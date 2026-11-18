import assert from "node:assert/strict";
import test from "node:test";
import { P256Keypair } from "@atproto/crypto";
import {
  COMMIT_MAC_PROFILE,
  MAC_COVERED_HEADER,
  RECORD_MAC_PROFILE,
  RepoCommit,
  SpaceKemError,
  SpaceMacError,
  SpaceRepoVerificationError,
  createCommitMacHeaders,
  createRecordMacHeaders,
  decapsulate,
  encapsulate,
  formatMacRequest,
  parseMacRequest,
  serializeRecord,
  verifyCommit,
  verifyCommitMac,
  verifyCredentialSig,
  verifyRecord,
  verifyRecordMac,
  writeRepoStar,
} from "@atproto/space";
import { StarParseError } from "@atproto/star";
import { UpstreamResponseTooLargeError } from "@flock/protocol/bounded-json";
import { FakeNetwork } from "./fake-network";
import { dmInboxUri, spaceRecordUri } from "@flock/protocol/keys";
import {
  LTHASH_STATE_BYTES,
  RepoStarLimitError,
  SPACE_CREDENTIAL_LIFETIME_MS,
  SPACE_CREDENTIAL_RENEW_BEFORE_MS,
  SpaceCredentialError,
  computeStarArchiveBytes,
  credentialLifetimeMs,
  exchangeSpaceCredential,
  isAccessLost,
  isCredentialRefused,
  isSpaceDeleted,
  listVerifiedBoundedRecords,
  mintSpaceCredentialWith,
  parseCid,
  serializedRecordBytes,
  starEntryBytes,
  starHeaderBytes,
  varintByteLength,
  verifyRecordCid,
  verifyRecordCidWithSize,
  type SpaceCredential,
} from "@flock/protocol/atproto/space-credential-core";
import { MEMBERSPACE_POLICY } from "@flock/protocol/atproto/space-policy";
import { XrpcError } from "@flock/protocol/atproto/xrpc";

const OWNER = "did:plc:owner";
const READER = "did:plc:reader";
const SPACE = dmInboxUri(OWNER);
const PDS1 = "https://fake-pds.test/pds1";
const COLLECTION = "new.flock.dm.request";

type Respond = (response: Response, request: Request) => Promise<Response> | Response;

async function capture(respond?: Respond) {
  const network = new FakeNetwork();
  network.createAccount(OWNER, "pds1");
  network.createAccount(READER, "pds2");
  await network.clientFor(OWNER).procedure("com.atproto.space.createSpace", {
    spaceType: "new.flock.dm.inbox", skey: "self",
    policy: { $type: MEMBERSPACE_POLICY, publicRead: true, publicWrite: true },
  });
  const requests: Request[] = [];
  const credential = await mintSpaceCredentialWith({
    memberClient: network.clientFor(READER),
    resolvePds: network.resolvePds,
    resolveKemKey: network.resolveKemKey,
    fetchEndpoint: async (request) => {
      requests.push(request.clone());
      const response = await network.fetchEndpoint(request);
      return respond ? respond(response, request) : response;
    },
    generateKey: network.generateKey,
    now: network.now,
  }, SPACE);
  return { network, credential, requests };
}

async function writeRequest(network: FakeNetwork, rkey: string, text = "hello"): Promise<void> {
  await network.clientFor(OWNER).procedure("com.atproto.space.putRecord", { space: SPACE, repo: OWNER, collection: COLLECTION, rkey, record: { text } });
}

const getRecord = (credential: SpaceCredential, rkey: string) =>
  credential.client(PDS1).query<{ uri: string; value: { text: string } }>("com.atproto.space.getRecord", { space: SPACE, repo: OWNER, collection: COLLECTION, rkey });
const getCommit = (credential: SpaceCredential) =>
  credential.client(PDS1).query<{ commit: { rev: string } }>("com.atproto.space.getLatestCommit", { space: SPACE, repo: OWNER });

/** Replaces a JSON response body, keeping its status and headers (the MAC), as a hostile or buggy host would. */
async function altered(response: Response, change: (body: Record<string, unknown>) => void): Promise<Response> {
  const body = await response.clone().json() as Record<string, unknown>;
  change(body);
  return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
}

// --- Credential exchange and use --------------------------------------------------------------------------

test("the credential exchange carries everything in its body: the delegation token and the key to bind, with no authorization or signature", async () => {
  const { requests, credential } = await capture();
  const [exchange] = requests;
  assert.equal(exchange!.headers.has("authorization"), false);
  assert.equal(exchange!.headers.has("signature"), false);
  assert.equal(exchange!.headers.has("signature-input"), false);
  assert.equal(exchange!.headers.has("dpop"), false);
  const body = await exchange!.json() as { space: string; credentialKey: string; delegationToken: string };
  assert.deepEqual(Object.keys(body).sort(), ["credentialKey", "delegationToken", "space"]);
  assert.equal(body.space, SPACE);
  assert.equal(body.credentialKey, credential.key.did());
  assert.match(body.delegationToken, /^delegation-/);
});

test("a credential request uses the Atproto-Space-Credential scheme and a tagged signature over the credential and the space authority audience", async () => {
  const { credential, requests, network } = await capture();
  await credential.client(PDS1).query("com.atproto.space.listWriters", { space: SPACE });
  const read = requests.at(-1)!;
  assert.match(read.headers.get("authorization")!, /^Atproto-Space-Credential eyJ/);
  assert.equal(read.headers.get("atproto-space-audience"), OWNER);
  assert.equal(read.headers.get("signature-input"), 'sig=("authorization" "atproto-space-audience");tag="atproto-space-credential"');
  assert.match(read.headers.get("signature")!, /^sig=:[A-Za-z0-9+/]+={0,2}:$/);
  assert.equal(read.headers.has("dpop"), false);
  assert.equal(credential.expiresAt, network.now() + SPACE_CREDENTIAL_LIFETIME_MS);
  assert.equal(credential.keypair, credential.key);
  await verifyCredentialSig(
    {
      authorization: read.headers.get("authorization") ?? undefined,
      "atproto-space-audience": read.headers.get("atproto-space-audience") ?? undefined,
      "signature-input": read.headers.get("signature-input") ?? undefined,
      signature: read.headers.get("signature") ?? undefined,
    },
    credential.key.did() as Parameters<typeof verifyCredentialSig>[1],
  );
});

