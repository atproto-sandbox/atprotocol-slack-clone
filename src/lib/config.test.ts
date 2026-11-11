import assert from "node:assert/strict";
import test from "node:test";
import { getConfig, parseAuthorityClientKeys } from "./config";

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

test("a deployed web app names its operator: the loopback default is for loopback development only", () => {
  Object.assign(process.env, { APP_URL: "https://spaces.example.com", OPERATOR_SERVICE_REF: "did:web:operator.spaces.example.com#atproto_flock_operator" });
  delete process.env.OPERATOR_URL;
  assert.throws(getConfig, /OPERATOR_URL is required outside loopback development/);

  process.env.OPERATOR_URL = "https://operator.spaces.example.com";
  assert.equal(getConfig().operatorUrl.origin, "https://operator.spaces.example.com");
});
