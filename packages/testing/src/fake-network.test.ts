import assert from "node:assert/strict";
import test from "node:test";
import { toBase64 } from "@atproto/lex-data";
import { MAC_HEADER, createSpaceSigHeaders } from "@atproto/space";
import { listBoundedRecords } from "@flock/protocol/atproto/record-pages";
import { SpaceMacError, mintSpaceCredentialWith, SpaceCredentialError, verifyRecordCid, type SpaceCredentialDeps } from "@flock/protocol/atproto/space-credential-core";
import { generateSpaceKey, type SpaceKey } from "@flock/protocol/atproto/space-key";
import { MEMBERSPACE_POLICY, memberspacePolicy } from "@flock/protocol/atproto/space-policy";
import { dmInboxUri, type Did } from "@flock/protocol/keys";
import { FakeNetwork } from "./fake-network";

const OWNER = "did:plc:owner";
const READER = "did:plc:reader";
const OUTSIDER = "did:plc:outsider";
const SPACE = dmInboxUri(OWNER);
const PUBLIC_READ = { $type: MEMBERSPACE_POLICY, publicRead: true, publicWrite: false };

type Tamper = (request: Request) => Promise<Request> | Request;

async function setup(tamper?: Tamper, policy: unknown = PUBLIC_READ) {
  const network = new FakeNetwork();
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
async function exchange(network: FakeNetwork, body: Record<string, unknown>): Promise<{ status: number; body: { credential?: string; error?: string } }> {
  const response = await network.fetchEndpoint(new Request("https://fake-pds.test/pds1/xrpc/com.atproto.space.getSpaceCredential".replace("/pds1", ""), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  return { status: response.status, body: await response.json() as { credential?: string; error?: string } };
}

async function delegationFor(network: FakeNetwork, did: string, space = SPACE): Promise<string> {
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

async function trackedWriters(network: FakeNetwork, deps: SpaceCredentialDeps): Promise<string[]> {
  const credential = await mintSpaceCredentialWith({ ...deps, memberClient: network.clientFor(OWNER) }, SPACE);
  const page = await credential.client("https://fake-pds.test/pds1").query<{ repos: Array<{ did: string }> }>("com.atproto.space.listRepos", { space: SPACE });
  return page.repos.map((repo) => repo.did);
}

async function writeRequest(network: FakeNetwork, did: string): Promise<void> {
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

test("FakeNetwork.listRepos emits real commit.data digests matching getLatestCommit", async () => {
  const { network, deps } = await setup(undefined, { $type: MEMBERSPACE_POLICY, publicRead: true, publicWrite: true });
  await network.writeAs(OWNER, SPACE, "new.flock.dm.request", "a", { text: "one" });
  await network.writeAs(READER, SPACE, "new.flock.dm.request", "b", { text: "two" });

  const cred = await mintSpaceCredentialWith(deps, SPACE);
  const listed = await cred.client("https://fake-pds.test/pds1").query<{
    repos: Array<{ did: string; repoRev: string; data: { $bytes: string } }>;
  }>("com.atproto.space.listRepos", { space: SPACE });
  assert.equal(listed.repos.length, 2);

  for (const repo of listed.repos) {
    const pds = await network.resolvePds(repo.did);
    const latest = await cred.client(pds).query<{ commit: { rev: string; data: { $bytes: string } } }>(
      "com.atproto.space.getLatestCommit",
      { space: SPACE, repo: repo.did },
    );
    assert.equal(repo.repoRev, latest.commit.rev);
    assert.equal(repo.data.$bytes, latest.commit.data.$bytes);
    assert.notEqual(repo.data.$bytes, toBase64(new Uint8Array(32)));
  }
});

test("FakeNetwork.listRecords supports optional collection, excludeValues, and full-uri cursor pagination across shared rkeys", async () => {
  const { network, deps } = await setup();
  // Write records with identical rkeys across two distinct collections.
  await network.writeAs(OWNER, SPACE, "new.flock.workspace.roster", "d-shared", { subject: READER });
  await network.writeAs(OWNER, SPACE, "new.flock.admin", "d-shared", { subject: READER });
  await network.writeAs(OWNER, SPACE, "new.flock.admin", "d-other", { subject: OUTSIDER });

  const cred = await mintSpaceCredentialWith(deps, SPACE);
  const client = cred.client("https://fake-pds.test/pds1");

  // Omitted collection paginates by full URI across both collections without colliding on "d-shared".
  const p1 = await client.query<{ records: Array<{ collection: string; rkey: string; value?: unknown }>; cursor?: string }>(
    "com.atproto.space.listRecords",
    { space: SPACE, repo: OWNER, limit: 2 },
  );
  assert.equal(p1.records.length, 2);
  assert.ok(p1.cursor?.startsWith(`${SPACE}/${OWNER}/`));
  const p2 = await client.query<{ records: Array<{ collection: string; rkey: string; value?: unknown }>; cursor?: string }>(
    "com.atproto.space.listRecords",
    { space: SPACE, repo: OWNER, limit: 2, cursor: p1.cursor },
  );
  assert.equal(p2.records.length, 1);
  assert.equal(p2.cursor, undefined);
  assert.deepEqual(
    [...p1.records, ...p2.records].map((r) => `${r.collection}/${r.rkey}`),
    [
      "new.flock.workspace.roster/d-shared",
      "new.flock.admin/d-shared",
      "new.flock.admin/d-other",
    ],
  );

  // Mid-listing deletion of the cursor record still advances cleanly by uri < cursor.
  await network.deleteAs(OWNER, SPACE, "new.flock.admin", "d-shared");
  const afterDelete = await client.query<{ records: Array<{ collection: string; rkey: string }> }>(
    "com.atproto.space.listRecords",
    { space: SPACE, repo: OWNER, limit: 2, cursor: p1.cursor },
  );
  assert.deepEqual(afterDelete.records.map((r) => `${r.collection}/${r.rkey}`), ["new.flock.admin/d-other"]);

  // excludeValues omits values and integrates with listBoundedRecords.
  const headers = await listBoundedRecords(client, { space: SPACE, repo: OWNER, maxRecords: 10, excludeValues: true });
  assert.equal(headers.records.length, 2);
  assert.equal(headers.records[0]!.value, undefined);
  assert.ok(headers.records[0]!.cid.length > 0);
});

test("FakeNetwork.listRepoOps handles applyWrites batches, superseded values, since/cursor pagination, and MAC rules", async () => {
  const { network, deps } = await setup();
  // Batch 1: create two records in one rev (equal rev, idx 0 and 1).
  await network.applyWritesAs(OWNER, SPACE, [
    { action: "create", collection: "new.flock.dm.request", rkey: "r1", value: { text: "v1" } },
    { action: "create", collection: "new.flock.dm.request", rkey: "r2", value: { text: "stay" } },
  ]);
  // Batch 2: update r1 (superseding Batch 1's r1 value!) and create r3, then delete r3 later.
  await network.applyWritesAs(OWNER, SPACE, [
    { action: "update", collection: "new.flock.dm.request", rkey: "r1", value: { text: "v2" } },
    { action: "create", collection: "new.flock.dm.request", rkey: "r3", value: { text: "temp" } },
  ]);
  await network.deleteAs(OWNER, SPACE, "new.flock.dm.request", "r3");

  const cred = await mintSpaceCredentialWith(deps, SPACE);
  const client = cred.client("https://fake-pds.test/pds1");

  type OpsPage = {
    ops: Array<{ rev: string; collection: string; rkey: string; cid: string | null; prev: string | null; value?: Record<string, unknown> }>;
    cursor?: string;
    commit?: { rev: string };
  };
  const allOps: OpsPage["ops"] = [];
  let cursor: string | undefined;
  let pages = 0;
  let finalRev: string | undefined;
  for (;;) {
    pages += 1;
    const page = await client.query<OpsPage>("com.atproto.space.listRepoOps", {
      space: SPACE, repo: OWNER, limit: 2, ...(cursor ? { cursor } : {}),
    });
    allOps.push(...page.ops);
    if (page.commit) {
      finalRev = page.commit.rev;
      assert.equal(page.cursor, undefined);
      break;
    }
    assert.equal(page.ops.length, 2);
    assert.ok(page.cursor);
    cursor = page.cursor;
  }
  assert.equal(pages, 3);
  assert.equal(allOps.length, 5);
  assert.equal(allOps[0]!.rev, allOps[1]!.rev, "same-rev batched ops share rev");
  assert.equal(allOps[0]!.value, undefined, "superseded create op has value: undefined");
  assert.deepEqual(allOps[1]!.value, { $type: "new.flock.dm.request", text: "stay" });
  assert.deepEqual(allOps[2]!.value, { $type: "new.flock.dm.request", text: "v2" });
  assert.equal(allOps[3]!.value, undefined, "deleted create op has value: undefined");
  assert.equal(allOps[4]!.cid, null);
  assert.equal(allOps[4]!.prev, allOps[3]!.cid);
  assert.equal(allOps[4]!.value, undefined);

  // since is exclusive.
  const sinceFirst = await client.query<OpsPage>("com.atproto.space.listRepoOps", {
    space: SPACE, repo: OWNER, since: allOps[0]!.rev, limit: 10,
  });
  assert.equal(sinceFirst.ops.length, 3);
  assert.equal(sinceFirst.commit?.rev, finalRev);

  // excludeValues: true omits surviving values too.
  const metaOnly = await client.query<OpsPage>("com.atproto.space.listRepoOps", {
    space: SPACE, repo: OWNER, excludeValues: true, limit: 10,
  });
  assert.equal(metaOnly.ops.every((op) => op.value === undefined), true);
});

test("FakeNetwork.clearRecords and importRepo preserve space_repo with new signed commit and reset oplog history", async () => {
  const { network, deps } = await setup();
  await network.writeAs(OWNER, SPACE, "new.flock.dm.request", "a", { text: "before-clear" });
  const cred = await mintSpaceCredentialWith(deps, SPACE);
  const client = cred.client("https://fake-pds.test/pds1");
  const beforeCommit = await client.query<{ commit: { rev: string } }>("com.atproto.space.getLatestCommit", { space: SPACE, repo: OWNER });

  // clearRecords clears records and oplog, assigns new commit rev, and NEVER returns RepoNotFound.
  network.clearRecordsAs(OWNER, SPACE);
  const afterClearCommit = await client.query<{ commit: { rev: string; data: { $bytes: string } } }>("com.atproto.space.getLatestCommit", { space: SPACE, repo: OWNER });
  assert.ok(afterClearCommit.commit.rev > beforeCommit.commit.rev);
  const afterClearOps = await client.query<{ ops: unknown[]; commit?: { rev: string } }>("com.atproto.space.listRepoOps", { space: SPACE, repo: OWNER, limit: 10 });
  assert.deepEqual(afterClearOps.ops, []);
  assert.equal(afterClearOps.commit?.rev, afterClearCommit.commit.rev);
  const afterClearStar = await cred.fetchVerifiedRepoStar("https://fake-pds.test/pds1", { space: SPACE, repo: OWNER, maxBytes: 1024 * 1024, maxRecords: 10 });
  assert.deepEqual(afterClearStar.records, []);

  // importRepo replaces records with imported set, resets oplog, and preserves space_repo (even when empty).
  await network.importRepoAs(OWNER, SPACE, [
    { collection: "new.flock.dm.request", rkey: "imported", value: { text: "from-import" } },
  ]);
  const importedStar = await cred.fetchVerifiedRepoStar("https://fake-pds.test/pds1", { space: SPACE, repo: OWNER, maxBytes: 1024 * 1024, maxRecords: 10 });
  assert.deepEqual(importedStar.records.map((r) => [r.rkey, r.record.text]), [["imported", "from-import"]]);
  const importedOps = await client.query<{ ops: unknown[]; commit?: { rev: string } }>("com.atproto.space.listRepoOps", { space: SPACE, repo: OWNER, limit: 10 });
  assert.deepEqual(importedOps.ops, []);
  assert.ok(importedOps.commit?.rev && importedOps.commit.rev > afterClearCommit.commit.rev);

  // Empty importRepo also preserves space_repo (never RepoNotFound).
  await network.importRepoAs(OWNER, SPACE, []);
  const emptyImportedStar = await cred.fetchVerifiedRepoStar("https://fake-pds.test/pds1", { space: SPACE, repo: OWNER, maxBytes: 1024 * 1024, maxRecords: 10 });
  assert.deepEqual(emptyImportedStar.records, []);
});

test("FakeNetwork distinguishes unwritten space repo vs missing account on PDS without MAC", async () => {
  const { network, deps } = await setup();
  const cred = await mintSpaceCredentialWith(deps, SPACE);
  const pds2 = "https://fake-pds.test/pds2";
  const client = cred.client(pds2);

  // Unwritten account (READER exists on pds2, never wrote to SPACE):
  // getLatestCommit & getRepo -> HTTP 400 RepoNotFound without MAC; listRepoOps -> { ops: [] } no commit/MAC; listRecords -> { records: [] }.
  let sawUnwrittenMac = false;
  network.interceptResponse = ({ method, response }) => {
    if (method === "com.atproto.space.getLatestCommit" || method === "com.atproto.space.getRepo") {
      if (response.headers.has(MAC_HEADER)) sawUnwrittenMac = true;
    }
    return response;
  };
  await assert.rejects(client.query("com.atproto.space.getLatestCommit", { space: SPACE, repo: READER }), { status: 400, code: "RepoNotFound" });
  await assert.rejects(cred.fetchVerifiedRepoStar(pds2, { space: SPACE, repo: READER, maxBytes: 1024 * 1024, maxRecords: 10 }), { status: 400, code: "RepoNotFound" });
  assert.equal(sawUnwrittenMac, false);
  assert.deepEqual(await client.query("com.atproto.space.listRepoOps", { space: SPACE, repo: READER }), { ops: [] });
  assert.deepEqual(await client.query("com.atproto.space.listRecords", { space: SPACE, repo: READER }), { records: [] });

  // Missing account on PDS: all reads (including listRepoOps and listRecords) fail with HTTP 400 RepoNotFound without MAC.
  network.setAccountState(READER, "missing");
  await assert.rejects(client.query("com.atproto.space.getLatestCommit", { space: SPACE, repo: READER }), { status: 400, code: "RepoNotFound" });
  await assert.rejects(cred.fetchVerifiedRepoStar(pds2, { space: SPACE, repo: READER, maxBytes: 1024 * 1024, maxRecords: 10 }), { status: 400, code: "RepoNotFound" });
  await assert.rejects(client.query("com.atproto.space.listRepoOps", { space: SPACE, repo: READER }), { status: 400, code: "RepoNotFound" });
  await assert.rejects(client.query("com.atproto.space.listRecords", { space: SPACE, repo: READER }), { status: 400, code: "RepoNotFound" });
});

test("FakeNetwork fault injection hooks exercise mid-read races, pruned oplog, forged CID, and MAC faults", async () => {
  const { network, deps } = await setup();
  await network.writeAs(OWNER, SPACE, "new.flock.dm.request", "a", { text: "one" });
  await network.writeAs(OWNER, SPACE, "new.flock.dm.request", "b", { text: "two" });
  const cred = await mintSpaceCredentialWith(deps, SPACE);
  const client = cred.client("https://fake-pds.test/pds1");

  // 1. Mid-page race via beforeListRepoOps & beforeGetLatestCommit.
  let racedOps = false;
  network.beforeListRepoOps = async ({ cursor }) => {
    if (cursor && !racedOps) {
      racedOps = true;
      await network.writeAs(OWNER, SPACE, "new.flock.dm.request", "c", { text: "race" });
    }
  };
  const page1 = await client.query<{ ops: Array<{ rev: string }>; cursor?: string }>("com.atproto.space.listRepoOps", {
    space: SPACE, repo: OWNER, limit: 1,
  });
  const page2 = await client.query<{ ops: Array<{ rev: string }>; cursor?: string }>("com.atproto.space.listRepoOps", {
    space: SPACE, repo: OWNER, limit: 1, cursor: page1.cursor,
  });
  const page3 = await client.query<{ ops: Array<{ rkey: string }>; commit?: { rev: string } }>("com.atproto.space.listRepoOps", {
    space: SPACE, repo: OWNER, limit: 10, cursor: page2.cursor,
  });
  assert.equal(racedOps, true);
  assert.equal(page3.ops[0]!.rkey, "c");
  network.beforeListRepoOps = undefined;

  let racedCommit = false;
  network.beforeGetLatestCommit = async () => {
    if (!racedCommit) {
      racedCommit = true;
      await network.writeAs(OWNER, SPACE, "new.flock.dm.request", "d", { text: "between" });
    }
  };
  const recs = await listBoundedRecords(client, { space: SPACE, repo: OWNER, maxRecords: 10 });
  const commitAfter = await client.query<{ commit: { rev: string } }>("com.atproto.space.getLatestCommit", { space: SPACE, repo: OWNER });
  assert.equal(racedCommit, true);
  assert.equal(recs.records.length, 3);
  assert.ok(commitAfter.commit.rev > page3.commit!.rev);
  network.beforeGetLatestCommit = undefined;

  // 2. pruneOplog drops history strictly before keepFromRev (leaving "c" at page3.commit.rev and "d" after it).
  network.pruneOplog(SPACE, OWNER, page3.commit!.rev);
  const prunedOps = await client.query<{ ops: Array<{ rkey: string; rev: string }> }>("com.atproto.space.listRepoOps", { space: SPACE, repo: OWNER, limit: 10 });
  assert.deepEqual(prunedOps.ops.map((op) => op.rkey), ["c", "d"]);

  // 3. interceptResponse can inject forged CIDs and forged MACs.
  network.interceptResponse = async ({ method, response }) => {
    if (method === "com.atproto.space.listRecords" && response.ok) {
      const json = await response.json() as { records: Array<{ value: Record<string, unknown> }> };
      json.records[0]!.value = { text: "forged-value" };
      return new Response(JSON.stringify(json), { status: 200, headers: response.headers });
    }
    if (method === "com.atproto.space.getLatestCommit" && response.ok) {
      const headers = new Headers(response.headers);
      headers.set(MAC_HEADER, headers.get(MAC_HEADER)!.replace(/mac=:[^:]+:/, "mac=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:"));
      return new Response(response.body, { status: 200, headers });
    }
    return response;
  };
  const tamperedList = await listBoundedRecords(client, { space: SPACE, repo: OWNER, maxRecords: 10 });
  assert.equal(await verifyRecordCid(tamperedList.records[0]!.collection, tamperedList.records[0]!.rkey, tamperedList.records[0]!.value, tamperedList.records[0]!.cid), false);
  await assert.rejects(client.query("com.atproto.space.getLatestCommit", { space: SPACE, repo: OWNER }), SpaceMacError);
});

test("reading or deleting an unwritten member repo does not mutate space.repos or pollute listSpaces", async () => {
  const { network, deps } = await setup(undefined, { $type: MEMBERSPACE_POLICY, publicRead: true, publicWrite: true });
  const cred = await mintSpaceCredentialWith(deps, SPACE);
  const readerClient = network.clientFor(READER);
  const pds2 = "https://fake-pds.test/pds2";
  const memberClient = cred.client(pds2);

  assert.deepEqual(await readerClient.query<{ spaces: Array<{ uri: string }> }>("com.atproto.space.listSpaces", {}), { spaces: [] });

  // Probe READER's unwritten repo across every read endpoint (and no-op delete/clear).
  assert.deepEqual(await memberClient.query("com.atproto.space.listRepoOps", { space: SPACE, repo: READER }), { ops: [] });
  assert.deepEqual(await memberClient.query("com.atproto.space.listRecords", { space: SPACE, repo: READER }), { records: [] });
  await assert.rejects(
    memberClient.query("com.atproto.space.getRecord", { space: SPACE, repo: READER, collection: "new.flock.dm.request", rkey: "missing" }),
    { status: 400, code: "RecordNotFound" },
  );
  await assert.rejects(
    cred.fetchVerifiedRepoStar(pds2, { space: SPACE, repo: READER, maxBytes: 64 * 1024, maxRecords: 10 }),
    { status: 400, code: "RepoNotFound" },
  );
  await assert.rejects(
    memberClient.query("com.atproto.space.getLatestCommit", { space: SPACE, repo: READER }),
    { status: 400, code: "RepoNotFound" },
  );
  await readerClient.procedure("com.atproto.space.deleteRecord", { space: SPACE, repo: READER, collection: "new.flock.dm.request", rkey: "missing" });
  await readerClient.procedure("com.atproto.space.clearRecords", { space: SPACE, repo: READER });

  // Unwritten repo reads/no-op deletes must NEVER add READER to listSpaces.
  assert.deepEqual(await readerClient.query<{ spaces: Array<{ uri: string }> }>("com.atproto.space.listSpaces", {}), { spaces: [] });

  // Once READER actually writes a record, listSpaces includes the space.
  await network.writeAs(READER, SPACE, "new.flock.dm.request", "m1", { text: "hello" });
  assert.deepEqual(await readerClient.query<{ spaces: Array<{ uri: string }> }>("com.atproto.space.listSpaces", {}), {
    spaces: [{ uri: SPACE }],
  });
});

test("concurrent applyWritesAs and putRecord calls on the same (space, repo) serialize cleanly and match LtHash commit", async () => {
  const { network, deps } = await setup();
  const cred = await mintSpaceCredentialWith(deps, SPACE);
  const pds1 = "https://fake-pds.test/pds1";

  await Promise.all([
    network.applyWritesAs(OWNER, SPACE, [
      { action: "create", collection: "new.flock.dm.request", rkey: "b1", value: { text: "one" } },
      { action: "create", collection: "new.flock.dm.request", rkey: "b2", value: { text: "two" } },
    ]),
    network.applyWritesAs(OWNER, SPACE, [
      { action: "create", collection: "new.flock.dm.request", rkey: "b3", value: { text: "three" } },
    ]),
    network.writeAs(OWNER, SPACE, "new.flock.dm.request", "p1", { text: "four" }),
  ]);

  const star = await cred.fetchVerifiedRepoStar(pds1, {
    space: SPACE,
    repo: OWNER,
    maxBytes: 1024 * 1024,
    maxRecords: 100,
  });
  assert.deepEqual(
    star.records.map((r) => r.rkey).sort(),
    ["b1", "b2", "b3", "p1"],
  );
  const opsPage = await cred.client(pds1).query<{ ops: Array<{ rev: string; rkey: string; prev: string | null }> }>(
    "com.atproto.space.listRepoOps",
    { space: SPACE, repo: OWNER, limit: 100 },
  );
  assert.deepEqual(opsPage.ops.map((o) => o.rkey).sort(), ["b1", "b2", "b3", "p1"]);
  for (const op of opsPage.ops) {
    assert.equal(op.prev, null);
  }
});
