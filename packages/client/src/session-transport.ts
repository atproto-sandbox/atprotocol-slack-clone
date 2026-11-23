import { generateSpaceKey } from "@flock/protocol/atproto/space-key";
import { AtprotoClient } from "@flock/protocol/atproto/xrpc";
import { resolveKemKey, resolvePds, type IdentityConfig } from "./did-documents";
import type { ClientTransport } from "./transport";

/** An account's OAuth session as either OAuth client gives it, the browser's or a Node app's. */
export type AccountSession = { did: string; fetchHandler(path: string, init: RequestInit): Promise<Response> };

/**
 * The engine's transport for an account's OAuth session: the account's own requests through the session, identities through the
 * shared resolver, other hosts through `fetchEndpoint`. A person's browser and a Node app differ only in that fetch: a Node app
 * reaches public hosts only (`@flock/client/node/transport`).
 */
export function sessionTransport(session: AccountSession, identity: IdentityConfig, fetchEndpoint: (request: Request) => Promise<Response>): ClientTransport {
  return {
    did: session.did,
    memberClient: new AtprotoClient((path, init) => session.fetchHandler(path, init)),
    resolvePds: (did, forceRefresh) => resolvePds(did, identity, forceRefresh),
    resolveKemKey: (did, forceRefresh) => resolveKemKey(did, identity, forceRefresh),
    fetchEndpoint,
    generateKey: generateSpaceKey,
  };
}
