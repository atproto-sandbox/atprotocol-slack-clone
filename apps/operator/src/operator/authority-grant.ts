import { createHash, randomBytes } from "node:crypto";
import { SimpleStoreMemory } from "@atproto-labs/simple-store-memory";
import { JoseKey } from "@atproto/jwk-jose";
import {
  NodeOAuthClient,
  type NodeOAuthClientOptions,
  TokenInvalidError,
  TokenRefreshError,
  TokenRevokedError,
  type NodeSavedSession,
  type NodeSavedState,
  type OAuthSession,
} from "@atproto/oauth-client-node";
import { fetchValidatedEndpoint } from "../atproto/identity";
import { oauthSqliteStore, oauthSqliteView, UnreadableStoredValueError } from "../auth/encrypted-store";
import {
  assertOAuthFlowAppState,
  isAuthorityFlowPurpose,
  oauthFlowCookieName,
  readOAuthFlowCookieValue,
  startOAuthFlow,
  trackOAuthStateStore,
  type AuthorityFlowPurpose,
  type OAuthFlowClient,
} from "../auth/oauth-flow";
import { oauthSqliteRequestLock } from "../auth/oauth-request-lock";
import { canonicalOAuthScope } from "../auth/oauth-scope";
import { workspaceAuthorityScopes } from "@flock/protocol/scopes";
import { getConfig } from "@flock/deployment/config";
import { getAuthorityClientKeys, getOperatorConfig, type AuthorityClientKey } from "../config";
import { getRawDb } from "../lib/db";
import { canonicalJson, isDid } from "@flock/protocol/keys";

// The workspace authority grant: the one OAuth session the operator administers a workspace with, held per authority DID.
// It is separate from any person's sign-in: a sign-in never writes it and a sign-out never revokes it. It is created only
// by the authority flow below (ticket, top-level navigation to /authority/start, PDS consent, /authority/callback), which
// is bound end to end to who started it, for which account, and why.

export const AUTHORITY_FLOW_PATHS = {
  start: "/authority/start",
  callback: "/authority/callback",
  clientMetadata: "/authority/client-metadata.json",
  jwks: "/authority/jwks.json",
} as const;

const TICKET_SECONDS = 2 * 60;
const FLOW_SECONDS = 15 * 60;

/** The operator holds no usable grant for this authority; an admin operation needs the authority to approve again. */
export class AuthorityReauthorizationRequiredError extends Error {
  constructor(readonly authorityDid: string, options?: ErrorOptions) {
    super("The workspace authority must approve its permission again.", options);
    this.name = "AuthorityReauthorizationRequiredError";
  }
}

/** The authority flow was refused: a bad, used or expired ticket or state, a missing flow cookie, or the wrong account. */
export class AuthorityFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorityFlowError";
  }
}

export type AuthorityTicketInput = { initiatorDid: string; authorityDid: string; purpose: AuthorityFlowPurpose };
export type CompletedAuthorityFlow = { authorityDid: string; initiatorDid: string; purpose: AuthorityFlowPurpose };

/** The scope every authority grant asks for: the same for every workspace, so one client ID serves them all. */
export function authorityGrantScope(): string {
  return canonicalOAuthScope(["atproto", ...workspaceAuthorityScopes()]);
}

/**
 * The authority client's metadata. Outside loopback development it is a confidential `private_key_jwt` client whose keys
 * are published at the JWKS route, so the PDS gives it the extended session lifetime. Loopback development cannot be
 * confidential (the PDS forces loopback clients public), so there it is a public loopback client.
 */
type AuthorityClientConfig = { operatorUrl: URL; authorityClientKeys: readonly AuthorityClientKey[] };

function authorityClientConfig(): AuthorityClientConfig {
  return { operatorUrl: getConfig().operatorUrl, authorityClientKeys: getAuthorityClientKeys() };
}

