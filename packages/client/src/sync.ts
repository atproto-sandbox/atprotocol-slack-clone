import { KemKeyError } from "@flock/protocol/atproto/kem-key";
import { assertBoundedRecordPage, listBoundedRecords, listBoundedRepos, listReposSince } from "@flock/protocol/atproto/record-pages";
import { classifyRepoFailure, classifyVerifiedRepoFailure } from "@flock/protocol/atproto/repo-failure";
import {
  LTHASH_STATE_BYTES,
  RepoCommit,
  RepoStarLimitError,
  RepoVerificationError,
  SpaceCredentialError,
  SpaceMacError,
  StarParseError,
  isCredentialRefused,
  listVerifiedBoundedRecords,
  parseCidSafe,
  serializedRecordBytes,
  verifyRecordCid,
  verifyRecordCidWithSize,
  type Cid,
  type Commit,
  type SpaceCredential,
} from "@flock/protocol/atproto/space-credential-core";
import { XrpcError, type AtprotoClient } from "@flock/protocol/atproto/xrpc";
import { mapLimited } from "@flock/protocol/map-limited";
import { isDid, parseSpaceUri, parseWorkspaceUri, spaceRecordUri } from "@flock/protocol/keys";
import { COLLECTION } from "@flock/protocol/nsids";
import { validateSpaceRecord } from "@flock/protocol/registry";
import {
  WORKSPACE_ENVELOPE,
  summarizeWorkspace,
  type ScannedRecords,
  type WorkspaceExtensionSummary,
  type WorkspaceSummary,
} from "@flock/protocol/workspace-summary";
import type { CredentialCache } from "./credentials";
import { MAX_ATTEMPTS, MAX_HOLD_MS, type WindowClock, type WindowLabels } from "./key-window";
import { compareItems, isAfterCursor, type Cursor } from "./merge";
import {
  COMMIT_DIGEST_BYTES,
  SyncStoreError,
  emptyWriterState,
  type Coverage,
  type ListedWriter,
  type SpaceState,
  type StoredRecord,
  type SyncStore,
  type WriterState,
} from "./store";
import { transportNow, type ClientTransport } from "./transport";

// The sync core: one implementation for channels, DMs and anything added later. Truth is each writer's own host; hints
// (`listRepos` since the stored space revision) only decide whom to check first. A writer is refreshed between two reads
// of its revision, so what is held of it is always one consistent state of its records, never a mixture of two.

export type SyncOptions = {
  /** How long a writer's check at its host stays current (D12). */
  truthIntervalMs: number;
  /** Records held per collection per space: 20,000 messages and 20,000 reactions in a channel. */
  maxRecordsPerCollection: number;
  maxWriters: number;
  concurrency: number;
  pageSize: number;
  /** The page of a collection held in full: the largest the host allows, so a writer's whole history is few round trips. */
  allPageSize: number;
  /** Bracketed listings tried before a writer is reported as changing. */
  maxAttempts: number;
};

export const DEFAULT_SYNC_OPTIONS: SyncOptions = {
  truthIntervalMs: 60 * 60 * 1000,
  maxRecordsPerCollection: 20_000,
  maxWriters: 20_000,
  concurrency: 8,
  pageSize: 100,
  allPageSize: 1_000,
  maxAttempts: 3,
};

/** One writer's records in one space. A channel has one per listed writer; a DM conversation, one per half. */
export type Source = { space: string; repo: string };

export type SetAside = { did: string; reason: string; permanent: boolean };

export type WindowRead = {
  sources: readonly Source[];
  /** The collection paged newest first: a channel's messages. */
  window: string;
  /** Collections held in full alongside the window and listed in the same bracket: a channel's reactions. */
  alongside?: readonly string[];
  limit: number;
  before?: Cursor;
  /** Picks the records a view shows from candidates in merge order, at most `limit`; it may drop invalid ones and read parents. */
  select(candidates: StoredRecord[], limit: number): Promise<StoredRecord[]>;
  /** Overrides the truth interval for this read: 0 checks every source at its host. */
  truthIntervalMs?: number;
  /** Whether a source set aside until its host recovers still shows what is held of it (a channel writer does; a DM half does not). */
  showSetAside?: boolean;
  /** Sources whose failure fails the read instead of setting them aside: the reader's own DM half. */
  required?: readonly string[];
};

export type WindowResult = {
  items: StoredRecord[];
  next?: Cursor;
  /** Every source not set aside holds the page as one checked, consistent state, and no bound cut a scan. */
  complete: boolean;
  setAside: SetAside[];
  /** Writers that kept changing through every bracketed attempt: shown as they were, possibly out of date. */
  changing: string[];
  /** Collections whose bound stopped a scan before its end, on this read or an earlier one whose state is still held. */
  cut: string[];
  /** Writers whose window was read but whose `alongside` collections could not be: shown without those records. */
  partial: SetAside[];
};

export type VerifiedEmptyReason = "unwrittenOrAbsent";

export type VerifiedWorkspaceSnapshot = {
  summary: WorkspaceSummary | null;
  rosterMembers: Set<string>;
  extensions: WorkspaceExtensionSummary[];
  workspaceSnapshotComplete: boolean;
  setAside: SetAside[];
  reason?: string;
};

export type VerifiedSpaceSyncInput = {
  space: string;
  collections: readonly string[];
  verifiedRosterMembers?: ReadonlySet<string> | readonly string[];
  workspaceSnapshotComplete?: boolean;
  includeAuthority?: boolean;
  workspace?: string | null;
  truthIntervalMs?: number;
  fullWriterScan?: boolean;
  maxStarBytes?: number;
  maxStarRecords?: number;
  signal?: AbortSignal;
};

export type VerifiedSpaceSyncResult = {
  records: StoredRecord[];
  byCollection: Record<string, StoredRecord[]>;
  writers: string[];
  listedWriters: string[];
  complete: boolean;
  setAside: SetAside[];
  changing: string[];
  emptyUnwrittenWriters: string[];
  emptyReasons: Record<string, VerifiedEmptyReason>;
};

export type RepoOpsEvent = {
  space: string;
  repo: string;
  collection: string;
  rkey: string;
  uri: string;
  cid: string;
  rev: string;
  value: Record<string, unknown>;
};

export type RepoOpsResetNotice = {
  kind: "reset";
  space: string;
  repo: string;
  reason: string;
  rev: string | null;
};

export type RepoOpsFollowInput = {
  space: string;
  collections: readonly string[];
  deliver: boolean;
  workspace?: string | null;
  writers?: readonly string[];
  listedWriters?: ReadonlySet<string>;
  truthIntervalMs?: number;
  signal?: AbortSignal;
  prepare?: (events: readonly RepoOpsEvent[]) => Promise<boolean>;
  onEvent: (event: RepoOpsEvent) => Promise<void>;
  onReset?: (notice: RepoOpsResetNotice) => void;
  onError?: (error: unknown) => void;
  clock?: WindowClock;
  labels?: WindowLabels;
};

export type RepoOpsFollowResult = {
  kind: "baseline" | "ops" | "reset";
  delivered: RepoOpsEvent[];
  resets: RepoOpsResetNotice[];
  complete: boolean;
  setAside: SetAside[];
};

const WORKSPACE_AUTHORITY_COLLECTIONS = [
  COLLECTION.workspaceProfile,
  COLLECTION.directory,
  COLLECTION.workspaceRoster,
  COLLECTION.admin,
  COLLECTION.appInstall,
  COLLECTION.extInstall,
] as const;

const MAX_OPS_SEEN_ENTRIES = 100_000;

type RepoFollowAttempt = {
  uri: string;
  rkey: string;
  cid: string;
  count: number;
  since: number;
};

type RepoFollowState = {
  rev: string | null;
  setHash: Uint8Array;
  cids: Map<string, Cid>;
  attempts: Map<string, RepoFollowAttempt>;
  unbaselined: boolean;
  stale: boolean;
  /** Elapsed clock timestamp when transient fetch failures began for this baselined writer (`MAX_HOLD_MS`). */
  holdStartedAt: number | null;
};

type SpaceFollowState = {
  baselined: boolean;
  listedOnce: boolean;
  lastCheckedAt: number | null;
  repos: Map<string, RepoFollowState>;
  seen: Set<string>;
  reportedAside: Set<string>;
};

export class SyncCore {
  readonly options: SyncOptions;
  /** Spaces whose writer set this session read in full: each of their writers is checked at its host once in the session. */
  private readonly opened = new Set<string>();
  /** Writers checked at their host in this session. */
  private readonly checked = new Set<string>();
  /** The oldest key of the latest page each space's window showed in this session: how deep a refresh lists. */
  private readonly floors = new Map<string, string>();
  /** Per-space host-ordered oplog tailing state used by `followRepoOps`. */
  private readonly opsFollowers = new Map<string, SpaceFollowState>();

  constructor(private readonly deps: { transport: ClientTransport; credentials: CredentialCache; store: SyncStore; options?: Partial<SyncOptions> }) {
    this.options = { ...DEFAULT_SYNC_OPTIONS, ...deps.options };
  }

  get store(): SyncStore {
    return this.deps.store;
  }

  get credentials(): CredentialCache {
    return this.deps.credentials;
  }

  get did(): string {
    return this.deps.transport.did;
  }

  now(): number {
    return transportNow(this.deps.transport);
  }

  /** Whether the space was opened in this session and the writer not yet checked in it. */
  uncheckedThisSession(source: Source): boolean {
    return this.opened.has(source.space) && !this.checked.has(sourceKey(source));
  }

  markChecked(source: Source): void {
    this.checked.add(sourceKey(source));
  }

  /** The lowest key the open view of `window` in `space` needs: the bottom of the latest page shown in this session. */
  windowFloor(space: string, window: string): string | undefined {
    return this.floors.get(`${space} ${window}`);
  }

  setWindowFloor(space: string, window: string, key: string): void {
    this.floors.set(`${space} ${window}`, key);
  }

  /**
   * The writers of a space, most recently active first. The authority's full list is read when the space is first opened in
   * this session and at each truth interval, and the records of anyone no longer listed are dropped (D14); between those, one
   * `listRepos` since the stored space revision names the writers that moved. A writer whose reported revision is newer than
   * what is held is marked for a check either way. The account's own writer is included while one of its writes is waiting
   * for the authority to list it, so a member's own message is never missing from the next page.
   */
  async writers(space: string, input: { workspace?: string | null } = {}): Promise<ListedWriter[]> {
    return (await this.resolveSpaceWriters(space, input)).writers;
  }

