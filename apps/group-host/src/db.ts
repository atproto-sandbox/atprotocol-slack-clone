import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export const SCHEMA_TABLE_CLASSIFICATION = {
  GROUP_PURGED_TABLES: [
    "notify_registration",
    "space_record_blob",
    "space_record",
    "space_oplog",
    "space_repo",
    "space_writer",
    "group_space",
    "public_record_blob",
    "public_record",
    "public_repo_block",
    "public_repo_root",
    "blob_store",
    "group_invite_target",
    "invite_delivery",
    "join_request",
    "join_operation_state",
    "mod_event",
    "mod_subject",
    "known_app_subject",
    "issued_credential",
    "revoked_credential",
    "used_delegation_jti",
    "used_attestation_jti",
    "service_jwt_jti",
    "group_action_token",
    "source_migration_lease",
    "migration_session",
    "revoked_migration_jti",
    "oauth_par",
    "upstream_oauth_state",
    "oauth_code",
    "oauth_refresh_token",
    "oauth_session",
    "revoked_oauth_family",
    "handle_reservation",
    "group_recovery_admin",
    "group_creation_journal",
    "outbox_notice",
    "group_account",
  ] as const,
  RETAINED_TOMBSTONE_TABLES: ["group_deletion_journal"] as const,
  GLOBAL_TTL_TABLES: ["dpop_jti", "client_assertion_jti"] as const,
} as const;

