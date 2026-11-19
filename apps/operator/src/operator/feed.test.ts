import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { dmConversationUri, dmInboxUri, tidNow } from "@flock/protocol/keys";
import { closeDb, getRawDb } from "../lib/db";
import {
  currentDmWakeHead,
  DM_WAKE_RATE_LIMIT_MAX,
  DmRateLimitError,
  recordDmWake,
  resetDmFeedWakesForTests,
} from "./dm-feed-wakes";
import {
  FeedRequestError,
  formatFeedCursor,
  getChanges,
  MAX_FOLLOWED_SPACES,
  parseCursorString,
  parseFollow,
  type FeedDeps,
  type Follow,
} from "./feed";
import { readNotices, recordWriteNotification } from "./notices";
import lexicon from "@flock/protocol/lexicons/new/flock/operator/getChanges.json";

// The change feed: merges SQLite workspace/channel notices with ephemeral in-memory DM wakes under opaque <=16-char cursors.

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
const dbHead = () => readNotices([]).head;
const combinedHead = (did = MEMBER) => {
  const dm = currentDmWakeHead(did);
  return formatFeedCursor(dm.epoch, dbHead(), dm.head);
};
const followAt = (space: string, cursorStr: string): Follow => {
  const parsed = parseCursorString(cursorStr);
  return { space, after: parsed.after, dmCursor: parsed.dmCursor };
};
const deps = (allowed: Set<string>, holdMs = 3_000): FeedDeps => ({ mayFollow: async (space) => allowed.has(space), holdMs });

function assertZeroDmRowsInSqlite(): void {
  const db = getRawDb();
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>)
    .map((row) => row.name);
  for (const table of tables) {
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
    for (const col of columns) {
      const hit = db.prepare(`SELECT 1 FROM ${table} WHERE CAST(${col} AS TEXT) LIKE '%new.flock.dm.%' LIMIT 1`).get();
      assert.equal(hit, undefined, `expected zero DM references in ${table}.${col}`);
    }
  }
}

test("a call that follows nothing answers combined head at once within the 16-char lexicon limit", async () => {
  notice(GENERAL);
  const started = Date.now();
  const answer = await getChanges(MEMBER, [], undefined, deps(new Set()));
  assert.equal(answer.head, combinedHead());
  assert.ok(answer.head.length <= 16, `cursor ${answer.head} exceeds 16 chars`);
  assert.ok(Date.now() - started < 500);
});

test("a space the caller may not follow is denied and the others are answered; the denied cursor does not move", async () => {
  const from = dbHead();
  notice(GENERAL);
  notice(SECRET);
  const answer = await getChanges(MEMBER, [{ space: GENERAL, after: from }, { space: SECRET, after: from }], undefined, deps(new Set([GENERAL])));
  assert.deepEqual(answer.changed.map((change) => change.space), [GENERAL]);
  assert.deepEqual(answer.denied, [SECRET]);
  assert.equal(answer.changed.some((change) => change.space === SECRET), false);
});

test("a call whose every space is denied answers at once, with nothing to wait for", async () => {
  const started = Date.now();
  const answer = await getChanges(MEMBER, [{ space: SECRET, after: dbHead() }], undefined, deps(new Set(), 5_000));
  assert.deepEqual([answer.changed, answer.denied, answer.reset], [[], [SECRET], []]);
  assert.ok(Date.now() - started < 500);
});

test("a held call answers as soon as a followed workspace space changes, with that space's newest cursor", async () => {
  const from = combinedHead();
  setTimeout(() => notice(GENERAL), 80);
  const started = Date.now();
  const answer = await getChanges(MEMBER, [followAt(GENERAL, from)], undefined, deps(new Set([GENERAL]), 5_000));
  assert.deepEqual(answer.changed, [{ space: GENERAL, cursor: combinedHead() }]);
  assert.ok(Date.now() - started < 1_000, "woken immediately by onSpaceNotice listener");
});

