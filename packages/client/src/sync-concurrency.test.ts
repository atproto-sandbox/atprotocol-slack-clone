import assert from "node:assert/strict";
import test from "node:test";
import { MemoryStore } from "./memory-store";
import { groupMembersUri } from "@flock/protocol/keys";
import { COLLECTION, ATGRP_COLLECTION, ATGRP_POLICY } from "@flock/protocol/nsids";
import { AUTHORITY, createChannel, key, readChannel, syncFor, writeMessage } from "./testing/engine-fixture";
import { FakeNetwork } from "@flock/testing/fake-network";

// Two tabs share one store; own writes, purges and backfills race refreshes. Every case asserts the state a correct
// engine must end in: no stale commit overwrites newer state, undoes a local write, or brings back purged records.

const ALICE = "did:plc:aliceaaaaaaaaaaaaaaaaaaa";
const BOB = "did:plc:bob2aaaaaaaaaaaaaaaaaaaa";
const READER = "did:plc:readeraaaaaaaaaaaaaaaaaa";

async function channel() {
  const network = new FakeNetwork();
  const space = await createChannel(network, "general", [READER, ALICE, BOB]);
  for (let n = 1; n <= 5; n += 1) await writeMessage(network, ALICE, space, n);
  for (let n = 6; n <= 10; n += 1) await writeMessage(network, BOB, space, n);
  return { network, space };
}

const heldKeys = async (store: MemoryStore, space: string, repo: string) =>
  (await store.records(space, COLLECTION.message, repo)).map((record) => record.rkey).sort();

test("two tabs refreshing one writer and committing out of order keep the newer state", async () => {
  const { network, space } = await channel();
  const store = new MemoryStore();
  const first = syncFor(network, READER, { store }).core;
  const second = syncFor(network, READER, { store }).core;
  await readChannel(first, space);
  await writeMessage(network, BOB, space, 11);
  // The first tab's refresh of bob is held after its listing; the second tab refreshes bob after a further write and commits.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let paused = false;
  network.beforeListRecords = async ({ repo, collection }) => {
    if (repo === BOB && collection === COLLECTION.reaction && !paused) {
      paused = true;
      await held;
    }
  };
  const slow = readChannel(first, space);
  while (!paused) await new Promise((resolve) => setTimeout(resolve, 1));
  network.beforeListRecords = undefined;
  await writeMessage(network, BOB, space, 12);
  await readChannel(second, space);
  release();
  await slow;
  assert.deepEqual(await heldKeys(store, space, BOB), [key(6), key(7), key(8), key(9), key(10), key(11), key(12)]);
  assert.equal((await store.getWriter(space, BOB))!.syncedRev, (await network.clientFor(BOB).query<{ commit: { rev: string } }>("com.atproto.space.getLatestCommit", { space, repo: BOB })).commit.rev);
});

test("an own write during a refresh of the own writer is not undone", async () => {
  const network = new FakeNetwork();
  const space = await createChannel(network, "general", [ALICE, READER]);
  await writeMessage(network, READER, space, 1);
  const { core, store } = syncFor(network, READER);
  await readChannel(core, space);
  await writeMessage(network, READER, space, 2);
  network.beforeListRecords = async ({ repo }) => {
    if (repo !== READER) return;
    network.beforeListRecords = undefined;
    // The reader's own new message lands while its own writer is being refreshed from a listing that predates it.
    await writeMessage(network, READER, space, 3);
    await core.applyOwnWrite({ space, repo: READER }, { upsert: [{ space, repo: READER, collection: COLLECTION.message, rkey: key(3), uri: `${space}/${READER}/${COLLECTION.message}/${key(3)}`, cid: "", value: { text: "own" } }] });
  };
  await readChannel(core, space);
  assert.deepEqual(await heldKeys(store as MemoryStore, space, READER), [key(1), key(2), key(3)]);
});

test("a purge followed by a late refresh does not bring the purged records back", async () => {
  const { network, space } = await channel();
  const { core, store } = syncFor(network, READER);
  await readChannel(core, space);
  await writeMessage(network, BOB, space, 11);
  network.beforeListRecords = async ({ repo }) => {
    if (repo !== BOB) return;
    network.beforeListRecords = undefined;
    await store.purgeSpace(space);
  };
  await readChannel(core, space);
  assert.deepEqual(await heldKeys(store as MemoryStore, space, BOB), [], "the refresh that started before the purge did not commit");
});

