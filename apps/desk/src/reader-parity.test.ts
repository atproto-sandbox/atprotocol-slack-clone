import assert from "node:assert/strict";
import test from "node:test";
import {
  channelRoleKey,
  channelUri,
  groupMembersUri,
  personalInboxUri,
  SELF_SKEY,
  tidNow,
  workspaceUri,
} from "@flock/protocol/keys";
import { ATGRP_COLLECTION, ATGRP_POLICY, COLLECTION, SPACE_TYPE } from "@flock/protocol/nsids";
import {
  listIndependentWorkspaces,
  readIndependentChannelPage,
  readIndependentInvites,
  readIndependentPrivateRoster,
  readIndependentWorkspace,
  type IndependentDeps,
} from "@flock/reader/independent";
import { createBrowserSpaceCredentialDeps } from "@flock/shell/did-resolver";
import { ensureInvitesSpace } from "@flock/shell/invites";
import { MemoryLifecycleStore } from "@flock/shell/lifecycle-store";
import { acceptDirectMembership } from "@flock/shell/membership";
import { postChannelMessage } from "@flock/shell/channel";
import { FakeNetwork } from "@flock/testing/fake-network";

const GROUP = "did:plc:grpdeskparityaaaaaaaaaaa";
const ALICE = "did:plc:alicedeskparityaaaaaaaaa";
const BOB = "did:plc:bobdeskparityaaaaaaaaaaa";

