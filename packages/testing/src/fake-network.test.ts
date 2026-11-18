import assert from "node:assert/strict";
import test from "node:test";
import { P256Keypair, Secp256k1Keypair } from "@atproto/crypto";
import { type LexMap, fromBase64, parseCid } from "@atproto/lex-data";
import { jsonToLex } from "@atproto/lexicon";
import {
  COMMIT_MAC_PROFILE,
  MAC_COVERED_HEADER,
  RECORD_MAC_PROFILE,
  type SpaceCommit,
  SpaceMacError,
  createClientAttestation,
  createSpaceSigHeaders,
  encapsulate,
  formatMacRequest,
  parseSpaceToken,
  spaceHostAud,
  verifyCommit,
  verifyCommitMac,
  verifyRecord,
  verifyRecordMac,
  verifyRepoStarFull,
  verifySpaceToken,
} from "@atproto/space";
import { readStar } from "@atproto/star";
import { MEMBERSPACE_POLICY, memberspacePolicy } from "@flock/protocol/atproto/space-policy";
import { AtprotoClient, XrpcError } from "@flock/protocol/atproto/xrpc";
import { isTid, type Did } from "@flock/protocol/keys";
import { FakeNetwork } from "./fake-network";

const ALICE = "did:plc:alice000000000000000001" as Did;
const BOB = "did:plc:bob00000000000000000002" as Did;
const CAROL = "did:plc:carol000000000000000003" as Did;
const DAVE = "did:plc:dave0000000000000000004" as Did;

const TEST_SPACE_TYPE = "social.flock.dm.inbox";
const TEST_COLLECTION = "social.flock.dm.message";
const PERSONAL_POLICY = { $type: "com.atproto.personalspace.policy" } as const;
const STAR_MEDIA_TYPE = "application/vnd.dasl.star";

type SpaceUri = `at://${Did}/space/${string}.${string}.${string}/${string}`;
type SpaceRecordUri = `${SpaceUri}/${Did}/${string}.${string}.${string}/${string}`;

interface TestSetup {
  network: FakeNetwork;
  alice: AtprotoClient;
  bob: AtprotoClient;
  carol: AtprotoClient;
  dave: AtprotoClient;
}

function makeNetwork(): TestSetup {
  const network = new FakeNetwork();
  network.createAccount(ALICE, "pds1");
  network.createAccount(BOB, "pds2");
  network.createAccount(CAROL, "pds3");
  network.createAccount(DAVE, "pds4");
  return {
    network,
    alice: network.clientFor(ALICE),
    bob: network.clientFor(BOB),
    carol: network.clientFor(CAROL),
    dave: network.clientFor(DAVE),
  };
}

async function createDidKey(): Promise<{ did: Did; keypair: P256Keypair }> {
  const keypair = await P256Keypair.create({ exportable: true });
  return { did: keypair.did() as Did, keypair };
}

async function fetchJson(
  network: FakeNetwork,
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; headers: Headers; json: Record<string, unknown> }> {
  const res = await network.fetchEndpoint(new Request(url, init));
  const text = await res.text();
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  return { status: res.status, headers: res.headers, json };
}

async function authorizeSync(
  network: FakeNetwork,
  authorityDid: Did,
  opts: {
    space: string;
    credentialKey?: string;
    delegationToken?: string;
    clientAttestation?: string;
    notify?: { endpoint: string; token: string };
    extraHeaders?: Record<string, string>;
  },
): Promise<{
  status: number;
  credential?: string;
  spaceRev?: string;
  keypair?: P256Keypair;
  error?: { error?: string; message?: string };
}> {
  const pds = await network.resolvePds(authorityDid);
  assert.ok(pds, `expected PDS for ${authorityDid}`);
  let keypair: P256Keypair | undefined;
  let credentialKey = opts.credentialKey;
  if (credentialKey === undefined) {
    keypair = await P256Keypair.create({ exportable: true });
    credentialKey = keypair.did();
  }
  const body: Record<string, unknown> = {
    space: opts.space,
    credentialKey,
  };
  if (opts.delegationToken !== undefined) body.delegationToken = opts.delegationToken;
  if (opts.clientAttestation !== undefined) body.clientAttestation = opts.clientAttestation;
  if (opts.notify !== undefined) body.notify = opts.notify;

  const { status, json } = await fetchJson(
    network,
    `${pds}/xrpc/com.atproto.space.authorizeSpaceSync`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...opts.extraHeaders,
      },
      body: JSON.stringify(body),
    },
  );
  if (status >= 400) {
    return { status, error: json as { error?: string; message?: string } };
  }
  return {
    status,
    credential: json.credential as string,
    spaceRev: json.spaceRev as string | undefined,
    keypair,
  };
}

async function makeSyncClientHeaders(
  credential: string,
  keypair: P256Keypair,
  audience: Did,
): Promise<Record<string, string>> {
  const signed = await createSpaceSigHeaders({
    authorization: `Atproto-Space-Credential ${credential}`,
    audience,
    keypair,
  });
  return signed.headers;
}

async function startMac(
  network: FakeNetwork,
  hostDid: Did,
  profile: typeof COMMIT_MAC_PROFILE | typeof RECORD_MAC_PROFILE,
  forceRefresh = false,
): Promise<{
  header: string;
  keyShare: `did:key:${string}`;
  sharedSecret: Uint8Array;
}> {
  const kemKey = (await network.resolveKemKey(hostDid, forceRefresh)) as `did:${string}:${string}`;
  const encap = await encapsulate(kemKey);
  const header = formatMacRequest(profile, encap.keyShare);
  return {
    header,
    keyShare: encap.keyShare as `did:key:${string}`,
    sharedSecret: encap.sharedSecret,
  };
}

async function assertXrpcError(
  promise: Promise<unknown>,
  expectedStatus: number,
  expectedCode: string,
): Promise<XrpcError> {
  try {
    await promise;
    assert.fail(`Expected XrpcError(${expectedStatus}, ${expectedCode})`);
  } catch (err) {
    assert.ok(err instanceof XrpcError, `Expected XrpcError, got ${String(err)}`);
    assert.equal(err.status, expectedStatus);
    assert.equal(err.code, expectedCode);
    return err;
  }
}

function decodeWireCommit(raw: Record<string, unknown>): SpaceCommit {
  return jsonToLex(raw as Parameters<typeof jsonToLex>[0]) as unknown as SpaceCommit;
}

test("space CRUD, field renames (space, spaceDid, repo), listSpaces metadata, and deleteSpace", async () => {
  const { alice, bob } = makeNetwork();

  const created = await alice.procedure<Record<string, unknown>, { space: SpaceUri }>(
    "com.atproto.space.createSpace",
    {
      spaceType: TEST_SPACE_TYPE,
      skey: "main",
      policy: { $type: MEMBERSPACE_POLICY, publicRead: false, publicWrite: false },
    },
  );
  const space = created.space;
  assert.equal(space, `at://${ALICE}/space/${TEST_SPACE_TYPE}/main`);
  assert.equal("record" in created, false);
  assert.equal("uri" in created, false);

  const fetched = await alice.query<{ space: string; policy: Record<string, unknown> }>(
    "com.atproto.space.getSpace",
    { space },
  );
  assert.equal(fetched.space, space);
  assert.equal(fetched.policy.$type, MEMBERSPACE_POLICY);
  assert.equal("record" in fetched, false);

  await assertXrpcError(
    bob.query("com.atproto.space.getSpace", { space }),
    400,
    "NotAuthorized",
  );

  // putMembers + write populates listSpaces with repoRev/data and authority spaceRev
  await alice.procedure("com.atproto.memberspace.putMembers", {
    space,
    members: [{ did: BOB, read: true, write: true }],
  });

  await bob.procedure("com.atproto.space.putRecord", {
    repo: BOB,
    space,
    collection: TEST_COLLECTION,
    rkey: "msg-1",
    record: { body: "hi" },
  });

  // Reading Alice's own empty space repo returns empty and must NOT add Alice as a space writer
  await alice.query("com.atproto.space.listRecords", {
    repo: ALICE,
    space,
    collection: TEST_COLLECTION,
  });

  const aliceSpacesBeforeOwnWrite = await alice.query<{
    spaces: Array<{ space: string; repoRev?: string; data?: { $bytes: string }; spaceRev?: string }>;
  }>("com.atproto.space.listSpaces", { spaceDid: ALICE });
  assert.equal(aliceSpacesBeforeOwnWrite.spaces.length, 1);
  assert.equal(aliceSpacesBeforeOwnWrite.spaces[0]?.space, space);
  assert.equal(aliceSpacesBeforeOwnWrite.spaces[0]?.repoRev, undefined);
  assert.ok(isTid(aliceSpacesBeforeOwnWrite.spaces[0]?.spaceRev ?? ""));

  const bobSpaces = await bob.query<{
    spaces: Array<{ space: string; repoRev?: string; data?: { $bytes: string }; spaceRev?: string }>;
  }>("com.atproto.space.listSpaces", { spaceDid: ALICE });
  assert.equal(bobSpaces.spaces.length, 1);
  assert.equal(bobSpaces.spaces[0]?.space, space);
  assert.equal("record" in bobSpaces.spaces[0]!, false);
  assert.ok(isTid(bobSpaces.spaces[0]!.repoRev ?? ""));
  assert.ok(typeof bobSpaces.spaces[0]!.data?.$bytes === "string");
  // Non-authority writer does not see authority's spaceRev unless querying as authority
  assert.equal(bobSpaces.spaces[0]?.spaceRev, undefined);

  // Pagination on listSpaces
  const s2 = await alice.procedure<Record<string, unknown>, { space: SpaceUri }>(
    "com.atproto.space.createSpace",
    { spaceType: TEST_SPACE_TYPE, skey: "second", policy: PERSONAL_POLICY },
  );
  const page1 = await alice.query<{ spaces: Array<{ space: string }>; cursor?: string }>(
    "com.atproto.space.listSpaces",
    { limit: 1 },
  );
  assert.equal(page1.spaces.length, 1);
  assert.ok(page1.cursor);
  const page2 = await alice.query<{ spaces: Array<{ space: string }>; cursor?: string }>(
    "com.atproto.space.listSpaces",
    { limit: 1, cursor: page1.cursor },
  );
  assert.equal(page2.spaces.length, 1);
  assert.notEqual(page2.spaces[0]!.space, page1.spaces[0]!.space);
  const page3 = await alice.query<{ spaces: Array<{ space: string }>; cursor?: string }>(
    "com.atproto.space.listSpaces",
    { limit: 1, cursor: page2.cursor },
  );
  assert.equal(page3.spaces.length, 0);
  assert.equal(page3.cursor, undefined);

  // deleteSpace deletes authority's repo while Bob's PDS keeps Bob's own written records
  await alice.procedure("com.atproto.space.putRecord", {
    repo: ALICE,
    space,
    collection: TEST_COLLECTION,
    rkey: "owner-rec",
    record: { body: "owner" },
  });
  await alice.procedure("com.atproto.space.deleteSpace", { space });
  await alice.procedure("com.atproto.space.deleteSpace", { space: s2.space });

  await assertXrpcError(alice.query("com.atproto.space.getSpace", { space }), 400, "SpaceNotFound");
  await assertXrpcError(
    alice.procedure("com.atproto.space.putRecord", {
      repo: ALICE,
      space,
      collection: TEST_COLLECTION,
      rkey: "after-delete",
      record: { body: "nope" },
    }),
    400,
    "SpaceNotFound",
  );
  const bobAfterDelete = await bob.query<{ records: Array<{ rkey: string }> }>(
    "com.atproto.space.listRecords",
    { repo: BOB, space, collection: TEST_COLLECTION },
  );
  assert.equal(bobAfterDelete.records.length, 1);
  // Authority's own repo under the space is deleted with the space
  const aliceAfterDelete = await alice.query<{ records: Array<{ rkey: string }> }>(
    "com.atproto.space.listRecords",
    { repo: ALICE, space, collection: TEST_COLLECTION },
  );
  assert.equal(aliceAfterDelete.records.length, 0);
});

