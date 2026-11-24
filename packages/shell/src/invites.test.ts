import assert from "node:assert/strict";
import test from "node:test";
import { AtprotoClient } from "@flock/protocol/atproto/xrpc";
import { personalInvitesUri, SELF_SKEY } from "@flock/protocol/keys";
import { OPENSOCIAL_SPACE_TYPE } from "@flock/protocol/nsids";
import { FakeNetwork } from "@flock/testing/fake-network";
import { ensureInvitesSpace, IncompatibleInvitesSpacePolicyError } from "./invites";

const ALICE = "did:plc:aliceinvitesaaaaaaaaaaaa";
const BOB = "did:plc:bobinvitesaaaaaaaaaaaaaa";

test("ensureInvitesSpace idempotently creates personal invites/self and enforces all 4 R13 invariants", async () => {
  const net = new FakeNetwork();
  net.createAccount(ALICE, "pds1");
  net.createAccount(BOB, "pds2");

  const deps = { did: ALICE, memberClient: net.clientFor(ALICE) };
  const space = await ensureInvitesSpace(deps);
  assert.equal(space, personalInvitesUri(ALICE));

  // Idempotent second call succeeds cleanly
  assert.equal(await ensureInvitesSpace(deps), space);

  // Invariant 1: publicWrite === true
  await deps.memberClient.procedure("com.atproto.space.updateSpace", {
    space,
    policy: { $type: "com.atproto.memberspace.policy", publicRead: false, publicWrite: false },
  });
  await assert.rejects(() => ensureInvitesSpace(deps), IncompatibleInvitesSpacePolicyError);

  // Invariant 2: publicRead === false
  await deps.memberClient.procedure("com.atproto.space.updateSpace", {
    space,
    policy: { $type: "com.atproto.memberspace.policy", publicRead: true, publicWrite: true },
  });
  await assert.rejects(() => ensureInvitesSpace(deps), IncompatibleInvitesSpacePolicyError);

  // Invariant 3: allowedApps === undefined (must reject even empty array `[]`!)
  const mockWithEmptyAllowedApps = new AtprotoClient(async (path) => {
    if (path.startsWith("/xrpc/com.atproto.space.getSpace")) {
      return new Response(
        JSON.stringify({
          uri: space,
          policy: {
            $type: "com.atproto.memberspace.policy",
            publicRead: false,
            publicWrite: true,
            allowedApps: [],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (path.startsWith("/xrpc/com.atproto.memberspace.listMembers")) {
      return new Response(JSON.stringify({ members: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  });
  await assert.rejects(
    () => ensureInvitesSpace({ did: ALICE, memberClient: mockWithEmptyAllowedApps }),
    IncompatibleInvitesSpacePolicyError,
  );

  // Invariant 4: zero explicit members (non-empty listMembers fails closed)
  const mockWithMember = new AtprotoClient(async (path) => {
    if (path.startsWith("/xrpc/com.atproto.space.getSpace")) {
      return new Response(
        JSON.stringify({
          uri: space,
          policy: {
            $type: "com.atproto.memberspace.policy",
            publicRead: false,
            publicWrite: true,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (path.startsWith("/xrpc/com.atproto.memberspace.listMembers")) {
      return new Response(JSON.stringify({ members: [{ did: BOB, read: true, write: true }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  });
  await assert.rejects(
    () => ensureInvitesSpace({ did: ALICE, memberClient: mockWithMember }),
    IncompatibleInvitesSpacePolicyError,
  );

  // Restore valid policy and verify passing again
  await deps.memberClient.procedure("com.atproto.space.updateSpace", {
    space,
    policy: { $type: "com.atproto.memberspace.policy", publicRead: false, publicWrite: true },
  });
  assert.equal(await ensureInvitesSpace(deps), space);
  void OPENSOCIAL_SPACE_TYPE;
  void SELF_SKEY;
});
