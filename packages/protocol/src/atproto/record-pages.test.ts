import assert from "node:assert/strict";
import test from "node:test";
import { XrpcError, type AtprotoClient } from "./xrpc";
import {
  RepoOpsPageError,
  WRITER_CURSOR_MAX_AGE_MS,
  WRITER_REMOVED_TYPE,
  WRITER_WRITE_TYPE,
  assertBoundedRecordPage,
  fetchRepoOpsPages,
  listAllSpaceUris,
  listBoundedMembers,
  listBoundedRecords,
  listBoundedSpaces,
  listBoundedWriters,
  listWritersSince,
  tidTimestampMs,
} from "./record-pages";

function writerWrite(did: string, rev: string, opts: { withType?: boolean } = {}) {
  const withType = opts.withType ?? true;
  return {
    ...(withType ? { $type: WRITER_WRITE_TYPE } : {}),
    repo: `did:plc:${did}`,
    repoRev: `r${rev}`,
    data: { $bytes: "AAAA" },
    spaceRev: rev,
  };
}

function writerRemoved(did: string, rev: string) {
  return {
    $type: WRITER_REMOVED_TYPE,
    repo: `did:plc:${did}`,
    spaceRev: rev,
  };
}

const TID_CHARS = "234567abcdefghijklmnopqrstuvwxyz";
function tidAtMs(ms: number): string {
  let val = BigInt(ms) * 1000n * 1024n;
  const out = Array<string>(13);
  for (let i = 12; i >= 0; i--) {
    out[i] = TID_CHARS[Number(val & 31n)]!;
    val >>= 5n;
  }
  return out.join("");
}

test("bounded writer lookahead distinguishes an exact limit from actual overflow", async () => {
  const exact = fakeClient([
    { repos: [writerWrite("a", "2"), writerWrite("b", "3")], cursor: "page-two" },
    { repos: [] },
  ]);
  const exactResult = await listBoundedWriters(exact.client, { space: "space", maxRepos: 2 });
  assert.equal(exactResult.writers.length, 2);
  assert.equal(exactResult.spaceRev, "3");
  assert.equal(exactResult.truncated, false);
  assert.deepEqual(exact.calls.map(({ limit, cursor }) => ({ limit, cursor })), [
    { limit: 2, cursor: undefined },
    { limit: 2, cursor: "page-two" },
  ]);

  const overflow = fakeClient([
    { repos: [writerWrite("a", "2", { withType: true }), writerWrite("b", "3")], cursor: "page-two" },
    { repos: [writerWrite("c", "4")] },
  ]);
  const overflowResult = await listBoundedWriters(overflow.client, { space: "space", maxRepos: 2 });
  assert.equal(overflowResult.writers.length, 2);
  assert.equal(overflowResult.spaceRev, "4");
  assert.equal(overflowResult.truncated, true);
});

test("bounded writer scan stops when page.repos.length < limit even with a non-empty cursor", async () => {
  const shortWithCursor = fakeClient([
    { repos: [writerWrite("a", "2"), writerWrite("b", "3")], cursor: "3" },
  ]);
  const result = await listBoundedWriters(shortWithCursor.client, { space: "space", maxRepos: 5 });
  assert.equal(result.writers.length, 2);
  assert.equal(result.spaceRev, "3");
  assert.equal(result.truncated, false);
  assert.equal(shortWithCursor.calls.length, 1);
});

test("bounded writer scan rejects oversized pages and malformed entries", async () => {
  const oversized = fakeClient([{ repos: [writerWrite("a", "2"), writerWrite("b", "3")] }]);
  await assert.rejects(
    listBoundedWriters(oversized.client, { space: "space", maxRepos: 1 }),
    /PDS writer page exceeded the requested limit/,
  );

  const emptyNonterminal = fakeClient([{ repos: [], cursor: "next" }]);
  await assert.rejects(
    listBoundedWriters(emptyNonterminal.client, { space: "space", maxRepos: 2 }),
    /empty nonterminal page/,
  );

  const malformedDid = fakeClient([{ repos: [{ $type: WRITER_WRITE_TYPE, repo: "not-a-did" }] }]);
  await assert.rejects(listBoundedWriters(malformedDid.client, { space: "space", maxRepos: 2 }), /malformed repo DID/);

  const unknownType = fakeClient([{ repos: [writerWrite("a", "2", { withType: false })] }]);
  await assert.rejects(listBoundedWriters(unknownType.client, { space: "space", maxRepos: 2 }), /unknown writer entry type/);

  const missingRevs = fakeClient([{ repos: [{ $type: WRITER_WRITE_TYPE, repo: "did:plc:a", rev: "old-shape", spaceRev: "2" }] }]);
  await assert.rejects(listBoundedWriters(missingRevs.client, { space: "space", maxRepos: 2 }), /without repoRev/);

  const descending = fakeClient([{ repos: [writerWrite("a", "3"), writerWrite("b", "2")] }]);
  await assert.rejects(listBoundedWriters(descending.client, { space: "space", maxRepos: 2 }), /ascending spaceRev order/);

  const stuck = fakeClient([{ repos: [writerWrite("a", "2")], cursor: "next" }, { repos: [writerWrite("b", "3")], cursor: "next" }]);
  await assert.rejects(listBoundedWriters(stuck.client, { space: "space", maxRepos: 1 }), /did not advance/);
});

