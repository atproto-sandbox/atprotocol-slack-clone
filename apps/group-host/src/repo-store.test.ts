import assert from "node:assert/strict";
import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { P256Keypair } from "@atproto/crypto";
import { parseCid } from "@atproto/lex-data";
import {
  COMMIT_MAC_PROFILE,
  createDelegationToken,
  createSpaceSigHeaders,
  encapsulate,
  formatMacRequest,
  RECORD_MAC_PROFILE,
  RepoCommit,
  serializeRecord,
  spaceHostAud,
  verifyCommitMac,
  verifyRecordMac,
  writeRepoStar,
} from "@atproto/space";
import { jsonToLex } from "@atproto/lexicon";
import type { LexMap } from "@atproto/lex-data";
import { ScopePermissions } from "@atproto/oauth-scopes";
import type { AtUriString, DidString, NsidString, RecordKeyString, SpaceRefString } from "@atproto/syntax";
import { createServiceJwt } from "@atproto/xrpc-server";
import { expandGroupScopes, groupAdminScopes } from "@flock/protocol/scopes";
import { SCHEMA_TABLE_CLASSIFICATION } from "./db";
import { isPermissionSubset } from "./rbac";
import {
  completeGroupOAuthFlow,
  startMockPersonalPds,
  startMockPlcServer,
  startTestGroupHost,
} from "./test-harness";

test("GroupRepoStore enforces public CAR/CAS, space auto-indexing, 129..512 skey bounds, RBAC anti-escalation, label & TID checks, and keep-safe clearRecords", async () => {
  const plc = await startMockPlcServer();
  const pds = await startMockPersonalPds(plc);
  const gh = await startTestGroupHost({ plc });

  try {
    const alice = await pds.registerUser("alice.test");
    const bob = await pds.registerUser("bob.test");
    const bot = await pds.registerUser("bot.test");

    const flow = await completeGroupOAuthFlow({
      groupHost: gh,
      pds,
      user: alice,
      scope: groupAdminScopes().join(" "),
      prompt: "create",
      createParams: {
        displayName: "Core Repo Test",
        handle: "core-repo.groups.localhost",
        joinPolicy: "invite",
        publicMeta: true,
      },
    });
    const dpop = flow.dpop;
    const token = flow.tokenResponse!.access_token;
    const groupDid = flow.tokenResponse!.sub;
    const groupHandle = "core-repo.groups.localhost";
    const metaSpace = `at:space/${groupDid}/group.opensocial.meta/self`;
    const membersSpace = `at:space/${groupDid}/group.opensocial.members/self`;

    // 1. Public repo handle `at-identifier`, blob upload, and `swapRecord` / `swapCommit` `InvalidSwap` CAS
    const getByHandle = await fetch(
      `${gh.url}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(groupHandle)}&collection=group.opensocial.declaration&rkey=self`,
    );
    assert.equal(getByHandle.status, 200);
    const declRec = (await getByHandle.json()) as { cid: string; uri: string };
    assert.ok(declRec.cid);

    const badSwapPub = await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.repo.putRecord`, {
      method: "POST",
      accessToken: token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo: groupHandle,
        collection: "group.opensocial.declaration",
        rkey: "self",
        swapRecord: "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        record: { $type: "group.opensocial.declaration", createdAt: new Date().toISOString() },
      }),
    });
    assert.equal(badSwapPub.status, 400);
    assert.equal(((await badSwapPub.json()) as { error: string }).error, "InvalidSwap");

    // Upload blob -> listBlobs -> getBlob
    const blobBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const uploadRes = await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.repo.uploadBlob`, {
      method: "POST",
      accessToken: token,
      headers: { "content-type": "image/png" },
      body: blobBytes,
    });
    assert.equal(uploadRes.status, 200);
    const uploadedBlob = ((await uploadRes.json()) as { blob: { ref: { $link: string }; size: number } }).blob;
    assert.equal(uploadedBlob.size, blobBytes.length);

    const getBlobRes = await fetch(
      `${gh.url}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(groupDid)}&cid=${encodeURIComponent(uploadedBlob.ref.$link)}`,
    );
    assert.equal(getBlobRes.status, 200);
    assert.deepEqual(Buffer.from(await getBlobRes.arrayBuffer()), blobBytes);

    // 2. Space key validation (`129` & `512` accepted on `key: "any"`, `513` & non-`self` on `literal:self` rejected) + `group.opensocial.space` auto-index
    const badMetaSkey = await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.createSpace`, {
      method: "POST",
      accessToken: token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        spaceType: "group.opensocial.meta",
        skey: "other",
        policy: { $type: "group.opensocial.policy", publicRead: true },
      }),
    });
    assert.equal(badMetaSkey.status, 400);

    const skey129 = "k".repeat(129);
    const skey512 = "m".repeat(512);
    const skey513 = "x".repeat(513);

    for (const validLongKey of [skey129, skey512]) {
      const cr = await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.createSpace`, {
        method: "POST",
        accessToken: token,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          spaceType: "new.flock.channel",
          skey: validLongKey,
          policy: {
            $type: "group.opensocial.policy",
            publicRead: false,
            unlisted: false,
            grants: [{ role: "member", read: true, write: true }],
          },
        }),
      });
      assert.equal(cr.status, 200, `Expected ${validLongKey.length}-char skey to succeed`);
    }

    const cr513 = await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.createSpace`, {
      method: "POST",
      accessToken: token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        spaceType: "new.flock.channel",
        skey: skey513,
        policy: { $type: "group.opensocial.policy", publicRead: false },
      }),
    });
    assert.equal(cr513.status, 400, "513-char skey must be rejected");

    // Verify `unlisted: false` auto-indexed `group.opensocial.space/<tid>` in `members/self`, and flipping `unlisted: true` removes it!
    const chanUri129 = `at:space/${groupDid}/new.flock.channel/${skey129}`;
    const chanUri512 = `at:space/${groupDid}/new.flock.channel/${skey512}`;
    const listIdx1 = await dpop.fetchWithDpop(
      `${gh.url}/xrpc/com.atproto.space.listRecords?space=${encodeURIComponent(membersSpace)}&repo=${encodeURIComponent(groupDid)}&collection=group.opensocial.space`,
      { method: "GET", accessToken: token },
    );
    assert.equal(listIdx1.status, 200);
    const idxRecs1 = ((await listIdx1.json()) as { records: Array<{ value: { space: string } }> }).records;
    assert.ok(idxRecs1.some((r) => r.value.space === chanUri129));
    assert.ok(idxRecs1.some((r) => r.value.space === chanUri512));

    const updUnlisted = await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.updateSpace`, {
      method: "POST",
      accessToken: token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: chanUri129,
        policy: {
          $type: "group.opensocial.policy",
          publicRead: false,
          unlisted: true,
          grants: [{ role: "member", read: true, write: true }],
        },
      }),
    });
    assert.equal(updUnlisted.status, 200);

    const listIdx2 = await dpop.fetchWithDpop(
      `${gh.url}/xrpc/com.atproto.space.listRecords?space=${encodeURIComponent(membersSpace)}&repo=${encodeURIComponent(groupDid)}&collection=group.opensocial.space`,
      { method: "GET", accessToken: token },
    );
    const idxRecs2 = ((await listIdx2.json()) as { records: Array<{ value: { space: string } }> }).records;
    assert.equal(idxRecs2.some((r) => r.value.space === chanUri129), false, "unlisted: true must remove group.opensocial.space index record");
    assert.equal(idxRecs2.some((r) => r.value.space === chanUri512), true);

    // `CannotDeleteCoreSpace` on `meta/self` & `members/self`
    const delMeta = await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.deleteSpace`, {
      method: "POST",
      accessToken: token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ space: metaSpace }),
    });
    assert.equal(delMeta.status, 400);
    assert.equal(((await delMeta.json()) as { error: string }).error, "CannotDeleteCoreSpace");

    // 3. Space `swapRecord` CAS, `clearRecords` `keep`, `profile.url`, labels, RBAC, Flock `LastAdmin` & `known_app_subject`!
    const profGet = await dpop.fetchWithDpop(
      `${gh.url}/xrpc/com.atproto.space.getRecord?space=${encodeURIComponent(metaSpace)}&repo=${encodeURIComponent(groupDid)}&collection=group.opensocial.profile&rkey=self`,
      { method: "GET", accessToken: token },
    );
    assert.equal(profGet.status, 200);

    // Space `swapRecord` mismatch -> `400 InvalidSwap`
    const badSpaceSwap = await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.putRecord`, {
      method: "POST",
      accessToken: token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: metaSpace,
        repo: groupDid,
        collection: "group.opensocial.profile",
        rkey: "self",
        swapRecord: "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        record: { $type: "group.opensocial.profile", displayName: "Updated", createdAt: new Date().toISOString() },
      }),
    });
    assert.equal(badSpaceSwap.status, 400);
    assert.equal(((await badSpaceSwap.json()) as { error: string }).error, "InvalidSwap");

    // `profile.url` javascript: scheme rejected (`400 InvalidRequest`)
    const badUrlProf = await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.putRecord`, {
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
          displayName: "Bad URL",
          url: "javascript:alert(1)",
          createdAt: new Date().toISOString(),
        },
      }),
    });
    assert.equal(badUrlProf.status, 400);

    // `com.atproto.label.record`: non-TID rkey, `val: ""` (`EmptyLabelValue`), and `CrossSpaceLabel` rejected!
    const chanSpace = `at:space/${groupDid}/new.flock.channel/${skey129}`;
    const badLabelVal = await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.putRecord`, {
      method: "POST",
      accessToken: token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: chanSpace,
        repo: groupDid,
        collection: "com.atproto.label.record",
        rkey: "3jzfcijpj2z2a",
        record: {
          $type: "com.atproto.label.record",
          src: groupDid,
          uri: `${chanSpace}/${alice.did}/new.flock.message/3jzfcijpj2z2a`,
          val: "",
          cts: new Date().toISOString(),
        },
      }),
    });
    assert.equal(badLabelVal.status, 400);

    const crossSpaceLbl = await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.putRecord`, {
      method: "POST",
      accessToken: token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: chanSpace,
        repo: groupDid,
        collection: "com.atproto.label.record",
        rkey: "3jzfcijpj2z2a",
        record: {
          $type: "com.atproto.label.record",
          src: groupDid,
          uri: `${metaSpace}/${groupDid}/group.opensocial.profile/self`,
          val: "!hide",
          cts: new Date().toISOString(),
        },
      }),
    });
    assert.equal(crossSpaceLbl.status, 400);

    // RBAC checks: `CannotTargetGroupSelf`, `EmptyMemberRoles`, `UnknownRole`, `RoleInUse`, `InvalidSpacePolicyScope`
    const selfMem = await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.putRecord`, {
      method: "POST",
      accessToken: token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: membersSpace,
        repo: groupDid,
        collection: "group.opensocial.membership",
        rkey: groupDid,
        record: { $type: "group.opensocial.membership", roles: ["member"], createdAt: new Date().toISOString() },
      }),
    });
    assert.equal(selfMem.status, 400);
    assert.equal(((await selfMem.json()) as { error: string }).error, "CannotTargetGroupSelf");

    const emptyRolesMem = await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.putRecord`, {
      method: "POST",
      accessToken: token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: membersSpace,
        repo: groupDid,
        collection: "group.opensocial.membership",
        rkey: bob.did,
        record: { $type: "group.opensocial.membership", roles: [], createdAt: new Date().toISOString() },
      }),
    });
    assert.equal(emptyRolesMem.status, 400);
    assert.equal(((await emptyRolesMem.json()) as { error: string }).error, "EmptyMemberRoles");

    // Leading `k`–`z` invalid 13-char TID in `new.flock.admittedSpaceRev` rejected!
    const badExtTid = await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.putRecord`, {
      method: "POST",
      accessToken: token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: membersSpace,
        repo: groupDid,
        collection: "group.opensocial.membership",
        rkey: bob.did,
        record: {
          $type: "group.opensocial.membership",
          roles: ["member"],
          createdAt: new Date().toISOString(),
          "new.flock.admittedSpaceRev": "zzzzzzzzzzzzz",
        },
      }),
    });
    assert.equal(badExtTid.status, 400);

    // Deleting `role/admin` while Alice holds it -> `400 RoleInUse`!
    const delAdminRole = await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.deleteRecord`, {
      method: "POST",
      accessToken: token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: membersSpace,
        repo: groupDid,
        collection: "group.opensocial.role",
        rkey: "admin",
      }),
    });
    assert.equal(delAdminRole.status, 400);
    assert.equal(((await delAdminRole.json()) as { error: string }).error, "RoleInUse");

    // Create Flock workspace space `new.flock.workspace/self` + `new.flock.workspace/self` record to enable Flock invariants (`LastAdmin` + `known_app_subject`)
    const wsSpace = `at:space/${groupDid}/new.flock.workspace/self`;
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
    const putWsRec = await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.putRecord`, {
      method: "POST",
      accessToken: token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: wsSpace,
        repo: groupDid,
        collection: "new.flock.workspace",
        rkey: "self",
        record: { $type: "new.flock.workspace", name: "Core WS", createdAt: new Date().toISOString() },
      }),
    });
    assert.equal(putWsRec.status, 200);

    // Demoting sole human admin Alice to `["member"]` in a Flock workspace -> `400 LastAdmin`!
    const demoteSelf = await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.putRecord`, {
      method: "POST",
      accessToken: token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: membersSpace,
        repo: groupDid,
        collection: "group.opensocial.membership",
        rkey: alice.did,
        record: { $type: "group.opensocial.membership", roles: ["member"], createdAt: new Date().toISOString() },
      }),
    });
    assert.equal(demoteSelf.status, 400);
    assert.equal(((await demoteSelf.json()) as { error: string }).error, "LastAdmin");

    // `clearRecords` on `members/self` while `role/member` is referenced by channel policy or `LastAdmin` holds -> `400`!
    const clearMembersBlocked = await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.clearRecords`, {
      method: "POST",
      accessToken: token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: membersSpace,
        repo: groupDid,
      }),
    });
    assert.equal(clearMembersBlocked.status, 400);

    // `clearRecords` on `chanUri512` deletes user/group records while preserving `com.atproto.space.policy/self`!
    await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.putRecord`, {
      method: "POST",
      accessToken: token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: chanUri512,
        repo: groupDid,
        collection: "com.atproto.label.record",
        rkey: "3jzfcijpj2z2a",
        record: {
          $type: "com.atproto.label.record",
          src: groupDid,
          uri: `${chanUri512}/${alice.did}/new.flock.message/3jzfcijpj2z2a`,
          val: "!hide",
          cts: new Date().toISOString(),
        },
      }),
    });
    const clearChan = await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.clearRecords`, {
      method: "POST",
      accessToken: token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: chanUri512,
        repo: groupDid,
      }),
    });
    assert.equal(clearChan.status, 200);
    const chanPolAfterClear = await dpop.fetchWithDpop(
      `${gh.url}/xrpc/com.atproto.space.getRecord?space=${encodeURIComponent(chanUri512)}&repo=${encodeURIComponent(groupDid)}&collection=com.atproto.space.policy&rkey=self`,
      { method: "GET", accessToken: token },
    );
    assert.equal(chanPolAfterClear.status, 200, "clearRecords must preserve com.atproto.space.policy/self");

    void bot;
  } finally {
    await gh.close();
    await pds.close();
    await plc.close();
  }
});