export function authorityClientMetadata(config: AuthorityClientConfig = authorityClientConfig()) {
  const origin = config.operatorUrl.origin;
  const redirectUri = `${origin}${AUTHORITY_FLOW_PATHS.callback}`;
  const scope = authorityGrantScope();
  const common = {
    client_name: "Spaces workspace authority",
    redirect_uris: [redirectUri] as [string],
    grant_types: ["authorization_code", "refresh_token"] as ["authorization_code", "refresh_token"],
    scope,
    response_types: ["code"] as ["code"],
    dpop_bound_access_tokens: true,
  };
  if (config.operatorUrl.protocol === "http:") {
    return {
      ...common,
      client_id: `http://localhost?${new URLSearchParams({ scope, redirect_uri: redirectUri }).toString()}`,
      token_endpoint_auth_method: "none" as const,
      application_type: "native" as const,
    };
  }
  if (config.authorityClientKeys.length === 0) throw new Error("The authority client has no signing keys.");
  return {
    ...common,
    client_id: `${origin}${AUTHORITY_FLOW_PATHS.clientMetadata}`,
    client_uri: origin,
    token_endpoint_auth_method: "private_key_jwt" as const,
    token_endpoint_auth_signing_alg: "ES256",
    jwks_uri: `${origin}${AUTHORITY_FLOW_PATHS.jwks}`,
    application_type: "web" as const,
  };
}

/** The public half of every configured authority client key, for the JWKS route. */
export function authorityPublicJwks(config: Pick<AuthorityClientConfig, "authorityClientKeys"> = authorityClientConfig()): { keys: Array<Record<string, string>> } {
  return { keys: config.authorityClientKeys.map(({ kty, crv, x, y, kid }) => ({ kty, crv, x, y, kid, alg: "ES256", use: "sig" })) };
}

export function authorityStartUrl(ticket: string): URL {
  const url = new URL(AUTHORITY_FLOW_PATHS.start, getConfig().operatorUrl);
  url.searchParams.set("ticket", ticket);
  return url;
}

/** A single-use, two-minute ticket that lets one top-level navigation start the authority flow. */
export function issueAuthorityTicket(input: AuthorityTicketInput, now = unixNow()): string {
  if (!isDid(input.initiatorDid) || !isDid(input.authorityDid) || !isAuthorityFlowPurpose(input.purpose)) {
    throw new AuthorityFlowError("Invalid authority approval request.");
  }
  // Until a workspace can be created under an authority other than its creator (R8), the creator is the authority.
  if (input.authorityDid !== input.initiatorDid) throw new AuthorityFlowError("Only the authority account can approve its own permission.");
  const ticket = randomBytes(32).toString("base64url");
  const db = getRawDb();
  db.transaction(() => {
    db.prepare("DELETE FROM authority_ticket WHERE expires_at <= ?").run(now);
    db.prepare("INSERT INTO authority_ticket (token_hash, initiator_did, authority_did, purpose_json, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(hashTicket(ticket), input.initiatorDid, input.authorityDid, JSON.stringify(input.purpose), now + TICKET_SECONDS);
  })();
  return ticket;
}

/** Consumes a ticket: it is gone after the first attempt, whether or not it was still valid. */
export function consumeAuthorityTicket(ticket: string, now = unixNow()): AuthorityTicketInput | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) return null;
  const row = getRawDb().prepare("DELETE FROM authority_ticket WHERE token_hash = ? RETURNING initiator_did, authority_did, purpose_json, expires_at")
    .get(hashTicket(ticket)) as { initiator_did: string; authority_did: string; purpose_json: string; expires_at: number } | undefined;
  if (!row || row.expires_at <= now) return null;
  const purpose: unknown = JSON.parse(row.purpose_json);
  if (!isAuthorityFlowPurpose(purpose)) return null;
  return { initiatorDid: row.initiator_did, authorityDid: row.authority_did, purpose };
}

/**
 * The operator URL that starts the authority flow for `did` as its own authority (R1: the initiator is the authority): a
 * ticket for creating the named workspace, or, without a name, for reauthorizing. A browser opens it as a top-level navigation.
 */
export function authorityFlowUrl(did: string, workspaceName: string | null, now = unixNow()): URL {
  const ticket = issueAuthorityTicket({
    initiatorDid: did,
    authorityDid: did,
    purpose: workspaceName ? { kind: "createWorkspace", name: workspaceName } : { kind: "reauthorize" },
  }, now);
  return authorityStartUrl(ticket);
}

