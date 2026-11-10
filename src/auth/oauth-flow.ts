import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NodeOAuthClient } from "@atproto/oauth-client-node";
import { isDid } from "@/protocol/keys";
import { canonicalOAuthScope } from "./oauth-scope";

/** Why a workspace-authority flow runs: to create a named workspace, or only to renew the grant. */
export type AuthorityFlowPurpose = { kind: "createWorkspace"; name: string } | { kind: "reauthorize" };

export type OAuthFlowBinding =
  | { kind: "login"; appState: string }
  | { kind: "permission"; expectedDid: string; appState: string; flowLockToken: string }
  | { kind: "authority"; expectedDid: string; initiatorDid: string; purpose: AuthorityFlowPurpose; expiresAt: number; appState: string };
type OAuthFlowIntent =
  | { kind: "login"; clientScope: string }
  | { kind: "permission"; expectedDid: string; clientScope: string; flowLockToken: string }
  | { kind: "authority"; expectedDid: string; initiatorDid: string; purpose: AuthorityFlowPurpose; expiresAt: number; clientScope: string };

const APP_STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const OAUTH_STATE_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;

type OAuthAuthorizeOptions = Parameters<NodeOAuthClient["authorize"]>[1];
type OAuthSavedState = { appState?: string };
type OAuthStateStore<T extends OAuthSavedState> = {
  get(key: string): Promise<T | undefined>;
  set(key: string, value: T): Promise<void>;
  del(key: string): Promise<void>;
};
export type OAuthFlowClient = Pick<NodeOAuthClient, "authorize"> & {
  clientMetadata: { scope?: string };
  takeProtocolStateForAppState(appState: string): string | undefined;
};

const MAX_PENDING_PROTOCOL_STATES = 256;

export function trackOAuthStateStore<T extends OAuthSavedState>(store: OAuthStateStore<T>): {
  store: OAuthStateStore<T>;
  takeProtocolStateForAppState(appState: string): string | undefined;
} {
  const protocolStates = new Map<string, string>();
  return {
    store: {
      get: (key) => store.get(key),
      async set(key, value) {
        await store.set(key, value);
        if (typeof value.appState !== "string") return;
        if (protocolStates.size >= MAX_PENDING_PROTOCOL_STATES) {
          const oldest = protocolStates.keys().next().value;
          if (oldest !== undefined) protocolStates.delete(oldest);
        }
        protocolStates.set(value.appState, key);
      },
      del: (key) => store.del(key),
    },
    takeProtocolStateForAppState(appState) {
      const state = protocolStates.get(appState);
      protocolStates.delete(appState);
      return state;
    },
  };
}

export function createOAuthFlowState(): string {
  return randomBytes(32).toString("base64url");
}

export function oauthFlowCookieName(state: string): string {
  return `spaces_oauth_${createHash("sha256").update(state).digest("hex")}`;
}

export function createOAuthFlowCookieValue(state: string, binding: OAuthFlowBinding, key: Buffer): string {
  if (!OAUTH_STATE_PATTERN.test(state) || !isBinding(binding)) throw new Error("Invalid OAuth flow binding.");
  const payload = Buffer.from(JSON.stringify(binding)).toString("base64url");
  const signature = sign(state, payload, key);
  return `${payload}.${signature}`;
}

export function readOAuthFlowCookieValue(state: string, value: string | undefined, key: Buffer): OAuthFlowBinding | null {
  if (!OAUTH_STATE_PATTERN.test(state) || !value) return null;
  const [payload, signature, extra] = value.split(".");
  if (extra !== undefined || !payload || !signature || !/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) {
    return null;
  }
  const expected = Buffer.from(sign(state, payload, key));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const binding: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return isBinding(binding) ? binding : null;
  } catch {
    return null;
  }
}

export async function startOAuthFlow(
  client: OAuthFlowClient,
  input: string,
  options: OAuthAuthorizeOptions,
  binding: OAuthFlowIntent,
  key: Buffer,
): Promise<{ url: URL; state: string; binding: OAuthFlowBinding; cookieValue: string }> {
  const clientScope = canonicalOAuthScope(binding.clientScope);
  const requestedScope = canonicalOAuthScope(options?.scope ?? client.clientMetadata.scope ?? "");
  if (requestedScope !== clientScope) throw new Error("OAuth client metadata does not match the requested scope.");
  const appState = createOAuthFlowState();
  let url: URL;
  try {
    url = await client.authorize(input, { ...options, state: appState });
  } catch (error) {
    client.takeProtocolStateForAppState(appState);
    throw error;
  }
  const state = client.takeProtocolStateForAppState(appState);
  const returnedState = url.searchParams.get("state");
  if (!state || !OAUTH_STATE_PATTERN.test(state) || (returnedState !== null && returnedState !== state)) {
    throw new Error("OAuth authorization did not produce a matching protocol state.");
  }
  const flowBinding = bindingFor(binding, appState);
  return { url, state, binding: flowBinding, cookieValue: createOAuthFlowCookieValue(state, flowBinding, key) };
}

export function assertOAuthFlowAppState(binding: OAuthFlowBinding, appState: string | null): void {
  if (appState !== binding.appState) throw new Error("OAuth callback state does not match this browser flow.");
}

function bindingFor(intent: OAuthFlowIntent, appState: string): OAuthFlowBinding {
  switch (intent.kind) {
    case "login":
      return { kind: "login", appState };
    case "permission":
      return { kind: "permission", expectedDid: intent.expectedDid, appState, flowLockToken: intent.flowLockToken };
    case "authority":
      return { kind: "authority", expectedDid: intent.expectedDid, initiatorDid: intent.initiatorDid, purpose: intent.purpose, expiresAt: intent.expiresAt, appState };
  }
}

function sign(state: string, payload: string, key: Buffer): string {
  return createHmac("sha256", key).update(state).update("\0").update(payload).digest("base64url");
}

function isBinding(value: unknown): value is OAuthFlowBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  if (binding.kind === "login") return Object.keys(binding).length === 2 && typeof binding.appState === "string" && APP_STATE_PATTERN.test(binding.appState);
  if (binding.kind === "authority") {
    return Object.keys(binding).length === 6 && isDid(binding.expectedDid) && isDid(binding.initiatorDid) &&
      isAuthorityFlowPurpose(binding.purpose) && Number.isSafeInteger(binding.expiresAt) &&
      typeof binding.appState === "string" && APP_STATE_PATTERN.test(binding.appState);
  }
  return binding.kind === "permission" && Object.keys(binding).length === 4 &&
    isDid(binding.expectedDid) &&
    typeof binding.appState === "string" && APP_STATE_PATTERN.test(binding.appState) &&
    typeof binding.flowLockToken === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(binding.flowLockToken);
}

export function isAuthorityFlowPurpose(value: unknown): value is AuthorityFlowPurpose {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const purpose = value as Record<string, unknown>;
  if (purpose.kind === "reauthorize") return Object.keys(purpose).length === 1;
  return purpose.kind === "createWorkspace" && Object.keys(purpose).length === 2 &&
    typeof purpose.name === "string" && purpose.name.length >= 1 && purpose.name.length <= 60;
}