test("authorizeSpaceSync, strict zero-skew space credentials, HPKE KEM-MAC, 105-JTI notifyCredentialsRevoked, legacy-cid STAR import, and 4-state deleteAccount", async () => {
  const plc = await startMockPlcServer();
  const pds = await startMockPersonalPds(plc);
  const gh = await startTestGroupHost({ plc });

  try {
    const alice = await pds.registerUser("alice.test");
    const bob = await pds.registerUser("bob.test");

    const flow = await completeGroupOAuthFlow({
      groupHost: gh,
      pds,
      user: alice,
      scope: groupAdminScopes().join(" "),
      prompt: "create",
      createParams: {
        displayName: "Sync & Delete Group",
        handle: "sync-del.groups.localhost",
        joinPolicy: "open",
        publicMeta: true,
      },
    });
    const dpop = flow.dpop;
    const token = flow.tokenResponse!.access_token;
    const groupDid = flow.tokenResponse!.sub;
    const membersSpace = `at:space/${groupDid}/group.opensocial.members/self`;

    // Admit Bob into `members/self`
    await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.putRecord`, {
      method: "POST",
      accessToken: token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: membersSpace,
        repo: groupDid,
        collection: "group.opensocial.membership",
        rkey: bob.did,
        record: { $type: "group.opensocial.membership", roles: ["member"], createdAt: new Date().toISOString() },
      }),
    });

    // 1. Issue 105 space credentials for Bob on `members/self` via `authorizeSpaceSync`!
    let lastCred = "";
    let lastCredKeypair!: P256Keypair;
    for (let i = 0; i < 105; i += 1) {
      const credKp = await P256Keypair.create({ exportable: true });
      const delTok = await createDelegationToken({
        iss: bob.did as DidString,
        sub: membersSpace as SpaceRefString,
        aud: spaceHostAud(groupDid as DidString),
        keypair: bob.signingKey,
      });
      const authSyncRes = await fetch(`${gh.url}/xrpc/com.atproto.space.authorizeSpaceSync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          space: membersSpace,
          delegationToken: delTok,
          credentialKey: credKp.did(),
          ...(i === 0
            ? {
                notify: {
                  endpoint: pds.url,
                  token: "syncer-tok-1",
                },
              }
            : {}),
        }),
      });
      assert.equal(authSyncRes.status, 200, `authorizeSpaceSync #${i} failed`);
      const parsed = (await authSyncRes.json()) as { credential: string; spaceRev: string };
      lastCred = parsed.credential;
      lastCredKeypair = credKp;
    }

    // 2. Verify HPKE KEM-MAC on `getRecord` AND `getLatestCommit` using `lastCred`!
    const groupDocRes = await fetch(`${plc.url}/${encodeURIComponent(groupDid)}`);
    const groupDoc = (await groupDocRes.json()) as { id: string; verificationMethod?: unknown };
    const groupKemDidKey = gh.plc.extractKemDidKey(groupDoc as Parameters<typeof gh.plc.extractKemDidKey>[0]) as DidString;
    const encRec = await encapsulate(groupKemDidKey);

    const getRecUrl = `${gh.url}/xrpc/com.atproto.space.getRecord?space=${encodeURIComponent(membersSpace)}&repo=${encodeURIComponent(groupDid)}&collection=group.opensocial.membership&rkey=${encodeURIComponent(bob.did)}`;
    const { headers: sigHeadersRec } = await createSpaceSigHeaders({
      keypair: lastCredKeypair,
      authorization: `Atproto-Space-Credential ${lastCred}`,
      audience: groupDid as DidString,
    });
    const macRecRes = await fetch(getRecUrl, {
      headers: {
        ...sigHeadersRec,
        "accept-signature": formatMacRequest(RECORD_MAC_PROFILE, encRec.keyShare),
      },
    });
    assert.equal(macRecRes.status, 200);
    const macRecBody = (await macRecRes.json()) as { uri: string; cid: string; value: Record<string, unknown> };
    verifyRecordMac(macRecBody.uri as AtUriString, parseCid(macRecBody.cid), {
      ...encRec,
      headers: macRecRes.headers,
    });
    assert.ok(macRecRes.headers.get("atproto-membership-incarnation"), "Must expose Atproto-Membership-Incarnation header");

    const encCommit = await encapsulate(groupKemDidKey);
    const getCommitUrl = `${gh.url}/xrpc/com.atproto.space.getLatestCommit?space=${encodeURIComponent(membersSpace)}&repo=${encodeURIComponent(groupDid)}`;
    const { headers: sigHeadersCommit } = await createSpaceSigHeaders({
      keypair: lastCredKeypair,
      authorization: `Atproto-Space-Credential ${lastCred}`,
      audience: groupDid as DidString,
    });
    const macCommitRes = await fetch(getCommitUrl, {
      headers: {
        ...sigHeadersCommit,
        "accept-signature": formatMacRequest(COMMIT_MAC_PROFILE, encCommit.keyShare),
      },
    });
    assert.equal(macCommitRes.status, 200);
    const macCommitBody = (await macCommitRes.json()) as {
      commit: { ver: 1; space: SpaceRefString; repo: DidString; rev: string; data: { $bytes: string } };
    };
    verifyCommitMac(
      {
        ...macCommitBody.commit,
        data: Buffer.from(macCommitBody.commit.data.$bytes, "base64"),
      },
      {
        ...encCommit,
        headers: macCommitRes.headers,
      },
    );

    // 3. Verify strict zero-skew `nowSec >= exp` rejection on expired space credential!
    const groupSigKey = await gh.repoStore.getGroupSigningKey(groupDid);
    const nowSec = Math.floor(Date.now() / 1000);
    const expHeader = Buffer.from(
      JSON.stringify({ typ: "atproto-space-credential+jwt", alg: "ES256", kid: "#atproto" }),
    ).toString("base64url");
    const expPayload = Buffer.from(
      JSON.stringify({
        iss: groupDid,
        sub: membersSpace,
        cnf: { kid: lastCredKeypair.did() },
        iat: nowSec - 600,
        exp: nowSec, // exact `nowSec === exp` must be rejected with zero clock skew!
        jti: randomUUID(),
      }),
    ).toString("base64url");
    const expSig = await groupSigKey.sign(Buffer.from(`${expHeader}.${expPayload}`, "utf8"));
    const expiredCred = `${expHeader}.${expPayload}.${Buffer.from(expSig).toString("base64url")}`;
    const { headers: expHeaders } = await createSpaceSigHeaders({
      keypair: lastCredKeypair,
      authorization: `Atproto-Space-Credential ${expiredCred}`,
      audience: groupDid as DidString,
    });
    const expReadRes = await fetch(getCommitUrl, {
      headers: {
        ...expHeaders,
        "accept-signature": formatMacRequest(COMMIT_MAC_PROFILE, encCommit.keyShare),
      },
    });
    assert.equal(expReadRes.status, 401, "Zero-skew credential verifier must reject exp === nowSec");

    // 4. Evict Bob by deleting `membership/<bob.did>` -> verify 105 issued credentials flush in 2 `notifyCredentialsRevoked` chunks (`100` + `5`)!
    pds.receivedCredentialsRevoked.length = 0;
    const delBobRes = await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.deleteRecord`, {
      method: "POST",
      accessToken: token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: membersSpace,
        repo: groupDid,
        collection: "group.opensocial.membership",
        rkey: bob.did,
      }),
    });
    assert.equal(delBobRes.status, 200);
    await gh.flushBackgroundWork();
    assert.equal(pds.receivedCredentialsRevoked.length, 2, "105 revoked JTIs must be chunked into 2 <=100-item batches");
    assert.equal(pds.receivedCredentialsRevoked[0]!.credentials.length, 100);
    assert.equal(pds.receivedCredentialsRevoked[1]!.credentials.length, 5);
    const totalRevokedJtis = pds.receivedCredentialsRevoked.reduce((acc, b) => acc + b.credentials.length, 0);
    assert.equal(totalRevokedJtis, 105);

    // 5. Verify `legacy-cid:<cid>` deterministic incarnation fallback + empty `group_invite_target` reconstruction during STAR staging!
    gh.db.prepare("UPDATE group_account SET activated = 0 WHERE did = ?").run(groupDid);
    gh.db
      .prepare(
        `INSERT INTO migration_session (
           id, group_did, mode, source_endpoint, source_plc_rotation_keys_json, preserved_sovereign_keys_json,
           access_jti, refresh_jti, auth_epoch, absolute_deadline_at, created_at
         ) VALUES ('mig-star-test', ?, 'standard', 'https://src.example', '[]', '[]', 'aj-1', 'rj-1', 1, ?, ?)`,
      )
      .run(groupDid, Date.now() + 600_000, Date.now());

    const membersMetaPolicyRow = gh.db
      .prepare("SELECT policy_json FROM group_space WHERE space_uri = ?")
      .get(membersSpace) as { policy_json: string };
    const legacyPolicySer = await serializeRecord(
      "com.atproto.space.policy" as NsidString,
      "self" as RecordKeyString,
      jsonToLex({
        $type: "com.atproto.space.policy",
        policy: JSON.parse(membersMetaPolicyRow.policy_json) as Record<string, unknown>,
      }) as LexMap,
    );
    const legacyRoleSer = await serializeRecord(
      "group.opensocial.role" as NsidString,
      "admin" as RecordKeyString,
      jsonToLex({
        $type: "group.opensocial.role",
        displayName: "Admin",
        assignable: ["*"],
        scopes: groupAdminScopes(groupDid),
      }) as LexMap,
    );
    const legacyMemSer = await serializeRecord(
      "group.opensocial.membership" as NsidString,
      alice.did as RecordKeyString,
      jsonToLex({
        $type: "group.opensocial.membership",
        roles: ["admin"],
        createdAt: "2026-01-01T00:00:00.000Z",
        // Intentionally NO "new.flock.incarnation" field!
      }) as LexMap,
    );
    const rc = RepoCommit.fromRecords([legacyPolicySer, legacyMemSer, legacyRoleSer]);
    const legacyStarChunks: Buffer[] = [];
    for await (const chunk of writeRepoStar(
      rc.toCommit({
        space: membersSpace as SpaceRefString,
        repo: groupDid as DidString,
        rev: "3kzzzzzzzzzzz",
      }),
      [legacyPolicySer, legacyMemSer, legacyRoleSer],
    )) {
      legacyStarChunks.push(Buffer.from(chunk));
    }
    await gh.repoStore.importSpaceRepoStarStream({
      groupDid,
      migrationSessionId: "mig-star-test",
      starStream: [Buffer.concat(legacyStarChunks)],
    });
    const importedMemRow = gh.db
      .prepare("SELECT incarnation FROM space_record WHERE space_uri = ? AND repo_did = ? AND collection = 'group.opensocial.membership' AND rkey = ?")
      .get(membersSpace, groupDid, alice.did) as { incarnation: string | null } | undefined;
    assert.equal(importedMemRow?.incarnation, `legacy-cid:${legacyMemSer.cid.toString()}`);

    // Also import an empty external `invites/self` STAR and verify `group_invite_target` is reconstructed!
    const emptyInvSpace = `at:space/${bob.did}/group.opensocial.invites/self`;
    const emptyInvChunks: Buffer[] = [];
    for await (const chunk of writeRepoStar(
      new RepoCommit().toCommit({
        space: emptyInvSpace as SpaceRefString,
        repo: groupDid as DidString,
        rev: "3kzzzzzzzzzzz",
      }),
      [],
    )) {
      emptyInvChunks.push(Buffer.from(chunk));
    }
    await gh.repoStore.importSpaceRepoStarStream({
      groupDid,
      migrationSessionId: "mig-star-test",
      starStream: [Buffer.concat(emptyInvChunks)],
    });
    const invTargetRow = gh.db
      .prepare("SELECT invitee_did FROM group_invite_target WHERE group_did = ? AND space_uri = ?")
      .get(groupDid, emptyInvSpace) as { invitee_did: string } | undefined;
    assert.equal(invTargetRow?.invitee_did, bob.did);

    gh.db.prepare("DELETE FROM migration_session WHERE id = 'mig-star-test'").run();
    gh.db.prepare("UPDATE group_account SET activated = 1 WHERE did = ?").run(groupDid);

    // 6. Test 4-state `deleteAccount` (with explicit `prompt=login` step-up!):
    //    - First inject a non-409 `400` PLC error -> `502 PlcTombstoneRejected` while preserving journal for retry;
    //    - Clear PLC fault -> retry `deleteAccount` -> `200 OK`, `#spaceDeleted` delivered, PLC tombstoned (`410`), and `0` rows across all 39 `GROUP_PURGED_TABLES`!
    const stepUpDel = await completeGroupOAuthFlow({
      groupHost: gh,
      pds,
      user: alice,
      scope: groupAdminScopes().join(" "),
      prompt: "login",
      loginHint: groupDid,
    });
    const delDpop = stepUpDel.dpop;
    const delAccessToken = stepUpDel.tokenResponse!.access_token;

    const reqDelRes = await delDpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.server.requestAccountDelete`, {
      method: "POST",
      accessToken: delAccessToken,
    });
    assert.equal(reqDelRes.status, 200);
    const claimDelRes = await delDpop.fetchWithDpop(`${gh.url}/group-admin/claim-action-token`, {
      method: "POST",
      accessToken: delAccessToken,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ group: groupDid, purpose: "delete_account" }),
    });
    assert.equal(claimDelRes.status, 200);
    const { token: delToken } = (await claimDelRes.json()) as { token: string };

    // Single-use claim: second claim returns `400 TokenAlreadyClaimed`!
    const secondClaim = await delDpop.fetchWithDpop(`${gh.url}/group-admin/claim-action-token`, {
      method: "POST",
      accessToken: delAccessToken,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ group: groupDid, purpose: "delete_account" }),
    });
    assert.equal(secondClaim.status, 400);
    assert.equal(((await secondClaim.json()) as { error: string }).error, "TokenAlreadyClaimed");

    // Inject non-409 PLC rejection on first `deleteAccount` attempt
    plc.interceptPost = (did) => (did === groupDid ? { status: 400, body: { message: "Simulated non-409 PLC reject" } } : null);
    const delFailRes = await delDpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.server.deleteAccount`, {
      method: "POST",
      accessToken: delAccessToken,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ did: groupDid, token: delToken }),
    });
    assert.equal(delFailRes.status, 502);
    assert.equal(((await delFailRes.json()) as { error: string }).error, "PlcTombstoneRejected");

    // Clear fault and resume `executeOrResumeDeleteAccount` (just like maintenance sweep or retry)!
    plc.interceptPost = undefined;
    await gh.flushBackgroundWork();

    const plcAfterDel = await fetch(`${plc.url}/${encodeURIComponent(groupDid)}`);
    assert.equal(plcAfterDel.status, 410, "Group DID must be tombstoned on PLC");

    assert.ok(
      pds.receivedSpaceUpdates.some((u) => u.update.$type === "com.atproto.space.notifySpaceUpdate#spaceDeleted"),
      "Registered syncer must receive #spaceDeleted before PLC tombstone",
    );

    for (const tbl of SCHEMA_TABLE_CLASSIFICATION.GROUP_PURGED_TABLES) {
      const cnt = (gh.db.prepare(`SELECT COUNT(*) AS cnt FROM ${tbl}`).get() as { cnt: number }).cnt;
      assert.equal(cnt, 0, `Table ${tbl} must have 0 rows after deleteAccount purge`);
    }
  } finally {
    await gh.close();
    await pds.close();
    await plc.close();
  }
});

