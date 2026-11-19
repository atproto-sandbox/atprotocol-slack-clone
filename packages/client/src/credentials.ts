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
  private readonly committedCredSeq = new Map<string, number>();
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

  private getCommittedCredSeq(space: string): number {
    return this.committedCredSeq.get(space) ?? 0;
  }

  private advanceCommittedCredSeq(space: string, seq: number): void {
    if (seq > this.getCommittedCredSeq(space)) {
      this.committedCredSeq.set(space, seq);
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
   * True iff `opSeq` has not been superseded by any newer committed credential, invalidation (`drop`/`fresh`),
   * authoritative access loss, or any newer in-flight operation (ordinary, sidecar, or unnotified) for `space`.
   */
  private ownsCredentialSlot(space: string, opSeq: number): boolean {
    if (opSeq <= this.getCommittedCredSeq(space)) return false;
    if (this.hasNewerActiveOp(space, opSeq)) return false;
    return true;
  }

  private ownsNotifySlot(space: string, opSeq: number): boolean {
    return this.ownsCredentialSlot(space, opSeq) && opSeq > this.getCommittedNotifySeq(space);
  }

  private recordAuthoritativeAccessLoss(space: string, opSeq: number, error: SpaceCredentialError): void {
    this.advanceCommittedCredSeq(space, opSeq);
    this.advanceCommittedNotifySeq(space, opSeq);
    this.inFlightOrdinaryMints.delete(space);
    this.credentials.delete(space);
    this.notifyTargets.delete(space);
    this.accessLossSeq.set(error, { space, seq: opSeq });
  }

  /**
   * True only when `error` is a `SpaceCredentialError` that owned the credential slot at `opSeq`
   * and has not been superseded by any newer committed or in-flight operation.
   */
  isAuthoritativeAccessLoss(space: string, error: unknown): error is SpaceCredentialError {
    if (!(error instanceof SpaceCredentialError)) return false;
    const recorded = this.accessLossSeq.get(error);
    return (
      recorded !== undefined
      && recorded.space === space
      && this.getCommittedCredSeq(space) === recorded.seq
      && !this.hasNewerActiveOp(space, recorded.seq)
    );
  }

  async get(space: string, opts?: { notify?: SpaceNotifyTarget; signal?: AbortSignal }): Promise<SpaceCredential> {
    if (opts?.signal?.aborted) throw abortReason(opts.signal);
    if (opts?.notify !== undefined) {
      const pending = this.credentials.get(space);
      const activeOrdinary = this.inFlightOrdinaryMints.get(space);
      const canReusePending = !activeOrdinary || activeOrdinary.promise !== pending || sameNotify(activeOrdinary.effectiveNotify, opts.notify);
      if (pending && canReusePending) {
        const checkNotifySeq = this.getCommittedNotifySeq(space);
        const checkCredSeq = this.getCommittedCredSeq(space);
        const baselineSeq = Math.max(checkNotifySeq, checkCredSeq);
        const existing = await raceWithSignal(pending.catch(() => undefined), opts.signal);
        if (
          existing
          && this.isUsable(existing)
          && sameNotify(existing.notify, opts.notify)
          && this.getCommittedNotifySeq(space) === checkNotifySeq
          && this.getCommittedCredSeq(space) === checkCredSeq
          && !this.hasNewerActiveOp(space, baselineSeq)
        ) {
          this.notifyTargets.set(space, opts.notify);
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
      if (this.credentials.get(space) === pending || this.credentials.get(space) === current) {
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
    this.advanceCommittedCredSeq(space, seq);
    this.inFlightOrdinaryMints.delete(space);
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
      if (this.ownsCredentialSlot(space, opSeq)) {
        this.advanceCommittedCredSeq(space, opSeq);
        if (!this.credentials.has(space) && !this.notifyTargets.has(space)) {
          this.credentials.set(space, Promise.resolve(credential));
        }
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
    this.advanceCommittedCredSeq(space, seq);
    this.inFlightOrdinaryMints.delete(space);
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
    const controller = new AbortController();
    const entry: InFlightOrdinaryMint = {
      opSeq,
      promise: undefined as unknown as Promise<SpaceCredential>,
      effectiveNotify,
      controller,
      unSignaledWaiters: 0,
      signaledWaiters: new Map(),
    };
    const minted = this.runOrdinaryMint(space, effectiveNotify, entry);
    entry.promise = minted;
    void minted.catch(() => undefined);
    this.inFlightOrdinaryMints.set(space, entry);
    this.credentials.set(space, minted);
    return this.joinOrdinaryMint(space, entry, signal);
  }

  private async runOrdinaryMint(
    space: string,
    effectiveNotify: SpaceNotifyTarget | undefined,
    entry: InFlightOrdinaryMint,
  ): Promise<SpaceCredential> {
    const { signal } = entry.controller;
    const { opSeq } = entry;
    try {
      const { credential, notifyConfirmed } = await this.mint(space, effectiveNotify, signal);
      if (signal.aborted) {
        if (this.credentials.get(space) === entry.promise) {
          this.credentials.delete(space);
        }
        throw abortReason(signal);
      }
      if (this.ownsCredentialSlot(space, opSeq)) {
        this.advanceCommittedCredSeq(space, opSeq);
        if (this.credentials.get(space) === entry.promise) {
          this.credentials.set(space, Promise.resolve(credential));
          if (effectiveNotify && opSeq > this.getCommittedNotifySeq(space)) {
            this.advanceCommittedNotifySeq(space, opSeq);
            if (notifyConfirmed) {
              this.notifyTargets.set(space, effectiveNotify);
            } else {
              this.notifyTargets.delete(space);
            }
          }
        }
      }
      return credential;
    } catch (error) {
      const stillOwnsCacheSlot = this.credentials.get(space) === entry.promise;
      if (stillOwnsCacheSlot) {
        this.credentials.delete(space);
      }
      if (
        !signal.aborted
        && error instanceof SpaceCredentialError
        && stillOwnsCacheSlot
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
        if (this.credentials.get(space) === entry.promise) {
          this.credentials.delete(space);
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
      if (this.ownsCredentialSlot(space, opSeq)) {
        this.advanceCommittedCredSeq(space, opSeq);
        if (opSeq > this.getCommittedNotifySeq(space)) {
          this.advanceCommittedNotifySeq(space, opSeq);
          this.notifyTargets.set(space, notify);
          this.inFlightOrdinaryMints.delete(space);
          this.credentials.set(space, Promise.resolve(credential));
        }
      }
      return credential;
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      if (this.ownsNotifySlot(space, opSeq)) {
        this.advanceCommittedNotifySeq(space, opSeq);
        this.notifyTargets.delete(space);
      }
      if (error instanceof SpaceCredentialError) {
        if (this.ownsCredentialSlot(space, opSeq)) {
          this.recordAuthoritativeAccessLoss(space, opSeq, error);
          await this.onAccessLost?.(space, error);
        }
        throw error;
      }
      if (!isRegistrationNotConfirmed(error)) {
        throw error;
      }
      const current = this.credentials.get(space);
      const activeOrdinary = this.inFlightOrdinaryMints.get(space);
      if (current && current !== activeOrdinary?.promise) {
        const existing = await raceWithSignal(current.catch(() => undefined), signal);
        if (existing && this.isUsable(existing) && (existing.notify === undefined || !this.ownsCredentialSlot(space, opSeq))) {
          if (this.ownsCredentialSlot(space, opSeq)) {
            this.advanceCommittedCredSeq(space, opSeq);
          }
          return existing;
        }
      }
      try {
        const fallback = await raceWithSignal(
          mintSpaceCredentialWith(this.transport, space, signal ? { signal } : undefined),
          signal,
        );
        if (signal?.aborted) throw abortReason(signal);
        if (this.ownsCredentialSlot(space, opSeq)) {
          this.advanceCommittedCredSeq(space, opSeq);
          this.inFlightOrdinaryMints.delete(space);
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
