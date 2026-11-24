import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { P256Keypair } from "@atproto/crypto";
import { createServiceJwt } from "@atproto/xrpc-server";
import { groupAdminScopes } from "@flock/protocol/scopes";
import * as jose from "jose";
import { reapExpiredPreparedMigrationLease } from "./rbac";
import {
  completeGroupOAuthFlow,
  startMockPersonalPds,
  startMockPlcServer,
  startTestGroupHost,
} from "./test-harness";

async function createSteppedUpGroupFlow(
  params: Parameters<typeof completeGroupOAuthFlow>[0],
): ReturnType<typeof completeGroupOAuthFlow> {
  const created = await completeGroupOAuthFlow(params);
  assert.ok(created.tokenResponse, "Expected tokenResponse from prompt=create");
  return completeGroupOAuthFlow({
    groupHost: params.groupHost,
    pds: params.pds,
    user: params.user,
    scope: params.scope,
    prompt: "login",
    loginHint: created.tokenResponse.sub,
  });
}

test("Two-GroupHost Coordinated v1 migration (A -> B) + Standard return-to-prior-host migration (B -> A) + UnsupportedGroupHostTarget & ProvenanceRequired checks", async () => {
  const plc = await startMockPlcServer();
  const pds = await startMockPersonalPds(plc);
  const ghA = await startTestGroupHost({ plc, handleDomain: "a.groups.localhost" });
  const ghB = await startTestGroupHost({ plc, handleDomain: "b.groups.localhost" });

  try {
    const alice = await pds.registerUser("alice.test");
    const bob = await pds.registerUser("bob.test");
    const adminScopeStr = groupAdminScopes().join(" ");

    // 1. Create group on `ghA`, add external sovereign PLC rotation key, upload a 2.5 MiB (> 2 MB) blob, and send an external invite!
    const flowA = await createSteppedUpGroupFlow({
      groupHost: ghA,
      pds,
      user: alice,
      scope: adminScopeStr,
      prompt: "create",
      createParams: {
        displayName: "Migrating Team",
        handle: "team.a.groups.localhost",
        joinPolicy: "invite",
        publicMeta: true,
      },
    });
    const dpopA = flowA.dpop;
    const tokA = flowA.tokenResponse!.access_token;
    const groupDid = flowA.tokenResponse!.sub;

    // Add external sovereign PLC rotation key (`sovKey`)
    const sovKey = await P256Keypair.create({ exportable: true });
    await dpopA.fetchWithDpop(`${ghA.url}/xrpc/com.atproto.identity.requestPlcOperationSignature`, {
      method: "POST",
      accessToken: tokA,
    });
    const claimSov = await dpopA.fetchWithDpop(`${ghA.url}/group-admin/claim-action-token`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ group: groupDid, purpose: "plc_operation" }),
    });
    const sovPlcTok = ((await claimSov.json()) as { token: string }).token;
    const lastOpBefore = (await (await fetch(`${plc.url}/${encodeURIComponent(groupDid)}/log/last`)).json()) as {
      rotationKeys: string[];
    };
    const signedSov = await dpopA.fetchWithDpop(`${ghA.url}/xrpc/com.atproto.identity.signPlcOperation`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: sovPlcTok,
        rotationKeys: [...lastOpBefore.rotationKeys, sovKey.did()],
      }),
    });
    const { operation: sovOp } = (await signedSov.json()) as { operation: Record<string, unknown> };
    const subSov = await dpopA.fetchWithDpop(`${ghA.url}/xrpc/com.atproto.identity.submitPlcOperation`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: sovOp }),
    });
    assert.equal(subSov.status, 200);

    // Upload a 1.5 MiB blob + reference it in `profile/self` avatar so blob migration & integrity verification run!
    const largeBlobBytes = randomBytes(1_500_000);
    const upBlobRes = await dpopA.fetchWithDpop(`${ghA.url}/xrpc/com.atproto.repo.uploadBlob`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "image/png" },
      body: Uint8Array.from(largeBlobBytes),
    });
    assert.equal(upBlobRes.status, 200);
    const uploadedBlob = ((await upBlobRes.json()) as { blob: Record<string, unknown> }).blob;

    const metaSpace = `at://${groupDid}/space/group.opensocial.meta/self`;
    const putProfBlob = await dpopA.fetchWithDpop(`${ghA.url}/xrpc/com.atproto.space.putRecord`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: metaSpace,
        repo: groupDid,
        collection: "group.opensocial.profile",
        rkey: "self",
        record: {
          $type: "group.opensocial.profile",
          displayName: "Migrating Team",
          avatar: uploadedBlob,
          joinPolicy: "invite",
          createdAt: new Date().toISOString(),
        },
      }),
    });
    assert.equal(putProfBlob.status, 200);

    // Create an external invite for Bob so external `invites/self` STAR migration runs too!
    const bobInvSpace = `at://${bob.did}/space/group.opensocial.invites/self`;
    await dpopA.fetchWithDpop(`${ghA.url}/xrpc/com.atproto.space.putRecord`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: bobInvSpace,
        repo: groupDid,
        collection: "group.opensocial.invite",
        rkey: "3jzfcijpj2z2a",
        record: {
          $type: "group.opensocial.invite",
          createdBy: alice.did,
          createdAt: new Date().toISOString(),
        },
      }),
    });
    await ghA.flushBackgroundWork();

    // 2. Negative checks:
    //    (a) `getServiceAuth` rejects `PROTECTED_METHODS` (`deleteAccount`, `submitPlcOperation`) -> `400`!
    const protAuthRes = await dpopA.fetchWithDpop(
      `${ghA.url}/xrpc/com.atproto.server.getServiceAuth?aud=${encodeURIComponent(ghB.config.serviceDid)}&lxm=com.atproto.server.deleteAccount`,
      { method: "GET", accessToken: tokA },
    );
    assert.equal(protAuthRes.status, 400);

    //    (b) `prepare-migration` against bare personal PDS (`pds.url`, lacking `OpenSocialGroupHost` capability) -> `400 UnsupportedGroupHostTarget`!
    const badTargetPrep = await dpopA.fetchWithDpop(`${ghA.url}/group-admin/prepare-migration`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        group: groupDid,
        operationId: "op-bad-target",
        targetEndpoint: pds.url,
      }),
    });
    assert.equal(badTargetPrep.status, 400);
    assert.equal(((await badTargetPrep.json()) as { error: string }).error, "UnsupportedGroupHostTarget");

    // 3. Coordinated v1 migration (`ghA -> ghB`):
    const coordOpId = `coord-${randomUUID()}`;
    const prep1 = await dpopA.fetchWithDpop(`${ghA.url}/group-admin/prepare-migration`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        group: groupDid,
        operationId: coordOpId,
        targetEndpoint: ghB.url,
      }),
    });
    assert.equal(prep1.status, 200, `prepare-migration failed: ${await prep1.clone().text()}`);
    const prepBody = (await prep1.json()) as {
      migrationTicket: string;
      targetServiceDid: string;
      manifestDigest: string;
    };
    assert.equal(prepBody.migrationTicket.length, 83, "Coordinated migration ticket must be exact fixed 83 bytes");

    // Offline-safe idempotent replay of `prepare-migration` with same `(group, operationId, targetEndpoint)` returns `200` with identical `migrationTicket`!
    const prepReplay = await dpopA.fetchWithDpop(`${ghA.url}/group-admin/prepare-migration`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        group: groupDid,
        operationId: coordOpId,
        targetEndpoint: ghB.url,
      }),
    });
    assert.equal(prepReplay.status, 200);
    assert.equal(((await prepReplay.json()) as { migrationTicket: string }).migrationTicket, prepBody.migrationTicket);

    // Source mutations are frozen (`409 MigrationInProgress`) while prepared lease is active!
    const frozenWrite = await dpopA.fetchWithDpop(`${ghA.url}/xrpc/com.atproto.space.putRecord`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: metaSpace,
        repo: groupDid,
        collection: "group.opensocial.rule",
        rkey: "3jzfcijpj2z2a",
        record: { $type: "group.opensocial.rule", title: "Frozen", createdAt: new Date().toISOString() },
      }),
    });
    assert.equal(frozenWrite.status, 409);
    assert.equal(((await frozenWrite.json()) as { error: string }).error, "MigrationInProgress");

    // Obtain `createAccount` service JWT from `ghA` -> stage on `ghB` with `X-Group-Migration-Ticket`!
    const svcAuthRes = await dpopA.fetchWithDpop(
      `${ghA.url}/xrpc/com.atproto.server.getServiceAuth?aud=${encodeURIComponent(ghB.config.serviceDid)}&lxm=com.atproto.server.createAccount`,
      { method: "GET", accessToken: tokA },
    );
    assert.equal(svcAuthRes.status, 200);
    const { token: createAcctJwt } = (await svcAuthRes.json()) as { token: string };

    const createBRes = await fetch(`${ghB.url}/xrpc/com.atproto.server.createAccount`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${createAcctJwt}`,
        "x-group-migration-ticket": prepBody.migrationTicket,
      },
      body: JSON.stringify({
        did: groupDid,
        handle: "team.b.groups.localhost",
      }),
    });
    assert.equal(createBRes.status, 200, `Target createAccount failed: ${await createBRes.clone().text()}`);
    const sessB1 = (await createBRes.json()) as {
      accessJwt: string;
      refreshJwt: string;
      did: string;
      handle: string;
    };
    assert.equal(sessB1.did, groupDid);

    // Rotate migration session via `refreshSession` (`refreshJwt` accepted; `accessJwt` rejected on `refreshSession`)
    const badRefreshWithAccess = await fetch(`${ghB.url}/xrpc/com.atproto.server.refreshSession`, {
      method: "POST",
      headers: { authorization: `Bearer ${sessB1.accessJwt}` },
    });
    assert.equal(badRefreshWithAccess.status, 401);

    const goodRefreshB = await fetch(`${ghB.url}/xrpc/com.atproto.server.refreshSession`, {
      method: "POST",
      headers: { authorization: `Bearer ${sessB1.refreshJwt}` },
    });
    assert.equal(goodRefreshB.status, 200);
    const sessB = (await goodRefreshB.json()) as { accessJwt: string; refreshJwt: string };

    // Copy public CAR (`sync.getRepo` -> `repo.importRepo`)
    const carBytes = Buffer.from(
      await (await fetch(`${ghA.url}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(groupDid)}`)).arrayBuffer(),
    );
    const impCarRes = await fetch(`${ghB.url}/xrpc/com.atproto.repo.importRepo`, {
      method: "POST",
      headers: {
        "content-type": "application/vnd.ipld.car",
        authorization: `Bearer ${sessB.accessJwt}`,
      },
      body: carBytes,
    });
    assert.equal(impCarRes.status, 200);

    // Copy blobs (`sync.listBlobs` -> `sync.getBlob` -> `repo.uploadBlob`)
    const blobsList = (await (
      await fetch(`${ghA.url}/xrpc/com.atproto.sync.listBlobs?did=${encodeURIComponent(groupDid)}`)
    ).json()) as { cids: string[] };
    assert.equal(blobsList.cids.length, 1);
    for (const cid of blobsList.cids) {
      const bRes = await fetch(
        `${ghA.url}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(groupDid)}&cid=${encodeURIComponent(cid)}`,
      );
      const mime = bRes.headers.get("content-type") ?? "application/octet-stream";
      const upB = await fetch(`${ghB.url}/xrpc/com.atproto.repo.uploadBlob`, {
        method: "POST",
        headers: {
          "content-type": mime,
          authorization: `Bearer ${sessB.accessJwt}`,
        },
        body: Buffer.from(await bRes.arrayBuffer()),
      });
      assert.equal(upB.status, 200);
    }

    // Calling `getRecommendedDidCredentials` BEFORE staging spaces fails with `409 MigrationStagingIncomplete` (or `400`)!
    const prematureCreds = await fetch(`${ghB.url}/xrpc/com.atproto.identity.getRecommendedDidCredentials`, {
      headers: { authorization: `Bearer ${sessB.accessJwt}` },
    });
    assert.equal(prematureCreds.ok, false, "getRecommendedDidCredentials before staging spaces must fail");

    // Copy all spaces (`listSpaces` -> `exportSpaceMeta`/`importSpaceMeta` for own spaces + `space.getRepo`/`space.importRepo` for all spaces!)
    const spacesRes = await dpopA.fetchWithDpop(`${ghA.url}/xrpc/com.atproto.space.listSpaces`, {
      method: "GET",
      accessToken: tokA,
    });
    assert.equal(spacesRes.status, 200);
    const { spaces } = (await spacesRes.json()) as { spaces: Array<{ space: string }> };
    assert.ok(spaces.some((s) => s.space === bobInvSpace), "listSpaces must include external invites/self repos");

    for (const sp of spaces) {
      if (sp.space.startsWith(`at://${groupDid}/space/`)) {
        const metaStarRes = await dpopA.fetchWithDpop(
          `${ghA.url}/xrpc/com.atproto.space.exportSpaceMeta?space=${encodeURIComponent(sp.space)}`,
          { method: "GET", accessToken: tokA },
        );
        assert.equal(metaStarRes.status, 200);
        const impMetaRes = await fetch(`${ghB.url}/xrpc/com.atproto.space.importSpaceMeta`, {
          method: "POST",
          headers: {
            "content-type": "application/vnd.dasl.star",
            authorization: `Bearer ${sessB.accessJwt}`,
          },
          body: Buffer.from(await metaStarRes.arrayBuffer()),
        });
        assert.equal(impMetaRes.status, 200);
      }

      const repoStarRes = await dpopA.fetchWithDpop(
        `${ghA.url}/xrpc/com.atproto.space.getRepo?space=${encodeURIComponent(sp.space)}&repo=${encodeURIComponent(groupDid)}`,
        { method: "GET", accessToken: tokA },
      );
      assert.equal(repoStarRes.status, 200);
      const impRepoRes = await fetch(`${ghB.url}/xrpc/com.atproto.space.importRepo`, {
        method: "POST",
        headers: {
          "content-type": "application/vnd.dasl.star",
          authorization: `Bearer ${sessB.accessJwt}`,
        },
        body: Buffer.from(await repoStarRes.arrayBuffer()),
      });
      assert.equal(
        impRepoRes.status,
        200,
        `space.importRepo(${sp.space}) failed: ${await impRepoRes.clone().text()}`,
      );
    }

    // Target `getRecommendedDidCredentials` -> preserves `sovKey.did()` and drops retiring `ghA` local rotation key!
    const recCredsRes = await fetch(`${ghB.url}/xrpc/com.atproto.identity.getRecommendedDidCredentials`, {
      headers: { authorization: `Bearer ${sessB.accessJwt}` },
    });
    assert.equal(recCredsRes.status, 200, `getRecommendedDidCredentials failed: ${await recCredsRes.clone().text()}`);
    const recCreds = (await recCredsRes.json()) as {
      rotationKeys: string[];
      alsoKnownAs: string[];
      verificationMethods: Record<string, string>;
      services: Record<string, { type: string; endpoint: string }>;
    };
    assert.ok(recCreds.rotationKeys.includes(sovKey.did()), "External sovereign PLC rotation key must be preserved");
    const ghALocalRot = (await ghA.repoStore.getGroupRotationKey(groupDid))!.did();
    assert.equal(recCreds.rotationKeys.includes(ghALocalRot), false, "Retiring source rotation key must be excluded");

    // Source `requestPlcOperationSignature` + `claim-action-token` + `signPlcOperation` (pulls Target `/group-admin/migration-attestation`!)
    await dpopA.fetchWithDpop(`${ghA.url}/xrpc/com.atproto.identity.requestPlcOperationSignature`, {
      method: "POST",
      accessToken: tokA,
    });
    const claimCutover = await dpopA.fetchWithDpop(`${ghA.url}/group-admin/claim-action-token`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ group: groupDid, purpose: "plc_operation" }),
    });
    const cutoverToken = ((await claimCutover.json()) as { token: string }).token;

    // Verify `SourceRotationKeyRetained` & `SovereignRotationKeyDropped` negative checks before valid sign!
    const retainSourceErr = await dpopA.fetchWithDpop(`${ghA.url}/xrpc/com.atproto.identity.signPlcOperation`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: cutoverToken,
        ...recCreds,
        rotationKeys: [...recCreds.rotationKeys, ghALocalRot],
      }),
    });
    assert.equal(retainSourceErr.status, 400);
    assert.equal(((await retainSourceErr.json()) as { error: string }).error, "SourceRotationKeyRetained");

    const dropSovErr = await dpopA.fetchWithDpop(`${ghA.url}/xrpc/com.atproto.identity.signPlcOperation`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: cutoverToken,
        ...recCreds,
        rotationKeys: recCreds.rotationKeys.filter((k) => k !== sovKey.did()),
      }),
    });
    assert.equal(dropSovErr.status, 400);
    assert.equal(((await dropSovErr.json()) as { error: string }).error, "SovereignRotationKeyDropped");

    const validSignRes = await dpopA.fetchWithDpop(`${ghA.url}/xrpc/com.atproto.identity.signPlcOperation`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: cutoverToken,
        ...recCreds,
      }),
    });
    assert.equal(validSignRes.status, 200, `signPlcOperation failed: ${await validSignRes.clone().text()}`);
    const { operation: cutoverPlcOp } = (await validSignRes.json()) as { operation: Record<string, unknown> };

    // Target `submitPlcOperation` -> Target `activateAccount` -> automatic `/group-admin/finalize-migrated-source` deactivates Source `ghA`!
    const subBRes = await fetch(`${ghB.url}/xrpc/com.atproto.identity.submitPlcOperation`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${sessB.accessJwt}`,
      },
      body: JSON.stringify({ operation: cutoverPlcOp }),
    });
    assert.equal(subBRes.status, 200, `Target submitPlcOperation failed: ${await subBRes.clone().text()}`);

    const actBRes = await fetch(`${ghB.url}/xrpc/com.atproto.server.activateAccount`, {
      method: "POST",
      headers: { authorization: `Bearer ${sessB.accessJwt}` },
    });
    assert.equal(actBRes.status, 200, `Target activateAccount failed: ${await actBRes.clone().text()}`);

    await ghB.flushBackgroundWork();

    // Verify `ghB` is active (`activated = 1`) AND `ghA` was automatically finalized (`activated = 0`, zero lease)!
    const acctOnB = ghB.db.prepare("SELECT activated, handle FROM group_account WHERE did = ?").get(groupDid) as {
      activated: number;
      handle: string;
    };
    assert.equal(acctOnB.activated, 1);
    assert.equal(acctOnB.handle, "team.b.groups.localhost");

    const acctOnA = ghA.db.prepare("SELECT activated FROM group_account WHERE did = ?").get(groupDid) as {
      activated: number;
    };
    assert.equal(acctOnA.activated, 0, "Source Group Host must be automatically finalized to activated=0");

    // 4. Standard / Flock-Advertised return-to-prior-host migration (`ghB -> ghA`, `A -> B -> A` re-entry WITHOUT `prepare-migration`!)
    const flowB = await completeGroupOAuthFlow({
      groupHost: ghB,
      pds,
      user: alice,
      scope: adminScopeStr,
      prompt: "login",
      loginHint: groupDid,
    });
    const dpopB = flowB.dpop;
    const tokB = flowB.tokenResponse!.access_token;

    const svcAuthBackRes = await dpopB.fetchWithDpop(
      `${ghB.url}/xrpc/com.atproto.server.getServiceAuth?aud=${encodeURIComponent(ghA.config.serviceDid)}&lxm=com.atproto.server.createAccount`,
      { method: "GET", accessToken: tokB },
    );
    assert.equal(svcAuthBackRes.status, 200);
    const { token: createBackJwt } = (await svcAuthBackRes.json()) as { token: string };

    const createBackRes = await fetch(`${ghA.url}/xrpc/com.atproto.server.createAccount`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${createBackJwt}`,
        // Intentionally NO X-Group-Migration-Ticket — exercises negotiated `public-group-keys` + `A -> B -> A` re-entry!
      },
      body: JSON.stringify({
        did: groupDid,
        handle: "team-back.a.groups.localhost",
      }),
    });
    assert.equal(createBackRes.status, 200, `A -> B -> A createAccount failed: ${await createBackRes.clone().text()}`);
    const sessBack = (await createBackRes.json()) as { accessJwt: string; did: string };
    assert.equal(sessBack.did, groupDid);

    // Lost-response replay on `createAccount` with a fresh service JWT returns `200` with fresh migration tokens!
    const svcAuthBackReplay = await dpopB.fetchWithDpop(
      `${ghB.url}/xrpc/com.atproto.server.getServiceAuth?aud=${encodeURIComponent(ghA.config.serviceDid)}&lxm=com.atproto.server.createAccount`,
      { method: "GET", accessToken: tokB },
    );
    const { token: createBackJwt2 } = (await svcAuthBackReplay.json()) as { token: string };
    const createBackReplay = await fetch(`${ghA.url}/xrpc/com.atproto.server.createAccount`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${createBackJwt2}`,
      },
      body: JSON.stringify({
        did: groupDid,
        handle: "team-back.a.groups.localhost",
      }),
    });
    assert.equal(createBackReplay.status, 200, "Lost-response createAccount replay must succeed");

    // 5. Unattested multi-key non-Flock source (`pds.url` with 2 PLC rotation keys) -> `400 ProvenanceRequired` without `X-Group-Migration-Key-Provenance`!
    const extSign = await P256Keypair.create({ exportable: true });
    const extKem = await P256Keypair.create({ exportable: true });
    const extRotHost = await P256Keypair.create({ exportable: true });
    const extRotSov = await P256Keypair.create({ exportable: true });
    const { formatAtprotoOp, signOperation, didForCreateOp } = await import("@did-plc/lib");
    const baseExt = formatAtprotoOp({
      signingKey: extSign.did(),
      handle: "ext.test",
      pds: pds.url,
      rotationKeys: [extRotHost.did(), extRotSov.did()],
      prev: null,
    });
    const signedExtGen = await signOperation(
      {
        ...baseExt,
        verificationMethods: { ...baseExt.verificationMethods, atproto_kem: extKem.did() },
      },
      extRotHost,
    );
    const extDid = await didForCreateOp(signedExtGen);
    await fetch(`${plc.url}/${encodeURIComponent(extDid)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(signedExtGen),
    });

    const extJwt1 = await createServiceJwt({
      iss: extDid,
      aud: ghB.config.serviceDid,
      lxm: "com.atproto.server.createAccount",
      keypair: extSign,
    });
    const unattestedMultiRes = await fetch(`${ghB.url}/xrpc/com.atproto.server.createAccount`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${extJwt1}`,
      },
      body: JSON.stringify({
        did: extDid,
        handle: "ext.b.groups.localhost",
      }),
    });
    assert.equal(unattestedMultiRes.status, 400);
    assert.equal(((await unattestedMultiRes.json()) as { error: string }).error, "ProvenanceRequired");

    // With valid `X-Group-Migration-Key-Provenance` JWS signed by sovereign key `extRotSov`, staging succeeds (`200`)!
    const nowSec = Math.floor(Date.now() / 1000);
    const provHeader = Buffer.from(
      JSON.stringify({ typ: "JWT", alg: "ES256", kid: extRotSov.did() }),
    ).toString("base64url");
    const provPayload = Buffer.from(
      JSON.stringify({
        iss: extRotSov.did(),
        sub: extDid,
        aud: ghB.config.serviceDid,
        act: "migration_key_provenance",
        sourceLocalRotationKey: extRotHost.did(),
        iat: nowSec,
        exp: nowSec + 120,
        jti: randomUUID(),
      }),
    ).toString("base64url");
    const provSig = await extRotSov.sign(Buffer.from(`${provHeader}.${provPayload}`, "utf8"));
    const provJws = `${provHeader}.${provPayload}.${Buffer.from(provSig).toString("base64url")}`;

    const extJwt2 = await createServiceJwt({
      iss: extDid,
      aud: ghB.config.serviceDid,
      lxm: "com.atproto.server.createAccount",
      keypair: extSign,
    });
    const attestedMultiRes = await fetch(`${ghB.url}/xrpc/com.atproto.server.createAccount`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${extJwt2}`,
        "x-group-migration-key-provenance": provJws,
      },
      body: JSON.stringify({
        did: extDid,
        handle: "ext.b.groups.localhost",
      }),
    });
    assert.equal(attestedMultiRes.status, 200, `Provenance-assisted createAccount failed: ${await attestedMultiRes.clone().text()}`);
  } finally {
    await ghA.close();
    await ghB.close();
    await pds.close();
    await plc.close();
  }
});

