import assert from "node:assert/strict";
import test from "node:test";
import { LTHASH_STATE_BYTES, RepoCommit, serializedRecordBytes, SpaceMacError } from "@flock/protocol/atproto/space-credential-core";
import { memberspacePolicy } from "@flock/protocol/atproto/space-policy";
import { extSpaceUriFor } from "@flock/protocol/extensions";
import { subjectKey, tidNow } from "@flock/protocol/keys";
import { COLLECTION } from "@flock/protocol/nsids";
import { FakeNetwork } from "@flock/testing/fake-network";
import { MAX_HOLD_MS } from "./key-window";
import { MemoryStore } from "./memory-store";
import { AUTHORITY, countCalls, createChannel, createWorkspace, key, readChannel, syncFor, transportFor, writeMessage } from "./testing/engine-fixture";

const ALICE = "did:plc:alice";
const BOB = "did:plc:bob2";
const CAROL = "did:plc:carol";
const READER = "did:plc:reader";

/** A channel where alice wrote 1..5 and bob 6..10, read by `READER`. */
async function seeded() {
  const network = new FakeNetwork();
  const space = await createChannel(network, "general", [ALICE, BOB, CAROL, READER]);
  for (let n = 1; n <= 5; n += 1) await writeMessage(network, ALICE, space, n);
  for (let n = 6; n <= 10; n += 1) await writeMessage(network, BOB, space, n);
  return { network, space, ...syncFor(network, READER, { options: { pageSize: 3 } }) };
}

const keysOf = (result: { items: Array<{ rkey: string }> }) => result.items.map((item) => item.rkey);

test("a first sync reads every listed writer and pages the newest records across them", async () => {
  const { space, core } = await seeded();
  const page = await readChannel(core, space, { limit: 4 });
  assert.deepEqual(keysOf(page), [key(10), key(9), key(8), key(7)]);
  assert.equal(page.complete, true);
  assert.ok(page.next, "older records remain");
  const older = await readChannel(core, space, { limit: 4, before: page.next });
  assert.deepEqual(keysOf(older), [key(6), key(5), key(4), key(3)]);
  const oldest = await readChannel(core, space, { limit: 4, before: older.next });
  assert.deepEqual(keysOf(oldest), [key(2), key(1)]);
  assert.equal(oldest.next, undefined);
});

test("a reopen within the truth interval asks the authority once and no writer", async () => {
  const { network, space, core } = await seeded();
  await readChannel(core, space);
  const calls = await countCalls(network, () => readChannel(core, space));
  assert.deepEqual(calls, { "com.atproto.space.listRepos": 1 });
});

test("a reopen after a new space session asks every writer once, and lists none that did not move", async () => {
  const { network, space, store } = await seeded();
  await readChannel(syncFor(network, READER, { store }).core, space);
  const { core: later } = syncFor(network, READER, { store });
  const calls = await countCalls(network, () => readChannel(later, space));
  assert.equal(calls["com.atproto.space.getLatestCommit"], 2, "one revision read per writer");
  assert.equal(calls["com.atproto.space.listRecords"], undefined, "nothing moved, so nothing is listed");
});

test("a collection held in full is listed at its own, larger page, so a writer with many reactions costs few round trips", async () => {
  const network = new FakeNetwork();
  const space = await createChannel(network, "general", [ALICE, READER]);
  await writeMessage(network, ALICE, space, 1);
  for (let n = 0; n < 25; n += 1) await network.writeAs(ALICE, space, COLLECTION.reaction, `r${n}`, { subject: "x", emoji: "👍", createdAt: "2026-11-10T12:00:00.000Z" });
  const { core, store } = syncFor(network, READER, { options: { pageSize: 5, allPageSize: 10 } });
  const calls = await countCalls(network, () => readChannel(core, space));
  assert.equal(calls["com.atproto.space.listRecords"], 4, "one page of messages and three of reactions");
  assert.equal((await store.records(space, COLLECTION.reaction)).length, 25);
});

test("another writer's create, edit and delete reach the reader through the hint", async () => {
  const { network, space, core } = await seeded();
  await readChannel(core, space);
  await writeMessage(network, ALICE, space, 11, "new");
  await writeMessage(network, BOB, space, 10, "edited");
  await network.deleteAs(BOB, space, COLLECTION.message, key(9));
  const page = await readChannel(core, space, { limit: 3 });
  assert.deepEqual(keysOf(page), [key(11), key(10), key(8)]);
  assert.equal(page.items[1]!.value.text, "edited");
  assert.equal(page.complete, true);
});

test("a record a writer inserts below its oldest held key, inside the window, is read on its next refresh", async () => {
  const network = new FakeNetwork();
  const space = await createChannel(network, "general", [ALICE, BOB, READER]);
  for (let n = 1; n <= 10; n += 1) await writeMessage(network, ALICE, space, n * 10);
  await writeMessage(network, BOB, space, 95);
  const { core } = syncFor(network, READER, { options: { pageSize: 3 } });
  assert.deepEqual(keysOf(await readChannel(core, space, { limit: 5 })), [key(100), key(95), key(90), key(80), key(70)]);
  // Bob's only held record is 95; he back-dates one to 85, below it but inside the page.
  await writeMessage(network, BOB, space, 85);
  assert.deepEqual(keysOf(await readChannel(core, space, { limit: 5 })), [key(100), key(95), key(90), key(85), key(80)]);
});

test("a writer with no records and a new writer are both read", async () => {
  const { network, space, core } = await seeded();
  await writeMessage(network, CAROL, space, 50);
  await network.deleteAs(CAROL, space, COLLECTION.message, key(50));
  const first = await readChannel(core, space, { limit: 3 });
  assert.deepEqual(keysOf(first), [key(10), key(9), key(8)]);
  assert.equal(first.complete, true, "a writer with nothing left holds a complete, empty coverage");
  const dave = "did:plc:dave";
  await network.clientFor("did:plc:authority").procedure("com.atproto.memberspace.putMember", { space, did: dave, read: true, write: true });
  network.createAccount(dave, "pds1");
  await writeMessage(network, dave, space, 12);
  assert.deepEqual(keysOf(await readChannel(core, space, { limit: 2 })), [key(12), key(10)]);
});

test("a delete at a page boundary moves the boundary instead of leaving a gap", async () => {
  const { network, space, core } = await seeded();
  const first = await readChannel(core, space, { limit: 3 });
  assert.deepEqual(keysOf(first), [key(10), key(9), key(8)]);
  await network.deleteAs(BOB, space, COLLECTION.message, key(8));
  const again = await readChannel(core, space, { limit: 3 });
  assert.deepEqual(keysOf(again), [key(10), key(9), key(7)]);
});

test("a write between two pages of one listing is never committed as a mixture of two states", async () => {
  const { network, space, core, store } = await seeded();
  let injected = false;
  network.beforeListRecords = async ({ repo, cursor, collection }) => {
    // While bob's messages are being listed, after the first page, he writes above it and deletes below it.
    if (repo === BOB && cursor && collection === COLLECTION.message && !injected) {
      injected = true;
      await writeMessage(network, BOB, space, 20);
      await network.deleteAs(BOB, space, COLLECTION.message, key(6));
    }
  };
  const page = await readChannel(core, space, { limit: 10 });
  assert.equal(injected, true);
  const held = (await store.records(space, COLLECTION.message, BOB)).map((record) => record.rkey).sort();
  assert.deepEqual(held, [key(7), key(8), key(9), key(10), key(20)], "bob's held records are one state: after both changes");
  assert.deepEqual(keysOf(page).slice(0, 2), [key(20), key(10)]);
});

test("a writer that keeps changing through every attempt is reported, and what was held before stands", async () => {
  const { network, space, core } = await seeded();
  await readChannel(core, space, { limit: 3 });
  let n = 100;
  await writeMessage(network, BOB, space, n);
  network.beforeListRecords = async ({ repo }) => {
    if (repo === BOB) await writeMessage(network, BOB, space, ++n);
  };
  const page = await readChannel(core, space, { limit: 3 });
  assert.deepEqual(page.changing, [BOB]);
  assert.equal(page.complete, false);
  assert.deepEqual(keysOf(page), [key(10), key(9), key(8)], "bob's last consistent state is shown");
});

test("a failure between two pages leaves the previous state, and the writer is set aside until its host returns", async () => {
  const { network, space, core } = await seeded();
  await readChannel(core, space, { limit: 3 });
  await writeMessage(network, BOB, space, 11);
  // A page of six needs a second page of bob's messages; his host goes down between the two.
  network.beforeListRecords = async ({ repo, cursor, collection }) => {
    if (repo === BOB && cursor && collection === COLLECTION.message) network.setHostReachable(BOB, false);
  };
  const failed = await readChannel(core, space, { limit: 6 });
  assert.deepEqual(failed.setAside.map((aside) => [aside.did, aside.permanent]), [[BOB, false]]);
  assert.deepEqual(keysOf(failed), [key(10), key(9), key(8), key(5), key(4), key(3)], "bob's last committed state is still shown");
  network.beforeListRecords = undefined;
  network.setHostReachable(BOB, true);
  const recovered = await readChannel(core, space, { limit: 6 });
  assert.deepEqual(recovered.setAside, []);
  assert.deepEqual(keysOf(recovered), [key(11), key(10), key(9), key(8), key(7), key(6)]);
});

test("a revision the authority reports late neither regresses the reader nor hides the write past the truth interval", async () => {
  const { network, space, core } = await seeded();
  await readChannel(core, space, { limit: 3 });
  network.setListingLag(space, true);
  await writeMessage(network, ALICE, space, 11);
  assert.deepEqual(keysOf(await readChannel(core, space, { limit: 3 })), [key(10), key(9), key(8)], "no hint yet: the held state stands");
  network.advanceClock(core.options.truthIntervalMs);
  const checked = await readChannel(core, space, { limit: 3 });
  assert.deepEqual(keysOf(checked), [key(11), key(10), key(9)], "the truth interval catches a notice that never arrived");
  network.setListingLag(space, false);
  assert.deepEqual(keysOf(await readChannel(core, space, { limit: 3 })), [key(11), key(10), key(9)], "the late report changes nothing");
});

