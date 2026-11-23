import { randomUUID } from "node:crypto";
import { isAccountSuspendedError, isScopeMissingError } from "@flock/protocol/atproto/xrpc";
import { canonicalJson, requestDigest } from "@flock/protocol/keys";
import { getRawDb, type OperationState } from "../lib/db";
import type { OperatorActor } from "./actor";
import { OperatorAuthError } from "./errors";

export type { OperationState };

export type OperationView = {
  operationId: string;
  requestHash: string;
  state: OperationState;
  completedSteps: string[];
  takenOverBy?: string;
  error?: string;
  updatedAt: string;
  /** The Group Host refused a step for a scope the authority grant lacks: an active admin must reauthorize, then retry. */
  authorizationRequired?: true;
};

export type OperationContext = {
  operationId: string;
  completedSteps: string[];
  replaying?: boolean;
  step(name: string, action: () => Promise<void>): Promise<void>;
};

export class OperationConflictError extends Error {}
export class OperationBusyError extends Error {}
export class OperationRejectedError extends Error {}

export type WorkspaceLock = {
  readonly token: string;
  readonly heartbeatError: unknown;
  refresh(): void;
};

const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429]);
const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const RETRY_DELAYS_MS = [100, 200, 400] as const;
const WORKSPACE_LOCK_LEASE_SECONDS = 90;
const WORKSPACE_LOCK_ACQUIRE_WAIT_MS = 100_000;
const OPERATION_TIME_LIMIT_MS = 3 * 60_000;
const WORKSPACE_LOCK_POLL_MS = 100;
const MAX_RECOVERABLE_OPERATIONS = 1_000;
const MAX_STALLED_OPERATIONS = 100;
const MAX_JOURNALED_WORKSPACES = 10_000;

export type JournalAdmission = {
  verify?(): Promise<void>;
  admit(now: number): void;
  restore?(now: number): void;
};

export type RunJournaledOperationOptions = {
  replay?: boolean;
  admission?: JournalAdmission;
  takeoverBy?: OperatorActor;
  beforeStep?: (stepName: string, completedSteps: readonly string[]) => Promise<void>;
};

type StoredOperationRow = {
  request_hash: string;
  steps_json: string;
  state: OperationState;
  taken_over_by: string | null;
  error: string | null;
  updated_at: number;
};

