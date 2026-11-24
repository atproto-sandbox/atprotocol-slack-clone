import type { AtprotoDid, HandleResolver, OAuthSession } from "@atproto/oauth-client-browser";
import { buildBrowserClientMetadata } from "./client-metadata";
import { readUpstreamText } from "@flock/protocol/bounded-json";
import { OPENSOCIAL_SPACE_TYPE, OPERATOR_METHOD, SPACE_TYPE, type AnySpaceType } from "@flock/protocol/nsids";
import { spaceCollections } from "@flock/protocol/registry";
import { LEGACY_OPERATOR_METHODS } from "@flock/protocol/scopes";

/** What the browser session is built from: the app's origin, the PLC, the one grant, the operator, and the default Group Host. */
export type BrowserSessionConfig = {
  appUrl: string;
  plcUrl: string;
  scope: string;
  serviceRef: string;
  operatorUrl: string;
  groupHostUrl?: string;
  loopback: boolean;
};

/** Restored OAuth session annotated with whether optional R12 DM notify-target scope upgrade requires reconnect. */
export type RestoredSession = OAuthSession & { readonly needsNotifyScopeUpgrade: boolean };

export type SessionScopeAssessment = {
  missing: string[];
  needsNotifyScopeUpgrade: boolean;
};

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
 * The signed-in session, or null when its grant lacks a required scope: a session granted before a required scope was added
 * goes back through consent so the new grant replaces it. Pre-R12 sessions lacking only the optional
 * `OPERATOR_METHOD.getDmNotifyTarget` operator RPC method remain admitted (`needsNotifyScopeUpgrade: true`) so existing
 * users stay signed in and fall back to polling until they reconnect (`D12.3b.1`).
 */
export async function restoreSession(
  config: BrowserSessionConfig,
  loadSession: (config: BrowserSessionConfig) => Promise<OAuthSession | null> = initialized,
): Promise<RestoredSession | null> {
  const session = await loadSession(config);
  if (!session) return null;
  const { scope } = await session.getTokenInfo(false);
  const assessment = assessSessionScopes(scope, config.scope, session.did);
  if (assessment.missing.length > 0) return null;
  Object.defineProperty(session, "needsNotifyScopeUpgrade", {
    value: assessment.needsNotifyScopeUpgrade,
    configurable: true,
    enumerable: true,
    writable: false,
  });
  return session as RestoredSession;
}

type ReducedSpaceScope = {
  spaceType: string;
  authority: string;
  skey: string;
  actions: ReadonlySet<string>;
  manage: ReadonlySet<string>;
  collections: ReadonlySet<string>;
};

const KNOWN_SPACE_TYPES: ReadonlySet<string> = new Set([
  ...Object.values(SPACE_TYPE),
  ...Object.values(OPENSOCIAL_SPACE_TYPE),
]);
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
      : `foreign:${rawAuthority}`;

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
      ? new Set(spaceCollections(spaceType as AnySpaceType))
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

type ReducedRpcScope = {
  aud: string;
  lxms: ReadonlySet<string>;
};

const RPC_PARAM_KEYS: ReadonlySet<string> = new Set(["aud", "lxm"]);

function reduceRpcScope(token: string): ReducedRpcScope | null {
  let positionalLxm: string | null = null;
  let query = "";
  if (token.startsWith("rpc?")) {
    query = token.slice("rpc?".length);
  } else if (token.startsWith("rpc:")) {
    const body = token.slice("rpc:".length);
    const queryIndex = body.indexOf("?");
    if (queryIndex === -1) return null;
    positionalLxm = body.slice(0, queryIndex);
    query = body.slice(queryIndex + 1);
    if (!positionalLxm) return null;
  } else {
    return null;
  }
  if (query.includes("?")) return null;

  const params = new URLSearchParams(query);
  for (const key of params.keys()) {
    if (!RPC_PARAM_KEYS.has(key)) return null;
  }
  const auds = params.getAll("aud");
  if (auds.length !== 1 || !auds[0]) return null;
  const aud = auds[0];

  const queryLxms = params.getAll("lxm");
  if (positionalLxm !== null) {
    if (queryLxms.length > 0) return null;
    return { aud, lxms: new Set([positionalLxm]) };
  }
  if (queryLxms.length === 0 || queryLxms.some((lxm) => !lxm)) return null;
  return { aud, lxms: new Set(queryLxms) };
}