test("a hint that arrives during a refresh makes the refresh start again", async () => {
  const { network, space, core } = await seeded();
  await readChannel(core, space, { limit: 3 });
  await writeMessage(network, BOB, space, 11);
  let hinted = false;
  network.beforeListRecords = async ({ repo }) => {
    if (repo === BOB && !hinted) {
      hinted = true;
      await writeMessage(network, BOB, space, 12);
      await core.markStale(space, BOB);
    }
  };
  const page = await readChannel(core, space, { limit: 3 });
  assert.deepEqual(keysOf(page), [key(12), key(11), key(10)]);
  assert.deepEqual(page.changing, []);
});

test("a writer whose account is taken down is set aside for good and its records stop counting", async () => {
  const { network, space, core, store } = await seeded();
  await readChannel(core, space, { limit: 3 });
  network.setAccountState(BOB, "takendown");
  await writeMessage(network, ALICE, space, 11);
  // A takedown is noticed at bob's next check: here the truth interval (D12).
  network.advanceClock(core.options.truthIntervalMs);
  const page = await readChannel(core, space, { limit: 3 });
  assert.deepEqual(page.setAside.map((aside) => [aside.did, aside.permanent]), [[BOB, true]]);
  assert.deepEqual(await store.records(space, COLLECTION.message, BOB), []);
  assert.deepEqual(keysOf(page), [key(11), key(5), key(4)]);
});

test("future-dated and back-dated keys take their place in key order", async () => {
  const { network, space, core } = await seeded();
  await writeMessage(network, ALICE, space, 1_000_000);
  await writeMessage(network, BOB, space, 0);
  const page = await readChannel(core, space, { limit: 20 });
  assert.equal(page.items[0]!.rkey, key(1_000_000));
  assert.equal(page.items.at(-1)!.rkey, key(0));
});

test("a reaction older than the window, on a message inside it, is held", async () => {
  const { network, space, core, store } = await seeded();
  await network.writeAs(ALICE, space, COLLECTION.reaction, "r-old", { subject: "x", emoji: "👍", createdAt: "2020-01-01T00:00:00.000Z" });
  await readChannel(core, space, { limit: 1 });
  assert.deepEqual((await store.records(space, COLLECTION.reaction)).map((record) => record.rkey), ["r-old"]);
});

test("a writer whose whole repo was replaced holds only the new state, nothing of the old", async () => {
  const { network, space, core, store } = await seeded();
  await readChannel(core, space, { limit: 20 });
  for (let n = 6; n <= 10; n += 1) await network.deleteAs(BOB, space, COLLECTION.message, key(n));
  for (let n = 30; n <= 32; n += 1) await writeMessage(network, BOB, space, n);
  await readChannel(core, space, { limit: 20 });
  assert.deepEqual((await store.records(space, COLLECTION.message, BOB)).map((record) => record.rkey).sort(), [key(30), key(31), key(32)]);
});

test("a collection held in full that was cut at its bound stays reported as cut on every later read", async () => {
  const network = new FakeNetwork();
  const space = await createChannel(network, "general", [ALICE, READER]);
  await writeMessage(network, ALICE, space, 1);
  for (let n = 0; n < 10; n += 1) await network.writeAs(ALICE, space, COLLECTION.reaction, `r${n}`, { subject: "x", emoji: "👍", createdAt: "2026-11-10T12:00:00.000Z" });
  const { core, store } = syncFor(network, READER, { options: { pageSize: 3, allPageSize: 3, maxRecordsPerCollection: 6 } });
  for (const read of ["first", "second", "third"]) {
    const page = await readChannel(core, space);
    assert.deepEqual([page.complete, page.cut], [false, [COLLECTION.reaction]], `${read} read`);
  }
  assert.equal((await store.records(space, COLLECTION.reaction)).length, 6);
});

test("a collection held in full that exactly fills its bound is complete, not cut", async () => {
  const network = new FakeNetwork();
  const space = await createChannel(network, "general", [ALICE, BOB, READER]);
  await writeMessage(network, ALICE, space, 1);
  await writeMessage(network, BOB, space, 2);
  for (let n = 0; n < 6; n += 1) await network.writeAs(ALICE, space, COLLECTION.reaction, `r${n}`, { subject: "x", emoji: "👍", createdAt: "2026-11-10T12:00:00.000Z" });
  // Two full pages, each with a cursor as the host gives one, then a one-record probe that finds nothing more.
  const { core, store } = syncFor(network, READER, { options: { allPageSize: 3, maxRecordsPerCollection: 6 } });
  const page = await readChannel(core, space);
  assert.deepEqual([page.complete, page.cut], [true, []]);
  assert.equal((await store.records(space, COLLECTION.reaction)).length, 6);
});

test("a writer whose first page sits wholly above the page's cutoff is backfilled until the page is whole", async () => {
  const network = new FakeNetwork();
  const space = await createChannel(network, "general", [ALICE, BOB, READER]);
  for (let n = 101; n <= 125; n += 1) await writeMessage(network, ALICE, space, n);
  for (let n = 1; n <= 25; n += 1) await writeMessage(network, BOB, space, n);
  // At the default page size each writer's first listing is its share of the page, at least ten: alice's ten are not enough.
  const page = await readChannel(syncFor(network, READER).core, space, { limit: 20 });
  assert.deepEqual(keysOf(page), Array.from({ length: 20 }, (_, index) => key(125 - index)));
  assert.equal(page.complete, true);
});

test("listings running at once cannot together hold more than the bound", async () => {
  const network = new FakeNetwork();
  const writers = Array.from({ length: 8 }, (_, index) => `did:plc:writer${index}`);
  const space = await createChannel(network, "general", [...writers, READER]);
  await writeMessage(network, writers[0]!, space, 1);
  for (const writer of writers) {
    for (let n = 0; n < 5; n += 1) await network.writeAs(writer, space, COLLECTION.reaction, `r${n}`, { subject: "x", emoji: "👍", createdAt: "2026-11-10T12:00:00.000Z" });
  }
  const { core, store } = syncFor(network, READER, { options: { maxRecordsPerCollection: 6 } });
  const page = await readChannel(core, space);
  assert.ok((await store.records(space, COLLECTION.reaction)).length <= 6);
  assert.deepEqual(page.cut, [COLLECTION.reaction]);
  assert.equal(page.complete, false);
});

test("a refresh after scrolling deep costs what it costs without scrolling: it lists down to the latest page, not everything held", async () => {
  const costOfNewMessage = async (scroll: boolean) => {
    const network = new FakeNetwork();
    const space = await createChannel(network, "general", [ALICE, READER]);
    for (let n = 1; n <= 30; n += 1) await writeMessage(network, ALICE, space, n);
    const { core } = syncFor(network, READER, { options: { pageSize: 5 } });
    let page = await readChannel(core, space, { limit: 5 });
    while (scroll && page.next) page = await readChannel(core, space, { limit: 5, before: page.next });
    await writeMessage(network, ALICE, space, 31);
    return countCalls(network, () => readChannel(core, space, { limit: 5 }));
  };
  const deep = await costOfNewMessage(true);
  assert.deepEqual(deep, await costOfNewMessage(false));
  assert.equal(deep["com.atproto.space.getLatestCommit"], 2);
});

test("a full listing marks writers whose reported revision moved, as a hint would", async () => {
  const { network, space, core } = await seeded();
  await readChannel(core, space, { limit: 3 });
  network.advanceClock(50 * 60 * 1000);
  await writeMessage(network, ALICE, space, 11);
  await readChannel(core, space, { limit: 3 });
  await writeMessage(network, ALICE, space, 12);
  network.advanceClock(11 * 60 * 1000);
  const page = await readChannel(core, space, { limit: 3 });
  assert.deepEqual(keysOf(page), [key(12), key(11), key(10)]);
});

test("a writer purged while a refresh of it is in flight is not brought back", async () => {
  const { network, space, core, store } = await seeded();
  await readChannel(core, space);
  await writeMessage(network, BOB, space, 11);
  network.beforeListRecords = async ({ repo }) => {
    if (repo !== BOB) return;
    network.beforeListRecords = undefined;
    await writeMessage(network, BOB, space, 12);
    await store.purgeWriter(space, BOB);
  };
  await readChannel(core, space);
  assert.deepEqual(await store.records(space, COLLECTION.message, BOB), []);
});

test("a check time in the future, after the clock was set back, counts as due", async () => {
  const { network, space, core } = await seeded();
  await readChannel(core, space, { limit: 3 });
  network.setListingLag(space, true);
  await writeMessage(network, BOB, space, 11);
  network.advanceClock(-2 * core.options.truthIntervalMs);
  assert.deepEqual(keysOf(await readChannel(core, space, { limit: 3 })), [key(11), key(10), key(9)]);
});

test("backfills running at once cannot together hold more than the bound", async () => {
  const network = new FakeNetwork();
  const writers = Array.from({ length: 8 }, (_, index) => `did:plc:deep${index}`);
  const space = await createChannel(network, "general", [...writers, READER]);
  for (const [index, writer] of writers.entries()) for (let n = 0; n < 20; n += 1) await writeMessage(network, writer, space, index * 100 + n);
  const { core, store } = syncFor(network, READER, { options: { pageSize: 5, maxRecordsPerCollection: 60 } });
  const page = await readChannel(core, space, { limit: 100 });
  assert.ok((await store.records(space, COLLECTION.message)).length <= 60);
  assert.deepEqual(page.cut, [COLLECTION.message]);
});