export async function runJournaledOperation(
  actor: OperatorActor,
  operationId: string,
  request: Record<string, unknown>,
  steps: readonly string[],
  run: (context: OperationContext) => Promise<void>,
  options: RunJournaledOperationOptions = {},
): Promise<OperationView> {
  const declared = stepMatcher(steps);
  const workspaceDid = actor.workspace.authorityDid;
  const requestHash = operationRequestHash(actor, request);
  const auditPrincipal = options.takeoverBy ?? actor;

  return withWorkspaceLock(workspaceDid, async (lock) => {
    const heldSince = Date.now();
    const raw = getRawDb();
    const now = unixNow();
    const prior = raw
      .prepare(
        "SELECT request_hash, steps_json, state, taken_over_by, error, updated_at FROM operation WHERE workspace = ? AND actor = ? AND operation_id = ?",
      )
      .get(workspaceDid, actor.did, operationId) as StoredOperationRow | undefined;

    if (prior && prior.request_hash !== requestHash) throw new OperationConflictError("OperationIdConflict");
    if (
      prior?.state === "completed" ||
      prior?.state === "failed" ||
      prior?.state === "aborted_actor_revoked"
    ) {
      return operationView(
        operationId,
        requestHash,
        prior.state,
        parseSteps(prior.steps_json),
        prior.error,
        prior.updated_at,
        prior.taken_over_by,
      );
    }

    const completedSteps = prior ? parseSteps(prior.steps_json) : [];
    let effectiveTakenOverBy: string | null = prior?.taken_over_by ?? null;

    if (!prior) {
      await options.admission?.verify?.();
      raw.transaction(() => {
        options.admission?.admit(now);
        raw
          .prepare(
            "INSERT INTO operation (workspace, workspace_uri, actor, operation_id, request_hash, request_json, state, steps_json, taken_over_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'running', '[]', NULL, ?, ?)",
          )
          .run(
            workspaceDid,
            actor.workspace.uri,
            actor.did,
            operationId,
            requestHash,
            canonicalJson({ workspace: actor.workspace.uri, request }),
            now,
            now,
          );
        raw
          .prepare("INSERT OR IGNORE INTO operation_workspace_catalog (workspace, workspace_uri) VALUES (?, ?)")
          .run(workspaceDid, actor.workspace.uri);
      })();
    } else {
      raw
        .prepare("INSERT OR IGNORE INTO operation_workspace_catalog (workspace, workspace_uri) VALUES (?, ?)")
        .run(workspaceDid, actor.workspace.uri);
      if (options.takeoverBy) {
        effectiveTakenOverBy = options.takeoverBy.did;
        raw
          .prepare(
            "UPDATE operation SET state = 'running', taken_over_by = ?, error = NULL, updated_at = ? WHERE workspace = ? AND actor = ? AND operation_id = ?",
          )
          .run(effectiveTakenOverBy, now, workspaceDid, actor.did, operationId);
        if (prior.taken_over_by !== effectiveTakenOverBy) {
          audit(options.takeoverBy, operationId, "operationAdminTakeover", {
            originalActor: actor.did,
            completedStepsBeforeTakeover: completedSteps.length,
          });
        }
      } else {
        raw
          .prepare("UPDATE operation SET state = 'running', error = NULL, updated_at = ? WHERE workspace = ? AND actor = ? AND operation_id = ?")
          .run(now, workspaceDid, actor.did, operationId);
      }
    }

    const step = async (name: string, action: () => Promise<void>) => {
      if (!declared(name)) throw new Error(`Step "${name}" is not declared for this operation.`);
      if (completedSteps.includes(name)) return;
      if (Date.now() - heldSince >= OPERATION_TIME_LIMIT_MS) {
        throw new Error("Operation paused at its time limit; send it again to continue it.");
      }
      lock.refresh();
      await options.beforeStep?.(name, completedSteps);
      lock.refresh();
      await action();
      lock.refresh();
      if (!completedSteps.includes(name)) completedSteps.push(name);
      const timestamp = unixNow();
      raw
        .prepare("UPDATE operation SET steps_json = ?, state = 'running', error = NULL, updated_at = ? WHERE workspace = ? AND actor = ? AND operation_id = ?")
        .run(JSON.stringify(completedSteps), timestamp, workspaceDid, actor.did, operationId);
      audit(auditPrincipal, operationId, name, {});
    };

    try {
      let attemptCount = 0;
      await retryTransient(() => {
        const replaying = Boolean(prior) || Boolean(options.replay) || attemptCount > 0;
        attemptCount += 1;
        return run({ operationId, completedSteps, replaying, step });
      });
      if (lock.heartbeatError) {
        persistHeartbeatLossIfOwned(raw, actor, auditPrincipal, operationId, requestHash, lock.token, lock.heartbeatError);
        throw lock.heartbeatError;
      }
      lock.refresh();
      const timestamp = unixNow();
      raw
        .prepare("UPDATE operation SET state = 'completed', error = NULL, updated_at = ? WHERE workspace = ? AND actor = ? AND operation_id = ?")
        .run(timestamp, workspaceDid, actor.did, operationId);
      audit(auditPrincipal, operationId, "operationCompleted", { steps: completedSteps.length });
      return operationView(operationId, requestHash, "completed", completedSteps, undefined, timestamp, effectiveTakenOverBy);
    } catch (error) {
      if (lock.heartbeatError) {
        persistHeartbeatLossIfOwned(raw, actor, auditPrincipal, operationId, requestHash, lock.token, lock.heartbeatError);
        throw lock.heartbeatError;
      }
      lock.refresh();
      const message = safeOperationError(error);
      const timestamp = unixNow();

      // Actor revoked before committing any side effects -> terminal `aborted_actor_revoked` (and rethrow 403 on live execute!)
      if (error instanceof OperatorAuthError && completedSteps.length === 0 && !options.takeoverBy) {
        raw
          .prepare("UPDATE operation SET state = 'aborted_actor_revoked', error = ?, updated_at = ? WHERE workspace = ? AND actor = ? AND operation_id = ?")
          .run(message, timestamp, workspaceDid, actor.did, operationId);
        audit(auditPrincipal, operationId, "operationAbortedActorRevoked", { originalActor: actor.did, error: message });
        if (!options.replay) throw error;
        return operationView(operationId, requestHash, "aborted_actor_revoked", [], message, timestamp, effectiveTakenOverBy);
      }

      if (error instanceof OperatorAuthError && options.takeoverBy) {
        // Recovering admin lost privileges mid-takeover: keep pending for a privileged admin and rethrow 403!
        raw
          .prepare("UPDATE operation SET state = 'pending', error = ?, updated_at = ? WHERE workspace = ? AND actor = ? AND operation_id = ?")
          .run(message, timestamp, workspaceDid, actor.did, operationId);
        audit(auditPrincipal, operationId, "operationPending", { error: message });
        throw error;
      }

      const failed =
        error instanceof OperationRejectedError ||
        (isAccountSuspendedError(error) && completedSteps.length === 0);
      const authorizationRequired = isScopeMissingError(error) ? { authorizationRequired: true as const } : {};
      const restore = options.admission?.restore;
      if (
        authorizationRequired.authorizationRequired &&
        !options.replay &&
        completedSteps.length === 0 &&
        discardEmptyOperationIfWorkspaceLockOwned({
          workspace: workspaceDid,
          workspaceUri: actor.workspace.uri,
          actor: actor.did,
          operationId,
          lock,
          reason: "authorizationRequired",
          alsoInTransaction: restore && (() => restore(timestamp)),
        })
      ) {
        return { ...operationView(operationId, requestHash, "pending", [], message, timestamp, effectiveTakenOverBy), ...authorizationRequired };
      }
      const state: OperationState = failed ? "failed" : "pending";
      raw
        .prepare("UPDATE operation SET state = ?, error = ?, updated_at = ? WHERE workspace = ? AND actor = ? AND operation_id = ?")
        .run(state, message, timestamp, workspaceDid, actor.did, operationId);
      audit(auditPrincipal, operationId, failed ? "operationFailed" : "operationPending", { error: message });
      return { ...operationView(operationId, requestHash, state, completedSteps, message, timestamp, effectiveTakenOverBy), ...authorizationRequired };
    }
  });
}

