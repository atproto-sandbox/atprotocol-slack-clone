import assert from "node:assert/strict";
import BetterSqlite3 from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NodeSavedSession, NodeSavedState } from "@atproto/oauth-client-node";
import test from "node:test";
import { closeDb, getRawDb } from "@/lib/db";
import { oauthSqliteStore, oauthSqliteView, retrySqliteBusyWrite } from "./encrypted-store";

test("OAuth persistence retries transient SQLite locks with a bounded attempt count", async () => {
  let attempts = 0;
  const stored = await retrySqliteBusyWrite(() => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error("database is busy"), { code: "SQLITE_BUSY" });
    return "saved";
  });
  assert.equal(stored, "saved");
  assert.equal(attempts, 3);

  let permanentAttempts = 0;
  await assert.rejects(retrySqliteBusyWrite(() => {
    permanentAttempts += 1;
    throw Object.assign(new Error("database is corrupt"), { code: "SQLITE_CORRUPT" });
  }));
  assert.equal(permanentAttempts, 1);

  let exhaustedAttempts = 0;
  await assert.rejects(retrySqliteBusyWrite(() => {
    exhaustedAttempts += 1;
    throw Object.assign(new Error("database is locked"), { code: "SQLITE_LOCKED" });
  }));
  assert.equal(exhaustedAttempts, 3);
});

test("OAuth state store prunes abandoned flows and retries deletion after a SQLite write lock", async () => {
  const directory = mkdtempSync(join(tmpdir(), "slack-oauth-delete-test-"));
  const databasePath = join(directory, "oauth.db");
  process.env.DATABASE_PATH = databasePath;
  process.env.AUTH_ENCRYPTION_KEY = "44".repeat(32);
  process.env.APP_URL = "http://127.0.0.1:3000";
  process.env.OPERATOR_SERVICE_REF = "did:web:localhost%3A3000#atproto_flock_operator";
  let blocker: BetterSqlite3.Database | undefined;
  let releaseTimer: NodeJS.Timeout | undefined;
  try {
    const raw = getRawDb();
    const stateStore = oauthSqliteStore<NodeSavedState>("authority_grant_state");
    const staleUpdatedAt = Date.now() - 40 * 60 * 1000;
    const insertStaleState = raw.prepare("INSERT INTO authority_grant_state (key,value,updated_at) VALUES (?,?,?)");
    insertStaleState.run("expired-on-read", "stale-ciphertext", staleUpdatedAt);
    assert.equal(await stateStore.get("expired-on-read"), undefined);
    assert.equal(raw.prepare("SELECT 1 FROM authority_grant_state WHERE key=?").get("expired-on-read"), undefined);
    insertStaleState.run("expired-on-write", "stale-ciphertext", staleUpdatedAt);
    await stateStore.set("current-state", {} as NodeSavedState);
    assert.equal(raw.prepare("SELECT 1 FROM authority_grant_state WHERE key=?").get("expired-on-write"), undefined);
    assert.ok(raw.prepare("SELECT 1 FROM authority_grant_state WHERE key=?").get("current-state"));

    raw.pragma("busy_timeout=1");
    blocker = new BetterSqlite3(databasePath);
    blocker.pragma("busy_timeout=1");
    blocker.exec("BEGIN IMMEDIATE");
    releaseTimer = setTimeout(() => blocker?.exec("ROLLBACK"), 260);
    await stateStore.del("pending-state");
  } finally {
    if (releaseTimer) clearTimeout(releaseTimer);
    if (blocker?.open) {
      try { blocker.exec("ROLLBACK"); } catch { /* The scheduled release may already have rolled back. */ }
      blocker.close();
    }
    closeDb();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a session view sees only the values it accepts, and never overwrites, deletes or restores a value that replaced its own", async () => {
  const directory = mkdtempSync(join(tmpdir(), "slack-oauth-view-test-"));
  process.env.DATABASE_PATH = join(directory, "oauth.db");
  process.env.AUTH_ENCRYPTION_KEY = "45".repeat(32);
  process.env.APP_URL = "http://127.0.0.1:3000";
  process.env.OPERATOR_SERVICE_REF = "did:web:localhost%3A3000#atproto_flock_operator";
  const session = (approval: string, token: string): NodeSavedSession => ({
    dpopJwk: { kty: "EC", crv: "P-256", x: approval, y: "y", d: "d" },
    authMethod: { method: "none" },
    tokenSet: { iss: "https://pds.example", sub: "did:plc:authority", aud: "https://pds.example", scope: "atproto", access_token: token, token_type: "DPoP" },
  });
  const approvalOf = (value: NodeSavedSession) => ("x" in value.dpopJwk ? value.dpopJwk.x : undefined);
  const tokenOf = (value: NodeSavedSession | undefined) => value?.tokenSet.access_token;
  try {
    // given a grant from approval A, and a view that sees only approval A
    const store = oauthSqliteStore<NodeSavedSession>("authority_grant");
    const viewOfA = oauthSqliteView<NodeSavedSession>("authority_grant", (value) => approvalOf(value) === "a");
    await store.set("did:plc:authority", session("a", "first"));

    // then the view reads it and writes its refreshes
    assert.equal(tokenOf(await viewOfA.get("did:plc:authority")), "first");
    await viewOfA.set("did:plc:authority", session("a", "refreshed"));
    assert.equal(tokenOf(await store.get("did:plc:authority")), "refreshed");

    // when approval B replaces it
    await store.set("did:plc:authority", session("b", "second"));

    // then the view finds nothing, and neither its write nor its delete touches B
    assert.equal(await viewOfA.get("did:plc:authority"), undefined);
    await viewOfA.set("did:plc:authority", session("a", "stale refresh"));
    await viewOfA.del("did:plc:authority");
    assert.equal(tokenOf(await store.get("did:plc:authority")), "second");

    // and once the grant is gone, the view does not write A back
    await store.del("did:plc:authority");
    await viewOfA.set("did:plc:authority", session("a", "late refresh"));
    assert.equal(await store.get("did:plc:authority"), undefined);

    // and a view of its own approval deletes it
    await store.set("did:plc:authority", session("b", "third"));
    await oauthSqliteView<NodeSavedSession>("authority_grant", (value) => approvalOf(value) === "b").del("did:plc:authority");
    assert.equal(await store.get("did:plc:authority"), undefined);
  } finally {
    closeDb();
    rmSync(directory, { recursive: true, force: true });
  }
});
