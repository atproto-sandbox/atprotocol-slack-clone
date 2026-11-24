import assert from "node:assert/strict";
import test from "node:test";
import { actionsBlock, button, sectionBlock } from "./blocks";
import { createEngine } from "./engine";
import { ChannelUnavailableError } from "./errors";
import { key, transportFor, createWorkspace, AUTHORITY, writeMessage } from "./testing/engine-fixture";
import { FakeNetwork } from "@flock/testing/fake-network";
import { channelRoleKey, reactionRecordKey, spaceRecordUri } from "@flock/protocol/keys";
import { ATPROTO_SPACE_COLLECTION, COLLECTION, OPENSOCIAL_COLLECTION } from "@flock/protocol/nsids";

// The channel rows of the route table ("What the member routes do today"): each rule the routes enforce, now owned by
// `ChannelClient`, on the fake network.

const ALICE = "did:plc:alice";
const BOB = "did:plc:bob2";

async function workspace(channels: Parameters<typeof createWorkspace>[1]["channels"] = [{ skey: "general", visibility: "public" }]) {
  const network = new FakeNetwork();
  const fixture = await createWorkspace(network, { members: [ALICE, BOB], channels });
  const alice = createEngine(transportFor(network, ALICE));
  const ref = (skey = "general") => ({ workspace: fixture.workspace, skey });
  return { network, fixture, alice, ref };
}

test("readPage serves a valid directory entry and refuses a transitioning or archived channel, dropping an archived one", async () => {
  const { network, fixture, alice, ref } = await workspace([{ skey: "general", visibility: "public" }, { skey: "moving", visibility: "transitioning" }]);
  await writeMessage(network, BOB, fixture.channels.general!, 1);
  const page = await alice.channels.readPage(ref());
  assert.deepEqual(page.messages.map((message) => message.rkey), [key(1)]);
  assert.equal(page.complete, true);
  await assert.rejects(alice.channels.readPage(ref("moving")), (error: unknown) => error instanceof ChannelUnavailableError && error.visibility === "transitioning");
  await network.writeAs(AUTHORITY, fixture.workspace, COLLECTION.directory, "general", { skey: "general", name: "general", visibility: "archived" });
  await assert.rejects(alice.channels.readPage(ref()), (error: unknown) => error instanceof ChannelUnavailableError && error.visibility === "archived");
  assert.deepEqual(await alice.sync.store.records(fixture.channels.general!, COLLECTION.message), [], "the archived channel's copy was dropped");
});

