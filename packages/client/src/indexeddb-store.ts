import { normalizeLegacySpaceUri } from "@flock/protocol/keys";
import {
  cloneActivityState,
  cloneJoiningGroupEntry,
  cloneLeavingGroupEntry,
  cloneReactivatingGroupEntry,
  cloneWriterState,
  commitAllowed,
  emptyWriterState,
  mergeMonotonicClock,
  mergeOptimisticOverlay,
  missingOptimisticKeys,
  nextWriterState,
  SyncStoreError,
  type ActivityState,
  type ClockPatch,
  type ClockState,
  type IdentityEntry,
  type IdentityKind,
  type JoiningGroupEntry,
  type LeavingGroupEntry,
  type PurgeWriterOptions,
  type PutSpaceOptions,
  type ReactivatingGroupEntry,
  type SpaceState,
  type StoredRecord,
  type SyncStore,
  type WriterCommit,
  type WriterState,
} from "./store";

// The browser's store for workspace, inbox and channel spaces (D10): one IndexedDB database per account, so a sign-out
// deletes one database and a different account's start deletes databases that are not its own.

const DATABASE_PREFIX = "flock-sync-";
const VERSION = 5;
const LAST = "￿";

type Factory = Pick<IDBFactory, "open" | "deleteDatabase" | "databases">;

export class IndexedDbStore implements SyncStore {
  private db: IDBDatabase | null;
  private dbPromise: Promise<IDBDatabase> | null;

  private constructor(db: IDBDatabase) {
    this.db = db;
    this.dbPromise = Promise.resolve(db);
  }