test("window reads never claim setHash, preserve existing setHash/commitDigest, and reject forged record CIDs", async () => {
  const { network, space, core, store } = await seeded();
  const partialFirst = await readChannel(core, space, { limit: 2 });
  assert.equal(partialFirst.complete, true);
  assert.equal((await store.getWriter(space, ALICE))?.setHash, undefined, "partial window read never seeds setHash");

  const verified = await core.syncVerifiedSpace({ space, collections: [COLLECTION.message, COLLECTION.reaction] });
  assert.equal(verified.complete, true);
  const aliceBefore = await store.getWriter(space, ALICE);
  assert.equal(aliceBefore?.setHash?.length, LTHASH_STATE_BYTES);
  assert.equal(aliceBefore?.commitDigest?.length, 32);

  // Window check (same rev on fresh SyncCore) and backfill preserve setHash & commitDigest;
  // a window refresh at a new rev leaves setHash undefined so verified sync falls back to STAR instead of reusing an old setHash.
  const freshWindow = syncFor(network, READER, { store, options: { pageSize: 2 } }).core;
  const backfillPage = await readChannel(freshWindow, space, { limit: 2 });
  assert.ok(backfillPage.next);
  await readChannel(freshWindow, space, { limit: 2, before: backfillPage.next });
  const aliceAfterCheck = await store.getWriter(space, ALICE);
  assert.equal(aliceAfterCheck?.setHash?.length, LTHASH_STATE_BYTES, "window check and backfill preserve persisted setHash");
  assert.equal(aliceAfterCheck?.commitDigest?.length, 32, "window check and backfill preserve persisted commitDigest");

  await writeMessage(network, ALICE, space, 11);
  await readChannel(freshWindow, space, { limit: 2 });
  assert.equal((await store.getWriter(space, ALICE))?.setHash, undefined, "partial window refresh clears stale setHash at new rev");

  // Forged CID in channel window listRecords sets aside the bad writer permanently without breaking honest writers.
  network.interceptResponse = async ({ method, params, response }) => {
    if (method !== "com.atproto.space.listRecords" || params.repo !== BOB) return response;
    const body = (await response.json()) as { records: Array<{ cid?: string; [k: string]: unknown }> };
    return new Response(
      JSON.stringify({
        ...body,
        records: body.records.map((entry, idx) => (idx === 0 ? { ...entry, cid: "bafyreigbtj4x7ip5legnfzn53mq67x67v4z4j6z4q4b7n4f6q6f4e4d4c4" } : entry)),
      }),
      { status: response.status, headers: response.headers },
    );
  };
  await writeMessage(network, BOB, space, 12);
  const withForgery = await readChannel(core, space, { limit: 5 });
  assert.deepEqual(withForgery.setAside.map((entry) => ({ did: entry.did, permanent: entry.permanent })), [
    { did: BOB, permanent: true },
  ]);
  assert.deepEqual(await store.records(space, COLLECTION.message, BOB), [], "permanent CID forgery drops bad writer records");
  assert.ok(withForgery.items.some((item) => item.repo === ALICE), "honest writers still appear");
});

test("syncVerifiedWorkspaceSnapshot verifies authority records via STAR and 404 fallback, and degrades on invalid records", async () => {
  const network = new FakeNetwork();
  const { workspace } = await createWorkspace(network, {
    members: [ALICE, BOB, READER],
    channels: [{ skey: "general", visibility: "public" }],
  });
  await network.writeAs(AUTHORITY, workspace, COLLECTION.extInstall, "tasks", {
    extId: "tasks",
    active: true,
    space: extSpaceUriFor(AUTHORITY, "acme", "tasks"),
    cleanupComplete: true,
    enabledBy: AUTHORITY,
    enabledAt: "2026-11-10T12:00:00.000Z",
    updatedAt: "2026-11-10T12:00:00.000Z",
  });

  const { core } = syncFor(network, READER);
  const starCalls = await countCalls(network, async () => {
    const snap = await core.syncVerifiedWorkspaceSnapshot(workspace);
    assert.equal(snap.workspaceSnapshotComplete, true);
    assert.equal(snap.rosterMembers.has(ALICE), true);
    assert.equal(snap.rosterMembers.has(BOB), true);
    assert.equal(snap.extensions.length, 1);
    assert.equal(snap.extensions[0]!.extId, "tasks");
  });
  assert.equal(starCalls["com.atproto.space.getRepo"], 1);
  assert.equal(starCalls["com.atproto.space.getRecord"], undefined);

  // Fallback when authority getRepo returns 404/501 uses bounded listRecords + getLatestCommit.
  const { core: fallbackCore } = syncFor(network, READER);
  network.interceptResponse = ({ method, response }) => {
    if (method === "com.atproto.space.getRepo") {
      return new Response(JSON.stringify({ error: "MethodNotImplemented", message: "no STAR" }), {
        status: 501,
        headers: { "content-type": "application/json" },
      });
    }
    return response;
  };
  const fallbackSnap = await fallbackCore.syncVerifiedWorkspaceSnapshot(workspace);
  assert.equal(fallbackSnap.workspaceSnapshotComplete, true);
  assert.equal(fallbackSnap.rosterMembers.has(ALICE), true);
  network.interceptResponse = undefined;

  // Malformed roster record forces workspaceSnapshotComplete = false, and syncVerifiedSpace keeps complete = false.
  await network.writeAs(AUTHORITY, workspace, COLLECTION.workspaceRoster, "bad-roster-key", {
    subject: "not-a-did",
    active: true,
    updatedAt: "2026-11-10T12:00:00.000Z",
  });
  const degradedSnap = await core.syncVerifiedWorkspaceSnapshot(workspace);
  assert.equal(degradedSnap.workspaceSnapshotComplete, false);
  const taskSync = await core.syncVerifiedSpace({
    space: workspace,
    collections: [COLLECTION.task],
    verifiedRosterMembers: degradedSnap.rosterMembers,
    workspaceSnapshotComplete: degradedSnap.workspaceSnapshotComplete,
  });
  assert.equal(taskSync.complete, false);
});

test("syncVerifiedSpace cold STAR, warm reopen with 0 writer calls, and incremental listRepoOps multi-op replay", async () => {
  const network = new FakeNetwork();
  network.createAccount(CAROL, "pds1");
  const { workspace, channels } = await createWorkspace(network, {
    members: [ALICE, BOB, READER],
    channels: [{ skey: "tasks", visibility: "public" }],
  });
  await writeMessage(network, ALICE, channels.tasks!, 1, "m1");
  await network.applyWritesAs(BOB, workspace, [
    { action: "create", collection: COLLECTION.task, rkey: key(1), value: { title: "first", status: "open", createdAt: "2026-11-10T12:00:00.000Z" } },
    { action: "create", collection: COLLECTION.task, rkey: key(2), value: { title: "second", status: "open", createdAt: "2026-11-10T12:00:00.000Z" } },
  ]);

  const sharedStore = new MemoryStore();
  const tab1 = syncFor(network, READER, { store: sharedStore }).core;
  const coldCalls = await countCalls(network, async () => {
    const res = await tab1.syncVerifiedSpace({
      space: workspace,
      collections: [COLLECTION.task],
      verifiedRosterMembers: [AUTHORITY, ALICE, BOB, CAROL, READER],
      workspaceSnapshotComplete: true,
      includeAuthority: true,
    });
    assert.equal(res.complete, true);
    assert.equal(res.records.length, 2);
    assert.deepEqual(res.emptyUnwrittenWriters, [CAROL]);
    assert.equal(res.emptyReasons[CAROL], "unwrittenOrAbsent");
  });
  assert.ok((coldCalls["com.atproto.space.getRepo"] ?? 0) >= 2, "cold load uses STAR for written repos");
  assert.equal(coldCalls["com.atproto.space.getRecord"], undefined);

  // Warm reopen on a fresh SyncCore over the same persisted SyncStore within truthIntervalMs -> 0 writer calls!
  const tab2 = syncFor(network, READER, { store: sharedStore }).core;
  const warmCalls = await countCalls(network, async () => {
    const res = await tab2.syncVerifiedSpace({
      space: workspace,
      collections: [COLLECTION.task],
      verifiedRosterMembers: [AUTHORITY, ALICE, BOB, CAROL, READER],
      workspaceSnapshotComplete: true,
      includeAuthority: true,
    });
    assert.equal(res.complete, true);
    assert.equal(res.records.length, 2);
  });
  assert.equal(warmCalls["com.atproto.space.listRepos"], 2);
  assert.equal(warmCalls["com.atproto.space.getRepo"], undefined);
  assert.equal(warmCalls["com.atproto.space.listRepoOps"], undefined);
  assert.equal(warmCalls["com.atproto.space.listRecords"], undefined);
  assert.equal(warmCalls["com.atproto.space.getLatestCommit"], undefined);

  // Advance Bob with same-rev applyWrites (intermediate update + delete + create across collections), leaving Carol unwritten.
  await network.applyWritesAs(BOB, workspace, [
    { action: "update", collection: COLLECTION.task, rkey: key(1), value: { title: "first-edited", status: "done", createdAt: "2026-11-10T12:00:00.000Z" } },
    { action: "delete", collection: COLLECTION.task, rkey: key(2) },
    { action: "create", collection: COLLECTION.task, rkey: key(3), value: { title: "third", status: "open", createdAt: "2026-11-10T12:00:00.000Z" } },
  ]);
  const deltaCalls = await countCalls(network, async () => {
    const res = await tab2.syncVerifiedSpace({
      space: workspace,
      collections: [COLLECTION.task],
      verifiedRosterMembers: [AUTHORITY, ALICE, BOB, CAROL, READER],
      workspaceSnapshotComplete: true,
      includeAuthority: true,
    });
    assert.equal(res.complete, true);
    assert.deepEqual(
      res.records.map((r) => ({ rkey: r.rkey, title: r.value.title })),
      [{ rkey: key(1), title: "first-edited" }, { rkey: key(3), title: "third" }],
    );
  });
  assert.equal(deltaCalls["com.atproto.space.listRepoOps"], 1);
  assert.equal(deltaCalls["com.atproto.space.getRepo"], undefined);
});