export async function completeSatisfiedMemberOperation(
  executorActor: OperatorActor,
  ownerDid: string,
  operationId: string,
): Promise<OperationView | null> {
  const workspaceDid = executorActor.workspace.authorityDid;
  return withWorkspaceLock(workspaceDid, async () => {
    const raw = getRawDb();
    const row = raw
      .prepare("SELECT request_hash, steps_json, state, taken_over_by, error, updated_at FROM operation WHERE workspace = ? AND actor = ? AND operation_id = ?")
      .get(workspaceDid, ownerDid, operationId) as StoredOperationRow | undefined;
    if (!row) return null;
    if (row.state === "completed" || row.state === "failed" || row.state === "aborted_actor_revoked") {
      return operationView(operationId, row.request_hash, row.state, parseSteps(row.steps_json), row.error, row.updated_at, row.taken_over_by);
    }
    const timestamp = unixNow();
    raw
      .prepare("UPDATE operation SET state = 'completed', error = NULL, updated_at = ? WHERE workspace = ? AND actor = ? AND operation_id = ?")
      .run(timestamp, workspaceDid, ownerDid, operationId);
    audit(executorActor, operationId, "operationSatisfiedByState", { originalActor: ownerDid });
    return operationView(operationId, row.request_hash, "completed", parseSteps(row.steps_json), undefined, timestamp, row.taken_over_by);
  });
}

export async function abortOperationActorRevoked(
  executorActor: OperatorActor,
  ownerDid: string,
  operationId: string,
  reason: string,
): Promise<OperationView | null> {
  const workspaceDid = executorActor.workspace.authorityDid;
  return withWorkspaceLock(workspaceDid, async () => {
    const raw = getRawDb();
    const row = raw
      .prepare("SELECT request_hash, steps_json, state, taken_over_by, error, updated_at FROM operation WHERE workspace = ? AND actor = ? AND operation_id = ?")
      .get(workspaceDid, ownerDid, operationId) as StoredOperationRow | undefined;
    if (!row) return null;
    const steps = parseSteps(row.steps_json);
    if (row.state === "completed" || row.state === "failed" || row.state === "aborted_actor_revoked") {
      return operationView(operationId, row.request_hash, row.state, steps, row.error, row.updated_at, row.taken_over_by);
    }
    if (steps.length > 0) return null;
    const message = safeOperationError(new Error(reason));
    const timestamp = unixNow();
    raw
      .prepare("UPDATE operation SET state = 'aborted_actor_revoked', error = ?, updated_at = ? WHERE workspace = ? AND actor = ? AND operation_id = ? AND steps_json = '[]'")
      .run(message, timestamp, workspaceDid, ownerDid, operationId);
    audit(executorActor, operationId, "operationAbortedActorRevoked", { originalActor: ownerDid, error: message });
    return operationView(operationId, row.request_hash, "aborted_actor_revoked", [], message, timestamp, row.taken_over_by);
  });
}

