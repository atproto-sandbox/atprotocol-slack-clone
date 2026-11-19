import {
  mintSpaceCredentialWith,
  SpaceCredentialError,
  type SpaceCredential,
  type SpaceNotifyTarget,
} from "@flock/protocol/atproto/space-credential-core";
import { XrpcError, type AtprotoClient } from "@flock/protocol/atproto/xrpc";
import { raceWithSignal } from "./operator-client";
import { transportNow, type ClientTransport } from "./transport";

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

export function isRegistrationNotConfirmed(error: unknown): boolean {
  if (error instanceof XrpcError && error.code === "RegistrationNotConfirmed") return true;
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; error?: unknown };
  return candidate.code === "RegistrationNotConfirmed" || candidate.error === "RegistrationNotConfirmed";
}

function sameNotify(left: SpaceNotifyTarget | undefined, right: SpaceNotifyTarget | undefined): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.endpoint === right.endpoint && left.token === right.token;
}

type InFlightOrdinaryMint = {
  opSeq: number;
  promise: Promise<SpaceCredential>;
  effectiveNotify: SpaceNotifyTarget | undefined;
  snapshotNotifySeq: number;
  controller: AbortController;
  unSignaledWaiters: number;
  signaledWaiters: Map<AbortSignal, number>;
};

type InFlightSidecarMint = {
  opSeq: number;
  promise: Promise<SpaceCredential>;
  controller: AbortController;
  unSignaledWaiters: number;
  signaledWaiters: Map<AbortSignal, number>;
};

/**
 * One space credential per space, shared by everything an account reads: a credential is minted once, reused until it is
 * close to expiry, and minted again by whoever asks first after that. A credential a host refused is dropped by its holder.
 * The authority refusing to mint one (access lost, or the space deleted) is where the client learns to drop the space.
 */
export class CredentialCache {
  private readonly credentials = new Map<string, Promise<SpaceCredential>>();
  private readonly inFlightOrdinaryMints = new Map<string, InFlightOrdinaryMint>();
  private readonly notifyTargets = new Map<string, SpaceNotifyTarget>();
  private readonly pendingNotifyMints = new Map<string, InFlightSidecarMint>();
  private readonly activeOpSeqs = new Map<string, Set<number>>();
  private readonly nextOpSeq = new Map<string, number>();
  private readonly settledFenceSeq = new Map<string, number>();
  private readonly storedCredSeq = new Map<string, number>();
  private readonly committedNotifySeq = new Map<string, number>();
  private readonly accessLossSeq = new WeakMap<SpaceCredentialError, { space: string; seq: number }>();

  constructor(
    private readonly transport: ClientTransport,
    private readonly onAccessLost?: (space: string, error: SpaceCredentialError) => Promise<void>,
  ) {}

  private allocateOpSeq(space: string): number {
    const next = (this.nextOpSeq.get(space) ?? 0) + 1;
    this.nextOpSeq.set(space, next);
    return next;
  }

  private registerActiveOp(space: string, opSeq: number): void {
    let set = this.activeOpSeqs.get(space);
    if (!set) {
      set = new Set<number>();
      this.activeOpSeqs.set(space, set);
    }
    set.add(opSeq);
  }

  private unregisterActiveOp(space: string, opSeq: number): void {
    const set = this.activeOpSeqs.get(space);
    if (!set) return;
    set.delete(opSeq);
    if (set.size === 0) {
      this.activeOpSeqs.delete(space);
    }
  }

  private hasNewerActiveOp(space: string, opSeq: number): boolean {
    const set = this.activeOpSeqs.get(space);
    if (!set) return false;
    for (const activeSeq of set) {
      if (activeSeq > opSeq) return true;
    }
    return false;
  }

  private getSettledFenceSeq(space: string): number {
    return this.settledFenceSeq.get(space) ?? 0;
  }

  private advanceSettledFence(space: string, seq: number): void {
    if (seq > this.getSettledFenceSeq(space)) {
      this.settledFenceSeq.set(space, seq);
    }
  }

