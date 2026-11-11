import { assertBoundedRecordPage, listBoundedRepos, listReposSince } from "@/atproto/record-pages";
import { classifyRepoFailure } from "@/atproto/repo-failure";
import { isCredentialRefused, SpaceCredentialError } from "@/atproto/space-credential-core";
import { XrpcError, type AtprotoClient } from "@/atproto/xrpc";
import { mapLimited } from "@/lib/map-limited";
import { parseSpaceUri, spaceRecordUri } from "@/protocol/keys";
import type { CredentialCache } from "./credentials";
import { compareItems, isAfterCursor, type Cursor } from "./merge";
import { emptyWriterState, SyncStoreError, type Coverage, type ListedWriter, type SpaceState, type StoredRecord, type SyncStore, type WriterState } from "./store";
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

export class SyncCore {
  readonly options: SyncOptions;
  /** Spaces whose writer set this session read in full: each of their writers is checked at its host once in the session. */
  private readonly opened = new Set<string>();
  /** Writers checked at their host in this session. */
  private readonly checked = new Set<string>();
  /** The oldest key of the latest page each space's window showed in this session: how deep a refresh lists. */
  private readonly floors = new Map<string, string>();

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
    const authorityDid = authorityOf(space);
    const now = this.now();
    const stored = await this.deps.store.getSpace(space);
    const state: SpaceState = stored ?? { space, spaceRev: null, writers: [], writersListedAt: null, workspace: input.workspace ?? null, lastOpenedAt: now };
    const client = await this.deps.credentials.clientFor(space, authorityDid);
    const held = new Map((await this.deps.store.listWriters(space)).map((writer) => [writer.repo, writer]));
    // An own write the authority has not listed yet keeps the own writer a source, for at most one truth interval: after
    // that an account the authority still does not list (say, reduced to read-only) is out of view like anyone else (D14).
    const ownPending = state.ownWriteAt !== undefined && state.ownWriteAt !== null && now - state.ownWriteAt >= 0 && now - state.ownWriteAt < this.options.truthIntervalMs;
    const sinceListing = state.writersListedAt === null ? Number.POSITIVE_INFINITY : now - state.writersListedAt;
    let reported: Array<{ did: string; repoRev: string }>;
    if (!this.opened.has(space) || sinceListing < 0 || sinceListing >= this.options.truthIntervalMs) {
      const scan = await listBoundedRepos(client, { space, maxRepos: this.options.maxWriters });
      if (scan.truncated) throw new Error(`The space has more than ${this.options.maxWriters} writers, more than this client reads.`);
      const listed = new Set(scan.repos.map((repo) => repo.did));
      for (const writer of held.values()) {
        if (listed.has(writer.repo) || (writer.repo === this.did && ownPending)) continue;
        if (writer.syncedRev !== null || Object.keys(writer.coverage).length > 0) await this.deps.store.purgeWriter(space, writer.repo);
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
    const writers = [...state.writers].sort((left, right) => (left.repoRev < right.repoRev ? 1 : left.repoRev > right.repoRev ? -1 : 0));
    if (state.ownWriteAt !== null && state.ownWriteAt !== undefined && !ownListed) writers.unshift({ did: this.did, repoRev: ownRev ?? "" });
    return writers;
  }

  /** A hint that a writer moved: it is checked at its host before its records count as current again. */
  async markStale(space: string, repo: string): Promise<void> {
    await this.deps.store.commit({ space, repo, expectedGeneration: null, markStale: true });
  }

  /**
   * The account's own write, applied once its host accepted it; the own writer is checked again on the next read. The space
   * is recorded too, so the lifecycle rules find what a write left even when the space was never read.
   */
  async applyOwnWrite(source: Source, change: { upsert?: StoredRecord[]; remove?: Array<{ collection: string; rkey: string }> }, input: { workspace?: string | null } = {}): Promise<void> {
    const space = (await this.deps.store.getSpace(source.space))
      ?? { space: source.space, spaceRev: null, writers: [], writersListedAt: null, workspace: input.workspace ?? null, lastOpenedAt: this.now() };
    await this.deps.store.putSpace({ ...space, ownWriteAt: this.now() });
    await this.deps.store.commit({ space: source.space, repo: source.repo, expectedGeneration: null, markStale: true, upsert: change.upsert, remove: change.remove });
  }

  /** Reads one page of `window` across `sources`, refreshing and backfilling writers until the page is the true one. */
  async read(input: WindowRead): Promise<WindowResult> {
    return new ReadRun(this, input).execute();
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
  return {
    records: page.records.map((record) => {
      if (!record.value) throw new Error("PDS record page contains a malformed record.");
      return {
        space: source.space, repo: source.repo, collection, rkey: record.rkey,
        uri: spaceRecordUri(source.space, source.repo, collection, record.rkey), cid: record.cid ?? "", value: record.value,
      };
    }),
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
  return { syncedRev: state.syncedRev, checkedAt: state.checkedAt, stale: state.stale, coverage: state.coverage };
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