test("syncVerifiedSpace falls back cleanly from broken oplog/reset/IDB-v1-upgrade to STAR, and aborts on STAR limits without listRecords retry", async () => {
  const network = new FakeNetwork();
  const space = await createChannel(network, "general", [ALICE, BOB, READER]);
  await writeMessage(network, ALICE, space, 1, "one");
  await writeMessage(network, ALICE, space, 2, "two");
  const { core, store } = syncFor(network, READER);

  await core.syncVerifiedSpace({ space, collections: [COLLECTION.message] });

  // 1. Pruned oplog -> listRepoOps breaks prev/rev check -> falls back cleanly to STAR recovery.
  await writeMessage(network, ALICE, space, 3, "three");
  await writeMessage(network, ALICE, space, 4, "four");
  network.pruneOplog(space, ALICE);
  const afterPrune = await core.syncVerifiedSpace({ space, collections: [COLLECTION.message] });
  assert.equal(afterPrune.complete, true);
  assert.equal(afterPrune.records.length, 4);

  // 2. Corrupted/decreasing rev or stripped value on surviving op triggers STAR fallback (while intermediate stripped op is allowed).
  await writeMessage(network, ALICE, space, 5, "five");
  let corruptOnce = true;
  network.interceptResponse = async ({ method, params, response }) => {
    if (!corruptOnce || method !== "com.atproto.space.listRepoOps" || params.repo !== ALICE) return response;
    corruptOnce = false;
    const body = (await response.json()) as { ops: Array<Record<string, unknown>> };
    return new Response(
      JSON.stringify({
        ...body,
        ops: body.ops.map((op) => ({ ...op, prev: "bafyreigbtj4x7ip5legnfzn53mq67x67v4z4j6z4q4b7n4f6q6f4e4d4c4" })),
      }),
      { status: response.status, headers: response.headers },
    );
  };
  const fallbackCalls = await countCalls(network, async () => {
    const res = await core.syncVerifiedSpace({ space, collections: [COLLECTION.message] });
    assert.equal(res.complete, true);
    assert.equal(res.records.length, 5);
  });
  network.interceptResponse = undefined;
  assert.equal(fallbackCalls["com.atproto.space.getRepo"], 1, "broken oplog triggers STAR recovery");

  // 3. Intermediate superseded op with value: undefined passes without STAR fallback when final surviving op has value.
  await network.applyWritesAs(ALICE, space, [
    { action: "create", collection: COLLECTION.message, rkey: key(6), value: { text: "v1", createdAt: "2026-11-10T12:00:00.000Z" } },
    { action: "update", collection: COLLECTION.message, rkey: key(6), value: { text: "v2", createdAt: "2026-11-10T12:00:00.000Z" } },
  ]);
  network.interceptResponse = async ({ method, params, response }) => {
    if (method !== "com.atproto.space.listRepoOps" || params.repo !== ALICE) return response;
    const body = (await response.json()) as { ops: Array<Record<string, unknown>> };
    return new Response(
      JSON.stringify({
        ...body,
        ops: body.ops.map((op, i) => (i === 0 ? { ...op, value: undefined } : op)),
      }),
      { status: response.status, headers: response.headers },
    );
  };
  const supersededCalls = await countCalls(network, async () => {
    const res = await core.syncVerifiedSpace({ space, collections: [COLLECTION.message] });
    assert.equal(res.records.find((r) => r.rkey === key(6))?.value.text, "v2");
  });
  network.interceptResponse = undefined;
  assert.equal(supersededCalls["com.atproto.space.getRepo"], undefined);

  // 4. IDB v1->v2 upgrade: state has syncedRev !== null but setHash === undefined -> recovers via STAR, never trusts getLatestCommit alone.
  const preUpgrade = await store.getWriter(space, ALICE);
  assert.ok(preUpgrade);
  await store.commit({
    space,
    repo: ALICE,
    expectedGeneration: preUpgrade.generation,
    next: { syncedRev: preUpgrade.syncedRev, checkedAt: 0, stale: false, coverage: preUpgrade.coverage },
  });
  const afterUpgradeCalls = await countCalls(network, async () => {
    const res = await core.syncVerifiedSpace({ space, collections: [COLLECTION.message] });
    assert.equal(res.complete, true);
  });
  assert.equal(afterUpgradeCalls["com.atproto.space.getRepo"], 1);
  assert.equal((await store.getWriter(space, ALICE))?.setHash?.length, LTHASH_STATE_BYTES);

  // 5. RepoStarLimitError aborts immediately WITHOUT falling back to listRecords!
  await writeMessage(network, BOB, space, 1, "bob-1");
  await writeMessage(network, BOB, space, 2, "bob-2");
  const limitedCalls = await countCalls(network, async () => {
    const res = await syncFor(network, READER).core.syncVerifiedSpace({
      space,
      collections: [COLLECTION.message],
      maxStarRecords: 1,
    });
    assert.equal(res.complete, false);
    assert.equal(res.setAside.some((entry) => entry.did === BOB), true);
  });
  assert.equal(limitedCalls["com.atproto.space.listRecords"], undefined, "RepoStarLimitError must not fall back to listRecords");
});

test("D14 purge waits for both listRepos and verifiedRosterMembers, and RepoNotFound enforces strict trust boundary", async () => {
  const network = new FakeNetwork();
  network.createAccount(CAROL, "pds1");
  const { workspace, channels } = await createWorkspace(network, {
    members: [ALICE, BOB, READER],
    channels: [{ skey: "tasks", visibility: "public" }],
  });
  await writeMessage(network, ALICE, channels.tasks!, 1, "keep");

  const { core, store } = syncFor(network, READER);
  // First sync: BOB is listed only via roster (unwritten), valid PDS -> trusted empty; ALICE has record.
  const first = await core.syncVerifiedSpace({
    space: channels.tasks!,
    collections: [COLLECTION.message],
    verifiedRosterMembers: [ALICE, BOB, CAROL, READER],
    workspaceSnapshotComplete: true,
  });
  assert.equal(first.complete, true);
  assert.equal(first.emptyReasons[BOB], "unwrittenOrAbsent");
  assert.equal((await store.getWriter(channels.tasks!, BOB))?.syncedRev, null);

  // Remove ALICE from listRepos while still in verifiedRosterMembers -> NOT purged under D14 yet!
  await network.clientFor(AUTHORITY).procedure("com.atproto.memberspace.removeMember", { space: channels.tasks!, did: ALICE });
  network.advanceClock(core.options.truthIntervalMs);
  const midEvict = await core.syncVerifiedSpace({
    space: channels.tasks!,
    collections: [COLLECTION.message],
    verifiedRosterMembers: [ALICE, BOB, CAROL, READER],
    workspaceSnapshotComplete: true,
  });
  assert.equal(midEvict.records.some((r) => r.repo === ALICE), true, "held while verifiedRosterMembers still retains Alice");

  // Drop ALICE from verifiedRosterMembers too -> purged under D14!
  network.advanceClock(core.options.truthIntervalMs);
  const fullEvict = await core.syncVerifiedSpace({
    space: channels.tasks!,
    collections: [COLLECTION.message],
    verifiedRosterMembers: [BOB, CAROL, READER],
    workspaceSnapshotComplete: true,
  });
  assert.equal(fullEvict.records.some((r) => r.repo === ALICE), false);
  const evictedAlice = await store.getWriter(channels.tasks!, ALICE);
  assert.equal(evictedAlice?.syncedRev, null);
  assert.deepEqual(evictedAlice?.coverage, {});

  // BOB now writes for the first time -> once truthInterval or markSpaceStale fires, Reader picks it up!
  await writeMessage(network, BOB, channels.tasks!, 1, "bob-first-write");
  await core.markSpaceStale(channels.tasks!);
  const afterWrite = await core.syncVerifiedSpace({
    space: channels.tasks!,
    collections: [COLLECTION.message],
    verifiedRosterMembers: [BOB, CAROL, READER],
    workspaceSnapshotComplete: true,
  });
  assert.equal(afterWrite.complete, true);
  assert.equal(afterWrite.emptyReasons[BOB], undefined);
  assert.equal(afterWrite.records.find((r) => r.repo === BOB)?.value.text, "bob-first-write");

  // RepoNotFound when previously synced (syncedRev !== null) -> FAIL CLOSED transiently (permanent: false) while keeping verified cached records!
  network.setAccountState(BOB, "missing");
  await core.markSpaceStale(channels.tasks!);
  const missingAfterSync = await core.syncVerifiedSpace({
    space: channels.tasks!,
    collections: [COLLECTION.message],
    verifiedRosterMembers: [BOB, CAROL, READER],
    workspaceSnapshotComplete: true,
  });
  assert.equal(missingAfterSync.complete, false);
  assert.deepEqual(missingAfterSync.setAside, [{ did: BOB, reason: "its host has no repo for it", permanent: false }]);
  assert.equal(missingAfterSync.records.find((r) => r.repo === BOB)?.value.text, "bob-first-write");
  // Repeat read still fails closed (permanent: false) until writer recovers or is evicted under D14.
  await network.clientFor(AUTHORITY).procedure("com.atproto.memberspace.removeMember", { space: channels.tasks!, did: BOB });
  await core.markSpaceStale(channels.tasks!);
  const missingSecondRead = await core.syncVerifiedSpace({
    space: channels.tasks!,
    collections: [COLLECTION.message],
    verifiedRosterMembers: [BOB, CAROL, READER],
    workspaceSnapshotComplete: true,
  });
  assert.equal(missingSecondRead.complete, false);
  assert.deepEqual(missingSecondRead.setAside, [{ did: BOB, reason: "its host has no repo for it", permanent: false }]);
  assert.equal(missingSecondRead.records.find((r) => r.repo === BOB)?.value.text, "bob-first-write");

  // RepoNotFound when listed in listRepos on cold read OR invalid resolvePds -> FAIL CLOSED (permanent: false)!
  const carolListedNetwork = new FakeNetwork();
  const s2 = await createChannel(carolListedNetwork, "g2", [CAROL, READER]);
  await writeMessage(carolListedNetwork, CAROL, s2, 1, "hi");
  carolListedNetwork.setAccountState(CAROL, "missing");
  const carolRes = await syncFor(carolListedNetwork, READER).core.syncVerifiedSpace({ space: s2, collections: [COLLECTION.message] });
  assert.equal(carolRes.complete, false);
  assert.deepEqual(carolRes.setAside.map((e) => ({ did: e.did, permanent: e.permanent })), [{ did: CAROL, permanent: false }]);

  // resolvePds failure or non-HTTPS endpoint on unwritten roster member -> FAIL CLOSED!
  const badPdsTransport = {
    ...transportFor(network, READER),
    resolvePds: async (did: string) => (did === CAROL ? "http://evil.example" : network.resolvePds(did)),
  };
  const { CredentialCache } = await import("./credentials");
  const { SyncCore } = await import("./sync");
  const badPdsCore = new SyncCore({ transport: badPdsTransport, credentials: new CredentialCache(badPdsTransport), store: new MemoryStore() });
  const badPdsRes = await badPdsCore.syncVerifiedSpace({
    space: channels.tasks!,
    collections: [COLLECTION.message],
    verifiedRosterMembers: [CAROL, READER],
    workspaceSnapshotComplete: true,
  });
  assert.equal(badPdsRes.complete, false);
  assert.equal(badPdsRes.setAside.some((entry) => entry.did === CAROL), true);
  void workspace;
});