  private getStoredCredSeq(space: string): number {
    return this.storedCredSeq.get(space) ?? 0;
  }

  private advanceStoredCredSeq(space: string, seq: number): void {
    if (seq > this.getStoredCredSeq(space)) {
      this.storedCredSeq.set(space, seq);
    }
  }

  private getCommittedNotifySeq(space: string): number {
    return this.committedNotifySeq.get(space) ?? 0;
  }

  private advanceCommittedNotifySeq(space: string, seq: number): void {
    if (seq > this.getCommittedNotifySeq(space)) {
      this.committedNotifySeq.set(space, seq);
    }
  }

  /**
   * True iff `opSeq` has not been superseded by any newer settled credential fence (`mintFreshUnnotified`,
   * ordinary, sidecar, `drop`, `fresh`, or access loss) OR any newer in-flight operation for `space`.
   */
  private ownsCredentialSlot(space: string, opSeq: number): boolean {
    if (opSeq <= this.getSettledFenceSeq(space)) return false;
    if (this.hasNewerActiveOp(space, opSeq)) return false;
    return true;
  }

  private ownsNotifySlot(space: string, opSeq: number): boolean {
    return this.ownsCredentialSlot(space, opSeq) && opSeq > this.getCommittedNotifySeq(space);
  }

  private deleteOlderInFlightOrdinary(space: string, opSeq: number): void {
    const active = this.inFlightOrdinaryMints.get(space);
    if (active && active.opSeq <= opSeq) {
      this.inFlightOrdinaryMints.delete(space);
    }
  }

  private recordAuthoritativeAccessLoss(space: string, opSeq: number, error: SpaceCredentialError): void {
    this.advanceSettledFence(space, opSeq);
    this.advanceStoredCredSeq(space, opSeq);
    this.advanceCommittedNotifySeq(space, opSeq);
    this.deleteOlderInFlightOrdinary(space, opSeq);
    this.credentials.delete(space);
    this.notifyTargets.delete(space);
    this.accessLossSeq.set(error, { space, seq: opSeq });
  }

  /**
   * True only when `error` is a `SpaceCredentialError` that owned the credential slot at `opSeq`
   * and has not been superseded by any newer settled fence or in-flight operation.
   */
  isAuthoritativeAccessLoss(space: string, error: unknown): error is SpaceCredentialError {
    if (!(error instanceof SpaceCredentialError)) return false;
    const recorded = this.accessLossSeq.get(error);
    return (
      recorded !== undefined
      && recorded.space === space
      && this.getSettledFenceSeq(space) === recorded.seq
      && !this.hasNewerActiveOp(space, recorded.seq)
    );
  }

  async get(space: string, opts?: { notify?: SpaceNotifyTarget; signal?: AbortSignal }): Promise<SpaceCredential> {
    if (opts?.signal?.aborted) throw abortReason(opts.signal);
    if (opts?.notify !== undefined) {
      const pending = this.credentials.get(space);
      if (pending) {
        const checkNotifySeq = this.getCommittedNotifySeq(space);
        const checkFenceSeq = this.getSettledFenceSeq(space);
        const baselineSeq = Math.max(checkNotifySeq, checkFenceSeq);
        const existing = await raceWithSignal(pending.catch(() => undefined), opts.signal);
        if (
          existing
          && this.isUsable(existing)
          && sameNotify(existing.notify, opts.notify)
          && this.getCommittedNotifySeq(space) === checkNotifySeq
          && this.getSettledFenceSeq(space) === checkFenceSeq
          && !this.hasNewerActiveOp(space, baselineSeq)
        ) {
          this.notifyTargets.set(space, opts.notify);
          return existing;
        }
      }
      const activeOrdinary = this.inFlightOrdinaryMints.get(space);
      if (activeOrdinary && sameNotify(activeOrdinary.effectiveNotify, opts.notify)) {
        const checkNotifySeq = this.getCommittedNotifySeq(space);
        const existing = await this.joinOrdinaryMint(space, activeOrdinary, opts.signal).catch(() => undefined);
        if (
          existing
          && this.isUsable(existing)
          && sameNotify(existing.notify, opts.notify)
          && this.getCommittedNotifySeq(space) === checkNotifySeq
          && !this.hasNewerActiveOp(space, activeOrdinary.opSeq)
        ) {
          return existing;
        }
      }
      return this.mintSidecarNotify(space, opts.notify, opts.signal, false);
    }

    const activeMint = this.inFlightOrdinaryMints.get(space);
    if (activeMint) {
      return this.joinOrdinaryMint(space, activeMint, opts?.signal);
    }

    const pending = this.credentials.get(space);
    if (pending) {
      const credential = await raceWithSignal(pending, opts?.signal);
      if (this.isUsable(credential)) {
        return credential;
      }
      const nextActiveMint = this.inFlightOrdinaryMints.get(space);
      if (nextActiveMint) {
        return this.joinOrdinaryMint(space, nextActiveMint, opts?.signal);
      }
      const current = this.credentials.get(space);
      if (current && current !== pending) {
        const next = await raceWithSignal(current, opts?.signal);
        if (this.isUsable(next)) {
          return next;
        }
      }
      if (this.credentials.get(space) === pending) {
        this.credentials.delete(space);
      }
    }

    return this.startAndJoinOrdinaryMint(space, opts?.signal);
  }