test("ephemeral DM wakes wake held long-polls with zero SQLite rows, and an operator restart resets DM cursors without resetting workspace cursors", async () => {
  resetDmFeedWakesForTests();
  const dmInbox = dmInboxUri(MEMBER);
  const dmConv = dmConversationUri(MEMBER, "3kabcdefghij2");
  const allowed = new Set([GENERAL, dmInbox, dmConv]);

  // Initial head read before syncing spaces (as ChangeFollower.follow does)
  const initialHead = (await getChanges(MEMBER, [], undefined, deps(allowed))).head;

  // Held poll wakes as soon as a DM wake arrives in memory for that caller
  setTimeout(() => { void recordDmWake(MEMBER, dmConv); }, 60);
  const started = Date.now();
  const wakeAnswer = await getChanges(
    MEMBER,
    [followAt(GENERAL, initialHead), followAt(dmInbox, initialHead), followAt(dmConv, initialHead)],
    undefined,
    deps(allowed, 5_000),
  );
  assert.ok(Date.now() - started < 1_000, "DM wake resolves long-poll immediately");
  assert.deepEqual(wakeAnswer.changed.map((c) => c.space), [dmConv]);
  assert.deepEqual(wakeAnswer.reset, []);
  assertZeroDmRowsInSqlite();

  // Advance DM cursor to the answered cursor, then simulate an operator restart (new boot epoch, cleared RAM state)
  const dmConvCursor = wakeAnswer.changed[0]!.cursor;
  resetDmFeedWakesForTests();

  const afterRestart = await getChanges(
    MEMBER,
    [followAt(GENERAL, initialHead), followAt(dmInbox, initialHead), followAt(dmConv, dmConvCursor)],
    undefined,
    deps(allowed, 300),
  );
  assert.deepEqual(
    afterRestart.reset,
    [dmInbox, dmConv],
    "followed DM spaces receive immediate reset on operator restart so clients resync missed wakes",
  );
  assert.equal(
    afterRestart.reset.includes(GENERAL),
    false,
    "SQLite-backed channel cursors survive operator restarts without unnecessary resets",
  );

  // Legacy plain-decimal cursors also trigger reset for DM spaces while continuing cleanly for workspace spaces
  const legacyDecimal = String(dbHead());
  const fromLegacy = await getChanges(
    MEMBER,
    [followAt(GENERAL, legacyDecimal), followAt(dmInbox, legacyDecimal)],
    undefined,
    deps(allowed, 300),
  );
  assert.deepEqual(fromLegacy.reset, [dmInbox]);
  assert.deepEqual(fromLegacy.changed, []);
  assertZeroDmRowsInSqlite();
});