test("readPage refuses a channel whose directory entry is missing or invalid, and drops its copy", async () => {
  const { network, fixture, alice, ref } = await workspace();
  await writeMessage(network, BOB, fixture.channels.general!, 1);
  await alice.channels.readPage(ref());
  await network.clientFor(AUTHORITY).procedure("com.atproto.space.deleteRecord", {
    space: fixture.workspace,
    repo: AUTHORITY,
    collection: COLLECTION.directory,
    rkey: "general",
  });
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

test("roster lists a private channel's members from OpenSocial role grants + memberships and gives a public channel none", async () => {
  const network = new FakeNetwork();
  const fixture = await createWorkspace(network, {
    members: [ALICE, BOB],
    channels: [{ skey: "general", visibility: "public" }, { skey: "secret", visibility: "private", members: [ALICE, BOB] }],
  });
  const alice = createEngine(transportFor(network, ALICE));
  assert.deepEqual(await alice.channels.roster({ workspace: fixture.workspace, skey: "secret" }), [ALICE, BOB].sort());
  assert.deepEqual(await alice.channels.roster({ workspace: fixture.workspace, skey: "general" }), []);
  await network.clientFor(AUTHORITY).procedure("com.atproto.space.putRecord", {
    space: fixture.members,
    repo: AUTHORITY,
    collection: OPENSOCIAL_COLLECTION.membership,
    rkey: BOB,
    record: { $type: OPENSOCIAL_COLLECTION.membership, roles: ["member"], createdAt: "2026-11-10T12:00:00.000Z" },
  });
  assert.deepEqual(await alice.channels.roster({ workspace: fixture.workspace, skey: "secret" }), [ALICE]);
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
  const { network, fixture, alice, ref } = await workspace([{ skey: "secret", visibility: "private", members: [ALICE, BOB] }]);
  const space = fixture.channels.secret!;
  await writeMessage(network, BOB, space, 1);
  await alice.channels.readPage(ref("secret"));
  await network.clientFor(AUTHORITY).procedure("com.atproto.space.putRecord", {
    space: fixture.members,
    repo: AUTHORITY,
    collection: OPENSOCIAL_COLLECTION.membership,
    rkey: ALICE,
    record: { $type: OPENSOCIAL_COLLECTION.membership, roles: ["member"], createdAt: "2026-11-10T12:00:00.000Z" },
  });
  network.advanceClock(11 * 60 * 1000);
  await assert.rejects(alice.channels.readPage(ref("secret")));
  assert.deepEqual(await alice.sync.store.records(space, COLLECTION.message), []);
});

test("after the account leaves a channel its cached credential and held copy go at once; a channel it can still read is kept", async () => {
  const { network, fixture, alice, ref } = await workspace([{ skey: "secret", visibility: "private", members: [ALICE, BOB] }]);
  const space = fixture.channels.secret!;
  await writeMessage(network, BOB, space, 1);
  await alice.channels.readPage(ref("secret"));
  await alice.channels.left(ref("secret"));
  assert.equal((await alice.sync.store.records(space, COLLECTION.message)).length, 1, "a channel the account can still read is kept");
  await network.clientFor(AUTHORITY).procedure("com.atproto.space.putRecord", {
    space: fixture.members,
    repo: AUTHORITY,
    collection: OPENSOCIAL_COLLECTION.membership,
    rkey: ALICE,
    record: { $type: OPENSOCIAL_COLLECTION.membership, roles: ["member"], createdAt: "2026-11-10T12:00:00.000Z" },
  });
  await alice.channels.left(ref("secret"));
  assert.deepEqual(await alice.sync.store.records(space, COLLECTION.message), [], "the held copy was dropped");
  await assert.rejects(alice.channels.readPage(ref("secret")), "no cached credential reads the channel any longer");
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
  await network.clientFor(AUTHORITY).procedure("com.atproto.space.deleteRecord", {
    space: fixture.members,
    repo: AUTHORITY,
    collection: OPENSOCIAL_COLLECTION.membership,
    rkey: ALICE,
  });
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
  const privRole = channelRoleKey("secret");
  for (let n = 0; n < 201; n += 1) {
    const did = `did:plc:member${n}`;
    await network.clientFor(AUTHORITY).procedure("com.atproto.space.putRecord", {
      space: fixture.members,
      repo: AUTHORITY,
      collection: OPENSOCIAL_COLLECTION.membership,
      rkey: did,
      record: { $type: OPENSOCIAL_COLLECTION.membership, roles: ["member", privRole], createdAt: "2026-11-10T12:00:00.000Z" },
    });
  }
  await assert.rejects(alice.channels.roster(ref("secret")), /exceeds 200 members/);
});

test("send and edit carry blocks, preserve them when omitted, and replace or clear them when asked", async () => {
  const { network, alice, ref } = await workspace();
  const initial = [sectionBlock("v1"), actionsBlock([button({ actionId: "one", label: "One", value: "1" })])];
  const sent = await alice.channels.send(ref(), "v1", undefined, initial);
  assert.deepEqual((await alice.channels.getMessage(ref(), sent.uri))?.value.blocks, initial);

  // Editing text alone preserves existing blocks.
  await alice.channels.edit(ref(), sent.uri, "v1-text-only");
  assert.deepEqual((await alice.channels.getMessage(ref(), sent.uri))?.value.blocks, initial);

  // Editing with new blocks replaces them.
  const replaced = [sectionBlock("v2")];
  await alice.channels.edit(ref(), sent.uri, "v2", replaced);
  assert.deepEqual((await alice.channels.getMessage(ref(), sent.uri))?.value.blocks, replaced);

  // Editing with null or [] clears blocks.
  await alice.channels.edit(ref(), sent.uri, "cleared-null", null);
  assert.equal((await alice.channels.getMessage(ref(), sent.uri))?.value.blocks, undefined);

  network.advanceClock(1);
  const second = await alice.channels.send(ref(), "with-blocks", undefined, initial);
  await alice.channels.edit(ref(), second.uri, "cleared-empty", []);
  assert.equal((await alice.channels.getMessage(ref(), second.uri))?.value.blocks, undefined);
});

test("getMessage reads any verified message regardless of page age, validates a reply's parent, and returns null when missing or invalid", async () => {
  const { network, fixture, alice, ref } = await workspace([{ skey: "general", visibility: "public" }, { skey: "other", visibility: "public" }]);
  const space = fixture.channels.general!;
  // Write a message older than a 100-message page.
  await writeMessage(network, BOB, space, 1, "ancient");
  for (let n = 2; n <= 120; n += 1) await writeMessage(network, BOB, space, n);
  const ancientUri = spaceRecordUri(space, BOB, COLLECTION.message, key(1));
  const ancient = await alice.channels.getMessage(ref(), ancientUri);
  assert.equal(ancient?.value.text, "ancient");

  // Valid reply to ancient top-level message resolves.
  const validReplyUri = spaceRecordUri(space, BOB, COLLECTION.message, key(121));
  await network.writeAs(BOB, space, COLLECTION.message, key(121), { text: "reply", createdAt: "2026-11-10T12:00:00.000Z", parent: ancientUri });
  assert.equal((await alice.channels.getMessage(ref(), validReplyUri))?.value.text, "reply");

  // Nested reply (parent is itself a reply) is rejected with null.
  const nestedUri = spaceRecordUri(space, BOB, COLLECTION.message, key(122));
  await network.writeAs(BOB, space, COLLECTION.message, key(122), { text: "nested", createdAt: "2026-11-10T12:00:00.000Z", parent: validReplyUri });
  assert.equal(await alice.channels.getMessage(ref(), nestedUri), null);

  // Reply whose parent was deleted returns null.
  await network.clientFor(BOB).procedure("com.atproto.space.deleteRecord", { space, repo: BOB, collection: COLLECTION.message, rkey: key(1) });
  assert.equal(await alice.channels.getMessage(ref(), validReplyUri), null);

  // Missing or cross-channel message URIs return null.
  assert.equal(await alice.channels.getMessage(ref(), spaceRecordUri(space, BOB, COLLECTION.message, key(999))), null);
  assert.equal(await alice.channels.getMessage(ref(), spaceRecordUri(fixture.channels.other!, BOB, COLLECTION.message, key(2))), null);
});

test("getMessage gates target and parent authors against sync.writers (Carbon R2-H1 / D14)", async () => {
  const { network, fixture, ref } = await workspace([{ skey: "general", visibility: "public" }]);
  const space = fixture.channels.general!;

  // 1. Write >5 pages (120 messages) from active writer BOB plus a valid top-level message from ALICE.
  await writeMessage(network, BOB, space, 1, "ancient-bob");
  for (let n = 2; n <= 120; n += 1) await writeMessage(network, BOB, space, n);
  const evilDid = "did:web:evil.example";
  const resolvedDids: string[] = [];
  const fetchedUrls: string[] = [];
  const baseTransport = transportFor(network, ALICE);
  const inspectedAlice = createEngine({
    ...baseTransport,
    resolvePds: async (did, force) => {
      resolvedDids.push(did);
      return baseTransport.resolvePds(did, force);
    },
    fetchEndpoint: async (request) => {
      fetchedUrls.push(request.url);
      return baseTransport.fetchEndpoint(request);
    },
  });

  // 2. Permalink to an unlisted external did:web author MUST return null without resolving PDS or sending a credential.
  const evilMsgUri = spaceRecordUri(space, evilDid, COLLECTION.message, key(500));
  assert.equal(await inspectedAlice.channels.getMessage(ref(), evilMsgUri), null);
  assert.equal(resolvedDids.includes(evilDid), false, "must never resolve unlisted did:web PDS");
  assert.equal(fetchedUrls.some((url) => url.includes("evil.example")), false, "must never leak SpaceCredential to unlisted host");

  // 3. Even if an active writer's reply names an unlisted did:web parent, getMessage refuses before resolving parent PDS.
  const spoofParentReplyUri = spaceRecordUri(space, BOB, COLLECTION.message, key(501));
  await network.writeAs(BOB, space, COLLECTION.message, key(501), {
    text: "reply pointing outside space",
    createdAt: "2026-11-10T12:00:00.000Z",
    parent: evilMsgUri,
  });
  assert.equal(await inspectedAlice.channels.getMessage(ref(), spoofParentReplyUri), null);
  assert.equal(resolvedDids.includes(evilDid), false, "must never resolve unlisted parent author PDS");

  // 4. Valid >5-page ancient message from active listed writer succeeds, and newly sent own message with pending listing lag succeeds.
  const ancientUri = spaceRecordUri(space, BOB, COLLECTION.message, key(1));
  assert.equal((await inspectedAlice.channels.getMessage(ref(), ancientUri))?.value.text, "ancient-bob");

  network.setListingLag(space, true);
  const ownSent = await inspectedAlice.channels.send(ref(), "own-pending-msg");
  assert.equal((await inspectedAlice.channels.getMessage(ref(), ownSent.uri))?.value.text, "own-pending-msg");
  network.setListingLag(space, false);

  // 5. Evicted writer removed from authority listWriters (D14) MUST return null on getMessage.
  await network.clientFor(AUTHORITY).procedure("com.atproto.space.deleteRecord", {
    space: fixture.members,
    repo: AUTHORITY,
    collection: OPENSOCIAL_COLLECTION.membership,
    rkey: BOB,
  });
  await inspectedAlice.sync.markSpaceStale(space);
  const evictedCalls = resolvedDids.length;
  assert.equal(await inspectedAlice.channels.getMessage(ref(), ancientUri), null);
  assert.equal(resolvedDids.length, evictedCalls, "evicted member getMessage returns null without resolving BOB PDS");
});

test("moderation labels withhold !takedown messages, replies, reactions, and takendown accounts, and mark !hide messages hidden until negated", async () => {
  const { network, fixture, alice, ref } = await workspace();
  const space = fixture.channels.general!;
  const owner = network.clientFor(AUTHORITY);

  await writeMessage(network, BOB, space, 1, "bob top");
  await writeMessage(network, ALICE, space, 2, "alice top");
  const bobTop = spaceRecordUri(space, BOB, COLLECTION.message, key(1));
  const aliceTop = spaceRecordUri(space, ALICE, COLLECTION.message, key(2));
  const replyToBob = spaceRecordUri(space, ALICE, COLLECTION.message, key(3));
  await network.writeAs(ALICE, space, COLLECTION.message, key(3), {
    text: "reply to bob",
    createdAt: "2026-11-10T12:00:00.000Z",
    parent: bobTop,
  });
  await alice.channels.react(ref(), aliceTop, "👍");

  // 1. `!hide` on aliceTop sets `hidden: true` and `labels: ["!hide"]` without dropping the message.
  await owner.procedure("com.atproto.space.putRecord", {
    space,
    repo: AUTHORITY,
    collection: ATPROTO_SPACE_COLLECTION.label,
    rkey: key(10),
    record: { $type: ATPROTO_SPACE_COLLECTION.label, src: AUTHORITY, uri: aliceTop, val: "!hide", cts: "2026-11-10T12:01:00.000Z" },
  });
  await alice.sync.markSpaceStale(space);
  let page = await alice.channels.readPage(ref());
  const hiddenMsg = page.messages.find((m) => m.uri === aliceTop)!;
  assert.equal(hiddenMsg.hidden, true);
  assert.deepEqual(hiddenMsg.labels, ["!hide"]);
  assert.equal((await alice.channels.getMessage(ref(), aliceTop))?.hidden, true);

  // 2. `!takedown` on bobTop withholds bobTop AND its reply (`replyToBob`), and `getMessage` returns null for both!
  await owner.procedure("com.atproto.space.putRecord", {
    space,
    repo: AUTHORITY,
    collection: ATPROTO_SPACE_COLLECTION.label,
    rkey: key(11),
    record: { $type: ATPROTO_SPACE_COLLECTION.label, src: AUTHORITY, uri: bobTop, val: "!takedown", cts: "2026-11-10T12:02:00.000Z" },
  });
  await alice.sync.markSpaceStale(space);
  page = await alice.channels.readPage(ref());
  assert.deepEqual(page.messages.map((m) => m.uri), [aliceTop]);
  assert.equal(await alice.channels.getMessage(ref(), bobTop), null);
  assert.equal(await alice.channels.getMessage(ref(), replyToBob), null);

  // 3. Negating `!hide` with a later `cts` clears `hidden`.
  await owner.procedure("com.atproto.space.putRecord", {
    space,
    repo: AUTHORITY,
    collection: ATPROTO_SPACE_COLLECTION.label,
    rkey: key(12),
    record: { $type: ATPROTO_SPACE_COLLECTION.label, src: AUTHORITY, uri: aliceTop, val: "!hide", neg: true, cts: "2026-11-10T12:03:00.000Z" },
  });
  await alice.sync.markSpaceStale(space);
  page = await alice.channels.readPage(ref());
  assert.equal(page.messages.find((m) => m.uri === aliceTop)?.hidden, undefined);

  // 4. Account-level `!hide` and `!takedown` labels in `members/self` take effect on `readPage` and `getMessage` via `syncAccountLabels` WITHOUT prior `markSpaceStale(members)` or `summary()`!
  const carol = "did:plc:carolaaaaaaaaaaaaaaaaaaa";
  network.createAccount(carol, "pds2");
  await owner.procedure("com.atproto.space.putRecord", {
    space: fixture.members,
    repo: AUTHORITY,
    collection: OPENSOCIAL_COLLECTION.membership,
    rkey: carol,
    record: { $type: OPENSOCIAL_COLLECTION.membership, roles: ["member"], createdAt: "2026-11-10T12:00:00.000Z" },
  });
  await network.writeAs(carol, fixture.members, OPENSOCIAL_COLLECTION.acceptance, "self", {
    group: AUTHORITY,
    createdAt: "2026-11-10T12:00:01.000Z",
  });
  await writeMessage(network, carol, space, 20, "carol live message");
  const carolMsg = spaceRecordUri(space, carol, COLLECTION.message, key(20));

  // Publish account-level `!hide` on `carol` in `members/self` without marking `members/self` stale.
  await owner.procedure("com.atproto.space.putRecord", {
    space: fixture.members,
    repo: AUTHORITY,
    collection: ATPROTO_SPACE_COLLECTION.label,
    rkey: key(21),
    record: { $type: ATPROTO_SPACE_COLLECTION.label, src: AUTHORITY, uri: carol, val: "!hide", cts: "2026-11-10T12:04:00.000Z" },
  });
  page = await alice.channels.readPage(ref());
  const carolHidden = page.messages.find((m) => m.uri === carolMsg);
  assert.equal(carolHidden?.hidden, true, "account-level !hide marks author's messages hidden");
  assert.deepEqual(carolHidden?.labels, ["!hide"]);
  assert.equal((await alice.channels.getMessage(ref(), carolMsg))?.hidden, true);

  // Publish account-level `!takedown` on `carol` in `members/self` -> withholds `carol` on both `readPage` and `getMessage`!
  await owner.procedure("com.atproto.space.putRecord", {
    space: fixture.members,
    repo: AUTHORITY,
    collection: ATPROTO_SPACE_COLLECTION.label,
    rkey: key(22),
    record: { $type: ATPROTO_SPACE_COLLECTION.label, src: AUTHORITY, uri: carol, val: "!takedown", cts: "2026-11-10T12:05:00.000Z" },
  });
  page = await alice.channels.readPage(ref());
  assert.equal(page.messages.some((m) => m.repo === carol), false, "account-level !takedown withholds all records from author");
  assert.equal(await alice.channels.getMessage(ref(), carolMsg), null);
});

test("an engine with applyOwnWrites disabled keeps nothing it sends, edits, deletes or reacts with in its local store", async () => {
  const network = new FakeNetwork();
  const fixture = await createWorkspace(network, { members: [ALICE], channels: [{ skey: "general", visibility: "public" }] });
  const space = fixture.channels.general!;
  const bot = createEngine(transportFor(network, ALICE), { applyOwnWrites: false });
  const ref = { workspace: fixture.workspace, skey: "general" };

  const sent = await bot.channels.send(ref, "from bot", undefined, [sectionBlock("from bot")]);
  await bot.channels.edit(ref, sent.uri, "updated");
  await bot.channels.react(ref, sent.uri, "👍");
  await bot.channels.unreact(ref, sent.uri, "👍");
  assert.deepEqual(await bot.sync.store.records(space, COLLECTION.message), []);
  assert.deepEqual(await bot.sync.store.records(space, COLLECTION.reaction), []);
  assert.equal(await bot.sync.store.getSpace(space), undefined);

  await bot.channels.delete(ref, sent.uri);
  assert.equal(await bot.sync.store.getSpace(space), undefined);
});

test("private channel roster excludes !takedown members and fails closed on missing/invalid policy or truncated scans, and syncAccountLabels fails closed on unverified authority repo", async () => {
  const { network, fixture, alice, ref } = await workspace([
    { skey: "secret", visibility: "private", members: [ALICE, BOB] },
  ]);
  const secretSpace = fixture.channels.secret!;
  const owner = network.clientFor(AUTHORITY);

  assert.deepEqual(await alice.channels.roster(ref("secret")), [ALICE, BOB].sort());

  // 1. Account-level !takedown on BOB excludes BOB from private-channel roster!
  await owner.procedure("com.atproto.space.putRecord", {
    space: fixture.members,
    repo: AUTHORITY,
    collection: ATPROTO_SPACE_COLLECTION.label,
    rkey: key(30),
    record: {
      $type: ATPROTO_SPACE_COLLECTION.label,
      src: AUTHORITY,
      uri: BOB,
      val: "!takedown",
      cts: "2026-11-10T12:10:00.000Z",
    },
  });
  assert.deepEqual(await alice.channels.roster(ref("secret")), [ALICE]);

  // 2. Truncated account label scan in roster() fails closed with WorkspaceEnvelopeError!
  const base = transportFor(network, ALICE);
  const truncRosterEngine = createEngine({
    ...base,
    fetchEndpoint: async (req) => {
      const url = new URL(req.url);
      if (
        url.pathname === "/xrpc/com.atproto.space.listRecords" &&
        url.searchParams.get("space") === fixture.members &&
        url.searchParams.get("collection") === ATPROTO_SPACE_COLLECTION.label
      ) {
        const offset = Number((url.searchParams.get("cursor") ?? "off-0").replace("off-", "")) || 0;
        const limit = Number(url.searchParams.get("limit") ?? "100");
        const total = 1_001;
        const count = Math.max(0, Math.min(limit, total - offset));
        const records = Array.from({ length: count }, (_, idx) => {
          const rkey = key(5_000 + offset + idx);
          return {
            uri: `${fixture.members}/${AUTHORITY}/${ATPROTO_SPACE_COLLECTION.label}/${rkey}`,
            cid: "bafyreitest",
            collection: ATPROTO_SPACE_COLLECTION.label,
            rkey,
            value: {
              $type: ATPROTO_SPACE_COLLECTION.label,
              src: AUTHORITY,
              uri: BOB,
              val: "custom-tag",
              cts: "2026-11-10T12:10:00.000Z",
            },
          };
        });
        return Response.json({
          records,
          ...(offset + count < total ? { cursor: `off-${offset + count}` } : {}),
        });
      }
      return base.fetchEndpoint(req);
    },
  });
  await assert.rejects(truncRosterEngine.channels.roster(ref("secret")), /exceeds the 1000-record limit/);

  // 3. Missing or malformed private-channel policy/self fails closed instead of synthesizing channel-secret fallback!
  for (const badRecords of [
    [],
    [
      {
        uri: `${secretSpace}/${AUTHORITY}/${ATPROTO_SPACE_COLLECTION.spacePolicy}/self`,
        cid: "bafyreipol",
        collection: ATPROTO_SPACE_COLLECTION.spacePolicy,
        rkey: "self",
        value: {
          $type: ATPROTO_SPACE_COLLECTION.spacePolicy,
          policy: {
            $type: "group.opensocial.policy",
            grants: [
              { role: "admin", read: true, write: true },
              { role: "admin", read: true, write: false }, // duplicate role grant -> invalid!
            ],
          },
        },
      },
    ],
  ]) {
    const badPolEngine = createEngine({
      ...base,
      fetchEndpoint: async (req) => {
        const url = new URL(req.url);
        if (
          url.pathname === "/xrpc/com.atproto.space.listRecords" &&
          url.searchParams.get("space") === secretSpace &&
          url.searchParams.get("collection") === ATPROTO_SPACE_COLLECTION.spacePolicy
        ) {
          return Response.json({ records: badRecords });
        }
        return base.fetchEndpoint(req);
      },
    });
    await assert.rejects(
      badPolEngine.channels.roster(ref("secret")),
      /Private-channel space policy is missing or invalid/,
    );
  }

  // 4. syncAccountLabels fails closed (throws) when authority's members/self repo cannot be verified (e.g. 500/corrupted STAR) instead of returning empty labels!
  const brokenMembersEngine = createEngine({
    ...base,
    fetchEndpoint: async (req) => {
      const url = new URL(req.url);
      if (
        url.pathname === "/xrpc/com.atproto.space.getRepo" &&
        url.searchParams.get("space") === fixture.members &&
        url.searchParams.get("repo") === AUTHORITY
      ) {
        return Response.json({ error: "UpstreamFailure", message: "corrupt star" }, { status: 500 });
      }
      return base.fetchEndpoint(req);
    },
  });
  await assert.rejects(
    brokenMembersEngine.sync.syncAccountLabels(AUTHORITY),
    /Moderation label state from .* could not be verified/,
  );
});