  /** A credential minted now, for a write that must not rely on membership checked up to ten minutes ago. */
  async fresh(space: string, opts?: { notify?: SpaceNotifyTarget; signal?: AbortSignal }): Promise<SpaceCredential> {
    if (opts?.signal?.aborted) throw abortReason(opts.signal);
    if (opts?.notify !== undefined) {
      return this.mintSidecarNotify(space, opts.notify, opts.signal, true);
    }
    const seq = this.allocateOpSeq(space);
    this.advanceSettledFence(space, seq);
    this.advanceStoredCredSeq(space, seq);
    this.deleteOlderInFlightOrdinary(space, seq);
    this.credentials.delete(space);
    return this.get(space, opts);
  }

  /**
   * Mints a brand-new un-notified credential (fresh `jti`) for single-use proof-of-possession without
   * triggering `{ notify }` confirmation or clobbering an active notified credential in the cache.
   */
  async mintFreshUnnotified(space: string, signal?: AbortSignal): Promise<SpaceCredential> {
    if (signal?.aborted) throw abortReason(signal);
    const opSeq = this.allocateOpSeq(space);
    this.registerActiveOp(space, opSeq);
    const onAbort = () => this.unregisterActiveOp(space, opSeq);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const credential = await raceWithSignal(
        mintSpaceCredentialWith(this.transport, space, signal ? { signal } : undefined),
        signal,
      );
      if (signal?.aborted) throw abortReason(signal);
      const canFillEmptyCache =
        this.ownsCredentialSlot(space, opSeq)
        && opSeq > this.getStoredCredSeq(space)
        && !this.credentials.has(space)
        && !this.notifyTargets.has(space);
      // Unconditionally record this settled proof of access as a monotonic fence, even if a later opSeq
      // is currently active and later aborts or fails transiently!
      this.advanceSettledFence(space, opSeq);
      if (canFillEmptyCache) {
        this.advanceStoredCredSeq(space, opSeq);
        this.credentials.set(space, Promise.resolve(credential));
      }
      return credential;
    } catch (error) {
      if (
        !signal?.aborted
        && error instanceof SpaceCredentialError
        && this.ownsCredentialSlot(space, opSeq)
      ) {
        this.recordAuthoritativeAccessLoss(space, opSeq, error);
        await this.onAccessLost?.(space, error);
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.unregisterActiveOp(space, opSeq);
    }
  }

  /** A client for `did`'s host (a writer, or the space's authority), signed with the space's credential. */
  async clientFor(space: string, did: string): Promise<AtprotoClient> {
    const credential = await this.get(space);
    return credential.client(await this.transport.resolvePds(did));
  }

