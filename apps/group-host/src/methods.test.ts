import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { P256Keypair } from "@atproto/crypto";
import { createServiceJwt } from "@atproto/xrpc-server";
import { groupAdminScopes } from "@flock/protocol/scopes";
import { loadGroupHostConfig } from "./config";
import { startGroupHostServer } from "./server";
import {
  completeGroupOAuthFlow,
  startMockPersonalPds,
  startMockPlcServer,
  startTestGroupHost,
} from "./test-harness";

test("OpenSocial requestJoin 6-case decision table (with & without Idempotency-Key), 200-row quota, invite retry, If-Join-Request-Present, and cursor pagination", async () => {
  const plc = await startMockPlcServer();
  const pds = await startMockPersonalPds(plc);
  const gh = await startTestGroupHost({ plc });

  try {
    const alice = await pds.registerUser("alice.test");
    const bob = await pds.registerUser("bob.test");
    const carol = await pds.registerUser("carol.test");
    const dave = await pds.registerUser("dave.test");
    const bot = await pds.registerUser("bot.test");

    const flow = await completeGroupOAuthFlow({
      groupHost: gh,
      pds,
      user: alice,
      scope: groupAdminScopes().join(" "),
      prompt: "create",
      createParams: {
        displayName: "Join Table Group",
        handle: "join-table.groups.localhost",
        joinPolicy: "invite",
        publicMeta: true,
      },
    });
    const dpop = flow.dpop;
    const token = flow.tokenResponse!.access_token;
    const groupDid = flow.tokenResponse!.sub;
    const aud = `${groupDid}#atproto_pds`;
    const metaSpace = `at:space/${groupDid}/group.opensocial.meta/self`;
    const membersSpace = `at:space/${groupDid}/group.opensocial.members/self`;

    // 0. Guard checks: `iss === groupDid` (`CannotTargetGroupSelf`), `75s` lifetime cap, and `service_jwt_jti` replay!
    const groupSigKey = await gh.repoStore.getGroupSigningKey(groupDid);
    const selfJwt = await createServiceJwt({
      iss: groupDid,
      aud,
      lxm: "group.opensocial.requestJoin",
      keypair: groupSigKey,
    });
    const selfJoinRes = await fetch(`${gh.url}/xrpc/group.opensocial.requestJoin`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${selfJwt}` },
      body: JSON.stringify({ group: groupDid }),
    });
    assert.equal(selfJoinRes.status, 400);
    assert.equal(((await selfJoinRes.json()) as { error: string }).error, "CannotTargetGroupSelf");

    const longExpJwt = await bob.signServiceJwt(aud, "group.opensocial.requestJoin", 120);
    const longExpRes = await fetch(`${gh.url}/xrpc/group.opensocial.requestJoin`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${longExpJwt}` },
      body: JSON.stringify({ group: groupDid }),
    });
    assert.equal(longExpRes.status, 401, ">75s service JWT lifetime must be rejected");

    // Register `bot` in `known_app_subject` -> `requestJoin` unconditionally rejected `400 SubjectIsAppServicePrincipal`!
    gh.db
      .prepare("INSERT INTO known_app_subject (group_did, subject_did, created_at) VALUES (?, ?, ?)")
      .run(groupDid, bot.did, Date.now());
    const botJoinRes = await fetch(`${gh.url}/xrpc/group.opensocial.requestJoin`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await bot.signServiceJwt(aud, "group.opensocial.requestJoin")}`,
      },
      body: JSON.stringify({ group: groupDid }),
    });
    assert.equal(botJoinRes.status, 400);
    assert.equal(((await botJoinRes.json()) as { error: string }).error, "SubjectIsAppServicePrincipal");

    // Case D: `joinPolicy === "invite"` without invite -> `400 JoinClosed` (both headerless & with Idempotency-Key)
    const closedRes = await fetch(`${gh.url}/xrpc/group.opensocial.requestJoin`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await bob.signServiceJwt(aud, "group.opensocial.requestJoin")}`,
        "idempotency-key": "op-closed-1",
      },
      body: JSON.stringify({ group: groupDid }),
    });
    assert.equal(closedRes.status, 400);
    assert.equal(((await closedRes.json()) as { error: string }).error, "JoinClosed");

    // Case B + Invite Delivery Failure -> `retry-invite-delivery` -> Author-Scoped 4-Key Redemption!
    pds.failInviteDeliveryForDid.add(bob.did);
    const bobInvSpace = `at:space/${bob.did}/group.opensocial.invites/self`;
    const invRkey = "3jzfcijpj2z2a";
    const putInvRes = await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.putRecord`, {
      method: "POST",
      accessToken: token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: bobInvSpace,
        repo: groupDid,
        collection: "group.opensocial.invite",
        rkey: invRkey,
        record: {
          $type: "group.opensocial.invite",
          createdBy: alice.did,
          createdAt: new Date().toISOString(),
        },
      }),
    });
    assert.equal(putInvRes.status, 200);
    const bobInviteUri = `${bobInvSpace}/${groupDid}/group.opensocial.invite/${invRkey}`;

    // Drain outbox while failing -> status becomes `pending`/`failed`, then clear failure & call `retry-invite-delivery`!
    for (let i = 0; i < 6; i += 1) {
      gh.db
        .prepare("UPDATE outbox_notice SET next_attempt_at = 0, lease_until = NULL WHERE group_did = ?")
        .run(groupDid);
      await gh.repoStore.flushOutboxNotices();
    }
    const delivList1 = await dpop.fetchWithDpop(
      `${gh.url}/group-admin/invite-deliveries?group=${encodeURIComponent(groupDid)}`,
      { method: "GET", accessToken: token },
    );
    assert.equal(delivList1.status, 200);
    const deliveries1 = ((await delivList1.json()) as { deliveries: Array<{ status: string; inviteUri: string }> }).deliveries;
    assert.equal(deliveries1[0]?.status, "failed");

    pds.failInviteDeliveryForDid.delete(bob.did);
    const retryRes = await dpop.fetchWithDpop(`${gh.url}/group-admin/retry-invite-delivery`, {
      method: "POST",
      accessToken: token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ group: groupDid, inviteUri: bobInviteUri }),
    });
    assert.equal(retryRes.status, 200);
    await gh.repoStore.flushOutboxNotices();

    const delivList2 = await dpop.fetchWithDpop(
      `${gh.url}/group-admin/invite-deliveries?group=${encodeURIComponent(groupDid)}`,
      { method: "GET", accessToken: token },
    );
    const deliveries2 = ((await delivList2.json()) as { deliveries: Array<{ status: string }> }).deliveries;
    assert.equal(deliveries2[0]?.status, "delivered");

    // Carol cannot redeem Bob's invite (`400 InvalidInvite`)!
    const carolStealInvite = await fetch(`${gh.url}/xrpc/group.opensocial.requestJoin`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await carol.signServiceJwt(aud, "group.opensocial.requestJoin")}`,
      },
      body: JSON.stringify({ group: groupDid, invite: bobInviteUri }),
    });
    assert.equal(carolStealInvite.status, 400);
    assert.equal(((await carolStealInvite.json()) as { error: string }).error, "InvalidInvite");

    // Bob redeems his invite WITHOUT `Idempotency-Key` (canonical third-party OpenSocial client!) -> `200 admitted`!
    const bobRedeemRes = await fetch(`${gh.url}/xrpc/group.opensocial.requestJoin`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await bob.signServiceJwt(aud, "group.opensocial.requestJoin")}`,
      },
      body: JSON.stringify({ group: groupDid, invite: bobInviteUri }),
    });
    assert.equal(bobRedeemRes.status, 200);
    const bobRedeemBody = (await bobRedeemRes.json()) as { status: string; membership: { uri: string } };
    assert.equal(bobRedeemBody.status, "admitted");

    // Case A1: Bob is already a member -> calling `requestJoin` with `Idempotency-Key` returns `admitted`, and mismatched params on same key -> `409 IdempotencyParameterMismatch`!
    const bobAgain = await fetch(`${gh.url}/xrpc/group.opensocial.requestJoin`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await bob.signServiceJwt(aud, "group.opensocial.requestJoin")}`,
        "idempotency-key": "op-bob-a1",
      },
      body: JSON.stringify({ group: groupDid }),
    });
    assert.equal(bobAgain.status, 200);

    const bobParamMismatch = await fetch(`${gh.url}/xrpc/group.opensocial.requestJoin`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await bob.signServiceJwt(aud, "group.opensocial.requestJoin")}`,
        "idempotency-key": "op-bob-a1",
      },
      body: JSON.stringify({ group: groupDid, message: "different" }),
    });
    assert.equal(bobParamMismatch.status, 409);
    assert.equal(((await bobParamMismatch.json()) as { error: string }).error, "IdempotencyParameterMismatch");

    // Case F: Unknown `joinPolicy` (`"custom-future-policy"`) fails closed with `400 JoinClosed`!
    await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.putRecord`, {
      method: "POST",
      accessToken: token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: metaSpace,
        repo: groupDid,
        collection: "group.opensocial.profile",
        rkey: "self",
        record: {
          $type: "group.opensocial.profile",
          displayName: "Join Table Group",
          joinPolicy: "custom-future-policy",
          createdAt: new Date().toISOString(),
        },
      }),
    });
    const unknownPolicyRes = await fetch(`${gh.url}/xrpc/group.opensocial.requestJoin`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await carol.signServiceJwt(aud, "group.opensocial.requestJoin")}`,
      },
      body: JSON.stringify({ group: groupDid }),
    });
    assert.equal(unknownPolicyRes.status, 400);
    assert.equal(((await unknownPolicyRes.json()) as { error: string }).error, "JoinClosed");

    // Case E: `joinPolicy === "approval"` -> pending + E2 alias + pagination + `cancelJoinRequest` + `If-Join-Request-Present: true`!
    await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.putRecord`, {
      method: "POST",
      accessToken: token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: metaSpace,
        repo: groupDid,
        collection: "group.opensocial.profile",
        rkey: "self",
        record: {
          $type: "group.opensocial.profile",
          displayName: "Join Table Group",
          joinPolicy: "approval",
          createdAt: new Date().toISOString(),
        },
      }),
    });

    const carolPend1 = await fetch(`${gh.url}/xrpc/group.opensocial.requestJoin`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await carol.signServiceJwt(aud, "group.opensocial.requestJoin")}`,
        "idempotency-key": "op-carol-1",
      },
      body: JSON.stringify({ group: groupDid, message: "Please let me in" }),
    });
    assert.equal(carolPend1.status, 200);
    assert.equal(((await carolPend1.json()) as { status: string }).status, "pending");

    // E2: Second `operationId` from Carol creates an alias without duplicating `join_request`!
    const carolPend2 = await fetch(`${gh.url}/xrpc/group.opensocial.requestJoin`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await carol.signServiceJwt(aud, "group.opensocial.requestJoin")}`,
        "idempotency-key": "op-carol-2",
      },
      body: JSON.stringify({ group: groupDid, message: "Second device" }),
    });
    assert.equal(carolPend2.status, 200);

    const davePend = await fetch(`${gh.url}/xrpc/group.opensocial.requestJoin`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await dave.signServiceJwt(aud, "group.opensocial.requestJoin")}`,
        "idempotency-key": "op-dave-1",
      },
      body: JSON.stringify({ group: groupDid, message: "Dave here" }),
    });
    assert.equal(davePend.status, 200);

    // Deterministic `listJoinRequests` pagination (`limit=1`)
    const page1Res = await dpop.fetchWithDpop(
      `${gh.url}/xrpc/group.opensocial.listJoinRequests?limit=1`,
      { method: "GET", accessToken: token },
    );
    assert.equal(page1Res.status, 200);
    const page1 = (await page1Res.json()) as { requests: Array<{ member: string }>; cursor?: string };
    assert.equal(page1.requests.length, 1);
    assert.equal(page1.requests[0]?.member, carol.did);
    assert.ok(page1.cursor);

    const page2Res = await dpop.fetchWithDpop(
      `${gh.url}/xrpc/group.opensocial.listJoinRequests?limit=1&cursor=${encodeURIComponent(page1.cursor!)}`,
      { method: "GET", accessToken: token },
    );
    const page2 = (await page2Res.json()) as { requests: Array<{ member: string }>; cursor?: string };
    assert.equal(page2.requests.length, 1);
    assert.equal(page2.requests[0]?.member, dave.did);
    assert.equal(page2.cursor, undefined);

    // Dave cancels his join request -> `200`, second cancel -> `400 JoinRequestNotFound`, and late admin `If-Join-Request-Present: true` -> `409 JoinRequestNotFound`!
    const daveCancel1 = await fetch(`${gh.url}/xrpc/group.opensocial.cancelJoinRequest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await dave.signServiceJwt(aud, "group.opensocial.cancelJoinRequest")}`,
      },
      body: JSON.stringify({ group: groupDid }),
    });
    assert.equal(daveCancel1.status, 200);

    const daveCancel2 = await fetch(`${gh.url}/xrpc/group.opensocial.cancelJoinRequest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await dave.signServiceJwt(aud, "group.opensocial.cancelJoinRequest")}`,
      },
      body: JSON.stringify({ group: groupDid }),
    });
    assert.equal(daveCancel2.status, 400);
    assert.equal(((await daveCancel2.json()) as { error: string }).error, "JoinRequestNotFound");

    const lateApproveDave = await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.putRecord`, {
      method: "POST",
      accessToken: token,
      headers: {
        "content-type": "application/json",
        "if-join-request-present": "true",
      },
      body: JSON.stringify({
        space: membersSpace,
        repo: groupDid,
        collection: "group.opensocial.membership",
        rkey: dave.did,
        record: { $type: "group.opensocial.membership", roles: ["member"], createdAt: new Date().toISOString() },
      }),
    });
    assert.equal(lateApproveDave.status, 409);
    assert.equal(((await lateApproveDave.json()) as { error: string }).error, "JoinRequestNotFound");

    // Approve Carol via `If-Join-Request-Present: true` -> atomically admits Carol AND upgrades `op-carol-1` & `op-carol-2` to `admitted`!
    const approveCarol = await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.putRecord`, {
      method: "POST",
      accessToken: token,
      headers: {
        "content-type": "application/json",
        "if-join-request-present": "true",
      },
      body: JSON.stringify({
        space: membersSpace,
        repo: groupDid,
        collection: "group.opensocial.membership",
        rkey: carol.did,
        record: { $type: "group.opensocial.membership", roles: ["member"], createdAt: new Date().toISOString() },
      }),
    });
    assert.equal(approveCarol.status, 200);

    const carolStatusRes = await fetch(
      `${gh.url}/group-member/join-status?group=${encodeURIComponent(groupDid)}&operationId=op-carol-1`,
      {
        headers: {
          authorization: `Bearer ${await carol.signServiceJwt(aud, "group.opensocial.requestJoin")}`,
        },
      },
    );
    assert.equal(carolStatusRes.status, 200);
    const carolStatus = (await carolStatusRes.json()) as { state: string; currentIncarnation?: string };
    assert.equal(carolStatus.state, "admitted");
    assert.ok(carolStatus.currentIncarnation);

    // Non-evicting `200`-row unexpired quota gate -> `429 JoinOperationQuotaExceeded`!
    const insJoinOp = gh.db.prepare(
      `INSERT INTO join_operation_state (
         group_did, requester_did, operation_id, request_hash, state, response_json, expires_at, updated_at
       ) VALUES (?, ?, ?, 'h', 'cancelled', '{}', ?, ?)`,
    );
    const nowMs = Date.now();
    gh.db.transaction(() => {
      for (let i = 0; i < 200; i += 1) {
        insJoinOp.run(groupDid, dave.did, `quota-op-${i}`, nowMs + 86_400_000, nowMs);
      }
    })();

    const quotaRes = await fetch(`${gh.url}/xrpc/group.opensocial.requestJoin`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await dave.signServiceJwt(aud, "group.opensocial.requestJoin")}`,
        "idempotency-key": "op-dave-over-quota",
      },
      body: JSON.stringify({ group: groupDid }),
    });
    assert.equal(quotaRes.status, 429);
    assert.equal(((await quotaRes.json()) as { error: string }).error, "JoinOperationQuotaExceeded");
  } finally {
    await gh.close();
    await pds.close();
    await plc.close();
  }
});

