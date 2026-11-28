import type {} from "@flock/protocol/keys";

export type DeskJoinPhase =
  | "submitting"
  | "pending_approval"
  | "membership_verified"
  | "acceptance_pending"
  | "discovery_verified"
  | "orphaned_by_migration"
  | "expired_unknown"
  | "unsupported_status"
  | "quota_exceeded";

export const PASSIVE_JOIN_PHASES: ReadonlySet<DeskJoinPhase> = new Set([
  "orphaned_by_migration",
  "expired_unknown",
  "unsupported_status",
  "quota_exceeded",
]);

export const POST_ADMISSION_JOIN_PHASES: ReadonlySet<DeskJoinPhase> = new Set([
  "membership_verified",
  "acceptance_pending",
  "discovery_verified",
]);

export type DeskJoiningGroupEntry = {
  viewerDid: string;
  operationId: string;
  mode: "open" | "invite" | "approval";
  intentHash: string;
  groupDid: string;
  inviteUri?: string;
  message?: string;
  authorityEndpoint?: string;
  currentIncarnation?: string;
  rawStatus?: string;
  phase: DeskJoinPhase;
  createdAt: number;
};

export type DeskLeavePhase =
  | "leaving_group"
  | "deleting_acceptance"
  | "reconciling_post_delete"
  | "blocked_deactivated";

export type DeskLeavingGroupEntry = {
  viewerDid: string;
  groupDid: string;
  expectedIncarnation?: string;
  phase: DeskLeavePhase;
  createdAt: number;
};

export class LifecycleActorMismatchError extends Error {
  constructor(expectedViewerDid: string, actualViewerDid: string) {
    super(`Lifecycle row actor mismatch: expected ${expectedViewerDid}, found ${actualViewerDid}.`);
    this.name = "LifecycleActorMismatchError";
  }
}

export class DeskLifecycleStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DeskLifecycleStoreError";
  }
}

export interface DeskLifecycleStore {
  readonly viewerDid: string;
  getJoiningGroup(operationId: string): Promise<DeskJoiningGroupEntry | undefined>;
  putJoiningGroup(entry: DeskJoiningGroupEntry): Promise<void>;
  deleteJoiningGroup(operationId: string): Promise<void>;
  replaceJoiningGroup(oldOperationId: string, nextEntry: DeskJoiningGroupEntry): Promise<void>;
  listJoiningGroups(): Promise<DeskJoiningGroupEntry[]>;
  getLeavingGroup(groupDid: string): Promise<DeskLeavingGroupEntry | undefined>;
  putLeavingGroup(entry: DeskLeavingGroupEntry): Promise<void>;
  deleteLeavingGroup(groupDid: string): Promise<void>;
  listLeavingGroups(): Promise<DeskLeavingGroupEntry[]>;
  close(): void;
}

const DATABASE_PREFIX = "flock-desk-lifecycle:";
const DB_VERSION = 3;

export function deskLifecycleDatabaseName(viewerDid: string): string {
  return `${DATABASE_PREFIX}${viewerDid}`;
}

function cloneJoining(entry: DeskJoiningGroupEntry): DeskJoiningGroupEntry {
  return {
    viewerDid: entry.viewerDid,
    operationId: entry.operationId,
    mode: entry.mode,
    intentHash: entry.intentHash,
    groupDid: entry.groupDid,
    ...(entry.inviteUri !== undefined ? { inviteUri: entry.inviteUri } : {}),
    ...(entry.message !== undefined ? { message: entry.message } : {}),
    ...(entry.authorityEndpoint !== undefined ? { authorityEndpoint: entry.authorityEndpoint } : {}),
    ...(entry.currentIncarnation !== undefined ? { currentIncarnation: entry.currentIncarnation } : {}),
    ...(entry.rawStatus !== undefined ? { rawStatus: entry.rawStatus } : {}),
    phase: entry.phase,
    createdAt: entry.createdAt,
  };
}

function cloneLeaving(entry: DeskLeavingGroupEntry): DeskLeavingGroupEntry {
  return {
    viewerDid: entry.viewerDid,
    groupDid: entry.groupDid,
    ...(entry.expectedIncarnation !== undefined ? { expectedIncarnation: entry.expectedIncarnation } : {}),
    phase: entry.phase,
    createdAt: entry.createdAt,
  };
}

type Factory = Pick<IDBFactory, "open" | "deleteDatabase" | "databases">;
type StoreName = "joiningGroups" | "leavingGroups";

const DELETE_BLOCKED_TIMEOUT_MS = 3_000;

function settle<T>(request: IDBRequest<T> | IDBOpenDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error);
  });
}

function settleDeleteDatabase(request: IDBOpenDBRequest, blockedTimeoutMs = DELETE_BLOCKED_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      fn();
    };
    request.onsuccess = () => finish(resolve);
    request.onerror = () => finish(() => reject(request.error));
    request.onblocked = () => {
      if (timer === undefined) {
        timer = setTimeout(() => finish(resolve), blockedTimeoutMs);
      }
    };
  });
}