  private async resolveSpaceWriters(
    space: string,
    input: { workspace?: string | null; truthIntervalMs?: number; keepWriters?: ReadonlySet<string>; fullScan?: boolean } = {},
  ): Promise<{ writers: ListedWriter[]; listed: Set<string>; reported: Array<{ did: string; repoRev: string }>; fullScan: boolean }> {
    const authorityDid = authorityOf(space);
    const now = this.now();
    const intervalMs = input.truthIntervalMs ?? this.options.truthIntervalMs;
    const stored = await this.deps.store.getSpace(space);
    const state: SpaceState = stored ?? { space, spaceRev: null, writers: [], writersListedAt: null, workspace: input.workspace ?? null, lastOpenedAt: now };
    const client = await this.deps.credentials.clientFor(space, authorityDid);
    const held = new Map((await this.deps.store.listWriters(space)).map((writer) => [writer.repo, writer]));
    // An own write the authority has not listed yet keeps the own writer a source, for at most one truth interval: after
    // that an account the authority still does not list (say, reduced to read-only) is out of view like anyone else (D14).
    const ownPending = state.ownWriteAt !== undefined && state.ownWriteAt !== null && now - state.ownWriteAt >= 0 && now - state.ownWriteAt < intervalMs;
    const sinceListing = state.writersListedAt === null ? Number.POSITIVE_INFINITY : now - state.writersListedAt;
    let reported: Array<{ did: string; repoRev: string }>;
    let fullScan = false;
    if (input.fullScan || !this.opened.has(space) || sinceListing < 0 || sinceListing >= intervalMs) {
      fullScan = true;
      const scan = await listBoundedRepos(client, { space, maxRepos: this.options.maxWriters });
      if (scan.truncated) throw new Error(`The space has more than ${this.options.maxWriters} writers, more than this client reads.`);
      const listed = new Set(scan.repos.map((repo) => repo.did));
      for (const writer of held.values()) {
        if (listed.has(writer.repo) || (writer.repo === this.did && ownPending) || input.keepWriters?.has(writer.repo)) continue;
        if (writer.syncedRev !== null || Object.keys(writer.coverage).length > 0 || writer.setHash !== undefined) {
          await this.deps.store.purgeWriter(space, writer.repo);
        }
      }
      state.writers = scan.repos.map((repo) => ({ did: repo.did, repoRev: repo.repoRev }));
      state.writersListedAt = now;
      state.spaceRev = maxOf(state.spaceRev, scan.repos.map((repo) => repo.spaceRev));
      reported = state.writers;
      this.opened.add(space);
    } else {
      const moved = await listReposSince(client, { space, since: state.spaceRev, maxRepos: this.options.maxWriters });
      const byDid = new Map(state.writers.map((writer) => [writer.did, writer]));
      for (const repo of moved.repos) byDid.set(repo.did, { did: repo.did, repoRev: repo.repoRev });
      state.writers = [...byDid.values()];
      state.spaceRev = maxOf(state.spaceRev, moved.spaceRev === null ? [] : [moved.spaceRev]);
      reported = moved.repos.map((repo) => ({ did: repo.did, repoRev: repo.repoRev }));
    }
    for (const repo of reported) {
      const writer = held.get(repo.did);
      // A reported revision can lag the host; only one newer than what is held says the writer moved.
      if (writer && (writer.syncedRev === null || repo.repoRev > writer.syncedRev)) await this.markStale(space, repo.did);
    }
    const ownListed = state.writers.find((writer) => writer.did === this.did);
    const ownRev = held.get(this.did)?.syncedRev ?? null;
    // The authority listing the own writer at the revision held for it means the pending write reached it.
    if (ownListed && (ownRev === null || ownListed.repoRev >= ownRev)) state.ownWriteAt = null;
    else if (!ownPending) state.ownWriteAt = null;
    state.lastOpenedAt = now;
    if (input.workspace !== undefined) state.workspace = input.workspace;
    await this.deps.store.putSpace(state);
    const listed = new Set(state.writers.map((writer) => writer.did));
    const writers = [...state.writers].sort((left, right) => (left.repoRev < right.repoRev ? 1 : left.repoRev > right.repoRev ? -1 : 0));
    if (state.ownWriteAt !== null && state.ownWriteAt !== undefined && !ownListed) writers.unshift({ did: this.did, repoRev: ownRev ?? "" });
    return { writers, listed, reported, fullScan };
  }

  /** A hint that a writer moved: it is checked at its host before its records count as current again. */
  async markStale(space: string, repo: string): Promise<void> {
    await this.deps.store.commit({ space, repo, expectedGeneration: null, markStale: true });
    const follower = this.opsFollowers.get(space)?.repos.get(repo);
    if (follower) follower.stale = true;
  }

  /** Marks every tracked writer (including unwritten probes) in `space` stale so the next sync re-probes them. */
  async markSpaceStale(space: string): Promise<void> {
    const spaceState = await this.deps.store.getSpace(space);
    if (spaceState && spaceState.writersListedAt !== null) {
      await this.deps.store.putSpace({ ...spaceState, writersListedAt: null });
    }
    this.opened.delete(space);
    const writers = await this.deps.store.listWriters(space);
    for (const writer of writers) {
      await this.deps.store.commit({ space, repo: writer.repo, expectedGeneration: null, markStale: true });
    }
    const follower = this.opsFollowers.get(space);
    if (follower) {
      for (const repo of follower.repos.values()) repo.stale = true;
    }
  }

  /** Clears host-ordered oplog tailing state for `space` when unfollowed. */
  unfollowRepoOps(space: string): void {
    this.opsFollowers.delete(space);
  }

  /**
   * The account's own write, applied once its host accepted it; the own writer is checked again on the next read. The space
   * is recorded too, so the lifecycle rules find what a write left even when the space was never read.
   */
  async applyOwnWrite(source: Source, change: { upsert?: StoredRecord[]; remove?: Array<{ collection: string; rkey: string }> }, input: { workspace?: string | null } = {}): Promise<void> {
    const space = (await this.deps.store.getSpace(source.space))
      ?? { space: source.space, spaceRev: null, writers: [], writersListedAt: null, workspace: input.workspace ?? null, lastOpenedAt: this.now() };
    await this.deps.store.putSpace({ ...space, ownWriteAt: this.now() });
    await this.deps.store.commit({
      space: source.space,
      repo: source.repo,
      expectedGeneration: null,
      markStale: true,
      recordOptimistic: true,
      upsert: change.upsert,
      remove: change.remove,
    });
  }

  /** Reads one page of `window` across `sources`, refreshing and backfilling writers until the page is the true one. */
  async read(input: WindowRead): Promise<WindowResult> {
    return new ReadRun(this, input).execute();
  }

  /**
   * Syncs and cryptographically verifies the authority's `workspace` space repo (STAR primary, bounded full `listRecords` +
   * `getLatestCommit` fallback, or `listRepoOps` delta when seeded), validates every authority record against `REGISTRY` and
   * `WORKSPACE_ENVELOPE`, and returns the verified snapshot and completeness status (`D11.3 #4`).
   */
  async syncVerifiedWorkspaceSnapshot(
    workspaceUri: string,
    options: { viewerDid?: string; truthIntervalMs?: number; fresh?: boolean; signal?: AbortSignal } = {},
  ): Promise<VerifiedWorkspaceSnapshot> {
    const workspace = parseWorkspaceUri(workspaceUri);
    if (!workspace) throw new Error("Invalid workspace URI.");
    const { authorityDid } = workspace;
    const now = this.now();
    const storedSpace = await this.deps.store.getSpace(workspaceUri);
    await this.deps.store.putSpace(
      storedSpace
        ? { ...storedSpace, lastOpenedAt: now }
        : { space: workspaceUri, spaceRev: null, writers: [], writersListedAt: null, workspace: null, lastOpenedAt: now },
    );
    const epoch = await this.deps.store.epoch(workspaceUri);
    const syncOutcome = await this.syncVerifiedWriter({
      space: workspaceUri,
      repo: authorityDid,
      collections: WORKSPACE_AUTHORITY_COLLECTIONS,
      epoch,
      intervalMs: options.fresh ? 0 : (options.truthIntervalMs ?? 0),
      listed: new Set([authorityDid]),
      allowTrustedEmpty: false,
      maxStarBytes: WORKSPACE_ENVELOPE.maxStarArchiveBytes,
      maxStarRecords: WORKSPACE_ENVELOPE.maxStarRecords,
      signal: options.signal,
    });

    const setAside = syncOutcome.setAside ? [syncOutcome.setAside] : [];
    const changing = syncOutcome.changing ? [authorityDid] : [];
    if (syncOutcome.setAside?.permanent) {
      return {
        summary: null,
        rosterMembers: new Set(),
        extensions: [],
        workspaceSnapshotComplete: false,
        setAside,
        reason: syncOutcome.setAside.reason,
      };
    }

    const byCollection = new Map<string, StoredRecord[]>();
    await Promise.all(WORKSPACE_AUTHORITY_COLLECTIONS.map(async (collection) => {
      byCollection.set(collection, await this.deps.store.records(workspaceUri, collection, authorityDid));
    }));

    const invalidReasons: string[] = [];
    const scannedOf = (collection: string, cap: number): ScannedRecords => {
      const held = byCollection.get(collection) ?? [];
      for (const record of held) {
        const check = validateSpaceRecord(collection, record.value, {
          authorityDid,
          spaceUri: workspaceUri,
          repoDid: authorityDid,
          rkey: record.rkey,
        });
        if (!check.valid) invalidReasons.push(`Invalid ${collection}/${record.rkey}: ${check.reason}`);
      }
      return {
        records: held.map((record) => ({ rkey: record.rkey, value: record.value })),
        truncated: held.length > cap,
      };
    };

    const scan = WORKSPACE_ENVELOPE.authorityRecordScan;
    const summary = summarizeWorkspace(workspaceUri, options.viewerDid ?? this.did, {
      profiles: scannedOf(COLLECTION.workspaceProfile, 1),
      directory: scannedOf(COLLECTION.directory, scan),
      roster: scannedOf(COLLECTION.workspaceRoster, scan),
      admins: scannedOf(COLLECTION.admin, scan),
      installs: scannedOf(COLLECTION.appInstall, scan),
      extInstalls: scannedOf(COLLECTION.extInstall, scan),
    });

    const failureReason = syncOutcome.setAside?.reason
      ?? (changing.length > 0 ? "Authority workspace state is changing." : undefined)
      ?? (!summary ? "Workspace profile is missing or invalid." : undefined)
      ?? invalidReasons[0]
      ?? summary?.degradedReasons[0];

    const workspaceSnapshotComplete = Boolean(summary)
      && setAside.length === 0
      && changing.length === 0
      && invalidReasons.length === 0
      && (summary?.degradedReasons.length ?? 1) === 0;

    return {
      summary,
      rosterMembers: new Set(summary?.members.map((member) => member.did) ?? []),
      extensions: summary?.extensions ?? [],
      workspaceSnapshotComplete,
      setAside,
      ...(failureReason ? { reason: failureReason } : {}),
    };
  }

  /**
   * Cryptographically verified complete sync for `"all"` spaces (`D11.1 #4`, `D11.3 #2-#4`).
   * Writer universe is `union(listRepos(space), verifiedRosterMembers)` (+ `authorityDid` when listed or `includeAuthority`).
   */
  async syncVerifiedSpace(input: VerifiedSpaceSyncInput): Promise<VerifiedSpaceSyncResult> {
    if (input.collections.length === 0) throw new RangeError("Verified space sync requires at least one collection.");
    const authorityDid = authorityOf(input.space);
    const rosterSet = toDidSet(input.verifiedRosterMembers) ?? new Set<string>();
    const keepWriters = new Set<string>(rosterSet);
    if (input.includeAuthority) keepWriters.add(authorityDid);

    const { listed } = await this.resolveSpaceWriters(input.space, {
      workspace: input.workspace,
      truthIntervalMs: input.truthIntervalMs,
      keepWriters: keepWriters.size > 0 ? keepWriters : undefined,
      fullScan: input.fullWriterScan,
    });
    const universeSet = new Set<string>([...listed, ...rosterSet]);
    if (input.includeAuthority) universeSet.add(authorityDid);
    const writers = [...universeSet].sort();
    if (writers.length > this.options.maxWriters) {
      throw new Error(`The space has more than ${this.options.maxWriters} writers, more than this client reads.`);
    }

    const epoch = await this.deps.store.epoch(input.space);
    const intervalMs = input.truthIntervalMs ?? this.options.truthIntervalMs;
    const maxStarBytes = input.maxStarBytes ?? WORKSPACE_ENVELOPE.maxStarArchiveBytes;
    const maxStarRecords = input.maxStarRecords ?? WORKSPACE_ENVELOPE.maxStarRecords;

    const outcomes = await mapLimited(writers, this.options.concurrency, (repo) =>
      this.syncVerifiedWriter({
        space: input.space,
        repo,
        collections: input.collections,
        epoch,
        intervalMs,
        listed,
        allowTrustedEmpty: !listed.has(repo),
        maxStarBytes,
        maxStarRecords,
        signal: input.signal,
      }),
    );

    const setAside: SetAside[] = [];
    const changing: string[] = [];
    const emptyUnwrittenWriters: string[] = [];
    const emptyReasons: Record<string, VerifiedEmptyReason> = {};
    const permanentAside = new Set<string>();
    for (const outcome of outcomes) {
      if (outcome.setAside) {
        setAside.push(outcome.setAside);
        if (outcome.setAside.permanent) permanentAside.add(outcome.repo);
      }
      if (outcome.changing) changing.push(outcome.repo);
      if (outcome.emptyReason) {
        emptyUnwrittenWriters.push(outcome.repo);
        emptyReasons[outcome.repo] = outcome.emptyReason;
      }
    }

    const byCollection: Record<string, StoredRecord[]> = {};
    const records: StoredRecord[] = [];
    await Promise.all(input.collections.map(async (collection) => {
      const held = (await this.deps.store.records(input.space, collection))
        .filter((record) => universeSet.has(record.repo) && !permanentAside.has(record.repo))
        .sort((left, right) => (left.uri < right.uri ? -1 : left.uri > right.uri ? 1 : 0));
      byCollection[collection] = held;
    }));
    for (const collection of input.collections) records.push(...(byCollection[collection] ?? []));

    const complete = input.workspaceSnapshotComplete !== false && setAside.length === 0 && changing.length === 0;
    return { records, byCollection, writers, listedWriters: [...listed].sort(), complete, setAside, changing, emptyUnwrittenWriters, emptyReasons };
  }

