import assert from "node:assert/strict";
import BetterSqlite3 from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NodeSavedState } from "@atproto/oauth-client-node";
import test from "node:test";
import { closeDb, getRawDb } from "@/lib/db";
import { oauthSqliteStore, retrySqliteBusyWrite } from "./encrypted-store";

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
    const stateStore = oauthSqliteStore<NodeSavedState>("oauth_state");
    const staleUpdatedAt = Date.now() - 40 * 60 * 1000;
    const insertStaleState = raw.prepare("INSERT INTO oauth_state (key,value,updated_at) VALUES (?,?,?)");
    insertStaleState.run("expired-on-read", "stale-ciphertext", staleUpdatedAt);
    assert.equal(await stateStore.get("expired-on-read"), undefined);
    assert.equal(raw.prepare("SELECT 1 FROM oauth_state WHERE key=?").get("expired-on-read"), undefined);
    insertStaleState.run("expired-on-write", "stale-ciphertext", staleUpdatedAt);
    await stateStore.set("current-state", {} as NodeSavedState);
    assert.equal(raw.prepare("SELECT 1 FROM oauth_state WHERE key=?").get("expired-on-write"), undefined);
    assert.ok(raw.prepare("SELECT 1 FROM oauth_state WHERE key=?").get("current-state"));

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