  /**
   * Opens (creating if needed) the account's database. Another tab deleting it (another account starting there) is not kept
   * waiting: this store closes, and `onClosedElsewhere` says so, since every later operation on it fails.
   */
  static async open(did: string, factory: Factory = indexedDB, onClosedElsewhere?: () => void): Promise<IndexedDbStore> {
    const opening = factory.open(databaseName(did), VERSION);
    opening.onupgradeneeded = (event) => {
      const db = opening.result;
      const upgradeTx = opening.transaction;
      const spaces = db.objectStoreNames.contains("spaces")
        ? upgradeTx?.objectStore("spaces")
        : db.createObjectStore("spaces", { keyPath: "space" });
      const writers = db.objectStoreNames.contains("writers")
        ? upgradeTx?.objectStore("writers")
        : db.createObjectStore("writers", { keyPath: ["space", "repo"] });
      if (writers && !writers.indexNames.contains("space")) writers.createIndex("space", "space");
      const records = db.objectStoreNames.contains("records")
        ? upgradeTx?.objectStore("records")
        : db.createObjectStore("records", { keyPath: ["space", "collection", "repo", "rkey"] });
      if (records && !records.indexNames.contains("writer")) records.createIndex("writer", ["space", "repo"]);
      const meta = db.objectStoreNames.contains("meta")
        ? upgradeTx?.objectStore("meta")
        : db.createObjectStore("meta", { keyPath: "key" });
      if (!db.objectStoreNames.contains("identities")) db.createObjectStore("identities", { keyPath: ["kind", "did"] });
      const activity = db.objectStoreNames.contains("activity")
        ? upgradeTx?.objectStore("activity")
        : db.createObjectStore("activity", { keyPath: ["accountDid", "space"] });
      if (activity && !activity.indexNames.contains("space")) activity.createIndex("space", "space");
      const clock = db.objectStoreNames.contains("clock")
        ? upgradeTx?.objectStore("clock")
        : db.createObjectStore("clock", { keyPath: ["accountDid", "scope"] });
      if (clock && !clock.indexNames.contains("scope")) clock.createIndex("scope", "scope");
      const leavingGroups = db.objectStoreNames.contains("leavingGroups")
        ? upgradeTx?.objectStore("leavingGroups")
        : db.createObjectStore("leavingGroups", { keyPath: "groupDid" });
      const joiningGroups = db.objectStoreNames.contains("joiningGroups")
        ? upgradeTx?.objectStore("joiningGroups")
        : db.createObjectStore("joiningGroups", { keyPath: "operationId" });
      const reactivatingGroups = db.objectStoreNames.contains("reactivatingGroups")
        ? upgradeTx?.objectStore("reactivatingGroups")
        : db.createObjectStore("reactivatingGroups", { keyPath: "operationId" });

      if (event.oldVersion > 0 && event.oldVersion < 5) {
        const normalizeV4 = event.oldVersion < 4;
        const isLegacyOpenSocial = (value: string | null | undefined): boolean =>
          typeof value === "string" && (value.includes("/group.opensocial.") || value.includes("/space/group.opensocial."));

        if (spaces) {
          migrateStoreRows(spaces, (row: SpaceState) => {
            if (isLegacyOpenSocial(row.space) || isLegacyOpenSocial(row.workspace)) return { action: "delete" };
            if (!normalizeV4) return null;
            const nextSpace = normalizeLegacySpaceUri(row.space);
            const nextWorkspace = row.workspace === null ? null : normalizeLegacySpaceUri(row.workspace);
            if (nextSpace === row.space && nextWorkspace === row.workspace) return null;
            return { action: "replace", next: { ...row, space: nextSpace, workspace: nextWorkspace }, keyChanged: nextSpace !== row.space };
          });
        }
        if (writers) {
          migrateStoreRows(writers, (row: WriterState) => {
            if (isLegacyOpenSocial(row.space)) return { action: "delete" };
            if (!normalizeV4) return null;
            const nextSpace = normalizeLegacySpaceUri(row.space);
            if (nextSpace === row.space) return null;
            return { action: "replace", next: { ...row, space: nextSpace }, keyChanged: true };
          });
        }
        if (records) {
          migrateStoreRows(records, (row: StoredRecord) => {
            if (
              isLegacyOpenSocial(row.space) ||
              row.collection.startsWith("group.opensocial.") ||
              isLegacyOpenSocial(row.uri)
            ) {
              return { action: "delete" };
            }
            if (!normalizeV4) return null;
            const nextSpace = normalizeLegacySpaceUri(row.space);
            const nextUri = normalizeLegacySpaceUri(row.uri);
            if (nextSpace === row.space && nextUri === row.uri) return null;
            return { action: "replace", next: { ...row, space: nextSpace, uri: nextUri }, keyChanged: nextSpace !== row.space };
          });
        }
        if (meta) {
          migrateStoreRows(meta, (row: { key: string; value: unknown }) => {
            if (isLegacyOpenSocial(row.key)) return { action: "delete" };
            if (!normalizeV4 || !row.key.startsWith("purges ")) return null;
            const rawSpace = row.key.slice("purges ".length);
            const nextSpace = normalizeLegacySpaceUri(rawSpace);
            if (nextSpace === rawSpace) return null;
            return { action: "replace", next: { ...row, key: `purges ${nextSpace}` }, keyChanged: true };
          });
        }
        if (activity) {
          migrateStoreRows(activity, (row: ActivityState) => {
            if (isLegacyOpenSocial(row.space)) return { action: "delete" };
            if (!normalizeV4) return null;
            const nextSpace = normalizeLegacySpaceUri(row.space);
            if (nextSpace === row.space) return null;
            return { action: "replace", next: { ...row, space: nextSpace }, keyChanged: true };
          });
        }
        if (clock) {
          migrateStoreRows(clock, (row: ClockState) => {
            if (isLegacyOpenSocial(row.scope)) return { action: "delete" };
            if (!normalizeV4) return null;
            const nextScope = normalizeLegacySpaceUri(row.scope);
            if (nextScope === row.scope) return null;
            return { action: "replace", next: { ...row, scope: nextScope }, keyChanged: true };
          });
        }
        // Clear all pre-R15 DID-only lifecycle journal rows so legacy OpenSocial entries cannot resume against R15 endpoints.
        leavingGroups?.clear();
        joiningGroups?.clear();
        reactivatingGroups?.clear();
      }
    };
    const db = await settle(opening);
    const store = new IndexedDbStore(db);
    db.onversionchange = () => {
      store.close();
      onClosedElsewhere?.();
    };
    db.onclose = () => {
      store.db = null;
      store.dbPromise = null;
    };
    return store;
  }