  /**
   * Host-ordered oplog event tailing (`D11.3 #5`). Separates verified current-state sync from event delivery:
   * - `deliver: false` baselines existing writers via `listRecords(excludeValues: true)` + MAC-verified `getLatestCommit`
   *   (zero payload downloads) without invoking `onEvent`.
   * - `deliver: true` replays `listRepoOps` in exact host `(rev, idx)` order, verifying `prev` chains, `LtHash`, and
   *   surviving `verifyRecordCid`, advancing `(rev, setHash)` ONLY AFTER handler acknowledgement or retry exhaustion
   *   (`MAX_ATTEMPTS = 3` / `MAX_HOLD_MS = 10 min`).
   */
  async followRepoOps(input: RepoOpsFollowInput): Promise<RepoOpsFollowResult> {
    authorityOf(input.space);
    if (input.collections.length === 0) throw new RangeError("followRepoOps requires at least one collection.");
    const clock: WindowClock = input.clock ?? { now: () => this.now(), elapsed: () => this.now() };
    const labels: WindowLabels = input.labels ?? { items: "records", space: "space" };
    const collectionsSet = new Set(input.collections);
    const intervalMs = input.truthIntervalMs ?? this.options.truthIntervalMs;

    let spaceFollow = this.opsFollowers.get(input.space);
    if (!spaceFollow) {
      spaceFollow = {
        baselined: input.deliver,
        listedOnce: false,
        lastCheckedAt: null,
        repos: new Map(),
        seen: new Set(),
        reportedAside: new Set(),
      };
      this.opsFollowers.set(input.space, spaceFollow);
    }

    let writersList: string[];
    let listedSet: Set<string>;
    let reportedSet: Set<string>;
    let fullScan = false;
    if (input.writers !== undefined) {
      writersList = [...new Set(input.writers)];
      listedSet = input.listedWriters ? new Set(input.listedWriters) : new Set<string>();
      reportedSet = new Set(writersList);
      fullScan = true;
    } else {
      const resolved = await this.resolveSpaceWriters(input.space, {
        workspace: input.workspace,
        truthIntervalMs: input.truthIntervalMs,
      });
      writersList = resolved.writers.map((writer) => writer.did);
      listedSet = resolved.listed;
      reportedSet = new Set(resolved.reported.map((repo) => repo.did));
      fullScan = resolved.fullScan;
      if (fullScan) {
        const active = new Set(writersList);
        for (const repo of spaceFollow.repos.keys()) {
          if (!active.has(repo)) {
            spaceFollow.repos.delete(repo);
            spaceFollow.reportedAside.delete(repo);
          }
        }
      }
    }
    spaceFollow.listedOnce = true;

    const listedRepoRevs = new Map<string, string>();
    if (input.writers === undefined) {
      const spaceState = await this.deps.store.getSpace(input.space);
      for (const entry of spaceState?.writers ?? []) listedRepoRevs.set(entry.did, entry.repoRev);
    }

    const now = clock.now();
    const elapsed = clock.elapsed();
    const intervalElapsed = spaceFollow.lastCheckedAt === null || now - spaceFollow.lastCheckedAt < 0 || now - spaceFollow.lastCheckedAt >= intervalMs;

    type PreparedRepoBatch = {
      repo: string;
      repoState: RepoFollowState;
      events: RepoOpsEvent[];
      commitRev?: string;
      nextSetHash?: Uint8Array;
      nextCids?: Map<string, Cid>;
      silentSeenKeys: string[];
      reset?: RepoOpsResetNotice;
      aside?: SetAside;
    };

    const writersToCheck = writersList.filter((repo) => {
      const existing = spaceFollow.repos.get(repo);
      if (!existing || existing.unbaselined || existing.stale || existing.attempts.size > 0 || existing.holdStartedAt !== null) return true;
      if (!input.deliver || intervalElapsed) return true;
      if (reportedSet.has(repo)) return true;
      const listedRev = listedRepoRevs.get(repo);
      return listedRev !== undefined && (existing.rev === null || listedRev > existing.rev);
    });

    const prepared = await mapLimited(writersToCheck, this.options.concurrency, async (repo): Promise<PreparedRepoBatch> => {
      let repoState = spaceFollow.repos.get(repo);
      if (!repoState) {
        repoState = {
          rev: null,
          setHash: new Uint8Array(LTHASH_STATE_BYTES),
          cids: new Map(),
          attempts: new Map(),
          unbaselined: !input.deliver || !spaceFollow.baselined,
          stale: false,
          holdStartedAt: null,
        };
        spaceFollow.repos.set(repo, repoState);
      }

      const shouldBaselineOnly = !input.deliver || repoState.unbaselined;
      const holdExpired = !shouldBaselineOnly && repoState.holdStartedAt !== null && elapsed - repoState.holdStartedAt >= MAX_HOLD_MS;
      try {
        await this.resolveValidPds(repo);
        if (shouldBaselineOnly || holdExpired) {
          const baseline = await this.fetchOpsBaseline(input.space, repo, {
            allowTrustedEmpty: !listedSet.has(repo) && repoState.rev === null,
            signal: input.signal,
          });
          repoState.rev = baseline.rev;
          repoState.setHash = baseline.setHash;
          repoState.cids = baseline.cids;
          repoState.attempts.clear();
          repoState.unbaselined = false;
          repoState.stale = false;
          repoState.holdStartedAt = null;
          for (const key of baseline.seenKeys) recordSeenKey(spaceFollow.seen, key);
          const reset: RepoOpsResetNotice | undefined = holdExpired
            ? {
                kind: "reset",
                space: input.space,
                repo,
                reason: `held missing writer expired after ${MAX_HOLD_MS / 60_000} minutes`,
                rev: baseline.rev,
              }
            : undefined;
          return { repo, repoState, events: [], silentSeenKeys: [], ...(reset ? { reset } : {}) };
        }

        const replay = await this.fetchAndReplayOpsForFollow({
          space: input.space,
          repo,
          repoState,
          listed: listedSet,
          collectionsSet,
          seen: spaceFollow.seen,
          signal: input.signal,
        });
        if (replay.kind === "reset") {
          const baseline = await this.fetchOpsBaseline(input.space, repo, {
            allowTrustedEmpty: !listedSet.has(repo) && repoState.rev === null,
            signal: input.signal,
          });
          repoState.rev = baseline.rev;
          repoState.setHash = baseline.setHash;
          repoState.cids = baseline.cids;
          repoState.attempts.clear();
          repoState.stale = false;
          repoState.holdStartedAt = null;
          for (const key of baseline.seenKeys) recordSeenKey(spaceFollow.seen, key);
          const reset: RepoOpsResetNotice = { kind: "reset", space: input.space, repo, reason: replay.reason, rev: baseline.rev };
          return { repo, repoState, events: [], silentSeenKeys: [], reset };
        }
        repoState.stale = false;
        repoState.holdStartedAt = null;
        return {
          repo,
          repoState,
          events: replay.events,
          commitRev: replay.commitRev,
          nextSetHash: replay.nextSetHash,
          nextCids: replay.nextCids,
          silentSeenKeys: replay.silentSeenKeys,
        };
      } catch (error) {
        if (error instanceof SyncStoreError || error instanceof SpaceCredentialError) throw error;
        if (isCredentialRefused(error)) this.deps.credentials.drop(input.space);
        const failure = this.classifyRepoNotFoundOrFailure(error, {
          listed: listedSet.has(repo),
          hadSyncedRev: repoState.rev !== null,
        });
        if (!failure) throw error;
        if (failure.kind === "empty") {
          repoState.rev = null;
          repoState.setHash = new Uint8Array(LTHASH_STATE_BYTES);
          repoState.cids = new Map();
          repoState.unbaselined = false;
          repoState.stale = false;
          repoState.holdStartedAt = null;
          return { repo, repoState, events: [], silentSeenKeys: [] };
        }
        if (failure.permanent) {
          repoState.rev = null;
          repoState.setHash = new Uint8Array(LTHASH_STATE_BYTES);
          repoState.cids = new Map();
          repoState.attempts.clear();
          repoState.holdStartedAt = null;
          repoState.unbaselined ||= !input.deliver || !spaceFollow.baselined;
        } else if (!repoState.unbaselined) {
          repoState.holdStartedAt ??= elapsed;
          if (elapsed - repoState.holdStartedAt >= MAX_HOLD_MS) {
            repoState.rev = null;
            repoState.setHash = new Uint8Array(LTHASH_STATE_BYTES);
            repoState.cids = new Map();
            repoState.attempts.clear();
            repoState.holdStartedAt = null;
            repoState.unbaselined = true;
            return {
              repo,
              repoState,
              events: [],
              silentSeenKeys: [],
              reset: {
                kind: "reset",
                space: input.space,
                repo,
                reason: `held missing writer expired after ${MAX_HOLD_MS / 60_000} minutes`,
                rev: null,
              },
              aside: { did: repo, reason: failure.reason, permanent: failure.permanent },
            };
          }
        }
        return {
          repo,
          repoState,
          events: [],
          silentSeenKeys: [],
          aside: { did: repo, reason: failure.reason, permanent: failure.permanent },
        };
      }
    });

    const resets = prepared.flatMap((batch) => (batch.reset ? [batch.reset] : []));
    const setAside = prepared.flatMap((batch) => (batch.aside ? [batch.aside] : []));

    spaceFollow.baselined ||=
      spaceFollow.listedOnce &&
      setAside.length === 0 &&
      writersToCheck.length === writersList.length &&
      writersList.every((did) => spaceFollow.repos.get(did)?.unbaselined === false);
    if (intervalElapsed) spaceFollow.lastCheckedAt = now;
    for (const reset of resets) {
      input.onReset?.(reset);
      if (!input.onReset) {
        input.onError?.(new Error(`Repo oplog reset on ${reset.space} (${reset.repo}): ${reset.reason}.`));
      }
    }

    if (!input.deliver) {
      return {
        kind: resets.length > 0 ? "reset" : "baseline",
        delivered: [],
        resets,
        complete: setAside.length === 0,
        setAside,
      };
    }

    const orderedEntries = mergeFollowQueues(prepared);
    if (input.prepare) {
      const proceed = await input.prepare(orderedEntries.map((entry) => entry.event));
      if (!proceed) {
        return { kind: resets.length > 0 ? "reset" : "ops", delivered: [], resets, complete: setAside.length === 0, setAside };
      }
    }

    for (const batch of prepared) {
      if (!batch.aside) spaceFollow.reportedAside.delete(batch.repo);
    }
    reportFollowSetAside(input.space, labels, setAside, spaceFollow.reportedAside, input.onError);

    const delivered: RepoOpsEvent[] = [];
    for (const { batch, event } of orderedEntries) {
      const seenKey = seenKeyOf(event.uri, event.cid);
      try {
        await input.onEvent(event);
        batch.repoState.attempts.delete(event.uri);
        recordSeenKey(spaceFollow.seen, seenKey);
        delivered.push(event);
      } catch (error) {
        input.onError?.(error);
        const existing = batch.repoState.attempts.get(event.uri);
        const attempt: RepoFollowAttempt = existing
          ? { ...existing, cid: event.cid, count: existing.count + 1 }
          : { uri: event.uri, rkey: event.rkey, cid: event.cid, count: 1, since: elapsed };
        if (attempt.count < MAX_ATTEMPTS) {
          batch.repoState.attempts.set(event.uri, attempt);
          continue;
        }
        input.onError?.(new Error(`The app failed on ${event.uri} ${attempt.count} times; it is not given again.`));
        batch.repoState.attempts.delete(event.uri);
        recordSeenKey(spaceFollow.seen, seenKey);
      }
    }

    for (const batch of prepared) {
      if (batch.aside) continue;
      for (const [uri, attempt] of batch.repoState.attempts) {
        if (elapsed - attempt.since <= MAX_HOLD_MS) continue;
        batch.repoState.attempts.delete(uri);
        recordSeenKey(spaceFollow.seen, seenKeyOf(attempt.uri, attempt.cid));
        input.onError?.(new Error(`The app failed on ${attempt.uri} and it has not been read again for ${MAX_HOLD_MS / 60_000} minutes; it is not given again.`));
      }

      if (batch.repoState.attempts.size === 0 && batch.nextSetHash && batch.nextCids) {
        batch.repoState.rev = batch.commitRev ?? null;
        batch.repoState.setHash = batch.nextSetHash;
        batch.repoState.cids = batch.nextCids;
        for (const key of batch.silentSeenKeys) recordSeenKey(spaceFollow.seen, key);
      }
    }

    return {
      kind: resets.length > 0 ? "reset" : "ops",
      delivered,
      resets,
      complete: setAside.length === 0,
      setAside,
    };
  }