test("a writer updated or removed while paginating uses latest-wins cross-page dedup", async () => {
  const reappearing = fakeClient([
    { repos: [writerWrite("a", "2"), writerWrite("b", "3")], cursor: "3" },
    { repos: [writerRemoved("a", "4"), writerWrite("c", "5")], cursor: "5" },
    { repos: [writerWrite("b", "6")] },
  ]);
  const result = await listBoundedWriters(reappearing.client, { space: "space", maxRepos: 2 });
  assert.deepEqual(
    result.writers.map(({ repo, spaceRev }) => [repo, spaceRev]),
    [["did:plc:b", "6"], ["did:plc:c", "5"]],
  );
  assert.equal(result.spaceRev, "6");
  assert.equal(result.truncated, false);
  assert.deepEqual(reappearing.calls.map(({ cursor }) => cursor), [undefined, "3", "5"]);
});

test("interleaved write past maxRepos followed by later #repoRemoved fits the bound without false truncation", async () => {
  // Exact Codex M2 case: maxRepos = 2, page 1 returns A@2, B@3; page 2 returns C@4, B#removed@5 -> {A@2, C@4}, truncated: false
  const interleaved = fakeClient([
    { repos: [writerWrite("a", "2"), writerWrite("b", "3")], cursor: "3" },
    { repos: [writerWrite("c", "4"), writerRemoved("b", "5")], cursor: "5" },
    { repos: [] },
  ]);
  const result = await listBoundedWriters(interleaved.client, { space: "space", maxRepos: 2 });
  assert.deepEqual(
    result.writers.map(({ repo, spaceRev }) => [repo, spaceRev]),
    [["did:plc:a", "2"], ["did:plc:c", "4"]],
  );
  assert.equal(result.spaceRev, "5");
  assert.equal(result.truncated, false);

  // Cross-page removal on page 3 after provisional overflow on page 2 also resolves to truncated: false
  const crossPageRemoval = fakeClient([
    { repos: [writerWrite("a", "2"), writerWrite("b", "3")], cursor: "3" },
    { repos: [writerWrite("c", "4"), writerWrite("d", "5")], cursor: "5" },
    { repos: [writerRemoved("b", "6"), writerRemoved("d", "7")] },
  ]);
  const crossPageResult = await listBoundedWriters(crossPageRemoval.client, { space: "space", maxRepos: 2 });
  assert.deepEqual(
    crossPageResult.writers.map(({ repo, spaceRev }) => [repo, spaceRev]),
    [["did:plc:a", "2"], ["did:plc:c", "4"]],
  );
  assert.equal(crossPageResult.spaceRev, "7");
  assert.equal(crossPageResult.truncated, false);

  // Raw-entry ceiling stops an infinite churn stream and flags truncated: true
  const churnPages = Array.from({ length: 10 }, (_, idx) => ({
    repos: [
      writerWrite("a", String(idx * 2 + 1).padStart(4, "0")),
      writerRemoved("b", String(idx * 2 + 2).padStart(4, "0")),
    ],
    cursor: `c${idx}`,
  }));
  const churnClient = fakeClient(churnPages);
  const capped = await listBoundedWriters(churnClient.client, { space: "space", maxRepos: 2, maxRawEntries: 6 });
  assert.equal(capped.truncated, true);
  assert.equal(capped.writers.length, 1);
  assert.equal(capped.writers[0]?.repo, "did:plc:a");
  assert.equal(churnClient.calls.length, 3);
});

