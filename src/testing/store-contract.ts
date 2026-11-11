import assert from "node:assert/strict";
import test from "node:test";
import type { StoredRecord, SyncStore, WriterCommit } from "@/client/store";
import { channelUri } from "@/protocol/keys";
import { COLLECTION } from "@/protocol/nsids";

// What every `SyncStore` must do, run against each implementation: compare-and-set commits by generation, revision and
// epoch; replacing one writer's collection without touching others; purges that leave tombstones; and copies, not shared
// objects, handed out.

const SPACE = channelUri("did:plc:a", "one");
const OTHER = channelUri("did:plc:a", "two");
const MESSAGE = COLLECTION.message;
const REACTION = COLLECTION.reaction;

function record(space: string, repo: string, collection: string, rkey: string): StoredRecord {
  return { space, repo, collection, rkey, uri: `${space}/${repo}/${collection}/${rkey}`, cid: "", value: { text: rkey } };
}

function commit(repo: string, expectedGeneration: number | null, extra: Partial<WriterCommit> = {}): WriterCommit {
  return { space: SPACE, repo, expectedGeneration, next: { syncedRev: "r1", checkedAt: 1, stale: false, coverage: {} }, ...extra };
}

export function storeContract(name: string, open: () => Promise<SyncStore>): void {
  test(`${name}: a commit applies only over the generation it was computed from, and advances it`, async () => {
    const store = await open();
    assert.equal(await store.commit(commit("did:plc:w", 0)), true);
    assert.equal((await store.getWriter(SPACE, "did:plc:w"))!.generation, 1);
    assert.equal(await store.commit(commit("did:plc:w", 0)), false, "a commit computed from generation 0 is refused at 1");
    assert.equal(await store.commit(commit("did:plc:w", null)), true, "an unconditional commit applies");
    assert.equal((await store.getWriter(SPACE, "did:plc:w"))!.generation, 2);
  });

  test(`${name}: two commits from one generation at once: exactly one applies`, async () => {
    const store = await open();
    const epoch = await store.epoch(SPACE);
    const results = await Promise.all([
      store.commit(commit("did:plc:w", 0, { epoch, rev: "r9", next: { syncedRev: "r9", checkedAt: 1, stale: false, coverage: {} } })),
      store.commit(commit("did:plc:w", 0, { epoch, rev: "r1", next: { syncedRev: "r1", checkedAt: 1, stale: false, coverage: {} } })),
    ]);
    assert.deepEqual(results.filter(Boolean).length, 1);
    assert.equal((await store.getWriter(SPACE, "did:plc:w"))!.generation, 1);
  });

  test(`${name}: marking a writer stale keeps its state, and is never lost to a concurrent commit`, async () => {
    const store = await open();
    await store.commit(commit("did:plc:w", 0, { rev: "r5", next: { syncedRev: "r5", checkedAt: 7, stale: false, coverage: { [MESSAGE]: { strategy: "window", lowest: "a", complete: false, cursor: "c" } } } }));
    // A hint lands while a refresh computed from generation 1 commits: whichever applies first, the writer ends stale.
    const [refreshed] = await Promise.all([
      store.commit(commit("did:plc:w", 1, { rev: "r6", next: { syncedRev: "r6", checkedAt: 8, stale: false, coverage: {} } })),
      store.commit({ space: SPACE, repo: "did:plc:w", expectedGeneration: null, markStale: true }),
    ]);
    const state = (await store.getWriter(SPACE, "did:plc:w"))!;
    assert.equal(state.stale, true, "a hint is never lost to a concurrent refresh");
    assert.deepEqual([state.syncedRev, state.generation], refreshed ? ["r6", 3] : ["r5", 2]);
  });

  test(`${name}: a commit with a revision older than the stored one is refused`, async () => {
    const store = await open();
    await store.commit(commit("did:plc:w", 0, { rev: "r5", next: { syncedRev: "r5", checkedAt: 1, stale: false, coverage: {} } }));
    assert.equal(await store.commit(commit("did:plc:w", 1, { rev: "r4" })), false);
    assert.equal(await store.commit(commit("did:plc:w", 1, { rev: "r5" })), true);
  });

  test(`${name}: replacing a writer's collection leaves its other collections and other writers alone`, async () => {
    const store = await open();
    await store.commit(commit("did:plc:w", 0, { upsert: [record(SPACE, "did:plc:w", MESSAGE, "a"), record(SPACE, "did:plc:w", REACTION, "r")] }));
    await store.commit(commit("did:plc:v", 0, { upsert: [record(SPACE, "did:plc:v", MESSAGE, "a")] }));
    await store.commit(commit("did:plc:w", 1, { replace: { [MESSAGE]: [record(SPACE, "did:plc:w", MESSAGE, "b")] } }));
    assert.deepEqual((await store.records(SPACE, MESSAGE, "did:plc:w")).map((held) => held.rkey), ["b"]);
    assert.deepEqual((await store.records(SPACE, REACTION, "did:plc:w")).map((held) => held.rkey), ["r"]);
    assert.deepEqual((await store.records(SPACE, MESSAGE)).map((held) => `${held.repo} ${held.rkey}`).sort(), ["did:plc:v a", "did:plc:w b"]);
    assert.deepEqual([...(await store.counts(SPACE, MESSAGE))].sort(), [["did:plc:v", 1], ["did:plc:w", 1]]);
    await store.commit(commit("did:plc:w", 2, { remove: [{ collection: MESSAGE, rkey: "b" }] }));
    assert.equal(await store.getRecord(SPACE, "did:plc:w", MESSAGE, "b"), undefined);
  });

  test(`${name}: purging a writer drops its records and leaves a tombstone a stale commit cannot pass`, async () => {
    const store = await open();
    await store.commit(commit("did:plc:w", 0, { upsert: [record(SPACE, "did:plc:w", MESSAGE, "a")] }));
    await store.purgeWriter(SPACE, "did:plc:w");
    assert.deepEqual(await store.records(SPACE, MESSAGE), []);
    assert.equal(await store.commit(commit("did:plc:w", 1)), false);
    const tombstone = (await store.getWriter(SPACE, "did:plc:w"))!;
    assert.deepEqual([tombstone.syncedRev, tombstone.coverage, tombstone.generation], [null, {}, 2]);
  });

  test(`${name}: purging a space drops it alone and advances its epoch, so commits computed before refuse`, async () => {
    const store = await open();
    await store.putSpace({ space: SPACE, spaceRev: null, writers: [], writersListedAt: null, workspace: null, lastOpenedAt: 1 });
    await store.commit(commit("did:plc:w", 0, { upsert: [record(SPACE, "did:plc:w", MESSAGE, "a")] }));
    await store.commit({ ...commit("did:plc:w", 0), space: OTHER, upsert: [record(OTHER, "did:plc:w", MESSAGE, "a")] });
    const before = await store.epoch(SPACE);
    await store.purgeSpace(SPACE);
    assert.notEqual(await store.epoch(SPACE), before);
    assert.equal(await store.getSpace(SPACE), undefined);
    assert.deepEqual(await store.records(SPACE, MESSAGE), []);
    assert.equal((await store.records(OTHER, MESSAGE)).length, 1);
    assert.equal(await store.commit(commit("did:plc:w", null, { epoch: before })), false);
    assert.equal(await store.commit(commit("did:plc:w", null, { epoch: await store.epoch(SPACE) })), true);
  });

  test(`${name}: clear drops everything and refuses commits computed before it`, async () => {
    const store = await open();
    await store.putSpace({ space: SPACE, spaceRev: null, writers: [], writersListedAt: null, workspace: null, lastOpenedAt: 1 });
    await store.commit(commit("did:plc:w", 0, { upsert: [record(SPACE, "did:plc:w", MESSAGE, "a")] }));
    const before = await store.epoch(SPACE);
    await store.clear();
    assert.deepEqual(await store.listSpaces(), []);
    assert.deepEqual(await store.records(SPACE, MESSAGE), []);
    assert.equal(await store.commit(commit("did:plc:w", null, { epoch: before })), false);
  });

  test(`${name}: a resolved identity is kept by kind and DID, and clear drops it`, async () => {
    const store = await open();
    await store.putIdentity({ kind: "pds", did: "did:plc:w", value: "https://pds.test", resolvedAt: 1 });
    await store.putIdentity({ kind: "kem", did: "did:plc:w", value: "did:key:z", resolvedAt: 2 });
    await store.putIdentity({ kind: "pds", did: "did:plc:w", value: "https://moved.test", resolvedAt: 3 });
    assert.deepEqual(await store.getIdentity("pds", "did:plc:w"), { kind: "pds", did: "did:plc:w", value: "https://moved.test", resolvedAt: 3 });
    assert.equal((await store.getIdentity("kem", "did:plc:w"))!.value, "did:key:z");
    await store.purgeSpace(SPACE);
    assert.notEqual(await store.getIdentity("pds", "did:plc:w"), undefined, "a purge drops a space, not who its writers are");
    await store.clear();
    assert.equal(await store.getIdentity("pds", "did:plc:w"), undefined);
  });

  test(`${name}: what the store hands out is a copy`, async () => {
    const store = await open();
    await store.commit(commit("did:plc:w", 0, { upsert: [record(SPACE, "did:plc:w", MESSAGE, "a")] }));
    const [held] = await store.records(SPACE, MESSAGE);
    held!.value.text = "changed";
    assert.equal((await store.getRecord(SPACE, "did:plc:w", MESSAGE, "a"))!.value.text, "a");
  });
}
