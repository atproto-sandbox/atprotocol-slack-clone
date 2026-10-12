import assert from "node:assert/strict";
import test from "node:test";
import type { AtprotoClient } from "./xrpc";
import { assertBoundedRecordPage, listBoundedMembers, listBoundedRecords, listBoundedRepos, listBoundedSpaces } from "./record-pages";

test("bounded repo lookahead distinguishes an exact limit from actual overflow", async () => {
  const exact = fakeClient([
    { repos: [{ did: "did:plc:a" }, { did: "did:plc:b" }], cursor: "page-two" },
    { repos: [] },
  ]);
  const exactResult = await listBoundedRepos(exact.client, { space: "space", maxRepos: 2 });
  assert.equal(exactResult.repos.length, 2);
  assert.equal(exactResult.truncated, false);
  assert.deepEqual(exact.calls.map(({ limit, cursor }) => ({ limit, cursor })), [
    { limit: 2, cursor: undefined },
    { limit: 1, cursor: "page-two" },
  ]);

  const overflow = fakeClient([
    { repos: [{ did: "did:plc:a" }, { did: "did:plc:b" }], cursor: "page-two" },
    { repos: [{ did: "did:plc:c" }] },
  ]);
  const overflowResult = await listBoundedRepos(overflow.client, { space: "space", maxRepos: 2 });
  assert.equal(overflowResult.repos.length, 2);
  assert.equal(overflowResult.truncated, true);
});

test("bounded repo scan rejects oversized pages and empty nonterminal pages", async () => {
  const oversized = fakeClient([{ repos: [{ did: "did:plc:a" }, { did: "did:plc:b" }] }]);
  await assert.rejects(
    listBoundedRepos(oversized.client, { space: "space", maxRepos: 1 }),
    /PDS repo page exceeded the requested limit/,
  );

  const emptyNonterminal = fakeClient([{ repos: [], cursor: "next" }]);
  await assert.rejects(
    listBoundedRepos(emptyNonterminal.client, { space: "space", maxRepos: 2 }),
    /empty nonterminal page/,
  );

  const malformedDid = fakeClient([{ repos: [{ did: "not-a-did" }] }]);
  await assert.rejects(listBoundedRepos(malformedDid.client, { space: "space", maxRepos: 2 }), /malformed repo DID/);

  const repeatedDid = fakeClient([
    { repos: [{ did: "did:plc:a" }], cursor: "next" },
    { repos: [{ did: "did:plc:a" }] },
  ]);
  await assert.rejects(listBoundedRepos(repeatedDid.client, { space: "space", maxRepos: 2 }), /duplicate repo DID/);
});

test("bounded space lookahead distinguishes an exact limit from actual overflow", async () => {
  const owner = "did:plc:a";
  const uri = (skey: string) => `at://${owner}/space/org.slack.dm.conversation/${skey}`;
  const exact = fakeClient([
    { spaces: [{ uri: uri("2222222222221") }, { uri: uri("2222222222222") }], cursor: "page-two" },
    { spaces: [] },
  ]);
  const exactResult = await listBoundedSpaces(exact.client, { type: "org.slack.dm.conversation", maxSpaces: 2 });
  assert.equal(exactResult.spaces.length, 2);
  assert.equal(exactResult.truncated, false);

  const overflow = fakeClient([
    { spaces: [{ uri: uri("2222222222221") }, { uri: uri("2222222222222") }], cursor: "page-two" },
    { spaces: [{ uri: uri("2222222222223") }] },
  ]);
  const overflowResult = await listBoundedSpaces(overflow.client, { type: "org.slack.dm.conversation", maxSpaces: 2 });
  assert.equal(overflowResult.spaces.length, 2);
  assert.equal(overflowResult.truncated, true);

  const malformed = fakeClient([{ spaces: [{ uri: "not-a-space-uri" }] }]);
  await assert.rejects(listBoundedSpaces(malformed.client, { maxSpaces: 2 }), /malformed space URI/);

  const repeated = fakeClient([
    { spaces: [{ uri: uri("2222222222221") }], cursor: "next" },
    { spaces: [{ uri: uri("2222222222221") }] },
  ]);
  await assert.rejects(listBoundedSpaces(repeated.client, { maxSpaces: 2 }), /duplicate space URI/);
});

test("record page validation rejects malformed rows, repeated cursors, and empty continuations", () => {
  const collection = "org.test.record";
  assert.throws(() => assertBoundedRecordPage({ records: [{ value: {} }] }, { collection, limit: 1 }), /malformed record/);
  assert.throws(() => assertBoundedRecordPage({ records: [{ collection, rkey: "a", value: {} }], cursor: "same" }, { collection, limit: 1, cursor: "same" }), /did not advance/);
  assert.throws(() => assertBoundedRecordPage({ records: [], cursor: "next" }, { collection, limit: 1 }), /empty nonterminal page/);
  assert.throws(() => assertBoundedRecordPage({ records: [{ collection, rkey: "a", value: {} }, { collection, rkey: "a", value: {} }] }, { collection, limit: 2 }), /duplicate record keys/);
  assert.throws(() => assertBoundedRecordPage({ records: [{ collection: "org.test.other", rkey: "a", value: {} }] }, { collection, limit: 1 }), /unexpected collection/);
});

