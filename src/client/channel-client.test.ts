import assert from "node:assert/strict";
import test from "node:test";
import { createEngine } from "@/client/engine";
import { ChannelUnavailableError } from "@/client/errors";
import { key, transportFor, createWorkspace, AUTHORITY, writeMessage } from "@/testing/engine-fixture";
import { FakeNetwork } from "@/testing/fake-network";
import { reactionRecordKey, spaceRecordUri, subjectKey } from "@/protocol/keys";
import { COLLECTION } from "@/protocol/nsids";

// The channel rows of the route table ("What the member routes do today"): each rule the routes enforce, now owned by
// `ChannelClient`, on the fake network.

const ALICE = "did:plc:alice";
const BOB = "did:plc:bob2";

async function workspace(channels: Parameters<typeof createWorkspace>[1]["channels"] = [{ skey: "general", visibility: "public" }]) {
  const network = new FakeNetwork();
  const fixture = await createWorkspace(network, { members: [ALICE, BOB], channels });
  const alice = createEngine(transportFor(network, ALICE));
  const ref = (skey = "general") => ({ workspace: fixture.workspace, skey: `acme-${skey}` });
  return { network, fixture, alice, ref };
}

test("readPage serves a valid directory entry and refuses a transitioning or archived channel, dropping an archived one", async () => {
  const { network, fixture, alice, ref } = await workspace([{ skey: "general", visibility: "public" }, { skey: "moving", visibility: "transitioning" }]);
  await writeMessage(network, BOB, fixture.channels.general!, 1);
  const page = await alice.channels.readPage(ref());
  assert.deepEqual(page.messages.map((message) => message.rkey), [key(1)]);
  assert.equal(page.complete, true);
  await assert.rejects(alice.channels.readPage(ref("moving")), (error: unknown) => error instanceof ChannelUnavailableError && error.visibility === "transitioning");
  await network.writeAs(AUTHORITY, fixture.workspace, COLLECTION.directory, "acme-general", { skey: "acme-general", name: "general", visibility: "archived" });
  await assert.rejects(alice.channels.readPage(ref()), (error: unknown) => error instanceof ChannelUnavailableError && error.visibility === "archived");
  assert.deepEqual(await alice.sync.store.records(fixture.channels.general!, COLLECTION.message), [], "the archived channel's copy was dropped");
});

test("readPage refuses a channel whose directory entry is missing or invalid, and drops its copy", async () => {
  const { network, fixture, alice, ref } = await workspace();
  await writeMessage(network, BOB, fixture.channels.general!, 1);
  await alice.channels.readPage(ref());
  await network.writeAs(AUTHORITY, fixture.workspace, COLLECTION.directory, "acme-general", { skey: "acme-other", name: "general", visibility: "public" });
  await assert.rejects(alice.channels.readPage(ref()), /missing or invalid/);
  assert.deepEqual(await alice.sync.store.records(fixture.channels.general!, COLLECTION.message), []);
});

test("readPage shows one level of replies within the channel, reading a parent it does not hold", async () => {
  const { network, fixture, alice, ref } = await workspace([{ skey: "general", visibility: "public" }, { skey: "other", visibility: "public" }]);
  const space = fixture.channels.general!;
  const top = spaceRecordUri(space, BOB, COLLECTION.message, key(1));
  await writeMessage(network, BOB, space, 1, "top");
  for (let n = 2; n <= 6; n += 1) await writeMessage(network, BOB, space, n);
  await network.writeAs(ALICE, space, COLLECTION.message, key(7), { text: "reply", createdAt: "2026-11-10T12:00:00.000Z", parent: top });
  await network.writeAs(ALICE, space, COLLECTION.message, key(8), { text: "nested", createdAt: "2026-11-10T12:00:00.000Z", parent: spaceRecordUri(space, ALICE, COLLECTION.message, key(7)) });
  await network.writeAs(ALICE, space, COLLECTION.message, key(9), { text: "elsewhere", createdAt: "2026-11-10T12:00:00.000Z", parent: spaceRecordUri(fixture.channels.other!, BOB, COLLECTION.message, key(1)) });
  const page = await alice.channels.readPage(ref(), { limit: 2 });
  assert.deepEqual(page.messages.map((message) => message.value.text), ["reply", "message 6"], "the reply to a parent outside the page is shown; the nested and cross-channel replies are not");
});

