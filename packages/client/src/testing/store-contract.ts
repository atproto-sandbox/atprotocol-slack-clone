import assert from "node:assert/strict";
import test from "node:test";
import { COMMIT_DIGEST_BYTES, LTHASH_STATE_BYTES, SyncStoreError, type StoredRecord, type SyncStore, type WriterCommit } from "../store";
import { channelUri, workspaceUri } from "@flock/protocol/keys";
import { COLLECTION } from "@flock/protocol/nsids";

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

  test(`${name}: invalidateSpace bumps invalidationSeq atomically, marks unpersisted extraRepos stale, and blocks stale expectedInvalidationSeq commits`, async () => {
    const store = await open();
    // Cold space with no SpaceState or WriterState yet: invalidationSeq starts at 0.
    assert.equal(await store.getSpace(SPACE), undefined);
    assert.equal(await store.getWriter(SPACE, "did:plc:auth"), undefined);

    await store.invalidateSpace(SPACE, ["did:plc:auth"]);
    const invalidatedSpace = (await store.getSpace(SPACE))!;
    assert.equal(invalidatedSpace.invalidationSeq, 1);
    assert.equal(invalidatedSpace.writersListedAt, null);
    const invalidatedWriter = (await store.getWriter(SPACE, "did:plc:auth"))!;
    assert.equal(invalidatedWriter.stale, true);
    assert.equal(invalidatedWriter.generation, 1);

    // Pre-invalidation generation-0 commit fails BOTH expectedGeneration AND expectedInvalidationSeq!
    assert.equal(await store.commit(commit("did:plc:auth", 0, { expectedInvalidationSeq: 0 })), false);
    // Even on an unrelated cold repo with generation 0, expectedInvalidationSeq: 0 is rejected atomically.
    assert.equal(await store.commit(commit("did:plc:cold2", 0, { expectedInvalidationSeq: 0 })), false);
    // Commit matching current invalidationSeq: 1 and generation: 1 succeeds and clears stale.
    assert.equal(await store.commit(commit("did:plc:auth", 1, { expectedInvalidationSeq: 1 })), true);
    assert.equal((await store.getWriter(SPACE, "did:plc:auth"))!.stale, false);

    // putSpace must never regress invalidationSeq.
    await store.putSpace({ space: SPACE, spaceRev: null, writers: [], writersListedAt: 100, workspace: null, lastOpenedAt: 100 });
    assert.equal((await store.getSpace(SPACE))!.invalidationSeq, 1);
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

  test(`${name}: writer setHash (2048B) and commitDigest (32B) persist, survive markStale, reject bad sizes, and copy buffers`, async () => {
    const store = await open();
    const setHash = new Uint8Array(LTHASH_STATE_BYTES).fill(7);
    const commitDigest = new Uint8Array(COMMIT_DIGEST_BYTES).fill(9);
    assert.equal(await store.commit(commit("did:plc:w", 0, {
      upsert: [record(SPACE, "did:plc:w", MESSAGE, "a")],
      next: { syncedRev: "r1", checkedAt: 1, stale: false, coverage: {}, setHash, commitDigest },
    })), true);

    // Input buffers must be defensively cloned.
    setHash.fill(0);
    commitDigest.fill(0);

    const writer = (await store.getWriter(SPACE, "did:plc:w"))!;
    assert.equal(writer.setHash?.byteLength, LTHASH_STATE_BYTES);
    assert.equal(writer.commitDigest?.byteLength, COMMIT_DIGEST_BYTES);
    assert.equal(writer.setHash?.[0], 7);
    assert.equal(writer.setHash?.[LTHASH_STATE_BYTES - 1], 7);
    assert.equal(writer.commitDigest?.[0], 9);
    assert.equal(writer.commitDigest?.[COMMIT_DIGEST_BYTES - 1], 9);

    // Output buffers must also be defensively cloned across getWriter and listWriters.
    writer.setHash!.fill(1);
    writer.commitDigest!.fill(2);
    const [listed] = await store.listWriters(SPACE);
    assert.equal(listed?.setHash?.[0], 7);
    assert.equal(listed?.commitDigest?.[0], 9);
    listed!.setHash!.fill(3);
    assert.equal((await store.getWriter(SPACE, "did:plc:w"))!.setHash?.[0], 7);

    // markStale MUST preserve setHash and commitDigest rather than dropping them.
    assert.equal(await store.commit({ space: SPACE, repo: "did:plc:w", expectedGeneration: null, markStale: true }), true);
    const staleWriter = (await store.getWriter(SPACE, "did:plc:w"))!;
    assert.equal(staleWriter.stale, true);
    assert.equal(staleWriter.setHash?.[0], 7);
    assert.equal(staleWriter.commitDigest?.[0], 9);

    // Invalid buffer sizes must be rejected without mutating writer state or records.
    await assert.rejects(
      () => store.commit(commit("did:plc:w", null, {
        upsert: [record(SPACE, "did:plc:w", MESSAGE, "bad-hash")],
        next: { syncedRev: "r2", checkedAt: 2, stale: false, coverage: {}, setHash: new Uint8Array(64) },
      })),
    );
    await assert.rejects(
      () => store.commit(commit("did:plc:w", null, {
        upsert: [record(SPACE, "did:plc:w", MESSAGE, "bad-digest")],
        next: { syncedRev: "r2", checkedAt: 2, stale: false, coverage: {}, commitDigest: new Uint8Array(16) },
      })),
    );
    assert.equal(await store.getRecord(SPACE, "did:plc:w", MESSAGE, "bad-hash"), undefined);
    assert.equal(await store.getRecord(SPACE, "did:plc:w", MESSAGE, "bad-digest"), undefined);
    assert.equal((await store.getWriter(SPACE, "did:plc:w"))!.syncedRev, "r1");

    // purgeWriter and purgeSpace reset hashes back to undefined, and purgeWriter enforces epoch/invalidationSeq/generation CAS.
    await store.putSpace({
      space: SPACE,
      spaceRev: "s1",
      writers: [{ did: "did:plc:w", repoRev: "r1" }],
      writersListedAt: 1,
      workspace: null,
      lastOpenedAt: 1,
      invalidationSeq: 2,
    });
    const prePurgeWriter = (await store.getWriter(SPACE, "did:plc:w"))!;
    const liveEpoch = await store.epoch(SPACE);
    assert.equal(
      await store.putSpace(
        {
          space: SPACE,
          spaceRev: "s0-stale",
          writers: [],
          writersListedAt: 99,
          workspace: null,
          lastOpenedAt: 99,
        },
        { expectedInvalidationSeq: 1 },
      ),
      false,
      "putSpace must refuse mismatched expectedInvalidationSeq without overwriting writers or writersListedAt",
    );
    assert.equal((await store.getSpace(SPACE))?.spaceRev, "s1");
    assert.equal(
      await store.purgeWriter(SPACE, "did:plc:w", { expectedGeneration: prePurgeWriter.generation + 99 }),
      false,
      "purgeWriter must refuse mismatched expectedGeneration",
    );
    assert.equal(
      await store.purgeWriter(SPACE, "did:plc:w", { expectedInvalidationSeq: 1 }),
      false,
      "purgeWriter must refuse mismatched expectedInvalidationSeq",
    );
    assert.equal(
      await store.purgeWriter(SPACE, "did:plc:w", { epoch: "stale:epoch" }),
      false,
      "purgeWriter must refuse mismatched epoch",
    );
    assert.equal((await store.getWriter(SPACE, "did:plc:w"))!.syncedRev, "r1", "refused CAS purgeWriter preserves writer");
    assert.equal(
      await store.purgeWriter(SPACE, "did:plc:w", {
        epoch: liveEpoch,
        expectedInvalidationSeq: 2,
        expectedGeneration: prePurgeWriter.generation,
      }),
      true,
    );
    const afterWriterPurge = (await store.getWriter(SPACE, "did:plc:w"))!;
    assert.equal(afterWriterPurge.setHash, undefined);
    assert.equal(afterWriterPurge.commitDigest, undefined);

    await store.commit(commit("did:plc:w", null, {
      next: {
        syncedRev: "r3",
        checkedAt: 3,
        stale: false,
        coverage: {},
        setHash: new Uint8Array(LTHASH_STATE_BYTES).fill(4),
        commitDigest: new Uint8Array(COMMIT_DIGEST_BYTES).fill(5),
      },
    }));
    await store.purgeSpace(SPACE);
    const afterSpacePurge = (await store.getWriter(SPACE, "did:plc:w"))!;
    assert.equal(afterSpacePurge.setHash, undefined);
    assert.equal(afterSpacePurge.commitDigest, undefined);
  });

  test(`${name}: clock reservations are atomic, monotonic, and bound to commit/purge/clear semantics`, async () => {
    const store = await open();
    const account = "did:plc:me";
    assert.equal(await store.getClock(account), undefined);

    const reserved = await Promise.all(
      Array.from({ length: 8 }, () =>
        store.updateClock(account, (current) => ({
          lastTidMs: (current?.lastTidMs ?? 1_000) + 10,
          lastClockId: (current?.lastClockId ?? 0) + 1,
        })),
      ),
    );
    assert.deepEqual(
      reserved.map((entry) => entry.lastClockId).sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    assert.equal((await store.getClock(account))!.lastTidMs, 1_080);

    // Monotonicity never regresses on stale patches.
    await store.updateClock(account, { lastTidMs: 2_000, lastClockId: 5, ownLastHlc: "2026-11-17T00:00:05.000Z-0001-w" });
    const afterStalePatch = await store.updateClock(account, { lastTidMs: 1_500, lastClockId: 1, ownLastHlc: "2026-11-17T00:00:01.000Z-0000-w" });
    assert.equal(afterStalePatch.lastTidMs, 2_000);
    assert.equal(afterStalePatch.lastClockId, 5);
    assert.equal(afterStalePatch.ownLastHlc, "2026-11-17T00:00:05.000Z-0001-w");

    // Atomic commit.clock succeeds only when the commit itself applies.
    assert.equal(await store.commit(commit("did:plc:w", 0, {
      upsert: [record(SPACE, "did:plc:w", MESSAGE, "c1")],
      clock: { accountDid: account, lastTidMs: 2_100, lastClockId: 6, ownLastHlc: "2026-11-17T00:00:06.000Z-0000-w" },
    })), true);
    assert.equal((await store.getClock(account))!.lastTidMs, 2_100);

    // Rejected generation CAS must not advance clock.
    assert.equal(await store.commit(commit("did:plc:w", 0, {
      clock: { accountDid: account, lastTidMs: 9_999, lastClockId: 99, ownLastHlc: "2026-11-17T00:00:99.000Z-0000-w" },
    })), false);
    assert.equal((await store.getClock(account))!.lastTidMs, 2_100);

    // Space-scoped clock cleans on purgeSpace(SPACE), while account-wide clock (scope = "") stays monotonic.
    await store.updateClock(account, { lastTidMs: 300, lastClockId: 1 }, SPACE);
    await store.updateClock(account, { lastTidMs: 400, lastClockId: 2 }, OTHER);
    await store.purgeSpace(SPACE);
    assert.equal(await store.getClock(account, SPACE), undefined);
    assert.equal((await store.getClock(account, OTHER))!.lastTidMs, 400);
    assert.equal((await store.getClock(account))!.lastTidMs, 2_100);

    await store.clear();
    assert.equal(await store.getClock(account), undefined);
    assert.equal(await store.getClock(account, OTHER), undefined);
  });

  test(`${name}: activity state persists per account+space, deduplicates, copies arrays, and clears on purge/clear`, async () => {
    const store = await open();
    const account = "did:plc:me";
    assert.equal(await store.getActivityState(account, SPACE), undefined);

    const seen1 = await store.markActivitySeen(account, SPACE, ["ev-1", "ev-2", "ev-1"], 100);
    assert.deepEqual(seen1.seenIds, ["ev-1", "ev-2"]);
    assert.deepEqual(seen1.dismissedIds, []);
    assert.equal(seen1.updatedAt, 100);

    seen1.seenIds.push("mutated-caller");
    const dismissed1 = await store.dismissActivity(account, SPACE, ["ev-2", "ev-3"], 200);
    assert.deepEqual(dismissed1.seenIds, ["ev-1", "ev-2"]);
    assert.deepEqual(dismissed1.dismissedIds, ["ev-2", "ev-3"]);
    assert.equal(dismissed1.updatedAt, 200);

    await store.putActivityState({
      accountDid: account,
      space: OTHER,
      seenIds: ["other-1", "other-1"],
      dismissedIds: ["other-2"],
      updatedAt: 300,
    });

    await assert.rejects(() => store.putActivityState({ accountDid: "", space: SPACE, seenIds: [], dismissedIds: [], updatedAt: 1 }), SyncStoreError);
    await assert.rejects(() => store.putActivityState({ accountDid: account, space: "", seenIds: [], dismissedIds: [], updatedAt: 1 }), SyncStoreError);
    await assert.rejects(() => store.markActivitySeen("", SPACE, ["e"]), SyncStoreError);
    await assert.rejects(() => store.dismissActivity(account, "", ["e"]), SyncStoreError);

    await store.purgeSpace(SPACE);
    assert.equal(await store.getActivityState(account, SPACE), undefined);
    assert.deepEqual(await store.getActivityState(account, OTHER), {
      accountDid: account,
      space: OTHER,
      seenIds: ["other-1"],
      dismissedIds: ["other-2"],
      updatedAt: 300,
    });

    await store.clear();
    assert.equal(await store.getActivityState(account, OTHER), undefined);
  });

  test(`${name}: recordOptimistic captures earliest pre-sync prevRecord atomically, survives markStale, and clears on verified commit`, async () => {
    const store = await open();
    const alice = "did:plc:alice";
    const existing = record(SPACE, alice, MESSAGE, "r1");
    assert.equal(await store.commit({
      space: SPACE,
      repo: alice,
      expectedGeneration: 0,
      rev: "rev1",
      next: {
        syncedRev: "rev1",
        checkedAt: 100,
        stale: false,
        coverage: { [MESSAGE]: { strategy: "all", lowest: null, complete: true, cursor: null } },
        setHash: new Uint8Array(2048),
        commitDigest: new Uint8Array(32),
      },
      replace: { [MESSAGE]: [existing] },
    }), true);

    // First optimistic update on existing r1 captures existing; second optimistic update on r1 preserves existing;
    // optimistic create on r2 captures prevRecord: null; follow-up update on r2 preserves prevRecord: null.
    const v1 = { ...existing, cid: "cid-v1", value: { text: "v1" } };
    const v2 = { ...existing, cid: "cid-v2", value: { text: "v2" } };
    const r2a = { ...record(SPACE, alice, MESSAGE, "r2"), cid: "cid-r2a", value: { text: "r2a" } };
    const r2b = { ...r2a, cid: "cid-r2b", value: { text: "r2b" } };

    assert.equal(await store.commit({
      space: SPACE, repo: alice, expectedGeneration: null, markStale: true, recordOptimistic: true, upsert: [v1, r2a],
    }), true);
    assert.equal(await store.commit({
      space: SPACE, repo: alice, expectedGeneration: null, markStale: true, recordOptimistic: true, upsert: [v2, r2b],
    }), true);
    // Plain markStale preserves optimisticOverlay.
    assert.equal(await store.commit({
      space: SPACE, repo: alice, expectedGeneration: null, markStale: true,
    }), true);

    const state = await store.getWriter(SPACE, alice);
    assert.ok(state?.optimisticOverlay);
    assert.deepEqual(state.optimisticOverlay, [
      { collection: MESSAGE, rkey: "r1", prevRecord: existing },
      { collection: MESSAGE, rkey: "r2", prevRecord: null },
    ]);

    // Next verified commit clears optimisticOverlay.
    assert.equal(await store.commit({
      space: SPACE,
      repo: alice,
      expectedGeneration: state.generation,
      rev: "rev2",
      next: {
        syncedRev: "rev2",
        checkedAt: 200,
        stale: false,
        coverage: { [MESSAGE]: { strategy: "all", lowest: null, complete: true, cursor: null } },
        setHash: new Uint8Array(2048),
        commitDigest: new Uint8Array(32),
      },
    }), true);
    assert.equal((await store.getWriter(SPACE, alice))?.optimisticOverlay, undefined);
  });

  test(`${name}: OpenSocial leavingGroups, joiningGroups, reactivatingGroups, and deleteIdentity persist, clone defensively, reject empty keys, and clear`, async () => {
    const store = await open();
    const groupDid = "did:plc:222222222222222222222222";

    await store.putIdentity({ kind: "pds", did: groupDid, value: "https://gh1.example", resolvedAt: 10 });
    assert.equal((await store.getIdentity("pds", groupDid))?.value, "https://gh1.example");
    await store.deleteIdentity("pds", groupDid);
    assert.equal(await store.getIdentity("pds", groupDid), undefined);

    const leaveInput = {
      groupDid,
      expectedIncarnation: "inc-1",
      phase: "leaving_group" as const,
      createdAt: 100,
    };
    await store.putLeavingGroup(leaveInput);
    leaveInput.expectedIncarnation = "mutated";
    const fetchedLeave = await store.getLeavingGroup(groupDid);
    assert.deepEqual(fetchedLeave, {
      groupDid,
      expectedIncarnation: "inc-1",
      phase: "leaving_group",
      createdAt: 100,
    });
    assert.equal((await store.listLeavingGroups()).length, 1);
    await assert.rejects(
      () => store.putLeavingGroup({ groupDid: "", phase: "leaving_group", createdAt: 1 }),
      SyncStoreError,
    );

    const joinInput = {
      operationId: "op-join-1",
      mode: "create" as const,
      intentHash: "hash-1",
      authorityEndpoint: "https://gh1.example",
      createParams: { name: "Acme", joinPolicy: "approval" as const, publicMeta: true },
      groupDid,
      phase: "submitting" as const,
      createdAt: 200,
    };
    await store.putJoiningGroup(joinInput);
    joinInput.createParams.name = "Mutated";
    const fetchedJoin = await store.getJoiningGroup("op-join-1");
    assert.equal(fetchedJoin?.createParams?.name, "Acme");
    fetchedJoin!.createParams!.name = "MutatedOut";
    assert.equal((await store.getJoiningGroup("op-join-1"))?.createParams?.name, "Acme");
    assert.equal((await store.listJoiningGroups()).length, 1);
    await assert.rejects(
      () => store.putJoiningGroup({ operationId: "", mode: "open", intentHash: "h", phase: "submitting", createdAt: 1 }),
      SyncStoreError,
    );

    const reactInput = {
      operationId: "op-react-1",
      groupDid,
      restoredIncarnation: "inc-2",
      phase: "restoring_acceptance" as const,
      createdAt: 300,
    };
    await store.putReactivatingGroup(reactInput);
    assert.deepEqual(await store.getReactivatingGroup("op-react-1"), reactInput);
    assert.equal((await store.listReactivatingGroups()).length, 1);
    await assert.rejects(
      () => store.putReactivatingGroup({ operationId: "", groupDid, phase: "activating", createdAt: 1 }),
      SyncStoreError,
    );

    await store.deleteLeavingGroup(groupDid);
    assert.equal(await store.getLeavingGroup(groupDid), undefined);
    await store.putLeavingGroup({ groupDid, phase: "reconciling_post_delete", createdAt: 101 });

    await store.deleteJoiningGroup("op-join-1");
    assert.equal(await store.getJoiningGroup("op-join-1"), undefined);
    await store.putJoiningGroup({
      operationId: "op-join-2",
      mode: "approval",
      intentHash: "hash-2",
      groupDid,
      phase: "pending_approval",
      createdAt: 201,
    });

    await store.deleteReactivatingGroup("op-react-1");
    assert.equal(await store.getReactivatingGroup("op-react-1"), undefined);
    await store.putReactivatingGroup({
      operationId: "op-react-2",
      groupDid,
      phase: "activating",
      createdAt: 301,
    });

    await store.clear();
    assert.deepEqual(await store.listLeavingGroups(), []);
    assert.deepEqual(await store.listJoiningGroups(), []);
    assert.deepEqual(await store.listReactivatingGroups(), []);
  });

  test(`${name}: staleIfBehindRev marks intermediate writer revisions stale while ignoring caught-up or absent writers, and putSpace enforces expectedRevision / disallowOlderSpaceRev / touchMetadataOnly`, async () => {
    const store = await open();
    const writerDid = "did:plc:r19writer00000000001";

    // 1. Cold/absent writer: `staleIfBehindRev` refuses without materializing a record.
    assert.equal(
      await store.commit({
        space: SPACE,
        repo: writerDid,
        expectedGeneration: null,
        markStale: true,
        staleIfBehindRev: "3lblr19rev003",
      }),
      false,
    );
    assert.equal(await store.getWriter(SPACE, writerDid), undefined);

    // 2. Concurrent refresh commits intermediate `r2` (`3lblr19rev002`, `stale: false`, `generation = 1`);
    //    `staleIfBehindRev: "3lblr19rev003"` (`r2 < r3`) marks it `stale: true` even without `expectedGeneration`!
    assert.equal(
      await store.commit({
        space: SPACE,
        repo: writerDid,
        expectedGeneration: 0,
        rev: "3lblr19rev002",
        next: { syncedRev: "3lblr19rev002", checkedAt: 100, stale: false, coverage: {} },
      }),
      true,
    );
    assert.equal(
      await store.commit({
        space: SPACE,
        repo: writerDid,
        expectedGeneration: null,
        markStale: true,
        staleIfBehindRev: "3lblr19rev002",
      }),
      false,
      "writer already at >= staleIfBehindRev must remain clean",
    );
    assert.equal((await store.getWriter(SPACE, writerDid))?.stale, false);

    assert.equal(
      await store.commit({
        space: SPACE,
        repo: writerDid,
        expectedGeneration: null,
        markStale: true,
        staleIfBehindRev: "3lblr19rev003",
      }),
      true,
      "writer at r2 < r3 must be marked stale",
    );
    assert.equal((await store.getWriter(SPACE, writerDid))?.stale, true);

    // 3. `putSpace` enforces `expectedRevision`, `disallowOlderSpaceRev`, and `touchMetadataOnly` atomically!
    const parentWs = workspaceUri("did:plc:g");
    assert.equal(
      await store.putSpace(
        {
          space: SPACE,
          spaceRev: null,
          writers: [],
          writersListedAt: null,
          workspace: parentWs,
          lastOpenedAt: 50,
        },
        { touchMetadataOnly: true },
      ),
      true,
    );
    assert.equal((await store.getSpace(SPACE))?.revision, 0, "touchMetadataOnly on cold space keeps revision 0");

    assert.equal(
      await store.putSpace(
        {
          space: SPACE,
          spaceRev: "3lblspace0002",
          writers: [{ did: writerDid, repoRev: "3lblr19rev003" }],
          writersListedAt: 200,
          workspace: parentWs,
          lastOpenedAt: 200,
        },
        { expectedRevision: 0, disallowOlderSpaceRev: true },
      ),
      true,
    );
    assert.equal((await store.getSpace(SPACE))?.revision, 1);

    // Stale cross-tab scan with `expectedRevision: 0` or older `spaceRev` is refused!
    assert.equal(
      await store.putSpace(
        {
          space: SPACE,
          spaceRev: "3lblspace0001",
          writers: [],
          writersListedAt: 150,
          workspace: null,
          lastOpenedAt: 150,
        },
        { expectedRevision: 0, disallowOlderSpaceRev: true },
      ),
      false,
    );
    assert.equal(
      await store.putSpace(
        {
          space: SPACE,
          spaceRev: "3lblspace0001",
          writers: [],
          writersListedAt: 150,
          workspace: null,
          lastOpenedAt: 150,
        },
        { disallowOlderSpaceRev: true },
      ),
      false,
    );

    // `touchMetadataOnly` updates `lastOpenedAt` without clobbering `spaceRev`, `writers`, or `revision`!
    assert.equal(
      await store.putSpace(
        {
          space: SPACE,
          spaceRev: null,
          writers: [],
          writersListedAt: null,
          workspace: parentWs,
          lastOpenedAt: 999,
        },
        { touchMetadataOnly: true },
      ),
      true,
    );
    const preserved = (await store.getSpace(SPACE))!;
    assert.equal(preserved.spaceRev, "3lblspace0002");
    assert.equal(preserved.writers.length, 1);
    assert.equal(preserved.lastOpenedAt, 999);
    assert.equal(preserved.revision, 1);

    // 4. `purgeWriter` enforces `expectedSpaceRevision` atomically without deleting writer records!
    await store.commit({
      space: SPACE,
      repo: writerDid,
      expectedGeneration: null,
      upsert: [record(SPACE, writerDid, MESSAGE, "keep-me")],
      next: { syncedRev: "3lblr19rev003", checkedAt: 300, stale: false, coverage: {} },
    });
    assert.equal(
      await store.purgeWriter(SPACE, writerDid, { expectedSpaceRevision: 0 }),
      false,
      "purgeWriter must refuse stale expectedSpaceRevision",
    );
    assert.equal((await store.records(SPACE, MESSAGE, writerDid)).length, 1);
  });
}
