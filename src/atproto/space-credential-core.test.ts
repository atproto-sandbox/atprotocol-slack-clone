import assert from "node:assert/strict";
import test from "node:test";
import { COMMIT_MAC_TYPE, MAC_HEADER, RECORD_MAC_TYPE, SpaceMacError, WANT_MAC_HEADER, parseMacHeader, serializeRecord } from "@atproto/space";
import { UpstreamResponseTooLargeError } from "@/lib/bounded-json";
import { FakeDmNetwork } from "@/dm/testing/fake-pds";
import { dmInboxUri } from "@/protocol/keys";
import { credentialLifetimeMs, exchangeSpaceCredential, isAccessLost, isCredentialRefused, isSpaceDeleted, mintSpaceCredentialWith, SPACE_CREDENTIAL_LIFETIME_MS, SPACE_CREDENTIAL_RENEW_BEFORE_MS, SpaceCredentialError, type SpaceCredential } from "./space-credential-core";
import { MEMBERSPACE_POLICY } from "./space-policy";
import { XrpcError } from "./xrpc";

const OWNER = "did:plc:owner";
const READER = "did:plc:reader";
const SPACE = dmInboxUri(OWNER);
const PDS1 = "https://fake-pds.test/pds1";
const COLLECTION = "org.slack.dm.request";

type Respond = (response: Response, request: Request) => Promise<Response> | Response;

