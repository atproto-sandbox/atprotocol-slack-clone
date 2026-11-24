import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NodeSavedSession } from "@atproto/oauth-client-node";
import type { AuthorityCallbackDeps } from "./authority-grant";
import test from "node:test";

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "authority-grant-test-")), "app.db");
process.env.AUTH_ENCRYPTION_KEY = "3c".repeat(32);
process.env.APP_URL = "http://127.0.0.1:3000";
process.env.OPERATOR_SERVICE_REF = "did:web:localhost%3A3000#atproto_flock_operator";

const AUTHORITY = "did:plc:authority";
const OTHER = "did:plc:someoneelse";
const KEY = Buffer.from("3c".repeat(32), "hex");

const [grant, flow, { oauthSqliteStore }, { getRawDb }] = await Promise.all([
  import("./authority-grant"), import("../auth/oauth-flow"), import("../auth/encrypted-store"), import("../lib/db"),
]);

function savedSession(label: string): NodeSavedSession {
  return { dpopJwk: { kty: "EC", label }, authMethod: { method: "none" }, tokenSet: { sub: AUTHORITY, access_token: label } } as unknown as NodeSavedSession;
}

/** A callback as the OAuth client completes it: the session lands in the staged store, under the account that signed in. */
function fakeCallback(signedInAs: string, appState: string, label: string, signOuts: string[]): AuthorityCallbackDeps["callbackClient"] {
  return async (staged) => ({
    async callback() {
      staged.set(signedInAs, savedSession(label));
      return { session: { did: signedInAs, signOut: async () => { staged.delete(signedInAs); signOuts.push(label); } }, state: appState };
    },
  });
}

function boundFlow(options: { expectedDid?: string; initiatorDid?: string; expiresAt?: number } = {}): { params: URLSearchParams; cookie: string; appState: string } {
  const state = flow.createOAuthFlowState();
  const appState = flow.createOAuthFlowState();
  const cookie = flow.createOAuthFlowCookieValue(state, {
    kind: "authority",
    expectedDid: options.expectedDid ?? AUTHORITY,
    initiatorDid: options.initiatorDid ?? AUTHORITY,
    purpose: { kind: "createWorkspace", name: "Acme" },
    expiresAt: options.expiresAt ?? Math.floor(Date.now() / 1000) + 900,
    appState,
  }, KEY);
  return { params: new URLSearchParams({ state, code: "code", iss: "https://pds.test" }), cookie, appState };
}

function storedGrant(did: string): Promise<NodeSavedSession | undefined> {
  return oauthSqliteStore<NodeSavedSession>("authority_grant").get(did);
}

test("a ticket starts at most one flow", () => {
  // given a ticket for the authority
  const ticket = grant.issueAuthorityTicket({ initiatorDid: AUTHORITY, authorityDid: AUTHORITY, purpose: { kind: "reauthorize" } });

  // when it is consumed twice
  const first = grant.consumeAuthorityTicket(ticket);
  const second = grant.consumeAuthorityTicket(ticket);

  // then only the first succeeds
  assert.deepEqual(first, { initiatorDid: AUTHORITY, authorityDid: AUTHORITY, purpose: { kind: "reauthorize" } });
  assert.equal(second, null);
});

test("a ticket expires after two minutes", () => {
  // given a ticket issued now
  const now = 1_000_000;
  const ticket = grant.issueAuthorityTicket({ initiatorDid: AUTHORITY, authorityDid: AUTHORITY, purpose: { kind: "reauthorize" } }, now);

  // when it is used two minutes later
  const late = grant.consumeAuthorityTicket(ticket, now + 120);

  // then it is refused
  assert.equal(late, null);
});

test("someone else may ask for a workspace account's approval: the ticket keeps who asked apart from the account", () => {
  const ticket = grant.issueAuthorityTicket({ initiatorDid: OTHER, authorityDid: AUTHORITY, purpose: { kind: "createWorkspace", name: "Acme" } });
  assert.deepEqual(grant.consumeAuthorityTicket(ticket), { initiatorDid: OTHER, authorityDid: AUTHORITY, purpose: { kind: "createWorkspace", name: "Acme" } });
});

const creationAuthorizations = () => getRawDb().prepare("SELECT authority_did, initiator_did, name, operation_id FROM creation_authorization ORDER BY initiator_did")
  .all() as Array<{ authority_did: string; initiator_did: string; name: string; operation_id: string | null }>;

