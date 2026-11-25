import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { closeDb, getRawDb } from "../lib/db";
import { dmConversationUri, dmInboxUri } from "@flock/protocol/keys";
import { advanceSpaceRev, pruneNotices, purgeSpaceNotifications, readNotices, recordSpaceWake, recordWriteNotification } from "./notices";

const DIRECTORY = mkdtempSync(join(tmpdir(), "slack-notifications-test-"));
const SERVICE_REF = "did:web:localhost%3A3000#atproto_flock_operator";
process.env.DATABASE_PATH = join(DIRECTORY, "notifications.db");
process.env.AUTH_ENCRYPTION_KEY = "33".repeat(32);
process.env.APP_URL = "http://127.0.0.1:3000";
process.env.OPERATOR_SERVICE_REF = SERVICE_REF;
after(() => {
  closeDb();
  rmSync(DIRECTORY, { recursive: true, force: true });
});

const CHANNEL = "at:space/did:plc:owner/new.flock.channel/alpha";
const rowCount = (where = "1=1", ...values: unknown[]) => (getRawDb().prepare(`SELECT count(*) AS count FROM space_notification WHERE ${where}`).get(...values) as { count: number }).count;
const notice = (space: string, index: number) => ({ space, repo: "did:plc:writer", repoRev: `rev-${index}` });

function reset(): void {
  for (const table of ["space_notification", "space_notification_type_floor", "space_notification_space_floor", "notification_registration"]) {
    getRawDb().prepare(`DELETE FROM ${table}`).run();
  }
}

test("DM spaces are forbidden from ever writing rows into SQLite space_notification", () => {
  reset();
  assert.throws(() => recordWriteNotification(notice(dmInboxUri("did:plc:alice"), 1)), /DM notifications must never be persisted/);
  assert.throws(() => recordWriteNotification(notice(dmConversationUri("did:plc:alice", "3kabcdefghij2"), 1)), /DM notifications must never be persisted/);
  assert.throws(() => recordSpaceWake(dmInboxUri("did:plc:alice")), /DM notifications must never be persisted/);
  assert.equal(rowCount(), 0);
});

test("advanceSpaceRev advances last_space_rev monotonically on notification_registration", () => {
  reset();
  getRawDb()
    .prepare("INSERT INTO notification_registration (service_ref, space_uri, expires_at, token, renew_at) VALUES (?, ?, ?, ?, 0)")
    .run(SERVICE_REF, CHANNEL, Date.now() + 600_000, "tok-1");
  const readRev = () =>
    (getRawDb().prepare("SELECT last_space_rev FROM notification_registration WHERE space_uri = ?").get(CHANNEL) as { last_space_rev: string | null }).last_space_rev;

  assert.equal(readRev(), null);
  advanceSpaceRev(CHANNEL, "3kabcdefghij3");
  assert.equal(readRev(), "3kabcdefghij3");
  advanceSpaceRev(CHANNEL, "3kabcdefghij2");
  assert.equal(readRev(), "3kabcdefghij3", "older revision never regresses last_space_rev");
  advanceSpaceRev(CHANNEL, "3kabcdefghij4");
  assert.equal(readRev(), "3kabcdefghij4");
});

test("a space keeps only its newest 1,000 notices", () => {
  // #given 1,010 notices for one space and one for another
  reset();
  recordWriteNotification(notice("at:space/did:plc:owner/new.flock.channel/beta", 0));
  for (let index = 0; index < 1_010; index += 1) recordWriteNotification(notice(CHANNEL, index));

  // #then the busy space is capped at its newest, and the other space is untouched
  assert.equal(rowCount("space_uri=?", CHANNEL), 1_000);
  assert.equal(rowCount("space_uri=?", "at:space/did:plc:owner/new.flock.channel/beta"), 1);
  const oldest = getRawDb().prepare("SELECT rev FROM space_notification WHERE space_uri=? ORDER BY id LIMIT 1").get(CHANNEL) as { rev: string };
  assert.equal(oldest.rev, "rev-10", "the oldest ten were dropped");
});