test("leaveGroup If-Match-Membership-Incarnation, Flock sole-member reversible deactivation vs non-Flock sovereign continuation, and moderation queue/history", async () => {
  const plc = await startMockPlcServer();
  const pds = await startMockPersonalPds(plc);
  const gh = await startTestGroupHost({ plc });

  try {
    const alice = await pds.registerUser("alice.test");
    const bob = await pds.registerUser("bob.test");
    const carol = await pds.registerUser("carol.test");

    // 1. Create a Flock workspace (`new.flock.workspace/self` present) + test `createReport` (`groupDid` account, writer record vs non-writer member!)
    const flockFlow = await completeGroupOAuthFlow({
      groupHost: gh,
      pds,
      user: alice,
      scope: groupAdminScopes().join(" "),
      prompt: "create",
      createParams: {
        displayName: "Flock Mod & Leave",
        handle: "flock-leave.groups.localhost",
        joinPolicy: "open",
        publicMeta: true,
      },
    });
    const dpop = flockFlow.dpop;
    const token = flockFlow.tokenResponse!.access_token;
    const groupDid = flockFlow.tokenResponse!.sub;
    const aud = `${groupDid}#atproto_pds`;
    const wsSpace = `at:space/${groupDid}/new.flock.workspace/self`;
    const chanSpace = `at:space/${groupDid}/new.flock.channel/general`;

    await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.createSpace`, {
      method: "POST",
      accessToken: token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        spaceType: "new.flock.workspace",
        skey: "self",
        policy: { $type: "group.opensocial.policy", publicRead: false, grants: [{ role: "member", read: true, write: false }] },
      }),
    });
    await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.putRecord`, {
      method: "POST",
      accessToken: token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: wsSpace,
        repo: groupDid,
        collection: "new.flock.workspace",
        rkey: "self",
        record: { $type: "new.flock.workspace", name: "Flock WS", createdAt: new Date().toISOString() },
      }),
    });
    await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.createSpace`, {
      method: "POST",
      accessToken: token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        spaceType: "new.flock.channel",
        skey: "general",
        policy: { $type: "group.opensocial.policy", publicRead: false, grants: [{ role: "member", read: true, write: true }] },
      }),
    });

    // Admit Bob & Carol via open `requestJoin`
    for (const u of [bob, carol]) {
      const r = await fetch(`${gh.url}/xrpc/group.opensocial.requestJoin`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await u.signServiceJwt(aud, "group.opensocial.requestJoin")}`,
        },
        body: JSON.stringify({ group: groupDid }),
      });
      assert.equal(r.status, 200);
    }

    // Bob notifies a commit on `chanSpace` (`space_writer` exists for Bob, NOT for Carol!)
    const notifyBob = await fetch(`${gh.url}/xrpc/com.atproto.space.notifyRepoUpdate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await bob.signServiceJwt(aud, "com.atproto.space.notifyRepoUpdate")}`,
      },
      body: JSON.stringify({
        space: chanSpace,
        repo: bob.did,
        repoRev: "3jzfcijpj2z2a",
        data: { $bytes: Buffer.alloc(32).toString("base64") },
      }),
    });
    assert.equal(notifyBob.status, 200);

    // Moderation:
    // (a) Implicit `subject === groupDid` account report succeeds (`200`)!
    const repGroupSelf = await fetch(`${gh.url}/xrpc/group.opensocial.createReport`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await bob.signServiceJwt(aud, "group.opensocial.createReport")}`,
      },
      body: JSON.stringify({
        group: groupDid,
        subject: groupDid,
        reasonType: "other",
        reason: "Reporting group metadata",
      }),
    });
    assert.equal(repGroupSelf.status, 200);

    // (b) Member-authored record in `chanSpace` by writer `bob` succeeds (`200`), whereas non-writer member `carol` is rejected (`400 InvalidSubject`)!
    const bobMsgUri = `${chanSpace}/${bob.did}/new.flock.message/3jzfcijpj2z2a`;
    const carolFakeMsgUri = `${chanSpace}/${carol.did}/new.flock.message/3jzfcijpj2z2a`;

    const repBobMsg = await fetch(`${gh.url}/xrpc/group.opensocial.createReport`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await alice.signServiceJwt(aud, "group.opensocial.createReport")}`,
      },
      body: JSON.stringify({
        group: groupDid,
        subject: bobMsgUri,
        reasonType: "spam",
      }),
    });
    assert.equal(repBobMsg.status, 200);

    const repCarolMsg = await fetch(`${gh.url}/xrpc/group.opensocial.createReport`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await alice.signServiceJwt(aud, "group.opensocial.createReport")}`,
      },
      body: JSON.stringify({
        group: groupDid,
        subject: carolFakeMsgUri,
        reasonType: "spam",
      }),
    });
    assert.equal(repCarolMsg.status, 400);
    assert.equal(((await repCarolMsg.json()) as { error: string }).error, "InvalidSubject");

    // `resolveModSubject` + `listModSubjects` + `getModSubjectHistory` pagination
    const resolveRes = await dpop.fetchWithDpop(`${gh.url}/xrpc/group.opensocial.resolveModSubject`, {
      method: "POST",
      accessToken: token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        subject: bobMsgUri,
        status: "resolved",
        note: "Reviewed",
      }),
    });
    assert.equal(resolveRes.status, 200);

    const hist1Res = await dpop.fetchWithDpop(
      `${gh.url}/xrpc/group.opensocial.getModSubjectHistory?subject=${encodeURIComponent(bobMsgUri)}&limit=1`,
      { method: "GET", accessToken: token },
    );
    assert.equal(hist1Res.status, 200);
    const hist1 = (await hist1Res.json()) as { events: Array<{ id: string }>; cursor?: string };
    assert.equal(hist1.events.length, 1);
    assert.ok(hist1.cursor);

    const hist2Res = await dpop.fetchWithDpop(
      `${gh.url}/xrpc/group.opensocial.getModSubjectHistory?subject=${encodeURIComponent(bobMsgUri)}&limit=1&cursor=${encodeURIComponent(hist1.cursor!)}`,
      { method: "GET", accessToken: token },
    );
    const hist2 = (await hist2Res.json()) as { events: Array<{ id: string }>; cursor?: string };
    assert.equal(hist2.events.length, 1);
    assert.equal(hist2.cursor, undefined);

    // 2. `leaveGroup` with wrong `If-Match-Membership-Incarnation` -> `409 MembershipIncarnationMismatch`!
    const badIncLeave = await fetch(`${gh.url}/xrpc/group.opensocial.leaveGroup`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await bob.signServiceJwt(aud, "group.opensocial.leaveGroup")}`,
        "if-match-membership-incarnation": "stale-incarnation-id",
      },
      body: JSON.stringify({ group: groupDid }),
    });
    assert.equal(badIncLeave.status, 409);
    assert.equal(((await badIncLeave.json()) as { error: string }).error, "MembershipIncarnationMismatch");

    // Bob and Carol leave cleanly
    for (const u of [bob, carol]) {
      const lv = await fetch(`${gh.url}/xrpc/group.opensocial.leaveGroup`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await u.signServiceJwt(aud, "group.opensocial.leaveGroup")}`,
        },
        body: JSON.stringify({ group: groupDid }),
      });
      assert.equal(lv.status, 200);
    }

    // Sole-member Alice leaves Flock workspace -> reversible deactivation (`activated = 0`, `left_deactivated`, idempotent replay `200`)!
    const aliceLeave1 = await fetch(`${gh.url}/xrpc/group.opensocial.leaveGroup`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await alice.signServiceJwt(aud, "group.opensocial.leaveGroup")}`,
      },
      body: JSON.stringify({ group: groupDid }),
    });
    assert.equal(aliceLeave1.status, 200);

    const aliceLeaveReplay = await fetch(`${gh.url}/xrpc/group.opensocial.leaveGroup`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await alice.signServiceJwt(aud, "group.opensocial.leaveGroup")}`,
      },
      body: JSON.stringify({ group: groupDid }),
    });
    assert.equal(aliceLeaveReplay.status, 200);

    const aliceJoinStatus = await fetch(
      `${gh.url}/group-member/join-status?group=${encodeURIComponent(groupDid)}`,
      {
        headers: {
          authorization: `Bearer ${await alice.signServiceJwt(aud, "group.opensocial.requestJoin")}`,
        },
      },
    );
    assert.equal(aliceJoinStatus.status, 200);
    assert.equal(((await aliceJoinStatus.json()) as { state: string }).state, "left_deactivated");

    // 3. Non-Flock OpenSocial group (`new.flock.workspace/self` absent):
    //    - Sole-member `leaveGroup` WITHOUT external sovereign PLC rotation key -> `400 NoSovereignCustodyKey`!
    //    - Sole-member `leaveGroup` WITH external sovereign PLC rotation key -> `200 OK` AND stays `activated = 1` with 0 human members!
    const nonFlockFlow = await completeGroupOAuthFlow({
      groupHost: gh,
      pds,
      user: alice,
      scope: groupAdminScopes().join(" "),
      prompt: "create",
      createParams: {
        displayName: "Sovereign Non-Flock Group",
        handle: "sovereign-nf.groups.localhost",
        joinPolicy: "invite",
        publicMeta: true,
      },
    });
    const nfDpop = nonFlockFlow.dpop;
    const nfTok = nonFlockFlow.tokenResponse!.access_token;
    const nfDid = nonFlockFlow.tokenResponse!.sub;
    const nfAud = `${nfDid}#atproto_pds`;

    const nfNoSovLeave = await fetch(`${gh.url}/xrpc/group.opensocial.leaveGroup`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await alice.signServiceJwt(nfAud, "group.opensocial.leaveGroup")}`,
      },
      body: JSON.stringify({ group: nfDid }),
    });
    assert.equal(nfNoSovLeave.status, 400);
    assert.equal(((await nfNoSovLeave.json()) as { error: string }).error, "NoSovereignCustodyKey");

    // Round 15 Fix #2: General space writes (`deleteRecord` / `applyWrites`) removing the last human member on a non-Flock group
    // MUST also enforce `isSupportedPlcRotationDidKey(k)` so malformed/unsupported non-local PLC rotation keys fail closed (`400 NoSovereignCustodyKey`)!
    const nfOrigOps = [...(plc.opsByDid.get(nfDid) ?? [])];
    const nfLastOrig = nfOrigOps[nfOrigOps.length - 1]!;
    if (nfLastOrig.type === "plc_operation") {
      plc.opsByDid.set(nfDid, [
        ...nfOrigOps.slice(0, -1),
        {
          ...nfLastOrig,
          rotationKeys: [...nfLastOrig.rotationKeys, "did:key:zUnsupportedNonRotationKey123"],
        },
      ]);
    }
    const nfUnsupportedBulkDel = await nfDpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.deleteRecord`, {
      method: "POST",
      accessToken: nfTok,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: `at:space/${nfDid}/group.opensocial.members/self`,
        repo: nfDid,
        collection: "group.opensocial.membership",
        rkey: alice.did,
      }),
    });
    assert.equal(nfUnsupportedBulkDel.status, 400);
    assert.equal(((await nfUnsupportedBulkDel.json()) as { error: string }).error, "NoSovereignCustodyKey");
    plc.opsByDid.set(nfDid, nfOrigOps);

    // Round 21 Fix #1: Missing or corrupt `rotation_key_enc` MUST fail closed (`400 NoSovereignCustodyKey` on both
    // `leaveGroup` and `deleteRecord(membership)`) rather than mistaking the host's local PLC rotation key for external!
    const origRotEncRow = gh.db
      .prepare("SELECT rotation_key_enc FROM group_account WHERE did = ?")
      .get(nfDid) as { rotation_key_enc: string };
    for (const badRotEnc of [null, "v1:corrupt:ciphertext"] as const) {
      gh.db.prepare("UPDATE group_account SET rotation_key_enc = ? WHERE did = ?").run(badRotEnc, nfDid);

      const corruptLeaveRes = await fetch(`${gh.url}/xrpc/group.opensocial.leaveGroup`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await alice.signServiceJwt(nfAud, "group.opensocial.leaveGroup")}`,
        },
        body: JSON.stringify({ group: nfDid }),
      });
      assert.equal(corruptLeaveRes.status, 400);
      assert.equal(((await corruptLeaveRes.json()) as { error: string }).error, "NoSovereignCustodyKey");

      const corruptDelRes = await nfDpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.deleteRecord`, {
        method: "POST",
        accessToken: nfTok,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          space: `at:space/${nfDid}/group.opensocial.members/self`,
          repo: nfDid,
          collection: "group.opensocial.membership",
          rkey: alice.did,
        }),
      });
      assert.equal(corruptDelRes.status, 400);
      assert.equal(((await corruptDelRes.json()) as { error: string }).error, "NoSovereignCustodyKey");
    }
    gh.db.prepare("UPDATE group_account SET rotation_key_enc = ? WHERE did = ?").run(origRotEncRow.rotation_key_enc, nfDid);

    // Add external sovereign PLC rotation key to `nfDid` (requires explicit `prompt=login` step-up!)
    const nfStepUp = await completeGroupOAuthFlow({
      groupHost: gh,
      pds,
      user: alice,
      scope: groupAdminScopes().join(" "),
      prompt: "login",
      loginHint: nfDid,
    });
    const nfStepDpop = nfStepUp.dpop;
    const nfStepTok = nfStepUp.tokenResponse!.access_token;
    const sovKey = await P256Keypair.create({ exportable: true });
    await nfStepDpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.identity.requestPlcOperationSignature`, {
      method: "POST",
      accessToken: nfStepTok,
    });
    const nfClaim = await nfStepDpop.fetchWithDpop(`${gh.url}/group-admin/claim-action-token`, {
      method: "POST",
      accessToken: nfStepTok,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ group: nfDid, purpose: "plc_operation" }),
    });
    const nfPlcToken = ((await nfClaim.json()) as { token: string }).token;
    const nfLastPlc = (await (await fetch(`${plc.url}/${encodeURIComponent(nfDid)}/log/last`)).json()) as { rotationKeys: string[] };
    const nfSigned = await nfStepDpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.identity.signPlcOperation`, {
      method: "POST",
      accessToken: nfStepTok,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: nfPlcToken, rotationKeys: [...nfLastPlc.rotationKeys, sovKey.did()] }),
    });
    const { operation: nfPlcOp } = (await nfSigned.json()) as { operation: Record<string, unknown> };
    await nfStepDpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.identity.submitPlcOperation`, {
      method: "POST",
      accessToken: nfStepTok,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: nfPlcOp }),
    });

    // Now sole-member `leaveGroup` succeeds AND keeps `nfDid` `activated = 1`!
    const nfLeaveOk = await fetch(`${gh.url}/xrpc/group.opensocial.leaveGroup`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await alice.signServiceJwt(nfAud, "group.opensocial.leaveGroup")}`,
      },
      body: JSON.stringify({ group: nfDid }),
    });
    assert.equal(nfLeaveOk.status, 200);
    const nfRow = gh.db.prepare("SELECT activated FROM group_account WHERE did = ?").get(nfDid) as { activated: number };
    assert.equal(nfRow.activated, 1, "Non-Flock sovereign group must stay activated=1 on sole-member leave");

    void randomUUID;
  } finally {
    await gh.close();
    await pds.close();
    await plc.close();
  }
});

