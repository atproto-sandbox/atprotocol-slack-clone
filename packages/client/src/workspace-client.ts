import { listAllSpaceUris, listBoundedRecords, listBoundedWriters } from "@flock/protocol/atproto/record-pages";
import { classifyRepoFailure } from "@flock/protocol/atproto/repo-failure";
import {
  createTimestampedSpaceSigHeaders,
  isAccessLost,
  isSpaceDeleted,
  SpaceCredentialError,
  type SpaceNotifyTarget,
} from "@flock/protocol/atproto/space-credential-core";
import { memberspacePolicy, readMemberspacePolicy } from "@flock/protocol/atproto/space-policy";
import { isMissingXrpcResource, isSpaceAlreadyExists, XrpcError } from "@flock/protocol/atproto/xrpc";
import { readUpstreamJson } from "@flock/protocol/bounded-json";
import {
  canonicalJson,
  decisionRecordKey,
  groupMembersUri,
  groupMetaUri,
  inboxUri,
  isDid,
  isTid,
  normalizeLegacySpaceUri,
  parseGroupMembersUri,
  parseWorkspaceUri,
  personalInvitesUri,
  SELF_SKEY,
  spaceRecordUri,
  tidNow,
  workspaceUri,
} from "@flock/protocol/keys";
export { normalizeLegacySpaceUri };
import { mapLimited } from "@flock/protocol/map-limited";
import { isTakendown, projectActiveLabels } from "@flock/protocol/moderation";
import {
  ATPROTO_SPACE_COLLECTION,
  COLLECTION,
  FLOCK_EXTENSION_FIELD,
  OPENSOCIAL_COLLECTION,
  OPENSOCIAL_METHOD,
  OPENSOCIAL_SPACE_TYPE,
  REPO_COLLECTION,
} from "@flock/protocol/nsids";
import { MAX_RECORD_BYTES, validateAppDeclaration, validateSpaceRecord } from "@flock/protocol/registry";
import type { GroupOpenSocialPolicy } from "@flock/protocol/scopes";
import {
  extractGroupSpacePolicyRecord,
  summarizeWorkspace,
  WORKSPACE_ENVELOPE,
  workspaceDegradedMessage,
  WorkspaceEnvelopeError,
  type MemberAcceptanceEntry,
  type MemberWriterRev,
  type WorkspaceSummary,
} from "@flock/protocol/workspace-summary";
import type { CredentialCache } from "./credentials";
import {
  IdempotencyParameterMismatchError,
  IncompatibleInvitesSpacePolicyError,
  isDidTombstonedError,
  JoinOperationQuotaExceededError,
  UnsupportedJoinStatusError,
} from "./errors";
import type { GroupClient } from "./group-client";
import { readWriterJoinRequests, type InboxJoinRequest, type SkippedInboxWriter } from "./inbox-requests";
import type { Lifecycle } from "./lifecycle";
import { MemoryStore } from "./memory-store";
import { OperatorRemoteError, type OperatorClient } from "./operator-client";
import type {
  JoiningGroupCreateParams,
  JoiningGroupEntry,
  JoiningGroupMode,
  JoiningGroupPhase,
  LeavingGroupEntry,
  ReactivatingGroupEntry,
  StoredRecord,
  SyncStore,
} from "./store";
import { transportNow, type ClientTransport } from "./transport";

export { IdempotencyParameterMismatchError };
export type { WorkspaceSummary };

const MAX_DISCOVERABLE_WORKSPACES = 1_000;
const MAX_INBOX_WRITERS = 2_000;
const MAX_DECLARATION_BYTES = MAX_RECORD_BYTES + 4 * 1024;
const MAX_GROUP_MEMBER_JSON_BYTES = 256 * 1024;

type BrowserLocksApi = {
  request<T>(name: string, options: { mode: "exclusive" }, callback: () => Promise<T>): Promise<T>;
};

function getBrowserLocks(): BrowserLocksApi | undefined {
  const nav = (globalThis as { navigator?: { locks?: BrowserLocksApi } }).navigator;
  return nav?.locks;
}

