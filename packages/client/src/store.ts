// What the sync core keeps between reads, behind one interface with two implementations: memory (DM spaces, tests) and
// IndexedDB (workspace, inbox and channel spaces in the browser). Every write that could race another reader of the same
// writer is a compare-and-set on the writer's generation, so a slow refresh cannot overwrite newer state, undo a local
// write, or bring back purged records.

/** One record as its writer's host listed it. */
export type StoredRecord = {
  space: string;
  repo: string;
  collection: string;
  rkey: string;
  uri: string;
  cid: string;
  value: Record<string, unknown>;
};

/**
 * How much of one collection the store holds for a writer, as one consistent state: every record with a key at or above
 * `lowest`, or every record when `complete`. `cursor` continues the host's listing below `lowest`. A writer with no state
 * for a collection holds nothing of it.
 */
export type Coverage = { strategy: "window" | "all"; lowest: string | null; complete: boolean; cursor: string | null };

export type WriterState = {
  space: string;
  repo: string;
  /** The revision every held collection was listed at; null when nothing was synced or the writer has no repo yet. */
  syncedRev: string | null;
  /** Advanced by every committed refresh, local write, hint and purge. */
  generation: number;
  /** When the writer's revision was last read at its own host. */
  checkedAt: number | null;
  /** A hint or a local write says the held state may be behind the host. */
  stale: boolean;
  coverage: Record<string, Coverage>;
};

export type ListedWriter = { did: string; repoRev: string };

export type SpaceState = {
  space: string;
  /** The highest space revision `listRepos` reported, the cursor for the next hint. */
  spaceRev: string | null;
  /** The writer set from the last full `listRepos`, and when it was read. */
  writers: ListedWriter[];
  writersListedAt: number | null;
  /** The workspace a channel or inbox belongs to, so losing the workspace drops it too. */
  workspace: string | null;
  lastOpenedAt: number;
  /** When the account last wrote here and the authority had not yet listed the write; absent when nothing is pending. */
  ownWriteAt?: number | null;
};

/** A DID's PDS host, or its `#atproto_kem` key, as its DID document said when it was resolved. */
export type IdentityKind = "pds" | "kem";
export type IdentityEntry = { kind: IdentityKind; did: string; value: string; resolvedAt: number };

export type WriterCommit = {
  space: string;
  repo: string;
  /** The generation the change was computed from; null applies unconditionally (a local write, a hint, a purge). */
  expectedGeneration: number | null;
  /** The change is refused when the stored revision is newer than this one. */
  rev?: string | null;
  /** The space epoch the change was computed under; a purge since then refuses it, so a read cannot bring a purged space back. */
  epoch?: string;
  /** The writer's state after the change; omitted with `markStale`, which keeps the stored state and only marks it stale. */
  next?: Omit<WriterState, "space" | "repo" | "generation">;
  /** Marks the stored state stale, atomically: a hint, or an own write applied before its host's listing shows it. */
  markStale?: boolean;
  /** Collections whose held records are replaced wholesale by these (a refresh). */
  replace?: Record<string, StoredRecord[]>;
  upsert?: StoredRecord[];
  remove?: Array<{ collection: string; rkey: string }>;
};

export interface SyncStore {
  getSpace(space: string): Promise<SpaceState | undefined>;
  putSpace(state: SpaceState): Promise<void>;
  listSpaces(): Promise<SpaceState[]>;
  getWriter(space: string, repo: string): Promise<WriterState | undefined>;
  listWriters(space: string): Promise<WriterState[]>;
  /** The held records of one collection in a space, optionally of one writer. */
  records(space: string, collection: string, repo?: string): Promise<StoredRecord[]>;
  getRecord(space: string, repo: string, collection: string, rkey: string): Promise<StoredRecord | undefined>;
  /** How many records of one collection in a space are held, per writer. */
  counts(space: string, collection: string): Promise<Map<string, number>>;
  /** Advanced by every purge of the space and by `clear`. */
  epoch(space: string): Promise<string>;
  /** Applies `change` atomically, and only if its epoch, generation and revision checks pass. Returns whether it applied. */
  commit(change: WriterCommit): Promise<boolean>;
  /** Drops a writer's records; its state becomes an empty tombstone with an advanced generation. */
  purgeWriter(space: string, repo: string): Promise<void>;
  /** Drops a space's records and state; its writers become tombstones with advanced generations. */
  purgeSpace(space: string): Promise<void>;
  getIdentity(kind: IdentityKind, did: string): Promise<IdentityEntry | undefined>;
  putIdentity(entry: IdentityEntry): Promise<void>;
  /** Drops everything, resolved identities included: the account signed out. */
  clear(): Promise<void>;
}

/** A failure of this app's own store, never a writer's: it fails a read instead of setting a writer aside. */
export class SyncStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SyncStoreError";
  }
}

export function emptyWriterState(space: string, repo: string, generation = 0): WriterState {
  return { space, repo, syncedRev: null, generation, checkedAt: null, stale: false, coverage: {} };
}

/** The state `change` leaves, with the generation advanced; computed inside the store's atomic section. */
export function nextWriterState(current: WriterState | undefined, change: WriterCommit): WriterState {
  const base = current ?? emptyWriterState(change.space, change.repo);
  if (!change.markStale && !change.next) throw new SyncStoreError("A writer commit needs its next state.");
  const fields = change.markStale
    ? { syncedRev: base.syncedRev, checkedAt: base.checkedAt, stale: true, coverage: base.coverage }
    : change.next!;
  return { ...fields, space: change.space, repo: change.repo, generation: base.generation + 1 };
}

/** Whether `change` may apply over `current`: the generation it was computed from, and a revision no older than the stored one. */
export function commitAllowed(current: WriterState | undefined, change: WriterCommit): boolean {
  const generation = current?.generation ?? 0;
  if (change.expectedGeneration !== null && change.expectedGeneration !== generation) return false;
  if (change.rev !== undefined && change.rev !== null && current?.syncedRev && change.rev < current.syncedRev) return false;
  return true;
}