export type GroupHostDb = Database.Database;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS group_account (
  did TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  signing_key_enc TEXT NOT NULL,
  kem_key_enc TEXT NOT NULL,
  rotation_key_enc TEXT,
  activated INTEGER NOT NULL DEFAULT 1,
  takendown INTEGER NOT NULL DEFAULT 0,
  deactivated_at INTEGER,
  auth_epoch INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS handle_reservation (
  handle TEXT PRIMARY KEY,
  group_did TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_handle_reservation_did ON handle_reservation (group_did);

CREATE TABLE IF NOT EXISTS group_recovery_admin (
  group_did TEXT PRIMARY KEY,
  recovery_did TEXT NOT NULL,
  roles_json TEXT NOT NULL,
  deactivated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS group_creation_journal (
  initiator_did TEXT NOT NULL,
  client_id TEXT NOT NULL,
  creation_key TEXT NOT NULL,
  group_did TEXT NOT NULL,
  handle TEXT NOT NULL,
  display_name TEXT NOT NULL,
  join_policy TEXT NOT NULL,
  public_meta INTEGER NOT NULL,
  signing_key_enc TEXT,
  kem_key_enc TEXT,
  rotation_key_enc TEXT,
  genesis_op_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_plc', 'plc_published', 'code_issued', 'completed', 'compensated')),
  auth_code TEXT,
  redirect_url TEXT,
  par_state TEXT,
  par_response_mode TEXT,
  code_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (initiator_did, client_id, creation_key)
);
CREATE INDEX IF NOT EXISTS idx_creation_journal_group ON group_creation_journal (group_did);
CREATE INDEX IF NOT EXISTS idx_creation_journal_exp ON group_creation_journal (status, updated_at);

CREATE TABLE IF NOT EXISTS public_repo_root (
  group_did TEXT PRIMARY KEY,
  commit_cid TEXT NOT NULL,
  rev TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS public_repo_block (
  group_did TEXT NOT NULL,
  cid TEXT NOT NULL,
  bytes BLOB NOT NULL,
  rev TEXT NOT NULL,
  PRIMARY KEY (group_did, cid)
);

CREATE TABLE IF NOT EXISTS public_record (
  group_did TEXT NOT NULL,
  collection TEXT NOT NULL,
  rkey TEXT NOT NULL,
  uri TEXT NOT NULL UNIQUE,
  cid TEXT NOT NULL,
  value TEXT NOT NULL,
  rev TEXT NOT NULL,
  indexed_at INTEGER NOT NULL,
  PRIMARY KEY (group_did, collection, rkey)
);

CREATE TABLE IF NOT EXISTS public_record_blob (
  group_did TEXT NOT NULL,
  record_uri TEXT NOT NULL,
  blob_cid TEXT NOT NULL,
  PRIMARY KEY (group_did, record_uri, blob_cid)
);

CREATE TABLE IF NOT EXISTS blob_store (
  group_did TEXT NOT NULL,
  cid TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  bytes BLOB NOT NULL,
  temp_key TEXT,
  permanent INTEGER NOT NULL DEFAULT 1,
  quarantined INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_did, cid)
);

CREATE TABLE IF NOT EXISTS group_space (
  space_uri TEXT PRIMARY KEY,
  group_did TEXT NOT NULL,
  space_type TEXT NOT NULL,
  skey TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  space_rev TEXT NOT NULL,
  index_rkey TEXT,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (group_did, space_type, skey)
);
CREATE INDEX IF NOT EXISTS idx_group_space_did ON group_space (group_did, deleted_at);

CREATE TABLE IF NOT EXISTS space_writer (
  space_uri TEXT NOT NULL,
  group_did TEXT NOT NULL,
  writer_did TEXT NOT NULL,
  removed INTEGER NOT NULL DEFAULT 0,
  repo_rev TEXT NOT NULL,
  last_evicted_repo_rev TEXT,
  prior_eject_count INTEGER NOT NULL DEFAULT 0,
  space_rev TEXT NOT NULL,
  data BLOB,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (space_uri, writer_did)
);
CREATE INDEX IF NOT EXISTS idx_space_writer_rev ON space_writer (space_uri, space_rev ASC);
CREATE INDEX IF NOT EXISTS idx_space_writer_group ON space_writer (group_did);

CREATE TABLE IF NOT EXISTS space_repo (
  space_uri TEXT NOT NULL,
  repo_did TEXT NOT NULL,
  set_hash BLOB NOT NULL,
  rev TEXT NOT NULL,
  PRIMARY KEY (space_uri, repo_did)
);
CREATE INDEX IF NOT EXISTS idx_space_repo_did ON space_repo (repo_did);

CREATE TABLE IF NOT EXISTS space_record (
  space_uri TEXT NOT NULL,
  repo_did TEXT NOT NULL,
  collection TEXT NOT NULL,
  rkey TEXT NOT NULL,
  uri TEXT NOT NULL UNIQUE,
  cid TEXT NOT NULL,
  value TEXT NOT NULL,
  cbor_bytes BLOB NOT NULL,
  repo_rev TEXT NOT NULL,
  indexed_at INTEGER NOT NULL,
  incarnation TEXT,
  PRIMARY KEY (space_uri, repo_did, collection, rkey)
);
CREATE INDEX IF NOT EXISTS idx_space_record_list ON space_record (space_uri, repo_did, collection, rkey ASC);

CREATE TABLE IF NOT EXISTS space_oplog (
  space_uri TEXT NOT NULL,
  repo_did TEXT NOT NULL,
  rev TEXT NOT NULL,
  idx INTEGER NOT NULL,
  action TEXT NOT NULL,
  uri TEXT NOT NULL,
  collection TEXT NOT NULL,
  rkey TEXT NOT NULL,
  cid TEXT,
  prev TEXT,
  PRIMARY KEY (space_uri, repo_did, rev, idx)
);
CREATE INDEX IF NOT EXISTS idx_space_oplog_cursor ON space_oplog (space_uri, repo_did, rev ASC, idx ASC);

CREATE TABLE IF NOT EXISTS space_record_blob (
  group_did TEXT NOT NULL,
  space_uri TEXT NOT NULL,
  record_uri TEXT NOT NULL,
  blob_cid TEXT NOT NULL,
  PRIMARY KEY (group_did, space_uri, record_uri, blob_cid)
);

CREATE TABLE IF NOT EXISTS notify_registration (
  space_uri TEXT NOT NULL,
  group_did TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  lapsed_notified INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (space_uri, endpoint, token)
);
CREATE INDEX IF NOT EXISTS idx_notify_reg_space ON notify_registration (space_uri, expires_at);
CREATE INDEX IF NOT EXISTS idx_notify_reg_group ON notify_registration (group_did);

CREATE TABLE IF NOT EXISTS group_invite_target (
  group_did TEXT NOT NULL,
  space_uri TEXT NOT NULL,
  invitee_did TEXT NOT NULL,
  PRIMARY KEY (group_did, space_uri)
);

CREATE TABLE IF NOT EXISTS invite_delivery (
  group_did TEXT NOT NULL,
  invite_uri TEXT NOT NULL,
  space_uri TEXT NOT NULL,
  invitee_did TEXT NOT NULL,
  rkey TEXT NOT NULL,
  repo_rev TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (group_did, invite_uri)
);
CREATE INDEX IF NOT EXISTS idx_invite_delivery_group ON invite_delivery (group_did, updated_at DESC);

CREATE TABLE IF NOT EXISTS join_request (
  group_did TEXT NOT NULL,
  requester_did TEXT NOT NULL,
  message TEXT,
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (group_did, requester_did)
);
CREATE INDEX IF NOT EXISTS idx_join_request_cursor ON join_request (group_did, created_at ASC, requester_did ASC);
CREATE INDEX IF NOT EXISTS idx_join_request_exp ON join_request (expires_at);

CREATE TABLE IF NOT EXISTS join_operation_state (
  group_did TEXT NOT NULL,
  requester_did TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'admitted', 'denied', 'cancelled')),
  response_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (group_did, requester_did, operation_id)
);
CREATE INDEX IF NOT EXISTS idx_join_op_exp ON join_operation_state (expires_at);

CREATE TABLE IF NOT EXISTS mod_subject (
  group_did TEXT NOT NULL,
  subject TEXT NOT NULL,
  cid_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'escalated')),
  report_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (group_did, subject, cid_key)
);
CREATE INDEX IF NOT EXISTS idx_mod_subject_queue ON mod_subject (group_did, status, updated_at DESC, subject ASC, cid_key ASC);