test("isPermissionSubset enforces exact structural wildcard containment and RBAC blocks role/policy anti-escalation bypasses", async () => {
  const sampleGroupDid = "did:plc:abcdefghijklmnopqrstuvwx";

  // 1. Direct structural wildcard subset verification (rejecting sentinel probe strings!)
  const probeHolder = expandGroupScopes(
    [
      "blob?accept=application/octet-stream&accept=image/png&accept=image/x-probe",
      "repo:com.atproto.probe.wildcard",
      "rpc:com.atproto.probe.wildcard?aud=did:plc:zzzzzzzzzzzzzzzzzzzzzzzz%23atproto_pds",
      "space:new.flock.channel?skey=general&collection=new.flock.message&action=read&action=create",
    ],
    sampleGroupDid,
  );
  assert.equal(
    isPermissionSubset(new ScopePermissions(["blob:*/*"]), probeHolder, sampleGroupDid),
    false,
    "Concrete MIME probes must not satisfy blob:*/*",
  );
  assert.equal(
    isPermissionSubset(new ScopePermissions(["blob:image/*"]), probeHolder, sampleGroupDid),
    false,
    "image/x-probe must not satisfy blob:image/*",
  );
  assert.equal(
    isPermissionSubset(new ScopePermissions(["repo:*?action=create"]), probeHolder, sampleGroupDid),
    false,
    "com.atproto.probe.wildcard must not satisfy repo:*",
  );
  assert.equal(
    isPermissionSubset(
      new ScopePermissions(["rpc:*?aud=did:plc:zzzzzzzzzzzzzzzzzzzzzzzz%23atproto_pds"]),
      probeHolder,
      sampleGroupDid,
    ),
    false,
    "Concrete lxm probe must not satisfy rpc:*",
  );
  assert.equal(
    isPermissionSubset(
      new ScopePermissions(["rpc:com.atproto.probe.wildcard?aud=*"]),
      probeHolder,
      sampleGroupDid,
    ),
    false,
    "Concrete aud probe must not satisfy aud=*",
  );
  assert.equal(
    isPermissionSubset(
      expandGroupScopes(["space:new.flock.channel?skey=*&collection=new.flock.message&action=create"], sampleGroupDid),
      probeHolder,
      sampleGroupDid,
    ),
    false,
    "Concrete skey must not satisfy skey=*",
  );
  assert.equal(
    isPermissionSubset(
      expandGroupScopes(["space:new.flock.channel?skey=general&collection=*&action=create"], sampleGroupDid),
      probeHolder,
      sampleGroupDid,
    ),
    false,
    "Concrete collection must not satisfy collection=*",
  );

  // 2. End-to-end role write/delete & policy update anti-escalation
  const plc = await startMockPlcServer();
  const pds = await startMockPersonalPds(plc);
  const gh = await startTestGroupHost({ plc });

  try {
    const alice = await pds.registerUser("alice-rbac.test");
    const bob = await pds.registerUser("bob-rbac.test");

    const createFlow = await completeGroupOAuthFlow({
      groupHost: gh,
      pds,
      user: alice,
      scope: groupAdminScopes().join(" "),
      prompt: "create",
      createParams: { displayName: "RBAC Hardening", handle: "rbac-hard.groups.localhost" },
    });
    const adminDpop = createFlow.dpop;
    const adminTok = createFlow.tokenResponse!.access_token;
    const groupDid = createFlow.tokenResponse!.sub;
    const membersSpace = `at:space/${groupDid}/group.opensocial.members/self`;
    const secretChan = `at:space/${groupDid}/new.flock.channel/secret`;
    const nowIso = new Date().toISOString();

    // Admin creates `helper`, `protected-role`, and `space-mgr` (assignable: ["helper"], NO read/write on secretChan initially)
    for (const [rkey, roleRec] of [
      ["helper", { displayName: "Helper", scopes: [] }],
      ["protected-role", { displayName: "Protected", scopes: [] }],
      [
        "space-mgr",
        {
          displayName: "Space Manager",
          assignable: ["helper"],
          scopes: [
            "space:group.opensocial.members?skey=self&collection=group.opensocial.role&action=read&action=create&action=update&action=delete",
            "space:new.flock.channel?skey=secret&action=read_self&manage=update",
            "space:new.flock.channel?skey=secret&collection=new.flock.message&action=read",
          ],
        },
      ],
    ] as const) {
      const res = await adminDpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.putRecord`, {
        method: "POST",
        accessToken: adminTok,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          space: membersSpace,
          repo: groupDid,
          collection: "group.opensocial.role",
          rkey,
          record: roleRec,
        }),
      });
      assert.equal(res.status, 200);
    }

    // Admin creates private `secretChan` with an `admin` grant ONLY (so Bob has `manage=update` via role scope, NOT `read` or `write`!)
    const adminChanGrant = {
      role: "admin",
      read: true,
      write: true,
      scopes: [
        "space:new.flock.channel?skey=secret&collection=*&action=read&action=create&action=update&action=delete&manage=update",
      ],
    };
    const mkSecRes = await adminDpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.createSpace`, {
      method: "POST",
      accessToken: adminTok,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        spaceType: "new.flock.channel",
        skey: "secret",
        policy: {
          $type: "group.opensocial.policy",
          publicRead: false,
          unlisted: true,
          grants: [adminChanGrant],
        },
      }),
    });
    assert.equal(mkSecRes.status, 200);

    // Admit Bob with `["space-mgr", "member"]`
    const admitBob = await adminDpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.putRecord`, {
      method: "POST",
      accessToken: adminTok,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: membersSpace,
        repo: groupDid,
        collection: "group.opensocial.membership",
        rkey: bob.did,
        record: { roles: ["space-mgr", "member"], createdAt: nowIso },
      }),
    });
    assert.equal(admitBob.status, 200);

    const bobScopes = [
      "atproto",
      "space:group.opensocial.members?skey=self&collection=group.opensocial.role&action=read&action=create&action=update&action=delete",
      "space:new.flock.channel?skey=secret&action=read_self&manage=update",
      "space:new.flock.channel?skey=secret&collection=new.flock.message&action=read",
    ].join(" ");
    const bobFlow = await completeGroupOAuthFlow({
      groupHost: gh,
      pds,
      user: bob,
      scope: bobScopes,
      loginHint: groupDid,
    });
    const bobDpop = bobFlow.dpop;
    const bobTok = bobFlow.tokenResponse!.access_token;

    // (a) Role writes & deletes: Bob CANNOT edit or delete `protected-role` (not in Bob's assignable)
    const editUnassignable = await bobDpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.putRecord`, {
      method: "POST",
      accessToken: bobTok,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: membersSpace,
        repo: groupDid,
        collection: "group.opensocial.role",
        rkey: "protected-role",
        record: { displayName: "Hijacked", scopes: [] },
      }),
    });
    assert.equal(editUnassignable.status, 403);
    assert.equal(((await editUnassignable.json()) as { error: string }).error, "PrivilegeEscalation");

    const delUnassignable = await bobDpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.deleteRecord`, {
      method: "POST",
      accessToken: bobTok,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: membersSpace,
        repo: groupDid,
        collection: "group.opensocial.role",
        rkey: "protected-role",
      }),
    });
    assert.equal(delUnassignable.status, 403);
    assert.equal(((await delUnassignable.json()) as { error: string }).error, "PrivilegeEscalation");

    const clearUnassignableRoles = await bobDpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.clearRecords`, {
      method: "POST",
      accessToken: bobTok,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: membersSpace,
        repo: groupDid,
        collections: ["group.opensocial.role"],
      }),
    });
    assert.equal(clearUnassignableRoles.status, 403);
    assert.equal(((await clearUnassignableRoles.json()) as { error: string }).error, "PrivilegeEscalation");

    // Bob CAN edit `helper` (assignable), but CANNOT add `"space-mgr"` to `helper.assignable`
    const addUnassignableToHelper = await bobDpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.putRecord`, {
      method: "POST",
      accessToken: bobTok,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: membersSpace,
        repo: groupDid,
        collection: "group.opensocial.role",
        rkey: "helper",
        record: { displayName: "Helper", assignable: ["space-mgr"], scopes: [] },
      }),
    });
    assert.equal(addUnassignableToHelper.status, 403);
    assert.equal(((await addUnassignableToHelper.json()) as { error: string }).error, "PrivilegeEscalation");

    // (b) Policy updates on `secretChan`: Bob lacks `read`/`write` on `secretChan`, so granting `read`, `write`, `publicRead`, or flipping `unlisted` is `403 PrivilegeEscalation`!
    for (const illegalPolicy of [
      {
        $type: "group.opensocial.policy",
        publicRead: false,
        unlisted: true,
        grants: [adminChanGrant, { role: "helper", read: true }],
      },
      {
        $type: "group.opensocial.policy",
        publicRead: false,
        unlisted: true,
        grants: [adminChanGrant, { role: "helper", write: true }],
      },
      {
        $type: "group.opensocial.policy",
        publicRead: true,
        unlisted: true,
        grants: [adminChanGrant],
      },
      {
        $type: "group.opensocial.policy",
        publicRead: false,
        unlisted: false,
        grants: [adminChanGrant],
      },
      {
        $type: "group.opensocial.policy",
        publicRead: false,
        unlisted: true,
        grants: [{ ...adminChanGrant, write: false }],
      },
    ]) {
      const polRes = await bobDpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.updateSpace`, {
        method: "POST",
        accessToken: bobTok,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ space: secretChan, policy: illegalPolicy }),
      });
      assert.equal(polRes.status, 403);
      assert.equal(((await polRes.json()) as { error: string }).error, "PrivilegeEscalation");
    }

    // Now Admin grants `space-mgr` `read: true` on `secretChan`; Bob CAN grant `helper` `read: true` + subset scope while leaving `adminChanGrant` untouched!
    const adminGrantMgrRead = await adminDpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.updateSpace`, {
      method: "POST",
      accessToken: adminTok,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: secretChan,
        policy: {
          $type: "group.opensocial.policy",
          publicRead: false,
          unlisted: true,
          grants: [adminChanGrant, { role: "space-mgr", read: true }],
        },
      }),
    });
    assert.equal(adminGrantMgrRead.status, 200);

    const bobLegitUpdate = await bobDpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.updateSpace`, {
      method: "POST",
      accessToken: bobTok,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: secretChan,
        policy: {
          $type: "group.opensocial.policy",
          publicRead: false,
          unlisted: true,
          grants: [
            adminChanGrant,
            { role: "space-mgr", read: true },
            {
              role: "helper",
              read: true,
              scopes: ["space:new.flock.channel?skey=secret&collection=new.flock.message&action=read"],
            },
          ],
        },
      }),
    });
    assert.equal(bobLegitUpdate.status, 200, "Delegated manager must not be blocked by untouched admin grant");
  } finally {
    await gh.close();
    await pds.close();
    await plc.close();
  }
});

