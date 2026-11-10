import assert from "node:assert/strict";
import test from "node:test";
import type { AtprotoClient } from "./xrpc";
import { assertBoundedRecordPage, listAllSpaceUris, listBoundedMembers, listBoundedRecords, listBoundedRepos, listBoundedSpaces } from "./record-pages";

function repo(did: string, rev: string) {
  return { did: `did:plc:${did}`, repoRev: `r${rev}`, data: { $bytes: "AAAA" }, spaceRev: rev };
}

test("bounded repo lookahead distinguishes an exact limit from actual overflow", async () => {
  const exact = fakeClient([
    { repos: [repo("a", "2"), repo("b", "3")], cursor: "page-two" },
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
    { repos: [repo("a", "2"), repo("b", "3")], cursor: "page-two" },
    { repos: [repo("c", "4")] },
  ]);
  const overflowResult = await listBoundedRepos(overflow.client, { space: "space", maxRepos: 2 });
  assert.equal(overflowResult.repos.length, 2);
  assert.equal(overflowResult.truncated, true);
});

test("bounded repo scan rejects oversized pages and empty nonterminal pages", async () => {
  const oversized = fakeClient([{ repos: [repo("a", "2"), repo("b", "3")] }]);
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

  const missingRevs = fakeClient([{ repos: [{ did: "did:plc:a", rev: "old-shape" }] }]);
  await assert.rejects(listBoundedRepos(missingRevs.client, { space: "space", maxRepos: 2 }), /without repoRev and spaceRev/);

  const descending = fakeClient([{ repos: [repo("a", "3"), repo("b", "2")] }]);
  await assert.rejects(listBoundedRepos(descending.client, { space: "space", maxRepos: 2 }), /ascending spaceRev order/);

  const stuck = fakeClient([{ repos: [repo("a", "2")], cursor: "next" }, { repos: [repo("b", "3")], cursor: "next" }]);
  await assert.rejects(listBoundedRepos(stuck.client, { space: "space", maxRepos: 5 }), /did not advance/);
});

test("a repo updated while paginating reappears and the writer set keeps its latest entry", async () => {
  const reappearing = fakeClient([
    { repos: [repo("a", "2"), repo("b", "3")], cursor: "3" },
    { repos: [repo("a", "5"), repo("c", "6")] },
  ]);
  const result = await listBoundedRepos(reappearing.client, { space: "space", maxRepos: 4 });
  assert.deepEqual(result.repos.map(({ did, spaceRev }) => [did, spaceRev]), [["did:plc:a", "5"], ["did:plc:b", "3"], ["did:plc:c", "6"]]);
  assert.equal(result.truncated, false);
  assert.deepEqual(reappearing.calls.map(({ cursor }) => cursor), [undefined, "3"]);
});

test("reappearing repos count once toward the bound and do not cause false truncation", async () => {
  const noisy = fakeClient([
    { repos: [repo("a", "2"), repo("b", "3")], cursor: "3" },
    { repos: [repo("a", "4")], cursor: "4" },
    { repos: [repo("b", "5")], cursor: "5" },
    { repos: [repo("a", "6")] },
  ]);
  const result = await listBoundedRepos(noisy.client, { space: "space", maxRepos: 2 });
  assert.deepEqual(result.repos.map(({ did, spaceRev }) => [did, spaceRev]), [["did:plc:a", "6"], ["did:plc:b", "5"]]);
  assert.equal(result.truncated, false);
});

test("a lookahead entry for an already collected repo does not truncate, a later new repo does", async () => {
  const lookahead = fakeClient([
    { repos: [repo("a", "2"), repo("b", "3")], cursor: "3" },
    { repos: [repo("a", "4")], cursor: "4" },
    { repos: [repo("c", "5")] },
  ]);
  const result = await listBoundedRepos(lookahead.client, { space: "space", maxRepos: 2 });
  assert.deepEqual(result.repos.map(({ did, spaceRev }) => [did, spaceRev]), [["did:plc:a", "4"], ["did:plc:b", "3"]]);
  assert.equal(result.truncated, true);
});

test("more distinct repos than the bound truncates", async () => {
  const overflow = fakeClient([
    { repos: [repo("a", "2"), repo("b", "3")], cursor: "3" },
    { repos: [repo("c", "4")] },
  ]);
  const result = await listBoundedRepos(overflow.client, { space: "space", maxRepos: 2 });
  assert.equal(result.repos.length, 2);
  assert.equal(result.truncated, true);
});

test("the repo scan page cap still applies when every page repeats a known repo", async () => {
  const pages = Array.from({ length: 600 }, (_, i) => ({ repos: [repo("a", String(i).padStart(4, "0"))], cursor: `c${i}` }));
  await assert.rejects(
    listBoundedRepos(fakeClient(pages).client, { space: "space", maxRepos: 2 }),
    /exceeded the bounded page limit/,
  );
});

