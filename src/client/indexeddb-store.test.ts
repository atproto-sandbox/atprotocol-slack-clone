import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { storeContract } from "@/testing/store-contract";
import { IndexedDbStore } from "./indexeddb-store";

// The browser store under fake-indexeddb: the same contract as the memory store, plus one database per account.

Object.assign(globalThis, { IDBKeyRange });

let account = 0;
storeContract("IndexedDB store", async () => IndexedDbStore.open(`did:plc:contract${account++}`, new IDBFactory()));

test("a store is per account, and starting as another account deletes the stores that are not its own", async () => {
  const factory = new IDBFactory();
  const alice = await IndexedDbStore.open("did:plc:alice", factory);
  await alice.putSpace({ space: "at://did:plc:a/space/new.flock.channel/one", spaceRev: null, writers: [], writersListedAt: null, workspace: null, lastOpenedAt: 1 });
  alice.close();
  const bob = await IndexedDbStore.open("did:plc:bob", factory);
  assert.deepEqual(await bob.listSpaces(), [], "bob does not see alice's store");
  await IndexedDbStore.deleteOtherAccounts("did:plc:bob", factory);
  assert.deepEqual((await factory.databases()).map((database) => database.name), ["flock-sync-did:plc:bob"]);
  bob.close();
});

test("an account's store left open in another tab does not hold up the next account's start", async () => {
  // #given alice's store still open, as in a tab left behind
  const factory = new IDBFactory();
  let told = false;
  const alice = await IndexedDbStore.open("did:plc:alice", factory, () => { told = true; });

  // #when bob starts and deletes the stores that are not his
  await IndexedDbStore.open("did:plc:bob", factory);
  const deleted = IndexedDbStore.deleteOtherAccounts("did:plc:bob", factory);
  const outcome = await Promise.race([deleted.then(() => "deleted"), new Promise((resolve) => setTimeout(() => resolve("still waiting"), 1_000))]);
  alice.close();
  await deleted;

  // #then alice's open store had let go of its database by itself, said so, and it was deleted
  assert.equal(outcome, "deleted");
  assert.equal(told, true, "the tab holding alice's store is told it was closed");
  assert.deepEqual((await factory.databases()).map((database) => database.name), ["flock-sync-did:plc:bob"]);
});
