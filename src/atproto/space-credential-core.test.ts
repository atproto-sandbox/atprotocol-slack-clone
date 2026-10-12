import assert from "node:assert/strict";
import test from "node:test";
import { FakeDmNetwork } from "@/dm/testing/fake-pds";
import { dmInboxUri } from "@/protocol/keys";
import { mintSpaceCredentialWith, SPACE_CREDENTIAL_LIFETIME_MS, SPACE_CREDENTIAL_RENEW_BEFORE_MS } from "./space-credential-core";

const OWNER = "did:plc:owner";
const READER = "did:plc:reader";
const SPACE = dmInboxUri(OWNER);

async function capture() {
  const network = new FakeDmNetwork();
  network.createAccount(OWNER, "pds1");
  network.createAccount(READER, "pds2");
  await network.clientFor(OWNER).procedure("com.atproto.simplespace.createSpace", {
    spaceType: "org.slack.dm.inbox", skey: "self",
    readPolicy: { $type: "com.atproto.simplespace.defs#publicPolicy" },
    writePolicy: { $type: "com.atproto.simplespace.defs#memberListPolicy" },
  });
  const requests: Request[] = [];
  const credential = await mintSpaceCredentialWith({
    memberClient: network.clientFor(READER),
    resolvePds: network.resolvePds,
    fetchEndpoint: (request) => {
      requests.push(request.clone());
      return network.fetchEndpoint(request);
    },
    generateKey: network.generateKey,
    now: network.now,
  }, SPACE);
  return { network, credential, requests };
}

test("the credential exchange carries the delegation token and a keyid signature, and no DPoP proof", async () => {
  const { requests } = await capture();
  const [exchange] = requests;
  assert.match(exchange!.headers.get("authorization")!, /^Bearer delegation-/);
  assert.match(exchange!.headers.get("signature-input")!, /^atproto-space=\("authorization"\);keyid="did:key:zDn[^"]+"$/);
  assert.match(exchange!.headers.get("signature")!, /^atproto-space=:[A-Za-z0-9+/=]+:$/);
  assert.equal(exchange!.headers.has("atproto-space-audience"), false);
  assert.equal(exchange!.headers.has("dpop"), false);
  assert.deepEqual(await exchange!.json(), { space: SPACE });
});

test("a credential request is signed over the Atproto-Space credential and the space authority audience", async () => {
  const { credential, requests, network } = await capture();
  await credential.client("https://fake-pds.test/pds1").query("com.atproto.space.listRepos", { space: SPACE });
  const read = requests.at(-1)!;
  assert.match(read.headers.get("authorization")!, /^Atproto-Space credential-/);
  assert.equal(read.headers.get("atproto-space-audience"), OWNER);
  assert.equal(read.headers.get("signature-input"), 'atproto-space=("authorization" "atproto-space-audience")');
  assert.equal(read.headers.has("dpop"), false);
  assert.equal(credential.expiresAt, network.now() + SPACE_CREDENTIAL_LIFETIME_MS);
});

test("a request for one repo is addressed to that repo's host, not the space authority", async () => {
  const { credential, requests } = await capture();
  await credential.client("https://fake-pds.test/pds2").query("com.atproto.space.listRecords", { space: SPACE, repo: READER, collection: "org.slack.dm.request" });
  assert.equal(requests.at(-1)!.headers.get("atproto-space-audience"), READER);
});

test("the credential lifetime is ten minutes, well under the one-hour protocol ceiling, and renewal opens inside it", () => {
  assert.equal(SPACE_CREDENTIAL_LIFETIME_MS, 600_000);
  assert.ok(SPACE_CREDENTIAL_RENEW_BEFORE_MS > 0 && SPACE_CREDENTIAL_RENEW_BEFORE_MS < SPACE_CREDENTIAL_LIFETIME_MS);
});
