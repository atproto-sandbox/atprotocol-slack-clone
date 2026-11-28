import { randomBytes } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { decode as cborDecode } from "@atproto/lex-cbor";
import { COMMIT_MAC_PROFILE, LtHash, RECORD_MAC_PROFILE, RepoCommit, spaceHostAud } from "@atproto/space";
import {
  isAtUriString,
  type DidString,
  type NsidString,
  type RecordKeyString,
  type SpaceRefString,
} from "@atproto/syntax";
import { cryptoVerifySignatureWithKey } from "@atproto/xrpc-server";
import { isDid, parseSpaceUri } from "@flock/protocol/keys";
import { lexicons as protocolLexicons } from "@flock/protocol/lexicons/api/lexicons";
import { ATGRP_COLLECTION, ATGRP_METHOD, ATGRP_SPACE_TYPE } from "@flock/protocol/nsids";
import { InvalidScopeError, InvalidSpacePolicyScopeError } from "@flock/protocol/scopes";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import {
  groupHostPdsServiceEndpoint,
  isLoopbackHostname,
  loadGroupHostConfig,
  normalizeGroupHostPublicUrl,
  parseGroupHostPortEnv,
  type GroupHostConfig,
} from "./config";
import { GroupHostCryptoBox, lexDataToPlainJson as lexToJson, sha256HexBytes } from "./crypto-box";
import { openGroupHostDb, pruneExpiredHostState, type GroupHostDb } from "./db";
import {
  extractBearerToken,
  GroupOpenSocialMethods,
  parseServiceJwtParts,
  verifyPersonalServiceJwt,
} from "./methods";
import { GroupMigrationService, type AuthenticatedMigrationSession } from "./migration";
import {
  executeQueryModSubjects,
  executeQuerySelfHistory,
  executeQuerySubjectHistory,
  executeSubmitAppealSync,
  executeSubmitReportSync,
  executeUpdateModSubjectSync,
} from "./moderation";
import {
  GroupHostOAuthService,
  OAuthProtocolError,
  revalidateLiveOAuthSessionSync,
  type AuthenticatedGroupSession,
} from "./oauth";
import { GroupHostHttpError, PlcAndDidResolver } from "./plc";
import {
  GroupRepoLockManager,
  hasActiveSourceMigrationLease,
  reapExpiredPreparedMigrationLease,
} from "./rbac";
import { GroupRepoStore } from "./repo-store";

export type RunningGroupHost = {
  app: Express;
  server: HttpServer;
  url: string;
  port: number;
  config: GroupHostConfig;
  db: GroupHostDb;
  cryptoBox: GroupHostCryptoBox;
  plc: PlcAndDidResolver;
  locks: GroupRepoLockManager;
  repoStore: GroupRepoStore;
  methods: GroupOpenSocialMethods;
  oauth: GroupHostOAuthService;
  migration: GroupMigrationService;
  flushBackgroundWork(): Promise<void>;
  close(): Promise<void>;
};

const XRPC_AND_ADMIN_ALLOW_HEADERS =
  "authorization, dpop, content-type, accept, accept-signature, atproto-space-audience, signature, signature-input, idempotency-key, if-match-membership-incarnation, if-join-request-present, x-group-migration-ticket, x-group-migration-secret, x-group-migration-key-provenance, x-group-migration-operation-id";

const XRPC_AND_ADMIN_EXPOSE_HEADERS =
  "dpop-nonce, www-authenticate, atproto-space-commit, atproto-space-record, atproto-membership-incarnation, signature, signature-input";

const OAUTH_JSON_ROUTES = new Set([
  "/oauth/par",
  "/oauth/token",
  "/oauth/revoke",
  "/oauth/jwks.json",
  "/oauth/client-metadata.json",
]);

const COOKIE_NAV_ROUTES = new Set([
  "/oauth/authorize",
  "/oauth/upstream-callback",
  "/oauth/confirm-action",
]);

function buildOAuthCspHeader(allowLoopback: boolean): string {
  const formAction = allowLoopback
    ? "form-action 'self' https: http:"
    : "form-action 'self' https:";
  return `default-src 'none'; style-src 'unsafe-inline'; ${formAction}; frame-ancestors 'none'; base-uri 'none'`;
}

function singleQueryString(req: Request, key: string): string | undefined {
  const v = req.query[key];
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return undefined;
}

function queryInt(req: Request, key: string): number | undefined {
  const raw = req.query[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !/^-?\d+$/.test(raw)) {
    throw new GroupHostHttpError(400, "InvalidRequest", `Query parameter '${key}' must be an integer.`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) {
    throw new GroupHostHttpError(400, "InvalidRequest", `Query parameter '${key}' must be an integer.`);
  }
  return n;
}

const DUMMY_VALID_AT_URI = "at://did:plc:abcdefghijklmnopqrstuvwx/app.bsky.feed.post/3jzfcijpj2z2a";

const MOD_SUBMISSION_RATE_WINDOW_MS = 5 * 60_000;
const MOD_SUBMISSION_RATE_MAX = 60;
const MOD_SUBMISSION_RATE_MAX_ACTORS = 4_096;

function createModSubmissionRateLimiter(): (actorDid: string, nowMs?: number) => void {
  const buckets = new Map<string, { windowStartMs: number; count: number }>();
  return (actorDid: string, nowMs = Date.now()) => {
    const existing = buckets.get(actorDid);
    if (!existing || nowMs - existing.windowStartMs >= MOD_SUBMISSION_RATE_WINDOW_MS) {
      if (buckets.size >= MOD_SUBMISSION_RATE_MAX_ACTORS) {
        const oldestKey = buckets.keys().next().value;
        if (oldestKey !== undefined) buckets.delete(oldestKey);
      }
      buckets.set(actorDid, { windowStartMs: nowMs, count: 1 });
      return;
    }
    if (existing.count >= MOD_SUBMISSION_RATE_MAX) {
      throw new GroupHostHttpError(429, "RateLimitExceeded", "Moderation submission rate limit exceeded.");
    }
    existing.count += 1;
  };
}

function assertAtgrpXrpcParams(
  nsid: string,
  req: Request,
  options: {
    intKeys?: readonly string[];
    arrayKeys?: readonly string[];
    preserveSubjectSemanticError?: boolean;
  } = {},
): Record<string, unknown> {
  const intKeys = new Set(options.intKeys ?? []);
  const arrayKeys = new Set(options.arrayKeys ?? []);
  const rawOut: Record<string, unknown> = {};
  const checkOut: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(req.query)) {
    if (v === undefined) continue;
    if (arrayKeys.has(k)) {
      let arr: string[];
      if (typeof v === "string") {
        arr = [v];
      } else if (Array.isArray(v) && v.every((item): item is string => typeof item === "string")) {
        arr = v;
      } else {
        throw new GroupHostHttpError(
          400,
          "InvalidRequest",
          `Query parameter '${k}' must be a string or array of strings.`,
        );
      }
      rawOut[k] = arr;
      checkOut[k] = arr;
      continue;
    }
    if (typeof v !== "string") {
      throw new GroupHostHttpError(400, "InvalidRequest", `Query parameter '${k}' must be a single string.`);
    }
    if (intKeys.has(k)) {
      if (!/^-?\d+$/.test(v)) {
        throw new GroupHostHttpError(400, "InvalidRequest", `Query parameter '${k}' must be an integer.`);
      }
      const n = Number(v);
      if (!Number.isSafeInteger(n)) {
        throw new GroupHostHttpError(400, "InvalidRequest", `Query parameter '${k}' must be an integer.`);
      }
      rawOut[k] = n;
      checkOut[k] = n;
    } else {
      rawOut[k] = v;
      checkOut[k] =
        options.preserveSubjectSemanticError && k === "subject" && v.length > 0 && v.length <= 4096
          ? DUMMY_VALID_AT_URI
          : v;
    }
  }
  try {
    protocolLexicons.assertValidXrpcParams(nsid, checkOut);
  } catch (err) {
    throw new GroupHostHttpError(
      400,
      "InvalidRequest",
      err instanceof Error ? err.message : "Invalid XRPC query parameters.",
    );
  }
  return rawOut;
}

function assertAtgrpXrpcInput(
  nsid: string,
  body: unknown,
  options: { preserveInviteSemanticError?: boolean; preserveSubjectSemanticError?: boolean } = {},
): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new GroupHostHttpError(400, "InvalidRequest", "Request body must be a JSON object.");
  }
  const rawBody = body as Record<string, unknown>;
  const checkBody: Record<string, unknown> = { ...rawBody };
  if (
    options.preserveInviteSemanticError &&
    typeof rawBody.invite === "string" &&
    rawBody.invite.length > 0 &&
    rawBody.invite.length <= 4096
  ) {
    checkBody.invite = DUMMY_VALID_AT_URI;
  }
  if (
    options.preserveSubjectSemanticError &&
    typeof rawBody.subject === "string" &&
    rawBody.subject.length > 0 &&
    rawBody.subject.length <= 4096
  ) {
    checkBody.subject = DUMMY_VALID_AT_URI;
  }
  try {
    protocolLexicons.assertValidXrpcInput(nsid, checkBody);
  } catch (err) {
    throw new GroupHostHttpError(
      400,
      "InvalidRequest",
      err instanceof Error ? err.message : "Invalid XRPC input body.",
    );
  }
  return rawBody;
}

function flatStringRecord(obj: unknown): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  if (!obj || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
  }
  return out;
}

function asyncHandler(fn: (req: Request, res: Response) => Promise<void> | void) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

export async function createGroupHostServices(configOverrides: Partial<GroupHostConfig> = {}) {
  const config = loadGroupHostConfig(configOverrides);
  const db = openGroupHostDb(config.databasePath);
  const cryptoBox = new GroupHostCryptoBox(config.encryptionKeyHex);
  const serviceKeys = await cryptoBox.deriveServiceSigningMaterial(config.serviceDid, config.servicePrivateJwks);
  const plc = new PlcAndDidResolver(config);
  const locks = new GroupRepoLockManager();
  const repoStore = new GroupRepoStore(db, config, cryptoBox, plc, locks);
  const methods = new GroupOpenSocialMethods(db, cryptoBox, plc, locks, repoStore);
  const oauth = new GroupHostOAuthService(db, config, cryptoBox, serviceKeys, plc, locks, repoStore);
  const migration = new GroupMigrationService(db, config, cryptoBox, serviceKeys, plc, locks, repoStore);

  return {
    config,
    db,
    cryptoBox,
    serviceKeys,
    plc,
    locks,
    repoStore,
    methods,
    oauth,
    migration,
  };
}

