import assert from "node:assert/strict";
import test from "node:test";
import { parseAuthorityClientKeys } from "./config";

const key = (kid: string) => ({ kty: "EC", crv: "P-256", x: "x", y: "y", d: "d", kid });

test("authority client keys parse from a JWK set, newest first", () => {
  // given two private EC P-256 keys
  const raw = JSON.stringify({ keys: [key("new"), key("old")] });

  // when parsed
  const keys = parseAuthorityClientKeys(raw);

  // then both are kept in order
  assert.deepEqual(keys.map(({ kid }) => kid), ["new", "old"]);
});

test("authority client keys refuse a missing or malformed value", () => {
  for (const raw of ["", "not json", "{}", JSON.stringify({ keys: [] }), JSON.stringify([key("a")])]) {
    assert.throws(() => parseAuthorityClientKeys(raw), /AUTHORITY_CLIENT_PRIVATE_JWKS/, raw);
  }
});

test("authority client keys refuse a public key, another curve, or a repeated kid", () => {
  const publicOnly = Object.fromEntries(Object.entries(key("public")).filter(([name]) => name !== "d"));
  for (const keys of [[publicOnly], [{ ...key("rsa"), kty: "RSA" }], [{ ...key("k256"), crv: "secp256k1" }], [key("same"), key("same")]]) {
    assert.throws(() => parseAuthorityClientKeys(JSON.stringify({ keys })), /AUTHORITY_CLIENT_PRIVATE_JWKS/);
  }
});