  /** Sign-out: deletes the account's store, records and all. Close an open store on it first, or this waits for it. */
  static async deleteAccount(did: string, factory: Factory = indexedDB): Promise<void> {
    await settle(factory.deleteDatabase(databaseName(did)));
  }

  /** Deletes the stores of every other account on this device: one left behind by a crash before its sign-out. */
  static async deleteOtherAccounts(did: string, factory: Factory = indexedDB): Promise<void> {
    const own = databaseName(did);
    for (const { name } of await factory.databases()) {
      if (name && name.startsWith(DATABASE_PREFIX) && name !== own) await settle(factory.deleteDatabase(name));
    }
  }

  close(): void {
    const db = this.db;
    this.db = null;
    this.dbPromise = null;
    db?.close();
  }

  async getSpace(space: string): Promise<SpaceState | undefined> {
    return this.read("spaces", (stores) => settle<SpaceState | undefined>(stores.spaces!.get(space)));
  }

  async putSpace(state: SpaceState, options?: PutSpaceOptions): Promise<boolean> {
    const storeNames: StoreName[] = ["spaces"];
    if (options?.epoch !== undefined) storeNames.push("meta");
    return this.write(storeNames, async (stores) => {
      if (options?.epoch !== undefined && options.epoch !== (await epochOf(stores.meta!, state.space))) {
        return false;
      }
      const existing = await settle<SpaceState | undefined>(stores.spaces!.get(state.space));
      if (options?.touchMetadataOnly) {
        const touched: SpaceState = existing
          ? {
              ...existing,
              workspace: state.workspace,
              lastOpenedAt: Math.max(existing.lastOpenedAt, state.lastOpenedAt),
            }
          : { ...state, revision: 0 };
        await settle(stores.spaces!.put(touched));
        return true;
      }
      if (
        options?.expectedInvalidationSeq !== undefined &&
        (existing?.invalidationSeq ?? 0) !== options.expectedInvalidationSeq
      ) {
        return false;
      }
      if (options?.expectedRevision !== undefined && (existing?.revision ?? 0) !== options.expectedRevision) {
        return false;
      }
      if (
        options?.disallowOlderSpaceRev &&
        existing?.spaceRev !== null &&
        existing?.spaceRev !== undefined &&
        (state.spaceRev === null || state.spaceRev < existing.spaceRev)
      ) {
        return false;
      }
      const nextSeq = Math.max(existing?.invalidationSeq ?? 0, state.invalidationSeq ?? 0);
      const next: SpaceState = { ...state, revision: (existing?.revision ?? 0) + 1 };
      if (
        options?.preserveNewerOwnWriteSince !== undefined &&
        existing?.ownWriteAt !== undefined &&
        existing.ownWriteAt !== null &&
        existing.ownWriteAt > options.preserveNewerOwnWriteSince
      ) {
        next.ownWriteAt = existing.ownWriteAt;
      }
      if (nextSeq > 0) next.invalidationSeq = nextSeq;
      await settle(stores.spaces!.put(next));
      return true;
    });
  }

  async listSpaces(): Promise<SpaceState[]> {
    return this.read("spaces", (stores) => settle<SpaceState[]>(stores.spaces!.getAll()));
  }

  async getWriter(space: string, repo: string): Promise<WriterState | undefined> {
    const state = await this.read("writers", (stores) => settle<WriterState | undefined>(stores.writers!.get([space, repo])));
    return state ? cloneWriterState(state) : undefined;
  }