async function sha256HexWeb(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** A slash command an app advertises in its public declaration. */
export type DeclaredCommand = { name: string; description?: string; usage?: string };

/** What an app account says it is, in its own repo: the name people see and the commands it offers. A label, never a grant. */
export type AppDeclaration = { name: string; description?: string; commands?: DeclaredCommand[] };

export type WorkspaceCompleteness = {
  rosterComplete: boolean;
  extensionsComplete: boolean;
  invalidRosterRecords: number;
  invalidExtInstallRecords: number;
  takendownMembers?: string[];
};

export type DiscoveredWorkspace = WorkspaceSummary & WorkspaceCompleteness;

export type WorkspaceCandidate = { uri: string; authorityDid: string; skey: string };

export type ReceivedGroupInvite = {
  uri: string;
  rkey: string;
  groupDid: string;
  createdAt: string;
  expiresAt?: string;
  message?: string;
  groupName?: string;
  groupDescription?: string;
};

export type WorkspaceDiscovery = {
  workspaces: DiscoveredWorkspace[];
  candidates: WorkspaceCandidate[];
  joiningGroups?: JoiningGroupEntry[];
  leavingGroups?: LeavingGroupEntry[];
  reactivatingGroups?: ReactivatingGroupEntry[];
};

export type JoinStatusResponse = {
  state: "admitted" | "pending" | "denied" | "cancelled" | "unknown" | "left_deactivated";
  currentIncarnation?: string;
  membership?: { uri: string; cid: string };
};

export type CreatedGroupWorkspace = {
  operationId: string;
  groupDid: string;
  workspace: string;
  state: "completed" | "pending";
  completedSteps?: string[];
  error?: string;
};

const VALID_JOIN_STATUS_STATES = new Set<JoinStatusResponse["state"]>([
  "admitted",
  "pending",
  "denied",
  "cancelled",
  "unknown",
  "left_deactivated",
]);

export type ReactivateGroupHooks = {
  getGroupClient?: (groupDid: string) => Promise<GroupClient> | GroupClient;
  reauthorizeOperator?: (groupDid: string) => Promise<boolean | void> | boolean | void;
  operator?: OperatorClient;
};

export type WorkspaceClientDeps = {
  transport: ClientTransport;
  credentials: CredentialCache;
  lifecycle: Lifecycle;
  store?: SyncStore;
  sync?: {
    readonly store?: SyncStore;
    markSpaceStale(space: string): Promise<void>;
  };
  operator?: OperatorClient;
  getGroupClient?: (groupDid: string) => Promise<GroupClient> | GroupClient;
  reauthorizeOperator?: (groupDid: string) => Promise<boolean | void> | boolean | void;
};

const TERMINAL_JOIN_XRPC_CODES = new Set([
  "InvalidInvite",
  "JoinClosed",
  "NoDefaultRole",
  "JoinRequestClosed",
  "IdempotencyParameterMismatch",
  "SubjectIsAppServicePrincipal",
  "CannotTargetGroupSelf",
]);

const PASSIVE_JOIN_PHASES = new Set([
  "orphaned_by_migration",
  "expired_unknown",
  "unsupported_status",
  "quota_exceeded",
]);

const POST_ADMISSION_JOIN_PHASES = new Set<JoiningGroupPhase>([
  "membership_verified",
  "acceptance_pending",
  "discovery_verified",
]);

/**
 * The member's OpenSocial groups & Flock workspaces: finding them, provisioning `invites/self`,
 * crash-safe 3-phase leaving, 5-phase migration-aware joining, 4-phase reactivation, and inbox review.
 */
export class WorkspaceClient {
  private readonly store: SyncStore;
  private readonly lifecycleLocks = new Map<string, Promise<unknown>>();
  private readonly activeForegroundCreates = new Set<string>();
  private invitesSpaceVerified = false;
  private invitesProvisionInFlight: Promise<string> | null = null;

  constructor(private readonly deps: WorkspaceClientDeps) {
    this.store = deps.store ?? deps.sync?.store ?? new MemoryStore();
  }

  /** Resets the in-memory `invitesSpaceVerified` flag (e.g. for simulated restart tests over a shared instance). */
  resetInvitesVerificationCache(): void {
    this.invitesSpaceVerified = false;
  }

  private async withGroupLifecycleLock<T>(groupDid: string, fn: () => Promise<T>): Promise<T> {
    const key = `${this.deps.transport.did}\0${groupDid}`;
    const runExclusive = async (): Promise<T> => {
      const locks = getBrowserLocks();
      if (locks) {
        return locks.request(`flock-acceptance:${this.deps.transport.did}:${groupDid}`, { mode: "exclusive" }, fn);
      }
      return fn();
    };
    const prev = this.lifecycleLocks.get(key) ?? Promise.resolve();
    const current = prev.catch(() => undefined).then(runExclusive);
    this.lifecycleLocks.set(key, current);
    try {
      return await current;
    } finally {
      if (this.lifecycleLocks.get(key) === current) {
        this.lifecycleLocks.delete(key);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // App Declarations & Handle Resolution
  // ---------------------------------------------------------------------------

  async appDeclaration(did: string): Promise<AppDeclaration | null> {
    if (!isDid(did)) throw new TypeError("An app is named by its DID.");
    const url = new URL("/xrpc/com.atproto.repo.getRecord", await this.deps.transport.resolvePds(did));
    for (const [name, value] of Object.entries({ repo: did, collection: REPO_COLLECTION.appDeclaration, rkey: "self" })) {
      url.searchParams.set(name, value);
    }
    const response = await this.deps.transport.fetchEndpoint(new Request(url, { headers: { accept: "application/json" } }));
    const body = await readUpstreamJson<{ value?: unknown; error?: string }>(response, MAX_DECLARATION_BYTES);
    if (!response.ok) {
      if (body?.error === "RecordNotFound") return null;
      throw new Error(`Could not read the app declaration of ${did} (${response.status}).`);
    }
    const value = body?.value;
    if (!validateAppDeclaration(value).valid) return null;
    const { name, description, commands } = value as {
      name: string;
      description?: string;
      commands?: Array<{ name: string; description?: string; usage?: string }>;
    };
    return {
      name,
      ...(description === undefined ? {} : { description }),
      ...(commands === undefined
        ? {}
        : {
            commands: commands.map((command) => ({
              name: command.name,
              ...(command.description === undefined ? {} : { description: command.description }),
              ...(command.usage === undefined ? {} : { usage: command.usage }),
            })),
          }),
    };
  }

  async resolveAccount(account: string): Promise<string> {
    const input = account.trim().replace(/^@/, "");
    if (isDid(input)) return input;
    const { did } = await this.deps.transport.memberClient.query<{ did: string }>(
      "com.atproto.identity.resolveHandle",
      { handle: input },
    );
    if (!isDid(did)) throw new Error(`The handle ${input} did not resolve to a DID.`);
    return did;
  }

  // ---------------------------------------------------------------------------
  // Personal `group.opensocial.invites/self` Provisioning, Notify & Tombstone-Aware Reader
  // ---------------------------------------------------------------------------

  /**
   * Idempotently provisions and verifies `at://<viewerDid>/space/group.opensocial.invites/self` on the
   * viewer's personal PDS (`proposal.md:155`: `{ publicRead: false, publicWrite: true }`, `allowedApps === undefined`,
   * and zero members). Cached per-instance once verified so warm polls pay 0 extra XRPCs.
   */
  async ensureInvitesSpace(): Promise<string> {
    const viewerDid = this.deps.transport.did;
    const invitesSpace = personalInvitesUri(viewerDid);
    if (this.invitesSpaceVerified) {
      return invitesSpace;
    }
    if (this.invitesProvisionInFlight) {
      return this.invitesProvisionInFlight;
    }

    const provision = async (): Promise<string> => {
      const locks = getBrowserLocks();
      const execute = async (): Promise<string> => {
        if (this.invitesSpaceVerified) return invitesSpace;

        let existing: { policy: unknown };
        try {
          existing = await this.deps.transport.memberClient.query<{ policy: unknown }>("com.atproto.space.getSpace", {
            space: invitesSpace,
          });
        } catch (error) {
          const isSpaceNotFound =
            isMissingXrpcResource(error) || (error instanceof XrpcError && error.code === "SpaceNotFound");
          if (!isSpaceNotFound) throw error;
          try {
            await this.deps.transport.memberClient.procedure("com.atproto.space.createSpace", {
              spaceType: OPENSOCIAL_SPACE_TYPE.invites,
              skey: SELF_SKEY,
              policy: memberspacePolicy({ publicWrite: true }),
            });
          } catch (createErr) {
            if (!isSpaceAlreadyExists(createErr)) throw createErr;
          }
          existing = await this.deps.transport.memberClient.query<{ policy: unknown }>("com.atproto.space.getSpace", {
            space: invitesSpace,
          });
        }

        const memberPage = await this.deps.transport.memberClient.query<{ members?: unknown[] }>(
          "com.atproto.memberspace.listMembers",
          {
            space: invitesSpace,
            limit: 1,
          },
        );

        const settings = readMemberspacePolicy(existing.policy);
        if (
          !settings ||
          settings.publicWrite !== true ||
          settings.publicRead !== false ||
          settings.allowedApps !== undefined ||
          (memberPage.members?.length ?? 0) !== 0
        ) {
          throw new IncompatibleInvitesSpacePolicyError(
            "Personal group.opensocial.invites/self space has an incompatible policy or non-empty member list.",
          );
        }

        this.invitesSpaceVerified = true;
        return invitesSpace;
      };

      if (locks) {
        return locks.request(`flock-invites-provision:${viewerDid}`, { mode: "exclusive" }, execute);
      }
      return execute();
    };

    const p = provision().finally(() => {
      if (this.invitesProvisionInFlight === p) {
        this.invitesProvisionInFlight = null;
      }
    });
    this.invitesProvisionInFlight = p;
    return p;
  }

  /**
   * Mints a fresh unnotified credential on `at://<viewerDid>/space/group.opensocial.invites/self`, signs a
   * timestamped RFC 9421 proof of possession, and obtains a stateless Operator webhook target via `getSpaceNotifyTarget`.
   */
  async invitesNotifyTarget(operator: OperatorClient, signal?: AbortSignal): Promise<SpaceNotifyTarget> {
    const space = await this.ensureInvitesSpace();
    let popCred;
    try {
      popCred = await this.deps.credentials.mintFreshUnnotified(space, signal);
    } catch (error) {
      if (error instanceof SpaceCredentialError && error.code === "SpaceNotFound") {
        this.invitesSpaceVerified = false;
        await this.ensureInvitesSpace();
        popCred = await this.deps.credentials.mintFreshUnnotified(space, signal);
      } else {
        throw error;
      }
    }

    const createdSec = Math.max(1, Math.floor(transportNow(this.deps.transport) / 1000));
    const { headers } = await createTimestampedSpaceSigHeaders({
      authorization: `Atproto-Space-Credential ${popCred.token}`,
      audience: operator.serviceRef,
      keypair: popCred.keypair,
      createdSec,
    });

    return operator.getSpaceNotifyTarget(
      {
        space,
        credential: popCred.token,
        proof: {
          authorization: headers.authorization!,
          signatureInput: headers["signature-input"]!,
          signature: headers.signature!,
        },
      },
      signal,
    );
  }

  /** Provisions `invites/self` and registers a live Operator `notify` credential on it. */
  async watchInvites(operator: OperatorClient, signal?: AbortSignal): Promise<string> {
    const space = await this.ensureInvitesSpace();
    const target = await this.invitesNotifyTarget(operator, signal);
    await this.deps.credentials.get(space, { notify: target, ...(signal ? { signal } : {}) });
    return space;
  }

  /**
   * Reads pending cross-PDS `group.opensocial.invite` records in `at://<viewerDid>/space/group.opensocial.invites/self`,
   * enforcing tombstone- & takedown-aware pruning: re-resolves `PLC_URL` first so migrated groups redirect to their live
   * target host while `404`/tombstone/`RepoNotFound`/`RepoTakendown`/`SpaceNotFound` authoritatively prune cached invites!
   */
  async listInvites(): Promise<ReceivedGroupInvite[]> {
    return this.withGroupLifecycleLock("invites:list", async () => {
      const viewerDid = this.deps.transport.did;
      const space = await this.ensureInvitesSpace();
      let credential;
      try {
        credential = await this.deps.credentials.get(space);
      } catch (error) {
        if (error instanceof SpaceCredentialError && error.code === "SpaceNotFound") {
          this.invitesSpaceVerified = false;
          await this.ensureInvitesSpace();
          credential = await this.deps.credentials.get(space);
        } else {
          throw error;
        }
      }

      const [startEpoch, startSpace, preScanWriters] = await Promise.all([
        this.store.epoch(space),
        this.store.getSpace(space),
        this.store.listWriters(space),
      ]);
      const startInvalidationSeq = startSpace?.invalidationSeq ?? 0;
      const startSpaceRevision = startSpace?.revision ?? 0;
      const preScanByRepo = new Map(preScanWriters.map((w) => [w.repo, w]));

      const ownPds = await this.deps.transport.resolvePds(viewerDid);
      const ownSpaceClient = credential.client(ownPds);
      const writerScan = await listBoundedWriters(ownSpaceClient, { space, maxRepos: MAX_INBOX_WRITERS });
      const nowMs = transportNow(this.deps.transport);

      const [afterEpoch, afterSpace] = await Promise.all([
        this.store.epoch(space),
        this.store.getSpace(space),
      ]);
      const scanStillCurrent =
        afterEpoch === startEpoch &&
        (afterSpace?.invalidationSeq ?? 0) === startInvalidationSeq &&
        (afterSpace?.revision ?? 0) === startSpaceRevision;

      const listedWriters = new Set(writerScan.writers.map((w) => w.repo));
      if (scanStillCurrent && !writerScan.truncated) {
        for (const storedWriter of preScanWriters) {
          if (!listedWriters.has(storedWriter.repo)) {
            await this.store.purgeWriter(space, storedWriter.repo, {
              epoch: startEpoch,
              expectedInvalidationSeq: startInvalidationSeq,
              expectedSpaceRevision: startSpaceRevision,
              expectedGeneration: storedWriter.generation,
            });
          }
        }
      }

      const externalWriters = writerScan.writers.filter((w) => w.repo !== viewerDid && isDid(w.repo));
      let anyWriterTruncated = false;
      const perWriter = await mapLimited(externalWriters, 8, async (writerEntry): Promise<ReceivedGroupInvite[]> => {
        const groupDid = writerEntry.repo;
        const preGroupWriter = preScanByRepo.get(groupDid);
        const writerPurgeGuard = {
          epoch: startEpoch,
          expectedInvalidationSeq: startInvalidationSeq,
          expectedSpaceRevision: startSpaceRevision,
          expectedGeneration: preGroupWriter?.generation ?? 0,
        };
        let liveGroupPds: string;
        try {
          liveGroupPds = await this.deps.transport.resolvePds(groupDid, true);
        } catch (error) {
          if (isDidTombstonedError(error)) {
            await this.store.purgeWriter(space, groupDid, writerPurgeGuard);
            return [];
          }
          // Transient PLC error: serve valid non-expired cached invites if present
          const cached = await this.store.records(space, OPENSOCIAL_COLLECTION.invite, groupDid);
          return this.projectInviteRecords(space, viewerDid, groupDid, cached, nowMs);
        }

        const fetchFromHost = async (pdsUrl: string) => {
          const groupSpaceClient = credential.client(pdsUrl);
          return listBoundedRecords(groupSpaceClient, {
            space,
            repo: groupDid,
            collection: OPENSOCIAL_COLLECTION.invite,
            maxRecords: 100,
          });
        };

        let scanned;
        try {
          scanned = await fetchFromHost(liveGroupPds);
        } catch (error) {
          const isPrunableRepoError =
            error instanceof XrpcError &&
            (error.code === "RepoNotFound" ||
              error.code === "RepoTakendown" ||
              error.code === "SpaceNotFound" ||
              error.code === "GroupNotFound");

          if (isPrunableRepoError) {
            // Re-resolve PLC_URL first so a migrated source host redirects to the live target host!
            let refreshedPds: string;
            try {
              refreshedPds = await this.deps.transport.resolvePds(groupDid, true);
            } catch (plcErr) {
              if (isDidTombstonedError(plcErr)) {
                await this.store.purgeWriter(space, groupDid, writerPurgeGuard);
                return [];
              }
              throw plcErr;
            }
            if (refreshedPds !== liveGroupPds) {
              try {
                scanned = await fetchFromHost(refreshedPds);
                liveGroupPds = refreshedPds;
              } catch (targetErr) {
                if (
                  targetErr instanceof XrpcError &&
                  (targetErr.code === "RepoNotFound" ||
                    targetErr.code === "RepoTakendown" ||
                    targetErr.code === "SpaceNotFound" ||
                    targetErr.code === "GroupNotFound")
                ) {
                  await this.store.purgeWriter(space, groupDid, writerPurgeGuard);
                  return [];
                }
                throw targetErr;
              }
            } else {
              await this.store.purgeWriter(space, groupDid, writerPurgeGuard);
              return [];
            }
          } else {
            const failure = classifyRepoFailure(error, { space, repo: groupDid, authorityDid: viewerDid });
            if (!failure) throw error;
            const cached = await this.store.records(space, OPENSOCIAL_COLLECTION.invite, groupDid);
            return this.projectInviteRecords(space, viewerDid, groupDid, cached, nowMs);
          }
        }

        const scannedStoredRecords: StoredRecord[] = scanned.records.map((rec) => ({
          space,
          repo: groupDid,
          collection: OPENSOCIAL_COLLECTION.invite,
          rkey: rec.rkey,
          uri: spaceRecordUri(space, groupDid, OPENSOCIAL_COLLECTION.invite, rec.rkey),
          cid: "",
          value: rec.value,
        }));

        let effectiveRecords = scannedStoredRecords;
        if (scanned.truncated) {
          anyWriterTruncated = true;
          const existingCached = await this.store.records(space, OPENSOCIAL_COLLECTION.invite, groupDid);
          const byRkey = new Map<string, StoredRecord>();
          for (const oldRec of existingCached) byRkey.set(oldRec.rkey, oldRec);
          for (const freshRec of scannedStoredRecords) byRkey.set(freshRec.rkey, freshRec);
          effectiveRecords = [...byRkey.values()];
        }

        await this.store.commit({
          space,
          repo: groupDid,
          expectedGeneration: preGroupWriter?.generation ?? 0,
          epoch: startEpoch,
          expectedInvalidationSeq: startInvalidationSeq,
          rev: writerEntry.repoRev,
          next: {
            syncedRev: writerEntry.repoRev,
            checkedAt: nowMs,
            stale: false,
            coverage: {
              [OPENSOCIAL_COLLECTION.invite]: { strategy: "all", lowest: null, complete: !scanned.truncated, cursor: null },
            },
          },
          replace: { [OPENSOCIAL_COLLECTION.invite]: effectiveRecords },
        });

        const projected = this.projectInviteRecords(space, viewerDid, groupDid, effectiveRecords, nowMs);
        if (projected.length > 0) {
          const publicMeta = await this.tryReadPublicGroupProfile(groupDid).catch(() => null);
          if (publicMeta) {
            for (const inv of projected) {
              inv.groupName = publicMeta.displayName;
              if (publicMeta.description !== undefined) inv.groupDescription = publicMeta.description;
            }
          }
        }
        return projected;
      });

      if (writerScan.truncated || anyWriterTruncated) {
        throw new WorkspaceEnvelopeError(
          "Personal invites space exceeded bounded scan limits; invitation list is incomplete.",
        );
      }

      return perWriter
        .flat()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.uri.localeCompare(b.uri));
    });
  }

  private projectInviteRecords(
    space: string,
    viewerDid: string,
    groupDid: string,
    records: readonly StoredRecord[],
    nowMs: number,
  ): ReceivedGroupInvite[] {
    const out: ReceivedGroupInvite[] = [];
    for (const rec of records) {
      if (!isTid(rec.rkey)) continue;
      const check = validateSpaceRecord(OPENSOCIAL_COLLECTION.invite, rec.value, {
        authorityDid: viewerDid,
        spaceUri: space,
        repoDid: groupDid,
        rkey: rec.rkey,
      });
      if (!check.valid) continue;
      if (rec.value.group !== undefined && rec.value.group !== groupDid) continue;
      const expiresAt = typeof rec.value.expiresAt === "string" ? rec.value.expiresAt : undefined;
      if (expiresAt !== undefined) {
        const expMs = Date.parse(expiresAt);
        if (!Number.isFinite(expMs) || expMs <= nowMs) continue;
      }
      const message = typeof rec.value.message === "string" ? rec.value.message : undefined;
      out.push({
        uri: spaceRecordUri(space, groupDid, OPENSOCIAL_COLLECTION.invite, rec.rkey),
        rkey: rec.rkey,
        groupDid,
        createdAt: String(rec.value.createdAt),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        ...(message !== undefined ? { message } : {}),
      });
    }
    return out;
  }

  async tryReadPublicGroupProfile(groupDid: string): Promise<{
    displayName: string;
    description?: string;
    joinPolicy: string;
  } | null> {
    if (!isDid(groupDid)) return null;
    const metaUri = groupMetaUri(groupDid);
    try {
      const cred = await this.deps.credentials.get(metaUri);
      const client = cred.client(await this.deps.transport.resolvePds(groupDid));
      const res = await client.query<{ value: Record<string, unknown> }>("com.atproto.space.getRecord", {
        space: metaUri,
        repo: groupDid,
        collection: OPENSOCIAL_COLLECTION.profile,
        rkey: SELF_SKEY,
      });
      if (!res.value || typeof res.value.displayName !== "string") return null;
      return {
        displayName: res.value.displayName,
        ...(typeof res.value.description === "string" ? { description: res.value.description } : {}),
        joinPolicy: typeof res.value.joinPolicy === "string" ? res.value.joinPolicy : "invite",
      };
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Crash-Safe Journal Resumption + Discovery (`discover()` vs `discoverCore()`)
  // ---------------------------------------------------------------------------

  /**
   * Resumes persisted lifecycle journals in strict order (`leavingGroups` -> `reactivatingGroups` -> `joiningGroups`),
   * skipping passive user-action states without automatic network retries.
   */
  async resumeJournals(hooks?: ReactivateGroupHooks & { operator?: OperatorClient }): Promise<void> {
    for (const leaveEntry of await this.store.listLeavingGroups()) {
      if (leaveEntry.phase === "blocked_deactivated") continue;
      await this.withGroupLifecycleLock(leaveEntry.groupDid, () =>
        this.executeLeavingGroupPhases(leaveEntry.groupDid, { interactive: false }),
      ).catch(() => undefined);
    }

    for (const reactEntry of await this.store.listReactivatingGroups()) {
      await this.withGroupLifecycleLock(reactEntry.groupDid, () =>
        this.executeReactivatingGroupPhases(reactEntry.operationId, hooks, { interactive: false }),
      ).catch(() => undefined);
    }

    for (const joinEntry of await this.store.listJoiningGroups()) {
      if (PASSIVE_JOIN_PHASES.has(joinEntry.phase)) continue;
      if (joinEntry.mode === "create" && this.activeForegroundCreates.has(joinEntry.operationId)) continue;
      const lockKey = joinEntry.groupDid ?? `create:${joinEntry.operationId}`;
      await this.withGroupLifecycleLock(lockKey, () =>
        this.executeJoiningGroupPhases(joinEntry.operationId, hooks?.operator ?? this.deps.operator, {
          interactive: false,
          heldLockKey: lockKey,
        }),
      ).catch(() => undefined);
    }
  }

  /**
   * Runs `resumeJournals()` (`leavingGroups` -> `reactivatingGroups` -> `joiningGroups`) and then `discoverCore()`.
   */
  async discover(hooks?: ReactivateGroupHooks & { operator?: OperatorClient }): Promise<WorkspaceDiscovery> {
    await this.ensureInvitesSpace().catch((error) => {
      if (error instanceof IncompatibleInvitesSpacePolicyError) throw error;
      // Non-fatal if personal PDS lacks invites scope in isolated legacy unit mocks
    });
    await this.resumeJournals(hooks);
    return this.discoverCore();
  }

  /**
   * Non-resuming workspace discovery (`§3.2 item 6.3`, `§4.2 item 1`):
   * Lists `group.opensocial.members` spaces on own PDS, verifies own-PDS `acceptance/self` BEFORE probing Group Host,
   * summarizes live workspaces, and drops stale cached workspaces.
   */
  async discoverCore(): Promise<WorkspaceDiscovery> {
    const memberSpaces = await listAllSpaceUris(this.deps.transport.memberClient, {
      spaceType: OPENSOCIAL_SPACE_TYPE.members,
      maxSpaces: MAX_DISCOVERABLE_WORKSPACES,
    });

    const activeGroupDids: string[] = [];
    await mapLimited(memberSpaces, 8, async (membersUri) => {
      const parsed = parseGroupMembersUri(membersUri);
      if (!parsed) return;
      const ownAcceptance = await this.readOwnAcceptanceRecord(parsed.groupDid);
      if (ownAcceptance !== null) {
        activeGroupDids.push(parsed.groupDid);
      }
    });

    const results = await mapLimited(activeGroupDids, 8, async (groupDid) => {
      const uri = workspaceUri(groupDid);
      try {
        return { summary: await this.summary(uri, { fresh: true }), candidate: null };
      } catch (error) {
        if (isDidTombstonedError(error)) {
          return { summary: null, candidate: null };
        }
        if (!isAccessLost(error)) throw error;
        const workspace = parseWorkspaceUri(uri);
        return {
          summary: null,
          candidate: !isSpaceDeleted(error) && workspace ? { uri, ...workspace } : null,
        };
      }
    });

    await this.deps.lifecycle.keepWorkspaces(results.flatMap(({ summary }) => (summary ? [summary.uri] : [])));
    const [joiningGroups, leavingGroups, reactivatingGroups] = await Promise.all([
      this.store.listJoiningGroups(),
      this.store.listLeavingGroups(),
      this.store.listReactivatingGroups(),
    ]);

    return {
      workspaces: results
        .flatMap(({ summary }) => (summary ? [summary] : []))
        .sort((left, right) => left.name.localeCompare(right.name)),
      candidates: results
        .flatMap(({ candidate }) => (candidate ? [candidate] : []))
        .sort((left, right) => left.uri.localeCompare(right.uri)),
      joiningGroups,
      leavingGroups,
      reactivatingGroups,
    };
  }

  /**
   * Reads and summarizes one OpenSocial Flock workspace (`meta/self`, `members/self` + member `acceptance/self` +
   * account labels, and `workspace/self`), or returns `null` when its group profile is missing/invalid.
   */
  async summary(uri: string, options: { fresh?: boolean } = {}): Promise<DiscoveredWorkspace | null> {
    const workspace = parseWorkspaceUri(uri);
    if (!workspace || workspace.skey !== SELF_SKEY) return null;
    const groupDid = workspace.authorityDid;
    const metaUri = groupMetaUri(groupDid);
    const membersUri = groupMembersUri(groupDid);

    if (options.fresh) {
      await Promise.all([
        this.deps.credentials.fresh(membersUri),
        this.deps.credentials.fresh(metaUri),
        this.deps.credentials.fresh(uri),
      ]);
    }

    if (this.deps.sync) {
      await Promise.all([
        this.deps.sync.markSpaceStale(metaUri),
        this.deps.sync.markSpaceStale(membersUri),
        this.deps.sync.markSpaceStale(uri),
      ]);
    }

    const [metaClient, membersClient, wsClient] = await Promise.all([
      this.deps.credentials.clientFor(metaUri, groupDid),
      this.deps.credentials.clientFor(membersUri, groupDid),
      this.deps.credentials.clientFor(uri, groupDid),
    ]);

    const bound = WORKSPACE_ENVELOPE.authorityRecordScan;
    const [
      profiles,
      metaPolicyScan,
      roles,
      memberships,
      membersPolicyScan,
      accountLabelScan,
      membersWriterScan,
      directory,
      installs,
      extInstalls,
      wsPolicyScan,
    ] = await Promise.all([
      listBoundedRecords(metaClient, { space: metaUri, repo: groupDid, collection: OPENSOCIAL_COLLECTION.profile, maxRecords: 1 }),
      listBoundedRecords(metaClient, { space: metaUri, repo: groupDid, collection: ATPROTO_SPACE_COLLECTION.spacePolicy, maxRecords: 1 }),
      listBoundedRecords(membersClient, { space: membersUri, repo: groupDid, collection: OPENSOCIAL_COLLECTION.role, maxRecords: bound }),
      listBoundedRecords(membersClient, { space: membersUri, repo: groupDid, collection: OPENSOCIAL_COLLECTION.membership, maxRecords: bound }),
      listBoundedRecords(membersClient, { space: membersUri, repo: groupDid, collection: ATPROTO_SPACE_COLLECTION.spacePolicy, maxRecords: 1 }),
      listBoundedRecords(membersClient, { space: membersUri, repo: groupDid, collection: ATPROTO_SPACE_COLLECTION.label, maxRecords: bound }),
      listBoundedWriters(membersClient, { space: membersUri, maxRepos: MAX_INBOX_WRITERS }),
      listBoundedRecords(wsClient, { space: uri, repo: groupDid, collection: COLLECTION.directory, maxRecords: bound }),
      listBoundedRecords(wsClient, { space: uri, repo: groupDid, collection: COLLECTION.appInstall, maxRecords: bound }),
      listBoundedRecords(wsClient, { space: uri, repo: groupDid, collection: COLLECTION.extInstall, maxRecords: bound }),
      listBoundedRecords(wsClient, { space: uri, repo: groupDid, collection: ATPROTO_SPACE_COLLECTION.spacePolicy, maxRecords: 1 }),
    ]);

    const spacePolicies = new Map<string, GroupOpenSocialPolicy>();
    let invalidPolicyScan = false;
    for (const [spUri, polScan] of [
      [metaUri, metaPolicyScan],
      [membersUri, membersPolicyScan],
      [uri, wsPolicyScan],
    ] as const) {
      const extracted = extractGroupSpacePolicyRecord(groupDid, spUri, polScan);
      if (extracted.valid && extracted.policy) {
        spacePolicies.set(spUri, extracted.policy);
      } else {
        invalidPolicyScan = true;
      }
    }

    const memberWriters = new Map<string, MemberWriterRev>();
    for (const w of membersWriterScan.writers) {
      memberWriters.set(w.repo, { repoRev: w.repoRev, spaceRev: w.spaceRev });
    }

    const knownAppDids = new Set<string>(
      installs.records
        .map((r) => (typeof r.value.subject === "string" ? r.value.subject : ""))
        .filter((s) => s.length > 0),
    );
    const admittedHumanDids = memberships.records
      .map((r) => r.rkey)
      .filter((did) => isDid(did) && did !== groupDid && !knownAppDids.has(did));

    const membersCredential = await this.deps.credentials.get(membersUri);
    const acceptances: MemberAcceptanceEntry[] = [];
    await mapLimited(admittedHumanDids, 8, async (memberDid) => {
      if (!memberWriters.has(memberDid) && memberDid !== this.deps.transport.did) return;
      try {
        const pds = await this.deps.transport.resolvePds(memberDid);
        const res = await membersCredential.client(pds).query<{ value: Record<string, unknown> }>(
          "com.atproto.space.getRecord",
          {
            space: membersUri,
            repo: memberDid,
            collection: OPENSOCIAL_COLLECTION.acceptance,
            rkey: SELF_SKEY,
          },
        );
        if (res.value && typeof res.value === "object" && !Array.isArray(res.value)) {
          acceptances.push({ repoDid: memberDid, rkey: SELF_SKEY, value: res.value });
        }
      } catch (error) {
        if (isMissingXrpcResource(error) || isDidTombstonedError(error)) return;
        const failure = classifyRepoFailure(error, { space: membersUri, repo: memberDid, authorityDid: groupDid });
        if (!failure) throw error;
      }
    });

    const activeAccountLabels = projectActiveLabels(
      accountLabelScan.records.map((r) => ({ repoDid: groupDid, rkey: r.rkey, value: r.value })),
      { groupDid, spaceUri: membersUri, nowMs: transportNow(this.deps.transport) },
    );

    const summary = summarizeWorkspace(uri, this.deps.transport.did, {
      profiles,
      roles,
      memberships,
      directory,
      installs,
      extInstalls,
      acceptances,
      memberWriters,
      spacePolicies,
      accountLabels: activeAccountLabels,
    });

    if (!summary) {
      await this.deps.lifecycle.dropSpace(uri);
      return null;
    }

    const takendownMembers = summary.takendownMembers ?? [];

    const invalidRosterRecords =
      countInvalidAuthorityRecords(OPENSOCIAL_COLLECTION.role, roles.records, groupDid, membersUri) +
      countInvalidAuthorityRecords(OPENSOCIAL_COLLECTION.membership, memberships.records, groupDid, membersUri);
    const invalidExtInstallRecords = countInvalidAuthorityRecords(
      COLLECTION.extInstall,
      extInstalls.records,
      groupDid,
      uri,
    );
    const activeExtensions = (summary.extensions ?? []).filter((ext) => ext.active);
    const totalHumanMembers = summary.members.length + summary.pendingMembers.length + takendownMembers.length;
    const rosterComplete =
      !roles.truncated &&
      !memberships.truncated &&
      !membersWriterScan.truncated &&
      !accountLabelScan.truncated &&
      !invalidPolicyScan &&
      invalidRosterRecords === 0 &&
      totalHumanMembers <= WORKSPACE_ENVELOPE.members;
    const extensionsComplete =
      !extInstalls.truncated &&
      invalidExtInstallRecords === 0 &&
      activeExtensions.length <= WORKSPACE_ENVELOPE.extensions;

    const degradedReasons = [
      ...summary.degradedReasons,
      ...(invalidPolicyScan && !summary.degradedReasons.some((r) => r.includes("Space policy records"))
        ? ["Space policy records contain malformed or missing entries; workspace access governance may be incomplete."]
        : []),
      ...(membersWriterScan.truncated
        ? [
            `Members space writer set exceeds the ${MAX_INBOX_WRITERS}-repo scan limit; member acceptance state may be incomplete.`,
          ]
        : []),
      ...(accountLabelScan.truncated
        ? [
            `Account moderation label records exceed the ${bound}-record scan limit; the member list is withheld.`,
          ]
        : []),
    ];

    await this.deps.lifecycle.keepWorkspaceSpaces(uri, {
      ...(directory.truncated ? {} : { channels: summary.channels.map((channel) => channel.uri) }),
      ...(extInstalls.truncated ? {} : { extensions: activeExtensions.map((ext) => ext.space) }),
    });

    return {
      ...summary,
      ...(accountLabelScan.truncated ? { members: [], pendingMembers: [] } : {}),
      degradedReasons,
      rosterComplete,
      extensionsComplete,
      invalidRosterRecords,
      invalidExtInstallRecords,
      ...(takendownMembers.length > 0 ? { takendownMembers } : {}),
    };
  }

  async requireSummary(uri: string): Promise<DiscoveredWorkspace> {
    const summary = await this.summary(uri);
    if (!summary) throw new Error("Workspace could not be read or contains invalid authority records.");
    return summary;
  }

  // ---------------------------------------------------------------------------
  // Direct Membership Acceptance (`accept`)
  // ---------------------------------------------------------------------------

  /**
   * Writes `group.opensocial.acceptance/self` in `members/self` after proving live `membership/<viewerDid>`
   * on the Group Host (stamping `FLOCK_EXTENSION_FIELD.incarnation` when present).
   */
  async accept(workspace: string): Promise<{ workspace: string; marker: string }> {
    const parsed = parseWorkspaceUri(workspace);
    if (!parsed || parsed.skey !== SELF_SKEY) throw new Error("Invalid workspace URI.");
    const groupDid = parsed.authorityDid;
    const membersUri = groupMembersUri(groupDid);
    const viewerDid = this.deps.transport.did;

    return this.withGroupLifecycleLock(groupDid, async () => {
      const cred = await this.deps.credentials.fresh(membersUri);
      const groupClient = cred.client(await this.deps.transport.resolvePds(groupDid));
      let inc: string | undefined;
      try {
        const mem = await groupClient.query<{ cid?: string; value: Record<string, unknown> }>("com.atproto.space.getRecord", {
          space: membersUri,
          repo: groupDid,
          collection: OPENSOCIAL_COLLECTION.membership,
          rkey: viewerDid,
        });
        if (typeof mem.value[FLOCK_EXTENSION_FIELD.incarnation] === "string") {
          inc = mem.value[FLOCK_EXTENSION_FIELD.incarnation] as string;
        } else if (typeof mem.cid === "string" && mem.cid.length > 0) {
          inc = `legacy-cid:${mem.cid}`;
        }
      } catch (error) {
        if (isMissingXrpcResource(error)) {
          throw new SpaceCredentialError(
            "NotAuthorized",
            403,
            "You haven't been added to this group yet.",
          );
        }
        throw error;
      }

      const marker = await this.writeOwnAcceptance(groupDid, inc);
      return { workspace, marker };
    });
  }

  // ---------------------------------------------------------------------------
  // 5-Phase Migration-Aware `joiningGroups` Machine (`create`, `open`, `invite`, `approval`)
  // ---------------------------------------------------------------------------

  async createWorkspace(
    createParams: JoiningGroupCreateParams,
    options: { operationId?: string; groupDid?: string; operator?: OperatorClient } = {},
  ): Promise<CreatedGroupWorkspace> {
    if (options.groupDid !== undefined && !isDid(options.groupDid)) {
      throw new Error("Invalid group DID.");
    }
    const operator = options.operator ?? this.deps.operator;
    const operationId = options.operationId ?? tidNow(transportNow(this.deps.transport));
    const intentHash = await sha256HexWeb(
      canonicalJson({
        mode: "create",
        name: createParams.name.trim(),
        joinPolicy: createParams.joinPolicy ?? "invite",
        publicMeta: createParams.publicMeta ?? true,
        groupDid: options.groupDid ?? null,
      }),
    );

    const existingPreLock = await this.store.getJoiningGroup(operationId);
    if (existingPreLock) {
      this.assertMatchingCreateEntry(existingPreLock, { intentHash, groupDid: options.groupDid });
    } else if (await this.store.getReactivatingGroup(operationId)) {
      throw new IdempotencyParameterMismatchError(
        `Operation ${operationId} is already bound to a group reactivation.`,
      );
    }

    const knownGroupDid = options.groupDid ?? existingPreLock?.groupDid;
    const lockKey = existingPreLock?.groupDid ?? options.groupDid ?? `create:${operationId}`;
    this.activeForegroundCreates.add(operationId);
    let settled;
    try {
      settled = await this.withGroupLifecycleLock(lockKey, async () => {
        const existing = await this.store.getJoiningGroup(operationId);
        if (existing) {
          this.assertMatchingCreateEntry(existing, { intentHash, groupDid: options.groupDid });
          if (existing.phase === "submitting" && !operator) {
            throw new Error("Operator client is required to submit createWorkspace.");
          }
          if (existing.groupDid && existing.groupDid !== lockKey) {
            const existingGroupDid = existing.groupDid;
            return this.withGroupLifecycleLock(existingGroupDid, () =>
              this.executeJoiningGroupPhases(operationId, operator, {
                interactive: true,
                heldLockKey: existingGroupDid,
              }),
            );
          }
        } else {
          if (!operator) {
            throw new Error("Operator client is required to submit createWorkspace.");
          }
          if (await this.store.getReactivatingGroup(operationId)) {
            throw new IdempotencyParameterMismatchError(
              `Operation ${operationId} is already bound to a group reactivation.`,
            );
          }
          await this.store.putJoiningGroup({
            operationId,
            mode: "create",
            intentHash,
            createParams: {
              name: createParams.name,
              ...(createParams.joinPolicy !== undefined ? { joinPolicy: createParams.joinPolicy } : {}),
              ...(createParams.publicMeta !== undefined ? { publicMeta: createParams.publicMeta } : {}),
            },
            ...(knownGroupDid !== undefined ? { groupDid: knownGroupDid } : {}),
            phase: "submitting",
            createdAt: transportNow(this.deps.transport),
          });
        }
        return this.executeJoiningGroupPhases(operationId, operator, {
          interactive: true,
          heldLockKey: lockKey,
        });
      });
    } finally {
      this.activeForegroundCreates.delete(operationId);
    }

    if (settled.status === "pending") {
      const groupDid = settled.groupDid ?? "";
      return {
        operationId,
        groupDid,
        workspace: settled.workspace ?? (groupDid ? workspaceUri(groupDid) : ""),
        state: "pending",
        ...(settled.completedSteps !== undefined ? { completedSteps: settled.completedSteps } : {}),
        ...(settled.pendingError !== undefined ? { error: settled.pendingError } : {}),
      };
    }

    if (!settled.groupDid) {
      throw new Error("Workspace creation did not resolve a group DID.");
    }
    return {
      operationId,
      groupDid: settled.groupDid,
      workspace: settled.workspace ?? workspaceUri(settled.groupDid),
      state: "completed",
      ...(settled.completedSteps !== undefined ? { completedSteps: settled.completedSteps } : {}),
    };
  }

  async createGroupWorkspace(
    operator: OperatorClient,
    createParams: JoiningGroupCreateParams,
    options: { operationId?: string; groupDid?: string } = {},
  ): Promise<CreatedGroupWorkspace> {
    return this.createWorkspace(createParams, { ...options, operator });
  }

  /**
   * Dismisses an unstarted `mode: "create"` journal entry (`phase === "submitting"` with no `groupDid` bound yet).
   * Never deletes an entry once `groupDid` has been recorded or post-submission phases have begun.
   */
  async dismissUnstartedCreateOperation(
    operationId: string,
  ): Promise<"dismissed" | "not_found" | "in_progress"> {
    const existingPreLock = await this.store.getJoiningGroup(operationId);
    if (!existingPreLock) return "not_found";
    if (existingPreLock.mode !== "create" || existingPreLock.phase !== "submitting" || existingPreLock.groupDid) {
      return "in_progress";
    }
    return this.withGroupLifecycleLock(`create:${operationId}`, async () => {
      const entry = await this.store.getJoiningGroup(operationId);
      if (!entry) return "not_found";
      if (entry.mode !== "create" || entry.phase !== "submitting" || entry.groupDid) {
        return "in_progress";
      }
      await this.store.deleteJoiningGroup(operationId);
      return "dismissed";
    });
  }

  async joinGroup(input: {
    groupDid: string;
    mode?: Exclude<JoiningGroupMode, "create">;
    inviteUri?: string;
    message?: string;
    operationId?: string;
  }): Promise<{ operationId: string; status: "admitted" | "pending"; workspace: string }> {
    if (!isDid(input.groupDid)) throw new Error("Invalid group DID.");
    const mode: Exclude<JoiningGroupMode, "create"> =
      input.mode ?? (input.inviteUri !== undefined ? "invite" : "open");
    const operationId = input.operationId ?? tidNow(transportNow(this.deps.transport));
    const intentHash = await sha256HexWeb(
      canonicalJson({
        group: input.groupDid,
        invite: input.inviteUri ?? null,
        message: input.message ?? null,
      }),
    );

    const existingPreLock = await this.store.getJoiningGroup(operationId);
    if (existingPreLock) {
      this.assertMatchingJoinEntry(existingPreLock, {
        groupDid: input.groupDid,
        mode,
        hasExplicitMode: input.mode !== undefined,
        intentHash,
      });
    } else if (await this.store.getReactivatingGroup(operationId)) {
      throw new IdempotencyParameterMismatchError(
        `Operation ${operationId} is already bound to a group reactivation.`,
      );
    }

    const lockGroupDid = existingPreLock?.groupDid ?? input.groupDid;
    return this.withGroupLifecycleLock(lockGroupDid, async () => {
      const existing = await this.store.getJoiningGroup(operationId);
      if (existing) {
        this.assertMatchingJoinEntry(existing, {
          groupDid: input.groupDid,
          mode,
          hasExplicitMode: input.mode !== undefined,
          intentHash,
        });
      } else {
        if (await this.store.getReactivatingGroup(operationId)) {
          throw new IdempotencyParameterMismatchError(
            `Operation ${operationId} is already bound to a group reactivation.`,
          );
        }
        const authorityEndpoint = await this.deps.transport.resolvePds(input.groupDid);
        await this.store.putJoiningGroup({
          operationId,
          mode,
          intentHash,
          authorityEndpoint,
          groupDid: input.groupDid,
          ...(input.inviteUri !== undefined ? { inviteUri: input.inviteUri } : {}),
          ...(input.message !== undefined ? { message: input.message } : {}),
          phase: "submitting",
          createdAt: transportNow(this.deps.transport),
        });
      }

      const settled = await this.executeJoiningGroupPhases(operationId, this.deps.operator, {
        interactive: true,
        heldLockKey: lockGroupDid,
      });
      const targetGroupDid = settled.groupDid ?? input.groupDid;
      return {
        operationId,
        status: settled.status,
        workspace: workspaceUri(targetGroupDid),
      };
    });
  }

  private assertMatchingCreateEntry(
    existing: JoiningGroupEntry,
    expected: { intentHash: string; groupDid?: string },
  ): void {
    if (
      existing.mode !== "create" ||
      existing.intentHash !== expected.intentHash ||
      (expected.groupDid !== undefined && existing.groupDid !== undefined && existing.groupDid !== expected.groupDid)
    ) {
      throw new IdempotencyParameterMismatchError(
        `Create operation ${existing.operationId} was already recorded with different parameters.`,
      );
    }
  }

  private assertMatchingJoinEntry(
    existing: JoiningGroupEntry,
    expected: {
      groupDid: string;
      mode: Exclude<JoiningGroupMode, "create">;
      hasExplicitMode: boolean;
      intentHash: string;
    },
  ): void {
    const modeMismatch =
      expected.hasExplicitMode &&
      existing.mode !== expected.mode &&
      !(existing.phase !== "submitting" && existing.mode === "approval");
    if (
      existing.mode === "create" ||
      existing.groupDid !== expected.groupDid ||
      existing.intentHash !== expected.intentHash ||
      modeMismatch
    ) {
      throw new IdempotencyParameterMismatchError(
        `Join operation ${existing.operationId} was already recorded with different parameters.`,
      );
    }
  }

  private async executeJoiningGroupPhases(
    operationId: string,
    operator: OperatorClient | undefined,
    opts: { interactive: boolean; heldLockKey: string },
  ): Promise<{
    groupDid?: string;
    workspace?: string;
    status: "admitted" | "pending";
    completedSteps?: string[];
    pendingError?: string;
  }> {
    let entry = await this.store.getJoiningGroup(operationId);
    if (!entry) {
      return { status: "admitted" };
    }
    if (PASSIVE_JOIN_PHASES.has(entry.phase)) {
      return { groupDid: entry.groupDid, status: "pending" };
    }
    if (entry.groupDid && opts.heldLockKey !== entry.groupDid) {
      const boundGroupDid = entry.groupDid;
      return this.withGroupLifecycleLock(boundGroupDid, () =>
        this.executeJoiningGroupPhases(operationId, operator, {
          ...opts,
          heldLockKey: boundGroupDid,
        }),
      );
    }

    let completedSteps: string[] | undefined;
    let createdWorkspaceUri: string | undefined;

    // Phase 1: `submitting`
    if (entry.phase === "submitting") {
      if (entry.mode === "create") {
        if (!operator || !entry.createParams) {
          throw new Error("Operator client is required to submit createWorkspace.");
        }
        let created;
        try {
          created = await operator.createWorkspace({
            name: entry.createParams.name,
            operationId: entry.operationId,
            ...(entry.groupDid ? { authority: entry.groupDid } : {}),
            ...(entry.createParams.joinPolicy ? { joinPolicy: entry.createParams.joinPolicy } : {}),
            ...(entry.createParams.publicMeta !== undefined ? { publicMeta: entry.createParams.publicMeta } : {}),
          });
        } catch (error) {
          if (
            !entry.groupDid &&
            error instanceof OperatorRemoteError &&
            (error.status === 400 || error.code === "WorkspaceExists" || error.code === "OperationIdConflict")
          ) {
            await this.store.deleteJoiningGroup(entry.operationId);
          }
          throw error;
        }

        if (created.state === "failed" || created.state === "aborted_actor_revoked") {
          if (!entry.groupDid && created.completedSteps.length === 0) {
            await this.store.deleteJoiningGroup(entry.operationId);
          }
          throw new OperatorRemoteError(
            400,
            "OperationFailed",
            created.error ?? `Workspace creation ${created.state}.`,
          );
        }

        if (created.state !== "completed") {
          const persistPendingCreate = async () => {
            const latest = await this.store.getJoiningGroup(operationId);
            if (!latest) return;
            entry = {
              ...latest,
              ...(created.groupDid ? { groupDid: created.groupDid } : {}),
              phase: "submitting",
            };
            await this.store.putJoiningGroup(entry);
          };
          if (created.groupDid && opts.heldLockKey !== created.groupDid) {
            await this.withGroupLifecycleLock(created.groupDid, persistPendingCreate);
          } else {
            await persistPendingCreate();
          }
          const pendingGroupDid = created.groupDid || entry.groupDid;
          return {
            ...(pendingGroupDid ? { groupDid: pendingGroupDid } : {}),
            ...(created.workspace ? { workspace: created.workspace } : {}),
            status: "pending",
            completedSteps: created.completedSteps,
            ...(created.error !== undefined ? { pendingError: created.error } : {}),
          };
        }

        completedSteps = created.completedSteps;
        createdWorkspaceUri = created.workspace || undefined;
        if (opts.heldLockKey !== created.groupDid) {
          return this.withGroupLifecycleLock(created.groupDid, async () => {
            const latest = await this.store.getJoiningGroup(operationId);
            if (!latest) {
              throw new XrpcError(
                409,
                "Workspace creation was superseded by a concurrent group leave.",
                "OperationSuperseded",
              );
            }
            const authorityEndpoint = await this.deps.transport.resolvePds(created.groupDid);
            await this.store.putJoiningGroup({
              ...latest,
              groupDid: created.groupDid,
              authorityEndpoint,
              phase: "membership_verified",
            });
            const settled = await this.executeJoiningGroupPhases(operationId, operator, {
              interactive: opts.interactive,
              heldLockKey: created.groupDid,
            });
            return {
              ...settled,
              groupDid: settled.groupDid ?? created.groupDid,
              ...(createdWorkspaceUri ? { workspace: createdWorkspaceUri } : {}),
              ...(completedSteps !== undefined ? { completedSteps } : {}),
            };
          });
        }
        const authorityEndpoint = await this.deps.transport.resolvePds(created.groupDid);
        entry = {
          ...entry,
          groupDid: created.groupDid,
          authorityEndpoint,
          phase: "membership_verified",
        };
        await this.store.putJoiningGroup(entry);
      } else {
        const groupDid = entry.groupDid!;
        const authorityEndpoint = entry.authorityEndpoint ?? (await this.deps.transport.resolvePds(groupDid));
        if (!entry.authorityEndpoint) {
          entry = { ...entry, authorityEndpoint };
          await this.store.putJoiningGroup(entry);
        }

        let joinRes: { status: string; membership?: { uri: string; cid: string } };
        try {
          joinRes = await this.callPersonalGroupProcedure<{ status: string; membership?: { uri: string; cid: string } }>(
            groupDid,
            authorityEndpoint,
            OPENSOCIAL_METHOD.requestJoin,
            {
              group: groupDid,
              ...(entry.inviteUri !== undefined ? { invite: entry.inviteUri } : {}),
              ...(entry.message !== undefined ? { message: entry.message } : {}),
            },
            { "idempotency-key": entry.operationId },
          );
        } catch (error) {
          if (error instanceof XrpcError && error.status === 429 && error.code === "JoinOperationQuotaExceeded") {
            await this.store.putJoiningGroup({ ...entry, phase: "quota_exceeded" });
            throw new JoinOperationQuotaExceededError(error.message);
          }
          if (error instanceof XrpcError && TERMINAL_JOIN_XRPC_CODES.has(error.code)) {
            await this.store.deleteJoiningGroup(entry.operationId);
            throw error;
          }
          throw error;
        }

        if (joinRes.status === "admitted") {
          entry = { ...entry, phase: "membership_verified" };
          await this.store.putJoiningGroup(entry);
        } else if (joinRes.status === "pending") {
          entry = { ...entry, mode: "approval", phase: "pending_approval" };
          await this.store.putJoiningGroup(entry);
          return { groupDid, status: "pending" };
        } else {
          await this.store.putJoiningGroup({
            ...entry,
            rawStatus: joinRes.status,
            phase: "unsupported_status",
          });
          throw new UnsupportedJoinStatusError(joinRes.status);
        }
      }
    }

    // Phase 2: `pending_approval` (NEVER calls `requestJoin` again!)
    if (entry.phase === "pending_approval") {
      const groupDid = entry.groupDid!;
      const currentEndpoint = await this.deps.transport.resolvePds(groupDid, true);
      const joinStatus = await this.queryJoinStatusAt(groupDid, currentEndpoint, entry.operationId);

      if (joinStatus.state === "admitted") {
        entry = {
          ...entry,
          authorityEndpoint: currentEndpoint,
          ...(joinStatus.currentIncarnation !== undefined ? { currentIncarnation: joinStatus.currentIncarnation } : {}),
          phase: "membership_verified",
        };
        await this.store.putJoiningGroup(entry);
      } else if (joinStatus.state === "denied" || joinStatus.state === "cancelled") {
        await this.store.deleteJoiningGroup(entry.operationId);
        return { groupDid, status: "pending" };
      } else if (
        joinStatus.state === "unknown" &&
        entry.authorityEndpoint !== undefined &&
        currentEndpoint !== entry.authorityEndpoint
      ) {
        await this.store.putJoiningGroup({ ...entry, phase: "orphaned_by_migration" });
        return { groupDid, status: "pending" };
      } else if (joinStatus.state === "unknown") {
        await this.store.putJoiningGroup({ ...entry, phase: "expired_unknown" });
        return { groupDid, status: "pending" };
      } else {
        // `state === "pending"`: preserve across restarts and `discover()` cycles!
        void opts;
        return { groupDid, status: "pending" };
      }
    }

    // Phase 3: `membership_verified`
    if (entry.phase === "membership_verified") {
      const groupDid = entry.groupDid!;
      let currentIncarnation: string | undefined;
      try {
        currentIncarnation = await this.verifyLiveGroupMembershipIncarnation(groupDid);
      } catch (error) {
        const membershipGone =
          isMissingXrpcResource(error) ||
          (error instanceof SpaceCredentialError && error.status === 403) ||
          (error instanceof XrpcError &&
            (error.code === "RepoDeactivated" ||
              error.code === "RepoNotFound" ||
              error.code === "GroupNotFound"));
        if (membershipGone) {
          await this.store.deleteJoiningGroup(entry.operationId);
        }
        throw error;
      }
      entry = {
        ...entry,
        ...(currentIncarnation !== undefined ? { currentIncarnation } : {}),
        phase: "acceptance_pending",
      };
      await this.store.putJoiningGroup(entry);
    }

    // Phase 4: `acceptance_pending`
    if (entry.phase === "acceptance_pending") {
      const groupDid = entry.groupDid!;
      await this.writeOwnAcceptance(groupDid, entry.currentIncarnation);
      entry = { ...entry, phase: "discovery_verified" };
      await this.store.putJoiningGroup(entry);
    }

    // Phase 5: `discovery_verified`
    if (entry.phase === "discovery_verified") {
      const groupDid = entry.groupDid!;
      const discovery = await this.discoverCore();
      const inActiveWorkspaces = discovery.workspaces.some((w) => w.groupDid === groupDid);
      if (!inActiveWorkspaces) {
        // Non-Flock pure OpenSocial groups lack `workspace/self`; confirm own-PDS acceptance + membership
        const ownAcc = await this.readOwnAcceptanceRecord(groupDid);
        if (!ownAcc) {
          throw new Error(`Acceptance record for ${groupDid} was not found during discovery verification.`);
        }
      }
      await this.store.deleteJoiningGroup(entry.operationId);
    }

    return {
      groupDid: entry.groupDid,
      ...(createdWorkspaceUri ? { workspace: createdWorkspaceUri } : {}),
      status: "admitted",
      ...(completedSteps !== undefined ? { completedSteps } : {}),
    };
  }

  async getJoinStatus(groupDid: string, operationId?: string): Promise<JoinStatusResponse> {
    if (!isDid(groupDid)) throw new Error("Invalid group DID.");
    const currentEndpoint = await this.deps.transport.resolvePds(groupDid, true);
    return this.queryJoinStatusAt(groupDid, currentEndpoint, operationId);
  }

  async cancelJoinRequest(groupDid: string): Promise<void> {
    if (!isDid(groupDid)) throw new Error("Invalid group DID.");
    await this.withGroupLifecycleLock(groupDid, async () => {
      const endpoint = await this.deps.transport.resolvePds(groupDid, true);
      const existingRows = (await this.store.listJoiningGroups()).filter((row) => row.groupDid === groupDid);
      const pendingApprovalRows = existingRows.filter(
        (row) => row.mode !== "create" && row.phase === "pending_approval",
      );
      const hasPostAdmissionRow = existingRows.some((row) => POST_ADMISSION_JOIN_PHASES.has(row.phase));

      const upgradePendingToMembershipVerified = async (incarnation: string | undefined) => {
        for (const row of pendingApprovalRows) {
          await this.store.putJoiningGroup({
            ...row,
            authorityEndpoint: endpoint,
            ...(incarnation !== undefined ? { currentIncarnation: incarnation } : {}),
            phase: "membership_verified",
          });
        }
      };

      const verifyNotAdmittedViaMembershipRead = async (): Promise<boolean> => {
        try {
          const liveInc = await this.verifyLiveGroupMembershipIncarnation(groupDid);
          await upgradePendingToMembershipVerified(liveInc);
          return false;
        } catch (liveErr) {
          const definitivelyNotAdmitted =
            isMissingXrpcResource(liveErr) ||
            (liveErr instanceof SpaceCredentialError && liveErr.status === 403);
          if (!definitivelyNotAdmitted) {
            throw liveErr;
          }
          return true;
        }
      };

      let confirmedTerminalAbsent = false;
      try {
        await this.callPersonalGroupProcedure(groupDid, endpoint, OPENSOCIAL_METHOD.cancelJoinRequest, {
          group: groupDid,
        });
        confirmedTerminalAbsent = true;
      } catch (error) {
        if (!(error instanceof XrpcError && error.status === 400 && error.code === "JoinRequestNotFound")) {
          throw error;
        }
        if (hasPostAdmissionRow) {
          throw error;
        }
        if (pendingApprovalRows.length === 0) {
          return;
        }

        let joinStatus: JoinStatusResponse | null = null;
        try {
          joinStatus = await this.queryJoinStatusAt(
            groupDid,
            endpoint,
            pendingApprovalRows[0]?.operationId,
          );
        } catch (probeErr) {
          if (!(probeErr instanceof XrpcError && probeErr.status === 404)) {
            throw probeErr;
          }
        }

        if (joinStatus === null || joinStatus.state === "unknown") {
          const notAdmitted = await verifyNotAdmittedViaMembershipRead();
          if (!notAdmitted) {
            throw error;
          }
          confirmedTerminalAbsent = true;
        } else if (joinStatus.state === "admitted") {
          await upgradePendingToMembershipVerified(joinStatus.currentIncarnation);
          throw error;
        } else if (joinStatus.state === "cancelled" || joinStatus.state === "denied") {
          confirmedTerminalAbsent = true;
        } else {
          // `pending` or `left_deactivated`: inconclusive/active — never delete recovery journal!
          throw error;
        }
      }

      if (!confirmedTerminalAbsent) {
        return;
      }

      for (const row of await this.store.listJoiningGroups()) {
        if (row.groupDid === groupDid && row.mode !== "create" && row.phase === "pending_approval") {
          await this.store.deleteJoiningGroup(row.operationId);
        }
      }
    });
  }

  async dismissJoinOperation(operationId: string): Promise<void> {
    const existingPreLock = await this.store.getJoiningGroup(operationId);
    if (!existingPreLock) return;
    const lockKey = existingPreLock.groupDid ?? `create:${operationId}`;
    const dismissLocked = async (heldLockKey: string): Promise<void> => {
      const entry = await this.store.getJoiningGroup(operationId);
      if (!entry) return;
      if (entry.groupDid && entry.groupDid !== heldLockKey) {
        const boundGroupDid = entry.groupDid;
        return this.withGroupLifecycleLock(boundGroupDid, () => dismissLocked(boundGroupDid));
      }
      if (entry.mode === "create" || !entry.groupDid || !PASSIVE_JOIN_PHASES.has(entry.phase)) {
        throw new Error(`Join operation ${operationId} in phase '${entry.phase}' cannot be dismissed.`);
      }
      await this.store.deleteJoiningGroup(operationId);
    };
    await this.withGroupLifecycleLock(lockKey, () => dismissLocked(lockKey));
  }

  async retryJoinOperation(
    operationId: string,
  ): Promise<{ operationId: string; status: "admitted" | "pending"; workspace: string }> {
    const pre = await this.store.getJoiningGroup(operationId);
    if (!pre || !pre.groupDid || !isDid(pre.groupDid) || pre.mode === "create") {
      throw new Error("Join operation cannot be retried.");
    }
    const targetGroupDid = pre.groupDid;
    return this.withGroupLifecycleLock(targetGroupDid, async () => {
      const old = await this.store.getJoiningGroup(operationId);
      if (
        !old ||
        old.groupDid !== targetGroupDid ||
        old.mode === "create" ||
        !PASSIVE_JOIN_PHASES.has(old.phase)
      ) {
        throw new Error("Join operation cannot be retried.");
      }
      let freshOperationId = tidNow(transportNow(this.deps.transport));
      while (
        freshOperationId === operationId ||
        (await this.store.getJoiningGroup(freshOperationId)) !== undefined ||
        (await this.store.getReactivatingGroup(freshOperationId)) !== undefined
      ) {
        freshOperationId = tidNow(transportNow(this.deps.transport));
      }
      const intentHash = await sha256HexWeb(
        canonicalJson({
          group: targetGroupDid,
          invite: old.inviteUri ?? null,
          message: old.message ?? null,
        }),
      );
      const authorityEndpoint = await this.deps.transport.resolvePds(targetGroupDid, true);
      await this.store.putJoiningGroup({
        operationId: freshOperationId,
        mode: old.mode,
        intentHash,
        authorityEndpoint,
        groupDid: targetGroupDid,
        ...(old.inviteUri !== undefined ? { inviteUri: old.inviteUri } : {}),
        ...(old.message !== undefined ? { message: old.message } : {}),
        phase: "submitting",
        createdAt: transportNow(this.deps.transport),
      });
      await this.store.deleteJoiningGroup(operationId);

      const settled = await this.executeJoiningGroupPhases(freshOperationId, this.deps.operator, {
        interactive: true,
        heldLockKey: targetGroupDid,
      });
      return {
        operationId: freshOperationId,
        status: settled.status,
        workspace: workspaceUri(settled.groupDid ?? targetGroupDid),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // 3-Phase Crash-Safe `leavingGroups` Machine (`leaveGroup`)
  // ---------------------------------------------------------------------------

  async leaveGroup(groupDid: string): Promise<void> {
    if (!isDid(groupDid)) throw new Error("Invalid group DID.");
    await this.withGroupLifecycleLock(groupDid, async () => {
      const existing = await this.store.getLeavingGroup(groupDid);
      if (!existing || existing.phase === "blocked_deactivated") {
        if (existing?.phase === "blocked_deactivated" && existing.expectedIncarnation !== undefined) {
          await this.store.putLeavingGroup({
            ...existing,
            phase: "leaving_group",
          });
        } else {
          const resolved = await this.resolveCurrentLeaveIncarnation(groupDid);
          if (resolved.kind === "blocked") {
            await this.store.putLeavingGroup({
              groupDid,
              ...(resolved.expectedIncarnation !== undefined
                ? { expectedIncarnation: resolved.expectedIncarnation }
                : {}),
              phase: "blocked_deactivated",
              createdAt: existing?.createdAt ?? transportNow(this.deps.transport),
            });
            throw resolved.error;
          }
          await this.store.putLeavingGroup({
            groupDid,
            ...(resolved.expectedIncarnation !== undefined
              ? { expectedIncarnation: resolved.expectedIncarnation }
              : {}),
            phase: "leaving_group",
            createdAt: existing?.createdAt ?? transportNow(this.deps.transport),
          });
        }
      }
      await this.executeLeavingGroupPhases(groupDid, { interactive: true });
    });
  }

  private async resolveCurrentLeaveIncarnation(
    groupDid: string,
  ): Promise<
    | { kind: "ready"; expectedIncarnation: string | undefined }
    | { kind: "blocked"; expectedIncarnation: string | undefined; error: XrpcError }
  > {
    const ownAcc = await this.readOwnAcceptanceRecord(groupDid);
    const rawOwnInc = ownAcc?.[FLOCK_EXTENSION_FIELD.incarnation];
    const ownIncarnation = typeof rawOwnInc === "string" && rawOwnInc.length > 0 ? rawOwnInc : undefined;

    let endpoint: string;
    try {
      endpoint = await this.deps.transport.resolvePds(groupDid);
    } catch (error) {
      if (isDidTombstonedError(error)) {
        return { kind: "ready", expectedIncarnation: ownIncarnation };
      }
      throw error;
    }

    const interpretJoinStatusError = async (
      error: unknown,
      attemptedEndpoint: string,
      allowPlcRefresh: boolean,
    ): Promise<
      | { kind: "ready"; expectedIncarnation: string | undefined }
      | { kind: "blocked"; expectedIncarnation: string | undefined; error: XrpcError }
      | { kind: "status"; status: JoinStatusResponse }
    > => {
      if (
        error instanceof XrpcError &&
        (error.code === "RepoNotFound" ||
          error.code === "GroupNotFound" ||
          error.code === "RepoTakendown" ||
          error.code === "RepoDeactivated")
      ) {
        if (allowPlcRefresh) {
          let refreshedEndpoint: string;
          try {
            refreshedEndpoint = await this.deps.transport.resolvePds(groupDid, true);
          } catch (plcErr) {
            if (isDidTombstonedError(plcErr)) {
              return { kind: "ready", expectedIncarnation: ownIncarnation };
            }
            throw plcErr;
          }
          if (refreshedEndpoint !== attemptedEndpoint) {
            try {
              const status = await this.queryJoinStatusAt(groupDid, refreshedEndpoint);
              return { kind: "status", status };
            } catch (retryErr) {
              return interpretJoinStatusError(retryErr, refreshedEndpoint, false);
            }
          }
        }
        if (error.code === "RepoNotFound" || error.code === "GroupNotFound") {
          return { kind: "ready", expectedIncarnation: ownIncarnation };
        }
        return { kind: "blocked", expectedIncarnation: ownIncarnation, error };
      }
      throw error;
    };

    let status: JoinStatusResponse;
    try {
      status = await this.queryJoinStatusAt(groupDid, endpoint);
    } catch (error) {
      const outcome = await interpretJoinStatusError(error, endpoint, true);
      if (outcome.kind !== "status") {
        return outcome;
      }
      status = outcome.status;
    }

    if (status.state === "admitted") {
      if (typeof status.currentIncarnation === "string" && status.currentIncarnation.length > 0) {
        return { kind: "ready", expectedIncarnation: status.currentIncarnation };
      }
      return { kind: "ready", expectedIncarnation: ownIncarnation };
    }
    return { kind: "ready", expectedIncarnation: ownIncarnation };
  }

  private async executeLeavingGroupPhases(
    groupDid: string,
    opts: { interactive: boolean },
  ): Promise<void> {
    let entry = await this.store.getLeavingGroup(groupDid);
    if (!entry || entry.phase === "blocked_deactivated") return;

    // Phase 1: `leaving_group` (executed BEFORE touching own-PDS `acceptance/self`!)
    if (entry.phase === "leaving_group") {
      let pds: string | null = null;
      try {
        pds = await this.deps.transport.resolvePds(groupDid);
      } catch (error) {
        if (isDidTombstonedError(error)) {
          entry = { ...entry, phase: "deleting_acceptance" };
          await this.store.putLeavingGroup(entry);
        } else {
          throw error;
        }
      }

      if (entry.phase === "leaving_group" && pds !== null) {
        const attemptLeaveAt = (endpoint: string) =>
          this.callPersonalGroupProcedure<Record<string, unknown>>(
            groupDid,
            endpoint,
            OPENSOCIAL_METHOD.leaveGroup,
            { group: groupDid },
            entry!.expectedIncarnation !== undefined
              ? { "if-match-membership-incarnation": entry!.expectedIncarnation }
              : undefined,
          );

        const handleLeaveError = async (
          error: unknown,
          attemptedPds: string,
          allowPlcRefresh: boolean,
        ): Promise<"parked_or_cleared" | "advanced"> => {
          if (error instanceof XrpcError && error.code === "LastAdmin") {
            await this.store.deleteLeavingGroup(groupDid);
            throw error;
          }
          if (error instanceof XrpcError && error.code === "MembershipIncarnationMismatch") {
            await this.store.deleteLeavingGroup(groupDid);
            if (opts.interactive) throw error;
            return "parked_or_cleared";
          }
          if (error instanceof XrpcError && error.code === "RepoDeactivated") {
            await this.store.putLeavingGroup({ ...entry!, phase: "blocked_deactivated" });
            if (opts.interactive) throw error;
            return "parked_or_cleared";
          }
          if (error instanceof XrpcError && error.code === "RepoTakendown") {
            if (allowPlcRefresh) {
              let refreshedPds: string;
              try {
                refreshedPds = await this.deps.transport.resolvePds(groupDid, true);
              } catch (plcErr) {
                if (isDidTombstonedError(plcErr)) {
                  entry = { ...entry!, phase: "deleting_acceptance" };
                  await this.store.putLeavingGroup(entry);
                  return "advanced";
                }
                throw plcErr;
              }
              if (refreshedPds !== attemptedPds) {
                try {
                  await attemptLeaveAt(refreshedPds);
                  entry = { ...entry!, phase: "deleting_acceptance" };
                  await this.store.putLeavingGroup(entry);
                  return "advanced";
                } catch (targetErr) {
                  return handleLeaveError(targetErr, refreshedPds, false);
                }
              }
            }
            await this.store.putLeavingGroup({ ...entry!, phase: "blocked_deactivated" });
            if (opts.interactive) throw error;
            return "parked_or_cleared";
          }
          if (
            error instanceof XrpcError &&
            (error.code === "RepoNotFound" || error.code === "GroupNotFound")
          ) {
            if (allowPlcRefresh) {
              let refreshedPds: string;
              try {
                refreshedPds = await this.deps.transport.resolvePds(groupDid, true);
              } catch (plcErr) {
                if (isDidTombstonedError(plcErr)) {
                  entry = { ...entry!, phase: "deleting_acceptance" };
                  await this.store.putLeavingGroup(entry);
                  return "advanced";
                }
                throw plcErr;
              }
              if (refreshedPds !== attemptedPds) {
                try {
                  await attemptLeaveAt(refreshedPds);
                } catch (targetErr) {
                  return handleLeaveError(targetErr, refreshedPds, false);
                }
              }
            }
            entry = { ...entry!, phase: "deleting_acceptance" };
            await this.store.putLeavingGroup(entry);
            return "advanced";
          }
          throw error;
        };

        try {
          await attemptLeaveAt(pds);
          entry = { ...entry, phase: "deleting_acceptance" };
          await this.store.putLeavingGroup(entry);
        } catch (error) {
          const resolution = await handleLeaveError(error, pds, true);
          if (resolution === "parked_or_cleared") return;
        }
      }
    }

    // Phase 2: `deleting_acceptance` (NEVER clears journal directly; ALWAYS advances to `reconciling_post_delete`!)
    if (entry.phase === "deleting_acceptance") {
      const [liveJoinStatus, ownAcc] = await Promise.all([
        this.safeQueryLiveJoinStatus(groupDid),
        this.readOwnAcceptanceRecord(groupDid),
      ]);

      const readmittedWithNewIncarnation =
        liveJoinStatus?.state === "admitted" &&
        liveJoinStatus.currentIncarnation !== undefined &&
        liveJoinStatus.currentIncarnation !== entry.expectedIncarnation;
      const ownAcceptanceMissing = ownAcc === null;
      const ownAcceptanceNewerIncarnation =
        ownAcc !== null &&
        typeof ownAcc[FLOCK_EXTENSION_FIELD.incarnation] === "string" &&
        ownAcc[FLOCK_EXTENSION_FIELD.incarnation] !== entry.expectedIncarnation;

      if (!readmittedWithNewIncarnation && !ownAcceptanceMissing && !ownAcceptanceNewerIncarnation) {
        try {
          await this.deps.transport.memberClient.procedure("com.atproto.space.deleteRecord", {
            space: groupMembersUri(groupDid),
            repo: this.deps.transport.did,
            collection: OPENSOCIAL_COLLECTION.acceptance,
            rkey: SELF_SKEY,
          });
        } catch (error) {
          if (!isMissingXrpcResource(error)) throw error;
        }
      }

      entry = { ...entry, phase: "reconciling_post_delete" };
      await this.store.putLeavingGroup(entry);
    }

    // Phase 3: `reconciling_post_delete`
    if (entry.phase === "reconciling_post_delete") {
      const liveJoinStatus = await this.safeQueryLiveJoinStatus(groupDid);
      if (
        liveJoinStatus?.state === "admitted" &&
        liveJoinStatus.currentIncarnation !== undefined &&
        liveJoinStatus.currentIncarnation !== entry.expectedIncarnation
      ) {
        const ownAcc = await this.readOwnAcceptanceRecord(groupDid);
        if (!ownAcc || ownAcc[FLOCK_EXTENSION_FIELD.incarnation] !== liveJoinStatus.currentIncarnation) {
          await this.writeOwnAcceptance(groupDid, liveJoinStatus.currentIncarnation);
        }
        await this.store.deleteLeavingGroup(groupDid);
        return;
      }

      const wsUri = workspaceUri(groupDid);
      this.deps.credentials.drop(wsUri, { clearNotify: true });
      this.deps.credentials.drop(groupMetaUri(groupDid), { clearNotify: true });
      this.deps.credentials.drop(groupMembersUri(groupDid), { clearNotify: true });
      await this.deps.lifecycle.dropSpace(wsUri);
      for (const joinRow of await this.store.listJoiningGroups()) {
        if (joinRow.groupDid === groupDid && !PASSIVE_JOIN_PHASES.has(joinRow.phase)) {
          await this.store.deleteJoiningGroup(joinRow.operationId);
        }
      }
      await this.store.deleteLeavingGroup(groupDid);
    }
  }

  private async safeQueryLiveJoinStatus(groupDid: string): Promise<JoinStatusResponse | null> {
    let endpoint: string;
    try {
      endpoint = await this.deps.transport.resolvePds(groupDid, true);
    } catch (error) {
      if (isDidTombstonedError(error)) return null;
      throw error;
    }
    try {
      return await this.queryJoinStatusAt(groupDid, endpoint);
    } catch (error) {
      if (
        error instanceof XrpcError &&
        (error.code === "RepoNotFound" ||
          error.code === "GroupNotFound" ||
          error.code === "RepoTakendown" ||
          error.code === "RepoDeactivated")
      ) {
        return null;
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // 4-Phase Non-Recursing `reactivatingGroups` Machine (`reactivateGroup`)
  // ---------------------------------------------------------------------------

  async reactivateGroup(
    groupDid: string,
    hooks?: ReactivateGroupHooks & { operationId?: string },
  ): Promise<{ operationId: string; workspace: string }> {
    if (!isDid(groupDid)) throw new Error("Invalid group DID.");
    const operationId = hooks?.operationId ?? tidNow(transportNow(this.deps.transport));
    const intentHash = await sha256HexWeb(canonicalJson({ mode: "reactivate", groupDid }));

    const existingPreLock = await this.store.getReactivatingGroup(operationId);
    if (existingPreLock) {
      if (
        existingPreLock.groupDid !== groupDid ||
        (existingPreLock.intentHash !== undefined && existingPreLock.intentHash !== intentHash)
      ) {
        throw new IdempotencyParameterMismatchError(
          `Reactivation operation ${operationId} was already recorded for ${existingPreLock.groupDid}.`,
        );
      }
    } else if (await this.store.getJoiningGroup(operationId)) {
      throw new IdempotencyParameterMismatchError(
        `Operation ${operationId} is already bound to a join or create operation.`,
      );
    }

    const lockGroupDid = existingPreLock?.groupDid ?? groupDid;
    return this.withGroupLifecycleLock(lockGroupDid, async () => {
      const existing = await this.store.getReactivatingGroup(operationId);
      if (existing) {
        if (
          existing.groupDid !== groupDid ||
          (existing.intentHash !== undefined && existing.intentHash !== intentHash)
        ) {
          throw new IdempotencyParameterMismatchError(
            `Reactivation operation ${operationId} was already recorded for ${existing.groupDid}.`,
          );
        }
      } else {
        if (await this.store.getJoiningGroup(operationId)) {
          throw new IdempotencyParameterMismatchError(
            `Operation ${operationId} is already bound to a join or create operation.`,
          );
        }
        await this.store.putReactivatingGroup({
          operationId,
          groupDid,
          intentHash,
          phase: "activating",
          createdAt: transportNow(this.deps.transport),
        });
      }
      await this.executeReactivatingGroupPhases(operationId, hooks, { interactive: true });
      return { operationId, workspace: workspaceUri(groupDid) };
    });
  }

  private async executeReactivatingGroupPhases(
    operationId: string,
    hooks: ReactivateGroupHooks | undefined,
    opts: { interactive: boolean },
  ): Promise<void> {
    let entry = await this.store.getReactivatingGroup(operationId);
    if (!entry) return;
    const { groupDid } = entry;

    // Phase 1: `activating`
    if (entry.phase === "activating") {
      const getGroupClient = hooks?.getGroupClient ?? this.deps.getGroupClient;
      if (!getGroupClient) {
        if (opts.interactive) {
          throw new Error("A recovery/group OAuth client is required to reactivate a deactivated group.");
        }
        return;
      }
      const groupClient = await getGroupClient(groupDid);
      const status = await groupClient.checkAccountStatus();
      if (!status.activated) {
        await groupClient.activateAccount();
      }
      // Clear any blocked_deactivated leave journal on reactivation
      const blockedLeave = await this.store.getLeavingGroup(groupDid);
      if (blockedLeave?.phase === "blocked_deactivated") {
        await this.store.deleteLeavingGroup(groupDid);
      }
      entry = { ...entry, phase: "restoring_acceptance" };
      await this.store.putReactivatingGroup(entry);
    }

    // Phase 2: `restoring_acceptance`
    if (entry.phase === "restoring_acceptance") {
      const restoredIncarnation = await this.verifyLiveGroupMembershipIncarnation(groupDid);
      await this.writeOwnAcceptance(groupDid, restoredIncarnation);
      entry = {
        ...entry,
        ...(restoredIncarnation !== undefined ? { restoredIncarnation } : {}),
        phase: "reauthorizing_operator",
      };
      await this.store.putReactivatingGroup(entry);
    }

    // Phase 3: `reauthorizing_operator`
    if (entry.phase === "reauthorizing_operator") {
      const operator = hooks?.operator ?? this.deps.operator;
      const reauth = hooks?.reauthorizeOperator ?? this.deps.reauthorizeOperator;
      if (operator) {
        const tryRefresh = async (): Promise<"refreshed" | "needs_reauth" | "parked"> => {
          try {
            return await this.refreshOperatorRegistrationsOnReactivate(operator, groupDid);
          } catch (error) {
            if (!opts.interactive) return "parked";
            throw error;
          }
        };

        const initialOutcome = await tryRefresh();
        if (initialOutcome === "parked") return;
        if (initialOutcome === "refreshed") {
          entry = { ...entry, phase: "refreshing_discovery" };
          await this.store.putReactivatingGroup(entry);
        } else {
          if (reauth) {
            const reauthOutcome = await reauth(groupDid);
            if (reauthOutcome !== false) {
              const postReauthOutcome = await tryRefresh();
              if (postReauthOutcome === "parked") return;
              if (postReauthOutcome === "refreshed") {
                entry = { ...entry, phase: "refreshing_discovery" };
                await this.store.putReactivatingGroup(entry);
              }
            }
          }
          if (entry.phase === "reauthorizing_operator") {
            if (opts.interactive) {
              throw new OperatorRemoteError(
                403,
                "AuthorizationRequired",
                "Operator authority reauthorization is required to complete group reactivation.",
              );
            }
            return;
          }
        }
      } else {
        const reauthApproved = reauth !== undefined && (await reauth(groupDid)) === true;
        if (!reauthApproved) {
          if (opts.interactive) {
            throw new OperatorRemoteError(
              403,
              "AuthorizationRequired",
              "Operator authority reauthorization is required to complete group reactivation.",
            );
          }
          return;
        }
        entry = { ...entry, phase: "refreshing_discovery" };
        await this.store.putReactivatingGroup(entry);
      }
    }

    // Phase 4: `refreshing_discovery` (calls non-resuming `discoverCore()` directly!)
    if (entry.phase === "refreshing_discovery") {
      const discovery = await this.discoverCore();
      const isLive = discovery.workspaces.some((w) => w.groupDid === groupDid);
      if (!isLive) {
        const ownAcc = await this.readOwnAcceptanceRecord(groupDid);
        if (!ownAcc) {
          throw new Error(`Reactivated group ${groupDid} was not found during discovery refresh.`);
        }
      }
      await this.store.deleteReactivatingGroup(operationId);
    }
  }

  private async refreshOperatorRegistrationsOnReactivate(
    operator: OperatorClient,
    groupDid: string,
  ): Promise<"refreshed" | "needs_reauth"> {
    let stalled;
    try {
      stalled = await operator.listStalledOperations(workspaceUri(groupDid), {
        refreshRegistrations: true,
      });
    } catch (error) {
      if (
        error instanceof OperatorRemoteError &&
        (error.code === "AuthoritySessionUnavailable" ||
          error.code === "AuthorizationRequired" ||
          error.code === "AuthorityAccessRejected" ||
          error.code === "AuthorityGrantRequired")
      ) {
        return "needs_reauth";
      }
      throw error;
    }
    const failedRegs = stalled.registrations ?? [];
    if (failedRegs.length > 0) {
      throw new OperatorRemoteError(
        502,
        "RegistrationRefreshFailed",
        `Operator failed to refresh change-notice registrations for ${failedRegs.length} group space(s).`,
      );
    }
    return "refreshed";
  }

  // ---------------------------------------------------------------------------
  // Personal Moderation Reports, Group Join Request Decisions & Private-Channel Inbox
  // ---------------------------------------------------------------------------

  async createReport(input: {
    groupDid: string;
    subject: string;
    cid?: string;
    reasonType: string;
    rule?: string;
    reason?: string;
  }): Promise<Record<string, unknown>> {
    if (!isDid(input.groupDid)) throw new Error("Invalid group DID.");
    const endpoint = await this.deps.transport.resolvePds(input.groupDid);
    return this.callPersonalGroupProcedure(input.groupDid, endpoint, OPENSOCIAL_METHOD.createReport, {
      group: input.groupDid,
      subject: input.subject,
      ...(input.cid !== undefined ? { cid: input.cid } : {}),
      reasonType: input.reasonType,
      ...(input.rule !== undefined ? { rule: input.rule } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
  }

  async decideGroupJoinRequest(
    workspace: string,
    operator: OperatorClient,
    input: { member: string; decision: "approve" | "deny"; roles?: string[]; operationId?: string },
  ) {
    const operationId = input.operationId ?? tidNow(transportNow(this.deps.transport));
    return operator.execute({
      workspace,
      operationId,
      request: {
        kind: "decideGroupJoinRequest",
        member: input.member,
        decision: input.decision,
        ...(input.roles !== undefined ? { roles: input.roles } : {}),
      },
    });
  }

  /**
   * Open private-channel join requests in `inbox/self` for an active admin.
   * Reads `listBoundedWriters(inbox/self)` directly on Group Host and withholds `!takedown`-labeled requests/authors.
   */
  async inboxRequests(
    workspace: string,
    operator?: OperatorClient,
  ): Promise<{ requests: InboxJoinRequest[]; skipped: SkippedInboxWriter[] }> {
    void operator;
    const summary = await this.requireSummary(workspace);
    if (!summary.isAdmin) throw new Error("Active workspace admin permission is required.");
    if (summary.degradedReasons.length > 0) {
      throw new WorkspaceEnvelopeError(workspaceDegradedMessage(summary.degradedReasons));
    }
    const inbox = inboxUri(summary.authorityDid, summary.skey);
    const authority = await this.deps.credentials.clientFor(inbox, summary.authorityDid);
    const [repoScan, labelScan] = await Promise.all([
      listBoundedWriters(authority, { space: inbox, maxRepos: MAX_INBOX_WRITERS }),
      listBoundedRecords(authority, {
        space: inbox,
        repo: summary.authorityDid,
        collection: ATPROTO_SPACE_COLLECTION.label,
        maxRecords: WORKSPACE_ENVELOPE.authorityRecordScan,
      }),
    ]);
    if (repoScan.truncated) {
      throw new WorkspaceEnvelopeError(
        `Inbox writer set exceeds the ${MAX_INBOX_WRITERS}-repo scan limit; inbox results are incomplete.`,
      );
    }
    if (labelScan.truncated) {
      throw new WorkspaceEnvelopeError(
        `Inbox moderation label scan exceeds the ${WORKSPACE_ENVELOPE.authorityRecordScan}-record limit; refusing fail-open read.`,
      );
    }
    const activeInboxLabels = projectActiveLabels(
      labelScan.records.map((r) => ({ repoDid: summary.authorityDid, rkey: r.rkey, value: r.value })),
      { groupDid: summary.authorityDid, spaceUri: inbox, nowMs: transportNow(this.deps.transport) },
    );
    const takendownAuthors = new Set(summary.takendownMembers ?? []);

    const writers = repoScan.writers
      .map((writer) => writer.repo)
      .filter((did) => did !== summary.authorityDid && !takendownAuthors.has(did));

    const perWriter = await mapLimited(writers, 8, (repoDid) =>
      readWriterJoinRequests({
        clientFor: () => this.deps.credentials.clientFor(inbox, repoDid),
        inbox,
        repoDid,
        authorityDid: summary.authorityDid,
        channels: summary.channels,
      }),
    );

    const unfiltered = perWriter
      .flatMap((result) => result.requests)
      .filter((req) => !isTakendown(activeInboxLabels, req.uri));

    const current = await mapLimited(unfiltered, 8, async (request) => {
      const rkey = decisionRecordKey(request.uri);
      try {
        const decision = await authority.query<{ value: Record<string, unknown> }>("com.atproto.space.getRecord", {
          space: inbox,
          repo: summary.authorityDid,
          collection: COLLECTION.joinDecision,
          rkey,
        });
        const valid = validateSpaceRecord(COLLECTION.joinDecision, decision.value, {
          authorityDid: summary.authorityDid,
          spaceUri: inbox,
          repoDid: summary.authorityDid,
          rkey,
        }).valid;
        return valid && decision.value.request === request.uri && decision.value.requestId === request.requestId
          ? null
          : request;
      } catch (error) {
        if (isMissingXrpcResource(error)) return request;
        throw error;
      }
    });

    return {
      requests: current
        .flatMap((request) => (request ? [request] : []))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
      skipped: perWriter.flatMap((result) => (result.skipped ? [result.skipped] : [])),
    };
  }

  // ---------------------------------------------------------------------------
  // Internal Personal-Session & Acceptance Helpers
  // ---------------------------------------------------------------------------

  private async readOwnAcceptanceRecord(groupDid: string): Promise<Record<string, unknown> | null> {
    try {
      const res = await this.deps.transport.memberClient.query<{ value: Record<string, unknown> }>(
        "com.atproto.space.getRecord",
        {
          space: groupMembersUri(groupDid),
          repo: this.deps.transport.did,
          collection: OPENSOCIAL_COLLECTION.acceptance,
          rkey: SELF_SKEY,
        },
      );
      return res.value ?? null;
    } catch (error) {
      if (isMissingXrpcResource(error) || (error instanceof XrpcError && error.code === "SpaceNotFound")) {
        return null;
      }
      throw error;
    }
  }

  private async writeOwnAcceptance(groupDid: string, incarnation?: string): Promise<string> {
    const membersUri = groupMembersUri(groupDid);
    const viewerDid = this.deps.transport.did;
    const record: Record<string, unknown> = {
      $type: OPENSOCIAL_COLLECTION.acceptance,
      createdAt: new Date(transportNow(this.deps.transport)).toISOString(),
      ...(incarnation !== undefined ? { [FLOCK_EXTENSION_FIELD.incarnation]: incarnation } : {}),
    };
    const validation = validateSpaceRecord(OPENSOCIAL_COLLECTION.acceptance, record, {
      authorityDid: groupDid,
      spaceUri: membersUri,
      repoDid: viewerDid,
      rkey: SELF_SKEY,
    });
    if (!validation.valid) throw new Error(validation.reason);

    const result = await this.deps.transport.memberClient.procedure<unknown, { uri: string }>(
      "com.atproto.space.putRecord",
      {
        space: membersUri,
        repo: viewerDid,
        collection: OPENSOCIAL_COLLECTION.acceptance,
        rkey: SELF_SKEY,
        record,
      },
    );
    return result.uri;
  }

  private async verifyLiveGroupMembershipIncarnation(groupDid: string): Promise<string | undefined> {
    const membersUri = groupMembersUri(groupDid);
    const viewerDid = this.deps.transport.did;
    const pds = await this.deps.transport.resolvePds(groupDid, true);
    const cred = await this.deps.credentials.fresh(membersUri);
    const res = await cred.client(pds).query<{ cid?: string; value: Record<string, unknown> }>("com.atproto.space.getRecord", {
      space: membersUri,
      repo: groupDid,
      collection: OPENSOCIAL_COLLECTION.membership,
      rkey: viewerDid,
    });
    if (typeof res.value[FLOCK_EXTENSION_FIELD.incarnation] === "string") {
      return res.value[FLOCK_EXTENSION_FIELD.incarnation] as string;
    }
    const status = await this.queryJoinStatusAt(groupDid, pds).catch(() => null);
    if (typeof status?.currentIncarnation === "string" && status.currentIncarnation.length > 0) {
      return status.currentIncarnation;
    }
    if (typeof res.cid === "string" && res.cid.length > 0) {
      return `legacy-cid:${res.cid}`;
    }
    return undefined;
  }

  private async callPersonalGroupProcedure<T>(
    groupDid: string,
    endpoint: string,
    methodNsid: string,
    input: Record<string, unknown>,
    extraHeaders?: Readonly<Record<string, string>>,
  ): Promise<T> {
    const { token } = await this.deps.transport.memberClient.query<{ token: string }>(
      "com.atproto.server.getServiceAuth",
      {
        aud: `${groupDid}#atproto_pds`,
        lxm: methodNsid,
      },
    );
    const url = new URL(`/xrpc/${methodNsid}`, endpoint);
    const response = await this.deps.transport.fetchEndpoint(
      new Request(url, {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          ...(extraHeaders ?? {}),
        },
        body: JSON.stringify(input),
      }),
    );
    const body = await readUpstreamJson<T & { error?: string; message?: string }>(
      response,
      MAX_GROUP_MEMBER_JSON_BYTES,
    );
    if (!response.ok) {
      throw new XrpcError(
        response.status,
        body?.message ?? `Group request ${methodNsid} failed (${response.status}).`,
        body?.error ?? "XrpcError",
      );
    }
    return (body ?? ({} as T)) as T;
  }

  private async queryJoinStatusAt(
    groupDid: string,
    endpoint: string,
    operationId?: string,
  ): Promise<JoinStatusResponse> {
    const { token } = await this.deps.transport.memberClient.query<{ token: string }>(
      "com.atproto.server.getServiceAuth",
      {
        aud: `${groupDid}#atproto_pds`,
        lxm: OPENSOCIAL_METHOD.requestJoin,
      },
    );
    const url = new URL("/group-member/join-status", endpoint);
    url.searchParams.set("group", groupDid);
    if (operationId !== undefined) {
      url.searchParams.set("operationId", operationId);
    }
    const response = await this.deps.transport.fetchEndpoint(
      new Request(url, {
        method: "GET",
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
        },
      }),
    );
    const body = await readUpstreamJson<Record<string, unknown>>(
      response,
      MAX_GROUP_MEMBER_JSON_BYTES,
    );
    if (!response.ok) {
      const errMsg = typeof body?.message === "string" ? body.message : `Join status check failed (${response.status}).`;
      const errCode = typeof body?.error === "string" ? body.error : "XrpcError";
      throw new XrpcError(response.status, errMsg, errCode);
    }
    return parseJoinStatusResponse(body);
  }
}

function parseJoinStatusResponse(raw: unknown): JoinStatusResponse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new XrpcError(502, "Malformed /group-member/join-status response.", "InvalidJoinStatusResponse");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.state !== "string" || !VALID_JOIN_STATUS_STATES.has(obj.state as JoinStatusResponse["state"])) {
    throw new XrpcError(502, "Malformed /group-member/join-status response.", "InvalidJoinStatusResponse");
  }
  if (
    obj.currentIncarnation !== undefined &&
    obj.currentIncarnation !== null &&
    (typeof obj.currentIncarnation !== "string" || obj.currentIncarnation.length === 0)
  ) {
    throw new XrpcError(502, "Malformed /group-member/join-status response.", "InvalidJoinStatusResponse");
  }
  let membership: { uri: string; cid: string } | undefined;
  if (obj.membership !== undefined && obj.membership !== null) {
    if (typeof obj.membership !== "object" || Array.isArray(obj.membership)) {
      throw new XrpcError(502, "Malformed /group-member/join-status response.", "InvalidJoinStatusResponse");
    }
    const memObj = obj.membership as Record<string, unknown>;
    if (typeof memObj.uri !== "string" || typeof memObj.cid !== "string") {
      throw new XrpcError(502, "Malformed /group-member/join-status response.", "InvalidJoinStatusResponse");
    }
    membership = { uri: memObj.uri, cid: memObj.cid };
  }
  return {
    state: obj.state as JoinStatusResponse["state"],
    ...(typeof obj.currentIncarnation === "string" ? { currentIncarnation: obj.currentIncarnation } : {}),
    ...(membership !== undefined ? { membership } : {}),
  };
}

function countInvalidAuthorityRecords(
  collection: string,
  records: ReadonlyArray<{ rkey: string; value: Record<string, unknown> }>,
  authorityDid: string,
  spaceUri: string,
): number {
  return records.filter(
    (record) =>
      !validateSpaceRecord(collection, record.value, {
        authorityDid,
        spaceUri,
        repoDid: authorityDid,
        rkey: record.rkey,
      }).valid,
  ).length;
}
