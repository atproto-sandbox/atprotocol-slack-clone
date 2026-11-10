import assert from "node:assert/strict";
import test from "node:test";
import { createEngine } from "@/client/engine";
import type { ChannelPage } from "@/client/channel-client";
import { DmClient } from "@/dm/dm-client";
import { readIndependentChannelPage, type IndependentChannelPage } from "@/reader/independent";
import { readIndependentDmConversation } from "@/reader/independent-dm";
import { reactionRecordKey, spaceRecordUri } from "@/protocol/keys";
import { COLLECTION } from "@/protocol/nsids";
import { AUTHORITY, createWorkspace, key, transportFor, writeMessage } from "@/testing/engine-fixture";
import { FakeNetwork } from "@/testing/fake-network";

// The engine against the independent readers, for what the readers can express: a fresh read of a channel page and of a
// DM conversation, after each sync and writer-set case that ends in such a read. The readers share no code with the engine.

const ALICE = "did:plc:alice";
const BOB = "did:plc:bob2";
const CAROL = "did:plc:carol";

function sameView(engine: ChannelPage, reader: IndependentChannelPage, label: string): void {
  assert.deepEqual(engine.messages.map((message) => [message.uri, message.value]), reader.messages.map((message) => [message.uri, message.value]), `${label}: messages`);
  assert.deepEqual(engine.reactions.map((reaction) => reaction.uri), reader.reactions.map((reaction) => reaction.uri), `${label}: reactions`);
  assert.equal(engine.degradedReasons.length > 0, reader.degraded, `${label}: degraded`);
}

test("a channel page matches the independent reader through writes, replies, reactions, a set-aside writer and a removed member", async () => {
  const network = new FakeNetwork();
  const fixture = await createWorkspace(network, { members: [ALICE, BOB, CAROL], channels: [{ skey: "general", visibility: "public" }] });
  const space = fixture.channels.general!;
  const ref = { workspace: fixture.workspace, skey: "acme-general" };
  const engine = createEngine(transportFor(network, ALICE));
  const reader = transportFor(network, ALICE);
  const compare = async (label: string) => {
    const fresh = await readIndependentChannelPage(reader, fixture.workspace, ref.skey);
    sameView(await engine.channels.readPage(ref), fresh, label);
  };

  for (let n = 1; n <= 30; n += 1) await writeMessage(network, [ALICE, BOB, CAROL][n % 3]!, space, n);
  await compare("first sync");

  const top = spaceRecordUri(space, BOB, COLLECTION.message, key(3));
  await network.writeAs(CAROL, space, COLLECTION.message, key(40), { text: "reply", createdAt: "2026-11-10T12:00:00.000Z", parent: top });
  await network.writeAs(ALICE, space, COLLECTION.message, key(41), { text: "nested", createdAt: "2026-11-10T12:00:00.000Z", parent: spaceRecordUri(space, CAROL, COLLECTION.message, key(40)) });
  await network.writeAs(BOB, space, COLLECTION.reaction, reactionRecordKey(top, "👍", BOB), { subject: top, emoji: "👍", createdAt: "2026-11-10T12:00:00.000Z" });
  await network.writeAs(CAROL, space, COLLECTION.reaction, reactionRecordKey(spaceRecordUri(space, ALICE, COLLECTION.message, key(30)), "🎉", CAROL), {
    subject: spaceRecordUri(space, ALICE, COLLECTION.message, key(30)), emoji: "🎉", createdAt: "2026-11-10T12:00:00.000Z",
  });
  await compare("replies and reactions, one older than the window on a message inside it");

  await writeMessage(network, BOB, space, 30, "same key as alice's");
  await writeMessage(network, ALICE, space, 29, "edited");
  await network.deleteAs(CAROL, space, COLLECTION.message, key(27));
  await compare("an edit, a delete and two writers sharing a key");

  network.setAccountState(BOB, "deactivated");
  network.advanceClock(engine.sync.options.truthIntervalMs);
  await compare("a deactivated writer set aside");
  network.setAccountState(BOB, "active");

  await network.clientFor(AUTHORITY).procedure("com.atproto.memberspace.removeMember", { space, did: CAROL });
  network.advanceClock(engine.sync.options.truthIntervalMs);
  await compare("a removed member, after the truth interval");

  const dave = "did:plc:dave";
  await network.clientFor(AUTHORITY).procedure("com.atproto.memberspace.putMember", { space, did: dave, read: true, write: true });
  network.createAccount(dave, "pds1");
  await writeMessage(network, dave, space, 50);
  await compare("a new writer");
});

test("a DM conversation read through the engine matches the independent DM reader", async () => {
  const network = new FakeNetwork();
  const transport = (did: string) => ({ ...transportFor(network, did), store: { get: async () => null, set: async () => undefined, delete: async () => undefined } });
  const alice = new DmClient(transport(ALICE));
  const bob = new DmClient(transport(BOB));
  await bob.enableDms("everyone");
  const started = await alice.startConversation([BOB]);
  await bob.accept((await bob.listRequests())[0]!);
  const first = await alice.send(started.convKey, "hello bob");
  network.advanceClock(1);
  const reply = await bob.send(started.convKey, "hello alice");
  network.advanceClock(1);
  await alice.send(started.convKey, "how are you");
  await alice.edit(first.uri, "hello again");
  await bob.react(first.uri, "👍");
  await alice.react(reply.uri, "🎉");
  const compare = async (label: string) => {
    const engine = await alice.readConversation(started.convKey, started.participants);
    const independent = await readIndependentDmConversation(transportFor(network, ALICE), started.convKey, started.participants);
    assert.deepEqual(engine.messages.map((message) => [message.uri, message.text]), independent.messages.map((message) => [message.uri, message.text]), `${label}: messages`);
    assert.deepEqual(engine.reactions.map((reaction) => reaction.uri).sort(), independent.reactions.map((reaction) => reaction.uri).sort(), `${label}: reactions`);
    assert.deepEqual(engine.halves, independent.halves, `${label}: halves`);
  };
  await compare("both halves");
  await bob.delete(reply.uri);
  await compare("after a delete");
  await bob.deleteEverything(started.convKey);
  await compare("after a half is deleted");
});