  async listWriters(space: string): Promise<WriterState[]> {
    const states = await this.read("writers", (stores) => settle<WriterState[]>(stores.writers!.index("space").getAll(space)));
    return states.map(cloneWriterState);
  }

  async getClock(accountDid: string, scope = ""): Promise<ClockState | undefined> {
    const clock = await this.read("clock", (stores) => settle<ClockState | undefined>(stores.clock!.get([accountDid, scope])));
    return clock ? { ...clock } : undefined;
  }

  async updateClock(
    accountDid: string,
    updater: ClockPatch | ((current: ClockState | undefined) => ClockPatch),
    scope = "",
  ): Promise<ClockState> {
    return this.write(["clock"], async (stores) => {
      const current = await settle<ClockState | undefined>(stores.clock!.get([accountDid, scope]));
      const patch = typeof updater === "function" ? updater(current ? { ...current } : undefined) : updater;
      const next = mergeMonotonicClock(accountDid, scope, current, patch);
      await settle(stores.clock!.put(next));
      return { ...next };
    });
  }

  async getActivityState(accountDid: string, space: string): Promise<ActivityState | undefined> {
    const state = await this.read("activity", (stores) => settle<ActivityState | undefined>(stores.activity!.get([accountDid, space])));
    return state ? cloneActivityState(state) : undefined;
  }

  async putActivityState(state: ActivityState): Promise<void> {
    await this.write(["activity"], (stores) => settle(stores.activity!.put(cloneActivityState(state))));
  }

  markActivitySeen(accountDid: string, space: string, eventIds: readonly string[], updatedAt = Date.now()): Promise<ActivityState> {
    return this.updateActivityIds(accountDid, space, "seenIds", eventIds, updatedAt);
  }

  dismissActivity(accountDid: string, space: string, eventIds: readonly string[], updatedAt = Date.now()): Promise<ActivityState> {
    return this.updateActivityIds(accountDid, space, "dismissedIds", eventIds, updatedAt);
  }

  private async updateActivityIds(
    accountDid: string,
    space: string,
    field: "seenIds" | "dismissedIds",
    eventIds: readonly string[],
    updatedAt: number,
  ): Promise<ActivityState> {
    return this.write(["activity"], async (stores) => {
      const current = await settle<ActivityState | undefined>(stores.activity!.get([accountDid, space]));
      const next = cloneActivityState({
        accountDid,
        space,
        seenIds: field === "seenIds" ? [...(current?.seenIds ?? []), ...eventIds] : (current?.seenIds ?? []),
        dismissedIds: field === "dismissedIds" ? [...(current?.dismissedIds ?? []), ...eventIds] : (current?.dismissedIds ?? []),
        updatedAt: Math.max(current?.updatedAt ?? 0, updatedAt),
      });
      await settle(stores.activity!.put(next));
      return cloneActivityState(next);
    });
  }

  async records(space: string, collection: string, repo?: string): Promise<StoredRecord[]> {
    const range = repo === undefined
      ? IDBKeyRange.bound([space, collection], [space, collection, LAST])
      : IDBKeyRange.bound([space, collection, repo], [space, collection, repo, LAST]);
    return this.read("records", (stores) => settle<StoredRecord[]>(stores.records!.getAll(range)));
  }

  async getRecord(space: string, repo: string, collection: string, rkey: string): Promise<StoredRecord | undefined> {
    return this.read("records", (stores) => settle<StoredRecord | undefined>(stores.records!.get([space, collection, repo, rkey])));
  }

  async counts(space: string, collection: string): Promise<Map<string, number>> {
    const keys = await this.read("records", (stores) => settle<IDBValidKey[]>(stores.records!.getAllKeys(IDBKeyRange.bound([space, collection], [space, collection, LAST]))));
    const counts = new Map<string, number>();
    for (const key of keys) {
      const repo = String((key as string[])[2]);
      counts.set(repo, (counts.get(repo) ?? 0) + 1);
    }
    return counts;
  }