  private async syncVerifiedWriter(input: {
    space: string;
    repo: string;
    collections: readonly string[];
    epoch: string;
    intervalMs: number;
    listed: ReadonlySet<string>;
    allowTrustedEmpty: boolean;
    maxStarBytes: number;
    maxStarRecords: number;
    signal?: AbortSignal;
  }): Promise<{ repo: string; setAside?: SetAside; changing?: boolean; emptyReason?: VerifiedEmptyReason }> {
    const now = this.now();
    const initial = await this.deps.store.getWriter(input.space, input.repo);
    const listedEntry = (await this.deps.store.getSpace(input.space))?.writers.find((writer) => writer.did === input.repo);
    if (!this.verifiedWriterNeedsCheck(initial, input.collections, listedEntry?.repoRev, now, input.intervalMs)) {
      return {
        repo: input.repo,
        ...(initial?.syncedRev === null ? { emptyReason: "unwrittenOrAbsent" as const } : {}),
      };
    }

    let currentState = initial;
    for (let casAttempt = 0; casAttempt < WORKSPACE_ENVELOPE.maxListRecordsRetry; casAttempt += 1) {
      if ((await this.deps.store.epoch(input.space)) !== input.epoch) return { repo: input.repo };
      currentState = await this.deps.store.getWriter(input.space, input.repo);
      const state = currentState ?? emptyWriterState(input.space, input.repo);
      let validPds: string | null = null;
      try {
        validPds = await this.resolveValidPds(input.repo);
        const canTryDelta = state.syncedRev !== null
          && hasVerifiedSetHash(state)
          && allPersistedCollectionsCovered(state, input.collections);

        if (canTryDelta) {
          const delta = await this.tryAdvanceViaRepoOps({
            space: input.space,
            repo: input.repo,
            state,
            collections: input.collections,
            maxBytes: input.maxStarBytes,
            maxRecords: input.maxStarRecords,
            signal: input.signal,
          });
          if (delta.applied) {
            const committed = await this.deps.store.commit({
              space: input.space,
              repo: input.repo,
              expectedGeneration: state.generation,
              rev: delta.commit.rev,
              epoch: input.epoch,
              next: {
                syncedRev: delta.commit.rev,
                checkedAt: this.now(),
                stale: false,
                coverage: delta.coverage,
                setHash: delta.setHash,
                commitDigest: delta.commit.data,
              },
              ...(delta.upsert.length > 0 ? { upsert: delta.upsert } : {}),
              ...(delta.remove.length > 0 ? { remove: delta.remove } : {}),
            });
            if (committed) return { repo: input.repo };
            continue;
          }
        }

        const recovered = await this.recoverFullVerifiedRepo({
          space: input.space,
          repo: input.repo,
          pdsUrl: validPds,
          maxBytes: input.maxStarBytes,
          maxRecords: input.maxStarRecords,
          signal: input.signal,
        });
        const replace = buildFullReplaceMap(input.space, input.repo, recovered.records, [
          ...Object.keys(state.coverage),
          ...input.collections,
        ]);
        const nextCoverage = buildVerifiedCoverage(replace, input.collections);
        const committed = await this.deps.store.commit({
          space: input.space,
          repo: input.repo,
          expectedGeneration: state.generation,
          rev: recovered.commit.rev,
          epoch: input.epoch,
          next: {
            syncedRev: recovered.commit.rev,
            checkedAt: this.now(),
            stale: false,
            coverage: nextCoverage,
            setHash: recovered.setHash,
            commitDigest: recovered.commitDigest,
          },
          replace,
        });
        if (committed) return { repo: input.repo };
      } catch (error) {
        if (error instanceof SyncStoreError || error instanceof SpaceCredentialError) throw error;
        if (isCredentialRefused(error)) this.deps.credentials.drop(input.space);
        const hadSyncedRev = state.syncedRev !== null;
        if (error instanceof XrpcError && error.code === "RepoNotFound") {
          if (input.allowTrustedEmpty && !hadSyncedRev && validPds !== null) {
            const emptyReplace = buildFullReplaceMap(input.space, input.repo, [], [
              ...Object.keys(state.coverage),
              ...input.collections,
            ]);
            const emptyCoverage = buildVerifiedCoverage(emptyReplace, input.collections);
            await this.deps.store.commit({
              space: input.space,
              repo: input.repo,
              expectedGeneration: state.generation,
              epoch: input.epoch,
              next: {
                syncedRev: null,
                checkedAt: this.now(),
                stale: false,
                coverage: emptyCoverage,
                setHash: new Uint8Array(LTHASH_STATE_BYTES),
              },
              replace: emptyReplace,
            });
            return { repo: input.repo, emptyReason: "unwrittenOrAbsent" };
          }
          // Fail closed without dropping verified cached records on unauthenticated 400 RepoNotFound.
          return { repo: input.repo, setAside: { did: input.repo, reason: "its host has no repo for it", permanent: false } };
        }
        if (error instanceof ChangingWriterError) return { repo: input.repo, changing: true };
        const failure = classifyVerifiedRepoFailure(error);
        if (!failure) throw error;
        if (failure.permanent) await this.dropRecordsOnPermanentFailure(input.space, input.repo, state, input.collections, input.epoch);
        return { repo: input.repo, setAside: { did: input.repo, reason: failure.reason, permanent: failure.permanent } };
      }
    }
    return { repo: input.repo, changing: true };
  }

  private verifiedWriterNeedsCheck(
    state: WriterState | undefined,
    collections: readonly string[],
    listedRepoRev: string | undefined,
    now: number,
    intervalMs: number,
  ): boolean {
    if (!state || state.stale || state.checkedAt === null || !hasVerifiedSetHash(state)) return true;
    if (!allPersistedCollectionsCovered(state, collections)) return true;
    if (intervalMs === 0) return true;
    if (listedRepoRev !== undefined && (state.syncedRev === null || listedRepoRev > state.syncedRev)) return true;
    const sinceCheck = now - state.checkedAt;
    return sinceCheck < 0 || sinceCheck >= intervalMs;
  }

  private async dropRecordsOnPermanentFailure(
    space: string,
    repo: string,
    state: WriterState,
    collections: readonly string[],
    epoch: string,
  ): Promise<void> {
    // When a writer had a verified syncedRev !== null and disappeared (`RepoNotFound` while omitted from listRepos),
    // clear held records/setHash/coverage while keeping `syncedRev` non-null so subsequent reads continue failing closed.
    if (state.syncedRev !== null) {
      const emptyReplace = buildFullReplaceMap(space, repo, [], [...Object.keys(state.coverage), ...collections]);
      await this.deps.store.commit({
        space,
        repo,
        expectedGeneration: state.generation,
        epoch,
        next: {
          syncedRev: state.syncedRev,
          checkedAt: null,
          stale: false,
          coverage: {},
        },
        replace: emptyReplace,
      });
      return;
    }
    await this.deps.store.purgeWriter(space, repo);
  }

  private async resolveValidPds(did: string): Promise<string> {
    if (!isDid(did)) throw new Error(`Invalid writer DID: ${did}`);
    const pdsUrl = await this.deps.transport.resolvePds(did);
    if (!isValidPdsEndpointUrl(pdsUrl)) throw new Error(`Invalid PDS endpoint URL for ${did}.`);
    return pdsUrl;
  }