test("caller-scoped DM wakes isolate participants and enforce per-(callerDid, space) rate limits: Alice's wakes never wake, advance, or reset Bob's feed", async () => {
  resetDmFeedWakesForTests();
  const alice = "did:plc:alice";
  const bob = "did:plc:bob";
  const sharedConv = dmConversationUri(alice, "3kabcdefghij5");
  const allowed = new Set([sharedConv]);

  const bobInitialHead = (await getChanges(bob, [], undefined, deps(allowed))).head;
  const aliceInitialHead = (await getChanges(alice, [], undefined, deps(allowed))).head;

  // Start Bob's long-poll (250ms hold) while Alice receives 120 wakes (up to her rate limit) and hits 429 on the 121st
  const bobPolling = getChanges(bob, [followAt(sharedConv, bobInitialHead)], undefined, deps(allowed, 250));
  const fixedNow = 10_000_000;
  for (let i = 0; i < DM_WAKE_RATE_LIMIT_MAX; i += 1) {
    await recordDmWake(alice, sharedConv, fixedNow + i);
  }
  await assert.rejects(
    recordDmWake(alice, sharedConv, fixedNow + DM_WAKE_RATE_LIMIT_MAX),
    (err: unknown) => err instanceof DmRateLimitError && err.status === 429,
  );

  // Bob's held poll finishes its full hold untouched: zero changed, zero reset, and Bob's head did NOT advance!
  const bobAfterAliceFlood = await bobPolling;
  assert.deepEqual(bobAfterAliceFlood, {
    head: bobInitialHead,
    changed: [],
    denied: [],
    reset: [],
  });

  // Meanwhile Alice's own feed DOES see the wake
  const aliceAfter = await getChanges(alice, [followAt(sharedConv, aliceInitialHead)], undefined, deps(allowed, 50));
  assert.deepEqual(aliceAfter.changed.map((c) => c.space), [sharedConv]);
  assert.deepEqual(aliceAfter.reset, []);

  // Bob's own rate-limit bucket is completely independent of Alice's flood, and wakes Bob immediately
  await recordDmWake(bob, sharedConv, fixedNow);
  const bobOwnWake = await getChanges(bob, [followAt(sharedConv, bobInitialHead)], undefined, deps(allowed, 50));
  assert.deepEqual(bobOwnWake.changed.map((c) => c.space), [sharedConv]);
  assert.deepEqual(bobOwnWake.reset, []);
  assertZeroDmRowsInSqlite();
});

test("a member removed while the call waits is denied, not told the space changed", async () => {
  const from = combinedHead();
  const allowed = new Set([GENERAL]);
  setTimeout(() => {
    allowed.delete(GENERAL);
    notice(GENERAL);
  }, 80);
  const answer = await getChanges(MEMBER, [followAt(GENERAL, from)], undefined, deps(allowed, 5_000));
  assert.deepEqual([answer.changed, answer.denied], [[], [GENERAL]]);
});

test("a call with nothing new answers empty after the hold, or at once when the caller goes away", async () => {
  const quiet: Follow[] = [followAt(GENERAL, combinedHead())];
  let started = Date.now();
  assert.deepEqual(await getChanges(MEMBER, quiet, undefined, deps(new Set([GENERAL]), 250)), {
    head: combinedHead(),
    changed: [],
    denied: [],
    reset: [],
  });
  assert.ok(Date.now() - started >= 230);
  const gone = new AbortController();
  setTimeout(() => gone.abort(), 80);
  started = Date.now();
  await getChanges(MEMBER, quiet, gone.signal, deps(new Set([GENERAL]), 5_000));
  assert.ok(Date.now() - started < 1_000);
});

test("a cursor older than the notices kept for its space is reset, for that space only", async () => {
  const from = dbHead();
  notice(SECRET);
  for (let index = 0; index < 1_001; index += 1) notice(GENERAL);
  const answer = await getChanges(MEMBER, [{ space: GENERAL, after: from }, { space: SECRET, after: from }], undefined, deps(new Set([GENERAL, SECRET])));
  assert.deepEqual(answer.reset, [GENERAL]);
  assert.deepEqual(answer.changed.map((change) => change.space), [SECRET]);
});

test("parseFollow accepts <=200 spaces with legacy decimal or epoch cursors (<=16 chars) and rejects malformed cursors", () => {
  const entry = (index: number) => ({ space: `at://did:plc:owner/space/new.flock.channel/c${index}`, after: "a1b.1z.0" });
  assert.equal(parseFollow({ follow: Array.from({ length: MAX_FOLLOWED_SPACES }, (_, index) => entry(index)) }).length, MAX_FOLLOWED_SPACES);
  assert.equal(parseFollow({ follow: [{ space: GENERAL, after: "0" }] })[0]?.dmCursor, null);
  assert.deepEqual(parseFollow({ follow: [{ space: GENERAL, after: "k9z.1a.2b" }] })[0], {
    space: GENERAL,
    after: 46,
    dmCursor: { epoch: "k9z", seq: 83 },
  });
  assert.throws(() => parseFollow({ follow: Array.from({ length: MAX_FOLLOWED_SPACES + 1 }, (_, index) => entry(index)) }), FeedRequestError);
  assert.throws(() => parseFollow({ follow: [entry(1), entry(1)] }), FeedRequestError);
  for (const after of ["-1", "1.5", "01", "1e3", 7, "9007199254740993", "A1b.0.0", "a1b.01.0", "a1b.zzzzzzzzzzzzz.0"]) {
    assert.throws(() => parseFollow({ follow: [{ space: GENERAL, after }] }), FeedRequestError, String(after));
  }
  assert.throws(() => parseFollow({ follow: [], extra: true }), FeedRequestError);
});

