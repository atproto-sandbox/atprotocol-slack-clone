import assert from "node:assert/strict";
import test from "node:test";
import { P256Keypair, verifySignature } from "@atproto/crypto";
import { fromBase64 } from "@atproto/lex-data";
import { createSpaceSigHeaders, generateSpaceKey } from "./space-signature";

// Vectors produced by the upstream `createSpaceSigHeaders` and checked with its
// `verifySpaceSignature`, using the fixed key below (RFC 6979 signatures are deterministic).
const FIXED_KEY_HEX = "01".repeat(32);
const FIXED_DID = "did:key:zDnaeXxvmFHMHjqgQTbadpWG7gPHwnga1i7SMwxrV2BSdUjAD";
const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln";
const AUDIENCE = "did:plc:authority123";

test("the delegation-token exchange headers match upstream byte for byte", async () => {
  const key = await P256Keypair.import(FIXED_KEY_HEX);
  assert.equal(key.did(), FIXED_DID);
  assert.deepEqual(await createSpaceSigHeaders(key, { authorization: `Bearer ${TOKEN}` }), {
    authorization: `Bearer ${TOKEN}`,
    "signature-input": `atproto-space=("authorization");keyid="${FIXED_DID}"`,
    signature: "atproto-space=:RxwJoS2h0grpy3iAXb7UXYURmLYS3aVf+o/J9y2p0d0m+UI53iuBmOwOQYf9IW6DRXYXkvinq44wXsrt9nz62g:",
  });
});

test("the credential request headers match upstream byte for byte", async () => {
  const key = await P256Keypair.import(FIXED_KEY_HEX);
  assert.deepEqual(await createSpaceSigHeaders(key, { authorization: `Atproto-Space ${TOKEN}`, audience: AUDIENCE }), {
    authorization: `Atproto-Space ${TOKEN}`,
    "atproto-space-audience": AUDIENCE,
    "signature-input": 'atproto-space=("authorization" "atproto-space-audience")',
    signature: "atproto-space=:gx60G08DNQeG3kfIhPOGg1apYYGnMn+4xLpaBLyNrp1lutxfx8HHoJQ5U8yXKx2iUXwXgwc8pLU7oGDB0iCHUw:",
  });
});

test("a generated key is a P-256 did:key whose signatures verify over the signature base", async () => {
  const key = await generateSpaceKey();
  assert.match(key.did(), /^did:key:zDn/);
  const headers = await createSpaceSigHeaders(key, { authorization: `Atproto-Space ${TOKEN}`, audience: AUDIENCE });
  const bytes = fromBase64(/^atproto-space=:(.+):$/.exec(headers.signature)![1]!);
  assert.equal(bytes.length, 64);
  const base = new TextEncoder().encode(
    `"authorization": Atproto-Space ${TOKEN}\n"atproto-space-audience": ${AUDIENCE}\n"@signature-params": ("authorization" "atproto-space-audience")`,
  );
  assert.equal(await verifySignature(key.did(), base, bytes, { allowMalleableSig: true }), true);
  const tampered = new TextEncoder().encode(new TextDecoder().decode(base).replace(AUDIENCE, "did:plc:other"));
  assert.equal(await verifySignature(key.did(), tampered, bytes, { allowMalleableSig: true }), false);
});

test("generated keys are distinct", async () => {
  assert.notEqual((await generateSpaceKey()).did(), (await generateSpaceKey()).did());
});
