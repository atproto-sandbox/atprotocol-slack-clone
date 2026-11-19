import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import BetterSqlite3 from "better-sqlite3";
import { closeDb, getRawDb } from "./db";

// Legacy databases from before per-type caps and before R12 inline webhook tokens open cleanly:
// `space_notification` keeps its exact content-free schema (no `space_rev`), `notification_registration` gains
// `(token, renew_at, last_space_rev)`, legacy `token = ''` rows reset `expires_at = 0, renew_at = 0` for immediate
// startup renewal, R12 rows preserve their state across restarts, and zero DM tables exist.

const DIRECTORY = mkdtempSync(join(tmpdir(), "slack-db-migration-test-"));
const PATH = join(DIRECTORY, "old.db");
const SERVICE_REF = "did:web:operator.test#atproto_flock_operator";
process.env.DATABASE_PATH = PATH;
process.env.AUTH_ENCRYPTION_KEY = "77".repeat(32);
process.env.APP_URL = "http://127.0.0.1:3000";
process.env.OPERATOR_SERVICE_REF = SERVICE_REF;
after(() => {
  closeDb();
  rmSync(DIRECTORY, { recursive: true, force: true });
});

test("legacy notice and registration tables migrate cleanly, resetting tokenless registerNotify rows for immediate renewal while preserving R12 rows", () => {
  const futureLegacyExpiry = Date.now() + 24 * 60 * 60 * 1000;
  const channelA = "at://did:plc:a/space/new.flock.channel/x";
  const channelB = "at://did:plc:a/space/new.flock.channel/y";

  const old = new BetterSqlite3(PATH);
  old.exec(`
    CREATE TABLE space_notification (id INTEGER PRIMARY KEY AUTOINCREMENT, space_uri TEXT NOT NULL, repo_did TEXT NOT NULL, rev TEXT NOT NULL, notified_at INTEGER NOT NULL);
    CREATE INDEX space_notification_lookup ON space_notification(space_uri, id);
    CREATE TABLE notification_registration (service_ref TEXT NOT NULL, space_uri TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (service_ref, space_uri));
  `);
  for (let index = 0; index < 5; index += 1) {
    old.prepare("INSERT INTO space_notification (space_uri,repo_did,rev,notified_at) VALUES (?,?,?,?)")
      .run(channelA, "did:plc:w", "r", 1);
  }
  // A pre-R12 registerNotify row whose 24-hour expires_at is still in the future, with no inline webhook token.
  old.prepare("INSERT INTO notification_registration VALUES (?,?,?)").run(SERVICE_REF, channelA, futureLegacyExpiry);
  old.close();

  const db = getRawDb();
  const columns = (table: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);

  assert.deepEqual(
    columns("space_notification"),
    ["id", "space_uri", "space_type", "type_seq", "repo_did", "rev", "notified_at"],
    "space_notification keeps its exact schema with no space_rev column",
  );
  assert.equal((db.prepare("SELECT count(*) AS count FROM space_notification").get() as { count: number }).count, 0, "the old notices went with their table");
  assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='space_notification'").get(), undefined, "so head starts again, and an older cursor is reset");

  assert.deepEqual(
    columns("notification_registration"),
    ["service_ref", "space_uri", "expires_at", "workspace_uri", "token", "renew_at", "last_space_rev"],
  );
  const migratedRow = db
    .prepare("SELECT expires_at, token, renew_at, last_space_rev FROM notification_registration WHERE space_uri = ?")
    .get(channelA) as { expires_at: number; token: string; renew_at: number; last_space_rev: string | null };
  assert.deepEqual(migratedRow, {
    expires_at: 0,
    token: "",
    renew_at: 0,
    last_space_rev: null,
  }, "legacy registerNotify row is reset to expires_at=0, renew_at=0 so startup renews it immediately");

  // Seed an active R12 row with a non-empty token, close and re-open DB: R12 columns must stay intact.
  const r12ExpiresAt = Date.now() + 600_000;
  const r12RenewAt = r12ExpiresAt - 180_000;
  db.prepare(`INSERT INTO notification_registration (service_ref, space_uri, expires_at, workspace_uri, token, renew_at, last_space_rev)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(SERVICE_REF, channelB, r12ExpiresAt, "at://did:plc:a/space/new.flock.workspace/w", "stable-token-b", r12RenewAt, "3kabcdefghij2");

  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);
  assert.equal(tables.some((name) => name.includes("dm")), false, "operator SQLite schema holds zero DM tables");

  closeDb();
  const reopened = getRawDb();
  const preserved = reopened
    .prepare("SELECT expires_at, token, renew_at, last_space_rev FROM notification_registration WHERE space_uri = ?")
    .get(channelB) as { expires_at: number; token: string; renew_at: number; last_space_rev: string | null };
  assert.deepEqual(preserved, {
    expires_at: r12ExpiresAt,
    token: "stable-token-b",
    renew_at: r12RenewAt,
    last_space_rev: "3kabcdefghij2",
  });
});
