import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { P256Keypair } from "@atproto/crypto";
import { tombstoneOp } from "@did-plc/lib";
import { groupAdminScopes, groupModeratorScopes } from "@flock/protocol/scopes";
import express from "express";
import * as jose from "jose";
import { createGroupGenesisPlcOp, plcCidForOp } from "./plc";
import {
  completeGroupOAuthFlow,
  createDpopTestClient,
  createPkcePair,
  startMockPersonalPds,
  startMockPlcServer,
  startTestGroupHost,
} from "./test-harness";

test("Group Host OAuth serves RFC metadata, DID overlap rotation, public & confidential clients, consent approve/deny, DPoP replay, family revocation, and controller-session", async () => {
  const plc = await startMockPlcServer();
  const pds = await startMockPersonalPds(plc);

  // Also test `GROUP_HOST_SERVICE_PRIVATE_JWKS` overlap rotation (`#atproto` + `#atproto-<kid>`)
  const jwk1 = await jose.generateKeyPair("ES256", { extractable: true });
  const jwk2 = await jose.generateKeyPair("ES256", { extractable: true });
  const exp1 = await jose.exportJWK(jwk1.privateKey);
  const exp2 = await jose.exportJWK(jwk2.privateKey);

  const gh = await startTestGroupHost({
    plc,
    overrides: {
      servicePrivateJwks: [
        { kid: "rot-primary", kty: "EC", crv: "P-256", x: exp1.x!, y: exp1.y!, d: exp1.d! },
        { kid: "rot-prev", kty: "EC", crv: "P-256", x: exp2.x!, y: exp2.y!, d: exp2.d! },
      ],
    },
  });

  // Start a tiny confidential OAuth client metadata + JWKS server
  const confKey = await jose.generateKeyPair("ES256", { extractable: true });
  const confPub = await jose.exportJWK(confKey.publicKey);
  confPub.kid = "conf-kid-1";
  confPub.alg = "ES256";
  confPub.use = "sig";
  const confApp = express();
  const confServer = createServer(confApp);
  await new Promise<void>((resolve) => confServer.listen(0, "127.0.0.1", () => resolve()));
  const confPort = (confServer.address() as AddressInfo).port;
  const confOrigin = `http://127.0.0.1:${confPort}`;
  const confClientId = `${confOrigin}/client-metadata.json`;
  const confRedirectUri = `${confOrigin}/callback`;
  const adminScopeStr = groupAdminScopes().join(" ");

  confApp.get("/client-metadata.json", (_req, res) => {
    res.json({
      client_id: confClientId,
      client_name: "Confidential Operator Test",
      redirect_uris: [confRedirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: adminScopeStr,
      token_endpoint_auth_method: "private_key_jwt",
      token_endpoint_auth_signing_alg: "ES256",
      jwks_uri: `${confOrigin}/jwks.json`,
      dpop_bound_access_tokens: true,
    });
  });
  confApp.get("/jwks.json", (_req, res) => {
    res.json({ keys: [confPub] });
  });

  try {
    // 1. Metadata & `/.well-known/did.json` overlap rotation check
    const didRes = await fetch(`${gh.url}/.well-known/did.json`);
    assert.equal(didRes.status, 200);
    const didDoc = (await didRes.json()) as {
      id: string;
      verificationMethod: Array<{ id: string }>;
      service: Array<{ id: string; type: string }>;
    };
    assert.ok(didDoc.id.startsWith("did:web:localhost%3A"));
    const vmIds = didDoc.verificationMethod.map((v) => v.id);
    assert.ok(vmIds.includes(`${didDoc.id}#atproto`));
    assert.ok(vmIds.includes(`${didDoc.id}#atproto-rot-primary`));
    assert.ok(vmIds.includes(`${didDoc.id}#atproto-rot-prev`));
    assert.ok(didDoc.service.some((s) => s.id.endsWith("#opensocial_group") && s.type === "OpenSocialGroupHost"));

    const asMetaRes = await fetch(`${gh.url}/.well-known/oauth-authorization-server`);
    assert.equal(asMetaRes.status, 200);
    const asMeta = (await asMetaRes.json()) as Record<string, unknown>;
    assert.equal(asMeta.issuer, gh.url);
    assert.equal(asMeta.require_pushed_authorization_requests, true);

    const jwksRes = await fetch(`${gh.url}/oauth/jwks.json`);
    assert.equal(jwksRes.status, 200);
    const jwksBody = (await jwksRes.json()) as { keys: Array<{ kid: string }> };
    assert.deepEqual(jwksBody.keys.map((k) => k.kid), ["rot-primary", "rot-prev"]);

    const alice = await pds.registerUser("alice.test");
    const bob = await pds.registerUser("bob.test");

    // 2. DPoP nonce negotiation (`400 use_dpop_nonce` on AS vs `401` on RS) & `dpop_jti` replay rejection
    const dpopProbe = await createDpopTestClient();
    const rawProofNoNonce = await dpopProbe.signProof({ htm: "POST", htu: `${gh.url}/oauth/par` });
    const noNonceAsRes = await fetch(`${gh.url}/oauth/par`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", dpop: rawProofNoNonce },
      body: "client_id=http://localhost",
    });
    assert.equal(noNonceAsRes.status, 400, "AS endpoint must return 400 on missing DPoP nonce");
    const freshNonce = noNonceAsRes.headers.get("dpop-nonce");
    assert.ok(freshNonce);
    const noNonceAsBody = (await noNonceAsRes.json()) as { error: string };
    assert.equal(noNonceAsBody.error, "use_dpop_nonce");

    const rsNoNonceProof = await dpopProbe.signProof({
      htm: "GET",
      htu: `${gh.url}/xrpc/com.atproto.server.checkAccountStatus`,
      accessToken: "dummy-token",
    });
    const noNonceRsRes = await fetch(`${gh.url}/xrpc/com.atproto.server.checkAccountStatus`, {
      headers: { authorization: "DPoP dummy-token", dpop: rsNoNonceProof },
    });
    assert.equal(noNonceRsRes.status, 401, "RS endpoint must return 401 on missing DPoP nonce");
    assert.match(noNonceRsRes.headers.get("www-authenticate") ?? "", /use_dpop_nonce/);

    // Verify `dpop_jti` replay rejection within 198s window
    const fixedJti = `replay-jti-${randomUUID()}`;
    const pkceProbe = createPkcePair();
    const loopClientId = `http://localhost?redirect_uri=${encodeURIComponent("http://127.0.0.1:43123/cb")}&scope=${encodeURIComponent("atproto")}`;
    const validParProof = await dpopProbe.signProof({
      htm: "POST",
      htu: `${gh.url}/oauth/par`,
      nonce: freshNonce!,
      jti: fixedJti,
    });
    const parFirst = await fetch(`${gh.url}/oauth/par`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", dpop: validParProof },
      body: new URLSearchParams({
        client_id: loopClientId,
        redirect_uri: "http://127.0.0.1:43123/cb",
        response_type: "code",
        code_challenge: pkceProbe.challenge,
        code_challenge_method: "S256",
        scope: "atproto",
      }).toString(),
    });
    assert.equal(parFirst.status, 201);

    const parReplay = await fetch(`${gh.url}/oauth/par`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", dpop: validParProof },
      body: new URLSearchParams({
        client_id: loopClientId,
        redirect_uri: "http://127.0.0.1:43123/cb",
        response_type: "code",
        code_challenge: pkceProbe.challenge,
        code_challenge_method: "S256",
        scope: "atproto",
      }).toString(),
    });
    assert.equal(parReplay.status, 400, "Replaying DPoP jti must be rejected");

    // 3. `prompt=create` with `publicMeta: true` AND `publicMeta: false` + simultaneous callbacks for same personal DID!
    const revokedCountBefore = pds.revokedTokens.length;
    const [createdPublic, createdPrivate] = await Promise.all([
      completeGroupOAuthFlow({
        groupHost: gh,
        pds,
        user: alice,
        scope: adminScopeStr,
        prompt: "create",
        createParams: {
          displayName: "Public Team",
          handle: "public-team.groups.localhost",
          joinPolicy: "open",
          publicMeta: true,
        },
      }),
      completeGroupOAuthFlow({
        groupHost: gh,
        pds,
        user: alice,
        scope: adminScopeStr,
        prompt: "create",
        responseMode: "fragment",
        createParams: {
          displayName: "Stealth Team",
          handle: "stealth-team.groups.localhost",
          joinPolicy: "invite",
          publicMeta: false,
        },
      }),
    ]);

    assert.ok(createdPublic.tokenResponse);
    assert.ok(createdPrivate.tokenResponse);
    assert.equal(createdPublic.tokenResponse.token_type, "DPoP");
    assert.ok(createdPublic.tokenResponse.sub.startsWith("did:plc:"));
    assert.ok(createdPublic.tokenResponse.refresh_token);
    assert.ok(createdPublic.tokenResponse.expires_in > 0);
    // Verify fragment redirect contained `iss` parameter
    assert.match(createdPrivate.redirectLocation, /#.*iss=/);
    // Verify `session.signOut()` called personal PDS `/oauth/revoke` for both upstream callbacks!
    assert.ok(
      pds.revokedTokens.length >= revokedCountBefore + 2,
      "Immediate upstream session.signOut() must revoke personal PDS tokens",
    );

    const pubGroupDid = createdPublic.tokenResponse.sub;
    const privGroupDid = createdPrivate.tokenResponse.sub;

    // `publicMeta: true` publishes `group.opensocial.declaration/self` in public repo; `publicMeta: false` omits it!
    const pubDeclRes = await fetch(
      `${gh.url}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(pubGroupDid)}&collection=group.opensocial.declaration&rkey=self`,
    );
    assert.equal(pubDeclRes.status, 200);
    const privDeclRes = await fetch(
      `${gh.url}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(privGroupDid)}&collection=group.opensocial.declaration&rkey=self`,
    );
    assert.equal(privDeclRes.status, 400, "publicMeta=false must omit public group.opensocial.declaration/self");

    // 4. Verify `HEAD /oauth/upstream-callback` returns `405 Method Not Allowed`!
    const headRes = await fetch(`${gh.url}/oauth/upstream-callback?state=any&code=any`, { method: "HEAD" });
    assert.equal(headRes.status, 405);

    // 5. Downstream `/oauth/confirm-action` Deny -> `error=access_denied` + `iss`
    const denied = await completeGroupOAuthFlow({
      groupHost: gh,
      pds,
      user: alice,
      scope: adminScopeStr,
      loginHint: pubGroupDid,
      decision: "deny",
    });
    assert.equal(denied.tokenResponse, undefined);
    const deniedUrl = new URL(denied.redirectLocation);
    assert.equal(deniedUrl.searchParams.get("error"), "access_denied");
    assert.equal(deniedUrl.searchParams.get("iss"), gh.url);

    // 6. Confidential `"private_key_jwt"` client PAR + Consent Approve + Token Exchange + Refresh (no PKCE) + Revoke
    const confDpop = await createDpopTestClient();
    const confPkce = createPkcePair();
    const signAssertion = async (jti = randomUUID()) =>
      new jose.SignJWT({})
        .setProtectedHeader({ alg: "ES256", kid: "conf-kid-1" })
        .setIssuer(confClientId)
        .setSubject(confClientId)
        .setAudience(gh.url)
        .setIssuedAt()
        .setExpirationTime("60s")
        .setJti(jti)
        .sign(confKey.privateKey);

    const parAssertionJti = randomUUID();
    const parAssertion = await signAssertion(parAssertionJti);
    const confParRes = await confDpop.fetchWithDpop(`${gh.url}/oauth/par`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: confClientId,
        redirect_uri: confRedirectUri,
        response_type: "code",
        code_challenge: confPkce.challenge,
        code_challenge_method: "S256",
        scope: adminScopeStr,
        login_hint: pubGroupDid,
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: parAssertion,
      }).toString(),
    });
    assert.equal(confParRes.status, 201);
    const { request_uri: confReqUri } = (await confParRes.json()) as { request_uri: string };

    // Replaying the same `client_assertion` JTI must fail!
    const replayAssertionRes = await confDpop.fetchWithDpop(`${gh.url}/oauth/par`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: confClientId,
        redirect_uri: confRedirectUri,
        response_type: "code",
        code_challenge: confPkce.challenge,
        code_challenge_method: "S256",
        scope: adminScopeStr,
        login_hint: pubGroupDid,
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: parAssertion,
      }).toString(),
    });
    assert.equal(replayAssertionRes.status, 401, "client_assertion jti replay must be rejected with 401 invalid_client");

    // Walk authorize -> upstream -> confirm-action Approve for confidential client
    const getAuthHtml = await (
      await fetch(
        `${gh.url}/oauth/authorize?client_id=${encodeURIComponent(confClientId)}&request_uri=${encodeURIComponent(confReqUri)}`,
      )
    ).text();
    const authCsrf = /name="csrf_token"\s+value="([^"]+)"/.exec(getAuthHtml)![1]!;
    const postAuth = await fetch(`${gh.url}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: confClientId,
        request_uri: confReqUri,
        csrf_token: authCsrf,
        actor: alice.did,
        decision: "approve",
      }).toString(),
      redirect: "manual",
    });
    const flowCookie = postAuth.headers.getSetCookie().map((c) => c.split(";")[0]!).join("; ");
    const upAuthLoc = new URL(postAuth.headers.get("location")!);
    upAuthLoc.searchParams.set("as_did", alice.did);
    const pdsCbLoc = (await fetch(upAuthLoc.toString(), { redirect: "manual" })).headers.get("location")!;
    const ghCb = await fetch(pdsCbLoc, { headers: { cookie: flowCookie }, redirect: "manual" });
    const consentCookie = ghCb.headers
      .getSetCookie()
      .filter((c) => !c.includes("Max-Age=0"))
      .map((c) => c.split(";")[0]!)
      .join("; ");
    const confirmHtml = await (await fetch(ghCb.headers.get("location")!, { headers: { cookie: consentCookie } })).text();
    const confirmCsrf = /name="csrf_token"\s+value="([^"]+)"/.exec(confirmHtml)![1]!;
    const confirmApproved = await fetch(`${gh.url}/oauth/confirm-action`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: consentCookie },
      body: new URLSearchParams({ csrf_token: confirmCsrf, decision: "approve" }).toString(),
      redirect: "manual",
    });
    const confCode = new URL(confirmApproved.headers.get("location")!).searchParams.get("code")!;

    const tokRes1 = await confDpop.fetchWithDpop(`${gh.url}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: confCode,
        redirect_uri: confRedirectUri,
        client_id: confClientId,
        code_verifier: confPkce.verifier,
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: await signAssertion(),
      }).toString(),
    });
    assert.equal(tokRes1.status, 200);
    const confTok1 = (await tokRes1.json()) as { access_token: string; refresh_token: string };

    // Refresh token rotation (WITHOUT any PKCE fields!)
    const tokRes2 = await confDpop.fetchWithDpop(`${gh.url}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: confTok1.refresh_token,
        client_id: confClientId,
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: await signAssertion(),
      }).toString(),
    });
    assert.equal(tokRes2.status, 200);
    const confTok2 = (await tokRes2.json()) as { access_token: string; refresh_token: string };

    // Replaying the consumed `confTok1.refresh_token` MUST revoke the entire OAuth family immediately!
    const replayRefresh = await confDpop.fetchWithDpop(`${gh.url}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: confTok1.refresh_token,
        client_id: confClientId,
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: await signAssertion(),
      }).toString(),
    });
    assert.equal(replayRefresh.status, 400);

    // Active `confTok2.access_token` in that family must now be rejected (`401`)!
    const afterCascade = await confDpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.server.checkAccountStatus`, {
      method: "GET",
      accessToken: confTok2.access_token,
    });
    assert.equal(afterCascade.status, 401, "Family cascade must immediately invalidate active access_token");

    // 7. Live `effectiveMemberPermissions` narrowing on role demotion!
    // Add `bob` with `admin` role, mint a moderator/admin session for `bob`, then demote `bob` to `member`!
    const membersSpace = `at://${pubGroupDid}/space/group.opensocial.members/self`;
    const putBobAdmin = await createdPublic.dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.putRecord`, {
      method: "POST",
      accessToken: createdPublic.tokenResponse.access_token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: membersSpace,
        repo: pubGroupDid,
        collection: "group.opensocial.membership",
        rkey: bob.did,
        record: {
          $type: "group.opensocial.membership",
          roles: ["admin"],
          createdAt: new Date().toISOString(),
        },
      }),
    });
    assert.equal(putBobAdmin.status, 200);

    const bobSession = await completeGroupOAuthFlow({
      groupHost: gh,
      pds,
      user: bob,
      scope: groupModeratorScopes().join(" "),
      loginHint: pubGroupDid,
    });
    assert.ok(bobSession.tokenResponse);

    // Before demotion, Bob can call `listModSubjects` (`200`)
    const modOk = await bobSession.dpop.fetchWithDpop(`${gh.url}/xrpc/group.opensocial.listModSubjects`, {
      method: "GET",
      accessToken: bobSession.tokenResponse.access_token,
    });
    assert.equal(modOk.status, 200);

    // Alice demotes Bob from `["admin"]` to `["member"]`
    const demoteBob = await createdPublic.dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.putRecord`, {
      method: "POST",
      accessToken: createdPublic.tokenResponse.access_token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: membersSpace,
        repo: pubGroupDid,
        collection: "group.opensocial.membership",
        rkey: bob.did,
        record: {
          $type: "group.opensocial.membership",
          roles: ["member"],
          createdAt: new Date().toISOString(),
        },
      }),
    });
    assert.equal(demoteBob.status, 200);

    // Immediately on the next request, Bob's existing access token is live-narrowed and denied (`403`)!
    const modAfterDemote = await bobSession.dpop.fetchWithDpop(`${gh.url}/xrpc/group.opensocial.listModSubjects`, {
      method: "GET",
      accessToken: bobSession.tokenResponse.access_token,
    });
    assert.equal(modAfterDemote.status, 403, "Demoted member session must lose moderator RPC capability immediately");

    // 8. Round 29 Finding #1: Destructive routes MUST reject non-step-up sessions (`prompt=create`, normal OAuth,
    //    and `prompt=consent`) with `403 FreshAuthRequired` even immediately after issuance, and accept ONLY
    //    explicit `prompt=login` (within 5 min) or sovereign `controller-session`!
    const normalOAuthFlow = await completeGroupOAuthFlow({
      groupHost: gh,
      pds,
      user: alice,
      scope: adminScopeStr,
      loginHint: pubGroupDid,
    });
    const consentOAuthFlow = await completeGroupOAuthFlow({
      groupHost: gh,
      pds,
      user: alice,
      scope: adminScopeStr,
      prompt: "consent",
      loginHint: pubGroupDid,
    });
    for (const [label, nonStepFlow] of [
      ["prompt=create", createdPublic],
      ["normal OAuth (no prompt)", normalOAuthFlow],
      ["prompt=consent", consentOAuthFlow],
    ] as const) {
      assert.ok(nonStepFlow.tokenResponse);
      const nonStepTok = nonStepFlow.tokenResponse.access_token;
      const rPlcSig = await nonStepFlow.dpop.fetchWithDpop(
        `${gh.url}/xrpc/com.atproto.identity.requestPlcOperationSignature`,
        { method: "POST", accessToken: nonStepTok },
      );
      assert.equal(rPlcSig.status, 403, `${label} must be rejected on requestPlcOperationSignature`);
      assert.equal(((await rPlcSig.json()) as { error: string }).error, "FreshAuthRequired");

      const rPrep = await nonStepFlow.dpop.fetchWithDpop(`${gh.url}/group-admin/prepare-migration`, {
        method: "POST",
        accessToken: nonStepTok,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ group: pubGroupDid, operationId: "r29-stepup-block", targetEndpoint: "http://127.0.0.1:9999" }),
      });
      assert.equal(rPrep.status, 403, `${label} must be rejected on prepare-migration`);
      assert.equal(((await rPrep.json()) as { error: string }).error, "FreshAuthRequired");

      const rClaim = await nonStepFlow.dpop.fetchWithDpop(`${gh.url}/group-admin/claim-action-token`, {
        method: "POST",
        accessToken: nonStepTok,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ group: pubGroupDid, purpose: "plc_operation" }),
      });
      assert.equal(rClaim.status, 403, `${label} must be rejected on claim-action-token`);
      assert.equal(((await rClaim.json()) as { error: string }).error, "FreshAuthRequired");

      const rReqDel = await nonStepFlow.dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.server.requestAccountDelete`, {
        method: "POST",
        accessToken: nonStepTok,
      });
      assert.equal(rReqDel.status, 403, `${label} must be rejected on requestAccountDelete`);
      assert.equal(((await rReqDel.json()) as { error: string }).error, "FreshAuthRequired");
    }

    // Explicit `prompt=login` step-up succeeds on destructive routes!
    const stepUpPublic = await completeGroupOAuthFlow({
      groupHost: gh,
      pds,
      user: alice,
      scope: adminScopeStr,
      prompt: "login",
      loginHint: pubGroupDid,
    });
    assert.ok(stepUpPublic.tokenResponse);

    // Sovereign PLC rotation-key `POST /group-admin/controller-session`!
    // Add an external sovereign P-256 rotation key via `requestPlcOperationSignature` -> `claim-action-token` -> `signPlcOperation` -> `submitPlcOperation`
    const sovKey = await P256Keypair.create({ exportable: true });
    const reqSigRes = await stepUpPublic.dpop.fetchWithDpop(
      `${gh.url}/xrpc/com.atproto.identity.requestPlcOperationSignature`,
      {
        method: "POST",
        accessToken: stepUpPublic.tokenResponse.access_token,
      },
    );
    assert.equal(reqSigRes.status, 200);
    const claimSigRes = await stepUpPublic.dpop.fetchWithDpop(`${gh.url}/group-admin/claim-action-token`, {
      method: "POST",
      accessToken: stepUpPublic.tokenResponse.access_token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ group: pubGroupDid, purpose: "plc_operation" }),
    });
    assert.equal(claimSigRes.status, 200);
    const capturedActionToken = ((await claimSigRes.json()) as { token: string }).token;

    const lastPlcRes = await fetch(`${plc.url}/${encodeURIComponent(pubGroupDid)}/log/last`);
    const lastPlcOp = (await lastPlcRes.json()) as { rotationKeys: string[] };
    const signPlcRes = await stepUpPublic.dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.identity.signPlcOperation`, {
      method: "POST",
      accessToken: stepUpPublic.tokenResponse.access_token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: capturedActionToken,
        rotationKeys: [...lastPlcOp.rotationKeys, sovKey.did()],
      }),
    });
    assert.equal(signPlcRes.status, 200);
    const { operation: signedPlcOp } = (await signPlcRes.json()) as { operation: Record<string, unknown> };
    const subPlcRes = await stepUpPublic.dpop.fetchWithDpop(
      `${gh.url}/xrpc/com.atproto.identity.submitPlcOperation`,
      {
        method: "POST",
        accessToken: stepUpPublic.tokenResponse.access_token,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation: signedPlcOp }),
      },
    );
    assert.equal(subPlcRes.status, 200);

    // Mint a sovereign controller-session signed by `sovKey`!
    const ctrlDpop = await createDpopTestClient();
    const ctrlJwt = await createControllerBearerJwt({
      iss: pubGroupDid,
      aud: gh.config.serviceDid,
      signer: sovKey,
    });
    const ctrlRes = await ctrlDpop.fetchWithDpop(`${gh.url}/group-admin/controller-session`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ctrlJwt}`,
      },
      body: JSON.stringify({ group: pubGroupDid }),
    });
    assert.equal(ctrlRes.status, 200, `controller-session failed: ${await ctrlRes.clone().text()}`);
    const ctrlTok = (await ctrlRes.json()) as { access_token: string; sub: string };
    assert.equal(ctrlTok.sub, pubGroupDid);

    const statusViaCtrl = await ctrlDpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.server.checkAccountStatus`, {
      method: "GET",
      accessToken: ctrlTok.access_token,
    });
    assert.equal(statusViaCtrl.status, 200);

    // Controller JWT must strictly enforce `typ === "JWT"`, `iat <= now + 5s`, `0 < exp - iat <= 60s`, and non-empty `jti`
    const nowSecCtrl = Math.floor(Date.now() / 1000);
    for (const badCtrlSpec of [
      { header: { alg: "ES256", kid: sovKey.did() }, payload: { iat: nowSecCtrl, exp: nowSecCtrl + 60, jti: randomUUID() } },
      { header: { typ: "JWT", alg: "ES256", kid: sovKey.did() }, payload: { iat: nowSecCtrl + 15, exp: nowSecCtrl + 60, jti: randomUUID() } },
      { header: { typ: "JWT", alg: "ES256", kid: sovKey.did() }, payload: { iat: nowSecCtrl - 10, exp: nowSecCtrl + 55, jti: randomUUID() } },
      { header: { typ: "JWT", alg: "ES256", kid: sovKey.did() }, payload: { iat: nowSecCtrl + 3, exp: nowSecCtrl + 2, jti: randomUUID() } },
      { header: { typ: "JWT", alg: "ES256", kid: sovKey.did() }, payload: { iat: nowSecCtrl, exp: nowSecCtrl + 60, jti: "   " } },
    ]) {
      const hB64 = Buffer.from(JSON.stringify(badCtrlSpec.header)).toString("base64url");
      const pB64 = Buffer.from(
        JSON.stringify({
          iss: pubGroupDid,
          aud: gh.config.serviceDid,
          lxm: "com.atproto.server.createSession",
          ...badCtrlSpec.payload,
        }),
      ).toString("base64url");
      const sB64 = Buffer.from(await sovKey.sign(Buffer.from(`${hB64}.${pB64}`, "utf8"))).toString("base64url");
      const badRes = await ctrlDpop.fetchWithDpop(`${gh.url}/group-admin/controller-session`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${hB64}.${pB64}.${sB64}`,
        },
        body: JSON.stringify({ group: pubGroupDid }),
      });
      assert.equal(badRes.status, 401);
    }
  } finally {
    await new Promise<void>((resolve) => confServer.close(() => resolve()));
    await gh.close();
    await pds.close();
    await plc.close();
  }
});

async function createControllerBearerJwt(params: {
  iss: string;
  aud: string;
  signer: P256Keypair;
}): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ typ: "JWT", alg: "ES256", kid: params.signer.did() }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: params.iss,
      aud: params.aud,
      lxm: "com.atproto.server.createSession",
      iat: nowSec,
      exp: nowSec + 60,
      jti: randomUUID(),
    }),
  ).toString("base64url");
  const sig = await params.signer.sign(Buffer.from(`${header}.${payload}`, "utf8"));
  return `${header}.${payload}.${Buffer.from(sig).toString("base64url")}`;
}

test("OAuth code replay cascade, 5-min creation code expiry -> existing-group reauth pivot, and 8-route recovery session allowlist", async () => {
  const plc = await startMockPlcServer();
  const pds = await startMockPersonalPds(plc);
  const gh = await startTestGroupHost({ plc });

  try {
    const alice = await pds.registerUser("alice.test");
    const adminScopeStr = groupAdminScopes().join(" ");

    // 1. Create group and verify consumed authorization_code replay revokes the minted session family
    const dpop = await createDpopTestClient();
    const redirectUri = "http://127.0.0.1:43123/callback";
    const clientId = `http://localhost?redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(adminScopeStr)}`;
    const pkce = createPkcePair();
    const creationKey = `ck-${randomUUID()}`;

    const parRes = await dpop.fetchWithDpop(`${gh.url}/oauth/par`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
        scope: adminScopeStr,
        prompt: "create",
        creation_key: creationKey,
      }).toString(),
    });
    const { request_uri: reqUri } = (await parRes.json()) as { request_uri: string };
    const formHtml = await (
      await fetch(`${gh.url}/oauth/authorize?client_id=${encodeURIComponent(clientId)}&request_uri=${encodeURIComponent(reqUri)}`)
    ).text();
    const csrf = /name="csrf_token"\s+value="([^"]+)"/.exec(formHtml)![1]!;
    const postAuth = await fetch(`${gh.url}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        request_uri: reqUri,
        csrf_token: csrf,
        actor: alice.did,
        creation_key: creationKey,
        display_name: "Recovery Test Group",
        handle: "recovery-test.groups.localhost",
        join_policy: "invite",
        public_meta: "true",
        decision: "approve",
      }).toString(),
      redirect: "manual",
    });
    const flowCookie = postAuth.headers.getSetCookie().map((c) => c.split(";")[0]!).join("; ");
    const upUrl = new URL(postAuth.headers.get("location")!);
    upUrl.searchParams.set("as_did", alice.did);
    const pdsCb = (await fetch(upUrl.toString(), { redirect: "manual" })).headers.get("location")!;
    const ghCb = await fetch(pdsCb, { headers: { cookie: flowCookie }, redirect: "manual" });
    const issuedCode = new URL(ghCb.headers.get("location")!).searchParams.get("code")!;

    // Exchange code once -> 200
    const ex1 = await dpop.fetchWithDpop(`${gh.url}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: issuedCode,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: pkce.verifier,
      }).toString(),
    });
    assert.equal(ex1.status, 200);
    const tok1 = (await ex1.json()) as { access_token: string; sub: string };
    const groupDid = tok1.sub;

    // Replay the same authorization_code -> 400 AND revokes `tok1.access_token`'s family!
    const exReplay = await dpop.fetchWithDpop(`${gh.url}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: issuedCode,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: pkce.verifier,
      }).toString(),
    });
    assert.equal(exReplay.status, 400);
    const checkAfterCodeReplay = await dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.server.checkAccountStatus`, {
      method: "GET",
      accessToken: tok1.access_token,
    });
    assert.equal(checkAfterCodeReplay.status, 401, "Consumed oauth_code replay must revoke session family");

    // 2. Simulate lost `/oauth/token` response / 5-min `oauth_code` expiry on `creation_key` -> recovers via existing-group reauth (`login_hint = groupDid`)!
    const reauthAfterLostToken = await completeGroupOAuthFlow({
      groupHost: gh,
      pds,
      user: alice,
      scope: adminScopeStr,
      loginHint: groupDid,
    });
    assert.ok(reauthAfterLostToken.tokenResponse);
    assert.equal(reauthAfterLostToken.tokenResponse.sub, groupDid);

    // 3. Deactivate group -> verify `auth_epoch` invalidation + `recovery` OAuth session 8-route allowlist!
    const deactRes = await reauthAfterLostToken.dpop.fetchWithDpop(
      `${gh.url}/xrpc/com.atproto.server.deactivateAccount`,
      {
        method: "POST",
        accessToken: reauthAfterLostToken.tokenResponse.access_token,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    assert.equal(deactRes.status, 200);

    // Prior active session is immediately invalidated (`auth_epoch` incremented)
    const staleAfterDeact = await reauthAfterLostToken.dpop.fetchWithDpop(
      `${gh.url}/xrpc/com.atproto.server.checkAccountStatus`,
      {
        method: "GET",
        accessToken: reauthAfterLostToken.tokenResponse.access_token,
      },
    );
    assert.equal(staleAfterDeact.status, 401);

    // Mint a `recovery` OAuth session (`prompt=login`, `login_hint = groupDid`) while `activated === 0`!
    const recoveryFlow = await completeGroupOAuthFlow({
      groupHost: gh,
      pds,
      user: alice,
      scope: adminScopeStr,
      prompt: "login",
      loginHint: groupDid,
    });
    assert.ok(recoveryFlow.tokenResponse);
    const recTok = recoveryFlow.tokenResponse.access_token;

    // Allowlisted route (`checkAccountStatus`) succeeds (`activated: false`)
    const recStatusRes = await recoveryFlow.dpop.fetchWithDpop(
      `${gh.url}/xrpc/com.atproto.server.checkAccountStatus`,
      {
        method: "GET",
        accessToken: recTok,
      },
    );
    assert.equal(recStatusRes.status, 200);
    const recStatus = (await recStatusRes.json()) as { activated: boolean };
    assert.equal(recStatus.activated, false);

    // Non-allowlisted XRPC route (`space.putRecord`) is rejected with `403`!
    const forbiddenWrite = await recoveryFlow.dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.space.putRecord`, {
      method: "POST",
      accessToken: recTok,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: `at://${groupDid}/space/group.opensocial.meta/self`,
        repo: groupDid,
        collection: "group.opensocial.profile",
        rkey: "self",
        record: { $type: "group.opensocial.profile", displayName: "Blocked", createdAt: new Date().toISOString() },
      }),
    });
    assert.equal(forbiddenWrite.status, 403);

    // `/group-admin/claim-action-token` with `purpose: "plc_operation"` is rejected (`403`) on `recovery` session!
    const forbiddenPlcClaim = await recoveryFlow.dpop.fetchWithDpop(`${gh.url}/group-admin/claim-action-token`, {
      method: "POST",
      accessToken: recTok,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ group: groupDid, purpose: "plc_operation" }),
    });
    assert.equal(forbiddenPlcClaim.status, 403);

    // `activateAccount` upgrades the session to `session_kind = 'group'` and restores `activated: true`!
    const actRes = await recoveryFlow.dpop.fetchWithDpop(`${gh.url}/xrpc/com.atproto.server.activateAccount`, {
      method: "POST",
      accessToken: recTok,
    });
    assert.equal(actRes.status, 200);

    const statusAfterAct = await recoveryFlow.dpop.fetchWithDpop(
      `${gh.url}/xrpc/com.atproto.server.checkAccountStatus`,
      {
        method: "GET",
        accessToken: recTok,
      },
    );
    assert.equal(statusAfterAct.status, 200);
    assert.equal(((await statusAfterAct.json()) as { activated: boolean }).activated, true);
  } finally {
    await gh.close();
    await pds.close();
    await plc.close();
  }
});