/** Starts the flow a ticket allows: returns the PDS authorization URL and the per-flow cookie that binds it to this browser. */
export async function beginAuthorityFlow(ticket: string, now = unixNow()): Promise<{ url: URL; cookieName: string; cookieValue: string }> {
  const intent = consumeAuthorityTicket(ticket, now);
  if (!intent) throw new AuthorityFlowError("This approval link is invalid, already used, or expired.");
  const scope = authorityGrantScope();
  const flow = await startOAuthFlow(await authorityGrantClient(), intent.authorityDid, { scope }, {
    kind: "authority",
    expectedDid: intent.authorityDid,
    initiatorDid: intent.initiatorDid,
    purpose: intent.purpose,
    expiresAt: now + FLOW_SECONDS,
    clientScope: scope,
  }, getOperatorConfig().encryptionKey);
  return { url: flow.url, cookieName: oauthFlowCookieName(flow.state), cookieValue: flow.cookieValue };
}

export type AuthorityCallbackClient = {
  callback(params: URLSearchParams): Promise<{ session: { did: string; signOut(): Promise<void> }; state: string | null }>;
};

export type AuthorityCallbackDeps = {
  /** An OAuth client whose session store is `staged`, so nothing reaches the grant table before the account is checked. */
  callbackClient(staged: Map<string, NodeSavedSession>): Promise<AuthorityCallbackClient>;
  persistGrant(did: string, saved: NodeSavedSession): Promise<void>;
};

/**
 * Completes the flow. The callback runs against a throwaway session store: the OAuth client revokes any stored session of
 * the account that signed in before storing the new one, so running it against the grant table would let a sign-in as the
 * wrong account destroy that account's own grant. Only a session for the intended authority, from the browser that started
 * the flow, before its expiry, is written; any other is revoked.
 */
export async function completeAuthorityFlow(
  params: URLSearchParams,
  cookieValue: string | undefined,
  deps: AuthorityCallbackDeps = defaultCallbackDeps,
  now = unixNow(),
): Promise<CompletedAuthorityFlow> {
  const binding = readOAuthFlowCookieValue(params.get("state") ?? "", cookieValue, getOperatorConfig().encryptionKey);
  if (binding?.kind !== "authority") throw new AuthorityFlowError("This approval is not bound to this browser.");
  if (binding.expiresAt <= now) throw new AuthorityFlowError("This approval expired. Start again.");
  const staged = new Map<string, NodeSavedSession>();
  const { session, state } = await (await deps.callbackClient(staged)).callback(params);
  try {
    assertOAuthFlowAppState(binding, state);
    if (session.did !== binding.expectedDid) throw new AuthorityFlowError("You signed in as a different account than the workspace authority.");
  } catch (error) {
    await session.signOut().catch(() => undefined);
    throw error;
  }
  const saved = staged.get(session.did);
  if (!saved) throw new AuthorityFlowError("The approved session was not returned.");
  try {
    await deps.persistGrant(session.did, saved);
  } catch (error) {
    // Nothing else holds this session, so it must not stay live at the PDS.
    await session.signOut().catch(() => undefined);
    throw error;
  }
  return { authorityDid: session.did, initiatorDid: binding.initiatorDid, purpose: binding.purpose };
}

/**
 * The authority's grant as a live session. A missing grant, one the PDS no longer honors, one that cannot be decrypted, or
 * one approved with a client key that is no longer configured needs a new approval. A grant's refreshes stay signed with
 * the key it was approved with, so that last case is checked before the OAuth client would delete the grant for it: putting
 * the key back restores the grant.
 *
 * The session sees only the approval it was restored from (`approvalView`). The OAuth client reads a session's tokens from
 * the store on every request but keeps the DPoP key it was restored with, so a session still in use after the authority
 * approves again would otherwise sign the new approval's tokens with the old key; the host refuses that, and the client
 * answers by deleting the stored grant, the new one. Pinned, such a session finds no grant and fails, and the new grant stays.
 */
export function restoreAuthorityGrant(did: string): Promise<OAuthSession> {
  return restoreApproval(did, true);
}

