import { randomUUID } from "node:crypto";
import type { LexMap } from "@atproto/lex-data";
import { serializeRecord } from "@atproto/space";
import type { DidString, NsidString, RecordKeyString } from "@atproto/syntax";
import { cryptoVerifySignatureWithKey } from "@atproto/xrpc-server";
import {
  canonicalJson,
  groupMembersUri,
  groupMetaUri,
  isDid,
  isTid,
  parseAnySpaceRecordUri,
  personalInboxUri,
} from "@flock/protocol/keys";
import {
  ATGRP_COLLECTION,
  ATGRP_METHOD,
  ATGRP_SPACE_TYPE,
  FLOCK_EXTENSION_FIELD,
} from "@flock/protocol/nsids";
import { clearModEjectionEligibilitySync } from "./moderation";
import {
  lexDataToPlainJson as lexToJson,
  plainJsonToLexData as jsonToLex,
  sha256HexBytes,
  type GroupHostCryptoBox,
} from "./crypto-box";
import type { GroupHostDb } from "./db";
import { assertFreshLoginStepUp, revalidateLiveOAuthSessionSync, type AuthenticatedGroupSession } from "./oauth";
import {
  GroupHostHttpError,
  isSupportedPlcRotationDidKey,
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
  type GroupRepoLockManager,
  type LiveGroupGovernanceState,
  type RecoveryAdminRow,
} from "./rbac";
import { nextMonotonicTid, type GroupRepoStore } from "./repo-store";

const DAY_MS = 86_400_000;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function isValidIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && IDEMPOTENCY_KEY_PATTERN.test(value);
}

export function extractBearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const m = /^Bearer\s+([A-Za-z0-9._~-]+)$/.exec(authorization.trim());
  return m?.[1] ?? null;
}

export type VerifiedServiceJwt = {
  iss: string;
  aud: string;
  lxm: string;
  jti: string;
  iat: number;
  exp: number;
  kid?: string;
};

export function parseServiceJwtParts(
  token: string,
): {
  header: { alg: string; typ?: string; kid?: string };
  payload: { iss: string; aud: string; lxm?: string; jti?: string; iat?: number; exp: number };
  signingInput: Buffer;
  sigBytes: Buffer;
} {
  if (typeof token !== "string" || token.length === 0 || token.length > 8192) {
    throw new GroupHostHttpError(401, "InvalidToken", "Malformed Bearer JWT.");
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new GroupHostHttpError(401, "InvalidToken", "Malformed Bearer JWT.");
  }
  const [hB64, pB64, sB64] = parts as [string, string, string];
  if (!hB64 || !pB64 || !sB64) {
    throw new GroupHostHttpError(401, "InvalidToken", "Malformed Bearer JWT.");
  }
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(hB64, "base64url").toString("utf8")) as Record<string, unknown>;
    payload = JSON.parse(Buffer.from(pB64, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new GroupHostHttpError(401, "InvalidToken", "Malformed JWT JSON.");
  }

  if (typeof header.alg !== "string" || (header.alg !== "ES256" && header.alg !== "ES256K")) {
    throw new GroupHostHttpError(401, "InvalidToken", "Unsupported service JWT alg.");
  }
  if (header.typ === "at+jwt" || header.typ === "refresh+jwt" || header.typ === "dpop+jwt") {
    throw new GroupHostHttpError(401, "InvalidToken", `Invalid service JWT typ '${String(header.typ)}'.`);
  }
  if (
    typeof payload.iss !== "string" ||
    typeof payload.aud !== "string" ||
    typeof payload.exp !== "number" ||
    !Number.isFinite(payload.exp) ||
    (payload.iat !== undefined && (typeof payload.iat !== "number" || !Number.isFinite(payload.iat)))
  ) {
    throw new GroupHostHttpError(401, "InvalidToken", "Missing or malformed service JWT claims.");
  }

  return {
    header: {
      alg: header.alg,
      ...(typeof header.typ === "string" ? { typ: header.typ } : {}),
      ...(typeof header.kid === "string" ? { kid: header.kid } : {}),
    },
    payload: {
      iss: payload.iss,
      aud: payload.aud,
      ...(typeof payload.lxm === "string" ? { lxm: payload.lxm } : {}),
      ...(typeof payload.jti === "string" ? { jti: payload.jti } : {}),
      ...(typeof payload.iat === "number" && Number.isFinite(payload.iat) ? { iat: payload.iat } : {}),
      exp: payload.exp,
    },
    signingInput: Buffer.from(`${hB64}.${pB64}`, "utf8"),
    sigBytes: Buffer.from(sB64, "base64url"),
  };
}

export async function verifyPersonalServiceJwt(params: {
  db: GroupHostDb;
  cryptoBox?: GroupHostCryptoBox;
  plc: PlcAndDidResolver;
  authorization: string | undefined;
  groupDid: string;
  expectedLxm: string;
  nowMs?: number;
}): Promise<VerifiedServiceJwt> {
  const nowMs = params.nowMs ?? Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const rawToken = extractBearerToken(params.authorization);
  if (!rawToken) {
    throw new GroupHostHttpError(401, "AuthMissing", "Personal service JWT Bearer authorization required.");
  }

  const parsed = parseServiceJwtParts(rawToken);
  const bareIss = parsed.payload.iss.split("#", 1)[0]!;
  if (!isDid(bareIss)) {
    throw new GroupHostHttpError(401, "InvalidToken", "Service JWT iss must be a valid DID.");
  }
  if (bareIss === params.groupDid) {
    throw new GroupHostHttpError(
      400,
      "CannotTargetGroupSelf",
      `${params.expectedLxm} acts strictly as a personal account, never as the group DID.`,
    );
  }
  if (parsed.payload.lxm !== params.expectedLxm) {
    throw new GroupHostHttpError(401, "InvalidToken", `Service JWT lxm must equal ${params.expectedLxm}.`);
  }
  if (parsed.payload.aud !== params.groupDid && parsed.payload.aud !== `${params.groupDid}#atproto_pds`) {
    throw new GroupHostHttpError(401, "InvalidToken", `Service JWT audience must target ${params.groupDid}.`);
  }
  const iat = parsed.payload.iat;
  if (
    iat === undefined ||
    iat > nowSec + 5 ||
    parsed.payload.exp <= nowSec ||
    parsed.payload.exp <= iat ||
    parsed.payload.exp - iat > 75 ||
    nowSec - iat > 75
  ) {
    throw new GroupHostHttpError(401, "ExpiredToken", "Service JWT is expired or outside the 75s lifetime window.");
  }
  if (!parsed.payload.jti || parsed.payload.jti.length > 256) {
    throw new GroupHostHttpError(401, "InvalidToken", "Service JWT must carry a unique jti.");
  }

  // Always resolve caller `#atproto` key from the live PLC / DID document (never trusting local staged or retired `group_account` keys).
  const signingDidKey = await params.plc.resolveSigningKey(bareIss, "#atproto");

  let validSig = false;
  try {
    validSig = await cryptoVerifySignatureWithKey(signingDidKey, parsed.signingInput, parsed.sigBytes, parsed.header.alg);
  } catch {
    validSig = false;
  }
  if (!validSig) {
    throw new GroupHostHttpError(401, "InvalidSignature", "Service JWT signature verification failed.");
  }

  const jti = parsed.payload.jti;
  const jtiKey = `jwt:${jti}`;
  const jtiExpMs = Math.max(parsed.payload.exp * 1000, nowMs + 80_000);
  const consumeTx = params.db.transaction(() => {
    params.db
      .prepare("DELETE FROM service_jwt_jti WHERE rowid IN (SELECT rowid FROM service_jwt_jti WHERE expires_at <= ? LIMIT 200)")
      .run(nowMs);
    const existing = params.db
      .prepare("SELECT 1 AS ok FROM service_jwt_jti WHERE issuer_did = ? AND jti = ?")
      .get(bareIss, jtiKey);
    if (existing) {
      throw new GroupHostHttpError(401, "ReplayDetected", "Service JWT jti has already been consumed.");
    }
    params.db
      .prepare("INSERT INTO service_jwt_jti (issuer_did, jti, group_did, expires_at) VALUES (?, ?, ?, ?)")
      .run(bareIss, jtiKey, params.groupDid, jtiExpMs);
  });
  consumeTx.immediate();

  return {
    iss: bareIss,
    aud: parsed.payload.aud,
    lxm: parsed.payload.lxm,
    jti,
    iat,
    exp: parsed.payload.exp,
    ...(parsed.header.kid ? { kid: parsed.header.kid } : {}),
  };
}

