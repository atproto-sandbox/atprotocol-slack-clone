import { listSpaceMembers } from "@/atproto/space-ops";
import { inboxUri, isDid, isSkey, isTid } from "@/protocol/keys";
import { OPERATOR_METHOD } from "@/protocol/nsids";
import type { OperatorActor, WorkspaceRef } from "./actor";
import { AuthorityReauthorizationRequiredError } from "./authority-grant";
import { OperatorAuthError } from "./errors";
import { auditOperationEvent, listRecoverableOperations, OperationBusyError, runJournaledOperation, type OperationView } from "./journal";
import { operationKind } from "./kinds";
import type { OperationKind, OperatorRequest } from "./kinds/kind";
import { assertAdminMutationsEnabled } from "./mutations-paused";
import { parseJoinRequestUri } from "./workspace-state";

// Dispatch for journaled operator operations: validate a request against its kind, recover earlier pending operations,
// and run the kind's steps under the journal. What each kind does lives in ./kinds, one file per kind.

export async function executeOperatorOperation(
  actor: OperatorActor,
  operationId: string,
  rawRequest: unknown,
): Promise<OperationView> {
  assertAdminMutationsEnabled();
  const { kind, request } = validateOperatorRequest(rawRequest, actor, "execute");
  assertMayStartKind(kind, actor.did, actor.workspace);
  const current = (row: { actor: string; operationId: string }) => row.actor === actor.did && row.operationId === operationId;
  const pending = listRecoverableOperations(actor.workspace.authorityDid, actor.workspace.uri).filter((row) => !current(row));
  if (actor.canRecoverOperations) await resumeRecoverableOperations(actor, operationId);
  else if (pending.length > 0) throw new OperationBusyError("Pending admin operations must be recovered by an active admin before member leave can proceed.");
  return runJournaledOperation(actor, operationId, request, kind.steps, (context) => kind.run(actor, context, request));
}

async function resumeRecoverableOperations(actor: OperatorActor, currentOperationId: string): Promise<void> {
  const pending = savedWorkspaceOperations(listRecoverableOperations(actor.workspace.authorityDid, actor.workspace.uri), actor, currentOperationId);
  let awaitingApproval = false;
  for (const row of pending) {
    try {
      if (!row.request) throw new Error("Journaled operation request is unreadable.");
      // The row was created only after its actor passed service-auth and PDS role checks. The current admin authorizes
      // recovery; the original DID remains the operation and audit principal even if a removal was partial. A workspace
      // creation stays with its authority.
      const priorActor = { ...actor, did: row.actor };
      const { kind, request } = validateOperatorRequest(row.request, priorActor, "journal");
      assertMayStartKind(kind, actor.did, actor.workspace);
      assertMayStartKind(kind, row.actor, actor.workspace);
      const view = await runJournaledOperation(priorActor, row.operationId, request, kind.steps, (context) => kind.run(priorActor, context, request), { replay: true });
      awaitingApproval ||= view.authorizationRequired === true;
    } catch (error) {
      // Leave the row pending for an active admin to inspect; never reconcile around it.
      auditOperationEvent(actor, row.operationId, "operationResumeFailed", { originalActor: row.actor, error: error instanceof Error ? error.message : "Unknown error" });
    }
  }
  // Nothing else may run until the authority approves what the pending operations need.
  if (awaitingApproval) throw new AuthorityReauthorizationRequiredError(actor.workspace.authorityDid);
  // Unreadable rows cannot be replayed or cleared in-app; they stay visible in the
  // audit log and stalled-operation alert instead of wedging every admin action.
  const remaining = savedWorkspaceOperations(listRecoverableOperations(actor.workspace.authorityDid, actor.workspace.uri), actor, currentOperationId)
    .filter((row) => row.request !== null);
  if (remaining.length > 0) {
    throw new Error(`Pending workspace operations could not be resumed (${remaining.map((row) => row.operationId).join(", ")}); membership reconciliation was skipped.`);
  }
}