export async function withWorkspaceLock<T>(workspace: string, run: (lock: WorkspaceLock) => Promise<T>): Promise<T> {
  const acquired = await acquireWorkspaceLock(workspace);
  let heartbeatError: unknown;
  const heartbeat = setInterval(() => {
    try {
      refreshWorkspaceLock(workspace, acquired.token);
    } catch (error) {
      heartbeatError = error;
    }
  }, 25_000);
  heartbeat.unref?.();
  const lock: WorkspaceLock = {
    token: acquired.token,
    get heartbeatError() {
      return heartbeatError;
    },
    refresh() {
      if (heartbeatError) throw heartbeatError;
      refreshWorkspaceLock(workspace, acquired.token);
    },
  };
  try {
    const result = await run(lock);
    lock.refresh();
    return result;
  } finally {
    clearInterval(heartbeat);
    releaseWorkspaceLock(workspace, acquired.token);
  }
}

export function discardEmptyOperationIfWorkspaceLockOwned(input: {
  workspace: string;
  workspaceUri: string;
  actor: string;
  operationId: string;
  lock: WorkspaceLock;
  reason: string;
  alsoInTransaction?: () => void;
}): boolean {
  const raw = getRawDb();
  try {
    return raw.transaction(() => {
      refreshWorkspaceLock(input.workspace, input.lock.token);
      const removed = raw
        .prepare(
          "DELETE FROM operation WHERE workspace = ? AND actor = ? AND operation_id = ? AND steps_json = '[]' AND state IN ('running', 'pending')",
        )
        .run(input.workspace, input.actor, input.operationId);
      if (removed.changes !== 1) return false;
      input.alsoInTransaction?.();
      raw
        .prepare(
          `DELETE FROM operation_workspace_catalog
           WHERE workspace = ? AND workspace_uri = ?
           AND NOT EXISTS (SELECT 1 FROM operation WHERE workspace = ? AND workspace_uri = ?)`,
        )
        .run(input.workspace, input.workspaceUri, input.workspace, input.workspaceUri);
      raw
        .prepare("INSERT INTO audit_event (workspace, actor, operation_id, event, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(input.workspace, input.actor, input.operationId, "operationDiscarded", canonicalJson({ reason: input.reason }), unixNow());
      return true;
    })();
  } catch {
    return false;
  }
}

async function retryTransient<T>(action: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (!isTransientOperationError(error) || delay === undefined) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export function isTransientOperationError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if (isAccountSuspendedError(error)) return false;
  if (
    "status" in error &&
    typeof error.status === "number" &&
    (TRANSIENT_HTTP_STATUSES.has(error.status) || (error.status >= 500 && error.status <= 599))
  ) {
    return true;
  }
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  if (code && TRANSIENT_NETWORK_CODES.has(code)) return true;
  if (
    error instanceof TypeError &&
    "cause" in error &&
    error.cause &&
    typeof error.cause === "object" &&
    "code" in error.cause &&
    typeof error.cause.code === "string" &&
    TRANSIENT_NETWORK_CODES.has(error.cause.code)
  ) {
    return true;
  }
  return false;
}

function persistHeartbeatLossIfOwned(
  raw: ReturnType<typeof getRawDb>,
  ownerActor: OperatorActor,
  auditActor: OperatorActor,
  operationId: string,
  requestHash: string,
  lockToken: string,
  error: unknown,
): void {
  try {
    refreshWorkspaceLock(ownerActor.workspace.authorityDid, lockToken);
    const message = safeOperationError(error);
    const timestamp = unixNow();
    const result = raw
      .prepare(
        "UPDATE operation SET state = 'pending', error = ?, updated_at = ? WHERE workspace = ? AND actor = ? AND operation_id = ? AND request_hash = ? AND state = 'running'",
      )
      .run(message, timestamp, ownerActor.workspace.authorityDid, ownerActor.did, operationId, requestHash);
    if (result.changes === 1) audit(auditActor, operationId, "operationPending", { error: message, reason: "heartbeatLost" });
  } catch {
    // Lock loss or database failure must not replace another runner's journal state.
  }
}

export function getActorOperation(actor: OperatorActor, operationId: string): OperationView | null {
  const row = getRawDb()
    .prepare(
      "SELECT request_hash, workspace_uri, state, steps_json, taken_over_by, error, updated_at FROM operation WHERE workspace = ? AND actor = ? AND operation_id = ?",
    )
    .get(actor.workspace.authorityDid, actor.did, operationId) as
    | (StoredOperationRow & { workspace_uri: string | null })
    | undefined;
  if (row && row.workspace_uri !== actor.workspace.uri) return null;
  return row
    ? operationView(
        operationId,
        row.request_hash,
        row.state,
        parseSteps(row.steps_json),
        row.error,
        row.updated_at,
        row.taken_over_by,
      )
    : null;
}

export function findActorOperationWorkspaceDid(actorDid: string, operationId: string): string | null {
  const row = getRawDb()
    .prepare("SELECT workspace FROM operation WHERE actor = ? AND operation_id = ? LIMIT 1")
    .get(actorDid, operationId) as { workspace: string } | undefined;
  return row?.workspace ?? null;
}

export function hasJournaledOperation(actor: OperatorActor, operationId: string, request: Record<string, unknown>): boolean {
  return getActorOperation(actor, operationId)?.requestHash === operationRequestHash(actor, request);
}

function operationRequestHash(actor: OperatorActor, request: Record<string, unknown>): string {
  return requestDigest({ workspace: actor.workspace.uri, request });
}

export type StalledOperations = {
  operations: Array<{ actor: string; operationId: string; state: OperationState; error: string | null; updatedAt: string }>;
  truncated: boolean;
};

export function listStalledOperations(workspaceDid: string, workspaceUri: string, stallSeconds = 300): StalledOperations {
  const cutoff = unixNow() - stallSeconds;
  const rows = getRawDb()
    .prepare(
      `SELECT actor, operation_id, request_json, state, error, updated_at FROM operation
       WHERE workspace = ? AND workspace_uri = ? AND state IN ('pending','running') AND updated_at <= ? ORDER BY updated_at ASC LIMIT ?`,
    )
    .all(workspaceDid, workspaceUri, cutoff, MAX_STALLED_OPERATIONS + 1) as Array<{
    actor: string;
    operation_id: string;
    request_json: string;
    state: OperationState;
    error: string | null;
    updated_at: number;
  }>;
  return {
    operations: rows.slice(0, MAX_STALLED_OPERATIONS).map((row) => ({
      actor: row.actor,
      operationId: row.operation_id,
      state: row.state,
      error: row.error,
      updatedAt: new Date(row.updated_at * 1000).toISOString(),
    })),
    truncated: rows.length > MAX_STALLED_OPERATIONS,
  };
}

export function listRecoverableOperations(
  workspaceDid: string,
  workspaceUri: string,
): Array<{ actor: string; operationId: string; requestJson: string; completedSteps: string[] }> {
  const rows = getRawDb()
    .prepare(
      `SELECT actor, operation_id, request_json, steps_json FROM operation
       WHERE workspace = ? AND workspace_uri = ? AND state IN ('queued','running','pending') ORDER BY created_at ASC LIMIT ?`,
    )
    .all(workspaceDid, workspaceUri, MAX_RECOVERABLE_OPERATIONS + 1) as Array<{
    actor: string;
    operation_id: string;
    request_json: string;
    steps_json: string;
  }>;
  if (rows.length > MAX_RECOVERABLE_OPERATIONS) {
    throw new OperationBusyError(
      `Workspace has more than ${MAX_RECOVERABLE_OPERATIONS} recoverable operations; automatic recovery is paused.`,
    );
  }
  return rows.map((row) => ({
    actor: row.actor,
    operationId: row.operation_id,
    requestJson: row.request_json,
    completedSteps: stepsOrNone(row.steps_json),
  }));
}

export function listJournaledWorkspaces(): Array<{ authorityDid: string; uri: string }> {
  const rows = getRawDb()
    .prepare("SELECT workspace, workspace_uri FROM operation_workspace_catalog ORDER BY workspace, workspace_uri LIMIT ?")
    .all(MAX_JOURNALED_WORKSPACES + 1) as Array<{ workspace: string; workspace_uri: string }>;
  if (rows.length > MAX_JOURNALED_WORKSPACES) {
    throw new OperationBusyError(`Journal catalog exceeds ${MAX_JOURNALED_WORKSPACES} workspaces; scheduled reconciliation is paused.`);
  }
  return rows.map((row) => ({ authorityDid: row.workspace, uri: row.workspace_uri }));
}

export function auditOperatorRead(actor: OperatorActor, event: string, details: Record<string, unknown> = {}): void {
  audit(actor, "", event, details);
}

export function auditOperationEvent(actor: OperatorActor, operationId: string, event: string, details: Record<string, unknown>): void {
  audit(actor, operationId, event, details);
}

export function operationView(
  operationId: string,
  requestHash: string,
  state: OperationState,
  steps: string[],
  error: string | null | undefined,
  updatedAt: number,
  takenOverBy?: string | null,
): OperationView {
  return {
    operationId,
    requestHash,
    state,
    completedSteps: steps,
    ...(takenOverBy ? { takenOverBy } : {}),
    ...(error ? { error } : {}),
    updatedAt: new Date(updatedAt * 1000).toISOString(),
  };
}

export function stepMatcher(steps: readonly string[]): (name: string) => boolean {
  const patterns = steps.map(
    (step) => new RegExp(`^${step.split(/\{[^}]+\}/).map((part) => part.replace(/[.*+?^$()|[\]\\]/g, "\\$&")).join(".+")}$`),
  );
  return (name) => patterns.some((pattern) => pattern.test(name));
}

function stepsOrNone(value: string): string[] {
  try {
    return parseSteps(value);
  } catch {
    return [];
  }
}

export function othersHaveUnfinishedOperation(workspaceDid: string, workspaceUri: string, actorDid: string): boolean {
  return (
    getRawDb()
      .prepare(
        "SELECT 1 FROM operation WHERE workspace = ? AND workspace_uri = ? AND actor != ? AND state NOT IN ('completed', 'failed', 'aborted_actor_revoked') LIMIT 1",
      )
      .get(workspaceDid, workspaceUri, actorDid) !== undefined
  );
}

export function operationRowExists(workspaceDid: string, actorDid: string, operationId: string): boolean {
  return (
    getRawDb()
      .prepare("SELECT 1 FROM operation WHERE workspace = ? AND actor = ? AND operation_id = ?")
      .get(workspaceDid, actorDid, operationId) !== undefined
  );
}

function parseSteps(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error("Operation journal has invalid step state.");
  }
  return parsed;
}

