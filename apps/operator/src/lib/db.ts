import BetterSqlite3 from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Kysely, SqliteDialect } from "kysely";
import { getOperatorConfig } from "../config";

type OperationState = "queued" | "running" | "pending" | "completed" | "failed" | "paused";

export interface SlackDb {
  oauth_request_lock: { name: string; token: string; expires_at: number };
  authority_grant: { key: string; value: string; updated_at: number };
  authority_grant_state: { key: string; value: string; updated_at: number };
  authority_ticket: { token_hash: string; initiator_did: string; authority_did: string; purpose_json: string; expires_at: number };
  creation_authorization: { authority_did: string; initiator_did: string; name: string; operation_id: string | null; expires_at: number };
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
  notification_registration: { service_ref: string; space_uri: string; expires_at: number; workspace_uri: string | null };
  notification_registration_failure: { space_uri: string; workspace_uri: string; failures: number; next_attempt_at: number; last_error: string };
  space_notification: { id: number; space_uri: string; space_type: string; type_seq: number; repo_did: string; rev: string; notified_at: number };
}

let database: Kysely<SlackDb> | undefined;
let rawDatabase: BetterSqlite3.Database | undefined;

/**
 * Content-free write notices, with what the change feed needs to answer a cursor: each notice's space type and its place
 * among that type's notices (the per-type cap), and the newest notice id pruned per type and, for a space's own cap, per
 * space, so a cursor below what was pruned is answered with a reset.
 */
const SPACE_NOTIFICATION_SCHEMA = `
    CREATE TABLE IF NOT EXISTS space_notification (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      space_uri TEXT NOT NULL,
      space_type TEXT NOT NULL,
      type_seq INTEGER NOT NULL,
      repo_did TEXT NOT NULL,
      rev TEXT NOT NULL,
      notified_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS space_notification_lookup ON space_notification(space_uri, id);
    CREATE INDEX IF NOT EXISTS space_notification_age ON space_notification(notified_at);
    CREATE INDEX IF NOT EXISTS space_notification_type ON space_notification(space_type, type_seq);
    CREATE TABLE IF NOT EXISTS space_notification_type_floor (
      space_type TEXT PRIMARY KEY,
      floor INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS space_notification_space_floor (
      space_uri TEXT PRIMARY KEY,
      space_type TEXT NOT NULL,
      floor INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS space_notification_space_floor_type ON space_notification_space_floor(space_type, floor);
`;

/**
 * Notices are content-free and kept a week at most, so a table from before the per-type caps is dropped, not migrated, before
 * the schema is created; its id sequence restarts, so a client's older cursor is above the new head and is answered with a
 * reset. Checked inside the write lock, so two processes opening an old database at once drop it only once.
 */
function replaceNoticeTableFromBeforeTypeCaps(database: BetterSqlite3.Database): void {
  database.transaction(() => {
    const columns = database.prepare("PRAGMA table_info(space_notification)").all() as Array<{ name: string }>;
    if (columns.length > 0 && !columns.some(({ name }) => name === "space_type")) database.exec("DROP TABLE space_notification");
  }).immediate();
}

