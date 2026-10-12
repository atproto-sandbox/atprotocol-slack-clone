import BetterSqlite3 from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Kysely, SqliteDialect } from "kysely";
import { getConfig } from "./config";

type OperationState = "queued" | "running" | "pending" | "completed" | "failed" | "paused";

export interface SlackDb {
  oauth_state: { key: string; value: string; updated_at: number };
  oauth_session: { key: string; value: string; updated_at: number };
  oauth_request_lock: { name: string; token: string; expires_at: number };
  web_session: { token_hash: string; did: string; created_at: number; expires_at: number };
  operation: {
    workspace: string;
    workspace_uri: string | null;
    actor: string;
    operation_id: string;
    request_hash: string;
    request_json: string;
    state: OperationState;
    steps_json: string;
    error: string | null;
    created_at: number;
    updated_at: number;
  };
  audit_event: {
    id: number;
    workspace: string;
    actor: string;
    operation_id: string;
    event: string;
    details_json: string;
    created_at: number;
  };
  sync_cursor: {
    account_did: string;
    space_uri: string;
    repo_did: string;
    rev: string;
    updated_at: number;
  };
  notification_registration: { service_ref: string; space_uri: string; expires_at: number };
  space_notification: { id: number; space_uri: string; repo_did: string; rev: string; notified_at: number };
}

let database: Kysely<SlackDb> | undefined;
let rawDatabase: BetterSqlite3.Database | undefined;

