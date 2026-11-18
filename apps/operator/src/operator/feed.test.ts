import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { closeDb } from "../lib/db";
import { FeedRequestError, getChanges, MAX_FOLLOWED_SPACES, parseFollow, type FeedDeps, type Follow } from "./feed";
import { readNotices, recordWriteNotification } from "./notices";
import lexicon from "@flock/protocol/lexicons/new/flock/operator/getChanges.json";

// The change feed: which followed spaces changed, for whom, and what a held call does while it waits.

const DIRECTORY = mkdtempSync(join(tmpdir(), "slack-feed-test-"));
process.env.DATABASE_PATH = join(DIRECTORY, "feed.db");
process.env.AUTH_ENCRYPTION_KEY = "55".repeat(32);
process.env.APP_URL = "http://127.0.0.1:3000";
process.env.OPERATOR_SERVICE_REF = "did:web:operator.test#atproto_flock_operator";
after(() => {
  closeDb();
  rmSync(DIRECTORY, { recursive: true, force: true });
});

const MEMBER = "did:plc:member";
const GENERAL = "at://did:plc:owner/space/new.flock.channel/feed-general";
const SECRET = "at://did:plc:owner/space/new.flock.channel/feed-secret";
const notice = (space: string) => recordWriteNotification({ space, repo: "did:plc:writer", repoRev: "rev" });
const head = () => readNotices([]).head;
const deps = (allowed: Set<string>, holdMs = 3_000): FeedDeps => ({ mayFollow: async (space) => allowed.has(space), holdMs });

test("a call that follows nothing answers head at once", async () => {
  notice(GENERAL);
  const started = Date.now();
  const answer = await getChanges(MEMBER, [], undefined, deps(new Set()));
  assert.equal(answer.head, String(head()));
  assert.ok(Date.now() - started < 500);
});

test("a space the caller may not follow is denied and the others are answered; the denied cursor does not move", async () => {
  const from = head();
  notice(GENERAL);
  notice(SECRET);
  const answer = await getChanges(MEMBER, [{ space: GENERAL, after: from }, { space: SECRET, after: from }], undefined, deps(new Set([GENERAL])));
  assert.deepEqual(answer.changed.map((change) => change.space), [GENERAL]);
  assert.deepEqual(answer.denied, [SECRET]);
  assert.equal(answer.changed.some((change) => change.space === SECRET), false);
});

test("a call whose every space is denied answers at once, with nothing to wait for", async () => {
  const started = Date.now();
  const answer = await getChanges(MEMBER, [{ space: SECRET, after: head() }], undefined, deps(new Set(), 5_000));
  assert.deepEqual([answer.changed, answer.denied, answer.reset], [[], [SECRET], []]);
  assert.ok(Date.now() - started < 500);
});

test("a held call answers as soon as a followed space changes, with that space's newest cursor", async () => {
  const from = head();
  setTimeout(() => notice(GENERAL), 100);
  const started = Date.now();
  const answer = await getChanges(MEMBER, [{ space: GENERAL, after: from }], undefined, deps(new Set([GENERAL]), 5_000));
  assert.deepEqual(answer.changed, [{ space: GENERAL, cursor: String(head()) }]);
  assert.ok(Date.now() - started < 2_500, "woken by the shared poller within a second or so of the notice");
});

test("a member removed while the call waits is denied, not told the space changed", async () => {
  const from = head();
  const allowed = new Set([GENERAL]);
  setTimeout(() => {
    allowed.delete(GENERAL);
    notice(GENERAL);
  }, 100);
  const answer = await getChanges(MEMBER, [{ space: GENERAL, after: from }], undefined, deps(allowed, 5_000));
  assert.deepEqual([answer.changed, answer.denied], [[], [GENERAL]]);
});

test("a call with nothing new answers empty after the hold, or at once when the caller goes away", async () => {
  const quiet: Follow[] = [{ space: GENERAL, after: head() }];
  let started = Date.now();
  assert.deepEqual(await getChanges(MEMBER, quiet, undefined, deps(new Set([GENERAL]), 300)), { head: String(head()), changed: [], denied: [], reset: [] });
  assert.ok(Date.now() - started >= 300);
  const gone = new AbortController();
  setTimeout(() => gone.abort(), 100);
  started = Date.now();
  await getChanges(MEMBER, quiet, gone.signal, deps(new Set([GENERAL]), 5_000));
  assert.ok(Date.now() - started < 1_000);
});

test("a cursor older than the notices kept for its space is reset, for that space only", async () => {
  const from = head();
  notice(SECRET);
  for (let index = 0; index < 1_001; index += 1) notice(GENERAL);
  const answer = await getChanges(MEMBER, [{ space: GENERAL, after: from }, { space: SECRET, after: from }], undefined, deps(new Set([GENERAL, SECRET])));
  assert.deepEqual(answer.reset, [GENERAL]);
  assert.deepEqual(answer.changed.map((change) => change.space), [SECRET]);
});

test("a request is refused past 200 spaces, with a space twice, or with a cursor that is not a decimal whole number", () => {
  const entry = (index: number) => ({ space: `at://did:plc:owner/space/new.flock.channel/c${index}`, after: "0" });
  assert.equal(parseFollow({ follow: Array.from({ length: MAX_FOLLOWED_SPACES }, (_, index) => entry(index)) }).length, MAX_FOLLOWED_SPACES);
  assert.throws(() => parseFollow({ follow: Array.from({ length: MAX_FOLLOWED_SPACES + 1 }, (_, index) => entry(index)) }), FeedRequestError);
  assert.throws(() => parseFollow({ follow: [entry(1), entry(1)] }), FeedRequestError);
  for (const after of ["-1", "1.5", "01", "1e3", 7, "9007199254740993"]) assert.throws(() => parseFollow({ follow: [{ space: GENERAL, after }] }), FeedRequestError);
  assert.throws(() => parseFollow({ follow: [], extra: true }), FeedRequestError);
});

test("the published lexicon allows exactly the spaces the operator serves in one call", () => {
  assert.equal(lexicon.defs.main.input.schema.properties.follow.maxLength, MAX_FOLLOWED_SPACES);
});