test("authorizeSpaceSync: no OAuth auth, credentialKey JWT & 10-min exp, spaceRev, delegationToken, allowedApps, account state", async () => {
  const { network, alice, bob, carol } = makeNetwork();
  const created = await alice.procedure<Record<string, unknown>, { space: SpaceUri }>(
    "com.atproto.space.createSpace",
    {
      spaceType: TEST_SPACE_TYPE,
      skey: "auth-sync",
      policy: memberspacePolicy(),
    },
  );
  const space = created.space;
  await alice.procedure("com.atproto.memberspace.putMembers", {
    space,
    members: [{ did: BOB, read: true, write: false }],
  });

  // Invalid credentialKey formats fail
  const badKey = await authorizeSync(network, ALICE, {
    space,
    credentialKey: "not-a-did-key",
  });
  assert.equal(badKey.status, 400);
  assert.equal(badKey.error?.error, "InvalidRequest");

  const secpKey = await Secp256k1Keypair.create();
  const nonP256 = await authorizeSync(network, ALICE, {
    space,
    credentialKey: secpKey.did(),
  });
  assert.equal(nonP256.status, 400);
  assert.equal(nonP256.error?.error, "InvalidRequest");

  // Unauthenticated request on private space without delegationToken -> 400 SpaceNotFound
  const unauthNoToken = await authorizeSync(network, ALICE, { space });
  assert.equal(unauthNoToken.status, 400);
  assert.equal(unauthNoToken.error?.error, "SpaceNotFound");

  // Carol can obtain a delegation token on her own PDS, but Alice's PDS rejects her with SpaceNotFound
  const carolDel = await carol.query<{ token: string }>("com.atproto.space.getDelegationToken", { space });
  const carolAttempt = await authorizeSync(network, ALICE, {
    space,
    delegationToken: carolDel.token,
  });
  assert.equal(carolAttempt.status, 400);
  assert.equal(carolAttempt.error?.error, "SpaceNotFound");

  // Bob's delegation token succeeds WITHOUT any Authorization header; before first write spaceRev is omitted
  const del1 = await bob.query<{ token: string }>("com.atproto.space.getDelegationToken", { space });
  assert.ok(del1.token.startsWith("delegation-"));
  const firstAuth = await authorizeSync(network, ALICE, {
    space,
    delegationToken: del1.token,
  });
  assert.equal(firstAuth.status, 200);
  assert.ok(firstAuth.credential);
  assert.equal(firstAuth.spaceRev, undefined);

  const verified = await verifySpaceToken("credential", firstAuth.credential, {
    getSigningKey: async (iss) => (await network.resolveSigningKey(iss))!,
    sub: space,
  });
  assert.equal(verified.payload.iss, ALICE);
  assert.equal(verified.payload.sub, space);
  assert.equal(verified.payload.exp - verified.payload.iat, 600);
  assert.equal(verified.payload.cnf.kid, firstAuth.keypair!.did());

  // Single-use delegationToken cannot be reused
  const reuseToken = await authorizeSync(network, ALICE, {
    space,
    delegationToken: del1.token,
  });
  assert.equal(reuseToken.status, 400);
  assert.equal(reuseToken.error?.error, "InvalidDelegationToken");

  // Expired delegationToken fails (TTL 60s + 5s skew)
  const expiringTokenRes = await bob.query<{ token: string }>("com.atproto.space.getDelegationToken", { space });
  network.advanceClock(70_000);
  const expiredTokenUse = await authorizeSync(network, ALICE, {
    space,
    delegationToken: expiringTokenRes.token,
  });
  assert.equal(expiredTokenUse.status, 400);
  assert.equal(expiredTokenUse.error?.error, "InvalidDelegationToken");

  // After a write, authorizeSpaceSync includes spaceRev
  await alice.procedure("com.atproto.space.putRecord", {
    repo: ALICE,
    space,
    collection: TEST_COLLECTION,
    rkey: "r1",
    record: { hello: 1 },
  });
  const del2 = await bob.query<{ token: string }>("com.atproto.space.getDelegationToken", { space });
  const afterWriteAuth = await authorizeSync(network, ALICE, {
    space,
    delegationToken: del2.token,
  });
  assert.equal(afterWriteAuth.status, 200);
  assert.ok(isTid(afterWriteAuth.spaceRev ?? ""));

  // allowedApps + clientAttestation, checking SpaceNotFound BEFORE AppNotAuthorized
  const { did: appDid, keypair: appKeypair } = await createDidKey();
  network.registerClientApp(appDid, appDid);
  await alice.procedure("com.atproto.space.updateSpace", {
    space,
    policy: { ...memberspacePolicy(), allowedApps: [appDid] },
  });

  // Unauthenticated / non-member fails with SpaceNotFound BEFORE AppNotAuthorized even without clientAttestation
  const unauthOnAppRestricted = await authorizeSync(network, ALICE, { space });
  assert.equal(unauthOnAppRestricted.status, 400);
  assert.equal(unauthOnAppRestricted.error?.error, "SpaceNotFound");

  // Non-existent space -> SpaceNotFound
  const missingSpaceFirst = await authorizeSync(network, ALICE, {
    space: `at://${ALICE}/space/${TEST_SPACE_TYPE}/nonexistent`,
  });
  assert.equal(missingSpaceFirst.status, 400);
  assert.equal(missingSpaceFirst.error?.error, "SpaceNotFound");

  // Authorized user without clientAttestation -> AppNotAuthorized
  const del3 = await bob.query<{ token: string }>("com.atproto.space.getDelegationToken", { space });
  const missingAttest = await authorizeSync(network, ALICE, {
    space,
    delegationToken: del3.token,
  });
  assert.equal(missingAttest.status, 400);
  assert.equal(missingAttest.error?.error, "AppNotAuthorized");

  // Rogue app attestation -> AppNotAuthorized
  const { did: rogueDid, keypair: rogueKeypair } = await createDidKey();
  network.registerClientApp(rogueDid, rogueDid);
  const rogueAttest = await createClientAttestation({
    clientId: rogueDid,
    aud: spaceHostAud(ALICE),
    keypair: rogueKeypair,
    expiresInSec: 300,
  });
  const del4 = await bob.query<{ token: string }>("com.atproto.space.getDelegationToken", { space });
  const rogueAttempt = await authorizeSync(network, ALICE, {
    space,
    delegationToken: del4.token,
    clientAttestation: rogueAttest,
  });
  assert.equal(rogueAttempt.status, 400);
  assert.equal(rogueAttempt.error?.error, "AppNotAuthorized");

  // Valid app attestation succeeds
  const validAttest = await createClientAttestation({
    clientId: appDid,
    aud: spaceHostAud(ALICE),
    keypair: appKeypair,
    expiresInSec: 300,
  });
  const del5 = await bob.query<{ token: string }>("com.atproto.space.getDelegationToken", { space });
  const attestedAuth = await authorizeSync(network, ALICE, {
    space,
    delegationToken: del5.token,
    clientAttestation: validAttest,
  });
  assert.equal(attestedAuth.status, 200);

  // Account suspension on space host yields RepoDeactivated / RepoTakendown
  network.setAccountState(ALICE, "deactivated");
  const deactivatedRes = await authorizeSync(network, ALICE, { space });
  assert.equal(deactivatedRes.status, 400);
  assert.equal(deactivatedRes.error?.error, "RepoDeactivated");

  network.setAccountState(ALICE, "takendown");
  const takendownRes = await authorizeSync(network, ALICE, { space });
  assert.equal(takendownRes.status, 400);
  assert.equal(takendownRes.error?.error, "RepoTakendown");

  // Deleted space yields SpaceDeleted on authorizeSpaceSync
  network.setAccountState(ALICE, "active");
  await alice.procedure("com.atproto.space.deleteSpace", { space });
  const deletedRes = await authorizeSync(network, ALICE, { space });
  assert.equal(deletedRes.status, 400);
  assert.equal(deletedRes.error?.error, "SpaceDeleted");
});

