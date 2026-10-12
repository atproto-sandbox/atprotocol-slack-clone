import type { AtprotoDid, HandleResolver, OAuthSession } from "@atproto/oauth-client-browser";
import { buildDmClientMetadata } from "./client-metadata";
import { AtprotoClient } from "@/atproto/xrpc";
import { readUpstreamText } from "@/lib/bounded-json";

export type DmConfig = { appUrl: string; plcUrl: string; scope: string; serviceRef: string; loopback: boolean };

const MAX_WELL_KNOWN_DID_BYTES = 512;

export class DmAccountMismatchError extends Error {
  constructor() {
    super("The direct-message session belongs to a different account than the signed-in session.");
    this.name = "DmAccountMismatchError";
  }
}

async function loadDmClient(config: DmConfig) {
  const { BrowserOAuthClient, asResolvedHandle } = await import("@atproto/oauth-client-browser");
  const metadata = buildDmClientMetadata({ appUrl: config.appUrl, scope: config.scope });
  return BrowserOAuthClient.load({
    clientId: metadata.client_id,
    plcDirectoryUrl: config.plcUrl,
    allowHttp: new URL(config.appUrl).protocol === "http:",
    handleResolver: wellKnownHandleResolver(asResolvedHandle),
  });
}

/**
 * `BrowserOAuthClientOptions` requires a `handleResolver` (the browser cannot
 * do DNS lookups itself), but `connectDms`/`restoreDmSession` always sign in
 * with a DID from the already-established server session, never a raw
 * handle, so this path only exists to satisfy that requirement. It implements
 * just the official HTTP "well-known" strategy
 * (`https://<handle>/.well-known/atproto-did`) directly against the handle's
 * own domain: no DNS-over-HTTPS relay and no hosted third-party AppView (the
 * library's own README warns that a service such as bsky.social leaks the
 * handle and the caller's IP to that company), matching this feature's rule
 * that no company- or operator-run service may sit in the discovery path.
 */
export function wellKnownHandleResolver(asResolvedHandle: (value: string) => null | (string & AtprotoDid)): HandleResolver {
  return {
    async resolve(handle, options) {
      let response: Response;
      try {
        response = await fetch(`https://${handle}/.well-known/atproto-did`, { redirect: "error", signal: options?.signal });
      } catch {
        return null;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      const text = await readUpstreamText(response, MAX_WELL_KNOWN_DID_BYTES);
      return text ? asResolvedHandle(text.trim()) : null;
    },
  };
}

/** Redirects the browser to the user's PDS to authorize the DM scope set. Never returns normally. */
export async function connectDms(did: string, config: DmConfig): Promise<void> {
  const client = await loadDmClient(config);
  await client.signInRedirect(did);
}

/**
 * Restores an existing DM session (from IndexedDB) or, on the OAuth callback
 * page, completes the redirect and returns the freshly issued session. Either
 * way, a session for a DID other than `expectedDid` is revoked and rejected,
 * so one browser profile can never hold DM permissions for a different
 * account than the one the server session is signed in as.
 */
export async function restoreDmSession(expectedDid: string, config: DmConfig): Promise<OAuthSession | null> {
  const client = await loadDmClient(config);
  const result = await client.init();
  if (!result) return null;
  if (result.session.did !== expectedDid) {
    await client.revoke(result.session.sub);
    throw new DmAccountMismatchError();
  }
  return result.session;
}

export async function disconnectDms(config: DmConfig): Promise<void> {
  const client = await loadDmClient(config);
  const result = await client.initRestore();
  if (result) await client.revoke(result.session.sub);
}

export function dmXrpcClient(session: OAuthSession): AtprotoClient {
  return new AtprotoClient((path, init) => session.fetchHandler(path, init));
}
