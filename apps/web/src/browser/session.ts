import type { AtprotoDid, HandleResolver, OAuthSession } from "@atproto/oauth-client-browser";
import { buildBrowserClientMetadata } from "./client-metadata";
import { readUpstreamText } from "@flock/protocol/bounded-json";
import { SPACE_TYPE, type SpaceType } from "@flock/protocol/nsids";
import { spaceCollections } from "@flock/protocol/registry";

/** What the browser session is built from: the app's origin, the PLC, the one grant, and the operator (its DID and where it serves). */
export type BrowserSessionConfig = { appUrl: string; plcUrl: string; scope: string; serviceRef: string; operatorUrl: string; loopback: boolean };

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
  return missingScopes(scope, config.scope, session.did).length > 0 ? null : session;
}

type ReducedSpaceScope = {
  spaceType: string;
  authority: string;
  skey: string;
  actions: ReadonlySet<string>;
  manage: ReadonlySet<string>;
  collections: ReadonlySet<string>;
};

const KNOWN_SPACE_TYPES: ReadonlySet<string> = new Set(Object.values(SPACE_TYPE));
const SPACE_PARAM_KEYS: ReadonlySet<string> = new Set(["authority", "skey", "collection", "action", "manage"]);
const VALID_SPACE_ACTIONS: ReadonlySet<string> = new Set(["read_self", "read", "create", "update", "delete"]);
const VALID_MANAGE_OPS: ReadonlySet<string> = new Set(["create", "update", "delete"]);

function reduceSpaceScope(token: string, accountDid: string): ReducedSpaceScope | null {
  if (!token.startsWith("space:")) return null;
  const body = token.slice("space:".length);
  const queryIndex = body.indexOf("?");
  const spaceType = queryIndex === -1 ? body : body.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : body.slice(queryIndex + 1);
  if (!spaceType || query.includes("?")) return null;

  const params = new URLSearchParams(query);
  for (const key of params.keys()) {
    if (!SPACE_PARAM_KEYS.has(key)) return null;
  }
  if (params.getAll("authority").length > 1 || params.getAll("skey").length > 1) return null;

  const rawAuthority = params.get("authority") ?? "self";
  if (!rawAuthority) return null;
  const authority = rawAuthority === "*"
    ? "*"
    : rawAuthority === "self" || rawAuthority === accountDid
      ? "account"
      : `did:${rawAuthority}`;

  const skey = params.get("skey") ?? "*";
  if (!skey) return null;

  const rawActions = params.getAll("action");
  const actionList = rawActions.length > 0 ? rawActions : ["read", "create", "update", "delete"];
  if (actionList.some((action) => !VALID_SPACE_ACTIONS.has(action))) return null;
  const actions = new Set(actionList);
  if (actions.has("read")) actions.add("read_self");

  const rawManage = params.getAll("manage");
  if (rawManage.some((op) => !VALID_MANAGE_OPS.has(op))) return null;
  const manage = new Set(rawManage);

  const rawCollections = params.getAll("collection");
  if (rawCollections.some((collection) => !collection)) return null;
  const collections = rawCollections.length > 0
    ? new Set(rawCollections)
    : KNOWN_SPACE_TYPES.has(spaceType)
      ? new Set(spaceCollections(spaceType as SpaceType))
      : new Set([`__all__:${spaceType}`]);

  return { spaceType, authority, skey, actions, manage, collections };
}

function coversSpaceScope(granted: ReducedSpaceScope, requested: ReducedSpaceScope): boolean {
  if (granted.spaceType !== "*" && granted.spaceType !== requested.spaceType) return false;
  if (granted.authority !== "*" && granted.authority !== requested.authority) return false;
  if (granted.skey !== "*" && granted.skey !== requested.skey) return false;
  for (const action of requested.actions) {
    if (!granted.actions.has(action)) return false;
  }
  for (const op of requested.manage) {
    if (!granted.manage.has(op)) return false;
  }
  if (granted.collections.has("*")) return true;
  for (const collection of requested.collections) {
    if (!granted.collections.has(collection)) return false;
  }
  return true;
}

/**
 * The scope tokens in `required` that `granted` does not cover for `accountDid`. Non-`space:` tokens (`atproto`, `repo:`,
 * `rpc:`) must be present verbatim; each `space:` token is reduced to its space type, authority (`*` or the account itself for
 * `self` / `accountDid`), `skey`, actions, `manage` ops and collections (expanding collectionless tokens with
 * `spaceCollections`), and must be covered whole by at least one granted `space:` token.
 */
export function missingScopes(granted: string, required: string, accountDid: string): string[] {
  const grantedTokens = granted.split(/\s+/).filter(Boolean);
  const haveExact = new Set(grantedTokens);
  const grantedSpaces = grantedTokens
    .filter((token) => token.startsWith("space:"))
    .flatMap((token) => {
      const reduced = reduceSpaceScope(token, accountDid);
      return reduced ? [reduced] : [];
    });

  return required
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => {
      if (!token.startsWith("space:")) return !haveExact.has(token);
      const requested = reduceSpaceScope(token, accountDid);
      if (!requested) return true;
      return !grantedSpaces.some((candidate) => coversSpaceScope(candidate, requested));
    });
}

/** Signs the account out of this browser: its session is revoked at its host. */
export async function signOut(config: BrowserSessionConfig): Promise<void> {
  const session = await initialized(config);
  if (session) await (await load(config).client).revoke(session.sub);
}

