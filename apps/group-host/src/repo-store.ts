import { randomUUID } from "node:crypto";
import { BlockMap, blocksToCarFile, readCarWithRoot } from "@atproto/car";
import { TID } from "@atproto/common";
import { P256Keypair, type Keypair } from "@atproto/crypto";
import { encode as cborEncode } from "@atproto/lex-cbor";
import { cidForCbor, fromBase64, parseCid, type Cid, type LexMap, type LexValue } from "@atproto/lex-data";
import { ReadableBlockstore, Repo, WriteOpAction, type CommitData, type RecordWriteOp, type RepoStorage } from "@atproto/repo";
import {
  COMMIT_MAC_PROFILE,
  createCommitMacHeaders,
  createDelegationToken,
  createRecordMacHeaders,
  createSpaceCredential,
  decapsulate,
  isP256DidKey,
  parseMacRequest,
  parseSpaceToken,
  readRepoStar,
  readSpaceMetaStar,
  RECORD_MAC_PROFILE,
  RepoCommit,
  serializeRecord,
  spaceHostAud,
  verifyCredentialSig,
  verifySpaceToken,
  writeRepoStar,
  writeSpaceMetaStar,
  type MacProfile,
  type SerializedRecord,
  type SpaceCommit,
  type SpaceMetaArchive,
} from "@atproto/space";
import type { AtUriString, DidString, NsidString, RecordKeyString, SpaceRefString } from "@atproto/syntax";
import { boundedSafeFetch, BOUNDED_FETCH_PROFILES, type SafeFetch } from "@flock/net/safe-fetch";
import { readUpstreamJson } from "@flock/protocol/bounded-json";
import {
  groupMembersUri,
  groupMetaUri,
  isDid,
  isRecordKey,
  isTid,
  parsePersonalInboxUri,
  parseSpaceUri,
  SELF_SKEY,
  spaceUri,
  tidNow,
  workspaceUri,
} from "@flock/protocol/keys";
import { compareUtf16 } from "@flock/protocol/migration-manifest";
import {
  ATGRP_COLLECTION,
  ATGRP_NAMESPACE,
  ATGRP_POLICY,
  ATGRP_SPACE_TYPE,
  ATPROTO_SPACE_COLLECTION,
  COLLECTION,
  FLOCK_EXTENSION_FIELD,
  REPO_COLLECTION,
} from "@flock/protocol/nsids";
import {
  decodeFlockMembershipExtensions,
  MANDATORY_VALIDATED_SPACE_COLLECTIONS,
  validatePublicRecord,
  validateSpacePolicy,
  validateSpaceRecord,
  validateSpaceTypeKey,
} from "@flock/protocol/registry";
import type { GroupAtgrpPolicy, GroupRoleRecord } from "@flock/protocol/scopes";
import * as jose from "jose";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import type { GroupHostConfig } from "./config";
import {
  lexDataToPlainJson as lexToJson,
  plainJsonToLexData as jsonToLex,
  type GroupHostCryptoBox,
} from "./crypto-box";
import { purgeGroupDataSync, type GroupHostDb } from "./db";
import {
  clearModEjectionEligibilitySync,
  recordModEjectEventSync,
  recordModLabelEventSync,
} from "./moderation";
import {
  assertFreshLoginStepUp,
  revalidateLiveOAuthSessionSync,
  type AuthenticatedGroupSession,
  type EffectiveSessionPermissions,
} from "./oauth";
import {
  GroupHostHttpError,
  isSupportedPlcRotationDidKey,
  normalizeOriginUrl,
  plcOpRotationKeys,
  type PlcAndDidResolver,
} from "./plc";
import {
  assertCanAssignRoleDiff,
  assertPolicyWriteAntiEscalation,
  assertPostGovernanceInvariants,
  assertRoleWriteAntiEscalation,
  effectiveStateForSession,
  hasActiveSourceMigrationLease,
  isAuthorizedLifecycleAdmin,
  liveRoleGrantsRead,
  liveRoleGrantsWrite,
  loadLiveGovernanceState,
  reapExpiredPreparedMigrationLease,
  type GroupRepoLockManager,
  type LiveGroupGovernanceState,
  type RecoveryAdminRow,
} from "./rbac";

export const MAX_WRITES_PER_APPLY = 200;
export const WRITE_POINTS_WINDOW_MS = 60_000;
export const WRITE_POINTS_MAX_PER_WINDOW = 5_000;
const SPACE_CREDENTIAL_TTL_SEC = 600;
const DELEGATION_TOKEN_TTL_SEC = 60;

export function nextMonotonicTid(prevRev?: string | null): string {
  return TID.nextStr(prevRev ?? undefined);
}

export function collectBlobCidsFromValue(value: unknown, out = new Set<string>()): Set<string> {
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) collectBlobCidsFromValue(item, out);
    return out;
  }
  const obj = value as Record<string, unknown>;
  if (obj.$type === "blob" && obj.ref && typeof obj.ref === "object") {
    const refObj = obj.ref as { $link?: unknown; toString?: () => string };
    if (typeof refObj.$link === "string") {
      out.add(refObj.$link);
    } else if (typeof refObj.toString === "function") {
      const s = refObj.toString();
      if (s && s !== "[object Object]") out.add(s);
    }
    return out;
  }
  for (const v of Object.values(obj)) {
    collectBlobCidsFromValue(v, out);
  }
  return out;
}

/**
 * Complete 13-method `RepoStorage` implementation over SQLite `public_repo_root` + `public_repo_block`
 * with in-memory block staging so async MST precomputation happens outside synchronous `better-sqlite3` transactions.
 */
export class SqlStagingRepoStorage extends ReadableBlockstore implements RepoStorage {
  readonly stagedBlocks = new Map<string, { cid: Cid; bytes: Uint8Array; rev: string }>();
  stagedRoot: Cid | null;
  stagedRev: string | null;
  readonly initialRootCidStr: string | null;

  constructor(
    private readonly db: GroupHostDb,
    readonly groupDid: string,
  ) {
    super();
    const row = db
      .prepare("SELECT commit_cid, rev FROM public_repo_root WHERE group_did = ?")
      .get(groupDid) as { commit_cid: string; rev: string } | undefined;
    this.initialRootCidStr = row?.commit_cid ?? null;
    this.stagedRoot = row ? parseCid(row.commit_cid) : null;
    this.stagedRev = row?.rev ?? null;
  }

  async getRoot(): Promise<Cid | null> {
    return this.stagedRoot;
  }

  async putBlock(cid: Cid, block: Uint8Array, rev: string): Promise<void> {
    this.stagedBlocks.set(cid.toString(), { cid, bytes: new Uint8Array(block), rev });
  }

  async putMany(blocks: BlockMap, rev: string): Promise<void> {
    for (const entry of blocks) {
      this.stagedBlocks.set(entry.cid.toString(), {
        cid: entry.cid,
        bytes: new Uint8Array(entry.bytes),
        rev,
      });
    }
  }

  async updateRoot(cid: Cid, rev: string): Promise<void> {
    this.stagedRoot = cid;
    this.stagedRev = rev;
  }

  async applyCommit(commit: CommitData): Promise<void> {
    await this.putMany(commit.newBlocks, commit.rev);
    await this.updateRoot(commit.cid, commit.rev);
  }

  async getBytes(cid: Cid): Promise<Uint8Array | null> {
    const key = cid.toString();
    const staged = this.stagedBlocks.get(key);
    if (staged) return staged.bytes;
    const row = this.db
      .prepare("SELECT bytes FROM public_repo_block WHERE group_did = ? AND cid = ?")
      .get(this.groupDid, key) as { bytes: Buffer } | undefined;
    return row ? new Uint8Array(row.bytes) : null;
  }

  async has(cid: Cid): Promise<boolean> {
    const key = cid.toString();
    if (this.stagedBlocks.has(key)) return true;
    const row = this.db
      .prepare("SELECT 1 AS ok FROM public_repo_block WHERE group_did = ? AND cid = ?")
      .get(this.groupDid, key);
    return Boolean(row);
  }

  async getBlocks(cids: Iterable<Cid>): Promise<{ blocks: BlockMap; missing: Cid[] }> {
    const blocks = new BlockMap();
    const missing: Cid[] = [];
    for (const cid of cids) {
      const bytes = await this.getBytes(cid);
      if (bytes) {
        blocks.set(cid, bytes);
      } else {
        missing.push(cid);
      }
    }
    return { blocks, missing };
  }

  /**
   * Flushes staged blocks & root into SQLite inside an already-open `IMMEDIATE` transaction,
   * verifying CAS against `initialRootCidStr`.
   */
  flushStagedSync(nowMs: number, removedCids?: Iterable<Cid>): void {
    const currentRow = this.db
      .prepare("SELECT commit_cid FROM public_repo_root WHERE group_did = ?")
      .get(this.groupDid) as { commit_cid: string } | undefined;
    const currentRoot = currentRow?.commit_cid ?? null;
    if (currentRoot !== this.initialRootCidStr) {
      throw new GroupHostHttpError(400, "InvalidSwap", "Concurrent public repo root modification.");
    }
    const insertBlock = this.db.prepare(
      "INSERT OR REPLACE INTO public_repo_block (group_did, cid, bytes, rev) VALUES (?, ?, ?, ?)",
    );
    for (const entry of this.stagedBlocks.values()) {
      insertBlock.run(this.groupDid, entry.cid.toString(), Buffer.from(entry.bytes), entry.rev);
    }
    if (removedCids) {
      const delBlock = this.db.prepare("DELETE FROM public_repo_block WHERE group_did = ? AND cid = ?");
      for (const cid of removedCids) {
        delBlock.run(this.groupDid, cid.toString());
      }
    }
    if (this.stagedRoot && this.stagedRev) {
      this.db
        .prepare(
          `INSERT INTO public_repo_root (group_did, commit_cid, rev, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(group_did) DO UPDATE SET commit_cid = excluded.commit_cid, rev = excluded.rev, updated_at = excluded.updated_at`,
        )
        .run(this.groupDid, this.stagedRoot.toString(), this.stagedRev, nowMs);
    }
  }
}

