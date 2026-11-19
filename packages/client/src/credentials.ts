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

  constructor(
    private readonly transport: ClientTransport,
    private readonly onAccessLost?: (space: string, error: SpaceCredentialError) => Promise<void>,
  ) {}

  async get(space: string, opts?: { notify?: SpaceNotifyTarget }): Promise<SpaceCredential> {
    const pending = this.credentials.get(space);
    if (pending) {
      const credential = await pending;
      const needsNotifyUpdate = opts?.notify !== undefined && !sameNotify(credential.notify, opts.notify);
      if (!needsNotifyUpdate && credential.expiresAt - transportNow(this.transport) > credential.renewBeforeMs) {
        return credential;
      }
      const current = this.credentials.get(space);
      if (current && current !== pending) {
        const next = await current;
        const currentNeedsUpdate = opts?.notify !== undefined && !sameNotify(next.notify, opts.notify);
        if (!currentNeedsUpdate && next.expiresAt - transportNow(this.transport) > next.renewBeforeMs) {
          return next;
        }
      }
      this.credentials.delete(space);
    }
    const effectiveNotify = opts?.notify ?? this.notifyTargets.get(space);
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
    this.credentials.delete(space);
    return this.get(space, opts);
  }

  /** A client for `did`'s host (a writer, or the space's authority), signed with the space's credential. */
  async clientFor(space: string, did: string): Promise<AtprotoClient> {
    const credential = await this.get(space);
    return credential.client(await this.transport.resolvePds(did));
  }

  drop(space: string, opts?: { clearNotify?: boolean }): void {
    this.credentials.delete(space);
    if (opts?.clearNotify) this.notifyTargets.delete(space);
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