test("bounded space lookahead distinguishes an exact limit from actual overflow", async () => {
  const owner = "did:plc:a";
  const uri = (skey: string) => `at://${owner}/space/new.flock.dm.conversation/${skey}`;
  const exact = fakeClient([
    { spaces: [{ uri: uri("2222222222221") }, { uri: uri("2222222222222") }], cursor: "page-two" },
    { spaces: [] },
  ]);
  const exactResult = await listBoundedSpaces(exact.client, { spaceType: "new.flock.dm.conversation", maxSpaces: 2 });
  assert.equal(exactResult.spaces.length, 2);
  assert.equal(exactResult.truncated, false);

  const overflow = fakeClient([
    { spaces: [{ uri: uri("2222222222221") }, { uri: uri("2222222222222") }], cursor: "page-two" },
    { spaces: [{ uri: uri("2222222222223") }] },
  ]);
  const overflowResult = await listBoundedSpaces(overflow.client, { spaceType: "new.flock.dm.conversation", maxSpaces: 2 });
  assert.equal(overflowResult.spaces.length, 2);
  assert.equal(overflowResult.truncated, true);

  const malformed = fakeClient([{ spaces: [{ uri: 5 }] }]);
  await assert.rejects(listBoundedSpaces(malformed.client, { maxSpaces: 2 }), /malformed space/);

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

test("workspace discovery returns every space URI at the exact limit and refuses to hide some when there are more", async () => {
  // #given an account with exactly as many workspaces as the limit, and another with one more
  const uri = (skey: string) => `at://did:plc:a/space/new.flock.workspace/${skey}`;
  const exact = fakeClient([{ spaces: [{ uri: uri("a") }, { uri: uri("b") }], cursor: "next" }, { spaces: [] }]);
  const overflow = fakeClient([{ spaces: [{ uri: uri("a") }, { uri: uri("b") }], cursor: "next" }, { spaces: [{ uri: uri("c") }] }]);

  // #when each is listed with a limit of two
  const listed = await listAllSpaceUris(exact.client, { spaceType: "new.flock.workspace", maxSpaces: 2 });

  // #then the exact list is returned whole and the overflowing one is an error, not a silent truncation
  assert.deepEqual(listed, [uri("a"), uri("b")]);
  await assert.rejects(listAllSpaceUris(overflow.client, { spaceType: "new.flock.workspace", maxSpaces: 2 }), /exceeds the 2-space discovery limit/);
});

test("a space whose URI this app cannot parse is skipped, not a reason to fail the whole listing", async () => {
  // #given an account whose store holds a workspace with a record key longer than this app creates, between two ordinary ones
  const uri = (skey: string) => `at://did:plc:a/space/new.flock.workspace/${skey}`;
  const page = fakeClient([{ spaces: [{ uri: uri("a") }, { uri: uri("k".repeat(200)) }, { uri: "not-a-space-uri" }, { uri: uri("b") }] }]);

  // #when workspaces are discovered
  const listed = await listAllSpaceUris(page.client, { spaceType: "new.flock.workspace", maxSpaces: 10 });

  // #then the usable ones are returned and the rest are ignored
  assert.deepEqual(listed, [uri("a"), uri("b")]);
});

test("an unparseable space past the limit is not overflow, and a usable one behind it still is", async () => {
  const uri = (skey: string) => `at://did:plc:a/space/new.flock.dm.conversation/${skey}`;
  const junk = { uri: `at://did:plc:a/space/new.flock.dm.conversation/${"k".repeat(200)}` };

  // #given exactly two usable spaces, then an entry the app cannot parse and nothing after it
  const exact = fakeClient([{ spaces: [{ uri: uri("2222222222221") }, { uri: uri("2222222222222") }], cursor: "more" }, { spaces: [junk] }]);
  // #and the same, but with a usable space behind the unparseable one
  const behind = fakeClient([
    { spaces: [{ uri: uri("2222222222221") }, { uri: uri("2222222222222") }], cursor: "more" },
    { spaces: [junk], cursor: "later" },
    { spaces: [{ uri: uri("2222222222223") }] },
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
  const uri = (skey: string) => `at://did:plc:a/space/new.flock.workspace/${skey}`;
  const pages = fakeClient([
    { spaces: [{ uri: uri("a") }, { uri: "not-a-space-uri" }], cursor: "p2" },
    { spaces: [{ uri: uri("b") }] },
  ]);

  const result = await listBoundedSpaces(pages.client, { spaceType: "new.flock.workspace", maxSpaces: 2 });

  assert.deepEqual(result.spaces.map((space) => space.uri), [uri("a"), uri("b")]);
  assert.equal(result.truncated, false);
});

test("the writers changed since a space revision are read page by page, a short page ending the scan", async () => {
  const { listReposSince } = await import("./record-pages");
  const repos = Array.from({ length: 150 }, (_, index) => ({ did: `did:plc:w${String(index).padStart(3, "0")}`, repoRev: "3jzfcijpj2z2a", spaceRev: `3jzfcijpj${String(index).padStart(4, "0")}` }));
  const requests: Array<string | undefined> = [];
  const client = {
    query: async (_method: string, params: { cursor?: string; limit: number }) => {
      requests.push(params.cursor);
      const start = params.cursor ? repos.findIndex((repo) => repo.spaceRev === params.cursor) + 1 : 0;
      const page = repos.slice(start, start + params.limit);
      return { repos: page, ...(page.length > 0 ? { cursor: page.at(-1)!.spaceRev } : {}) };
    },
  } as unknown as Parameters<typeof listReposSince>[0];
  const changed = await listReposSince(client, { space: "at://did:plc:a/space/new.flock.channel/x", since: null, maxRepos: 1_000 });
  assert.equal(changed.repos.length, 150);
  assert.equal(changed.spaceRev, repos.at(-1)!.spaceRev);
  assert.equal(requests.length, 2, "the second page is short, so no third request asks for an empty one");
  await assert.rejects(listReposSince(client, { space: "at://did:plc:a/space/new.flock.channel/x", since: null, maxRepos: 99 }), /scan limit/);
});