test("a request for one repo is addressed to that repo's host, not the space authority", async () => {
  const { credential, requests } = await capture();
  await credential.client("https://fake-pds.test/pds2").query("com.atproto.space.listRecords", { space: SPACE, repo: READER, collection: COLLECTION });
  assert.equal(requests.at(-1)!.headers.get("atproto-space-audience"), READER);
});

test("a non-DID repo query falls back to the space authority audience", async () => {
  const { credential, requests } = await capture();
  await credential.client("https://fake-pds.test/pds2").query("com.atproto.space.listRecords", { space: SPACE, repo: "not-a-did", collection: COLLECTION }).catch(() => undefined);
  assert.equal(requests.at(-1)!.headers.get("atproto-space-audience"), OWNER);
});

test("a POST body naming a repo does not change the audience", async () => {
  const { credential, requests } = await capture();
  await credential.client("https://fake-pds.test/pds2").procedure("com.atproto.space.putRecord", { space: SPACE, repo: READER, collection: COLLECTION, rkey: "x", record: {} }).catch(() => undefined);
  assert.equal(requests.at(-1)!.headers.get("atproto-space-audience"), OWNER);
});

test("the credential lifetime is ten minutes, well under the one-hour protocol ceiling, and renewal opens inside it", () => {
  assert.equal(SPACE_CREDENTIAL_LIFETIME_MS, 600_000);
  assert.ok(SPACE_CREDENTIAL_RENEW_BEFORE_MS > 0 && SPACE_CREDENTIAL_RENEW_BEFORE_MS < SPACE_CREDENTIAL_LIFETIME_MS);
});

// --- MACs on getRecord and getLatestCommit ---------------------------------------------------------------------

test("getRecord asks for a record MAC with a fresh key share per request and returns the verified record", async () => {
  const { network, credential, requests } = await capture();
  await writeRequest(network, "a");
  assert.equal((await getRecord(credential, "a")).value.text, "hello");
  await getRecord(credential, "a");
  const asked = requests.filter((request) => request.url.includes("getRecord")).map((request) => request.headers.get("accept-signature")!);
  assert.equal(asked.length, 2);
  assert.match(asked[0]!, /^mac=\("atproto-space-record";sf\);keyid="did:key:zDn[^"]*";tag="atproto-space-record"$/);
  assert.ok(parseMacRequest(asked[0]!, RECORD_MAC_PROFILE)?.keyShare.startsWith("did:key:zDn"));
  assert.notEqual(asked[0], asked[1], "a key share is never reused");
});

test("getLatestCommit asks for a commit MAC and verifies the commit against the request", async () => {
  const { network, credential, requests } = await capture();
  await writeRequest(network, "a");
  assert.ok((await getCommit(credential)).commit.rev);
  const wanted = requests.filter((request) => request.url.includes("getLatestCommit")).map((request) => request.headers.get("accept-signature")!);
  assert.equal(wanted.length, 1);
  assert.match(wanted[0]!, /^mac=\("atproto-space-commit";sf\);keyid="did:key:zDn[^"]*";tag="atproto-space-commit"$/);
});

test("reads that carry no MAC (listRecords, listWriters) send no MAC request", async () => {
  const { network, credential, requests } = await capture();
  await writeRequest(network, "a");
  await credential.client(PDS1).query("com.atproto.space.listRecords", { space: SPACE, repo: OWNER, collection: COLLECTION });
  await credential.client(PDS1).query("com.atproto.space.listWriters", { space: SPACE });
  assert.equal(requests.slice(1).some((request) => request.headers.has("accept-signature")), false);
});

test("a record whose value was altered after the host computed its MAC is rejected immediately without retrying KEM", async () => {
  const { network, credential, requests } = await capture((response, request) =>
    request.url.includes("getRecord") && response.ok ? altered(response, (body) => { body.value = { text: "forged" }; }) : response);
  await writeRequest(network, "a");
  const before = requests.length;
  await assert.rejects(getRecord(credential, "a"), SpaceRepoVerificationError);
  assert.equal(requests.length - before, 1);
});

test("a record answered for a different uri than the one requested is rejected", async () => {
  const { network, credential } = await capture((response, request) =>
    request.url.includes("getRecord") && response.ok ? altered(response, (body) => { body.uri = `${String(body.uri)}x`; }) : response);
  await writeRequest(network, "a");
  await assert.rejects(getRecord(credential, "a"), SpaceRepoVerificationError);
});

test("a commit with a different repo or space than the request is rejected", async () => {
  for (const field of ["repo", "space"] as const) {
    const { network, credential } = await capture((response, request) =>
      request.url.includes("getLatestCommit") && response.ok ? altered(response, (body) => { (body.commit as Record<string, string>)[field] = field === "repo" ? READER : dmInboxUri(READER); }) : response);
    await writeRequest(network, "a");
    await assert.rejects(getCommit(credential), SpaceRepoVerificationError, field);
  }
});

test("a commit whose data was changed is rejected", async () => {
  const { network, credential } = await capture((response, request) =>
    request.url.includes("getLatestCommit") && response.ok ? altered(response, (body) => { (body.commit as { data: { $bytes: string } }).data = { $bytes: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }; }) : response);
  await writeRequest(network, "a");
  await assert.rejects(getCommit(credential), SpaceMacError);
});

test("a host that ignores the MAC request and sends no MAC header is not trusted", async () => {
  const { network, credential } = await capture((response, request) => {
    if (!request.url.includes("getRecord") || !response.ok) return response;
    const headers = new Headers(response.headers);
    headers.delete("signature");
    headers.delete("signature-input");
    headers.delete(MAC_COVERED_HEADER[RECORD_MAC_PROFILE]);
    return new Response(response.body, { status: response.status, headers });
  });
  await writeRequest(network, "a");
  await assert.rejects(getRecord(credential, "a"), SpaceMacError);
});

test("a MAC of the wrong profile tag is not accepted for a record", async () => {
  const { network, credential } = await capture((response, request) => {
    if (!request.url.includes("getRecord") || !response.ok) return response;
    const headers = new Headers(response.headers);
    headers.set("signature-input", headers.get("signature-input")!.replaceAll(RECORD_MAC_PROFILE, COMMIT_MAC_PROFILE));
    return new Response(response.body, { status: response.status, headers });
  });
  await writeRequest(network, "a");
  await assert.rejects(getRecord(credential, "a"), SpaceMacError);
});

test("a rotated #atproto_kem key is picked up by one forced refresh and the read then succeeds", async () => {
  const { network, credential, requests } = await capture();
  await writeRequest(network, "a");
  await getRecord(credential, "a");
  await network.rotateKemKey(OWNER);
  const before = requests.length;
  assert.equal((await getRecord(credential, "a")).value.text, "hello");
  assert.equal(requests.length - before, 2, "the stale-key attempt is retried once with a refreshed key");
});

