import { safeFetch } from "@flock/net/safe-fetch";
import { sessionTransport, type AccountSession } from "../session-transport";
import type { ClientTransport } from "../transport";

/**
 * The engine's transport for an app's own OAuth session on Node. It is the browser's (`sessionTransport`) but for one thing:
 * the DID documents and hosts that members name are reached through `@flock/net`, public hosts only, as the operator reaches
 * them, since a server has no browser sandbox around it. An app password cannot mint a space credential (K7), which is why an app
 * holds an OAuth session at all.
 */
export function nodeTransport(session: AccountSession, identity: { plcUrl: string; loopback: boolean }): ClientTransport {
  const fetchPublicHost = safeFetch(() => identity.loopback);
  return sessionTransport(session, { ...identity, fetch: fetchPublicHost }, fetchPublicHost);
}
