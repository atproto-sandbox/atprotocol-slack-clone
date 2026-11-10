import assert from "node:assert/strict";
import test from "node:test";
import { parseSpaceDeletedNotification, parseWriteNotification } from "./write-notification";

const valid = {
  space: "at://did:plc:authority/space/new.flock.workspace/team",
  repo: "did:plc:member",
  repoRev: "3kabcdefghij2",
  spaceRev: "3kabcdefghij3",
  prevSpaceRev: "3kabcdefghij2",
  data: { $bytes: "q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA" },
};

test("parseWriteNotification accepts the body the PDS sends, with data as lexicon bytes", () => {
  // #given #when
  const parsed = parseWriteNotification(valid);

  // #then
  assert.deepEqual(parsed, { space: valid.space, repo: valid.repo, repoRev: valid.repoRev });
});

test("parseWriteNotification rejects a data value that is not a bytes object", () => {
  assert.equal(parseWriteNotification({ ...valid, data: "q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQ" }), null);
  assert.equal(parseWriteNotification({ ...valid, data: { $bytes: "not base64 !!" } }), null);
  assert.equal(parseWriteNotification({ ...valid, data: { $bytes: valid.data.$bytes, extra: true } }), null);
  assert.equal(parseWriteNotification({ ...valid, data: null }), null);
});

test("parseWriteNotification accepts the repo host's body without the forwarded space revisions", () => {
  const fromRepoHost = { space: valid.space, repo: valid.repo, repoRev: valid.repoRev, data: valid.data };
  assert.deepEqual(parseWriteNotification(fromRepoHost), { space: valid.space, repo: valid.repo, repoRev: valid.repoRev });
});

test("parseWriteNotification rejects the old rev field and non-TID revisions", () => {
  const { repoRev, ...withoutRepoRev } = valid;
  assert.equal(parseWriteNotification({ ...withoutRepoRev, rev: repoRev }), null);
  assert.equal(parseWriteNotification({ ...valid, spaceRev: "not-a-tid" }), null);
  assert.equal(parseWriteNotification({ ...valid, prevSpaceRev: "x".repeat(129) }), null);
});

test("parseWriteNotification rejects unexpected fields, a bad repo DID, and a missing or malformed repoRev", () => {
  assert.equal(parseWriteNotification({ ...valid, extra: 1 }), null);
  assert.equal(parseWriteNotification({ ...valid, repo: "not-a-did" }), null);
  assert.equal(parseWriteNotification({ ...valid, space: "not-a-space" }), null);
  assert.equal(parseWriteNotification({ ...valid, repoRev: "" }), null);
  assert.equal(parseWriteNotification({ ...valid, repoRev: "x".repeat(129) }), null);
  assert.equal(parseWriteNotification([valid]), null);
  assert.equal(parseWriteNotification(null), null);
});

test("parseSpaceDeletedNotification accepts the lexicon's one field and ignores a field a later revision adds", () => {
  assert.deepEqual(parseSpaceDeletedNotification({ space: valid.space }), { space: valid.space });
  assert.deepEqual(parseSpaceDeletedNotification({ space: valid.space, deletedAt: "later" }), { space: valid.space });
});

test("parseSpaceDeletedNotification rejects a body without a valid space", () => {
  assert.equal(parseSpaceDeletedNotification(null), null);
  assert.equal(parseSpaceDeletedNotification([valid.space]), null);
  assert.equal(parseSpaceDeletedNotification({}), null);
  assert.equal(parseSpaceDeletedNotification({ space: "at://not-a-space" }), null);
});
