import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("scheduled reconciliation reports stalled work and a missing authority grant while paused", async () => {
  const directory = mkdtempSync(join(tmpdir(), "slack-reconcile-"));
  const databasePath = join(directory, "app.db");
  Object.assign(process.env, {
    NODE_ENV: "test",
    APP_URL: "http://127.0.0.1:3000",
    AUTH_ENCRYPTION_KEY: "4c".repeat(32),
    OPERATOR_SERVICE_REF: "did:web:localhost%3A3000#atproto_flock_operator",
    DATABASE_PATH: databasePath,
  });

  try {
    const { getRawDb } = await import("@/lib/db");
    const db = getRawDb();
    const authorityDid = "did:plc:reconcilefixture0001";
    const workspace = `at://${authorityDid}/space/new.flock.workspace/reconcile-fixture`;
    const operationId = "2222222222222";
    const updatedAt = Math.floor(Date.now() / 1000) - 301;
    db.prepare(`INSERT INTO operation
      (workspace, workspace_uri, actor, operation_id, request_hash, request_json, state, steps_json, error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', '[]', ?, ?, ?)`)
      .run(authorityDid, workspace, authorityDid, operationId, "fixture-hash", JSON.stringify({
        workspace, request: { kind: "bootstrapWorkspace", name: "reconcile fixture" },
      }), "injected outage", updatedAt, updatedAt);
    db.prepare("INSERT INTO operation_workspace_catalog (workspace, workspace_uri) VALUES (?, ?)").run(authorityDid, workspace);

    const child = spawn(process.execPath, ["--import", "tsx", "scripts/reconcile-workspaces.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_PATH: databasePath, FLOCK_ADMIN_MUTATIONS_PAUSED: "true" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });

    assert.equal(exitCode, 1);
    assert.match(stdout, /Admin mutations are paused/);
    assert.match(stderr, new RegExp(`ALERT stalled operation ${operationId}`));
    assert.match(stderr, /authority grant is missing/);
    const operation = db.prepare("SELECT state, updated_at FROM operation WHERE operation_id = ?")
      .get(operationId) as { state: string; updated_at: number };
    assert.deepEqual(operation, { state: "pending", updated_at: updatedAt }, "paused recovery must leave the journal untouched");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_event").get().count, 0);
  } finally {
    const { closeDb } = await import("@/lib/db");
    closeDb();
    delete process.env.DATABASE_PATH;
    rmSync(directory, { recursive: true, force: true });
  }
});
