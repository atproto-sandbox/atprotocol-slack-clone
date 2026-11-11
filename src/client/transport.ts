import type { ResolveKemKey } from "@/atproto/space-credential-core";
import type { SpaceKey } from "@/atproto/space-key";
import type { AtprotoClient } from "@/atproto/xrpc";

/**
 * What the engine needs from its host, injected so the same code runs in the browser, in a Node bot and in tests: the
 * account's own authenticated client, DID resolution, the fetch it uses for other hosts, and a key generator for space
 * credentials.
 */
export type ClientTransport = {
  did: string;
  memberClient: AtprotoClient;
  resolvePds(did: string): Promise<string>;
  resolveKemKey: ResolveKemKey;
  fetchEndpoint(request: Request): Promise<Response>;
  generateKey(): Promise<SpaceKey>;
  now?: () => number;
};

export function transportNow(transport: Pick<ClientTransport, "now">): number {
  return transport.now ? transport.now() : Date.now();
}