test("a creation flow someone else started leaves them an approval of that one workspace; the account's own flow leaves none", async () => {
  getRawDb().prepare("DELETE FROM creation_authorization").run();

  // given a creation flow the workspace account started for itself, completed
  const own = boundFlow();
  await grant.completeAuthorityFlow(own.params, own.cookie, { callbackClient: fakeCallback(AUTHORITY, own.appState, "own", []), persistGrant: grant.persistAuthorityGrant });

  // then it needs only the grant: no approval is written
  assert.deepEqual(creationAuthorizations(), []);

  // when someone else starts one for the account, and someone who can sign in as the account approves it
  const theirs = boundFlow({ initiatorDid: OTHER });
  const completed = await grant.completeAuthorityFlow(theirs.params, theirs.cookie, { callbackClient: fakeCallback(AUTHORITY, theirs.appState, "theirs", []), persistGrant: grant.persistAuthorityGrant });

  // then the grant is the account's, and the one approval is theirs, for that name, for any one operation
  assert.deepEqual(completed, { authorityDid: AUTHORITY, initiatorDid: OTHER, purpose: { kind: "createWorkspace", name: "Acme" } });
  assert.equal((await storedGrant(AUTHORITY))?.tokenSet.access_token, "theirs");
  assert.deepEqual(creationAuthorizations(), [{ authority_did: AUTHORITY, initiator_did: OTHER, name: "Acme", operation_id: null }]);

  // when the creation flow carries a creationKey, the stored creation_authorization is bound to that exact operation_id
  getRawDb().prepare("DELETE FROM creation_authorization").run();
  const state = flow.createOAuthFlowState();
  const appState = flow.createOAuthFlowState();
  const boundCookie = flow.createOAuthFlowCookieValue(state, {
    kind: "authority",
    expectedDid: AUTHORITY,
    initiatorDid: OTHER,
    purpose: { kind: "createWorkspace", name: "Acme", creationKey: "3lblcreateop01" },
    expiresAt: Math.floor(Date.now() / 1000) + 900,
    appState,
  }, KEY);
  await grant.completeAuthorityFlow(new URLSearchParams({ state, code: "code", iss: "https://pds.test" }), boundCookie, {
    callbackClient: fakeCallback(AUTHORITY, appState, "bound", []),
    persistGrant: grant.persistAuthorityGrant,
  });
  assert.deepEqual(creationAuthorizations(), [{ authority_did: AUTHORITY, initiator_did: OTHER, name: "Acme", operation_id: "3lblcreateop01" }]);
});

test("a creation flow someone else started, approved by the wrong account, leaves them no approval", async () => {
  getRawDb().prepare("DELETE FROM creation_authorization").run();
  const theirs = boundFlow({ initiatorDid: OTHER });
  await assert.rejects(grant.completeAuthorityFlow(theirs.params, theirs.cookie, {
    callbackClient: fakeCallback(OTHER, theirs.appState, "wrong", []), persistGrant: grant.persistAuthorityGrant,
  }), /different account/);
  assert.deepEqual(creationAuthorizations(), []);
});

test("a reauthorization someone else started grants nothing but the account's fresh session", async () => {
  getRawDb().prepare("DELETE FROM creation_authorization").run();
  const state = flow.createOAuthFlowState();
  const appState = flow.createOAuthFlowState();
  const cookie = flow.createOAuthFlowCookieValue(state, {
    kind: "authority", expectedDid: AUTHORITY, initiatorDid: OTHER, purpose: { kind: "reauthorize" },
    expiresAt: Math.floor(Date.now() / 1000) + 900, appState,
  }, KEY);
  await grant.completeAuthorityFlow(new URLSearchParams({ state, code: "code", iss: "https://pds.test" }), cookie, {
    callbackClient: fakeCallback(AUTHORITY, appState, "renewed", []), persistGrant: grant.persistAuthorityGrant,
  });
  assert.equal((await storedGrant(AUTHORITY))?.tokenSet.access_token, "renewed");
  assert.deepEqual(creationAuthorizations(), []);
});

test("a malformed or unknown ticket starts nothing", () => {
  assert.equal(grant.consumeAuthorityTicket("not-a-ticket"), null);
  assert.equal(grant.consumeAuthorityTicket("A".repeat(43)), null);
});