  /** Stops re-registering `notify` on future renewals for `space` without dropping valid cached read credentials. */
  clearNotify(space: string): void {
    const seq = this.allocateOpSeq(space);
    this.advanceCommittedNotifySeq(space, seq);
    this.notifyTargets.delete(space);
  }

  drop(space: string, opts?: { clearNotify?: boolean }): void {
    const seq = this.allocateOpSeq(space);
    this.advanceSettledFence(space, seq);
    this.advanceStoredCredSeq(space, seq);
    this.deleteOlderInFlightOrdinary(space, seq);
    this.credentials.delete(space);
    if (opts?.clearNotify) {
      this.advanceCommittedNotifySeq(space, seq);
      this.notifyTargets.delete(space);
    }
  }

  private isUsable(credential: SpaceCredential): boolean {
    return credential.expiresAt - transportNow(this.transport) > credential.renewBeforeMs;
  }

  private startAndJoinOrdinaryMint(space: string, signal?: AbortSignal): Promise<SpaceCredential> {
    if (signal?.aborted) {
      return Promise.reject(abortReason(signal));
    }
    const opSeq = this.allocateOpSeq(space);
    this.registerActiveOp(space, opSeq);
    const effectiveNotify = this.notifyTargets.get(space);
    const snapshotNotifySeq = this.getCommittedNotifySeq(space);
    const controller = new AbortController();
    const entry: InFlightOrdinaryMint = {
      opSeq,
      promise: undefined as unknown as Promise<SpaceCredential>,
      effectiveNotify,
      snapshotNotifySeq,
      controller,
      unSignaledWaiters: 0,
      signaledWaiters: new Map(),
    };
    const minted = this.runOrdinaryMint(space, effectiveNotify, entry);
    entry.promise = minted;
    void minted.catch(() => undefined);
    this.inFlightOrdinaryMints.set(space, entry);
    return this.joinOrdinaryMint(space, entry, signal);
  }

  private async runOrdinaryMint(
    space: string,
    effectiveNotify: SpaceNotifyTarget | undefined,
    entry: InFlightOrdinaryMint,
  ): Promise<SpaceCredential> {
    const { signal } = entry.controller;
    const { opSeq, snapshotNotifySeq } = entry;
    try {
      const { credential, notifyConfirmed } = await this.mint(space, effectiveNotify, signal);
      if (signal.aborted) {
        throw abortReason(signal);
      }
      this.advanceSettledFence(space, opSeq);
      if (this.getCommittedNotifySeq(space) === snapshotNotifySeq) {
        if (opSeq > this.getStoredCredSeq(space)) {
          this.advanceStoredCredSeq(space, opSeq);
          this.credentials.set(space, Promise.resolve(credential));
          if (effectiveNotify) {
            if (notifyConfirmed) {
              this.advanceCommittedNotifySeq(space, opSeq);
              this.notifyTargets.set(space, effectiveNotify);
            } else if (!this.hasNewerActiveOp(space, opSeq)) {
              this.advanceCommittedNotifySeq(space, opSeq);
              this.notifyTargets.delete(space);
            }
          }
        }
      } else if (
        !this.notifyTargets.has(space)
        && credential.notify === undefined
        && opSeq > this.getStoredCredSeq(space)
      ) {
        this.advanceStoredCredSeq(space, opSeq);
        this.credentials.set(space, Promise.resolve(credential));
      }
      return credential;
    } catch (error) {
      if (
        !signal.aborted
        && error instanceof SpaceCredentialError
        && this.ownsCredentialSlot(space, opSeq)
      ) {
        this.recordAuthoritativeAccessLoss(space, opSeq, error);
        await this.onAccessLost?.(space, error);
      }
      throw error;
    } finally {
      this.unregisterActiveOp(space, opSeq);
      if (this.inFlightOrdinaryMints.get(space) === entry) {
        this.inFlightOrdinaryMints.delete(space);
      }
    }
  }