test("bounded collection lookahead distinguishes an exact limit from actual overflow", async () => {
  const exact = fakeClient([
    { records: [{ rkey: "a", value: {} }, { rkey: "b", value: {} }], cursor: "page-two" },
    { records: [] },
  ]);
  const exactResult = await listBoundedRecords(exact.client, { space: "space", repo: "did:plc:test", collection: "org.test.record", maxRecords: 2 });
  assert.equal(exactResult.records.length, 2);
  assert.equal(exactResult.truncated, false);
  assert.deepEqual(exact.calls.map(({ limit, cursor }) => ({ limit, cursor })), [
    { limit: 2, cursor: undefined },
    { limit: 1, cursor: "page-two" },
  ]);

  const overflow = fakeClient([
    { records: [{ rkey: "a", value: {} }, { rkey: "b", value: {} }], cursor: "page-two" },
    { records: [{ rkey: "c", value: {} }] },
  ]);
  const overflowResult = await listBoundedRecords(overflow.client, { space: "space", repo: "did:plc:test", collection: "org.test.record", maxRecords: 2 });
  assert.equal(overflowResult.records.length, 2);
  assert.equal(overflowResult.truncated, true);
});

test("bounded member lookahead distinguishes an exact limit from actual overflow", async () => {
  const exact = fakeClient([
    { members: [{ did: "did:plc:a", read: true, write: true }, { did: "did:plc:b", read: true, write: true }], cursor: "page-two" },
    { members: [] },
  ]);
  const exactResult = await listBoundedMembers(exact.client, { space: "space", maxMembers: 2 });
  assert.equal(exactResult.members.length, 2);
  assert.equal(exactResult.truncated, false);
  assert.deepEqual(exact.calls.map(({ limit, cursor }) => ({ limit, cursor })), [
    { limit: 2, cursor: undefined },
    { limit: 1, cursor: "page-two" },
  ]);

  const overflow = fakeClient([
    { members: [{ did: "did:plc:a", read: true, write: true }, { did: "did:plc:b", read: true, write: true }], cursor: "page-two" },
    { members: [{ did: "did:plc:c", read: true, write: true }] },
  ]);
  const overflowResult = await listBoundedMembers(overflow.client, { space: "space", maxMembers: 2 });
  assert.equal(overflowResult.members.length, 2);
  assert.equal(overflowResult.truncated, true);
});

test("bounded scanners reject malformed and non-advancing PDS pages", async () => {
  const oversizedRecords = fakeClient([{ records: [{ rkey: "a", value: {} }, { rkey: "b", value: {} }] }]);
  await assert.rejects(
    listBoundedRecords(oversizedRecords.client, { space: "space", repo: "did:plc:test", collection: "org.test.record", maxRecords: 1 }),
    /PDS record page exceeded the requested limit/,
  );

  const emptyMembers = fakeClient([{ members: [], cursor: "next" }]);
  await assert.rejects(
    listBoundedMembers(emptyMembers.client, { space: "space", maxMembers: 2 }),
    /empty nonterminal page/,
  );
  assert.equal(emptyMembers.calls.length, 1);

  for (const member of [
    { did: "not-a-did", read: true, write: true },
    { did: "did:plc:member", read: 1, write: true },
    { did: "did:plc:member", read: true, write: false, $type: "wrong" },
  ]) {
    const malformedMembers = fakeClient([{ members: [member] }]);
    await assert.rejects(listBoundedMembers(malformedMembers.client, { space: "space", maxMembers: 2 }), /malformed member/);
  }

  const repeatedMember = fakeClient([
    { members: [{ did: "did:plc:a", read: true, write: true }], cursor: "next" },
    { members: [{ did: "did:plc:a", read: false, write: true }] },
  ]);
  await assert.rejects(listBoundedMembers(repeatedMember.client, { space: "space", maxMembers: 2 }), /duplicate member DID/);

  const invalidCursor = fakeClient([{ members: [], cursor: 42 }]);
  await assert.rejects(listBoundedMembers(invalidCursor.client, { space: "space", maxMembers: 2 }), /invalid cursor/);

  const repeatedCursor = fakeClient([
    { members: [{ did: "did:plc:a", read: true, write: true }], cursor: "page-a" },
    { members: [{ did: "did:plc:b", read: true, write: true }], cursor: "page-b" },
    { members: [{ did: "did:plc:c", read: true, write: true }], cursor: "page-a" },
  ]);
  await assert.rejects(listBoundedMembers(repeatedCursor.client, { space: "space", maxMembers: 5 }), /did not advance/);

  const loopingRecords = fakeClient([
    { records: [{ rkey: "a", value: {} }], cursor: "cursor-a" },
    { records: [{ rkey: "b", value: {} }], cursor: "cursor-b" },
    { records: [{ rkey: "c", value: {} }], cursor: "cursor-a" },
  ]);
  await assert.rejects(
    listBoundedRecords(loopingRecords.client, { space: "space", repo: "did:plc:test", collection: "org.test.record", maxRecords: 4 }),
    /did not advance/,
  );

  const repeatedRecord = fakeClient([
    { records: [{ rkey: "a", value: {} }], cursor: "next" },
    { records: [{ rkey: "a", value: {} }] },
  ]);
  await assert.rejects(
    listBoundedRecords(repeatedRecord.client, { space: "space", repo: "did:plc:test", collection: "org.test.record", maxRecords: 3 }),
    /duplicate record key/,
  );
});

function fakeClient(pages: Array<Record<string, unknown>>) {
  const calls: Array<{ limit?: number; cursor?: string }> = [];
  const client = {
    query: async (_method: string, input: { limit?: number; cursor?: string; collection?: string }) => {
      calls.push(input);
      const page = pages.shift();
      assert.ok(page, "all fixture pages should be consumed");
      if (Array.isArray(page.records)) {
        page.records = page.records.map((record) => ({ collection: input.collection, ...(record as Record<string, unknown>) }));
      }
      return page;
    },
  } as unknown as AtprotoClient;
  return { client, calls };
}
