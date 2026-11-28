import { createHash, randomBytes, randomUUID } from "node:crypto";
import { BlockMap } from "@atproto/car";
import { P256Keypair } from "@atproto/crypto";
import { JoseKey } from "@atproto/jwk-jose";
import { encode as cborEncode } from "@atproto/lex-cbor";
import { cidForCbor, type LexMap, type LexValue } from "@atproto/lex-data";
import { NodeOAuthClient, type NodeSavedSession, type NodeSavedState } from "@atproto/oauth-client-node";
import { ScopePermissions } from "@atproto/oauth-scopes";
import {
  atprotoLoopbackClientMetadata,
  isOAuthClientIdLoopback,
  type OAuthClientMetadata,
} from "@atproto/oauth-types";
import { Repo, WriteOpAction } from "@atproto/repo";
import { RepoCommit, serializeRecord } from "@atproto/space";
import type { NsidString, RecordKeyString } from "@atproto/syntax";
import { cryptoVerifySignatureWithKey } from "@atproto/xrpc-server";
import { tombstoneOp, type Operation } from "@did-plc/lib";
import { boundedSafeFetch, BOUNDED_FETCH_PROFILES, type SafeFetch } from "@flock/net/safe-fetch";
import { readUpstreamJson } from "@flock/protocol/bounded-json";
import {
  groupMembersUri,
  groupMetaUri,
  isDid,
  SELF_SKEY,
} from "@flock/protocol/keys";
import {
  ATGRP_COLLECTION,
  ATGRP_POLICY,
  ATGRP_SPACE_TYPE,
  ATPROTO_SPACE_COLLECTION,
  FLOCK_EXTENSION_FIELD,
  REPO_COLLECTION,
} from "@flock/protocol/nsids";
import {
  effectiveMemberPermissions,
  expandGroupScopes,
  groupAdminScopes,
  groupModeratorScopes,
  InvalidScopeError,
  resolveAuthorizedGroupScope,
  UnauthorizedScopeError,
  type GroupAtgrpPolicy,
  type GroupRoleRecord,
} from "@flock/protocol/scopes";
import * as jose from "jose";
import { groupHostPdsServiceEndpoint, type GroupHostConfig } from "./config";
import {
  plainJsonToLexData as jsonToLex,
  sha256Base64Url,
  sha256HexBytes,
  type GroupHostCryptoBox,
  type ServiceSigningMaterial,
} from "./crypto-box";
import type { GroupHostDb } from "./db";
import { extractBearerToken, parseServiceJwtParts } from "./methods";
import {
  createGroupGenesisPlcOp,
  GroupHostHttpError,
  isSupportedPlcRotationDidKey,
  normalizeOriginUrl,
  plcCidForOp,
  plcOpRotationKeys,
  type PlcAndDidResolver,
} from "./plc";
import {
  effectiveStateForSession,
  isAuthorizedLifecycleAdmin,
  isPermissionSubset,
  loadLiveGovernanceState,
  type GroupRepoLockManager,
  type LiveGroupGovernanceState,
  type RecoveryAdminRow,
} from "./rbac";
import { nextMonotonicTid, SqlStagingRepoStorage, type GroupRepoStore } from "./repo-store";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const ACCESS_TOKEN_TTL_SEC = 900; // 15 minutes
const REFRESH_TOKEN_TTL_MS = 30 * DAY_MS;
const PAR_TTL_MS = 10 * MINUTE_MS;
const AUTH_CODE_TTL_MS = 5 * MINUTE_MS;
const DPOP_REPLAY_TTL_MS = 198_000; // 1.1 * 180s

export const RECOVERY_ALLOWED_XRPC_METHODS = new Set<string>([
  "com.atproto.server.checkAccountStatus",
  "com.atproto.server.activateAccount",
  "com.atproto.server.requestAccountDelete",
  "com.atproto.server.deleteAccount",
  "com.atproto.sync.getRepo",
  "com.atproto.sync.listBlobs",
  "com.atproto.sync.getBlob",
  "com.atproto.space.exportSpaceMeta",
]);

export class OAuthProtocolError extends Error {
  constructor(
    readonly status: number,
    readonly oauthError: string,
    readonly errorDescription: string,
    readonly wwwAuthenticate?: string,
  ) {
    super(errorDescription);
    this.name = "OAuthProtocolError";
  }
}

export type VerifiedDpopResult = {
  jkt: string;
  jti: string;
  freshNonce: string;
};

export type AuthenticatedGroupSession = {
  kind: "oauth";
  sessionId: string;
  familyId: string;
  groupDid: string;
  authorizingUserDid: string;
  clientId: string;
  sessionKind: "group" | "recovery";
  authenticatedAt: number;
  /** Timestamp of explicit upstream `prompt=login` step-up (or sovereign controller-session proof); `null` for ordinary/consent/create OAuth. */
  loginStepUpAt: number | null;
  authEpoch: number;
  dpopNonce: string;
  /** Intersects `sessionPerms` AND `liveMemberPerms` on every permission assertion! */
  permissions: EffectiveSessionPermissions;
};

/**
 * Enforces explicit `prompt=login` step-up (or sovereign controller-session proof) within the last 5 minutes.
 */
export function assertFreshLoginStepUp(
  session: { authenticatedAt: number; loginStepUpAt?: number | null },
  nowMs: number,
  message: string,
): void {
  const cutoff = nowMs - 5 * 60_000;
  if (
    session.loginStepUpAt === null ||
    session.loginStepUpAt === undefined ||
    session.loginStepUpAt < cutoff ||
    session.authenticatedAt < cutoff
  ) {
    throw new GroupHostHttpError(403, "FreshAuthRequired", message);
  }
}

export class EffectiveSessionPermissions {
  constructor(
    private readonly sessionPerms: ScopePermissions,
    private readonly livePerms: ScopePermissions,
  ) {}

  assertAccount(opts: Parameters<ScopePermissions["allowsAccount"]>[0]): void {
    if (!this.sessionPerms.allowsAccount(opts) || !this.livePerms.allowsAccount(opts)) {
      throw new GroupHostHttpError(403, "ScopeMissingError", `Missing account permission (${opts.attr}:${opts.action}).`);
    }
  }

  assertIdentity(opts: Parameters<ScopePermissions["allowsIdentity"]>[0]): void {
    if (!this.sessionPerms.allowsIdentity(opts) || !this.livePerms.allowsIdentity(opts)) {
      throw new GroupHostHttpError(403, "ScopeMissingError", `Missing identity permission (${opts.attr}).`);
    }
  }

  assertBlob(opts: Parameters<ScopePermissions["allowsBlob"]>[0]): void {
    if (!this.sessionPerms.allowsBlob(opts) || !this.livePerms.allowsBlob(opts)) {
      throw new GroupHostHttpError(403, "ScopeMissingError", `Missing blob upload permission for ${opts.mime}.`);
    }
  }

  allowsRepo(opts: Parameters<ScopePermissions["allowsRepo"]>[0]): boolean {
    return this.sessionPerms.allowsRepo(opts) && this.livePerms.allowsRepo(opts);
  }

  assertRepo(opts: Parameters<ScopePermissions["allowsRepo"]>[0]): void {
    if (!this.allowsRepo(opts)) {
      throw new GroupHostHttpError(
        403,
        "ScopeMissingError",
        `Missing repo permission (${String(opts.collection)}:${opts.action}).`,
      );
    }
  }

  assertRpc(opts: Parameters<ScopePermissions["allowsRpc"]>[0]): void {
    if (!this.sessionPerms.allowsRpc(opts) || !this.livePerms.allowsRpc(opts)) {
      throw new GroupHostHttpError(
        403,
        "ScopeMissingError",
        `Missing rpc permission (${String(opts.lxm)} -> ${String(opts.aud)}).`,
      );
    }
  }

  allowsSpace(
    target: Parameters<ScopePermissions["allowsSpace"]>[0],
    op: Parameters<ScopePermissions["allowsSpace"]>[1],
  ): boolean {
    return this.sessionPerms.allowsSpace(target, op) && this.livePerms.allowsSpace(target, op);
  }

  assertSpace(
    target: Parameters<ScopePermissions["allowsSpace"]>[0],
    op: Parameters<ScopePermissions["allowsSpace"]>[1],
  ): void {
    if (!this.allowsSpace(target, op)) {
      throw new GroupHostHttpError(403, "ScopeMissingError", "Missing space permission for requested operation.");
    }
  }
}

export type RevalidatedOAuthSessionState = {
  liveState: LiveGroupGovernanceState;
  effState: LiveGroupGovernanceState;
  recoveryRow: RecoveryAdminRow | undefined;
  permissions: EffectiveSessionPermissions;
};

/**
 * Re-verifies live `oauth_session`, `group_account`, `revoked_oauth_family`, `group_deletion_journal`,
 * `source_migration_lease` (`status = 'plc_signed'`), and live `effectiveMemberPermissions` synchronously
 * inside a `withGroupRepoLock` + `db.transaction(...).immediate()` critical section to close commit-time TOCTOU.
 */
export function revalidateLiveOAuthSessionSync(
  db: GroupHostDb,
  session: AuthenticatedGroupSession,
  options: {
    allowDeactivatedRecovery?: boolean;
    allowDeletionJournal?: boolean;
    allowPlcSignedSourceLease?: boolean;
    nowMs?: number;
  } = {},
): RevalidatedOAuthSessionState {
  const nowMs = options.nowMs ?? Date.now();
  const sess = db
    .prepare("SELECT * FROM oauth_session WHERE session_id = ?")
    .get(session.sessionId) as
    | {
        session_id: string;
        family_id: string;
        group_did: string;
        authorizing_user_did: string;
        client_id: string;
        approved_scope: string;
        dpop_jkt: string;
        session_kind: "group" | "recovery";
        auth_epoch: number;
        authenticated_at: number;
        expires_at: number;
      }
    | undefined;

  if (
    !sess ||
    sess.expires_at <= nowMs ||
    sess.group_did !== session.groupDid ||
    sess.authorizing_user_did !== session.authorizingUserDid ||
    db.prepare("SELECT 1 AS ok FROM revoked_oauth_family WHERE family_id = ?").get(sess.family_id)
  ) {
    throw new OAuthProtocolError(
      401,
      "invalid_token",
      "OAuth session expired or revoked.",
      'DPoP algs="ES256", error="invalid_token"',
    );
  }

  const acct = db
    .prepare("SELECT activated, takendown, auth_epoch FROM group_account WHERE did = ?")
    .get(sess.group_did) as { activated: number; takendown: number; auth_epoch: number } | undefined;
  if (!acct) {
    throw new GroupHostHttpError(400, "RepoNotFound", "Group not hosted here.");
  }
  if (
    acct.takendown !== 0 ||
    (!options.allowDeletionJournal &&
      db.prepare("SELECT 1 AS ok FROM group_deletion_journal WHERE group_did = ?").get(sess.group_did))
  ) {
    throw new GroupHostHttpError(401, "AccountTakedown", "Group account is taken down.");
  }
  if (acct.auth_epoch !== session.authEpoch || acct.auth_epoch !== sess.auth_epoch) {
    throw new OAuthProtocolError(
      401,
      "invalid_token",
      "Authorization epoch invalidated.",
      'DPoP algs="ES256", error="invalid_token"',
    );
  }
  if (acct.activated === 0 && !options.allowDeactivatedRecovery && sess.session_kind !== "recovery") {
    throw new GroupHostHttpError(401, "AccountDeactivated", "Group account is currently deactivated.");
  }
  if (
    !options.allowPlcSignedSourceLease &&
    db
      .prepare("SELECT 1 AS ok FROM source_migration_lease WHERE group_did = ? AND status = 'plc_signed'")
      .get(sess.group_did)
  ) {
    throw new GroupHostHttpError(409, "MigrationInProgress", "Group migration PLC cutover has been signed.");
  }

  const liveState = loadLiveGovernanceState(db, sess.group_did);
  const recoveryRow = db
    .prepare("SELECT * FROM group_recovery_admin WHERE group_did = ?")
    .get(sess.group_did) as RecoveryAdminRow | undefined;
  const effState = effectiveStateForSession(
    liveState,
    { sessionKind: sess.session_kind, authorizingUserDid: sess.authorizing_user_did },
    recoveryRow,
  );
  const sessionPerms = expandGroupScopes(sess.approved_scope.split(/\s+/).filter(Boolean), sess.group_did);
  const livePerms = effectiveMemberPermissions(effState, sess.group_did, sess.authorizing_user_did);

  return {
    liveState,
    effState,
    recoveryRow,
    permissions: new EffectiveSessionPermissions(sessionPerms, livePerms),
  };
}