test("a backfill racing a refresh of the same writer is refused, and the refresh's state stands", async () => {
  const network = new FakeNetwork();
  const space = await createChannel(network, "general", [ALICE, READER]);
  for (let n = 1; n <= 12; n += 1) await writeMessage(network, ALICE, space, n);
  const store = new MemoryStore();
  const reader = syncFor(network, READER, { store, options: { pageSize: 3 } }).core;
  const other = syncFor(network, READER, { store, options: { pageSize: 3 } }).core;
  const first = await readChannel(reader, space, { limit: 3 });
  let raced = false;
  network.beforeListRecords = async ({ cursor }) => {
    if (!cursor || raced) return;
    raced = true;
    // Paging back reads below the coverage; meanwhile alice writes and another tab refreshes her.
    await writeMessage(network, ALICE, space, 13);
    await other.markStale(space, ALICE);
    await readChannel(other, space, { limit: 3 });
  };
  const older = await readChannel(reader, space, { limit: 3, before: first.next });
  assert.equal(raced, true);
  assert.deepEqual(older.items.map((item) => item.rkey), [key(9), key(8), key(7)]);
  const held = await heldKeys(store, space, ALICE);
  assert.ok(held.includes(key(13)), "the refresh's newer state stands");
});

test("records of several writers with one key across a page boundary are each shown once", async () => {
  const network = new FakeNetwork();
  const space = await createChannel(network, "general", [ALICE, BOB, READER]);
  for (const writer of [ALICE, BOB]) for (const n of [1, 2, 3]) await writeMessage(network, writer, space, n);
  const { core } = syncFor(network, READER, { options: { pageSize: 2 } });
  const seen: string[] = [];
  let before: { key: string; uri: string } | undefined;
  for (let pages = 0; pages < 10; pages += 1) {
    const page = await readChannel(core, space, { limit: 3, before });
    seen.push(...page.items.map((item) => item.uri));
    if (!page.next) break;
    before = page.next;
  }
  assert.equal(seen.length, 6);
  assert.equal(new Set(seen).size, 6, "no record lost or repeated at a boundary where two writers share a key");
});

test("the bound reached with records spread unevenly across writers cuts the page and says so", async () => {
  const network = new FakeNetwork();
  const space = await createChannel(network, "general", [ALICE, BOB, READER]);
  for (let n = 1; n <= 9; n += 1) await writeMessage(network, ALICE, space, n * 2);
  await writeMessage(network, BOB, space, 1);
  const { core } = syncFor(network, READER, { options: { pageSize: 3, maxRecordsPerCollection: 6 } });
  const page = await readChannel(core, space, { limit: 8 });
  assert.equal(page.complete, false);
  assert.deepEqual(page.cut, [COLLECTION.message]);
  assert.ok(page.items.length <= 6);
});

test("a fresh client and a long-lived one agree after a member is removed and another reduced to read-only", async () => {
  const { network, space } = await channel();
  const longLived = syncFor(network, READER).core;
  await readChannel(longLived, space);
  const owner = network.clientFor(AUTHORITY);
  const membersSpace = groupMembersUri(AUTHORITY);
  await owner.procedure("com.atproto.space.deleteRecord", {
    space: membersSpace,
    repo: AUTHORITY,
    collection: ATGRP_COLLECTION.membership,
    rkey: ALICE,
  });
  await owner.procedure("com.atproto.space.putRecord", {
    space: membersSpace,
    repo: AUTHORITY,
    collection: ATGRP_COLLECTION.role,
    rkey: "readonly",
    record: {
      $type: ATGRP_COLLECTION.role,
      displayName: "Read-only",
      scopes: [],
      createdAt: "2026-11-10T12:00:00.000Z",
    },
  });
  await owner.procedure("com.atproto.space.putRecord", {
    space: membersSpace,
    repo: AUTHORITY,
    collection: ATGRP_COLLECTION.membership,
    rkey: BOB,
    record: {
      $type: ATGRP_COLLECTION.membership,
      roles: ["readonly"],
      createdAt: "2026-11-10T12:00:00.000Z",
    },
  });
  await owner.procedure("com.atproto.space.updateSpace", {
    space,
    policy: {
      $type: ATGRP_POLICY,
      publicRead: false,
      unlisted: false,
      grants: [
        { role: "admin", read: true, write: true },
        { role: "moderator", read: true, write: true },
        { role: "member", read: true, write: true },
        { role: "readonly", read: true },
      ],
    },
  });
  // An app uninstalled leaves the member list the same way a removed member does.
  network.advanceClock(longLived.options.truthIntervalMs);
  const fresh = await readChannel(syncFor(network, READER).core, space);
  const kept = await readChannel(longLived, space);
  assert.deepEqual(kept.items.map((item) => item.uri), fresh.items.map((item) => item.uri));
  assert.deepEqual(fresh.items, [], "neither shows records from accounts the authority no longer lists (D14)");
});