CREATE TABLE IF NOT EXISTS mod_event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  group_did TEXT NOT NULL,
  subject TEXT NOT NULL,
  cid_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT,
  event_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mod_event_subject ON mod_event (group_did, subject, cid_key, seq ASC);

CREATE TABLE IF NOT EXISTS known_app_subject (
  group_did TEXT NOT NULL,
  subject_did TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_did, subject_did)
);

CREATE TABLE IF NOT EXISTS issued_credential (
  jti TEXT PRIMARY KEY,
  group_did TEXT NOT NULL,
  space_uri TEXT NOT NULL,
  writer_did TEXT,
  cnf_kid TEXT NOT NULL,
  exp INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_issued_cred_group ON issued_credential (group_did, exp);
CREATE INDEX IF NOT EXISTS idx_issued_cred_exp ON issued_credential (exp);

CREATE TABLE IF NOT EXISTS revoked_credential (
  jti TEXT NOT NULL,
  group_did TEXT NOT NULL,
  space_uri TEXT NOT NULL,
  exp INTEGER NOT NULL,
  revoked_at INTEGER NOT NULL,
  PRIMARY KEY (group_did, space_uri, jti)
);
CREATE INDEX IF NOT EXISTS idx_revoked_cred_exp ON revoked_credential (exp);
CREATE INDEX IF NOT EXISTS idx_revoked_cred_group ON revoked_credential (group_did);
CREATE INDEX IF NOT EXISTS idx_revoked_cred_group_space ON revoked_credential (group_did, space_uri, exp);

CREATE TABLE IF NOT EXISTS used_delegation_jti (
  issuer_did TEXT NOT NULL,
  jti TEXT NOT NULL,
  group_did TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (issuer_did, jti)
);
CREATE INDEX IF NOT EXISTS idx_used_delegation_exp ON used_delegation_jti (expires_at);
CREATE INDEX IF NOT EXISTS idx_used_delegation_group ON used_delegation_jti (group_did);

CREATE TABLE IF NOT EXISTS used_attestation_jti (
  client_id TEXT NOT NULL,
  jti TEXT NOT NULL,
  group_did TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, jti)
);
CREATE INDEX IF NOT EXISTS idx_used_attestation_exp ON used_attestation_jti (expires_at);
CREATE INDEX IF NOT EXISTS idx_used_attestation_group ON used_attestation_jti (group_did);

CREATE TABLE IF NOT EXISTS service_jwt_jti (
  issuer_did TEXT NOT NULL,
  jti TEXT NOT NULL,
  group_did TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (issuer_did, jti)
);
CREATE INDEX IF NOT EXISTS idx_service_jwt_exp ON service_jwt_jti (expires_at);
CREATE INDEX IF NOT EXISTS idx_service_jwt_group ON service_jwt_jti (group_did);

