import { isAccessLost } from "@/atproto/space-credential-core";
import type { CredentialCache } from "./credentials";
import type { OperatorClient } from "./operator-client";

/**
 * How long a poll waits before returning when it could not finish: a sync failed (its cursor stays, so the operator would
 * answer at once again), or a denied space is still followed (the operator answers a call that follows only denied spaces at
 * once). Without it either would ask again without pause.
 */
export const RETRY_DELAY_MS = 5_000;

export type FollowerDeps = {
  operator: Pick<OperatorClient, "getChanges">;
  credentials: Pick<CredentialCache, "fresh">;
  /** Brings what the client holds of `space` up to date: a channel's open page read again, say. */
  sync(space: string): Promise<void>;
  retryDelayMs?: number;
};

export type PollResult = { synced: string[]; unfollowed: string[]; failed: Array<{ space: string; error: unknown }> };

/**
 * Follows spaces through the operator's change feed in the order that loses nothing: read `head`, sync the space, then follow
 * it from that `head`, so anything in between is reported again. A changed space is synced and followed from its new cursor;
 * one reset is synced and followed from the answer's `head`. A denied space is minted a credential afresh, which says why: a
 * deleted space or lost access drops it (the credential cache's `onAccessLost`) and it is no longer followed; access that is
 * still there, or back, is synced and followed again; a passing failure is asked about again next time.
 */
export class ChangeFollower {
  private readonly cursors = new Map<string, string>();

  constructor(private readonly deps: FollowerDeps) {}

  get following(): string[] {
    return [...this.cursors.keys()];
  }

  async follow(space: string): Promise<void> {
    const { head } = await this.deps.operator.getChanges([]);
    await this.deps.sync(space);
    this.cursors.set(space, head);
  }

  unfollow(space: string): void {
    this.cursors.delete(space);
  }

  /** One long poll over every followed space. A space whose sync fails keeps its cursor, so it is reported again, and is listed in `failed`. */
  async poll(signal?: AbortSignal): Promise<PollResult> {
    const result: PollResult = { synced: [], unfollowed: [], failed: [] };
    if (this.cursors.size === 0) return result;
    const answer = await this.deps.operator.getChanges([...this.cursors].map(([space, after]) => ({ space, after })), signal);
    const syncTo = async (space: string, cursor: string) => {
      try {
        await this.deps.sync(space);
      } catch (error) {
        result.failed.push({ space, error });
        return;
      }
      this.cursors.set(space, cursor);
      result.synced.push(space);
    };
    for (const { space, cursor } of answer.changed) await syncTo(space, cursor);
    for (const space of answer.reset) await syncTo(space, answer.head);
    for (const space of answer.denied) {
      try {
        await this.deps.credentials.fresh(space);
      } catch (error) {
        if (!isAccessLost(error)) continue;
        this.unfollow(space);
        result.unfollowed.push(space);
        continue;
      }
      try {
        await this.follow(space);
        result.synced.push(space);
      } catch (error) {
        result.failed.push({ space, error });
      }
    }
    if (result.failed.length > 0 || answer.denied.some((space) => this.cursors.has(space))) {
      await pause(this.deps.retryDelayMs ?? RETRY_DELAY_MS, signal);
    }
    return result;
  }
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
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