export async function readBoundedStreamBytes(
  stream: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  maxBytes: number,
  errorCode = "PayloadTooLarge",
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new GroupHostHttpError(413, errorCode, `Stream exceeded byte limit (${maxBytes} bytes).`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return new Uint8Array(Buffer.concat(chunks, total));
}

export type PublicWriteInputOp =
  | { action: "create"; collection: string; rkey?: string; value: Record<string, unknown>; validate?: boolean }
  | { action: "update"; collection: string; rkey: string; value: Record<string, unknown>; swapRecord?: string | null; validate?: boolean }
  | { action: "delete"; collection: string; rkey: string; swapRecord?: string | null };

export type SpaceWriteInputOp =
  | { action: "create"; collection: string; rkey?: string; value: Record<string, unknown>; validate?: boolean }
  | { action: "update"; collection: string; rkey: string; value: Record<string, unknown>; swapRecord?: string | null; validate?: boolean }
  | { action: "delete"; collection: string; rkey: string; swapRecord?: string | null };

export class GroupRepoStore {
  private readonly writePoints = new Map<string, { windowStartMs: number; points: number }>();
  private readonly noticeFetcher: SafeFetch;
  private readonly jwksMetadataFetcher: SafeFetch;

  constructor(
    readonly db: GroupHostDb,
    readonly config: GroupHostConfig,
    readonly cryptoBox: GroupHostCryptoBox,
    readonly plc: PlcAndDidResolver,
    readonly locks: GroupRepoLockManager,
  ) {
    this.noticeFetcher =
      config.fetchImpl ?? boundedSafeFetch(() => config.allowLoopback, BOUNDED_FETCH_PROFILES.xrpcNotice);
    this.jwksMetadataFetcher =
      config.fetchImpl ?? boundedSafeFetch(() => config.allowLoopback, BOUNDED_FETCH_PROFILES.didAndJwks);
  }

  private assertMetaPublicReadForDeclarationSync(groupDid: string): void {
    const metaRow = this.db
      .prepare("SELECT policy_json FROM group_space WHERE space_uri = ? AND group_did = ? AND deleted_at IS NULL")
      .get(groupMetaUri(groupDid), groupDid) as { policy_json: string } | undefined;
    if (!metaRow) {
      throw new GroupHostHttpError(
        400,
        "InvalidRequest",
        "Cannot publish org.atgrp.declaration while org.atgrp.meta/self is missing.",
      );
    }
    const pol = JSON.parse(metaRow.policy_json) as { publicRead?: boolean };
    if (pol.publicRead !== true) {
      throw new GroupHostHttpError(
        400,
        "InvalidRequest",
        "Cannot publish org.atgrp.declaration while org.atgrp.meta/self has publicRead=false.",
      );
    }
  }

  consumeWritePoints(did: string, ops: ReadonlyArray<{ action: "create" | "update" | "delete" }>, nowMs = Date.now()): void {
    let cost = 0;
    for (const op of ops) {
      cost += op.action === "create" ? 3 : op.action === "update" ? 2 : 1;
    }
    const existing = this.writePoints.get(did);
    if (!existing || nowMs - existing.windowStartMs >= WRITE_POINTS_WINDOW_MS) {
      if (cost > WRITE_POINTS_MAX_PER_WINDOW) {
        throw new GroupHostHttpError(429, "RateLimitExceeded", "Write rate limit exceeded.");
      }
      this.writePoints.set(did, { windowStartMs: nowMs, points: cost });
      return;
    }
    if (existing.points + cost > WRITE_POINTS_MAX_PER_WINDOW) {
      throw new GroupHostHttpError(429, "RateLimitExceeded", "Write rate limit exceeded.");
    }
    existing.points += cost;
  }

  resolveRepoIdentifier(identifier: string): { did: string; handle: string; activated: number; takendown: number } {
    const trimmed = identifier.trim();
    const row = isDid(trimmed)
      ? (this.db
          .prepare("SELECT did, handle, activated, takendown FROM group_account WHERE did = ?")
          .get(trimmed) as { did: string; handle: string; activated: number; takendown: number } | undefined)
      : (this.db
          .prepare("SELECT did, handle, activated, takendown FROM group_account WHERE handle = ?")
          .get(trimmed.toLowerCase()) as { did: string; handle: string; activated: number; takendown: number } | undefined);
    if (!row) {
      throw new GroupHostHttpError(400, "RepoNotFound", `Could not find repo for ${identifier}`);
    }
    return row;
  }

  async getGroupSigningKey(groupDid: string): Promise<Keypair> {
    const row = this.db
      .prepare("SELECT signing_key_enc FROM group_account WHERE did = ?")
      .get(groupDid) as { signing_key_enc: string } | undefined;
    if (!row) throw new GroupHostHttpError(400, "RepoNotFound", `Unknown group ${groupDid}`);
    return this.cryptoBox.decryptKeypair("group_account", groupDid, "signing_key_enc", row.signing_key_enc);
  }

  async getGroupKemKey(groupDid: string): Promise<Keypair> {
    const row = this.db
      .prepare("SELECT kem_key_enc FROM group_account WHERE did = ?")
      .get(groupDid) as { kem_key_enc: string } | undefined;
    if (!row) throw new GroupHostHttpError(400, "RepoNotFound", `Unknown group ${groupDid}`);
    return this.cryptoBox.decryptKeypair("group_account", groupDid, "kem_key_enc", row.kem_key_enc);
  }

  async getGroupRotationKey(groupDid: string): Promise<Keypair | null> {
    const row = this.db
      .prepare("SELECT rotation_key_enc FROM group_account WHERE did = ?")
      .get(groupDid) as { rotation_key_enc: string | null } | undefined;
    if (!row?.rotation_key_enc) return null;
    try {
      return await this.cryptoBox.decryptKeypair("group_account", groupDid, "rotation_key_enc", row.rotation_key_enc);
    } catch {
      return null;
    }
  }

  // =========================================================================
  // Public Repository (`com.atproto.repo.*` & `com.atproto.sync.*`)
  // =========================================================================

  async exportPublicRepoCar(groupDid: string): Promise<{ rootCid: string; rev: string; carBytes: Uint8Array }> {
    const rootRow = this.db
      .prepare("SELECT commit_cid, rev FROM public_repo_root WHERE group_did = ?")
      .get(groupDid) as { commit_cid: string; rev: string } | undefined;
    if (!rootRow) {
      throw new GroupHostHttpError(400, "RepoNotFound", `Missing public repo root for ${groupDid}`);
    }
    const blockRows = this.db
      .prepare("SELECT cid, bytes FROM public_repo_block WHERE group_did = ?")
      .all(groupDid) as Array<{ cid: string; bytes: Buffer }>;
    const blocks = new BlockMap();
    for (const row of blockRows) {
      blocks.set(parseCid(row.cid), new Uint8Array(row.bytes));
    }
    const carBytes = await blocksToCarFile(parseCid(rootRow.commit_cid), blocks);
    return { rootCid: rootRow.commit_cid, rev: rootRow.rev, carBytes };
  }

  async applyPublicWrites(params: {
    groupDid: string;
    session?: AuthenticatedGroupSession;
    writes: readonly PublicWriteInputOp[];
    swapCommit?: string;
    isPutRecord?: boolean;
    putSwapRecord?: string | null;
    nowMs?: number;
  }): Promise<{
    commit: { cid: string; rev: string };
    results: Array<{ $type: string; uri?: string; cid?: string; validationStatus?: string }>;
  }> {
    const nowMs = params.nowMs ?? Date.now();
    if (params.writes.length > MAX_WRITES_PER_APPLY) {
      throw new GroupHostHttpError(400, "InvalidRequest", `Too many writes (max ${MAX_WRITES_PER_APPLY}).`);
    }

    return this.locks.withGroupRepoLock(params.groupDid, async () => {
      reapExpiredPreparedMigrationLease(this.db, params.groupDid, nowMs);
      if (hasActiveSourceMigrationLease(this.db, params.groupDid, nowMs)) {
        throw new GroupHostHttpError(409, "MigrationInProgress", "Group is frozen during active migration.");
      }
      const acct = this.db
        .prepare("SELECT activated, takendown FROM group_account WHERE did = ?")
        .get(params.groupDid) as { activated: number; takendown: number } | undefined;
      if (!acct || acct.takendown !== 0) throw new GroupHostHttpError(400, "RepoTakendown", "Repo taken down.");
      if (acct.activated !== 1) throw new GroupHostHttpError(400, "RepoDeactivated", "Repo deactivated.");

      const storage = new SqlStagingRepoStorage(this.db, params.groupDid);
      if (params.swapCommit !== undefined && storage.initialRootCidStr !== params.swapCommit) {
        throw new GroupHostHttpError(400, "InvalidSwap", "swapCommit does not match current commit CID.");
      }

      const signingKey = await this.getGroupSigningKey(params.groupDid);
      const repo = await Repo.load(storage);

      const repoWrites: RecordWriteOp[] = [];
      const resultMeta: Array<{
        op: "create" | "update" | "delete";
        inputAction: "create" | "update" | "delete";
        expectedExisted: boolean;
        expectedExistingCid?: string;
        collection: string;
        rkey: string;
        uri: string;
        value?: Record<string, unknown>;
        noopCid?: string;
      }> = [];

      // Pre-validate & check swapRecord preconditions BEFORE any no-op short-circuit!
      for (const w of params.writes) {
        const rkey = w.action === "create" ? (w.rkey ?? tidNow(nowMs)) : w.rkey;
        if (!isRecordKey(rkey)) {
          throw new GroupHostHttpError(400, "InvalidRequest", `Invalid record key: ${rkey}`);
        }
        const existingRow = this.db
          .prepare("SELECT cid, value FROM public_record WHERE group_did = ? AND collection = ? AND rkey = ?")
          .get(params.groupDid, w.collection, rkey) as { cid: string; value: string } | undefined;
        const uri = `at://${params.groupDid}/${w.collection}/${rkey}`;

        if (w.action === "create") {
          if (existingRow) {
            throw new GroupHostHttpError(400, "InvalidSwap", `Record already exists at ${uri}`);
          }
          const withType = { $type: w.collection, ...w.value };
          const check = validatePublicRecord(w.collection, withType, {
            repoDid: params.groupDid,
            rkey,
            validate: w.validate,
          });
          if (!check.valid) {
            throw new GroupHostHttpError(400, check.code ?? "InvalidRequest", check.reason);
          }
          if (w.collection === REPO_COLLECTION.groupDeclaration) {
            this.assertMetaPublicReadForDeclarationSync(params.groupDid);
          }
          repoWrites.push({
            action: WriteOpAction.Create,
            collection: w.collection as NsidString,
            rkey,
            record: jsonToLex(withType) as LexMap,
          });
          resultMeta.push({
            op: "create",
            inputAction: "create",
            expectedExisted: false,
            collection: w.collection,
            rkey,
            uri,
            value: withType,
          });
        } else if (w.action === "update") {
          if (params.isPutRecord) {
            if (params.putSwapRecord === null && existingRow) {
              throw new GroupHostHttpError(400, "InvalidSwap", "Expected absent record for swapRecord: null.");
            }
            if (typeof params.putSwapRecord === "string" && (!existingRow || existingRow.cid !== params.putSwapRecord)) {
              throw new GroupHostHttpError(400, "InvalidSwap", "swapRecord CID mismatch.");
            }
          } else if (!existingRow) {
            throw new GroupHostHttpError(400, "InvalidSwap", `Cannot update absent record at ${uri}`);
          } else if (w.swapRecord !== undefined && w.swapRecord !== existingRow.cid) {
            throw new GroupHostHttpError(400, "InvalidSwap", "swapRecord CID mismatch.");
          }
          const withType = { $type: w.collection, ...w.value };
          const check = validatePublicRecord(w.collection, withType, {
            repoDid: params.groupDid,
            rkey,
            validate: w.validate,
          });
          if (!check.valid) {
            throw new GroupHostHttpError(400, check.code ?? "InvalidRequest", check.reason);
          }
          if (w.collection === REPO_COLLECTION.groupDeclaration) {
            this.assertMetaPublicReadForDeclarationSync(params.groupDid);
          }
          if (!existingRow) {
            repoWrites.push({
              action: WriteOpAction.Create,
              collection: w.collection as NsidString,
              rkey,
              record: jsonToLex(withType) as LexMap,
            });
            resultMeta.push({
              op: "create",
              inputAction: "update",
              expectedExisted: false,
              collection: w.collection,
              rkey,
              uri,
              value: withType,
            });
          } else {
            const candidateCid = (await cidForCbor(cborEncode(jsonToLex(withType) as LexValue))).toString();
            if (candidateCid === existingRow.cid) {
              resultMeta.push({
                op: "update",
                inputAction: "update",
                expectedExisted: true,
                expectedExistingCid: existingRow.cid,
                collection: w.collection,
                rkey,
                uri,
                value: withType,
                noopCid: candidateCid,
              });
            } else {
              repoWrites.push({
                action: WriteOpAction.Update,
                collection: w.collection as NsidString,
                rkey,
                record: jsonToLex(withType) as LexMap,
              });
              resultMeta.push({
                op: "update",
                inputAction: "update",
                expectedExisted: true,
                expectedExistingCid: existingRow.cid,
                collection: w.collection,
                rkey,
                uri,
                value: withType,
              });
            }
          }
        } else {
          // delete
          if (!existingRow) {
            if (!params.isPutRecord && w.swapRecord !== undefined && w.swapRecord !== null) {
              throw new GroupHostHttpError(400, "InvalidSwap", "Cannot delete absent record with non-null swapRecord.");
            }
            if (params.isPutRecord) {
              // deleteRecord endpoint: re-verify live authorization & state inside `tx.immediate()` before returning no-op
              this.db
                .transaction(() => {
                  reapExpiredPreparedMigrationLease(this.db, params.groupDid, nowMs);
                  if (hasActiveSourceMigrationLease(this.db, params.groupDid, nowMs)) {
                    throw new GroupHostHttpError(409, "MigrationInProgress", "Group is frozen during active migration.");
                  }
                  if (params.session) {
                    const { permissions: commitPerms } = revalidateLiveOAuthSessionSync(this.db, params.session, { nowMs });
                    commitPerms.assertRepo({ collection: w.collection as NsidString, action: "delete" });
                  }
                  const liveExisting = this.db
                    .prepare("SELECT cid FROM public_record WHERE group_did = ? AND collection = ? AND rkey = ?")
                    .get(params.groupDid, w.collection, rkey) as { cid: string } | undefined;
                  if (liveExisting) {
                    throw new GroupHostHttpError(400, "InvalidSwap", "Concurrent record created during deleteRecord.");
                  }
                })
                .immediate();
              return { commit: { cid: storage.initialRootCidStr!, rev: storage.stagedRev! }, results: [] };
            }
            throw new GroupHostHttpError(400, "InvalidSwap", `Cannot delete absent record in applyWrites: ${uri}`);
          }
          if (w.swapRecord !== undefined && w.swapRecord !== null && existingRow.cid !== w.swapRecord) {
            throw new GroupHostHttpError(400, "InvalidSwap", "swapRecord CID mismatch on delete.");
          }
          repoWrites.push({
            action: WriteOpAction.Delete,
            collection: w.collection as NsidString,
            rkey,
          });
          resultMeta.push({
            op: "delete",
            inputAction: "delete",
            expectedExisted: true,
            expectedExistingCid: existingRow.cid,
            collection: w.collection,
            rkey,
            uri,
          });
        }
      }

      const verifyCommitAuthAndStateSync = () => {
        reapExpiredPreparedMigrationLease(this.db, params.groupDid, nowMs);
        if (hasActiveSourceMigrationLease(this.db, params.groupDid, nowMs)) {
          throw new GroupHostHttpError(409, "MigrationInProgress", "Group is frozen during active migration.");
        }
        if (params.swapCommit !== undefined) {
          const liveRoot = this.db
            .prepare("SELECT commit_cid FROM public_repo_root WHERE group_did = ?")
            .get(params.groupDid) as { commit_cid: string } | undefined;
          if (liveRoot?.commit_cid !== params.swapCommit) {
            throw new GroupHostHttpError(400, "InvalidSwap", "Concurrent commit changed root.");
          }
        }
        const commitPerms = params.session
          ? revalidateLiveOAuthSessionSync(this.db, params.session, { nowMs }).permissions
          : undefined;
        for (const m of resultMeta) {
          const liveExisting = this.db
            .prepare("SELECT cid FROM public_record WHERE group_did = ? AND collection = ? AND rkey = ?")
            .get(params.groupDid, m.collection, m.rkey) as { cid: string } | undefined;
          if (
            Boolean(liveExisting) !== m.expectedExisted ||
            (m.expectedExisted && liveExisting?.cid !== m.expectedExistingCid)
          ) {
            throw new GroupHostHttpError(400, "InvalidSwap", "Concurrent commit changed target record.");
          }
          if (m.op !== "delete" && m.collection === REPO_COLLECTION.groupDeclaration) {
            this.assertMetaPublicReadForDeclarationSync(params.groupDid);
          }
          if (commitPerms) {
            const requiredAction =
              params.isPutRecord && m.inputAction === "update"
                ? liveExisting
                  ? "update"
                  : "create"
                : m.op;
            commitPerms.assertRepo({
              collection: m.collection as NsidString,
              action: requiredAction,
            });
          }
        }
      };

      this.consumeWritePoints(params.groupDid, params.writes, nowMs);

      if (repoWrites.length === 0) {
        this.db.transaction(() => verifyCommitAuthAndStateSync()).immediate();
        return {
          commit: { cid: storage.initialRootCidStr!, rev: storage.stagedRev! },
          results: resultMeta.map((m) => ({
            $type: `com.atproto.repo.applyWrites#${m.op}Result`,
            uri: m.uri,
            ...(m.noopCid ? { cid: m.noopCid, validationStatus: "valid" } : {}),
          })),
        };
      }

      const commitData = await repo.formatCommit(repoWrites, signingKey);
      await storage.applyCommit(commitData);
      const updatedRepo = await Repo.load(storage, commitData.cid);

      const finalCids = new Map<string, string>();
      for (const m of resultMeta) {
        if (m.op !== "delete") {
          const cid = await updatedRepo.data.get(`${m.collection}/${m.rkey}`);
          if (cid) finalCids.set(`${m.collection}/${m.rkey}`, cid.toString());
        }
      }

      const tx = this.db.transaction(() => {
        verifyCommitAuthAndStateSync();
        storage.flushStagedSync(nowMs, commitData.removedCids.toList());

        for (const m of resultMeta) {
          this.db.prepare("DELETE FROM public_record_blob WHERE group_did = ? AND record_uri = ?").run(params.groupDid, m.uri);
          if (m.op === "delete") {
            this.db
              .prepare("DELETE FROM public_record WHERE group_did = ? AND collection = ? AND rkey = ?")
              .run(params.groupDid, m.collection, m.rkey);
          } else {
            const cidStr = finalCids.get(`${m.collection}/${m.rkey}`) ?? m.noopCid!;
            this.db
              .prepare(
                `INSERT INTO public_record (group_did, collection, rkey, uri, cid, value, rev, indexed_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(group_did, collection, rkey) DO UPDATE SET
                   cid = excluded.cid, value = excluded.value, rev = excluded.rev, indexed_at = excluded.indexed_at`,
              )
              .run(params.groupDid, m.collection, m.rkey, m.uri, cidStr, JSON.stringify(m.value), commitData.rev, nowMs);
            for (const blobCid of collectBlobCidsFromValue(m.value)) {
              this.db
                .prepare("INSERT OR IGNORE INTO public_record_blob (group_did, record_uri, blob_cid) VALUES (?, ?, ?)")
                .run(params.groupDid, m.uri, blobCid);
            }
          }
        }
      });
      tx.immediate();

      return {
        commit: { cid: commitData.cid.toString(), rev: commitData.rev },
        results: resultMeta.map((m) =>
          m.op === "delete"
            ? { $type: "com.atproto.repo.applyWrites#deleteResult" }
            : {
                $type: `com.atproto.repo.applyWrites#${m.op}Result`,
                uri: m.uri,
                cid: finalCids.get(`${m.collection}/${m.rkey}`) ?? m.noopCid!,
                validationStatus: "valid",
              },
        ),
      };
    });
  }

  async importPublicRepoCar(params: {
    groupDid: string;
    migrationSessionId: string;
    migrationTokenExpSec?: number;
    carStream: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
    nowMs?: number;
  }): Promise<void> {
    const startWallMs = Date.now();
    const initialNowMs = params.nowMs ?? startWallMs;
    this.assertLiveMigrationStagingSync(
      params.groupDid,
      params.migrationSessionId,
      initialNowMs,
      params.migrationTokenExpSec,
    );
    const carBytes = await readBoundedStreamBytes(
      params.carStream,
      this.config.maxRepoImportSize,
      "InvalidRequest",
    );
    let parsedCar: Awaited<ReturnType<typeof readCarWithRoot>>;
    try {
      parsedCar = await readCarWithRoot(carBytes);
    } catch (err) {
      throw new GroupHostHttpError(400, "InvalidRequest", err instanceof Error ? err.message : "Invalid CAR archive.");
    }

    return this.locks.withGroupRepoLock(params.groupDid, async () => {
      const signingKey = await this.getGroupSigningKey(params.groupDid);
      const tempStorage = new SqlStagingRepoStorage(this.db, params.groupDid);
      tempStorage.stagedBlocks.clear();
      const importRev = nextMonotonicTid();
      await tempStorage.putMany(parsedCar.blocks, importRev);
      await tempStorage.updateRoot(parsedCar.root, importRev);

      const importedRepo = await Repo.load(tempStorage, parsedCar.root);
      const resigned = await importedRepo.formatResignCommit(importRev, signingKey);
      await tempStorage.putMany(resigned.newBlocks, importRev);
      await tempStorage.updateRoot(resigned.cid, importRev);

      const finalRepo = await Repo.load(tempStorage, resigned.cid);
      const extractedRecords: Array<{
        collection: string;
        rkey: string;
        uri: string;
        cid: string;
        valueJson: string;
        blobs: string[];
      }> = [];

      for await (const entry of finalRepo.walkRecords()) {
        const plainJson = lexToJson(entry.record) as Record<string, unknown>;
        const check = validatePublicRecord(entry.collection, plainJson, {
          repoDid: params.groupDid,
          rkey: entry.rkey,
          validate: false, // Unconditionally validates group.opensocial.declaration!
        });
        if (!check.valid) {
          throw new GroupHostHttpError(400, check.code ?? "InvalidRequest", check.reason);
        }
        const uri = `at://${params.groupDid}/${entry.collection}/${entry.rkey}`;
        extractedRecords.push({
          collection: entry.collection,
          rkey: entry.rkey,
          uri,
          cid: entry.cid.toString(),
          valueJson: JSON.stringify(plainJson),
          blobs: [...collectBlobCidsFromValue(plainJson)],
        });
      }

      const tx = this.db.transaction(() => {
        const commitNowMs =
          params.nowMs !== undefined ? params.nowMs + Math.max(0, Date.now() - startWallMs) : Date.now();
        this.assertLiveMigrationStagingSync(
          params.groupDid,
          params.migrationSessionId,
          commitNowMs,
          params.migrationTokenExpSec,
        );
        this.db.prepare("DELETE FROM public_record_blob WHERE group_did = ?").run(params.groupDid);
        this.db.prepare("DELETE FROM public_record WHERE group_did = ?").run(params.groupDid);
        this.db.prepare("DELETE FROM public_repo_block WHERE group_did = ?").run(params.groupDid);

        const insBlock = this.db.prepare(
          "INSERT OR REPLACE INTO public_repo_block (group_did, cid, bytes, rev) VALUES (?, ?, ?, ?)",
        );
        const oldRootStr = parsedCar.root.toString();
        for (const b of parsedCar.blocks) {
          if (b.cid.toString() === oldRootStr) continue;
          insBlock.run(params.groupDid, b.cid.toString(), Buffer.from(b.bytes), importRev);
        }
        for (const b of resigned.relevantBlocks) {
          insBlock.run(params.groupDid, b.cid.toString(), Buffer.from(b.bytes), importRev);
        }
        for (const b of resigned.newBlocks) {
          insBlock.run(params.groupDid, b.cid.toString(), Buffer.from(b.bytes), importRev);
        }
        this.db
          .prepare(
            `INSERT INTO public_repo_root (group_did, commit_cid, rev, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(group_did) DO UPDATE SET commit_cid = excluded.commit_cid, rev = excluded.rev, updated_at = excluded.updated_at`,
          )
          .run(params.groupDid, resigned.cid.toString(), importRev, commitNowMs);

        const insRec = this.db.prepare(
          `INSERT INTO public_record (group_did, collection, rkey, uri, cid, value, rev, indexed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const insBlobRef = this.db.prepare(
          "INSERT OR IGNORE INTO public_record_blob (group_did, record_uri, blob_cid) VALUES (?, ?, ?)",
        );
        for (const rec of extractedRecords) {
          insRec.run(
            params.groupDid,
            rec.collection,
            rec.rkey,
            rec.uri,
            rec.cid,
            rec.valueJson,
            importRev,
            commitNowMs,
          );
          for (const blobCid of rec.blobs) {
            insBlobRef.run(params.groupDid, rec.uri, blobCid);
          }
        }
      });
      tx.immediate();
    });
  }

  assertLiveMigrationStagingSync(
    groupDid: string,
    migrationSessionId: string,
    nowMs: number,
    migrationTokenExpSec?: number,
    options?: { allowSamePendingPlcOpCid?: string },
  ): void {
    const acct = this.db
      .prepare("SELECT activated, takendown FROM group_account WHERE did = ?")
      .get(groupDid) as { activated: number; takendown: number } | undefined;
    if (!acct) throw new GroupHostHttpError(400, "RepoNotFound", "Group account not staged.");
    if (acct.takendown !== 0) throw new GroupHostHttpError(400, "RepoTakendown", "Group is taken down.");
    if (acct.activated !== 0) throw new GroupHostHttpError(400, "AlreadyActivated", "Group is already activated.");

    const delRow = this.db
      .prepare("SELECT status, plc_outcome FROM group_deletion_journal WHERE group_did = ?")
      .get(groupDid) as { status: string; plc_outcome: string | null } | undefined;
    if (delRow && delRow.plc_outcome !== "migrated_remote") {
      throw new GroupHostHttpError(400, "RepoTakendown", "Group is being deleted.");
    }

    const sess = this.db
      .prepare(
        "SELECT id, plc_cutover_at, plc_submitting_at, pending_plc_op_cid, absolute_deadline_at FROM migration_session WHERE group_did = ?",
      )
      .get(groupDid) as
      | {
          id: string;
          plc_cutover_at: number | null;
          plc_submitting_at: number | null;
          pending_plc_op_cid: string | null;
          absolute_deadline_at: number;
        }
      | undefined;
    if (!sess || sess.id !== migrationSessionId) {
      throw new GroupHostHttpError(401, "InvalidToken", "Migration session no longer active.");
    }
    const isAllowedPendingRetry =
      sess.plc_cutover_at === null &&
      options?.allowSamePendingPlcOpCid !== undefined &&
      sess.pending_plc_op_cid !== null &&
      sess.pending_plc_op_cid === options.allowSamePendingPlcOpCid;
    if (
      sess.plc_cutover_at !== null ||
      ((sess.plc_submitting_at !== null || sess.pending_plc_op_cid !== null) && !isAllowedPendingRetry)
    ) {
      throw new GroupHostHttpError(
        409,
        "MigrationCutoverCommitted",
        "Cannot mutate staged data during or after PLC cutover.",
      );
    }
    if (
      nowMs >= sess.absolute_deadline_at ||
      (migrationTokenExpSec !== undefined && Math.floor(nowMs / 1000) >= migrationTokenExpSec)
    ) {
      throw new GroupHostHttpError(401, "ExpiredToken", "Migration staging deadline expired.");
    }
  }

  async uploadBlob(params: {
    groupDid: string;
    session?: AuthenticatedGroupSession;
    mimeType: string;
    bodyStream: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
    migrationSessionId?: string;
    migrationTokenExpSec?: number;
    nowMs?: number;
  }): Promise<{ blob: Record<string, unknown> }> {
    const startWallMs = Date.now();
    const initialNowMs = params.nowMs ?? startWallMs;
    if (params.migrationSessionId) {
      this.assertLiveMigrationStagingSync(
        params.groupDid,
        params.migrationSessionId,
        initialNowMs,
        params.migrationTokenExpSec,
      );
    }
    const limit = params.migrationSessionId
      ? this.config.migrationBlobUploadLimit
      : this.config.blobUploadLimit;
    const bytes = await readBoundedStreamBytes(params.bodyStream, limit, "PayloadTooLarge");
    const digest = await sha256.digest(bytes);
    const rawBlobCid = CID.createV1(0x55, digest);

    return this.locks.withGroupRepoLock(params.groupDid, () => {
      const tx = this.db.transaction(() => {
        const commitNowMs =
          params.nowMs !== undefined ? params.nowMs + Math.max(0, Date.now() - startWallMs) : Date.now();
        if (params.migrationSessionId) {
          this.assertLiveMigrationStagingSync(
            params.groupDid,
            params.migrationSessionId,
            commitNowMs,
            params.migrationTokenExpSec,
          );
        } else {
          reapExpiredPreparedMigrationLease(this.db, params.groupDid, commitNowMs);
          if (hasActiveSourceMigrationLease(this.db, params.groupDid, commitNowMs)) {
            throw new GroupHostHttpError(409, "MigrationInProgress", "Group is frozen during active migration.");
          }
          if (params.session) {
            const { permissions: commitPerms } = revalidateLiveOAuthSessionSync(this.db, params.session, {
              nowMs: commitNowMs,
            });
            commitPerms.assertBlob({ mime: params.mimeType as `${string}/${string}` });
          }
          const acct = this.db
            .prepare("SELECT activated, takendown FROM group_account WHERE did = ?")
            .get(params.groupDid) as { activated: number; takendown: number } | undefined;
          if (!acct || acct.takendown !== 0) throw new GroupHostHttpError(400, "RepoTakendown");
          if (acct.activated !== 1) throw new GroupHostHttpError(400, "RepoDeactivated");
        }
        this.db
          .prepare(
            `INSERT INTO blob_store (group_did, cid, mime_type, size, bytes, permanent, quarantined, created_at)
             VALUES (?, ?, ?, ?, ?, 1, 0, ?)
             ON CONFLICT(group_did, cid) DO UPDATE SET mime_type = excluded.mime_type, bytes = excluded.bytes, size = excluded.size`,
          )
          .run(
            params.groupDid,
            rawBlobCid.toString(),
            params.mimeType,
            bytes.byteLength,
            Buffer.from(bytes),
            commitNowMs,
          );
      });
      tx.immediate();

      return {
        blob: {
          $type: "blob",
          ref: { $link: rawBlobCid.toString() },
          mimeType: params.mimeType,
          size: bytes.byteLength,
        },
      };
    });
  }

  listMissingBlobs(groupDid: string, limit = 500, cursor?: string): { blobs: Array<{ cid: string; recordUri: string }>; cursor?: string } {
    const referenced = this.db
      .prepare(
        `SELECT blob_cid AS cid, MIN(record_uri) AS record_uri FROM (
           SELECT blob_cid, record_uri FROM public_record_blob WHERE group_did = ?
           UNION ALL
           SELECT blob_cid, record_uri FROM space_record_blob WHERE group_did = ?
         )
         WHERE blob_cid NOT IN (SELECT cid FROM blob_store WHERE group_did = ?)
           AND (? IS NULL OR blob_cid > ?)
         GROUP BY blob_cid
         ORDER BY blob_cid ASC
         LIMIT ?`,
      )
      .all(groupDid, groupDid, groupDid, cursor ?? null, cursor ?? null, limit + 1) as Array<{
      cid: string;
      record_uri: string;
    }>;

    const hasMore = referenced.length > limit;
    const page = hasMore ? referenced.slice(0, limit) : referenced;
    const last = page.at(-1);
    return {
      blobs: page.map((r) => ({ cid: r.cid, recordUri: r.record_uri })),
      ...(hasMore && last ? { cursor: last.cid } : {}),
    };
  }

  // =========================================================================
  // Space Repo & Space Metadata Helpers (`com.atproto.space.*`)
  // =========================================================================

  /**
   * Synchronously applies a batch of `<repoDid>` record mutations inside `spaceUri`
   * within the caller's active `IMMEDIATE` transaction, updating `space_record`,
   * `space_oplog`, `space_repo` (`LtHash`), `space_writer`, and `outbox_notice`.
   */
  applySpaceRepoMutationsSync(params: {
    groupDid: string;
    spaceUri: string;
    repoDid: string;
    ops: ReadonlyArray<{
      action: "create" | "update" | "delete";
      collection: string;
      rkey: string;
      value?: Record<string, unknown>;
      cborBytes?: Uint8Array;
      cidStr?: string;
      incarnation?: string | null;
    }>;
    isOwnAuthoritySpace: boolean;
    suppressNotices?: boolean;
    nowMs: number;
  }): { rev: string; digest: Uint8Array; results: Array<{ uri: string; cid?: string }> } {
    const existingRepo = this.db
      .prepare("SELECT set_hash, rev FROM space_repo WHERE space_uri = ? AND repo_did = ?")
      .get(params.spaceUri, params.repoDid) as { set_hash: Buffer; rev: string } | undefined;

    const repoCommit = RepoCommit.fromState(existingRepo ? new Uint8Array(existingRepo.set_hash) : null);
    const nextRev = nextMonotonicTid(existingRepo?.rev ?? null);
    const results: Array<{ uri: string; cid?: string }> = [];

    let opIdx = 0;
    for (const op of params.ops) {
      const uri = `${params.spaceUri}/${params.repoDid}/${op.collection}/${op.rkey}`;
      const prevRow = this.db
        .prepare(
          "SELECT cid, value, incarnation FROM space_record WHERE space_uri = ? AND repo_did = ? AND collection = ? AND rkey = ?",
        )
        .get(params.spaceUri, params.repoDid, op.collection, op.rkey) as
        | { cid: string; value: string; incarnation: string | null }
        | undefined;

      if (op.action === "delete") {
        if (!prevRow) {
          results.push({ uri });
          continue;
        }
        repoCommit.remove(op.collection as NsidString, op.rkey as RecordKeyString, parseCid(prevRow.cid));
        this.db
          .prepare("DELETE FROM space_record WHERE space_uri = ? AND repo_did = ? AND collection = ? AND rkey = ?")
          .run(params.spaceUri, params.repoDid, op.collection, op.rkey);
        this.db
          .prepare("DELETE FROM space_record_blob WHERE group_did = ? AND space_uri = ? AND record_uri = ?")
          .run(params.groupDid, params.spaceUri, uri);
        this.db
          .prepare(
            `INSERT INTO space_oplog (space_uri, repo_did, rev, idx, action, uri, collection, rkey, cid, prev)
             VALUES (?, ?, ?, ?, 'delete', ?, ?, ?, NULL, ?)`,
          )
          .run(params.spaceUri, params.repoDid, nextRev, opIdx++, uri, op.collection, op.rkey, prevRow.cid);
        results.push({ uri });
      } else {
        const cborBytes = op.cborBytes!;
        const cidStr = op.cidStr!;
        if (prevRow) {
          if (prevRow.cid === cidStr) {
            results.push({ uri, cid: cidStr });
            continue;
          }
          repoCommit.remove(op.collection as NsidString, op.rkey as RecordKeyString, parseCid(prevRow.cid));
        }
        repoCommit.add(op.collection as NsidString, op.rkey as RecordKeyString, parseCid(cidStr));
        const incarnation =
          op.incarnation !== undefined ? op.incarnation : prevRow?.incarnation ?? null;
        this.db
          .prepare(
            `INSERT INTO space_record (space_uri, repo_did, collection, rkey, uri, cid, value, cbor_bytes, repo_rev, indexed_at, incarnation)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(space_uri, repo_did, collection, rkey) DO UPDATE SET
               cid = excluded.cid,
               value = excluded.value,
               cbor_bytes = excluded.cbor_bytes,
               repo_rev = excluded.repo_rev,
               indexed_at = excluded.indexed_at,
               incarnation = excluded.incarnation`,
          )
          .run(
            params.spaceUri,
            params.repoDid,
            op.collection,
            op.rkey,
            uri,
            cidStr,
            JSON.stringify(op.value),
            Buffer.from(cborBytes),
            nextRev,
            params.nowMs,
            incarnation,
          );
        this.db
          .prepare("DELETE FROM space_record_blob WHERE group_did = ? AND space_uri = ? AND record_uri = ?")
          .run(params.groupDid, params.spaceUri, uri);
        for (const blobCid of collectBlobCidsFromValue(op.value)) {
          this.db
            .prepare("INSERT OR IGNORE INTO space_record_blob (group_did, space_uri, record_uri, blob_cid) VALUES (?, ?, ?, ?)")
            .run(params.groupDid, params.spaceUri, uri, blobCid);
        }
        this.db
          .prepare(
            `INSERT INTO space_oplog (space_uri, repo_did, rev, idx, action, uri, collection, rkey, cid, prev)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            params.spaceUri,
            params.repoDid,
            nextRev,
            opIdx++,
            prevRow ? "update" : "create",
            uri,
            op.collection,
            op.rkey,
            cidStr,
            prevRow?.cid ?? null,
          );
        results.push({ uri, cid: cidStr });
      }
    }

    if (opIdx === 0 && existingRepo) {
      return {
        rev: existingRepo.rev,
        digest: RepoCommit.fromState(new Uint8Array(existingRepo.set_hash)).setHash.digest(),
        results,
      };
    }

    const newStateBytes = repoCommit.setHash.state();
    const digest = repoCommit.setHash.digest();
    this.db
      .prepare(
        `INSERT INTO space_repo (space_uri, repo_did, set_hash, rev)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(space_uri, repo_did) DO UPDATE SET set_hash = excluded.set_hash, rev = excluded.rev`,
      )
      .run(params.spaceUri, params.repoDid, Buffer.from(newStateBytes), nextRev);

    if (params.isOwnAuthoritySpace) {
      const spaceRev = this.bumpGroupSpaceRevSync(params.spaceUri, params.nowMs);
      this.db
        .prepare(
          `INSERT INTO space_writer (space_uri, group_did, writer_did, removed, repo_rev, space_rev, data, updated_at)
           VALUES (?, ?, ?, 0, ?, ?, ?, ?)
           ON CONFLICT(space_uri, writer_did) DO UPDATE SET
             removed = 0, repo_rev = excluded.repo_rev, space_rev = excluded.space_rev, data = excluded.data, updated_at = excluded.updated_at`,
        )
        .run(params.spaceUri, params.groupDid, params.repoDid, nextRev, spaceRev, Buffer.from(digest), params.nowMs);

      if (!params.suppressNotices) {
        this.enqueueSyncerSpaceUpdateSync({
          groupDid: params.groupDid,
          spaceUri: params.spaceUri,
          update: {
            $type: "com.atproto.space.defs#repoWrite",
            repo: params.repoDid,
            repoRev: nextRev,
            spaceRev,
            data: lexToJson(digest),
          },
          nowMs: params.nowMs,
        });
      }
    }

    return { rev: nextRev, digest, results };
  }

  bumpGroupSpaceRevSync(spaceUriValue: string, nowMs: number): string {
    const row = this.db
      .prepare("SELECT space_rev FROM group_space WHERE space_uri = ?")
      .get(spaceUriValue) as { space_rev: string } | undefined;
    const nextRev = nextMonotonicTid(row?.space_rev ?? null);
    this.db
      .prepare("UPDATE group_space SET space_rev = ?, updated_at = ? WHERE space_uri = ?")
      .run(nextRev, nowMs, spaceUriValue);
    return nextRev;
  }

  enqueueSyncerSpaceUpdateSync(params: {
    groupDid: string;
    spaceUri: string;
    update: Record<string, unknown>;
    nowMs: number;
  }): void {
    const spRow = this.db
      .prepare("SELECT space_rev FROM group_space WHERE space_uri = ?")
      .get(params.spaceUri) as { space_rev: string } | undefined;
    const currentSpaceRev =
      (typeof params.update.spaceRev === "string" ? params.update.spaceRev : spRow?.space_rev) ?? nextMonotonicTid();

    const regs = this.db
      .prepare("SELECT endpoint, token, expires_at, lapsed_notified FROM notify_registration WHERE space_uri = ?")
      .all(params.spaceUri) as Array<{
      endpoint: string;
      token: string;
      expires_at: number;
      lapsed_notified: number;
    }>;

    const isSpaceDeleted =
      params.update.$type === "com.atproto.space.notifySpaceUpdate#spaceDeleted" ||
      params.update.$type === "com.atproto.space.defs#spaceDeleted";
    const normalizedUpdate = isSpaceDeleted
      ? { $type: "com.atproto.space.notifySpaceUpdate#spaceDeleted" }
      : params.update;

    for (const reg of regs) {
      const coalesceKey = `syncer\u0000${params.spaceUri}\u0000${reg.endpoint}\u0000${reg.token}`;
      if (!isSpaceDeleted && reg.expires_at <= params.nowMs) {
        if (reg.lapsed_notified === 0) {
          this.db
            .prepare("UPDATE notify_registration SET lapsed_notified = 1 WHERE space_uri = ? AND endpoint = ? AND token = ?")
            .run(params.spaceUri, reg.endpoint, reg.token);
          this.upsertOutboxNoticeSync({
            kind: "syncer_update",
            groupDid: params.groupDid,
            coalesceKey,
            endpoint: reg.endpoint,
            token: reg.token,
            spaceUri: params.spaceUri,
            payload: {
              space: params.spaceUri,
              token: reg.token,
              update: {
                $type: "com.atproto.space.notifySpaceUpdate#registrationExpired",
                spaceRev: currentSpaceRev,
              },
            },
            nowMs: params.nowMs,
            expiresAt: params.nowMs + 60_000,
          });
        }
        continue;
      }

      this.upsertOutboxNoticeSync({
        kind: "syncer_update",
        groupDid: params.groupDid,
        coalesceKey,
        endpoint: reg.endpoint,
        token: reg.token,
        spaceUri: params.spaceUri,
        payload: {
          space: params.spaceUri,
          token: reg.token,
          update: normalizedUpdate,
        },
        nowMs: params.nowMs,
        expiresAt: params.nowMs + 60_000,
      });
    }
  }

  upsertOutboxNoticeSync(params: {
    kind: "syncer_update" | "credential_revocation" | "invite_repo_update" | "source_migration_finalize";
    groupDid: string;
    coalesceKey: string | null;
    endpoint: string;
    token?: string | null;
    spaceUri?: string | null;
    writerDid?: string | null;
    payload: Record<string, unknown>;
    maxAttempts?: number;
    nowMs: number;
    expiresAt: number;
  }): void {
    const id = randomUUID();
    const maxAttempts = params.maxAttempts ?? 5;
    if (params.coalesceKey) {
      this.db
        .prepare(
          `INSERT INTO outbox_notice (
             id, kind, group_did, coalesce_key, endpoint, token, space_uri, writer_did,
             payload_json, status, attempts, max_attempts, lease_until, next_attempt_at, expires_at, last_error, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, ?, ?, NULL, ?)
           ON CONFLICT(coalesce_key) DO UPDATE SET
             endpoint = excluded.endpoint,
             token = excluded.token,
             payload_json = excluded.payload_json,
             status = 'pending',
             attempts = 0,
             max_attempts = excluded.max_attempts,
             lease_until = NULL,
             next_attempt_at = excluded.next_attempt_at,
             expires_at = excluded.expires_at,
             last_error = NULL,
             created_at = excluded.created_at`,
        )
        .run(
          id,
          params.kind,
          params.groupDid,
          params.coalesceKey,
          params.endpoint,
          params.token ?? null,
          params.spaceUri ?? null,
          params.writerDid ?? null,
          JSON.stringify(params.payload),
          maxAttempts,
          params.nowMs,
          params.expiresAt,
          params.nowMs,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO outbox_notice (
             id, kind, group_did, coalesce_key, endpoint, token, space_uri, writer_did,
             payload_json, status, attempts, max_attempts, lease_until, next_attempt_at, expires_at, last_error, created_at
           ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, ?, ?, NULL, ?)`,
        )
        .run(
          id,
          params.kind,
          params.groupDid,
          params.endpoint,
          params.token ?? null,
          params.spaceUri ?? null,
          params.writerDid ?? null,
          JSON.stringify(params.payload),
          maxAttempts,
          params.nowMs,
          params.expiresAt,
          params.nowMs,
        );
    }
  }

  /**
   * Evicts a writer from `spaceUri` (`removeWriter` / policy write-loss / membership removal),
   * recording `last_evicted_repo_rev` + incrementing `prior_eject_count` on `members/self`
   * and enqueueing `#repoRemoved`!
   */
  evictWriterFromSpaceSync(params: {
    groupDid: string;
    spaceUri: string;
    writerDid: string;
    incrementEjectCount?: boolean;
    suppressNotices?: boolean;
    nowMs: number;
  }): boolean {
    if (params.writerDid === params.groupDid) return false;
    const existing = this.db
      .prepare("SELECT removed, repo_rev, prior_eject_count FROM space_writer WHERE space_uri = ? AND writer_did = ?")
      .get(params.spaceUri, params.writerDid) as
      | { removed: number; repo_rev: string; prior_eject_count: number }
      | undefined;

    if (!existing) {
      if (params.incrementEjectCount) {
        // Record prior_eject_count even if member never notified a repo commit before ejection!
        const spaceRev = this.bumpGroupSpaceRevSync(params.spaceUri, params.nowMs);
        this.db
          .prepare(
            `INSERT INTO space_writer (space_uri, group_did, writer_did, removed, repo_rev, last_evicted_repo_rev, prior_eject_count, space_rev, data, updated_at)
             VALUES (?, ?, ?, 1, '', NULL, 1, ?, NULL, ?)`,
          )
          .run(params.spaceUri, params.groupDid, params.writerDid, spaceRev, params.nowMs);
      }
      return false;
    }

    if (existing.removed !== 0) {
      if (params.incrementEjectCount) {
        this.db
          .prepare("UPDATE space_writer SET prior_eject_count = prior_eject_count + 1, updated_at = ? WHERE space_uri = ? AND writer_did = ?")
          .run(params.nowMs, params.spaceUri, params.writerDid);
      }
      return false;
    }

    const spaceRev = this.bumpGroupSpaceRevSync(params.spaceUri, params.nowMs);
    const nextEjectCount = existing.prior_eject_count + (params.incrementEjectCount ? 1 : 0);
    const lastEvictedRev = existing.repo_rev !== "" ? existing.repo_rev : null;

    this.db
      .prepare(
        `UPDATE space_writer
         SET removed = 1,
             last_evicted_repo_rev = COALESCE(?, last_evicted_repo_rev),
             prior_eject_count = ?,
             space_rev = ?,
             data = NULL,
             updated_at = ?
         WHERE space_uri = ? AND writer_did = ?`,
      )
      .run(lastEvictedRev, nextEjectCount, spaceRev, params.nowMs, params.spaceUri, params.writerDid);

    if (!params.suppressNotices) {
      this.enqueueSyncerSpaceUpdateSync({
        groupDid: params.groupDid,
        spaceUri: params.spaceUri,
        update: {
          $type: "com.atproto.space.defs#repoRemoved",
          repo: params.writerDid,
          spaceRev,
        },
        nowMs: params.nowMs,
      });
    }
    return true;
  }

  /**
   * Reconciles writers across all non-deleted spaces of `groupDid` after any role/membership/policy mutation:
   * any writer in `space_writer` (`removed === 0`) who no longer holds `liveRoleGrantsWrite` is evicted!
   */
  reconcileAllSpaceWritersSync(groupDid: string, postState: LiveGroupGovernanceState, nowMs: number, suppressNotices = false): void {
    const activeWriters = this.db
      .prepare("SELECT space_uri, writer_did FROM space_writer WHERE group_did = ? AND removed = 0")
      .all(groupDid) as Array<{ space_uri: string; writer_did: string }>;

    const membersSpace = groupMembersUri(groupDid);
    for (const w of activeWriters) {
      if (w.writer_did === groupDid) continue;
      if (!liveRoleGrantsWrite(postState, w.space_uri, w.writer_did, groupDid)) {
        this.evictWriterFromSpaceSync({
          groupDid,
          spaceUri: w.space_uri,
          writerDid: w.writer_did,
          incrementEjectCount: w.space_uri === membersSpace && !postState.memberships.has(w.writer_did),
          suppressNotices,
          nowMs,
        });
      }
    }

    // Also revoke any unexpired issued space credentials whose grantee no longer holds live `read` authorization!
    const nowSec = Math.floor(nowMs / 1000);
    const liveCreds = this.db
      .prepare("SELECT jti, space_uri, writer_did, exp FROM issued_credential WHERE group_did = ? AND exp > ?")
      .all(groupDid, nowSec) as Array<{
      jti: string;
      space_uri: string;
      writer_did: string | null;
      exp: number;
    }>;
    if (liveCreds.length > 0) {
      const insRevoked = this.db.prepare(
        "INSERT OR REPLACE INTO revoked_credential (jti, group_did, space_uri, exp, revoked_at) VALUES (?, ?, ?, ?, ?)",
      );
      const delIssued = this.db.prepare("DELETE FROM issued_credential WHERE jti = ?");
      const bySpaceAndTarget = new Map<string, { spaceUri: string; targetDid: string; jtis: string[] }>();

      for (const c of liveCreds) {
        const stillReadable = liveRoleGrantsRead(postState, c.space_uri, c.writer_did ?? "", groupDid);
        if (stillReadable) continue;
        insRevoked.run(c.jti, groupDid, c.space_uri, c.exp, nowMs);
        delIssued.run(c.jti);
        if (!suppressNotices) {
          const targets = new Set<string>();
          if (c.writer_did && c.writer_did !== groupDid) targets.add(c.writer_did);
          const spaceExternalWriters = this.db
            .prepare("SELECT writer_did FROM space_writer WHERE space_uri = ? AND removed = 0 AND writer_did != ?")
            .all(c.space_uri, groupDid) as Array<{ writer_did: string }>;
          for (const sw of spaceExternalWriters) targets.add(sw.writer_did);

          for (const targetDid of targets) {
            const key = `${c.space_uri}\u0000${targetDid}`;
            let bucket = bySpaceAndTarget.get(key);
            if (!bucket) {
              bucket = { spaceUri: c.space_uri, targetDid, jtis: [] };
              bySpaceAndTarget.set(key, bucket);
            }
            bucket.jtis.push(c.jti);
          }
        }
      }

      if (!suppressNotices) {
        for (const bucket of bySpaceAndTarget.values()) {
          for (let i = 0; i < bucket.jtis.length; i += 100) {
            const chunk = bucket.jtis.slice(i, i + 100);
            const batchUuid = randomUUID();
            this.upsertOutboxNoticeSync({
              kind: "credential_revocation",
              groupDid,
              coalesceKey: `credrev\u0000${batchUuid}`,
              endpoint: bucket.targetDid,
              spaceUri: bucket.spaceUri,
              writerDid: bucket.targetDid,
              payload: {
                space: bucket.spaceUri,
                credentials: chunk,
              },
              maxAttempts: 5,
              nowMs,
              expiresAt: nowMs + 30_000,
            });
          }
        }
      }
    }
  }

  /**
   * Revokes unexpired `issued_credential` JTIs for `groupDid` (or a specific space) and enqueues
   * `<= 100`-JTI batched `credential_revocation` outbox rows (`aud = bare <writerDid>`).
   */
  revokeIssuedCredentialsSync(params: {
    groupDid: string;
    spaceUri?: string;
    enqueueNotices: boolean;
    nowMs: number;
  }): void {
    const nowSec = Math.floor(params.nowMs / 1000);
    const creds = params.spaceUri
      ? (this.db
          .prepare(
            "SELECT jti, space_uri, writer_did, exp FROM issued_credential WHERE group_did = ? AND space_uri = ? AND exp > ?",
          )
          .all(params.groupDid, params.spaceUri, nowSec) as Array<{
          jti: string;
          space_uri: string;
          writer_did: string | null;
          exp: number;
        }>)
      : (this.db
          .prepare("SELECT jti, space_uri, writer_did, exp FROM issued_credential WHERE group_did = ? AND exp > ?")
          .all(params.groupDid, nowSec) as Array<{
          jti: string;
          space_uri: string;
          writer_did: string | null;
          exp: number;
        }>);

    if (creds.length === 0) return;

    const insRevoked = this.db.prepare(
      "INSERT OR REPLACE INTO revoked_credential (jti, group_did, space_uri, exp, revoked_at) VALUES (?, ?, ?, ?, ?)",
    );
    const delIssued = this.db.prepare("DELETE FROM issued_credential WHERE jti = ?");
    const selExternalWriters = this.db.prepare(
      "SELECT writer_did FROM space_writer WHERE space_uri = ? AND removed = 0 AND writer_did != ?",
    );
    const externalWritersCache = new Map<string, string[]>();
    const bySpaceAndTarget = new Map<string, { spaceUri: string; targetDid: string; jtis: Set<string> }>();

    for (const c of creds) {
      insRevoked.run(c.jti, params.groupDid, c.space_uri, c.exp, params.nowMs);
      delIssued.run(c.jti);
      if (params.enqueueNotices) {
        let extWriters = externalWritersCache.get(c.space_uri);
        if (!extWriters) {
          extWriters = (
            selExternalWriters.all(c.space_uri, params.groupDid) as Array<{ writer_did: string }>
          ).map((r) => r.writer_did);
          externalWritersCache.set(c.space_uri, extWriters);
        }

        const targets = new Set<string>();
        if (c.writer_did && c.writer_did !== params.groupDid) {
          targets.add(c.writer_did);
        }
        for (const writerDid of extWriters) {
          targets.add(writerDid);
        }

        for (const targetDid of targets) {
          const key = `${c.space_uri}\u0000${targetDid}`;
          let bucket = bySpaceAndTarget.get(key);
          if (!bucket) {
            bucket = { spaceUri: c.space_uri, targetDid, jtis: new Set<string>() };
            bySpaceAndTarget.set(key, bucket);
          }
          bucket.jtis.add(c.jti);
        }
      }
    }

    if (params.enqueueNotices) {
      for (const bucket of bySpaceAndTarget.values()) {
        const allJtis = [...bucket.jtis];
        for (let i = 0; i < allJtis.length; i += 100) {
          const chunk = allJtis.slice(i, i + 100);
          const batchUuid = randomUUID();
          this.upsertOutboxNoticeSync({
            kind: "credential_revocation",
            groupDid: params.groupDid,
            coalesceKey: `credrev\u0000${batchUuid}`,
            endpoint: bucket.targetDid, // Resolved dynamically via PLC/DID doc during outbox delivery!
            spaceUri: bucket.spaceUri,
            writerDid: bucket.targetDid,
            payload: {
              space: bucket.spaceUri,
              credentials: chunk,
            },
            maxAttempts: 5,
            nowMs: params.nowMs,
            expiresAt: params.nowMs + 30_000,
          });
        }
      }
    }
  }

  // =========================================================================
  // Space CRUD (`createSpace`, `getSpace`, `updateSpace`, `deleteSpace`, `removeWriter`, `listSpaces`)
  // =========================================================================

  async createOrUpdateSpace(params: {
    mode: "create" | "update";
    groupDid: string;
    actorDid: string;
    session?: AuthenticatedGroupSession;
    spaceType: string;
    skey: string;
    policy: Record<string, unknown>;
    suppressNotices?: boolean;
    nowMs?: number;
  }): Promise<{ space: string; uri: string; policy: GroupAtgrpPolicy }> {
    const nowMs = params.nowMs ?? Date.now();
    const keyCheck = validateSpaceTypeKey(params.spaceType, params.skey, { isGroupHostOwnSpace: true });
    if (!keyCheck.valid) {
      throw new GroupHostHttpError(400, keyCheck.code ?? "InvalidSpaceKey", keyCheck.reason);
    }
    const polCheck = validateSpacePolicy(params.policy, {
      groupDid: params.groupDid,
      spaceType: params.spaceType,
      skey: params.skey,
    });
    if (!polCheck.valid) {
      throw new GroupHostHttpError(400, polCheck.code ?? "InvalidSpacePolicy", polCheck.reason);
    }
    const normalizedPolicy: GroupAtgrpPolicy = {
      $type: ATGRP_POLICY,
      publicRead: params.policy.publicRead === true,
      unlisted: params.policy.unlisted === true,
      grants: (params.policy.grants as GroupAtgrpPolicy["grants"]).map((g) => ({
        role: g.role,
        ...(g.read !== undefined ? { read: Boolean(g.read) } : {}),
        ...(g.write !== undefined ? { write: Boolean(g.write) } : {}),
        ...(g.permissions && g.permissions.length > 0 ? { permissions: [...g.permissions] } : {}),
      })),
    };

    const targetSpaceUri = spaceUri(params.groupDid, params.spaceType, params.skey);
    const isCoreSpace =
      params.spaceType === ATGRP_SPACE_TYPE.meta ||
      params.spaceType === ATGRP_SPACE_TYPE.members;

    // Pre-serialize `com.atproto.space.policy/self` CBOR + optional `org.atgrp.space/<tid>` CBOR outside transaction!
    const policyRecordValue = {
      $type: ATPROTO_SPACE_COLLECTION.spacePolicy,
      policy: normalizedPolicy,
    };
    const serializedPolicy = await serializeRecord(
      ATPROTO_SPACE_COLLECTION.spacePolicy as NsidString,
      SELF_SKEY as RecordKeyString,
      jsonToLex(policyRecordValue) as LexMap,
    );

    const candidateIndexRkey = tidNow(nowMs);
    const nowIso = new Date(nowMs).toISOString();
    const indexRecordValue = {
      $type: ATGRP_COLLECTION.space,
      space: targetSpaceUri,
      createdAt: nowIso,
    };
    const serializedIndex = !isCoreSpace
      ? await serializeRecord(
          ATGRP_COLLECTION.space as NsidString,
          candidateIndexRkey as RecordKeyString,
          jsonToLex(indexRecordValue) as LexMap,
        )
      : null;

    return this.locks.withGroupRepoLock(params.groupDid, async () => {
      const isMetaSelf = targetSpaceUri === groupMetaUri(params.groupDid);
      const hasRepoRoot = isMetaSelf
        ? Boolean(this.db.prepare("SELECT 1 AS ok FROM public_repo_root WHERE group_did = ?").get(params.groupDid))
        : false;
      let stagedMetaDeclOp:
        | {
            kind: "upsert";
            expectedExistingCid: string | null;
            storage: SqlStagingRepoStorage;
            commitData: CommitData;
            uri: string;
            cidStr: string;
            valueJson: string;
          }
        | {
            kind: "delete";
            expectedExistingCid: string;
            storage: SqlStagingRepoStorage;
            commitData: CommitData;
            uri: string;
          }
        | {
            kind: "noop";
            expectedExistingCid: string | null;
          }
        | null = null;

      if (isMetaSelf && hasRepoRoot) {
        const existingDecl = this.db
          .prepare("SELECT cid, value FROM public_record WHERE group_did = ? AND collection = ? AND rkey = ?")
          .get(params.groupDid, REPO_COLLECTION.groupDeclaration, SELF_SKEY) as
          | { cid: string; value: string }
          | undefined;
        const declUri = `at://${params.groupDid}/${REPO_COLLECTION.groupDeclaration}/${SELF_SKEY}`;
        if (normalizedPolicy.publicRead === true) {
          const prevDecl = existingDecl ? (JSON.parse(existingDecl.value) as Record<string, unknown>) : null;
          if (
            prevDecl &&
            prevDecl.$type === REPO_COLLECTION.groupDeclaration
          ) {
            stagedMetaDeclOp = { kind: "noop", expectedExistingCid: existingDecl!.cid };
          } else {
            const declValue: Record<string, unknown> = {
              $type: REPO_COLLECTION.groupDeclaration,
            };
            const storage = new SqlStagingRepoStorage(this.db, params.groupDid);
            const signingKey = await this.getGroupSigningKey(params.groupDid);
            const repo = await Repo.load(storage);
            const commitData = await repo.formatCommit(
              [
                {
                  action: existingDecl ? WriteOpAction.Update : WriteOpAction.Create,
                  collection: REPO_COLLECTION.groupDeclaration as NsidString,
                  rkey: SELF_SKEY,
                  record: jsonToLex(declValue) as LexMap,
                },
              ],
              signingKey,
            );
            await storage.applyCommit(commitData);
            const cidStr = (await cidForCbor(cborEncode(jsonToLex(declValue) as LexValue))).toString();
            stagedMetaDeclOp = {
              kind: "upsert",
              expectedExistingCid: existingDecl?.cid ?? null,
              storage,
              commitData,
              uri: declUri,
              cidStr,
              valueJson: JSON.stringify(declValue),
            };
          }
        } else if (existingDecl) {
          const storage = new SqlStagingRepoStorage(this.db, params.groupDid);
          const signingKey = await this.getGroupSigningKey(params.groupDid);
          const repo = await Repo.load(storage);
          const commitData = await repo.formatCommit(
            [
              {
                action: WriteOpAction.Delete,
                collection: REPO_COLLECTION.groupDeclaration as NsidString,
                rkey: SELF_SKEY,
              },
            ],
            signingKey,
          );
          await storage.applyCommit(commitData);
          stagedMetaDeclOp = {
            kind: "delete",
            expectedExistingCid: existingDecl.cid,
            storage,
            commitData,
            uri: declUri,
          };
        } else {
          stagedMetaDeclOp = { kind: "noop", expectedExistingCid: null };
        }
      }

      const tx = this.db.transaction(() => {
        reapExpiredPreparedMigrationLease(this.db, params.groupDid, nowMs);
        if (hasActiveSourceMigrationLease(this.db, params.groupDid, nowMs)) {
          throw new GroupHostHttpError(409, "MigrationInProgress", "Group is frozen during active migration.");
        }
        let preState: LiveGroupGovernanceState;
        if (params.session) {
          const revalidated = revalidateLiveOAuthSessionSync(this.db, params.session, { nowMs });
          revalidated.permissions.assertSpace(
            {
              spaceType: params.spaceType as NsidString,
              authority: params.groupDid as DidString,
              skey: params.skey as RecordKeyString,
            },
            { manage: params.mode },
          );
          preState = revalidated.liveState;
        } else {
          preState = loadLiveGovernanceState(this.db, params.groupDid);
        }
        assertPolicyWriteAntiEscalation(
          params.actorDid,
          preState,
          params.groupDid,
          params.spaceType,
          params.skey,
          normalizedPolicy,
        );

        const existingSpace = this.db
          .prepare("SELECT index_rkey, deleted_at FROM group_space WHERE space_uri = ?")
          .get(targetSpaceUri) as { index_rkey: string | null; deleted_at: number | null } | undefined;

        if (params.mode === "create") {
          if (existingSpace && existingSpace.deleted_at === null) {
            throw new GroupHostHttpError(400, "SpaceAlreadyExists", `Space already exists: ${targetSpaceUri}`);
          }
          if (existingSpace && existingSpace.deleted_at !== null) {
            throw new GroupHostHttpError(400, "SpaceDeleted", `Space was deleted: ${targetSpaceUri}`);
          }
        } else {
          if (!existingSpace) {
            throw new GroupHostHttpError(400, "SpaceNotFound", `Space not found: ${targetSpaceUri}`);
          }
          if (existingSpace.deleted_at !== null) {
            throw new GroupHostHttpError(400, "SpaceDeleted", `Space was deleted: ${targetSpaceUri}`);
          }
        }

        // Validate post-state invariants (role references in policy.grants)
        const postSpacePolicies = new Map(preState.spacePolicies);
        postSpacePolicies.set(targetSpaceUri, normalizedPolicy);
        const postState: LiveGroupGovernanceState = {
          ...preState,
          spacePolicies: postSpacePolicies,
          hasFlockWorkspace: preState.hasFlockWorkspace || targetSpaceUri === workspaceUri(params.groupDid),
        };
        assertPostGovernanceInvariants(preState, postState, params.groupDid);

        let nextIndexRkey = existingSpace?.index_rkey ?? null;
        if (!isCoreSpace) {
          if (!normalizedPolicy.unlisted && !nextIndexRkey) {
            nextIndexRkey = candidateIndexRkey;
          } else if (normalizedPolicy.unlisted && nextIndexRkey) {
            nextIndexRkey = null;
          }
        }

        const initialSpaceRev = nextMonotonicTid();
        if (params.mode === "create") {
          this.db
            .prepare(
              `INSERT INTO group_space (
                 space_uri, group_did, space_type, skey, policy_json, space_rev, index_rkey, deleted_at, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
            )
            .run(
              targetSpaceUri,
              params.groupDid,
              params.spaceType,
              params.skey,
              JSON.stringify(normalizedPolicy),
              initialSpaceRev,
              nextIndexRkey,
              nowMs,
              nowMs,
            );
        } else {
          this.db
            .prepare(
              "UPDATE group_space SET policy_json = ?, index_rkey = ?, updated_at = ? WHERE space_uri = ?",
            )
            .run(JSON.stringify(normalizedPolicy), nextIndexRkey, nowMs, targetSpaceUri);
        }

        // Auto-publish com.atproto.space.policy/self in `<groupDid>`'s repo inside `targetSpaceUri`
        this.applySpaceRepoMutationsSync({
          groupDid: params.groupDid,
          spaceUri: targetSpaceUri,
          repoDid: params.groupDid,
          ops: [
            {
              action: params.mode === "create" ? "create" : "update",
              collection: ATPROTO_SPACE_COLLECTION.spacePolicy,
              rkey: SELF_SKEY,
              value: policyRecordValue,
              cborBytes: serializedPolicy.bytes,
              cidStr: serializedPolicy.cid.toString(),
            },
          ],
          isOwnAuthoritySpace: true,
          suppressNotices: params.suppressNotices,
          nowMs,
        });

        // Atomically couple `meta/self` `policy.publicRead` <-> `org.atgrp.declaration/self` in the public MST repo!
        if (stagedMetaDeclOp !== null) {
          const liveDecl = this.db
            .prepare("SELECT cid FROM public_record WHERE group_did = ? AND collection = ? AND rkey = ?")
            .get(params.groupDid, REPO_COLLECTION.groupDeclaration, SELF_SKEY) as { cid: string } | undefined;
          if ((liveDecl?.cid ?? null) !== stagedMetaDeclOp.expectedExistingCid) {
            throw new GroupHostHttpError(400, "InvalidSwap", "Concurrent modification of org.atgrp.declaration/self.");
          }
          if (stagedMetaDeclOp.kind === "upsert") {
            stagedMetaDeclOp.storage.flushStagedSync(nowMs, stagedMetaDeclOp.commitData.removedCids.toList());
            this.db
              .prepare("DELETE FROM public_record_blob WHERE group_did = ? AND record_uri = ?")
              .run(params.groupDid, stagedMetaDeclOp.uri);
            this.db
              .prepare(
                `INSERT INTO public_record (group_did, collection, rkey, uri, cid, value, rev, indexed_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(group_did, collection, rkey) DO UPDATE SET
                   cid = excluded.cid, value = excluded.value, rev = excluded.rev, indexed_at = excluded.indexed_at`,
              )
              .run(
                params.groupDid,
                REPO_COLLECTION.groupDeclaration,
                SELF_SKEY,
                stagedMetaDeclOp.uri,
                stagedMetaDeclOp.cidStr,
                stagedMetaDeclOp.valueJson,
                stagedMetaDeclOp.commitData.rev,
                nowMs,
              );
          } else if (stagedMetaDeclOp.kind === "delete") {
            stagedMetaDeclOp.storage.flushStagedSync(nowMs, stagedMetaDeclOp.commitData.removedCids.toList());
            this.db
              .prepare("DELETE FROM public_record_blob WHERE group_did = ? AND record_uri = ?")
              .run(params.groupDid, stagedMetaDeclOp.uri);
            this.db
              .prepare("DELETE FROM public_record WHERE group_did = ? AND collection = ? AND rkey = ?")
              .run(params.groupDid, REPO_COLLECTION.groupDeclaration, SELF_SKEY);
          }
        }

        // Maintain host-managed `org.atgrp.space/<tid>` index in `members/self`
        if (!isCoreSpace) {
          const membersSpace = groupMembersUri(params.groupDid);
          const membersExists = this.db
            .prepare("SELECT 1 AS ok FROM group_space WHERE space_uri = ? AND deleted_at IS NULL")
            .get(membersSpace);
          if (membersExists) {
            if (!normalizedPolicy.unlisted && !existingSpace?.index_rkey && serializedIndex && nextIndexRkey) {
              this.applySpaceRepoMutationsSync({
                groupDid: params.groupDid,
                spaceUri: membersSpace,
                repoDid: params.groupDid,
                ops: [
                  {
                    action: "create",
                    collection: ATGRP_COLLECTION.space,
                    rkey: nextIndexRkey,
                    value: indexRecordValue,
                    cborBytes: serializedIndex.bytes,
                    cidStr: serializedIndex.cid.toString(),
                  },
                ],
                isOwnAuthoritySpace: true,
                suppressNotices: params.suppressNotices,
                nowMs,
              });
            } else if (normalizedPolicy.unlisted && existingSpace?.index_rkey) {
              this.applySpaceRepoMutationsSync({
                groupDid: params.groupDid,
                spaceUri: membersSpace,
                repoDid: params.groupDid,
                ops: [
                  {
                    action: "delete",
                    collection: ATGRP_COLLECTION.space,
                    rkey: existingSpace.index_rkey,
                  },
                ],
                isOwnAuthoritySpace: true,
                suppressNotices: params.suppressNotices,
                nowMs,
              });
            }
          }
        }

        // Reconcile writer evictions if policy write grants changed
        this.reconcileAllSpaceWritersSync(params.groupDid, postState, nowMs, params.suppressNotices);

        return { space: targetSpaceUri, uri: targetSpaceUri, policy: normalizedPolicy };
      });
      return tx.immediate();
    });
  }

  async deleteSpace(params: {
    groupDid: string;
    session?: AuthenticatedGroupSession;
    spaceUri: string;
    nowMs?: number;
  }): Promise<void> {
    const nowMs = params.nowMs ?? Date.now();
    const parsed = parseSpaceUri(params.spaceUri);
    if (!parsed || parsed.authorityDid !== params.groupDid) {
      throw new GroupHostHttpError(400, "InvalidRequest", "Space does not belong to this group.");
    }
    if (
      parsed.type === ATGRP_SPACE_TYPE.meta ||
      parsed.type === ATGRP_SPACE_TYPE.members
    ) {
      throw new GroupHostHttpError(400, "CannotDeleteCoreSpace", `Core Atmosphere Group space ${parsed.type} cannot be deleted.`);
    }

    return this.locks.withGroupRepoLock(params.groupDid, () => {
      const tx = this.db.transaction(() => {
        reapExpiredPreparedMigrationLease(this.db, params.groupDid, nowMs);
        if (hasActiveSourceMigrationLease(this.db, params.groupDid, nowMs)) {
          throw new GroupHostHttpError(409, "MigrationInProgress", "Group is frozen during active migration.");
        }
        if (params.session) {
          const { permissions: commitPerms } = revalidateLiveOAuthSessionSync(this.db, params.session, { nowMs });
          commitPerms.assertSpace(
            {
              spaceType: parsed.type as NsidString,
              authority: params.groupDid as DidString,
              skey: parsed.skey as RecordKeyString,
            },
            { manage: "delete" },
          );
        }
        const existing = this.db
          .prepare("SELECT index_rkey, deleted_at FROM group_space WHERE space_uri = ? AND group_did = ?")
          .get(params.spaceUri, params.groupDid) as { index_rkey: string | null; deleted_at: number | null } | undefined;
        if (!existing) {
          throw new GroupHostHttpError(400, "SpaceNotFound", `Space not found: ${params.spaceUri}`);
        }
        if (existing.deleted_at !== null) {
          return;
        }

        // Protect Flock workspace/self whenever `known_app_subject` is non-empty!
        if (params.spaceUri === workspaceUri(params.groupDid)) {
          const hasApps = this.db
            .prepare("SELECT 1 AS ok FROM known_app_subject WHERE group_did = ? LIMIT 1")
            .get(params.groupDid);
          if (hasApps) {
            throw new GroupHostHttpError(
              400,
              "CannotDeleteWorkspaceWithAppTombstones",
              "Cannot delete Flock workspace/self while known_app_subject tombstones exist.",
            );
          }
        }

        // Remove from `group.opensocial.space` index in `members/self`
        if (existing.index_rkey) {
          this.applySpaceRepoMutationsSync({
            groupDid: params.groupDid,
            spaceUri: groupMembersUri(params.groupDid),
            repoDid: params.groupDid,
            ops: [
              {
                action: "delete",
                collection: ATGRP_COLLECTION.space,
                rkey: existing.index_rkey,
              },
            ],
            isOwnAuthoritySpace: true,
            nowMs,
          });
        }

        this.enqueueSyncerSpaceUpdateSync({
          groupDid: params.groupDid,
          spaceUri: params.spaceUri,
          update: { $type: "com.atproto.space.defs#spaceDeleted" },
          nowMs,
        });
        this.revokeIssuedCredentialsSync({
          groupDid: params.groupDid,
          spaceUri: params.spaceUri,
          enqueueNotices: true,
          nowMs,
        });

        this.db.prepare("DELETE FROM notify_registration WHERE space_uri = ?").run(params.spaceUri);
        this.db.prepare("DELETE FROM space_record_blob WHERE space_uri = ?").run(params.spaceUri);
        this.db.prepare("DELETE FROM space_record WHERE space_uri = ?").run(params.spaceUri);
        this.db.prepare("DELETE FROM space_oplog WHERE space_uri = ?").run(params.spaceUri);
        this.db.prepare("DELETE FROM space_repo WHERE space_uri = ?").run(params.spaceUri);
        this.db.prepare("DELETE FROM space_writer WHERE space_uri = ?").run(params.spaceUri);
        this.db
          .prepare("UPDATE group_space SET deleted_at = ?, index_rkey = NULL, updated_at = ? WHERE space_uri = ?")
          .run(nowMs, nowMs, params.spaceUri);
      });
      tx.immediate();
    });
  }

  // =========================================================================
  // Space Record Writes (`space.putRecord`, `createRecord`, `applyWrites`, `deleteRecord`, `clearRecords`)
  // =========================================================================

  async applySpaceWrites(params: {
    groupDid: string;
    actorDid: string;
    session?: AuthenticatedGroupSession;
    spaceUri: string;
    writes: readonly SpaceWriteInputOp[];
    buildWrites?: () => readonly SpaceWriteInputOp[];
    skipMaxWritesCap?: boolean;
    extraCommitSpaceCheck?: (
      perms: EffectiveSessionPermissions,
      target: { spaceType: NsidString; authority: DidString; skey: RecordKeyString },
    ) => void;
    isPutRecord?: boolean;
    putSwapRecord?: string | null;
    ifJoinRequestPresent?: boolean;
    nowMs?: number;
  }): Promise<{
    commit: { rev: string };
    results: Array<{ uri: string; cid?: string; $type?: string; validationStatus?: string }>;
  }> {
    const nowMs = params.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    if (!params.skipMaxWritesCap && params.writes.length > MAX_WRITES_PER_APPLY) {
      throw new GroupHostHttpError(400, "InvalidRequest", `Too many writes (max ${MAX_WRITES_PER_APPLY}).`);
    }

    const parsedSpace = parseSpaceUri(params.spaceUri);
    if (!parsedSpace) {
      throw new GroupHostHttpError(400, "InvalidRequest", `Invalid space URI: ${params.spaceUri}`);
    }
    const isOwnAuthoritySpace = parsedSpace.authorityDid === params.groupDid;
    const spaceKeyCheck = validateSpaceTypeKey(parsedSpace.type, parsedSpace.skey, {
      isGroupHostOwnSpace: isOwnAuthoritySpace,
    });
    if (!spaceKeyCheck.valid) {
      throw new GroupHostHttpError(400, spaceKeyCheck.code ?? "InvalidSpaceKey", spaceKeyCheck.reason);
    }
    if (!isOwnAuthoritySpace && parsedSpace.type !== ATGRP_SPACE_TYPE.inbox) {
      throw new GroupHostHttpError(400, "InvalidRequest", "Group Host only writes to own group spaces or external org.atgrp.inbox/self spaces.");
    }

    // Lock sorted([groupDid, parsedSpace.authorityDid]) if target space authority is also hosted locally!
    const lockDids = [params.groupDid];
    if (!isOwnAuthoritySpace) {
      const localOther = this.db
        .prepare("SELECT 1 AS ok FROM group_account WHERE did = ?")
        .get(parsedSpace.authorityDid);
      if (localOther) lockDids.push(parsedSpace.authorityDid);
    }

    return this.locks.withSortedGroupRepoLocks(lockDids, async () => {
      reapExpiredPreparedMigrationLease(this.db, params.groupDid, nowMs);
      if (hasActiveSourceMigrationLease(this.db, params.groupDid, nowMs)) {
        throw new GroupHostHttpError(409, "MigrationInProgress", "Group is frozen during active migration.");
      }

      if (isOwnAuthoritySpace) {
        const spRow = this.db
          .prepare("SELECT deleted_at FROM group_space WHERE space_uri = ? AND group_did = ?")
          .get(params.spaceUri, params.groupDid) as { deleted_at: number | null } | undefined;
        if (!spRow) throw new GroupHostHttpError(400, "SpaceNotFound", `Space not found: ${params.spaceUri}`);
        if (spRow.deleted_at !== null) throw new GroupHostHttpError(400, "SpaceDeleted", `Space deleted: ${params.spaceUri}`);
      }

      const resolvedWrites = params.buildWrites ? params.buildWrites() : params.writes;
      if (!params.skipMaxWritesCap && resolvedWrites.length > MAX_WRITES_PER_APPLY) {
        throw new GroupHostHttpError(400, "InvalidRequest", `Too many writes (max ${MAX_WRITES_PER_APPLY}).`);
      }

      const spaceTarget = {
        spaceType: parsedSpace.type as NsidString,
        authority: parsedSpace.authorityDid as DidString,
        skey: parsedSpace.skey as RecordKeyString,
      };

      if (resolvedWrites.length === 0) {
        const rev = this.db
          .transaction(() => {
            reapExpiredPreparedMigrationLease(this.db, params.groupDid, nowMs);
            if (hasActiveSourceMigrationLease(this.db, params.groupDid, nowMs)) {
              throw new GroupHostHttpError(409, "MigrationInProgress", "Group is frozen during active migration.");
            }
            if (params.session) {
              const { permissions: commitPerms } = revalidateLiveOAuthSessionSync(this.db, params.session, { nowMs });
              params.extraCommitSpaceCheck?.(commitPerms, spaceTarget);
            }
            const repoRow = this.db
              .prepare("SELECT rev FROM space_repo WHERE space_uri = ? AND repo_did = ?")
              .get(params.spaceUri, params.groupDid) as { rev: string } | undefined;
            return repoRow?.rev ?? tidNow(nowMs);
          })
          .immediate();
        return { commit: { rev }, results: [] };
      }

      const preState = loadLiveGovernanceState(this.db, params.groupDid);
      const membersSpace = groupMembersUri(params.groupDid);

      // Prepare simulated post-state + pre-serialized CBOR records
      const postRoles = new Map(preState.roles);
      const postMemberships = new Map(preState.memberships);
      const postAllAppInstalls = new Map(preState.allAppInstalls);
      const postActiveAppInstalls = new Map(preState.activeAppInstalls);
      const postKnownAppSubjects = new Set(preState.knownAppSubjects);
      const deletedRoles = new Set<string>();

      const currentMembersSpaceRow = this.db
        .prepare("SELECT space_rev FROM group_space WHERE space_uri = ?")
        .get(membersSpace) as { space_rev: string } | undefined;
      const predictedNextMembersSpaceRev = nextMonotonicTid(currentMembersSpaceRow?.space_rev ?? null);

      const preparedOps: Array<{
        action: "create" | "update" | "delete";
        inputAction: "create" | "update" | "delete";
        expectedExisted: boolean;
        expectedExistingCid?: string;
        collection: string;
        rkey: string;
        value?: Record<string, unknown>;
        cborBytes?: Uint8Array;
        cidStr?: string;
        incarnation?: string | null;
        prevValue?: Record<string, unknown>;
      }> = [];

      for (const w of resolvedWrites) {
        if (w.collection === ATPROTO_SPACE_COLLECTION.spacePolicy) {
          throw new GroupHostHttpError(400, "InvalidRequest", "com.atproto.space.policy is host-published via createSpace/updateSpace.");
        }
        if (w.collection === ATGRP_COLLECTION.space) {
          throw new GroupHostHttpError(400, "IndexHostMaintained", "org.atgrp.space is host-maintained and rejects direct writes.");
        }
        if (!isOwnAuthoritySpace && w.collection !== ATGRP_COLLECTION.invite) {
          throw new GroupHostHttpError(
            400,
            "InvalidRequest",
            "External org.atgrp.inbox/self spaces only accept org.atgrp.invite records.",
          );
        }

        const rkey = w.action === "create" ? (w.rkey ?? tidNow(nowMs)) : w.rkey;
        if (!isRecordKey(rkey)) {
          throw new GroupHostHttpError(400, "InvalidRequest", `Invalid record key: ${rkey}`);
        }
        const existingRow = this.db
          .prepare(
            "SELECT cid, value, incarnation FROM space_record WHERE space_uri = ? AND repo_did = ? AND collection = ? AND rkey = ?",
          )
          .get(params.spaceUri, params.groupDid, w.collection, rkey) as
          | { cid: string; value: string; incarnation: string | null }
          | undefined;

        if (w.action === "delete") {
          if (w.swapRecord !== undefined && w.swapRecord !== null && existingRow?.cid !== w.swapRecord) {
            throw new GroupHostHttpError(400, "InvalidSwap", "swapRecord mismatch on space deleteRecord.");
          }
          const prevVal = existingRow ? (JSON.parse(existingRow.value) as Record<string, unknown>) : undefined;
          if (params.spaceUri === membersSpace && w.collection === ATGRP_COLLECTION.role) {
            assertRoleWriteAntiEscalation(params.actorDid, preState, params.groupDid, rkey, undefined);
            postRoles.delete(rkey);
            deletedRoles.add(rkey);
          } else if (params.spaceUri === membersSpace && w.collection === ATGRP_COLLECTION.membership) {
            if (prevVal) {
              assertCanAssignRoleDiff(
                params.actorDid,
                preState,
                params.groupDid,
                prevVal.roles as string[],
                [],
              );
            }
            postMemberships.delete(rkey);
          } else if (params.spaceUri === workspaceUri(params.groupDid) && w.collection === COLLECTION.appInstall) {
            postAllAppInstalls.delete(rkey);
            for (const [subj] of preState.allAppInstalls) {
              if (prevVal?.subject === subj) {
                postAllAppInstalls.delete(subj);
                postActiveAppInstalls.delete(subj);
              }
            }
          }
          preparedOps.push({
            action: "delete",
            inputAction: "delete",
            expectedExisted: Boolean(existingRow),
            ...(existingRow ? { expectedExistingCid: existingRow.cid } : {}),
            collection: w.collection,
            rkey,
            prevValue: prevVal,
          });
          continue;
        }

        // create or update
        if (w.action === "create" && existingRow) {
          throw new GroupHostHttpError(400, "InvalidSwap", `Space record already exists: ${w.collection}/${rkey}`);
        }
        if (params.isPutRecord) {
          if (params.putSwapRecord === null && existingRow) {
            throw new GroupHostHttpError(400, "InvalidSwap", "Expected absent space record for swapRecord: null.");
          }
          if (typeof params.putSwapRecord === "string" && (!existingRow || existingRow.cid !== params.putSwapRecord)) {
            throw new GroupHostHttpError(400, "InvalidSwap", "swapRecord CID mismatch.");
          }
        } else if (w.action === "update") {
          if (!existingRow) {
            throw new GroupHostHttpError(400, "InvalidSwap", `Cannot update absent space record: ${w.collection}/${rkey}`);
          }
          if (w.swapRecord !== undefined && w.swapRecord !== existingRow.cid) {
            throw new GroupHostHttpError(400, "InvalidSwap", "swapRecord CID mismatch.");
          }
        }

        let recordValue: Record<string, unknown> = { $type: w.collection, ...w.value };
        let recordIncarnation: string | null | undefined = undefined;

        // Stamp or preserve Flock incarnation + generation metadata on `org.atgrp.membership`!
        if (params.spaceUri === membersSpace && w.collection === ATGRP_COLLECTION.membership) {
          const callerExtCheck = decodeFlockMembershipExtensions(recordValue);
          if (!callerExtCheck.valid) {
            throw new GroupHostHttpError(400, callerExtCheck.code, callerExtCheck.reason);
          }
          if (!existingRow) {
            // Absent -> Present transition: mint fresh incarnation + generation + admittedSpaceRev + afterWriterRev!
            const writerMeta = this.db
              .prepare(
                "SELECT last_evicted_repo_rev, prior_eject_count FROM space_writer WHERE space_uri = ? AND writer_did = ?",
              )
              .get(membersSpace, rkey) as
              | { last_evicted_repo_rev: string | null; prior_eject_count: number }
              | undefined;
            const freshInc = randomUUID();
            const gen = (writerMeta?.prior_eject_count ?? 0) + 1;
            const afterWriterRev = writerMeta?.last_evicted_repo_rev ?? null;
            recordValue = {
              ...recordValue,
              [FLOCK_EXTENSION_FIELD.incarnation]: freshInc,
              [FLOCK_EXTENSION_FIELD.generation]: gen,
              [FLOCK_EXTENSION_FIELD.admittedSpaceRev]: predictedNextMembersSpaceRev,
              [FLOCK_EXTENSION_FIELD.afterWriterRev]: afterWriterRev,
            };
            recordIncarnation = freshInc;
          } else {
            // In-place role update: preserve existing incarnation + generation metadata!
            const prevParsed = JSON.parse(existingRow.value) as Record<string, unknown>;
            const preservedInc =
              existingRow.incarnation ??
              (typeof prevParsed[FLOCK_EXTENSION_FIELD.incarnation] === "string"
                ? (prevParsed[FLOCK_EXTENSION_FIELD.incarnation] as string)
                : randomUUID());
            recordValue = {
              ...recordValue,
              [FLOCK_EXTENSION_FIELD.incarnation]: preservedInc,
              ...(prevParsed[FLOCK_EXTENSION_FIELD.generation] !== undefined
                ? { [FLOCK_EXTENSION_FIELD.generation]: prevParsed[FLOCK_EXTENSION_FIELD.generation] }
                : {}),
              ...(prevParsed[FLOCK_EXTENSION_FIELD.admittedSpaceRev] !== undefined
                ? { [FLOCK_EXTENSION_FIELD.admittedSpaceRev]: prevParsed[FLOCK_EXTENSION_FIELD.admittedSpaceRev] }
                : {}),
              ...(prevParsed[FLOCK_EXTENSION_FIELD.afterWriterRev] !== undefined
                ? { [FLOCK_EXTENSION_FIELD.afterWriterRev]: prevParsed[FLOCK_EXTENSION_FIELD.afterWriterRev] }
                : {}),
            };
            recordIncarnation = preservedInc;
          }
        }

        // Enforce runtime Lexicons + semantic validation unconditionally for MANDATORY_VALIDATED_SPACE_COLLECTIONS,
        // the ENTIRE reserved `org.atgrp.*` namespace, and external `org.atgrp.inbox/self`!
        const isReservedAtgrp = w.collection.startsWith(`${ATGRP_NAMESPACE}.`);
        const mustValidate =
          !isOwnAuthoritySpace ||
          w.validate !== false ||
          MANDATORY_VALIDATED_SPACE_COLLECTIONS.has(w.collection) ||
          isReservedAtgrp;
        if (mustValidate) {
          const check = validateSpaceRecord(w.collection, recordValue, {
            authorityDid: parsedSpace.authorityDid,
            spaceUri: params.spaceUri,
            repoDid: params.groupDid,
            rkey,
          });
          if (!check.valid) {
            if (
              isOwnAuthoritySpace &&
              check.reason === "unknown collection" &&
              !MANDATORY_VALIDATED_SPACE_COLLECTIONS.has(w.collection) &&
              !isReservedAtgrp
            ) {
              // Third-party modality collection permitted on Group Host
            } else {
              throw new GroupHostHttpError(400, check.code ?? "InvalidRequest", check.reason);
            }
          }
        }

        // RBAC anti-escalation & post-state tracking
        if (params.spaceUri === membersSpace && w.collection === ATGRP_COLLECTION.role) {
          const nextRole = recordValue as unknown as LiveGroupGovernanceState["roles"] extends Map<string, infer R> ? R : never;
          assertRoleWriteAntiEscalation(params.actorDid, preState, params.groupDid, rkey, nextRole);
          postRoles.set(rkey, nextRole);
        } else if (params.spaceUri === membersSpace && w.collection === ATGRP_COLLECTION.membership) {
          const prevRoles = existingRow
            ? ((JSON.parse(existingRow.value) as { roles?: string[] }).roles ?? [])
            : undefined;
          const nextRoles = recordValue.roles as string[];
          assertCanAssignRoleDiff(params.actorDid, preState, params.groupDid, prevRoles, nextRoles);
          postMemberships.set(rkey, {
            ...recordValue,
            roles: nextRoles,
            createdAt: String(recordValue.createdAt),
          });
        } else if (params.spaceUri === workspaceUri(params.groupDid) && w.collection === COLLECTION.appInstall) {
          const subjectDid = String(recordValue.subject);
          const snap = {
            subject: subjectDid,
            active: recordValue.active === true,
            channels: Array.isArray(recordValue.channels)
              ? (recordValue.channels as Array<{ skey: string; write: boolean }>)
              : [],
          };
          postKnownAppSubjects.add(subjectDid);
          postAllAppInstalls.set(subjectDid, snap);
          if (snap.active) postActiveAppInstalls.set(subjectDid, snap);
          else postActiveAppInstalls.delete(subjectDid);
        }

        const serialized = await serializeRecord(
          w.collection as NsidString,
          rkey as RecordKeyString,
          jsonToLex(recordValue) as LexMap,
        );
        preparedOps.push({
          action: existingRow ? "update" : "create",
          inputAction: w.action,
          expectedExisted: Boolean(existingRow),
          ...(existingRow ? { expectedExistingCid: existingRow.cid } : {}),
          collection: w.collection,
          rkey,
          value: recordValue,
          cborBytes: serialized.bytes,
          cidStr: serialized.cid.toString(),
          incarnation: recordIncarnation,
          prevValue: existingRow ? (JSON.parse(existingRow.value) as Record<string, unknown>) : undefined,
        });
      }

      const postState: LiveGroupGovernanceState = {
        ...preState,
        roles: postRoles,
        memberships: postMemberships,
        knownAppSubjects: postKnownAppSubjects,
        allAppInstalls: postAllAppInstalls,
        activeAppInstalls: postActiveAppInstalls,
      };
      assertPostGovernanceInvariants(preState, postState, params.groupDid, { deletedRoles });

      // Non-Flock zero-human transition check (`NoSovereignCustodyKey`)!
      if (!postState.hasFlockWorkspace) {
        const postHumans = [...postState.memberships.keys()].filter(
          (did) => did !== params.groupDid && !postState.knownAppSubjects.has(did),
        );
        if (postHumans.length === 0) {
          const recoveryRow = this.db
            .prepare("SELECT 1 AS ok FROM group_recovery_admin WHERE group_did = ?")
            .get(params.groupDid);
          if (!recoveryRow) {
            const localRot = await this.getGroupRotationKey(params.groupDid);
            const lastPlc = await this.plc.getPlcLastOp(params.groupDid);
            const rotKeys = plcOpRotationKeys(lastPlc);
            const hasExternalSov =
              localRot !== null &&
              rotKeys.some((k) => k !== localRot.did() && isSupportedPlcRotationDidKey(k));
            if (!hasExternalSov) {
              throw new GroupHostHttpError(
                400,
                "NoSovereignCustodyKey",
                "Cannot remove the last human member without an external sovereign PLC rotation key.",
              );
            }
          }
        }
      }

      this.consumeWritePoints(params.groupDid, resolvedWrites, nowMs);

      const tx = this.db.transaction(() => {
        reapExpiredPreparedMigrationLease(this.db, params.groupDid, nowMs);
        if (hasActiveSourceMigrationLease(this.db, params.groupDid, nowMs)) {
          throw new GroupHostHttpError(409, "MigrationInProgress", "Group is frozen during active migration.");
        }

        const revalidated = params.session
          ? revalidateLiveOAuthSessionSync(this.db, params.session, { nowMs })
          : undefined;
        if (revalidated) {
          params.extraCommitSpaceCheck?.(revalidated.permissions, spaceTarget);
        }

        for (const op of preparedOps) {
          const liveExisting = this.db
            .prepare("SELECT cid FROM space_record WHERE space_uri = ? AND repo_did = ? AND collection = ? AND rkey = ?")
            .get(params.spaceUri, params.groupDid, op.collection, op.rkey) as { cid: string } | undefined;
          if (
            Boolean(liveExisting) !== op.expectedExisted ||
            (op.expectedExisted && liveExisting?.cid !== op.expectedExistingCid)
          ) {
            throw new GroupHostHttpError(400, "InvalidSwap", "Concurrent space record state changed.");
          }
          if (revalidated) {
            const requiredAction =
              params.isPutRecord && op.inputAction === "update"
                ? liveExisting
                  ? "update"
                  : "create"
                : op.inputAction;
            revalidated.permissions.assertSpace(spaceTarget, {
              action: requiredAction,
              collection: op.collection as NsidString,
            });
            if (params.spaceUri === membersSpace && op.collection === ATGRP_COLLECTION.role) {
              assertRoleWriteAntiEscalation(
                params.actorDid,
                revalidated.liveState,
                params.groupDid,
                op.rkey,
                op.action === "delete" ? undefined : (op.value as unknown as GroupRoleRecord),
              );
            } else if (params.spaceUri === membersSpace && op.collection === ATGRP_COLLECTION.membership) {
              assertCanAssignRoleDiff(
                params.actorDid,
                revalidated.liveState,
                params.groupDid,
                op.prevValue?.roles as string[] | undefined,
                op.action === "delete" ? [] : (op.value?.roles as string[]),
              );
            }
          }
        }

        // Prune expired join_request & join_operation_state rows before checking `If-Join-Request-Present`
        this.db.prepare("DELETE FROM join_request WHERE group_did = ? AND expires_at <= ?").run(params.groupDid, nowMs);
        this.db.prepare("DELETE FROM join_operation_state WHERE group_did = ? AND expires_at <= ?").run(params.groupDid, nowMs);

        if (params.ifJoinRequestPresent) {
          for (const op of preparedOps) {
            if (params.spaceUri === membersSpace && op.collection === ATGRP_COLLECTION.membership && op.action !== "delete") {
              const jr = this.db
                .prepare("SELECT 1 AS ok FROM join_request WHERE group_did = ? AND requester_did = ? AND expires_at > ?")
                .get(params.groupDid, op.rkey, nowMs);
              if (!jr) {
                throw new GroupHostHttpError(
                  409,
                  "JoinRequestNotFound",
                  `No active join request found for ${op.rkey}.`,
                );
              }
            }
          }
        }

        const applied = this.applySpaceRepoMutationsSync({
          groupDid: params.groupDid,
          spaceUri: params.spaceUri,
          repoDid: params.groupDid,
          ops: preparedOps,
          isOwnAuthoritySpace,
          nowMs,
        });

        // Side-effects inside the exact same synchronous IMMEDIATE transaction!
        for (let i = 0; i < preparedOps.length; i += 1) {
          const op = preparedOps[i]!;
          const res = applied.results[i]!;

          // 1. Register known_app_subject permanently when app.install is created/updated
          if (params.spaceUri === workspaceUri(params.groupDid) && op.collection === COLLECTION.appInstall && op.value) {
            this.db
              .prepare("INSERT OR IGNORE INTO known_app_subject (group_did, subject_did, created_at) VALUES (?, ?, ?)")
              .run(params.groupDid, String(op.value.subject), nowMs);
          }

          // 2. Membership create/update -> clear ejection eligibility, delete join_request & upgrade pending join_operation_state rows!
          if (params.spaceUri === membersSpace && op.collection === ATGRP_COLLECTION.membership) {
            if (op.action !== "delete" && res.cid) {
              clearModEjectionEligibilitySync(this.db, params.groupDid, op.rkey);
              this.db
                .prepare("DELETE FROM join_request WHERE group_did = ? AND requester_did = ?")
                .run(params.groupDid, op.rkey);
              const admittedResp = JSON.stringify({
                status: "admitted",
                membership: { uri: res.uri, cid: res.cid },
              });
              this.db
                .prepare(
                  `UPDATE join_operation_state
                   SET state = 'admitted', response_json = ?, updated_at = ?
                   WHERE group_did = ? AND requester_did = ? AND state = 'pending'`,
                )
                .run(admittedResp, nowMs, params.groupDid, op.rkey);
            } else if (op.action === "delete" && op.prevValue) {
              this.evictWriterFromSpaceSync({
                groupDid: params.groupDid,
                spaceUri: membersSpace,
                writerDid: op.rkey,
                incrementEjectCount: true,
                nowMs,
              });
              recordModEjectEventSync(this.db, {
                groupDid: params.groupDid,
                actorDid: params.actorDid,
                ejectedMemberDid: op.rkey,
                nowIso,
              });
            }
          }

          // 3. Label create/update/delete -> record labelEvent in moderation history!
          if (isOwnAuthoritySpace && op.collection === ATPROTO_SPACE_COLLECTION.label) {
            const labelVal = op.action === "delete" ? op.prevValue : op.value;
            if (labelVal && typeof labelVal.uri === "string" && typeof labelVal.val === "string") {
              recordModLabelEventSync(this.db, {
                groupDid: params.groupDid,
                actorDid: params.actorDid,
                subjectUri: labelVal.uri,
                subjectCid: typeof labelVal.cid === "string" ? labelVal.cid : undefined,
                labelRecordUri: res.uri,
                val: labelVal.val,
                deleted: op.action === "delete",
                nowIso,
              });
            }
          }

          // 4. External `org.atgrp.inbox/self` tracking + `notifyRepoUpdate` outbox!
          if (!isOwnAuthoritySpace && parsedSpace.type === ATGRP_SPACE_TYPE.inbox && op.collection === ATGRP_COLLECTION.invite) {
            const inviteeDid = parsedSpace.authorityDid;
            this.db
              .prepare("INSERT OR IGNORE INTO group_invite_target (group_did, space_uri, invitee_did) VALUES (?, ?, ?)")
              .run(params.groupDid, params.spaceUri, inviteeDid);

            if (op.action === "delete") {
              this.db
                .prepare("DELETE FROM invite_delivery WHERE group_did = ? AND invite_uri = ?")
                .run(params.groupDid, res.uri);
            } else {
              this.db
                .prepare(
                  `INSERT INTO invite_delivery (
                     group_did, invite_uri, space_uri, invitee_did, rkey, repo_rev, status, attempts, last_error, created_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, NULL, ?, ?)
                   ON CONFLICT(group_did, invite_uri) DO UPDATE SET
                     repo_rev = excluded.repo_rev, status = 'pending', attempts = 0, last_error = NULL, updated_at = excluded.updated_at`,
                )
                .run(params.groupDid, res.uri, params.spaceUri, inviteeDid, op.rkey, applied.rev, nowMs, nowMs);
            }

            this.upsertOutboxNoticeSync({
              kind: "invite_repo_update",
              groupDid: params.groupDid,
              coalesceKey: `invite\u0000${params.groupDid}\u0000${params.spaceUri}`,
              endpoint: inviteeDid, // Resolved via PLC/DID doc during outbox delivery!
              spaceUri: params.spaceUri,
              writerDid: inviteeDid,
              payload: {
                space: params.spaceUri,
                repo: params.groupDid,
                repoRev: applied.rev,
                data: lexToJson(applied.digest),
              },
              maxAttempts: 5,
              nowMs,
              expiresAt: nowMs + 60_000,
            });
          }
        }

        // Reconcile writer evictions across all spaces!
        this.reconcileAllSpaceWritersSync(params.groupDid, postState, nowMs);

        return {
          commit: { rev: applied.rev },
          results: applied.results.map((r, idx) => {
            const op = preparedOps[idx]!;
            return op.action === "delete"
              ? { uri: r.uri, $type: "com.atproto.space.applyWrites#deleteResult" }
              : {
                  uri: r.uri,
                  cid: r.cid,
                  $type: `com.atproto.space.applyWrites#${op.action}Result`,
                  validationStatus: "valid",
                };
          }),
        };
      });

      return tx.immediate();
    });
  }

  async clearSpaceRecords(params: {
    groupDid: string;
    actorDid: string;
    session?: AuthenticatedGroupSession;
    spaceUri: string;
    collections?: readonly string[];
    nowMs?: number;
  }): Promise<{ commit: { rev: string } }> {
    const parsedSpace = parseSpaceUri(params.spaceUri);
    if (!parsedSpace) throw new GroupHostHttpError(400, "InvalidRequest", "Invalid space URI.");
    const isOwnAuthority = parsedSpace.authorityDid === params.groupDid;
    const keep = new Set<string>(
      isOwnAuthority ? [ATPROTO_SPACE_COLLECTION.spacePolicy, ATGRP_COLLECTION.space] : [],
    );
    const filterCols = params.collections && params.collections.length > 0 ? new Set(params.collections) : null;

    const res = await this.applySpaceWrites({
      groupDid: params.groupDid,
      actorDid: params.actorDid,
      session: params.session,
      spaceUri: params.spaceUri,
      writes: [],
      skipMaxWritesCap: true,
      buildWrites: () => {
        const rows = this.db
          .prepare("SELECT collection, rkey FROM space_record WHERE space_uri = ? AND repo_did = ?")
          .all(params.spaceUri, params.groupDid) as Array<{ collection: string; rkey: string }>;
        return rows
          .filter((r) => !keep.has(r.collection) && (!filterCols || filterCols.has(r.collection)))
          .map((r) => ({ action: "delete" as const, collection: r.collection, rkey: r.rkey }));
      },
      extraCommitSpaceCheck: (perms, target) => {
        if (params.collections && params.collections.length > 0) {
          for (const c of params.collections) {
            perms.assertSpace(target, { action: "delete", collection: c as NsidString });
          }
        } else {
          perms.assertSpace(target, { action: "delete", collection: "*" });
        }
      },
      nowMs: params.nowMs,
    });
    return { commit: res.commit };
  }

  // =========================================================================
  // Space Export & Import (`exportSpaceMeta`, `importSpaceMeta`, `space.getRepo`, `space.importRepo`)
  // =========================================================================

  async exportSpaceMetaBytes(groupDid: string, spaceUriValue: string): Promise<Uint8Array> {
    const spRow = this.db
      .prepare("SELECT policy_json, deleted_at FROM group_space WHERE space_uri = ? AND group_did = ?")
      .get(spaceUriValue, groupDid) as { policy_json: string; deleted_at: number | null } | undefined;
    if (!spRow) throw new GroupHostHttpError(400, "SpaceNotFound", `Space not found: ${spaceUriValue}`);
    if (spRow.deleted_at !== null) throw new GroupHostHttpError(400, "SpaceDeleted", `Space deleted: ${spaceUriValue}`);

    const writers = this.db
      .prepare(
        "SELECT writer_did, repo_rev, space_rev, data FROM space_writer WHERE space_uri = ? AND removed = 0 ORDER BY writer_did ASC",
      )
      .all(spaceUriValue) as Array<{
      writer_did: string;
      repo_rev: string;
      space_rev: string;
      data: Buffer;
    }>;

    const archive: SpaceMetaArchive = {
      space: spaceUriValue as SpaceRefString,
      policy: jsonToLex(JSON.parse(spRow.policy_json)) as LexMap,
      policyState: [],
      writers: writers.map((w) => ({
        did: w.writer_did as DidString,
        repoRev: w.repo_rev,
        spaceRev: w.space_rev,
        data: new Uint8Array(w.data),
      })),
    };

    const chunks: Buffer[] = [];
    for await (const chunk of writeSpaceMetaStar(archive)) {
      chunks.push(Buffer.from(chunk));
    }
    return new Uint8Array(Buffer.concat(chunks));
  }

  async importSpaceMetaStream(params: {
    groupDid: string;
    migrationSessionId: string;
    migrationTokenExpSec?: number;
    starStream: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
    nowMs?: number;
  }): Promise<{ uri: string }> {
    const startWallMs = Date.now();
    const initialNowMs = params.nowMs ?? startWallMs;
    this.assertLiveMigrationStagingSync(
      params.groupDid,
      params.migrationSessionId,
      initialNowMs,
      params.migrationTokenExpSec,
    );
    const starBytes = await readBoundedStreamBytes(
      params.starStream,
      this.config.maxSpaceMetaImportSize,
      "InvalidSpaceMeta",
    );
    let archive: SpaceMetaArchive;
    try {
      archive = await readSpaceMetaStar([starBytes]);
    } catch (err) {
      throw new GroupHostHttpError(400, "InvalidSpaceMeta", err instanceof Error ? err.message : "Invalid space meta STAR.");
    }

    const parsedSpace = parseSpaceUri(archive.space);
    if (!parsedSpace || parsedSpace.authorityDid !== params.groupDid) {
      throw new GroupHostHttpError(400, "InvalidSpaceMeta", "Space meta authority mismatch.");
    }
    const keyCheck = validateSpaceTypeKey(parsedSpace.type, parsedSpace.skey, { isGroupHostOwnSpace: true });
    if (!keyCheck.valid) {
      throw new GroupHostHttpError(400, keyCheck.code ?? "InvalidSpaceMeta", keyCheck.reason);
    }

    const plainPolicy = lexToJson(archive.policy) as Record<string, unknown>;
    const polCheck = validateSpacePolicy(plainPolicy, {
      groupDid: params.groupDid,
      spaceType: parsedSpace.type,
      skey: parsedSpace.skey,
      importMode: true,
    });
    if (!polCheck.valid) {
      throw new GroupHostHttpError(400, polCheck.code ?? "InvalidSpaceMeta", polCheck.reason);
    }
    const normalizedPolicy: GroupAtgrpPolicy = {
      $type: ATGRP_POLICY,
      publicRead: plainPolicy.publicRead === true,
      unlisted: plainPolicy.unlisted === true,
      grants: (plainPolicy.grants as GroupAtgrpPolicy["grants"]).map((g) => ({
        role: g.role,
        ...(g.read !== undefined ? { read: Boolean(g.read) } : {}),
        ...(g.write !== undefined ? { write: Boolean(g.write) } : {}),
        ...(g.permissions && g.permissions.length > 0 ? { permissions: [...g.permissions] } : {}),
      })),
    };

    const maxWriterSpaceRev = archive.writers.reduce(
      (acc, w) => (w.spaceRev > acc ? w.spaceRev : acc),
      "",
    );
    const spaceRev = maxWriterSpaceRev !== "" ? maxWriterSpaceRev : nextMonotonicTid();

    return this.locks.withGroupRepoLock(params.groupDid, () => {
      const tx = this.db.transaction(() => {
        const commitNowMs =
          params.nowMs !== undefined ? params.nowMs + Math.max(0, Date.now() - startWallMs) : Date.now();
        this.assertLiveMigrationStagingSync(
          params.groupDid,
          params.migrationSessionId,
          commitNowMs,
          params.migrationTokenExpSec,
        );
        this.db.prepare("DELETE FROM space_writer WHERE space_uri = ?").run(archive.space);
        this.db
          .prepare(
            `INSERT INTO group_space (
               space_uri, group_did, space_type, skey, policy_json, space_rev, index_rkey, deleted_at, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
             ON CONFLICT(space_uri) DO UPDATE SET
               policy_json = excluded.policy_json,
               space_rev = excluded.space_rev,
               deleted_at = NULL,
               updated_at = excluded.updated_at`,
          )
          .run(
            archive.space,
            params.groupDid,
            parsedSpace.type,
            parsedSpace.skey,
            JSON.stringify(normalizedPolicy),
            spaceRev,
            commitNowMs,
            commitNowMs,
          );

        const insWriter = this.db.prepare(
          `INSERT INTO space_writer (space_uri, group_did, writer_did, removed, repo_rev, space_rev, data, updated_at)
           VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
        );
        for (const w of archive.writers) {
          insWriter.run(archive.space, params.groupDid, w.did, w.repoRev, w.spaceRev, Buffer.from(w.data), commitNowMs);
        }
        return { uri: archive.space };
      });
      return tx.immediate();
    });
  }

  async exportSpaceRepoStarBytes(spaceUriValue: string, repoDid: string): Promise<{ commit: SpaceCommit; starBytes: Uint8Array }> {
    const repoRow = this.db
      .prepare("SELECT set_hash, rev FROM space_repo WHERE space_uri = ? AND repo_did = ?")
      .get(spaceUriValue, repoDid) as { set_hash: Buffer; rev: string } | undefined;
    if (!repoRow) {
      throw new GroupHostHttpError(400, "RepoNotFound", `No space repo for ${repoDid} in ${spaceUriValue}`);
    }
    const repoCommit = RepoCommit.fromState(new Uint8Array(repoRow.set_hash));
    const commit = repoCommit.toCommit({
      space: spaceUriValue as SpaceRefString,
      repo: repoDid as DidString,
      rev: repoRow.rev,
    });

    const recordRows = this.db
      .prepare(
        "SELECT collection, rkey, cbor_bytes FROM space_record WHERE space_uri = ? AND repo_did = ?",
      )
      .all(spaceUriValue, repoDid) as Array<{ collection: string; rkey: string; cbor_bytes: Buffer }>;

    // STAR requires strict UTF-16 path (`${collection}/${rkey}`) order!
    const sortedRecords: SerializedRecord[] = recordRows
      .map((r) => ({
        collection: r.collection as NsidString,
        rkey: r.rkey as RecordKeyString,
        bytes: new Uint8Array(r.cbor_bytes),
        pathKey: `${r.collection}/${r.rkey}`,
      }))
      .sort((a, b) => compareUtf16(a.pathKey, b.pathKey))
      .map(({ collection, rkey, bytes }) => ({ collection, rkey, bytes }));

    const chunks: Buffer[] = [];
    for await (const chunk of writeRepoStar(commit, sortedRecords)) {
      chunks.push(Buffer.from(chunk));
    }
    return { commit, starBytes: new Uint8Array(Buffer.concat(chunks)) };
  }

  async importSpaceRepoStarStream(params: {
    groupDid: string;
    migrationSessionId: string;
    migrationTokenExpSec?: number;
    starStream: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
    nowMs?: number;
  }): Promise<void> {
    const startWallMs = Date.now();
    const initialNowMs = params.nowMs ?? startWallMs;
    this.assertLiveMigrationStagingSync(
      params.groupDid,
      params.migrationSessionId,
      initialNowMs,
      params.migrationTokenExpSec,
    );
    const starBytes = await readBoundedStreamBytes(
      params.starStream,
      this.config.maxRepoImportSize,
      "InvalidRepoFile",
    );

    let commit: SpaceCommit;
    const verifiedRecords: Array<{
      collection: string;
      rkey: string;
      cidStr: string;
      cborBytes: Uint8Array;
      plainJson: Record<string, unknown>;
      incarnation: string | null;
      blobs: string[];
    }> = [];

    let repoReader: Awaited<ReturnType<typeof readRepoStar>>;
    try {
      repoReader = await readRepoStar([starBytes]);
    } catch (err) {
      throw new GroupHostHttpError(400, "InvalidRepoFile", err instanceof Error ? err.message : "Invalid space repo STAR.");
    }

    try {
      commit = repoReader.commit;
      if (commit.repo !== params.groupDid) {
        throw new GroupHostHttpError(400, "RepoMismatch", `Expected repo ${params.groupDid}, got ${commit.repo}`);
      }
      const parsedSpace = parseSpaceUri(commit.space);
      if (!parsedSpace) {
        throw new GroupHostHttpError(400, "InvalidRepoFile", `Invalid space URI in STAR: ${commit.space}`);
      }
      const isOwnAuthority = parsedSpace.authorityDid === params.groupDid;
      const keyCheck = validateSpaceTypeKey(parsedSpace.type, parsedSpace.skey, {
        isGroupHostOwnSpace: isOwnAuthority,
      });
      if (!keyCheck.valid) {
        throw new GroupHostHttpError(400, keyCheck.code ?? "InvalidSpaceKey", keyCheck.reason);
      }
      if (!isOwnAuthority && parsedSpace.type !== ATGRP_SPACE_TYPE.inbox) {
        throw new GroupHostHttpError(400, "InvalidRepoFile", "External space repo must be org.atgrp.inbox/self.");
      }

      for await (const entry of repoReader.records) {
        // Preserve untouched DRISL CBOR bytes verbatim (`cborEncode(entry.record)`)!
        const rawCbor = cborEncode(entry.record);
        const plainJson = lexToJson(entry.record) as Record<string, unknown>;

        if (!isOwnAuthority) {
          if (entry.collection !== ATGRP_COLLECTION.invite) {
            throw new GroupHostHttpError(
              400,
              "InvalidRepoFile",
              "External org.atgrp.inbox/self STAR archives may only contain org.atgrp.invite records.",
            );
          }
          const check = validateSpaceRecord(ATGRP_COLLECTION.invite, plainJson, {
            authorityDid: parsedSpace.authorityDid,
            spaceUri: commit.space,
            repoDid: params.groupDid,
            rkey: entry.rkey,
            importMode: true,
          });
          if (!check.valid) {
            throw new GroupHostHttpError(400, "InvalidRepoFile", check.reason);
          }
        } else if (entry.collection === ATPROTO_SPACE_COLLECTION.spacePolicy) {
          if (plainJson.$type !== ATPROTO_SPACE_COLLECTION.spacePolicy) {
            throw new GroupHostHttpError(
              400,
              "InvalidRepoFile",
              "com.atproto.space.policy record must declare $type com.atproto.space.policy.",
            );
          }
          const check = validateSpaceRecord(ATPROTO_SPACE_COLLECTION.spacePolicy, plainJson, {
            authorityDid: parsedSpace.authorityDid,
            spaceUri: commit.space,
            repoDid: params.groupDid,
            rkey: entry.rkey,
            importMode: true,
          });
          if (!check.valid) {
            throw new GroupHostHttpError(400, check.code ?? "InvalidRepoFile", check.reason);
          }
          const polCheck = validateSpacePolicy(plainJson.policy, {
            groupDid: params.groupDid,
            spaceType: parsedSpace.type,
            skey: parsedSpace.skey,
            importMode: true,
          });
          if (!polCheck.valid) {
            throw new GroupHostHttpError(400, polCheck.code ?? "InvalidSpacePolicy", polCheck.reason);
          }
        } else {
          const isReservedAtgrp = entry.collection.startsWith(`${ATGRP_NAMESPACE}.`);
          const check = validateSpaceRecord(entry.collection, plainJson, {
            authorityDid: parsedSpace.authorityDid,
            spaceUri: commit.space,
            repoDid: params.groupDid,
            rkey: entry.rkey,
            importMode: true,
          });
          if (!check.valid) {
            if (
              check.reason === "unknown collection" &&
              !MANDATORY_VALIDATED_SPACE_COLLECTIONS.has(entry.collection) &&
              !isReservedAtgrp
            ) {
              // Third-party modality collection permitted in own-authority spaces
            } else {
              throw new GroupHostHttpError(400, check.code ?? "InvalidRepoFile", check.reason);
            }
          }
        }

        let incarnation: string | null = null;
        if (entry.collection === ATGRP_COLLECTION.membership) {
          const ext = decodeFlockMembershipExtensions(plainJson);
          if (!ext.valid) {
            throw new GroupHostHttpError(400, ext.code, ext.reason);
          }
          // Deterministic `legacy-cid:<cid>` fallback when Flock incarnation field is absent!
          incarnation = ext.incarnation ?? `legacy-cid:${entry.cid.toString()}`;
        }

        verifiedRecords.push({
          collection: entry.collection,
          rkey: entry.rkey,
          cidStr: entry.cid.toString(),
          cborBytes: rawCbor,
          plainJson,
          incarnation,
          blobs: [...collectBlobCidsFromValue(plainJson)],
        });
      }
    } finally {
      try {
        await repoReader[Symbol.asyncDispose]();
      } catch {
        // Ignore dispose errors
      }
    }

    const parsedSpace = parseSpaceUri(commit.space)!;
    const isOwnAuthority = parsedSpace.authorityDid === params.groupDid;
    const repoCommit = RepoCommit.fromRecords(
      verifiedRecords.map((r) => ({
        collection: r.collection as NsidString,
        rkey: r.rkey as RecordKeyString,
        cid: parseCid(r.cidStr),
      })),
    );
    const setHashBytes = repoCommit.setHash.state();

    return this.locks.withGroupRepoLock(params.groupDid, () => {
      const tx = this.db.transaction(() => {
        const commitNowMs =
          params.nowMs !== undefined ? params.nowMs + Math.max(0, Date.now() - startWallMs) : Date.now();
        this.assertLiveMigrationStagingSync(
          params.groupDid,
          params.migrationSessionId,
          commitNowMs,
          params.migrationTokenExpSec,
        );

        if (isOwnAuthority) {
          const stagedSpace = this.db
            .prepare("SELECT space_rev FROM group_space WHERE space_uri = ? AND group_did = ? AND deleted_at IS NULL")
            .get(commit.space, params.groupDid) as { space_rev: string } | undefined;
          if (!stagedSpace) {
            throw new GroupHostHttpError(400, "SpaceNotFound", "Own-authority space must be staged via importSpaceMeta before importRepo.");
          }
        } else {
          // Reconstruct `group_invite_target` even when `verifiedRecords.length === 0`!
          const inviteTarget = parsePersonalInboxUri(commit.space);
          if (inviteTarget) {
            this.db
              .prepare("INSERT OR IGNORE INTO group_invite_target (group_did, space_uri, invitee_did) VALUES (?, ?, ?)")
              .run(params.groupDid, commit.space, inviteTarget.userDid);
          }
        }

        this.db
          .prepare("DELETE FROM space_record_blob WHERE group_did = ? AND space_uri = ?")
          .run(params.groupDid, commit.space);
        this.db
          .prepare("DELETE FROM space_record WHERE space_uri = ? AND repo_did = ?")
          .run(commit.space, params.groupDid);
        this.db
          .prepare("DELETE FROM space_oplog WHERE space_uri = ? AND repo_did = ?")
          .run(commit.space, params.groupDid);
        if (commit.space === groupMembersUri(params.groupDid)) {
          this.db
            .prepare("UPDATE group_space SET index_rkey = NULL WHERE group_did = ?")
            .run(params.groupDid);
        }

        this.db
          .prepare(
            `INSERT INTO space_repo (space_uri, repo_did, set_hash, rev)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(space_uri, repo_did) DO UPDATE SET set_hash = excluded.set_hash, rev = excluded.rev`,
          )
          .run(commit.space, params.groupDid, Buffer.from(setHashBytes), commit.rev);

        const insRec = this.db.prepare(
          `INSERT INTO space_record (
             space_uri, repo_did, collection, rkey, uri, cid, value, cbor_bytes, repo_rev, indexed_at, incarnation
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const insOp = this.db.prepare(
          `INSERT INTO space_oplog (
             space_uri, repo_did, rev, idx, action, uri, collection, rkey, cid, prev
           ) VALUES (?, ?, ?, ?, 'create', ?, ?, ?, ?, NULL)`,
        );
        const insBlob = this.db.prepare(
          "INSERT OR IGNORE INTO space_record_blob (group_did, space_uri, record_uri, blob_cid) VALUES (?, ?, ?, ?)",
        );

        let idx = 0;
        for (const rec of verifiedRecords) {
          const uri = `${commit.space}/${params.groupDid}/${rec.collection}/${rec.rkey}`;
          insRec.run(
            commit.space,
            params.groupDid,
            rec.collection,
            rec.rkey,
            uri,
            rec.cidStr,
            JSON.stringify(rec.plainJson),
            Buffer.from(rec.cborBytes),
            commit.rev,
            commitNowMs,
            rec.incarnation,
          );
          insOp.run(
            commit.space,
            params.groupDid,
            commit.rev,
            idx++,
            uri,
            rec.collection,
            rec.rkey,
            rec.cidStr,
          );
          for (const blobCid of rec.blobs) {
            insBlob.run(params.groupDid, commit.space, uri, blobCid);
          }

          if (commit.space === workspaceUri(params.groupDid) && rec.collection === COLLECTION.appInstall) {
            this.db
              .prepare("INSERT OR IGNORE INTO known_app_subject (group_did, subject_did, created_at) VALUES (?, ?, ?)")
              .run(params.groupDid, String(rec.plainJson.subject), commitNowMs);
          }
          if (commit.space === groupMembersUri(params.groupDid) && rec.collection === ATGRP_COLLECTION.space) {
            const indexedSpaceUri = String(rec.plainJson.space);
            this.db
              .prepare("UPDATE group_space SET index_rkey = ? WHERE space_uri = ? AND group_did = ?")
              .run(rec.rkey, indexedSpaceUri, params.groupDid);
          }
        }
      });
      tx.immediate();
    });
  }

  // =========================================================================
  // `authorizeSpaceSync`, `verifyGroupSpaceCredential`, MAC Reads & Writer Notices
  // =========================================================================

  async authorizeSpaceSync(params: {
    space: string;
    credentialKey: string;
    delegationToken?: string;
    clientAttestation?: string;
    notify?: { endpoint: string; token: string };
    nowMs?: number;
  }): Promise<{ credential: string; spaceRev: string }> {
    const nowMs = params.nowMs ?? Date.now();
    const parsedSpace = parseSpaceUri(params.space);
    if (!parsedSpace || !isP256DidKey(params.credentialKey)) {
      throw new GroupHostHttpError(400, "InvalidRequest", "Invalid space URI or non-P256 credentialKey.");
    }
    const groupDid = parsedSpace.authorityDid;

    // Step 2: Initial lifecycle & epoch snapshot
    const acctRow = this.db
      .prepare("SELECT activated, takendown, auth_epoch FROM group_account WHERE did = ?")
      .get(groupDid) as { activated: number; takendown: number; auth_epoch: number } | undefined;
    if (!acctRow) throw new GroupHostHttpError(400, "SpaceNotFound", "Space not found.");
    if (acctRow.takendown !== 0) throw new GroupHostHttpError(400, "RepoTakendown", "Group taken down.");
    if (acctRow.activated !== 1) throw new GroupHostHttpError(400, "RepoDeactivated", "Group deactivated.");

    const delRow = this.db
      .prepare("SELECT 1 AS ok FROM group_deletion_journal WHERE group_did = ?")
      .get(groupDid);
    if (delRow) throw new GroupHostHttpError(400, "RepoTakendown", "Group deleting.");

    const migRow = this.db
      .prepare("SELECT status FROM source_migration_lease WHERE group_did = ?")
      .get(groupDid) as { status: string } | undefined;
    if (migRow?.status === "plc_signed") {
      throw new GroupHostHttpError(409, "MigrationCutoverPending", "Group cutover pending.");
    }
    const initialAuthEpoch = acctRow.auth_epoch;

    const spRow = this.db
      .prepare("SELECT deleted_at FROM group_space WHERE space_uri = ? AND group_did = ?")
      .get(params.space, groupDid) as { deleted_at: number | null } | undefined;
    if (!spRow) throw new GroupHostHttpError(400, "SpaceNotFound", "Space not found.");
    if (spRow.deleted_at !== null) throw new GroupHostHttpError(400, "SpaceDeleted", "Space deleted.");

    // Step 3: Optional delegationToken verification
    let callerRepoDid: string | undefined;
    let delegationJti: { issuerDid: string; jti: string; expMs: number } | undefined;
    if (params.delegationToken !== undefined) {
      if (typeof params.delegationToken !== "string") {
        throw new GroupHostHttpError(400, "InvalidDelegationToken", "Invalid delegationToken.");
      }
      if (params.delegationToken !== "") {
        let verifiedDel: Awaited<ReturnType<typeof verifySpaceToken<"delegation">>>;
        try {
          verifiedDel = await verifySpaceToken("delegation", params.delegationToken, {
            sub: params.space as SpaceRefString,
            aud: spaceHostAud(groupDid as DidString),
            getSigningKey: async (iss) => this.plc.resolveSigningKey(iss, "#atproto"),
          });
        } catch (err) {
          throw new GroupHostHttpError(
            400,
            "InvalidDelegationToken",
            err instanceof Error ? err.message : "Invalid delegationToken.",
          );
        }
        const nowSec = Math.floor(nowMs / 1000);
        if (
          verifiedDel.payload.iat > nowSec + 5 ||
          nowSec - 5 >= verifiedDel.payload.exp ||
          verifiedDel.payload.exp <= verifiedDel.payload.iat
        ) {
          throw new GroupHostHttpError(400, "InvalidDelegationToken", "Invalid delegationToken timestamps.");
        }
        if (
          this.db
            .prepare("SELECT 1 AS ok FROM used_delegation_jti WHERE issuer_did = ? AND jti = ? AND expires_at > ?")
            .get(verifiedDel.payload.iss, verifiedDel.payload.jti, nowMs)
        ) {
          throw new GroupHostHttpError(400, "InvalidDelegationToken", "delegationToken JTI already used.");
        }
        callerRepoDid = verifiedDel.payload.iss;
        delegationJti = {
          issuerDid: verifiedDel.payload.iss,
          jti: verifiedDel.payload.jti,
          expMs: (verifiedDel.payload.exp + 5) * 1000,
        };
      }
    }

    // Step 4: Optional clientAttestation verification (cryptographically verified across ALL origins including localhost!)
    let attestationJti: { clientId: string; jti: string; expMs: number } | undefined;
    if (params.clientAttestation !== undefined) {
      if (typeof params.clientAttestation !== "string") {
        throw new GroupHostHttpError(400, "InvalidClientAttestation", "Invalid clientAttestation.");
      }
      if (params.clientAttestation !== "") {
        let parsedAtt: ReturnType<typeof parseSpaceToken<"clientAttestation">>;
        try {
          parsedAtt = parseSpaceToken("clientAttestation", params.clientAttestation);
        } catch (err) {
          throw new GroupHostHttpError(
            400,
            "InvalidClientAttestation",
            err instanceof Error ? err.message : "Invalid clientAttestation.",
          );
        }
        const clientId = parsedAtt.payload.iss;
        const nowSec = Math.floor(nowMs / 1000);
        if (
          parsedAtt.payload.sub !== clientId ||
          parsedAtt.payload.aud !== spaceHostAud(groupDid as DidString) ||
          typeof parsedAtt.payload.iat !== "number" ||
          !Number.isFinite(parsedAtt.payload.iat) ||
          parsedAtt.payload.iat > nowSec + 5 ||
          typeof parsedAtt.payload.exp !== "number" ||
          !Number.isFinite(parsedAtt.payload.exp) ||
          nowSec - 5 >= parsedAtt.payload.exp ||
          parsedAtt.payload.exp <= parsedAtt.payload.iat
        ) {
          throw new GroupHostHttpError(400, "InvalidClientAttestation", "Invalid clientAttestation claims.");
        }
        try {
          new URL(clientId);
        } catch {
          throw new GroupHostHttpError(400, "InvalidClientAttestation", "Invalid clientAttestation clientId URL.");
        }
        if (
          this.db
            .prepare("SELECT 1 AS ok FROM used_attestation_jti WHERE client_id = ? AND jti = ? AND expires_at > ?")
            .get(clientId, parsedAtt.payload.jti, nowMs)
        ) {
          throw new GroupHostHttpError(400, "InvalidClientAttestation", "clientAttestation JTI already used.");
        }

        let jwks: jose.JSONWebKeySet | undefined;
        try {
          const metaRes = await this.jwksMetadataFetcher(clientId, {
            method: "GET",
            headers: { accept: "application/json" },
          });
          if (!metaRes.ok) {
            throw new Error(`HTTP ${metaRes.status}`);
          }
          const meta = await readUpstreamJson<{ jwks?: jose.JSONWebKeySet; jwks_uri?: string }>(metaRes, 262_144);
          jwks = meta?.jwks;
          if (!jwks && meta?.jwks_uri) {
            const jwksRes = await this.jwksMetadataFetcher(meta.jwks_uri, {
              method: "GET",
              headers: { accept: "application/jwk-set+json, application/json" },
            });
            if (jwksRes.ok) {
              jwks = (await readUpstreamJson<jose.JSONWebKeySet>(jwksRes, 262_144)) ?? undefined;
            }
          }
        } catch {
          throw new GroupHostHttpError(400, "InvalidClientAttestation", "Could not fetch client metadata.");
        }
        if (!jwks || !Array.isArray(jwks.keys)) {
          throw new GroupHostHttpError(400, "InvalidClientAttestation", "Client metadata missing JWKS.");
        }
        try {
          const keySet = jose.createLocalJWKSet(jwks);
          await jose.jwtVerify(params.clientAttestation, keySet, {
            typ: "atproto-client-attestation+jwt",
            issuer: clientId,
            subject: clientId,
            audience: spaceHostAud(groupDid as DidString),
            clockTolerance: 5,
            currentDate: new Date(nowMs),
          });
        } catch (err) {
          throw new GroupHostHttpError(
            400,
            "InvalidClientAttestation",
            err instanceof Error ? err.message : "Bad clientAttestation signature.",
          );
        }
        attestationJti = {
          clientId,
          jti: parsedAtt.payload.jti,
          expMs: (parsedAtt.payload.exp + 5) * 1000,
        };
      }
    }

    // Consume single-use delegation/attestation JTIs up front & check initial policy!
    const preCheckState = loadLiveGovernanceState(this.db, groupDid);
    const initiallyAuthorized = liveRoleGrantsRead(
      preCheckState,
      params.space,
      callerRepoDid ?? "",
      groupDid,
    );
    if (!initiallyAuthorized) {
      if (params.notify) {
        this.db
          .prepare("DELETE FROM notify_registration WHERE space_uri = ? AND endpoint = ? AND token = ?")
          .run(params.space, params.notify.endpoint, params.notify.token);
      }
      throw new GroupHostHttpError(400, "SpaceNotFound", "Space not found.");
    }

    // Step 6: Synchronous confirmRegistration if unseen `(space, endpoint, token)`
    if (params.notify) {
      const seenReg = this.db
        .prepare("SELECT 1 AS ok FROM notify_registration WHERE space_uri = ? AND endpoint = ? AND token = ?")
        .get(params.space, params.notify.endpoint, params.notify.token);
      if (!seenReg) {
        const challenge = randomUUID();
        const confirmUrl = new URL("/xrpc/com.atproto.space.confirmRegistration", params.notify.endpoint);
        const res = await this.noticeFetcher(confirmUrl.toString(), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            authorization: `Bearer ${params.notify.token}`,
          },
          body: JSON.stringify({ space: params.space, token: params.notify.token, challenge }),
        });
        if (!res.ok) {
          throw new GroupHostHttpError(400, "InvalidNotifyEndpoint", `confirmRegistration failed (${res.status}).`);
        }
        const confirmBody = await readUpstreamJson<{ challenge?: string }>(res, 65_536);
        if (confirmBody?.challenge !== challenge) {
          throw new GroupHostHttpError(400, "InvalidNotifyEndpoint", "confirmRegistration challenge mismatch.");
        }
      }
    }

    // Step 7: Pre-sign 10-min credential, then synchronous IMMEDIATE final re-verification & commit!
    const signingKey = await this.getGroupSigningKey(groupDid);
    const credentialJwt = await createSpaceCredential({
      iss: groupDid as DidString,
      sub: params.space as SpaceRefString,
      keyId: params.credentialKey as DidString,
      keypair: signingKey,
      expiresInSec: SPACE_CREDENTIAL_TTL_SEC,
    });
    const parsedCred = parseSpaceToken("credential", credentialJwt);
    const credJti = parsedCred.payload.jti;
    const expSec = parsedCred.payload.exp;

    const tx = this.db.transaction(() => {
      if (delegationJti) {
        const used = this.db
          .prepare("SELECT 1 AS ok FROM used_delegation_jti WHERE issuer_did = ? AND jti = ? AND expires_at > ?")
          .get(delegationJti.issuerDid, delegationJti.jti, nowMs);
        if (used) {
          throw new GroupHostHttpError(400, "InvalidDelegationToken", "delegationToken JTI already used.");
        }
        this.db
          .prepare(
            "INSERT OR REPLACE INTO used_delegation_jti (issuer_did, jti, group_did, expires_at) VALUES (?, ?, ?, ?)",
          )
          .run(delegationJti.issuerDid, delegationJti.jti, groupDid, delegationJti.expMs);
      }
      if (attestationJti) {
        const used = this.db
          .prepare("SELECT 1 AS ok FROM used_attestation_jti WHERE client_id = ? AND jti = ? AND expires_at > ?")
          .get(attestationJti.clientId, attestationJti.jti, nowMs);
        if (used) {
          throw new GroupHostHttpError(400, "InvalidClientAttestation", "clientAttestation JTI already used.");
        }
        this.db
          .prepare(
            "INSERT OR REPLACE INTO used_attestation_jti (client_id, jti, group_did, expires_at) VALUES (?, ?, ?, ?)",
          )
          .run(attestationJti.clientId, attestationJti.jti, groupDid, attestationJti.expMs);
      }

      const finalAcct = this.db
        .prepare("SELECT activated, takendown, auth_epoch FROM group_account WHERE did = ?")
        .get(groupDid) as { activated: number; takendown: number; auth_epoch: number } | undefined;
      if (!finalAcct) throw new GroupHostHttpError(400, "SpaceNotFound", "Space not found.");
      if (finalAcct.takendown !== 0) throw new GroupHostHttpError(400, "RepoTakendown", "Group taken down.");
      if (finalAcct.activated !== 1) throw new GroupHostHttpError(400, "RepoDeactivated", "Group deactivated.");
      if (finalAcct.auth_epoch !== initialAuthEpoch) {
        throw new GroupHostHttpError(400, "SpaceNotFound", "Authorization epoch changed concurrently.");
      }
      if (this.db.prepare("SELECT 1 AS ok FROM group_deletion_journal WHERE group_did = ?").get(groupDid)) {
        throw new GroupHostHttpError(400, "RepoTakendown", "Group deleting.");
      }
      const finalMig = this.db
        .prepare("SELECT status FROM source_migration_lease WHERE group_did = ?")
        .get(groupDid) as { status: string } | undefined;
      if (finalMig?.status === "plc_signed") {
        throw new GroupHostHttpError(409, "MigrationCutoverPending", "Group cutover pending.");
      }
      const finalSpace = this.db
        .prepare("SELECT space_rev, deleted_at FROM group_space WHERE space_uri = ? AND group_did = ?")
        .get(params.space, groupDid) as { space_rev: string; deleted_at: number | null } | undefined;
      if (!finalSpace) throw new GroupHostHttpError(400, "SpaceNotFound", "Space not found.");
      if (finalSpace.deleted_at !== null) throw new GroupHostHttpError(400, "SpaceDeleted", "Space deleted.");

      const finalState = loadLiveGovernanceState(this.db, groupDid);
      if (!liveRoleGrantsRead(finalState, params.space, callerRepoDid ?? "", groupDid)) {
        if (params.notify) {
          this.db
            .prepare("DELETE FROM notify_registration WHERE space_uri = ? AND endpoint = ? AND token = ?")
            .run(params.space, params.notify.endpoint, params.notify.token);
        }
        throw new GroupHostHttpError(400, "SpaceNotFound", "Space not found.");
      }

      this.db
        .prepare(
          `INSERT INTO issued_credential (jti, group_did, space_uri, writer_did, cnf_kid, exp, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          credJti,
          groupDid,
          params.space,
          callerRepoDid ?? null,
          params.credentialKey,
          expSec,
          nowMs,
        );

      if (params.notify) {
        this.db
          .prepare(
            `INSERT INTO notify_registration (space_uri, group_did, endpoint, token, expires_at, lapsed_notified, updated_at)
             VALUES (?, ?, ?, ?, ?, 0, ?)
             ON CONFLICT(space_uri, endpoint, token) DO UPDATE SET
               expires_at = excluded.expires_at, lapsed_notified = 0, updated_at = excluded.updated_at`,
          )
          .run(
            params.space,
            groupDid,
            params.notify.endpoint,
            params.notify.token,
            expSec * 1000,
            nowMs,
          );
      }

      return { credential: credentialJwt, spaceRev: finalSpace.space_rev };
    });

    return tx.immediate();
  }

  async mintDelegationToken(
    groupDid: string,
    spaceUriValue: string,
  ): Promise<{ token: string; delegationToken: string }> {
    const parsedSpace = parseSpaceUri(spaceUriValue);
    if (!parsedSpace) throw new GroupHostHttpError(400, "InvalidRequest", "Invalid space URI.");
    const signingKey = await this.getGroupSigningKey(groupDid);
    const delegationToken = await createDelegationToken({
      iss: groupDid as DidString,
      sub: spaceUriValue as SpaceRefString,
      aud: spaceHostAud(parsedSpace.authorityDid as DidString),
      keypair: signingKey,
      expiresInSec: DELEGATION_TOKEN_TTL_SEC,
    });
    return { token: delegationToken, delegationToken };
  }

  /**
   * Verifies `Atproto-Space-Credential` with strict zero-skew `nowSec >= payload.exp` rejection,
   * `revoked_credential` check, `Atproto-Space-Audience` check, and RFC 9421 `verifyCredentialSig` PoP!
   */
  async verifyGroupSpaceCredential(params: {
    spaceUri: string;
    expectedAudienceDid: string;
    method: string;
    url: string;
    headers: Record<string, string | undefined>;
    nowMs?: number;
  }): Promise<{ cnfKid: string; jti: string }> {
    const nowMs = params.nowMs ?? Date.now();
    const nowSec = Math.floor(nowMs / 1000);

    const authHeader = params.headers.authorization ?? "";
    const prefix = "Atproto-Space-Credential ";
    if (!authHeader.startsWith(prefix)) {
      throw new GroupHostHttpError(401, "InvalidToken", "Expected Atproto-Space-Credential authorization scheme.");
    }
    const jwt = authHeader.slice(prefix.length).trim();
    const parsedSpace = parseSpaceUri(params.spaceUri);
    if (!parsedSpace) {
      throw new GroupHostHttpError(400, "InvalidRequest", "Invalid space URI.");
    }

    let verified: Awaited<ReturnType<typeof verifySpaceToken<"credential">>>;
    try {
      verified = await verifySpaceToken("credential", jwt, {
        sub: params.spaceUri as SpaceRefString,
        getSigningKey: async (iss) => this.plc.resolveSigningKey(iss, "#atproto"),
      });
    } catch (err) {
      throw new GroupHostHttpError(401, "InvalidToken", err instanceof Error ? err.message : "Invalid space credential.");
    }

    // Strict zero-skew expiry check (matching strict-credential-expiry.patch & operator security.ts:250)!
    if (nowSec >= verified.payload.exp) {
      throw new GroupHostHttpError(401, "ExpiredToken", "Space credential has expired (strict zero-skew).");
    }
    if (verified.payload.iss !== parsedSpace.authorityDid) {
      throw new GroupHostHttpError(401, "InvalidToken", "Space credential issuer does not match space authority.");
    }

    const revoked = this.db
      .prepare("SELECT 1 AS ok FROM revoked_credential WHERE group_did = ? AND space_uri = ? AND jti = ? AND exp > ?")
      .get(params.expectedAudienceDid, params.spaceUri, verified.payload.jti, nowSec);
    if (revoked) {
      throw new GroupHostHttpError(401, "InvalidToken", "Space credential has been revoked.");
    }

    const audHeader = params.headers["atproto-space-audience"];
    if (audHeader !== params.expectedAudienceDid) {
      throw new GroupHostHttpError(
        401,
        "InvalidToken",
        `Atproto-Space-Audience mismatch: expected ${params.expectedAudienceDid}, got ${audHeader ?? "missing"}.`,
      );
    }

    try {
      await verifyCredentialSig(params.headers, verified.payload.cnf.kid as DidString);
    } catch (err) {
      throw new GroupHostHttpError(401, "InvalidSignature", err instanceof Error ? err.message : "Invalid RFC 9421 credential proof.");
    }

    return { cnfKid: verified.payload.cnf.kid, jti: verified.payload.jti };
  }

  async createResponseMacHeaders(params: {
    groupDid: string;
    profile: MacProfile;
    acceptSignatureHeader: string | undefined;
    isSpaceCredential: boolean;
    recordMeta?: { uri: string; cid: string };
    commitMeta?: SpaceCommit;
  }): Promise<Record<string, string>> {
    let macReq: ReturnType<typeof parseMacRequest>;
    try {
      macReq = parseMacRequest(params.acceptSignatureHeader, params.profile);
    } catch (err) {
      throw new GroupHostHttpError(400, "InvalidSpaceMac", err instanceof Error ? err.message : "Invalid Accept-Signature header.");
    }
    if (!macReq) {
      if (params.isSpaceCredential) {
        throw new GroupHostHttpError(400, "InvalidSpaceMac", `A MAC must be requested with tag "${params.profile}".`);
      }
      return {};
    }
    const kemKey = (await this.getGroupKemKey(params.groupDid)) as P256Keypair;
    let sharedSecret: Uint8Array;
    try {
      sharedSecret = decapsulate(kemKey, macReq.keyShare);
    } catch (err) {
      throw new GroupHostHttpError(400, "InvalidSpaceMac", err instanceof Error ? err.message : "HPKE decapsulation failed.");
    }

    if (params.profile === RECORD_MAC_PROFILE && params.recordMeta) {
      return createRecordMacHeaders(
        params.recordMeta.uri as AtUriString,
        parseCid(params.recordMeta.cid),
        { ...macReq, sharedSecret },
      ).headers;
    }
    if (params.profile === COMMIT_MAC_PROFILE && params.commitMeta) {
      return createCommitMacHeaders(params.commitMeta, { ...macReq, sharedSecret }).headers;
    }
    throw new GroupHostHttpError(500, "InternalServerError", "Missing MAC metadata.");
  }

  async handleNotifyRepoUpdate(params: {
    space: string;
    repo: string;
    repoRev: string;
    dataInput: unknown;
    nowMs?: number;
  }): Promise<void> {
    const nowMs = params.nowMs ?? Date.now();
    const parsedSpace = parseSpaceUri(params.space);
    if (!parsedSpace) throw new GroupHostHttpError(400, "InvalidRequest", "Invalid space URI.");
    const groupDid = parsedSpace.authorityDid;

    // Canonical pinned `isValidTid` check BEFORE `TID.fromStr` (rejecting leading k..z!)
    if (!isTid(params.repoRev)) {
      throw new GroupHostHttpError(400, "InvalidRequest", "repoRev must be a canonical 13-char TID starting with [234567abcdefghij].");
    }
    const revTid = TID.fromStr(params.repoRev);
    const revMs = Math.floor(revTid.timestamp() / 1000);
    if (revMs > nowMs + 5 * 60_000) {
      throw new GroupHostHttpError(400, "FutureRev", "repoRev is more than 5 minutes in the future.");
    }

    let dataBytes: Buffer;
    try {
      let rawB64: string;
      if (typeof params.dataInput === "string") {
        rawB64 = params.dataInput;
      } else if (
        params.dataInput &&
        typeof params.dataInput === "object" &&
        !Array.isArray(params.dataInput) &&
        typeof (params.dataInput as { $bytes?: unknown }).$bytes === "string"
      ) {
        rawB64 = (params.dataInput as { $bytes: string }).$bytes;
      } else {
        throw new Error("missing bytes");
      }
      if (rawB64.length === 0) {
        throw new Error("empty bytes");
      }
      dataBytes = Buffer.from(fromBase64(rawB64));
    } catch {
      throw new GroupHostHttpError(400, "InvalidRequest", "Invalid base64 data digest.");
    }
    if (dataBytes.byteLength !== 32) {
      throw new GroupHostHttpError(400, "InvalidRequest", "Repo commit data digest must be 32 bytes.");
    }

    return this.locks.withGroupRepoLock(groupDid, () => {
      const tx = this.db.transaction(() => {
        reapExpiredPreparedMigrationLease(this.db, groupDid, nowMs);
        if (hasActiveSourceMigrationLease(this.db, groupDid, nowMs)) {
          throw new GroupHostHttpError(409, "MigrationInProgress", "Group is frozen during active migration.");
        }
        const acct = this.db
          .prepare("SELECT activated, takendown FROM group_account WHERE did = ?")
          .get(groupDid) as { activated: number; takendown: number } | undefined;
        if (!acct || acct.takendown !== 0) throw new GroupHostHttpError(400, "RepoTakendown");
        if (acct.activated !== 1) throw new GroupHostHttpError(400, "RepoDeactivated");

        const spRow = this.db
          .prepare("SELECT deleted_at FROM group_space WHERE space_uri = ? AND group_did = ?")
          .get(params.space, groupDid) as { deleted_at: number | null } | undefined;
        if (!spRow || spRow.deleted_at !== null) {
          throw new GroupHostHttpError(400, "SpaceNotFound", "Space not found.");
        }

        const state = loadLiveGovernanceState(this.db, groupDid);
        if (!liveRoleGrantsWrite(state, params.space, params.repo, groupDid)) {
          throw new GroupHostHttpError(403, "Forbidden", `${params.repo} does not hold write access to ${params.space}.`);
        }

        // Post-ejection stale-repo defense on `members/self`!
        if (params.space === groupMembersUri(groupDid)) {
          const membership = state.memberships.get(params.repo);
          if (membership) {
            const ext = decodeFlockMembershipExtensions(membership);
            if (!ext.valid) {
              throw new GroupHostHttpError(400, ext.code, ext.reason);
            }
            if (ext.afterWriterRev !== undefined && ext.afterWriterRev !== null) {
              if (!(params.repoRev > ext.afterWriterRev)) {
                throw new GroupHostHttpError(
                  409,
                  "StalePreEjectionRepo",
                  `Writer repoRev (${params.repoRev}) does not advance past pre-ejection rev (${ext.afterWriterRev}).`,
                );
              }
            }
          }
        }

        const existingWriter = this.db
          .prepare("SELECT removed, repo_rev FROM space_writer WHERE space_uri = ? AND writer_did = ?")
          .get(params.space, params.repo) as { removed: number; repo_rev: string } | undefined;
        if (existingWriter && existingWriter.removed === 0 && existingWriter.repo_rev >= params.repoRev) {
          // Idempotent / older revision ignored cleanly
          return;
        }

        const spaceRev = this.bumpGroupSpaceRevSync(params.space, nowMs);
        this.db
          .prepare(
            `INSERT INTO space_writer (space_uri, group_did, writer_did, removed, repo_rev, space_rev, data, updated_at)
             VALUES (?, ?, ?, 0, ?, ?, ?, ?)
             ON CONFLICT(space_uri, writer_did) DO UPDATE SET
               removed = 0, repo_rev = excluded.repo_rev, space_rev = excluded.space_rev, data = excluded.data, updated_at = excluded.updated_at`,
          )
          .run(params.space, groupDid, params.repo, params.repoRev, spaceRev, dataBytes, nowMs);

        this.enqueueSyncerSpaceUpdateSync({
          groupDid,
          spaceUri: params.space,
          update: {
            $type: "com.atproto.space.defs#repoWrite",
            repo: params.repo,
            repoRev: params.repoRev,
            spaceRev,
            data: lexToJson(new Uint8Array(dataBytes)),
          },
          nowMs,
        });
      });
      tx.immediate();
    });
  }

  private readonly credRevocationWindows = new Map<string, Array<{ atMs: number; count: number }>>();

  handleNotifyCredentialsRevokedSync(params: {
    hostedGroupDid: string;
    issuerDid?: string;
    serviceJwtJti?: string;
    serviceJwtExpSec?: number;
    space: string;
    credentials: readonly string[];
    nowMs?: number;
  }): void {
    const nowMs = params.nowMs ?? Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const expSec = nowSec + SPACE_CREDENTIAL_TTL_SEC;
    const bareIss = params.issuerDid;
    const jti = params.serviceJwtJti;
    const jtiExpMs = ((params.serviceJwtExpSec ?? nowSec + 60) + 5) * 1000;
    const uniqueCredentials = [...new Set(params.credentials)];

    const tx = this.db.transaction(() => {
      if (bareIss !== undefined && jti !== undefined) {
        const jtiKey = `credrev:${bareIss}:${jti}`;
        this.db
          .prepare("DELETE FROM service_jwt_jti WHERE issuer_did = ? AND jti = ? AND expires_at <= ?")
          .run(bareIss, jtiKey, nowMs);
        const existingJti = this.db
          .prepare("SELECT 1 AS ok FROM service_jwt_jti WHERE issuer_did = ? AND jti = ?")
          .get(bareIss, jtiKey);
        if (existingJti) {
          throw new GroupHostHttpError(401, "ReplayDetected", "notifyCredentialsRevoked JWT jti already consumed.");
        }

        // Sliding-window per-(bareIss, hostedGroupDid) rate & credential-ID amplification cap (30 reqs or 2,000 IDs / 60s)
        const windowKey = `${bareIss}\u0000${params.hostedGroupDid}`;
        const cutoffMs = nowMs - 60_000;
        if (this.credRevocationWindows.size > 4_096) {
          for (const [k, entries] of this.credRevocationWindows) {
            const live = entries.filter((e) => e.atMs > cutoffMs);
            if (live.length === 0) this.credRevocationWindows.delete(k);
            else this.credRevocationWindows.set(k, live);
          }
        }
        const recent = (this.credRevocationWindows.get(windowKey) ?? []).filter((e) => e.atMs > cutoffMs);
        const recentIds = recent.reduce((acc, e) => acc + e.count, 0);
        if (recent.length + 1 > 30 || recentIds + params.credentials.length > 2_000) {
          this.credRevocationWindows.set(windowKey, recent);
          throw new GroupHostHttpError(
            429,
            "RateLimitExceeded",
            "notifyCredentialsRevoked rate or amplification limit exceeded.",
          );
        }

        // Prune expired rows for (hostedGroupDid, space) before enforcing the 10,000-row stored cap
        this.db
          .prepare("DELETE FROM revoked_credential WHERE group_did = ? AND space_uri = ? AND exp <= ?")
          .run(params.hostedGroupDid, params.space, nowSec);
        const activeCount = (
          this.db
            .prepare("SELECT COUNT(*) AS cnt FROM revoked_credential WHERE group_did = ? AND space_uri = ?")
            .get(params.hostedGroupDid, params.space) as { cnt: number }
        ).cnt;
        const existsStmt = this.db.prepare(
          "SELECT 1 AS ok FROM revoked_credential WHERE group_did = ? AND space_uri = ? AND jti = ?",
        );
        let netNew = 0;
        for (const credJti of uniqueCredentials) {
          if (!existsStmt.get(params.hostedGroupDid, params.space, credJti)) {
            netNew += 1;
          }
        }
        if (activeCount + netNew > 10_000) {
          throw new GroupHostHttpError(
            429,
            "RateLimitExceeded",
            "Stored revoked_credential quota exceeded for target space.",
          );
        }

        this.db
          .prepare("INSERT INTO service_jwt_jti (issuer_did, jti, group_did, expires_at) VALUES (?, ?, ?, ?)")
          .run(bareIss, jtiKey, params.hostedGroupDid, jtiExpMs);

        recent.push({ atMs: nowMs, count: params.credentials.length });
        this.credRevocationWindows.set(windowKey, recent);
      } else {
        this.db
          .prepare("DELETE FROM revoked_credential WHERE group_did = ? AND space_uri = ? AND exp <= ?")
          .run(params.hostedGroupDid, params.space, nowSec);
      }

      const ins = this.db.prepare(
        "INSERT OR REPLACE INTO revoked_credential (jti, group_did, space_uri, exp, revoked_at) VALUES (?, ?, ?, ?, ?)",
      );
      for (const credJti of uniqueCredentials) {
        ins.run(credJti, params.hostedGroupDid, params.space, expSec, nowMs);
      }
    });
    tx.immediate();
  }

  // =========================================================================
  // Outbox Worker & 4-State Pre-Tombstone Zero-Residue `deleteAccount` Machine
  // =========================================================================

  async signGroupServiceJwt(params: {
    groupDid: string;
    aud: string;
    lxm: string;
    expSec?: number;
    nowMs?: number;
  }): Promise<string> {
    const nowMs = params.nowMs ?? Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const exp = params.expSec ?? nowSec + 60;
    const signingKey = await this.getGroupSigningKey(params.groupDid);
    const header = { alg: "ES256", typ: "JWT", kid: "#atproto" };
    const payload = {
      iss: params.groupDid,
      aud: params.aud,
      lxm: params.lxm,
      iat: nowSec,
      exp,
      jti: randomUUID(),
    };
    const signingInput = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
    const sig = await signingKey.sign(Buffer.from(signingInput, "utf8"));
    return `${signingInput}.${Buffer.from(sig).toString("base64url")}`;
  }

  private outboxFlushChain: Promise<void> = Promise.resolve();

  async flushOutboxNotices(options: { groupDid?: string; nowMs?: number } = {}): Promise<void> {
    const next = this.outboxFlushChain.then(
      () => this.flushOutboxNoticesSerial(options),
      () => this.flushOutboxNoticesSerial(options),
    );
    this.outboxFlushChain = next.catch(() => undefined);
    return next;
  }

  private async flushOutboxNoticesSerial(options: { groupDid?: string; nowMs?: number } = {}): Promise<void> {
    const nowMs = options.nowMs ?? Date.now();
    const dueRows = (
      options.groupDid
        ? this.db
            .prepare(
              `SELECT * FROM outbox_notice
               WHERE group_did = ? AND status IN ('pending', 'leased')
                 AND (lease_until IS NULL OR lease_until <= ?)
               ORDER BY next_attempt_at ASC
               LIMIT 100`,
            )
            .all(options.groupDid, nowMs)
        : this.db
            .prepare(
              `SELECT * FROM outbox_notice
               WHERE status IN ('pending', 'leased')
                 AND next_attempt_at <= ?
                 AND (lease_until IS NULL OR lease_until <= ?)
               ORDER BY next_attempt_at ASC
               LIMIT 100`,
            )
            .all(nowMs, nowMs)
    ) as Array<{
      id: string;
      kind: "syncer_update" | "credential_revocation" | "invite_repo_update" | "source_migration_finalize";
      group_did: string;
      endpoint: string;
      token: string | null;
      space_uri: string | null;
      writer_did: string | null;
      payload_json: string;
      attempts: number;
      max_attempts: number;
      expires_at: number;
    }>;

    for (const row of dueRows) {
      if (row.expires_at <= nowMs || row.attempts >= row.max_attempts) {
        this.db
          .prepare("UPDATE outbox_notice SET status = 'abandoned', lease_until = NULL WHERE id = ?")
          .run(row.id);
        continue;
      }

      this.db
        .prepare("UPDATE outbox_notice SET status = 'leased', lease_until = ? WHERE id = ?")
        .run(nowMs + 15_000, row.id);

      let delivered = false;
      let nonRetryable = false;
      let errMessage = "";

      try {
        if (row.kind === "syncer_update") {
          const url = new URL("/xrpc/com.atproto.space.notifySpaceUpdate", row.endpoint).toString();
          const res = await this.noticeFetcher(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json",
              ...(row.token ? { authorization: `Bearer ${row.token}` } : {}),
            },
            body: row.payload_json,
          });
          if (res.ok) {
            delivered = true;
          } else {
            errMessage = `HTTP ${res.status}`;
            if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
              nonRetryable = true;
              if (row.space_uri && row.token) {
                this.db
                  .prepare("DELETE FROM notify_registration WHERE space_uri = ? AND endpoint = ? AND token = ?")
                  .run(row.space_uri, row.endpoint, row.token);
              }
            }
          }
        } else if (row.kind === "credential_revocation") {
          const writerDid = row.writer_did!;
          const doc = await this.plc.resolveDidDocument(writerDid);
          const pdsOrigin = doc ? this.plc.extractPdsEndpoint(doc) : null;
          if (!pdsOrigin) {
            nonRetryable = true;
            errMessage = "Writer PDS endpoint unresolvable";
          } else {
            // Bare writer DID audience per `notifyCredentialsRevoked.ts:16-27`!
            const jwt = await this.signGroupServiceJwt({
              groupDid: row.group_did,
              aud: writerDid,
              lxm: "com.atproto.space.notifyCredentialsRevoked",
              nowMs,
            });
            const url = new URL("/xrpc/com.atproto.space.notifyCredentialsRevoked", pdsOrigin).toString();
            const res = await this.noticeFetcher(url, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                accept: "application/json",
                authorization: `Bearer ${jwt}`,
              },
              body: row.payload_json,
            });
            if (res.ok) delivered = true;
            else {
              errMessage = `HTTP ${res.status}`;
              if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
                nonRetryable = true;
              }
            }
          }
        } else if (row.kind === "invite_repo_update") {
          const inviteeDid = row.writer_did!;
          const doc = await this.plc.resolveDidDocument(inviteeDid);
          const pdsOrigin = doc ? this.plc.extractPdsEndpoint(doc) : null;
          if (!pdsOrigin) {
            nonRetryable = true;
            errMessage = "Invitee PDS endpoint unresolvable";
          } else {
            const jwt = await this.signGroupServiceJwt({
              groupDid: row.group_did,
              aud: `${inviteeDid}#atproto_pds`,
              lxm: "com.atproto.space.notifyRepoUpdate",
              nowMs,
            });
            const url = new URL("/xrpc/com.atproto.space.notifyRepoUpdate", pdsOrigin).toString();
            const res = await this.noticeFetcher(url, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                accept: "application/json",
                authorization: `Bearer ${jwt}`,
              },
              body: row.payload_json,
            });
            if (res.ok) {
              delivered = true;
              if (row.space_uri) {
                this.db
                  .prepare(
                    "UPDATE invite_delivery SET status = 'delivered', last_error = NULL, updated_at = ? WHERE group_did = ? AND space_uri = ?",
                  )
                  .run(nowMs, row.group_did, row.space_uri);
              }
            } else {
              const errBody = await res.text().catch(() => "");
              errMessage = `HTTP ${res.status}${errBody ? `: ${errBody.slice(0, 120)}` : ""}`;
              if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
                nonRetryable = true;
              }
            }
          }
        } else if (row.kind === "source_migration_finalize") {
          const targetPayload = JSON.parse(row.payload_json) as {
            group: string;
            operationId?: string;
            sourceServiceDid: string;
          };
          const jwt = await this.signGroupServiceJwt({
            groupDid: row.group_did,
            aud: targetPayload.sourceServiceDid,
            lxm: "com.atproto.server.deactivateAccount",
            nowMs,
          });
          const url = new URL("/group-admin/finalize-migrated-source", row.endpoint).toString();
          const res = await this.noticeFetcher(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json",
              authorization: `Bearer ${jwt}`,
            },
            body: JSON.stringify({
              group: targetPayload.group,
              ...(targetPayload.operationId ? { operationId: targetPayload.operationId } : {}),
            }),
          });
          if (res.ok) delivered = true;
          else {
            errMessage = `HTTP ${res.status}`;
            if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
              nonRetryable = true;
            }
          }
        }
      } catch (err) {
        errMessage = err instanceof Error ? err.message : "Network error";
      }

      const nextAttempts = row.attempts + 1;
      if (delivered) {
        this.db
          .prepare(
            "UPDATE outbox_notice SET status = 'delivered', attempts = ?, lease_until = NULL, last_error = NULL WHERE id = ?",
          )
          .run(nextAttempts, row.id);
      } else if (nonRetryable || nextAttempts >= row.max_attempts || row.expires_at <= nowMs) {
        this.db
          .prepare(
            "UPDATE outbox_notice SET status = 'abandoned', attempts = ?, lease_until = NULL, last_error = ? WHERE id = ?",
          )
          .run(nextAttempts, errMessage, row.id);
        if (row.kind === "invite_repo_update" && row.space_uri) {
          this.db
            .prepare(
              "UPDATE invite_delivery SET status = 'failed', attempts = ?, last_error = ?, updated_at = ? WHERE group_did = ? AND space_uri = ?",
            )
            .run(nextAttempts, errMessage, nowMs, row.group_did, row.space_uri);
        }
      } else {
        const backoffMs = Math.min(1000 * 2 ** (nextAttempts - 1), 10_000);
        this.db
          .prepare(
            "UPDATE outbox_notice SET status = 'pending', attempts = ?, lease_until = NULL, next_attempt_at = ?, last_error = ? WHERE id = ?",
          )
          .run(nextAttempts, nowMs + backoffMs, errMessage, row.id);
        if (row.kind === "invite_repo_update" && row.space_uri) {
          this.db
            .prepare(
              "UPDATE invite_delivery SET status = 'failed', attempts = ?, last_error = ?, updated_at = ? WHERE group_did = ? AND space_uri = ?",
            )
            .run(nextAttempts, errMessage, nowMs, row.group_did, row.space_uri);
        }
      }
    }
  }

  async requestAccountDelete(params: {
    groupDid: string;
    actorDid: string;
    session:
      | AuthenticatedGroupSession
      | { sessionKind: "group" | "recovery"; authorizingUserDid: string; authenticatedAt: number; loginStepUpAt?: number | null };
    rawTokenHex: string;
    tokenHashHex: string;
    nowMs?: number;
  }): Promise<void> {
    return this.locks.withGroupRepoLock(params.groupDid, () => {
      this.requestAccountDeleteSync(params);
    });
  }

  requestAccountDeleteSync(params: {
    groupDid: string;
    actorDid: string;
    session:
      | AuthenticatedGroupSession
      | { sessionKind: "group" | "recovery"; authorizingUserDid: string; authenticatedAt: number; loginStepUpAt?: number | null };
    rawTokenHex: string;
    tokenHashHex: string;
    nowMs?: number;
  }): void {
    const nowMs = params.nowMs ?? Date.now();
    assertFreshLoginStepUp(
      params.session,
      nowMs,
      "requestAccountDelete requires prompt=login within the last 5 minutes.",
    );
    const tx = this.db.transaction(() => {
      reapExpiredPreparedMigrationLease(this.db, params.groupDid, nowMs);
      if (hasActiveSourceMigrationLease(this.db, params.groupDid, nowMs)) {
        throw new GroupHostHttpError(409, "MigrationInProgress", "Cannot delete group during active migration.");
      }
      let effState: LiveGroupGovernanceState;
      if ("sessionId" in params.session) {
        const revalidated = revalidateLiveOAuthSessionSync(this.db, params.session, {
          allowDeactivatedRecovery: true,
          nowMs,
        });
        revalidated.permissions.assertAccount({ attr: "status", action: "manage" });
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

      const enc = this.cryptoBox.encryptColumn(
        "group_action_token",
        `${params.groupDid}:delete_account`,
        "claim_ciphertext_enc",
        params.rawTokenHex,
      );
      this.db
        .prepare(
          `INSERT INTO group_action_token (
             token_hash, group_did, actor_did, purpose, claim_ciphertext_enc, claimed_at, expires_at, created_at
           ) VALUES (?, ?, ?, 'delete_account', ?, NULL, ?, ?)
           ON CONFLICT(group_did, purpose) DO UPDATE SET
             token_hash = excluded.token_hash,
             actor_did = excluded.actor_did,
             claim_ciphertext_enc = excluded.claim_ciphertext_enc,
             claimed_at = NULL,
             expires_at = excluded.expires_at,
             created_at = excluded.created_at`,
        )
        .run(
          params.tokenHashHex,
          params.groupDid,
          params.actorDid,
          enc,
          nowMs + 10 * 60_000,
          nowMs,
        );
    });
    tx.immediate();
  }

  /**
   * Crash-safe 4-state Pre-Tombstone Zero-Residue `deleteAccount` state machine:
   * `remote_cleanup_queued` -> `remote_cleanup_drained` -> `plc_tombstoned` -> `purged`!
   */
  async executeOrResumeDeleteAccount(params: {
    groupDid: string;
    initCall?: {
      actorDid: string;
      password?: string;
      tokenHashHex: string;
      session:
        | AuthenticatedGroupSession
        | { sessionKind: "group" | "recovery"; authorizingUserDid: string; authenticatedAt: number; loginStepUpAt?: number | null };
    };
    stopAfterState?: "remote_cleanup_queued" | "remote_cleanup_drained" | "plc_tombstoned";
    nowMs?: number;
  }): Promise<void> {
    const nowMs = params.nowMs ?? Date.now();
    return this.locks.withGroupRepoLock(params.groupDid, async () => {
      let journal = this.db
        .prepare("SELECT * FROM group_deletion_journal WHERE group_did = ?")
        .get(params.groupDid) as
        | { group_did: string; actor_did: string; plc_outcome: string | null; status: string }
        | undefined;

      // State 1: `remote_cleanup_queued`
      if (!journal) {
        if (!params.initCall) return;
        const { actorDid, password, tokenHashHex, session } = params.initCall;
        if (password !== undefined && password !== params.groupDid) {
          throw new GroupHostHttpError(401, "InvalidPassword", "For atmospheric groups, password must equal group DID.");
        }
        assertFreshLoginStepUp(session, nowMs, "deleteAccount requires prompt=login within the last 5 minutes.");

        const tx1 = this.db.transaction(() => {
          reapExpiredPreparedMigrationLease(this.db, params.groupDid, nowMs);
          if (hasActiveSourceMigrationLease(this.db, params.groupDid, nowMs)) {
            throw new GroupHostHttpError(409, "MigrationInProgress", "Cannot delete group during active migration.");
          }
          let effState: LiveGroupGovernanceState;
          if ("sessionId" in session) {
            const revalidated = revalidateLiveOAuthSessionSync(this.db, session, {
              allowDeactivatedRecovery: true,
              allowDeletionJournal: true,
              nowMs,
            });
            revalidated.permissions.assertAccount({ attr: "status", action: "manage" });
            effState = revalidated.effState;
          } else {
            const liveState = loadLiveGovernanceState(this.db, params.groupDid);
            const recoveryRow = this.db
              .prepare("SELECT * FROM group_recovery_admin WHERE group_did = ?")
              .get(params.groupDid) as RecoveryAdminRow | undefined;
            effState = effectiveStateForSession(liveState, session, recoveryRow);
          }
          if (!isAuthorizedLifecycleAdmin(actorDid, effState, params.groupDid)) {
            throw new GroupHostHttpError(403, "Forbidden", "Caller is not an authorized lifecycle admin.");
          }

          const tokenRow = this.db
            .prepare(
              "SELECT actor_did, expires_at FROM group_action_token WHERE token_hash = ? AND group_did = ? AND purpose = 'delete_account'",
            )
            .get(tokenHashHex, params.groupDid) as { actor_did: string; expires_at: number } | undefined;
          if (!tokenRow || tokenRow.actor_did !== actorDid) {
            throw new GroupHostHttpError(400, "InvalidToken", "Invalid deleteAccount confirmation token.");
          }
          if (tokenRow.expires_at <= nowMs) {
            throw new GroupHostHttpError(400, "ExpiredToken", "deleteAccount confirmation token expired.");
          }
          this.db.prepare("DELETE FROM group_action_token WHERE token_hash = ?").run(tokenHashHex);

          // Revoke sessions & freeze account while retaining signing/rotation keys for pre-tombstone remote cleanup!
          this.db
            .prepare("UPDATE group_account SET auth_epoch = auth_epoch + 1, takendown = 1, activated = 0 WHERE did = ?")
            .run(params.groupDid);
          this.db.prepare("DELETE FROM source_migration_lease WHERE group_did = ?").run(params.groupDid);
          this.db.prepare("DELETE FROM migration_session WHERE group_did = ?").run(params.groupDid);
          this.db.prepare("DELETE FROM revoked_migration_jti WHERE group_did = ?").run(params.groupDid);
          this.db.prepare("DELETE FROM oauth_par WHERE group_did = ?").run(params.groupDid);
          this.db.prepare("DELETE FROM upstream_oauth_state WHERE group_did = ?").run(params.groupDid);
          this.db.prepare("DELETE FROM oauth_code WHERE group_did = ?").run(params.groupDid);
          this.db.prepare("DELETE FROM oauth_refresh_token WHERE group_did = ?").run(params.groupDid);
          this.db.prepare("DELETE FROM oauth_session WHERE group_did = ?").run(params.groupDid);

          // Materialize strictly newer empty RepoCommit across EVERY historical `group_invite_target`!
          const inviteTargets = this.db
            .prepare("SELECT space_uri, invitee_did FROM group_invite_target WHERE group_did = ?")
            .all(params.groupDid) as Array<{ space_uri: string; invitee_did: string }>;
          const emptyRepoCommit = RepoCommit.fromRecords([]);
          const emptyStateBytes = emptyRepoCommit.setHash.state();
          const emptyDigest = emptyRepoCommit.setHash.digest();

          for (const target of inviteTargets) {
            const priorRepo = this.db
              .prepare("SELECT rev FROM space_repo WHERE space_uri = ? AND repo_did = ?")
              .get(target.space_uri, params.groupDid) as { rev: string } | undefined;
            const nextEmptyRev = nextMonotonicTid(priorRepo?.rev ?? null);
            this.db
              .prepare("DELETE FROM space_record WHERE space_uri = ? AND repo_did = ?")
              .run(target.space_uri, params.groupDid);
            this.db
              .prepare("DELETE FROM space_oplog WHERE space_uri = ? AND repo_did = ?")
              .run(target.space_uri, params.groupDid);
            this.db
              .prepare(
                `INSERT INTO space_repo (space_uri, repo_did, set_hash, rev)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(space_uri, repo_did) DO UPDATE SET set_hash = excluded.set_hash, rev = excluded.rev`,
              )
              .run(target.space_uri, params.groupDid, Buffer.from(emptyStateBytes), nextEmptyRev);

            this.upsertOutboxNoticeSync({
              kind: "invite_repo_update",
              groupDid: params.groupDid,
              coalesceKey: `invite\u0000${params.groupDid}\u0000${target.space_uri}`,
              endpoint: target.invitee_did,
              spaceUri: target.space_uri,
              writerDid: target.invitee_did,
              payload: {
                space: target.space_uri,
                repo: params.groupDid,
                repoRev: nextEmptyRev,
                data: lexToJson(emptyDigest),
              },
              maxAttempts: 5,
              nowMs,
              expiresAt: nowMs + 30_000,
            });
          }

          // Revoke all unexpired credentials in <= 100-JTI batches
          this.revokeIssuedCredentialsSync({
            groupDid: params.groupDid,
            enqueueNotices: true,
            nowMs,
          });

          // Enqueue #spaceDeleted across all non-deleted spaces
          const spaces = this.db
            .prepare("SELECT space_uri FROM group_space WHERE group_did = ? AND deleted_at IS NULL")
            .all(params.groupDid) as Array<{ space_uri: string }>;
          for (const sp of spaces) {
            this.enqueueSyncerSpaceUpdateSync({
              groupDid: params.groupDid,
              spaceUri: sp.space_uri,
              update: { $type: "com.atproto.space.defs#spaceDeleted" },
              nowMs,
            });
          }

          this.db
            .prepare(
              `INSERT INTO group_deletion_journal (group_did, actor_did, plc_outcome, status, updated_at)
               VALUES (?, ?, NULL, 'remote_cleanup_queued', ?)`,
            )
            .run(params.groupDid, actorDid, nowMs);
        });
        tx1.immediate();

        journal = {
          group_did: params.groupDid,
          actor_did: actorDid,
          plc_outcome: null,
          status: "remote_cleanup_queued",
        };
      }

      if (params.stopAfterState === "remote_cleanup_queued") return;

      // State 2: `remote_cleanup_drained` (while PLC DID is still live & resolvable!)
      if (journal.status === "remote_cleanup_queued") {
        for (let pass = 0; pass < 6; pass += 1) {
          const remaining = this.db
            .prepare(
              "SELECT COUNT(*) AS cnt FROM outbox_notice WHERE group_did = ? AND status IN ('pending', 'leased')",
            )
            .get(params.groupDid) as { cnt: number };
          if (remaining.cnt === 0) break;
          // Force immediate drain attempt for deletion notices
          this.db
            .prepare(
              "UPDATE outbox_notice SET next_attempt_at = 0, lease_until = NULL WHERE group_did = ? AND status IN ('pending', 'leased')",
            )
            .run(params.groupDid);
          await this.flushOutboxNotices({ groupDid: params.groupDid, nowMs });
        }
        // Abandon any still-failing notices after bounded attempts so deletion never wedges permanently
        this.db
          .prepare(
            "UPDATE outbox_notice SET status = 'abandoned', lease_until = NULL WHERE group_did = ? AND status IN ('pending', 'leased')",
          )
          .run(params.groupDid);
        this.db
          .prepare("UPDATE group_deletion_journal SET status = 'remote_cleanup_drained', updated_at = ? WHERE group_did = ?")
          .run(nowMs, params.groupDid);
        journal.status = "remote_cleanup_drained";
      }

      if (params.stopAfterState === "remote_cleanup_drained") return;

      // State 3: `plc_tombstoned`
      if (journal.status === "remote_cleanup_drained") {
        const rotationKey = await this.getGroupRotationKey(params.groupDid);
        const plcOutcome = await this.plc.settleDeleteAccountPlcTombstone({
          did: params.groupDid,
          expectedHostOrigin: normalizeOriginUrl(this.config.publicUrl),
          rotationKey,
        });
        this.db
          .prepare(
            "UPDATE group_deletion_journal SET plc_outcome = ?, status = 'plc_tombstoned', updated_at = ? WHERE group_did = ?",
          )
          .run(plcOutcome, nowMs, params.groupDid);
        journal.status = "plc_tombstoned";
        journal.plc_outcome = plcOutcome;
      }

      if (params.stopAfterState === "plc_tombstoned") return;

      // State 4: `purged` (zero-residue purge across all 39 GROUP_PURGED_TABLES!)
      if (journal.status === "plc_tombstoned") {
        const tx4 = this.db.transaction(() => {
          purgeGroupDataSync(this.db, params.groupDid);
          this.db
            .prepare("UPDATE group_deletion_journal SET status = 'purged', updated_at = ? WHERE group_did = ?")
            .run(nowMs, params.groupDid);
        });
        tx4.immediate();
      }
    });
  }

  private deletionSweepCursorDid = "";

  /**
   * Resumes incomplete `group_deletion_journal` rows (`status != 'purged'`) using primary-key
   * keyset pagination (`group_did ASC`) and a persistent wrap-around cursor so permanently or
   * transiently failing PLC tombstones never starve later account deletions.
   */
  async sweepIncompleteDeletionJournals(nowMs = Date.now()): Promise<void> {
    const PAGE_SIZE = 20;
    const MAX_PER_SWEEP = 200;
    const stmtUnbounded = this.db.prepare(
      `SELECT group_did FROM group_deletion_journal
       WHERE status != 'purged'
         AND group_did > ?
       ORDER BY group_did ASC
       LIMIT ?`,
    );
    const stmtBounded = this.db.prepare(
      `SELECT group_did FROM group_deletion_journal
       WHERE status != 'purged'
         AND group_did > ?
         AND group_did <= ?
       ORDER BY group_did ASC
       LIMIT ?`,
    );

    const initialCursor = this.deletionSweepCursorDid;
    let cursor = initialCursor;
    let wrapped = false;
    let processed = 0;

    while (processed < MAX_PER_SWEEP) {
      const limit = Math.min(PAGE_SIZE, MAX_PER_SWEEP - processed);
      const batch = (
        wrapped
          ? stmtBounded.all(cursor, initialCursor, limit)
          : stmtUnbounded.all(cursor, limit)
      ) as Array<{ group_did: string }>;

      for (const row of batch) {
        cursor = row.group_did;
        this.deletionSweepCursorDid = cursor;
        processed += 1;
        await this.executeOrResumeDeleteAccount({ groupDid: row.group_did, nowMs }).catch(() => undefined);
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
    this.deletionSweepCursorDid = cursor;
  }
}
