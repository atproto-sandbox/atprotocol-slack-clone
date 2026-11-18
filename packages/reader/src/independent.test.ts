import assert from "node:assert/strict";
import test from "node:test";
import { COMMIT_MAC_PROFILE, RECORD_MAC_PROFILE } from "@atproto/space";
import { WRITER_REMOVED_TYPE, WRITER_WRITE_TYPE } from "@flock/protocol/atproto/record-pages";
import { isAccessLost } from "@flock/protocol/atproto/space-credential-core";
import { memberspacePolicy } from "@flock/protocol/atproto/space-policy";
import { XrpcError } from "@flock/protocol/atproto/xrpc";
import { channelUri, acceptanceRecordKey, subjectKey, tidNow } from "@flock/protocol/keys";
import { COLLECTION, SPACE_TYPE } from "@flock/protocol/nsids";
import { FakeNetwork } from "@flock/testing/fake-network";
import {
  listIndependentWorkspaces,
  readIndependentChannelPage,
  readIndependentPrivateRoster,
  type IndependentDeps,
} from "./independent";

const AUTHORITY = "did:plc:authority";
const ALICE = "did:plc:alice";
const BOB = "did:plc:bob2";
const CAROL = "did:plc:carol";
const TIMESTAMP = "2026-11-17T12:00:00.000Z";

function depsFor(network: FakeNetwork, did: string): IndependentDeps {
  return {
    memberClient: network.clientFor(did),
    resolvePds: network.resolvePds,
    resolveKemKey: network.resolveKemKey,
    fetchEndpoint: network.fetchEndpoint,
    generateKey: network.generateKey,
    now: network.now,
  };
}

async function createChannelWorkspace(
  network: FakeNetwork,
  input: { members: readonly string[]; visibility?: "public" | "private"; skey?: string } = { members: [ALICE, BOB] },
) {
  const wsSkey = input.skey ?? "ws1";
  const chSkey = `${wsSkey}-general`;
  if (!network.hasAccount(AUTHORITY)) network.createAccount(AUTHORITY, "pds1");
  const owner = network.clientFor(AUTHORITY);

  const { space: workspace } = await owner.procedure<unknown, { space: string }>("com.atproto.space.createSpace", {
    spaceType: SPACE_TYPE.workspace,
    skey: wsSkey,
    policy: memberspacePolicy(),
  });
  await network.writeAs(AUTHORITY, workspace, COLLECTION.workspaceProfile, "self", {
    name: `Workspace ${wsSkey}`,
    createdAt: TIMESTAMP,
  });
  await network.writeAs(AUTHORITY, workspace, COLLECTION.admin, subjectKey(AUTHORITY), {
    subject: AUTHORITY,
    active: true,
    updatedAt: TIMESTAMP,
  });

  const channel = channelUri(AUTHORITY, chSkey);
  await owner.procedure("com.atproto.space.createSpace", {
    spaceType: SPACE_TYPE.channel,
    skey: chSkey,
    policy: memberspacePolicy(),
  });
  await network.writeAs(AUTHORITY, workspace, COLLECTION.directory, chSkey, {
    skey: chSkey,
    name: "general",
    visibility: input.visibility ?? "public",
    createdAt: TIMESTAMP,
  });

  for (const did of [AUTHORITY, ...input.members]) {
    if (!network.hasAccount(did)) network.createAccount(did, did.endsWith("2") ? "pds2" : "pds1");
    await network.writeAs(AUTHORITY, workspace, COLLECTION.workspaceRoster, subjectKey(did), {
      subject: did,
      active: true,
      updatedAt: TIMESTAMP,
    });
    if (input.visibility === "private") {
      await network.writeAs(AUTHORITY, channel, COLLECTION.channelRoster, subjectKey(did), {
        subject: did,
        active: true,
        updatedAt: TIMESTAMP,
      });
    }
    if (did === AUTHORITY) continue;
    await owner.procedure("com.atproto.memberspace.putMembers", {
      space: workspace,
      members: [{ did, read: true, write: true }],
    });
    await owner.procedure("com.atproto.memberspace.putMembers", {
      space: channel,
      members: [{ did, read: true, write: true }],
    });
  }

  return { workspace, channel, chSkey };
}

