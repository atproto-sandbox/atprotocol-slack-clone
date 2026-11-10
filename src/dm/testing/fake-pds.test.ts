import assert from "node:assert/strict";
import test from "node:test";
import { createSpaceSigHeaders } from "@atproto/space";
import { mintSpaceCredentialWith, SpaceCredentialError, type SpaceCredentialDeps } from "@/atproto/space-credential-core";
import { generateSpaceKey, type SpaceKey } from "@/atproto/space-key";
import { MEMBERSPACE_POLICY, memberspacePolicy } from "@/atproto/space-policy";
import { dmInboxUri, type Did } from "@/protocol/keys";
import { FakeDmNetwork } from "./fake-pds";

const OWNER = "did:plc:owner";
const READER = "did:plc:reader";
const OUTSIDER = "did:plc:outsider";
const SPACE = dmInboxUri(OWNER);
const PUBLIC_READ = { $type: MEMBERSPACE_POLICY, publicRead: true, publicWrite: false };

type Tamper = (request: Request) => Promise<Request> | Request;

async function setup(tamper?: Tamper, policy: unknown = PUBLIC_READ) {
  const network = new FakeDmNetwork();
  for (const [did, host] of [[OWNER, "pds1"], [READER, "pds2"], [OUTSIDER, "pds3"]] as const) network.createAccount(did, host);
  await network.clientFor(OWNER).procedure("com.atproto.space.createSpace", { spaceType: "new.flock.dm.inbox", skey: "self", policy });
  const minted: SpaceKey[] = [];
  const deps: SpaceCredentialDeps = {
    memberClient: network.clientFor(READER),
    resolvePds: network.resolvePds,
    resolveKemKey: network.resolveKemKey,
    fetchEndpoint: async (request) => network.fetchEndpoint(tamper ? await tamper(request) : request),
    generateKey: async () => {
      const key = await network.generateKey();
      minted.push(key);
      return key;
    },
    now: network.now,
  };
  return { network, deps, mintedKey: () => minted[0]! };
}

function without(request: Request, header: string): Request {
  const headers = new Headers(request.headers);
  headers.delete(header);
  return new Request(request, { headers });
}

function withHeader(request: Request, name: string, value: string): Request {
  const headers = new Headers(request.headers);
  headers.set(name, value);
  return new Request(request, { headers });
}

const isExchange = (request: Request) => request.url.includes("getSpaceCredential");

async function readRepos(deps: SpaceCredentialDeps) {
  const credential = await mintSpaceCredentialWith(deps, SPACE);
  return credential.client("https://fake-pds.test/pds1").query("com.atproto.space.listRepos", { space: SPACE });
}