export function getDb(): Kysely<SlackDb> {
  if (database) return database;
  const config = getConfig();
  const file = resolve(config.databasePath);
  mkdirSync(dirname(file), { recursive: true });
  rawDatabase = new BetterSqlite3(file);
  rawDatabase.pragma("journal_mode = WAL");
  rawDatabase.pragma("foreign_keys = ON");
  rawDatabase.pragma("busy_timeout = 5000");
  rawDatabase.exec(`
    CREATE TABLE IF NOT EXISTS oauth_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_session (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_request_lock (
      name TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS web_session (
      token_hash TEXT PRIMARY KEY,
      did TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS web_session_expiry ON web_session(expires_at);
    CREATE TABLE IF NOT EXISTS operation (
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
    CREATE INDEX IF NOT EXISTS operation_status ON operation(state, updated_at);
    CREATE TABLE IF NOT EXISTS operation_workspace_catalog (
      workspace TEXT NOT NULL,
      workspace_uri TEXT NOT NULL,
      PRIMARY KEY (workspace, workspace_uri)
    );
    CREATE TABLE IF NOT EXISTS schema_migration (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_event (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace TEXT NOT NULL,
      actor TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      event TEXT NOT NULL,
      details_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_cursor (
      account_did TEXT NOT NULL,
      space_uri TEXT NOT NULL,
      repo_did TEXT NOT NULL,
      rev TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (account_did, space_uri, repo_did)
    );
    CREATE TABLE IF NOT EXISTS workspace_lock (
      workspace TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS channel_record_cache (
      account_did TEXT NOT NULL,
      space_uri TEXT NOT NULL,
      repo_did TEXT NOT NULL,
      collection TEXT NOT NULL,
      rkey TEXT NOT NULL,
      uri TEXT NOT NULL,
      value_cipher TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (account_did, space_uri, repo_did, collection, rkey)
    );
    CREATE INDEX IF NOT EXISTS channel_cache_page ON channel_record_cache(account_did, space_uri, collection, rkey);
    CREATE TABLE IF NOT EXISTS workspace_channel_cache (
      account_did TEXT NOT NULL,
      workspace_uri TEXT NOT NULL,
      space_uri TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (account_did, workspace_uri, space_uri)
    );
    CREATE INDEX IF NOT EXISTS workspace_channel_lookup ON workspace_channel_cache(account_did, space_uri);
    CREATE TABLE IF NOT EXISTS space_collection_cursor (
      account_did TEXT NOT NULL,
      space_uri TEXT NOT NULL,
      repo_did TEXT NOT NULL,
      collection TEXT NOT NULL,
      rev TEXT NOT NULL,
      next_cursor TEXT,
      finished INTEGER NOT NULL DEFAULT 0,
      checked_at INTEGER NOT NULL,
      PRIMARY KEY (account_did, space_uri, repo_did, collection)
    );
    CREATE TABLE IF NOT EXISTS notification_registration (
      service_ref TEXT NOT NULL,
      space_uri TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (service_ref, space_uri)
    );
    CREATE TABLE IF NOT EXISTS space_notification (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      space_uri TEXT NOT NULL,
      repo_did TEXT NOT NULL,
      rev TEXT NOT NULL,
      notified_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS space_notification_lookup ON space_notification(space_uri, id);
    CREATE INDEX IF NOT EXISTS space_notification_age ON space_notification(notified_at);
    CREATE INDEX IF NOT EXISTS space_collection_cursor_repo ON space_collection_cursor(space_uri, repo_did);
  `);
  rawDatabase.exec("BEGIN IMMEDIATE");
  try {
    const operationColumns = rawDatabase.prepare("PRAGMA table_info(operation)").all() as Array<{ name: string }>;
    if (!operationColumns.some(({ name }) => name === "workspace_uri")) {
      rawDatabase.exec("ALTER TABLE operation ADD COLUMN workspace_uri TEXT");
    }
    const migration = rawDatabase.prepare("SELECT 1 FROM schema_migration WHERE version = 1").get();
    if (!migration) {
      rawDatabase.exec(`UPDATE operation
        SET workspace_uri = CASE
          WHEN json_valid(request_json) THEN CASE
            WHEN json_type(request_json, '$.workspace') = 'text' THEN json_extract(request_json, '$.workspace')
            ELSE NULL
          END
          ELSE NULL
        END
        WHERE workspace_uri IS NULL`);
      rawDatabase.exec(`INSERT OR IGNORE INTO operation_workspace_catalog (workspace, workspace_uri)
        SELECT DISTINCT workspace, workspace_uri FROM operation WHERE workspace_uri IS NOT NULL`);
      rawDatabase.prepare("INSERT INTO schema_migration (version, applied_at) VALUES (1, ?)").run(Math.floor(Date.now() / 1000));
    }
    const contextBoundCacheMigration = rawDatabase.prepare("SELECT 1 FROM schema_migration WHERE version = 2").get();
    if (!contextBoundCacheMigration) {
      // v1 cache ciphertext was not bound to its account/space/record row. Drop
      // it and its paging cursors so the next authorized read refetches records.
      rawDatabase.exec("DELETE FROM channel_record_cache; DELETE FROM space_collection_cursor; DELETE FROM sync_cursor;");
      rawDatabase.prepare("INSERT INTO schema_migration (version, applied_at) VALUES (2, ?)").run(Math.floor(Date.now() / 1000));
    }
    rawDatabase.exec(`CREATE INDEX IF NOT EXISTS operation_workspace_recovery
      ON operation(workspace, workspace_uri, state, created_at);
      CREATE INDEX IF NOT EXISTS operation_workspace_stalled
      ON operation(workspace, workspace_uri, state, updated_at);`);
    rawDatabase.exec("COMMIT");
  } catch (error) {
    rawDatabase.exec("ROLLBACK");
    throw error;
  }
  database = new Kysely<SlackDb>({ dialect: new SqliteDialect({ database: rawDatabase }) });
  return database;
}

export function getRawDb(): BetterSqlite3.Database {
  getDb();
  if (!rawDatabase) throw new Error("Database did not initialize.");
  return rawDatabase;
}

export function closeDb(): void {
  const raw = rawDatabase;
  database = undefined;
  rawDatabase = undefined;
  if (raw?.open) raw.close();
}