test("a writer the authority never listed stays unread, and the page claims completeness only for the listed writers", async () => {
  const { network, space } = await channel();
  const stranger = "did:plc:strangeraaaaaaaaaaaaaaaa";
  network.createAccount(stranger, "pds1");
  await writeMessage(network, stranger, space, 99);
  const page = await readChannel(syncFor(network, READER).core, space, { limit: 3 });
  assert.equal(page.items.some((item) => item.repo === stranger), false);
  assert.equal(page.complete, true);
});

test("two tabs racing syncVerifiedSpace and listRepoOps delta commits preserve newer state and non-stale setHash", async () => {
  const { network, space } = await channel();
  const store = new MemoryStore();
  const tabA = syncFor(network, READER, { store }).core;
  const tabB = syncFor(network, READER, { store }).core;

  // Both tabs warm-sync via STAR first so Bob holds a valid 2048B setHash and syncedRev.
  await tabA.syncVerifiedSpace({ space, collections: [COLLECTION.message, COLLECTION.reaction] });

  // Bob writes msg 11; tab A enters listRepoOps, pauses, then Bob writes msg 12 and tab B commits rev(12) first.
  await writeMessage(network, BOB, space, 11);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let paused = false;
  network.beforeListRepoOps = async ({ repo }) => {
    if (repo !== BOB || paused) return;
    paused = true;
    await held;
  };
  const slowTabA = tabA.syncVerifiedSpace({ space, collections: [COLLECTION.message, COLLECTION.reaction] });
  while (!paused) await new Promise((resolve) => setTimeout(resolve, 1));
  network.beforeListRepoOps = undefined;

  await writeMessage(network, BOB, space, 12);
  await tabB.markStale(space, BOB);
  await tabB.syncVerifiedSpace({ space, collections: [COLLECTION.message, COLLECTION.reaction] });
  release();
  await slowTabA;

  const heldAfter = await heldKeys(store, space, BOB);
  assert.ok(heldAfter.includes(key(12)), "tab B's newer verified delta state survives CAS race");
  const bobState = await store.getWriter(space, BOB);
  assert.equal(bobState?.setHash?.length, 2048);
  assert.equal(bobState?.commitDigest?.length, 32);
});

test("a space purge during an in-flight syncVerifiedSpace STAR or listRepoOps delta refuses to resurrect records", async () => {
  const { network, space } = await channel();
  const store = new MemoryStore();
  const { core } = syncFor(network, READER, { store });

  let raced = false;
  network.beforeGetRepo = async ({ repo }) => {
    if (repo !== BOB || raced) return;
    raced = true;
    await store.purgeSpace(space);
  };
  await core.syncVerifiedSpace({ space, collections: [COLLECTION.message, COLLECTION.reaction] });
  network.beforeGetRepo = undefined;
  assert.equal(raced, true);
  assert.deepEqual(await heldKeys(store, space, BOB), [], "STAR result from pre-purge epoch must not commit");
});

