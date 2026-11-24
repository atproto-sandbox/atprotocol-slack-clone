import type { AtprotoDid, HandleResolver, OAuthSession } from "@atproto/oauth-client-browser";
import { readUpstreamText } from "@flock/protocol/bounded-json";
import { ALL_SPACE_TYPE, type AnySpaceType } from "@flock/protocol/nsids";
import { spaceCollections } from "@flock/protocol/registry";
import { buildDeskClientMetadata } from "./client-metadata";
import { assertSafeBrowserEndpointUrl, isExactLoopbackHost, UnsafeBrowserEndpointUrlError } from "./did-resolver";
import { IndexedDbLifecycleStore } from "./lifecycle-store";

export type DeskSessionConfig = {
  appUrl: string;
  plcUrl: string;
  scope: string;
};

const MAX_WELL_KNOWN_DID_BYTES = 512;
export const PENDING_INVITE_STORAGE_KEY = "flock.desk.pendingInvite";
const DEFAULT_DESK_SESSION_STORAGE_KEYS = [PENDING_INVITE_STORAGE_KEY] as const;

/**
 * Wraps `fetch` for `@atproto/oauth-client-browser` so every outbound OAuth request
 * (DID resolution, protected resource metadata, issuer discovery, PAR, token exchange)
 * is validated by `assertSafeBrowserEndpointUrl` and cannot silently follow redirects.
 */
export function createGuardedOAuthFetch(
  loopbackAllowed: boolean,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new UnsafeBrowserEndpointUrlError("Invalid OAuth request URL.");
    }
    if (parsed.username || parsed.password) {
      throw new UnsafeBrowserEndpointUrlError("OAuth request URL must not contain embedded credentials.");
    }
    // Validate the request origin against the full canonical private/non-public/loopback denylist
    // while preserving the XRPC/OAuth pathname and query string.
    assertSafeBrowserEndpointUrl(parsed.origin, loopbackAllowed);
    if (input instanceof Request) {
      const effectiveRedirect = init?.redirect ?? input.redirect;
      const alreadyNoFollow = effectiveRedirect === "error" || effectiveRedirect === "manual";
      if (init === undefined && alreadyNoFollow) {
        return fetchImpl(input);
      }
      // Buffer any Request body into an ArrayBuffer so Chromium never falls into HTTP/2-only
      // streaming `duplex: "half"` mode when overriding `redirect: "follow"` on HTTP/1.1 PDSes.
      const body =
        init?.body !== undefined
          ? init.body
          : input.body !== null
            ? await input.arrayBuffer()
            : undefined;
      const headers = new Headers(input.headers);
      if (init?.headers) {
        new Headers(init.headers).forEach((value, key) => headers.set(key, value));
      }
      const nextInit: RequestInit = {
        method: init?.method ?? input.method,
        headers,
        ...(body !== undefined ? { body } : {}),
        mode: init?.mode ?? input.mode,
        credentials: init?.credentials ?? input.credentials,
        cache: init?.cache ?? input.cache,
        referrer: init?.referrer ?? input.referrer,
        referrerPolicy: init?.referrerPolicy ?? input.referrerPolicy,
        integrity: init?.integrity ?? input.integrity,
        keepalive: init?.keepalive ?? input.keepalive,
        signal: init?.signal ?? input.signal,
        redirect: effectiveRedirect === "manual" ? "manual" : "error",
      };
      return fetchImpl(parsed.toString(), nextInit);
    }
    const nextRedirect = init?.redirect === "manual" ? "manual" : "error";
    return fetchImpl(parsed, { ...init, redirect: nextRedirect });
  };
}

type LoadedClient = Awaited<ReturnType<typeof import("@atproto/oauth-client-browser").BrowserOAuthClient.load>>;

type LoadedEntry = {
  clientId: string;
  client: Promise<LoadedClient>;
  session?: Promise<OAuthSession | null>;
};

let loaded: LoadedEntry | undefined;

export class DeskClientUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      `Flock Desk could not load its OAuth client (${cause instanceof Error ? cause.message : String(cause)}).`,
      { cause },
    );
    this.name = "DeskClientUnavailableError";
  }
}

/**
 * SSRF-hardened well-known handle resolver (`https://<handle>/.well-known/atproto-did`):
 * - Validates target URL with `assertSafeBrowserEndpointUrl(url, loopbackAllowed)` BEFORE calling `fetch()`,
 *   rejecting private/RFC1918/CGNAT/NAT64/6to4/Teredo/IPv4-mapped/metadata/local/disallowed-loopback targets.
 * - Uses `redirect: "error"` and enforces a 512-byte body cap via `readUpstreamText`.
 */