test("remove-then-write across pages re-adds the writer at the newer entry", async () => {
  const readded = fakeClient([
    { repos: [writerRemoved("a", "2"), writerWrite("b", "3")], cursor: "3" },
    { repos: [writerWrite("a", "4")] },
  ]);
  const result = await listBoundedWriters(readded.client, { space: "space", maxRepos: 2 });
  assert.deepEqual(
    result.writers.map(({ repo, spaceRev }) => [repo, spaceRev]),
    [["did:plc:b", "3"], ["did:plc:a", "4"]],
  );
  assert.equal(result.spaceRev, "4");
  assert.equal(result.truncated, false);
});

test("removals do not consume maxRepos and do not trigger false truncation", async () => {
  const onlyRemovalsLookahead = fakeClient([
    { repos: [writerWrite("a", "2"), writerWrite("b", "3")], cursor: "3" },
    { repos: [writerRemoved("c", "4"), writerRemoved("b", "5")], cursor: "5" },
    { repos: [writerWrite("d", "6"), writerWrite("e", "7")] },
  ]);
  const result = await listBoundedWriters(onlyRemovalsLookahead.client, { space: "space", maxRepos: 2 });
  assert.deepEqual(
    result.writers.map(({ repo, spaceRev }) => [repo, spaceRev]),
    [["did:plc:a", "2"], ["did:plc:d", "6"]],
  );
  assert.equal(result.spaceRev, "7");
  assert.equal(result.truncated, true);
});

test("reappearing writers count once toward the bound and do not cause false truncation", async () => {
  const noisy = fakeClient([
    { repos: [writerWrite("a", "2"), writerWrite("b", "3")], cursor: "3" },
    { repos: [writerWrite("a", "4"), writerWrite("b", "5")], cursor: "5" },
    { repos: [writerWrite("a", "6")] },
  ]);
  const result = await listBoundedWriters(noisy.client, { space: "space", maxRepos: 2 });
  assert.deepEqual(result.writers.map(({ repo, spaceRev }) => [repo, spaceRev]), [["did:plc:a", "6"], ["did:plc:b", "5"]]);
  assert.equal(result.truncated, false);
});

test("a lookahead entry for an already collected writer does not truncate, a later new writer does", async () => {
  const lookahead = fakeClient([
    { repos: [writerWrite("a", "2"), writerWrite("b", "3")], cursor: "3" },
    { repos: [writerWrite("a", "4"), writerWrite("c", "5")] },
  ]);
  const result = await listBoundedWriters(lookahead.client, { space: "space", maxRepos: 2 });
  assert.deepEqual(result.writers.map(({ repo, spaceRev }) => [repo, spaceRev]), [["did:plc:a", "4"], ["did:plc:b", "3"]]);
  assert.equal(result.spaceRev, "5");
  assert.equal(result.truncated, true);
});

test("more distinct writers than the bound truncates", async () => {
  const overflow = fakeClient([
    { repos: [writerWrite("a", "2"), writerWrite("b", "3")], cursor: "3" },
    { repos: [writerWrite("c", "4")] },
  ]);
  const result = await listBoundedWriters(overflow.client, { space: "space", maxRepos: 2 });
  assert.equal(result.writers.length, 2);
  assert.equal(result.truncated, true);
});

test("the writer scan page cap still applies when every page repeats a known writer", async () => {
  const pages = Array.from({ length: 600 }, (_, i) => ({ repos: [writerWrite("a", String(i).padStart(4, "0"))], cursor: `c${i}` }));
  await assert.rejects(
    listBoundedWriters(fakeClient(pages).client, { space: "space", maxRepos: 1 }),
    /exceeded the bounded page limit/,
  );
});

function spaceEntry(space: string, id = 1) {
  return { spaceDid: `did:plc:sp${String(id).padStart(20, "0")}`, space };
}