test("Round 18 Fix #2: applyOwnWrite and markStale enforce epoch/invalidation/generation CAS without resurrecting purged spaces or clobbering writers", async () => {
  const { network, space } = await channel();
  const store = new MemoryStore();
  const { core } = syncFor(network, READER, { store });
  await readChannel(core, space);

  // 1. Pre-captured `epoch` before an in-flight own write refuses to recreate `SpaceState` or records if `purgeSpace` ran meanwhile!
  const prePurgeEpoch = await store.epoch(space);
  await store.purgeSpace(space);
  await core.applyOwnWrite(
    { space, repo: READER },
    {
      upsert: [
        {
          space,
          repo: READER,
          collection: COLLECTION.message,
          rkey: key(91),
          uri: `${space}/${READER}/${COLLECTION.message}/${key(91)}`,
          cid: "",
          value: { text: "stale-own-write" },
        },
      ],
    },
    { epoch: prePurgeEpoch },
  );
  assert.equal(await store.getSpace(space), undefined, "purged SpaceState must NOT be recreated by pre-purge applyOwnWrite");
  assert.deepEqual(await heldKeys(store, space, READER), [], "purged records must NOT be recreated by pre-purge applyOwnWrite");

  // 2. Live `applyOwnWrite` touches `ownWriteAt` atomically without clobbering concurrent `SpaceState.writers` or `invalidationSeq`!
  await readChannel(core, space);
  const spaceBeforeOwn = await store.getSpace(space);
  assert.ok(spaceBeforeOwn && spaceBeforeOwn.writers.length > 0);
  await store.invalidateSpace(space);
  const seqAfterInv = (await store.getSpace(space))?.invalidationSeq ?? 0;
  await core.applyOwnWrite(
    { space, repo: READER },
    {
      upsert: [
        {
          space,
          repo: READER,
          collection: COLLECTION.message,
          rkey: key(92),
          uri: `${space}/${READER}/${COLLECTION.message}/${key(92)}`,
          cid: "",
          value: { text: "atomic-own-write" },
        },
      ],
    },
  );
  const spaceAfterOwn = await store.getSpace(space);
  assert.equal(spaceAfterOwn?.writers.length, spaceBeforeOwn.writers.length, "applyOwnWrite must preserve concurrent writers list");
  assert.equal(spaceAfterOwn?.invalidationSeq, seqAfterInv, "applyOwnWrite must preserve invalidationSeq");
  assert.equal(typeof spaceAfterOwn?.ownWriteAt, "number");

  // 3. Guarded `markStale` refuses stale `epoch`, `expectedInvalidationSeq`, or `expectedGeneration`!
  await readChannel(core, space);
  const bobClean = await store.getWriter(space, BOB);
  assert.equal(bobClean?.stale, false);
  await core.markStale(space, BOB, {
    epoch: prePurgeEpoch,
    expectedInvalidationSeq: seqAfterInv,
    expectedGeneration: bobClean!.generation,
  });
  assert.equal((await store.getWriter(space, BOB))?.stale, false, "mismatched epoch must refuse markStale");

  const liveEpoch = await store.epoch(space);
  await core.markStale(space, BOB, {
    epoch: liveEpoch,
    expectedInvalidationSeq: seqAfterInv + 99,
    expectedGeneration: bobClean!.generation,
  });
  assert.equal((await store.getWriter(space, BOB))?.stale, false, "mismatched invalidationSeq must refuse markStale");

  await core.markStale(space, BOB, {
    epoch: liveEpoch,
    expectedInvalidationSeq: seqAfterInv,
    expectedGeneration: bobClean!.generation + 99,
  });
  assert.equal((await store.getWriter(space, BOB))?.stale, false, "mismatched generation must refuse markStale");
});