test("a callback in a browser without the flow cookie is rejected before the code is redeemed", async () => {
  // given a flow whose cookie this browser does not have
  const { params } = boundFlow();
  let redeemed = false;

  // when the callback arrives
  const attempt = grant.completeAuthorityFlow(params, undefined, {
    callbackClient: async () => ({ callback: async () => { redeemed = true; throw new Error("unreachable"); } }),
    persistGrant: async () => { throw new Error("unreachable"); },
  });

  // then it is refused and nothing is exchanged
  await assert.rejects(attempt, grant.AuthorityFlowError);
  assert.equal(redeemed, false);
});

test("a callback after the flow expired is rejected", async () => {
  // given a flow that expired a second ago
  const { params, cookie } = boundFlow({ expiresAt: Math.floor(Date.now() / 1000) - 1 });

  // when its callback arrives
  const attempt = grant.completeAuthorityFlow(params, cookie, { callbackClient: async () => { throw new Error("unreachable"); }, persistGrant: async () => undefined });

  // then it is refused
  await assert.rejects(attempt, /expired/);
});

test("approving as a different account revokes that session and stores no grant", async () => {
  // given a flow for the authority, approved at the PDS by another account
  const { params, cookie, appState } = boundFlow();
  const signOuts: string[] = [];
  const persisted: string[] = [];

  // when the callback completes
  const attempt = grant.completeAuthorityFlow(params, cookie, {
    callbackClient: fakeCallback(OTHER, appState, "wrong-account", signOuts),
    persistGrant: async (did) => { persisted.push(did); },
  });

  // then the flow fails, the other account's new session is revoked, and nothing is written
  await assert.rejects(attempt, /different account/);
  assert.deepEqual(signOuts, ["wrong-account"]);
  assert.deepEqual(persisted, []);
});

test("a callback whose app state belongs to another flow is rejected and its session revoked", async () => {
  // given this browser's cookie for one flow and a callback that returns another flow's app state
  const { params, cookie } = boundFlow();
  const signOuts: string[] = [];

  // when the callback completes
  const attempt = grant.completeAuthorityFlow(params, cookie, {
    callbackClient: fakeCallback(AUTHORITY, flow.createOAuthFlowState(), "foreign-state", signOuts),
    persistGrant: async () => { throw new Error("unreachable"); },
  });

  // then it is refused and the session revoked
  await assert.rejects(attempt, /does not match this browser flow/);
  assert.deepEqual(signOuts, ["foreign-state"]);
});

test("a completed flow stores the grant under the authority and reports who started it and why", async () => {
  // given a flow approved by the authority
  const { params, cookie, appState } = boundFlow();

  // when it completes
  const completed = await grant.completeAuthorityFlow(params, cookie, {
    callbackClient: fakeCallback(AUTHORITY, appState, "approved", []),
    persistGrant: grant.persistAuthorityGrant,
  });

  // then the grant row holds that session
  assert.deepEqual(completed, { authorityDid: AUTHORITY, initiatorDid: AUTHORITY, purpose: { kind: "createWorkspace", name: "Acme" } });
  assert.equal((await storedGrant(AUTHORITY))?.tokenSet.access_token, "approved");
  assert.equal(grant.hasAuthorityGrant(AUTHORITY), true);
});

test("two flows at once in one browser both complete, and leave one grant", async () => {
  // given two flows started in the same browser, each with its own cookie
  const first = boundFlow();
  const second = boundFlow();

  // when both callbacks complete at once
  const results = await Promise.all([
    grant.completeAuthorityFlow(first.params, first.cookie, { callbackClient: fakeCallback(AUTHORITY, first.appState, "first", []), persistGrant: grant.persistAuthorityGrant }),
    grant.completeAuthorityFlow(second.params, second.cookie, { callbackClient: fakeCallback(AUTHORITY, second.appState, "second", []), persistGrant: grant.persistAuthorityGrant }),
  ]);

  // then both succeed and exactly one grant row remains, holding one of the two sessions
  assert.equal(results.length, 2);
  const rows = getRawDb().prepare("SELECT key FROM authority_grant WHERE key = ?").all(AUTHORITY);
  assert.equal(rows.length, 1);
  assert.ok(["first", "second"].includes((await storedGrant(AUTHORITY))?.tokenSet.access_token ?? ""));
});