test("Commit-time TOCTOU reauthorization and concurrent putRecord create-vs-update enforce live permissions inside lock/tx", async () => {
  const plc = await startMockPlcServer();
  const pds = await startMockPersonalPds(plc);
  const gh = await startTestGroupHost({ plc });

  try {
    const alice = await pds.registerUser("alice-toctou.test");
    const bob = await pds.registerUser("bob-toctou.test");

    const createFlow = await completeGroupOAuthFlow({
      groupHost: gh,
      pds,
      user: alice,
      scope: groupAdminScopes().join(" "),
      prompt: "create",
      createParams: { displayName: "TOCTOU Group", handle: "toctou.groups.localhost" },
    });
    const adminDpop = createFlow.dpop;
    const adminTok = createFlow.tokenResponse!.access_token;
    const groupDid = createFlow.tokenResponse!.sub;
    const membersSpace = `at:space/${groupDid}/group.opensocial.members/self`;
    const chanSpace = `at:space/${groupDid}/new.flock.channel/general`;
    const nowIso = new Date().toISOString();

    // Create `creator-only` role with `create` ONLY (NO `update`!) on public post & channel message
    await adminDpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.putRecord`, {
      method: "POST",
      accessToken: adminTok,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: membersSpace,
        repo: groupDid,
        collection: "group.opensocial.role",
        rkey: "creator-only",
        record: {
          displayName: "Creator Only",
          scopes: [
            "repo:app.bsky.feed.post?action=create",
            "space:new.flock.channel?skey=general&collection=new.flock.message&action=read&action=create",
          ],
        },
      }),
    });

    await adminDpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.createSpace`, {
      method: "POST",
      accessToken: adminTok,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        spaceType: "new.flock.channel",
        skey: "general",
        policy: {
          $type: "group.opensocial.policy",
          publicRead: false,
          grants: [{ role: "creator-only", read: true, write: true }],
        },
      }),
    });

    await adminDpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.putRecord`, {
      method: "POST",
      accessToken: adminTok,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: membersSpace,
        repo: groupDid,
        collection: "group.opensocial.membership",
        rkey: bob.did,
        record: { roles: ["creator-only", "member"], createdAt: nowIso },
      }),
    });

    const bobFlow = await completeGroupOAuthFlow({
      groupHost: gh,
      pds,
      user: bob,
      scope: [
        "atproto",
        "repo:app.bsky.feed.post?action=create",
        "space:new.flock.channel?skey=general&collection=new.flock.message&action=read&action=create",
      ].join(" "),
      loginHint: groupDid,
    });
    const bobDpop = bobFlow.dpop;
    const bobTok = bobFlow.tokenResponse!.access_token;

    // 1. Concurrent absent-record `repo.putRecord` with `create`-only scope: first wins (`200`), second sees existing record inside lock/tx (`403`)!
    const [rPut1, rPut2] = await Promise.all([
      bobDpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.repo.putRecord`, {
        method: "POST",
        accessToken: bobTok,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repo: groupDid,
          collection: "app.bsky.feed.post",
          rkey: "3jzfcijpj2z2a",
          record: { text: "first", createdAt: nowIso },
        }),
      }),
      bobDpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.repo.putRecord`, {
        method: "POST",
        accessToken: bobTok,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repo: groupDid,
          collection: "app.bsky.feed.post",
          rkey: "3jzfcijpj2z2a",
          record: { text: "second", createdAt: nowIso },
        }),
      }),
    ]);
    assert.deepEqual([rPut1.status, rPut2.status].sort(), [200, 403]);

    // 2. Concurrent absent-record `space.putRecord` with `create`-only scope: first wins (`200`), second fails `403`!
    const [sPut1, sPut2] = await Promise.all([
      bobDpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.putRecord`, {
        method: "POST",
        accessToken: bobTok,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          space: chanSpace,
          repo: groupDid,
          collection: "new.flock.message",
          rkey: "3jzfcijpj2z2b",
          record: { text: "msg-1", createdAt: nowIso },
        }),
      }),
      bobDpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.putRecord`, {
        method: "POST",
        accessToken: bobTok,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          space: chanSpace,
          repo: groupDid,
          collection: "new.flock.message",
          rkey: "3jzfcijpj2z2b",
          record: { text: "msg-2", createdAt: nowIso },
        }),
      }),
    ]);
    assert.deepEqual([sPut1.status, sPut2.status].sort(), [200, 403]);

    // 3. Commit-time TOCTOU: Bob authenticates BEFORE acquiring `withGroupRepoLock`, gets demoted before lock releases -> `403`!
    let releaseHold!: () => void;
    let lockAcquired!: () => void;
    const holdPromise = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const acquiredPromise = new Promise<void>((resolve) => {
      lockAcquired = resolve;
    });

    const holderTask = gh.locks.withGroupRepoLock(groupDid, async () => {
      lockAcquired();
      await holdPromise;
      // Demote Bob to `["member"]` (removing `creator-only`) right before releasing the repo lock!
      gh.db
        .prepare("UPDATE space_record SET value = ? WHERE space_uri = ? AND repo_did = ? AND collection = ? AND rkey = ?")
        .run(
          JSON.stringify({ $type: "group.opensocial.membership", roles: ["member"], createdAt: nowIso }),
          membersSpace,
          groupDid,
          "group.opensocial.membership",
          bob.did,
        );
    });

    await acquiredPromise;
    const inflightWrite = bobDpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.repo.createRecord`, {
      method: "POST",
      accessToken: bobTok,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo: groupDid,
        collection: "app.bsky.feed.post",
        rkey: "3jzfcijpj2z2c",
        record: { text: "stale-authorized-write", createdAt: nowIso },
      }),
    });

    // Give `inflightWrite` a few ms to complete `authGroupDpop` and queue on `withGroupRepoLock`
    await new Promise((r) => setTimeout(r, 25));
    releaseHold();
    await holderTask;

    const toctouRes = await inflightWrite;
    assert.equal(toctouRes.status, 403, "Demoted caller queued behind repo lock must be rejected at commit time");
    assert.equal(((await toctouRes.json()) as { error: string }).error, "ScopeMissingError");

    // 4. `com.atproto.space.notifyCredentialsRevoked` wire + security contract:
    //    - requires `credentials: string[1..100]` with `1 <= c.length <= 256` (`400 InvalidRequest`)
    //    - rejects unrelated external space before `groupDid` has a local `space_repo` (`403 Forbidden`)
    //    - enforces single-use `jti` (`401 ReplayDetected`), per-space revocation isolation, and `10,000`-row stored quota (`429 RateLimitExceeded`)
    const notifyJwt = await alice.signServiceJwt(groupDid, "com.atproto.space.notifyCredentialsRevoked");
    const aliceSpace = `at:space/${alice.did}/group.opensocial.invites/self`;
    for (const invalidBody of [
      { space: aliceSpace, jtis: ["jti-legacy-only"] },
      { space: aliceSpace, credentials: [] },
      { space: aliceSpace, credentials: [""] },
      { space: aliceSpace, credentials: ["x".repeat(257)] },
      { space: aliceSpace, credentials: [123] },
      { space: aliceSpace, credentials: Array.from({ length: 101 }, (_, idx) => `c-${idx}`) },
      { space: "not-a-valid-space-ref", credentials: ["c-1"] },
    ]) {
      const badNotifyRes = await fetch(`${gh.url}/xrpc/com.atproto.space.notifyCredentialsRevoked`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${notifyJwt}`,
        },
        body: JSON.stringify(invalidBody),
      });
      assert.equal(badNotifyRes.status, 400, `Expected 400 InvalidRequest for ${JSON.stringify(invalidBody)}`);
      assert.equal(((await badNotifyRes.json()) as { error: string }).error, "InvalidRequest");
    }

    // Before `groupDid` writes to `aliceSpace`, `alice` cannot push revocations for `aliceSpace` (`403 Forbidden`)
    const unrelatedSpaceRes = await fetch(`${gh.url}/xrpc/com.atproto.space.notifyCredentialsRevoked`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${notifyJwt}`,
      },
      body: JSON.stringify({
        space: aliceSpace,
        credentials: ["revoked-cred-blocked"],
      }),
    });
    assert.equal(unrelatedSpaceRes.status, 403);
    assert.equal(((await unrelatedSpaceRes.json()) as { error: string }).error, "Forbidden");

    // Write an invite from `groupDid` into `aliceSpace` so `space_repo(aliceSpace, groupDid)` exists
    const seedInviteRes = await adminDpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.putRecord`, {
      method: "POST",
      accessToken: adminTok,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: aliceSpace,
        repo: groupDid,
        collection: "group.opensocial.invite",
        rkey: "3jzfcijpj2z2d",
        record: { createdAt: nowIso },
      }),
    });
    assert.equal(seedInviteRes.status, 200);

    const validNotifyRes = await fetch(`${gh.url}/xrpc/com.atproto.space.notifyCredentialsRevoked`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${notifyJwt}`,
      },
      body: JSON.stringify({
        space: aliceSpace,
        credentials: ["revoked-cred-1", "revoked-cred-2"],
      }),
    });
    assert.equal(validNotifyRes.status, 200);
    const storedRevoked = gh.db
      .prepare("SELECT jti FROM revoked_credential WHERE group_did = ? AND space_uri = ? ORDER BY jti")
      .all(groupDid, aliceSpace) as Array<{ jti: string }>;
    assert.deepEqual(storedRevoked.map((r) => r.jti), ["revoked-cred-1", "revoked-cred-2"]);

    // Replay of the exact same `notifyJwt` is rejected with `401 ReplayDetected`
    const replayNotifyRes = await fetch(`${gh.url}/xrpc/com.atproto.space.notifyCredentialsRevoked`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${notifyJwt}`,
      },
      body: JSON.stringify({
        space: aliceSpace,
        credentials: ["revoked-cred-3"],
      }),
    });
    assert.equal(replayNotifyRes.status, 401);
    assert.equal(((await replayNotifyRes.json()) as { error: string }).error, "ReplayDetected");

    // Stored `10,000`-row quota per `(group_did, space_uri)` rejects overflow with `429`, then succeeds after expiry prune!
    const baseMs = Date.now() + 120_000;
    for (let batch = 0; batch < 100; batch += 1) {
      gh.repoStore.handleNotifyCredentialsRevokedSync({
        hostedGroupDid: groupDid,
        issuerDid: bob.did,
        serviceJwtJti: `quota-jti-${batch}`,
        serviceJwtExpSec: Math.floor((baseMs + batch * 3_000) / 1000) + 60,
        space: chanSpace,
        credentials: Array.from({ length: 100 }, (_, idx) => `q-${batch}-${idx}`),
        nowMs: baseMs + batch * 3_000,
      });
    }
    assert.throws(
      () =>
        gh.repoStore.handleNotifyCredentialsRevokedSync({
          hostedGroupDid: groupDid,
          issuerDid: bob.did,
          serviceJwtJti: "quota-jti-overflow",
          serviceJwtExpSec: Math.floor((baseMs + 310_000) / 1000) + 60,
          space: chanSpace,
          credentials: ["q-overflow"],
          nowMs: baseMs + 310_000,
        }),
      (err: unknown) => (err as { status?: number; code?: string }).status === 429 && (err as { code?: string }).code === "RateLimitExceeded",
    );

    // 5. `uploadBlob` produces raw codec 0x55 SHA-256 CIDv1 cleanly
    const blobPayload = Buffer.from("opensocial-raw-blob-bytes", "utf8");
    const upRes = await adminDpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.repo.uploadBlob`, {
      method: "POST",
      accessToken: adminTok,
      headers: { "content-type": "application/octet-stream" },
      body: blobPayload,
    });
    assert.equal(upRes.status, 200);
    const upJson = (await upRes.json()) as { blob: { ref: { $link: string }; size: number } };
    assert.equal(upJson.blob.size, blobPayload.byteLength);
    const dlRes = await fetch(
      `${gh.url}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(groupDid)}&cid=${encodeURIComponent(upJson.blob.ref.$link)}`,
    );
    assert.equal(dlRes.status, 200);
    assert.deepEqual(Buffer.from(await dlRes.arrayBuffer()), blobPayload);
  } finally {
    await gh.close();
    await pds.close();
    await plc.close();
  }
});

