import assert from "node:assert/strict";
import test from "node:test";
import { mintSpaceCredentialWith, SpaceCredentialError, type SpaceCredentialDeps } from "@/atproto/space-credential-core";
import { createSpaceSigHeaders, generateSpaceKey, type SpaceKey } from "@/atproto/space-signature";
import { dmInboxUri } from "@/protocol/keys";
import { FakeDmNetwork } from "./fake-pds";

const OWNER = "did:plc:owner";
const READER = "did:plc:reader";
const SPACE = dmInboxUri(OWNER);

type Tamper = (request: Request) => Promise<Request> | Request;

async function setup(tamper?: Tamper) {
  const network = new FakeDmNetwork();
  network.createAccount(OWNER, "pds1");
  network.createAccount(READER, "pds2");
  await network.clientFor(OWNER).procedure("com.atproto.simplespace.createSpace", {
    spaceType: "org.slack.dm.inbox", skey: "self",
    readPolicy: { $type: "com.atproto.simplespace.defs#publicPolicy" },
    writePolicy: { $type: "com.atproto.simplespace.defs#memberListPolicy" },
  });
  const minted: SpaceKey[] = [];
  const deps: SpaceCredentialDeps = {
    memberClient: network.clientFor(READER),
    resolvePds: network.resolvePds,
    fetchEndpoint: async (request) => network.fetchEndpoint(tamper ? await tamper(request) : request),
    generateKey: async () => {
      const key = await network.generateKey();
      minted.push(key);
      return key;
    },
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

test("a correctly signed exchange and credential request is accepted", async () => {
  const { deps } = await setup();
  assert.deepEqual(await readRepos(deps), { repos: [] });
});

test("the exchange is rejected without a signature", async () => {
  const { deps } = await setup((request) => isExchange(request) ? without(request, "signature") : request);
  await assert.rejects(mintSpaceCredentialWith(deps, SPACE), (error) => error instanceof SpaceCredentialError && error.status === 401);
});

test("the exchange is rejected when its signature does not come from the key it names", async () => {
  const { deps } = await setup(async (request) => {
    if (!isExchange(request)) return request;
    const forged = await createSpaceSigHeaders(await generateSpaceKey(), { authorization: request.headers.get("authorization")! });
    return withHeader(request, "signature", forged.signature!);
  });
  await assert.rejects(mintSpaceCredentialWith(deps, SPACE), (error) => error instanceof SpaceCredentialError && error.status === 401);
});

test("the exchange is rejected when the delegation token is sent as a DPoP credential", async () => {
  const { deps } = await setup((request) => isExchange(request)
    ? withHeader(request, "authorization", request.headers.get("authorization")!.replace("Bearer", "DPoP"))
    : request);
  await assert.rejects(mintSpaceCredentialWith(deps, SPACE), (error) => error instanceof SpaceCredentialError && error.status === 401);
});

test("a credential request is rejected without the audience header", async () => {
  const { deps } = await setup((request) => isExchange(request) ? request : without(request, "atproto-space-audience"));
  await assert.rejects(readRepos(deps), { status: 401, code: "BadSpaceSignature" });
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
      audience: request.headers.get("atproto-space-audience")!,
    });
    return withHeader(request, "signature", headers.signature!);
  });
  await assert.rejects(readRepos(deps), { status: 401 });
});

test("a credential request is rejected under the Bearer scheme", async () => {
  const { deps } = await setup((request) => isExchange(request)
    ? request
    : withHeader(request, "authorization", request.headers.get("authorization")!.replace("Atproto-Space", "Bearer")));
  await assert.rejects(readRepos(deps), { status: 401 });
});

test("a credential request is rejected under the old DPoP scheme", async () => {
  const { deps } = await setup((request) => isExchange(request)
    ? request
    : withHeader(request, "authorization", request.headers.get("authorization")!.replace("Atproto-Space", "DPoP")));
  await assert.rejects(readRepos(deps), { status: 401 });
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
    credential.client("https://fake-pds.test/pds2").query("com.atproto.space.listRecords", { space: SPACE, repo: READER, collection: "org.slack.dm.request" }),
    { status: 401, code: "BadSpaceAudience" },
  );
});