  private async withCredentialRetry<T>(space: string, repo: string, run: (credential: SpaceCredential, client: AtprotoClient) => Promise<T>): Promise<T> {
    const pdsUrl = await this.resolveValidPds(repo);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const credential = attempt === 0 ? await this.deps.credentials.get(space) : await this.deps.credentials.fresh(space);
      try {
        return await run(credential, credential.client(pdsUrl));
      } catch (error) {
        if (attempt === 0 && isCredentialRefused(error)) {
          this.deps.credentials.drop(space);
          continue;
        }
        throw error;
      }
    }
    throw new Error("Credential retry exhausted.");
  }

  private async tryAdvanceViaRepoOps(input: {
    space: string;
    repo: string;
    state: WriterState;
    collections: readonly string[];
    maxBytes: number;
    maxRecords: number;
    signal?: AbortSignal;
  }): Promise<
    | { applied: false }
    | {
        applied: true;
        commit: Commit;
        setHash: Uint8Array;
        coverage: Record<string, Coverage>;
        upsert: StoredRecord[];
        remove: Array<{ collection: string; rkey: string }>;
      }
  > {
    const { space, repo, state } = input;
    const syncedRev = state.syncedRev!;
    const persistedCols = Object.keys(state.coverage);
    const persisted = (await Promise.all(persistedCols.map((c) => this.deps.store.records(space, c, repo)))).flat();
    const liveRecords = new Map<string, StoredRecord>();
    for (const record of persisted) {
      liveRecords.set(pathKey(record.collection, record.rkey), record);
    }
    const overlayKeys = new Map<string, StoredRecord | null>();
    for (const entry of state.optimisticOverlay ?? []) {
      const path = pathKey(entry.collection, entry.rkey);
      overlayKeys.set(path, entry.prevRecord);
      if (entry.prevRecord === null) {
        liveRecords.delete(path);
      } else {
        liveRecords.set(path, entry.prevRecord);
      }
    }
    const stagedCids = new Map<string, Cid>();
    for (const [path, record] of liveRecords) {
      const cid = parseCidSafe(record.cid);
      if (!cid) return { applied: false };
      stagedCids.set(path, cid);
    }
    const persistedSetHash = RepoCommit.fromRecords(
      [...stagedCids.entries()].map(([path, cid]) => {
        const [collection, rkey] = splitPathKey(path);
        return { collection: collection as never, rkey: rkey as never, cid };
      }),
    ).setHash.state();
    if (!bytesEqual(persistedSetHash, state.setHash!)) return { applied: false };

    let paged: { ops: RawRepoOp[]; commit: Commit };
    try {
      paged = await this.fetchRepoOpsPages(space, repo, syncedRev, false, input.signal);
    } catch (error) {
      if (error instanceof DeltaFallbackError || error instanceof UnsignedEmptyRepoOpsError || isUnsupportedEndpointError(error)) {
        return { applied: false };
      }
      throw error;
    }

    const replayed = await replayValidatedRepoOps({
      space,
      repo,
      ops: paged.ops,
      commit: paged.commit,
      baseRev: syncedRev,
      baseSetHash: state.setHash!,
      baseCids: stagedCids,
      maxRecords: input.maxRecords,
    });
    if (!replayed.ok) {
      if (replayed.exceededLimit === "records") {
        throw new RepoStarLimitError("records", input.maxRecords);
      }
      return { applied: false };
    }

    const touchedPaths = new Set<string>();
    const touchedBytes = new Map<string, number>();
    const upsert: StoredRecord[] = [];
    const remove: Array<{ collection: string; rkey: string }> = [];
    for (const item of replayed.touched) {
      touchedPaths.add(item.path);
      if (item.finalCid === null) {
        liveRecords.delete(item.path);
        remove.push({ collection: item.collection, rkey: item.rkey });
      } else {
        if (item.finalByteLength !== undefined) touchedBytes.set(item.path, item.finalByteLength);
        const stored: StoredRecord = {
          space,
          repo,
          collection: item.collection,
          rkey: item.rkey,
          uri: spaceRecordUri(space, repo, item.collection, item.rkey),
          cid: item.finalCid.toString(),
          value: item.finalValue!,
        };
        liveRecords.set(item.path, stored);
        upsert.push(stored);
      }
    }

    // Reconcile any optimistic keys not touched by verified oplog replay back to their verified pre-optimistic baseline.
    for (const [path, prevRecord] of overlayKeys) {
      if (touchedPaths.has(path)) continue;
      if (prevRecord === null) {
        const [collection, rkey] = splitPathKey(path);
        remove.push({ collection, rkey });
      } else {
        upsert.push(prevRecord);
      }
    }

    // Enforce aggregate 20,000-record and 16 MiB CBOR byte caps over all surviving live records (matching cold STAR).
    if (replayed.stagedCids.size > input.maxRecords) {
      throw new RepoStarLimitError("records", input.maxRecords);
    }
    let liveBytes = 0;
    const byCol = new Map<string, StoredRecord[]>();
    for (const [path] of replayed.stagedCids) {
      const live = liveRecords.get(path);
      if (!live) continue;
      const bytes = touchedBytes.get(path) ?? await serializedRecordBytes(live.collection, live.rkey, live.value);
      liveBytes += bytes;
      if (liveBytes > input.maxBytes) {
        throw new RepoStarLimitError("bytes", input.maxBytes, liveBytes);
      }
      const list = byCol.get(live.collection) ?? [];
      list.push(live);
      byCol.set(live.collection, list);
    }
    return {
      applied: true,
      commit: paged.commit,
      setHash: replayed.setHash,
      coverage: buildVerifiedCoverage(Object.fromEntries(byCol), [...persistedCols, ...input.collections]),
      upsert,
      remove,
    };
  }

  private async fetchRepoOpsPages(
    space: string,
    repo: string,
    since: string | undefined,
    excludeValues: boolean,
    signal?: AbortSignal,
  ): Promise<{ ops: RawRepoOp[]; commit: Commit }> {
    return this.withCredentialRetry(space, repo, async (_credential, client) => {
      const ops: RawRepoOp[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      for (let pageIndex = 0; pageIndex < WORKSPACE_ENVELOPE.maxRepoOpsPages; pageIndex += 1) {
        if (signal?.aborted) throw signal.reason ?? new Error("Aborted.");
        const page = await client.query<{ ops?: unknown; cursor?: unknown; commit?: unknown }>("com.atproto.space.listRepoOps", {
          space,
          repo,
          ...(since !== undefined && cursor === undefined ? { since } : {}),
          limit: 500,
          ...(excludeValues ? { excludeValues: true } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
        });
        if (!page || typeof page !== "object" || !Array.isArray(page.ops) || page.ops.length > 500) {
          throw new DeltaFallbackError("Malformed listRepoOps page.");
        }
        ops.push(...(page.ops as RawRepoOp[]));
        if (page.commit !== undefined) {
          const commit = decodeCommitResponse(page.commit, space, repo);
          if (!commit || page.cursor !== undefined) throw new DeltaFallbackError("Malformed final listRepoOps commit.");
          return { ops, commit };
        }
        if (typeof page.cursor === "string" && page.cursor.length > 0 && page.ops.length > 0) {
          if (page.cursor === cursor || seenCursors.has(page.cursor)) {
            throw new DeltaFallbackError("listRepoOps cursor did not advance.");
          }
          seenCursors.add(page.cursor);
          cursor = page.cursor;
          continue;
        }
        if (page.ops.length === 0 && page.cursor === undefined) {
          throw new UnsignedEmptyRepoOpsError();
        }
        throw new DeltaFallbackError("Missing commit or cursor on listRepoOps page.");
      }
      throw new DeltaFallbackError("listRepoOps exceeded maxRepoOpsPages.");
    });
  }

  private async recoverFullVerifiedRepo(input: {
    space: string;
    repo: string;
    pdsUrl: string;
    maxBytes: number;
    maxRecords: number;
    signal?: AbortSignal;
  }): Promise<{ commit: Commit; setHash: Uint8Array; commitDigest: Uint8Array; records: Array<{ collection: string; rkey: string; cid: string; value: Record<string, unknown> }> }> {
    let starUnsupported = false;
    for (let attempt = 0; attempt < WORKSPACE_ENVELOPE.maxListRecordsRetry; attempt += 1) {
      if (input.signal?.aborted) throw input.signal.reason ?? new Error("Aborted.");
      try {
        const star = await this.withCredentialRetry(input.space, input.repo, (credential) =>
          credential.fetchVerifiedRepoStar(input.pdsUrl, {
            space: input.space,
            repo: input.repo,
            maxBytes: input.maxBytes,
            maxRecords: input.maxRecords,
            signal: input.signal,
          }),
        );
        return {
          commit: star.commit,
          setHash: star.setHash,
          commitDigest: star.commitDigest,
          records: star.records.map((entry) => ({
            collection: entry.collection,
            rkey: entry.rkey,
            cid: entry.cid,
            value: entry.record,
          })),
        };
      } catch (error) {
        if (error instanceof RepoStarLimitError || error instanceof SpaceMacError || error instanceof KemKeyError || error instanceof SpaceCredentialError || error instanceof SyncStoreError) {
          throw error;
        }
        if (error instanceof XrpcError && error.code === "RepoNotFound") throw error;
        if (isUnsupportedEndpointError(error)) {
          starUnsupported = true;
          break;
        }
        if (error instanceof RepoVerificationError || error instanceof StarParseError) {
          if (attempt + 1 < WORKSPACE_ENVELOPE.maxListRecordsRetry) continue;
          throw error;
        }
        throw error;
      }
    }

    if (!starUnsupported) throw new RepoVerificationError(`STAR verification failed for ${input.repo}.`);

    for (let attempt = 0; attempt < WORKSPACE_ENVELOPE.maxListRecordsRetry; attempt += 1) {
      const result = await this.withCredentialRetry(input.space, input.repo, async (_credential, client) => {
        const beforeCommit = await latestCommit(client, input.space, input.repo);
        const listed = await listVerifiedBoundedRecords(client, {
          space: input.space,
          repo: input.repo,
          maxRecords: input.maxRecords,
          maxBytes: input.maxBytes,
        });
        const afterCommit = await latestCommit(client, input.space, input.repo);
        return { beforeCommit, listed, afterCommit };
      });
      if (result.beforeCommit.rev !== result.afterCommit.rev) continue;
      const repoCommit = RepoCommit.fromRecords(
        result.listed.records.map((entry) => ({
          collection: entry.collection as never,
          rkey: entry.rkey as never,
          cid: entry.parsedCid,
        })),
      );
      if (!repoCommit.matches(result.afterCommit)) {
        throw new SpaceMacError(`Commit digest mismatch for ${input.repo} across stable listRecords bracket.`);
      }
      return {
        commit: result.afterCommit,
        setHash: repoCommit.setHash.state(),
        commitDigest: new Uint8Array(result.afterCommit.data),
        records: result.listed.records.map((entry) => ({
          collection: entry.collection,
          rkey: entry.rkey,
          cid: entry.cid,
          value: entry.value,
        })),
      };
    }
    throw new ChangingWriterError(input.repo);
  }

  private async fetchOpsBaseline(
    space: string,
    repo: string,
    input: { allowTrustedEmpty: boolean; signal?: AbortSignal },
  ): Promise<{ rev: string | null; setHash: Uint8Array; cids: Map<string, Cid>; seenKeys: string[] }> {
    for (let attempt = 0; attempt < WORKSPACE_ENVELOPE.maxListRecordsRetry; attempt += 1) {
      if (input.signal?.aborted) throw input.signal.reason ?? new Error("Aborted.");
      try {
        const result = await this.withCredentialRetry(space, repo, async (_credential, client) => {
          const beforeCommit = await latestCommit(client, space, repo);
          const listed = await listBoundedRecords(client, {
            space,
            repo,
            maxRecords: WORKSPACE_ENVELOPE.maxStarRecords,
            excludeValues: true,
          });
          if (listed.truncated) throw new RepoStarLimitError("records", WORKSPACE_ENVELOPE.maxStarRecords);
          const afterCommit = await latestCommit(client, space, repo);
          return { beforeCommit, listed, afterCommit };
        });
        if (result.beforeCommit.rev !== result.afterCommit.rev) continue;
        const cids = new Map<string, Cid>();
        const seenKeys: string[] = [];
        const commitEntries: Array<{ collection: never; rkey: never; cid: Cid }> = [];
        for (const entry of result.listed.records) {
          const parsedCid = parseCidSafe(entry.cid);
          if (!parsedCid) throw new SpaceMacError(`Invalid CID in listRecords baseline for ${repo}.`);
          cids.set(pathKey(entry.collection, entry.rkey), parsedCid);
          seenKeys.push(seenKeyOf(spaceRecordUri(space, repo, entry.collection, entry.rkey), entry.cid));
          commitEntries.push({ collection: entry.collection as never, rkey: entry.rkey as never, cid: parsedCid });
        }
        const repoCommit = RepoCommit.fromRecords(commitEntries);
        if (!repoCommit.matches(result.afterCommit)) {
          throw new SpaceMacError(`Commit digest mismatch for ${repo} across stable baseline bracket.`);
        }
        return {
          rev: result.afterCommit.rev,
          setHash: repoCommit.setHash.state(),
          cids,
          seenKeys,
        };
      } catch (error) {
        if (error instanceof XrpcError && error.code === "RepoNotFound" && input.allowTrustedEmpty) {
          return { rev: null, setHash: new Uint8Array(LTHASH_STATE_BYTES), cids: new Map(), seenKeys: [] };
        }
        throw error;
      }
    }
    throw new SpaceMacError(`Baseline verification failed for ${repo} due to concurrent writes or commit mismatch.`);
  }

  private async fetchAndReplayOpsForFollow(input: {
    space: string;
    repo: string;
    repoState: RepoFollowState;
    listed: ReadonlySet<string>;
    collectionsSet: ReadonlySet<string>;
    seen: ReadonlySet<string>;
    signal?: AbortSignal;
  }): Promise<
    | { kind: "reset"; reason: string }
    | {
        kind: "ops";
        events: RepoOpsEvent[];
        commitRev: string | undefined;
        nextSetHash: Uint8Array;
        nextCids: Map<string, Cid>;
        silentSeenKeys: string[];
      }
  > {
    const { space, repo, repoState } = input;
    let paged: { ops: RawRepoOp[]; commit: Commit };
    try {
      paged = await this.fetchRepoOpsPages(space, repo, repoState.rev ?? undefined, false, input.signal);
    } catch (error) {
      if (error instanceof UnsignedEmptyRepoOpsError) {
        if (repoState.rev === null && !input.listed.has(repo)) {
          return {
            kind: "ops",
            events: [],
            commitRev: undefined,
            nextSetHash: new Uint8Array(LTHASH_STATE_BYTES),
            nextCids: new Map(),
            silentSeenKeys: [],
          };
        }
        throw new SpaceMacError(`Host returned unsigned empty listRepoOps for ${repo}.`);
      }
      if (error instanceof DeltaFallbackError) {
        return { kind: "reset", reason: error.message };
      }
      throw error;
    }

    const replayed = await replayValidatedRepoOps({
      space,
      repo,
      ops: paged.ops,
      commit: paged.commit,
      baseRev: repoState.rev,
      baseSetHash: repoState.setHash,
      baseCids: repoState.cids,
    });
    if (!replayed.ok) {
      return { kind: "reset", reason: replayed.reason };
    }

    const surviving = replayed.touched
      .filter((item) => item.finalCid !== null)
      .sort((left, right) => left.orderIndex - right.orderIndex);

    const events: RepoOpsEvent[] = [];
    const silentSeenKeys: string[] = [];
    for (const item of surviving) {
      const cidStr = item.finalCid!.toString();
      const uri = spaceRecordUri(space, repo, item.collection, item.rkey);
      const seenKey = seenKeyOf(uri, cidStr);
      const isCreateOrRestore = !item.hadBefore || item.sawCreateOrDelete;
      if (!input.collectionsSet.has(item.collection) || !isCreateOrRestore || input.seen.has(seenKey)) {
        silentSeenKeys.push(seenKey);
        continue;
      }
      events.push({
        space,
        repo,
        collection: item.collection,
        rkey: item.rkey,
        uri,
        cid: cidStr,
        rev: item.finalRev,
        value: item.finalValue!,
      });
    }

    return {
      kind: "ops",
      events,
      commitRev: paged.commit.rev,
      nextSetHash: replayed.setHash,
      nextCids: replayed.stagedCids,
      silentSeenKeys,
    };
  }

  private classifyRepoNotFoundOrFailure(
    error: unknown,
    ctx: { listed: boolean; hadSyncedRev: boolean },
  ): ({ kind: "empty" } | { kind: "failure"; reason: string; permanent: boolean }) | null {
    if (error instanceof XrpcError && error.code === "RepoNotFound") {
      if (!ctx.listed && !ctx.hadSyncedRev) return { kind: "empty" };
      return { kind: "failure", reason: "its host has no repo for it", permanent: false };
    }
    const failure = classifyVerifiedRepoFailure(error);
    return failure ? { kind: "failure", ...failure } : null;
  }
}

/** One read: its set-aside writers, changing writers, bounds, and the page it settled on. */
class ReadRun {
  private readonly aside = new Map<string, SetAside>();
  /** Writers purged while this read was reading them (no longer listed, or unreadable for good): not read further. */
  private readonly dropped = new Set<string>();
  private readonly partial = new Map<string, SetAside>();
  private readonly changing = new Set<string>();
  private readonly cut = new Set<string>();
  private readonly budgets = new Map<string, Promise<Budget>>();
  private readonly strategies: Map<string, Coverage["strategy"]>;
  private readonly intervalMs: number;
  /** How many records of the window a writer's first listing asks for: its share of the page, at least ten. */
  private readonly firstPage: number;
  /** Sources this read checked at their host: with a truth interval of 0, each is checked once per read. */
  private readonly checkedHere = new Set<string>();
  /** Each space's epoch when the read started: a purge since then ends the read's commits to that space. */
  private readonly epochs = new Map<string, Promise<string>>();
  /** Each writer's generation when the read started: a writer that became a tombstone since then was purged mid-read. */
  private startGenerations = new Map<string, number>();

  constructor(private readonly core: SyncCore, private readonly input: WindowRead) {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) throw new RangeError("Page limit must be a positive safe integer.");
    this.strategies = new Map<string, Coverage["strategy"]>([[input.window, "window"], ...(input.alongside ?? []).map((collection) => [collection, "all"] as const)]);
    this.intervalMs = input.truthIntervalMs ?? core.options.truthIntervalMs;
    this.firstPage = Math.max(1, Math.min(core.options.pageSize, Math.max(10, Math.ceil(input.limit / Math.max(1, input.sources.length)))));
  }

  async execute(): Promise<WindowResult> {
    const options = this.core.options;
    for (const source of this.input.sources) if (!this.epochs.has(source.space)) this.epochs.set(source.space, this.core.store.epoch(source.space));
    const initial = await this.states();
    for (const [key, state] of initial) if (state) this.startGenerations.set(key, state.generation);
    const due = this.input.sources.filter((source) => this.needsCheck(source, initial.get(sourceKey(source))));
    await mapLimited(due, options.concurrency, (source) => this.guard(source, () => this.check(source)));

    let page: StoredRecord[] = [];
    let needsMore: Source[] = [];
    for (let round = 0; ; round += 1) {
      if (round > options.maxRecordsPerCollection) throw new Error("The read did not settle within its bounded number of rounds.");
      const states = await this.states();
      // A writer set aside until its host recovers still shows what is held of it; it is only not read further.
      const candidates = (await this.held(this.input.window)).filter((record) => isAfterCursor(itemOf(record), this.input.before));
      candidates.sort((left, right) => compareItems(itemOf(left), itemOf(right)));
      // The page is in merge order whatever order `select` returns, so the cursor taken from it continues where it ends.
      page = (await this.input.select(candidates, this.input.limit + 1)).sort((left, right) => compareItems(itemOf(left), itemOf(right)));
      const cutoff = page.length >= this.input.limit ? page[this.input.limit - 1]!.rkey : undefined;
      needsMore = this.readable().filter((source) => {
        const coverage = states.get(sourceKey(source))?.coverage[this.input.window];
        if (coverage?.complete) return false;
        return cutoff === undefined || !coverage || coverage.lowest === null || coverage.lowest > cutoff;
      });
      if (needsMore.length === 0 || this.cut.has(this.input.window)) break;
      const progressed = await mapLimited(needsMore, options.concurrency, (source) => this.guard(source, () => this.backfill(source)));
      if (!progressed.some(Boolean)) break;
    }

    const states = await this.states();
    // A collection held in full that a writer holds only in part was cut at its bound, on this read or an earlier one.
    for (const [collection, strategy] of this.strategies) {
      if (strategy === "all" && this.readable().some((source) => states.get(sourceKey(source))?.coverage[collection]?.complete === false)) this.cut.add(collection);
    }
    const items = page.slice(0, this.input.limit);
    const last = items[items.length - 1];
    if (!this.input.before && last) for (const space of new Set(this.input.sources.map((source) => source.space))) this.core.setWindowFloor(space, this.input.window, last.rkey);
    const moreMayExist = page.length > this.input.limit || this.readable().some((source) => !states.get(sourceKey(source))?.coverage[this.input.window]?.complete);
    const allChecked = this.readable().every((source) => !this.needsCheck(source, states.get(sourceKey(source))));
    return {
      items,
      ...(moreMayExist && last ? { next: { key: last.rkey, uri: last.uri } } : {}),
      complete: needsMore.length === 0 && this.cut.size === 0 && this.changing.size === 0 && this.partial.size === 0 && allChecked,
      setAside: [...this.aside.values()],
      changing: [...this.changing],
      cut: [...this.cut],
      partial: [...this.partial.values()],
    };
  }

  private needsCheck(source: Source, state: WriterState | undefined): boolean {
    if (!state || state.stale || state.checkedAt === null) return true;
    // A collection missing, or held in full but cut at its bound, is listed again on every read until it fits.
    if ([...this.strategies].some(([collection, strategy]) => state.coverage[collection] === undefined || (strategy === "all" && !state.coverage[collection]!.complete))) return true;
    if (this.intervalMs === 0) return !this.checkedHere.has(sourceKey(source));
    if (this.core.uncheckedThisSession(source)) return true;
    const sinceCheck = this.core.now() - state.checkedAt;
    // A check time in the future (a clock set back) counts as due rather than as fresh forever.
    return sinceCheck < 0 || sinceCheck >= this.intervalMs;
  }

  private readable(): Source[] {
    return this.input.sources.filter((source) => !this.aside.has(source.repo) && !this.dropped.has(source.repo));
  }

  /** The read's writers' states, one store read per space. */
  private async states(): Promise<Map<string, WriterState | undefined>> {
    const states = new Map<string, WriterState | undefined>();
    for (const space of new Set(this.input.sources.map((source) => source.space))) {
      for (const state of await this.core.store.listWriters(space)) states.set(sourceKey(state), state);
    }
    return states;
  }

  /** What is held of `collection` from the read's sources, one store read per space. */
  private async held(collection: string): Promise<StoredRecord[]> {
    const bySpace = new Map<string, Set<string>>();
    for (const source of this.input.sources) {
      const aside = this.aside.get(source.repo);
      if (this.dropped.has(source.repo) || (aside && (aside.permanent || this.input.showSetAside === false))) continue;
      const repos = bySpace.get(source.space) ?? new Set<string>();
      repos.add(source.repo);
      bySpace.set(source.space, repos);
    }
    const records: StoredRecord[] = [];
    for (const [space, repos] of bySpace) {
      for (const record of await this.core.store.records(space, collection)) if (repos.has(record.repo)) records.push(record);
    }
    return records;
  }

  /** Reads the writer's revision at its host; refreshes it only when it moved, or a hint or own write made it stale. */
  private async check(source: Source): Promise<boolean> {
    const client = await this.core.credentials.clientFor(source.space, source.repo);
    const rev = await latestRev(client, source);
    const state = (await this.core.store.getWriter(source.space, source.repo)) ?? emptyWriterState(source.space, source.repo);
    // A collection held in full that was cut at its bound is listed again, in case the bound has room now.
    const covered = [...this.strategies].every(([collection, strategy]) => {
      const coverage = state.coverage[collection];
      return coverage !== undefined && (strategy === "window" || coverage.complete);
    });
    if (!state.stale && covered && rev === state.syncedRev) {
      const committed = await this.core.store.commit({
        space: source.space, repo: source.repo, expectedGeneration: state.generation, rev, epoch: await this.epochs.get(source.space),
        next: { ...stateFields(state), checkedAt: this.core.now() },
      });
      if (committed) {
        this.core.markChecked(source);
        this.checkedHere.add(sourceKey(source));
        return true;
      }
    }
    return this.refresh(source, client, rev);
  }

  /**
   * Lists every collection held of the writer between two reads of its revision: a window one page newest first (down to the
   * read's cursor when paging back), a collection held in full to its end. A listing is committed only when both reads agree,
   * and only over the state it started from: a hint, an own write or a purge in the meantime advances the generation and the
   * refresh starts again, except that a purge of the writer or the space ends it. If an `alongside` collection cannot be
   * listed, the window is still committed under the same bracket and the writer is reported as partial.
   */
  private async refresh(source: Source, client: AtprotoClient, firstRev?: string): Promise<boolean> {
    const startGeneration = this.startGenerations.get(sourceKey(source)) ?? 0;
    for (let attempt = 0; attempt < this.core.options.maxAttempts; attempt += 1) {
      if (await this.purgedSinceStart(source.space)) return false;
      const state = (await this.core.store.getWriter(source.space, source.repo)) ?? emptyWriterState(source.space, source.repo);
      if (state.generation !== startGeneration && isTombstone(state)) {
        this.dropped.add(source.repo);
        return false;
      }
      const before = attempt === 0 && firstRev !== undefined ? firstRev : await latestRev(client, source);
      const listed: Record<string, StoredRecord[]> = {};
      const coverage: Record<string, Coverage> = {};
      const failed: Array<{ collection: string; error: unknown }> = [];
      const reservations: Array<() => void> = [];
      try {
        // The collections are listed side by side inside the one bracket, and all settle before anything is rethrown, so no
        // listing is still reserving room after the refresh gave up.
        const settled = await Promise.allSettled(this.collectionsOf(state).map(async ([collection, strategy]) => {
          const downTo = collection === this.input.window ? this.input.before?.key ?? this.core.windowFloor(source.space, collection) ?? null : null;
          return { collection, strategy, result: await this.list(client, source, collection, strategy, downTo, reservations) };
        }));
        const reads = this.collectionsOf(state);
        for (const [index, outcome] of settled.entries()) {
          const [collection, strategy] = reads[index]!;
          if (outcome.status === "fulfilled") {
            listed[collection] = outcome.value.result.records;
            coverage[collection] = outcome.value.result.coverage;
            continue;
          }
          const error = outcome.reason;
          if (strategy !== "all" || error instanceof SyncStoreError || error instanceof SpaceCredentialError || !classifyRepoFailure(error)) throw error;
          if (this.input.required?.includes(source.repo)) throw error;
          if (isCredentialRefused(error)) this.core.credentials.drop(source.space);
          failed.push({ collection, error });
          listed[collection] = [];
        }
        const after = await latestRev(client, source);
        if (before !== after) continue;
        const nextCoverage = { ...state.coverage, ...coverage };
        for (const { collection } of failed) delete nextCoverage[collection];
        const committed = await this.core.store.commit({
          space: source.space, repo: source.repo, expectedGeneration: state.generation, rev: after, epoch: await this.epochs.get(source.space),
          next: { syncedRev: after, checkedAt: this.core.now(), stale: false, coverage: nextCoverage },
          replace: listed,
        });
        if (!committed) continue;
        for (const [collection, records] of Object.entries(listed)) (await this.budget(source.space, collection)).set(source.repo, records.length);
        for (const { error } of failed) {
          const failure = classifyRepoFailure(error)!;
          this.partial.set(source.repo, { did: source.repo, reason: failure.reason, permanent: failure.permanent });
        }
        this.core.markChecked(source);
        this.checkedHere.add(sourceKey(source));
        return true;
      } finally {
        for (const release of reservations.splice(0)) release();
      }
    }
    if (!(await this.purgedSinceStart(source.space))) this.changing.add(source.repo);
    return false;
  }

  /** Extends what is held of the window downward, between two revision reads that both equal the held revision. */
  private async backfill(source: Source): Promise<boolean> {
    const window = this.input.window;
    const state = await this.core.store.getWriter(source.space, source.repo);
    const coverage = state?.coverage[window];
    const client = await this.core.credentials.clientFor(source.space, source.repo);
    if (!state || !coverage || coverage.complete || coverage.cursor === null || state.syncedRev === null) return this.refresh(source, client);
    const before = await latestRev(client, source);
    if (before !== state.syncedRev) return this.refresh(source, client, before);
    const budget = await this.budget(source.space, window);
    // A backfill adds to what the writer holds, so its room is the bound less everyone's held records, its own included.
    const held = budget.count(source.repo);
    let room = budget.allowance(source.repo) - held;
    while (room <= 0 && budget.othersFetching(source.repo)) {
      await budget.settled();
      room = budget.allowance(source.repo) - held;
    }
    const limit = Math.max(1, Math.min(this.core.options.pageSize, room));
    if (room > 0) budget.fetch(source.repo, limit);
    let page: Awaited<ReturnType<typeof listPage>>;
    let after: string;
    try {
      page = await listPage(client, source, window, coverage.cursor, limit);
      // The page counts against the bound until it is committed or given up, so no waiting listing claims its room.
      budget.fetched(source.repo, room > 0 ? page.records.length : 0);
      after = await latestRev(client, source);
    } catch (error) {
      budget.release(source.repo);
      throw error;
    }
    if (after !== before) {
      budget.release(source.repo);
      return this.refresh(source, client, after);
    }
    if (room <= 0) {
      budget.release(source.repo);
      // At the bound: one record past it means the history was cut short, none means the writer simply ended there.
      if (page.records.length > 0) {
        this.cut.add(window);
        return false;
      }
      return this.core.store.commit({
        space: source.space, repo: source.repo, expectedGeneration: state.generation, rev: after, epoch: await this.epochs.get(source.space),
        next: { ...stateFields(state), coverage: { ...state.coverage, [window]: { ...coverage, complete: true, cursor: null } } },
      });
    }
    try {
      const committed = await this.core.store.commit({
        space: source.space, repo: source.repo, expectedGeneration: state.generation, rev: after, epoch: await this.epochs.get(source.space),
        next: {
          ...stateFields(state),
          coverage: { ...state.coverage, [window]: { strategy: "window", lowest: lowestKey(page.records) ?? coverage.lowest, complete: !page.cursor, cursor: page.cursor ?? null } },
        },
        upsert: page.records,
      });
      if (committed) budget.set(source.repo, held + page.records.length);
      return committed;
    } finally {
      budget.release(source.repo);
    }
  }

  /** The collections a refresh lists: everything held of the writer, so its revision covers all of it, and what this read needs. */
  private collectionsOf(state: WriterState): Array<[string, Coverage["strategy"]]> {
    const reads = new Map(this.strategies);
    for (const [collection, coverage] of Object.entries(state.coverage)) if (!reads.has(collection)) reads.set(collection, coverage.strategy);
    return [...reads];
  }

  /**
   * Lists one collection of a writer under the per-space bound, reserving each page's room before it is fetched so that
   * concurrent listings cannot together pass the bound. The reservation is released when the refresh commits or gives up.
   */
  private async list(
    client: AtprotoClient,
    source: Source,
    collection: string,
    strategy: Coverage["strategy"],
    downTo: string | null,
    reservations: Array<() => void>,
  ): Promise<{ records: StoredRecord[]; coverage: Coverage }> {
    const budget = await this.budget(source.space, collection);
    const base = budget.count(source.repo);
    reservations.push(() => budget.release(source.repo));
    const records: StoredRecord[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const room = budget.allowance(source.repo) - records.length;
      if (room <= 0 && budget.othersFetching(source.repo)) {
        await budget.settled();
        continue;
      }
      const pageSize = strategy === "all" ? this.core.options.allPageSize : downTo === null ? this.firstPage : this.core.options.pageSize;
      const limit = Math.max(1, Math.min(pageSize, room));
      // This listing replaces what the writer held, so it needs room only past its held count.
      if (room > 0) budget.fetch(source.repo, records.length + limit - base);
      let page: Awaited<ReturnType<typeof listPage>>;
      try {
        page = await listPage(client, source, collection, cursor, limit, seenCursors);
      } finally {
        budget.fetched(source.repo, records.length - base);
      }
      if (room <= 0) {
        // At the bound: one record past it means the scan was cut short, none means the writer simply ended there.
        if (page.records.length > 0) this.cut.add(collection);
        const complete = page.records.length === 0;
        return { records, coverage: { strategy, lowest: lowestKey(records), complete, cursor: complete ? null : cursor ?? null } };
      }
      records.push(...page.records);
      budget.fetched(source.repo, records.length - base);
      cursor = page.cursor;
      const lowest = lowestKey(records);
      if (!cursor) return { records, coverage: { strategy, lowest, complete: true, cursor: null } };
      if (strategy === "window" && (downTo === null || (lowest !== null && lowest <= downTo))) {
        return { records, coverage: { strategy, lowest, complete: false, cursor } };
      }
    }
  }

  /** The per-space bound of one collection, counted per writer in that space. */
  private budget(space: string, collection: string): Promise<Budget> {
    const key = `${space} ${collection}`;
    let budget = this.budgets.get(key);
    if (!budget) {
      budget = this.core.store.counts(space, collection).then((counts) => new Budget(this.core.options.maxRecordsPerCollection, counts));
      this.budgets.set(key, budget);
    }
    return budget;
  }

  private async purgedSinceStart(space: string): Promise<boolean> {
    return (await this.epochs.get(space)) !== (await this.core.store.epoch(space));
  }

  /**
   * Runs one writer's work. A failure that is the writer's own sets it aside for this read: permanently (its records are
   * dropped, so they count toward no limit and are not shown) or until its host recovers (what is held stays and is shown).
   * A failure of this app's own store, or the authority refusing the reader a credential, still fails the read.
   */
  private async guard(source: Source, run: () => Promise<boolean>): Promise<boolean> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof SyncStoreError || error instanceof SpaceCredentialError) throw error;
      if (isCredentialRefused(error)) this.core.credentials.drop(source.space);
      if (this.input.required?.includes(source.repo)) throw error;
      const failure = classifyRepoFailure(error);
      if (!failure) throw error;
      this.aside.set(source.repo, { did: source.repo, reason: failure.reason, permanent: failure.permanent });
      if (failure.permanent) await this.core.store.purgeWriter(source.space, source.repo);
      return false;
    }
  }
}

