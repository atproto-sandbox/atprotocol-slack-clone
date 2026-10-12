import type { OAuthSession } from "@atproto/oauth-client-node";
import { getRawDb } from "@/lib/db";
import { canonicalJson, requestDigest, stableHash, subjectKey, channelUri, workspaceUri, inboxUri } from "@/protocol/keys";
import { ensureMemberListSpace, putAuthorityRecord } from "@/atproto/space-ops";
import { isScopeMissingError } from "@/atproto/xrpc";
import { discardEmptyOperationIfWorkspaceLockOwned, listRecoverableOperations, persistPendingIfWorkspaceLockOwned, withWorkspaceLock, type WorkspaceLock } from "@/operator/journal";
import { assertAdminMutationsEnabled } from "@/operator/mutations-paused";

export type BootstrapResult = {
  operationId: string; workspace: string; channel: string; state: string; completedSteps: string[]; error?: string;
  /** Setup is waiting on the user to approve the workspace-authority permission, not on a retry. */
  authorizationRequired?: true;
};

export async function bootstrapWorkspace(session: OAuthSession, input: { name: string; operationId: string }): Promise<BootstrapResult> {
  assertAdminMutationsEnabled();
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,59}$/.test(input.name.trim())) {
    throw new Error("Workspace name must be 1 to 60 plain-text characters.");
  }
  if (!/^[234567abcdefghijklmnopqrstuvwxyz]{13}$/.test(input.operationId)) throw new Error("Operation ID must be a protocol TID.");
  return withWorkspaceLock(session.did, (lock) => bootstrapWorkspaceLocked(session, input, lock));
}

export async function resumePendingWorkspaceBootstraps(session: OAuthSession, workspace: string): Promise<BootstrapResult[]> {
  const match = /^at:\/\/(did:[^/]+)\/space\/org\.slack\.workspace\/[A-Za-z0-9._~:-]{1,128}$/.exec(workspace);
  if (!match || match[1] !== session.did) throw new Error("Workspace bootstrap recovery requires its authority session.");
  const pending = listRecoverableOperations(session.did, workspace).filter((row) => row.actor === session.did);
  const results: BootstrapResult[] = [];
  for (const row of pending) {
    let saved: unknown;
    try { saved = JSON.parse(row.requestJson); }
    catch { continue; }
    if (!isPlainObject(saved) || saved.workspace !== workspace || !isPlainObject(saved.request) || saved.request.kind !== "bootstrapWorkspace") continue;
    if (typeof saved.request.name !== "string") throw new Error("Pending workspace bootstrap has an invalid name.");
    results.push(await bootstrapWorkspace(session, { name: saved.request.name, operationId: row.operationId }));
  }
  return results;
}

