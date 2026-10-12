import assert from "node:assert/strict";
import test from "node:test";
import { mergeDmHalves, type DmHalfPage, type DmHalfRecord } from "./merge";

function record(ownerDid: string, rkey: string): DmHalfRecord {
  return { uri: `at://${ownerDid}/space/org.slack.dm.conversation/conv/${ownerDid}/org.slack.dm.message/${rkey}`, rkey, ownerDid, value: { text: `${ownerDid}-${rkey}` } };
}

test("interleaves two exhausted halves by rkey, newest first", () => {
  const alice: DmHalfPage = { ownerDid: "alice", records: [record("alice", "3"), record("alice", "1")], exhausted: true };
  const bob: DmHalfPage = { ownerDid: "bob", records: [record("bob", "4"), record("bob", "2")], exhausted: true };
  const result = mergeDmHalves([alice, bob], { limit: 10 });
  assert.deepEqual(result.messages.map((message) => message.rkey), ["4", "3", "2", "1"]);
  assert.deepEqual(result.needsMore, []);
  assert.equal(result.nextBefore, undefined, "no more history once every half is exhausted and fully returned");
});

test("uneven halves: a shallow page from one half still needs paging while its oldest fetched record could hide more within the window", () => {
  // Only the first two of heavy's records have been fetched so far; sparse's
  // single, exhausted record already sits inside the current top-3 window.
  const heavy: DmHalfPage = { ownerDid: "heavy", records: [record("heavy", "9"), record("heavy", "8")], exhausted: false };
  const sparse: DmHalfPage = { ownerDid: "sparse", records: [record("sparse", "7")], exhausted: true };
  const result = mergeDmHalves([heavy, sparse], { limit: 3 });
  assert.deepEqual(result.messages.map((message) => message.rkey), ["9", "8", "7"]);
  // heavy's oldest fetched record ("8") is still >= the cutoff ("7"), so there
  // could be an unfetched heavy record between them; sparse is exhausted and
  // already past the cutoff, so it needs no further paging.
  assert.deepEqual(result.needsMore, ["heavy"]);
  assert.equal(result.nextBefore, "7");
});

test("a needsMore half stops needing more once its oldest fetched record falls below the cutoff", () => {
  const heavy: DmHalfPage = { ownerDid: "heavy", records: ["9", "8", "7", "6", "5", "1"].map((rkey) => record("heavy", rkey)), exhausted: false };
  const sparse: DmHalfPage = { ownerDid: "sparse", records: [record("sparse", "4")], exhausted: true };
  const result = mergeDmHalves([heavy, sparse], { limit: 3 });
  assert.deepEqual(result.messages.map((message) => message.rkey), ["9", "8", "7"]);
  assert.deepEqual(result.needsMore, []);
});

test("the before cursor excludes records at or after it and pagination composes across calls", () => {
  const alice: DmHalfPage = { ownerDid: "alice", records: [record("alice", "5"), record("alice", "3"), record("alice", "1")], exhausted: true };
  const firstPage = mergeDmHalves([alice], { limit: 2 });
  assert.deepEqual(firstPage.messages.map((message) => message.rkey), ["5", "3"]);
  assert.equal(firstPage.nextBefore, "3");
  const secondPage = mergeDmHalves([alice], { limit: 2, before: firstPage.nextBefore });
  assert.deepEqual(secondPage.messages.map((message) => message.rkey), ["1"]);
  assert.equal(secondPage.nextBefore, undefined);
});

test("duplicate records for the same URI across repeated fetches are deduplicated", () => {
  const shared = record("alice", "2");
  const alice: DmHalfPage = { ownerDid: "alice", records: [shared, { ...shared }, record("alice", "1")], exhausted: true };
  const result = mergeDmHalves([alice], { limit: 10 });
  assert.deepEqual(result.messages.map((message) => message.rkey), ["2", "1"]);
});

test("an empty halves list returns no messages and no pagination", () => {
  const result = mergeDmHalves([], { limit: 5 });
  assert.deepEqual(result.messages, []);
  assert.deepEqual(result.needsMore, []);
  assert.equal(result.nextBefore, undefined);
});

test("rejects a non-positive-integer limit", () => {
  assert.throws(() => mergeDmHalves([], { limit: 0 }), RangeError);
  assert.throws(() => mergeDmHalves([], { limit: 1.5 }), RangeError);
});