test("Target abort-migration blocks confused-deputy JWTs, flushBackgroundWork reaps expired leases to target, resolveHandle requires activated=1, and plc_signed fences refresh_token", async () => {
  const plc = await startMockPlcServer();
  const pds = await startMockPersonalPds(plc);
  const ghA = await startTestGroupHost({ plc, handleDomain: "a.groups.localhost" });
  const ghB = await startTestGroupHost({ plc, handleDomain: "b.groups.localhost" });

  try {
    const alice = await pds.registerUser("alice-migsec.test");
    const flowA = await createSteppedUpGroupFlow({
      groupHost: ghA,
      pds,
      user: alice,
      scope: groupAdminScopes().join(" "),
      prompt: "create",
      createParams: { displayName: "Mig Security", handle: "migsec.a.groups.localhost" },
    });
    const dpopA = flowA.dpop;
    const tokA = flowA.tokenResponse!.access_token;
    const refreshTokA = flowA.tokenResponse!.refresh_token!;
    const groupDid = flowA.tokenResponse!.sub;

    // 1. Prepare coordinated migration `ghA -> ghB` and stage `createAccount` on `ghB`
    const prep1 = await dpopA.fetchWithDpop(`${ghA.url}/group-admin/prepare-migration`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        group: groupDid,
        operationId: "op-sec-1",
        targetEndpoint: ghB.url,
      }),
    });
    assert.equal(prep1.status, 200);
    const prep1Body = (await prep1.json()) as { migrationTicket: string; operationId: string };
    const ticketId1 = prep1Body.migrationTicket.split(".")[1]!;

    const groupSigKey = await ghA.repoStore.getGroupSigningKey(groupDid);
    const createJwt1 = await createServiceJwt({
      iss: groupDid,
      aud: ghB.config.serviceDid,
      lxm: "com.atproto.server.createAccount",
      keypair: groupSigKey,
    });
    const stage1 = await fetch(`${ghB.url}/xrpc/com.atproto.server.createAccount`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${createJwt1}`,
        "x-group-migration-ticket": prep1Body.migrationTicket,
      },
      body: JSON.stringify({ did: groupDid, handle: "migsec.b.groups.localhost" }),
    });
    assert.equal(stage1.status, 200);

    // `resolveHandle` on `ghB` must reject unactivated (`activated = 0`) staged handle!
    const resolveStagedRes = await fetch(
      `${ghB.url}/xrpc/com.atproto.identity.resolveHandle?handle=migsec.b.groups.localhost`,
    );
    assert.equal(resolveStagedRes.status, 400);
    assert.equal(((await resolveStagedRes.json()) as { error: string }).error, "UnableToResolveHandle");

    // 2. Confused-deputy checks on `ghB` `POST /group-admin/abort-migration`
    const pubKeysRes = await fetch(`${ghA.url}/group-admin/public-group-keys?group=${encodeURIComponent(groupDid)}`);
    const { proofJwt } = (await pubKeysRes.json()) as { proofJwt: string };

    const replayProofAbort = await fetch(`${ghB.url}/group-admin/abort-migration`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${proofJwt}` },
      body: JSON.stringify({ group: groupDid, operationId: "op-sec-1", ticketId: ticketId1 }),
    });
    assert.equal(replayProofAbort.status, 401, "public-group-keys proofJwt (aud=*) must be rejected");

    const wrongLxmJwt = await createServiceJwt({
      iss: groupDid,
      aud: ghB.config.serviceDid,
      lxm: "com.atproto.space.notifyCredentialsRevoked",
      keypair: groupSigKey,
    });
    const wrongLxmRes = await fetch(`${ghB.url}/group-admin/abort-migration`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${wrongLxmJwt}` },
      body: JSON.stringify({ group: groupDid, operationId: "op-sec-1", ticketId: ticketId1 }),
    });
    assert.equal(wrongLxmRes.status, 401, "Wrong lxm service JWT must be rejected");

    const wrongAudJwt = await createServiceJwt({
      iss: groupDid,
      aud: ghA.config.serviceDid,
      lxm: "group.opensocial.abortMigration",
      keypair: groupSigKey,
    });
    const wrongAudRes = await fetch(`${ghB.url}/group-admin/abort-migration`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${wrongAudJwt}` },
      body: JSON.stringify({ group: groupDid, operationId: "op-sec-1", ticketId: ticketId1 }),
    });
    assert.equal(wrongAudRes.status, 401, "Wrong aud service JWT must be rejected");

    // Missing `operationId` -> 400 InvalidRequest
    const missingOpJwt = await createServiceJwt({
      iss: groupDid,
      aud: ghB.config.serviceDid,
      lxm: "group.opensocial.abortMigration",
      keypair: groupSigKey,
    });
    const missingOpRes = await fetch(`${ghB.url}/group-admin/abort-migration`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${missingOpJwt}` },
      body: JSON.stringify({ group: groupDid, ticketId: ticketId1 }),
    });
    assert.equal(missingOpRes.status, 400);

    // Missing `ticketId` on coordinated session -> 400 InvalidRequest
    const missingTicketJwt = await createServiceJwt({
      iss: groupDid,
      aud: ghB.config.serviceDid,
      lxm: "group.opensocial.abortMigration",
      keypair: groupSigKey,
    });
    const missingTicketRes = await fetch(`${ghB.url}/group-admin/abort-migration`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${missingTicketJwt}` },
      body: JSON.stringify({ group: groupDid, operationId: "op-sec-1" }),
    });
    assert.equal(missingTicketRes.status, 400);

    // Mismatched `operationId` -> 200 `{ status: "superseded" }` without purging `ghB` staging!
    const staleAbortJwt = await createServiceJwt({
      iss: groupDid,
      aud: ghB.config.serviceDid,
      lxm: "group.opensocial.abortMigration",
      keypair: groupSigKey,
    });
    const supersededRes = await fetch(`${ghB.url}/group-admin/abort-migration`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${staleAbortJwt}` },
      body: JSON.stringify({ group: groupDid, operationId: "stale-op", ticketId: "stale-ticket" }),
    });
    assert.equal(supersededRes.status, 200);
    assert.equal(((await supersededRes.json()) as { status: string }).status, "superseded");
    assert.ok(ghB.db.prepare("SELECT 1 FROM migration_session WHERE group_did = ?").get(groupDid));

    // Valid `group.opensocial.abortMigration` JWT -> 200 `{ status: "purged" }`, and JTI replay -> 401 `ReplayDetected`!
    const validAbortJwt = await createServiceJwt({
      iss: groupDid,
      aud: ghB.config.serviceDid,
      lxm: "group.opensocial.abortMigration",
      keypair: groupSigKey,
    });
    const validAbortRes = await fetch(`${ghB.url}/group-admin/abort-migration`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${validAbortJwt}` },
      body: JSON.stringify({ group: groupDid, operationId: "op-sec-1", ticketId: ticketId1 }),
    });
    assert.equal(validAbortRes.status, 200);
    assert.equal(((await validAbortRes.json()) as { status: string }).status, "purged");

    const replayedAbortRes = await fetch(`${ghB.url}/group-admin/abort-migration`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${validAbortJwt}` },
      body: JSON.stringify({ group: groupDid, operationId: "op-sec-1", ticketId: ticketId1 }),
    });
    assert.equal(replayedAbortRes.status, 401, "Consumed abort JTI must survive purgeGroupDataSync and block replay");
    assert.equal(((await replayedAbortRes.json()) as { error: string }).error, "ReplayDetected");

    // Abort source lease on `ghA` so we can test background lease-expiry sweep next
    await dpopA.fetchWithDpop(`${ghA.url}/group-admin/abort-migration`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ group: groupDid, operationId: "op-sec-1" }),
    });

    // 3. `flushBackgroundWork` runs `sweepExpiredPreparedMigrationLeases` BEFORE `pruneExpiredHostState` and aborts target staging!
    const prep2 = await dpopA.fetchWithDpop(`${ghA.url}/group-admin/prepare-migration`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        group: groupDid,
        operationId: "op-sec-sweep",
        targetEndpoint: ghB.url,
      }),
    });
    assert.equal(prep2.status, 200);
    const prep2Body = (await prep2.json()) as { migrationTicket: string };

    const createJwt2 = await createServiceJwt({
      iss: groupDid,
      aud: ghB.config.serviceDid,
      lxm: "com.atproto.server.createAccount",
      keypair: groupSigKey,
    });
    const stage2 = await fetch(`${ghB.url}/xrpc/com.atproto.server.createAccount`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${createJwt2}`,
        "x-group-migration-ticket": prep2Body.migrationTicket,
      },
      body: JSON.stringify({ did: groupDid, handle: "migsec.b.groups.localhost" }),
    });
    assert.equal(stage2.status, 200);
    assert.ok(ghB.db.prepare("SELECT 1 FROM group_account WHERE did = ?").get(groupDid));

    ghA.db
      .prepare("UPDATE source_migration_lease SET expires_at = ? WHERE group_did = ?")
      .run(Date.now() - 5_000, groupDid);
    await ghA.flushBackgroundWork();

    assert.equal(
      ghA.db.prepare("SELECT 1 FROM source_migration_lease WHERE group_did = ?").get(groupDid),
      undefined,
      "Expired source lease must be reaped",
    );
    assert.equal(
      ghB.db.prepare("SELECT 1 FROM group_account WHERE did = ?").get(groupDid),
      undefined,
      "Sweeper abort must purge staged target group_account on ghB",
    );

    // 4. `plc_signed` source migration lease fences `/oauth/token` `refresh_token` (`400 invalid_grant`)
    ghA.db
      .prepare(
        `INSERT INTO source_migration_lease (
           group_did, operation_id, mode, ticket_id, ticket_secret_hash, ticket_secret_enc,
           target_service_did, target_endpoint, status, signed_plc_op_json,
           frozen_at, deadline_at, expires_at, manifest_digest, root_manifest_json
         ) VALUES (?, 'op-signed', 'standard', NULL, NULL, NULL, ?, ?, 'plc_signed', '{}', ?, ?, NULL, 'dig', '{}')`,
      )
      .run(groupDid, ghB.config.serviceDid, ghB.url, Date.now(), Date.now() + 3_600_000);

    const sessClient = (
      ghA.db.prepare("SELECT client_id FROM oauth_session WHERE group_did = ? LIMIT 1").get(groupDid) as {
        client_id: string;
      }
    ).client_id;
    const fencedRefreshRes = await dpopA.fetchWithDpop(`${ghA.url}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: sessClient,
        refresh_token: refreshTokA,
      }).toString(),
    });
    assert.equal(fencedRefreshRes.status, 400, "plc_signed source lease must fence refresh_token");
    const fencedBody = (await fencedRefreshRes.json()) as { error: string; error_description: string };
    assert.equal(fencedBody.error, "invalid_grant");
    assert.match(fencedBody.error_description, /PLC cutover/i);

    void randomBytes;
  } finally {
    await ghA.close();
    await ghB.close();
    await pds.close();
    await plc.close();
  }
});

async function signCustomServiceJwt(
  keypair: { sign(msg: Uint8Array): Promise<Uint8Array> },
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
): Promise<string> {
  const h = Buffer.from(JSON.stringify(header)).toString("base64url");
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = await keypair.sign(Buffer.from(`${h}.${p}`, "utf8"));
  return `${h}.${p}.${Buffer.from(sig).toString("base64url")}`;
}

test("Lazy prepared-lease reap aborts target staging (coordinated & standard), standard deadlineAtMs guards newer sessions, service-JWT verifiers enforce exact contract, and signPlcOperation / submitPlcOperation / unleased abort are crash-resumable", async () => {
  const plc = await startMockPlcServer();
  const pds = await startMockPersonalPds(plc);
  const ghA = await startTestGroupHost({ plc, handleDomain: "a2.groups.localhost" });
  const ghB = await startTestGroupHost({ plc, handleDomain: "b2.groups.localhost" });

  try {
    const alice = await pds.registerUser("alice-resumable.test");
    const adminScopeStr = groupAdminScopes().join(" ");
    const flowA = await createSteppedUpGroupFlow({
      groupHost: ghA,
      pds,
      user: alice,
      scope: adminScopeStr,
      prompt: "create",
      createParams: { displayName: "Resumable Migration", handle: "resumable.a2.groups.localhost" },
    });
    const dpopA = flowA.dpop;
    const tokA = flowA.tokenResponse!.access_token;
    const groupDid = flowA.tokenResponse!.sub;
    const groupSigKeyA = await ghA.repoStore.getGroupSigningKey(groupDid);

    // =========================================================================
    // 1. Exact migration service-JWT contract on `verifyPeerHostServiceJwt`, `createMigrationAccount`, & `abortMigrationOnTarget`
    // =========================================================================
    const prepJwtTest = await dpopA.fetchWithDpop(`${ghA.url}/group-admin/prepare-migration`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ group: groupDid, operationId: "op-jwt-contract", targetEndpoint: ghB.url }),
    });
    assert.equal(prepJwtTest.status, 200);
    const prepJwtBody = (await prepJwtTest.json()) as { migrationTicket: string };
    const [, ticketIdJwt, secretJwt] = prepJwtBody.migrationTicket.split(".");

    const nowSec = Math.floor(Date.now() / 1000);
    for (const badSpec of [
      // Omitted `typ`
      { header: { alg: "ES256" }, claims: { iat: nowSec, exp: nowSec + 60, jti: randomUUID() } },
      // Future `iat` > 5s (e.g. +15s, previously accepted by abortMigrationOnTarget!)
      { header: { typ: "JWT", alg: "ES256" }, claims: { iat: nowSec + 15, exp: nowSec + 60, jti: randomUUID() } },
      // Lifetime > 60s (`exp - iat = 65`)
      { header: { typ: "JWT", alg: "ES256" }, claims: { iat: nowSec - 10, exp: nowSec + 55, jti: randomUUID() } },
      // Missing `iat`
      { header: { typ: "JWT", alg: "ES256" }, claims: { exp: nowSec + 60, jti: randomUUID() } },
      // `exp <= iat`
      { header: { typ: "JWT", alg: "ES256" }, claims: { iat: nowSec + 3, exp: nowSec + 2, jti: randomUUID() } },
      // Whitespace-only `jti`
      { header: { typ: "JWT", alg: "ES256" }, claims: { iat: nowSec, exp: nowSec + 60, jti: "  " } },
    ]) {
      // (a) `verifyPeerHostServiceJwt` (`/group-admin/migration-manifest`)
      const badPeerJwt = await signCustomServiceJwt(ghB.migration.serviceKeys.activeKeypair, badSpec.header, {
        iss: ghB.config.serviceDid,
        aud: ghA.config.serviceDid,
        lxm: "com.atproto.server.createAccount",
        ...badSpec.claims,
      });
      const manRes = await fetch(
        `${ghA.url}/group-admin/migration-manifest?group=${encodeURIComponent(groupDid)}&ticketId=${encodeURIComponent(ticketIdJwt!)}`,
        {
          headers: {
            authorization: `Bearer ${badPeerJwt}`,
            "x-group-migration-secret": secretJwt!,
          },
        },
      );
      assert.equal(manRes.status, 401, `verifyPeerHostServiceJwt must reject ${JSON.stringify(badSpec)}`);

      // (b) `createMigrationAccount` (`/xrpc/com.atproto.server.createAccount`)
      const badCreateJwt = await signCustomServiceJwt(groupSigKeyA, badSpec.header, {
        iss: groupDid,
        aud: ghB.config.serviceDid,
        lxm: "com.atproto.server.createAccount",
        ...badSpec.claims,
      });
      const crRes = await fetch(`${ghB.url}/xrpc/com.atproto.server.createAccount`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${badCreateJwt}`,
          "x-group-migration-ticket": prepJwtBody.migrationTicket,
        },
        body: JSON.stringify({ did: groupDid, handle: "resumable.b2.groups.localhost" }),
      });
      assert.equal(crRes.status, 401, `createMigrationAccount must reject ${JSON.stringify(badSpec)}`);

      // (c) `abortMigrationOnTarget` (`/group-admin/abort-migration`)
      const badAbortJwt = await signCustomServiceJwt(groupSigKeyA, badSpec.header, {
        iss: groupDid,
        aud: ghB.config.serviceDid,
        lxm: "group.opensocial.abortMigration",
        ...badSpec.claims,
      });
      const abRes = await fetch(`${ghB.url}/group-admin/abort-migration`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${badAbortJwt}`,
        },
        body: JSON.stringify({ group: groupDid, operationId: "op-jwt-contract", ticketId: ticketIdJwt }),
      });
      assert.equal(abRes.status, 401, `abortMigrationOnTarget must reject ${JSON.stringify(badSpec)}`);
    }

    // =========================================================================
    // 2. Lazy prepared-lease expiry via ordinary request (`hasActiveSourceMigrationLease` / `reapExpiredPreparedMigrationLease`)
    //    must abort Target staging for BOTH `coordinated` AND `standard` modes WITHOUT periodic sweep!
    // =========================================================================
    const validCreateCoordJwt = await createServiceJwt({
      iss: groupDid,
      aud: ghB.config.serviceDid,
      lxm: "com.atproto.server.createAccount",
      keypair: groupSigKeyA,
    });
    const stagedCoordRes = await fetch(`${ghB.url}/xrpc/com.atproto.server.createAccount`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${validCreateCoordJwt}`,
        "x-group-migration-ticket": prepJwtBody.migrationTicket,
      },
      body: JSON.stringify({ did: groupDid, handle: "resumable.b2.groups.localhost" }),
    });
    assert.equal(stagedCoordRes.status, 200);
    assert.ok(ghB.db.prepare("SELECT 1 FROM migration_session WHERE group_did = ?").get(groupDid));

    // Expire the coordinated lease on `ghA`, then trigger a normal public write (`createRecord`) BEFORE `sweepExpiredPreparedMigrationLeases`!
    ghA.db
      .prepare("UPDATE source_migration_lease SET expires_at = ? WHERE group_did = ?")
      .run(Date.now() - 5_000, groupDid);
    const thawWriteRes = await dpopA.fetchWithDpop(`${ghA.url}/xrpc/com.atproto.repo.createRecord`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo: groupDid,
        collection: "group.opensocial.rule",
        record: { $type: "group.opensocial.rule", title: "Thawed Write", createdAt: new Date().toISOString() },
      }),
    });
    assert.equal(thawWriteRes.status, 200, "Ordinary write must lazily reap expired prepared lease and succeed");
    await ghA.migration.flushPendingTargetAborts();
    assert.equal(
      ghB.db.prepare("SELECT 1 FROM migration_session WHERE group_did = ?").get(groupDid),
      undefined,
      "Lazy prepared-lease reap must fire queueMicrotask hook and purge coordinated target staging on ghB",
    );

    // Repeat lazy prepared-lease expiry for `standard` mode + verify `deadlineAtMs` guard on `abortMigrationOnTarget`!
    const prepStd = await dpopA.fetchWithDpop(`${ghA.url}/group-admin/prepare-migration`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        group: groupDid,
        operationId: "op-lazy-std",
        targetEndpoint: ghB.url,
        mode: "standard",
      }),
    });
    assert.equal(prepStd.status, 200);
    const prepStdBody = (await prepStd.json()) as { mode: string; deadlineAtMs: number };
    assert.equal(prepStdBody.mode, "standard");

    // Malformed `X-Group-Migration-Operation-Id` header must be rejected with `400 InvalidRequest`
    const badOpHeaderJwt = await createServiceJwt({
      iss: groupDid,
      aud: ghB.config.serviceDid,
      lxm: "com.atproto.server.createAccount",
      keypair: groupSigKeyA,
    });
    const badOpHeaderRes = await fetch(`${ghB.url}/xrpc/com.atproto.server.createAccount`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${badOpHeaderJwt}`,
        "x-group-migration-operation-id": "invalid spaces!",
      },
      body: JSON.stringify({ did: groupDid, handle: "resumable.b2.groups.localhost" }),
    });
    assert.equal(badOpHeaderRes.status, 400);
    assert.equal(((await badOpHeaderRes.json()) as { error: string }).error, "InvalidRequest");

    const createStdJwt = await createServiceJwt({
      iss: groupDid,
      aud: ghB.config.serviceDid,
      lxm: "com.atproto.server.createAccount",
      keypair: groupSigKeyA,
    });
    const stageStdRes = await fetch(`${ghB.url}/xrpc/com.atproto.server.createAccount`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${createStdJwt}`,
        "x-group-migration-operation-id": "op-lazy-std",
      },
      body: JSON.stringify({ did: groupDid, handle: "resumable.b2.groups.localhost" }),
    });
    assert.equal(stageStdRes.status, 200);
    assert.equal(
      (
        ghB.db.prepare("SELECT operation_id FROM migration_session WHERE group_did = ?").get(groupDid) as {
          operation_id: string | null;
        }
      ).operation_id,
      "op-lazy-std",
    );

    // Lost-response replay with matching `X-Group-Migration-Operation-Id` succeeds (`200`), while competing `operationId` fails (`409 MigrationInProgress`)!
    const replayStdJwt = await createServiceJwt({
      iss: groupDid,
      aud: ghB.config.serviceDid,
      lxm: "com.atproto.server.createAccount",
      keypair: groupSigKeyA,
    });
    const replayStdRes = await fetch(`${ghB.url}/xrpc/com.atproto.server.createAccount`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${replayStdJwt}`,
        "x-group-migration-operation-id": "op-lazy-std",
      },
      body: JSON.stringify({ did: groupDid, handle: "resumable.b2.groups.localhost" }),
    });
    assert.equal(replayStdRes.status, 200);

    const competingStdJwt = await createServiceJwt({
      iss: groupDid,
      aud: ghB.config.serviceDid,
      lxm: "com.atproto.server.createAccount",
      keypair: groupSigKeyA,
    });
    const competingStdRes = await fetch(`${ghB.url}/xrpc/com.atproto.server.createAccount`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${competingStdJwt}`,
        "x-group-migration-operation-id": "op-competing-std",
      },
      body: JSON.stringify({ did: groupDid, handle: "resumable.b2.groups.localhost" }),
    });
    assert.equal(competingStdRes.status, 409);
    assert.equal(((await competingStdRes.json()) as { error: string }).error, "MigrationInProgress");

    // Verify delayed `#atproto` `abort-migration` for an older operation (`"op-older-std-1"`) NEVER purges `"op-lazy-std"`
    // EVEN WHEN `sess.created_at < deadlineAtMs` (created immediately, well before Operation 1's 2-hour deadline)!
    const sessCreatedAt = (
      ghB.db.prepare("SELECT created_at FROM migration_session WHERE group_did = ?").get(groupDid) as {
        created_at: number;
      }
    ).created_at;
    const delayedOldOpAbortJwt = await createServiceJwt({
      iss: groupDid,
      aud: ghB.config.serviceDid,
      lxm: "group.opensocial.abortMigration",
      keypair: groupSigKeyA,
    });
    const delayedOldOpAbortRes = await fetch(`${ghB.url}/group-admin/abort-migration`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${delayedOldOpAbortJwt}`,
      },
      body: JSON.stringify({
        group: groupDid,
        operationId: "op-older-std-1",
        deadlineAtMs: sessCreatedAt + 7_200_000,
      }),
    });
    assert.equal(delayedOldOpAbortRes.status, 200);
    assert.equal(((await delayedOldOpAbortRes.json()) as { status: string }).status, "superseded");
    assert.ok(
      ghB.db.prepare("SELECT 1 FROM migration_session WHERE group_did = ?").get(groupDid),
      "Delayed abort for older operationId must never purge newer Standard session even before old deadlineAtMs",
    );

    // Now expire the `standard` prepared lease on `ghA` and trigger lazy reap via `createRecord` -> purges `ghB` standard session!
    ghA.db
      .prepare("UPDATE source_migration_lease SET expires_at = ? WHERE group_did = ?")
      .run(Date.now() - 5_000, groupDid);
    const thawStdWriteRes = await dpopA.fetchWithDpop(`${ghA.url}/xrpc/com.atproto.repo.createRecord`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo: groupDid,
        collection: "group.opensocial.rule",
        record: { $type: "group.opensocial.rule", title: "Thawed Std Write", createdAt: new Date().toISOString() },
      }),
    });
    assert.equal(thawStdWriteRes.status, 200);
    await ghA.migration.flushPendingTargetAborts();
    assert.equal(
      ghB.db.prepare("SELECT 1 FROM migration_session WHERE group_did = ?").get(groupDid),
      undefined,
      "Lazy prepared-lease reap must also purge standard-mode target staging on ghB",
    );

    // =========================================================================
    // 3. Unleased standard-mode `signPlcOperation` (`operation_id = "unleased-..."`) aborted with omitted `operationId`
    // =========================================================================
    const createUnleasedJwt = await createServiceJwt({
      iss: groupDid,
      aud: ghB.config.serviceDid,
      lxm: "com.atproto.server.createAccount",
      keypair: groupSigKeyA,
    });
    const stageUnleasedRes = await fetch(`${ghB.url}/xrpc/com.atproto.server.createAccount`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${createUnleasedJwt}`,
      },
      body: JSON.stringify({ did: groupDid, handle: "resumable.b2.groups.localhost" }),
    });
    assert.equal(stageUnleasedRes.status, 200);
    const stageUnleasedToks = (await stageUnleasedRes.json()) as { accessJwt: string };

    // Stage meta/self & members/self on `ghB` so `getRecommendedDidCredentials` succeeds
    for (const spUri of [
      `at://${groupDid}/space/group.opensocial.meta/self`,
      `at://${groupDid}/space/group.opensocial.members/self`,
      `at://${groupDid}/space/new.flock.workspace/self`,
    ]) {
      const metaStar = new Uint8Array(
        await (
          await dpopA.fetchWithDpop(
            `${ghA.url}/xrpc/com.atproto.space.exportSpaceMeta?space=${encodeURIComponent(spUri)}`,
            { method: "GET", accessToken: tokA },
          )
        ).arrayBuffer(),
      );
      await fetch(`${ghB.url}/xrpc/com.atproto.space.importSpaceMeta?space=${encodeURIComponent(spUri)}`, {
        method: "POST",
        headers: {
          "content-type": "application/vnd.dasl.star",
          authorization: `Bearer ${stageUnleasedToks.accessJwt}`,
        },
        body: metaStar,
      });
      const repoRes = await dpopA.fetchWithDpop(
        `${ghA.url}/xrpc/com.atproto.space.getRepo?space=${encodeURIComponent(spUri)}&repo=${encodeURIComponent(groupDid)}`,
        { method: "GET", accessToken: tokA },
      );
      if (repoRes.status === 200) {
        const repoStar = new Uint8Array(await repoRes.arrayBuffer());
        await fetch(`${ghB.url}/xrpc/com.atproto.space.importRepo`, {
          method: "POST",
          headers: {
            "content-type": "application/vnd.dasl.star",
            authorization: `Bearer ${stageUnleasedToks.accessJwt}`,
          },
          body: repoStar,
        });
      }
    }
    const carBytes = new Uint8Array(
      await (await fetch(`${ghA.url}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(groupDid)}`)).arrayBuffer(),
    );
    await fetch(`${ghB.url}/xrpc/com.atproto.repo.importRepo`, {
      method: "POST",
      headers: {
        "content-type": "application/vnd.ipld.car",
        authorization: `Bearer ${stageUnleasedToks.accessJwt}`,
      },
      body: carBytes,
    });

    const recUnleased = (await (
      await fetch(`${ghB.url}/xrpc/com.atproto.identity.getRecommendedDidCredentials`, {
        headers: { authorization: `Bearer ${stageUnleasedToks.accessJwt}` },
      })
    ).json()) as {
      rotationKeys: string[];
      alsoKnownAs: string[];
      verificationMethods: Record<string, string>;
      services: Record<string, { type: string; endpoint: string }>;
    };

    await dpopA.fetchWithDpop(`${ghA.url}/xrpc/com.atproto.identity.requestPlcOperationSignature`, {
      method: "POST",
      accessToken: tokA,
    });
    const claimUnleased = (await (
      await dpopA.fetchWithDpop(`${ghA.url}/group-admin/claim-action-token`, {
        method: "POST",
        accessToken: tokA,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ group: groupDid, purpose: "plc_operation" }),
      })
    ).json()) as { token: string };

    const signedUnleasedRes = await dpopA.fetchWithDpop(`${ghA.url}/xrpc/com.atproto.identity.signPlcOperation`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: claimUnleased.token,
        ...recUnleased,
      }),
    });
    assert.equal(signedUnleasedRes.status, 200);
    const { operation: signedUnleasedOp } = (await signedUnleasedRes.json()) as { operation: Record<string, unknown> };

    const unleasedRow = ghA.db
      .prepare("SELECT operation_id, status FROM source_migration_lease WHERE group_did = ?")
      .get(groupDid) as { operation_id: string; status: string };
    assert.match(unleasedRow.operation_id, /^unleased-/);
    assert.equal(unleasedRow.status, "plc_signed");

    // `prepare-migration` MUST still return `409 MigrationInProgress` when `status === 'plc_signed'`!
    const prepBlockedRes = await dpopA.fetchWithDpop(`${ghA.url}/group-admin/prepare-migration`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ group: groupDid, operationId: "op-blocked", targetEndpoint: ghB.url }),
    });
    assert.equal(prepBlockedRes.status, 409);

    // =========================================================================
    // 4. `signPlcOperation` idempotent replay across `plc_signed` crash window (without unconsumed `group_action_token`!)
    // =========================================================================
    // (a) Replay WITHOUT `token` -> returns exact `savedSignedOp`
    const replayNoTokenRes = await dpopA.fetchWithDpop(`${ghA.url}/xrpc/com.atproto.identity.signPlcOperation`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...recUnleased }),
    });
    assert.equal(replayNoTokenRes.status, 200);
    assert.deepEqual(((await replayNoTokenRes.json()) as { operation: unknown }).operation, signedUnleasedOp);

    // (b) Replay WITH already-consumed `token` -> also returns exact `savedSignedOp`
    const replayConsumedTokenRes = await dpopA.fetchWithDpop(`${ghA.url}/xrpc/com.atproto.identity.signPlcOperation`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: claimUnleased.token, ...recUnleased }),
    });
    assert.equal(replayConsumedTokenRes.status, 200);
    assert.deepEqual(((await replayConsumedTokenRes.json()) as { operation: unknown }).operation, signedUnleasedOp);

    // (c) Replay with mismatched `rotationKeys` -> `409 MigrationInProgress`
    const extraKey = await P256Keypair.create();
    const mismatchReplayRes = await dpopA.fetchWithDpop(`${ghA.url}/xrpc/com.atproto.identity.signPlcOperation`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...recUnleased, rotationKeys: [...recUnleased.rotationKeys, extraKey.did()] }),
    });
    assert.equal(mismatchReplayRes.status, 409);

    // Delayed `#atproto` `abort-migration` from a prior leased operation (`deadlineAtMs` still 2 hours in the future!)
    // MUST return `{ status: "superseded" }` and leave zero-header `operation_id === null` staged data 100% intact!
    const delayedAgainstNullJwt = await createServiceJwt({
      iss: groupDid,
      aud: ghB.config.serviceDid,
      lxm: "group.opensocial.abortMigration",
      keypair: groupSigKeyA,
    });
    const delayedAgainstNullRes = await fetch(`${ghB.url}/group-admin/abort-migration`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${delayedAgainstNullJwt}`,
      },
      body: JSON.stringify({
        group: groupDid,
        operationId: "op-delayed-from-op1",
        deadlineAtMs: Date.now() + 7_200_000,
      }),
    });
    assert.equal(delayedAgainstNullRes.status, 200);
    assert.equal(((await delayedAgainstNullRes.json()) as { status: string }).status, "superseded");
    assert.ok(
      ghB.db.prepare("SELECT 1 FROM migration_session WHERE group_did = ?").get(groupDid),
      "Delayed #atproto abort must never purge a zero-header unleased Standard session",
    );

    // Now abort the unleased `plc_signed` lease with `operationId` OMITTED (`{ group }`):
    // must advance `ghA` PLC head (invalidating `signedUnleasedOp`), delete `source_migration_lease`,
    // and NOT let `#atproto` `abort-migration` (`unleased-...`) clobber `operation_id === null` on `ghB`;
    // then `migration_session` Bearer abort on `ghB` purges the unleased staging session cleanly!
    const abortUnleasedRes = await dpopA.fetchWithDpop(`${ghA.url}/group-admin/abort-migration`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ group: groupDid }),
    });
    assert.equal(abortUnleasedRes.status, 200);
    assert.equal(((await abortUnleasedRes.json()) as { status: string }).status, "aborted");
    assert.equal(ghA.db.prepare("SELECT 1 FROM source_migration_lease WHERE group_did = ?").get(groupDid), undefined);
    assert.ok(
      ghB.db.prepare("SELECT 1 FROM migration_session WHERE group_did = ?").get(groupDid),
      "Unleased #atproto abort must return superseded rather than purging operation_id=null staging",
    );
    const bearerPurgeUnleasedRes = await fetch(`${ghB.url}/group-admin/abort-migration`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${stageUnleasedToks.accessJwt}`,
      },
      body: JSON.stringify({ group: groupDid }),
    });
    assert.equal(bearerPurgeUnleasedRes.status, 200);
    assert.equal(((await bearerPurgeUnleasedRes.json()) as { status: string }).status, "purged");
    assert.equal(
      ghB.db.prepare("SELECT 1 FROM migration_session WHERE group_did = ?").get(groupDid),
      undefined,
      "migration_session Bearer abort must purge unleased target staging on ghB",
    );
    const replayAbortedOpOnPlc = await fetch(`${plc.url}/${encodeURIComponent(groupDid)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(signedUnleasedOp),
    });
    assert.ok(replayAbortedOpOnPlc.status === 400 || replayAbortedOpOnPlc.status === 409);

    // =========================================================================
    // 5. `submitPlcOperation` idempotent retry when `migration_session.plc_cutover_at !== null`
    //    AND `finalizeMigratedSource` strict JWT contract
    // =========================================================================
    const prepCut = await dpopA.fetchWithDpop(`${ghA.url}/group-admin/prepare-migration`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ group: groupDid, operationId: "op-idemp-cut", targetEndpoint: ghB.url }),
    });
    assert.equal(prepCut.status, 200);
    const prepCutBody = (await prepCut.json()) as { migrationTicket: string };

    const createCutJwt = await createServiceJwt({
      iss: groupDid,
      aud: ghB.config.serviceDid,
      lxm: "com.atproto.server.createAccount",
      keypair: groupSigKeyA,
    });
    const stageCutRes = await fetch(`${ghB.url}/xrpc/com.atproto.server.createAccount`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${createCutJwt}`,
        "x-group-migration-ticket": prepCutBody.migrationTicket,
      },
      body: JSON.stringify({ did: groupDid, handle: "resumable.b2.groups.localhost" }),
    });
    assert.equal(stageCutRes.status, 200);
    const stageCutToks = (await stageCutRes.json()) as { accessJwt: string };

    for (const spUri of [
      `at://${groupDid}/space/group.opensocial.meta/self`,
      `at://${groupDid}/space/group.opensocial.members/self`,
      `at://${groupDid}/space/new.flock.workspace/self`,
    ]) {
      const metaStar = new Uint8Array(
        await (
          await dpopA.fetchWithDpop(
            `${ghA.url}/xrpc/com.atproto.space.exportSpaceMeta?space=${encodeURIComponent(spUri)}`,
            { method: "GET", accessToken: tokA },
          )
        ).arrayBuffer(),
      );
      await fetch(`${ghB.url}/xrpc/com.atproto.space.importSpaceMeta?space=${encodeURIComponent(spUri)}`, {
        method: "POST",
        headers: {
          "content-type": "application/vnd.dasl.star",
          authorization: `Bearer ${stageCutToks.accessJwt}`,
        },
        body: metaStar,
      });
      const repoRes = await dpopA.fetchWithDpop(
        `${ghA.url}/xrpc/com.atproto.space.getRepo?space=${encodeURIComponent(spUri)}&repo=${encodeURIComponent(groupDid)}`,
        { method: "GET", accessToken: tokA },
      );
      if (repoRes.status === 200) {
        const repoStar = new Uint8Array(await repoRes.arrayBuffer());
        await fetch(`${ghB.url}/xrpc/com.atproto.space.importRepo`, {
          method: "POST",
          headers: {
            "content-type": "application/vnd.dasl.star",
            authorization: `Bearer ${stageCutToks.accessJwt}`,
          },
          body: repoStar,
        });
      }
    }
    const freshCarBytes = new Uint8Array(
      await (await fetch(`${ghA.url}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(groupDid)}`)).arrayBuffer(),
    );
    await fetch(`${ghB.url}/xrpc/com.atproto.repo.importRepo`, {
      method: "POST",
      headers: {
        "content-type": "application/vnd.ipld.car",
        authorization: `Bearer ${stageCutToks.accessJwt}`,
      },
      body: freshCarBytes,
    });

    const recCut = (await (
      await fetch(`${ghB.url}/xrpc/com.atproto.identity.getRecommendedDidCredentials`, {
        headers: { authorization: `Bearer ${stageCutToks.accessJwt}` },
      })
    ).json()) as {
      rotationKeys: string[];
      alsoKnownAs: string[];
      verificationMethods: Record<string, string>;
      services: Record<string, { type: string; endpoint: string }>;
    };

    await dpopA.fetchWithDpop(`${ghA.url}/xrpc/com.atproto.identity.requestPlcOperationSignature`, {
      method: "POST",
      accessToken: tokA,
    });
    const claimCut = (await (
      await dpopA.fetchWithDpop(`${ghA.url}/group-admin/claim-action-token`, {
        method: "POST",
        accessToken: tokA,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ group: groupDid, purpose: "plc_operation" }),
      })
    ).json()) as { token: string };

    const signCutRes = await dpopA.fetchWithDpop(`${ghA.url}/xrpc/com.atproto.identity.signPlcOperation`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: claimCut.token, ...recCut }),
    });
    assert.equal(signCutRes.status, 200);
    const { operation: signedCutOp } = (await signCutRes.json()) as { operation: Record<string, unknown> };

    // First `submitPlcOperation` commits PLC cutover and sets `plc_cutover_at`
    const sub1Res = await fetch(`${ghB.url}/xrpc/com.atproto.identity.submitPlcOperation`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${stageCutToks.accessJwt}`,
      },
      body: JSON.stringify({ operation: signedCutOp }),
    });
    assert.equal(sub1Res.status, 200);

    // Second `submitPlcOperation` (client retry after lost HTTP response!) returns `200` idempotently!
    const sub2Res = await fetch(`${ghB.url}/xrpc/com.atproto.identity.submitPlcOperation`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${stageCutToks.accessJwt}`,
      },
      body: JSON.stringify({ operation: signedCutOp }),
    });
    assert.equal(
      sub2Res.status,
      200,
      `Duplicate submitPlcOperation after plc_cutover_at must return 200 idempotently: ${await sub2Res.clone().text()}`,
    );

    // Verify `finalizeMigratedSource` rejects omitted `typ`, `exp <= iat`, `exp - iat > 60`, and `iat > now + 5`
    const groupSigKeyB = await ghB.repoStore.getGroupSigningKey(groupDid);
    const finNowSec = Math.floor(Date.now() / 1000);
    for (const badFinSpec of [
      { header: { alg: "ES256" }, claims: { iat: finNowSec, exp: finNowSec + 60, jti: randomUUID() } },
      { header: { typ: "JWT", alg: "ES256" }, claims: { iat: finNowSec + 15, exp: finNowSec + 60, jti: randomUUID() } },
      { header: { typ: "JWT", alg: "ES256" }, claims: { iat: finNowSec - 10, exp: finNowSec + 55, jti: randomUUID() } },
      { header: { typ: "JWT", alg: "ES256" }, claims: { iat: finNowSec + 3, exp: finNowSec + 2, jti: randomUUID() } },
    ]) {
      const badFinJwt = await signCustomServiceJwt(groupSigKeyB, badFinSpec.header, {
        iss: groupDid,
        aud: ghA.config.serviceDid,
        lxm: "com.atproto.server.deactivateAccount",
        ...badFinSpec.claims,
      });
      const badFinRes = await fetch(`${ghA.url}/group-admin/finalize-migrated-source`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${badFinJwt}`,
        },
        body: JSON.stringify({ group: groupDid }),
      });
      assert.equal(badFinRes.status, 401);
    }
  } finally {
    await ghA.close();
    await ghB.close();
    await pds.close();
    await plc.close();
  }
});

test("Round 5 hardening: operation-ID tombstones block same-ID reuse and pre-arrival aborts, and migration key provenance fails closed against live PLC rotationKeys & JWT bounds", async () => {
  const plc = await startMockPlcServer();
  const pds = await startMockPersonalPds(plc);
  let interceptTargetOutbound:
    | ((url: string, init: RequestInit | undefined, forward: () => Promise<Response>) => Promise<Response>)
    | undefined;
  const ghA = await startTestGroupHost({ plc, handleDomain: "r5a.groups.localhost" });
  const ghB = await startTestGroupHost({
    plc,
    handleDomain: "r5b.groups.localhost",
    overrides: {
      fetchImpl: async (input, init) => {
        const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const forward = () => fetch(input, init);
        if (interceptTargetOutbound) {
          return interceptTargetOutbound(urlStr, init, forward);
        }
        return forward();
      },
    },
  });

  try {
    const alice = await pds.registerUser("alice-r5.test");
    const adminScopeStr = groupAdminScopes().join(" ");
    const flowA = await createSteppedUpGroupFlow({
      groupHost: ghA,
      pds,
      user: alice,
      scope: adminScopeStr,
      prompt: "create",
      createParams: { displayName: "Round 5 Migration", handle: "r5.r5a.groups.localhost" },
    });
    const dpopA = flowA.dpop;
    const tokA = flowA.tokenResponse!.access_token;
    const groupDid = flowA.tokenResponse!.sub;
    const groupSigKeyA = await ghA.repoStore.getGroupSigningKey(groupDid);
    const localRotA = await ghA.repoStore.getGroupRotationKey(groupDid);
    assert.ok(localRotA);

    const makeCreateJwt = () =>
      createServiceJwt({
        iss: groupDid,
        aud: ghB.config.serviceDid,
        lxm: "com.atproto.server.createAccount",
        keypair: groupSigKeyA,
      });
    const makeAbortJwt = () =>
      createServiceJwt({
        iss: groupDid,
        aud: ghB.config.serviceDid,
        lxm: "group.opensocial.abortMigration",
        keypair: groupSigKeyA,
      });

    // =========================================================================
    // 1. Codex Round 5 Finding #2: Same-operationId reuse blocked by tombstone
    // =========================================================================
    // Stage Standard session with `op-r5-1`
    const stageOp1Res = await fetch(`${ghB.url}/xrpc/com.atproto.server.createAccount`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await makeCreateJwt()}`,
        "x-group-migration-operation-id": "op-r5-1",
      },
      body: JSON.stringify({ did: groupDid, handle: "r5.r5b.groups.localhost" }),
    });
    assert.equal(stageOp1Res.status, 200);
    const op1Toks = (await stageOp1Res.json()) as { accessJwt: string };

    // Bearer-abort `op-r5-1` on target
    const bearerAbortOp1 = await fetch(`${ghB.url}/group-admin/abort-migration`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${op1Toks.accessJwt}` },
      body: JSON.stringify({ group: groupDid, operationId: "op-r5-1" }),
    });
    assert.equal(bearerAbortOp1.status, 200);
    assert.equal(((await bearerAbortOp1.json()) as { status: string }).status, "purged");

    // Reusing `op-r5-1` on `createAccount` MUST fail with `409 OperationIdAlreadyAborted`!
    const reuseOp1Res = await fetch(`${ghB.url}/xrpc/com.atproto.server.createAccount`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await makeCreateJwt()}`,
        "x-group-migration-operation-id": "op-r5-1",
      },
      body: JSON.stringify({ did: groupDid, handle: "r5.r5b.groups.localhost" }),
    });
    assert.equal(reuseOp1Res.status, 409);
    assert.equal(((await reuseOp1Res.json()) as { error: string }).error, "OperationIdAlreadyAborted");

    // Stage fresh `op-r5-2`
    const stageOp2Res = await fetch(`${ghB.url}/xrpc/com.atproto.server.createAccount`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await makeCreateJwt()}`,
        "x-group-migration-operation-id": "op-r5-2",
      },
      body: JSON.stringify({ did: groupDid, handle: "r5.r5b.groups.localhost" }),
    });
    assert.equal(stageOp2Res.status, 200);
    const op2Toks = (await stageOp2Res.json()) as { accessJwt: string };

    // Delayed `#atproto` reaper abort JWT for `op-r5-1` arrives -> `200 { status: "superseded" }` and `op-r5-2` survives!
    const delayedReaperAbortRes = await fetch(`${ghB.url}/group-admin/abort-migration`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await makeAbortJwt()}`,
      },
      body: JSON.stringify({
        group: groupDid,
        operationId: "op-r5-1",
        deadlineAtMs: Date.now() + 7_200_000,
      }),
    });
    assert.equal(delayedReaperAbortRes.status, 200);
    assert.equal(((await delayedReaperAbortRes.json()) as { status: string }).status, "superseded");
    const op2CheckRes = await fetch(`${ghB.url}/xrpc/com.atproto.server.checkAccountStatus`, {
      headers: { authorization: `Bearer ${op2Toks.accessJwt}` },
    });
    assert.equal(op2CheckRes.status, 200, "op-r5-2 must remain 100% intact after delayed reaper abort for op-r5-1");

    // Clean up `op-r5-2` via Bearer abort; verify `op-r5-1` AND `op-r5-2` tombstones both survive staging/abort purges!
    const bearerAbortOp2 = await fetch(`${ghB.url}/group-admin/abort-migration`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${op2Toks.accessJwt}` },
      body: JSON.stringify({ group: groupDid }),
    });
    assert.equal(bearerAbortOp2.status, 200);
    for (const retiredOp of ["op-r5-1", "op-r5-2"]) {
      const retryRetired = await fetch(`${ghB.url}/xrpc/com.atproto.server.createAccount`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await makeCreateJwt()}`,
          "x-group-migration-operation-id": retiredOp,
        },
        body: JSON.stringify({ did: groupDid, handle: "r5.r5b.groups.localhost" }),
      });
      assert.equal(retryRetired.status, 409, `${retiredOp} tombstone must survive subsequent staging/abort purges`);
      assert.equal(((await retryRetired.json()) as { error: string }).error, "OperationIdAlreadyAborted");
    }

    // Pre-arrival `#atproto` abort JWT (`status: "already_absent"`) tombstones `op-pre-r5` before late `createAccount`!
    const preAbortRes = await fetch(`${ghB.url}/group-admin/abort-migration`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await makeAbortJwt()}`,
      },
      body: JSON.stringify({
        group: groupDid,
        operationId: "op-pre-r5",
        deadlineAtMs: Date.now() + 7_200_000,
      }),
    });
    assert.equal(preAbortRes.status, 200);
    assert.equal(((await preAbortRes.json()) as { status: string }).status, "already_absent");

    const lateStagePreRes = await fetch(`${ghB.url}/xrpc/com.atproto.server.createAccount`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await makeCreateJwt()}`,
        "x-group-migration-operation-id": "op-pre-r5",
      },
      body: JSON.stringify({ did: groupDid, handle: "r5.r5b.groups.localhost" }),
    });
    assert.equal(lateStagePreRes.status, 409);
    assert.equal(((await lateStagePreRes.json()) as { error: string }).error, "OperationIdAlreadyAborted");

    // Expired un-cutover `migration_session` reaped by `flushBackgroundWork` (`sweepExpiredMigrationSessions`) reconciles PLC and tombstones `operation_id`!
    const stageReapRes = await fetch(`${ghB.url}/xrpc/com.atproto.server.createAccount`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await makeCreateJwt()}`,
        "x-group-migration-operation-id": "op-reaped-r5",
      },
      body: JSON.stringify({ did: groupDid, handle: "r5.r5b.groups.localhost" }),
    });
    assert.equal(stageReapRes.status, 200);
    ghB.db
      .prepare("UPDATE migration_session SET absolute_deadline_at = ? WHERE group_did = ?")
      .run(Date.now() - 5_000, groupDid);
    await ghB.flushBackgroundWork();
    assert.equal(ghB.db.prepare("SELECT 1 FROM migration_session WHERE group_did = ?").get(groupDid), undefined);

    const reuseReapedRes = await fetch(`${ghB.url}/xrpc/com.atproto.server.createAccount`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await makeCreateJwt()}`,
        "x-group-migration-operation-id": "op-reaped-r5",
      },
      body: JSON.stringify({ did: groupDid, handle: "r5.r5b.groups.localhost" }),
    });
    assert.equal(reuseReapedRes.status, 409);
    assert.equal(((await reuseReapedRes.json()) as { error: string }).error, "OperationIdAlreadyAborted");

    // =========================================================================
    // 2. Codex Round 5 Finding #3: Fail-closed `public-group-keys` & `migration-manifest` provenance
    // =========================================================================
    const uninvolvedRotKey = await P256Keypair.create();
    const nowSec = Math.floor(Date.now() / 1000);

    for (const badProofCase of [
      {
        label: "missing typ: JWT",
        header: { alg: "ES256", kid: "#atproto" },
        localRotationKey: localRotA.did(),
        claims: {
          iss: groupDid,
          groupDid,
          localRotationKey: localRotA.did(),
          iat: nowSec,
          exp: nowSec + 300,
        },
      },
      {
        label: "missing iat",
        header: { typ: "JWT", alg: "ES256", kid: "#atproto" },
        localRotationKey: localRotA.did(),
        claims: {
          iss: groupDid,
          groupDid,
          localRotationKey: localRotA.did(),
          exp: nowSec + 300,
        },
      },
      {
        label: "future iat > now + 5s",
        header: { typ: "JWT", alg: "ES256", kid: "#atproto" },
        localRotationKey: localRotA.did(),
        claims: {
          iss: groupDid,
          groupDid,
          localRotationKey: localRotA.did(),
          iat: nowSec + 30,
          exp: nowSec + 300,
        },
      },
      {
        label: "exp - iat > 300s",
        header: { typ: "JWT", alg: "ES256", kid: "#atproto" },
        localRotationKey: localRotA.did(),
        claims: {
          iss: groupDid,
          groupDid,
          localRotationKey: localRotA.did(),
          iat: nowSec - 10,
          exp: nowSec + 310,
        },
      },
      {
        label: "localRotationKey absent from live PLC rotationKeys",
        header: { typ: "JWT", alg: "ES256", kid: "#atproto" },
        localRotationKey: uninvolvedRotKey.did(),
        claims: {
          iss: groupDid,
          groupDid,
          localRotationKey: uninvolvedRotKey.did(),
          iat: nowSec,
          exp: nowSec + 300,
        },
      },
    ]) {
      const forgedProofJwt = await signCustomServiceJwt(groupSigKeyA, badProofCase.header, badProofCase.claims);
      interceptTargetOutbound = async (urlStr, _init, forward) => {
        if (urlStr.includes("/group-admin/public-group-keys")) {
          return new Response(
            JSON.stringify({
              groupDid,
              localRotationKey: badProofCase.localRotationKey,
              proofJwt: forgedProofJwt,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return forward();
      };

      const badStdRes = await fetch(`${ghB.url}/xrpc/com.atproto.server.createAccount`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await makeCreateJwt()}`,
          "x-group-migration-operation-id": `op-bad-pk-${randomUUID().slice(0, 8)}`,
        },
        body: JSON.stringify({ did: groupDid, handle: "r5.r5b.groups.localhost" }),
      });
      assert.equal(badStdRes.status, 400, `public-group-keys ${badProofCase.label} must fail closed with 400`);
      assert.equal(((await badStdRes.json()) as { error: string }).error, "InvalidSourceKeyProof");
      assert.equal(
        ghB.db.prepare("SELECT 1 FROM migration_session WHERE group_did = ?").get(groupDid),
        undefined,
        `Target must NOT stage migration_session on bad public-group-keys (${badProofCase.label})`,
      );
    }
    interceptTargetOutbound = undefined;

    // Coordinated `migration-manifest` fail-closed checks: `sourceLocalRotationKey` not in live PLC `rotationKeys` (`400 InvalidSourceKeyProof`),
    // expired `deadlineAtMs` (`400 InvalidMigrationManifest`), and invalid `operationId` (`400 InvalidMigrationManifest`)!
    const prepCoord = await dpopA.fetchWithDpop(`${ghA.url}/group-admin/prepare-migration`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ group: groupDid, operationId: "op-r5-coord", targetEndpoint: ghB.url }),
    });
    assert.equal(prepCoord.status, 200);
    const { migrationTicket: coordTicket } = (await prepCoord.json()) as { migrationTicket: string };

    for (const badManifestCase of [
      {
        label: "sourceLocalRotationKey not in live PLC rotationKeys",
        mutate: (body: Record<string, unknown>) => ({ ...body, sourceLocalRotationKey: uninvolvedRotKey.did() }),
        expectedCode: "InvalidSourceKeyProof",
      },
      {
        label: "expired deadlineAtMs",
        mutate: (body: Record<string, unknown>) => ({ ...body, deadlineAtMs: Date.now() - 5_000 }),
        expectedCode: "InvalidMigrationManifest",
      },
      {
        label: "excessive deadlineAtMs > now + 2h + 60s",
        mutate: (body: Record<string, unknown>) => ({ ...body, deadlineAtMs: Date.now() + 3 * 3_600_000 }),
        expectedCode: "InvalidMigrationManifest",
      },
      {
        label: "invalid operationId syntax",
        mutate: (body: Record<string, unknown>) => ({ ...body, operationId: "invalid op id!" }),
        expectedCode: "InvalidMigrationManifest",
      },
    ]) {
      interceptTargetOutbound = async (urlStr, _init, forward) => {
        const upstreamRes = await forward();
        if (urlStr.includes("/group-admin/migration-manifest")) {
          const origJson = (await upstreamRes.json()) as Record<string, unknown>;
          return new Response(JSON.stringify(badManifestCase.mutate(origJson)), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return upstreamRes;
      };

      const badCoordRes = await fetch(`${ghB.url}/xrpc/com.atproto.server.createAccount`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await makeCreateJwt()}`,
          "x-group-migration-ticket": coordTicket,
        },
        body: JSON.stringify({ did: groupDid, handle: "r5.r5b.groups.localhost" }),
      });
      assert.equal(badCoordRes.status, 400, `migration-manifest ${badManifestCase.label} must fail closed with 400`);
      assert.equal(((await badCoordRes.json()) as { error: string }).error, badManifestCase.expectedCode);
      assert.equal(
        ghB.db.prepare("SELECT 1 FROM migration_session WHERE group_did = ?").get(groupDid),
        undefined,
        `Target must NOT stage migration_session on bad migration-manifest (${badManifestCase.label})`,
      );
    }
    interceptTargetOutbound = undefined;
  } finally {
    await ghA.close();
    await ghB.close();
    await pds.close();
    await plc.close();
  }
});