test("a host that never produces a verifiable MAC fails after the single retry", async () => {
  const { network, credential, requests } = await capture((response, request) => {
    if (!request.url.includes("getRecord") || !response.ok) return response;
    const headers = new Headers(response.headers);
    headers.set("signature", "mac=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:");
    return new Response(response.body, { status: response.status, headers });
  });
  await writeRequest(network, "a");
  const before = requests.length;
  await assert.rejects(getRecord(credential, "a"), SpaceMacError);
  assert.equal(requests.length - before, 2);
});

test("an error response from a MAC read passes through unchanged", async () => {
  const { credential } = await capture();
  await assert.rejects(getRecord(credential, "missing"), { status: 400, code: "RecordNotFound" });
});

test("a MAC response varies on Accept-Signature and exposes the RFC 9421 MAC headers to browsers", async () => {
  const seen: Array<{ vary: string | null; exposed: string | null }> = [];
  const { network, credential } = await capture((response, request) => {
    if (request.url.includes("getRecord") && response.ok) seen.push({ vary: response.headers.get("vary"), exposed: response.headers.get("access-control-expose-headers") });
    return response;
  });
  await writeRequest(network, "a");
  await getRecord(credential, "a");
  assert.equal(seen.length, 1);
  assert.match(seen[0]!.vary ?? "", /accept-signature/i);
  assert.match(seen[0]!.exposed ?? "", /atproto-space-record/i);
  assert.match(seen[0]!.exposed ?? "", /signature-input/i);
  assert.match(seen[0]!.exposed ?? "", /signature/i);
});

test("RFC 9421 MAC helpers and KEM encapsulation validate valid inputs and throw typed errors on invalid ones", async () => {
  const recipient = await P256Keypair.create({ exportable: true });
  const recipientDid = recipient.did();
  await assert.rejects(encapsulate("not-a-did-key" as never), SpaceKemError);
  assert.throws(() => parseMacRequest('mac=("atproto-space-record";sf);keyid="bad";tag="atproto-space-record"', RECORD_MAC_PROFILE), SpaceMacError);

  const enc = await encapsulate(recipientDid as never);
  const dec = decapsulate(recipient, enc.keyShare);
  assert.deepEqual(enc.sharedSecret, dec);

  const reqHeader = formatMacRequest(RECORD_MAC_PROFILE, enc.keyShare);
  const parsedReq = parseMacRequest(reqHeader, RECORD_MAC_PROFILE);
  assert.ok(parsedReq);

  const { cid, bytes } = await serializeRecord(COLLECTION, "a" as never, { text: "hello" });
  const uri = spaceRecordUri(SPACE, OWNER, COLLECTION, "a") as Parameters<typeof createRecordMacHeaders>[0];
  const verifyUri = uri as Parameters<typeof verifyRecord>[1]["uri"];
  const { headers: recHeadersObj } = createRecordMacHeaders(uri, cid, { ...parsedReq, sharedSecret: dec });
  const recHeaders = new Headers(recHeadersObj);
  verifyRecordMac(uri, cid, { ...enc, headers: recHeaders });
  await verifyRecord({ uri, cid: cid.toString(), value: { text: "hello" } }, { uri: verifyUri, ...enc, headers: recHeaders });
  assert.ok(bytes.byteLength > 0);
  await assert.rejects(
    verifyRecord({ uri, cid: cid.toString(), value: { text: "tampered" } }, { uri: verifyUri, ...enc, headers: recHeaders }),
    SpaceRepoVerificationError,
  );
  assert.throws(
    () => verifyRecordMac(uri, cid, { keyShare: enc.keyShare, sharedSecret: new Uint8Array(32), headers: recHeaders }),
    SpaceMacError,
  );

  const commit = new RepoCommit().add(COLLECTION, "a", cid).toCommit({
    space: SPACE as never,
    repo: OWNER as never,
    rev: "3jzfcijpj2z2a" as never,
  });
  const commitReq = parseMacRequest(formatMacRequest(COMMIT_MAC_PROFILE, enc.keyShare), COMMIT_MAC_PROFILE)!;
  const { headers: commitHeadersObj } = createCommitMacHeaders(commit, { ...commitReq, sharedSecret: dec });
  const commitHeaders = new Headers(commitHeadersObj);
  verifyCommitMac(commit, { ...enc, headers: commitHeaders });
  verifyCommit(commit, { ...enc, headers: commitHeaders, space: SPACE as never, repo: OWNER as never });
  assert.throws(
    () => verifyCommit(commit, { ...enc, headers: commitHeaders, space: SPACE as never, repo: READER as never }),
    SpaceRepoVerificationError,
  );
  assert.throws(
    () => verifyCommitMac(commit, { keyShare: enc.keyShare, sharedSecret: new Uint8Array(32), headers: commitHeaders }),
    SpaceMacError,
  );
});

test("a malformed #atproto_kem key throws SpaceKemError during credentialed reads", async () => {
  const network = new FakeNetwork();
  network.createAccount(OWNER, "pds1");
  network.createAccount(READER, "pds2");
  await network.clientFor(OWNER).procedure("com.atproto.space.createSpace", {
    spaceType: "new.flock.dm.inbox", skey: "self",
    policy: { $type: MEMBERSPACE_POLICY, publicRead: true, publicWrite: true },
  });
  const credential = await mintSpaceCredentialWith({
    memberClient: network.clientFor(READER),
    resolvePds: network.resolvePds,
    resolveKemKey: async () => "not-a-kem-did-key",
    fetchEndpoint: network.fetchEndpoint,
    generateKey: network.generateKey,
    now: network.now,
  }, SPACE);
  await assert.rejects(getCommit(credential), SpaceKemError);
});

// --- Telling a lost grant from a missing record ---------------------------------------------------------------

test("a removed member's credential request fails with the authority's SpaceNotFound code as a 403, and that counts as lost access", async () => {
  const network = new FakeNetwork();
  network.createAccount(OWNER, "pds1");
  network.createAccount(READER, "pds2");
  const owner = network.clientFor(OWNER);
  await owner.procedure("com.atproto.space.createSpace", { spaceType: "new.flock.dm.inbox", skey: "self", policy: { $type: MEMBERSPACE_POLICY } });
  await owner.procedure("com.atproto.memberspace.putMembers", { space: SPACE, members: [{ did: READER, read: true, write: false }] });
  const deps = { memberClient: network.clientFor(READER), resolvePds: network.resolvePds, resolveKemKey: network.resolveKemKey, fetchEndpoint: network.fetchEndpoint, generateKey: network.generateKey, now: network.now };
  await mintSpaceCredentialWith(deps, SPACE);
  await owner.procedure("com.atproto.memberspace.removeMembers", { space: SPACE, dids: [READER] });
  await assert.rejects(mintSpaceCredentialWith(deps, SPACE), (error) => error instanceof SpaceCredentialError && error.code === "SpaceNotFound" && error.status === 403 && isAccessLost(error));
});