test("listIndependentWorkspaces uses .space from listSpaces, skips revoked/deleted workspaces, and keeps RepoTakendown non-destructive", async () => {
  const network = new FakeNetwork();
  const ws1 = await createChannelWorkspace(network, { members: [ALICE], skey: "alpha" });
  const ws2 = await createChannelWorkspace(network, { members: [ALICE], skey: "beta" });

  // Alice writes acceptance records so listSpaces on Alice's PDS lists both workspaces, then Alice is removed from ws2.
  await network.writeAs(ALICE, ws1.workspace, COLLECTION.acceptance, acceptanceRecordKey(ws1.workspace), {
    workspace: ws1.workspace,
    createdAt: TIMESTAMP,
  });
  await network.writeAs(ALICE, ws2.workspace, COLLECTION.acceptance, acceptanceRecordKey(ws2.workspace), {
    workspace: ws2.workspace,
    createdAt: TIMESTAMP,
  });
  await network.writeAs(AUTHORITY, ws2.workspace, COLLECTION.workspaceRoster, subjectKey(ALICE), {
    subject: ALICE,
    active: false,
    updatedAt: TIMESTAMP,
  });
  await network.clientFor(AUTHORITY).procedure("com.atproto.memberspace.removeMembers", {
    space: ws2.workspace,
    dids: [ALICE],
  });

  const listed = await listIndependentWorkspaces(depsFor(network, ALICE));
  assert.deepEqual(listed.map((w) => w.uri), [ws1.workspace]);

  // Host-level RepoTakendown on authorizeSpaceSync propagates as XrpcError (!isAccessLost), not SpaceCredentialError.
  network.setAccountState(AUTHORITY, "takendown");
  await assert.rejects(
    listIndependentWorkspaces(depsFor(network, ALICE)),
    (err: unknown) => err instanceof XrpcError && err.code === "RepoTakendown" && !isAccessLost(err),
  );
});

test("readIndependentChannelPage applies listWriters #repoRemoved and cross-page latest-wins removal", async () => {
  const network = new FakeNetwork();
  const { workspace, channel, chSkey } = await createChannelWorkspace(network, { members: [ALICE, BOB, CAROL], visibility: "private" });

  await network.writeAs(ALICE, channel, COLLECTION.message, tidNow(network.now() + 10), {
    text: "alice-msg",
    createdAt: TIMESTAMP,
  });
  await network.writeAs(BOB, channel, COLLECTION.message, tidNow(network.now() + 20), {
    text: "bob-msg",
    createdAt: TIMESTAMP,
  });

  assert.deepEqual(await readIndependentPrivateRoster(depsFor(network, ALICE), workspace, chSkey), [ALICE, AUTHORITY, BOB, CAROL].sort());

  // Remove Bob via removeMembers -> #repoRemoved excludes Bob's messages cleanly.
  await network.clientFor(AUTHORITY).procedure("com.atproto.memberspace.removeMembers", {
    space: channel,
    dids: [BOB],
  });
  const afterRemove = await readIndependentChannelPage(depsFor(network, ALICE), workspace, chSkey);
  assert.equal(afterRemove.degraded, false);
  assert.deepEqual(afterRemove.messages.map((m) => m.value.text), ["alice-msg"]);

  // Simulated listWriters #repoWrite followed by #repoRemoved for CAROL -> CAROL never probed.
  let carolProbed = false;
  network.interceptResponse = ({ method, params, response }) => {
    if (method === "com.atproto.space.listWriters" && params.space === channel && response.ok) {
      return Response.json({
        repos: [
          { $type: WRITER_WRITE_TYPE, repo: CAROL, repoRev: tidNow(network.now() + 30), spaceRev: tidNow(network.now() + 31), data: { $bytes: "AAAA" } },
          { $type: WRITER_WRITE_TYPE, repo: ALICE, repoRev: tidNow(network.now() + 32), spaceRev: tidNow(network.now() + 33), data: { $bytes: "AAAA" } },
          { $type: WRITER_REMOVED_TYPE, repo: CAROL, spaceRev: tidNow(network.now() + 34) },
        ],
        cursor: tidNow(network.now() + 34),
      });
    }
    if (method === "com.atproto.space.listRecords" && params.repo === CAROL) {
      carolProbed = true;
    }
    return response;
  };
  const crossEntry = await readIndependentChannelPage(depsFor(network, ALICE), workspace, chSkey);
  assert.equal(crossEntry.degraded, false);
  assert.equal(carolProbed, false);
  assert.deepEqual(crossEntry.messages.map((m) => m.value.text), ["alice-msg"]);
});