async function bootstrapWorkspaceLocked(session: OAuthSession, input: { name: string; operationId: string }, lock: WorkspaceLock): Promise<BootstrapResult> {
  const workspaceSkey = workspaceKey(input.name.trim());
  const workspace = workspaceUri(session.did, workspaceSkey);
  const inbox = inboxUri(session.did, workspaceSkey);
  const generalSkey = `${workspaceSkey}-general`;
  const channel = channelUri(session.did, generalSkey);
  const request = { kind: "bootstrapWorkspace", name: input.name.trim() };
  const requestJson = canonicalJson({ workspace, request });
  const requestHash = requestDigest({ workspace, request });
  const raw = getRawDb();
  lock.refresh();
  const now = Math.floor(Date.now() / 1000);
  const existing = raw.prepare("SELECT request_hash, steps_json, state FROM operation WHERE workspace = ? AND actor = ? AND operation_id = ?")
    .get(session.did, session.did, input.operationId) as { request_hash: string; steps_json: string; state: string } | undefined;
  if (existing && existing.request_hash !== requestHash) throw new Error("OperationIdConflict");
  if (!existing) {
    raw.transaction(() => {
      raw.prepare("INSERT INTO operation (workspace, workspace_uri, actor, operation_id, request_hash, request_json, state, steps_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'running', '[]', ?, ?)")
        .run(session.did, workspace, session.did, input.operationId, requestHash, requestJson, now, now);
      raw.prepare("INSERT OR IGNORE INTO operation_workspace_catalog (workspace, workspace_uri) VALUES (?, ?)")
        .run(session.did, workspace);
    })();
  } else {
    raw.prepare("INSERT OR IGNORE INTO operation_workspace_catalog (workspace, workspace_uri) VALUES (?, ?)")
      .run(session.did, workspace);
    if (existing.state === "completed") {
      return { operationId: input.operationId, workspace, channel, state: existing.state, completedSteps: JSON.parse(existing.steps_json) as string[] };
    }
    // Resuming: mark it running again so a failure at the first remaining step is recorded as pending.
    raw.prepare("UPDATE operation SET state = 'running', error = NULL, updated_at = ? WHERE workspace = ? AND actor = ? AND operation_id = ? AND state = 'pending'")
      .run(now, session.did, session.did, input.operationId);
  }

  const completed = existing ? JSON.parse(existing.steps_json) as string[] : [];
  const mark = (step: string) => {
    if (!completed.includes(step)) completed.push(step);
    raw.prepare("UPDATE operation SET steps_json = ?, state = 'running', error = NULL, updated_at = ? WHERE workspace = ? AND actor = ? AND operation_id = ?")
      .run(JSON.stringify(completed), Math.floor(Date.now() / 1000), session.did, session.did, input.operationId);
  };
  const run = async (step: string, operation: () => Promise<void>) => {
    if (completed.includes(step)) return;
    lock.refresh();
    await operation();
    lock.refresh();
    mark(step);
    raw.prepare("INSERT INTO audit_event (workspace, actor, operation_id, event, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(session.did, session.did, input.operationId, step, "{}", Math.floor(Date.now() / 1000));
  };

  try {
    await run("workspace-space", async () => { await ensureMemberListSpace(session, "org.slack.workspace", workspaceSkey); });
    await run("inbox-space", async () => {
      const actual = await ensureMemberListSpace(session, "org.slack.inbox", workspaceSkey);
      if (actual !== inbox) throw new Error("Inbox URI did not match the workspace key.");
    });
    await run("general-channel-space", async () => { await ensureMemberListSpace(session, "org.slack.channel", generalSkey); });
    await run("workspace-profile", async () => {
      await putAuthorityRecord(session, workspace, "org.slack.workspace.profile", "self", {
        name: input.name.trim(), createdAt: new Date().toISOString(),
      });
    });
    await run("owner-roster", async () => {
      await putAuthorityRecord(session, workspace, "org.slack.workspace.roster", subjectKey(session.did), {
        subject: session.did, active: true, updatedAt: new Date().toISOString(),
      });
    });
    await run("owner-admin", async () => {
      await putAuthorityRecord(session, workspace, "org.slack.admin", subjectKey(session.did), {
        subject: session.did, active: true, updatedAt: new Date().toISOString(),
      });
    });
    await run("general-directory", async () => {
      await putAuthorityRecord(session, workspace, "org.slack.directory", generalSkey, {
        skey: generalSkey, name: "general", visibility: "public",
      });
    });
    lock.refresh();
    raw.prepare("UPDATE operation SET state = 'completed', error = NULL, steps_json = ?, updated_at = ? WHERE workspace = ? AND actor = ? AND operation_id = ?")
      .run(JSON.stringify(completed), Math.floor(Date.now() / 1000), session.did, session.did, input.operationId);
    return { operationId: input.operationId, workspace, channel, state: "completed", completedSteps: completed };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : "WorkspaceSetupFailed";
    const authorizationRequired = isScopeMissingError(error);
    // Waiting on the user's approval with nothing done yet: leave no journal row to recover or alert on.
    if (authorizationRequired && completed.length === 0 && discardEmptyOperationIfWorkspaceLockOwned({
      workspace: session.did, workspaceUri: workspace, actor: session.did, operationId: input.operationId, lock, reason: "authorizationRequired",
    })) {
      return { operationId: input.operationId, workspace, channel, state: "pending", completedSteps: completed, error: message, authorizationRequired: true };
    }
    const persisted = persistPendingIfWorkspaceLockOwned({
      workspace: session.did,
      actor: session.did,
      operationId: input.operationId,
      requestHash,
      lock,
      completedSteps: completed,
      error,
    });
    if (!persisted) throw error;
    return {
      operationId: input.operationId, workspace, channel, state: "pending", completedSteps: completed, error: message,
      ...(authorizationRequired ? { authorizationRequired: true as const } : {}),
    };
  }
}

function workspaceKey(name: string): string {
  const slug = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "team";
  return `${slug.slice(0, 42)}-${stableHash(name).slice(0, 10)}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
