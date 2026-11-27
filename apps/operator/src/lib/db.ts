import BetterSqlite3 from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Kysely, SqliteDialect } from "kysely";
import { normalizeLegacySpaceUri } from "@flock/protocol/keys";
import { NAMESPACE } from "@flock/protocol/nsids";
import { getOperatorConfig, resetOperatorConfigCacheForTest } from "../config";

export type OperationState =
  | "queued"
  | "running"
  | "pending"
  | "completed"
  | "failed"
  | "paused"
  | "aborted_actor_revoked";

export const OPERATION_TAKEOVER_MIGRATION = 4;
export const SPACE_URI_MIGRATION = 5;

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
    taken_over_by: string | null;
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
  notification_registration: {
    service_ref: string;
    space_uri: string;
    expires_at: number;
    workspace_uri: string | null;
    token: string;
    renew_at: number;
    last_space_rev: string | null;
    generation: number;
  };
  notification_registration_failure: { space_uri: string; workspace_uri: string; failures: number; next_attempt_at: number; last_error: string };
  space_notification: { id: number; space_uri: string; space_type: string; type_seq: number; repo_did: string; rev: string; notified_at: number };
}

let database: Kysely<SlackDb> | undefined;
let rawDatabase: BetterSqlite3.Database | undefined;
const dbCloseListeners = new Set<() => void>();

export function onDbClose(listener: () => void): () => void {
  dbCloseListeners.add(listener);
  return () => {
    dbCloseListeners.delete(listener);
  };
}

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
  const isMemoryDb = config.databasePath === ":memory:";
  const file = isMemoryDb ? ":memory:" : resolve(config.databasePath);
  if (!isMemoryDb) {
    mkdirSync(dirname(file), { recursive: true });
  }
  rawDatabase = new BetterSqlite3(file);
  if (!isMemoryDb) {
    rawDatabase.pragma("journal_mode = WAL");
  }
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
      state TEXT NOT NULL CHECK (state IN ('queued','running','pending','completed','failed','paused','aborted_actor_revoked')),
      steps_json TEXT NOT NULL DEFAULT '[]',
      taken_over_by TEXT,
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
      token TEXT NOT NULL DEFAULT '',
      renew_at INTEGER NOT NULL DEFAULT 0,
      last_space_rev TEXT,
      generation INTEGER NOT NULL DEFAULT 1,
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
    if (!registrationColumns.some(({ name }) => name === "token")) {
      rawDatabase.exec("ALTER TABLE notification_registration ADD COLUMN token TEXT NOT NULL DEFAULT ''");
    }
    if (!registrationColumns.some(({ name }) => name === "renew_at")) {
      rawDatabase.exec("ALTER TABLE notification_registration ADD COLUMN renew_at INTEGER NOT NULL DEFAULT 0");
    }
    if (!registrationColumns.some(({ name }) => name === "last_space_rev")) {
      rawDatabase.exec("ALTER TABLE notification_registration ADD COLUMN last_space_rev TEXT");
    }
    if (!registrationColumns.some(({ name }) => name === "generation")) {
      rawDatabase.exec("ALTER TABLE notification_registration ADD COLUMN generation INTEGER NOT NULL DEFAULT 1");
    }
    // Legacy registerNotify-era rows have no inline webhook token (and could have ~24h expires_at); reset so startup renews immediately.
    rawDatabase.exec("UPDATE notification_registration SET expires_at = 0, renew_at = 0 WHERE token = ''");
    // Purge any historical pre-R12 DM rows left in notice and floor tables on upgraded databases.
    const dmSpaceTypePattern = `${NAMESPACE}.dm.%`;
    rawDatabase.prepare("DELETE FROM space_notification WHERE space_type LIKE ?").run(dmSpaceTypePattern);
    rawDatabase.prepare("DELETE FROM space_notification_space_floor WHERE space_type LIKE ?").run(dmSpaceTypePattern);
    rawDatabase.prepare("DELETE FROM space_notification_type_floor WHERE space_type LIKE ?").run(dmSpaceTypePattern);
    rawDatabase.exec("CREATE INDEX IF NOT EXISTS notification_registration_workspace ON notification_registration(workspace_uri, expires_at)");
    rawDatabase.exec("CREATE INDEX IF NOT EXISTS notification_registration_due ON notification_registration(service_ref, renew_at)");
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
    const takeoverMigration = rawDatabase.prepare("SELECT 1 FROM schema_migration WHERE version = ?").get(OPERATION_TAKEOVER_MIGRATION);
    if (!takeoverMigration) {
      const latestOperationColumns = rawDatabase.prepare("PRAGMA table_info(operation)").all() as Array<{ name: string }>;
      const hasTakenOverBy = latestOperationColumns.some(({ name }) => name === "taken_over_by");
      rawDatabase.exec(`
        DROP TABLE IF EXISTS operation_r13_rebuild;
        CREATE TABLE operation_r13_rebuild (
          workspace TEXT NOT NULL,
          workspace_uri TEXT,
          actor TEXT NOT NULL,
          operation_id TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          request_json TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('queued','running','pending','completed','failed','paused','aborted_actor_revoked')),
          steps_json TEXT NOT NULL DEFAULT '[]',
          taken_over_by TEXT,
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (workspace, actor, operation_id)
        );
        INSERT INTO operation_r13_rebuild (
          workspace, workspace_uri, actor, operation_id, request_hash, request_json,
          state, steps_json, taken_over_by, error, created_at, updated_at
        )
        SELECT
          workspace, workspace_uri, actor, operation_id, request_hash, request_json,
          state, steps_json, ${hasTakenOverBy ? "taken_over_by" : "NULL"}, error, created_at, updated_at
        FROM operation;
        DROP TABLE operation;
        ALTER TABLE operation_r13_rebuild RENAME TO operation;
        CREATE INDEX IF NOT EXISTS operation_status ON operation(state, updated_at);
      `);
      rawDatabase
        .prepare("INSERT INTO schema_migration (version, applied_at) VALUES (?, ?)")
        .run(OPERATION_TAKEOVER_MIGRATION, Math.floor(Date.now() / 1000));
    }
    const spaceUriMigration = rawDatabase.prepare("SELECT 1 FROM schema_migration WHERE version = ?").get(SPACE_URI_MIGRATION);
    if (!spaceUriMigration) {
      migrateOperatorLegacySpaceUrisSync(rawDatabase);
      rawDatabase
        .prepare("INSERT INTO schema_migration (version, applied_at) VALUES (?, ?)")
        .run(SPACE_URI_MIGRATION, Math.floor(Date.now() / 1000));
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

const OPERATOR_LEGACY_SPACE_URI_COLUMNS: ReadonlyArray<readonly [table: string, column: string]> = [
  ["operation", "workspace_uri"],
  ["operation_workspace_catalog", "workspace_uri"],
  ["notification_registration", "space_uri"],
  ["notification_registration", "workspace_uri"],
  ["notification_registration_failure", "space_uri"],
  ["notification_registration_failure", "workspace_uri"],
  ["space_notification", "space_uri"],
  ["space_notification_space_floor", "space_uri"],
];

const OPERATOR_LEGACY_SPACE_URI_INLINE_RE = /at:\/\/(did:[^/"'\s\\]+)\/space\//g;

function rewriteOperatorJsonLegacySpaceUris(raw: string): string {
  if (!raw.includes("/space/")) return raw;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const visit = (value: unknown): unknown => {
      if (typeof value === "string") {
        const normalized = normalizeLegacySpaceUri(value);
        return normalized !== value ? normalized : value.replace(OPERATOR_LEGACY_SPACE_URI_INLINE_RE, "at:space/$1/");
      }
      if (Array.isArray(value)) return value.map(visit);
      if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          out[normalizeLegacySpaceUri(k)] = visit(v);
        }
        return out;
      }
      return value;
    };
    return JSON.stringify(visit(parsed));
  } catch {
    return raw.replace(OPERATOR_LEGACY_SPACE_URI_INLINE_RE, "at:space/$1/");
  }
}