  private async joinOrdinaryMint(
    space: string,
    entry: InFlightOrdinaryMint,
    signal?: AbortSignal,
  ): Promise<SpaceCredential> {
    if (signal?.aborted) throw abortReason(signal);
    if (!signal) {
      entry.unSignaledWaiters += 1;
      try {
        return await entry.promise;
      } finally {
        entry.unSignaledWaiters -= 1;
      }
    }

    entry.signaledWaiters.set(signal, (entry.signaledWaiters.get(signal) ?? 0) + 1);
    let decremented = false;
    const releaseSignalWaiter = () => {
      if (decremented) return;
      decremented = true;
      const prev = entry.signaledWaiters.get(signal) ?? 0;
      if (prev <= 1) {
        entry.signaledWaiters.delete(signal);
      } else {
        entry.signaledWaiters.set(signal, prev - 1);
      }
    };

    const onAbort = () => {
      releaseSignalWaiter();
      if (entry.unSignaledWaiters === 0 && entry.signaledWaiters.size === 0) {
        this.unregisterActiveOp(space, entry.opSeq);
        if (this.inFlightOrdinaryMints.get(space) === entry) {
          this.inFlightOrdinaryMints.delete(space);
        }
        entry.controller.abort(abortReason(signal));
      }
    };

    signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await raceWithSignal(entry.promise, signal);
    } catch (error) {
      if (signal.aborted) {
        onAbort();
      }
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
      releaseSignalWaiter();
    }
  }

  private mintSidecarNotify(
    space: string,
    notify: SpaceNotifyTarget,
    signal: AbortSignal | undefined,
    forceNew: boolean,
  ): Promise<SpaceCredential> {
    if (signal?.aborted) {
      return Promise.reject(abortReason(signal));
    }
    const mintKey = `${space}\0${notify.endpoint}\0${notify.token}`;
    const inFlight = this.pendingNotifyMints.get(mintKey);
    if (!forceNew && inFlight && this.ownsNotifySlot(space, inFlight.opSeq)) {
      return this.joinSidecarMint(space, mintKey, inFlight, signal);
    }

    const opSeq = this.allocateOpSeq(space);
    this.registerActiveOp(space, opSeq);
    const controller = new AbortController();
    const sidecarEntry: InFlightSidecarMint = {
      opSeq,
      promise: undefined as unknown as Promise<SpaceCredential>,
      controller,
      unSignaledWaiters: 0,
      signaledWaiters: new Map(),
    };
    const run: Promise<SpaceCredential> = this.runSidecarNotifyMint(space, notify, opSeq, controller.signal).finally(() => {
      this.unregisterActiveOp(space, opSeq);
      if (this.pendingNotifyMints.get(mintKey) === sidecarEntry) {
        this.pendingNotifyMints.delete(mintKey);
      }
    });
    sidecarEntry.promise = run;
    void run.catch(() => undefined);

    this.pendingNotifyMints.set(mintKey, sidecarEntry);
    return this.joinSidecarMint(space, mintKey, sidecarEntry, signal);
  }

  private async joinSidecarMint(
    space: string,
    mintKey: string,
    entry: InFlightSidecarMint,
    signal?: AbortSignal,
  ): Promise<SpaceCredential> {
    if (signal?.aborted) throw abortReason(signal);
    if (!signal) {
      entry.unSignaledWaiters += 1;
      try {
        return await entry.promise;
      } finally {
        entry.unSignaledWaiters -= 1;
      }
    }

    entry.signaledWaiters.set(signal, (entry.signaledWaiters.get(signal) ?? 0) + 1);
    let decremented = false;
    const releaseSignalWaiter = () => {
      if (decremented) return;
      decremented = true;
      const prev = entry.signaledWaiters.get(signal) ?? 0;
      if (prev <= 1) {
        entry.signaledWaiters.delete(signal);
      } else {
        entry.signaledWaiters.set(signal, prev - 1);
      }
    };

    const onAbort = () => {
      releaseSignalWaiter();
      if (entry.unSignaledWaiters === 0 && entry.signaledWaiters.size === 0) {
        this.unregisterActiveOp(space, entry.opSeq);
        if (this.pendingNotifyMints.get(mintKey) === entry) {
          this.pendingNotifyMints.delete(mintKey);
        }
        entry.controller.abort(abortReason(signal));
      }
    };

    signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await raceWithSignal(entry.promise, signal);
    } catch (error) {
      if (signal.aborted) {
        onAbort();
      }
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
      releaseSignalWaiter();
    }
  }

  private async runSidecarNotifyMint(
    space: string,
    notify: SpaceNotifyTarget,
    opSeq: number,
    signal?: AbortSignal,
  ): Promise<SpaceCredential> {
    if (signal?.aborted) throw abortReason(signal);
    try {
      const credential = await raceWithSignal(
        mintSpaceCredentialWith(this.transport, space, {
          notify,
          ...(signal ? { signal } : {}),
        }),
        signal,
      );
      if (signal?.aborted) throw abortReason(signal);
      this.advanceSettledFence(space, opSeq);
      if (opSeq > this.getStoredCredSeq(space) && opSeq > this.getCommittedNotifySeq(space)) {
        this.advanceStoredCredSeq(space, opSeq);
        this.advanceCommittedNotifySeq(space, opSeq);
        this.notifyTargets.set(space, notify);
        this.deleteOlderInFlightOrdinary(space, opSeq);
        this.credentials.set(space, Promise.resolve(credential));
      }
      return credential;
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      if (error instanceof SpaceCredentialError) {
        if (this.ownsCredentialSlot(space, opSeq)) {
          this.recordAuthoritativeAccessLoss(space, opSeq, error);
          await this.onAccessLost?.(space, error);
        }
        throw error;
      }
      if (this.ownsNotifySlot(space, opSeq)) {
        this.advanceCommittedNotifySeq(space, opSeq);
        this.notifyTargets.delete(space);
      }
      if (!isRegistrationNotConfirmed(error)) {
        throw error;
      }
      const current = this.credentials.get(space);
      if (current) {
        const existing = await raceWithSignal(current.catch(() => undefined), signal);
        if (existing && this.isUsable(existing) && (existing.notify === undefined || !this.ownsCredentialSlot(space, opSeq))) {
          return existing;
        }
      }
      try {
        const fallback = await raceWithSignal(
          mintSpaceCredentialWith(this.transport, space, signal ? { signal } : undefined),
          signal,
        );
        if (signal?.aborted) throw abortReason(signal);
        this.advanceSettledFence(space, opSeq);
        if (this.ownsCredentialSlot(space, opSeq) && opSeq > this.getStoredCredSeq(space)) {
          this.advanceStoredCredSeq(space, opSeq);
          this.deleteOlderInFlightOrdinary(space, opSeq);
          this.credentials.set(space, Promise.resolve(fallback));
        }
        return fallback;
      } catch (fallbackError) {
        if (
          !signal?.aborted
          && fallbackError instanceof SpaceCredentialError
          && this.ownsCredentialSlot(space, opSeq)
        ) {
          this.recordAuthoritativeAccessLoss(space, opSeq, fallbackError);
          await this.onAccessLost?.(space, fallbackError);
        }
        throw fallbackError;
      }
    }
  }

  private async mint(
    space: string,
    notify?: SpaceNotifyTarget,
    signal?: AbortSignal,
  ): Promise<{ credential: SpaceCredential; notifyConfirmed: boolean }> {
    if (signal?.aborted) throw abortReason(signal);
    if (notify) {
      try {
        const credential = await raceWithSignal(
          mintSpaceCredentialWith(this.transport, space, {
            notify,
            ...(signal ? { signal } : {}),
          }),
          signal,
        );
        if (signal?.aborted) throw abortReason(signal);
        return { credential, notifyConfirmed: true };
      } catch (error) {
        if (signal?.aborted || !isRegistrationNotConfirmed(error)) throw error;
      }
    }
    const credential = await raceWithSignal(
      mintSpaceCredentialWith(this.transport, space, signal ? { signal } : undefined),
      signal,
    );
    return { credential, notifyConfirmed: false };
  }
}