test("the exchange reports each refusal the lexicon declares as a denial, sends notify/credentialKey, and keeps non-refusal 400s as XrpcError", async () => {
  const network = new FakeNetwork();
  const key = await network.generateKey();
  const seenBodies: unknown[] = [];
  const notify = { endpoint: "https://notify.example/hook", token: "reg-token" };
  const ok = await exchangeSpaceCredential({
    authorityPds: "https://pds.example",
    delegationToken: "delegation-1",
    clientAttestation: "att-1",
    notify,
    space: SPACE,
    credentialKey: key.did(),
    fetchEndpoint: async (request) => {
      assert.equal(new URL(request.url).pathname, "/xrpc/com.atproto.space.authorizeSpaceSync");
      seenBodies.push(await request.json());
      return Response.json({ credential: "eyJ.cred.sig", spaceRev: "3jzfcijpj2z2a" });
    },
  });
  assert.deepEqual(ok, { credential: "eyJ.cred.sig", spaceRev: "3jzfcijpj2z2a" });
  assert.deepEqual(seenBodies[0], {
    space: SPACE,
    credentialKey: key.did(),
    delegationToken: "delegation-1",
    clientAttestation: "att-1",
    notify,
  });

  const minted = await mintSpaceCredentialWith({
    memberClient: { query: async () => ({ token: "delegation-2" }) } as never,
    resolvePds: async () => "https://pds.example",
    resolveKemKey: async () => "did:key:unused",
    fetchEndpoint: async () => Response.json({ credential: "eyJ.cred.sig", spaceRev: "3jzfcijpj2z2b" }),
    generateKey: async () => key,
  }, SPACE, { notify });
  assert.equal(minted.spaceRev, "3jzfcijpj2z2b");
  assert.deepEqual(minted.notify, notify);

  const answer = (error: string, status = 400) => exchangeSpaceCredential({
    authorityPds: "https://pds.example", delegationToken: "token", space: SPACE, key,
    fetchEndpoint: async () => new Response(JSON.stringify({ error, message: `${error} message` }), { status }),
  });
  for (const code of ["AccountNotAuthorized", "NotAuthorized", "AppNotAuthorized", "SpaceNotFound"]) {
    await assert.rejects(answer(code), (error) => error instanceof SpaceCredentialError && error.status === 403 && error.code === code && isAccessLost(error), code);
  }
  await assert.rejects(answer("SpaceDeleted"), (error) => error instanceof SpaceCredentialError && error.status === 410 && isSpaceDeleted(error));
  for (const code of ["InvalidDelegationToken", "InvalidClientAttestation", "RegistrationNotConfirmed", "RepoTakendown", "RepoDeactivated"]) {
    await assert.rejects(answer(code), (error) => error instanceof XrpcError && error.status === 400 && error.code === code && !isAccessLost(error), code);
  }
});

test("isAccessLost recognizes authorization failures and a deleted space, not a missing record", () => {
  assert.equal(isAccessLost(new SpaceCredentialError("denied", 403, "AccountNotAuthorized")), true);
  assert.equal(isAccessLost(new SpaceCredentialError("expired", 401)), true);
  assert.equal(isAccessLost(new SpaceCredentialError("not found", 403, "SpaceNotFound")), true);
  assert.equal(isAccessLost(new SpaceCredentialError("gone", 410, "SpaceDeleted")), true, "a deleted space can no longer be read either, so its cached copies go");
  assert.equal(isSpaceDeleted(new SpaceCredentialError("gone", 410, "SpaceDeleted")), true);
  assert.equal(isSpaceDeleted(new SpaceCredentialError("denied", 403, "AccountNotAuthorized")), false);
  assert.equal(isSpaceDeleted({ status: 410 }), false, "only the authority's SpaceDeleted answer counts, not any 410");
  assert.equal(isAccessLost({ status: 403 }), true);
  assert.equal(isAccessLost(new XrpcError(403, 'Missing required scope "space:new.flock.app.inbox"', "ScopeMissingError")), false, "a missing OAuth scope is not lost space access");
  assert.equal(isAccessLost({ status: 404 }), false, "a record read that is not found is only a missing record");
  assert.equal(isAccessLost(new Error("boom")), false);
});

// --- Hostile or large responses --------------------------------------------------------------------------------

test("a record whose value carries a $link and a $bytes verifies, because the value is converted back to its Lexicon form before the CID is checked", async () => {
  const { network, credential } = await capture();
  const { cid } = await serializeRecord(COLLECTION, "seed" as never, { text: "seed" });
  const value = { text: "with refs", ref: { $link: cid.toString() }, blob: { $bytes: "AAECAw" } };
  await network.clientFor(OWNER).procedure("com.atproto.space.putRecord", { space: SPACE, repo: OWNER, collection: COLLECTION, rkey: "refs", record: value });
  assert.deepEqual((await getRecord(credential, "refs")).value, value, "the value reaches the caller exactly as the host sent it");
});

test("a record whose $link value was swapped after the host computed its CID is rejected", async () => {
  const { network, credential } = await capture((response, request) =>
    request.url.includes("getRecord") && response.ok ? altered(response, (body) => { (body.value as { ref: { $link: string } }).ref = { $link: "bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi" }; }) : response);
  const { cid } = await serializeRecord(COLLECTION, "seed" as never, { text: "seed" });
  await network.clientFor(OWNER).procedure("com.atproto.space.putRecord", { space: SPACE, repo: OWNER, collection: COLLECTION, rkey: "refs", record: { text: "x", ref: { $link: cid.toString() } } });
  await assert.rejects(getRecord(credential, "refs"), SpaceRepoVerificationError);
});

test("a MAC-bearing response larger than the bound fails at once instead of waiting on a stream nobody reads", async () => {
  const { network, credential } = await capture((response, request) => {
    if (!request.url.includes("getRecord") || !response.ok) return response;
    const headers = new Headers(response.headers);
    headers.set("content-length", String(8 * 1024 * 1024 + 1));
    return new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024)); } }), { status: 200, headers });
  });
  await writeRequest(network, "a");
  const outcome = await Promise.race([
    getRecord(credential, "a").then(() => "resolved", (error: unknown) => error),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 5_000)),
  ]);
  assert.ok(outcome instanceof UpstreamResponseTooLargeError, `expected the size bound to trip, got ${String(outcome)}`);
});

