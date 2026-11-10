import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { getRawDb } from "@/lib/db";
import {
  acquireOAuthPermissionFlowLock,
  isTransientOAuthInfrastructureError,
  OAuthRequestLockError,
  oauthSqliteRequestLock,
  releaseOAuthPermissionFlowLock,
} from "./oauth-request-lock";

test("SQLite OAuth request lock serializes concurrent refreshes for one DID", async () => {
  const directory = mkdtempSync(join(tmpdir(), "slack-oauth-lock-test-"));
  process.env.DATABASE_PATH = join(directory, "oauth.db");
  process.env.AUTH_ENCRYPTION_KEY = "88".repeat(32);
  process.env.OPERATOR_SERVICE_REF = "did:web:localhost%3A3000#atproto_flock_operator";
  process.env.APP_URL = "http://127.0.0.1:3000";
  process.env.OAUTH_LOCK_TEST_LOG = join(directory, "events.log");
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });

  try {
    const first = oauthSqliteRequestLock("@atproto-oauth-client-did:plc:alice", async () => {
      appendFileSync(process.env.OAUTH_LOCK_TEST_LOG!, "parent:start\n");
      markStarted();
      await new Promise((resolve) => setTimeout(resolve, 750));
      appendFileSync(process.env.OAUTH_LOCK_TEST_LOG!, "parent:end\n");
    });
    await started;
    await Promise.all([first, runLockWorker()]);
    assert.deepEqual(readFileSync(process.env.OAUTH_LOCK_TEST_LOG!, "utf8").trim().split("\n"), [
      "parent:start", "parent:end", "child:start", "child:end",
    ]);
    const remaining = getRawDb().prepare("SELECT COUNT(*) AS count FROM oauth_request_lock").get() as { count: number };
    assert.equal(remaining.count, 0);
    const permissionDid = "did:plc:permission-lock";
    assert.equal(acquireOAuthPermissionFlowLock(permissionDid, "flow-one"), true);
    assert.equal(acquireOAuthPermissionFlowLock(permissionDid, "flow-two"), false, "a second pending grant for one DID is rejected");
    releaseOAuthPermissionFlowLock(permissionDid, "wrong-flow");
    assert.equal(acquireOAuthPermissionFlowLock(permissionDid, "flow-two"), false, "only the owning callback can release its flow lock");
    releaseOAuthPermissionFlowLock(permissionDid, "flow-one");
    assert.equal(acquireOAuthPermissionFlowLock(permissionDid, "flow-two"), true, "the next grant can start after its callback releases the lock");
    getRawDb().prepare("UPDATE oauth_request_lock SET expires_at = ? WHERE name = ?")
      .run(Math.floor(Date.now() / 1000) - 1, "@spaces-permission-flow-did:plc:permission-lock");
    assert.equal(acquireOAuthPermissionFlowLock(permissionDid, "flow-three"), true, "an abandoned flow lock can be reclaimed after its lease");
    releaseOAuthPermissionFlowLock(permissionDid, "flow-three");
    getRawDb().prepare("INSERT INTO oauth_request_lock (name, token, expires_at) VALUES (?, ?, ?)")
      .run("@atproto-oauth-client-did:plc:crashed", "stale-token", Math.floor(Date.now() / 1000) - 1);
    let reclaimed = false;
    await oauthSqliteRequestLock("@atproto-oauth-client-did:plc:crashed", async () => { reclaimed = true; });
    assert.equal(reclaimed, true, "a stale lease left by a crashed worker can be reclaimed");
  } finally {
    getRawDb().close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("temporary OAuth lock, SQLite, and endpoint failures do not look like invalid credentials", () => {
  assert.equal(isTransientOAuthInfrastructureError(new OAuthRequestLockError("busy")), true);
  assert.equal(isTransientOAuthInfrastructureError({ code: "SQLITE_BUSY" }), true);
  assert.equal(isTransientOAuthInfrastructureError(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } })), true);
  assert.equal(isTransientOAuthInfrastructureError({ status: 503 }), true);
  assert.equal(isTransientOAuthInfrastructureError(new Error("OAuth request failed", {
    cause: new Error("This operation was aborted", { cause: Object.assign(new Error("timed out"), { name: "TimeoutError" }) }),
  })), true);
  assert.equal(isTransientOAuthInfrastructureError({ name: "AbortError" }), true);
  assert.equal(isTransientOAuthInfrastructureError(new Error("wrapper", {
    cause: new TypeError("fetch failed", { cause: { code: "EAI_AGAIN" } }),
  })), true);
  assert.equal(isTransientOAuthInfrastructureError({ status: 401 }), false);
  assert.equal(isTransientOAuthInfrastructureError({ status: 400, error: "invalid_grant" }), false);
});

function runLockWorker(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/auth/oauth-request-lock-worker.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, OAUTH_LOCK_TEST_LABEL: "child" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`OAuth lock worker exited ${code}: ${stderr}`)));
  });
}
