import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { IndexedDbStore } from "@flock/client/indexeddb-store";
import { tasksSpaceUri } from "@flock/protocol/keys";
import { signOutAccount } from "./sign-out";

// Sign-out in the browser: what the account kept here goes even when its host cannot be told, and the result says which held.

const ALICE = "did:plc:alice";
const BOB = "did:plc:bob";

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

test("D11.7: signing out completely erases IndexedDbStore activity and clock state while leaving other accounts untouched", async () => {
  const factory = new IDBFactory();
  const tasksSpace = tasksSpaceUri("did:plc:authority", "acme");
  const raw = new Map<string, string>();
  const storage = {
    get length() { return raw.size; },
    key: (index: number) => [...raw.keys()][index] ?? null,
    getItem: (key: string) => raw.get(key) ?? null,
    setItem: (key: string, value: string) => { raw.set(key, value); },
    removeItem: (key: string) => { raw.delete(key); },
  };
  Object.assign(globalThis, { indexedDB: factory, IDBKeyRange, localStorage: storage });

  const aliceStore = await IndexedDbStore.open(ALICE, factory);
  await aliceStore.putSpace({
    space: tasksSpace,
    spaceRev: "3k22222222222",
    writers: [{ did: ALICE, repoRev: "3k22222222222" }],
    writersListedAt: 1_000,
    workspace: null,
    lastOpenedAt: 1_000,
  });
  await aliceStore.markActivitySeen(ALICE, tasksSpace, ["field:ev1", "delete:ev2"], 100);
  await aliceStore.dismissActivity(ALICE, tasksSpace, ["delete:ev2", "set:ev3"], 200);
  await aliceStore.updateClock(ALICE, {
    lastTidMs: 1_700_000_000_100,
    lastClockId: 17,
    ownLastHlc: "001700000000100.0003",
  }, "");
  await aliceStore.updateClock(ALICE, {
    lastTidMs: 1_700_000_000_200,
    lastClockId: 18,
    ownLastHlc: "001700000000200.0001",
  }, tasksSpace);
  aliceStore.close();

  const bobStore = await IndexedDbStore.open(BOB, factory);
  await bobStore.markActivitySeen(BOB, tasksSpace, ["bob-ev1"], 300);
  await bobStore.updateClock(BOB, {
    lastTidMs: 1_700_000_000_999,
    lastClockId: 42,
    ownLastHlc: "001700000000999.0009",
  }, "");
  bobStore.close();

  const result = await signOutAccount(ALICE, async () => undefined);
  assert.deepEqual(result, { revoked: true, erased: true });
  assert.deepEqual((await factory.databases()).map((db) => db.name), [`flock-sync-${BOB}`]);

  const reopenedAlice = await IndexedDbStore.open(ALICE, factory);
  assert.deepEqual(await reopenedAlice.listSpaces(), []);
  assert.equal(await reopenedAlice.getActivityState(ALICE, tasksSpace), undefined);
  assert.equal(await reopenedAlice.getClock(ALICE, ""), undefined);
  assert.equal(await reopenedAlice.getClock(ALICE, tasksSpace), undefined);
  reopenedAlice.close();

  const reopenedBob = await IndexedDbStore.open(BOB, factory);
  assert.deepEqual((await reopenedBob.getActivityState(BOB, tasksSpace))?.seenIds, ["bob-ev1"]);
  assert.deepEqual(await reopenedBob.getClock(BOB, ""), {
    accountDid: BOB,
    scope: "",
    lastTidMs: 1_700_000_000_999,
    lastClockId: 42,
    ownLastHlc: "001700000000999.0009",
  });
  reopenedBob.close();
});
