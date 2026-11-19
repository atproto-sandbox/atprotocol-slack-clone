import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { dmConversationUri, dmInboxUri } from "@flock/protocol/keys";
import { closeDb, getRawDb } from "../lib/db";
import { currentDmWakeHead, recordDmSpaceWake, resetDmFeedWakesForTests } from "./dm-feed-wakes";
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
const combinedHead = () => {
  const dm = currentDmWakeHead();
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

  // Held poll wakes as soon as a DM wake arrives in memory
  setTimeout(() => recordDmSpaceWake(dmConv), 60);
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

test("the published lexicon allows 200 followed spaces and 16-character cursors", () => {
  assert.equal(lexicon.defs.main.input.schema.properties.follow.maxLength, MAX_FOLLOWED_SPACES);
  assert.equal(lexicon.defs.main.output.schema.properties.head.maxLength, 16);
  assert.equal(lexicon.defs.follow.properties.after.maxLength, 16);
  assert.equal(lexicon.defs.change.properties.cursor.maxLength, 16);
});
