import assert from "node:assert/strict";
import test from "node:test";
import { createSpaceSigHeaders, isP256DidKey, verifyCredentialSig } from "@atproto/space";
import { generateSpaceKey } from "./space-key";

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln";
const AUDIENCE = "did:plc:authority123";
const authorization = `Atproto-Space-Credential ${TOKEN}`;

test("a generated key is a P-256 did:key the library accepts as a credential binding", async () => {
  const key = await generateSpaceKey();
  assert.match(key.did(), /^did:key:zDn/);
  assert.equal(isP256DidKey(key.did()), true);
});

test("requests signed by a generated key verify against its did:key and fail for any other covered value", async () => {
  const key = await generateSpaceKey();
  const { headers } = await createSpaceSigHeaders({ keypair: key, authorization, audience: AUDIENCE });
  assert.equal(headers["signature-input"], 'sig=("authorization" "atproto-space-audience");tag="atproto-space-credential"');
  await verifyCredentialSig(headers, key.did() as `did:key:${string}`);
  await assert.rejects(verifyCredentialSig({ ...headers, "atproto-space-audience": "did:plc:other" }, key.did() as `did:key:${string}`), /invalid HTTP message signature/);
  await assert.rejects(verifyCredentialSig(headers, (await generateSpaceKey()).did() as `did:key:${string}`), /invalid HTTP message signature/);
});

test("the library emits padded base64, resolves signatures by tag under any label, and rejects wrong or missing tags", async () => {
  const key = await generateSpaceKey();
  const { headers } = await createSpaceSigHeaders({ keypair: key, authorization, audience: AUDIENCE });
  assert.match(headers.signature, /^sig=:[A-Za-z0-9+/]+={0,2}:$/);
  assert.equal(headers.signature.replace(/^sig=:|:$/g, "").length % 4, 0);

  // Under a different label but keeping tag="atproto-space-credential", verifyCredentialSig still finds and verifies it.
  const customLabel = {
    ...headers,
    signature: headers.signature.replace(/^sig=/, "custom="),
    "signature-input": headers["signature-input"].replace(/^sig=/, "custom="),
  };
  await verifyCredentialSig(customLabel, key.did() as `did:key:${string}`);

  // A wrong or missing tag is rejected even if the signature bytes are valid for the base.
  const wrongTag = {
    ...headers,
    "signature-input": headers["signature-input"].replace('tag="atproto-space-credential"', 'tag="atproto-space"'),
  };
  await assert.rejects(verifyCredentialSig(wrongTag, key.did() as `did:key:${string}`), /missing or malformed signature with tag/);

  const missingTag = {
    ...headers,
    "signature-input": headers["signature-input"].replace(';tag="atproto-space-credential"', ""),
  };
  await assert.rejects(verifyCredentialSig(missingTag, key.did() as `did:key:${string}`), /missing or malformed signature with tag/);
});

test("generated keys are distinct", async () => {
  assert.notEqual((await generateSpaceKey()).did(), (await generateSpaceKey()).did());
});