/** A raw exchange, as any client (or an attacker) could send it: no authorization, everything in the body. */
async function exchange(network: FakeDmNetwork, body: Record<string, unknown>): Promise<{ status: number; body: { credential?: string; error?: string } }> {
  const response = await network.fetchEndpoint(new Request("https://fake-pds.test/pds1/xrpc/com.atproto.space.getSpaceCredential".replace("/pds1", ""), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  return { status: response.status, body: await response.json() as { credential?: string; error?: string } };
}

async function delegationFor(network: FakeDmNetwork, did: string, space = SPACE): Promise<string> {
  return (await network.clientFor(did).query<{ token: string }>("com.atproto.space.getDelegationToken", { space })).token;
}

test("a correctly signed exchange and credential request is accepted", async () => {
  const { deps } = await setup();
  assert.deepEqual(await readRepos(deps), { repos: [] });
});

// --- The exchange: everything is in the body ----------------------------------------------------------------

test("the exchange accepts a delegation token in its body and binds the credential to the named key", async () => {
  const { network } = await setup();
  const key = await generateSpaceKey();
  const result = await exchange(network, { space: SPACE, credentialKid: key.did(), delegationToken: await delegationFor(network, READER) });
  assert.equal(result.status, 200);
  assert.ok(result.body.credential);
});

test("the exchange refuses a bad, wrong-space or missing-kid request", async () => {
  const { network } = await setup();
  const key = await generateSpaceKey();
  assert.deepEqual((await exchange(network, { space: SPACE, credentialKid: key.did(), delegationToken: "not-a-token" })).body.error, "InvalidDelegationToken");
  const elsewhere = await delegationFor(network, READER, dmInboxUri(OUTSIDER));
  assert.deepEqual((await exchange(network, { space: SPACE, credentialKid: key.did(), delegationToken: elsewhere })).body.error, "InvalidDelegationToken");
  assert.deepEqual((await exchange(network, { space: SPACE, credentialKid: "did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme", delegationToken: await delegationFor(network, READER) })).body.error, "InvalidRequest");
});

test("without a delegation token only a publicly readable space issues a credential, and any other answers SpaceNotFound", async () => {
  const open = await setup();
  const key = await generateSpaceKey();
  assert.ok((await exchange(open.network, { space: SPACE, credentialKid: key.did() })).body.credential);
  const closed = await setup(undefined, memberspacePolicy());
  assert.equal((await exchange(closed.network, { space: SPACE, credentialKid: key.did() })).body.error, "SpaceNotFound");
  assert.equal((await exchange(closed.network, { space: dmInboxUri("did:plc:nobody"), credentialKid: key.did() })).body.error, "SpaceNotFound");
});

test("a user the policy does not authorize gets SpaceNotFound, exactly as for a space that does not exist", async () => {
  const { network } = await setup(undefined, memberspacePolicy());
  const key = await generateSpaceKey();
  await network.clientFor(OWNER).procedure("com.atproto.memberspace.putMember", { space: SPACE, did: READER, read: true, write: false });
  assert.ok((await exchange(network, { space: SPACE, credentialKid: key.did(), delegationToken: await delegationFor(network, READER) })).body.credential);
  const refused = await exchange(network, { space: SPACE, credentialKid: key.did(), delegationToken: await delegationFor(network, OUTSIDER) });
  assert.deepEqual([refused.status, refused.body.error], [400, "SpaceNotFound"]);
  const missing = dmInboxUri("did:plc:nobody");
  const absent = await exchange(network, { space: missing, credentialKid: key.did(), delegationToken: await delegationFor(network, OUTSIDER, missing) });
  assert.deepEqual([absent.status, absent.body.error], [400, "SpaceNotFound"]);
});

test("a deleted space answers SpaceDeleted with or without a delegation token, before any policy check", async () => {
  const { network } = await setup(undefined, memberspacePolicy());
  await network.clientFor(OWNER).procedure("com.atproto.space.deleteSpace", { space: SPACE });
  const key = await generateSpaceKey();
  assert.equal((await exchange(network, { space: SPACE, credentialKid: key.did() })).body.error, "SpaceDeleted");
  assert.equal((await exchange(network, { space: SPACE, credentialKid: key.did(), delegationToken: await delegationFor(network, OUTSIDER) })).body.error, "SpaceDeleted");
});

// --- Credential use ------------------------------------------------------------------------------------------

test("a credential request is rejected without a signature or without the audience header", async () => {
  const unsigned = await setup((request) => isExchange(request) ? request : without(request, "signature"));
  await assert.rejects(readRepos(unsigned.deps), { status: 401, code: "BadSpaceSignature" });
  const noAudience = await setup((request) => isExchange(request) ? request : without(request, "atproto-space-audience"));
  await assert.rejects(readRepos(noAudience.deps), { status: 401, code: "BadSpaceSignature" });
});

test("a credential request is rejected when the audience is not the space authority", async () => {
  let key: () => SpaceKey = () => { throw new Error("no key minted yet"); };
  const { deps, mintedKey } = await setup(async (request) => {
    if (isExchange(request)) return request;
    const headers = await createSpaceSigHeaders(key(), { authorization: request.headers.get("authorization")!, audience: READER });
    return new Request(request, { headers: { ...Object.fromEntries(request.headers), ...headers } });
  });
  key = mintedKey;
  await assert.rejects(readRepos(deps), { status: 401, code: "BadSpaceAudience" });
});

test("a credential request is rejected when signed by a key other than the one the credential is bound to", async () => {
  const other = await generateSpaceKey();
  const { deps } = await setup(async (request) => {
    if (isExchange(request)) return request;
    const headers = await createSpaceSigHeaders(other, {
      authorization: request.headers.get("authorization")!,
      audience: request.headers.get("atproto-space-audience")! as Did,
    });
    return withHeader(request, "signature", headers.signature!);
  });
  await assert.rejects(readRepos(deps), { status: 401 });
});

test("a credential request is rejected when the signature tag is missing or wrong", async () => {
  for (const tag of ["", ';tag="something-else"']) {
    const { deps } = await setup((request) => isExchange(request)
      ? request
      : withHeader(request, "signature-input", request.headers.get("signature-input")!.replace(';tag="atproto-space-credential"', tag)));
    await assert.rejects(readRepos(deps), { status: 401, code: "BadSpaceSignature" });
  }
});

test("a credential request under the old Atproto-Space scheme is refused as an unsupported authorization type", async () => {
  const { deps } = await setup((request) => isExchange(request)
    ? request
    : withHeader(request, "authorization", request.headers.get("authorization")!.replace("Atproto-Space-Credential", "Atproto-Space")));
  await assert.rejects(readRepos(deps), { status: 400, code: "InvalidToken" });
});

test("a credential request is rejected under the Bearer and DPoP schemes", async () => {
  for (const scheme of ["Bearer", "DPoP"]) {
    const { deps } = await setup((request) => isExchange(request)
      ? request
      : withHeader(request, "authorization", request.headers.get("authorization")!.replace("Atproto-Space-Credential", scheme)));
    await assert.rejects(readRepos(deps), { status: 401 });
  }
});

test("the scheme is recognized in any letter case, and the signature covers the Authorization value exactly as sent", async () => {
  let key: () => SpaceKey = () => { throw new Error("no key minted yet"); };
  const { deps, mintedKey } = await setup(async (request) => {
    if (isExchange(request)) return request;
    const authorization = request.headers.get("authorization")!.replace("Atproto-Space-Credential", "atproto-space-credential");
    const headers = await createSpaceSigHeaders(key(), { authorization, audience: request.headers.get("atproto-space-audience")! as Did });
    return new Request(request, { headers: { ...Object.fromEntries(request.headers), ...headers } });
  });
  key = mintedKey;
  assert.deepEqual(await readRepos(deps), { repos: [] });
  const stale = await setup((request) => isExchange(request)
    ? request
    : withHeader(request, "authorization", request.headers.get("authorization")!.replace("Atproto-Space-Credential", "atproto-space-credential")));
  await assert.rejects(readRepos(stale.deps), { status: 401 });
});

test("a read of one repo is rejected when addressed to the space authority instead of the repo's host", async () => {
  let key: () => SpaceKey = () => { throw new Error("no key minted yet"); };
  const { deps, mintedKey } = await setup(async (request) => {
    if (isExchange(request)) return request;
    const headers = await createSpaceSigHeaders(key(), { authorization: request.headers.get("authorization")!, audience: OWNER });
    return new Request(request, { headers: { ...Object.fromEntries(request.headers), ...headers } });
  });
  key = mintedKey;
  const credential = await mintSpaceCredentialWith(deps, SPACE);
  await assert.rejects(
    credential.client("https://fake-pds.test/pds2").query("com.atproto.space.listRecords", { space: SPACE, repo: READER, collection: "new.flock.dm.request" }),
    { status: 401, code: "BadSpaceAudience" },
  );
});

test("a MAC-bearing read without a MAC request is refused with BadSpaceMac", async () => {
  const { network, deps } = await setup();
  await network.clientFor(OWNER).procedure("com.atproto.space.putRecord", { space: SPACE, repo: OWNER, collection: "new.flock.dm.request", rkey: "a", record: { text: "x" } });
  const credential = await mintSpaceCredentialWith(deps, SPACE);
  const unverifiedFetch = deps.fetchEndpoint;
  const bare = new SpaceCredentialAccess(credential, unverifiedFetch);
  await assert.rejects(bare.getRecord(OWNER, "new.flock.dm.request", "a"), { status: 400, code: "BadSpaceMac" });
});

test("an account's own OAuth read of its repo needs no MAC, while the same read with a credential does", async () => {
  const { network, deps } = await setup();
  await network.clientFor(OWNER).procedure("com.atproto.space.putRecord", { space: SPACE, repo: OWNER, collection: "new.flock.dm.request", rkey: "a", record: { text: "x" } });

  const own = await network.clientFor(OWNER).query<{ uri: string; value: { text: string } }>("com.atproto.space.getRecord", { space: SPACE, repo: OWNER, collection: "new.flock.dm.request", rkey: "a" });
  assert.equal(own.value.text, "x", "the own read succeeded without asking for a MAC");

  const credential = await mintSpaceCredentialWith(deps, SPACE);
  await assert.rejects(new SpaceCredentialAccess(credential, deps.fetchEndpoint).getRecord(OWNER, "new.flock.dm.request", "a"), { status: 400, code: "BadSpaceMac" });
  await assert.rejects(network.clientFor(READER).query("com.atproto.space.getRecord", { space: SPACE, repo: OWNER, collection: "new.flock.dm.request", rkey: "a" }), /missing space credential/, "another account's OAuth session is not a credential");
});

/** Sends a credentialed getRecord the way a client that forgot the MAC request would. */
class SpaceCredentialAccess {
  constructor(private readonly credential: { key: SpaceKey; token: string }, private readonly send: (request: Request) => Promise<Response>) {}

  async getRecord(repo: string, collection: string, rkey: string): Promise<void> {
    const url = new URL("https://fake-pds.test/xrpc/com.atproto.space.getRecord");
    for (const [name, value] of Object.entries({ space: SPACE, repo, collection, rkey })) url.searchParams.set(name, value);
    const headers = await createSpaceSigHeaders(this.credential.key, { authorization: `Atproto-Space-Credential ${this.credential.token}`, audience: repo as Did });
    const response = await this.send(new Request(url, { headers }));
    const body = await response.json() as { error?: string };
    if (!response.ok) throw Object.assign(new Error(body.error), { status: response.status, code: body.error });
  }
}

// --- Space policies ------------------------------------------------------------------------------------------

test("createSpace refuses a policy the host does not implement", async () => {
  const { network } = await setup();
  await assert.rejects(
    network.clientFor(OWNER).procedure("com.atproto.space.createSpace", { spaceType: "new.flock.workspace", skey: "x", policy: { $type: "com.atproto.managedspace.policy", managingApp: "did:web:app.test" } }),
    { code: "UnsupportedPolicy" },
  );
});

test("updateSpace replaces the whole policy, so an omitted flag falls back to its default", async () => {
  const { network } = await setup(undefined, { $type: MEMBERSPACE_POLICY, publicRead: true, publicWrite: true });
  await network.clientFor(OWNER).procedure("com.atproto.space.updateSpace", { space: SPACE, policy: memberspacePolicy({ publicWrite: true }) });
  const reported = await network.clientFor(OWNER).query<{ policy: { publicRead: boolean; publicWrite: boolean } }>("com.atproto.space.getSpace", { space: SPACE });
  assert.deepEqual([reported.policy.publicRead, reported.policy.publicWrite], [false, true]);
});

test("a policy of a different type migrates the space and discards its member list; the same type keeps it", async () => {
  const { network } = await setup(undefined, memberspacePolicy());
  const owner = network.clientFor(OWNER);
  await owner.procedure("com.atproto.memberspace.putMember", { space: SPACE, did: READER, read: true, write: true });
  await owner.procedure("com.atproto.space.updateSpace", { space: SPACE, policy: memberspacePolicy({ publicWrite: true }) });
  assert.equal((await owner.query<{ members: unknown[] }>("com.atproto.memberspace.listMembers", { space: SPACE })).members.length, 1);
  await owner.procedure("com.atproto.space.updateSpace", { space: SPACE, policy: { $type: "com.atproto.personalspace.policy" } });
  await assert.rejects(owner.query("com.atproto.memberspace.listMembers", { space: SPACE }), { code: "PolicyMismatch" });
  await owner.procedure("com.atproto.space.updateSpace", { space: SPACE, policy: memberspacePolicy() });
  assert.equal((await owner.query<{ members: unknown[] }>("com.atproto.memberspace.listMembers", { space: SPACE })).members.length, 0);
});

test("member methods are refused on a space under another policy", async () => {
  const { network } = await setup(undefined, { $type: "com.atproto.personalspace.policy" });
  await assert.rejects(network.clientFor(OWNER).procedure("com.atproto.memberspace.putMember", { space: SPACE, did: READER, read: true, write: false }), { code: "PolicyMismatch" });
});

test("getSpace is owner-only and refuses a space credential", async () => {
  const { network, deps } = await setup();
  await assert.rejects(network.clientFor(READER).query("com.atproto.space.getSpace", { space: SPACE }), { code: "NotSpaceOwner" });
  const credential = await mintSpaceCredentialWith(deps, SPACE);
  await assert.rejects(credential.client("https://fake-pds.test/pds1").query("com.atproto.space.getSpace", { space: SPACE }), { status: 401 });
});

// --- The writer set ------------------------------------------------------------------------------------------

async function trackedWriters(network: FakeDmNetwork, deps: SpaceCredentialDeps): Promise<string[]> {
  const credential = await mintSpaceCredentialWith({ ...deps, memberClient: network.clientFor(OWNER) }, SPACE);
  const page = await credential.client("https://fake-pds.test/pds1").query<{ repos: Array<{ did: string }> }>("com.atproto.space.listRepos", { space: SPACE });
  return page.repos.map((repo) => repo.did);
}

async function writeRequest(network: FakeDmNetwork, did: string): Promise<void> {
  await network.clientFor(did).procedure("com.atproto.space.putRecord", { space: SPACE, repo: did, collection: "new.flock.dm.request", rkey: "r", record: { text: "x" } });
}

test("removeMember and putMember with write:false evict a tracked writer; updateSpace does not", async () => {
  const { network, deps } = await setup(undefined, memberspacePolicy());
  const owner = network.clientFor(OWNER);
  await owner.procedure("com.atproto.memberspace.putMember", { space: SPACE, did: READER, read: false, write: true });
  await writeRequest(network, READER);
  assert.deepEqual(await trackedWriters(network, deps), [READER]);
  await owner.procedure("com.atproto.space.updateSpace", { space: SPACE, policy: memberspacePolicy() });
  assert.deepEqual(await trackedWriters(network, deps), [READER], "a policy update does not re-evaluate the writer set");
  await owner.procedure("com.atproto.memberspace.putMember", { space: SPACE, did: READER, read: false, write: false });
  assert.deepEqual(await trackedWriters(network, deps), []);
  await owner.procedure("com.atproto.memberspace.putMember", { space: SPACE, did: READER, read: false, write: true });
  await writeRequest(network, READER);
  assert.deepEqual(await trackedWriters(network, deps), [READER], "an authorized writer is tracked again by its next write");
  await owner.procedure("com.atproto.memberspace.removeMember", { space: SPACE, did: READER });
  assert.deepEqual(await trackedWriters(network, deps), []);
});

test("a denied credential request surfaces as a SpaceCredentialError with the SpaceNotFound code", async () => {
  const { deps } = await setup(undefined, memberspacePolicy());
  await assert.rejects(mintSpaceCredentialWith(deps, SPACE), (error) => error instanceof SpaceCredentialError && error.status === 403 && error.code === "SpaceNotFound");
});

test("an account can list its own repo with its own session and no credential, as on the pinned PDS; anyone else needs a credential", async () => {
  // #given the owner has put a record into a space
  const { network } = await setup();
  await network.clientFor(OWNER).procedure("com.atproto.space.putRecord", { space: SPACE, repo: OWNER, collection: "new.flock.dm.request", rkey: "a", record: { text: "x" } });
  const listing = { space: SPACE, repo: OWNER, collection: "new.flock.dm.request" };

  // #when the owner lists it through her own session, and another account tries the same
  const own = await network.clientFor(OWNER).query<{ records: unknown[] }>("com.atproto.space.listRecords", listing);

  // #then her own listing works and the other account is refused for the missing credential
  assert.equal(own.records.length, 1);
  await assert.rejects(network.clientFor(READER).query("com.atproto.space.listRecords", listing), /missing space credential/);
});
