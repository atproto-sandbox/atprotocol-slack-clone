import assert from "node:assert/strict";
import BetterSqlite3 from "better-sqlite3";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDb, getRawDb } from "@/lib/db";
import { listJournaledWorkspaces, listRecoverableOperations } from "./journal";

const MEMBER_TOKEN = "member-access-token-sentinel";
const CHANNEL_CONTENT = "channel-content-sentinel";

test("journal migration indexes legacy operation rows by workspace URI; an older database keeps nothing of the member session", () => {
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
    CREATE TABLE oauth_session (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE oauth_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE web_session (token_hash TEXT PRIMARY KEY, did TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
  `);
  const account = "did:plc:legacyreader";
  const channel = `at://${workspaceDid}/space/new.flock.channel/general`;
  legacy.prepare(`INSERT INTO channel_record_cache
    (account_did,space_uri,repo_did,collection,rkey,uri,value_cipher,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(account, channel, account, "new.flock.channel.message", "2222222222299", `at://${account}/new.flock.channel.message/2222222222299`, CHANNEL_CONTENT, now);
  legacy.prepare(`INSERT INTO space_collection_cursor
    (account_did,space_uri,repo_did,collection,rev,next_cursor,finished,checked_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(account, channel, account, "new.flock.channel.message", "rev", null, 1, now);
  legacy.prepare("INSERT INTO sync_cursor (account_did,space_uri,repo_did,rev,updated_at) VALUES (?,?,?,?,?)")
    .run(account, channel, account, "rev", now);
  legacy.prepare("INSERT INTO workspace_channel_cache (account_did,workspace_uri,space_uri,updated_at) VALUES (?,?,?,?)")
    .run(account, workspaceUri, channel, now);
  legacy.prepare("INSERT INTO oauth_session (key,value,updated_at) VALUES (?,?,?)").run(account, JSON.stringify({ access_token: MEMBER_TOKEN }), now);
  legacy.prepare("INSERT INTO oauth_state (key,value,updated_at) VALUES (?,?,?)").run("state", MEMBER_TOKEN, now);
  legacy.prepare("INSERT INTO web_session (token_hash,did,created_at,expires_at) VALUES (?,?,?,?)").run(MEMBER_TOKEN, account, now, now + 3600);
  legacy.close();
  try {
    const raw = getRawDb();
    const migrated = raw.prepare("SELECT workspace_uri FROM operation WHERE operation_id = ?").get("2222222222299") as { workspace_uri: string };
    assert.equal(migrated.workspace_uri, workspaceUri);
    assert.deepEqual(listJournaledWorkspaces(), [{ authorityDid: workspaceDid, uri: workspaceUri }]);
    assert.equal(listRecoverableOperations(workspaceDid, workspaceUri).length, 1);
    const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(({ name }) => name);
    for (const table of ["oauth_state", "oauth_session", "web_session", "sync_cursor", "channel_record_cache", "workspace_channel_cache", "space_collection_cursor"]) {
      assert.ok(!tables.includes(table), `${table} is dropped`);
    }
    // Nothing of what they held survives in the file's free pages.
    const file = Buffer.concat([databasePath, `${databasePath}-wal`].filter(existsSync).map((path) => readFileSync(path)));
    assert.equal(file.includes(MEMBER_TOKEN), false, "no member token is left in the database file");
    assert.equal(file.includes(CHANNEL_CONTENT), false, "no channel content is left in the database file");
  } finally {
    closeDb();
    rmSync(directory, { recursive: true, force: true });
  }
});
