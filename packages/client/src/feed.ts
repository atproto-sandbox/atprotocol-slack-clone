import { isAccessLost } from "@flock/protocol/atproto/space-credential-core";
import type { CredentialCache } from "./credentials";
import type { OperatorClient } from "./operator-client";

/**
 * How long a poll waits before returning when it could not finish: a sync failed (its cursor stays, so the operator would
 * answer at once again), or a denied space is still followed (the operator answers a call that follows only denied spaces at
 * once). Without it either would ask again without pause.
 */
export const RETRY_DELAY_MS = 5_000;

/**
 * How long a space the operator denied, though the account can still read it, waits before it is followed again. The
 * operator's answer about who may follow a space lasts this long (D12), and an operator that cannot serve the space at all
 * (it holds no grant from its authority) would deny it again at once.
 */
export const REFOLLOW_DELAY_MS = 60_000;

export type FollowerDeps = {
  operator: Pick<OperatorClient, "getChanges">;
  credentials: Pick<CredentialCache, "fresh">;
  /** Brings what the client holds of `space` up to date: a channel's open page read again, say. */
  sync(space: string): Promise<void>;
  retryDelayMs?: number;
  refollowDelayMs?: number;
};

export type PollResult = { synced: string[]; unfollowed: string[]; failed: Array<{ space: string; error: unknown }> };

/**
 * Follows spaces through the operator's change feed in the order that loses nothing: read `head`, sync the space, then follow
 * it from that `head`, so anything in between is reported again. A changed space is synced and followed from its new cursor;
 * one reset is synced and followed from the answer's `head`. A denied space is minted a credential afresh, which says why: a
 * deleted space or lost access drops it (the credential cache's `onAccessLost`) and it is no longer followed; access that is
 * still there, or back, has the space followed again from a new head once `REFOLLOW_DELAY_MS` has passed; a passing failure
 * is asked about again next time.
 */
export class ChangeFollower {
  private readonly cursors = new Map<string, string>();
  /** Denied spaces the account can still read, and when each is followed again. */
  private readonly deferred = new Map<string, number>();
  /** Spaces a `follow` is under way for, one token per follow. */
  private readonly pending = new Map<string, Set<symbol>>();
  /** Raised by every unfollow, so work begun before it (a follow, a sync, a mint) then leaves the space alone. */
  private readonly generations = new Map<string, number>();

  constructor(private readonly deps: FollowerDeps) {}

  /** Every space being followed: with a cursor, waiting to be followed again after a denial, or with a follow under way. */
  get following(): string[] {
    return [...new Set([...this.cursors.keys(), ...this.deferred.keys(), ...this.pending.keys()])];
  }

  /**
   * Follows `spaces` from one head read before they are brought up to date: by `load` when given (once, for everything that
   * reads them), else by syncing each.
   */
  async follow(spaces: readonly string[], load?: () => Promise<unknown>): Promise<void> {
    const token = Symbol("follow");
    const started = new Map(spaces.map((space) => [space, this.generation(space)]));
    for (const space of spaces) this.pending.set(space, (this.pending.get(space) ?? new Set()).add(token));
    try {
      const { head } = await this.deps.operator.getChanges([]);
      if (load) await load();
      else for (const space of spaces) await this.deps.sync(space);
      for (const space of spaces) {
        if (this.generation(space) !== started.get(space)) continue;
        this.deferred.delete(space);
        this.cursors.set(space, head);
      }
    } finally {
      for (const space of spaces) {
        const tokens = this.pending.get(space);
        tokens?.delete(token);
        if (tokens?.size === 0) this.pending.delete(space);
      }
    }
  }

  /** Whether a poll has anything to ask: a space with a cursor, or a denied one waiting to be followed again. */
  get pollable(): boolean {
    return this.cursors.size > 0 || this.deferred.size > 0;
  }

  unfollow(space: string): void {
    this.cursors.delete(space);
    this.deferred.delete(space);
    this.pending.delete(space);
    this.generations.set(space, this.generation(space) + 1);
  }

  private generation(space: string): number {
    return this.generations.get(space) ?? 0;
  }

  /**
   * One long poll over every followed space. A space whose sync fails keeps its cursor, so it is reported again, and is listed
   * in `failed`. A space unfollowed while the poll was held, or while its answer was being acted on, is left alone.
   */
  async poll(signal?: AbortSignal): Promise<PollResult> {
    const result: PollResult = { synced: [], unfollowed: [], failed: [] };
    await this.followDeferred(result, signal);
    if (this.cursors.size === 0) return result;
    const answer = await this.deps.operator.getChanges([...this.cursors].map(([space, after]) => ({ space, after })), signal);
    const syncTo = async (space: string, cursor: string) => {
      if (!this.cursors.has(space)) return;
      const started = this.generation(space);
      try {
        await this.deps.sync(space);
      } catch (error) {
        result.failed.push({ space, error });
        return;
      }
      if (this.generation(space) !== started) return;
      this.cursors.set(space, cursor);
      result.synced.push(space);
    };
    for (const { space, cursor } of answer.changed) await syncTo(space, cursor);
    for (const space of answer.reset) await syncTo(space, answer.head);
    for (const space of answer.denied) {
      if (!this.cursors.has(space)) continue;
      const started = this.generation(space);
      try {
        await this.deps.credentials.fresh(space);
      } catch (error) {
        if (!isAccessLost(error)) continue;
        this.unfollow(space);
        result.unfollowed.push(space);
        continue;
      }
      if (this.generation(space) === started) this.defer(space);
    }
    if (result.failed.length > 0 || answer.denied.some((space) => this.cursors.has(space))) {
      await pause(this.deps.retryDelayMs ?? RETRY_DELAY_MS, signal);
    }
    return result;
  }

  private defer(space: string): void {
    this.cursors.delete(space);
    this.deferred.set(space, Date.now() + (this.deps.refollowDelayMs ?? REFOLLOW_DELAY_MS));
  }

  /** Follows again the deferred spaces whose wait is over; with nothing else followed, first waits for the next of them. */
  private async followDeferred(result: PollResult, signal?: AbortSignal): Promise<void> {
    if (this.deferred.size === 0) return;
    if (this.cursors.size === 0) await pause(Math.min(...this.deferred.values()) - Date.now(), signal);
    for (const [space, at] of [...this.deferred]) {
      if (at > Date.now() || signal?.aborted) continue;
      const started = this.generation(space);
      try {
        await this.follow([space]);
        if (this.cursors.has(space)) result.synced.push(space);
      } catch (error) {
        if (this.generation(space) !== started) continue;
        this.defer(space);
        result.failed.push({ space, error });
      }
    }
  }
}

/** Waits `ms`, or less when `signal` aborts; leaves no listener behind. */
export function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