  async epoch(space: string): Promise<string> {
    return this.read("meta", async (stores) => epochOf(stores.meta!, space));
  }

  async commit(change: WriterCommit): Promise<boolean> {
    const storeNames: StoreName[] = ["writers", "records", "meta"];
    if (change.clock) storeNames.push("clock");
    if (change.expectedInvalidationSeq !== undefined || change.touchOwnSpace !== undefined) {
      storeNames.push("spaces");
    }
    return this.write(storeNames, async (stores) => {
      if (change.epoch !== undefined && change.epoch !== await epochOf(stores.meta!, change.space)) return false;
      let spaceStateLoaded = false;
      let spaceState: SpaceState | undefined;
      if (change.expectedInvalidationSeq !== undefined || change.touchOwnSpace !== undefined) {
        spaceState = await settle<SpaceState | undefined>(stores.spaces!.get(change.space));
        spaceStateLoaded = true;
      }
      if (
        change.expectedInvalidationSeq !== undefined &&
        (spaceState?.invalidationSeq ?? 0) !== change.expectedInvalidationSeq
      ) {
        return false;
      }
      const current = await settle<WriterState | undefined>(stores.writers!.get([change.space, change.repo]));
      if (!commitAllowed(current, change)) return false;
      const missingKeys = missingOptimisticKeys(current, change);
      const addedOverlay = missingKeys.length > 0
        ? await Promise.all(
            missingKeys.map(async ({ collection, rkey }) => ({
              collection,
              rkey,
              prevRecord: (await settle<StoredRecord | undefined>(stores.records!.get([change.space, collection, change.repo, rkey]))) ?? null,
            })),
          )
        : [];
      const resolvedOverlay = change.markStale
        ? mergeOptimisticOverlay(current?.optimisticOverlay, addedOverlay)
        : undefined;
      const next = nextWriterState(current, change, resolvedOverlay);
      const clockScope = change.clock ? (change.clock.scope ?? "") : "";
      const currentClock = change.clock
        ? await settle<ClockState | undefined>(stores.clock!.get([change.clock.accountDid, clockScope]))
        : undefined;
      const nextClock = change.clock
        ? mergeMonotonicClock(change.clock.accountDid, clockScope, currentClock, change.clock)
        : undefined;
      // Requests in one transaction run in the order issued, so they are issued together and awaited once.
      const pending: Array<Promise<unknown>> = [];
      for (const [collection, records] of Object.entries(change.replace ?? {})) {
        pending.push(settle(stores.records!.delete(IDBKeyRange.bound([change.space, collection, change.repo], [change.space, collection, change.repo, LAST]))));
        for (const record of records) pending.push(settle(stores.records!.put(record)));
      }
      for (const record of change.upsert ?? []) pending.push(settle(stores.records!.put(record)));
      for (const { collection, rkey } of change.remove ?? []) pending.push(settle(stores.records!.delete([change.space, collection, change.repo, rkey])));
      pending.push(settle(stores.writers!.put(next)));
      if (nextClock) pending.push(settle(stores.clock!.put(nextClock)));
      if (change.touchOwnSpace && spaceStateLoaded) {
        const touch = change.touchOwnSpace;
        const nextSpace: SpaceState = spaceState
          ? {
              ...spaceState,
              ownWriteAt: Math.max(spaceState.ownWriteAt ?? 0, touch.ownWriteAt),
              ...(touch.workspace !== undefined && spaceState.workspace === null
                ? { workspace: touch.workspace }
                : {}),
            }
          : {
              space: change.space,
              spaceRev: null,
              writers: [],
              writersListedAt: null,
              workspace: touch.workspace ?? null,
              lastOpenedAt: touch.defaultLastOpenedAt,
              ownWriteAt: touch.ownWriteAt,
            };
        pending.push(settle(stores.spaces!.put(nextSpace)));
      }
      await Promise.all(pending);
      return true;
    });
  }

