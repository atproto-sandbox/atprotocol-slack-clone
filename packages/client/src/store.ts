import { LTHASH_STATE_BYTES } from "@flock/protocol/atproto/space-credential-core";

// What the sync core keeps between reads, behind one interface with two implementations: memory (DM spaces, tests) and
// IndexedDB (workspace, inbox and channel spaces in the browser). Every write that could race another reader of the same
// writer is a compare-and-set on the writer's generation, so a slow refresh cannot overwrite newer state, undo a local
// write, or bring back purged records.

export { LTHASH_STATE_BYTES };
export const COMMIT_DIGEST_BYTES = 32;

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
  /** Exact 2048-byte LtHash accumulator state for verified complete sync; absent for v1 or partial window writers. */
  setHash?: Uint8Array;
  /** 32-byte SHA-256 commit digest of `setHash`. */
  commitDigest?: Uint8Array;
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

/** Persisted monotonic local TID + HLC reservation state per `(accountDid, scope)`. Account-wide state uses `scope = ""`. */
export type ClockState = {
  accountDid: string;
  scope: string;
  lastTidMs: number;
  lastClockId: number;
  ownLastHlc: string | null;
};

export type ClockPatch = Partial<Omit<ClockState, "accountDid" | "scope">>;

export type ClockUpdate = ClockPatch & {
  accountDid: string;
  scope?: string;
};

/** Per-account, per-space seen and dismissed Activity conflict IDs. */
export type ActivityState = {
  accountDid: string;
  space: string;
  seenIds: string[];
  dismissedIds: string[];
  updatedAt: number;
};

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
  /** Optional monotonic clock update persisted in the same atomic transaction when the commit applies. */
  clock?: ClockUpdate;
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
  getClock(accountDid: string, scope?: string): Promise<ClockState | undefined>;
  /** Atomically reads, updates monotonically, and persists the clock state for `(accountDid, scope)`. */
  updateClock(
    accountDid: string,
    updater: ClockPatch | ((current: ClockState | undefined) => ClockPatch),
    scope?: string,
  ): Promise<ClockState>;
  getActivityState(accountDid: string, space: string): Promise<ActivityState | undefined>;
  putActivityState(state: ActivityState): Promise<void>;
  markActivitySeen(accountDid: string, space: string, eventIds: readonly string[], updatedAt?: number): Promise<ActivityState>;
  dismissActivity(accountDid: string, space: string, eventIds: readonly string[], updatedAt?: number): Promise<ActivityState>;
  /** Drops everything, resolved identities, activity state, and clock state included: the account signed out. */
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

export function validateWriterHashes(fields: Pick<WriterState, "setHash" | "commitDigest">): void {
  if (fields.setHash !== undefined) {
    if (!(fields.setHash instanceof Uint8Array) || fields.setHash.byteLength !== LTHASH_STATE_BYTES) {
      throw new SyncStoreError(`WriterState.setHash must be exactly ${LTHASH_STATE_BYTES} bytes.`);
    }
  }
  if (fields.commitDigest !== undefined) {
    if (!(fields.commitDigest instanceof Uint8Array) || fields.commitDigest.byteLength !== COMMIT_DIGEST_BYTES) {
      throw new SyncStoreError(`WriterState.commitDigest must be exactly ${COMMIT_DIGEST_BYTES} bytes.`);
    }
  }
}

export function cloneWriterState(state: WriterState): WriterState {
  const coverage: Record<string, Coverage> = {};
  for (const [collection, entry] of Object.entries(state.coverage)) coverage[collection] = { ...entry };
  return {
    space: state.space,
    repo: state.repo,
    syncedRev: state.syncedRev,
    generation: state.generation,
    checkedAt: state.checkedAt,
    stale: state.stale,
    coverage,
    ...(state.setHash !== undefined ? { setHash: new Uint8Array(state.setHash) } : {}),
    ...(state.commitDigest !== undefined ? { commitDigest: new Uint8Array(state.commitDigest) } : {}),
  };
}

