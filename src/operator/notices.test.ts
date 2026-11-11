import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { closeDb, getRawDb } from "@/lib/db";
import { dmConversationUri, dmInboxUri } from "@/protocol/keys";
import { isNotificationAccepted, pruneNotices, purgeSpaceNotifications, readNotices, recordWriteNotification } from "./notices";

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

const CHANNEL = "at://did:plc:owner/space/new.flock.channel/alpha";
const rowCount = (where = "1=1", ...values: unknown[]) => (getRawDb().prepare(`SELECT count(*) AS count FROM space_notification WHERE ${where}`).get(...values) as { count: number }).count;
const notice = (space: string, index: number) => ({ space, repo: "did:plc:writer", repoRev: `rev-${index}` });

function reset(): void {
  for (const table of ["space_notification", "space_notification_type_floor", "space_notification_space_floor", "notification_registration"]) {
    getRawDb().prepare(`DELETE FROM ${table}`).run();
  }
}

test("a notice is accepted for a space the app registered and refused for one it did not", () => {
  // #given the app registered one channel
  reset();
  getRawDb().prepare("INSERT INTO notification_registration (service_ref,space_uri,expires_at) VALUES (?,?,?)").run(SERVICE_REF, CHANNEL, Date.now() + 3_600_000);

  // #then only that channel is accepted
  assert.equal(isNotificationAccepted(CHANNEL), true);
  assert.equal(isNotificationAccepted("at://did:plc:owner/space/new.flock.channel/other"), false);
  assert.equal(isNotificationAccepted("at://did:plc:stranger/space/new.flock.workspace/team"), false);
});

test("a registration that ran out is honored for five minutes and then refused", () => {
  reset();
  const now = Date.now();
  getRawDb().prepare("INSERT INTO notification_registration (service_ref,space_uri,expires_at) VALUES (?,?,?)").run(SERVICE_REF, CHANNEL, now - 60_000);
  assert.equal(isNotificationAccepted(CHANNEL, now), true, "just expired: a late notice still counts");
  assert.equal(isNotificationAccepted(CHANNEL, now + 10 * 60_000), false, "long expired");
});

test("a DM space is accepted without a server-side registration, because the member's browser registers it", () => {
  reset();
  assert.equal(isNotificationAccepted(dmInboxUri("did:plc:alice")), true);
  assert.equal(isNotificationAccepted(dmConversationUri("did:plc:alice", "3kabcdefghij2")), true);
});

test("a space keeps only its newest 1,000 notices", () => {
  // #given 1,010 notices for one space and one for another
  reset();
  recordWriteNotification(notice("at://did:plc:owner/space/new.flock.channel/beta", 0));
  for (let index = 0; index < 1_010; index += 1) recordWriteNotification(notice(CHANNEL, index));

  // #then the busy space is capped at its newest, and the other space is untouched
  assert.equal(rowCount("space_uri=?", CHANNEL), 1_000);
  assert.equal(rowCount("space_uri=?", "at://did:plc:owner/space/new.flock.channel/beta"), 1);
  const oldest = getRawDb().prepare("SELECT rev FROM space_notification WHERE space_uri=? ORDER BY id LIMIT 1").get(CHANNEL) as { rev: string };
  assert.equal(oldest.rev, "rev-10", "the oldest ten were dropped");
});

test("one authority keeps at most its newest 5,000 notices across all its spaces", () => {
  reset();
  for (let index = 0; index < 5_010; index += 1) recordWriteNotification(notice(`at://did:plc:spammer/space/new.flock.channel/c${index % 7}`, index));
  recordWriteNotification(notice(CHANNEL, 0));
  assert.equal(rowCount("space_uri LIKE ?", "at://did:plc:spammer/%"), 5_000);
  assert.equal(rowCount("space_uri=?", CHANNEL), 1, "another authority is untouched");
});

test("notices older than a week are dropped when a new one arrives", () => {
  reset();
  const now = Math.floor(Date.now() / 1000);
  recordWriteNotification(notice(CHANNEL, 1), now - 8 * 86_400);
  recordWriteNotification(notice(CHANNEL, 2), now);
  assert.equal(rowCount("space_uri=?", CHANNEL), 1);
});