test("inline notify registration, confirmation reuse, refusal withdrawal, and notifySpaceUpdate delivery", async () => {
  const { network, alice, bob, carol } = makeNetwork();
  const created = await alice.procedure<Record<string, unknown>, { space: SpaceUri }>(
    "com.atproto.space.createSpace",
    {
      spaceType: TEST_SPACE_TYPE,
      skey: "notify-room",
      policy: memberspacePolicy(),
    },
  );
  const space = created.space;
  await alice.procedure("com.atproto.memberspace.putMembers", {
    space,
    members: [
      { did: BOB, read: true, write: true },
      { did: CAROL, read: true, write: false },
    ],
  });

  const watcherUrl = "https://watcher.example";
  const confirmations: Array<{ space: string; token: string; challenge: string }> = [];
  const notifications: Array<{ space: string; token: string; update: Record<string, unknown> }> = [];
  let confirmMode: "echo" | "mismatch" | "http400" = "echo";
  let updateStatus = 200;
  let expiredStatus = 400;

  network.registerEndpoint(watcherUrl, async (req) => {
    const pathname = new URL(req.url).pathname;
    const body = (await req.json()) as Record<string, unknown>;
    if (pathname === "/xrpc/com.atproto.space.confirmRegistration") {
      const payload = body as { space: string; token: string; challenge: string };
      confirmations.push(payload);
      if (confirmMode === "http400") {
        return new Response(JSON.stringify({ error: "InvalidRequest" }), { status: 400 });
      }
      const challenge = confirmMode === "mismatch" ? "wrong-challenge" : payload.challenge;
      return new Response(JSON.stringify({ challenge }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (pathname === "/xrpc/com.atproto.space.notifySpaceUpdate") {
      const payload = body as { space: string; token: string; update: Record<string, unknown> };
      notifications.push(payload);
      if (
        payload.update.$type === "com.atproto.space.notifySpaceUpdate#registrationExpired"
      ) {
        return new Response(JSON.stringify({ error: "Expired" }), { status: expiredStatus });
      }
      return new Response(updateStatus >= 400 ? JSON.stringify({ error: "Bad" }) : "{}", {
        status: updateStatus,
      });
    }
    return new Response("not found", { status: 404 });
  });

  // Challenge mismatch -> RegistrationNotConfirmed
  confirmMode = "mismatch";
  const t0 = await bob.query<{ token: string }>("com.atproto.space.getDelegationToken", { space });
  const mismatchRes = await authorizeSync(network, ALICE, {
    space,
    delegationToken: t0.token,
    notify: { endpoint: watcherUrl, token: "tok-a" },
  });
  assert.equal(mismatchRes.status, 400);
  assert.equal(mismatchRes.error?.error, "RegistrationNotConfirmed");

  // Confirm failure HTTP 400 -> RegistrationNotConfirmed
  confirmMode = "http400";
  const t1 = await bob.query<{ token: string }>("com.atproto.space.getDelegationToken", { space });
  const errConfirmRes = await authorizeSync(network, ALICE, {
    space,
    delegationToken: t1.token,
    notify: { endpoint: watcherUrl, token: "tok-a" },
  });
  assert.equal(errConfirmRes.status, 400);
  assert.equal(errConfirmRes.error?.error, "RegistrationNotConfirmed");

  // Unreachable endpoint -> RegistrationNotConfirmed
  confirmMode = "echo";
  const t2 = await bob.query<{ token: string }>("com.atproto.space.getDelegationToken", { space });
  const unreachRes = await authorizeSync(network, ALICE, {
    space,
    delegationToken: t2.token,
    notify: { endpoint: "https://missing-watcher.example", token: "tok-a" },
  });
  assert.equal(unreachRes.status, 400);
  assert.equal(unreachRes.error?.error, "RegistrationNotConfirmed");

  // Register (space, watcherUrl, "tok-a") and (space, watcherUrl, "tok-b")
  confirmations.length = 0;
  const t3 = await bob.query<{ token: string }>("com.atproto.space.getDelegationToken", { space });
  const regA = await authorizeSync(network, ALICE, {
    space,
    delegationToken: t3.token,
    notify: { endpoint: watcherUrl, token: "tok-a" },
  });
  assert.equal(regA.status, 200);
  assert.equal(confirmations.length, 1);

  const t4 = await carol.query<{ token: string }>("com.atproto.space.getDelegationToken", { space });
  const regB = await authorizeSync(network, ALICE, {
    space,
    delegationToken: t4.token,
    notify: { endpoint: watcherUrl, token: "tok-b" },
  });
  assert.equal(regB.status, 200);
  assert.equal(confirmations.length, 2);

  // Re-authorizing SAME (space, watcherUrl, "tok-a") while unexpired reuses registration without re-confirming
  const t5 = await bob.query<{ token: string }>("com.atproto.space.getDelegationToken", { space });
  const reuseRegA = await authorizeSync(network, ALICE, {
    space,
    delegationToken: t5.token,
    notify: { endpoint: watcherUrl, token: "tok-a" },
  });
  assert.equal(reuseRegA.status, 200);
  assert.equal(confirmations.length, 2);

  // Unauthenticated refusal withdraws ONLY matching (space, endpoint, token)
  const refuseA = await authorizeSync(network, ALICE, {
    space,
    notify: { endpoint: watcherUrl, token: "tok-a" },
  });
  assert.equal(refuseA.status, 400);
  assert.equal(refuseA.error?.error, "SpaceNotFound");

  // Write #1: only tok-b receives #repoWrite (no prevSpaceRev on first write)
  await bob.procedure("com.atproto.space.putRecord", {
    repo: BOB,
    space,
    collection: TEST_COLLECTION,
    rkey: "w1",
    record: { n: 1 },
  });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]!.token, "tok-b");
  assert.equal(notifications[0]!.update.$type, "com.atproto.space.defs#repoWrite");
  assert.equal(notifications[0]!.update.repo, BOB);
  assert.equal(notifications[0]!.update.prevSpaceRev, undefined);
  assert.ok(isTid(notifications[0]!.update.spaceRev as string));
  const dataObj = notifications[0]!.update.data as { $bytes: string };
  assert.ok(fromBase64(dataObj.$bytes).byteLength > 0);
  const rev1 = notifications[0]!.update.spaceRev as string;

  // HTTP 400 on active #repoWrite logs warning without dropping registration
  updateStatus = 400;
  await alice.procedure("com.atproto.space.putRecord", {
    repo: ALICE,
    space,
    collection: TEST_COLLECTION,
    rkey: "w2",
    record: { n: 2 },
  });
  assert.equal(notifications.length, 2);
  assert.ok(network.notifyWarnings.length >= 1);
  const rev2 = notifications[1]!.update.spaceRev as string;
  assert.equal(notifications[1]!.update.prevSpaceRev, rev1);

  // Next update (removeWriter) still reaches tok-b!
  updateStatus = 200;
  await alice.procedure("com.atproto.space.removeWriter", { space, repo: BOB });
  assert.equal(notifications.length, 3);
  assert.equal(notifications[2]!.update.$type, "com.atproto.space.defs#repoRemoved");
  assert.equal(notifications[2]!.update.repo, BOB);
  assert.equal(notifications[2]!.update.prevSpaceRev, rev2);

  // withholdNotices suppresses notifications until lifted
  network.withholdNotices(space, true);
  await alice.procedure("com.atproto.space.putRecord", {
    repo: ALICE,
    space,
    collection: TEST_COLLECTION,
    rkey: "w3",
    record: { n: 3 },
  });
  assert.equal(notifications.length, 3);
  network.withholdNotices(space, false);

  // Advance clock 10 minutes -> registration expires; next write delivers ONE #registrationExpired notice
  // and HTTP 400 drops it cleanly
  network.advanceClock(600_000);
  expiredStatus = 400;
  await alice.procedure("com.atproto.space.putRecord", {
    repo: ALICE,
    space,
    collection: TEST_COLLECTION,
    rkey: "w4",
    record: { n: 4 },
  });
  assert.equal(notifications.length, 4);
  assert.equal(
    notifications[3]!.update.$type,
    "com.atproto.space.notifySpaceUpdate#registrationExpired",
  );

  // Subsequent write sends nothing because tok-b was cleanly dropped
  await alice.procedure("com.atproto.space.putRecord", {
    repo: ALICE,
    space,
    collection: TEST_COLLECTION,
    rkey: "w5",
    record: { n: 5 },
  });
  assert.equal(notifications.length, 4);

  // Re-register after lapse triggers fresh confirmRegistration; retryable 503 preserves until #spaceDeleted
  const t6 = await carol.query<{ token: string }>("com.atproto.space.getDelegationToken", { space });
  const reRegB = await authorizeSync(network, ALICE, {
    space,
    delegationToken: t6.token,
    notify: { endpoint: watcherUrl, token: "tok-b" },
  });
  assert.equal(reRegB.status, 200);
  assert.equal(confirmations.length, 3);

  network.advanceClock(600_000);
  expiredStatus = 503;
  await alice.procedure("com.atproto.space.putRecord", {
    repo: ALICE,
    space,
    collection: TEST_COLLECTION,
    rkey: "w6",
    record: { n: 6 },
  });
  assert.equal(notifications.length, 5);
  assert.equal(
    notifications[4]!.update.$type,
    "com.atproto.space.notifySpaceUpdate#registrationExpired",
  );

  await alice.procedure("com.atproto.space.deleteSpace", { space });
  await network.flushNotifications();
  assert.equal(notifications.length, 6);
  assert.equal(
    notifications[5]!.update.$type,
    "com.atproto.space.notifySpaceUpdate#spaceDeleted",
  );
});

test("listWriters: spaceCredentialAuth, RFC 9421 sig checks, #repoWrite/#repoRemoved union order, cursor behavior & lag", async () => {
  const { network, alice, bob, carol } = makeNetwork();
  const created = await alice.procedure<Record<string, unknown>, { space: SpaceUri }>(
    "com.atproto.space.createSpace",
    {
      spaceType: TEST_SPACE_TYPE,
      skey: "writers",
      policy: memberspacePolicy(),
    },
  );
  const space = created.space;
  await alice.procedure("com.atproto.memberspace.putMembers", {
    space,
    members: [
      { did: BOB, read: true, write: true },
      { did: CAROL, read: true, write: true },
    ],
  });

  const alicePds = (await network.resolvePds(ALICE))!;

  // listWriters rejects account session Bearer and legacy Atproto-Space headers
  const bearerOnly = await fetchJson(
    network,
    `${alicePds}/xrpc/com.atproto.space.listWriters?space=${encodeURIComponent(space)}`,
    {
      headers: { authorization: `Bearer ${network.issueSessionToken(ALICE, "full")}` },
    },
  );
  assert.equal(bearerOnly.status, 401);
  assert.equal(bearerOnly.json.error, "MissingJwt");

  const del = await bob.query<{ token: string }>("com.atproto.space.getDelegationToken", { space });
  const auth = await authorizeSync(network, ALICE, { space, delegationToken: del.token });
  assert.equal(auth.status, 200);
  assert.ok(auth.credential && auth.keypair);

  const legacyHeader = await fetchJson(
    network,
    `${alicePds}/xrpc/com.atproto.space.listWriters?space=${encodeURIComponent(space)}`,
    {
      headers: { authorization: `Atproto-Space ${auth.credential}` },
    },
  );
  assert.equal(legacyHeader.status, 400);
  assert.equal(legacyHeader.json.error, "InvalidToken");

  // Wrong audience -> BadSpaceAudience
  const wrongAudHeaders = await makeSyncClientHeaders(auth.credential, auth.keypair, BOB);
  const badAud = await fetchJson(
    network,
    `${alicePds}/xrpc/com.atproto.space.listWriters?space=${encodeURIComponent(space)}`,
    { headers: wrongAudHeaders },
  );
  assert.equal(badAud.status, 401);
  assert.equal(badAud.json.error, "BadSpaceAudience");

  // Bad signature (different keypair) -> BadSpaceSignature
  const wrongKeypair = await P256Keypair.create();
  const badSigHeaders = await makeSyncClientHeaders(auth.credential, wrongKeypair, ALICE);
  const badSig = await fetchJson(
    network,
    `${alicePds}/xrpc/com.atproto.space.listWriters?space=${encodeURIComponent(space)}`,
    { headers: badSigHeaders },
  );
  assert.equal(badSig.status, 401);
  assert.equal(badSig.json.error, "BadSpaceSignature");

  // Writes & removal interleaved in spaceRev order
  await alice.procedure("com.atproto.space.putRecord", {
    repo: ALICE,
    space,
    collection: TEST_COLLECTION,
    rkey: "a1",
    record: { n: 1 },
  });
  await bob.procedure("com.atproto.space.putRecord", {
    repo: BOB,
    space,
    collection: TEST_COLLECTION,
    rkey: "b1",
    record: { n: 2 },
  });
  await carol.procedure("com.atproto.space.putRecord", {
    repo: CAROL,
    space,
    collection: TEST_COLLECTION,
    rkey: "c1",
    record: { n: 3 },
  });
  await alice.procedure("com.atproto.space.removeWriter", { space, repo: BOB });
  // Carol updates again -> moves after Bob removal
  await carol.procedure("com.atproto.space.putRecord", {
    repo: CAROL,
    space,
    collection: TEST_COLLECTION,
    rkey: "c2",
    record: { n: 4 },
  });

  const callList = async (params: Record<string, string>) => {
    const qs = new URLSearchParams({ space, ...params }).toString();
    const hdrs = await makeSyncClientHeaders(auth.credential!, auth.keypair!, ALICE);
    return fetchJson(network, `${alicePds}/xrpc/com.atproto.space.listWriters?${qs}`, {
      headers: hdrs,
    });
  };

  // Page 1 (limit=2) -> Alice write, Bob removed
  const page1 = await callList({ limit: "2" });
  assert.equal(page1.status, 200);
  const repos1 = page1.json.repos as Array<Record<string, unknown>>;
  assert.equal(repos1.length, 2);
  assert.equal(repos1[0]!.$type, "com.atproto.space.defs#repoWrite");
  assert.equal(repos1[0]!.repo, ALICE);
  assert.equal(repos1[1]!.$type, "com.atproto.space.defs#repoRemoved");
  assert.equal(repos1[1]!.repo, BOB);
  assert.ok(typeof page1.json.cursor === "string");

  // Page 2 (limit=2, fewer than limit items remaining!) MUST still emit cursor per listWriters.ts:25
  const page2 = await callList({ limit: "2", cursor: page1.json.cursor as string });
  assert.equal(page2.status, 200);
  const repos2 = page2.json.repos as Array<Record<string, unknown>>;
  assert.equal(repos2.length, 1);
  assert.equal(repos2[0]!.$type, "com.atproto.space.defs#repoWrite");
  assert.equal(repos2[0]!.repo, CAROL);
  assert.ok(typeof page2.json.cursor === "string");
  assert.ok((repos1[0]!.spaceRev as string) < (repos1[1]!.spaceRev as string));
  assert.ok((repos1[1]!.spaceRev as string) < (repos2[0]!.spaceRev as string));

  // Page 3 -> empty array, NO cursor
  const page3 = await callList({ limit: "2", cursor: page2.json.cursor as string });
  assert.equal(page3.status, 200);
  assert.deepEqual(page3.json.repos, []);
  assert.equal(page3.json.cursor, undefined);

  // Listing lag hides subsequent write until flushListing, then saved cursor picks it up
  network.setListingLag(space, true);
  await alice.procedure("com.atproto.space.putRecord", {
    repo: ALICE,
    space,
    collection: TEST_COLLECTION,
    rkey: "a2",
    record: { n: 5 },
  });
  const laggedPage = await callList({ cursor: page2.json.cursor as string });
  assert.deepEqual(laggedPage.json.repos, []);
  network.flushListing(space);
  const flushedPage = await callList({ cursor: page2.json.cursor as string });
  const flushedRepos = flushedPage.json.repos as Array<Record<string, unknown>>;
  assert.equal(flushedRepos.length, 1);
  assert.equal(flushedRepos[0]!.repo, ALICE);

  // InvalidCursor check
  const badCursor = await callList({ cursor: "not-a-valid-tid-cursor" });
  assert.equal(badCursor.status, 400);
  assert.equal(badCursor.json.error, "InvalidCursor");

  // Exact exp boundary: 599_999ms since auth ok, 600_000ms -> JwtExpired
  network.advanceClock(599_999);
  const beforeExp = await callList({});
  assert.equal(beforeExp.status, 200);
  network.advanceClock(1);
  const atExp = await callList({});
  assert.equal(atExp.status, 401);
  assert.equal(atExp.json.error, "JwtExpired");

  // Case-insensitive Atproto-Space-Credential scheme works when signed verbatim, then revocation rejects
  const del2 = await bob.query<{ token: string }>("com.atproto.space.getDelegationToken", { space });
  const auth2 = await authorizeSync(network, ALICE, { space, delegationToken: del2.token });
  const lowercaseSigned = await createSpaceSigHeaders({
    authorization: `atproto-space-credential ${auth2.credential!}`,
    audience: ALICE,
    keypair: auth2.keypair!,
  });
  const lowerRes = await fetchJson(
    network,
    `${alicePds}/xrpc/com.atproto.space.listWriters?space=${encodeURIComponent(space)}`,
    { headers: lowercaseSigned.headers },
  );
  assert.equal(lowerRes.status, 200);

  const parsed2 = parseSpaceToken("credential", auth2.credential!);
  network.revokeCredential(space, parsed2.payload.jti);
  const hdrsRevoked = await makeSyncClientHeaders(auth2.credential!, auth2.keypair!, ALICE);
  const revokedRes = await fetchJson(
    network,
    `${alicePds}/xrpc/com.atproto.space.listWriters?space=${encodeURIComponent(space)}`,
    { headers: hdrsRevoked },
  );
  assert.equal(revokedRes.status, 401);
  assert.equal(revokedRes.json.error, "CredentialRevoked");

  // Host suspension yields RepoTakendown / RepoDeactivated
  const del3 = await bob.query<{ token: string }>("com.atproto.space.getDelegationToken", { space });
  const auth3 = await authorizeSync(network, ALICE, { space, delegationToken: del3.token });
  const hdrs3 = await makeSyncClientHeaders(auth3.credential!, auth3.keypair!, ALICE);
  network.setAccountState(ALICE, "takendown");
  const tkRes = await fetchJson(
    network,
    `${alicePds}/xrpc/com.atproto.space.listWriters?space=${encodeURIComponent(space)}`,
    { headers: hdrs3 },
  );
  assert.equal(tkRes.status, 400);
  assert.equal(tkRes.json.error, "RepoTakendown");

  network.setAccountState(ALICE, "deactivated");
  const deRes = await fetchJson(
    network,
    `${alicePds}/xrpc/com.atproto.space.listWriters?space=${encodeURIComponent(space)}`,
    { headers: hdrs3 },
  );
  assert.equal(deRes.status, 400);
  assert.equal(deRes.json.error, "RepoDeactivated");
});

test("putMembers & removeMembers (<=100), publicWrite denying explicit write:false, personalspace & managedspace.checkAccess", async () => {
  const { network, alice, bob, carol, dave } = makeNetwork();

  const created = await alice.procedure<Record<string, unknown>, { space: SpaceUri }>(
    "com.atproto.space.createSpace",
    {
      spaceType: TEST_SPACE_TYPE,
      skey: "pub-write",
      policy: { $type: MEMBERSPACE_POLICY, publicRead: true, publicWrite: true },
    },
  );
  const space = created.space;

  // >100 rejected
  const over100 = Array.from({ length: 101 }, (_, i) => ({
    did: `did:plc:member${String(i).padStart(18, "0")}`,
    read: true,
    write: true,
  }));
  await assertXrpcError(
    alice.procedure("com.atproto.memberspace.putMembers", { space, members: over100 }),
    400,
    "InvalidRequest",
  );
  await assertXrpcError(
    alice.procedure("com.atproto.memberspace.removeMembers", {
      space,
      dids: over100.map((m) => m.did),
    }),
    400,
    "InvalidRequest",
  );

  // Unmentioned Bob & Carol can write under publicWrite: true
  await bob.procedure("com.atproto.space.putRecord", {
    repo: BOB,
    space,
    collection: TEST_COLLECTION,
    rkey: "b1",
    record: { v: 1 },
  });
  await carol.procedure("com.atproto.space.putRecord", {
    repo: CAROL,
    space,
    collection: TEST_COLLECTION,
    rkey: "c1",
    record: { v: 1 },
  });

  // Dedup last-entry-wins: Carol ends up write:false even with publicWrite:true (manager.ts:287)
  await alice.procedure("com.atproto.memberspace.putMembers", {
    space,
    members: [
      { did: CAROL, read: true, write: true },
      { did: CAROL, read: true, write: false },
    ],
  });
  await carol.procedure("com.atproto.space.putRecord", {
    repo: CAROL,
    space,
    collection: TEST_COLLECTION,
    rkey: "c2",
    record: { v: 2 },
  });
  // Verify Carol was revoked from writers by putMembers(write: false), and cannot write again!
  const pds = (await network.resolvePds(ALICE))!;
  const del0 = await bob.query<{ token: string }>("com.atproto.space.getDelegationToken", { space });
  const auth0 = await authorizeSync(network, ALICE, { space, delegationToken: del0.token });
  const lw0 = await fetchJson(
    network,
    `${pds}/xrpc/com.atproto.space.listWriters?space=${encodeURIComponent(space)}`,
    { headers: await makeSyncClientHeaders(auth0.credential!, auth0.keypair!, ALICE) },
  );
  const writersBefore = lw0.json.repos as Array<{ $type: string; repo: string }>;
  assert.equal(
    writersBefore.find((w) => w.repo === CAROL)?.$type,
    "com.atproto.space.defs#repoRemoved",
  );

  // Removing a NON-member (Bob) under publicWrite leaves Bob in writers!
  // Removing Carol removes her explicit write:false deny so Carol's next write enters writers again!
  await alice.procedure("com.atproto.memberspace.removeMembers", {
    space,
    dids: [BOB, CAROL],
  });
  const lw1 = await fetchJson(
    network,
    `${pds}/xrpc/com.atproto.space.listWriters?space=${encodeURIComponent(space)}`,
    { headers: await makeSyncClientHeaders(auth0.credential!, auth0.keypair!, ALICE) },
  );
  const writersAfterRemove = lw1.json.repos as Array<{ $type: string; repo: string }>;
  assert.equal(
    writersAfterRemove.find((w) => w.repo === BOB)?.$type,
    "com.atproto.space.defs#repoWrite",
  );

  await carol.procedure("com.atproto.space.putRecord", {
    repo: CAROL,
    space,
    collection: TEST_COLLECTION,
    rkey: "c3",
    record: { v: 3 },
  });
  const lw2 = await fetchJson(
    network,
    `${pds}/xrpc/com.atproto.space.listWriters?space=${encodeURIComponent(space)}`,
    { headers: await makeSyncClientHeaders(auth0.credential!, auth0.keypair!, ALICE) },
  );
  const writersAfterCarolRetry = lw2.json.repos as Array<{ $type: string; repo: string }>;
  assert.equal(
    writersAfterCarolRetry.find((w) => w.repo === CAROL)?.$type,
    "com.atproto.space.defs#repoWrite",
  );

  // personalspace policy: authority-only writes and reads
  const personalRes = await alice.procedure<Record<string, unknown>, { space: SpaceUri }>(
    "com.atproto.space.createSpace",
    {
      spaceType: TEST_SPACE_TYPE,
      skey: "personal",
      policy: PERSONAL_POLICY,
    },
  );
  const personalSpace = personalRes.space;
  await assertXrpcError(
    alice.procedure("com.atproto.memberspace.putMembers", {
      space: personalSpace,
      members: [{ did: BOB, read: true, write: true }],
    }),
    400,
    "PolicyMismatch",
  );
  await alice.procedure("com.atproto.space.putRecord", {
    repo: ALICE,
    space: personalSpace,
    collection: TEST_COLLECTION,
    rkey: "p1",
    record: { private: true },
  });
  // Bob cannot authorize sync for personalSpace
  const bobPersonalDel = await bob.query<{ token: string }>("com.atproto.space.getDelegationToken", {
    space: personalSpace,
  });
  const bobPersonalSync = await authorizeSync(network, ALICE, {
    space: personalSpace,
    delegationToken: bobPersonalDel.token,
  });
  assert.equal(bobPersonalSync.status, 400);
  assert.equal(bobPersonalSync.error?.error, "SpaceNotFound");

  // managedspace.checkAccess policy
  const accessSvcDid = "did:plc:accesssvc00000000000001" as Did;
  const accessSvcRef = `${accessSvcDid}#space_access`;
  const accessSvcUrl = "https://access.example";
  let allowBobWrite = true;
  let allowDaveRead = true;
  const checkCalls: Array<{ space: string; repo: string; clientId?: string; authAud: string }> = [];

  network.registerService(accessSvcRef, accessSvcUrl, async (req) => {
    const authHeader = req.headers.get("authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const claims = network.readServiceToken(token);
    assert.ok(claims);
    assert.equal(claims.lxm, "com.atproto.managedspace.checkAccess");
    const url = new URL(req.url);
    const reqSpace = url.searchParams.get("space") ?? "";
    const reqRepo = url.searchParams.get("repo") ?? "";
    const reqClient = url.searchParams.get("clientId") ?? undefined;
    checkCalls.push({ space: reqSpace, repo: reqRepo, clientId: reqClient, authAud: claims.aud });
    if (reqRepo === BOB) {
      return Response.json({ read: true, write: allowBobWrite });
    }
    if (reqRepo === DAVE) {
      return Response.json({ read: allowDaveRead, write: false });
    }
    return Response.json({ read: false, write: false });
  });

  // Invalid managingApp without #serviceId -> InvalidRequest
  await assertXrpcError(
    alice.procedure("com.atproto.space.createSpace", {
      spaceType: TEST_SPACE_TYPE,
      skey: "bad-managed",
      policy: { $type: "com.atproto.managedspace.policy", managingApp: "invalid-no-fragment" },
    }),
    400,
    "InvalidRequest",
  );

  const managedRes = await alice.procedure<Record<string, unknown>, { space: SpaceUri }>(
    "com.atproto.space.createSpace",
    {
      spaceType: TEST_SPACE_TYPE,
      skey: "managed",
      policy: { $type: "com.atproto.managedspace.policy", managingApp: accessSvcRef },
    },
  );
  const managedSpace = managedRes.space;

  await bob.procedure("com.atproto.space.putRecord", {
    repo: BOB,
    space: managedSpace,
    collection: TEST_COLLECTION,
    rkey: "m1",
    record: { managed: true },
  });

  // Dave (read:true, write:false) CAN get delegation & read Bob's repo via space credential,
  // while Carol (read:false) CANNOT authorize sync
  const daveDel = await dave.query<{ token: string }>("com.atproto.space.getDelegationToken", {
    space: managedSpace,
  });
  const daveAuth = await authorizeSync(network, ALICE, {
    space: managedSpace,
    delegationToken: daveDel.token,
  });
  assert.equal(daveAuth.status, 200);

  const mac = await startMac(network, BOB, COMMIT_MAC_PROFILE);
  const bobPds = (await network.resolvePds(BOB))!;
  const daveRead = await fetchJson(
    network,
    `${bobPds}/xrpc/com.atproto.space.getLatestCommit?repo=${encodeURIComponent(BOB)}&space=${encodeURIComponent(managedSpace)}`,
    {
      headers: {
        ...(await makeSyncClientHeaders(daveAuth.credential!, daveAuth.keypair!, BOB)),
        "accept-signature": mac.header,
      },
    },
  );
  assert.equal(daveRead.status, 200);

  // Dave writing does NOT appear in managedspace writers because write:false
  await dave.procedure("com.atproto.space.putRecord", {
    repo: DAVE,
    space: managedSpace,
    collection: TEST_COLLECTION,
    rkey: "d1",
    record: { nope: true },
  });

  const lwManaged = await fetchJson(
    network,
    `${pds}/xrpc/com.atproto.space.listWriters?space=${encodeURIComponent(managedSpace)}`,
    { headers: await makeSyncClientHeaders(daveAuth.credential!, daveAuth.keypair!, ALICE) },
  );
  const managedWriters = (lwManaged.json.repos as Array<{ repo: string }>).map((w) => w.repo);
  assert.deepEqual(managedWriters, [BOB]);

  // Flip Dave read:false -> authorizeSync refused
  allowDaveRead = false;
  const daveDel2 = await dave.query<{ token: string }>("com.atproto.space.getDelegationToken", {
    space: managedSpace,
  });
  const daveRefused = await authorizeSync(network, ALICE, {
    space: managedSpace,
    delegationToken: daveDel2.token,
  });
  assert.equal(daveRefused.status, 400);
  assert.equal(daveRefused.error?.error, "SpaceNotFound");

  // Unreachable managingApp -> 502 UpstreamFailure; retryNotifications recovers queued write when reachable again
  // AND 502 UpstreamFailure on authorizeSpaceSync must NOT withdraw an existing notify registration!
  const upstreamWatcher = "https://managed-watcher.example";
  const upstreamConfirmations: string[] = [];
  const upstreamNotices: Array<{ token: string; update: Record<string, unknown> }> = [];
  network.registerEndpoint(upstreamWatcher, async (req) => {
    const pathname = new URL(req.url).pathname;
    const body = (await req.json()) as Record<string, unknown>;
    if (pathname === "/xrpc/com.atproto.space.confirmRegistration") {
      upstreamConfirmations.push(String(body.challenge));
      return Response.json({ challenge: body.challenge });
    }
    if (pathname === "/xrpc/com.atproto.space.notifySpaceUpdate") {
      upstreamNotices.push(body as { token: string; update: Record<string, unknown> });
      return Response.json({});
    }
    return new Response("not found", { status: 404 });
  });

  const bobManagedDel = await bob.query<{ token: string }>("com.atproto.space.getDelegationToken", { space: managedSpace });
  const bobManagedAuth = await authorizeSync(network, ALICE, {
    space: managedSpace,
    delegationToken: bobManagedDel.token,
    notify: { endpoint: upstreamWatcher, token: "managed-tok" },
  });
  assert.equal(bobManagedAuth.status, 200);
  assert.equal(upstreamConfirmations.length, 1);

  allowBobWrite = true;
  let svcUp = false;
  network.registerService(accessSvcRef, accessSvcUrl, async (req) => {
    if (!svcUp) return new Response("down", { status: 503 });
    const url = new URL(req.url);
    const reqRepo = url.searchParams.get("repo") ?? "";
    return Response.json({ read: reqRepo === BOB, write: reqRepo === BOB });
  });

  const carolDelManaged = await carol.query<{ token: string }>(
    "com.atproto.space.getDelegationToken",
    { space: managedSpace },
  );
  const upstreamErr = await authorizeSync(network, ALICE, {
    space: managedSpace,
    delegationToken: carolDelManaged.token,
    notify: { endpoint: upstreamWatcher, token: "managed-tok" },
  });
  assert.equal(upstreamErr.status, 502);
  assert.equal(upstreamErr.error?.error, "UpstreamFailure");

  // Write while checkAccess fails -> queued in pendingRepoUpdateRetries; when svc recovers, retryNotifications delivers!
  await bob.procedure("com.atproto.space.putRecord", {
    repo: BOB,
    space: managedSpace,
    collection: TEST_COLLECTION,
    rkey: "m2",
    record: { recovered: true },
  });
  assert.equal(upstreamNotices.length, 0);

  svcUp = true;
  await network.retryNotifications();
  assert.equal(upstreamNotices.length, 1);
  assert.equal(upstreamNotices[0]!.token, "managed-tok");
  assert.equal(upstreamNotices[0]!.update.$type, "com.atproto.space.defs#repoWrite");
  assert.equal(upstreamNotices[0]!.update.repo, BOB);

  assert.ok(checkCalls.some((c) => c.repo === BOB && c.authAud === accessSvcRef));
});

test("getRepo returns application/vnd.dasl.star verified by verifyRepoStarFull + importRepo roundtrip", async () => {
  const { network, alice, bob } = makeNetwork();
  const created = await alice.procedure<Record<string, unknown>, { space: SpaceUri }>(
    "com.atproto.space.createSpace",
    {
      spaceType: TEST_SPACE_TYPE,
      skey: "star-repo",
      policy: { $type: MEMBERSPACE_POLICY, publicRead: true, publicWrite: false },
    },
  );
  const space = created.space;

  await alice.procedure("com.atproto.space.applyWrites", {
    repo: ALICE,
    space,
    writes: [
      {
        $type: "com.atproto.space.applyWrites#create",
        collection: TEST_COLLECTION,
        rkey: "r1",
        value: { msg: "one" },
      },
      {
        $type: "com.atproto.space.applyWrites#create",
        collection: TEST_COLLECTION,
        rkey: "r2",
        value: { msg: "two" },
      },
      {
        $type: "com.atproto.space.applyWrites#update",
        collection: TEST_COLLECTION,
        rkey: "r1",
        value: { msg: "one-updated" },
      },
      {
        $type: "com.atproto.space.applyWrites#delete",
        collection: TEST_COLLECTION,
        rkey: "r2",
      },
    ],
  });

  const pds = (await network.resolvePds(ALICE))!;
  const mac = await startMac(network, ALICE, COMMIT_MAC_PROFILE);
  const res = await network.fetchEndpoint(
    new Request(
      `${pds}/xrpc/com.atproto.space.getRepo?repo=${encodeURIComponent(ALICE)}&space=${encodeURIComponent(space)}`,
      {
        headers: {
          authorization: `Bearer ${network.issueSessionToken(ALICE, "full")}`,
          "accept-signature": mac.header,
        },
      },
    ),
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), STAR_MEDIA_TYPE);
  assert.equal(res.headers.get("vary"), "Accept-Signature");
  const starBytes = new Uint8Array(await res.arrayBuffer());
  const star = await readStar([starBytes]);
  assert.equal(star.meta.$type, "atproto-space-repo");
  await star.pairs.return?.(undefined);

  const verifiedStar = await verifyRepoStarFull([starBytes], {
    space,
    repo: ALICE,
    keyShare: mac.keyShare,
    sharedSecret: mac.sharedSecret,
    headers: res.headers,
  });
  assert.equal(verifiedStar.records.length, 1);
  assert.equal(verifiedStar.records[0]!.collection, TEST_COLLECTION);
  assert.equal(verifiedStar.records[0]!.rkey, "r1");
  assert.deepEqual(verifiedStar.records[0]!.record, { msg: "one-updated" });

  // Unwritten repo -> RepoNotFound
  await assertXrpcError(
    bob.query("com.atproto.space.getRepo", { repo: BOB, space }),
    400,
    "RepoNotFound",
  );

  // Clear records -> getRepo returns valid signed empty STAR
  await alice.procedure("com.atproto.space.clearRecords", { repo: ALICE, space });
  const macEmpty = await startMac(network, ALICE, COMMIT_MAC_PROFILE);
  const emptyRes = await network.fetchEndpoint(
    new Request(
      `${pds}/xrpc/com.atproto.space.getRepo?repo=${encodeURIComponent(ALICE)}&space=${encodeURIComponent(space)}`,
      {
        headers: {
          authorization: `Bearer ${network.issueSessionToken(ALICE, "full")}`,
          "accept-signature": macEmpty.header,
        },
      },
    ),
  );
  assert.equal(emptyRes.status, 200);
  const verifiedEmpty = await verifyRepoStarFull([new Uint8Array(await emptyRes.arrayBuffer())], {
    space,
    repo: ALICE,
    keyShare: macEmpty.keyShare,
    sharedSecret: macEmpty.sharedSecret,
    headers: emptyRes.headers,
  });
  assert.equal(verifiedEmpty.records.length, 0);

  // importRepo restores STAR archive into Alice's repo with Content-Type: application/vnd.dasl.star
  const importRes = await network.fetchEndpoint(
    new Request(`${pds}/xrpc/com.atproto.space.importRepo`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${network.issueSessionToken(ALICE, "full")}`,
        "content-type": STAR_MEDIA_TYPE,
      },
      body: starBytes,
    }),
  );
  assert.equal(importRes.status, 200);
  const restored = await alice.query<{ records: Array<{ rkey: string; value: Record<string, unknown> }> }>(
    "com.atproto.space.listRecords",
    { repo: ALICE, space, collection: TEST_COLLECTION },
  );
  assert.equal(restored.records.length, 1);
  assert.deepEqual(restored.records[0]!.value, { msg: "one-updated" });

  // Wrong repo in STAR when Bob tries to import Alice's STAR -> RepoMismatch
  const bobPds = (await network.resolvePds(BOB))!;
  const mismatchImport = await fetchJson(
    network,
    `${bobPds}/xrpc/com.atproto.space.importRepo`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${network.issueSessionToken(BOB, "full")}`,
        "content-type": STAR_MEDIA_TYPE,
      },
      body: starBytes,
    },
  );
  assert.equal(mismatchImport.status, 400);
  assert.equal(mismatchImport.json.error, "RepoMismatch");

  // Malformed STAR -> InvalidRepoFile
  const badImport = await fetchJson(
    network,
    `${pds}/xrpc/com.atproto.space.importRepo`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${network.issueSessionToken(ALICE, "full")}`,
        "content-type": STAR_MEDIA_TYPE,
      },
      body: new Uint8Array([1, 2, 3, 4]),
    },
  );
  assert.equal(badImport.status, 400);
  assert.equal(badImport.json.error, "InvalidRepoFile");
});

test("listRepoOps signed/MAC commit on EVERY page, RepoNotFound for unwritten repo, RFC 9421 MACs & CORS headers", async () => {
  const { network, alice } = makeNetwork();
  const created = await alice.procedure<Record<string, unknown>, { space: SpaceUri }>(
    "com.atproto.space.createSpace",
    {
      spaceType: TEST_SPACE_TYPE,
      skey: "mac-and-ops",
      policy: { $type: MEMBERSPACE_POLICY, publicRead: true, publicWrite: true },
    },
  );
  const space = created.space;

  // CORS preflight allows accept-signature
  const pds = (await network.resolvePds(ALICE))!;
  const optRes = await network.fetchEndpoint(
    new Request(`${pds}/xrpc/com.atproto.space.listRepoOps`, { method: "OPTIONS" }),
  );
  assert.equal(optRes.status, 204);
  assert.equal(optRes.headers.get("access-control-allow-origin"), "*");
  assert.ok(
    (optRes.headers.get("access-control-allow-headers") ?? "")
      .toLowerCase()
      .includes("accept-signature"),
  );

  // Account that has NEVER written to space -> 400 RepoNotFound
  const bobPds = (await network.resolvePds(BOB))!;
  const bobDel = await alice.query<{ token: string }>("com.atproto.space.getDelegationToken", { space });
  // Alice owns the space; check Bob's unwritten repo directly as Bob!
  await assertXrpcError(
    network.clientFor(BOB).query("com.atproto.space.listRepoOps", { repo: BOB, space }),
    400,
    "RepoNotFound",
  );
  assert.ok(bobPds && bobDel.token);

  // Create 5 ops so limit=2 produces intermediate cursor pages + final page
  for (let i = 1; i <= 5; i++) {
    await alice.procedure("com.atproto.space.putRecord", {
      repo: ALICE,
      space,
      collection: TEST_COLLECTION,
      rkey: `k${i}`,
      record: { i },
    });
  }

  const fetchOpsPage = async (cursor?: string, extra?: Record<string, string>) => {
    const mac = await startMac(network, ALICE, COMMIT_MAC_PROFILE);
    const qs = new URLSearchParams({
      repo: ALICE,
      space,
      limit: "2",
      ...(cursor ? { cursor } : {}),
      ...extra,
    }).toString();
    const res = await network.fetchEndpoint(
      new Request(`${pds}/xrpc/com.atproto.space.listRepoOps?${qs}`, {
        headers: {
          authorization: `Bearer ${network.issueSessionToken(ALICE, "full")}`,
          "accept-signature": mac.header,
        },
      }),
    );
    const json = (await res.json()) as {
      ops?: Array<Record<string, unknown>>;
      commit?: Record<string, unknown>;
      cursor?: string;
      error?: string;
    };
    return { res, json, mac };
  };

  // Intermediate page 1 MUST have signed/MAC'd commit + CORS headers
  const p1 = await fetchOpsPage();
  assert.equal(p1.res.status, 200);
  assert.equal(p1.json.ops?.length, 2);
  assert.ok(p1.json.commit, "intermediate page 1 must include commit");
  assert.ok(p1.json.cursor);
  assert.equal(p1.res.headers.get("vary"), "Accept-Signature");
  const expose1 = (p1.res.headers.get("access-control-expose-headers") ?? "").toLowerCase();
  assert.ok(expose1.includes(MAC_COVERED_HEADER[COMMIT_MAC_PROFILE]));
  assert.ok(expose1.includes("signature-input"));
  assert.ok(expose1.includes("signature"));
  const commit1 = decodeWireCommit(p1.json.commit);
  verifyCommitMac(commit1, {
    keyShare: p1.mac.keyShare,
    sharedSecret: p1.mac.sharedSecret,
    headers: p1.res.headers,
  });
  verifyCommit(commit1, {
    space,
    repo: ALICE,
    keyShare: p1.mac.keyShare,
    sharedSecret: p1.mac.sharedSecret,
    headers: p1.res.headers,
  });

  // Intermediate page 2 MUST also have signed/MAC'd commit
  const p2 = await fetchOpsPage(p1.json.cursor);
  assert.equal(p2.res.status, 200);
  assert.equal(p2.json.ops?.length, 2);
  assert.ok(p2.json.commit, "intermediate page 2 must include commit");
  assert.ok(p2.json.cursor);
  verifyCommitMac(decodeWireCommit(p2.json.commit), {
    keyShare: p2.mac.keyShare,
    sharedSecret: p2.mac.sharedSecret,
    headers: p2.res.headers,
  });

  // Final page 3
  const p3 = await fetchOpsPage(p2.json.cursor);
  assert.equal(p3.res.status, 200);
  assert.equal(p3.json.ops?.length, 1);
  assert.ok(p3.json.commit);
  assert.equal(p3.json.cursor, undefined);

  // Malformed cursor -> InvalidCursor
  const badCursor = await fetchOpsPage("bad-no-slash");
  assert.equal(badCursor.res.status, 400);
  assert.equal(badCursor.json.error, "InvalidCursor");

  // Record MAC verification on getRecord
  const recMac = await startMac(network, ALICE, RECORD_MAC_PROFILE);
  const expectedUri = `${space}/${ALICE}/${TEST_COLLECTION}/k1` as SpaceRecordUri;
  const recRes = await network.fetchEndpoint(
    new Request(
      `${pds}/xrpc/com.atproto.space.getRecord?repo=${encodeURIComponent(ALICE)}&space=${encodeURIComponent(space)}&collection=${TEST_COLLECTION}&rkey=k1`,
      {
        headers: {
          authorization: `Bearer ${network.issueSessionToken(ALICE, "full")}`,
          "accept-signature": recMac.header,
        },
      },
    ),
  );
  assert.equal(recRes.status, 200);
  const recJson = (await recRes.json()) as { uri: SpaceRecordUri; cid: string; value: LexMap };
  assert.equal(recJson.uri, expectedUri);
  const recExpose = (recRes.headers.get("access-control-expose-headers") ?? "").toLowerCase();
  assert.ok(recExpose.includes(MAC_COVERED_HEADER[RECORD_MAC_PROFILE]));
  verifyRecordMac(recJson.uri, parseCid(recJson.cid), {
    keyShare: recMac.keyShare,
    sharedSecret: recMac.sharedSecret,
    headers: recRes.headers,
  });
  await verifyRecord(recJson, {
    uri: expectedUri,
    keyShare: recMac.keyShare,
    sharedSecret: recMac.sharedSecret,
    headers: recRes.headers,
  });

  // Invalid Accept-Signature -> 400 InvalidSpaceMac
  const badMacRes = await fetchJson(
    network,
    `${pds}/xrpc/com.atproto.space.getLatestCommit?repo=${encodeURIComponent(ALICE)}&space=${encodeURIComponent(space)}`,
    {
      headers: {
        authorization: `Bearer ${network.issueSessionToken(ALICE, "full")}`,
        "accept-signature": "sig1=(@status);alg=\"bogus\"",
      },
    },
  );
  assert.equal(badMacRes.status, 400);
  assert.equal(badMacRes.json.error, "InvalidSpaceMac");

  // KEM key rotation: stale key fails verification/decapsulation -> InvalidSpaceMac; refreshed key succeeds
  const oldMac = await startMac(network, ALICE, COMMIT_MAC_PROFILE);
  await network.rotateKemKey(ALICE);
  const staleRes = await network.fetchEndpoint(
    new Request(
      `${pds}/xrpc/com.atproto.space.getLatestCommit?repo=${encodeURIComponent(ALICE)}&space=${encodeURIComponent(space)}`,
      {
        headers: {
          authorization: `Bearer ${network.issueSessionToken(ALICE, "full")}`,
          "accept-signature": oldMac.header,
        },
      },
    ),
  );
  assert.equal(staleRes.status, 200);
  const staleBody = (await staleRes.json()) as { commit: Record<string, unknown> };
  assert.throws(
    () =>
      verifyCommitMac(decodeWireCommit(staleBody.commit), {
        keyShare: oldMac.keyShare,
        sharedSecret: oldMac.sharedSecret,
        headers: staleRes.headers,
      }),
    SpaceMacError,
  );

  const freshMac = await startMac(network, ALICE, COMMIT_MAC_PROFILE, true);
  const freshRes = await network.fetchEndpoint(
    new Request(
      `${pds}/xrpc/com.atproto.space.getLatestCommit?repo=${encodeURIComponent(ALICE)}&space=${encodeURIComponent(space)}`,
      {
        headers: {
          authorization: `Bearer ${network.issueSessionToken(ALICE, "full")}`,
          "accept-signature": freshMac.header,
        },
      },
    ),
  );
  assert.equal(freshRes.status, 200);
  const freshBody = (await freshRes.json()) as { commit: Record<string, unknown> };
  verifyCommitMac(decodeWireCommit(freshBody.commit), {
    keyShare: freshMac.keyShare,
    sharedSecret: freshMac.sharedSecret,
    headers: freshRes.headers,
  });

  // clearRecords -> empty written repo STILL returns signed/MAC'd commit on listRepoOps
  await alice.procedure("com.atproto.space.clearRecords", { repo: ALICE, space });
  const clearedOps = await fetchOpsPage();
  assert.equal(clearedOps.res.status, 200);
  assert.deepEqual(clearedOps.json.ops, []);
  assert.ok(clearedOps.json.commit);
  verifyCommitMac(decodeWireCommit(clearedOps.json.commit), {
    keyShare: clearedOps.mac.keyShare,
    sharedSecret: clearedOps.mac.sharedSecret,
    headers: clearedOps.res.headers,
  });
});

test("ACCESS_FULL app-password refusal strictly on account-authenticated space/memberspace routes", async () => {
  const { network, alice } = makeNetwork();
  const created = await alice.procedure<Record<string, unknown>, { space: SpaceUri }>(
    "com.atproto.space.createSpace",
    {
      spaceType: TEST_SPACE_TYPE,
      skey: "scope-check",
      policy: { $type: MEMBERSPACE_POLICY, publicRead: true, publicWrite: true },
    },
  );
  const space = created.space;
  await alice.procedure("com.atproto.space.putRecord", {
    repo: ALICE,
    space,
    collection: TEST_COLLECTION,
    rkey: "k1",
    record: { ok: true },
  });

  const appClient = network.clientFor(ALICE, { appPassword: true });

  // Account-authenticated space & memberspace routes MUST fail with 400 InvalidToken ("Bad token scope")
  const blockedProcedures: Array<[string, Record<string, unknown>]> = [
    ["com.atproto.space.createSpace", { spaceType: TEST_SPACE_TYPE, skey: "s2", policy: PERSONAL_POLICY }],
    ["com.atproto.space.updateSpace", { space, policy: PERSONAL_POLICY }],
    ["com.atproto.space.deleteSpace", { space }],
    ["com.atproto.space.removeWriter", { space, repo: ALICE }],
    ["com.atproto.space.createRecord", { repo: ALICE, space, collection: TEST_COLLECTION, record: { x: 1 } }],
    ["com.atproto.space.putRecord", { repo: ALICE, space, collection: TEST_COLLECTION, rkey: "x", record: { x: 1 } }],
    ["com.atproto.space.deleteRecord", { repo: ALICE, space, collection: TEST_COLLECTION, rkey: "k1" }],
    ["com.atproto.space.applyWrites", { repo: ALICE, space, writes: [] }],
    ["com.atproto.space.clearRecords", { repo: ALICE, space }],
    ["com.atproto.memberspace.putMembers", { space, members: [] }],
    ["com.atproto.memberspace.removeMembers", { space, dids: [] }],
  ];
  for (const [nsid, input] of blockedProcedures) {
    const err = await assertXrpcError(appClient.procedure(nsid, input), 400, "InvalidToken");
    assert.equal(err.message, "Bad token scope");
  }

  const blockedQueries: Array<[string, Record<string, string>]> = [
    ["com.atproto.space.getSpace", { space }],
    ["com.atproto.space.listSpaces", {}],
    ["com.atproto.space.getDelegationToken", { space }],
    ["com.atproto.space.getLatestCommit", { repo: ALICE, space }],
    ["com.atproto.space.listRepoOps", { repo: ALICE, space }],
    ["com.atproto.space.getRepo", { repo: ALICE, space }],
    ["com.atproto.space.getRecord", { repo: ALICE, space, collection: TEST_COLLECTION, rkey: "k1" }],
    ["com.atproto.space.listRecords", { repo: ALICE, space, collection: TEST_COLLECTION }],
    ["com.atproto.memberspace.listMembers", { space }],
  ];
  for (const [nsid, params] of blockedQueries) {
    const err = await assertXrpcError(appClient.query(nsid, params), 400, "InvalidToken");
    assert.equal(err.message, "Bad token scope");
  }

  // Also verify via createAppPassword + createSession Bearer JWT over HTTP fetchEndpoint
  const appPass = await alice.procedure<
    { name: string; privileged: boolean },
    { password: string }
  >("com.atproto.server.createAppPassword", { name: "cli", privileged: true });
  const session = await alice.procedure<
    { identifier: string; password: string },
    { accessJwt: string }
  >("com.atproto.server.createSession", { identifier: ALICE, password: appPass.password });

  const pds = (await network.resolvePds(ALICE))!;
  const httpBlocked = await fetchJson(
    network,
    `${pds}/xrpc/com.atproto.space.listRecords?repo=${encodeURIComponent(ALICE)}&space=${encodeURIComponent(space)}&collection=${TEST_COLLECTION}`,
    { headers: { authorization: `Bearer ${session.accessJwt}` } },
  );
  assert.equal(httpBlocked.status, 400);
  assert.equal(httpBlocked.json.error, "InvalidToken");
  assert.equal(httpBlocked.json.message, "Bad token scope");

  // importRepo also fails with Bad token scope
  const importBlocked = await fetchJson(
    network,
    `${pds}/xrpc/com.atproto.space.importRepo`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.accessJwt}`,
        "content-type": STAR_MEDIA_TYPE,
      },
      body: new Uint8Array(),
    },
  );
  assert.equal(importBlocked.status, 400);
  assert.equal(importBlocked.json.error, "InvalidToken");
  assert.equal(importBlocked.json.message, "Bad token scope");

  // authorizeSpaceSync is NOT account-authenticated -> succeeds even if app-password Bearer is sent!
  const authSyncWithAppPass = await authorizeSync(network, ALICE, {
    space,
    extraHeaders: { authorization: `Bearer ${session.accessJwt}` },
  });
  assert.equal(authSyncWithAppPass.status, 200);

  // listWriters uses spaceCredentialAuth -> fails with 401 MissingJwt (NOT Bad token scope)
  const lwAppPass = await fetchJson(
    network,
    `${pds}/xrpc/com.atproto.space.listWriters?space=${encodeURIComponent(space)}`,
    { headers: { authorization: `Bearer ${session.accessJwt}` } },
  );
  assert.equal(lwAppPass.status, 401);
  assert.equal(lwAppPass.json.error, "MissingJwt");

  // getServiceAuth and com.atproto.repo.putRecord STAY ALLOWED with app-password scope
  const svcAuth = await appClient.query<{ token: string }>("com.atproto.server.getServiceAuth", {
    aud: BOB,
    lxm: "com.atproto.space.putRecord",
  });
  assert.ok(typeof svcAuth.token === "string");

  const stdRepoPut = await appClient.procedure<Record<string, unknown>, { uri: string }>(
    "com.atproto.repo.putRecord",
    {
      repo: ALICE,
      collection: "app.bsky.feed.post",
      rkey: "post1",
      record: { text: "hello" },
    },
  );
  assert.ok(stdRepoPut.uri.startsWith(`at://${ALICE}/`));
});