test("followRepoOps baselines without downloading payloads, preserves same-rev applyWrites host order, handles reset & retry", async () => {
  const network = new FakeNetwork();
  const space = await createChannel(network, "general", [ALICE, BOB, READER]);
  await writeMessage(network, ALICE, space, 1, "historical");
  let elapsed = 0;
  const clock = { now: () => network.now(), elapsed: () => elapsed };
  const advance = (ms: number) => {
    network.advanceClock(ms);
    elapsed += ms;
  };
  void advance;
  const { core } = syncFor(network, READER);

  let baselineExcludeValues: boolean | undefined;
  network.beforeListRecords = ({ excludeValues }) => {
    baselineExcludeValues = excludeValues;
  };
  const delivered: Array<{ repo: string; rkey: string; text: string }> = [];
  const resets: Array<{ repo: string; reason: string }> = [];
  const base = await core.followRepoOps({
    space,
    collections: [COLLECTION.message],
    deliver: false,
    clock,
    onEvent: async (ev) => {
      delivered.push({ repo: ev.repo, rkey: ev.rkey, text: String(ev.value.text) });
    },
    onReset: (notice) => resets.push({ repo: notice.repo, reason: notice.reason }),
  });
  network.beforeListRecords = undefined;
  assert.equal(base.kind, "baseline");
  assert.equal(baselineExcludeValues, true, "baseline downloads 0 record payloads");
  assert.equal(delivered.length, 0);

  // Write two messages in one applyWrites rev with rkeys intentionally reversed vs TID order (`zzz` BEFORE `aaa`).
  await network.applyWritesAs(ALICE, space, [
    { action: "create", collection: COLLECTION.message, rkey: "zzzzzzzzzzzzz", value: { text: "host-first", createdAt: "2026-11-10T12:00:00.000Z" } },
    { action: "create", collection: COLLECTION.message, rkey: "aaaaaaaaaaaaa", value: { text: "host-second", createdAt: "2026-11-10T12:00:00.000Z" } },
  ]);
  // Update historical message -> should NOT deliver on onEvent.
  await writeMessage(network, ALICE, space, 1, "historical-edited");

  // Simulate transient handler failure on first delivery attempt for `host-first`, while `host-second` succeeds!
  let failOnce = true;
  await core.followRepoOps({
    space,
    collections: [COLLECTION.message],
    deliver: true,
    clock,
    onEvent: async (ev) => {
      if (failOnce && ev.value.text === "host-first") {
        failOnce = false;
        throw new Error("transient boom");
      }
      delivered.push({ repo: ev.repo, rkey: ev.rkey, text: String(ev.value.text) });
    },
    onReset: (notice) => resets.push({ repo: notice.repo, reason: notice.reason }),
  });
  // `host-second` succeeded; `host-first` deferred! Next poll delivers ONLY `host-first` without duplicating `host-second`.
  assert.deepEqual(delivered.map((d) => d.text), ["host-second"]);
  await core.followRepoOps({
    space,
    collections: [COLLECTION.message],
    deliver: true,
    clock,
    onEvent: async (ev) => {
      delivered.push({ repo: ev.repo, rkey: ev.rkey, text: String(ev.value.text) });
    },
    onReset: (notice) => resets.push({ repo: notice.repo, reason: notice.reason }),
  });
  assert.deepEqual(delivered.map((d) => d.text), ["host-second", "host-first"]);

  // Fresh follower checks strict same-rev host order cleanly without failures:
  const ordered: string[] = [];
  const { core: freshCore } = syncFor(network, READER);
  await freshCore.followRepoOps({
    space,
    collections: [COLLECTION.message],
    deliver: false,
    clock,
    onEvent: async () => undefined,
  });
  await network.applyWritesAs(BOB, space, [
    { action: "create", collection: COLLECTION.message, rkey: "zzzzzzzzzzzzz", value: { text: "batch-1", createdAt: "2026-11-10T12:00:00.000Z" } },
    { action: "create", collection: COLLECTION.message, rkey: "aaaaaaaaaaaaa", value: { text: "batch-2", createdAt: "2026-11-10T12:00:00.000Z" } },
  ]);
  await freshCore.followRepoOps({
    space,
    collections: [COLLECTION.message],
    deliver: true,
    clock,
    onEvent: async (ev) => {
      ordered.push(String(ev.value.text));
    },
  });
  assert.deepEqual(ordered, ["batch-1", "batch-2"], "host oplog (rev, idx) order wins over reverse rkey");

  // importRepo reset on BOB emits reset notice, does NOT re-deliver `batch-1`/`batch-2`, and still delivers subsequent writes!
  const postReset: string[] = [];
  const resetNotices: string[] = [];
  await network.importRepoAs(BOB, space, [
    { collection: COLLECTION.message, rkey: "zzzzzzzzzzzzz", value: { text: "batch-1", createdAt: "2026-11-10T12:00:00.000Z" } },
    { collection: COLLECTION.message, rkey: "aaaaaaaaaaaaa", value: { text: "batch-2", createdAt: "2026-11-10T12:00:00.000Z" } },
    { collection: COLLECTION.message, rkey: key(500), value: { text: "in-import-new", createdAt: "2026-11-10T12:00:00.000Z" } },
  ]);
  // Advance past truthInterval (or markSpaceStale) so the imported commit without an authority push is inspected.
  await freshCore.markSpaceStale(space);
  await freshCore.followRepoOps({
    space,
    collections: [COLLECTION.message],
    deliver: true,
    clock,
    onEvent: async (ev) => {
      postReset.push(String(ev.value.text));
    },
    onReset: (notice) => resetNotices.push(notice.repo),
  });
  assert.deepEqual(resetNotices, [BOB]);
  assert.equal(postReset.length, 0, "reset re-baselines cleanly without re-delivering historical records");

  await network.writeAs(BOB, space, COLLECTION.message, key(501), { text: "post-reset-new", createdAt: "2026-11-10T12:00:00.000Z" });
  await freshCore.followRepoOps({
    space,
    collections: [COLLECTION.message],
    deliver: true,
    clock,
    onEvent: async (ev) => {
      postReset.push(String(ev.value.text));
    },
    onReset: (notice) => resetNotices.push(notice.repo),
  });
  assert.deepEqual(postReset, ["post-reset-new"]);

  // Forged CID in listRepoOps sets aside writer cleanly:
  network.interceptResponse = async ({ method, params, response }) => {
    if (method !== "com.atproto.space.listRepoOps" || params.repo !== BOB) return response;
    const body = (await response.json()) as { ops: Array<Record<string, unknown>> };
    const created = body.ops.at(-1)!;
    const fakeCid = RepoCommit.fromRecords([]).toCommit({ space: space as never, repo: BOB as never, rev: tidNow() }).rev;
    void fakeCid;
    return new Response(
      JSON.stringify({
        ...body,
        ops: body.ops.map((op) => (op === created ? { ...op, value: { ...(op.value as Record<string, unknown>), text: "TAMPERED" } } : op)),
      }),
      { status: response.status, headers: response.headers },
    );
  };
  await network.writeAs(BOB, space, COLLECTION.message, key(502), { text: "honest", createdAt: "2026-11-10T12:00:00.000Z" });
  const forgedRes = await freshCore.followRepoOps({
    space,
    collections: [COLLECTION.message],
    deliver: true,
    clock,
    onEvent: async () => undefined,
  });
  network.interceptResponse = undefined;
  assert.equal(forgedRes.complete, false);
  assert.equal(forgedRes.setAside.some((entry) => entry.did === BOB && entry.permanent), true);
  assert.ok(SpaceMacError);
  assert.ok(subjectKey(ALICE));
});

