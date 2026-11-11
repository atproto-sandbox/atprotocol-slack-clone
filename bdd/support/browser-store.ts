import { databaseName } from "@/client/indexeddb-store";
import type { StoredRecord } from "@/client/store";
import type { Actor } from "./world";
import { BROWSER_CLIENT_METADATA_PATH } from "@/browser/client-metadata";

// What the app's engine holds in a browser: the signed-in account's IndexedDB store at the page's origin. Steps that once
// read the app server's record cache read this instead, since the browser now reads and keeps the records itself.

export type BrowserStore = { spaces: string[]; records: StoredRecord[] };

/** The account's store at the page's origin, or empty when the account has none there; reading never creates one. */
export async function browserStore(actor: Actor): Promise<BrowserStore> {
  return actor.page.evaluate(async (name) => {
    if (!(await indexedDB.databases()).some((database) => database.name === name)) return { spaces: [], records: [] };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open(name);
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    try {
      // No named functions in here: the test runner's compiler wraps them in a helper the page does not have.
      const [spaces, records] = await Promise.all(["spaces", "records"].map((store) => new Promise<unknown[]>((resolve, reject) => {
        const request = db.transaction(store, "readonly").objectStore(store).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      })));
      return { spaces: (spaces as Array<{ space: string }>).map((entry) => entry.space).sort(), records: records as StoredRecord[] };
    } finally { db.close(); }
  }, databaseName(actor.did));
}

/** The records of one collection the account's store holds at the page's origin. */
export async function browserRecords(actor: Actor, collection: string): Promise<StoredRecord[]> {
  return (await browserStore(actor)).records.filter((record) => record.collection === collection);
}

/**
 * The account's store at `origin`, read from a page of that origin that runs no app code (the browser client's OAuth metadata), so the
 * app cannot sync or purge it first. The page is left there.
 */
export async function browserStoreAt(actor: Actor, origin: string): Promise<BrowserStore> {
  await actor.page.goto(new URL(BROWSER_CLIENT_METADATA_PATH, origin).href);
  return browserStore(actor);
}