/**
 * Tiny account-scoped IndexedDB operational workflow journal (`flock-desk-lifecycle:<viewerDid>`).
 * Holds ONLY in-flight join/leave operational rows — NEVER protocol records or sync state.
 */
export class IndexedDbLifecycleStore implements DeskLifecycleStore {
  private db: IDBDatabase | null;

  private constructor(
    readonly viewerDid: string,
    db: IDBDatabase,
  ) {
    this.db = db;
  }

  static async open(
    viewerDid: string,
    factory: Factory = indexedDB,
    onClosedElsewhere?: () => void,
  ): Promise<IndexedDbLifecycleStore> {
    const opening = factory.open(deskLifecycleDatabaseName(viewerDid), DB_VERSION);
    opening.onupgradeneeded = (event) => {
      const db = opening.result;
      const tx = opening.transaction;
      const joining = db.objectStoreNames.contains("joiningGroups")
        ? tx?.objectStore("joiningGroups")
        : db.createObjectStore("joiningGroups", { keyPath: "operationId" });
      const leaving = db.objectStoreNames.contains("leavingGroups")
        ? tx?.objectStore("leavingGroups")
        : db.createObjectStore("leavingGroups", { keyPath: "groupDid" });
      if (event.oldVersion > 0 && event.oldVersion < 3) {
        // Clear pre-R15 DID-only lifecycle rows so legacy OpenSocial entries cannot resume against R15 org.atgrp.* endpoints.
        joining?.clear();
        leaving?.clear();
      }
    };
    const db = await settle(opening);
    const store = new IndexedDbLifecycleStore(viewerDid, db);
    db.onversionchange = () => {
      store.close();
      onClosedElsewhere?.();
    };
    db.onclose = () => {
      store.db = null;
    };
    return store;
  }

  static async deleteAccount(viewerDid: string, factory: Factory = indexedDB): Promise<void> {
    await settleDeleteDatabase(factory.deleteDatabase(deskLifecycleDatabaseName(viewerDid)));
  }

  static async deleteOtherAccounts(viewerDid: string, factory: Factory = indexedDB): Promise<void> {
    const own = deskLifecycleDatabaseName(viewerDid);
    if (typeof factory.databases !== "function") return;
    for (const { name } of await factory.databases()) {
      if (name && name.startsWith(DATABASE_PREFIX) && name !== own) {
        await settleDeleteDatabase(factory.deleteDatabase(name));
      }
    }
  }

  close(): void {
    const db = this.db;
    this.db = null;
    db?.close();
  }

  async getJoiningGroup(operationId: string): Promise<DeskJoiningGroupEntry | undefined> {
    const row = await this.transact(["joiningGroups"], "readonly", (stores) =>
      settle<DeskJoiningGroupEntry | undefined>(stores.joiningGroups!.get(operationId)),
    );
    return row ? cloneJoining(row) : undefined;
  }

  async putJoiningGroup(entry: DeskJoiningGroupEntry): Promise<void> {
    if (entry.viewerDid !== this.viewerDid) {
      throw new LifecycleActorMismatchError(this.viewerDid, entry.viewerDid);
    }
    await this.transact(["joiningGroups"], "readwrite", (stores) =>
      settle(stores.joiningGroups!.put(cloneJoining(entry))),
    );
  }

  async deleteJoiningGroup(operationId: string): Promise<void> {
    await this.transact(["joiningGroups"], "readwrite", (stores) =>
      settle(stores.joiningGroups!.delete(operationId)),
    );
  }

  async replaceJoiningGroup(oldOperationId: string, nextEntry: DeskJoiningGroupEntry): Promise<void> {
    if (nextEntry.viewerDid !== this.viewerDid) {
      throw new LifecycleActorMismatchError(this.viewerDid, nextEntry.viewerDid);
    }
    await this.transact(["joiningGroups"], "readwrite", async (stores) => {
      await Promise.all([
        settle(stores.joiningGroups!.put(cloneJoining(nextEntry))),
        settle(stores.joiningGroups!.delete(oldOperationId)),
      ]);
    });
  }

  async listJoiningGroups(): Promise<DeskJoiningGroupEntry[]> {
    const rows = await this.transact(["joiningGroups"], "readonly", (stores) =>
      settle<DeskJoiningGroupEntry[]>(stores.joiningGroups!.getAll()),
    );
    return rows.map(cloneJoining);
  }

  async getLeavingGroup(groupDid: string): Promise<DeskLeavingGroupEntry | undefined> {
    const row = await this.transact(["leavingGroups"], "readonly", (stores) =>
      settle<DeskLeavingGroupEntry | undefined>(stores.leavingGroups!.get(groupDid)),
    );
    return row ? cloneLeaving(row) : undefined;
  }

