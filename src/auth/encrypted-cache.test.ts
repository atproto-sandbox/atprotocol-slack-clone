import assert from "node:assert/strict";
import test from "node:test";

test("channel cache values are authenticated and encrypted at rest", async () => {
  process.env.AUTH_ENCRYPTION_KEY = "11".repeat(32);
  process.env.OPERATOR_SERVICE_REF = "did:web:localhost%3A3000#atproto_flock_operator";
  process.env.APP_URL = "http://127.0.0.1:3000";
  const { decryptCachedValue, encryptCachedValue } = await import("./encrypted-cache");
  const value = { text: "private message", author: "did:plc:alice" };
  const context = {
    accountDid: "did:plc:reader",
    spaceUri: "at://did:plc:owner/space/new.flock.channel/general",
    repoDid: "did:plc:alice",
    collection: "new.flock.channel.message",
    rkey: "2222222222299",
    uri: "at://did:plc:alice/new.flock.channel.message/2222222222299",
  };
  const encrypted = encryptCachedValue(value, context);
  assert.equal(encrypted.includes(value.text), false);
  assert.deepEqual(decryptCachedValue(encrypted, context), value);
  assert.throws(() => decryptCachedValue(encrypted, { ...context, spaceUri: "at://did:plc:owner/space/new.flock.channel/private" }));
  assert.throws(() => decryptCachedValue(encrypted, { ...context, accountDid: "did:plc:other" }));
  assert.throws(() => decryptCachedValue(encrypted, { ...context, repoDid: "did:plc:other" }));
  assert.throws(() => decryptCachedValue(encrypted, { ...context, collection: "new.flock.channel.reaction" }));
  assert.throws(() => decryptCachedValue(encrypted, { ...context, rkey: "22222222222ab" }));
  assert.throws(() => decryptCachedValue(encrypted, { ...context, uri: "at://did:plc:alice/new.flock.channel.message/other" }));
  const [version, iv, , body] = encrypted.split(".");
  assert.throws(() => decryptCachedValue(`${version}.${iv}.AAAAAAAAAAAAAAAAAAAAAA.${body}`, context));
  assert.throws(() => decryptCachedValue("v1.AAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AA", context), /Unsupported encrypted cache value/);
});
