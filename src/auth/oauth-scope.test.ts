import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { canonicalOAuthScope, decodeOAuthScopeDescriptor, encodeOAuthScopeDescriptor, MAX_OAUTH_SCOPE_BYTES } from "./oauth-scope";

test("OAuth scopes are deduplicated and sorted into a stable client identity", () => {
  assert.equal(canonicalOAuthScope(["space:custom", "atproto", "space:custom"]), "atproto space:custom");
  assert.equal(canonicalOAuthScope("atproto space:custom"), "atproto space:custom");
  assert.throws(() => canonicalOAuthScope(["space:custom"]), /include "atproto"/);
  assert.throws(() => canonicalOAuthScope("atproto injected\nscope"), /Invalid OAuth scope/);
});

test("discoverable client scope descriptors are compressed and authenticated", () => {
  const key = Buffer.from("99".repeat(32), "hex");
  const scope = canonicalOAuthScope(["space:new.flock.workspace?authority=did:plc:alice&skey=workspace&action=read", "atproto"]);
  const descriptor = encodeOAuthScopeDescriptor(scope, key);

  assert.equal(decodeOAuthScopeDescriptor(descriptor.scope, descriptor.signature, key), scope);
  assert.equal(decodeOAuthScopeDescriptor(descriptor.scope, descriptor.signature, Buffer.from("88".repeat(32), "hex")), null);
  assert.equal(decodeOAuthScopeDescriptor(descriptor.scope, `${descriptor.signature.slice(0, -1)}A`, key), null);
  assert.equal(decodeOAuthScopeDescriptor("not-a-descriptor", descriptor.signature, key), null);
});

test("OAuth scope encoding rejects scopes outside the decoder's bounded envelope", () => {
  const key = Buffer.from("99".repeat(32), "hex");
  const highEntropyScope = `atproto space:${randomBytes(8 * 1024).toString("base64url")}`;
  assert.throws(() => encodeOAuthScopeDescriptor(highEntropyScope, key), /descriptor is too large/);
  assert.throws(() => canonicalOAuthScope(`atproto space:${"a".repeat(MAX_OAUTH_SCOPE_BYTES)}`), /scope is too large/);
  assert.equal(decodeOAuthScopeDescriptor("A".repeat(4097), "a".repeat(43), key), null);
});