  async putLeavingGroup(entry: DeskLeavingGroupEntry): Promise<void> {
    if (entry.viewerDid !== this.viewerDid) {
      throw new LifecycleActorMismatchError(this.viewerDid, entry.viewerDid);
    }
    await this.transact(["leavingGroups"], "readwrite", (stores) =>
      settle(stores.leavingGroups!.put(cloneLeaving(entry))),
    );
  }

  async deleteLeavingGroup(groupDid: string): Promise<void> {
    await this.transact(["leavingGroups"], "readwrite", (stores) =>
      settle(stores.leavingGroups!.delete(groupDid)),
    );
  }

  async listLeavingGroups(): Promise<DeskLeavingGroupEntry[]> {
    const rows = await this.transact(["leavingGroups"], "readonly", (stores) =>
      settle<DeskLeavingGroupEntry[]>(stores.leavingGroups!.getAll()),
    );
    return rows.map(cloneLeaving);
  }

  private async transact<T>(
    names: StoreName[],
    mode: IDBTransactionMode,
    run: (stores: Partial<Record<StoreName, IDBObjectStore>>) => Promise<T>,
  ): Promise<T> {
    let tx: IDBTransaction | undefined;
    try {
      const db = this.db;
      if (!db) throw new Error("Lifecycle store connection is closed.");
      tx = db.transaction(names, mode);
      const finished = new Promise<void>((resolve, reject) => {
        tx!.oncomplete = () => resolve();
        tx!.onerror = () => reject(tx!.error);
        tx!.onabort = () => reject(tx!.error ?? new Error("Lifecycle store transaction aborted."));
      });
      finished.catch(() => undefined);
      const stores: Partial<Record<StoreName, IDBObjectStore>> = Object.fromEntries(
        names.map((name) => [name, tx!.objectStore(name)]),
      );
      const result = await run(stores);
      await finished;
      return result;
    } catch (error) {
      if (tx) {
        try {
          tx.abort();
        } catch {
          // ignore if already settled
        }
      }
      if (error instanceof LifecycleActorMismatchError) throw error;
      throw new DeskLifecycleStoreError("Desk lifecycle store transaction failed.", { cause: error });
    }
  }
}

export class MemoryLifecycleStore implements DeskLifecycleStore {
  private readonly joining = new Map<string, DeskJoiningGroupEntry>();
  private readonly leaving = new Map<string, DeskLeavingGroupEntry>();

  constructor(readonly viewerDid: string) {}

  async getJoiningGroup(operationId: string): Promise<DeskJoiningGroupEntry | undefined> {
    const row = this.joining.get(operationId);
    return row ? cloneJoining(row) : undefined;
  }

  async putJoiningGroup(entry: DeskJoiningGroupEntry): Promise<void> {
    if (entry.viewerDid !== this.viewerDid) {
      throw new LifecycleActorMismatchError(this.viewerDid, entry.viewerDid);
    }
    this.joining.set(entry.operationId, cloneJoining(entry));
  }

  async deleteJoiningGroup(operationId: string): Promise<void> {
    this.joining.delete(operationId);
  }

  async replaceJoiningGroup(oldOperationId: string, nextEntry: DeskJoiningGroupEntry): Promise<void> {
    if (nextEntry.viewerDid !== this.viewerDid) {
      throw new LifecycleActorMismatchError(this.viewerDid, nextEntry.viewerDid);
    }
    this.joining.set(nextEntry.operationId, cloneJoining(nextEntry));
    this.joining.delete(oldOperationId);
  }

  async listJoiningGroups(): Promise<DeskJoiningGroupEntry[]> {
    return [...this.joining.values()].map(cloneJoining);
  }

  async getLeavingGroup(groupDid: string): Promise<DeskLeavingGroupEntry | undefined> {
    const row = this.leaving.get(groupDid);
    return row ? cloneLeaving(row) : undefined;
  }

  async putLeavingGroup(entry: DeskLeavingGroupEntry): Promise<void> {
    if (entry.viewerDid !== this.viewerDid) {
      throw new LifecycleActorMismatchError(this.viewerDid, entry.viewerDid);
    }
    this.leaving.set(entry.groupDid, cloneLeaving(entry));
  }

  async deleteLeavingGroup(groupDid: string): Promise<void> {
    this.leaving.delete(groupDid);
  }

  async listLeavingGroups(): Promise<DeskLeavingGroupEntry[]> {
    return [...this.leaving.values()].map(cloneLeaving);
  }

  /** Test helper: injects a row bypassing the viewerDid guard to test cross-actor protection. */
  injectUnsafeRowForTest(row: DeskJoiningGroupEntry | DeskLeavingGroupEntry): void {
    if ("operationId" in row) {
      this.joining.set(row.operationId, cloneJoining(row));
    } else {
      this.leaving.set(row.groupDid, cloneLeaving(row));
    }
  }

  close(): void {}
}