test("one authority keeps at most its newest 5,000 notices across all its spaces", () => {
  reset();
  for (let index = 0; index < 5_010; index += 1) recordWriteNotification(notice(`at:space/did:plc:spammer/new.flock.channel/c${index % 7}`, index));
  recordWriteNotification(notice(CHANNEL, 0));
  assert.equal(rowCount("space_uri LIKE ?", "at:space/did:plc:spammer/%"), 5_000);
  assert.equal(rowCount("space_uri=?", CHANNEL), 1, "another authority is untouched");
});

test("notices older than a week are dropped when a new one arrives", () => {
  reset();
  const now = Math.floor(Date.now() / 1000);
  recordWriteNotification(notice(CHANNEL, 1), now - 8 * 86_400);
  recordWriteNotification(notice(CHANNEL, 2), now);
  assert.equal(rowCount("space_uri=?", CHANNEL), 1);
});

test("the periodic prune drops week-old notices and >30-day expired registrations, while keeping staged/migrated expires_at=0 rows", () => {
  reset();
  const now = Date.now();
  const seconds = Math.floor(now / 1000);
  const beta = "at:space/did:plc:owner/new.flock.channel/beta";
  const staged = "at:space/did:plc:owner/new.flock.channel/staged";
  recordWriteNotification(notice(beta, 2), seconds);
  getRawDb().prepare("INSERT INTO space_notification (space_uri,space_type,type_seq,repo_did,rev,notified_at) VALUES (?,?,?,?,?,?)")
    .run(CHANNEL, "new.flock.channel", 999_999, "did:plc:writer", "rev-old", seconds - 8 * 86_400);
  const register = getRawDb().prepare("INSERT INTO notification_registration (service_ref,space_uri,expires_at,token,renew_at) VALUES (?,?,?,?,0)");
  register.run(SERVICE_REF, CHANNEL, now - 31 * 86_400_000, "tok-old");
  register.run(SERVICE_REF, beta, now - 86_400_000, "tok-yesterday");
  register.run(SERVICE_REF, staged, 0, "tok-staged");

  pruneNotices(now);

  assert.equal(rowCount("space_uri=?", CHANNEL), 0);
  assert.equal(rowCount(), 1);
  assert.deepEqual(
    (getRawDb().prepare("SELECT space_uri FROM notification_registration ORDER BY space_uri").all() as Array<{ space_uri: string }>).map((row) => row.space_uri),
    [beta, staged],
    "staged/migrated expires_at=0 rows and recently lapsed registrations stay",
  );
});

test("a space type keeps only its newest 50,000 notices, however many authorities file them, and another type keeps its own", () => {
  // #given 50,010 notices from 50,010 different app-inbox authorities, and one channel notice among the oldest
  reset();
  recordWriteNotification(notice(CHANNEL, 0));
  const insert = getRawDb().prepare("INSERT INTO space_notification (space_uri,space_type,type_seq,repo_did,rev,notified_at) VALUES (?,'new.flock.app.inbox',?,?,?,?)");
  const now = Math.floor(Date.now() / 1000);
  getRawDb().transaction(() => {
    for (let index = 0; index < 50_009; index += 1) {
      insert.run(`at:space/did:plc:a${index}/new.flock.app.inbox/i-bot`, index + 1, "did:plc:writer", `rev-${index}`, now);
    }
  })();
  recordWriteNotification(notice("at:space/did:plc:a50009/new.flock.app.inbox/i-bot", 50_009));

  // #then the app.inbox type is at its cap, and the channel notice, older than all of them, is still there
  assert.equal(rowCount("space_type=?", "new.flock.app.inbox"), 50_000);
  assert.equal(rowCount("space_uri=?", CHANNEL), 1);
});

test("an authority's cap counts exactly its own notices, not those of an authority whose DID starts the same", () => {
  reset();
  const insert = getRawDb().prepare("INSERT INTO space_notification (space_uri,space_type,type_seq,repo_did,rev,notified_at) VALUES (?,'new.flock.channel',?,?,?,?)");
  const now = Math.floor(Date.now() / 1000);
  let seq = 0;
  getRawDb().transaction(() => {
    for (let index = 0; index < 5_400; index += 1) insert.run(`at:space/did:plc:ab/new.flock.channel/c${index % 6}`, ++seq, "did:plc:writer", `rev-${index}`, now);
    for (let index = 0; index < 10; index += 1) insert.run("at:space/did:plc:abc/new.flock.channel/x", ++seq, "did:plc:writer", `rev-${index}`, now);
    for (let index = 0; index < 10; index += 1) insert.run("at:space/did:plc:ab0/new.flock.channel/x", ++seq, "did:plc:writer", `rev-${index}`, now);
  })();

  recordWriteNotification(notice("at:space/did:plc:ab/new.flock.channel/c0", 5_400));

  assert.equal(rowCount("space_uri LIKE ?", "at:space/did:plc:ab/%"), 5_000);
  assert.equal(rowCount("space_uri LIKE ?", "at:space/did:plc:abc/%"), 10);
  assert.equal(rowCount("space_uri LIKE ?", "at:space/did:plc:ab0/%"), 10, "the DID whose first differing character is the range's end character is untouched too");
});