function escapeHtml(raw: string): string {
  return raw
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeHtu(rawUrl: string, allowLoopback = false): string {
  const u = new URL(rawUrl);
  const lowerHost = u.hostname.toLowerCase();
  if (
    allowLoopback &&
    u.protocol === "http:" &&
    (lowerHost === "localhost" || lowerHost === "127.0.0.1" || lowerHost === "[::1]")
  ) {
    u.hostname = "localhost";
  }
  return `${u.origin}${u.pathname}`;
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

function formatSetCookie(params: {
  name: string;
  value: string;
  path: string;
  maxAgeSec: number;
  secure: boolean;
}): string {
  const directives = [
    `${params.name}=${encodeURIComponent(params.value)}`,
    `Path=${params.path}`,
    `Max-Age=${params.maxAgeSec}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (params.secure) directives.push("Secure");
  return directives.join("; ");
}

function slugifyHandleBase(displayName: string): string {
  const cleaned = displayName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 24)
    .replace(/-+$/g, "");
  return cleaned.length >= 2 ? cleaned : "group";
}

export function normalizeAndValidateGroupHandle(rawHandle: string, handleDomain: string): string {
  const lower = rawHandle.trim().toLowerCase();
  const suffix = `.${handleDomain}`;
  if (!lower.endsWith(suffix)) {
    throw new GroupHostHttpError(400, "UnsupportedDomain", `Group handle must end with ${suffix}`);
  }
  const slug = lower.slice(0, -suffix.length);
  if (
    slug.length < 1 ||
    slug.length > 63 ||
    slug.includes(".") ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)
  ) {
    throw new GroupHostHttpError(400, "InvalidHandle", `Invalid handle slug '${slug}' for ${handleDomain}`);
  }
  return lower;
}

type CreationFormParams = {
  displayName: string;
  handle?: string;
  joinPolicy: "invite" | "approval" | "open";
  publicMeta: boolean;
  creationKey: string;
  creatorApproved: boolean;
  reviewedScope?: string;
};

type ConsentCookiePayload = {
  requestUri: string;
  userDid: string;
  csrf: string;
  createParams?: CreationFormParams;
  expMs: number;
};

const graphemeSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
function countGraphemesLocal(text: string): number {
  let count = 0;
  for (const seg of graphemeSegmenter.segment(text)) {
    if (seg.segment.length >= 0) count += 1;
  }
  return count;
}

type NodeClientOpts = ConstructorParameters<typeof NodeOAuthClient>[0];
type AsMetaCacheVal = Parameters<NonNullable<NodeClientOpts["authorizationServerMetadataCache"]>["set"]>[1];
type PrMetaCacheVal = Parameters<NonNullable<NodeClientOpts["protectedResourceMetadataCache"]>["set"]>[1];

function createBoundedTtlStore<K extends string, V>(ttlMs: number, maxEntries: number) {
  const map = new Map<K, { value: V; exp: number }>();
  return {
    async get(key: K): Promise<V | undefined> {
      const hit = map.get(key);
      if (!hit) return undefined;
      if (hit.exp <= Date.now()) {
        map.delete(key);
        return undefined;
      }
      return hit.value;
    },
    async set(key: K, value: V): Promise<void> {
      map.delete(key);
      map.set(key, { value, exp: Date.now() + ttlMs });
      while (map.size > maxEntries) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
    },
    async del(key: K): Promise<void> {
      map.delete(key);
    },
  };
}

export class GroupHostOAuthService {
  private readonly oauthMetaFetcher: SafeFetch;
  private readonly jwksFetcher: SafeFetch;
  private readonly upstreamCaches = {
    dpopNonceCache: createBoundedTtlStore<string, string>(60_000, 200),
    authorizationServerMetadataCache: createBoundedTtlStore<string, AsMetaCacheVal>(60_000, 200),
    protectedResourceMetadataCache: createBoundedTtlStore<string, PrMetaCacheVal>(60_000, 200),
  };
  private readonly upstreamLocks = new Map<string, Promise<void>>();

  constructor(
    readonly db: GroupHostDb,
    readonly config: GroupHostConfig,
    readonly cryptoBox: GroupHostCryptoBox,
    readonly serviceKeys: ServiceSigningMaterial,
    readonly plc: PlcAndDidResolver,
    readonly locks: GroupRepoLockManager,
    readonly repoStore: GroupRepoStore,
  ) {
    this.oauthMetaFetcher =
      config.fetchImpl ?? boundedSafeFetch(() => config.allowLoopback, BOUNDED_FETCH_PROFILES.oauthMetadata);
    this.jwksFetcher =
      config.fetchImpl ?? boundedSafeFetch(() => config.allowLoopback, BOUNDED_FETCH_PROFILES.didAndJwks);
  }

  getProtectedResourceMetadata(hostHeader?: string): Record<string, unknown> {
    const pdsEndpoint = groupHostPdsServiceEndpoint(this.config);
    const resource =
      this.config.allowLoopback && hostHeader?.toLowerCase() === `localhost:${this.config.port}`
        ? pdsEndpoint
        : this.config.publicUrl;
    return {
      resource,
      authorization_servers: [this.config.publicUrl],
      bearer_methods_supported: ["header"],
      scopes_supported: ["atproto"],
    };
  }

  getAuthorizationServerMetadata(): Record<string, unknown> {
    return {
      issuer: this.config.publicUrl,
      authorization_endpoint: `${this.config.publicUrl}/oauth/authorize`,
      token_endpoint: `${this.config.publicUrl}/oauth/token`,
      pushed_authorization_request_endpoint: `${this.config.publicUrl}/oauth/par`,
      revocation_endpoint: `${this.config.publicUrl}/oauth/revoke`,
      jwks_uri: `${this.config.publicUrl}/oauth/jwks.json`,
      require_pushed_authorization_requests: true,
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      response_types_supported: ["code"],
      response_modes_supported: ["query", "fragment"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
      token_endpoint_auth_signing_alg_values_supported: ["ES256"],
      dpop_signing_alg_values_supported: ["ES256"],
      prompt_values_supported: ["login", "consent", "create"],
      scopes_supported: ["atproto"],
    };
  }

  getPublicJwks(): { keys: Array<Record<string, unknown>> } {
    return { keys: this.serviceKeys.publicJwks };
  }

  getUpstreamClientMetadata(): OAuthClientMetadata {
    const redirectUri = `${this.config.publicUrl}/oauth/upstream-callback`;
    const scope = "atproto";
    if (this.config.publicUrl.startsWith("http:")) {
      const clientId = `http://localhost?${new URLSearchParams({ scope, redirect_uri: redirectUri }).toString()}`;
      return atprotoLoopbackClientMetadata(clientId) as unknown as OAuthClientMetadata;
    }
    return {
      client_id: `${this.config.publicUrl}/oauth/client-metadata.json`,
      client_name: "OpenSocial Group Host",
      client_uri: this.config.publicUrl,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope,
      token_endpoint_auth_method: "private_key_jwt",
      token_endpoint_auth_signing_alg: "ES256",
      jwks_uri: `${this.config.publicUrl}/oauth/jwks.json`,
      dpop_bound_access_tokens: true,
      application_type: "web",
    } as unknown as OAuthClientMetadata;
  }

  // =========================================================================
  // Full DPoP Proof Verifier (`198s` Replay Table + Rolling HMAC Nonce)
  // =========================================================================

  async verifyDpopProof(params: {
    dpopHeader: string | string[] | undefined;
    method: string;
    path: string;
    isAuthServer: boolean;
    expectedAccessToken?: string;
    nowMs?: number;
  }): Promise<VerifiedDpopResult> {
    const nowMs = params.nowMs ?? Date.now();
    const freshNonce = this.cryptoBox.createDpopNonce(nowMs);

    if (Array.isArray(params.dpopHeader) || typeof params.dpopHeader !== "string" || params.dpopHeader.trim() === "") {
      throw new OAuthProtocolError(
        params.isAuthServer ? 400 : 401,
        "invalid_dpop_proof",
        "Missing or duplicate DPoP header.",
        params.isAuthServer ? undefined : 'DPoP algs="ES256", error="invalid_dpop_proof"',
      );
    }

    let verified: jose.JWTVerifyResult & { protectedHeader: jose.JWTHeaderParameters };
    try {
      verified = await jose.jwtVerify(params.dpopHeader, jose.EmbeddedJWK, {
        typ: "dpop+jwt",
        algorithms: ["ES256"],
        maxTokenAge: 10,
        clockTolerance: 180,
        currentDate: new Date(nowMs),
      });
    } catch (err) {
      throw new OAuthProtocolError(
        params.isAuthServer ? 400 : 401,
        "invalid_dpop_proof",
        err instanceof Error ? err.message : "Invalid DPoP signature.",
        params.isAuthServer ? undefined : 'DPoP algs="ES256", error="invalid_dpop_proof"',
      );
    }

    const jwk = verified.protectedHeader.jwk;
    if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof (jwk as Record<string, unknown>).d === "string") {
      throw new OAuthProtocolError(
        params.isAuthServer ? 400 : 401,
        "invalid_dpop_proof",
        "DPoP header jwk must be a public P-256 key.",
        params.isAuthServer ? undefined : 'DPoP algs="ES256", error="invalid_dpop_proof"',
      );
    }
    const jkt = await jose.calculateJwkThumbprint(jwk, "sha256");

    const { jti, htm, htu, nonce, ath } = verified.payload as {
      jti?: unknown;
      htm?: unknown;
      htu?: unknown;
      nonce?: unknown;
      ath?: unknown;
    };

    if (typeof jti !== "string" || jti.length === 0 || jti.length > 256) {
      throw new OAuthProtocolError(
        params.isAuthServer ? 400 : 401,
        "invalid_dpop_proof",
        "DPoP proof must carry a valid jti.",
        params.isAuthServer ? undefined : 'DPoP algs="ES256", error="invalid_dpop_proof"',
      );
    }
    if (htm !== params.method) {
      throw new OAuthProtocolError(
        params.isAuthServer ? 400 : 401,
        "invalid_dpop_proof",
        `DPoP htm mismatch: expected ${params.method}.`,
        params.isAuthServer ? undefined : 'DPoP algs="ES256", error="invalid_dpop_proof"',
      );
    }

    const expectedHtu = normalizeHtu(`${this.config.publicUrl}${params.path}`, this.config.allowLoopback);
    let actualHtu = "";
    try {
      if (typeof htu === "string") actualHtu = normalizeHtu(htu, this.config.allowLoopback);
    } catch {
      actualHtu = "";
    }
    if (actualHtu !== expectedHtu) {
      throw new OAuthProtocolError(
        params.isAuthServer ? 400 : 401,
        "invalid_dpop_proof",
        `DPoP htu mismatch: expected ${expectedHtu}, got ${String(htu)}.`,
        params.isAuthServer ? undefined : 'DPoP algs="ES256", error="invalid_dpop_proof"',
      );
    }

    if (params.expectedAccessToken !== undefined) {
      const expectedAth = sha256Base64Url(params.expectedAccessToken);
      if (ath !== expectedAth) {
        throw new OAuthProtocolError(
          401,
          "invalid_dpop_proof",
          "DPoP ath claim missing or does not match access token.",
          'DPoP algs="ES256", error="invalid_dpop_proof"',
        );
      }
    } else if (ath !== undefined) {
      throw new OAuthProtocolError(
        params.isAuthServer ? 400 : 401,
        "invalid_dpop_proof",
        "DPoP ath claim must be omitted when no DPoP access token is presented.",
        params.isAuthServer ? undefined : 'DPoP algs="ES256", error="invalid_dpop_proof"',
      );
    }

    if (!this.cryptoBox.verifyDpopNonce(nonce, nowMs)) {
      throw new OAuthProtocolError(
        params.isAuthServer ? 400 : 401,
        "use_dpop_nonce",
        "DPoP nonce missing or expired.",
        params.isAuthServer
          ? undefined
          : 'DPoP algs="ES256", error="use_dpop_nonce", error_description="Resource server requires nonce in DPoP proof"',
      );
    }

    const tx = this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM dpop_jti WHERE rowid IN (SELECT rowid FROM dpop_jti WHERE expires_at <= ? LIMIT 500)")
        .run(nowMs);
      const seen = this.db
        .prepare("SELECT 1 AS ok FROM dpop_jti WHERE jkt = ? AND jti = ?")
        .get(jkt, jti);
      if (seen) {
        throw new OAuthProtocolError(
          params.isAuthServer ? 400 : 401,
          "invalid_dpop_proof",
          "DPoP jti replay detected.",
          params.isAuthServer ? undefined : 'DPoP algs="ES256", error="invalid_dpop_proof"',
        );
      }
      this.db
        .prepare("INSERT INTO dpop_jti (jkt, jti, expires_at) VALUES (?, ?, ?)")
        .run(jkt, jti, nowMs + DPOP_REPLAY_TTL_MS);
    });
    tx.immediate();

    return { jkt, jti, freshNonce };
  }

  // =========================================================================
  // Downstream Client Metadata & Client Authentication (`"none"` vs `"private_key_jwt"`)
  // =========================================================================

  async resolveDownstreamClientMetadata(clientId: string): Promise<OAuthClientMetadata> {
    if (isOAuthClientIdLoopback(clientId)) {
      try {
        return atprotoLoopbackClientMetadata(clientId) as unknown as OAuthClientMetadata;
      } catch (err) {
        throw new OAuthProtocolError(
          400,
          "invalid_client",
          err instanceof Error ? err.message : "Invalid loopback client_id.",
        );
      }
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(clientId);
    } catch {
      throw new OAuthProtocolError(400, "invalid_client", "Invalid client_id URL.");
    }
    if (parsedUrl.protocol !== "https:" && !(this.config.allowLoopback && parsedUrl.protocol === "http:")) {
      throw new OAuthProtocolError(400, "invalid_client", "Discoverable client_id must use HTTPS.");
    }

    const res = await this.oauthMetaFetcher(clientId, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      throw new OAuthProtocolError(400, "invalid_client", `Failed fetching client metadata (${res.status}).`);
    }
    const meta = await readUpstreamJson<OAuthClientMetadata>(res, BOUNDED_FETCH_PROFILES.oauthMetadata.maxResponseBytes);
    if (!meta || meta.client_id !== clientId || !Array.isArray(meta.redirect_uris) || meta.redirect_uris.length === 0) {
      throw new OAuthProtocolError(400, "invalid_client", "Malformed client metadata document.");
    }
    return meta;
  }

  async verifyDownstreamClientAuth(params: {
    body: Record<string, string | undefined>;
    endpointUrl: string;
    nowMs: number;
  }): Promise<{ clientId: string; metadata: OAuthClientMetadata }> {
    const clientId = params.body.client_id;
    if (!clientId) {
      throw new OAuthProtocolError(400, "invalid_request", "client_id is required.");
    }
    const metadata = await this.resolveDownstreamClientMetadata(clientId);
    const authMethod = metadata.token_endpoint_auth_method ?? "none";

    if (authMethod === "none") {
      if (params.body.client_assertion !== undefined || params.body.client_assertion_type !== undefined) {
        throw new OAuthProtocolError(
          400,
          "invalid_request",
          "Public 'none' client must not send client_assertion parameters.",
        );
      }
      return { clientId, metadata };
    }

    if (authMethod === "private_key_jwt") {
      if (params.body.client_assertion_type !== "urn:ietf:params:oauth:client-assertion-type:jwt-bearer") {
        throw new OAuthProtocolError(401, "invalid_client", "Missing or invalid client_assertion_type.");
      }
      const assertion = params.body.client_assertion;
      if (!assertion) {
        throw new OAuthProtocolError(401, "invalid_client", "Missing client_assertion.");
      }

      let jwks = metadata.jwks as jose.JSONWebKeySet | undefined;
      if (!jwks && metadata.jwks_uri) {
        const jwksRes = await this.jwksFetcher(metadata.jwks_uri, {
          method: "GET",
          headers: { accept: "application/jwk-set+json, application/json" },
        });
        if (!jwksRes.ok) {
          throw new OAuthProtocolError(401, "invalid_client", "Failed fetching client jwks_uri.");
        }
        jwks = (await readUpstreamJson<jose.JSONWebKeySet>(jwksRes, BOUNDED_FETCH_PROFILES.didAndJwks.maxResponseBytes)) ?? undefined;
      }
      if (!jwks || !Array.isArray(jwks.keys)) {
        throw new OAuthProtocolError(401, "invalid_client", "Confidential client metadata lacks JWKS.");
      }

      let verified: jose.JWTVerifyResult;
      try {
        const keySet = jose.createLocalJWKSet(jwks);
        verified = await jose.jwtVerify(assertion, keySet, {
          algorithms: ["ES256"],
          issuer: clientId,
          subject: clientId,
          audience: [this.config.publicUrl, params.endpointUrl],
          maxTokenAge: 120,
          clockTolerance: 5,
        });
      } catch (err) {
        throw new OAuthProtocolError(
          401,
          "invalid_client",
          err instanceof Error ? err.message : "Invalid client_assertion JWT.",
        );
      }

      const jti = verified.payload.jti;
      const exp = verified.payload.exp;
      if (typeof jti !== "string" || !jti || typeof exp !== "number") {
        throw new OAuthProtocolError(401, "invalid_client", "client_assertion must include jti and exp.");
      }

      const tx = this.db.transaction(() => {
        this.db
          .prepare(
            "DELETE FROM client_assertion_jti WHERE rowid IN (SELECT rowid FROM client_assertion_jti WHERE expires_at <= ? LIMIT 200)",
          )
          .run(params.nowMs);
        const dup = this.db
          .prepare("SELECT 1 AS ok FROM client_assertion_jti WHERE client_id = ? AND jti = ?")
          .get(clientId, jti);
        if (dup) {
          throw new OAuthProtocolError(401, "invalid_client", "client_assertion jti replay detected.");
        }
        this.db
          .prepare("INSERT INTO client_assertion_jti (client_id, jti, expires_at) VALUES (?, ?, ?)")
          .run(clientId, jti, Math.max(exp * 1000, params.nowMs + 125_000));
      });
      tx.immediate();

      return { clientId, metadata };
    }

    throw new OAuthProtocolError(400, "invalid_client", `Unsupported token_endpoint_auth_method: ${authMethod}`);
  }

  private matchesRedirectUri(metadata: OAuthClientMetadata, requestedRedirectUri: string): boolean {
    if (requestedRedirectUri.includes("#")) return false;
    let reqUrl: URL;
    try {
      reqUrl = new URL(requestedRedirectUri);
    } catch {
      return false;
    }
    if (reqUrl.hash !== "") return false;
    if (metadata.redirect_uris.includes(requestedRedirectUri as never)) return true;
    // RFC 8252 loopback port wildcard when portless http://127.0.0.1/... or http://[::1]/... is registered
    if (reqUrl.protocol === "http:" && (reqUrl.hostname === "127.0.0.1" || reqUrl.hostname === "[::1]")) {
      const portless = `http://${reqUrl.hostname}${reqUrl.pathname}${reqUrl.search}`;
      return metadata.redirect_uris.includes(portless as never);
    }
    return false;
  }

  // =========================================================================
  // `/oauth/par`
  // =========================================================================

  async handlePar(params: {
    dpopHeader: string | string[] | undefined;
    body: Record<string, string | undefined>;
    nowMs?: number;
  }): Promise<{ status: number; dpopNonce: string; body: { request_uri: string; expires_in: number } }> {
    const nowMs = params.nowMs ?? Date.now();
    const dpop = await this.verifyDpopProof({
      dpopHeader: params.dpopHeader,
      method: "POST",
      path: "/oauth/par",
      isAuthServer: true,
      nowMs,
    });

    const { clientId, metadata } = await this.verifyDownstreamClientAuth({
      body: params.body,
      endpointUrl: `${this.config.publicUrl}/oauth/par`,
      nowMs,
    });

    if (params.body.response_type !== "code") {
      throw new OAuthProtocolError(400, "unsupported_response_type", "response_type must equal 'code'.");
    }
    const redirectUri = params.body.redirect_uri;
    if (!redirectUri || !this.matchesRedirectUri(metadata, redirectUri)) {
      throw new OAuthProtocolError(400, "invalid_request", "redirect_uri is missing or not registered on client.");
    }
    const responseMode = params.body.response_mode ?? "query";
    if (responseMode !== "query" && responseMode !== "fragment") {
      throw new OAuthProtocolError(400, "invalid_request", "response_mode must be 'query' or 'fragment'.");
    }

    const codeChallenge = params.body.code_challenge;
    const codeChallengeMethod = params.body.code_challenge_method;
    if (!codeChallenge || !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge) || codeChallengeMethod !== "S256") {
      throw new OAuthProtocolError(400, "invalid_request", "PKCE S256 code_challenge is required on /oauth/par.");
    }
    if (params.body.code_verifier !== undefined) {
      throw new OAuthProtocolError(400, "invalid_request", "code_verifier must not be sent to /oauth/par.");
    }

    const scopeStr = (params.body.scope ?? "atproto").trim();
    const scopeTokens = scopeStr.split(/\s+/).filter(Boolean);
    if (!scopeTokens.includes("atproto")) {
      throw new OAuthProtocolError(400, "invalid_scope", "ATProto OAuth scope must include 'atproto'.");
    }
    try {
      expandGroupScopes(scopeTokens);
    } catch (err) {
      throw new OAuthProtocolError(
        400,
        "invalid_scope",
        err instanceof Error ? err.message : "Invalid scope.",
      );
    }

    const prompt = params.body.prompt;
    if (prompt !== undefined && prompt !== "login" && prompt !== "consent" && prompt !== "create") {
      throw new OAuthProtocolError(400, "invalid_request", `Unsupported prompt '${prompt}'.`);
    }

    const loginHint = params.body.login_hint?.trim();
    let targetGroupDid: string | null = null;
    if (prompt !== "create" && loginHint) {
      const resolved = this.resolveLocalGroupIdentifierOrNull(loginHint);
      if (!resolved) {
        throw new OAuthProtocolError(400, "invalid_request", `Unknown group login_hint '${loginHint}'.`);
      }
      targetGroupDid = resolved.did;
    }

    const requestUri = `urn:ietf:params:oauth:request_uri:${randomBytes(24).toString("base64url")}`;
    const creationKey = params.body.creation_key?.trim() || null;

    this.db
      .prepare(
        `INSERT INTO oauth_par (
           request_uri, group_did, client_id, redirect_uri, response_mode, scope, state,
           code_challenge, dpop_jkt, prompt, login_hint, creation_key,
           authenticated_user_did, authenticated_at, login_step_up_at, expires_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        requestUri,
        targetGroupDid,
        clientId,
        redirectUri,
        responseMode,
        scopeTokens.join(" "),
        params.body.state ?? null,
        codeChallenge,
        dpop.jkt,
        prompt ?? null,
        loginHint ?? null,
        creationKey,
        nowMs + PAR_TTL_MS,
        nowMs,
      );

    return {
      status: 201,
      dpopNonce: dpop.freshNonce,
      body: {
        request_uri: requestUri,
        expires_in: Math.floor(PAR_TTL_MS / 1000),
      },
    };
  }

  private resolveLocalGroupIdentifierOrNull(identifier: string): { did: string; handle: string; activated: number; takendown: number } | null {
    const row = isDid(identifier)
      ? (this.db
          .prepare("SELECT did, handle, activated, takendown FROM group_account WHERE did = ?")
          .get(identifier) as { did: string; handle: string; activated: number; takendown: number } | undefined)
      : (this.db
          .prepare("SELECT did, handle, activated, takendown FROM group_account WHERE handle = ?")
          .get(identifier.toLowerCase()) as { did: string; handle: string; activated: number; takendown: number } | undefined);
    return row ?? null;
  }

  // =========================================================================
  // Upstream `NodeOAuthClient` (Personal-PDS Identity Proof)
  // =========================================================================

  private async withUpstreamLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.upstreamLocks.get(name) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = prev.then(() => gate);
    this.upstreamLocks.set(name, chained);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.upstreamLocks.get(name) === chained) {
        this.upstreamLocks.delete(name);
      }
    }
  }

  private async createUpstreamClient(options: {
    sessionMap: Map<string, NodeSavedSession>;
    stateMetaHook?: {
      parRequestUri: string;
      groupDid: string | null;
      expectedUserDid: string | null;
      appState: string;
      createParams?: CreationFormParams;
      nowMs: number;
    };
  }): Promise<{ client: NodeOAuthClient; getCapturedProtocolState: () => string | null }> {
    let capturedProtocolState: string | null = null;
    const clientMetadata = this.getUpstreamClientMetadata();

    let keyset: JoseKey[] | undefined;
    if (this.config.publicUrl.startsWith("https:")) {
      if (this.config.servicePrivateJwks && this.config.servicePrivateJwks.length > 0) {
        keyset = await Promise.all(
          this.config.servicePrivateJwks.map((k) =>
            JoseKey.fromImportable(
              { kty: "EC", crv: "P-256", kid: k.kid, x: k.x, y: k.y, d: k.d, use: "sig" },
              k.kid,
            ),
          ),
        );
      } else {
        const pubJwk = this.serviceKeys.publicJwks[0] as { x: string; y: string; kid: string };
        const privRaw = await this.serviceKeys.activeKeypair.export();
        const privBytes = typeof privRaw === "string" ? Buffer.from(privRaw, "hex") : Buffer.from(privRaw);
        const dB64 = privBytes.toString("base64url");
        keyset = [
          await JoseKey.fromImportable(
            { kty: "EC", crv: "P-256", kid: pubJwk.kid, x: pubJwk.x, y: pubJwk.y, d: dB64, use: "sig" },
            pubJwk.kid,
          ),
        ];
      }
    }

    const upstreamFetch =
      this.config.fetchImpl ??
      boundedSafeFetch(() => this.config.allowLoopback, {
        deadlineMs: 10_000,
        maxResponseBytes: 512 * 1024,
        allowedContentTypes: ["application/json", "application/did+ld+json", "application/jwk-set+json", "text/plain"],
      });

    const client = new NodeOAuthClient({
      clientMetadata,
      ...(keyset ? { keyset } : {}),
      fetch: upstreamFetch,
      requestLock: <T>(name: string, fn: () => PromiseLike<T> | T) =>
        this.withUpstreamLock(name, async () => await fn()),
      allowHttp: this.config.allowLoopback,
      plcDirectoryUrl: this.config.plcUrl,
      stateStore: {
        set: async (stateKey: string, savedState: NodeSavedState) => {
          capturedProtocolState = stateKey;
          const hook = options.stateMetaHook;
          if (!hook) return;
          const envelope = JSON.stringify({
            savedState,
            createParams: hook.createParams ?? null,
          });
          const enc = this.cryptoBox.encryptColumn("upstream_oauth_state", stateKey, "payload_enc", envelope);
          this.db
            .prepare(
              `INSERT INTO upstream_oauth_state (
                 state, group_did, par_request_uri, expected_user_did, app_state, payload_enc, expires_at, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              stateKey,
              hook.groupDid,
              hook.parRequestUri,
              hook.expectedUserDid,
              hook.appState,
              enc,
              hook.nowMs + 10 * MINUTE_MS,
              hook.nowMs,
            );
        },
        get: async (stateKey: string) => {
          // Consume-on-read atomically via DELETE ... RETURNING!
          const row = this.db
            .prepare("DELETE FROM upstream_oauth_state WHERE state = ? RETURNING payload_enc, expires_at")
            .get(stateKey) as { payload_enc: string; expires_at: number } | undefined;
          if (!row || row.expires_at <= Date.now()) return undefined;
          const decoded = JSON.parse(
            this.cryptoBox.decryptColumnUtf8("upstream_oauth_state", stateKey, "payload_enc", row.payload_enc),
          ) as { savedState: NodeSavedState };
          return decoded.savedState;
        },
        del: async (stateKey: string) => {
          this.db.prepare("DELETE FROM upstream_oauth_state WHERE state = ?").run(stateKey);
        },
      },
      sessionStore: {
        get: async (did: string) => options.sessionMap.get(did),
        set: async (did: string, session: NodeSavedSession) => {
          options.sessionMap.set(did, session);
        },
        del: async (did: string) => {
          options.sessionMap.delete(did);
        },
      },
      ...this.upstreamCaches,
    });

    return {
      client,
      getCapturedProtocolState: () => capturedProtocolState,
    };
  }

  // =========================================================================
  // `/oauth/authorize` (`GET` & `POST`)
  // =========================================================================

  private loadValidParRow(clientId: string | undefined, requestUri: string | undefined, nowMs: number) {
    if (!clientId || !requestUri) {
      throw new OAuthProtocolError(400, "invalid_request", "client_id and request_uri are required.");
    }
    const par = this.db
      .prepare("SELECT * FROM oauth_par WHERE request_uri = ?")
      .get(requestUri) as
      | {
          request_uri: string;
          group_did: string | null;
          client_id: string;
          redirect_uri: string;
          response_mode: "query" | "fragment";
          scope: string;
          state: string | null;
          code_challenge: string;
          dpop_jkt: string;
          prompt: string | null;
          login_hint: string | null;
          creation_key: string | null;
          authenticated_user_did: string | null;
          authenticated_at: number | null;
          expires_at: number;
        }
      | undefined;

    if (!par || par.expires_at <= nowMs) {
      throw new OAuthProtocolError(400, "invalid_request", "PAR request_uri is unknown or expired.");
    }
    if (par.client_id !== clientId) {
      throw new OAuthProtocolError(400, "invalid_request", "client_id does not match PAR request_uri.");
    }
    return par;
  }

  formatDownstreamRedirect(params: {
    redirectUri: string;
    responseMode: "query" | "fragment";
    state: string | null;
    code?: string;
    error?: string;
    errorDescription?: string;
  }): string {
    const outParams = new URLSearchParams();
    if (params.code !== undefined) outParams.set("code", params.code);
    if (params.error !== undefined) outParams.set("error", params.error);
    if (params.errorDescription !== undefined) outParams.set("error_description", params.errorDescription);
    if (params.state !== null && params.state !== "") outParams.set("state", params.state);
    outParams.set("iss", this.config.publicUrl);

    const target = new URL(params.redirectUri);
    if (params.responseMode === "fragment") {
      target.hash = outParams.toString();
    } else {
      for (const [k, v] of outParams.entries()) {
        target.searchParams.set(k, v);
      }
    }
    return target.toString();
  }

  async handleAuthorizeGet(params: {
    query: Record<string, string | undefined>;
    nowMs?: number;
  }): Promise<
    | { kind: "html"; status: number; html: string }
    | { kind: "redirect"; location: string; setCookie: string }
  > {
    const nowMs = params.nowMs ?? Date.now();
    const par = this.loadValidParRow(params.query.client_id, params.query.request_uri, nowMs);

    const actorHint = params.query.actor?.trim();
    const isCreate = par.prompt === "create";

    // On existing-group auth where both target group (`par.group_did` or `query.group`) and `actor` hint are supplied,
    // we can start the upstream personal-PDS sign-in immediately (consent still runs on `/oauth/confirm-action`!).
    if (!isCreate && actorHint && (par.group_did || params.query.group)) {
      let groupDid = par.group_did;
      if (!groupDid && params.query.group) {
        const resolved = this.resolveLocalGroupIdentifierOrNull(params.query.group);
        if (!resolved) {
          throw new OAuthProtocolError(400, "invalid_request", `Unknown group '${params.query.group}'.`);
        }
        groupDid = resolved.did;
        this.db.prepare("UPDATE oauth_par SET group_did = ? WHERE request_uri = ?").run(groupDid, par.request_uri);
      }
      return this.beginUpstreamPersonalLogin({
        parRequestUri: par.request_uri,
        prompt: par.prompt,
        groupDid: groupDid!,
        userInput: actorHint,
        nowMs,
      });
    }

    // Otherwise (including ALL `prompt=create` flows, displaying client_id + requested scopes + creation parameters!),
    // render the CSP-locked CSRF-protected `/oauth/authorize` form!
    const csrf = this.cryptoBox.signCookiePayload(
      "authorize-csrf",
      JSON.stringify({ requestUri: par.request_uri, expMs: nowMs + 10 * MINUTE_MS }),
    );
    const defaultName = params.query.name?.trim() ?? "";
    const defaultHandle =
      params.query.handle?.trim() ??
      (defaultName ? `${slugifyHandleBase(defaultName)}-${randomBytes(3).toString("hex")}.${this.config.handleDomain}` : "");
    const defaultJoinPolicy =
      params.query.join_policy === "open" || params.query.join_policy === "approval"
        ? params.query.join_policy
        : "invite";
    const defaultPublicMeta = params.query.public_meta !== "false";
    const defaultCreationKey = params.query.creation_key?.trim() || par.creation_key || randomUUID();

    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${isCreate ? "Create Atmosphere Group" : "Authorize Group Access"}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 520px; margin: 40px auto; padding: 0 20px; color: #111; }
    label { display: block; margin-top: 12px; font-weight: 600; font-size: 14px; }
    input[type="text"], select { width: 100%; box-sizing: border-box; padding: 8px 10px; margin-top: 4px; border: 1px solid #ccc; border-radius: 6px; }
    .scopes { background: #f6f8fa; padding: 10px; border-radius: 6px; font-family: monospace; font-size: 12px; word-break: break-all; margin-top: 12px; }
    .actions { display: flex; gap: 10px; margin-top: 20px; }
    button { padding: 10px 16px; border-radius: 6px; border: none; font-weight: 600; cursor: pointer; }
    .primary { background: #0f62fe; color: #fff; }
    .secondary { background: #e0e0e0; color: #111; }
  </style>
</head>
<body>
  <h1>${isCreate ? "Create Atmosphere Group" : "Sign in to Group"}</h1>
  <p>Client: <code>${escapeHtml(par.client_id)}</code></p>
  <div class="scopes">Requested scopes: ${escapeHtml(par.scope)}</div>
  <form method="POST" action="/oauth/authorize" data-testid="group-oauth-authorize-form">
    <input type="hidden" name="client_id" value="${escapeHtml(par.client_id)}" />
    <input type="hidden" name="request_uri" value="${escapeHtml(par.request_uri)}" />
    <input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}" />
    <label>Your Personal Handle or DID
      <input type="text" name="actor" required value="${escapeHtml(actorHint ?? "")}" data-testid="group-oauth-actor-input" />
    </label>
    ${
      isCreate
        ? `
    <input type="hidden" name="creation_key" value="${escapeHtml(defaultCreationKey)}" />
    <label>Group Display Name
      <input type="text" name="display_name" required maxlength="64" value="${escapeHtml(defaultName)}" data-testid="group-oauth-display-name-input" />
    </label>
    <label>Group Handle (.${escapeHtml(this.config.handleDomain)})
      <input type="text" name="handle" value="${escapeHtml(defaultHandle)}" data-testid="group-oauth-handle-input" />
    </label>
    <label>Join Policy
      <select name="join_policy" data-testid="group-oauth-join-policy-select">
        <option value="invite"${defaultJoinPolicy === "invite" ? " selected" : ""}>Invite Only</option>
        <option value="approval"${defaultJoinPolicy === "approval" ? " selected" : ""}>Approval Required</option>
        <option value="open"${defaultJoinPolicy === "open" ? " selected" : ""}>Open</option>
      </select>
    </label>
    <label>
      <input type="checkbox" name="public_meta" value="true"${defaultPublicMeta ? " checked" : ""} data-testid="group-oauth-public-meta-checkbox" />
      Publish public group metadata (<code>org.atgrp.declaration</code> &amp; <code>publicRead: true</code> on <code>meta/self</code>)
    </label>
    `
        : !par.group_did
          ? `
    <label>Target Group Handle or DID
      <input type="text" name="group" required value="${escapeHtml(params.query.group ?? "")}" data-testid="group-oauth-target-group-input" />
    </label>
    `
          : ""
    }
    <div class="actions">
      <button type="submit" name="decision" value="approve" class="primary" data-testid="group-oauth-approve-button">
        ${isCreate ? "Create Group & Approve" : "Continue"}
      </button>
      <button type="submit" name="decision" value="deny" class="secondary" formnovalidate data-testid="group-oauth-deny-button">
        Cancel
      </button>
    </div>
  </form>
</body>
</html>`;

    return { kind: "html", status: 200, html };
  }

  async handleAuthorizePost(params: {
    body: Record<string, string | undefined>;
    nowMs?: number;
  }): Promise<{ location: string; setCookie?: string }> {
    const nowMs = params.nowMs ?? Date.now();
    const par = this.loadValidParRow(params.body.client_id, params.body.request_uri, nowMs);

    const csrfPayload = this.cryptoBox.verifyCookiePayload<{ requestUri: string; expMs: number }>(
      "authorize-csrf",
      params.body.csrf_token,
    );
    if (!csrfPayload || csrfPayload.requestUri !== par.request_uri || csrfPayload.expMs <= nowMs) {
      throw new OAuthProtocolError(400, "invalid_request", "Invalid or expired CSRF token.");
    }

    if (params.body.decision === "deny") {
      this.db.prepare("DELETE FROM oauth_par WHERE request_uri = ?").run(par.request_uri);
      return {
        location: this.formatDownstreamRedirect({
          redirectUri: par.redirect_uri,
          responseMode: par.response_mode,
          state: par.state,
          error: "access_denied",
          errorDescription: "The user cancelled authorization.",
        }),
      };
    }

    const userInput = params.body.actor?.trim();
    if (!userInput) {
      throw new OAuthProtocolError(400, "invalid_request", "Personal handle or DID is required.");
    }

    if (par.prompt === "create") {
      const displayName = (params.body.display_name ?? "").trim();
      if (!displayName || countGraphemesLocal(displayName) > 64 || Buffer.byteLength(displayName, "utf8") > 640) {
        throw new OAuthProtocolError(400, "invalid_request", "Group displayName must be 1..64 graphemes.");
      }
      const rawHandle =
        params.body.handle?.trim() ||
        `${slugifyHandleBase(displayName)}-${randomBytes(3).toString("hex")}.${this.config.handleDomain}`;
      const normalizedHandle = normalizeAndValidateGroupHandle(rawHandle, this.config.handleDomain);
      const joinPolicy =
        params.body.join_policy === "open" || params.body.join_policy === "approval"
          ? params.body.join_policy
          : "invite";
      const publicMeta = params.body.public_meta === "true" || params.body.public_meta === "on";
      const creationKey = params.body.creation_key?.trim() || par.creation_key || randomUUID();

      this.db
        .prepare("UPDATE oauth_par SET creation_key = ? WHERE request_uri = ?")
        .run(creationKey, par.request_uri);

      const started = await this.beginUpstreamPersonalLogin({
        parRequestUri: par.request_uri,
        prompt: par.prompt,
        groupDid: null,
        userInput,
        createParams: {
          displayName,
          handle: normalizedHandle,
          joinPolicy,
          publicMeta,
          creationKey,
          creatorApproved: true,
          reviewedScope: par.scope,
        },
        nowMs,
      });
      return { location: started.location, setCookie: started.setCookie };
    }

    let groupDid = par.group_did;
    if (!groupDid) {
      const targetInput = params.body.group?.trim();
      if (!targetInput) {
        throw new OAuthProtocolError(400, "invalid_request", "Target group is required.");
      }
      const resolved = this.resolveLocalGroupIdentifierOrNull(targetInput);
      if (!resolved) {
        throw new OAuthProtocolError(400, "invalid_request", `Unknown group '${targetInput}'.`);
      }
      groupDid = resolved.did;
      this.db.prepare("UPDATE oauth_par SET group_did = ? WHERE request_uri = ?").run(groupDid, par.request_uri);
    }

    const started = await this.beginUpstreamPersonalLogin({
      parRequestUri: par.request_uri,
      prompt: par.prompt,
      groupDid,
      userInput,
      nowMs,
    });
    return { location: started.location, setCookie: started.setCookie };
  }

  private async beginUpstreamPersonalLogin(params: {
    parRequestUri: string;
    prompt: string | null;
    groupDid: string | null;
    userInput: string;
    createParams?: CreationFormParams;
    nowMs: number;
  }): Promise<{ kind: "redirect"; location: string; setCookie: string }> {
    const appState = randomBytes(32).toString("base64url");
    const expectedUserDid = isDid(params.userInput) ? params.userInput : null;
    const dummyMap = new Map<string, NodeSavedSession>();

    const { client, getCapturedProtocolState } = await this.createUpstreamClient({
      sessionMap: dummyMap,
      stateMetaHook: {
        parRequestUri: params.parRequestUri,
        groupDid: params.groupDid,
        expectedUserDid,
        appState,
        createParams: params.createParams,
        nowMs: params.nowMs,
      },
    });

    let authUrl: URL;
    try {
      authUrl = await client.authorize(params.userInput, {
        scope: "atproto",
        state: appState,
        ...(params.prompt === "login" ? { prompt: "login" } : {}),
      });
    } catch (err) {
      throw new OAuthProtocolError(
        400,
        "invalid_request",
        err instanceof Error ? err.message : "Failed to resolve personal identity.",
      );
    }

    const protocolState = getCapturedProtocolState() ?? authUrl.searchParams.get("state");
    if (!protocolState) {
      throw new OAuthProtocolError(500, "server_error", "Upstream OAuth client did not emit state.");
    }

    const cookieName = `gh_oauth_${sha256HexBytes(protocolState)}`;
    const cookieVal = this.cryptoBox.signCookiePayload(
      `upstream:${protocolState}`,
      JSON.stringify({ appState, expMs: params.nowMs + 10 * MINUTE_MS }),
    );
    const setCookie = formatSetCookie({
      name: cookieName,
      value: cookieVal,
      path: "/oauth/upstream-callback",
      maxAgeSec: 600,
      secure: this.config.publicUrl.startsWith("https:"),
    });

    return { kind: "redirect", location: authUrl.toString(), setCookie };
  }

  // =========================================================================
  // `GET /oauth/upstream-callback` (Isolated Per-Callback `staged` Map + `signOut()`)
  // =========================================================================

  async handleUpstreamCallback(params: {
    queryParams: URLSearchParams;
    cookieHeader: string | undefined;
    nowMs?: number;
  }): Promise<{ location: string; setCookies: string[] }> {
    const nowMs = params.nowMs ?? Date.now();
    const state = params.queryParams.get("state") ?? "";
    if (!state) {
      throw new OAuthProtocolError(400, "invalid_request", "Missing upstream OAuth state parameter.");
    }

    const cookieName = `gh_oauth_${sha256HexBytes(state)}`;
    const cookies = parseCookies(params.cookieHeader);
    const clearFlowCookie = formatSetCookie({
      name: cookieName,
      value: "",
      path: "/oauth/upstream-callback",
      maxAgeSec: 0,
      secure: this.config.publicUrl.startsWith("https:"),
    });

    const verifiedCookie = this.cryptoBox.verifyCookiePayload<{ appState: string; expMs: number }>(
      `upstream:${state}`,
      cookies[cookieName],
    );
    if (!verifiedCookie || verifiedCookie.expMs <= nowMs) {
      throw new OAuthProtocolError(400, "invalid_request", "Missing, mismatched, or expired browser login-CSRF cookie.");
    }

    // Peek non-secret columns + encrypted createParams BEFORE NodeOAuthClient's consumeOnRead `get()` deletes the row!
    const preStateRow = this.db
      .prepare(
        "SELECT par_request_uri, group_did, expected_user_did, app_state, payload_enc, expires_at FROM upstream_oauth_state WHERE state = ?",
      )
      .get(state) as
      | {
          par_request_uri: string;
          group_did: string | null;
          expected_user_did: string | null;
          app_state: string;
          payload_enc: string;
          expires_at: number;
        }
      | undefined;

    if (!preStateRow || preStateRow.expires_at <= nowMs || preStateRow.app_state !== verifiedCookie.appState) {
      this.db.prepare("DELETE FROM upstream_oauth_state WHERE state = ?").run(state);
      throw new OAuthProtocolError(400, "invalid_request", "Upstream OAuth state is unknown, replayed, or expired.");
    }

    const decodedEnvelope = JSON.parse(
      this.cryptoBox.decryptColumnUtf8("upstream_oauth_state", state, "payload_enc", preStateRow.payload_enc),
    ) as { createParams: CreationFormParams | null };

    // Isolated throwaway in-memory session store (`staged`) per callback + mandatory `signOut()` in `finally`!
    const staged = new Map<string, NodeSavedSession>();
    const { client } = await this.createUpstreamClient({ sessionMap: staged });

    let authorizingUserDid: string;
    let callbackSession: { did: string; signOut(): Promise<void> } | null = null;
    try {
      const cbResult = await client.callback(params.queryParams);
      callbackSession = cbResult.session;
      if (cbResult.state !== verifiedCookie.appState) {
        throw new OAuthProtocolError(400, "invalid_request", "Upstream OAuth appState mismatch.");
      }
      authorizingUserDid = cbResult.session.did;
      if (preStateRow.expected_user_did !== null && authorizingUserDid !== preStateRow.expected_user_did) {
        throw new OAuthProtocolError(403, "access_denied", "Signed-in personal account did not match expected actor.");
      }
    } finally {
      if (callbackSession) {
        await callbackSession.signOut().catch(() => undefined);
      }
      staged.clear();
    }

    const par = this.db
      .prepare("SELECT * FROM oauth_par WHERE request_uri = ?")
      .get(preStateRow.par_request_uri) as
      | {
          request_uri: string;
          group_did: string | null;
          client_id: string;
          redirect_uri: string;
          response_mode: "query" | "fragment";
          scope: string;
          state: string | null;
          code_challenge: string;
          dpop_jkt: string;
          prompt: string | null;
          creation_key: string | null;
          expires_at: number;
        }
      | undefined;

    if (!par || par.expires_at <= nowMs) {
      throw new OAuthProtocolError(400, "invalid_request", "Downstream PAR expired during personal PDS sign-in.");
    }

    const loginStepUpAt = par.prompt === "login" ? nowMs : null;
    this.db
      .prepare(
        "UPDATE oauth_par SET authenticated_user_did = ?, authenticated_at = ?, login_step_up_at = ? WHERE request_uri = ?",
      )
      .run(authorizingUserDid, nowMs, loginStepUpAt, par.request_uri);

    // Branch 1: `prompt=create`!
    if (par.prompt === "create" && decodedEnvelope.createParams) {
      const createParams = decodedEnvelope.createParams;
      const rowKey = `${authorizingUserDid}:${par.client_id}:${createParams.creationKey}`;
      return this.locks.withGroupRepoLock(`create:${rowKey}`, async () => {
        // Check if `(authorizingUserDid, par.client_id, createParams.creationKey)` already completed / issued a code!
        const existingJournal = this.db
          .prepare(
            "SELECT group_did, status, auth_code, redirect_url, par_state, par_response_mode, code_expires_at FROM group_creation_journal WHERE initiator_did = ? AND client_id = ? AND creation_key = ?",
          )
          .get(authorizingUserDid, par.client_id, createParams.creationKey) as
          | {
              group_did: string;
              status: "pending_plc" | "plc_published" | "code_issued" | "completed" | "compensated";
              auth_code: string | null;
              redirect_url: string | null;
              par_state: string | null;
              par_response_mode: string | null;
              code_expires_at: number | null;
            }
          | undefined;

        if (existingJournal?.status === "code_issued") {
          let unconsumed:
            | { code_challenge: string; dpop_jkt: string; redirect_uri: string }
            | undefined;
          if (
            existingJournal.auth_code &&
            existingJournal.code_expires_at &&
            nowMs < existingJournal.code_expires_at
          ) {
            const codeHash = sha256HexBytes(existingJournal.auth_code);
            unconsumed = this.db
              .prepare(
                `SELECT code_challenge, dpop_jkt, redirect_uri
                 FROM oauth_code
                 WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
              )
              .get(codeHash, nowMs) as
              | { code_challenge: string; dpop_jkt: string; redirect_uri: string }
              | undefined;
            if (
              unconsumed &&
              existingJournal.redirect_url &&
              unconsumed.code_challenge === par.code_challenge &&
              unconsumed.dpop_jkt === par.dpop_jkt &&
              unconsumed.redirect_uri === par.redirect_uri &&
              existingJournal.par_state === (par.state ?? null) &&
              existingJournal.par_response_mode === par.response_mode
            ) {
              this.db.prepare("DELETE FROM oauth_par WHERE request_uri = ?").run(par.request_uri);
              return { location: existingJournal.redirect_url, setCookies: [clearFlowCookie] };
            }
          }
          // Only mark `completed` if the original `oauth_code` expired or was already consumed; never clobber an in-flight sibling PAR's unconsumed code!
          if (!unconsumed) {
            this.db
              .prepare(
                "UPDATE group_creation_journal SET status = 'completed', auth_code = NULL, updated_at = ? WHERE initiator_did = ? AND client_id = ? AND creation_key = ? AND status = 'code_issued'",
              )
              .run(nowMs, authorizingUserDid, par.client_id, createParams.creationKey);
          }
          this.db
            .prepare("UPDATE oauth_par SET group_did = ?, prompt = 'consent' WHERE request_uri = ?")
            .run(existingJournal.group_did, par.request_uri);
          return this.redirectToConfirmAction({
            parRequestUri: par.request_uri,
            userDid: authorizingUserDid,
            clearFlowCookie,
            nowMs,
          });
        }

        if (existingJournal?.status === "completed") {
          // Pivot cleanly into existing-group OAuth reauthorization via `/oauth/confirm-action`!
          this.db
            .prepare("UPDATE oauth_par SET group_did = ?, prompt = 'consent' WHERE request_uri = ?")
            .run(existingJournal.group_did, par.request_uri);
          return this.redirectToConfirmAction({
            parRequestUri: par.request_uri,
            userDid: authorizingUserDid,
            clearFlowCookie,
            nowMs,
          });
        }

        if (createParams.creatorApproved) {
          const redirectUrl = await this.executeCreateGroupJournalLocked({
            initiatorDid: authorizingUserDid,
            par,
            createParams,
            nowMs,
          });
          return { location: redirectUrl, setCookies: [clearFlowCookie] };
        }

        return this.redirectToConfirmAction({
          parRequestUri: par.request_uri,
          userDid: authorizingUserDid,
          createParams,
          clearFlowCookie,
          nowMs,
        });
      });
    }

    // Branch 2: Existing-group authorization!
    const groupDid = preStateRow.group_did ?? par.group_did;
    if (!groupDid) {
      throw new OAuthProtocolError(400, "invalid_request", "Missing target group DID.");
    }

    // Check whether confidential `private_key_jwt` client already has an active session covering the narrowed live scope (and `prompt !== "consent"`)
    const clientMeta = await this.resolveDownstreamClientMetadata(par.client_id);
    const isPublicClient = (clientMeta.token_endpoint_auth_method ?? "none") === "none";
    if (!isPublicClient && par.prompt !== "consent") {
      const priorSessions = this.db
        .prepare(
          `SELECT approved_scope FROM oauth_session
           WHERE group_did = ? AND authorizing_user_did = ? AND client_id = ? AND expires_at > ?`,
        )
        .all(groupDid, authorizingUserDid, par.client_id, nowMs) as Array<{ approved_scope: string }>;

      if (priorSessions.length > 0) {
        const acct = this.db
          .prepare("SELECT activated FROM group_account WHERE did = ?")
          .get(groupDid) as { activated: number } | undefined;
        const liveState = loadLiveGovernanceState(this.db, groupDid);
        const recRow = this.db
          .prepare("SELECT * FROM group_recovery_admin WHERE group_did = ?")
          .get(groupDid) as RecoveryAdminRow | undefined;
        const effState = effectiveStateForSession(
          liveState,
          { sessionKind: acct?.activated === 0 ? "recovery" : "group", authorizingUserDid },
          recRow,
        );
        const livePerms = effectiveMemberPermissions(effState, groupDid, authorizingUserDid);
        let narrowedLivePerms: ScopePermissions | null = null;
        try {
          narrowedLivePerms = resolveAuthorizedGroupScope(
            par.scope.split(/\s+/).filter(Boolean),
            livePerms,
            groupDid,
          ).permissions;
        } catch {
          narrowedLivePerms = null;
        }

        const matchedPrior = narrowedLivePerms
          ? priorSessions.find((s) => {
              try {
                const priorPerms = expandGroupScopes(s.approved_scope.split(/\s+/).filter(Boolean), groupDid);
                return isPermissionSubset(narrowedLivePerms!, priorPerms, groupDid);
              } catch {
                return false;
              }
            })
          : undefined;

        if (matchedPrior) {
          const redirectUrl = this.issueDownstreamAuthCodeSync({
            groupDid,
            authorizingUserDid,
            authenticatedAt: nowMs,
            loginStepUpAt,
            par,
            priorApprovedScope: matchedPrior.approved_scope,
            nowMs,
          });
          return { location: redirectUrl, setCookies: [clearFlowCookie] };
        }
      }
    }

    return this.redirectToConfirmAction({
      parRequestUri: par.request_uri,
      userDid: authorizingUserDid,
      clearFlowCookie,
      nowMs,
    });
  }

  private consentCookieName(consentId: string): string {
    return `gh_consent_${sha256HexBytes(consentId).slice(0, 16)}`;
  }

  private redirectToConfirmAction(params: {
    parRequestUri: string;
    userDid: string;
    createParams?: CreationFormParams;
    clearFlowCookie: string;
    nowMs: number;
  }): { location: string; setCookies: string[] } {
    const consentId = randomUUID();
    const csrf = `${consentId}.${randomBytes(24).toString("base64url")}`;
    const payload: ConsentCookiePayload = {
      requestUri: params.parRequestUri,
      userDid: params.userDid,
      csrf,
      ...(params.createParams ? { createParams: params.createParams } : {}),
      expMs: params.nowMs + 5 * MINUTE_MS,
    };
    const consentCookie = formatSetCookie({
      name: this.consentCookieName(consentId),
      value: this.cryptoBox.signCookiePayload(`consent-action:${consentId}`, JSON.stringify(payload)),
      path: "/oauth/confirm-action",
      maxAgeSec: 300,
      secure: this.config.publicUrl.startsWith("https:"),
    });
    return {
      location: `${this.config.publicUrl}/oauth/confirm-action?consent=${encodeURIComponent(consentId)}`,
      setCookies: [params.clearFlowCookie, consentCookie],
    };
  }

  // =========================================================================
  // `GET` & `POST /oauth/confirm-action` (Downstream Consent Screen)
  // =========================================================================

  handleConfirmActionGet(params: {
    cookieHeader: string | undefined;
    consentId?: string;
    nowMs?: number;
  }): { status: number; html: string } {
    const nowMs = params.nowMs ?? Date.now();
    const consentId = params.consentId;
    if (!consentId || !/^[A-Za-z0-9_-]{1,128}$/.test(consentId)) {
      throw new OAuthProtocolError(400, "invalid_request", "Consent session identifier missing or invalid.");
    }
    const cookies = parseCookies(params.cookieHeader);
    const cookieVal = cookies[this.consentCookieName(consentId)];
    const consent = this.cryptoBox.verifyCookiePayload<ConsentCookiePayload>(`consent-action:${consentId}`, cookieVal);
    if (!consent || consent.expMs <= nowMs) {
      throw new OAuthProtocolError(400, "invalid_request", "Consent session missing or expired.");
    }

    const par = this.db
      .prepare("SELECT * FROM oauth_par WHERE request_uri = ?")
      .get(consent.requestUri) as
      | {
          request_uri: string;
          group_did: string | null;
          client_id: string;
          scope: string;
          expires_at: number;
        }
      | undefined;
    if (!par || par.expires_at <= nowMs || !par.group_did) {
      throw new OAuthProtocolError(400, "invalid_request", "PAR expired or missing group target.");
    }

    const acct = this.db
      .prepare("SELECT handle, activated FROM group_account WHERE did = ?")
      .get(par.group_did) as { handle: string; activated: number } | undefined;
    if (!acct) {
      throw new OAuthProtocolError(400, "invalid_request", "Target group not found.");
    }

    const aboutRow = this.db
      .prepare(
        "SELECT value FROM space_record WHERE space_uri = ? AND repo_did = ? AND collection = ? AND rkey = 'self'",
      )
      .get(groupMetaUri(par.group_did), par.group_did, ATGRP_COLLECTION.about) as { value: string } | undefined;
    const displayName = aboutRow
      ? ((JSON.parse(aboutRow.value) as { displayName?: string }).displayName ?? acct.handle)
      : acct.handle;

    const liveState = loadLiveGovernanceState(this.db, par.group_did);
    const recRow = this.db
      .prepare("SELECT * FROM group_recovery_admin WHERE group_did = ?")
      .get(par.group_did) as RecoveryAdminRow | undefined;
    const effState = effectiveStateForSession(
      liveState,
      { sessionKind: acct.activated === 0 ? "recovery" : "group", authorizingUserDid: consent.userDid },
      recRow,
    );
    const userRoles = effState.memberships.get(consent.userDid)?.roles ?? [];
    const livePerms = effectiveMemberPermissions(effState, par.group_did, consent.userDid);

    let reviewedScope = par.scope;
    try {
      reviewedScope = resolveAuthorizedGroupScope(
        par.scope.split(/\s+/).filter(Boolean),
        livePerms,
        par.group_did,
      ).scope;
    } catch (err) {
      if (err instanceof UnauthorizedScopeError) {
        throw new OAuthProtocolError(403, "access_denied", err.message);
      }
      if (err instanceof InvalidScopeError) {
        throw new OAuthProtocolError(400, "invalid_scope", err.message);
      }
      throw err;
    }

    const snapshotId = randomUUID();
    const snapshotExpiresAt = Math.min(par.expires_at, nowMs + 5 * MINUTE_MS);
    this.db
      .prepare(
        `INSERT INTO oauth_consent_snapshot (
           snapshot_id, par_request_uri, group_did, authorizing_user_did, reviewed_scope, created_at, expires_at, consumed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(snapshotId, par.request_uri, par.group_did, consent.userDid, reviewedScope, nowMs, snapshotExpiresAt);
    const signedSnapshotRef = this.cryptoBox.signCookiePayload(
      "consent-snapshot",
      JSON.stringify({ snapshotId, requestUri: par.request_uri }),
    );

    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Authorize Group Access</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 520px; margin: 40px auto; padding: 0 20px; color: #111; }
    .card { border: 1px solid #ddd; border-radius: 8px; padding: 16px; margin: 16px 0; }
    .scopes { background: #f6f8fa; padding: 10px; border-radius: 6px; font-family: monospace; font-size: 12px; word-break: break-all; }
    .actions { display: flex; gap: 10px; margin-top: 20px; }
    button { padding: 10px 16px; border-radius: 6px; border: none; font-weight: 600; cursor: pointer; }
    .primary { background: #0f62fe; color: #fff; }
    .secondary { background: #e0e0e0; color: #111; }
  </style>
</head>
<body>
  <h1>Authorize Group Access</h1>
  <div class="card">
    <p><strong>Group:</strong> ${escapeHtml(displayName)} (<code>${escapeHtml(acct.handle)}</code> / <code>${escapeHtml(par.group_did)}</code>)</p>
    <p><strong>Signed in as:</strong> <code>${escapeHtml(consent.userDid)}</code></p>
    <p><strong>Active roles:</strong> <code>${escapeHtml(userRoles.join(", ") || "none")}</code></p>
    <p><strong>Client:</strong> <code>${escapeHtml(par.client_id)}</code></p>
  </div>
  <div class="scopes">${escapeHtml(reviewedScope)}</div>
  <form method="POST" action="/oauth/confirm-action?consent=${escapeHtml(encodeURIComponent(consentId))}" data-testid="group-oauth-confirm-form">
    <input type="hidden" name="csrf_token" value="${escapeHtml(consent.csrf)}" />
    <input type="hidden" name="consent_snapshot" value="${escapeHtml(signedSnapshotRef)}" />
    <div class="actions">
      <button type="submit" name="decision" value="approve" class="primary" data-testid="group-oauth-confirm-approve">Approve</button>
      <button type="submit" name="decision" value="deny" class="secondary" data-testid="group-oauth-confirm-deny">Deny</button>
    </div>
  </form>
</body>
</html>`;

    return { status: 200, html };
  }

  async handleConfirmActionPost(params: {
    cookieHeader: string | undefined;
    consentId?: string;
    body: Record<string, string | undefined>;
    nowMs?: number;
  }): Promise<{ location: string; clearCookie: string }> {
    const nowMs = params.nowMs ?? Date.now();
    const rawCsrf = params.body.csrf_token;
    const dotIdx = typeof rawCsrf === "string" ? rawCsrf.indexOf(".") : -1;
    const csrfConsentId = dotIdx > 0 && typeof rawCsrf === "string" ? rawCsrf.slice(0, dotIdx) : undefined;
    if (params.consentId !== undefined && csrfConsentId !== undefined && params.consentId !== csrfConsentId) {
      throw new OAuthProtocolError(400, "invalid_request", "Consent session mismatch.");
    }
    const consentId = params.consentId ?? csrfConsentId;
    if (!consentId || !/^[A-Za-z0-9_-]{1,128}$/.test(consentId)) {
      throw new OAuthProtocolError(400, "invalid_request", "Invalid or expired consent session.");
    }

    const cookieName = this.consentCookieName(consentId);
    const cookies = parseCookies(params.cookieHeader);
    const consent = this.cryptoBox.verifyCookiePayload<ConsentCookiePayload>(
      `consent-action:${consentId}`,
      cookies[cookieName],
    );
    const clearCookie = formatSetCookie({
      name: cookieName,
      value: "",
      path: "/oauth/confirm-action",
      maxAgeSec: 0,
      secure: this.config.publicUrl.startsWith("https:"),
    });

    if (!consent || consent.expMs <= nowMs || rawCsrf !== consent.csrf) {
      throw new OAuthProtocolError(400, "invalid_request", "Invalid or expired consent session.");
    }

    const par = this.db
      .prepare("SELECT * FROM oauth_par WHERE request_uri = ?")
      .get(consent.requestUri) as
      | {
          request_uri: string;
          group_did: string | null;
          client_id: string;
          redirect_uri: string;
          response_mode: "query" | "fragment";
          scope: string;
          state: string | null;
          code_challenge: string;
          dpop_jkt: string;
          prompt: string | null;
          authenticated_user_did: string | null;
          authenticated_at: number | null;
          login_step_up_at: number | null;
          expires_at: number;
        }
      | undefined;

    if (!par || par.expires_at <= nowMs || par.authenticated_user_did !== consent.userDid) {
      throw new OAuthProtocolError(400, "invalid_request", "PAR expired or user mismatch.");
    }

    if (params.body.decision !== "approve") {
      this.db.prepare("DELETE FROM oauth_par WHERE request_uri = ?").run(par.request_uri);
      return {
        location: this.formatDownstreamRedirect({
          redirectUri: par.redirect_uri,
          responseMode: par.response_mode,
          state: par.state,
          error: "access_denied",
          errorDescription: "The user denied the authorization request.",
        }),
        clearCookie,
      };
    }

    if (!par.group_did) {
      throw new OAuthProtocolError(400, "invalid_request", "Missing group DID on PAR.");
    }

    const verifiedSnapshot = this.cryptoBox.verifyCookiePayload<{ snapshotId: string; requestUri: string }>(
      "consent-snapshot",
      params.body.consent_snapshot,
    );
    if (!verifiedSnapshot || verifiedSnapshot.requestUri !== par.request_uri) {
      throw new OAuthProtocolError(400, "invalid_request", "Missing or invalid consent snapshot reference.");
    }

    const location = this.issueDownstreamAuthCodeSync({
      groupDid: par.group_did,
      authorizingUserDid: consent.userDid,
      authenticatedAt: par.authenticated_at ?? nowMs,
      loginStepUpAt: par.prompt === "login" ? par.login_step_up_at : null,
      par,
      consentSnapshotId: verifiedSnapshot.snapshotId,
      nowMs,
    });

    return { location, clearCookie };
  }

  private issueDownstreamAuthCodeSync(params: {
    groupDid: string;
    authorizingUserDid: string;
    authenticatedAt: number;
    loginStepUpAt: number | null;
    par: {
      request_uri: string;
      client_id: string;
      redirect_uri: string;
      response_mode: "query" | "fragment";
      scope: string;
      state: string | null;
      code_challenge: string;
      dpop_jkt: string;
    };
    consentSnapshotId?: string;
    priorApprovedScope?: string;
    nowMs: number;
  }): string {
    const tx = this.db.transaction(() => {
      const acct = this.db
        .prepare("SELECT activated, takendown FROM group_account WHERE did = ?")
        .get(params.groupDid) as { activated: number; takendown: number } | undefined;
      if (!acct) {
        throw new OAuthProtocolError(400, "invalid_request", "Group not hosted here.");
      }
      if (acct.takendown !== 0 || this.db.prepare("SELECT 1 AS ok FROM group_deletion_journal WHERE group_did = ?").get(params.groupDid)) {
        throw new OAuthProtocolError(403, "access_denied", "Group is taken down.");
      }

      const sessionKind: "group" | "recovery" = acct.activated === 0 ? "recovery" : "group";
      const liveState = loadLiveGovernanceState(this.db, params.groupDid);
      const recRow = this.db
        .prepare("SELECT * FROM group_recovery_admin WHERE group_did = ?")
        .get(params.groupDid) as RecoveryAdminRow | undefined;
      const effState = effectiveStateForSession(
        liveState,
        { sessionKind, authorizingUserDid: params.authorizingUserDid },
        recRow,
      );

      if (sessionKind === "recovery") {
        if (!isAuthorizedLifecycleAdmin(params.authorizingUserDid, effState, params.groupDid)) {
          throw new OAuthProtocolError(403, "access_denied", "Caller is not an authorized recovery admin for this deactivated group.");
        }
        const livePerms = effectiveMemberPermissions(effState, params.groupDid, params.authorizingUserDid);
        if (!livePerms.allowsAccount({ attr: "status", action: "manage" })) {
          throw new OAuthProtocolError(403, "access_denied", "Caller lacks account:status?action=manage recovery permission.");
        }
      } else {
        if (
          params.authorizingUserDid !== params.groupDid &&
          !effState.memberships.has(params.authorizingUserDid)
        ) {
          throw new OAuthProtocolError(403, "access_denied", "Caller is not a member of this group.");
        }
      }

      // Atomically consume server-side consent snapshot if present, then narrow requested scopes
      // against caller's live roles and reviewed/prior ceiling (Atmosphere Groups §Permission sets).
      let ceilingPerms: ScopePermissions | undefined;
      if (params.consentSnapshotId !== undefined) {
        const snapRow = this.db
          .prepare(
            `UPDATE oauth_consent_snapshot
             SET consumed_at = ?
             WHERE snapshot_id = ?
               AND par_request_uri = ?
               AND group_did = ?
               AND authorizing_user_did = ?
               AND consumed_at IS NULL
               AND expires_at > ?
             RETURNING reviewed_scope`,
          )
          .get(
            params.nowMs,
            params.consentSnapshotId,
            params.par.request_uri,
            params.groupDid,
            params.authorizingUserDid,
            params.nowMs,
          ) as { reviewed_scope: string } | undefined;
        if (!snapRow) {
          throw new OAuthProtocolError(
            400,
            "invalid_request",
            "Consent snapshot is missing, expired, or already consumed.",
          );
        }
        ceilingPerms = expandGroupScopes(snapRow.reviewed_scope.split(/\s+/).filter(Boolean), params.groupDid);
      } else if (params.priorApprovedScope !== undefined) {
        ceilingPerms = expandGroupScopes(params.priorApprovedScope.split(/\s+/).filter(Boolean), params.groupDid);
      }

      const livePerms = effectiveMemberPermissions(effState, params.groupDid, params.authorizingUserDid);
      let issuedScope: string;
      try {
        issuedScope = resolveAuthorizedGroupScope(
          params.par.scope.split(/\s+/).filter(Boolean),
          livePerms,
          params.groupDid,
          { ceilingPerms },
        ).scope;
      } catch (err) {
        if (err instanceof UnauthorizedScopeError) {
          throw new OAuthProtocolError(403, "access_denied", err.message);
        }
        if (err instanceof InvalidScopeError) {
          throw new OAuthProtocolError(400, "invalid_scope", err.message);
        }
        throw err;
      }

      const rawCode = `ghc_${randomBytes(32).toString("base64url")}`;
      const codeHash = sha256HexBytes(rawCode);
      const familyId = randomUUID();

      this.db.prepare("DELETE FROM oauth_par WHERE request_uri = ?").run(params.par.request_uri);
      this.db
        .prepare(
          `INSERT INTO oauth_code (
             code_hash, family_id, group_did, authorizing_user_did, client_id, redirect_uri,
             approved_scope, code_challenge, dpop_jkt, session_kind, authenticated_at, login_step_up_at,
             consumed_at, expires_at, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          codeHash,
          familyId,
          params.groupDid,
          params.authorizingUserDid,
          params.par.client_id,
          params.par.redirect_uri,
          issuedScope,
          params.par.code_challenge,
          params.par.dpop_jkt,
          sessionKind,
          params.authenticatedAt,
          params.loginStepUpAt,
          params.nowMs + AUTH_CODE_TTL_MS,
          params.nowMs,
        );

      return this.formatDownstreamRedirect({
        redirectUri: params.par.redirect_uri,
        responseMode: params.par.response_mode,
        state: params.par.state,
        code: rawCode,
      });
    });

    return tx.immediate();
  }

  // =========================================================================
  // 5-State Crash-Safe `prompt=create` Journal (`pending_plc` -> `plc_published` -> `code_issued`)
  // =========================================================================

  private async executeCreateGroupJournalLocked(params: {
    initiatorDid: string;
    par: {
      request_uri: string;
      client_id: string;
      redirect_uri: string;
      response_mode: "query" | "fragment";
      scope: string;
      state: string | null;
      code_challenge: string;
      dpop_jkt: string;
    };
    createParams: CreationFormParams;
    nowMs: number;
  }): Promise<string> {
    const nowMs = params.nowMs;
    const nowIso = new Date(nowMs).toISOString();

    let journal = this.db
      .prepare(
        "SELECT * FROM group_creation_journal WHERE initiator_did = ? AND client_id = ? AND creation_key = ?",
      )
      .get(params.initiatorDid, params.par.client_id, params.createParams.creationKey) as
      | {
          group_did: string;
          handle: string;
          display_name: string;
          join_policy: "invite" | "approval" | "open";
          public_meta: number;
          signing_key_enc: string | null;
          kem_key_enc: string | null;
          rotation_key_enc: string | null;
          genesis_op_json: string;
          status: string;
          reviewed_scope?: string | null;
          redirect_url?: string | null;
          code_expires_at?: number | null;
        }
      | undefined;

    if (journal && (journal.status === "code_issued" || journal.status === "completed")) {
      const parStillPresent = this.db
        .prepare("SELECT 1 AS ok FROM oauth_par WHERE request_uri = ?")
        .get(params.par.request_uri);
      if (!parStillPresent && journal.status === "code_issued" && journal.redirect_url && (journal.code_expires_at ?? 0) > nowMs) {
        return journal.redirect_url;
      }
      return this.issueDownstreamAuthCodeSync({
        groupDid: journal.group_did,
        authorizingUserDid: params.initiatorDid,
        authenticatedAt: nowMs,
        loginStepUpAt: null,
        par: params.par,
        nowMs,
      });
    }

    if (journal && (journal.status === "pending_plc" || journal.status === "plc_published")) {
      this.db
        .prepare(
          "UPDATE group_creation_journal SET updated_at = ? WHERE initiator_did = ? AND client_id = ? AND creation_key = ?",
        )
        .run(nowMs, params.initiatorDid, params.par.client_id, params.createParams.creationKey);
      const livePlcOp = await this.plc.getPlcLastOp(journal.group_did);
      if (livePlcOp && livePlcOp.type === "plc_tombstone") {
        const staleGroupDid = journal.group_did;
        this.db
          .transaction(() => {
            if (!this.db.prepare("SELECT 1 AS ok FROM group_account WHERE did = ?").get(staleGroupDid)) {
              this.db.prepare("DELETE FROM handle_reservation WHERE group_did = ?").run(staleGroupDid);
            }
            this.db
              .prepare(
                `UPDATE group_creation_journal
                 SET status = 'compensated', signing_key_enc = NULL, kem_key_enc = NULL, rotation_key_enc = NULL, auth_code = NULL, updated_at = ?
                 WHERE initiator_did = ? AND client_id = ? AND creation_key = ? AND group_did = ?`,
              )
              .run(nowMs, params.initiatorDid, params.par.client_id, params.createParams.creationKey, staleGroupDid);
          })
          .immediate();
        journal.status = "compensated";
      } else if (journal.status === "plc_published" && !livePlcOp) {
        journal.status = "pending_plc";
      }
    }

    let signingKey: P256Keypair;
    let kemKey: P256Keypair;
    let rotationKey: P256Keypair;

    // State 1: `pending_plc`
    if (!journal || journal.status === "compensated") {
      const normalizedHandle = normalizeAndValidateGroupHandle(
        params.createParams.handle ??
          `${slugifyHandleBase(params.createParams.displayName)}-${randomBytes(3).toString("hex")}.${this.config.handleDomain}`,
        this.config.handleDomain,
      );

      signingKey = await P256Keypair.create({ exportable: true });
      kemKey = await P256Keypair.create({ exportable: true });
      rotationKey = await P256Keypair.create({ exportable: true });

      const { did, genesisOp } = await createGroupGenesisPlcOp({
        signingKey,
        kemKey,
        rotationKey,
        handle: normalizedHandle,
        pdsEndpoint: groupHostPdsServiceEndpoint(this.config),
      });

      const rowKey = `${params.initiatorDid}:${params.par.client_id}:${params.createParams.creationKey}`;
      const sigEnc = await this.cryptoBox.encryptKeypair("group_creation_journal", rowKey, "signing_key_enc", signingKey);
      const kemEnc = await this.cryptoBox.encryptKeypair("group_creation_journal", rowKey, "kem_key_enc", kemKey);
      const rotEnc = await this.cryptoBox.encryptKeypair("group_creation_journal", rowKey, "rotation_key_enc", rotationKey);
      const genesisJson = JSON.stringify(genesisOp);

      const tx1 = this.db.transaction(() => {
        const handleTaken = this.db
          .prepare("SELECT group_did FROM handle_reservation WHERE handle = ?")
          .get(normalizedHandle) as { group_did: string } | undefined;
        const acctTaken = this.db
          .prepare("SELECT did FROM group_account WHERE handle = ?")
          .get(normalizedHandle) as { did: string } | undefined;
        if ((handleTaken && handleTaken.group_did !== did) || (acctTaken && acctTaken.did !== did)) {
          throw new GroupHostHttpError(400, "HandleNotAvailable", `Handle '${normalizedHandle}' is already taken.`);
        }

        this.db
          .prepare(
            `INSERT INTO handle_reservation (handle, group_did, created_at)
             VALUES (?, ?, ?)
             ON CONFLICT(handle) DO UPDATE SET group_did = excluded.group_did`,
          )
          .run(normalizedHandle, did, nowMs);

        this.db
          .prepare(
            `INSERT INTO group_creation_journal (
               initiator_did, client_id, creation_key, group_did, handle, display_name, join_policy, public_meta,
               signing_key_enc, kem_key_enc, rotation_key_enc, genesis_op_json, reviewed_scope,
               status, auth_code, redirect_url, code_expires_at, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_plc', NULL, NULL, NULL, ?, ?)
             ON CONFLICT(initiator_did, client_id, creation_key) DO UPDATE SET
               group_did = excluded.group_did,
               handle = excluded.handle,
               display_name = excluded.display_name,
               join_policy = excluded.join_policy,
               public_meta = excluded.public_meta,
               signing_key_enc = excluded.signing_key_enc,
               kem_key_enc = excluded.kem_key_enc,
               rotation_key_enc = excluded.rotation_key_enc,
               genesis_op_json = excluded.genesis_op_json,
               reviewed_scope = excluded.reviewed_scope,
               status = 'pending_plc',
               updated_at = excluded.updated_at`,
          )
          .run(
            params.initiatorDid,
            params.par.client_id,
            params.createParams.creationKey,
            did,
            normalizedHandle,
            params.createParams.displayName,
            params.createParams.joinPolicy,
            params.createParams.publicMeta ? 1 : 0,
            sigEnc,
            kemEnc,
            rotEnc,
            genesisJson,
            params.createParams.reviewedScope ?? params.par.scope,
            nowMs,
            nowMs,
          );
      });
      tx1.immediate();

      journal = {
        group_did: did,
        handle: normalizedHandle,
        display_name: params.createParams.displayName,
        join_policy: params.createParams.joinPolicy,
        public_meta: params.createParams.publicMeta ? 1 : 0,
        signing_key_enc: sigEnc,
        kem_key_enc: kemEnc,
        rotation_key_enc: rotEnc,
        genesis_op_json: genesisJson,
        reviewed_scope: params.createParams.reviewedScope ?? params.par.scope,
        status: "pending_plc",
      };
    } else {
      const rowKey = `${params.initiatorDid}:${params.par.client_id}:${params.createParams.creationKey}`;
      signingKey = await this.cryptoBox.decryptKeypair(
        "group_creation_journal",
        rowKey,
        "signing_key_enc",
        journal.signing_key_enc!,
      );
      kemKey = await this.cryptoBox.decryptKeypair(
        "group_creation_journal",
        rowKey,
        "kem_key_enc",
        journal.kem_key_enc!,
      );
      rotationKey = await this.cryptoBox.decryptKeypair(
        "group_creation_journal",
        rowKey,
        "rotation_key_enc",
        journal.rotation_key_enc!,
      );
    }

    const groupDid = journal.group_did;

    // State 2: `plc_published`
    if (journal.status === "pending_plc") {
      const existingDoc = await this.plc.resolveDidDocument(groupDid);
      if (!existingDoc) {
        const genesisOp = JSON.parse(journal.genesis_op_json) as Operation;
        const plcRes = await this.plc.submitPlcOperation(groupDid, genesisOp);
        if (!plcRes.ok) {
          const text = await plcRes.text().catch(() => "");
          throw new GroupHostHttpError(502, "PlcGenesisFailed", `PLC genesis rejected (${plcRes.status}): ${text.slice(0, 200)}`);
        }
      }
      this.db
        .prepare(
          "UPDATE group_creation_journal SET status = 'plc_published', updated_at = ? WHERE initiator_did = ? AND client_id = ? AND creation_key = ?",
        )
        .run(nowMs, params.initiatorDid, params.par.client_id, params.createParams.creationKey);
      journal.status = "plc_published";
    }

    // State 3: `code_issued` (pre-compute MST + space CBORs, then commit everything in one synchronous IMMEDIATE tx!)
    return this.locks.withGroupRepoLock(groupDid, async () => {
      const postLockPlcOp = await this.plc.getPlcLastOp(groupDid);
      const postLockDoc = await this.plc.resolveDidDocument(groupDid);
      if (!postLockDoc || (postLockPlcOp && postLockPlcOp.type === "plc_tombstone")) {
        throw new GroupHostHttpError(
          409,
          "CreationJournalCompensated",
          "Group genesis DID is missing or tombstoned on PLC; retry group creation.",
        );
      }

      const publicMetaBool = Boolean(journal!.public_meta);
      const acctSigEnc = await this.cryptoBox.encryptKeypair("group_account", groupDid, "signing_key_enc", signingKey);
      const acctKemEnc = await this.cryptoBox.encryptKeypair("group_account", groupDid, "kem_key_enc", kemKey);
      const acctRotEnc = await this.cryptoBox.encryptKeypair("group_account", groupDid, "rotation_key_enc", rotationKey);

      const metaSpace = groupMetaUri(groupDid);
      const membersSpace = groupMembersUri(groupDid);

      // Build initial public MST commit (`org.atgrp.declaration/self` when `publicMeta === true`, empty signed MST when `false`!)
      const initBlocks = new BlockMap();
      const tempStorage = new SqlStagingRepoStorage(this.db, groupDid);
      const declarationValue = {
        $type: REPO_COLLECTION.groupDeclaration,
      };
      const initWrites = publicMetaBool
        ? [
            {
              action: WriteOpAction.Create as const,
              collection: REPO_COLLECTION.groupDeclaration as NsidString,
              rkey: SELF_SKEY,
              record: jsonToLex(declarationValue) as LexMap,
            },
          ]
        : [];
      const initCommit = await Repo.formatInitCommit(tempStorage, groupDid, signingKey, initWrites);
      for (const b of initCommit.newBlocks) {
        initBlocks.set(b.cid, b.bytes);
      }
      let declarationCidStr: string | null = null;
      if (publicMetaBool) {
        declarationCidStr = (await cidForCbor(cborEncode(jsonToLex(declarationValue) as LexValue))).toString();
      }

      // Pre-serialize `org.atgrp.meta/self` records (`policy/self`, `about/self`, `config/self`)
      const metaPolicy: GroupAtgrpPolicy = {
        $type: ATGRP_POLICY,
        publicRead: publicMetaBool,
        unlisted: false,
        grants: [
          { role: "admin", read: true },
          { role: "moderator", read: true },
          { role: "member", read: true },
        ],
      };
      const metaPolicyRec = { $type: ATPROTO_SPACE_COLLECTION.spacePolicy, policy: metaPolicy };
      const aboutRec = {
        $type: ATGRP_COLLECTION.about,
        displayName: journal!.display_name,
      };
      const configRec = {
        $type: ATGRP_COLLECTION.config,
        joinPolicy: journal!.join_policy,
      };

      const serMetaPolicy = await serializeRecord(
        ATPROTO_SPACE_COLLECTION.spacePolicy as NsidString,
        SELF_SKEY as RecordKeyString,
        jsonToLex(metaPolicyRec) as LexMap,
      );
      const serAbout = await serializeRecord(
        ATGRP_COLLECTION.about as NsidString,
        SELF_SKEY as RecordKeyString,
        jsonToLex(aboutRec) as LexMap,
      );
      const serConfig = await serializeRecord(
        ATGRP_COLLECTION.config as NsidString,
        SELF_SKEY as RecordKeyString,
        jsonToLex(configRec) as LexMap,
      );

      // Pre-serialize `org.atgrp.members/self` records (`policy/self`, `labeler/self`, `role/admin`, `role/moderator`, `role/member`, `membership/<creatorDid>`)
      const membersPolicy: GroupAtgrpPolicy = {
        $type: ATGRP_POLICY,
        publicRead: false,
        unlisted: false,
        grants: [
          { role: "admin", read: true, write: true },
          { role: "moderator", read: true, write: true },
          { role: "member", read: true, write: true },
        ],
      };
      const membersPolicyRec = { $type: ATPROTO_SPACE_COLLECTION.spacePolicy, policy: membersPolicy };
      const labelerRec = {
        $type: ATGRP_COLLECTION.labeler,
        policies: { labelValues: ["!hide", "!takedown"] },
      };
      const adminRoleRec = {
        $type: ATGRP_COLLECTION.role,
        displayName: "Admin",
        permissions: groupAdminScopes(groupDid).filter((s) => s !== "atproto"),
        canAssign: ["*"],
      };
      const modRoleRec = {
        $type: ATGRP_COLLECTION.role,
        displayName: "Moderator",
        permissions: groupModeratorScopes().filter((s) => s !== "atproto"),
        canAssign: ["member"],
      };
      const memberRoleRec = {
        $type: ATGRP_COLLECTION.role,
        displayName: "Member",
        default: true,
      };

      const initialMembersSpaceRev = nextMonotonicTid();
      const nextMembersSpaceRev = nextMonotonicTid(initialMembersSpaceRev);
      const creatorIncarnation = randomUUID();
      const creatorMembershipRec: Record<string, unknown> = {
        $type: ATGRP_COLLECTION.membership,
        roles: ["admin", "member"],
        createdAt: nowIso,
        [FLOCK_EXTENSION_FIELD.incarnation]: creatorIncarnation,
        [FLOCK_EXTENSION_FIELD.generation]: 1,
        [FLOCK_EXTENSION_FIELD.admittedSpaceRev]: nextMembersSpaceRev,
        [FLOCK_EXTENSION_FIELD.afterWriterRev]: null,
      };

      const serMembersPolicy = await serializeRecord(
        ATPROTO_SPACE_COLLECTION.spacePolicy as NsidString,
        SELF_SKEY as RecordKeyString,
        jsonToLex(membersPolicyRec) as LexMap,
      );
      const serLabeler = await serializeRecord(
        ATGRP_COLLECTION.labeler as NsidString,
        SELF_SKEY as RecordKeyString,
        jsonToLex(labelerRec) as LexMap,
      );
      const serAdminRole = await serializeRecord(
        ATGRP_COLLECTION.role as NsidString,
        "admin" as RecordKeyString,
        jsonToLex(adminRoleRec) as LexMap,
      );
      const serModRole = await serializeRecord(
        ATGRP_COLLECTION.role as NsidString,
        "moderator" as RecordKeyString,
        jsonToLex(modRoleRec) as LexMap,
      );
      const serMemberRole = await serializeRecord(
        ATGRP_COLLECTION.role as NsidString,
        "member" as RecordKeyString,
        jsonToLex(memberRoleRec) as LexMap,
      );
      const serCreatorMem = await serializeRecord(
        ATGRP_COLLECTION.membership as NsidString,
        params.initiatorDid as RecordKeyString,
        jsonToLex(creatorMembershipRec) as LexMap,
      );

      // Narrow requested PAR scopes against creator's seeded admin permissions and reviewed ceiling
      const creatorState = {
        roles: new Map<string, GroupRoleRecord>([
          ["admin", adminRoleRec],
          ["moderator", modRoleRec],
          ["member", memberRoleRec],
        ]),
        memberships: new Map([[params.initiatorDid, { roles: ["admin", "member"], createdAt: nowIso }]]),
        spacePolicies: new Map([
          [metaSpace, metaPolicy],
          [membersSpace, membersPolicy],
        ]),
      };
      const creatorPerms = effectiveMemberPermissions(creatorState, groupDid, params.initiatorDid);
      const reviewedScopeRaw = journal!.reviewed_scope ?? params.createParams.reviewedScope ?? params.par.scope;
      const ceilingPerms = expandGroupScopes(reviewedScopeRaw.split(/\s+/).filter(Boolean), groupDid);
      let issuedScope: string;
      try {
        issuedScope = resolveAuthorizedGroupScope(
          params.par.scope.split(/\s+/).filter(Boolean),
          creatorPerms,
          groupDid,
          { ceilingPerms },
        ).scope;
      } catch (err) {
        if (err instanceof UnauthorizedScopeError) {
          throw new OAuthProtocolError(403, "access_denied", err.message);
        }
        if (err instanceof InvalidScopeError) {
          throw new OAuthProtocolError(400, "invalid_scope", err.message);
        }
        throw err;
      }

      const rawCode = `ghc_${randomBytes(32).toString("base64url")}`;
      const codeHash = sha256HexBytes(rawCode);
      const codeExpiresAt = nowMs + AUTH_CODE_TTL_MS;
      const redirectUrl = this.formatDownstreamRedirect({
        redirectUri: params.par.redirect_uri,
        responseMode: params.par.response_mode,
        state: params.par.state,
        code: rawCode,
      });

      const tx3 = this.db.transaction(() => {
        const liveJournal = this.db
          .prepare(
            "SELECT group_did, status FROM group_creation_journal WHERE initiator_did = ? AND client_id = ? AND creation_key = ?",
          )
          .get(params.initiatorDid, params.par.client_id, params.createParams.creationKey) as
          | { group_did: string; status: string }
          | undefined;
        if (!liveJournal || liveJournal.group_did !== groupDid || liveJournal.status !== "plc_published") {
          throw new GroupHostHttpError(
            409,
            "CreationJournalCompensated",
            "Group creation journal was concurrently superseded or compensated.",
          );
        }

        this.db
          .prepare(
            `INSERT INTO group_account (
               did, handle, signing_key_enc, kem_key_enc, rotation_key_enc, activated, takendown, deactivated_at, auth_epoch, created_at
             ) VALUES (?, ?, ?, ?, ?, 1, 0, NULL, 1, ?)`,
          )
          .run(groupDid, journal!.handle, acctSigEnc, acctKemEnc, acctRotEnc, nowMs);

        const insBlock = this.db.prepare(
          "INSERT INTO public_repo_block (group_did, cid, bytes, rev) VALUES (?, ?, ?, ?)",
        );
        for (const b of initBlocks) {
          insBlock.run(groupDid, b.cid.toString(), Buffer.from(b.bytes), initCommit.rev);
        }
        this.db
          .prepare("INSERT INTO public_repo_root (group_did, commit_cid, rev, updated_at) VALUES (?, ?, ?, ?)")
          .run(groupDid, initCommit.cid.toString(), initCommit.rev, nowMs);

        if (publicMetaBool && declarationCidStr) {
          this.db
            .prepare(
              `INSERT INTO public_record (group_did, collection, rkey, uri, cid, value, rev, indexed_at)
               VALUES (?, ?, 'self', ?, ?, ?, ?, ?)`,
            )
            .run(
              groupDid,
              REPO_COLLECTION.groupDeclaration,
              `at://${groupDid}/${REPO_COLLECTION.groupDeclaration}/self`,
              declarationCidStr,
              JSON.stringify(declarationValue),
              initCommit.rev,
              nowMs,
            );
        }

        const initialMetaSpaceRev = nextMonotonicTid();
        this.db
          .prepare(
            `INSERT INTO group_space (
               space_uri, group_did, space_type, skey, policy_json, space_rev, index_rkey, deleted_at, created_at, updated_at
             ) VALUES (?, ?, ?, 'self', ?, ?, NULL, NULL, ?, ?)`,
          )
          .run(metaSpace, groupDid, ATGRP_SPACE_TYPE.meta, JSON.stringify(metaPolicy), initialMetaSpaceRev, nowMs, nowMs);

        this.repoStore.applySpaceRepoMutationsSync({
          groupDid,
          spaceUri: metaSpace,
          repoDid: groupDid,
          ops: [
            {
              action: "create",
              collection: ATPROTO_SPACE_COLLECTION.spacePolicy,
              rkey: SELF_SKEY,
              value: metaPolicyRec,
              cborBytes: serMetaPolicy.bytes,
              cidStr: serMetaPolicy.cid.toString(),
            },
            {
              action: "create",
              collection: ATGRP_COLLECTION.about,
              rkey: SELF_SKEY,
              value: aboutRec,
              cborBytes: serAbout.bytes,
              cidStr: serAbout.cid.toString(),
            },
            {
              action: "create",
              collection: ATGRP_COLLECTION.config,
              rkey: SELF_SKEY,
              value: configRec,
              cborBytes: serConfig.bytes,
              cidStr: serConfig.cid.toString(),
            },
          ],
          isOwnAuthoritySpace: true,
          suppressNotices: true,
          nowMs,
        });

        this.db
          .prepare(
            `INSERT INTO group_space (
               space_uri, group_did, space_type, skey, policy_json, space_rev, index_rkey, deleted_at, created_at, updated_at
             ) VALUES (?, ?, ?, 'self', ?, ?, NULL, NULL, ?, ?)`,
          )
          .run(
            membersSpace,
            groupDid,
            ATGRP_SPACE_TYPE.members,
            JSON.stringify(membersPolicy),
            initialMembersSpaceRev,
            nowMs,
            nowMs,
          );

        this.repoStore.applySpaceRepoMutationsSync({
          groupDid,
          spaceUri: membersSpace,
          repoDid: groupDid,
          ops: [
            {
              action: "create",
              collection: ATPROTO_SPACE_COLLECTION.spacePolicy,
              rkey: SELF_SKEY,
              value: membersPolicyRec,
              cborBytes: serMembersPolicy.bytes,
              cidStr: serMembersPolicy.cid.toString(),
            },
            {
              action: "create",
              collection: ATGRP_COLLECTION.labeler,
              rkey: SELF_SKEY,
              value: labelerRec,
              cborBytes: serLabeler.bytes,
              cidStr: serLabeler.cid.toString(),
            },
            {
              action: "create",
              collection: ATGRP_COLLECTION.role,
              rkey: "admin",
              value: adminRoleRec,
              cborBytes: serAdminRole.bytes,
              cidStr: serAdminRole.cid.toString(),
            },
            {
              action: "create",
              collection: ATGRP_COLLECTION.role,
              rkey: "moderator",
              value: modRoleRec,
              cborBytes: serModRole.bytes,
              cidStr: serModRole.cid.toString(),
            },
            {
              action: "create",
              collection: ATGRP_COLLECTION.role,
              rkey: "member",
              value: memberRoleRec,
              cborBytes: serMemberRole.bytes,
              cidStr: serMemberRole.cid.toString(),
            },
            {
              action: "create",
              collection: ATGRP_COLLECTION.membership,
              rkey: params.initiatorDid,
              value: creatorMembershipRec,
              cborBytes: serCreatorMem.bytes,
              cidStr: serCreatorMem.cid.toString(),
              incarnation: creatorIncarnation,
            },
          ],
          isOwnAuthoritySpace: true,
          suppressNotices: true,
          nowMs,
        });

        const familyId = randomUUID();
        this.db.prepare("DELETE FROM oauth_par WHERE request_uri = ?").run(params.par.request_uri);
        this.db
          .prepare(
            `INSERT INTO oauth_code (
               code_hash, family_id, group_did, authorizing_user_did, client_id, redirect_uri,
               approved_scope, code_challenge, dpop_jkt, session_kind, authenticated_at, login_step_up_at,
               consumed_at, expires_at, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'group', ?, NULL, NULL, ?, ?)`,
          )
          .run(
            codeHash,
            familyId,
            groupDid,
            params.initiatorDid,
            params.par.client_id,
            params.par.redirect_uri,
            issuedScope,
            params.par.code_challenge,
            params.par.dpop_jkt,
            nowMs,
            codeExpiresAt,
            nowMs,
          );

        // Scrub encrypted keys from `group_creation_journal` and advance to `code_issued`!
        this.db
          .prepare(
            `UPDATE group_creation_journal
             SET signing_key_enc = NULL,
                 kem_key_enc = NULL,
                 rotation_key_enc = NULL,
                 status = 'code_issued',
                 auth_code = ?,
                 redirect_url = ?,
                 par_state = ?,
                 par_response_mode = ?,
                 code_expires_at = ?,
                 updated_at = ?
             WHERE initiator_did = ? AND client_id = ? AND creation_key = ?`,
          )
          .run(
            rawCode,
            redirectUrl,
            params.par.state,
            params.par.response_mode,
            codeExpiresAt,
            nowMs,
            params.initiatorDid,
            params.par.client_id,
            params.createParams.creationKey,
          );
      });
      tx3.immediate();

      return redirectUrl;
    });
  }

  private creationSweepCursorRowid = 0;

  /**
   * Compensates stale `pending_plc` / `plc_published` creation journals (`updated_at <= nowMs - 15 min`)
   * by tombstoning uncommitted genesis DIDs on PLC and releasing handle reservations.
   * Uses `rowid` keyset pagination with a persistent wrap-around cursor so failing PLC tombstones
   * never starve later stale creation journals.
   */
  async compensateStaleCreationJournals(nowMs = Date.now()): Promise<void> {
    const PAGE_SIZE = 50;
    const MAX_PER_SWEEP = 500;
    const cutoffMs = nowMs - 15 * MINUTE_MS;
    const stmtUnbounded = this.db.prepare(
      `SELECT rowid AS row_id, initiator_did, client_id, creation_key, group_did, rotation_key_enc
       FROM group_creation_journal
       WHERE status IN ('pending_plc', 'plc_published')
         AND updated_at <= ?
         AND rowid > ?
       ORDER BY rowid ASC
       LIMIT ?`,
    );
    const stmtBounded = this.db.prepare(
      `SELECT rowid AS row_id, initiator_did, client_id, creation_key, group_did, rotation_key_enc
       FROM group_creation_journal
       WHERE status IN ('pending_plc', 'plc_published')
         AND updated_at <= ?
         AND rowid > ?
         AND rowid <= ?
       ORDER BY rowid ASC
       LIMIT ?`,
    );

    const initialCursor = this.creationSweepCursorRowid;
    let cursor = initialCursor;
    let wrapped = false;
    let processed = 0;

    while (processed < MAX_PER_SWEEP) {
      const limit = Math.min(PAGE_SIZE, MAX_PER_SWEEP - processed);
      const staleRows = (
        wrapped
          ? stmtBounded.all(cutoffMs, cursor, initialCursor, limit)
          : stmtUnbounded.all(cutoffMs, cursor, limit)
      ) as Array<{
        row_id: number;
        initiator_did: string;
        client_id: string;
        creation_key: string;
        group_did: string;
        rotation_key_enc: string | null;
      }>;

      for (const row of staleRows) {
        cursor = row.row_id;
        this.creationSweepCursorRowid = cursor;
        processed += 1;
        try {
          const rowKey = `${row.initiator_did}:${row.client_id}:${row.creation_key}`;
          await this.locks.withGroupRepoLock(`create:${rowKey}`, () =>
            this.locks.withGroupRepoLock(row.group_did, async () => {
              const liveRow = this.db
                .prepare(
                  `SELECT group_did, status, updated_at, rotation_key_enc
                   FROM group_creation_journal
                   WHERE initiator_did = ? AND client_id = ? AND creation_key = ?`,
                )
                .get(row.initiator_did, row.client_id, row.creation_key) as
                | {
                    group_did: string;
                    status: string;
                    updated_at: number;
                    rotation_key_enc: string | null;
                  }
                | undefined;
              if (!liveRow || liveRow.group_did !== row.group_did) {
                return;
              }

              const committedAcct = this.db
                .prepare("SELECT 1 AS ok FROM group_account WHERE did = ?")
                .get(row.group_did);
              if (committedAcct) {
                this.db
                  .prepare(
                    `UPDATE group_creation_journal
                     SET status = 'completed', signing_key_enc = NULL, kem_key_enc = NULL, rotation_key_enc = NULL, auth_code = NULL, updated_at = ?
                     WHERE initiator_did = ? AND client_id = ? AND creation_key = ? AND group_did = ?`,
                  )
                  .run(nowMs, row.initiator_did, row.client_id, row.creation_key, row.group_did);
                return;
              }

              if (
                (liveRow.status !== "pending_plc" && liveRow.status !== "plc_published") ||
                liveRow.updated_at > cutoffMs
              ) {
                return;
              }

              let plcSafeToCompensate = false;
              try {
                let decryptedRotKey: P256Keypair | null = null;
                for (let attempt = 1; attempt <= 3; attempt += 1) {
                  const lastOp = await this.plc.getPlcLastOp(row.group_did);
                  if (!lastOp || lastOp.type === "plc_tombstone") {
                    plcSafeToCompensate = true;
                    break;
                  }
                  if (!liveRow.rotation_key_enc) {
                    break;
                  }
                  if (!decryptedRotKey) {
                    decryptedRotKey = await this.cryptoBox.decryptKeypair(
                      "group_creation_journal",
                      rowKey,
                      "rotation_key_enc",
                      liveRow.rotation_key_enc,
                    );
                  }
                  if (!plcOpRotationKeys(lastOp).includes(decryptedRotKey.did())) {
                    break;
                  }
                  const prevCid = await plcCidForOp(lastOp);
                  const tomb = await tombstoneOp(prevCid, decryptedRotKey);
                  let res: Response;
                  try {
                    res = await this.plc.submitPlcOperation(row.group_did, tomb);
                  } catch (submitErr) {
                    if (
                      attempt < 3 &&
                      submitErr instanceof Error &&
                      (submitErr.name === "TimeoutError" || submitErr.name === "AbortError")
                    ) {
                      continue;
                    }
                    throw submitErr;
                  }
                  if (res.ok) {
                    plcSafeToCompensate = true;
                    break;
                  }
                  if (res.status === 409 && attempt < 3) {
                    continue;
                  }
                  // Reject non-409 failures (including POST 404!) without scrubbing keys or releasing handle_reservation.
                  break;
                }
              } catch {
                plcSafeToCompensate = false;
              }
              if (!plcSafeToCompensate) {
                // Retain journal & handle reservation when PLC live DID cannot be tombstoned, without starving higher rowids!
                return;
              }

              const tx = this.db.transaction(() => {
                const upd = this.db
                  .prepare(
                    `UPDATE group_creation_journal
                     SET status = 'compensated', signing_key_enc = NULL, kem_key_enc = NULL, rotation_key_enc = NULL, auth_code = NULL, updated_at = ?
                     WHERE initiator_did = ? AND client_id = ? AND creation_key = ? AND group_did = ? AND status IN ('pending_plc', 'plc_published')`,
                  )
                  .run(nowMs, row.initiator_did, row.client_id, row.creation_key, row.group_did);
                if (
                  upd.changes === 1 &&
                  !this.db.prepare("SELECT 1 AS ok FROM group_account WHERE did = ?").get(row.group_did)
                ) {
                  this.db.prepare("DELETE FROM handle_reservation WHERE group_did = ?").run(row.group_did);
                }
              });
              tx.immediate();
            }),
          );
        } catch {
          // Per-row isolation so cursor and subsequent rows always progress
        }
      }

      if (staleRows.length < limit) {
        if (!wrapped && initialCursor !== 0) {
          cursor = 0;
          wrapped = true;
        } else {
          cursor = 0;
          break;
        }
      }
    }
    this.creationSweepCursorRowid = cursor;
  }

  // =========================================================================
  // `/oauth/token` (`authorization_code` & `refresh_token`) & `/oauth/revoke`
  // =========================================================================

  private async signOAuthAccessToken(params: {
    groupDid: string;
    sessionId: string;
    familyId: string;
    dpopJkt: string;
    authEpoch: number;
    scope: string;
    nowMs: number;
  }): Promise<string> {
    const nowSec = Math.floor(params.nowMs / 1000);
    const header = {
      alg: "ES256",
      typ: "at+jwt",
      kid: this.serviceKeys.activeJwkKid,
    };
    const payload = {
      iss: this.config.publicUrl,
      sub: params.groupDid,
      aud: this.config.publicUrl,
      jti: randomUUID(),
      iat: nowSec,
      exp: nowSec + ACCESS_TOKEN_TTL_SEC,
      scope: params.scope,
      sid: params.sessionId,
      fid: params.familyId,
      epoch: params.authEpoch,
      cnf: { jkt: params.dpopJkt },
    };
    const signingInput = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
    const sig = await this.serviceKeys.activeKeypair.sign(Buffer.from(signingInput, "utf8"));
    return `${signingInput}.${Buffer.from(sig).toString("base64url")}`;
  }

  private revokeFamilySync(familyId: string, groupDid: string, nowMs: number): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO revoked_oauth_family (family_id, group_did, expires_at, revoked_at) VALUES (?, ?, ?, ?)",
      )
      .run(familyId, groupDid, nowMs + REFRESH_TOKEN_TTL_MS, nowMs);
    this.db.prepare("DELETE FROM oauth_refresh_token WHERE family_id = ?").run(familyId);
    this.db.prepare("DELETE FROM oauth_session WHERE family_id = ?").run(familyId);
  }

  async handleToken(params: {
    dpopHeader: string | string[] | undefined;
    authorizationHeader: string | undefined;
    body: Record<string, string | undefined>;
    nowMs?: number;
  }): Promise<{
    dpopNonce: string;
    body: {
      access_token: string;
      token_type: "DPoP";
      sub: string;
      scope: string;
      refresh_token: string;
      expires_in: number;
    };
  }> {
    const nowMs = params.nowMs ?? Date.now();
    if (params.authorizationHeader !== undefined) {
      throw new OAuthProtocolError(400, "invalid_request", "/oauth/token accepts body parameters only, never Authorization header.");
    }

    const dpop = await this.verifyDpopProof({
      dpopHeader: params.dpopHeader,
      method: "POST",
      path: "/oauth/token",
      isAuthServer: true,
      nowMs,
    });

    const { clientId } = await this.verifyDownstreamClientAuth({
      body: params.body,
      endpointUrl: `${this.config.publicUrl}/oauth/token`,
      nowMs,
    });

    const grantType = params.body.grant_type;

    if (grantType === "authorization_code") {
      const code = params.body.code;
      const codeVerifier = params.body.code_verifier;
      const redirectUri = params.body.redirect_uri;
      if (!code || !codeVerifier || !redirectUri) {
        throw new OAuthProtocolError(400, "invalid_request", "code, code_verifier, and redirect_uri are required.");
      }

      const codeHash = sha256HexBytes(code);
      const codeGroupPeek = this.db
        .prepare("SELECT group_did FROM oauth_code WHERE code_hash = ?")
        .get(codeHash) as { group_did: string } | undefined;
      if (!codeGroupPeek) {
        throw new OAuthProtocolError(400, "invalid_grant", "Unknown authorization code.");
      }
      const redeemed = await this.locks.withGroupRepoLock(codeGroupPeek.group_did, () =>
        this.db
          .transaction(() => {
            const codeRow = this.db
              .prepare("SELECT * FROM oauth_code WHERE code_hash = ?")
              .get(codeHash) as
              | {
                  code_hash: string;
                  family_id: string;
                  group_did: string;
                  authorizing_user_did: string;
                  client_id: string;
                  redirect_uri: string;
                  approved_scope: string;
                  code_challenge: string;
                  dpop_jkt: string;
                  session_kind: "group" | "recovery";
                  authenticated_at: number;
                  login_step_up_at: number | null;
                  consumed_at: number | null;
                  expires_at: number;
                }
              | undefined;

            if (!codeRow) {
              throw new OAuthProtocolError(400, "invalid_grant", "Unknown authorization code.");
            }
          if (codeRow.client_id !== clientId || codeRow.redirect_uri !== redirectUri) {
            throw new OAuthProtocolError(400, "invalid_grant", "client_id or redirect_uri mismatch.");
          }
          if (codeRow.dpop_jkt !== dpop.jkt) {
            throw new OAuthProtocolError(400, "invalid_dpop_proof", "DPoP key thumbprint does not match PAR binding.");
          }
          const verifierHash = createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
          if (verifierHash !== codeRow.code_challenge) {
            throw new OAuthProtocolError(400, "invalid_grant", "PKCE code_verifier check failed.");
          }

          // Consumed-code replay cascades revocation across the code's entire session family ONLY after client/DPoP/PKCE proof!
          if (codeRow.consumed_at !== null) {
            this.revokeFamilySync(codeRow.family_id, codeRow.group_did, nowMs);
            return { replayRevoked: true as const };
          }
          if (codeRow.expires_at <= nowMs) {
            this.db.prepare("DELETE FROM oauth_code WHERE code_hash = ?").run(codeHash);
            throw new OAuthProtocolError(400, "invalid_grant", "Authorization code expired.");
          }
          if (
            this.db
              .prepare("SELECT 1 AS ok FROM source_migration_lease WHERE group_did = ? AND status = 'plc_signed'")
              .get(codeRow.group_did)
          ) {
            throw new OAuthProtocolError(400, "invalid_grant", "Group migration PLC cutover has been signed.");
          }

          const acct = this.db
            .prepare("SELECT auth_epoch, activated, takendown FROM group_account WHERE did = ?")
            .get(codeRow.group_did) as { auth_epoch: number; activated: number; takendown: number } | undefined;
          if (!acct || acct.takendown !== 0) {
            throw new OAuthProtocolError(400, "invalid_grant", "Group account unavailable.");
          }

          // Atomically mark code consumed & transition any `code_issued` creation journal to `completed`!
          this.db
            .prepare("UPDATE oauth_code SET consumed_at = ? WHERE code_hash = ?")
            .run(nowMs, codeHash);
          this.db
            .prepare(
              `UPDATE group_creation_journal
               SET status = 'completed', auth_code = NULL, updated_at = ?
               WHERE group_did = ? AND status = 'code_issued'`,
            )
            .run(nowMs, codeRow.group_did);

          const sessionId = randomUUID();
          const rawRefreshToken = `ghr_${randomBytes(32).toString("base64url")}`;
          const refreshHash = sha256HexBytes(rawRefreshToken);

          this.db
            .prepare(
              `INSERT INTO oauth_session (
                 session_id, family_id, group_did, authorizing_user_did, client_id, approved_scope,
                 dpop_jkt, session_kind, auth_epoch, authenticated_at, login_step_up_at, expires_at, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              sessionId,
              codeRow.family_id,
              codeRow.group_did,
              codeRow.authorizing_user_did,
              codeRow.client_id,
              codeRow.approved_scope,
              codeRow.dpop_jkt,
              codeRow.session_kind,
              acct.auth_epoch,
              codeRow.authenticated_at,
              codeRow.login_step_up_at,
              nowMs + REFRESH_TOKEN_TTL_MS,
              nowMs,
            );

          this.db
            .prepare(
              `INSERT INTO oauth_refresh_token (
                 token_hash, session_id, family_id, group_did, consumed_at, expires_at, created_at
               ) VALUES (?, ?, ?, ?, NULL, ?, ?)`,
            )
            .run(
              refreshHash,
              sessionId,
              codeRow.family_id,
              codeRow.group_did,
              nowMs + REFRESH_TOKEN_TTL_MS,
              nowMs,
            );

          return {
            replayRevoked: false as const,
            sessionId,
            familyId: codeRow.family_id,
            groupDid: codeRow.group_did,
            scope: codeRow.approved_scope,
            dpopJkt: codeRow.dpop_jkt,
            authEpoch: acct.auth_epoch,
            rawRefreshToken,
          };
        })
          .immediate(),
      );

      if (redeemed.replayRevoked) {
        throw new OAuthProtocolError(400, "invalid_grant", "Authorization code has already been consumed.");
      }

      const accessToken = await this.signOAuthAccessToken({
        groupDid: redeemed.groupDid,
        sessionId: redeemed.sessionId,
        familyId: redeemed.familyId,
        dpopJkt: redeemed.dpopJkt,
        authEpoch: redeemed.authEpoch,
        scope: redeemed.scope,
        nowMs,
      });

      return {
        dpopNonce: dpop.freshNonce,
        body: {
          access_token: accessToken,
          token_type: "DPoP",
          sub: redeemed.groupDid,
          scope: redeemed.scope,
          refresh_token: redeemed.rawRefreshToken,
          expires_in: ACCESS_TOKEN_TTL_SEC,
        },
      };
    }

    if (grantType === "refresh_token") {
      if (params.body.code_verifier !== undefined || params.body.code_challenge !== undefined) {
        throw new OAuthProtocolError(400, "invalid_request", "PKCE parameters must not be sent on refresh_token grant.");
      }
      const refreshToken = params.body.refresh_token;
      if (!refreshToken) {
        throw new OAuthProtocolError(400, "invalid_request", "refresh_token is required.");
      }
      const refreshHash = sha256HexBytes(refreshToken);
      const rtGroupPeek = this.db
        .prepare("SELECT group_did FROM oauth_refresh_token WHERE token_hash = ?")
        .get(refreshHash) as { group_did: string } | undefined;
      if (!rtGroupPeek) {
        throw new OAuthProtocolError(400, "invalid_grant", "Unknown refresh token.");
      }

      const rotated = await this.locks.withGroupRepoLock(rtGroupPeek.group_did, () =>
        this.db
          .transaction(() => {
            const rtRow = this.db
              .prepare("SELECT * FROM oauth_refresh_token WHERE token_hash = ?")
              .get(refreshHash) as
              | {
                  token_hash: string;
                  session_id: string;
                  family_id: string;
                  group_did: string;
                  consumed_at: number | null;
                  expires_at: number;
                }
              | undefined;

            if (!rtRow) {
              throw new OAuthProtocolError(400, "invalid_grant", "Unknown refresh token.");
            }

          const sess = this.db
            .prepare("SELECT * FROM oauth_session WHERE session_id = ?")
            .get(rtRow.session_id) as
            | {
                session_id: string;
                family_id: string;
                group_did: string;
                authorizing_user_did: string;
                client_id: string;
                approved_scope: string;
                dpop_jkt: string;
                session_kind: "group" | "recovery";
                auth_epoch: number;
                expires_at: number;
              }
            | undefined;

          if (!sess || sess.client_id !== clientId) {
            throw new OAuthProtocolError(400, "invalid_grant", "OAuth session no longer valid.");
          }
          if (sess.dpop_jkt !== dpop.jkt) {
            throw new OAuthProtocolError(400, "invalid_dpop_proof", "DPoP key thumbprint mismatch on refresh.");
          }

          // Rotated refresh-token replay cascades family revocation ONLY after client + DPoP key proof!
          if (rtRow.consumed_at !== null) {
            this.revokeFamilySync(rtRow.family_id, rtRow.group_did, nowMs);
            return { replayRevoked: true as const };
          }
          if (
            rtRow.expires_at <= nowMs ||
            sess.expires_at <= nowMs ||
            this.db.prepare("SELECT 1 AS ok FROM revoked_oauth_family WHERE family_id = ?").get(rtRow.family_id)
          ) {
            throw new OAuthProtocolError(400, "invalid_grant", "Refresh token expired or revoked.");
          }
          if (
            this.db
              .prepare("SELECT 1 AS ok FROM source_migration_lease WHERE group_did = ? AND status = 'plc_signed'")
              .get(sess.group_did)
          ) {
            throw new OAuthProtocolError(400, "invalid_grant", "Group migration PLC cutover has been signed.");
          }

          const acct = this.db
            .prepare("SELECT auth_epoch, takendown FROM group_account WHERE did = ?")
            .get(sess.group_did) as { auth_epoch: number; takendown: number } | undefined;
          if (!acct || acct.takendown !== 0 || acct.auth_epoch !== sess.auth_epoch) {
            throw new OAuthProtocolError(400, "invalid_grant", "Group account authorization epoch invalidated.");
          }

          this.db
            .prepare("UPDATE oauth_refresh_token SET consumed_at = ? WHERE token_hash = ?")
            .run(nowMs, refreshHash);

          const nextRawRefresh = `ghr_${randomBytes(32).toString("base64url")}`;
          const nextRefreshHash = sha256HexBytes(nextRawRefresh);
          const nextExpiresAt = nowMs + REFRESH_TOKEN_TTL_MS;

          this.db
            .prepare("UPDATE oauth_session SET expires_at = ? WHERE session_id = ?")
            .run(nextExpiresAt, sess.session_id);
          this.db
            .prepare(
              `INSERT INTO oauth_refresh_token (
                 token_hash, session_id, family_id, group_did, consumed_at, expires_at, created_at
               ) VALUES (?, ?, ?, ?, NULL, ?, ?)`,
            )
            .run(nextRefreshHash, sess.session_id, sess.family_id, sess.group_did, nextExpiresAt, nowMs);

          return {
            replayRevoked: false as const,
            sessionId: sess.session_id,
            familyId: sess.family_id,
            groupDid: sess.group_did,
            scope: sess.approved_scope,
            dpopJkt: sess.dpop_jkt,
            authEpoch: sess.auth_epoch,
            nextRawRefresh,
          };
        })
          .immediate(),
      );

      if (rotated.replayRevoked) {
        throw new OAuthProtocolError(400, "invalid_grant", "Refresh token replay detected; session family revoked.");
      }

      const accessToken = await this.signOAuthAccessToken({
        groupDid: rotated.groupDid,
        sessionId: rotated.sessionId,
        familyId: rotated.familyId,
        dpopJkt: rotated.dpopJkt,
        authEpoch: rotated.authEpoch,
        scope: rotated.scope,
        nowMs,
      });

      return {
        dpopNonce: dpop.freshNonce,
        body: {
          access_token: accessToken,
          token_type: "DPoP",
          sub: rotated.groupDid,
          scope: rotated.scope,
          refresh_token: rotated.nextRawRefresh,
          expires_in: ACCESS_TOKEN_TTL_SEC,
        },
      };
    }

    throw new OAuthProtocolError(400, "unsupported_grant_type", `Unsupported grant_type '${String(grantType)}'.`);
  }

  async handleRevoke(params: {
    dpopHeader: string | string[] | undefined;
    authorizationHeader: string | undefined;
    body: Record<string, string | undefined>;
    nowMs?: number;
  }): Promise<{ dpopNonce: string }> {
    const nowMs = params.nowMs ?? Date.now();
    if (params.authorizationHeader !== undefined) {
      throw new OAuthProtocolError(400, "invalid_request", "/oauth/revoke accepts body parameters only.");
    }
    if (params.body.code_verifier !== undefined || params.body.code_challenge !== undefined) {
      throw new OAuthProtocolError(400, "invalid_request", "PKCE parameters must not be sent to /oauth/revoke.");
    }

    const dpop = await this.verifyDpopProof({
      dpopHeader: params.dpopHeader,
      method: "POST",
      path: "/oauth/revoke",
      isAuthServer: true,
      nowMs,
    });

    const { clientId } = await this.verifyDownstreamClientAuth({
      body: params.body,
      endpointUrl: `${this.config.publicUrl}/oauth/revoke`,
      nowMs,
    });

    const token = params.body.token;
    if (token) {
      if (token.startsWith("ghr_")) {
        const hash = sha256HexBytes(token);
        const rt = this.db
          .prepare("SELECT session_id, family_id, group_did FROM oauth_refresh_token WHERE token_hash = ?")
          .get(hash) as { session_id: string; family_id: string; group_did: string } | undefined;
        if (rt) {
          await this.locks.withGroupRepoLock(rt.group_did, () => {
            this.db
              .transaction(() => {
                const sess = this.db
                  .prepare("SELECT client_id, dpop_jkt FROM oauth_session WHERE session_id = ?")
                  .get(rt.session_id) as { client_id: string; dpop_jkt: string } | undefined;
                if (sess) {
                  if (sess.client_id !== clientId) {
                    throw new OAuthProtocolError(400, "invalid_grant", "Token does not belong to the authenticated client.");
                  }
                  if (sess.dpop_jkt !== dpop.jkt) {
                    throw new OAuthProtocolError(400, "invalid_dpop_proof", "DPoP key thumbprint does not match token binding.");
                  }
                  this.revokeFamilySync(rt.family_id, rt.group_did, nowMs);
                }
              })
              .immediate();
          });
        }
      } else {
        let verifiedJwt: jose.JWTVerifyResult | undefined;
        try {
          const localJwks = jose.createLocalJWKSet({ keys: this.serviceKeys.publicJwks as unknown as jose.JWK[] });
          verifiedJwt = await jose.jwtVerify(token, localJwks, {
            typ: "at+jwt",
            algorithms: ["ES256"],
            issuer: this.config.publicUrl,
            audience: [this.config.publicUrl, groupHostPdsServiceEndpoint(this.config)],
            clockTolerance: 365 * 86_400,
            currentDate: new Date(nowMs),
          });
        } catch {
          // RFC 7009: invalid or unverifiable tokens are ignored with 200 OK
          verifiedJwt = undefined;
        }
        if (verifiedJwt) {
          const decoded = verifiedJwt.payload as {
            sid?: string;
            fid?: string;
            sub?: string;
            cnf?: { jkt?: string };
          };
          if (typeof decoded.sid === "string" && typeof decoded.fid === "string" && typeof decoded.sub === "string") {
            const sid = decoded.sid;
            const fid = decoded.fid;
            const sub = decoded.sub;
            await this.locks.withGroupRepoLock(sub, () => {
              this.db
                .transaction(() => {
                  const sess = this.db
                    .prepare("SELECT client_id, dpop_jkt, family_id, group_did FROM oauth_session WHERE session_id = ?")
                    .get(sid) as
                    | { client_id: string; dpop_jkt: string; family_id: string; group_did: string }
                    | undefined;
                  if (sess && sess.family_id === fid && sess.group_did === sub) {
                    if (sess.client_id !== clientId) {
                      throw new OAuthProtocolError(400, "invalid_grant", "Token does not belong to the authenticated client.");
                    }
                    if (sess.dpop_jkt !== dpop.jkt || decoded.cnf?.jkt !== dpop.jkt) {
                      throw new OAuthProtocolError(400, "invalid_dpop_proof", "DPoP key thumbprint does not match token binding.");
                    }
                    this.revokeFamilySync(sess.family_id, sess.group_did, nowMs);
                  }
                })
                .immediate();
            });
          }
        }
      }
    }

    return { dpopNonce: dpop.freshNonce };
  }

  // =========================================================================
  // `POST /group-admin/controller-session` (Sovereign PLC Rotation-Key Custody)
  // =========================================================================

  async handleControllerSession(params: {
    dpopHeader: string | string[] | undefined;
    authorizationHeader: string | undefined;
    groupDid: string;
    nowMs?: number;
  }): Promise<{
    dpopNonce: string;
    body: {
      access_token: string;
      token_type: "DPoP";
      sub: string;
      scope: string;
      refresh_token: string;
      expires_in: number;
    };
  }> {
    const nowMs = params.nowMs ?? Date.now();
    const nowSec = Math.floor(nowMs / 1000);

    const dpop = await this.verifyDpopProof({
      dpopHeader: params.dpopHeader,
      method: "POST",
      path: "/group-admin/controller-session",
      isAuthServer: false,
      nowMs,
    });

    if (!isDid(params.groupDid)) {
      throw new GroupHostHttpError(400, "InvalidRequest", "Invalid group DID.");
    }

    const rawJwt = extractBearerToken(params.authorizationHeader);
    if (!rawJwt) {
      throw new GroupHostHttpError(401, "AuthMissing", "Controller Bearer JWT required.");
    }

    const parsed = parseServiceJwtParts(rawJwt);
    if (
      parsed.header.typ !== "JWT" ||
      (parsed.header.alg !== "ES256" && parsed.header.alg !== "ES256K") ||
      parsed.payload.iss !== params.groupDid ||
      parsed.payload.aud !== this.config.serviceDid ||
      parsed.payload.lxm !== "com.atproto.server.createSession" ||
      typeof parsed.payload.jti !== "string" ||
      parsed.payload.jti.trim().length === 0
    ) {
      throw new GroupHostHttpError(401, "InvalidToken", "Invalid controller JWT claims.");
    }
    const iat = parsed.payload.iat;
    const exp = parsed.payload.exp;
    if (
      typeof iat !== "number" ||
      !Number.isFinite(iat) ||
      iat > nowSec + 5 ||
      typeof exp !== "number" ||
      !Number.isFinite(exp) ||
      exp <= nowSec ||
      exp - iat <= 0 ||
      exp - iat > 60
    ) {
      throw new GroupHostHttpError(401, "ExpiredToken", "Controller JWT expired or exceeds 60s lifetime.");
    }

    const signingDidKey = parsed.header.kid;
    if (!isSupportedPlcRotationDidKey(signingDidKey)) {
      throw new GroupHostHttpError(401, "InvalidToken", "Controller JWT header.kid must be a PLC rotation did:key.");
    }

    const doc = await this.plc.resolveDidDocument(params.groupDid);
    const lastOp = await this.plc.getPlcLastOp(params.groupDid);
    if (!doc || !lastOp || lastOp.type === "plc_tombstone") {
      throw new GroupHostHttpError(400, "UnresolvableDid", "Group DID unresolvable or tombstoned.");
    }
    if (this.plc.extractPdsEndpoint(doc) !== normalizeOriginUrl(this.config.publicUrl)) {
      throw new GroupHostHttpError(403, "Forbidden", "Group PLC #atproto_pds does not point to this host.");
    }

    const localRot = await this.repoStore.getGroupRotationKey(params.groupDid);
    if (!localRot || signingDidKey === localRot.did() || !plcOpRotationKeys(lastOp).includes(signingDidKey)) {
      throw new GroupHostHttpError(
        403,
        "Forbidden",
        "Controller JWT must be signed by an external sovereign PLC rotation key.",
      );
    }

    const validSig = await cryptoVerifySignatureWithKey(
      signingDidKey,
      parsed.signingInput,
      parsed.sigBytes,
      parsed.header.alg,
    ).catch(() => false);
    if (!validSig) {
      throw new GroupHostHttpError(401, "InvalidSignature", "Controller JWT signature invalid.");
    }

    const scope = groupAdminScopes(params.groupDid).join(" ");
    const sessionId = randomUUID();
    const familyId = randomUUID();
    const rawRefresh = `ghr_${randomBytes(32).toString("base64url")}`;
    const refreshHash = sha256HexBytes(rawRefresh);
    const jtiKey = `ctrl-jwt:${parsed.payload.jti}`;

    const minted = this.db
      .transaction(() => {
        const dup = this.db
          .prepare("SELECT 1 AS ok FROM service_jwt_jti WHERE issuer_did = ? AND jti = ?")
          .get(signingDidKey, jtiKey);
        if (dup) {
          throw new GroupHostHttpError(401, "ReplayDetected", "Controller JWT jti already used.");
        }
        this.db
          .prepare("INSERT INTO service_jwt_jti (issuer_did, jti, group_did, expires_at) VALUES (?, ?, ?, ?)")
          .run(signingDidKey, jtiKey, params.groupDid, Math.max(parsed.payload.exp * 1000, nowMs + 65_000));

        const acct = this.db
          .prepare("SELECT activated, takendown, auth_epoch FROM group_account WHERE did = ?")
          .get(params.groupDid) as { activated: number; takendown: number; auth_epoch: number } | undefined;
        if (!acct) throw new GroupHostHttpError(400, "RepoNotFound", "Group account not hosted here.");
        if (acct.takendown !== 0) throw new GroupHostHttpError(400, "RepoTakendown", "Group taken down.");

        const sessionKind: "group" | "recovery" = acct.activated === 0 ? "recovery" : "group";

        this.db
          .prepare(
            `INSERT INTO oauth_session (
               session_id, family_id, group_did, authorizing_user_did, client_id, approved_scope,
               dpop_jkt, session_kind, auth_epoch, authenticated_at, login_step_up_at, expires_at, created_at
             ) VALUES (?, ?, ?, ?, 'urn:opensocial:controller-session', ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            sessionId,
            familyId,
            params.groupDid,
            params.groupDid,
            scope,
            dpop.jkt,
            sessionKind,
            acct.auth_epoch,
            nowMs,
            nowMs,
            nowMs + REFRESH_TOKEN_TTL_MS,
            nowMs,
          );

        this.db
          .prepare(
            `INSERT INTO oauth_refresh_token (
               token_hash, session_id, family_id, group_did, consumed_at, expires_at, created_at
             ) VALUES (?, ?, ?, ?, NULL, ?, ?)`,
          )
          .run(refreshHash, sessionId, familyId, params.groupDid, nowMs + REFRESH_TOKEN_TTL_MS, nowMs);

        return { authEpoch: acct.auth_epoch };
      })
      .immediate();

    const accessToken = await this.signOAuthAccessToken({
      groupDid: params.groupDid,
      sessionId,
      familyId,
      dpopJkt: dpop.jkt,
      authEpoch: minted.authEpoch,
      scope,
      nowMs,
    });

    return {
      dpopNonce: dpop.freshNonce,
      body: {
        access_token: accessToken,
        token_type: "DPoP",
        sub: params.groupDid,
        scope,
        refresh_token: rawRefresh,
        expires_in: ACCESS_TOKEN_TTL_SEC,
      },
    };
  }

  // =========================================================================
  // Resource Route DPoP Access-Token Verifier + Live Role Narrowing
  // =========================================================================

  async authenticateGroupDpopRequest(params: {
    authorizationHeader: string | undefined;
    dpopHeader: string | string[] | undefined;
    method: string;
    path: string;
    xrpcMethod?: string;
    allowDeactivatedRecovery?: boolean;
    nowMs?: number;
  }): Promise<AuthenticatedGroupSession> {
    const nowMs = params.nowMs ?? Date.now();
    if (!params.authorizationHeader || !params.authorizationHeader.startsWith("DPoP ")) {
      throw new OAuthProtocolError(
        401,
        "invalid_token",
        "DPoP access token required.",
        'DPoP algs="ES256"',
      );
    }
    const accessToken = params.authorizationHeader.slice("DPoP ".length).trim();

    const dpop = await this.verifyDpopProof({
      dpopHeader: params.dpopHeader,
      method: params.method,
      path: params.path,
      isAuthServer: false,
      expectedAccessToken: accessToken,
      nowMs,
    });

    let verifiedJwt: jose.JWTVerifyResult;
    try {
      const localJwks = jose.createLocalJWKSet({ keys: this.serviceKeys.publicJwks as unknown as jose.JWK[] });
      verifiedJwt = await jose.jwtVerify(accessToken, localJwks, {
        typ: "at+jwt",
        algorithms: ["ES256"],
        issuer: this.config.publicUrl,
        audience: [this.config.publicUrl, groupHostPdsServiceEndpoint(this.config)],
        clockTolerance: 0,
      });
    } catch (err) {
      throw new OAuthProtocolError(
        401,
        "invalid_token",
        err instanceof Error ? err.message : "Invalid or expired access token.",
        'DPoP algs="ES256", error="invalid_token"',
      );
    }

    const payload = verifiedJwt.payload as {
      sub?: string;
      sid?: string;
      fid?: string;
      epoch?: number;
      cnf?: { jkt?: string };
    };
    if (
      typeof payload.sub !== "string" ||
      typeof payload.sid !== "string" ||
      typeof payload.fid !== "string" ||
      typeof payload.epoch !== "number" ||
      payload.cnf?.jkt !== dpop.jkt
    ) {
      throw new OAuthProtocolError(
        401,
        "invalid_token",
        "Malformed access token binding claims.",
        'DPoP algs="ES256", error="invalid_token"',
      );
    }

    const sess = this.db
      .prepare("SELECT * FROM oauth_session WHERE session_id = ?")
      .get(payload.sid) as
      | {
          session_id: string;
          family_id: string;
          group_did: string;
          authorizing_user_did: string;
          client_id: string;
          approved_scope: string;
          dpop_jkt: string;
          session_kind: "group" | "recovery";
          auth_epoch: number;
          authenticated_at: number;
          login_step_up_at: number | null;
          expires_at: number;
        }
      | undefined;

    if (
      !sess ||
      sess.expires_at <= nowMs ||
      sess.group_did !== payload.sub ||
      sess.dpop_jkt !== dpop.jkt ||
      this.db.prepare("SELECT 1 AS ok FROM revoked_oauth_family WHERE family_id = ?").get(sess.family_id)
    ) {
      throw new OAuthProtocolError(
        401,
        "invalid_token",
        "OAuth session expired or revoked.",
        'DPoP algs="ES256", error="invalid_token"',
      );
    }

    const acct = this.db
      .prepare("SELECT activated, takendown, auth_epoch FROM group_account WHERE did = ?")
      .get(sess.group_did) as { activated: number; takendown: number; auth_epoch: number } | undefined;
    if (!acct) {
      throw new GroupHostHttpError(400, "RepoNotFound", "Group not hosted here.");
    }
    if (acct.takendown !== 0 || this.db.prepare("SELECT 1 AS ok FROM group_deletion_journal WHERE group_did = ?").get(sess.group_did)) {
      // Do NOT emit WWW-Authenticate invalid_token on account suspension/takedown (matches authorityOAuthFetch)!
      throw new GroupHostHttpError(401, "AccountTakedown", "Group account is taken down.");
    }
    if (acct.auth_epoch !== payload.epoch || acct.auth_epoch !== sess.auth_epoch) {
      throw new OAuthProtocolError(
        401,
        "invalid_token",
        "Authorization epoch invalidated.",
        'DPoP algs="ES256", error="invalid_token"',
      );
    }

    // Enforce strict 8-route recovery allowlist when `session_kind === 'recovery'`!
    if (sess.session_kind === "recovery") {
      const allowedXrpc = params.xrpcMethod !== undefined && RECOVERY_ALLOWED_XRPC_METHODS.has(params.xrpcMethod);
      const allowedAdminClaim = params.path === "/group-admin/claim-action-token";
      if (!allowedXrpc && !allowedAdminClaim) {
        throw new GroupHostHttpError(
          403,
          "Forbidden",
          "Recovery OAuth sessions are restricted strictly to recovery/export/deletion endpoints.",
        );
      }
    }

    if (acct.activated === 0 && !params.allowDeactivatedRecovery && sess.session_kind !== "recovery") {
      throw new GroupHostHttpError(401, "AccountDeactivated", "Group account is currently deactivated.");
    }

    // Live role narrowing: intersect `sessionPerms` with live `effectiveMemberPermissions`!
    const liveState = loadLiveGovernanceState(this.db, sess.group_did);
    const recRow = this.db
      .prepare("SELECT * FROM group_recovery_admin WHERE group_did = ?")
      .get(sess.group_did) as RecoveryAdminRow | undefined;
    const effState = effectiveStateForSession(
      liveState,
      { sessionKind: sess.session_kind, authorizingUserDid: sess.authorizing_user_did },
      recRow,
    );

    const sessionPerms = expandGroupScopes(sess.approved_scope.split(/\s+/).filter(Boolean), sess.group_did);
    const livePerms = effectiveMemberPermissions(effState, sess.group_did, sess.authorizing_user_did);

    return {
      kind: "oauth",
      sessionId: sess.session_id,
      familyId: sess.family_id,
      groupDid: sess.group_did,
      authorizingUserDid: sess.authorizing_user_did,
      clientId: sess.client_id,
      sessionKind: sess.session_kind,
      authenticatedAt: sess.authenticated_at,
      loginStepUpAt: sess.login_step_up_at,
      authEpoch: acct.auth_epoch,
      dpopNonce: dpop.freshNonce,
      permissions: new EffectiveSessionPermissions(sessionPerms, livePerms),
    };
  }
}

export { RepoCommit };
