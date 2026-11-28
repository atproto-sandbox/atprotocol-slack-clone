import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { P256Keypair } from "@atproto/crypto";
import { GroupHostCryptoBox } from "./crypto-box";
import {
  ATGRP_SCHEMA_VERSION,
  IncompatibleGroupHostSchemaError,
  openGroupHostDb,
  pruneExpiredHostState,
  purgeGroupDataSync,
  SCHEMA_TABLE_CLASSIFICATION,
  type GroupHostDb,
} from "./db";

const TEST_HEX_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function seedGroupRowsAcrossAll42Tables(db: GroupHostDb, groupDid: string, suffix: string, nowMs: number): void {
  const spaceUri = `at:space/${groupDid}/org.atgrp.meta/self`;
  const externalInviteSpace = `at:space/did:plc:invitee${suffix}/org.atgrp.inbox/self`;
  const nowSec = Math.floor(nowMs / 1000);
  const nowIso = new Date(nowMs).toISOString();

  db.prepare(
    `INSERT INTO group_account (did, handle, signing_key_enc, kem_key_enc, rotation_key_enc, activated, takendown, auth_epoch, created_at)
     VALUES (?, ?, 'enc-sig', 'enc-kem', 'enc-rot', 1, 0, 1, ?)`,
  ).run(groupDid, `team-${suffix}.groups.localhost`, nowMs);

  db.prepare("INSERT INTO handle_reservation (handle, group_did, created_at) VALUES (?, ?, ?)").run(
    `team-${suffix}.groups.localhost`,
    groupDid,
    nowMs,
  );
  db.prepare("INSERT INTO group_recovery_admin (group_did, recovery_did, roles_json, deactivated_at) VALUES (?, ?, ?, ?)").run(
    groupDid,
    `did:plc:admin${suffix}`,
    '["admin"]',
    nowMs,
  );
  db.prepare(
    `INSERT INTO group_creation_journal (
       initiator_did, client_id, creation_key, group_did, handle, display_name, join_policy, public_meta,
       genesis_op_json, status, created_at, updated_at
     ) VALUES (?, 'http://localhost', ?, ?, ?, 'Team', 'invite', 1, '{}', 'completed', ?, ?)`,
  ).run(`did:plc:admin${suffix}`, `ck-${suffix}`, groupDid, `team-${suffix}.groups.localhost`, nowMs, nowMs);

  db.prepare("INSERT INTO public_repo_root (group_did, commit_cid, rev, updated_at) VALUES (?, ?, '3jzfcijpj2z2a', ?)").run(
    groupDid,
    `cid-root-${suffix}`,
    nowMs,
  );
  db.prepare("INSERT INTO public_repo_block (group_did, cid, bytes, rev) VALUES (?, ?, ?, '3jzfcijpj2z2a')").run(
    groupDid,
    `cid-blk-${suffix}`,
    Buffer.from([1, 2, 3]),
  );
  db.prepare(
    `INSERT INTO public_record (group_did, collection, rkey, uri, cid, value, rev, indexed_at)
     VALUES (?, 'org.atgrp.declaration', 'self', ?, ?, '{}', '3jzfcijpj2z2a', ?)`,
  ).run(groupDid, `at://${groupDid}/org.atgrp.declaration/self`, `cid-rec-${suffix}`, nowMs);
  db.prepare("INSERT INTO public_record_blob (group_did, record_uri, blob_cid) VALUES (?, ?, ?)").run(
    groupDid,
    `at://${groupDid}/org.atgrp.declaration/self`,
    `blob-${suffix}`,
  );
  db.prepare(
    `INSERT INTO blob_store (group_did, cid, mime_type, size, bytes, permanent, quarantined, created_at)
     VALUES (?, ?, 'image/png', 3, ?, 1, 0, ?)`,
  ).run(groupDid, `blob-${suffix}`, Buffer.from([7, 8, 9]), nowMs);

  db.prepare(
    `INSERT INTO group_space (space_uri, group_did, space_type, skey, policy_json, space_rev, created_at, updated_at)
     VALUES (?, ?, 'org.atgrp.meta', 'self', '{}', '3jzfcijpj2z2a', ?, ?)`,
  ).run(spaceUri, groupDid, nowMs, nowMs);

  db.prepare(
    `INSERT INTO space_writer (space_uri, group_did, writer_did, removed, repo_rev, space_rev, updated_at)
     VALUES (?, ?, ?, 0, '3jzfcijpj2z2a', '3jzfcijpj2z2a', ?)`,
  ).run(spaceUri, groupDid, groupDid, nowMs);

  db.prepare("INSERT INTO space_repo (space_uri, repo_did, set_hash, rev) VALUES (?, ?, ?, '3jzfcijpj2z2a')").run(
    spaceUri,
    groupDid,
    Buffer.alloc(32),
  );
  db.prepare("INSERT INTO space_repo (space_uri, repo_did, set_hash, rev) VALUES (?, ?, ?, '3jzfcijpj2z2a')").run(
    externalInviteSpace,
    groupDid,
    Buffer.alloc(32),
  );

  const recUri = `${spaceUri}/${groupDid}/org.atgrp.about/self`;
  db.prepare(
    `INSERT INTO space_record (space_uri, repo_did, collection, rkey, uri, cid, value, cbor_bytes, repo_rev, indexed_at)
     VALUES (?, ?, 'org.atgrp.about', 'self', ?, ?, '{}', ?, '3jzfcijpj2z2a', ?)`,
  ).run(spaceUri, groupDid, recUri, `cid-prof-${suffix}`, Buffer.from([0xa0]), nowMs);

  db.prepare(
    `INSERT INTO space_oplog (space_uri, repo_did, rev, idx, action, uri, collection, rkey, cid, prev)
     VALUES (?, ?, '3jzfcijpj2z2a', 0, 'create', ?, 'org.atgrp.about', 'self', ?, NULL)`,
  ).run(spaceUri, groupDid, recUri, `cid-prof-${suffix}`);

  db.prepare("INSERT INTO space_record_blob (group_did, space_uri, record_uri, blob_cid) VALUES (?, ?, ?, ?)").run(
    groupDid,
    spaceUri,
    recUri,
    `blob-${suffix}`,
  );

  db.prepare(
    `INSERT INTO notify_registration (space_uri, group_did, endpoint, token, expires_at, lapsed_notified, updated_at)
     VALUES (?, ?, 'http://127.0.0.1:3001/webhook', ?, ?, 0, ?)`,
  ).run(spaceUri, groupDid, `tok-${suffix}`, nowMs + 600_000, nowMs);

  db.prepare("INSERT INTO group_invite_target (group_did, space_uri, invitee_did) VALUES (?, ?, ?)").run(
    groupDid,
    externalInviteSpace,
    `did:plc:invitee${suffix}`,
  );

  db.prepare(
    `INSERT INTO invite_delivery (group_did, invite_uri, space_uri, invitee_did, rkey, repo_rev, status, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, '3jzfcijpj2z2a', '3jzfcijpj2z2a', 'delivered', 1, ?, ?)`,
  ).run(
    groupDid,
    `${externalInviteSpace}/${groupDid}/org.atgrp.invite/3jzfcijpj2z2a`,
    externalInviteSpace,
    `did:plc:invitee${suffix}`,
    nowMs,
    nowMs,
  );

  db.prepare(
    `INSERT INTO join_request (group_did, requester_did, message, created_at, expires_at)
     VALUES (?, ?, 'hi', ?, ?)`,
  ).run(groupDid, `did:plc:req${suffix}`, nowIso, nowMs + 86_400_000);

  db.prepare(
    `INSERT INTO join_operation_state (group_did, requester_did, operation_id, request_hash, state, response_json, expires_at, updated_at)
     VALUES (?, ?, ?, 'hash', 'pending', '{}', ?, ?)`,
  ).run(groupDid, `did:plc:req${suffix}`, `op-${suffix}`, nowMs + 86_400_000, nowMs);

  db.prepare(
    `INSERT INTO mod_subject (group_did, subject, cid_key, status, report_count, created_at, updated_at)
     VALUES (?, ?, '', 'open', 1, ?, ?)`,
  ).run(groupDid, groupDid, nowIso, nowIso);

  db.prepare(
    `INSERT INTO mod_subject_tag (group_did, subject, cid_key, tag)
     VALUES (?, ?, '', 'escalated')`,
  ).run(groupDid, groupDid);

  db.prepare(
    `INSERT INTO mod_ejection_eligibility (group_did, member_did, ejected_at)
     VALUES (?, ?, ?)`,
  ).run(groupDid, `did:plc:ejected${suffix}`, nowIso);

  db.prepare(
    `INSERT INTO mod_event (group_did, subject, cid_key, subject_owner_did, is_self_visible, created_at, created_by, event_json)
     VALUES (?, ?, '', ?, 0, ?, ?, '{}')`,
  ).run(groupDid, groupDid, groupDid, nowIso, `did:plc:admin${suffix}`);

  db.prepare("INSERT INTO known_app_subject (group_did, subject_did, created_at) VALUES (?, ?, ?)").run(
    groupDid,
    `did:plc:bot${suffix}`,
    nowMs,
  );

  db.prepare(
    `INSERT INTO issued_credential (jti, group_did, space_uri, writer_did, cnf_kid, exp, created_at)
     VALUES (?, ?, ?, ?, 'did:key:zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169', ?, ?)`,
  ).run(`ic-${suffix}`, groupDid, spaceUri, `did:plc:admin${suffix}`, nowSec + 600, nowMs);

  db.prepare("INSERT INTO revoked_credential (jti, group_did, space_uri, exp, revoked_at) VALUES (?, ?, ?, ?, ?)").run(
    `rc-${suffix}`,
    groupDid,
    spaceUri,
    nowSec + 600,
    nowMs,
  );

  db.prepare(
    "INSERT INTO used_delegation_jti (issuer_did, jti, group_did, expires_at) VALUES (?, ?, ?, ?)",
  ).run(
    `did:plc:member${suffix}`,
    `ud-${suffix}`,
    groupDid,
    nowMs + 60_000,
  );
  db.prepare(
    "INSERT INTO used_attestation_jti (client_id, jti, group_did, expires_at) VALUES (?, ?, ?, ?)",
  ).run(
    `https://app-${suffix}.example/client-metadata.json`,
    `ua-${suffix}`,
    groupDid,
    nowMs + 60_000,
  );
  db.prepare("INSERT INTO service_jwt_jti (issuer_did, jti, group_did, expires_at) VALUES (?, ?, ?, ?)").run(
    `did:plc:admin${suffix}`,
    `sj-${suffix}`,
    groupDid,
    nowMs + 60_000,
  );
  db.prepare(
    `INSERT INTO group_action_token (token_hash, group_did, actor_did, purpose, claim_ciphertext_enc, expires_at, created_at)
     VALUES (?, ?, ?, 'delete_account', 'enc', ?, ?)`,
  ).run(`at-${suffix}`, groupDid, `did:plc:admin${suffix}`, nowMs + 600_000, nowMs);

  db.prepare(
    `INSERT INTO source_migration_lease (
       group_did, operation_id, mode, target_service_did, target_endpoint, status, frozen_at, deadline_at, expires_at, manifest_digest, root_manifest_json
     ) VALUES (?, ?, 'coordinated', 'did:web:target', 'https://target.example', 'prepared', ?, ?, ?, 'dig', '{}')`,
  ).run(groupDid, `mig-${suffix}`, nowMs, nowMs + 3_600_000, nowMs + 900_000);

  db.prepare(
    `INSERT INTO migration_session (
       id, group_did, mode, source_endpoint, source_plc_rotation_keys_json, preserved_sovereign_keys_json,
       access_jti, refresh_jti, auth_epoch, absolute_deadline_at, created_at
     ) VALUES (?, ?, 'standard', 'https://source.example', '[]', '[]', ?, ?, 1, ?, ?)`,
  ).run(`ms-${suffix}`, groupDid, `aj-${suffix}`, `rj-${suffix}`, nowMs + 3_600_000, nowMs);

  db.prepare("INSERT INTO revoked_migration_jti (jti, group_did, expires_at) VALUES (?, ?, ?)").run(
    `rmj-${suffix}`,
    groupDid,
    nowMs + 3_600_000,
  );

  db.prepare(
    `INSERT INTO oauth_par (
       request_uri, group_did, client_id, redirect_uri, response_mode, scope, code_challenge, dpop_jkt, expires_at, created_at
     ) VALUES (?, ?, 'http://localhost', 'http://127.0.0.1/cb', 'query', 'atproto', 'cc', 'jkt', ?, ?)`,
  ).run(`urn:par:${suffix}`, groupDid, nowMs + 60_000, nowMs);

  db.prepare(
    `INSERT INTO oauth_consent_snapshot (
       snapshot_id, par_request_uri, group_did, authorizing_user_did, reviewed_scope, created_at, expires_at, consumed_at
     ) VALUES (?, ?, ?, ?, 'atproto', ?, ?, NULL)`,
  ).run(`snap-${suffix}`, `urn:par:${suffix}`, groupDid, `did:plc:admin${suffix}`, nowMs, nowMs + 60_000);

  db.prepare(
    `INSERT INTO upstream_oauth_state (state, group_did, par_request_uri, app_state, payload_enc, expires_at, created_at)
     VALUES (?, ?, ?, 'st', 'enc', ?, ?)`,
  ).run(`ust-${suffix}`, groupDid, `urn:par:${suffix}`, nowMs + 60_000, nowMs);

  db.prepare(
    `INSERT INTO oauth_code (
       code_hash, family_id, group_did, authorizing_user_did, client_id, redirect_uri,
       approved_scope, code_challenge, dpop_jkt, session_kind, authenticated_at, expires_at, created_at
     ) VALUES (?, ?, ?, ?, 'http://localhost', 'http://127.0.0.1/cb', 'atproto', 'cc', 'jkt', 'group', ?, ?, ?)`,
  ).run(`ch-${suffix}`, `fam-${suffix}`, groupDid, `did:plc:admin${suffix}`, nowMs, nowMs + 300_000, nowMs);

  db.prepare(
    `INSERT INTO oauth_session (
       session_id, family_id, group_did, authorizing_user_did, client_id, approved_scope, dpop_jkt,
       session_kind, auth_epoch, authenticated_at, expires_at, created_at
     ) VALUES (?, ?, ?, ?, 'http://localhost', 'atproto', 'jkt', 'group', 1, ?, ?, ?)`,
  ).run(`sess-${suffix}`, `fam-${suffix}`, groupDid, `did:plc:admin${suffix}`, nowMs, nowMs + 3_600_000, nowMs);

  db.prepare(
    `INSERT INTO oauth_refresh_token (token_hash, session_id, family_id, group_did, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(`rt-${suffix}`, `sess-${suffix}`, `fam-${suffix}`, groupDid, nowMs + 86_400_000, nowMs);

  db.prepare("INSERT INTO revoked_oauth_family (family_id, group_did, expires_at, revoked_at) VALUES (?, ?, ?, ?)").run(
    `rfam-${suffix}`,
    groupDid,
    nowMs + 86_400_000,
    nowMs,
  );

  db.prepare(
    `INSERT INTO outbox_notice (
       id, kind, group_did, endpoint, payload_json, status, next_attempt_at, expires_at, created_at
     ) VALUES (?, 'syncer_update', ?, 'http://127.0.0.1:3001/webhook', '{}', 'pending', ?, ?, ?)`,
  ).run(`ob-${suffix}`, groupDid, nowMs, nowMs + 3_600_000, nowMs);
}

test("openGroupHostDb enforces 0o600 permissions, WAL mode, host_meta version, and exact 46-table SCHEMA_TABLE_CLASSIFICATION completeness", () => {
  const dir = mkdtempSync(join(tmpdir(), "gh-db-test-"));
  try {
    const dbPath = join(dir, "nested", "group-host.db");
    const db = openGroupHostDb(dbPath);
    try {
      const mode = statSync(dbPath).mode & 0o777;
      assert.equal(mode, 0o600, "SQLite database file must have 0o600 permissions");
      assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
      assert.equal(db.pragma("foreign_keys", { simple: true }), 1);

      const ver = db
        .prepare("SELECT value FROM host_meta WHERE key = 'atgrp_schema_version'")
        .get() as { value: string } | undefined;
      assert.equal(ver?.value, ATGRP_SCHEMA_VERSION);

      const liveTables = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC")
          .all() as Array<{ name: string }>
      ).map((r) => r.name);

      assert.equal(SCHEMA_TABLE_CLASSIFICATION.GROUP_PURGED_TABLES.length, 42);
      assert.equal(SCHEMA_TABLE_CLASSIFICATION.RETAINED_TOMBSTONE_TABLES.length, 1);
      assert.equal(SCHEMA_TABLE_CLASSIFICATION.GLOBAL_TTL_TABLES.length, 2);
      assert.equal(SCHEMA_TABLE_CLASSIFICATION.GLOBAL_TABLES.length, 1);

      const classified = [
        ...SCHEMA_TABLE_CLASSIFICATION.GROUP_PURGED_TABLES,
        ...SCHEMA_TABLE_CLASSIFICATION.RETAINED_TOMBSTONE_TABLES,
        ...SCHEMA_TABLE_CLASSIFICATION.GLOBAL_TTL_TABLES,
        ...SCHEMA_TABLE_CLASSIFICATION.GLOBAL_TABLES,
      ];
      assert.equal(new Set(classified).size, 46, "Classification buckets must be pairwise disjoint");
      assert.deepEqual([...classified].sort(), liveTables, "Every SQLite table must be classified 1-for-1");
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openGroupHostDb read-only pre-open probe fails closed on legacy R14 DBs leaving file byte-identical with zero -wal/-shm sidecars", () => {
  const dir = mkdtempSync(join(tmpdir(), "gh-legacy-probe-"));
  try {
    const legacyPath = join(dir, "legacy-r14.db");
    const legacy = new Database(legacyPath);
    legacy.exec("CREATE TABLE group_account (did TEXT PRIMARY KEY);");
    legacy.close();

    const beforeBytes = readFileSync(legacyPath);
    const beforeSha = createHash("sha256").update(beforeBytes).digest("hex");
    const beforeMtimeMs = statSync(legacyPath).mtimeMs;

    assert.throws(
      () => openGroupHostDb(legacyPath),
      (err: unknown) => err instanceof IncompatibleGroupHostSchemaError,
    );

    const afterBytes = readFileSync(legacyPath);
    const afterSha = createHash("sha256").update(afterBytes).digest("hex");
    const afterMtimeMs = statSync(legacyPath).mtimeMs;
    assert.equal(afterSha, beforeSha, "legacy DB file must remain byte-identical");
    assert.equal(afterMtimeMs, beforeMtimeMs, "legacy DB mtime must remain untouched");
    assert.equal(existsSync(`${legacyPath}-wal`), false, "must not create -wal sidecar");
    assert.equal(existsSync(`${legacyPath}-shm`), false, "must not create -shm sidecar");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GroupHostCryptoBox binds AES-256-GCM AAD, derives valid P-256 service keys, and rotates DPoP nonces", async () => {
  const box = new GroupHostCryptoBox(TEST_HEX_KEY);
  const ct = box.encryptColumn("group_account", "did:plc:grp1", "signing_key_enc", "secret-scalar");
  assert.equal(box.decryptColumnUtf8("group_account", "did:plc:grp1", "signing_key_enc", ct), "secret-scalar");

  assert.throws(() => box.decryptColumnUtf8("group_account", "did:plc:grp2", "signing_key_enc", ct));
  assert.throws(() => box.decryptColumnUtf8("group_account", "did:plc:grp1", "kem_key_enc", ct));
  assert.throws(() => box.decryptColumnUtf8("other_table", "did:plc:grp1", "signing_key_enc", ct));

  const kp = await P256Keypair.create({ exportable: true });
  const kpEnc = await box.encryptKeypair("group_account", "did:plc:grp1", "rotation_key_enc", kp);
  const kpDec = await box.decryptKeypair("group_account", "did:plc:grp1", "rotation_key_enc", kpEnc);
  assert.equal(kpDec.did(), kp.did());

  const mat = await box.deriveServiceSigningMaterial("did:web:groups.example");
  assert.equal(mat.activeKidFragment, "#atproto");
  assert.equal(mat.verificationMethods.length, 1);
  assert.equal(mat.publicJwks.length, 1);

  const t0 = 1_700_000_000_000;
  const nonce = box.createDpopNonce(t0);
  assert.equal(box.verifyDpopNonce(nonce, t0), true);
  assert.equal(box.verifyDpopNonce(nonce, t0 + 110_000), true);
  assert.equal(box.verifyDpopNonce(nonce, t0 + 240_000), false, "Expired bucket must be rejected");
  assert.equal(box.verifyDpopNonce(nonce, t0 - 65_000), false, "Future bucket must be rejected");
  assert.equal(box.verifyDpopNonce(`${nonce}x`, t0), false);

  const signedCookie = box.signCookiePayload("gh_oauth", JSON.stringify({ csrf: "abc" }));
  assert.deepEqual(box.verifyCookiePayload<{ csrf: string }>("gh_oauth", signedCookie), { csrf: "abc" });
  assert.equal(box.verifyCookiePayload("wrong_purpose", signedCookie), null);
});

test("purgeGroupDataSync leaves zero residue across all 42 GROUP_PURGED_TABLES while preserving sibling groups and global host_meta", () => {
  const db = openGroupHostDb(":memory:");
  try {
    const nowMs = 1_700_000_000_000;
    const g1 = "did:plc:group1111111111111111111";
    const g2 = "did:plc:group2222222222222222222";
    seedGroupRowsAcrossAll42Tables(db, g1, "one", nowMs);
    seedGroupRowsAcrossAll42Tables(db, g2, "two", nowMs);

    // Verify all 42 tables initially contain >= 1 row for both groups
    for (const tbl of SCHEMA_TABLE_CLASSIFICATION.GROUP_PURGED_TABLES) {
      const total = (db.prepare(`SELECT COUNT(*) AS cnt FROM ${tbl}`).get() as { cnt: number }).cnt;
      assert.ok(total >= 2, `Expected seeded rows in ${tbl}, got ${total}`);
    }

    db.prepare(
      "INSERT INTO group_deletion_journal (group_did, actor_did, plc_outcome, status, updated_at) VALUES (?, ?, 'tombstoned', 'purged', ?)",
    ).run(g1, "did:plc:adminone", nowMs);

    db.transaction(() => {
      purgeGroupDataSync(db, g1);
    }).immediate();

    // Verify every one of the 42 GROUP_PURGED_TABLES has 0 rows for g1 and still has its rows for g2!
    for (const tbl of SCHEMA_TABLE_CLASSIFICATION.GROUP_PURGED_TABLES) {
      const rows = db.prepare(`SELECT * FROM ${tbl}`).all() as Array<Record<string, unknown>>;
      assert.ok(rows.length >= 1, `Sibling group rows must survive in ${tbl}`);
      const serialized = JSON.stringify(rows);
      assert.equal(serialized.includes(g1), false, `Table ${tbl} leaked purged group ${g1}: ${serialized}`);
      assert.equal(serialized.includes("team-one"), false, `Table ${tbl} leaked purged handle in ${serialized}`);
    }

    const hostMetaVer = db
      .prepare("SELECT value FROM host_meta WHERE key = 'atgrp_schema_version'")
      .get() as { value: string } | undefined;
    assert.equal(hostMetaVer?.value, ATGRP_SCHEMA_VERSION, "host_meta must survive group purge");

    const retained = db
      .prepare("SELECT status, plc_outcome FROM group_deletion_journal WHERE group_did = ?")
      .get(g1) as { status: string; plc_outcome: string } | undefined;
    assert.deepEqual(retained, { status: "purged", plc_outcome: "tombstoned" });
  } finally {
    db.close();
  }
});

test("pruneExpiredHostState bounds sweeps to LIMIT 500 and preserves unexpired and post-PLC migration rows", () => {
  const db = openGroupHostDb(":memory:");
  try {
    const nowMs = 1_700_000_000_000;
    const nowSec = Math.floor(nowMs / 1000);

    const insDpop = db.prepare("INSERT INTO dpop_jti (jkt, jti, expires_at) VALUES ('jkt', ?, ?)");
    db.transaction(() => {
      for (let i = 0; i < 620; i += 1) {
        insDpop.run(`exp-${i}`, nowMs - 1_000);
      }
      insDpop.run("live-1", nowMs + 60_000);
    })();

    db.prepare(
      "INSERT INTO issued_credential (jti, group_did, space_uri, writer_did, cnf_kid, exp, created_at) VALUES ('ic-exp', 'did:plc:g', 'at:space/did:plc:g/org.atgrp.meta/self', 'did:plc:u', 'did:key:z1', ?, ?)",
    ).run(nowSec - 1, nowMs - 600_000);
    db.prepare(
      "INSERT INTO issued_credential (jti, group_did, space_uri, writer_did, cnf_kid, exp, created_at) VALUES ('ic-live', 'did:plc:g', 'at:space/did:plc:g/org.atgrp.meta/self', 'did:plc:u', 'did:key:z1', ?, ?)",
    ).run(nowSec + 60, nowMs);

    db.prepare(
      "INSERT INTO revoked_credential (jti, group_did, space_uri, exp, revoked_at) VALUES ('rc-exp', 'did:plc:g', 'at:space/did:plc:g/org.atgrp.meta/self', ?, ?)",
    ).run(nowSec - 5, nowMs - 60_000);
    db.prepare(
      "INSERT INTO revoked_credential (jti, group_did, space_uri, exp, revoked_at) VALUES ('rc-live', 'did:plc:g', 'at:space/did:plc:g/org.atgrp.meta/self', ?, ?)",
    ).run(nowSec + 60, nowMs);

    db.prepare(
      `INSERT INTO outbox_notice (id, kind, group_did, endpoint, payload_json, status, next_attempt_at, expires_at, created_at)
       VALUES ('ob-old-del', 'syncer_update', 'did:plc:g', 'http://127.0.0.1', '{}', 'delivered', ?, ?, ?)`,
    ).run(nowMs - 90_000_000, nowMs, nowMs - 90_000_000);
    db.prepare(
      `INSERT INTO outbox_notice (id, kind, group_did, endpoint, payload_json, status, next_attempt_at, expires_at, created_at)
       VALUES ('ob-pending', 'syncer_update', 'did:plc:g', 'http://127.0.0.1', '{}', 'pending', ?, ?, ?)`,
    ).run(nowMs - 90_000_000, nowMs + 60_000, nowMs - 90_000_000);

    // Post-PLC-cutover migration_session must NEVER be pruned even past absolute_deadline_at!
    db.prepare(
      `INSERT INTO migration_session (
         id, group_did, mode, source_endpoint, source_plc_rotation_keys_json, preserved_sovereign_keys_json,
         access_jti, refresh_jti, auth_epoch, plc_cutover_at, absolute_deadline_at, created_at
       ) VALUES ('ms-cutover', 'did:plc:g', 'standard', 'https://src.example', '[]', '[]', 'aj', 'rj', 1, ?, ?, ?)`,
    ).run(nowMs - 10_000, nowMs - 5_000, nowMs - 20_000);

    pruneExpiredHostState(db, nowMs);

    const dpopAfterFirst = (db.prepare("SELECT COUNT(*) AS cnt FROM dpop_jti").get() as { cnt: number }).cnt;
    assert.equal(dpopAfterFirst, 121, "First bounded pass must delete at most 500 expired dpop_jti rows");

    pruneExpiredHostState(db, nowMs);
    const dpopAfterSecond = (db.prepare("SELECT jti FROM dpop_jti").all() as Array<{ jti: string }>).map((r) => r.jti);
    assert.deepEqual(dpopAfterSecond, ["live-1"]);

    const issuedRemaining = (db.prepare("SELECT jti FROM issued_credential").all() as Array<{ jti: string }>).map((r) => r.jti);
    assert.deepEqual(issuedRemaining, ["ic-live"]);
    const revokedRemaining = (db.prepare("SELECT jti FROM revoked_credential").all() as Array<{ jti: string }>).map((r) => r.jti);
    assert.deepEqual(revokedRemaining, ["rc-live"]);
    const outboxRemaining = (db.prepare("SELECT id FROM outbox_notice").all() as Array<{ id: string }>).map((r) => r.id);
    assert.deepEqual(outboxRemaining, ["ob-pending"]);

    const cutoverRemaining = db.prepare("SELECT id FROM migration_session WHERE id = 'ms-cutover'").get();
    assert.ok(cutoverRemaining, "Post-PLC-cutover migration_session must survive pruneExpiredHostState");
  } finally {
    db.close();
  }
});

test("pruneExpiredHostState preserves unactivated expired migration_session rows for PLC-reconciling sweeper while cleaning leftover rows on already-activated accounts", () => {
  const db = openGroupHostDb(":memory:");
  try {
    const nowMs = 1_700_000_000_000;
    const unactivatedDid = "did:plc:abandonedstage1234567890";
    const activatedLeftoverDid = "did:plc:activatedstage1234567890";

    db.prepare(
      `INSERT INTO group_account (did, handle, signing_key_enc, kem_key_enc, rotation_key_enc, activated, takendown, auth_epoch, created_at)
       VALUES (?, 'abandoned.groups.localhost', 'sig', 'kem', 'rot', 0, 0, 1, ?)`,
    ).run(unactivatedDid, nowMs - 7_200_000);
    db.prepare("INSERT INTO handle_reservation (handle, group_did, created_at) VALUES (?, ?, ?)").run(
      "abandoned.groups.localhost",
      unactivatedDid,
      nowMs - 7_200_000,
    );
    db.prepare(
      `INSERT INTO migration_session (
         id, group_did, mode, source_endpoint, source_plc_rotation_keys_json, preserved_sovereign_keys_json,
         access_jti, refresh_jti, auth_epoch, plc_cutover_at, absolute_deadline_at, created_at
       ) VALUES ('ms-abandoned', ?, 'standard', 'https://src.example', '[]', '[]', 'aj-ab', 'rj-ab', 1, NULL, ?, ?)`,
    ).run(unactivatedDid, nowMs - 1_000, nowMs - 7_200_000);

    db.prepare(
      `INSERT INTO group_account (did, handle, signing_key_enc, kem_key_enc, rotation_key_enc, activated, takendown, auth_epoch, created_at)
       VALUES (?, 'activated.groups.localhost', 'sig2', 'kem2', 'rot2', 1, 0, 1, ?)`,
    ).run(activatedLeftoverDid, nowMs - 7_200_000);
    db.prepare(
      `INSERT INTO migration_session (
         id, group_did, mode, source_endpoint, source_plc_rotation_keys_json, preserved_sovereign_keys_json,
         access_jti, refresh_jti, auth_epoch, plc_cutover_at, absolute_deadline_at, created_at
       ) VALUES ('ms-act-leftover', ?, 'standard', 'https://src.example', '[]', '[]', 'aj-act', 'rj-act', 1, NULL, ?, ?)`,
    ).run(activatedLeftoverDid, nowMs - 1_000, nowMs - 7_200_000);

    // Prepared source_migration_lease must NOT be deleted by pruneExpiredHostState before sweepExpiredPreparedMigrationLeases runs
    db.prepare(
      `INSERT INTO source_migration_lease (
         group_did, operation_id, mode, ticket_id, ticket_secret_hash, ticket_secret_enc,
         target_service_did, target_endpoint, status, signed_plc_op_json,
         frozen_at, deadline_at, expires_at, manifest_digest, root_manifest_json
       ) VALUES ('did:plc:srcleased123456789012345', 'op-1', 'coordinated', 't-1', 'h', 'e', 'did:web:target.example', 'https://target.example', 'prepared', NULL, ?, ?, ?, 'dig', '{}')`,
    ).run(nowMs - 7_200_000, nowMs - 1_000, nowMs - 1_000);

    pruneExpiredHostState(db, nowMs);

    assert.ok(
      db.prepare("SELECT 1 FROM group_account WHERE did = ?").get(unactivatedDid),
      "Unactivated staging group_account must NOT be purged by synchronous pruneExpiredHostState without PLC reconciliation",
    );
    assert.ok(
      db.prepare("SELECT 1 FROM migration_session WHERE id = 'ms-abandoned'").get(),
      "Unactivated expired migration_session must be left for GroupMigrationService.sweepExpiredMigrationSessions PLC reconciliation",
    );
    assert.equal(
      db.prepare("SELECT 1 FROM migration_session WHERE id = 'ms-act-leftover'").get(),
      undefined,
      "Leftover expired migration_session on an already-activated account is cleaned safely",
    );
    assert.ok(
      db.prepare("SELECT 1 FROM source_migration_lease WHERE group_did = 'did:plc:srcleased123456789012345'").get(),
      "Prepared source_migration_lease must survive pruneExpiredHostState so sweeper can send target abort",
    );
  } finally {
    db.close();
  }
});

test("EXPLAIN QUERY PLAN uses composite indexes without full-table SCAN on all hot Group Host queries", () => {
  const db = openGroupHostDb(":memory:");
  try {
    const queries: Array<{ label: string; sql: string; params: unknown[] }> = [
      {
        label: "space_record collection listing",
        sql: "SELECT rkey, cid, value FROM space_record WHERE space_uri = ? AND repo_did = ? AND collection = ? AND rkey > ? ORDER BY rkey ASC LIMIT 50",
        params: ["at:space/did:plc:g/new.flock.channel/general", "did:plc:u", "new.flock.message", ""],
      },
      {
        label: "space_oplog cursor replay",
        sql: "SELECT rev, idx, action, uri FROM space_oplog WHERE space_uri = ? AND repo_did = ? AND (rev > ? OR (rev = ? AND idx > ?)) ORDER BY rev ASC, idx ASC LIMIT 50",
        params: ["at:space/did:plc:g/new.flock.channel/general", "did:plc:u", "3jzfcijpj2z2a", "3jzfcijpj2z2a", 0],
      },
      {
        label: "space_writer listWriters",
        sql: "SELECT writer_did, space_rev FROM space_writer WHERE space_uri = ? AND space_rev > ? ORDER BY space_rev ASC",
        params: ["at:space/did:plc:g/new.flock.channel/general", ""],
      },
      {
        label: "notify_registration fanout",
        sql: "SELECT endpoint, token FROM notify_registration WHERE space_uri = ? AND expires_at > ?",
        params: ["at:space/did:plc:g/new.flock.channel/general", 1_700_000_000_000],
      },
      {
        label: "outbox_notice due queue",
        sql: "SELECT id FROM outbox_notice WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at ASC LIMIT 25",
        params: [1_700_000_000_000],
      },
      {
        label: "mod_subject oldest unfiltered",
        sql: "SELECT subject, cid_key FROM mod_subject WHERE group_did = ? ORDER BY created_at ASC, subject ASC, cid_key ASC LIMIT 50",
        params: ["did:plc:g"],
      },
      {
        label: "mod_subject newest status-filtered",
        sql: "SELECT subject, cid_key FROM mod_subject WHERE group_did = ? AND status = ? ORDER BY created_at DESC, subject DESC, cid_key DESC LIMIT 50",
        params: ["did:plc:g", "open"],
      },
      {
        label: "mod_subject updated unfiltered",
        sql: "SELECT subject, cid_key FROM mod_subject WHERE group_did = ? ORDER BY updated_at DESC, subject ASC, cid_key ASC LIMIT 50",
        params: ["did:plc:g"],
      },
      {
        label: "mod_subject updated status-filtered with EXISTS tag filter",
        sql: "SELECT m.subject, m.cid_key FROM mod_subject m WHERE m.group_did = ? AND m.status = ? AND EXISTS (SELECT 1 FROM mod_subject_tag t WHERE t.group_did = m.group_did AND t.subject = m.subject AND t.cid_key = m.cid_key AND t.tag IN (?)) ORDER BY m.updated_at DESC, m.subject ASC, m.cid_key ASC LIMIT 50",
        params: ["did:plc:g", "open", "escalated"],
      },
      {
        label: "mod_event subject history unfiltered",
        sql: "SELECT seq, event_json FROM mod_event WHERE group_did = ? AND subject = ? ORDER BY seq DESC LIMIT 50",
        params: ["did:plc:g", "did:plc:u"],
      },
      {
        label: "mod_event subject history cid-filtered",
        sql: "SELECT seq, event_json FROM mod_event WHERE group_did = ? AND subject = ? AND cid_key = ? AND seq < ? ORDER BY seq DESC LIMIT 50",
        params: ["did:plc:g", "did:plc:u", "", 100],
      },
      {
        label: "mod_event self history unfiltered",
        sql: "SELECT seq, event_json FROM mod_event WHERE group_did = ? AND subject_owner_did = ? AND is_self_visible = 1 ORDER BY seq DESC LIMIT 50",
        params: ["did:plc:g", "did:plc:u"],
      },
      {
        label: "mod_event self history subject-filtered",
        sql: "SELECT seq, event_json FROM mod_event WHERE group_did = ? AND subject_owner_did = ? AND is_self_visible = 1 AND subject = ? ORDER BY seq ASC LIMIT 50",
        params: ["did:plc:g", "did:plc:u", "did:plc:u"],
      },
      {
        label: "join_request cursor pagination",
        sql: "SELECT requester_did, created_at FROM join_request WHERE group_did = ? ORDER BY created_at ASC, requester_did ASC LIMIT 50",
        params: ["did:plc:g"],
      },
      {
        label: "dpop_jti expiry sweep",
        sql: "SELECT rowid FROM dpop_jti WHERE expires_at <= ? LIMIT 500",
        params: [1_700_000_000_000],
      },
    ];

    for (const q of queries) {
      const planRows = db.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...q.params) as Array<{ detail: string }>;
      const details = planRows.map((r) => r.detail).join(" | ");
      assert.match(details, /SEARCH .* USING (?:COVERING )?INDEX/, `${q.label} must use an index, got: ${details}`);
      assert.doesNotMatch(details, /\bSCAN\b/, `${q.label} must not full-scan, got: ${details}`);
      assert.doesNotMatch(details, /USE TEMP B-TREE/, `${q.label} must not require a temp B-tree sort, got: ${details}`);
    }
  } finally {
    db.close();
  }
});

test("pruneExpiredHostState sweeps up to 10,000 expired revoked_credential and service_jwt_jti rows per sweep and isolates revoked_credential by (group_did, space_uri, jti)", () => {
  const db = openGroupHostDb(":memory:");
  try {
    const nowMs = 1_750_000_000_000;
    const nowSec = Math.floor(nowMs / 1000);

    // 1. Same credential JTI across two distinct spaces/groups does not collide or overwrite
    const insertRev = db.prepare(
      "INSERT INTO revoked_credential (jti, group_did, space_uri, exp, revoked_at) VALUES (?, ?, ?, ?, ?)",
    );
    insertRev.run("shared-jti", "did:plc:g1", "at:space/did:plc:g1/org.atgrp.meta/self", nowSec + 300, nowMs);
    insertRev.run("shared-jti", "did:plc:g2", "at:space/did:plc:g2/org.atgrp.meta/self", nowSec + 300, nowMs);
    const sharedRows = (
      db.prepare("SELECT COUNT(*) AS cnt FROM revoked_credential WHERE jti = 'shared-jti'").get() as { cnt: number }
    ).cnt;
    assert.equal(sharedRows, 2, "composite PK (group_did, space_uri, jti) must isolate distinct spaces");

    // 2. Seed 1,600 expired rows (> 3 x 500 batches) in both revoked_credential and service_jwt_jti
    const seedTx = db.transaction(() => {
      const insJwt = db.prepare(
        "INSERT INTO service_jwt_jti (issuer_did, jti, group_did, expires_at) VALUES (?, ?, ?, ?)",
      );
      for (let i = 0; i < 1_600; i += 1) {
        insertRev.run(
          `exp-rc-${i}`,
          "did:plc:g1",
          "at:space/did:plc:g1/org.atgrp.meta/self",
          nowSec - 10,
          nowMs - 10_000,
        );
        insJwt.run("did:plc:iss", `credrev:did:plc:iss:exp-${i}`, "did:plc:g1", nowMs - 1_000);
      }
      insJwt.run("did:plc:iss", "credrev:did:plc:iss:live", "did:plc:g1", nowMs + 60_000);
    });
    seedTx();

    pruneExpiredHostState(db, nowMs);

    const remainingRev = (
      db.prepare("SELECT COUNT(*) AS cnt FROM revoked_credential").get() as { cnt: number }
    ).cnt;
    assert.equal(remainingRev, 2, "single pruneExpiredHostState sweep must drain all 1,600 expired revoked_credential rows");

    const remainingJwt = (
      db.prepare("SELECT jti FROM service_jwt_jti").all() as Array<{ jti: string }>
    ).map((r) => r.jti);
    assert.deepEqual(remainingJwt, ["credrev:did:plc:iss:live"]);
  } finally {
    db.close();
  }
});

test("migrateLegacySpaceUrisSync idempotently rewrites Group Host space URIs while keeping space_record payloads/CBOR untouched", async () => {
  const { migrateLegacySpaceUrisSync } = await import("./db");
  const db = openGroupHostDb(":memory:");
  try {
    const groupDid = "did:plc:legacymig";
    const oldSpace = `at://${groupDid}/space/new.flock.channel/general`;
    const newSpace = `at:space/${groupDid}/new.flock.channel/general`;
    const oldRec = `${oldSpace}/did:plc:alice/new.flock.channel.message/2222222222222`;
    const newRec = `${newSpace}/did:plc:alice/new.flock.channel.message/2222222222222`;
    const immutableValue = JSON.stringify({ text: "hello", parent: oldRec });
    const immutableCbor = Buffer.from([1, 2, 3, 4]);

    db.prepare(
      "INSERT INTO group_space (space_uri, group_did, space_type, skey, policy_json, space_rev, created_at, updated_at) VALUES (?, ?, 'new.flock.channel', 'general', '{}', '2222222222222', 1, 1)",
    ).run(oldSpace, groupDid);
    db.prepare(
      "INSERT INTO space_record (space_uri, repo_did, collection, rkey, uri, cid, value, cbor_bytes, repo_rev, indexed_at) VALUES (?, 'did:plc:alice', 'new.flock.channel.message', '2222222222222', ?, 'bafy1', ?, ?, '2222222222222', 1)",
    ).run(oldSpace, oldRec, immutableValue, immutableCbor);
    db.prepare(
      "INSERT INTO mod_subject (group_did, subject, cid_key, status, report_count, created_at, updated_at) VALUES (?, ?, '', 'open', 1, '2026-11-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z')",
    ).run(groupDid, oldRec);
    db.prepare(
      "INSERT INTO outbox_notice (id, kind, group_did, coalesce_key, endpoint, space_uri, payload_json, status, next_attempt_at, expires_at, created_at) VALUES ('n1', 'syncer_update', ?, ?, 'https://op.test', ?, ?, 'pending', 1, 9999999999, 1)",
    ).run(groupDid, `sync:${oldSpace}`, oldSpace, JSON.stringify({ space: oldSpace }));

    migrateLegacySpaceUrisSync(db);
    // Re-run must be idempotent
    migrateLegacySpaceUrisSync(db);

    const sp = db.prepare("SELECT space_uri FROM group_space WHERE group_did = ?").get(groupDid) as { space_uri: string };
    assert.equal(sp.space_uri, newSpace);
    const rec = db.prepare("SELECT space_uri, uri, value, cbor_bytes FROM space_record WHERE cid = 'bafy1'").get() as {
      space_uri: string;
      uri: string;
      value: string;
      cbor_bytes: Buffer;
    };
    assert.equal(rec.space_uri, newSpace);
    assert.equal(rec.uri, newRec);
    assert.equal(rec.value, immutableValue, "immutable record value must not be rewritten");
    assert.deepEqual(rec.cbor_bytes, immutableCbor, "immutable record CBOR must not be rewritten");
    const mod = db.prepare("SELECT subject FROM mod_subject WHERE group_did = ?").get(groupDid) as { subject: string };
    assert.equal(mod.subject, newRec);
    const outbox = db.prepare("SELECT space_uri, coalesce_key, payload_json FROM outbox_notice WHERE id = 'n1'").get() as {
      space_uri: string;
      coalesce_key: string;
      payload_json: string;
    };
    assert.equal(outbox.space_uri, newSpace);
    assert.equal(outbox.coalesce_key, `sync:${newSpace}`);
    assert.deepEqual(JSON.parse(outbox.payload_json), { space: newSpace });
  } finally {
    db.close();
  }
});