async function restoreApproval(did: string, againIfReplaced: boolean): Promise<OAuthSession> {
  const stored = await readable(grantStore().get(did));
  if (!stored || !clientKeyAvailable(stored)) throw new AuthorityReauthorizationRequiredError(did);
  try {
    const session = await (await createAuthorityClient(approvalView(stored))).restore(did);
    if (session.did !== did) throw new AuthorityReauthorizationRequiredError(did);
    return session;
  } catch (error) {
    // The authority approved again between the read above and the restore, which then found no grant of its approval: the
    // new approval is restored instead, once.
    if (againIfReplaced && error instanceof TokenRefreshError && await approvedAgainSince(did, stored)) return restoreApproval(did, false);
    // Refused at refresh, or revoked or deleted meanwhile: only a new approval gives the operator a usable grant.
    if (error instanceof TokenRefreshError || error instanceof TokenRevokedError || error instanceof TokenInvalidError || error instanceof UnreadableStoredValueError) {
      throw new AuthorityReauthorizationRequiredError(did, { cause: error });
    }
    throw error;
  }
}

export function hasAuthorityGrant(did: string): boolean {
  return Boolean(getRawDb().prepare("SELECT 1 FROM authority_grant WHERE key = ?").get(did));
}

/**
 * The documented operator action: deletes the grant and signs it out at its PDS. Admin operations then need a new approval.
 * The row is read and deleted under the grant's lock, so a replacement approved meanwhile is never the row deleted. A row
 * that cannot be decrypted is still deleted, but there is no session to sign out ("deleted"). If the PDS cannot be reached,
 * the row is gone and the error is thrown for the operator to see.
 */
export async function revokeAuthorityGrant(did: string): Promise<"none" | "revoked" | "deleted"> {
  const store = grantStore();
  const removed = await withGrantLock(did, async () => {
    if (!hasAuthorityGrant(did)) return null;
    const current = await readable(store.get(did));
    await store.del(did);
    return { current };
  });
  if (!removed) return "none";
  if (!removed.current) return "deleted";
  await revokeDetached(did, removed.current);
  return "revoked";
}

/**
 * Writes the new grant, then revokes the one it replaced. Both the write and the read of the old grant hold the lock the
 * OAuth client refreshes a grant under, so a refresh in flight finishes on the old grant first instead of deleting the new
 * one when its token is revoked. The revocation runs after the lock is released, because revoking takes that lock too. A
 * revocation that fails does not undo the new grant; it is recorded, and the old session, which nothing holds any more,
 * lapses with its lifetime.
 */
export async function persistAuthorityGrant(did: string, saved: NodeSavedSession): Promise<void> {
  const store = grantStore();
  const replaced = await withGrantLock(did, async () => {
    const previous = await readable(store.get(did));
    await store.set(did, saved);
    return previous;
  });
  if (!replaced) return;
  await revokeDetached(did, replaced).catch((error: unknown) => {
    getRawDb().prepare("INSERT INTO audit_event (workspace, actor, operation_id, event, details_json, created_at) VALUES (?, ?, '', ?, ?, ?)")
      .run(did, did, "authorityGrantRevocationFailed", JSON.stringify({ error: error instanceof Error ? error.message.slice(0, 300) : "unknown" }), unixNow());
  });
}

/** The grant table as one approval's session sees it: that approval through its refreshes, and nothing that replaced it. */
function approvalView(approved: NodeSavedSession): Store<NodeSavedSession> {
  return oauthSqliteView<NodeSavedSession>("authority_grant", (value) => sameApproval(value, approved));
}

async function approvedAgainSince(did: string, approved: NodeSavedSession): Promise<boolean> {
  const current = await readable(grantStore().get(did));
  return current !== undefined && !sameApproval(current, approved);
}

/** Each approval has its own DPoP key, and its refreshes keep it. */
function sameApproval(left: NodeSavedSession, right: NodeSavedSession): boolean {
  return canonicalJson(left.dpopJwk) === canonicalJson(right.dpopJwk);
}

function clientKeyAvailable(saved: NodeSavedSession): boolean {
  const authMethod = saved.authMethod as { method?: string; kid?: string } | undefined;
  if (authMethod?.method !== "private_key_jwt") return true;
  return getAuthorityClientKeys().some((key) => key.kid === authMethod.kid);
}

/** A stored grant, or nothing when the row cannot be decrypted (corrupt, or written under another key): it holds no usable session. */
async function readable(value: Promise<NodeSavedSession | undefined>): Promise<NodeSavedSession | undefined> {
  try {
    return await value;
  } catch (error) {
    if (error instanceof UnreadableStoredValueError) return undefined;
    throw error;
  }
}

