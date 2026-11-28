import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { P256Keypair } from "@atproto/crypto";
import { type LexMap } from "@atproto/lex-data";
import { ScopePermissions } from "@atproto/oauth-scopes";
import { Repo } from "@atproto/repo";
import { RepoCommit, serializeRecord } from "@atproto/space";
import type { DidString, NsidString, RecordKeyString } from "@atproto/syntax";
import { createServiceJwt, cryptoVerifySignatureWithKey } from "@atproto/xrpc-server";
import {
  assureValidOp,
  formatAtprotoOp,
  signOperation,
  type CompatibleOpOrTombstone,
  type Operation,
  type UnsignedOperation,
} from "@did-plc/lib";
import { boundedSafeFetch, BOUNDED_FETCH_PROFILES, type SafeFetch } from "@flock/net/safe-fetch";
import { readUpstreamJson } from "@flock/protocol/bounded-json";
import {
  groupMembersUri,
  groupMetaUri,
  isDid,
  parseSpaceUri,
  SELF_SKEY,
} from "@flock/protocol/keys";
import {
  computeCanonicalMigrationManifest,
  verifyMigrationManifestDigest,
  type MigrationSpaceManifestEntry,
} from "@flock/protocol/migration-manifest";
import {
  ATGRP_COLLECTION,
  ATGRP_POLICY,
  ATGRP_SPACE_TYPE,
  ATPROTO_SPACE_COLLECTION,
  FLOCK_EXTENSION_FIELD,
  FLOCK_GROUP_METHOD,
  REPO_COLLECTION,
} from "@flock/protocol/nsids";
import {
  canonicalAtgrpPolicyKey,
  validatePublicRecord,
  validateSpacePolicy,
  validateSpaceRecord,
  validateSpaceTypeKey,
} from "@flock/protocol/registry";
import {
  effectiveHumanAdmins,
  expandGroupScopes,
  groupAdminScopes,
  type GroupAtgrpPolicy,
} from "@flock/protocol/scopes";
import { bytesToHex } from "@noble/hashes/utils";
import * as jose from "jose";
import { groupHostPdsServiceEndpoint, type GroupHostConfig } from "./config";
import {
  plainJsonToLexData as jsonToLex,
  sha256HexBytes,
  type GroupHostCryptoBox,
  type ServiceSigningMaterial,
} from "./crypto-box";
import { purgeMigrationStagingDataSync, type GroupHostDb } from "./db";
import { extractBearerToken, isValidIdempotencyKey, parseServiceJwtParts } from "./methods";
import {
  assertFreshLoginStepUp,
  EffectiveSessionPermissions,
  normalizeAndValidateGroupHandle,
  revalidateLiveOAuthSessionSync,
  type AuthenticatedGroupSession,
} from "./oauth";
import {
  GroupHostHttpError,
  isSupportedPlcRotationDidKey,
  normalizeOriginUrl,
  plcCidForOp,
  plcOpRotationKeys,
  type PlcAndDidResolver,
} from "./plc";
import {
  assertPostGovernanceInvariants,
  effectiveStateForSession,
  hasActiveSourceMigrationLease,
  humanMemberships,
  isAuthorizedLifecycleAdmin,
  loadLiveGovernanceState,
  reapExpiredPreparedMigrationLease,
  registerPreparedLeaseReapHook,
  type GroupRepoLockManager,
  type ReapedPreparedLease,
  type RecoveryAdminRow,
} from "./rbac";
import { nextMonotonicTid, SqlStagingRepoStorage, type GroupRepoStore } from "./repo-store";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * Exact 16 protected methods from `@atproto/pds` `pipethrough.ts:721-738`
 * PLUS `com.atproto.server.deleteAccount` and `com.atproto.identity.submitPlcOperation`.
 */
export const PROTECTED_SERVICE_AUTH_METHODS = new Set<string>([
  "com.atproto.admin.sendEmail",
  "com.atproto.identity.requestPlcOperationSignature",
  "com.atproto.identity.signPlcOperation",
  "com.atproto.identity.submitPlcOperation",
  "com.atproto.identity.updateHandle",
  "com.atproto.server.activateAccount",
  "com.atproto.server.confirmEmail",
  "com.atproto.server.createAppPassword",
  "com.atproto.server.deactivateAccount",
  "com.atproto.server.deleteAccount",
  "com.atproto.server.getAccountInviteCodes",
  "com.atproto.server.getSession",
  "com.atproto.server.listAppPasswords",
  "com.atproto.server.requestAccountDelete",
  "com.atproto.server.requestEmailConfirmation",
  "com.atproto.server.requestEmailUpdate",
  "com.atproto.server.revokeAppPassword",
  "com.atproto.server.updateEmail",
]);

export type AuthenticatedMigrationSession = {
  kind: "migration";
  id: string;
  groupDid: string;
  presentedJti: string;
  expSec: number;
  mode: "coordinated" | "standard";
  operationId: string | null;
  ticketId: string | null;
  sourceEndpoint: string;
  sourceServiceDid: string | null;
  sourceLocalRotationKey: string | null;
  preservedSovereignKeys: string[];
  manifestDigest: string | null;
  expectedManifestJson: string | null;
  plcCutoverAt: number | null;
  absoluteDeadlineAt: number;
  permissions: EffectiveSessionPermissions;
};

type TargetCapabilityResult = {
  mode: "coordinated" | "standard";
  targetEndpoint: string;
  targetServiceDid: string;
  limits: {
    blobUploadLimit?: number;
    migrationBlobUploadLimit?: number;
    maxRepoImportSize?: number;
    maxSpaceMetaImportSize?: number;
    maxManifestBytes?: number;
  };
};

export function parseMigrationTicket(raw: string | undefined): { ticketId: string; secret: string } | null {
  if (!raw || raw.length !== 83 || !raw.startsWith("v1.")) return null;
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const [, ticketId, secret] = parts as [string, string, string];
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ticketId) ||
    !/^[A-Za-z0-9_-]{43}$/.test(secret)
  ) {
    return null;
  }
  return { ticketId, secret };
}

export class GroupMigrationService {
  private readonly infoFetcher: SafeFetch;
  private readonly manifestFetcher: SafeFetch;
  private readonly noticeFetcher: SafeFetch;
  private readonly pendingTargetAborts = new Set<Promise<void>>();

  constructor(
    readonly db: GroupHostDb,
    readonly config: GroupHostConfig,
    readonly cryptoBox: GroupHostCryptoBox,
    readonly serviceKeys: ServiceSigningMaterial,
    readonly plc: PlcAndDidResolver,
    readonly locks: GroupRepoLockManager,
    readonly repoStore: GroupRepoStore,
  ) {
    this.infoFetcher =
      config.fetchImpl ?? boundedSafeFetch(() => config.allowLoopback, BOUNDED_FETCH_PROFILES.migrationInfo);
    this.manifestFetcher =
      config.fetchImpl ?? boundedSafeFetch(() => config.allowLoopback, BOUNDED_FETCH_PROFILES.migrationManifest);
    this.noticeFetcher =
      config.fetchImpl ?? boundedSafeFetch(() => config.allowLoopback, BOUNDED_FETCH_PROFILES.xrpcNotice);
    registerPreparedLeaseReapHook(this.db, (reaped) => this.scheduleReapedLeaseTargetAbort(reaped));
  }

  private buildTargetAbortPayload(lease: {
    group_did: string;
    operation_id: string;
    mode: "coordinated" | "standard";
    ticket_id: string | null;
    deadline_at: number;
  }): Record<string, unknown> {
    return {
      group: lease.group_did,
      operationId: lease.operation_id,
      ...(lease.mode === "coordinated" && lease.ticket_id !== null ? { ticketId: lease.ticket_id } : {}),
      ...(lease.ticket_id !== null ? { leaseAttemptId: lease.ticket_id } : {}),
      deadlineAtMs: lease.deadline_at,
    };
  }