const jwtWith = (claims: Record<string, unknown>) => {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "ES256", typ: "JWT" })}.${part(claims)}.signature`;
};

test("a credential lasts as long as the authority made it last, measured by the authority's own iat and exp", () => {
  assert.equal(credentialLifetimeMs(jwtWith({ iat: 1_000, exp: 1_120 })), 120_000, "a two-minute credential is not kept for ten");
  assert.equal(credentialLifetimeMs(jwtWith({ iat: 1_000, exp: 2_800 })), 1_800_000, "a half-hour credential is kept that long");
  assert.equal(credentialLifetimeMs(jwtWith({ iat: 5_000_000_000, exp: 5_000_000_600 })), 600_000, "the issuer's clock being far from ours does not matter");
});

test("a lifetime the authority claims beyond the protocol ceiling, or that cannot be read, is not used", () => {
  assert.equal(credentialLifetimeMs(jwtWith({ iat: 1_000, exp: 1_000 + 24 * 3600 })), null, "longer than an hour");
  assert.equal(credentialLifetimeMs(jwtWith({ iat: 1_000, exp: 1_000 })), null, "no lifetime");
  assert.equal(credentialLifetimeMs(jwtWith({ iat: 2_000, exp: 1_000 })), null, "expires before it was issued");
  assert.equal(credentialLifetimeMs(jwtWith({ exp: 1_600 })), null, "no iat");
  assert.equal(credentialLifetimeMs(jwtWith({ iat: "now", exp: 1_600 })), null, "iat is not a number");
  assert.equal(credentialLifetimeMs("an-opaque-token"), null, "not a JWT");
  assert.equal(credentialLifetimeMs("a.!!!.c"), null, "payload is not base64 JSON");
});

test("minting keeps a short-lived credential for its own lifetime and renews it proportionally early, and falls back to the default for an opaque one", async () => {
  // #given an authority that issues a 60-second credential, and one that issues an opaque token
  const mintWith = async (credential: string) => mintSpaceCredentialWith({
    memberClient: { query: async () => ({ token: "delegation" }) } as never,
    resolvePds: async () => "https://authority.test",
    resolveKemKey: async () => "did:key:unused",
    fetchEndpoint: async () => Response.json({ credential }),
    generateKey: async () => (await import("@flock/protocol/atproto/space-key")).generateSpaceKey(),
    now: () => 1_000_000,
  }, "at://did:plc:owner/space/new.flock.channel/alpha");

  // #when each is minted at a fixed clock
  const short = await mintWith(jwtWith({ iat: 1_000, exp: 1_060 }));
  const opaque = await mintWith("an-opaque-token");

  // #then the short one lasts 60 s and renews 10 s early (a sixth of its life), the opaque one gets the defaults
  assert.equal(short.expiresAt, 1_000_000 + 60_000);
  assert.equal(short.renewBeforeMs, 10_000);
  assert.equal(opaque.expiresAt, 1_000_000 + SPACE_CREDENTIAL_LIFETIME_MS);
  assert.equal(opaque.renewBeforeMs, SPACE_CREDENTIAL_RENEW_BEFORE_MS);
});

test("only a host refusing the credential itself counts as a refused credential, not a refusal of the reader or a host failure", () => {
  assert.equal(isCredentialRefused(new XrpcError(401, "expired", "InvalidToken")), true);
  assert.equal(isCredentialRefused(new XrpcError(401, "audience", "BadSpaceAudience")), true);
  assert.equal(isCredentialRefused(new XrpcError(400, "not scoped to this space", "InvalidCredential")), true);
  assert.equal(isCredentialRefused(new XrpcError(403, "denied", "Forbidden")), false);
  assert.equal(isCredentialRefused(new XrpcError(502, "bad gateway", "UpstreamFailure")), false);
  assert.equal(isCredentialRefused(new TypeError("fetch failed")), false);
});

// --- listRepoOps MAC gating --------------------------------------------------------------------------------

test("listRepoOps rejects unwritten repos with RepoNotFound and verifies COMMIT_MAC_PROFILE commit + MAC on every page", async () => {
  const { network, credential, requests } = await capture();
  // Unwritten repo: listRepoOps returns XrpcError RepoNotFound (no unsigned empty repo bypass).
  await assert.rejects(
    credential.client(PDS1).query("com.atproto.space.listRepoOps", { space: SPACE, repo: OWNER, limit: 10 }),
    (error) => error instanceof XrpcError && error.code === "RepoNotFound",
  );
  assert.match(requests.at(-1)!.headers.get("accept-signature") ?? "", /^mac=\("atproto-space-commit";sf\);keyid="/);

  // Two writes paginated with limit: 1 -> EVERY page carries commit + RFC 9421 MAC.
  await writeRequest(network, "a", "one");
  await writeRequest(network, "b", "two");
  const page1 = await credential.client(PDS1).query<{ ops: unknown[]; cursor?: string; commit?: { rev: string } }>("com.atproto.space.listRepoOps", {
    space: SPACE, repo: OWNER, limit: 1,
  });
  assert.equal(page1.ops.length, 1);
  assert.ok(page1.cursor);
  assert.ok(page1.commit?.rev);

  const page2 = await credential.client(PDS1).query<{ ops: unknown[]; cursor?: string; commit?: { rev: string } }>("com.atproto.space.listRepoOps", {
    space: SPACE, repo: OWNER, limit: 1, cursor: page1.cursor,
  });
  assert.equal(page2.ops.length, 1);
  assert.ok(page2.commit?.rev);

  let headRev = page2.commit!.rev;
  if (page2.cursor) {
    const page3 = await credential.client(PDS1).query<{ ops: unknown[]; cursor?: string; commit?: { rev: string } }>("com.atproto.space.listRepoOps", {
      space: SPACE, repo: OWNER, limit: 1, cursor: page2.cursor,
    });
    assert.equal(page3.ops.length, 0);
    assert.equal(page3.cursor, undefined);
    assert.ok(page3.commit?.rev);
    headRev = page3.commit!.rev;
  }

  const sinceHead = await credential.client(PDS1).query<{ ops: unknown[]; cursor?: string; commit?: { rev: string } }>("com.atproto.space.listRepoOps", {
    space: SPACE, repo: OWNER, limit: 10, since: headRev,
  });
  assert.equal(sinceHead.ops.length, 0);
  assert.equal(sinceHead.commit?.rev, headRev);

  // Empty written repo after deleting all records still carries commit + MAC.
  await network.deleteAs(OWNER, SPACE, COLLECTION, "a");
  await network.deleteAs(OWNER, SPACE, COLLECTION, "b");
  const cleared = await credential.client(PDS1).query<{ ops: unknown[]; commit?: { rev: string } }>("com.atproto.space.listRepoOps", {
    space: SPACE, repo: OWNER, limit: 10, since: sinceHead.commit!.rev,
  });
  assert.ok(cleared.commit?.rev);
  const emptyCleared = await credential.client(PDS1).query<{ ops: unknown[]; commit?: { rev: string } }>("com.atproto.space.listRepoOps", {
    space: SPACE, repo: OWNER, limit: 10, since: cleared.commit!.rev,
  });
  assert.equal(emptyCleared.ops.length, 0);
  assert.equal(emptyCleared.commit?.rev, cleared.commit!.rev);
});

test("listRepoOps rejects any HTTP 200 without commit, non-array ops, or missing/forged commit MAC; getLatestCommit never passes HTTP 200 without commit or MAC", async () => {
  for (const [label, body] of [
    ["unwritten-style empty ops without commit", { ops: [] }],
    ["empty ops with cursor and no commit", { ops: [], cursor: "r1/0" }],
    ["intermediate ops with cursor and no commit", { ops: [{ rev: "r1", collection: COLLECTION, rkey: "a", cid: "bafy", prev: null }], cursor: "r1/1" }],
    ["non-empty ops without cursor or commit", { ops: [{ rev: "r1", collection: COLLECTION, rkey: "a", cid: "bafy", prev: null }] }],
    ["non-array ops with commit", { ops: null, commit: { ver: 1, repo: OWNER, space: SPACE, rev: "r1", data: { $bytes: "AAAA" } } }],
  ] as const) {
    const { network, credential } = await capture((response, request) => {
      if (!request.url.includes("listRepoOps") || !response.ok) return response;
      const headers = new Headers(response.headers);
      headers.delete("signature");
      headers.delete("signature-input");
      return new Response(JSON.stringify(body), { status: 200, headers });
    });
    await writeRequest(network, "a");
    await assert.rejects(
      credential.client(PDS1).query("com.atproto.space.listRepoOps", { space: SPACE, repo: OWNER, limit: 10 }),
      SpaceRepoVerificationError,
      label,
    );
  }

  // listRepoOps page with commit but missing or wrong-tag MAC header must fail SpaceMacError.
  for (const tamper of ["missing-mac", "wrong-tag"] as const) {
    const { network, credential } = await capture((response, request) => {
      if (!request.url.includes("listRepoOps") || !response.ok) return response;
      const headers = new Headers(response.headers);
      if (tamper === "missing-mac") {
        headers.delete("signature");
        headers.delete("signature-input");
      } else {
        headers.set("signature-input", headers.get("signature-input")!.replaceAll(COMMIT_MAC_PROFILE, RECORD_MAC_PROFILE));
      }
      return new Response(response.body, { status: 200, headers });
    });
    await writeRequest(network, "a");
    await assert.rejects(
      credential.client(PDS1).query("com.atproto.space.listRepoOps", { space: SPACE, repo: OWNER, limit: 10 }),
      SpaceMacError,
      tamper,
    );
  }

  // Rotated KEM key on listRepoOps triggers one forced refresh and succeeds.
  {
    const { network, credential, requests } = await capture();
    await writeRequest(network, "a");
    await getCommit(credential); // Prime KEM cache
    await network.rotateKemKey(OWNER);
    const before = requests.length;
    const result = await credential.client(PDS1).query<{ ops: unknown[]; commit?: { rev: string } }>("com.atproto.space.listRepoOps", {
      space: SPACE, repo: OWNER, limit: 10,
    });
    assert.equal(result.ops.length, 1);
    assert.ok(result.commit?.rev);
    assert.equal(requests.length - before, 2);
  }

  // getLatestCommit HTTP 200 without commit -> SpaceRepoVerificationError; without MAC -> SpaceMacError.
  {
    const { network, credential } = await capture((response, request) => {
      if (!request.url.includes("getLatestCommit") || !response.ok) return response;
      return new Response(JSON.stringify({ ops: [] }), { status: 200, headers: response.headers });
    });
    await writeRequest(network, "a");
    await assert.rejects(getCommit(credential), SpaceRepoVerificationError);
  }
  {
    const { network, credential } = await capture((response, request) => {
      if (!request.url.includes("getLatestCommit") || !response.ok) return response;
      const headers = new Headers(response.headers);
      headers.delete("signature");
      headers.delete("signature-input");
      return new Response(response.body, { status: 200, headers });
    });
    await writeRequest(network, "a");
    await assert.rejects(getCommit(credential), SpaceMacError);
  }
});

// --- fetchVerifiedRepoStar & verifyRecordCid --------------------------------------------------------------

test("fetchVerifiedRepoStar verifies STAR archive, computes 2048B LtHash state and 32B digest, handles $link/$bytes and empty repos", async () => {
  const { network, credential } = await capture();
  const { cid: seedCid } = await serializeRecord(COLLECTION, "seed" as never, { text: "seed" });
  const refValue = { text: "with refs", ref: { $link: seedCid.toString() }, blob: { $bytes: "AAECAw" } };
  await network.clientFor(OWNER).procedure("com.atproto.space.putRecord", {
    space: SPACE, repo: OWNER, collection: COLLECTION, rkey: "b", record: refValue,
  });
  await writeRequest(network, "a", "alpha");

  const star = await credential.fetchVerifiedRepoStar(PDS1, {
    space: SPACE, repo: OWNER, maxBytes: 1024 * 1024, maxRecords: 100,
  });
  assert.equal(star.setHash.byteLength, LTHASH_STATE_BYTES);
  assert.equal(star.commitDigest.byteLength, 32);
  assert.deepEqual(star.commit.data, star.commitDigest);
  assert.deepEqual(star.records.map((r) => [r.collection, r.rkey]), [[COLLECTION, "a"], [COLLECTION, "b"]]);
  assert.deepEqual(star.records[1]!.record, refValue);

  const expectedSetHash = RepoCommit.fromRecords(
    star.records.map((r) => ({ collection: r.collection as never, rkey: r.rkey as never, cid: parseCid(r.cid) })),
  ).setHash.state();
  assert.deepEqual(star.setHash, expectedSetHash);

  // Every returned record passes verifyRecordCid.
  for (const r of star.records) {
    assert.equal(await verifyRecordCid(r.collection, r.rkey, r.record, r.cid), true);
  }

  // Empty written repo (after deleting all records) verifies cleanly with 2048 zero bytes.
  await network.deleteAs(OWNER, SPACE, COLLECTION, "a");
  await network.deleteAs(OWNER, SPACE, COLLECTION, "b");
  const emptyStar = await credential.fetchVerifiedRepoStar(PDS1, {
    space: SPACE, repo: OWNER, maxBytes: 1024 * 1024, maxRecords: 100,
  });
  assert.deepEqual(emptyStar.records, []);
  assert.deepEqual(emptyStar.setHash, new Uint8Array(LTHASH_STATE_BYTES));
});

test("fetchVerifiedRepoStar retries once on rotated #atproto_kem key and rejects forged/missing MAC or tampered STAR body", async () => {
  // Rotated KEM key triggers 1 forced refresh and succeeds; request carries Accept: application/vnd.dasl.star.
  {
    const { network, credential, requests } = await capture();
    await writeRequest(network, "a", "hello");
    await getCommit(credential); // Prime KEM cache
    await network.rotateKemKey(OWNER);
    const before = requests.length;
    const star = await credential.fetchVerifiedRepoStar(PDS1, {
      space: SPACE, repo: OWNER, maxBytes: 1024 * 1024, maxRecords: 100,
    });
    assert.equal(star.records.length, 1);
    assert.equal(requests.length - before, 2);
    assert.equal(requests.at(-1)!.headers.get("accept"), "application/vnd.dasl.star");
  }

  // Missing MAC header fails SpaceMacError.
  {
    const { network, credential } = await capture((response, request) => {
      if (!request.url.includes("getRepo") || !response.ok) return response;
      const headers = new Headers(response.headers);
      headers.delete("signature");
      headers.delete("signature-input");
      return new Response(response.body, { status: 200, headers });
    });
    await writeRequest(network, "a");
    await assert.rejects(
      credential.fetchVerifiedRepoStar(PDS1, { space: SPACE, repo: OWNER, maxBytes: 1024 * 1024, maxRecords: 100 }),
      SpaceMacError,
    );
  }

  // Forged / wrong-tag MAC header fails SpaceMacError.
  {
    const { network, credential } = await capture((response, request) => {
      if (!request.url.includes("getRepo") || !response.ok) return response;
      const headers = new Headers(response.headers);
      headers.set("signature-input", headers.get("signature-input")!.replaceAll(COMMIT_MAC_PROFILE, RECORD_MAC_PROFILE));
      return new Response(response.body, { status: 200, headers });
    });
    await writeRequest(network, "a");
    await assert.rejects(
      credential.fetchVerifiedRepoStar(PDS1, { space: SPACE, repo: OWNER, maxBytes: 1024 * 1024, maxRecords: 100 }),
      SpaceMacError,
    );
  }

  // Truncated STAR stream (header verified, EOF before all records matching commit) fails SpaceRepoVerificationError or StarParseError.
  {
    const { network, credential } = await capture(async (response, request) => {
      if (!request.url.includes("getRepo") || !response.ok) return response;
      const full = new Uint8Array(await response.arrayBuffer());
      // Keep magic + metadata header only, drop the record pair bytes.
      const truncated = full.subarray(0, full.length - 10);
      return new Response(truncated, { status: 200, headers: response.headers });
    });
    await writeRequest(network, "a", "hello");
    await assert.rejects(
      credential.fetchVerifiedRepoStar(PDS1, { space: SPACE, repo: OWNER, maxBytes: 1024 * 1024, maxRecords: 100 }),
      (error) => error instanceof SpaceRepoVerificationError || error instanceof StarParseError,
    );
  }

  // Unwritten repo returns XrpcError RepoNotFound.
  {
    const { credential } = await capture();
    await assert.rejects(
      credential.fetchVerifiedRepoStar(PDS1, { space: SPACE, repo: OWNER, maxBytes: 1024 * 1024, maxRecords: 100 }),
      (error) => error instanceof XrpcError && error.code === "RepoNotFound",
    );
  }
});

test("fetchVerifiedRepoStar enforces maxBytes and maxRecords mid-stream before buffering unbounded bytes", async () => {
  // Authentic chunked STAR stream without content-length must abort mid-stream once maxBytes is exceeded.
  {
    let pulls = 0;
    let canceled = false;
    const { network, credential } = await capture(async (response, request) => {
      if (!request.url.includes("getRepo") || !response.ok) return response;
      const full = new Uint8Array(await response.arrayBuffer());
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      let offset = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          if (offset >= full.byteLength) {
            controller.close();
            return;
          }
          const end = Math.min(offset + 512, full.byteLength);
          controller.enqueue(full.subarray(offset, end));
          offset = end;
        },
        cancel() {
          canceled = true;
        },
      });
      return new Response(stream, { status: 200, headers });
    });
    for (let i = 0; i < 8; i += 1) await writeRequest(network, `big${i}`, "x".repeat(1_000));
    await assert.rejects(
      credential.fetchVerifiedRepoStar(PDS1, { space: SPACE, repo: OWNER, maxBytes: 2048, maxRecords: 100 }),
      (error) => error instanceof RepoStarLimitError && error instanceof UpstreamResponseTooLargeError && error.kind === "bytes",
    );
    assert.equal(canceled, true, "oversized STAR stream is canceled");
    assert.ok(pulls <= 6, `expected early abort, got ${pulls} pulls`);
  }

  // Content-length exceeding maxBytes aborts without reading body.
  {
    const { network, credential } = await capture((response, request) => {
      if (!request.url.includes("getRepo") || !response.ok) return response;
      const headers = new Headers(response.headers);
      headers.set("content-length", String(100_000));
      return new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(128)); } }), { status: 200, headers });
    });
    await writeRequest(network, "a");
    await assert.rejects(
      credential.fetchVerifiedRepoStar(PDS1, { space: SPACE, repo: OWNER, maxBytes: 1024, maxRecords: 100 }),
      (error) => error instanceof RepoStarLimitError && error.kind === "bytes",
    );
  }

  // maxRecords exceeded mid-stream aborts before consuming remaining records.
  {
    const { network, credential } = await capture();
    for (let i = 0; i < 5; i += 1) await writeRequest(network, `r${i}`, `msg ${i}`);
    await assert.rejects(
      credential.fetchVerifiedRepoStar(PDS1, { space: SPACE, repo: OWNER, maxBytes: 1024 * 1024, maxRecords: 3 }),
      (error) => error instanceof RepoStarLimitError && error instanceof UpstreamResponseTooLargeError && error.kind === "records",
    );
  }

  // Pre-aborted signal aborts cleanly without fetching.
  {
    const { network, credential, requests } = await capture();
    await writeRequest(network, "a");
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const before = requests.length;
    await assert.rejects(
      credential.fetchVerifiedRepoStar(PDS1, { space: SPACE, repo: OWNER, maxBytes: 1024 * 1024, maxRecords: 10, signal: controller.signal }),
      /cancelled/,
    );
    assert.equal(requests.length, before);
  }
});

test("verifyRecordCid checks canonical DRISL CID and returns false cleanly on mismatches or malformed inputs", async () => {
  const { cid: seedCid } = await serializeRecord(COLLECTION, "seed" as never, { text: "seed" });
  const value = { text: "hello", ref: { $link: seedCid.toString() }, blob: { $bytes: "AAECAw" } };
  const { cid } = await serializeRecord(COLLECTION, "a" as never, { text: "hello", ref: seedCid, blob: new Uint8Array([0, 1, 2, 3]) });

  assert.equal(await verifyRecordCid(COLLECTION, "a", value, cid.toString()), true);
  assert.equal(await verifyRecordCid(COLLECTION, "a", { ...value, text: "tampered" }, cid.toString()), false);
  assert.equal(await verifyRecordCid(COLLECTION, "a", value, "not-a-cid"), false);
  assert.equal(await verifyRecordCid(COLLECTION, "a", value, seedCid.toString()), false);
  assert.equal(await verifyRecordCid(COLLECTION, "a", { badLink: { $link: "invalid" } }, cid.toString()), false);
  assert.equal(await verifyRecordCid(COLLECTION, "a", { badFloat: 1.5 }, cid.toString()), false);
  assert.equal(await verifyRecordCid("", "a", value, cid.toString()), false);
  assert.equal(await verifyRecordCid(COLLECTION, "", value, cid.toString()), false);
  assert.equal(await verifyRecordCid(COLLECTION, "a", null as never, cid.toString()), false);
  assert.equal(await verifyRecordCid(COLLECTION, "a", [] as never, cid.toString()), false);
});

test("listVerifiedBoundedRecords enforces aggregate byte and record limits across paginated listRecords responses", async () => {
  const { network, credential } = await capture();
  const payloadText = "x".repeat(400);
  for (let i = 0; i < 6; i += 1) {
    await writeRequest(network, `r${i}`, `${payloadText}-${i}`);
  }
  const oneSize = await serializedRecordBytes(COLLECTION, "r0", { text: `${payloadText}-0` });
  assert.ok(oneSize > 400);

  const rawStarBytes = await credential.fetchVerifiedRepoStar(PDS1, { space: SPACE, repo: OWNER, maxBytes: 1024 * 1024, maxRecords: 100 });
  const encodedStarChunks: Uint8Array[] = [];
  const serializedEntries = await Promise.all(
    rawStarBytes.records.map(async (entry) =>
      serializeRecord(entry.collection as never, entry.rkey as never, entry.record as never),
    ),
  );
  // Note: writeRepoStar requires strict UTF-8 path order; r0..r5 are already sorted.
  serializedEntries.sort((a, b) => (a.rkey < b.rkey ? -1 : a.rkey > b.rkey ? 1 : 0));
  for await (const chunk of writeRepoStar(rawStarBytes.commit, serializedEntries)) encodedStarChunks.push(chunk);
  const expectedArchiveBytes = encodedStarChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);

  const emptyChunks: Uint8Array[] = [];
  for await (const chunk of writeRepoStar(rawStarBytes.commit, [])) emptyChunks.push(chunk);
  assert.equal(await starHeaderBytes(rawStarBytes.commit), emptyChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));

  // Within both caps succeeds and returns exact STAR archive byte length matching writeRepoStar!
  const full = await listVerifiedBoundedRecords(credential.client(PDS1), {
    space: SPACE,
    repo: OWNER,
    maxRecords: 10,
    maxBytes: expectedArchiveBytes,
    commit: rawStarBytes.commit,
  });
  assert.equal(full.records.length, 6);
  assert.equal(full.totalBytes, expectedArchiveBytes);
  assert.equal(
    await computeStarArchiveBytes(rawStarBytes.commit, full.records),
    expectedArchiveBytes,
    "computeStarArchiveBytes must match writeRepoStar byteLength byte-for-byte",
  );
  assert.equal(varintByteLength(0), 1);
  assert.equal(varintByteLength(127), 1);
  assert.equal(varintByteLength(128), 2);
  assert.equal(
    (await starHeaderBytes(rawStarBytes.commit)) +
      full.records.reduce((acc, rec) => acc + starEntryBytes(rec.collection, rec.rkey, rec.byteLength), 0),
    expectedArchiveBytes,
  );

  // maxBytes = expectedArchiveBytes - 1 rejects right at the exact STAR byte boundary.
  await assert.rejects(
    listVerifiedBoundedRecords(credential.client(PDS1), {
      space: SPACE,
      repo: OWNER,
      maxRecords: 100,
      maxBytes: expectedArchiveBytes - 1,
      commit: rawStarBytes.commit,
    }),
    (error) => error instanceof RepoStarLimitError && error instanceof UpstreamResponseTooLargeError && error.kind === "bytes",
  );

  // > maxRecords throws RepoStarLimitError("records", maxRecords) (including maxRecords === 0).
  await assert.rejects(
    listVerifiedBoundedRecords(credential.client(PDS1), {
      space: SPACE,
      repo: OWNER,
      maxRecords: 4,
      maxBytes: 1024 * 1024,
    }),
    (error) => error instanceof RepoStarLimitError && error.kind === "records",
  );
  await assert.rejects(
    listVerifiedBoundedRecords(credential.client(PDS1), {
      space: SPACE,
      repo: OWNER,
      maxRecords: 0,
      maxBytes: 1024 * 1024,
    }),
    (error) => error instanceof RepoStarLimitError && error.kind === "records",
  );

  const r0Record = full.records.find((r) => r.rkey === "r0");
  assert.ok(r0Record);
  const checkWithSize = await verifyRecordCidWithSize(COLLECTION, "r0", r0Record.value, r0Record.cid);
  assert.deepEqual(checkWithSize, { ok: true, byteLength: oneSize });
});