test("OpenSocial XRPC enforces strict Lexicon parameter/body bounds and GroupHost supports GROUP_HOST_PORT + IPv6 [::1] / 0.0.0.0 bind", async () => {
  const plc = await startMockPlcServer();
  const pds = await startMockPersonalPds(plc);
  const gh = await startTestGroupHost({ plc });

  try {
    const alice = await pds.registerUser("alice-lex.test");
    const bob = await pds.registerUser("bob-lex.test");

    const flow = await completeGroupOAuthFlow({
      groupHost: gh,
      pds,
      user: alice,
      scope: groupAdminScopes().join(" "),
      prompt: "create",
      createParams: { displayName: "Lexicon Bounds", handle: "lex-bounds.groups.localhost", joinPolicy: "approval" },
    });
    const dpop = flow.dpop;
    const token = flow.tokenResponse!.access_token;
    const groupDid = flow.tokenResponse!.sub;
    const aud = `${groupDid}#atproto_pds`;

    // 1. Strict `limit` bounds (`1..100`) & query parameter validation on `listJoinRequests`, `listModSubjects`, `getModSubjectHistory`
    for (const badLimit of ["0", "101", "-5", "10abc"]) {
      const r1 = await dpop.fetchWithDpop(
        `${gh.url}/xrpc/group.opensocial.listJoinRequests?limit=${encodeURIComponent(badLimit)}`,
        { method: "GET", accessToken: token },
      );
      assert.equal(r1.status, 400, `listJoinRequests must reject limit=${badLimit}`);
      assert.equal(((await r1.json()) as { error: string }).error, "InvalidRequest");

      const r2 = await dpop.fetchWithDpop(
        `${gh.url}/xrpc/group.opensocial.listModSubjects?limit=${encodeURIComponent(badLimit)}`,
        { method: "GET", accessToken: token },
      );
      assert.equal(r2.status, 400, `listModSubjects must reject limit=${badLimit}`);

      const r3 = await dpop.fetchWithDpop(
        `${gh.url}/xrpc/group.opensocial.getModSubjectHistory?subject=${encodeURIComponent(alice.did)}&limit=${encodeURIComponent(badLimit)}`,
        { method: "GET", accessToken: token },
      );
      assert.equal(r3.status, 400, `getModSubjectHistory must reject limit=${badLimit}`);
    }

    // 2. `requestJoin` enforces string types and `maxLength: 20000` / `maxGraphemes: 2000` on `message`
    for (const badBody of [
      { group: groupDid, message: 12345 },
      { group: groupDid, message: "a".repeat(20_001) },
      { group: groupDid, message: "x".repeat(2_001) },
    ]) {
      const res = await fetch(`${gh.url}/xrpc/group.opensocial.requestJoin`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await bob.signServiceJwt(aud, "group.opensocial.requestJoin")}`,
        },
        body: JSON.stringify(badBody),
      });
      assert.equal(res.status, 400);
      assert.equal(((await res.json()) as { error: string }).error, "InvalidRequest");
    }

    // 3. `createReport` & `resolveModSubject` enforce string types and `maxLength`/`maxGraphemes` on `reason` / `note`
    for (const badReport of [
      { group: groupDid, subject: groupDid, reasonType: "spam", reason: 999 },
      { group: groupDid, subject: groupDid, reasonType: "spam", reason: "r".repeat(2_001) },
    ]) {
      const res = await fetch(`${gh.url}/xrpc/group.opensocial.createReport`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await alice.signServiceJwt(aud, "group.opensocial.createReport")}`,
        },
        body: JSON.stringify(badReport),
      });
      assert.equal(res.status, 400);
      assert.equal(((await res.json()) as { error: string }).error, "InvalidRequest");
    }

    for (const badResolve of [
      { subject: groupDid, status: "resolved", note: false },
      { subject: groupDid, status: "resolved", note: "n".repeat(2_001) },
    ]) {
      const res = await dpop.fetchWithDpop(`${gh.url}/xrpc/group.opensocial.resolveModSubject`, {
        method: "POST",
        accessToken: token,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(badResolve),
      });
      assert.equal(res.status, 400);
      assert.equal(((await res.json()) as { error: string }).error, "InvalidRequest");
    }

    // 4. `GROUP_HOST_PORT` env override + `PLC_URL` / loopback predicate hygiene + IPv6 `[::1]` port 0 URL rewrite + non-loopback `https:` `0.0.0.0` bind
    const prevPortEnv = process.env.GROUP_HOST_PORT;
    const prevUrlEnv = process.env.GROUP_HOST_URL;
    const prevKeyEnv = process.env.GROUP_HOST_ENCRYPTION_KEY;
    const prevPlcEnv = process.env.PLC_URL;
    const hexKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    try {
      process.env.GROUP_HOST_URL = "https://groups.example.com";
      process.env.GROUP_HOST_PORT = "4321";
      process.env.GROUP_HOST_ENCRYPTION_KEY = hexKey;
      delete process.env.PLC_URL;
      const cfg = loadGroupHostConfig({ allowLoopback: false });
      assert.equal(cfg.port, 4321);
      assert.equal(cfg.publicUrl, "https://groups.example.com", "GROUP_HOST_PORT must keep publicUrl clean");
      assert.equal(cfg.plcUrl, "https://plc.directory", "Production config must default PLC_URL to https://plc.directory, never loopback HTTP");

      // `*.localhost` must NOT pass Group Host loopback check (matches `@flock/deployment/config`)
      assert.throws(
        () => loadGroupHostConfig({ publicUrl: "http://groups.localhost:3004", allowLoopback: true }),
        /Plain HTTP GROUP_HOST_URL is allowed only for loopback development/,
      );

      // `PLC_URL` origin & HTTPS validation
      for (const badPlc of [
        "http://127.0.0.1:2582",
        "http://plc.directory",
        "https://user:pw@plc.directory",
        "https://plc.directory/subpath",
        "https://plc.directory?q=1",
        "https://plc.directory#frag",
      ]) {
        assert.throws(() => loadGroupHostConfig({ allowLoopback: false, plcUrl: badPlc }));
      }
      assert.throws(
        () => loadGroupHostConfig({ allowLoopback: true, plcUrl: "http://plc.directory" }),
        /Plain HTTP PLC_URL is allowed only for loopback development/,
      );

      process.env.GROUP_HOST_PORT = "70000";
      assert.throws(() => loadGroupHostConfig(), /Invalid GROUP_HOST_PORT/);
    } finally {
      if (prevPortEnv === undefined) delete process.env.GROUP_HOST_PORT;
      else process.env.GROUP_HOST_PORT = prevPortEnv;
      if (prevUrlEnv === undefined) delete process.env.GROUP_HOST_URL;
      else process.env.GROUP_HOST_URL = prevUrlEnv;
      if (prevKeyEnv === undefined) delete process.env.GROUP_HOST_ENCRYPTION_KEY;
      else process.env.GROUP_HOST_ENCRYPTION_KEY = prevKeyEnv;
      if (prevPlcEnv === undefined) delete process.env.PLC_URL;
      else process.env.PLC_URL = prevPlcEnv;
    }

    const gh6 = await startGroupHostServer({
      port: 0,
      publicUrl: "http://[::1]",
      allowLoopback: true,
      plcUrl: plc.url,
      databasePath: ":memory:",
      encryptionKeyHex: hexKey,
      handleDomain: "v6.groups.localhost",
    });
    try {
      const addr6 = gh6.server.address() as AddressInfo;
      assert.equal(addr6.address, "::1");
      assert.equal(gh6.url, `http://[::1]:${gh6.port}`);
      const didRes6 = await fetch(`${gh6.url}/.well-known/did.json`);
      assert.equal(didRes6.status, 200);
    } finally {
      await gh6.close();
    }

    const ghHttps = await startGroupHostServer({
      port: 0,
      publicUrl: "https://groups.example.com",
      allowLoopback: false,
      plcUrl: "https://plc.directory",
      databasePath: ":memory:",
      encryptionKeyHex: hexKey,
      handleDomain: "groups.example.com",
    });
    try {
      const addrHttps = ghHttps.server.address() as AddressInfo;
      assert.equal(addrHttps.address, "0.0.0.0");
      assert.equal(ghHttps.config.publicUrl, "https://groups.example.com");
      assert.equal(ghHttps.config.plcUrl, "https://plc.directory");
      assert.ok(ghHttps.port > 0);
    } finally {
      await ghHttps.close();
    }
  } finally {
    await gh.close();
    await pds.close();
    await plc.close();
  }
});

