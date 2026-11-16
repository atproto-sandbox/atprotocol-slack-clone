import { randomBytes } from "node:crypto";
import {
  JoseKey,
  NodeOAuthClient,
  type Jwk,
  type NodeSavedSession,
  type NodeSavedState,
  type OAuthSession,
} from "@atproto/oauth-client-node";
import { safeFetch } from "@flock/net/safe-fetch";
import { isLoopbackApp } from "./oauth";

// An app's second, identity-only OAuth client (`atproto` scope) for signing people into its own admin page at `/admin/oauth/*`
// without colliding with the app account's own OAuth client at `/oauth/*`. Sessions are revoked immediately after callback.

export const ADMIN_OAUTH_PATHS = {
  clientMetadata: "/admin/oauth/client-metadata.json",
  jwks: "/admin/oauth/jwks.json",
  callback: "/admin/oauth/callback",
} as const;

export const ADMIN_OAUTH_SCOPE = "atproto";
export const MAX_PENDING_ADMIN_STATES = 100;
export const ADMIN_STATE_TTL_MS = 10 * 60_000;

export class PendingSignInCapError extends Error {
  readonly status = 429;

  constructor() {
    super("Too many sign-in attempts are already in progress. Try again in a few minutes.");
    this.name = "PendingSignInCapError";
  }
}

export type AdminOAuthConfig = {
  appUrl: string;
  keys: readonly Jwk[];
  name: string;
  plcUrl: string;
  maxPendingStates?: number;
  stateTtlMs?: number;
  now?: () => number;
};

export function adminClientMetadata(config: Pick<AdminOAuthConfig, "appUrl" | "keys" | "name">) {
  const origin = new URL(config.appUrl).origin;
  const redirectUri = `${origin}${ADMIN_OAUTH_PATHS.callback}`;
  const common = {
    client_name: config.name,
    redirect_uris: [redirectUri] as [string],
    grant_types: ["authorization_code", "refresh_token"] as ["authorization_code", "refresh_token"],
    scope: ADMIN_OAUTH_SCOPE,
    response_types: ["code"] as ["code"],
    dpop_bound_access_tokens: true,
  };
  if (isLoopbackApp(config.appUrl)) {
    return {
      ...common,
      client_id: `http://localhost?${new URLSearchParams({ scope: ADMIN_OAUTH_SCOPE, redirect_uri: redirectUri }).toString()}`,
      token_endpoint_auth_method: "none" as const,
      application_type: "native" as const,
    };
  }
  if (config.keys.length === 0) {
    throw new Error("An app reached over https signs its token requests: give it at least one key.");
  }
  return {
    ...common,
    client_id: `${origin}${ADMIN_OAUTH_PATHS.clientMetadata}`,
    client_uri: origin,
    token_endpoint_auth_method: "private_key_jwt" as const,
    token_endpoint_auth_signing_alg: "ES256",
    jwks_uri: `${origin}${ADMIN_OAUTH_PATHS.jwks}`,
  };
}

export class BoundedAdminStateStore {
  private readonly entries = new Map<string, { value: NodeSavedState; createdAt: number }>();
  private readonly byAppState = new Map<string, string>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: { maxEntries?: number; ttlMs?: number; now?: () => number } = {}) {
    this.maxEntries = options.maxEntries ?? MAX_PENDING_ADMIN_STATES;
    this.ttlMs = options.ttlMs ?? ADMIN_STATE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    this.prune();
    return this.entries.size;
  }

  async get(key: string): Promise<NodeSavedState | undefined> {
    this.prune();
    return this.entries.get(key)?.value;
  }

  async set(key: string, value: NodeSavedState): Promise<void> {
    this.prune();
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      throw new PendingSignInCapError();
    }
    this.entries.set(key, { value, createdAt: this.now() });
    if (typeof value.appState === "string") {
      this.byAppState.set(value.appState, key);
    }
  }

  async del(key: string): Promise<void> {
    const existing = this.entries.get(key);
    this.entries.delete(key);
    if (typeof existing?.value.appState === "string" && this.byAppState.get(existing.value.appState) === key) {
      this.byAppState.delete(existing.value.appState);
    }
  }

  hasPending(protocolState: string, expectedAppState: string): boolean {
    this.prune();
    const entry = this.entries.get(protocolState);
    return entry !== undefined && entry.value.appState === expectedAppState;
  }

  takeProtocolState(appState: string): string | undefined {
    this.prune();
    const protocolState = this.byAppState.get(appState);
    this.byAppState.delete(appState);
    return protocolState;
  }

  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.createdAt >= this.ttlMs || now < entry.createdAt) {
        this.entries.delete(key);
        if (typeof entry.value.appState === "string" && this.byAppState.get(entry.value.appState) === key) {
          this.byAppState.delete(entry.value.appState);
        }
      }
    }
  }
}

