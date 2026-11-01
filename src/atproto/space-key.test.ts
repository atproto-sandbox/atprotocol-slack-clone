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
  const headers = await createSpaceSigHeaders(key, { authorization, audience: AUDIENCE });
  assert.equal(headers["signature-input"], 'atproto-space-credential=("authorization" "atproto-space-audience");tag="atproto-space-credential"');
  await verifyCredentialSig(headers, key.did() as `did:key:${string}`);
  await assert.rejects(verifyCredentialSig({ ...headers, "atproto-space-audience": "did:plc:other" }, key.did() as `did:key:${string}`), /invalid HTTP message signature/);
  await assert.rejects(verifyCredentialSig(headers, (await generateSpaceKey()).did() as `did:key:${string}`), /invalid HTTP message signature/);
});

test("the library emits padded base64 and rejects the old scheme label", async () => {
  const key = await generateSpaceKey();
  const headers = await createSpaceSigHeaders(key, { authorization, audience: AUDIENCE });
  assert.match(headers.signature, /^atproto-space-credential=:[A-Za-z0-9+/]+={0,2}:$/);
  assert.equal(headers.signature.replace(/^atproto-space-credential=:|:$/g, "").length % 4, 0);
  const legacy = { ...headers, signature: headers.signature.replace("atproto-space-credential", "atproto-space"), "signature-input": headers["signature-input"].replace("atproto-space-credential=", "atproto-space=") };
  await assert.rejects(verifyCredentialSig(legacy, key.did() as `did:key:${string}`), /malformed/);
});

test("generated keys are distinct", async () => {
  assert.notEqual((await generateSpaceKey()).did(), (await generateSpaceKey()).did());
});