test("Round 7 hardening: signPlcOperation validates all preconditions before revoking credentials or abandoning outbox rows, refreshSession rotates atomically under concurrency, and verifyOpenSocialTargetCapability enforces JWT/kid/lifetime constraints", async () => {
  const plc = await startMockPlcServer();
  const pds = await startMockPersonalPds(plc);
  let interceptSourceOutbound:
    | ((url: string, init: RequestInit | undefined, forward: () => Promise<Response>) => Promise<Response>)
    | undefined;
  const ghA = await startTestGroupHost({
    plc,
    handleDomain: "r7a.groups.localhost",
    overrides: {
      fetchImpl: async (input, init) => {
        const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const forward = () => fetch(input, init);
        if (interceptSourceOutbound) {
          return interceptSourceOutbound(urlStr, init, forward);
        }
        return forward();
      },
    },
  });
  const ghB = await startTestGroupHost({ plc, handleDomain: "r7b.groups.localhost" });

  // Also start `ghRot`, configured with `GROUP_HOST_SERVICE_PRIVATE_JWKS` (`#atproto-rot-primary` + `#atproto-rot-prev`),
  // to verify designated overlap signing keys succeed in `verifyOpenSocialTargetCapability`!
  const rotJwk1 = await jose.generateKeyPair("ES256", { extractable: true });
  const rotJwk2 = await jose.generateKeyPair("ES256", { extractable: true });
  const expRot1 = await jose.exportJWK(rotJwk1.privateKey);
  const expRot2 = await jose.exportJWK(rotJwk2.privateKey);
  const ghRot = await startTestGroupHost({
    plc,
    handleDomain: "r7rot.groups.localhost",
    overrides: {
      servicePrivateJwks: [
        { kid: "rot-primary", kty: "EC", crv: "P-256", x: expRot1.x!, y: expRot1.y!, d: expRot1.d! },
        { kid: "rot-prev", kty: "EC", crv: "P-256", x: expRot2.x!, y: expRot2.y!, d: expRot2.d! },
      ],
    },
  });

  try {
    const alice = await pds.registerUser("alice-r7.test");
    const bob = await pds.registerUser("bob-r7.test");
    const adminScopeStr = groupAdminScopes().join(" ");

    const flowA = await createSteppedUpGroupFlow({
      groupHost: ghA,
      pds,
      user: alice,
      scope: adminScopeStr,
      prompt: "create",
      createParams: {
        displayName: "Round 7 Group",
        handle: "r7.r7a.groups.localhost",
        joinPolicy: "open",
        publicMeta: true,
      },
    });
    const dpopA = flowA.dpop;
    const tokA = flowA.tokenResponse!.access_token;
    const groupDid = flowA.tokenResponse!.sub;
    const membersSpace = `at://${groupDid}/space/group.opensocial.members/self`;
    const metaSpace = `at://${groupDid}/space/group.opensocial.meta/self`;

    // Add an external sovereign PLC rotation key (`sovKey`) so we can test `SovereignRotationKeyDropped` too
    const sovKey = await P256Keypair.create({ exportable: true });
    await dpopA.fetchWithDpop(`${ghA.url}/xrpc/com.atproto.identity.requestPlcOperationSignature`, {
      method: "POST",
      accessToken: tokA,
    });
    const claimInit = (await (
      await dpopA.fetchWithDpop(`${ghA.url}/group-admin/claim-action-token`, {
        method: "POST",
        accessToken: tokA,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ group: groupDid, purpose: "plc_operation" }),
      })
    ).json()) as { token: string };
    const lastOp0 = (await (await fetch(`${plc.url}/${encodeURIComponent(groupDid)}/log/last`)).json()) as {
      rotationKeys: string[];
    };
    const signedSovRes = await dpopA.fetchWithDpop(`${ghA.url}/xrpc/com.atproto.identity.signPlcOperation`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: claimInit.token,
        rotationKeys: [...lastOp0.rotationKeys, sovKey.did()],
      }),
    });
    assert.equal(signedSovRes.status, 200);
    const { operation: signedSovOp } = (await signedSovRes.json()) as { operation: Record<string, unknown> };
    const subSovRes = await dpopA.fetchWithDpop(`${ghA.url}/xrpc/com.atproto.identity.submitPlcOperation`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: signedSovOp }),
    });
    assert.equal(subSovRes.status, 200);

    // Admit Bob with `identity:*` scope in a non-admin custom role so Bob passes `assertIdentity`
    // yet fails `isAuthorizedLifecycleAdmin`!
    const putNonAdminIdRole = await dpopA.fetchWithDpop(`${ghA.url}/xrpc/com.atproto.space.putRecord`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: membersSpace,
        repo: groupDid,
        collection: "group.opensocial.role",
        rkey: "id-viewer",
        record: {
          $type: "group.opensocial.role",
          displayName: "Identity Viewer",
          scopes: ["identity:*"],
        },
      }),
    });
    assert.equal(putNonAdminIdRole.status, 200);
    const putBobMem = await dpopA.fetchWithDpop(`${ghA.url}/xrpc/com.atproto.space.putRecord`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: membersSpace,
        repo: groupDid,
        collection: "group.opensocial.membership",
        rkey: bob.did,
        record: {
          $type: "group.opensocial.membership",
          roles: ["member", "id-viewer"],
          createdAt: new Date().toISOString(),
        },
      }),
    });
    assert.equal(putBobMem.status, 200);

    const bobFlow = await completeGroupOAuthFlow({
      groupHost: ghA,
      pds,
      user: bob,
      scope: "atproto identity:*",
      prompt: "login",
      loginHint: groupDid,
    });
    const bobDpop = bobFlow.dpop;
    const bobTok = bobFlow.tokenResponse!.access_token;

    // =========================================================================
    // 1. Codex Round 7 Finding #3: `verifyOpenSocialTargetCapability` JWT/kid/lifetime hardening
    // =========================================================================
    const auxKey = await P256Keypair.create({ exportable: true });
    const kemKey = await P256Keypair.create({ exportable: true });
    const auxMultibase = auxKey.did().replace(/^did:key:/, "");
    const kemMultibase = kemKey.did().replace(/^did:key:/, "");
    const targetDid = ghB.config.serviceDid;
    const targetKeypair = ghB.migration.serviceKeys.activeKeypair;
    const nowSecCap = Math.floor(Date.now() / 1000);

    for (const badCapCase of [
      {
        label: "missing typ: JWT",
        signer: targetKeypair,
        header: { alg: "ES256", kid: "#atproto" },
        claims: {
          iss: targetDid,
          iat: nowSecCap,
          exp: nowSecCap + 300,
          endpoint: ghB.url,
          supportedSpacePolicies: ["group.opensocial.policy"],
          atomicMigrationVersion: 1,
        },
      },
      {
        label: "wrong typ: at+jwt",
        signer: targetKeypair,
        header: { typ: "at+jwt", alg: "ES256", kid: "#atproto" },
        claims: {
          iss: targetDid,
          iat: nowSecCap,
          exp: nowSecCap + 300,
          endpoint: ghB.url,
          supportedSpacePolicies: ["group.opensocial.policy"],
          atomicMigrationVersion: 1,
        },
      },
      {
        label: "auxiliary verificationMethod kid #aux",
        signer: auxKey,
        header: { typ: "JWT", alg: "ES256", kid: "#aux" },
        claims: {
          iss: targetDid,
          iat: nowSecCap,
          exp: nowSecCap + 300,
          endpoint: ghB.url,
          supportedSpacePolicies: ["group.opensocial.policy"],
          atomicMigrationVersion: 1,
        },
      },
      {
        label: "auxiliary verificationMethod full DID#aux",
        signer: auxKey,
        header: { typ: "JWT", alg: "ES256", kid: `${targetDid}#aux` },
        claims: {
          iss: targetDid,
          iat: nowSecCap,
          exp: nowSecCap + 300,
          endpoint: ghB.url,
          supportedSpacePolicies: ["group.opensocial.policy"],
          atomicMigrationVersion: 1,
        },
      },
      {
        label: "HPKE encryption verificationMethod #atproto_kem",
        signer: kemKey,
        header: { typ: "JWT", alg: "ES256", kid: "#atproto_kem" },
        claims: {
          iss: targetDid,
          iat: nowSecCap,
          exp: nowSecCap + 300,
          endpoint: ghB.url,
          supportedSpacePolicies: ["group.opensocial.policy"],
          atomicMigrationVersion: 1,
        },
      },
      {
        label: "missing iat",
        signer: targetKeypair,
        header: { typ: "JWT", alg: "ES256", kid: "#atproto" },
        claims: {
          iss: targetDid,
          exp: nowSecCap + 300,
          endpoint: ghB.url,
          supportedSpacePolicies: ["group.opensocial.policy"],
          atomicMigrationVersion: 1,
        },
      },
      {
        label: "future iat > now + 5s",
        signer: targetKeypair,
        header: { typ: "JWT", alg: "ES256", kid: "#atproto" },
        claims: {
          iss: targetDid,
          iat: nowSecCap + 30,
          exp: nowSecCap + 300,
          endpoint: ghB.url,
          supportedSpacePolicies: ["group.opensocial.policy"],
          atomicMigrationVersion: 1,
        },
      },
      {
        label: "expired exp <= now",
        signer: targetKeypair,
        header: { typ: "JWT", alg: "ES256", kid: "#atproto" },
        claims: {
          iss: targetDid,
          iat: nowSecCap - 120,
          exp: nowSecCap,
          endpoint: ghB.url,
          supportedSpacePolicies: ["group.opensocial.policy"],
          atomicMigrationVersion: 1,
        },
      },
      {
        label: "non-positive lifetime exp <= iat",
        signer: targetKeypair,
        header: { typ: "JWT", alg: "ES256", kid: "#atproto" },
        claims: {
          iss: targetDid,
          iat: nowSecCap + 3,
          exp: nowSecCap + 2,
          endpoint: ghB.url,
          supportedSpacePolicies: ["group.opensocial.policy"],
          atomicMigrationVersion: 1,
        },
      },
      {
        label: "excessive lifetime exp - iat > 300s",
        signer: targetKeypair,
        header: { typ: "JWT", alg: "ES256", kid: "#atproto" },
        claims: {
          iss: targetDid,
          iat: nowSecCap - 10,
          exp: nowSecCap + 295,
          endpoint: ghB.url,
          supportedSpacePolicies: ["group.opensocial.policy"],
          atomicMigrationVersion: 1,
        },
      },
    ]) {
      const badCapJwt = await signCustomServiceJwt(badCapCase.signer, badCapCase.header, badCapCase.claims);
      interceptSourceOutbound = async (urlStr, _init, forward) => {
        if (urlStr === `${ghB.url}/group-admin/migration-info`) {
          const orig = (await (await forward()).json()) as Record<string, unknown>;
          return new Response(JSON.stringify({ ...orig, capabilityProofJwt: badCapJwt }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (urlStr.endsWith("/.well-known/did.json") && urlStr.includes(String(new URL(ghB.url).port))) {
          const origDoc = (await (await forward()).json()) as {
            id: string;
            verificationMethod: Array<Record<string, unknown>>;
            service: unknown[];
          };
          return new Response(
            JSON.stringify({
              ...origDoc,
              verificationMethod: [
                ...origDoc.verificationMethod,
                { id: `${origDoc.id}#aux`, type: "Multikey", controller: origDoc.id, publicKeyMultibase: auxMultibase },
                {
                  id: `${origDoc.id}#atproto_kem`,
                  type: "Multikey",
                  controller: origDoc.id,
                  publicKeyMultibase: kemMultibase,
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/did+ld+json" } },
          );
        }
        return forward();
      };

      const badPrepRes = await dpopA.fetchWithDpop(`${ghA.url}/group-admin/prepare-migration`, {
        method: "POST",
        accessToken: tokA,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          group: groupDid,
          operationId: `op-bad-cap-${randomUUID().slice(0, 8)}`,
          targetEndpoint: ghB.url,
        }),
      });
      assert.equal(badPrepRes.status, 400, `prepare-migration must reject capabilityProofJwt (${badCapCase.label})`);
      assert.equal(((await badPrepRes.json()) as { error: string }).error, "UnsupportedGroupHostTarget");

      const badSvcAuthRes = await dpopA.fetchWithDpop(
        `${ghA.url}/xrpc/com.atproto.server.getServiceAuth?aud=${encodeURIComponent(targetDid)}&lxm=com.atproto.server.createAccount`,
        { method: "GET", accessToken: tokA },
      );
      assert.equal(badSvcAuthRes.status, 400, `getServiceAuth(createAccount) must reject (${badCapCase.label})`);
      assert.equal(((await badSvcAuthRes.json()) as { error: string }).error, "UnsupportedGroupHostTarget");
    }
    interceptSourceOutbound = undefined;

    // Positive check: `ghRot` (`GROUP_HOST_SERVICE_PRIVATE_JWKS` with `#atproto-rot-primary`) succeeds in coordinated mode!
    const prepRotRes = await dpopA.fetchWithDpop(`${ghA.url}/group-admin/prepare-migration`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        group: groupDid,
        operationId: "op-r7-rot-valid",
        targetEndpoint: ghRot.url,
      }),
    });
    assert.equal(prepRotRes.status, 200, `GROUP_HOST_SERVICE_PRIVATE_JWKS target failed: ${await prepRotRes.clone().text()}`);
    assert.equal(((await prepRotRes.json()) as { mode: string }).mode, "coordinated");
    await dpopA.fetchWithDpop(`${ghA.url}/group-admin/abort-migration`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ group: groupDid, operationId: "op-r7-rot-valid" }),
    });

    // =========================================================================
    // 2. Codex Round 7 Finding #1: `signPlcOperation` zero destructive side effects on ANY failure!
    // =========================================================================
    // Mint a live public-read space credential on `metaSpace` AND seed a `'pending'` outbox row on `ghA`!
    const credKeypair = await P256Keypair.create({ exportable: true });
    const authSyncRes = await fetch(`${ghA.url}/xrpc/com.atproto.space.authorizeSpaceSync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: metaSpace,
        credentialKey: credKeypair.did(),
      }),
    });
    assert.equal(authSyncRes.status, 200);

    const seededNoticeId = `r7-pending-notice-${randomUUID()}`;
    const futureMs = Date.now() + 600_000;
    ghA.db
      .prepare(
        `INSERT INTO outbox_notice (
           id, kind, group_did, coalesce_key, endpoint, token, space_uri, writer_did,
           payload_json, status, attempts, max_attempts, lease_until, next_attempt_at, expires_at, created_at
         ) VALUES (?, 'syncer_update', ?, ?, 'http://127.0.0.1:9', 'tok', ?, NULL, '{}', 'pending', 0, 5, NULL, ?, ?, ?)`,
      )
      .run(seededNoticeId, groupDid, `test\u0000${seededNoticeId}`, metaSpace, futureMs, futureMs + 60_000, Date.now());

    const assertZeroCutoverSideEffects = (context: string) => {
      const issuedCnt = (
        ghA.db.prepare("SELECT COUNT(*) AS cnt FROM issued_credential WHERE group_did = ?").get(groupDid) as {
          cnt: number;
        }
      ).cnt;
      const revokedCnt = (
        ghA.db.prepare("SELECT COUNT(*) AS cnt FROM revoked_credential WHERE group_did = ?").get(groupDid) as {
          cnt: number;
        }
      ).cnt;
      const noticeRow = ghA.db
        .prepare("SELECT status, attempts FROM outbox_notice WHERE id = ?")
        .get(seededNoticeId) as { status: string; attempts: number } | undefined;
      assert.equal(issuedCnt, 1, `[${context}] issued_credential must remain intact`);
      assert.equal(revokedCnt, 0, `[${context}] zero credentials may be revoked on failed signPlcOperation`);
      assert.equal(noticeRow?.status, "pending", `[${context}] pending outbox_notice must not be flushed or abandoned`);
      assert.equal(noticeRow?.attempts, 0, `[${context}] pending outbox_notice must have 0 delivery attempts`);
    };

    const ghALocalRot = (await ghA.repoStore.getGroupRotationKey(groupDid))!.did();
    const targetCandKey = await P256Keypair.create();
    const targetSignKey = await P256Keypair.create();
    const targetKemKey = await P256Keypair.create();
    const cutoverParams = {
      rotationKeys: [targetCandKey.did(), sovKey.did()],
      alsoKnownAs: ["at://r7.r7b.groups.localhost"],
      verificationMethods: {
        atproto: targetSignKey.did(),
        atproto_kem: targetKemKey.did(),
      },
      services: {
        atproto_pds: { type: "AtprotoPersonalDataServer", endpoint: ghB.url },
        opensocial_group: { type: "OpenSocialGroupHost", endpoint: ghB.url },
      },
    };

    // Request and claim a genuine `plc_operation` token for Alice
    await dpopA.fetchWithDpop(`${ghA.url}/xrpc/com.atproto.identity.requestPlcOperationSignature`, {
      method: "POST",
      accessToken: tokA,
    });
    const alicePlcToken = (
      (await (
        await dpopA.fetchWithDpop(`${ghA.url}/group-admin/claim-action-token`, {
          method: "POST",
          accessToken: tokA,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ group: groupDid, purpose: "plc_operation" }),
        })
      ).json()) as { token: string }
    ).token;

    // (a) Missing `token` -> `400 InvalidToken`
    const noTokRes = await dpopA.fetchWithDpop(`${ghA.url}/xrpc/com.atproto.identity.signPlcOperation`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cutoverParams),
    });
    assert.equal(noTokRes.status, 400);
    assert.equal(((await noTokRes.json()) as { error: string }).error, "InvalidToken");
    assertZeroCutoverSideEffects("missing token");

    // (b) Wrong `token` -> `400 InvalidToken` (and Alice's genuine `alicePlcToken` remains unconsumed!)
    const wrongTokRes = await dpopA.fetchWithDpop(`${ghA.url}/xrpc/com.atproto.identity.signPlcOperation`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "wrong-confirmation-token", ...cutoverParams }),
    });
    assert.equal(wrongTokRes.status, 400);
    assert.equal(((await wrongTokRes.json()) as { error: string }).error, "InvalidToken");
    assertZeroCutoverSideEffects("wrong token");

    // (c) Non-lifecycle-admin Bob (`identity:*` present, but not admin!) -> `403 Forbidden`
    const bobSignRes = await bobDpop.fetchWithDpop(`${ghA.url}/xrpc/com.atproto.identity.signPlcOperation`, {
      method: "POST",
      accessToken: bobTok,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: alicePlcToken, ...cutoverParams }),
    });
    assert.equal(bobSignRes.status, 403);
    assert.equal(((await bobSignRes.json()) as { error: string }).error, "Forbidden");
    assertZeroCutoverSideEffects("non-admin caller");

    // (d) Unleased cutover to bare personal PDS (`pds.url`) -> `400 UnsupportedGroupHostTarget`
    const barePdsSignRes = await dpopA.fetchWithDpop(`${ghA.url}/xrpc/com.atproto.identity.signPlcOperation`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: alicePlcToken,
        ...cutoverParams,
        services: {
          atproto_pds: { type: "AtprotoPersonalDataServer", endpoint: pds.url },
        },
      }),
    });
    assert.equal(barePdsSignRes.status, 400);
    assert.equal(((await barePdsSignRes.json()) as { error: string }).error, "UnsupportedGroupHostTarget");
    assertZeroCutoverSideEffects("bare PDS target");

    // (e) `SourceRotationKeyRetained` & `SovereignRotationKeyDropped` -> `400`
    const retainErrRes = await dpopA.fetchWithDpop(`${ghA.url}/xrpc/com.atproto.identity.signPlcOperation`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: alicePlcToken,
        ...cutoverParams,
        rotationKeys: [...cutoverParams.rotationKeys, ghALocalRot],
      }),
    });
    assert.equal(retainErrRes.status, 400);
    assert.equal(((await retainErrRes.json()) as { error: string }).error, "SourceRotationKeyRetained");
    assertZeroCutoverSideEffects("SourceRotationKeyRetained");

    const dropSovRes = await dpopA.fetchWithDpop(`${ghA.url}/xrpc/com.atproto.identity.signPlcOperation`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: alicePlcToken,
        ...cutoverParams,
        rotationKeys: [targetCandKey.did()],
      }),
    });
    assert.equal(dropSovRes.status, 400);
    assert.equal(((await dropSovRes.json()) as { error: string }).error, "SovereignRotationKeyDropped");
    assertZeroCutoverSideEffects("SovereignRotationKeyDropped");

    // (f) Expired `token` -> `400 ExpiredToken` with zero side effects!
    const origExp = (
      ghA.db
        .prepare("SELECT expires_at FROM group_action_token WHERE group_did = ? AND purpose = 'plc_operation'")
        .get(groupDid) as { expires_at: number }
    ).expires_at;
    ghA.db
      .prepare("UPDATE group_action_token SET expires_at = ? WHERE group_did = ? AND purpose = 'plc_operation'")
      .run(Date.now() - 1_000, groupDid);
    const expTokRes = await dpopA.fetchWithDpop(`${ghA.url}/xrpc/com.atproto.identity.signPlcOperation`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: alicePlcToken, ...cutoverParams }),
    });
    assert.equal(expTokRes.status, 400);
    assert.equal(((await expTokRes.json()) as { error: string }).error, "ExpiredToken");
    assertZeroCutoverSideEffects("expired token");
    // Restore `expires_at` so `alicePlcToken` is still valid for the next negative check!
    ghA.db
      .prepare("UPDATE group_action_token SET expires_at = ? WHERE group_did = ? AND purpose = 'plc_operation'")
      .run(origExp, groupDid);

    // (g) Prepared coordinated migration where target attestation fails (`409 MigrationAttestationFailed`)
    //     because target staging has NOT completed yet -> ZERO credentials revoked, ZERO outbox rows abandoned,
    //     AND `alicePlcToken` remains unconsumed!
    const prepCoord = await dpopA.fetchWithDpop(`${ghA.url}/group-admin/prepare-migration`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        group: groupDid,
        operationId: "op-r7-precheck-coord",
        targetEndpoint: ghB.url,
      }),
    });
    assert.equal(prepCoord.status, 200);
    const { migrationTicket: r7Ticket } = (await prepCoord.json()) as { migrationTicket: string };

    const prematureAttSignRes = await dpopA.fetchWithDpop(`${ghA.url}/xrpc/com.atproto.identity.signPlcOperation`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: alicePlcToken, ...cutoverParams }),
    });
    assert.equal(prematureAttSignRes.status, 409);
    assert.equal(((await prematureAttSignRes.json()) as { error: string }).error, "MigrationAttestationFailed");
    assertZeroCutoverSideEffects("MigrationAttestationFailed");
    assert.ok(
      ghA.db.prepare("SELECT 1 FROM group_action_token WHERE group_did = ? AND purpose = 'plc_operation'").get(groupDid),
      "Valid plc_operation token must NOT be consumed when signPlcOperation fails pre-cutover validation",
    );

    // Clean up the prepared lease on `ghA`
    await dpopA.fetchWithDpop(`${ghA.url}/group-admin/abort-migration`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ group: groupDid, operationId: "op-r7-precheck-coord" }),
    });
    void r7Ticket;

    // =========================================================================
    // 3. Codex Round 7 Finding #2: Atomic single-use `refreshSession` rotation under concurrency!
    // =========================================================================
    const groupSigKeyA = await ghA.repoStore.getGroupSigningKey(groupDid);
    const makeCreateJwt = () =>
      createServiceJwt({
        iss: groupDid,
        aud: ghB.config.serviceDid,
        lxm: "com.atproto.server.createAccount",
        keypair: groupSigKeyA,
      });

    // (a) Uncutover concurrent `refreshSession` race: TWO simultaneous calls with `refreshJwt0` ->
    //     exact `[200, 401]`, and the losing replay purges uncutover staging + tombstones `op-r7-race-uncutover`!
    const stageRace1Res = await fetch(`${ghB.url}/xrpc/com.atproto.server.createAccount`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await makeCreateJwt()}`,
        "x-group-migration-operation-id": "op-r7-race-uncutover",
      },
      body: JSON.stringify({ did: groupDid, handle: "r7.r7b.groups.localhost" }),
    });
    assert.equal(stageRace1Res.status, 200);
    const stageRace1Toks = (await stageRace1Res.json()) as { accessJwt: string; refreshJwt: string };

    const [uncutR1, uncutR2] = await Promise.all([
      fetch(`${ghB.url}/xrpc/com.atproto.server.refreshSession`, {
        method: "POST",
        headers: { authorization: `Bearer ${stageRace1Toks.refreshJwt}` },
      }),
      fetch(`${ghB.url}/xrpc/com.atproto.server.refreshSession`, {
        method: "POST",
        headers: { authorization: `Bearer ${stageRace1Toks.refreshJwt}` },
      }),
    ]);
    assert.deepEqual(
      [uncutR1.status, uncutR2.status].sort((a, b) => a - b),
      [200, 401],
      "Concurrent uncutover refreshSession with same refreshJwt must yield exact [200, 401]",
    );
    assert.equal(
      ghB.db.prepare("SELECT 1 FROM migration_session WHERE group_did = ?").get(groupDid),
      undefined,
      "Losing concurrent refreshJwt replay must purge uncutover staging",
    );
    const retryTombstonedRaceRes = await fetch(`${ghB.url}/xrpc/com.atproto.server.createAccount`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await makeCreateJwt()}`,
        "x-group-migration-operation-id": "op-r7-race-uncutover",
      },
      body: JSON.stringify({ did: groupDid, handle: "r7.r7b.groups.localhost" }),
    });
    assert.equal(retryTombstonedRaceRes.status, 409);
    assert.equal(((await retryTombstonedRaceRes.json()) as { error: string }).error, "OperationIdAlreadyAborted");

    // (b) Post-cutover (`plc_cutover_at !== null`) concurrent `refreshSession` race:
    //     TWO simultaneous calls with `refreshJwtCut0` -> exact `[200, 401]`, staging is NOT purged,
    //     and the winning response's `accessJwt` & `refreshJwt` remain 100% live and unrevoked!
    const stageRace2Res = await fetch(`${ghB.url}/xrpc/com.atproto.server.createAccount`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await makeCreateJwt()}`,
        "x-group-migration-operation-id": "op-r7-race-postcutover",
      },
      body: JSON.stringify({ did: groupDid, handle: "r7.r7b.groups.localhost" }),
    });
    assert.equal(stageRace2Res.status, 200);
    const stageRace2Toks = (await stageRace2Res.json()) as { accessJwt: string; refreshJwt: string };
    ghB.db.prepare("UPDATE migration_session SET plc_cutover_at = ? WHERE group_did = ?").run(Date.now(), groupDid);

    const [cutR1, cutR2] = await Promise.all([
      fetch(`${ghB.url}/xrpc/com.atproto.server.refreshSession`, {
        method: "POST",
        headers: { authorization: `Bearer ${stageRace2Toks.refreshJwt}` },
      }),
      fetch(`${ghB.url}/xrpc/com.atproto.server.refreshSession`, {
        method: "POST",
        headers: { authorization: `Bearer ${stageRace2Toks.refreshJwt}` },
      }),
    ]);
    assert.deepEqual(
      [cutR1.status, cutR2.status].sort((a, b) => a - b),
      [200, 401],
      "Concurrent post-cutover refreshSession with same refreshJwt must yield exact [200, 401]",
    );
    const winningRes = cutR1.status === 200 ? cutR1 : cutR2;
    const winningToks = (await winningRes.json()) as { accessJwt: string; refreshJwt: string };

    const checkWinningAccessRes = await fetch(`${ghB.url}/xrpc/com.atproto.server.checkAccountStatus`, {
      headers: { authorization: `Bearer ${winningToks.accessJwt}` },
    });
    assert.equal(
      checkWinningAccessRes.status,
      200,
      "Losing concurrent refreshSession must NOT revoke the winning response's newly issued accessJwt",
    );

    const checkWinningRefreshRes = await fetch(`${ghB.url}/xrpc/com.atproto.server.refreshSession`, {
      method: "POST",
      headers: { authorization: `Bearer ${winningToks.refreshJwt}` },
    });
    assert.equal(
      checkWinningRefreshRes.status,
      200,
      "Losing concurrent refreshSession must NOT revoke the winning response's newly issued refreshJwt",
    );
  } finally {
    await ghRot.close();
    await ghA.close();
    await ghB.close();
    await pds.close();
    await plc.close();
  }
});