test("approving as a different account leaves that account's own grant exactly as it was", async () => {
  // given the other account already holds a grant
  await grant.persistAuthorityGrant(OTHER, savedSession("other-grant"));
  const before = getRawDb().prepare("SELECT value FROM authority_grant WHERE key = ?").get(OTHER);
  const { params, cookie, appState } = boundFlow();

  // when it approves this authority's flow (the client revokes any stored session of that account first, as the real one does)
  const attempt = grant.completeAuthorityFlow(params, cookie, {
    callbackClient: async (staged) => ({
      async callback() {
        staged.delete(OTHER);
        staged.set(OTHER, savedSession("wrong-account"));
        return { session: { did: OTHER, signOut: async () => { staged.delete(OTHER); } }, state: appState };
      },
    }),
    persistGrant: grant.persistAuthorityGrant,
  });

  // then the flow fails and the other account's grant row is byte for byte unchanged
  await assert.rejects(attempt, /different account/);
  assert.deepEqual(getRawDb().prepare("SELECT value FROM authority_grant WHERE key = ?").get(OTHER), before);
});

test("replacing a grant waits for a refresh that holds the grant's lock", async () => {
  // given a refresh of the current grant in flight, holding the OAuth client's lock for that DID
  await grant.persistAuthorityGrant(AUTHORITY, savedSession("before-refresh"));
  const { oauthSqliteRequestLock } = await import("../auth/oauth-request-lock");
  let finishRefresh: () => void = () => undefined;
  const refreshing = oauthSqliteRequestLock(`@atproto-oauth-client-${AUTHORITY}`, async () => {
    await new Promise<void>((resolve) => { finishRefresh = resolve; });
    await oauthSqliteStore<NodeSavedSession>("authority_grant").set(AUTHORITY, savedSession("refreshed"));
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  // when a new approval is written meanwhile
  const replacing = grant.persistAuthorityGrant(AUTHORITY, savedSession("replacement"));
  await new Promise((resolve) => setTimeout(resolve, 200));
  const duringRefresh = (await storedGrant(AUTHORITY))?.tokenSet.access_token;
  finishRefresh();
  await refreshing;
  await replacing;

  // then the replacement waited for the refresh, and the replacement is what remains
  assert.equal(duringRefresh, "before-refresh");
  assert.equal((await storedGrant(AUTHORITY))?.tokenSet.access_token, "replacement");
});

test("a replaced grant whose revocation fails is recorded, and the new grant stays", async () => {
  // given a stored grant whose revocation cannot succeed (its issuer is not reachable)
  await grant.persistAuthorityGrant(AUTHORITY, savedSession("unrevocable"));
  const before = (getRawDb().prepare("SELECT count(*) AS count FROM audit_event WHERE event = 'authorityGrantRevocationFailed'").get() as { count: number }).count;

  // when it is replaced
  await grant.persistAuthorityGrant(AUTHORITY, savedSession("successor"));

  // then the failure is in the audit trail and the successor is stored
  const after = (getRawDb().prepare("SELECT count(*) AS count FROM audit_event WHERE event = 'authorityGrantRevocationFailed'").get() as { count: number }).count;
  assert.equal(after, before + 1);
  assert.equal((await storedGrant(AUTHORITY))?.tokenSet.access_token, "successor");
});

test("revoking a grant deletes it even when its PDS cannot be reached, and says the sign-out failed", async () => {
  // given a stored grant whose PDS cannot be reached
  await grant.persistAuthorityGrant("did:plc:revoked", savedSession("to-revoke"));

  // when the operator revokes it
  const revocation = grant.revokeAuthorityGrant("did:plc:revoked");

  // then the sign-out failure is reported and the row is gone
  await assert.rejects(revocation);
  assert.equal(grant.hasAuthorityGrant("did:plc:revoked"), false);
});

test("revoking waits for a refresh that holds the grant's lock", async () => {
  // given a grant being refreshed under the OAuth client's lock
  await grant.persistAuthorityGrant("did:plc:locked", savedSession("locked"));
  const { oauthSqliteRequestLock } = await import("../auth/oauth-request-lock");
  let finishRefresh: () => void = () => undefined;
  const refreshing = oauthSqliteRequestLock("@atproto-oauth-client-did:plc:locked", () => new Promise<void>((resolve) => { finishRefresh = resolve; }));
  await new Promise((resolve) => setTimeout(resolve, 100));

  // when the operator revokes it meanwhile
  const revocation = grant.revokeAuthorityGrant("did:plc:locked").catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const presentDuringRefresh = grant.hasAuthorityGrant("did:plc:locked");
  finishRefresh();
  await refreshing;
  await revocation;

  // then the row stayed until the refresh finished, and is gone after
  assert.equal(presentDuringRefresh, true);
  assert.equal(grant.hasAuthorityGrant("did:plc:locked"), false);
});

test("an unreadable grant asks for reauthorization, is replaced by a new approval, and can be revoked", async () => {
  // given a grant row written under another encryption key
  const did = "did:plc:unreadable";
  const writeUnreadable = () => getRawDb().prepare("INSERT OR REPLACE INTO authority_grant (key, value, updated_at) VALUES (?, ?, ?)").run(did, "v1.AAAA.BBBB.CCCC", Date.now());
  writeUnreadable();

  // then restoring it asks for a new approval
  await assert.rejects(grant.restoreAuthorityGrant(did), grant.AuthorityReauthorizationRequiredError);

  // and a new approval replaces it
  await grant.persistAuthorityGrant(did, savedSession("readable-again"));
  assert.equal((await storedGrant(did))?.tokenSet.access_token, "readable-again");

  // and revoking an unreadable row deletes it, with no session to sign out
  writeUnreadable();
  assert.equal(await grant.revokeAuthorityGrant(did), "deleted");
  assert.equal(grant.hasAuthorityGrant(did), false);
});

test("a grant approved with a client key that is no longer configured asks for reauthorization and stays stored", async () => {
  // given a grant whose refreshes are signed with key "retired", which is no longer configured
  const did = "did:plc:retiredkey";
  await grant.persistAuthorityGrant(did, { ...savedSession("retired-key"), authMethod: { method: "private_key_jwt", kid: "retired" } } as unknown as NodeSavedSession);

  // when it is restored
  const restoring = grant.restoreAuthorityGrant(did);

  // then a new approval is asked for, and the grant is kept so that putting the key back restores it
  await assert.rejects(restoring, grant.AuthorityReauthorizationRequiredError);
  assert.equal(grant.hasAuthorityGrant(did), true);
});

test("an approved session that cannot be stored is signed out", async () => {
  // given a flow whose grant cannot be written
  const { params, cookie, appState } = boundFlow();
  const signOuts: string[] = [];

  // when its callback completes
  const attempt = grant.completeAuthorityFlow(params, cookie, {
    callbackClient: fakeCallback(AUTHORITY, appState, "unstorable", signOuts),
    persistGrant: async () => { throw new Error("disk full"); },
  });

  // then the flow fails and the session, which nothing holds, is signed out at the PDS
  await assert.rejects(attempt, /disk full/);
  assert.deepEqual(signOuts, ["unstorable"]);
});

test("an authority flow state can be read only once, even by racing callbacks", async () => {
  // given a stored flow state
  const states = oauthSqliteStore<NodeSavedSession>("authority_grant_state", { consumeOnRead: true });
  await states.set("state-1", savedSession("flow-state"));

  // when two callbacks read it at once
  const reads = await Promise.all([states.get("state-1"), states.get("state-1")]);

  // then exactly one gets it
  assert.equal(reads.filter(Boolean).length, 1);
});

test("a missing grant asks for reauthorization", async () => {
  await assert.rejects(grant.restoreAuthorityGrant("did:plc:nograntheld"), grant.AuthorityReauthorizationRequiredError);
});

test("on loopback the authority client is a public loopback client", () => {
  // given loopback development
  const metadata = grant.authorityClientMetadata({ operatorUrl: new URL("http://127.0.0.1:3000"), authorityClientKeys: [] });

  // then the client is public, with its own callback
  assert.equal(metadata.token_endpoint_auth_method, "none");
  assert.ok(metadata.client_id.startsWith("http://localhost?"));
  assert.equal(new URL(metadata.client_id).searchParams.get("redirect_uri"), "http://127.0.0.1:3000/authority/callback");
  assert.equal(new URL(metadata.client_id).searchParams.get("scope"), grant.authorityGrantScope());
});

test("outside loopback the authority client is confidential and publishes its keys", () => {
  // given a deployment with two signing keys
  const keys = [
    { kty: "EC" as const, crv: "P-256" as const, x: "x1", y: "y1", d: "secret1", kid: "new" },
    { kty: "EC" as const, crv: "P-256" as const, x: "x2", y: "y2", d: "secret2", kid: "old" },
  ];
  const config = { operatorUrl: new URL("https://spaces.example.com"), authorityClientKeys: keys };

  // when its metadata and JWKS are served
  const metadata = grant.authorityClientMetadata(config);
  const jwks = grant.authorityPublicJwks(config);

  // then it authenticates with private_key_jwt, points at its JWKS, and the JWKS holds no private part
  assert.equal(metadata.client_id, "https://spaces.example.com/authority/client-metadata.json");
  assert.equal(metadata.token_endpoint_auth_method, "private_key_jwt");
  assert.equal("token_endpoint_auth_signing_alg" in metadata && metadata.token_endpoint_auth_signing_alg, "ES256");
  assert.equal("jwks_uri" in metadata && metadata.jwks_uri, "https://spaces.example.com/authority/jwks.json");
  assert.deepEqual(jwks.keys.map((key) => key.kid), ["new", "old"]);
  assert.ok(jwks.keys.every((key) => !("d" in key)));
});

test("the authority grant scope asks for authority records only, never message content", () => {
  const scope = grant.authorityGrantScope();
  assert.ok(scope.split(" ").includes("atproto"));
  assert.ok(!scope.includes("channel.message") && !scope.includes("channel.reaction") && !scope.includes("new.flock.dm"));
});

test("authorityOAuthFetch strips WWW-Authenticate invalid_token on 401 AccountTakedown/AccountDeactivated so OAuthSession preserves the stored grant", async () => {
  for (const code of ["AccountTakedown", "AccountDeactivated"]) {
    const res = await grant.authorityOAuthFetch(
      "https://pds.example/xrpc/com.atproto.space.getSpace",
      undefined,
      async () =>
        new Response(JSON.stringify({ error: code, message: "Suspended" }), {
          status: 401,
          headers: {
            "content-type": "application/json",
            "www-authenticate": 'DPoP error="invalid_token", error_description="Account suspended"',
          },
        }),
    );
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("www-authenticate"), null, `${code} must not trigger OAuthSession invalid_token deletion`);
    assert.deepEqual(await res.json(), { error: code, message: "Suspended" });
  }

  // Genuine InvalidToken keeps WWW-Authenticate so OAuthSession refreshes or triggers reauthorization
  const genuine = await grant.authorityOAuthFetch(
    "https://pds.example/xrpc/com.atproto.space.getSpace",
    undefined,
    async () =>
      new Response(JSON.stringify({ error: "InvalidToken", message: "Token expired" }), {
        status: 401,
        headers: {
          "content-type": "application/json",
          "www-authenticate": 'DPoP error="invalid_token"',
        },
      }),
  );
  assert.equal(genuine.headers.get("www-authenticate"), 'DPoP error="invalid_token"');
});

test("quarantined sessionStore + out-of-band probe preserve authority_grant across expired-token refresh during AccountDeactivated/AccountTakedown/5xx, recover after deactivation, and require reapproval only once active refresh is still invalid_grant", async () => {
  const [{ JoseKey }, { operatorHttpFailure }, { AUTHORIZE_SUSP_BACKOFF, resetBreaker }] = await Promise.all([
    import("@atproto/jwk-jose"),
    import("./errors"),
    import("./authority-suspension").then((m) => ({
      AUTHORIZE_SUSP_BACKOFF: m.AUTHORITY_SUSPENDED_BACKOFF_MS,
      resetBreaker: m.resetAuthoritySuspensionForTests,
    })),
  ]);
  resetBreaker();

  const pdsOrigin = "https://pds.quarantine.test";
  const did = "did:web:pds.quarantine.test";
  const dpopKey = await JoseKey.generate(["ES256"], "dpop-quarantine-1");
  const dpopJwk = dpopKey.privateJwk!;
  assert.ok(dpopJwk, "generated private DPoP JWK");

  const expiredSession: NodeSavedSession = {
    dpopJwk,
    authMethod: { method: "none" },
    tokenSet: {
      iss: pdsOrigin,
      sub: did,
      aud: pdsOrigin,
      scope: grant.authorityGrantScope() as NodeSavedSession["tokenSet"]["scope"],
      access_token: "expired-access-token-1",
      refresh_token: "refresh-token-1",
      token_type: "DPoP",
      expires_at: new Date(Date.now() - 120_000).toISOString(),
    },
  };
  await grant.persistAuthorityGrant(did, expiredSession);
  const initialCiphertext = (getRawDb().prepare("SELECT value FROM authority_grant WHERE key = ?").get(did) as { value: string }).value;

  const clock = { now: Date.now() };
  let tokenMode: "invalid_grant" | "ok" = "invalid_grant";
  let probeMode: "deactivated" | "takendown" | "list_spaces_takendown" | "transient_503" | "active" = "deactivated";
  let oauthTokenCalls = 0;
  let probeCalls = 0;

  const mockFetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/.well-known/did.json") {
      return Response.json({
        "@context": ["https://www.w3.org/ns/did/v1"],
        id: did,
        service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: pdsOrigin }],
      });
    }
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      return Response.json({
        resource: pdsOrigin,
        authorization_servers: [pdsOrigin],
      });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return Response.json({
        issuer: pdsOrigin,
        authorization_endpoint: `${pdsOrigin}/oauth/authorize`,
        token_endpoint: `${pdsOrigin}/oauth/token`,
        revocation_endpoint: `${pdsOrigin}/oauth/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        dpop_signing_alg_values_supported: ["ES256"],
        scopes_supported: ["atproto"],
        client_id_metadata_document_supported: true,
      });
    }
    if (url.pathname === "/oauth/token") {
      oauthTokenCalls += 1;
      if (tokenMode === "invalid_grant") {
        return Response.json(
          { error: "invalid_grant", error_description: "Token was revoked or account unavailable" },
          { status: 400 },
        );
      }
      return Response.json({
        access_token: "refreshed-access-token-2",
        refresh_token: "refresh-token-2",
        token_type: "DPoP",
        sub: did,
        scope: grant.authorityGrantScope() as NodeSavedSession["tokenSet"]["scope"],
        expires_in: 3600,
      });
    }
    if (url.pathname === "/xrpc/com.atproto.sync.getRepoStatus") {
      probeCalls += 1;
      if (probeMode === "deactivated") {
        return Response.json({ did, active: false, status: "deactivated" });
      }
      if (probeMode === "takendown") {
        return Response.json({ did, active: false, status: "takendown" });
      }
      if (probeMode === "list_spaces_takendown") {
        return Response.json({ error: "MethodNotImplemented", message: "Not implemented" }, { status: 501 });
      }
      if (probeMode === "transient_503") {
        return Response.json({ error: "ServiceUnavailable", message: "PDS restarting" }, { status: 503 });
      }
      return Response.json({ did, active: true, rev: "3kabcdefghij2" });
    }
    if (url.pathname === "/xrpc/com.atproto.space.listSpaces") {
      probeCalls += 1;
      if (probeMode === "list_spaces_takendown") {
        return Response.json({ error: "RepoTakendown", message: "Repo taken down" }, { status: 400 });
      }
      return Response.json({ spaces: [] });
    }
    throw new Error(`Unexpected fetch URL: ${url.toString()}`);
  };

  const restoreDeps = {
    resolvePds: async () => pdsOrigin,
    fetchEndpoint: mockFetch,
    now: () => clock.now,
  };

  // 1. Expired access token during AccountDeactivated: NodeOAuthClient calls del(), which quarantines in memory ONLY;
  //    probe classifies AccountDeactivated -> 503 UpstreamUnavailable, and canonical authority_grant row stays intact!
  let caughtErr: unknown;
  await assert.rejects(
    async () => {
      try {
        await grant.restoreAuthorityGrant(did, restoreDeps);
      } catch (err) {
        caughtErr = err;
        throw err;
      }
    },
  );
  assert.deepEqual(operatorHttpFailure(caughtErr)?.status, 503);
  assert.deepEqual(operatorHttpFailure(caughtErr)?.name, "UpstreamUnavailable");
  assert.equal(grant.hasAuthorityGrant(did), true, "canonical authority_grant row MUST stay in SQLite during AccountDeactivated");
  assert.equal(
    (getRawDb().prepare("SELECT value FROM authority_grant WHERE key = ?").get(did) as { value: string }).value,
    initialCiphertext,
  );
  assert.equal(oauthTokenCalls, 1);
  assert.equal(probeCalls, 1);

  // Within the 15s authority circuit-breaker window, repeated calls make ZERO /oauth/token or probe requests!
  await assert.rejects(grant.restoreAuthorityGrant(did, restoreDeps));
  assert.equal(oauthTokenCalls, 1, "breaker blocks repeated /oauth/token calls within 15s");
  assert.equal(probeCalls, 1, "breaker blocks repeated probe calls within 15s");

  // 2. AccountDeactivated recovers once reactivated: refreshed tokens persist to SQLite via same-approval CAS!
  clock.now += AUTHORIZE_SUSP_BACKOFF;
  tokenMode = "ok";
  probeMode = "active";
  const recovered = await grant.restoreAuthorityGrant(did, restoreDeps);
  assert.equal(recovered.did, did);
  assert.equal((await storedGrant(did))?.tokenSet.access_token, "refreshed-access-token-2");

  // Expire the stored access token again to test AccountTakedown, listSpaces fallback, and transient 503 probe
  await grant.persistAuthorityGrant(did, {
    ...expiredSession,
    tokenSet: { ...expiredSession.tokenSet, access_token: "expired-after-recovery", refresh_token: "refresh-token-2" },
  });
  tokenMode = "invalid_grant";

  for (const mode of ["takendown", "list_spaces_takendown", "transient_503"] as const) {
    resetBreaker();
    probeMode = mode;
    let errForMode: unknown;
    await assert.rejects(async () => {
      try {
        await grant.restoreAuthorityGrant(did, restoreDeps);
      } catch (err) {
        errForMode = err;
        throw err;
      }
    });
    assert.equal(operatorHttpFailure(errForMode)?.status, 503, `${mode} maps to 503 UpstreamUnavailable`);
    assert.equal(operatorHttpFailure(errForMode)?.name, "UpstreamUnavailable");
    assert.equal(grant.hasAuthorityGrant(did), true, `canonical authority_grant preserved across ${mode}`);
  }

  // 3. Moderation lifts takedown (account active === true), but server-side refresh token was destroyed at takedown time:
  //    surfaces AuthorityReauthorizationRequiredError (502 AuthoritySessionUnavailable), STILL without auto-deleting the row!
  resetBreaker();
  probeMode = "active";
  let postTakedownErr: unknown;
  await assert.rejects(async () => {
    try {
      await grant.restoreAuthorityGrant(did, restoreDeps);
    } catch (err) {
      postTakedownErr = err;
      throw err;
    }
  }, grant.AuthorityReauthorizationRequiredError);
  assert.equal(operatorHttpFailure(postTakedownErr)?.status, 502);
  assert.equal(operatorHttpFailure(postTakedownErr)?.name, "AuthoritySessionUnavailable");
  assert.equal(grant.hasAuthorityGrant(did), true, "row remains in SQLite until explicit revokeAuthorityGrant or new approval");

  // Explicit revokeAuthorityGrant deletes canonical storage
  await grant.revokeAuthorityGrant(did).catch(() => undefined);
  assert.equal(grant.hasAuthorityGrant(did), false);
});

test("assertCredentialFreeOriginUrl and authorityClientMetadata reject embedded userinfo, paths, queries, and fragments", () => {
  for (const bad of [
    "https://user:secret@operator.example",
    "https://user@operator.example",
    "https://operator.example/subpath",
    "https://operator.example?leak=1",
    "https://operator.example#frag",
    "ftp://operator.example",
  ]) {
    assert.throws(
      () => grant.assertCredentialFreeOriginUrl(new URL(bad), "operatorUrl"),
      grant.AuthorityFlowError,
      `must reject ${bad}`,
    );
    assert.throws(
      () => grant.authorityClientMetadata({ operatorUrl: new URL(bad), authorityClientKeys: [] }),
      grant.AuthorityFlowError,
      `authorityClientMetadata must reject ${bad}`,
    );
  }
  assert.equal(
    grant.assertCredentialFreeOriginUrl(new URL("https://operator.example"), "operatorUrl"),
    "https://operator.example",
  );
});
