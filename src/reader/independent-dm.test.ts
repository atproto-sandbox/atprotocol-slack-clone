import assert from "node:assert/strict";
import test from "node:test";
import { mergeIndependentDmMessages } from "./independent-dm";

function record(ownerDid: string, rkey: string) {
  return {
    uri: `at://${ownerDid}/space/org.slack.dm.conversation/conv/${ownerDid}/org.slack.dm.message/${rkey}`,
    ownerDid,
    rkey,
    value: { text: `${ownerDid}-${rkey}`, createdAt: "2026-01-01T00:00:00.000Z" },
  };
}

test("merges records from every half by rkey, newest first", () => {
  const records = [record("alice", "3"), record("alice", "1"), record("bob", "4"), record("bob", "2")];
  const result = mergeIndependentDmMessages(records, { limit: 10 });
  assert.deepEqual(result.map((message) => message.rkey), ["4", "3", "2", "1"]);
  assert.equal(result[0]!.text, "bob-4");
  assert.equal(result[0]!.ownerDid, "bob");
});

test("applies the limit after sorting", () => {
  const records = [record("alice", "3"), record("alice", "2"), record("alice", "1")];
  const result = mergeIndependentDmMessages(records, { limit: 2 });
  assert.deepEqual(result.map((message) => message.rkey), ["3", "2"]);
});

test("the before cursor excludes records at or after it", () => {
  const records = [record("alice", "5"), record("alice", "3"), record("alice", "1")];
  const result = mergeIndependentDmMessages(records, { limit: 10, before: "3" });
  assert.deepEqual(result.map((message) => message.rkey), ["1"]);
});

test("deduplicates by URI, keeping one entry per record", () => {
  const shared = record("alice", "2");
  const result = mergeIndependentDmMessages([shared, { ...shared }, record("alice", "1")], { limit: 10 });
  assert.deepEqual(result.map((message) => message.rkey), ["2", "1"]);
});

test("breaks rkey ties by URI so the order is deterministic", () => {
  const left = record("aaa", "1");
  const right = record("zzz", "1");
  const result = mergeIndependentDmMessages([right, left], { limit: 10 });
  assert.deepEqual(result.map((message) => message.ownerDid), ["aaa", "zzz"]);
});

test("carries the optional parent field through", () => {
  const withParent = { ...record("alice", "2"), value: { text: "reply", createdAt: "2026-01-01T00:00:00.000Z", parent: "at://parent" } };
  const result = mergeIndependentDmMessages([withParent], { limit: 10 });
  assert.equal(result[0]!.parent, "at://parent");
});

test("an empty record list returns no messages", () => {
  assert.deepEqual(mergeIndependentDmMessages([], { limit: 5 }), []);
});

test("rejects a non-positive-integer limit", () => {
  assert.throws(() => mergeIndependentDmMessages([], { limit: 0 }), RangeError);
  assert.throws(() => mergeIndependentDmMessages([], { limit: 1.5 }), RangeError);
});