/**
 * Records held per collection per space, counted per writer, so scans stop at the bound. A listing counts what it has listed
 * and not yet committed, and reserves each page's room while the page is fetched, so listings running at once cannot
 * together pass the bound. A listing that finds no room while others are fetching waits for those fetches instead of
 * reporting a cut their reservations may not need; it waits only on fetches in flight, which always end, so two waiting
 * listings never wait on each other.
 */
class Budget {
  /** Listed by a refresh or backfill and not yet committed. */
  private readonly listing = new Map<string, number>();
  /** Room reserved for a page being fetched. */
  private readonly fetching = new Map<string, number>();
  private waiting: Array<() => void> = [];

  constructor(private readonly max: number, private readonly held: Map<string, number>) {}

  /** How many records `repo` may hold, given what every other writer holds, is listing, or is fetching. */
  allowance(repo: string): number {
    let others = 0;
    for (const counts of [this.held, this.listing, this.fetching]) for (const [did, count] of counts) if (did !== repo) others += count;
    return this.max - others;
  }

  count(repo: string): number {
    return this.held.get(repo) ?? 0;
  }

  set(repo: string, count: number): void {
    this.held.set(repo, count);
  }

  fetch(repo: string, room: number): void {
    this.fetching.set(repo, Math.max(0, room));
  }