test("JSON fallback and incremental oplog growth enforce cumulative byte limits permanently and purge warm cache", async () => {
  // 1. JSON listRecords fallback exceeding maxStarBytes aborts permanently and purges cached records.
  {
    const network = new FakeNetwork();
    const space = await createChannel(network, "fallback-limit", [ALICE, BOB, READER]);
    await writeMessage(network, ALICE, space, 1, "alice-small");
    await writeMessage(network, BOB, space, 1, "bob-initial");
    const oneSize = await serializedRecordBytes(COLLECTION.message, key(1), {
      text: "bob-initial",
      createdAt: "2026-11-10T12:00:00.000Z",
    });
    const budget = 1024;

    const { core, store } = syncFor(network, READER);
    const seed = await core.syncVerifiedSpace({
      space,
      collections: [COLLECTION.message],
      maxStarBytes: budget,
    });
    assert.equal(seed.complete, true);
    assert.equal(seed.records.some((r) => r.repo === BOB), true);

    // Bob adds records pushing cumulative live CBOR bytes > 1024 while getRepo returns 501 (forcing JSON listRecords fallback).
    await writeMessage(network, BOB, space, 2, `bob-2-${"x".repeat(400)}`);
    await writeMessage(network, BOB, space, 3, `bob-3-${"x".repeat(400)}`);
    await writeMessage(network, BOB, space, 4, `bob-4-${"x".repeat(400)}`);
    let getRepoFallbackCalls = 0;
    network.interceptResponse = ({ method, params, response }) => {
      if (method === "com.atproto.space.getRepo" && params.repo === BOB) {
        getRepoFallbackCalls += 1;
        return new Response(JSON.stringify({ error: "MethodNotImplemented", message: "no star" }), { status: 501 });
      }
      // Force fallback even on delta attempts for this check by returning 501 on listRepoOps too.
      if (method === "com.atproto.space.listRepoOps" && params.repo === BOB) {
        return new Response(JSON.stringify({ error: "MethodNotImplemented", message: "no ops" }), { status: 501 });
      }
      return response;
    };
    await core.markSpaceStale(space);
    const exceeded = await core.syncVerifiedSpace({
      space,
      collections: [COLLECTION.message],
      maxStarBytes: budget,
    });
    assert.ok(oneSize > 0 && getRepoFallbackCalls >= 1);
    assert.equal(exceeded.complete, false);
    assert.deepEqual(exceeded.setAside, [
      { did: BOB, reason: "its answer is larger than this app reads", permanent: true },
    ]);
    assert.equal(exceeded.records.some((r) => r.repo === BOB), false, "permanent size failure purges cached records");
    assert.equal((await store.records(space, COLLECTION.message, BOB)).length, 0);
  }

  // 2. Incremental listRepoOps replay exceeding maxStarBytes aborts permanently via RepoStarLimitError without STAR fallback and purges cache.
  {
    const network = new FakeNetwork();
    const space = await createChannel(network, "oplog-limit", [ALICE, BOB, READER]);
    await writeMessage(network, ALICE, space, 1, "alice-ok");
    await writeMessage(network, BOB, space, 1, `bob-1-${"x".repeat(420)}`);
    const budget = 1024;

    const { core, store } = syncFor(network, READER);
    const initial = await core.syncVerifiedSpace({
      space,
      collections: [COLLECTION.message],
      maxStarBytes: budget,
    });
    assert.equal(initial.complete, true);

    await writeMessage(network, BOB, space, 2, `bob-2-${"y".repeat(420)}`);
    const calls = await countCalls(network, async () => {
      const next = await core.syncVerifiedSpace({
        space,
        collections: [COLLECTION.message],
        maxStarBytes: budget,
      });
      assert.equal(next.complete, false);
      assert.deepEqual(next.setAside, [
        { did: BOB, reason: "its answer is larger than this app reads", permanent: true },
      ]);
      assert.equal(next.records.some((r) => r.repo === BOB), false, "stale oversized cache purged after incremental overflow");
    });
    assert.equal(calls["com.atproto.space.getRepo"] ?? 0, 0, "aborts permanently from listRepoOps without extra STAR fetch");
    assert.equal((await store.records(space, COLLECTION.message, BOB)).length, 0);
  }
});

test("followRepoOps keeps initial baseline sticky across baseline failures and expires missing-writer holds after MAX_HOLD_MS", async () => {
  // Codex #2: deliver:false fails twice with SpaceMacError -> recovers on subsequent deliver:true poll -> historical commands are NOT delivered.
  {
    const network = new FakeNetwork();
    const space = await createChannel(network, "codex2", [ALICE, BOB, READER]);
    await writeMessage(network, BOB, space, 1, "historical-command-1");
    await writeMessage(network, BOB, space, 2, "historical-command-2");

    let corruptBobMac = true;
    network.interceptResponse = ({ method, params, response }) => {
      if (corruptBobMac && method === "com.atproto.space.getLatestCommit" && params.repo === BOB && response.ok) {
        const headers = new Headers(response.headers);
        headers.delete("atproto-space-mac");
        return new Response(response.body, { status: 200, headers });
      }
      return response;
    };

    const { core } = syncFor(network, READER);
    const delivered: string[] = [];
    const poll1 = await core.followRepoOps({
      space,
      collections: [COLLECTION.message],
      deliver: false,
      onEvent: async (ev) => { delivered.push(String(ev.value.text)); },
    });
    assert.equal(poll1.complete, false);
    assert.equal(poll1.setAside.some((entry) => entry.did === BOB && entry.permanent), true);

    const poll2 = await core.followRepoOps({
      space,
      collections: [COLLECTION.message],
      deliver: false,
      onEvent: async (ev) => { delivered.push(String(ev.value.text)); },
    });
    assert.equal(poll2.complete, false);
    assert.equal(delivered.length, 0);

    // Recover Bob's MAC: unrelated ticks stay backed off before truthIntervalMs, then truthIntervalMs recovers cleanly without replaying historical commands.
    corruptBobMac = false;
    network.interceptResponse = undefined;
    const backedOffCalls = await countCalls(network, async () => {
      const earlyPoll = await core.followRepoOps({
        space,
        collections: [COLLECTION.message],
        deliver: true,
        onEvent: async (ev) => { delivered.push(String(ev.value.text)); },
      });
      assert.equal(earlyPoll.complete, false);
      assert.equal(earlyPoll.setAside.some((entry) => entry.did === BOB && entry.permanent), true);
    });
    assert.equal(backedOffCalls["com.atproto.space.getLatestCommit"] ?? 0, 0, "permanent baseline failure does not hammer PDS before truthIntervalMs");

    network.advanceClock(core.options.truthIntervalMs);
    const poll3 = await core.followRepoOps({
      space,
      collections: [COLLECTION.message],
      deliver: true,
      onEvent: async (ev) => { delivered.push(String(ev.value.text)); },
    });
    assert.equal(poll3.complete, true);
    assert.equal(delivered.length, 0, "recovered failed-baseline writer must baseline instead of replaying historical records");

    // Genuine new command written after recovery IS delivered.
    await writeMessage(network, BOB, space, 3, "live-command-after-recovery");
    const poll4 = await core.followRepoOps({
      space,
      collections: [COLLECTION.message],
      deliver: true,
      onEvent: async (ev) => { delivered.push(String(ev.value.text)); },
    });
    assert.deepEqual(poll4.delivered.map((d) => String(d.value.text)), ["live-command-after-recovery"]);
  }

  // Codex #10: missing-writer hold expires after MAX_HOLD_MS (10 min), re-baselining on recovery without replaying stale commands.
  {
    const network = new FakeNetwork();
    const space = await createChannel(network, "codex10", [ALICE, BOB, READER]);
    await writeMessage(network, BOB, space, 1, "initial-seed");
    let elapsed = 0;
    const clock = { now: () => network.now(), elapsed: () => elapsed };
    const advance = (ms: number) => {
      network.advanceClock(ms);
      elapsed += ms;
    };

    const { core } = syncFor(network, READER);
    const delivered: string[] = [];
    const resets: string[] = [];
    const errors: string[] = [];
    await core.followRepoOps({
      space,
      collections: [COLLECTION.message],
      deliver: false,
      clock,
      onEvent: async (ev) => { delivered.push(String(ev.value.text)); },
    });

    // At minute 1, Bob's host fails with 503 after Bob receives a stale command while unreachable from reader.
    advance(60_000);
    await writeMessage(network, BOB, space, 2, "stale-minute-1-cmd");
    network.setHostReachable(BOB, false);
    const downPoll = await core.followRepoOps({
      space,
      collections: [COLLECTION.message],
      deliver: true,
      clock,
      onEvent: async (ev) => { delivered.push(String(ev.value.text)); },
      onReset: (n) => resets.push(`${n.repo}:${n.reason}`),
      onError: (err) => errors.push(err instanceof Error ? err.message : String(err)),
    });
    assert.equal(downPoll.complete, false);
    assert.deepEqual(downPoll.setAside, [{ did: BOB, reason: "its host answered HTTP 503", permanent: false }]);
    assert.equal(resets.length, 0);

    // At minute 5 (< MAX_HOLD_MS), a briefly recovering writer WOULD deliver cleanly; instead keep Bob down past MAX_HOLD_MS (minute 12).
    advance(11 * 60_000);
    assert.ok(elapsed > MAX_HOLD_MS);
    network.setHostReachable(BOB, true);
    const recoveredPoll = await core.followRepoOps({
      space,
      collections: [COLLECTION.message],
      deliver: true,
      clock,
      onEvent: async (ev) => { delivered.push(String(ev.value.text)); },
      onReset: (n) => resets.push(`${n.repo}:${n.reason}`),
      onError: (err) => errors.push(err instanceof Error ? err.message : String(err)),
    });
    assert.equal(recoveredPoll.kind, "reset");
    assert.equal(recoveredPoll.complete, true);
    assert.equal(resets.length, 1);
    assert.match(resets[0]!, new RegExp(`^${BOB}:`));
    assert.equal(delivered.length, 0, "expired missing-writer hold re-baselines without executing stale minute-1 commands");

    // New command at minute 13 IS delivered normally.
    await writeMessage(network, BOB, space, 3, "fresh-minute-13-cmd");
    const postRecovery = await core.followRepoOps({
      space,
      collections: [COLLECTION.message],
      deliver: true,
      clock,
      onEvent: async (ev) => { delivered.push(String(ev.value.text)); },
    });
    assert.deepEqual(postRecovery.delivered.map((d) => String(d.value.text)), ["fresh-minute-13-cmd"]);
    void errors;
  }

  // Transient baseline 503 recovers immediately on the next deliver:true tick without waiting truthIntervalMs and without replaying historical commands.
  {
    const network = new FakeNetwork();
    const space = await createChannel(network, "transient-baseline", [ALICE, BOB, READER]);
    await writeMessage(network, BOB, space, 1, "historical-503");
    network.setHostReachable(BOB, false);
    const { core } = syncFor(network, READER);
    const delivered: string[] = [];
    const basePoll = await core.followRepoOps({
      space,
      collections: [COLLECTION.message],
      deliver: false,
      onEvent: async (ev) => { delivered.push(String(ev.value.text)); },
    });
    assert.equal(basePoll.complete, false);
    network.setHostReachable(BOB, true);
    const recovered = await core.followRepoOps({
      space,
      collections: [COLLECTION.message],
      deliver: true,
      onEvent: async (ev) => { delivered.push(String(ev.value.text)); },
    });
    assert.equal(recovered.complete, true);
    assert.equal(delivered.length, 0);
  }
});