test("Round 19 Fix #2 & #3: writer scan preserves newer r3 hint across concurrent r2 refresh and cross-tab writer scans never regress SpaceState", async () => {
  const CAROL = "did:plc:carolcrosstabwriteraaaa2";
  const network = new FakeNetwork();
  const space = await createChannel(network, "crosstab", [READER, ALICE, BOB, CAROL]);
  const store = new MemoryStore();
  const tabA = syncFor(network, READER, { store, options: { truthIntervalMs: 60_000 } });
  const tabB = syncFor(network, READER, { store, options: { truthIntervalMs: 60_000 } });

  // Seed initial read (`r1`) in shared store (`CAROL` has not written yet, so `CAROL` is not in `listWriters` yet!)
  await writeMessage(network, BOB, space, 1);
  assert.deepEqual((await readChannel(tabA.core, space)).items.map((i) => i.rkey), [key(1)]);
  const r1 = (await store.getWriter(space, BOB))!.syncedRev!;

  // --- Finding #2: Scan observes `r3` while concurrent refresh committed clean intermediate `r2` (`r1 < r2 < r3`, bumping generation) ---
  await writeMessage(network, BOB, space, 2);
  await store.invalidateSpace(space);
  await readChannel(tabB.core, space);
  const r2State = (await store.getWriter(space, BOB))!;
  assert.ok(r2State.syncedRev! > r1);
  assert.equal(r2State.stale, false);

  // Publish `r3` on BOB, reset BOB in store to `r1` right before scan starts, then commit clean `r2` mid-scan (bumping generation)!
  await writeMessage(network, BOB, space, 3);
  await store.commit({
    space,
    repo: BOB,
    expectedGeneration: r2State.generation,
    next: {
      syncedRev: r1,
      checkedAt: network.now(),
      stale: false,
      coverage: r2State.coverage,
      ...(r2State.setHash ? { setHash: r2State.setHash } : {}),
      ...(r2State.commitDigest ? { commitDigest: r2State.commitDigest } : {}),
    },
  });
  await store.invalidateSpace(space);
  const preR1Writer = (await store.getWriter(space, BOB))!;
  const origCommit = store.commit.bind(store);
  let injectedIntermediateR2 = false;
  store.commit = async (change) => {
    if (!injectedIntermediateR2 && change.repo === BOB && change.staleIfBehindRev !== undefined) {
      injectedIntermediateR2 = true;
      const appliedR2 = await origCommit({
        space,
        repo: BOB,
        expectedGeneration: preR1Writer.generation,
        rev: r2State.syncedRev,
        next: {
          syncedRev: r2State.syncedRev,
          checkedAt: network.now(),
          stale: false,
          coverage: r2State.coverage,
          ...(r2State.setHash ? { setHash: r2State.setHash } : {}),
          ...(r2State.commitDigest ? { commitDigest: r2State.commitDigest } : {}),
        },
      });
      assert.equal(appliedR2, true, "concurrent refresh committed clean intermediate r2 and bumped generation");
    }
    return origCommit(change);
  };
  await tabA.core.writers(space);
  store.commit = origCommit;

  assert.equal(injectedIntermediateR2, true);
  assert.equal(
    (await store.getWriter(space, BOB))?.stale,
    true,
    "writer at intermediate r2 < r3 MUST be marked stale despite concurrent generation bump",
  );
  assert.deepEqual(
    (await readChannel(tabA.core, space)).items.map((i) => i.rkey).sort(),
    [key(1), key(2), key(3)],
    "subsequent read fetches r3 instead of serving stale r2",
  );

  // --- Finding #3: Two SyncCore instances (cross-tab) both pass pre-save check, and delayed older scan (`s1`) cannot regress `SpaceState` (`s2`) ---
  const s1Space = (await store.getSpace(space))!;
  assert.equal(s1Space.writers.some((w) => w.did === CAROL), false);

  // Hold `tabB`'s `putSpace` right after `tabB` passed `afterScanSpace` (having scanned `s1` before CAROL wrote),
  // while CAROL writes `m4` (`s2 > s1`) and `tabA` completes a fresh scan committing `s2` first!
  const origPutSpace = store.putSpace.bind(store);
  let releaseDelayedTabBPut!: () => void;
  let tabBReachedPut!: () => void;
  const tabBAtPutPromise = new Promise<void>((res) => {
    tabBReachedPut = res;
  });
  const delayedGate = new Promise<void>((res) => {
    releaseDelayedTabBPut = res;
  });
  let interceptNextPut = true;
  store.putSpace = async (st, opts) => {
    if (interceptNextPut && !opts?.touchMetadataOnly) {
      interceptNextPut = false;
      tabBReachedPut();
      await delayedGate;
    }
    return origPutSpace(st, opts);
  };

  // Fresh cold tab (`tabB` has not opened `space` since `invalidateSpace` / construct a fresh `tabC` to trigger full scan)
  const tabSlow = syncFor(network, READER, { store, options: { truthIntervalMs: 60_000 } });
  const tabFast = syncFor(network, READER, { store, options: { truthIntervalMs: 60_000 } });
  const slowScanPromise = tabSlow.core.writers(space);
  await tabBAtPutPromise;

  await writeMessage(network, CAROL, space, 4);
  const fastWriters = await tabFast.core.writers(space);
  assert.equal(fastWriters.some((w) => w.did === CAROL), true);
  const s2Space = (await store.getSpace(space))!;
  assert.ok(s2Space.spaceRev! > s1Space.spaceRev!);
  assert.equal(s2Space.writers.some((w) => w.did === CAROL), true);

  // Release `tabSlow`'s stale `putSpace(s1)` -> rejected by `expectedRevision` + `disallowOlderSpaceRev`, preserving `s2` and CAROL!
  releaseDelayedTabBPut();
  const slowWriters = await slowScanPromise;
  store.putSpace = origPutSpace;

  const finalSpace = (await store.getSpace(space))!;
  assert.equal(finalSpace.spaceRev, s2Space.spaceRev, "delayed cross-tab scan must NOT regress persisted spaceRev");
  assert.equal(
    finalSpace.writers.some((w) => w.did === CAROL),
    true,
    "delayed cross-tab scan must NOT drop newly listed writer CAROL",
  );
  assert.equal(slowWriters.some((w) => w.did === CAROL), true, "slow tab retry resolves up-to-date writer set including CAROL");

  // --- Round 20 Fix #2: Stale cross-tab scan cannot purge a writer re-admitted at the SAME repoRev (where writer generation did not bump) ---
  await readChannel(tabFast.core, space);
  assert.deepEqual(await heldKeys(store, space, CAROL), [key(4)]);
  const carolGenBefore = (await store.getWriter(space, CAROL))!.generation;

  // Simulate `tabPurgeSlow` scanning `s1` where CAROL was temporarily absent (`#repoRemoved`), while CAROL was
  // re-admitted at the EXACT SAME `repoRev` (`s2`, so `WriterState.generation` stays `carolGenBefore`) and `tabPurgeFast` commits `s2`!
  let omitCarolOnce = true;
  network.interceptResponse = ({ method, params, response }) => {
    if (omitCarolOnce && method === "com.atproto.space.listWriters" && params.space === space) {
      omitCarolOnce = false;
      return response.json().then((body: { repos: Array<{ repo?: string; did?: string }>; spaceRev?: string }) => {
        const withoutCarol = body.repos.filter((r) => r.repo !== CAROL && r.did !== CAROL);
        return Response.json({ ...body, repos: withoutCarol });
      });
    }
    return response;
  };

  const origPurgeWriter = store.purgeWriter.bind(store);
  let notifyAtPurge!: () => void;
  const reachedPurge = new Promise<void>((res) => {
    notifyAtPurge = res;
  });
  let releasePurge!: () => void;
  const purgeGate = new Promise<void>((res) => {
    releasePurge = res;
  });
  let pausePurgeOnce = true;
  store.purgeWriter = async (sp, rp, opts) => {
    if (pausePurgeOnce && rp === CAROL) {
      pausePurgeOnce = false;
      notifyAtPurge();
      await purgeGate;
    }
    return origPurgeWriter(sp, rp, opts);
  };

  const tabPurgeSlow = syncFor(network, READER, { store, options: { truthIntervalMs: 60_000 } });
  const tabPurgeFast = syncFor(network, READER, { store, options: { truthIntervalMs: 60_000 } });
  const slowPurgeScan = tabPurgeSlow.core.writers(space);
  await reachedPurge;
  network.interceptResponse = undefined;

  // `tabPurgeFast` runs a fresh full scan seeing CAROL at the SAME `repoRev` and commits `SpaceState`
  // (bumping `SpaceState.revision`, WITHOUT changing CAROL's `WriterState.generation`!)
  await tabPurgeFast.core.writers(space);
  assert.equal((await store.getWriter(space, CAROL))!.generation, carolGenBefore);

  releasePurge();
  await slowPurgeScan;
  store.purgeWriter = origPurgeWriter;

  assert.deepEqual(
    await heldKeys(store, space, CAROL),
    [key(4)],
    "stale cross-tab scan MUST NOT purge records of a writer after SpaceState.revision advanced",
  );
});