export class GroupOpenSocialMethods {
  constructor(
    private readonly db: GroupHostDb,
    private readonly cryptoBox: GroupHostCryptoBox,
    private readonly plc: PlcAndDidResolver,
    private readonly locks: GroupRepoLockManager,
    private readonly repoStore: GroupRepoStore,
  ) {}

  private assertActiveGroupNotFrozenSync(groupDid: string, nowMs: number): void {
    reapExpiredPreparedMigrationLease(this.db, groupDid, nowMs);
    if (hasActiveSourceMigrationLease(this.db, groupDid, nowMs)) {
      throw new GroupHostHttpError(409, "MigrationInProgress", "Group is frozen during active migration.");
    }
    const acct = this.db
      .prepare("SELECT activated, takendown FROM group_account WHERE did = ?")
      .get(groupDid) as { activated: number; takendown: number } | undefined;
    if (!acct) {
      throw new GroupHostHttpError(400, "GroupNotFound", "Group not hosted here.");
    }
    if (acct.takendown !== 0 || this.db.prepare("SELECT 1 AS ok FROM group_deletion_journal WHERE group_did = ?").get(groupDid)) {
      throw new GroupHostHttpError(400, "RepoTakendown", "Group is taken down.");
    }
    if (acct.activated !== 1) {
      throw new GroupHostHttpError(400, "RepoDeactivated", "Group is deactivated.");
    }
  }