test("fetchRepoOpsPages aborts multi-page listRepoOps early on staging payload overflow in syncVerifiedSpace and followRepoOps (Codex R2-#1 / Carbon R2-M1)", async () => {
  // 1. syncVerifiedSpace falls back cleanly to streaming STAR before fetching cursor pages beyond maxPayloadBytes.
  {
    const network = new FakeNetwork();
    const space = await createChannel(network, "staging-cap-sync", [ALICE, BOB, READER]);
    await writeMessage(network, BOB, space, 1, "bob-seed");
    const { core } = syncFor(network, READER);
    assert.equal((await core.syncVerifiedSpace({ space, collections: [COLLECTION.message] })).complete, true);

    await writeMessage(network, BOB, space, 2, "bob-trigger");
    const cursorsRequested: Array<string | undefined> = [];
    const largeChunk = "z".repeat(4_800_000);
    network.interceptResponse = ({ method, params, response }) => {
      if (method === "com.atproto.space.listRepoOps" && params.repo === BOB) {
        const cursor = typeof params.cursor === "string" ? params.cursor : undefined;
        cursorsRequested.push(cursor);
        const pageNum = cursor === undefined ? 1 : Number(cursor.replace("p", ""));
        return new Response(
          JSON.stringify({
            ops: [
              { rev: `rev-${pageNum}`, idx: 0, collection: COLLECTION.message, rkey: key(pageNum + 2), cid: "bafyreigbtj4x7ip5legnfznqu3bdr24v6s2s6x2f3b5f6r6x5c7u6o2t3y", prev: null, value: { text: largeChunk } },
            ],
            ...(pageNum < 10 ? { cursor: `p${pageNum + 1}` } : {}),
          }),
          { status: 200, headers: response.headers },
        );
      }
      return response;
    };

    const res = await core.syncVerifiedSpace({ space, collections: [COLLECTION.message] });
    assert.equal(res.complete, true, "falls back cleanly via STAR to actual host state");
    assert.ok(cursorsRequested.length >= 3 && cursorsRequested.length <= 4, `aborted early at <=4 pages (~16 MiB staging cap), fetched ${cursorsRequested.length}`);
    assert.equal(cursorsRequested.includes("p6"), false, "remaining cursor pages were never fetched");
  }

  // 2. followRepoOps aborts multi-page listRepoOps early and triggers bounded reset instead of buffering unbounded pages in RAM.
  {
    const network = new FakeNetwork();
    const space = await createChannel(network, "staging-cap-follow", [ALICE, READER]);
    await writeMessage(network, ALICE, space, 1, "seed");
    const { core } = syncFor(network, READER);
    assert.equal((await core.followRepoOps({ space, collections: [COLLECTION.message], deliver: false, onEvent: async () => undefined })).complete, true);

    await writeMessage(network, ALICE, space, 2, "alice-trigger");
    const cursorsRequested: Array<string | undefined> = [];
    const largeChunk = "w".repeat(4_800_000);
    network.interceptResponse = ({ method, params, response }) => {
      if (method === "com.atproto.space.listRepoOps" && params.repo === ALICE) {
        const cursor = typeof params.cursor === "string" ? params.cursor : undefined;
        cursorsRequested.push(cursor);
        const pageNum = cursor === undefined ? 1 : Number(cursor.replace("p", ""));
        return new Response(
          JSON.stringify({
            ops: [
              { rev: `rev-${pageNum}`, idx: 0, collection: COLLECTION.message, rkey: key(pageNum + 2), cid: "bafyreigbtj4x7ip5legnfznqu3bdr24v6s2s6x2f3b5f6r6x5c7u6o2t3y", prev: null, value: { text: largeChunk } },
            ],
            ...(pageNum < 10 ? { cursor: `p${pageNum + 1}` } : {}),
          }),
          { status: 200, headers: response.headers },
        );
      }
      return response;
    };

    const resets: string[] = [];
    const poll = await core.followRepoOps({
      space,
      collections: [COLLECTION.message],
      deliver: true,
      onEvent: async () => undefined,
      onReset: (notice) => resets.push(notice.reason),
    });
    assert.equal(poll.kind, "reset");
    assert.ok(cursorsRequested.length >= 3 && cursorsRequested.length <= 4, `aborted followRepoOps paging early at ${cursorsRequested.length} pages`);
    assert.equal(cursorsRequested.includes("p6"), false);
    assert.match(resets[0]!, /payload byte staging bound/);
  }
});

test("cold in-flight generation-0 syncVerifiedWorkspaceSnapshot cannot commit stale state past concurrent markSpaceStale (Codex R2-#2)", async () => {
  const network = new FakeNetwork();
  const fixture = await createWorkspace(network, { members: [ALICE], channels: [{ skey: "general", visibility: "public" }] });
  const tasksSpace = extSpaceUriFor(AUTHORITY, "acme", "tasks");
  await network.clientFor(AUTHORITY).procedure("com.atproto.space.createSpace", {
    spaceType: "new.flock.ext.tasks",
    skey: "acme-tasks",
    policy: memberspacePolicy(),
  });
  await network.writeAs(AUTHORITY, fixture.workspace, COLLECTION.extInstall, "tasks", {
    extId: "tasks",
    space: tasksSpace,
    active: true,
    enabledBy: AUTHORITY,
    enabledAt: "2026-11-10T12:00:00.000Z",
    updatedAt: "2026-11-10T12:00:00.000Z",
  });

  const { core } = syncFor(network, ALICE);
  assert.equal(await core.store.getSpace(fixture.workspace), undefined);
  assert.equal(await core.store.getWriter(fixture.workspace, AUTHORITY), undefined);

  let releaseStaleStar!: () => void;
  const staleStarGate = new Promise<void>((resolve) => {
    releaseStaleStar = resolve;
  });
  let markPaused!: () => void;
  const paused = new Promise<void>((resolve) => {
    markPaused = resolve;
  });
  let pausedOnce = false;
  network.interceptResponse = async ({ method, params, response }) => {
    if (!pausedOnce && method === "com.atproto.space.getRepo" && params.space === fixture.workspace && response.ok) {
      pausedOnce = true;
      markPaused();
      await staleStarGate;
    }
    return response;
  };

  // Start cold workspace snapshot sync (generation 0, invalidationSeq 0).
  const snapshotPromise = core.syncVerifiedWorkspaceSnapshot(fixture.workspace, { truthIntervalMs: core.options.truthIntervalMs });
  await Promise.race([
    paused,
    snapshotPromise.then(() => {
      throw new Error("syncVerifiedWorkspaceSnapshot finished before getRepo intercepted");
    }),
  ]);

  // Concurrently disable Tasks and call markSpaceStale(workspace) while old valid STAR snapshot is delayed in flight.
  await network.writeAs(AUTHORITY, fixture.workspace, COLLECTION.extInstall, "tasks", {
    extId: "tasks",
    space: tasksSpace,
    active: false,
    enabledBy: AUTHORITY,
    enabledAt: "2026-11-10T12:00:00.000Z",
    updatedAt: "2026-11-10T12:01:00.000Z",
    disabledAt: "2026-11-10T12:01:00.000Z",
  });
  await core.markSpaceStale(fixture.workspace);
  releaseStaleStar();

  const snapshot = await snapshotPromise;
  const tasksExt = snapshot.extensions.find((ext) => ext.extId === "tasks");
  assert.equal(tasksExt?.active, false, "cold generation-0 commit refused stale snapshot and retried to observe active: false");
  const persistedExt = await core.store.getRecord(fixture.workspace, AUTHORITY, COLLECTION.extInstall, "tasks");
  assert.equal(persistedExt?.value.active, false);
});