test("send writes after the channel-state check and a fresh credential, and a reply must target a top-level message", async () => {
  const { network, fixture, alice, ref } = await workspace([{ skey: "general", visibility: "public" }, { skey: "moving", visibility: "transitioning" }]);
  const space = fixture.channels.general!;
  const sent = await alice.channels.send(ref(), "hello");
  network.advanceClock(1);
  const reply = await alice.channels.send(ref(), "re", sent.uri);
  await assert.rejects(alice.channels.send(ref(), "nested", reply.uri), /top-level message/);
  await assert.rejects(alice.channels.send(ref(), "nowhere", spaceRecordUri(space, BOB, COLLECTION.message, key(99))), /top-level message/);
  await assert.rejects(alice.channels.send(ref("moving"), "paused"), ChannelUnavailableError);
  network.setListingLag(space, true);
  const page = await alice.channels.readPage(ref());
  assert.deepEqual(page.messages.map((message) => message.value.text), ["re", "hello"], "own writes show without waiting for the authority");
});

test("edit and delete change only own messages, and an edit keeps the fields it had", async () => {
  const { network, fixture, alice, ref } = await workspace();
  const space = fixture.channels.general!;
  await writeMessage(network, BOB, space, 1);
  const bobs = spaceRecordUri(space, BOB, COLLECTION.message, key(1));
  await assert.rejects(alice.channels.edit(ref(), bobs, "hijacked"), /only your own/);
  await assert.rejects(alice.channels.delete(ref(), bobs), /only your own/);
  const { uri, rkey } = await alice.channels.send(ref(), "first");
  await network.writeAs(ALICE, space, COLLECTION.message, rkey, { text: "first", createdAt: "2026-11-10T12:00:00.000Z", pinnedBy: "another-app" });
  await alice.channels.edit(ref(), uri, "second");
  const page = await alice.channels.readPage(ref());
  const edited = page.messages.find((message) => message.uri === uri)!;
  assert.deepEqual([edited.value.text, edited.value.pinnedBy], ["second", "another-app"]);
  await alice.channels.delete(ref(), uri);
  assert.equal((await alice.channels.readPage(ref())).messages.some((message) => message.uri === uri), false);
});

test("react needs an existing message in the channel and derives its key; removing a missing reaction succeeds", async () => {
  const { network, fixture, alice, ref } = await workspace();
  const space = fixture.channels.general!;
  await writeMessage(network, BOB, space, 1);
  const subject = spaceRecordUri(space, BOB, COLLECTION.message, key(1));
  await assert.rejects(alice.channels.react(ref(), spaceRecordUri(space, BOB, COLLECTION.message, key(2)), "👍"), /not found/);
  const { rkey } = await alice.channels.react(ref(), subject, "👍");
  assert.equal(rkey, reactionRecordKey(subject, "👍", ALICE));
  const page = await alice.channels.readPage(ref());
  assert.deepEqual(page.reactions.map((reaction) => reaction.value.emoji), ["👍"]);
  await alice.channels.unreact(ref(), subject, "👍");
  await alice.channels.unreact(ref(), subject, "👍");
  assert.deepEqual((await alice.channels.readPage(ref())).reactions, []);
});

test("join requests are for private channels only, with a new request id each time; withdrawing is always allowed", async () => {
  const { network, alice, ref } = await workspace([{ skey: "general", visibility: "public" }, { skey: "secret", visibility: "private", members: [BOB] }]);
  await assert.rejects(alice.channels.requestJoin(ref()), /only used for private channels/);
  const first = await alice.channels.requestJoin(ref("secret"));
  network.advanceClock(1);
  const second = await alice.channels.requestJoin(ref("secret"));
  assert.notEqual(first.requestId, second.requestId);
  assert.equal(first.uri, second.uri, "the key is derived from the channel and the requester");
  await alice.channels.withdrawJoin(ref("secret"));
  await alice.channels.withdrawJoin(ref("secret"));
  await alice.channels.withdrawJoin(ref());
});

test("roster lists a private channel's members and gives a public channel none", async () => {
  const network = new FakeNetwork();
  const fixture = await createWorkspace(network, { members: [ALICE, BOB], channels: [{ skey: "general", visibility: "public" }, { skey: "secret", visibility: "private", members: [ALICE, BOB] }] });
  const alice = createEngine(transportFor(network, ALICE));
  assert.deepEqual(await alice.channels.roster({ workspace: fixture.workspace, skey: "acme-secret" }), [ALICE, BOB].sort());
  assert.deepEqual(await alice.channels.roster({ workspace: fixture.workspace, skey: "acme-general" }), []);
  await network.writeAs(AUTHORITY, fixture.channels.secret!, COLLECTION.channelRoster, subjectKey(BOB), { subject: BOB, active: false, updatedAt: "2026-11-10T12:00:00.000Z" });
  assert.deepEqual(await alice.channels.roster({ workspace: fixture.workspace, skey: "acme-secret" }), [ALICE]);
});

test("a writer set aside is named in the page's degraded reasons, and the page still serves everyone else", async () => {
  const { network, fixture, alice, ref } = await workspace();
  const space = fixture.channels.general!;
  await writeMessage(network, BOB, space, 1);
  await writeMessage(network, ALICE, space, 2);
  network.setAccountState(BOB, "deactivated");
  const page = await alice.channels.readPage(ref());
  assert.deepEqual(page.messages.map((message) => message.repo), [ALICE]);
  assert.match(page.degradedReasons.join(" "), new RegExp(`Messages from ${BOB} may be missing or out of date: its account is deactivated`));
});

