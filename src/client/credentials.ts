import { mintSpaceCredentialWith, SpaceCredentialError, type SpaceCredential } from "@/atproto/space-credential-core";
import type { AtprotoClient } from "@/atproto/xrpc";
import { transportNow, type ClientTransport } from "./transport";

/**
 * One space credential per space, shared by everything an account reads: a credential is minted once, reused until it is
 * close to expiry, and minted again by whoever asks first after that. A credential a host refused is dropped by its holder.
 * The authority refusing to mint one (access lost, or the space deleted) is where the client learns to drop the space.
 */
export class CredentialCache {
  private readonly credentials = new Map<string, Promise<SpaceCredential>>();

  constructor(
    private readonly transport: ClientTransport,
    private readonly onAccessLost?: (space: string, error: SpaceCredentialError) => Promise<void>,
  ) {}

  async get(space: string): Promise<SpaceCredential> {
    const pending = this.credentials.get(space);
    if (pending) {
      const credential = await pending;
      if (credential.expiresAt - transportNow(this.transport) > credential.renewBeforeMs) return credential;
      const current = this.credentials.get(space);
      if (current && current !== pending) return current;
      this.credentials.delete(space);
    }
    const minted = mintSpaceCredentialWith(this.transport, space);
    this.credentials.set(space, minted);
    try {
      return await minted;
    } catch (error) {
      if (this.credentials.get(space) === minted) this.credentials.delete(space);
      if (error instanceof SpaceCredentialError) await this.onAccessLost?.(space, error);
      throw error;
    }
  }

  /** A credential minted now, for a write that must not rely on membership checked up to ten minutes ago. */
  async fresh(space: string): Promise<SpaceCredential> {
    this.credentials.delete(space);
    return this.get(space);
  }

  /** A client for `did`'s host (a writer, or the space's authority), signed with the space's credential. */
  async clientFor(space: string, did: string): Promise<AtprotoClient> {
    const credential = await this.get(space);
    return credential.client(await this.transport.resolvePds(did));
  }

  drop(space: string): void {
    this.credentials.delete(space);
  }
}