function safeOperationError(error: unknown): string {
  const message = error instanceof Error ? error.message : "OperationFailed";
  return message.replace(/[\r\n\t]/g, " ").slice(0, 300);
}

function audit(actor: OperatorActor, operationId: string, event: string, details: Record<string, unknown>): void {
  getRawDb()
    .prepare("INSERT INTO audit_event (workspace, actor, operation_id, event, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(actor.workspace.authorityDid, actor.did, operationId, event, canonicalJson(details), unixNow());
}

async function acquireWorkspaceLock(workspace: string): Promise<{ token: string }> {
  const raw = getRawDb();
  const token = randomUUID();
  const maxAttempts = Math.ceil(WORKSPACE_LOCK_ACQUIRE_WAIT_MS / WORKSPACE_LOCK_POLL_MS);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const now = unixNow();
    const result = raw
      .prepare(
        `INSERT INTO workspace_lock (workspace, token, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(workspace) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at
         WHERE workspace_lock.expires_at <= ?`,
      )
      .run(workspace, token, now + WORKSPACE_LOCK_LEASE_SECONDS, now);
    if (result.changes === 1) return { token };
    await new Promise((resolve) => setTimeout(resolve, WORKSPACE_LOCK_POLL_MS));
  }
  throw new OperationBusyError("Workspace has another operation running.");
}

function refreshWorkspaceLock(workspace: string, token: string): void {
  const result = getRawDb()
    .prepare("UPDATE workspace_lock SET expires_at = ? WHERE workspace = ? AND token = ?")
    .run(unixNow() + WORKSPACE_LOCK_LEASE_SECONDS, workspace, token);
  if (result.changes !== 1) throw new OperationBusyError("Workspace operation lock was lost.");
}

function releaseWorkspaceLock(workspace: string, token: string): void {
  getRawDb().prepare("DELETE FROM workspace_lock WHERE workspace = ? AND token = ?").run(workspace, token);
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}