test("losing access to a channel drops its copy", async () => {
  const { network, fixture, alice, ref } = await workspace();
  const space = fixture.channels.general!;
  await writeMessage(network, BOB, space, 1);
  await alice.channels.readPage(ref());
  await network.clientFor(AUTHORITY).procedure("com.atproto.memberspace.removeMember", { space, did: ALICE });
  network.advanceClock(11 * 60 * 1000);
  await assert.rejects(alice.channels.readPage(ref()));
  assert.deepEqual(await alice.sync.store.records(space, COLLECTION.message), []);
});

test("paging a channel where two writers share keys at a page boundary shows every message once, in merge order", async () => {
  const { network, fixture, alice, ref } = await workspace();
  const space = fixture.channels.general!;
  for (const n of [1, 2, 3, 4]) for (const writer of [ALICE, BOB]) await writeMessage(network, writer, space, n);
  const seen: string[] = [];
  let before: string | undefined;
  for (let pages = 0; pages < 10; pages += 1) {
    const page = await alice.channels.readPage(ref(), { limit: 3, before });
    seen.push(...page.messages.map((message) => message.uri));
    if (!page.next) break;
    before = page.next;
  }
  const expected = [4, 3, 2, 1].flatMap((n) => [ALICE, BOB].map((writer) => spaceRecordUri(space, writer, COLLECTION.message, key(n))).sort());
  assert.deepEqual(seen, expected);
});

test("a write is refused once the member is removed, even while a cached credential would still be accepted", async () => {
  const { network, fixture, alice, ref } = await workspace();
  await alice.channels.readPage(ref());
  await network.clientFor(AUTHORITY).procedure("com.atproto.memberspace.removeMember", { space: fixture.channels.general!, did: ALICE });
  await assert.rejects(alice.channels.send(ref(), "after removal"));
  assert.equal((await network.clientFor(ALICE).query<{ records: unknown[] }>("com.atproto.space.listRecords", {
    space: fixture.channels.general!, repo: ALICE, collection: COLLECTION.message,
  }).catch(() => ({ records: [] }))).records.length, 0, "nothing was written");
});

test("an edit re-checks its reply target: a reply whose parent is gone cannot be edited", async () => {
  const { network, alice, ref } = await workspace();
  const top = await alice.channels.send(ref(), "top");
  network.advanceClock(1);
  const reply = await alice.channels.send(ref(), "reply", top.uri);
  await alice.channels.delete(ref(), top.uri);
  await assert.rejects(alice.channels.edit(ref(), reply.uri, "edited"), /top-level message/);
});

test("a member's own message stays on every page while the authority has not listed it yet, and after it has", async () => {
  const { network, fixture, alice, ref } = await workspace();
  const space = fixture.channels.general!;
  await writeMessage(network, BOB, space, 1);
  await alice.channels.readPage(ref());
  network.setListingLag(space, true);
  await alice.channels.send(ref(), "mine");
  for (const read of ["first", "second", "third"]) {
    assert.deepEqual((await alice.channels.readPage(ref())).messages.map((message) => message.value.text), ["mine", "message 1"], `${read} read during the lag`);
  }
  network.setListingLag(space, false);
  assert.deepEqual((await alice.channels.readPage(ref())).messages.map((message) => message.value.text), ["mine", "message 1"], "once listed");
});

test("an own write the authority never lists is out of view after one truth interval, as for any unlisted account (D14)", async () => {
  const { network, fixture, alice, ref } = await workspace();
  const space = fixture.channels.general!;
  await writeMessage(network, BOB, space, 1);
  network.setListingLag(space, true);
  await alice.channels.send(ref(), "never listed");
  assert.equal((await alice.channels.readPage(ref())).messages.length, 2);
  network.advanceClock(alice.sync.options.truthIntervalMs);
  assert.deepEqual((await alice.channels.readPage(ref())).messages.map((message) => message.value.text), ["message 1"]);
});

test("roster refuses a private channel whose roster exceeds the supported members", async () => {
  const { network, fixture, alice, ref } = await workspace([{ skey: "secret", visibility: "private", members: [ALICE] }]);
  for (let n = 0; n < 201; n += 1) {
    const did = `did:plc:member${n}`;
    await network.writeAs(AUTHORITY, fixture.channels.secret!, COLLECTION.channelRoster, subjectKey(did), { subject: did, active: true, updatedAt: "2026-11-10T12:00:00.000Z" });
  }
  await assert.rejects(alice.channels.roster(ref("secret")), /exceeds 200 members/);
});