test("OAuth binds family revocation to client+DPoP, preserves loopback redirect_uri query, isolates concurrent gh_consent_<hash> cookies, enforces DPoP maxTokenAge=10, and verifies PLC compensation", async () => {
  const plc = await startMockPlcServer();
  const pds = await startMockPersonalPds(plc);
  const gh = await startTestGroupHost({ plc });

  // Custom loopback metadata server registering a portless loopback redirect URI with query parameter
  const metaApp = express();
  const metaServer = createServer(metaApp);
  await new Promise<void>((resolve) => metaServer.listen(0, "127.0.0.1", () => resolve()));
  const metaPort = (metaServer.address() as AddressInfo).port;
  const metaClientId = `http://127.0.0.1:${metaPort}/client-metadata.json`;
  const adminScopeStr = groupAdminScopes().join(" ");

  metaApp.get("/client-metadata.json", (_req, res) => {
    res.json({
      client_id: metaClientId,
      client_name: "Query Loopback Client",
      redirect_uris: ["http://127.0.0.1/callback?mode=popup"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: adminScopeStr,
      token_endpoint_auth_method: "none",
      dpop_bound_access_tokens: true,
    });
  });

  try {
    const alice = await pds.registerUser("alice-oauthsec.test");

    // 1. DPoP `maxTokenAge: 10` check (`iat` = now - 200s exceeds 10 + 180 = 190s window!)
    const ageDpop = await createDpopTestClient();
    const initNonceRes = await fetch(`${gh.url}/oauth/par`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        dpop: await ageDpop.signProof({ htm: "POST", htu: `${gh.url}/oauth/par` }),
      },
      body: "client_id=http://localhost",
    });
    const nonce1 = initNonceRes.headers.get("dpop-nonce")!;
    const staleIat = Math.floor(Date.now() / 1000) - 200;
    const staleProof = await new jose.SignJWT({
      jti: randomUUID(),
      htm: "POST",
      htu: `${gh.url}/oauth/par`,
      iat: staleIat,
      nonce: nonce1,
    })
      .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: ageDpop.publicJwk })
      .sign(ageDpop.keyPair.privateKey);
    const staleProofRes = await fetch(`${gh.url}/oauth/par`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", dpop: staleProof },
      body: "client_id=http://localhost",
    });
    assert.equal(staleProofRes.status, 400, "DPoP proof older than maxTokenAge(10)+clockTolerance(180) must be rejected");
    assert.equal(((await staleProofRes.json()) as { error: string }).error, "invalid_dpop_proof");

    // 2. Loopback `redirect_uri` `#fragment` rejection & exact query matching on dynamic loopback ports
    const pkce = createPkcePair();
    const fragParRes = await ageDpop.fetchWithDpop(`${gh.url}/oauth/par`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: "http://localhost",
        response_type: "code",
        redirect_uri: "http://127.0.0.1:54321/#evil",
        scope: adminScopeStr,
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
      }).toString(),
    });
    assert.equal(fragParRes.status, 400, "redirect_uri with #fragment must be rejected");

    const wrongQueryParRes = await ageDpop.fetchWithDpop(`${gh.url}/oauth/par`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: metaClientId,
        response_type: "code",
        redirect_uri: "http://127.0.0.1:54321/callback?mode=tampered",
        scope: adminScopeStr,
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
      }).toString(),
    });
    assert.equal(wrongQueryParRes.status, 400, "Mismatched query on dynamic loopback port must be rejected");

    const matchingQueryParRes = await ageDpop.fetchWithDpop(`${gh.url}/oauth/par`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: metaClientId,
        response_type: "code",
        redirect_uri: "http://127.0.0.1:54321/callback?mode=popup",
        scope: adminScopeStr,
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
      }).toString(),
    });
    assert.equal(matchingQueryParRes.status, 201, "Exact query match on dynamic loopback port must succeed");

    // 3. Family revocation bound to authenticated client + DPoP key (wrong caller CANNOT cascade victim's family!)
    const victimRedirectUri = "http://127.0.0.1:43123/callback";
    const victimClientId = `http://localhost?redirect_uri=${encodeURIComponent(victimRedirectUri)}&scope=${encodeURIComponent(adminScopeStr)}`;
    const victimFlow = await completeGroupOAuthFlow({
      groupHost: gh,
      pds,
      user: alice,
      scope: adminScopeStr,
      clientId: victimClientId,
      redirectUri: victimRedirectUri,
      prompt: "create",
      createParams: { displayName: "Victim Group", handle: "victim.groups.localhost" },
    });
    const victimDpop = victimFlow.dpop;
    const groupDid = victimFlow.tokenResponse!.sub;
    const consumedCode = new URL(victimFlow.redirectLocation).searchParams.get("code")!;
    const rt1 = victimFlow.tokenResponse!.refresh_token!;

    // Rotate `rt1 -> rt2`
    const rotRes = await victimDpop.fetchWithDpop(`${gh.url}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: victimClientId,
        refresh_token: rt1,
      }).toString(),
    });
    assert.equal(rotRes.status, 200);
    const rotBody = (await rotRes.json()) as { access_token: string; refresh_token: string };
    const liveAccessTok = rotBody.access_token;
    const liveRefreshTok = rotBody.refresh_token;

    // Unrelated attacker DPoP client tries replaying `consumedCode` & `rt1`, and calling `/oauth/revoke` with forged & stolen tokens!
    const attackerDpop = await createDpopTestClient();

    const attackerCodeReplay = await attackerDpop.fetchWithDpop(`${gh.url}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: victimClientId,
        code: consumedCode,
        code_verifier: createPkcePair().verifier,
        redirect_uri: victimRedirectUri,
      }).toString(),
    });
    assert.equal(attackerCodeReplay.status, 400);

    const attackerRefreshReplay = await attackerDpop.fetchWithDpop(`${gh.url}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: victimClientId,
        refresh_token: rt1,
      }).toString(),
    });
    assert.equal(attackerRefreshReplay.status, 400);

    // Forged JWT carrying victim's `fid`/`sub`/`sid` signed with attacker's key
    const decodedVictim = jose.decodeJwt(liveAccessTok);
    const forgedKey = await jose.generateKeyPair("ES256");
    const forgedJwt = await new jose.SignJWT({
      ...decodedVictim,
      cnf: { jkt: attackerDpop.dpopJkt },
    })
      .setProtectedHeader({ typ: "at+jwt", alg: "ES256" })
      .sign(forgedKey.privateKey);

    const forgedRevoke = await attackerDpop.fetchWithDpop(`${gh.url}/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: victimClientId, token: forgedJwt }).toString(),
    });
    assert.equal(forgedRevoke.status, 200);

    const stolenRefreshRevoke = await attackerDpop.fetchWithDpop(`${gh.url}/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: victimClientId, token: liveRefreshTok }).toString(),
    });
    assert.equal(stolenRefreshRevoke.status, 400);

    const stolenAccessRevoke = await attackerDpop.fetchWithDpop(`${gh.url}/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: victimClientId, token: liveAccessTok }).toString(),
    });
    assert.equal(stolenAccessRevoke.status, 400);

    // Victim's live session MUST STILL BE ACTIVE!
    const checkVictimAlive = await victimDpop.fetchWithDpop(
      `${gh.url}/xrpc/com.atproto.server.checkAccountStatus`,
      { method: "GET", accessToken: liveAccessTok },
    );
    assert.equal(checkVictimAlive.status, 200, "Victim OAuth family must survive wrong-client/wrong-DPoP attacks");

    // 4. Two concurrent `/oauth/confirm-action` flows share one browser cookie jar (`gh_consent_<hash>`) without clobbering!
    const startToConfirm = async () => {
      const d = await createDpopTestClient();
      const p = createPkcePair();
      const par = await d.fetchWithDpop(`${gh.url}/oauth/par`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: metaClientId,
          response_type: "code",
          redirect_uri: "http://127.0.0.1:54321/callback?mode=popup",
          scope: adminScopeStr,
          code_challenge: p.challenge,
          code_challenge_method: "S256",
          login_hint: groupDid,
          prompt: "consent",
        }).toString(),
      });
      const { request_uri } = (await par.json()) as { request_uri: string };
      const authHtml = await (
        await fetch(
          `${gh.url}/oauth/authorize?client_id=${encodeURIComponent(metaClientId)}&request_uri=${encodeURIComponent(request_uri)}`,
        )
      ).text();
      const authCsrf = /name="csrf_token"\s+value="([^"]+)"/.exec(authHtml)![1]!;
      const postAuth = await fetch(`${gh.url}/oauth/authorize`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: metaClientId,
          request_uri,
          csrf_token: authCsrf,
          actor: alice.did,
          decision: "approve",
        }).toString(),
        redirect: "manual",
      });
      const flowCookie = postAuth.headers.getSetCookie().map((c) => c.split(";")[0]!).join("; ");
      const upAuth = new URL(postAuth.headers.get("location")!);
      upAuth.searchParams.set("as_did", alice.did);
      const pdsCb = (await fetch(upAuth.toString(), { redirect: "manual" })).headers.get("location")!;
      const ghCb = await fetch(pdsCb, { headers: { cookie: flowCookie }, redirect: "manual" });
      const setConsent = ghCb.headers
        .getSetCookie()
        .filter((c) => !c.includes("Max-Age=0"))
        .map((c) => c.split(";")[0]!)
        .join("; ");
      return { confirmUrl: ghCb.headers.get("location")!, consentCookie: setConsent };
    };

    const tab1 = await startToConfirm();
    const tab2 = await startToConfirm();
    assert.notEqual(
      tab1.consentCookie.split("=")[0],
      tab2.consentCookie.split("=")[0],
      "Concurrent confirm-action flows must use distinct gh_consent_<hash> cookie names",
    );
    const sharedBrowserCookies = `${tab1.consentCookie}; ${tab2.consentCookie}`;

    const html1 = await (await fetch(tab1.confirmUrl, { headers: { cookie: sharedBrowserCookies } })).text();
    const html2 = await (await fetch(tab2.confirmUrl, { headers: { cookie: sharedBrowserCookies } })).text();
    const csrf1 = /name="csrf_token"\s+value="([^"]+)"/.exec(html1)![1]!;
    const csrf2 = /name="csrf_token"\s+value="([^"]+)"/.exec(html2)![1]!;

    const approve1 = await fetch(`${gh.url}/oauth/confirm-action`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: sharedBrowserCookies },
      body: new URLSearchParams({ csrf_token: csrf1, decision: "approve" }).toString(),
      redirect: "manual",
    });
    const approve2 = await fetch(`${gh.url}/oauth/confirm-action`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: sharedBrowserCookies },
      body: new URLSearchParams({ csrf_token: csrf2, decision: "approve" }).toString(),
      redirect: "manual",
    });
    assert.equal(approve1.status, 303);
    assert.equal(approve2.status, 303);
    assert.ok(new URL(approve1.headers.get("location")!).searchParams.get("code"));
    assert.ok(new URL(approve2.headers.get("location")!).searchParams.get("code"));

    // 5. Stale `group_creation_journal` PLC compensation preserves handle & rotation key on PLC 500, retries 409, and tombstones!
    const staleSig = await P256Keypair.create({ exportable: true });
    const staleKem = await P256Keypair.create({ exportable: true });
    const staleRot = await P256Keypair.create({ exportable: true });
    const staleHandle = "stale-comp.groups.localhost";
    const { did: staleDid, genesisOp } = await createGroupGenesisPlcOp({
      signingKey: staleSig,
      kemKey: staleKem,
      rotationKey: staleRot,
      handle: staleHandle,
      pdsEndpoint: gh.url,
    });
    const pubGenRes = await fetch(`${plc.url}/${encodeURIComponent(staleDid)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(genesisOp),
    });
    assert.equal(pubGenRes.status, 200);

    const creationKey = "ck-comp-1";
    const rowKey = `${alice.did}:http://localhost:${creationKey}`;
    const rotEnc = await gh.cryptoBox.encryptKeypair(
      "group_creation_journal",
      rowKey,
      "rotation_key_enc",
      staleRot,
    );
    const staleTime = Date.now() - 20 * 60_000;
    gh.db
      .prepare("INSERT INTO handle_reservation (handle, group_did, created_at) VALUES (?, ?, ?)")
      .run(staleHandle, staleDid, staleTime);
    gh.db
      .prepare(
        `INSERT INTO group_creation_journal (
           initiator_did, client_id, creation_key, group_did, handle, display_name, join_policy, public_meta,
           rotation_key_enc, genesis_op_json, status, created_at, updated_at
         ) VALUES (?, 'http://localhost', ?, ?, ?, 'Stale', 'invite', 1, ?, '{}', 'plc_published', ?, ?)`,
      )
      .run(alice.did, creationKey, staleDid, staleHandle, rotEnc, staleTime, staleTime);

    // (a) PLC returns 500 -> compensation MUST NOT release handle or wipe rotation_key_enc!
    plc.interceptPost = (did) => (did === staleDid ? { status: 500, body: { message: "PLC down" } } : null);
    await gh.oauth.compensateStaleCreationJournals();

    const journalAfter500 = gh.db
      .prepare("SELECT status, rotation_key_enc FROM group_creation_journal WHERE creation_key = ?")
      .get(creationKey) as { status: string; rotation_key_enc: string | null };
    assert.equal(journalAfter500.status, "plc_published");
    assert.ok(journalAfter500.rotation_key_enc, "rotation_key_enc must be retained when PLC tombstone fails");
    assert.ok(
      gh.db.prepare("SELECT 1 FROM handle_reservation WHERE handle = ?").get(staleHandle),
      "handle_reservation must be retained when PLC tombstone fails",
    );

    // (b) PLC returns 409 once, then succeeds on retry -> tombstones DID (410), releases handle, marks compensated!
    let sawFirst409 = false;
    plc.interceptPost = (did) => {
      if (did === staleDid && !sawFirst409) {
        sawFirst409 = true;
        return { status: 409, body: { message: "Simulated stale prev conflict" } };
      }
      return null;
    };
    await gh.oauth.compensateStaleCreationJournals();
    plc.interceptPost = undefined;
    assert.equal(sawFirst409, true);

    const plcAfterComp = await fetch(`${plc.url}/${encodeURIComponent(staleDid)}`);
    assert.equal(plcAfterComp.status, 410, "Compensated genesis DID must be tombstoned on PLC after 409 retry");
    assert.equal(
      gh.db.prepare("SELECT 1 FROM handle_reservation WHERE handle = ?").get(staleHandle),
      undefined,
      "handle_reservation must be released after verified PLC tombstone",
    );
    const journalAfterOk = gh.db
      .prepare("SELECT status, rotation_key_enc FROM group_creation_journal WHERE creation_key = ?")
      .get(creationKey) as { status: string; rotation_key_enc: string | null };
    assert.equal(journalAfterOk.status, "compensated");
    assert.equal(journalAfterOk.rotation_key_enc, null);

    // 6. Round 16 Fix #1:
    //    (a) Retrying a stale `plc_published` journal concurrently with `compensateStaleCreationJournals` serializes under
    //        `create:<rowKey> -> <groupDid>` so `group_account` is NEVER committed for a tombstoned PLC DID!
    const raceCreationKey = "ck-r16-race-1";
    const raceRedirectUri = "http://127.0.0.1:43123/callback";
    const raceScope = groupAdminScopes().join(" ");
    const raceClientId = `http://localhost?redirect_uri=${encodeURIComponent(raceRedirectUri)}&scope=${encodeURIComponent(raceScope)}`;
    const raceRowKey = `${alice.did}:${raceClientId}:${raceCreationKey}`;
    const raceSig = await P256Keypair.create({ exportable: true });
    const raceKem = await P256Keypair.create({ exportable: true });
    const raceRot = await P256Keypair.create({ exportable: true });
    const raceHandle = "r16-race.groups.localhost";
    const { did: raceDid, genesisOp: raceGenesis } = await createGroupGenesisPlcOp({
      signingKey: raceSig,
      kemKey: raceKem,
      rotationKey: raceRot,
      handle: raceHandle,
      pdsEndpoint: gh.url,
    });
    const pubRaceRes = await fetch(`${plc.url}/${encodeURIComponent(raceDid)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(raceGenesis),
    });
    assert.equal(pubRaceRes.status, 200);

    const [raceSigEnc, raceKemEnc, raceRotEnc] = await Promise.all([
      gh.cryptoBox.encryptKeypair("group_creation_journal", raceRowKey, "signing_key_enc", raceSig),
      gh.cryptoBox.encryptKeypair("group_creation_journal", raceRowKey, "kem_key_enc", raceKem),
      gh.cryptoBox.encryptKeypair("group_creation_journal", raceRowKey, "rotation_key_enc", raceRot),
    ]);
    const raceStaleTime = Date.now() - 20 * 60_000;
    gh.db
      .prepare("INSERT INTO handle_reservation (handle, group_did, created_at) VALUES (?, ?, ?)")
      .run(raceHandle, raceDid, raceStaleTime);
    gh.db
      .prepare(
        `INSERT INTO group_creation_journal (
           initiator_did, client_id, creation_key, group_did, handle, display_name, join_policy, public_meta,
           signing_key_enc, kem_key_enc, rotation_key_enc, genesis_op_json, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'R16 Race Team', 'invite', 1, ?, ?, ?, ?, 'plc_published', ?, ?)`,
      )
      .run(
        alice.did,
        raceClientId,
        raceCreationKey,
        raceDid,
        raceHandle,
        raceSigEnc,
        raceKemEnc,
        raceRotEnc,
        JSON.stringify(raceGenesis),
        raceStaleTime,
        raceStaleTime,
      );

    const [raceFlow] = await Promise.all([
      completeGroupOAuthFlow({
        groupHost: gh,
        pds,
        user: alice,
        clientId: raceClientId,
        redirectUri: raceRedirectUri,
        scope: raceScope,
        prompt: "create",
        createParams: {
          creationKey: raceCreationKey,
          displayName: "R16 Race Team",
          handle: raceHandle,
          joinPolicy: "invite",
          publicMeta: true,
        },
      }),
      gh.oauth.compensateStaleCreationJournals(),
    ]);
    const committedRaceDid = raceFlow.tokenResponse!.sub;
    const livePlcDocRes = await fetch(`${plc.url}/${encodeURIComponent(committedRaceDid)}`);
    assert.equal(
      livePlcDocRes.status,
      200,
      "Activated group_account from concurrent stale retry + sweep MUST resolve 200 on PLC (never tombstoned)",
    );

    //    (b) Crash recovery where a prior sweep tombstoned `crashedDid` on PLC (`410`) BEFORE updating SQLite:
    //        retrying `completeGroupOAuthFlow` detects `plc_tombstone`, releases the tombstoned attempt, and mints a fresh live DID!
    const crashedCreationKey = "ck-r16-crashed-tombstone";
    const crashedRowKey = `${alice.did}:${raceClientId}:${crashedCreationKey}`;
    const cSig = await P256Keypair.create({ exportable: true });
    const cKem = await P256Keypair.create({ exportable: true });
    const cRot = await P256Keypair.create({ exportable: true });
    const cHandle = "r16-crashed.groups.localhost";
    const { did: crashedDid, genesisOp: cGenesis } = await createGroupGenesisPlcOp({
      signingKey: cSig,
      kemKey: cKem,
      rotationKey: cRot,
      handle: cHandle,
      pdsEndpoint: gh.url,
    });
    assert.equal(
      (
        await fetch(`${plc.url}/${encodeURIComponent(crashedDid)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(cGenesis),
        })
      ).status,
      200,
    );
    const cGenesisCid = await plcCidForOp(cGenesis);
    const cTomb = await tombstoneOp(cGenesisCid, cRot);
    assert.equal(
      (
        await fetch(`${plc.url}/${encodeURIComponent(crashedDid)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(cTomb),
        })
      ).status,
      200,
    );
    assert.equal((await fetch(`${plc.url}/${encodeURIComponent(crashedDid)}`)).status, 410);

    const [cSigEnc, cKemEnc, cRotEnc] = await Promise.all([
      gh.cryptoBox.encryptKeypair("group_creation_journal", crashedRowKey, "signing_key_enc", cSig),
      gh.cryptoBox.encryptKeypair("group_creation_journal", crashedRowKey, "kem_key_enc", cKem),
      gh.cryptoBox.encryptKeypair("group_creation_journal", crashedRowKey, "rotation_key_enc", cRot),
    ]);
    gh.db
      .prepare("INSERT INTO handle_reservation (handle, group_did, created_at) VALUES (?, ?, ?)")
      .run(cHandle, crashedDid, raceStaleTime);
    gh.db
      .prepare(
        `INSERT INTO group_creation_journal (
           initiator_did, client_id, creation_key, group_did, handle, display_name, join_policy, public_meta,
           signing_key_enc, kem_key_enc, rotation_key_enc, genesis_op_json, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'R16 Recovered Team', 'invite', 1, ?, ?, ?, ?, 'plc_published', ?, ?)`,
      )
      .run(
        alice.did,
        raceClientId,
        crashedCreationKey,
        crashedDid,
        cHandle,
        cSigEnc,
        cKemEnc,
        cRotEnc,
        JSON.stringify(cGenesis),
        raceStaleTime,
        raceStaleTime,
      );

    const recoveredFlow = await completeGroupOAuthFlow({
      groupHost: gh,
      pds,
      user: alice,
      clientId: raceClientId,
      redirectUri: raceRedirectUri,
      scope: raceScope,
      prompt: "create",
      createParams: {
        creationKey: crashedCreationKey,
        displayName: "R16 Recovered Team",
        handle: cHandle,
        joinPolicy: "invite",
        publicMeta: true,
      },
    });
    const regeneratedDid = recoveredFlow.tokenResponse!.sub;
    assert.notEqual(regeneratedDid, crashedDid, "Tombstoned stale journal DID must be regenerated");
    assert.equal(
      gh.db.prepare("SELECT 1 FROM group_account WHERE did = ?").get(crashedDid),
      undefined,
      "Tombstoned DID must never be inserted into group_account",
    );
    assert.equal((await fetch(`${plc.url}/${encodeURIComponent(regeneratedDid)}`)).status, 200);

    // 7. Round 22 Fix #1: Stale `group_creation_journal` compensation with missing/empty `rotation_key_enc`
    //    MUST retain journal + handle_reservation when PLC DID is still live, while compensating cleanly when PLC is absent/tombstoned!
    for (const missingRot of [null, ""] as const) {
      const mSig = await P256Keypair.create({ exportable: true });
      const mKem = await P256Keypair.create({ exportable: true });
      const mRot = await P256Keypair.create({ exportable: true });
      const suffix = missingRot === null ? "null" : "empty";
      const mHandle = `r22-missing-rot-${suffix}.groups.localhost`;
      const { did: mDid, genesisOp: mGen } = await createGroupGenesisPlcOp({
        signingKey: mSig,
        kemKey: mKem,
        rotationKey: mRot,
        handle: mHandle,
        pdsEndpoint: gh.url,
      });
      assert.equal(
        (
          await fetch(`${plc.url}/${encodeURIComponent(mDid)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(mGen),
          })
        ).status,
        200,
      );
      const mKey = `ck-r22-missing-${suffix}`;
      gh.db
        .prepare("INSERT INTO handle_reservation (handle, group_did, created_at) VALUES (?, ?, ?)")
        .run(mHandle, mDid, raceStaleTime);
      gh.db
        .prepare(
          `INSERT INTO group_creation_journal (
             initiator_did, client_id, creation_key, group_did, handle, display_name, join_policy, public_meta,
             rotation_key_enc, genesis_op_json, status, created_at, updated_at
           ) VALUES (?, 'http://localhost', ?, ?, ?, 'R22 Missing Rot', 'invite', 1, ?, '{}', 'plc_published', ?, ?)`,
        )
        .run(alice.did, mKey, mDid, mHandle, missingRot, raceStaleTime, raceStaleTime);

      await gh.oauth.compensateStaleCreationJournals();

      const retainedRow = gh.db
        .prepare("SELECT status FROM group_creation_journal WHERE creation_key = ?")
        .get(mKey) as { status: string };
      assert.equal(
        retainedRow.status,
        "plc_published",
        `stale journal with live PLC DID and rotation_key_enc=${JSON.stringify(missingRot)} MUST NOT fail open to compensated`,
      );
      assert.ok(
        gh.db.prepare("SELECT 1 FROM handle_reservation WHERE handle = ?").get(mHandle),
        `handle_reservation MUST be retained when live PLC DID cannot be tombstoned (rotation_key_enc=${JSON.stringify(missingRot)})`,
      );
    }

    // Conversely, an unpublished `pending_plc` DID (`404` on PLC) with `rotation_key_enc = null` DOES prove PLC absence and compensates cleanly!
    const unpubHandle = "r22-unpub-null.groups.localhost";
    const unpubDid = "did:plc:r22unpubabsentdidaaaaaaa";
    gh.db
      .prepare("INSERT INTO handle_reservation (handle, group_did, created_at) VALUES (?, ?, ?)")
      .run(unpubHandle, unpubDid, raceStaleTime);
    gh.db
      .prepare(
        `INSERT INTO group_creation_journal (
           initiator_did, client_id, creation_key, group_did, handle, display_name, join_policy, public_meta,
           rotation_key_enc, genesis_op_json, status, created_at, updated_at
         ) VALUES (?, 'http://localhost', 'ck-r22-unpub-null', ?, ?, 'R22 Unpub', 'invite', 1, NULL, '{}', 'pending_plc', ?, ?)`,
      )
      .run(alice.did, unpubDid, unpubHandle, raceStaleTime, raceStaleTime);

    await gh.oauth.compensateStaleCreationJournals();
    assert.equal(
      (
        gh.db
          .prepare("SELECT status FROM group_creation_journal WHERE creation_key = 'ck-r22-unpub-null'")
          .get() as { status: string }
      ).status,
      "compensated",
    );
    assert.equal(gh.db.prepare("SELECT 1 FROM handle_reservation WHERE handle = ?").get(unpubHandle), undefined);

    // 8. Round 23 Fix #1: Tombstone POST `404` (both initial POST `404` and `409`-then-retry POST `404`)
    //    MUST NOT fail open when GET observed a live PLC DID — retains journal, `rotation_key_enc`, and `handle_reservation`
    //    until a subsequent tombstone POST succeeds (`2xx`) or GET proves absence/tombstoning!
    const seedLiveStaleJournal = async (tag: string) => {
      const kSig = await P256Keypair.create({ exportable: true });
      const kKem = await P256Keypair.create({ exportable: true });
      const kRot = await P256Keypair.create({ exportable: true });
      const jHandle = `r23-${tag}.groups.localhost`;
      const { did: jDid, genesisOp: jGen } = await createGroupGenesisPlcOp({
        signingKey: kSig,
        kemKey: kKem,
        rotationKey: kRot,
        handle: jHandle,
        pdsEndpoint: gh.url,
      });
      assert.equal(
        (
          await fetch(`${plc.url}/${encodeURIComponent(jDid)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(jGen),
          })
        ).status,
        200,
      );
      const jCreationKey = `ck-r23-${tag}`;
      const jRowKey = `${alice.did}:${raceClientId}:${jCreationKey}`;
      const [jSigEnc, jKemEnc, jRotEnc] = await Promise.all([
        gh.cryptoBox.encryptKeypair("group_creation_journal", jRowKey, "signing_key_enc", kSig),
        gh.cryptoBox.encryptKeypair("group_creation_journal", jRowKey, "kem_key_enc", kKem),
        gh.cryptoBox.encryptKeypair("group_creation_journal", jRowKey, "rotation_key_enc", kRot),
      ]);
      gh.db
        .prepare("INSERT INTO handle_reservation (handle, group_did, created_at) VALUES (?, ?, ?)")
        .run(jHandle, jDid, raceStaleTime);
      gh.db
        .prepare(
          `INSERT INTO group_creation_journal (
             initiator_did, client_id, creation_key, group_did, handle, display_name, join_policy, public_meta,
             signing_key_enc, kem_key_enc, rotation_key_enc, genesis_op_json, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'R23 Post 404', 'invite', 1, ?, ?, ?, ?, 'plc_published', ?, ?)`,
        )
        .run(
          alice.did,
          raceClientId,
          jCreationKey,
          jDid,
          jHandle,
          jSigEnc,
          jKemEnc,
          jRotEnc,
          JSON.stringify(jGen),
          raceStaleTime,
          raceStaleTime,
        );
      return { jDid, jHandle, jCreationKey };
    };

    const post404Initial = await seedLiveStaleJournal("init-404");
    const post404Retry = await seedLiveStaleJournal("retry-404");
    let retryPostCalls = 0;
    plc.interceptPost = (did, op) => {
      if (op.type !== "plc_tombstone") return null;
      if (did === post404Initial.jDid) {
        return { status: 404, body: { message: "Simulated proxy 404 on initial tombstone POST" } };
      }
      if (did === post404Retry.jDid) {
        retryPostCalls += 1;
        if (retryPostCalls === 1) {
          return { status: 409, body: { message: "Simulated 409 conflict before retry POST 404" } };
        }
        return { status: 404, body: { message: "Simulated proxy 404 on retry tombstone POST" } };
      }
      return null;
    };

    try {
      await gh.oauth.compensateStaleCreationJournals();
    } finally {
      plc.interceptPost = undefined;
    }
    assert.equal(retryPostCalls, 2, "409 tombstone response must re-read PLC and issue retry POST before hitting 404");

    for (const item of [post404Initial, post404Retry]) {
      const row = gh.db
        .prepare("SELECT status, rotation_key_enc FROM group_creation_journal WHERE creation_key = ?")
        .get(item.jCreationKey) as { status: string; rotation_key_enc: string | null };
      assert.equal(row.status, "plc_published", `${item.jCreationKey} must retain plc_published after POST 404`);
      assert.ok(row.rotation_key_enc, `${item.jCreationKey} must retain rotation_key_enc after POST 404`);
      assert.ok(
        gh.db.prepare("SELECT 1 FROM handle_reservation WHERE handle = ?").get(item.jHandle),
        `${item.jCreationKey} must retain handle_reservation after POST 404`,
      );
      assert.equal((await fetch(`${plc.url}/${encodeURIComponent(item.jDid)}`)).status, 200);
    }

    // Once transient POST 404 clears, subsequent sweep uses the retained `rotation_key_enc` to tombstone & compensate cleanly!
    await gh.oauth.compensateStaleCreationJournals();
    for (const item of [post404Initial, post404Retry]) {
      const row = gh.db
        .prepare("SELECT status, rotation_key_enc FROM group_creation_journal WHERE creation_key = ?")
        .get(item.jCreationKey) as { status: string; rotation_key_enc: string | null };
      assert.equal(row.status, "compensated");
      assert.equal(row.rotation_key_enc, null);
      assert.equal(gh.db.prepare("SELECT 1 FROM handle_reservation WHERE handle = ?").get(item.jHandle), undefined);
      assert.equal((await fetch(`${plc.url}/${encodeURIComponent(item.jDid)}`)).status, 410);
    }

    // 9. Concurrent resumer arriving while Resumer 1's `status === 'code_issued'` `oauth_code` is still unconsumed
    //    MUST NOT receive Resumer 1's PKCE/DPoP-bound `auth_code` — pivots to `/oauth/confirm-action` for its own code
    //    so BOTH Resumer 1 and Resumer 2 redeem `/oauth/token` cleanly without cross-PAR code replay or family revocation!
    const codeIssuedRaceKey = `ck-r23-code-issued-race-${randomUUID()}`;
    const codeIssuedHandle = "r23-code-issued-race.groups.localhost";
    const dpopR1 = await createDpopTestClient();
    const pkceR1 = createPkcePair();
    const parR1Res = await dpopR1.fetchWithDpop(`${gh.url}/oauth/par`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: raceClientId,
        redirect_uri: raceRedirectUri,
        response_type: "code",
        code_challenge: pkceR1.challenge,
        code_challenge_method: "S256",
        scope: raceScope,
        prompt: "create",
        creation_key: codeIssuedRaceKey,
        state: "state-r1",
      }).toString(),
    });
    assert.equal(parR1Res.status, 201);
    const { request_uri: reqUriR1 } = (await parR1Res.json()) as { request_uri: string };
    const htmlR1 = await (
      await fetch(`${gh.url}/oauth/authorize?client_id=${encodeURIComponent(raceClientId)}&request_uri=${encodeURIComponent(reqUriR1)}`)
    ).text();
    const csrfR1 = /name="csrf_token"\s+value="([^"]+)"/.exec(htmlR1)![1]!;
    const authPostR1 = await fetch(`${gh.url}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: raceClientId,
        request_uri: reqUriR1,
        csrf_token: csrfR1,
        actor: alice.did,
        creation_key: codeIssuedRaceKey,
        display_name: "Code Issued Race Team",
        handle: codeIssuedHandle,
        join_policy: "invite",
        public_meta: "true",
        decision: "approve",
      }).toString(),
      redirect: "manual",
    });
    const cookieR1 = authPostR1.headers.getSetCookie().map((c) => c.split(";")[0]!).join("; ");
    const upR1 = new URL(authPostR1.headers.get("location")!);
    upR1.searchParams.set("as_did", alice.did);
    const pdsCbR1 = (await fetch(upR1.toString(), { redirect: "manual" })).headers.get("location")!;
    const ghCbR1 = await fetch(pdsCbR1, { headers: { cookie: cookieR1 }, redirect: "manual" });
    const codeR1 = new URL(ghCbR1.headers.get("location")!).searchParams.get("code")!;
    assert.ok(codeR1, "Resumer 1 must receive unconsumed codeR1 in code_issued state");

    // BEFORE Resumer 1 calls `/oauth/token`, Resumer 2 runs `completeGroupOAuthFlow` on the SAME `codeIssuedRaceKey` with fresh PKCE & DPoP!
    const resumer2Flow = await completeGroupOAuthFlow({
      groupHost: gh,
      pds,
      user: alice,
      clientId: raceClientId,
      redirectUri: raceRedirectUri,
      scope: raceScope,
      prompt: "create",
      createParams: {
        creationKey: codeIssuedRaceKey,
        displayName: "Code Issued Race Team",
        handle: codeIssuedHandle,
        joinPolicy: "invite",
        publicMeta: true,
      },
    });
    assert.ok(resumer2Flow.tokenResponse, "Resumer 2 must receive its own valid session");

    // Now Resumer 1 exchanges `codeR1` with `pkceR1.verifier` + `dpopR1` -> MUST ALSO SUCCEED (`200`)!
    const tokR1Res = await dpopR1.fetchWithDpop(`${gh.url}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: codeR1,
        redirect_uri: raceRedirectUri,
        client_id: raceClientId,
        code_verifier: pkceR1.verifier,
      }).toString(),
    });
    assert.equal(tokR1Res.status, 200, "Resumer 1 unconsumed codeR1 must remain redeemable after Resumer 2 completes");
    const tokR1 = (await tokR1Res.json()) as { access_token: string; sub: string };
    assert.equal(tokR1.sub, resumer2Flow.tokenResponse.sub, "Both resumers must bind to the exact same groupDid");

    // 10. Round 24 Fix #2: `code_issued` replay compares persisted `par_state` and `par_response_mode` directly!
    //     When registered `redirect_uri` contains `?state=r2`, a fragment-mode flow with `state=r1` MUST NOT replay
    //     to a query-mode sibling with `state=r2` even if PKCE and DPoP are identical!
    const queryRedir = "http://127.0.0.1:43998/cb?state=r2";
    const queryClientId = `http://localhost?redirect_uri=${encodeURIComponent(queryRedir)}&scope=${encodeURIComponent(raceScope)}`;
    const r24StateKey = `ck-r24-state-mode-${randomUUID()}`;
    const r24Handle = "r24-state-mode.groups.localhost";
    const dpopR24 = await createDpopTestClient();
    const pkceR24 = createPkcePair();

    const startCreatePar = async (responseMode: "fragment" | "query", stateVal: string) => {
      const pRes = await dpopR24.fetchWithDpop(`${gh.url}/oauth/par`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: queryClientId,
          redirect_uri: queryRedir,
          response_type: "code",
          response_mode: responseMode,
          code_challenge: pkceR24.challenge,
          code_challenge_method: "S256",
          scope: raceScope,
          prompt: "create",
          creation_key: r24StateKey,
          state: stateVal,
        }).toString(),
      });
      assert.equal(pRes.status, 201);
      const { request_uri: rUri } = (await pRes.json()) as { request_uri: string };
      const html = await (
        await fetch(`${gh.url}/oauth/authorize?client_id=${encodeURIComponent(queryClientId)}&request_uri=${encodeURIComponent(rUri)}`)
      ).text();
      const csrf = /name="csrf_token"\s+value="([^"]+)"/.exec(html)![1]!;
      const post = await fetch(`${gh.url}/oauth/authorize`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: queryClientId,
          request_uri: rUri,
          csrf_token: csrf,
          actor: alice.did,
          creation_key: r24StateKey,
          display_name: "R24 State Mode Team",
          handle: r24Handle,
          join_policy: "invite",
          public_meta: "true",
          decision: "approve",
        }).toString(),
        redirect: "manual",
      });
      const cookie = post.headers.getSetCookie().map((c) => c.split(";")[0]!).join("; ");
      const up = new URL(post.headers.get("location")!);
      up.searchParams.set("as_did", alice.did);
      const pdsCb = (await fetch(up.toString(), { redirect: "manual" })).headers.get("location")!;
      return fetch(pdsCb, { headers: { cookie }, redirect: "manual" });
    };

    const fragRes = await startCreatePar("fragment", "r1");
    assert.ok(fragRes.status >= 300 && fragRes.status < 400);
    const fragLoc = fragRes.headers.get("location")!;
    assert.ok(fragLoc.startsWith(`${queryRedir}#`), "Original fragment-mode creation redirects to fragment");
    const fragCode = new URLSearchParams(new URL(fragLoc).hash.replace(/^#/, "")).get("code");
    assert.ok(fragCode);

    // Sibling PAR with IDENTICAL PKCE & DPoP, `response_mode=query`, and `state=r2` (matching base query `?state=r2`!)
    // MUST NOT replay `fragLoc` — must pivot to `/oauth/confirm-action` instead!
    const querySiblingRes = await startCreatePar("query", "r2");
    assert.ok(querySiblingRes.status >= 300 && querySiblingRes.status < 400);
    const querySiblingLoc = querySiblingRes.headers.get("location")!;
    assert.ok(
      querySiblingLoc.startsWith(`${gh.url}/oauth/confirm-action`),
      `Query-mode sibling with state=r2 must pivot to /oauth/confirm-action rather than replaying fragment state=r1 code (got ${querySiblingLoc})`,
    );
  } finally {
    await new Promise<void>((resolve) => metaServer.close(() => resolve()));
    await gh.close();
    await pds.close();
    await plc.close();
  }
});