  async invalidateSpace(space: string, extraRepos: readonly string[] = []): Promise<void> {
    await this.write(["spaces", "writers"], async (stores) => {
      const [currentSpace, existingWriters] = await Promise.all([
        settle<SpaceState | undefined>(stores.spaces!.get(space)),
        settle<WriterState[]>(stores.writers!.index("space").getAll(space)),
      ]);
      const nextSpace: SpaceState = currentSpace
        ? {
            ...currentSpace,
            writersListedAt: null,
            invalidationSeq: (currentSpace.invalidationSeq ?? 0) + 1,
            revision: (currentSpace.revision ?? 0) + 1,
          }
        : {
            space,
            spaceRev: null,
            writers: [],
            writersListedAt: null,
            workspace: null,
            lastOpenedAt: 0,
            invalidationSeq: 1,
            revision: 1,
          };
      const byRepo = new Map(existingWriters.map((writer) => [writer.repo, writer]));
      const repos = new Set<string>([...byRepo.keys(), ...extraRepos]);
      const pending: Array<Promise<unknown>> = [settle(stores.spaces!.put(nextSpace))];
      for (const repo of repos) {
        const currentWriter = byRepo.get(repo);
        const staleChange: WriterCommit = { space, repo, expectedGeneration: null, markStale: true };
        const nextWriter = nextWriterState(currentWriter, staleChange, currentWriter?.optimisticOverlay);
        pending.push(settle(stores.writers!.put(nextWriter)));
      }
      await Promise.all(pending);
    });
  }

  async purgeWriter(space: string, repo: string, options?: PurgeWriterOptions): Promise<boolean> {
    const storeNames: StoreName[] = ["writers", "records"];
    if (options?.epoch !== undefined) storeNames.push("meta");
    if (options?.expectedInvalidationSeq !== undefined || options?.expectedSpaceRevision !== undefined) {
      storeNames.push("spaces");
    }
    return this.write(storeNames, async (stores) => {
      if (options?.epoch !== undefined && options.epoch !== (await epochOf(stores.meta!, space))) {
        return false;
      }
      if (options?.expectedInvalidationSeq !== undefined || options?.expectedSpaceRevision !== undefined) {
        const spaceState = await settle<SpaceState | undefined>(stores.spaces!.get(space));
        if (
          options?.expectedInvalidationSeq !== undefined &&
          (spaceState?.invalidationSeq ?? 0) !== options.expectedInvalidationSeq
        ) {
          return false;
        }
        if (
          options?.expectedSpaceRevision !== undefined &&
          (spaceState?.revision ?? 0) !== options.expectedSpaceRevision
        ) {
          return false;
        }
      }
      const current = await settle<WriterState | undefined>(stores.writers!.get([space, repo]));
      if (options?.expectedGeneration !== undefined && (current?.generation ?? 0) !== options.expectedGeneration) {
        return false;
      }
      for (const key of await settle<IDBValidKey[]>(stores.records!.index("writer").getAllKeys([space, repo]))) {
        await settle(stores.records!.delete(key));
      }
      await settle(stores.writers!.put(emptyWriterState(space, repo, (current?.generation ?? 0) + 1)));
      return true;
    });
  }

  async purgeSpace(space: string): Promise<void> {
    await this.write(["spaces", "writers", "records", "meta", "activity", "clock"], async (stores) => {
      await settle(stores.records!.delete(IDBKeyRange.bound([space], [space, LAST])));
      for (const state of await settle<WriterState[]>(stores.writers!.index("space").getAll(space))) {
        await settle(stores.writers!.put(emptyWriterState(space, state.repo, state.generation + 1)));
      }
      await settle(stores.spaces!.delete(space));
      for (const key of await settle<IDBValidKey[]>(stores.activity!.index("space").getAllKeys(space))) {
        await settle(stores.activity!.delete(key));
      }
      if (space !== "") {
        for (const key of await settle<IDBValidKey[]>(stores.clock!.index("scope").getAllKeys(space))) {
          await settle(stores.clock!.delete(key));
        }
      }
      const purges = await settle<{ key: string; value: number } | undefined>(stores.meta!.get(`purges ${space}`));
      await settle(stores.meta!.put({ key: `purges ${space}`, value: (purges?.value ?? 0) + 1 }));
    });
  }