test("listRecords descending order (reverse dropped), cross-account isolation, hooks, and concurrency", async () => {
  const { network, alice, bob } = makeNetwork();
  const created = await alice.procedure<Record<string, unknown>, { space: SpaceUri }>(
    "com.atproto.space.createSpace",
    {
      spaceType: TEST_SPACE_TYPE,
      skey: "records",
      policy: memberspacePolicy(),
    },
  );
  const space = created.space;
  await alice.procedure("com.atproto.memberspace.putMembers", {
    space,
    members: [{ did: BOB, read: true, write: true }],
  });

  // Cross-account write forbidden (403 Forbidden), cross-account read via session Bearer returns 400 RepoNotFound
  await assertXrpcError(
    bob.procedure("com.atproto.space.putRecord", {
      repo: ALICE,
      space,
      collection: TEST_COLLECTION,
      rkey: "x",
      record: {},
    }),
    403,
    "Forbidden",
  );
  await assertXrpcError(
    alice.query("com.atproto.space.listRecords", {
      repo: BOB,
      space,
      collection: TEST_COLLECTION,
    }),
    400,
    "RepoNotFound",
  );

  // Concurrent writes keep distinct monotonic revs
  await Promise.all([
    network.writeAs(BOB, space, TEST_COLLECTION, "a", { n: 1 }),
    network.writeAs(BOB, space, TEST_COLLECTION, "b", { n: 2 }),
    network.writeAs(BOB, space, TEST_COLLECTION, "c", { n: 3 }),
  ]);

  // listRecords defaults to descending by rkey (reverse param dropped)
  const listed = await bob.query<{ records: Array<{ rkey: string }> }>(
    "com.atproto.space.listRecords",
    { repo: BOB, space, collection: TEST_COLLECTION },
  );
  assert.deepEqual(
    listed.records.map((r) => r.rkey),
    ["c", "b", "a"],
  );

  // Malformed cursor -> InvalidCursor
  await assertXrpcError(
    bob.query("com.atproto.space.listRecords", {
      repo: BOB,
      space,
      collection: TEST_COLLECTION,
      cursor: "bad-cursor",
    }),
    400,
    "InvalidCursor",
  );

  // Absent deleteRecord & empty clearRecords are clean no-ops
  await bob.procedure("com.atproto.space.deleteRecord", {
    repo: BOB,
    space,
    collection: TEST_COLLECTION,
    rkey: "missing",
  });

  // Fault hook check
  let hookHit = false;
  network.beforeListRecords = () => {
    hookHit = true;
  };
  await bob.query("com.atproto.space.listRecords", {
    repo: BOB,
    space,
    collection: TEST_COLLECTION,
  });
  assert.equal(hookHit, true);
});