test("followRepoOps isolates failed initial writers from new joiners, tracks permanent backoff, recovers hold-expiry post-floor commands, and skips genesis replay after permanent failures (Codex R2-#4/#5 + Carbon R2-H2)", async () => {
  // 1. Codex R2-#4 + Carbon R2-H2 Trace 1: Alice baselines + Bob fails permanently (RepoDeactivated) -> Carol joins on deliver:true and delivers immediately without hammering Bob.
  {
    const network = new FakeNetwork();
    const space = await createChannel(network, "r2h2-trace1", [ALICE, BOB, READER]);
    await writeMessage(network, ALICE, space, 1, "alice-historical");
    await writeMessage(network, BOB, space, 1, "bob-pre-deactivation");
    network.setAccountState(BOB, "deactivated");

    const { core } = syncFor(network, READER);
    const delivered: Array<{ repo: string; text: string }> = [];
    const basePoll = await core.followRepoOps({
      space,
      collections: [COLLECTION.message],
      deliver: false,
      onEvent: async (ev) => { delivered.push({ repo: ev.repo, text: String(ev.value.text) }); },
    });
    assert.equal(basePoll.complete, false);
    assert.deepEqual(basePoll.setAside.map((s) => ({ did: s.did, permanent: s.permanent })), [{ did: BOB, permanent: true }]);
    assert.equal(delivered.length, 0);

    // Carol joins after initial baseline while Bob is still deactivated!
    network.createAccount(CAROL, "pds2");
    await network.clientFor(AUTHORITY).procedure("com.atproto.memberspace.putMember", {
      space,
      did: CAROL,
      read: true,
      write: true,
    });
    await network.writeAs(CAROL, space, COLLECTION.message, tidNow(network.now(), 0), {
      text: "carol-first-live-command",
      createdAt: "2026-11-10T12:00:00.000Z",
    });

    const carolCalls = await countCalls(network, async () => {
      const carolPoll = await core.followRepoOps({
        space,
        collections: [COLLECTION.message],
        deliver: true,
        onEvent: async (ev) => { delivered.push({ repo: ev.repo, text: String(ev.value.text) }); },
      });
      assert.deepEqual(carolPoll.delivered.map((d) => String(d.value.text)), ["carol-first-live-command"]);
      assert.equal(carolPoll.setAside.some((s) => s.did === BOB && s.permanent), true);
    });
    assert.equal(delivered.length, 1);
    // Verify Bob's deactivated PDS was NOT polled during Carol's deliver:true tick (only Carol's PDS + authority).
    assert.equal(carolCalls["com.atproto.space.getLatestCommit"] ?? 0, 0);
    assert.equal(carolCalls["com.atproto.space.listRecords"] ?? 0, 0);
  }

  // 2. Codex R2-#5: min-0 baseline -> min-1 fail (cmd-m1) -> min-11.1 hold expiry -> min-11.5 write (cmd-m11-5) -> min-12 recovery drops cmd-m1 and delivers cmd-m11-5 (with retry!).
  {
    const network = new FakeNetwork();
    const space = await createChannel(network, "codex5-floor", [ALICE, BOB, READER]);
    let elapsed = 0;
    const clock = { now: () => network.now(), elapsed: () => elapsed };
    const advance = (ms: number) => {
      network.advanceClock(ms);
      elapsed += ms;
    };
    await network.writeAs(BOB, space, COLLECTION.message, tidNow(network.now(), 0), {
      text: "bob-seed",
      createdAt: "2026-11-10T12:00:00.000Z",
    });

    const { core } = syncFor(network, READER);
    const delivered: string[] = [];
    const resets: string[] = [];
    await core.followRepoOps({ space, collections: [COLLECTION.message], deliver: false, clock, onEvent: async () => undefined });

    // Minute 1: write cmd-m1 and go unreachable (503).
    advance(60_000);
    await network.writeAs(BOB, space, COLLECTION.message, tidNow(network.now(), 0), {
      text: "cmd-m1",
      createdAt: "2026-11-10T12:01:00.000Z",
    });
    network.setHostReachable(BOB, false);
    const failPoll = await core.followRepoOps({
      space,
      collections: [COLLECTION.message],
      deliver: true,
      clock,
      onEvent: async (ev) => { delivered.push(String(ev.value.text)); },
      onReset: (n) => resets.push(n.repo),
    });
    assert.equal(failPoll.complete, false);
    assert.equal(resets.length, 0);

    // Minute 11.1 (> MAX_HOLD_MS = 10 min): failed poll expires hold and records floor at 11.1m.
    advance(10 * 60_000 + 6_000);
    const expiryPoll = await core.followRepoOps({
      space,
      collections: [COLLECTION.message],
      deliver: true,
      clock,
      onEvent: async (ev) => { delivered.push(String(ev.value.text)); },
      onReset: (n) => resets.push(n.repo),
    });
    assert.equal(expiryPoll.kind, "reset");
    assert.deepEqual(resets, [BOB]);
    assert.equal(delivered.length, 0);

    // Minute 11.5: cmd-m11-5 written AFTER expiry poll while Bob recovers.
    advance(24_000);
    await network.writeAs(BOB, space, COLLECTION.message, tidNow(network.now(), 0), {
      text: "cmd-m11-5",
      createdAt: "2026-11-10T12:11:30.000Z",
    });

    // Minute 12: Bob recovers; handler fails once on cmd-m11-5 to verify retry safety, then succeeds at 12.1!
    advance(30_000);
    network.setHostReachable(BOB, true);
    let failDeliveryOnce = true;
    const recoveryPoll1 = await core.followRepoOps({
      space,
      collections: [COLLECTION.message],
      deliver: true,
      clock,
      onEvent: async (ev) => {
        if (failDeliveryOnce) {
          failDeliveryOnce = false;
          throw new Error("transient delivery error");
        }
        delivered.push(String(ev.value.text));
      },
      onReset: (n) => resets.push(n.repo),
    });
    assert.equal(recoveryPoll1.delivered.length, 0);

    advance(6_000);
    const recoveryPoll2 = await core.followRepoOps({
      space,
      collections: [COLLECTION.message],
      deliver: true,
      clock,
      onEvent: async (ev) => { delivered.push(String(ev.value.text)); },
      onReset: (n) => resets.push(n.repo),
    });
    assert.deepEqual(recoveryPoll2.delivered.map((d) => String(d.value.text)), ["cmd-m11-5"]);
    assert.deepEqual(delivered, ["cmd-m11-5"], "drops expired cmd-m1 and delivers post-expiry cmd-m11-5 without duplicating");
    assert.equal(resets.length, 1, "no extra reset emitted on minute 12 recovery");

    // Subsequent write at minute 13 resumes incremental listRepoOps delta.
    advance(60_000);
    await network.writeAs(BOB, space, COLLECTION.message, tidNow(network.now(), 0), {
      text: "cmd-m13",
      createdAt: "2026-11-10T12:13:00.000Z",
    });
    const postPoll = await core.followRepoOps({
      space,
      collections: [COLLECTION.message],
      deliver: true,
      clock,
      onEvent: async (ev) => { delivered.push(String(ev.value.text)); },
    });
    assert.deepEqual(postPoll.delivered.map((d) => String(d.value.text)), ["cmd-m13"]);
  }

  // 3. Carbon R2-H2 Trace 2: post-baseline RepoTakendown (permanent failure) at min 1 -> restored at min 21 does NOT replay genesis oplog or cmd-m1.
  {
    const network = new FakeNetwork();
    const space = await createChannel(network, "r2h2-trace2", [ALICE, BOB, READER]);
    let elapsed = 0;
    const clock = { now: () => network.now(), elapsed: () => elapsed };
    const advance = (ms: number) => {
      network.advanceClock(ms);
      elapsed += ms;
    };
    await network.writeAs(BOB, space, COLLECTION.message, tidNow(network.now(), 0), {
      text: "bob-initial",
      createdAt: "2026-11-10T12:00:00.000Z",
    });

    const { core } = syncFor(network, READER);
    const delivered: string[] = [];
    const resets: string[] = [];
    await core.followRepoOps({ space, collections: [COLLECTION.message], deliver: false, clock, onEvent: async () => undefined });

    // Minute 1: Bob writes cmd-m1 while account gets suspended/takendown (permanent: true).
    advance(60_000);
    await network.writeAs(BOB, space, COLLECTION.message, tidNow(network.now(), 0), {
      text: "cmd-m1-suspended",
      createdAt: "2026-11-10T12:01:00.000Z",
    });
    network.setAccountState(BOB, "takendown");
    const suspPoll = await core.followRepoOps({
      space,
      collections: [COLLECTION.message],
      deliver: true,
      clock,
      onEvent: async (ev) => { delivered.push(String(ev.value.text)); },
    });
    assert.deepEqual(suspPoll.setAside.map((s) => ({ did: s.did, permanent: s.permanent })), [{ did: BOB, permanent: true }]);

    // Minute 21: Bob is unsuspended; recovery must NOT fetch listRepoOps(since: undefined) or execute cmd-m1-suspended.
    advance(20 * 60_000);
    network.setAccountState(BOB, "active");
    let genesisListRepoOpsCalled = false;
    network.beforeListRepoOps = ({ since }) => {
      if (since === undefined) genesisListRepoOpsCalled = true;
    };
    await core.markSpaceStale(space);
    const restorePoll = await core.followRepoOps({
      space,
      collections: [COLLECTION.message],
      deliver: true,
      clock,
      onEvent: async (ev) => { delivered.push(String(ev.value.text)); },
      onReset: (n) => resets.push(n.repo),
    });
    assert.equal(genesisListRepoOpsCalled, false, "must NOT replay genesis listRepoOps after post-baseline permanent failure");
    assert.equal(restorePoll.kind, "reset");
    assert.deepEqual(resets, [BOB]);
    assert.equal(delivered.length, 0, "must NOT execute pre-suspension cmd-m1-suspended");
  }
});
