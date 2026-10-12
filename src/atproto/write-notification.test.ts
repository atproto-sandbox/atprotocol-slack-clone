import assert from "node:assert/strict";
import test from "node:test";
import { parseWriteNotification } from "./write-notification";

const valid = {
  space: "at://did:plc:authority/space/org.slack.workspace/team",
  repo: "did:plc:member",
  rev: "3kabcdefghij2",
  hash: { $bytes: "q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA" },
};

test("parseWriteNotification accepts the body the PDS sends, with hash as lexicon bytes", () => {
  // #given #when
  const parsed = parseWriteNotification(valid);

  // #then
  assert.deepEqual(parsed, { space: valid.space, repo: valid.repo, rev: valid.rev });
});

test("parseWriteNotification rejects a hash that is not a bytes object", () => {
  assert.equal(parseWriteNotification({ ...valid, hash: "q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQ" }), null);
  assert.equal(parseWriteNotification({ ...valid, hash: { $bytes: "not base64 !!" } }), null);
  assert.equal(parseWriteNotification({ ...valid, hash: { $bytes: valid.hash.$bytes, extra: true } }), null);
  assert.equal(parseWriteNotification({ ...valid, hash: null }), null);
});

test("parseWriteNotification rejects unexpected fields, a bad repo DID, and a missing or oversized rev", () => {
  assert.equal(parseWriteNotification({ ...valid, extra: 1 }), null);
  assert.equal(parseWriteNotification({ ...valid, repo: "not-a-did" }), null);
  assert.equal(parseWriteNotification({ ...valid, space: "not-a-space" }), null);
  assert.equal(parseWriteNotification({ ...valid, rev: "" }), null);
  assert.equal(parseWriteNotification({ ...valid, rev: "x".repeat(129) }), null);
  assert.equal(parseWriteNotification([valid]), null);
  assert.equal(parseWriteNotification(null), null);
});