test("bounded space lookahead distinguishes an exact limit from actual overflow", async () => {
  const owner = "did:plc:a";
  const uri = (skey: string) => `at://${owner}/space/new.flock.dm.conversation/${skey}`;
  const exact = fakeClient([
    { spaces: [spaceEntry(uri("2222222222222"), 1), spaceEntry(uri("2222222222223"), 2)], cursor: "page-two" },
    { spaces: [] },
  ]);
  const exactResult = await listBoundedSpaces(exact.client, { spaceType: "new.flock.dm.conversation", maxSpaces: 2 });
  assert.equal(exactResult.spaces.length, 2);
  assert.equal(exactResult.truncated, false);

  const overflow = fakeClient([
    { spaces: [spaceEntry(uri("2222222222222"), 1), spaceEntry(uri("2222222222223"), 2)], cursor: "page-two" },
    { spaces: [spaceEntry(uri("2222222222224"), 3)] },
  ]);
  const overflowResult = await listBoundedSpaces(overflow.client, { spaceType: "new.flock.dm.conversation", maxSpaces: 2 });
  assert.equal(overflowResult.spaces.length, 2);
  assert.equal(overflowResult.truncated, true);

  const malformed = fakeClient([{ spaces: [{ spaceDid: "did:plc:a", space: 5 }] }]);
  await assert.rejects(listBoundedSpaces(malformed.client, { maxSpaces: 2 }), /malformed space/);

  const repeated = fakeClient([
    { spaces: [spaceEntry(uri("2222222222221"), 1)], cursor: "next" },
    { spaces: [spaceEntry(uri("2222222222221"), 1)] },
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

  const typedMember = fakeClient([
    { members: [{ $type: "com.atproto.memberspace.defs#member", did: "did:plc:member", read: true, write: false }] },
  ]);
  const typedResult = await listBoundedMembers(typedMember.client, { space: "space", maxMembers: 2 });
  assert.equal(typedResult.members.length, 1);

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

test("workspace discovery returns every space URI at the exact limit and refuses to hide some when there are more", async () => {
  // #given an account with exactly as many channels as the limit, and another with one more
  const uri = (skey: string) => `at://did:plc:a/space/new.flock.channel/${skey}`;
  const exact = fakeClient([{ spaces: [spaceEntry(uri("a"), 1), spaceEntry(uri("b"), 2)], cursor: "next" }, { spaces: [] }]);
  const overflow = fakeClient([{ spaces: [spaceEntry(uri("a"), 1), spaceEntry(uri("b"), 2)], cursor: "next" }, { spaces: [spaceEntry(uri("c"), 3)] }]);

  // #when each is listed with a limit of two
  const listed = await listAllSpaceUris(exact.client, { spaceType: "new.flock.channel", maxSpaces: 2 });

  // #then the exact list is returned whole and the overflowing one is an error, not a silent truncation
  assert.deepEqual(listed, [uri("a"), uri("b")]);
  await assert.rejects(listAllSpaceUris(overflow.client, { spaceType: "new.flock.channel", maxSpaces: 2 }), /exceeds the 2-space discovery limit/);
});

test("a space whose URI exceeds record-key limits or fails literal:self is skipped, not a reason to fail the whole listing", async () => {
  const uri = (skey: string) => `at://did:plc:a/space/new.flock.channel/${skey}`;
  const page = fakeClient([
    {
      spaces: [
        spaceEntry(uri("a"), 1),
        spaceEntry(uri("k".repeat(513)), 2),
        spaceEntry("at://did:plc:a/space/new.flock.workspace/not-self", 3),
        spaceEntry("not-a-space-uri", 4),
        spaceEntry(uri("b"), 5),
      ],
    },
  ]);

  const listed = await listAllSpaceUris(page.client, { spaceType: "new.flock.channel", maxSpaces: 10 });

  assert.deepEqual(listed, [uri("a"), uri("b")]);
});

test("an unparseable space past the limit is not overflow, and a usable one behind it still is", async () => {
  const uri = (skey: string) => `at://did:plc:a/space/new.flock.dm.conversation/${skey}`;
  const junk = spaceEntry(`at://did:plc:a/space/new.flock.dm.conversation/${"k".repeat(200)}`, 99);

  // #given exactly two usable spaces, then an entry the app cannot parse and nothing after it
  const exact = fakeClient([
    { spaces: [spaceEntry(uri("2222222222222"), 1), spaceEntry(uri("2222222222223"), 2)], cursor: "more" },
    { spaces: [junk] },
  ]);
  // #and the same, but with a usable space behind the unparseable one
  const behind = fakeClient([
    { spaces: [spaceEntry(uri("2222222222222"), 1), spaceEntry(uri("2222222222223"), 2)], cursor: "more" },
    { spaces: [junk], cursor: "later" },
    { spaces: [spaceEntry(uri("2222222222224"), 3)] },
  ]);

  // #when each is listed with a limit of two
  const exactResult = await listBoundedSpaces(exact.client, { spaceType: "new.flock.dm.conversation", maxSpaces: 2 });
  const behindResult = await listBoundedSpaces(behind.client, { spaceType: "new.flock.dm.conversation", maxSpaces: 2 });

  // #then junk alone is not overflow, and a usable space behind junk is
  assert.equal(exactResult.truncated, false);
  assert.equal(behindResult.truncated, true);
  assert.equal(behindResult.spaces.length, 2);
});

test("skipped spaces do not count toward the limit, across pages", async () => {
  const uri = (skey: string) => `at://did:plc:a/space/new.flock.channel/${skey}`;
  const pages = fakeClient([
    { spaces: [spaceEntry(uri("a"), 1), spaceEntry("not-a-space-uri", 2)], cursor: "p2" },
    { spaces: [spaceEntry(uri("b"), 3)] },
  ]);

  const result = await listBoundedSpaces(pages.client, { spaceType: "new.flock.channel", maxSpaces: 2 });

  assert.deepEqual(result.spaces.map((space) => space.space), [uri("a"), uri("b")]);
  assert.equal(result.truncated, false);
});

test("the writers changed since a space revision are read page by page, a short page ending the scan", async () => {
  const entries = Array.from({ length: 150 }, (_, index) =>
    writerWrite(`w${String(index).padStart(3, "0")}`, `3jzfcijpj${String(index).padStart(4, "0")}`),
  );
  const requests: Array<string | undefined> = [];
  const client = {
    query: async (_method: string, params: { cursor?: string; limit: number }) => {
      requests.push(params.cursor);
      const start = params.cursor ? entries.findIndex((entry) => entry.spaceRev === params.cursor) + 1 : 0;
      const page = entries.slice(start, start + params.limit);
      return { repos: page, ...(page.length > 0 ? { cursor: page.at(-1)!.spaceRev } : {}) };
    },
  } as unknown as AtprotoClient;
  const changed = await listWritersSince(client, { space: "at://did:plc:a/space/new.flock.channel/x", since: null, maxRepos: 1_000 });
  assert.equal(changed.fullReconcile, false);
  assert.equal(changed.updates.length, 150);
  assert.equal(changed.spaceRev, entries.at(-1)!.spaceRev);
  assert.equal(requests.length, 2, "the second page is short, so no third request asks for an empty one");
  await assert.rejects(listWritersSince(client, { space: "at://did:plc:a/space/new.flock.channel/x", since: null, maxRepos: 99 }), /scan limit/);
});

test("listWritersSince handles removals and falls back to full reconcile on InvalidCursor or >72h cursor age", async () => {
  const space = "at://did:plc:a/space/new.flock.channel/x";
  const now = 1_760_000_000_000;
  const recentTid = tidAtMs(now - 60_000);
  const expiredTid = tidAtMs(now - WRITER_CURSOR_MAX_AGE_MS - 1_000);
  assert.equal(tidTimestampMs(recentTid), now - 60_000);
  assert.equal(tidTimestampMs("not-a-tid"), null);

  // Incremental page with write + removed
  const incrementalCalls: Array<{ cursor?: string }> = [];
  const incremental = {
    query: async (_method: string, params: { cursor?: string }) => {
      incrementalCalls.push({ cursor: params.cursor });
      return {
        repos: [
          writerWrite("a", tidAtMs(now - 30_000)),
          writerRemoved("b", tidAtMs(now - 10_000)),
        ],
      };
    },
  } as unknown as AtprotoClient;
  const incResult = await listWritersSince(incremental, { space, since: recentTid, now, maxRepos: 10 });
  assert.equal(incResult.fullReconcile, false);
  assert.deepEqual(incResult.updates.map((u) => [u.kind, u.repo]), [
    ["write", "did:plc:a"],
    ["removed", "did:plc:b"],
  ]);
  assert.equal(incrementalCalls[0]?.cursor, recentTid);

  // Expired TID (>72h) triggers fullReconcile without passing since cursor
  const expiredCalls: Array<{ cursor?: string }> = [];
  const fullFallback = {
    query: async (_method: string, params: { cursor?: string }) => {
      expiredCalls.push({ cursor: params.cursor });
      return { repos: [writerWrite("a", recentTid)] };
    },
  } as unknown as AtprotoClient;
  const expiredResult = await listWritersSince(fullFallback, { space, since: expiredTid, now, maxRepos: 10 });
  assert.equal(expiredResult.fullReconcile, true);
  assert.equal(expiredResult.writers?.length, 1);
  assert.equal(expiredCalls.length, 1);
  assert.equal(expiredCalls[0]?.cursor, undefined);

  // Expired sinceListedAt (>72h) triggers fullReconcile even for non-timestamp cursor
  const oldListedResult = await listWritersSince(fullFallback, {
    space,
    since: "0000000000001",
    sinceListedAt: now - WRITER_CURSOR_MAX_AGE_MS - 1,
    now,
    maxRepos: 10,
  });
  assert.equal(oldListedResult.fullReconcile, true);

  // Server InvalidCursor error triggers fullReconcile fallback
  let attempts = 0;
  const invalidCursorClient = {
    query: async (_method: string, params: { cursor?: string }) => {
      attempts++;
      if (params.cursor === recentTid) throw new XrpcError(400, "Cursor expired", "InvalidCursor");
      return { repos: [writerWrite("a", recentTid)] };
    },
  } as unknown as AtprotoClient;
  const recovered = await listWritersSince(invalidCursorClient, { space, since: recentTid, now, maxRepos: 10 });
  assert.equal(attempts, 2);
  assert.equal(recovered.fullReconcile, true);
  assert.equal(recovered.writers?.length, 1);

  // Incremental updates exceeding maxRepos due to churn + #repoRemoved tombstones fall back cleanly to fullReconciliation
  const churnQueries: Array<{ cursor?: string; limit?: number }> = [];
  const churnClient = {
    query: async (_method: string, params: { cursor?: string; limit?: number }) => {
      churnQueries.push(params);
      if (params.cursor === recentTid) {
        return {
          repos: [
            writerWrite("a", tidAtMs(now - 40_000)),
            writerRemoved("b", tidAtMs(now - 30_000)),
            writerWrite("c", tidAtMs(now - 20_000)),
          ],
          cursor: tidAtMs(now - 20_000),
        };
      }
      // Un-cursored fullBoundedWriters scan sees A@1, B@2, C@4, B#removed@5 -> active {A, C} <= maxRepos = 2
      if (!params.cursor) {
        return {
          repos: [
            writerWrite("a", tidAtMs(now - 40_000)),
            writerWrite("b", tidAtMs(now - 35_000)),
          ],
          cursor: tidAtMs(now - 35_000),
        };
      }
      return {
        repos: [
          writerWrite("c", tidAtMs(now - 20_000)),
          writerRemoved("b", tidAtMs(now - 10_000)),
        ],
      };
    },
  } as unknown as AtprotoClient;
  const churnReconciled = await listWritersSince(churnClient, { space, since: recentTid, now, maxRepos: 2 });
  assert.equal(churnReconciled.fullReconcile, true);
  assert.deepEqual(
    churnReconciled.writers?.map((w) => w.repo),
    ["did:plc:a", "did:plc:c"],
  );
  assert.equal(churnReconciled.spaceRev, tidAtMs(now - 10_000));
  assert.equal(churnQueries[0]?.cursor, recentTid);
  assert.equal(churnQueries[1]?.cursor, undefined);
});

test("fetchRepoOpsPages verifies commit presence on every page, passes RepoNotFound through, and strips/bounds fields", async () => {
  const space = "at://did:plc:a/space/new.flock.channel/x";
  const repo = "did:plc:writer1";
  const commitFor = (rev: string) => ({
    ver: 1,
    space,
    repo,
    rev,
    data: { $bytes: "AAAA" },
  });

  // Multi-page valid ops + unknown field stripped
  const queries: Array<Record<string, unknown>> = [];
  const multiPage = {
    query: async (_method: string, params: Record<string, unknown>) => {
      queries.push(params);
      if (!params.cursor) {
        return {
          cursor: "page2",
          commit: commitFor("3jzfcijpj2z2a"),
          ops: [
            {
              collection: "org.test.rec",
              rkey: "r1",
              rev: "3jzfcijpj2z2a",
              cid: "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              prev: null,
              value: { $type: "org.test.rec", body: "hello" },
              extraField: "should-be-stripped",
            },
          ],
        };
      }
      return {
        commit: commitFor("3jzfcijpj2z2b"),
        ops: [
          {
            collection: "org.test.rec",
            rkey: "r0",
            rev: "3jzfcijpj2z2b",
            cid: null,
            prev: "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
        ],
      };
    },
  } as unknown as AtprotoClient;
  const full = await fetchRepoOpsPages(multiPage, { space, repo, since: "3jzfcijpj2z20" });
  assert.equal(full.ops.length, 2);
  assert.equal(full.commit?.rev, "3jzfcijpj2z2b");
  assert.equal("extraField" in full.ops[0]!, false);
  assert.deepEqual(full.ops[0]!.value, { $type: "org.test.rec", body: "hello" });
  assert.equal(queries[0]?.excludeValues, undefined);

  // excludeValues omits record bodies and passes excludeValues: true
  const stripped = await fetchRepoOpsPages(
    {
      query: async (_method: string, params: Record<string, unknown>) => {
        assert.equal(params.excludeValues, true);
        return {
          commit: commitFor("3jzfcijpj2z2a"),
          ops: [
            {
              collection: "org.test.rec",
              rkey: "r1",
              rev: "3jzfcijpj2z2a",
              cid: "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              prev: null,
              value: { ignored: true },
            },
          ],
        };
      },
    } as unknown as AtprotoClient,
    { space, repo, excludeValues: true },
  );
  assert.equal("value" in stripped.ops[0]!, false);

  // Missing commit on an intermediate or empty final page rejects with RepoOpsPageError
  const missingIntermediateCommit = {
    query: async () => ({
      cursor: "next",
      ops: [{ collection: "org.test.rec", rkey: "r1", rev: "3jzfcijpj2z2a", cid: "bafyrei", prev: null }],
    }),
  } as unknown as AtprotoClient;
  await assert.rejects(fetchRepoOpsPages(missingIntermediateCommit, { space, repo }), RepoOpsPageError);

  const missingFinalCommit = {
    query: async () => ({ ops: [] }),
  } as unknown as AtprotoClient;
  await assert.rejects(fetchRepoOpsPages(missingFinalCommit, { space, repo }), RepoOpsPageError);

  // RepoNotFound passes through untouched
  const notFound = {
    query: async () => {
      throw new XrpcError(400, "Repo not found", "RepoNotFound");
    },
  } as unknown as AtprotoClient;
  await assert.rejects(
    fetchRepoOpsPages(notFound, { space, repo }),
    (err: unknown) => err instanceof XrpcError && err.code === "RepoNotFound",
  );
});

test("omitted collection allows shared rkeys across collections while rejecting duplicate (collection, rkey)", async () => {
  const space = "at://did:plc:auth/space/new.flock.workspace/ws";
  const repo = "did:plc:auth";
  // Same rkey "d-alice" in roster and admin is valid across collections.
  assert.doesNotThrow(() =>
    assertBoundedRecordPage(
      {
        records: [
          { collection: "new.flock.workspace.roster", rkey: "d-alice", cid: "bafyreia", value: { subject: "did:plc:alice" } },
          { collection: "new.flock.admin", rkey: "d-alice", cid: "bafyreib", value: { subject: "did:plc:alice" } },
        ],
      },
      { limit: 10, space, repo },
    ),
  );

  // Duplicate within the same collection is still rejected when collection is omitted.
  assert.throws(
    () =>
      assertBoundedRecordPage(
        {
          records: [
            { collection: "new.flock.admin", rkey: "d-alice", cid: "bafyreia", value: {} },
            { collection: "new.flock.admin", rkey: "d-alice", cid: "bafyreib", value: {} },
          ],
        },
        { limit: 10 },
      ),
    /duplicate record keys/,
  );

  // Across pages with collection omitted: shared rkey across collections succeeds, duplicate (collection, rkey) fails.
  const crossCollection = fakeClient([
    {
      records: [
        { collection: "new.flock.workspace.roster", rkey: "d-alice", cid: "bafyreia", value: { role: "member" } },
      ],
      cursor: "p2",
    },
    {
      records: [
        { collection: "new.flock.admin", rkey: "d-alice", cid: "bafyreib", value: { role: "admin" } },
      ],
    },
  ]);
  const fullRepo = await listBoundedRecords(crossCollection.client, { space, repo, maxRecords: 10 });
  assert.deepEqual(
    fullRepo.records.map((r) => [r.collection, r.rkey]),
    [["new.flock.workspace.roster", "d-alice"], ["new.flock.admin", "d-alice"]],
  );
  assert.equal(fullRepo.truncated, false);
  assert.equal("collection" in crossCollection.calls[0]!, false);

  const dupAcrossPages = fakeClient([
    { records: [{ collection: "new.flock.admin", rkey: "d-alice", cid: "bafyreia", value: {} }], cursor: "p2" },
    { records: [{ collection: "new.flock.admin", rkey: "d-alice", cid: "bafyreib", value: {} }] },
  ]);
  await assert.rejects(
    listBoundedRecords(dupAcrossPages.client, { space, repo, maxRecords: 10 }),
    /duplicate record key/,
  );
});

test("excludeValues allows omitted value on metadata pages while !excludeValues rejects missing values", async () => {
  const space = "at://did:plc:auth/space/new.flock.channel/general";
  const repo = "did:plc:writer";
  // excludeValues: true allows omitted value, requires valid cid.
  assert.doesNotThrow(() =>
    assertBoundedRecordPage(
      { records: [{ collection: "new.flock.channel.message", rkey: "a", cid: "bafyreia" }] },
      { limit: 5, excludeValues: true },
    ),
  );
  // excludeValues: true still rejects missing cid or non-object value if present.
  assert.throws(
    () => assertBoundedRecordPage({ records: [{ collection: "new.flock.channel.message", rkey: "a" }] }, { limit: 5, excludeValues: true }),
    /malformed record/,
  );
  assert.throws(
    () => assertBoundedRecordPage({ records: [{ collection: "new.flock.channel.message", rkey: "a", cid: "bafyreia", value: "bad" }] }, { limit: 5, excludeValues: true }),
    /malformed record/,
  );
  // excludeValues: false / omitted rejects missing or non-object value.
  assert.throws(
    () => assertBoundedRecordPage({ records: [{ collection: "new.flock.channel.message", rkey: "a", cid: "bafyreia" }] }, { limit: 5 }),
    /malformed record/,
  );
  assert.throws(
    () => assertBoundedRecordPage({ records: [{ collection: "new.flock.channel.message", rkey: "a", value: ["not-plain"] }] }, { limit: 5, excludeValues: false }),
    /malformed record/,
  );

  // listBoundedRecords with excludeValues: true + omitted collection returns header entries cleanly.
  const headersClient = fakeClient([
    {
      records: [
        { collection: "new.flock.channel.message", rkey: "k1", cid: "bafyrei1" },
        { collection: "new.flock.channel.reaction", rkey: "k1", cid: "bafyrei2" },
      ],
    },
  ]);
  const headers = await listBoundedRecords(headersClient.client, { space, repo, maxRecords: 10, excludeValues: true });
  assert.deepEqual(headers.records, [
    { collection: "new.flock.channel.message", rkey: "k1", cid: "bafyrei1" },
    { collection: "new.flock.channel.reaction", rkey: "k1", cid: "bafyrei2" },
  ]);
  assert.equal(headers.truncated, false);
});

test("record page validation checks collection NSID syntax and optional record.uri consistency", () => {
  const space = "at://did:plc:auth/space/new.flock.workspace/ws";
  const repo = "did:plc:writer";
  assert.throws(
    () => assertBoundedRecordPage({ records: [{ collection: "badnsid", rkey: "a", value: {} }] }, { limit: 5 }),
    /malformed record/,
  );
  assert.throws(
    () => assertBoundedRecordPage({ records: [{ collection: "", rkey: "a", value: {} }] }, { limit: 5 }),
    /malformed record/,
  );
  assert.doesNotThrow(() =>
    assertBoundedRecordPage(
      {
        records: [
          {
            collection: "new.flock.ext.tasks.task",
            rkey: "3jzfcijpj2z2a",
            cid: "bafyreia",
            uri: `${space}/${repo}/new.flock.ext.tasks.task/3jzfcijpj2z2a`,
            value: {},
          },
        ],
      },
      { limit: 5, space, repo },
    ),
  );
  assert.throws(
    () =>
      assertBoundedRecordPage(
        {
          records: [
            {
              collection: "new.flock.ext.tasks.task",
              rkey: "3jzfcijpj2z2a",
              cid: "bafyreia",
              uri: `${space}/${repo}/new.flock.ext.tasks.task/wrong-rkey`,
              value: {},
            },
          ],
        },
        { limit: 5, space, repo },
      ),
    /malformed record/,
  );
  assert.throws(
    () =>
      assertBoundedRecordPage(
        {
          records: [
            {
              collection: "new.flock.ext.tasks.task",
              rkey: "3jzfcijpj2z2a",
              cid: "bafyreia",
              uri: `${space}/did:plc:other/new.flock.ext.tasks.task/3jzfcijpj2z2a`,
              value: {},
            },
          ],
        },
        { limit: 5, space, repo },
      ),
    /malformed record/,
  );
});