test("the periodic prune drops week-old notices on a quiet instance, and registrations that ran out a month ago", () => {
  // #given a notice a week and a day old, a fresh one, a registration that ran out 31 days ago and one that ran out yesterday
  reset();
  const now = Date.now();
  const seconds = Math.floor(now / 1000);
  // (the old notice is written straight to the table: a notice arriving would itself prune it, which is not what is tested)
  recordWriteNotification(notice("at://did:plc:owner/space/new.flock.channel/beta", 2), seconds);
  getRawDb().prepare("INSERT INTO space_notification (space_uri,space_type,type_seq,repo_did,rev,notified_at) VALUES (?,?,?,?,?,?)")
    .run(CHANNEL, "new.flock.channel", 999_999, "did:plc:writer", "rev-old", seconds - 8 * 86_400);
  const register = getRawDb().prepare("INSERT INTO notification_registration (service_ref,space_uri,expires_at) VALUES (?,?,?)");
  register.run(SERVICE_REF, CHANNEL, now - 31 * 86_400_000);
  register.run(SERVICE_REF, "at://did:plc:owner/space/new.flock.channel/beta", now - 86_400_000);

  // #when the reconcile job prunes, with no new notice arriving
  pruneNotices(now);

  // #then only the fresh notice and the recently lapsed registration remain
  assert.equal(rowCount("space_uri=?", CHANNEL), 0);
  assert.equal(rowCount(), 1);
  assert.deepEqual((getRawDb().prepare("SELECT space_uri FROM notification_registration").all() as Array<{ space_uri: string }>).map((row) => row.space_uri),
    ["at://did:plc:owner/space/new.flock.channel/beta"]);
});

test("a space type keeps only its newest 50,000 notices, however many authorities file them, and another type keeps its own", () => {
  // #given 50,010 notices from 50,010 different DM-space authorities, and one channel notice among the oldest
  reset();
  recordWriteNotification(notice(CHANNEL, 0));
  const insert = getRawDb().prepare("INSERT INTO space_notification (space_uri,space_type,type_seq,repo_did,rev,notified_at) VALUES (?,'new.flock.dm.inbox',?,?,?,?)");
  const now = Math.floor(Date.now() / 1000);
  getRawDb().transaction(() => {
    for (let index = 0; index < 50_009; index += 1) insert.run(`at://did:plc:a${index}/space/new.flock.dm.inbox/self`, index + 1, "did:plc:writer", `rev-${index}`, now);
  })();
  recordWriteNotification(notice("at://did:plc:a50009/space/new.flock.dm.inbox/self", 50_009));

  // #then the DM inbox type is at its cap, and the channel notice, older than all of them, is still there
  assert.equal(rowCount("space_type=?", "new.flock.dm.inbox"), 50_000);
  assert.equal(rowCount("space_uri=?", CHANNEL), 1);
});

test("an authority's cap counts exactly its own notices, not those of an authority whose DID starts the same", () => {
  // #given 5,400 notices for did:plc:ab spread over six spaces (each under the per-space cap), and ten for did:plc:abc
  reset();
  const insert = getRawDb().prepare("INSERT INTO space_notification (space_uri,space_type,type_seq,repo_did,rev,notified_at) VALUES (?,'new.flock.channel',?,?,?,?)");
  const now = Math.floor(Date.now() / 1000);
  let seq = 0;
  getRawDb().transaction(() => {
    for (let index = 0; index < 5_400; index += 1) insert.run(`at://did:plc:ab/space/new.flock.channel/c${index % 6}`, ++seq, "did:plc:writer", `rev-${index}`, now);
    for (let index = 0; index < 10; index += 1) insert.run("at://did:plc:abc/space/new.flock.channel/x", ++seq, "did:plc:writer", `rev-${index}`, now);
    for (let index = 0; index < 10; index += 1) insert.run("at://did:plc:ab0/space/new.flock.channel/x", ++seq, "did:plc:writer", `rev-${index}`, now);
  })();

  // #when one more notice arrives for did:plc:ab
  recordWriteNotification(notice("at://did:plc:ab/space/new.flock.channel/c0", 5_400));

  // #then did:plc:ab is trimmed to exactly its authority cap and did:plc:abc is untouched
  assert.equal(rowCount("space_uri LIKE ?", "at://did:plc:ab/%"), 5_000);
  assert.equal(rowCount("space_uri LIKE ?", "at://did:plc:abc/%"), 10);
  assert.equal(rowCount("space_uri LIKE ?", "at://did:plc:ab0/%"), 10, "the DID whose first differing character is the range's end character is untouched too");
});

// Cursors: what `readNotices` answers for followed spaces, which the change feed passes on.

const OTHER_CHANNEL = "at://did:plc:owner/space/new.flock.channel/gamma";
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
  // #given a cursor taken before a space ran past its own cap
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
