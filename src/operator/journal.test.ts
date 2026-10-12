import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDb, getRawDb } from "@/lib/db";
import { XrpcError } from "@/atproto/xrpc";
import { getActorOperation, isTransientOperationError, listJournaledWorkspaces, listRecoverableOperations, listStalledOperations, discardEmptyOperationIfWorkspaceLockOwned, persistPendingIfWorkspaceLockOwned, runJournaledOperation, withWorkspaceLock } from "./journal";
import type { OperatorActor } from "./security";

test("journal retry skips completed steps and reuses the same operation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "slack-journal-test-"));
  process.env.DATABASE_PATH = join(directory, "journal.db");
  process.env.AUTH_ENCRYPTION_KEY = "22".repeat(32);
  process.env.OPERATOR_SERVICE_REF = "did:web:localhost%3A3000#atproto_slack_admin";
  process.env.APP_URL = "http://127.0.0.1:3000";
  const actor = {
    did: "did:plc:admin",
    session: {} as OperatorActor["session"],
    workspace: { uri: "at://did:plc:owner/space/org.slack.workspace/acme", authorityDid: "did:plc:owner", skey: "acme" },
    canRecoverOperations: true,
  } satisfies OperatorActor;
  let first = 0;
  let second = 0;
  let transientAttempts = 0;
  let shouldFail = true;
  const run = () => runJournaledOperation(actor, "2222222222222", { kind: "testOperation" }, async (context) => {
    await context.step("first", async () => { first += 1; });
    await context.step("transient", async () => {
      transientAttempts += 1;
      if (transientAttempts < 3) throw new XrpcError(503, "temporary PDS outage", "ServiceUnavailable");
    });
    if (shouldFail) { shouldFail = false; throw new Error("temporary failure"); }
    await context.step("second", async () => { second += 1; });
  });
  try {
    const initial = await run();
    assert.equal(initial.state, "pending");
    assert.deepEqual(initial.completedSteps, ["first", "transient"]);
    assert.equal(transientAttempts, 3, "transient PDS failures are retried with bounded backoff");
    assert.equal(isTransientOperationError(new XrpcError(403, "denied", "Forbidden")), false);
    assert.equal(isTransientOperationError(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } })), true);
    const resumed = await run();
    assert.equal(resumed.state, "completed");
    assert.deepEqual(resumed.completedSteps, ["first", "transient", "second"]);
    assert.deepEqual([first, second], [1, 1]);
    const raw = getRawDb();
    const now = Math.floor(Date.now() / 1000) - 600;
    const rows = [
      { operationId: "2222222222224", workspace: actor.workspace.uri },
      { operationId: "2222222222225", workspace: "at://did:plc:owner/space/org.slack.workspace/other" },
    ];
    for (const row of rows) {
      raw.prepare(`INSERT INTO operation
        (workspace,workspace_uri,actor,operation_id,request_hash,request_json,state,steps_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,'pending','[]',?,?)`).run(
        actor.workspace.authorityDid, row.workspace, actor.did, row.operationId, "hash",
        JSON.stringify({ workspace: row.workspace, request: { kind: "testOperation" } }), now, now,
      );
      raw.prepare("INSERT OR IGNORE INTO operation_workspace_catalog (workspace,workspace_uri) VALUES (?,?)")
        .run(actor.workspace.authorityDid, row.workspace);
    }
    assert.equal(getActorOperation(actor, rows[1].operationId), null);
    assert.deepEqual(listJournaledWorkspaces(), [
      { authorityDid: actor.workspace.authorityDid, uri: actor.workspace.uri },
      { authorityDid: actor.workspace.authorityDid, uri: "at://did:plc:owner/space/org.slack.workspace/other" },
    ]);
    assert.deepEqual(listRecoverableOperations(actor.workspace.authorityDid, actor.workspace.uri).map((row) => row.operationId), [rows[0].operationId]);
    assert.deepEqual(listStalledOperations(actor.workspace.authorityDid, actor.workspace.uri).operations.map((row) => row.operationId), [rows[0].operationId]);
    assert.equal((await run()).state, "completed");
    assert.deepEqual([first, second], [1, 1]);

    const staleLeaseNow = Date.now();
    raw.prepare("INSERT OR REPLACE INTO workspace_lock (workspace,token,expires_at) VALUES (?,?,?)")
      .run(actor.workspace.authorityDid, "crashed-holder", Math.floor(staleLeaseNow / 1000) + 90);
    const realDateNow = Date.now;
    let fakeNow = staleLeaseNow;
    let releaseHolder: (() => void) | undefined;
    let resolveHolderEntered: (() => void) | undefined;
    let holderPromise: ReturnType<typeof runJournaledOperation> | undefined;
    let contenderPromise: ReturnType<typeof runJournaledOperation> | undefined;
    const holderEntered = new Promise<void>((resolve) => { resolveHolderEntered = resolve; });
    let acquiredExpiresAt = 0;
    let contenderEntered = false;
    let staleLeaseClock: NodeJS.Timeout | undefined;
    try {
      Date.now = () => fakeNow;
      staleLeaseClock = setTimeout(() => { fakeNow += 91_000; }, 10);
      holderPromise = runJournaledOperation(actor, "2222222222226", { kind: "staleLeaseTakeover" }, async () => {
        acquiredExpiresAt = (raw.prepare("SELECT expires_at FROM workspace_lock WHERE workspace=?")
          .get(actor.workspace.authorityDid) as { expires_at: number }).expires_at;
        resolveHolderEntered?.();
        await new Promise<void>((resolve) => { releaseHolder = resolve; });
      });
      await holderEntered;
      assert.ok(acquiredExpiresAt > Math.floor(Date.now() / 1000), "a stale-lock takeover must receive a fresh lease");
      contenderPromise = runJournaledOperation(actor, "2222222222227", { kind: "contender" }, async () => {
        contenderEntered = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(contenderEntered, false, "a second process must not take over the newly acquired lease");
      releaseHolder?.();
      assert.equal((await holderPromise).state, "completed");
      assert.equal((await contenderPromise).state, "completed");
      assert.equal(contenderEntered, true);
    } finally {
      releaseHolder?.();
      await holderPromise?.catch(() => undefined);
      await contenderPromise?.catch(() => undefined);
      if (staleLeaseClock) clearTimeout(staleLeaseClock);
      Date.now = realDateNow;
    }
  } finally {
    closeDb();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stalled-operation detection includes the exact five-minute cutoff", () => {
  const directory = mkdtempSync(join(tmpdir(), "slack-stalled-operation-test-"));
  process.env.DATABASE_PATH = join(directory, "stalled.db");
  process.env.AUTH_ENCRYPTION_KEY = "33".repeat(32);
  const workspaceDid = "did:plc:owner";
  const workspaceUri = "at://did:plc:owner/space/org.slack.workspace/acme";
  const stableNow = Math.floor(Date.now() / 1000) + 60;
  const realDateNow = Date.now;
  Date.now = () => stableNow * 1000;
  try {
    const raw = getRawDb();
    const rows = [
      { operationId: "2222222222231", age: 301, state: "pending" },
      { operationId: "2222222222232", age: 300, state: "running" },
      { operationId: "2222222222233", age: 299, state: "pending" },
      { operationId: "2222222222234", age: 600, state: "completed" },
    ] as const;
    for (const row of rows) {
      const updatedAt = stableNow - row.age;
      raw.prepare(`INSERT INTO operation
        (workspace,workspace_uri,actor,operation_id,request_hash,request_json,state,steps_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?, '[]',?,?)`).run(
        workspaceDid, workspaceUri, workspaceDid, row.operationId, `hash-${row.operationId}`,
        JSON.stringify({ workspace: workspaceUri, request: { kind: "testOperation" } }),
        row.state, updatedAt, updatedAt,
      );
    }
    assert.deepEqual(
      listStalledOperations(workspaceDid, workspaceUri).operations.map((row) => row.operationId),
      ["2222222222231", "2222222222232"],
    );
  } finally {
    Date.now = realDateNow;
    closeDb();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the shared workspace lock serializes bootstrap and operator work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "slack-workspace-lock-test-"));
  process.env.DATABASE_PATH = join(directory, "lock.db");
  process.env.AUTH_ENCRYPTION_KEY = "44".repeat(32);
  process.env.OPERATOR_SERVICE_REF = "did:web:localhost%3A3000#atproto_slack_admin";
  process.env.APP_URL = "http://127.0.0.1:3000";
  const authority = "did:plc:owner";
  let releaseFirst: (() => void) | undefined;
  let signalFirstEntered: (() => void) | undefined;
  let first: Promise<void> | undefined;
  let second: Promise<void> | undefined;
  let secondEntered = false;
  const firstEntered = new Promise<void>((resolve) => { signalFirstEntered = resolve; });
  try {
    first = withWorkspaceLock(authority, async (lock) => {
      lock.refresh();
      signalFirstEntered?.();
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      lock.refresh();
    });
    await firstEntered;
    second = withWorkspaceLock(authority, async (lock) => {
      secondEntered = true;
      lock.refresh();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(secondEntered, false, "a bootstrap cannot overlap an operator operation for the same authority");
    releaseFirst?.();
    await Promise.all([first, second]);
    assert.equal(secondEntered, true);
  } finally {
    releaseFirst?.();
    await first?.catch(() => undefined);
    await second?.catch(() => undefined);
    closeDb();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pending journal state is persisted only by the current workspace lock owner", async () => {
  const directory = mkdtempSync(join(tmpdir(), "slack-pending-lock-test-"));
  process.env.DATABASE_PATH = join(directory, "pending.db");
  process.env.AUTH_ENCRYPTION_KEY = "55".repeat(32);
  process.env.OPERATOR_SERVICE_REF = "did:web:localhost%3A3000#atproto_slack_admin";
  process.env.APP_URL = "http://127.0.0.1:3000";
  const workspace = "did:plc:owner";
  const actor = workspace;
  const firstId = "2222222222228";
  const lostId = "2222222222229";
  const raw = getRawDb();
  const now = Math.floor(Date.now() / 1000);
  const requestJson = JSON.stringify({ workspace: "at://did:plc:owner/space/org.slack.workspace/retry", request: { kind: "bootstrapWorkspace", name: "Retry" } });
  const insertRunning = (operationId: string) => raw.prepare(`INSERT INTO operation
    (workspace,workspace_uri,actor,operation_id,request_hash,request_json,state,steps_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'running','[]',?,?)`).run(workspace, "at://did:plc:owner/space/org.slack.workspace/retry", actor, operationId, `hash-${operationId}`, requestJson, now, now);
  try {
    await withWorkspaceLock(workspace, async (lock) => {
      insertRunning(firstId);
      assert.equal(persistPendingIfWorkspaceLockOwned({
        workspace, actor, operationId: firstId, requestHash: `hash-${firstId}`, lock,
        completedSteps: ["workspace-space"], error: new Error("temporary PDS failure"),
      }), true);
      const row = raw.prepare("SELECT state,steps_json FROM operation WHERE workspace=? AND actor=? AND operation_id=?")
        .get(workspace, actor, firstId) as { state: string; steps_json: string };
      assert.equal(row.state, "pending");
      assert.deepEqual(JSON.parse(row.steps_json), ["workspace-space"]);
    });
    await assert.rejects(withWorkspaceLock(workspace, async (lock) => {
      insertRunning(lostId);
      raw.prepare("DELETE FROM workspace_lock WHERE workspace=? AND token=?").run(workspace, lock.token);
      assert.equal(persistPendingIfWorkspaceLockOwned({
        workspace, actor, operationId: lostId, requestHash: `hash-${lostId}`, lock,
        completedSteps: [], error: new Error("lost lock"),
      }), false);
      const row = raw.prepare("SELECT state FROM operation WHERE workspace=? AND actor=? AND operation_id=?")
        .get(workspace, actor, lostId) as { state: string };
      assert.equal(row.state, "running", "a stale runner cannot change state after another runner may own the lock");
    }), /Workspace operation lock was lost/);
  } finally {
    closeDb();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("discarding an empty operation keeps the catalog entry another operation needs, and refuses without the lock or with progress", async () => {
  const directory = mkdtempSync(join(tmpdir(), "slack-discard-test-"));
  process.env.DATABASE_PATH = join(directory, "discard.db");
  process.env.AUTH_ENCRYPTION_KEY = "66".repeat(32);
  process.env.OPERATOR_SERVICE_REF = "did:web:localhost%3A3000#atproto_slack_admin";
  process.env.APP_URL = "http://127.0.0.1:3000";
  const workspace = "did:plc:owner";
  const sharedUri = "at://did:plc:owner/space/org.slack.workspace/shared";
  const loneUri = "at://did:plc:owner/space/org.slack.workspace/lone";
  const raw = getRawDb();
  const now = Math.floor(Date.now() / 1000);
  const insert = (workspaceUri: string, operationId: string, state: string, steps: string[]) => {
    raw.prepare(`INSERT INTO operation (workspace,workspace_uri,actor,operation_id,request_hash,request_json,state,steps_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(workspace, workspaceUri, workspace, operationId, `hash-${operationId}`, "{}", state, JSON.stringify(steps), now, now);
    raw.prepare("INSERT OR IGNORE INTO operation_workspace_catalog (workspace, workspace_uri) VALUES (?, ?)").run(workspace, workspaceUri);
  };
  const exists = (operationId: string) => raw.prepare("SELECT 1 FROM operation WHERE operation_id=?").get(operationId) !== undefined;
  const catalogHas = (workspaceUri: string) => raw.prepare("SELECT 1 FROM operation_workspace_catalog WHERE workspace_uri=?").get(workspaceUri) !== undefined;
  try {
    await withWorkspaceLock(workspace, async (lock) => {
      const discard = (workspaceUri: string, operationId: string) => discardEmptyOperationIfWorkspaceLockOwned({
        workspace, workspaceUri, actor: workspace, operationId, lock, reason: "authorizationRequired",
      });

      // #given a completed operation and an empty pending one on the same workspace
      insert(sharedUri, "2222222222222", "completed", ["workspace-space"]);
      insert(sharedUri, "2222222222223", "pending", []);
      // #when the empty one is discarded
      // #then the row goes, but the catalog entry the completed operation needs stays, and the discard is audited
      assert.equal(discard(sharedUri, "2222222222223"), true);
      assert.equal(exists("2222222222223"), false);
      assert.equal(exists("2222222222222"), true, "the completed operation is untouched");
      assert.equal(catalogHas(sharedUri), true, "the catalog entry is kept while any operation references it");
      const audit = raw.prepare("SELECT event FROM audit_event WHERE operation_id=?").all("2222222222223") as Array<{ event: string }>;
      assert.deepEqual(audit.map((entry) => entry.event), ["operationDiscarded"]);

      // #given an empty operation that is the only one on its workspace
      insert(loneUri, "2222222222224", "running", []);
      // #then discarding it removes the catalog entry too
      assert.equal(discard(loneUri, "2222222222224"), true);
      assert.equal(catalogHas(loneUri), false);

      // #given an operation that made progress, or one already completed
      insert(loneUri, "2222222222225", "pending", ["workspace-space"]);
      insert(loneUri, "2222222222226", "completed", []);
      // #then neither can be discarded
      assert.equal(discard(loneUri, "2222222222225"), false, "progress is never discarded");
      assert.equal(discard(loneUri, "2222222222226"), false, "a completed operation is never discarded");
      assert.equal(exists("2222222222225") && exists("2222222222226"), true);

      // #given an empty operation and a runner that lost the workspace lock
      insert(loneUri, "2222222222227", "running", []);
      raw.prepare("DELETE FROM workspace_lock WHERE workspace=? AND token=?").run(workspace, lock.token);
      // #then it cannot delete anything
      assert.equal(discard(loneUri, "2222222222227"), false);
      assert.equal(exists("2222222222227"), true, "a stale runner cannot delete a row after losing the lock");
    }).catch((error: unknown) => {
      assert.match(String(error), /Workspace operation lock was lost/);
    });
  } finally {
    closeDb();
    rmSync(directory, { recursive: true, force: true });
  }
});