export async function createGroupHostApp(services: Awaited<ReturnType<typeof createGroupHostServices>>): Promise<Express> {
  const { config, db, cryptoBox, plc, repoStore, methods, oauth, migration } = services;
  const app = express();
  app.disable("x-powered-by");

  const oauthCspHeader = buildOAuthCspHeader(config.allowLoopback);

  // 1. CORS & CSP Middleware (`Rev 29:176`)
  app.use((req, res, next) => {
    if (COOKIE_NAV_ROUTES.has(req.path)) {
      res.setHeader("Content-Security-Policy", oauthCspHeader);
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("X-Content-Type-Options", "nosniff");
      return next();
    }

    if (
      req.path.startsWith("/xrpc/") ||
      req.path.startsWith("/group-admin/") ||
      req.path.startsWith("/group-member/")
    ) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", XRPC_AND_ADMIN_ALLOW_HEADERS);
      res.setHeader("Access-Control-Expose-Headers", XRPC_AND_ADMIN_EXPOSE_HEADERS);
      res.setHeader("Access-Control-Max-Age", "600");
      if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
      }
      return next();
    }

    if (req.path.startsWith("/.well-known/") || OAUTH_JSON_ROUTES.has(req.path)) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "authorization, dpop, content-type, accept");
      res.setHeader("Access-Control-Expose-Headers", "dpop-nonce, www-authenticate");
      res.setHeader("Access-Control-Max-Age", "600");
      if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
      }
    }

    next();
  });

  const json1Mb = express.json({ limit: 1_000_000 });
  const formParser = express.urlencoded({ extended: false, limit: 100_000 });
  const oauthBodyParser = [express.json({ limit: 100_000 }), formParser];

  const attachDpopNonce = (res: Response, auth: { kind: string; dpopNonce?: string }) => {
    if (auth.kind === "oauth" && auth.dpopNonce) {
      res.setHeader("DPoP-Nonce", auth.dpopNonce);
    }
  };

  const authGroupDpop = async (
    req: Request,
    res: Response,
    xrpcMethod?: string,
    allowDeactivatedRecovery = false,
  ): Promise<AuthenticatedGroupSession> => {
    const sess = await oauth.authenticateGroupDpopRequest({
      authorizationHeader: req.headers.authorization,
      dpopHeader: req.headers.dpop,
      method: req.method,
      path: req.path,
      xrpcMethod,
      allowDeactivatedRecovery,
    });
    res.setHeader("DPoP-Nonce", sess.dpopNonce);
    return sess;
  };

  const authGroupOrMigration = async (
    req: Request,
    res: Response,
    xrpcMethod: string,
    allowDeactivatedRecovery = false,
  ): Promise<AuthenticatedGroupSession | AuthenticatedMigrationSession> => {
    const authHeader = req.headers.authorization ?? "";
    if (authHeader.startsWith("Bearer ")) {
      return migration.authenticateMigrationBearer(authHeader, false);
    }
    return authGroupDpop(req, res, xrpcMethod, allowDeactivatedRecovery);
  };

  // =========================================================================
  // Health & `.well-known/*`
  // =========================================================================

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, did: config.serviceDid });
  });

  app.get("/.well-known/did.json", (_req, res) => {
    res.setHeader("Content-Type", "application/did+ld+json; charset=utf-8");
    res.send(JSON.stringify(migration.getDidDocument()));
  });

  const requestVerifyOrigin = (req: Request): string => {
    const host = typeof req.headers.host === "string" ? req.headers.host : undefined;
    if (config.allowLoopback && host?.toLowerCase() === `localhost:${config.port}`) {
      return groupHostPdsServiceEndpoint(config);
    }
    return config.publicUrl;
  };

  app.get("/.well-known/oauth-protected-resource", (req, res) => {
    res.json(oauth.getProtectedResourceMetadata(typeof req.headers.host === "string" ? req.headers.host : undefined));
  });

  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json(oauth.getAuthorizationServerMetadata());
  });

  // =========================================================================
  // `/oauth/*`
  // =========================================================================

  app.get("/oauth/jwks.json", (_req, res) => {
    res.setHeader("Content-Type", "application/jwk-set+json; charset=utf-8");
    res.send(JSON.stringify(oauth.getPublicJwks()));
  });

  app.get("/oauth/client-metadata.json", (_req, res) => {
    res.json(oauth.getUpstreamClientMetadata());
  });

  app.post(
    "/oauth/par",
    ...oauthBodyParser,
    asyncHandler(async (req, res) => {
      const out = await oauth.handlePar({
        dpopHeader: req.headers.dpop,
        body: flatStringRecord(req.body),
      });
      res.setHeader("DPoP-Nonce", out.dpopNonce);
      res.setHeader("Cache-Control", "no-store");
      res.status(out.status).json(out.body);
    }),
  );

  app.get(
    "/oauth/authorize",
    asyncHandler(async (req, res) => {
      const out = await oauth.handleAuthorizeGet({
        query: flatStringRecord(req.query),
      });
      if (out.kind === "redirect") {
        res.setHeader("Set-Cookie", out.setCookie);
        res.redirect(303, out.location);
        return;
      }
      res.status(out.status).type("html").send(out.html);
    }),
  );

  app.post(
    "/oauth/authorize",
    formParser,
    asyncHandler(async (req, res) => {
      const out = await oauth.handleAuthorizePost({
        body: flatStringRecord(req.body),
      });
      if (out.setCookie) {
        res.setHeader("Set-Cookie", out.setCookie);
      }
      res.redirect(303, out.location);
    }),
  );

  // Express maps `app.get` to `HEAD` automatically unless intercepted first (`Rev 29:211`: 405 on HEAD)!
  app.use("/oauth/upstream-callback", (req, res, next) => {
    if (req.method === "HEAD") {
      res.setHeader("Allow", "GET");
      res.status(405).end();
      return;
    }
    next();
  });

  app.get(
    "/oauth/upstream-callback",
    asyncHandler(async (req, res) => {
      const rawUrl = new URL(req.originalUrl, config.publicUrl);
      const out = await oauth.handleUpstreamCallback({
        queryParams: rawUrl.searchParams,
        cookieHeader: req.headers.cookie,
      });
      res.setHeader("Set-Cookie", out.setCookies);
      res.redirect(303, out.location);
    }),
  );

  app.get(
    "/oauth/confirm-action",
    asyncHandler(async (req, res) => {
      const out = oauth.handleConfirmActionGet({
        cookieHeader: req.headers.cookie,
        consentId: singleQueryString(req, "consent"),
      });
      res.status(out.status).type("html").send(out.html);
    }),
  );

  app.post(
    "/oauth/confirm-action",
    formParser,
    asyncHandler(async (req, res) => {
      const out = await oauth.handleConfirmActionPost({
        cookieHeader: req.headers.cookie,
        consentId: singleQueryString(req, "consent"),
        body: flatStringRecord(req.body),
      });
      res.setHeader("Set-Cookie", out.clearCookie);
      res.redirect(303, out.location);
    }),
  );

  app.post(
    "/oauth/token",
    ...oauthBodyParser,
    asyncHandler(async (req, res) => {
      const out = await oauth.handleToken({
        dpopHeader: req.headers.dpop,
        authorizationHeader: req.headers.authorization,
        body: flatStringRecord(req.body),
      });
      res.setHeader("DPoP-Nonce", out.dpopNonce);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Pragma", "no-cache");
      res.json(out.body);
    }),
  );

  app.post(
    "/oauth/revoke",
    ...oauthBodyParser,
    asyncHandler(async (req, res) => {
      const out = await oauth.handleRevoke({
        dpopHeader: req.headers.dpop,
        authorizationHeader: req.headers.authorization,
        body: flatStringRecord(req.body),
      });
      res.setHeader("DPoP-Nonce", out.dpopNonce);
      res.status(200).json({});
    }),
  );

  // =========================================================================
  // `/group-admin/*` & `/group-member/*`
  // =========================================================================

  app.get(
    "/group-admin/migration-info",
    asyncHandler(async (_req, res) => {
      res.json(await migration.getMigrationInfo());
    }),
  );

  app.get(
    "/group-admin/public-group-keys",
    asyncHandler(async (req, res) => {
      const group = singleQueryString(req, "group");
      if (!group) throw new GroupHostHttpError(400, "InvalidRequest", "group query parameter required.");
      const operationId = singleQueryString(req, "operationId");
      res.json(await migration.getPublicGroupKeys(group, Date.now(), operationId));
    }),
  );

  app.get(
    "/group-admin/migration-manifest",
    asyncHandler(async (req, res) => {
      const group = singleQueryString(req, "group") ?? "";
      const ticketId = singleQueryString(req, "ticketId") ?? "";
      const secretHeader =
        typeof req.headers["x-group-migration-secret"] === "string"
          ? req.headers["x-group-migration-secret"]
          : undefined;
      const body = await migration.getMigrationManifest({
        authorizationHeader: req.headers.authorization,
        secretHeader,
        groupDid: group,
        ticketId,
      });
      res.json(body);
    }),
  );

  app.get(
    "/group-admin/migration-attestation",
    asyncHandler(async (req, res) => {
      const group = singleQueryString(req, "group") ?? "";
      const operationId = singleQueryString(req, "operationId") ?? "";
      const ticketId = singleQueryString(req, "ticketId") ?? "";
      const body = await migration.getMigrationAttestation({
        authorizationHeader: req.headers.authorization,
        groupDid: group,
        operationId,
        ticketId,
      });
      res.json(body);
    }),
  );

  app.post(
    "/group-admin/prepare-migration",
    json1Mb,
    asyncHandler(async (req, res) => {
      const session = await authGroupDpop(req, res);
      const { group, operationId, targetEndpoint, mode } = (req.body ?? {}) as {
        group?: string;
        operationId?: string;
        targetEndpoint?: string;
        mode?: string;
      };
      if (!group || !operationId || !targetEndpoint) {
        throw new GroupHostHttpError(400, "InvalidRequest", "group, operationId, and targetEndpoint are required.");
      }
      if (mode !== undefined && mode !== "auto" && mode !== "coordinated" && mode !== "standard") {
        throw new GroupHostHttpError(400, "InvalidRequest", "mode must be 'auto', 'coordinated', or 'standard'.");
      }
      const out = await migration.prepareMigration({
        session,
        groupDid: group,
        operationId,
        targetEndpoint,
        ...(mode !== undefined ? { requestedMode: mode } : {}),
      });
      res.json(out);
    }),
  );

  app.post(
    "/group-admin/abort-migration",
    json1Mb,
    asyncHandler(async (req, res) => {
      const { group, operationId, ticketId, leaseAttemptId, deadlineAtMs } = (req.body ?? {}) as {
        group?: unknown;
        operationId?: unknown;
        ticketId?: unknown;
        leaseAttemptId?: unknown;
        deadlineAtMs?: unknown;
      };
      if (typeof group !== "string" || !isDid(group)) {
        throw new GroupHostHttpError(400, "InvalidRequest", "group DID is required.");
      }
      const authHeader = req.headers.authorization ?? "";
      if (authHeader.startsWith("Bearer ")) {
        const out = await migration.abortMigrationOnTarget({
          authorizationHeader: authHeader,
          groupDid: group,
          operationId,
          ticketId,
          leaseAttemptId,
          deadlineAtMs,
        });
        res.json(out);
        return;
      }
      const session = await authGroupDpop(req, res);
      if (operationId !== undefined && typeof operationId !== "string") {
        throw new GroupHostHttpError(400, "InvalidRequest", "operationId must be a string.");
      }
      const out = await migration.abortMigrationOnSource({
        session,
        groupDid: group,
        operationId,
      });
      res.json(out);
    }),
  );

  app.post(
    "/group-admin/finalize-migrated-source",
    json1Mb,
    asyncHandler(async (req, res) => {
      const { group, operationId } = (req.body ?? {}) as { group?: string; operationId?: string };
      if (!group) throw new GroupHostHttpError(400, "InvalidRequest", "group DID is required.");
      const out = await migration.finalizeMigratedSource({
        authorizationHeader: req.headers.authorization,
        groupDid: group,
        operationId,
      });
      res.json(out);
    }),
  );

  app.post(
    "/group-admin/claim-action-token",
    json1Mb,
    asyncHandler(async (req, res) => {
      const session = await authGroupDpop(req, res, undefined, true);
      const { group, purpose } = (req.body ?? {}) as {
        group?: string;
        purpose?: "plc_operation" | "delete_account";
      };
      if (!group || group !== session.groupDid) {
        throw new GroupHostHttpError(403, "Forbidden", "Session subject does not match group.");
      }
      if (purpose !== "plc_operation" && purpose !== "delete_account") {
        throw new GroupHostHttpError(400, "InvalidRequest", "purpose must be 'plc_operation' or 'delete_account'.");
      }
      if (purpose === "plc_operation") {
        session.permissions.assertIdentity({ attr: "*" });
      } else {
        session.permissions.assertAccount({ attr: "status", action: "manage" });
      }
      const out = await methods.executeClaimActionToken({
        groupDid: group,
        actorDid: session.authorizingUserDid,
        purpose,
        session,
      });
      res.json(out);
    }),
  );

  app.post(
    "/group-admin/controller-session",
    json1Mb,
    asyncHandler(async (req, res) => {
      const { group } = (req.body ?? {}) as { group?: string };
      if (!group) throw new GroupHostHttpError(400, "InvalidRequest", "group DID is required.");
      const out = await oauth.handleControllerSession({
        dpopHeader: req.headers.dpop,
        authorizationHeader: req.headers.authorization,
        groupDid: group,
      });
      res.setHeader("DPoP-Nonce", out.dpopNonce);
      res.setHeader("Cache-Control", "no-store");
      res.json(out.body);
    }),
  );

  app.get(
    "/group-admin/invite-deliveries",
    asyncHandler(async (req, res) => {
      const session = await authGroupDpop(req, res);
      const group = singleQueryString(req, "group") ?? session.groupDid;
      if (group !== session.groupDid) {
        throw new GroupHostHttpError(403, "Forbidden", "Session subject mismatch.");
      }
      const migRow = db.prepare("SELECT status FROM source_migration_lease WHERE group_did = ?").get(group) as
        | { status: string }
        | undefined;
      if (migRow?.status === "plc_signed") {
        throw new GroupHostHttpError(409, "MigrationCutoverPending", "Group cutover pending.");
      }
      session.permissions.assertSpace(
        {
          spaceType: ATGRP_SPACE_TYPE.inbox as NsidString,
          authority: "*",
          skey: "self" as RecordKeyString,
        },
        { action: "read_self" },
      );
      res.json(methods.executeListInviteDeliveries(group));
    }),
  );

  app.post(
    "/group-admin/retry-invite-delivery",
    json1Mb,
    asyncHandler(async (req, res) => {
      const session = await authGroupDpop(req, res);
      const { group, inviteUri } = (req.body ?? {}) as { group?: string; inviteUri?: string };
      const targetGroup = group ?? session.groupDid;
      if (targetGroup !== session.groupDid) {
        throw new GroupHostHttpError(403, "Forbidden", "Session subject mismatch.");
      }
      if (!inviteUri) {
        throw new GroupHostHttpError(400, "InvalidRequest", "inviteUri is required.");
      }
      session.permissions.assertSpace(
        {
          spaceType: ATGRP_SPACE_TYPE.inbox as NsidString,
          authority: "*",
          skey: "self" as RecordKeyString,
        },
        { action: "update", collection: ATGRP_COLLECTION.invite as NsidString },
      );
      const out = await methods.executeRetryInviteDelivery({
        groupDid: targetGroup,
        inviteUri,
        session,
      });
      res.json(out);
    }),
  );

  app.get(
    "/group-member/join-status",
    asyncHandler(async (req, res) => {
      const group = singleQueryString(req, "group");
      if (!group || !isDid(group)) {
        throw new GroupHostHttpError(400, "InvalidRequest", "group DID query parameter is required.");
      }
      const operationId = singleQueryString(req, "operationId");
      const jwt = await verifyPersonalServiceJwt({
        db,
        cryptoBox,
        plc,
        authorization: req.headers.authorization,
        groupDid: group,
        expectedLxm: ATGRP_METHOD.requestJoin,
      });
      const out = methods.executeGetJoinStatus({
        callerDid: jwt.iss,
        groupDid: group,
        operationId,
      });
      res.json(out);
    }),
  );

  // =========================================================================
  // `/xrpc/com.atproto.server.*` & `/xrpc/com.atproto.identity.*`
  // =========================================================================

  app.get("/xrpc/com.atproto.server.describeServer", (_req, res) => {
    res.json(migration.describeServer());
  });

  app.get(
    "/xrpc/com.atproto.identity.resolveHandle",
    asyncHandler((req, res) => {
      const handle = singleQueryString(req, "handle")?.trim().toLowerCase();
      if (!handle) throw new GroupHostHttpError(400, "InvalidRequest", "handle parameter required.");
      const row = db
        .prepare("SELECT did, activated, takendown FROM group_account WHERE handle = ?")
        .get(handle) as { did: string; activated: number; takendown: number } | undefined;
      if (!row || row.activated !== 1 || row.takendown !== 0) {
        throw new GroupHostHttpError(400, "UnableToResolveHandle", `Unable to resolve handle: ${handle}`);
      }
      res.json({ did: row.did });
    }),
  );

  app.post(
    "/xrpc/com.atproto.server.createAccount",
    json1Mb,
    asyncHandler(async (req, res) => {
      const { did, handle, recoveryKey } = (req.body ?? {}) as {
        did?: string;
        handle?: string;
        recoveryKey?: string;
      };
      if (!did || !handle) {
        throw new GroupHostHttpError(400, "InvalidRequest", "did and handle are required.");
      }
      const ticketHeader =
        typeof req.headers["x-group-migration-ticket"] === "string"
          ? req.headers["x-group-migration-ticket"]
          : undefined;
      const provenanceHeader =
        typeof req.headers["x-group-migration-key-provenance"] === "string"
          ? req.headers["x-group-migration-key-provenance"]
          : undefined;
      const rawOpIdHeader = req.headers["x-group-migration-operation-id"];
      if (Array.isArray(rawOpIdHeader)) {
        throw new GroupHostHttpError(400, "InvalidRequest", "Duplicate X-Group-Migration-Operation-Id header.");
      }
      const operationIdHeader = typeof rawOpIdHeader === "string" ? rawOpIdHeader : undefined;
      const out = await migration.createMigrationAccount({
        authorizationHeader: req.headers.authorization,
        ticketHeader,
        provenanceHeader,
        operationIdHeader,
        did,
        handle,
        recoveryKey,
      });
      res.json(out);
    }),
  );

  app.post(
    "/xrpc/com.atproto.server.refreshSession",
    asyncHandler(async (req, res) => {
      const idempotencyKey =
        typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"] : undefined;
      const out = await migration.refreshMigrationSession(req.headers.authorization, undefined, idempotencyKey);
      res.json(out);
    }),
  );

  app.get(
    "/xrpc/com.atproto.server.checkAccountStatus",
    asyncHandler(async (req, res) => {
      const auth = await authGroupOrMigration(req, res, "com.atproto.server.checkAccountStatus", true);
      attachDpopNonce(res, auth);
      res.json(migration.checkAccountStatus(auth.groupDid));
    }),
  );

  app.post(
    "/xrpc/com.atproto.server.activateAccount",
    asyncHandler(async (req, res) => {
      const auth = await authGroupOrMigration(req, res, "com.atproto.server.activateAccount", true);
      attachDpopNonce(res, auth);
      await migration.activateAccount({ auth });
      res.status(200).end();
    }),
  );

  app.post(
    "/xrpc/com.atproto.server.deactivateAccount",
    json1Mb,
    asyncHandler(async (req, res) => {
      const session = await authGroupDpop(req, res, "com.atproto.server.deactivateAccount");
      await migration.deactivateAccount({ session });
      res.status(200).end();
    }),
  );

  app.get(
    "/xrpc/com.atproto.server.getServiceAuth",
    asyncHandler(async (req, res) => {
      const session = await authGroupDpop(req, res, "com.atproto.server.getServiceAuth");
      const aud = singleQueryString(req, "aud");
      if (!aud) throw new GroupHostHttpError(400, "InvalidRequest", "aud parameter required.");
      const exp = queryInt(req, "exp");
      const lxm = singleQueryString(req, "lxm");
      const out = await migration.getServiceAuth({ session, aud, exp, lxm });
      res.json(out);
    }),
  );

  app.post(
    "/xrpc/com.atproto.server.requestAccountDelete",
    asyncHandler(async (req, res) => {
      const session = await authGroupDpop(req, res, "com.atproto.server.requestAccountDelete", true);
      session.permissions.assertAccount({ attr: "status", action: "manage" });
      const rawTokenHex = randomBytes(32).toString("hex");
      const tokenHashHex = sha256HexBytes(rawTokenHex);
      await repoStore.requestAccountDelete({
        groupDid: session.groupDid,
        actorDid: session.authorizingUserDid,
        session,
        rawTokenHex,
        tokenHashHex,
      });
      res.status(200).end();
    }),
  );

  app.post(
    "/xrpc/com.atproto.server.deleteAccount",
    json1Mb,
    asyncHandler(async (req, res) => {
      const session = await authGroupDpop(req, res, "com.atproto.server.deleteAccount", true);
      session.permissions.assertAccount({ attr: "status", action: "manage" });
      const { did, password, token } = (req.body ?? {}) as {
        did?: string;
        password?: string;
        token?: string;
      };
      if (!did || did !== session.groupDid || !token) {
        throw new GroupHostHttpError(400, "InvalidRequest", "did (matching session) and token are required.");
      }
      await repoStore.executeOrResumeDeleteAccount({
        groupDid: did,
        initCall: {
          actorDid: session.authorizingUserDid,
          password,
          tokenHashHex: sha256HexBytes(token),
          session,
        },
      });
      res.status(200).end();
    }),
  );

  app.get(
    "/xrpc/com.atproto.identity.getRecommendedDidCredentials",
    asyncHandler(async (req, res) => {
      const auth = await authGroupOrMigration(req, res, "com.atproto.identity.getRecommendedDidCredentials");
      attachDpopNonce(res, auth);
      res.json(await migration.getRecommendedDidCredentials({ auth }));
    }),
  );

  app.post(
    "/xrpc/com.atproto.identity.requestPlcOperationSignature",
    asyncHandler(async (req, res) => {
      const session = await authGroupDpop(req, res, "com.atproto.identity.requestPlcOperationSignature");
      await migration.requestPlcOperationSignature({ session });
      res.status(200).end();
    }),
  );

  app.post(
    "/xrpc/com.atproto.identity.signPlcOperation",
    json1Mb,
    asyncHandler(async (req, res) => {
      const session = await authGroupDpop(req, res, "com.atproto.identity.signPlcOperation");
      const rawOpIdHeader = req.headers["x-group-migration-operation-id"];
      if (Array.isArray(rawOpIdHeader)) {
        throw new GroupHostHttpError(400, "InvalidRequest", "Duplicate X-Group-Migration-Operation-Id header.");
      }
      const body = (req.body ?? {}) as {
        token?: string;
        rotationKeys?: string[];
        alsoKnownAs?: string[];
        verificationMethods?: Record<string, string>;
        services?: Record<string, { type: string; endpoint: string }>;
      };
      const out = await migration.signPlcOperation({
        session,
        ...body,
        ...(typeof rawOpIdHeader === "string" ? { operationIdHeader: rawOpIdHeader } : {}),
      });
      res.json(out);
    }),
  );

  app.post(
    "/xrpc/com.atproto.identity.submitPlcOperation",
    json1Mb,
    asyncHandler(async (req, res) => {
      const auth = await authGroupOrMigration(req, res, "com.atproto.identity.submitPlcOperation");
      attachDpopNonce(res, auth);
      const { operation } = (req.body ?? {}) as { operation?: unknown };
      await migration.submitPlcOperation({ auth, operation });
      res.status(200).end();
    }),
  );

  // =========================================================================
  // `/xrpc/com.atproto.sync.*` & `/xrpc/com.atproto.repo.*` (Public Repo & Blobs)
  // =========================================================================

  const checkSyncRepoAvailability = async (req: Request, res: Response, did: string, xrpcMethod: string) => {
    const acct = db
      .prepare("SELECT activated, takendown FROM group_account WHERE did = ?")
      .get(did) as { activated: number; takendown: number } | undefined;
    if (!acct) throw new GroupHostHttpError(400, "RepoNotFound", `Repo not found: ${did}`);
    if (acct.takendown !== 0) throw new GroupHostHttpError(400, "RepoTakendown", `Repo taken down: ${did}`);
    if (acct.activated !== 1) {
      // Allow `recovery` DPoP OAuth on `getRepo`, `listBlobs`, `getBlob` while deactivated!
      if (req.headers.authorization?.startsWith("DPoP ")) {
        const sess = await authGroupDpop(req, res, xrpcMethod, true);
        if (sess.groupDid === did) return;
      }
      throw new GroupHostHttpError(400, "RepoDeactivated", `Repo deactivated: ${did}`);
    }
  };

  app.get(
    "/xrpc/com.atproto.sync.getRepoStatus",
    asyncHandler((req, res) => {
      const did = singleQueryString(req, "did");
      if (!did) throw new GroupHostHttpError(400, "InvalidRequest", "did required.");
      const acct = db
        .prepare("SELECT activated, takendown FROM group_account WHERE did = ?")
        .get(did) as { activated: number; takendown: number } | undefined;
      if (!acct) throw new GroupHostHttpError(400, "RepoNotFound", `Repo not found: ${did}`);
      const root = db
        .prepare("SELECT rev FROM public_repo_root WHERE group_did = ?")
        .get(did) as { rev: string } | undefined;
      if (acct.takendown !== 0) {
        res.json({ did, active: false, status: "takendown" });
        return;
      }
      if (acct.activated !== 1) {
        res.json({ did, active: false, status: "deactivated", ...(root ? { rev: root.rev } : {}) });
        return;
      }
      res.json({ did, active: true, ...(root ? { rev: root.rev } : {}) });
    }),
  );

  app.get(
    "/xrpc/com.atproto.sync.getLatestCommit",
    asyncHandler(async (req, res) => {
      const did = singleQueryString(req, "did");
      if (!did) throw new GroupHostHttpError(400, "InvalidRequest", "did required.");
      await checkSyncRepoAvailability(req, res, did, "com.atproto.sync.getLatestCommit");
      const root = db
        .prepare("SELECT commit_cid, rev FROM public_repo_root WHERE group_did = ?")
        .get(did) as { commit_cid: string; rev: string } | undefined;
      if (!root) throw new GroupHostHttpError(400, "RepoNotFound");
      res.json({ cid: root.commit_cid, rev: root.rev });
    }),
  );

  app.get(
    "/xrpc/com.atproto.sync.getRepo",
    asyncHandler(async (req, res) => {
      const did = singleQueryString(req, "did");
      if (!did) throw new GroupHostHttpError(400, "InvalidRequest", "did required.");
      await checkSyncRepoAvailability(req, res, did, "com.atproto.sync.getRepo");
      const { carBytes } = await repoStore.exportPublicRepoCar(did);
      res.setHeader("Content-Type", "application/vnd.ipld.car");
      res.send(Buffer.from(carBytes));
    }),
  );

  app.get(
    "/xrpc/com.atproto.sync.listBlobs",
    asyncHandler(async (req, res) => {
      const did = singleQueryString(req, "did");
      if (!did) throw new GroupHostHttpError(400, "InvalidRequest", "did required.");
      await checkSyncRepoAvailability(req, res, did, "com.atproto.sync.listBlobs");
      const limit = Math.min(Math.max(queryInt(req, "limit") ?? 500, 1), 1000);
      const cursor = singleQueryString(req, "cursor");
      const rows = db
        .prepare(
          `SELECT cid FROM blob_store
           WHERE group_did = ? AND quarantined = 0 AND (? IS NULL OR cid > ?)
           ORDER BY cid ASC
           LIMIT ?`,
        )
        .all(did, cursor ?? null, cursor ?? null, limit + 1) as Array<{ cid: string }>;
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      res.json({
        cids: page.map((r) => r.cid),
        ...(hasMore && page.at(-1) ? { cursor: page.at(-1)!.cid } : {}),
      });
    }),
  );

  app.get(
    "/xrpc/com.atproto.sync.getBlob",
    asyncHandler(async (req, res) => {
      const did = singleQueryString(req, "did");
      const cid = singleQueryString(req, "cid");
      if (!did || !cid) throw new GroupHostHttpError(400, "InvalidRequest", "did and cid required.");
      await checkSyncRepoAvailability(req, res, did, "com.atproto.sync.getBlob");
      const row = db
        .prepare("SELECT mime_type, bytes, quarantined FROM blob_store WHERE group_did = ? AND cid = ?")
        .get(did, cid) as { mime_type: string; bytes: Buffer; quarantined: number } | undefined;
      if (!row || row.quarantined !== 0) {
        throw new GroupHostHttpError(400, "BlobNotFound", `Blob not found: ${cid}`);
      }
      res.setHeader("Content-Type", row.mime_type || "application/octet-stream");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.send(row.bytes);
    }),
  );

  app.get(
    "/xrpc/com.atproto.repo.describeRepo",
    asyncHandler((req, res) => {
      const repoParam = singleQueryString(req, "repo");
      if (!repoParam) throw new GroupHostHttpError(400, "InvalidRequest", "repo parameter required.");
      const acct = repoStore.resolveRepoIdentifier(repoParam);
      if (acct.takendown !== 0) throw new GroupHostHttpError(400, "RepoTakendown");
      if (acct.activated !== 1) throw new GroupHostHttpError(400, "RepoDeactivated");
      const cols = db
        .prepare("SELECT DISTINCT collection FROM public_record WHERE group_did = ? ORDER BY collection ASC")
        .all(acct.did) as Array<{ collection: string }>;
      res.json({
        handle: acct.handle,
        did: acct.did,
        didDoc: {},
        collections: cols.map((c) => c.collection),
        handleIsCorrect: true,
      });
    }),
  );

  app.get(
    "/xrpc/com.atproto.repo.getRecord",
    asyncHandler((req, res) => {
      const repoParam = singleQueryString(req, "repo");
      const collection = singleQueryString(req, "collection");
      const rkey = singleQueryString(req, "rkey");
      const cidParam = singleQueryString(req, "cid");
      if (!repoParam || !collection || !rkey) {
        throw new GroupHostHttpError(400, "InvalidRequest", "repo, collection, and rkey required.");
      }
      const acct = repoStore.resolveRepoIdentifier(repoParam);
      if (acct.takendown !== 0) throw new GroupHostHttpError(400, "RepoTakendown");
      if (acct.activated !== 1) throw new GroupHostHttpError(400, "RepoDeactivated");
      const row = db
        .prepare("SELECT uri, cid, value FROM public_record WHERE group_did = ? AND collection = ? AND rkey = ?")
        .get(acct.did, collection, rkey) as { uri: string; cid: string; value: string } | undefined;
      if (!row || (cidParam && row.cid !== cidParam)) {
        throw new GroupHostHttpError(400, "RecordNotFound", `Record not found: ${collection}/${rkey}`);
      }
      res.json({
        uri: row.uri,
        cid: row.cid,
        value: JSON.parse(row.value),
      });
    }),
  );

  app.get(
    "/xrpc/com.atproto.repo.listRecords",
    asyncHandler((req, res) => {
      const repoParam = singleQueryString(req, "repo");
      const collection = singleQueryString(req, "collection");
      if (!repoParam || !collection) {
        throw new GroupHostHttpError(400, "InvalidRequest", "repo and collection required.");
      }
      const acct = repoStore.resolveRepoIdentifier(repoParam);
      if (acct.takendown !== 0) throw new GroupHostHttpError(400, "RepoTakendown");
      if (acct.activated !== 1) throw new GroupHostHttpError(400, "RepoDeactivated");
      const limit = Math.min(Math.max(queryInt(req, "limit") ?? 50, 1), 100);
      const cursor = singleQueryString(req, "cursor");
      const reverse = singleQueryString(req, "reverse") === "true";

      const rows = reverse
        ? (db
            .prepare(
              `SELECT rkey, uri, cid, value FROM public_record
               WHERE group_did = ? AND collection = ? AND (? IS NULL OR rkey > ?)
               ORDER BY rkey ASC LIMIT ?`,
            )
            .all(acct.did, collection, cursor ?? null, cursor ?? null, limit + 1) as Array<{
            rkey: string;
            uri: string;
            cid: string;
            value: string;
          }>)
        : (db
            .prepare(
              `SELECT rkey, uri, cid, value FROM public_record
               WHERE group_did = ? AND collection = ? AND (? IS NULL OR rkey < ?)
               ORDER BY rkey DESC LIMIT ?`,
            )
            .all(acct.did, collection, cursor ?? null, cursor ?? null, limit + 1) as Array<{
            rkey: string;
            uri: string;
            cid: string;
            value: string;
          }>);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      res.json({
        records: page.map((r) => ({
          uri: r.uri,
          cid: r.cid,
          value: JSON.parse(r.value),
        })),
        ...(hasMore && page.at(-1) ? { cursor: page.at(-1)!.rkey } : {}),
      });
    }),
  );

  app.post(
    "/xrpc/com.atproto.repo.createRecord",
    json1Mb,
    asyncHandler(async (req, res) => {
      const session = await authGroupDpop(req, res);
      const { repo, collection, rkey, record, validate, swapCommit } = (req.body ?? {}) as {
        repo?: string;
        collection?: string;
        rkey?: string;
        record?: Record<string, unknown>;
        validate?: boolean;
        swapCommit?: string;
      };
      if (!repo || !collection || !record || typeof record !== "object") {
        throw new GroupHostHttpError(400, "InvalidRequest", "repo, collection, and record are required.");
      }
      const acct = repoStore.resolveRepoIdentifier(repo);
      if (acct.did !== session.groupDid) {
        throw new GroupHostHttpError(403, "Forbidden", "Repo does not match authenticated group DID.");
      }
      session.permissions.assertRepo({ collection: collection as NsidString, action: "create" });
      const out = await repoStore.applyPublicWrites({
        groupDid: acct.did,
        session,
        writes: [{ action: "create", collection, rkey, value: record, validate }],
        swapCommit,
      });
      const r0 = out.results[0]!;
      res.json({
        uri: r0.uri,
        cid: r0.cid,
        commit: out.commit,
        validationStatus: r0.validationStatus ?? "valid",
      });
    }),
  );

  app.post(
    "/xrpc/com.atproto.repo.putRecord",
    json1Mb,
    asyncHandler(async (req, res) => {
      const session = await authGroupDpop(req, res);
      const { repo, collection, rkey, record, validate, swapCommit, swapRecord } = (req.body ?? {}) as {
        repo?: string;
        collection?: string;
        rkey?: string;
        record?: Record<string, unknown>;
        validate?: boolean;
        swapCommit?: string;
        swapRecord?: string | null;
      };
      if (!repo || !collection || !rkey || !record || typeof record !== "object") {
        throw new GroupHostHttpError(400, "InvalidRequest", "repo, collection, rkey, and record are required.");
      }
      const acct = repoStore.resolveRepoIdentifier(repo);
      if (acct.did !== session.groupDid) {
        throw new GroupHostHttpError(403, "Forbidden", "Repo does not match authenticated group DID.");
      }
      if (
        !session.permissions.allowsRepo({ collection: collection as NsidString, action: "create" }) &&
        !session.permissions.allowsRepo({ collection: collection as NsidString, action: "update" })
      ) {
        session.permissions.assertRepo({ collection: collection as NsidString, action: "create" });
      }
      const out = await repoStore.applyPublicWrites({
        groupDid: acct.did,
        session,
        writes: [{ action: "update", collection, rkey, value: record, validate }],
        swapCommit,
        isPutRecord: true,
        putSwapRecord: swapRecord,
      });
      const r0 = out.results[0]!;
      res.json({
        uri: r0.uri,
        cid: r0.cid,
        commit: out.commit,
        validationStatus: r0.validationStatus ?? "valid",
      });
    }),
  );

  app.post(
    "/xrpc/com.atproto.repo.deleteRecord",
    json1Mb,
    asyncHandler(async (req, res) => {
      const session = await authGroupDpop(req, res);
      const { repo, collection, rkey, swapCommit, swapRecord } = (req.body ?? {}) as {
        repo?: string;
        collection?: string;
        rkey?: string;
        swapCommit?: string;
        swapRecord?: string | null;
      };
      if (!repo || !collection || !rkey) {
        throw new GroupHostHttpError(400, "InvalidRequest", "repo, collection, and rkey are required.");
      }
      const acct = repoStore.resolveRepoIdentifier(repo);
      if (acct.did !== session.groupDid) {
        throw new GroupHostHttpError(403, "Forbidden", "Repo does not match authenticated group DID.");
      }
      session.permissions.assertRepo({ collection: collection as NsidString, action: "delete" });
      const out = await repoStore.applyPublicWrites({
        groupDid: acct.did,
        session,
        writes: [{ action: "delete", collection, rkey, swapRecord }],
        swapCommit,
        isPutRecord: true,
      });
      res.json(out.results.length === 0 ? {} : { commit: out.commit });
    }),
  );

  app.post(
    "/xrpc/com.atproto.repo.applyWrites",
    json1Mb,
    asyncHandler(async (req, res) => {
      const session = await authGroupDpop(req, res);
      const { repo, writes, validate, swapCommit } = (req.body ?? {}) as {
        repo?: string;
        writes?: Array<Record<string, unknown>>;
        validate?: boolean;
        swapCommit?: string;
      };
      if (!repo || !Array.isArray(writes)) {
        throw new GroupHostHttpError(400, "InvalidRequest", "repo and writes array required.");
      }
      const acct = repoStore.resolveRepoIdentifier(repo);
      if (acct.did !== session.groupDid) {
        throw new GroupHostHttpError(403, "Forbidden", "Repo does not match authenticated group DID.");
      }
      const mapped = writes.map((w) => {
        const t = w.$type;
        const collection = String(w.collection ?? "");
        if (t === "com.atproto.repo.applyWrites#create") {
          session.permissions.assertRepo({ collection: collection as NsidString, action: "create" });
          return {
            action: "create" as const,
            collection,
            ...(typeof w.rkey === "string" ? { rkey: w.rkey } : {}),
            value: w.value as Record<string, unknown>,
            validate,
          };
        }
        if (t === "com.atproto.repo.applyWrites#update") {
          session.permissions.assertRepo({ collection: collection as NsidString, action: "update" });
          return {
            action: "update" as const,
            collection,
            rkey: String(w.rkey ?? ""),
            value: w.value as Record<string, unknown>,
            validate,
          };
        }
        if (t === "com.atproto.repo.applyWrites#delete") {
          session.permissions.assertRepo({ collection: collection as NsidString, action: "delete" });
          return {
            action: "delete" as const,
            collection,
            rkey: String(w.rkey ?? ""),
          };
        }
        throw new GroupHostHttpError(400, "InvalidRequest", `Unknown applyWrites op $type: ${String(t)}`);
      });
      const out = await repoStore.applyPublicWrites({
        groupDid: acct.did,
        session,
        writes: mapped,
        swapCommit,
      });
      res.json(out);
    }),
  );

  app.post(
    "/xrpc/com.atproto.repo.uploadBlob",
    asyncHandler(async (req, res) => {
      const auth = await authGroupOrMigration(req, res, "com.atproto.repo.uploadBlob");
      attachDpopNonce(res, auth);
      const mimeType = (req.headers["content-type"]?.split(";")[0]?.trim() || "application/octet-stream") as `${string}/${string}`;
      if (auth.kind === "oauth") {
        auth.permissions.assertBlob({ mime: mimeType });
      } else {
        auth.permissions.assertAccount({ attr: "repo", action: "manage" });
      }
      const out = await repoStore.uploadBlob({
        groupDid: auth.groupDid,
        ...(auth.kind === "oauth" ? { session: auth } : {}),
        mimeType,
        bodyStream: req,
        migrationSessionId: auth.kind === "migration" ? auth.id : undefined,
        migrationTokenExpSec: auth.kind === "migration" ? auth.expSec : undefined,
      });
      res.json(out);
    }),
  );

  app.post(
    "/xrpc/com.atproto.repo.importRepo",
    asyncHandler(async (req, res) => {
      if (!req.headers.authorization?.startsWith("Bearer ")) {
        const sess = await authGroupDpop(req, res);
        void sess;
        throw new GroupHostHttpError(400, "AlreadyActivated", "importRepo is only allowed on unactivated migration staging sessions.");
      }
      const migAuth = await migration.authenticateMigrationBearer(req.headers.authorization, false);
      migAuth.permissions.assertAccount({ attr: "repo", action: "manage" });
      await repoStore.importPublicRepoCar({
        groupDid: migAuth.groupDid,
        migrationSessionId: migAuth.id,
        migrationTokenExpSec: migAuth.expSec,
        carStream: req,
      });
      res.status(200).end();
    }),
  );

  app.get(
    "/xrpc/com.atproto.repo.listMissingBlobs",
    asyncHandler(async (req, res) => {
      const auth = await authGroupOrMigration(req, res, "com.atproto.repo.listMissingBlobs");
      attachDpopNonce(res, auth);
      auth.permissions.assertAccount({ attr: "repo", action: "manage" });
      const limit = Math.min(Math.max(queryInt(req, "limit") ?? 500, 1), 1000);
      const cursor = singleQueryString(req, "cursor");
      res.json(repoStore.listMissingBlobs(auth.groupDid, limit, cursor));
    }),
  );

  // =========================================================================
  // `/xrpc/com.atproto.space.*`
  // =========================================================================

  const parseSpaceTarget = (spaceUriValue: string) => {
    const parsed = parseSpaceUri(spaceUriValue);
    if (!parsed) throw new GroupHostHttpError(400, "InvalidSpaceUri", `Invalid space URI: ${spaceUriValue}`);
    return {
      parsed,
      permRef: {
        spaceDid: parsed.authorityDid as DidString,
        spaceType: parsed.type as NsidString,
        skey: parsed.skey as RecordKeyString,
      },
    };
  };

  app.post(
    "/xrpc/com.atproto.space.createSpace",
    json1Mb,
    asyncHandler(async (req, res) => {
      const session = await authGroupDpop(req, res);
      const { spaceType, skey, policy } = (req.body ?? {}) as {
        spaceType?: string;
        skey?: string;
        policy?: Record<string, unknown>;
      };
      if (!spaceType || !policy || typeof policy !== "object") {
        throw new GroupHostHttpError(400, "InvalidRequest", "spaceType and policy are required.");
      }
      const actualSkey = skey ?? tidNowFallback();
      session.permissions.assertSpace(
        {
          spaceDid: session.groupDid as DidString,
          spaceType: spaceType as NsidString,
          skey: actualSkey as RecordKeyString,
        },
        { manage: "create" },
      );
      const out = await repoStore.createOrUpdateSpace({
        mode: "create",
        groupDid: session.groupDid,
        actorDid: session.authorizingUserDid,
        session,
        spaceType,
        skey: actualSkey,
        policy,
      });
      res.json(out);
    }),
  );

  app.post(
    "/xrpc/com.atproto.space.updateSpace",
    json1Mb,
    asyncHandler(async (req, res) => {
      const session = await authGroupDpop(req, res);
      const { space, policy } = (req.body ?? {}) as {
        space?: string;
        policy?: Record<string, unknown>;
      };
      if (!space || !policy || typeof policy !== "object") {
        throw new GroupHostHttpError(400, "InvalidRequest", "space and policy are required.");
      }
      const { parsed, permRef } = parseSpaceTarget(space);
      if (parsed.authorityDid !== session.groupDid) {
        throw new GroupHostHttpError(400, "NotAuthorized", "Not the space authority.");
      }
      session.permissions.assertSpace(permRef, { manage: "update" });
      const out = await repoStore.createOrUpdateSpace({
        mode: "update",
        groupDid: session.groupDid,
        actorDid: session.authorizingUserDid,
        session,
        spaceType: parsed.type,
        skey: parsed.skey,
        policy,
      });
      res.json(out);
    }),
  );

  app.get(
    "/xrpc/com.atproto.space.getSpace",
    asyncHandler(async (req, res) => {
      const session = await authGroupDpop(req, res);
      const space = singleQueryString(req, "space");
      if (!space) throw new GroupHostHttpError(400, "InvalidRequest", "space required.");
      const { parsed, permRef } = parseSpaceTarget(space);
      if (parsed.authorityDid !== session.groupDid) {
        throw new GroupHostHttpError(400, "NotAuthorized", "Not the space authority.");
      }
      const mig = db.prepare("SELECT status FROM source_migration_lease WHERE group_did = ?").get(session.groupDid) as
        | { status: string }
        | undefined;
      if (mig?.status === "plc_signed") {
        throw new GroupHostHttpError(409, "MigrationCutoverPending");
      }
      session.permissions.assertSpace(permRef, { action: "read_self" });
      const spRow = db
        .prepare("SELECT policy_json, deleted_at FROM group_space WHERE space_uri = ? AND group_did = ?")
        .get(space, session.groupDid) as { policy_json: string; deleted_at: number | null } | undefined;
      if (!spRow) throw new GroupHostHttpError(400, "SpaceNotFound");
      if (spRow.deleted_at !== null) throw new GroupHostHttpError(400, "SpaceDeleted");
      res.json({ space, uri: space, policy: JSON.parse(spRow.policy_json) });
    }),
  );

  app.post(
    "/xrpc/com.atproto.space.deleteSpace",
    json1Mb,
    asyncHandler(async (req, res) => {
      const session = await authGroupDpop(req, res);
      const { space } = (req.body ?? {}) as { space?: string };
      if (!space) throw new GroupHostHttpError(400, "InvalidRequest", "space required.");
      const { parsed, permRef } = parseSpaceTarget(space);
      if (parsed.authorityDid !== session.groupDid) {
        throw new GroupHostHttpError(400, "NotAuthorized", "Not the space authority.");
      }
      session.permissions.assertSpace(permRef, { manage: "delete" });
      await repoStore.deleteSpace({ groupDid: session.groupDid, session, spaceUri: space });
      res.status(200).end();
    }),
  );

  app.post(
    "/xrpc/com.atproto.space.removeWriter",
    json1Mb,
    asyncHandler(async (req, res) => {
      const session = await authGroupDpop(req, res);
      const { space, repo } = (req.body ?? {}) as { space?: string; repo?: string };
      if (!space || !repo) throw new GroupHostHttpError(400, "InvalidRequest", "space and repo required.");
      const { parsed, permRef } = parseSpaceTarget(space);
      if (parsed.authorityDid !== session.groupDid) {
        throw new GroupHostHttpError(400, "NotAuthorized", "Not the space authority.");
      }
      session.permissions.assertSpace(permRef, { manage: "update" });
      await services.locks.withGroupRepoLock(session.groupDid, () => {
        const nowMs = Date.now();
        const tx = db.transaction(() => {
          reapExpiredPreparedMigrationLease(db, session.groupDid, nowMs);
          if (hasActiveSourceMigrationLease(db, session.groupDid, nowMs)) {
            throw new GroupHostHttpError(409, "MigrationInProgress");
          }
          const revalidated = revalidateLiveOAuthSessionSync(db, session, { nowMs });
          revalidated.permissions.assertSpace(permRef, { manage: "update" });
          repoStore.evictWriterFromSpaceSync({
            groupDid: session.groupDid,
            spaceUri: space,
            writerDid: repo,
            nowMs,
          });
        });
        tx.immediate();
      });
      res.status(200).end();
    }),
  );

  app.get(
    "/xrpc/com.atproto.space.exportSpaceMeta",
    asyncHandler(async (req, res) => {
      const auth = await authGroupOrMigration(req, res, "com.atproto.space.exportSpaceMeta", true);
      attachDpopNonce(res, auth);
      const space = singleQueryString(req, "space");
      if (!space) throw new GroupHostHttpError(400, "InvalidRequest", "space required.");
      const { parsed, permRef } = parseSpaceTarget(space);
      if (parsed.authorityDid !== auth.groupDid) {
        throw new GroupHostHttpError(400, "NotAuthorized", "Not the space authority.");
      }
      const mig = db.prepare("SELECT status FROM source_migration_lease WHERE group_did = ?").get(auth.groupDid) as
        | { status: string }
        | undefined;
      if (mig?.status === "plc_signed") {
        throw new GroupHostHttpError(409, "MigrationCutoverPending");
      }
      auth.permissions.assertSpace(permRef, { action: "read_self" });
      const starBytes = await repoStore.exportSpaceMetaBytes(auth.groupDid, space);
      res.setHeader("Content-Type", "application/vnd.dasl.star");
      res.send(Buffer.from(starBytes));
    }),
  );

  app.post(
    "/xrpc/com.atproto.space.importSpaceMeta",
    asyncHandler(async (req, res) => {
      if (!req.headers.authorization?.startsWith("Bearer ")) {
        const sess = await authGroupDpop(req, res);
        void sess;
        throw new GroupHostHttpError(400, "AlreadyActivated", "importSpaceMeta is only allowed on unactivated migration staging sessions.");
      }
      const migAuth = await migration.authenticateMigrationBearer(req.headers.authorization, false);
      migAuth.permissions.assertSpace(
        { spaceType: "*", authority: migAuth.groupDid as DidString, skey: "*" },
        { manage: "create" },
      );
      migAuth.permissions.assertSpace(
        { spaceType: "*", authority: migAuth.groupDid as DidString, skey: "*" },
        { manage: "update" },
      );
      const out = await repoStore.importSpaceMetaStream({
        groupDid: migAuth.groupDid,
        migrationSessionId: migAuth.id,
        migrationTokenExpSec: migAuth.expSec,
        starStream: req,
      });
      res.json(out);
    }),
  );

  app.post(
    "/xrpc/com.atproto.space.importRepo",
    asyncHandler(async (req, res) => {
      if (!req.headers.authorization?.startsWith("Bearer ")) {
        const sess = await authGroupDpop(req, res);
        void sess;
        throw new GroupHostHttpError(400, "AlreadyActivated", "space.importRepo is only allowed on unactivated migration staging sessions.");
      }
      const migAuth = await migration.authenticateMigrationBearer(req.headers.authorization, false);
      migAuth.permissions.assertSpace(
        { spaceType: "*", authority: "*", skey: "*" },
        { action: "read_self" },
      );
      migAuth.permissions.assertSpace(
        { spaceType: "*", authority: migAuth.groupDid as DidString, skey: "*" },
        { action: "create", collection: "*" },
      );
      migAuth.permissions.assertSpace(
        { spaceType: "*", authority: migAuth.groupDid as DidString, skey: "*" },
        { action: "update", collection: "*" },
      );
      migAuth.permissions.assertSpace(
        { spaceType: "*", authority: migAuth.groupDid as DidString, skey: "*" },
        { action: "delete", collection: "*" },
      );
      await repoStore.importSpaceRepoStarStream({
        groupDid: migAuth.groupDid,
        migrationSessionId: migAuth.id,
        migrationTokenExpSec: migAuth.expSec,
        starStream: req,
      });
      res.status(200).end();
    }),
  );

  app.post(
    "/xrpc/com.atproto.space.createRecord",
    json1Mb,
    asyncHandler(async (req, res) => {
      const session = await authGroupDpop(req, res);
      const { space, repo, collection, rkey, record, validate } = (req.body ?? {}) as {
        space?: string;
        repo?: string;
        collection?: string;
        rkey?: string;
        record?: Record<string, unknown>;
        validate?: boolean;
      };
      if (!space || !repo || !collection || !record || typeof record !== "object") {
        throw new GroupHostHttpError(400, "InvalidRequest", "space, repo, collection, and record are required.");
      }
      if (repo !== session.groupDid) {
        throw new GroupHostHttpError(403, "Forbidden", "repo must equal authenticated group DID.");
      }
      const { permRef } = parseSpaceTarget(space);
      session.permissions.assertSpace(permRef, {
        action: "create",
        collection: collection as NsidString,
      });
      const ifJoinReq = req.headers["if-join-request-present"] === "true";
      const out = await repoStore.applySpaceWrites({
        groupDid: session.groupDid,
        actorDid: session.authorizingUserDid,
        session,
        spaceUri: space,
        writes: [{ action: "create", collection, rkey, value: record, validate }],
        ifJoinRequestPresent: ifJoinReq,
      });
      const r0 = out.results[0]!;
      res.json({
        uri: r0.uri,
        cid: r0.cid,
        commit: out.commit,
        validationStatus: r0.validationStatus ?? "valid",
      });
    }),
  );

  app.post(
    "/xrpc/com.atproto.space.putRecord",
    json1Mb,
    asyncHandler(async (req, res) => {
      const session = await authGroupDpop(req, res);
      const { space, repo, collection, rkey, record, validate, swapRecord } = (req.body ?? {}) as {
        space?: string;
        repo?: string;
        collection?: string;
        rkey?: string;
        record?: Record<string, unknown>;
        validate?: boolean;
        swapRecord?: string | null;
      };
      if (!space || !repo || !collection || !rkey || !record || typeof record !== "object") {
        throw new GroupHostHttpError(400, "InvalidRequest", "space, repo, collection, rkey, and record are required.");
      }
      if (repo !== session.groupDid) {
        throw new GroupHostHttpError(403, "Forbidden", "repo must equal authenticated group DID.");
      }
      const { permRef } = parseSpaceTarget(space);
      if (
        !session.permissions.allowsSpace(permRef, {
          action: "create",
          collection: collection as NsidString,
        }) &&
        !session.permissions.allowsSpace(permRef, {
          action: "update",
          collection: collection as NsidString,
        })
      ) {
        session.permissions.assertSpace(permRef, {
          action: "create",
          collection: collection as NsidString,
        });
      }
      const ifJoinReq = req.headers["if-join-request-present"] === "true";
      const out = await repoStore.applySpaceWrites({
        groupDid: session.groupDid,
        actorDid: session.authorizingUserDid,
        session,
        spaceUri: space,
        writes: [{ action: "update", collection, rkey, value: record, validate }],
        isPutRecord: true,
        putSwapRecord: swapRecord,
        ifJoinRequestPresent: ifJoinReq,
      });
      const r0 = out.results[0]!;
      res.json({
        uri: r0.uri,
        cid: r0.cid,
        commit: out.commit,
        validationStatus: r0.validationStatus ?? "valid",
      });
    }),
  );

  app.post(
    "/xrpc/com.atproto.space.deleteRecord",
    json1Mb,
    asyncHandler(async (req, res) => {
      const session = await authGroupDpop(req, res);
      const { space, repo, collection, rkey, swapRecord } = (req.body ?? {}) as {
        space?: string;
        repo?: string;
        collection?: string;
        rkey?: string;
        swapRecord?: string | null;
      };
      if (!space || !repo || !collection || !rkey) {
        throw new GroupHostHttpError(400, "InvalidRequest", "space, repo, collection, and rkey are required.");
      }
      if (repo !== session.groupDid) {
        throw new GroupHostHttpError(403, "Forbidden", "repo must equal authenticated group DID.");
      }
      const { permRef } = parseSpaceTarget(space);
      session.permissions.assertSpace(permRef, {
        action: "delete",
        collection: collection as NsidString,
      });
      const out = await repoStore.applySpaceWrites({
        groupDid: session.groupDid,
        actorDid: session.authorizingUserDid,
        session,
        spaceUri: space,
        writes: [{ action: "delete", collection, rkey, swapRecord }],
        isPutRecord: true,
      });
      res.json({ commit: out.commit });
    }),
  );

  app.post(
    "/xrpc/com.atproto.space.applyWrites",
    json1Mb,
    asyncHandler(async (req, res) => {
      const session = await authGroupDpop(req, res);
      const { space, repo, writes, validate } = (req.body ?? {}) as {
        space?: string;
        repo?: string;
        writes?: Array<Record<string, unknown>>;
        validate?: boolean;
      };
      if (!space || !repo || !Array.isArray(writes)) {
        throw new GroupHostHttpError(400, "InvalidRequest", "space, repo, and writes array required.");
      }
      if (repo !== session.groupDid) {
        throw new GroupHostHttpError(403, "Forbidden", "repo must equal authenticated group DID.");
      }
      const { permRef } = parseSpaceTarget(space);
      const mapped = writes.map((w) => {
        const t = w.$type;
        const collection = String(w.collection ?? "");
        if (t === "com.atproto.space.applyWrites#create") {
          session.permissions.assertSpace(permRef, { action: "create", collection: collection as NsidString });
          return {
            action: "create" as const,
            collection,
            ...(typeof w.rkey === "string" ? { rkey: w.rkey } : {}),
            value: w.value as Record<string, unknown>,
            validate,
          };
        }
        if (t === "com.atproto.space.applyWrites#update") {
          session.permissions.assertSpace(permRef, { action: "update", collection: collection as NsidString });
          return {
            action: "update" as const,
            collection,
            rkey: String(w.rkey ?? ""),
            value: w.value as Record<string, unknown>,
            validate,
          };
        }
        if (t === "com.atproto.space.applyWrites#delete") {
          session.permissions.assertSpace(permRef, { action: "delete", collection: collection as NsidString });
          return {
            action: "delete" as const,
            collection,
            rkey: String(w.rkey ?? ""),
          };
        }
        throw new GroupHostHttpError(400, "InvalidRequest", `Unknown space applyWrites op $type: ${String(t)}`);
      });
      const ifJoinReq = req.headers["if-join-request-present"] === "true";
      const out = await repoStore.applySpaceWrites({
        groupDid: session.groupDid,
        actorDid: session.authorizingUserDid,
        session,
        spaceUri: space,
        writes: mapped,
        ifJoinRequestPresent: ifJoinReq,
      });
      res.json(out);
    }),
  );

  app.post(
    "/xrpc/com.atproto.space.clearRecords",
    json1Mb,
    asyncHandler(async (req, res) => {
      const session = await authGroupDpop(req, res);
      const { space, repo, collections } = (req.body ?? {}) as {
        space?: string;
        repo?: string;
        collections?: string[];
      };
      if (!space || !repo) throw new GroupHostHttpError(400, "InvalidRequest", "space and repo required.");
      if (repo !== session.groupDid) {
        throw new GroupHostHttpError(403, "Forbidden", "repo must equal authenticated group DID.");
      }
      const { permRef } = parseSpaceTarget(space);
      if (collections && collections.length > 0) {
        for (const col of collections) {
          session.permissions.assertSpace(permRef, { action: "delete", collection: col as NsidString });
        }
      } else {
        session.permissions.assertSpace(permRef, { action: "delete", collection: "*" });
      }
      const out = await repoStore.clearSpaceRecords({
        groupDid: session.groupDid,
        actorDid: session.authorizingUserDid,
        session,
        spaceUri: space,
        collections,
      });
      res.json(out);
    }),
  );

  const handleGetDelegationToken = asyncHandler(async (req, res) => {
    const session = await authGroupDpop(req, res);
    const space =
      req.method === "GET"
        ? singleQueryString(req, "space")
        : ((req.body ?? {}) as { space?: string }).space;
    if (!space) throw new GroupHostHttpError(400, "InvalidRequest", "space required.");
    const mig = db.prepare("SELECT status FROM source_migration_lease WHERE group_did = ?").get(session.groupDid) as
      | { status: string }
      | undefined;
    if (mig?.status === "plc_signed") throw new GroupHostHttpError(409, "MigrationCutoverPending");
    const { permRef } = parseSpaceTarget(space);
    session.permissions.assertSpace(permRef, { action: "read" });
    res.json(await repoStore.mintDelegationToken(session.groupDid, space));
  });

  app.get("/xrpc/com.atproto.space.getDelegationToken", handleGetDelegationToken);
  app.post("/xrpc/com.atproto.space.getDelegationToken", json1Mb, handleGetDelegationToken);

  app.get(
    "/xrpc/com.atproto.space.listSpaces",
    asyncHandler(async (req, res) => {
      const session = await authGroupDpop(req, res);
      const spaceDid = singleQueryString(req, "spaceDid");
      const spaceType = singleQueryString(req, "spaceType");
      const limit = Math.min(Math.max(queryInt(req, "limit") ?? 50, 1), 100);
      const cursor = singleQueryString(req, "cursor");

      const mig = db.prepare("SELECT status FROM source_migration_lease WHERE group_did = ?").get(session.groupDid) as
        | { status: string }
        | undefined;
      if (mig?.status === "plc_signed") throw new GroupHostHttpError(409, "MigrationCutoverPending");

      session.permissions.assertSpace(
        {
          spaceType: (spaceType ?? "*") as NsidString | "*",
          authority: (spaceDid ?? "*") as DidString | "*",
          skey: "*",
        },
        { action: "read_self" },
      );

      // Union own `group_space` rows AND external `space_repo` rows (e.g. `at://<inviteeDid>/space/group.opensocial.invites/self`!)
      const ownSpaces = db
        .prepare("SELECT space_uri, space_type, space_rev FROM group_space WHERE group_did = ? AND deleted_at IS NULL")
        .all(session.groupDid) as Array<{ space_uri: string; space_type: string; space_rev: string }>;
      const ownMap = new Map(ownSpaces.map((s) => [s.space_uri, s]));

      const repoRows = db
        .prepare("SELECT space_uri, set_hash, rev FROM space_repo WHERE repo_did = ?")
        .all(session.groupDid) as Array<{ space_uri: string; set_hash: Buffer; rev: string }>;
      const repoMap = new Map(repoRows.map((r) => [r.space_uri, r]));

      const allUris = [...new Set([...ownMap.keys(), ...repoMap.keys()])].sort();
      const filtered: Array<{
        space: string;
        repoRev?: string;
        data?: unknown;
        spaceRev?: string;
      }> = [];

      for (const uri of allUris) {
        if (cursor && uri <= cursor) continue;
        const parsed = parseSpaceUri(uri);
        if (!parsed) continue;
        if (parsed.authorityDid === session.groupDid && !ownMap.has(uri)) continue;
        if (spaceDid && parsed.authorityDid !== spaceDid) continue;
        if (spaceType && parsed.type !== spaceType) continue;

        const own = ownMap.get(uri);
        const rp = repoMap.get(uri);
        filtered.push({
          space: uri,
          ...(rp ? { repoRev: rp.rev, data: lexToJson(new LtHash(new Uint8Array(rp.set_hash)).digest()) } : {}),
          ...(own ? { spaceRev: own.space_rev } : {}),
        });
      }

      const hasMore = filtered.length > limit;
      const page = hasMore ? filtered.slice(0, limit) : filtered;
      res.json({
        spaces: page,
        ...(hasMore && page.at(-1) ? { cursor: page.at(-1)!.space } : {}),
      });
    }),
  );

  app.post(
    "/xrpc/com.atproto.space.authorizeSpaceSync",
    json1Mb,
    asyncHandler(async (req, res) => {
      const { space, credentialKey, delegationToken, clientAttestation, notify } = (req.body ?? {}) as {
        space?: string;
        credentialKey?: string;
        delegationToken?: string;
        clientAttestation?: string;
        notify?: { endpoint: string; token: string };
      };
      if (!space || !credentialKey) {
        throw new GroupHostHttpError(400, "InvalidRequest", "space and credentialKey are required.");
      }
      const out = await repoStore.authorizeSpaceSync({
        space,
        credentialKey,
        delegationToken,
        clientAttestation,
        notify,
      });
      res.json(out);
    }),
  );

  const authorizeSpaceRead = async (
    req: Request,
    res: Response,
    spaceUriValue: string,
    repoDid: string,
  ): Promise<{ isSpaceCredential: boolean }> => {
    const { parsed, permRef } = parseSpaceTarget(spaceUriValue);
    const mig = db.prepare("SELECT status FROM source_migration_lease WHERE group_did = ?").get(repoDid) as
      | { status: string }
      | undefined;
    if (mig?.status === "plc_signed") {
      throw new GroupHostHttpError(409, "MigrationCutoverPending");
    }

    const authHeader = req.headers.authorization ?? "";
    if (authHeader.startsWith("Atproto-Space-Credential ")) {
      await repoStore.verifyGroupSpaceCredential({
        spaceUri: spaceUriValue,
        expectedAudienceDid: repoDid,
        method: req.method,
        url: `${requestVerifyOrigin(req)}${req.originalUrl}`,
        headers: flatStringRecord(req.headers),
      });

      const acct = db
        .prepare("SELECT activated, takendown FROM group_account WHERE did = ?")
        .get(repoDid) as { activated: number; takendown: number } | undefined;
      if (!acct) throw new GroupHostHttpError(400, "RepoNotFound");

      // Permit external `<inviteeDid>` `invites/self` sync while in `remote_cleanup_queued`!
      const delRow = db
        .prepare("SELECT status FROM group_deletion_journal WHERE group_did = ?")
        .get(repoDid) as { status: string } | undefined;
      const isExternalInvitesCleanup =
        parsed.authorityDid !== repoDid &&
        parsed.type === ATGRP_SPACE_TYPE.inbox &&
        delRow?.status === "remote_cleanup_queued";

      if (!isExternalInvitesCleanup) {
        if (acct.takendown !== 0 || delRow) throw new GroupHostHttpError(400, "RepoTakendown");
        if (acct.activated !== 1) throw new GroupHostHttpError(400, "RepoDeactivated");
        if (parsed.authorityDid === repoDid) {
          const sp = db
            .prepare("SELECT deleted_at FROM group_space WHERE space_uri = ? AND group_did = ?")
            .get(spaceUriValue, repoDid) as { deleted_at: number | null } | undefined;
          if (!sp) throw new GroupHostHttpError(400, "SpaceNotFound");
          if (sp.deleted_at !== null) throw new GroupHostHttpError(400, "SpaceDeleted");
        }
      }
      return { isSpaceCredential: true };
    }

    const session = await authGroupDpop(req, res);
    if (session.groupDid !== repoDid) {
      throw new GroupHostHttpError(400, "RepoNotFound", `Could not find repo for DID: ${repoDid}`);
    }
    session.permissions.assertSpace(permRef, { action: "read_self" });
    return { isSpaceCredential: false };
  };

  app.get(
    "/xrpc/com.atproto.space.listWriters",
    asyncHandler(async (req, res) => {
      const space = singleQueryString(req, "space");
      if (!space) throw new GroupHostHttpError(400, "InvalidRequest", "space required.");
      const { parsed } = parseSpaceTarget(space);
      const groupDid = parsed.authorityDid;

      const mig = db.prepare("SELECT status FROM source_migration_lease WHERE group_did = ?").get(groupDid) as
        | { status: string }
        | undefined;
      if (mig?.status === "plc_signed") throw new GroupHostHttpError(409, "MigrationCutoverPending");

      await repoStore.verifyGroupSpaceCredential({
        spaceUri: space,
        expectedAudienceDid: groupDid,
        method: req.method,
        url: `${requestVerifyOrigin(req)}${req.originalUrl}`,
        headers: flatStringRecord(req.headers),
      });

      const acct = db
        .prepare("SELECT activated, takendown FROM group_account WHERE did = ?")
        .get(groupDid) as { activated: number; takendown: number } | undefined;
      if (!acct) throw new GroupHostHttpError(400, "SpaceNotFound");
      if (acct.takendown !== 0) throw new GroupHostHttpError(400, "RepoTakendown");
      if (acct.activated !== 1) throw new GroupHostHttpError(400, "RepoDeactivated");

      const sp = db
        .prepare("SELECT deleted_at FROM group_space WHERE space_uri = ? AND group_did = ?")
        .get(space, groupDid) as { deleted_at: number | null } | undefined;
      if (!sp) throw new GroupHostHttpError(400, "SpaceNotFound");
      if (sp.deleted_at !== null) throw new GroupHostHttpError(400, "SpaceDeleted");

      const limit = Math.min(Math.max(queryInt(req, "limit") ?? 100, 1), 1000);
      const cursor = singleQueryString(req, "cursor");
      const rows = db
        .prepare(
          `SELECT writer_did, removed, repo_rev, space_rev, data
           FROM space_writer
           WHERE space_uri = ? AND (removed = 0 OR repo_rev != '') AND (? IS NULL OR space_rev > ?)
           ORDER BY space_rev ASC
           LIMIT ?`,
        )
        .all(space, cursor ?? null, cursor ?? null, limit) as Array<{
        writer_did: string;
        removed: number;
        repo_rev: string;
        space_rev: string;
        data: Buffer | null;
      }>;

      res.json({
        ...(rows.length > 0 && rows.at(-1) ? { cursor: rows.at(-1)!.space_rev } : {}),
        repos: rows.map((w) =>
          w.removed !== 0
            ? {
                $type: "com.atproto.space.defs#repoRemoved",
                repo: w.writer_did,
                spaceRev: w.space_rev,
              }
            : {
                $type: "com.atproto.space.defs#repoWrite",
                repo: w.writer_did,
                repoRev: w.repo_rev,
                spaceRev: w.space_rev,
                data: lexToJson(new Uint8Array(w.data!)),
              },
        ),
      });
    }),
  );

  app.get(
    "/xrpc/com.atproto.space.getRecord",
    asyncHandler(async (req, res) => {
      const space = singleQueryString(req, "space");
      const repo = singleQueryString(req, "repo");
      const collection = singleQueryString(req, "collection");
      const rkey = singleQueryString(req, "rkey");
      if (!space || !repo || !collection || !rkey) {
        throw new GroupHostHttpError(400, "InvalidRequest", "space, repo, collection, and rkey required.");
      }
      const { isSpaceCredential } = await authorizeSpaceRead(req, res, space, repo);

      const row = db
        .prepare(
          "SELECT uri, cid, value, incarnation FROM space_record WHERE space_uri = ? AND repo_did = ? AND collection = ? AND rkey = ?",
        )
        .get(space, repo, collection, rkey) as
        | { uri: string; cid: string; value: string; incarnation: string | null }
        | undefined;
      if (!row) {
        throw new GroupHostHttpError(400, "RecordNotFound", `Could not locate record: ${space}/${repo}/${collection}/${rkey}`);
      }

      const macHeaders = await repoStore.createResponseMacHeaders({
        groupDid: repo,
        profile: RECORD_MAC_PROFILE,
        acceptSignatureHeader:
          typeof req.headers["accept-signature"] === "string" ? req.headers["accept-signature"] : undefined,
        isSpaceCredential,
        recordMeta: { uri: row.uri, cid: row.cid },
      });
      for (const [hk, hv] of Object.entries(macHeaders)) {
        res.setHeader(hk, hv);
      }
      if (collection === ATGRP_COLLECTION.membership && row.incarnation) {
        res.setHeader("Atproto-Membership-Incarnation", row.incarnation);
      }

      res.json({
        uri: row.uri,
        cid: row.cid,
        value: JSON.parse(row.value),
      });
    }),
  );

  app.get(
    "/xrpc/com.atproto.space.listRecords",
    asyncHandler(async (req, res) => {
      const space = singleQueryString(req, "space");
      const repo = singleQueryString(req, "repo");
      const collection = singleQueryString(req, "collection");
      if (!space || !repo) {
        throw new GroupHostHttpError(400, "InvalidRequest", "space and repo required.");
      }
      await authorizeSpaceRead(req, res, space, repo);

      const limit = Math.min(Math.max(queryInt(req, "limit") ?? 50, 1), 1000);
      const cursor = singleQueryString(req, "cursor");
      if (cursor !== undefined && !isAtUriString(cursor)) {
        throw new GroupHostHttpError(400, "InvalidCursor", "Malformed cursor");
      }
      const reverse = singleQueryString(req, "reverse") === "true";
      const excludeValues = singleQueryString(req, "excludeValues") === "true";

      type ListedSpaceRecordRow = {
        collection: string;
        rkey: string;
        uri: string;
        cid: string;
        cbor_bytes: Buffer;
      };

      const rows = reverse
        ? (db
            .prepare(
              `SELECT collection, rkey, uri, cid, cbor_bytes FROM space_record
               WHERE space_uri = ? AND repo_did = ?
                 AND (? IS NULL OR collection = ?)
                 AND (? IS NULL OR uri > ?)
               ORDER BY uri ASC LIMIT ?`,
            )
            .all(
              space,
              repo,
              collection ?? null,
              collection ?? null,
              cursor ?? null,
              cursor ?? null,
              limit,
            ) as ListedSpaceRecordRow[])
        : (db
            .prepare(
              `SELECT collection, rkey, uri, cid, cbor_bytes FROM space_record
               WHERE space_uri = ? AND repo_did = ?
                 AND (? IS NULL OR collection = ?)
                 AND (? IS NULL OR uri < ?)
               ORDER BY uri DESC LIMIT ?`,
            )
            .all(
              space,
              repo,
              collection ?? null,
              collection ?? null,
              cursor ?? null,
              cursor ?? null,
              limit,
            ) as ListedSpaceRecordRow[]);

      const nextCursor = rows.length < limit ? undefined : rows.at(-1)?.uri;
      res.json({
        records: rows.map((r) => ({
          collection: r.collection,
          rkey: r.rkey,
          uri: r.uri,
          cid: r.cid,
          ...(excludeValues ? {} : { value: lexToJson(cborDecode(new Uint8Array(r.cbor_bytes))) }),
        })),
        ...(nextCursor !== undefined ? { cursor: nextCursor } : {}),
      });
    }),
  );

  app.get(
    "/xrpc/com.atproto.space.getLatestCommit",
    asyncHandler(async (req, res) => {
      const space = singleQueryString(req, "space");
      const repo = singleQueryString(req, "repo");
      if (!space || !repo) throw new GroupHostHttpError(400, "InvalidRequest", "space and repo required.");
      const { isSpaceCredential } = await authorizeSpaceRead(req, res, space, repo);

      const repoRow = db
        .prepare("SELECT set_hash, rev FROM space_repo WHERE space_uri = ? AND repo_did = ?")
        .get(space, repo) as { set_hash: Buffer; rev: string } | undefined;
      if (!repoRow) {
        throw new GroupHostHttpError(400, "RepoNotFound", `Could not find repo for space: ${space}`);
      }
      const commit = RepoCommit.fromState(new Uint8Array(repoRow.set_hash)).toCommit({
        space: space as SpaceRefString,
        repo: repo as DidString,
        rev: repoRow.rev,
      });

      const macHeaders = await repoStore.createResponseMacHeaders({
        groupDid: repo,
        profile: COMMIT_MAC_PROFILE,
        acceptSignatureHeader:
          typeof req.headers["accept-signature"] === "string" ? req.headers["accept-signature"] : undefined,
        isSpaceCredential,
        commitMeta: commit,
      });
      for (const [hk, hv] of Object.entries(macHeaders)) {
        res.setHeader(hk, hv);
      }

      res.json({
        commit: {
          ver: commit.ver,
          space: commit.space,
          repo: commit.repo,
          rev: commit.rev,
          data: lexToJson(commit.data),
        },
      });
    }),
  );

  app.get(
    "/xrpc/com.atproto.space.listRepoOps",
    asyncHandler(async (req, res) => {
      const space = singleQueryString(req, "space");
      const repo = singleQueryString(req, "repo");
      if (!space || !repo) throw new GroupHostHttpError(400, "InvalidRequest", "space and repo required.");
      const { isSpaceCredential } = await authorizeSpaceRead(req, res, space, repo);

      const repoRow = db
        .prepare("SELECT set_hash, rev FROM space_repo WHERE space_uri = ? AND repo_did = ?")
        .get(space, repo) as { set_hash: Buffer; rev: string } | undefined;
      if (!repoRow) {
        throw new GroupHostHttpError(400, "RepoNotFound", `Could not find repo for space: ${space}`);
      }
      const commit = RepoCommit.fromState(new Uint8Array(repoRow.set_hash)).toCommit({
        space: space as SpaceRefString,
        repo: repo as DidString,
        rev: repoRow.rev,
      });

      const since = singleQueryString(req, "since");
      const cursorParam = singleQueryString(req, "cursor");
      const excludeValues = singleQueryString(req, "excludeValues") === "true";
      const limit = Math.min(Math.max(queryInt(req, "limit") ?? 100, 1), 1000);

      let cursorRev: string | null = null;
      let cursorIdx = -1;
      if (cursorParam !== undefined) {
        const [r, iStr] = cursorParam.split("/");
        const idxNum = Number.parseInt(iStr ?? "", 10);
        if (!r || !Number.isSafeInteger(idxNum)) {
          throw new GroupHostHttpError(400, "InvalidCursor", "Malformed listRepoOps cursor.");
        }
        cursorRev = r;
        cursorIdx = idxNum;
      }

      const opRows = cursorRev
        ? (db
            .prepare(
              `SELECT rev, idx, collection, rkey, cid, prev FROM space_oplog
               WHERE space_uri = ? AND repo_did = ?
                 AND (? IS NULL OR rev > ?)
                 AND (rev > ? OR (rev = ? AND idx > ?))
               ORDER BY rev ASC, idx ASC
               LIMIT ?`,
            )
            .all(space, repo, since ?? null, since ?? null, cursorRev, cursorRev, cursorIdx, limit) as Array<{
            rev: string;
            idx: number;
            collection: string;
            rkey: string;
            cid: string | null;
            prev: string | null;
          }>)
        : (db
            .prepare(
              `SELECT rev, idx, collection, rkey, cid, prev FROM space_oplog
               WHERE space_uri = ? AND repo_did = ?
                 AND (? IS NULL OR rev > ?)
               ORDER BY rev ASC, idx ASC
               LIMIT ?`,
            )
            .all(space, repo, since ?? null, since ?? null, limit) as Array<{
            rev: string;
            idx: number;
            collection: string;
            rkey: string;
            cid: string | null;
            prev: string | null;
          }>);

      const ops = opRows.map((op) => {
        let val: unknown = undefined;
        if (!excludeValues && op.cid !== null) {
          const recRow = db
            .prepare(
              "SELECT cid, cbor_bytes FROM space_record WHERE space_uri = ? AND repo_did = ? AND collection = ? AND rkey = ?",
            )
            .get(space, repo, op.collection, op.rkey) as { cid: string; cbor_bytes: Buffer } | undefined;
          if (recRow && recRow.cid === op.cid) {
            val = lexToJson(cborDecode(recRow.cbor_bytes));
          }
        }
        return {
          rev: op.rev,
          collection: op.collection,
          rkey: op.rkey,
          cid: op.cid ?? null,
          prev: op.prev ?? null,
          ...(val !== undefined ? { value: val } : {}),
        };
      });

      const last = opRows.at(-1);
      const nextCursor = last && opRows.length === limit ? `${last.rev}/${last.idx}` : undefined;

      const macHeaders = await repoStore.createResponseMacHeaders({
        groupDid: repo,
        profile: COMMIT_MAC_PROFILE,
        acceptSignatureHeader:
          typeof req.headers["accept-signature"] === "string" ? req.headers["accept-signature"] : undefined,
        isSpaceCredential,
        commitMeta: commit,
      });
      for (const [hk, hv] of Object.entries(macHeaders)) {
        res.setHeader(hk, hv);
      }

      res.json({
        ops,
        ...(nextCursor ? { cursor: nextCursor } : {}),
        commit: {
          ver: commit.ver,
          space: commit.space,
          repo: commit.repo,
          rev: commit.rev,
          data: lexToJson(commit.data),
        },
      });
    }),
  );

  app.get(
    "/xrpc/com.atproto.space.getRepo",
    asyncHandler(async (req, res) => {
      const space = singleQueryString(req, "space");
      const repo = singleQueryString(req, "repo");
      if (!space || !repo) throw new GroupHostHttpError(400, "InvalidRequest", "space and repo required.");
      const { isSpaceCredential } = await authorizeSpaceRead(req, res, space, repo);

      const { commit, starBytes } = await repoStore.exportSpaceRepoStarBytes(space, repo);
      const macHeaders = await repoStore.createResponseMacHeaders({
        groupDid: repo,
        profile: COMMIT_MAC_PROFILE,
        acceptSignatureHeader:
          typeof req.headers["accept-signature"] === "string" ? req.headers["accept-signature"] : undefined,
        isSpaceCredential,
        commitMeta: commit,
      });
      for (const [hk, hv] of Object.entries(macHeaders)) {
        res.setHeader(hk, hv);
      }
      res.setHeader("Content-Type", "application/vnd.dasl.star");
      res.send(Buffer.from(starBytes));
    }),
  );

  app.get(
    "/xrpc/com.atproto.space.getBlob",
    asyncHandler(async (req, res) => {
      const space = singleQueryString(req, "space");
      const repo = singleQueryString(req, "repo");
      const cid = singleQueryString(req, "cid");
      if (!space || !repo || !cid) {
        throw new GroupHostHttpError(400, "InvalidRequest", "space, repo, and cid required.");
      }
      await authorizeSpaceRead(req, res, space, repo);
      const refRow = db
        .prepare("SELECT 1 AS ok FROM space_record_blob WHERE group_did = ? AND space_uri = ? AND blob_cid = ?")
        .get(repo, space, cid);
      const blobRow = db
        .prepare("SELECT mime_type, bytes, quarantined FROM blob_store WHERE group_did = ? AND cid = ?")
        .get(repo, cid) as { mime_type: string; bytes: Buffer; quarantined: number } | undefined;
      if (!refRow || !blobRow || blobRow.quarantined !== 0) {
        throw new GroupHostHttpError(400, "BlobNotFound", `Blob not found in space: ${cid}`);
      }
      res.setHeader("Content-Type", blobRow.mime_type || "application/octet-stream");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.send(blobRow.bytes);
    }),
  );

  app.get(
    "/xrpc/com.atproto.space.listBlobs",
    asyncHandler(async (req, res) => {
      const space = singleQueryString(req, "space");
      const repo = singleQueryString(req, "repo");
      if (!space || !repo) throw new GroupHostHttpError(400, "InvalidRequest", "space and repo required.");
      await authorizeSpaceRead(req, res, space, repo);
      const limit = Math.min(Math.max(queryInt(req, "limit") ?? 500, 1), 1000);
      const cursor = singleQueryString(req, "cursor");
      const rows = db
        .prepare(
          `SELECT DISTINCT blob_cid AS cid FROM space_record_blob
           WHERE group_did = ? AND space_uri = ? AND (? IS NULL OR blob_cid > ?)
           ORDER BY blob_cid ASC LIMIT ?`,
        )
        .all(repo, space, cursor ?? null, cursor ?? null, limit + 1) as Array<{ cid: string }>;
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      res.json({
        cids: page.map((r) => r.cid),
        ...(hasMore && page.at(-1) ? { cursor: page.at(-1)!.cid } : {}),
      });
    }),
  );

  app.post(
    "/xrpc/com.atproto.space.notifyRepoUpdate",
    json1Mb,
    asyncHandler(async (req, res) => {
      const { space, repo, repoRev, data } = (req.body ?? {}) as {
        space?: string;
        repo?: string;
        repoRev?: string;
        data?: unknown;
      };
      if (!space || !repo || !repoRev || data === undefined) {
        throw new GroupHostHttpError(400, "InvalidRequest", "space, repo, repoRev, and data are required.");
      }
      const { parsed } = parseSpaceTarget(space);
      const groupDid = parsed.authorityDid;

      const rawJwt = extractBearerToken(req.headers.authorization);
      if (!rawJwt) throw new GroupHostHttpError(401, "AuthMissing", "Service JWT required.");
      const jwtParts = parseServiceJwtParts(rawJwt);
      const bareIss = jwtParts.payload.iss.split("#", 1)[0]!;
      if (bareIss !== repo) {
        throw new GroupHostHttpError(403, "Forbidden", "Notification iss does not match repo.");
      }
      if (jwtParts.payload.lxm !== "com.atproto.space.notifyRepoUpdate") {
        throw new GroupHostHttpError(401, "InvalidToken", "Invalid notifyRepoUpdate lxm.");
      }
      if (jwtParts.payload.aud !== groupDid && jwtParts.payload.aud !== spaceHostAud(groupDid as DidString)) {
        throw new GroupHostHttpError(403, "Forbidden", "Notification aud does not match space authority.");
      }
      const nowSec = Math.floor(Date.now() / 1000);
      if (jwtParts.payload.exp <= nowSec) {
        throw new GroupHostHttpError(401, "ExpiredToken", "Service JWT expired.");
      }
      if (
        jwtParts.payload.iat !== undefined &&
        (jwtParts.payload.iat > nowSec + 5 || jwtParts.payload.exp <= jwtParts.payload.iat)
      ) {
        throw new GroupHostHttpError(401, "InvalidToken", "Invalid notifyRepoUpdate JWT iat/exp bounds.");
      }

      const sigKey = await plc.resolveSigningKey(bareIss, "#atproto");
      const sigOk = await cryptoVerifySignatureWithKey(
        sigKey,
        jwtParts.signingInput,
        jwtParts.sigBytes,
        jwtParts.header.alg,
      ).catch(() => false);
      if (!sigOk) {
        throw new GroupHostHttpError(401, "InvalidSignature", "Invalid notifyRepoUpdate JWT signature.");
      }

      await repoStore.handleNotifyRepoUpdate({
        space,
        repo,
        repoRev,
        dataInput: data,
      });
      res.status(200).end();
    }),
  );

  app.post(
    "/xrpc/com.atproto.space.notifyCredentialsRevoked",
    json1Mb,
    asyncHandler(async (req, res) => {
      const parsedBody = assertAtgrpXrpcInput("com.atproto.space.notifyCredentialsRevoked", req.body) as {
        space: string;
        credentials: string[];
      };
      const { space, credentials } = parsedBody;
      if (
        typeof space !== "string" ||
        !Array.isArray(credentials) ||
        credentials.length < 1 ||
        credentials.length > 100 ||
        credentials.some((c) => typeof c !== "string" || c.length < 1 || c.length > 256)
      ) {
        throw new GroupHostHttpError(
          400,
          "InvalidRequest",
          "space and credentials array of 1..100 strings (1..256 chars) required.",
        );
      }
      const { parsed } = parseSpaceTarget(space);
      const rawJwt = extractBearerToken(req.headers.authorization);
      if (!rawJwt) throw new GroupHostHttpError(401, "AuthMissing", "Service JWT required.");
      const jwtParts = parseServiceJwtParts(rawJwt);
      const nowMs = Date.now();
      const nowSec = Math.floor(nowMs / 1000);
      const bareIss = jwtParts.payload.iss.split("#", 1)[0]!;
      const iat = jwtParts.payload.iat;
      const exp = jwtParts.payload.exp;
      const jti = jwtParts.payload.jti;
      if (
        jwtParts.header.typ !== "JWT" ||
        (jwtParts.header.alg !== "ES256" && jwtParts.header.alg !== "ES256K") ||
        !isDid(bareIss) ||
        bareIss !== parsed.authorityDid ||
        !isDid(jwtParts.payload.aud) ||
        jwtParts.payload.aud.includes("#") ||
        jwtParts.payload.lxm !== "com.atproto.space.notifyCredentialsRevoked" ||
        typeof iat !== "number" ||
        !Number.isFinite(iat) ||
        iat > nowSec + 5 ||
        typeof exp !== "number" ||
        !Number.isFinite(exp) ||
        exp <= nowSec ||
        exp - iat <= 0 ||
        exp - iat > 60 ||
        typeof jti !== "string" ||
        jti.length < 1 ||
        jti.length > 256 ||
        jti.trim().length === 0
      ) {
        throw new GroupHostHttpError(401, "InvalidToken", "Invalid notifyCredentialsRevoked JWT.");
      }
      const hostedAcct = db
        .prepare("SELECT did, activated, takendown FROM group_account WHERE did = ?")
        .get(jwtParts.payload.aud) as { did: string; activated: number; takendown: number } | undefined;
      if (!hostedAcct || hostedAcct.takendown !== 0 || hostedAcct.activated !== 1) {
        throw new GroupHostHttpError(403, "Forbidden", "Audience is not an active hosted group DID.");
      }

      if (bareIss !== hostedAcct.did) {
        const hasLocalRepo = db
          .prepare("SELECT 1 AS ok FROM space_repo WHERE space_uri = ? AND repo_did = ?")
          .get(space, hostedAcct.did);
        if (!hasLocalRepo) {
          throw new GroupHostHttpError(403, "Forbidden", "Hosted group has no repository in the target space.");
        }
      } else {
        const ownSpace = db
          .prepare("SELECT deleted_at FROM group_space WHERE space_uri = ? AND group_did = ?")
          .get(space, hostedAcct.did) as { deleted_at: number | null } | undefined;
        if (!ownSpace || ownSpace.deleted_at !== null) {
          throw new GroupHostHttpError(403, "Forbidden", "Target space does not exist for hosted group.");
        }
      }

      const sigKey = await plc.resolveSigningKey(bareIss, "#atproto");
      const sigOk = await cryptoVerifySignatureWithKey(
        sigKey,
        jwtParts.signingInput,
        jwtParts.sigBytes,
        jwtParts.header.alg,
      ).catch(() => false);
      if (!sigOk) {
        throw new GroupHostHttpError(401, "InvalidSignature", "Invalid notifyCredentialsRevoked signature.");
      }

      repoStore.handleNotifyCredentialsRevokedSync({
        hostedGroupDid: hostedAcct.did,
        issuerDid: bareIss,
        serviceJwtJti: jti,
        serviceJwtExpSec: exp,
        space,
        credentials,
        nowMs,
      });
      res.status(200).end();
    }),
  );

  // =========================================================================
  // `/xrpc/org.atgrp.*` & `/xrpc/org.atgrp.mod.*`
  // =========================================================================

  const checkModSubmissionRate = createModSubmissionRateLimiter();

  app.post(
    `/xrpc/${ATGRP_METHOD.requestJoin}`,
    json1Mb,
    asyncHandler(async (req, res) => {
      const parsedBody = assertAtgrpXrpcInput(ATGRP_METHOD.requestJoin, req.body, {
        preserveInviteSemanticError: true,
      }) as {
        group: string;
        invite?: string;
        message?: string;
      };
      const { group, invite, message } = parsedBody;
      if (!isDid(group)) {
        throw new GroupHostHttpError(400, "InvalidRequest", "group DID is required.");
      }
      const jwt = await verifyPersonalServiceJwt({
        db,
        cryptoBox,
        plc,
        authorization: req.headers.authorization,
        groupDid: group,
        expectedLxm: ATGRP_METHOD.requestJoin,
      });
      const idempotencyKey =
        typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"] : undefined;
      const out = await methods.executeRequestJoin({
        callerDid: jwt.iss,
        groupDid: group,
        invite,
        message,
        idempotencyKey,
      });
      res.json(out);
    }),
  );

  app.post(
    `/xrpc/${ATGRP_METHOD.cancelJoinRequest}`,
    json1Mb,
    asyncHandler(async (req, res) => {
      const { group } = assertAtgrpXrpcInput(ATGRP_METHOD.cancelJoinRequest, req.body) as {
        group: string;
      };
      if (!isDid(group)) {
        throw new GroupHostHttpError(400, "InvalidRequest", "group DID is required.");
      }
      const jwt = await verifyPersonalServiceJwt({
        db,
        cryptoBox,
        plc,
        authorization: req.headers.authorization,
        groupDid: group,
        expectedLxm: ATGRP_METHOD.cancelJoinRequest,
      });
      await methods.executeCancelJoinRequest({
        callerDid: jwt.iss,
        groupDid: group,
      });
      res.status(200).end();
    }),
  );

  app.post(
    `/xrpc/${ATGRP_METHOD.leaveGroup}`,
    json1Mb,
    asyncHandler(async (req, res) => {
      const { group } = assertAtgrpXrpcInput(ATGRP_METHOD.leaveGroup, req.body) as {
        group: string;
      };
      if (!isDid(group)) {
        throw new GroupHostHttpError(400, "InvalidRequest", "group DID is required.");
      }
      const jwt = await verifyPersonalServiceJwt({
        db,
        cryptoBox,
        plc,
        authorization: req.headers.authorization,
        groupDid: group,
        expectedLxm: ATGRP_METHOD.leaveGroup,
      });
      const ifMatchIncarnation =
        typeof req.headers["if-match-membership-incarnation"] === "string"
          ? req.headers["if-match-membership-incarnation"]
          : undefined;
      await methods.executeLeaveGroup({
        callerDid: jwt.iss,
        groupDid: group,
        ifMatchIncarnation,
      });
      res.status(200).end();
    }),
  );

  app.get(
    `/xrpc/${ATGRP_METHOD.listJoinRequests}`,
    asyncHandler(async (req, res) => {
      const session = await authGroupDpop(req, res, ATGRP_METHOD.listJoinRequests);
      const mig = db.prepare("SELECT status FROM source_migration_lease WHERE group_did = ?").get(session.groupDid) as
        | { status: string }
        | undefined;
      if (mig?.status === "plc_signed") throw new GroupHostHttpError(409, "MigrationCutoverPending");
      session.permissions.assertRpc({
        aud: `${session.groupDid}#atproto_pds` as `${DidString}#${string}`,
        lxm: ATGRP_METHOD.listJoinRequests as NsidString,
      });
      const { limit, cursor } = assertAtgrpXrpcParams(ATGRP_METHOD.listJoinRequests, req, {
        intKeys: ["limit"],
      }) as { limit?: number; cursor?: string };
      res.json(methods.executeListJoinRequests({ groupDid: session.groupDid, limit, cursor }));
    }),
  );

  app.post(
    `/xrpc/${ATGRP_METHOD.denyJoinRequest}`,
    json1Mb,
    asyncHandler(async (req, res) => {
      const session = await authGroupDpop(req, res, ATGRP_METHOD.denyJoinRequest);
      session.permissions.assertRpc({
        aud: `${session.groupDid}#atproto_pds` as `${DidString}#${string}`,
        lxm: ATGRP_METHOD.denyJoinRequest as NsidString,
      });
      const { member } = assertAtgrpXrpcInput(ATGRP_METHOD.denyJoinRequest, req.body) as {
        member: string;
      };
      if (!isDid(member)) {
        throw new GroupHostHttpError(400, "InvalidRequest", "member DID is required.");
      }
      await methods.executeDenyJoinRequest({ groupDid: session.groupDid, memberDid: member, session });
      res.status(200).end();
    }),
  );

  app.post(
    `/xrpc/${ATGRP_METHOD.modSubmitReport}`,
    json1Mb,
    asyncHandler(async (req, res) => {
      const { group, subject, cid, reasonType, reason, rule } = assertAtgrpXrpcInput(
        ATGRP_METHOD.modSubmitReport,
        req.body,
        { preserveSubjectSemanticError: true },
      ) as {
        group: string;
        subject: string;
        cid?: string;
        reasonType: string;
        reason?: string;
        rule?: string;
      };
      if (!isDid(group)) {
        throw new GroupHostHttpError(400, "InvalidRequest", "group DID is required.");
      }
      const jwt = await verifyPersonalServiceJwt({
        db,
        cryptoBox,
        plc,
        authorization: req.headers.authorization,
        groupDid: group,
        expectedLxm: ATGRP_METHOD.modSubmitReport,
      });
      checkModSubmissionRate(jwt.iss);
      const out = await services.locks.withGroupRepoLock(group, () =>
        executeSubmitReportSync(db, {
          callerDid: jwt.iss,
          groupDid: group,
          subject,
          cid,
          reasonType,
          reason,
          rule,
        }),
      );
      res.json(out);
    }),
  );

  app.post(
    `/xrpc/${ATGRP_METHOD.modSubmitAppeal}`,
    json1Mb,
    asyncHandler(async (req, res) => {
      const { group, subject, note } = assertAtgrpXrpcInput(
        ATGRP_METHOD.modSubmitAppeal,
        req.body,
        { preserveSubjectSemanticError: true },
      ) as {
        group: string;
        subject: string;
        note?: string;
      };
      if (!isDid(group)) {
        throw new GroupHostHttpError(400, "InvalidRequest", "group DID is required.");
      }
      const jwt = await verifyPersonalServiceJwt({
        db,
        cryptoBox,
        plc,
        authorization: req.headers.authorization,
        groupDid: group,
        expectedLxm: ATGRP_METHOD.modSubmitAppeal,
      });
      checkModSubmissionRate(jwt.iss);
      const out = await services.locks.withGroupRepoLock(group, () =>
        executeSubmitAppealSync(db, {
          callerDid: jwt.iss,
          groupDid: group,
          subject,
          note,
        }),
      );
      res.json(out);
    }),
  );

  app.get(
    `/xrpc/${ATGRP_METHOD.modQuerySubjects}`,
    asyncHandler(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const session = await authGroupDpop(req, res, ATGRP_METHOD.modQuerySubjects);
      const mig = db.prepare("SELECT status FROM source_migration_lease WHERE group_did = ?").get(session.groupDid) as
        | { status: string }
        | undefined;
      if (mig?.status === "plc_signed") throw new GroupHostHttpError(409, "MigrationCutoverPending");
      session.permissions.assertRpc({
        aud: `${session.groupDid}#atproto_pds` as `${DidString}#${string}`,
        lxm: ATGRP_METHOD.modQuerySubjects as NsidString,
      });
      const { status, tags, sort, limit, cursor } = assertAtgrpXrpcParams(ATGRP_METHOD.modQuerySubjects, req, {
        intKeys: ["limit"],
        arrayKeys: ["tags"],
      }) as {
        status?: "open" | "resolved";
        tags?: string[];
        sort?: string;
        limit?: number;
        cursor?: string;
      };
      res.json(executeQueryModSubjects(db, { groupDid: session.groupDid, status, tags, sort, limit, cursor }));
    }),
  );

  app.get(
    `/xrpc/${ATGRP_METHOD.modQuerySubjectHistory}`,
    asyncHandler(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const session = await authGroupDpop(req, res, ATGRP_METHOD.modQuerySubjectHistory);
      const mig = db.prepare("SELECT status FROM source_migration_lease WHERE group_did = ?").get(session.groupDid) as
        | { status: string }
        | undefined;
      if (mig?.status === "plc_signed") throw new GroupHostHttpError(409, "MigrationCutoverPending");
      session.permissions.assertRpc({
        aud: `${session.groupDid}#atproto_pds` as `${DidString}#${string}`,
        lxm: ATGRP_METHOD.modQuerySubjectHistory as NsidString,
      });
      const { subject, cid, sort, limit, cursor } = assertAtgrpXrpcParams(
        ATGRP_METHOD.modQuerySubjectHistory,
        req,
        { intKeys: ["limit"], preserveSubjectSemanticError: true },
      ) as {
        subject: string;
        cid?: string;
        sort?: string;
        limit?: number;
        cursor?: string;
      };
      res.json(executeQuerySubjectHistory(db, { groupDid: session.groupDid, subject, cid, sort, limit, cursor }));
    }),
  );

  app.get(
    `/xrpc/${ATGRP_METHOD.modQuerySelfHistory}`,
    asyncHandler(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const { group, subject, sort, limit, cursor } = assertAtgrpXrpcParams(
        ATGRP_METHOD.modQuerySelfHistory,
        req,
        { intKeys: ["limit"], preserveSubjectSemanticError: true },
      ) as {
        group: string;
        subject?: string;
        sort?: string;
        limit?: number;
        cursor?: string;
      };
      if (!isDid(group)) {
        throw new GroupHostHttpError(400, "InvalidRequest", "group DID is required.");
      }
      const mig = db.prepare("SELECT status FROM source_migration_lease WHERE group_did = ?").get(group) as
        | { status: string }
        | undefined;
      if (mig?.status === "plc_signed") throw new GroupHostHttpError(409, "MigrationCutoverPending");
      const jwt = await verifyPersonalServiceJwt({
        db,
        cryptoBox,
        plc,
        authorization: req.headers.authorization,
        groupDid: group,
        expectedLxm: ATGRP_METHOD.modQuerySelfHistory,
      });
      res.json(
        executeQuerySelfHistory(db, {
          callerDid: jwt.iss,
          groupDid: group,
          subject,
          sort,
          limit,
          cursor,
        }),
      );
    }),
  );

  app.post(
    `/xrpc/${ATGRP_METHOD.modUpdateSubject}`,
    json1Mb,
    asyncHandler(async (req, res) => {
      const session = await authGroupDpop(req, res, ATGRP_METHOD.modUpdateSubject);
      session.permissions.assertRpc({
        aud: `${session.groupDid}#atproto_pds` as `${DidString}#${string}`,
        lxm: ATGRP_METHOD.modUpdateSubject as NsidString,
      });
      const { subject, cid, status, note, addTags, removeTags } = assertAtgrpXrpcInput(
        ATGRP_METHOD.modUpdateSubject,
        req.body,
        { preserveSubjectSemanticError: true },
      ) as {
        subject: string;
        cid?: string;
        status?: "open" | "resolved";
        note?: string;
        addTags?: string[];
        removeTags?: string[];
      };
      const out = await services.locks.withGroupRepoLock(session.groupDid, () =>
        executeUpdateModSubjectSync(db, {
          groupDid: session.groupDid,
          actorDid: session.authorizingUserDid,
          session,
          subject,
          cid,
          status,
          note,
          addTags,
          removeTags,
        }),
      );
      res.json(out);
    }),
  );

  // =========================================================================
  // Error Handler
  // =========================================================================

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    void _next;
    if (res.headersSent) return;

    const freshNonce = cryptoBox.createDpopNonce();
    res.setHeader("DPoP-Nonce", freshNonce);

    if (err instanceof OAuthProtocolError) {
      if (err.wwwAuthenticate) {
        res.setHeader("WWW-Authenticate", err.wwwAuthenticate);
      }
      if (req.path.startsWith("/oauth/")) {
        res.status(err.status).json({
          error: err.oauthError,
          error_description: err.errorDescription,
        });
        return;
      }
      res.status(err.status).json({
        error: err.oauthError,
        message: err.errorDescription,
      });
      return;
    }

    if (err instanceof GroupHostHttpError) {
      res.status(err.status).json({
        error: err.code,
        message: err.message,
      });
      return;
    }

    if (err instanceof InvalidScopeError || err instanceof InvalidSpacePolicyScopeError) {
      res.status(err.status).json({
        error: err.code,
        message: err.message,
      });
      return;
    }

    if (
      err &&
      typeof err === "object" &&
      "type" in err &&
      (err as { type?: string }).type === "entity.too.large"
    ) {
      res.status(413).json({
        error: "PayloadTooLarge",
        message: "Request body exceeded size limit.",
      });
      return;
    }

    res.status(500).json({
      error: "InternalServerError",
      message: err instanceof Error ? err.message : "Unexpected server error.",
    });
  });

  return app;
}

