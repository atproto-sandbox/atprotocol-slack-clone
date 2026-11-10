import type { OAuthSession } from "@atproto/oauth-client-node";
import { ensureMemberListSpace, putAuthorityRecord } from "@/atproto/space-ops";
import { channelUri, inboxUri, parseWorkspaceUri, stableHash, subjectKey, workspaceUri } from "@/protocol/keys";
import { COLLECTION, SPACE_TYPE } from "@/protocol/nsids";
import { listRecoverableOperations, OperationRejectedError, runJournaledOperation, type OperationContext } from "../journal";
import { assertAdminMutationsEnabled } from "../mutations-paused";
import { parseWorkspaceRef, type OperatorActor } from "../actor";
import type { OperationKind } from "./kind";

export type BootstrapResult = {
  operationId: string; workspace: string; channel: string; state: string; completedSteps: string[]; error?: string;
  /** Setup is waiting on the authority to approve its grant, not on a retry. */
  authorizationRequired?: true;
};

/** Creates a workspace for its authority: the three spaces, the profile, the authority's roster and admin records, #general. */
export const bootstrapWorkspaceKind: OperationKind = {
  kind: "bootstrapWorkspace",
  required: ["name"],
  actor: "authority",
  submittedThrough: "createWorkspace",
  steps: ["workspace-space", "inbox-space", "general-channel-space", "workspace-profile", "owner-roster", "owner-admin", "general-directory"],
  validate: (request) => assertWorkspaceName(String(request.name)),
  run: (actor, context, request) => runBootstrap(actor, context, String(request.name)),
};

/** Refuses a workspace name the app does not create, before anything else is asked of the account. */
export function assertWorkspaceName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,59}$/.test(name.trim())) {
    throw new Error("Workspace name must be 1 to 60 plain-text characters.");
  }
}

/** Creates (or resumes creating) the workspace named `name`, with the authority's grant session. */
export async function bootstrapWorkspace(session: OAuthSession, input: { name: string; operationId: string }): Promise<BootstrapResult> {
  assertAdminMutationsEnabled();
  assertWorkspaceName(input.name);
  if (!/^[234567abcdefghijklmnopqrstuvwxyz]{13}$/.test(input.operationId)) throw new Error("Operation ID must be a protocol TID.");
  const name = input.name.trim();
  const skey = workspaceKey(name);
  const actor: OperatorActor = { did: session.did, session, workspace: parseWorkspaceRef(workspaceUri(session.did, skey)), canRecoverOperations: true };
  const view = await runJournaledOperation(actor, input.operationId, { kind: bootstrapWorkspaceKind.kind, name }, bootstrapWorkspaceKind.steps,
    (context) => bootstrapWorkspaceKind.run(actor, context, { kind: bootstrapWorkspaceKind.kind, name }));
  return {
    operationId: input.operationId,
    workspace: actor.workspace.uri,
    channel: channelUri(session.did, generalKey(skey)),
    state: view.state,
    completedSteps: view.completedSteps,
    ...(view.error ? { error: view.error } : {}),
    ...(view.authorizationRequired ? { authorizationRequired: true as const } : {}),
  };
}

/** Resumes this authority's unfinished creations of `workspace`, before its admin records exist to authorize anything else. */
export async function resumePendingWorkspaceBootstraps(session: OAuthSession, workspace: string): Promise<BootstrapResult[]> {
  if (parseWorkspaceUri(workspace)?.authorityDid !== session.did) throw new Error("Workspace bootstrap recovery requires its authority session.");
  const results: BootstrapResult[] = [];
  for (const row of listRecoverableOperations(session.did, workspace).filter((entry) => entry.actor === session.did)) {
    let saved: unknown;
    try { saved = JSON.parse(row.requestJson); }
    catch { continue; }
    if (!isPlainObject(saved) || saved.workspace !== workspace || !isPlainObject(saved.request) || saved.request.kind !== bootstrapWorkspaceKind.kind) continue;
    if (typeof saved.request.name !== "string") throw new Error("Pending workspace bootstrap has an invalid name.");
    results.push(await bootstrapWorkspace(session, { name: saved.request.name, operationId: row.operationId }));
  }
  return results;
}

async function runBootstrap(actor: OperatorActor, context: OperationContext, name: string): Promise<void> {
  const { session } = actor;
  const { uri: workspace, skey } = actor.workspace;
  if (workspaceKey(name) !== skey) throw new OperationRejectedError("A workspace's key must be the one derived from its name.");
  const inbox = inboxUri(session.did, skey);
  const general = generalKey(skey);
  await context.step("workspace-space", async () => { await ensureMemberListSpace(session, SPACE_TYPE.workspace, skey); });
  await context.step("inbox-space", async () => {
    if (await ensureMemberListSpace(session, SPACE_TYPE.inbox, skey) !== inbox) throw new Error("Inbox URI did not match the workspace key.");
  });
  await context.step("general-channel-space", async () => { await ensureMemberListSpace(session, SPACE_TYPE.channel, general); });
  await context.step("workspace-profile", async () => {
    await putAuthorityRecord(session, workspace, COLLECTION.workspaceProfile, "self", { name, createdAt: new Date().toISOString() });
  });
  await context.step("owner-roster", async () => {
    await putAuthorityRecord(session, workspace, COLLECTION.workspaceRoster, subjectKey(session.did), { subject: session.did, active: true, updatedAt: new Date().toISOString() });
  });
  await context.step("owner-admin", async () => {
    await putAuthorityRecord(session, workspace, COLLECTION.admin, subjectKey(session.did), { subject: session.did, active: true, updatedAt: new Date().toISOString() });
  });
  await context.step("general-directory", async () => {
    await putAuthorityRecord(session, workspace, COLLECTION.directory, general, { skey: general, name: "general", visibility: "public" });
  });
}

function workspaceKey(name: string): string {
  const slug = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "team";
  return `${slug.slice(0, 42)}-${stableHash(name).slice(0, 10)}`;
}

function generalKey(workspaceSkey: string): string {
  return `${workspaceSkey}-general`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
