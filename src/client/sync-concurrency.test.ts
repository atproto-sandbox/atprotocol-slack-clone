import assert from "node:assert/strict";
import test from "node:test";
import { MemoryStore } from "@/client/memory-store";
import { COLLECTION } from "@/protocol/nsids";
import { AUTHORITY, createChannel, key, readChannel, syncFor, writeMessage } from "@/testing/engine-fixture";
import { FakeNetwork } from "@/testing/fake-network";

// Two tabs share one store; own writes, purges and backfills race refreshes. Every case asserts the state a correct
// engine must end in: no stale commit overwrites newer state, undoes a local write, or brings back purged records.

const ALICE = "did:plc:alice";
const BOB = "did:plc:bob2";
const READER = "did:plc:reader";

async function channel() {
  const network = new FakeNetwork();
  const space = await createChannel(network, "general", [ALICE, BOB, READER]);
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
  await owner.procedure("com.atproto.memberspace.removeMember", { space, did: ALICE });
  await owner.procedure("com.atproto.memberspace.putMember", { space, did: BOB, read: true, write: false });
  // An app uninstalled leaves the member list the same way a removed member does.
  network.advanceClock(longLived.options.truthIntervalMs);
  const fresh = await readChannel(syncFor(network, READER).core, space);
  const kept = await readChannel(longLived, space);
  assert.deepEqual(kept.items.map((item) => item.uri), fresh.items.map((item) => item.uri));
  assert.deepEqual(fresh.items, [], "neither shows records from accounts the authority no longer lists (D14)");
});

test("a writer the authority never listed stays unread, and the page claims completeness only for the listed writers", async () => {
  const { network, space } = await channel();
  const stranger = "did:plc:stranger";
  network.createAccount(stranger, "pds1");
  await writeMessage(network, stranger, space, 99);
  const page = await readChannel(syncFor(network, READER).core, space, { limit: 3 });
  assert.equal(page.items.some((item) => item.repo === stranger), false);
  assert.equal(page.complete, true);
});
