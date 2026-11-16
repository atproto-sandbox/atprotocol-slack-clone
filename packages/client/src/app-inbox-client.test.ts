import assert from "node:assert/strict";
import test from "node:test";
import { memberspacePolicy } from "@flock/protocol/atproto/space-policy";
import { appInboxSkey, appInboxUri, spaceRecordUri } from "@flock/protocol/keys";
import { COLLECTION, SPACE_TYPE } from "@flock/protocol/nsids";
import { FakeNetwork } from "@flock/testing/fake-network";
import { createEngine } from "./engine";
import { AUTHORITY, countCalls, createWorkspace, key, transportFor } from "./testing/engine-fixture";

const ALICE = "did:plc:alice";
const APP = "did:plc:app2";

test("a member sends and retracts commands and actions without minting a credential or touching their local store, and the app syncs both collections", async () => {
  const network = new FakeNetwork();
  const fixture = await createWorkspace(network, { members: [ALICE], channels: [{ skey: "general", visibility: "public" }] });
  network.createAccount(APP, "pds2");
  const owner = network.clientFor(AUTHORITY);
  const inboxSkey = appInboxSkey("acme", APP);
  const inbox = appInboxUri(AUTHORITY, "acme", APP);
  await owner.procedure("com.atproto.space.createSpace", { spaceType: SPACE_TYPE.appInbox, skey: inboxSkey, policy: memberspacePolicy() });
  await owner.procedure("com.atproto.memberspace.putMember", { space: inbox, did: ALICE, read: false, write: true });
  await owner.procedure("com.atproto.memberspace.putMember", { space: inbox, did: APP, read: true, write: false });

  const alice = createEngine(transportFor(network, ALICE));
  const app = createEngine(transportFor(network, APP), { applyOwnWrites: false });
  const ref = { workspace: fixture.workspace, skey: "acme-general" };
  const targetMsg = spaceRecordUri(fixture.channels.general!, APP, COLLECTION.message, key(1));

  let cmdWritten!: { uri: string; rkey: string };
  let actWritten!: { uri: string; rkey: string };
  const memberCalls = await countCalls(network, async () => {
    cmdWritten = await alice.appInboxes.sendCommand(ref, APP, "echo", "hello");
    network.advanceClock(1);
    actWritten = await alice.appInboxes.sendAction(ref, APP, targetMsg, "again");
  });

  assert.equal(memberCalls["com.atproto.space.getDelegationToken"], undefined, "member writes mint no credential");
  assert.deepEqual(await alice.sync.store.records(inbox, COLLECTION.appCommand), [], "member writes keep nothing in the local store");
  assert.deepEqual(await alice.sync.store.records(inbox, COLLECTION.appAction), []);

  // Another member cannot mint a credential to read the inbox.
  await assert.rejects(alice.appInboxes.readPage(fixture.workspace, APP, COLLECTION.appCommand));

  // The installed app syncs both collections from the inbox.
  const writers = await app.appInboxes.writers(fixture.workspace, APP);
  const commands = await app.appInboxes.readPage(fixture.workspace, APP, COLLECTION.appCommand, { writers });
  const actions = await app.appInboxes.readPage(fixture.workspace, APP, COLLECTION.appAction, { writers });
  assert.deepEqual(commands.records.map((entry) => [entry.uri, entry.value.command, entry.value.text]), [[cmdWritten.uri, "echo", "hello"]]);
  assert.deepEqual(actions.records.map((entry) => [entry.uri, entry.value.actionId, entry.value.value]), [[actWritten.uri, "again", undefined]]);

  // Retracting is idempotent even when already gone.
  await alice.appInboxes.retractCommand(fixture.workspace, APP, cmdWritten.rkey);
  await alice.appInboxes.retractCommand(fixture.workspace, APP, cmdWritten.rkey);
  await alice.appInboxes.retractAction(fixture.workspace, APP, actWritten.rkey);
  await alice.appInboxes.retractAction(fixture.workspace, APP, actWritten.rkey);

  const afterWriters = await app.appInboxes.writers(fixture.workspace, APP);
  assert.deepEqual((await app.appInboxes.readPage(fixture.workspace, APP, COLLECTION.appCommand, { writers: afterWriters })).records, []);
  assert.deepEqual((await app.appInboxes.readPage(fixture.workspace, APP, COLLECTION.appAction, { writers: afterWriters })).records, []);
});