test("readIndependentChannelPage distinguishes authority RepoTakendown/Deactivated (transient N3) from non-authority writer (permanent) and verifies parent MACs", async () => {
  const network = new FakeNetwork();
  const { workspace, channel, chSkey } = await createChannelWorkspace(network, { members: [ALICE, BOB] });

  const baseMs = network.now();
  const parentRkey = tidNow(baseMs + 500);
  const parentUri = `at://${AUTHORITY}/space/${SPACE_TYPE.channel}/${chSkey}/${AUTHORITY}/${COLLECTION.message}/${parentRkey}`;
  await network.writeAs(AUTHORITY, channel, COLLECTION.message, parentRkey, {
    text: "authority-msg",
    createdAt: TIMESTAMP,
  });
  // Seed Bob's parent older than Bob's latest 100 messages so selectValidChannelMessages fetches it via MAC-verified getRecord.
  const bobParentRkey = tidNow(baseMs + 1);
  const bobParentUri = `at://${AUTHORITY}/space/${SPACE_TYPE.channel}/${chSkey}/${BOB}/${COLLECTION.message}/${bobParentRkey}`;
  await network.writeAs(BOB, channel, COLLECTION.message, bobParentRkey, {
    text: "bob-parent",
    createdAt: TIMESTAMP,
  });
  await network.applyWritesAs(
    BOB,
    channel,
    Array.from({ length: 100 }, (_, i) => ({
      action: "create" as const,
      collection: COLLECTION.message,
      rkey: tidNow(baseMs + 10 + i),
      value: { text: `bob-filler-${i}`, createdAt: TIMESTAMP },
    })),
  );
  await network.writeAs(ALICE, channel, COLLECTION.message, tidNow(baseMs + 600), {
    text: "alice-top",
    createdAt: TIMESTAMP,
  });
  await network.writeAs(ALICE, channel, COLLECTION.message, tidNow(baseMs + 601), {
    text: "alice-reply-to-bob",
    parent: bobParentUri,
    createdAt: TIMESTAMP,
  });

  // Valid parent MAC includes the reply.
  const validParentPage = await readIndependentChannelPage(depsFor(network, ALICE), workspace, chSkey, 2);
  assert.equal(validParentPage.messages.some((m) => m.value.text === "alice-reply-to-bob"), true);

  // Forged parent MAC drops the reply cleanly while keeping top-level messages.
  network.interceptResponse = ({ method, params, response }) => {
    if (method === "com.atproto.space.getRecord" && params.repo === BOB && params.rkey === bobParentRkey && response.ok) {
      const headers = new Headers(response.headers);
      headers.set("signature-input", headers.get("signature-input")!.replaceAll(RECORD_MAC_PROFILE, COMMIT_MAC_PROFILE));
      return new Response(response.body, { status: 200, headers });
    }
    return response;
  };
  const pageWithForgedParent = await readIndependentChannelPage(depsFor(network, ALICE), workspace, chSkey, 2);
  assert.equal(pageWithForgedParent.messages.some((m) => m.value.text === "alice-reply-to-bob"), false);
  assert.equal(pageWithForgedParent.messages.some((m) => m.value.text === "alice-top"), true);

  // N3: repo === AUTHORITY RepoTakendown logs "(transient)" while non-authority BOB RepoTakendown logs "(permanent)".
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    network.setAccountState(BOB, "takendown");
    network.interceptResponse = ({ method, params, response }) => {
      if (method === "com.atproto.space.listRecords" && params.space === channel && params.repo === AUTHORITY && response.ok) {
        return new Response(JSON.stringify({ error: "RepoTakendown", message: `RepoTakendown: ${AUTHORITY}` }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return response;
    };
    const degraded = await readIndependentChannelPage(depsFor(network, ALICE), workspace, chSkey);
    assert.equal(degraded.degraded, true);
    assert.ok(degraded.degradedReasons.some((r) => r.includes(AUTHORITY) && r.includes("taken down")));
    assert.ok(degraded.degradedReasons.some((r) => r.includes(BOB) && r.includes("taken down")));
    assert.ok(warnings.some((w) => w.includes("(transient)") && w.includes("RepoTakendown")));
    assert.ok(warnings.some((w) => w.includes("(permanent)") && w.includes("RepoTakendown")));
    assert.equal(degraded.messages.some((m) => m.value.text === "alice-top"), true);
    assert.equal(degraded.messages.some((m) => m.uri === parentUri), false);

    // Also test non-authority writer RepoNotFound sets writer aside cleanly.
    network.setAccountState(BOB, "missing");
    const missingBob = await readIndependentChannelPage(depsFor(network, ALICE), workspace, chSkey);
    assert.equal(missingBob.degraded, true);
    assert.ok(missingBob.degradedReasons.some((r) => r.includes(BOB) && r.includes("no repo")));
  } finally {
    console.warn = origWarn;
  }
});
