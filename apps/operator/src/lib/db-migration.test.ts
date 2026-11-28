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
  const channelA = "at:space/did:plc:a/new.flock.channel/x";
  const channelB = "at:space/did:plc:a/new.flock.channel/y";

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
    ["service_ref", "space_uri", "expires_at", "workspace_uri", "token", "renew_at", "last_space_rev", "generation"],
  );
  const migratedRow = db
    .prepare("SELECT expires_at, token, renew_at, last_space_rev, generation FROM notification_registration WHERE space_uri = ?")
    .get(channelA) as { expires_at: number; token: string; renew_at: number; last_space_rev: string | null; generation: number };
  assert.deepEqual(migratedRow, {
    expires_at: 0,
    token: "",
    renew_at: 0,
    last_space_rev: null,
    generation: 1,
  }, "legacy registerNotify row is reset to expires_at=0, renew_at=0, generation=1 so startup renews it immediately");

  // Seed an active R12 row with a non-empty token, close and re-open DB: R12 columns must stay intact.
  const r12ExpiresAt = Date.now() + 600_000;
  const r12RenewAt = r12ExpiresAt - 180_000;
  db.prepare(`INSERT INTO notification_registration (service_ref, space_uri, expires_at, workspace_uri, token, renew_at, last_space_rev, generation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(SERVICE_REF, channelB, r12ExpiresAt, "at:space/did:plc:a/new.flock.workspace/w", "stable-token-b", r12RenewAt, "3kabcdefghij2", 3);

  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);
  assert.equal(tables.some((name) => name.includes("dm")), false, "operator SQLite schema holds zero DM tables");

  closeDb();
  const reopened = getRawDb();
  const preserved = reopened
    .prepare("SELECT expires_at, token, renew_at, last_space_rev, generation FROM notification_registration WHERE space_uri = ?")
    .get(channelB) as { expires_at: number; token: string; renew_at: number; last_space_rev: string | null; generation: number };
  assert.deepEqual(preserved, {
    expires_at: r12ExpiresAt,
    token: "stable-token-b",
    renew_at: r12RenewAt,
    last_space_rev: "3kabcdefghij2",
    generation: 3,
  });
});

test("startup migration purges historical pre-R12 new.flock.dm.* rows from space_notification and floor tables while keeping workspace/channel rows", () => {
  closeDb();

  const preR12 = new BetterSqlite3(PATH);
  preR12.prepare("DELETE FROM space_notification").run();
  preR12.prepare("DELETE FROM space_notification_type_floor").run();
  preR12.prepare("DELETE FROM space_notification_space_floor").run();
  preR12.prepare("INSERT INTO space_notification (space_uri, space_type, type_seq, repo_did, rev, notified_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("at:space/did:plc:a/new.flock.channel/general", "new.flock.channel", 1, "did:plc:w", "3kabcdefghij2", 100);
  preR12.prepare("INSERT INTO space_notification (space_uri, space_type, type_seq, repo_did, rev, notified_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("at:space/did:plc:a/new.flock.dm.inbox/self", "new.flock.dm.inbox", 1, "did:plc:w", "3kabcdefghij3", 101);
  preR12.prepare("INSERT INTO space_notification (space_uri, space_type, type_seq, repo_did, rev, notified_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("at:space/did:plc:a/new.flock.dm.conversation/3kabcdefghij4", "new.flock.dm.conversation", 1, "did:plc:w", "3kabcdefghij5", 102);

  preR12.prepare("INSERT INTO space_notification_type_floor VALUES (?, ?)").run("new.flock.channel", 10);
  preR12.prepare("INSERT INTO space_notification_type_floor VALUES (?, ?)").run("new.flock.dm.inbox", 20);
  preR12.prepare("INSERT INTO space_notification_type_floor VALUES (?, ?)").run("new.flock.dm.conversation", 30);

  preR12.prepare("INSERT INTO space_notification_space_floor VALUES (?, ?, ?)")
    .run("at:space/did:plc:a/new.flock.channel/general", "new.flock.channel", 15);
  preR12.prepare("INSERT INTO space_notification_space_floor VALUES (?, ?, ?)")
    .run("at:space/did:plc:a/new.flock.dm.inbox/self", "new.flock.dm.inbox", 25);
  preR12.prepare("INSERT INTO space_notification_space_floor VALUES (?, ?, ?)")
    .run("at:space/did:plc:a/new.flock.dm.conversation/3kabcdefghij4", "new.flock.dm.conversation", 35);
  preR12.close();

  const db = getRawDb();
  assert.deepEqual(
    db.prepare("SELECT space_type FROM space_notification").all(),
    [{ space_type: "new.flock.channel" }],
  );
  assert.deepEqual(
    db.prepare("SELECT space_type FROM space_notification_type_floor").all(),
    [{ space_type: "new.flock.channel" }],
  );
  assert.deepEqual(
    db.prepare("SELECT space_type FROM space_notification_space_floor").all(),
    [{ space_type: "new.flock.channel" }],
  );
});

test("SPACE_URI_MIGRATION rewrites legacy at://<did>/space/... Operator columns and resets rewritten registrations for immediate renewal", async () => {
  const { SPACE_URI_MIGRATION } = await import("./db");
  closeDb();

  const legacy = new BetterSqlite3(PATH);
  legacy.prepare("DELETE FROM schema_migration WHERE version = ?").run(SPACE_URI_MIGRATION);
  const oldWs = "at://did:plc:mig/space/new.flock.workspace/self";
  const newWs = "at:space/did:plc:mig/new.flock.workspace/self";
  const oldChan = "at://did:plc:mig/space/new.flock.channel/general";
  const newChan = "at:space/did:plc:mig/new.flock.channel/general";

  legacy.prepare(`INSERT OR REPLACE INTO operation (workspace, workspace_uri, actor, operation_id, request_hash, request_json, state, steps_json, created_at, updated_at)
    VALUES ('did:plc:mig', ?, 'did:plc:admin', '2222222222222', 'h', ?, 'pending', ?, 1, 1)`)
    .run(oldWs, JSON.stringify({ workspace: oldWs, channel: oldChan }), JSON.stringify([`createSpace ${oldChan}`]));
  legacy.prepare("INSERT OR REPLACE INTO operation_workspace_catalog (workspace, workspace_uri) VALUES ('did:plc:mig', ?)").run(oldWs);
  legacy.prepare(`INSERT OR REPLACE INTO notification_registration (service_ref, space_uri, expires_at, workspace_uri, token, renew_at, last_space_rev, generation)
    VALUES (?, ?, ?, ?, 'tok-legacy', ?, '2222222222222', 2)`)
    .run(SERVICE_REF, oldChan, Date.now() + 600_000, oldWs, Date.now() + 300_000);
  legacy.prepare("INSERT INTO space_notification (space_uri, space_type, type_seq, repo_did, rev, notified_at) VALUES (?, 'new.flock.channel', 99, 'did:plc:w', '2222222222222', 200)")
    .run(oldChan);
  legacy.close();

  const db = getRawDb();
  const op = db.prepare("SELECT workspace_uri, request_json, steps_json FROM operation WHERE operation_id = '2222222222222'").get() as {
    workspace_uri: string;
    request_json: string;
    steps_json: string;
  };
  assert.equal(op.workspace_uri, newWs);
  assert.deepEqual(JSON.parse(op.request_json), { workspace: newWs, channel: newChan });
  assert.deepEqual(JSON.parse(op.steps_json), [`createSpace ${newChan}`]);

  const cat = db.prepare("SELECT workspace_uri FROM operation_workspace_catalog WHERE workspace = 'did:plc:mig'").get() as { workspace_uri: string };
  assert.equal(cat.workspace_uri, newWs);

  const reg = db.prepare("SELECT space_uri, workspace_uri, expires_at, renew_at FROM notification_registration WHERE space_uri = ?").get(newChan) as {
    space_uri: string;
    workspace_uri: string;
    expires_at: number;
    renew_at: number;
  };
  assert.equal(reg.space_uri, newChan);
  assert.equal(reg.workspace_uri, newWs);
  assert.equal(reg.expires_at, 0, "rewritten registration must reset expires_at for immediate renewal");
  assert.equal(reg.renew_at, 0, "rewritten registration must reset renew_at for immediate renewal");
});

test("ATGRP_MIGRATION = 6 fails closed on unfinished operation rows and retires legacy group.opensocial.invites rows while preserving DM/channel rows", async () => {
  const { ATGRP_MIGRATION } = await import("./db");
  closeDb();

  // 1. Fail closed when ANY unfinished operation row exists ('queued', 'running', 'pending', 'paused')
  for (const state of ["queued", "running", "pending", "paused"] as const) {
    const dbFile = new BetterSqlite3(PATH);
    dbFile.prepare("DELETE FROM schema_migration WHERE version = ?").run(ATGRP_MIGRATION);
    dbFile.prepare("DELETE FROM operation").run();
    dbFile
      .prepare(
        `INSERT INTO operation (workspace, workspace_uri, actor, operation_id, request_hash, request_json, state, steps_json, created_at, updated_at)
         VALUES ('did:plc:mig6', 'at:space/did:plc:mig6/new.flock.workspace/self', 'did:plc:alice', '2222222222226', 'h', '{}', ?, '[]', 1, 1)`,
      )
      .run(state);
    dbFile.close();

    assert.throws(
      () => getRawDb(),
      /Cannot migrate Operator SQLite database to Atmosphere Groups/,
      `ATGRP_MIGRATION must fail closed on unfinished '${state}' operation`,
    );
    closeDb();
  }

  // 2. When only terminal operations exist, v6 succeeds and retires legacy group.opensocial.invites rows while preserving channel & completed audit history
  const dbFile = new BetterSqlite3(PATH);
  dbFile.prepare("DELETE FROM schema_migration WHERE version = ?").run(ATGRP_MIGRATION);
  dbFile.prepare("UPDATE operation SET state = 'completed'").run();
  const legacyInv = "at:space/did:plc:alice/group.opensocial.invites/self";
  const keepChan = "at:space/did:plc:mig6/new.flock.channel/general";
  dbFile
    .prepare(
      `INSERT OR REPLACE INTO notification_registration (service_ref, space_uri, expires_at, workspace_uri, token, renew_at, last_space_rev, generation)
       VALUES (?, ?, 9999999999999, NULL, 'tok-inv', 9999999999999, NULL, 1)`,
    )
    .run(SERVICE_REF, legacyInv);
  dbFile
    .prepare(
      `INSERT OR REPLACE INTO notification_registration (service_ref, space_uri, expires_at, workspace_uri, token, renew_at, last_space_rev, generation)
       VALUES (?, ?, 9999999999999, 'at:space/did:plc:mig6/new.flock.workspace/self', 'tok-chan', 9999999999999, NULL, 1)`,
    )
    .run(SERVICE_REF, keepChan);
  dbFile
    .prepare("INSERT INTO space_notification (space_uri, space_type, type_seq, repo_did, rev, notified_at) VALUES (?, 'group.opensocial.invites', 1, 'did:plc:grp', '2222222222222', 10)")
    .run(legacyInv);
  dbFile
    .prepare("INSERT OR REPLACE INTO space_notification_space_floor (space_uri, space_type, floor) VALUES (?, 'group.opensocial.invites', 1)")
    .run(legacyInv);
  dbFile
    .prepare("INSERT OR REPLACE INTO space_notification_type_floor (space_type, floor) VALUES ('group.opensocial.invites', 1)")
    .run();
  dbFile.close();

  const migrated = getRawDb();
  assert.equal(
    migrated.prepare("SELECT 1 FROM notification_registration WHERE space_uri = ?").get(legacyInv),
    undefined,
    "legacy group.opensocial.invites registration must be retired",
  );
  assert.ok(
    migrated.prepare("SELECT 1 FROM notification_registration WHERE space_uri = ?").get(keepChan),
    "channel registration must be preserved",
  );
  assert.equal(
    migrated.prepare("SELECT 1 FROM space_notification WHERE space_type = 'group.opensocial.invites'").get(),
    undefined,
  );
  assert.equal(
    migrated.prepare("SELECT 1 FROM space_notification_space_floor WHERE space_type = 'group.opensocial.invites'").get(),
    undefined,
  );
  assert.equal(
    migrated.prepare("SELECT 1 FROM space_notification_type_floor WHERE space_type = 'group.opensocial.invites'").get(),
    undefined,
  );
});
