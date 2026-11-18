import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import BetterSqlite3 from "better-sqlite3";
import { closeDb, getRawDb } from "./db";

// A database written by a release before the change feed's per-type caps opens, with its notice table replaced.

const DIRECTORY = mkdtempSync(join(tmpdir(), "slack-db-migration-test-"));
const PATH = join(DIRECTORY, "old.db");
process.env.DATABASE_PATH = PATH;
process.env.AUTH_ENCRYPTION_KEY = "77".repeat(32);
process.env.APP_URL = "http://127.0.0.1:3000";
process.env.OPERATOR_SERVICE_REF = "did:web:operator.test#atproto_flock_operator";
after(() => {
  closeDb();
  rmSync(DIRECTORY, { recursive: true, force: true });
});

test("a notice table and registration table from before the per-type caps are replaced and extended when the database opens", () => {
  const old = new BetterSqlite3(PATH);
  old.exec(`
    CREATE TABLE space_notification (id INTEGER PRIMARY KEY AUTOINCREMENT, space_uri TEXT NOT NULL, repo_did TEXT NOT NULL, rev TEXT NOT NULL, notified_at INTEGER NOT NULL);
    CREATE INDEX space_notification_lookup ON space_notification(space_uri, id);
    CREATE TABLE notification_registration (service_ref TEXT NOT NULL, space_uri TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (service_ref, space_uri));
  `);
  for (let index = 0; index < 5; index += 1) old.prepare("INSERT INTO space_notification (space_uri,repo_did,rev,notified_at) VALUES (?,?,?,?)").run("at://did:plc:a/space/new.flock.channel/x", "did:plc:w", "r", 1);
  old.prepare("INSERT INTO notification_registration VALUES (?,?,?)").run("did:web:operator.test#atproto_flock_operator", "at://did:plc:a/space/new.flock.channel/x", 1);
  old.close();

  const db = getRawDb();
  const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
  assert.ok(columns("space_notification").includes("space_type") && columns("space_notification").includes("type_seq"));
  assert.equal((db.prepare("SELECT count(*) AS count FROM space_notification").get() as { count: number }).count, 0, "the old notices went with their table");
  assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='space_notification'").get(), undefined, "so head starts again, and an older cursor is reset");
  assert.ok(columns("notification_registration").includes("workspace_uri"));
  assert.equal((db.prepare("SELECT count(*) AS count FROM notification_registration").get() as { count: number }).count, 1, "registrations are kept");
});
