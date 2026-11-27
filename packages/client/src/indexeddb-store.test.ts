import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { storeContract } from "./testing/store-contract";
import { IndexedDbStore } from "./indexeddb-store";
import { LTHASH_STATE_BYTES, SyncStoreError } from "./store";
import { channelUri } from "@flock/protocol/keys";
import { COLLECTION } from "@flock/protocol/nsids";

// The browser store under fake-indexeddb: the same contract as the memory store, plus one database per account.

Object.assign(globalThis, { IDBKeyRange });

let account = 0;
storeContract("IndexedDB store", async () => IndexedDbStore.open(`did:plc:contract${account++}`, new IDBFactory()));

test("a store is per account, and starting as another account deletes the stores that are not its own", async () => {
  const factory = new IDBFactory();
  const alice = await IndexedDbStore.open("did:plc:alice", factory);
  await alice.putSpace({ space: "at:space/did:plc:a/new.flock.channel/one", spaceRev: null, writers: [], writersListedAt: null, workspace: null, lastOpenedAt: 1 });
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

test("signing out deletes the account's store and leaves another account's", async () => {
  // #given alice's store with a space in it, closed as sign-out closes it, and bob's
  const factory = new IDBFactory();
  const alice = await IndexedDbStore.open("did:plc:alice", factory);
  await alice.putSpace({ space: "at:space/did:plc:a/new.flock.channel/one", spaceRev: null, writers: [], writersListedAt: null, workspace: null, lastOpenedAt: 1 });
  alice.close();
  (await IndexedDbStore.open("did:plc:bob", factory)).close();

  // #when alice signs out
  await IndexedDbStore.deleteAccount("did:plc:alice", factory);

  // #then her database is gone, and opening it again finds nothing
  assert.deepEqual((await factory.databases()).map((database) => database.name), ["flock-sync-did:plc:bob"]);
  const reopened = await IndexedDbStore.open("did:plc:alice", factory);
  assert.deepEqual(await reopened.listSpaces(), []);
  reopened.close();
});

test("v1 IndexedDB database upgrades cleanly to v2 without ConstraintError and preserves all v1 state and meta epochs", async () => {
  const factory = new IDBFactory();
  const did = "did:plc:migrate";
  const dbName = `flock-sync-${did}`;
  const space = channelUri("did:plc:host", "migrated");
  const writer = "did:plc:writer1";
  const collection = COLLECTION.message;

  // Seed a v1 database matching the pre-R11 schema (v1 stores + populated data, no activity/clock stores).
  const v1Db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = factory.open(dbName, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("spaces", { keyPath: "space" });
      db.createObjectStore("writers", { keyPath: ["space", "repo"] }).createIndex("space", "space");
      db.createObjectStore("records", { keyPath: ["space", "collection", "repo", "rkey"] }).createIndex("writer", ["space", "repo"]);
      db.createObjectStore("meta", { keyPath: "key" });
      db.createObjectStore("identities", { keyPath: ["kind", "did"] });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  await new Promise<void>((resolve, reject) => {
    const tx = v1Db.transaction(["spaces", "writers", "records", "meta", "identities"], "readwrite");
    tx.objectStore("spaces").put({ space, spaceRev: "rev-0", writers: [writer], writersListedAt: 10, workspace: null, lastOpenedAt: 20 });
    tx.objectStore("writers").put({ space, repo: writer, generation: 4, syncedRev: "rev-w1", checkedAt: 30, stale: false, coverage: { [collection]: "full" } });
    tx.objectStore("records").put({
      space,
      collection,
      repo: writer,
      rkey: "m1",
      uri: `${space}/${writer}/${collection}/m1`,
      cid: "bafy-old",
      value: { text: "from-v1" },
    });
    tx.objectStore("meta").put({ key: "clears", value: 2 });
    tx.objectStore("meta").put({ key: `purges ${space}`, value: 3 });
    tx.objectStore("identities").put({ kind: "pds", did: writer, value: "https://pds.example", checkedAt: 40 });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  v1Db.close();

  // Opening IndexedDbStore v2 upgrades in-place cleanly without throwing ConstraintError.
  const store = await IndexedDbStore.open(did, factory);
  try {
    assert.equal((await store.getSpace(space))?.spaceRev, "rev-0");
    const migratedWriter = (await store.getWriter(space, writer))!;
    assert.equal(migratedWriter.generation, 4);
    assert.equal(migratedWriter.syncedRev, "rev-w1");
    assert.equal(migratedWriter.setHash, undefined, "migrated v1 writer keeps setHash undefined for cold STAR/full recovery");
    assert.equal(migratedWriter.commitDigest, undefined);
    assert.equal((await store.getRecord(space, writer, collection, "m1"))?.value.text, "from-v1");
    assert.equal((await store.getIdentity("pds", writer))?.value, "https://pds.example");

    const epochBefore = await store.epoch(space);
    assert.ok(epochBefore.includes("2") && epochBefore.includes("3"), `expected v1 meta epoch to survive, got ${epochBefore}`);
    await store.purgeSpace(space);
    assert.notEqual(await store.epoch(space), epochBefore);

    // New v2 stores work immediately after migration.
    const clock = await store.updateClock(did, { lastTidMs: 5_000, lastClockId: 1, ownLastHlc: "2026-11-17T00:00:05.000Z-0000-w" });
    assert.equal(clock.lastTidMs, 5_000);
    const activity = await store.markActivitySeen(did, space, ["e1"], 99);
    assert.deepEqual(activity.seenIds, ["e1"]);
  } finally {
    store.close();
  }
});

test("IndexedDbStore rolls back failed commits and failed clock updates atomically without partial writes", async () => {
  const factory = new IDBFactory();
  const did = "did:plc:rollback";
  const store = await IndexedDbStore.open(did, factory);
  const space = channelUri("did:plc:host", "rb");
  const repo = "did:plc:writer";
  try {
    await store.updateClock(did, { lastTidMs: 1_000, lastClockId: 1 });
    assert.equal(await store.commit({
      space,
      repo,
      expectedGeneration: 0,
      upsert: [{ space, repo, collection: COLLECTION.message, rkey: "ok", uri: `${space}/${repo}/${COLLECTION.message}/ok`, cid: "cid-ok", value: { text: "ok" } }],
      next: { syncedRev: "r1", checkedAt: 1, stale: false, coverage: {}, setHash: new Uint8Array(LTHASH_STATE_BYTES).fill(2) },
    }), true);

    // Rejecting inside commit (invalid setHash length) must not persist upsert or clock.
    await assert.rejects(
      () =>
        store.commit({
          space,
          repo,
          expectedGeneration: 1,
          upsert: [{ space, repo, collection: COLLECTION.message, rkey: "bad", uri: `${space}/${repo}/${COLLECTION.message}/bad`, cid: "cid-bad", value: { text: "bad" } }],
          clock: { accountDid: did, lastTidMs: 9_000, lastClockId: 9 },
          next: { syncedRev: "r2", checkedAt: 2, stale: false, coverage: {}, setHash: new Uint8Array(99) },
        }),
      SyncStoreError,
    );

    // Non-serializable record value triggering DataCloneError inside IDB put after prior writes aborts atomically.
    const uncloneable: Record<string, unknown> = { bad: () => undefined };
    await assert.rejects(
      () =>
        store.commit({
          space,
          repo,
          expectedGeneration: 1,
          upsert: [{ space, repo, collection: COLLECTION.message, rkey: "badfn", uri: `${space}/${repo}/${COLLECTION.message}/badfn`, cid: "cid-fn", value: uncloneable }],
          clock: { accountDid: did, lastTidMs: 8_000, lastClockId: 8 },
          next: { syncedRev: "r2", checkedAt: 2, stale: false, coverage: {} },
        }),
      SyncStoreError,
    );

    await assert.rejects(
      () =>
        store.updateClock(did, () => {
          throw new Error("boom");
        }),
      SyncStoreError,
    );

    assert.equal((await store.getWriter(space, repo))!.generation, 1);
    assert.equal(await store.getRecord(space, repo, COLLECTION.message, "bad"), undefined);
    assert.equal(await store.getRecord(space, repo, COLLECTION.message, "badfn"), undefined);
    assert.equal((await store.getClock(did))!.lastTidMs, 1_000);
  } finally {
    store.close();
  }
});

test("deleteAccount wipes persisted activity and clock state alongside spaces without touching other accounts", async () => {
  const factory = new IDBFactory();
  const space = channelUri("did:plc:host", "wipe");
  const alice = await IndexedDbStore.open("did:plc:alice", factory);
  await alice.markActivitySeen("did:plc:alice", space, ["a1"], 10);
  await alice.dismissActivity("did:plc:alice", space, ["a2"], 20);
  await alice.updateClock("did:plc:alice", { lastTidMs: 1_234, lastClockId: 3 });
  alice.close();

  const bob = await IndexedDbStore.open("did:plc:bob", factory);
  await bob.markActivitySeen("did:plc:bob", space, ["b1"], 15);
  await bob.updateClock("did:plc:bob", { lastTidMs: 4_567, lastClockId: 4 });
  bob.close();

  await IndexedDbStore.deleteAccount("did:plc:alice", factory);

  const reopenedAlice = await IndexedDbStore.open("did:plc:alice", factory);
  assert.equal(await reopenedAlice.getActivityState("did:plc:alice", space), undefined);
  assert.equal(await reopenedAlice.getClock("did:plc:alice"), undefined);
  reopenedAlice.close();

  const reopenedBob = await IndexedDbStore.open("did:plc:bob", factory);
  assert.deepEqual((await reopenedBob.getActivityState("did:plc:bob", space))?.seenIds, ["b1"]);
  assert.equal((await reopenedBob.getClock("did:plc:bob"))?.lastTidMs, 4_567);
  reopenedBob.close();
});

test("onversionchange closes existing IndexedDbStore cleanly so a v5 upgrade does not wedge", async () => {
  const factory = new IDBFactory();
  const did = "did:plc:versionchange";
  let closedCount = 0;
  const store1 = await IndexedDbStore.open(did, factory, () => {
    closedCount++;
  });

  // Upgrade the same database to version 5 from a second connection; store1 must close and unblock cleanly.
  const upgraded = new Promise<IDBDatabase>((resolve, reject) => {
    const req = factory.open(`flock-sync-${did}`, 5);
    req.onupgradeneeded = () => {
      // No-op v5 upgrade.
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  const v5Db = await Promise.race([
    upgraded,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("v5 upgrade wedged waiting on store1")), 1_000)),
  ]);
  v5Db.close();

  assert.equal(closedCount, 1);
  await assert.rejects(() => store1.listSpaces(), SyncStoreError);
});

test("v3 IndexedDB database upgrades cleanly to v4 rewriting legacy at://<did>/space/... keys across all stores", async () => {
  const factory = new IDBFactory();
  const did = "did:plc:migratev4";
  const dbName = `flock-sync-${did}`;
  const oldSpace = "at://did:plc:host/space/new.flock.channel/general";
  const newSpace = "at:space/did:plc:host/new.flock.channel/general";
  const oldWs = "at://did:plc:host/space/new.flock.workspace/self";
  const newWs = "at:space/did:plc:host/new.flock.workspace/self";
  const oldRec = `${oldSpace}/did:plc:alice/${COLLECTION.message}/2222222222222`;
  const newRec = `${newSpace}/did:plc:alice/${COLLECTION.message}/2222222222222`;
  const oldInvite = "at://did:plc:migratev4/space/group.opensocial.invites/self/did:plc:host/group.opensocial.invite/2222222222222";
  const newInvite = "at:space/did:plc:migratev4/group.opensocial.invites/self/did:plc:host/group.opensocial.invite/2222222222222";

  const v3Db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = factory.open(dbName, 3);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("spaces", { keyPath: "space" });
      db.createObjectStore("writers", { keyPath: ["space", "repo"] }).createIndex("space", "space");
      db.createObjectStore("records", { keyPath: ["space", "collection", "repo", "rkey"] }).createIndex("writer", ["space", "repo"]);
      db.createObjectStore("meta", { keyPath: "key" });
      db.createObjectStore("identities", { keyPath: ["kind", "did"] });
      db.createObjectStore("activity", { keyPath: ["accountDid", "space"] }).createIndex("space", "space");
      db.createObjectStore("clock", { keyPath: ["accountDid", "scope"] }).createIndex("scope", "scope");
      db.createObjectStore("leavingGroups", { keyPath: "groupDid" });
      db.createObjectStore("joiningGroups", { keyPath: "operationId" });
      db.createObjectStore("reactivatingGroups", { keyPath: "operationId" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  await new Promise<void>((resolve, reject) => {
    const tx = v3Db.transaction(["spaces", "writers", "records", "meta", "activity", "clock", "joiningGroups"], "readwrite");
    tx.objectStore("spaces").put({ space: oldSpace, spaceRev: "2222222222222", writers: ["did:plc:alice"], writersListedAt: 10, workspace: oldWs, lastOpenedAt: 20 });
    tx.objectStore("writers").put({ space: oldSpace, repo: "did:plc:alice", generation: 1, syncedRev: "2222222222222", checkedAt: 30, stale: false, coverage: {} });
    tx.objectStore("records").put({ space: oldSpace, collection: COLLECTION.message, repo: "did:plc:alice", rkey: "2222222222222", uri: oldRec, cid: "bafy1", value: { text: "hi" } });
    tx.objectStore("meta").put({ key: `purges ${oldSpace}`, value: 7 });
    tx.objectStore("activity").put({ accountDid: did, space: oldSpace, seenIds: ["e1"], dismissedIds: [], updatedAt: 50 });
    tx.objectStore("clock").put({ accountDid: did, scope: oldSpace, lastTidMs: 100, lastHlcMs: 100, lastHlcCounter: 0 });
    tx.objectStore("joiningGroups").put({ operationId: "op1", groupDid: "did:plc:host", mode: "invite", inviteUri: oldInvite, phase: "submitting", createdAt: 60 });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  v3Db.close();

  const store = await IndexedDbStore.open(did, factory);
  try {
    assert.equal(await store.getSpace(oldSpace), undefined);
    const sp = await store.getSpace(newSpace);
    assert.equal(sp?.workspace, newWs);
    assert.equal((await store.getWriter(newSpace, "did:plc:alice"))?.syncedRev, "2222222222222");
    assert.equal((await store.getRecord(newSpace, "did:plc:alice", COLLECTION.message, "2222222222222"))?.uri, newRec);
    assert.equal(await store.epoch(newSpace), "0:7");
    assert.deepEqual((await store.getActivityState(did, newSpace))?.seenIds, ["e1"]);
    assert.equal((await store.getClock(did, newSpace))?.lastTidMs, 100);
    assert.equal((await store.getJoiningGroup("op1"))?.inviteUri, newInvite);
  } finally {
    store.close();
  }
});