test("createBrowserSpaceCredentialDeps from @flock/shell integrates seamlessly with @flock/reader/independent on FakeNetwork", async () => {
  const net = new FakeNetwork();
  net.createAccount(ALICE, "pds1");
  net.createAccount(BOB, "pds2");
  await net.createGroupAccount(GROUP, {
    name: "Desk Parity Group",
    joinPolicy: "invite",
    publicMeta: true,
    sovereignRotationKeys: ["did:key:zDnaeDeskParityKey"],
  });

  const owner = net.clientFor(GROUP);
  const wsUri = workspaceUri(GROUP);
  const membersUri = groupMembersUri(GROUP);
  const generalUri = channelUri(GROUP, "general");
  const vaultUri = channelUri(GROUP, "vault");
  const vaultRole = channelRoleKey("vault");

  const openPolicy = {
    $type: ATGRP_POLICY,
    publicRead: false,
    unlisted: false,
    grants: [
      { role: "admin", read: true, write: true },
      { role: "member", read: true, write: true },
    ],
  };

  await owner.procedure("com.atproto.space.createSpace", { spaceType: SPACE_TYPE.workspace, skey: SELF_SKEY, policy: openPolicy });
  await owner.procedure("com.atproto.space.createSpace", { spaceType: SPACE_TYPE.channel, skey: "general", policy: openPolicy });
  await owner.procedure("com.atproto.space.putRecord", {
    space: membersUri,
    repo: GROUP,
    collection: ATGRP_COLLECTION.role,
    rkey: vaultRole,
    record: { $type: ATGRP_COLLECTION.role, displayName: "Vault members" },
  });
  await owner.procedure("com.atproto.space.createSpace", {
    spaceType: SPACE_TYPE.channel,
    skey: "vault",
    policy: {
      $type: ATGRP_POLICY,
      publicRead: false,
      unlisted: true,
      grants: [{ role: vaultRole, read: true, write: true }],
    },
  });
  await net.writeAs(GROUP, wsUri, COLLECTION.directory, "general", {
    skey: "general",
    name: "general",
    visibility: "public",
    createdAt: "2026-11-20T00:00:00.000Z",
  });
  await net.writeAs(GROUP, wsUri, COLLECTION.directory, "vault", {
    skey: "vault",
    name: "Vault",
    visibility: "private",
    createdAt: "2026-11-20T00:00:00.000Z",
  });

  for (const [did, roles] of [[ALICE, ["admin", "member"]], [BOB, ["member", vaultRole]]] as const) {
    await owner.procedure("com.atproto.space.putRecord", {
      space: membersUri,
      repo: GROUP,
      collection: ATGRP_COLLECTION.membership,
      rkey: did,
      record: { $type: ATGRP_COLLECTION.membership, roles: [...roles], createdAt: "2026-11-20T00:00:00.000Z" },
    });
  }

  // Build BrowserSpaceCredentialDeps via @flock/shell factory (using FakeNetwork as loopback fetch)
  const makeShellDeps = (did: string): IndependentDeps & { readonly did: string } => {
    const pdsOrigin = `http://127.0.0.1:${did === ALICE ? 9101 : 9102}`;
    const rawClient = net.clientFor(did);
    // Bridge raw fetchHandler to FakeNetwork client
    const session = {
      did,
      fetchHandler: async (path: string, init: RequestInit) => {
        const url = new URL(path, pdsOrigin);
        const method = url.pathname.replace(/^\/xrpc\//, "");
        try {
          if ((init.method ?? "GET").toUpperCase() === "GET") {
            const params: Record<string, string> = {};
            for (const [k, v] of url.searchParams.entries()) params[k] = v;
            const data = await rawClient.query(method, params);
            return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
          }
          const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
          const data = await rawClient.procedure(method, body);
          return new Response(JSON.stringify(data ?? {}), { status: 200, headers: { "content-type": "application/json" } });
        } catch (error) {
          const status = typeof error === "object" && error && "status" in error ? Number((error as { status: number }).status) : 500;
          const code = typeof error === "object" && error && "code" in error ? String((error as { code: string }).code) : "XrpcError";
          const message = error instanceof Error ? error.message : String(error);
          return new Response(JSON.stringify({ error: code, message }), { status, headers: { "content-type": "application/json" } });
        }
      },
    };
    const base = createBrowserSpaceCredentialDeps(session, {
      plcUrl: "http://127.0.0.1:2582",
      loopbackAllowed: true,
      fetchImpl: async (input, init) => net.fetchEndpoint(input instanceof Request ? input : new Request(input, init)),
      didResolver: {
        resolveDocument: async () => ({}),
        resolvePds: net.resolvePds,
        resolveKemKey: net.resolveKemKey,
      },
      generateKey: net.generateKey,
      now: net.now,
    });
    // Structural assignability check to @flock/reader's IndependentDeps:
    const asIndependent: IndependentDeps & { readonly did: string } = base;
    return asIndependent;
  };

  const bobDeps = makeShellDeps(BOB);
  const bobStore = new MemoryLifecycleStore(BOB);

  // Provision invites space & seed an expiring cross-PDS invite
  await ensureInvitesSpace(bobDeps);
  await owner.procedure("com.atproto.space.putRecord", {
    space: personalInboxUri(BOB),
    repo: GROUP,
    collection: ATGRP_COLLECTION.invite,
    rkey: tidNow(net.now()),
    record: {
      $type: ATGRP_COLLECTION.invite,
      group: GROUP,
      message: "Welcome to Desk Parity",
      expiresAt: new Date(net.now() + 3_600_000).toISOString(),
      createdAt: new Date(net.now()).toISOString(),
    },
  });

  const invites = await readIndependentInvites(bobDeps, BOB, net.now());
  assert.equal(invites.length, 1);
  assert.equal(invites[0]!.groupDid, GROUP);

  // Accept direct membership and verify listIndependentWorkspaces + readIndependentWorkspace + channel + private roster
  await acceptDirectMembership(bobDeps, bobStore, { groupDid: GROUP });
  await postChannelMessage(bobDeps, generalUri, { text: "Parity message from Desk shell" });
  await postChannelMessage(bobDeps, vaultUri, { text: "Secret vault note" });

  const workspaces = await listIndependentWorkspaces(bobDeps);
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0]!.uri, wsUri);
  assert.equal(workspaces[0]!.name, "Desk Parity Group");

  const detail = await readIndependentWorkspace(bobDeps, wsUri);
  assert.equal(detail?.channels.length, 2);

  const generalPage = await readIndependentChannelPage(bobDeps, wsUri, "general");
  assert.deepEqual(generalPage.messages.map((m) => m.value.text), ["Parity message from Desk shell"]);

  const vaultRoster = await readIndependentPrivateRoster(bobDeps, wsUri, "vault");
  assert.deepEqual(vaultRoster, [BOB]);
});
