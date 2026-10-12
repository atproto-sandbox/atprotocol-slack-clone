import assert from "node:assert/strict";
import test from "node:test";
import { JoseKey } from "@atproto/jwk-jose";
import { sha256 } from "@noble/hashes/sha2";
import { utf8ToBytes } from "@noble/hashes/utils";
import { createSpaceDpopProof } from "./dpop";

// jose is a transitive dependency (pulled in by @atproto/jwk-jose) but is not
// an allowed direct dependency for this milestone, so the proof is verified
// with the platform Web Crypto API directly instead of jose's jwtVerify. This
// is a stronger check: it proves the JWT is valid per the JOSE/DPoP spec
// using only standard APIs, independent of any atproto-authored library.
test("createSpaceDpopProof produces a JWT that verifies against its embedded ES256 JWK", async () => {
  const key = await JoseKey.generate(["ES256"]);
  const credential = "test-credential-token";
  const proof = await createSpaceDpopProof(key, {
    htm: "POST",
    htu: "https://pds.example/xrpc/com.atproto.space.getSpaceCredential?ignored=1",
    credential,
  });
  const [headerPart, payloadPart, signaturePart] = proof.split(".");
  assert.ok(headerPart && payloadPart && signaturePart);
  const header = decodeJwtPart(headerPart);
  const payload = decodeJwtPart(payloadPart);

  assert.equal(header.alg, "ES256");
  assert.equal(header.typ, "dpop+jwt");
  assert.ok(header.jwk && typeof header.jwk === "object");

  const publicKey = await crypto.subtle.importKey(
    "jwk",
    header.jwk as JsonWebKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const signingInput = Uint8Array.from(new TextEncoder().encode(`${headerPart}.${payloadPart}`));
  const signature = Uint8Array.from(base64UrlDecode(signaturePart));
  const verified = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, signature, signingInput);
  assert.equal(verified, true);

  assert.equal(payload.htm, "POST");
  assert.equal(payload.htu, "https://pds.example/xrpc/com.atproto.space.getSpaceCredential");
  assert.equal(payload.ath, base64UrlEncode(sha256(utf8ToBytes(credential))));
  assert.match(payload.jti as string, /^[0-9a-f]{32}$/);
  assert.ok(typeof payload.iat === "number" && Number.isInteger(payload.iat));
  assert.ok(Math.abs((payload.iat as number) - Math.floor(Date.now() / 1000)) < 5);
});

test("createSpaceDpopProof omits ath when no credential is bound", async () => {
  const key = await JoseKey.generate(["ES256"]);
  const proof = await createSpaceDpopProof(key, { htm: "GET", htu: "https://pds.example/xrpc/test" });
  const payload = decodeJwtPart(proof.split(".")[1]);
  assert.equal("ath" in payload, false);
});

test("createSpaceDpopProof rejects keys that cannot sign ES256", async () => {
  const key = await JoseKey.generate(["ES256"]);
  const restricted = { bareJwk: key.bareJwk, algorithms: ["EdDSA"] as const, createJwt: key.createJwt.bind(key) };
  await assert.rejects(
    createSpaceDpopProof(restricted, { htm: "GET", htu: "https://pds.example/xrpc/test" }),
    /asymmetric ES256 key/,
  );
});

function decodeJwtPart(value: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(value)));
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