function coversRpcScope(granted: ReducedRpcScope, requested: ReducedRpcScope): boolean {
  if (granted.aud !== "*" && granted.aud !== requested.aud) return false;
  if (granted.lxms.has("*")) return true;
  for (const lxm of requested.lxms) {
    if (!granted.lxms.has(lxm)) return false;
  }
  return true;
}

function coversLegacyPreR12RpcScope(granted: ReducedRpcScope, requested: ReducedRpcScope): boolean {
  if (granted.aud !== "*" && granted.aud !== requested.aud) return false;
  if (
    !requested.lxms.has(OPERATOR_METHOD.getDmNotifyTarget) &&
    !requested.lxms.has(OPERATOR_METHOD.getSpaceNotifyTarget)
  ) {
    return false;
  }
  for (const method of LEGACY_OPERATOR_METHODS) {
    if (!granted.lxms.has(method)) return false;
  }
  for (const lxm of requested.lxms) {
    if (lxm === OPERATOR_METHOD.getDmNotifyTarget || lxm === OPERATOR_METHOD.getSpaceNotifyTarget) continue;
    if (!granted.lxms.has(lxm)) return false;
  }
  return true;
}

/**
 * Assesses whether `granted` covers every token in `required` for `accountDid`, tolerating legacy pre-R12 `rpc` grants whose
 * only missing method is `OPERATOR_METHOD.getDmNotifyTarget` unless `options?.strict` is set (`D12.3b.1`).
 */
export function assessSessionScopes(
  granted: string,
  required: string,
  accountDid: string,
  options?: { strict?: boolean },
): SessionScopeAssessment {
  const grantedTokens = granted.split(/\s+/).filter(Boolean);
  const haveExact = new Set(grantedTokens);
  const grantedSpaces = grantedTokens
    .filter((token) => token.startsWith("space:"))
    .flatMap((token) => {
      const reduced = reduceSpaceScope(token, accountDid);
      return reduced ? [reduced] : [];
    });
  const grantedRpcs = grantedTokens
    .filter((token) => token.startsWith("rpc?") || token.startsWith("rpc:"))
    .flatMap((token) => {
      const reduced = reduceRpcScope(token);
      return reduced ? [reduced] : [];
    });

  let needsNotifyScopeUpgrade = false;
  const missing = required
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => {
      if (token.startsWith("space:")) {
        const requested = reduceSpaceScope(token, accountDid);
        if (!requested) return true;
        return !grantedSpaces.some((candidate) => coversSpaceScope(candidate, requested));
      }
      if (token.startsWith("rpc?") || token.startsWith("rpc:")) {
        if (haveExact.has(token)) return false;
        const requested = reduceRpcScope(token);
        if (!requested) return true;
        if (grantedRpcs.some((candidate) => coversRpcScope(candidate, requested))) return false;
        if (!options?.strict && grantedRpcs.some((candidate) => coversLegacyPreR12RpcScope(candidate, requested))) {
          needsNotifyScopeUpgrade = true;
          return false;
        }
        return true;
      }
      return !haveExact.has(token);
    });

  return { missing, needsNotifyScopeUpgrade };
}

/**
 * The scope tokens in `required` that `granted` does not cover for `accountDid`. `atproto` and `repo:` tokens must be present
 * verbatim; `rpc` tokens match regardless of `lxm` ordering (and tolerate pre-R12 grants lacking only `getDmNotifyTarget`
 * unless `options?.strict` is true); each `space:` token is reduced to its space type, authority (`*` or the account itself for
 * `self` / `accountDid`), `skey`, actions, `manage` ops and collections (expanding collectionless tokens with
 * `spaceCollections`), and must be covered whole by at least one granted `space:` token.
 */
export function missingScopes(
  granted: string,
  required: string,
  accountDid: string,
  options?: { strict?: boolean },
): string[] {
  return assessSessionScopes(granted, required, accountDid, options).missing;
}

/** Signs the account out of this browser: its session is revoked at its host. */
export async function signOut(config: BrowserSessionConfig): Promise<void> {
  const session = await initialized(config);
  if (session) await (await load(config).client).revoke(session.sub);
}