export type AdminIdentityOAuth = {
  readonly client: NodeOAuthClient;
  readonly states: BoundedAdminStateStore;
  answerMetadataRoute(url: URL): { status: number; type: string; body: string } | null;
  startSignIn(handle: string): Promise<{ url: URL; state: string; appState: string }>;
  completeSignIn(params: URLSearchParams, expected: { state: string; appState: string }): Promise<{ did: string }>;
};

export async function createAdminIdentityOAuth(config: AdminOAuthConfig): Promise<AdminIdentityOAuth> {
  const loopback = isLoopbackApp(config.appUrl);
  const states = new BoundedAdminStateStore({
    maxEntries: config.maxPendingStates,
    ttlMs: config.stateTtlMs,
    now: config.now,
  });
  const transientSessions = new Map<string, NodeSavedSession>();
  const client = new NodeOAuthClient({
    clientMetadata: adminClientMetadata(config),
    keyset: await Promise.all(config.keys.map((key) => JoseKey.fromImportable(key, key.kid))),
    allowHttp: loopback,
    fetch: safeFetch(() => loopback),
    plcDirectoryUrl: config.plcUrl,
    stateStore: states,
    sessionStore: {
      get: async (key) => transientSessions.get(key),
      set: async (key, value) => { transientSessions.set(key, value); },
      del: async (key) => { transientSessions.delete(key); },
    },
  });

  return {
    client,
    states,
    answerMetadataRoute(url: URL) {
      if (url.pathname === ADMIN_OAUTH_PATHS.clientMetadata) {
        return { status: 200, type: "application/json", body: JSON.stringify(client.clientMetadata) };
      }
      if (url.pathname === ADMIN_OAUTH_PATHS.jwks) {
        return { status: 200, type: "application/json", body: JSON.stringify(client.jwks) };
      }
      return null;
    },
    async startSignIn(handle: string) {
      const appState = randomBytes(32).toString("base64url");
      try {
        const url = await client.authorize(handle, { scope: ADMIN_OAUTH_SCOPE, state: appState });
        const state = states.takeProtocolState(appState);
        if (!state) throw new Error("OAuth authorization did not record a pending state.");
        return { url, state, appState };
      } catch (error) {
        const leaked = states.takeProtocolState(appState);
        if (leaked) await states.del(leaked);
        throw error;
      }
    },
    async completeSignIn(params: URLSearchParams, expected: { state: string; appState: string }) {
      const state = params.get("state");
      if (!state || state !== expected.state || !states.hasPending(state, expected.appState)) {
        throw new Error("Sign-in state is missing, expired, or does not match this browser.");
      }
      let completedSession: OAuthSession | undefined;
      try {
        const { session, state: returnedAppState } = await client.callback(params);
        completedSession = session;
        if (returnedAppState !== expected.appState) {
          throw new Error("Sign-in callback state did not match this browser.");
        }
        return { did: session.did };
      } finally {
        if (completedSession) {
          await completedSession.signOut().catch(() => undefined);
          transientSessions.delete(completedSession.did);
        }
      }
    },
  };
}