test("global aggregate maxSpaces cap evicts oldest (callerDid, space) entries across callers, preserves empty caller shells for accurate resets, and refreshes global LRU on wake", async () => {
  resetDmFeedWakesForTests({ maxSpaces: 5 });
  try {
    const caller1 = "did:plc:caller1";
    const caller2 = "did:plc:caller2";
    const caller3 = "did:plc:caller3";
    const caller4 = "did:plc:caller4";
    const s1a = dmConversationUri(caller1, tidNow(1_700_000_001_000));
    const s1b = dmConversationUri(caller1, tidNow(1_700_000_002_000));
    const s2a = dmConversationUri(caller2, tidNow(1_700_000_003_000));
    const s2b = dmConversationUri(caller2, tidNow(1_700_000_004_000));
    const s3a = dmConversationUri(caller3, tidNow(1_700_000_005_000));
    const s3b = dmConversationUri(caller3, tidNow(1_700_000_006_000));
    const s3c = dmConversationUri(caller3, tidNow(1_700_000_007_000));
    const s3d = dmConversationUri(caller3, tidNow(1_700_000_008_000));
    const s4a = dmInboxUri(caller4);
    const allowed = new Set([s1a, s1b, s2a, s2b, s3a, s3b, s3c, s3d, s4a]);

    const head1 = (await getChanges(caller1, [], undefined, deps(allowed))).head;
    const head2 = (await getChanges(caller2, [], undefined, deps(allowed))).head;
    const head3 = (await getChanges(caller3, [], undefined, deps(allowed))).head;
    const head4 = (await getChanges(caller4, [], undefined, deps(allowed))).head;

    // 3 callers x 2 spaces = 6 total > maxSpaces(5) -> oldest (caller1, s1a) is evicted globally!
    await recordDmWake(caller1, s1a);
    await recordDmWake(caller1, s1b);
    await recordDmWake(caller2, s2a);
    await recordDmWake(caller2, s2b);
    await recordDmWake(caller3, s3a);
    await recordDmWake(caller3, s3b);

    const ans1 = await getChanges(caller1, [followAt(s1a, head1), followAt(s1b, head1)], undefined, deps(allowed, 50));
    assert.deepEqual(ans1.reset, [s1a], "oldest global entry (caller1, s1a) was evicted and reports reset");
    assert.deepEqual(ans1.changed.map((c) => c.space), [s1b], "newer entry (caller1, s1b) stayed intact");

    const ans2 = await getChanges(caller2, [followAt(s2a, head2), followAt(s2b, head2)], undefined, deps(allowed, 50));
    assert.deepEqual(ans2.reset, []);
    assert.deepEqual(ans2.changed.map((c) => c.space), [s2a, s2b]);

    const ans3 = await getChanges(caller3, [followAt(s3a, head3), followAt(s3b, head3)], undefined, deps(allowed, 50));
    assert.deepEqual(ans3.reset, []);
    assert.deepEqual(ans3.changed.map((c) => c.space), [s3a, s3b]);

    // Refreshing (caller1, s1b) moves it to newest in global LRU; adding s3c & s3d evicts BOTH of caller2's spaces!
    await recordDmWake(caller1, s1b);
    await recordDmWake(caller3, s3c);
    await recordDmWake(caller3, s3d);

    const ans1AfterRefresh = await getChanges(caller1, [followAt(s1b, head1)], undefined, deps(allowed, 50));
    assert.deepEqual(ans1AfterRefresh.reset, [], "refreshed (caller1, s1b) survived subsequent global evictions");
    assert.deepEqual(ans1AfterRefresh.changed.map((c) => c.space), [s1b]);

    const ans2EmptyShell = await getChanges(caller2, [followAt(s2a, head2), followAt(s2b, head2)], undefined, deps(allowed, 50));
    assert.deepEqual(ans2EmptyShell.reset, [s2a, s2b], "empty caller shell retains evictedFloor so caller2 receives accurate resets");

    const ans4Untouched = await getChanges(caller4, [followAt(s4a, head4)], undefined, deps(allowed, 30));
    assert.deepEqual(ans4Untouched.reset, [], "unrelated caller4 with zero evictions does not receive spurious resets");
    assertZeroDmRowsInSqlite();
  } finally {
    resetDmFeedWakesForTests();
  }
});