/** The state `change` leaves, with the generation advanced; computed inside the store's atomic section. */
export function nextWriterState(current: WriterState | undefined, change: WriterCommit): WriterState {
  const base = current ?? emptyWriterState(change.space, change.repo);
  if (!change.markStale && !change.next) throw new SyncStoreError("A writer commit needs its next state.");
  if (!change.markStale && change.next) validateWriterHashes(change.next);
  const fields = change.markStale
    ? {
        syncedRev: base.syncedRev,
        checkedAt: base.checkedAt,
        stale: true,
        coverage: base.coverage,
        ...(base.setHash !== undefined ? { setHash: new Uint8Array(base.setHash) } : {}),
        ...(base.commitDigest !== undefined ? { commitDigest: new Uint8Array(base.commitDigest) } : {}),
      }
    : change.next!;
  return cloneWriterState({ ...fields, space: change.space, repo: change.repo, generation: base.generation + 1 });
}

/** Whether `change` may apply over `current`: the generation it was computed from, and a revision no older than the stored one. */
export function commitAllowed(current: WriterState | undefined, change: WriterCommit): boolean {
  const generation = current?.generation ?? 0;
  if (change.expectedGeneration !== null && change.expectedGeneration !== generation) return false;
  if (change.rev !== undefined && change.rev !== null && current?.syncedRev && change.rev < current.syncedRev) return false;
  return true;
}

export function mergeMonotonicClock(
  accountDid: string,
  scope: string,
  current: ClockState | undefined,
  patch: ClockPatch,
): ClockState {
  if (typeof accountDid !== "string" || accountDid.length === 0) {
    throw new SyncStoreError("ClockState.accountDid must not be empty.");
  }
  if (typeof scope !== "string") {
    throw new SyncStoreError("ClockState.scope must be a string.");
  }
  const base: ClockState = current ?? { accountDid, scope, lastTidMs: 0, lastClockId: 0, ownLastHlc: null };
  let lastTidMs = base.lastTidMs;
  let lastClockId = base.lastClockId;
  if (patch.lastTidMs !== undefined) {
    if (!Number.isSafeInteger(patch.lastTidMs) || patch.lastTidMs < 0) {
      throw new SyncStoreError("ClockState.lastTidMs must be a non-negative safe integer.");
    }
  }
  if (patch.lastClockId !== undefined) {
    if (!Number.isSafeInteger(patch.lastClockId) || patch.lastClockId < 0 || patch.lastClockId > 1023) {
      throw new SyncStoreError("ClockState.lastClockId must be between 0 and 1023.");
    }
  }
  if (patch.lastTidMs !== undefined || patch.lastClockId !== undefined) {
    const candidateMs = patch.lastTidMs ?? base.lastTidMs;
    const candidateId = patch.lastClockId ?? (candidateMs > base.lastTidMs ? 0 : base.lastClockId);
    if (candidateMs > lastTidMs || (candidateMs === lastTidMs && candidateId > lastClockId)) {
      lastTidMs = candidateMs;
      lastClockId = candidateId;
    }
  }
  let ownLastHlc = base.ownLastHlc;
  if (patch.ownLastHlc !== undefined && patch.ownLastHlc !== null) {
    if (typeof patch.ownLastHlc !== "string" || patch.ownLastHlc.length === 0) {
      throw new SyncStoreError("ClockState.ownLastHlc must be a non-empty string.");
    }
    if (ownLastHlc === null || patch.ownLastHlc > ownLastHlc) {
      ownLastHlc = patch.ownLastHlc;
    }
  }
  return { accountDid, scope, lastTidMs, lastClockId, ownLastHlc };
}

export function cloneActivityState(state: ActivityState): ActivityState {
  if (typeof state.accountDid !== "string" || state.accountDid.length === 0) {
    throw new SyncStoreError("ActivityState.accountDid must not be empty.");
  }
  if (typeof state.space !== "string" || state.space.length === 0) {
    throw new SyncStoreError("ActivityState.space must not be empty.");
  }
  return {
    accountDid: state.accountDid,
    space: state.space,
    seenIds: dedupeIds(state.seenIds),
    dismissedIds: dedupeIds(state.dismissedIds),
    updatedAt: state.updatedAt,
  };
}

export function dedupeIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id === "string" && id.length > 0 && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