  /** The page arrived: its reservation becomes what the writer has listed beyond its held records. */
  fetched(repo: string, listedBeyondHeld: number): void {
    this.fetching.delete(repo);
    this.listing.set(repo, Math.max(0, listedBeyondHeld));
    this.wake();
  }

  release(repo: string): void {
    this.fetching.delete(repo);
    this.listing.delete(repo);
    this.wake();
  }

  othersFetching(repo: string): boolean {
    for (const [did, count] of this.fetching) if (did !== repo && count > 0) return true;
    return false;
  }

  /** Resolves when a fetch ends or a listing is released. */
  settled(): Promise<void> {
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private wake(): void {
    const waiting = this.waiting;
    this.waiting = [];
    for (const wake of waiting) wake();
  }
}

async function listPage(
  client: AtprotoClient,
  source: Source,
  collection: string,
  cursor: string | undefined | null,
  limit: number,
  seenCursors = new Set<string>(),
): Promise<{ records: StoredRecord[]; cursor?: string }> {
  const page = await client.query<{ cursor?: string; records: Array<{ rkey: string; cid?: string; value?: Record<string, unknown> }> }>(
    "com.atproto.space.listRecords", { space: source.space, repo: source.repo, collection, limit, cursor: cursor ?? undefined },
  );
  if (cursor) seenCursors.add(cursor);
  assertBoundedRecordPage(page, { collection, limit, cursor: cursor ?? undefined, seenCursors });
  if (page.cursor) seenCursors.add(page.cursor);
  const records: StoredRecord[] = [];
  for (const record of page.records) {
    if (!record.value) throw new Error("PDS record page contains a malformed record.");
    const cid = record.cid ?? "";
    if (cid.length > 0 && !(await verifyRecordCid(collection, record.rkey, record.value, cid))) {
      throw new SpaceMacError(`Record ${collection}/${record.rkey} for ${source.repo} failed CID verification.`);
    }
    records.push({
      space: source.space,
      repo: source.repo,
      collection,
      rkey: record.rkey,
      uri: spaceRecordUri(source.space, source.repo, collection, record.rkey),
      cid,
      value: record.value,
    });
  }
  return {
    records,
    ...(page.cursor ? { cursor: page.cursor } : {}),
  };
}

/** The writer's revision in the space, read at its own host with a verified MAC. */
async function latestRev(client: AtprotoClient, source: Source): Promise<string> {
  const result = await client.query<{ commit?: { rev?: unknown } }>("com.atproto.space.getLatestCommit", { space: source.space, repo: source.repo });
  if (typeof result?.commit?.rev !== "string") throw new XrpcError(502, "The host answered a revision read without a revision.", "InvalidResponse");
  return result.commit.rev;
}

function stateFields(state: WriterState): Omit<WriterState, "space" | "repo" | "generation"> {
  return {
    syncedRev: state.syncedRev,
    checkedAt: state.checkedAt,
    stale: state.stale,
    coverage: state.coverage,
    ...(state.setHash !== undefined ? { setHash: state.setHash } : {}),
    ...(state.commitDigest !== undefined ? { commitDigest: state.commitDigest } : {}),
  };
}

function itemOf(record: StoredRecord): { key: string; uri: string } {
  return { key: record.rkey, uri: record.uri };
}

function lowestKey(records: readonly StoredRecord[]): string | null {
  return records.reduce<string | null>((low, record) => (low === null || record.rkey < low ? record.rkey : low), null);
}

function maxOf(current: string | null, values: readonly string[]): string | null {
  return values.reduce<string | null>((max, value) => (max === null || value > max ? value : max), current);
}

function authorityOf(space: string): string {
  const parsed = parseSpaceUri(space);
  if (!parsed) throw new Error("Invalid space URI.");
  return parsed.authorityDid;
}

function sourceKey(source: { space: string; repo: string }): string {
  return `${source.space} ${source.repo}`;
}

/** A writer state a purge left: nothing held, never synced, not marked stale by a hint. */
function isTombstone(state: WriterState): boolean {
  return state.syncedRev === null && Object.keys(state.coverage).length === 0 && !state.stale;
}

type RawRepoOp = {
  rev: string;
  collection: string;
  rkey: string;
  cid: string | null;
  prev: string | null;
  value?: unknown;
};

type TouchedRepoPath = {
  path: string;
  collection: string;
  rkey: string;
  finalCid: Cid | null;
  finalValue?: Record<string, unknown>;
  finalByteLength?: number;
  finalRev: string;
  hadBefore: boolean;
  sawCreateOrDelete: boolean;
  orderIndex: number;
};

class DeltaFallbackError extends Error {}

class UnsignedEmptyRepoOpsError extends Error {}

class ChangingWriterError extends Error {
  constructor(readonly repo: string) {
    super(`Writer ${repo} kept changing during verification bracket.`);
  }
}

async function replayValidatedRepoOps(input: {
  space: string;
  repo: string;
  ops: readonly RawRepoOp[];
  commit: Commit;
  baseRev: string | null;
  baseSetHash: Uint8Array;
  baseCids: ReadonlyMap<string, Cid>;
  maxRecords?: number;
}): Promise<
  | { ok: false; reason: string; exceededLimit?: "records" }
  | { ok: true; setHash: Uint8Array; stagedCids: Map<string, Cid>; touched: TouchedRepoPath[] }
> {
  if (input.ops.length === 0) {
    if (input.baseRev !== null && input.commit.rev !== input.baseRev) {
      return { ok: false, reason: "Repository history reset (clearRecords/importRepo/pruned oplog)." };
    }
    if (!RepoCommit.fromState(input.baseSetHash).matches(input.commit)) {
      return {
        ok: false,
        reason: input.baseRev === null
          ? "Repository holds records without oplog history."
          : "Repository commit digest diverged from baseline.",
      };
    }
    if (input.maxRecords !== undefined && input.baseCids.size > input.maxRecords) {
      return { ok: false, exceededLimit: "records", reason: "Repository exceeds maxRecords limit." };
    }
    return { ok: true, setHash: new Uint8Array(input.baseSetHash), stagedCids: new Map(input.baseCids), touched: [] };
  }

  const replayed = RepoCommit.fromState(input.baseSetHash);
  const stagedCids = new Map(input.baseCids);
  const pathMeta = new Map<string, {
    collection: string;
    rkey: string;
    hadBefore: boolean;
    sawCreateOrDelete: boolean;
    orderIndex: number;
    finalCid: Cid | null;
    finalOp?: RawRepoOp;
  }>();
  let lastRev: string | null = null;

  for (let index = 0; index < input.ops.length; index += 1) {
    const rawOp = input.ops[index]!;
    if (!isValidRawOp(rawOp)) return { ok: false, reason: "Malformed op entry in listRepoOps." };
    if (input.baseRev !== null && rawOp.rev <= input.baseRev) {
      return { ok: false, reason: "listRepoOps rev did not advance past baseline." };
    }
    if (lastRev !== null && rawOp.rev < lastRev) {
      return { ok: false, reason: "listRepoOps returned decreasing rev." };
    }
    lastRev = rawOp.rev;

    const nextCid = rawOp.cid === null ? null : parseCidSafe(rawOp.cid);
    const prevCid = rawOp.prev === null ? null : parseCidSafe(rawOp.prev);
    if ((rawOp.cid !== null && !nextCid) || (rawOp.prev !== null && !prevCid) || (nextCid === null && prevCid === null)) {
      return { ok: false, reason: "Invalid CID in listRepoOps." };
    }

    const path = pathKey(rawOp.collection, rawOp.rkey);
    const staged = stagedCids.get(path) ?? null;
    if (!isValidPrevTransition(staged, prevCid, nextCid)) {
      return { ok: false, reason: "Oplog prev-chain discontinuity (pruned or reset)." };
    }

    replayed.applyOp({ collection: rawOp.collection as never, rkey: rawOp.rkey as never, cid: nextCid, prev: prevCid });
    const existing = pathMeta.get(path) ?? {
      collection: rawOp.collection,
      rkey: rawOp.rkey,
      hadBefore: input.baseCids.has(path),
      sawCreateOrDelete: false,
      orderIndex: index,
      finalCid: null,
    };
    if (nextCid === null) {
      stagedCids.delete(path);
      existing.sawCreateOrDelete = true;
      existing.finalCid = null;
      existing.finalOp = rawOp;
    } else {
      stagedCids.set(path, nextCid);
      if (prevCid === null) {
        existing.sawCreateOrDelete = true;
        existing.orderIndex = index;
      }
      existing.finalCid = nextCid;
      existing.finalOp = rawOp;
    }
    pathMeta.set(path, existing);
  }

  if (!replayed.matches(input.commit)) {
    return { ok: false, reason: "Oplog replay commit digest mismatch." };
  }
  const rebuiltState = RepoCommit.fromRecords(
    [...stagedCids.entries()].map(([path, cid]) => {
      const [collection, rkey] = splitPathKey(path);
      return { collection: collection as never, rkey: rkey as never, cid };
    }),
  ).setHash.state();
  const replayedState = replayed.setHash.state();
  if (!bytesEqual(rebuiltState, replayedState)) {
    return { ok: false, reason: "Materialized LtHash mismatch after oplog replay." };
  }
  if (input.maxRecords !== undefined && stagedCids.size > input.maxRecords) {
    return { ok: false, exceededLimit: "records", reason: "Repository exceeds maxRecords limit." };
  }

  const touched: TouchedRepoPath[] = [];
  for (const [path, meta] of pathMeta) {
    const finalOp = meta.finalOp!;
    if (meta.finalCid === null) {
      touched.push({
        path,
        collection: meta.collection,
        rkey: meta.rkey,
        finalCid: null,
        finalRev: finalOp.rev,
        hadBefore: meta.hadBefore,
        sawCreateOrDelete: meta.sawCreateOrDelete,
        orderIndex: meta.orderIndex,
      });
      continue;
    }
    if (!isPlainRecord(finalOp.value)) {
      return { ok: false, reason: "Surviving op missing inlined value." };
    }
    const verifiedCid = await verifyRecordCidWithSize(meta.collection, meta.rkey, finalOp.value, meta.finalCid.toString());
    if (!verifiedCid.ok) {
      throw new SpaceMacError(`Record ${meta.collection}/${meta.rkey} for ${input.repo} failed CID verification.`);
    }
    touched.push({
      path,
      collection: meta.collection,
      rkey: meta.rkey,
      finalCid: meta.finalCid,
      finalValue: finalOp.value,
      finalByteLength: verifiedCid.byteLength,
      finalRev: finalOp.rev,
      hadBefore: meta.hadBefore,
      sawCreateOrDelete: meta.sawCreateOrDelete,
      orderIndex: meta.orderIndex,
    });
  }

  return { ok: true, setHash: replayedState, stagedCids, touched };
}

async function latestCommit(client: AtprotoClient, space: string, repo: string): Promise<Commit> {
  const result = await client.query<{ commit?: unknown }>("com.atproto.space.getLatestCommit", { space, repo });
  const commit = decodeCommitResponse(result?.commit, space, repo);
  if (!commit) throw new XrpcError(502, "The host answered getLatestCommit without a valid commit.", "InvalidResponse");
  return commit;
}

function decodeCommitResponse(raw: unknown, expectedSpace: string, expectedRepo: string): Commit | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const candidate = raw as { ver?: unknown; repo?: unknown; space?: unknown; rev?: unknown; data?: unknown };
  if (typeof candidate.ver !== "number" || typeof candidate.repo !== "string" || typeof candidate.space !== "string" || typeof candidate.rev !== "string") {
    return null;
  }
  if (candidate.space !== expectedSpace || candidate.repo !== expectedRepo) return null;
  const data = decodeBytes(candidate.data);
  if (!data || data.length !== COMMIT_DIGEST_BYTES) return null;
  return { ver: candidate.ver, repo: candidate.repo, space: candidate.space, rev: candidate.rev, data } as Commit;
}