test("R3-L1: global maxSpaces eviction wakes a held 25s getChanges long-poll immediately (<500ms) with reset", async () => {
  resetDmFeedWakesForTests({ maxSpaces: 2 });
  try {
    const caller1 = "did:plc:evict-victim";
    const caller2 = "did:plc:evict-actor";
    const caller1Space = dmInboxUri(caller1);
    const caller1OtherSpace = dmConversationUri(caller1, tidNow(1_700_000_100_000));
    const caller2SpaceA = dmConversationUri(caller2, tidNow(1_700_000_200_000));
    const caller2SpaceB = dmConversationUri(caller2, tidNow(1_700_000_300_000));
    const allowed = new Set([caller1Space, caller1OtherSpace, caller2SpaceA, caller2SpaceB]);

    const initialHead = (await getChanges(caller1, [], undefined, deps(allowed))).head;

    // Caller 1 starts a 25,000ms long-poll watching caller1Space at seq 0.
    const pendingLongPoll = getChanges(
      caller1,
      [followAt(caller1Space, initialHead)],
      undefined,
      deps(allowed, 25_000),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));

    // A wake on an unfollowed DM space of Caller 1 advances Caller 1's head to seq 1;
    // Caller 1 re-evaluates (no change on caller1Space) and sleeps in NoticePoller at seenHead = seq 1.
    await recordDmWake(caller1, caller1OtherSpace);
    await new Promise((resolve) => setTimeout(resolve, 25));

    // Caller 2 now triggers global maxSpaces(2) eviction of Caller 1's entry, raising Caller 1's evictedFloor above seq 0!
    const evictionStarted = Date.now();
    await recordDmWake(caller2, caller2SpaceA);
    await recordDmWake(caller2, caller2SpaceB);

    const answer = await pendingLongPoll;
    const elapsedMs = Date.now() - evictionStarted;
    assert.ok(elapsedMs < 500, `expected held 25s long-poll to wake in <500ms on global eviction, took ${elapsedMs}ms`);
    assert.deepEqual(answer.reset, [caller1Space]);
    assert.deepEqual(answer.changed, []);
    assertZeroDmRowsInSqlite();
  } finally {
    resetDmFeedWakesForTests();
  }
});

test("the published lexicon allows 200 followed spaces, 16-character cursors, and names listWriters", () => {
  assert.equal(lexicon.defs.main.input.schema.properties.follow.maxLength, MAX_FOLLOWED_SPACES);
  assert.equal(lexicon.defs.main.output.schema.properties.head.maxLength, 16);
  assert.equal(lexicon.defs.follow.properties.after.maxLength, 16);
  assert.equal(lexicon.defs.change.properties.cursor.maxLength, 16);
  assert.equal(lexicon.defs.main.description.includes("listWriters"), true);
  assert.equal(lexicon.defs.main.description.includes("listRepos"), false);
});