export function savedWorkspaceOperations(
  rows: Array<{ actor: string; operationId: string; requestJson: string }>,
  actor: Pick<OperatorActor, "did" | "workspace">,
  currentOperationId: string,
): Array<{ actor: string; operationId: string; request: Record<string, unknown> | null }> {
  return rows
    .filter((row) => !(row.actor === actor.did && row.operationId === currentOperationId))
    .flatMap((row) => {
      let saved: unknown;
      try { saved = JSON.parse(row.requestJson); }
      catch { return [{ actor: row.actor, operationId: row.operationId, request: null }]; }
      if (isPlainObject(saved) && saved.workspace !== actor.workspace.uri) return [];
      const request = isPlainObject(saved) && isPlainObject(saved.request) ? saved.request : null;
      return [{ actor: row.actor, operationId: row.operationId, request }];
    });
}

export async function listInboxWriters(actor: OperatorActor): Promise<{ inbox: string; writers: string[]; checkedAt: string }> {
  const inbox = inboxUri(actor.workspace.authorityDid, actor.workspace.skey);
  const members = await listSpaceMembers(actor.session, inbox);
  return { inbox, writers: members.filter((member) => member.write).map((member) => member.did).sort(), checkedAt: new Date().toISOString() };
}

/** A kind only the authority may start runs for the authority alone: whoever submits it, and whoever recovers it. */
export function assertMayStartKind(kind: OperationKind, actorDid: string, workspace: WorkspaceRef): void {
  if (kind.actor === "authority" && actorDid !== workspace.authorityDid) throw new OperatorAuthError("Only the workspace authority can run this operation.");
}

/** The rule for each request field, wherever it appears. Every field a kind declares has one (kinds.test.ts checks it). */
export const FIELD_RULES: Record<string, (value: unknown, actor: OperatorActor) => string | null> = {
  subject: (value) => isDid(value) ? null : "Invalid subject DID.",
  active: (value) => typeof value === "boolean" ? null : "Admin state must be boolean.",
  skey: (value) => isSkey(value) ? null : "Invalid channel key.",
  name: (value) => typeof value === "string" && value.trim().length >= 1 && Array.from(value).length <= 80 ? null : "Channel name must contain 1 to 80 characters.",
  visibility: (value) => value === "public" || value === "private" ? null : "Invalid channel visibility.",
  members: (value) => Array.isArray(value) && value.length <= 200 && value.every(isDid) && new Set(value).size === value.length ? null : "Channel members must be at most 200 unique DIDs.",
  request: (value, actor) => typeof value === "string" && parseJoinRequestUri(value, actor.workspace.authorityDid, inboxUri(actor.workspace.authorityDid, actor.workspace.skey))
    ? null : "Invalid join request URI.",
  requestId: (value) => typeof value === "string" && isTid(value) ? null : "Invalid request generation.",
  decision: (value) => value === "approve" || value === "deny" ? null : "Invalid join decision.",
};

/**
 * Checks a request against its kind: exactly the kind's fields, each valid. A request submitted to the execute method must be
 * a kind submitted there; a journaled row may be any persisted kind.
 */
export function validateOperatorRequest(value: unknown, actor: OperatorActor, source: "execute" | "journal"): { kind: OperationKind; request: OperatorRequest } {
  if (!isPlainObject(value)) throw new Error("Operation request must be an object.");
  if (typeof value.kind !== "string") throw new Error("Operation kind is required.");
  const kind = operationKind(value.kind);
  if (!kind || (source === "execute" && kind.submittedThrough !== "execute")) throw new Error("Unsupported operation kind.");
  const allowed = new Set(["kind", "$type", ...kind.required, ...(kind.optional ?? [])]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || kind.required.some((key) => !(key in value))) {
    throw new Error("Operation has missing or unexpected fields.");
  }
  if (value.$type !== undefined && value.$type !== `${OPERATOR_METHOD.execute}#operationRequest`) throw new Error("Invalid operation type.");
  for (const [field, fieldValue] of Object.entries(value)) {
    if (field === "kind" || field === "$type") continue;
    // Every field a kind declares has a rule; one without a rule is refused rather than passed through unchecked.
    const problem = Object.hasOwn(FIELD_RULES, field) ? FIELD_RULES[field]!(fieldValue, actor) : `No rule checks the field ${field}.`;
    if (problem) throw new Error(problem);
  }
  const request = value as OperatorRequest;
  kind.validate?.(request);
  return { kind, request };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