// Cursors: what `readNotices` answers for followed spaces, which the change feed passes on.

const OTHER_CHANNEL = "at:space/did:plc:owner/new.flock.channel/gamma";
const newestId = (space: string) => (getRawDb().prepare("SELECT MAX(id) AS id FROM space_notification WHERE space_uri=?").get(space) as { id: number }).id;

test("a space with a notice newer than its cursor is changed, with its newest notice as the cursor; head moves with every notice", () => {
  reset();
  const start = readNotices([]).head;
  recordWriteNotification(notice(CHANNEL, 1));
  recordWriteNotification(notice(OTHER_CHANNEL, 2));
  recordWriteNotification(notice(CHANNEL, 3));
  const answer = readNotices([{ space: CHANNEL, after: start }, { space: OTHER_CHANNEL, after: newestId(OTHER_CHANNEL) }]);
  assert.equal(answer.head, start + 3);
  assert.deepEqual(answer.changed, [{ space: CHANNEL, cursor: newestId(CHANNEL) }]);
  assert.deepEqual(answer.reset, []);
});

test("a space added after the last notice is not missed when followed from head", () => {
  reset();
  recordWriteNotification(notice(CHANNEL, 1));
  const { head } = readNotices([]);
  recordWriteNotification(notice(OTHER_CHANNEL, 2));
  assert.deepEqual(readNotices([{ space: OTHER_CHANNEL, after: head }]).changed.map((change) => change.space), [OTHER_CHANNEL]);
});

test("a cursor below what was pruned for its space is reset; one above it, or another space's, is not", () => {
  reset();
  recordWriteNotification(notice(OTHER_CHANNEL, 0));
  const before = readNotices([]).head;
  for (let index = 0; index < 1_005; index += 1) recordWriteNotification(notice(CHANNEL, index));
  const answer = readNotices([{ space: CHANNEL, after: before }, { space: OTHER_CHANNEL, after: before }]);
  assert.deepEqual(answer.reset, [CHANNEL], "the busy space's pruned notices may hold a change after the cursor");
  assert.deepEqual(readNotices([{ space: CHANNEL, after: newestId(CHANNEL) - 10 }]).reset, [], "a cursor inside what is kept is not");
});

test("a cursor below what was pruned for its type, by age or by cap, is reset", () => {
  reset();
  const now = Math.floor(Date.now() / 1000);
  recordWriteNotification(notice(CHANNEL, 0), now - 8 * 86_400);
  const before = newestId(CHANNEL) - 1;
  recordWriteNotification(notice(OTHER_CHANNEL, 1), now);
  assert.deepEqual(readNotices([{ space: CHANNEL, after: before }]).reset, [CHANNEL], "its week-old notice aged out");
  assert.deepEqual(readNotices([{ space: CHANNEL, after: newestId(OTHER_CHANNEL) }]).reset, []);
});

test("a cursor above head, from another database, is reset, and a deleted space's floor goes with it", () => {
  reset();
  recordWriteNotification(notice(CHANNEL, 0));
  const { head } = readNotices([]);
  assert.deepEqual(readNotices([{ space: CHANNEL, after: head + 100 }]).reset, [CHANNEL]);
  for (let index = 0; index < 1_001; index += 1) recordWriteNotification(notice(OTHER_CHANNEL, index));
  purgeSpaceNotifications(OTHER_CHANNEL);
  assert.equal((getRawDb().prepare("SELECT count(*) AS count FROM space_notification_space_floor WHERE space_uri=?").get(OTHER_CHANNEL) as { count: number }).count, 0);
});
