import assert from "node:assert/strict";
import test from "node:test";
import { COMMIT_MAC_PROFILE, RECORD_MAC_PROFILE } from "@atproto/space";
import { WRITER_REMOVED_TYPE, WRITER_WRITE_TYPE } from "@flock/protocol/atproto/record-pages";
import { isAccessLost } from "@flock/protocol/atproto/space-credential-core";
import { memberspacePolicy } from "@flock/protocol/atproto/space-policy";
import { XrpcError } from "@flock/protocol/atproto/xrpc";
import {
  channelRoleKey,
  channelUri,
  groupMembersUri,
  personalInvitesUri,
  SELF_SKEY,
  spaceRecordUri,
  tidNow,
  workspaceUri,
} from "@flock/protocol/keys";
import {
  ATPROTO_SPACE_COLLECTION,
  COLLECTION,
  FLOCK_EXTENSION_FIELD,
  OPENSOCIAL_COLLECTION,
  OPENSOCIAL_POLICY,
  OPENSOCIAL_SPACE_TYPE,
  SPACE_TYPE,
} from "@flock/protocol/nsids";
import { FakeNetwork } from "@flock/testing/fake-network";
import {
  listIndependentWorkspaces,
  readIndependentChannelPage,
  readIndependentInvites,
  readIndependentPrivateRoster,
  readIndependentWorkspace,
  type IndependentDeps,
} from "./independent";
import { readIndependentTasksWorkspaceSnapshot } from "./independent-tasks";

const AUTHORITY = "did:plc:authorityaaaaaaaaaaaaaaa";
const ALICE = "did:plc:aliceaaaaaaaaaaaaaaaaaaa";
const BOB = "did:plc:bob2aaaaaaaaaaaaaaaaaaaa";
const CAROL = "did:plc:carolaaaaaaaaaaaaaaaaaaa";
const TIMESTAMP = "2026-11-17T12:00:00.000Z";

function groupDidFor(label: string): string {
  if (label === "ws1") return AUTHORITY;
  const cleaned = label.toLowerCase().replace(/[^a-z2-7]/g, "").slice(0, 18);
  return `did:plc:grp${cleaned.padEnd(21, "a")}`;
}

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
  const label = input.skey ?? "ws1";
  const groupDid = groupDidFor(label);
  const chSkey = "general";

  await network.createGroupAccount(groupDid, {
    name: `Workspace ${label}`,
    joinPolicy: "invite",
    publicMeta: true,
    sovereignRotationKeys: ["did:key:zDnaeTestSovereignKey"],
  });
  const owner = network.clientFor(groupDid);
  const workspace = workspaceUri(groupDid);
  const membersSpace = groupMembersUri(groupDid);

  await owner.procedure("com.atproto.space.createSpace", {
    spaceType: SPACE_TYPE.workspace,
    skey: SELF_SKEY,
    policy: {
      $type: OPENSOCIAL_POLICY,
      publicRead: false,
      unlisted: false,
      grants: [
        { role: "admin", read: true, write: true },
        { role: "moderator", read: true, write: true },
        { role: "member", read: true },
      ],
    },
  });

  const privRole = channelRoleKey(chSkey);
  if (input.visibility === "private") {
    await owner.procedure("com.atproto.space.putRecord", {
      space: membersSpace,
      repo: groupDid,
      collection: OPENSOCIAL_COLLECTION.role,
      rkey: privRole,
      record: { $type: OPENSOCIAL_COLLECTION.role, displayName: "#general private" },
    });
  }

  const channel = channelUri(groupDid, chSkey);
  await owner.procedure("com.atproto.space.createSpace", {
    spaceType: SPACE_TYPE.channel,
    skey: chSkey,
    policy:
      input.visibility === "private"
        ? {
            $type: OPENSOCIAL_POLICY,
            publicRead: false,
            unlisted: true,
            grants: [{ role: privRole, read: true, write: true }],
          }
        : {
            $type: OPENSOCIAL_POLICY,
            publicRead: false,
            unlisted: false,
            grants: [
              { role: "admin", read: true, write: true },
              { role: "moderator", read: true, write: true },
              { role: "member", read: true, write: true },
            ],
          },
  });
  await network.writeAs(groupDid, workspace, COLLECTION.directory, chSkey, {
    skey: chSkey,
    name: "general",
    visibility: input.visibility ?? "public",
    createdAt: TIMESTAMP,
  });

  for (const [idx, did] of input.members.entries()) {
    if (!network.hasAccount(did)) network.createAccount(did, did.includes("bob2") ? "pds2" : "pds1");
    if (did === groupDid) continue;
    const roles = idx === 0 ? ["admin", "member"] : ["member"];
    if (input.visibility === "private") roles.push(privRole);
    await owner.procedure("com.atproto.space.putRecord", {
      space: membersSpace,
      repo: groupDid,
      collection: OPENSOCIAL_COLLECTION.membership,
      rkey: did,
      record: { $type: OPENSOCIAL_COLLECTION.membership, roles, createdAt: TIMESTAMP },
    });
    const mem = await owner.query<{ value: Record<string, unknown> }>("com.atproto.space.getRecord", {
      space: membersSpace,
      repo: groupDid,
      collection: OPENSOCIAL_COLLECTION.membership,
      rkey: did,
    });
    const inc = mem.value["new.flock.incarnation"];
    await network.writeAs(did, membersSpace, OPENSOCIAL_COLLECTION.acceptance, SELF_SKEY, {
      createdAt: TIMESTAMP,
      ...(typeof inc === "string" ? { "new.flock.incarnation": inc } : {}),
    });
  }

  return { groupDid, workspace, membersSpace, channel, chSkey };
}

