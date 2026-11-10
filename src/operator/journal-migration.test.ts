import assert from "node:assert/strict";
import BetterSqlite3 from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDb, getRawDb } from "@/lib/db";
import { listJournaledWorkspaces, listRecoverableOperations } from "./journal";

test("journal migration indexes legacy operation rows by workspace URI", () => {
  const directory = mkdtempSync(join(tmpdir(), "slack-journal-migration-test-"));
  const databasePath = join(directory, "legacy.db");
  const workspaceDid = "did:plc:legacyowner";
  const workspaceUri = `at://${workspaceDid}/space/new.flock.workspace/legacy`;
  process.env.DATABASE_PATH = databasePath;
  process.env.AUTH_ENCRYPTION_KEY = "66".repeat(32);
  process.env.OPERATOR_SERVICE_REF = "did:web:localhost%3A3000#atproto_flock_operator";
  process.env.APP_URL = "http://127.0.0.1:3000";
  const legacy = new BetterSqlite3(databasePath);
  legacy.exec(`CREATE TABLE operation (
    workspace TEXT NOT NULL, actor TEXT NOT NULL, operation_id TEXT NOT NULL,
    request_hash TEXT NOT NULL, request_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued','running','pending','completed','failed','paused')),
    steps_json TEXT NOT NULL DEFAULT '[]', error TEXT, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, PRIMARY KEY (workspace,actor,operation_id)
  )`);
  const now = Math.floor(Date.now() / 1000);
  legacy.prepare(`INSERT INTO operation
    (workspace,actor,operation_id,request_hash,request_json,state,steps_json,created_at,updated_at)
    VALUES (?,?,?,?,?,'pending','[]',?,?)`).run(
    workspaceDid, workspaceDid, "2222222222299", "legacy-hash",
    JSON.stringify({ workspace: workspaceUri, request: { kind: "testOperation" } }), now, now,
  );
  legacy.exec(`
    CREATE TABLE channel_record_cache (
      account_did TEXT NOT NULL, space_uri TEXT NOT NULL, repo_did TEXT NOT NULL,
      collection TEXT NOT NULL, rkey TEXT NOT NULL, uri TEXT NOT NULL,
      value_cipher TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (account_did, space_uri, repo_did, collection, rkey)
    );
    CREATE TABLE space_collection_cursor (
      account_did TEXT NOT NULL, space_uri TEXT NOT NULL, repo_did TEXT NOT NULL,
      collection TEXT NOT NULL, rev TEXT NOT NULL, next_cursor TEXT,
      finished INTEGER NOT NULL DEFAULT 0, checked_at INTEGER NOT NULL,
      PRIMARY KEY (account_did, space_uri, repo_did, collection)
    );
    CREATE TABLE sync_cursor (
      account_did TEXT NOT NULL, space_uri TEXT NOT NULL, repo_did TEXT NOT NULL,
      rev TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (account_did, space_uri, repo_did)
    );
    CREATE TABLE workspace_channel_cache (
      account_did TEXT NOT NULL, workspace_uri TEXT NOT NULL, space_uri TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (account_did, workspace_uri, space_uri)
    );
  `);
  const account = "did:plc:legacyreader";
  const channel = `at://${workspaceDid}/space/new.flock.channel/general`;
  legacy.prepare(`INSERT INTO channel_record_cache
    (account_did,space_uri,repo_did,collection,rkey,uri,value_cipher,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(account, channel, account, "new.flock.channel.message", "2222222222299", `at://${account}/new.flock.channel.message/2222222222299`, "v1.unbound", now);
  legacy.prepare(`INSERT INTO space_collection_cursor
    (account_did,space_uri,repo_did,collection,rev,next_cursor,finished,checked_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(account, channel, account, "new.flock.channel.message", "rev", null, 1, now);
  legacy.prepare("INSERT INTO sync_cursor (account_did,space_uri,repo_did,rev,updated_at) VALUES (?,?,?,?,?)")
    .run(account, channel, account, "rev", now);
  legacy.prepare("INSERT INTO workspace_channel_cache (account_did,workspace_uri,space_uri,updated_at) VALUES (?,?,?,?)")
    .run(account, workspaceUri, channel, now);
  legacy.close();
  try {
    const raw = getRawDb();
    const migrated = raw.prepare("SELECT workspace_uri FROM operation WHERE operation_id = ?").get("2222222222299") as { workspace_uri: string };
    assert.equal(migrated.workspace_uri, workspaceUri);
    assert.deepEqual(listJournaledWorkspaces(), [{ authorityDid: workspaceDid, uri: workspaceUri }]);
    assert.equal(listRecoverableOperations(workspaceDid, workspaceUri).length, 1);
    for (const table of ["channel_record_cache", "space_collection_cursor", "sync_cursor"]) {
      assert.equal((raw.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count, 0, `${table} is cleared`);
    }
    assert.equal((raw.prepare("SELECT count(*) AS count FROM workspace_channel_cache").get() as { count: number }).count, 1);
    assert.ok(raw.prepare("SELECT 1 FROM schema_migration WHERE version = 2").get());
  } finally {
    closeDb();
    rmSync(directory, { recursive: true, force: true });
  }
});