test("Round 9 hardening: strict target cleanup on explicit source abort, withGroupRepoLock OAuth revocation serialization without split state, public-group-keys 502 fail-closed, and +10m clock-skewed Standard reaper abort isolation", async () => {
  const plc = await startMockPlcServer();
  const pds = await startMockPersonalPds(plc);

  let srcOutboundHook:
    | ((urlStr: string, init: RequestInit | undefined, forward: () => Promise<Response>) => Promise<Response>)
    | undefined;
  let dstOutboundHook:
    | ((urlStr: string, init: RequestInit | undefined, forward: () => Promise<Response>) => Promise<Response>)
    | undefined;

  const ghA = await startTestGroupHost({
    plc,
    handleDomain: "r9a.groups.localhost",
    overrides: {
      fetchImpl: async (input, init) => {
        const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const forward = () => fetch(input, init);
        return srcOutboundHook ? srcOutboundHook(urlStr, init, forward) : forward();
      },
    },
  });
  const ghB = await startTestGroupHost({
    plc,
    handleDomain: "r9b.groups.localhost",
    overrides: {
      fetchImpl: async (input, init) => {
        const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const forward = () => fetch(input, init);
        return dstOutboundHook ? dstOutboundHook(urlStr, init, forward) : forward();
      },
    },
  });

  try {
    const alice = await pds.registerUser("alice-r9-mig.test");
    const flowA = await createSteppedUpGroupFlow({
      groupHost: ghA,
      pds,
      user: alice,
      scope: groupAdminScopes().join(" "),
      prompt: "create",
      createParams: {
        displayName: "R9 Migration Group",
        handle: "r9.r9a.groups.localhost",
        joinPolicy: "invite",
        publicMeta: true,
      },
    });
    const dpopA = flowA.dpop;
    const tokA = flowA.tokenResponse!.access_token;
    const groupDid = flowA.tokenResponse!.sub;
    const srcSigKey = await ghA.repoStore.getGroupSigningKey(groupDid);

    const makeCreateJwt = () =>
      createServiceJwt({
        iss: groupDid,
        aud: ghB.config.serviceDid,
        lxm: "com.atproto.server.createAccount",
        keypair: srcSigKey,
      });

    // =========================================================================
    // 1. Finding #8: Explicit `abortMigrationOnSource` fails closed (`502 TargetAbortFailed`)
    //    and preserves `source_migration_lease` for retry when Target cleanup fails!
    // =========================================================================
    const prepCoord = await dpopA.fetchWithDpop(`${ghA.url}/group-admin/prepare-migration`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        group: groupDid,
        operationId: "op-r9-strict-coord",
        targetEndpoint: ghB.url,
      }),
    });
    assert.equal(prepCoord.status, 200);
    const prepCoordBody = (await prepCoord.json()) as { migrationTicket: string };

    const stageCoordRes = await fetch(`${ghB.url}/xrpc/com.atproto.server.createAccount`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await makeCreateJwt()}`,
        "x-group-migration-ticket": prepCoordBody.migrationTicket,
      },
      body: JSON.stringify({ did: groupDid, handle: "r9.r9b.groups.localhost" }),
    });
    assert.equal(stageCoordRes.status, 200);

    for (const failMode of ["503", "404-coord", "network"] as const) {
      srcOutboundHook = async (urlStr, _init, forward) => {
        if (urlStr.endsWith("/group-admin/abort-migration")) {
          if (failMode === "503") {
            return new Response(JSON.stringify({ error: "ServiceUnavailable" }), {
              status: 503,
              headers: { "content-type": "application/json" },
            });
          }
          if (failMode === "404-coord") {
            return new Response(JSON.stringify({ error: "NotFound" }), {
              status: 404,
              headers: { "content-type": "application/json" },
            });
          }
          throw new Error("simulated target abort transport outage");
        }
        return forward();
      };

      const failedAbortRes = await dpopA.fetchWithDpop(`${ghA.url}/group-admin/abort-migration`, {
        method: "POST",
        accessToken: tokA,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ group: groupDid, operationId: "op-r9-strict-coord" }),
      });
      assert.equal(failedAbortRes.status, 502, `Explicit source abort (${failMode}) must fail with 502`);
      assert.equal(((await failedAbortRes.json()) as { error: string }).error, "TargetAbortFailed");
      assert.ok(
        ghA.db.prepare("SELECT 1 FROM source_migration_lease WHERE group_did = ?").get(groupDid),
        `source_migration_lease must remain intact after failed target abort (${failMode})`,
      );
      assert.ok(
        ghB.db.prepare("SELECT 1 FROM migration_session WHERE group_did = ?").get(groupDid),
        `target staging must still exist before retry (${failMode})`,
      );
    }

    // Clear target outage -> retry `abort-migration` on `ghA` -> `200 { status: "aborted" }` and both sides clean!
    srcOutboundHook = undefined;
    const retryAbortRes = await dpopA.fetchWithDpop(`${ghA.url}/group-admin/abort-migration`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ group: groupDid, operationId: "op-r9-strict-coord" }),
    });
    assert.equal(retryAbortRes.status, 200);
    assert.equal(((await retryAbortRes.json()) as { status: string }).status, "aborted");
    assert.equal(ghA.db.prepare("SELECT 1 FROM source_migration_lease WHERE group_did = ?").get(groupDid), undefined);
    assert.equal(ghB.db.prepare("SELECT 1 FROM migration_session WHERE group_did = ?").get(groupDid), undefined);

    // =========================================================================
    // 2. Finding #2: `/oauth/revoke` serializes on `withGroupRepoLock(groupDid)` and never
    //    splits `source_migration_lease` vs Target purge + PLC head advance!
    // =========================================================================
    const prepPlcAbort = await dpopA.fetchWithDpop(`${ghA.url}/group-admin/prepare-migration`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        group: groupDid,
        operationId: "op-r9-revoke-race",
        targetEndpoint: ghB.url,
        mode: "standard",
      }),
    });
    assert.equal(prepPlcAbort.status, 200);
    const stageRevRace = await fetch(`${ghB.url}/xrpc/com.atproto.server.createAccount`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await makeCreateJwt()}`,
        "x-group-migration-operation-id": "op-r9-revoke-race",
      },
      body: JSON.stringify({ did: groupDid, handle: "r9.r9b.groups.localhost" }),
    });
    assert.equal(stageRevRace.status, 200);
    const stageRevRaceToks = (await stageRevRace.json()) as { accessJwt: string };

    for (const spUri of [
      `at://${groupDid}/space/group.opensocial.meta/self`,
      `at://${groupDid}/space/group.opensocial.members/self`,
    ]) {
      const metaStar = new Uint8Array(
        await (
          await dpopA.fetchWithDpop(
            `${ghA.url}/xrpc/com.atproto.space.exportSpaceMeta?space=${encodeURIComponent(spUri)}`,
            { method: "GET", accessToken: tokA },
          )
        ).arrayBuffer(),
      );
      await fetch(`${ghB.url}/xrpc/com.atproto.space.importSpaceMeta`, {
        method: "POST",
        headers: { "content-type": "application/vnd.dasl.star", authorization: `Bearer ${stageRevRaceToks.accessJwt}` },
        body: metaStar,
      });
      const repoStar = new Uint8Array(
        await (
          await dpopA.fetchWithDpop(
            `${ghA.url}/xrpc/com.atproto.space.getRepo?space=${encodeURIComponent(spUri)}&repo=${encodeURIComponent(groupDid)}`,
            { method: "GET", accessToken: tokA },
          )
        ).arrayBuffer(),
      );
      await fetch(`${ghB.url}/xrpc/com.atproto.space.importRepo`, {
        method: "POST",
        headers: { "content-type": "application/vnd.dasl.star", authorization: `Bearer ${stageRevRaceToks.accessJwt}` },
        body: repoStar,
      });
    }
    const carBytes = new Uint8Array(
      await (await fetch(`${ghA.url}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(groupDid)}`)).arrayBuffer(),
    );
    await fetch(`${ghB.url}/xrpc/com.atproto.repo.importRepo`, {
      method: "POST",
      headers: { "content-type": "application/vnd.ipld.car", authorization: `Bearer ${stageRevRaceToks.accessJwt}` },
      body: carBytes,
    });
    const recRevRace = (await (
      await fetch(`${ghB.url}/xrpc/com.atproto.identity.getRecommendedDidCredentials`, {
        headers: { authorization: `Bearer ${stageRevRaceToks.accessJwt}` },
      })
    ).json()) as Record<string, unknown>;
    await dpopA.fetchWithDpop(`${ghA.url}/xrpc/com.atproto.identity.requestPlcOperationSignature`, {
      method: "POST",
      accessToken: tokA,
    });
    const plcTokRevRace = (await (
      await dpopA.fetchWithDpop(`${ghA.url}/group-admin/claim-action-token`, {
        method: "POST",
        accessToken: tokA,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ group: groupDid, purpose: "plc_operation" }),
      })
    ).json()) as { token: string };
    const signRevRace = await dpopA.fetchWithDpop(`${ghA.url}/xrpc/com.atproto.identity.signPlcOperation`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: plcTokRevRace.token, ...recRevRace }),
    });
    assert.equal(signRevRace.status, 200);

    const plcOpsCountBeforeAbort = plc.opsByDid.get(groupDid)?.length ?? 0;
    const oauthSessionRow = ghA.db
      .prepare("SELECT client_id FROM oauth_session WHERE group_did = ?")
      .get(groupDid) as { client_id: string };

    let releaseAbortMidFlight!: () => void;
    const abortMidFlightGate = new Promise<void>((resolve) => {
      releaseAbortMidFlight = resolve;
    });
    let abortReachedTarget!: () => void;
    const abortAtTarget = new Promise<void>((resolve) => {
      abortReachedTarget = resolve;
    });

    srcOutboundHook = async (urlStr, _init, forward) => {
      if (urlStr.endsWith("/group-admin/abort-migration")) {
        abortReachedTarget();
        await abortMidFlightGate;
      }
      return forward();
    };

    const inFlightAbortPromise = dpopA.fetchWithDpop(`${ghA.url}/group-admin/abort-migration`, {
      method: "POST",
      accessToken: tokA,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ group: groupDid, operationId: "op-r9-revoke-race" }),
    });
    await abortAtTarget;

    let revokeSettledWhileAbortHeld = false;
    const concurrentRevokePromise = dpopA
      .fetchWithDpop(`${ghA.url}/oauth/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: oauthSessionRow.client_id,
          token: tokA,
        }).toString(),
      })
      .then((res) => {
        revokeSettledWhileAbortHeld = true;
        return res;
      });

    await new Promise((r) => setTimeout(r, 25));
    assert.equal(
      revokeSettledWhileAbortHeld,
      false,
      "/oauth/revoke must wait on withGroupRepoLock(groupDid) while abortMigrationOnSource is in flight",
    );

    releaseAbortMidFlight();
    const [finishedAbortRes, finishedRevokeRes] = await Promise.all([inFlightAbortPromise, concurrentRevokePromise]);
    srcOutboundHook = undefined;

    assert.equal(finishedAbortRes.status, 200, "In-flight source abort must commit cleanly without split state");
    assert.equal(((await finishedAbortRes.json()) as { status: string }).status, "aborted");
    assert.equal(finishedRevokeRes.status, 200);
    assert.equal(
      ghA.db.prepare("SELECT 1 FROM source_migration_lease WHERE group_did = ?").get(groupDid),
      undefined,
      "source_migration_lease must be deleted alongside target purge and PLC head advance",
    );
    assert.equal(ghB.db.prepare("SELECT 1 FROM migration_session WHERE group_did = ?").get(groupDid), undefined);
    assert.equal(
      plc.opsByDid.get(groupDid)?.length,
      plcOpsCountBeforeAbort + 1,
      "PLC head must have advanced once to invalidate the signed cutover op",
    );

    // Re-authenticate a fresh admin session on `ghA` after `tokA` was revoked
    const flowA2 = await completeGroupOAuthFlow({
      groupHost: ghA,
      pds,
      user: alice,
      scope: groupAdminScopes().join(" "),
      prompt: "login",
      loginHint: groupDid,
    });
    const dpopA2 = flowA2.dpop;
    const tokA2 = flowA2.tokenResponse!.access_token;

    // =========================================================================
    // 3. Finding #6: `/group-admin/public-group-keys` fails closed (`502 SourceHostUnavailable`)
    //    on 5xx / transport errors (ONLY `404`/`501` falls back to single-key!), AND delayed
    //    Standard reaper abort is 100% clock-free even when Source clock is +10m ahead of Target!
    // =========================================================================
    for (const pkFail of ["503", "network"] as const) {
      dstOutboundHook = async (urlStr, _init, forward) => {
        if (urlStr.includes("/group-admin/public-group-keys")) {
          if (pkFail === "503") {
            return new Response(JSON.stringify({ error: "ServiceUnavailable" }), {
              status: 503,
              headers: { "content-type": "application/json" },
            });
          }
          throw new Error("simulated public-group-keys timeout");
        }
        return forward();
      };
      const failCreateRes = await fetch(`${ghB.url}/xrpc/com.atproto.server.createAccount`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await makeCreateJwt()}`,
          "x-group-migration-operation-id": `op-r9-pk-${pkFail}`,
        },
        body: JSON.stringify({ did: groupDid, handle: "r9.r9b.groups.localhost" }),
      });
      assert.equal(failCreateRes.status, 502, `public-group-keys (${pkFail}) must fail closed with 502`);
      assert.equal(((await failCreateRes.json()) as { error: string }).error, "SourceHostUnavailable");
    }
    dstOutboundHook = undefined;

    // Skew Source's lease & reap timestamps +10 minutes (+600_000 ms) ahead of Target's wall clock!
    const skewedOpId = "op-r9-skewed-std";
    const prepSkew = await dpopA2.fetchWithDpop(`${ghA.url}/group-admin/prepare-migration`, {
      method: "POST",
      accessToken: tokA2,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        group: groupDid,
        operationId: skewedOpId,
        targetEndpoint: ghB.url,
        mode: "standard",
      }),
    });
    assert.equal(prepSkew.status, 200);

    let releaseSkewedReapAbort!: () => void;
    const skewedReapGate = new Promise<void>((resolve) => {
      releaseSkewedReapAbort = resolve;
    });
    let skewedReapSeen!: () => void;
    const skewedReapInFlight = new Promise<void>((resolve) => {
      skewedReapSeen = resolve;
    });
    let skewedReapResponse: Response | null = null;

    srcOutboundHook = async (urlStr, _init, forward) => {
      if (urlStr.endsWith("/group-admin/abort-migration")) {
        skewedReapSeen();
        await skewedReapGate;
        const res = await forward();
        skewedReapResponse = res.clone();
        return res;
      }
      return forward();
    };

    const skewedSourceNowMs = Date.now() + 10 * 60_000;
    ghA.db
      .prepare("UPDATE source_migration_lease SET expires_at = ? WHERE group_did = ?")
      .run(skewedSourceNowMs - 1_000, groupDid);
    const reapedRow = reapExpiredPreparedMigrationLease(ghA.db, groupDid, skewedSourceNowMs);
    assert.ok(reapedRow, "Source lease must reap at skewedSourceNowMs (+10m)");
    await skewedReapInFlight;

    // Even if Target stages `skewedOpId` via 404 single-key fallback at real wall clock (`created_at` 10 minutes
    // EARLIER than `skewedSourceNowMs`!), releasing the delayed reaper abort returns `superseded` (via clock-free
    // `leaseAttemptId` mismatch) and NEVER purges Target's newer staging session!
    dstOutboundHook = async (urlStr, _init, forward) => {
      if (urlStr.includes("/group-admin/public-group-keys")) {
        return new Response(JSON.stringify({ error: "NotFound" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      return forward();
    };
    const skewedStageRes = await fetch(`${ghB.url}/xrpc/com.atproto.server.createAccount`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await makeCreateJwt()}`,
        "x-group-migration-operation-id": skewedOpId,
      },
      body: JSON.stringify({ did: groupDid, handle: "r9.r9b.groups.localhost" }),
    });
    dstOutboundHook = undefined;
    assert.equal(skewedStageRes.status, 200);
    const skewedStageToks = (await skewedStageRes.json()) as { refreshJwt: string };

    const targetCreatedAt = (
      ghB.db.prepare("SELECT created_at FROM migration_session WHERE group_did = ?").get(groupDid) as {
        created_at: number;
      }
    ).created_at;
    assert.ok(
      targetCreatedAt < skewedSourceNowMs - 500_000,
      "Target created_at must be ~10 minutes behind Source reap timestamp to prove zero clock-skew vulnerability",
    );

    releaseSkewedReapAbort();
    await ghA.migration.flushPendingTargetAborts();
    srcOutboundHook = undefined;

    assert.ok(skewedReapResponse !== null);
    assert.equal((skewedReapResponse as Response).status, 200);
    assert.equal(
      ((await (skewedReapResponse as Response).json()) as { status: string }).status,
      "superseded",
      "Delayed Standard reaper abort must return superseded via clock-free leaseAttemptId even under +10m Source clock skew",
    );

    const refreshStillAlive = await fetch(`${ghB.url}/xrpc/com.atproto.server.refreshSession`, {
      method: "POST",
      headers: { authorization: `Bearer ${skewedStageToks.refreshJwt}` },
    });
    assert.equal(refreshStillAlive.status, 200, "Target staging session must survive +10m clock-skewed reaper abort");
  } finally {
    await ghB.close();
    await ghA.close();
    await pds.close();
    await plc.close();
  }
});

test("Round 11 hardening: submitPlcOperation crash after PLC commit + deadline expiry + PLC outage fail-safe + restart reconciles /log/last without purging keys and completes activation recovery", async () => {
  const plc = await startMockPlcServer();
  const pds = await startMockPersonalPds(plc);
  const tmpDir = mkdtempSync(join(tmpdir(), "gh-r11-crash-recovery-"));
  const targetDbPath = join(tmpDir, "target.sqlite");

  let targetDidHook:
    | ((url: string, init: RequestInit | undefined, forward: () => Promise<Response>) => Promise<Response>)
    | undefined;
  const wrappedTargetFetchImpl: typeof globalThis.fetch = async (input, init) => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const forward = () => fetch(input, init);
    if (targetDidHook) {
      return targetDidHook(urlStr, init, forward);
    }
    return forward();
  };

  const ghSource = await startTestGroupHost({ plc, handleDomain: "r11src.groups.localhost" });
  const ghTarget = await startTestGroupHost({
    plc,
    handleDomain: "r11dst.groups.localhost",
    overrides: {
      databasePath: targetDbPath,
      fetchImpl: wrappedTargetFetchImpl,
    },
  });
  let ghTargetRestarted: Awaited<ReturnType<typeof startTestGroupHost>> | null = null;

  try {
    const alice = await pds.registerUser("alice-r11.test");
    const adminScopeStr = groupAdminScopes().join(" ");

    // 1. Create group WITHOUT any external sovereign rotation key (sole custody rests on host rotation key!)
    const flowSrc = await createSteppedUpGroupFlow({
      groupHost: ghSource,
      pds,
      user: alice,
      prompt: "create",
      scope: adminScopeStr,
      createParams: {
        displayName: "R11 Crash Recovery Group",
        handle: "r11.r11src.groups.localhost",
        joinPolicy: "open",
        publicMeta: true,
      },
    });
    const groupDid = flowSrc.tokenResponse!.sub;
    const dpopSrc = flowSrc.dpop;
    const tokSrc = flowSrc.tokenResponse!.access_token;

    // Upload a blob referenced by group profile so we prove blobs survive crash + deadline expiry + restart too!
    const avatarBytes = new Uint8Array(randomBytes(8192));
    const upBlobSrc = await dpopSrc.fetchWithDpop(`${ghSource.url}/xrpc/com.atproto.repo.uploadBlob`, {
      method: "POST",
      accessToken: tokSrc,
      headers: { "content-type": "image/png" },
      body: avatarBytes,
    });
    assert.equal(upBlobSrc.status, 200);
    const { blob: avatarBlob } = (await upBlobSrc.json()) as { blob: { ref: { $link: string } } };

    const metaSpace = `at://${groupDid}/space/group.opensocial.meta/self`;
    const membersSpace = `at://${groupDid}/space/group.opensocial.members/self`;
    const putProfRes = await dpopSrc.fetchWithDpop(`${ghSource.url}/xrpc/com.atproto.space.putRecord`, {
      method: "POST",
      accessToken: tokSrc,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: metaSpace,
        repo: groupDid,
        collection: "group.opensocial.profile",
        rkey: "self",
        record: {
          $type: "group.opensocial.profile",
          displayName: "R11 Crash Recovery Group",
          joinPolicy: "open",
          avatar: avatarBlob,
          createdAt: new Date().toISOString(),
        },
      }),
    });
    assert.equal(putProfRes.status, 200);

    // 2. Prepare Standard-mode migration on `ghSource` -> `createAccount` on `ghTarget`
    const prepRes = await dpopSrc.fetchWithDpop(`${ghSource.url}/group-admin/prepare-migration`, {
      method: "POST",
      accessToken: tokSrc,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        group: groupDid,
        targetEndpoint: ghTarget.url,
        operationId: "op-r11-crash-cutover",
        mode: "standard",
      }),
    });
    assert.equal(prepRes.status, 200);
    const prepBody = (await prepRes.json()) as { targetServiceDid: string };

    const srcSigKey = await ghSource.repoStore.getGroupSigningKey(groupDid);
    const createJwt = await createServiceJwt({
      iss: groupDid,
      aud: prepBody.targetServiceDid,
      lxm: "com.atproto.server.createAccount",
      keypair: srcSigKey,
    });
    const stageRes = await fetch(`${ghTarget.url}/xrpc/com.atproto.server.createAccount`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${createJwt}`,
        "x-group-migration-operation-id": "op-r11-crash-cutover",
      },
      body: JSON.stringify({ did: groupDid, handle: "r11.r11dst.groups.localhost" }),
    });
    assert.equal(stageRes.status, 200);
    const stageToks = (await stageRes.json()) as { accessJwt: string; refreshJwt: string };

    // Stage public CAR + avatar blob + `meta/self` & `members/self` metadata and STAR archives on `ghTarget`
    const carBytes = new Uint8Array(
      await (await fetch(`${ghSource.url}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(groupDid)}`)).arrayBuffer(),
    );
    assert.equal(
      (
        await fetch(`${ghTarget.url}/xrpc/com.atproto.repo.importRepo`, {
          method: "POST",
          headers: {
            "content-type": "application/vnd.ipld.car",
            authorization: `Bearer ${stageToks.accessJwt}`,
          },
          body: carBytes,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(`${ghTarget.url}/xrpc/com.atproto.repo.uploadBlob`, {
          method: "POST",
          headers: {
            "content-type": "image/png",
            authorization: `Bearer ${stageToks.accessJwt}`,
          },
          body: avatarBytes,
        })
      ).status,
      200,
    );

    for (const spUri of [metaSpace, membersSpace]) {
      const metaBytes = new Uint8Array(
        await (
          await dpopSrc.fetchWithDpop(
            `${ghSource.url}/xrpc/com.atproto.space.exportSpaceMeta?space=${encodeURIComponent(spUri)}`,
            { method: "GET", accessToken: tokSrc },
          )
        ).arrayBuffer(),
      );
      assert.equal(
        (
          await fetch(`${ghTarget.url}/xrpc/com.atproto.space.importSpaceMeta`, {
            method: "POST",
            headers: {
              "content-type": "application/vnd.dasl.star",
              authorization: `Bearer ${stageToks.accessJwt}`,
            },
            body: metaBytes,
          })
        ).status,
        200,
      );
      const starBytes = new Uint8Array(
        await (
          await dpopSrc.fetchWithDpop(
            `${ghSource.url}/xrpc/com.atproto.space.getRepo?space=${encodeURIComponent(spUri)}&repo=${encodeURIComponent(groupDid)}`,
            { method: "GET", accessToken: tokSrc },
          )
        ).arrayBuffer(),
      );
      assert.equal(
        (
          await fetch(`${ghTarget.url}/xrpc/com.atproto.space.importRepo`, {
            method: "POST",
            headers: {
              "content-type": "application/vnd.dasl.star",
              authorization: `Bearer ${stageToks.accessJwt}`,
            },
            body: starBytes,
          })
        ).status,
        200,
      );
    }

    // Sign cutover PLC operation on `ghSource`
    const recCreds = (await (
      await fetch(`${ghTarget.url}/xrpc/com.atproto.identity.getRecommendedDidCredentials`, {
        headers: { authorization: `Bearer ${stageToks.accessJwt}` },
      })
    ).json()) as Record<string, unknown>;
    assert.equal(
      (
        await dpopSrc.fetchWithDpop(`${ghSource.url}/xrpc/com.atproto.identity.requestPlcOperationSignature`, {
          method: "POST",
          accessToken: tokSrc,
        })
      ).status,
      200,
    );
    const { token: plcTok } = (await (
      await dpopSrc.fetchWithDpop(`${ghSource.url}/group-admin/claim-action-token`, {
        method: "POST",
        accessToken: tokSrc,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ group: groupDid, purpose: "plc_operation" }),
      })
    ).json()) as { token: string };
    const { operation: signedCutoverOp } = (await (
      await dpopSrc.fetchWithDpop(`${ghSource.url}/xrpc/com.atproto.identity.signPlcOperation`, {
        method: "POST",
        accessToken: tokSrc,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: plcTok, ...recCreds }),
      })
    ).json()) as { operation: Record<string, unknown> };

    // 3. FAILPOINT: `POST /:did` to PLC commits `200 OK` on PLC directory, then crashes/drops BEFORE
    //    `submitPlcOperation` writes `migration_session.plc_cutover_at`!
    let plcAcceptedBeforeCrash = false;
    targetDidHook = async (urlStr, init, forward) => {
      if ((init?.method ?? "GET").toUpperCase() === "POST" && urlStr.startsWith(plc.url)) {
        const realPlcRes = await forward();
        assert.equal(realPlcRes.status, 200, "PLC directory must accept cutover op before simulated crash");
        plcAcceptedBeforeCrash = true;
        throw new Error("Simulated crash immediately after PLC accepted cutover op");
      }
      return forward();
    };

    const crashedSubRes = await fetch(`${ghTarget.url}/xrpc/com.atproto.identity.submitPlcOperation`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${stageToks.accessJwt}`,
      },
      body: JSON.stringify({ operation: signedCutoverOp }),
    });
    assert.equal(plcAcceptedBeforeCrash, true);
    assert.equal(crashedSubRes.status, 502, "Crash/network error after PLC POST must return 502 PlcDirectoryError");
    targetDidHook = undefined;

    // Verify durable pre-I/O state on disk: `plc_cutover_at` is STILL NULL while `plc_submitting_at` and `pending_plc_op_cid` are persisted!
    const crashRow = ghTarget.db
      .prepare(
        "SELECT plc_cutover_at, plc_submitting_at, pending_plc_op_cid, pending_plc_op_json FROM migration_session WHERE group_did = ?",
      )
      .get(groupDid) as {
      plc_cutover_at: number | null;
      plc_submitting_at: number | null;
      pending_plc_op_cid: string | null;
      pending_plc_op_json: string | null;
    };
    assert.equal(crashRow.plc_cutover_at, null, "plc_cutover_at must still be NULL right after crash");
    assert.notEqual(crashRow.plc_submitting_at, null, "plc_submitting_at must be durably recorded before PLC I/O");
    assert.ok(crashRow.pending_plc_op_cid && crashRow.pending_plc_op_json, "pending_plc_op_cid/json must be persisted");

    // 4. Expire `absolute_deadline_at`!
    ghTarget.db
      .prepare("UPDATE migration_session SET absolute_deadline_at = ? WHERE group_did = ?")
      .run(Date.now() - 30_000, groupDid);

    // 5. FAIL-SAFE UNDER PLC OUTAGE: while PLC `/log/last` & DID doc return `503`, `flushBackgroundWork`
    //    MUST NOT purge `group_account`, staged spaces, blobs, or `migration_session`!
    targetDidHook = async (urlStr, _init, forward) => {
      if (urlStr.startsWith(plc.url)) {
        return new Response("PLC temporarily unavailable", { status: 503 });
      }
      return forward();
    };
    await ghTarget.flushBackgroundWork();
    assert.ok(
      ghTarget.db.prepare("SELECT 1 FROM group_account WHERE did = ?").get(groupDid),
      "Target group_account (holding sole live PLC rotation key!) MUST survive maintenance sweep during PLC outage",
    );
    assert.ok(
      ghTarget.db.prepare("SELECT 1 FROM migration_session WHERE group_did = ?").get(groupDid),
      "Expired null-marker migration_session MUST fail safe and survive during PLC outage",
    );
    assert.equal(
      ghTarget.db
        .prepare("SELECT 1 FROM service_jwt_jti WHERE issuer_did = ? AND jti = 'aborted-op:op-r11-crash-cutover'")
        .get(groupDid),
      undefined,
      "Operation ID must NOT be tombstoned when PLC is unreachable",
    );

    // 6. FULL TARGET RESTART on the exact same port, publicUrl, and SQLite database with PLC reachable again!
    const targetPort = ghTarget.port;
    const targetPublicUrl = ghTarget.url;
    await ghTarget.close();
    targetDidHook = undefined;

    ghTargetRestarted = await startTestGroupHost({
      plc,
      handleDomain: "r11dst.groups.localhost",
      overrides: {
        port: targetPort,
        publicUrl: targetPublicUrl,
        databasePath: targetDbPath,
        fetchImpl: wrappedTargetFetchImpl,
      },
    });

    // Startup sweep MUST have reconciled `/log/last` under `withGroupRepoLock`, stamped `plc_cutover_at`, and retained all staged data!
    const reconciledRow = ghTargetRestarted.db
      .prepare("SELECT plc_cutover_at, plc_submitting_at FROM migration_session WHERE group_did = ?")
      .get(groupDid) as { plc_cutover_at: number | null; plc_submitting_at: number | null } | undefined;
    assert.ok(reconciledRow, "migration_session must be retained across restart after live PLC cutover reconciliation");
    assert.notEqual(reconciledRow.plc_cutover_at, null, "Startup PLC reconciliation must stamp plc_cutover_at");
    assert.equal(reconciledRow.plc_submitting_at, null, "plc_submitting_at must be cleared once plc_cutover_at is stamped");

    // 7. POST-DEADLINE ACTIVATION RECOVERY using the pre-crash `refreshJwt`!
    const refreshAfterRestart = await fetch(`${ghTargetRestarted.url}/xrpc/com.atproto.server.refreshSession`, {
      method: "POST",
      headers: { authorization: `Bearer ${stageToks.refreshJwt}` },
    });
    assert.equal(
      refreshAfterRestart.status,
      200,
      `Post-deadline refreshSession after reconciled PLC cutover must 200: ${await refreshAfterRestart.clone().text()}`,
    );
    const postRecoveryToks = (await refreshAfterRestart.json()) as { accessJwt: string };

    // Idempotent `submitPlcOperation` retry returns `200 OK`
    const retrySubRes = await fetch(`${ghTargetRestarted.url}/xrpc/com.atproto.identity.submitPlcOperation`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${postRecoveryToks.accessJwt}`,
      },
      body: JSON.stringify({ operation: signedCutoverOp }),
    });
    assert.equal(retrySubRes.status, 200);

    // `activateAccount` succeeds (`200 OK`) with all staged spaces, profile, and avatar blob intact!
    const actRes = await fetch(`${ghTargetRestarted.url}/xrpc/com.atproto.server.activateAccount`, {
      method: "POST",
      headers: { authorization: `Bearer ${postRecoveryToks.accessJwt}` },
    });
    assert.equal(actRes.status, 200, `Post-recovery activateAccount failed: ${await actRes.clone().text()}`);

    await ghTargetRestarted.flushBackgroundWork();
    const targetAcct = ghTargetRestarted.db
      .prepare("SELECT activated FROM group_account WHERE did = ?")
      .get(groupDid) as { activated: number };
    assert.equal(targetAcct.activated, 1, "Target group_account must be activated after recovery");
    const srcAcct = ghSource.db
      .prepare("SELECT activated FROM group_account WHERE did = ?")
      .get(groupDid) as { activated: number };
    assert.equal(srcAcct.activated, 0, "Source group_account must be automatically finalized to activated=0");

    // Verify full OAuth login on restarted & activated Target succeeds!
    const postMigLogin = await completeGroupOAuthFlow({
      groupHost: ghTargetRestarted,
      pds,
      user: alice,
      scope: adminScopeStr,
      loginHint: groupDid,
    });
    assert.equal(postMigLogin.tokenResponse?.sub, groupDid);
  } finally {
    if (ghTargetRestarted) {
      await ghTargetRestarted.close();
    }
    await ghTarget.close().catch(() => undefined);
    await ghSource.close();
    await pds.close();
    await plc.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Round 12 hardening (1a): delayed in-flight PLC commit (live head === pendingOp.prev) survives expired sweep without clearing pending state or purging keys, then reconciles on commit; Source head-advance abort clears pending state cleanly", async () => {
  const plc = await startMockPlcServer();
  const pds = await startMockPersonalPds(plc);

  let targetDidHook:
    | ((url: string, init: RequestInit | undefined, forward: () => Promise<Response>) => Promise<Response>)
    | undefined;
  const wrappedTargetFetchImpl: typeof globalThis.fetch = async (input, init) => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const forward = () => fetch(input, init);
    if (targetDidHook) {
      return targetDidHook(urlStr, init, forward);
    }
    return forward();
  };

  const ghSource = await startTestGroupHost({ plc, handleDomain: "r12asrc.groups.localhost" });
  const ghTarget = await startTestGroupHost({
    plc,
    handleDomain: "r12adst.groups.localhost",
    overrides: { fetchImpl: wrappedTargetFetchImpl },
  });

  try {
    const alice = await pds.registerUser("alice-r12a.test");
    const adminScopeStr = groupAdminScopes().join(" ");

    const stageGroupToPlcSigned = async (suffix: string) => {
      const flowSrc = await createSteppedUpGroupFlow({
        groupHost: ghSource,
        pds,
        user: alice,
        prompt: "create",
        scope: adminScopeStr,
        createParams: {
          displayName: `R12 Delayed Cutover ${suffix}`,
          handle: `${suffix}.r12asrc.groups.localhost`,
          joinPolicy: "open",
          publicMeta: true,
        },
      });
      const groupDid = flowSrc.tokenResponse!.sub;
      const dpopSrc = flowSrc.dpop;
      const tokSrc = flowSrc.tokenResponse!.access_token;

      const prepRes = await dpopSrc.fetchWithDpop(`${ghSource.url}/group-admin/prepare-migration`, {
        method: "POST",
        accessToken: tokSrc,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          group: groupDid,
          targetEndpoint: ghTarget.url,
          operationId: `op-r12a-${suffix}`,
          mode: "standard",
        }),
      });
      assert.equal(prepRes.status, 200);
      const prepBody = (await prepRes.json()) as { targetServiceDid: string };

      const srcSigKey = await ghSource.repoStore.getGroupSigningKey(groupDid);
      const createJwt = await createServiceJwt({
        iss: groupDid,
        aud: prepBody.targetServiceDid,
        lxm: "com.atproto.server.createAccount",
        keypair: srcSigKey,
      });
      const stageRes = await fetch(`${ghTarget.url}/xrpc/com.atproto.server.createAccount`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${createJwt}`,
          "x-group-migration-operation-id": `op-r12a-${suffix}`,
        },
        body: JSON.stringify({ did: groupDid, handle: `${suffix}.r12adst.groups.localhost` }),
      });
      assert.equal(stageRes.status, 200);
      const stageToks = (await stageRes.json()) as { accessJwt: string; refreshJwt: string };

      const carBytes = new Uint8Array(
        await (await fetch(`${ghSource.url}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(groupDid)}`)).arrayBuffer(),
      );
      assert.equal(
        (
          await fetch(`${ghTarget.url}/xrpc/com.atproto.repo.importRepo`, {
            method: "POST",
            headers: { "content-type": "application/vnd.ipld.car", authorization: `Bearer ${stageToks.accessJwt}` },
            body: carBytes,
          })
        ).status,
        200,
      );

      for (const spUri of [
        `at://${groupDid}/space/group.opensocial.meta/self`,
        `at://${groupDid}/space/group.opensocial.members/self`,
      ]) {
        const metaBytes = new Uint8Array(
          await (
            await dpopSrc.fetchWithDpop(
              `${ghSource.url}/xrpc/com.atproto.space.exportSpaceMeta?space=${encodeURIComponent(spUri)}`,
              { method: "GET", accessToken: tokSrc },
            )
          ).arrayBuffer(),
        );
        assert.equal(
          (
            await fetch(`${ghTarget.url}/xrpc/com.atproto.space.importSpaceMeta`, {
              method: "POST",
              headers: { "content-type": "application/vnd.dasl.star", authorization: `Bearer ${stageToks.accessJwt}` },
              body: metaBytes,
            })
          ).status,
          200,
        );
        const starBytes = new Uint8Array(
          await (
            await dpopSrc.fetchWithDpop(
              `${ghSource.url}/xrpc/com.atproto.space.getRepo?space=${encodeURIComponent(spUri)}&repo=${encodeURIComponent(groupDid)}`,
              { method: "GET", accessToken: tokSrc },
            )
          ).arrayBuffer(),
        );
        assert.equal(
          (
            await fetch(`${ghTarget.url}/xrpc/com.atproto.space.importRepo`, {
              method: "POST",
              headers: { "content-type": "application/vnd.dasl.star", authorization: `Bearer ${stageToks.accessJwt}` },
              body: starBytes,
            })
          ).status,
          200,
        );
      }

      const recCreds = (await (
        await fetch(`${ghTarget.url}/xrpc/com.atproto.identity.getRecommendedDidCredentials`, {
          headers: { authorization: `Bearer ${stageToks.accessJwt}` },
        })
      ).json()) as Record<string, unknown>;
      await dpopSrc.fetchWithDpop(`${ghSource.url}/xrpc/com.atproto.identity.requestPlcOperationSignature`, {
        method: "POST",
        accessToken: tokSrc,
      });
      const { token: plcTok } = (await (
        await dpopSrc.fetchWithDpop(`${ghSource.url}/group-admin/claim-action-token`, {
          method: "POST",
          accessToken: tokSrc,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ group: groupDid, purpose: "plc_operation" }),
        })
      ).json()) as { token: string };
      const { operation: signedCutoverOp } = (await (
        await dpopSrc.fetchWithDpop(`${ghSource.url}/xrpc/com.atproto.identity.signPlcOperation`, {
          method: "POST",
          accessToken: tokSrc,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: plcTok, ...recCreds }),
        })
      ).json()) as { operation: Record<string, unknown> };

      return { groupDid, dpopSrc, tokSrc, stageToks, signedCutoverOp, targetServiceDid: prepBody.targetServiceDid };
    };

    // --- Schedule A: Delayed PLC commit (`POST /:did` times out BEFORE PLC commits; live `/log/last` head STILL === `signedCutoverOp.prev`) ---
    const grpA = await stageGroupToPlcSigned("delayed");
    let interceptedBeforePlcCommit = false;
    targetDidHook = async (urlStr, init, forward) => {
      if ((init?.method ?? "GET").toUpperCase() === "POST" && urlStr.startsWith(plc.url)) {
        // DO NOT call `forward()` yet: simulate an in-flight/delayed PLC request whose HTTP client timed out before PLC committed!
        interceptedBeforePlcCommit = true;
        throw new Error("Simulated HTTP timeout while PLC submission is still queued upstream");
      }
      return forward();
    };

    const subTimeoutRes = await fetch(`${ghTarget.url}/xrpc/com.atproto.identity.submitPlcOperation`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${grpA.stageToks.accessJwt}`,
      },
      body: JSON.stringify({ operation: grpA.signedCutoverOp }),
    });
    assert.equal(interceptedBeforePlcCommit, true);
    assert.equal(subTimeoutRes.status, 502);
    targetDidHook = undefined;

    // Expire `absolute_deadline_at` and run maintenance sweep WHILE PLC is 100% reachable and `/log/last` STILL equals `signedCutoverOp.prev`!
    ghTarget.db
      .prepare("UPDATE migration_session SET absolute_deadline_at = ? WHERE group_did = ?")
      .run(Date.now() - 60_000, grpA.groupDid);
    await ghTarget.flushBackgroundWork();

    const afterSweepPreCommit = ghTarget.db
      .prepare(
        "SELECT plc_cutover_at, plc_submitting_at, pending_plc_op_cid, pending_plc_op_json FROM migration_session WHERE group_did = ?",
      )
      .get(grpA.groupDid) as
      | {
          plc_cutover_at: number | null;
          plc_submitting_at: number | null;
          pending_plc_op_cid: string | null;
          pending_plc_op_json: string | null;
        }
      | undefined;
    assert.ok(afterSweepPreCommit, "migration_session MUST survive expired sweep while live PLC head still equals pendingOp.prev");
    assert.equal(afterSweepPreCommit.plc_cutover_at, null);
    assert.notEqual(
      afterSweepPreCommit.plc_submitting_at,
      null,
      "plc_submitting_at MUST remain authoritative while live PLC head === pendingOp.prev",
    );
    assert.ok(
      afterSweepPreCommit.pending_plc_op_cid && afterSweepPreCommit.pending_plc_op_json,
      "pending_plc_op_cid/json MUST NOT be cleared while pendingOp remains admissible",
    );
    assert.ok(
      ghTarget.db.prepare("SELECT 1 FROM group_account WHERE did = ?").get(grpA.groupDid),
      "Target group_account & custody keys MUST NOT be purged before delayed PLC commit lands",
    );

    // Direct Target abort while `pendingOp.prev` is still live head MUST be refused (`409 MigrationCutoverCommitted`)
    const prematureAbortRes = await fetch(`${ghTarget.url}/group-admin/abort-migration`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${grpA.stageToks.accessJwt}`,
      },
      body: JSON.stringify({ group: grpA.groupDid, operationId: "op-r12a-delayed" }),
    });
    // `accessJwt` expired with `absolute_deadline_at` (`401`), or signed service JWT from Source before head advance gets `409`:
    const prematureSrcJwt = await ghSource.repoStore.signGroupServiceJwt({
      groupDid: grpA.groupDid,
      aud: grpA.targetServiceDid,
      lxm: "group.opensocial.abortMigration",
    });
    const prematureSvcAbortRes = await fetch(`${ghTarget.url}/group-admin/abort-migration`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${prematureSrcJwt}`,
      },
      body: JSON.stringify({ group: grpA.groupDid, operationId: "op-r12a-delayed" }),
    });
    assert.equal(prematureAbortRes.status, 401);
    assert.equal(
      prematureSvcAbortRes.status,
      409,
      `Target abort before Source advances PLC head must 409: ${await prematureSvcAbortRes.clone().text()}`,
    );

    // Now the delayed PLC cutover operation finally commits on PLC!
    const delayedPlcRes = await fetch(`${plc.url}/${encodeURIComponent(grpA.groupDid)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(grpA.signedCutoverOp),
    });
    assert.equal(delayedPlcRes.status, 200);

    // Next Target sweep reconciles `/log/last`, stamps `plc_cutover_at`, and clears pending markers -> `refreshSession` + `activateAccount` succeed!
    await ghTarget.flushBackgroundWork();
    const afterDelayedCommit = ghTarget.db
      .prepare("SELECT plc_cutover_at, plc_submitting_at, pending_plc_op_cid FROM migration_session WHERE group_did = ?")
      .get(grpA.groupDid) as {
      plc_cutover_at: number | null;
      plc_submitting_at: number | null;
      pending_plc_op_cid: string | null;
    };
    assert.notEqual(afterDelayedCommit.plc_cutover_at, null);
    assert.equal(afterDelayedCommit.plc_submitting_at, null);
    assert.equal(afterDelayedCommit.pending_plc_op_cid, null);

    const recRefreshRes = await fetch(`${ghTarget.url}/xrpc/com.atproto.server.refreshSession`, {
      method: "POST",
      headers: { authorization: `Bearer ${grpA.stageToks.refreshJwt}` },
    });
    assert.equal(recRefreshRes.status, 200);
    const { accessJwt: recAccessJwt } = (await recRefreshRes.json()) as { accessJwt: string };
    const recActRes = await fetch(`${ghTarget.url}/xrpc/com.atproto.server.activateAccount`, {
      method: "POST",
      headers: { authorization: `Bearer ${recAccessJwt}` },
    });
    assert.equal(recActRes.status, 200);

    // --- Schedule B: Source `abort-migration` advances `/log/last` past `pendingOp.prev`, allowing Target to clear pending state & purge cleanly ---
    const grpB = await stageGroupToPlcSigned("aborted");
    targetDidHook = async (urlStr, init, forward) => {
      if ((init?.method ?? "GET").toUpperCase() === "POST" && urlStr.startsWith(plc.url)) {
        throw new Error("Dropped before PLC received request");
      }
      return forward();
    };
    const droppedSubRes = await fetch(`${ghTarget.url}/xrpc/com.atproto.identity.submitPlcOperation`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${grpB.stageToks.accessJwt}`,
      },
      body: JSON.stringify({ operation: grpB.signedCutoverOp }),
    });
    assert.equal(droppedSubRes.status, 502);
    targetDidHook = undefined;

    // Source `abort-migration` submits a no-op PLC head-advance op (invalidating `grpB.signedCutoverOp.prev`!) and aborts Target!
    const srcAbortRes = await grpB.dpopSrc.fetchWithDpop(`${ghSource.url}/group-admin/abort-migration`, {
      method: "POST",
      accessToken: grpB.tokSrc,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ group: grpB.groupDid, operationId: "op-r12a-aborted" }),
    });
    assert.equal(srcAbortRes.status, 200, `Source head-advance abort must succeed: ${await srcAbortRes.clone().text()}`);
    assert.equal(
      ghTarget.db.prepare("SELECT 1 FROM group_account WHERE did = ?").get(grpB.groupDid),
      undefined,
      "Target staging must be purged once Source advances PLC head past pendingOp.prev",
    );
  } finally {
    await ghTarget.close();
    await ghSource.close();
    await pds.close();
    await plc.close();
  }
});

test("Round 12 hardening (1b): markerless direct PLC cutover + PLC 503 outage + revoked/stale token replays honor retain_fail_safe without purging Target", async () => {
  const plc = await startMockPlcServer();
  const pds = await startMockPersonalPds(plc);

  let plcOutage = false;
  const wrappedTargetFetchImpl: typeof globalThis.fetch = async (input, init) => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (plcOutage && urlStr.startsWith(plc.url)) {
      return new Response("PLC temporarily unavailable", { status: 503 });
    }
    return fetch(input, init);
  };

  const ghSource = await startTestGroupHost({ plc, handleDomain: "r12bsrc.groups.localhost" });
  const ghTarget = await startTestGroupHost({
    plc,
    handleDomain: "r12bdst.groups.localhost",
    overrides: { fetchImpl: wrappedTargetFetchImpl },
  });

  try {
    const alice = await pds.registerUser("alice-r12b.test");
    const adminScopeStr = groupAdminScopes().join(" ");

    const flowSrc = await createSteppedUpGroupFlow({
      groupHost: ghSource,
      pds,
      user: alice,
      prompt: "create",
      scope: adminScopeStr,
      createParams: {
        displayName: "R12 Direct Cutover Group",
        handle: "direct.r12bsrc.groups.localhost",
        joinPolicy: "open",
        publicMeta: true,
      },
    });
    const groupDid = flowSrc.tokenResponse!.sub;
    const dpopSrc = flowSrc.dpop;
    const tokSrc = flowSrc.tokenResponse!.access_token;

    const prepRes = await dpopSrc.fetchWithDpop(`${ghSource.url}/group-admin/prepare-migration`, {
      method: "POST",
      accessToken: tokSrc,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        group: groupDid,
        targetEndpoint: ghTarget.url,
        operationId: "op-r12b-direct",
        mode: "standard",
      }),
    });
    assert.equal(prepRes.status, 200);
    const prepBody = (await prepRes.json()) as { targetServiceDid: string };

    const srcSigKey = await ghSource.repoStore.getGroupSigningKey(groupDid);
    const createJwt = await createServiceJwt({
      iss: groupDid,
      aud: prepBody.targetServiceDid,
      lxm: "com.atproto.server.createAccount",
      keypair: srcSigKey,
    });
    const stageRes = await fetch(`${ghTarget.url}/xrpc/com.atproto.server.createAccount`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${createJwt}`,
        "x-group-migration-operation-id": "op-r12b-direct",
      },
      body: JSON.stringify({ did: groupDid, handle: "direct.r12bdst.groups.localhost" }),
    });
    assert.equal(stageRes.status, 200);
    const initialToks = (await stageRes.json()) as { accessJwt: string; refreshJwt: string };

    // Rotate once via `refreshSession` BEFORE cutover so `initialToks` JTIs are recorded in `revoked_migration_jti`!
    const rotRes = await fetch(`${ghTarget.url}/xrpc/com.atproto.server.refreshSession`, {
      method: "POST",
      headers: { authorization: `Bearer ${initialToks.refreshJwt}` },
    });
    assert.equal(rotRes.status, 200);
    const rotatedToks = (await rotRes.json()) as { accessJwt: string; refreshJwt: string };

    // Stage public CAR + `meta/self` & `members/self` on `ghTarget`
    const carBytes = new Uint8Array(
      await (await fetch(`${ghSource.url}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(groupDid)}`)).arrayBuffer(),
    );
    assert.equal(
      (
        await fetch(`${ghTarget.url}/xrpc/com.atproto.repo.importRepo`, {
          method: "POST",
          headers: { "content-type": "application/vnd.ipld.car", authorization: `Bearer ${rotatedToks.accessJwt}` },
          body: carBytes,
        })
      ).status,
      200,
    );
    for (const spUri of [
      `at://${groupDid}/space/group.opensocial.meta/self`,
      `at://${groupDid}/space/group.opensocial.members/self`,
    ]) {
      const metaBytes = new Uint8Array(
        await (
          await dpopSrc.fetchWithDpop(
            `${ghSource.url}/xrpc/com.atproto.space.exportSpaceMeta?space=${encodeURIComponent(spUri)}`,
            { method: "GET", accessToken: tokSrc },
          )
        ).arrayBuffer(),
      );
      assert.equal(
        (
          await fetch(`${ghTarget.url}/xrpc/com.atproto.space.importSpaceMeta`, {
            method: "POST",
            headers: { "content-type": "application/vnd.dasl.star", authorization: `Bearer ${rotatedToks.accessJwt}` },
            body: metaBytes,
          })
        ).status,
        200,
      );
      const starBytes = new Uint8Array(
        await (
          await dpopSrc.fetchWithDpop(
            `${ghSource.url}/xrpc/com.atproto.space.getRepo?space=${encodeURIComponent(spUri)}&repo=${encodeURIComponent(groupDid)}`,
            { method: "GET", accessToken: tokSrc },
          )
        ).arrayBuffer(),
      );
      assert.equal(
        (
          await fetch(`${ghTarget.url}/xrpc/com.atproto.space.importRepo`, {
            method: "POST",
            headers: { "content-type": "application/vnd.dasl.star", authorization: `Bearer ${rotatedToks.accessJwt}` },
            body: starBytes,
          })
        ).status,
        200,
      );
    }

    const recCreds = (await (
      await fetch(`${ghTarget.url}/xrpc/com.atproto.identity.getRecommendedDidCredentials`, {
        headers: { authorization: `Bearer ${rotatedToks.accessJwt}` },
      })
    ).json()) as Record<string, unknown>;
    await dpopSrc.fetchWithDpop(`${ghSource.url}/xrpc/com.atproto.identity.requestPlcOperationSignature`, {
      method: "POST",
      accessToken: tokSrc,
    });
    const { token: plcTok } = (await (
      await dpopSrc.fetchWithDpop(`${ghSource.url}/group-admin/claim-action-token`, {
        method: "POST",
        accessToken: tokSrc,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ group: groupDid, purpose: "plc_operation" }),
      })
    ).json()) as { token: string };
    const { operation: signedCutoverOp } = (await (
      await dpopSrc.fetchWithDpop(`${ghSource.url}/xrpc/com.atproto.identity.signPlcOperation`, {
        method: "POST",
        accessToken: tokSrc,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: plcTok, ...recCreds }),
      })
    ).json()) as { operation: Record<string, unknown> };

    // MARKERLESS DIRECT PLC CUTOVER: submit directly to `plc.url`, bypassing Target `submitPlcOperation`!
    const directPlcRes = await fetch(`${plc.url}/${encodeURIComponent(groupDid)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(signedCutoverOp),
    });
    assert.equal(directPlcRes.status, 200);

    const markerlessRow = ghTarget.db
      .prepare("SELECT plc_cutover_at, plc_submitting_at, pending_plc_op_cid FROM migration_session WHERE group_did = ?")
      .get(groupDid) as {
      plc_cutover_at: number | null;
      plc_submitting_at: number | null;
      pending_plc_op_cid: string | null;
    };
    assert.equal(markerlessRow.plc_cutover_at, null);
    assert.equal(markerlessRow.plc_submitting_at, null);
    assert.equal(markerlessRow.pending_plc_op_cid, null);

    // Inject PLC `503` outage and replay BOTH revoked `accessJwt` AND revoked `refreshJwt` AND stale `refresh_jti`!
    plcOutage = true;

    const replayAccessRes = await fetch(`${ghTarget.url}/xrpc/com.atproto.server.activateAccount`, {
      method: "POST",
      headers: { authorization: `Bearer ${initialToks.accessJwt}` },
    });
    assert.equal(replayAccessRes.status, 401);

    const replayRefreshRes = await fetch(`${ghTarget.url}/xrpc/com.atproto.server.refreshSession`, {
      method: "POST",
      headers: { authorization: `Bearer ${initialToks.refreshJwt}` },
    });
    assert.equal(replayRefreshRes.status, 401);

    // Also test the `sess.refresh_jti !== presented.jti` branch (when `revoked_migration_jti` row has already aged out)!
    ghTarget.db.prepare("DELETE FROM revoked_migration_jti").run();
    const mismatchRefreshRes = await fetch(`${ghTarget.url}/xrpc/com.atproto.server.refreshSession`, {
      method: "POST",
      headers: { authorization: `Bearer ${initialToks.refreshJwt}` },
    });
    assert.equal(mismatchRefreshRes.status, 401);

    // Target MUST NOT have purged `group_account`, custody keys, or `migration_session` during PLC outage!
    assert.ok(
      ghTarget.db.prepare("SELECT 1 FROM group_account WHERE did = ?").get(groupDid),
      "Markerless direct-cutover group_account MUST survive revoked/stale token replays during PLC outage",
    );
    assert.ok(
      ghTarget.db.prepare("SELECT 1 FROM migration_session WHERE group_did = ?").get(groupDid),
      "Markerless direct-cutover migration_session MUST survive revoked/stale token replays during PLC outage",
    );
    assert.equal(
      ghTarget.db.prepare("SELECT 1 FROM service_jwt_jti WHERE issuer_did = ? AND jti = 'aborted-op:op-r12b-direct'").get(groupDid),
      undefined,
    );

    // Restore PLC -> valid `rotatedToks.refreshJwt` + `activateAccount` succeeds!
    plcOutage = false;
    const okRefreshRes = await fetch(`${ghTarget.url}/xrpc/com.atproto.server.refreshSession`, {
      method: "POST",
      headers: { authorization: `Bearer ${rotatedToks.refreshJwt}` },
    });
    assert.equal(okRefreshRes.status, 200);
    const { accessJwt: finalAccessJwt } = (await okRefreshRes.json()) as { accessJwt: string };
    const finalActRes = await fetch(`${ghTarget.url}/xrpc/com.atproto.server.activateAccount`, {
      method: "POST",
      headers: { authorization: `Bearer ${finalAccessJwt}` },
    });
    assert.equal(finalActRes.status, 200);
    const activatedRow = ghTarget.db
      .prepare("SELECT activated FROM group_account WHERE did = ?")
      .get(groupDid) as { activated: number };
    assert.equal(activatedRow.activated, 1);
  } finally {
    await ghTarget.close();
    await ghSource.close();
    await pds.close();
    await plc.close();
  }
});

test("Round 13 Fix #2: sweepExpiredMigrationSessions paginates past >50 and >500 retained sessions without starving later expired sessions", async () => {
  const plc = await startMockPlcServer();
  const pds = await startMockPersonalPds(plc);
  const ghSource = await startTestGroupHost({ plc, handleDomain: "src-r13.localhost" });
  const ghTarget = await startTestGroupHost({ plc, handleDomain: "dst-r13.localhost" });

  try {
    const alice = await pds.registerUser("alice.test");
    const adminScopeStr = groupAdminScopes().join(" ");
    const prepareCoordinatedMigration = async (handle: string, operationId: string) => {
      const flowSrc = await createSteppedUpGroupFlow({
        groupHost: ghSource,
        pds,
        user: alice,
        prompt: "create",
        scope: adminScopeStr,
        createParams: {
          displayName: `R13 Sweep ${handle}`,
          handle,
          joinPolicy: "open",
          publicMeta: true,
        },
      });
      const groupDid = flowSrc.tokenResponse!.sub;
      const prepRes = await flowSrc.dpop.fetchWithDpop(`${ghSource.url}/group-admin/prepare-migration`, {
        method: "POST",
        accessToken: flowSrc.tokenResponse!.access_token,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          group: groupDid,
          targetEndpoint: ghTarget.url,
          operationId,
          mode: "standard",
        }),
      });
      assert.equal(prepRes.status, 200);
      const prepBody = (await prepRes.json()) as { targetServiceDid: string };
      return { groupDid, operationId, prepBody };
    };

    const grpA = await prepareCoordinatedMigration("r13-tail-a.src-r13.localhost", "op-r13-tail-a");
    const grpB = await prepareCoordinatedMigration("r13-tail-b.src-r13.localhost", "op-r13-tail-b");

    const createStagingSession = async (
      grp: Awaited<ReturnType<typeof prepareCoordinatedMigration>>,
      targetHandle: string,
      forcedSessionId: string,
    ) => {
      const srcSigKey = await ghSource.repoStore.getGroupSigningKey(grp.groupDid);
      const createJwt = await createServiceJwt({
        iss: grp.groupDid,
        aud: grp.prepBody.targetServiceDid,
        lxm: "com.atproto.server.createAccount",
        keypair: srcSigKey,
      });
      const caRes = await fetch(`${ghTarget.url}/xrpc/com.atproto.server.createAccount`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${createJwt}`,
          "x-group-migration-operation-id": grp.operationId,
        },
        body: JSON.stringify({
          did: grp.groupDid,
          handle: targetHandle,
        }),
      });
      assert.equal(caRes.status, 200);
      ghTarget.db
        .prepare("UPDATE migration_session SET id = ?, absolute_deadline_at = ? WHERE group_did = ?")
        .run(forcedSessionId, Date.now() - 60_000, grp.groupDid);
    };

    await createStagingSession(grpA, "r13-tail-a.dst-r13.localhost", "zzzz-expired-tail-a");
    await createStagingSession(grpB, "r13-tail-b.dst-r13.localhost", "zzzz-expired-tail-b");

    // Seed 55 `retain_fail_safe` rows (`id = 'aaaa-retained-000' .. 'aaaa-retained-054'`, lexicographically BEFORE `'zzzz-expired-tail-*'`)!
    // Malformed `pending_plc_op_json` with `plc_submitting_at` set deterministically triggers `retain_fail_safe` in `reconcileUncutoverSessionLocked`.
    const now = Date.now();
    const insAcct = ghTarget.db.prepare(
      `INSERT INTO group_account (did, handle, signing_key_enc, kem_key_enc, rotation_key_enc, activated, takendown, auth_epoch, created_at)
       VALUES (?, ?, 'enc', 'enc', 'enc', 0, 0, 1, ?)`,
    );
    const insSess = ghTarget.db.prepare(
      `INSERT INTO migration_session (
         id, group_did, mode, operation_id, source_endpoint, source_plc_rotation_keys_json, preserved_sovereign_keys_json,
         access_jti, refresh_jti, auth_epoch, plc_submitting_at, pending_plc_op_cid, pending_plc_op_json, absolute_deadline_at, created_at
       ) VALUES (?, ?, 'standard', ?, 'https://src.example', '[]', '[]', ?, ?, 1, ?, 'bafy-pending', '{malformed', ?, ?)`,
    );
    const seedRetainedRange = ghTarget.db.transaction((startIdx: number, endExclusive: number) => {
      for (let i = startIdx; i < endExclusive; i += 1) {
        const pad = String(i).padStart(4, "0");
        const did = `did:plc:r13retained00000000${pad}`;
        insAcct.run(did, `ret-${pad}.dst-r13.localhost`, now);
        insSess.run(
          `aaaa-retained-${pad}`,
          did,
          `op-ret-${pad}`,
          `aj-ret-${pad}`,
          `rj-ret-${pad}`,
          now - 10_000,
          now - 10_000,
          now - 20_000,
        );
      }
    });

    // Part 1: 55 retained rows (> `PAGE_SIZE = 50`) + `zzzz-expired-tail-a` (and keep `zzzz-expired-tail-b` unexpired for Part 2)
    seedRetainedRange(0, 55);
    ghTarget.db
      .prepare("UPDATE migration_session SET absolute_deadline_at = ? WHERE id = 'zzzz-expired-tail-b'")
      .run(now + 600_000);

    await ghTarget.flushBackgroundWork();

    assert.equal(
      (ghTarget.db.prepare("SELECT COUNT(*) AS cnt FROM migration_session WHERE id LIKE 'aaaa-retained-%'").get() as { cnt: number }).cnt,
      55,
      "All 55 retain_fail_safe sessions must remain intact",
    );
    assert.equal(
      ghTarget.db.prepare("SELECT 1 FROM migration_session WHERE group_did = ?").get(grpA.groupDid),
      undefined,
      "Expired session behind >50 retained sessions MUST be purged in a single flushBackgroundWork sweep",
    );
    assert.equal(
      ghTarget.db.prepare("SELECT 1 FROM group_account WHERE did = ?").get(grpA.groupDid),
      undefined,
      "Staged group_account for purged expired session MUST be cleaned up",
    );
    assert.ok(
      ghTarget.db
        .prepare("SELECT 1 FROM service_jwt_jti WHERE issuer_did = ? AND jti = 'aborted-op:op-r13-tail-a'")
        .get(grpA.groupDid),
      "Aborted operation tombstone MUST be recorded for purged expired session",
    );

    // Part 2: Seed up to 505 retained rows (> `MAX_PER_SWEEP = 500`) and expire `zzzz-expired-tail-b`!
    // Sweep 1 scans 500 retained rows and saves cursor; Sweep 2 resumes from cursor, scans 500..504, and purges `zzzz-expired-tail-b`!
    seedRetainedRange(55, 505);
    ghTarget.db
      .prepare("UPDATE migration_session SET absolute_deadline_at = ? WHERE id = 'zzzz-expired-tail-b'")
      .run(now - 60_000);

    await ghTarget.migration.sweepExpiredMigrationSessions(now);
    // After 1st sweep of 505+1 rows (`MAX_PER_SWEEP = 500`), `zzzz-expired-tail-b` is at index 506 so it awaits Sweep 2
    assert.ok(
      ghTarget.db.prepare("SELECT 1 FROM migration_session WHERE group_did = ?").get(grpB.groupDid),
      "First bounded sweep stops at 500 candidates and persists keyset cursor",
    );

    await ghTarget.migration.sweepExpiredMigrationSessions(now);
    assert.equal(
      ghTarget.db.prepare("SELECT 1 FROM migration_session WHERE group_did = ?").get(grpB.groupDid),
      undefined,
      "Second sweep MUST resume past 500 retained sessions and purge zzzz-expired-tail-b without starvation",
    );
    assert.equal(
      ghTarget.db.prepare("SELECT 1 FROM group_account WHERE did = ?").get(grpB.groupDid),
      undefined,
    );

    // Part 3 (Round 14 Fix): A DID document pointing `#atproto_pds` to `ghTarget` with matching `#atproto` signing key
    // but missing/malformed `#atproto_kem` (`KemKeyError`) MUST fail safe (`retain_fail_safe`) instead of throwing
    // out of `reconcileUncutoverSessionLocked` and starving later migration sessions or deletion journals!
    const grpC = await prepareCoordinatedMigration("r13-tail-c.src-r13.localhost", "op-r13-tail-c");
    await createStagingSession(grpC, "r13-tail-c.dst-r13.localhost", "zzzz-expired-tail-c");

    const kemBrokenGroup = await prepareCoordinatedMigration("r14-kem-broken.src-r13.localhost", "op-r14-kem-broken");
    await createStagingSession(kemBrokenGroup, "r14-kem-broken.dst-r13.localhost", "0000-kem-broken-head");
    const targetSigDidKey = (await ghTarget.repoStore.getGroupSigningKey(kemBrokenGroup.groupDid)).did();
    const targetRotKey = await ghTarget.repoStore.getGroupRotationKey(kemBrokenGroup.groupDid);
    assert.ok(targetRotKey);
    // Replace PLC op for `kemBrokenGroup` with one pointing to `ghTarget` & matching `#atproto` signing key, WITHOUT `#atproto_kem`!
    plc.opsByDid.set(kemBrokenGroup.groupDid, [
      {
        type: "plc_operation",
        prev: null,
        sig: "mock-sig",
        rotationKeys: [targetRotKey.did()],
        verificationMethods: {
          atproto: targetSigDidKey.replace(/^did:key:/, "did:key:"),
        },
        alsoKnownAs: ["at://r14-kem-broken.dst-r13.localhost"],
        services: {
          atproto_pds: {
            type: "AtprotoPersonalDataServer",
            endpoint: ghTarget.url,
          },
        },
      },
    ]);

    await ghTarget.flushBackgroundWork();

    assert.ok(
      ghTarget.db.prepare("SELECT 1 FROM migration_session WHERE group_did = ?").get(kemBrokenGroup.groupDid),
      "Target-pointed DID doc missing #atproto_kem MUST fail safe (retain_fail_safe) without purging staged keys",
    );
    assert.equal(
      ghTarget.db.prepare("SELECT 1 FROM migration_session WHERE group_did = ?").get(grpC.groupDid),
      undefined,
      "KemKeyError on 0000-kem-broken-head MUST NOT throw or starve zzzz-expired-tail-c in flushBackgroundWork",
    );

    // Part 4 (Round 16 Fix #2): Idempotent `refreshSession` rotation recovery (`Idempotency-Key`)
    // preserves uncutover staging across lost HTTP responses while still purging on uncoordinated or post-use replays!
    const grpIdem = await prepareCoordinatedMigration("r16-idem.src-r13.localhost", "op-r16-idem");
    const idemSigKey = await ghSource.repoStore.getGroupSigningKey(grpIdem.groupDid);
    const idemCreateJwt = await createServiceJwt({
      iss: grpIdem.groupDid,
      aud: grpIdem.prepBody.targetServiceDid,
      lxm: "com.atproto.server.createAccount",
      keypair: idemSigKey,
    });
    const idemCreateRes = await fetch(`${ghTarget.url}/xrpc/com.atproto.server.createAccount`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${idemCreateJwt}`,
        "x-group-migration-operation-id": grpIdem.operationId,
      },
      body: JSON.stringify({
        did: grpIdem.groupDid,
        handle: "r16-idem.dst-r13.localhost",
      }),
    });
    assert.equal(idemCreateRes.status, 200);
    const idemInitial = (await idemCreateRes.json()) as { accessJwt: string; refreshJwt: string };

    // First refresh with Idempotency-Key commits rotation (simulating lost HTTP response in transit)
    const idemFirstRes = await fetch(`${ghTarget.url}/xrpc/com.atproto.server.refreshSession`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${idemInitial.refreshJwt}`,
        "idempotency-key": "migref-r16-idem-key-1",
      },
    });
    assert.equal(idemFirstRes.status, 200);

    // Retrying with the SAME refreshJwt + SAME Idempotency-Key returns 200 with active tokens and does NOT purge staging!
    const idemRetryRes = await fetch(`${ghTarget.url}/xrpc/com.atproto.server.refreshSession`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${idemInitial.refreshJwt}`,
        "idempotency-key": "migref-r16-idem-key-1",
      },
    });
    assert.equal(idemRetryRes.status, 200, "Idempotent refresh retry with matching Idempotency-Key must return 200");
    const idemRecovered = (await idemRetryRes.json()) as { accessJwt: string; refreshJwt: string };
    assert.ok(
      ghTarget.db.prepare("SELECT 1 FROM migration_session WHERE group_did = ?").get(grpIdem.groupDid),
      "Uncutover migration_session must remain intact after idempotent refresh recovery",
    );

    // Round 17 Fix #3: Exact `createAccount` replay after `refreshSession` rotation preserves the active `G1` generation
    // without displacing `idemRecovered` into mismatch/purge or creating a cross-generation recovery jump!
    const idemReplayCreateJwt = await createServiceJwt({
      iss: grpIdem.groupDid,
      aud: grpIdem.prepBody.targetServiceDid,
      lxm: "com.atproto.server.createAccount",
      keypair: idemSigKey,
    });
    const idemReplayCreateRes = await fetch(`${ghTarget.url}/xrpc/com.atproto.server.createAccount`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${idemReplayCreateJwt}`,
        "x-group-migration-operation-id": grpIdem.operationId,
      },
      body: JSON.stringify({
        did: grpIdem.groupDid,
        handle: "r16-idem.dst-r13.localhost",
      }),
    });
    assert.equal(idemReplayCreateRes.status, 200);
    const idemReplayedCreate = (await idemReplayCreateRes.json()) as { accessJwt: string; refreshJwt: string };

    // Using `idemRecovered.accessJwt` STILL succeeds (proving `createAccount` replay preserved `G1`'s access_jti) and closes `G0`'s grace window!
    const statusRes = await fetch(`${ghTarget.url}/xrpc/com.atproto.server.checkAccountStatus`, {
      headers: { authorization: `Bearer ${idemRecovered.accessJwt}` },
    });
    assert.equal(statusRes.status, 200);

    // Rotating `idemRecovered.refreshJwt` -> `G2` succeeds (proving `createAccount` replay did NOT displace `G1`'s refresh_jti)!
    const rotateGen2Res = await fetch(`${ghTarget.url}/xrpc/com.atproto.server.refreshSession`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${idemRecovered.refreshJwt}`,
        "idempotency-key": "migref-r17-idem-key-2",
      },
    });
    assert.equal(rotateGen2Res.status, 200);
    // And `idemReplayedCreate.refreshJwt` had the same `G1` JTI, so replaying it with the same `G1 -> G2` idempotency key recovers `G2` cleanly!
    const replayCreateGen2Res = await fetch(`${ghTarget.url}/xrpc/com.atproto.server.refreshSession`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${idemReplayedCreate.refreshJwt}`,
        "idempotency-key": "migref-r17-idem-key-2",
      },
    });
    assert.equal(replayCreateGen2Res.status, 200);

    // Any subsequent replay of `idemInitial.refreshJwt` (even with `"migref-r16-idem-key-1"`) 401s and purges uncutover staging!
    const postUseReplay = await fetch(`${ghTarget.url}/xrpc/com.atproto.server.refreshSession`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${idemInitial.refreshJwt}`,
        "idempotency-key": "migref-r16-idem-key-1",
      },
    });
    assert.equal(postUseReplay.status, 401);
    assert.equal(
      ghTarget.db.prepare("SELECT 1 FROM migration_session WHERE group_did = ?").get(grpIdem.groupDid),
      undefined,
      "Post-use refresh token replay must still purge uncutover staging",
    );
  } finally {
    await ghTarget.close();
    await ghSource.close();
    await pds.close();
    await plc.close();
  }
});
