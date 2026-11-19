import {
  mintSpaceCredentialWith,
  SpaceCredentialError,
  type SpaceCredential,
  type SpaceNotifyTarget,
} from "@flock/protocol/atproto/space-credential-core";
import { XrpcError, type AtprotoClient } from "@flock/protocol/atproto/xrpc";
import { transportNow, type ClientTransport } from "./transport";

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

/**
 * One space credential per space, shared by everything an account reads: a credential is minted once, reused until it is
 * close to expiry, and minted again by whoever asks first after that. A credential a host refused is dropped by its holder.
 * The authority refusing to mint one (access lost, or the space deleted) is where the client learns to drop the space.
 */
export class CredentialCache {
  private readonly credentials = new Map<string, Promise<SpaceCredential>>();
  private readonly notifyTargets = new Map<string, SpaceNotifyTarget>();
  private readonly pendingNotifyMints = new Map<string, Promise<SpaceCredential>>();

  constructor(
    private readonly transport: ClientTransport,
    private readonly onAccessLost?: (space: string, error: SpaceCredentialError) => Promise<void>,
  ) {}

  async get(space: string, opts?: { notify?: SpaceNotifyTarget }): Promise<SpaceCredential> {
    if (opts?.notify !== undefined) {
      const pending = this.credentials.get(space);
      if (pending) {
        const existing = await pending.catch(() => undefined);
        if (existing && this.isUsable(existing) && sameNotify(existing.notify, opts.notify)) {
          this.notifyTargets.set(space, opts.notify);
          return existing;
        }
      }
      return this.mintSidecarNotify(space, opts.notify);
    }

    const pending = this.credentials.get(space);
    if (pending) {
      const credential = await pending;
      if (this.isUsable(credential)) {
        return credential;
      }
      const current = this.credentials.get(space);
      if (current && current !== pending) {
        const next = await current;
        if (this.isUsable(next)) {
          return next;
        }
      }
      this.credentials.delete(space);
    }
    const effectiveNotify = this.notifyTargets.get(space);
    const minted = this.mint(space, effectiveNotify);
    this.credentials.set(space, minted);
    try {
      return await minted;
    } catch (error) {
      if (this.credentials.get(space) === minted) this.credentials.delete(space);
      if (error instanceof SpaceCredentialError) {
        this.notifyTargets.delete(space);
        await this.onAccessLost?.(space, error);
      }
      throw error;
    }
  }

  /** A credential minted now, for a write that must not rely on membership checked up to ten minutes ago. */
  async fresh(space: string, opts?: { notify?: SpaceNotifyTarget }): Promise<SpaceCredential> {
    if (opts?.notify !== undefined) {
      return this.mintSidecarNotify(space, opts.notify);
    }
    this.credentials.delete(space);
    return this.get(space);
  }

  /**
   * Mints a brand-new un-notified credential (fresh `jti`) for single-use proof-of-possession without
   * triggering `{ notify }` confirmation or clobbering an active notified credential in the cache.
   */
  async mintFreshUnnotified(space: string): Promise<SpaceCredential> {
    try {
      const credential = await mintSpaceCredentialWith(this.transport, space);
      if (!this.credentials.has(space) && !this.notifyTargets.has(space)) {
        this.credentials.set(space, Promise.resolve(credential));
      }
      return credential;
    } catch (error) {
      if (error instanceof SpaceCredentialError) {
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
    this.notifyTargets.delete(space);
  }

  drop(space: string, opts?: { clearNotify?: boolean }): void {
    this.credentials.delete(space);
    if (opts?.clearNotify) this.notifyTargets.delete(space);
  }

  private isUsable(credential: SpaceCredential): boolean {
    return credential.expiresAt - transportNow(this.transport) > credential.renewBeforeMs;
  }

  private mintSidecarNotify(space: string, notify: SpaceNotifyTarget): Promise<SpaceCredential> {
    const mintKey = `${space}\0${notify.endpoint}\0${notify.token}`;
    const inFlight = this.pendingNotifyMints.get(mintKey);
    if (inFlight) return inFlight;

    const run: Promise<SpaceCredential> = this.runSidecarNotifyMint(space, notify).finally(() => {
      if (this.pendingNotifyMints.get(mintKey) === run) {
        this.pendingNotifyMints.delete(mintKey);
      }
    });

    this.pendingNotifyMints.set(mintKey, run);
    return run;
  }

  private async runSidecarNotifyMint(space: string, notify: SpaceNotifyTarget): Promise<SpaceCredential> {
    try {
      const credential = await mintSpaceCredentialWith(this.transport, space, { notify });
      this.notifyTargets.set(space, notify);
      this.credentials.set(space, Promise.resolve(credential));
      return credential;
    } catch (error) {
      this.notifyTargets.delete(space);
      if (error instanceof SpaceCredentialError) {
        this.credentials.delete(space);
        await this.onAccessLost?.(space, error);
        throw error;
      }
      if (!isRegistrationNotConfirmed(error)) {
        throw error;
      }
      const current = this.credentials.get(space);
      if (current) {
        const existing = await current.catch(() => undefined);
        if (existing && existing.notify === undefined && this.isUsable(existing)) {
          return existing;
        }
      }
      try {
        const fallback = await mintSpaceCredentialWith(this.transport, space);
        this.credentials.set(space, Promise.resolve(fallback));
        return fallback;
      } catch (fallbackError) {
        if (fallbackError instanceof SpaceCredentialError) {
          this.credentials.delete(space);
          await this.onAccessLost?.(space, fallbackError);
        }
        throw fallbackError;
      }
    }
  }

  private async mint(space: string, notify?: SpaceNotifyTarget): Promise<SpaceCredential> {
    if (notify) {
      try {
        const credential = await mintSpaceCredentialWith(this.transport, space, { notify });
        this.notifyTargets.set(space, notify);
        return credential;
      } catch (error) {
        if (!isRegistrationNotConfirmed(error)) throw error;
        this.notifyTargets.delete(space);
      }
    }
    return mintSpaceCredentialWith(this.transport, space);
  }
}