function decodeBytes(raw: unknown): Uint8Array | null {
  if (raw instanceof Uint8Array) return raw;
  if (!raw || typeof raw !== "object") return null;
  const b64 = (raw as { $bytes?: unknown }).$bytes;
  if (typeof b64 !== "string") return null;
  try {
    const normalized = b64.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function isUnsupportedEndpointError(error: unknown): boolean {
  if (!(error instanceof XrpcError)) return false;
  return error.status === 404 || error.status === 501 || error.code === "MethodNotImplemented" || error.code === "MethodNotFound";
}

function buildFullReplaceMap(
  space: string,
  repo: string,
  records: ReadonlyArray<{ collection: string; rkey: string; cid: string; value: Record<string, unknown> }>,
  collections: readonly string[],
): Record<string, StoredRecord[]> {
  const replace: Record<string, StoredRecord[]> = {};
  for (const collection of collections) replace[collection] = [];
  for (const entry of records) {
    const list = replace[entry.collection] ?? [];
    list.push({
      space,
      repo,
      collection: entry.collection,
      rkey: entry.rkey,
      uri: spaceRecordUri(space, repo, entry.collection, entry.rkey),
      cid: entry.cid,
      value: entry.value,
    });
    replace[entry.collection] = list;
  }
  return replace;
}

function buildVerifiedCoverage(recordsByCollection: Record<string, StoredRecord[]>, collections: readonly string[]): Record<string, Coverage> {
  const coverage: Record<string, Coverage> = {};
  for (const collection of collections) {
    const records = recordsByCollection[collection] ?? [];
    coverage[collection] = { strategy: "all", lowest: lowestKey(records), complete: true, cursor: null };
  }
  for (const [collection, records] of Object.entries(recordsByCollection)) {
    if (records.length === 0 || coverage[collection] !== undefined) continue;
    coverage[collection] = { strategy: "all", lowest: lowestKey(records), complete: true, cursor: null };
  }
  return coverage;
}

function allPersistedCollectionsCovered(state: WriterState, collections: readonly string[]): boolean {
  for (const collection of collections) {
    const entry = state.coverage[collection];
    if (!entry || entry.strategy !== "all" || !entry.complete) return false;
  }
  for (const entry of Object.values(state.coverage)) {
    if (!entry.complete) return false;
  }
  return true;
}

function hasVerifiedSetHash(state: WriterState): boolean {
  return state.setHash instanceof Uint8Array && state.setHash.length === LTHASH_STATE_BYTES;
}

function toDidSet(values: ReadonlySet<string> | readonly string[] | undefined): Set<string> | undefined {
  if (values === undefined) return undefined;
  return new Set(values);
}

function isValidPdsEndpointUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "https:") return true;
    if (parsed.protocol === "http:") {
      return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1" || parsed.hostname === "[::1]";
    }
    return false;
  } catch {
    return false;
  }
}

function isValidRawOp(op: unknown): op is RawRepoOp {
  if (!op || typeof op !== "object" || Array.isArray(op)) return false;
  const candidate = op as Record<string, unknown>;
  if (typeof candidate.rev !== "string" || candidate.rev.length === 0) return false;
  if (typeof candidate.collection !== "string" || candidate.collection.length === 0) return false;
  if (typeof candidate.rkey !== "string" || candidate.rkey.length === 0) return false;
  if (candidate.cid !== null && typeof candidate.cid !== "string") return false;
  if (candidate.prev !== null && typeof candidate.prev !== "string") return false;
  return true;
}

function isValidPrevTransition(staged: Cid | null, prev: Cid | null, next: Cid | null): boolean {
  if (next === null) {
    return staged !== null && prev !== null && staged.equals(prev);
  }
  if (prev === null) {
    return staged === null;
  }
  return staged !== null && staged.equals(prev);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathKey(collection: string, rkey: string): string {
  return `${collection}\0${rkey}`;
}

function splitPathKey(path: string): [string, string] {
  const sep = path.indexOf("\0");
  return [path.slice(0, sep), path.slice(sep + 1)];
}

function seenKeyOf(uri: string, cid: string): string {
  return `${uri}\0${cid}`;
}

function recordSeenKey(seen: Set<string>, key: string): void {
  if (seen.has(key)) return;
  seen.add(key);
  while (seen.size > MAX_OPS_SEEN_ENTRIES) {
    const oldest = seen.values().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
}

function mergeFollowQueues<T extends { aside?: SetAside; events: readonly RepoOpsEvent[] }>(
  batches: readonly T[],
): Array<{ batch: T; event: RepoOpsEvent }> {
  const cursors = batches
    .filter((batch) => !batch.aside && batch.events.length > 0)
    .map((batch) => ({ batch, index: 0 }));
  const merged: Array<{ batch: T; event: RepoOpsEvent }> = [];
  while (cursors.length > 0) {
    let bestPos = 0;
    for (let pos = 1; pos < cursors.length; pos += 1) {
      const candidate = cursors[pos]!.batch.events[cursors[pos]!.index]!;
      const best = cursors[bestPos]!.batch.events[cursors[bestPos]!.index]!;
      if (candidate.rkey < best.rkey || (candidate.rkey === best.rkey && candidate.uri < best.uri)) {
        bestPos = pos;
      }
    }
    const chosen = cursors[bestPos]!;
    merged.push({ batch: chosen.batch, event: chosen.batch.events[chosen.index]! });
    chosen.index += 1;
    if (chosen.index >= chosen.batch.events.length) cursors.splice(bestPos, 1);
  }
  return merged;
}

function reportFollowSetAside(
  _space: string,
  _labels: WindowLabels,
  setAside: readonly SetAside[],
  reportedAside: Set<string>,
  onError?: (error: unknown) => void,
): void {
  for (const aside of setAside) {
    if (reportedAside.has(aside.did)) continue;
    reportedAside.add(aside.did);
    onError?.(new Error(`${aside.did} could not be synced: ${aside.reason}.`));
  }
}

