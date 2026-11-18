import { commitAllowed, emptyWriterState, nextWriterState, type IdentityEntry, type IdentityKind, type SpaceState, type StoredRecord, type SyncStore, type WriterCommit, type WriterState } from "./store";

/** A `SyncStore` held in memory: for DM spaces, which are never written to disk, and for tests. */
export class MemoryStore implements SyncStore {
  private readonly spaces = new Map<string, SpaceState>();
  private readonly writers = new Map<string, WriterState>();
  /** By space and collection, then by `repo rkey`. */
  private readonly held = new Map<string, Map<string, StoredRecord>>();
  private readonly purges = new Map<string, number>();
  private readonly identities = new Map<string, IdentityEntry>();
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
    return clone(this.writers.get(writerKey(space, repo)));
  }

  async listWriters(space: string): Promise<WriterState[]> {
    return [...this.writers.values()].filter((state) => state.space === space).map((state) => clone(state));
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
    const next = nextWriterState(current, change);
    for (const [collection, records] of Object.entries(change.replace ?? {})) {
      const bucket = this.bucket(change.space, collection);
      for (const [held, record] of bucket) if (record.repo === change.repo) bucket.delete(held);
      for (const record of records) bucket.set(recordKey(record.repo, record.rkey), clone(record));
    }
    for (const record of change.upsert ?? []) this.bucket(record.space, record.collection).set(recordKey(record.repo, record.rkey), clone(record));
    for (const { collection, rkey } of change.remove ?? []) this.bucket(change.space, collection).delete(recordKey(change.repo, rkey));
    this.writers.set(key, clone(next));
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
    this.spaces.delete(space);
    this.purges.set(space, (this.purges.get(space) ?? 0) + 1);
  }

  async getIdentity(kind: IdentityKind, did: string): Promise<IdentityEntry | undefined> {
    return clone(this.identities.get(`${kind} ${did}`));
  }

  async putIdentity(entry: IdentityEntry): Promise<void> {
    this.identities.set(`${entry.kind} ${entry.did}`, clone(entry));
  }

  async clear(): Promise<void> {
    this.clears += 1;
    this.spaces.clear();
    this.writers.clear();
    this.held.clear();
    this.identities.clear();
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

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}