  private async sendBestEffortTargetAbort(
    lease: {
      group_did: string;
      operation_id: string;
      mode: "coordinated" | "standard";
      ticket_id: string | null;
      target_service_did: string;
      target_endpoint: string;
      deadline_at: number;
    },
    nowMs = Date.now(),
  ): Promise<void> {
    if (!lease.target_endpoint || !lease.target_service_did || !lease.operation_id) {
      return;
    }
    try {
      const jwt = await this.repoStore.signGroupServiceJwt({
        groupDid: lease.group_did,
        aud: lease.target_service_did,
        lxm: FLOCK_GROUP_METHOD.abortMigration,
        nowMs,
      });
      await this.noticeFetcher(`${lease.target_endpoint}/group-admin/abort-migration`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify(this.buildTargetAbortPayload(lease)),
      }).catch(() => undefined);
    } catch {
      // Best-effort target abort on background expiry reap only
    }
  }

  private async sendStrictTargetAbort(
    lease: {
      group_did: string;
      operation_id: string;
      mode: "coordinated" | "standard";
      ticket_id: string | null;
      target_service_did: string;
      target_endpoint: string;
      deadline_at: number;
    },
    nowMs = Date.now(),
  ): Promise<void> {
    if (!lease.target_endpoint || !lease.target_service_did || !lease.operation_id) {
      return;
    }
    const jwt = await this.repoStore.signGroupServiceJwt({
      groupDid: lease.group_did,
      aud: lease.target_service_did,
      lxm: FLOCK_GROUP_METHOD.abortMigration,
      nowMs,
    });
    let res: Response;
    try {
      res = await this.noticeFetcher(`${lease.target_endpoint}/group-admin/abort-migration`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify(this.buildTargetAbortPayload(lease)),
      });
    } catch {
      throw new GroupHostHttpError(
        502,
        "TargetAbortFailed",
        "Could not reach target host to purge migration staging; source lease preserved for retry.",
      );
    }

    if (res.status === 409) {
      const errBody = await readUpstreamJson<{ error?: unknown; message?: unknown }>(res, 65_536).catch(() => null);
      if (errBody?.error === "MigrationCutoverCommitted") {
        throw new GroupHostHttpError(
          409,
          "MigrationCutoverCommitted",
          typeof errBody.message === "string" ? errBody.message : "Target migration cutover already committed.",
        );
      }
      throw new GroupHostHttpError(
        502,
        "TargetAbortFailed",
        "Target host rejected abort-migration with HTTP 409; source lease preserved for retry.",
      );
    }

    if (res.status === 404 && lease.mode === "standard") {
      // Non-Flock Standard target without /group-admin/abort-migration
      return;
    }

    if (res.status !== 200) {
      throw new GroupHostHttpError(
        502,
        "TargetAbortFailed",
        `Target host abort-migration failed (${res.status}); source lease preserved for retry.`,
      );
    }

    const okBody = await readUpstreamJson<{ status?: unknown }>(res, 65_536).catch(() => null);
    if (
      !okBody ||
      (okBody.status !== "purged" && okBody.status !== "already_absent" && okBody.status !== "superseded")
    ) {
      throw new GroupHostHttpError(
        502,
        "TargetAbortFailed",
        "Target host returned malformed abort-migration acknowledgement; source lease preserved for retry.",
      );
    }
  }

  private scheduleReapedLeaseTargetAbort(reaped: ReapedPreparedLease): void {
    if (!reaped.target_endpoint || !reaped.target_service_did || !reaped.operation_id) {
      return;
    }
    let done!: () => void;
    const task = new Promise<void>((resolve) => {
      done = resolve;
    });
    this.pendingTargetAborts.add(task);
    queueMicrotask(async () => {
      try {
        if (!this.db.open) return;
        const rolledBack = this.db
          .prepare(
            "SELECT 1 AS ok FROM source_migration_lease WHERE group_did = ? AND operation_id = ? AND status = 'prepared'",
          )
          .get(reaped.group_did, reaped.operation_id);
        if (rolledBack) return;
        await this.sendBestEffortTargetAbort(reaped);
      } catch {
        // Best-effort target abort
      } finally {
        this.pendingTargetAborts.delete(task);
        done();
      }
    });
  }

  async flushPendingTargetAborts(): Promise<void> {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    while (this.pendingTargetAborts.size > 0) {
      await Promise.allSettled([...this.pendingTargetAborts]);
    }
  }

  // =========================================================================
  // DID Document, `describeServer`, `migration-info`, `public-group-keys`
  // =========================================================================

  getDidDocument(): Record<string, unknown> {
    const pdsEndpoint = groupHostPdsServiceEndpoint(this.config);
    return {
      "@context": [
        "https://www.w3.org/ns/did/v1",
        "https://w3id.org/security/multikey/v1",
      ],
      id: this.config.serviceDid,
      verificationMethod: this.serviceKeys.verificationMethods,
      service: [
        {
          id: "#atproto_pds",
          type: "AtprotoPersonalDataServer",
          serviceEndpoint: pdsEndpoint,
        },
        {
          id: "#atgrp_host",
          type: "AtmosphereGroupHostV1",
          serviceEndpoint: pdsEndpoint,
        },
      ],
    };
  }

  describeServer(): Record<string, unknown> {
    return {
      did: this.config.serviceDid,
      availableUserDomains: [this.config.handleDomain],
      inviteCodeRequired: false,
      phoneVerificationRequired: false,
      links: {},
      contact: {},
      blobUploadLimit: this.config.blobUploadLimit,
    };
  }

  private async signHostJwt(payload: Record<string, unknown>): Promise<string> {
    const header = {
      alg: "ES256",
      typ: "JWT",
      kid: this.serviceKeys.activeKidFragment,
    };
    const signingInput = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
    const sig = await this.serviceKeys.activeKeypair.sign(Buffer.from(signingInput, "utf8"));
    return `${signingInput}.${Buffer.from(sig).toString("base64url")}`;
  }

  async getMigrationInfo(nowMs = Date.now()): Promise<Record<string, unknown>> {
    const nowSec = Math.floor(nowMs / 1000);
    const capabilityProofJwt = await this.signHostJwt({
      iss: this.config.serviceDid,
      iat: nowSec,
      exp: nowSec + 300,
      endpoint: this.config.publicUrl,
      supportedSpacePolicies: [ATGRP_POLICY],
      atomicMigrationVersion: 1,
    });

    return {
      did: this.config.serviceDid,
      supportedSpacePolicies: [ATGRP_POLICY],
      blobUploadLimit: this.config.blobUploadLimit,
      migrationBlobUploadLimit: this.config.migrationBlobUploadLimit,
      maxRepoImportSize: this.config.maxRepoImportSize,
      maxSpaceMetaImportSize: this.config.maxSpaceMetaImportSize,
      maxManifestBytes: this.config.maxManifestBytes,
      atomicMigrationVersion: 1,
      capabilityProofJwt,
    };
  }

  async getPublicGroupKeys(
    groupDid: string,
    nowMs = Date.now(),
    operationId?: string,
  ): Promise<Record<string, unknown>> {
    if (!isDid(groupDid)) {
      throw new GroupHostHttpError(400, "InvalidRequest", "Invalid group DID.");
    }
    if (operationId !== undefined && !isValidIdempotencyKey(operationId)) {
      throw new GroupHostHttpError(400, "InvalidRequest", "Invalid operationId query parameter.");
    }
    reapExpiredPreparedMigrationLease(this.db, groupDid, nowMs);
    if (operationId !== undefined) {
      const tombstoned = this.db
        .prepare("SELECT expires_at FROM service_jwt_jti WHERE issuer_did = ? AND jti = ?")
        .get(groupDid, `aborted-op:${operationId}`) as { expires_at: number } | undefined;
      if (tombstoned && tombstoned.expires_at > nowMs) {
        throw new GroupHostHttpError(
          409,
          "OperationIdAlreadyAborted",
          `Migration operationId '${operationId}' was already aborted or expired on source; start a new operationId.`,
        );
      }
    }
    const activeLease = this.db
      .prepare("SELECT operation_id, ticket_id FROM source_migration_lease WHERE group_did = ?")
      .get(groupDid) as { operation_id: string; ticket_id: string | null } | undefined;
    if (activeLease && operationId !== undefined && activeLease.operation_id !== operationId) {
      throw new GroupHostHttpError(
        409,
        "MigrationInProgress",
        "Active source migration lease does not match the requested operationId.",
      );
    }
    const leaseAttemptId =
      activeLease &&
      activeLease.ticket_id &&
      (operationId === undefined || activeLease.operation_id === operationId)
        ? activeLease.ticket_id
        : null;

    const localRot = await this.repoStore.getGroupRotationKey(groupDid);
    if (!localRot) {
      throw new GroupHostHttpError(400, "RepoNotFound", `Group ${groupDid} has no local rotation key on this host.`);
    }
    const signingKey = await this.repoStore.getGroupSigningKey(groupDid);
    const nowSec = Math.floor(nowMs / 1000);
    const header = { alg: "ES256", typ: "JWT", kid: "#atproto" };
    const payload = {
      iss: groupDid,
      aud: "*",
      iat: nowSec,
      exp: nowSec + 300,
      groupDid,
      localRotationKey: localRot.did(),
      ...(leaseAttemptId ? { leaseAttemptId } : {}),
    };
    const signingInput = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
    const sig = await signingKey.sign(Buffer.from(signingInput, "utf8"));
    const proofJwt = `${signingInput}.${Buffer.from(sig).toString("base64url")}`;

    return {
      groupDid,
      localRotationKey: localRot.did(),
      proofJwt,
      ...(leaseAttemptId ? { leaseAttemptId } : {}),
    };
  }

  // =========================================================================
  // Peer Service-JWT Verification & Target Capability Negotiation
  // =========================================================================

  async verifyPeerHostServiceJwt(params: {
    authorizationHeader: string | undefined;
    expectedLxm: string;
    expectedIssuerDid?: string;
    expectedPeerEndpoint?: string;
    groupDidForJti: string;
    nowMs?: number;
  }): Promise<{ iss: string; jti: string }> {
    const nowMs = params.nowMs ?? Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const rawJwt = extractBearerToken(params.authorizationHeader);
    if (!rawJwt) {
      throw new GroupHostHttpError(401, "AuthMissing", "Peer service JWT Bearer authorization required.");
    }

    const parsed = parseServiceJwtParts(rawJwt);
    if (
      parsed.header.typ !== "JWT" ||
      parsed.header.alg !== "ES256" ||
      !parsed.payload.iss ||
      parsed.payload.aud !== this.config.serviceDid ||
      !params.expectedLxm ||
      parsed.payload.lxm !== params.expectedLxm ||
      typeof parsed.payload.jti !== "string" ||
      parsed.payload.jti.trim().length === 0
    ) {
      throw new GroupHostHttpError(401, "InvalidToken", "Invalid peer host service JWT claims.");
    }
    if (params.expectedIssuerDid && parsed.payload.iss !== params.expectedIssuerDid) {
      throw new GroupHostHttpError(403, "Forbidden", "Peer service JWT issuer mismatch.");
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
      throw new GroupHostHttpError(401, "ExpiredToken", "Peer service JWT expired or exceeds 60s lifetime.");
    }

    const doc = await this.plc.resolveDidDocument(parsed.payload.iss);
    if (!doc) {
      throw new GroupHostHttpError(401, "UnresolvableDid", `Cannot resolve peer host DID ${parsed.payload.iss}.`);
    }
    if (params.expectedPeerEndpoint) {
      const pdsOrigin = this.plc.extractPdsEndpoint(doc);
      if (pdsOrigin !== normalizeOriginUrl(params.expectedPeerEndpoint)) {
        throw new GroupHostHttpError(401, "InvalidToken", "Peer DID #atproto_pds endpoint mismatch.");
      }
    }

    const fragment = parsed.header.kid
      ? parsed.header.kid.startsWith(`${doc.id}#`)
        ? parsed.header.kid.slice(doc.id.length)
        : parsed.header.kid
      : "#atproto";
    const isDesignatedPeerSigningKey =
      fragment === "#atproto" || /^#atproto-[A-Za-z0-9_-]{1,64}$/.test(fragment);
    const signingDidKey = isDesignatedPeerSigningKey
      ? this.plc.extractVerificationMethodDidKey(doc, fragment)
      : null;
    if (!signingDidKey) {
      throw new GroupHostHttpError(401, "SigningKeyNotFound", "Peer signing key not found in DID document.");
    }

    const validSig = await cryptoVerifySignatureWithKey(
      signingDidKey,
      parsed.signingInput,
      parsed.sigBytes,
      parsed.header.alg,
    ).catch(() => false);
    if (!validSig) {
      throw new GroupHostHttpError(401, "InvalidSignature", "Peer service JWT signature invalid.");
    }

    const jti = parsed.payload.jti;
    if (jti.length > 256) {
      throw new GroupHostHttpError(401, "InvalidToken", "Peer service JWT jti exceeds maximum length.");
    }
    const jtiKey = `jwt:${jti}`;
    const tx = this.db.transaction(() => {
      const dup = this.db
        .prepare("SELECT 1 AS ok FROM service_jwt_jti WHERE issuer_did = ? AND jti = ?")
        .get(parsed.payload.iss, jtiKey);
      if (dup) {
        throw new GroupHostHttpError(401, "ReplayDetected", "Peer service JWT jti replay detected.");
      }
      this.db
        .prepare("INSERT INTO service_jwt_jti (issuer_did, jti, group_did, expires_at) VALUES (?, ?, ?, ?)")
        .run(parsed.payload.iss, jtiKey, params.groupDidForJti, Math.max(parsed.payload.exp * 1000, nowMs + 65_000));
    });
    tx.immediate();

    return { iss: parsed.payload.iss, jti };
  }

  /**
   * Verifies DID-bound `group.opensocial.policy` capability on `<targetEndpoint>`
   * via EITHER `capabilityProofJwt` on `/group-admin/migration-info` OR `#opensocial_group`
   * in `describeServer.did`'s verified DID document — NEVER falling back to bare `describeServer`!
   */
  async verifyOpenSocialTargetCapability(rawTargetEndpoint: string, nowMs = Date.now()): Promise<TargetCapabilityResult> {
    let targetOrigin: string;
    try {
      targetOrigin = normalizeOriginUrl(rawTargetEndpoint);
    } catch {
      throw new GroupHostHttpError(400, "InvalidRequest", `Invalid targetEndpoint URL: ${rawTargetEndpoint}`);
    }
    if (targetOrigin === normalizeOriginUrl(this.config.publicUrl)) {
      throw new GroupHostHttpError(400, "InvalidRequest", "Target endpoint cannot equal this source Group Host.");
    }

    const nowSec = Math.floor(nowMs / 1000);

    // Attempt 1: `/group-admin/migration-info` carrying `capabilityProofJwt`
    // Note: when HTTP 200 is returned, `capabilityProofJwt` MUST pass all cryptographic, key, and lifetime
    // invariants; invalid HTTP 200 proofs fail closed without silently downgrading to Attempt 2.
    let migInfoRes: Response | null = null;
    try {
      const infoRes = await this.infoFetcher(`${targetOrigin}/group-admin/migration-info`, {
        method: "GET",
        headers: { accept: "application/json" },
      });
      if (infoRes.status === 200) {
        migInfoRes = infoRes;
      }
    } catch {
      // Endpoint absent or non-JSON 404; fall through to Attempt 2 (`describeServer` + `#opensocial_group` DID service)
    }

    if (migInfoRes !== null) {
      let info: {
        did?: unknown;
        supportedSpacePolicies?: unknown;
        blobUploadLimit?: number;
        migrationBlobUploadLimit?: number;
        maxRepoImportSize?: number;
        maxSpaceMetaImportSize?: number;
        maxManifestBytes?: number;
        atomicMigrationVersion?: unknown;
        capabilityProofJwt?: unknown;
      } | null = null;
      try {
        info = await readUpstreamJson(migInfoRes, BOUNDED_FETCH_PROFILES.migrationInfo.maxResponseBytes);
      } catch {
        throw new GroupHostHttpError(
          400,
          "UnsupportedGroupHostTarget",
          `Malformed /group-admin/migration-info response from ${targetOrigin}.`,
        );
      }

      if (
        !info ||
        typeof info !== "object" ||
        Array.isArray(info) ||
        typeof info.did !== "string" ||
        !isDid(info.did) ||
        !Array.isArray(info.supportedSpacePolicies) ||
        !info.supportedSpacePolicies.includes(ATGRP_POLICY) ||
        typeof info.capabilityProofJwt !== "string" ||
        info.capabilityProofJwt.length === 0 ||
        info.capabilityProofJwt.length > 8_192
      ) {
        throw new GroupHostHttpError(
          400,
          "UnsupportedGroupHostTarget",
          `Target host ${targetOrigin} returned invalid /group-admin/migration-info metadata.`,
        );
      }

      const doc = await this.plc.resolveDidDocument(info.did).catch(() => null);
      if (!doc || this.plc.extractPdsEndpoint(doc) !== targetOrigin) {
        throw new GroupHostHttpError(
          400,
          "UnsupportedGroupHostTarget",
          `Target host ${targetOrigin} DID document #atproto_pds does not match endpoint.`,
        );
      }

      const jwtParts = info.capabilityProofJwt.split(".");
      if (jwtParts.length !== 3 || !jwtParts[0] || !jwtParts[1] || !jwtParts[2]) {
        throw new GroupHostHttpError(
          400,
          "UnsupportedGroupHostTarget",
          `Target host ${targetOrigin} capabilityProofJwt is malformed.`,
        );
      }

      let hdr: { typ?: unknown; alg?: unknown; kid?: unknown };
      let claims: {
        iss?: unknown;
        iat?: unknown;
        exp?: unknown;
        endpoint?: unknown;
        supportedSpacePolicies?: unknown;
        atomicMigrationVersion?: unknown;
      };
      try {
        const rawHdr = JSON.parse(Buffer.from(jwtParts[0], "base64url").toString("utf8")) as unknown;
        const rawClaims = JSON.parse(Buffer.from(jwtParts[1], "base64url").toString("utf8")) as unknown;
        if (
          !rawHdr ||
          typeof rawHdr !== "object" ||
          Array.isArray(rawHdr) ||
          !rawClaims ||
          typeof rawClaims !== "object" ||
          Array.isArray(rawClaims)
        ) {
          throw new Error("Invalid capabilityProofJwt JSON object.");
        }
        hdr = rawHdr as typeof hdr;
        claims = rawClaims as typeof claims;
      } catch {
        throw new GroupHostHttpError(
          400,
          "UnsupportedGroupHostTarget",
          `Target host ${targetOrigin} capabilityProofJwt contains malformed JSON.`,
        );
      }

      if (
        hdr.typ !== "JWT" ||
        hdr.alg !== "ES256" ||
        (hdr.kid !== undefined && typeof hdr.kid !== "string")
      ) {
        throw new GroupHostHttpError(
          400,
          "UnsupportedGroupHostTarget",
          `Target host ${targetOrigin} capabilityProofJwt protected header is invalid.`,
        );
      }

      const frag =
        hdr.kid === undefined
          ? "#atproto"
          : hdr.kid.startsWith(`${doc.id}#`)
            ? hdr.kid.slice(doc.id.length)
            : hdr.kid;
      const isDesignatedHostSigningKey =
        frag === "#atproto" || /^#atproto-[A-Za-z0-9_-]{1,64}$/.test(frag);
      const matchedVm = isDesignatedHostSigningKey
        ? (doc.verificationMethod ?? []).find((vm) => vm.id === frag || vm.id === `${doc.id}${frag}`)
        : undefined;
      if (!matchedVm || (matchedVm.controller !== undefined && matchedVm.controller !== doc.id)) {
        throw new GroupHostHttpError(
          400,
          "UnsupportedGroupHostTarget",
          `Target host ${targetOrigin} capabilityProofJwt is not signed by a designated host signing key.`,
        );
      }

      let normalizedClaimEndpoint: string | null = null;
      if (typeof claims.endpoint === "string") {
        try {
          normalizedClaimEndpoint = normalizeOriginUrl(claims.endpoint);
        } catch {
          normalizedClaimEndpoint = null;
        }
      }

      if (
        claims.iss !== info.did ||
        typeof claims.iat !== "number" ||
        !Number.isFinite(claims.iat) ||
        claims.iat > nowSec + 5 ||
        typeof claims.exp !== "number" ||
        !Number.isFinite(claims.exp) ||
        claims.exp <= nowSec ||
        claims.exp - claims.iat <= 0 ||
        claims.exp - claims.iat > 300 ||
        normalizedClaimEndpoint !== targetOrigin ||
        !Array.isArray(claims.supportedSpacePolicies) ||
        !claims.supportedSpacePolicies.includes(ATGRP_POLICY)
      ) {
        throw new GroupHostHttpError(
          400,
          "UnsupportedGroupHostTarget",
          `Target host ${targetOrigin} capabilityProofJwt claims or lifetime are invalid.`,
        );
      }

      const didKey = this.plc.extractVerificationMethodDidKey(doc, frag);
      const sigOk = didKey
        ? await cryptoVerifySignatureWithKey(
            didKey,
            Buffer.from(`${jwtParts[0]}.${jwtParts[1]}`, "utf8"),
            Buffer.from(jwtParts[2], "base64url"),
            hdr.alg,
          ).catch(() => false)
        : false;
      if (!sigOk) {
        throw new GroupHostHttpError(
          400,
          "UnsupportedGroupHostTarget",
          `Target host ${targetOrigin} capabilityProofJwt signature verification failed.`,
        );
      }

      return {
        mode: claims.atomicMigrationVersion === 1 ? "coordinated" : "standard",
        targetEndpoint: targetOrigin,
        targetServiceDid: info.did,
        limits: {
          blobUploadLimit: info.blobUploadLimit,
          migrationBlobUploadLimit: info.migrationBlobUploadLimit,
          maxRepoImportSize: info.maxRepoImportSize,
          maxSpaceMetaImportSize: info.maxSpaceMetaImportSize,
          maxManifestBytes: info.maxManifestBytes,
        },
      };
    }

    // Attempt 2: `describeServer` + verified DID document `#atgrp_host` (`AtmosphereGroupHostV1`) service
    try {
      const descRes = await this.infoFetcher(`${targetOrigin}/xrpc/com.atproto.server.describeServer`, {
        method: "GET",
        headers: { accept: "application/json" },
      });
      if (descRes.ok) {
        const desc = await readUpstreamJson<{ did?: string; blobUploadLimit?: number }>(
          descRes,
          BOUNDED_FETCH_PROFILES.migrationInfo.maxResponseBytes,
        );
        if (desc?.did && isDid(desc.did)) {
          const doc = await this.plc.resolveDidDocument(desc.did);
          if (
            doc &&
            this.plc.extractPdsEndpoint(doc) === targetOrigin &&
            this.plc.hasAtgrpGroupService(doc, targetOrigin)
          ) {
            return {
              mode: "standard",
              targetEndpoint: targetOrigin,
              targetServiceDid: desc.did,
              limits: {
                blobUploadLimit: desc.blobUploadLimit,
              },
            };
          }
        }
      }
    } catch {
      // Fall through to fail-closed error
    }

    throw new GroupHostHttpError(
      400,
      "UnsupportedGroupHostTarget",
      `Target host ${targetOrigin} does not advertise verifiable Atmosphere Groups org.atgrp.policy capability.`,
    );
  }

  // =========================================================================
  // Canonical Manifest Computation & Preflight Sizing
  // =========================================================================

  async snapshotGroupManifestAndSizes(params: {
    groupDid: string;
    operationId: string;
    deadlineAtMs: number;
    sourceLocalRotationKey: string;
  }): Promise<{
    manifestJson: string;
    manifestDigest: string;
    publicRootCommitCid: string;
    spaceRepoRevs: Map<string, string>;
    carByteLength: number;
    maxBlobSize: number;
    maxSpaceMetaByteLength: number;
    maxSpaceRepoByteLength: number;
  }> {
    const storage = new SqlStagingRepoStorage(this.db, params.groupDid);
    if (!storage.initialRootCidStr) {
      throw new GroupHostHttpError(400, "RepoNotFound", `Missing public repo for ${params.groupDid}.`);
    }
    const repo = await Repo.load(storage);
    const publicRepoDataRootCid = repo.commit.data.toString();
    const { carBytes } = await this.repoStore.exportPublicRepoCar(params.groupDid);

    const publicRecords = this.db
      .prepare("SELECT collection, rkey, cid FROM public_record WHERE group_did = ?")
      .all(params.groupDid) as Array<{ collection: string; rkey: string; cid: string }>;

    const blobRows = this.db
      .prepare("SELECT cid, size FROM blob_store WHERE group_did = ?")
      .all(params.groupDid) as Array<{ cid: string; size: number }>;
    let maxBlobSize = 0;
    for (const b of blobRows) {
      if (b.size > maxBlobSize) maxBlobSize = b.size;
    }

    const ownSpaces = this.db
      .prepare("SELECT space_uri FROM group_space WHERE group_did = ? AND deleted_at IS NULL")
      .all(params.groupDid) as Array<{ space_uri: string }>;
    const ownSpaceSet = new Set(ownSpaces.map((s) => s.space_uri));

    const repoSpaces = this.db
      .prepare("SELECT space_uri, rev FROM space_repo WHERE repo_did = ?")
      .all(params.groupDid) as Array<{ space_uri: string; rev: string }>;
    const spaceRepoRevs = new Map<string, string>();
    for (const r of repoSpaces) {
      spaceRepoRevs.set(r.space_uri, r.rev);
    }

    const allSpaceUris = new Set<string>([...ownSpaceSet, ...spaceRepoRevs.keys()]);
    const spaceEntries: MigrationSpaceManifestEntry[] = [];
    let maxSpaceMetaByteLength = 0;
    let maxSpaceRepoByteLength = 0;

    for (const spUri of allSpaceUris) {
      const isOwn = ownSpaceSet.has(spUri);
      // Skip deleted own spaces if any stale space_repo remained
      if (!isOwn && parseSpaceUri(spUri)?.authorityDid === params.groupDid) {
        continue;
      }

      let spaceMetaSha256: string | null = null;
      if (isOwn) {
        const metaBytes = await this.repoStore.exportSpaceMetaBytes(params.groupDid, spUri);
        if (metaBytes.byteLength > maxSpaceMetaByteLength) {
          maxSpaceMetaByteLength = metaBytes.byteLength;
        }
        spaceMetaSha256 = sha256HexBytes(metaBytes);
      }

      let repoRootDataHex = bytesToHex(RepoCommit.fromRecords([]).setHash.digest());
      if (spaceRepoRevs.has(spUri)) {
        const exported = await this.repoStore.exportSpaceRepoStarBytes(spUri, params.groupDid);
        if (exported.starBytes.byteLength > maxSpaceRepoByteLength) {
          maxSpaceRepoByteLength = exported.starBytes.byteLength;
        }
        repoRootDataHex = bytesToHex(exported.commit.data).toLowerCase();
      }

      spaceEntries.push({
        spaceUri: spUri,
        isOwnAuthority: isOwn,
        spaceMetaSha256,
        repoRootDataHex,
      });
    }

    const computed = computeCanonicalMigrationManifest({
      groupDid: params.groupDid,
      operationId: params.operationId,
      deadlineAtMs: params.deadlineAtMs,
      sourceLocalRotationKey: params.sourceLocalRotationKey,
      publicRepoDataRootCid,
      publicRecords,
      blobs: blobRows.map((b) => b.cid),
      spaces: spaceEntries,
    });

    return {
      manifestJson: computed.manifestJson,
      manifestDigest: computed.manifestDigest,
      publicRootCommitCid: storage.initialRootCidStr,
      spaceRepoRevs,
      carByteLength: carBytes.byteLength,
      maxBlobSize,
      maxSpaceMetaByteLength,
      maxSpaceRepoByteLength,
    };
  }

  // =========================================================================
  // `prepare-migration`, `migration-manifest`, `migration-attestation`, `abort`, `finalize`
  // =========================================================================

  async prepareMigration(params: {
    session: AuthenticatedGroupSession;
    groupDid: string;
    operationId: string;
    targetEndpoint: string;
    requestedMode?: "auto" | "coordinated" | "standard";
    nowMs?: number;
  }): Promise<Record<string, unknown>> {
    const nowMs = params.nowMs ?? Date.now();
    if (params.session.groupDid !== params.groupDid) {
      throw new GroupHostHttpError(403, "Forbidden", "OAuth session subject does not match group.");
    }
    if (!isValidIdempotencyKey(params.operationId)) {
      throw new GroupHostHttpError(400, "InvalidRequest", "operationId must be 1..128 [A-Za-z0-9._:-] chars.");
    }
    assertFreshLoginStepUp(params.session, nowMs, "prepare-migration requires prompt=login within 5 minutes.");
    params.session.permissions.assertAccount({ attr: "repo", action: "manage" });
    params.session.permissions.assertIdentity({ attr: "*" });

    let normalizedTargetOrigin: string;
    try {
      normalizedTargetOrigin = normalizeOriginUrl(params.targetEndpoint);
    } catch {
      throw new GroupHostHttpError(400, "InvalidRequest", "Invalid targetEndpoint URL.");
    }

    // Step 1: Offline-Safe Replay Check BEFORE Any Target Network Probe!
    const assertSourceOpNotAbortedSync = () => {
      const tombstoned = this.db
        .prepare("SELECT expires_at FROM service_jwt_jti WHERE issuer_did = ? AND jti = ?")
        .get(params.groupDid, `aborted-op:${params.operationId}`) as { expires_at: number } | undefined;
      if (tombstoned && tombstoned.expires_at > nowMs) {
        throw new GroupHostHttpError(
          409,
          "OperationIdAlreadyAborted",
          `Migration operationId '${params.operationId}' was already aborted or expired; start a new operationId.`,
        );
      }
    };

    const replayResult = await this.locks.withGroupRepoLock(params.groupDid, () => {
      reapExpiredPreparedMigrationLease(this.db, params.groupDid, nowMs);
      assertSourceOpNotAbortedSync();
      const acct = this.db
        .prepare("SELECT activated, takendown FROM group_account WHERE did = ?")
        .get(params.groupDid) as { activated: number; takendown: number } | undefined;
      if (!acct || acct.takendown !== 0) throw new GroupHostHttpError(400, "RepoTakendown");
      if (acct.activated !== 1) throw new GroupHostHttpError(400, "RepoDeactivated");

      const liveState = loadLiveGovernanceState(this.db, params.groupDid);
      if (!isAuthorizedLifecycleAdmin(params.session.authorizingUserDid, liveState, params.groupDid)) {
        throw new GroupHostHttpError(403, "Forbidden", "Caller is not an authorized lifecycle admin.");
      }

      const existingLease = this.db
        .prepare("SELECT * FROM source_migration_lease WHERE group_did = ?")
        .get(params.groupDid) as
        | {
            operation_id: string;
            mode: "coordinated" | "standard";
            ticket_id: string | null;
            ticket_secret_enc: string | null;
            target_service_did: string;
            target_endpoint: string;
            status: "prepared" | "plc_signed";
            deadline_at: number;
            manifest_digest: string;
          }
        | undefined;

      if (!existingLease) return null;

      if (
        existingLease.status === "prepared" &&
        existingLease.operation_id === params.operationId &&
        existingLease.target_endpoint === normalizedTargetOrigin &&
        (params.requestedMode === undefined ||
          params.requestedMode === "auto" ||
          existingLease.mode === params.requestedMode)
      ) {
        let migrationTicket: string | null = null;
        if (existingLease.mode === "coordinated" && existingLease.ticket_id && existingLease.ticket_secret_enc) {
          const secret = this.cryptoBox.decryptColumnUtf8(
            "source_migration_lease",
            params.groupDid,
            "ticket_secret_enc",
            existingLease.ticket_secret_enc,
          );
          migrationTicket = `v1.${existingLease.ticket_id}.${secret}`;
        }
        return {
          groupDid: params.groupDid,
          operationId: existingLease.operation_id,
          mode: existingLease.mode,
          targetEndpoint: existingLease.target_endpoint,
          targetServiceDid: existingLease.target_service_did,
          deadlineAtMs: existingLease.deadline_at,
          manifestDigest: existingLease.manifest_digest,
          migrationTicket,
        };
      }

      throw new GroupHostHttpError(409, "MigrationInProgress", "Another migration operation is already active.");
    });

    if (replayResult) return replayResult;

    // Step 2: Mandatory Target Capability Negotiation (outside lock!)
    const targetCap = await this.verifyOpenSocialTargetCapability(normalizedTargetOrigin, nowMs);
    if (params.requestedMode === "coordinated" && targetCap.mode !== "coordinated") {
      throw new GroupHostHttpError(
        400,
        "CoordinatedMigrationUnsupported",
        "Target host does not support coordinated atomic migration.",
      );
    }
    const effectiveMode: "coordinated" | "standard" =
      params.requestedMode === "standard" ? "standard" : targetCap.mode;

    // Step 3: Atomic Snapshot & Preflight Under `withGroupRepoLock(groupDid, ...)`!
    return this.locks.withGroupRepoLock(params.groupDid, async () => {
      reapExpiredPreparedMigrationLease(this.db, params.groupDid, nowMs);
      assertSourceOpNotAbortedSync();
      const concurrentLease = this.db
        .prepare("SELECT * FROM source_migration_lease WHERE group_did = ?")
        .get(params.groupDid) as
        | {
            operation_id: string;
            mode: "coordinated" | "standard";
            ticket_id: string | null;
            ticket_secret_enc: string | null;
            target_service_did: string;
            target_endpoint: string;
            status: "prepared" | "plc_signed";
            deadline_at: number;
            manifest_digest: string;
          }
        | undefined;

      if (concurrentLease) {
        if (
          concurrentLease.status === "prepared" &&
          concurrentLease.operation_id === params.operationId &&
          concurrentLease.target_endpoint === targetCap.targetEndpoint &&
          (params.requestedMode === undefined ||
            params.requestedMode === "auto" ||
            concurrentLease.mode === params.requestedMode)
        ) {
          const secret =
            concurrentLease.mode === "coordinated" && concurrentLease.ticket_id && concurrentLease.ticket_secret_enc
              ? this.cryptoBox.decryptColumnUtf8(
                  "source_migration_lease",
                  params.groupDid,
                  "ticket_secret_enc",
                  concurrentLease.ticket_secret_enc,
                )
              : null;
          return {
            groupDid: params.groupDid,
            operationId: concurrentLease.operation_id,
            mode: concurrentLease.mode,
            targetEndpoint: concurrentLease.target_endpoint,
            targetServiceDid: concurrentLease.target_service_did,
            deadlineAtMs: concurrentLease.deadline_at,
            manifestDigest: concurrentLease.manifest_digest,
            migrationTicket: secret ? `v1.${concurrentLease.ticket_id}.${secret}` : null,
          };
        }
        throw new GroupHostHttpError(409, "MigrationInProgress", "Concurrent migration started.");
      }

      const localRot = await this.repoStore.getGroupRotationKey(params.groupDid);
      if (!localRot) {
        throw new GroupHostHttpError(400, "InvalidRequest", "Source group lacks a local PLC rotation key.");
      }

      const deadlineAtMs = nowMs + 2 * HOUR_MS;
      const snap = await this.snapshotGroupManifestAndSizes({
        groupDid: params.groupDid,
        operationId: params.operationId,
        deadlineAtMs,
        sourceLocalRotationKey: localRot.did(),
      });

      const candidateTicketId = randomUUID();
      const candidateSecret = randomBytes(32).toString("base64url"); // exact 43 chars
      const envelopePreview = JSON.stringify({
        groupDid: params.groupDid,
        operationId: params.operationId,
        ticketId: candidateTicketId,
        deadlineAtMs,
        sourceEndpoint: this.config.publicUrl,
        sourceServiceDid: this.config.serviceDid,
        sourceLocalRotationKey: localRot.did(),
        targetEndpoint: targetCap.targetEndpoint,
        targetServiceDid: targetCap.targetServiceDid,
        manifestDigest: snap.manifestDigest,
        manifestJson: snap.manifestJson,
      });
      const envelopeBytes = Buffer.byteLength(envelopePreview, "utf8");

      // Preflight Target Size Checks BEFORE Freezing Source (`400 TargetMigrationLimitExceeded`)!
      if (effectiveMode === "coordinated") {
        const maxBlob = targetCap.limits.migrationBlobUploadLimit ?? 100 * 1024 * 1024;
        const maxManifest = targetCap.limits.maxManifestBytes ?? 4 * 1024 * 1024;
        const maxRepo = targetCap.limits.maxRepoImportSize ?? 100 * 1024 * 1024;
        const maxMeta = targetCap.limits.maxSpaceMetaImportSize ?? 100 * 1024 * 1024;
        if (
          snap.maxBlobSize > maxBlob ||
          envelopeBytes > maxManifest ||
          snap.carByteLength > maxRepo ||
          snap.maxSpaceRepoByteLength > maxRepo ||
          snap.maxSpaceMetaByteLength > maxMeta
        ) {
          throw new GroupHostHttpError(
            400,
            "TargetMigrationLimitExceeded",
            "Group repository, blobs, or space archives exceed target host migration limits.",
          );
        }
      } else if (
        targetCap.limits.blobUploadLimit !== undefined &&
        snap.maxBlobSize > targetCap.limits.blobUploadLimit
      ) {
        throw new GroupHostHttpError(
          400,
          "TargetMigrationLimitExceeded",
          `Largest group blob (${snap.maxBlobSize}B) exceeds target blobUploadLimit (${targetCap.limits.blobUploadLimit}B).`,
        );
      }

      // Bind every prepared lease (`coordinated` AND `standard`) to a unique causal UUID (`ticket_id`),
      // while issuing an 83-byte `migrationTicket` secret only in `coordinated` mode!
      const ticketId = candidateTicketId;
      const ticketSecretHash = effectiveMode === "coordinated" ? sha256HexBytes(candidateSecret) : null;
      const ticketSecretEnc =
        effectiveMode === "coordinated"
          ? this.cryptoBox.encryptColumn("source_migration_lease", params.groupDid, "ticket_secret_enc", candidateSecret)
          : null;
      const migrationTicket = effectiveMode === "coordinated" ? `v1.${candidateTicketId}.${candidateSecret}` : null;

      const tx = this.db.transaction(() => {
        const revalidated = revalidateLiveOAuthSessionSync(this.db, params.session, { nowMs });
        revalidated.permissions.assertAccount({ attr: "repo", action: "manage" });
        if (!isAuthorizedLifecycleAdmin(params.session.authorizingUserDid, revalidated.liveState, params.groupDid)) {
          throw new GroupHostHttpError(403, "Forbidden", "Caller is not an authorized lifecycle admin.");
        }

        const liveRoot = this.db
          .prepare("SELECT commit_cid FROM public_repo_root WHERE group_did = ?")
          .get(params.groupDid) as { commit_cid: string } | undefined;
        if (liveRoot?.commit_cid !== snap.publicRootCommitCid) {
          throw new GroupHostHttpError(409, "ConcurrentModification", "Public repo changed during snapshot.");
        }
        const liveSpaceRepos = this.db
          .prepare("SELECT space_uri, rev FROM space_repo WHERE repo_did = ?")
          .all(params.groupDid) as Array<{ space_uri: string; rev: string }>;
        if (liveSpaceRepos.length !== snap.spaceRepoRevs.size) {
          throw new GroupHostHttpError(409, "ConcurrentModification", "Space repo set changed during snapshot.");
        }
        for (const r of liveSpaceRepos) {
          if (snap.spaceRepoRevs.get(r.space_uri) !== r.rev) {
            throw new GroupHostHttpError(409, "ConcurrentModification", "Space repo revision changed during snapshot.");
          }
        }

        this.db
          .prepare(
            `INSERT INTO source_migration_lease (
               group_did, operation_id, mode, ticket_id, ticket_secret_hash, ticket_secret_enc,
               target_service_did, target_endpoint, status, signed_plc_op_json,
               frozen_at, deadline_at, expires_at, manifest_digest, root_manifest_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prepared', NULL, ?, ?, ?, ?, ?)`,
          )
          .run(
            params.groupDid,
            params.operationId,
            effectiveMode,
            ticketId,
            ticketSecretHash,
            ticketSecretEnc,
            targetCap.targetServiceDid,
            targetCap.targetEndpoint,
            nowMs,
            deadlineAtMs,
            deadlineAtMs,
            snap.manifestDigest,
            snap.manifestJson,
          );
      });
      tx.immediate();

      return {
        groupDid: params.groupDid,
        operationId: params.operationId,
        mode: effectiveMode,
        targetEndpoint: targetCap.targetEndpoint,
        targetServiceDid: targetCap.targetServiceDid,
        deadlineAtMs,
        manifestDigest: snap.manifestDigest,
        migrationTicket,
      };
    });
  }

  async getMigrationManifest(params: {
    authorizationHeader: string | undefined;
    secretHeader: string | undefined;
    groupDid: string;
    ticketId: string;
    nowMs?: number;
  }): Promise<Record<string, unknown>> {
    const nowMs = params.nowMs ?? Date.now();
    if (!isDid(params.groupDid) || !params.ticketId) {
      throw new GroupHostHttpError(400, "InvalidRequest", "group and ticketId query parameters are required.");
    }
    if (!params.secretHeader || params.secretHeader.length !== 43) {
      throw new GroupHostHttpError(409, "InvalidMigrationTicket", "Missing or malformed X-Group-Migration-Secret.");
    }

    reapExpiredPreparedMigrationLease(this.db, params.groupDid, nowMs);
    const lease = this.db
      .prepare("SELECT * FROM source_migration_lease WHERE group_did = ?")
      .get(params.groupDid) as
      | {
          operation_id: string;
          mode: "coordinated" | "standard";
          ticket_id: string | null;
          ticket_secret_hash: string | null;
          target_service_did: string;
          target_endpoint: string;
          deadline_at: number;
          manifest_digest: string;
          root_manifest_json: string;
        }
      | undefined;

    if (
      !lease ||
      lease.mode !== "coordinated" ||
      lease.ticket_id !== params.ticketId ||
      !lease.ticket_secret_hash
    ) {
      throw new GroupHostHttpError(409, "MigrationLeaseNotFound", "No matching coordinated migration lease.");
    }

    const actualHashBuf = Buffer.from(sha256HexBytes(params.secretHeader), "hex");
    const expectedHashBuf = Buffer.from(lease.ticket_secret_hash, "hex");
    if (actualHashBuf.byteLength !== expectedHashBuf.byteLength || !timingSafeEqual(actualHashBuf, expectedHashBuf)) {
      throw new GroupHostHttpError(409, "InvalidMigrationTicket", "X-Group-Migration-Secret mismatch.");
    }

    await this.verifyPeerHostServiceJwt({
      authorizationHeader: params.authorizationHeader,
      expectedLxm: "com.atproto.server.createAccount",
      expectedIssuerDid: lease.target_service_did,
      expectedPeerEndpoint: lease.target_endpoint,
      groupDidForJti: params.groupDid,
      nowMs,
    });

    const localRot = await this.repoStore.getGroupRotationKey(params.groupDid);
    if (!localRot) {
      throw new GroupHostHttpError(400, "RepoNotFound", "Source rotation key unavailable.");
    }

    const body = {
      groupDid: params.groupDid,
      operationId: lease.operation_id,
      ticketId: lease.ticket_id,
      deadlineAtMs: lease.deadline_at,
      sourceEndpoint: this.config.publicUrl,
      sourceServiceDid: this.config.serviceDid,
      sourceLocalRotationKey: localRot.did(),
      targetEndpoint: lease.target_endpoint,
      targetServiceDid: lease.target_service_did,
      manifestDigest: lease.manifest_digest,
      manifestJson: lease.root_manifest_json,
    };
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > this.config.maxManifestBytes) {
      throw new GroupHostHttpError(413, "PayloadTooLarge", "Migration manifest exceeds maxManifestBytes.");
    }
    return body;
  }

  async getMigrationAttestation(params: {
    authorizationHeader: string | undefined;
    groupDid: string;
    operationId: string;
    ticketId: string;
    nowMs?: number;
  }): Promise<Record<string, unknown>> {
    const nowMs = params.nowMs ?? Date.now();
    const acct = this.db
      .prepare("SELECT activated FROM group_account WHERE did = ?")
      .get(params.groupDid) as { activated: number } | undefined;
    if (!acct || acct.activated !== 0) {
      throw new GroupHostHttpError(409, "AlreadyActivated", "Group is not in unactivated target staging.");
    }

    const sess = this.db
      .prepare("SELECT * FROM migration_session WHERE group_did = ?")
      .get(params.groupDid) as
      | {
          mode: "coordinated" | "standard";
          operation_id: string | null;
          ticket_id: string | null;
          source_endpoint: string;
          source_service_did: string | null;
          source_local_rotation_key: string | null;
          preserved_sovereign_keys_json: string;
          manifest_digest: string | null;
          expected_manifest_json: string | null;
          absolute_deadline_at: number;
        }
      | undefined;

    if (
      !sess ||
      sess.mode !== "coordinated" ||
      sess.operation_id !== params.operationId ||
      sess.ticket_id !== params.ticketId ||
      !sess.source_service_did ||
      !sess.expected_manifest_json ||
      !sess.manifest_digest ||
      !sess.source_local_rotation_key
    ) {
      throw new GroupHostHttpError(409, "MigrationSessionMismatch", "No matching coordinated staging session.");
    }

    await this.verifyPeerHostServiceJwt({
      authorizationHeader: params.authorizationHeader,
      expectedLxm: "com.atproto.identity.signPlcOperation",
      expectedIssuerDid: sess.source_service_did,
      expectedPeerEndpoint: sess.source_endpoint,
      groupDidForJti: params.groupDid,
      nowMs,
    });

    const stagedSnap = await this.snapshotGroupManifestAndSizes({
      groupDid: params.groupDid,
      operationId: sess.operation_id,
      deadlineAtMs: sess.absolute_deadline_at,
      sourceLocalRotationKey: sess.source_local_rotation_key,
    });
    if (stagedSnap.manifestJson !== sess.expected_manifest_json) {
      throw new GroupHostHttpError(
        409,
        "MigrationManifestMismatch",
        "Staged target state does not match expected source manifest.",
      );
    }

    const signingKey = await this.repoStore.getGroupSigningKey(params.groupDid);
    const kemKey = await this.repoStore.getGroupKemKey(params.groupDid);
    const localRot = await this.repoStore.getGroupRotationKey(params.groupDid);
    if (!localRot) {
      throw new GroupHostHttpError(500, "InternalServerError", "Missing target local rotation key.");
    }

    const recRow = this.db
      .prepare("SELECT * FROM group_recovery_admin WHERE group_did = ?")
      .get(params.groupDid) as RecoveryAdminRow | undefined;
    const preservedSov = JSON.parse(sess.preserved_sovereign_keys_json) as string[];
    this.validateStagedOpenSocialIntegritySync({
      groupDid: params.groupDid,
      rotationKeysAfterCutover: [localRot.did(), ...preservedSov],
      localRotationDidKey: localRot.did(),
      sourceLocalRotationKey: sess.source_local_rotation_key,
      recoveryRow: recRow,
    });

    return {
      groupDid: params.groupDid,
      operationId: params.operationId,
      ticketId: params.ticketId,
      manifestDigest: sess.manifest_digest,
      targetEndpoint: this.config.publicUrl,
      targetServiceDid: this.config.serviceDid,
      targetSigningKey: signingKey.did(),
      targetKemKey: kemKey.did(),
      targetLocalRotationKey: localRot.did(),
    };
  }

  async abortMigrationOnSource(params: {
    session: AuthenticatedGroupSession;
    groupDid: string;
    operationId?: string;
    nowMs?: number;
  }): Promise<{ status: "aborted" | "already_absent" }> {
    const nowMs = params.nowMs ?? Date.now();
    if (params.session.groupDid !== params.groupDid) {
      throw new GroupHostHttpError(403, "Forbidden", "Session subject mismatch.");
    }
    params.session.permissions.assertAccount({ attr: "repo", action: "manage" });

    return this.locks.withGroupRepoLock(params.groupDid, async () => {
      // 1. Validate live OAuth session, governance permissions, and lifecycle-admin status synchronously FIRST
      //    (before any external Target purge or PLC head-advance side effects; OAuth revocations also serialize on `withGroupRepoLock`)!
      const lease = this.db
        .transaction(() => {
          const revalidated = revalidateLiveOAuthSessionSync(this.db, params.session, {
            allowPlcSignedSourceLease: true,
            nowMs,
          });
          revalidated.permissions.assertAccount({ attr: "repo", action: "manage" });
          if (!isAuthorizedLifecycleAdmin(params.session.authorizingUserDid, revalidated.liveState, params.groupDid)) {
            throw new GroupHostHttpError(403, "Forbidden", "Caller is not an authorized lifecycle admin.");
          }
          return this.db
            .prepare("SELECT * FROM source_migration_lease WHERE group_did = ?")
            .get(params.groupDid) as
            | {
                operation_id: string;
                mode: "coordinated" | "standard";
                ticket_id: string | null;
                target_service_did: string;
                target_endpoint: string;
                status: "prepared" | "plc_signed";
                signed_plc_op_json: string | null;
                deadline_at: number;
              }
            | undefined;
        })
        .immediate();

      const doc = await this.plc.resolveDidDocument(params.groupDid);
      if (doc && this.plc.extractPdsEndpoint(doc) !== normalizeOriginUrl(this.config.publicUrl)) {
        throw new GroupHostHttpError(409, "MigrationCutoverCommitted", "PLC #atproto_pds has already cut over.");
      }

      if (!lease || (params.operationId !== undefined && lease.operation_id !== params.operationId)) {
        return { status: "already_absent" };
      }

      // 2. When `lease.status === 'plc_signed'`, advance Source's PLC head FIRST (before purging Target!)
      //    so the signed cutover operation's `prev` is invalidated on PLC before Target keys/staging are deleted!
      if (lease.status === "plc_signed") {
        let signedPrevCid: string | null = null;
        if (lease.signed_plc_op_json) {
          try {
            const parsedSigned = JSON.parse(lease.signed_plc_op_json) as { prev?: unknown };
            if (typeof parsedSigned.prev === "string" && parsedSigned.prev.length > 0) {
              signedPrevCid = parsedSigned.prev;
            }
          } catch {
            signedPrevCid = null;
          }
        }
        const acct = this.db
          .prepare("SELECT handle FROM group_account WHERE did = ?")
          .get(params.groupDid) as { handle: string } | undefined;
        const lastOp = await this.plc.getPlcLastOp(params.groupDid);
        const localRot = await this.repoStore.getGroupRotationKey(params.groupDid);
        const sigKey = await this.repoStore.getGroupSigningKey(params.groupDid);
        const kemKey = await this.repoStore.getGroupKemKey(params.groupDid);
        const liveRotKeys = lastOp && lastOp.type !== "plc_tombstone" ? plcOpRotationKeys(lastOp) : [];
        if (acct && lastOp && lastOp.type !== "plc_tombstone" && localRot && liveRotKeys.includes(localRot.did())) {
          const prevCid = await plcCidForOp(lastOp);
          if (signedPrevCid === null || prevCid.toString() === signedPrevCid) {
            const baseOp = formatAtprotoOp({
              signingKey: sigKey.did(),
              handle: acct.handle,
              pds: groupHostPdsServiceEndpoint(this.config),
              rotationKeys: liveRotKeys,
              prev: prevCid,
            });
            const headAdvanceUnsigned: UnsignedOperation = {
              ...baseOp,
              verificationMethods: {
                ...baseOp.verificationMethods,
                atproto_kem: kemKey.did(),
              },
            };
            const signedHeadAdvance = await signOperation(headAdvanceUnsigned, localRot);
            const plcRes = await this.plc.submitPlcOperation(params.groupDid, signedHeadAdvance);
            if (!plcRes.ok) {
              // Re-check if target won the race on PLC!
              const freshDoc = await this.plc.resolveDidDocument(params.groupDid);
              if (freshDoc && this.plc.extractPdsEndpoint(freshDoc) !== normalizeOriginUrl(this.config.publicUrl)) {
                throw new GroupHostHttpError(409, "MigrationCutoverCommitted", "Target cutover committed concurrently.");
              }
              throw new GroupHostHttpError(
                502,
                "PlcAbortFailed",
                `Failed to advance PLC head during source abort (${plcRes.status}); source lease preserved for retry.`,
              );
            }
          }
        }
      }

      // 3. Strict Target cleanup: preserve `source_migration_lease` intact for retry if Target cleanup fails!
      if (lease.target_endpoint && lease.target_service_did && lease.operation_id.trim().length > 0) {
        await this.sendStrictTargetAbort(
          {
            group_did: params.groupDid,
            operation_id: lease.operation_id,
            mode: lease.mode,
            ticket_id: lease.ticket_id,
            target_service_did: lease.target_service_did,
            target_endpoint: lease.target_endpoint,
            deadline_at: lease.deadline_at,
          },
          nowMs,
        );
      }

      // 4. External Target purge (+ PLC head advance) succeeded under `withGroupRepoLock(groupDid)` —
      //    commit tombstone + lease deletion unconditionally so Source and Target/PLC state never split!
      const commitMs = Date.now();
      this.db
        .transaction(() => {
          if (lease.operation_id) {
            const existingTombstone = this.db
              .prepare("SELECT expires_at FROM service_jwt_jti WHERE issuer_did = ? AND jti = ?")
              .get(params.groupDid, `aborted-op:${lease.operation_id}`) as { expires_at: number } | undefined;
            this.db
              .prepare("INSERT OR REPLACE INTO service_jwt_jti (issuer_did, jti, group_did, expires_at) VALUES (?, ?, ?, ?)")
              .run(
                params.groupDid,
                `aborted-op:${lease.operation_id}`,
                params.groupDid,
                Math.max(existingTombstone?.expires_at ?? 0, lease.deadline_at, Math.max(nowMs, commitMs) + 2 * HOUR_MS),
              );
          }
          if (lease.ticket_id) {
            const ticketKey = `ticket:${lease.ticket_id}`;
            const existingTicket = this.db
              .prepare("SELECT expires_at FROM service_jwt_jti WHERE issuer_did = ? AND jti = ?")
              .get(params.groupDid, ticketKey) as { expires_at: number } | undefined;
            this.db
              .prepare("INSERT OR REPLACE INTO service_jwt_jti (issuer_did, jti, group_did, expires_at) VALUES (?, ?, ?, ?)")
              .run(
                params.groupDid,
                ticketKey,
                params.groupDid,
                Math.max(existingTicket?.expires_at ?? 0, lease.deadline_at, Math.max(nowMs, commitMs) + 2 * HOUR_MS),
              );
          }
          this.db
            .prepare("DELETE FROM source_migration_lease WHERE group_did = ? AND operation_id = ?")
            .run(params.groupDid, lease.operation_id);
        })
        .immediate();
      return { status: "aborted" };
    });
  }

  async abortMigrationOnTarget(params: {
    authorizationHeader: string | undefined;
    groupDid: string;
    operationId?: unknown;
    ticketId?: unknown;
    leaseAttemptId?: unknown;
    deadlineAtMs?: unknown;
    nowMs?: number;
  }): Promise<{ status: "purged" | "already_absent" | "superseded" }> {
    const nowMs = params.nowMs ?? Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    if (!isDid(params.groupDid)) {
      throw new GroupHostHttpError(400, "InvalidRequest", "Invalid group DID.");
    }

    // Authenticate either via unactivated `migration_session` Bearer (`at+jwt`) OR `<groupDid>` `#atproto` service JWT!
    const rawJwt = extractBearerToken(params.authorizationHeader);
    if (!rawJwt) {
      throw new GroupHostHttpError(401, "AuthMissing", "Bearer token required on target abort-migration.");
    }

    const jwtHeaderPart = rawJwt.split(".")[0];
    let jwtTyp: string | undefined;
    try {
      if (jwtHeaderPart) {
        jwtTyp = (JSON.parse(Buffer.from(jwtHeaderPart, "base64url").toString("utf8")) as { typ?: string }).typ;
      }
    } catch {
      jwtTyp = undefined;
    }

    let bearerClaims: { sub: string; sid: string; jti: string; epoch: number; exp: number } | undefined;
    let serviceJwtInfo: { jti: string; exp: number } | undefined;
    if (jwtTyp === "at+jwt") {
      bearerClaims = await this.verifyMigrationJwtClaims(params.authorizationHeader, false, nowMs);
      if (bearerClaims.sub !== params.groupDid) {
        throw new GroupHostHttpError(403, "Forbidden", "Migration token subject mismatch.");
      }
    } else {
      const parsed = parseServiceJwtParts(rawJwt);
      const iat = parsed.payload.iat;
      if (
        parsed.header.typ !== "JWT" ||
        (parsed.header.alg !== "ES256" && parsed.header.alg !== "ES256K") ||
        parsed.payload.iss !== params.groupDid ||
        parsed.payload.aud !== this.config.serviceDid ||
        parsed.payload.lxm !== FLOCK_GROUP_METHOD.abortMigration ||
        typeof iat !== "number" ||
        !Number.isFinite(iat) ||
        iat > nowSec + 5 ||
        typeof parsed.payload.exp !== "number" ||
        !Number.isFinite(parsed.payload.exp) ||
        parsed.payload.exp <= nowSec ||
        parsed.payload.exp <= iat ||
        parsed.payload.exp - iat > 60 ||
        typeof parsed.payload.jti !== "string" ||
        parsed.payload.jti.trim().length === 0 ||
        parsed.payload.jti.length > 256
      ) {
        throw new GroupHostHttpError(401, "InvalidToken", "Invalid abort-migration service JWT.");
      }
      const signingKeyDid = await this.plc.resolveSigningKey(params.groupDid, "#atproto");
      const sigOk = await cryptoVerifySignatureWithKey(
        signingKeyDid,
        parsed.signingInput,
        parsed.sigBytes,
        parsed.header.alg,
      ).catch(() => false);
      if (!sigOk) {
        throw new GroupHostHttpError(401, "InvalidSignature", "Abort JWT signature invalid.");
      }
      if (typeof params.operationId !== "string" || !isValidIdempotencyKey(params.operationId)) {
        throw new GroupHostHttpError(
          400,
          "InvalidRequest",
          "operationId (1..128 [A-Za-z0-9._:-] chars) is required for service-JWT migration abort.",
        );
      }
      serviceJwtInfo = { jti: parsed.payload.jti, exp: parsed.payload.exp };
    }

    return this.locks.withGroupRepoLock(params.groupDid, async () => {
      const recState = await this.reconcileUncutoverSessionLocked(params.groupDid, nowMs);
      if (recState === "cutover_committed") {
        throw new GroupHostHttpError(
          409,
          "MigrationCutoverCommitted",
          "Target migration cutover already committed.",
        );
      }

      if (bearerClaims !== undefined) {
        const preSess = this.db
          .prepare("SELECT id, auth_epoch, plc_cutover_at, absolute_deadline_at FROM migration_session WHERE group_did = ?")
          .get(params.groupDid) as
          | { id: string; auth_epoch: number; plc_cutover_at: number | null; absolute_deadline_at: number }
          | undefined;
        if (
          preSess &&
          preSess.id === bearerClaims.sid &&
          preSess.auth_epoch === bearerClaims.epoch &&
          preSess.plc_cutover_at === null &&
          nowMs >= preSess.absolute_deadline_at
        ) {
          throw new GroupHostHttpError(401, "ExpiredToken", "Migration session deadline expired.");
        }
      }

      if (recState === "pending_admissible") {
        throw new GroupHostHttpError(
          409,
          "MigrationCutoverCommitted",
          "Pending PLC cutover submission remains admissible against live PLC head; advance source PLC head before aborting target.",
        );
      }
      if (recState === "retain_fail_safe") {
        throw new GroupHostHttpError(
          502,
          "PlcDirectoryError",
          "Cannot abort migration while PLC cutover state is indeterminate; retry when PLC directory is reachable.",
        );
      }

      const doc = await this.plc.resolveDidDocument(params.groupDid);
      if (doc && this.plc.extractPdsEndpoint(doc) === normalizeOriginUrl(this.config.publicUrl)) {
        throw new GroupHostHttpError(409, "MigrationCutoverCommitted", "PLC #atproto_pds already points to this target host.");
      }

      const sess = this.db
        .prepare("SELECT * FROM migration_session WHERE group_did = ?")
        .get(params.groupDid) as
        | {
            mode: "coordinated" | "standard";
            operation_id: string | null;
            ticket_id: string | null;
            plc_cutover_at: number | null;
            plc_submitting_at: number | null;
            absolute_deadline_at: number;
            created_at: number;
          }
        | undefined;

      if (sess?.plc_cutover_at !== null && sess?.plc_cutover_at !== undefined) {
        throw new GroupHostHttpError(409, "MigrationCutoverCommitted", "Target migration cutover already committed.");
      }

      const tx = this.db.transaction(() => {
        const liveSess = this.db
          .prepare("SELECT * FROM migration_session WHERE group_did = ?")
          .get(params.groupDid) as
          | {
              id: string;
              mode: "coordinated" | "standard";
              operation_id: string | null;
              ticket_id: string | null;
              access_jti: string;
              prev_refresh_jti: string | null;
              auth_epoch: number;
              plc_cutover_at: number | null;
              absolute_deadline_at: number;
              created_at: number;
            }
          | undefined;

        if (liveSess?.plc_cutover_at !== null && liveSess?.plc_cutover_at !== undefined) {
          throw new GroupHostHttpError(409, "MigrationCutoverCommitted", "Target migration cutover already committed.");
        }

        if (serviceJwtInfo) {
          const dup = this.db
            .prepare("SELECT 1 AS ok FROM service_jwt_jti WHERE issuer_did = ? AND jti = ?")
            .get(params.groupDid, `abort-jwt:${serviceJwtInfo.jti}`);
          if (dup) {
            throw new GroupHostHttpError(401, "ReplayDetected", "Abort service JWT jti replay detected.");
          }
        }

        if (
          params.operationId !== undefined &&
          (typeof params.operationId !== "string" || !isValidIdempotencyKey(params.operationId))
        ) {
          throw new GroupHostHttpError(400, "InvalidRequest", "Invalid operationId.");
        }
        const operationId = params.operationId;
        if (
          params.ticketId !== undefined &&
          params.ticketId !== null &&
          (typeof params.ticketId !== "string" || !isValidIdempotencyKey(params.ticketId))
        ) {
          throw new GroupHostHttpError(400, "InvalidRequest", "Invalid ticketId.");
        }
        const ticketId = typeof params.ticketId === "string" ? params.ticketId : undefined;
        if (
          params.leaseAttemptId !== undefined &&
          (typeof params.leaseAttemptId !== "string" || !isValidIdempotencyKey(params.leaseAttemptId))
        ) {
          throw new GroupHostHttpError(400, "InvalidRequest", "Invalid leaseAttemptId.");
        }
        const leaseAttemptId = typeof params.leaseAttemptId === "string" ? params.leaseAttemptId : undefined;

        if (serviceJwtInfo) {
          if (
            liveSess?.mode === "coordinated" &&
            liveSess.operation_id === operationId &&
            (!ticketId || params.ticketId === null)
          ) {
            throw new GroupHostHttpError(400, "InvalidRequest", "ticketId is required for coordinated migration abort.");
          }
        } else if (liveSess?.mode === "coordinated" && params.ticketId === null) {
          throw new GroupHostHttpError(400, "InvalidRequest", "Invalid ticketId.");
        }

        const safeDeadlineAtMs =
          typeof params.deadlineAtMs === "number" && Number.isFinite(params.deadlineAtMs)
            ? params.deadlineAtMs
            : 0;
        const maxTombstoneExpiresAt = nowMs + 2 * HOUR_MS + 60_000;
        const clampedDeadlineAtMs = Math.min(Math.max(safeDeadlineAtMs, nowMs + 2 * HOUR_MS), maxTombstoneExpiresAt);
        const tombstoneExpiresAt = clampedDeadlineAtMs;

        const MAX_ABORT_ENTRIES_PER_ISSUER = 256;
        const MAX_ABORT_ENTRIES_TOTAL = 10_000;

        const upsertSemanticTombstoneSync = (jtiKey: string, minExpiresAt: number) => {
          const boundedExpiresAt = Math.min(minExpiresAt, maxTombstoneExpiresAt);
          const existing = this.db
            .prepare("SELECT expires_at FROM service_jwt_jti WHERE issuer_did = ? AND jti = ?")
            .get(params.groupDid, jtiKey) as { expires_at: number } | undefined;
          this.db
            .prepare("INSERT OR REPLACE INTO service_jwt_jti (issuer_did, jti, group_did, expires_at) VALUES (?, ?, ?, ?)")
            .run(params.groupDid, jtiKey, params.groupDid, Math.max(existing?.expires_at ?? 0, boundedExpiresAt));
        };

        const enforceAbortStorageQuotaSync = (candidateKeys: string[]) => {
          this.db
            .prepare("DELETE FROM service_jwt_jti WHERE rowid IN (SELECT rowid FROM service_jwt_jti WHERE expires_at <= ? LIMIT 500)")
            .run(nowMs);
          const uniqueKeys = [...new Set(candidateKeys)];
          if (uniqueKeys.length === 0) return;
          const existsStmt = this.db.prepare(
            "SELECT 1 AS ok FROM service_jwt_jti WHERE issuer_did = ? AND jti = ? AND expires_at > ?",
          );
          let netNew = 0;
          for (const k of uniqueKeys) {
            if (!existsStmt.get(params.groupDid, k, nowMs)) netNew += 1;
          }
          if (netNew === 0) return;
          const abortKeyPredicate =
            "(jti LIKE 'abort-jwt:%' OR jti LIKE 'aborted-op:%' OR jti LIKE 'ticket:%' OR jti LIKE 'lease-attempt:%')";
          const issuerActive = (
            this.db
              .prepare(`SELECT COUNT(*) AS cnt FROM service_jwt_jti WHERE issuer_did = ? AND expires_at > ? AND ${abortKeyPredicate}`)
              .get(params.groupDid, nowMs) as { cnt: number }
          ).cnt;
          const totalActive = (
            this.db
              .prepare(`SELECT COUNT(*) AS cnt FROM service_jwt_jti WHERE expires_at > ? AND ${abortKeyPredicate}`)
              .get(nowMs) as { cnt: number }
          ).cnt;
          if (
            issuerActive + netNew > MAX_ABORT_ENTRIES_PER_ISSUER ||
            totalActive + netNew > MAX_ABORT_ENTRIES_TOTAL
          ) {
            throw new GroupHostHttpError(
              429,
              "RateLimitExceeded",
              "Too many active migration abort entries for issuer or host.",
            );
          }
        };

        const recordConsumedTokensSync = (
          includeTicketTombstone: boolean,
          abortedLeaseAttemptId?: string | null,
        ) => {
          if (serviceJwtInfo) {
            this.db
              .prepare("INSERT INTO service_jwt_jti (issuer_did, jti, group_did, expires_at) VALUES (?, ?, ?, ?)")
              .run(
                params.groupDid,
                `abort-jwt:${serviceJwtInfo.jti}`,
                params.groupDid,
                Math.min(Math.max(serviceJwtInfo.exp * 1000, nowMs + 65_000), maxTombstoneExpiresAt),
              );
          }
          if (includeTicketTombstone && ticketId) {
            upsertSemanticTombstoneSync(`ticket:${ticketId}`, tombstoneExpiresAt);
          }
          if (abortedLeaseAttemptId) {
            upsertSemanticTombstoneSync(`lease-attempt:${abortedLeaseAttemptId}`, tombstoneExpiresAt);
          }
        };

        if (!liveSess) {
          if (serviceJwtInfo !== undefined) {
            const candidateKeys = [`abort-jwt:${serviceJwtInfo.jti}`];
            if (ticketId) candidateKeys.push(`ticket:${ticketId}`);
            if (leaseAttemptId) candidateKeys.push(`lease-attempt:${leaseAttemptId}`);
            if (operationId) candidateKeys.push(`aborted-op:${operationId}`);
            enforceAbortStorageQuotaSync(candidateKeys);
            recordConsumedTokensSync(true, leaseAttemptId);
            if (operationId) {
              upsertSemanticTombstoneSync(`aborted-op:${operationId}`, clampedDeadlineAtMs);
            }
          }
          return { status: "already_absent" as const };
        }

        if (bearerClaims !== undefined) {
          if (bearerClaims.sid !== liveSess.id || bearerClaims.epoch !== liveSess.auth_epoch) {
            return { status: "superseded" as const };
          }
          if (nowMs >= liveSess.absolute_deadline_at) {
            throw new GroupHostHttpError(401, "ExpiredToken", "Migration session deadline expired.");
          }
          if (bearerClaims.jti !== liveSess.access_jti) {
            const revokedJti = this.db
              .prepare("SELECT 1 AS ok FROM revoked_migration_jti WHERE jti = ?")
              .get(bearerClaims.jti);
            if (revokedJti) {
              this.purgeUncutoverSessionOnReplaySync(params.groupDid, bearerClaims.sid, bearerClaims.epoch, nowMs);
              throw new GroupHostHttpError(401, "InvalidToken", "Revoked migration token JTI replayed.");
            }
            throw new GroupHostHttpError(401, "InvalidToken", "Migration token JTI or epoch mismatch.");
          }
          if (liveSess.prev_refresh_jti !== null) {
            this.db
              .prepare(
                `UPDATE migration_session
                 SET prev_refresh_jti = NULL, refresh_idempotency_key = NULL, refresh_grace_expires_at = NULL
                 WHERE id = ? AND access_jti = ?`,
              )
              .run(liveSess.id, bearerClaims.jti);
          }
        }

        const hasTicketMismatch =
          liveSess.mode === "coordinated"
            ? serviceJwtInfo !== undefined
              ? liveSess.ticket_id !== ticketId
              : ticketId !== undefined && liveSess.ticket_id !== ticketId
            : ticketId !== undefined;

        const hasOperationMismatch =
          serviceJwtInfo !== undefined
            ? liveSess.operation_id === null || liveSess.operation_id !== operationId
            : operationId !== undefined &&
              liveSess.operation_id !== null &&
              liveSess.operation_id !== operationId;

        const hasLeaseAttemptMismatch =
          serviceJwtInfo !== undefined &&
          liveSess.mode === "standard" &&
          (leaseAttemptId === undefined ||
            liveSess.ticket_id === null ||
            liveSess.ticket_id !== leaseAttemptId);

        const isSuperseded = hasTicketMismatch || hasOperationMismatch || hasLeaseAttemptMismatch;

        if (isSuperseded) {
          if (serviceJwtInfo !== undefined) {
            const includeTicket = ticketId !== undefined && ticketId !== liveSess.ticket_id;
            const supersededLeaseAttempt =
              leaseAttemptId !== undefined && leaseAttemptId !== liveSess.ticket_id ? leaseAttemptId : null;
            const candidateKeys = [`abort-jwt:${serviceJwtInfo.jti}`];
            if (includeTicket && ticketId) candidateKeys.push(`ticket:${ticketId}`);
            if (supersededLeaseAttempt) candidateKeys.push(`lease-attempt:${supersededLeaseAttempt}`);
            if (operationId && liveSess.operation_id !== operationId) candidateKeys.push(`aborted-op:${operationId}`);
            enforceAbortStorageQuotaSync(candidateKeys);
            recordConsumedTokensSync(includeTicket, supersededLeaseAttempt);
            if (operationId && liveSess.operation_id !== operationId) {
              upsertSemanticTombstoneSync(`aborted-op:${operationId}`, clampedDeadlineAtMs);
            }
          }
          return { status: "superseded" as const };
        }

        const retiredTicketId = liveSess.mode === "coordinated" ? ticketId : undefined;
        const retiredLeaseAttemptId = liveSess.ticket_id;
        const purgeCandidateKeys: string[] = [];
        if (serviceJwtInfo !== undefined) purgeCandidateKeys.push(`abort-jwt:${serviceJwtInfo.jti}`);
        if (retiredTicketId) purgeCandidateKeys.push(`ticket:${retiredTicketId}`);
        if (retiredLeaseAttemptId) purgeCandidateKeys.push(`lease-attempt:${retiredLeaseAttemptId}`);
        if (liveSess.operation_id !== null) purgeCandidateKeys.push(`aborted-op:${liveSess.operation_id}`);
        enforceAbortStorageQuotaSync(purgeCandidateKeys);

        purgeMigrationStagingDataSync(this.db, params.groupDid, nowMs);
        recordConsumedTokensSync(retiredTicketId !== undefined, retiredLeaseAttemptId);
        if (liveSess.operation_id !== null) {
          upsertSemanticTombstoneSync(
            `aborted-op:${liveSess.operation_id}`,
            Math.max(liveSess.absolute_deadline_at, clampedDeadlineAtMs),
          );
        }
        return { status: "purged" as const };
      });
      return tx.immediate();
    });
  }

  async finalizeMigratedSource(params: {
    authorizationHeader: string | undefined;
    groupDid: string;
    operationId?: string;
    nowMs?: number;
  }): Promise<{ status: "finalized" | "already_finalized" }> {
    const nowMs = params.nowMs ?? Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    if (!isDid(params.groupDid)) {
      throw new GroupHostHttpError(400, "InvalidRequest", "Invalid group DID.");
    }

    return this.locks.withGroupRepoLock(params.groupDid, async () => {
      const acct = this.db
        .prepare("SELECT activated FROM group_account WHERE did = ?")
        .get(params.groupDid) as { activated: number } | undefined;
      const delRow = this.db
        .prepare("SELECT 1 AS ok FROM group_deletion_journal WHERE group_did = ?")
        .get(params.groupDid);
      const leaseRow = this.db
        .prepare("SELECT 1 AS ok FROM source_migration_lease WHERE group_did = ?")
        .get(params.groupDid);

      if (!acct || delRow || (acct.activated === 0 && !leaseRow)) {
        return { status: "already_finalized" };
      }

      const rawJwt = extractBearerToken(params.authorizationHeader);
      if (!rawJwt) {
        throw new GroupHostHttpError(401, "AuthMissing", "Bearer token required.");
      }
      const parsed = parseServiceJwtParts(rawJwt);
      const iat = parsed.payload.iat;
      const exp = parsed.payload.exp;
      if (
        parsed.header.typ !== "JWT" ||
        parsed.header.alg !== "ES256" ||
        parsed.payload.iss !== params.groupDid ||
        parsed.payload.aud !== this.config.serviceDid ||
        parsed.payload.lxm !== "com.atproto.server.deactivateAccount" ||
        typeof parsed.payload.jti !== "string" ||
        parsed.payload.jti.trim().length === 0 ||
        typeof iat !== "number" ||
        !Number.isFinite(iat) ||
        iat > nowSec + 5 ||
        typeof exp !== "number" ||
        !Number.isFinite(exp) ||
        exp <= nowSec ||
        exp - iat <= 0 ||
        exp - iat > 60
      ) {
        throw new GroupHostHttpError(401, "InvalidToken", "Invalid finalize-migrated-source service JWT.");
      }

      const doc = await this.plc.resolveDidDocument(params.groupDid);
      if (!doc) {
        throw new GroupHostHttpError(400, "UnresolvableDid", "Group DID not resolvable.");
      }
      if (this.plc.extractPdsEndpoint(doc) === normalizeOriginUrl(this.config.publicUrl)) {
        throw new GroupHostHttpError(409, "CutoverNotActive", "PLC #atproto_pds still points to this host.");
      }

      const targetSigningKey = this.plc.extractVerificationMethodDidKey(doc, "#atproto");
      if (!targetSigningKey) {
        throw new GroupHostHttpError(401, "SigningKeyNotFound", "Target #atproto key missing on PLC.");
      }
      const sigOk = await cryptoVerifySignatureWithKey(
        targetSigningKey,
        parsed.signingInput,
        parsed.sigBytes,
        "ES256",
      ).catch(() => false);
      if (!sigOk) {
        throw new GroupHostHttpError(401, "InvalidSignature", "JWT signature does not match live PLC #atproto key.");
      }

      const jtiKey = `jwt:${parsed.payload.jti}`;
      const tx = this.db.transaction(() => {
        const dup = this.db
          .prepare("SELECT 1 AS ok FROM service_jwt_jti WHERE issuer_did = ? AND jti = ?")
          .get(params.groupDid, jtiKey);
        if (dup) {
          throw new GroupHostHttpError(401, "ReplayDetected", "Finalize JWT jti replay detected.");
        }
        this.db
          .prepare("INSERT INTO service_jwt_jti (issuer_did, jti, group_did, expires_at) VALUES (?, ?, ?, ?)")
          .run(params.groupDid, jtiKey, params.groupDid, Math.max(parsed.payload.exp * 1000, nowMs + 65_000));

        this.db
          .prepare("UPDATE group_account SET auth_epoch = auth_epoch + 1, activated = 0, deactivated_at = ? WHERE did = ?")
          .run(nowMs, params.groupDid);
        this.db.prepare("DELETE FROM source_migration_lease WHERE group_did = ?").run(params.groupDid);
        this.db.prepare("DELETE FROM migration_session WHERE group_did = ?").run(params.groupDid);
        this.db.prepare("DELETE FROM revoked_migration_jti WHERE group_did = ?").run(params.groupDid);
        this.db.prepare("DELETE FROM oauth_par WHERE group_did = ?").run(params.groupDid);
        this.db.prepare("DELETE FROM oauth_consent_snapshot WHERE group_did = ?").run(params.groupDid);
        this.db.prepare("DELETE FROM upstream_oauth_state WHERE group_did = ?").run(params.groupDid);
        this.db.prepare("DELETE FROM oauth_code WHERE group_did = ?").run(params.groupDid);
        this.db.prepare("DELETE FROM oauth_refresh_token WHERE group_did = ?").run(params.groupDid);
        this.db.prepare("DELETE FROM oauth_session WHERE group_did = ?").run(params.groupDid);
      });
      tx.immediate();

      return { status: "finalized" };
    });
  }

  private preparedLeaseSweepCursorDid = "";

  async sweepExpiredPreparedMigrationLeases(nowMs = Date.now()): Promise<void> {
    const PAGE_SIZE = 50;
    const MAX_PER_SWEEP = 500;
    const stmtUnbounded = this.db.prepare(
      `SELECT group_did FROM source_migration_lease
       WHERE status = 'prepared' AND expires_at IS NOT NULL AND expires_at <= ?
         AND group_did > ?
       ORDER BY group_did ASC
       LIMIT ?`,
    );
    const stmtBounded = this.db.prepare(
      `SELECT group_did FROM source_migration_lease
       WHERE status = 'prepared' AND expires_at IS NOT NULL AND expires_at <= ?
         AND group_did > ?
         AND group_did <= ?
       ORDER BY group_did ASC
       LIMIT ?`,
    );

    const initialCursor = this.preparedLeaseSweepCursorDid;
    let cursor = initialCursor;
    let wrapped = false;
    let processed = 0;

    while (processed < MAX_PER_SWEEP) {
      const limit = Math.min(PAGE_SIZE, MAX_PER_SWEEP - processed);
      const batch = (
        wrapped
          ? stmtBounded.all(nowMs, cursor, initialCursor, limit)
          : stmtUnbounded.all(nowMs, cursor, limit)
      ) as Array<{ group_did: string }>;

      for (const row of batch) {
        cursor = row.group_did;
        this.preparedLeaseSweepCursorDid = cursor;
        processed += 1;
        try {
          await this.locks.withGroupRepoLock(row.group_did, () =>
            reapExpiredPreparedMigrationLease(this.db, row.group_did, nowMs),
          );
        } catch {
          // Isolate individual lease failures so cursor and subsequent leases still progress
        }
      }

      if (batch.length < limit) {
        if (!wrapped && initialCursor !== "") {
          cursor = "";
          wrapped = true;
        } else {
          cursor = "";
          break;
        }
      }
    }
    this.preparedLeaseSweepCursorDid = cursor;

    await this.flushPendingTargetAborts();
  }

  /**
   * Reconciles an unactivated `migration_session` (`plc_cutover_at IS NULL`) against live PLC
   * `/log/last` + DID document while holding `withGroupRepoLock(groupDid)`.
   *
   * - Exact live cutover to this Target host -> stamps `plc_cutover_at` and returns `"cutover_committed"`.
   * - PLC unreachable / error / `#atproto_pds` pointing to this host in an unexpected state -> returns
   *   `"retain_fail_safe"` (never destructively purge!).
   * - PLC reachable and `#atproto_pds` does NOT point to this host -> clears any stale pre-PLC
   *   `plc_submitting_at` marker and returns `"not_cutover"`.
   */
  private async reconcileUncutoverSessionLocked(
    groupDid: string,
    nowMs = Date.now(),
  ): Promise<
    | "cutover_committed"
    | "pending_admissible"
    | "not_cutover"
    | "retain_fail_safe"
    | "no_session"
    | "already_activated"
  > {
    const migSess = this.db
      .prepare(
        `SELECT id, source_local_rotation_key, preserved_sovereign_keys_json,
                plc_cutover_at, plc_submitting_at, pending_plc_op_cid, pending_plc_op_json
         FROM migration_session WHERE group_did = ?`,
      )
      .get(groupDid) as
      | {
          id: string;
          source_local_rotation_key: string | null;
          preserved_sovereign_keys_json: string;
          plc_cutover_at: number | null;
          plc_submitting_at: number | null;
          pending_plc_op_cid: string | null;
          pending_plc_op_json: string | null;
        }
      | undefined;
    if (!migSess) return "no_session";
    if (migSess.plc_cutover_at !== null) return "cutover_committed";

    const acct = this.db
      .prepare("SELECT handle, activated, takendown FROM group_account WHERE did = ?")
      .get(groupDid) as { handle: string; activated: number; takendown: number } | undefined;
    if (!acct) return "no_session";
    if (acct.activated === 1) return "already_activated";

    const hasPendingMarker = migSess.plc_submitting_at !== null || migSess.pending_plc_op_cid !== null;
    let pendingPrevCid: string | null = null;
    if (migSess.pending_plc_op_json !== null) {
      try {
        const parsed = JSON.parse(migSess.pending_plc_op_json) as { prev?: unknown };
        if (typeof parsed.prev !== "string" || parsed.prev.length === 0) {
          return "retain_fail_safe";
        }
        pendingPrevCid = parsed.prev;
      } catch {
        return "retain_fail_safe";
      }
    } else if (hasPendingMarker) {
      return "retain_fail_safe";
    }

    let doc: Awaited<ReturnType<typeof this.plc.resolveDidDocument>>;
    let lastOp: CompatibleOpOrTombstone | null;
    try {
      doc = await this.plc.resolveDidDocument(groupDid);
      lastOp = await this.plc.getPlcLastOp(groupDid);
    } catch {
      return "retain_fail_safe";
    }

    if (lastOp?.type === "plc_tombstone") {
      if (hasPendingMarker) {
        this.db
          .prepare(
            "UPDATE migration_session SET plc_submitting_at = NULL, pending_plc_op_cid = NULL, pending_plc_op_json = NULL WHERE id = ? AND plc_cutover_at IS NULL",
          )
          .run(migSess.id);
      }
      return "not_cutover";
    }

    if (!doc || !lastOp) {
      if (hasPendingMarker) {
        return "retain_fail_safe";
      }
      return "not_cutover";
    }

    const headCid = await plcCidForOp(lastOp).then((c) => c.toString()).catch(() => null);
    if (headCid === null && hasPendingMarker) {
      return "retain_fail_safe";
    }

    let expectedOrigin: string;
    let liveOrigin: string | null;
    try {
      expectedOrigin = normalizeOriginUrl(this.config.publicUrl);
      liveOrigin = this.plc.extractPdsEndpoint(doc);
    } catch {
      return "retain_fail_safe";
    }

    if (liveOrigin !== expectedOrigin) {
      if (migSess.pending_plc_op_cid !== null && headCid !== null && headCid === migSess.pending_plc_op_cid) {
        // `/log/last` already matches `pending_plc_op_cid` while DID doc resolution lagged — fail safe!
        return "retain_fail_safe";
      }
      if (hasPendingMarker && pendingPrevCid !== null && headCid === pendingPrevCid) {
        // Live `/log/last` head still equals the pending cutover operation's `prev`!
        // The submitted PLC operation remains admissible and may commit asynchronously — DO NOT clear pending state or purge!
        return "pending_admissible";
      }
      if (hasPendingMarker) {
        // Live `/log/last` head has provably advanced past `pendingOp.prev` to a different operation on another host,
        // so `pendingOp` is permanently inadmissible on PLC due to `prev` CAS mismatch.
        this.db
          .prepare(
            "UPDATE migration_session SET plc_submitting_at = NULL, pending_plc_op_cid = NULL, pending_plc_op_json = NULL WHERE id = ? AND plc_cutover_at IS NULL",
          )
          .run(migSess.id);
      }
      return "not_cutover";
    }

    // Live PLC `#atproto_pds` points to THIS Target host! Verify target key & handle invariants fail-safely.
    let localSigning: P256Keypair;
    let localKem: P256Keypair;
    let localRot: Awaited<ReturnType<GroupRepoStore["getGroupRotationKey"]>>;
    try {
      localSigning = (await this.repoStore.getGroupSigningKey(groupDid)) as P256Keypair;
      localKem = (await this.repoStore.getGroupKemKey(groupDid)) as P256Keypair;
      localRot = await this.repoStore.getGroupRotationKey(groupDid);
    } catch {
      return "retain_fail_safe";
    }
    if (!localRot) {
      return "retain_fail_safe";
    }

    let cutoverRotKeys: string[];
    let exactTargetCutover = false;
    try {
      cutoverRotKeys = plcOpRotationKeys(lastOp);
      const parsedSov = JSON.parse(migSess.preserved_sovereign_keys_json) as unknown;
      if (!Array.isArray(parsedSov) || !parsedSov.every((item): item is string => typeof item === "string")) {
        return "retain_fail_safe";
      }
      const preservedSov = parsedSov;
      const akaFirst = Array.isArray(doc.alsoKnownAs) ? doc.alsoKnownAs[0] : undefined;
      exactTargetCutover =
        (migSess.pending_plc_op_cid !== null && headCid !== null && headCid === migSess.pending_plc_op_cid) ||
        (this.plc.extractVerificationMethodDidKey(doc, "#atproto") === localSigning.did() &&
          this.plc.extractKemDidKey(doc) === localKem.did() &&
          akaFirst === `at://${acct.handle}` &&
          cutoverRotKeys.length >= 1 &&
          cutoverRotKeys.length <= 5 &&
          cutoverRotKeys.includes(localRot.did()) &&
          (migSess.source_local_rotation_key === null || !cutoverRotKeys.includes(migSess.source_local_rotation_key)) &&
          preservedSov.every((sov) => cutoverRotKeys.includes(sov)));
    } catch {
      // Malformed DID doc (e.g. KemKeyError when `#atproto_kem` is missing/invalid) while `#atproto_pds` points to this host -> retain fail-safe!
      return "retain_fail_safe";
    }

    if (!exactTargetCutover) {
      // Live `#atproto_pds` points to this host, so NEVER destructively purge local keys!
      return "retain_fail_safe";
    }

    try {
      const recRow = this.db
        .prepare("SELECT * FROM group_recovery_admin WHERE group_did = ?")
        .get(groupDid) as RecoveryAdminRow | undefined;
      this.db
        .transaction(() => {
          this.validateStagedOpenSocialIntegritySync({
            groupDid,
            rotationKeysAfterCutover: cutoverRotKeys,
            localRotationDidKey: localRot.did(),
            sourceLocalRotationKey: migSess.source_local_rotation_key,
            recoveryRow: recRow,
          });
          this.db
            .prepare(
              "UPDATE migration_session SET plc_cutover_at = ?, plc_submitting_at = NULL, pending_plc_op_cid = NULL, pending_plc_op_json = NULL WHERE id = ? AND plc_cutover_at IS NULL",
            )
            .run(nowMs, migSess.id);
        })
        .immediate();
      return "cutover_committed";
    } catch {
      return "retain_fail_safe";
    }
  }

  private migrationSessionSweepCursor = "";

  /**
   * Startup and periodic maintenance sweep for un-cutover `migration_session` rows (`plc_submitting_at IS NOT NULL`,
   * `pending_plc_op_cid IS NOT NULL`, or `absolute_deadline_at <= nowMs`). Always reconciles `/log/last` under
   * `withGroupRepoLock(groupDid)` before purging; stamps `plc_cutover_at` when live cutover landed on PLC and fails
   * safe without purging when PLC is unavailable or when a pending PLC operation remains admissible (`headCid === prev`).
   * Uses primary-key keyset pagination (`id ASC`) with a persistent wrap-around cursor so retained `pending_admissible`
   * / `retain_fail_safe` sessions never starve expired sessions behind them.
   */
  async sweepExpiredMigrationSessions(nowMs = Date.now()): Promise<void> {
    const PAGE_SIZE = 50;
    const MAX_PER_SWEEP = 500;
    const stmtUnbounded = this.db.prepare(
      `SELECT id, group_did FROM migration_session
       WHERE plc_cutover_at IS NULL
         AND (plc_submitting_at IS NOT NULL OR pending_plc_op_cid IS NOT NULL OR absolute_deadline_at <= ?)
         AND id > ?
       ORDER BY id ASC
       LIMIT ?`,
    );
    const stmtBounded = this.db.prepare(
      `SELECT id, group_did FROM migration_session
       WHERE plc_cutover_at IS NULL
         AND (plc_submitting_at IS NOT NULL OR pending_plc_op_cid IS NOT NULL OR absolute_deadline_at <= ?)
         AND id > ?
         AND id <= ?
       ORDER BY id ASC
       LIMIT ?`,
    );

    const initialCursor = this.migrationSessionSweepCursor;
    let cursor = initialCursor;
    let wrapped = false;
    let processed = 0;

    while (processed < MAX_PER_SWEEP) {
      const limit = Math.min(PAGE_SIZE, MAX_PER_SWEEP - processed);
      const candidates = (
        wrapped
          ? stmtBounded.all(nowMs, cursor, initialCursor, limit)
          : stmtUnbounded.all(nowMs, cursor, limit)
      ) as Array<{ id: string; group_did: string }>;

      for (const cand of candidates) {
        cursor = cand.id;
        this.migrationSessionSweepCursor = cursor;
        processed += 1;
        try {
          await this.locks.withGroupRepoLock(cand.group_did, async () => {
            const recState = await this.reconcileUncutoverSessionLocked(cand.group_did, nowMs);
            if (
              recState === "cutover_committed" ||
              recState === "pending_admissible" ||
              recState === "retain_fail_safe" ||
              recState === "no_session"
            ) {
              return;
            }
            this.db
              .transaction(() => {
                const liveSess = this.db
                  .prepare(
                    "SELECT id, operation_id, plc_cutover_at, plc_submitting_at, pending_plc_op_cid, absolute_deadline_at FROM migration_session WHERE group_did = ?",
                  )
                  .get(cand.group_did) as
                  | {
                      id: string;
                      operation_id: string | null;
                      plc_cutover_at: number | null;
                      plc_submitting_at: number | null;
                      pending_plc_op_cid: string | null;
                      absolute_deadline_at: number;
                    }
                  | undefined;
                if (
                  !liveSess ||
                  liveSess.id !== cand.id ||
                  liveSess.plc_cutover_at !== null ||
                  liveSess.plc_submitting_at !== null ||
                  liveSess.pending_plc_op_cid !== null ||
                  liveSess.absolute_deadline_at > nowMs
                ) {
                  return;
                }
                if (liveSess.operation_id !== null) {
                  const existingTombstone = this.db
                    .prepare("SELECT expires_at FROM service_jwt_jti WHERE issuer_did = ? AND jti = ?")
                    .get(cand.group_did, `aborted-op:${liveSess.operation_id}`) as { expires_at: number } | undefined;
                  this.db
                    .prepare("INSERT OR REPLACE INTO service_jwt_jti (issuer_did, jti, group_did, expires_at) VALUES (?, ?, ?, ?)")
                    .run(
                      cand.group_did,
                      `aborted-op:${liveSess.operation_id}`,
                      cand.group_did,
                      Math.max(existingTombstone?.expires_at ?? 0, nowMs + 2 * HOUR_MS),
                    );
                }
                const acct = this.db
                  .prepare("SELECT activated FROM group_account WHERE did = ?")
                  .get(cand.group_did) as { activated: number } | undefined;
                if (!acct || acct.activated === 0) {
                  purgeMigrationStagingDataSync(this.db, cand.group_did, nowMs);
                } else {
                  this.db
                    .prepare("DELETE FROM migration_session WHERE id = ? AND plc_cutover_at IS NULL")
                    .run(liveSess.id);
                }
              })
              .immediate();
          });
        } catch {
          // Per-candidate isolation: fail safe without aborting cursor progress or subsequent sweep candidates!
        }
      }

      if (candidates.length < limit) {
        if (!wrapped && initialCursor !== "") {
          cursor = "";
          wrapped = true;
        } else {
          cursor = "";
          break;
        }
      }
    }
    this.migrationSessionSweepCursor = cursor;
  }

  // =========================================================================
  // Target `createAccount`, `refreshSession`, & `authenticateMigrationBearer`
  // =========================================================================

  private async signMigrationSessionTokens(params: {
    groupDid: string;
    sessionId: string;
    accessJti: string;
    refreshJti: string;
    authEpoch: number;
    absoluteDeadlineAt: number;
    plcCutoverCommitted: boolean;
    nowMs: number;
  }): Promise<{ accessJwt: string; refreshJwt: string }> {
    const nowSec = Math.floor(params.nowMs / 1000);
    // Once `plc_cutover_at !== null`, migration_session is exempt from `absolute_deadline_at` expiry!
    // `refreshJwt` carries a 30-day cryptographic `exp` while `refreshMigrationSession` enforces
    // `absolute_deadline_at` in SQLite after reconciling any crash-window PLC cutover.
    const accessExp = params.plcCutoverCommitted
      ? nowSec + 900
      : Math.min(nowSec + 900, Math.ceil(params.absoluteDeadlineAt / 1000));
    const refreshExp = nowSec + 30 * 86_400;

    const accessHeader = { alg: "ES256", typ: "at+jwt", kid: this.serviceKeys.activeJwkKid };
    const accessPayload = {
      iss: this.config.publicUrl,
      sub: params.groupDid,
      sid: params.sessionId,
      aud: this.config.serviceDid,
      jti: params.accessJti,
      epoch: params.authEpoch,
      iat: nowSec,
      exp: Math.max(accessExp, nowSec + 1),
      mig: true,
    };
    const accessInput = `${Buffer.from(JSON.stringify(accessHeader)).toString("base64url")}.${Buffer.from(JSON.stringify(accessPayload)).toString("base64url")}`;
    const accessSig = await this.serviceKeys.activeKeypair.sign(Buffer.from(accessInput, "utf8"));

    const refreshHeader = { alg: "ES256", typ: "refresh+jwt", kid: this.serviceKeys.activeJwkKid };
    const refreshPayload = {
      iss: this.config.publicUrl,
      sub: params.groupDid,
      sid: params.sessionId,
      aud: this.config.serviceDid,
      jti: params.refreshJti,
      epoch: params.authEpoch,
      iat: nowSec,
      exp: Math.max(refreshExp, nowSec + 1),
      mig: true,
    };
    const refreshInput = `${Buffer.from(JSON.stringify(refreshHeader)).toString("base64url")}.${Buffer.from(JSON.stringify(refreshPayload)).toString("base64url")}`;
    const refreshSig = await this.serviceKeys.activeKeypair.sign(Buffer.from(refreshInput, "utf8"));

    return {
      accessJwt: `${accessInput}.${Buffer.from(accessSig).toString("base64url")}`,
      refreshJwt: `${refreshInput}.${Buffer.from(refreshSig).toString("base64url")}`,
    };
  }

  private async verifyMigrationJwtClaims(
    authorizationHeader: string | undefined,
    isRefresh: boolean,
    nowMs = Date.now(),
  ): Promise<{ sub: string; sid: string; jti: string; epoch: number; exp: number }> {
    const rawJwt = extractBearerToken(authorizationHeader);
    if (!rawJwt) {
      throw new GroupHostHttpError(401, "AuthMissing", "Migration Bearer token required.");
    }

    let verified: jose.JWTVerifyResult;
    try {
      const localJwks = jose.createLocalJWKSet({ keys: this.serviceKeys.publicJwks as unknown as jose.JWK[] });
      verified = await jose.jwtVerify(rawJwt, localJwks, {
        typ: isRefresh ? "refresh+jwt" : "at+jwt",
        algorithms: ["ES256"],
        issuer: this.config.publicUrl,
        audience: this.config.serviceDid,
        clockTolerance: 0,
        currentDate: new Date(nowMs),
      });
    } catch (err) {
      throw new GroupHostHttpError(401, "ExpiredToken", err instanceof Error ? err.message : "Invalid migration token.");
    }

    const payload = verified.payload as {
      sub?: string;
      sid?: string;
      jti?: string;
      epoch?: number;
      exp?: number;
      mig?: boolean;
    };
    if (
      !payload.mig ||
      typeof payload.sub !== "string" ||
      typeof payload.sid !== "string" ||
      payload.sid.length === 0 ||
      typeof payload.jti !== "string" ||
      typeof payload.epoch !== "number" ||
      typeof payload.exp !== "number"
    ) {
      throw new GroupHostHttpError(401, "InvalidToken", "Malformed migration token payload.");
    }

    return {
      sub: payload.sub,
      sid: payload.sid,
      jti: payload.jti,
      epoch: payload.epoch,
      exp: payload.exp,
    };
  }

  private purgeUncutoverSessionOnReplaySync(
    groupDid: string,
    presentedSessionId: string,
    presentedEpoch: number,
    nowMs: number,
  ): void {
    const sessCheck = this.db
      .prepare(
        "SELECT id, operation_id, auth_epoch, plc_cutover_at, plc_submitting_at, pending_plc_op_cid, absolute_deadline_at FROM migration_session WHERE group_did = ?",
      )
      .get(groupDid) as
      | {
          id: string;
          operation_id: string | null;
          auth_epoch: number;
          plc_cutover_at: number | null;
          plc_submitting_at: number | null;
          pending_plc_op_cid: string | null;
          absolute_deadline_at: number;
        }
      | undefined;
    if (
      sessCheck &&
      sessCheck.id === presentedSessionId &&
      sessCheck.auth_epoch === presentedEpoch &&
      sessCheck.plc_cutover_at === null &&
      sessCheck.plc_submitting_at === null &&
      sessCheck.pending_plc_op_cid === null
    ) {
      purgeMigrationStagingDataSync(this.db, groupDid, nowMs);
      if (sessCheck.operation_id !== null) {
        this.db
          .prepare(
            "INSERT OR REPLACE INTO service_jwt_jti (issuer_did, jti, group_did, expires_at) VALUES (?, ?, ?, ?)",
          )
          .run(
            groupDid,
            `aborted-op:${sessCheck.operation_id}`,
            groupDid,
            Math.max(sessCheck.absolute_deadline_at, nowMs + 2 * HOUR_MS),
          );
      }
    }
  }

  async authenticateMigrationBearer(
    authorizationHeader: string | undefined,
    isRefresh: boolean,
    nowMs = Date.now(),
  ): Promise<AuthenticatedMigrationSession> {
    const payload = await this.verifyMigrationJwtClaims(authorizationHeader, isRefresh, nowMs);

    const revokedJti = this.db
      .prepare("SELECT 1 AS ok FROM revoked_migration_jti WHERE jti = ?")
      .get(payload.jti);
    if (revokedJti) {
      await this.locks.withGroupRepoLock(payload.sub, async () => {
        const recState = await this.reconcileUncutoverSessionLocked(payload.sub, nowMs);
        if (recState === "not_cutover") {
          this.db
            .transaction(() => {
              this.purgeUncutoverSessionOnReplaySync(payload.sub, payload.sid, payload.epoch, nowMs);
            })
            .immediate();
        }
      });
      throw new GroupHostHttpError(401, "InvalidToken", "Revoked migration token JTI replayed.");
    }

    type MigrationSessionRow = {
      id: string;
      group_did: string;
      mode: "coordinated" | "standard";
      operation_id: string | null;
      ticket_id: string | null;
      source_endpoint: string;
      source_service_did: string | null;
      source_local_rotation_key: string | null;
      preserved_sovereign_keys_json: string;
      manifest_digest: string | null;
      expected_manifest_json: string | null;
      access_jti: string;
      refresh_jti: string;
      prev_refresh_jti: string | null;
      auth_epoch: number;
      plc_cutover_at: number | null;
      plc_submitting_at: number | null;
      pending_plc_op_cid: string | null;
      absolute_deadline_at: number;
    };

    let sess = this.db
      .prepare("SELECT * FROM migration_session WHERE group_did = ?")
      .get(payload.sub) as MigrationSessionRow | undefined;

    if (!sess) {
      throw new GroupHostHttpError(401, "InvalidToken", "Migration session not found.");
    }
    if (
      sess.plc_cutover_at === null &&
      (sess.plc_submitting_at !== null || sess.pending_plc_op_cid !== null || nowMs >= sess.absolute_deadline_at)
    ) {
      await this.locks.withGroupRepoLock(sess.group_did, async () => {
        await this.reconcileUncutoverSessionLocked(sess!.group_did, nowMs);
      });
      sess = this.db
        .prepare("SELECT * FROM migration_session WHERE group_did = ?")
        .get(payload.sub) as MigrationSessionRow | undefined;
      if (!sess) {
        throw new GroupHostHttpError(401, "InvalidToken", "Migration session not found.");
      }
    }
    if (sess.plc_cutover_at === null && nowMs >= sess.absolute_deadline_at) {
      throw new GroupHostHttpError(401, "ExpiredToken", "Migration session deadline expired.");
    }

    const expectedJti = isRefresh ? sess.refresh_jti : sess.access_jti;
    if (payload.sid !== sess.id || payload.jti !== expectedJti || payload.epoch !== sess.auth_epoch) {
      throw new GroupHostHttpError(401, "InvalidToken", "Migration token JTI or epoch mismatch.");
    }

    if (!isRefresh && sess.prev_refresh_jti !== null) {
      this.db
        .prepare(
          `UPDATE migration_session
           SET prev_refresh_jti = NULL, refresh_idempotency_key = NULL, refresh_grace_expires_at = NULL
           WHERE id = ? AND access_jti = ?`,
        )
        .run(sess.id, payload.jti);
    }

    const fullPerms = expandGroupScopes(groupAdminScopes(sess.group_did), sess.group_did);
    return {
      kind: "migration",
      id: sess.id,
      groupDid: sess.group_did,
      presentedJti: payload.jti,
      expSec: payload.exp,
      mode: sess.mode,
      operationId: sess.operation_id,
      ticketId: sess.ticket_id,
      sourceEndpoint: sess.source_endpoint,
      sourceServiceDid: sess.source_service_did,
      sourceLocalRotationKey: sess.source_local_rotation_key,
      preservedSovereignKeys: JSON.parse(sess.preserved_sovereign_keys_json) as string[],
      manifestDigest: sess.manifest_digest,
      expectedManifestJson: sess.expected_manifest_json,
      plcCutoverAt: sess.plc_cutover_at,
      absoluteDeadlineAt: sess.absolute_deadline_at,
      permissions: new EffectiveSessionPermissions(fullPerms, fullPerms),
    };
  }

  async refreshMigrationSession(
    authorizationHeader: string | undefined,
    nowMs = Date.now(),
    idempotencyKey?: string,
  ): Promise<{ accessJwt: string; refreshJwt: string; handle: string; did: string }> {
    if (idempotencyKey !== undefined && !isValidIdempotencyKey(idempotencyKey)) {
      throw new GroupHostHttpError(
        400,
        "InvalidIdempotencyKey",
        "Idempotency-Key must be 1..128 [A-Za-z0-9._:-] characters.",
      );
    }
    const presented = await this.verifyMigrationJwtClaims(authorizationHeader, true, nowMs);
    return this.locks.withGroupRepoLock(presented.sub, async () => {
      const preSess = this.db
        .prepare(
          `SELECT auth_epoch, refresh_jti, prev_refresh_jti, refresh_idempotency_key, refresh_grace_expires_at,
                  plc_cutover_at, plc_submitting_at, pending_plc_op_cid, absolute_deadline_at
           FROM migration_session
           WHERE group_did = ?`,
        )
        .get(presented.sub) as
        | {
            auth_epoch: number;
            refresh_jti: string;
            prev_refresh_jti: string | null;
            refresh_idempotency_key: string | null;
            refresh_grace_expires_at: number | null;
            plc_cutover_at: number | null;
            plc_submitting_at: number | null;
            pending_plc_op_cid: string | null;
            absolute_deadline_at: number;
          }
        | undefined;
      let recState: Awaited<ReturnType<typeof this.reconcileUncutoverSessionLocked>> | null = null;
      if (preSess && preSess.plc_cutover_at === null) {
        const isEligibleIdempotentRetry = Boolean(
          idempotencyKey &&
            preSess.auth_epoch === presented.epoch &&
            preSess.prev_refresh_jti === presented.jti &&
            preSess.refresh_idempotency_key === idempotencyKey &&
            preSess.refresh_grace_expires_at !== null &&
            nowMs < preSess.refresh_grace_expires_at,
        );
        const hasRevokedReplay =
          !isEligibleIdempotentRetry &&
          Boolean(this.db.prepare("SELECT 1 AS ok FROM revoked_migration_jti WHERE jti = ?").get(presented.jti));
        const hasRefreshJtiMismatch =
          !isEligibleIdempotentRetry &&
          preSess.auth_epoch === presented.epoch &&
          preSess.refresh_jti !== presented.jti;
        if (
          hasRevokedReplay ||
          hasRefreshJtiMismatch ||
          preSess.plc_submitting_at !== null ||
          preSess.pending_plc_op_cid !== null ||
          nowMs >= preSess.absolute_deadline_at
        ) {
          recState = await this.reconcileUncutoverSessionLocked(presented.sub, nowMs);
        }
      }

      const nextAccessJti = randomUUID();
      const nextRefreshJti = randomUUID();

      type RefreshTxResult =
        | { outcome: "error"; error: GroupHostHttpError }
        | {
            outcome: "rotated";
            sessionId: string;
            accessJti: string;
            refreshJti: string;
            handle: string;
            authEpoch: number;
            plcCutoverCommitted: boolean;
            absoluteDeadlineAt: number;
          };

      const txResult = this.db
        .transaction((): RefreshTxResult => {
          const sess = this.db
            .prepare(
              `SELECT id, access_jti, refresh_jti, prev_refresh_jti, refresh_idempotency_key, refresh_grace_expires_at,
                      auth_epoch, plc_cutover_at, absolute_deadline_at
               FROM migration_session
               WHERE group_did = ?`,
            )
            .get(presented.sub) as
            | {
                id: string;
                access_jti: string;
                refresh_jti: string;
                prev_refresh_jti: string | null;
                refresh_idempotency_key: string | null;
                refresh_grace_expires_at: number | null;
                auth_epoch: number;
                plc_cutover_at: number | null;
                absolute_deadline_at: number;
              }
            | undefined;

          const matchesIdempotentGrace = Boolean(
            idempotencyKey &&
              sess &&
              sess.id === presented.sid &&
              sess.auth_epoch === presented.epoch &&
              sess.prev_refresh_jti === presented.jti &&
              sess.refresh_idempotency_key === idempotencyKey &&
              sess.refresh_grace_expires_at !== null &&
              nowMs < sess.refresh_grace_expires_at,
          );

          if (matchesIdempotentGrace && sess) {
            if (sess.plc_cutover_at === null && nowMs >= sess.absolute_deadline_at) {
              return {
                outcome: "error",
                error: new GroupHostHttpError(401, "ExpiredToken", "Migration session deadline expired."),
              };
            }
            const acct = this.db
              .prepare("SELECT handle, activated, takendown FROM group_account WHERE did = ?")
              .get(presented.sub) as { handle: string; activated: number; takendown: number } | undefined;
            if (!acct || acct.takendown !== 0) {
              return { outcome: "error", error: new GroupHostHttpError(400, "RepoTakendown") };
            }
            if (acct.activated !== 0) {
              return { outcome: "error", error: new GroupHostHttpError(400, "AlreadyActivated") };
            }
            return {
              outcome: "rotated",
              sessionId: sess.id,
              accessJti: sess.access_jti,
              refreshJti: sess.refresh_jti,
              handle: acct.handle,
              authEpoch: sess.auth_epoch,
              plcCutoverCommitted: sess.plc_cutover_at !== null,
              absoluteDeadlineAt: sess.absolute_deadline_at,
            };
          }

          const revokedJti = this.db
            .prepare("SELECT 1 AS ok FROM revoked_migration_jti WHERE jti = ?")
            .get(presented.jti);
          if (revokedJti) {
            if (recState === "not_cutover") {
              this.purgeUncutoverSessionOnReplaySync(presented.sub, presented.sid, presented.epoch, nowMs);
            }
            return {
              outcome: "error",
              error: new GroupHostHttpError(401, "InvalidToken", "Revoked migration token JTI replayed."),
            };
          }

          if (!sess) {
            return {
              outcome: "error",
              error: new GroupHostHttpError(401, "InvalidToken", "Migration session not found."),
            };
          }
          if (sess.id !== presented.sid || sess.auth_epoch !== presented.epoch) {
            return {
              outcome: "error",
              error: new GroupHostHttpError(401, "InvalidToken", "Migration token JTI or epoch mismatch."),
            };
          }
          if (sess.refresh_jti !== presented.jti) {
            if (recState === "not_cutover") {
              this.purgeUncutoverSessionOnReplaySync(presented.sub, presented.sid, presented.epoch, nowMs);
            }
            return {
              outcome: "error",
              error: new GroupHostHttpError(401, "InvalidToken", "Migration refresh token JTI replay or mismatch."),
            };
          }
          if (sess.plc_cutover_at === null && nowMs >= sess.absolute_deadline_at) {
            return {
              outcome: "error",
              error: new GroupHostHttpError(401, "ExpiredToken", "Migration session deadline expired."),
            };
          }

          const acct = this.db
            .prepare("SELECT handle, activated, takendown FROM group_account WHERE did = ?")
            .get(presented.sub) as { handle: string; activated: number; takendown: number } | undefined;
          if (!acct || acct.takendown !== 0) {
            return { outcome: "error", error: new GroupHostHttpError(400, "RepoTakendown") };
          }
          if (acct.activated !== 0) {
            return { outcome: "error", error: new GroupHostHttpError(400, "AlreadyActivated") };
          }

          const revExp = Math.max(sess.absolute_deadline_at, nowMs + 30 * 86_400_000);
          this.db
            .prepare("INSERT OR REPLACE INTO revoked_migration_jti (jti, group_did, expires_at) VALUES (?, ?, ?)")
            .run(presented.jti, presented.sub, revExp);
          this.db
            .prepare("INSERT OR REPLACE INTO revoked_migration_jti (jti, group_did, expires_at) VALUES (?, ?, ?)")
            .run(sess.access_jti, presented.sub, revExp);

          const graceExp =
            idempotencyKey !== undefined
              ? sess.plc_cutover_at === null
                ? Math.min(sess.absolute_deadline_at, nowMs + 15 * 60_000)
                : nowMs + 15 * 60_000
              : null;
          const upd = this.db
            .prepare(
              `UPDATE migration_session
               SET access_jti = ?, refresh_jti = ?, prev_refresh_jti = ?, refresh_idempotency_key = ?, refresh_grace_expires_at = ?
               WHERE id = ? AND refresh_jti = ?`,
            )
            .run(
              nextAccessJti,
              nextRefreshJti,
              idempotencyKey !== undefined ? presented.jti : null,
              idempotencyKey ?? null,
              graceExp,
              sess.id,
              presented.jti,
            );
          if (upd.changes !== 1) {
            return {
              outcome: "error",
              error: new GroupHostHttpError(401, "InvalidToken", "Concurrent migration token rotation detected."),
            };
          }

          return {
            outcome: "rotated",
            sessionId: sess.id,
            accessJti: nextAccessJti,
            refreshJti: nextRefreshJti,
            handle: acct.handle,
            authEpoch: sess.auth_epoch,
            plcCutoverCommitted: sess.plc_cutover_at !== null,
            absoluteDeadlineAt: sess.absolute_deadline_at,
          };
        })
        .immediate();

      if (txResult.outcome === "error") {
        throw txResult.error;
      }

      const tokens = await this.signMigrationSessionTokens({
        groupDid: presented.sub,
        sessionId: txResult.sessionId,
        accessJti: txResult.accessJti,
        refreshJti: txResult.refreshJti,
        authEpoch: txResult.authEpoch,
        absoluteDeadlineAt: txResult.absoluteDeadlineAt,
        plcCutoverCommitted: txResult.plcCutoverCommitted,
        nowMs,
      });

      return {
        accessJwt: tokens.accessJwt,
        refreshJwt: tokens.refreshJwt,
        handle: txResult.handle,
        did: presented.sub,
      };
    });
  }

  /**
   * `com.atproto.server.createAccount` (3-tier migration target with retry-safe lost-response replay & `A -> B -> A` re-entry).
   */
  async createMigrationAccount(params: {
    authorizationHeader: string | undefined;
    ticketHeader: string | undefined;
    provenanceHeader: string | undefined;
    operationIdHeader?: string;
    did: string;
    handle: string;
    recoveryKey?: string;
    nowMs?: number;
  }): Promise<{ accessJwt: string; refreshJwt: string; handle: string; did: string }> {
    const nowMs = params.nowMs ?? Date.now();
    const nowSec = Math.floor(nowMs / 1000);

    if (!isDid(params.did)) {
      throw new GroupHostHttpError(400, "InvalidRequest", "createAccount on Group Host requires an existing group DID.");
    }
    if (params.operationIdHeader !== undefined && !isValidIdempotencyKey(params.operationIdHeader)) {
      throw new GroupHostHttpError(400, "InvalidRequest", "Malformed X-Group-Migration-Operation-Id header.");
    }
    const normalizedHandle = normalizeAndValidateGroupHandle(params.handle, this.config.handleDomain);
    if (params.recoveryKey !== undefined && !isSupportedPlcRotationDidKey(params.recoveryKey)) {
      throw new GroupHostHttpError(400, "InvalidRequest", "Unsupported recoveryKey format.");
    }

    const rawJwt = extractBearerToken(params.authorizationHeader);
    if (!rawJwt) {
      throw new GroupHostHttpError(401, "AuthMissing", "Service JWT Bearer required for createAccount.");
    }
    const callerJwt = parseServiceJwtParts(rawJwt);
    const callerIat = callerJwt.payload.iat;
    const callerExp = callerJwt.payload.exp;
    if (
      callerJwt.header.typ !== "JWT" ||
      (callerJwt.header.alg !== "ES256" && callerJwt.header.alg !== "ES256K") ||
      callerJwt.payload.iss !== params.did ||
      callerJwt.payload.aud !== this.config.serviceDid ||
      callerJwt.payload.lxm !== "com.atproto.server.createAccount" ||
      typeof callerJwt.payload.jti !== "string" ||
      callerJwt.payload.jti.trim().length === 0 ||
      callerJwt.payload.jti.length > 256 ||
      typeof callerIat !== "number" ||
      !Number.isFinite(callerIat) ||
      callerIat > nowSec + 5 ||
      typeof callerExp !== "number" ||
      !Number.isFinite(callerExp) ||
      callerExp <= nowSec ||
      callerExp - callerIat <= 0 ||
      callerExp - callerIat > 60
    ) {
      throw new GroupHostHttpError(401, "InvalidToken", "Invalid createAccount service JWT claims.");
    }

    return this.locks.withGroupRepoLock(params.did, async () => {
      // Check handle conflicts against OTHER DIDs before consuming JTI!
      const handleRes = this.db
        .prepare("SELECT group_did FROM handle_reservation WHERE handle = ?")
        .get(normalizedHandle) as { group_did: string } | undefined;
      const acctRes = this.db
        .prepare("SELECT did FROM group_account WHERE handle = ?")
        .get(normalizedHandle) as { did: string } | undefined;
      if ((handleRes && handleRes.group_did !== params.did) || (acctRes && acctRes.did !== params.did)) {
        throw new GroupHostHttpError(400, "HandleNotAvailable", `Handle '${normalizedHandle}' is already taken.`);
      }

      const localDel = this.db
        .prepare("SELECT plc_outcome FROM group_deletion_journal WHERE group_did = ?")
        .get(params.did) as { plc_outcome: string | null } | undefined;
      if (localDel && localDel.plc_outcome !== "migrated_remote") {
        throw new GroupHostHttpError(400, "RepoTakendown", "Group was permanently deleted.");
      }

      const doc = await this.plc.resolveDidDocument(params.did);
      const lastOp = await this.plc.getPlcLastOp(params.did);
      if (!doc || !lastOp || lastOp.type === "plc_tombstone") {
        throw new GroupHostHttpError(400, "UnresolvableDid", "Source group DID not found or tombstoned on PLC.");
      }

      const sourceSigningDidKey = this.plc.extractVerificationMethodDidKey(doc, "#atproto");
      if (!sourceSigningDidKey) {
        throw new GroupHostHttpError(400, "SigningKeyNotFound", "Source #atproto verification method missing.");
      }
      const sigOk = await cryptoVerifySignatureWithKey(
        sourceSigningDidKey,
        callerJwt.signingInput,
        callerJwt.sigBytes,
        callerJwt.header.alg,
      ).catch(() => false);
      if (!sigOk) {
        throw new GroupHostHttpError(401, "InvalidSignature", "createAccount service JWT signature invalid.");
      }

      const callerJti = `jwt:${callerJwt.payload.jti!}`;
      const dupCallerJti = this.db
        .prepare("SELECT 1 AS ok FROM service_jwt_jti WHERE issuer_did = ? AND jti = ?")
        .get(params.did, callerJti);
      if (dupCallerJti) {
        throw new GroupHostHttpError(401, "ReplayDetected", "createAccount service JWT jti already consumed.");
      }

      const sourceEndpoint = this.plc.extractPdsEndpoint(doc);
      if (!sourceEndpoint) {
        throw new GroupHostHttpError(400, "InvalidRequest", "Source DID lacks #atproto_pds serviceEndpoint.");
      }
      if (sourceEndpoint === normalizeOriginUrl(this.config.publicUrl)) {
        throw new GroupHostHttpError(400, "AlreadyHostedHere", "Group is already hosted on this Group Host.");
      }
      const sourceLiveRotationKeys = plcOpRotationKeys(lastOp);

      // Check existing unexpired un-cutover `migration_session` for Lost-Response Replay!
      const preExistingSess = this.db
        .prepare(
          "SELECT plc_cutover_at, plc_submitting_at, pending_plc_op_cid, absolute_deadline_at FROM migration_session WHERE group_did = ?",
        )
        .get(params.did) as
        | {
            plc_cutover_at: number | null;
            plc_submitting_at: number | null;
            pending_plc_op_cid: string | null;
            absolute_deadline_at: number;
          }
        | undefined;
      if (
        preExistingSess &&
        preExistingSess.plc_cutover_at === null &&
        (preExistingSess.plc_submitting_at !== null ||
          preExistingSess.pending_plc_op_cid !== null ||
          nowMs >= preExistingSess.absolute_deadline_at)
      ) {
        const recState = await this.reconcileUncutoverSessionLocked(params.did, nowMs);
        if (recState === "cutover_committed" || recState === "pending_admissible") {
          throw new GroupHostHttpError(409, "MigrationInProgress", "Migration cutover already committed or in-flight.");
        }
        if (recState === "retain_fail_safe") {
          throw new GroupHostHttpError(
            502,
            "PlcDirectoryError",
            "Cannot restage migration while prior PLC cutover submission is indeterminate.",
          );
        }
      }

      const existingSess = this.db
        .prepare("SELECT * FROM migration_session WHERE group_did = ?")
        .get(params.did) as
        | {
            id: string;
            mode: "coordinated" | "standard";
            operation_id: string | null;
            ticket_id: string | null;
            ticket_secret_hash: string | null;
            provenance_jti: string | null;
            source_endpoint: string;
            preserved_sovereign_keys_json: string;
            access_jti: string;
            refresh_jti: string;
            auth_epoch: number;
            plc_cutover_at: number | null;
            plc_submitting_at: number | null;
            absolute_deadline_at: number;
          }
        | undefined;
      const existingAcct = this.db
        .prepare("SELECT handle, activated, auth_epoch FROM group_account WHERE did = ?")
        .get(params.did) as { handle: string; activated: number; auth_epoch: number } | undefined;

      const parsedTicket = params.ticketHeader !== undefined ? parseMigrationTicket(params.ticketHeader) : null;
      if (params.ticketHeader !== undefined && !parsedTicket) {
        throw new GroupHostHttpError(400, "InvalidMigrationTicket", "Malformed X-Group-Migration-Ticket header.");
      }

      if (
        existingSess &&
        existingSess.plc_cutover_at === null &&
        nowMs >= existingSess.absolute_deadline_at &&
        existingSess.operation_id !== null
      ) {
        this.db
          .prepare("INSERT OR REPLACE INTO service_jwt_jti (issuer_did, jti, group_did, expires_at) VALUES (?, ?, ?, ?)")
          .run(params.did, `aborted-op:${existingSess.operation_id}`, params.did, nowMs + 2 * HOUR_MS);
      }

      const assertOperationIdNotAbortedSync = (opId: string | null | undefined) => {
        if (!opId) return;
        const abortedOp = this.db
          .prepare("SELECT 1 AS ok FROM service_jwt_jti WHERE issuer_did = ? AND jti = ? AND expires_at > ?")
          .get(params.did, `aborted-op:${opId}`, nowMs);
        if (abortedOp) {
          throw new GroupHostHttpError(
            409,
            "OperationIdAlreadyAborted",
            `Migration operationId '${opId}' was already aborted; start a new operationId.`,
          );
        }
      };

      assertOperationIdNotAbortedSync(params.operationIdHeader);

      // Coordinated lost-response replay check BEFORE pulling single-use Source `migration-manifest`!
      if (existingSess && (existingSess.plc_cutover_at !== null || nowMs < existingSess.absolute_deadline_at)) {
        if (existingSess.plc_cutover_at !== null) {
          throw new GroupHostHttpError(409, "MigrationInProgress", "Migration cutover already committed.");
        }
        if (
          parsedTicket &&
          existingSess.mode === "coordinated" &&
          existingSess.ticket_id === parsedTicket.ticketId &&
          existingSess.ticket_secret_hash &&
          existingAcct?.handle === normalizedHandle
        ) {
          if (params.operationIdHeader !== undefined && params.operationIdHeader !== existingSess.operation_id) {
            throw new GroupHostHttpError(
              400,
              "InvalidRequest",
              "X-Group-Migration-Operation-Id does not match coordinated manifest operationId.",
            );
          }
          assertOperationIdNotAbortedSync(existingSess.operation_id);
          const actualHash = Buffer.from(sha256HexBytes(parsedTicket.secret), "hex");
          const expectedHash = Buffer.from(existingSess.ticket_secret_hash, "hex");
          if (actualHash.byteLength === expectedHash.byteLength && timingSafeEqual(actualHash, expectedHash)) {
            this.db
              .transaction(() => {
                this.db
                  .prepare("INSERT INTO service_jwt_jti (issuer_did, jti, group_did, expires_at) VALUES (?, ?, ?, ?)")
                  .run(params.did, callerJti, params.did, Math.max(callerJwt.payload.exp * 1000, nowMs + 80_000));
              })
              .immediate();

            const tokens = await this.signMigrationSessionTokens({
              groupDid: params.did,
              sessionId: existingSess.id,
              accessJti: existingSess.access_jti,
              refreshJti: existingSess.refresh_jti,
              authEpoch: existingSess.auth_epoch,
              absoluteDeadlineAt: existingSess.absolute_deadline_at,
              plcCutoverCommitted: false,
              nowMs,
            });
            return {
              accessJwt: tokens.accessJwt,
              refreshJwt: tokens.refreshJwt,
              handle: normalizedHandle,
              did: params.did,
            };
          }
        }
      }

      // Evaluate 3-Tier Provenance & Manifest
      let mode: "coordinated" | "standard";
      let operationId: string | null = null;
      let ticketId: string | null = null;
      let ticketSecretHash: string | null = null;
      let provenanceJti: string | null = null;
      let sourceServiceDid: string | null = null;
      let sourceLocalRotationKey: string | null = null;
      let manifestDigest: string | null = null;
      let expectedManifestJson: string | null = null;
      let absoluteDeadlineAt: number;

      if (parsedTicket) {
        // Tier (a): Coordinated Mode
        mode = "coordinated";
        ticketId = parsedTicket.ticketId;
        ticketSecretHash = sha256HexBytes(parsedTicket.secret);

        const abortedTicket = this.db
          .prepare("SELECT 1 AS ok FROM service_jwt_jti WHERE issuer_did = ? AND jti = ? AND expires_at > ?")
          .get(params.did, `ticket:${ticketId}`, nowMs);
        if (abortedTicket) {
          throw new GroupHostHttpError(409, "InvalidMigrationTicket", "Migration ticket was already aborted.");
        }

        const infoRes = await this.infoFetcher(`${sourceEndpoint}/group-admin/migration-info`, {
          method: "GET",
          headers: { accept: "application/json" },
        });
        if (!infoRes.ok) {
          throw new GroupHostHttpError(502, "SourceHostUnavailable", "Could not fetch source migration-info.");
        }
        const info = await readUpstreamJson<{ did?: string }>(
          infoRes,
          BOUNDED_FETCH_PROFILES.migrationInfo.maxResponseBytes,
        );
        if (!info?.did || !isDid(info.did)) {
          throw new GroupHostHttpError(502, "InvalidSourceMigrationInfo", "Source migration-info missing DID.");
        }
        const srcServiceDoc = await this.plc.resolveDidDocument(info.did);
        if (!srcServiceDoc || this.plc.extractPdsEndpoint(srcServiceDoc) !== sourceEndpoint) {
          throw new GroupHostHttpError(400, "InvalidSourceMigrationInfo", "Source service DID #atproto_pds mismatch.");
        }
        sourceServiceDid = info.did;

        const targetJwt = await createServiceJwt({
          iss: this.config.serviceDid,
          aud: sourceServiceDid,
          iat: nowSec,
          exp: nowSec + 60,
          lxm: "com.atproto.server.createAccount",
          keypair: this.serviceKeys.activeKeypair,
        });
        const manUrl = `${sourceEndpoint}/group-admin/migration-manifest?group=${encodeURIComponent(params.did)}&ticketId=${encodeURIComponent(ticketId)}`;
        const manRes = await this.manifestFetcher(manUrl, {
          method: "GET",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${targetJwt}`,
            "x-group-migration-secret": parsedTicket.secret,
          },
        });
        if (!manRes.ok) {
          throw new GroupHostHttpError(409, "InvalidMigrationTicket", `Source rejected migration-manifest pull (${manRes.status}).`);
        }
        const manBody = await readUpstreamJson<{
          groupDid?: string;
          operationId?: string;
          ticketId?: string;
          deadlineAtMs?: number;
          sourceServiceDid?: string;
          sourceLocalRotationKey?: string;
          targetEndpoint?: string;
          targetServiceDid?: string;
          manifestDigest?: string;
          manifestJson?: string;
        }>(manRes, this.config.maxManifestBytes);

        let normalizedManifestTargetOrigin: string | null = null;
        if (typeof manBody?.targetEndpoint === "string") {
          try {
            normalizedManifestTargetOrigin = normalizeOriginUrl(manBody.targetEndpoint);
          } catch {
            normalizedManifestTargetOrigin = null;
          }
        }

        if (
          !manBody ||
          manBody.groupDid !== params.did ||
          manBody.ticketId !== ticketId ||
          manBody.sourceServiceDid !== sourceServiceDid ||
          manBody.targetServiceDid !== this.config.serviceDid ||
          normalizedManifestTargetOrigin !== normalizeOriginUrl(this.config.publicUrl) ||
          typeof manBody.operationId !== "string" ||
          !isValidIdempotencyKey(manBody.operationId) ||
          typeof manBody.deadlineAtMs !== "number" ||
          !Number.isFinite(manBody.deadlineAtMs) ||
          manBody.deadlineAtMs <= nowMs ||
          manBody.deadlineAtMs > nowMs + 2 * HOUR_MS + 60_000 ||
          typeof manBody.manifestDigest !== "string" ||
          typeof manBody.manifestJson !== "string" ||
          !verifyMigrationManifestDigest(manBody.manifestJson, manBody.manifestDigest)
        ) {
          throw new GroupHostHttpError(400, "InvalidMigrationManifest", "Source migration-manifest failed verification.");
        }

        if (
          !isSupportedPlcRotationDidKey(manBody.sourceLocalRotationKey) ||
          !sourceLiveRotationKeys.includes(manBody.sourceLocalRotationKey)
        ) {
          throw new GroupHostHttpError(
            400,
            "InvalidSourceKeyProof",
            "Coordinated migration-manifest sourceLocalRotationKey is invalid or absent from live PLC rotationKeys.",
          );
        }

        type InnerManifestHeader = {
          version?: unknown;
          groupDid?: unknown;
          operationId?: unknown;
          deadlineAtMs?: unknown;
          sourceLocalRotationKey?: unknown;
        };
        let parsedInnerManifest: InnerManifestHeader | null;
        try {
          parsedInnerManifest = JSON.parse(manBody.manifestJson) as InnerManifestHeader;
        } catch {
          parsedInnerManifest = null;
        }
        if (
          !parsedInnerManifest ||
          parsedInnerManifest.version !== 1 ||
          parsedInnerManifest.groupDid !== params.did ||
          parsedInnerManifest.operationId !== manBody.operationId ||
          parsedInnerManifest.deadlineAtMs !== manBody.deadlineAtMs ||
          parsedInnerManifest.sourceLocalRotationKey !== manBody.sourceLocalRotationKey
        ) {
          throw new GroupHostHttpError(
            400,
            "InvalidMigrationManifest",
            "Canonical migration-manifest inner fields do not match envelope.",
          );
        }

        if (params.operationIdHeader !== undefined && params.operationIdHeader !== manBody.operationId) {
          throw new GroupHostHttpError(
            400,
            "InvalidRequest",
            "X-Group-Migration-Operation-Id does not match coordinated manifest operationId.",
          );
        }

        operationId = manBody.operationId;
        absoluteDeadlineAt = manBody.deadlineAtMs;
        sourceLocalRotationKey = manBody.sourceLocalRotationKey;
        manifestDigest = manBody.manifestDigest;
        expectedManifestJson = manBody.manifestJson;
      } else if (params.provenanceHeader !== undefined) {
        // Tier (c): Provenance-Assisted Multi-Key Extension (`X-Group-Migration-Key-Provenance`)
        mode = "standard";
        operationId = params.operationIdHeader ?? null;
        absoluteDeadlineAt = nowMs + 2 * HOUR_MS;
        if (Buffer.byteLength(params.provenanceHeader, "utf8") > 4096) {
          throw new GroupHostHttpError(400, "InvalidSourceKeyProof", "Provenance JWS exceeds 4 KiB.");
        }
        let provParts: ReturnType<typeof parseServiceJwtParts>;
        let rawClaims: {
          iss?: string;
          sub?: string;
          aud?: string;
          act?: string;
          jti?: string;
          iat?: number;
          exp?: number;
          sourceLocalRotationKey?: string | null;
        };
        try {
          provParts = parseServiceJwtParts(params.provenanceHeader);
          rawClaims = JSON.parse(
            Buffer.from(params.provenanceHeader.split(".")[1]!, "base64url").toString("utf8"),
          ) as typeof rawClaims;
        } catch {
          throw new GroupHostHttpError(400, "InvalidSourceKeyProof", "Malformed X-Group-Migration-Key-Provenance JWS.");
        }
        const kSov = provParts.header.kid;

        if (
          provParts.header.typ !== "JWT" ||
          !kSov ||
          !isSupportedPlcRotationDidKey(kSov) ||
          !sourceLiveRotationKeys.includes(kSov) ||
          rawClaims.iss !== kSov ||
          rawClaims.sub !== params.did ||
          rawClaims.aud !== this.config.serviceDid ||
          rawClaims.act !== "migration_key_provenance" ||
          typeof rawClaims.jti !== "string" ||
          rawClaims.jti.trim().length === 0 ||
          typeof rawClaims.iat !== "number" ||
          !Number.isFinite(rawClaims.iat) ||
          rawClaims.iat > nowSec + 5 ||
          typeof rawClaims.exp !== "number" ||
          !Number.isFinite(rawClaims.exp) ||
          rawClaims.exp <= nowSec ||
          rawClaims.exp - rawClaims.iat <= 0 ||
          rawClaims.exp - rawClaims.iat > 120 ||
          !(
            rawClaims.sourceLocalRotationKey === null ||
            (isSupportedPlcRotationDidKey(rawClaims.sourceLocalRotationKey) &&
              sourceLiveRotationKeys.includes(rawClaims.sourceLocalRotationKey) &&
              rawClaims.sourceLocalRotationKey !== kSov)
          )
        ) {
          throw new GroupHostHttpError(400, "InvalidSourceKeyProof", "Invalid X-Group-Migration-Key-Provenance claims.");
        }

        const provSigOk = await cryptoVerifySignatureWithKey(
          kSov,
          provParts.signingInput,
          provParts.sigBytes,
          provParts.header.alg,
        ).catch(() => false);
        if (!provSigOk) {
          throw new GroupHostHttpError(400, "InvalidSourceKeyProof", "Invalid X-Group-Migration-Key-Provenance signature.");
        }

        provenanceJti = rawClaims.jti;
        sourceLocalRotationKey = rawClaims.sourceLocalRotationKey;
      } else {
        // Tier (b): Standard ATProto Migration (zero client extensions)
        mode = "standard";
        operationId = params.operationIdHeader ?? null;
        absoluteDeadlineAt = nowMs + 2 * HOUR_MS;

        let negotiatedResolved = false;
        const pkUrl =
          `${sourceEndpoint}/group-admin/public-group-keys?group=${encodeURIComponent(params.did)}` +
          (operationId ? `&operationId=${encodeURIComponent(operationId)}` : "");
        let pkRes: Response;
        try {
          pkRes = await this.infoFetcher(pkUrl, {
            method: "GET",
            headers: { accept: "application/json" },
          });
        } catch {
          throw new GroupHostHttpError(
            502,
            "SourceHostUnavailable",
            "Could not reach source host /group-admin/public-group-keys.",
          );
        }

        if (pkRes.status === 409) {
          const conflictBody = await readUpstreamJson<{ error?: string; message?: string }>(pkRes, 65_536).catch(
            () => null,
          );
          if (conflictBody?.error === "OperationIdAlreadyAborted") {
            throw new GroupHostHttpError(
              409,
              "OperationIdAlreadyAborted",
              conflictBody.message ?? `Migration operationId '${operationId}' was already aborted on source.`,
            );
          }
          if (conflictBody?.error === "MigrationInProgress") {
            throw new GroupHostHttpError(
              409,
              "MigrationInProgress",
              conflictBody.message ?? "Source host already has an active migration lease for a different operationId.",
            );
          }
          throw new GroupHostHttpError(
            502,
            "SourceHostUnavailable",
            `Source /group-admin/public-group-keys returned unexpected 409.`,
          );
        }

        if (pkRes.status === 200) {
          let pkBody: {
            groupDid?: string;
            localRotationKey?: string;
            proofJwt?: string;
            leaseAttemptId?: unknown;
          } | null = null;
          try {
            pkBody = await readUpstreamJson<{
              groupDid?: string;
              localRotationKey?: string;
              proofJwt?: string;
              leaseAttemptId?: unknown;
            }>(pkRes, 65_536);
          } catch {
            throw new GroupHostHttpError(400, "InvalidSourceKeyProof", "Malformed public-group-keys response.");
          }
          if (
            !pkBody ||
            pkBody.groupDid !== params.did ||
            typeof pkBody.localRotationKey !== "string" ||
            typeof pkBody.proofJwt !== "string" ||
            (pkBody.leaseAttemptId !== undefined &&
              (typeof pkBody.leaseAttemptId !== "string" || pkBody.leaseAttemptId.trim().length === 0))
          ) {
            throw new GroupHostHttpError(400, "InvalidSourceKeyProof", "Malformed public-group-keys response.");
          }
          const jwtSegs = pkBody.proofJwt.split(".");
          if (jwtSegs.length !== 3 || !jwtSegs[0] || !jwtSegs[1] || !jwtSegs[2]) {
            throw new GroupHostHttpError(400, "InvalidSourceKeyProof", "Malformed public-group-keys proofJwt.");
          }
          let proofHeader: { typ?: unknown; alg?: unknown; kid?: unknown };
          let proofClaims: {
            iss?: unknown;
            iat?: unknown;
            exp?: unknown;
            groupDid?: unknown;
            localRotationKey?: unknown;
            leaseAttemptId?: unknown;
          };
          try {
            const rawHdr = JSON.parse(Buffer.from(jwtSegs[0], "base64url").toString("utf8")) as unknown;
            const rawPl = JSON.parse(Buffer.from(jwtSegs[1], "base64url").toString("utf8")) as unknown;
            if (
              !rawHdr ||
              typeof rawHdr !== "object" ||
              Array.isArray(rawHdr) ||
              !rawPl ||
              typeof rawPl !== "object" ||
              Array.isArray(rawPl)
            ) {
              throw new Error("invalid JWT object");
            }
            proofHeader = rawHdr as typeof proofHeader;
            proofClaims = rawPl as typeof proofClaims;
          } catch {
            throw new GroupHostHttpError(400, "InvalidSourceKeyProof", "Malformed public-group-keys proofJwt JSON.");
          }
          if (
            proofHeader.typ !== "JWT" ||
            (proofHeader.alg !== "ES256" && proofHeader.alg !== "ES256K") ||
            (proofHeader.kid !== undefined &&
              proofHeader.kid !== "#atproto" &&
              proofHeader.kid !== `${params.did}#atproto`)
          ) {
            throw new GroupHostHttpError(400, "InvalidSourceKeyProof", "Invalid proofJwt protected header.");
          }
          if (
            proofClaims.iss !== params.did ||
            proofClaims.groupDid !== params.did ||
            typeof proofClaims.iat !== "number" ||
            !Number.isFinite(proofClaims.iat) ||
            proofClaims.iat > nowSec + 5 ||
            typeof proofClaims.exp !== "number" ||
            !Number.isFinite(proofClaims.exp) ||
            proofClaims.exp <= nowSec ||
            proofClaims.exp - proofClaims.iat <= 0 ||
            proofClaims.exp - proofClaims.iat > 300 ||
            proofClaims.localRotationKey !== pkBody.localRotationKey ||
            proofClaims.leaseAttemptId !== pkBody.leaseAttemptId ||
            !isSupportedPlcRotationDidKey(proofClaims.localRotationKey) ||
            !sourceLiveRotationKeys.includes(proofClaims.localRotationKey)
          ) {
            throw new GroupHostHttpError(400, "InvalidSourceKeyProof", "Invalid public-group-keys proofJwt claims.");
          }
          const proofSigOk = await cryptoVerifySignatureWithKey(
            sourceSigningDidKey,
            Buffer.from(`${jwtSegs[0]}.${jwtSegs[1]}`, "utf8"),
            Buffer.from(jwtSegs[2], "base64url"),
            proofHeader.alg,
          ).catch(() => false);
          if (!proofSigOk) {
            throw new GroupHostHttpError(400, "InvalidSourceKeyProof", "Invalid public-group-keys proofJwt signature.");
          }
          sourceLocalRotationKey = proofClaims.localRotationKey;
          ticketId = typeof pkBody.leaseAttemptId === "string" ? pkBody.leaseAttemptId : null;
          negotiatedResolved = true;
        } else if (pkRes.status !== 404 && pkRes.status !== 501) {
          throw new GroupHostHttpError(
            502,
            "SourceHostUnavailable",
            `Source /group-admin/public-group-keys failed (${pkRes.status}).`,
          );
        }

        if (!negotiatedResolved) {
          if (sourceLiveRotationKeys.length === 1) {
            const soleKey = sourceLiveRotationKeys[0]!;
            if (params.recoveryKey === soleKey) {
              sourceLocalRotationKey = null;
            } else {
              sourceLocalRotationKey = soleKey;
            }
          } else {
            throw new GroupHostHttpError(
              400,
              "ProvenanceRequired",
              "Multi-key source host lacks /group-admin/public-group-keys; supply X-Group-Migration-Key-Provenance signed by a sovereign PLC rotation key.",
            );
          }
        }
      }

      const assertLeaseAttemptNotAbortedSync = (attemptId: string | null | undefined) => {
        if (!attemptId) return;
        const abortedAttempt = this.db
          .prepare("SELECT 1 AS ok FROM service_jwt_jti WHERE issuer_did = ? AND jti = ? AND expires_at > ?")
          .get(params.did, `lease-attempt:${attemptId}`, nowMs);
        if (abortedAttempt) {
          throw new GroupHostHttpError(
            409,
            "OperationIdAlreadyAborted",
            "Migration lease attempt was already aborted.",
          );
        }
      };

      assertOperationIdNotAbortedSync(operationId);
      if (mode === "standard") {
        assertLeaseAttemptNotAbortedSync(ticketId);
      }

      if (sourceLocalRotationKey !== null && params.recoveryKey === sourceLocalRotationKey) {
        throw new GroupHostHttpError(
          400,
          "SourceRotationKeyRetained",
          "recoveryKey cannot retain the retiring source host's rotation key.",
        );
      }

      const targetSigningKey = await P256Keypair.create({ exportable: true });
      const targetKemKey = await P256Keypair.create({ exportable: true });
      const targetLocalRotationKey = await P256Keypair.create({ exportable: true });

      const preservedSovereignKeys = [
        ...new Set([
          ...sourceLiveRotationKeys.filter(
            (k) => k !== sourceLocalRotationKey && k !== targetLocalRotationKey.did(),
          ),
          ...(params.recoveryKey &&
          params.recoveryKey !== targetLocalRotationKey.did() &&
          params.recoveryKey !== sourceLocalRotationKey
            ? [params.recoveryKey]
            : []),
        ]),
      ];

      if (1 + preservedSovereignKeys.length > 5) {
        throw new GroupHostHttpError(
          400,
          "TooManyRotationKeys",
          "Target rotation key plus preserved sovereign rotation keys would exceed PLC's 5-key limit.",
        );
      }

      // Check Standard-mode Lost-Response Replay!
      if (existingSess && nowMs < existingSess.absolute_deadline_at) {
        const operationIdMatchesForReplay =
          existingSess.operation_id !== null
            ? operationId === existingSess.operation_id
            : operationId === null;
        if (
          mode === "standard" &&
          existingSess.mode === "standard" &&
          operationIdMatchesForReplay &&
          existingSess.ticket_id === ticketId &&
          existingAcct?.handle === normalizedHandle &&
          existingSess.source_endpoint === sourceEndpoint &&
          existingSess.preserved_sovereign_keys_json === JSON.stringify(preservedSovereignKeys)
        ) {
          if (provenanceJti !== null && provenanceJti !== existingSess.provenance_jti) {
            const usedProv = this.db
              .prepare("SELECT 1 AS ok FROM revoked_migration_jti WHERE jti = ?")
              .get(`prov:${provenanceJti}`);
            if (usedProv) {
              throw new GroupHostHttpError(401, "ReplayDetected", "Provenance JTI already consumed.");
            }
          }
          this.db
            .transaction(() => {
              this.db
                .prepare("INSERT INTO service_jwt_jti (issuer_did, jti, group_did, expires_at) VALUES (?, ?, ?, ?)")
                .run(params.did, callerJti, params.did, Math.max(callerJwt.payload.exp * 1000, nowMs + 80_000));
              if (provenanceJti !== null && provenanceJti !== existingSess.provenance_jti) {
                this.db
                  .prepare("INSERT INTO revoked_migration_jti (jti, group_did, expires_at) VALUES (?, ?, ?)")
                  .run(`prov:${provenanceJti}`, params.did, absoluteDeadlineAt);
              }
            })
            .immediate();

          const tokens = await this.signMigrationSessionTokens({
            groupDid: params.did,
            sessionId: existingSess.id,
            accessJti: existingSess.access_jti,
            refreshJti: existingSess.refresh_jti,
            authEpoch: existingSess.auth_epoch,
            absoluteDeadlineAt: existingSess.absolute_deadline_at,
            plcCutoverCommitted: false,
            nowMs,
          });
          return {
            accessJwt: tokens.accessJwt,
            refreshJwt: tokens.refreshJwt,
            handle: normalizedHandle,
            did: params.did,
          };
        }

        throw new GroupHostHttpError(
          409,
          "MigrationInProgress",
          "An active migration staging session with different parameters already exists.",
        );
      }

      if (provenanceJti !== null) {
        const usedProv = this.db
          .prepare("SELECT 1 AS ok FROM revoked_migration_jti WHERE jti = ?")
          .get(`prov:${provenanceJti}`);
        if (usedProv) {
          throw new GroupHostHttpError(401, "ReplayDetected", "Provenance JTI already consumed.");
        }
      }

      // Precompute empty signed MST commit + encrypted key columns outside synchronous transaction
      const tempStorage = new SqlStagingRepoStorage(this.db, params.did);
      tempStorage.stagedBlocks.clear();
      const emptyCommit = await Repo.formatInitCommit(tempStorage, params.did, targetSigningKey, []);
      const sigEnc = await this.cryptoBox.encryptKeypair("group_account", params.did, "signing_key_enc", targetSigningKey);
      const kemEnc = await this.cryptoBox.encryptKeypair("group_account", params.did, "kem_key_enc", targetKemKey);
      const rotEnc = await this.cryptoBox.encryptKeypair(
        "group_account",
        params.did,
        "rotation_key_enc",
        targetLocalRotationKey,
      );

      const sessionId = randomUUID();
      const accessJti = randomUUID();
      const refreshJti = randomUUID();

      // Single Atomic First-Time / Expired-Staging / `A -> B -> A` Re-Entry Staging Transaction!
      const nextAuthEpoch = this.db
        .transaction(() => {
          const hCheck = this.db
            .prepare("SELECT group_did FROM handle_reservation WHERE handle = ?")
            .get(normalizedHandle) as { group_did: string } | undefined;
          const aCheck = this.db
            .prepare("SELECT did FROM group_account WHERE handle = ?")
            .get(normalizedHandle) as { did: string } | undefined;
          if ((hCheck && hCheck.group_did !== params.did) || (aCheck && aCheck.did !== params.did)) {
            throw new GroupHostHttpError(400, "HandleNotAvailable", `Handle '${normalizedHandle}' is already taken.`);
          }

          const priorEpochRow = this.db
            .prepare("SELECT auth_epoch FROM group_account WHERE did = ?")
            .get(params.did) as { auth_epoch: number } | undefined;
          const epoch = (priorEpochRow?.auth_epoch ?? 0) + 1;

          assertOperationIdNotAbortedSync(operationId);
          if (mode === "standard") {
            assertLeaseAttemptNotAbortedSync(ticketId);
          }

          // Purge all 39 GROUP_PURGED_TABLES (preserving unexpired service_jwt_jti tombstones/JTIs) + any `migrated_remote` deletion journal row!
          purgeMigrationStagingDataSync(this.db, params.did, nowMs);
          this.db
            .prepare("DELETE FROM group_deletion_journal WHERE group_did = ? AND plc_outcome = 'migrated_remote'")
            .run(params.did);

          this.db
            .prepare(
              `INSERT INTO group_account (
                 did, handle, signing_key_enc, kem_key_enc, rotation_key_enc,
                 activated, takendown, deactivated_at, auth_epoch, created_at
               ) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
            )
            .run(params.did, normalizedHandle, sigEnc, kemEnc, rotEnc, nowMs, epoch, nowMs);

          this.db
            .prepare("INSERT INTO handle_reservation (handle, group_did, created_at) VALUES (?, ?, ?)")
            .run(normalizedHandle, params.did, nowMs);

          const insBlock = this.db.prepare(
            "INSERT INTO public_repo_block (group_did, cid, bytes, rev) VALUES (?, ?, ?, ?)",
          );
          for (const b of emptyCommit.newBlocks) {
            insBlock.run(params.did, b.cid.toString(), Buffer.from(b.bytes), emptyCommit.rev);
          }
          this.db
            .prepare("INSERT INTO public_repo_root (group_did, commit_cid, rev, updated_at) VALUES (?, ?, ?, ?)")
            .run(params.did, emptyCommit.cid.toString(), emptyCommit.rev, nowMs);

          this.db
            .prepare("INSERT INTO service_jwt_jti (issuer_did, jti, group_did, expires_at) VALUES (?, ?, ?, ?)")
            .run(params.did, callerJti, params.did, Math.max(callerJwt.payload.exp * 1000, nowMs + 80_000));

          if (mode === "coordinated" && ticketId) {
            this.db
              .prepare("INSERT OR REPLACE INTO service_jwt_jti (issuer_did, jti, group_did, expires_at) VALUES (?, ?, ?, ?)")
              .run(params.did, `ticket:${ticketId}`, params.did, absoluteDeadlineAt);
          }
          if (provenanceJti) {
            this.db
              .prepare("INSERT OR REPLACE INTO revoked_migration_jti (jti, group_did, expires_at) VALUES (?, ?, ?)")
              .run(`prov:${provenanceJti}`, params.did, absoluteDeadlineAt);
          }

          this.db
            .prepare(
              `INSERT INTO migration_session (
                 id, group_did, mode, operation_id, ticket_id, ticket_secret_hash, provenance_jti,
                 source_endpoint, source_service_did, source_local_rotation_key,
                 source_plc_rotation_keys_json, preserved_sovereign_keys_json,
                 manifest_digest, expected_manifest_json,
                 access_jti, refresh_jti, auth_epoch, plc_cutover_at, absolute_deadline_at, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
            )
            .run(
              sessionId,
              params.did,
              mode,
              operationId,
              ticketId,
              ticketSecretHash,
              provenanceJti,
              sourceEndpoint,
              sourceServiceDid,
              sourceLocalRotationKey,
              JSON.stringify(sourceLiveRotationKeys),
              JSON.stringify(preservedSovereignKeys),
              manifestDigest,
              expectedManifestJson,
              accessJti,
              refreshJti,
              epoch,
              absoluteDeadlineAt,
              nowMs,
            );

          return epoch;
        })
        .immediate();

      const tokens = await this.signMigrationSessionTokens({
        groupDid: params.did,
        sessionId,
        accessJti,
        refreshJti,
        authEpoch: nextAuthEpoch,
        absoluteDeadlineAt,
        plcCutoverCommitted: false,
        nowMs,
      });

      return {
        accessJwt: tokens.accessJwt,
        refreshJwt: tokens.refreshJwt,
        handle: normalizedHandle,
        did: params.did,
      };
    });
  }

  // =========================================================================
  // Staged OpenSocial Integrity Validation (`submitPlcOperation` & `activateAccount`)
  // =========================================================================

  private validateStagedOpenSocialIntegritySync(params: {
    groupDid: string;
    rotationKeysAfterCutover: readonly string[];
    localRotationDidKey: string;
    sourceLocalRotationKey: string | null;
    recoveryRow: RecoveryAdminRow | undefined;
  }): void {
    const metaSpace = groupMetaUri(params.groupDid);
    const membersSpace = groupMembersUri(params.groupDid);

    const spaceRows = this.db
      .prepare(
        "SELECT space_uri, space_type, skey, policy_json FROM group_space WHERE group_did = ? AND deleted_at IS NULL",
      )
      .all(params.groupDid) as Array<{ space_uri: string; space_type: string; skey: string; policy_json: string }>;

    const spaceMap = new Map(spaceRows.map((r) => [r.space_uri, r]));
    if (!spaceMap.has(metaSpace) || !spaceMap.has(membersSpace)) {
      throw new GroupHostHttpError(
        400,
        "MigrationStagingIncomplete",
        "Core OpenSocial spaces meta/self and members/self must be staged.",
      );
    }

    for (const sp of spaceRows) {
      const keyCheck = validateSpaceTypeKey(sp.space_type, sp.skey, { isGroupHostOwnSpace: true });
      if (!keyCheck.valid) {
        throw new GroupHostHttpError(400, keyCheck.code ?? "InvalidSpaceKey", keyCheck.reason);
      }
      const stagedMetaPolicy = JSON.parse(sp.policy_json) as GroupAtgrpPolicy;
      const polCheck = validateSpacePolicy(stagedMetaPolicy, {
        groupDid: params.groupDid,
        spaceType: sp.space_type,
        skey: sp.skey,
        importMode: true,
      });
      if (!polCheck.valid) {
        throw new GroupHostHttpError(400, polCheck.code ?? "InvalidSpacePolicy", polCheck.reason);
      }

      const policyRows = this.db
        .prepare("SELECT rkey, value FROM space_record WHERE space_uri = ? AND repo_did = ? AND collection = ?")
        .all(sp.space_uri, params.groupDid, ATPROTO_SPACE_COLLECTION.spacePolicy) as Array<{
        rkey: string;
        value: string;
      }>;
      const selfPolicyRow = policyRows.find((r) => r.rkey === SELF_SKEY);
      if (!selfPolicyRow) {
        throw new GroupHostHttpError(
          400,
          "MissingSpacePolicyRecord",
          `Missing published com.atproto.space.policy/self in ${sp.space_uri}.`,
        );
      }
      if (policyRows.length !== 1) {
        throw new GroupHostHttpError(
          400,
          "InvalidSpacePolicy",
          `Space ${sp.space_uri} must contain only com.atproto.space.policy/self.`,
        );
      }
      let publishedRec: Record<string, unknown>;
      try {
        publishedRec = JSON.parse(selfPolicyRow.value) as Record<string, unknown>;
      } catch {
        throw new GroupHostHttpError(
          400,
          "InvalidSpacePolicy",
          `Malformed com.atproto.space.policy/self JSON in ${sp.space_uri}.`,
        );
      }
      if (publishedRec.$type !== ATPROTO_SPACE_COLLECTION.spacePolicy) {
        throw new GroupHostHttpError(
          400,
          "InvalidSpacePolicy",
          `Published com.atproto.space.policy/self in ${sp.space_uri} must declare $type com.atproto.space.policy.`,
        );
      }
      const recCheck = validateSpaceRecord(ATPROTO_SPACE_COLLECTION.spacePolicy, publishedRec, {
        authorityDid: params.groupDid,
        spaceUri: sp.space_uri,
        repoDid: params.groupDid,
        rkey: SELF_SKEY,
        importMode: true,
      });
      if (!recCheck.valid) {
        throw new GroupHostHttpError(400, recCheck.code ?? "InvalidSpacePolicy", recCheck.reason);
      }
      const pubPolCheck = validateSpacePolicy(publishedRec.policy, {
        groupDid: params.groupDid,
        spaceType: sp.space_type,
        skey: sp.skey,
        importMode: true,
      });
      if (!pubPolCheck.valid) {
        throw new GroupHostHttpError(400, pubPolCheck.code ?? "InvalidSpacePolicy", pubPolCheck.reason);
      }
      if (
        canonicalAtgrpPolicyKey(stagedMetaPolicy) !==
        canonicalAtgrpPolicyKey(publishedRec.policy as GroupAtgrpPolicy)
      ) {
        throw new GroupHostHttpError(
          400,
          "SpacePolicyMismatch",
          `Published com.atproto.space.policy/self in ${sp.space_uri} diverges from staged space metadata policy.`,
        );
      }
    }

    const repoSpaces = this.db
      .prepare("SELECT space_uri FROM space_repo WHERE repo_did = ?")
      .all(params.groupDid) as Array<{ space_uri: string }>;
    for (const r of repoSpaces) {
      const parsed = parseSpaceUri(r.space_uri);
      if (!parsed) throw new GroupHostHttpError(400, "InvalidSpaceKey", `Invalid space URI: ${r.space_uri}`);
      const keyCheck = validateSpaceTypeKey(parsed.type, parsed.skey, {
        isGroupHostOwnSpace: parsed.authorityDid === params.groupDid,
      });
      if (!keyCheck.valid) {
        throw new GroupHostHttpError(400, keyCheck.code ?? "InvalidSpaceKey", keyCheck.reason);
      }
    }

    // Verify BOTH `org.atgrp.about/self` AND `org.atgrp.config/self` in `meta/self` via registry
    const aboutRow = this.db
      .prepare("SELECT value FROM space_record WHERE space_uri = ? AND repo_did = ? AND collection = ? AND rkey = 'self'")
      .get(metaSpace, params.groupDid, ATGRP_COLLECTION.about) as { value: string } | undefined;
    if (!aboutRow) {
      throw new GroupHostHttpError(400, "MissingGroupAbout", "org.atgrp.about/self is required in meta/self.");
    }
    const aboutCheck = validateSpaceRecord(ATGRP_COLLECTION.about, JSON.parse(aboutRow.value), {
      authorityDid: params.groupDid,
      spaceUri: metaSpace,
      repoDid: params.groupDid,
      rkey: SELF_SKEY,
      importMode: true,
    });
    if (!aboutCheck.valid) {
      throw new GroupHostHttpError(400, aboutCheck.code ?? "InvalidRequest", aboutCheck.reason);
    }

    const configRow = this.db
      .prepare("SELECT value FROM space_record WHERE space_uri = ? AND repo_did = ? AND collection = ? AND rkey = 'self'")
      .get(metaSpace, params.groupDid, ATGRP_COLLECTION.config) as { value: string } | undefined;
    if (!configRow) {
      throw new GroupHostHttpError(400, "MissingGroupConfig", "org.atgrp.config/self is required in meta/self.");
    }
    const configCheck = validateSpaceRecord(ATGRP_COLLECTION.config, JSON.parse(configRow.value), {
      authorityDid: params.groupDid,
      spaceUri: metaSpace,
      repoDid: params.groupDid,
      rkey: SELF_SKEY,
      importMode: true,
    });
    if (!configCheck.valid) {
      throw new GroupHostHttpError(400, configCheck.code ?? "InvalidRequest", configCheck.reason);
    }

    // Optional `org.atgrp.declaration/self` in `public_record` (must validate if present, never required when absent!)
    const declRows = this.db
      .prepare("SELECT rkey, value FROM public_record WHERE group_did = ? AND collection = ?")
      .all(params.groupDid, REPO_COLLECTION.groupDeclaration) as Array<{ rkey: string; value: string }>;
    for (const d of declRows) {
      const check = validatePublicRecord(REPO_COLLECTION.groupDeclaration, JSON.parse(d.value), {
        repoDid: params.groupDid,
        rkey: d.rkey,
        validate: true,
      });
      if (!check.valid) {
        throw new GroupHostHttpError(400, check.code ?? "InvalidRequest", check.reason);
      }
    }

    // Verify all referenced blobs exist in `blob_store`
    const missing = this.repoStore.listMissingBlobs(params.groupDid, 1);
    if (missing.blobs.length > 0) {
      throw new GroupHostHttpError(400, "MissingBlobs", `Missing blob ${missing.blobs[0]!.cid} referenced by ${missing.blobs[0]!.recordUri}.`);
    }

    // Verify exact `org.atgrp.space` index parity in `members/self`!
    const indexedRows = this.db
      .prepare("SELECT rkey, value FROM space_record WHERE space_uri = ? AND repo_did = ? AND collection = ?")
      .all(membersSpace, params.groupDid, ATGRP_COLLECTION.space) as Array<{ rkey: string; value: string }>;
    const indexedSpaceUris = new Set<string>();
    for (const r of indexedRows) {
      const spVal = JSON.parse(r.value) as { space?: string };
      if (!spVal.space || indexedSpaceUris.has(spVal.space)) {
        throw new GroupHostHttpError(400, "InvalidSpaceIndex", "Duplicate or malformed org.atgrp.space index entry.");
      }
      indexedSpaceUris.add(spVal.space);
    }
    for (const sp of spaceRows) {
      const isCore = sp.space_type === ATGRP_SPACE_TYPE.meta || sp.space_type === ATGRP_SPACE_TYPE.members;
      if (isCore) continue;
      const pol = JSON.parse(sp.policy_json) as { unlisted?: boolean };
      const shouldBeIndexed = pol.unlisted !== true;
      if (shouldBeIndexed !== indexedSpaceUris.has(sp.space_uri)) {
        throw new GroupHostHttpError(
          400,
          "SpaceIndexParityMismatch",
          `org.atgrp.space index parity mismatch for ${sp.space_uri}.`,
        );
      }
      indexedSpaceUris.delete(sp.space_uri);
    }
    if (indexedSpaceUris.size > 0) {
      throw new GroupHostHttpError(400, "SpaceIndexParityMismatch", "Dangling org.atgrp.space index entry.");
    }

    // Verify RBAC / role / membership / Flock-modality invariants!
    const state = loadLiveGovernanceState(this.db, params.groupDid);
    const effState = effectiveStateForSession(
      state,
      params.recoveryRow
        ? { sessionKind: "recovery", authorizingUserDid: params.recoveryRow.recovery_did }
        : null,
      params.recoveryRow,
    );
    const emptyPreState = {
      ...effState,
      allAppInstalls: new Map(),
      activeAppInstalls: new Map(),
    };
    assertPostGovernanceInvariants(emptyPreState, effState, params.groupDid, { importMode: true });

    if (effState.hasFlockWorkspace) {
      if (effState.roles.size < 1) {
        throw new GroupHostHttpError(400, "MissingRoles", "Flock workspace requires at least one role.");
      }
      if (effectiveHumanAdmins(effState, params.groupDid).length < 1) {
        throw new GroupHostHttpError(400, "LastAdmin", "Flock workspace requires at least one effective human admin.");
      }
    }

    // Zero-human custody guarantee!
    if (humanMemberships(state, params.groupDid).size === 0 && !params.recoveryRow) {
      const hasExternalSov = params.rotationKeysAfterCutover.some(
        (k) =>
          k !== params.localRotationDidKey &&
          k !== params.sourceLocalRotationKey &&
          isSupportedPlcRotationDidKey(k),
      );
      if (!hasExternalSov) {
        throw new GroupHostHttpError(
          400,
          "NoSovereignCustodyKey",
          "Zero-human group requires at least one external sovereign PLC rotation key.",
        );
      }
    }
  }

  // =========================================================================
  // `checkAccountStatus`, `activateAccount`, `deactivateAccount`, `getServiceAuth`
  // =========================================================================

  checkAccountStatus(groupDid: string): Record<string, unknown> {
    const acct = this.db
      .prepare("SELECT activated FROM group_account WHERE did = ?")
      .get(groupDid) as { activated: number } | undefined;
    if (!acct) throw new GroupHostHttpError(400, "RepoNotFound");

    const root = this.db
      .prepare("SELECT commit_cid, rev FROM public_repo_root WHERE group_did = ?")
      .get(groupDid) as { commit_cid: string; rev: string } | undefined;
    const blockCnt = (
      this.db.prepare("SELECT COUNT(*) AS cnt FROM public_repo_block WHERE group_did = ?").get(groupDid) as { cnt: number }
    ).cnt;
    const recCnt = (
      this.db.prepare("SELECT COUNT(*) AS cnt FROM public_record WHERE group_did = ?").get(groupDid) as { cnt: number }
    ).cnt;
    const blobCnt = (
      this.db.prepare("SELECT COUNT(*) AS cnt FROM blob_store WHERE group_did = ?").get(groupDid) as { cnt: number }
    ).cnt;
    const missingCnt = this.repoStore.listMissingBlobs(groupDid, 500).blobs.length;

    return {
      activated: acct.activated === 1,
      validDid: true,
      repoCommit: root?.commit_cid ?? "",
      repoRev: root?.rev ?? "",
      repoBlocks: blockCnt,
      indexedRecords: recCnt,
      privateStateValues: 0,
      expectedBlobs: blobCnt + missingCnt,
      importedBlobs: blobCnt,
    };
  }

  async activateAccount(params: {
    auth: AuthenticatedGroupSession | AuthenticatedMigrationSession;
    nowMs?: number;
  }): Promise<void> {
    const nowMs = params.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const groupDid = params.auth.groupDid;
    params.auth.permissions.assertAccount({ attr: "status", action: "manage" });

    return this.locks.withGroupRepoLock(groupDid, async () => {
      const acct = this.db
        .prepare("SELECT handle, activated, takendown FROM group_account WHERE did = ?")
        .get(groupDid) as { handle: string; activated: number; takendown: number } | undefined;
      if (!acct || acct.takendown !== 0) throw new GroupHostHttpError(400, "RepoTakendown");
      if (acct.activated === 1) {
        return;
      }

      const migSess = this.db
        .prepare("SELECT * FROM migration_session WHERE group_did = ?")
        .get(groupDid) as
        | {
            id: string;
            mode: "coordinated" | "standard";
            operation_id: string | null;
            source_endpoint: string;
            source_service_did: string | null;
            source_local_rotation_key: string | null;
            preserved_sovereign_keys_json: string;
            expected_manifest_json: string | null;
            absolute_deadline_at: number;
          }
        | undefined;

      const recRow = this.db
        .prepare("SELECT * FROM group_recovery_admin WHERE group_did = ?")
        .get(groupDid) as RecoveryAdminRow | undefined;

      if (params.auth.kind === "oauth") {
        const liveState = loadLiveGovernanceState(this.db, groupDid);
        const effState = effectiveStateForSession(liveState, params.auth, recRow);
        if (!isAuthorizedLifecycleAdmin(params.auth.authorizingUserDid, effState, groupDid)) {
          throw new GroupHostHttpError(403, "Forbidden", "Caller is not an authorized lifecycle admin.");
        }
      }

      // Verify live PLC DID doc AND `/log/last`!
      const doc = await this.plc.resolveDidDocument(groupDid);
      const lastOp = await this.plc.getPlcLastOp(groupDid);
      if (!doc || !lastOp || lastOp.type === "plc_tombstone") {
        throw new GroupHostHttpError(400, "UnresolvableDid", "Group DID unresolvable on PLC.");
      }

      const localSigning = await this.repoStore.getGroupSigningKey(groupDid);
      const localKem = await this.repoStore.getGroupKemKey(groupDid);
      const localRot = await this.repoStore.getGroupRotationKey(groupDid);
      if (!localRot) {
        throw new GroupHostHttpError(400, "InvalidRequest", "Missing local rotation key.");
      }

      if (this.plc.extractPdsEndpoint(doc) !== normalizeOriginUrl(this.config.publicUrl)) {
        throw new GroupHostHttpError(400, "InvalidPlcState", "PLC #atproto_pds does not point to this Group Host.");
      }
      if (this.plc.extractVerificationMethodDidKey(doc, "#atproto") !== localSigning.did()) {
        throw new GroupHostHttpError(400, "InvalidPlcState", "PLC #atproto key does not match local signing key.");
      }
      if (this.plc.extractKemDidKey(doc) !== localKem.did()) {
        throw new GroupHostHttpError(400, "InvalidPlcState", "PLC #atproto_kem key does not match local KEM key.");
      }
      if (!doc.alsoKnownAs || doc.alsoKnownAs[0] !== `at://${acct.handle}`) {
        throw new GroupHostHttpError(400, "InvalidPlcState", "PLC alsoKnownAs[0] does not match group handle.");
      }
      const cutoverRotKeys = plcOpRotationKeys(lastOp);
      if (cutoverRotKeys.length < 1 || cutoverRotKeys.length > 5) {
        throw new GroupHostHttpError(400, "TooManyRotationKeys", "PLC rotationKeys count out of 1..5 bounds.");
      }
      if (!cutoverRotKeys.includes(localRot.did())) {
        throw new GroupHostHttpError(400, "InvalidPlcState", "PLC rotationKeys missing local host rotation key.");
      }

      if (migSess) {
        if (migSess.source_local_rotation_key !== null && cutoverRotKeys.includes(migSess.source_local_rotation_key)) {
          throw new GroupHostHttpError(
            400,
            "SourceRotationKeyRetained",
            "PLC rotationKeys still retains retiring source host rotation key.",
          );
        }
        const preserved = JSON.parse(migSess.preserved_sovereign_keys_json) as string[];
        for (const sov of preserved) {
          if (!cutoverRotKeys.includes(sov)) {
            throw new GroupHostHttpError(
              400,
              "SovereignRotationKeyDropped",
              `Preserved sovereign rotation key missing from PLC: ${sov}`,
            );
          }
        }

        if (migSess.mode === "coordinated" && migSess.expected_manifest_json && migSess.operation_id && migSess.source_local_rotation_key) {
          const snap = await this.snapshotGroupManifestAndSizes({
            groupDid,
            operationId: migSess.operation_id,
            deadlineAtMs: migSess.absolute_deadline_at,
            sourceLocalRotationKey: migSess.source_local_rotation_key,
          });
          if (snap.manifestJson !== migSess.expected_manifest_json) {
            throw new GroupHostHttpError(409, "MigrationManifestMismatch", "Staged state differs from expected manifest.");
          }
        }
      }

      // Check if source host supports `atomicMigrationVersion: 1` for `finalize-migrated-source`
      let finalizeSourceServiceDid: string | null = migSess?.source_service_did ?? null;
      if (migSess && !finalizeSourceServiceDid) {
        try {
          const srcInfoRes = await this.infoFetcher(`${migSess.source_endpoint}/group-admin/migration-info`, {
            method: "GET",
            headers: { accept: "application/json" },
          });
          if (srcInfoRes.ok) {
            const srcInfo = await readUpstreamJson<{ did?: string; atomicMigrationVersion?: number }>(srcInfoRes, 65_536);
            if (srcInfo?.atomicMigrationVersion === 1 && srcInfo.did && isDid(srcInfo.did)) {
              finalizeSourceServiceDid = srcInfo.did;
            }
          }
        } catch {
          // Ignore if source lacks migration-info
        }
      }

      // Pre-serialize restored `membership/<recovery_did>` if recovering from sole-member leave!
      let restoredRecoveryMem:
        | {
            rkey: string;
            value: Record<string, unknown>;
            cborBytes: Uint8Array;
            cidStr: string;
            incarnation: string;
          }
        | undefined;
      if (recRow) {
        const membersSpace = groupMembersUri(groupDid);
        const writerMeta = this.db
          .prepare("SELECT last_evicted_repo_rev, prior_eject_count FROM space_writer WHERE space_uri = ? AND writer_did = ?")
          .get(membersSpace, recRow.recovery_did) as
          | { last_evicted_repo_rev: string | null; prior_eject_count: number }
          | undefined;
        const curSpace = this.db
          .prepare("SELECT space_rev FROM group_space WHERE space_uri = ?")
          .get(membersSpace) as { space_rev: string } | undefined;
        const predictedRev = nextMonotonicTid(curSpace?.space_rev ?? null);
        const freshInc = randomUUID();
        const roles = JSON.parse(recRow.roles_json) as string[];
        const memVal: Record<string, unknown> = {
          $type: ATGRP_COLLECTION.membership,
          roles,
          createdAt: nowIso,
          [FLOCK_EXTENSION_FIELD.incarnation]: freshInc,
          [FLOCK_EXTENSION_FIELD.generation]: (writerMeta?.prior_eject_count ?? 0) + 1,
          [FLOCK_EXTENSION_FIELD.admittedSpaceRev]: predictedRev,
          [FLOCK_EXTENSION_FIELD.afterWriterRev]: writerMeta?.last_evicted_repo_rev ?? null,
        };
        const ser = await serializeRecord(
          ATGRP_COLLECTION.membership as NsidString,
          recRow.recovery_did as RecordKeyString,
          jsonToLex(memVal) as LexMap,
        );
        restoredRecoveryMem = {
          rkey: recRow.recovery_did,
          value: memVal,
          cborBytes: ser.bytes,
          cidStr: ser.cid.toString(),
          incarnation: freshInc,
        };
      }

      const tx = this.db.transaction(() => {
        if (params.auth.kind === "oauth") {
          const revalidated = revalidateLiveOAuthSessionSync(this.db, params.auth, {
            allowDeactivatedRecovery: true,
            nowMs,
          });
          revalidated.permissions.assertAccount({ attr: "status", action: "manage" });
          if (!isAuthorizedLifecycleAdmin(params.auth.authorizingUserDid, revalidated.effState, groupDid)) {
            throw new GroupHostHttpError(403, "Forbidden", "Caller is not an authorized lifecycle admin.");
          }
        }
        this.validateStagedOpenSocialIntegritySync({
          groupDid,
          rotationKeysAfterCutover: cutoverRotKeys,
          localRotationDidKey: localRot.did(),
          sourceLocalRotationKey: migSess?.source_local_rotation_key ?? null,
          recoveryRow: recRow,
        });

        if (restoredRecoveryMem) {
          this.repoStore.applySpaceRepoMutationsSync({
            groupDid,
            spaceUri: groupMembersUri(groupDid),
            repoDid: groupDid,
            ops: [
              {
                action: "create",
                collection: ATGRP_COLLECTION.membership,
                rkey: restoredRecoveryMem.rkey,
                value: restoredRecoveryMem.value,
                cborBytes: restoredRecoveryMem.cborBytes,
                cidStr: restoredRecoveryMem.cidStr,
                incarnation: restoredRecoveryMem.incarnation,
              },
            ],
            isOwnAuthoritySpace: true,
            nowMs,
          });
          this.db.prepare("DELETE FROM group_recovery_admin WHERE group_did = ?").run(groupDid);
        }

        this.db.prepare("DELETE FROM migration_session WHERE group_did = ?").run(groupDid);
        this.db.prepare("DELETE FROM revoked_migration_jti WHERE group_did = ?").run(groupDid);
        this.db
          .prepare("UPDATE group_account SET activated = 1, deactivated_at = NULL WHERE did = ?")
          .run(groupDid);

        if (params.auth.kind === "oauth" && params.auth.sessionKind === "recovery") {
          this.db
            .prepare("UPDATE oauth_session SET session_kind = 'group' WHERE session_id = ?")
            .run(params.auth.sessionId);
        }

        if (migSess && finalizeSourceServiceDid) {
          this.repoStore.upsertOutboxNoticeSync({
            kind: "source_migration_finalize",
            groupDid,
            coalesceKey: `srcfin\u0000${groupDid}\u0000${migSess.source_endpoint}`,
            endpoint: migSess.source_endpoint,
            payload: {
              group: groupDid,
              ...(migSess.operation_id ? { operationId: migSess.operation_id } : {}),
              sourceServiceDid: finalizeSourceServiceDid,
            },
            maxAttempts: 5,
            nowMs,
            expiresAt: nowMs + 60_000,
          });
        }
      });
      tx.immediate();

      if (migSess && finalizeSourceServiceDid) {
        await this.repoStore.flushOutboxNotices({ groupDid, nowMs }).catch(() => undefined);
      }
    });
  }

  async deactivateAccount(params: {
    session: AuthenticatedGroupSession;
    nowMs?: number;
  }): Promise<void> {
    const nowMs = params.nowMs ?? Date.now();
    const groupDid = params.session.groupDid;
    if (params.session.sessionKind !== "group") {
      throw new GroupHostHttpError(403, "Forbidden", "deactivateAccount requires an active Group-DID OAuth session.");
    }
    params.session.permissions.assertAccount({ attr: "status", action: "manage" });

    return this.locks.withGroupRepoLock(groupDid, async () => {
      reapExpiredPreparedMigrationLease(this.db, groupDid, nowMs);
      const hasLease = hasActiveSourceMigrationLease(this.db, groupDid, nowMs);

      const doc = await this.plc.resolveDidDocument(groupDid);
      const plcPointsHere = doc ? this.plc.extractPdsEndpoint(doc) === normalizeOriginUrl(this.config.publicUrl) : true;
      if (hasLease && plcPointsHere) {
        throw new GroupHostHttpError(409, "MigrationInProgress", "Cannot deactivate group while pre-cutover migration is active.");
      }

      const tx = this.db.transaction(() => {
        const revalidated = revalidateLiveOAuthSessionSync(this.db, params.session, {
          allowPlcSignedSourceLease: !plcPointsHere,
          nowMs,
        });
        revalidated.permissions.assertAccount({ attr: "status", action: "manage" });
        if (!isAuthorizedLifecycleAdmin(params.session.authorizingUserDid, revalidated.liveState, groupDid)) {
          throw new GroupHostHttpError(403, "Forbidden", "Caller is not an authorized lifecycle admin.");
        }

        const famRows = this.db
          .prepare("SELECT DISTINCT family_id, expires_at FROM oauth_session WHERE group_did = ?")
          .all(groupDid) as Array<{ family_id: string; expires_at: number }>;
        const insRevFam = this.db.prepare(
          "INSERT OR REPLACE INTO revoked_oauth_family (family_id, group_did, expires_at, revoked_at) VALUES (?, ?, ?, ?)",
        );
        for (const f of famRows) {
          insRevFam.run(f.family_id, groupDid, f.expires_at, nowMs);
        }

        this.db
          .prepare("UPDATE group_account SET auth_epoch = auth_epoch + 1, activated = 0, deactivated_at = ? WHERE did = ?")
          .run(nowMs, groupDid);
        this.db.prepare("DELETE FROM source_migration_lease WHERE group_did = ?").run(groupDid);
        this.db.prepare("DELETE FROM migration_session WHERE group_did = ?").run(groupDid);
        this.db.prepare("DELETE FROM revoked_migration_jti WHERE group_did = ?").run(groupDid);
        this.db.prepare("DELETE FROM oauth_par WHERE group_did = ?").run(groupDid);
        this.db.prepare("DELETE FROM upstream_oauth_state WHERE group_did = ?").run(groupDid);
        this.db.prepare("DELETE FROM oauth_code WHERE group_did = ?").run(groupDid);
        this.db.prepare("DELETE FROM oauth_refresh_token WHERE group_did = ?").run(groupDid);
        this.db.prepare("DELETE FROM oauth_session WHERE group_did = ?").run(groupDid);

        this.repoStore.revokeIssuedCredentialsSync({
          groupDid,
          enqueueNotices: plcPointsHere,
          nowMs,
        });
      });
      tx.immediate();
    });
  }

  async getServiceAuth(params: {
    session: AuthenticatedGroupSession;
    aud: string;
    exp?: number;
    lxm?: string;
    nowMs?: number;
  }): Promise<{ token: string }> {
    const nowMs = params.nowMs ?? Date.now();
    const groupDid = params.session.groupDid;
    if (params.session.sessionKind !== "group") {
      throw new GroupHostHttpError(403, "Forbidden", "getServiceAuth requires an active Group-DID OAuth session.");
    }

    reapExpiredPreparedMigrationLease(this.db, groupDid, nowMs);
    const lxm = params.lxm ?? null;

    if (lxm && PROTECTED_SERVICE_AUTH_METHODS.has(lxm)) {
      throw new GroupHostHttpError(
        400,
        "InvalidRequest",
        `Cannot request a service auth token for protected method: ${lxm}`,
      );
    }

    if (params.exp !== undefined) {
      const diffMs = params.exp * 1000 - nowMs;
      if (diffMs < 0) {
        throw new GroupHostHttpError(400, "BadExpiration", "Expiration is in the past.");
      }
      if (diffMs > HOUR_MS) {
        throw new GroupHostHttpError(400, "BadExpiration", "Cannot request expiration more than an hour in the future.");
      }
      if (!lxm && diffMs > MINUTE_MS) {
        throw new GroupHostHttpError(
          400,
          "BadExpiration",
          "Cannot request a method-less token with expiration more than a minute in the future.",
        );
      }
    }

    params.session.permissions.assertRpc({
      aud: params.aud as `${DidString}#${string}`,
      lxm: (lxm ?? "*") as NsidString,
    });

    const isTargetMigrationLxm =
      lxm === "com.atproto.server.createAccount" || lxm === FLOCK_GROUP_METHOD.abortMigration;
    let unleasedTargetVerified = false;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (isTargetMigrationLxm) {
        const preLease = this.db
          .prepare("SELECT target_service_did FROM source_migration_lease WHERE group_did = ?")
          .get(groupDid) as { target_service_did: string } | undefined;
        if (preLease) {
          if (params.aud !== preLease.target_service_did) {
            throw new GroupHostHttpError(
              409,
              "MigrationInProgress",
              `Active migration lease restricts ${lxm} aud to ${preLease.target_service_did}.`,
            );
          }
        } else if (!unleasedTargetVerified) {
          // Unleased outbound migration: verify target capability against `aud` DID doc `#atproto_pds`!
          const checkNowMs = params.nowMs ?? Date.now();
          const bareAudDid = params.aud.split("#", 1)[0]!;
          const audDoc = await this.plc.resolveDidDocument(bareAudDid).catch(() => null);
          const audPds = audDoc ? this.plc.extractPdsEndpoint(audDoc) : null;
          if (!audPds) {
            throw new GroupHostHttpError(400, "UnsupportedGroupHostTarget", `Cannot resolve #atproto_pds for ${params.aud}.`);
          }
          const cap = await this.verifyOpenSocialTargetCapability(audPds, checkNowMs);
          if (cap.targetServiceDid !== bareAudDid || params.aud !== cap.targetServiceDid) {
            throw new GroupHostHttpError(400, "UnsupportedGroupHostTarget", "Target service DID mismatch.");
          }
          unleasedTargetVerified = true;
        }
      }

      const signingKey = await this.repoStore.getGroupSigningKey(groupDid);
      const minted = await this.locks.withGroupRepoLock(groupDid, async () => {
        const mintNowMs = params.nowMs ?? Date.now();
        const nowSec = Math.floor(mintNowMs / 1000);
        const mintExpSec = params.exp ?? nowSec + 60;
        const token = await createServiceJwt({
          iss: groupDid,
          aud: params.aud,
          iat: nowSec,
          exp: mintExpSec,
          lxm,
          keypair: signingKey,
        });

        // Final zero-yield synchronous commit-point revalidation of live session, role, status, exp, and migration lease!
        const commitNowMs = params.nowMs ?? Date.now();
        const commitNowSec = Math.floor(commitNowMs / 1000);
        reapExpiredPreparedMigrationLease(this.db, groupDid, commitNowMs);
        const revalidated = revalidateLiveOAuthSessionSync(this.db, params.session, { nowMs: commitNowMs });
        revalidated.permissions.assertRpc({
          aud: params.aud as `${DidString}#${string}`,
          lxm: (lxm ?? "*") as NsidString,
        });
        const finalDiffMs = mintExpSec * 1000 - commitNowMs;
        if (mintExpSec <= commitNowSec || finalDiffMs <= 0) {
          throw new GroupHostHttpError(400, "BadExpiration", "Expiration is in the past.");
        }
        if (finalDiffMs > HOUR_MS) {
          throw new GroupHostHttpError(400, "BadExpiration", "Cannot request expiration more than an hour in the future.");
        }
        if (!lxm && finalDiffMs > MINUTE_MS) {
          throw new GroupHostHttpError(
            400,
            "BadExpiration",
            "Cannot request a method-less token with expiration more than a minute in the future.",
          );
        }
        if (isTargetMigrationLxm) {
          const liveLease = this.db
            .prepare("SELECT target_service_did FROM source_migration_lease WHERE group_did = ?")
            .get(groupDid) as { target_service_did: string } | undefined;
          if (liveLease) {
            if (params.aud !== liveLease.target_service_did) {
              throw new GroupHostHttpError(
                409,
                "MigrationInProgress",
                `Active migration lease restricts ${lxm} aud to ${liveLease.target_service_did}.`,
              );
            }
          } else if (!unleasedTargetVerified) {
            // Lease cleared during async key/signing step; loop once to verify unleased target capability before returning!
            return null;
          }
        }
        return { token };
      });
      if (minted) return minted;
    }
    throw new GroupHostHttpError(409, "MigrationInProgress", "Concurrent migration state change during getServiceAuth; retry.");
  }

  // =========================================================================
  // `getRecommendedDidCredentials`, `requestPlcOperationSignature`, `signPlcOperation`, `submitPlcOperation`
  // =========================================================================

  async getRecommendedDidCredentials(params: {
    auth: AuthenticatedGroupSession | AuthenticatedMigrationSession;
  }): Promise<Record<string, unknown>> {
    const groupDid = params.auth.groupDid;
    params.auth.permissions.assertIdentity({ attr: "*" });

    return this.locks.withGroupRepoLock(groupDid, async () => {
      if (
        this.db
          .prepare("SELECT 1 AS ok FROM group_deletion_journal WHERE group_did = ? AND (plc_outcome IS NULL OR plc_outcome != 'migrated_remote')")
          .get(groupDid)
      ) {
        throw new GroupHostHttpError(400, "RepoTakendown", "Group is deleting.");
      }

      const acct = this.db
        .prepare("SELECT handle, activated, takendown FROM group_account WHERE did = ?")
        .get(groupDid) as { handle: string; activated: number; takendown: number } | undefined;
      if (!acct || acct.takendown !== 0) throw new GroupHostHttpError(400, "RepoTakendown");

      const signingKey = await this.repoStore.getGroupSigningKey(groupDid);
      const kemKey = await this.repoStore.getGroupKemKey(groupDid);
      const localRot = await this.repoStore.getGroupRotationKey(groupDid);
      if (!localRot) {
        throw new GroupHostHttpError(400, "InvalidRequest", "Group lacks local PLC rotation key.");
      }

      let rotationKeys: string[];
      if (acct.activated === 0) {
        const sess = this.db
          .prepare("SELECT preserved_sovereign_keys_json FROM migration_session WHERE group_did = ?")
          .get(groupDid) as { preserved_sovereign_keys_json: string } | undefined;
        if (!sess) {
          throw new GroupHostHttpError(400, "RepoDeactivated", "Group is deactivated.");
        }
        const metaExists = this.db
          .prepare("SELECT 1 AS ok FROM group_space WHERE space_uri = ? AND deleted_at IS NULL")
          .get(groupMetaUri(groupDid));
        const membersExists = this.db
          .prepare("SELECT 1 AS ok FROM group_space WHERE space_uri = ? AND deleted_at IS NULL")
          .get(groupMembersUri(groupDid));
        if (!metaExists || !membersExists) {
          throw new GroupHostHttpError(
            409,
            "MigrationStagingIncomplete",
            "meta/self and members/self must be staged before getRecommendedDidCredentials.",
          );
        }

        const preservedSov = JSON.parse(sess.preserved_sovereign_keys_json) as string[];
        if (1 + preservedSov.length > 5) {
          throw new GroupHostHttpError(400, "TooManyRotationKeys", "Rotation keys exceed 5-key PLC limit.");
        }

        const stagedState = loadLiveGovernanceState(this.db, groupDid);
        const recRow = this.db
          .prepare("SELECT * FROM group_recovery_admin WHERE group_did = ?")
          .get(groupDid) as RecoveryAdminRow | undefined;
        if (humanMemberships(stagedState, groupDid).size === 0 && !recRow && preservedSov.length === 0) {
          throw new GroupHostHttpError(
            400,
            "NoSovereignCustodyKey",
            "Zero-human group requires an external sovereign PLC rotation key before cutover.",
          );
        }
        rotationKeys = [localRot.did(), ...preservedSov];
      } else {
        const lastOp = await this.plc.getPlcLastOp(groupDid);
        const liveRot = lastOp && "rotationKeys" in lastOp ? lastOp.rotationKeys : [];
        rotationKeys = [localRot.did(), ...liveRot.filter((k) => k !== localRot.did())];
      }

      return {
        rotationKeys,
        alsoKnownAs: [`at://${acct.handle}`],
        verificationMethods: {
          atproto: signingKey.did(),
          atproto_kem: kemKey.did(),
        },
        services: {
          atproto_pds: {
            type: "AtprotoPersonalDataServer",
            endpoint: groupHostPdsServiceEndpoint(this.config),
          },
        },
      };
    });
  }

  async requestPlcOperationSignature(params: {
    session: AuthenticatedGroupSession;
    nowMs?: number;
  }): Promise<void> {
    return this.locks.withGroupRepoLock(params.session.groupDid, () => {
      this.requestPlcOperationSignatureSync(params);
    });
  }

  requestPlcOperationSignatureSync(params: {
    session: AuthenticatedGroupSession;
    nowMs?: number;
  }): void {
    const nowMs = params.nowMs ?? Date.now();
    const groupDid = params.session.groupDid;
    if (params.session.sessionKind !== "group") {
      throw new GroupHostHttpError(403, "Forbidden", "requestPlcOperationSignature requires an active Group-DID OAuth session.");
    }
    assertFreshLoginStepUp(
      params.session,
      nowMs,
      "requestPlcOperationSignature requires prompt=login within 5 minutes.",
    );
    params.session.permissions.assertIdentity({ attr: "*" });

    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = sha256HexBytes(rawToken);

    const tx = this.db.transaction(() => {
      const revalidated = revalidateLiveOAuthSessionSync(this.db, params.session, { nowMs });
      revalidated.permissions.assertIdentity({ attr: "*" });
      if (!isAuthorizedLifecycleAdmin(params.session.authorizingUserDid, revalidated.liveState, groupDid)) {
        throw new GroupHostHttpError(403, "Forbidden", "Caller is not an authorized lifecycle admin.");
      }

      const enc = this.cryptoBox.encryptColumn(
        "group_action_token",
        `${groupDid}:plc_operation`,
        "claim_ciphertext_enc",
        rawToken,
      );
      this.db
        .prepare(
          `INSERT INTO group_action_token (
             token_hash, group_did, actor_did, purpose, claim_ciphertext_enc, claimed_at, expires_at, created_at
           ) VALUES (?, ?, ?, 'plc_operation', ?, NULL, ?, ?)
           ON CONFLICT(group_did, purpose) DO UPDATE SET
             token_hash = excluded.token_hash,
             actor_did = excluded.actor_did,
             claim_ciphertext_enc = excluded.claim_ciphertext_enc,
             claimed_at = NULL,
             expires_at = excluded.expires_at,
             created_at = excluded.created_at`,
        )
        .run(tokenHash, groupDid, params.session.authorizingUserDid, enc, nowMs + 10 * MINUTE_MS, nowMs);
    });
    tx.immediate();
  }

  async signPlcOperation(params: {
    session: AuthenticatedGroupSession;
    token?: string;
    rotationKeys?: string[];
    alsoKnownAs?: string[];
    verificationMethods?: Record<string, string>;
    services?: Record<string, { type: string; endpoint: string }>;
    operationIdHeader?: string;
    nowMs?: number;
  }): Promise<{ operation: Operation }> {
    const nowMs = params.nowMs ?? Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const groupDid = params.session.groupDid;
    if (params.session.sessionKind !== "group") {
      throw new GroupHostHttpError(403, "Forbidden", "signPlcOperation requires an active Group-DID OAuth session.");
    }
    assertFreshLoginStepUp(params.session, nowMs, "signPlcOperation requires prompt=login within 5 minutes.");
    params.session.permissions.assertIdentity({ attr: "*" });
    if (params.operationIdHeader !== undefined && !isValidIdempotencyKey(params.operationIdHeader)) {
      throw new GroupHostHttpError(400, "InvalidRequest", "Malformed X-Group-Migration-Operation-Id header.");
    }

    return this.locks.withGroupRepoLock(groupDid, async () => {
      if (this.db.prepare("SELECT 1 AS ok FROM group_deletion_journal WHERE group_did = ?").get(groupDid)) {
        throw new GroupHostHttpError(400, "RepoTakendown", "Group is deleting.");
      }

      reapExpiredPreparedMigrationLease(this.db, groupDid, nowMs);

      const acct = this.db
        .prepare("SELECT handle, activated, takendown FROM group_account WHERE did = ?")
        .get(groupDid) as { handle: string; activated: number; takendown: number } | undefined;
      if (!acct || acct.takendown !== 0) throw new GroupHostHttpError(400, "RepoTakendown");
      if (acct.activated !== 1) throw new GroupHostHttpError(400, "RepoDeactivated");

      const localSigning = await this.repoStore.getGroupSigningKey(groupDid);
      const localKem = await this.repoStore.getGroupKemKey(groupDid);
      const localRot = await this.repoStore.getGroupRotationKey(groupDid);
      if (!localRot) {
        throw new GroupHostHttpError(400, "InvalidRequest", "Source group lacks a local PLC rotation key.");
      }

      const lastOp = await this.plc.getPlcLastOp(groupDid);
      if (!lastOp || lastOp.type !== "plc_operation") {
        throw new GroupHostHttpError(400, "InvalidRequest", "PLC DID absent, tombstoned, or legacy genesis.");
      }

      const proposedServices = params.services ?? lastOp.services;
      let proposedPdsOrigin: string;
      try {
        proposedPdsOrigin = proposedServices?.atproto_pds?.endpoint
          ? normalizeOriginUrl(proposedServices.atproto_pds.endpoint)
          : normalizeOriginUrl(this.config.publicUrl);
      } catch {
        throw new GroupHostHttpError(400, "InvalidRequest", "Invalid #atproto_pds service endpoint.");
      }
      const proposedRotKeys = params.rotationKeys ?? lastOp.rotationKeys;
      const proposedAka = params.alsoKnownAs ?? lastOp.alsoKnownAs;
      const proposedVm = params.verificationMethods ?? lastOp.verificationMethods;

      if (proposedRotKeys.length < 1 || proposedRotKeys.length > 5) {
        throw new GroupHostHttpError(400, "TooManyRotationKeys", "PLC rotationKeys must contain 1..5 keys.");
      }
      if (!proposedRotKeys.every(isSupportedPlcRotationDidKey)) {
        throw new GroupHostHttpError(400, "InvalidRequest", "Unsupported rotation key format.");
      }

      const isCutover = proposedPdsOrigin !== normalizeOriginUrl(this.config.publicUrl);
      let unleasedOperationId: string | null = null;
      let unleasedTargetServiceDid: string | null = null;
      let unleasedSnap: Awaited<ReturnType<GroupMigrationService["snapshotGroupManifestAndSizes"]>> | null = null;

      const initialLease = this.db
        .prepare("SELECT * FROM source_migration_lease WHERE group_did = ?")
        .get(groupDid) as
        | {
            operation_id: string;
            mode: "coordinated" | "standard";
            ticket_id: string | null;
            target_service_did: string;
            target_endpoint: string;
            status: "prepared" | "plc_signed";
            signed_plc_op_json: string | null;
            deadline_at: number;
            manifest_digest: string;
            root_manifest_json: string;
          }
        | undefined;

      if (isCutover) {
        if (initialLease && params.operationIdHeader !== undefined && initialLease.operation_id !== params.operationIdHeader) {
          throw new GroupHostHttpError(
            409,
            "MigrationInProgress",
            `Active source migration lease (${initialLease.operation_id}) does not match X-Group-Migration-Operation-Id (${params.operationIdHeader}).`,
          );
        }
        if (initialLease && initialLease.target_endpoint !== proposedPdsOrigin) {
          throw new GroupHostHttpError(
            409,
            "MigrationInProgress",
            `Proposed #atproto_pds (${proposedPdsOrigin}) does not match leased target (${initialLease.target_endpoint}).`,
          );
        }

        // Crash-safe idempotent replay when a cutover `signPlcOperation` already committed `status = 'plc_signed'`
        // and consumed `group_action_token` before the caller received/persisted the response!
        if (initialLease?.status === "plc_signed") {
          if (initialLease.signed_plc_op_json === null) {
            throw new GroupHostHttpError(409, "MigrationInProgress", "Migration PLC operation already signed.");
          }
          const savedSignedOp = JSON.parse(initialLease.signed_plc_op_json) as Operation;
          const matchesSaved =
            isDeepStrictEqual(proposedRotKeys, savedSignedOp.rotationKeys) &&
            isDeepStrictEqual(proposedAka, savedSignedOp.alsoKnownAs) &&
            isDeepStrictEqual(proposedVm, savedSignedOp.verificationMethods) &&
            isDeepStrictEqual(proposedServices, savedSignedOp.services);

          this.db
            .transaction(() => {
              const revalidated = revalidateLiveOAuthSessionSync(this.db, params.session, {
                allowPlcSignedSourceLease: true,
                nowMs,
              });
              assertFreshLoginStepUp(
                params.session,
                nowMs,
                "signPlcOperation requires prompt=login within 5 minutes.",
              );
              revalidated.permissions.assertIdentity({ attr: "*" });
              if (!isAuthorizedLifecycleAdmin(params.session.authorizingUserDid, revalidated.liveState, groupDid)) {
                throw new GroupHostHttpError(403, "Forbidden", "Caller is not an authorized lifecycle admin.");
              }
              if (!matchesSaved) {
                throw new GroupHostHttpError(
                  409,
                  "MigrationInProgress",
                  "Cutover PLC operation was already signed with different parameters.",
                );
              }
              if (params.token) {
                const maybeHash = sha256HexBytes(params.token);
                this.db
                  .prepare(
                    "DELETE FROM group_action_token WHERE token_hash = ? AND group_did = ? AND actor_did = ? AND purpose = 'plc_operation'",
                  )
                  .run(maybeHash, groupDid, params.session.authorizingUserDid);
              }
            })
            .immediate();

          return { operation: savedSignedOp };
        }
      } else if (initialLease?.status === "plc_signed") {
        throw new GroupHostHttpError(409, "MigrationInProgress", "Group migration PLC cutover has been signed.");
      }

      // Validate live lifecycle-admin authorization and unconsumed confirmation token BEFORE any
      // network probes, credential revocations, or outbox modifications!
      if (!params.token) {
        throw new GroupHostHttpError(400, "InvalidToken", "Confirmation token is required for signPlcOperation.");
      }
      const rawConfirmationToken = params.token;
      const tokenHash = sha256HexBytes(rawConfirmationToken);

      const verifyAuthAndTokenSync = (checkNowMs: number) => {
        const revalidated = revalidateLiveOAuthSessionSync(this.db, params.session, {
          allowPlcSignedSourceLease: false,
          nowMs: checkNowMs,
        });
        assertFreshLoginStepUp(
          params.session,
          checkNowMs,
          "signPlcOperation requires prompt=login within 5 minutes.",
        );
        revalidated.permissions.assertIdentity({ attr: "*" });
        if (!isAuthorizedLifecycleAdmin(params.session.authorizingUserDid, revalidated.liveState, groupDid)) {
          throw new GroupHostHttpError(403, "Forbidden", "Caller is not an authorized lifecycle admin.");
        }
        const tokenRow = this.db
          .prepare(
            "SELECT actor_did, expires_at FROM group_action_token WHERE token_hash = ? AND group_did = ? AND purpose = 'plc_operation'",
          )
          .get(tokenHash, groupDid) as { actor_did: string; expires_at: number } | undefined;
        if (!tokenRow || tokenRow.actor_did !== params.session.authorizingUserDid) {
          throw new GroupHostHttpError(400, "InvalidToken", "Invalid PLC operation confirmation token.");
        }
        if (tokenRow.expires_at <= checkNowMs) {
          throw new GroupHostHttpError(400, "ExpiredToken", "PLC operation confirmation token expired.");
        }
      };

      verifyAuthAndTokenSync(nowMs);

      if (isCutover) {
        // Enforce retiring source key removal & sovereign key preservation across ALL cutover modes!
        if (proposedRotKeys.includes(localRot.did())) {
          throw new GroupHostHttpError(
            400,
            "SourceRotationKeyRetained",
            "Cutover PLC operation must remove retiring source host rotation key.",
          );
        }
        const sourceSovereignKeys = lastOp.rotationKeys.filter((k) => k !== localRot.did());
        for (const sov of sourceSovereignKeys) {
          if (!proposedRotKeys.includes(sov)) {
            throw new GroupHostHttpError(
              400,
              "SovereignRotationKeyDropped",
              `Cutover PLC operation dropped external sovereign rotation key: ${sov}`,
            );
          }
        }

        const lease = initialLease;

        if (lease) {
          const currentSnap = await this.snapshotGroupManifestAndSizes({
            groupDid,
            operationId: lease.operation_id,
            deadlineAtMs: lease.deadline_at,
            sourceLocalRotationKey: localRot.did(),
          });
          if (currentSnap.manifestJson !== lease.root_manifest_json) {
            throw new GroupHostHttpError(409, "MigrationManifestMismatch", "Source state changed after prepare-migration.");
          }

          if (lease.mode === "coordinated" && lease.ticket_id) {
            const srcJwt = await createServiceJwt({
              iss: this.config.serviceDid,
              aud: lease.target_service_did,
              iat: nowSec,
              exp: nowSec + 60,
              lxm: "com.atproto.identity.signPlcOperation",
              keypair: this.serviceKeys.activeKeypair,
            });
            const attUrl = `${lease.target_endpoint}/group-admin/migration-attestation?group=${encodeURIComponent(groupDid)}&operationId=${encodeURIComponent(lease.operation_id)}&ticketId=${encodeURIComponent(lease.ticket_id)}`;
            const attRes = await this.infoFetcher(attUrl, {
              method: "GET",
              headers: {
                accept: "application/json",
                authorization: `Bearer ${srcJwt}`,
              },
            });
            if (!attRes.ok) {
              throw new GroupHostHttpError(
                409,
                "MigrationAttestationFailed",
                `Target migration-attestation rejected (${attRes.status}).`,
              );
            }
            const att = await readUpstreamJson<{
              groupDid?: string;
              operationId?: string;
              ticketId?: string;
              manifestDigest?: string;
              targetEndpoint?: string;
              targetServiceDid?: string;
              targetSigningKey?: string;
              targetKemKey?: string;
              targetLocalRotationKey?: string;
            }>(attRes, BOUNDED_FETCH_PROFILES.migrationInfo.maxResponseBytes);

            if (
              !att ||
              att.groupDid !== groupDid ||
              att.operationId !== lease.operation_id ||
              att.ticketId !== lease.ticket_id ||
              att.manifestDigest !== lease.manifest_digest ||
              att.targetEndpoint !== lease.target_endpoint ||
              att.targetServiceDid !== lease.target_service_did ||
              att.targetSigningKey !== proposedVm.atproto ||
              att.targetKemKey !== proposedVm.atproto_kem ||
              typeof att.targetLocalRotationKey !== "string" ||
              !proposedRotKeys.includes(att.targetLocalRotationKey)
            ) {
              throw new GroupHostHttpError(
                409,
                "MigrationAttestationMismatch",
                "Target attestation does not match proposed cutover credentials or manifest digest.",
              );
            }
          }
        } else {
          // Unleased outbound migration: verify DID-bound `group.opensocial.policy` capability FIRST!
          if (params.operationIdHeader !== undefined) {
            const abortedOpRow = this.db
              .prepare("SELECT 1 AS ok FROM service_jwt_jti WHERE issuer_did = ? AND jti = ? AND expires_at > ?")
              .get(groupDid, `aborted-op:${params.operationIdHeader}`, nowMs);
            if (abortedOpRow) {
              throw new GroupHostHttpError(
                409,
                "OperationIdAlreadyAborted",
                `Migration operationId '${params.operationIdHeader}' was already aborted on source.`,
              );
            }
          }
          const cap = await this.verifyOpenSocialTargetCapability(proposedPdsOrigin, nowMs);
          unleasedOperationId = params.operationIdHeader ?? `unleased-${randomUUID()}`;
          unleasedTargetServiceDid = cap.targetServiceDid;
          unleasedSnap = await this.snapshotGroupManifestAndSizes({
            groupDid,
            operationId: unleasedOperationId,
            deadlineAtMs: nowMs + 2 * HOUR_MS,
            sourceLocalRotationKey: localRot.did(),
          });
        }
      } else {
        // Non-cutover local PLC update: ensure local rotation key stays present
        if (!proposedRotKeys.includes(localRot.did())) {
          throw new GroupHostHttpError(400, "InvalidRequest", "Local PLC operation must retain local host rotation key.");
        }
        void localSigning;
        void localKem;
      }

      const prevCid = await plcCidForOp(lastOp);
      const unsignedOp: UnsignedOperation = {
        type: "plc_operation",
        rotationKeys: proposedRotKeys,
        verificationMethods: proposedVm,
        alsoKnownAs: proposedAka,
        services: proposedServices,
        prev: prevCid.toString(),
      };
      const signedOp = await signOperation(unsignedOp, localRot);
      try {
        await assureValidOp(signedOp);
      } catch (err) {
        throw new GroupHostHttpError(
          400,
          "InvalidRequest",
          err instanceof Error ? err.message : "Invalid PLC operation.",
        );
      }

      const commitDecisionNowMs = params.nowMs ?? Date.now();

      if (isCutover) {
        // ONLY AFTER all authorization, token, key, manifest, attestation/capability, and PLC op checks
        // have succeeded: re-verify auth + token + lease atomically and revoke source credentials + drain outbox!
        this.db
          .transaction(() => {
            verifyAuthAndTokenSync(commitDecisionNowMs);
            const liveLease = this.db
              .prepare("SELECT operation_id, status, target_endpoint FROM source_migration_lease WHERE group_did = ?")
              .get(groupDid) as
              | { operation_id: string; status: "prepared" | "plc_signed"; target_endpoint: string }
              | undefined;
            if (initialLease) {
              if (
                !liveLease ||
                liveLease.operation_id !== initialLease.operation_id ||
                liveLease.status !== "prepared" ||
                liveLease.target_endpoint !== proposedPdsOrigin
              ) {
                throw new GroupHostHttpError(409, "MigrationInProgress", "Migration lease changed before cutover.");
              }
            } else if (liveLease) {
              throw new GroupHostHttpError(409, "MigrationInProgress", "Another migration lease started concurrently.");
            }
            this.repoStore.revokeIssuedCredentialsSync({
              groupDid,
              enqueueNotices: true,
              nowMs: commitDecisionNowMs,
            });
          })
          .immediate();

        for (let pass = 0; pass < 4; pass += 1) {
          const pending = (
            this.db
              .prepare("SELECT COUNT(*) AS cnt FROM outbox_notice WHERE group_did = ? AND status IN ('pending', 'leased')")
              .get(groupDid) as { cnt: number }
          ).cnt;
          if (pending === 0) break;
          this.db
            .prepare("UPDATE outbox_notice SET next_attempt_at = 0, lease_until = NULL WHERE group_did = ? AND status IN ('pending', 'leased')")
            .run(groupDid);
          await this.repoStore.flushOutboxNotices({ groupDid, nowMs: commitDecisionNowMs });
        }
        // Abandon any non-responsive peer notices so cutover never hangs indefinitely
        this.db
          .prepare("UPDATE outbox_notice SET status = 'abandoned', lease_until = NULL WHERE group_did = ? AND status IN ('pending', 'leased')")
          .run(groupDid);
      }

      const tx = this.db.transaction(() => {
        verifyAuthAndTokenSync(commitDecisionNowMs);

        const pendingOutbox = (
          this.db
            .prepare("SELECT COUNT(*) AS cnt FROM outbox_notice WHERE group_did = ? AND status IN ('pending', 'leased')")
            .get(groupDid) as { cnt: number }
        ).cnt;
        if (isCutover && pendingOutbox > 0) {
          throw new GroupHostHttpError(409, "OutboxDrainIncomplete", "Source outbox notices still draining.");
        }

        const delRes = this.db.prepare("DELETE FROM group_action_token WHERE token_hash = ?").run(tokenHash);
        if (delRes.changes !== 1) {
          throw new GroupHostHttpError(400, "InvalidToken", "Invalid PLC operation confirmation token.");
        }

        if (isCutover) {
          const existingLease = this.db
            .prepare("SELECT 1 AS ok FROM source_migration_lease WHERE group_did = ?")
            .get(groupDid);
          if (existingLease) {
            this.db
              .prepare(
                "UPDATE source_migration_lease SET status = 'plc_signed', expires_at = NULL, signed_plc_op_json = ? WHERE group_did = ?",
              )
              .run(JSON.stringify(signedOp), groupDid);
          } else if (unleasedOperationId && unleasedTargetServiceDid && unleasedSnap) {
            this.db
              .prepare(
                `INSERT INTO source_migration_lease (
                   group_did, operation_id, mode, ticket_id, ticket_secret_hash, ticket_secret_enc,
                   target_service_did, target_endpoint, status, signed_plc_op_json,
                   frozen_at, deadline_at, expires_at, manifest_digest, root_manifest_json
                 ) VALUES (?, ?, 'standard', NULL, NULL, NULL, ?, ?, 'plc_signed', ?, ?, ?, NULL, ?, ?)`,
              )
              .run(
                groupDid,
                unleasedOperationId,
                unleasedTargetServiceDid,
                proposedPdsOrigin,
                JSON.stringify(signedOp),
                commitDecisionNowMs,
                commitDecisionNowMs + 2 * HOUR_MS,
                unleasedSnap.manifestDigest,
                unleasedSnap.manifestJson,
              );
          }
        }
      });
      tx.immediate();

      return { operation: signedOp };
    });
  }

  async submitPlcOperation(params: {
    auth: AuthenticatedGroupSession | AuthenticatedMigrationSession;
    operation: unknown;
    nowMs?: number;
  }): Promise<void> {
    const startWallMs = Date.now();
    const nowMs = params.nowMs ?? startWallMs;
    const commitNow = () =>
      params.nowMs !== undefined ? params.nowMs + Math.max(0, Date.now() - startWallMs) : Date.now();
    const groupDid = params.auth.groupDid;
    params.auth.permissions.assertIdentity({ attr: "*" });
    if (typeof params.operation !== "object" || params.operation === null) {
      throw new GroupHostHttpError(400, "InvalidRequest", "PLC operation must be an object.");
    }

    return this.locks.withGroupRepoLock(groupDid, async () => {
      if (
        this.db
          .prepare("SELECT 1 AS ok FROM group_deletion_journal WHERE group_did = ? AND (plc_outcome IS NULL OR plc_outcome != 'migrated_remote')")
          .get(groupDid)
      ) {
        throw new GroupHostHttpError(400, "RepoTakendown", "Group is deleting.");
      }

      const acct = this.db
        .prepare("SELECT handle, activated, takendown FROM group_account WHERE did = ?")
        .get(groupDid) as { handle: string; activated: number; takendown: number } | undefined;
      if (!acct || acct.takendown !== 0) throw new GroupHostHttpError(400, "RepoTakendown");

      const signingKey = await this.repoStore.getGroupSigningKey(groupDid);
      const kemKey = await this.repoStore.getGroupKemKey(groupDid);
      const localRot = await this.repoStore.getGroupRotationKey(groupDid);
      if (!localRot) {
        throw new GroupHostHttpError(400, "InvalidRequest", "Missing local rotation key.");
      }

      type SubmitMigSessionRow = {
        id: string;
        mode: "coordinated" | "standard";
        operation_id: string | null;
        source_local_rotation_key: string | null;
        preserved_sovereign_keys_json: string;
        expected_manifest_json: string | null;
        plc_cutover_at: number | null;
        plc_submitting_at: number | null;
        pending_plc_op_cid: string | null;
        absolute_deadline_at: number;
      };

      let migSess = this.db
        .prepare("SELECT * FROM migration_session WHERE group_did = ?")
        .get(groupDid) as SubmitMigSessionRow | undefined;

      if (
        migSess &&
        migSess.plc_cutover_at === null &&
        (migSess.plc_submitting_at !== null || migSess.pending_plc_op_cid !== null)
      ) {
        const recState = await this.reconcileUncutoverSessionLocked(groupDid, commitNow());
        if (recState === "retain_fail_safe") {
          throw new GroupHostHttpError(
            502,
            "PlcDirectoryError",
            "Prior PLC cutover submission is indeterminate while PLC directory is unreachable.",
          );
        }
        migSess = this.db
          .prepare("SELECT * FROM migration_session WHERE group_did = ?")
          .get(groupDid) as SubmitMigSessionRow | undefined;
      }
      const hadPriorPendingSubmission = Boolean(
        migSess && (migSess.plc_submitting_at !== null || migSess.pending_plc_op_cid !== null),
      );

      const verifyLiveCutoverPlcState = async () => {
        const doc = await this.plc.resolveDidDocument(groupDid);
        const lastOp = await this.plc.getPlcLastOp(groupDid);
        if (!doc || !lastOp || lastOp.type === "plc_tombstone") {
          throw new GroupHostHttpError(400, "UnresolvableDid", "Group DID unresolvable on PLC.");
        }
        if (this.plc.extractPdsEndpoint(doc) !== normalizeOriginUrl(this.config.publicUrl)) {
          throw new GroupHostHttpError(400, "InvalidPlcState", "PLC #atproto_pds does not point to this Group Host.");
        }
        if (this.plc.extractVerificationMethodDidKey(doc, "#atproto") !== signingKey.did()) {
          throw new GroupHostHttpError(400, "InvalidPlcState", "PLC #atproto key does not match local signing key.");
        }
        if (this.plc.extractKemDidKey(doc) !== kemKey.did()) {
          throw new GroupHostHttpError(400, "InvalidPlcState", "PLC #atproto_kem key does not match local KEM key.");
        }
        if (!doc.alsoKnownAs || doc.alsoKnownAs[0] !== `at://${acct.handle}`) {
          throw new GroupHostHttpError(400, "InvalidPlcState", "PLC alsoKnownAs[0] does not match group handle.");
        }
        if (!plcOpRotationKeys(lastOp).includes(localRot.did())) {
          throw new GroupHostHttpError(400, "InvalidPlcState", "PLC rotationKeys missing local host rotation key.");
        }
        return lastOp;
      };

      // Idempotent retry when `submitPlcOperation` already committed earlier and the client lost the HTTP response!
      if (migSess?.plc_cutover_at !== null && migSess?.plc_cutover_at !== undefined) {
        if (params.auth.kind === "oauth") {
          const oauthAuth = params.auth;
          this.db
            .transaction(() => {
              const revalidated = revalidateLiveOAuthSessionSync(this.db, oauthAuth, {
                allowDeactivatedRecovery: true,
                nowMs,
              });
              revalidated.permissions.assertIdentity({ attr: "*" });
              if (!isAuthorizedLifecycleAdmin(oauthAuth.authorizingUserDid, revalidated.effState, groupDid)) {
                throw new GroupHostHttpError(403, "Forbidden", "Caller is not an authorized lifecycle admin.");
              }
            })
            .immediate();
        }
        await verifyLiveCutoverPlcState();
        return;
      }

      // Also handle the crash window where PLC accepted the exact cutover op right before `plc_cutover_at` was written!
      if (migSess && (params.operation as { type?: unknown }).type === "plc_operation") {
        const lastOp = await this.plc.getPlcLastOp(groupDid);
        if (lastOp && lastOp.type === "plc_operation") {
          const headCid = await plcCidForOp(lastOp).then((c) => c.toString()).catch(() => null);
          const reqCid = await plcCidForOp(params.operation as Operation).then((c) => c.toString()).catch(() => null);
          if (headCid && reqCid && headCid === reqCid) {
            await verifyLiveCutoverPlcState();
            const recRow = this.db
              .prepare("SELECT * FROM group_recovery_admin WHERE group_did = ?")
              .get(groupDid) as RecoveryAdminRow | undefined;
            this.db
              .transaction(() => {
                if (params.auth.kind === "oauth") {
                  const revalidated = revalidateLiveOAuthSessionSync(this.db, params.auth, {
                    allowDeactivatedRecovery: true,
                    nowMs,
                  });
                  revalidated.permissions.assertIdentity({ attr: "*" });
                  if (!isAuthorizedLifecycleAdmin(params.auth.authorizingUserDid, revalidated.effState, groupDid)) {
                    throw new GroupHostHttpError(403, "Forbidden", "Caller is not an authorized lifecycle admin.");
                  }
                }
                this.validateStagedOpenSocialIntegritySync({
                  groupDid,
                  rotationKeysAfterCutover: lastOp.rotationKeys,
                  localRotationDidKey: localRot.did(),
                  sourceLocalRotationKey: migSess.source_local_rotation_key,
                  recoveryRow: recRow,
                });
                this.db
                  .prepare(
                    "UPDATE migration_session SET plc_cutover_at = ?, plc_submitting_at = NULL, pending_plc_op_cid = NULL, pending_plc_op_json = NULL WHERE id = ?",
                  )
                  .run(nowMs, migSess.id);
              })
              .immediate();
            return;
          }
        }
      }

      const preservedSov = migSess
        ? (JSON.parse(migSess.preserved_sovereign_keys_json) as string[])
        : await (async () => {
            const lastOp: CompatibleOpOrTombstone | null = await this.plc.getPlcLastOp(groupDid);
            const liveRot = lastOp && "rotationKeys" in lastOp ? lastOp.rotationKeys : [];
            return liveRot.filter((k) => k !== localRot.did());
          })();

      const verifiedOp = await this.plc.verifyCutoverPlcOperation({
        did: groupDid,
        rawOp: params.operation,
        expectedPdsOrigin: normalizeOriginUrl(this.config.publicUrl),
        expectedHandle: acct.handle,
        expectedSigningDidKey: signingKey.did(),
        expectedKemDidKey: kemKey.did(),
        localRotationDidKey: localRot.did(),
        sourceLocalRotationKey: migSess?.source_local_rotation_key ?? null,
        preservedSovereignKeys: preservedSov,
      });

      const recRow = this.db
        .prepare("SELECT * FROM group_recovery_admin WHERE group_did = ?")
        .get(groupDid) as RecoveryAdminRow | undefined;

      if (migSess?.mode === "coordinated" && migSess.expected_manifest_json && migSess.operation_id && migSess.source_local_rotation_key) {
        const snap = await this.snapshotGroupManifestAndSizes({
          groupDid,
          operationId: migSess.operation_id,
          deadlineAtMs: migSess.absolute_deadline_at,
          sourceLocalRotationKey: migSess.source_local_rotation_key,
        });
        if (snap.manifestJson !== migSess.expected_manifest_json) {
          throw new GroupHostHttpError(
            409,
            "MigrationManifestMismatch",
            "Staged target state does not match expected source manifest before PLC cutover.",
          );
        }
      }

      const verifiedOpCid = (await plcCidForOp(verifiedOp)).toString();
      if (migSess?.pending_plc_op_cid !== null && migSess?.pending_plc_op_cid !== undefined && migSess.pending_plc_op_cid !== verifiedOpCid) {
        throw new GroupHostHttpError(
          409,
          "MigrationCutoverCommitted",
          "Another PLC cutover operation is already pending submission against the live PLC head.",
        );
      }

      this.db
        .transaction(() => {
          const checkNowMs = commitNow();
          if (params.auth.kind === "oauth") {
            const revalidated = revalidateLiveOAuthSessionSync(this.db, params.auth, {
              allowDeactivatedRecovery: true,
              nowMs: checkNowMs,
            });
            revalidated.permissions.assertIdentity({ attr: "*" });
            if (!isAuthorizedLifecycleAdmin(params.auth.authorizingUserDid, revalidated.effState, groupDid)) {
              throw new GroupHostHttpError(403, "Forbidden", "Caller is not an authorized lifecycle admin.");
            }
          } else {
            this.repoStore.assertLiveMigrationStagingSync(
              groupDid,
              params.auth.id,
              checkNowMs,
              params.auth.expSec,
              { allowSamePendingPlcOpCid: verifiedOpCid },
            );
          }
          this.validateStagedOpenSocialIntegritySync({
            groupDid,
            rotationKeysAfterCutover: verifiedOp.rotationKeys,
            localRotationDidKey: localRot.did(),
            sourceLocalRotationKey: migSess?.source_local_rotation_key ?? null,
            recoveryRow: recRow,
          });
          if (migSess) {
            this.db
              .prepare(
                "UPDATE migration_session SET plc_submitting_at = ?, pending_plc_op_cid = ?, pending_plc_op_json = ? WHERE id = ?",
              )
              .run(checkNowMs, verifiedOpCid, JSON.stringify(verifiedOp), migSess.id);
          }
        })
        .immediate();

      let plcRes: Response;
      try {
        plcRes = await this.plc.submitPlcOperation(groupDid, verifiedOp);
      } catch (err) {
        if (err instanceof GroupHostHttpError) throw err;
        throw new GroupHostHttpError(
          502,
          "PlcDirectoryError",
          `PLC operation submission failed with network error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!plcRes.ok) {
        const bodyText = await plcRes.text().catch(() => "");
        if (plcRes.status >= 500) {
          throw new GroupHostHttpError(
            502,
            "PlcDirectoryError",
            `PLC directory returned ${plcRes.status}: ${bodyText.slice(0, 200)}`,
          );
        }
        if (migSess) {
          const recState = await this.reconcileUncutoverSessionLocked(groupDid, commitNow());
          if (recState === "cutover_committed") {
            return;
          }
          if (recState === "retain_fail_safe") {
            throw new GroupHostHttpError(
              502,
              "PlcDirectoryError",
              "PLC operation response was rejected while live PLC head could not be reconciled.",
            );
          }
          if (recState === "pending_admissible" && !hadPriorPendingSubmission) {
            this.db
              .prepare(
                "UPDATE migration_session SET plc_submitting_at = NULL, pending_plc_op_cid = NULL, pending_plc_op_json = NULL WHERE id = ? AND plc_cutover_at IS NULL AND pending_plc_op_cid = ?",
              )
              .run(migSess.id, verifiedOpCid);
          }
        }
        throw new GroupHostHttpError(
          400,
          "InvalidPlcOperation",
          `PLC directory rejected operation (${plcRes.status}): ${bodyText.slice(0, 200)}`,
        );
      }

      if (migSess) {
        this.db
          .prepare(
            "UPDATE migration_session SET plc_cutover_at = ?, plc_submitting_at = NULL, pending_plc_op_cid = NULL, pending_plc_op_json = NULL WHERE id = ?",
          )
          .run(commitNow(), migSess.id);
      }
    });
  }
}

export { ScopePermissions };
