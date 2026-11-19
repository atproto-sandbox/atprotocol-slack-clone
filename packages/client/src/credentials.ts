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
  promise: Promise<SpaceCredential>;
  effectiveNotify: SpaceNotifyTarget | undefined;
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
  private readonly pendingNotifyMints = new Map<string, Promise<SpaceCredential>>();
  private readonly cacheGenerations = new Map<string, number>();
  private readonly notifyGenerations = new Map<string, number>();

  constructor(
    private readonly transport: ClientTransport,
    private readonly onAccessLost?: (space: string, error: SpaceCredentialError) => Promise<void>,
  ) {}

  private currentCacheGen(space: string): number {
    return this.cacheGenerations.get(space) ?? 0;
  }

  private bumpCacheGen(space: string): number {
    const next = this.currentCacheGen(space) + 1;
    this.cacheGenerations.set(space, next);
    return next;
  }

  private currentNotifyGen(space: string): number {
    return this.notifyGenerations.get(space) ?? 0;
  }

  private bumpNotifyGen(space: string): number {
    const next = this.currentNotifyGen(space) + 1;
    this.notifyGenerations.set(space, next);
    return next;
  }

  async get(space: string, opts?: { notify?: SpaceNotifyTarget; signal?: AbortSignal }): Promise<SpaceCredential> {
    if (opts?.signal?.aborted) throw abortReason(opts.signal);
    if (opts?.notify !== undefined) {
      const pending = this.credentials.get(space);
      const activeOrdinary = this.inFlightOrdinaryMints.get(space);
      const canReusePending = !activeOrdinary || activeOrdinary.promise !== pending || sameNotify(activeOrdinary.effectiveNotify, opts.notify);
      if (pending && canReusePending) {
        const startedNotifyGen = this.currentNotifyGen(space);
        const existing = await raceWithSignal(pending.catch(() => undefined), opts.signal);
        if (
          existing
          && this.isUsable(existing)
          && sameNotify(existing.notify, opts.notify)
          && this.currentNotifyGen(space) === startedNotifyGen
        ) {
          this.notifyTargets.set(space, opts.notify);
          return existing;
        }
      }
      return this.mintSidecarNotify(space, opts.notify, opts.signal);
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
      return this.mintSidecarNotify(space, opts.notify, opts.signal);
    }
    this.bumpCacheGen(space);
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
    const startedCacheGen = this.currentCacheGen(space);
    try {
      const credential = await raceWithSignal(
        mintSpaceCredentialWith(this.transport, space, signal ? { signal } : undefined),
        signal,
      );
      if (signal?.aborted) throw abortReason(signal);
      if (
        this.currentCacheGen(space) === startedCacheGen
        && !this.credentials.has(space)
        && !this.notifyTargets.has(space)
      ) {
        this.credentials.set(space, Promise.resolve(credential));
      }
      return credential;
    } catch (error) {
      if (
        !signal?.aborted
        && error instanceof SpaceCredentialError
        && this.currentCacheGen(space) === startedCacheGen
      ) {
        this.bumpCacheGen(space);
        this.bumpNotifyGen(space);
        this.inFlightOrdinaryMints.delete(space);
        this.credentials.delete(space);
        this.notifyTargets.delete(space);
        await this.onAccessLost?.(space, error);
      }
      throw error;
    }
  }

  /** A client for `did`'s host (a writer, or the space's authority), signed with the space's credential. */
  async clientFor(space: string, did: string): Promise<AtprotoClient> {
    const credential = await this.get(space);
    return credential.client(await this.transport.resolvePds(did));
  }

  /** Stops re-registering `notify` on future renewals for `space` without dropping valid cached read credentials. */
  clearNotify(space: string): void {
    this.bumpNotifyGen(space);
    this.notifyTargets.delete(space);
  }

  drop(space: string, opts?: { clearNotify?: boolean }): void {
    this.bumpCacheGen(space);
    this.inFlightOrdinaryMints.delete(space);
    this.credentials.delete(space);
    if (opts?.clearNotify) {
      this.bumpNotifyGen(space);
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
    const startedCacheGen = this.currentCacheGen(space);
    const startedNotifyGen = this.currentNotifyGen(space);
    const effectiveNotify = this.notifyTargets.get(space);
    const controller = new AbortController();
    const entry: InFlightOrdinaryMint = {
      promise: undefined as unknown as Promise<SpaceCredential>,
      effectiveNotify,
      controller,
      unSignaledWaiters: 0,
      signaledWaiters: new Map(),
    };
    const minted = this.runOrdinaryMint(space, effectiveNotify, entry, startedCacheGen, startedNotifyGen);
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
    startedCacheGen: number,
    startedNotifyGen: number,
  ): Promise<SpaceCredential> {
    const { signal } = entry.controller;
    const ownsCurrentState = () =>
      this.inFlightOrdinaryMints.get(space) === entry
      && this.credentials.get(space) === entry.promise
      && this.currentCacheGen(space) === startedCacheGen;
    try {
      const { credential, notifyConfirmed } = await this.mint(space, effectiveNotify, signal);
      if (signal.aborted) {
        if (this.credentials.get(space) === entry.promise) {
          this.credentials.delete(space);
        }
        throw abortReason(signal);
      }
      if (ownsCurrentState() && effectiveNotify && this.currentNotifyGen(space) === startedNotifyGen) {
        if (notifyConfirmed) {
          this.notifyTargets.set(space, effectiveNotify);
        } else {
          this.notifyTargets.delete(space);
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
        && this.currentCacheGen(space) === startedCacheGen
      ) {
        this.bumpCacheGen(space);
        this.bumpNotifyGen(space);
        this.notifyTargets.delete(space);
        await this.onAccessLost?.(space, error);
      }
      throw error;
    } finally {
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
    signal?: AbortSignal,
  ): Promise<SpaceCredential> {
    if (signal?.aborted) {
      return Promise.reject(abortReason(signal));
    }
    const mintKey = `${space}\0${notify.endpoint}\0${notify.token}`;
    const inFlight = this.pendingNotifyMints.get(mintKey);
    if (inFlight) return raceWithSignal(inFlight, signal);

    const run: Promise<SpaceCredential> = this.runSidecarNotifyMint(space, notify, signal).finally(() => {
      if (this.pendingNotifyMints.get(mintKey) === run) {
        this.pendingNotifyMints.delete(mintKey);
      }
    });

    this.pendingNotifyMints.set(mintKey, run);
    if (signal) {
      const detachOnAbort = () => {
        if (this.pendingNotifyMints.get(mintKey) === run) {
          this.pendingNotifyMints.delete(mintKey);
        }
      };
      signal.addEventListener("abort", detachOnAbort, { once: true });
      void run.then(
        () => signal.removeEventListener("abort", detachOnAbort),
        () => signal.removeEventListener("abort", detachOnAbort),
      );
    }
    return run;
  }

  private async runSidecarNotifyMint(
    space: string,
    notify: SpaceNotifyTarget,
    signal?: AbortSignal,
  ): Promise<SpaceCredential> {
    if (signal?.aborted) throw abortReason(signal);
    const startedCacheGen = this.currentCacheGen(space);
    const startedNotifyGen = this.currentNotifyGen(space);
    try {
      const credential = await raceWithSignal(
        mintSpaceCredentialWith(this.transport, space, {
          notify,
          ...(signal ? { signal } : {}),
        }),
        signal,
      );
      if (signal?.aborted) throw abortReason(signal);
      if (
        this.currentCacheGen(space) === startedCacheGen
        && this.currentNotifyGen(space) === startedNotifyGen
      ) {
        this.bumpCacheGen(space);
        this.bumpNotifyGen(space);
        this.notifyTargets.set(space, notify);
        this.inFlightOrdinaryMints.delete(space);
        this.credentials.set(space, Promise.resolve(credential));
      }
      return credential;
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      if (this.currentNotifyGen(space) === startedNotifyGen) {
        this.bumpNotifyGen(space);
        this.notifyTargets.delete(space);
      }
      if (error instanceof SpaceCredentialError) {
        if (this.currentCacheGen(space) === startedCacheGen) {
          this.bumpCacheGen(space);
          this.bumpNotifyGen(space);
          this.inFlightOrdinaryMints.delete(space);
          this.credentials.delete(space);
          this.notifyTargets.delete(space);
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
        if (existing && existing.notify === undefined && this.isUsable(existing)) {
          return existing;
        }
      }
      try {
        const fallback = await raceWithSignal(
          mintSpaceCredentialWith(this.transport, space, signal ? { signal } : undefined),
          signal,
        );
        if (signal?.aborted) throw abortReason(signal);
        if (this.currentCacheGen(space) === startedCacheGen) {
          this.bumpCacheGen(space);
          this.inFlightOrdinaryMints.delete(space);
          this.credentials.set(space, Promise.resolve(fallback));
        }
        return fallback;
      } catch (fallbackError) {
        if (
          !signal?.aborted
          && fallbackError instanceof SpaceCredentialError
          && this.currentCacheGen(space) === startedCacheGen
        ) {
          this.bumpCacheGen(space);
          this.bumpNotifyGen(space);
          this.inFlightOrdinaryMints.delete(space);
          this.credentials.delete(space);
          this.notifyTargets.delete(space);
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