test("Round 9 hardening: verifyPersonalServiceJwt strictly resolves live PLC #atproto key and rejects staged or retired co-hosted group keys", async () => {
  const plc = await startMockPlcServer();
  const pds = await startMockPersonalPds(plc);
  const gh1 = await startTestGroupHost({ plc, overrides: { handleDomain: "h1.groups.localhost" } });
  const gh2 = await startTestGroupHost({ plc, overrides: { handleDomain: "h2.groups.localhost" } });

  try {
    const alice = await pds.registerUser("alice.test");

    // Create `group1` on `gh1`, `siblingOnGh2` on `gh2`, and `siblingOnGh1` on `gh1` (all `joinPolicy: "open"`)
    const flow1 = await completeGroupOAuthFlow({
      groupHost: gh1,
      pds,
      user: alice,
      scope: groupAdminScopes().join(" "),
      prompt: "create",
      createParams: {
        displayName: "Migrating Group",
        handle: "mig.h1.groups.localhost",
        joinPolicy: "open",
        publicMeta: true,
      },
    });
    const dpop1 = flow1.dpop;
    const tok1 = flow1.tokenResponse!.access_token;
    const group1Did = flow1.tokenResponse!.sub;
    const group1SourceSigningKey = await gh1.repoStore.getGroupSigningKey(group1Did);

    const flowSib2 = await completeGroupOAuthFlow({
      groupHost: gh2,
      pds,
      user: alice,
      scope: groupAdminScopes().join(" "),
      prompt: "create",
      createParams: {
        displayName: "Sibling Group On GH2",
        handle: "sib2.h2.groups.localhost",
        joinPolicy: "open",
        publicMeta: true,
      },
    });
    const siblingOnGh2Did = flowSib2.tokenResponse!.sub;

    const flowSib1 = await completeGroupOAuthFlow({
      groupHost: gh1,
      pds,
      user: alice,
      scope: groupAdminScopes().join(" "),
      prompt: "create",
      createParams: {
        displayName: "Sibling Group On GH1",
        handle: "sib1.h1.groups.localhost",
        joinPolicy: "open",
        publicMeta: true,
      },
    });
    const siblingOnGh1Did = flowSib1.tokenResponse!.sub;

    // 1. Stage `group1` onto `gh2` (`activated = 0` on `gh2`, pre-PLC cutover!)
    const createJwt = await createServiceJwt({
      iss: group1Did,
      aud: gh2.config.serviceDid,
      lxm: "com.atproto.server.createAccount",
      keypair: group1SourceSigningKey,
    });
    const stageRes = await fetch(`${gh2.url}/xrpc/com.atproto.server.createAccount`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${createJwt}`,
      },
      body: JSON.stringify({ did: group1Did, handle: "mig.h2.groups.localhost" }),
    });
    assert.equal(stageRes.status, 200);
    const stagedToks = (await stageRes.json()) as { accessJwt: string };
    const group1StagedTargetSigningKey = await gh2.repoStore.getGroupSigningKey(group1Did);
    assert.notEqual(
      group1StagedTargetSigningKey.did(),
      group1SourceSigningKey.did(),
      "Target staging key must differ from live source PLC #atproto key",
    );

    // Pre-cutover impersonation attempt: `gh2`'s local staged (`activated = 0`) key for `group1Did` MUST be rejected
    // with `401 InvalidSignature` when calling `siblingOnGh2Did`'s personal `requestJoin` endpoint on `gh2`!
    const forgedStagedJwt = await createServiceJwt({
      iss: group1Did,
      aud: `${siblingOnGh2Did}#atproto_pds`,
      lxm: "group.opensocial.requestJoin",
      keypair: group1StagedTargetSigningKey,
    });
    const forgedStagedRes = await fetch(`${gh2.url}/xrpc/group.opensocial.requestJoin`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${forgedStagedJwt}` },
      body: JSON.stringify({ group: siblingOnGh2Did }),
    });
    assert.equal(forgedStagedRes.status, 401, "Staged un-cutover group key must be rejected with 401 InvalidSignature");
    assert.equal(((await forgedStagedRes.json()) as { error: string }).error, "InvalidSignature");

    // Meanwhile, `group1Did`'s LIVE PLC `#atproto` key (`group1SourceSigningKey`) is accepted on `gh2`!
    const livePreCutoverJwt = await createServiceJwt({
      iss: group1Did,
      aud: `${siblingOnGh2Did}#atproto_pds`,
      lxm: "group.opensocial.requestJoin",
      keypair: group1SourceSigningKey,
    });
    const livePreCutoverRes = await fetch(`${gh2.url}/xrpc/group.opensocial.requestJoin`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${livePreCutoverJwt}` },
      body: JSON.stringify({ group: siblingOnGh2Did }),
    });
    assert.equal(livePreCutoverRes.status, 200, "Live PLC #atproto key must succeed pre-cutover");

    // 2. Complete migration & PLC cutover of `group1` from `gh1` -> `gh2`, deactivating `group1` on `gh1`!
    const carBytes = new Uint8Array(
      await (await fetch(`${gh1.url}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(group1Did)}`)).arrayBuffer(),
    );
    assert.equal(
      (
        await fetch(`${gh2.url}/xrpc/com.atproto.repo.importRepo`, {
          method: "POST",
          headers: { "content-type": "application/vnd.ipld.car", authorization: `Bearer ${stagedToks.accessJwt}` },
          body: carBytes,
        })
      ).status,
      200,
    );
    for (const spUri of [
      `at:space/${group1Did}/group.opensocial.meta/self`,
      `at:space/${group1Did}/group.opensocial.members/self`,
    ]) {
      const metaStar = new Uint8Array(
        await (
          await dpop1.fetchWithDpop(
            `${gh1.url}/xrpc/com.atproto.space.exportSpaceMeta?space=${encodeURIComponent(spUri)}`,
            { method: "GET", accessToken: tok1 },
          )
        ).arrayBuffer(),
      );
      assert.equal(
        (
          await fetch(`${gh2.url}/xrpc/com.atproto.space.importSpaceMeta`, {
            method: "POST",
            headers: { "content-type": "application/vnd.dasl.star", authorization: `Bearer ${stagedToks.accessJwt}` },
            body: metaStar,
          })
        ).status,
        200,
      );
      const repoStar = new Uint8Array(
        await (
          await dpop1.fetchWithDpop(
            `${gh1.url}/xrpc/com.atproto.space.getRepo?space=${encodeURIComponent(spUri)}&repo=${encodeURIComponent(group1Did)}`,
            { method: "GET", accessToken: tok1 },
          )
        ).arrayBuffer(),
      );
      assert.equal(
        (
          await fetch(`${gh2.url}/xrpc/com.atproto.space.importRepo`, {
            method: "POST",
            headers: { "content-type": "application/vnd.dasl.star", authorization: `Bearer ${stagedToks.accessJwt}` },
            body: repoStar,
          })
        ).status,
        200,
      );
    }

    const recCreds = (await (
      await fetch(`${gh2.url}/xrpc/com.atproto.identity.getRecommendedDidCredentials`, {
        headers: { authorization: `Bearer ${stagedToks.accessJwt}` },
      })
    ).json()) as Record<string, unknown>;
    const stepUp1 = await completeGroupOAuthFlow({
      groupHost: gh1,
      pds,
      user: alice,
      scope: groupAdminScopes().join(" "),
      prompt: "login",
      loginHint: group1Did,
    });
    const stepDpop1 = stepUp1.dpop;
    const stepTok1 = stepUp1.tokenResponse!.access_token;
    await stepDpop1.fetchWithDpop(`${gh1.url}/xrpc/com.atproto.identity.requestPlcOperationSignature`, {
      method: "POST",
      accessToken: stepTok1,
    });
    const plcClaim = (await (
      await stepDpop1.fetchWithDpop(`${gh1.url}/group-admin/claim-action-token`, {
        method: "POST",
        accessToken: stepTok1,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ group: group1Did, purpose: "plc_operation" }),
      })
    ).json()) as { token: string };
    const signedPlc = (await (
      await stepDpop1.fetchWithDpop(`${gh1.url}/xrpc/com.atproto.identity.signPlcOperation`, {
        method: "POST",
        accessToken: stepTok1,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: plcClaim.token, ...recCreds }),
      })
    ).json()) as { operation: Record<string, unknown> };
    assert.equal(
      (
        await fetch(`${gh2.url}/xrpc/com.atproto.identity.submitPlcOperation`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${stagedToks.accessJwt}` },
          body: JSON.stringify({ operation: signedPlc.operation }),
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(`${gh2.url}/xrpc/com.atproto.server.activateAccount`, {
          method: "POST",
          headers: { authorization: `Bearer ${stagedToks.accessJwt}` },
        })
      ).status,
      200,
    );
    await gh2.flushBackgroundWork();
    assert.equal(
      (gh1.db.prepare("SELECT activated FROM group_account WHERE did = ?").get(group1Did) as { activated: number })
        .activated,
      0,
      "Retired source group_account must be deactivated (activated = 0) on gh1",
    );

    // Post-cutover impersonation attempt: `gh1`'s RETIRED (`activated = 0`) `signing_key_enc` for `group1Did` MUST be
    // rejected with `401 InvalidSignature` when calling `siblingOnGh1Did`'s personal `requestJoin` endpoint on `gh1`!
    const forgedRetiredJwt = await createServiceJwt({
      iss: group1Did,
      aud: `${siblingOnGh1Did}#atproto_pds`,
      lxm: "group.opensocial.requestJoin",
      keypair: group1SourceSigningKey,
    });
    const forgedRetiredRes = await fetch(`${gh1.url}/xrpc/group.opensocial.requestJoin`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${forgedRetiredJwt}` },
      body: JSON.stringify({ group: siblingOnGh1Did }),
    });
    assert.equal(forgedRetiredRes.status, 401, "Retired migrated-away source key must be rejected with 401 InvalidSignature");
    assert.equal(((await forgedRetiredRes.json()) as { error: string }).error, "InvalidSignature");

    // Meanwhile, `group1Did`'s new cut-over LIVE PLC `#atproto` key (`group1StagedTargetSigningKey`) succeeds on `gh1`!
    const livePostCutoverJwt = await createServiceJwt({
      iss: group1Did,
      aud: `${siblingOnGh1Did}#atproto_pds`,
      lxm: "group.opensocial.requestJoin",
      keypair: group1StagedTargetSigningKey,
    });
    const livePostCutoverRes = await fetch(`${gh1.url}/xrpc/group.opensocial.requestJoin`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${livePostCutoverJwt}` },
      body: JSON.stringify({ group: siblingOnGh1Did }),
    });
    assert.equal(livePostCutoverRes.status, 200, "New live cut-over PLC #atproto key must succeed on gh1");
  } finally {
    await gh2.close();
    await gh1.close();
    await pds.close();
    await plc.close();
  }
});
