import {
  cloneActivityState,
  cloneWriterState,
  commitAllowed,
  dedupeIds,
  emptyWriterState,
  mergeMonotonicClock,
  nextWriterState,
  SyncStoreError,
  type ActivityState,
  type ClockPatch,
  type ClockState,
  type IdentityEntry,
  type IdentityKind,
  type SpaceState,
  type StoredRecord,
  type SyncStore,
  type WriterCommit,
  type WriterState,
} from "./store";

/** A `SyncStore` held in memory: for DM spaces, which are never written to disk, and for tests. */
export class MemoryStore implements SyncStore {
  private readonly spaces = new Map<string, SpaceState>();
  private readonly writers = new Map<string, WriterState>();
  /** By space and collection, then by `repo rkey`. */
  private readonly held = new Map<string, Map<string, StoredRecord>>();
  private readonly purges = new Map<string, number>();
  private readonly identities = new Map<string, IdentityEntry>();
  private readonly clocks = new Map<string, ClockState>();
  private readonly activities = new Map<string, ActivityState>();
  private clears = 0;

  async getSpace(space: string): Promise<SpaceState | undefined> {
    return clone(this.spaces.get(space));
  }

  async putSpace(state: SpaceState): Promise<void> {
    this.spaces.set(state.space, clone(state));
  }

  async listSpaces(): Promise<SpaceState[]> {
    return [...this.spaces.values()].map((state) => clone(state));
  }

  async getWriter(space: string, repo: string): Promise<WriterState | undefined> {
    const state = this.writers.get(writerKey(space, repo));
    return state ? cloneWriterState(state) : undefined;
  }

  async listWriters(space: string): Promise<WriterState[]> {
    return [...this.writers.values()].filter((state) => state.space === space).map((state) => cloneWriterState(state));
  }

  async records(space: string, collection: string, repo?: string): Promise<StoredRecord[]> {
    const all = [...(this.held.get(collectionKey(space, collection))?.values() ?? [])];
    return (repo === undefined ? all : all.filter((record) => record.repo === repo)).map((record) => clone(record));
  }

  async getRecord(space: string, repo: string, collection: string, rkey: string): Promise<StoredRecord | undefined> {
    return clone(this.held.get(collectionKey(space, collection))?.get(recordKey(repo, rkey)));
  }