/** The lock the OAuth client takes for every read, refresh and delete of this DID's stored session. */
async function withGrantLock<T>(did: string, action: () => Promise<T>): Promise<T> {
  return await oauthSqliteRequestLock(`@atproto-oauth-client-${did}`, action);
}

/** Revokes a session that is no longer in the grant table, through a client whose only store is that session. */
async function revokeDetached(did: string, saved: NodeSavedSession): Promise<void> {
  const staged = new Map([[did, saved]]);
  await (await createAuthorityClient(mapStore(staged))).revoke(did);
}

const defaultCallbackDeps: AuthorityCallbackDeps = {
  callbackClient: async (staged) => createAuthorityClient(mapStore(staged)),
  persistGrant: persistAuthorityGrant,
};

type Store<T> = { get(key: string): Promise<T | undefined>; set(key: string, value: T): Promise<void>; del(key: string): Promise<void> };

let grantClient: Promise<OAuthFlowClient & NodeOAuthClient> | undefined;

/**
 * The caches every authority client shares (the library's defaults, kept once per process), so a client made for one restore
 * does not fetch the authorization server's metadata or a DPoP nonce again.
 */
const sharedClientCaches: Pick<NodeOAuthClientOptions, "dpopNonceCache" | "authorizationServerMetadataCache" | "protectedResourceMetadataCache"> = {
  dpopNonceCache: new SimpleStoreMemory({ ttl: 60e3, max: 100 }),
  authorizationServerMetadataCache: new SimpleStoreMemory({ ttl: 60e3, max: 100 }),
  protectedResourceMetadataCache: new SimpleStoreMemory({ ttl: 60e3, max: 100 }),
};
let stateTracker: ReturnType<typeof trackOAuthStateStore<NodeSavedState>> | undefined;

const refuseSessions = () => Promise.reject(new Error("The authority flow client holds no session; restore a grant with restoreAuthorityGrant."));
const NO_SESSIONS: Store<NodeSavedSession> = { get: refuseSessions, set: refuseSessions, del: refuseSessions };

/**
 * The client that starts flows. It holds no session: a restore uses a client of its own over one approval (`approvalView`),
 * and a callback one over a staged store.
 */
function authorityGrantClient(): Promise<OAuthFlowClient & NodeOAuthClient> {
  grantClient ??= createAuthorityClient(NO_SESSIONS).then((client) => Object.assign(client, {
    takeProtocolStateForAppState: stateStore().takeProtocolStateForAppState,
  }));
  return grantClient;
}

async function createAuthorityClient(sessionStore: Store<NodeSavedSession>): Promise<NodeOAuthClient> {
  const config = authorityClientConfig();
  return new NodeOAuthClient({
    clientMetadata: authorityClientMetadata(config),
    keyset: await Promise.all(config.authorityClientKeys.map((key) => JoseKey.fromImportable(key, key.kid))),
    fetch: fetchValidatedEndpoint,
    requestLock: oauthSqliteRequestLock,
    allowHttp: config.operatorUrl.protocol === "http:",
    plcDirectoryUrl: getConfig().plcDirectoryUrl,
    stateStore: stateStore().store,
    sessionStore,
    ...sharedClientCaches,
  });
}

/**
 * The flow states. Reading a state consumes it atomically: the OAuth client reads a state and deletes it in two steps, so two
 * callbacks racing with one state could otherwise both read it before either deleted it.
 */
function stateStore(): ReturnType<typeof trackOAuthStateStore<NodeSavedState>> {
  stateTracker ??= trackOAuthStateStore<NodeSavedState>(oauthSqliteStore<NodeSavedState>("authority_grant_state", { consumeOnRead: true }));
  return stateTracker;
}

function grantStore(): Store<NodeSavedSession> {
  return oauthSqliteStore<NodeSavedSession>("authority_grant");
}

function mapStore(map: Map<string, NodeSavedSession>): Store<NodeSavedSession> {
  return {
    get: async (key) => map.get(key),
    set: async (key, value) => { map.set(key, value); },
    del: async (key) => { map.delete(key); },
  };
}

function hashTicket(ticket: string): string {
  return createHash("sha256").update(ticket).digest("hex");
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}