  async getIdentity(kind: IdentityKind, did: string): Promise<IdentityEntry | undefined> {
    return this.read("identities", (stores) => settle<IdentityEntry | undefined>(stores.identities!.get([kind, did])));
  }

  async putIdentity(entry: IdentityEntry): Promise<void> {
    await this.write(["identities"], async (stores) => { await settle(stores.identities!.put(entry)); });
  }

  async deleteIdentity(kind: IdentityKind, did: string): Promise<void> {
    await this.write(["identities"], async (stores) => { await settle(stores.identities!.delete([kind, did])); });
  }

  async getLeavingGroup(groupDid: string): Promise<LeavingGroupEntry | undefined> {
    const entry = await this.read("leavingGroups", (stores) => settle<LeavingGroupEntry | undefined>(stores.leavingGroups!.get(groupDid)));
    return entry ? cloneLeavingGroupEntry(entry) : undefined;
  }

  async putLeavingGroup(entry: LeavingGroupEntry): Promise<void> {
    await this.write(["leavingGroups"], (stores) => settle(stores.leavingGroups!.put(cloneLeavingGroupEntry(entry))));
  }

  async deleteLeavingGroup(groupDid: string): Promise<void> {
    await this.write(["leavingGroups"], (stores) => settle(stores.leavingGroups!.delete(groupDid)));
  }

  async listLeavingGroups(): Promise<LeavingGroupEntry[]> {
    const entries = await this.read("leavingGroups", (stores) => settle<LeavingGroupEntry[]>(stores.leavingGroups!.getAll()));
    return entries.map((entry) => cloneLeavingGroupEntry(entry));
  }

  async getJoiningGroup(operationId: string): Promise<JoiningGroupEntry | undefined> {
    const entry = await this.read("joiningGroups", (stores) => settle<JoiningGroupEntry | undefined>(stores.joiningGroups!.get(operationId)));
    return entry ? cloneJoiningGroupEntry(entry) : undefined;
  }

  async putJoiningGroup(entry: JoiningGroupEntry): Promise<void> {
    await this.write(["joiningGroups"], (stores) => settle(stores.joiningGroups!.put(cloneJoiningGroupEntry(entry))));
  }

  async deleteJoiningGroup(operationId: string): Promise<void> {
    await this.write(["joiningGroups"], (stores) => settle(stores.joiningGroups!.delete(operationId)));
  }

  async listJoiningGroups(): Promise<JoiningGroupEntry[]> {
    const entries = await this.read("joiningGroups", (stores) => settle<JoiningGroupEntry[]>(stores.joiningGroups!.getAll()));
    return entries.map((entry) => cloneJoiningGroupEntry(entry));
  }

  async getReactivatingGroup(operationId: string): Promise<ReactivatingGroupEntry | undefined> {
    const entry = await this.read("reactivatingGroups", (stores) => settle<ReactivatingGroupEntry | undefined>(stores.reactivatingGroups!.get(operationId)));
    return entry ? cloneReactivatingGroupEntry(entry) : undefined;
  }

  async putReactivatingGroup(entry: ReactivatingGroupEntry): Promise<void> {
    await this.write(["reactivatingGroups"], (stores) => settle(stores.reactivatingGroups!.put(cloneReactivatingGroupEntry(entry))));
  }

  async deleteReactivatingGroup(operationId: string): Promise<void> {
    await this.write(["reactivatingGroups"], (stores) => settle(stores.reactivatingGroups!.delete(operationId)));
  }

  async listReactivatingGroups(): Promise<ReactivatingGroupEntry[]> {
    const entries = await this.read("reactivatingGroups", (stores) => settle<ReactivatingGroupEntry[]>(stores.reactivatingGroups!.getAll()));
    return entries.map((entry) => cloneReactivatingGroupEntry(entry));
  }

