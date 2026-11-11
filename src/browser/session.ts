import type { AtprotoDid, HandleResolver, OAuthSession } from "@atproto/oauth-client-browser";
import { buildBrowserClientMetadata } from "./client-metadata";
import { AtprotoClient } from "@/atproto/xrpc";
import { readUpstreamText } from "@/lib/bounded-json";

export type BrowserSessionConfig = { appUrl: string; plcUrl: string; scope: string; serviceRef: string; loopback: boolean };

const MAX_WELL_KNOWN_DID_BYTES = 512;

type Client = Awaited<ReturnType<typeof import("@atproto/oauth-client-browser").BrowserOAuthClient.load>>;

/** The page's one OAuth client, and the one `init` that restores its session or completes a sign-in: shared by every caller. */
type Loaded = { clientId: string; client: Promise<Client>; session?: Promise<OAuthSession | null> };
let loaded: Loaded | undefined;

function load(config: BrowserSessionConfig): Loaded {
  const metadata = buildBrowserClientMetadata({ appUrl: config.appUrl, scope: config.scope });
  if (loaded?.clientId === metadata.client_id) return loaded;
  const client = (async () => {
    const { BrowserOAuthClient, asResolvedHandle } = await import("@atproto/oauth-client-browser");
    return BrowserOAuthClient.load({
      clientId: metadata.client_id,
      plcDirectoryUrl: config.plcUrl,
      allowHttp: new URL(config.appUrl).protocol === "http:",
      handleResolver: wellKnownHandleResolver(asResolvedHandle),
    });
  })();
  loaded = { clientId: metadata.client_id, client };
  // A client that could not load (its metadata unreachable) is loaded again by the next caller.
  client.catch(() => {
    if (loaded?.client === client) loaded = undefined;
  });
  return loaded;
}

/**
 * This page's OAuth client could not load (its metadata unreachable), so nothing is known about the session yet: trying again
 * may work. A restore that fails otherwise has ended the session (the library forgets it), and the person signs in again.
 */
export class ClientUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`This page could not load its sign-in client (${cause instanceof Error ? cause.message : String(cause)}).`, { cause });
    this.name = "ClientUnavailableError";
  }
}

/**
 * The account's session in this browser, restored or (on the callback page) completed now; null when nobody is signed in.
 * Kept for the page once it answers; a failure is not, so the next caller asks again.
 */
function initialized(config: BrowserSessionConfig): Promise<OAuthSession | null> {
  const entry = load(config);
  if (entry.session) return entry.session;
  const session = entry.client.then(
    async (client) => (await client.init())?.session ?? null,
    (cause: unknown) => { throw new ClientUnavailableError(cause); },
  );
  entry.session = session;
  session.catch(() => {
    if (entry.session === session) entry.session = undefined;
  });
  return session;
}

/**
 * How the browser resolves a handle a person signs in with (the browser cannot do DNS lookups itself): only the official
 * HTTP "well-known" strategy (`https://<handle>/.well-known/atproto-did`), directly against the handle's own domain. No
 * DNS-over-HTTPS relay and no hosted third-party AppView (the library's own README warns that a service such as bsky.social
 * leaks the handle and the caller's IP to that company), matching the rule that no company- or operator-run service may sit
 * in the discovery path. A handle published only in DNS signs in by its DID or by its host's address instead.
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

/** The DID signed in in this browser, whether or not its grant still covers every scope; null when nobody is. */
export async function signedInDid(config: BrowserSessionConfig): Promise<string | null> {
  return (await initialized(config))?.did ?? null;
}

/**
 * Sends the browser to sign in at the account's host with the app's one grant: `input` is a DID, a handle, or the host's
 * address. Never returns normally.
 */
export async function signIn(input: string, config: BrowserSessionConfig): Promise<void> {
  await (await load(config).client).signInRedirect(input);
}

/**
 * The signed-in session, or null when its grant lacks a scope the app asks for: a session granted before a scope was added
 * cannot use what that scope is for, so the person goes back through consent and the new grant replaces it.
 */
export async function restoreSession(config: BrowserSessionConfig): Promise<OAuthSession | null> {
  const session = await initialized(config);
  if (!session) return null;
  const { scope } = await session.getTokenInfo(false);
  return missingScopes(scope, config.scope).length > 0 ? null : session;
}

/**
 * The scope tokens in `required` that `granted` does not contain. `space:` tokens are not compared: the PDS rewrites them when it
 * grants them (`authority=self` becomes the account's DID, and a read grant gains the collection list), so a granted token never
 * equals the requested one. The other tokens (`atproto`, `repo:`, `rpc:`) are returned as requested.
 */
export function missingScopes(granted: string, required: string): string[] {
  const have = new Set(granted.split(/\s+/).filter(Boolean));
  return required.split(/\s+/).filter((token) => token !== "" && !token.startsWith("space:")).filter((token) => !have.has(token));
}

/** Signs the account out of this browser: its session is revoked at its host. */
export async function signOut(config: BrowserSessionConfig): Promise<void> {
  const session = await initialized(config);
  if (session) await (await load(config).client).revoke(session.sub);
}

export function sessionXrpcClient(session: OAuthSession): AtprotoClient {
  return new AtprotoClient((path, init) => session.fetchHandler(path, init));
}
