import assert from "node:assert/strict";
import test from "node:test";
import { appInboxSkey, appInboxUri, appRoleKey, SELF_SKEY, spaceRecordUri, subjectKey } from "@flock/protocol/keys";
import { ATPROTO_SPACE_COLLECTION, COLLECTION, ATGRP_COLLECTION, ATGRP_POLICY, SPACE_TYPE } from "@flock/protocol/nsids";
import { FakeNetwork } from "@flock/testing/fake-network";
import { createEngine } from "./engine";
import { AUTHORITY, countCalls, createWorkspace, key, transportFor } from "./testing/engine-fixture";

const ALICE = "did:plc:alice";
const APP = "did:plc:app2";

test("a member sends and retracts commands and actions without minting a credential or touching their local store, and the app syncs both collections with !takedown filtering", async () => {
  const network = new FakeNetwork();
  const fixture = await createWorkspace(network, { members: [ALICE], channels: [{ skey: "general", visibility: "public" }] });
  network.createAccount(APP, "pds2");
  const owner = network.clientFor(AUTHORITY);
  const botRole = appRoleKey(APP);
  await owner.procedure("com.atproto.space.putRecord", {
    space: fixture.members,
    repo: AUTHORITY,
    collection: ATGRP_COLLECTION.role,
    rkey: botRole,
    record: { $type: ATGRP_COLLECTION.role, displayName: "App Bot" },
  });
  await owner.procedure("com.atproto.space.putRecord", {
    space: fixture.workspace,
    repo: AUTHORITY,
    collection: COLLECTION.appInstall,
    rkey: subjectKey(APP),
    record: {
      $type: COLLECTION.appInstall,
      subject: APP,
      active: true,
      channels: [{ skey: "general", write: true }],
      installedBy: ALICE,
      installedAt: "2026-11-10T12:00:00.000Z",
      updatedAt: "2026-11-10T12:00:00.000Z",
    },
  });
  await owner.procedure("com.atproto.space.putRecord", {
    space: fixture.members,
    repo: AUTHORITY,
    collection: ATGRP_COLLECTION.membership,
    rkey: APP,
    record: { $type: ATGRP_COLLECTION.membership, roles: [botRole], createdAt: "2026-11-10T12:00:00.000Z" },
  });

  const inboxSkey = appInboxSkey(SELF_SKEY, APP);
  const inbox = appInboxUri(AUTHORITY, SELF_SKEY, APP);
  await owner.procedure("com.atproto.space.createSpace", {
    spaceType: SPACE_TYPE.appInbox,
    skey: inboxSkey,
    policy: {
      $type: ATGRP_POLICY,
      publicRead: false,
      unlisted: true,
      grants: [
        { role: botRole, read: true },
        { role: "admin", write: true },
        { role: "moderator", write: true },
        { role: "member", write: true },
      ],
    },
  });

  const alice = createEngine(transportFor(network, ALICE));
  const app = createEngine(transportFor(network, APP), { applyOwnWrites: false });
  const ref = { workspace: fixture.workspace, skey: "general" };
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

  // Group `!takedown` label on inbox command withholds it from `readPage`, and negation restores it.
  await owner.procedure("com.atproto.space.putRecord", {
    space: inbox,
    repo: AUTHORITY,
    collection: ATPROTO_SPACE_COLLECTION.label,
    rkey: key(10),
    record: {
      $type: ATPROTO_SPACE_COLLECTION.label,
      src: AUTHORITY,
      uri: cmdWritten.uri,
      val: "!takedown",
      cts: "2026-11-10T12:01:00.000Z",
    },
  });
  await app.sync.markSpaceStale(inbox);
  const takedownWriters = await app.appInboxes.writers(fixture.workspace, APP);
  assert.deepEqual((await app.appInboxes.readPage(fixture.workspace, APP, COLLECTION.appCommand, { writers: takedownWriters })).records, []);

  await owner.procedure("com.atproto.space.putRecord", {
    space: inbox,
    repo: AUTHORITY,
    collection: ATPROTO_SPACE_COLLECTION.label,
    rkey: key(11),
    record: {
      $type: ATPROTO_SPACE_COLLECTION.label,
      src: AUTHORITY,
      uri: cmdWritten.uri,
      val: "!takedown",
      neg: true,
      cts: "2026-11-10T12:02:00.000Z",
    },
  });
  await app.sync.markSpaceStale(inbox);
  const restoredWriters = await app.appInboxes.writers(fixture.workspace, APP);
  assert.equal((await app.appInboxes.readPage(fixture.workspace, APP, COLLECTION.appCommand, { writers: restoredWriters })).records.length, 1);

  // Account-level `!takedown` label in `members/self` (granted read to `botRole`) withholds ALICE's inbox commands & actions without prior `markSpaceStale`!
  await owner.procedure("com.atproto.space.updateSpace", {
    space: fixture.members,
    policy: {
      $type: ATGRP_POLICY,
      publicRead: false,
      unlisted: false,
      grants: [
        { role: "admin", read: true, write: true },
        { role: "moderator", read: true, write: true },
        { role: "member", read: true, write: true },
        { role: botRole, read: true },
      ],
    },
  });
  await owner.procedure("com.atproto.space.putRecord", {
    space: fixture.members,
    repo: AUTHORITY,
    collection: ATPROTO_SPACE_COLLECTION.label,
    rkey: key(12),
    record: {
      $type: ATPROTO_SPACE_COLLECTION.label,
      src: AUTHORITY,
      uri: ALICE,
      val: "!takedown",
      cts: "2026-11-10T12:03:00.000Z",
    },
  });
  const acctWriters = await app.appInboxes.writers(fixture.workspace, APP);
  assert.deepEqual((await app.appInboxes.readPage(fixture.workspace, APP, COLLECTION.appCommand, { writers: acctWriters })).records, []);
  assert.deepEqual((await app.appInboxes.readPage(fixture.workspace, APP, COLLECTION.appAction, { writers: acctWriters })).records, []);

  // Negating account-level `!takedown` restores ALICE's inbox records.
  await owner.procedure("com.atproto.space.putRecord", {
    space: fixture.members,
    repo: AUTHORITY,
    collection: ATPROTO_SPACE_COLLECTION.label,
    rkey: key(13),
    record: {
      $type: ATPROTO_SPACE_COLLECTION.label,
      src: AUTHORITY,
      uri: ALICE,
      val: "!takedown",
      neg: true,
      cts: "2026-11-10T12:04:00.000Z",
    },
  });
  const unblockedWriters = await app.appInboxes.writers(fixture.workspace, APP);
  assert.equal((await app.appInboxes.readPage(fixture.workspace, APP, COLLECTION.appCommand, { writers: unblockedWriters })).records.length, 1);

  // Retracting is idempotent even when already gone.
  await alice.appInboxes.retractCommand(fixture.workspace, APP, cmdWritten.rkey);
  await alice.appInboxes.retractCommand(fixture.workspace, APP, cmdWritten.rkey);
  await alice.appInboxes.retractAction(fixture.workspace, APP, actWritten.rkey);
  await alice.appInboxes.retractAction(fixture.workspace, APP, actWritten.rkey);

  const afterWriters = await app.appInboxes.writers(fixture.workspace, APP);
  assert.deepEqual((await app.appInboxes.readPage(fixture.workspace, APP, COLLECTION.appCommand, { writers: afterWriters })).records, []);
  assert.deepEqual((await app.appInboxes.readPage(fixture.workspace, APP, COLLECTION.appAction, { writers: afterWriters })).records, []);
});