import { tidNow } from "@flock/protocol/keys";
function tidNowFallback(): string {
  return tidNow();
}

export async function startGroupHostServer(overrides: Partial<GroupHostConfig> = {}): Promise<RunningGroupHost> {
  const allowLoopback =
    overrides.allowLoopback ??
    ((process.env.NODE_ENV !== "production" || process.env.ATPROTO_ACCEPTANCE_TEST === "true") &&
      process.env.ALLOW_LOOPBACK !== "false");
  const rawPublicUrl = overrides.publicUrl ?? process.env.GROUP_HOST_URL ?? "http://127.0.0.1:3004";
  const initialPublicUrl = normalizeGroupHostPublicUrl(rawPublicUrl, allowLoopback);
  if (
    overrides.port !== undefined &&
    (!Number.isSafeInteger(overrides.port) || overrides.port < 0 || overrides.port > 65535)
  ) {
    throw new Error(`Invalid Group Host port: ${String(overrides.port)}`);
  }
  const envPort = parseGroupHostPortEnv(process.env.GROUP_HOST_PORT);
  const requestedPort =
    overrides.port ??
    envPort ??
    (initialPublicUrl.port
      ? Number(initialPublicUrl.port)
      : initialPublicUrl.protocol === "https:"
        ? 443
        : 3004);

  const normalizedHost = initialPublicUrl.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const bindHost =
    !isLoopbackHostname(normalizedHost) && initialPublicUrl.protocol === "https:"
      ? "0.0.0.0"
      : normalizedHost === "::1"
        ? "::1"
        : "127.0.0.1";

  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, bindHost, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo;
  const actualPort = addr.port;
  const shouldRewriteEphemeralLoopbackUrl =
    requestedPort === 0 && initialPublicUrl.protocol === "http:" && isLoopbackHostname(normalizedHost);
  const effectiveOverrides: Partial<GroupHostConfig> = shouldRewriteEphemeralLoopbackUrl
    ? {
        ...overrides,
        port: actualPort,
        publicUrl:
          normalizedHost === "::1"
            ? `http://[::1]:${actualPort}`
            : `http://127.0.0.1:${actualPort}`,
      }
    : { ...overrides, port: actualPort };

  let services: Awaited<ReturnType<typeof createGroupHostServices>>;
  try {
    services = await createGroupHostServices(effectiveOverrides);
  } catch (err) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw err;
  }

  const app = await createGroupHostApp(services);
  server.on("request", app);
  const actualUrl = services.config.publicUrl;

  const flushBackgroundWork = async () => {
    await services.repoStore.flushOutboxNotices().catch(() => undefined);
    await services.migration.sweepExpiredPreparedMigrationLeases().catch(() => undefined);
    await services.migration.sweepExpiredMigrationSessions().catch(() => undefined);
    try {
      pruneExpiredHostState(services.db);
    } catch {
      // Isolate synchronous host-state pruning failures from remaining sweeps
    }
    await services.oauth.compensateStaleCreationJournals().catch(() => undefined);

    // Resume any interrupted `group_deletion_journal` rows without head-of-line starvation!
    await services.repoStore.sweepIncompleteDeletionJournals().catch(() => undefined);
  };

  // Initial startup sweep
  await flushBackgroundWork().catch(() => undefined);

  const outboxTimer = setInterval(() => {
    services.repoStore.flushOutboxNotices().catch(() => undefined);
  }, 500);
  outboxTimer.unref();

  const maintenanceTimer = setInterval(() => {
    flushBackgroundWork().catch(() => undefined);
  }, 60_000);
  maintenanceTimer.unref();

  let closed = false;
  return {
    app,
    server,
    url: actualUrl,
    port: actualPort,
    ...services,
    flushBackgroundWork,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(outboxTimer);
      clearInterval(maintenanceTimer);
      await services.migration.flushPendingTargetAborts().catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      services.db.close();
    },
  };
}
