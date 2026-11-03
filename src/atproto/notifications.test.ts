import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { closeDb, getRawDb } from "@/lib/db";
import { dmConversationUri, dmInboxUri } from "@/protocol/keys";
import { isNotificationAccepted, recordWriteNotification } from "./notifications";

const DIRECTORY = mkdtempSync(join(tmpdir(), "slack-notifications-test-"));
const SERVICE_REF = "did:web:localhost%3A3000#atproto_slack_admin";
process.env.DATABASE_PATH = join(DIRECTORY, "notifications.db");
process.env.AUTH_ENCRYPTION_KEY = "33".repeat(32);
process.env.APP_URL = "http://127.0.0.1:3000";
process.env.OPERATOR_SERVICE_REF = SERVICE_REF;
after(() => {
  closeDb();
  rmSync(DIRECTORY, { recursive: true, force: true });
});

const CHANNEL = "at://did:plc:owner/space/org.slack.channel/alpha";
const rowCount = (where = "1=1", ...values: unknown[]) => (getRawDb().prepare(`SELECT count(*) AS count FROM space_notification WHERE ${where}`).get(...values) as { count: number }).count;
const notice = (space: string, index: number) => ({ space, repo: "did:plc:writer", repoRev: `rev-${index}` });

function reset(): void {
  getRawDb().prepare("DELETE FROM space_notification").run();
  getRawDb().prepare("DELETE FROM notification_registration").run();
}

test("a notice is accepted for a space the app registered and refused for one it did not", () => {
  // #given the app registered one channel
  reset();
  getRawDb().prepare("INSERT INTO notification_registration (service_ref,space_uri,expires_at) VALUES (?,?,?)").run(SERVICE_REF, CHANNEL, Date.now() + 3_600_000);

  // #then only that channel is accepted
  assert.equal(isNotificationAccepted(CHANNEL), true);
  assert.equal(isNotificationAccepted("at://did:plc:owner/space/org.slack.channel/other"), false);
  assert.equal(isNotificationAccepted("at://did:plc:stranger/space/org.slack.workspace/team"), false);
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
  recordWriteNotification(notice("at://did:plc:owner/space/org.slack.channel/beta", 0));
  for (let index = 0; index < 1_010; index += 1) recordWriteNotification(notice(CHANNEL, index));

  // #then the busy space is capped at its newest, and the other space is untouched
  assert.equal(rowCount("space_uri=?", CHANNEL), 1_000);
  assert.equal(rowCount("space_uri=?", "at://did:plc:owner/space/org.slack.channel/beta"), 1);
  const oldest = getRawDb().prepare("SELECT rev FROM space_notification WHERE space_uri=? ORDER BY id LIMIT 1").get(CHANNEL) as { rev: string };
  assert.equal(oldest.rev, "rev-10", "the oldest ten were dropped");
});

test("one authority keeps at most its newest 5,000 notices across all its spaces", () => {
  reset();
  for (let index = 0; index < 5_010; index += 1) recordWriteNotification(notice(`at://did:plc:spammer/space/org.slack.channel/c${index % 7}`, index));
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

test("the table keeps only its newest 50,000 notices overall, however many authorities file them", () => {
  // #given 50,010 notices from 50,010 different DM-space authorities
  reset();
  const insert = getRawDb().prepare("INSERT INTO space_notification (space_uri,repo_did,rev,notified_at) VALUES (?,?,?,?)");
  const now = Math.floor(Date.now() / 1000);
  getRawDb().transaction(() => {
    for (let index = 0; index < 50_010; index += 1) insert.run(`at://did:plc:a${index}/space/org.slack.dm.inbox/self`, "did:plc:writer", `rev-${index}`, now);
  })();

  // #when one more notice arrives
  recordWriteNotification(notice(CHANNEL, 0));

  // #then the oldest are dropped and the table is at the cap
  assert.equal(rowCount(), 50_000);
  assert.equal(rowCount("space_uri=?", CHANNEL), 1);
});

test("an authority's cap counts exactly its own notices, not those of an authority whose DID starts the same", () => {
  // #given 5,400 notices for did:plc:ab spread over six spaces (each under the per-space cap), and ten for did:plc:abc
  reset();
  const insert = getRawDb().prepare("INSERT INTO space_notification (space_uri,repo_did,rev,notified_at) VALUES (?,?,?,?)");
  const now = Math.floor(Date.now() / 1000);
  getRawDb().transaction(() => {
    for (let index = 0; index < 5_400; index += 1) insert.run(`at://did:plc:ab/space/org.slack.channel/c${index % 6}`, "did:plc:writer", `rev-${index}`, now);
    for (let index = 0; index < 10; index += 1) insert.run("at://did:plc:abc/space/org.slack.channel/x", "did:plc:writer", `rev-${index}`, now);
    for (let index = 0; index < 10; index += 1) insert.run("at://did:plc:ab0/space/org.slack.channel/x", "did:plc:writer", `rev-${index}`, now);
  })();

  // #when one more notice arrives for did:plc:ab
  recordWriteNotification(notice("at://did:plc:ab/space/org.slack.channel/c0", 5_400));

  // #then did:plc:ab is trimmed to exactly its authority cap and did:plc:abc is untouched
  assert.equal(rowCount("space_uri LIKE ?", "at://did:plc:ab/%"), 5_000);
  assert.equal(rowCount("space_uri LIKE ?", "at://did:plc:abc/%"), 10);
  assert.equal(rowCount("space_uri LIKE ?", "at://did:plc:ab0/%"), 10, "the DID whose first differing character is the range's end character is untouched too");
});
