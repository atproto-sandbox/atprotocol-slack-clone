import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import BetterSqlite3 from "better-sqlite3";
import { closeDb, getRawDb, OPERATION_TAKEOVER_MIGRATION } from "./db";

const DIRECTORY = mkdtempSync(join(tmpdir(), "slack-db-r13-upgrade-test-"));
const PATH = join(DIRECTORY, "r12.db");
const SERVICE_REF = "did:web:operator.test#atproto_flock_operator";
process.env.DATABASE_PATH = PATH;
process.env.AUTH_ENCRYPTION_KEY = "88".repeat(32);
process.env.APP_URL = "http://127.0.0.1:3000";
process.env.OPERATOR_SERVICE_REF = SERVICE_REF;

after(() => {
  closeDb();
  rmSync(DIRECTORY, { recursive: true, force: true });
});

test("OPERATION_TAKEOVER_MIGRATION = 4 upgrades a pre-R13 6-state operation table in-place, backfills taken_over_by = NULL, recreates indexes, and accepts aborted_actor_revoked", () => {
  // Seed a genuine pre-R13 SQLite DB with the 6-state CHECK constraint and no `taken_over_by` column.
  const r12 = new BetterSqlite3(PATH);
  r12.exec(`
    CREATE TABLE schema_migration (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
    INSERT INTO schema_migration VALUES (1, 1700000000), (3, 1700000001);
    CREATE TABLE operation (
      workspace TEXT NOT NULL,
      workspace_uri TEXT,
      actor TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      request_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued','running','pending','completed','failed','paused')),
      steps_json TEXT NOT NULL DEFAULT '[]',
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace, actor, operation_id)
    );
    CREATE INDEX operation_status ON operation(state, updated_at);
    CREATE INDEX operation_workspace_recovery ON operation(workspace, workspace_uri, state, created_at);
    CREATE INDEX operation_workspace_stalled ON operation(workspace, workspace_uri, state, updated_at);
  `);

  const workspaceDid = "did:plc:rthirteenupgrd2222222222";
  const workspaceUri = `at:space/${workspaceDid}/new.flock.workspace/self`;
  r12.prepare(`INSERT INTO operation
    (workspace, workspace_uri, actor, operation_id, request_hash, request_json, state, steps_json, error, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      workspaceDid,
      workspaceUri,
      "did:plc:aliceadmin22222222222222",
      "3kabcdefghij2",
      "a".repeat(64),
      JSON.stringify({ workspace: workspaceUri, request: { kind: "createChannel", skey: "roadmap", name: "roadmap", visibility: "public" } }),
      "pending",
      JSON.stringify(["channel-space"]),
      "transient timeout",
      1700000100,
      1700000150,
    );

  // Confirm R12 schema rejects `aborted_actor_revoked` before upgrade.
  assert.throws(() => {
    r12.prepare(`INSERT INTO operation
      (workspace, workspace_uri, actor, operation_id, request_hash, request_json, state, steps_json, error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'aborted_actor_revoked', '[]', NULL, 1, 1)`)
      .run(workspaceDid, workspaceUri, "did:plc:bobmember222222222222222", "3kabcdefghij3", "b".repeat(64), "{}");
  }, /CHECK constraint failed/);
  r12.close();

  // Open through `getRawDb()` and verify `OPERATION_TAKEOVER_MIGRATION = 4` upgraded `operation` cleanly.
  const db = getRawDb();
  const migRow = db.prepare("SELECT version FROM schema_migration WHERE version = ?").get(OPERATION_TAKEOVER_MIGRATION) as { version: number } | undefined;
  assert.equal(migRow?.version, 4);

  const cols = (db.prepare("PRAGMA table_info(operation)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.deepEqual(cols, [
    "workspace",
    "workspace_uri",
    "actor",
    "operation_id",
    "request_hash",
    "request_json",
    "state",
    "steps_json",
    "taken_over_by",
    "error",
    "created_at",
    "updated_at",
  ]);

  const preserved = db
    .prepare("SELECT state, steps_json, taken_over_by, error FROM operation WHERE operation_id = ?")
    .get("3kabcdefghij2") as { state: string; steps_json: string; taken_over_by: string | null; error: string | null };
  assert.deepEqual(preserved, {
    state: "pending",
    steps_json: JSON.stringify(["channel-space"]),
    taken_over_by: null,
    error: "transient timeout",
  });

  // Verify `aborted_actor_revoked` and `taken_over_by` writes now succeed, while invalid states still fail CHECK!
  db.prepare(`INSERT INTO operation
    (workspace, workspace_uri, actor, operation_id, request_hash, request_json, state, steps_json, taken_over_by, error, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'aborted_actor_revoked', '[]', NULL, 'actor demoted', 1700000200, 1700000200)`)
    .run(workspaceDid, workspaceUri, "did:plc:bobmember222222222222222", "3kabcdefghij3", "b".repeat(64), "{}");

  db.prepare("UPDATE operation SET state = 'completed', taken_over_by = ?, error = NULL WHERE operation_id = ?")
    .run("did:plc:caroladmin22222222222222", "3kabcdefghij2");

  const takenOver = db
    .prepare("SELECT state, taken_over_by FROM operation WHERE operation_id = ?")
    .get("3kabcdefghij2") as { state: string; taken_over_by: string | null };
  assert.deepEqual(takenOver, { state: "completed", taken_over_by: "did:plc:caroladmin22222222222222" });

  assert.throws(() => {
    db.prepare("UPDATE operation SET state = 'bogus_state' WHERE operation_id = ?").run("3kabcdefghij2");
  }, /CHECK constraint failed/);

  // Verify all 3 required indexes on `operation` were recreated.
  const indexes = (db.prepare("PRAGMA index_list(operation)").all() as Array<{ name: string }>).map((i) => i.name);
  assert.ok(indexes.includes("operation_status"), "operation_status index present");
  assert.ok(indexes.includes("operation_workspace_recovery"), "operation_workspace_recovery index present");
  assert.ok(indexes.includes("operation_workspace_stalled"), "operation_workspace_stalled index present");
});