  async counts(space: string, collection: string): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const record of this.held.get(collectionKey(space, collection))?.values() ?? []) counts.set(record.repo, (counts.get(record.repo) ?? 0) + 1);
    return counts;
  }

  async epoch(space: string): Promise<string> {
    return this.epochOf(space);
  }

  /** The whole check and write run without yielding, so two commits cannot both pass the same compare-and-set. */
  async commit(change: WriterCommit): Promise<boolean> {
    const key = writerKey(change.space, change.repo);
    const current = this.writers.get(key);
    if (change.epoch !== undefined && change.epoch !== this.epochOf(change.space)) return false;
    if (!commitAllowed(current, change)) return false;

    // Validate and prepare all mutations before applying any so a validation failure leaves the store unchanged.
    let next: WriterState;
    let nextClock: { key: string; state: ClockState } | undefined;
    let clonedReplace: Array<[string, StoredRecord[]]>;
    let clonedUpsert: StoredRecord[];
    try {
      next = nextWriterState(current, change);
      nextClock = change.clock
        ? (() => {
            const scope = change.clock.scope ?? "";
            const ck = compositeKey(change.clock.accountDid, scope);
            return { key: ck, state: mergeMonotonicClock(change.clock.accountDid, scope, this.clocks.get(ck), change.clock) };
          })()
        : undefined;
      clonedReplace = Object.entries(change.replace ?? {}).map(([collection, records]) => [
        collection,
        records.map((record) => clone(record)),
      ]);
      clonedUpsert = (change.upsert ?? []).map((record) => clone(record));
    } catch (error) {
      throw asStoreError(error);
    }

    for (const [collection, records] of clonedReplace) {
      const bucket = this.bucket(change.space, collection);
      for (const [held, record] of bucket) if (record.repo === change.repo) bucket.delete(held);
      for (const record of records) bucket.set(recordKey(record.repo, record.rkey), record);
    }
    for (const record of clonedUpsert) this.bucket(record.space, record.collection).set(recordKey(record.repo, record.rkey), record);
    for (const { collection, rkey } of change.remove ?? []) this.bucket(change.space, collection).delete(recordKey(change.repo, rkey));
    this.writers.set(key, next);
    if (nextClock) this.clocks.set(nextClock.key, nextClock.state);
    return true;
  }

  private epochOf(space: string): string {
    return `${this.clears}:${this.purges.get(space) ?? 0}`;
  }

  async purgeWriter(space: string, repo: string): Promise<void> {
    for (const [key, bucket] of this.held) {
      if (!key.startsWith(`${space} `)) continue;
      for (const [held, record] of bucket) if (record.repo === repo) bucket.delete(held);
    }
    const current = this.writers.get(writerKey(space, repo));
    this.writers.set(writerKey(space, repo), emptyWriterState(space, repo, (current?.generation ?? 0) + 1));
  }

  async purgeSpace(space: string): Promise<void> {
    for (const key of [...this.held.keys()]) if (key.startsWith(`${space} `)) this.held.delete(key);
    for (const [key, state] of this.writers) if (state.space === space) this.writers.set(key, emptyWriterState(space, state.repo, state.generation + 1));
    for (const [key, entry] of this.activities) if (entry.space === space) this.activities.delete(key);
    for (const [key, entry] of this.clocks) if (entry.scope === space) this.clocks.delete(key);
    this.spaces.delete(space);
    this.purges.set(space, (this.purges.get(space) ?? 0) + 1);
  }

  async getIdentity(kind: IdentityKind, did: string): Promise<IdentityEntry | undefined> {
    return clone(this.identities.get(`${kind} ${did}`));
  }

  async putIdentity(entry: IdentityEntry): Promise<void> {
    this.identities.set(`${entry.kind} ${entry.did}`, clone(entry));
  }

  async getClock(accountDid: string, scope = ""): Promise<ClockState | undefined> {
    return clone(this.clocks.get(compositeKey(accountDid, scope)));
  }

  async updateClock(
    accountDid: string,
    updater: ClockPatch | ((current: ClockState | undefined) => ClockPatch),
    scope = "",
  ): Promise<ClockState> {
    try {
      const key = compositeKey(accountDid, scope);
      const current = this.clocks.get(key);
      const patch = typeof updater === "function" ? updater(clone(current)) : updater;
      const next = mergeMonotonicClock(accountDid, scope, current, patch);
      this.clocks.set(key, next);
      return clone(next);
    } catch (error) {
      throw asStoreError(error);
    }
  }

  async getActivityState(accountDid: string, space: string): Promise<ActivityState | undefined> {
    return clone(this.activities.get(compositeKey(accountDid, space)));
  }

  async putActivityState(state: ActivityState): Promise<void> {
    const next = cloneActivityState(state);
    this.activities.set(compositeKey(next.accountDid, next.space), next);
  }

  async markActivitySeen(accountDid: string, space: string, eventIds: readonly string[], updatedAt = Date.now()): Promise<ActivityState> {
    return this.updateActivityIds(accountDid, space, "seenIds", eventIds, updatedAt);
  }

  async dismissActivity(accountDid: string, space: string, eventIds: readonly string[], updatedAt = Date.now()): Promise<ActivityState> {
    return this.updateActivityIds(accountDid, space, "dismissedIds", eventIds, updatedAt);
  }

  private updateActivityIds(
    accountDid: string,
    space: string,
    field: "seenIds" | "dismissedIds",
    eventIds: readonly string[],
    updatedAt: number,
  ): ActivityState {
    const key = compositeKey(accountDid, space);
    const current = this.activities.get(key);
    const next = cloneActivityState({
      accountDid,
      space,
      seenIds: field === "seenIds" ? dedupeIds([...(current?.seenIds ?? []), ...eventIds]) : current?.seenIds ?? [],
      dismissedIds: field === "dismissedIds" ? dedupeIds([...(current?.dismissedIds ?? []), ...eventIds]) : current?.dismissedIds ?? [],
      updatedAt: Math.max(current?.updatedAt ?? 0, updatedAt),
    });
    this.activities.set(key, next);
    return clone(next);
  }

  async clear(): Promise<void> {
    this.clears += 1;
    this.spaces.clear();
    this.writers.clear();
    this.held.clear();
    this.identities.clear();
    this.clocks.clear();
    this.activities.clear();
  }

  private bucket(space: string, collection: string): Map<string, StoredRecord> {
    const key = collectionKey(space, collection);
    let bucket = this.held.get(key);
    if (!bucket) this.held.set(key, bucket = new Map());
    return bucket;
  }
}

function writerKey(space: string, repo: string): string {
  return `${space} ${repo}`;
}

function collectionKey(space: string, collection: string): string {
  return `${space} ${collection}`;
}

function recordKey(repo: string, rkey: string): string {
  return `${repo} ${rkey}`;
}

function compositeKey(first: string, second: string): string {
  return `${first}\0${second}`;
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

function asStoreError(error: unknown): SyncStoreError {
  return error instanceof SyncStoreError ? error : new SyncStoreError("The local store failed.", { cause: error });
}