test("Round 4 hardening: atomic meta publicRead <-> declaration/self coupling, strict external invites/self collection enforcement, and localhost clientAttestation verification", async () => {
  const plc = await startMockPlcServer();
  const pds = await startMockPersonalPds(plc);
  const gh = await startTestGroupHost({ plc });

  // Localhost OAuth client metadata + JWKS (`application/jwk-set+json`) server
  const { publicKey: appPubKey, privateKey: appPrivKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const { privateKey: wrongPrivKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const appPubJwk = { ...appPubKey.export({ format: "jwk" }), kid: "localhost-app-k1", use: "sig", alg: "ES256" };

  let appPort = 0;
  const appServer = createHttpServer((req, res) => {
    const clientId = `http://localhost:${appPort}/client-metadata.json`;
    if (req.url === "/client-metadata.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          client_id: clientId,
          client_name: "Localhost Test App",
          jwks_uri: `http://localhost:${appPort}/jwks.json`,
        }),
      );
      return;
    }
    if (req.url === "/jwks.json") {
      res.writeHead(200, { "content-type": "application/jwk-set+json" });
      res.end(JSON.stringify({ keys: [appPubJwk] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => appServer.listen(0, "127.0.0.1", resolve));
  appPort = (appServer.address() as AddressInfo).port;
  const localhostClientId = `http://localhost:${appPort}/client-metadata.json`;

  const signAttestation = (
    privKey: typeof appPrivKey,
    claims: Record<string, unknown>,
    headerOverrides: Record<string, unknown> = {},
  ): string => {
    const hdr = Buffer.from(
      JSON.stringify({ typ: "atproto-client-attestation+jwt", alg: "ES256", kid: "localhost-app-k1", ...headerOverrides }),
    ).toString("base64url");
    const bdy = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signer = createSign("SHA256");
    signer.update(`${hdr}.${bdy}`);
    signer.end();
    const sig = signer.sign({ key: privKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
    return `${hdr}.${bdy}.${sig}`;
  };

  try {
    const alice = await pds.registerUser("alice-r4.test");
    const bob = await pds.registerUser("bob-r4.test");

    const flow = await completeGroupOAuthFlow({
      groupHost: gh,
      pds,
      user: alice,
      scope: groupAdminScopes().join(" "),
      prompt: "create",
      createParams: {
        displayName: "Round 4 Group",
        handle: "r4.groups.localhost",
        joinPolicy: "open",
        publicMeta: true,
      },
    });
    const dpop = flow.dpop;
    const token = flow.tokenResponse!.access_token;
    const groupDid = flow.tokenResponse!.sub;
    const metaSpace = `at:space/${groupDid}/group.opensocial.meta/self`;
    const membersSpace = `at:space/${groupDid}/group.opensocial.members/self`;

    // 1. Atomic coupling between `meta/self` `policy.publicRead` and `group.opensocial.declaration/self`
    const initDeclRes = await fetch(
      `${gh.url}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(groupDid)}&collection=group.opensocial.declaration&rkey=self`,
    );
    assert.equal(initDeclRes.status, 200);

    // Flipping `meta/self` to `publicRead: false` atomically deletes `declaration/self`!
    const setPrivateRes = await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.updateSpace`, {
      method: "POST",
      accessToken: token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: metaSpace,
        policy: {
          $type: "group.opensocial.policy",
          publicRead: false,
          grants: [{ role: "member", read: true }],
        },
      }),
    });
    assert.equal(setPrivateRes.status, 200);

    const afterPrivDecl = await fetch(
      `${gh.url}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(groupDid)}&collection=group.opensocial.declaration&rkey=self`,
    );
    assert.equal(afterPrivDecl.status, 400);
    assert.equal(((await afterPrivDecl.json()) as { error: string }).error, "RecordNotFound");

    // Publishing `declaration/self` while `meta/self` has `publicRead === false` is rejected (`400 InvalidRequest`)!
    const illegalPutDecl = await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.repo.putRecord`, {
      method: "POST",
      accessToken: token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo: groupDid,
        collection: "group.opensocial.declaration",
        rkey: "self",
        record: {
          $type: "group.opensocial.declaration",
          meta: metaSpace,
          createdAt: new Date().toISOString(),
        },
      }),
    });
    assert.equal(illegalPutDecl.status, 400);
    assert.equal(((await illegalPutDecl.json()) as { error: string }).error, "InvalidRequest");

    // Flipping `meta/self` back to `publicRead: true` atomically creates `declaration/self` and preserves `createdAt` across subsequent `publicRead: true` updates!
    const setPublicRes = await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.updateSpace`, {
      method: "POST",
      accessToken: token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: metaSpace,
        policy: {
          $type: "group.opensocial.policy",
          publicRead: true,
          grants: [{ role: "member", read: true }],
        },
      }),
    });
    assert.equal(setPublicRes.status, 200);

    const restoredDecl = (await (
      await fetch(
        `${gh.url}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(groupDid)}&collection=group.opensocial.declaration&rkey=self`,
      )
    ).json()) as { value: { meta: string; createdAt: string } };
    assert.equal(restoredDecl.value.meta, metaSpace);

    await new Promise((r) => setTimeout(r, 15));
    const setPublicAgainRes = await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.updateSpace`, {
      method: "POST",
      accessToken: token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: metaSpace,
        policy: {
          $type: "group.opensocial.policy",
          publicRead: true,
          grants: [
            { role: "admin", read: true },
            { role: "member", read: true },
          ],
        },
      }),
    });
    assert.equal(setPublicAgainRes.status, 200);
    const preservedDecl = (await (
      await fetch(
        `${gh.url}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(groupDid)}&collection=group.opensocial.declaration&rkey=self`,
      )
    ).json()) as { value: { createdAt: string } };
    assert.equal(preservedDecl.value.createdAt, restoredDecl.value.createdAt);

    // 2. Reject unknown collections in external `group.opensocial.invites/self` (even with `collection=*` scope & `validate: false`, and in `importRepo`)!
    const wildcardInviteScope =
      "space:group.opensocial.invites?authority=*&skey=self&collection=*&action=create&action=update&action=delete";
    gh.db
      .prepare(
        "UPDATE space_record SET value = ? WHERE space_uri = ? AND repo_did = ? AND collection = 'group.opensocial.role' AND rkey = 'admin'",
      )
      .run(
        JSON.stringify({
          $type: "group.opensocial.role",
          displayName: "Admin",
          assignable: ["*"],
          scopes: [...groupAdminScopes(groupDid).filter((s) => s !== "atproto"), wildcardInviteScope],
        }),
        membersSpace,
        groupDid,
      );
    const wildFlow = await completeGroupOAuthFlow({
      groupHost: gh,
      pds,
      user: alice,
      scope: ["atproto", wildcardInviteScope].join(" "),
      loginHint: groupDid,
    });
    const wildDpop = wildFlow.dpop;
    const wildTok = wildFlow.tokenResponse!.access_token;
    const bobInvSpace = `at:space/${bob.did}/group.opensocial.invites/self`;

    const badExtCollectionRes = await wildDpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.putRecord`, {
      method: "POST",
      accessToken: wildTok,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: bobInvSpace,
        repo: groupDid,
        collection: "app.bsky.feed.post",
        rkey: "3jzfcijpj2z2a",
        validate: false,
        record: { text: "Arbitrary external space record", createdAt: new Date().toISOString() },
      }),
    });
    assert.equal(badExtCollectionRes.status, 400);
    assert.equal(((await badExtCollectionRes.json()) as { error: string }).error, "InvalidRequest");

    // Also verify `importSpaceRepoStarStream` rejects non-invite collections in external `invites/self` STAR archives (`400 InvalidRepoFile`)!
    gh.db.prepare("UPDATE group_account SET activated = 0 WHERE did = ?").run(groupDid);
    gh.db
      .prepare(
        `INSERT INTO migration_session (
           id, group_did, mode, source_endpoint, source_plc_rotation_keys_json, preserved_sovereign_keys_json,
           access_jti, refresh_jti, auth_epoch, absolute_deadline_at, created_at
         ) VALUES ('mig-ext-inv-check', ?, 'standard', 'https://src.example', '[]', '[]', 'aj-ext', 'rj-ext', 1, ?, ?)`,
      )
      .run(groupDid, Date.now() + 600_000, Date.now());

    const roguePostSer = await serializeRecord(
      "app.bsky.feed.post" as NsidString,
      "3jzfcijpj2z2a" as RecordKeyString,
      jsonToLex({ $type: "app.bsky.feed.post", text: "Rogue", createdAt: "2026-01-01T00:00:00.000Z" }) as LexMap,
    );
    const rogueStarChunks: Buffer[] = [];
    for await (const chunk of writeRepoStar(
      RepoCommit.fromRecords([roguePostSer]).toCommit({
        space: bobInvSpace as SpaceRefString,
        repo: groupDid as DidString,
        rev: "3kzzzzzzzzzzz",
      }),
      [roguePostSer],
    )) {
      rogueStarChunks.push(Buffer.from(chunk));
    }
    await assert.rejects(
      () =>
        gh.repoStore.importSpaceRepoStarStream({
          groupDid,
          migrationSessionId: "mig-ext-inv-check",
          starStream: [Buffer.concat(rogueStarChunks)],
        }),
      (err: unknown) =>
        (err as { status?: number; code?: string }).status === 400 &&
        (err as { code?: string }).code === "InvalidRepoFile",
    );
    gh.db.prepare("DELETE FROM migration_session WHERE id = 'mig-ext-inv-check'").run();
    gh.db.prepare("UPDATE group_account SET activated = 1 WHERE did = ?").run(groupDid);

    // 3. Cryptographic `clientAttestation` verification on `http://localhost:...`!
    const gatedChan = `at:space/${groupDid}/new.flock.channel/app-gated`;
    const mkGated = await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.createSpace`, {
      method: "POST",
      accessToken: token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        spaceType: "new.flock.channel",
        skey: "app-gated",
        policy: {
          $type: "group.opensocial.policy",
          publicRead: false,
          allowedApps: [localhostClientId],
          grants: [{ role: "admin", read: true, write: true }],
        },
      }),
    });
    assert.equal(mkGated.status, 200);

    const credKp = await P256Keypair.create({ exportable: true });
    const nowSec = Math.floor(Date.now() / 1000);
    const makeDel = () =>
      createDelegationToken({
        iss: alice.did as DidString,
        sub: gatedChan as SpaceRefString,
        aud: spaceHostAud(groupDid as DidString),
        keypair: alice.signingKey,
      });

    // (a) Forged signature on `http://localhost:...` -> `400 InvalidClientAttestation`!
    const forgedLocalAtt = signAttestation(wrongPrivKey, {
      iss: localhostClientId,
      sub: localhostClientId,
      aud: spaceHostAud(groupDid as DidString),
      iat: nowSec,
      exp: nowSec + 60,
      jti: `forged-${randomUUID()}`,
    });
    const forgedRes = await fetch(`${gh.url}/xrpc/com.atproto.space.authorizeSpaceSync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: gatedChan,
        delegationToken: await makeDel(),
        credentialKey: credKp.did(),
        clientAttestation: forgedLocalAtt,
      }),
    });
    assert.equal(forgedRes.status, 400);
    assert.equal(((await forgedRes.json()) as { error: string }).error, "InvalidClientAttestation");

    // (b) Wrong `aud` on `http://localhost:...` -> `400 InvalidClientAttestation`!
    const wrongAudAtt = signAttestation(appPrivKey, {
      iss: localhostClientId,
      sub: localhostClientId,
      aud: "did:plc:wronggroupaaaaaaaaaaaaaa",
      iat: nowSec,
      exp: nowSec + 60,
      jti: `wrong-aud-${randomUUID()}`,
    });
    const wrongAudRes = await fetch(`${gh.url}/xrpc/com.atproto.space.authorizeSpaceSync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: gatedChan,
        delegationToken: await makeDel(),
        credentialKey: credKp.did(),
        clientAttestation: wrongAudAtt,
      }),
    });
    assert.equal(wrongAudRes.status, 400);
    assert.equal(((await wrongAudRes.json()) as { error: string }).error, "InvalidClientAttestation");

    // (c) Valid ES256 signature on `http://localhost:...` -> `200 OK`!
    const validJti = `valid-local-${randomUUID()}`;
    const validLocalAtt = signAttestation(appPrivKey, {
      iss: localhostClientId,
      sub: localhostClientId,
      aud: spaceHostAud(groupDid as DidString),
      iat: nowSec,
      exp: nowSec + 60,
      jti: validJti,
    });
    const validLocalRes = await fetch(`${gh.url}/xrpc/com.atproto.space.authorizeSpaceSync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: gatedChan,
        delegationToken: await makeDel(),
        credentialKey: credKp.did(),
        clientAttestation: validLocalAtt,
      }),
    });
    assert.equal(validLocalRes.status, 200, `Valid localhost clientAttestation failed: ${await validLocalRes.clone().text()}`);

    // (d) Replaying the same `jti` on `http://localhost:...` -> `400 InvalidClientAttestation`!
    const replayLocalRes = await fetch(`${gh.url}/xrpc/com.atproto.space.authorizeSpaceSync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: gatedChan,
        delegationToken: await makeDel(),
        credentialKey: credKp.did(),
        clientAttestation: validLocalAtt,
      }),
    });
    assert.equal(replayLocalRes.status, 400);
    assert.equal(((await replayLocalRes.json()) as { error: string }).error, "InvalidClientAttestation");
  } finally {
    await new Promise<void>((resolve) => appServer.close(() => resolve()));
    await gh.close();
    await pds.close();
    await plc.close();
  }
});

test("Round 7 hardening: anonymous publicRead credentials (writer_did IS NULL) fan out notifyCredentialsRevoked to external space_writer PDSes across deleteSpace, deactivateAccount, cutover signPlcOperation, sole-member leaveGroup, and deleteAccount", async () => {
  const plc = await startMockPlcServer();
  const pdsA = await startMockPersonalPds(plc);
  const pdsB = await startMockPersonalPds(plc);
  const gh = await startTestGroupHost({ plc, handleDomain: "r7cred.groups.localhost" });
  const ghTarget = await startTestGroupHost({ plc, handleDomain: "r7target.groups.localhost" });

  try {
    const alice = await pdsA.registerUser("alice-r7cred.test");
    const bob = await pdsB.registerUser("bob-r7cred.test");

    const flow = await completeGroupOAuthFlow({
      groupHost: gh,
      pds: pdsA,
      user: alice,
      scope: groupAdminScopes().join(" "),
      prompt: "create",
      createParams: {
        displayName: "Round 7 Public Cred Group",
        handle: "r7cred.r7cred.groups.localhost",
        joinPolicy: "open",
        publicMeta: true,
      },
    });
    const dpop = flow.dpop;
    let token = flow.tokenResponse!.access_token;
    const groupDid = flow.tokenResponse!.sub;
    const membersSpace = `at:space/${groupDid}/group.opensocial.members/self`;

    // Create `new.flock.workspace/self` so sole-member `leaveGroup` exercises Flock reversible deactivation!
    const createWsRes = await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.createSpace`, {
      method: "POST",
      accessToken: token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        spaceType: "new.flock.workspace",
        skey: "self",
        policy: {
          $type: "group.opensocial.policy",
          publicRead: false,
          grants: [
            { role: "admin", read: true, write: true },
            { role: "member", read: true },
          ],
        },
      }),
    });
    assert.equal(createWsRes.status, 200);

    // Admit Bob as `member`
    const admitBobRes = await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.putRecord`, {
      method: "POST",
      accessToken: token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: membersSpace,
        repo: groupDid,
        collection: "group.opensocial.membership",
        rkey: bob.did,
        record: {
          $type: "group.opensocial.membership",
          roles: ["member"],
          createdAt: new Date().toISOString(),
        },
      }),
    });
    assert.equal(admitBobRes.status, 200);

    const decodeCredentialJti = (credJwt: string): string =>
      (JSON.parse(Buffer.from(credJwt.split(".")[1]!, "base64url").toString("utf8")) as { jti: string }).jti;

    const createPublicChannelWithWriter = async (skey: string, writer: typeof alice) => {
      const chanUri = `at:space/${groupDid}/new.flock.channel/${skey}`;
      const crRes = await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.createSpace`, {
        method: "POST",
        accessToken: token,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          spaceType: "new.flock.channel",
          skey,
          policy: {
            $type: "group.opensocial.policy",
            publicRead: true,
            grants: [
              { role: "admin", read: true, write: true },
              { role: "member", read: true, write: true },
            ],
          },
        }),
      });
      assert.equal(crRes.status, 200);

      const notifyJwt = await writer.signServiceJwt(`${groupDid}#atproto_pds`, "com.atproto.space.notifyRepoUpdate");
      const nruRes = await fetch(`${gh.url}/xrpc/com.atproto.space.notifyRepoUpdate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${notifyJwt}`,
        },
        body: JSON.stringify({
          space: chanUri,
          repo: writer.did,
          repoRev: "3jzfcijpj2z2a",
          data: { $bytes: Buffer.alloc(32, 7).toString("base64") },
        }),
      });
      assert.equal(nruRes.status, 200);
      return chanUri;
    };

    const mintAnonymousPublicCredential = async (spaceUri: string): Promise<string> => {
      const credKp = await P256Keypair.create({ exportable: true });
      const res = await fetch(`${gh.url}/xrpc/com.atproto.space.authorizeSpaceSync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          space: spaceUri,
          credentialKey: credKp.did(),
          // Intentionally NO delegationToken -> `writer_did` is stored as `NULL`!
        }),
      });
      assert.equal(res.status, 200);
      const { credential } = (await res.json()) as { credential: string };
      const jti = decodeCredentialJti(credential);
      const row = gh.db
        .prepare("SELECT writer_did FROM issued_credential WHERE jti = ?")
        .get(jti) as { writer_did: string | null } | undefined;
      assert.ok(row, "Expected issued_credential row");
      assert.equal(row.writer_did, null, "Anonymous publicRead credential must store writer_did = NULL");
      return jti;
    };

    // 1. `deleteSpace` + deduplication when Bob holds BOTH a delegated credential (`writer_did = bob.did`)
    //    AND an anonymous `publicRead` credential (`writer_did = NULL`) on `pubChan1`!
    const pubChan1 = await createPublicChannelWithWriter("pub-del-space", bob);
    const anonJti1 = await mintAnonymousPublicCredential(pubChan1);
    const bobCredKp = await P256Keypair.create({ exportable: true });
    const bobDelTok = await createDelegationToken({
      iss: bob.did as DidString,
      sub: pubChan1 as SpaceRefString,
      aud: spaceHostAud(groupDid as DidString),
      keypair: bob.signingKey,
    });
    const bobSyncRes = await fetch(`${gh.url}/xrpc/com.atproto.space.authorizeSpaceSync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: pubChan1,
        delegationToken: bobDelTok,
        credentialKey: bobCredKp.did(),
      }),
    });
    assert.equal(bobSyncRes.status, 200);
    const bobDelegatedJti = decodeCredentialJti(((await bobSyncRes.json()) as { credential: string }).credential);

    pdsA.receivedCredentialsRevoked.length = 0;
    pdsB.receivedCredentialsRevoked.length = 0;
    const delSpRes = await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.deleteSpace`, {
      method: "POST",
      accessToken: token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ space: pubChan1 }),
    });
    assert.equal(delSpRes.status, 200);
    await gh.flushBackgroundWork();

    assert.equal(pdsB.receivedCredentialsRevoked.length, 1, "Bob's PDS must receive 1 deduplicated notifyCredentialsRevoked batch on deleteSpace");
    const bobRevClaims = JSON.parse(
      Buffer.from(
        (pdsB.receivedCredentialsRevoked[0]!.authorization ?? "").replace(/^Bearer\s+/i, "").split(".")[1]!,
        "base64url",
      ).toString("utf8"),
    ) as { iss: string; aud: string; lxm: string };
    assert.equal(bobRevClaims.iss, groupDid);
    assert.equal(bobRevClaims.aud, bob.did);
    assert.equal(bobRevClaims.lxm, "com.atproto.space.notifyCredentialsRevoked");
    assert.deepEqual(
      [...pdsB.receivedCredentialsRevoked[0]!.credentials].sort(),
      [anonJti1, bobDelegatedJti].sort(),
      "deleteSpace must fan out writer_did=NULL JTI alongside delegated JTI without duplicates",
    );
    assert.equal(pdsA.receivedCredentialsRevoked.length, 0, "Alice is not a writer on pubChan1");

    // 2. `deactivateAccount` fans out `writer_did = NULL` credential to external writers (`alice` & `bob`)!
    const pubChan2 = await createPublicChannelWithWriter("pub-deact", bob);
    // Also register Alice as an external writer on `pubChan2` so multi-writer fanout (`alice` + `bob`) is verified!
    const aliceNruJwt = await alice.signServiceJwt(`${groupDid}#atproto_pds`, "com.atproto.space.notifyRepoUpdate");
    const aliceNruRes = await fetch(`${gh.url}/xrpc/com.atproto.space.notifyRepoUpdate`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${aliceNruJwt}` },
      body: JSON.stringify({
        space: pubChan2,
        repo: alice.did,
        repoRev: "3jzfcijpj2z2b",
        data: { $bytes: Buffer.alloc(32, 8).toString("base64") },
      }),
    });
    assert.equal(aliceNruRes.status, 200);

    const anonJtiDeact = await mintAnonymousPublicCredential(pubChan2);
    pdsA.receivedCredentialsRevoked.length = 0;
    pdsB.receivedCredentialsRevoked.length = 0;

    const deactRes = await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.server.deactivateAccount`, {
      method: "POST",
      accessToken: token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(deactRes.status, 200);
    await gh.flushBackgroundWork();

    assert.equal(pdsA.receivedCredentialsRevoked.length, 1, "Alice's PDS must receive public-read revocation on deactivateAccount");
    assert.deepEqual(pdsA.receivedCredentialsRevoked[0]!.credentials, [anonJtiDeact]);
    assert.equal(pdsB.receivedCredentialsRevoked.length, 1, "Bob's PDS must receive public-read revocation on deactivateAccount");
    assert.deepEqual(pdsB.receivedCredentialsRevoked[0]!.credentials, [anonJtiDeact]);

    // Reactivate via `recovery` OAuth flow so we can test cutover `signPlcOperation`, sole-member `leaveGroup`, and `deleteAccount`!
    const recovFlow = await completeGroupOAuthFlow({
      groupHost: gh,
      pds: pdsA,
      user: alice,
      scope: groupAdminScopes().join(" "),
      prompt: "login",
      loginHint: groupDid,
    });
    const actRes = await recovFlow.dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.server.activateAccount`, {
      method: "POST",
      accessToken: recovFlow.tokenResponse!.access_token,
    });
    assert.equal(actRes.status, 200);

    const reauthFlow = await completeGroupOAuthFlow({
      groupHost: gh,
      pds: pdsA,
      user: alice,
      scope: groupAdminScopes().join(" "),
      prompt: "login",
      loginHint: groupDid,
    });
    token = reauthFlow.tokenResponse!.access_token;
    const dpop2 = reauthFlow.dpop;

    // 3. Cutover `signPlcOperation` fans out `writer_did = NULL` credential to external writers before signing cutover!
    const anonJtiCutover = await mintAnonymousPublicCredential(pubChan2);
    pdsA.receivedCredentialsRevoked.length = 0;
    pdsB.receivedCredentialsRevoked.length = 0;

    await dpop2.fetchWithDpop(`${gh.url}/xrpc/com.atproto.identity.requestPlcOperationSignature`, {
      method: "POST",
      accessToken: token,
    });
    const cutTok = (
      (await (
        await dpop2.fetchWithDpop(`${gh.url}/group-admin/claim-action-token`, {
          method: "POST",
          accessToken: token,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ group: groupDid, purpose: "plc_operation" }),
        })
      ).json()) as { token: string }
    ).token;
    const targetTempRot = await P256Keypair.create();
    const targetTempSign = await P256Keypair.create();
    const targetTempKem = await P256Keypair.create();
    const signCutRes = await dpop2.fetchWithDpop(`${gh.url}/xrpc/com.atproto.identity.signPlcOperation`, {
      method: "POST",
      accessToken: token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: cutTok,
        rotationKeys: [targetTempRot.did()],
        alsoKnownAs: ["at://r7cred.r7target.groups.localhost"],
        verificationMethods: {
          atproto: targetTempSign.did(),
          atproto_kem: targetTempKem.did(),
        },
        services: {
          atproto_pds: { type: "AtprotoPersonalDataServer", endpoint: ghTarget.url },
          opensocial_group: { type: "OpenSocialGroupHost", endpoint: ghTarget.url },
        },
      }),
    });
    assert.equal(signCutRes.status, 200);
    assert.equal(pdsA.receivedCredentialsRevoked.length, 1, "Alice's PDS must receive public-read revocation on cutover signPlcOperation");
    assert.deepEqual(pdsA.receivedCredentialsRevoked[0]!.credentials, [anonJtiCutover]);
    assert.equal(pdsB.receivedCredentialsRevoked.length, 1, "Bob's PDS must receive public-read revocation on cutover signPlcOperation");
    assert.deepEqual(pdsB.receivedCredentialsRevoked[0]!.credentials, [anonJtiCutover]);

    // Abort cutover lease (`abort-migration` advances PLC head and thaws `gh`)
    const abortCutRes = await dpop2.fetchWithDpop(`${gh.url}/group-admin/abort-migration`, {
      method: "POST",
      accessToken: token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ group: groupDid }),
    });
    assert.equal(abortCutRes.status, 200);

    // 4. Sole-member `leaveGroup` fans out `writer_did = NULL` credential to external writer (`alice`) BEFORE marking writers `removed = 1`!
    // First remove Bob so Alice is the sole member (while Alice remains `removed = 0` in `space_writer` on `pubChan2`!)
    const removeBobRes = await dpop2.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.deleteRecord`, {
      method: "POST",
      accessToken: token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: membersSpace,
        repo: groupDid,
        collection: "group.opensocial.membership",
        rkey: bob.did,
      }),
    });
    assert.equal(removeBobRes.status, 200);
    await gh.flushBackgroundWork();

    const anonJtiSoleLeave = await mintAnonymousPublicCredential(pubChan2);
    pdsA.receivedCredentialsRevoked.length = 0;
    const leaveJwt = await alice.signServiceJwt(`${groupDid}#atproto_pds`, "group.opensocial.leaveGroup");
    const soleLeaveRes = await fetch(`${gh.url}/xrpc/group.opensocial.leaveGroup`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${leaveJwt}` },
      body: JSON.stringify({ group: groupDid }),
    });
    assert.equal(soleLeaveRes.status, 200);
    await gh.flushBackgroundWork();

    assert.equal(pdsA.receivedCredentialsRevoked.length, 1, "Alice's PDS must receive public-read revocation on sole-member leaveGroup");
    assert.deepEqual(pdsA.receivedCredentialsRevoked[0]!.credentials, [anonJtiSoleLeave]);

    // 5. `deleteAccount` fans out `writer_did = NULL` credential to external writer (`alice`) during `remote_cleanup_queued` -> `remote_cleanup_drained`!
    // Reactivate, re-register Alice as external writer on `pubChan2`, mint anonymous credential, then `deleteAccount`!
    const recovFlow2 = await completeGroupOAuthFlow({
      groupHost: gh,
      pds: pdsA,
      user: alice,
      scope: groupAdminScopes().join(" "),
      prompt: "login",
      loginHint: groupDid,
    });
    await recovFlow2.dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.server.activateAccount`, {
      method: "POST",
      accessToken: recovFlow2.tokenResponse!.access_token,
    });
    const activeFlow3 = await completeGroupOAuthFlow({
      groupHost: gh,
      pds: pdsA,
      user: alice,
      scope: groupAdminScopes().join(" "),
      prompt: "login",
      loginHint: groupDid,
    });
    const dpop3 = activeFlow3.dpop;
    const tok3 = activeFlow3.tokenResponse!.access_token;

    const aliceNruJwt2 = await alice.signServiceJwt(`${groupDid}#atproto_pds`, "com.atproto.space.notifyRepoUpdate");
    const aliceNruRes2 = await fetch(`${gh.url}/xrpc/com.atproto.space.notifyRepoUpdate`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${aliceNruJwt2}` },
      body: JSON.stringify({
        space: pubChan2,
        repo: alice.did,
        repoRev: "3jzfcijpj2z2z",
        data: { $bytes: Buffer.alloc(32, 9).toString("base64") },
      }),
    });
    assert.equal(aliceNruRes2.status, 200);

    const anonJtiDelete = await mintAnonymousPublicCredential(pubChan2);
    pdsA.receivedCredentialsRevoked.length = 0;

    await dpop3.fetchWithDpop(`${gh.url}/xrpc/com.atproto.server.requestAccountDelete`, {
      method: "POST",
      accessToken: tok3,
    });
    const delToken = (
      (await (
        await dpop3.fetchWithDpop(`${gh.url}/group-admin/claim-action-token`, {
          method: "POST",
          accessToken: tok3,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ group: groupDid, purpose: "delete_account" }),
        })
      ).json()) as { token: string }
    ).token;
    const delAcctRes = await dpop3.fetchWithDpop(`${gh.url}/xrpc/com.atproto.server.deleteAccount`, {
      method: "POST",
      accessToken: tok3,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ did: groupDid, token: delToken }),
    });
    assert.equal(delAcctRes.status, 200);

    assert.equal(pdsA.receivedCredentialsRevoked.length, 1, "Alice's PDS must receive public-read revocation on deleteAccount");
    assert.deepEqual(pdsA.receivedCredentialsRevoked[0]!.credentials, [anonJtiDelete]);
  } finally {
    await ghTarget.close();
    await gh.close();
    await pdsB.close();
    await pdsA.close();
    await plc.close();
  }
});


test("Round 9 hardening: streamed migration writes (importRepo, uploadBlob, importSpaceMeta, space.importRepo) enforce absolute_deadline_at at commit time with zero staged mutations", async () => {
  const plc = await startMockPlcServer();
  const pds = await startMockPersonalPds(plc);
  const ghSrc = await startTestGroupHost({ plc, handleDomain: "src9.groups.localhost" });
  const ghDst = await startTestGroupHost({ plc, handleDomain: "dst9.groups.localhost" });

  try {
    const alice = await pds.registerUser("alice-r9.test");
    const flowSrc = await completeGroupOAuthFlow({
      groupHost: ghSrc,
      pds,
      user: alice,
      scope: groupAdminScopes().join(" "),
      prompt: "create",
      createParams: {
        displayName: "Stream Deadline Group",
        handle: "deadline.src9.groups.localhost",
        joinPolicy: "open",
        publicMeta: true,
      },
    });
    const dpopSrc = flowSrc.dpop;
    const tokSrc = flowSrc.tokenResponse!.access_token;
    const groupDid = flowSrc.tokenResponse!.sub;
    const srcSigKey = await ghSrc.repoStore.getGroupSigningKey(groupDid);

    const metaSpace = `at:space/${groupDid}/group.opensocial.meta/self`;
    const carBytes = new Uint8Array(
      await (await fetch(`${ghSrc.url}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(groupDid)}`)).arrayBuffer(),
    );
    const metaStarBytes = new Uint8Array(
      await (
        await dpopSrc.fetchWithDpop(
          `${ghSrc.url}/xrpc/com.atproto.space.exportSpaceMeta?space=${encodeURIComponent(metaSpace)}`,
          { method: "GET", accessToken: tokSrc },
        )
      ).arrayBuffer(),
    );
    const repoStarBytes = new Uint8Array(
      await (
        await dpopSrc.fetchWithDpop(
          `${ghSrc.url}/xrpc/com.atproto.space.getRepo?space=${encodeURIComponent(metaSpace)}&repo=${encodeURIComponent(groupDid)}`,
          { method: "GET", accessToken: tokSrc },
        )
      ).arrayBuffer(),
    );

    const stageWithShortDeadline = async (opId: string, deadlineOffsetMs: number) => {
      const jwt = await createServiceJwt({
        iss: groupDid,
        aud: ghDst.config.serviceDid,
        lxm: "com.atproto.server.createAccount",
        keypair: srcSigKey,
      });
      const res = await fetch(`${ghDst.url}/xrpc/com.atproto.server.createAccount`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${jwt}`,
          "x-group-migration-operation-id": opId,
        },
        body: JSON.stringify({ did: groupDid, handle: "deadline.dst9.groups.localhost" }),
      });
      assert.equal(res.status, 200);
      const sessRow = ghDst.db
        .prepare("SELECT id FROM migration_session WHERE group_did = ?")
        .get(groupDid) as { id: string };
      const deadlineAt = Date.now() + deadlineOffsetMs;
      ghDst.db
        .prepare("UPDATE migration_session SET absolute_deadline_at = ? WHERE id = ?")
        .run(deadlineAt, sessRow.id);
      return { sessionId: sessRow.id, deadlineAt };
    };

    async function* slowChunkStream(payload: Uint8Array, pauseMs: number): AsyncGenerator<Uint8Array> {
      const split = Math.max(1, Math.floor(payload.byteLength / 2));
      yield payload.subarray(0, split);
      await new Promise((r) => setTimeout(r, pauseMs));
      yield payload.subarray(split);
    }

    // 1. `importPublicRepoCar` started BEFORE `absolute_deadline_at` and finishing AFTER -> `401 ExpiredToken` + zero public_record rows!
    const st1 = await stageWithShortDeadline("op-r9-stream-car", 70);
    await assert.rejects(
      () =>
        ghDst.repoStore.importPublicRepoCar({
          groupDid,
          migrationSessionId: st1.sessionId,
          carStream: slowChunkStream(carBytes, 120),
        }),
      (err: unknown) =>
        (err as { status?: number; code?: string }).status === 401 &&
        (err as { code?: string }).code === "ExpiredToken",
    );
    assert.equal(
      (ghDst.db.prepare("SELECT COUNT(*) AS cnt FROM public_record WHERE group_did = ?").get(groupDid) as { cnt: number })
        .cnt,
      0,
      "Expired importPublicRepoCar stream must commit zero public_record rows",
    );

    // 2. `uploadBlob` started BEFORE `absolute_deadline_at` and finishing AFTER -> `401 ExpiredToken` + zero blob_store rows!
    const st2 = await stageWithShortDeadline("op-r9-stream-blob", 70);
    await assert.rejects(
      () =>
        ghDst.repoStore.uploadBlob({
          groupDid,
          mimeType: "image/png",
          migrationSessionId: st2.sessionId,
          bodyStream: slowChunkStream(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]), 120),
        }),
      (err: unknown) =>
        (err as { status?: number; code?: string }).status === 401 &&
        (err as { code?: string }).code === "ExpiredToken",
    );
    assert.equal(
      (ghDst.db.prepare("SELECT COUNT(*) AS cnt FROM blob_store WHERE group_did = ?").get(groupDid) as { cnt: number })
        .cnt,
      0,
      "Expired uploadBlob stream must commit zero blob_store rows",
    );

    // 3. `importSpaceMetaStream` started BEFORE `absolute_deadline_at` and finishing AFTER -> `401 ExpiredToken` + zero group_space rows!
    const st3 = await stageWithShortDeadline("op-r9-stream-meta", 70);
    await assert.rejects(
      () =>
        ghDst.repoStore.importSpaceMetaStream({
          groupDid,
          migrationSessionId: st3.sessionId,
          starStream: slowChunkStream(metaStarBytes, 120),
        }),
      (err: unknown) =>
        (err as { status?: number; code?: string }).status === 401 &&
        (err as { code?: string }).code === "ExpiredToken",
    );
    assert.equal(
      (ghDst.db.prepare("SELECT COUNT(*) AS cnt FROM group_space WHERE group_did = ?").get(groupDid) as { cnt: number })
        .cnt,
      0,
      "Expired importSpaceMetaStream must commit zero group_space rows",
    );

    // 4. `importSpaceRepoStarStream` started BEFORE `absolute_deadline_at` (even with explicit `nowMs` passed!)
    //    and finishing AFTER -> `401 ExpiredToken` + zero space_repo / space_record rows!
    const st4 = await stageWithShortDeadline("op-r9-stream-star", 200);
    // Stage meta/self quickly while still well before deadline so `importSpaceRepoStarStream` would otherwise succeed
    await ghDst.repoStore.importSpaceMetaStream({
      groupDid,
      migrationSessionId: st4.sessionId,
      starStream: [metaStarBytes],
    });
    const remainingBeforeDeadline = Math.max(20, st4.deadlineAt - Date.now());
    const explicitStartNowMs = st4.deadlineAt - 40;
    await assert.rejects(
      () =>
        ghDst.repoStore.importSpaceRepoStarStream({
          groupDid,
          migrationSessionId: st4.sessionId,
          starStream: slowChunkStream(repoStarBytes, remainingBeforeDeadline + 80),
          nowMs: explicitStartNowMs,
        }),
      (err: unknown) =>
        (err as { status?: number; code?: string }).status === 401 &&
        (err as { code?: string }).code === "ExpiredToken",
    );
    assert.equal(
      (ghDst.db.prepare("SELECT COUNT(*) AS cnt FROM space_repo WHERE repo_did = ?").get(groupDid) as { cnt: number })
        .cnt,
      0,
      "Expired importSpaceRepoStarStream must commit zero space_repo rows even when caller passed initial nowMs",
    );
  } finally {
    await ghDst.close();
    await ghSrc.close();
    await pds.close();
    await plc.close();
  }
});