export function getDb(): Kysely<SlackDb> {
  if (database) return database;
  const config = getOperatorConfig();
  const file = resolve(config.databasePath);
  mkdirSync(dirname(file), { recursive: true });
  rawDatabase = new BetterSqlite3(file);
  rawDatabase.pragma("journal_mode = WAL");
  rawDatabase.pragma("foreign_keys = ON");
  rawDatabase.pragma("busy_timeout = 5000");
  replaceNoticeTableFromBeforeTypeCaps(rawDatabase);
  rawDatabase.exec(`
    CREATE TABLE IF NOT EXISTS authority_grant (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS authority_grant_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS authority_ticket (
      token_hash TEXT PRIMARY KEY,
      initiator_did TEXT NOT NULL,
      authority_did TEXT NOT NULL,
      purpose_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS authority_ticket_expiry ON authority_ticket(expires_at);
    CREATE TABLE IF NOT EXISTS creation_authorization (
      authority_did TEXT NOT NULL,
      initiator_did TEXT NOT NULL,
      name TEXT NOT NULL,
      operation_id TEXT,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (authority_did, initiator_did, name)
    );
    CREATE TABLE IF NOT EXISTS oauth_request_lock (
      name TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
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
    CREATE TABLE IF NOT EXISTS workspace_lock (
      workspace TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notification_registration (
      service_ref TEXT NOT NULL,
      space_uri TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      workspace_uri TEXT,
      PRIMARY KEY (service_ref, space_uri)
    );
    CREATE TABLE IF NOT EXISTS notification_registration_failure (
      space_uri TEXT PRIMARY KEY,
      workspace_uri TEXT NOT NULL,
      failures INTEGER NOT NULL,
      next_attempt_at INTEGER NOT NULL,
      last_error TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS notification_registration_failure_workspace ON notification_registration_failure(workspace_uri);
    ${SPACE_NOTIFICATION_SCHEMA}
  `);
  rawDatabase.exec("BEGIN IMMEDIATE");
  try {
    const registrationColumns = rawDatabase.prepare("PRAGMA table_info(notification_registration)").all() as Array<{ name: string }>;
    if (!registrationColumns.some(({ name }) => name === "workspace_uri")) {
      rawDatabase.exec("ALTER TABLE notification_registration ADD COLUMN workspace_uri TEXT");
    }
    rawDatabase.exec("CREATE INDEX IF NOT EXISTS notification_registration_workspace ON notification_registration(workspace_uri, expires_at)");
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
    rawDatabase.exec(`CREATE INDEX IF NOT EXISTS operation_workspace_recovery
      ON operation(workspace, workspace_uri, state, created_at);
      CREATE INDEX IF NOT EXISTS operation_workspace_stalled
      ON operation(workspace, workspace_uri, state, updated_at);`);
    rawDatabase.exec("COMMIT");
  } catch (error) {
    rawDatabase.exec("ROLLBACK");
    throw error;
  }
  dropMemberSessionTables(rawDatabase);
  database = new Kysely<SlackDb>({ dialect: new SqliteDialect({ database: rawDatabase }) });
  return database;
}

/**
 * What the server held while members signed in to it, until R6c: OAuth state and sessions, its web sessions, and the
 * channel content it synced for them with its cursors. An older database drops them and is rebuilt, so neither a token nor a
 * record survives in the file's free pages.
 */
export const MEMBER_SESSION_TABLES: readonly string[] = ["oauth_state", "oauth_session", "web_session", "sync_cursor", "channel_record_cache", "workspace_channel_cache", "space_collection_cursor"];

/** The `schema_migration` version recorded once those tables are gone and the file was rebuilt without them. */
const MEMBER_SESSION_DROPPED = 3;

function dropMemberSessionTables(db: BetterSqlite3.Database): void {
  if (db.prepare("SELECT 1 FROM schema_migration WHERE version = ?").get(MEMBER_SESSION_DROPPED)) return;
  // One write transaction, so two processes starting together drop them once.
  db.transaction(() => {
    for (const table of MEMBER_SESSION_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
  }).immediate();
  // The rebuild is recorded only once it held: a start that could not finish it (busy, or stopped) rebuilds at the next.
  try {
    db.exec("VACUUM");
  } catch (error) {
    if (isBusy(error)) return;
    throw error;
  }
  const [checkpoint] = db.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number }>;
  if (checkpoint?.busy) return;
  db.prepare("INSERT OR IGNORE INTO schema_migration (version, applied_at) VALUES (?, ?)").run(MEMBER_SESSION_DROPPED, Math.floor(Date.now() / 1000));
}

/** Another connection holds the database, for now. */
function isBusy(error: unknown): boolean {
  return error instanceof Error && "code" in error && typeof error.code === "string" && error.code.startsWith("SQLITE_BUSY");
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