async function capture(respond?: Respond) {
  const network = new FakeDmNetwork();
  network.createAccount(OWNER, "pds1");
  network.createAccount(READER, "pds2");
  await network.clientFor(OWNER).procedure("com.atproto.space.createSpace", {
    spaceType: "org.slack.dm.inbox", skey: "self",
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

async function writeRequest(network: FakeDmNetwork, rkey: string, text = "hello"): Promise<void> {
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
  const body = await exchange!.json() as { space: string; credentialKid: string; delegationToken: string };
  assert.deepEqual(Object.keys(body).sort(), ["credentialKid", "delegationToken", "space"]);
  assert.equal(body.space, SPACE);
  assert.equal(body.credentialKid, credential.key.did());
  assert.match(body.delegationToken, /^delegation-/);
});

test("a credential request uses the Atproto-Space-Credential scheme and a tagged signature over the credential and the space authority audience", async () => {
  const { credential, requests, network } = await capture();
  await credential.client(PDS1).query("com.atproto.space.listRepos", { space: SPACE });
  const read = requests.at(-1)!;
  assert.match(read.headers.get("authorization")!, /^Atproto-Space-Credential credential-/);
  assert.equal(read.headers.get("atproto-space-audience"), OWNER);
  assert.equal(read.headers.get("signature-input"), 'atproto-space-credential=("authorization" "atproto-space-audience");tag="atproto-space-credential"');
  assert.match(read.headers.get("signature")!, /^atproto-space-credential=:[A-Za-z0-9+/]+={0,2}:$/);
  assert.equal(read.headers.has("dpop"), false);
  assert.equal(credential.expiresAt, network.now() + SPACE_CREDENTIAL_LIFETIME_MS);
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
  const asked = requests.filter((request) => request.url.includes("getRecord")).map((request) => request.headers.get(WANT_MAC_HEADER)!);
  assert.equal(asked.length, 2);
  assert.match(asked[0]!, /^type="atproto-space-record", ver=1, key_share="did:key:zDn/);
  assert.notEqual(asked[0], asked[1], "a key share is never reused");
});

test("getLatestCommit asks for a commit MAC and verifies the commit against the request", async () => {
  const { network, credential, requests } = await capture();
  await writeRequest(network, "a");
  assert.ok((await getCommit(credential)).commit.rev);
  const wanted = requests.filter((request) => request.url.includes("getLatestCommit")).map((request) => request.headers.get(WANT_MAC_HEADER)!);
  assert.equal(wanted.length, 1);
  assert.match(wanted[0]!, /^type="atproto-space-repo", ver=1, key_share=/);
});

test("reads that carry no MAC (listRecords, listRepos) send no MAC request", async () => {
  const { network, credential, requests } = await capture();
  await writeRequest(network, "a");
  await credential.client(PDS1).query("com.atproto.space.listRecords", { space: SPACE, repo: OWNER, collection: COLLECTION });
  await credential.client(PDS1).query("com.atproto.space.listRepos", { space: SPACE });
  assert.equal(requests.slice(1).some((request) => request.headers.has(WANT_MAC_HEADER)), false);
});

test("a record whose value was altered after the host computed its MAC is rejected", async () => {
  const { network, credential } = await capture((response, request) =>
    request.url.includes("getRecord") && response.ok ? altered(response, (body) => { body.value = { text: "forged" }; }) : response);
  await writeRequest(network, "a");
  await assert.rejects(getRecord(credential, "a"), (error) => error instanceof SpaceMacError && /failed MAC verification/.test(error.message));
});

test("a record answered for a different uri than the one requested is rejected", async () => {
  const { network, credential } = await capture((response, request) =>
    request.url.includes("getRecord") && response.ok ? altered(response, (body) => { body.uri = `${String(body.uri)}x`; }) : response);
  await writeRequest(network, "a");
  await assert.rejects(getRecord(credential, "a"), SpaceMacError);
});

test("a commit with a different repo or space than the request is rejected", async () => {
  for (const field of ["repo", "space"] as const) {
    const { network, credential } = await capture((response, request) =>
      request.url.includes("getLatestCommit") && response.ok ? altered(response, (body) => { (body.commit as Record<string, string>)[field] = field === "repo" ? READER : dmInboxUri(READER); }) : response);
    await writeRequest(network, "a");
    await assert.rejects(getCommit(credential), SpaceMacError, field);
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
    headers.delete(MAC_HEADER);
    return new Response(response.body, { status: response.status, headers });
  });
  await writeRequest(network, "a");
  await assert.rejects(getRecord(credential, "a"), SpaceMacError);
});

test("a MAC of the wrong type is not accepted for a record", async () => {
  const { network, credential } = await capture((response, request) => {
    if (!request.url.includes("getRecord") || !response.ok) return response;
    const headers = new Headers(response.headers);
    headers.set(MAC_HEADER, headers.get(MAC_HEADER)!.replace(RECORD_MAC_TYPE, COMMIT_MAC_TYPE));
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
  const { network, credential, requests } = await capture((response, request) =>
    request.url.includes("getRecord") && response.ok ? altered(response, (body) => { body.value = { text: "forged" }; }) : response);
  await writeRequest(network, "a");
  const before = requests.length;
  await assert.rejects(getRecord(credential, "a"), SpaceMacError);
  assert.equal(requests.length - before, 2);
});

test("an error response from a MAC read passes through unchanged", async () => {
  const { credential } = await capture();
  await assert.rejects(getRecord(credential, "missing"), { status: 400, code: "RecordNotFound" });
});

test("a MAC response varies on the MAC request header and exposes the MAC header to browsers", async () => {
  const seen: Array<{ vary: string | null; exposed: string | null }> = [];
  const { network, credential } = await capture((response, request) => {
    if (request.url.includes("getRecord") && response.ok) seen.push({ vary: response.headers.get("vary"), exposed: response.headers.get("access-control-expose-headers") });
    return response;
  });
  await writeRequest(network, "a");
  await getRecord(credential, "a");
  assert.equal(seen.length, 1);
  assert.match(seen[0]!.vary ?? "", new RegExp(WANT_MAC_HEADER, "i"));
  assert.match(seen[0]!.exposed ?? "", new RegExp(MAC_HEADER, "i"));
});

test("the MAC header the fake PDS returns parses as a record MAC", async () => {
  const { network, credential } = await capture((response, request) => {
    if (request.url.includes("getRecord") && response.ok) assert.ok(parseMacHeader(response.headers.get(MAC_HEADER) ?? undefined, RECORD_MAC_TYPE).length === 32);
    return response;
  });
  await writeRequest(network, "a");
  await getRecord(credential, "a");
});

// --- Telling a lost grant from a missing record ---------------------------------------------------------------

test("a removed member's credential request fails with the authority's SpaceNotFound code as a 403, and that counts as lost access", async () => {
  const network = new FakeDmNetwork();
  network.createAccount(OWNER, "pds1");
  network.createAccount(READER, "pds2");
  const owner = network.clientFor(OWNER);
  await owner.procedure("com.atproto.space.createSpace", { spaceType: "org.slack.dm.inbox", skey: "self", policy: { $type: MEMBERSPACE_POLICY } });
  await owner.procedure("com.atproto.memberspace.putMember", { space: SPACE, did: READER, read: true, write: false });
  const deps = { memberClient: network.clientFor(READER), resolvePds: network.resolvePds, resolveKemKey: network.resolveKemKey, fetchEndpoint: network.fetchEndpoint, generateKey: network.generateKey, now: network.now };
  await mintSpaceCredentialWith(deps, SPACE);
  await owner.procedure("com.atproto.memberspace.removeMember", { space: SPACE, did: READER });
  await assert.rejects(mintSpaceCredentialWith(deps, SPACE), (error) => error instanceof SpaceCredentialError && error.code === "SpaceNotFound" && error.status === 403 && isAccessLost(error));
});

test("the exchange reports each refusal the lexicon declares as a denial, and a malformed request as its own error", async () => {
  const network = new FakeDmNetwork();
  const key = await network.generateKey();
  const answer = (error: string, status = 400) => exchangeSpaceCredential({
    authorityPds: "https://pds.example", delegationToken: "token", space: SPACE, key,
    fetchEndpoint: async () => new Response(JSON.stringify({ error, message: `${error} message` }), { status }),
  });
  for (const code of ["UserNotAuthorized", "NotAuthorized", "AppNotAuthorized", "SpaceNotFound"]) {
    await assert.rejects(answer(code), (error) => error instanceof SpaceCredentialError && error.status === 403 && error.code === code && isAccessLost(error), code);
  }
  await assert.rejects(answer("SpaceDeleted"), (error) => error instanceof SpaceCredentialError && error.status === 410 && isSpaceDeleted(error));
  for (const code of ["InvalidDelegationToken", "InvalidClientAttestation"]) {
    await assert.rejects(answer(code), (error) => error instanceof XrpcError && error.status === 400 && error.code === code && !isAccessLost(error), code);
  }
});

test("isAccessLost recognizes authorization failures and a deleted space, not a missing record", () => {
  assert.equal(isAccessLost(new SpaceCredentialError("denied", 403, "UserNotAuthorized")), true);
  assert.equal(isAccessLost(new SpaceCredentialError("expired", 401)), true);
  assert.equal(isAccessLost(new SpaceCredentialError("not found", 403, "SpaceNotFound")), true);
  assert.equal(isAccessLost(new SpaceCredentialError("gone", 410, "SpaceDeleted")), true, "a deleted space can no longer be read either, so its cached copies go");
  assert.equal(isSpaceDeleted(new SpaceCredentialError("gone", 410, "SpaceDeleted")), true);
  assert.equal(isSpaceDeleted(new SpaceCredentialError("denied", 403, "UserNotAuthorized")), false);
  assert.equal(isSpaceDeleted({ status: 410 }), false, "only the authority's SpaceDeleted answer counts, not any 410");
  assert.equal(isAccessLost({ status: 403 }), true);
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
  await assert.rejects(getRecord(credential, "refs"), SpaceMacError);
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
    generateKey: async () => (await import("./space-key")).generateSpaceKey(),
    now: () => 1_000_000,
  }, "at://did:plc:owner/space/org.slack.channel/alpha");

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