/**
 * Idempotently rewrites pre-Nov-24 `at://<did>/space/...` URIs to canonical `at:space/<did>/...` across
 * Operator SQLite tables and resets rewritten webhook registrations so startup renews them immediately.
 */
export function migrateOperatorLegacySpaceUrisSync(db: BetterSqlite3.Database): void {
  // Force immediate renewal on any registration whose space_uri or workspace_uri is still in legacy form.
  db.exec(`
    UPDATE notification_registration
    SET expires_at = 0, renew_at = 0
    WHERE (substr(space_uri, 1, 5) = 'at://' AND substr(space_uri, instr(substr(space_uri, 6), '/') + 5, 7) = '/space/')
       OR (workspace_uri IS NOT NULL AND substr(workspace_uri, 1, 5) = 'at://' AND substr(workspace_uri, instr(substr(workspace_uri, 6), '/') + 5, 7) = '/space/')
  `);

  for (const [table, column] of OPERATOR_LEGACY_SPACE_URI_COLUMNS) {
    db.exec(`
      UPDATE ${table}
      SET ${column} = 'at:space/' || substr(${column}, 6, instr(substr(${column}, 6), '/') - 1) || '/'
        || substr(${column}, instr(substr(${column}, 6), '/') + 12)
      WHERE ${column} IS NOT NULL
        AND substr(${column}, 1, 5) = 'at://'
        AND substr(${column}, instr(substr(${column}, 6), '/') + 5, 7) = '/space/'
    `);
  }

  const opRows = db
    .prepare(
      "SELECT workspace, actor, operation_id, request_json, steps_json FROM operation WHERE request_json LIKE '%at://%/space/%' OR steps_json LIKE '%at://%/space/%'",
    )
    .all() as Array<{ workspace: string; actor: string; operation_id: string; request_json: string; steps_json: string }>;
  if (opRows.length > 0) {
    const updOp = db.prepare(
      "UPDATE operation SET request_json = ?, steps_json = ? WHERE workspace = ? AND actor = ? AND operation_id = ?",
    );
    for (const row of opRows) {
      updOp.run(
        rewriteOperatorJsonLegacySpaceUris(row.request_json),
        rewriteOperatorJsonLegacySpaceUris(row.steps_json),
        row.workspace,
        row.actor,
        row.operation_id,
      );
    }
  }

  const auditRows = db
    .prepare("SELECT id, details_json FROM audit_event WHERE details_json LIKE '%at://%/space/%'")
    .all() as Array<{ id: number; details_json: string }>;
  if (auditRows.length > 0) {
    const updAudit = db.prepare("UPDATE audit_event SET details_json = ? WHERE id = ?");
    for (const row of auditRows) {
      updAudit.run(rewriteOperatorJsonLegacySpaceUris(row.details_json), row.id);
    }
  }
}

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
  for (const listener of [...dbCloseListeners]) {
    try {
      listener();
    } catch {
      // Best-effort listener teardown.
    }
  }
  const raw = rawDatabase;
  database = undefined;
  rawDatabase = undefined;
  resetOperatorConfigCacheForTest();
  if (raw?.open) raw.close();
}
