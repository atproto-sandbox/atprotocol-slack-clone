import assert from "node:assert/strict";
import test from "node:test";
import { SpaceCredentialError } from "@flock/protocol/atproto/space-credential-core";
import { channelUri, groupMembersUri, SELF_SKEY, workspaceUri } from "@flock/protocol/keys";
import { COLLECTION, OPENSOCIAL_COLLECTION, OPENSOCIAL_POLICY, SPACE_TYPE } from "@flock/protocol/nsids";
import { FakeNetwork } from "@flock/testing/fake-network";
import { deleteChannelMessage, editChannelMessage, postChannelMessage } from "./channel";
import type { DeskShellDeps } from "./membership";

const GROUP = "did:plc:grpchannelaaaaaaaaaaaaaa";
const ALICE = "did:plc:alicechannelaaaaaaaaaaaa";
const BOB = "did:plc:bobchannelaaaaaaaaaaaaaa";

function shellDeps(net: FakeNetwork, did: string): DeskShellDeps {
  return {
    did,
    memberClient: net.clientFor(did),
    resolvePds: net.resolvePds,
    resolveKemKey: net.resolveKemKey,
    fetchEndpoint: net.fetchEndpoint,
    generateKey: net.generateKey,
    now: net.now,
  };
}

async function setupGroupWithChannel() {
  const net = new FakeNetwork();
  net.createAccount(ALICE, "pds1");
  net.createAccount(BOB, "pds2");
  await net.createGroupAccount(GROUP, {
    name: "Channel Test Group",
    joinPolicy: "open",
    publicMeta: true,
    sovereignRotationKeys: ["did:key:zDnaeTestChannelKey"],
  });
  const owner = net.clientFor(GROUP);
  const ws = workspaceUri(GROUP);
  const ch = channelUri(GROUP, "general");
  const membersUri = groupMembersUri(GROUP);
  const policy = {
    $type: OPENSOCIAL_POLICY,
    publicRead: false,
    unlisted: false,
    grants: [
      { role: "admin", read: true, write: true },
      { role: "member", read: true, write: true },
    ],
  };
  await owner.procedure("com.atproto.space.createSpace", { spaceType: SPACE_TYPE.workspace, skey: SELF_SKEY, policy });
  await owner.procedure("com.atproto.space.createSpace", { spaceType: SPACE_TYPE.channel, skey: "general", policy });
  for (const [did, roles] of [[ALICE, ["admin", "member"]], [BOB, ["member"]]] as const) {
    await owner.procedure("com.atproto.space.putRecord", {
      space: membersUri,
      repo: GROUP,
      collection: OPENSOCIAL_COLLECTION.membership,
      rkey: did,
      record: { $type: OPENSOCIAL_COLLECTION.membership, roles: [...roles], createdAt: "2026-11-20T00:00:00.000Z" },
    });
  }
  return { net, ws, ch, membersUri };
}

test("channel writes mint fresh credentials, use createRecord, verify top-level parents, preserve third-party fields on edit, and reject removed members immediately", async () => {
  const { net, ch, membersUri } = await setupGroupWithChannel();
  const aliceDeps = shellDeps(net, ALICE);
  const bobDeps = shellDeps(net, BOB);

  // 1. Post top-level message via createRecord
  const top = await postChannelMessage(aliceDeps, ch, { text: "Hello from Desk" });
  assert.ok(top.uri.includes(`/${ALICE}/${COLLECTION.message}/${top.rkey}`));

  // 2. Reply to top-level message succeeds
  const reply = await postChannelMessage(bobDeps, ch, { text: "Reply from Bob", parent: top.uri });
  assert.ok(reply.uri.includes(`/${BOB}/${COLLECTION.message}/${reply.rkey}`));

  // 3. Replying to a reply (nested thread) or non-existent parent is rejected
  await assert.rejects(
    () => postChannelMessage(aliceDeps, ch, { text: "Nested", parent: reply.uri }),
    /top-level message/,
  );

  // 4. Edit preserves unknown third-party fields & re-verifies parent
  await net.clientFor(BOB).procedure("com.atproto.space.putRecord", {
    space: ch,
    repo: BOB,
    collection: COLLECTION.message,
    rkey: reply.rkey,
    record: {
      $type: COLLECTION.message,
      text: "Reply from Bob",
      parent: top.uri,
      thirdPartyTag: "keep-me",
      createdAt: "2026-11-20T00:01:00.000Z",
    },
  });
  await editChannelMessage(bobDeps, ch, reply.uri, { text: "Edited reply" });
  const edited = await net.clientFor(BOB).query<{ value: Record<string, unknown> }>("com.atproto.space.getRecord", {
    space: ch,
    repo: BOB,
    collection: COLLECTION.message,
    rkey: reply.rkey,
  });
  assert.equal(edited.value.text, "Edited reply");
  assert.equal(edited.value.thirdPartyTag, "keep-me");
  assert.equal(edited.value.parent, top.uri);

  // 5. Cannot edit or delete another member's message
  await assert.rejects(() => editChannelMessage(aliceDeps, ch, reply.uri, { text: "hijack" }), /only your own/);
  await assert.rejects(() => deleteChannelMessage(aliceDeps, ch, reply.uri), /only your own/);

  // 6. Delete own message succeeds
  await deleteChannelMessage(bobDeps, ch, reply.uri);

  // 7. Remove Bob from group -> fresh credential check immediately rejects any write!
  await net.clientFor(GROUP).procedure("com.atproto.space.deleteRecord", {
    space: membersUri,
    repo: GROUP,
    collection: OPENSOCIAL_COLLECTION.membership,
    rkey: BOB,
  });
  await assert.rejects(
    () => postChannelMessage(bobDeps, ch, { text: "Should be blocked" }),
    SpaceCredentialError,
  );
});