CREATE TABLE IF NOT EXISTS group_action_token (
  token_hash TEXT PRIMARY KEY,
  group_did TEXT NOT NULL,
  actor_did TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('delete_account', 'plc_operation')),
  claim_ciphertext_enc TEXT,
  claimed_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (group_did, purpose)
);
CREATE INDEX IF NOT EXISTS idx_action_token_exp ON group_action_token (expires_at);

CREATE TABLE IF NOT EXISTS source_migration_lease (
  group_did TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('coordinated', 'standard')),
  ticket_id TEXT,
  ticket_secret_hash TEXT,
  ticket_secret_enc TEXT,
  target_service_did TEXT NOT NULL,
  target_endpoint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('prepared', 'plc_signed')),
  signed_plc_op_json TEXT,
  frozen_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  expires_at INTEGER,
  manifest_digest TEXT NOT NULL,
  root_manifest_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_source_migration_exp ON source_migration_lease (status, expires_at);

CREATE TABLE IF NOT EXISTS migration_session (
  id TEXT PRIMARY KEY,
  group_did TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK (mode IN ('coordinated', 'standard')),
  operation_id TEXT,
  ticket_id TEXT,
  ticket_secret_hash TEXT,
  provenance_jti TEXT,
  source_endpoint TEXT NOT NULL,
  source_service_did TEXT,
  source_local_rotation_key TEXT,
  source_plc_rotation_keys_json TEXT NOT NULL,
  preserved_sovereign_keys_json TEXT NOT NULL,
  manifest_digest TEXT,
  expected_manifest_json TEXT,
  access_jti TEXT NOT NULL UNIQUE,
  refresh_jti TEXT NOT NULL UNIQUE,
  prev_refresh_jti TEXT,
  refresh_idempotency_key TEXT,
  refresh_grace_expires_at INTEGER,
  auth_epoch INTEGER NOT NULL,
  plc_submitting_at INTEGER,
  pending_plc_op_cid TEXT,
  pending_plc_op_json TEXT,
  plc_cutover_at INTEGER,
  absolute_deadline_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_migration_session_exp ON migration_session (plc_cutover_at, absolute_deadline_at);

CREATE TABLE IF NOT EXISTS revoked_migration_jti (
  jti TEXT PRIMARY KEY,
  group_did TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revoked_mig_exp ON revoked_migration_jti (expires_at);
CREATE INDEX IF NOT EXISTS idx_revoked_mig_group ON revoked_migration_jti (group_did);

CREATE TABLE IF NOT EXISTS oauth_par (
  request_uri TEXT PRIMARY KEY,
  group_did TEXT,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  response_mode TEXT NOT NULL CHECK (response_mode IN ('query', 'fragment')),
  scope TEXT NOT NULL,
  state TEXT,
  code_challenge TEXT NOT NULL,
  dpop_jkt TEXT NOT NULL,
  prompt TEXT,
  login_hint TEXT,
  creation_key TEXT,
  authenticated_user_did TEXT,
  authenticated_at INTEGER,
  login_step_up_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_par_exp ON oauth_par (expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_par_group ON oauth_par (group_did);

CREATE TABLE IF NOT EXISTS upstream_oauth_state (
  state TEXT PRIMARY KEY,
  group_did TEXT,
  par_request_uri TEXT NOT NULL,
  expected_user_did TEXT,
  app_state TEXT NOT NULL,
  payload_enc TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_upstream_oauth_exp ON upstream_oauth_state (expires_at);
CREATE INDEX IF NOT EXISTS idx_upstream_oauth_group ON upstream_oauth_state (group_did);

CREATE TABLE IF NOT EXISTS oauth_code (
  code_hash TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  group_did TEXT NOT NULL,
  authorizing_user_did TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  approved_scope TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  dpop_jkt TEXT NOT NULL,
  session_kind TEXT NOT NULL CHECK (session_kind IN ('group', 'recovery')),
  authenticated_at INTEGER NOT NULL,
  login_step_up_at INTEGER,
  consumed_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_code_exp ON oauth_code (expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_code_group ON oauth_code (group_did);

CREATE TABLE IF NOT EXISTS oauth_session (
  session_id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  group_did TEXT NOT NULL,
  authorizing_user_did TEXT NOT NULL,
  client_id TEXT NOT NULL,
  approved_scope TEXT NOT NULL,
  dpop_jkt TEXT NOT NULL,
  session_kind TEXT NOT NULL CHECK (session_kind IN ('group', 'recovery')),
  auth_epoch INTEGER NOT NULL,
  authenticated_at INTEGER NOT NULL,
  login_step_up_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_session_group ON oauth_session (group_did, authorizing_user_did, client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_session_family ON oauth_session (family_id);
CREATE INDEX IF NOT EXISTS idx_oauth_session_exp ON oauth_session (expires_at);

CREATE TABLE IF NOT EXISTS oauth_refresh_token (
  token_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  family_id TEXT NOT NULL,
  group_did TEXT NOT NULL,
  consumed_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_exp ON oauth_refresh_token (expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_group ON oauth_refresh_token (group_did);

CREATE TABLE IF NOT EXISTS revoked_oauth_family (
  family_id TEXT PRIMARY KEY,
  group_did TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revoked_family_exp ON revoked_oauth_family (expires_at);
CREATE INDEX IF NOT EXISTS idx_revoked_family_group ON revoked_oauth_family (group_did);

CREATE TABLE IF NOT EXISTS outbox_notice (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('syncer_update', 'credential_revocation', 'invite_repo_update', 'source_migration_finalize')),
  group_did TEXT NOT NULL,
  coalesce_key TEXT UNIQUE,
  endpoint TEXT NOT NULL,
  token TEXT,
  space_uri TEXT,
  writer_did TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'delivered', 'abandoned')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  lease_until INTEGER,
  next_attempt_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox_notice (status, next_attempt_at ASC);
CREATE INDEX IF NOT EXISTS idx_outbox_group ON outbox_notice (group_did, status);

CREATE TABLE IF NOT EXISTS group_deletion_journal (
  group_did TEXT PRIMARY KEY,
  actor_did TEXT NOT NULL,
  plc_outcome TEXT CHECK (plc_outcome IN ('tombstoned', 'tombstoned_or_absent', 'migrated_remote', 'authority_lost_local_purge')),
  status TEXT NOT NULL CHECK (status IN ('remote_cleanup_queued', 'remote_cleanup_drained', 'plc_tombstoned', 'purged')),
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dpop_jti (
  jkt TEXT NOT NULL,
  jti TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (jkt, jti)
);
CREATE INDEX IF NOT EXISTS idx_dpop_jti_exp ON dpop_jti (expires_at);

CREATE TABLE IF NOT EXISTS client_assertion_jti (
  client_id TEXT NOT NULL,
  jti TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, jti)
);
CREATE INDEX IF NOT EXISTS idx_client_assertion_exp ON client_assertion_jti (expires_at);
`;

export function openGroupHostDb(databasePath: string): GroupHostDb {
  if (databasePath !== ":memory:") {
    const parent = dirname(databasePath);
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true, mode: 0o700 });
    }
  }
  const db = new Database(databasePath);
  if (databasePath !== ":memory:" && existsSync(databasePath)) {
    try {
      chmodSync(databasePath, 0o600);
    } catch {
      // Ignore chmod errors on virtual filesystems
    }
  }
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA_SQL);
  const migCols = new Set(
    (db.prepare("PRAGMA table_info(migration_session)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!migCols.has("plc_submitting_at")) {
    db.exec("ALTER TABLE migration_session ADD COLUMN plc_submitting_at INTEGER");
  }
  if (!migCols.has("pending_plc_op_cid")) {
    db.exec("ALTER TABLE migration_session ADD COLUMN pending_plc_op_cid TEXT");
  }
  if (!migCols.has("pending_plc_op_json")) {
    db.exec("ALTER TABLE migration_session ADD COLUMN pending_plc_op_json TEXT");
  }
  if (!migCols.has("prev_refresh_jti")) {
    db.exec("ALTER TABLE migration_session ADD COLUMN prev_refresh_jti TEXT");
  }
  if (!migCols.has("refresh_idempotency_key")) {
    db.exec("ALTER TABLE migration_session ADD COLUMN refresh_idempotency_key TEXT");
  }
  if (!migCols.has("refresh_grace_expires_at")) {
    db.exec("ALTER TABLE migration_session ADD COLUMN refresh_grace_expires_at INTEGER");
  }
  for (const tbl of ["oauth_par", "oauth_code", "oauth_session"] as const) {
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(${tbl})`).all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has("login_step_up_at")) {
      db.exec(`ALTER TABLE ${tbl} ADD COLUMN login_step_up_at INTEGER`);
    }
  }
  return db;
}

/**
 * Deletes every row belonging to `groupDid` across all 39 tables in `SCHEMA_TABLE_CLASSIFICATION.GROUP_PURGED_TABLES`.
 * Caller MUST invoke inside an active transaction or under `withGroupRepoLock(groupDid, ...)`.
 */
export function purgeGroupDataSync(db: GroupHostDb, groupDid: string): void {
  const ownSpacePrefix = `at://${groupDid}/space/%`;
  db.prepare("DELETE FROM notify_registration WHERE group_did = ? OR space_uri LIKE ?").run(groupDid, ownSpacePrefix);
  db.prepare("DELETE FROM space_record_blob WHERE group_did = ? OR space_uri LIKE ?").run(groupDid, ownSpacePrefix);
  db.prepare("DELETE FROM space_record WHERE repo_did = ? OR space_uri LIKE ?").run(groupDid, ownSpacePrefix);
  db.prepare("DELETE FROM space_oplog WHERE repo_did = ? OR space_uri LIKE ?").run(groupDid, ownSpacePrefix);
  db.prepare("DELETE FROM space_repo WHERE repo_did = ? OR space_uri LIKE ?").run(groupDid, ownSpacePrefix);
  db.prepare("DELETE FROM space_writer WHERE group_did = ? OR space_uri LIKE ?").run(groupDid, ownSpacePrefix);
  db.prepare("DELETE FROM group_space WHERE group_did = ?").run(groupDid);
  db.prepare("DELETE FROM public_record_blob WHERE group_did = ?").run(groupDid);
  db.prepare("DELETE FROM public_record WHERE group_did = ?").run(groupDid);
  db.prepare("DELETE FROM public_repo_block WHERE group_did = ?").run(groupDid);
  db.prepare("DELETE FROM public_repo_root WHERE group_did = ?").run(groupDid);
  db.prepare("DELETE FROM blob_store WHERE group_did = ?").run(groupDid);
  db.prepare("DELETE FROM group_invite_target WHERE group_did = ?").run(groupDid);
  db.prepare("DELETE FROM invite_delivery WHERE group_did = ?").run(groupDid);
  db.prepare("DELETE FROM join_request WHERE group_did = ?").run(groupDid);
  db.prepare("DELETE FROM join_operation_state WHERE group_did = ?").run(groupDid);
  db.prepare("DELETE FROM mod_event WHERE group_did = ?").run(groupDid);
  db.prepare("DELETE FROM mod_subject WHERE group_did = ?").run(groupDid);
  db.prepare("DELETE FROM known_app_subject WHERE group_did = ?").run(groupDid);
  db.prepare("DELETE FROM issued_credential WHERE group_did = ?").run(groupDid);
  db.prepare("DELETE FROM revoked_credential WHERE group_did = ?").run(groupDid);
  db.prepare("DELETE FROM used_delegation_jti WHERE group_did = ?").run(groupDid);
  db.prepare("DELETE FROM used_attestation_jti WHERE group_did = ?").run(groupDid);
  db.prepare("DELETE FROM service_jwt_jti WHERE group_did = ?").run(groupDid);
  db.prepare("DELETE FROM group_action_token WHERE group_did = ?").run(groupDid);
  db.prepare("DELETE FROM source_migration_lease WHERE group_did = ?").run(groupDid);
  db.prepare("DELETE FROM migration_session WHERE group_did = ?").run(groupDid);
  db.prepare("DELETE FROM revoked_migration_jti WHERE group_did = ?").run(groupDid);
  db.prepare("DELETE FROM oauth_par WHERE group_did = ?").run(groupDid);
  db.prepare("DELETE FROM upstream_oauth_state WHERE group_did = ?").run(groupDid);
  db.prepare("DELETE FROM oauth_code WHERE group_did = ?").run(groupDid);
  db.prepare("DELETE FROM oauth_refresh_token WHERE group_did = ?").run(groupDid);
  db.prepare("DELETE FROM oauth_session WHERE group_did = ?").run(groupDid);
  db.prepare("DELETE FROM revoked_oauth_family WHERE group_did = ?").run(groupDid);
  db.prepare("DELETE FROM handle_reservation WHERE group_did = ?").run(groupDid);
  db.prepare("DELETE FROM group_recovery_admin WHERE group_did = ?").run(groupDid);
  db.prepare("DELETE FROM group_creation_journal WHERE group_did = ?").run(groupDid);
  db.prepare("DELETE FROM outbox_notice WHERE group_did = ?").run(groupDid);
  db.prepare("DELETE FROM group_account WHERE did = ?").run(groupDid);
}

/**
 * Purges un-cutover migration staging state for `groupDid` while preserving unexpired
 * `service_jwt_jti` replay/tombstone rows (`aborted-op:*`, `ticket:*`, and consumed service-JWT
 * JTIs) so tombstoned operation/ticket IDs and JTIs survive across staging and abort cycles.
 */
export function purgeMigrationStagingDataSync(db: GroupHostDb, groupDid: string, nowMs: number): void {
  const liveServiceJtis = db
    .prepare(
      "SELECT issuer_did, jti, group_did, expires_at FROM service_jwt_jti WHERE group_did = ? AND expires_at > ?",
    )
    .all(groupDid, nowMs) as Array<{
    issuer_did: string;
    jti: string;
    group_did: string;
    expires_at: number;
  }>;
  purgeGroupDataSync(db, groupDid);
  if (liveServiceJtis.length > 0) {
    const restoreStmt = db.prepare(
      "INSERT OR REPLACE INTO service_jwt_jti (issuer_did, jti, group_did, expires_at) VALUES (?, ?, ?, ?)",
    );
    for (const row of liveServiceJtis) {
      restoreStmt.run(row.issuer_did, row.jti, row.group_did, row.expires_at);
    }
  }
}

const DAY_MS = 86_400_000;

/**
 * Bounded `LIMIT 500` periodic and write-path expiry/retention sweep across credentials, JTIs,
 * OAuth state, creation journals, join queues, and terminal outbox rows.
 */
export function pruneExpiredHostState(db: GroupHostDb, nowMs = Date.now()): void {
  const nowSec = Math.floor(nowMs / 1000);
  const tx = db.transaction(() => {
    db.prepare(
      "DELETE FROM dpop_jti WHERE rowid IN (SELECT rowid FROM dpop_jti WHERE expires_at <= ? LIMIT 500)",
    ).run(nowMs);
    db.prepare(
      "DELETE FROM client_assertion_jti WHERE rowid IN (SELECT rowid FROM client_assertion_jti WHERE expires_at <= ? LIMIT 500)",
    ).run(nowMs);
    db.prepare(
      "DELETE FROM issued_credential WHERE rowid IN (SELECT rowid FROM issued_credential WHERE exp <= ? LIMIT 500)",
    ).run(nowSec);
    const pruneRevokedStmt = db.prepare(
      "DELETE FROM revoked_credential WHERE rowid IN (SELECT rowid FROM revoked_credential WHERE exp <= ? LIMIT 500)",
    );
    for (let i = 0; i < 20; i += 1) {
      if (pruneRevokedStmt.run(nowSec).changes < 500) break;
    }
    const pruneDelegationStmt = db.prepare(
      "DELETE FROM used_delegation_jti WHERE rowid IN (SELECT rowid FROM used_delegation_jti WHERE expires_at <= ? LIMIT 500)",
    );
    for (let i = 0; i < 20; i += 1) {
      if (pruneDelegationStmt.run(nowMs).changes < 500) break;
    }
    const pruneAttestationStmt = db.prepare(
      "DELETE FROM used_attestation_jti WHERE rowid IN (SELECT rowid FROM used_attestation_jti WHERE expires_at <= ? LIMIT 500)",
    );
    for (let i = 0; i < 20; i += 1) {
      if (pruneAttestationStmt.run(nowMs).changes < 500) break;
    }
    const pruneServiceJwtStmt = db.prepare(
      "DELETE FROM service_jwt_jti WHERE rowid IN (SELECT rowid FROM service_jwt_jti WHERE expires_at <= ? LIMIT 500)",
    );
    for (let i = 0; i < 20; i += 1) {
      if (pruneServiceJwtStmt.run(nowMs).changes < 500) break;
    }
    db.prepare(
      "DELETE FROM revoked_migration_jti WHERE rowid IN (SELECT rowid FROM revoked_migration_jti WHERE expires_at <= ? LIMIT 500)",
    ).run(nowMs);
    db.prepare(
      "DELETE FROM group_action_token WHERE rowid IN (SELECT rowid FROM group_action_token WHERE expires_at <= ? LIMIT 500)",
    ).run(nowMs);
    // Note: Unactivated (`activated = 0`) expired `migration_session` rows MUST NOT be purged
    // synchronously without reconciling PLC `/log/last` under `withGroupRepoLock`; they are
    // swept by `GroupMigrationService.sweepExpiredMigrationSessions` instead. Only stale
    // leftover rows on already-activated (`activated = 1`) accounts are cleaned here.
    db.prepare(
      `DELETE FROM migration_session
       WHERE plc_cutover_at IS NULL
         AND plc_submitting_at IS NULL
         AND pending_plc_op_cid IS NULL
         AND absolute_deadline_at <= ?
         AND group_did IN (SELECT did FROM group_account WHERE activated = 1)`,
    ).run(nowMs);
    db.prepare(
      "DELETE FROM oauth_par WHERE rowid IN (SELECT rowid FROM oauth_par WHERE expires_at <= ? LIMIT 500)",
    ).run(nowMs);
    db.prepare(
      "DELETE FROM upstream_oauth_state WHERE rowid IN (SELECT rowid FROM upstream_oauth_state WHERE expires_at <= ? LIMIT 500)",
    ).run(nowMs);
    db.prepare(
      "DELETE FROM oauth_code WHERE rowid IN (SELECT rowid FROM oauth_code WHERE expires_at <= ? LIMIT 500)",
    ).run(nowMs);
    db.prepare(
      "DELETE FROM oauth_refresh_token WHERE rowid IN (SELECT rowid FROM oauth_refresh_token WHERE expires_at <= ? LIMIT 500)",
    ).run(nowMs);
    db.prepare(
      "DELETE FROM oauth_session WHERE rowid IN (SELECT rowid FROM oauth_session WHERE expires_at <= ? LIMIT 500)",
    ).run(nowMs);
    db.prepare(
      "DELETE FROM revoked_oauth_family WHERE rowid IN (SELECT rowid FROM revoked_oauth_family WHERE expires_at <= ? LIMIT 500)",
    ).run(nowMs);
    db.prepare(
      "DELETE FROM join_request WHERE rowid IN (SELECT rowid FROM join_request WHERE expires_at <= ? LIMIT 500)",
    ).run(nowMs);
    db.prepare(
      "DELETE FROM join_operation_state WHERE rowid IN (SELECT rowid FROM join_operation_state WHERE expires_at <= ? LIMIT 500)",
    ).run(nowMs);
    db.prepare(
      `DELETE FROM outbox_notice
       WHERE rowid IN (
         SELECT rowid FROM outbox_notice
         WHERE status IN ('delivered', 'abandoned') AND created_at <= ?
         LIMIT 500
       )`,
    ).run(nowMs - DAY_MS);
    db.prepare(
      `UPDATE group_creation_journal
       SET status = 'completed', auth_code = NULL, updated_at = ?
       WHERE status = 'code_issued' AND code_expires_at IS NOT NULL AND code_expires_at <= ?`,
    ).run(nowMs, nowMs);
    db.prepare(
      `DELETE FROM group_creation_journal
       WHERE rowid IN (
         SELECT rowid FROM group_creation_journal
         WHERE status IN ('completed', 'compensated') AND updated_at <= ?
         LIMIT 500
       )`,
    ).run(nowMs - DAY_MS);
  });
  tx.immediate();
}
