import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { IndexedDbStore } from "@flock/client/indexeddb-store";
import { signOutAccount } from "./sign-out";

// Sign-out in the browser: what the account kept here goes even when its host cannot be told, and the result says which held.

const ALICE = "did:plc:alice";

test("signing out deletes the account's store and DM state even when its session cannot be revoked", async () => {
  // #given alice's store and DM state in this browser, and a host that cannot be reached
  const raw = new Map<string, string>([[`dm:${ALICE}:hidden-request:at://x`, "1"], ["dm:did:plc:bob:hidden-request:at://y", "1"]]);
  const storage = {
    get length() { return raw.size; },
    key: (index: number) => [...raw.keys()][index] ?? null,
    getItem: (key: string) => raw.get(key) ?? null,
    setItem: (key: string, value: string) => { raw.set(key, value); },
    removeItem: (key: string) => { raw.delete(key); },
  };
  const factory = new IDBFactory();
  Object.assign(globalThis, { indexedDB: factory, IDBKeyRange, localStorage: storage });
  (await IndexedDbStore.open(ALICE, factory)).close();

  // #when alice signs out
  const result = await signOutAccount(ALICE, async () => { throw new Error("the host cannot be reached"); });

  // #then her store and DM state are gone, bob's DM state is not, and the revoke is reported as not done
  assert.deepEqual(result, { revoked: false, erased: true });
  assert.deepEqual((await factory.databases()).map((database) => database.name), []);
  assert.deepEqual([...raw.keys()], ["dm:did:plc:bob:hidden-request:at://y"]);
});

test("a revoke and a deletion that both hold are reported as such", async () => {
  const factory = new IDBFactory();
  Object.assign(globalThis, { indexedDB: factory, IDBKeyRange });
  (await IndexedDbStore.open(ALICE, factory)).close();
  assert.deepEqual(await signOutAccount(ALICE, async () => undefined), { revoked: true, erased: true });
});