  async clear(): Promise<void> {
    const allStores: StoreName[] = [
      "spaces",
      "writers",
      "records",
      "meta",
      "identities",
      "activity",
      "clock",
      "leavingGroups",
      "joiningGroups",
      "reactivatingGroups",
    ];
    await this.write(allStores, async (stores) => {
      for (const name of [
        "spaces",
        "writers",
        "records",
        "identities",
        "activity",
        "clock",
        "leavingGroups",
        "joiningGroups",
        "reactivatingGroups",
      ] as const) {
        await settle(stores[name]!.clear());
      }
      const clears = await settle<{ key: string; value: number } | undefined>(stores.meta!.get("clears"));
      await settle(stores.meta!.put({ key: "clears", value: (clears?.value ?? 0) + 1 }));
    });
  }

  private async read<T>(name: StoreName, run: (stores: Stores) => Promise<T>): Promise<T> {
    return this.transact([name], "readonly", run);
  }

  private async write<T>(names: StoreName[], run: (stores: Stores) => Promise<T>): Promise<T> {
    return this.transact(names, "readwrite", run);
  }

  /** Runs `run` in one transaction and resolves once the transaction completed, so a resolved write is durable. */
  private async transact<T>(names: StoreName[], mode: IDBTransactionMode, run: (stores: Stores) => Promise<T>): Promise<T> {
    let transaction: IDBTransaction | undefined;
    try {
      const db = this.db ?? (this.dbPromise ? await this.dbPromise : null);
      if (!db) throw new Error("The store connection is closed.");
      transaction = db.transaction(names, mode);
      const finished = new Promise<void>((resolve, reject) => {
        transaction!.oncomplete = () => resolve();
        transaction!.onerror = () => reject(transaction!.error);
        transaction!.onabort = () => reject(transaction!.error ?? new Error("The store transaction was aborted."));
      });
      // `run` may fail first, and then this rejection is reported through `run`'s error instead of going unhandled.
      finished.catch(() => undefined);
      const stores: Stores = Object.fromEntries(names.map((name) => [name, transaction!.objectStore(name)]));
      const result = await run(stores);
      await finished;
      return result;
    } catch (error) {
      if (transaction) {
        try {
          transaction.abort();
        } catch {
          // Ignore if the transaction already settled.
        }
      }
      throw new SyncStoreError("The local store failed.", { cause: error });
    }
  }
}

type StoreName =
  | "spaces"
  | "writers"
  | "records"
  | "meta"
  | "identities"
  | "activity"
  | "clock"
  | "leavingGroups"
  | "joiningGroups"
  | "reactivatingGroups";
type Stores = Partial<Record<StoreName, IDBObjectStore>>;

/** The account's database name on this device. */
export function databaseName(did: string): string {
  return `${DATABASE_PREFIX}${did}`;
}

async function epochOf(meta: IDBObjectStore, space: string): Promise<string> {
  const [clears, purges] = await Promise.all([
    settle<{ value: number } | undefined>(meta.get("clears")),
    settle<{ value: number } | undefined>(meta.get(`purges ${space}`)),
  ]);
  return `${clears?.value ?? 0}:${purges?.value ?? 0}`;
}

function migrateStoreRows<T>(
  store: IDBObjectStore,
  transform: (row: T) => { action: "delete" } | { action: "replace"; next: T; keyChanged: boolean } | null,
): void {
  const req = store.openCursor();
  req.onsuccess = () => {
    const cursor = req.result;
    if (!cursor) return;
    const change = transform(cursor.value as T);
    if (change) {
      if (change.action === "delete") {
        cursor.delete();
      } else if (change.keyChanged) {
        cursor.delete();
        store.put(change.next);
      } else {
        cursor.update(change.next);
      }
    }
    cursor.continue();
  };
}

function settle<T>(request: IDBRequest<T> | IDBOpenDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error);
  });
}
