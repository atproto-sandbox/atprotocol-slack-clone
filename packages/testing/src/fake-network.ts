import { createHash, createPublicKey, timingSafeEqual, verify as cryptoVerify } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { BlockMap, blocksToCarFile, readCarWithRoot } from "@atproto/car";
import {
  formatDidKey,
  multibaseToBytes,
  P256_JWT_ALG,
  P256Keypair,
  parseDidKey,
  randomStr,
  SECP256K1_JWT_ALG,
  verifySignature,
} from "@atproto/crypto";
import { type BlobRef, cidForRawBytes, decodeCid, enumBlobRefs, fromBase64, isCid, parseCid, toBase64, type LexMap, type LexValue } from "@atproto/lex-data";
import { ScopePermissions } from "@atproto/oauth-scopes";
import {
  COMMIT_MAC_PROFILE,
  type CreateMacParams,
  MAC_COVERED_HEADER,
  type MacProfile,
  RECORD_MAC_PROFILE,
  RepoCommit,
  SPACE_CREDENTIAL_TYP,
  type SerializedRecord,
  type SpaceCommit,
  type SpaceMetaArchive,
  SpaceKemError,
  SpaceMacError,
  createCommitMacHeaders,
  createRecordMacHeaders,
  decapsulate,
  isP256DidKey,
  parseMacRequest,
  parseSpaceToken,
  readRepoStar,
  readSpaceMetaStar,
  serializeRecord,
  verifyCredentialSig,
  writeRepoStar,
  writeSpaceMetaStar,
} from "@atproto/space";
import { isAtUriString, type DidString, type NsidString, type RecordKeyString, type SpaceRefString } from "@atproto/syntax";
import { generateSpaceKey } from "@flock/protocol/atproto/space-key";
import { MEMBERSPACE_POLICY } from "@flock/protocol/atproto/space-policy";
import { AtprotoClient } from "@flock/protocol/atproto/xrpc";
import { isDid, isRecordKey, isSkey, isTid, parseSpaceUri, spaceUri as buildSpaceUri, tidTimestampUs } from "@flock/protocol/keys";
import {
  computeCanonicalMigrationManifest,
  verifyMigrationManifestDigest,
  type MigrationSpaceManifestEntry,
} from "@flock/protocol/migration-manifest";
import {
  ATGRP_METHOD,
  ATGRP_MOD_EVENT_TYPE,
  ATGRP_MOD_REASON,
  ATGRP_NAMESPACE,
  FLOCK_GROUP_METHOD,
  REPO_COLLECTION,
} from "@flock/protocol/nsids";
import { projectActiveLabels } from "@flock/protocol/moderation";
import {
  canonicalAtgrpPolicyKey,
  MANDATORY_VALIDATED_SPACE_COLLECTIONS,
  validatePublicRecord,
  validateSpacePolicy,
  validateSpaceRecord,
  validateSpaceTypeKey,
} from "@flock/protocol/registry";
import {
  effectiveHumanAdmins,
  effectiveMemberPermissions,
  expandGroupScopes,
  groupAdminScopes,
  type GroupMembershipRecord,
  type GroupAtgrpPolicy,
  type GroupRoleRecord,
} from "@flock/protocol/scopes";
import {
  ATPROTO_SPACE_COLLECTION,
  canonicalJson,
  checkPostGovernanceInvariants,
  checkRoleAndAssignmentEscalation,
  COLLECTION,
  DAY_MS,
  decodeFlockMembershipExtensions,
  defaultBootstrapRoles,
  FLOCK_EXTENSION_FIELD,
  groupMembersUri,
  groupMetaUri,
  isEffectiveAdminMember,
  isValidIdempotencyKey,
  lexDataToPlainJsonLocal,
  liveRoleGrantsAccess,
  normalizeAtgrpPolicy,
  ATGRP_COLLECTION,
  ATGRP_POLICY,
  ATGRP_SPACE_TYPE,
  parseAnySpaceRecordUri,
  personalInboxUri,
  plainJsonToLexDataLocal,
  randomUUID,
  SELF_SKEY,
  sha256Hex,
  workspaceUri,
  type FakeGroupState,
  type GovernanceSnapshot,
} from "./fake-group-host";

/**
 * An in-memory, multi-host fake of the pinned ATProto Spaces PDS protocol (`#5187`).
 * Test-only: production code never imports this.
 *
 * - Space management (`createSpace`, `updateSpace`, `getSpace`, `deleteSpace`,
 *   `removeWriter`, `putMembers`, `removeMembers`, `listMembers`, `listSpaces`)
 *   requires `ACCESS_FULL` account auth (`clientFor(did)` or full-access Bearer token).
 *   App-password sessions (`scope: "appPass" | "appPassPrivileged"`) are refused with
 *   `InvalidToken: Bad token scope` on all account-authenticated `com.atproto.space.*`
 *   and `com.atproto.memberspace.*` routes, while `com.atproto.server.getServiceAuth`
 *   and `com.atproto.repo.putRecord` remain allowed.
 * - `authorizeSpaceSync` has no OAuth session auth verifier (body `delegationToken`,
 *   `credentialKey`, optional `clientAttestation` and `notify` only), issues a 10-min
 *   `exp`-bound `atproto-space-credential+jwt`, returns `{ credential, spaceRev? }`,
 *   synchronously confirms unseen `(space, endpoint, token)` registrations via
 *   `confirmRegistration`, renews retained registrations (including lapsed ones) silently
 *   without re-confirming, and withdraws a matching registration on authorization refusals.
 * - `listWriters` requires `spaceCredentialAuth` only, returning `#repoWrite` and
 *   `#repoRemoved` entries ordered ascending by `spaceRev`, enforcing host availability.
 * - Repo reads (`getRecord`, `getLatestCommit`, `getRepo`, `listRepoOps`, `listRecords`)
 *   accept either the repo account's `ACCESS_FULL` session or a `space_credential`
 *   bound by RFC 9421 `verifyCredentialSig` and `Atproto-Space-Audience`. Credential
 *   reads on MAC-bearing methods require `Accept-Signature` and return RFC 9421 MAC
 *   headers (`Atproto-Space-Commit` / `Atproto-Space-Record`, `Signature-Input`,
 *   `Signature`) derived via HPKE `"atproto-mac"`, `Vary: Accept-Signature`, and CORS
 *   exposure/allow headers.
 */

const PERSONALSPACE_POLICY = "com.atproto.personalspace.policy";
const MANAGEDSPACE_POLICY = "com.atproto.managedspace.policy";
const STAR_MEDIA_TYPE = "application/vnd.dasl.star";
const SPACE_CREDENTIAL_LIFETIME_SEC = 600;
const DELEGATION_TOKEN_LIFETIME_SEC = 60;
const CLOCK_SKEW_SEC = 5;
const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const CORS_ALLOW_HEADERS =
  "authorization, content-type, accept-signature, atproto-space-audience, signature-input, signature";

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

export type SessionScope = "full" | "appPass" | "appPassPrivileged";

type RecordEntry = {
  value: Record<string, unknown>;
  cid: Awaited<ReturnType<typeof serializeRecord>>["cid"];
  incarnation?: string | null;
};

type FakeRepoOp = {
  rev: string;
  idx: number;
  collection: string;
  rkey: string;
  cid: string | null;
  prev: string | null;
};

type FakeAccountRepo = {
  rev: string;
  collections: Map<string, Map<string, RecordEntry>>;
  oplog: FakeRepoOp[];
};

type FakeWriterEntry =
  | { removed: false; repoRev: string; spaceRev: string; data: Uint8Array }
  | { removed: true; lastRepoRev: string; spaceRev: string };

type FakeNotifyRegistration = {
  endpoint: string;
  token: string;
  expiresAtMs: number;
  expiryNotified: boolean;
};

type FakeSpace = {
  type: string;
  skey: string;
  ownerDid: string;
  policy: {
    $type: string;
    publicRead: boolean;
    publicWrite: boolean;
    unlisted?: boolean;
    grants?: Array<{ role: string; read?: boolean; write?: boolean; permissions?: string[] }>;
    allowedApps?: string[];
    publishPolicy?: boolean;
    publishMembers?: boolean;
    managingApp?: string;
  };
  members: Map<string, { read: boolean; write: boolean }>;
  writers: Map<string, FakeWriterEntry>;
  deleted: boolean;
  notifyRegistrations: Map<string, FakeNotifyRegistration>;
  spaceRev?: string;
};

export type ApplyWriteOp =
  | { action: "create"; collection: string; rkey?: string; value: Record<string, unknown> }
  | { action: "update"; collection: string; rkey: string; value: Record<string, unknown> }
  | { action: "delete"; collection: string; rkey: string };

type FakeSessionEntry = {
  did: string;
  scope: SessionScope;
  authorizingUserDid?: string;
  approvedScopes?: readonly string[];
  sessionKind?: "group" | "recovery";
  authenticatedAtMs?: number;
  loginStepUpAtMs?: number | null;
  sessionAuthEpoch?: number;
  dpopJkt?: string;
  rawAccessToken?: string;
};

const FAKE_RECOVERY_ALLOWED_METHODS = new Set<string>([
  "com.atproto.server.checkAccountStatus",
  "com.atproto.server.activateAccount",
  "com.atproto.server.requestAccountDelete",
  "com.atproto.server.deleteAccount",
  "com.atproto.sync.getRepo",
  "com.atproto.sync.listBlobs",
  "com.atproto.sync.getBlob",
  "com.atproto.space.exportSpaceMeta",
  "group-admin/claim-action-token",
]);

type FakeMigrationBearerEntry = {
  did: string;
  sessionId: string;
  tokenKind: "access" | "refresh";
  jti: string;
  authEpoch: number;
  expSec: number;
};

type FakeAuth =
  | ({ kind: "self" } & FakeSessionEntry)
  | ({ kind: "migration" } & FakeMigrationBearerEntry)
  | { kind: "credential-candidate"; token: string; headers: Headers }
  | { kind: "raw-token"; scheme: string; token?: string }
  | { kind: "none" }
  | { kind: "rejected"; error: FakeXrpcError };

const PROTECTED_SERVICE_AUTH_METHODS = new Set<string>([
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

type PendingRepoUpdateRetry = {
  spaceUri: string;
  repo: string;
  repoRev: string;
  data: Uint8Array;
};

const MAC_METHODS: Readonly<Record<string, MacProfile>> = {
  "com.atproto.space.getRecord": RECORD_MAC_PROFILE,
  "com.atproto.space.getLatestCommit": COMMIT_MAC_PROFILE,
  "com.atproto.space.listRepoOps": COMMIT_MAC_PROFILE,
  "com.atproto.space.getRepo": COMMIT_MAC_PROFILE,
};

export class FakeXrpcError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message = code,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "FakeXrpcError";
  }
}

function blobRefCidString(blobRef: BlobRef): string {
  return "ref" in blobRef ? blobRef.ref.toString() : blobRef.cid;
}

function macHeaders(profile: MacProfile, headers: Record<string, string>): Record<string, string> {
  return {
    ...headers,
    vary: "Accept-Signature",
    "access-control-expose-headers": `${MAC_COVERED_HEADER[profile]}, signature-input, signature`,
  };
}

class WithHeaders {
  constructor(readonly body: unknown, readonly headers: Record<string, string>) {}
}

class BinaryResponse {
  constructor(
    readonly body: ReadableStream<Uint8Array> | Uint8Array,
    readonly headers: Record<string, string>,
    readonly contentType = STAR_MEDIA_TYPE,
  ) {}
}

export class FakeNetwork {
  private virtualNow = Math.floor(Date.now() / 1000) * 1000;

  private readonly accounts = new Map<string, string>();
  /** Accounts whose repo the host refuses to serve (deactivated, taken down, or missing on PDS). */
  private readonly unavailable = new Map<string, "RepoDeactivated" | "RepoTakendown" | "RepoNotFound">();
  private readonly signingKeys = new Map<string, Promise<P256Keypair>>();
  private publishedSigningKeys = new Map<string, string>();
  private readonly kemKeys = new Map<string, Promise<P256Keypair>>();
  /** What a DID-document cache holds for each account: stale after `rotateKemKey` until a forced refresh. */
  private publishedKemKeys = new Map<string, string>();
  private readonly spaces = new Map<string, FakeSpace>();
  /** Per-`(repoDid, spaceUri)` repo storage, matching each account's own PDS actor store. */
  private readonly accountRepos = new Map<string, Map<string, FakeAccountRepo>>();
  /** Public repo records (`com.atproto.repo.*`), keyed by repo DID then `collection/rkey`. */
  private readonly publicRecords = new Map<string, Map<string, { value: unknown; cid: string }>>();
  private readonly delegations = new Map<string, { space: string; granteeDid: string; exp: number; used: boolean }>();
  private readonly credentials = new Map<string, { space: string; grantedDid: string; keyId: string; iat: number; exp: number; jti: string }>();
  private readonly revokedCredentials = new Set<string>();
  private readonly appPasswords = new Map<string, Map<string, { did: string; privileged: boolean }>>();
  private readonly sessions = new Map<string, FakeSessionEntry>();
  private readonly groups = new Map<string, FakeGroupState>();
  private readonly groupsByHandle = new Map<string, string>();
  private hostServiceKeys = new Map<string, Promise<P256Keypair>>();
  private peerNetwork: FakeNetwork | undefined;
  private readonly migrationTokens = new Map<string, FakeMigrationBearerEntry>();
  private readonly revokedMigrationJtis = new Set<string>();
  private readonly fakeGroupLocks = new Map<string, Promise<void>>();
  private readonly usedServiceJtis = new Set<string>();
  private readonly abortedMigrationOps = new Map<string, number>();
  private readonly abortedMigrationLeaseAttempts = new Map<string, number>();
  private readonly fakeAbortStorageEntries = new Map<string, number>();
  private readonly usedCredRevJtis = new Map<string, number>();
  private readonly credRevocationWindows = new Map<string, Array<{ atMs: number; count: number }>>();
  private readonly storedRevokedByAudSpace = new Map<string, Map<string, number>>();
  private readonly validDpopNonces = new Set<string>();
  private dpopNonceCounter = 0;
  private readonly clientApps = new Map<string, string>();
  private readonly usedDelegationJtis = new Map<string, { groupDid: string; expiresAtMs: number }>();
  private readonly usedAttestations = new Map<string, { groupDid: string; expiresAtMs: number }>();
  private readonly endpoints = new Map<string, (request: Request) => Promise<Response> | Response>();
  private readonly services = new Map<string, string>();
  private readonly pendingRepoUpdateRetries = new Map<string, PendingRepoUpdateRetry>();
  private readonly pendingDeliveries = new Set<Promise<void>>();
  private tokenCounter = 0;
  private revCounter = 0;
  /** Spaces whose writes reach `listWriters` only on `flushListing`, so a reported revision lags the host. */
  private readonly lagging = new Set<string>();
  private readonly pendingListing = new Map<string, Array<{ did: string; repoRev: string }>>();
  /** Writer DIDs whose host is down: every read of their repo by another account fails. */
  private readonly unreachable = new Set<string>();
  private readonly withheldNotices = new Set<string>();
  /** Per-`(space, repo)` serialization queue so concurrent async mutations never interleave or clobber staged snapshots. */
  private readonly repoLocks = new Map<string, Promise<unknown>>();

  /** Requests served, by XRPC method. */
  readonly calls = new Map<string, number>();
  /** Recorded warnings from active `notifySpaceUpdate` deliveries that failed (e.g. HTTP 400). */
  readonly notifyWarnings: Array<{ space: string; endpoint: string; updateType: string; status?: number; error: string }> = [];
  /** Optional fallback/outbound transport for `confirmRegistration`, `notifySpaceUpdate`, and `checkAccess`. */
  outboundFetch: ((request: Request) => Promise<Response>) | undefined;
  /** Runs before each `listRecords` page is served, so a test can write between two pages of one listing. */
  beforeListRecords: ((params: { space: string; repo: string; collection?: string; excludeValues?: boolean; cursor?: string }) => Promise<void> | void) | undefined;
  /** Runs before each `listRepoOps` page is served, so a test can inject concurrent mutations or resets. */
  beforeListRepoOps: ((params: { space: string; repo: string; since?: string; cursor?: string; limit: number; excludeValues: boolean }) => Promise<void> | void) | undefined;
  /** Runs before `getLatestCommit` is served, so a test can race a write between `listRecords` and `getLatestCommit`. */
  beforeGetLatestCommit: ((params: { space: string; repo: string }) => Promise<void> | void) | undefined;
  /** Runs before `getRepo` is served, so a test can inject concurrent mutations or resets before STAR export. */
  beforeGetRepo: ((params: { space: string; repo: string }) => Promise<void> | void) | undefined;
  /** Optional response fault-injection hook for tests (tampered MACs, reordered/broken ops, forged CIDs, oversized streams). */
  interceptResponse: ((ctx: { method: string; params: Record<string, unknown>; response: Response }) => Promise<Response> | Response) | undefined;

  now = (): number => this.virtualNow;

  /** Registers an in-memory HTTP handler for outbound webhook / managing-app requests matching `baseUrl`. */
  registerEndpoint(baseUrl: string, handler: (request: Request) => Promise<Response> | Response): void {
    this.endpoints.set(normalizeBaseUrl(baseUrl), handler);
  }

  unregisterEndpoint(baseUrl: string): void {
    this.endpoints.delete(normalizeBaseUrl(baseUrl));
  }

  /** Registers a `did#serviceId` service endpoint (e.g. a managing app), optionally mounting its handler. */
  registerService(serviceRef: string, endpoint: string, handler?: (request: Request) => Promise<Response> | Response): void {
    this.services.set(serviceRef, normalizeBaseUrl(endpoint));
    if (handler) this.registerEndpoint(endpoint, handler);
  }

  /** Registers an OAuth client's public signing `did:key` for `clientAttestation` verification. */
  registerClientApp(clientId: string, didKey: string): void {
    this.clientApps.set(clientId, didKey);
  }

  /** Waits for any async `notifySpaceUpdate` deliveries kicked off by synchronous test helpers. */
  async flushNotifications(): Promise<void> {
    while (this.pendingDeliveries.size > 0) {
      await Promise.allSettled([...this.pendingDeliveries]);
    }
  }

  /** Retries queued PDS-to-authority `notifyRepoUpdate` notifications (e.g. after a managing app recovers). */
  async retryNotifications(): Promise<void> {
    const entries = [...this.pendingRepoUpdateRetries.entries()];
    for (const [key, retry] of entries) {
      const space = this.spaces.get(retry.spaceUri);
      if (!space || space.deleted) {
        this.pendingRepoUpdateRetries.delete(key);
        continue;
      }
      const delivery = await this.deliverRepoUpdateToSpace(space, retry.repo, retry.repoRev, retry.data);
      if (delivery !== "retryable") this.pendingRepoUpdateRetries.delete(key);
    }
    await this.flushNotifications();
  }

  /** Holds a space's writes back from `listWriters` until `flushListing`, as an authority that has not processed them yet. */
  setListingLag(space: string, lagging: boolean): void {
    if (lagging) this.lagging.add(space);
    else {
      this.lagging.delete(space);
      this.flushListing(space);
    }
  }

  flushListing(space: string): void {
    const target = this.spaces.get(space);
    const pending = this.pendingListing.get(space) ?? [];
    this.pendingListing.delete(space);
    for (const { did, repoRev } of pending) {
      if (!target || target.deleted) continue;
      const repoState = this.accountRepos.get(did)?.get(space);
      if (!repoState) continue;
      const data = this.commitForState(space, did, repoState).data;
      if (target.policy.$type === MANAGEDSPACE_POLICY) {
        this.trackDelivery(this.deliverRepoUpdateToSpace(target, did, repoRev, data).then(() => undefined));
      } else if (this.currentlyAuthorizedSyncWriter(target, did)) {
        const update = this.recordWriterEntry(target, did, repoRev, data);
        if (update) this.trackDelivery(this.deliverSpaceUpdate(target, update));
      }
    }
  }

  /** Takes a writer's host down (or back up): every other account's read of its repo fails with 503. */
  setHostReachable(did: string, reachable: boolean): void {
    if (reachable) this.unreachable.delete(did);
    else this.unreachable.add(did);
  }

  /** Stops (or resumes) the authority's `notifySpaceUpdate` deliveries for a space: a lost notice. */
  withholdNotices(space: string, withheld: boolean): void {
    if (withheld) this.withheldNotices.add(space);
    else this.withheldNotices.delete(space);
  }

  /** Writes a record into `did`'s repo in a space without a client: another app's write, or seeding. */
  async writeAs(did: string, space: string, collection: string, rkey: string, record: Record<string, unknown>): Promise<void> {
    const deliveries: Promise<void>[] = [];
    await this.putRecord({ space, repo: did, collection, rkey, record: { $type: collection, ...record } }, { kind: "self", did, scope: "full" }, deliveries);
    await Promise.allSettled(deliveries);
  }

  async deleteAs(did: string, space: string, collection: string, rkey: string): Promise<void> {
    const deliveries: Promise<void>[] = [];
    await this.deleteRecord({ space, repo: did, collection, rkey }, { kind: "self", did, scope: "full" }, deliveries);
    await Promise.allSettled(deliveries);
  }

  /** Applies an atomic multi-op batch into `did`'s repo sharing a single `rev`. */
  async applyWritesAs(did: string, space: string, writes: readonly ApplyWriteOp[]) {
    const deliveries: Promise<void>[] = [];
    const result = await this.applyWrites({
      space,
      repo: did,
      writes: writes.map((write) => {
        if (write.action === "delete") {
          return { $type: "com.atproto.space.applyWrites#delete", collection: write.collection, rkey: write.rkey };
        }
        if (write.action === "update") {
          return {
            $type: "com.atproto.space.applyWrites#update",
            collection: write.collection,
            rkey: write.rkey,
            value: { $type: write.collection, ...write.value },
          };
        }
        return {
          $type: "com.atproto.space.applyWrites#create",
          collection: write.collection,
          ...(write.rkey !== undefined ? { rkey: write.rkey } : {}),
          value: { $type: write.collection, ...write.value },
        };
      }),
    }, { kind: "self", did, scope: "full" }, deliveries);
    await Promise.allSettled(deliveries);
    return result;
  }

  /** Clears all records and oplog history for `did` in `space`, preserving `space_repo` with a new signed commit. */
  clearRecordsAs(did: string, space: string): void {
    const deliveries: Promise<void>[] = [];
    const result = this.clearRecords({ space, repo: did }, { kind: "self", did, scope: "full" }, deliveries);
    if (result instanceof Promise) {
      this.trackDelivery(result.then(() => Promise.allSettled(deliveries)).then(() => undefined));
    } else {
      for (const delivery of deliveries) this.trackDelivery(delivery);
    }
  }

  /** Imports a STAR archive or record set for `did` in `space`, replacing records and resetting oplog history. */
  async importRepoAs(
    did: string,
    space: string,
    input: Uint8Array | ReadonlyArray<{ collection: string; rkey: string; value: Record<string, unknown> }>,
  ): Promise<void> {
    let starBytes: Uint8Array;
    if (input instanceof Uint8Array) {
      starBytes = input;
    } else {
      const encoder = new TextEncoder();
      const sorted = [...input].sort((a, b) =>
        compareBytes(encoder.encode(`${a.collection}/${a.rkey}`), encoder.encode(`${b.collection}/${b.rkey}`)));
      const serialized: Array<SerializedRecord & { cid: Awaited<ReturnType<typeof serializeRecord>>["cid"] }> = [];
      for (const item of sorted) {
        const lex = plainJsonToLexDataLocal({ $type: item.collection, ...item.value }) as Parameters<typeof serializeRecord>[2];
        serialized.push(await serializeRecord(item.collection as never, item.rkey as never, lex));
      }
      const commit = RepoCommit.fromRecords(serialized).toCommit({
        space: space as never,
        repo: did as never,
        rev: this.nextRev(),
      });
      const chunks: Uint8Array[] = [];
      for await (const chunk of writeRepoStar(commit, serialized)) chunks.push(chunk);
      starBytes = concatBytes(chunks);
    }
    await this.importRepo({}, { kind: "self", did, scope: "full" }, undefined, starBytes);
  }

  /** Seeds members on a personal-PDS space (e.g. for testing incompatible pre-existing `invites/self` members). */
  seedPersonalSpaceMembers(
    authorityDid: string,
    spaceUriStr: string,
    members: ReadonlyArray<{ did: string; read: boolean; write: boolean }>,
  ): void {
    const deliveries: Promise<void>[] = [];
    this.putMembers({ space: spaceUriStr, members: [...members] }, { kind: "self", did: authorityDid, scope: "full" }, deliveries);
    for (const delivery of deliveries) this.trackDelivery(delivery);
  }

  /** Simulates PDS oplog pruning/compaction for `(space, repo)`: drops all ops, or ops strictly before `keepFromRev`. */
  pruneOplog(space: string, repo: string, keepFromRev?: string): void {
    const accountRepo = this.accountRepos.get(repo)?.get(space);
    if (!accountRepo) return;
    if (keepFromRev === undefined) {
      accountRepo.oplog = [];
      return;
    }
    accountRepo.oplog = accountRepo.oplog.filter((op) => op.rev >= keepFromRev);
  }

  /** Advances the fake network's clock, used by tests exercising credential expiry and registration lapse. */
  advanceClock(ms: number): void {
    this.virtualNow += ms;
  }

  createAccount(did: string, host = "pds1"): void {
    this.accounts.set(did, host);
  }

  /** Deactivates, takes down, or marks missing an account on its PDS. */
  setAccountState(did: string, state: "active" | "deactivated" | "takendown" | "missing"): void {
    if (state === "active") this.unavailable.delete(did);
    else if (state === "missing") this.unavailable.set(did, "RepoNotFound");
    else this.unavailable.set(did, state === "deactivated" ? "RepoDeactivated" : "RepoTakendown");
  }

  hasAccount(did: string): boolean {
    return this.accounts.has(did);
  }

  /** Shares `did:web` host service keypairs and PLC source metadata across peer `FakeNetwork` instances in multi-host migration tests. */
  shareHostServiceKeysWith(other: FakeNetwork): void {
    this.hostServiceKeys = other.hostServiceKeys;
    this.publishedSigningKeys = other.publishedSigningKeys;
    this.publishedKemKeys = other.publishedKemKeys;
    this.peerNetwork = other;
    other.peerNetwork = this;
  }

  private recordFakeAbortedOperation(
    groupDid: string,
    opId: string,
    minExpiresAtMs: number,
    hostSlug = "group-host",
  ): void {
    const key = `${hostSlug}\u0000${groupDid}\u0000${opId}`;
    const existing = this.abortedMigrationOps.get(key) ?? 0;
    const nextExp = Math.max(existing, minExpiresAtMs);
    this.abortedMigrationOps.set(key, nextExp);
    this.recordFakeAbortStorageEntry(groupDid, `aborted-op:${opId}`, nextExp, hostSlug);
  }

  private recordFakeAbortedLeaseAttempt(
    groupDid: string,
    attemptId: string,
    minExpiresAtMs: number,
    hostSlug = "group-host",
  ): void {
    const key = `${hostSlug}\u0000${groupDid}\u0000${attemptId}`;
    const existing = this.abortedMigrationLeaseAttempts.get(key) ?? 0;
    const nextExp = Math.max(existing, minExpiresAtMs);
    this.abortedMigrationLeaseAttempts.set(key, nextExp);
    this.recordFakeAbortStorageEntry(groupDid, `lease-attempt:${attemptId}`, nextExp, hostSlug);
  }

  private recordFakeAbortStorageEntry(
    issuerDid: string,
    jtiKey: string,
    minExpiresAtMs: number,
    hostSlug = "group-host",
  ): void {
    const key = `${hostSlug}\u0000${issuerDid}\u0000${jtiKey}`;
    const existing = this.fakeAbortStorageEntries.get(key) ?? 0;
    this.fakeAbortStorageEntries.set(key, Math.max(existing, minExpiresAtMs));
  }

  /** Test-only inspector returning the exact count of active abort-storage entries for `(hostSlug, issuerDid)`. */
  getAbortStorageCountForTest(issuerDid: string, hostSlug = "group-host"): number {
    const nowMs = this.now();
    const prefix = `${hostSlug}\u0000${issuerDid}\u0000`;
    let count = 0;
    for (const [k, exp] of this.fakeAbortStorageEntries) {
      if (exp > nowMs && k.startsWith(prefix)) count += 1;
    }
    return count;
  }

  private enforceFakeAbortStorageQuota(
    issuerDid: string,
    candidateKeys: string[],
    nowMs: number,
    hostSlug = "group-host",
  ): void {
    const MAX_ABORT_ENTRIES_PER_ISSUER = 256;
    const MAX_ABORT_ENTRIES_TOTAL = 10_000;
    for (const [k, exp] of this.fakeAbortStorageEntries) {
      if (exp <= nowMs) this.fakeAbortStorageEntries.delete(k);
    }
    const uniqueKeys = [...new Set(candidateKeys)];
    let netNew = 0;
    for (const k of uniqueKeys) {
      const existing = this.fakeAbortStorageEntries.get(`${hostSlug}\u0000${issuerDid}\u0000${k}`);
      if (existing === undefined || existing <= nowMs) netNew += 1;
    }
    if (netNew === 0) return;
    let issuerActive = 0;
    let totalActive = 0;
    const hostPrefix = `${hostSlug}\u0000`;
    const issuerPrefix = `${hostSlug}\u0000${issuerDid}\u0000`;
    for (const [k, exp] of this.fakeAbortStorageEntries) {
      if (exp > nowMs && k.startsWith(hostPrefix)) {
        totalActive += 1;
        if (k.startsWith(issuerPrefix)) issuerActive += 1;
      }
    }
    if (issuerActive + netNew > MAX_ABORT_ENTRIES_PER_ISSUER || totalActive + netNew > MAX_ABORT_ENTRIES_TOTAL) {
      throw new FakeXrpcError(429, "RateLimitExceeded", "Too many active migration abort entries for issuer or host");
    }
  }

  private assertFakeOperationIdNotAborted(
    groupDid: string,
    opId: string | null | undefined,
    nowMs: number,
    hostSlug = "group-host",
  ): void {
    if (!opId) return;
    const expiresAt = this.abortedMigrationOps.get(`${hostSlug}\u0000${groupDid}\u0000${opId}`);
    if (expiresAt !== undefined && expiresAt > nowMs) {
      throw new FakeXrpcError(
        409,
        "OperationIdAlreadyAborted",
        `Migration operationId '${opId}' was already aborted; start a new operationId.`,
      );
    }
  }

  /** Resolves live PLC `rotationKeys` for `did` across local or peer `FakeNetwork` directories. */
  resolveRotationKeys = async (did: string, requestingHostSlug?: string): Promise<string[]> => {
    const localHost = this.accounts.get(did);
    if (localHost && (requestingHostSlug === undefined || localHost !== requestingHostSlug)) {
      const grp = this.groups.get(did);
      if (grp) {
        return [...grp.sovereignRotationKeys, grp.localRotationKey.did()];
      }
    }
    if (this.peerNetwork?.accounts.has(did)) {
      const peerGrp = this.peerNetwork.groups.get(did);
      if (peerGrp) {
        return [...peerGrp.sovereignRotationKeys, peerGrp.localRotationKey.did()];
      }
    }
    if (localHost && requestingHostSlug !== undefined && localHost === requestingHostSlug) {
      const localGrp = this.groups.get(did);
      if (localGrp && !localGrp.migrationSession) {
        return [...localGrp.sovereignRotationKeys, localGrp.localRotationKey.did()];
      }
    }
    const sigKey = await this.resolveSigningKey(did);
    return [sigKey];
  };

  /** Revokes a credential by `jti` for `space` (matches `notifyCredentialsRevoked`). */
  revokeCredential(space: string, jti: string): void {
    this.revokedCredentials.add(`${space}\u0000${jti}`);
  }

  resolvePds = async (did: string): Promise<string> => {
    const host = this.accounts.get(did);
    if (!host) throw new Error(`fake-pds: no account registered for ${did}`);
    return `https://fake-pds.test/${host}`;
  };

  /** Resolves an account's live PLC `#atproto` signing key, never trusting un-cutover staged or retired local keys. */
  resolveSigningKey = async (did: string, forceRefresh = false): Promise<string> => {
    const published = this.publishedSigningKeys.get(did);
    if (published && !forceRefresh) return published;

    const localGrp = this.groups.get(did);
    if (localGrp?.migrationSession && localGrp.migrationSession.plcCutoverAt === null) {
      if (this.peerNetwork && this.peerNetwork !== this) {
        return this.peerNetwork.resolveSigningKey(did, forceRefresh);
      }
      if (published) return published;
      throw new Error(`fake-pds: staged un-cutover group ${did} has no published PLC signing key on this host`);
    }

    if (!this.accounts.has(did)) {
      if (this.peerNetwork && this.peerNetwork !== this) {
        return this.peerNetwork.resolveSigningKey(did, forceRefresh);
      }
      throw new Error(`fake-pds: no account registered for ${did}`);
    }

    if (
      this.unavailable.get(did) === "RepoDeactivated" &&
      this.peerNetwork &&
      this.peerNetwork !== this &&
      this.peerNetwork.accounts.has(did)
    ) {
      const peerGrp = this.peerNetwork.groups.get(did);
      if (peerGrp && (!peerGrp.migrationSession || peerGrp.migrationSession.plcCutoverAt !== null)) {
        return this.peerNetwork.resolveSigningKey(did, forceRefresh);
      }
    }

    const current = (await this.signingKeypair(did)).did();
    this.publishedSigningKeys.set(did, current);
    return current;
  };

  /**
   * Stands in for a DID-document lookup of `#atproto_kem`. A cached key stays until `forceRefresh`, so a test can
   * observe a syncer holding a rotated-away key.
   */
  resolveKemKey = async (did: string, forceRefresh = false): Promise<string> => {
    if (!this.accounts.has(did)) throw new Error(`fake-pds: no account registered for ${did}`);
    const published = this.publishedKemKeys.get(did);
    if (published && !forceRefresh) return published;
    const current = (await this.kemKeypair(did)).did();
    this.publishedKemKeys.set(did, current);
    return current;
  };

  /** Replaces the account's `#atproto_kem` key. Resolvers that cached the old one fail verification until they refresh. */
  async rotateKemKey(did: string): Promise<void> {
    await this.resolveKemKey(did);
    this.kemKeys.set(did, P256Keypair.create());
  }

  private signingKeypair(did: string): Promise<P256Keypair> {
    let key = this.signingKeys.get(did);
    if (!key) {
      key = P256Keypair.create();
      this.signingKeys.set(did, key);
    }
    return key;
  }

  private kemKeypair(did: string): Promise<P256Keypair> {
    let key = this.kemKeys.get(did);
    if (!key) {
      key = P256Keypair.create();
      this.kemKeys.set(did, key);
    }
    return key;
  }

  /** Stands in for an authenticated account session client (`full` OAuth by default, or `appPass` / `appPassPrivileged`). */
  clientFor(did: string, options: { scope?: SessionScope; appPassword?: boolean } = {}): AtprotoClient {
    if (!this.accounts.has(did)) throw new Error(`fake-pds: no account registered for ${did}`);
    const scope: SessionScope = options.scope ?? (options.appPassword ? "appPass" : "full");
    return new AtprotoClient((path, init) => this.respond(path, init, { kind: "self", did, scope }));
  }

  /** Issues a Bearer session token usable over `fetchEndpoint` with the given scope. */
  issueSessionToken(did: string, scope: SessionScope = "full"): string {
    if (!this.accounts.has(did)) throw new Error(`fake-pds: no account registered for ${did}`);
    const token = `fake-session-${this.tokenCounter++}`;
    this.sessions.set(token, { did, scope });
    return token;
  }

  /**
   * Provisions an `opensocial.group` Group-DID account on `FakeNetwork` with core `meta/self` and
   * `members/self` spaces, bootstrap `admin`/`moderator`/`member` roles, `profile/self`, optional
   * public `declaration/self`, and optional initial `creatorDid` admin membership.
   */
  async createGroupAccount(
    groupDid: string,
    opts: {
      host?: string;
      creatorDid?: string;
      name?: string;
      description?: string;
      joinPolicy?: "open" | "approval" | "invite";
      publicMeta?: boolean;
      handle?: string;
      sovereignRotationKeys?: readonly string[];
    } = {},
  ): Promise<void> {
    const host = opts.host ?? "group-host";
    this.createAccount(groupDid, host);
    await this.resolveSigningKey(groupDid);
    await this.resolveKemKey(groupDid);

    const handle = (opts.handle ?? `${groupDid.replace(/[^a-z0-9-]/gi, "-").slice(0, 32)}.groups.test`).toLowerCase();
    const localRotationKey = await P256Keypair.create();
    const groupState: FakeGroupState = {
      did: groupDid,
      handle,
      authEpoch: 1,
      localRotationKey,
      sovereignRotationKeys: new Set(opts.sovereignRotationKeys ?? []),
      knownAppSubjects: new Set(),
      recoveryAdmin: null,
      sourceMigrationLease: null,
      migrationSession: null,
      spaceIndexRkeys: new Map(),
      priorEjectCounts: new Map(),
      joinRequests: new Map(),
      joinOperations: new Map(),
      inviteDeliveries: new Map(),
      modSubjects: new Map(),
      modEjectionEligibility: new Map(),
      modEvents: [],
      nextModSeq: 1,
      actionTokens: new Map(),
      blobs: new Map(),
    };
    this.groups.set(groupDid, groupState);
    this.groupsByHandle.set(handle, groupDid);

    const selfAuth: FakeAuth = { kind: "self", did: groupDid, scope: "full" };
    const deliveries: Promise<void>[] = [];
    const nowIso = new Date(this.now()).toISOString();

    await this.createSpace(
      {
        spaceType: ATGRP_SPACE_TYPE.meta,
        skey: SELF_SKEY,
        policy: {
          $type: ATGRP_POLICY,
          publicRead: opts.publicMeta === true,
          unlisted: false,
          grants: [
            { role: "admin", read: true },
            { role: "moderator", read: true },
            { role: "member", read: true },
          ],
        },
      },
      selfAuth,
      deliveries,
      true,
    );

    await this.createSpace(
      {
        spaceType: ATGRP_SPACE_TYPE.members,
        skey: SELF_SKEY,
        policy: {
          $type: ATGRP_POLICY,
          publicRead: false,
          unlisted: false,
          grants: [
            { role: "admin", read: true, write: true },
            { role: "moderator", read: true, write: true },
            { role: "member", read: true, write: true },
          ],
        },
      },
      selfAuth,
      deliveries,
      true,
    );

    const membersSpace = groupMembersUri(groupDid);
    const metaSpace = groupMetaUri(groupDid);
    const roles = defaultBootstrapRoles(groupDid);
    for (const [rkey, roleVal] of Object.entries(roles)) {
      await this.putGroupSpaceRecordInternal(groupDid, groupDid, membersSpace, ATGRP_COLLECTION.role, rkey, roleVal, deliveries, true);
    }

    await this.putGroupSpaceRecordInternal(
      groupDid,
      groupDid,
      membersSpace,
      ATGRP_COLLECTION.labeler,
      SELF_SKEY,
      {
        $type: ATGRP_COLLECTION.labeler,
        policies: { labelValues: ["!hide", "!takedown"] },
      },
      deliveries,
      true,
    );

    await this.putGroupSpaceRecordInternal(
      groupDid,
      groupDid,
      metaSpace,
      ATGRP_COLLECTION.about,
      SELF_SKEY,
      {
        $type: ATGRP_COLLECTION.about,
        displayName: opts.name ?? "Group",
        ...(opts.description !== undefined ? { description: opts.description } : {}),
      },
      deliveries,
      true,
    );

    await this.putGroupSpaceRecordInternal(
      groupDid,
      groupDid,
      metaSpace,
      ATGRP_COLLECTION.config,
      SELF_SKEY,
      {
        $type: ATGRP_COLLECTION.config,
        joinPolicy: opts.joinPolicy ?? "invite",
      },
      deliveries,
      true,
    );

    if (opts.publicMeta === true) {
      await this.putPublicRecord(
        {
          repo: groupDid,
          collection: REPO_COLLECTION.groupDeclaration,
          rkey: SELF_SKEY,
          record: {
            $type: REPO_COLLECTION.groupDeclaration,
          },
        },
        selfAuth,
      );
    }

    if (opts.creatorDid) {
      await this.putGroupSpaceRecordInternal(
        groupDid,
        groupDid,
        membersSpace,
        ATGRP_COLLECTION.membership,
        opts.creatorDid,
        {
          $type: ATGRP_COLLECTION.membership,
          roles: ["admin", "member"],
          createdAt: nowIso,
        },
        deliveries,
        true,
      );
    }

    await Promise.allSettled(deliveries);
  }

  /**
   * Returns a group-DID `AtprotoClient` backed by an authorizing user (`authorizingUserDid`),
   * dynamically narrowed on every request against live `effectiveMemberPermissions`.
   */
  clientForGroupMember(
    groupDid: string,
    authorizingUserDid: string,
    opts: {
      approvedScopes?: readonly string[];
      sessionKind?: "group" | "recovery";
      authenticatedAtMs?: number;
      loginStepUpAtMs?: number | null;
    } = {},
  ): AtprotoClient {
    const grp = this.groups.get(groupDid);
    if (!grp) throw new Error(`fake-pds: no group registered for ${groupDid}`);
    const authAt = opts.authenticatedAtMs ?? this.now();
    const auth: FakeAuth = {
      kind: "self",
      did: groupDid,
      scope: "full",
      authorizingUserDid,
      approvedScopes: opts.approvedScopes ?? groupAdminScopes(groupDid),
      sessionKind: opts.sessionKind ?? "group",
      authenticatedAtMs: authAt,
      loginStepUpAtMs: opts.loginStepUpAtMs === undefined ? authAt : opts.loginStepUpAtMs,
      sessionAuthEpoch: grp.authEpoch,
    };
    return new AtprotoClient((path, init) => this.respond(path, init, auth));
  }

  /** Issues a Bearer group-DID session token dynamically narrowed by `authorizingUserDid`. */
  issueGroupSessionToken(
    groupDid: string,
    authorizingUserDid: string,
    opts: {
      approvedScopes?: readonly string[];
      sessionKind?: "group" | "recovery";
      authenticatedAtMs?: number;
      loginStepUpAtMs?: number | null;
    } = {},
  ): string {
    const grp = this.groups.get(groupDid);
    if (!grp) throw new Error(`fake-pds: no group registered for ${groupDid}`);
    const authAt = opts.authenticatedAtMs ?? this.now();
    const token = `fake-group-session-${this.tokenCounter++}`;
    this.sessions.set(token, {
      did: groupDid,
      scope: "full",
      authorizingUserDid,
      approvedScopes: opts.approvedScopes ?? groupAdminScopes(groupDid),
      sessionKind: opts.sessionKind ?? "group",
      authenticatedAtMs: authAt,
      loginStepUpAtMs: opts.loginStepUpAtMs === undefined ? authAt : opts.loginStepUpAtMs,
      sessionAuthEpoch: grp.authEpoch,
    });
    return token;
  }

  /** Returns the local PLC rotation keypair for `groupDid` (for negative parity tests). */
  getGroupLocalRotationKeyForTest(groupDid: string): P256Keypair {
    const grp = this.groups.get(groupDid);
    if (!grp) throw new Error(`fake-pds: no group registered for ${groupDid}`);
    return grp.localRotationKey;
  }

  /** Issues an unconfirmed single-use action token (`delete_account` or `plc_operation`) for tests. */
  issueGroupActionTokenForTest(
    groupDid: string,
    actorDid: string,
    purpose: "delete_account" | "plc_operation",
    ttlMs = 15 * 60_000,
  ): string {
    const grp = this.groups.get(groupDid);
    if (!grp) throw new Error(`fake-pds: no group registered for ${groupDid}`);
    const raw = `act-${randomUUID()}`;
    grp.actionTokens.set(purpose, {
      token: raw,
      tokenHash: sha256Hex(raw),
      actorDid,
      purpose,
      expiresAt: this.now() + ttlMs,
    });
    return raw;
  }

  /** Stands in for `deps.fetchEndpoint`: routes a cross-host `Request` by its URL. */
  fetchEndpoint = async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") {
      const requestedHeaders = request.headers.get("access-control-request-headers");
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": requestedHeaders ? `${requestedHeaders}, accept-signature` : CORS_ALLOW_HEADERS,
          "access-control-max-age": "86400",
        },
      });
    }
    const url = new URL(request.url);
    const path = `${url.pathname}${url.search}`;
    const contentType = request.headers.get("content-type") ?? "";
    const isBinaryBody =
      contentType.includes(STAR_MEDIA_TYPE) ||
      contentType.includes("application/octet-stream") ||
      contentType.includes("application/vnd.ipld.car") ||
      url.pathname.endsWith("/com.atproto.repo.uploadBlob") ||
      url.pathname.endsWith("/com.atproto.repo.importRepo") ||
      url.pathname.endsWith("/com.atproto.space.importRepo") ||
      url.pathname.endsWith("/com.atproto.space.importSpaceMeta");
    const preAuth = this.authFromRequest(request.headers);
    const isMigrationStreamWrite =
      url.pathname.endsWith("/com.atproto.repo.uploadBlob") ||
      url.pathname.endsWith("/com.atproto.repo.importRepo") ||
      url.pathname.endsWith("/com.atproto.space.importRepo") ||
      url.pathname.endsWith("/com.atproto.space.importSpaceMeta");
    if (isMigrationStreamWrite && preAuth.kind === "migration") {
      try {
        this.verifyActiveMigrationAccessAuth(preAuth);
      } catch (err) {
        if (err instanceof FakeXrpcError) {
          return new Response(JSON.stringify({ error: err.code, message: err.message }), {
            status: err.status,
            headers: {
              "content-type": "application/json",
              "access-control-allow-origin": "*",
              ...(err.headers ?? {}),
            },
          });
        }
        throw err;
      }
    }
    const body = request.method === "GET" || request.method === "HEAD"
      ? undefined
      : isBinaryBody && !contentType.includes("application/json")
        ? new Uint8Array(await request.arrayBuffer())
        : await request.text();
    return this.respond(path, { method: request.method, body }, preAuth, request.headers, url);
  };

  generateKey = generateSpaceKey;

  /**
   * Parses an HTTP `Authorization` header as the pinned PDS does (`auth-verifier.ts`):
   * `Atproto-Space-Credential` (case-insensitive) carries a space credential verified with
   * `verifyCredentialSig` on endpoints that accept space credentials; `Bearer` carries a
   * session token; `Atproto-Space` and malformed headers are rejected with `InvalidToken`.
   */
  private authFromRequest(headers: Headers): FakeAuth {
    const authorization = headers.get("authorization");
    if (!authorization) return { kind: "none" };
    const parts = authorization.split(" ");
    if (parts.length !== 2) return rejected(400, "InvalidToken", "Malformed authorization header");
    const [rawScheme, token] = parts;
    const scheme = rawScheme!.toLowerCase();
    if (scheme === "atproto-space-credential") {
      if (!token) return { kind: "none" };
      return { kind: "credential-candidate", token, headers };
    }
    if (scheme === "bearer") {
      const session = token ? this.sessions.get(token) : undefined;
      if (session) {
        if (session.dpopJkt) {
          return rejected(401, "invalid_token", "DPoP-bound access token cannot be presented as Bearer", {
            "www-authenticate": 'DPoP algs="ES256", error="invalid_token"',
          });
        }
        return { kind: "self", ...session, rawAccessToken: token };
      }
      const mig = token ? this.migrationTokens.get(token) : undefined;
      if (mig) return { kind: "migration", ...mig };
      return { kind: "raw-token", scheme, token };
    }
    if (scheme === "dpop") {
      const session = token ? this.sessions.get(token) : undefined;
      if (session) return { kind: "self", ...session, rawAccessToken: token };
      return { kind: "raw-token", scheme, token };
    }
    if (scheme === "basic") {
      return { kind: "raw-token", scheme, token };
    }
    return rejected(400, "InvalidToken", `Unsupported authorization type: ${rawScheme}`);
  }

  private async respond(
    path: string,
    init: { method?: string; body?: unknown },
    auth: FakeAuth,
    requestHeaders?: Headers,
    requestUrl?: URL,
  ): Promise<Response> {
    const url = requestUrl ?? new URL(path, "https://fake-pds.test");
    const xrpcMatch = /^\/(?:([^/]+)\/)?xrpc\/(.+)$/.exec(url.pathname);
    const nonXrpcMatch = /^\/(?:([^/]+)\/)?((?:group-member|group-admin|\.well-known)\/.+)$/.exec(url.pathname);
    const hostSlug = (xrpcMatch?.[1] ?? nonXrpcMatch?.[1]) || "group-host";
    const method = xrpcMatch
      ? xrpcMatch[2]!
      : nonXrpcMatch
        ? nonXrpcMatch[2]!
        : url.pathname.replace(/^\/+/, "");
    const params: Record<string, unknown> = {};
    for (const [key, value] of url.searchParams.entries()) {
      if (key in params) {
        const existing = params[key];
        params[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
      } else {
        params[key] = value;
      }
    }
    const bodyParams: Record<string, unknown> = {};
    if (typeof init.body === "string" && init.body.length > 0) {
      const parsedBody = JSON.parse(init.body) as Record<string, unknown>;
      Object.assign(params, parsedBody);
      Object.assign(bodyParams, parsedBody);
    }
    const rawBody = init.body instanceof Uint8Array ? init.body : undefined;
    this.calls.set(method, (this.calls.get(method) ?? 0) + 1);

    const callDeliveries: Promise<void>[] = [];
    let response: Response;
    if (
      typeof params.repo === "string" &&
      this.unreachable.has(params.repo) &&
      !(auth.kind === "self" && auth.did === params.repo)
    ) {
      response = errorResponse(new FakeXrpcError(503, "ServiceUnavailable", "The repo host is down."));
    } else {
      try {
        let extraResponseHeaders: Record<string, string> = {};
        if (auth.kind === "self" && auth.dpopJkt) {
          if (!auth.rawAccessToken) {
            throw new FakeXrpcError(401, "invalid_token", "DPoP access token required", {
              "dpop-nonce": this.issueFakeDpopNonce(),
              "www-authenticate": 'DPoP algs="ES256", error="invalid_token"',
            });
          }
          const dpop = this.verifyFakeDpopProof({
            dpopHeader: requestHeaders?.get("dpop") ?? undefined,
            method: (init.method ?? "GET").toUpperCase(),
            expectedHtu: `${url.origin}${url.pathname}`,
            expectedAccessToken: auth.rawAccessToken,
          });
          if (dpop.jkt !== auth.dpopJkt) {
            throw new FakeXrpcError(401, "invalid_token", "DPoP proof key mismatch", {
              "dpop-nonce": dpop.freshNonce,
              "www-authenticate": 'DPoP algs="ES256", error="invalid_token"',
            });
          }
          extraResponseHeaders = { "dpop-nonce": dpop.freshNonce };
        }
        if (auth.kind === "self" && auth.sessionKind === "recovery" && !FAKE_RECOVERY_ALLOWED_METHODS.has(method)) {
          throw new FakeXrpcError(
            403,
            "Forbidden",
            "Recovery OAuth sessions are restricted strictly to recovery/export/deletion endpoints.",
            extraResponseHeaders,
          );
        }
        if (
          auth.kind === "self" &&
          this.groups.has(auth.did) &&
          this.unavailable.get(auth.did) === "RepoDeactivated" &&
          auth.sessionKind !== "recovery"
        ) {
          throw new FakeXrpcError(401, "AccountDeactivated", "Group account is currently deactivated.", extraResponseHeaders);
        }

        const handled = await this.handle(
          method,
          params,
          auth,
          requestHeaders,
          rawBody,
          callDeliveries,
          hostSlug,
          url,
          (init.method ?? "GET").toUpperCase(),
          bodyParams,
        );
        if (handled instanceof BinaryResponse) {
          const responseBody: BodyInit = handled.body instanceof Uint8Array ? new Uint8Array(handled.body) : handled.body;
          response = new Response(responseBody, {
            status: 200,
            headers: {
              "content-type": handled.contentType,
              "access-control-allow-origin": "*",
              "access-control-allow-headers": CORS_ALLOW_HEADERS,
              ...extraResponseHeaders,
              ...handled.headers,
            },
          });
        } else {
          const [body, headers] = handled instanceof WithHeaders ? [handled.body, handled.headers] : [handled, {}];
          response = new Response(JSON.stringify(body), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "access-control-allow-origin": "*",
              "access-control-allow-headers": CORS_ALLOW_HEADERS,
              ...extraResponseHeaders,
              ...headers,
            },
          });
        }
      } catch (error) {
        if (error instanceof FakeXrpcError) response = errorResponse(error);
        else throw error;
      }
    }
    if (callDeliveries.length > 0) {
      await Promise.allSettled(callDeliveries);
    }
    return this.interceptResponse ? this.interceptResponse({ method, params, response }) : response;
  }

  private async handle(
    method: string,
    params: Record<string, unknown>,
    auth: FakeAuth,
    requestHeaders: Headers | undefined,
    rawBody: Uint8Array | undefined,
    deliveries: Promise<void>[],
    hostSlug = "group-host",
    requestUrl?: URL,
    httpMethod = "GET",
    bodyParams: Record<string, unknown> = params,
  ): Promise<unknown> {
    switch (method) {
      case ".well-known/did.json": return this.describeFakeHostDidDoc(hostSlug);
      case "com.atproto.server.describeServer": return this.describeFakeServer(hostSlug);
      case "com.atproto.identity.resolveHandle": return this.resolveFakeHandle(params);
      case "com.atproto.identity.getRecommendedDidCredentials": return this.getFakeRecommendedDidCredentials(auth, hostSlug);
      case "com.atproto.identity.requestPlcOperationSignature": return this.requestFakePlcOperationSignature(auth);
      case "com.atproto.identity.signPlcOperation": return this.signFakePlcOperation(params, auth, deliveries, hostSlug, requestHeaders);
      case "com.atproto.identity.submitPlcOperation": return this.submitFakePlcOperation(params, auth, hostSlug);
      case "com.atproto.repo.describeRepo": return this.describePublicRepo(params);
      case "com.atproto.repo.createRecord": return this.createPublicRecord(params, auth);
      case "com.atproto.repo.putRecord": return this.putPublicRecord(params, auth);
      case "com.atproto.repo.deleteRecord": return this.deletePublicRecord(params, auth);
      case "com.atproto.repo.applyWrites": return this.applyPublicWrites(params, auth);
      case "com.atproto.repo.getRecord": return this.getPublicRecord(params);
      case "com.atproto.repo.listRecords": return this.listPublicRecords(params);
      case "com.atproto.repo.uploadBlob": return this.uploadFakeBlob(auth, requestHeaders, rawBody);
      case "com.atproto.repo.importRepo": return this.importPublicRepoCar(auth, requestHeaders, rawBody);
      case "com.atproto.repo.listMissingBlobs": return this.listMissingFakeBlobs(params, auth);
      case "com.atproto.sync.getRepoStatus": return this.getFakeSyncRepoStatus(params);
      case "com.atproto.sync.getLatestCommit": return this.getFakeSyncLatestCommit(params, auth);
      case "com.atproto.sync.getRepo": return this.getFakeSyncRepoCar(params, auth);
      case "com.atproto.sync.getBlob": return this.getPublicBlob(params, auth);
      case "com.atproto.sync.listBlobs": return this.listPublicBlobs(params, auth);
      case "com.atproto.server.getServiceAuth": return this.getServiceAuth(params, auth, hostSlug);
      case "com.atproto.server.createAccount": return this.createFakeMigrationAccount(params, auth, requestHeaders, hostSlug);
      case "com.atproto.server.refreshSession": return this.refreshFakeMigrationSession(auth, requestHeaders);
      case "com.atproto.server.createAppPassword": return this.createAppPassword(params, auth);
      case "com.atproto.server.createSession": return this.createSession(params);
      case "com.atproto.server.checkAccountStatus": return this.checkFakeAccountStatus(auth);
      case "com.atproto.server.deactivateAccount": return this.deactivateFakeAccount(auth, deliveries);
      case "com.atproto.server.activateAccount": return this.activateFakeAccount(auth, deliveries);
      case "com.atproto.server.requestAccountDelete": return this.requestFakeAccountDelete(auth);
      case "com.atproto.server.deleteAccount": return this.deleteFakeAccount(params, auth, deliveries, hostSlug);
      case "com.atproto.space.getDelegationToken": return this.getDelegationToken(params, auth);
      case "com.atproto.space.authorizeSpaceSync": return this.authorizeSpaceSync(params);
      case "com.atproto.space.createSpace": return this.createSpace(params, auth, deliveries);
      case "com.atproto.space.updateSpace": return this.updateSpace(params, auth, deliveries);
      case "com.atproto.space.getSpace": return this.getSpace(params, auth);
      case "com.atproto.space.deleteSpace": return this.deleteSpace(params, auth, deliveries);
      case "com.atproto.space.removeWriter": return this.removeWriter(params, auth, deliveries);
      case "com.atproto.space.listWriters": return this.listWriters(params, auth);
      case "com.atproto.space.listSpaces": return this.listSpaces(params, auth);
      case "com.atproto.memberspace.putMembers": return this.putMembers(params, auth, deliveries);
      case "com.atproto.memberspace.removeMembers": return this.removeMembers(params, auth, deliveries);
      case "com.atproto.memberspace.listMembers": return this.listMembers(params, auth);
      case "com.atproto.space.putRecord": return this.putRecord(params, auth, deliveries, requestHeaders);
      case "com.atproto.space.createRecord": return this.createRecord(params, auth, deliveries, requestHeaders);
      case "com.atproto.space.applyWrites": return this.applyWrites(params, auth, deliveries, requestHeaders);
      case "com.atproto.space.clearRecords": return this.clearRecords(params, auth, deliveries);
      case "com.atproto.space.importRepo": return this.importRepo(params, auth, requestHeaders, rawBody);
      case "com.atproto.space.deleteRecord": return this.deleteRecord(params, auth, deliveries);
      case "com.atproto.space.getRecord": return this.getRecord(params, auth, requestHeaders);
      case "com.atproto.space.getLatestCommit": return this.getLatestCommit(params, auth, requestHeaders);
      case "com.atproto.space.getRepo": return this.getRepo(params, auth, requestHeaders);
      case "com.atproto.space.getBlob": return this.getBlob(params, auth);
      case "com.atproto.space.listBlobs": return this.listBlobs(params, auth);
      case "com.atproto.space.exportSpaceMeta": return this.exportSpaceMeta(params, auth);
      case "com.atproto.space.importSpaceMeta": return this.importSpaceMeta(auth, requestHeaders, rawBody);
      case "com.atproto.space.listRecords": return this.listRecords(params, auth);
      case "com.atproto.space.listRepoOps": return this.listRepoOps(params, auth, requestHeaders);
      case "com.atproto.space.notifyRepoUpdate": return this.handleInboundNotifyRepoUpdate(params, auth, deliveries);
      case "com.atproto.space.notifyCredentialsRevoked": return this.handleInboundNotifyCredentialsRevoked(params, auth, requestUrl);
      case ATGRP_METHOD.requestJoin: return this.handleFakeRequestJoin(params, auth, requestHeaders, deliveries);
      case ATGRP_METHOD.cancelJoinRequest: return this.handleFakeCancelJoinRequest(params, auth);
      case ATGRP_METHOD.denyJoinRequest: return this.handleFakeDenyJoinRequest(params, auth);
      case ATGRP_METHOD.listJoinRequests: return this.handleFakeListJoinRequests(params, auth);
      case ATGRP_METHOD.leaveGroup: return this.handleFakeLeaveGroup(params, auth, requestHeaders, deliveries);
      case ATGRP_METHOD.modSubmitReport: return this.handleFakeSubmitReport(params, auth);
      case ATGRP_METHOD.modSubmitAppeal: return this.handleFakeSubmitAppeal(params, auth);
      case ATGRP_METHOD.modQuerySubjects: return this.handleFakeQueryModSubjects(params, auth);
      case ATGRP_METHOD.modQuerySubjectHistory: return this.handleFakeQueryModSubjectHistory(params, auth);
      case ATGRP_METHOD.modQuerySelfHistory: return this.handleFakeQuerySelfModHistory(params, auth);
      case ATGRP_METHOD.modUpdateSubject: return this.handleFakeUpdateModSubject(params, auth);
      case "group-member/join-status": return this.handleFakeJoinStatus(params, auth);
      case "group-admin/migration-info": return this.getFakeMigrationInfo(hostSlug);
      case "group-admin/public-group-keys": return this.getFakePublicGroupKeys(params);
      case "group-admin/migration-manifest": return this.getFakeMigrationManifest(params, auth, requestHeaders, hostSlug);
      case "group-admin/migration-attestation": return this.getFakeMigrationAttestation(params, auth, hostSlug);
      case "group-admin/prepare-migration": return this.prepareFakeMigration(params, auth, hostSlug);
      case "group-admin/abort-migration": return this.abortFakeMigration(bodyParams, auth, hostSlug);
      case "group-admin/finalize-migrated-source": return this.finalizeFakeMigratedSource(params, auth, hostSlug);
      case "group-admin/invite-deliveries": return this.handleFakeListInviteDeliveries(auth);
      case "group-admin/retry-invite-delivery": return this.handleFakeRetryInviteDelivery(params, auth, deliveries);
      case "group-admin/claim-action-token": return this.handleFakeClaimActionToken(params, auth);
      case "group-admin/controller-session": return this.handleFakeControllerSession(params, auth, requestHeaders, hostSlug, requestUrl, httpMethod);
      default: throw new FakeXrpcError(501, "MethodNotImplemented", `fake-pds does not implement ${method}`);
    }
  }

  private requireSelf(
    auth: FakeAuth,
    opts: {
      scopes?: "full" | "standard";
      checkTakedown?: boolean;
      checkDeactivated?: boolean;
      allowMigration?: boolean;
    } = {},
  ): string {
    if (auth.kind === "rejected") throw auth.error;
    if (auth.kind === "credential-candidate") {
      throw new FakeXrpcError(400, "InvalidToken", "Unexpected authorization type");
    }
    if (auth.kind === "none") throw new FakeXrpcError(401, "AuthMissing", "Authentication Required");
    if (auth.kind === "raw-token") throw new FakeXrpcError(401, "InvalidToken", "Token could not be verified");
    if (auth.kind === "migration") {
      if (!opts.allowMigration) {
        throw new FakeXrpcError(401, "InvalidToken", "Migration staging token is not permitted on this route");
      }
      return this.verifyActiveMigrationAccessAuth(auth).did;
    }
    if (auth.rawAccessToken !== undefined && !this.sessions.has(auth.rawAccessToken)) {
      throw new FakeXrpcError(401, "InvalidToken", "Session expired or revoked");
    }
    if (auth.sessionAuthEpoch !== undefined) {
      const grp = this.groups.get(auth.did);
      if (grp && grp.authEpoch !== auth.sessionAuthEpoch) {
        throw new FakeXrpcError(401, "InvalidToken", "Session invalidated by auth_epoch advance");
      }
    }
    if ((opts.scopes ?? "full") === "full" && auth.scope !== "full") {
      throw new FakeXrpcError(400, "InvalidToken", "Bad token scope");
    }
    if (opts.checkTakedown || opts.checkDeactivated) {
      const state = this.unavailable.get(auth.did);
      if (state === "RepoNotFound") throw new FakeXrpcError(403, "AccountNotFound", "Account not found");
      if (opts.checkTakedown && state === "RepoTakendown") {
        throw new FakeXrpcError(401, "AccountTakedown", "Account has been taken down");
      }
      if (opts.checkDeactivated && state === "RepoDeactivated") {
        throw new FakeXrpcError(401, "AccountDeactivated", "Account is deactivated");
      }
    }
    return auth.did;
  }

  private assertActiveSpaceHost(authorityDid: string): void {
    if (!this.accounts.has(authorityDid) || this.unavailable.get(authorityDid) === "RepoNotFound") {
      throw new FakeXrpcError(400, "SpaceNotFound", "Space not found");
    }
    const state = this.unavailable.get(authorityDid);
    if (state === "RepoTakendown") {
      throw new FakeXrpcError(400, "RepoTakendown", `Repo has been takendown: ${authorityDid}`);
    }
    if (state === "RepoDeactivated") {
      throw new FakeXrpcError(400, "RepoDeactivated", `Repo has been deactivated: ${authorityDid}`);
    }
  }

  private requireSpaceRef(uri: unknown) {
    if (typeof uri !== "string") throw new FakeXrpcError(400, "InvalidSpaceUri", "Invalid space URI");
    const parsed = parseSpaceUri(uri);
    if (!parsed) throw new FakeXrpcError(400, "InvalidSpaceUri", `Not a space uri: ${uri}`);
    return parsed;
  }

  private requireSpaceAuthority(uri: unknown, did: string): void {
    const ref = this.requireSpaceRef(uri);
    if (ref.authorityDid !== did) throw new FakeXrpcError(400, "NotAuthorized", "Not the space authority");
  }

  private requireActiveSpace(uri: unknown): FakeSpace {
    if (typeof uri !== "string") throw new FakeXrpcError(400, "SpaceNotFound", "Space not found");
    const space = this.spaces.get(uri);
    if (!space || space.deleted) throw new FakeXrpcError(400, "SpaceNotFound", "Space not found");
    return space;
  }

  private requireMemberspace(space: FakeSpace): void {
    if (space.policy.$type !== MEMBERSPACE_POLICY) {
      throw new FakeXrpcError(400, "PolicyMismatch", "Space is not governed by the memberspace policy");
    }
  }

  private async requireCredential(
    params: Record<string, unknown>,
    auth: FakeAuth,
    expectedAudience?: string,
  ): Promise<{ grantedDid: string; space: string }> {
    if (auth.kind === "rejected") throw auth.error;
    if (auth.kind !== "credential-candidate") {
      throw new FakeXrpcError(401, "MissingJwt", "missing space credential");
    }
    const credential = this.credentials.get(auth.token);
    if (!credential) {
      throw new FakeXrpcError(401, "BadJwt", "invalid space credential");
    }
    const nowSec = Math.floor(this.now() / 1000);
    if (nowSec >= credential.exp) {
      throw new FakeXrpcError(401, "JwtExpired", "token expired");
    }
    const audience = auth.headers.get("atproto-space-audience");
    if (!isDid(audience)) {
      throw new FakeXrpcError(401, "BadSpaceSignature", "missing or invalid space audience DID");
    }
    try {
      await verifyCredentialSig(Object.fromEntries(auth.headers.entries()), credential.keyId as `did:key:${string}`);
    } catch (error) {
      throw new FakeXrpcError(401, "BadSpaceSignature", error instanceof Error ? error.message : "invalid HTTP message signature");
    }
    if (this.revokedCredentials.has(`${credential.space}\u0000${credential.jti}`)) {
      throw new FakeXrpcError(401, "CredentialRevoked", "space credential has been revoked");
    }
    if (credential.space !== params.space) {
      throw new FakeXrpcError(400, "InvalidCredential", "Credential is not scoped to this space");
    }
    const expected = expectedAudience ?? this.requireSpaceRef(params.space).authorityDid;
    if (audience !== expected) {
      throw new FakeXrpcError(401, "BadSpaceAudience", "space audience does not match the request");
    }
    return { grantedDid: credential.grantedDid, space: credential.space };
  }

  private async authorizeSpaceRead(params: Record<string, unknown>, auth: FakeAuth): Promise<{ own: boolean }> {
    const repo = String(params.repo);
    this.requireSpaceRef(params.space);
    if (auth.kind === "credential-candidate") {
      await this.requireCredential(params, auth, repo);
      return { own: false };
    }
    const callerDid = this.requireSelf(auth, { scopes: "full" });
    if (callerDid !== repo) {
      throw new FakeXrpcError(400, "RepoNotFound", `Could not find repo for DID: ${repo}`);
    }
    return { own: true };
  }

  private createAppPassword(params: Record<string, unknown>, auth: FakeAuth): { name: string; password: string; privileged: boolean } {
    const did = this.requireSelf(auth, { scopes: "full" });
    const name = String(params.name ?? "app");
    const privileged = params.privileged === true;
    const password = `app-pass-${randomStr(12, "hex")}`;
    let map = this.appPasswords.get(did);
    if (!map) this.appPasswords.set(did, map = new Map());
    map.set(password, { did, privileged });
    return { name, password, privileged };
  }

  private createSession(params: Record<string, unknown>): { accessJwt: string; did: string; handle: string } {
    const identifier = String(params.identifier ?? "");
    const password = String(params.password ?? "");
    const entry = this.appPasswords.get(identifier)?.get(password);
    if (!entry) throw new FakeXrpcError(401, "AuthenticationRequired", "Invalid identifier or password");
    const scope: SessionScope = entry.privileged ? "appPassPrivileged" : "appPass";
    return { accessJwt: this.issueSessionToken(entry.did, scope), did: entry.did, handle: entry.did };
  }

  private getDelegationToken(params: Record<string, unknown>, auth: FakeAuth): { token: string } {
    const granteeDid = this.requireSelf(auth, { scopes: "full", checkTakedown: true, checkDeactivated: true });
    const space = String(params.space);
    this.requireSpaceRef(space);
    const token = `delegation-${this.tokenCounter++}`;
    const exp = Math.floor(this.now() / 1000) + DELEGATION_TOKEN_LIFETIME_SEC;
    this.delegations.set(token, { space, granteeDid, exp, used: false });
    return { token };
  }

  /**
   * Authorizes syncing a space, exchanging an optional single-use `delegationToken` and
   * optional `clientAttestation` for a 10-min `exp`-bound `SpaceCredential` JWT, and
   * optionally registering/renewing `notify: { endpoint, token }`.
   */
  private async authorizeSpaceSync(params: Record<string, unknown>): Promise<{ credential: string; spaceRev?: string }> {
    const ref = this.requireSpaceRef(params.space);
    const spaceUriStr = String(params.space);
    const credentialKey = params.credentialKey;
    if (typeof credentialKey !== "string" || !isP256DidKey(credentialKey)) {
      throw new FakeXrpcError(400, "InvalidRequest", "credentialKey must be a P-256 did:key");
    }

    const notify = parseNotifyParam(params.notify);
    this.assertActiveSpaceHost(ref.authorityDid);

    const initialGroup = this.groups.get(ref.authorityDid);
    if (initialGroup?.sourceMigrationLease?.status === "plc_signed") {
      throw new FakeXrpcError(409, "MigrationCutoverPending", "Group cutover pending");
    }
    const initialAuthEpoch = initialGroup?.authEpoch;

    const existingSpace = this.spaces.get(spaceUriStr);
    if (existingSpace?.deleted) {
      throw new FakeXrpcError(400, "SpaceDeleted", "Space has been deleted");
    }

    let userDid: string | undefined;
    let verifiedOpaqueDelegation: { used: boolean } | undefined;
    let verifiedDelegationJti: { replayKey: string; expiresAtMs: number } | undefined;
    if (params.delegationToken !== undefined) {
      if (typeof params.delegationToken !== "string") {
        throw new FakeXrpcError(400, "InvalidDelegationToken", "Invalid delegation token");
      }
      if (params.delegationToken !== "") {
        const delegation = this.delegations.get(params.delegationToken);
        const nowMs = this.now();
        const nowSec = Math.floor(nowMs / 1000);
        if (delegation) {
          if (delegation.used || delegation.space !== spaceUriStr || nowSec - CLOCK_SKEW_SEC >= delegation.exp) {
            throw new FakeXrpcError(400, "InvalidDelegationToken", "Delegation token is invalid, expired, replayed, or does not match requested space");
          }
          verifiedOpaqueDelegation = delegation;
          userDid = delegation.granteeDid;
        } else if (params.delegationToken.includes(".")) {
          let parsedDel: ReturnType<typeof parseSpaceToken<"delegation">>;
          try {
            parsedDel = parseSpaceToken("delegation", params.delegationToken);
          } catch {
            throw new FakeXrpcError(400, "InvalidDelegationToken", "Invalid delegation token");
          }
          if (
            parsedDel.payload.sub !== spaceUriStr ||
            parsedDel.payload.aud !== `${ref.authorityDid}#atproto_pds` ||
            parsedDel.payload.iat > nowSec + CLOCK_SKEW_SEC ||
            nowSec - CLOCK_SKEW_SEC >= parsedDel.payload.exp ||
            parsedDel.payload.exp <= parsedDel.payload.iat
          ) {
            throw new FakeXrpcError(400, "InvalidDelegationToken", "Delegation token audience, subject, or expiry mismatch");
          }
          const replayKey = `${parsedDel.payload.iss}\u0000${parsedDel.payload.jti}`;
          const existingDel = this.usedDelegationJtis.get(replayKey);
          if (existingDel && existingDel.expiresAtMs > nowMs) {
            throw new FakeXrpcError(400, "InvalidDelegationToken", "Delegation token already used");
          }
          const sigKey = await this.resolveSigningKey(parsedDel.payload.iss).catch(() => undefined);
          if (!sigKey) {
            throw new FakeXrpcError(400, "InvalidDelegationToken", "Unknown delegation issuer");
          }
          const valid = await verifySignature(sigKey, parsedDel.signingInput, parsedDel.sig, {
            jwtAlg: parsedDel.header.alg,
          }).catch(() => false);
          if (!valid) {
            throw new FakeXrpcError(400, "InvalidDelegationToken", "Invalid delegation signature");
          }
          verifiedDelegationJti = {
            replayKey,
            expiresAtMs: (parsedDel.payload.exp + CLOCK_SKEW_SEC) * 1000,
          };
          userDid = parsedDel.payload.iss;
        } else {
          throw new FakeXrpcError(400, "InvalidDelegationToken", "Delegation token is invalid, expired, replayed, or does not match requested space");
        }
      }
    }

    let clientId: string | undefined;
    let verifiedAttestation: { clientId: string; replayKey: string; expiresAtMs: number } | undefined;
    if (params.clientAttestation !== undefined) {
      if (typeof params.clientAttestation !== "string") {
        throw new FakeXrpcError(400, "InvalidClientAttestation", "Invalid client attestation");
      }
      if (params.clientAttestation !== "") {
        verifiedAttestation = await this.verifyClientAttestation(params.clientAttestation, ref.authorityDid);
        clientId = verifiedAttestation.clientId;
      }
    }

    const space = this.requireActiveSpace(spaceUriStr);
    try {
      await this.authorizeCredential(space, userDid, clientId);
    } catch (error) {
      if (notify && error instanceof FakeXrpcError && error.status === 400) {
        space.notifyRegistrations.delete(notifyKey(notify.endpoint, notify.token));
      }
      throw error;
    }

    if (notify) {
      const regKey = notifyKey(notify.endpoint, notify.token);
      const existingReg = space.notifyRegistrations.get(regKey);
      if (!existingReg) {
        await this.confirmRegistration(spaceUriStr, notify);
        if (space.deleted) {
          throw new FakeXrpcError(400, "SpaceDeleted", "Space has been deleted");
        }
      }
    }

    const signingKey = await this.signingKeypair(ref.authorityDid);
    const iat = Math.floor(this.now() / 1000);
    const exp = iat + SPACE_CREDENTIAL_LIFETIME_SEC;
    const jti = randomStr(16, "hex");
    const header = { alg: signingKey.jwtAlg, typ: SPACE_CREDENTIAL_TYP, kid: "#atproto" };
    const payload = {
      iss: ref.authorityDid,
      sub: spaceUriStr,
      cnf: { kid: credentialKey },
      iat,
      exp,
      jti,
    };
    const signingInput = `${jsonToB64Url(header)}.${jsonToB64Url(payload)}`;
    const sig = await signingKey.sign(utf8Encoder.encode(signingInput));
    const token = `${signingInput}.${toBase64(sig, "base64url")}`;

    // Final synchronous re-verification of activated, takendown, auth_epoch, space lifecycle, and read policy
    // before committing or returning the signed credential!
    this.assertActiveSpaceHost(ref.authorityDid);
    const finalGroup = this.groups.get(ref.authorityDid);
    if (initialAuthEpoch !== undefined && (!finalGroup || finalGroup.authEpoch !== initialAuthEpoch)) {
      throw new FakeXrpcError(400, "SpaceNotFound", "Authorization epoch changed concurrently");
    }
    if (finalGroup?.sourceMigrationLease?.status === "plc_signed") {
      throw new FakeXrpcError(409, "MigrationCutoverPending", "Group cutover pending");
    }
    const finalSpace = this.spaces.get(spaceUriStr);
    if (!finalSpace) {
      throw new FakeXrpcError(400, "SpaceNotFound", "Space not found");
    }
    if (finalSpace.deleted) {
      throw new FakeXrpcError(400, "SpaceDeleted", "Space has been deleted");
    }
    try {
      await this.authorizeCredential(finalSpace, userDid, clientId);
    } catch (error) {
      if (notify && error instanceof FakeXrpcError && error.status === 400) {
        finalSpace.notifyRegistrations.delete(notifyKey(notify.endpoint, notify.token));
      }
      throw error;
    }

    const commitNowMs = this.now();
    if (verifiedOpaqueDelegation) {
      if (verifiedOpaqueDelegation.used) {
        throw new FakeXrpcError(400, "InvalidDelegationToken", "Delegation token already used");
      }
      verifiedOpaqueDelegation.used = true;
    }
    if (verifiedDelegationJti) {
      const existingDel = this.usedDelegationJtis.get(verifiedDelegationJti.replayKey);
      if (existingDel && existingDel.expiresAtMs > commitNowMs) {
        throw new FakeXrpcError(400, "InvalidDelegationToken", "Delegation token already used");
      }
      this.usedDelegationJtis.set(verifiedDelegationJti.replayKey, {
        groupDid: ref.authorityDid,
        expiresAtMs: verifiedDelegationJti.expiresAtMs,
      });
    }
    if (verifiedAttestation) {
      const existingAtt = this.usedAttestations.get(verifiedAttestation.replayKey);
      if (existingAtt && existingAtt.expiresAtMs > commitNowMs) {
        throw new FakeXrpcError(
          400,
          "InvalidClientAttestation",
          `Invalid client attestation for "${verifiedAttestation.clientId}"`,
        );
      }
      this.usedAttestations.set(verifiedAttestation.replayKey, {
        groupDid: ref.authorityDid,
        expiresAtMs: verifiedAttestation.expiresAtMs,
      });
    }

    this.credentials.set(token, {
      space: spaceUriStr,
      grantedDid: userDid ?? "",
      keyId: credentialKey,
      iat,
      exp,
      jti,
    });

    if (notify) {
      finalSpace.notifyRegistrations.set(notifyKey(notify.endpoint, notify.token), {
        endpoint: notify.endpoint,
        token: notify.token,
        expiresAtMs: exp * 1000,
        expiryNotified: false,
      });
    }

    const spaceRev = this.currentSpaceRev(finalSpace);
    return {
      credential: token,
      ...(spaceRev !== undefined ? { spaceRev } : {}),
    };
  }

  getSpaceCredential(params: Record<string, unknown>): Promise<{ credential: string; spaceRev?: string }> {
    return this.authorizeSpaceSync(params);
  }

  private async verifyClientAttestation(
    attestation: unknown,
    authorityDid: string,
  ): Promise<{ clientId: string; replayKey: string; expiresAtMs: number }> {
    if (typeof attestation !== "string" || attestation.length === 0) {
      throw new FakeXrpcError(400, "InvalidClientAttestation", "Invalid client attestation");
    }
    let parsed: ReturnType<typeof parseSpaceToken<"clientAttestation">>;
    try {
      parsed = parseSpaceToken("clientAttestation", attestation);
    } catch (error) {
      throw new FakeXrpcError(400, "InvalidClientAttestation", error instanceof Error ? error.message : "Invalid client attestation");
    }
    const { header, payload, signingInput, sig } = parsed;
    const nowMs = this.now();
    const nowSec = Math.floor(nowMs / 1000);
    if (
      payload.sub !== payload.iss ||
      typeof payload.iat !== "number" ||
      !Number.isFinite(payload.iat) ||
      payload.iat > nowSec + CLOCK_SKEW_SEC ||
      typeof payload.exp !== "number" ||
      !Number.isFinite(payload.exp) ||
      nowSec - CLOCK_SKEW_SEC >= payload.exp ||
      payload.exp <= payload.iat
    ) {
      throw new FakeXrpcError(400, "InvalidClientAttestation", `Invalid client attestation for "${payload.iss}"`);
    }
    if (payload.aud !== `${authorityDid}#atproto_pds`) {
      throw new FakeXrpcError(400, "InvalidClientAttestation", `Invalid client attestation for "${payload.iss}"`);
    }
    const replayKey = `${payload.iss}\u0000${payload.jti}`;
    const existingAtt = this.usedAttestations.get(replayKey);
    if (existingAtt && existingAtt.expiresAtMs > nowMs) {
      throw new FakeXrpcError(400, "InvalidClientAttestation", `Invalid client attestation for "${payload.iss}"`);
    }
    const clientKey = this.clientApps.get(payload.iss);
    if (clientKey) {
      const valid = await verifySignature(clientKey, signingInput, sig, { jwtAlg: header.alg }).catch(() => false);
      if (!valid) {
        throw new FakeXrpcError(400, "InvalidClientAttestation", `Invalid client attestation for "${payload.iss}"`);
      }
    } else {
      try {
        new URL(payload.iss);
      } catch {
        throw new FakeXrpcError(400, "InvalidClientAttestation", `Invalid client attestation clientId URL "${payload.iss}"`);
      }
      if (header.alg !== "ES256" && header.alg !== "ES256K") {
        throw new FakeXrpcError(400, "InvalidClientAttestation", `Unsupported client attestation alg "${String(header.alg)}"`);
      }
      let jwks: { keys?: Array<Record<string, unknown>> } | undefined;
      try {
        const metaRes = await this.sendOutbound(payload.iss, {
          method: "GET",
          headers: { accept: "application/json" },
        });
        if (!metaRes.ok) {
          throw new Error(`HTTP ${metaRes.status}`);
        }
        const meta = (await metaRes.json()) as { jwks?: { keys?: Array<Record<string, unknown>> }; jwks_uri?: string };
        jwks = meta?.jwks;
        if (!jwks && meta?.jwks_uri) {
          const jwksRes = await this.sendOutbound(meta.jwks_uri, {
            method: "GET",
            headers: { accept: "application/jwk-set+json, application/json" },
          });
          if (jwksRes.ok) {
            jwks = (await jwksRes.json()) as { keys?: Array<Record<string, unknown>> };
          }
        }
      } catch {
        throw new FakeXrpcError(400, "InvalidClientAttestation", `Invalid client attestation for "${payload.iss}"`);
      }
      if (!jwks || !Array.isArray(jwks.keys) || jwks.keys.length === 0) {
        throw new FakeXrpcError(400, "InvalidClientAttestation", `Invalid client attestation for "${payload.iss}"`);
      }
      const candidateJwks = header.kid
        ? jwks.keys.filter((k) => k && typeof k === "object" && k.kid === header.kid)
        : jwks.keys;
      let validJwkSig = false;
      for (const jwk of candidateJwks) {
        if (!jwk || typeof jwk !== "object" || typeof jwk.d === "string") continue;
        try {
          const pubKey = createPublicKey({ key: jwk as never, format: "jwk" });
          if (cryptoVerify("sha256", signingInput, { key: pubKey, dsaEncoding: "ieee-p1363" }, sig)) {
            validJwkSig = true;
            break;
          }
        } catch {
          // Try next candidate JWK.
        }
      }
      if (!validJwkSig) {
        throw new FakeXrpcError(400, "InvalidClientAttestation", `Invalid client attestation for "${payload.iss}"`);
      }
    }
    return {
      clientId: payload.iss,
      replayKey,
      expiresAtMs: (payload.exp + CLOCK_SKEW_SEC) * 1000,
    };
  }

  private async confirmRegistration(space: string, notify: { endpoint: string; token: string }): Promise<void> {
    const challenge = randomStr(16, "base32");
    try {
      const response = await this.sendOutbound(
        `${normalizeBaseUrl(notify.endpoint)}/xrpc/com.atproto.space.confirmRegistration`,
        {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ space, token: notify.token, challenge }),
        },
      );
      if (response.ok) {
        const body = await response.json() as { challenge?: unknown };
        if (body && typeof body === "object" && body.challenge === challenge) return;
      }
    } catch {
      // Treated identically to challenge mismatch below.
    }
    throw new FakeXrpcError(400, "RegistrationNotConfirmed", "Notify endpoint did not confirm the registration");
  }

  private async authorizeCredential(space: FakeSpace, repo: string | undefined, clientId: string | undefined): Promise<void> {
    const repoAuthorized = await this.authorizeRepoAccess(space, repo, "read", clientId);
    if (!repoAuthorized) {
      throw new FakeXrpcError(400, "SpaceNotFound", "Space not found");
    }
    if (space.policy.$type === MEMBERSPACE_POLICY && space.policy.allowedApps !== undefined) {
      if (clientId === undefined || !space.policy.allowedApps.includes(clientId)) {
        throw new FakeXrpcError(400, "AppNotAuthorized", "Application not authorized for this space");
      }
    }
  }

  private async authorizeRepoAccess(
    space: FakeSpace,
    repo: string | undefined,
    access: "read" | "write",
    clientId?: string,
  ): Promise<boolean> {
    if (repo === space.ownerDid) return true;
    if (space.policy.$type === PERSONALSPACE_POLICY) return false;
    if (space.policy.$type === MEMBERSPACE_POLICY) {
      if (access === "read" && space.policy.publicRead) return true;
      if (!repo) return false;
      const member = space.members.get(repo);
      if (access === "read") return member?.read === true;
      // An explicit member with write:false stays excluded even when publicWrite is true.
      if (member) return member.write;
      return space.policy.publicWrite === true;
    }
    if (space.policy.$type === MANAGEDSPACE_POLICY) {
      const result = await this.checkManagedAccess(space, repo, clientId);
      return result[access];
    }
    if (space.policy.$type === ATGRP_POLICY) {
      const state = this.loadFakeGovernanceState(space.ownerDid);
      return liveRoleGrantsAccess(state, spaceUri(space), repo, space.ownerDid, access);
    }
    return false;
  }

  private async checkManagedAccess(
    space: FakeSpace,
    repo: string | undefined,
    clientId?: string,
  ): Promise<{ read: boolean; write: boolean }> {
    const managingApp = space.policy.managingApp;
    const base = managingApp ? this.services.get(managingApp) : undefined;
    if (!managingApp || !base) {
      throw new FakeXrpcError(502, "UpstreamFailure", "Managing app did not answer");
    }
    const url = new URL(`${base}/xrpc/com.atproto.managedspace.checkAccess`);
    url.searchParams.set("space", spaceUri(space));
    if (repo !== undefined) url.searchParams.set("repo", repo);
    if (clientId !== undefined) url.searchParams.set("clientId", clientId);

    const exp = Math.floor(this.now() / 1000) + 60;
    const serviceJwt = `fake-service-token.${btoa(JSON.stringify({
      iss: space.ownerDid,
      aud: managingApp,
      lxm: "com.atproto.managedspace.checkAccess",
      exp,
    }))}`;
    try {
      const response = await this.sendOutbound(url.toString(), {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${serviceJwt}`,
        },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as { read?: unknown; write?: unknown };
      if (!body || typeof body.read !== "boolean" || typeof body.write !== "boolean") {
        throw new Error("Invalid checkAccess response");
      }
      return { read: body.read, write: body.write };
    } catch {
      throw new FakeXrpcError(502, "UpstreamFailure", "Managing app did not answer");
    }
  }

  private async createSpace(
    params: Record<string, unknown>,
    auth: FakeAuth,
    deliveries: Promise<void>[] = [],
    skipGroupBootstrapChecks = false,
  ): Promise<{ space: string }> {
    const ownerDid = this.requireSelf(auth, { scopes: "full", checkTakedown: true, checkDeactivated: true });
    const type = String(params.spaceType);
    const skey = typeof params.skey === "string" ? params.skey : fakeTid(++this.revCounter);

    const groupState = this.groups.get(ownerDid);
    if (groupState) {
      const keyCheck = validateSpaceTypeKey(type, skey, { isGroupHostOwnSpace: true });
      if (!keyCheck.valid) {
        throw new FakeXrpcError(400, keyCheck.code ?? "InvalidSpaceKey", keyCheck.reason);
      }
      const actorDid = this.requireGroupSpaceManagePerm(auth, ownerDid, type, skey, "create");
      const normalized = normalizeAtgrpPolicy(params.policy, { groupDid: ownerDid, spaceType: type, skey }, FakeXrpcError);
      const uri = buildSpaceUri(ownerDid, type, skey);
      const existing = this.spaces.get(uri);
      if (existing && !existing.deleted) throw new FakeXrpcError(400, "SpaceAlreadyExists", "Space already exists");

      if (!skipGroupBootstrapChecks) {
        this.assertNoActiveFakeMigrationLease(groupState);
        const preState = this.loadFakeGovernanceState(ownerDid);
        checkRoleAndAssignmentEscalation({
          actorDid,
          preState,
          groupDid: ownerDid,
          roleWrites: [],
          policyWrite: {
            spaceUri: uri,
            spaceType: type,
            skey,
            policy: normalized,
            isEffectiveAdmin: actorDid === ownerDid || isEffectiveAdminMember(actorDid, preState, ownerDid),
          },
          membershipDiffs: [],
          ErrorCtor: FakeXrpcError,
        });
        const postPolicies = new Map(preState.spacePolicies);
        postPolicies.set(uri, normalized);
        const postState: GovernanceSnapshot = {
          ...preState,
          spacePolicies: postPolicies,
          hasFlockWorkspace: preState.hasFlockWorkspace || uri === workspaceUri(ownerDid),
        };
        checkPostGovernanceInvariants(preState, postState, ownerDid, {}, FakeXrpcError);
      }

      this.spaces.set(uri, {
        type,
        skey,
        ownerDid,
        policy: {
          $type: ATGRP_POLICY,
          publicRead: normalized.publicRead === true,
          publicWrite: false,
          unlisted: normalized.unlisted === true,
          grants: normalized.grants.map((g) => ({
            role: g.role,
            ...(g.read !== undefined ? { read: g.read } : {}),
            ...(g.write !== undefined ? { write: g.write } : {}),
            ...(g.permissions ? { permissions: [...g.permissions] } : {}),
          })),
        },
        members: new Map(),
        writers: new Map(),
        deleted: false,
        notifyRegistrations: new Map(),
      });

      await this.putGroupSpaceRecordInternal(
        ownerDid,
        ownerDid,
        uri,
        ATPROTO_SPACE_COLLECTION.spacePolicy,
        SELF_SKEY,
        { $type: ATPROTO_SPACE_COLLECTION.spacePolicy, policy: normalized },
        deliveries,
        skipGroupBootstrapChecks,
      );

      const isCore = type === ATGRP_SPACE_TYPE.meta || type === ATGRP_SPACE_TYPE.members;
      if (!isCore && normalized.unlisted !== true) {
        const idxRkey = this.nextRev();
        groupState.spaceIndexRkeys.set(uri, idxRkey);
        await this.putGroupSpaceRecordInternal(
          ownerDid,
          ownerDid,
          groupMembersUri(ownerDid),
          ATGRP_COLLECTION.space,
          idxRkey,
          {
            $type: ATGRP_COLLECTION.space,
            space: uri,
            createdAt: new Date(this.now()).toISOString(),
          },
          deliveries,
          skipGroupBootstrapChecks,
        );
      }
      return { space: uri };
    }

    if (!isSkey(skey)) throw new FakeXrpcError(400, "InvalidRequest", "Invalid space key");
    const uri = buildSpaceUri(ownerDid, type, skey);
    const existing = this.spaces.get(uri);
    if (existing && !existing.deleted) throw new FakeXrpcError(400, "SpaceAlreadyExists", "Space already exists");
    this.spaces.set(uri, {
      type,
      skey,
      ownerDid,
      policy: toStoredPolicy(params.policy),
      members: new Map(),
      writers: new Map(),
      deleted: false,
      notifyRegistrations: new Map(),
    });
    return { space: uri };
  }

  /** Replaces the whole policy. A different `$type` migrates the space and discards the member list; on OpenSocial groups re-evaluates writers & space index. */
  private async updateSpace(
    params: Record<string, unknown>,
    auth: FakeAuth,
    deliveries: Promise<void>[] = [],
  ): Promise<Record<string, never>> {
    const did = this.requireSelf(auth, { scopes: "full", checkTakedown: true, checkDeactivated: true });
    this.requireSpaceAuthority(params.space, did);
    const space = this.requireActiveSpace(params.space);

    const groupState = this.groups.get(did);
    if (groupState) {
      return this.withRepoLock("__group_gov__", did, async () => {
        this.assertNoActiveFakeMigrationLease(groupState);
        const currentSpace = this.requireActiveSpace(params.space);
        const actorDid = this.requireGroupSpaceManagePerm(auth, did, currentSpace.type, currentSpace.skey, "update");
        const normalized = normalizeAtgrpPolicy(
          params.policy,
          { groupDid: did, spaceType: currentSpace.type, skey: currentSpace.skey },
          FakeXrpcError,
        );
        const uri = spaceUri(currentSpace);
        const preState = this.loadFakeGovernanceState(did);
        checkRoleAndAssignmentEscalation({
          actorDid,
          preState,
          groupDid: did,
          roleWrites: [],
          policyWrite: {
            spaceUri: uri,
            spaceType: currentSpace.type,
            skey: currentSpace.skey,
            policy: normalized,
            prevPolicy: preState.spacePolicies.get(uri),
            isEffectiveAdmin: actorDid === did || isEffectiveAdminMember(actorDid, preState, did),
          },
          membershipDiffs: [],
          ErrorCtor: FakeXrpcError,
        });
        const postPolicies = new Map(preState.spacePolicies);
        postPolicies.set(uri, normalized);
        const postState: GovernanceSnapshot = { ...preState, spacePolicies: postPolicies };
        checkPostGovernanceInvariants(preState, postState, did, {}, FakeXrpcError);

        let preparedMetaDecl: { value: Record<string, unknown>; cid: string } | "delete" | "noop" = "noop";
        if (uri === groupMetaUri(did)) {
          const existingDecl = this.publicRecords.get(did)?.get(`${REPO_COLLECTION.groupDeclaration}/${SELF_SKEY}`);
          if (normalized.publicRead === true) {
            const prevDecl =
              existingDecl?.value && typeof existingDecl.value === "object"
                ? (existingDecl.value as Record<string, unknown>)
                : null;
            if (!prevDecl || prevDecl.$type !== REPO_COLLECTION.groupDeclaration) {
              const declValue: Record<string, unknown> = {
                $type: REPO_COLLECTION.groupDeclaration,
              };
              const { cid: declCid } = await serializeRecord(
                REPO_COLLECTION.groupDeclaration as NsidString,
                SELF_SKEY as RecordKeyString,
                plainJsonToLexDataLocal(declValue) as LexMap,
              );
              preparedMetaDecl = { value: declValue, cid: declCid.toString() };
            }
          } else if (existingDecl) {
            preparedMetaDecl = "delete";
          }
        }

        currentSpace.policy = {
          $type: ATGRP_POLICY,
          publicRead: normalized.publicRead === true,
          publicWrite: false,
          unlisted: normalized.unlisted === true,
          grants: normalized.grants.map((g) => ({
            role: g.role,
            ...(g.read !== undefined ? { read: g.read } : {}),
            ...(g.write !== undefined ? { write: g.write } : {}),
            ...(g.permissions ? { permissions: [...g.permissions] } : {}),
          })),
        };

        if (preparedMetaDecl === "delete") {
          this.publicRecords.get(did)?.delete(`${REPO_COLLECTION.groupDeclaration}/${SELF_SKEY}`);
        } else if (preparedMetaDecl !== "noop") {
          let records = this.publicRecords.get(did);
          if (!records) this.publicRecords.set(did, (records = new Map()));
          records.set(`${REPO_COLLECTION.groupDeclaration}/${SELF_SKEY}`, preparedMetaDecl);
        }

        await this.putGroupSpaceRecordInternal(
          did,
          did,
          uri,
          ATPROTO_SPACE_COLLECTION.spacePolicy,
          SELF_SKEY,
          { $type: ATPROTO_SPACE_COLLECTION.spacePolicy, policy: normalized },
          deliveries,
          false,
        );

        const isCore = currentSpace.type === ATGRP_SPACE_TYPE.meta || currentSpace.type === ATGRP_SPACE_TYPE.members;
        if (!isCore) {
          const existingIdxRkey = groupState.spaceIndexRkeys.get(uri);
          if (!normalized.unlisted && !existingIdxRkey) {
            const idxRkey = this.nextRev();
            groupState.spaceIndexRkeys.set(uri, idxRkey);
            await this.putGroupSpaceRecordInternal(
              did,
              did,
              groupMembersUri(did),
              ATGRP_COLLECTION.space,
              idxRkey,
              {
                $type: ATGRP_COLLECTION.space,
                space: uri,
                createdAt: new Date(this.now()).toISOString(),
              },
              deliveries,
              false,
            );
          } else if (normalized.unlisted && existingIdxRkey) {
            groupState.spaceIndexRkeys.delete(uri);
            await this.deleteGroupSpaceRecordInternal(
              did,
              groupMembersUri(did),
              ATGRP_COLLECTION.space,
              existingIdxRkey,
              deliveries,
            );
          }
        }

        this.reconcileGroupSpaceWriters(did, postState, deliveries);
        return {};
      });
    }

    const next = toStoredPolicy(params.policy);
    if (next.$type !== space.policy.$type) space.members.clear();
    space.policy = next;
    return {};
  }

  private getSpace(params: Record<string, unknown>, auth: FakeAuth) {
    const did = this.requireSelf(auth, { scopes: "full" });
    this.requireSpaceAuthority(params.space, did);
    const grp = this.groups.get(did);
    if (grp) {
      if (grp.sourceMigrationLease?.status === "plc_signed") {
        throw new FakeXrpcError(409, "MigrationCutoverPending", "Group cutover pending");
      }
      const ref = this.requireSpaceRef(params.space);
      this.requireGroupSpaceActionPerm(auth, did, ref.type, ref.skey, "read_self");
    }
    const space = this.requireActiveSpace(params.space);
    return { space: spaceUri(space), policy: toPublicPolicy(space.policy) };
  }

  private putMembers(params: Record<string, unknown>, auth: FakeAuth, deliveries: Promise<void>[]): Record<string, never> {
    const did = this.requireSelf(auth, { scopes: "full", checkTakedown: true, checkDeactivated: true });
    this.requireSpaceAuthority(params.space, did);
    const space = this.requireActiveSpace(params.space);
    this.requireMemberspace(space);
    if (!Array.isArray(params.members) || params.members.length > 100) {
      throw new FakeXrpcError(400, "InvalidRequest", "members must be an array of at most 100 entries");
    }
    const accessByDid = new Map<string, { read: boolean; write: boolean }>();
    for (const raw of params.members) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new FakeXrpcError(400, "InvalidRequest", "Invalid member entry");
      }
      const member = raw as { did?: unknown; read?: unknown; write?: unknown };
      if (!isDid(member.did) || typeof member.read !== "boolean" || typeof member.write !== "boolean") {
        throw new FakeXrpcError(400, "InvalidRequest", "Member requires did, read, and write");
      }
      accessByDid.set(member.did, { read: member.read, write: member.write });
    }
    for (const [memberDid, access] of accessByDid) {
      space.members.set(memberDid, access);
      if (!access.write) {
        const removed = this.removeWriterEntry(space, memberDid);
        if (removed) deliveries.push(this.deliverSpaceUpdate(space, removed));
      }
    }
    return {};
  }

  private removeMembers(params: Record<string, unknown>, auth: FakeAuth, deliveries: Promise<void>[]): Record<string, never> {
    const did = this.requireSelf(auth, { scopes: "full", checkTakedown: true, checkDeactivated: true });
    this.requireSpaceAuthority(params.space, did);
    const space = this.requireActiveSpace(params.space);
    this.requireMemberspace(space);
    if (!Array.isArray(params.dids) || params.dids.length > 100) {
      throw new FakeXrpcError(400, "InvalidRequest", "dids must be an array of at most 100 DIDs");
    }
    for (const rawDid of params.dids) {
      if (!isDid(rawDid)) throw new FakeXrpcError(400, "InvalidRequest", "Invalid member DID");
      const wasMember = space.members.delete(rawDid);
      if (!wasMember) continue;
      const removed = this.removeWriterEntry(space, rawDid);
      if (removed) deliveries.push(this.deliverSpaceUpdate(space, removed));
    }
    return {};
  }

  private removeWriter(params: Record<string, unknown>, auth: FakeAuth, deliveries: Promise<void>[]): Record<string, never> {
    const did = this.requireSelf(auth, { scopes: "full", checkTakedown: true, checkDeactivated: true });
    this.requireSpaceAuthority(params.space, did);
    const grp = this.groups.get(did);
    if (grp) {
      this.assertNoActiveFakeMigrationLease(grp);
      const ref = this.requireSpaceRef(params.space);
      this.requireGroupSpaceManagePerm(auth, did, ref.type, ref.skey, "update");
    }
    const space = this.requireActiveSpace(params.space);
    if (!isDid(params.repo)) throw new FakeXrpcError(400, "InvalidRequest", "repo must be a DID");
    const removed = this.removeWriterEntry(space, params.repo);
    if (removed) deliveries.push(this.deliverSpaceUpdate(space, removed));
    return {};
  }

  private async deleteSpace(
    params: Record<string, unknown>,
    auth: FakeAuth,
    deliveries: Promise<void>[],
  ): Promise<Record<string, never>> {
    const did = this.requireSelf(auth, { scopes: "full", checkTakedown: true, checkDeactivated: true });
    this.requireSpaceAuthority(params.space, did);
    const uri = String(params.space ?? "");
    const space = this.spaces.get(uri);
    if (!space) throw new FakeXrpcError(400, "SpaceNotFound", "Space not found");

    const groupState = this.groups.get(did);
    if (groupState) {
      this.assertNoActiveFakeMigrationLease(groupState);
      this.requireGroupSpaceManagePerm(auth, did, space.type, space.skey, "delete");
      if (space.type === ATGRP_SPACE_TYPE.meta || space.type === ATGRP_SPACE_TYPE.members) {
        throw new FakeXrpcError(400, "CannotDeleteCoreSpace", `Core OpenSocial space ${space.type} cannot be deleted`);
      }
      if (uri === workspaceUri(did) && groupState.knownAppSubjects.size > 0) {
        throw new FakeXrpcError(
          400,
          "CannotDeleteWorkspaceWithAppTombstones",
          "Cannot delete Flock workspace/self while known_app_subject tombstones exist.",
        );
      }
      if (space.deleted) return {};
      const idxRkey = groupState.spaceIndexRkeys.get(uri);
      if (idxRkey) {
        groupState.spaceIndexRkeys.delete(uri);
        await this.deleteGroupSpaceRecordInternal(
          did,
          groupMembersUri(did),
          ATGRP_COLLECTION.space,
          idxRkey,
          deliveries,
        );
      }
      this.revokeGroupCredentialsForSpace(did, uri, undefined, deliveries);
    } else if (space.deleted) {
      return {};
    }

    const registrations = [...space.notifyRegistrations.values()];
    space.deleted = true;
    space.members.clear();
    space.writers.clear();
    space.notifyRegistrations.clear();
    this.accountRepos.get(space.ownerDid)?.delete(uri);

    if (!this.withheldNotices.has(uri) && registrations.length > 0) {
      deliveries.push(
        this.deliverDeletionNotice(uri, registrations),
      );
    }
    return {};
  }

  private listMembers(params: Record<string, unknown>, auth: FakeAuth) {
    const did = this.requireSelf(auth, { scopes: "full" });
    this.requireSpaceAuthority(params.space, did);
    const space = this.requireActiveSpace(params.space);
    this.requireMemberspace(space);
    const cursor = typeof params.cursor === "string" ? params.cursor : undefined;
    if (cursor !== undefined && !isDid(cursor)) {
      throw new FakeXrpcError(400, "InvalidCursor", "Malformed cursor");
    }
    const limit = clampLimit(params.limit, 100, 1000);
    const sorted = [...space.members.entries()]
      .map(([memberDid, access]) => ({ did: memberDid, ...access }))
      .sort((left, right) => compareLex(left.did, right.did));
    const filtered = cursor !== undefined ? sorted.filter((member) => member.did > cursor) : sorted;
    const page = filtered.slice(0, limit);
    return {
      members: page,
      ...(page.length === limit && filtered.length > limit ? { cursor: page[page.length - 1]!.did } : {}),
    };
  }

  /** Spaces the caller is the authority of or holds a repo in, as the reference PDS lists them. */
  private listSpaces(params: Record<string, unknown>, auth: FakeAuth) {
    const did = this.requireSelf(auth, { scopes: "full" });
    if (this.groups.has(did)) {
      this.requireGroupReadSelfPerm(auth, did);
    }
    const cursor = typeof params.cursor === "string" ? params.cursor : undefined;
    if (cursor !== undefined && !parseSpaceUri(cursor)) {
      throw new FakeXrpcError(400, "InvalidCursor", "Malformed cursor");
    }
    const spaceDidFilter = typeof params.spaceDid === "string" ? params.spaceDid : undefined;
    const spaceTypeFilter = typeof params.spaceType === "string" ? params.spaceType : undefined;
    const limit = clampLimit(params.limit, 50, 100);

    const uris = new Set<string>();
    for (const [uri, space] of this.spaces) {
      if (!space.deleted && space.ownerDid === did) uris.add(uri);
    }
    for (const uri of this.accountRepos.get(did)?.keys() ?? []) {
      uris.add(uri);
    }

    const entries = [...uris]
      .filter((uri) => {
        const parsed = parseSpaceUri(uri);
        if (!parsed) return false;
        if (spaceTypeFilter !== undefined && parsed.type !== spaceTypeFilter) return false;
        if (spaceDidFilter !== undefined && parsed.authorityDid !== spaceDidFilter) return false;
        return cursor === undefined || uri > cursor;
      })
      .sort(compareLex);

    const pageUris = entries.slice(0, limit);
    const callerRepos = this.accountRepos.get(did);
    const spaces = pageUris.map((uri) => {
      const repoState = callerRepos?.get(uri);
      const space = this.spaces.get(uri);
      const spaceRev = space && !space.deleted && space.ownerDid === did ? this.currentSpaceRev(space) : undefined;
      return {
        space: uri,
        ...(repoState ? { repoRev: repoState.rev, data: { $bytes: toBase64(this.commitForState(uri, did, repoState).data) } } : {}),
        ...(spaceRev !== undefined ? { spaceRev } : {}),
      };
    });
    return {
      spaces,
      ...(pageUris.length === limit ? { cursor: pageUris[pageUris.length - 1]! } : {}),
    };
  }

  /** A record in the account's ordinary public repo (outside any space), writable only by its owner. */
  private async putPublicRecord(params: Record<string, unknown>, auth: FakeAuth) {
    const did = this.requireSelf(auth, { scopes: "standard" });
    if (params.repo !== did) throw new FakeXrpcError(400, "InvalidRequest", "Can only write to your own repo");
    const collection = String(params.collection);
    const rkey = String(params.rkey);
    const grp = this.groups.get(did);
    if (grp) {
      return this.withRepoLock("__group_gov__", did, async () => {
        const existing = this.publicRecords.get(did)?.get(`${collection}/${rkey}`);
        this.assertNoActiveFakeMigrationLease(grp);
        this.requireGroupPublicRepoPerm(auth, did, collection, existing ? "update" : "create");
        if (params.swapRecord === null && existing) {
          throw new FakeXrpcError(400, "InvalidSwap", "Expected absent record for swapRecord: null");
        }
        if (typeof params.swapRecord === "string" && (!existing || existing.cid !== params.swapRecord)) {
          throw new FakeXrpcError(400, "InvalidSwap", "swapRecord CID mismatch");
        }
        const withType = { $type: collection, ...(params.record as Record<string, unknown>) };
        const check = validatePublicRecord(collection, withType, {
          repoDid: did,
          rkey,
          validate: typeof params.validate === "boolean" ? params.validate : undefined,
        });
        if (!check.valid) throw new FakeXrpcError(400, check.code ?? "InvalidRequest", check.reason);
        if (collection === REPO_COLLECTION.groupDeclaration) {
          const metaSp = this.spaces.get(groupMetaUri(did));
          if (!metaSp || metaSp.deleted || metaSp.policy.publicRead !== true) {
            throw new FakeXrpcError(
              400,
              "InvalidRequest",
              "Cannot publish org.atgrp.declaration while org.atgrp.meta/self has publicRead=false.",
            );
          }
        }
        const { cid } = await serializeRecord(
          collection as NsidString,
          rkey as RecordKeyString,
          plainJsonToLexDataLocal(withType) as LexMap,
        );
        let records = this.publicRecords.get(did);
        if (!records) this.publicRecords.set(did, (records = new Map()));
        records.set(`${collection}/${rkey}`, { value: withType, cid: cid.toString() });
        return { uri: `at://${did}/${collection}/${rkey}`, cid: cid.toString() };
      });
    }
    const { cid } = await serializeRecord(collection as `${string}.${string}.${string}`, rkey as never, plainJsonToLexDataLocal(params.record) as never);
    let records = this.publicRecords.get(did);
    if (!records) this.publicRecords.set(did, records = new Map());
    records.set(`${collection}/${rkey}`, { value: params.record, cid: cid.toString() });
    return { uri: `at://${did}/${collection}/${rkey}`, cid: cid.toString() };
  }

  private async createPublicRecord(params: Record<string, unknown>, auth: FakeAuth) {
    const did = this.requireSelf(auth, { scopes: "standard" });
    if (params.repo !== did) throw new FakeXrpcError(400, "InvalidRequest", "Can only write to your own repo");
    const collection = String(params.collection);
    const rkey = typeof params.rkey === "string" ? params.rkey : this.nextRev();
    if (!this.groups.has(did) && this.publicRecords.get(did)?.has(`${collection}/${rkey}`)) {
      throw new FakeXrpcError(400, "InvalidSwap", "Record already exists");
    }
    return this.putPublicRecord({ ...params, rkey, swapRecord: null }, auth);
  }

  private deletePublicRecord(params: Record<string, unknown>, auth: FakeAuth) {
    const did = this.requireSelf(auth, { scopes: "standard" });
    if (params.repo !== did) throw new FakeXrpcError(400, "InvalidRequest", "Can only write to your own repo");
    const collection = String(params.collection);
    const rkey = String(params.rkey);
    const grp = this.groups.get(did);
    const runDelete = () => {
      if (grp) {
        this.assertNoActiveFakeMigrationLease(grp);
        this.requireGroupPublicRepoPerm(auth, did, collection, "delete");
      }
      const existing = this.publicRecords.get(did)?.get(`${collection}/${rkey}`);
      if (typeof params.swapRecord === "string" && (!existing || existing.cid !== params.swapRecord)) {
        throw new FakeXrpcError(400, "InvalidSwap", "swapRecord CID mismatch");
      }
      this.publicRecords.get(did)?.delete(`${collection}/${rkey}`);
      return {};
    };
    return grp ? this.withRepoLock("__group_gov__", did, runDelete) : runDelete();
  }

  private async applyPublicWrites(params: Record<string, unknown>, auth: FakeAuth) {
    const did = this.requireSelf(auth, { scopes: "standard" });
    if (params.repo !== did) throw new FakeXrpcError(400, "InvalidRequest", "Can only write to your own repo");
    const writes = Array.isArray(params.writes) ? (params.writes as Array<Record<string, unknown>>) : [];
    const results: Array<Record<string, unknown>> = [];
    for (const w of writes) {
      const type = String(w.$type ?? "");
      const collection = String(w.collection ?? "");
      if (type === "com.atproto.repo.applyWrites#delete") {
        await this.deletePublicRecord({ repo: did, collection, rkey: String(w.rkey ?? "") }, auth);
        results.push({ $type: "com.atproto.repo.applyWrites#deleteResult" });
      } else if (type === "com.atproto.repo.applyWrites#create") {
        const res = await this.createPublicRecord(
          { repo: did, collection, rkey: w.rkey, record: w.value, validate: params.validate },
          auth,
        );
        results.push({ $type: "com.atproto.repo.applyWrites#createResult", ...res });
      } else if (type === "com.atproto.repo.applyWrites#update") {
        const res = await this.putPublicRecord(
          { repo: did, collection, rkey: w.rkey, record: w.value, validate: params.validate },
          auth,
        );
        results.push({ $type: "com.atproto.repo.applyWrites#updateResult", ...res });
      } else {
        throw new FakeXrpcError(400, "InvalidRequest", `Unsupported write type: ${type}`);
      }
    }
    return { results };
  }

  private describePublicRepo(params: Record<string, unknown>) {
    const repoInput = String(params.repo ?? "");
    const did = isDid(repoInput) ? repoInput : this.groupsByHandle.get(repoInput);
    if (!did || !this.accounts.has(did)) throw new FakeXrpcError(400, "RepoNotFound", "Repo not found");
    const handle = this.groups.get(did)?.handle ?? did;
    const collections = new Set<string>();
    for (const key of this.publicRecords.get(did)?.keys() ?? []) {
      collections.add(key.split("/", 1)[0]!);
    }
    return {
      handle,
      did,
      didDoc: {},
      collections: [...collections].sort(),
      handleIsCorrect: true,
    };
  }

  private listPublicRecords(params: Record<string, unknown>) {
    const did = String(params.repo ?? "");
    const collection = String(params.collection ?? "");
    const limit = clampLimit(params.limit, 50, 100);
    const cursor = typeof params.cursor === "string" ? params.cursor : undefined;
    const all: Array<{ uri: string; cid: string; value: unknown; rkey: string }> = [];
    for (const [key, entry] of this.publicRecords.get(did)?.entries() ?? []) {
      const slash = key.indexOf("/");
      const col = key.slice(0, slash);
      const rkey = key.slice(slash + 1);
      if (col === collection) {
        all.push({ uri: `at://${did}/${col}/${rkey}`, cid: entry.cid, value: entry.value, rkey });
      }
    }
    all.sort((a, b) => compareLex(b.rkey, a.rkey));
    const filtered = cursor !== undefined ? all.filter((item) => item.rkey < cursor) : all;
    const page = filtered.slice(0, limit);
    return {
      records: page.map(({ uri, cid, value }) => ({ uri, cid, value })),
      ...(page.length === limit && filtered.length > limit ? { cursor: page.at(-1)!.rkey } : {}),
    };
  }

  /** Public: any caller, session or not, may read a public repo record. */
  private getPublicRecord(params: Record<string, unknown>) {
    const repo = String(params.repo);
    const state = this.unavailable.get(repo);
    if (state === "RepoDeactivated" || state === "RepoTakendown") {
      throw new FakeXrpcError(400, state, `Repo is not available: ${repo}`);
    }
    const record = this.publicRecords.get(repo)?.get(`${String(params.collection)}/${String(params.rkey)}`);
    if (!record) throw new FakeXrpcError(400, "RecordNotFound", "Record not found");
    return { uri: `at://${repo}/${String(params.collection)}/${String(params.rkey)}`, cid: record.cid, value: record.value };
  }

  /**
   * Runs a mutation strictly serialized per `(spaceUri, repoDid)`.
   * Executes synchronously when no mutation is queued so sync test helpers (`clearRecordsAs`) keep working without `await`.
   */
  private withRepoLock<T>(spaceUri: string, repoDid: string, fn: () => T | Promise<T>): T | Promise<T> {
    const key = `${spaceUri}\u0000${repoDid}`;
    const prev = this.repoLocks.get(key);
    if (!prev) {
      const result = fn();
      if (result instanceof Promise) {
        const tracked = result.then(() => undefined, () => undefined).finally(() => {
          if (this.repoLocks.get(key) === tracked) this.repoLocks.delete(key);
        });
        this.repoLocks.set(key, tracked);
      }
      return result;
    }
    const next = prev.then(() => fn());
    const tracked = next.then(() => undefined, () => undefined).finally(() => {
      if (this.repoLocks.get(key) === tracked) this.repoLocks.delete(key);
    });
    this.repoLocks.set(key, tracked);
    return next;
  }

  private getOrCreateAccountRepo(repo: string, spaceUriStr: string): FakeAccountRepo {
    let bySpace = this.accountRepos.get(repo);
    if (!bySpace) this.accountRepos.set(repo, bySpace = new Map());
    let state = bySpace.get(spaceUriStr);
    if (!state) {
      state = { rev: this.nextRev(), collections: new Map(), oplog: [] };
      bySpace.set(spaceUriStr, state);
    }
    return state;
  }

  private assertOwnSpaceExistsForWrite(spaceUriStr: string, writerDid: string): void {
    const ref = this.requireSpaceRef(spaceUriStr);
    if (ref.authorityDid === writerDid) {
      const space = this.spaces.get(spaceUriStr);
      if (!space || space.deleted) throw new FakeXrpcError(400, "SpaceNotFound", "Space not found");
    }
  }

  private async putRecordUnlocked(
    params: Record<string, unknown>,
    did: string,
    deliveries: Promise<void>[],
  ) {
    const spaceUriStr = String(params.space);
    const repo = String(params.repo);
    const collection = String(params.collection);
    const rkey = String(params.rkey);
    const record = params.record as Record<string, unknown>;
    this.assertOwnSpaceExistsForWrite(spaceUriStr, did);

    const { cid } = await serializeRecord(
      collection as `${string}.${string}.${string}`,
      rkey as never,
      plainJsonToLexDataLocal(record) as never,
    );
    const accountRepo = this.getOrCreateAccountRepo(repo, spaceUriStr);
    let records = accountRepo.collections.get(collection);
    if (!records) accountRepo.collections.set(collection, records = new Map());
    const prev = records.get(rkey)?.cid.toString() ?? null;
    records.set(rkey, { value: record, cid });
    const rev = this.nextRev();
    accountRepo.rev = rev;
    accountRepo.oplog.push({ rev, idx: 0, collection, rkey, cid: cid.toString(), prev });
    this.recordWrite(spaceUriStr, repo, accountRepo, deliveries);
    return { uri: `${spaceUriStr}/${repo}/${collection}/${rkey}`, cid: cid.toString() };
  }

  private async putRecord(
    params: Record<string, unknown>,
    auth: FakeAuth,
    deliveries: Promise<void>[],
    requestHeaders?: Headers,
  ) {
    const did = this.requireSelf(auth, { scopes: "full", checkTakedown: true, checkDeactivated: true });
    const repo = String(params.repo);
    if (repo !== did) throw new FakeXrpcError(403, "Forbidden", "repo must match authenticated user");
    if (this.groups.has(did)) {
      const spaceUriStr = String(params.space ?? "");
      const collection = String(params.collection);
      const rkey = String(params.rkey);
      const existing = this.accountRepos.get(did)?.get(spaceUriStr)?.collections.get(collection)?.has(rkey);
      const actorDid = this.requireGroupSpaceRecordPerm(auth, did, spaceUriStr, collection, existing ? "update" : "create");
      const ifJoinReq = requestHeaders?.get("if-join-request-present")?.trim().toLowerCase() === "true";
      const res = await this.applyGroupSpaceWrites({
        groupDid: did,
        actorDid,
        spaceUri: spaceUriStr,
        writes: [
          {
            action: existing ? "update" : "create",
            collection,
            rkey,
            value: params.record as Record<string, unknown>,
            ...(typeof params.validate === "boolean" ? { validate: params.validate } : {}),
          },
        ],
        isPutRecord: true,
        putSwapRecord: params.swapRecord === null ? null : typeof params.swapRecord === "string" ? params.swapRecord : undefined,
        ifJoinRequestPresent: ifJoinReq,
        deliveries,
      });
      return {
        uri: res.results[0]!.uri,
        cid: res.results[0]!.cid!,
        commit: res.commit,
        validationStatus: "valid",
      };
    }
    return this.withRepoLock(String(params.space ?? ""), repo, () => this.putRecordUnlocked(params, did, deliveries));
  }

  /** Like `putRecord`, but a record already at that key is refused, as the pinned PDS's `createRecord` does. */
  private async createRecord(
    params: Record<string, unknown>,
    auth: FakeAuth,
    deliveries: Promise<void>[],
    requestHeaders?: Headers,
  ) {
    const did = this.requireSelf(auth, { scopes: "full", checkTakedown: true, checkDeactivated: true });
    const repo = String(params.repo);
    if (repo !== did) throw new FakeXrpcError(403, "Forbidden", "repo must match authenticated user");
    const spaceUriStr = String(params.space ?? "");
    if (this.groups.has(did)) {
      const collection = String(params.collection);
      const actorDid = this.requireGroupSpaceRecordPerm(auth, did, spaceUriStr, collection, "create");
      const ifJoinReq = requestHeaders?.get("if-join-request-present")?.trim().toLowerCase() === "true";
      const res = await this.applyGroupSpaceWrites({
        groupDid: did,
        actorDid,
        spaceUri: spaceUriStr,
        writes: [
          {
            action: "create",
            collection,
            ...(typeof params.rkey === "string" ? { rkey: params.rkey } : {}),
            value: params.record as Record<string, unknown>,
            ...(typeof params.validate === "boolean" ? { validate: params.validate } : {}),
          },
        ],
        ifJoinRequestPresent: ifJoinReq,
        deliveries,
      });
      return {
        uri: res.results[0]!.uri,
        cid: res.results[0]!.cid!,
        commit: res.commit,
        validationStatus: "valid",
      };
    }
    return this.withRepoLock(spaceUriStr, repo, () => {
      this.assertOwnSpaceExistsForWrite(spaceUriStr, did);
      const rkey = typeof params.rkey === "string" ? params.rkey : fakeTid(++this.revCounter);
      const existing = this.accountRepos.get(repo)?.get(spaceUriStr)?.collections.get(String(params.collection))?.has(rkey);
      if (existing) throw new FakeXrpcError(400, "RecordAlreadyExists", "Record already exists");
      return this.putRecordUnlocked({ ...params, rkey }, did, deliveries);
    });
  }

  private async applyWrites(
    params: Record<string, unknown>,
    auth: FakeAuth,
    deliveries: Promise<void>[],
    requestHeaders?: Headers,
  ) {
    const did = this.requireSelf(auth, { scopes: "full", checkTakedown: true, checkDeactivated: true });
    const repo = String(params.repo);
    if (repo !== did) throw new FakeXrpcError(403, "Forbidden", "repo must match authenticated user");
    const spaceUriStr = String(params.space ?? "");
    if (this.groups.has(did)) {
      const writes = Array.isArray(params.writes) ? (params.writes as Array<Record<string, unknown>>) : [];
      if (writes.length > 200) throw new FakeXrpcError(400, "InvalidRequest", "Too many writes. Max: 200");
      if (writes.length === 0) return { results: [] };
      let actorDid = did;
      const mapped = writes.map((w) => {
        const type = String(w.$type ?? "");
        const collection = String(w.collection ?? "");
        if (type === "com.atproto.space.applyWrites#delete") {
          actorDid = this.requireGroupSpaceRecordPerm(auth, did, spaceUriStr, collection, "delete");
          return { action: "delete" as const, collection, rkey: String(w.rkey ?? "") };
        }
        if (type === "com.atproto.space.applyWrites#create") {
          actorDid = this.requireGroupSpaceRecordPerm(auth, did, spaceUriStr, collection, "create");
          return {
            action: "create" as const,
            collection,
            ...(typeof w.rkey === "string" ? { rkey: w.rkey } : {}),
            value: w.value as Record<string, unknown>,
            ...(typeof params.validate === "boolean" ? { validate: params.validate } : {}),
          };
        }
        if (type === "com.atproto.space.applyWrites#update") {
          actorDid = this.requireGroupSpaceRecordPerm(auth, did, spaceUriStr, collection, "update");
          return {
            action: "update" as const,
            collection,
            rkey: String(w.rkey ?? ""),
            value: w.value as Record<string, unknown>,
            ...(typeof params.validate === "boolean" ? { validate: params.validate } : {}),
          };
        }
        throw new FakeXrpcError(400, "InvalidRequest", `Action not supported: ${type}`);
      });
      const ifJoinReq = requestHeaders?.get("if-join-request-present")?.trim().toLowerCase() === "true";
      return this.applyGroupSpaceWrites({
        groupDid: did,
        actorDid,
        spaceUri: spaceUriStr,
        writes: mapped,
        ifJoinRequestPresent: ifJoinReq,
        deliveries,
      });
    }
    return this.withRepoLock(spaceUriStr, repo, async () => {
      this.requireSpaceRef(spaceUriStr);
      this.assertOwnSpaceExistsForWrite(spaceUriStr, did);
      const writes = Array.isArray(params.writes) ? (params.writes as Array<Record<string, unknown>>) : [];
      if (writes.length > 200) throw new FakeXrpcError(400, "InvalidRequest", "Too many writes. Max: 200");
      if (writes.length === 0) return { results: [] };

      const existingCollections = this.accountRepos.get(repo)?.get(spaceUriStr)?.collections;
      const staged = new Map<string, Map<string, RecordEntry>>();
      for (const [col, entries] of existingCollections ?? []) staged.set(col, new Map(entries));

      const rev = this.nextRev();
      const ops: FakeRepoOp[] = [];
      const results: Array<Record<string, unknown>> = [];

      for (const write of writes) {
        const type = String(write.$type ?? "");
        const collection = String(write.collection ?? "");
        if (type === "com.atproto.space.applyWrites#delete") {
          const rkey = String(write.rkey ?? "");
          const col = staged.get(collection);
          const prevEntry = col?.get(rkey);
          if (!prevEntry) throw new FakeXrpcError(400, "RecordNotFound", `Record not found: ${collection}/${rkey}`);
          col!.delete(rkey);
          ops.push({ rev, idx: ops.length, collection, rkey, cid: null, prev: prevEntry.cid.toString() });
          results.push({ $type: "com.atproto.space.applyWrites#deleteResult" });
          continue;
        }

        const isCreate = type === "com.atproto.space.applyWrites#create";
        const isUpdate = type === "com.atproto.space.applyWrites#update";
        if (!isCreate && !isUpdate) throw new FakeXrpcError(400, "InvalidRequest", `Action not supported: ${type}`);

        const rkey = typeof write.rkey === "string" ? write.rkey : fakeTid(++this.revCounter);
        let col = staged.get(collection);
        if (!col) staged.set(collection, col = new Map());
        const prevEntry = col.get(rkey);
        if (isCreate && prevEntry) throw new FakeXrpcError(400, "RecordAlreadyExists", `Record already exists: ${collection}/${rkey}`);
        if (isUpdate && !prevEntry) throw new FakeXrpcError(400, "RecordNotFound", `Record not found: ${collection}/${rkey}`);

        const value = write.value as Record<string, unknown>;
        const { cid } = await serializeRecord(collection as never, rkey as never, plainJsonToLexDataLocal(value) as never);
        col.set(rkey, { value, cid });
        ops.push({
          rev,
          idx: ops.length,
          collection,
          rkey,
          cid: cid.toString(),
          prev: prevEntry?.cid.toString() ?? null,
        });
        results.push({
          $type: isCreate ? "com.atproto.space.applyWrites#createResult" : "com.atproto.space.applyWrites#updateResult",
          uri: `${spaceUriStr}/${repo}/${collection}/${rkey}`,
          cid: cid.toString(),
        });
      }

      const accountRepo = this.getOrCreateAccountRepo(repo, spaceUriStr);
      accountRepo.collections = staged;
      accountRepo.rev = rev;
      accountRepo.oplog.push(...ops);
      this.recordWrite(spaceUriStr, repo, accountRepo, deliveries);
      return { results };
    });
  }

  private clearRecords(
    params: Record<string, unknown>,
    auth: FakeAuth,
    deliveries: Promise<void>[],
  ): Record<string, unknown> | Promise<Record<string, unknown>> {
    const did = this.requireSelf(auth, { scopes: "full", checkTakedown: true, checkDeactivated: true });
    const repo = String(params.repo);
    if (repo !== did) throw new FakeXrpcError(403, "Forbidden", "repo must match authenticated user");
    const spaceUriStr = String(params.space ?? "");
    if (this.groups.has(did)) {
      const actorDid = this.requireGroupSpaceRecordPerm(auth, did, spaceUriStr, "*", "delete");
      const accountRepo = this.accountRepos.get(did)?.get(spaceUriStr);
      const deleteOps: Array<{ action: "delete"; collection: string; rkey: string }> = [];
      for (const [col, entries] of accountRepo?.collections ?? []) {
        if (col === ATPROTO_SPACE_COLLECTION.spacePolicy || col === ATGRP_COLLECTION.space) continue;
        for (const rkey of entries.keys()) {
          deleteOps.push({ action: "delete", collection: col, rkey });
        }
      }
      if (deleteOps.length === 0) return { commit: { rev: accountRepo?.rev ?? this.nextRev() } };
      return this.applyGroupSpaceWrites({
        groupDid: did,
        actorDid,
        spaceUri: spaceUriStr,
        writes: deleteOps,
        deliveries,
      }).then((r) => ({ commit: r.commit }));
    }
    return this.withRepoLock(spaceUriStr, repo, () => {
      this.requireSpaceRef(spaceUriStr);
      const accountRepo = this.accountRepos.get(repo)?.get(spaceUriStr);
      if (!accountRepo) return {};
      let hadRecords = false;
      for (const entries of accountRepo.collections.values()) {
        if (entries.size > 0) {
          hadRecords = true;
          break;
        }
      }
      if (!hadRecords) return {};
      accountRepo.collections.clear();
      accountRepo.oplog = [];
      accountRepo.rev = this.nextRev();
      this.recordWrite(spaceUriStr, repo, accountRepo, deliveries);
      return {};
    });
  }

  private async importRepo(
    _params: Record<string, unknown>,
    auth: FakeAuth,
    requestHeaders: Headers | undefined,
    rawBody?: Uint8Array,
  ): Promise<Record<string, never>> {
    const did = this.requireSelf(auth, { scopes: "full", checkTakedown: true, allowMigration: true });
    if (requestHeaders) {
      const contentType = requestHeaders.get("content-type") ?? "";
      if (!contentType.includes(STAR_MEDIA_TYPE)) {
        throw new FakeXrpcError(400, "InvalidRequest", `Content-Type must be ${STAR_MEDIA_TYPE}`);
      }
    }
    if (this.groups.has(did) && requestHeaders !== undefined && auth.kind !== "migration") {
      throw new FakeXrpcError(400, "AlreadyActivated", "Group is already activated");
    }
    if (!rawBody) throw new FakeXrpcError(400, "InvalidRepoFile", "STAR archive body is required");
    let parsed: Awaited<ReturnType<typeof readRepoStar>>;
    try {
      parsed = await readRepoStar([rawBody]);
    } catch (error) {
      throw new FakeXrpcError(400, "InvalidRepoFile", error instanceof Error ? error.message : "Invalid STAR archive");
    }
    try {
      if (parsed.commit.repo !== did) {
        throw new FakeXrpcError(400, "RepoMismatch", "Repo does not match the authenticated account");
      }
      if (this.groups.has(did) && auth.kind !== "migration") {
        this.requireGroupSpaceRecordPerm(auth, did, parsed.commit.space, "*", "create");
        this.requireGroupSpaceRecordPerm(auth, did, parsed.commit.space, "*", "update");
        this.requireGroupSpaceRecordPerm(auth, did, parsed.commit.space, "*", "delete");
      }
      return await this.withRepoLock(parsed.commit.space, did, async () => {
        const parsedSpace = this.requireSpaceRef(parsed.commit.space);
        const isOwnAuthority = parsedSpace.authorityDid === did;
        if (isOwnAuthority) {
          this.assertOwnSpaceExistsForWrite(parsed.commit.space, did);
        } else if (this.groups.has(did) && parsedSpace.type !== ATGRP_SPACE_TYPE.inbox) {
          throw new FakeXrpcError(400, "InvalidRepoFile", "External space repo must be org.atgrp.inbox/self");
        }
        const imported = new Map<string, Map<string, RecordEntry>>();
        const pendingKnownApps: string[] = [];
        const pendingSpaceIndex: Array<[string, string]> = [];
        const groupState = this.groups.get(did);
        for await (const entry of parsed.records) {
          const plainJson = lexDataToPlainJsonLocal(entry.record) as Record<string, unknown>;
          let incarnation: string | null | undefined = undefined;
          if (groupState) {
            if (!isOwnAuthority) {
              if (entry.collection !== ATGRP_COLLECTION.invite) {
                throw new FakeXrpcError(
                  400,
                  "InvalidRepoFile",
                  "External org.atgrp.inbox/self STAR archives may only contain org.atgrp.invite records",
                );
              }
              const check = validateSpaceRecord(ATGRP_COLLECTION.invite, plainJson, {
                authorityDid: parsedSpace.authorityDid,
                spaceUri: parsed.commit.space,
                repoDid: did,
                rkey: entry.rkey,
              });
              if (!check.valid) {
                throw new FakeXrpcError(400, "InvalidRepoFile", check.reason);
              }
            } else if (entry.collection === ATPROTO_SPACE_COLLECTION.spacePolicy) {
              if (plainJson.$type !== ATPROTO_SPACE_COLLECTION.spacePolicy) {
                throw new FakeXrpcError(
                  400,
                  "InvalidRepoFile",
                  "com.atproto.space.policy record must declare $type com.atproto.space.policy",
                );
              }
              const check = validateSpaceRecord(ATPROTO_SPACE_COLLECTION.spacePolicy, plainJson, {
                authorityDid: parsedSpace.authorityDid,
                spaceUri: parsed.commit.space,
                repoDid: did,
                rkey: entry.rkey,
              });
              if (!check.valid) {
                throw new FakeXrpcError(400, check.code ?? "InvalidRepoFile", check.reason);
              }
              const polCheck = validateSpacePolicy(plainJson.policy, {
                groupDid: did,
                spaceType: parsedSpace.type,
                skey: parsedSpace.skey,
                importMode: true,
              });
              if (!polCheck.valid) {
                throw new FakeXrpcError(400, polCheck.code ?? "InvalidSpacePolicy", polCheck.reason);
              }
            } else {
              const check = validateSpaceRecord(entry.collection, plainJson, {
                authorityDid: parsedSpace.authorityDid,
                spaceUri: parsed.commit.space,
                repoDid: did,
                rkey: entry.rkey,
                importMode: true,
              });
              if (
                !check.valid &&
                (check.reason !== "unknown collection" ||
                  MANDATORY_VALIDATED_SPACE_COLLECTIONS.has(entry.collection) ||
                  entry.collection.startsWith(`${ATGRP_NAMESPACE}.`))
              ) {
                throw new FakeXrpcError(400, check.code ?? "InvalidRepoFile", check.reason);
              }
            }
            if (parsed.commit.space === groupMembersUri(did) && entry.collection === ATGRP_COLLECTION.membership) {
              incarnation = typeof plainJson[FLOCK_EXTENSION_FIELD.incarnation] === "string"
                ? (plainJson[FLOCK_EXTENSION_FIELD.incarnation] as string)
                : `legacy-cid:${entry.cid.toString()}`;
            }
            if (parsed.commit.space === workspaceUri(did) && entry.collection === COLLECTION.appInstall) {
              pendingKnownApps.push(String(plainJson.subject));
            }
            if (parsed.commit.space === groupMembersUri(did) && entry.collection === ATGRP_COLLECTION.space) {
              pendingSpaceIndex.push([String(plainJson.space), entry.rkey]);
            }
          }
          let col = imported.get(entry.collection);
          if (!col) imported.set(entry.collection, col = new Map());
          col.set(entry.rkey, { value: plainJson, cid: entry.cid, ...(incarnation !== undefined ? { incarnation } : {}) });
        }
        return await this.withFakeGroupLock(did, () => {
          if (auth.kind === "migration") {
            this.verifyActiveMigrationAccessAuth(auth);
          }
          if (groupState) {
            for (const subj of pendingKnownApps) groupState.knownAppSubjects.add(subj);
            if (parsed.commit.space === groupMembersUri(did)) {
              groupState.spaceIndexRkeys.clear();
            }
            for (const [spUri, rkey] of pendingSpaceIndex) groupState.spaceIndexRkeys.set(spUri, rkey);
          }
          const accountRepo = this.getOrCreateAccountRepo(did, parsed.commit.space);
          accountRepo.collections = imported;
          accountRepo.oplog = [];
          accountRepo.rev = parsed.commit.rev ?? this.nextRev();
          return {};
        });
      });
    } catch (error) {
      if (error instanceof FakeXrpcError) throw error;
      throw new FakeXrpcError(400, "InvalidRepoFile", error instanceof Error ? error.message : "Invalid STAR archive");
    } finally {
      await parsed.records.return?.(undefined).catch(() => undefined);
    }
  }

  /**
   * A service token for `aud` and `lxm`, as the caller's own PDS or Group Host issues one.
   * Remains usable by app passwords (`ACCESS_STANDARD`) on personal PDS accounts, while signing
   * real ES256 service JWTs with bare `<groupDid>` `iss` on OpenSocial group accounts.
   */
  private async getServiceAuth(
    params: Record<string, unknown>,
    auth: FakeAuth,
    hostSlug = "group-host",
  ): Promise<{ token: string }> {
    const grpCheckDid = auth.kind === "self" ? auth.did : undefined;
    if (grpCheckDid && this.groups.has(grpCheckDid)) {
      const did = this.requireSelf(auth, { scopes: "full", checkTakedown: true, checkDeactivated: true });
      const grp = this.groups.get(did)!;
      if (auth.kind === "self" && auth.sessionKind === "recovery") {
        throw new FakeXrpcError(403, "Forbidden", "Recovery sessions cannot mint service JWTs");
      }
      this.reapFakeExpiredPreparedMigrationLease(grp);
      if (grp.sourceMigrationLease?.status === "plc_signed") {
        throw new FakeXrpcError(409, "MigrationCutoverPending", "Group cutover pending");
      }
      if (typeof params.aud !== "string" || params.aud.length === 0) {
        throw new FakeXrpcError(400, "InvalidRequest", "aud is required");
      }
      const aud: string = params.aud;
      const lxm = typeof params.lxm === "string" && params.lxm.length > 0 ? params.lxm : undefined;
      if (lxm && PROTECTED_SERVICE_AUTH_METHODS.has(lxm)) {
        throw new FakeXrpcError(400, "InvalidRequest", `Protected method cannot be minted via getServiceAuth: ${lxm}`);
      }
      const iat = Math.floor(this.now() / 1000);
      const exp = params.exp !== undefined ? Number(params.exp) : iat + 60;
      if (!Number.isFinite(exp)) {
        throw new FakeXrpcError(400, "InvalidRequest", "exp must be finite");
      }
      if (exp <= iat || exp * 1000 <= this.now()) {
        throw new FakeXrpcError(400, "BadExpiration", "Expiration is in the past");
      }
      if (lxm === undefined && exp - iat > 60) {
        throw new FakeXrpcError(400, "BadExpiration", "Unbound service JWT exp cannot exceed 60 seconds");
      }
      if (exp - iat > 3600) {
        throw new FakeXrpcError(400, "BadExpiration", "Service JWT exp cannot exceed 3600 seconds");
      }
      this.requireGroupRpcPerm(auth, did, aud, lxm ?? "*");
      const isTargetMigrationLxm =
        lxm === "com.atproto.server.createAccount" || lxm === FLOCK_GROUP_METHOD.abortMigration;
      let unleasedTargetVerified = false;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (isTargetMigrationLxm) {
          if (grp.sourceMigrationLease) {
            if (aud !== grp.sourceMigrationLease.targetServiceDid) {
              throw new FakeXrpcError(
                409,
                "MigrationInProgress",
                `Active migration lease restricts ${lxm} aud to ${grp.sourceMigrationLease.targetServiceDid}`,
              );
            }
          } else if (!unleasedTargetVerified) {
            const bareAudDid = aud.split("#", 1)[0]!;
            const audDoc = await this.resolveFakePeerDidDoc(bareAudDid);
            const audPds = audDoc ? this.extractFakeDidPdsEndpoint(audDoc) : null;
            if (!audPds) {
              throw new FakeXrpcError(400, "UnsupportedGroupHostTarget", `Cannot resolve #atproto_pds for ${aud}`);
            }
            const cap = await this.verifyFakeOpenSocialTargetCapability(audPds, hostSlug);
            if (cap.targetServiceDid !== bareAudDid || aud !== cap.targetServiceDid) {
              throw new FakeXrpcError(400, "UnsupportedGroupHostTarget", "Target service DID mismatch");
            }
            unleasedTargetVerified = true;
          }
        }
        const mintIat = Math.floor(this.now() / 1000);
        const mintExp = params.exp !== undefined ? Number(params.exp) : mintIat + 60;
        const jti = typeof params.jti === "string" ? params.jti : randomUUID();
        const token = await this.signFakeServiceJwt({
          issDid: did,
          aud,
          ...(lxm !== undefined ? { lxm } : {}),
          iat: mintIat,
          exp: mintExp,
          jti,
        });

        // Final synchronous commit-point revalidation after async target/signing awaits!
        this.requireSelf(auth, { scopes: "full", checkTakedown: true, checkDeactivated: true });
        const liveGrp = this.groups.get(did);
        if (!liveGrp) {
          throw new FakeXrpcError(400, "RepoNotFound", "Group no longer hosted here");
        }
        this.reapFakeExpiredPreparedMigrationLease(liveGrp);
        if (liveGrp.sourceMigrationLease?.status === "plc_signed") {
          throw new FakeXrpcError(409, "MigrationCutoverPending", "Group cutover pending");
        }
        this.requireGroupRpcPerm(auth, did, aud, lxm ?? "*");
        const commitNowMs = this.now();
        const commitNowSec = Math.floor(commitNowMs / 1000);
        const finalDiffMs = mintExp * 1000 - commitNowMs;
        if (mintExp <= commitNowSec || finalDiffMs <= 0) {
          throw new FakeXrpcError(400, "BadExpiration", "Expiration is in the past");
        }
        if (finalDiffMs > 3_600_000) {
          throw new FakeXrpcError(400, "BadExpiration", "Service JWT exp cannot exceed 3600 seconds");
        }
        if (lxm === undefined && finalDiffMs > 60_000) {
          throw new FakeXrpcError(400, "BadExpiration", "Unbound service JWT exp cannot exceed 60 seconds");
        }
        if (isTargetMigrationLxm) {
          if (liveGrp.sourceMigrationLease) {
            if (aud !== liveGrp.sourceMigrationLease.targetServiceDid) {
              throw new FakeXrpcError(
                409,
                "MigrationInProgress",
                `Active migration lease restricts ${lxm} aud to ${liveGrp.sourceMigrationLease.targetServiceDid}`,
              );
            }
          } else if (!unleasedTargetVerified) {
            continue;
          }
        }
        return { token };
      }
      throw new FakeXrpcError(409, "MigrationInProgress", "Concurrent migration state change during getServiceAuth");
    }

    const did = this.requireSelf(auth, { scopes: "standard" });
    if (typeof params.aud !== "string") throw new FakeXrpcError(400, "InvalidRequest", "aud is required");
    const iat = Math.floor(this.now() / 1000);
    const exp = params.exp !== undefined ? Number(params.exp) : iat + 60;
    const jti = typeof params.jti === "string" ? params.jti : randomStr(12, "hex");
    return { token: `fake-service-token.${btoa(JSON.stringify({ iss: did, aud: params.aud, lxm: params.lxm ?? null, iat, exp, jti }))}` };
  }

  /** What a fake service token says, or null when it is not one this network issued. */
  readServiceToken(token: string): { iss: string; aud: string; lxm: string | null; exp: number } | null {
    if (token.startsWith("fake-service-token.")) {
      try {
        return JSON.parse(atob(token.slice("fake-service-token.".length))) as { iss: string; aud: string; lxm: string | null; exp: number };
      } catch {
        return null;
      }
    }
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    try {
      const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
        iss?: string;
        aud?: string;
        lxm?: string | null;
        exp?: number;
      };
      if (
        typeof payload.iss !== "string" ||
        typeof payload.aud !== "string" ||
        typeof payload.exp !== "number"
      ) {
        return null;
      }
      const bareIss = payload.iss.split("#", 1)[0]!;
      if (!this.accounts.has(bareIss) && !bareIss.startsWith("did:web:fake-pds.test")) {
        return null;
      }
      return {
        iss: payload.iss,
        aud: payload.aud,
        lxm: payload.lxm ?? null,
        exp: payload.exp,
      };
    } catch {
      return null;
    }
  }

  private deleteRecord(
    params: Record<string, unknown>,
    auth: FakeAuth,
    deliveries: Promise<void>[],
  ): Record<string, unknown> | Promise<Record<string, unknown>> {
    const did = this.requireSelf(auth, { scopes: "full", checkTakedown: true, checkDeactivated: true });
    const repo = String(params.repo);
    if (repo !== did) throw new FakeXrpcError(403, "Forbidden", "repo must match authenticated user");
    const spaceUriStr = String(params.space ?? "");
    if (this.groups.has(did)) {
      const collection = String(params.collection);
      const rkey = String(params.rkey);
      const actorDid = this.requireGroupSpaceRecordPerm(auth, did, spaceUriStr, collection, "delete");
      return this.applyGroupSpaceWrites({
        groupDid: did,
        actorDid,
        spaceUri: spaceUriStr,
        writes: [
          {
            action: "delete",
            collection,
            rkey,
            ...(typeof params.swapRecord === "string" ? { swapRecord: params.swapRecord } : {}),
          },
        ],
        isPutRecord: true,
        deliveries,
      }).then((r) => ({ commit: r.commit }));
    }
    return this.withRepoLock(spaceUriStr, repo, () => {
      this.requireSpaceRef(spaceUriStr);
      const accountRepo = this.accountRepos.get(repo)?.get(spaceUriStr);
      if (!accountRepo) return {};
      const collection = String(params.collection);
      const rkey = String(params.rkey);
      const entries = accountRepo.collections.get(collection);
      const existing = entries?.get(rkey);
      if (!existing) return {};
      entries!.delete(rkey);
      const rev = this.nextRev();
      accountRepo.oplog.push({ rev, idx: 0, collection, rkey, cid: null, prev: existing.cid.toString() });
      accountRepo.rev = rev;
      this.recordWrite(spaceUriStr, repo, accountRepo, deliveries);
      return {};
    });
  }

  /** Updates the space's writer set (unless lagging) and schedules `notifySpaceUpdate` deliveries. */
  private recordWrite(
    spaceUriStr: string,
    repo: string,
    accountRepo: FakeAccountRepo,
    deliveries: Promise<void>[],
  ): void {
    const space = this.spaces.get(spaceUriStr);
    if (!space || space.deleted) return;
    const repoRev = accountRepo.rev;
    if (this.lagging.has(spaceUriStr)) {
      if (space.policy.$type === MANAGEDSPACE_POLICY || this.currentlyAuthorizedSyncWriter(space, repo)) {
        const pending = this.pendingListing.get(spaceUriStr) ?? [];
        pending.push({ did: repo, repoRev });
        this.pendingListing.set(spaceUriStr, pending);
      }
      return;
    }
    const data = this.commitForState(spaceUriStr, repo, accountRepo).data;
    if (space.policy.$type === MANAGEDSPACE_POLICY) {
      deliveries.push(this.deliverRepoUpdateToSpace(space, repo, repoRev, data).then(() => undefined));
      return;
    }
    if (!this.currentlyAuthorizedSyncWriter(space, repo)) return;
    const update = this.recordWriterEntry(space, repo, repoRev, data);
    if (update) deliveries.push(this.deliverSpaceUpdate(space, update));
  }

  private async deliverRepoUpdateToSpace(
    space: FakeSpace,
    repo: string,
    repoRev: string,
    data: Uint8Array,
  ): Promise<"ok" | "rejected" | "retryable"> {
    try {
      const authorized = await this.authorizeRepoAccess(space, repo, "write");
      if (!authorized) return "rejected";
      const update = this.recordWriterEntry(space, repo, repoRev, data);
      if (update) await this.deliverSpaceUpdate(space, update);
      return "ok";
    } catch (error) {
      if (error instanceof FakeXrpcError && error.status >= 500) {
        const spaceUriStr = spaceUri(space);
        this.pendingRepoUpdateRetries.set(`${spaceUriStr}\u0000${repo}`, { spaceUri: spaceUriStr, repo, repoRev, data });
        return "retryable";
      }
      return "rejected";
    }
  }

  private recordWriterEntry(
    space: FakeSpace,
    repo: string,
    repoRev: string,
    data: Uint8Array,
  ): Record<string, unknown> | undefined {
    if (!isTid(repoRev)) {
      throw new FakeXrpcError(
        400,
        "InvalidRequest",
        "repoRev must be a canonical 13-char TID starting with [234567abcdefghij]",
      );
    }
    const existing = space.writers.get(repo);
    const existingRev = existing
      ? existing.removed
        ? this.groups.has(space.ownerDid)
          ? undefined
          : existing.lastRepoRev
        : existing.repoRev
      : undefined;
    if (existingRev !== undefined) {
      if (isTid(existingRev)) {
        const prevTs = tidTimestampUs(existingRev);
        const nextTs = tidTimestampUs(repoRev);
        if (prevTs > nextTs || (prevTs === nextTs && existingRev >= repoRev)) {
          return undefined;
        }
      } else if ((existingRev as string) >= repoRev) {
        return undefined;
      }
    }

    const { spaceRev, prevSpaceRev } = this.nextSpaceRev(space);
    space.writers.set(repo, { removed: false, repoRev, spaceRev, data });
    return {
      $type: "com.atproto.space.defs#repoWrite",
      repo,
      repoRev,
      spaceRev,
      ...(prevSpaceRev !== undefined ? { prevSpaceRev } : {}),
      data: { $bytes: toBase64(data) },
    };
  }

  private removeWriterEntry(space: FakeSpace, repo: string): Record<string, unknown> | undefined {
    const existing = space.writers.get(repo);
    if (!existing || existing.removed) return undefined;
    const { spaceRev, prevSpaceRev } = this.nextSpaceRev(space);
    space.writers.set(repo, { removed: true, lastRepoRev: existing.repoRev, spaceRev });
    return {
      $type: "com.atproto.space.defs#repoRemoved",
      repo,
      spaceRev,
      ...(prevSpaceRev !== undefined ? { prevSpaceRev } : {}),
    };
  }

  private currentSpaceRev(space: FakeSpace): string | undefined {
    let latest: string | undefined;
    for (const entry of space.writers.values()) {
      if (latest === undefined || entry.spaceRev > latest) latest = entry.spaceRev;
    }
    return latest;
  }

  private nextSpaceRev(space: FakeSpace): { spaceRev: string; prevSpaceRev?: string } {
    const prevSpaceRev = this.currentSpaceRev(space);
    return { spaceRev: this.nextRev(), ...(prevSpaceRev !== undefined ? { prevSpaceRev } : {}) };
  }

  private async deliverSpaceUpdate(space: FakeSpace, update: Record<string, unknown>): Promise<void> {
    const uri = spaceUri(space);
    if (this.withheldNotices.has(uri)) return;
    const registrations = [...space.notifyRegistrations.entries()];
    if (registrations.length === 0) return;

    const nowMs = this.now();
    const active: Array<{ endpoint: string; token: string }> = [];
    const lapsed: Array<{ key: string; reg: FakeNotifyRegistration }> = [];

    for (const [key, reg] of registrations) {
      if (reg.expiresAtMs > nowMs) {
        active.push({ endpoint: reg.endpoint, token: reg.token });
      } else if (!reg.expiryNotified) {
        reg.expiryNotified = true;
        lapsed.push({ key, reg });
      }
    }

    await Promise.all(
      active.map(async ({ endpoint, token }) => {
        try {
          const response = await this.sendNotifyUpdate(endpoint, { space: uri, token, update });
          if (!response.ok) {
            // Active write/removal rejection (including HTTP 400) is logged and ignored without dropping registration (`util.ts:443`).
            this.notifyWarnings.push({
              space: uri,
              endpoint,
              updateType: String(update.$type ?? ""),
              status: response.status,
              error: `notifySpaceUpdate failed with HTTP ${response.status}`,
            });
          }
        } catch (error) {
          this.notifyWarnings.push({
            space: uri,
            endpoint,
            updateType: String(update.$type ?? ""),
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );

    if (lapsed.length > 0) {
      const expiredUpdate = {
        $type: "com.atproto.space.notifySpaceUpdate#registrationExpired",
        spaceRev: String(update.spaceRev),
      };
      await Promise.all(
        lapsed.map(async ({ key, reg }) => {
          try {
            const response = await this.sendNotifyUpdate(reg.endpoint, {
              space: uri,
              token: reg.token,
              update: expiredUpdate,
            });
            if (!response.ok && !RETRYABLE_HTTP_STATUSES.has(response.status)) {
              const current = space.notifyRegistrations.get(key);
              if (current && current.expiresAtMs <= this.now()) {
                space.notifyRegistrations.delete(key);
              }
            }
          } catch (error) {
            this.notifyWarnings.push({
              space: uri,
              endpoint: reg.endpoint,
              updateType: expiredUpdate.$type,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }),
      );
    }
  }

  private async deliverDeletionNotice(
    uri: string,
    registrations: readonly FakeNotifyRegistration[],
  ): Promise<void> {
    const update = { $type: "com.atproto.space.notifySpaceUpdate#spaceDeleted" };
    await Promise.all(
      registrations.map(async ({ endpoint, token }) => {
        try {
          await this.sendNotifyUpdate(endpoint, { space: uri, token, update });
        } catch (error) {
          this.notifyWarnings.push({
            space: uri,
            endpoint,
            updateType: update.$type,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );
  }

  private async sendNotifyUpdate(
    endpoint: string,
    body: { space: string; token: string; update: Record<string, unknown> },
  ): Promise<Response> {
    return this.sendOutbound(`${normalizeBaseUrl(endpoint)}/xrpc/com.atproto.space.notifySpaceUpdate`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
  }

  private hasOutboundHandler(url: string): boolean {
    const normalized = normalizeBaseUrl(url);
    for (const [base] of this.endpoints) {
      if (normalized === base || normalized.startsWith(`${base}/`)) return true;
    }
    return Boolean(this.outboundFetch);
  }

  private async sendOutbound(url: string, init: RequestInit): Promise<Response> {
    const request = new Request(url, init);
    const normalized = normalizeBaseUrl(url);
    let matchedEndpoint: string | undefined;
    let matchedHandler: ((request: Request) => Promise<Response> | Response) | undefined;
    for (const [base, handler] of this.endpoints) {
      if ((normalized === base || normalized.startsWith(`${base}/`)) && (!matchedEndpoint || base.length > matchedEndpoint.length)) {
        matchedEndpoint = base;
        matchedHandler = handler;
      }
    }
    if (matchedHandler) return matchedHandler(request);
    if (this.outboundFetch) return this.outboundFetch(request);
    throw new TypeError(`fake-pds: no endpoint registered for ${url}`);
  }

  private trackDelivery(promise: Promise<void>): void {
    const tracked = promise.catch(() => undefined).finally(() => {
      this.pendingDeliveries.delete(tracked);
    });
    this.pendingDeliveries.add(tracked);
  }

  /**
   * The shared secret for a MAC-bearing read. A credential must ask for a MAC via
   * `Accept-Signature` (`InvalidSpaceMac` otherwise); the secret is derived with HPKE
   * `"atproto-mac"` against the repo author's current `#atproto_kem` key.
   */
  private async spaceMacRequest(
    method: string,
    repo: string,
    own: boolean,
    requestHeaders: Headers | undefined,
  ): Promise<CreateMacParams | undefined> {
    const profile = MAC_METHODS[method]!;
    let request: ReturnType<typeof parseMacRequest>;
    try {
      request = parseMacRequest(requestHeaders?.get("accept-signature") ?? undefined, profile);
    } catch (error) {
      if (error instanceof SpaceMacError) throw new FakeXrpcError(400, "InvalidSpaceMac", error.message);
      throw error;
    }
    if (!request) {
      if (!own) {
        throw new FakeXrpcError(400, "InvalidSpaceMac", `A MAC must be requested with tag "${profile}"`);
      }
      return undefined;
    }
    try {
      const sharedSecret = decapsulate(await this.kemKeypair(repo), request.keyShare);
      return { ...request, sharedSecret };
    } catch (error) {
      if (error instanceof SpaceKemError || error instanceof SpaceMacError) {
        throw new FakeXrpcError(400, "InvalidSpaceMac", error.message);
      }
      throw error;
    }
  }

  private assertRepoAvailability(repo: string, own: boolean): void {
    if (!this.accounts.has(repo)) throw new FakeXrpcError(400, "RepoNotFound", `Could not find repo for DID: ${repo}`);
    const state = this.unavailable.get(repo);
    if (state === "RepoNotFound") throw new FakeXrpcError(400, "RepoNotFound", `Could not find repo for DID: ${repo}`);
    if (state && !own) throw new FakeXrpcError(400, state, `Repo is not available: ${repo}`);
  }

  private async getRecord(params: Record<string, unknown>, auth: FakeAuth, requestHeaders: Headers | undefined): Promise<WithHeaders> {
    const { own } = await this.authorizeSpaceRead(params, auth);
    const repo = String(params.repo);
    this.assertRepoAvailability(repo, own);
    const spaceUriStr = String(params.space);
    if (own && this.groups.has(repo)) {
      const ref = this.requireSpaceRef(spaceUriStr);
      this.requireGroupSpaceActionPerm(auth, repo, ref.type, ref.skey, "read_self", ref.authorityDid);
    }
    const mac = await this.spaceMacRequest("com.atproto.space.getRecord", repo, own, requestHeaders);

    const collection = String(params.collection);
    const rkey = String(params.rkey);
    const record = this.accountRepos.get(repo)?.get(spaceUriStr)?.collections.get(collection)?.get(rkey);
    if (!record) throw new FakeXrpcError(400, "RecordNotFound", "Record not found");

    const uri = `${spaceUriStr}/${repo}/${collection}/${rkey}`;
    const headers: Record<string, string> = mac
      ? macHeaders(RECORD_MAC_PROFILE, createRecordMacHeaders(uri as never, record.cid, mac).headers)
      : { vary: "Accept-Signature" };
    if (
      this.groups.has(repo) &&
      spaceUriStr === groupMembersUri(repo) &&
      collection === ATGRP_COLLECTION.membership
    ) {
      const inc =
        record.incarnation ??
        (typeof record.value[FLOCK_EXTENSION_FIELD.incarnation] === "string"
          ? (record.value[FLOCK_EXTENSION_FIELD.incarnation] as string)
          : undefined);
      if (inc) {
        headers["Atproto-Membership-Incarnation"] = inc;
        headers["access-control-expose-headers"] = headers["access-control-expose-headers"]
          ? `${headers["access-control-expose-headers"]}, Atproto-Membership-Incarnation`
          : "Atproto-Membership-Incarnation";
      }
    }
    return new WithHeaders({ uri, cid: record.cid.toString(), value: record.value }, headers);
  }

  private async getLatestCommit(params: Record<string, unknown>, auth: FakeAuth, requestHeaders: Headers | undefined): Promise<WithHeaders> {
    await this.beforeGetLatestCommit?.({ space: String(params.space), repo: String(params.repo) });
    const { own } = await this.authorizeSpaceRead(params, auth);
    const repo = String(params.repo);
    this.assertRepoAvailability(repo, own);
    const spaceUriStr = String(params.space);
    if (own && this.groups.has(repo)) {
      const ref = this.requireSpaceRef(spaceUriStr);
      this.requireGroupSpaceActionPerm(auth, repo, ref.type, ref.skey, "read_self", ref.authorityDid);
    }
    const mac = await this.spaceMacRequest("com.atproto.space.getLatestCommit", repo, own, requestHeaders);

    const commit = this.commitForRepo(spaceUriStr, repo);
    const headers = mac
      ? macHeaders(COMMIT_MAC_PROFILE, createCommitMacHeaders(commit, mac).headers)
      : { vary: "Accept-Signature" };
    return new WithHeaders({ commit: commitJson(commit) }, headers);
  }

  private async getRepo(params: Record<string, unknown>, auth: FakeAuth, requestHeaders: Headers | undefined): Promise<BinaryResponse> {
    await this.beforeGetRepo?.({ space: String(params.space), repo: String(params.repo) });
    const { own } = await this.authorizeSpaceRead(params, auth);
    const repo = String(params.repo);
    this.assertRepoAvailability(repo, own);
    const spaceUriStr = String(params.space);
    if (own && this.groups.has(repo)) {
      const ref = this.requireSpaceRef(spaceUriStr);
      this.requireGroupSpaceActionPerm(auth, repo, ref.type, ref.skey, "read_self", ref.authorityDid);
    }
    const mac = await this.spaceMacRequest("com.atproto.space.getRepo", repo, own, requestHeaders);

    const accountRepo = this.accountRepos.get(repo)?.get(spaceUriStr);
    if (!accountRepo) throw new FakeXrpcError(400, "RepoNotFound", `Could not find repo for space: ${spaceUriStr}`);
    const commit = this.commitForState(spaceUriStr, repo, accountRepo);

    const entries: Array<{ pathKey: string; collection: string; rkey: string; value: Record<string, unknown> }> = [];
    for (const [collection, records] of accountRepo.collections) {
      for (const [rkey, entry] of records) {
        entries.push({ pathKey: `${collection}/${rkey}`, collection, rkey, value: entry.value });
      }
    }
    entries.sort((left, right) => compareLex(left.pathKey, right.pathKey));
    const serialized: SerializedRecord[] = [];
    for (const entry of entries) {
      const lex = plainJsonToLexDataLocal(entry.value) as Parameters<typeof serializeRecord>[2];
      serialized.push(await serializeRecord(entry.collection as never, entry.rkey as never, lex));
    }
    const generator = writeRepoStar(commit, serialized);
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await generator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      async cancel() {
        await generator.return?.(undefined);
      },
    });
    const headers = mac
      ? macHeaders(COMMIT_MAC_PROFILE, createCommitMacHeaders(commit, mac).headers)
      : { vary: "Accept-Signature" };
    return new BinaryResponse(stream, headers, STAR_MEDIA_TYPE);
  }

  private async getBlob(params: Record<string, unknown>, auth: FakeAuth): Promise<BinaryResponse> {
    if (auth.kind === "credential-candidate") {
      await this.authorizeSpaceRead(params, auth);
    } else {
      const did = this.requireSelf(auth, { scopes: "full" });
      if (this.groups.has(did)) {
        const ref = this.requireSpaceRef(params.space);
        this.requireGroupSpaceActionPerm(auth, did, ref.type, ref.skey, "read");
      }
    }
    const repo = String(params.repo ?? "");
    const cid = String(params.cid ?? "");
    const spaceUriStr = String(params.space ?? "");
    const referenced = this.collectSpaceBlobCids(repo, spaceUriStr);
    if (!referenced.includes(cid)) {
      throw new FakeXrpcError(400, "BlobNotFound", `Blob not referenced in space: ${cid}`);
    }
    const blob = this.groups.get(repo)?.blobs.get(cid);
    if (!blob) throw new FakeXrpcError(400, "BlobNotFound", `Blob not found: ${cid}`);
    return new BinaryResponse(blob.bytes, { "x-content-type-options": "nosniff" }, blob.mimeType);
  }

  private async listBlobs(params: Record<string, unknown>, auth: FakeAuth) {
    if (auth.kind === "credential-candidate") {
      await this.authorizeSpaceRead(params, auth);
    } else {
      const did = this.requireSelf(auth, { scopes: "full" });
      if (this.groups.has(did)) {
        const ref = this.requireSpaceRef(params.space);
        this.requireGroupSpaceActionPerm(auth, did, ref.type, ref.skey, "read");
      }
    }
    const repo = String(params.repo ?? "");
    const spaceUriStr = String(params.space ?? "");
    const limit = clampLimit(params.limit, 500, 1000);
    const cursor = typeof params.cursor === "string" ? params.cursor : undefined;
    const all = this.collectSpaceBlobCids(repo, spaceUriStr);
    const filtered = cursor !== undefined ? all.filter((c) => c > cursor) : all;
    const page = filtered.slice(0, limit);
    return {
      cids: page,
      ...(page.length === limit && filtered.length > limit ? { cursor: page.at(-1)! } : {}),
    };
  }

  private async exportSpaceMeta(params: Record<string, unknown>, auth: FakeAuth): Promise<BinaryResponse> {
    const did = this.requireSelf(auth, { scopes: "full", allowMigration: true });
    this.requireSpaceAuthority(params.space, did);
    const grp = this.groups.get(did);
    if (grp) {
      this.reapFakeExpiredPreparedMigrationLease(grp);
      if (grp.sourceMigrationLease?.status === "plc_signed") {
        throw new FakeXrpcError(409, "MigrationCutoverPending", "Group cutover pending");
      }
      if (auth.kind !== "migration") {
        const ref = this.requireSpaceRef(params.space);
        this.requireGroupSpaceActionPerm(auth, did, ref.type, ref.skey, "read_self");
      }
    }
    const space = this.requireActiveSpace(params.space);
    const uri = spaceUri(space);
    const writers = [...space.writers.entries()]
      .filter(([, w]) => !w.removed)
      .sort((a, b) => compareLex(a[0], b[0]))
      .map(([writerDid, w]) => {
        if (w.removed) throw new Error("unreachable");
        return {
          did: writerDid as DidString,
          repoRev: w.repoRev,
          spaceRev: w.spaceRev,
          data: w.data,
        };
      });
    const archive: SpaceMetaArchive = {
      space: uri as SpaceRefString,
      policy: plainJsonToLexDataLocal(toPublicPolicy(space.policy)) as LexMap,
      policyState: [],
      writers,
    };
    const chunks: Uint8Array[] = [];
    for await (const chunk of writeSpaceMetaStar(archive)) chunks.push(chunk);
    return new BinaryResponse(concatBytes(chunks), {}, STAR_MEDIA_TYPE);
  }

  private async importSpaceMeta(
    auth: FakeAuth,
    requestHeaders?: Headers,
    rawBody?: Uint8Array,
  ): Promise<{ space: string }> {
    const did = this.requireSelf(auth, { scopes: "full", checkTakedown: true, allowMigration: true });
    if (requestHeaders) {
      const ct = requestHeaders.get("content-type") ?? "";
      if (!ct.includes(STAR_MEDIA_TYPE)) {
        throw new FakeXrpcError(400, "InvalidRequest", `Content-Type must be ${STAR_MEDIA_TYPE}`);
      }
    }
    if (this.groups.has(did) && auth.kind !== "migration") {
      throw new FakeXrpcError(400, "AlreadyActivated", "Group is already activated");
    }
    if (!rawBody || rawBody.byteLength === 0) {
      throw new FakeXrpcError(400, "InvalidSpaceMeta", "STAR archive body is required");
    }
    let archive: SpaceMetaArchive;
    try {
      archive = await readSpaceMetaStar([rawBody]);
    } catch (error) {
      throw new FakeXrpcError(400, "InvalidSpaceMeta", error instanceof Error ? error.message : "Invalid space meta STAR");
    }
    const parsed = parseSpaceUri(archive.space);
    if (!parsed || parsed.authorityDid !== did) {
      throw new FakeXrpcError(400, "InvalidSpaceMeta", "Space authority mismatch");
    }
    if (this.groups.has(did)) {
      const keyCheck = validateSpaceTypeKey(parsed.type, parsed.skey, { isGroupHostOwnSpace: true });
      if (!keyCheck.valid) {
        throw new FakeXrpcError(400, keyCheck.code ?? "InvalidSpaceMeta", keyCheck.reason);
      }
      const plainPolicy = lexDataToPlainJsonLocal(archive.policy);
      const normalized = normalizeAtgrpPolicy(
        plainPolicy,
        { groupDid: did, spaceType: parsed.type, skey: parsed.skey },
        FakeXrpcError,
      );
      const writersMap = new Map<string, FakeWriterEntry>();
      for (const w of archive.writers) {
        writersMap.set(w.did, {
          removed: false,
          repoRev: w.repoRev,
          spaceRev: w.spaceRev,
          data: new Uint8Array(w.data),
        });
      }
      return await this.withFakeGroupLock(did, () => {
        if (auth.kind === "migration") {
          this.verifyActiveMigrationAccessAuth(auth);
        }
        this.spaces.set(archive.space, {
          type: parsed.type,
          skey: parsed.skey,
          ownerDid: did,
          policy: {
            $type: ATGRP_POLICY,
            publicRead: normalized.publicRead === true,
            publicWrite: false,
            unlisted: normalized.unlisted === true,
            grants: normalized.grants.map((g) => ({
              role: g.role,
              ...(g.read !== undefined ? { read: g.read } : {}),
              ...(g.write !== undefined ? { write: g.write } : {}),
              ...(g.permissions ? { permissions: [...g.permissions] } : {}),
            })),
          },
          members: new Map(),
          writers: writersMap,
          deleted: false,
          notifyRegistrations: new Map(),
        });
        return { space: archive.space };
      });
    }
    const storedPol = toStoredPolicy(lexDataToPlainJsonLocal(archive.policy));
    const writersMap = new Map<string, FakeWriterEntry>();
    for (const w of archive.writers) {
      writersMap.set(w.did, {
        removed: false,
        repoRev: w.repoRev,
        spaceRev: w.spaceRev,
        data: new Uint8Array(w.data),
      });
    }
    this.spaces.set(archive.space, {
      type: parsed.type,
      skey: parsed.skey,
      ownerDid: did,
      policy: storedPol,
      members: new Map(),
      writers: writersMap,
      deleted: false,
      notifyRegistrations: new Map(),
    });
    return { space: archive.space };
  }

  private commitForRepo(spaceUriStr: string, repo: string): SpaceCommit {
    const accountRepo = this.accountRepos.get(repo)?.get(spaceUriStr);
    if (!accountRepo) throw new FakeXrpcError(400, "RepoNotFound", `Could not find repo for space: ${spaceUriStr}`);
    return this.commitForState(spaceUriStr, repo, accountRepo);
  }

  private commitForState(spaceUriStr: string, repo: string, accountRepo: FakeAccountRepo): SpaceCommit {
    const records = [...accountRepo.collections].flatMap(([collection, entries]) =>
      [...entries].map(([rkey, entry]) => ({ collection: collection as never, rkey: rkey as never, cid: entry.cid })));
    return RepoCommit.fromRecords(records).toCommit({
      space: spaceUriStr as SpaceCommit["space"],
      repo: repo as SpaceCommit["repo"],
      rev: accountRepo.rev as SpaceCommit["rev"],
    });
  }

  private async listRecords(params: Record<string, unknown>, auth: FakeAuth) {
    const collection = typeof params.collection === "string" ? params.collection : undefined;
    const excludeValues = params.excludeValues === true || params.excludeValues === "true";
    await this.beforeListRecords?.({
      space: String(params.space),
      repo: String(params.repo),
      ...(collection !== undefined ? { collection } : {}),
      excludeValues,
      ...(typeof params.cursor === "string" ? { cursor: params.cursor } : {}),
    });
    const { own } = await this.authorizeSpaceRead(params, auth);
    const repo = String(params.repo);
    this.assertRepoAvailability(repo, own);
    const spaceUriStr = String(params.space);
    const cursor = typeof params.cursor === "string" ? params.cursor : undefined;
    if (cursor !== undefined && !isSpaceRecordCursor(cursor)) {
      throw new FakeXrpcError(400, "InvalidCursor", "Malformed cursor");
    }

    const prefix = `${spaceUriStr}/${repo}`;
    const all: Array<{ uri: string; collection: string; rkey: string; entry: RecordEntry }> = [];
    const collections = this.accountRepos.get(repo)?.get(spaceUriStr)?.collections;
    if (collections) {
      if (collection !== undefined) {
        for (const [rkey, entry] of collections.get(collection)?.entries() ?? []) {
          all.push({ uri: `${prefix}/${collection}/${rkey}`, collection, rkey, entry });
        }
      } else {
        for (const [col, entries] of collections) {
          for (const [rkey, entry] of entries) {
            all.push({ uri: `${prefix}/${col}/${rkey}`, collection: col, rkey, entry });
          }
        }
      }
    }
    all.sort((left, right) => compareLex(right.uri, left.uri));
    const filtered = cursor !== undefined ? all.filter((item) => item.uri < cursor) : all;
    const limit = clampLimit(params.limit, 50, 1000);
    const page = filtered.slice(0, limit);
    const nextCursor = page.length < limit ? undefined : page.at(-1)?.uri;
    return {
      records: page.map((item) => ({
        collection: item.collection,
        rkey: item.rkey,
        cid: item.entry.cid.toString(),
        ...(excludeValues ? {} : { value: item.entry.value }),
      })),
      ...(nextCursor !== undefined ? { cursor: nextCursor } : {}),
    };
  }

  private async listRepoOps(params: Record<string, unknown>, auth: FakeAuth, requestHeaders: Headers | undefined): Promise<WithHeaders> {
    const limit = clampLimit(params.limit, 100, 1000);
    const excludeValues = params.excludeValues === true || params.excludeValues === "true";
    const since = typeof params.since === "string" ? params.since : undefined;
    const cursorStr = typeof params.cursor === "string" ? params.cursor : undefined;
    await this.beforeListRepoOps?.({
      space: String(params.space),
      repo: String(params.repo),
      ...(since !== undefined ? { since } : {}),
      ...(cursorStr !== undefined ? { cursor: cursorStr } : {}),
      limit,
      excludeValues,
    });
    const { own } = await this.authorizeSpaceRead(params, auth);
    const repo = String(params.repo);
    this.assertRepoAvailability(repo, own);
    const spaceUriStr = String(params.space);
    const mac = await this.spaceMacRequest("com.atproto.space.listRepoOps", repo, own, requestHeaders);
    const cursor = cursorStr !== undefined ? parseRepoOpsCursor(cursorStr) : undefined;

    const accountRepo = this.accountRepos.get(repo)?.get(spaceUriStr);
    if (!accountRepo) {
      throw new FakeXrpcError(400, "RepoNotFound", `Could not find repo for space: ${spaceUriStr}`);
    }
    const commit = this.commitForState(spaceUriStr, repo, accountRepo);

    const filtered = accountRepo.oplog.filter((op) => {
      if (since !== undefined && op.rev <= since) return false;
      if (cursor !== undefined && !(op.rev > cursor.rev || (op.rev === cursor.rev && op.idx > cursor.idx))) return false;
      return true;
    });
    const page = filtered.slice(0, limit);
    const ops = page.map((op) => {
      const live = accountRepo.collections.get(op.collection)?.get(op.rkey);
      const value = !excludeValues && op.cid !== null && live && live.cid.toString() === op.cid ? live.value : undefined;
      return {
        rev: op.rev,
        collection: op.collection,
        rkey: op.rkey,
        cid: op.cid,
        prev: op.prev,
        ...(value !== undefined ? { value } : {}),
      };
    });

    const nextCursor = ops.length === limit ? `${page[page.length - 1]!.rev}/${page[page.length - 1]!.idx}` : undefined;
    const headers = mac
      ? macHeaders(COMMIT_MAC_PROFILE, createCommitMacHeaders(commit, mac).headers)
      : { vary: "Accept-Signature" };
    return new WithHeaders(
      {
        ops,
        ...(nextCursor !== undefined ? { cursor: nextCursor } : {}),
        commit: commitJson(commit),
      },
      headers,
    );
  }

  private async listWriters(params: Record<string, unknown>, auth: FakeAuth) {
    const ref = this.requireSpaceRef(params.space);
    await this.requireCredential(params, auth, ref.authorityDid);
    this.assertActiveSpaceHost(ref.authorityDid);
    const space = this.requireActiveSpace(params.space);
    const limit = clampLimit(params.limit, 100, 1000);
    const after = typeof params.cursor === "string" && params.cursor.length > 0 ? params.cursor : undefined;
    const updated = [...space.writers.entries()]
      .filter(([, entry]) => after === undefined || entry.spaceRev > after)
      .sort((left, right) => compareLex(left[1].spaceRev, right[1].spaceRev));
    const page = updated.slice(0, limit);
    const repos = page.map(([repo, entry]) =>
      entry.removed
        ? {
            $type: "com.atproto.space.defs#repoRemoved",
            repo,
            spaceRev: entry.spaceRev,
          }
        : {
            $type: "com.atproto.space.defs#repoWrite",
            repo,
            repoRev: entry.repoRev,
            spaceRev: entry.spaceRev,
            data: { $bytes: toBase64(entry.data) },
          });
    return {
      repos,
      ...(page.length > 0 ? { cursor: page[page.length - 1]![1].spaceRev } : {}),
    };
  }

  private nextRev(): string {
    return fakeTid(++this.revCounter);
  }

  private currentlyAuthorizedSyncWriter(space: FakeSpace, did: string): boolean {
    if (did === space.ownerDid) return true;
    if (space.policy.$type === PERSONALSPACE_POLICY) return false;
    if (space.policy.$type === MEMBERSPACE_POLICY) {
      const member = space.members.get(did);
      if (member) return member.write;
      return space.policy.publicWrite;
    }
    if (space.policy.$type === ATGRP_POLICY) {
      const state = this.loadFakeGovernanceState(space.ownerDid);
      return liveRoleGrantsAccess(state, spaceUri(space), did, space.ownerDid, "write");
    }
    return false;
  }

  // =========================================================================
  // OpenSocial Group Host Parity Methods
  // =========================================================================

  private loadFakeGovernanceState(groupDid: string): GovernanceSnapshot {
    const groupState = this.groups.get(groupDid);
    const membersSpace = groupMembersUri(groupDid);
    const flockWsSpace = workspaceUri(groupDid);

    const spacePolicies = new Map<string, GroupAtgrpPolicy>();
    let hasFlockWorkspace = false;
    for (const [uri, sp] of this.spaces) {
      if (sp.ownerDid !== groupDid || sp.deleted) continue;
      if (uri === flockWsSpace) hasFlockWorkspace = true;
      if (sp.policy.$type === ATGRP_POLICY) {
        spacePolicies.set(uri, {
          $type: ATGRP_POLICY,
          publicRead: sp.policy.publicRead,
          unlisted: sp.policy.unlisted === true,
          grants: (sp.policy.grants ?? []).map((g) => ({ ...g })),
        });
      }
    }

    const roles = new Map<string, GroupRoleRecord>();
    const membersRepo = this.accountRepos.get(groupDid)?.get(membersSpace);
    for (const [rkey, entry] of membersRepo?.collections.get(ATGRP_COLLECTION.role) ?? []) {
      roles.set(rkey, entry.value as unknown as GroupRoleRecord);
    }

    const memberships = new Map<string, GroupMembershipRecord>();
    for (const [rkey, entry] of membersRepo?.collections.get(ATGRP_COLLECTION.membership) ?? []) {
      memberships.set(rkey, entry.value as unknown as GroupMembershipRecord);
    }

    const knownAppSubjects = new Set<string>(groupState?.knownAppSubjects ?? []);
    const allAppInstalls = new Map<string, { subject: string; active: boolean; channels: Array<{ skey: string; write: boolean }> }>();
    const activeAppInstalls = new Map<string, { subject: string; active: boolean; channels: Array<{ skey: string; write: boolean }> }>();
    if (hasFlockWorkspace) {
      const wsRepo = this.accountRepos.get(groupDid)?.get(flockWsSpace);
      for (const [, entry] of wsRepo?.collections.get(COLLECTION.appInstall) ?? []) {
        const val = entry.value as { subject: string; active: boolean; channels?: Array<{ skey: string; write: boolean }> };
        const snap = {
          subject: val.subject,
          active: val.active === true,
          channels: Array.isArray(val.channels) ? val.channels : [],
        };
        knownAppSubjects.add(snap.subject);
        allAppInstalls.set(snap.subject, snap);
        if (snap.active) activeAppInstalls.set(snap.subject, snap);
      }
    }

    return {
      roles,
      memberships,
      spacePolicies,
      knownAppSubjects,
      allAppInstalls,
      activeAppInstalls,
      hasFlockWorkspace,
    };
  }

  private effectiveFakeStateForAuth(groupDid: string, auth: FakeAuth): GovernanceSnapshot {
    const live = this.loadFakeGovernanceState(groupDid);
    const grp = this.groups.get(groupDid);
    if (
      auth.kind === "self" &&
      auth.sessionKind === "recovery" &&
      auth.authorizingUserDid &&
      grp?.recoveryAdmin &&
      grp.recoveryAdmin.recoveryDid === auth.authorizingUserDid &&
      live.memberships.size === 0
    ) {
      const cloned = new Map(live.memberships);
      cloned.set(grp.recoveryAdmin.recoveryDid, {
        roles: grp.recoveryAdmin.roles,
        createdAt: new Date(grp.recoveryAdmin.deactivatedAt).toISOString(),
      });
      return { ...live, memberships: cloned };
    }
    return live;
  }

  private narrowedGroupSessionPerms(
    auth: FakeAuth,
    groupDid: string,
  ): { actorDid: string; approved: ScopePermissions; live: ScopePermissions } {
    if (auth.kind !== "self" || auth.did !== groupDid) {
      throw new FakeXrpcError(401, "AuthMissing", "Group session required");
    }
    if (!auth.authorizingUserDid || auth.authorizingUserDid === groupDid) {
      const effState = this.effectiveFakeStateForAuth(groupDid, auth);
      const approved = expandGroupScopes(auth.approvedScopes ?? groupAdminScopes(groupDid), groupDid);
      const live = effectiveMemberPermissions(effState, groupDid, groupDid);
      return { actorDid: groupDid, approved: approved, live };
    }
    const effState = this.effectiveFakeStateForAuth(groupDid, auth);
    if (!effState.memberships.has(auth.authorizingUserDid)) {
      throw new FakeXrpcError(403, "ScopeMissingError", "Authorizing user is no longer an active group member");
    }
    const approved = expandGroupScopes(auth.approvedScopes ?? groupAdminScopes(groupDid), groupDid);
    const live = effectiveMemberPermissions(effState, groupDid, auth.authorizingUserDid);
    return { actorDid: auth.authorizingUserDid, approved, live };
  }

  private requireGroupSpaceManagePerm(
    auth: FakeAuth,
    groupDid: string,
    spaceType: string,
    skey: string,
    manage: "create" | "update" | "delete",
  ): string {
    const { actorDid, approved, live } = this.narrowedGroupSessionPerms(auth, groupDid);
    const ref = { spaceType: spaceType as NsidString, authority: groupDid as DidString, skey: skey as RecordKeyString };
    if (!approved.allowsSpace(ref, { manage }) || !live.allowsSpace(ref, { manage })) {
      throw new FakeXrpcError(403, "ScopeMissingError", `Missing space manage=${manage} permission for ${spaceType}/${skey}`);
    }
    return actorDid;
  }

  private requireGroupSpaceActionPerm(
    auth: FakeAuth,
    groupDid: string,
    spaceType: string,
    skey: string,
    action: "read" | "read_self",
    authorityDid: string = groupDid,
  ): string {
    const { actorDid, approved, live } = this.narrowedGroupSessionPerms(auth, groupDid);
    const ref = { spaceType: spaceType as NsidString, authority: authorityDid as DidString, skey: skey as RecordKeyString };
    if (!approved.allowsSpace(ref, { action }) || !live.allowsSpace(ref, { action })) {
      throw new FakeXrpcError(403, "ScopeMissingError", `Missing space action=${action} permission for ${spaceType}/${skey}`);
    }
    return actorDid;
  }

  private requireGroupReadSelfPerm(auth: FakeAuth, groupDid: string): string {
    const { actorDid, approved, live } = this.narrowedGroupSessionPerms(auth, groupDid);
    const ref = { spaceType: "*" as const, authority: "*" as const, skey: "*" as const };
    if (!approved.allowsSpace(ref, { action: "read_self" }) || !live.allowsSpace(ref, { action: "read_self" })) {
      throw new FakeXrpcError(403, "ScopeMissingError", "Missing space read_self permission");
    }
    return actorDid;
  }

  private requireGroupSpaceRecordPerm(
    auth: FakeAuth,
    groupDid: string,
    spaceUriStr: string,
    collection: string,
    action: "create" | "update" | "delete",
  ): string {
    const parsed = this.requireSpaceRef(spaceUriStr);
    const { actorDid, approved, live } = this.narrowedGroupSessionPerms(auth, groupDid);
    const ref = {
      spaceType: parsed.type as NsidString,
      authority: parsed.authorityDid as DidString,
      skey: parsed.skey as RecordKeyString,
    };
    const col = collection as NsidString | "*";
    if (!approved.allowsSpace(ref, { action, collection: col }) || !live.allowsSpace(ref, { action, collection: col })) {
      throw new FakeXrpcError(403, "ScopeMissingError", `Missing space record ${action} permission on ${collection}`);
    }
    return actorDid;
  }

  private requireGroupPublicRepoPerm(
    auth: FakeAuth,
    groupDid: string,
    collection: string,
    action: "create" | "update" | "delete",
  ): string {
    const { actorDid, approved, live } = this.narrowedGroupSessionPerms(auth, groupDid);
    const col = collection as NsidString | "*";
    if (!approved.allowsRepo({ collection: col, action }) || !live.allowsRepo({ collection: col, action })) {
      throw new FakeXrpcError(403, "ScopeMissingError", `Missing public repo ${action} permission on ${collection}`);
    }
    return actorDid;
  }

  private requireGroupRpcPerm(auth: FakeAuth, groupDid: string, aud: string, lxm: string): string {
    const { actorDid, approved, live } = this.narrowedGroupSessionPerms(auth, groupDid);
    const audParam = (aud === "*" ? "did:plc:zzzzzzzzzzzzzzzzzzzzzzzz#atproto_pds" : aud.includes("#") ? aud : `${aud}#atproto_pds`) as `${DidString}#${string}`;
    const lxmParam = (lxm === "*" ? "com.atproto.probe.wildcard" : lxm) as NsidString;
    if (!approved.allowsRpc({ aud: audParam, lxm: lxmParam }) || !live.allowsRpc({ aud: audParam, lxm: lxmParam })) {
      throw new FakeXrpcError(403, "ScopeMissingError", `Missing RPC permission for ${lxm}`);
    }
    return actorDid;
  }

  private collectSpaceBlobCids(repo: string, spaceUriStr: string): string[] {
    const cids = new Set<string>();
    const accountRepo = this.accountRepos.get(repo)?.get(spaceUriStr);
    for (const entries of accountRepo?.collections.values() ?? []) {
      for (const entry of entries.values()) {
        for (const blobRef of enumBlobRefs(plainJsonToLexDataLocal(entry.value) as LexValue)) {
          cids.add(blobRefCidString(blobRef));
        }
      }
    }
    return [...cids].sort(compareLex);
  }

  private collectAllGroupBlobCids(groupDid: string): Map<string, string> {
    const map = new Map<string, string>();
    for (const [key, entry] of this.publicRecords.get(groupDid)?.entries() ?? []) {
      const uri = `at://${groupDid}/${key}`;
      for (const blobRef of enumBlobRefs(plainJsonToLexDataLocal(entry.value) as LexValue)) {
        const cid = blobRefCidString(blobRef);
        if (!map.has(cid)) map.set(cid, uri);
      }
    }
    for (const [spUri, accountRepo] of this.accountRepos.get(groupDid)?.entries() ?? []) {
      for (const [col, entries] of accountRepo.collections) {
        for (const [rkey, entry] of entries) {
          const uri = `${spUri}/${groupDid}/${col}/${rkey}`;
          for (const blobRef of enumBlobRefs(plainJsonToLexDataLocal(entry.value) as LexValue)) {
            const cid = blobRefCidString(blobRef);
            if (!map.has(cid)) map.set(cid, uri);
          }
        }
      }
    }
    return map;
  }

  private revokeGroupCredentialsForSpace(
    groupDid: string,
    spaceUriStr: string | undefined,
    onlyGranteeDid: string | undefined,
    deliveries: Promise<void>[],
  ): void {
    const nowSec = Math.floor(this.now() / 1000);
    const bySpaceAndWriter = new Map<string, { space: string; writerDid: string; jtis: Set<string> }>();
    for (const [, cred] of this.credentials) {
      const parsed = parseSpaceUri(cred.space);
      if (!parsed || parsed.authorityDid !== groupDid) continue;
      if (spaceUriStr !== undefined && cred.space !== spaceUriStr) continue;
      if (onlyGranteeDid !== undefined && cred.grantedDid !== onlyGranteeDid) continue;
      if (cred.exp <= nowSec) continue;
      const revKey = `${cred.space}\u0000${cred.jti}`;
      if (this.revokedCredentials.has(revKey)) continue;
      this.revokedCredentials.add(revKey);

      const targets = new Set<string>();
      if (cred.grantedDid && cred.grantedDid !== groupDid) {
        targets.add(cred.grantedDid);
      }
      const sp = this.spaces.get(cred.space);
      if (sp) {
        for (const [writerDid, entry] of sp.writers) {
          if (writerDid !== groupDid && !entry.removed) {
            targets.add(writerDid);
          }
        }
      }

      for (const targetDid of targets) {
        const bKey = `${cred.space}\u0000${targetDid}`;
        let bucket = bySpaceAndWriter.get(bKey);
        if (!bucket) {
          bucket = { space: cred.space, writerDid: targetDid, jtis: new Set<string>() };
          bySpaceAndWriter.set(bKey, bucket);
        }
        bucket.jtis.add(cred.jti);
      }
    }

    for (const bucket of bySpaceAndWriter.values()) {
      const allJtis = [...bucket.jtis];
      for (let i = 0; i < allJtis.length; i += 100) {
        const chunk = allJtis.slice(i, i + 100);
        deliveries.push(this.deliverCredentialsRevokedToPeer(groupDid, bucket.writerDid, bucket.space, chunk));
      }
    }
  }

  private async deliverCredentialsRevokedToPeer(
    groupDid: string,
    writerDid: string,
    spaceUriStr: string,
    jtis: string[],
  ): Promise<void> {
    try {
      const pds = await this.resolvePds(writerDid);
      const serviceJwt = await this.signFakeServiceJwt({
        issDid: groupDid,
        aud: writerDid,
        lxm: "com.atproto.space.notifyCredentialsRevoked",
      });
      const targetUrl = `${normalizeBaseUrl(pds)}/xrpc/com.atproto.space.notifyCredentialsRevoked`;
      const init: RequestInit = {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${serviceJwt}`,
        },
        body: JSON.stringify({ space: spaceUriStr, credentials: jtis }),
      };
      if (this.hasOutboundHandler(targetUrl)) {
        await this.sendOutbound(targetUrl, init);
      } else {
        await this.fetchEndpoint(new Request(targetUrl, init));
      }
    } catch {
      // Best-effort revocation push
    }
  }

  private reconcileGroupSpaceWriters(
    groupDid: string,
    postState: GovernanceSnapshot,
    deliveries: Promise<void>[],
    suppressNotices = false,
  ): void {
    const grp = this.groups.get(groupDid);
    for (const [uri, space] of this.spaces) {
      if (space.ownerDid !== groupDid || space.deleted || space.policy.$type !== ATGRP_POLICY) continue;
      for (const [writerDid, entry] of space.writers) {
        if (writerDid === groupDid || entry.removed) continue;
        if (!liveRoleGrantsAccess(postState, uri, writerDid, groupDid, "write")) {
          if (uri === groupMembersUri(groupDid) && grp) {
            const prev = grp.priorEjectCounts.get(writerDid) ?? { count: 0, lastEvictedRepoRev: null };
            grp.priorEjectCounts.set(writerDid, { count: prev.count, lastEvictedRepoRev: entry.repoRev });
          }
          const removed = this.removeWriterEntry(space, writerDid);
          if (removed && !suppressNotices) {
            deliveries.push(this.deliverSpaceUpdate(space, removed));
          }
        }
      }

      // Also revoke issued credentials (including anonymous publicRead credentials!) whose grantee lost `read` access!
      const seenGrantees = new Set<string>();
      for (const cred of this.credentials.values()) {
        if (cred.space !== uri || cred.grantedDid === groupDid) continue;
        if (seenGrantees.has(cred.grantedDid)) continue;
        seenGrantees.add(cred.grantedDid);
        if (!liveRoleGrantsAccess(postState, uri, cred.grantedDid || undefined, groupDid, "read")) {
          this.revokeGroupCredentialsForSpace(groupDid, uri, cred.grantedDid, suppressNotices ? [] : deliveries);
        }
      }
    }
  }

  private async putGroupSpaceRecordInternal(
    groupDid: string,
    _actorDid: string,
    spaceUriStr: string,
    collection: string,
    rkey: string,
    record: Record<string, unknown>,
    deliveries: Promise<void>[],
    suppressNotices = false,
  ): Promise<{ uri: string; cid: string; rev: string }> {
    const grp = this.groups.get(groupDid);
    let recordValue: Record<string, unknown> = { $type: collection, ...record };
    let incarnation: string | undefined;

    const accountRepo = this.getOrCreateAccountRepo(groupDid, spaceUriStr);
    let col = accountRepo.collections.get(collection);
    if (!col) accountRepo.collections.set(collection, col = new Map());
    const prevEntry = col.get(rkey);

    if (spaceUriStr === groupMembersUri(groupDid) && collection === ATGRP_COLLECTION.membership) {
      if (!prevEntry) {
        const freshInc = typeof recordValue[FLOCK_EXTENSION_FIELD.incarnation] === "string"
          ? (recordValue[FLOCK_EXTENSION_FIELD.incarnation] as string)
          : randomUUID();
        const ejectMeta = grp?.priorEjectCounts.get(rkey) ?? { count: 0, lastEvictedRepoRev: null };
        const predictedSpaceRev = this.nextRev();
        recordValue = {
          ...recordValue,
          [FLOCK_EXTENSION_FIELD.incarnation]: freshInc,
          [FLOCK_EXTENSION_FIELD.generation]: ejectMeta.count + 1,
          [FLOCK_EXTENSION_FIELD.admittedSpaceRev]: predictedSpaceRev,
          [FLOCK_EXTENSION_FIELD.afterWriterRev]: ejectMeta.lastEvictedRepoRev,
        };
        incarnation = freshInc;
      } else {
        const preserved = prevEntry.incarnation ?? randomUUID();
        recordValue = {
          ...recordValue,
          [FLOCK_EXTENSION_FIELD.incarnation]: preserved,
          ...(prevEntry.value[FLOCK_EXTENSION_FIELD.generation] !== undefined
            ? { [FLOCK_EXTENSION_FIELD.generation]: prevEntry.value[FLOCK_EXTENSION_FIELD.generation] }
            : {}),
          ...(prevEntry.value[FLOCK_EXTENSION_FIELD.admittedSpaceRev] !== undefined
            ? { [FLOCK_EXTENSION_FIELD.admittedSpaceRev]: prevEntry.value[FLOCK_EXTENSION_FIELD.admittedSpaceRev] }
            : {}),
          ...(prevEntry.value[FLOCK_EXTENSION_FIELD.afterWriterRev] !== undefined
            ? { [FLOCK_EXTENSION_FIELD.afterWriterRev]: prevEntry.value[FLOCK_EXTENSION_FIELD.afterWriterRev] }
            : {}),
        };
        incarnation = preserved;
      }
    }

    const { cid } = await serializeRecord(
      collection as NsidString,
      rkey as RecordKeyString,
      plainJsonToLexDataLocal(recordValue) as LexMap,
    );
    col.set(rkey, { value: recordValue, cid, ...(incarnation !== undefined ? { incarnation } : {}) });
    const rev = this.nextRev();
    accountRepo.rev = rev;
    accountRepo.oplog.push({
      rev,
      idx: 0,
      collection,
      rkey,
      cid: cid.toString(),
      prev: prevEntry?.cid.toString() ?? null,
    });
    if (!suppressNotices) {
      this.recordWrite(spaceUriStr, groupDid, accountRepo, deliveries);
    } else {
      const space = this.spaces.get(spaceUriStr);
      if (space && !space.deleted) {
        const data = this.commitForState(spaceUriStr, groupDid, accountRepo).data;
        this.recordWriterEntry(space, groupDid, rev, data);
      }
    }
    return { uri: `${spaceUriStr}/${groupDid}/${collection}/${rkey}`, cid: cid.toString(), rev };
  }

  private async deleteGroupSpaceRecordInternal(
    groupDid: string,
    spaceUriStr: string,
    collection: string,
    rkey: string,
    deliveries: Promise<void>[],
    suppressNotices = false,
  ): Promise<{ rev: string }> {
    const accountRepo = this.accountRepos.get(groupDid)?.get(spaceUriStr);
    const col = accountRepo?.collections.get(collection);
    const prevEntry = col?.get(rkey);
    const rev = this.nextRev();
    if (accountRepo && prevEntry) {
      col!.delete(rkey);
      accountRepo.rev = rev;
      accountRepo.oplog.push({
        rev,
        idx: 0,
        collection,
        rkey,
        cid: null,
        prev: prevEntry.cid.toString(),
      });
      if (!suppressNotices) {
        this.recordWrite(spaceUriStr, groupDid, accountRepo, deliveries);
      } else {
        const space = this.spaces.get(spaceUriStr);
        if (space && !space.deleted) {
          const data = this.commitForState(spaceUriStr, groupDid, accountRepo).data;
          this.recordWriterEntry(space, groupDid, rev, data);
        }
      }
    }
    return { rev };
  }

  private async applyGroupSpaceWrites(params: {
    groupDid: string;
    actorDid: string;
    spaceUri: string;
    writes: ReadonlyArray<{
      action: "create" | "update" | "delete";
      collection: string;
      rkey?: string;
      value?: Record<string, unknown>;
      swapRecord?: string | null;
      validate?: boolean;
    }>;
    isPutRecord?: boolean;
    putSwapRecord?: string | null;
    ifJoinRequestPresent?: boolean;
    deliveries: Promise<void>[];
  }): Promise<{ commit: { rev: string }; results: Array<{ uri: string; cid?: string; $type?: string; validationStatus?: string }> }> {
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const grp = this.groups.get(params.groupDid)!;
    const parsedSpace = parseSpaceUri(params.spaceUri);
    if (!parsedSpace) throw new FakeXrpcError(400, "InvalidRequest", `Invalid space URI: ${params.spaceUri}`);
    const isOwnSpace = parsedSpace.authorityDid === params.groupDid;
    const keyCheck = validateSpaceTypeKey(parsedSpace.type, parsedSpace.skey, { isGroupHostOwnSpace: isOwnSpace });
    if (!keyCheck.valid) throw new FakeXrpcError(400, keyCheck.code ?? "InvalidSpaceKey", keyCheck.reason);
    if (!isOwnSpace && parsedSpace.type !== ATGRP_SPACE_TYPE.inbox) {
      throw new FakeXrpcError(400, "InvalidRequest", "Group can only write to own spaces or external org.atgrp.inbox/self");
    }

    return this.withRepoLock(params.spaceUri, params.groupDid, async () => {
      this.assertNoActiveFakeMigrationLease(grp);
      if (isOwnSpace) {
        const sp = this.spaces.get(params.spaceUri);
        if (!sp) throw new FakeXrpcError(400, "SpaceNotFound", "Space not found");
        if (sp.deleted) throw new FakeXrpcError(400, "SpaceDeleted", "Space deleted");
      }

      this.pruneFakeExpiredJoinState(grp, nowMs);
      const preState = this.loadFakeGovernanceState(params.groupDid);
      const membersSpace = groupMembersUri(params.groupDid);

      const postRoles = new Map(preState.roles);
      const postMemberships = new Map(preState.memberships);
      const postAllApps = new Map(preState.allAppInstalls);
      const postActiveApps = new Map(preState.activeAppInstalls);
      const postKnownApps = new Set(preState.knownAppSubjects);
      const deletedRoles = new Set<string>();
      const roleWrites: Array<{ rkey: string; role: GroupRoleRecord }> = [];
      const membershipDiffs: Array<{ prevRoles?: readonly string[]; nextRoles: readonly string[] }> = [];

      const accountRepo = this.getOrCreateAccountRepo(params.groupDid, params.spaceUri);
      const staged = new Map<string, Map<string, RecordEntry>>();
      for (const [col, entries] of accountRepo.collections) staged.set(col, new Map(entries));

      const prepared: Array<{
        action: "create" | "update" | "delete";
        collection: string;
        rkey: string;
        uri: string;
        cid?: Awaited<ReturnType<typeof serializeRecord>>["cid"];
        value?: Record<string, unknown>;
        incarnation?: string;
        prevEntry?: RecordEntry;
      }> = [];

      for (const w of params.writes) {
        if (w.collection === ATPROTO_SPACE_COLLECTION.spacePolicy) {
          throw new FakeXrpcError(400, "InvalidRequest", "com.atproto.space.policy is host-published via createSpace/updateSpace");
        }
        if (w.collection === ATGRP_COLLECTION.space) {
          throw new FakeXrpcError(400, "IndexHostMaintained", "org.atgrp.space is host-maintained");
        }
        if (!isOwnSpace && w.collection !== ATGRP_COLLECTION.invite) {
          throw new FakeXrpcError(
            400,
            "InvalidRequest",
            "External org.atgrp.inbox/self spaces only accept org.atgrp.invite records",
          );
        }

        const rkey = w.action === "create" ? (w.rkey ?? this.nextRev()) : String(w.rkey ?? "");
        if (!isRecordKey(rkey)) throw new FakeXrpcError(400, "InvalidRequest", `Invalid record key: ${rkey}`);
        const uri = `${params.spaceUri}/${params.groupDid}/${w.collection}/${rkey}`;
        let colMap = staged.get(w.collection);
        if (!colMap) staged.set(w.collection, colMap = new Map());
        const existing = colMap.get(rkey);

        if (w.action === "delete") {
          if (w.swapRecord !== undefined && w.swapRecord !== null && existing?.cid.toString() !== w.swapRecord) {
            throw new FakeXrpcError(400, "InvalidSwap", "swapRecord CID mismatch on delete");
          }
          if (!params.isPutRecord && !existing) {
            throw new FakeXrpcError(400, "RecordNotFound", `Record not found: ${w.collection}/${rkey}`);
          }
          if (params.spaceUri === membersSpace && w.collection === ATGRP_COLLECTION.role) {
            postRoles.delete(rkey);
            deletedRoles.add(rkey);
          } else if (params.spaceUri === membersSpace && w.collection === ATGRP_COLLECTION.membership) {
            if (existing) {
              membershipDiffs.push({ prevRoles: (existing.value.roles as string[]) ?? [], nextRoles: [] });
            }
            postMemberships.delete(rkey);
          } else if (params.spaceUri === workspaceUri(params.groupDid) && w.collection === COLLECTION.appInstall) {
            if (existing?.value.subject) {
              postAllApps.delete(String(existing.value.subject));
              postActiveApps.delete(String(existing.value.subject));
            }
          }
          colMap.delete(rkey);
          prepared.push({ action: "delete", collection: w.collection, rkey, uri, prevEntry: existing });
          continue;
        }

        if (w.action === "create" && existing) {
          throw new FakeXrpcError(400, "InvalidSwap", `Space record already exists: ${w.collection}/${rkey}`);
        }
        if (params.isPutRecord) {
          if (params.putSwapRecord === null && existing) {
            throw new FakeXrpcError(400, "InvalidSwap", "Expected absent space record for swapRecord: null");
          }
          if (typeof params.putSwapRecord === "string" && (!existing || existing.cid.toString() !== params.putSwapRecord)) {
            throw new FakeXrpcError(400, "InvalidSwap", "swapRecord CID mismatch");
          }
        } else if (w.action === "update" && !existing) {
          throw new FakeXrpcError(400, "InvalidSwap", `Cannot update absent space record: ${w.collection}/${rkey}`);
        }

        let recordValue: Record<string, unknown> = { $type: w.collection, ...(w.value ?? {}) };
        let incarnation: string | undefined;

        if (params.spaceUri === membersSpace && w.collection === ATGRP_COLLECTION.membership) {
          const callerExt = decodeFlockMembershipExtensions(recordValue);
          if (!callerExt.valid) {
            throw new FakeXrpcError(400, callerExt.code, callerExt.reason);
          }
          if (!existing) {
            const freshInc = randomUUID();
            const ejectMeta = grp.priorEjectCounts.get(rkey) ?? { count: 0, lastEvictedRepoRev: null };
            recordValue = {
              ...recordValue,
              [FLOCK_EXTENSION_FIELD.incarnation]: freshInc,
              [FLOCK_EXTENSION_FIELD.generation]: ejectMeta.count + 1,
              [FLOCK_EXTENSION_FIELD.admittedSpaceRev]: this.nextRev(),
              [FLOCK_EXTENSION_FIELD.afterWriterRev]: ejectMeta.lastEvictedRepoRev,
            };
            incarnation = freshInc;
          } else {
            const preserved = existing.incarnation ?? randomUUID();
            recordValue = {
              ...recordValue,
              [FLOCK_EXTENSION_FIELD.incarnation]: preserved,
              ...(existing.value[FLOCK_EXTENSION_FIELD.generation] !== undefined
                ? { [FLOCK_EXTENSION_FIELD.generation]: existing.value[FLOCK_EXTENSION_FIELD.generation] }
                : {}),
              ...(existing.value[FLOCK_EXTENSION_FIELD.admittedSpaceRev] !== undefined
                ? { [FLOCK_EXTENSION_FIELD.admittedSpaceRev]: existing.value[FLOCK_EXTENSION_FIELD.admittedSpaceRev] }
                : {}),
              ...(existing.value[FLOCK_EXTENSION_FIELD.afterWriterRev] !== undefined
                ? { [FLOCK_EXTENSION_FIELD.afterWriterRev]: existing.value[FLOCK_EXTENSION_FIELD.afterWriterRev] }
                : {}),
            };
            incarnation = preserved;
          }
        }

        const mustValidate =
          !isOwnSpace ||
          w.validate !== false ||
          MANDATORY_VALIDATED_SPACE_COLLECTIONS.has(w.collection) ||
          w.collection.startsWith(`${ATGRP_NAMESPACE}.`);
        if (mustValidate) {
          const check = validateSpaceRecord(w.collection, recordValue, {
            authorityDid: parsedSpace.authorityDid,
            spaceUri: params.spaceUri,
            repoDid: params.groupDid,
            rkey,
          });
          if (
            !check.valid &&
            (!isOwnSpace ||
              check.reason !== "unknown collection" ||
              MANDATORY_VALIDATED_SPACE_COLLECTIONS.has(w.collection) ||
              w.collection.startsWith(`${ATGRP_NAMESPACE}.`))
          ) {
            throw new FakeXrpcError(400, check.code ?? "InvalidRequest", check.reason);
          }
        }

        if (params.spaceUri === membersSpace && w.collection === ATGRP_COLLECTION.role) {
          const nextRole = recordValue as unknown as GroupRoleRecord;
          roleWrites.push({ rkey, role: nextRole });
          postRoles.set(rkey, nextRole);
        } else if (params.spaceUri === membersSpace && w.collection === ATGRP_COLLECTION.membership) {
          const prevRoles = existing ? ((existing.value.roles as string[]) ?? []) : undefined;
          const nextRoles = recordValue.roles as string[];
          membershipDiffs.push({ ...(prevRoles !== undefined ? { prevRoles } : {}), nextRoles });
          postMemberships.set(rkey, { ...recordValue, roles: nextRoles, createdAt: String(recordValue.createdAt) });
        } else if (params.spaceUri === workspaceUri(params.groupDid) && w.collection === COLLECTION.appInstall) {
          const subj = String(recordValue.subject);
          const snap = {
            subject: subj,
            active: recordValue.active === true,
            channels: Array.isArray(recordValue.channels)
              ? (recordValue.channels as Array<{ skey: string; write: boolean }>)
              : [],
          };
          postKnownApps.add(subj);
          postAllApps.set(subj, snap);
          if (snap.active) postActiveApps.set(subj, snap);
          else postActiveApps.delete(subj);
        }

        if (params.ifJoinRequestPresent && params.spaceUri === membersSpace && w.collection === ATGRP_COLLECTION.membership) {
          if (!grp.joinRequests.has(rkey)) {
            throw new FakeXrpcError(409, "JoinRequestNotFound", `No active join request found for ${rkey}`);
          }
        }

        const { cid } = await serializeRecord(
          w.collection as NsidString,
          rkey as RecordKeyString,
          plainJsonToLexDataLocal(recordValue) as LexMap,
        );
        colMap.set(rkey, { value: recordValue, cid, ...(incarnation !== undefined ? { incarnation } : {}) });
        prepared.push({
          action: existing ? "update" : "create",
          collection: w.collection,
          rkey,
          uri,
          cid,
          value: recordValue,
          ...(incarnation !== undefined ? { incarnation } : {}),
          prevEntry: existing,
        });
      }

      checkRoleAndAssignmentEscalation({
        actorDid: params.actorDid,
        preState,
        groupDid: params.groupDid,
        roleWrites,
        roleDeletes: [...deletedRoles],
        membershipDiffs,
        ErrorCtor: FakeXrpcError,
      });

      const postState: GovernanceSnapshot = {
        ...preState,
        roles: postRoles,
        memberships: postMemberships,
        knownAppSubjects: postKnownApps,
        allAppInstalls: postAllApps,
        activeAppInstalls: postActiveApps,
      };
      checkPostGovernanceInvariants(preState, postState, params.groupDid, { deletedRoles }, FakeXrpcError);

      if (!postState.hasFlockWorkspace) {
        const postHumans = [...postState.memberships.keys()].filter(
          (d) => d !== params.groupDid && !postState.knownAppSubjects.has(d),
        );
        if (postHumans.length === 0 && !grp.recoveryAdmin && grp.sovereignRotationKeys.size === 0) {
          throw new FakeXrpcError(
            400,
            "NoSovereignCustodyKey",
            "Cannot remove the last human member without an external sovereign PLC rotation key.",
          );
        }
      }

      const rev = this.nextRev();
      const ops: FakeRepoOp[] = [];
      const results: Array<{ uri: string; cid?: string; $type?: string; validationStatus?: string }> = [];

      for (const p of prepared) {
        if (p.action === "delete") {
          if (p.prevEntry) {
            ops.push({
              rev,
              idx: ops.length,
              collection: p.collection,
              rkey: p.rkey,
              cid: null,
              prev: p.prevEntry.cid.toString(),
            });
          }
          results.push({ uri: p.uri, $type: "com.atproto.space.applyWrites#deleteResult" });
        } else {
          ops.push({
            rev,
            idx: ops.length,
            collection: p.collection,
            rkey: p.rkey,
            cid: p.cid!.toString(),
            prev: p.prevEntry?.cid.toString() ?? null,
          });
          results.push({
            uri: p.uri,
            cid: p.cid!.toString(),
            $type: `com.atproto.space.applyWrites#${p.action}Result`,
            validationStatus: "valid",
          });
        }
      }

      accountRepo.collections = staged;
      if (ops.length > 0) {
        accountRepo.rev = rev;
        accountRepo.oplog.push(...ops);
      }

      // Side-effects
      for (const p of prepared) {
        if (params.spaceUri === workspaceUri(params.groupDid) && p.collection === COLLECTION.appInstall && p.value) {
          grp.knownAppSubjects.add(String(p.value.subject));
        }

        if (params.spaceUri === membersSpace && p.collection === ATGRP_COLLECTION.membership) {
          if (p.action !== "delete" && p.cid) {
            grp.joinRequests.delete(p.rkey);
            grp.modEjectionEligibility.delete(p.rkey);
            const admittedResp = JSON.stringify({
              status: "admitted",
              membership: { uri: p.uri, cid: p.cid.toString() },
            });
            for (const opRow of grp.joinOperations.values()) {
              if (opRow.requesterDid === p.rkey && opRow.state === "pending") {
                opRow.state = "admitted";
                opRow.responseJson = admittedResp;
                opRow.updatedAt = nowMs;
              }
            }
          } else if (p.action === "delete" && p.prevEntry) {
            const membersSp = this.spaces.get(membersSpace);
            const writerEntry = membersSp?.writers.get(p.rkey);
            const lastRev = writerEntry ? (writerEntry.removed ? writerEntry.lastRepoRev : writerEntry.repoRev) : null;
            const prevEject = grp.priorEjectCounts.get(p.rkey) ?? { count: 0, lastEvictedRepoRev: null };
            grp.priorEjectCounts.set(p.rkey, { count: prevEject.count + 1, lastEvictedRepoRev: lastRev ?? prevEject.lastEvictedRepoRev });
            if (membersSp) {
              const removed = this.removeWriterEntry(membersSp, p.rkey);
              if (removed) params.deliveries.push(this.deliverSpaceUpdate(membersSp, removed));
            }
            grp.modEjectionEligibility.set(p.rkey, nowIso);
            const modKey = `${p.rkey}\u0000`;
            const modSubj = grp.modSubjects.get(modKey);
            if (modSubj) {
              modSubj.updatedAt = nowIso;
            }
            const seq = grp.nextModSeq++;
            grp.modEvents.push({
              seq,
              eventId: `ev-${sha256Hex(`${params.groupDid}\u0000${seq}`).slice(0, 20)}`,
              subject: p.rkey,
              cidKey: "",
              subjectOwnerDid: p.rkey,
              isSelfVisible: true,
              createdAt: nowIso,
              createdBy: params.actorDid,
              event: { $type: ATGRP_MOD_EVENT_TYPE.eject },
            });
          }
        }

        if (isOwnSpace && p.collection === ATPROTO_SPACE_COLLECTION.label) {
          const labelVal = p.action === "delete" ? p.prevEntry?.value : p.value;
          if (labelVal && typeof labelVal.uri === "string" && typeof labelVal.val === "string") {
            const cidKey = typeof labelVal.cid === "string" ? labelVal.cid : "";
            const modKey = `${labelVal.uri}\u0000${cidKey}`;
            const existingMod = grp.modSubjects.get(modKey);
            if (!existingMod) {
              grp.modSubjects.set(modKey, {
                subject: labelVal.uri,
                cidKey,
                status: "open",
                reportCount: 0,
                tags: new Set(),
                createdAt: nowIso,
                updatedAt: nowIso,
              });
            } else {
              existingMod.updatedAt = nowIso;
            }
            const parsedOwner = isDid(labelVal.uri) ? labelVal.uri : parseAnySpaceRecordUri(labelVal.uri)?.repoDid ?? params.groupDid;
            const seq = grp.nextModSeq++;
            grp.modEvents.push({
              seq,
              eventId: `ev-${sha256Hex(`${params.groupDid}\u0000${seq}`).slice(0, 20)}`,
              subject: labelVal.uri,
              cidKey,
              subjectOwnerDid: parsedOwner,
              isSelfVisible: true,
              createdAt: nowIso,
              createdBy: params.actorDid,
              event: {
                $type: ATGRP_MOD_EVENT_TYPE.label,
                uri: p.uri,
                val: labelVal.val,
                ...(p.action === "delete" ? { deleted: true } : {}),
              },
            });
          }
        }

        if (!isOwnSpace && parsedSpace.type === ATGRP_SPACE_TYPE.inbox && p.collection === ATGRP_COLLECTION.invite) {
          const inviteeDid = parsedSpace.authorityDid;
          if (p.action === "delete") {
            grp.inviteDeliveries.delete(p.uri);
          } else {
            const delivStatus = this.deliverFakeInviteToSpace(params.groupDid, inviteeDid, params.spaceUri, accountRepo, params.deliveries);
            grp.inviteDeliveries.set(p.uri, {
              inviteUri: p.uri,
              spaceUri: params.spaceUri,
              inviteeDid,
              rkey: p.rkey,
              repoRev: accountRepo.rev,
              status: delivStatus.status,
              attempts: 1,
              lastError: delivStatus.error ?? null,
              createdAt: nowMs,
              updatedAt: nowMs,
            });
          }
        }
      }

      if (isOwnSpace && ops.length > 0) {
        this.recordWrite(params.spaceUri, params.groupDid, accountRepo, params.deliveries);
      } else if (!isOwnSpace && ops.length > 0) {
        this.deliverFakeInviteToSpace(params.groupDid, parsedSpace.authorityDid, params.spaceUri, accountRepo, params.deliveries);
      }

      this.reconcileGroupSpaceWriters(params.groupDid, postState, params.deliveries);
      return { commit: { rev: accountRepo.rev }, results };
    });
  }

  private deliverFakeInviteToSpace(
    groupDid: string,
    inviteeDid: string,
    inviteSpaceUri: string,
    accountRepo: FakeAccountRepo,
    deliveries: Promise<void>[],
  ): { status: "delivered" | "failed"; error?: string } {
    if (this.unreachable.has(inviteeDid) || !this.accounts.has(inviteeDid)) {
      return { status: "failed", error: "Invitee PDS unreachable" };
    }
    const targetSpace = this.spaces.get(inviteSpaceUri);
    if (!targetSpace || targetSpace.deleted) {
      return { status: "failed", error: "SpaceNotFound: invites/self not yet provisioned" };
    }
    if (!this.currentlyAuthorizedSyncWriter(targetSpace, groupDid)) {
      return { status: "failed", error: "NotAuthorized" };
    }
    const data = this.commitForState(inviteSpaceUri, groupDid, accountRepo).data;
    const update = this.recordWriterEntry(targetSpace, groupDid, accountRepo.rev, data);
    if (update) deliveries.push(this.deliverSpaceUpdate(targetSpace, update));
    return { status: "delivered" };
  }

  private pruneFakeExpiredJoinState(grp: FakeGroupState, nowMs: number): void {
    for (const [k, row] of grp.joinRequests) {
      if (row.expiresAt <= nowMs) grp.joinRequests.delete(k);
    }
    for (const [k, row] of grp.joinOperations) {
      if (row.expiresAt <= nowMs) grp.joinOperations.delete(k);
    }
  }

  private async verifyFakePersonalServiceJwt(
    auth: FakeAuth,
    groupDid: string,
    expectedLxm: string,
  ): Promise<string> {
    if (auth.kind === "none") throw new FakeXrpcError(401, "AuthMissing", "Personal service JWT Bearer authorization required");
    if (auth.kind === "rejected") throw auth.error;
    // Allow direct `clientFor(personalDid)` convenience in unit tests when `did !== groupDid`
    if (auth.kind === "self") {
      if (auth.did === groupDid) {
        throw new FakeXrpcError(400, "CannotTargetGroupSelf", `${expectedLxm} acts strictly as a personal account`);
      }
      return auth.did;
    }
    if (auth.kind !== "raw-token" || auth.scheme !== "bearer" || !auth.token) {
      throw new FakeXrpcError(401, "InvalidToken", "Bearer service JWT required");
    }
    const nowSec = Math.floor(this.now() / 1000);
    const raw = auth.token;
    if (raw.startsWith("fake-service-token.")) {
      let decoded: { iss?: string; aud?: string; lxm?: string | null; iat?: number; exp?: number; jti?: string };
      try {
        decoded = JSON.parse(atob(raw.slice("fake-service-token.".length))) as typeof decoded;
      } catch {
        throw new FakeXrpcError(401, "InvalidToken", "Malformed fake service token");
      }
      const iss = decoded.iss?.split("#", 1)[0] ?? "";
      if (!isDid(iss)) throw new FakeXrpcError(401, "InvalidToken", "Invalid service JWT iss");
      if (iss === groupDid) throw new FakeXrpcError(400, "CannotTargetGroupSelf", "Group DID cannot target self");
      if (decoded.lxm !== expectedLxm) throw new FakeXrpcError(401, "InvalidToken", `Expected lxm ${expectedLxm}`);
      if (decoded.aud !== groupDid && decoded.aud !== `${groupDid}#atproto_pds`) {
        throw new FakeXrpcError(401, "InvalidToken", "Audience mismatch");
      }
      const iat = decoded.iat ?? (decoded.exp !== undefined ? decoded.exp - 60 : nowSec);
      if (
        decoded.exp === undefined ||
        iat > nowSec + 5 ||
        decoded.exp <= nowSec ||
        decoded.exp <= iat ||
        decoded.exp - iat > 75 ||
        nowSec - iat > 75
      ) {
        throw new FakeXrpcError(401, "ExpiredToken", "Service JWT expired or outside 75s window");
      }
      if (decoded.jti) {
        const rk = `svc\u0000${iss}\u0000${decoded.jti}`;
        if (this.usedServiceJtis.has(rk)) {
          throw new FakeXrpcError(401, "ReplayDetected", "Service JWT jti already consumed");
        }
        this.usedServiceJtis.add(rk);
      }
      return iss;
    }

    const parts = raw.split(".");
    if (parts.length !== 3) throw new FakeXrpcError(401, "InvalidToken", "Malformed JWT");
    let header: { alg?: string; typ?: string };
    let payload: { iss?: string; aud?: string; lxm?: string; iat?: number; exp?: number; jti?: string };
    try {
      header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as typeof header;
      payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as typeof payload;
    } catch {
      throw new FakeXrpcError(401, "InvalidToken", "Malformed JWT JSON");
    }
    if (header.typ === "at+jwt" || header.typ === "refresh+jwt" || header.typ === "dpop+jwt") {
      throw new FakeXrpcError(401, "InvalidToken", "Invalid service JWT typ");
    }
    if (header.alg !== "ES256" && header.alg !== "ES256K") {
      throw new FakeXrpcError(401, "InvalidToken", "Unsupported alg");
    }
    const iss = payload.iss?.split("#", 1)[0] ?? "";
    if (!isDid(iss)) throw new FakeXrpcError(401, "InvalidToken", "Invalid iss");
    if (iss === groupDid) throw new FakeXrpcError(400, "CannotTargetGroupSelf", "Group DID cannot target self");
    if (payload.lxm !== expectedLxm) throw new FakeXrpcError(401, "InvalidToken", `Expected lxm ${expectedLxm}`);
    if (payload.aud !== groupDid && payload.aud !== `${groupDid}#atproto_pds`) {
      throw new FakeXrpcError(401, "InvalidToken", "Audience mismatch");
    }
    if (
      payload.iat === undefined ||
      payload.exp === undefined ||
      payload.iat > nowSec + 5 ||
      payload.exp <= nowSec ||
      payload.exp <= payload.iat ||
      payload.exp - payload.iat > 75 ||
      nowSec - payload.iat > 75
    ) {
      throw new FakeXrpcError(401, "ExpiredToken", "Service JWT expired or outside 75s window");
    }
    if (!payload.jti) throw new FakeXrpcError(401, "InvalidToken", "Missing jti");
    const sigKey = await this.resolveSigningKey(iss).catch(() => undefined);
    if (!sigKey) throw new FakeXrpcError(401, "InvalidSignature", "Unknown issuer signing key");
    const valid = await verifySignature(
      sigKey,
      utf8Encoder.encode(`${parts[0]}.${parts[1]}`),
      Uint8Array.from(Buffer.from(parts[2]!, "base64url")),
      { jwtAlg: header.alg },
    ).catch(() => false);
    if (!valid) throw new FakeXrpcError(401, "InvalidSignature", "Service JWT signature verification failed");
    const rk = `svc\u0000${iss}\u0000${payload.jti}`;
    if (this.usedServiceJtis.has(rk)) {
      throw new FakeXrpcError(401, "ReplayDetected", "Service JWT jti already consumed");
    }
    this.usedServiceJtis.add(rk);
    return iss;
  }

  private requireActiveFakeGroup(groupDid: string): FakeGroupState {
    const grp = this.groups.get(groupDid);
    if (!grp || this.unavailable.get(groupDid) === "RepoNotFound") {
      throw new FakeXrpcError(400, "GroupNotFound", "Group not hosted here");
    }
    const unavail = this.unavailable.get(groupDid);
    if (unavail === "RepoTakendown") throw new FakeXrpcError(400, "RepoTakendown", "Group is taken down");
    if (unavail === "RepoDeactivated") throw new FakeXrpcError(400, "RepoDeactivated", "Group is deactivated");
    return grp;
  }

  private validateFakeInviteForCaller(
    groupDid: string,
    callerDid: string,
    inviteUri: string,
    nowMs: number,
  ): { inviteSpaceUri: string; rkey: string } {
    const parsed = parseAnySpaceRecordUri(inviteUri);
    const expectedSpace = personalInboxUri(callerDid);
    if (
      !parsed ||
      parsed.authorityDid !== callerDid ||
      parsed.spaceType !== ATGRP_SPACE_TYPE.inbox ||
      parsed.skey !== SELF_SKEY ||
      parsed.spaceUri !== expectedSpace ||
      parsed.repoDid !== groupDid ||
      parsed.collection !== ATGRP_COLLECTION.invite ||
      !isTid(parsed.rkey) ||
      inviteUri !== `${expectedSpace}/${groupDid}/${ATGRP_COLLECTION.invite}/${parsed.rkey}`
    ) {
      throw new FakeXrpcError(400, "InvalidInvite", "Invite URI is malformed or does not target caller");
    }
    const entry = this.accountRepos.get(groupDid)?.get(expectedSpace)?.collections.get(ATGRP_COLLECTION.invite)?.get(parsed.rkey);
    if (!entry) throw new FakeXrpcError(400, "InvalidInvite", "Invite not found or already redeemed/revoked");
    const val = entry.value as { group?: string; expiresAt?: string };
    if (val.group && val.group !== groupDid) {
      throw new FakeXrpcError(400, "InvalidInvite", "Invite group mismatch");
    }
    if (val.expiresAt !== undefined) {
      const expMs = Date.parse(val.expiresAt);
      if (!Number.isFinite(expMs) || expMs <= nowMs) {
        throw new FakeXrpcError(400, "InvalidInvite", "Invite has expired");
      }
    }
    return { inviteSpaceUri: expectedSpace, rkey: parsed.rkey };
  }

  private async redeemFakeInvite(
    grp: FakeGroupState,
    callerDid: string,
    inviteSpaceUri: string,
    rkey: string,
    inviteUri: string,
    deliveries: Promise<void>[],
  ): Promise<void> {
    await this.deleteGroupSpaceRecordInternal(grp.did, inviteSpaceUri, ATGRP_COLLECTION.invite, rkey, deliveries, true);
    grp.inviteDeliveries.delete(inviteUri);
    const repo = this.accountRepos.get(grp.did)?.get(inviteSpaceUri);
    if (repo) {
      this.deliverFakeInviteToSpace(grp.did, callerDid, inviteSpaceUri, repo, deliveries);
    }
  }

  private async handleFakeRequestJoin(
    params: Record<string, unknown>,
    auth: FakeAuth,
    requestHeaders: Headers | undefined,
    deliveries: Promise<void>[],
  ): Promise<Record<string, unknown>> {
    const groupDid = String(params.group ?? "");
    const callerDid = await this.verifyFakePersonalServiceJwt(auth, groupDid, ATGRP_METHOD.requestJoin);
    const grp = this.requireActiveFakeGroup(groupDid);
    this.assertNoActiveFakeMigrationLease(grp);
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();

    const idempotencyKey = requestHeaders?.get("idempotency-key") ?? undefined;
    if (idempotencyKey !== undefined && !isValidIdempotencyKey(idempotencyKey)) {
      throw new FakeXrpcError(400, "InvalidIdempotencyKey", "Invalid Idempotency-Key");
    }
    if (grp.knownAppSubjects.has(callerDid)) {
      throw new FakeXrpcError(400, "SubjectIsAppServicePrincipal", "App service principals cannot request human membership");
    }

    this.pruneFakeExpiredJoinState(grp, nowMs);
    const invite = typeof params.invite === "string" ? params.invite : undefined;
    const message = typeof params.message === "string" ? params.message : undefined;
    const reqHash = idempotencyKey !== undefined
      ? sha256Hex(canonicalJson({ group: groupDid, invite: invite ?? null, message: message ?? null }))
      : null;

    const membersSpace = groupMembersUri(groupDid);
    const existingMem = this.accountRepos.get(groupDid)?.get(membersSpace)?.collections.get(ATGRP_COLLECTION.membership)?.get(callerDid);
    const existingMemRef = existingMem
      ? { uri: `${membersSpace}/${groupDid}/${ATGRP_COLLECTION.membership}/${callerDid}`, cid: existingMem.cid.toString() }
      : undefined;

    if (idempotencyKey !== undefined && reqHash !== null) {
      const opKey = `${callerDid}\u0000${idempotencyKey}`;
      const storedOp = grp.joinOperations.get(opKey);
      if (storedOp) {
        if (storedOp.requestHash !== reqHash) {
          throw new FakeXrpcError(409, "IdempotencyParameterMismatch", "Idempotency-Key reused with different parameters");
        }
        if (storedOp.state === "pending" && existingMemRef) {
          const upgraded = { status: "admitted", membership: existingMemRef };
          storedOp.state = "admitted";
          storedOp.responseJson = JSON.stringify(upgraded);
          storedOp.updatedAt = nowMs;
          return upgraded;
        }
        if (storedOp.state === "admitted") {
          if (existingMemRef) return JSON.parse(storedOp.responseJson) as Record<string, unknown>;
          throw new FakeXrpcError(400, "JoinRequestClosed", "Prior admitted membership was subsequently removed");
        }
        if (storedOp.state === "pending") {
          return JSON.parse(storedOp.responseJson) as Record<string, unknown>;
        }
        throw new FakeXrpcError(400, "JoinRequestClosed", `Join operation already ${storedOp.state}`);
      }
    }

    const checkQuota = () => {
      if (idempotencyKey === undefined) return;
      let count = 0;
      for (const op of grp.joinOperations.values()) {
        if (op.requesterDid === callerDid && op.expiresAt > nowMs) count += 1;
      }
      if (count >= 200) {
        throw new FakeXrpcError(429, "JoinOperationQuotaExceeded", "Unexpired join operation quota (200) exceeded");
      }
    };

    const recordOp = (state: "pending" | "admitted", resp: Record<string, unknown>, expiresAt: number) => {
      if (idempotencyKey === undefined || reqHash === null) return;
      grp.joinOperations.set(`${callerDid}\u0000${idempotencyKey}`, {
        requesterDid: callerDid,
        operationId: idempotencyKey,
        requestHash: reqHash,
        state,
        responseJson: JSON.stringify(resp),
        expiresAt,
        updatedAt: nowMs,
      });
    };

    const state = this.loadFakeGovernanceState(groupDid);
    const defaultRoles = [...state.roles.entries()].filter(([, r]) => r.default === true).map(([k]) => k);

    // Case A: Already a human member
    if (existingMemRef) {
      let validatedInvite: { inviteSpaceUri: string; rkey: string } | undefined;
      if (invite !== undefined) {
        validatedInvite = this.validateFakeInviteForCaller(groupDid, callerDid, invite, nowMs);
      }
      checkQuota();
      if (validatedInvite && invite !== undefined) {
        await this.redeemFakeInvite(grp, callerDid, validatedInvite.inviteSpaceUri, validatedInvite.rkey, invite, deliveries);
      }
      grp.joinRequests.delete(callerDid);
      const resp = { status: "admitted", membership: existingMemRef };
      recordOp("admitted", resp, nowMs + 30 * DAY_MS);
      return resp;
    }

    // Case B: Invite redemption
    if (invite !== undefined) {
      const validated = this.validateFakeInviteForCaller(groupDid, callerDid, invite, nowMs);
      if (defaultRoles.length === 0) throw new FakeXrpcError(400, "NoDefaultRole", "No default role configured");
      checkQuota();
      const written = await this.putGroupSpaceRecordInternal(
        groupDid,
        groupDid,
        membersSpace,
        ATGRP_COLLECTION.membership,
        callerDid,
        { $type: ATGRP_COLLECTION.membership, roles: defaultRoles, createdAt: nowIso },
        deliveries,
      );
      await this.redeemFakeInvite(grp, callerDid, validated.inviteSpaceUri, validated.rkey, invite, deliveries);
      grp.joinRequests.delete(callerDid);
      grp.modEjectionEligibility.delete(callerDid);
      const resp = { status: "admitted", membership: { uri: written.uri, cid: written.cid } };
      for (const op of grp.joinOperations.values()) {
        if (op.requesterDid === callerDid && op.state === "pending") {
          op.state = "admitted";
          op.responseJson = JSON.stringify(resp);
          op.updatedAt = nowMs;
        }
      }
      recordOp("admitted", resp, nowMs + 30 * DAY_MS);
      return resp;
    }

    const cfgEntry = this.accountRepos
      .get(groupDid)
      ?.get(groupMetaUri(groupDid))
      ?.collections.get(ATGRP_COLLECTION.config)
      ?.get(SELF_SKEY);
    const joinPolicy = (cfgEntry?.value as { joinPolicy?: string } | undefined)?.joinPolicy;

    // Case C: open
    if (joinPolicy === "open") {
      if (defaultRoles.length === 0) throw new FakeXrpcError(400, "NoDefaultRole", "No default role configured");
      checkQuota();
      const written = await this.putGroupSpaceRecordInternal(
        groupDid,
        groupDid,
        membersSpace,
        ATGRP_COLLECTION.membership,
        callerDid,
        { $type: ATGRP_COLLECTION.membership, roles: defaultRoles, createdAt: nowIso },
        deliveries,
      );
      grp.joinRequests.delete(callerDid);
      grp.modEjectionEligibility.delete(callerDid);
      const resp = { status: "admitted", membership: { uri: written.uri, cid: written.cid } };
      for (const op of grp.joinOperations.values()) {
        if (op.requesterDid === callerDid && op.state === "pending") {
          op.state = "admitted";
          op.responseJson = JSON.stringify(resp);
          op.updatedAt = nowMs;
        }
      }
      recordOp("admitted", resp, nowMs + 30 * DAY_MS);
      return resp;
    }

    // Case D: invite-only
    if (joinPolicy === undefined || joinPolicy === "invite") {
      throw new FakeXrpcError(400, "JoinClosed", "The group is invite-only.");
    }

    // Case E: approval
    if (joinPolicy === "approval") {
      checkQuota();
      const existingReq = grp.joinRequests.get(callerDid);
      if (!existingReq) {
        const expiresAt = nowMs + 30 * DAY_MS;
        grp.joinRequests.set(callerDid, {
          requesterDid: callerDid,
          message: message !== undefined && message !== "" ? message : null,
          createdAt: nowIso,
          expiresAt,
        });
        const resp = {
          status: "pending",
          request: {
            member: callerDid,
            createdAt: nowIso,
            ...(message !== undefined && message !== "" ? { message } : {}),
          },
        };
        recordOp("pending", resp, expiresAt);
        return resp;
      }
      const resp = {
        status: "pending",
        request: {
          member: callerDid,
          createdAt: existingReq.createdAt,
          ...(existingReq.message !== null ? { message: existingReq.message } : {}),
        },
      };
      recordOp("pending", resp, existingReq.expiresAt);
      return resp;
    }

    throw new FakeXrpcError(400, "JoinClosed", `Unsupported joinPolicy '${joinPolicy}'`);
  }

  private async handleFakeCancelJoinRequest(params: Record<string, unknown>, auth: FakeAuth): Promise<Record<string, never>> {
    const groupDid = String(params.group ?? "");
    const callerDid = await this.verifyFakePersonalServiceJwt(auth, groupDid, ATGRP_METHOD.cancelJoinRequest);
    const grp = this.requireActiveFakeGroup(groupDid);
    this.assertNoActiveFakeMigrationLease(grp);
    const nowMs = this.now();
    this.pruneFakeExpiredJoinState(grp, nowMs);
    if (!grp.joinRequests.delete(callerDid)) {
      throw new FakeXrpcError(400, "JoinRequestNotFound", "No pending join request found for caller");
    }
    for (const op of grp.joinOperations.values()) {
      if (op.requesterDid === callerDid && op.state === "pending") {
        op.state = "cancelled";
        op.updatedAt = nowMs;
      }
    }
    return {};
  }

  private handleFakeDenyJoinRequest(params: Record<string, unknown>, auth: FakeAuth): Record<string, never> {
    const groupDid = this.requireSelf(auth, { scopes: "full", checkTakedown: true, checkDeactivated: true });
    const grp = this.requireActiveFakeGroup(groupDid);
    this.assertNoActiveFakeMigrationLease(grp);
    this.requireGroupRpcPerm(auth, groupDid, groupDid, ATGRP_METHOD.denyJoinRequest);
    const memberDid = String(params.member ?? "");
    if (memberDid === groupDid) throw new FakeXrpcError(400, "CannotTargetGroupSelf", "Cannot target group self DID");
    const nowMs = this.now();
    this.pruneFakeExpiredJoinState(grp, nowMs);
    if (!grp.joinRequests.delete(memberDid)) {
      throw new FakeXrpcError(400, "JoinRequestNotFound", `No pending join request for ${memberDid}`);
    }
    for (const op of grp.joinOperations.values()) {
      if (op.requesterDid === memberDid && op.state === "pending") {
        op.state = "denied";
        op.updatedAt = nowMs;
      }
    }
    return {};
  }

  private handleFakeListJoinRequests(params: Record<string, unknown>, auth: FakeAuth) {
    const groupDid = this.requireSelf(auth, { scopes: "full", checkTakedown: true, checkDeactivated: true });
    const grp = this.requireActiveFakeGroup(groupDid);
    this.requireGroupRpcPerm(auth, groupDid, groupDid, ATGRP_METHOD.listJoinRequests);
    const nowMs = this.now();
    this.pruneFakeExpiredJoinState(grp, nowMs);

    const limit = clampLimit(params.limit, 50, 100);
    let cursorDecoded: { createdAt: string; member: string } | null = null;
    if (params.cursor !== undefined) {
      try {
        const raw = JSON.parse(Buffer.from(String(params.cursor), "base64url").toString("utf8")) as Record<string, unknown>;
        if (typeof raw?.createdAt !== "string" || typeof raw?.member !== "string" || !isDid(raw.member)) {
          throw new Error("bad");
        }
        cursorDecoded = { createdAt: raw.createdAt, member: raw.member };
      } catch {
        throw new FakeXrpcError(400, "InvalidCursor", "Malformed listJoinRequests cursor");
      }
    }

    const sorted = [...grp.joinRequests.values()].sort((a, b) =>
      a.createdAt !== b.createdAt ? compareLex(a.createdAt, b.createdAt) : compareLex(a.requesterDid, b.requesterDid),
    );
    const filtered = cursorDecoded
      ? sorted.filter(
          (r) => r.createdAt > cursorDecoded!.createdAt || (r.createdAt === cursorDecoded!.createdAt && r.requesterDid > cursorDecoded!.member),
        )
      : sorted;
    const page = filtered.slice(0, limit);
    const last = page.at(-1);
    const nextCursor =
      filtered.length > limit && last
        ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, member: last.requesterDid }), "utf8").toString("base64url")
        : undefined;

    return {
      requests: page.map((r) => ({
        member: r.requesterDid,
        createdAt: r.createdAt,
        ...(r.message !== null ? { message: r.message } : {}),
      })),
      ...(nextCursor ? { cursor: nextCursor } : {}),
    };
  }

  private async handleFakeLeaveGroup(
    params: Record<string, unknown>,
    auth: FakeAuth,
    requestHeaders: Headers | undefined,
    deliveries: Promise<void>[],
  ): Promise<Record<string, never>> {
    const groupDid = String(params.group ?? "");
    const callerDid = await this.verifyFakePersonalServiceJwt(auth, groupDid, ATGRP_METHOD.leaveGroup);
    const grp = this.groups.get(groupDid);
    if (!grp || this.unavailable.get(groupDid) === "RepoNotFound") {
      throw new FakeXrpcError(400, "GroupNotFound", "Group not hosted here");
    }
    const unavail = this.unavailable.get(groupDid);
    if (unavail === "RepoTakendown") throw new FakeXrpcError(400, "RepoTakendown", "Group is taken down");
    if (unavail === "RepoDeactivated") {
      if (grp.recoveryAdmin?.recoveryDid === callerDid) return {};
      throw new FakeXrpcError(400, "RepoDeactivated", "Group is deactivated");
    }
    this.assertNoActiveFakeMigrationLease(grp);

    const membersSpace = groupMembersUri(groupDid);
    const memEntry = this.accountRepos
      .get(groupDid)
      ?.get(membersSpace)
      ?.collections.get(ATGRP_COLLECTION.membership)
      ?.get(callerDid);
    if (!memEntry) return {};

    const ifMatch = requestHeaders?.get("if-match-membership-incarnation") ?? undefined;
    if (ifMatch !== undefined && memEntry.incarnation !== ifMatch) {
      throw new FakeXrpcError(409, "MembershipIncarnationMismatch", "Membership incarnation mismatch");
    }

    const preState = this.loadFakeGovernanceState(groupDid);
    if (preState.knownAppSubjects.has(callerDid)) {
      throw new FakeXrpcError(400, "SubjectIsAppServicePrincipal", "App service principals cannot call leaveGroup");
    }

    const callerRoles = [...(preState.memberships.get(callerDid)?.roles ?? [])];
    const postMemberships = new Map(preState.memberships);
    postMemberships.delete(callerDid);
    const postState: GovernanceSnapshot = { ...preState, memberships: postMemberships };

    const preHumans = [...preState.memberships.keys()].filter((d) => d !== groupDid && !preState.knownAppSubjects.has(d));
    const isSoleMember = preHumans.length === 1 && preState.memberships.size === 1 && preHumans[0] === callerDid;

    if (preState.hasFlockWorkspace) {
      checkPostGovernanceInvariants(preState, postState, groupDid, { allowSoleMemberDeactivation: isSoleMember }, FakeXrpcError);
    } else {
      const postHumans = [...postState.memberships.keys()].filter((d) => d !== groupDid && !postState.knownAppSubjects.has(d));
      if (postHumans.length === 0 && grp.sovereignRotationKeys.size === 0) {
        throw new FakeXrpcError(
          400,
          "NoSovereignCustodyKey",
          "Cannot leave as the last human member of a non-Flock group without an external sovereign PLC rotation key.",
        );
      }
    }

    const membersSp = this.spaces.get(membersSpace);
    const writerEntry = membersSp?.writers.get(callerDid);
    const lastRev = writerEntry ? (writerEntry.removed ? writerEntry.lastRepoRev : writerEntry.repoRev) : null;
    const prevEject = grp.priorEjectCounts.get(callerDid) ?? { count: 0, lastEvictedRepoRev: null };
    grp.priorEjectCounts.set(callerDid, { count: prevEject.count + 1, lastEvictedRepoRev: lastRev ?? prevEject.lastEvictedRepoRev });

    const suppress = isSoleMember && preState.hasFlockWorkspace;
    await this.deleteGroupSpaceRecordInternal(groupDid, membersSpace, ATGRP_COLLECTION.membership, callerDid, deliveries, suppress);
    if (isSoleMember && preState.hasFlockWorkspace) {
      // Revoke & fan out `notifyCredentialsRevoked` BEFORE `reconcileGroupSpaceWriters` marks writers `removed = true`!
      this.revokeGroupCredentialsForSpace(groupDid, undefined, undefined, deliveries);
    }
    this.reconcileGroupSpaceWriters(groupDid, postState, deliveries, suppress);

    if (isSoleMember && preState.hasFlockWorkspace) {
      grp.authEpoch += 1;
      grp.recoveryAdmin = {
        recoveryDid: callerDid,
        roles: callerRoles,
        deactivatedAt: this.now(),
      };
      this.unavailable.set(groupDid, "RepoDeactivated");
      for (const [tok, sess] of this.sessions) {
        if (sess.did === groupDid) this.sessions.delete(tok);
      }
      this.revokeGroupCredentialsForSpace(groupDid, undefined, undefined, deliveries);
    }
    return {};
  }

  private handleFakeJoinStatus(params: Record<string, unknown>, auth: FakeAuth): Promise<Record<string, unknown>> {
    return (async () => {
      const groupDid = String(params.group ?? "");
      const callerDid = await this.verifyFakePersonalServiceJwt(auth, groupDid, ATGRP_METHOD.requestJoin);
      const operationId = typeof params.operationId === "string" ? params.operationId : undefined;
      if (operationId !== undefined && !isValidIdempotencyKey(operationId)) {
        throw new FakeXrpcError(400, "InvalidIdempotencyKey", "Invalid operationId");
      }
      const grp = this.groups.get(groupDid);
      if (!grp || this.unavailable.get(groupDid) === "RepoNotFound") {
        throw new FakeXrpcError(400, "GroupNotFound", "Group not hosted here");
      }
      const unavail = this.unavailable.get(groupDid);
      if (unavail === "RepoTakendown") throw new FakeXrpcError(400, "RepoTakendown", "Group is taken down");
      if (unavail === "RepoDeactivated") {
        if (grp.recoveryAdmin?.recoveryDid === callerDid) return { state: "left_deactivated" };
        throw new FakeXrpcError(400, "RepoDeactivated", "Group is deactivated");
      }

      const nowMs = this.now();
      this.pruneFakeExpiredJoinState(grp, nowMs);

      if (!grp.knownAppSubjects.has(callerDid)) {
        const membersSpace = groupMembersUri(groupDid);
        const memEntry = this.accountRepos
          .get(groupDid)
          ?.get(membersSpace)
          ?.collections.get(ATGRP_COLLECTION.membership)
          ?.get(callerDid);
        if (memEntry) {
          return {
            state: "admitted",
            currentIncarnation: memEntry.incarnation ?? null,
            membership: {
              uri: `${membersSpace}/${groupDid}/${ATGRP_COLLECTION.membership}/${callerDid}`,
              cid: memEntry.cid.toString(),
            },
          };
        }
      }

      if (operationId !== undefined) {
        const op = grp.joinOperations.get(`${callerDid}\u0000${operationId}`);
        if (!op) return { state: "unknown" };
        if (op.state === "admitted") return { state: "denied" };
        return { state: op.state };
      }

      return { state: grp.joinRequests.has(callerDid) ? "pending" : "unknown" };
    })();
  }

  private handleFakeListInviteDeliveries(auth: FakeAuth) {
    const groupDid = this.requireSelf(auth, { scopes: "full", checkTakedown: true, checkDeactivated: true });
    const grp = this.requireActiveFakeGroup(groupDid);
    this.requireGroupSpaceRecordPerm(auth, groupDid, personalInboxUri("did:plc:probeaaaaaaaaaaaaaaaaaa2"), ATGRP_COLLECTION.invite, "create");
    const sorted = [...grp.inviteDeliveries.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      deliveries: sorted.map((d) => ({
        inviteUri: d.inviteUri,
        spaceUri: d.spaceUri,
        inviteeDid: d.inviteeDid,
        rkey: d.rkey,
        repoRev: d.repoRev,
        status: d.status,
        attempts: d.attempts,
        ...(d.lastError !== null ? { lastError: d.lastError } : {}),
        createdAt: new Date(d.createdAt).toISOString(),
        updatedAt: new Date(d.updatedAt).toISOString(),
      })),
    };
  }

  private handleFakeRetryInviteDelivery(
    params: Record<string, unknown>,
    auth: FakeAuth,
    deliveries: Promise<void>[],
  ) {
    const groupDid = this.requireSelf(auth, { scopes: "full", checkTakedown: true, checkDeactivated: true });
    const grp = this.requireActiveFakeGroup(groupDid);
    this.assertNoActiveFakeMigrationLease(grp);
    const inviteUri = String(params.inviteUri ?? "");
    const row = grp.inviteDeliveries.get(inviteUri);
    if (!row) throw new FakeXrpcError(400, "InviteNotFound", `Invite delivery not found: ${inviteUri}`);
    this.requireGroupSpaceRecordPerm(auth, groupDid, row.spaceUri, ATGRP_COLLECTION.invite, "create");
    const repo = this.accountRepos.get(groupDid)?.get(row.spaceUri);
    if (!repo) throw new FakeXrpcError(400, "InviteNotFound", "Invite repo missing");
    const res = this.deliverFakeInviteToSpace(groupDid, row.inviteeDid, row.spaceUri, repo, deliveries);
    row.status = res.status;
    row.attempts += 1;
    row.lastError = res.error ?? null;
    row.updatedAt = this.now();
    return {
      status: row.status,
      ...(row.lastError ? { lastError: row.lastError } : {}),
    };
  }

  private async handleFakeSubmitReport(params: Record<string, unknown>, auth: FakeAuth) {
    const groupDid = String(params.group ?? "");
    const callerDid = await this.verifyFakePersonalServiceJwt(auth, groupDid, ATGRP_METHOD.modSubmitReport);
    const grp = this.requireActiveFakeGroup(groupDid);
    this.assertNoActiveFakeMigrationLease(grp);
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();

    const subject = String(params.subject ?? "");
    const cid = typeof params.cid === "string" ? params.cid : undefined;
    const reasonType = String(params.reasonType ?? "");
    const reason = typeof params.reason === "string" ? params.reason : undefined;
    const rule = typeof params.rule === "string" ? params.rule : undefined;
    if (params.reason !== undefined && typeof params.reason !== "string") {
      throw new FakeXrpcError(400, "InvalidRequest", "reason must be a string");
    }
    if (reason !== undefined && (reason.length > 20_000 || [...reason].length > 2_000)) {
      throw new FakeXrpcError(400, "InvalidRequest", "reason exceeds maximum length");
    }

    const state = this.loadFakeGovernanceState(groupDid);
    const membersSpaceUri = groupMembersUri(groupDid);

    let subjectType: "account" | "record";
    let subjectCollection: string | undefined;
    let subjectOwnerDid: string;

    if (isDid(subject)) {
      subjectType = "account";
      subjectOwnerDid = subject;
      if (cid !== undefined) throw new FakeXrpcError(400, "InvalidRequest", "Account DID reports cannot include a cid");
      if (!liveRoleGrantsAccess(state, membersSpaceUri, callerDid, groupDid, "read")) {
        throw new FakeXrpcError(400, "InvalidSubject", "The subject isn't in this group.");
      }
      if (subject !== groupDid && !state.memberships.has(subject)) {
        throw new FakeXrpcError(400, "InvalidSubject", "The subject isn't in this group.");
      }
    } else {
      subjectType = "record";
      const parsed = parseAnySpaceRecordUri(subject);
      if (!parsed || parsed.authorityDid !== groupDid) {
        throw new FakeXrpcError(400, "InvalidSubject", "The subject isn't in this group.");
      }
      subjectCollection = parsed.collection;
      subjectOwnerDid = parsed.repoDid;
      const targetSpace = this.spaces.get(parsed.spaceUri);
      if (!targetSpace || targetSpace.deleted || !liveRoleGrantsAccess(state, parsed.spaceUri, callerDid, groupDid, "read")) {
        throw new FakeXrpcError(400, "InvalidSubject", "The subject isn't in this group.");
      }
      if (parsed.repoDid === groupDid) {
        const rec = this.accountRepos.get(groupDid)?.get(parsed.spaceUri)?.collections.get(parsed.collection)?.get(parsed.rkey);
        if (!rec || (cid !== undefined && rec.cid.toString() !== cid)) {
          throw new FakeXrpcError(400, "InvalidSubject", "The subject isn't in this group.");
        }
      } else {
        const writerEntry = targetSpace.writers.get(parsed.repoDid);
        if (!writerEntry || writerEntry.removed) {
          throw new FakeXrpcError(400, "InvalidSubject", "The subject isn't in this group.");
        }
        if (cid !== undefined) {
          try {
            parseCid(cid);
          } catch {
            throw new FakeXrpcError(400, "InvalidRequest", "Invalid CID syntax");
          }
        }
      }
    }

    const labelerEntry = this.accountRepos
      .get(groupDid)
      ?.get(membersSpaceUri)
      ?.collections.get(ATGRP_COLLECTION.labeler)
      ?.get(SELF_SKEY);
    if (labelerEntry) {
      const labeler = labelerEntry.value as {
        reasonTypes?: string[];
        subjectTypes?: string[];
        subjectCollections?: string[];
      };
      if (labeler.reasonTypes && !labeler.reasonTypes.includes(reasonType)) {
        throw new FakeXrpcError(400, "InvalidRequest", `Report reasonType '${reasonType}' is not accepted`);
      }
      if (labeler.subjectTypes && !labeler.subjectTypes.includes(subjectType)) {
        throw new FakeXrpcError(400, "InvalidRequest", `Report subjectType '${subjectType}' is not accepted`);
      }
      if (subjectCollection && labeler.subjectCollections && !labeler.subjectCollections.includes(subjectCollection)) {
        throw new FakeXrpcError(400, "InvalidRequest", `Report collection '${subjectCollection}' is not accepted`);
      }
    }

    if (reasonType === ATGRP_MOD_REASON.violation && !rule) {
      throw new FakeXrpcError(400, "InvalidRequest", "reasonType violation requires citing 'rule'");
    }
    if (rule !== undefined) {
      const parsedRule = parseAnySpaceRecordUri(rule);
      if (
        !parsedRule ||
        parsedRule.spaceUri !== membersSpaceUri ||
        parsedRule.repoDid !== groupDid ||
        parsedRule.collection !== ATGRP_COLLECTION.rule ||
        !this.accountRepos.get(groupDid)?.get(membersSpaceUri)?.collections.get(ATGRP_COLLECTION.rule)?.has(parsedRule.rkey)
      ) {
        throw new FakeXrpcError(400, "InvalidRequest", "Cited rule does not exist in members/self");
      }
    }

    const cidKey = cid ?? "";
    const modKey = `${subject}\u0000${cidKey}`;
    const existing = grp.modSubjects.get(modKey);
    if (!existing) {
      grp.modSubjects.set(modKey, {
        subject,
        cidKey,
        status: "open",
        reportCount: 1,
        tags: new Set(),
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    } else {
      existing.status = existing.status === "resolved" ? "open" : existing.status;
      existing.reportCount += 1;
      existing.updatedAt = nowIso;
    }

    const seq = grp.nextModSeq++;
    const eventId = `ev-${sha256Hex(`${groupDid}\u0000${seq}`).slice(0, 20)}`;
    grp.modEvents.push({
      seq,
      eventId,
      subject,
      cidKey,
      subjectOwnerDid,
      isSelfVisible: false,
      createdAt: nowIso,
      createdBy: callerDid,
      event: {
        $type: ATGRP_MOD_EVENT_TYPE.report,
        reasonType,
        ...(reason !== undefined ? { reason } : {}),
        ...(rule !== undefined ? { rule } : {}),
      },
    });
    return { eventId, createdAt: nowIso };
  }

  private async handleFakeSubmitAppeal(params: Record<string, unknown>, auth: FakeAuth) {
    const groupDid = String(params.group ?? "");
    const callerDid = await this.verifyFakePersonalServiceJwt(auth, groupDid, ATGRP_METHOD.modSubmitAppeal);
    const grp = this.requireActiveFakeGroup(groupDid);
    this.assertNoActiveFakeMigrationLease(grp);
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();

    const subject = String(params.subject ?? "");
    const reason = typeof params.reason === "string" ? params.reason : undefined;
    if (params.reason !== undefined && typeof params.reason !== "string") {
      throw new FakeXrpcError(400, "InvalidRequest", "reason must be a string");
    }
    if (reason !== undefined && (reason.length > 20_000 || [...reason].length > 2_000)) {
      throw new FakeXrpcError(400, "InvalidRequest", "reason exceeds maximum length");
    }

    const membersSpaceUri = groupMembersUri(groupDid);
    let labelSpaceUri: string;
    if (isDid(subject)) {
      if (subject !== callerDid) {
        throw new FakeXrpcError(400, "InvalidSubject", "You may only appeal moderation actions on your own account or records.");
      }
      labelSpaceUri = membersSpaceUri;
    } else {
      const parsed = parseAnySpaceRecordUri(subject);
      if (!parsed || parsed.authorityDid !== groupDid || parsed.repoDid !== callerDid) {
        throw new FakeXrpcError(400, "InvalidSubject", "You may only appeal moderation actions on your own account or records.");
      }
      labelSpaceUri = parsed.spaceUri;
    }

    const labelCol = this.accountRepos.get(groupDid)?.get(labelSpaceUri)?.collections.get(ATPROTO_SPACE_COLLECTION.label);
    const liveLabels = labelCol
      ? [...labelCol.entries()].map(([rkey, entry]) => ({ repoDid: groupDid, rkey, value: entry.value }))
      : [];
    const activeLabels = projectActiveLabels(liveLabels, { groupDid, spaceUri: labelSpaceUri, nowMs }).filter(
      (l) => l.uri === subject,
    );
    const isEjectedEligible = isDid(subject) && grp.modEjectionEligibility.has(callerDid);

    if (activeLabels.length === 0 && !isEjectedEligible) {
      throw new FakeXrpcError(400, "NotAppealable", "This subject has no active moderation action eligible for appeal.");
    }

    const modKey = `${subject}\u0000`;
    const existing = grp.modSubjects.get(modKey);
    if (!existing) {
      grp.modSubjects.set(modKey, {
        subject,
        cidKey: "",
        status: "open",
        reportCount: 0,
        tags: new Set(),
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    } else {
      existing.status = "open";
      existing.updatedAt = nowIso;
    }

    const seq = grp.nextModSeq++;
    const eventId = `ev-${sha256Hex(`${groupDid}\u0000${seq}`).slice(0, 20)}`;
    grp.modEvents.push({
      seq,
      eventId,
      subject,
      cidKey: "",
      subjectOwnerDid: callerDid,
      isSelfVisible: true,
      createdAt: nowIso,
      createdBy: callerDid,
      event: {
        $type: ATGRP_MOD_EVENT_TYPE.appeal,
        ...(reason !== undefined ? { reason } : {}),
      },
    });
    return { eventId, createdAt: nowIso };
  }

  private handleFakeQueryModSubjects(params: Record<string, unknown>, auth: FakeAuth) {
    const groupDid = this.requireSelf(auth, { scopes: "full", checkTakedown: true, checkDeactivated: true });
    const grp = this.requireActiveFakeGroup(groupDid);
    this.requireGroupRpcPerm(auth, groupDid, groupDid, ATGRP_METHOD.modQuerySubjects);

    const allowedKeys = new Set(["status", "tags", "sort", "limit", "cursor"]);
    for (const k of Object.keys(params)) {
      if (!allowedKeys.has(k)) {
        throw new FakeXrpcError(400, "InvalidRequest", `Unknown query parameter '${k}'`);
      }
    }

    const status = params.status === undefined ? undefined : String(params.status);
    if (status !== undefined && status !== "open" && status !== "resolved") {
      throw new FakeXrpcError(400, "InvalidRequest", "status must be 'open' or 'resolved'");
    }
    const sort = params.sort === undefined ? "oldest" : String(params.sort);
    if (sort !== "oldest" && sort !== "newest" && sort !== "updated") {
      throw new FakeXrpcError(400, "InvalidRequest", "sort must be 'oldest', 'newest', or 'updated'");
    }
    let tagsFilter: string[] | undefined;
    if (params.tags !== undefined) {
      const rawTags = Array.isArray(params.tags) ? params.tags : [params.tags];
      if (!rawTags.every((t) => typeof t === "string" && /^[a-z-]{1,128}$/.test(t))) {
        throw new FakeXrpcError(400, "InvalidRequest", "Invalid tags filter");
      }
      tagsFilter = [...new Set(rawTags as string[])].sort(compareLex);
    }
    const limit = clampLimit(params.limit, 50, 100);
    const fHash = sha256Hex(JSON.stringify({ status: status ?? null, tags: tagsFilter ?? null })).slice(0, 16);

    let cursorDecoded: { ts: string; subject: string; cidKey: string } | null = null;
    if (params.cursor !== undefined) {
      try {
        const raw = JSON.parse(Buffer.from(String(params.cursor), "base64url").toString("utf8")) as Record<string, unknown>;
        if (
          raw?.v !== 1 ||
          raw.ep !== "querySubjects" ||
          raw.groupDid !== groupDid ||
          raw.sort !== sort ||
          raw.filtersHash !== fHash ||
          typeof raw.ts !== "string" ||
          typeof raw.subject !== "string" ||
          typeof raw.cidKey !== "string"
        ) {
          throw new Error("bad");
        }
        cursorDecoded = { ts: raw.ts, subject: raw.subject, cidKey: raw.cidKey };
      } catch {
        throw new FakeXrpcError(400, "InvalidCursor", "Malformed querySubjects cursor");
      }
    }

    const matching = [...grp.modSubjects.values()]
      .filter((s) => (status === undefined || s.status === status) && (!tagsFilter || tagsFilter.some((t) => s.tags.has(t))))
      .sort((a, b) => {
        const aTs = sort === "updated" ? a.updatedAt : a.createdAt;
        const bTs = sort === "updated" ? b.updatedAt : b.createdAt;
        if (aTs !== bTs) return sort === "oldest" ? compareLex(aTs, bTs) : compareLex(bTs, aTs);
        if (a.subject !== b.subject) return compareLex(a.subject, b.subject);
        return compareLex(a.cidKey, b.cidKey);
      });

    const filtered = cursorDecoded
      ? matching.filter((s) => {
          const ts = sort === "updated" ? s.updatedAt : s.createdAt;
          if (sort === "oldest") {
            return (
              ts > cursorDecoded!.ts ||
              (ts === cursorDecoded!.ts && s.subject > cursorDecoded!.subject) ||
              (ts === cursorDecoded!.ts && s.subject === cursorDecoded!.subject && s.cidKey > cursorDecoded!.cidKey)
            );
          }
          return (
            ts < cursorDecoded!.ts ||
            (ts === cursorDecoded!.ts && s.subject > cursorDecoded!.subject) ||
            (ts === cursorDecoded!.ts && s.subject === cursorDecoded!.subject && s.cidKey > cursorDecoded!.cidKey)
          );
        })
      : matching;

    const page = filtered.slice(0, limit);
    const last = page.at(-1);
    const nextCursor =
      filtered.length > limit && last
        ? Buffer.from(
            JSON.stringify({
              v: 1,
              ep: "querySubjects",
              groupDid,
              sort,
              filtersHash: fHash,
              ts: sort === "updated" ? last.updatedAt : last.createdAt,
              subject: last.subject,
              cidKey: last.cidKey,
            }),
            "utf8",
          ).toString("base64url")
        : undefined;

    return new WithHeaders(
      {
        subjects: page.map((r) => {
          const tags = [...r.tags].sort(compareLex);
          return {
            subject: r.subject,
            ...(r.cidKey !== "" ? { cid: r.cidKey } : {}),
            status: r.status,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
            ...(r.reportCount > 0 ? { reportCount: r.reportCount } : {}),
            ...(tags.length > 0 ? { tags } : {}),
          };
        }),
        ...(nextCursor ? { cursor: nextCursor } : {}),
      },
      { "cache-control": "no-store" },
    );
  }

  private handleFakeQueryModSubjectHistory(params: Record<string, unknown>, auth: FakeAuth) {
    const groupDid = this.requireSelf(auth, { scopes: "full", checkTakedown: true, checkDeactivated: true });
    const grp = this.requireActiveFakeGroup(groupDid);
    this.requireGroupRpcPerm(auth, groupDid, groupDid, ATGRP_METHOD.modQuerySubjectHistory);

    const subject = String(params.subject ?? "");
    if (!isDid(subject)) {
      const parsed = parseAnySpaceRecordUri(subject);
      if (!parsed || parsed.authorityDid !== groupDid) {
        throw new FakeXrpcError(400, "InvalidSubject", "Subject is not an account DID or space record URI of this group");
      }
    }
    const cidFilter = typeof params.cid === "string" ? params.cid : undefined;
    const sort = params.sort === undefined ? "newest" : String(params.sort);
    if (sort !== "newest" && sort !== "oldest") {
      throw new FakeXrpcError(400, "InvalidRequest", "sort must be 'newest' or 'oldest'");
    }
    const limit = clampLimit(params.limit, 50, 100);
    const fHash = sha256Hex(JSON.stringify({ subject, cid: cidFilter ?? null })).slice(0, 16);

    let cursorSeq: number | null = null;
    if (params.cursor !== undefined) {
      try {
        const raw = JSON.parse(Buffer.from(String(params.cursor), "base64url").toString("utf8")) as Record<string, unknown>;
        if (
          raw?.v !== 1 ||
          raw.ep !== "querySubjectHistory" ||
          raw.groupDid !== groupDid ||
          raw.sort !== sort ||
          raw.filtersHash !== fHash ||
          typeof raw.seq !== "number"
        ) {
          throw new Error("bad");
        }
        cursorSeq = raw.seq;
      } catch {
        throw new FakeXrpcError(400, "InvalidCursor", "Malformed querySubjectHistory cursor");
      }
    }

    const matching = grp.modEvents
      .filter(
        (e) =>
          e.subject === subject &&
          (cidFilter === undefined || e.cidKey === cidFilter) &&
          (cursorSeq === null || (sort === "newest" ? e.seq < cursorSeq : e.seq > cursorSeq)),
      )
      .sort((a, b) => (sort === "newest" ? b.seq - a.seq : a.seq - b.seq));

    const page = matching.slice(0, limit);
    const last = page.at(-1);
    const nextCursor =
      matching.length > limit && last
        ? Buffer.from(
            JSON.stringify({
              v: 1,
              ep: "querySubjectHistory",
              groupDid,
              sort,
              filtersHash: fHash,
              seq: last.seq,
            }),
            "utf8",
          ).toString("base64url")
        : undefined;

    return new WithHeaders(
      {
        events: page.map((e) => ({
          eventId: e.eventId,
          createdAt: e.createdAt,
          subject: e.subject,
          ...(e.cidKey !== "" ? { cid: e.cidKey } : {}),
          ...(e.createdBy !== null ? { createdBy: e.createdBy } : {}),
          event: e.event,
        })),
        ...(nextCursor ? { cursor: nextCursor } : {}),
      },
      { "cache-control": "no-store" },
    );
  }

  private async handleFakeQuerySelfModHistory(params: Record<string, unknown>, auth: FakeAuth) {
    const groupDid = String(params.group ?? "");
    const callerDid = await this.verifyFakePersonalServiceJwt(auth, groupDid, ATGRP_METHOD.modQuerySelfHistory);
    const grp = this.requireActiveFakeGroup(groupDid);

    const subjectFilter = typeof params.subject === "string" ? params.subject : undefined;
    if (subjectFilter !== undefined) {
      if (isDid(subjectFilter)) {
        if (subjectFilter !== callerDid) {
          throw new FakeXrpcError(400, "InvalidSubject", "You may only query moderation history for your own account or records.");
        }
      } else {
        const parsed = parseAnySpaceRecordUri(subjectFilter);
        if (!parsed || parsed.authorityDid !== groupDid || parsed.repoDid !== callerDid) {
          throw new FakeXrpcError(400, "InvalidSubject", "You may only query moderation history for your own account or records.");
        }
      }
    }
    const sort = params.sort === undefined ? "newest" : String(params.sort);
    if (sort !== "newest" && sort !== "oldest") {
      throw new FakeXrpcError(400, "InvalidRequest", "sort must be 'newest' or 'oldest'");
    }
    const limit = clampLimit(params.limit, 50, 100);
    const fHash = sha256Hex(JSON.stringify({ callerDid, subject: subjectFilter ?? null })).slice(0, 16);

    let cursorSeq: number | null = null;
    if (params.cursor !== undefined) {
      try {
        const raw = JSON.parse(Buffer.from(String(params.cursor), "base64url").toString("utf8")) as Record<string, unknown>;
        if (
          raw?.v !== 1 ||
          raw.ep !== "querySelfHistory" ||
          raw.groupDid !== groupDid ||
          raw.sort !== sort ||
          raw.filtersHash !== fHash ||
          typeof raw.seq !== "number"
        ) {
          throw new Error("bad");
        }
        cursorSeq = raw.seq;
      } catch {
        throw new FakeXrpcError(400, "InvalidCursor", "Malformed querySelfHistory cursor");
      }
    }

    const matching = grp.modEvents
      .filter(
        (e) =>
          e.subjectOwnerDid === callerDid &&
          e.isSelfVisible &&
          (subjectFilter === undefined || e.subject === subjectFilter) &&
          (cursorSeq === null || (sort === "newest" ? e.seq < cursorSeq : e.seq > cursorSeq)),
      )
      .sort((a, b) => (sort === "newest" ? b.seq - a.seq : a.seq - b.seq));

    const page = matching.slice(0, limit);
    const last = page.at(-1);
    const nextCursor =
      matching.length > limit && last
        ? Buffer.from(
            JSON.stringify({
              v: 1,
              ep: "querySelfHistory",
              groupDid,
              sort,
              filtersHash: fHash,
              seq: last.seq,
            }),
            "utf8",
          ).toString("base64url")
        : undefined;

    const projectSelfEvent = (ev: Record<string, unknown>): Record<string, unknown> => {
      switch (ev.$type) {
        case ATGRP_MOD_EVENT_TYPE.appeal:
          return { $type: ATGRP_MOD_EVENT_TYPE.appeal };
        case ATGRP_MOD_EVENT_TYPE.status:
          return { $type: ATGRP_MOD_EVENT_TYPE.status, status: ev.status };
        case ATGRP_MOD_EVENT_TYPE.label:
          return {
            $type: ATGRP_MOD_EVENT_TYPE.label,
            uri: ev.uri,
            val: ev.val,
            ...(ev.deleted === true ? { deleted: true } : {}),
          };
        case ATGRP_MOD_EVENT_TYPE.eject:
          return { $type: ATGRP_MOD_EVENT_TYPE.eject };
        default:
          throw new Error(`Unexpected self-visible event type: ${String(ev.$type)}`);
      }
    };

    return new WithHeaders(
      {
        events: page.map((e) => ({
          eventId: e.eventId,
          createdAt: e.createdAt,
          subject: e.subject,
          ...(e.cidKey !== "" ? { cid: e.cidKey } : {}),
          event: projectSelfEvent(e.event),
        })),
        ...(nextCursor ? { cursor: nextCursor } : {}),
      },
      { "cache-control": "no-store" },
    );
  }

  private handleFakeUpdateModSubject(params: Record<string, unknown>, auth: FakeAuth) {
    const groupDid = this.requireSelf(auth, { scopes: "full", checkTakedown: true, checkDeactivated: true });
    const grp = this.requireActiveFakeGroup(groupDid);
    this.assertNoActiveFakeMigrationLease(grp);
    const actorDid = this.requireGroupRpcPerm(auth, groupDid, groupDid, ATGRP_METHOD.modUpdateSubject);

    const subject = String(params.subject ?? "");
    if (!isDid(subject)) {
      const parsed = parseAnySpaceRecordUri(subject);
      if (!parsed || parsed.authorityDid !== groupDid) {
        throw new FakeXrpcError(400, "InvalidSubject", "Subject is not an account DID or space record URI of this group");
      }
    }
    const status = params.status as "open" | "resolved" | undefined;
    if (status !== undefined && status !== "open" && status !== "resolved") {
      throw new FakeXrpcError(400, "InvalidRequest", "status must be 'open' or 'resolved'");
    }
    if (params.note !== undefined && typeof params.note !== "string") {
      throw new FakeXrpcError(400, "InvalidRequest", "note must be a string");
    }
    const note = typeof params.note === "string" ? params.note : undefined;
    if (note !== undefined && (note.length > 20_000 || [...note].length > 2_000)) {
      throw new FakeXrpcError(400, "InvalidRequest", "note exceeds maximum length");
    }

    const parseTags = (raw: unknown, label: string): string[] => {
      if (raw === undefined) return [];
      if (!Array.isArray(raw) || !raw.every((t) => typeof t === "string" && /^[a-z-]{1,128}$/.test(t))) {
        throw new FakeXrpcError(400, "InvalidRequest", `Invalid ${label}`);
      }
      return [...new Set(raw as string[])];
    };
    const addTags = parseTags(params.addTags, "addTags");
    const removeTags = parseTags(params.removeTags, "removeTags");
    const addSet = new Set(addTags);
    for (const t of removeTags) {
      if (addSet.has(t)) {
        throw new FakeXrpcError(400, "InvalidRequest", `Tag '${t}' cannot appear in both addTags and removeTags`);
      }
    }
    if (status === undefined && addTags.length === 0 && removeTags.length === 0) {
      throw new FakeXrpcError(400, "InvalidRequest", "updateSubject requires at least status, addTags, or removeTags");
    }

    const cidKey = typeof params.cid === "string" ? params.cid : "";
    const existing = grp.modSubjects.get(`${subject}\u0000${cidKey}`);
    if (!existing) {
      throw new FakeXrpcError(400, "SubjectNotFound", "The subject has never been reported.");
    }

    const nextTags = new Set(existing.tags);
    for (const t of removeTags) nextTags.delete(t);
    for (const t of addTags) nextTags.add(t);
    if (nextTags.size > 100) {
      throw new FakeXrpcError(400, "InvalidRequest", "A moderation subject may have at most 100 tags");
    }

    const nowIso = new Date(this.now()).toISOString();
    const subjectOwnerDid = isDid(subject) ? subject : parseAnySpaceRecordUri(subject)!.repoDid;
    if (status !== undefined) {
      existing.status = status;
      const seq = grp.nextModSeq++;
      grp.modEvents.push({
        seq,
        eventId: `ev-${sha256Hex(`${groupDid}\u0000${seq}`).slice(0, 20)}`,
        subject,
        cidKey,
        subjectOwnerDid,
        isSelfVisible: true,
        createdAt: nowIso,
        createdBy: actorDid,
        event: {
          $type: ATGRP_MOD_EVENT_TYPE.status,
          status,
          ...(note !== undefined ? { note } : {}),
        },
      });
    }
    if (addTags.length > 0 || removeTags.length > 0) {
      existing.tags = nextTags;
      const seq = grp.nextModSeq++;
      grp.modEvents.push({
        seq,
        eventId: `ev-${sha256Hex(`${groupDid}\u0000${seq}`).slice(0, 20)}`,
        subject,
        cidKey,
        subjectOwnerDid,
        isSelfVisible: false,
        createdAt: nowIso,
        createdBy: actorDid,
        event: {
          $type: ATGRP_MOD_EVENT_TYPE.tag,
          ...(addTags.length > 0 ? { add: addTags } : {}),
          ...(removeTags.length > 0 ? { remove: removeTags } : {}),
          ...(status === undefined && note !== undefined ? { note } : {}),
        },
      });
    }
    existing.updatedAt = nowIso;
    const sortedTags = [...existing.tags].sort(compareLex);
    return {
      subject: existing.subject,
      ...(existing.cidKey !== "" ? { cid: existing.cidKey } : {}),
      status: existing.status,
      createdAt: existing.createdAt,
      updatedAt: existing.updatedAt,
      ...(existing.reportCount > 0 ? { reportCount: existing.reportCount } : {}),
      ...(sortedTags.length > 0 ? { tags: sortedTags } : {}),
    };
  }

  private handleFakeClaimActionToken(params: Record<string, unknown>, auth: FakeAuth) {
    const groupDid = this.requireSelf(auth, { scopes: "full", checkTakedown: true });
    const grp = this.groups.get(groupDid);
    if (!grp) throw new FakeXrpcError(400, "GroupNotFound", "Group not hosted here");
    const purpose = params.purpose as "delete_account" | "plc_operation";
    if (purpose !== "delete_account" && purpose !== "plc_operation") {
      throw new FakeXrpcError(400, "InvalidRequest", "Invalid purpose");
    }
    if (auth.kind !== "self") throw new FakeXrpcError(401, "AuthMissing", "Group session required");
    if (auth.sessionKind === "recovery" && purpose !== "delete_account") {
      throw new FakeXrpcError(403, "Forbidden", "Recovery sessions may only claim delete_account tokens");
    }
    const nowMs = this.now();
    this.assertFakeFreshLoginStepUp(auth, nowMs, "Fresh prompt=login authentication required");
    const actorDid = auth.authorizingUserDid ?? groupDid;
    const effState = this.effectiveFakeStateForAuth(groupDid, auth);
    const admins = effectiveHumanAdmins(effState, groupDid);
    const isAdmin = actorDid === groupDid || (admins.length >= 1 ? admins.includes(actorDid) : effState.memberships.has(actorDid));
    if (!isAdmin) throw new FakeXrpcError(403, "Forbidden", "Caller is not an authorized lifecycle admin");

    const row = grp.actionTokens.get(purpose);
    if (!row || row.actorDid !== actorDid) {
      throw new FakeXrpcError(400, "InvalidToken", "No matching action token found");
    }
    if (row.expiresAt <= nowMs) {
      throw new FakeXrpcError(400, "ExpiredToken", "Action token expired");
    }
    if (row.token === null) {
      throw new FakeXrpcError(400, "TokenAlreadyClaimed", "Action token was already claimed");
    }
    const claimed = row.token;
    row.token = null;
    return { token: claimed, expiresAt: new Date(row.expiresAt).toISOString() };
  }

  private hostServiceDid(hostSlug: string): string {
    return hostSlug === "group-host" ? "did:web:fake-pds.test" : `did:web:fake-pds.test:${hostSlug}`;
  }

  private hostEndpointUrl(hostSlug: string): string {
    return `https://fake-pds.test/${hostSlug}`;
  }

  private hostServiceKeypair(hostSlug: string): Promise<P256Keypair> {
    const svcDid = this.hostServiceDid(hostSlug);
    let kp = this.hostServiceKeys.get(svcDid);
    if (!kp) {
      kp = P256Keypair.create();
      this.hostServiceKeys.set(svcDid, kp);
    }
    return kp;
  }

  private async signFakeServiceJwt(params: {
    issDid: string;
    aud: string;
    lxm?: string;
    iat?: number;
    exp?: number;
    jti?: string;
  }): Promise<string> {
    const iat = params.iat ?? Math.floor(this.now() / 1000);
    const exp = params.exp ?? iat + 60;
    const jti = params.jti ?? randomUUID();
    const isHostDid = params.issDid.startsWith("did:web:");
    const kp = isHostDid
      ? ((await this.hostServiceKeys.get(params.issDid)) ??
        (await this.hostServiceKeypair(
          params.issDid === "did:web:fake-pds.test"
            ? "group-host"
            : params.issDid.startsWith("did:web:fake-pds.test:")
              ? params.issDid.slice("did:web:fake-pds.test:".length)
              : params.issDid,
        )))
      : await this.signingKeypair(params.issDid);
    const header = { alg: kp.jwtAlg, typ: "JWT", kid: "#atproto" };
    const payload: Record<string, unknown> = {
      iss: params.issDid,
      aud: params.aud,
      ...(params.lxm !== undefined ? { lxm: params.lxm } : {}),
      iat,
      exp,
      jti,
    };
    const signingInput = `${jsonToB64Url(header)}.${jsonToB64Url(payload)}`;
    const sig = await kp.sign(utf8Encoder.encode(signingInput));
    return `${signingInput}.${toBase64(sig, "base64url")}`;
  }

  private reapFakeExpiredPreparedMigrationLease(grp: FakeGroupState): void {
    const nowMs = this.now();
    const lease = grp.sourceMigrationLease;
    if (lease && lease.status === "prepared" && lease.expiresAt !== null && lease.expiresAt <= nowMs) {
      grp.sourceMigrationLease = null;
      if (lease.operationId) {
        this.recordFakeAbortedOperation(
          grp.did,
          lease.operationId,
          Math.max(lease.deadlineAt, nowMs + 2 * 3_600_000),
          this.accounts.get(grp.did) ?? "group-host",
        );
      }
      if (lease.targetEndpoint && lease.targetServiceDid && lease.operationId.trim().length > 0) {
        const delivery = (async () => {
          try {
            await Promise.resolve();
            const abortJwt = await this.signFakeServiceJwt({
              issDid: grp.did,
              aud: lease.targetServiceDid,
              lxm: FLOCK_GROUP_METHOD.abortMigration,
            });
            const abortUrl = `${lease.targetEndpoint}/group-admin/abort-migration`;
            const abortInit: RequestInit = {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${abortJwt}`,
              },
              body: JSON.stringify({
                group: grp.did,
                operationId: lease.operationId,
                ...(lease.mode === "coordinated" && lease.ticketId ? { ticketId: lease.ticketId } : {}),
                ...(lease.ticketId ? { leaseAttemptId: lease.ticketId } : {}),
                deadlineAtMs: lease.deadlineAt,
              }),
            };
            if (this.hasOutboundHandler(abortUrl)) {
              await this.sendOutbound(abortUrl, abortInit).catch(() => undefined);
            } else {
              await this.fetchEndpoint(new Request(abortUrl, abortInit)).catch(() => undefined);
            }
          } catch {
            // Best-effort target abort on background expiry reap only
          }
        })();
        this.pendingDeliveries.add(delivery);
        void delivery.finally(() => this.pendingDeliveries.delete(delivery));
      }
    }
  }

  private assertNoActiveFakeMigrationLease(grp: FakeGroupState): void {
    this.reapFakeExpiredPreparedMigrationLease(grp);
    if (grp.sourceMigrationLease) {
      throw new FakeXrpcError(409, "MigrationInProgress", "Group is frozen during active migration");
    }
  }

  private async withFakeGroupLock<T>(groupDid: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = this.fakeGroupLocks.get(groupDid) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => next, () => next);
    this.fakeGroupLocks.set(groupDid, tail);
    await prev.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.fakeGroupLocks.get(groupDid) === tail) {
        this.fakeGroupLocks.delete(groupDid);
      }
    }
  }

  private reconcileFakeUncutoverMigrationSession(did: string, grp: FakeGroupState, nowMs: number): void {
    const sess = grp.migrationSession;
    if (!sess || sess.plcCutoverAt !== null) return;
    if (
      this.publishedSigningKeys.get(did) === sess.stagedSigningKey.did() &&
      this.publishedKemKeys.get(did) === sess.stagedKemKey.did()
    ) {
      sess.plcCutoverAt = nowMs;
    }
  }

  private purgeFakeUncutoverStagingOnReplay(
    did: string,
    sessionId: string,
    authEpoch: number,
    nowMs: number,
    hostSlug?: string,
  ): void {
    const resolvedHostSlug = hostSlug ?? this.accounts.get(did) ?? "group-host";
    const grp = this.groups.get(did);
    if (grp) {
      this.reconcileFakeUncutoverMigrationSession(did, grp, nowMs);
    }
    const sess = grp?.migrationSession;
    if (!grp || !sess || sess.id !== sessionId || sess.authEpoch !== authEpoch || sess.plcCutoverAt !== null) {
      return;
    }
    // Prune expired abort-storage entries for `(resolvedHostSlug, did)` just like
    // production `purgeMigrationStagingDataSync` preserves only rows with `expires_at > nowMs`.
    const abortPrefix = `${resolvedHostSlug}\u0000${did}\u0000`;
    for (const [key, exp] of this.fakeAbortStorageEntries) {
      if (key.startsWith(abortPrefix) && exp <= nowMs) {
        this.fakeAbortStorageEntries.delete(key);
      }
    }
    // Mirror production `purgeUncutoverSessionOnReplaySync`: never recreate or extend `ticket:`
    // beyond its original `absoluteDeadlineAt`; only preserve unexpired ticket rejection!
    if (sess.mode === "coordinated" && sess.ticketId) {
      if (sess.absoluteDeadlineAt > nowMs) {
        this.usedServiceJtis.add(`aborted-ticket\u0000${did}\u0000${sess.ticketId}`);
      } else {
        this.usedServiceJtis.delete(`aborted-ticket\u0000${did}\u0000${sess.ticketId}`);
      }
    }
    if (sess.operationId !== null) {
      this.recordFakeAbortedOperation(
        did,
        sess.operationId,
        Math.max(sess.absoluteDeadlineAt, nowMs + 2 * 3_600_000),
        resolvedHostSlug,
      );
    }
    this.revokedMigrationJtis.add(sess.accessJti);
    this.revokedMigrationJtis.add(sess.refreshJti);
    if (this.unavailable.get(did) === "RepoDeactivated" && grp.recoveryAdmin === null) {
      this.groupsByHandle.delete(grp.handle);
      for (const [spUri, sp] of this.spaces) {
        if (sp.ownerDid === did) this.spaces.delete(spUri);
      }
      this.groups.delete(did);
      this.publicRecords.delete(did);
      this.accountRepos.delete(did);
      this.accounts.delete(did);
      this.unavailable.delete(did);
    } else {
      grp.migrationSession = null;
    }
  }

  private verifyActiveMigrationAccessAuth(
    auth: Extract<FakeAuth, { kind: "migration" }>,
  ): { did: string; grp: FakeGroupState } {
    const nowMs = this.now();
    const nowSec = Math.floor(nowMs / 1000);
    if (auth.tokenKind !== "access") {
      throw new FakeXrpcError(401, "ExpiredToken", "Refresh token cannot be used as access token");
    }
    if (nowSec >= auth.expSec) {
      throw new FakeXrpcError(401, "ExpiredToken", "Migration access token expired");
    }
    if (this.revokedMigrationJtis.has(auth.jti)) {
      this.purgeFakeUncutoverStagingOnReplay(auth.did, auth.sessionId, auth.authEpoch, nowMs);
      throw new FakeXrpcError(401, "InvalidToken", "Revoked migration token JTI replayed");
    }
    const grp = this.groups.get(auth.did);
    if (!grp) {
      throw new FakeXrpcError(401, "InvalidToken", "Staged group account not found");
    }
    if (this.unavailable.get(auth.did) === "RepoTakendown") {
      throw new FakeXrpcError(400, "RepoTakendown", "Group is taken down");
    }
    if (this.unavailable.get(auth.did) !== "RepoDeactivated") {
      throw new FakeXrpcError(400, "AlreadyActivated", "Group is already activated");
    }
    const sess = grp.migrationSession;
    if (!sess || sess.id !== auth.sessionId || sess.accessJti !== auth.jti || grp.authEpoch !== auth.authEpoch) {
      throw new FakeXrpcError(401, "InvalidToken", "Migration session is no longer active");
    }
    if (sess.plcCutoverAt === null && nowMs >= sess.absoluteDeadlineAt) {
      this.reconcileFakeUncutoverMigrationSession(auth.did, grp, nowMs);
    }
    if (sess.plcCutoverAt === null && nowMs >= sess.absoluteDeadlineAt) {
      throw new FakeXrpcError(401, "ExpiredToken", "Migration staging deadline expired");
    }
    if (sess.prevRefreshJti !== null) {
      sess.prevRefreshJti = null;
      sess.refreshIdempotencyKey = null;
      sess.refreshGraceExpiresAt = null;
    }
    return { did: auth.did, grp };
  }

  private isAuthorizedFakeLifecycleAdmin(actorDid: string, state: GovernanceSnapshot, groupDid: string): boolean {
    if (actorDid === groupDid) return true;
    const admins = effectiveHumanAdmins(state, groupDid);
    if (admins.length >= 1) return admins.includes(actorDid);
    return !state.knownAppSubjects.has(actorDid) && state.memberships.has(actorDid);
  }

  private checkFakeSyncRepoAvailability(did: string, auth: FakeAuth, allowRecoveryWhenDeactivated: boolean): void {
    if (!this.accounts.has(did) || this.unavailable.get(did) === "RepoNotFound") {
      throw new FakeXrpcError(400, "RepoNotFound", `Repo not found: ${did}`);
    }
    const state = this.unavailable.get(did);
    if (state === "RepoTakendown") {
      throw new FakeXrpcError(400, "RepoTakendown", `Repo taken down: ${did}`);
    }
    if (state === "RepoDeactivated") {
      if (allowRecoveryWhenDeactivated && auth.kind === "self" && auth.did === did) {
        this.requireSelf(auth, { scopes: "full", checkTakedown: true });
        return;
      }
      throw new FakeXrpcError(400, "RepoDeactivated", `Repo deactivated: ${did}`);
    }
  }

  private async exportFakePublicRepoCar(did: string): Promise<{
    carBytes: Uint8Array;
    rootCid: string;
    dataRootCid: string;
    rev: string;
    blockCount: number;
  }> {
    const blocks = new BlockMap();
    const pubMap = this.publicRecords.get(did) ?? new Map<string, { value: unknown; cid: string }>();
    const sortedKeys = [...pubMap.keys()].sort(compareLex);
    const mstEntries: Array<{ p: number; k: Uint8Array; v: ReturnType<typeof parseCid>; t: null }> = [];
    let prevKeyBytes: Uint8Array = new Uint8Array(0);
    for (const pathKey of sortedKeys) {
      const slash = pathKey.indexOf("/");
      const col = pathKey.slice(0, slash);
      const rkey = pathKey.slice(slash + 1);
      const entry = pubMap.get(pathKey)!;
      const withType = { $type: col, ...(entry.value as Record<string, unknown>) };
      const ser = await serializeRecord(
        col as NsidString,
        rkey as RecordKeyString,
        plainJsonToLexDataLocal(withType) as LexMap,
      );
      blocks.set(ser.cid, ser.bytes);
      const keyBytes = utf8Encoder.encode(pathKey);
      let prefixLen = 0;
      const maxPrefix = Math.min(prevKeyBytes.length, keyBytes.length);
      while (prefixLen < maxPrefix && prevKeyBytes[prefixLen] === keyBytes[prefixLen]) {
        prefixLen += 1;
      }
      mstEntries.push({
        p: prefixLen,
        k: keyBytes.slice(prefixLen),
        v: ser.cid,
        t: null,
      });
      prevKeyBytes = keyBytes;
    }
    const dataCid = await blocks.add({ l: null, e: mstEntries });
    const rev = "3kzzzzzzzzzzz";
    const kp = await this.signingKeypair(did);
    const unsignedCommit = {
      did,
      version: 3,
      data: dataCid,
      rev,
      prev: null,
    };
    const unsignedCid = await blocks.add(unsignedCommit);
    const unsignedBytes = blocks.get(unsignedCid)!;
    blocks.delete(unsignedCid);
    const sig = await kp.sign(unsignedBytes);
    const rootCid = await blocks.add({ ...unsignedCommit, sig });
    const carBytes = await blocksToCarFile(rootCid, blocks);
    return {
      carBytes,
      rootCid: rootCid.toString(),
      dataRootCid: dataCid.toString(),
      rev,
      blockCount: blocks.size,
    };
  }

  private async getFakeSyncRepoStatus(params: Record<string, unknown>) {
    const did = typeof params.did === "string" ? params.did : "";
    if (!did) throw new FakeXrpcError(400, "InvalidRequest", "did required");
    if (!this.accounts.has(did) || this.unavailable.get(did) === "RepoNotFound") {
      throw new FakeXrpcError(400, "RepoNotFound", `Repo not found: ${did}`);
    }
    const state = this.unavailable.get(did);
    if (state === "RepoTakendown") {
      return { did, active: false, status: "takendown" };
    }
    const exported = await this.exportFakePublicRepoCar(did);
    if (state === "RepoDeactivated") {
      return { did, active: false, status: "deactivated", rev: exported.rev };
    }
    return { did, active: true, rev: exported.rev };
  }

  private async getFakeSyncLatestCommit(params: Record<string, unknown>, auth: FakeAuth) {
    const did = typeof params.did === "string" ? params.did : "";
    if (!did) throw new FakeXrpcError(400, "InvalidRequest", "did required");
    this.checkFakeSyncRepoAvailability(did, auth, false);
    const exported = await this.exportFakePublicRepoCar(did);
    return { cid: exported.rootCid, rev: exported.rev };
  }

  private async getFakeSyncRepoCar(params: Record<string, unknown>, auth: FakeAuth): Promise<BinaryResponse> {
    const did = typeof params.did === "string" ? params.did : "";
    if (!did) throw new FakeXrpcError(400, "InvalidRequest", "did required");
    this.checkFakeSyncRepoAvailability(did, auth, true);
    const exported = await this.exportFakePublicRepoCar(did);
    return new BinaryResponse(exported.carBytes, {}, "application/vnd.ipld.car");
  }

  private async importPublicRepoCar(
    auth: FakeAuth,
    requestHeaders: Headers | undefined,
    rawBody: Uint8Array | undefined,
  ): Promise<Record<string, never>> {
    const did = this.requireSelf(auth, { scopes: "full", checkTakedown: true, allowMigration: true });
    if (this.groups.has(did) && auth.kind !== "migration") {
      throw new FakeXrpcError(400, "AlreadyActivated", "Group is already activated");
    }
    if (requestHeaders) {
      const ct = requestHeaders.get("content-type") ?? "";
      if (ct && !ct.includes("application/vnd.ipld.car") && !ct.includes("application/octet-stream")) {
        throw new FakeXrpcError(400, "InvalidRequest", "Content-Type must be application/vnd.ipld.car");
      }
    }
    if (!rawBody || rawBody.byteLength === 0) {
      throw new FakeXrpcError(400, "InvalidRequest", "CAR body required");
    }
    let parsedCar: Awaited<ReturnType<typeof readCarWithRoot>>;
    try {
      parsedCar = await readCarWithRoot(rawBody);
    } catch (err) {
      throw new FakeXrpcError(400, "InvalidRequest", err instanceof Error ? err.message : "Invalid CAR archive");
    }
    const rootBytes = parsedCar.blocks.get(parsedCar.root);
    if (!rootBytes) throw new FakeXrpcError(400, "InvalidRequest", "Missing CAR root block");
    const rootDecoded = cborDecode(rootBytes) as { did?: unknown; data?: unknown };
    if (typeof rootDecoded?.did === "string" && rootDecoded.did !== did) {
      throw new FakeXrpcError(400, "RepoMismatch", "CAR commit DID does not match target account");
    }
    if (!isCid(rootDecoded?.data)) {
      throw new FakeXrpcError(400, "InvalidRequest", "CAR commit missing MST data root CID");
    }

    const extracted = new Map<string, { value: unknown; cid: string }>();
    const walkMst = (nodeCid: ReturnType<typeof parseCid>) => {
      const nodeBytes = parsedCar.blocks.get(nodeCid);
      if (!nodeBytes) throw new FakeXrpcError(400, "InvalidRequest", `Missing MST node block ${nodeCid.toString()}`);
      const node = cborDecode(nodeBytes) as {
        l?: unknown;
        e?: Array<{ p?: unknown; k?: unknown; v?: unknown; t?: unknown }>;
      };
      if (isCid(node.l)) walkMst(node.l);
      let prevKey: Uint8Array = new Uint8Array(0);
      for (const entry of node.e ?? []) {
        const p = typeof entry.p === "number" ? entry.p : 0;
        const k = entry.k instanceof Uint8Array ? entry.k : new Uint8Array(0);
        const fullKeyBytes = concatBytes([prevKey.slice(0, p), k]);
        prevKey = fullKeyBytes;
        const fullKey = utf8Decoder.decode(fullKeyBytes);
        const slash = fullKey.indexOf("/");
        if (slash <= 0 || !isCid(entry.v)) {
          throw new FakeXrpcError(400, "InvalidRequest", `Invalid MST entry '${fullKey}'`);
        }
        const collection = fullKey.slice(0, slash);
        const rkey = fullKey.slice(slash + 1);
        const recBytes = parsedCar.blocks.get(entry.v);
        if (!recBytes) throw new FakeXrpcError(400, "InvalidRequest", `Missing record block ${entry.v.toString()}`);
        const plainVal = lexDataToPlainJsonLocal(cborDecode(recBytes)) as Record<string, unknown>;
        if (this.groups.has(did)) {
          const check = validatePublicRecord(collection, plainVal, {
            repoDid: did,
            rkey,
            validate: false,
          });
          if (!check.valid) {
            throw new FakeXrpcError(400, check.code ?? "InvalidRequest", check.reason);
          }
        }
        extracted.set(fullKey, { value: plainVal, cid: entry.v.toString() });
        if (isCid(entry.t)) walkMst(entry.t);
      }
    };
    walkMst(rootDecoded.data);
    return this.withFakeGroupLock(did, () => {
      if (auth.kind === "migration") {
        this.verifyActiveMigrationAccessAuth(auth);
      }
      this.publicRecords.set(did, extracted);
      return {};
    });
  }

  private async uploadFakeBlob(auth: FakeAuth, requestHeaders: Headers | undefined, rawBody: Uint8Array | undefined) {
    const did = this.requireSelf(auth, { scopes: "full", checkTakedown: true, checkDeactivated: auth.kind !== "migration", allowMigration: true });
    const grp = this.groups.get(did);
    if (!grp) throw new FakeXrpcError(501, "NotImplemented", "Blob upload only enabled on group accounts in FakeNetwork");
    const mimeType = (requestHeaders?.get("content-type")?.split(";", 1)[0]?.trim() || "application/octet-stream") as `${string}/${string}`;
    const bytes = rawBody ?? new Uint8Array();
    const cid = (await cidForRawBytes(bytes)).toString();
    return this.withFakeGroupLock(did, () => {
      if (auth.kind === "migration") {
        this.verifyActiveMigrationAccessAuth(auth);
      } else {
        this.assertNoActiveFakeMigrationLease(grp);
        const { approved, live } = this.narrowedGroupSessionPerms(auth, did);
        if (!approved.allowsBlob({ mime: mimeType }) || !live.allowsBlob({ mime: mimeType })) {
          throw new FakeXrpcError(403, "Forbidden", `Missing blob upload permission for ${mimeType}`);
        }
      }
      grp.blobs.set(cid, { mimeType, size: bytes.byteLength, bytes });
      return {
        blob: {
          $type: "blob",
          ref: { $link: cid },
          mimeType,
          size: bytes.byteLength,
        },
      };
    });
  }

  private listMissingFakeBlobs(params: Record<string, unknown>, auth: FakeAuth) {
    const did = this.requireSelf(auth, { scopes: "full", allowMigration: true });
    const grp = this.groups.get(did);
    if (!grp) return { blobs: [] };
    if (grp.sourceMigrationLease?.status === "plc_signed") {
      throw new FakeXrpcError(409, "MigrationCutoverPending", "Group cutover pending");
    }
    const limit = clampLimit(params.limit, 500, 1000);
    const cursor = typeof params.cursor === "string" ? params.cursor : undefined;
    const refs = this.collectAllGroupBlobCids(did);
    const missing = [...refs.entries()]
      .filter(([cid]) => !grp.blobs.has(cid) && (cursor === undefined || cid > cursor))
      .sort((a, b) => compareLex(a[0], b[0]));
    const page = missing.slice(0, limit);
    return {
      blobs: page.map(([cid, recordUri]) => ({ cid, recordUri })),
      ...(page.length === limit && missing.length > limit ? { cursor: page.at(-1)![0] } : {}),
    };
  }

  private getPublicBlob(params: Record<string, unknown>, auth: FakeAuth): BinaryResponse {
    const did = typeof params.did === "string" ? params.did : "";
    const cid = typeof params.cid === "string" ? params.cid : "";
    if (!did || !cid) throw new FakeXrpcError(400, "InvalidRequest", "did and cid required");
    this.checkFakeSyncRepoAvailability(did, auth, true);
    const blob = this.groups.get(did)?.blobs.get(cid);
    if (!blob) throw new FakeXrpcError(400, "BlobNotFound", `Blob not found: ${cid}`);
    return new BinaryResponse(blob.bytes, { "x-content-type-options": "nosniff" }, blob.mimeType);
  }

  private listPublicBlobs(params: Record<string, unknown>, auth: FakeAuth) {
    const did = typeof params.did === "string" ? params.did : "";
    if (!did) throw new FakeXrpcError(400, "InvalidRequest", "did required");
    this.checkFakeSyncRepoAvailability(did, auth, true);
    const limit = clampLimit(params.limit, 500, 1000);
    const cursor = typeof params.cursor === "string" ? params.cursor : undefined;
    const allCids = [...(this.groups.get(did)?.blobs.keys() ?? [])].sort(compareLex);
    const filtered = cursor !== undefined ? allCids.filter((c) => c > cursor) : allCids;
    const page = filtered.slice(0, limit);
    return {
      cids: page,
      ...(page.length === limit && filtered.length > limit ? { cursor: page.at(-1)! } : {}),
    };
  }

  private async checkFakeAccountStatus(auth: FakeAuth) {
    const did = this.requireSelf(auth, { scopes: "full", checkTakedown: true, allowMigration: true });
    const grp = this.groups.get(did);
    const activated = this.unavailable.get(did) !== "RepoDeactivated";
    const referenced = grp ? this.collectAllGroupBlobCids(did) : new Map<string, string>();
    let importedBlobs = 0;
    if (grp) {
      for (const cid of referenced.keys()) {
        if (grp.blobs.has(cid)) importedBlobs += 1;
      }
    }
    const exported = await this.exportFakePublicRepoCar(did);
    const indexedRecords = this.publicRecords.get(did)?.size ?? 0;
    let privateStateValues = 0;
    for (const [, sp] of this.spaces) {
      if (sp.ownerDid === did && !sp.deleted) privateStateValues += 1;
    }
    return {
      activated,
      validDid: true,
      repoCommit: exported.rootCid,
      repoRev: exported.rev,
      repoBlocks: exported.blockCount,
      indexedRecords,
      privateStateValues,
      expectedBlobs: referenced.size,
      importedBlobs,
    };
  }

  private deactivateFakeAccount(auth: FakeAuth, deliveries: Promise<void>[]) {
    const did = this.requireSelf(auth, { scopes: "full", checkTakedown: true, checkDeactivated: true });
    const grp = this.groups.get(did);
    if (!grp) {
      this.unavailable.set(did, "RepoDeactivated");
      return {};
    }
    if (auth.kind === "self" && auth.sessionKind === "recovery") {
      throw new FakeXrpcError(403, "Forbidden", "Recovery sessions cannot deactivate an account");
    }
    this.assertNoActiveFakeMigrationLease(grp);
    const { actorDid, approved, live } = this.narrowedGroupSessionPerms(auth, did);
    if (!approved.allowsAccount({ attr: "status", action: "manage" }) || !live.allowsAccount({ attr: "status", action: "manage" })) {
      throw new FakeXrpcError(403, "Forbidden", "Missing account:status?action=manage");
    }
    const state = this.loadFakeGovernanceState(did);
    if (!this.isAuthorizedFakeLifecycleAdmin(actorDid, state, did)) {
      throw new FakeXrpcError(403, "Forbidden", "Caller is not an authorized lifecycle admin");
    }
    grp.authEpoch += 1;
    this.unavailable.set(did, "RepoDeactivated");
    for (const [tok, sess] of this.sessions) {
      if (sess.did === did) this.sessions.delete(tok);
    }
    this.revokeGroupCredentialsForSpace(did, undefined, undefined, deliveries);
    return {};
  }

  private validateFakeStagedOpenSocialIntegrity(did: string, grp: FakeGroupState): void {
    const membersSpace = groupMembersUri(did);
    const metaSpace = groupMetaUri(did);
    const membersSp = this.spaces.get(membersSpace);
    const metaSp = this.spaces.get(metaSpace);
    if (!membersSp || membersSp.deleted || !metaSp || metaSp.deleted) {
      throw new FakeXrpcError(
        400,
        "MigrationStagingIncomplete",
        "Core OpenSocial spaces meta/self and members/self must be staged",
      );
    }

    const ownSpaces: Array<[string, FakeSpace]> = [];
    for (const [spUri, sp] of this.spaces) {
      if (sp.ownerDid !== did || sp.deleted) continue;
      ownSpaces.push([spUri, sp]);
      const keyCheck = validateSpaceTypeKey(sp.type, sp.skey, { isGroupHostOwnSpace: true });
      if (!keyCheck.valid) {
        throw new FakeXrpcError(400, keyCheck.code ?? "InvalidSpaceKey", keyCheck.reason);
      }
      const rawGrants = (sp.policy as unknown as { grants?: GroupAtgrpPolicy["grants"] }).grants;
      const stagedMetaPolicy: GroupAtgrpPolicy = {
        $type: ATGRP_POLICY,
        publicRead: sp.policy.publicRead === true,
        unlisted: sp.policy.unlisted === true,
        grants: Array.isArray(rawGrants) ? rawGrants : [],
      };
      const polCheck = validateSpacePolicy(stagedMetaPolicy, {
        groupDid: did,
        spaceType: sp.type,
        skey: sp.skey,
      });
      if (!polCheck.valid) {
        throw new FakeXrpcError(400, polCheck.code ?? "InvalidSpacePolicy", polCheck.reason);
      }

      const policyCol = this.accountRepos.get(did)?.get(spUri)?.collections.get(ATPROTO_SPACE_COLLECTION.spacePolicy);
      const selfPolicyEntry = policyCol?.get(SELF_SKEY);
      if (!selfPolicyEntry) {
        throw new FakeXrpcError(
          400,
          "MissingSpacePolicyRecord",
          `Missing published com.atproto.space.policy/self in ${spUri}.`,
        );
      }
      if (policyCol!.size !== 1) {
        throw new FakeXrpcError(
          400,
          "InvalidSpacePolicy",
          `Space ${spUri} must contain only com.atproto.space.policy/self.`,
        );
      }
      const publishedRec = selfPolicyEntry.value;
      if (publishedRec.$type !== ATPROTO_SPACE_COLLECTION.spacePolicy) {
        throw new FakeXrpcError(
          400,
          "InvalidSpacePolicy",
          `Published com.atproto.space.policy/self in ${spUri} must declare $type com.atproto.space.policy.`,
        );
      }
      const recCheck = validateSpaceRecord(ATPROTO_SPACE_COLLECTION.spacePolicy, publishedRec, {
        authorityDid: did,
        spaceUri: spUri,
        repoDid: did,
        rkey: SELF_SKEY,
      });
      if (!recCheck.valid) {
        throw new FakeXrpcError(400, recCheck.code ?? "InvalidSpacePolicy", recCheck.reason);
      }
      const pubPolCheck = validateSpacePolicy(publishedRec.policy, {
        groupDid: did,
        spaceType: sp.type,
        skey: sp.skey,
      });
      if (!pubPolCheck.valid) {
        throw new FakeXrpcError(400, pubPolCheck.code ?? "InvalidSpacePolicy", pubPolCheck.reason);
      }
      if (
        canonicalAtgrpPolicyKey(stagedMetaPolicy) !==
        canonicalAtgrpPolicyKey(publishedRec.policy as GroupAtgrpPolicy)
      ) {
        throw new FakeXrpcError(
          400,
          "SpacePolicyMismatch",
          `Published com.atproto.space.policy/self in ${spUri} diverges from staged space metadata policy.`,
        );
      }
    }

    const aboutEntry = this.accountRepos
      .get(did)
      ?.get(metaSpace)
      ?.collections.get(ATGRP_COLLECTION.about)
      ?.get(SELF_SKEY);
    if (!aboutEntry) {
      throw new FakeXrpcError(400, "MissingGroupProfile", "org.atgrp.about/self is required in meta/self.");
    }
    const aboutCheck = validateSpaceRecord(ATGRP_COLLECTION.about, aboutEntry.value, {
      authorityDid: did,
      spaceUri: metaSpace,
      repoDid: did,
      rkey: SELF_SKEY,
      importMode: true,
    });
    if (!aboutCheck.valid) {
      throw new FakeXrpcError(400, aboutCheck.code ?? "InvalidRequest", aboutCheck.reason);
    }
    const configEntry = this.accountRepos
      .get(did)
      ?.get(metaSpace)
      ?.collections.get(ATGRP_COLLECTION.config)
      ?.get(SELF_SKEY);
    if (!configEntry) {
      throw new FakeXrpcError(400, "MissingGroupConfig", "org.atgrp.config/self is required in meta/self.");
    }
    const configCheck = validateSpaceRecord(ATGRP_COLLECTION.config, configEntry.value, {
      authorityDid: did,
      spaceUri: metaSpace,
      repoDid: did,
      rkey: SELF_SKEY,
      importMode: true,
    });
    if (!configCheck.valid) {
      throw new FakeXrpcError(400, configCheck.code ?? "InvalidRequest", configCheck.reason);
    }

    const refs = this.collectAllGroupBlobCids(did);
    for (const cid of refs.keys()) {
      if (!grp.blobs.has(cid)) {
        throw new FakeXrpcError(400, "MissingBlobs", `Missing referenced blob: ${cid}`);
      }
    }

    const indexedCol = this.accountRepos
      .get(did)
      ?.get(membersSpace)
      ?.collections.get(ATGRP_COLLECTION.space);
    const indexedSpaceUris = new Set<string>();
    if (indexedCol) {
      for (const entry of indexedCol.values()) {
        const spVal = entry.value as { space?: string };
        if (!spVal.space || indexedSpaceUris.has(spVal.space)) {
          throw new FakeXrpcError(
            400,
            "InvalidSpaceIndex",
            "Duplicate or malformed org.atgrp.space index entry.",
          );
        }
        indexedSpaceUris.add(spVal.space);
      }
    }
    for (const [spUri, sp] of ownSpaces) {
      const isCore = sp.type === ATGRP_SPACE_TYPE.meta || sp.type === ATGRP_SPACE_TYPE.members;
      if (isCore) continue;
      const shouldBeIndexed = sp.policy.unlisted !== true;
      if (shouldBeIndexed !== indexedSpaceUris.has(spUri)) {
        throw new FakeXrpcError(
          400,
          "SpaceIndexParityMismatch",
          `org.atgrp.space index parity mismatch for ${spUri}.`,
        );
      }
      indexedSpaceUris.delete(spUri);
    }
    if (indexedSpaceUris.size > 0) {
      throw new FakeXrpcError(400, "SpaceIndexParityMismatch", "Dangling org.atgrp.space index entry.");
    }
  }

  private async activateFakeAccount(auth: FakeAuth, deliveries: Promise<void>[]) {
    const did = this.requireSelf(auth, { scopes: "full", checkTakedown: true, allowMigration: true });
    const grp = this.groups.get(did);
    if (!grp) {
      this.unavailable.delete(did);
      return {};
    }
    if (auth.kind === "migration") {
      this.validateFakeStagedOpenSocialIntegrity(did, grp);
      grp.authEpoch += 1;
      if (grp.migrationSession) {
        this.signingKeys.set(did, Promise.resolve(grp.migrationSession.stagedSigningKey));
        this.kemKeys.set(did, Promise.resolve(grp.migrationSession.stagedKemKey));
        this.publishedSigningKeys.set(did, grp.migrationSession.stagedSigningKey.did());
        this.publishedKemKeys.set(did, grp.migrationSession.stagedKemKey.did());
        this.revokedMigrationJtis.add(grp.migrationSession.accessJti);
        this.revokedMigrationJtis.add(grp.migrationSession.refreshJti);
        grp.migrationSession = null;
      }
      this.unavailable.delete(did);
      return {};
    }

    this.assertNoActiveFakeMigrationLease(grp);
    const { actorDid, approved, live } = this.narrowedGroupSessionPerms(auth, did);
    if (!approved.allowsAccount({ attr: "status", action: "manage" }) || !live.allowsAccount({ attr: "status", action: "manage" })) {
      throw new FakeXrpcError(403, "Forbidden", "Missing account:status?action=manage");
    }
    const effState = this.effectiveFakeStateForAuth(did, auth);
    if (!this.isAuthorizedFakeLifecycleAdmin(actorDid, effState, did)) {
      throw new FakeXrpcError(403, "Forbidden", "Caller is not an authorized lifecycle admin");
    }
    this.validateFakeStagedOpenSocialIntegrity(did, grp);
    const liveState = this.loadFakeGovernanceState(did);
    if (liveState.memberships.size === 0 && grp.recoveryAdmin) {
      await this.putGroupSpaceRecordInternal(
        did,
        did,
        groupMembersUri(did),
        ATGRP_COLLECTION.membership,
        grp.recoveryAdmin.recoveryDid,
        {
          $type: ATGRP_COLLECTION.membership,
          roles: grp.recoveryAdmin.roles,
          createdAt: new Date(this.now()).toISOString(),
        },
        deliveries,
      );
      grp.recoveryAdmin = null;
    }
    grp.authEpoch += 1;
    this.unavailable.delete(did);
    return {};
  }

  private assertFakeFreshLoginStepUp(auth: FakeAuth, nowMs: number, message: string): void {
    if (auth.kind !== "self") return;
    const cutoff = nowMs - 5 * 60_000;
    if (
      auth.loginStepUpAtMs === null ||
      auth.loginStepUpAtMs === undefined ||
      auth.loginStepUpAtMs < cutoff ||
      (auth.authenticatedAtMs !== undefined && auth.authenticatedAtMs < cutoff)
    ) {
      throw new FakeXrpcError(403, "FreshAuthRequired", message);
    }
  }

  private requestFakeAccountDelete(auth: FakeAuth) {
    const did = this.requireSelf(auth, { scopes: "full", checkTakedown: true });
    const grp = this.groups.get(did);
    if (!grp) throw new FakeXrpcError(400, "GroupNotFound", "Group not hosted here");
    this.assertNoActiveFakeMigrationLease(grp);
    this.assertFakeFreshLoginStepUp(auth, this.now(), "Fresh prompt=login authentication required");
    const { actorDid, approved, live } = this.narrowedGroupSessionPerms(auth, did);
    if (!approved.allowsAccount({ attr: "status", action: "manage" }) || !live.allowsAccount({ attr: "status", action: "manage" })) {
      throw new FakeXrpcError(403, "Forbidden", "Missing account:status?action=manage");
    }
    const effState = this.effectiveFakeStateForAuth(did, auth);
    if (!this.isAuthorizedFakeLifecycleAdmin(actorDid, effState, did)) {
      throw new FakeXrpcError(403, "Forbidden", "Caller is not an authorized lifecycle admin");
    }
    this.issueGroupActionTokenForTest(did, actorDid, "delete_account");
    return {};
  }

  private deleteFakeAccount(
    params: Record<string, unknown>,
    auth: FakeAuth,
    deliveries: Promise<void>[],
    hostSlug = "group-host",
  ) {
    const sessionDid = this.requireSelf(auth, { scopes: "full", checkTakedown: true });
    const did = typeof params.did === "string" ? params.did : "";
    const token = typeof params.token === "string" ? params.token : "";
    const password = params.password;
    if (!did || did !== sessionDid || !token) {
      throw new FakeXrpcError(400, "InvalidRequest", "did (matching session) and token are required");
    }
    if (password !== undefined && password !== did) {
      throw new FakeXrpcError(400, "InvalidPassword", "password must be omitted or match group DID");
    }
    const grp = this.groups.get(did);
    if (!grp) throw new FakeXrpcError(400, "GroupNotFound", "Group not hosted here");
    this.assertNoActiveFakeMigrationLease(grp);
    this.assertFakeFreshLoginStepUp(auth, this.now(), "Fresh prompt=login authentication required");
    const { actorDid, approved, live } = this.narrowedGroupSessionPerms(auth, did);
    if (!approved.allowsAccount({ attr: "status", action: "manage" }) || !live.allowsAccount({ attr: "status", action: "manage" })) {
      throw new FakeXrpcError(403, "Forbidden", "Missing account:status?action=manage");
    }
    const effState = this.effectiveFakeStateForAuth(did, auth);
    if (!this.isAuthorizedFakeLifecycleAdmin(actorDid, effState, did)) {
      throw new FakeXrpcError(403, "Forbidden", "Caller is not an authorized lifecycle admin");
    }
    const row = grp.actionTokens.get("delete_account");
    if (!row || row.actorDid !== actorDid || row.tokenHash !== sha256Hex(token)) {
      throw new FakeXrpcError(400, "InvalidToken", "Invalid deleteAccount token");
    }
    if (row.expiresAt <= this.now()) {
      throw new FakeXrpcError(400, "ExpiredToken", "deleteAccount token expired");
    }
    grp.authEpoch += 1;
    for (const [tok, sess] of this.sessions) {
      if (sess.did === did) this.sessions.delete(tok);
    }
    this.revokeGroupCredentialsForSpace(did, undefined, undefined, deliveries);
    for (const [uri, sp] of this.spaces) {
      if (sp.ownerDid !== did || sp.deleted) continue;
      const regs = [...sp.notifyRegistrations.values()];
      sp.deleted = true;
      sp.writers.clear();
      sp.notifyRegistrations.clear();
      if (regs.length > 0) deliveries.push(this.deliverDeletionNotice(uri, regs));
    }
    for (const [k, entry] of this.usedAttestations) {
      if (entry.groupDid === did) this.usedAttestations.delete(k);
    }
    for (const [k, entry] of this.usedDelegationJtis) {
      if (entry.groupDid === did) this.usedDelegationJtis.delete(k);
    }
    const hostDidPrefix = `${hostSlug}\u0000${did}\u0000`;
    for (const k of [...this.fakeAbortStorageEntries.keys()]) {
      if (k.startsWith(hostDidPrefix)) this.fakeAbortStorageEntries.delete(k);
    }
    for (const k of [...this.abortedMigrationOps.keys()]) {
      if (k.startsWith(hostDidPrefix)) this.abortedMigrationOps.delete(k);
    }
    for (const k of [...this.abortedMigrationLeaseAttempts.keys()]) {
      if (k.startsWith(hostDidPrefix)) this.abortedMigrationLeaseAttempts.delete(k);
    }
    for (const k of [...this.usedServiceJtis]) {
      if (k.startsWith(`aborted-ticket\u0000${did}\u0000`) || k.includes(`\u0000${did}\u0000`)) {
        this.usedServiceJtis.delete(k);
      }
    }
    this.unavailable.set(did, "RepoNotFound");
    this.groupsByHandle.delete(grp.handle);
    this.groups.delete(did);
    this.publicRecords.delete(did);
    this.accountRepos.delete(did);
    return {};
  }

  private isFakePersonalPdsHostSlug(hostSlug: string): boolean {
    return hostSlug === "pds" || hostSlug.startsWith("pds-") || /^pds\d+$/.test(hostSlug);
  }

  private normalizeFakeTargetEndpoint(rawUrl: string): string {
    const parsedUrl = new URL(rawUrl);
    return normalizeBaseUrl(`${parsedUrl.origin}${parsedUrl.pathname}`);
  }

  private extractFakeDidPdsEndpoint(doc: {
    id?: string;
    service?: Array<{ id?: string; type?: string; serviceEndpoint?: unknown }>;
  }): string | null {
    const svc = (doc.service ?? []).find(
      (s) =>
        (s.id === "#atproto_pds" || (doc.id !== undefined && s.id === `${doc.id}#atproto_pds`)) &&
        typeof s.serviceEndpoint === "string",
    );
    if (!svc || typeof svc.serviceEndpoint !== "string") return null;
    try {
      return this.normalizeFakeTargetEndpoint(svc.serviceEndpoint);
    } catch {
      return null;
    }
  }

  private hasFakeOpenSocialGroupService(
    doc: {
      id?: string;
      service?: Array<{ id?: string; type?: string; serviceEndpoint?: unknown }>;
    },
    expectedEndpoint: string,
  ): boolean {
    return (doc.service ?? []).some((s) => {
      if (
        (s.id !== "#atgrp_host" && (doc.id === undefined || s.id !== `${doc.id}#atgrp_host`)) ||
        s.type !== "AtmosphereGroupHostV1" ||
        typeof s.serviceEndpoint !== "string"
      ) {
        return false;
      }
      try {
        return this.normalizeFakeTargetEndpoint(s.serviceEndpoint) === expectedEndpoint;
      } catch {
        return false;
      }
    });
  }

  private extractFakeVerificationMethodDidKey(
    doc: {
      id: string;
      verificationMethod?: Array<{ id?: string; type?: string; controller?: string; publicKeyMultibase?: string }>;
    },
    fragment: string,
  ): string | null {
    const vm = (doc.verificationMethod ?? []).find(
      (v) => v.id === fragment || v.id === `${doc.id}${fragment}`,
    );
    if (!vm || !vm.publicKeyMultibase) return null;
    if (vm.controller !== undefined && vm.controller !== doc.id) return null;
    try {
      if (vm.type === "EcdsaSecp256r1VerificationKey2019") {
        return formatDidKey(P256_JWT_ALG, multibaseToBytes(vm.publicKeyMultibase));
      }
      if (vm.type === "EcdsaSecp256k1VerificationKey2019") {
        return formatDidKey(SECP256K1_JWT_ALG, multibaseToBytes(vm.publicKeyMultibase));
      }
      return `did:key:${vm.publicKeyMultibase}`;
    } catch {
      return null;
    }
  }

  private async resolveFakePeerDidDoc(did: string): Promise<{
    id: string;
    verificationMethod?: Array<{ id?: string; type?: string; controller?: string; publicKeyMultibase?: string }>;
    service?: Array<{ id?: string; type?: string; serviceEndpoint?: unknown }>;
  } | null> {
    if (!did.startsWith("did:web:")) return null;
    let url: string;
    if (did === "did:web:fake-pds.test") {
      url = "https://fake-pds.test/group-host/.well-known/did.json";
    } else if (did.startsWith("did:web:fake-pds.test:")) {
      const slug = did.slice("did:web:fake-pds.test:".length);
      url = `https://fake-pds.test/${slug}/.well-known/did.json`;
    } else {
      const hostPart = decodeURIComponent(did.slice("did:web:".length));
      const isLoopback =
        hostPart === "localhost" ||
        hostPart.startsWith("localhost:") ||
        hostPart.startsWith("127.0.0.1") ||
        hostPart.startsWith("[::1]");
      url = `${isLoopback ? "http" : "https"}://${hostPart}/.well-known/did.json`;
    }
    const probeFetch = async (u: string): Promise<Response> =>
      this.hasOutboundHandler(u)
        ? this.sendOutbound(u, { method: "GET", headers: { accept: "application/did+ld+json, application/json" } })
        : this.fetchEndpoint(new Request(u, { method: "GET", headers: { accept: "application/did+ld+json, application/json" } }));
    const res = await probeFetch(url).catch(() => null);
    if (!res || !res.ok) return null;
    const doc = (await res.json().catch(() => null)) as {
      id?: unknown;
      verificationMethod?: Array<{ id?: string; type?: string; controller?: string; publicKeyMultibase?: string }>;
      service?: Array<{ id?: string; type?: string; serviceEndpoint?: unknown }>;
    } | null;
    if (!doc || doc.id !== did) return null;
    return doc as {
      id: string;
      verificationMethod?: Array<{ id?: string; type?: string; controller?: string; publicKeyMultibase?: string }>;
      service?: Array<{ id?: string; type?: string; serviceEndpoint?: unknown }>;
    };
  }

  private async verifyFakeOpenSocialTargetCapability(
    rawTargetEndpoint: string,
    sourceHostSlug = "group-host",
  ): Promise<{ mode: "coordinated" | "standard"; targetEndpoint: string; targetServiceDid: string }> {
    let targetEndpoint: string;
    try {
      targetEndpoint = this.normalizeFakeTargetEndpoint(rawTargetEndpoint);
    } catch {
      throw new FakeXrpcError(400, "InvalidRequest", "Invalid targetEndpoint URL");
    }
    if (targetEndpoint === this.hostEndpointUrl(sourceHostSlug)) {
      throw new FakeXrpcError(400, "InvalidRequest", "Cannot migrate group to the same host");
    }

    const nowSec = Math.floor(this.now() / 1000);
    const probeFetch = async (url: string): Promise<Response> =>
      this.hasOutboundHandler(url)
        ? this.sendOutbound(url, { method: "GET", headers: { accept: "application/json" } })
        : this.fetchEndpoint(new Request(url, { method: "GET", headers: { accept: "application/json" } }));

    let migInfoRes: Response | null = null;
    try {
      const res = await probeFetch(`${targetEndpoint}/group-admin/migration-info`);
      if (res.status === 200) {
        migInfoRes = res;
      }
    } catch {
      // Endpoint absent; fall through to Attempt 2 (`describeServer` + `#atgrp_host`)
    }

    if (migInfoRes !== null) {
      const info = (await migInfoRes.json().catch(() => null)) as {
        did?: unknown;
        supportedSpacePolicies?: unknown;
        atomicMigrationVersion?: unknown;
        capabilityProofJwt?: unknown;
      } | null;
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
        throw new FakeXrpcError(
          400,
          "UnsupportedGroupHostTarget",
          "Target host returned invalid /group-admin/migration-info metadata",
        );
      }

      const doc = await this.resolveFakePeerDidDoc(info.did);
      if (!doc || this.extractFakeDidPdsEndpoint(doc) !== targetEndpoint) {
        throw new FakeXrpcError(
          400,
          "UnsupportedGroupHostTarget",
          "Target host DID document #atproto_pds does not match endpoint",
        );
      }

      const jwtParts = info.capabilityProofJwt.split(".");
      if (jwtParts.length !== 3 || !jwtParts[0] || !jwtParts[1] || !jwtParts[2]) {
        throw new FakeXrpcError(400, "UnsupportedGroupHostTarget", "Malformed capabilityProofJwt");
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
          throw new Error("Invalid JWT JSON");
        }
        hdr = rawHdr as typeof hdr;
        claims = rawClaims as typeof claims;
      } catch {
        throw new FakeXrpcError(400, "UnsupportedGroupHostTarget", "Malformed capabilityProofJwt JSON");
      }

      if (
        hdr.typ !== "JWT" ||
        hdr.alg !== "ES256" ||
        (hdr.kid !== undefined && typeof hdr.kid !== "string")
      ) {
        throw new FakeXrpcError(400, "UnsupportedGroupHostTarget", "Invalid capabilityProofJwt protected header");
      }

      const frag =
        hdr.kid === undefined
          ? "#atproto"
          : hdr.kid.startsWith(`${doc.id}#`)
            ? hdr.kid.slice(doc.id.length)
            : hdr.kid;
      const isDesignatedSigningKey =
        frag === "#atproto" || /^#atproto-[A-Za-z0-9_-]{1,64}$/.test(frag);
      const didKey = isDesignatedSigningKey ? this.extractFakeVerificationMethodDidKey(doc, frag) : null;
      if (!didKey) {
        throw new FakeXrpcError(
          400,
          "UnsupportedGroupHostTarget",
          "capabilityProofJwt is not signed by a designated host signing key",
        );
      }

      let normalizedClaimEndpoint: string | null = null;
      if (typeof claims.endpoint === "string") {
        try {
          normalizedClaimEndpoint = this.normalizeFakeTargetEndpoint(claims.endpoint);
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
        normalizedClaimEndpoint !== targetEndpoint ||
        !Array.isArray(claims.supportedSpacePolicies) ||
        !claims.supportedSpacePolicies.includes(ATGRP_POLICY)
      ) {
        throw new FakeXrpcError(400, "UnsupportedGroupHostTarget", "Invalid capabilityProofJwt claims or lifetime");
      }

      const sigOk = await verifySignature(
        didKey,
        utf8Encoder.encode(`${jwtParts[0]}.${jwtParts[1]}`),
        Uint8Array.from(Buffer.from(jwtParts[2], "base64url")),
        { jwtAlg: hdr.alg },
      ).catch(() => false);
      if (!sigOk) {
        throw new FakeXrpcError(400, "UnsupportedGroupHostTarget", "Invalid capabilityProofJwt signature");
      }

      return {
        mode: claims.atomicMigrationVersion === 1 ? "coordinated" : "standard",
        targetEndpoint,
        targetServiceDid: info.did,
      };
    }

    try {
      const descRes = await probeFetch(`${targetEndpoint}/xrpc/com.atproto.server.describeServer`);
      if (descRes.ok) {
        const desc = (await descRes.json().catch(() => null)) as { did?: unknown } | null;
        if (desc && typeof desc.did === "string" && isDid(desc.did)) {
          const doc = await this.resolveFakePeerDidDoc(desc.did);
          if (
            doc &&
            this.extractFakeDidPdsEndpoint(doc) === targetEndpoint &&
            this.hasFakeOpenSocialGroupService(doc, targetEndpoint)
          ) {
            return {
              mode: "standard",
              targetEndpoint,
              targetServiceDid: desc.did,
            };
          }
        }
      }
    } catch {
      // Fall through to fail-closed error
    }

    throw new FakeXrpcError(
      400,
      "UnsupportedGroupHostTarget",
      `Target host ${targetEndpoint} does not advertise verifiable OpenSocial org.atgrp.policy capability`,
    );
  }

  private async describeFakeHostDidDoc(hostSlug = "group-host") {
    const svcDid = this.hostServiceDid(hostSlug);
    const endpoint = this.hostEndpointUrl(hostSlug);
    const kp = await this.hostServiceKeypair(hostSlug);
    const multibase = kp.did().replace(/^did:key:/, "");
    const isPersonalPds = this.isFakePersonalPdsHostSlug(hostSlug);
    return {
      "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
      id: svcDid,
      verificationMethod: [
        {
          id: `${svcDid}#atproto`,
          type: "Multikey",
          controller: svcDid,
          publicKeyMultibase: multibase,
        },
      ],
      service: [
        { id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: endpoint },
        ...(isPersonalPds
          ? []
          : [{ id: "#atgrp_host", type: "AtmosphereGroupHostV1", serviceEndpoint: endpoint }]),
      ],
    };
  }

  private describeFakeServer(hostSlug = "group-host") {
    return {
      did: this.hostServiceDid(hostSlug),
      availableUserDomains: [".groups.test"],
      inviteCodeRequired: false,
      phoneVerificationRequired: false,
      links: {},
      contact: {},
      blobUploadLimit: 10 * 1024 * 1024,
    };
  }

  private resolveFakeHandle(params: Record<string, unknown>) {
    const handle = typeof params.handle === "string" ? params.handle.trim().toLowerCase() : "";
    if (!handle) throw new FakeXrpcError(400, "InvalidRequest", "handle parameter required");
    const did = this.groupsByHandle.get(handle);
    const unavail = did ? this.unavailable.get(did) : undefined;
    if (!did || unavail === "RepoTakendown" || unavail === "RepoNotFound") {
      throw new FakeXrpcError(400, "UnableToResolveHandle", `Unable to resolve handle: ${handle}`);
    }
    return { did };
  }

  private async getFakeMigrationInfo(hostSlug = "group-host") {
    if (this.isFakePersonalPdsHostSlug(hostSlug)) {
      throw new FakeXrpcError(404, "NotFound", "Personal PDS does not serve /group-admin/migration-info");
    }
    const svcDid = this.hostServiceDid(hostSlug);
    const endpoint = this.hostEndpointUrl(hostSlug);
    const kp = await this.hostServiceKeypair(hostSlug);
    const nowSec = Math.floor(this.now() / 1000);
    const header = { alg: kp.jwtAlg, typ: "JWT", kid: "#atproto" };
    const payload = {
      iss: svcDid,
      iat: nowSec,
      exp: nowSec + 300,
      endpoint,
      supportedSpacePolicies: [ATGRP_POLICY],
      atomicMigrationVersion: 1,
    };
    const signingInput = `${jsonToB64Url(header)}.${jsonToB64Url(payload)}`;
    const sig = await kp.sign(utf8Encoder.encode(signingInput));
    const capabilityProofJwt = `${signingInput}.${toBase64(sig, "base64url")}`;
    return {
      did: svcDid,
      supportedSpacePolicies: [ATGRP_POLICY],
      blobUploadLimit: 10 * 1024 * 1024,
      migrationBlobUploadLimit: 100 * 1024 * 1024,
      maxRepoImportSize: 100 * 1024 * 1024,
      maxSpaceMetaImportSize: 100 * 1024 * 1024,
      maxManifestBytes: 4 * 1024 * 1024,
      atomicMigrationVersion: 1,
      capabilityProofJwt,
    };
  }

  private async getFakePublicGroupKeys(params: Record<string, unknown>) {
    const groupDid = typeof params.group === "string" ? params.group : "";
    if (!isDid(groupDid)) throw new FakeXrpcError(400, "InvalidRequest", "Invalid group DID");
    const operationId = typeof params.operationId === "string" ? params.operationId : undefined;
    if (operationId !== undefined && !isValidIdempotencyKey(operationId)) {
      throw new FakeXrpcError(400, "InvalidRequest", "Invalid operationId query parameter");
    }
    const grp = this.groups.get(groupDid);
    if (!grp || this.unavailable.get(groupDid) === "RepoNotFound") {
      throw new FakeXrpcError(400, "RepoNotFound", `Group ${groupDid} not hosted here`);
    }
    const nowMs = this.now();
    this.reapFakeExpiredPreparedMigrationLease(grp);
    if (operationId !== undefined) {
      this.assertFakeOperationIdNotAborted(groupDid, operationId, nowMs, this.accounts.get(groupDid) ?? "group-host");
    }
    const activeLease = grp.sourceMigrationLease;
    if (activeLease && operationId !== undefined && activeLease.operationId !== operationId) {
      throw new FakeXrpcError(
        409,
        "MigrationInProgress",
        "Active source migration lease does not match the requested operationId",
      );
    }
    const leaseAttemptId =
      activeLease &&
      activeLease.ticketId &&
      (operationId === undefined || activeLease.operationId === operationId)
        ? activeLease.ticketId
        : null;
    const signingKey = await this.signingKeypair(groupDid);
    const nowSec = Math.floor(nowMs / 1000);
    const header = { alg: "ES256", typ: "JWT", kid: "#atproto" };
    const payload = {
      iss: groupDid,
      aud: "*",
      iat: nowSec,
      exp: nowSec + 300,
      groupDid,
      localRotationKey: grp.localRotationKey.did(),
      ...(leaseAttemptId ? { leaseAttemptId } : {}),
    };
    const signingInput = `${jsonToB64Url(header)}.${jsonToB64Url(payload)}`;
    const sig = await signingKey.sign(utf8Encoder.encode(signingInput));
    return {
      groupDid,
      localRotationKey: grp.localRotationKey.did(),
      proofJwt: `${signingInput}.${toBase64(sig, "base64url")}`,
      ...(leaseAttemptId ? { leaseAttemptId } : {}),
    };
  }

  private async snapshotFakeMigrationManifest(params: {
    groupDid: string;
    operationId: string;
    deadlineAtMs: number;
    sourceLocalRotationKey: string;
  }): Promise<{ manifestJson: string; manifestDigest: string }> {
    const exportedCar = await this.exportFakePublicRepoCar(params.groupDid);
    const publicRecords: Array<{ collection: string; rkey: string; cid: string }> = [];
    for (const [key, entry] of this.publicRecords.get(params.groupDid)?.entries() ?? []) {
      const slash = key.indexOf("/");
      publicRecords.push({
        collection: key.slice(0, slash),
        rkey: key.slice(slash + 1),
        cid: entry.cid,
      });
    }
    const grp = this.groups.get(params.groupDid)!;
    const blobs = [...grp.blobs.keys()];

    const ownSpaces = new Set<string>();
    for (const [uri, sp] of this.spaces) {
      if (sp.ownerDid === params.groupDid && !sp.deleted) ownSpaces.add(uri);
    }
    const repoSpaces = new Set<string>(this.accountRepos.get(params.groupDid)?.keys() ?? []);
    const allSpaceUris = new Set<string>([...ownSpaces, ...repoSpaces]);
    const spaces: MigrationSpaceManifestEntry[] = [];
    const emptyDigestHex = Buffer.from(RepoCommit.fromRecords([]).setHash.digest()).toString("hex").toLowerCase();

    for (const spUri of allSpaceUris) {
      const isOwn = ownSpaces.has(spUri);
      if (!isOwn && parseSpaceUri(spUri)?.authorityDid === params.groupDid) continue;
      let spaceMetaSha256: string | null = null;
      if (isOwn) {
        const metaResp = await this.exportSpaceMeta({ space: spUri }, { kind: "self", did: params.groupDid, scope: "full" });
        const metaBytes = metaResp.body instanceof Uint8Array ? metaResp.body : new Uint8Array();
        spaceMetaSha256 = sha256HexBytesLocal(metaBytes);
      }
      let repoRootDataHex = emptyDigestHex;
      const accountRepo = this.accountRepos.get(params.groupDid)?.get(spUri);
      if (accountRepo) {
        const commit = this.commitForState(spUri, params.groupDid, accountRepo);
        repoRootDataHex = Buffer.from(commit.data).toString("hex").toLowerCase();
      }
      spaces.push({
        spaceUri: spUri,
        isOwnAuthority: isOwn,
        spaceMetaSha256,
        repoRootDataHex,
      });
    }

    return computeCanonicalMigrationManifest({
      groupDid: params.groupDid,
      operationId: params.operationId,
      deadlineAtMs: params.deadlineAtMs,
      sourceLocalRotationKey: params.sourceLocalRotationKey,
      publicRepoDataRootCid: exportedCar.dataRootCid,
      publicRecords,
      blobs,
      spaces,
    });
  }

  private async prepareFakeMigration(
    params: Record<string, unknown>,
    auth: FakeAuth,
    hostSlug = "group-host",
  ) {
    const sessionDid = this.requireSelf(auth, { scopes: "full", checkTakedown: true, checkDeactivated: true });
    const groupDid = typeof params.group === "string" ? params.group : "";
    const operationId = typeof params.operationId === "string" ? params.operationId : "";
    const targetEndpointRaw = typeof params.targetEndpoint === "string" ? params.targetEndpoint : "";
    const requestedMode = params.mode !== undefined ? params.mode : "auto";
    if (!groupDid || !operationId || !targetEndpointRaw) {
      throw new FakeXrpcError(400, "InvalidRequest", "group, operationId, and targetEndpoint are required");
    }
    if (requestedMode !== "auto" && requestedMode !== "coordinated" && requestedMode !== "standard") {
      throw new FakeXrpcError(400, "InvalidRequest", 'mode must be "auto", "coordinated", or "standard"');
    }
    if (groupDid !== sessionDid) {
      throw new FakeXrpcError(403, "Forbidden", "Session subject does not match group");
    }
    if (!isValidIdempotencyKey(operationId)) {
      throw new FakeXrpcError(400, "InvalidRequest", "Invalid operationId");
    }
    const nowMs = this.now();
    this.assertFakeFreshLoginStepUp(auth, nowMs, "prepare-migration requires prompt=login within 5 minutes");
    const { actorDid, approved, live } = this.narrowedGroupSessionPerms(auth, groupDid);
    if (
      !approved.allowsAccount({ attr: "repo", action: "manage" }) ||
      !live.allowsAccount({ attr: "repo", action: "manage" }) ||
      !approved.allowsIdentity({ attr: "*" }) ||
      !live.allowsIdentity({ attr: "*" })
    ) {
      throw new FakeXrpcError(403, "Forbidden", "Missing account:repo?action=manage or identity:*");
    }
    let targetEndpoint: string;
    try {
      const parsedUrl = new URL(targetEndpointRaw);
      targetEndpoint = normalizeBaseUrl(`${parsedUrl.origin}${parsedUrl.pathname}`);
    } catch {
      throw new FakeXrpcError(400, "InvalidRequest", "Invalid targetEndpoint URL");
    }
    if (targetEndpoint === this.hostEndpointUrl(hostSlug)) {
      throw new FakeXrpcError(400, "InvalidRequest", "Cannot migrate group to the same host");
    }

    const grp = this.requireActiveFakeGroup(groupDid);
    const liveState = this.loadFakeGovernanceState(groupDid);
    if (!this.isAuthorizedFakeLifecycleAdmin(actorDid, liveState, groupDid)) {
      throw new FakeXrpcError(403, "Forbidden", "Caller is not an authorized lifecycle admin");
    }
    this.reapFakeExpiredPreparedMigrationLease(grp);
    this.assertFakeOperationIdNotAborted(groupDid, operationId, nowMs, hostSlug);
    if (grp.sourceMigrationLease) {
      const existing = grp.sourceMigrationLease;
      if (
        existing.status === "prepared" &&
        existing.operationId === operationId &&
        existing.targetEndpoint === targetEndpoint &&
        (requestedMode === "auto" || existing.mode === requestedMode)
      ) {
        return {
          groupDid,
          operationId: existing.operationId,
          mode: existing.mode,
          targetEndpoint: existing.targetEndpoint,
          targetServiceDid: existing.targetServiceDid,
          deadlineAtMs: existing.deadlineAt,
          manifestDigest: existing.manifestDigest,
          migrationTicket:
            existing.mode === "coordinated" && existing.ticketId && existing.ticketSecret
              ? `v1.${existing.ticketId}.${existing.ticketSecret}`
              : null,
        };
      }
      throw new FakeXrpcError(409, "MigrationInProgress", "Another migration operation is already active");
    }

    const targetCap = await this.verifyFakeOpenSocialTargetCapability(targetEndpoint, hostSlug);
    if (requestedMode === "coordinated" && targetCap.mode !== "coordinated") {
      throw new FakeXrpcError(
        400,
        "CoordinatedMigrationUnsupported",
        "Target host does not support coordinated atomic migration",
      );
    }
    const targetServiceDid = targetCap.targetServiceDid;
    const mode: "coordinated" | "standard" = requestedMode === "standard" ? "standard" : targetCap.mode;

    const deadlineAtMs = nowMs + 2 * 3_600_000;
    const snap = await this.snapshotFakeMigrationManifest({
      groupDid,
      operationId,
      deadlineAtMs,
      sourceLocalRotationKey: grp.localRotationKey.did(),
    });
    const ticketId = randomUUID();
    const ticketSecret = mode === "coordinated" ? randomStr(32, "base64url").padEnd(43, "A").slice(0, 43) : null;

    grp.sourceMigrationLease = {
      operationId,
      mode,
      ticketId,
      ticketSecret,
      ticketSecretHash: ticketSecret ? sha256Hex(ticketSecret) : null,
      targetServiceDid,
      targetEndpoint,
      status: "prepared",
      signedPlcOp: null,
      frozenAt: nowMs,
      deadlineAt: deadlineAtMs,
      expiresAt: deadlineAtMs,
      manifestDigest: snap.manifestDigest,
      rootManifestJson: snap.manifestJson,
    };

    return {
      groupDid,
      operationId,
      mode,
      targetEndpoint,
      targetServiceDid,
      deadlineAtMs,
      manifestDigest: snap.manifestDigest,
      migrationTicket: mode === "coordinated" && ticketId && ticketSecret ? `v1.${ticketId}.${ticketSecret}` : null,
    };
  }

  private async getFakeMigrationManifest(
    params: Record<string, unknown>,
    auth: FakeAuth,
    requestHeaders: Headers | undefined,
    defaultHostSlug = "group-host",
  ) {
    const groupDid = typeof params.group === "string" ? params.group : "";
    const ticketId = typeof params.ticketId === "string" ? params.ticketId : "";
    if (!isDid(groupDid) || !ticketId) {
      throw new FakeXrpcError(400, "InvalidRequest", "group and ticketId query parameters are required");
    }
    const secret = requestHeaders?.get("x-group-migration-secret") ?? undefined;
    if (!secret || secret.length !== 43) {
      throw new FakeXrpcError(409, "InvalidMigrationTicket", "Missing or malformed X-Group-Migration-Secret");
    }
    const grp = this.groups.get(groupDid);
    if (grp) this.reapFakeExpiredPreparedMigrationLease(grp);
    const lease = grp?.sourceMigrationLease;
    if (!grp || !lease || lease.mode !== "coordinated" || lease.ticketId !== ticketId || !lease.ticketSecretHash) {
      throw new FakeXrpcError(409, "MigrationLeaseNotFound", "No matching coordinated migration lease");
    }
    if (sha256Hex(secret) !== lease.ticketSecretHash) {
      throw new FakeXrpcError(409, "InvalidMigrationTicket", "X-Group-Migration-Secret mismatch");
    }
    const hostSlug = this.accounts.get(groupDid) ?? defaultHostSlug;
    await this.verifyFakePeerServiceJwt(auth, {
      expectedIss: lease.targetServiceDid,
      expectedAud: this.hostServiceDid(hostSlug),
      expectedLxm: "com.atproto.server.createAccount",
      peerHost: true,
      expectedPeerEndpoint: lease.targetEndpoint,
      hostSlug,
    });
    return {
      groupDid,
      operationId: lease.operationId,
      ticketId: lease.ticketId,
      deadlineAtMs: lease.deadlineAt,
      sourceEndpoint: this.hostEndpointUrl(hostSlug),
      sourceServiceDid: this.hostServiceDid(hostSlug),
      sourceLocalRotationKey: grp.localRotationKey.did(),
      targetEndpoint: lease.targetEndpoint,
      targetServiceDid: lease.targetServiceDid,
      manifestDigest: lease.manifestDigest,
      manifestJson: lease.rootManifestJson,
    };
  }

  private async getFakeMigrationAttestation(
    params: Record<string, unknown>,
    auth: FakeAuth,
    hostSlug = "group-host",
  ) {
    const groupDid = typeof params.group === "string" ? params.group : "";
    const operationId = typeof params.operationId === "string" ? params.operationId : "";
    const ticketId = typeof params.ticketId === "string" ? params.ticketId : "";
    const grp = this.groups.get(groupDid);
    if (!grp || this.unavailable.get(groupDid) !== "RepoDeactivated") {
      throw new FakeXrpcError(409, "AlreadyActivated", "Group is not in unactivated target staging");
    }
    const sess = grp.migrationSession;
    if (
      !sess ||
      sess.mode !== "coordinated" ||
      sess.operationId !== operationId ||
      sess.ticketId !== ticketId ||
      !sess.sourceServiceDid ||
      !sess.expectedManifestJson ||
      !sess.manifestDigest ||
      !sess.sourceLocalRotationKey
    ) {
      throw new FakeXrpcError(409, "MigrationSessionMismatch", "No matching coordinated staging session");
    }
    await this.verifyFakePeerServiceJwt(auth, {
      expectedIss: sess.sourceServiceDid,
      expectedAud: this.hostServiceDid(hostSlug),
      expectedLxm: "com.atproto.identity.signPlcOperation",
      peerHost: true,
      expectedPeerEndpoint: sess.sourceEndpoint,
      hostSlug,
    });
    const stagedSnap = await this.snapshotFakeMigrationManifest({
      groupDid,
      operationId,
      deadlineAtMs: sess.absoluteDeadlineAt,
      sourceLocalRotationKey: sess.sourceLocalRotationKey,
    });
    if (stagedSnap.manifestJson !== sess.expectedManifestJson) {
      throw new FakeXrpcError(409, "MigrationManifestMismatch", "Staged target state does not match expected source manifest");
    }
    this.validateFakeStagedOpenSocialIntegrity(groupDid, grp);
    return {
      groupDid,
      operationId,
      ticketId,
      manifestDigest: sess.manifestDigest,
      targetEndpoint: this.hostEndpointUrl(hostSlug),
      targetServiceDid: this.hostServiceDid(hostSlug),
      targetSigningKey: sess.stagedSigningKey.did(),
      targetKemKey: sess.stagedKemKey.did(),
      targetLocalRotationKey: grp.localRotationKey.did(),
    };
  }

  private isSupportedFakePlcRotationDidKey(didKey: unknown): didKey is string {
    if (typeof didKey !== "string" || !didKey.startsWith("did:key:")) return false;
    try {
      const parsed = parseDidKey(didKey);
      return parsed.jwtAlg === "ES256" || parsed.jwtAlg === "ES256K";
    } catch {
      return false;
    }
  }

  private async createFakeMigrationAccount(
    params: Record<string, unknown>,
    auth: FakeAuth,
    requestHeaders: Headers | undefined,
    hostSlug = "group-host",
  ) {
    const did = typeof params.did === "string" ? params.did : "";
    const handle = typeof params.handle === "string" ? params.handle.trim().toLowerCase() : "";
    if (!isDid(did) || !handle) {
      throw new FakeXrpcError(400, "InvalidRequest", "did and handle are required");
    }
    const operationIdHeader = requestHeaders?.get("x-group-migration-operation-id") ?? undefined;
    if (operationIdHeader !== undefined && !isValidIdempotencyKey(operationIdHeader)) {
      throw new FakeXrpcError(400, "InvalidRequest", "Malformed X-Group-Migration-Operation-Id header");
    }
    const recoveryKey = params.recoveryKey;
    if (recoveryKey !== undefined && !this.isSupportedFakePlcRotationDidKey(recoveryKey)) {
      throw new FakeXrpcError(400, "InvalidRequest", "Unsupported recoveryKey format");
    }
    if (auth.kind !== "raw-token" || auth.scheme !== "bearer" || !auth.token) {
      throw new FakeXrpcError(401, "AuthMissing", "Service JWT Bearer token required for migration createAccount");
    }
    const targetSvcDid = this.hostServiceDid(hostSlug);
    const verifiedCallerJwt = await this.verifyFakePeerServiceJwt(auth, {
      expectedIss: did,
      expectedAud: targetSvcDid,
      expectedLxm: "com.atproto.server.createAccount",
      deferConsume: true,
      replayNamespace: "jwt",
      hostSlug,
    });

    const handleOwner = this.groupsByHandle.get(handle);
    if (handleOwner && handleOwner !== did && this.unavailable.get(handleOwner) !== "RepoNotFound") {
      throw new FakeXrpcError(400, "HandleNotAvailable", `Handle '${handle}' is already taken`);
    }

    const existingHost = this.accounts.get(did);
    const existingGrp = existingHost === hostSlug ? this.groups.get(did) : undefined;
    if (existingHost === hostSlug && this.unavailable.get(did) !== "RepoNotFound") {
      if (this.unavailable.get(did) !== "RepoDeactivated" || !existingGrp?.migrationSession) {
        throw new FakeXrpcError(400, "AlreadyHostedHere", `Account ${did} is already hosted on ${hostSlug}`);
      }
    }

    const sourceSigningDidKey = await this.resolveSigningKey(did).catch(() => undefined);
    if (!sourceSigningDidKey) {
      throw new FakeXrpcError(400, "UnresolvableDid", "Source group DID not found or tombstoned on PLC");
    }
    const sourceLiveRotationKeys = await this.resolveRotationKeys(did, hostSlug);

    let sourceHostSlug = "group-host";
    let sourceEndpoint = "https://fake-pds.test/group-host";
    if (existingHost && existingHost !== hostSlug) {
      sourceHostSlug = existingHost;
      sourceEndpoint = this.hostEndpointUrl(existingHost);
    } else if (this.peerNetwork?.accounts.has(did)) {
      const peerSlug = this.peerNetwork.accounts.get(did)!;
      if (peerSlug === hostSlug) {
        throw new FakeXrpcError(400, "AlreadyHostedHere", `Account ${did} is already hosted on ${hostSlug}`);
      }
      sourceHostSlug = peerSlug;
      sourceEndpoint = this.peerNetwork.hostEndpointUrl(peerSlug);
    }

    const nowMs = this.now();
    const nowSec = Math.floor(nowMs / 1000);
    const ticketHeader = requestHeaders?.get("x-group-migration-ticket") ?? undefined;
    let parsedTicket: { ticketId: string; secret: string } | null = null;
    if (ticketHeader !== undefined) {
      const m = /^v1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/i.exec(
        ticketHeader,
      );
      if (!m) throw new FakeXrpcError(400, "InvalidMigrationTicket", "Malformed X-Group-Migration-Ticket");
      parsedTicket = { ticketId: m[1]!, secret: m[2]! };
    }
    const provenanceHeader = requestHeaders?.get("x-group-migration-key-provenance") ?? undefined;

    const existingSess = existingGrp?.migrationSession ?? null;
    if (
      existingSess &&
      existingSess.plcCutoverAt === null &&
      nowMs >= existingSess.absoluteDeadlineAt &&
      existingSess.operationId !== null
    ) {
      this.recordFakeAbortedOperation(did, existingSess.operationId, nowMs + 2 * 3_600_000, hostSlug);
    }

    this.assertFakeOperationIdNotAborted(did, operationIdHeader, nowMs, hostSlug);

    const rotateExistingSessionTokens = (grp: FakeGroupState, sess: NonNullable<FakeGroupState["migrationSession"]>) => {
      verifiedCallerJwt.consumeJti();
      const accessExpSec = Math.max(Math.min(nowSec + 900, Math.ceil(sess.absoluteDeadlineAt / 1000)), nowSec + 1);
      const refreshExpSec = nowSec + 30 * 86_400;
      const accessToken = this.issueFakeMigrationJwt(did, sess.id, sess.accessJti, "at+jwt", accessExpSec);
      const refreshToken = this.issueFakeMigrationJwt(
        did,
        sess.id,
        sess.refreshJti,
        "refresh+jwt",
        refreshExpSec,
      );
      this.migrationTokens.set(accessToken, {
        did,
        sessionId: sess.id,
        jti: sess.accessJti,
        tokenKind: "access",
        authEpoch: grp.authEpoch,
        expSec: accessExpSec,
      });
      this.migrationTokens.set(refreshToken, {
        did,
        sessionId: sess.id,
        jti: sess.refreshJti,
        tokenKind: "refresh",
        authEpoch: grp.authEpoch,
        expSec: refreshExpSec,
      });
      return { did, handle, accessJwt: accessToken, refreshJwt: refreshToken };
    };

    if (existingGrp && existingSess && (existingSess.plcCutoverAt !== null || nowMs < existingSess.absoluteDeadlineAt)) {
      if (existingSess.plcCutoverAt !== null) {
        throw new FakeXrpcError(409, "MigrationInProgress", "Migration cutover already committed");
      }
      if (
        parsedTicket &&
        existingSess.mode === "coordinated" &&
        existingSess.ticketId === parsedTicket.ticketId &&
        existingSess.ticketSecretHash &&
        existingGrp.handle === handle
      ) {
        if (operationIdHeader !== undefined && operationIdHeader !== existingSess.operationId) {
          throw new FakeXrpcError(
            400,
            "InvalidRequest",
            "X-Group-Migration-Operation-Id does not match coordinated manifest operationId",
          );
        }
        this.assertFakeOperationIdNotAborted(did, existingSess.operationId, nowMs, hostSlug);
        const actualHash = Buffer.from(
          createHash("sha256").update(parsedTicket.secret, "utf8").digest("hex"),
          "hex",
        );
        const expectedHash = Buffer.from(existingSess.ticketSecretHash, "hex");
        if (actualHash.byteLength === expectedHash.byteLength && timingSafeEqual(actualHash, expectedHash)) {
          return rotateExistingSessionTokens(existingGrp, existingSess);
        }
      }
    }

    const fetchFromSource = async (url: string, init: RequestInit): Promise<Response> => {
      if (this.hasOutboundHandler(url)) return this.sendOutbound(url, init);
      if (this.peerNetwork?.accounts.has(did)) return this.peerNetwork.fetchEndpoint(new Request(url, init));
      if (existingHost && existingHost !== hostSlug) return this.fetchEndpoint(new Request(url, init));
      return new Response(JSON.stringify({ error: "NotFound" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    };

    let mode: "coordinated" | "standard" = "standard";
    let operationId: string | null = operationIdHeader ?? null;
    let ticketId: string | null = null;
    let provenanceJti: string | null = null;
    let sourceServiceDid: string | null = null;
    let sourceLocalRotationKey: string | null = null;
    let manifestDigest: string | null = null;
    let expectedManifestJson: string | null = null;
    let deadlineAtMs = nowMs + 2 * 3_600_000;

    if (parsedTicket) {
      ticketId = parsedTicket.ticketId;
      const secret = parsedTicket.secret;
      if (this.usedServiceJtis.has(`aborted-ticket\u0000${did}\u0000${ticketId}`)) {
        throw new FakeXrpcError(409, "InvalidMigrationTicket", "Migration ticket was aborted");
      }

      const infoUrl = `${sourceEndpoint}/group-admin/migration-info`;
      const infoRes = await fetchFromSource(infoUrl, {
        method: "GET",
        headers: { accept: "application/json" },
      });
      if (!infoRes.ok) {
        throw new FakeXrpcError(502, "SourceHostUnavailable", "Could not fetch source migration-info");
      }
      const infoBody = (await infoRes.json().catch(() => null)) as { did?: unknown } | null;
      if (!infoBody || typeof infoBody.did !== "string" || !isDid(infoBody.did)) {
        throw new FakeXrpcError(502, "InvalidSourceMigrationInfo", "Source migration-info missing DID");
      }
      const expectedSourceDid = this.hostServiceDid(sourceHostSlug);
      if (infoBody.did.startsWith("did:web:fake-pds.test") && infoBody.did !== expectedSourceDid) {
        throw new FakeXrpcError(400, "InvalidSourceMigrationInfo", "Source service DID #atproto_pds mismatch");
      }
      sourceServiceDid = infoBody.did;

      const peerJwt = await this.signFakeServiceJwt({
        issDid: targetSvcDid,
        aud: sourceServiceDid,
        lxm: "com.atproto.server.createAccount",
      });
      const manifestUrl = `${sourceEndpoint}/group-admin/migration-manifest?group=${encodeURIComponent(did)}&ticketId=${encodeURIComponent(ticketId)}`;
      const res = await fetchFromSource(manifestUrl, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${peerJwt}`,
          "x-group-migration-secret": secret,
        },
      });
      if (!res.ok) {
        throw new FakeXrpcError(409, "InvalidMigrationTicket", `Source rejected migration-manifest pull (${res.status})`);
      }
      const env = (await res.json().catch(() => null)) as {
        groupDid?: unknown;
        ticketId?: unknown;
        operationId?: unknown;
        deadlineAtMs?: unknown;
        sourceEndpoint?: unknown;
        sourceServiceDid?: unknown;
        sourceLocalRotationKey?: unknown;
        targetEndpoint?: unknown;
        targetServiceDid?: unknown;
        manifestDigest?: unknown;
        manifestJson?: unknown;
      } | null;

      let normalizedManifestTarget: string | null = null;
      if (typeof env?.targetEndpoint === "string") {
        try {
          const u = new URL(env.targetEndpoint);
          normalizedManifestTarget = normalizeBaseUrl(`${u.origin}${u.pathname}`);
        } catch {
          normalizedManifestTarget = null;
        }
      }

      if (
        !env ||
        env.groupDid !== did ||
        env.ticketId !== ticketId ||
        env.sourceServiceDid !== sourceServiceDid ||
        env.targetServiceDid !== targetSvcDid ||
        normalizedManifestTarget !== this.hostEndpointUrl(hostSlug) ||
        typeof env.operationId !== "string" ||
        !isValidIdempotencyKey(env.operationId) ||
        typeof env.deadlineAtMs !== "number" ||
        !Number.isFinite(env.deadlineAtMs) ||
        env.deadlineAtMs <= nowMs ||
        env.deadlineAtMs > nowMs + 2 * 3_600_000 + 60_000 ||
        typeof env.manifestDigest !== "string" ||
        typeof env.manifestJson !== "string" ||
        !verifyMigrationManifestDigest(env.manifestJson, env.manifestDigest)
      ) {
        throw new FakeXrpcError(400, "InvalidMigrationManifest", "Source migration-manifest failed verification");
      }

      if (
        !this.isSupportedFakePlcRotationDidKey(env.sourceLocalRotationKey) ||
        !sourceLiveRotationKeys.includes(env.sourceLocalRotationKey)
      ) {
        throw new FakeXrpcError(
          400,
          "InvalidSourceKeyProof",
          "Coordinated migration-manifest sourceLocalRotationKey is invalid or absent from live PLC rotationKeys",
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
        parsedInnerManifest = JSON.parse(env.manifestJson) as InnerManifestHeader;
      } catch {
        parsedInnerManifest = null;
      }
      if (
        !parsedInnerManifest ||
        parsedInnerManifest.version !== 1 ||
        parsedInnerManifest.groupDid !== did ||
        parsedInnerManifest.operationId !== env.operationId ||
        parsedInnerManifest.deadlineAtMs !== env.deadlineAtMs ||
        parsedInnerManifest.sourceLocalRotationKey !== env.sourceLocalRotationKey
      ) {
        throw new FakeXrpcError(
          400,
          "InvalidMigrationManifest",
          "Canonical migration-manifest inner fields do not match envelope",
        );
      }

      if (operationIdHeader !== undefined && operationIdHeader !== env.operationId) {
        throw new FakeXrpcError(
          400,
          "InvalidRequest",
          "X-Group-Migration-Operation-Id does not match coordinated manifest operationId",
        );
      }
      mode = "coordinated";
      operationId = env.operationId;
      deadlineAtMs = env.deadlineAtMs;
      sourceLocalRotationKey = env.sourceLocalRotationKey;
      manifestDigest = env.manifestDigest;
      expectedManifestJson = env.manifestJson;
    } else if (provenanceHeader !== undefined) {
      mode = "standard";
      operationId = operationIdHeader ?? null;
      deadlineAtMs = nowMs + 2 * 3_600_000;
      if (Buffer.byteLength(provenanceHeader, "utf8") > 4096) {
        throw new FakeXrpcError(400, "InvalidSourceKeyProof", "Provenance JWS exceeds 4 KiB");
      }
      const provSegs = provenanceHeader.split(".");
      if (provSegs.length !== 3 || !provSegs[0] || !provSegs[1] || !provSegs[2]) {
        throw new FakeXrpcError(400, "InvalidSourceKeyProof", "Malformed X-Group-Migration-Key-Provenance JWS");
      }
      let provHeader: { typ?: unknown; alg?: unknown; kid?: unknown };
      let rawClaims: {
        iss?: unknown;
        sub?: unknown;
        aud?: unknown;
        act?: unknown;
        jti?: unknown;
        iat?: unknown;
        exp?: unknown;
        sourceLocalRotationKey?: unknown;
      };
      try {
        provHeader = JSON.parse(Buffer.from(provSegs[0], "base64url").toString("utf8")) as typeof provHeader;
        rawClaims = JSON.parse(Buffer.from(provSegs[1], "base64url").toString("utf8")) as typeof rawClaims;
      } catch {
        throw new FakeXrpcError(400, "InvalidSourceKeyProof", "Malformed X-Group-Migration-Key-Provenance JSON");
      }
      const kSov = provHeader.kid;
      if (
        provHeader.typ !== "JWT" ||
        (provHeader.alg !== "ES256" && provHeader.alg !== "ES256K") ||
        !this.isSupportedFakePlcRotationDidKey(kSov) ||
        !sourceLiveRotationKeys.includes(kSov) ||
        rawClaims.iss !== kSov ||
        rawClaims.sub !== did ||
        rawClaims.aud !== targetSvcDid ||
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
          (this.isSupportedFakePlcRotationDidKey(rawClaims.sourceLocalRotationKey) &&
            sourceLiveRotationKeys.includes(rawClaims.sourceLocalRotationKey) &&
            rawClaims.sourceLocalRotationKey !== kSov)
        )
      ) {
        throw new FakeXrpcError(400, "InvalidSourceKeyProof", "Invalid X-Group-Migration-Key-Provenance claims");
      }
      const provSigOk = await verifySignature(
        kSov,
        utf8Encoder.encode(`${provSegs[0]}.${provSegs[1]}`),
        Uint8Array.from(Buffer.from(provSegs[2], "base64url")),
        { jwtAlg: provHeader.alg },
      ).catch(() => false);
      if (!provSigOk) {
        throw new FakeXrpcError(400, "InvalidSourceKeyProof", "Invalid X-Group-Migration-Key-Provenance signature");
      }
      provenanceJti = rawClaims.jti;
      sourceLocalRotationKey = rawClaims.sourceLocalRotationKey as string | null;
    } else {
      mode = "standard";
      operationId = operationIdHeader ?? null;
      deadlineAtMs = nowMs + 2 * 3_600_000;

      let negotiatedResolved = false;
      const pkUrl =
        `${sourceEndpoint}/group-admin/public-group-keys?group=${encodeURIComponent(did)}` +
        (operationId ? `&operationId=${encodeURIComponent(operationId)}` : "");
      let pkRes: Response;
      try {
        pkRes = await fetchFromSource(pkUrl, {
          method: "GET",
          headers: { accept: "application/json" },
        });
      } catch {
        throw new FakeXrpcError(
          502,
          "SourceHostUnavailable",
          "Could not reach source host /group-admin/public-group-keys",
        );
      }
      if (pkRes.status === 409) {
        const conflictBody = (await pkRes.json().catch(() => null)) as { error?: unknown; message?: unknown } | null;
        if (conflictBody?.error === "OperationIdAlreadyAborted") {
          throw new FakeXrpcError(
            409,
            "OperationIdAlreadyAborted",
            typeof conflictBody.message === "string"
              ? conflictBody.message
              : `Migration operationId '${operationId}' was already aborted on source`,
          );
        }
        if (conflictBody?.error === "MigrationInProgress") {
          throw new FakeXrpcError(
            409,
            "MigrationInProgress",
            typeof conflictBody.message === "string"
              ? conflictBody.message
              : "Source host already has an active migration lease for a different operationId",
          );
        }
        throw new FakeXrpcError(
          502,
          "SourceHostUnavailable",
          "Source /group-admin/public-group-keys returned unexpected 409",
        );
      }
      if (pkRes.status === 200) {
        const rawText = await pkRes.text().catch(() => {
          throw new FakeXrpcError(400, "InvalidSourceKeyProof", "Malformed public-group-keys response");
        });
        if (Buffer.byteLength(rawText, "utf8") > 65_536) {
          throw new FakeXrpcError(400, "InvalidSourceKeyProof", "public-group-keys response exceeds 64 KiB");
        }
        let pkBody: {
          groupDid?: unknown;
          localRotationKey?: unknown;
          proofJwt?: unknown;
          leaseAttemptId?: unknown;
        } | null;
        try {
          pkBody = JSON.parse(rawText) as {
            groupDid?: unknown;
            localRotationKey?: unknown;
            proofJwt?: unknown;
            leaseAttemptId?: unknown;
          } | null;
        } catch {
          throw new FakeXrpcError(400, "InvalidSourceKeyProof", "Malformed public-group-keys JSON");
        }
        if (
          !pkBody ||
          pkBody.groupDid !== did ||
          typeof pkBody.localRotationKey !== "string" ||
          typeof pkBody.proofJwt !== "string" ||
          (pkBody.leaseAttemptId !== undefined &&
            (typeof pkBody.leaseAttemptId !== "string" || pkBody.leaseAttemptId.trim().length === 0))
        ) {
          throw new FakeXrpcError(400, "InvalidSourceKeyProof", "Malformed public-group-keys response");
        }
        const jwtSegs = pkBody.proofJwt.split(".");
        if (jwtSegs.length !== 3 || !jwtSegs[0] || !jwtSegs[1] || !jwtSegs[2]) {
          throw new FakeXrpcError(400, "InvalidSourceKeyProof", "Malformed public-group-keys proofJwt");
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
          throw new FakeXrpcError(400, "InvalidSourceKeyProof", "Malformed public-group-keys proofJwt JSON");
        }
        if (
          proofHeader.typ !== "JWT" ||
          (proofHeader.alg !== "ES256" && proofHeader.alg !== "ES256K") ||
          (proofHeader.kid !== undefined && proofHeader.kid !== "#atproto" && proofHeader.kid !== `${did}#atproto`)
        ) {
          throw new FakeXrpcError(400, "InvalidSourceKeyProof", "Invalid proofJwt protected header");
        }
        if (
          proofClaims.iss !== did ||
          proofClaims.groupDid !== did ||
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
          !this.isSupportedFakePlcRotationDidKey(proofClaims.localRotationKey) ||
          !sourceLiveRotationKeys.includes(proofClaims.localRotationKey)
        ) {
          throw new FakeXrpcError(400, "InvalidSourceKeyProof", "Invalid public-group-keys proofJwt claims");
        }
        const proofSigOk = await verifySignature(
          sourceSigningDidKey,
          utf8Encoder.encode(`${jwtSegs[0]}.${jwtSegs[1]}`),
          Uint8Array.from(Buffer.from(jwtSegs[2], "base64url")),
          { jwtAlg: proofHeader.alg },
        ).catch(() => false);
        if (!proofSigOk) {
          throw new FakeXrpcError(400, "InvalidSourceKeyProof", "Invalid public-group-keys proofJwt signature");
        }
        sourceLocalRotationKey = proofClaims.localRotationKey;
        ticketId = typeof pkBody.leaseAttemptId === "string" ? pkBody.leaseAttemptId : null;
        negotiatedResolved = true;
      } else if (pkRes.status !== 404 && pkRes.status !== 501) {
        throw new FakeXrpcError(
          502,
          "SourceHostUnavailable",
          `Source /group-admin/public-group-keys failed (${pkRes.status})`,
        );
      }

      if (!negotiatedResolved) {
        if (sourceLiveRotationKeys.length === 1) {
          const soleKey = sourceLiveRotationKeys[0]!;
          sourceLocalRotationKey = recoveryKey === soleKey ? null : soleKey;
        } else {
          throw new FakeXrpcError(
            400,
            "ProvenanceRequired",
            "Multi-key source host lacks /group-admin/public-group-keys; supply X-Group-Migration-Key-Provenance signed by a sovereign PLC rotation key.",
          );
        }
      }
    }

    this.assertFakeOperationIdNotAborted(did, operationId, nowMs, hostSlug);
    if (mode === "standard" && ticketId) {
      const attemptExp = this.abortedMigrationLeaseAttempts.get(`${hostSlug}\u0000${did}\u0000${ticketId}`);
      if (attemptExp !== undefined && attemptExp > nowMs) {
        throw new FakeXrpcError(409, "OperationIdAlreadyAborted", "Migration lease attempt was already aborted");
      }
    }

    if (sourceLocalRotationKey !== null && recoveryKey === sourceLocalRotationKey) {
      throw new FakeXrpcError(
        400,
        "SourceRotationKeyRetained",
        "recoveryKey cannot retain the retiring source host's rotation key",
      );
    }

    const localRotationKey = await P256Keypair.create();
    const preservedSovereignKeys = [
      ...new Set([
        ...sourceLiveRotationKeys.filter(
          (k) => k !== sourceLocalRotationKey && k !== localRotationKey.did(),
        ),
        ...(typeof recoveryKey === "string" &&
        recoveryKey !== localRotationKey.did() &&
        recoveryKey !== sourceLocalRotationKey
          ? [recoveryKey]
          : []),
      ]),
    ];
    if (1 + preservedSovereignKeys.length > 5) {
      throw new FakeXrpcError(
        400,
        "TooManyRotationKeys",
        "Target rotation key plus preserved sovereign rotation keys would exceed PLC's 5-key limit",
      );
    }

    if (existingGrp && existingSess && nowMs < existingSess.absoluteDeadlineAt) {
      const operationIdMatchesForReplay =
        existingSess.operationId !== null ? operationId === existingSess.operationId : operationId === null;
      const existingPreserved = [...existingGrp.sovereignRotationKeys];
      if (
        mode === "standard" &&
        existingSess.mode === "standard" &&
        operationIdMatchesForReplay &&
        existingSess.ticketId === ticketId &&
        existingGrp.handle === handle &&
        existingSess.sourceEndpoint === sourceEndpoint &&
        JSON.stringify(existingPreserved) === JSON.stringify(preservedSovereignKeys)
      ) {
        if (provenanceJti !== null && this.revokedMigrationJtis.has(`prov:${provenanceJti}`)) {
          throw new FakeXrpcError(401, "ReplayDetected", "Provenance JTI already consumed");
        }
        if (provenanceJti !== null) {
          this.revokedMigrationJtis.add(`prov:${provenanceJti}`);
        }
        return rotateExistingSessionTokens(existingGrp, existingSess);
      }
      throw new FakeXrpcError(
        409,
        "MigrationInProgress",
        "An active migration staging session with different parameters already exists",
      );
    }

    if (provenanceJti !== null) {
      if (this.revokedMigrationJtis.has(`prov:${provenanceJti}`)) {
        throw new FakeXrpcError(401, "ReplayDetected", "Provenance JTI already consumed");
      }
      this.revokedMigrationJtis.add(`prov:${provenanceJti}`);
    }

    verifiedCallerJwt.consumeJti();
    if (mode === "coordinated" && ticketId) {
      this.recordFakeAbortStorageEntry(did, `ticket:${ticketId}`, deadlineAtMs, hostSlug);
    }

    const sessionId = randomUUID();
    const accessJti = randomUUID();
    const refreshJti = randomUUID();
    const nextAuthEpoch = (existingGrp?.authEpoch ?? 0) + 1;
    const accessExpSec = Math.max(Math.min(nowSec + 900, Math.ceil(deadlineAtMs / 1000)), nowSec + 1);
    const refreshExpSec = nowSec + 30 * 86_400;
    const accessToken = this.issueFakeMigrationJwt(did, sessionId, accessJti, "at+jwt", accessExpSec);
    const refreshToken = this.issueFakeMigrationJwt(did, sessionId, refreshJti, "refresh+jwt", refreshExpSec);

    // Purge any expired prior staging on `hostSlug` before creating the fresh staging session
    if (existingGrp && existingHost === hostSlug) {
      if (existingSess) {
        this.revokedMigrationJtis.add(existingSess.accessJti);
        this.revokedMigrationJtis.add(existingSess.refreshJti);
      }
      this.groupsByHandle.delete(existingGrp.handle);
      for (const [spUri, sp] of this.spaces) {
        if (sp.ownerDid === did) this.spaces.delete(spUri);
      }
      this.publicRecords.delete(did);
      this.accountRepos.delete(did);
      this.groups.delete(did);
    }

    if (!this.groups.has(did)) {
      this.accounts.set(did, hostSlug);
      const stagedSigningKey = await P256Keypair.create({ exportable: true });
      const stagedKemKey = await P256Keypair.create({ exportable: true });
      if (!this.signingKeys.has(did)) {
        this.signingKeys.set(did, Promise.resolve(stagedSigningKey));
      }
      if (!this.kemKeys.has(did)) {
        this.kemKeys.set(did, Promise.resolve(stagedKemKey));
      }
      const stagedGroup: FakeGroupState = {
        did,
        handle,
        authEpoch: nextAuthEpoch,
        localRotationKey,
        knownAppSubjects: new Set(),
        sovereignRotationKeys: new Set(preservedSovereignKeys),
        priorEjectCounts: new Map(),
        joinRequests: new Map(),
        joinOperations: new Map(),
        modSubjects: new Map(),
        modEvents: [],
        modEjectionEligibility: new Map(),
        nextModSeq: 1,
        inviteDeliveries: new Map(),
        recoveryAdmin: null,
        actionTokens: new Map(),
        blobs: new Map(),
        spaceIndexRkeys: new Map(),
        sourceMigrationLease: null,
        migrationSession: {
          id: sessionId,
          mode,
          operationId,
          ticketId,
          ticketSecretHash: parsedTicket
            ? createHash("sha256").update(parsedTicket.secret, "utf8").digest("hex")
            : null,
          sourceEndpoint,
          sourceServiceDid,
          sourceLocalRotationKey,
          manifestDigest,
          expectedManifestJson,
          stagedSigningKey,
          stagedKemKey,
          accessJti,
          refreshJti,
          prevRefreshJti: null,
          refreshIdempotencyKey: null,
          refreshGraceExpiresAt: null,
          authEpoch: nextAuthEpoch,
          plcCutoverAt: null,
          absoluteDeadlineAt: deadlineAtMs,
          createdAt: nowMs,
        },
      };
      this.groups.set(did, stagedGroup);
      this.groupsByHandle.set(handle, did);
      this.unavailable.set(did, "RepoDeactivated");
      this.migrationTokens.set(accessToken, {
        did,
        sessionId,
        jti: accessJti,
        tokenKind: "access",
        authEpoch: nextAuthEpoch,
        expSec: accessExpSec,
      });
      this.migrationTokens.set(refreshToken, {
        did,
        sessionId,
        jti: refreshJti,
        tokenKind: "refresh",
        authEpoch: nextAuthEpoch,
        expSec: refreshExpSec,
      });
    }

    return {
      did,
      handle,
      accessJwt: accessToken,
      refreshJwt: refreshToken,
    };
  }

  private issueFakeMigrationJwt(
    did: string,
    sessionId: string,
    jti: string,
    typ: "at+jwt" | "refresh+jwt",
    expSec: number,
  ): string {
    const header = { alg: "ES256", typ };
    const payload = {
      sub: did,
      sid: sessionId,
      jti,
      nonce: randomUUID(),
      iat: Math.floor(this.now() / 1000),
      exp: expSec,
    };
    return `${jsonToB64Url(header)}.${jsonToB64Url(payload)}.fakesig`;
  }

  private async refreshFakeMigrationSession(auth: FakeAuth, requestHeaders?: Headers) {
    const rawIdemHeader = requestHeaders?.get("idempotency-key") ?? undefined;
    if (rawIdemHeader !== undefined && !isValidIdempotencyKey(rawIdemHeader)) {
      throw new FakeXrpcError(
        400,
        "InvalidIdempotencyKey",
        "Idempotency-Key must be 1..128 [A-Za-z0-9._:-] characters.",
      );
    }
    if (auth.kind === "none") {
      throw new FakeXrpcError(401, "AuthMissing", "Migration Bearer token required");
    }
    if (auth.kind === "rejected") {
      throw auth.error;
    }
    if (auth.kind !== "migration" || auth.tokenKind !== "refresh") {
      throw new FakeXrpcError(401, "ExpiredToken", "Invalid migration refresh token");
    }
    const nowMs = this.now();
    const nowSec = Math.floor(nowMs / 1000);
    if (nowSec >= auth.expSec) {
      throw new FakeXrpcError(401, "ExpiredToken", "Migration refresh token expired");
    }

    return this.withFakeGroupLock(auth.did, () => {
      const lockNowMs = this.now();
      const lockNowSec = Math.floor(lockNowMs / 1000);
      const grp = this.groups.get(auth.did);
      const sess = grp?.migrationSession;

      const matchesIdempotentGrace = Boolean(
        rawIdemHeader &&
          grp &&
          sess &&
          sess.id === auth.sessionId &&
          sess.authEpoch === auth.authEpoch &&
          grp.authEpoch === auth.authEpoch &&
          sess.prevRefreshJti === auth.jti &&
          sess.refreshIdempotencyKey === rawIdemHeader &&
          sess.refreshGraceExpiresAt !== null &&
          lockNowMs < sess.refreshGraceExpiresAt,
      );

      if (matchesIdempotentGrace && grp && sess) {
        if (sess.plcCutoverAt === null && lockNowMs >= sess.absoluteDeadlineAt) {
          this.reconcileFakeUncutoverMigrationSession(auth.did, grp, lockNowMs);
        }
        if (sess.plcCutoverAt === null && lockNowMs >= sess.absoluteDeadlineAt) {
          throw new FakeXrpcError(401, "ExpiredToken", "Migration session deadline expired");
        }
        if (this.unavailable.get(auth.did) === "RepoTakendown") {
          throw new FakeXrpcError(400, "RepoTakendown", "Group is taken down");
        }
        if (this.unavailable.get(auth.did) !== "RepoDeactivated") {
          throw new FakeXrpcError(400, "AlreadyActivated", "Group is already activated");
        }
        const accessExpSec =
          sess.plcCutoverAt !== null
            ? lockNowSec + 900
            : Math.max(Math.min(lockNowSec + 900, Math.ceil(sess.absoluteDeadlineAt / 1000)), lockNowSec + 1);
        const refreshExpSec = lockNowSec + 30 * 86_400;
        const accessJwt = this.issueFakeMigrationJwt(auth.did, sess.id, sess.accessJti, "at+jwt", accessExpSec);
        const refreshJwt = this.issueFakeMigrationJwt(
          auth.did,
          sess.id,
          sess.refreshJti,
          "refresh+jwt",
          refreshExpSec,
        );
        this.migrationTokens.set(accessJwt, {
          did: auth.did,
          sessionId: sess.id,
          jti: sess.accessJti,
          tokenKind: "access",
          authEpoch: grp.authEpoch,
          expSec: accessExpSec,
        });
        this.migrationTokens.set(refreshJwt, {
          did: auth.did,
          sessionId: sess.id,
          jti: sess.refreshJti,
          tokenKind: "refresh",
          authEpoch: grp.authEpoch,
          expSec: refreshExpSec,
        });
        return {
          did: auth.did,
          handle: grp.handle,
          accessJwt,
          refreshJwt,
        };
      }

      if (this.revokedMigrationJtis.has(auth.jti)) {
        this.purgeFakeUncutoverStagingOnReplay(auth.did, auth.sessionId, auth.authEpoch, lockNowMs);
        throw new FakeXrpcError(401, "InvalidToken", "Revoked migration token JTI replayed");
      }

      if (!grp || !sess) {
        throw new FakeXrpcError(401, "InvalidToken", "Migration session not found");
      }
      if (sess.authEpoch !== auth.authEpoch || grp.authEpoch !== auth.authEpoch) {
        throw new FakeXrpcError(401, "InvalidToken", "Migration token JTI or epoch mismatch");
      }
      if (sess.id !== auth.sessionId || sess.refreshJti !== auth.jti) {
        this.purgeFakeUncutoverStagingOnReplay(auth.did, auth.sessionId, auth.authEpoch, lockNowMs);
        throw new FakeXrpcError(401, "InvalidToken", "Migration refresh token JTI replay or mismatch");
      }
      if (sess.plcCutoverAt === null && lockNowMs >= sess.absoluteDeadlineAt) {
        this.reconcileFakeUncutoverMigrationSession(auth.did, grp, lockNowMs);
      }
      if (sess.plcCutoverAt === null && lockNowMs >= sess.absoluteDeadlineAt) {
        throw new FakeXrpcError(401, "ExpiredToken", "Migration session deadline expired");
      }
      if (this.unavailable.get(auth.did) === "RepoTakendown") {
        throw new FakeXrpcError(400, "RepoTakendown", "Group is taken down");
      }
      if (this.unavailable.get(auth.did) !== "RepoDeactivated") {
        throw new FakeXrpcError(400, "AlreadyActivated", "Group is already activated");
      }

      const prevRefreshJti = auth.jti;
      this.revokedMigrationJtis.add(auth.jti);
      this.revokedMigrationJtis.add(sess.accessJti);
      const nextAccessJti = randomUUID();
      const nextRefreshJti = randomUUID();
      sess.accessJti = nextAccessJti;
      sess.refreshJti = nextRefreshJti;
      sess.prevRefreshJti = rawIdemHeader !== undefined ? prevRefreshJti : null;
      sess.refreshIdempotencyKey = rawIdemHeader ?? null;
      sess.refreshGraceExpiresAt =
        rawIdemHeader !== undefined
          ? sess.plcCutoverAt === null
            ? Math.min(sess.absoluteDeadlineAt, lockNowMs + 15 * 60_000)
            : lockNowMs + 15 * 60_000
          : null;

      const accessExpSec =
        sess.plcCutoverAt !== null
          ? lockNowSec + 900
          : Math.max(Math.min(lockNowSec + 900, Math.ceil(sess.absoluteDeadlineAt / 1000)), lockNowSec + 1);
      const refreshExpSec = lockNowSec + 30 * 86_400;

      const accessJwt = this.issueFakeMigrationJwt(auth.did, sess.id, nextAccessJti, "at+jwt", accessExpSec);
      const refreshJwt = this.issueFakeMigrationJwt(auth.did, sess.id, nextRefreshJti, "refresh+jwt", refreshExpSec);
      this.migrationTokens.set(accessJwt, {
        did: auth.did,
        sessionId: sess.id,
        jti: nextAccessJti,
        tokenKind: "access",
        authEpoch: grp.authEpoch,
        expSec: accessExpSec,
      });
      this.migrationTokens.set(refreshJwt, {
        did: auth.did,
        sessionId: sess.id,
        jti: nextRefreshJti,
        tokenKind: "refresh",
        authEpoch: grp.authEpoch,
        expSec: refreshExpSec,
      });
      return {
        did: auth.did,
        handle: grp.handle,
        accessJwt,
        refreshJwt,
      };
    });
  }

  private async getFakeRecommendedDidCredentials(auth: FakeAuth, hostSlug = "group-host") {
    const did = this.requireSelf(auth, { scopes: "full", checkTakedown: true, allowMigration: true });
    const grp = this.groups.get(did);
    if (!grp) throw new FakeXrpcError(400, "GroupNotFound", "Group not hosted here");
    if (auth.kind !== "migration") {
      const { approved, live } = this.narrowedGroupSessionPerms(auth, did);
      if (!approved.allowsIdentity({ attr: "*" }) || !live.allowsIdentity({ attr: "*" })) {
        throw new FakeXrpcError(403, "Forbidden", "Missing identity:* permission");
      }
    }
    const endpoint = this.hostEndpointUrl(hostSlug);
    return {
      rotationKeys: [...grp.sovereignRotationKeys, grp.localRotationKey.did()],
      alsoKnownAs: [`at://${grp.handle}`],
      verificationMethods: {
        atproto: grp.migrationSession
          ? grp.migrationSession.stagedSigningKey.did()
          : (await this.signingKeypair(did)).did(),
        atproto_kem: grp.migrationSession
          ? grp.migrationSession.stagedKemKey.did()
          : (await this.kemKeypair(did)).did(),
      },
      services: {
        atproto_pds: { type: "AtprotoPersonalDataServer", endpoint },
        atgrp_host: { type: "AtmosphereGroupHostV1", endpoint },
      },
    };
  }

  private requestFakePlcOperationSignature(auth: FakeAuth) {
    const did = this.requireSelf(auth, { scopes: "full", checkTakedown: true, checkDeactivated: true });
    const grp = this.requireActiveFakeGroup(did);
    if (grp.sourceMigrationLease?.status === "plc_signed") {
      throw new FakeXrpcError(409, "MigrationCutoverPending", "Group cutover pending");
    }
    this.assertFakeFreshLoginStepUp(auth, this.now(), "Fresh prompt=login authentication required");
    const { actorDid, approved, live } = this.narrowedGroupSessionPerms(auth, did);
    if (!approved.allowsIdentity({ attr: "*" }) || !live.allowsIdentity({ attr: "*" })) {
      throw new FakeXrpcError(403, "Forbidden", "Missing identity:* permission");
    }
    const state = this.loadFakeGovernanceState(did);
    if (!this.isAuthorizedFakeLifecycleAdmin(actorDid, state, did)) {
      throw new FakeXrpcError(403, "Forbidden", "Caller is not an authorized lifecycle admin");
    }
    this.issueGroupActionTokenForTest(did, actorDid, "plc_operation");
    return {};
  }

  private async signFakePlcOperation(
    params: Record<string, unknown>,
    auth: FakeAuth,
    deliveries: Promise<void>[],
    hostSlug = "group-host",
    requestHeaders?: Headers,
  ) {
    const did = this.requireSelf(auth, { scopes: "full", checkTakedown: true, checkDeactivated: true });
    if (auth.kind === "self" && auth.sessionKind === "recovery") {
      throw new FakeXrpcError(403, "Forbidden", "signPlcOperation requires an active Group-DID OAuth session");
    }
    this.assertFakeFreshLoginStepUp(auth, this.now(), "Fresh prompt=login authentication required");
    const operationIdHeader = requestHeaders?.get("x-group-migration-operation-id") ?? undefined;
    if (operationIdHeader !== undefined && !isValidIdempotencyKey(operationIdHeader)) {
      throw new FakeXrpcError(400, "InvalidRequest", "Malformed X-Group-Migration-Operation-Id header");
    }

    return this.withFakeGroupLock(did, async () => {
      const grp = this.requireActiveFakeGroup(did);
      this.reapFakeExpiredPreparedMigrationLease(grp);

      const defaultEndpoint = this.hostEndpointUrl(hostSlug);
      const defaultRotKeys = [...grp.sovereignRotationKeys, grp.localRotationKey.did()];
      const defaultVm: Record<string, string> = {
        atproto: (await this.signingKeypair(did)).did(),
        atproto_kem: (await this.kemKeypair(did)).did(),
      };
      const defaultAka = [`at://${grp.handle}`];
      const defaultServices: Record<string, { type: string; endpoint: string }> = {
        atproto_pds: { type: "AtprotoPersonalDataServer", endpoint: defaultEndpoint },
        atgrp_host: { type: "AtmosphereGroupHostV1", endpoint: defaultEndpoint },
      };

      const proposedRotKeys = Array.isArray(params.rotationKeys) ? (params.rotationKeys as string[]) : defaultRotKeys;
      const proposedVm =
        params.verificationMethods && typeof params.verificationMethods === "object" && !Array.isArray(params.verificationMethods)
          ? (params.verificationMethods as Record<string, string>)
          : defaultVm;
      const proposedAka = Array.isArray(params.alsoKnownAs) ? (params.alsoKnownAs as string[]) : defaultAka;
      const proposedServices =
        params.services && typeof params.services === "object" && !Array.isArray(params.services)
          ? (params.services as Record<string, { type: string; endpoint: string }>)
          : defaultServices;

      let proposedPdsOrigin: string;
      try {
        proposedPdsOrigin = proposedServices.atproto_pds?.endpoint
          ? this.normalizeFakeTargetEndpoint(proposedServices.atproto_pds.endpoint)
          : defaultEndpoint;
      } catch {
        throw new FakeXrpcError(400, "InvalidRequest", "Invalid #atproto_pds service endpoint");
      }

      if (proposedRotKeys.length < 1 || proposedRotKeys.length > 5) {
        throw new FakeXrpcError(400, "TooManyRotationKeys", "PLC rotationKeys must contain 1..5 keys");
      }
      if (!proposedRotKeys.every((k) => this.isSupportedFakePlcRotationDidKey(k))) {
        throw new FakeXrpcError(400, "InvalidRequest", "Unsupported rotation key format");
      }

      const isCutover = proposedPdsOrigin !== defaultEndpoint;
      const initialLease = grp.sourceMigrationLease;

      if (isCutover) {
        if (initialLease && operationIdHeader !== undefined && initialLease.operationId !== operationIdHeader) {
          throw new FakeXrpcError(
            409,
            "MigrationInProgress",
            `Active source migration lease (${initialLease.operationId}) does not match X-Group-Migration-Operation-Id (${operationIdHeader})`,
          );
        }
        if (initialLease && initialLease.targetEndpoint !== proposedPdsOrigin) {
          throw new FakeXrpcError(
            409,
            "MigrationInProgress",
            `Proposed #atproto_pds (${proposedPdsOrigin}) does not match leased target (${initialLease.targetEndpoint})`,
          );
        }

        if (initialLease?.status === "plc_signed") {
          if (!initialLease.signedPlcOp) {
            throw new FakeXrpcError(409, "MigrationInProgress", "Migration PLC operation already signed");
          }
          const savedOp = initialLease.signedPlcOp as {
            rotationKeys?: unknown;
            alsoKnownAs?: unknown;
            verificationMethods?: unknown;
            services?: unknown;
          };
          const matchesSaved =
            isDeepStrictEqual(proposedRotKeys, savedOp.rotationKeys) &&
            isDeepStrictEqual(proposedAka, savedOp.alsoKnownAs) &&
            isDeepStrictEqual(proposedVm, savedOp.verificationMethods) &&
            isDeepStrictEqual(proposedServices, savedOp.services);

          const nowCheck = this.now();
          this.assertFakeFreshLoginStepUp(auth, nowCheck, "Fresh prompt=login authentication required");
          const { actorDid, approved, live } = this.narrowedGroupSessionPerms(auth, did);
          if (!approved.allowsIdentity({ attr: "*" }) || !live.allowsIdentity({ attr: "*" })) {
            throw new FakeXrpcError(403, "Forbidden", "Missing identity:* permission");
          }
          const liveState = this.loadFakeGovernanceState(did);
          if (!this.isAuthorizedFakeLifecycleAdmin(actorDid, liveState, did)) {
            throw new FakeXrpcError(403, "Forbidden", "Caller is not an authorized lifecycle admin");
          }
          if (!matchesSaved) {
            throw new FakeXrpcError(
              409,
              "MigrationInProgress",
              "Cutover PLC operation was already signed with different parameters",
            );
          }
          if (typeof params.token === "string" && params.token.length > 0) {
            const row = grp.actionTokens.get("plc_operation");
            if (row && row.actorDid === actorDid && row.tokenHash === sha256Hex(params.token)) {
              grp.actionTokens.delete("plc_operation");
            }
          }
          return { operation: initialLease.signedPlcOp };
        }
      } else if (initialLease?.status === "plc_signed") {
        throw new FakeXrpcError(409, "MigrationInProgress", "Group migration PLC cutover has been signed");
      }

      const token = typeof params.token === "string" ? params.token : "";
      if (!token) {
        throw new FakeXrpcError(400, "InvalidToken", "Confirmation token is required for signPlcOperation");
      }

      const verifyFakeAuthAndToken = (checkNowMs: number) => {
        this.assertFakeFreshLoginStepUp(auth, checkNowMs, "Fresh prompt=login authentication required");
        const { actorDid, approved, live } = this.narrowedGroupSessionPerms(auth, did);
        if (!approved.allowsIdentity({ attr: "*" }) || !live.allowsIdentity({ attr: "*" })) {
          throw new FakeXrpcError(403, "Forbidden", "Missing identity:* permission");
        }
        const liveState = this.loadFakeGovernanceState(did);
        if (!this.isAuthorizedFakeLifecycleAdmin(actorDid, liveState, did)) {
          throw new FakeXrpcError(403, "Forbidden", "Caller is not an authorized lifecycle admin");
        }
        const row = grp.actionTokens.get("plc_operation");
        if (!row || row.actorDid !== actorDid || row.tokenHash !== sha256Hex(token)) {
          throw new FakeXrpcError(400, "InvalidToken", "Invalid plc_operation token");
        }
        if (row.expiresAt <= checkNowMs) {
          throw new FakeXrpcError(400, "ExpiredToken", "plc_operation token expired");
        }
      };

      verifyFakeAuthAndToken(this.now());

      let unleasedOperationId: string | null = null;
      let unleasedTargetServiceDid: string | null = null;
      let unleasedSnap: { manifestJson: string; manifestDigest: string } | null = null;

      if (isCutover) {
        if (proposedRotKeys.includes(grp.localRotationKey.did())) {
          throw new FakeXrpcError(
            400,
            "SourceRotationKeyRetained",
            "Cutover PLC operation must remove retiring source host rotation key",
          );
        }
        for (const sov of grp.sovereignRotationKeys) {
          if (!proposedRotKeys.includes(sov)) {
            throw new FakeXrpcError(
              400,
              "SovereignRotationKeyDropped",
              `Cutover PLC operation dropped external sovereign rotation key: ${sov}`,
            );
          }
        }

        if (initialLease) {
          const currentSnap = await this.snapshotFakeMigrationManifest({
            groupDid: did,
            operationId: initialLease.operationId,
            deadlineAtMs: initialLease.deadlineAt,
            sourceLocalRotationKey: grp.localRotationKey.did(),
          });
          if (currentSnap.manifestJson !== initialLease.rootManifestJson) {
            throw new FakeXrpcError(409, "MigrationManifestMismatch", "Source state changed after prepare-migration");
          }

          if (initialLease.mode === "coordinated" && initialLease.ticketId) {
            const srcJwt = await this.signFakeServiceJwt({
              issDid: this.hostServiceDid(hostSlug),
              aud: initialLease.targetServiceDid,
              lxm: "com.atproto.identity.signPlcOperation",
            });
            const attUrl = `${initialLease.targetEndpoint}/group-admin/migration-attestation?group=${encodeURIComponent(did)}&operationId=${encodeURIComponent(initialLease.operationId)}&ticketId=${encodeURIComponent(initialLease.ticketId)}`;
            const attRes = this.hasOutboundHandler(attUrl)
              ? await this.sendOutbound(attUrl, {
                  method: "GET",
                  headers: { accept: "application/json", authorization: `Bearer ${srcJwt}` },
                })
              : await this.fetchEndpoint(
                  new Request(attUrl, {
                    method: "GET",
                    headers: { accept: "application/json", authorization: `Bearer ${srcJwt}` },
                  }),
                );
            if (!attRes.ok) {
              throw new FakeXrpcError(
                409,
                "MigrationAttestationFailed",
                `Target migration-attestation rejected (${attRes.status})`,
              );
            }
            const att = (await attRes.json().catch(() => null)) as {
              groupDid?: unknown;
              operationId?: unknown;
              ticketId?: unknown;
              manifestDigest?: unknown;
              targetEndpoint?: unknown;
              targetServiceDid?: unknown;
              targetSigningKey?: unknown;
              targetKemKey?: unknown;
              targetLocalRotationKey?: unknown;
            } | null;
            if (
              !att ||
              att.groupDid !== did ||
              att.operationId !== initialLease.operationId ||
              att.ticketId !== initialLease.ticketId ||
              att.manifestDigest !== initialLease.manifestDigest ||
              att.targetEndpoint !== initialLease.targetEndpoint ||
              att.targetServiceDid !== initialLease.targetServiceDid ||
              att.targetSigningKey !== proposedVm.atproto ||
              att.targetKemKey !== proposedVm.atproto_kem ||
              typeof att.targetLocalRotationKey !== "string" ||
              !proposedRotKeys.includes(att.targetLocalRotationKey)
            ) {
              throw new FakeXrpcError(
                409,
                "MigrationAttestationMismatch",
                "Target attestation does not match proposed cutover credentials or manifest digest",
              );
            }
          }
        } else {
          if (operationIdHeader !== undefined) {
            this.assertFakeOperationIdNotAborted(did, operationIdHeader, this.now(), hostSlug);
          }
          const cap = await this.verifyFakeOpenSocialTargetCapability(proposedPdsOrigin, hostSlug);
          unleasedOperationId = operationIdHeader ?? `unleased-${randomUUID()}`;
          unleasedTargetServiceDid = cap.targetServiceDid;
          unleasedSnap = await this.snapshotFakeMigrationManifest({
            groupDid: did,
            operationId: unleasedOperationId,
            deadlineAtMs: this.now() + 2 * 3_600_000,
            sourceLocalRotationKey: grp.localRotationKey.did(),
          });
        }
      } else {
        if (!proposedRotKeys.includes(grp.localRotationKey.did())) {
          throw new FakeXrpcError(400, "InvalidRequest", "Local PLC operation must retain local host rotation key");
        }
      }

      const commitNowMs = this.now();
      verifyFakeAuthAndToken(commitNowMs);
      grp.actionTokens.delete("plc_operation");

      const operation = {
        type: "plc_operation",
        rotationKeys: proposedRotKeys,
        verificationMethods: proposedVm,
        alsoKnownAs: proposedAka,
        services: proposedServices,
        prev: null,
        sig: `fake-plc-sig-${randomStr(16, "hex")}`,
      };

      if (isCutover) {
        this.revokeGroupCredentialsForSpace(did, undefined, undefined, deliveries);
        if (grp.sourceMigrationLease) {
          grp.sourceMigrationLease.status = "plc_signed";
          grp.sourceMigrationLease.expiresAt = null;
          grp.sourceMigrationLease.signedPlcOp = operation;
        } else if (unleasedOperationId && unleasedTargetServiceDid && unleasedSnap) {
          grp.sourceMigrationLease = {
            operationId: unleasedOperationId,
            mode: "standard",
            ticketId: null,
            ticketSecret: null,
            ticketSecretHash: null,
            targetServiceDid: unleasedTargetServiceDid,
            targetEndpoint: proposedPdsOrigin,
            status: "plc_signed",
            signedPlcOp: operation,
            frozenAt: commitNowMs,
            deadlineAt: commitNowMs + 2 * 3_600_000,
            expiresAt: null,
            manifestDigest: unleasedSnap.manifestDigest,
            rootManifestJson: unleasedSnap.manifestJson,
          };
        }
      }

      return { operation };
    });
  }

  private submitFakePlcOperation(params: Record<string, unknown>, auth: FakeAuth, hostSlug = "group-host") {
    const did = this.requireSelf(auth, { scopes: "full", checkTakedown: true, allowMigration: true });
    const grp = this.groups.get(did);
    if (!grp) throw new FakeXrpcError(400, "GroupNotFound", "Group not hosted here");
    if (!params.operation || typeof params.operation !== "object") {
      throw new FakeXrpcError(400, "InvalidRequest", "operation object is required");
    }
    const opObj = params.operation as {
      rotationKeys?: unknown;
      verificationMethods?: { atproto?: unknown; atproto_kem?: unknown };
    };
    if (auth.kind === "migration" && grp.migrationSession) {
      this.validateFakeStagedOpenSocialIntegrity(did, grp);
      grp.migrationSession.plcCutoverAt = this.now();
      this.accounts.set(did, hostSlug);
      this.signingKeys.set(did, Promise.resolve(grp.migrationSession.stagedSigningKey));
      this.kemKeys.set(did, Promise.resolve(grp.migrationSession.stagedKemKey));
      const nextAtproto =
        typeof opObj.verificationMethods?.atproto === "string"
          ? opObj.verificationMethods.atproto
          : grp.migrationSession.stagedSigningKey.did();
      const nextKem =
        typeof opObj.verificationMethods?.atproto_kem === "string"
          ? opObj.verificationMethods.atproto_kem
          : grp.migrationSession.stagedKemKey.did();
      this.publishedSigningKeys.set(did, nextAtproto);
      this.publishedKemKeys.set(did, nextKem);
    } else {
      const { approved, live } = this.narrowedGroupSessionPerms(auth, did);
      if (!approved.allowsIdentity({ attr: "*" }) || !live.allowsIdentity({ attr: "*" })) {
        throw new FakeXrpcError(403, "Forbidden", "Missing identity:* permission");
      }
      if (typeof opObj.verificationMethods?.atproto === "string") {
        this.publishedSigningKeys.set(did, opObj.verificationMethods.atproto);
      }
      if (typeof opObj.verificationMethods?.atproto_kem === "string") {
        this.publishedKemKeys.set(did, opObj.verificationMethods.atproto_kem);
      }
    }
    if (Array.isArray(opObj.rotationKeys)) {
      const localDid = grp.localRotationKey.did();
      grp.sovereignRotationKeys = new Set(
        opObj.rotationKeys.filter((k): k is string => typeof k === "string" && k !== localDid),
      );
    }
    return {};
  }

  private async abortFakeMigration(
    params: Record<string, unknown>,
    auth: FakeAuth,
    hostSlug = "group-host",
  ) {
    const groupDid = typeof params.group === "string" ? params.group : "";
    if (!isDid(groupDid)) {
      throw new FakeXrpcError(400, "InvalidRequest", "group DID is required");
    }

    // Target-side abort: migration staging token OR `<groupDid>` Bearer service JWT (`aud = targetServiceDid`, `lxm = FLOCK_GROUP_METHOD.abortMigration`)!
    if (auth.kind === "migration" || auth.kind === "raw-token") {
      const nowMs = this.now();
      const nowSec = Math.floor(nowMs / 1000);
      let viaServiceJwt = false;
      let verifiedSvcJwt: { iss: string; aud: string; jti: string; expSec: number; consumeJti: () => void } | undefined;
      if (auth.kind === "migration") {
        if (auth.tokenKind !== "access") {
          throw new FakeXrpcError(401, "ExpiredToken", "Refresh token cannot be used as access token");
        }
        if (nowSec >= auth.expSec) {
          throw new FakeXrpcError(401, "ExpiredToken", "Migration access token expired");
        }
        if (auth.did !== groupDid) {
          throw new FakeXrpcError(403, "Forbidden", "Migration token subject mismatch");
        }
      } else {
        if (auth.scheme !== "bearer" || !auth.token) {
          throw new FakeXrpcError(401, "AuthMissing", "Bearer token required on target abort-migration");
        }
        verifiedSvcJwt = await this.verifyFakePeerServiceJwt(auth, {
          expectedIss: groupDid,
          expectedAud: this.hostServiceDid(hostSlug),
          expectedLxm: FLOCK_GROUP_METHOD.abortMigration,
          deferConsume: true,
          replayNamespace: "abort-jwt",
          hostSlug,
        });
        if (typeof params.operationId !== "string" || !isValidIdempotencyKey(params.operationId)) {
          throw new FakeXrpcError(
            400,
            "InvalidRequest",
            "operationId (1..128 [A-Za-z0-9._:-] chars) is required for service-JWT migration abort",
          );
        }
        viaServiceJwt = true;
      }

      const safeDeadlineAtMs =
        typeof params.deadlineAtMs === "number" && Number.isFinite(params.deadlineAtMs)
          ? params.deadlineAtMs
          : 0;
      const maxTombstoneExpiresAt = nowMs + 2 * 3_600_000 + 60_000;
      const clampedDeadlineAtMs = Math.min(Math.max(safeDeadlineAtMs, nowMs + 2 * 3_600_000), maxTombstoneExpiresAt);
      const grp = this.groups.get(groupDid);
      const acctHost = this.accounts.get(groupDid);
      const unavail = this.unavailable.get(groupDid);
      if (grp && acctHost === hostSlug && unavail !== "RepoDeactivated" && unavail !== "RepoNotFound") {
        throw new FakeXrpcError(409, "MigrationCutoverCommitted", "PLC #atproto_pds already points to this target host");
      }
      if (grp) {
        this.reconcileFakeUncutoverMigrationSession(groupDid, grp, nowMs);
      }
      const sess = grp?.migrationSession;
      if (sess?.plcCutoverAt !== null && sess?.plcCutoverAt !== undefined) {
        throw new FakeXrpcError(409, "MigrationCutoverCommitted", "Target migration cutover already committed");
      }

      if (
        params.operationId !== undefined &&
        (typeof params.operationId !== "string" || !isValidIdempotencyKey(params.operationId))
      ) {
        throw new FakeXrpcError(400, "InvalidRequest", "Invalid operationId");
      }
      const operationId = params.operationId;
      if (
        params.ticketId !== undefined &&
        params.ticketId !== null &&
        (typeof params.ticketId !== "string" || !isValidIdempotencyKey(params.ticketId))
      ) {
        throw new FakeXrpcError(400, "InvalidRequest", "Invalid ticketId");
      }
      const ticketId = typeof params.ticketId === "string" ? params.ticketId : undefined;
      if (
        params.leaseAttemptId !== undefined &&
        (typeof params.leaseAttemptId !== "string" || !isValidIdempotencyKey(params.leaseAttemptId))
      ) {
        throw new FakeXrpcError(400, "InvalidRequest", "Invalid leaseAttemptId");
      }
      const leaseAttemptId = typeof params.leaseAttemptId === "string" ? params.leaseAttemptId : undefined;

      if (viaServiceJwt) {
        if (
          sess?.mode === "coordinated" &&
          sess.operationId === operationId &&
          (!ticketId || params.ticketId === null)
        ) {
          throw new FakeXrpcError(400, "InvalidRequest", "ticketId is required for coordinated migration abort");
        }
      } else if (sess?.mode === "coordinated" && params.ticketId === null) {
        throw new FakeXrpcError(400, "InvalidRequest", "Invalid ticketId");
      }

      const consumeVerifiedSvcJwt = () => {
        if (!verifiedSvcJwt) return;
        verifiedSvcJwt.consumeJti();
        this.recordFakeAbortStorageEntry(
          groupDid,
          `abort-jwt:${verifiedSvcJwt.jti}`,
          Math.min(Math.max(verifiedSvcJwt.expSec * 1000, nowMs + 65_000), maxTombstoneExpiresAt),
          hostSlug,
        );
      };

      if (!grp || !sess) {
        if (viaServiceJwt && verifiedSvcJwt) {
          const candidateKeys = [`abort-jwt:${verifiedSvcJwt.jti}`];
          if (ticketId) candidateKeys.push(`ticket:${ticketId}`);
          if (leaseAttemptId) candidateKeys.push(`lease-attempt:${leaseAttemptId}`);
          if (operationId) candidateKeys.push(`aborted-op:${operationId}`);
          this.enforceFakeAbortStorageQuota(groupDid, candidateKeys, nowMs, hostSlug);
          consumeVerifiedSvcJwt();
          if (ticketId) {
            this.usedServiceJtis.add(`aborted-ticket\u0000${groupDid}\u0000${ticketId}`);
            this.recordFakeAbortStorageEntry(groupDid, `ticket:${ticketId}`, clampedDeadlineAtMs, hostSlug);
          }
          if (leaseAttemptId) {
            this.recordFakeAbortedLeaseAttempt(groupDid, leaseAttemptId, clampedDeadlineAtMs, hostSlug);
          }
          if (operationId) {
            this.recordFakeAbortedOperation(groupDid, operationId, clampedDeadlineAtMs, hostSlug);
          }
        }
        return { status: "already_absent" };
      }

      if (auth.kind === "migration") {
        if (auth.authEpoch !== sess.authEpoch || auth.sessionId !== sess.id) {
          return { status: "superseded" };
        }
        if (nowMs >= sess.absoluteDeadlineAt) {
          throw new FakeXrpcError(401, "ExpiredToken", "Migration staging deadline expired");
        }
        if (auth.jti !== sess.accessJti) {
          if (this.revokedMigrationJtis.has(auth.jti)) {
            this.purgeFakeUncutoverStagingOnReplay(groupDid, auth.sessionId, auth.authEpoch, nowMs, hostSlug);
            throw new FakeXrpcError(401, "InvalidToken", "Revoked migration token JTI replayed");
          }
          throw new FakeXrpcError(401, "InvalidToken", "Migration session is no longer active");
        }
        if (sess.prevRefreshJti !== null) {
          sess.prevRefreshJti = null;
          sess.refreshIdempotencyKey = null;
          sess.refreshGraceExpiresAt = null;
        }
      }

      const hasTicketMismatch =
        sess.mode === "coordinated"
          ? viaServiceJwt
            ? sess.ticketId !== ticketId
            : ticketId !== undefined && sess.ticketId !== ticketId
          : ticketId !== undefined;
      const hasOperationMismatch = viaServiceJwt
        ? sess.operationId === null || sess.operationId !== operationId
        : operationId !== undefined && sess.operationId !== null && sess.operationId !== operationId;
      const hasLeaseAttemptMismatch =
        viaServiceJwt &&
        sess.mode === "standard" &&
        (leaseAttemptId === undefined ||
          sess.ticketId === null ||
          sess.ticketId !== leaseAttemptId);

      if (hasTicketMismatch || hasOperationMismatch || hasLeaseAttemptMismatch) {
        if (viaServiceJwt && verifiedSvcJwt) {
          const includeTicket = ticketId !== undefined && ticketId !== sess.ticketId;
          const supersededLeaseAttempt =
            leaseAttemptId !== undefined && leaseAttemptId !== sess.ticketId ? leaseAttemptId : null;
          const candidateKeys = [`abort-jwt:${verifiedSvcJwt.jti}`];
          if (includeTicket && ticketId) candidateKeys.push(`ticket:${ticketId}`);
          if (supersededLeaseAttempt) candidateKeys.push(`lease-attempt:${supersededLeaseAttempt}`);
          if (operationId && sess.operationId !== operationId) candidateKeys.push(`aborted-op:${operationId}`);
          this.enforceFakeAbortStorageQuota(groupDid, candidateKeys, nowMs, hostSlug);
          consumeVerifiedSvcJwt();
          if (includeTicket && ticketId) {
            this.usedServiceJtis.add(`aborted-ticket\u0000${groupDid}\u0000${ticketId}`);
            this.recordFakeAbortStorageEntry(groupDid, `ticket:${ticketId}`, clampedDeadlineAtMs, hostSlug);
          }
          if (supersededLeaseAttempt) {
            this.recordFakeAbortedLeaseAttempt(groupDid, supersededLeaseAttempt, clampedDeadlineAtMs, hostSlug);
          }
          if (operationId && sess.operationId !== operationId) {
            this.recordFakeAbortedOperation(groupDid, operationId, clampedDeadlineAtMs, hostSlug);
          }
        }
        return { status: "superseded" };
      }

      const retiredTicketId = sess.mode === "coordinated" ? ticketId : undefined;
      const retiredAttemptId = sess.ticketId;
      const purgeCandidateKeys: string[] = [];
      if (viaServiceJwt && verifiedSvcJwt) purgeCandidateKeys.push(`abort-jwt:${verifiedSvcJwt.jti}`);
      if (retiredTicketId) purgeCandidateKeys.push(`ticket:${retiredTicketId}`);
      if (retiredAttemptId) purgeCandidateKeys.push(`lease-attempt:${retiredAttemptId}`);
      if (sess.operationId !== null) purgeCandidateKeys.push(`aborted-op:${sess.operationId}`);
      this.enforceFakeAbortStorageQuota(groupDid, purgeCandidateKeys, nowMs, hostSlug);

      consumeVerifiedSvcJwt();
      if (retiredTicketId) {
        this.usedServiceJtis.add(`aborted-ticket\u0000${groupDid}\u0000${retiredTicketId}`);
        this.recordFakeAbortStorageEntry(groupDid, `ticket:${retiredTicketId}`, clampedDeadlineAtMs, hostSlug);
      }
      if (retiredAttemptId) {
        this.recordFakeAbortedLeaseAttempt(groupDid, retiredAttemptId, clampedDeadlineAtMs, hostSlug);
      }
      if (sess.operationId !== null) {
        this.recordFakeAbortedOperation(
          groupDid,
          sess.operationId,
          Math.min(Math.max(sess.absoluteDeadlineAt, clampedDeadlineAtMs), maxTombstoneExpiresAt),
          hostSlug,
        );
      }
      this.revokedMigrationJtis.add(sess.accessJti);
      this.revokedMigrationJtis.add(sess.refreshJti);
      if (acctHost === hostSlug) {
        this.groupsByHandle.delete(grp.handle);
        for (const [spUri, sp] of this.spaces) {
          if (sp.ownerDid === groupDid) this.spaces.delete(spUri);
        }
        this.groups.delete(groupDid);
        this.publicRecords.delete(groupDid);
        this.accountRepos.delete(groupDid);
        this.accounts.delete(groupDid);
        this.unavailable.delete(groupDid);
      } else {
        grp.migrationSession = null;
      }
      return { status: "purged" };
    }

    // Source-side abort: authenticated group admin session serialized under `withFakeGroupLock`
    const sessionDid = this.requireSelf(auth, { scopes: "full", checkTakedown: true, checkDeactivated: true });
    if (sessionDid !== groupDid) {
      throw new FakeXrpcError(403, "Forbidden", "Session subject mismatch");
    }
    if (params.operationId !== undefined && typeof params.operationId !== "string") {
      throw new FakeXrpcError(400, "InvalidRequest", "operationId must be a string");
    }
    const operationId = params.operationId;
    return this.withFakeGroupLock(groupDid, async () => {
      const { actorDid, approved, live } = this.narrowedGroupSessionPerms(auth, groupDid);
      if (!approved.allowsAccount({ attr: "repo", action: "manage" }) || !live.allowsAccount({ attr: "repo", action: "manage" })) {
        throw new FakeXrpcError(403, "Forbidden", "Missing account:repo?action=manage");
      }
      const grp = this.requireActiveFakeGroup(groupDid);
      const liveState = this.loadFakeGovernanceState(groupDid);
      if (!this.isAuthorizedFakeLifecycleAdmin(actorDid, liveState, groupDid)) {
        throw new FakeXrpcError(403, "Forbidden", "Caller is not an authorized lifecycle admin");
      }
      if (
        (this.accounts.get(groupDid) && this.accounts.get(groupDid) !== hostSlug) ||
        (this.peerNetwork?.groups.get(groupDid)?.migrationSession?.plcCutoverAt !== null &&
          this.peerNetwork?.groups.get(groupDid)?.migrationSession?.plcCutoverAt !== undefined)
      ) {
        throw new FakeXrpcError(409, "MigrationCutoverCommitted", "PLC #atproto_pds has already cut over");
      }
      this.reapFakeExpiredPreparedMigrationLease(grp);
      const lease = grp.sourceMigrationLease;
      if (!lease || (operationId !== undefined && lease.operationId !== operationId)) {
        return { status: "already_absent" };
      }
      if (lease.targetEndpoint && lease.targetServiceDid && lease.operationId.trim().length > 0) {
        const abortJwt = await this.signFakeServiceJwt({
          issDid: groupDid,
          aud: lease.targetServiceDid,
          lxm: FLOCK_GROUP_METHOD.abortMigration,
        });
        const abortUrl = `${lease.targetEndpoint}/group-admin/abort-migration`;
        const abortInit: RequestInit = {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${abortJwt}`,
          },
          body: JSON.stringify({
            group: groupDid,
            operationId: lease.operationId,
            ...(lease.mode === "coordinated" && lease.ticketId ? { ticketId: lease.ticketId } : {}),
            ...(lease.ticketId ? { leaseAttemptId: lease.ticketId } : {}),
            deadlineAtMs: lease.deadlineAt,
          }),
        };
        let abortRes: Response;
        try {
          abortRes = this.hasOutboundHandler(abortUrl)
            ? await this.sendOutbound(abortUrl, abortInit)
            : await this.fetchEndpoint(new Request(abortUrl, abortInit));
        } catch {
          throw new FakeXrpcError(
            502,
            "TargetAbortFailed",
            "Could not reach target host to purge migration staging; source lease preserved for retry",
          );
        }
        if (abortRes.status === 409) {
          const errBody = (await abortRes.json().catch(() => null)) as { error?: unknown; message?: unknown } | null;
          if (errBody?.error === "MigrationCutoverCommitted") {
            throw new FakeXrpcError(
              409,
              "MigrationCutoverCommitted",
              typeof errBody.message === "string" ? errBody.message : "Target migration cutover already committed",
            );
          }
          throw new FakeXrpcError(
            502,
            "TargetAbortFailed",
            "Target host rejected abort-migration with HTTP 409; source lease preserved for retry",
          );
        }
        if (!(abortRes.status === 404 && lease.mode === "standard")) {
          if (abortRes.status !== 200) {
            throw new FakeXrpcError(
              502,
              "TargetAbortFailed",
              `Target host abort-migration failed (${abortRes.status}); source lease preserved for retry`,
            );
          }
          const okBody = (await abortRes.json().catch(() => null)) as { status?: unknown } | null;
          if (
            !okBody ||
            (okBody.status !== "purged" && okBody.status !== "already_absent" && okBody.status !== "superseded")
          ) {
            throw new FakeXrpcError(
              502,
              "TargetAbortFailed",
              "Target host returned malformed abort-migration acknowledgement; source lease preserved for retry",
            );
          }
        }
      }
      if (lease.operationId) {
        this.recordFakeAbortedOperation(
          groupDid,
          lease.operationId,
          Math.max(lease.deadlineAt, this.now() + 2 * 3_600_000),
          hostSlug,
        );
      }
      if (lease.ticketId) {
        this.usedServiceJtis.add(`aborted-ticket\u0000${groupDid}\u0000${lease.ticketId}`);
        this.recordFakeAbortStorageEntry(
          groupDid,
          `ticket:${lease.ticketId}`,
          Math.max(lease.deadlineAt, this.now() + 2 * 3_600_000),
          hostSlug,
        );
      }
      grp.sourceMigrationLease = null;
      return { status: "aborted" };
    });
  }

  private async finalizeFakeMigratedSource(
    params: Record<string, unknown>,
    auth: FakeAuth,
    hostSlug = "group-host",
  ) {
    const groupDid = typeof params.group === "string" ? params.group : "";
    if (!isDid(groupDid)) throw new FakeXrpcError(400, "InvalidRequest", "Invalid group DID");
    const grp = this.groups.get(groupDid);
    if (!grp || (this.unavailable.get(groupDid) === "RepoDeactivated" && !grp.sourceMigrationLease)) {
      return { status: "already_finalized" };
    }
    await this.verifyFakePeerServiceJwt(auth, {
      expectedIss: groupDid,
      expectedAud: this.hostServiceDid(hostSlug),
      expectedLxm: "com.atproto.server.deactivateAccount",
      requireEs256: true,
      hostSlug,
    });
    grp.sourceMigrationLease = null;
    grp.authEpoch += 1;
    this.unavailable.set(groupDid, "RepoDeactivated");
    return { status: "finalized" };
  }

  private async verifyFakePeerServiceJwt(
    auth: FakeAuth,
    opts: {
      expectedIss: string;
      expectedAud?: string;
      expectedLxm: string;
      peerHost?: boolean;
      expectedPeerEndpoint?: string;
      requireEs256?: boolean;
      deferConsume?: boolean;
      replayNamespace?: string;
      hostSlug?: string;
    },
  ): Promise<{ iss: string; aud: string; jti: string; expSec: number; consumeJti: () => void }> {
    if (auth.kind === "none") throw new FakeXrpcError(401, "AuthMissing", "Bearer service JWT required");
    if (auth.kind === "rejected") throw auth.error;
    if (auth.kind !== "raw-token" || auth.scheme !== "bearer" || !auth.token) {
      throw new FakeXrpcError(401, "InvalidToken", "Bearer service JWT required");
    }
    const parts = auth.token.split(".");
    if (parts.length !== 3) throw new FakeXrpcError(401, "InvalidToken", "Malformed service JWT");
    let header: { alg?: string; typ?: string; kid?: string };
    let payload: { iss?: string; aud?: string; lxm?: string; iat?: number; exp?: number; jti?: string };
    try {
      header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as typeof header;
      payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as typeof payload;
    } catch {
      throw new FakeXrpcError(401, "InvalidToken", "Malformed service JWT JSON");
    }
    if (header.typ !== "JWT") {
      throw new FakeXrpcError(401, "InvalidToken", "Service JWT header.typ must be JWT");
    }
    const isPeerHostAuth = Boolean(opts.peerHost || opts.expectedPeerEndpoint !== undefined);
    const es256Only = isPeerHostAuth || Boolean(opts.requireEs256);
    if (header.alg !== "ES256" && header.alg !== "ES256K") {
      throw new FakeXrpcError(401, "InvalidToken", "Unsupported service JWT alg");
    }
    if (es256Only && header.alg !== "ES256") {
      throw new FakeXrpcError(401, "InvalidToken", "Peer service JWT alg must be ES256");
    }
    const nowSec = Math.floor(this.now() / 1000);
    if (
      payload.iss !== opts.expectedIss ||
      (opts.expectedAud !== undefined && payload.aud !== opts.expectedAud) ||
      typeof payload.aud !== "string" ||
      payload.lxm !== opts.expectedLxm ||
      typeof payload.jti !== "string" ||
      payload.jti.trim().length === 0 ||
      payload.jti.length > 256 ||
      typeof payload.iat !== "number" ||
      !Number.isFinite(payload.iat) ||
      payload.iat > nowSec + 5 ||
      typeof payload.exp !== "number" ||
      !Number.isFinite(payload.exp) ||
      payload.exp <= nowSec ||
      payload.exp <= payload.iat ||
      payload.exp - payload.iat > 60
    ) {
      throw new FakeXrpcError(401, "InvalidToken", "Service JWT claims mismatch or expired");
    }
    let sigKey: string | undefined;
    if (isPeerHostAuth) {
      const doc = await this.resolveFakePeerDidDoc(payload.iss);
      if (!doc) {
        throw new FakeXrpcError(401, "UnresolvableDid", `Cannot resolve peer host DID ${payload.iss}`);
      }
      if (opts.expectedPeerEndpoint !== undefined) {
        const pdsSvc = (doc.service ?? []).find(
          (s) => s && (s.id === "#atproto_pds" || s.id === `${doc.id}#atproto_pds`),
        );
        let pdsNorm: string | null = null;
        if (typeof pdsSvc?.serviceEndpoint === "string") {
          try {
            pdsNorm = this.normalizeFakeTargetEndpoint(pdsSvc.serviceEndpoint);
          } catch {
            pdsNorm = null;
          }
        }
        let expectedNorm: string | null = null;
        try {
          expectedNorm = this.normalizeFakeTargetEndpoint(opts.expectedPeerEndpoint);
        } catch {
          expectedNorm = null;
        }
        if (!pdsNorm || !expectedNorm || pdsNorm !== expectedNorm) {
          throw new FakeXrpcError(401, "InvalidToken", "Peer DID #atproto_pds endpoint mismatch");
        }
      }
      const rawKid = typeof header.kid === "string" && header.kid.length > 0 ? header.kid : undefined;
      const fragment = rawKid
        ? rawKid.startsWith(`${doc.id}#`)
          ? rawKid.slice(doc.id.length)
          : rawKid
        : "#atproto";
      const isDesignatedPeerSigningKey =
        fragment === "#atproto" || /^#atproto-[A-Za-z0-9_-]{1,64}$/.test(fragment);
      const matchedVm = isDesignatedPeerSigningKey
        ? (doc.verificationMethod ?? []).find(
            (vm) =>
              vm &&
              typeof vm === "object" &&
              (vm.id === fragment || vm.id === `${doc.id}${fragment}`) &&
              typeof vm.publicKeyMultibase === "string" &&
              vm.publicKeyMultibase.length > 0,
          )
        : undefined;
      if (!matchedVm?.publicKeyMultibase) {
        throw new FakeXrpcError(401, "SigningKeyNotFound", "Peer signing key not found in DID document");
      }
      try {
        if (matchedVm.type === "Multikey") {
          sigKey = `did:key:${matchedVm.publicKeyMultibase}`;
        } else if (matchedVm.type === "EcdsaSecp256r1VerificationKey2019") {
          sigKey = formatDidKey(P256_JWT_ALG, multibaseToBytes(matchedVm.publicKeyMultibase));
        } else if (matchedVm.type === "EcdsaSecp256k1VerificationKey2019") {
          sigKey = formatDidKey(SECP256K1_JWT_ALG, multibaseToBytes(matchedVm.publicKeyMultibase));
        } else {
          sigKey = `did:key:${matchedVm.publicKeyMultibase}`;
        }
      } catch {
        throw new FakeXrpcError(401, "SigningKeyNotFound", "Peer signing key in DID document is malformed");
      }
    } else {
      sigKey = payload.iss.startsWith("did:web:fake-pds.test")
        ? (
            await this.hostServiceKeypair(
              payload.iss === "did:web:fake-pds.test"
                ? "group-host"
                : payload.iss.slice("did:web:fake-pds.test:".length),
            )
          ).did()
        : await this.resolveSigningKey(payload.iss).catch(() => undefined);
    }
    if (!sigKey) {
      throw new FakeXrpcError(401, "InvalidSignature", "Unknown issuer signing key");
    }
    const sigOk = await verifySignature(
      sigKey,
      utf8Encoder.encode(`${parts[0]}.${parts[1]}`),
      Uint8Array.from(Buffer.from(parts[2]!, "base64url")),
      { jwtAlg: header.alg },
    ).catch(() => false);
    if (!sigOk) {
      throw new FakeXrpcError(401, "InvalidSignature", "Invalid service JWT signature");
    }
    const rkHost = opts.hostSlug ?? "group-host";
    const rkNs = opts.replayNamespace ?? "jwt";
    const rk = `${rkHost}\u0000${rkNs}\u0000${payload.iss}\u0000${payload.jti}`;
    if (this.usedServiceJtis.has(rk)) {
      throw new FakeXrpcError(401, "ReplayDetected", "Service JWT jti already consumed");
    }
    const consumeJti = () => {
      if (this.usedServiceJtis.has(rk)) {
        throw new FakeXrpcError(401, "ReplayDetected", "Service JWT jti already consumed");
      }
      this.usedServiceJtis.add(rk);
    };
    if (!opts.deferConsume) {
      consumeJti();
    }
    return { iss: payload.iss, aud: payload.aud, jti: payload.jti, expSec: payload.exp, consumeJti };
  }

  private issueFakeDpopNonce(): string {
    const nonce = `fake-dpop-nonce-${++this.dpopNonceCounter}`;
    this.validDpopNonces.add(nonce);
    return nonce;
  }

  private verifyFakeDpopProof(params: {
    dpopHeader: string | undefined;
    method: string;
    expectedHtu: string;
    expectedAccessToken?: string;
  }): { jkt: string; jti: string; freshNonce: string } {
    const freshNonce = this.issueFakeDpopNonce();
    const dpopFail = (code: string, message: string, wwwAuthError = "invalid_dpop_proof"): never => {
      throw new FakeXrpcError(401, code, message, {
        "dpop-nonce": freshNonce,
        "www-authenticate": `DPoP algs="ES256", error="${wwwAuthError}"`,
      });
    };

    const raw = params.dpopHeader;
    if (!raw || raw.trim() === "" || raw.includes(",")) {
      return dpopFail("invalid_dpop_proof", "Missing or duplicate DPoP header.");
    }
    const parts = raw.split(".");
    if (parts.length !== 3) {
      return dpopFail("invalid_dpop_proof", "Malformed DPoP proof.");
    }
    let header: { typ?: unknown; alg?: unknown; jwk?: Record<string, unknown> };
    let payload: { jti?: unknown; htm?: unknown; htu?: unknown; iat?: unknown; nonce?: unknown; ath?: unknown };
    try {
      header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as typeof header;
      payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as typeof payload;
    } catch {
      return dpopFail("invalid_dpop_proof", "Malformed DPoP JSON.");
    }
    if (header.typ !== "dpop+jwt" || header.alg !== "ES256" || !header.jwk || typeof header.jwk !== "object") {
      return dpopFail("invalid_dpop_proof", "Invalid DPoP protected header.");
    }
    const jwk = header.jwk;
    if (
      jwk.kty !== "EC" ||
      jwk.crv !== "P-256" ||
      typeof jwk.x !== "string" ||
      typeof jwk.y !== "string" ||
      typeof jwk.d === "string"
    ) {
      return dpopFail("invalid_dpop_proof", "DPoP header jwk must be a public P-256 key.");
    }

    let sigOk = false;
    try {
      const pubKey = createPublicKey({
        key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
        format: "jwk",
      });
      sigOk = cryptoVerify(
        "sha256",
        utf8Encoder.encode(`${parts[0]}.${parts[1]}`),
        { key: pubKey, dsaEncoding: "ieee-p1363" },
        Uint8Array.from(Buffer.from(parts[2]!, "base64url")),
      );
    } catch {
      sigOk = false;
    }
    if (!sigOk) {
      return dpopFail("invalid_dpop_proof", "Invalid DPoP signature.");
    }

    const nowSec = Math.floor(this.now() / 1000);
    if (typeof payload.iat !== "number" || !Number.isFinite(payload.iat) || Math.abs(nowSec - payload.iat) > 190) {
      return dpopFail("invalid_dpop_proof", "DPoP proof expired or outside freshness window.");
    }
    if (typeof payload.jti !== "string" || payload.jti.length === 0 || payload.jti.length > 256) {
      return dpopFail("invalid_dpop_proof", "DPoP proof must carry a valid jti.");
    }
    if (payload.htm !== params.method) {
      return dpopFail("invalid_dpop_proof", `DPoP htm mismatch: expected ${params.method}.`);
    }
    if (payload.htu !== params.expectedHtu) {
      return dpopFail("invalid_dpop_proof", `DPoP htu mismatch: expected ${params.expectedHtu}.`);
    }

    if (params.expectedAccessToken !== undefined) {
      const expectedAth = createHash("sha256").update(params.expectedAccessToken).digest("base64url");
      if (payload.ath !== expectedAth) {
        return dpopFail("invalid_dpop_proof", "DPoP ath claim missing or does not match access token.");
      }
    } else if (payload.ath !== undefined) {
      return dpopFail("invalid_dpop_proof", "DPoP ath claim must be omitted when no DPoP access token is presented.");
    }

    if (typeof payload.nonce !== "string" || !this.validDpopNonces.has(payload.nonce)) {
      throw new FakeXrpcError(401, "use_dpop_nonce", "DPoP nonce missing or expired.", {
        "dpop-nonce": freshNonce,
        "www-authenticate":
          'DPoP algs="ES256", error="use_dpop_nonce", error_description="Resource server requires nonce in DPoP proof"',
      });
    }

    const jkt = createHash("sha256")
      .update(JSON.stringify({ crv: "P-256", kty: "EC", x: jwk.x, y: jwk.y }))
      .digest("base64url");
    const replayKey = `dpop\u0000${jkt}\u0000${payload.jti}`;
    if (this.usedServiceJtis.has(replayKey)) {
      return dpopFail("invalid_dpop_proof", "DPoP jti replay detected.");
    }
    this.usedServiceJtis.add(replayKey);

    return { jkt, jti: payload.jti, freshNonce };
  }

  private async handleFakeControllerSession(
    params: Record<string, unknown>,
    auth: FakeAuth,
    requestHeaders: Headers | undefined,
    hostSlug = "group-host",
    requestUrl?: URL,
    httpMethod = "POST",
  ): Promise<WithHeaders> {
    if (httpMethod !== "POST") {
      throw new FakeXrpcError(405, "MethodNotAllowed", "POST required");
    }
    const groupDid = typeof params.group === "string" ? params.group : "";
    if (!groupDid) {
      throw new FakeXrpcError(400, "InvalidRequest", "group DID is required.", {
        "dpop-nonce": this.issueFakeDpopNonce(),
      });
    }

    const expectedHtu = requestUrl
      ? `${requestUrl.origin}${requestUrl.pathname}`
      : `${this.hostEndpointUrl(hostSlug)}/group-admin/controller-session`;
    const dpop = this.verifyFakeDpopProof({
      dpopHeader: requestHeaders?.get("dpop") ?? undefined,
      method: "POST",
      expectedHtu,
    });
    const nonceHeaders = { "dpop-nonce": dpop.freshNonce };

    if (!isDid(groupDid)) {
      throw new FakeXrpcError(400, "InvalidRequest", "Invalid group DID.", nonceHeaders);
    }
    if (auth.kind === "none") {
      throw new FakeXrpcError(401, "AuthMissing", "Controller Bearer JWT required.", nonceHeaders);
    }
    if (auth.kind !== "raw-token" || auth.scheme !== "bearer" || !auth.token) {
      throw new FakeXrpcError(401, "InvalidToken", "Controller Bearer JWT required.", nonceHeaders);
    }

    const parts = auth.token.split(".");
    if (parts.length !== 3) {
      throw new FakeXrpcError(401, "InvalidToken", "Malformed controller JWT.", nonceHeaders);
    }
    let header: { typ?: string; alg?: string; kid?: string };
    let payload: { iss?: string; aud?: string; lxm?: string; iat?: number; exp?: number; jti?: string };
    try {
      header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as typeof header;
      payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as typeof payload;
    } catch {
      throw new FakeXrpcError(401, "InvalidToken", "Malformed controller JWT JSON.", nonceHeaders);
    }

    const hostServiceDid = this.hostServiceDid(hostSlug);
    if (
      header.typ !== "JWT" ||
      (header.alg !== "ES256" && header.alg !== "ES256K") ||
      payload.iss !== groupDid ||
      payload.aud !== hostServiceDid ||
      payload.lxm !== "com.atproto.server.createSession" ||
      typeof payload.jti !== "string" ||
      payload.jti.trim().length === 0
    ) {
      throw new FakeXrpcError(401, "InvalidToken", "Invalid controller JWT claims.", nonceHeaders);
    }

    const nowMs = this.now();
    const nowSec = Math.floor(nowMs / 1000);
    const iat = payload.iat;
    if (
      typeof iat !== "number" ||
      !Number.isFinite(iat) ||
      iat > nowSec + 5 ||
      typeof payload.exp !== "number" ||
      !Number.isFinite(payload.exp) ||
      payload.exp <= nowSec ||
      payload.exp <= iat ||
      payload.exp - iat > 60
    ) {
      throw new FakeXrpcError(401, "ExpiredToken", "Controller JWT expired or exceeds 60s lifetime.", nonceHeaders);
    }

    const signingDidKey = header.kid;
    if (typeof signingDidKey !== "string" || !signingDidKey.startsWith("did:key:z")) {
      throw new FakeXrpcError(401, "InvalidToken", "Controller JWT header.kid must be a PLC rotation did:key.", nonceHeaders);
    }

    const currentHost = this.accounts.get(groupDid);
    if (!currentHost || this.unavailable.get(groupDid) === "RepoNotFound") {
      throw new FakeXrpcError(400, "UnresolvableDid", "Group DID unresolvable or tombstoned.", nonceHeaders);
    }
    if (currentHost !== hostSlug) {
      throw new FakeXrpcError(403, "Forbidden", "Group PLC #atproto_pds does not point to this host.", nonceHeaders);
    }

    const grp = this.groups.get(groupDid);
    if (!grp) {
      throw new FakeXrpcError(400, "RepoNotFound", "Group account not hosted here.", nonceHeaders);
    }

    if (signingDidKey === grp.localRotationKey.did() || !grp.sovereignRotationKeys.has(signingDidKey)) {
      throw new FakeXrpcError(
        403,
        "Forbidden",
        "Controller JWT must be signed by an external sovereign PLC rotation key.",
        nonceHeaders,
      );
    }

    const validSig = await verifySignature(
      signingDidKey,
      utf8Encoder.encode(`${parts[0]}.${parts[1]}`),
      Uint8Array.from(Buffer.from(parts[2]!, "base64url")),
      { jwtAlg: header.alg },
    ).catch(() => false);
    if (!validSig) {
      throw new FakeXrpcError(401, "InvalidSignature", "Controller JWT signature invalid.", nonceHeaders);
    }

    const jtiKey = `ctrl\u0000${signingDidKey}\u0000${payload.jti}`;
    if (this.usedServiceJtis.has(jtiKey)) {
      throw new FakeXrpcError(401, "ReplayDetected", "Controller JWT jti already used.", nonceHeaders);
    }
    this.usedServiceJtis.add(jtiKey);

    const unavail = this.unavailable.get(groupDid);
    if (unavail === "RepoTakendown") {
      throw new FakeXrpcError(400, "RepoTakendown", "Group taken down.", nonceHeaders);
    }

    const sessionKind: "group" | "recovery" = unavail === "RepoDeactivated" ? "recovery" : "group";
    const approvedScopes = groupAdminScopes(groupDid);
    const scope = approvedScopes.join(" ");
    const accessToken = `fake-ctrl-at-${randomUUID()}`;
    const refreshToken = `ghr_${randomStr(32, "base64url")}`;

    this.sessions.set(accessToken, {
      did: groupDid,
      scope: "full",
      authorizingUserDid: groupDid,
      approvedScopes,
      sessionKind,
      authenticatedAtMs: nowMs,
      loginStepUpAtMs: nowMs,
      sessionAuthEpoch: grp.authEpoch,
      dpopJkt: dpop.jkt,
    });

    return new WithHeaders(
      {
        access_token: accessToken,
        token_type: "DPoP",
        sub: groupDid,
        scope,
        refresh_token: refreshToken,
        expires_in: 900,
      },
      {
        "dpop-nonce": dpop.freshNonce,
        "cache-control": "no-store",
      },
    );
  }

  private async verifyFakeNotifyRepoUpdateJwt(
    auth: FakeAuth,
    authorityDid: string,
    expectedRepoDid: string,
  ): Promise<void> {
    if (auth.kind === "none") {
      throw new FakeXrpcError(401, "AuthMissing", "Service JWT required");
    }
    if (auth.kind === "rejected") throw auth.error;
    if (auth.kind !== "raw-token" || auth.scheme !== "bearer" || !auth.token || auth.token.length > 8192) {
      throw new FakeXrpcError(401, "InvalidToken", "Bearer service JWT required");
    }

    const parts = auth.token.split(".");
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
      throw new FakeXrpcError(401, "InvalidToken", "Malformed Bearer JWT");
    }
    let header: Record<string, unknown>;
    let payload: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Record<string, unknown>;
      payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
    } catch {
      throw new FakeXrpcError(401, "InvalidToken", "Malformed JWT JSON");
    }
    if (typeof header.alg !== "string" || (header.alg !== "ES256" && header.alg !== "ES256K")) {
      throw new FakeXrpcError(401, "InvalidToken", "Unsupported service JWT alg");
    }
    if (header.typ === "at+jwt" || header.typ === "refresh+jwt" || header.typ === "dpop+jwt") {
      throw new FakeXrpcError(401, "InvalidToken", `Invalid service JWT typ '${String(header.typ)}'`);
    }
    if (
      typeof payload.iss !== "string" ||
      typeof payload.aud !== "string" ||
      typeof payload.exp !== "number" ||
      !Number.isFinite(payload.exp) ||
      (payload.iat !== undefined && (typeof payload.iat !== "number" || !Number.isFinite(payload.iat)))
    ) {
      throw new FakeXrpcError(401, "InvalidToken", "Missing or malformed service JWT claims");
    }

    const bareIss = payload.iss.split("#", 1)[0]!;
    if (bareIss !== expectedRepoDid) {
      throw new FakeXrpcError(403, "Forbidden", "Notification iss does not match repo");
    }
    if (payload.lxm !== "com.atproto.space.notifyRepoUpdate") {
      throw new FakeXrpcError(401, "InvalidToken", "Invalid notifyRepoUpdate lxm");
    }
    if (payload.aud !== authorityDid && payload.aud !== `${authorityDid}#atproto_pds`) {
      throw new FakeXrpcError(403, "Forbidden", "Notification aud does not match space authority");
    }

    const nowSec = Math.floor(this.now() / 1000);
    if (payload.exp <= nowSec) {
      throw new FakeXrpcError(401, "ExpiredToken", "Service JWT expired");
    }
    if (
      typeof payload.iat === "number" &&
      (payload.iat > nowSec + 5 || payload.exp <= payload.iat)
    ) {
      throw new FakeXrpcError(401, "InvalidToken", "Invalid notifyRepoUpdate JWT iat/exp bounds");
    }

    const sigKey = await this.resolveSigningKey(bareIss).catch(() => undefined);
    if (!sigKey) {
      throw new FakeXrpcError(400, "UnresolvableDid", `DID not found or tombstoned: ${bareIss}`);
    }
    const valid = await verifySignature(
      sigKey,
      utf8Encoder.encode(`${parts[0]}.${parts[1]}`),
      Uint8Array.from(Buffer.from(parts[2], "base64url")),
      { jwtAlg: header.alg },
    ).catch(() => false);
    if (!valid) {
      throw new FakeXrpcError(401, "InvalidSignature", "Invalid notifyRepoUpdate JWT signature");
    }
  }

  private async handleInboundNotifyRepoUpdate(
    params: Record<string, unknown>,
    auth: FakeAuth,
    deliveries: Promise<void>[],
  ) {
    const spaceUriStr = typeof params.space === "string" ? params.space : "";
    const repo = typeof params.repo === "string" ? params.repo : "";
    const repoRev = typeof params.repoRev === "string" ? params.repoRev : "";
    if (!spaceUriStr || !repo || !repoRev || params.data === undefined || params.data === null) {
      throw new FakeXrpcError(400, "InvalidRequest", "space, repo, repoRev, and data are required");
    }
    const parsedSpace = this.requireSpaceRef(spaceUriStr);
    const authorityDid = parsedSpace.authorityDid;

    await this.verifyFakeNotifyRepoUpdateJwt(auth, authorityDid, repo);

    const nowMs = this.now();
    if (!isTid(repoRev)) {
      throw new FakeXrpcError(
        400,
        "InvalidRequest",
        "repoRev must be a canonical 13-char TID starting with [234567abcdefghij]",
      );
    }
    if (Number(tidTimestampUs(repoRev) / 1000n) > nowMs + 5 * 60_000) {
      throw new FakeXrpcError(400, "FutureRev", "repoRev is more than 5 minutes in the future");
    }

    let data: Uint8Array;
    try {
      let rawB64: string;
      if (typeof params.data === "string") {
        rawB64 = params.data;
      } else if (
        params.data &&
        typeof params.data === "object" &&
        !Array.isArray(params.data) &&
        typeof (params.data as { $bytes?: unknown }).$bytes === "string"
      ) {
        rawB64 = (params.data as { $bytes: string }).$bytes;
      } else {
        throw new Error("missing bytes");
      }
      if (rawB64.length === 0) {
        throw new Error("empty bytes");
      }
      data = fromBase64(rawB64);
    } catch {
      throw new FakeXrpcError(400, "InvalidRequest", "Invalid base64 data digest");
    }
    if (data.byteLength !== 32) {
      throw new FakeXrpcError(400, "InvalidRequest", "Repo commit data digest must be 32 bytes");
    }

    const applyUpdate = () => {
      const grp = this.groups.get(authorityDid);
      if (grp) {
        this.assertNoActiveFakeMigrationLease(grp);
      }
      this.assertActiveSpaceHost(authorityDid);
      const targetSpace = this.requireActiveSpace(spaceUriStr);
      if (!this.currentlyAuthorizedSyncWriter(targetSpace, repo)) {
        throw new FakeXrpcError(403, "Forbidden", `${repo} does not hold write access to ${spaceUriStr}`);
      }
      if (grp && spaceUriStr === groupMembersUri(authorityDid)) {
        const state = this.loadFakeGovernanceState(authorityDid);
        const membership = state.memberships.get(repo);
        if (membership) {
          const ext = decodeFlockMembershipExtensions(membership);
          if (!ext.valid) {
            throw new FakeXrpcError(400, ext.code, ext.reason);
          }
          if (ext.afterWriterRev !== undefined && ext.afterWriterRev !== null) {
            if (!(repoRev > ext.afterWriterRev)) {
              throw new FakeXrpcError(
                409,
                "StalePreEjectionRepo",
                `Writer repoRev (${repoRev}) does not advance past pre-ejection rev (${ext.afterWriterRev})`,
              );
            }
          }
        }
      }
      const update = this.recordWriterEntry(targetSpace, repo, repoRev, data);
      if (update) deliveries.push(this.deliverSpaceUpdate(targetSpace, update));
    };

    if (this.groups.has(authorityDid)) {
      await this.withFakeGroupLock(authorityDid, applyUpdate);
    } else {
      applyUpdate();
    }
    return {};
  }

  private async handleInboundNotifyCredentialsRevoked(
    params: Record<string, unknown>,
    auth: FakeAuth,
    requestUrl?: URL,
  ) {
    if (typeof params.space !== "string" || !Array.isArray(params.credentials)) {
      throw new FakeXrpcError(400, "InvalidRequest", "space and credentials array are required");
    }
    const parsed = this.requireSpaceRef(params.space);
    if (
      params.credentials.length < 1 ||
      params.credentials.length > 100 ||
      params.credentials.some((cred) => typeof cred !== "string" || cred.length < 1 || cred.length > 256)
    ) {
      throw new FakeXrpcError(400, "InvalidRequest", "credentials must contain 1..100 strings (1..256 chars)");
    }
    if (auth.kind === "none") {
      throw new FakeXrpcError(401, "AuthMissing", "Bearer service JWT required");
    }
    if (auth.kind === "rejected") throw auth.error;
    if (auth.kind !== "raw-token" || auth.scheme !== "bearer" || !auth.token || auth.token.length > 8192) {
      throw new FakeXrpcError(401, "InvalidToken", "Bearer service JWT required");
    }

    const parts = auth.token.split(".");
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
      throw new FakeXrpcError(401, "InvalidToken", "Malformed notifyCredentialsRevoked JWT");
    }
    let header: { alg?: string; typ?: string };
    let payload: { iss?: string; aud?: string; lxm?: string; iat?: number; exp?: number; jti?: string };
    try {
      header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as typeof header;
      payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as typeof payload;
    } catch {
      throw new FakeXrpcError(401, "InvalidToken", "Malformed notifyCredentialsRevoked JWT JSON");
    }
    if (header.typ !== "JWT") {
      throw new FakeXrpcError(401, "InvalidToken", "Invalid notifyCredentialsRevoked JWT typ");
    }
    if (header.alg !== "ES256" && header.alg !== "ES256K") {
      throw new FakeXrpcError(401, "InvalidToken", "Unsupported notifyCredentialsRevoked JWT alg");
    }
    const nowMs = this.now();
    const nowSec = Math.floor(nowMs / 1000);
    const bareIss = typeof payload.iss === "string" ? payload.iss.split("#", 1)[0]! : "";
    if (
      !isDid(bareIss) ||
      bareIss !== parsed.authorityDid ||
      typeof payload.aud !== "string" ||
      payload.aud.includes("#") ||
      !isDid(payload.aud) ||
      payload.lxm !== "com.atproto.space.notifyCredentialsRevoked" ||
      typeof payload.iat !== "number" ||
      !Number.isFinite(payload.iat) ||
      payload.iat > nowSec + CLOCK_SKEW_SEC ||
      typeof payload.exp !== "number" ||
      !Number.isFinite(payload.exp) ||
      payload.exp <= nowSec ||
      payload.exp - payload.iat <= 0 ||
      payload.exp - payload.iat > 60 ||
      typeof payload.jti !== "string" ||
      payload.jti.length < 1 ||
      payload.jti.length > 256 ||
      payload.jti.trim().length === 0
    ) {
      throw new FakeXrpcError(401, "InvalidToken", "Invalid notifyCredentialsRevoked JWT claims");
    }

    const audDid = payload.aud;
    const writerHost = this.accounts.get(audDid);
    if (!writerHost || this.unavailable.has(audDid)) {
      throw new FakeXrpcError(403, "Forbidden", "Audience is not an active hosted account DID");
    }
    if (requestUrl) {
      const urlSlugMatch = /^\/([^/]+)\/xrpc\//.exec(requestUrl.pathname);
      const urlHostSlug = urlSlugMatch?.[1];
      if (urlHostSlug && writerHost !== urlHostSlug) {
        throw new FakeXrpcError(403, "Forbidden", "Audience DID is not hosted on this endpoint");
      }
    }

    const spaceUriStr = params.space;
    if (this.groups.has(audDid)) {
      if (bareIss !== audDid) {
        if (!this.accountRepos.get(audDid)?.has(spaceUriStr)) {
          throw new FakeXrpcError(403, "Forbidden", "Hosted group has no repository in the target space");
        }
      } else {
        const ownSpace = this.spaces.get(spaceUriStr);
        if (!ownSpace || ownSpace.ownerDid !== audDid || ownSpace.deleted) {
          throw new FakeXrpcError(403, "Forbidden", "Target space does not exist for hosted group");
        }
      }
    } else if (bareIss === audDid) {
      const ownSpace = this.spaces.get(spaceUriStr);
      if (!ownSpace || ownSpace.ownerDid !== audDid || ownSpace.deleted) {
        throw new FakeXrpcError(403, "Forbidden", "Target space does not exist for hosted account");
      }
    } else {
      const hasRepo = Boolean(this.accountRepos.get(audDid)?.has(spaceUriStr));
      let hasDelegation = false;
      if (!hasRepo) {
        for (const del of this.delegations.values()) {
          if (del.granteeDid === audDid && del.space === spaceUriStr) {
            hasDelegation = true;
            break;
          }
        }
      }
      if (!hasRepo && !hasDelegation) {
        throw new FakeXrpcError(403, "Forbidden", "Hosted account has no repository or delegation in the target space");
      }
    }

    const sigKey = await this.resolveSigningKey(bareIss).catch(() => undefined);
    if (!sigKey) {
      throw new FakeXrpcError(401, "InvalidSignature", "Unknown authority signing key");
    }
    const sigOk = await verifySignature(
      sigKey,
      utf8Encoder.encode(`${parts[0]}.${parts[1]}`),
      Uint8Array.from(Buffer.from(parts[2], "base64url")),
      { jwtAlg: header.alg },
    ).catch(() => false);
    if (!sigOk) {
      throw new FakeXrpcError(401, "InvalidSignature", "Invalid notifyCredentialsRevoked JWT signature");
    }

    const jtiKey = `credrev:${bareIss}:${payload.jti}`;
    const existingJtiExp = this.usedCredRevJtis.get(jtiKey);
    if (existingJtiExp !== undefined && existingJtiExp > nowMs) {
      throw new FakeXrpcError(401, "ReplayDetected", "notifyCredentialsRevoked JWT jti already consumed");
    }

    const windowKey = `${bareIss}\u0000${audDid}`;
    const cutoffMs = nowMs - 60_000;
    const recent = (this.credRevocationWindows.get(windowKey) ?? []).filter((e) => e.atMs > cutoffMs);
    const recentIds = recent.reduce((acc, e) => acc + e.count, 0);
    const credArray = params.credentials as string[];
    if (recent.length + 1 > 30 || recentIds + credArray.length > 2_000) {
      this.credRevocationWindows.set(windowKey, recent);
      throw new FakeXrpcError(429, "RateLimitExceeded", "notifyCredentialsRevoked rate or amplification limit exceeded");
    }

    const audSpaceKey = `${audDid}\u0000${spaceUriStr}`;
    let spaceMap = this.storedRevokedByAudSpace.get(audSpaceKey);
    if (!spaceMap) {
      spaceMap = new Map();
      this.storedRevokedByAudSpace.set(audSpaceKey, spaceMap);
    }
    for (const [cj, expAt] of spaceMap) {
      if (expAt <= nowSec) spaceMap.delete(cj);
    }
    const uniqueCreds = [...new Set(credArray)];
    let netNew = 0;
    for (const cj of uniqueCreds) {
      if (!spaceMap.has(cj)) netNew += 1;
    }
    if (spaceMap.size + netNew > 10_000) {
      throw new FakeXrpcError(429, "RateLimitExceeded", "Stored revoked_credential quota exceeded for target space");
    }

    this.usedCredRevJtis.set(jtiKey, (payload.exp + 5) * 1000);
    recent.push({ atMs: nowMs, count: credArray.length });
    this.credRevocationWindows.set(windowKey, recent);

    const credExpSec = nowSec + SPACE_CREDENTIAL_LIFETIME_SEC;
    for (const credJti of uniqueCreds) {
      spaceMap.set(credJti, credExpSec);
      this.revokeCredential(spaceUriStr, credJti);
    }
    return {};
  }
}

function sha256HexBytesLocal(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function cborDecode(bytes: Uint8Array): unknown {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;

  const readArg = (ai: number): number => {
    if (ai < 24) return ai;
    if (ai === 24) {
      const v = view.getUint8(offset);
      offset += 1;
      return v;
    }
    if (ai === 25) {
      const v = view.getUint16(offset, false);
      offset += 2;
      return v;
    }
    if (ai === 26) {
      const v = view.getUint32(offset, false);
      offset += 4;
      return v;
    }
    if (ai === 27) {
      const v = Number(view.getBigUint64(offset, false));
      offset += 8;
      return v;
    }
    throw new Error(`Unsupported CBOR additional info: ${ai}`);
  };

  const readItem = (): unknown => {
    if (offset >= bytes.byteLength) throw new Error("Unexpected end of CBOR input");
    const first = view.getUint8(offset);
    offset += 1;
    const major = first >> 5;
    const ai = first & 0x1f;

    if (major === 0) return readArg(ai);
    if (major === 1) return -1 - readArg(ai);
    if (major === 2) {
      const len = readArg(ai);
      const out = bytes.slice(offset, offset + len);
      offset += len;
      return out;
    }
    if (major === 3) {
      const len = readArg(ai);
      const out = utf8Decoder.decode(bytes.subarray(offset, offset + len));
      offset += len;
      return out;
    }
    if (major === 4) {
      const len = readArg(ai);
      const arr: unknown[] = [];
      for (let i = 0; i < len; i += 1) arr.push(readItem());
      return arr;
    }
    if (major === 5) {
      const len = readArg(ai);
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < len; i += 1) {
        const k = String(readItem());
        obj[k] = readItem();
      }
      return obj;
    }
    if (major === 6) {
      const tag = readArg(ai);
      const inner = readItem();
      if (tag === 42 && inner instanceof Uint8Array && inner.byteLength > 1 && inner[0] === 0) {
        return decodeCid(inner.subarray(1));
      }
      throw new Error(`Unsupported CBOR tag: ${tag}`);
    }
    if (ai === 20) return false;
    if (ai === 21) return true;
    if (ai === 22) return null;
    if (ai === 26) {
      const v = view.getFloat32(offset, false);
      offset += 4;
      return v;
    }
    if (ai === 27) {
      const v = view.getFloat64(offset, false);
      offset += 8;
      return v;
    }
    throw new Error(`Unsupported CBOR simple/float value: ${ai}`);
  };

  return readItem();
}

function compareLex(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const len = Math.min(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    if (left[i] !== right[i]) return left[i]! - right[i]!;
  }
  return left.length - right.length;
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function clampLimit(raw: unknown, fallback: number, max: number): number {
  const value = typeof raw === "number" ? raw : raw !== undefined ? Number(raw) : fallback;
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(max, Math.floor(value));
}

function parseRepoOpsCursor(cursor: string): { rev: string; idx: number } {
  const slash = cursor.indexOf("/");
  if (slash <= 0) throw new FakeXrpcError(400, "InvalidCursor", "Malformed cursor");
  const rev = cursor.slice(0, slash);
  const idxStr = cursor.slice(slash + 1);
  if (!/^\d+$/.test(idxStr)) throw new FakeXrpcError(400, "InvalidCursor", "Malformed cursor");
  return { rev, idx: Number(idxStr) };
}

function isSpaceRecordCursor(value: string): boolean {
  return isAtUriString(value);
}

function spaceUri(space: FakeSpace): string {
  return buildSpaceUri(space.ownerDid, space.type, space.skey);
}

function normalizeBaseUrl(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function notifyKey(endpoint: string, token: string): string {
  return `${endpoint}\u0000${token}`;
}

function parseNotifyParam(raw: unknown): { endpoint: string; token: string } | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new FakeXrpcError(400, "InvalidRequest", "Invalid notify registration");
  }
  const candidate = raw as { endpoint?: unknown; token?: unknown };
  if (typeof candidate.endpoint !== "string" || candidate.endpoint.length === 0) {
    throw new FakeXrpcError(400, "InvalidRequest", "notify.endpoint must be a URI");
  }
  try {
    new URL(candidate.endpoint);
  } catch {
    throw new FakeXrpcError(400, "InvalidRequest", "notify.endpoint must be a valid URI");
  }
  if (typeof candidate.token !== "string" || candidate.token.length > 512) {
    throw new FakeXrpcError(400, "InvalidRequest", "notify.token must be a string up to 512 characters");
  }
  return { endpoint: candidate.endpoint, token: candidate.token };
}

function isDidServiceRef(value: string): boolean {
  return /^did:[a-z0-9]+:[^\s#]+#[A-Za-z0-9._-]+$/.test(value);
}

function toStoredPolicy(policy: unknown): FakeSpace["policy"] {
  const fields = (policy ?? {}) as {
    $type?: unknown;
    publicRead?: unknown;
    publicWrite?: unknown;
    allowedApps?: unknown;
    publishPolicy?: unknown;
    publishMembers?: unknown;
    managingApp?: unknown;
  };
  if (fields.$type === MEMBERSPACE_POLICY) {
    let allowedApps: string[] | undefined;
    if (fields.allowedApps !== undefined) {
      if (!Array.isArray(fields.allowedApps)) {
        throw new FakeXrpcError(400, "InvalidRequest", "allowedApps must be an array of URIs");
      }
      allowedApps = fields.allowedApps.map((app) => {
        if (typeof app !== "string") throw new FakeXrpcError(400, "InvalidRequest", "allowedApps entries must be URIs");
        try {
          new URL(app);
        } catch {
          throw new FakeXrpcError(400, "InvalidRequest", `allowedApps entry is not a valid URI: ${app}`);
        }
        return app;
      });
    }
    return {
      $type: MEMBERSPACE_POLICY,
      publicRead: fields.publicRead === true,
      publicWrite: fields.publicWrite === true,
      ...(allowedApps !== undefined ? { allowedApps } : {}),
      ...(fields.publishPolicy === true ? { publishPolicy: true } : {}),
      ...(fields.publishMembers === true ? { publishMembers: true } : {}),
    };
  }
  if (fields.$type === PERSONALSPACE_POLICY) {
    return { $type: PERSONALSPACE_POLICY, publicRead: false, publicWrite: false };
  }
  if (fields.$type === MANAGEDSPACE_POLICY) {
    if (typeof fields.managingApp !== "string" || !isDidServiceRef(fields.managingApp)) {
      throw new FakeXrpcError(
        400,
        "InvalidRequest",
        `managingApp must be a did#serviceId reference, got: ${String(fields.managingApp)}`,
      );
    }
    return {
      $type: MANAGEDSPACE_POLICY,
      publicRead: false,
      publicWrite: false,
      managingApp: fields.managingApp,
      ...(fields.publishPolicy === true ? { publishPolicy: true } : {}),
    };
  }
  throw new FakeXrpcError(400, "UnsupportedPolicy", "The requested policy is not one the host implements.");
}

function toPublicPolicy(policy: FakeSpace["policy"]): Record<string, unknown> {
  if (policy.$type === MEMBERSPACE_POLICY) {
    return {
      $type: MEMBERSPACE_POLICY,
      publicRead: policy.publicRead,
      publicWrite: policy.publicWrite,
      ...(policy.allowedApps !== undefined ? { allowedApps: policy.allowedApps } : {}),
      ...(policy.publishPolicy === true ? { publishPolicy: true } : {}),
      ...(policy.publishMembers === true ? { publishMembers: true } : {}),
    };
  }
  if (policy.$type === MANAGEDSPACE_POLICY) {
    return {
      $type: MANAGEDSPACE_POLICY,
      managingApp: policy.managingApp,
      publishPolicy: policy.publishPolicy === true,
    };
  }
  if (policy.$type === ATGRP_POLICY) {
    return {
      $type: ATGRP_POLICY,
      publicRead: policy.publicRead === true,
      unlisted: policy.unlisted === true,
      grants: (policy.grants ?? []).map((g) => ({
        role: g.role,
        ...(g.read !== undefined ? { read: g.read } : {}),
        ...(g.write !== undefined ? { write: g.write } : {}),
        ...(g.permissions ? { permissions: [...g.permissions] } : {}),
      })),
    };
  }
  return { $type: policy.$type };
}

function commitJson(commit: { ver: number; repo: string; space: string; rev: string; data: Uint8Array }) {
  return { ver: commit.ver, repo: commit.repo, space: commit.space, rev: commit.rev, data: { $bytes: toBase64(commit.data) } };
}

function jsonToB64Url(json: Record<string, unknown>): string {
  return toBase64(utf8Encoder.encode(JSON.stringify(json)), "base64url");
}

const TID_ALPHABET = "234567abcdefghijklmnopqrstuvwxyz";

/** A 13-character TID whose lexical order follows `counter`. */
function fakeTid(counter: number): string {
  let rest = counter;
  let tid = "";
  for (let i = 0; i < 13; i++) {
    tid = TID_ALPHABET[rest % 32]! + tid;
    rest = Math.floor(rest / 32);
  }
  return tid;
}

function errorResponse(error: FakeXrpcError): Response {
  return new Response(JSON.stringify({ error: error.code, message: error.message }), {
    status: error.status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": CORS_ALLOW_HEADERS,
      ...error.headers,
    },
  });
}

function rejected(status: number, code: string, message: string, headers?: Record<string, string>): FakeAuth {
  return { kind: "rejected", error: new FakeXrpcError(status, code, message, headers) };
}
