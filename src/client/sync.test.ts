import assert from "node:assert/strict";
import test from "node:test";
import { COLLECTION } from "@/protocol/nsids";
import { countCalls, createChannel, key, readChannel, syncFor, writeMessage } from "@/testing/engine-fixture";
import { FakeNetwork } from "@/testing/fake-network";

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