export function wellKnownHandleResolver(
  asResolvedHandle: (value: string) => null | (string & AtprotoDid),
  options: { loopbackAllowed: boolean; fetchImpl?: typeof fetch },
): HandleResolver {
  const fetchFn = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  return {
    async resolve(handle, resolveOptions) {
      if (typeof handle !== "string" || handle.length === 0 || /[\s/?#@\\]/.test(handle)) {
        return null;
      }
      const scheme = options.loopbackAllowed && isExactLoopbackHost(handle) ? "http" : "https";
      let targetUrl: URL;
      try {
        targetUrl = assertSafeBrowserEndpointUrl(
          `${scheme}://${handle}/.well-known/atproto-did`,
          options.loopbackAllowed,
        );
      } catch {
        return null;
      }
      let response: Response;
      try {
        response = await fetchFn(targetUrl, {
          redirect: "error",
          signal: resolveOptions?.signal,
        });
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

function loadEntry(config: DeskSessionConfig): LoadedEntry {
  const metadata = buildDeskClientMetadata({ appUrl: config.appUrl, scope: config.scope });
  if (loaded?.clientId === metadata.client_id) return loaded;
  const allowHttp = new URL(config.appUrl).protocol === "http:";
  const client = (async () => {
    const { BrowserOAuthClient, asResolvedHandle } = await import("@atproto/oauth-client-browser");
    const guardedFetch = createGuardedOAuthFetch(allowHttp);
    return BrowserOAuthClient.load({
      clientId: metadata.client_id,
      plcDirectoryUrl: config.plcUrl,
      allowHttp,
      fetch: guardedFetch,
      handleResolver: wellKnownHandleResolver(asResolvedHandle, {
        loopbackAllowed: allowHttp,
        fetchImpl: guardedFetch,
      }),
    });
  })();
  loaded = { clientId: metadata.client_id, client };
  client.catch(() => {
    if (loaded?.client === client) loaded = undefined;
  });
  return loaded;
}

function initializedSession(config: DeskSessionConfig): Promise<OAuthSession | null> {
  const entry = loadEntry(config);
  if (entry.session) return entry.session;
  const session = entry.client.then(
    async (client) => (await client.init())?.session ?? null,
    (cause: unknown) => {
      throw new DeskClientUnavailableError(cause);
    },
  );
  entry.session = session;
  session.catch(() => {
    if (entry.session === session) entry.session = undefined;
  });
  return session;
}

export async function signedInDeskDid(config: DeskSessionConfig): Promise<string | null> {
  return (await initializedSession(config))?.did ?? null;
}

export function validateDeskLoginInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Enter an ATProto handle or DID to sign in.");
  }
  if (trimmed.includes("://") || /^https?:/i.test(trimmed) || /[\s/?#\\]/.test(trimmed)) {
    throw new Error("Enter an ATProto handle (e.g. alice.example) or DID (did:...), not a server URL.");
  }
  return trimmed;
}

export async function signInDesk(input: string, config: DeskSessionConfig): Promise<void> {
  const validated = validateDeskLoginInput(input);
  await (await loadEntry(config).client).signInRedirect(validated);
}

export async function restoreDeskSession(
  config: DeskSessionConfig,
  loadSession: (cfg: DeskSessionConfig) => Promise<OAuthSession | null> = initializedSession,
): Promise<OAuthSession | null> {
  const session = await loadSession(config);
  if (!session) return null;
  const { scope } = await session.getTokenInfo(false);
  const missing = missingDeskScopes(scope, config.scope, session.did);
  if (missing.length > 0) return null;
  return session;
}

export async function signOutDesk(
  config: DeskSessionConfig,
  options?: {
    lifecycleStore?: { close(): void } | null;
    viewerDid?: string;
    sessionStorageKeys?: readonly string[];
  },
): Promise<void> {
  const session = await initializedSession(config).catch(() => null);
  const targetDid = options?.viewerDid ?? session?.did;
  options?.lifecycleStore?.close();
  if (session) {
    try {
      await session.signOut();
    } catch {
      const client = await loadEntry(config).client.catch(() => null);
      if (client) await client.revoke(session.sub).catch(() => undefined);
    }
  }
  loaded = undefined;
  if (targetDid && typeof indexedDB !== "undefined") {
    await IndexedDbLifecycleStore.deleteAccount(targetDid).catch(() => undefined);
  }
  if (typeof sessionStorage !== "undefined") {
    const keys = options?.sessionStorageKeys ?? DEFAULT_DESK_SESSION_STORAGE_KEYS;
    for (const key of keys) {
      try {
        sessionStorage.removeItem(key);
      } catch {
        // ignore restricted storage contexts
      }
    }
  }
}

// --- Pure scope coverage check (no legacy Operator exceptions) ---

type ReducedSpaceScope = {
  spaceType: string;
  authority: string;
  skey: string;
  actions: ReadonlySet<string>;
  manage: ReadonlySet<string>;
  collections: ReadonlySet<string>;
};

const KNOWN_SPACE_TYPES: ReadonlySet<string> = new Set(Object.values(ALL_SPACE_TYPE));
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
  const authority =
    rawAuthority === "*"
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
  const collections =
    rawCollections.length > 0
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

type ReducedRpcScope = { aud: string; lxms: ReadonlySet<string> };
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

export function missingDeskScopes(granted: string, required: string, accountDid: string): string[] {
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

  return required
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
        return !grantedRpcs.some((candidate) => coversRpcScope(candidate, requested));
      }
      return !haveExact.has(token);
    });
}