test("listIndependentWorkspaces discovers OpenSocial groups via acceptance/self, skips revoked/deleted workspaces, and keeps RepoTakendown non-destructive", async () => {
  const network = new FakeNetwork();
  const ws1 = await createChannelWorkspace(network, { members: [ALICE], skey: "alpha" });
  const ws2 = await createChannelWorkspace(network, { members: [BOB, ALICE], skey: "beta" });

  await network.clientFor(ws2.groupDid).procedure("com.atproto.space.deleteRecord", {
    space: ws2.membersSpace,
    repo: ws2.groupDid,
    collection: OPENSOCIAL_COLLECTION.membership,
    rkey: ALICE,
  });

  const listed = await listIndependentWorkspaces(depsFor(network, ALICE));
  assert.deepEqual(listed.map((w) => w.uri), [ws1.workspace]);

  network.setAccountState(ws1.groupDid, "takendown");
  await assert.rejects(
    listIndependentWorkspaces(depsFor(network, ALICE)),
    (err: unknown) => err instanceof XrpcError && err.code === "RepoTakendown" && !isAccessLost(err),
  );
});

test("readIndependentChannelPage applies listWriters #repoRemoved, cross-page latest-wins removal, private roster RBAC, and !takedown / !hide labels", async () => {
  const network = new FakeNetwork();
  const { groupDid, workspace, membersSpace, channel, chSkey } = await createChannelWorkspace(network, {
    members: [ALICE, BOB, CAROL],
    visibility: "private",
  });

  const aliceRkey = tidNow(network.now() + 10);
  const bobRkey = tidNow(network.now() + 20);
  const carolRkey = tidNow(network.now() + 25);
  const aliceUri = spaceRecordUri(channel, ALICE, COLLECTION.message, aliceRkey);
  const carolUri = spaceRecordUri(channel, CAROL, COLLECTION.message, carolRkey);
  await network.writeAs(ALICE, channel, COLLECTION.message, aliceRkey, {
    text: "alice-msg",
    createdAt: TIMESTAMP,
  });
  await network.writeAs(BOB, channel, COLLECTION.message, bobRkey, {
    text: "bob-msg",
    createdAt: TIMESTAMP,
  });
  await network.writeAs(CAROL, channel, COLLECTION.message, carolRkey, {
    text: "carol-msg",
    createdAt: TIMESTAMP,
  });

  assert.deepEqual(await readIndependentPrivateRoster(depsFor(network, ALICE), workspace, chSkey), [ALICE, BOB, CAROL].sort());

  // Apply `!hide` on aliceUri and `!takedown` on carolUri
  await network.clientFor(groupDid).procedure("com.atproto.space.putRecord", {
    space: channel,
    repo: groupDid,
    collection: ATPROTO_SPACE_COLLECTION.label,
    rkey: tidNow(network.now() + 26),
    record: { $type: ATPROTO_SPACE_COLLECTION.label, src: groupDid, uri: aliceUri, val: "!hide", cts: TIMESTAMP },
  });
  await network.clientFor(groupDid).procedure("com.atproto.space.putRecord", {
    space: channel,
    repo: groupDid,
    collection: ATPROTO_SPACE_COLLECTION.label,
    rkey: tidNow(network.now() + 27),
    record: { $type: ATPROTO_SPACE_COLLECTION.label, src: groupDid, uri: carolUri, val: "!takedown", cts: TIMESTAMP },
  });

  // Remove Bob's membership -> #repoRemoved excludes Bob's messages cleanly.
  await network.clientFor(groupDid).procedure("com.atproto.space.deleteRecord", {
    space: membersSpace,
    repo: groupDid,
    collection: OPENSOCIAL_COLLECTION.membership,
    rkey: BOB,
  });
  const afterRemove = await readIndependentChannelPage(depsFor(network, ALICE), workspace, chSkey);
  assert.equal(afterRemove.degraded, false);
  assert.deepEqual(afterRemove.messages.map((m) => [m.value.text, m.hidden ?? false]), [["alice-msg", true]]);

  let carolProbed = false;
  network.interceptResponse = ({ method, params, response }) => {
    if (method === "com.atproto.space.listWriters" && params.space === channel && response.ok) {
      return Response.json({
        repos: [
          { $type: WRITER_WRITE_TYPE, repo: CAROL, repoRev: tidNow(network.now() + 30), spaceRev: tidNow(network.now() + 31), data: { $bytes: "AAAA" } },
          { $type: WRITER_WRITE_TYPE, repo: ALICE, repoRev: tidNow(network.now() + 32), spaceRev: tidNow(network.now() + 33), data: { $bytes: "AAAA" } },
          { $type: WRITER_WRITE_TYPE, repo: groupDid, repoRev: tidNow(network.now() + 33), spaceRev: tidNow(network.now() + 34), data: { $bytes: "AAAA" } },
          { $type: WRITER_REMOVED_TYPE, repo: CAROL, spaceRev: tidNow(network.now() + 35) },
        ],
        cursor: tidNow(network.now() + 35),
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
  const parentUri = `at:space/${AUTHORITY}/${SPACE_TYPE.channel}/${chSkey}/${AUTHORITY}/${COLLECTION.message}/${parentRkey}`;
  await network.writeAs(AUTHORITY, channel, COLLECTION.message, parentRkey, {
    text: "authority-msg",
    createdAt: TIMESTAMP,
  });

  const bobParentRkey = tidNow(baseMs + 1);
  const bobParentUri = `at:space/${AUTHORITY}/${SPACE_TYPE.channel}/${chSkey}/${BOB}/${COLLECTION.message}/${bobParentRkey}`;
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

  const validParentPage = await readIndependentChannelPage(depsFor(network, ALICE), workspace, chSkey, 2);
  assert.equal(validParentPage.messages.some((m) => m.value.text === "alice-reply-to-bob"), true);

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

  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    network.setAccountState(BOB, "takendown");
    network.interceptResponse = ({ method, params, response }) => {
      if (
        method === "com.atproto.space.listRecords" &&
        params.space === channel &&
        params.repo === AUTHORITY &&
        params.collection !== ATPROTO_SPACE_COLLECTION.label &&
        response.ok
      ) {
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

    network.setAccountState(BOB, "missing");
    const missingBob = await readIndependentChannelPage(depsFor(network, ALICE), workspace, chSkey);
    assert.equal(missingBob.degraded, true);
    assert.ok(missingBob.degradedReasons.some((r) => r.includes(BOB) && r.includes("no repo")));
  } finally {
    console.warn = origWarn;
  }
});

test("readIndependentInvites returns live cross-PDS invites and prunes tombstoned or RepoNotFound group writers", async () => {
  const network = new FakeNetwork();
  network.createAccount(ALICE, "pds1");
  await network.clientFor(ALICE).procedure("com.atproto.space.createSpace", {
    spaceType: OPENSOCIAL_SPACE_TYPE.invites,
    skey: SELF_SKEY,
    policy: memberspacePolicy({ publicWrite: true }),
  });
  const g1 = await createChannelWorkspace(network, { members: [BOB], skey: "invlive" });
  const g2 = await createChannelWorkspace(network, { members: [BOB], skey: "invdead" });

  const invitesSpace = personalInvitesUri(ALICE);
  const g1StdRkey = tidNow(network.now() + 1);
  await network.clientFor(g1.groupDid).procedure("com.atproto.space.putRecord", {
    space: invitesSpace,
    repo: g1.groupDid,
    collection: OPENSOCIAL_COLLECTION.invite,
    rkey: g1StdRkey,
    record: { $type: OPENSOCIAL_COLLECTION.invite, createdAt: TIMESTAMP, message: "Come join g1" },
  });
  const g1SpoofRkey = tidNow(network.now() + 2);
  await network.clientFor(g1.groupDid).procedure("com.atproto.space.putRecord", {
    space: invitesSpace,
    repo: g1.groupDid,
    collection: OPENSOCIAL_COLLECTION.invite,
    rkey: g1SpoofRkey,
    record: { $type: OPENSOCIAL_COLLECTION.invite, group: g2.groupDid, createdAt: TIMESTAMP },
  });
  await network.clientFor(g2.groupDid).procedure("com.atproto.space.putRecord", {
    space: invitesSpace,
    repo: g2.groupDid,
    collection: OPENSOCIAL_COLLECTION.invite,
    rkey: tidNow(network.now() + 3),
    record: { $type: OPENSOCIAL_COLLECTION.invite, createdAt: TIMESTAMP },
  });

  const baseDeps = depsFor(network, ALICE);
  const discoveredInvites = await readIndependentInvites(baseDeps, ALICE);
  assert.deepEqual(
    discoveredInvites.map((i) => i.groupDid).sort(),
    [g1.groupDid, g2.groupDid].sort(),
  );
  assert.equal(discoveredInvites.some((i) => i.rkey === g1SpoofRkey), false, "spoofed mismatched group property rejected");
  assert.equal(discoveredInvites.find((i) => i.rkey === g1StdRkey)?.message, "Come join g1");

  // Tombstoning g2 on PLC prunes g2 without failing readIndependentInvites!
  const pruned = await readIndependentInvites(
    {
      ...baseDeps,
      resolvePds: async (did: string) => {
        if (did === g2.groupDid) throw Object.assign(new Error("DidNotFound"), { status: 404, code: "DidNotFound" });
        return baseDeps.resolvePds(did);
      },
    },
    ALICE,
  );
  assert.deepEqual(pruned.map((i) => i.groupDid), [g1.groupDid]);
});

test("readIndependentInvites and readIndependentWorkspace force-refresh cached PLC origins after migration and withhold !takedown members", async () => {
  const network = new FakeNetwork();
  network.createAccount(ALICE, "pds1");
  await network.clientFor(ALICE).procedure("com.atproto.space.createSpace", {
    spaceType: OPENSOCIAL_SPACE_TYPE.invites,
    skey: SELF_SKEY,
    policy: memberspacePolicy({ publicWrite: true }),
  });
  const migrated = await createChannelWorkspace(network, { members: [ALICE, BOB, CAROL], skey: "migratedgrp" });

  // Publish invite on migrated.groupDid into ALICE's personal invites/self
  const invitesSpace = personalInvitesUri(ALICE);
  await network.clientFor(migrated.groupDid).procedure("com.atproto.space.putRecord", {
    space: invitesSpace,
    repo: migrated.groupDid,
    collection: OPENSOCIAL_COLLECTION.invite,
    rkey: tidNow(network.now() + 5),
    record: { $type: OPENSOCIAL_COLLECTION.invite, createdAt: TIMESTAMP },
  });

  // Publish account-level `!takedown` on CAROL in `members/self`
  await network.clientFor(migrated.groupDid).procedure("com.atproto.space.putRecord", {
    space: migrated.membersSpace,
    repo: migrated.groupDid,
    collection: ATPROTO_SPACE_COLLECTION.label,
    rkey: tidNow(network.now() + 6),
    record: {
      $type: ATPROTO_SPACE_COLLECTION.label,
      src: migrated.groupDid,
      uri: CAROL,
      val: "!takedown",
      cts: TIMESTAMP,
    },
  });

  const baseDeps = depsFor(network, ALICE);
  const liveGroupPds = await network.resolvePds(migrated.groupDid);
  const staleOldHost = "https://old-group-host.example";

  for (const staleErrorCode of ["RepoNotFound", "GroupNotFound", "SpaceNotFound", "RepoTakendown"] as const) {
    let forceRefreshCalls = 0;
    const staleCacheDeps: IndependentDeps = {
      ...baseDeps,
      did: ALICE,
      resolvePds: async (did, forceRefresh) => {
        if (did === migrated.groupDid) {
          if (forceRefresh) {
            forceRefreshCalls += 1;
            return liveGroupPds;
          }
          return staleOldHost;
        }
        return baseDeps.resolvePds(did, forceRefresh);
      },
      fetchEndpoint: async (request) => {
        if (new URL(request.url).origin === staleOldHost) {
          return Response.json(
            { error: staleErrorCode, message: `${staleErrorCode} on migrated source host` },
            { status: 400 },
          );
        }
        return baseDeps.fetchEndpoint(request);
      },
    };

    const invites = await readIndependentInvites(staleCacheDeps, ALICE);
    assert.deepEqual(invites.map((i) => i.groupDid), [migrated.groupDid], `invite recovered on ${staleErrorCode}`);
    assert.ok(forceRefreshCalls >= 1, `forceRefresh invoked for invite on ${staleErrorCode}`);

    const beforeWsRefresh = forceRefreshCalls;
    const ws = await readIndependentWorkspace(staleCacheDeps, migrated.workspace);
    assert.ok(ws, `workspace recovered on ${staleErrorCode}`);
    assert.ok(forceRefreshCalls > beforeWsRefresh, `forceRefresh invoked for workspace on ${staleErrorCode}`);
    assert.deepEqual(ws.members, [ALICE, BOB].sort(), "!takedown member CAROL withheld from members");
    assert.deepEqual(ws.pendingMembers, []);
    assert.deepEqual(ws.takendownMembers, [CAROL]);
  }
});

test("independent reader fails closed on truncated label/invite scans, excludes !takedown from private rosters, and rejects missing/malformed private channel policy", async () => {
  const network = new FakeNetwork();
  network.createAccount(ALICE, "pds1");
  await network.clientFor(ALICE).procedure("com.atproto.space.createSpace", {
    spaceType: OPENSOCIAL_SPACE_TYPE.invites,
    skey: SELF_SKEY,
    policy: memberspacePolicy({ publicWrite: true }),
  });

  const privFixture = await createChannelWorkspace(network, {
    members: [ALICE, BOB, CAROL],
    visibility: "private",
    skey: "privcheck",
  });
  const owner = network.clientFor(privFixture.groupDid);
  const baseDeps = depsFor(network, ALICE);

  // 1. Account !takedown on CAROL excludes CAROL from readIndependentPrivateRoster!
  await owner.procedure("com.atproto.space.putRecord", {
    space: privFixture.membersSpace,
    repo: privFixture.groupDid,
    collection: ATPROTO_SPACE_COLLECTION.label,
    rkey: tidNow(network.now() + 10),
    record: {
      $type: ATPROTO_SPACE_COLLECTION.label,
      src: privFixture.groupDid,
      uri: CAROL,
      val: "!takedown",
      cts: TIMESTAMP,
    },
  });
  const privRoster = await readIndependentPrivateRoster(baseDeps, privFixture.workspace, privFixture.chSkey);
  assert.deepEqual(privRoster, [ALICE, BOB].sort());

  // 2. Missing or malformed private-channel policy/self fails closed instead of synthesizing channel-<skey>!
  for (const badPolRecords of [
    [],
    [
      {
        uri: `${privFixture.channel}/${privFixture.groupDid}/${ATPROTO_SPACE_COLLECTION.spacePolicy}/self`,
        cid: "bafyreipol",
        collection: ATPROTO_SPACE_COLLECTION.spacePolicy,
        rkey: "self",
        value: {
          $type: ATPROTO_SPACE_COLLECTION.spacePolicy,
          policy: {
            $type: "com.example.wrongPolicy",
            grants: [{ role: "admin", read: true, write: true }],
          },
        },
      },
    ],
    // Round 18 Fix #3 & Round 19 Fix #4: Inner policy missing `$type`, outer wrapper missing `$type`, OR outer wrapper with wrong `$type` MUST all fail closed!
    [
      {
        uri: `${privFixture.channel}/${privFixture.groupDid}/${ATPROTO_SPACE_COLLECTION.spacePolicy}/self`,
        cid: "bafyreipolmissingoutertype",
        collection: ATPROTO_SPACE_COLLECTION.spacePolicy,
        rkey: "self",
        value: {
          policy: {
            $type: OPENSOCIAL_POLICY,
            grants: [{ role: "admin", read: true, write: true }],
          },
        },
      },
    ],
    [
      {
        uri: `${privFixture.channel}/${privFixture.groupDid}/${ATPROTO_SPACE_COLLECTION.spacePolicy}/self`,
        cid: "bafyreipolmissingtype",
        collection: ATPROTO_SPACE_COLLECTION.spacePolicy,
        rkey: "self",
        value: {
          $type: ATPROTO_SPACE_COLLECTION.spacePolicy,
          policy: {
            grants: [{ role: "admin", read: true, write: true }],
          },
        },
      },
    ],
    [
      {
        uri: `${privFixture.channel}/${privFixture.groupDid}/${ATPROTO_SPACE_COLLECTION.spacePolicy}/self`,
        cid: "bafyreipolbadwrapper",
        collection: ATPROTO_SPACE_COLLECTION.spacePolicy,
        rkey: "self",
        value: {
          $type: "com.example.badWrapper",
          policy: {
            $type: OPENSOCIAL_POLICY,
            grants: [{ role: "admin", read: true, write: true }],
          },
        },
      },
    ],
  ]) {
    const badPolDeps: IndependentDeps = {
      ...baseDeps,
      fetchEndpoint: async (req) => {
        const url = new URL(req.url);
        if (
          url.pathname === "/xrpc/com.atproto.space.listRecords" &&
          url.searchParams.get("space") === privFixture.channel &&
          url.searchParams.get("collection") === ATPROTO_SPACE_COLLECTION.spacePolicy
        ) {
          return Response.json({ records: badPolRecords });
        }
        return baseDeps.fetchEndpoint(req);
      },
    };
    await assert.rejects(
      readIndependentPrivateRoster(badPolDeps, privFixture.workspace, privFixture.chSkey),
      /Private-channel space policy is missing or invalid/,
    );
  }

  // 3. Truncated account label scan withholds members/pendingMembers in readIndependentWorkspace (rosterComplete: false) and throws in readIndependentChannelPage & readIndependentPrivateRoster!
  const truncLabelDeps: IndependentDeps = {
    ...baseDeps,
    fetchEndpoint: async (req) => {
      const url = new URL(req.url);
      if (
        url.pathname === "/xrpc/com.atproto.space.listRecords" &&
        url.searchParams.get("space") === privFixture.membersSpace &&
        url.searchParams.get("collection") === ATPROTO_SPACE_COLLECTION.label
      ) {
        const offset = Number((url.searchParams.get("cursor") ?? "off-0").replace("off-", "")) || 0;
        const limit = Number(url.searchParams.get("limit") ?? "100");
        const total = 2_001;
        const count = Math.max(0, Math.min(limit, total - offset));
        const records = Array.from({ length: count }, (_, idx) => {
          const rkey = tidNow(network.now() + 1_000 + offset + idx);
          return {
            uri: `${privFixture.membersSpace}/${privFixture.groupDid}/${ATPROTO_SPACE_COLLECTION.label}/${rkey}`,
            cid: "bafyreitest",
            collection: ATPROTO_SPACE_COLLECTION.label,
            rkey,
            value: {
              $type: ATPROTO_SPACE_COLLECTION.label,
              src: privFixture.groupDid,
              uri: BOB,
              val: "custom-tag",
              cts: TIMESTAMP,
            },
          };
        });
        return Response.json({
          records,
          ...(offset + count < total ? { cursor: `off-${offset + count}` } : {}),
        });
      }
      return baseDeps.fetchEndpoint(req);
    },
  };
  const truncWs = await readIndependentWorkspace(truncLabelDeps, privFixture.workspace);
  assert.ok(truncWs);
  assert.equal(truncWs.rosterComplete, false);
  assert.deepEqual(truncWs.members, []);
  assert.deepEqual(truncWs.pendingMembers, []);
  await assert.rejects(
    readIndependentChannelPage(truncLabelDeps, privFixture.workspace, privFixture.chSkey),
    /Moderation label scan exceeded authority record bounds/,
  );
  await assert.rejects(
    readIndependentPrivateRoster(truncLabelDeps, privFixture.workspace, privFixture.chSkey),
    /exceeds the 1000-record limit/,
  );

  // Authority label scan errors (500) in readIndependentChannelPage fail closed (not swallowed via readWriter)!
  const errorLabelDeps: IndependentDeps = {
    ...baseDeps,
    fetchEndpoint: async (req) => {
      const url = new URL(req.url);
      if (
        url.pathname === "/xrpc/com.atproto.space.listRecords" &&
        url.searchParams.get("space") === privFixture.channel &&
        url.searchParams.get("collection") === ATPROTO_SPACE_COLLECTION.label
      ) {
        return Response.json({ error: "UpstreamFailure", message: "label scan failed" }, { status: 500 });
      }
      return baseDeps.fetchEndpoint(req);
    },
  };
  await assert.rejects(
    readIndependentChannelPage(errorLabelDeps, privFixture.workspace, privFixture.chSkey),
    /label scan failed/,
  );

  // 4. readIndependentInvites fails closed on truncated writer scan and truncated per-writer invite scan!
  const invitesSpace = personalInvitesUri(ALICE);
  await owner.procedure("com.atproto.space.putRecord", {
    space: invitesSpace,
    repo: privFixture.groupDid,
    collection: OPENSOCIAL_COLLECTION.invite,
    rkey: tidNow(network.now() + 20),
    record: { $type: OPENSOCIAL_COLLECTION.invite, createdAt: TIMESTAMP },
  });

  const truncWriterInviteDeps: IndependentDeps = {
    ...baseDeps,
    fetchEndpoint: async (req) => {
      const url = new URL(req.url);
      if (
        url.pathname === "/xrpc/com.atproto.space.listWriters" &&
        url.searchParams.get("space") === invitesSpace
      ) {
        const offset = Number((url.searchParams.get("cursor") ?? "w-0").replace("w-", "")) || 0;
        const limit = Number(url.searchParams.get("limit") ?? "100");
        const total = 2_001;
        const count = Math.max(0, Math.min(limit, total - offset));
        const fixedRev = tidNow(network.now());
        const repos = Array.from({ length: count }, (_, idx) => ({
          $type: WRITER_WRITE_TYPE,
          repo: `did:web:fillerinv-${offset + idx}.example`,
          repoRev: fixedRev,
          spaceRev: fixedRev,
        }));
        return Response.json({
          repos,
          ...(offset + count < total ? { cursor: `w-${offset + count}` } : {}),
        });
      }
      return baseDeps.fetchEndpoint(req);
    },
  };
  await assert.rejects(
    readIndependentInvites(truncWriterInviteDeps, ALICE),
    /Invite scan exceeded bounded limits/,
  );

  const truncRecordInviteDeps: IndependentDeps = {
    ...baseDeps,
    fetchEndpoint: async (req) => {
      const url = new URL(req.url);
      if (
        url.pathname === "/xrpc/com.atproto.space.listRecords" &&
        url.searchParams.get("space") === invitesSpace &&
        url.searchParams.get("collection") === OPENSOCIAL_COLLECTION.invite
      ) {
        const offset = Number((url.searchParams.get("cursor") ?? "r-0").replace("r-", "")) || 0;
        const limit = Number(url.searchParams.get("limit") ?? "100");
        const total = 101;
        const count = Math.max(0, Math.min(limit, total - offset));
        const records = Array.from({ length: count }, (_, idx) => {
          const rkey = tidNow(network.now() + 5_000 + offset + idx);
          return {
            uri: `${invitesSpace}/${privFixture.groupDid}/${OPENSOCIAL_COLLECTION.invite}/${rkey}`,
            cid: "bafyreiinv",
            collection: OPENSOCIAL_COLLECTION.invite,
            rkey,
            value: { $type: OPENSOCIAL_COLLECTION.invite, createdAt: TIMESTAMP },
          };
        });
        return Response.json({
          records,
          ...(offset + count < total ? { cursor: `r-${offset + count}` } : {}),
        });
      }
      return baseDeps.fetchEndpoint(req);
    },
  };
  await assert.rejects(
    readIndependentInvites(truncRecordInviteDeps, ALICE),
    /Invite scan exceeded bounded limits/,
  );
});

test("independent reader and tasks snapshot recognize legacy-cid:<cid> bilateral acceptance on imported unversioned memberships", async () => {
  const network = new FakeNetwork();
  const fixture = await createChannelWorkspace(network, {
    members: [ALICE, BOB, CAROL],
    skey: "legacyreader",
  });

  // Preserve non-membership records (`role/*`, `space/*`, `spacePolicy/self`) and import unversioned `membership` records via STAR!
  const existing = await network.clientFor(fixture.groupDid).query<{
    records: Array<{ collection: string; rkey: string; value: Record<string, unknown> }>;
  }>("com.atproto.space.listRecords", {
    space: fixture.membersSpace,
    repo: fixture.groupDid,
    limit: 100,
  });
  const nonMemberships = existing.records
    .filter((rec) => rec.collection !== OPENSOCIAL_COLLECTION.membership)
    .map((rec) => {
      const { $type: _type, ...rest } = rec.value;
      void _type;
      return { collection: rec.collection, rkey: rec.rkey, value: rest };
    });

  await network.importRepoAs(fixture.groupDid, fixture.membersSpace, [
    ...nonMemberships,
    {
      collection: OPENSOCIAL_COLLECTION.membership,
      rkey: ALICE,
      value: { roles: ["admin", "member"], createdAt: TIMESTAMP },
    },
    {
      collection: OPENSOCIAL_COLLECTION.membership,
      rkey: BOB,
      value: { roles: ["member"], createdAt: TIMESTAMP },
    },
    {
      collection: OPENSOCIAL_COLLECTION.membership,
      rkey: CAROL,
      value: { roles: ["member"], createdAt: TIMESTAMP },
    },
  ]);

  const aliceMem = await network.clientFor(fixture.groupDid).query<{
    cid: string;
    value: Record<string, unknown>;
  }>("com.atproto.space.getRecord", {
    space: fixture.membersSpace,
    repo: fixture.groupDid,
    collection: OPENSOCIAL_COLLECTION.membership,
    rkey: ALICE,
  });
  assert.equal(aliceMem.value[FLOCK_EXTENSION_FIELD.incarnation], undefined);

  // Alice writes matching `legacy-cid:<aliceMem.cid>` acceptance; Bob writes mismatched `legacy-cid:`; Carol has none!
  await network.writeAs(ALICE, fixture.membersSpace, OPENSOCIAL_COLLECTION.acceptance, SELF_SKEY, {
    createdAt: TIMESTAMP,
    [FLOCK_EXTENSION_FIELD.incarnation]: `legacy-cid:${aliceMem.cid}`,
  });
  await network.writeAs(BOB, fixture.membersSpace, OPENSOCIAL_COLLECTION.acceptance, SELF_SKEY, {
    createdAt: TIMESTAMP,
    [FLOCK_EXTENSION_FIELD.incarnation]: "legacy-cid:bafyreistalebobcid",
  });
  await network.deleteAs(CAROL, fixture.membersSpace, OPENSOCIAL_COLLECTION.acceptance, SELF_SKEY);

  const deps = { ...depsFor(network, ALICE), did: ALICE };
  const ws = await readIndependentWorkspace(deps, fixture.workspace);
  assert.ok(ws);
  assert.equal(ws.rosterComplete, true);
  assert.deepEqual(ws.members, [ALICE]);
  assert.deepEqual(ws.pendingMembers, [BOB, CAROL].sort());

  const listed = await listIndependentWorkspaces(deps);
  assert.deepEqual(listed.find((w) => w.uri === fixture.workspace)?.members, [ALICE]);

  const tasksSnap = await readIndependentTasksWorkspaceSnapshot(deps, fixture.workspace);
  assert.equal(tasksSnap.workspaceSnapshotComplete, true);
  assert.deepEqual(tasksSnap.rosterMembers, [ALICE]);
});

test("Round 9 Finding #5: listIndependentWorkspaces rethrows transient personal acceptance/self read failures while skipping true absence", async () => {
  const network = new FakeNetwork();
  const acceptedWs = await createChannelWorkspace(network, { members: [ALICE], skey: "r9indacc" });
  const unacceptedWs = await createChannelWorkspace(network, { members: [BOB, ALICE], skey: "r9indnoacc" });
  await network.deleteAs(ALICE, unacceptedWs.membersSpace, OPENSOCIAL_COLLECTION.acceptance, SELF_SKEY);

  const baseDeps: IndependentDeps = { ...depsFor(network, ALICE), did: ALICE };

  // Baseline: `RecordNotFound` on `unacceptedWs` skips `unacceptedWs` while returning `acceptedWs`!
  const normalListed = await listIndependentWorkspaces(baseDeps);
  assert.deepEqual(normalListed.map((w) => w.uri), [acceptedWs.workspace]);

  // Transient 503, network TypeError, and 403 ScopeMissingError on personal `acceptance/self` MUST rethrow instead of hiding `acceptedWs`!
  for (const injected of [
    new XrpcError(503, "Personal PDS unavailable", "UpstreamFailure"),
    new TypeError("fetch failed"),
    new XrpcError(403, "Missing scope", "ScopeMissingError"),
  ]) {
    const flakyDeps: IndependentDeps = {
      ...baseDeps,
      memberClient: {
        query: async (nsid, params, opts) => {
          if (
            nsid === "com.atproto.space.getRecord" &&
            params?.space === acceptedWs.membersSpace &&
            params?.collection === OPENSOCIAL_COLLECTION.acceptance
          ) {
            throw injected;
          }
          return baseDeps.memberClient.query(nsid, params, opts);
        },
        procedure: (nsid, input, params, opts) => baseDeps.memberClient.procedure(nsid, input, params, opts),
      } as IndependentDeps["memberClient"],
    };
    await assert.rejects(
      listIndependentWorkspaces(flakyDeps),
      (err: unknown) => err === injected,
    );
  }
});