test("Round 13 Fix #3: sweepIncompleteDeletionJournals paginates past >20 and >200 PLC-failing journals without starving valid deletions", async () => {
  const plc = await startMockPlcServer();
  const pds = await startMockPersonalPds(plc);
  const gh = await startTestGroupHost({ plc, handleDomain: "del-r13.localhost" });

  try {
    const alice = await pds.registerUser("alice.test");

    const createAndStartInterruptedDelete = async (handle: string): Promise<string> => {
      const flow = await completeGroupOAuthFlow({
        groupHost: gh,
        pds,
        user: alice,
        scope: groupAdminScopes().join(" "),
        prompt: "create",
        createParams: {
          displayName: `Delete Sweep ${handle}`,
          handle,
          joinPolicy: "invite",
          publicMeta: true,
        },
      });
      const groupDid = flow.tokenResponse!.sub;
      const stepUpFlow = await completeGroupOAuthFlow({
        groupHost: gh,
        pds,
        user: alice,
        scope: groupAdminScopes().join(" "),
        prompt: "login",
        loginHint: groupDid,
      });
      const dpop = stepUpFlow.dpop;
      const accessToken = stepUpFlow.tokenResponse!.access_token;

      const reqDelRes = await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.server.requestAccountDelete`, {
        method: "POST",
        accessToken,
      });
      assert.equal(reqDelRes.status, 200);
      const claimRes = await dpop.fetchWithDpop(`${gh.url}/group-admin/claim-action-token`, {
        method: "POST",
        accessToken,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ group: groupDid, purpose: "delete_account" }),
      });
      assert.equal(claimRes.status, 200);
      const { token: confirmToken } = (await claimRes.json()) as { token: string };

      // Temporarily reject PLC tombstone so `deleteAccount` leaves journal at `remote_cleanup_drained` (`502 PlcTombstoneRejected`)!
      plc.interceptPost = (_did, op) =>
        op.type === "plc_tombstone" ? { status: 503, body: { message: "transient PLC outage" } } : null;

      const delRes = await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.server.deleteAccount`, {
        method: "POST",
        accessToken,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ did: groupDid, password: groupDid, token: confirmToken }),
      });
      assert.equal(delRes.status, 502);
      assert.equal(
        (gh.db.prepare("SELECT status FROM group_deletion_journal WHERE group_did = ?").get(groupDid) as { status: string }).status,
        "remote_cleanup_drained",
      );
      plc.interceptPost = undefined;
      return groupDid;
    };

    const groupDidA = await createAndStartInterruptedDelete("sweep-a.del-r13.localhost");
    const groupDidB = await createAndStartInterruptedDelete("sweep-b.del-r13.localhost");

    // Seed synthetic permanently-failing `group_deletion_journal` rows with `did:plc:0000...` (`'0' < '[a-z2-7]'` so ALL sort before `groupDidA`/`groupDidB`)!
    // Give each synthetic DID a live PLC log op pointing to `gh.url` + matching rotation key so `settleDeleteAccountPlcTombstone`
    // submits a tombstone to `plc` where `plc.interceptPost` returns `400 Bad Request` (`502 PlcTombstoneRejected`)!
    const stuckRotKey = await P256Keypair.create({ exportable: true });
    const seedFailingDeletionRange = async (startIdx: number, endExclusive: number) => {
      const now = Date.now();
      const insJournal = gh.db.prepare(
        `INSERT INTO group_deletion_journal (group_did, actor_did, plc_outcome, status, updated_at)
         VALUES (?, ?, NULL, 'remote_cleanup_drained', ?)`,
      );
      const insAcct = gh.db.prepare(
        `INSERT INTO group_account (did, handle, signing_key_enc, kem_key_enc, rotation_key_enc, activated, takendown, auth_epoch, created_at)
         VALUES (?, ?, 'enc', 'enc', ?, 0, 1, 2, ?)`,
      );
      for (let i = startIdx; i < endExclusive; i += 1) {
        const pad = String(i).padStart(4, "0");
        const fakeDid = `did:plc:00000000000000000000${pad}`;
        const rotEnc = await gh.cryptoBox.encryptKeypair(
          "group_account",
          fakeDid,
          "rotation_key_enc",
          stuckRotKey,
        );
        plc.opsByDid.set(fakeDid, [
          {
            type: "plc_operation",
            prev: null,
            sig: "fake-sig",
            rotationKeys: [stuckRotKey.did()],
            verificationMethods: { atproto: stuckRotKey.did() },
            alsoKnownAs: [`at://stuck-${pad}.del-r13.localhost`],
            services: {
              atproto_pds: {
                type: "AtprotoPersonalDataServer",
                endpoint: gh.url,
              },
            },
          },
        ]);
        insAcct.run(fakeDid, `stuck-${pad}.del-r13.localhost`, rotEnc, now);
        insJournal.run(fakeDid, alice.did, now);
      }
    };

    // Part 1: 25 permanently failing journals (> `PAGE_SIZE = 20`) + `groupDidA` allowed to succeed (keep `groupDidB` blocked for Part 2)
    await seedFailingDeletionRange(0, 25);
    plc.interceptPost = (did, op) => {
      if (op.type === "plc_tombstone" && (did.startsWith("did:plc:0000") || did === groupDidB)) {
        return { status: 400, body: { message: "PLC rejected tombstone" } };
      }
      return null;
    };

    await gh.flushBackgroundWork();

    assert.equal(
      (
        gh.db
          .prepare("SELECT COUNT(*) AS cnt FROM group_deletion_journal WHERE group_did LIKE 'did:plc:0000%' AND status = 'remote_cleanup_drained'")
          .get() as { cnt: number }
      ).cnt,
      25,
      "All 25 permanently failing journals remain in remote_cleanup_drained",
    );
    const rowA = gh.db
      .prepare("SELECT status, plc_outcome FROM group_deletion_journal WHERE group_did = ?")
      .get(groupDidA) as { status: string; plc_outcome: string };
    assert.deepEqual(rowA, { status: "purged", plc_outcome: "tombstoned" });
    assert.equal((await fetch(`${plc.url}/${encodeURIComponent(groupDidA)}`)).status, 410);
    for (const table of SCHEMA_TABLE_CLASSIFICATION.GROUP_PURGED_TABLES) {
      const col = table === "group_account" ? "did" : table === "space_repo" || table === "space_record" || table === "space_oplog" ? "repo_did" : "group_did";
      const count = (gh.db.prepare(`SELECT COUNT(*) AS cnt FROM ${table} WHERE ${col} = ?`).get(groupDidA) as { cnt: number }).cnt;
      assert.equal(count, 0, `Table ${table} must have zero residue for purged ${groupDidA}`);
    }

    // Part 2: Seed up to 205 failing journals (> `MAX_PER_SWEEP = 200`) and unblock `groupDidB`!
    // Sweep 1 scans 200 failing journals and persists cursor; Sweep 2 resumes past 200..204 and purges `groupDidB`!
    await seedFailingDeletionRange(25, 205);
    plc.interceptPost = (did, op) => {
      if (op.type === "plc_tombstone" && did.startsWith("did:plc:0000")) {
        return { status: 400, body: { message: "PLC rejected tombstone" } };
      }
      return null;
    };

    await gh.repoStore.sweepIncompleteDeletionJournals();
    assert.equal(
      (gh.db.prepare("SELECT status FROM group_deletion_journal WHERE group_did = ?").get(groupDidB) as { status: string }).status,
      "remote_cleanup_drained",
      "First bounded sweep stops at 200 journals and persists keyset cursor",
    );

    await gh.repoStore.sweepIncompleteDeletionJournals();
    const rowB = gh.db
      .prepare("SELECT status, plc_outcome FROM group_deletion_journal WHERE group_did = ?")
      .get(groupDidB) as { status: string; plc_outcome: string };
    assert.deepEqual(
      rowB,
      { status: "purged", plc_outcome: "tombstoned" },
      "Second sweep MUST resume past 200 failing journals and tombstone + purge groupDidB",
    );
    assert.equal((await fetch(`${plc.url}/${encodeURIComponent(groupDidB)}`)).status, 410);
  } finally {
    await gh.close();
    await pds.close();
    await plc.close();
  }
});
