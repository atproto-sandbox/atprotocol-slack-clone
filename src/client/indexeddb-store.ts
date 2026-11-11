import { commitAllowed, emptyWriterState, nextWriterState, SyncStoreError, type IdentityEntry, type IdentityKind, type SpaceState, type StoredRecord, type SyncStore, type WriterCommit, type WriterState } from "./store";

// The browser's store for workspace, inbox and channel spaces (D10): one IndexedDB database per account, so a sign-out
// deletes one database and a different account's start deletes databases that are not its own.

const DATABASE_PREFIX = "flock-sync-";
const VERSION = 1;
const LAST = "￿";

type Factory = Pick<IDBFactory, "open" | "deleteDatabase" | "databases">;

export class IndexedDbStore implements SyncStore {
  private constructor(private readonly db: IDBDatabase) {}

  /** Opens (creating if needed) the account's database. */
  static async open(did: string, factory: Factory = indexedDB): Promise<IndexedDbStore> {
    const opening = factory.open(databaseName(did), VERSION);
    opening.onupgradeneeded = () => {
      const db = opening.result;
      db.createObjectStore("spaces", { keyPath: "space" });
      db.createObjectStore("writers", { keyPath: ["space", "repo"] }).createIndex("space", "space");
      db.createObjectStore("records", { keyPath: ["space", "collection", "repo", "rkey"] }).createIndex("writer", ["space", "repo"]);
      db.createObjectStore("meta", { keyPath: "key" });
      db.createObjectStore("identities", { keyPath: ["kind", "did"] });
    };
    return new IndexedDbStore(await settle(opening));
  }

  /** Deletes the stores of every other account on this device: one left behind by a crash before its sign-out. */
  static async deleteOtherAccounts(did: string, factory: Factory = indexedDB): Promise<void> {
    const own = databaseName(did);
    for (const { name } of await factory.databases()) {
      if (name && name.startsWith(DATABASE_PREFIX) && name !== own) await settle(factory.deleteDatabase(name));
    }
  }

  close(): void {
    this.db.close();
  }

  async getSpace(space: string): Promise<SpaceState | undefined> {
    return this.read("spaces", (stores) => settle<SpaceState | undefined>(stores.spaces!.get(space)));
  }

  async putSpace(state: SpaceState): Promise<void> {
    await this.write(["spaces"], async (stores) => { await settle(stores.spaces!.put(state)); });
  }

  async listSpaces(): Promise<SpaceState[]> {
    return this.read("spaces", (stores) => settle<SpaceState[]>(stores.spaces!.getAll()));
  }

  async getWriter(space: string, repo: string): Promise<WriterState | undefined> {
    return this.read("writers", (stores) => settle<WriterState | undefined>(stores.writers!.get([space, repo])));
  }

  async listWriters(space: string): Promise<WriterState[]> {
    return this.read("writers", (stores) => settle<WriterState[]>(stores.writers!.index("space").getAll(space)));
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
    return this.write(["writers", "records", "meta"], async (stores) => {
      if (change.epoch !== undefined && change.epoch !== await epochOf(stores.meta!, change.space)) return false;
      const current = await settle<WriterState | undefined>(stores.writers!.get([change.space, change.repo]));
      if (!commitAllowed(current, change)) return false;
      const next = nextWriterState(current, change);
      // Requests in one transaction run in the order issued, so they are issued together and awaited once.
      const pending: Array<Promise<unknown>> = [];
      for (const [collection, records] of Object.entries(change.replace ?? {})) {
        pending.push(settle(stores.records!.delete(IDBKeyRange.bound([change.space, collection, change.repo], [change.space, collection, change.repo, LAST]))));
        for (const record of records) pending.push(settle(stores.records!.put(record)));
      }
      for (const record of change.upsert ?? []) pending.push(settle(stores.records!.put(record)));
      for (const { collection, rkey } of change.remove ?? []) pending.push(settle(stores.records!.delete([change.space, collection, change.repo, rkey])));
      pending.push(settle(stores.writers!.put(next)));
      await Promise.all(pending);
      return true;
    });
  }

  async purgeWriter(space: string, repo: string): Promise<void> {
    await this.write(["writers", "records"], async (stores) => {
      for (const key of await settle<IDBValidKey[]>(stores.records!.index("writer").getAllKeys([space, repo]))) await settle(stores.records!.delete(key));
      const current = await settle<WriterState | undefined>(stores.writers!.get([space, repo]));
      await settle(stores.writers!.put(emptyWriterState(space, repo, (current?.generation ?? 0) + 1)));
    });
  }

  async purgeSpace(space: string): Promise<void> {
    await this.write(["spaces", "writers", "records", "meta"], async (stores) => {
      await settle(stores.records!.delete(IDBKeyRange.bound([space], [space, LAST])));
      for (const state of await settle<WriterState[]>(stores.writers!.index("space").getAll(space))) {
        await settle(stores.writers!.put(emptyWriterState(space, state.repo, state.generation + 1)));
      }
      await settle(stores.spaces!.delete(space));
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

  async clear(): Promise<void> {
    await this.write(["spaces", "writers", "records", "meta", "identities"], async (stores) => {
      for (const name of ["spaces", "writers", "records", "identities"] as const) await settle(stores[name]!.clear());
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
    try {
      const transaction = this.db.transaction(names, mode);
      const finished = new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error ?? new Error("The store transaction was aborted."));
      });
      // `run` may fail first, and then this rejection is reported through `run`'s error instead of going unhandled.
      finished.catch(() => undefined);
      const stores: Stores = Object.fromEntries(names.map((name) => [name, transaction.objectStore(name)]));
      const result = await run(stores);
      await finished;
      return result;
    } catch (error) {
      throw new SyncStoreError("The local store failed.", { cause: error });
    }
  }
}

type StoreName = "spaces" | "writers" | "records" | "meta" | "identities";
type Stores = Partial<Record<StoreName, IDBObjectStore>>;

function databaseName(did: string): string {
  return `${DATABASE_PREFIX}${did}`;
}

async function epochOf(meta: IDBObjectStore, space: string): Promise<string> {
  const [clears, purges] = await Promise.all([
    settle<{ value: number } | undefined>(meta.get("clears")),
    settle<{ value: number } | undefined>(meta.get(`purges ${space}`)),
  ]);
  return `${clears?.value ?? 0}:${purges?.value ?? 0}`;
}

function settle<T>(request: IDBRequest<T> | IDBOpenDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error);
  });
}