  private assertJoinOperationQuotaSync(groupDid: string, requesterDid: string, nowMs: number): void {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS cnt FROM join_operation_state WHERE group_did = ? AND requester_did = ? AND expires_at > ?",
      )
      .get(groupDid, requesterDid, nowMs) as { cnt: number };
    if (row.cnt >= 200) {
      throw new GroupHostHttpError(
        429,
        "JoinOperationQuotaExceeded",
        "Unexpired join operation idempotency key quota (200) exceeded for this group.",
      );
    }
  }

  private validateInviteForCallerSync(params: {
    groupDid: string;
    callerDid: string;
    inviteUri: string;
    nowMs: number;
  }): { inviteSpaceUri: string; rkey: string; inviteRecordUri: string } {
    const parsed = parseAnySpaceRecordUri(params.inviteUri);
    const expectedInviteSpace = personalInboxUri(params.callerDid);
    if (
      !parsed ||
      parsed.authorityDid !== params.callerDid ||
      parsed.spaceType !== ATGRP_SPACE_TYPE.inbox ||
      parsed.skey !== "self" ||
      parsed.spaceUri !== expectedInviteSpace ||
      parsed.repoDid !== params.groupDid ||
      parsed.collection !== ATGRP_COLLECTION.invite ||
      !isTid(parsed.rkey) ||
      params.inviteUri !== `${expectedInviteSpace}/${params.groupDid}/${ATGRP_COLLECTION.invite}/${parsed.rkey}`
    ) {
      throw new GroupHostHttpError(400, "InvalidInvite", "Invite URI is malformed or does not target caller.");
    }

    const row = this.db
      .prepare(
        "SELECT value FROM space_record WHERE space_uri = ? AND repo_did = ? AND collection = ? AND rkey = ?",
      )
      .get(expectedInviteSpace, params.groupDid, ATGRP_COLLECTION.invite, parsed.rkey) as
      | { value: string }
      | undefined;
    if (!row) {
      throw new GroupHostHttpError(400, "InvalidInvite", "Invite not found or already redeemed/revoked.");
    }

    const parsedValue = JSON.parse(row.value) as { group?: string; expiresAt?: string };
    if (parsedValue.group && parsedValue.group !== params.groupDid) {
      throw new GroupHostHttpError(400, "InvalidInvite", "Invite group mismatch.");
    }
    if (parsedValue.expiresAt !== undefined) {
      const expMs = Date.parse(parsedValue.expiresAt);
      if (!Number.isFinite(expMs) || expMs <= params.nowMs) {
        throw new GroupHostHttpError(400, "InvalidInvite", "Invite has expired.");
      }
    }

    return {
      inviteSpaceUri: expectedInviteSpace,
      rkey: parsed.rkey,
      inviteRecordUri: params.inviteUri,
    };
  }

  private redeemInviteSync(params: {
    groupDid: string;
    callerDid: string;
    inviteSpaceUri: string;
    rkey: string;
    inviteRecordUri: string;
    nowMs: number;
  }): void {
    const applied = this.repoStore.applySpaceRepoMutationsSync({
      groupDid: params.groupDid,
      spaceUri: params.inviteSpaceUri,
      repoDid: params.groupDid,
      ops: [
        {
          action: "delete",
          collection: ATGRP_COLLECTION.invite,
          rkey: params.rkey,
        },
      ],
      isOwnAuthoritySpace: false,
      nowMs: params.nowMs,
    });
    this.db
      .prepare("DELETE FROM invite_delivery WHERE group_did = ? AND invite_uri = ?")
      .run(params.groupDid, params.inviteRecordUri);
    this.repoStore.upsertOutboxNoticeSync({
      kind: "invite_repo_update",
      groupDid: params.groupDid,
      coalesceKey: `invite\u0000${params.groupDid}\u0000${params.inviteSpaceUri}`,
      endpoint: params.callerDid,
      spaceUri: params.inviteSpaceUri,
      writerDid: params.callerDid,
      payload: {
        space: params.inviteSpaceUri,
        repo: params.groupDid,
        repoRev: applied.rev,
        data: lexToJson(applied.digest),
      },
      maxAttempts: 5,
      nowMs: params.nowMs,
      expiresAt: params.nowMs + 60_000,
    });
  }

  /**
   * Complete 6-case `group.opensocial.requestJoin` decision table (with and without `Idempotency-Key`).
   */
  async executeRequestJoin(params: {
    callerDid: string;
    groupDid: string;
    invite?: string;
    message?: string;
    idempotencyKey?: string;
    nowMs?: number;
  }): Promise<Record<string, unknown>> {
    const nowMs = params.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();

    if (params.callerDid === params.groupDid) {
      throw new GroupHostHttpError(400, "CannotTargetGroupSelf", "Group DID cannot join itself.");
    }
    if (params.idempotencyKey !== undefined && !isValidIdempotencyKey(params.idempotencyKey)) {
      throw new GroupHostHttpError(400, "InvalidIdempotencyKey", "Idempotency-Key must be 1..128 [A-Za-z0-9._:-] characters.");
    }
    const operationId = params.idempotencyKey;
    const requestHash =
      operationId !== undefined
        ? sha256HexBytes(
            canonicalJson({
              group: params.groupDid,
              invite: params.invite ?? null,
              message: params.message ?? null,
            }),
          )
        : null;

    const lockDids = [params.groupDid];
    if (this.db.prepare("SELECT 1 AS ok FROM group_account WHERE did = ?").get(params.callerDid)) {
      lockDids.push(params.callerDid);
    }

    return this.locks.withSortedGroupRepoLocks(lockDids, async () => {
      // Pre-compute candidate default-role membership CBOR under lock so synchronous `IMMEDIATE` tx needs zero awaits!
      const membersSpace = groupMembersUri(params.groupDid);
      const preState = loadLiveGovernanceState(this.db, params.groupDid);
      const defaultRoles = [...preState.roles.entries()]
        .filter(([, r]) => r.default === true)
        .map(([rkey]) => rkey);

      let preSerializedMembership:
        | {
            value: Record<string, unknown>;
            cborBytes: Uint8Array;
            cidStr: string;
            incarnation: string;
          }
        | undefined;

      if (defaultRoles.length > 0 && !preState.memberships.has(params.callerDid)) {
        const writerMeta = this.db
          .prepare(
            "SELECT last_evicted_repo_rev, prior_eject_count FROM space_writer WHERE space_uri = ? AND writer_did = ?",
          )
          .get(membersSpace, params.callerDid) as
          | { last_evicted_repo_rev: string | null; prior_eject_count: number }
          | undefined;
        const curSpace = this.db
          .prepare("SELECT space_rev FROM group_space WHERE space_uri = ?")
          .get(membersSpace) as { space_rev: string } | undefined;
        const predictedMembersSpaceRev = nextMonotonicTid(curSpace?.space_rev ?? null);
        const freshInc = randomUUID();
        const memVal: Record<string, unknown> = {
          $type: ATGRP_COLLECTION.membership,
          roles: defaultRoles,
          createdAt: nowIso,
          [FLOCK_EXTENSION_FIELD.incarnation]: freshInc,
          [FLOCK_EXTENSION_FIELD.generation]: (writerMeta?.prior_eject_count ?? 0) + 1,
          [FLOCK_EXTENSION_FIELD.admittedSpaceRev]: predictedMembersSpaceRev,
          [FLOCK_EXTENSION_FIELD.afterWriterRev]: writerMeta?.last_evicted_repo_rev ?? null,
        };
        const serialized = await serializeRecord(
          ATGRP_COLLECTION.membership as NsidString,
          params.callerDid as RecordKeyString,
          jsonToLex(memVal) as LexMap,
        );
        preSerializedMembership = {
          value: memVal,
          cborBytes: serialized.bytes,
          cidStr: serialized.cid.toString(),
          incarnation: freshInc,
        };
      }

      const tx = this.db.transaction(() => {
        this.assertActiveGroupNotFrozenSync(params.groupDid, nowMs);

        // Step 0: Reject known app service principals (active OR uninstalled)!
        const isKnownApp = this.db
          .prepare("SELECT 1 AS ok FROM known_app_subject WHERE group_did = ? AND subject_did = ?")
          .get(params.groupDid, params.callerDid);
        if (isKnownApp) {
          throw new GroupHostHttpError(
            400,
            "SubjectIsAppServicePrincipal",
            "App service principals cannot request or hold human group membership.",
          );
        }

        // Step 1: Prune ONLY expired rows from join_request & join_operation_state
        this.db.prepare("DELETE FROM join_request WHERE group_did = ? AND expires_at <= ?").run(params.groupDid, nowMs);
        this.db.prepare("DELETE FROM join_operation_state WHERE group_did = ? AND expires_at <= ?").run(params.groupDid, nowMs);

        const existingMembership = this.db
          .prepare(
            "SELECT uri, cid FROM space_record WHERE space_uri = ? AND repo_did = ? AND collection = ? AND rkey = ?",
          )
          .get(membersSpace, params.groupDid, ATGRP_COLLECTION.membership, params.callerDid) as
          | { uri: string; cid: string }
          | undefined;

        // Step 2: Existing operationId replay check
        if (operationId !== undefined && requestHash !== null) {
          const storedOp = this.db
            .prepare(
              "SELECT request_hash, state, response_json FROM join_operation_state WHERE group_did = ? AND requester_did = ? AND operation_id = ?",
            )
            .get(params.groupDid, params.callerDid, operationId) as
            | { request_hash: string; state: "pending" | "admitted" | "denied" | "cancelled"; response_json: string }
            | undefined;

          if (storedOp) {
            if (storedOp.request_hash !== requestHash) {
              throw new GroupHostHttpError(
                409,
                "IdempotencyParameterMismatch",
                "Idempotency-Key reused with different request parameters.",
              );
            }
            if (storedOp.state === "pending" && existingMembership) {
              const upgradedResp = {
                status: "admitted",
                membership: { uri: existingMembership.uri, cid: existingMembership.cid },
              };
              this.db
                .prepare(
                  `UPDATE join_operation_state
                   SET state = 'admitted', response_json = ?, updated_at = ?
                   WHERE group_did = ? AND requester_did = ? AND operation_id = ?`,
                )
                .run(JSON.stringify(upgradedResp), nowMs, params.groupDid, params.callerDid, operationId);
              return upgradedResp;
            }
            if (storedOp.state === "admitted") {
              if (existingMembership) {
                return JSON.parse(storedOp.response_json) as Record<string, unknown>;
              }
              throw new GroupHostHttpError(400, "JoinRequestClosed", "Prior admitted membership was subsequently removed.");
            }
            if (storedOp.state === "pending") {
              return JSON.parse(storedOp.response_json) as Record<string, unknown>;
            }
            throw new GroupHostHttpError(400, "JoinRequestClosed", `Join operation already ${storedOp.state}.`);
          }
        }

        const insertOperationStateIfPresent = (
          state: "pending" | "admitted",
          respObj: Record<string, unknown>,
          expiresAt: number,
        ) => {
          if (operationId === undefined || requestHash === null) return;
          this.db
            .prepare(
              `INSERT INTO join_operation_state (
                 group_did, requester_did, operation_id, request_hash, state, response_json, expires_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              params.groupDid,
              params.callerDid,
              operationId,
              requestHash,
              state,
              JSON.stringify(respObj),
              expiresAt,
              nowMs,
            );
        };

        // Case A: Already a human member
        if (existingMembership) {
          let validatedInvite: ReturnType<GroupOpenSocialMethods["validateInviteForCallerSync"]> | undefined;
          if (params.invite !== undefined) {
            validatedInvite = this.validateInviteForCallerSync({
              groupDid: params.groupDid,
              callerDid: params.callerDid,
              inviteUri: params.invite,
              nowMs,
            });
          }
          if (operationId !== undefined) {
            this.assertJoinOperationQuotaSync(params.groupDid, params.callerDid, nowMs);
          }
          if (validatedInvite) {
            this.redeemInviteSync({
              groupDid: params.groupDid,
              callerDid: params.callerDid,
              ...validatedInvite,
              nowMs,
            });
          }
          this.db
            .prepare("DELETE FROM join_request WHERE group_did = ? AND requester_did = ?")
            .run(params.groupDid, params.callerDid);
          const finalResp = {
            status: "admitted",
            membership: { uri: existingMembership.uri, cid: existingMembership.cid },
          };
          insertOperationStateIfPresent("admitted", finalResp, nowMs + 30 * DAY_MS);
          return finalResp;
        }

        // Case B: Not yet a member, `invite !== undefined`
        if (params.invite !== undefined) {
          const validatedInvite = this.validateInviteForCallerSync({
            groupDid: params.groupDid,
            callerDid: params.callerDid,
            inviteUri: params.invite,
            nowMs,
          });
          if (defaultRoles.length === 0 || !preSerializedMembership) {
            throw new GroupHostHttpError(400, "NoDefaultRole", "Group has no default role configured for admission.");
          }
          if (operationId !== undefined) {
            this.assertJoinOperationQuotaSync(params.groupDid, params.callerDid, nowMs);
          }

          const appliedMem = this.repoStore.applySpaceRepoMutationsSync({
            groupDid: params.groupDid,
            spaceUri: membersSpace,
            repoDid: params.groupDid,
            ops: [
              {
                action: "create",
                collection: ATGRP_COLLECTION.membership,
                rkey: params.callerDid,
                value: preSerializedMembership.value,
                cborBytes: preSerializedMembership.cborBytes,
                cidStr: preSerializedMembership.cidStr,
                incarnation: preSerializedMembership.incarnation,
              },
            ],
            isOwnAuthoritySpace: true,
            nowMs,
          });
          clearModEjectionEligibilitySync(this.db, params.groupDid, params.callerDid);
          const memRef = appliedMem.results[0]!;
          const finalResp = {
            status: "admitted",
            membership: { uri: memRef.uri, cid: memRef.cid! },
          };

          this.redeemInviteSync({
            groupDid: params.groupDid,
            callerDid: params.callerDid,
            ...validatedInvite,
            nowMs,
          });
          this.db
            .prepare("DELETE FROM join_request WHERE group_did = ? AND requester_did = ?")
            .run(params.groupDid, params.callerDid);
          this.db
            .prepare(
              `UPDATE join_operation_state
               SET state = 'admitted', response_json = ?, updated_at = ?
               WHERE group_did = ? AND requester_did = ? AND state = 'pending'`,
            )
            .run(JSON.stringify(finalResp), nowMs, params.groupDid, params.callerDid);
          insertOperationStateIfPresent("admitted", finalResp, nowMs + 30 * DAY_MS);
          return finalResp;
        }

        // Read `org.atgrp.config/self` in `meta/self` to determine `joinPolicy`
        const metaSpace = groupMetaUri(params.groupDid);
        const configRow = this.db
          .prepare(
            "SELECT value FROM space_record WHERE space_uri = ? AND repo_did = ? AND collection = ? AND rkey = 'self'",
          )
          .get(metaSpace, params.groupDid, ATGRP_COLLECTION.config) as { value: string } | undefined;
        const config = configRow ? (JSON.parse(configRow.value) as { joinPolicy?: string }) : {};
        const joinPolicy = config.joinPolicy;

        // Case C: `joinPolicy === "open"`
        if (joinPolicy === "open") {
          if (defaultRoles.length === 0 || !preSerializedMembership) {
            throw new GroupHostHttpError(400, "NoDefaultRole", "Group has no default role configured for admission.");
          }
          if (operationId !== undefined) {
            this.assertJoinOperationQuotaSync(params.groupDid, params.callerDid, nowMs);
          }
          const appliedMem = this.repoStore.applySpaceRepoMutationsSync({
            groupDid: params.groupDid,
            spaceUri: membersSpace,
            repoDid: params.groupDid,
            ops: [
              {
                action: "create",
                collection: ATGRP_COLLECTION.membership,
                rkey: params.callerDid,
                value: preSerializedMembership.value,
                cborBytes: preSerializedMembership.cborBytes,
                cidStr: preSerializedMembership.cidStr,
                incarnation: preSerializedMembership.incarnation,
              },
            ],
            isOwnAuthoritySpace: true,
            nowMs,
          });
          clearModEjectionEligibilitySync(this.db, params.groupDid, params.callerDid);
          const memRef = appliedMem.results[0]!;
          const finalResp = {
            status: "admitted",
            membership: { uri: memRef.uri, cid: memRef.cid! },
          };
          this.db
            .prepare("DELETE FROM join_request WHERE group_did = ? AND requester_did = ?")
            .run(params.groupDid, params.callerDid);
          this.db
            .prepare(
              `UPDATE join_operation_state
               SET state = 'admitted', response_json = ?, updated_at = ?
               WHERE group_did = ? AND requester_did = ? AND state = 'pending'`,
            )
            .run(JSON.stringify(finalResp), nowMs, params.groupDid, params.callerDid);
          insertOperationStateIfPresent("admitted", finalResp, nowMs + 30 * DAY_MS);
          return finalResp;
        }

        // Case D: `(joinPolicy ?? "invite") === "invite"`
        if (joinPolicy === undefined || joinPolicy === "invite") {
          throw new GroupHostHttpError(400, "JoinClosed", "The group is invite-only.");
        }

        // Case E: `joinPolicy === "approval"`
        if (joinPolicy === "approval") {
          if (operationId !== undefined) {
            this.assertJoinOperationQuotaSync(params.groupDid, params.callerDid, nowMs);
          }
          const existingReq = this.db
            .prepare(
              "SELECT message, created_at, expires_at FROM join_request WHERE group_did = ? AND requester_did = ?",
            )
            .get(params.groupDid, params.callerDid) as
            | { message: string | null; created_at: string; expires_at: number }
            | undefined;

          if (!existingReq) {
            const expiresAt = nowMs + 30 * DAY_MS;
            const pendingResp = {
              status: "pending",
              request: {
                member: params.callerDid,
                createdAt: nowIso,
                ...(params.message !== undefined && params.message !== "" ? { message: params.message } : {}),
              },
            };
            this.db
              .prepare(
                `INSERT INTO join_request (group_did, requester_did, message, created_at, expires_at)
                 VALUES (?, ?, ?, ?, ?)`,
              )
              .run(
                params.groupDid,
                params.callerDid,
                params.message !== undefined && params.message !== "" ? params.message : null,
                nowIso,
                expiresAt,
              );
            insertOperationStateIfPresent("pending", pendingResp, expiresAt);
            return pendingResp;
          }

          const existingResp = {
            status: "pending",
            request: {
              member: params.callerDid,
              createdAt: existingReq.created_at,
              ...(existingReq.message !== null ? { message: existingReq.message } : {}),
            },
          };
          insertOperationStateIfPresent("pending", existingResp, existingReq.expires_at);
          return existingResp;
        }

        // Case F: Fail-closed unknown `joinPolicy`
        throw new GroupHostHttpError(400, "JoinClosed", `Unsupported joinPolicy '${joinPolicy}'.`);
      });

      return tx.immediate();
    });
  }

  async executeCancelJoinRequest(params: {
    callerDid: string;
    groupDid: string;
    nowMs?: number;
  }): Promise<void> {
    const nowMs = params.nowMs ?? Date.now();
    if (params.callerDid === params.groupDid) {
      throw new GroupHostHttpError(400, "CannotTargetGroupSelf", "Group DID cannot cancel a join request.");
    }
    return this.locks.withGroupRepoLock(params.groupDid, () => {
      const tx = this.db.transaction(() => {
        this.assertActiveGroupNotFrozenSync(params.groupDid, nowMs);
        this.db.prepare("DELETE FROM join_request WHERE group_did = ? AND expires_at <= ?").run(params.groupDid, nowMs);
        this.db.prepare("DELETE FROM join_operation_state WHERE group_did = ? AND expires_at <= ?").run(params.groupDid, nowMs);

        const del = this.db
          .prepare("DELETE FROM join_request WHERE group_did = ? AND requester_did = ?")
          .run(params.groupDid, params.callerDid);
        if (del.changes === 0) {
          throw new GroupHostHttpError(400, "JoinRequestNotFound", "No pending join request found for caller.");
        }
        this.db
          .prepare(
            `UPDATE join_operation_state
             SET state = 'cancelled', updated_at = ?
             WHERE group_did = ? AND requester_did = ? AND state = 'pending'`,
          )
          .run(nowMs, params.groupDid, params.callerDid);
      });
      tx.immediate();
    });
  }

  async executeDenyJoinRequest(params: {
    groupDid: string;
    memberDid: string;
    session?: AuthenticatedGroupSession;
    nowMs?: number;
  }): Promise<void> {
    const nowMs = params.nowMs ?? Date.now();
    if (params.memberDid === params.groupDid) {
      throw new GroupHostHttpError(400, "CannotTargetGroupSelf", "Cannot target group self DID.");
    }
    return this.locks.withGroupRepoLock(params.groupDid, () => {
      const tx = this.db.transaction(() => {
        this.assertActiveGroupNotFrozenSync(params.groupDid, nowMs);
        if (params.session) {
          const { permissions: commitPerms } = revalidateLiveOAuthSessionSync(this.db, params.session, { nowMs });
          commitPerms.assertRpc({
            aud: `${params.groupDid}#atproto_pds` as `${DidString}#${string}`,
            lxm: ATGRP_METHOD.denyJoinRequest as NsidString,
          });
        }
        this.db.prepare("DELETE FROM join_request WHERE group_did = ? AND expires_at <= ?").run(params.groupDid, nowMs);
        this.db.prepare("DELETE FROM join_operation_state WHERE group_did = ? AND expires_at <= ?").run(params.groupDid, nowMs);

        const del = this.db
          .prepare("DELETE FROM join_request WHERE group_did = ? AND requester_did = ?")
          .run(params.groupDid, params.memberDid);
        if (del.changes === 0) {
          throw new GroupHostHttpError(400, "JoinRequestNotFound", `No pending join request for ${params.memberDid}.`);
        }
        this.db
          .prepare(
            `UPDATE join_operation_state
             SET state = 'denied', updated_at = ?
             WHERE group_did = ? AND requester_did = ? AND state = 'pending'`,
          )
          .run(nowMs, params.groupDid, params.memberDid);
      });
      tx.immediate();
    });
  }

  executeListJoinRequests(params: {
    groupDid: string;
    limit?: number;
    cursor?: string;
    nowMs?: number;
  }): {
    requests: Array<{ member: string; createdAt: string; message?: string }>;
    cursor?: string;
  } {
    const nowMs = params.nowMs ?? Date.now();
    if (
      params.limit !== undefined &&
      (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 100)
    ) {
      throw new GroupHostHttpError(400, "InvalidRequest", "limit must be an integer between 1 and 100.");
    }
    this.db.prepare("DELETE FROM join_request WHERE group_did = ? AND expires_at <= ?").run(params.groupDid, nowMs);

    const limit = params.limit ?? 50;
    let cursorDecoded: { createdAt: string; member: string } | null = null;
    if (params.cursor !== undefined) {
      try {
        const raw = JSON.parse(Buffer.from(params.cursor, "base64url").toString("utf8")) as Record<string, unknown>;
        if (typeof raw?.createdAt !== "string" || typeof raw?.member !== "string" || !isDid(raw.member)) {
          throw new Error("bad cursor");
        }
        cursorDecoded = { createdAt: raw.createdAt, member: raw.member };
      } catch {
        throw new GroupHostHttpError(400, "InvalidCursor", "Malformed listJoinRequests cursor.");
      }
    }

    const rows = cursorDecoded
      ? (this.db
          .prepare(
            `SELECT requester_did, message, created_at
             FROM join_request
             WHERE group_did = ?
               AND (created_at > ? OR (created_at = ? AND requester_did > ?))
             ORDER BY created_at ASC, requester_did ASC
             LIMIT ?`,
          )
          .all(
            params.groupDid,
            cursorDecoded.createdAt,
            cursorDecoded.createdAt,
            cursorDecoded.member,
            limit + 1,
          ) as Array<{ requester_did: string; message: string | null; created_at: string }>)
      : (this.db
          .prepare(
            `SELECT requester_did, message, created_at
             FROM join_request
             WHERE group_did = ?
             ORDER BY created_at ASC, requester_did ASC
             LIMIT ?`,
          )
          .all(params.groupDid, limit + 1) as Array<{ requester_did: string; message: string | null; created_at: string }>);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    const nextCursor =
      hasMore && last
        ? Buffer.from(
            JSON.stringify({ createdAt: last.created_at, member: last.requester_did }),
            "utf8",
          ).toString("base64url")
        : undefined;

    return {
      requests: page.map((r) => ({
        member: r.requester_did,
        createdAt: r.created_at,
        ...(r.message !== null ? { message: r.message } : {}),
      })),
      ...(nextCursor ? { cursor: nextCursor } : {}),
    };
  }

  /**
   * `group.opensocial.leaveGroup` with `If-Match-Membership-Incarnation` CAS and Flock-scoped
   * sole-member reversible deactivation vs non-Flock sovereign zero-human continuation!
   */
  async executeLeaveGroup(params: {
    callerDid: string;
    groupDid: string;
    ifMatchIncarnation?: string;
    nowMs?: number;
  }): Promise<void> {
    const nowMs = params.nowMs ?? Date.now();
    if (params.callerDid === params.groupDid) {
      throw new GroupHostHttpError(400, "CannotTargetGroupSelf", "Group DID cannot leave itself.");
    }

    return this.locks.withGroupRepoLock(params.groupDid, async () => {
      const acct = this.db
        .prepare("SELECT activated, takendown FROM group_account WHERE did = ?")
        .get(params.groupDid) as { activated: number; takendown: number } | undefined;
      if (!acct) {
        throw new GroupHostHttpError(400, "GroupNotFound", "Group not hosted here.");
      }
      if (acct.takendown !== 0 || this.db.prepare("SELECT 1 AS ok FROM group_deletion_journal WHERE group_did = ?").get(params.groupDid)) {
        throw new GroupHostHttpError(400, "RepoTakendown", "Group is taken down.");
      }

      // Idempotent sole-member deactivation replay: if activated === 0 && recovery_did === callerDid -> 200 OK `{}`!
      if (acct.activated === 0) {
        const recRow = this.db
          .prepare("SELECT recovery_did FROM group_recovery_admin WHERE group_did = ?")
          .get(params.groupDid) as { recovery_did: string } | undefined;
        if (recRow?.recovery_did === params.callerDid) {
          return;
        }
        throw new GroupHostHttpError(400, "RepoDeactivated", "Group is deactivated.");
      }

      const preCheckState = loadLiveGovernanceState(this.db, params.groupDid);
      let externalSovKeyPresent = false;
      if (!preCheckState.hasFlockWorkspace && preCheckState.memberships.has(params.callerDid)) {
        const humans = humanMemberships(preCheckState, params.groupDid);
        if (humans.size === 1 && humans.has(params.callerDid)) {
          const localRot = await this.repoStore.getGroupRotationKey(params.groupDid);
          const lastOp = await this.plc.getPlcLastOp(params.groupDid);
          const rotKeys = plcOpRotationKeys(lastOp);
          externalSovKeyPresent =
            localRot !== null &&
            rotKeys.some((k) => k !== localRot.did() && isSupportedPlcRotationDidKey(k));
        }
      }

      const tx = this.db.transaction(() => {
        reapExpiredPreparedMigrationLease(this.db, params.groupDid, nowMs);
        if (hasActiveSourceMigrationLease(this.db, params.groupDid, nowMs)) {
          throw new GroupHostHttpError(409, "MigrationInProgress", "Group is frozen during active migration.");
        }

        const membersSpace = groupMembersUri(params.groupDid);
        const memRow = this.db
          .prepare(
            "SELECT value, incarnation FROM space_record WHERE space_uri = ? AND repo_did = ? AND collection = ? AND rkey = ?",
          )
          .get(membersSpace, params.groupDid, ATGRP_COLLECTION.membership, params.callerDid) as
          | { value: string; incarnation: string | null }
          | undefined;

        if (!memRow) {
          // Already absent -> idempotent no-op
          return;
        }

        if (params.ifMatchIncarnation !== undefined && memRow.incarnation !== params.ifMatchIncarnation) {
          throw new GroupHostHttpError(
            409,
            "MembershipIncarnationMismatch",
            `Expected membership incarnation '${params.ifMatchIncarnation}', found '${memRow.incarnation ?? "null"}'.`,
          );
        }

        const preState = loadLiveGovernanceState(this.db, params.groupDid);
        if (preState.knownAppSubjects.has(params.callerDid)) {
          throw new GroupHostHttpError(400, "SubjectIsAppServicePrincipal", "App service principals cannot call leaveGroup.");
        }

        const callerMem = preState.memberships.get(params.callerDid)!;
        const postMemberships = new Map(preState.memberships);
        postMemberships.delete(params.callerDid);
        const postState: LiveGroupGovernanceState = {
          ...preState,
          memberships: postMemberships,
        };

        const preHumans = humanMemberships(preState, params.groupDid);
        const isSoleMember =
          preHumans.size === 1 &&
          preState.memberships.size === 1 &&
          preHumans.has(params.callerDid);

        if (preState.hasFlockWorkspace) {
          assertPostGovernanceInvariants(preState, postState, params.groupDid, {
            allowSoleMemberDeactivation: isSoleMember,
          });
        } else if (humanMemberships(postState, params.groupDid).size === 0 && !externalSovKeyPresent) {
          throw new GroupHostHttpError(
            400,
            "NoSovereignCustodyKey",
            "Cannot leave as the last human member of a non-Flock group without an external sovereign PLC rotation key.",
          );
        }

        // Delete `membership/<callerDid>` and evict caller from all space writer sets
        this.repoStore.applySpaceRepoMutationsSync({
          groupDid: params.groupDid,
          spaceUri: membersSpace,
          repoDid: params.groupDid,
          ops: [
            {
              action: "delete",
              collection: ATGRP_COLLECTION.membership,
              rkey: params.callerDid,
            },
          ],
          isOwnAuthoritySpace: true,
          suppressNotices: isSoleMember && preState.hasFlockWorkspace,
          nowMs,
        });
        if (isSoleMember && preState.hasFlockWorkspace) {
          // Revoke & enqueue `[100, ...]` `notifyCredentialsRevoked` notices BEFORE `reconcileAllSpaceWritersSync`
          // (`suppressNotices: true`), which deletes remaining `issued_credential` rows!
          this.repoStore.revokeIssuedCredentialsSync({
            groupDid: params.groupDid,
            enqueueNotices: true,
            nowMs,
          });
        }
        this.repoStore.reconcileAllSpaceWritersSync(
          params.groupDid,
          postState,
          nowMs,
          isSoleMember && preState.hasFlockWorkspace,
        );

        // Sole-member Flock workspace reversible deactivation!
        if (isSoleMember && preState.hasFlockWorkspace) {
          this.db
            .prepare(
              `INSERT INTO group_recovery_admin (group_did, recovery_did, roles_json, deactivated_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(group_did) DO UPDATE SET
                 recovery_did = excluded.recovery_did,
                 roles_json = excluded.roles_json,
                 deactivated_at = excluded.deactivated_at`,
            )
            .run(params.groupDid, params.callerDid, JSON.stringify(callerMem.roles), nowMs);

          this.db
            .prepare(
              "UPDATE group_account SET auth_epoch = auth_epoch + 1, activated = 0, deactivated_at = ? WHERE did = ?",
            )
            .run(nowMs, params.groupDid);

          const famRows = this.db
            .prepare("SELECT DISTINCT family_id, expires_at FROM oauth_session WHERE group_did = ?")
            .all(params.groupDid) as Array<{ family_id: string; expires_at: number }>;
          const insRevFam = this.db.prepare(
            "INSERT OR REPLACE INTO revoked_oauth_family (family_id, group_did, expires_at, revoked_at) VALUES (?, ?, ?, ?)",
          );
          for (const f of famRows) {
            insRevFam.run(f.family_id, params.groupDid, f.expires_at, nowMs);
          }

          this.db.prepare("DELETE FROM migration_session WHERE group_did = ?").run(params.groupDid);
          this.db.prepare("DELETE FROM revoked_migration_jti WHERE group_did = ?").run(params.groupDid);
          this.db.prepare("DELETE FROM oauth_par WHERE group_did = ?").run(params.groupDid);
          this.db.prepare("DELETE FROM oauth_consent_snapshot WHERE group_did = ?").run(params.groupDid);
          this.db.prepare("DELETE FROM upstream_oauth_state WHERE group_did = ?").run(params.groupDid);
          this.db.prepare("DELETE FROM oauth_code WHERE group_did = ?").run(params.groupDid);
          this.db.prepare("DELETE FROM oauth_refresh_token WHERE group_did = ?").run(params.groupDid);
          this.db.prepare("DELETE FROM oauth_session WHERE group_did = ?").run(params.groupDid);

          this.repoStore.revokeIssuedCredentialsSync({
            groupDid: params.groupDid,
            enqueueNotices: true,
            nowMs,
          });
        }
      });

      tx.immediate();
    });
  }

  /**
   * `GET /group-member/join-status?group=<DidString>&operationId=<optional>`
   */
  executeGetJoinStatus(params: {
    callerDid: string;
    groupDid: string;
    operationId?: string;
    nowMs?: number;
  }): Record<string, unknown> {
    const nowMs = params.nowMs ?? Date.now();
    if (params.callerDid === params.groupDid) {
      throw new GroupHostHttpError(400, "CannotTargetGroupSelf", "Group DID cannot query personal join-status.");
    }
    if (params.operationId !== undefined && !isValidIdempotencyKey(params.operationId)) {
      throw new GroupHostHttpError(400, "InvalidIdempotencyKey", "operationId must be 1..128 [A-Za-z0-9._:-] characters.");
    }

    const migRow = this.db
      .prepare("SELECT status FROM source_migration_lease WHERE group_did = ?")
      .get(params.groupDid) as { status: string } | undefined;
    if (migRow?.status === "plc_signed") {
      throw new GroupHostHttpError(409, "MigrationCutoverPending", "Group cutover pending.");
    }

    const acct = this.db
      .prepare("SELECT activated, takendown FROM group_account WHERE did = ?")
      .get(params.groupDid) as { activated: number; takendown: number } | undefined;
    if (!acct) {
      throw new GroupHostHttpError(400, "GroupNotFound", "Group not hosted here.");
    }
    if (acct.takendown !== 0 || this.db.prepare("SELECT 1 AS ok FROM group_deletion_journal WHERE group_did = ?").get(params.groupDid)) {
      throw new GroupHostHttpError(400, "RepoTakendown", "Group is taken down.");
    }

    if (acct.activated === 0) {
      const recRow = this.db
        .prepare("SELECT recovery_did FROM group_recovery_admin WHERE group_did = ?")
        .get(params.groupDid) as { recovery_did: string } | undefined;
      if (recRow?.recovery_did === params.callerDid) {
        return { state: "left_deactivated" };
      }
      throw new GroupHostHttpError(400, "RepoDeactivated", "Group is deactivated.");
    }

    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM join_request WHERE group_did = ? AND expires_at <= ?").run(params.groupDid, nowMs);
      this.db.prepare("DELETE FROM join_operation_state WHERE group_did = ? AND expires_at <= ?").run(params.groupDid, nowMs);

      const isKnownApp = this.db
        .prepare("SELECT 1 AS ok FROM known_app_subject WHERE group_did = ? AND subject_did = ?")
        .get(params.groupDid, params.callerDid);

      if (!isKnownApp) {
        const membersSpace = groupMembersUri(params.groupDid);
        const memRow = this.db
          .prepare(
            "SELECT uri, cid, incarnation FROM space_record WHERE space_uri = ? AND repo_did = ? AND collection = ? AND rkey = ?",
          )
          .get(membersSpace, params.groupDid, ATGRP_COLLECTION.membership, params.callerDid) as
          | { uri: string; cid: string; incarnation: string | null }
          | undefined;

        // Check durable `membership/<callerDid>` FIRST before `join_operation_state`!
        if (memRow) {
          return {
            state: "admitted",
            currentIncarnation: memRow.incarnation,
            membership: { uri: memRow.uri, cid: memRow.cid },
          };
        }
      }

      if (params.operationId !== undefined) {
        const opRow = this.db
          .prepare(
            "SELECT state FROM join_operation_state WHERE group_did = ? AND requester_did = ? AND operation_id = ?",
          )
          .get(params.groupDid, params.callerDid, params.operationId) as
          | { state: "pending" | "admitted" | "denied" | "cancelled" }
          | undefined;
        if (!opRow) {
          return { state: "unknown" };
        }
        if (opRow.state === "admitted") {
          // Stale `"admitted"` row whose membership was subsequently ejected maps to `"denied"`
          return { state: "denied" };
        }
        return { state: opRow.state };
      }

      const pendingReq = this.db
        .prepare("SELECT 1 AS ok FROM join_request WHERE group_did = ? AND requester_did = ?")
        .get(params.groupDid, params.callerDid);
      return { state: pendingReq ? "pending" : "unknown" };
    });

    return tx.immediate();
  }

  executeListInviteDeliveries(groupDid: string): {
    deliveries: Array<{
      inviteUri: string;
      spaceUri: string;
      inviteeDid: string;
      rkey: string;
      repoRev: string;
      status: "pending" | "delivered" | "failed";
      attempts: number;
      lastError?: string;
      createdAt: string;
      updatedAt: string;
    }>;
  } {
    const rows = this.db
      .prepare(
        `SELECT invite_uri, space_uri, invitee_did, rkey, repo_rev, status, attempts, last_error, created_at, updated_at
         FROM invite_delivery
         WHERE group_did = ?
         ORDER BY updated_at DESC`,
      )
      .all(groupDid) as Array<{
      invite_uri: string;
      space_uri: string;
      invitee_did: string;
      rkey: string;
      repo_rev: string;
      status: "pending" | "delivered" | "failed";
      attempts: number;
      last_error: string | null;
      created_at: number;
      updated_at: number;
    }>;

    return {
      deliveries: rows.map((r) => ({
        inviteUri: r.invite_uri,
        spaceUri: r.space_uri,
        inviteeDid: r.invitee_did,
        rkey: r.rkey,
        repoRev: r.repo_rev,
        status: r.status,
        attempts: r.attempts,
        ...(r.last_error !== null ? { lastError: r.last_error } : {}),
        createdAt: new Date(r.created_at).toISOString(),
        updatedAt: new Date(r.updated_at).toISOString(),
      })),
    };
  }

  async executeRetryInviteDelivery(params: {
    groupDid: string;
    inviteUri: string;
    session?: AuthenticatedGroupSession;
    nowMs?: number;
  }): Promise<{ status: "pending" | "delivered" | "failed"; lastError?: string }> {
    const nowMs = params.nowMs ?? Date.now();
    await this.locks.withGroupRepoLock(params.groupDid, () => {
      const tx = this.db.transaction(() => {
        this.assertActiveGroupNotFrozenSync(params.groupDid, nowMs);
        const deliv = this.db
          .prepare(
            "SELECT space_uri, invitee_did FROM invite_delivery WHERE group_did = ? AND invite_uri = ?",
          )
          .get(params.groupDid, params.inviteUri) as { space_uri: string; invitee_did: string } | undefined;
        if (!deliv) {
          throw new GroupHostHttpError(400, "InviteNotFound", `Invite delivery not found: ${params.inviteUri}`);
        }
        if (params.session) {
          const { permissions: commitPerms } = revalidateLiveOAuthSessionSync(this.db, params.session, { nowMs });
          commitPerms.assertSpace(
            {
              spaceType: ATGRP_SPACE_TYPE.inbox as NsidString,
              authority: deliv.invitee_did as DidString,
              skey: "self" as RecordKeyString,
            },
            { action: "update", collection: ATGRP_COLLECTION.invite as NsidString },
          );
        }
        const repoRow = this.db
          .prepare("SELECT set_hash, rev FROM space_repo WHERE space_uri = ? AND repo_did = ?")
          .get(deliv.space_uri, params.groupDid) as { set_hash: Buffer; rev: string } | undefined;
        if (!repoRow) {
          throw new GroupHostHttpError(400, "InviteNotFound", "Invite repo state missing.");
        }
        const { RepoCommit } = requireRepoCommit();
        const digest = RepoCommit.fromState(new Uint8Array(repoRow.set_hash)).setHash.digest();

        this.db
          .prepare(
            "UPDATE invite_delivery SET status = 'pending', attempts = 0, last_error = NULL, updated_at = ? WHERE group_did = ? AND invite_uri = ?",
          )
          .run(nowMs, params.groupDid, params.inviteUri);

        this.repoStore.upsertOutboxNoticeSync({
          kind: "invite_repo_update",
          groupDid: params.groupDid,
          coalesceKey: `invite\u0000${params.groupDid}\u0000${deliv.space_uri}`,
          endpoint: deliv.invitee_did,
          spaceUri: deliv.space_uri,
          writerDid: deliv.invitee_did,
          payload: {
            space: deliv.space_uri,
            repo: params.groupDid,
            repoRev: repoRow.rev,
            data: lexToJson(digest),
          },
          maxAttempts: 5,
          nowMs,
          expiresAt: nowMs + 60_000,
        });
      });
      tx.immediate();
    });

    await this.repoStore.flushOutboxNotices({ groupDid: params.groupDid, nowMs });
    const updated = this.db
      .prepare("SELECT status, last_error FROM invite_delivery WHERE group_did = ? AND invite_uri = ?")
      .get(params.groupDid, params.inviteUri) as
      | { status: "pending" | "delivered" | "failed"; last_error: string | null }
      | undefined;
    return {
      status: updated?.status ?? "pending",
      ...(updated?.last_error ? { lastError: updated.last_error } : {}),
    };
  }

  async executeClaimActionToken(params: {
    groupDid: string;
    actorDid: string;
    purpose: "plc_operation" | "delete_account";
    session:
      | AuthenticatedGroupSession
      | { sessionKind: "group" | "recovery"; authorizingUserDid: string; authenticatedAt: number; loginStepUpAt?: number | null };
    nowMs?: number;
  }): Promise<{ token: string; expiresAt: string }> {
    return this.locks.withGroupRepoLock(params.groupDid, () => this.executeClaimActionTokenSync(params));
  }

  /**
   * `POST /group-admin/claim-action-token` single-use claim (`claim_ciphertext_enc -> NULL`).
   */
  executeClaimActionTokenSync(params: {
    groupDid: string;
    actorDid: string;
    purpose: "plc_operation" | "delete_account";
    session:
      | AuthenticatedGroupSession
      | { sessionKind: "group" | "recovery"; authorizingUserDid: string; authenticatedAt: number; loginStepUpAt?: number | null };
    nowMs?: number;
  }): { token: string; expiresAt: string } {
    const nowMs = params.nowMs ?? Date.now();
    if (params.session.sessionKind === "recovery" && params.purpose !== "delete_account") {
      throw new GroupHostHttpError(
        403,
        "Forbidden",
        "Recovery sessions may only claim 'delete_account' action tokens.",
      );
    }
    assertFreshLoginStepUp(
      params.session,
      nowMs,
      "claim-action-token requires prompt=login authentication within the last 5 minutes.",
    );

    const tx = this.db.transaction(() => {
      let effState: LiveGroupGovernanceState;
      if ("sessionId" in params.session) {
        const revalidated = revalidateLiveOAuthSessionSync(this.db, params.session, {
          allowDeactivatedRecovery: params.purpose === "delete_account",
          nowMs,
        });
        if (params.purpose === "plc_operation") {
          revalidated.permissions.assertIdentity({ attr: "*" });
        } else {
          revalidated.permissions.assertAccount({ attr: "status", action: "manage" });
        }
        effState = revalidated.effState;
      } else {
        const liveState = loadLiveGovernanceState(this.db, params.groupDid);
        const recoveryRow = this.db
          .prepare("SELECT * FROM group_recovery_admin WHERE group_did = ?")
          .get(params.groupDid) as RecoveryAdminRow | undefined;
        effState = effectiveStateForSession(liveState, params.session, recoveryRow);
      }
      if (!isAuthorizedLifecycleAdmin(params.actorDid, effState, params.groupDid)) {
        throw new GroupHostHttpError(403, "Forbidden", "Caller is not an authorized lifecycle admin.");
      }

      const row = this.db
        .prepare(
          "SELECT token_hash, actor_did, claim_ciphertext_enc, expires_at FROM group_action_token WHERE group_did = ? AND purpose = ?",
        )
        .get(params.groupDid, params.purpose) as
        | {
            token_hash: string;
            actor_did: string;
            claim_ciphertext_enc: string | null;
            expires_at: number;
          }
        | undefined;

      if (!row || row.actor_did !== params.actorDid) {
        throw new GroupHostHttpError(400, "InvalidToken", "No matching action token found for caller.");
      }
      if (row.expires_at <= nowMs) {
        throw new GroupHostHttpError(400, "ExpiredToken", "Action token has expired.");
      }
      if (row.claim_ciphertext_enc === null) {
        throw new GroupHostHttpError(400, "TokenAlreadyClaimed", "Action token was already claimed.");
      }

      const upd = this.db
        .prepare(
          "UPDATE group_action_token SET claim_ciphertext_enc = NULL, claimed_at = ? WHERE token_hash = ? AND claim_ciphertext_enc IS NOT NULL",
        )
        .run(nowMs, row.token_hash);
      if (upd.changes !== 1) {
        throw new GroupHostHttpError(400, "TokenAlreadyClaimed", "Action token was already claimed.");
      }

      const rawToken = this.cryptoBox.decryptColumnUtf8(
        "group_action_token",
        `${params.groupDid}:${params.purpose}`,
        "claim_ciphertext_enc",
        row.claim_ciphertext_enc,
      );
      return {
        token: rawToken,
        expiresAt: new Date(row.expires_at).toISOString(),
      };
    });

    return tx.immediate();
  }
}

import { RepoCommit as SpaceRepoCommit } from "@atproto/space";
function requireRepoCommit() {
  return { RepoCommit: SpaceRepoCommit };
}

export { ATGRP_METHOD };
