import type { OAuthSession } from "@atproto/oauth-client-node";
import { isExtensionId } from "@flock/protocol/extensions";
import {
  channelRoleKey,
  channelUri,
  inboxUri,
  isDid,
  isRecordKey,
  isSkey,
  isTid,
  parseSpaceUri,
  personalInboxUri,
  requestRecordKey,
} from "@flock/protocol/keys";
import {
  COLLECTION,
  ATGRP_COLLECTION,
  ATGRP_METHOD,
  ATGRP_SPACE_TYPE,
  OPERATOR_METHOD,
  SPACE_TYPE,
} from "@flock/protocol/nsids";
import { fitsDirectoryName } from "@flock/protocol/registry";
import {
  effectiveMemberPermissions,
  isEffectiveAdminMember,
  permissionsAllowRpc,
  permissionsAllowSpace,
} from "@flock/protocol/scopes";
import { WORKSPACE_ENVELOPE } from "@flock/protocol/workspace-summary";
import { parseWorkspaceRef, type OperatorActor, type WorkspaceRef } from "./actor";
import { AuthorityReauthorizationRequiredError } from "./authority-grant";
import { OperatorAuthError } from "./errors";
import {
  abortOperationActorRevoked,
  auditOperationEvent,
  completeSatisfiedMemberOperation,
  listRecoverableOperations,
  OperationBusyError,
  runJournaledOperation,
  type OperationView,
} from "./journal";
import { bootstrapWorkspaceKind } from "./kinds/bootstrap-workspace";
import { createWorkspaceKind, creationAdmission, creationResult, type WorkspaceCreation } from "./kinds/create-workspace";
import { operationKind } from "./kinds/index";
import type { OperationKind, OperatorRequest } from "./kinds/kind";
import { assertAdminMutationsEnabled } from "./mutations-paused";
import { afterOperation, type RegistrationDeps } from "./registrations";
import {
  assignableRolesForMember,
  canAssignRole,
  defaultRoleKeys,
  directoryRecords,
  parseJoinRequestUri,
  readGroupGovernanceState,
  type LiveGroupGovernanceState,
} from "./workspace-state";

export type ActorCapabilityOptions = {
  completedSteps?: readonly string[];
  isReplay?: boolean;
  isTakeover?: boolean;
};

export function isMemberOperationSatisfiedByState(
  state: LiveGroupGovernanceState,
  memberDid: string,
  request: OperatorRequest,
): boolean {
  const membership = state.memberships.get(memberDid);
  if (!membership) return true;
  if (request.kind === "leaveChannel" && typeof request.skey === "string" && isSkey(request.skey)) {
    return !membership.roles.includes(channelRoleKey(request.skey));
  }
  return false;
}

/**
 * Verifies live human membership (`actorDid !== groupDid && !knownAppSubjects.has(actorDid)`),
 * canonical `effectiveMemberPermissions` (`role.scopes` ∪ space-clamped `policy.grants[].scopes`),
 * and `assignable` coverage over every target role/member — NEVER gating on `acceptance/self`!
 */
export async function assertActorAuthorizedForOperation(
  session: OAuthSession,
  workspace: WorkspaceRef,
  actorDid: string,
  kind: OperationKind,
  request: OperatorRequest,
  options: ActorCapabilityOptions = {},
): Promise<LiveGroupGovernanceState> {
  const groupDid = workspace.authorityDid;
  assertMayStartKind(kind, actorDid, workspace);

  if (kind.actor === "authority") {
    return readGroupGovernanceState(session, groupDid);
  }

  const state = await readGroupGovernanceState(session, groupDid);
  if (actorDid === groupDid || state.knownAppSubjects.has(actorDid)) {
    throw new OperatorAuthError("Actor must be a human group member, not the group DID or an app principal.");
  }

  const completedSteps = options.completedSteps ?? [];

  // Allow self-removal / self-demotion final verification steps after the self-revoking step already committed.
  if (
    !options.isTakeover &&
    kind.endsOwnRole?.(request, actorDid) &&
    ((request.kind === "removeMember" && completedSteps.includes("remove-workspace-membership")) ||
      (request.kind === "leaveWorkspace" && completedSteps.includes("remove-workspace-membership")) ||
      (request.kind === "setAdmin" && completedSteps.includes("write-admin-inactive")) ||
      (request.kind === "leaveChannel" && completedSteps.includes("leave-channel-membership")))
  ) {
    return state;
  }

  const membership = state.memberships.get(actorDid);
  if (!membership || membership.roles.length === 0) {
    throw new OperatorAuthError("Actor is not an active member of this group.");
  }

  if (kind.actor === "creator") {
    if (!options.isTakeover && actorDid !== String(request.creator)) {
      throw new OperatorAuthError("Workspace creation must run as its creator.");
    }
    if (!isEffectiveAdminMember(actorDid, state, groupDid)) {
      throw new OperatorAuthError("Workspace creator does not hold effective admin permissions.");
    }
    return state;
  }

  if (kind.actor === "member") {
    if (!options.isReplay && completedSteps.length === 0) {
      const checkActor: OperatorActor = { did: actorDid, session, workspace, canRecoverOperations: false };
      await kind.authorizeMember?.(checkActor, request);
    }
    return state;
  }

  // `kind.actor === "admin"`: check canonical `effectiveMemberPermissions` + `assignable` coverage!
  if (isEffectiveAdminMember(actorDid, state, groupDid)) {
    return state;
  }

  const perms = effectiveMemberPermissions(state, groupDid, actorDid);
  const assignable = assignableRolesForMember(state, actorDid);
  const membersTarget = { spaceDid: groupDid, spaceType: ATGRP_SPACE_TYPE.members, skey: "self" };
  const workspaceTarget = { spaceDid: groupDid, spaceType: SPACE_TYPE.workspace, skey: workspace.skey };
  const inboxTarget = { spaceDid: groupDid, spaceType: SPACE_TYPE.inbox, skey: workspace.skey };

  switch (request.kind) {
    case "inviteMember": {
      const defaults = defaultRoleKeys(state);
      const rolesToAssign = defaults.length > 0 ? defaults : ["member"];
      const canWriteMembership =
        permissionsAllowSpace(perms, membersTarget, { action: "create", collection: ATGRP_COLLECTION.membership }) &&
        permissionsAllowSpace(perms, membersTarget, { action: "update", collection: ATGRP_COLLECTION.membership });
      if (!canWriteMembership || !rolesToAssign.every((r) => canAssignRole(assignable, r))) {
        throw new OperatorAuthError("Actor lacks membership write or assignable permission for inviteMember.");
      }
      if (request.expiresAt !== undefined) {
        const parsedInvites = parseSpaceUri(personalInboxUri(String(request.subject)))!;
        if (
          !permissionsAllowSpace(
            perms,
            {
              spaceDid: parsedInvites.authorityDid,
              spaceType: parsedInvites.type,
              skey: parsedInvites.skey,
            },
            { action: "create", collection: ATGRP_COLLECTION.invite },
          )
        ) {
          throw new OperatorAuthError("Actor lacks invite write permission.");
        }
      }
      return state;
    }

    case "removeMember": {
      const subject = String(request.subject);
      const targetRoles = state.memberships.get(subject)?.roles ?? ["member"];
      if (
        !permissionsAllowSpace(perms, membersTarget, { action: "delete", collection: ATGRP_COLLECTION.membership }) ||
        !targetRoles.every((r) => canAssignRole(assignable, r))
      ) {
        throw new OperatorAuthError("Actor lacks membership delete or assignable coverage over target member's roles.");
      }
      return state;
    }

    case "setAdmin": {
      if (
        !permissionsAllowSpace(perms, membersTarget, { action: "update", collection: ATGRP_COLLECTION.membership }) ||
        !canAssignRole(assignable, "admin")
      ) {
        throw new OperatorAuthError("Actor lacks membership update or assignable coverage over 'admin' role.");
      }
      return state;
    }

    case "createChannel": {
      const rawSkey = String(request.skey);
      const chSkey = workspace.skey === "self" ? rawSkey : `${workspace.skey}-${rawSkey}`;
      const chTarget = { spaceDid: groupDid, spaceType: SPACE_TYPE.channel, skey: chSkey };
      const ok =
        permissionsAllowSpace(perms, chTarget, { manage: "create" }) &&
        permissionsAllowSpace(perms, workspaceTarget, { action: "create", collection: COLLECTION.directory }) &&
        permissionsAllowSpace(perms, workspaceTarget, { action: "update", collection: COLLECTION.directory });
      if (!ok) throw new OperatorAuthError("Actor lacks channel creation or directory write permissions.");
      if (request.visibility === "private") {
        const privRole = channelRoleKey(chSkey);
        const privOk =
          permissionsAllowSpace(perms, membersTarget, { action: "create", collection: ATGRP_COLLECTION.role }) &&
          permissionsAllowSpace(perms, membersTarget, { action: "update", collection: ATGRP_COLLECTION.membership }) &&
          canAssignRole(assignable, privRole);
        if (!privOk) throw new OperatorAuthError("Actor lacks role/assignable permissions for private channel creation.");
      }
      return state;
    }

    case "transitionChannel": {
      const chSkey = String(request.skey);
      const chTarget = { spaceDid: groupDid, spaceType: SPACE_TYPE.channel, skey: chSkey };
      const privRole = channelRoleKey(chSkey);
      const ok =
        permissionsAllowSpace(perms, chTarget, { manage: "update" }) &&
        permissionsAllowSpace(perms, workspaceTarget, { action: "update", collection: COLLECTION.directory }) &&
        permissionsAllowSpace(perms, membersTarget, { action: "create", collection: ATGRP_COLLECTION.role }) &&
        permissionsAllowSpace(perms, membersTarget, { action: "update", collection: ATGRP_COLLECTION.membership }) &&
        canAssignRole(assignable, privRole);
      if (!ok) throw new OperatorAuthError("Actor lacks permissions to transition channel visibility.");
      return state;
    }

    case "archiveChannel": {
      const chSkey = String(request.skey);
      const chTarget = { spaceDid: groupDid, spaceType: SPACE_TYPE.channel, skey: chSkey };
      const privRole = channelRoleKey(chSkey);
      const ok =
        permissionsAllowSpace(perms, chTarget, { manage: "update" }) &&
        permissionsAllowSpace(perms, workspaceTarget, { action: "update", collection: COLLECTION.directory }) &&
        permissionsAllowSpace(perms, membersTarget, { action: "update", collection: ATGRP_COLLECTION.membership }) &&
        permissionsAllowSpace(perms, membersTarget, { action: "delete", collection: ATGRP_COLLECTION.role }) &&
        canAssignRole(assignable, privRole);
      if (!ok) throw new OperatorAuthError("Actor lacks permissions to archive channel.");
      return state;
    }

    case "decideJoinRequest": {
      const canDecide =
        permissionsAllowSpace(perms, inboxTarget, { action: "read" }) &&
        permissionsAllowSpace(perms, inboxTarget, { action: "create", collection: COLLECTION.joinDecision }) &&
        permissionsAllowSpace(perms, inboxTarget, { action: "update", collection: COLLECTION.joinDecision });
      if (!canDecide) throw new OperatorAuthError("Actor lacks inbox read/joinDecision permissions.");
      if (request.decision === "approve") {
        if (!permissionsAllowSpace(perms, membersTarget, { action: "update", collection: ATGRP_COLLECTION.membership })) {
          throw new OperatorAuthError("Actor lacks membership update permission for channel approval.");
        }
        const parsedReq = parseJoinRequestUri(String(request.request), groupDid, inboxUri(groupDid, workspace.skey));
        if (parsedReq) {
          const tempActor: OperatorActor = { did: actorDid, session, workspace, canRecoverOperations: false };
          const channels = await directoryRecords(tempActor);
          const matched = channels.find(
            (rec) => requestRecordKey(channelUri(groupDid, rec.value.skey), parsedReq.repo) === parsedReq.rkey,
          );
          if (matched && !canAssignRole(assignable, channelRoleKey(matched.value.skey))) {
            throw new OperatorAuthError("Actor lacks assignable coverage over private channel role.");
          }
        }
        if (assignable.size === 0) {
          throw new OperatorAuthError("Actor holds no assignable roles.");
        }
      }
      return state;
    }

    case "decideGroupJoinRequest": {
      if (request.decision === "deny") {
        if (!permissionsAllowRpc(perms, groupDid, ATGRP_METHOD.denyJoinRequest)) {
          throw new OperatorAuthError("Actor lacks org.atgrp.denyJoinRequest permission.");
        }
        return state;
      }
      const requestedRoles = Array.isArray(request.roles)
        ? (request.roles as string[])
        : defaultRoleKeys(state);
      const rolesToCheck = requestedRoles.length > 0 ? requestedRoles : ["member"];
      const canApprove =
        permissionsAllowSpace(perms, membersTarget, { action: "create", collection: ATGRP_COLLECTION.membership }) &&
        permissionsAllowSpace(perms, membersTarget, { action: "update", collection: ATGRP_COLLECTION.membership }) &&
        rolesToCheck.every((r) => canAssignRole(assignable, r));
      if (!canApprove) {
        throw new OperatorAuthError("Actor lacks membership write or assignable coverage for decideGroupJoinRequest.");
      }
      return state;
    }

    default:
      throw new OperatorAuthError("Active workspace admin permission is required.");
  }
}

export async function executeOperatorOperation(
  actor: OperatorActor,
  operationId: string,
  rawRequest: unknown,
  registration?: RegistrationDeps,
): Promise<OperationView> {
  assertAdminMutationsEnabled();
  const { kind, request } = validateOperatorRequest(rawRequest, actor, "execute");
  assertMayStartKind(kind, actor.did, actor.workspace);
  const current = (row: { actor: string; operationId: string }) =>
    row.actor === actor.did && row.operationId === operationId;
  const pending = listRecoverableOperations(actor.workspace.authorityDid, actor.workspace.uri).filter(
    (row) => !current(row),
  );
  if (actor.canRecoverOperations) {
    await resumeRecoverableOperations(actor, operationId, registration);
  } else if (pending.length > 0) {
    throw new OperationBusyError(
      "Pending admin operations must be recovered by an active admin before member leave can proceed.",
    );
  }
  const view = await runJournaledOperation(
    actor,
    operationId,
    request,
    kind.steps,
    (context) => kind.run(actor, context, request),
    {
      beforeStep: (_stepName, completedSteps) =>
        assertActorAuthorizedForOperation(actor.session, actor.workspace, actor.did, kind, request, {
          completedSteps,
        }).then(() => undefined),
    },
  );
  if (registration) await safeAfterOperation(actor, actor, operationId, kind, request, view, registration);
  return view;
}

async function resumeRecoverableOperations(
  executorActor: OperatorActor,
  currentOperationId: string,
  registration?: RegistrationDeps,
): Promise<void> {
  const pending = savedWorkspaceOperations(
    listRecoverableOperations(executorActor.workspace.authorityDid, executorActor.workspace.uri),
    executorActor,
    currentOperationId,
  );
  let awaitingApproval = false;

  for (const row of pending) {
    let completed: { priorActor: OperatorActor; kind: OperationKind; request: OperatorRequest; view: OperationView } | undefined;
    try {
      if (!row.request) throw new Error("Journaled operation request is unreadable.");
      const ownerDid = row.actor;
      const priorActor: OperatorActor = { ...executorActor, did: ownerDid };
      const { kind, request } = validateOperatorRequest(row.request, priorActor, "journal");
      assertMayStartKind(kind, ownerDid, executorActor.workspace);
      assertMayResumeCreation(kind, executorActor.did, row);

      let ownerStillAuthorized = true;
      let revokeReason = "Original actor is no longer authorized.";
      try {
        await assertActorAuthorizedForOperation(
          executorActor.session,
          executorActor.workspace,
          ownerDid,
          kind,
          request,
          { completedSteps: row.completedSteps, isReplay: true },
        );
      } catch (authErr) {
        if (!(authErr instanceof OperatorAuthError)) throw authErr;
        ownerStillAuthorized = false;
        revokeReason = authErr.message;
      }

      if (ownerStillAuthorized) {
        const view = await runJournaledOperation(
          priorActor,
          row.operationId,
          request,
          kind.steps,
          (context) => kind.run(priorActor, context, request),
          {
            replay: true,
            beforeStep: (_stepName, completedSteps) =>
              assertActorAuthorizedForOperation(
                executorActor.session,
                executorActor.workspace,
                ownerDid,
                kind,
                request,
                { completedSteps, isReplay: true },
              ).then(() => undefined),
          },
        );
        awaitingApproval ||= view.authorizationRequired === true;
        completed = { priorActor, kind, request, view };
      } else {
        // Deterministic demoted/ejected original-actor recovery:
        const liveState = await readGroupGovernanceState(
          executorActor.session,
          executorActor.workspace.authorityDid,
        );

        // (1) Member self-service kind already satisfied by live state:
        if (kind.actor === "member" && isMemberOperationSatisfiedByState(liveState, ownerDid, request)) {
          const view = await completeSatisfiedMemberOperation(executorActor, ownerDid, row.operationId);
          if (view) completed = { priorActor, kind, request, view };
        } else if (row.completedSteps.length === 0) {
          // (2) Zero side effects committed -> terminal `aborted_actor_revoked`!
          await abortOperationActorRevoked(executorActor, ownerDid, row.operationId, revokeReason);
        } else {
          // (3) Partial durable state (`completedSteps.length >= 1`) -> verify `executorActor` independently holds
          // live `effectiveMemberPermissions` + `assignable` coverage (`403` if insufficient!) and replay under audited takeover!
          await assertActorAuthorizedForOperation(
            executorActor.session,
            executorActor.workspace,
            executorActor.did,
            kind,
            request,
            { completedSteps: row.completedSteps, isTakeover: true },
          );
          const view = await runJournaledOperation(
            priorActor,
            row.operationId,
            request,
            kind.steps,
            (context) => kind.run(priorActor, context, request),
            {
              replay: true,
              takeoverBy: executorActor,
              beforeStep: (_stepName, completedSteps) =>
                assertActorAuthorizedForOperation(
                  executorActor.session,
                  executorActor.workspace,
                  executorActor.did,
                  kind,
                  request,
                  { completedSteps, isTakeover: true },
                ).then(() => undefined),
            },
          );
          awaitingApproval ||= view.authorizationRequired === true;
          completed = { priorActor, kind, request, view };
        }
      }
    } catch (error) {
      if (error instanceof OperatorAuthError) {
        // Recovering admin lacks required capabilities/assignable coverage -> propagate 403 immediately!
        throw error;
      }
      auditOperationEvent(executorActor, row.operationId, "operationResumeFailed", {
        originalActor: row.actor,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
    if (completed && registration) {
      await safeAfterOperation(
        executorActor,
        completed.priorActor,
        row.operationId,
        completed.kind,
        completed.request,
        completed.view,
        registration,
      );
    }
  }

  if (awaitingApproval) throw new AuthorityReauthorizationRequiredError(executorActor.workspace.authorityDid);

  const remaining = savedWorkspaceOperations(
    listRecoverableOperations(executorActor.workspace.authorityDid, executorActor.workspace.uri),
    executorActor,
    currentOperationId,
  ).filter((row) => row.request !== null);
  if (remaining.length > 0) {
    throw new Error(
      `Pending workspace operations could not be resumed (${remaining.map((row) => row.operationId).join(", ")}); membership reconciliation was skipped.`,
    );
  }
}

export function savedWorkspaceOperations(
  rows: Array<{ actor: string; operationId: string; requestJson: string; completedSteps: string[] }>,
  actor: Pick<OperatorActor, "did" | "workspace">,
  currentOperationId: string,
): Array<{ actor: string; operationId: string; completedSteps: string[]; request: Record<string, unknown> | null }> {
  return rows
    .filter((row) => !(row.actor === actor.did && row.operationId === currentOperationId))
    .flatMap((row) => {
      let saved: unknown;
      try {
        saved = JSON.parse(row.requestJson);
      } catch {
        return [{ actor: row.actor, operationId: row.operationId, completedSteps: row.completedSteps, request: null }];
      }
      if (isPlainObject(saved) && saved.workspace !== actor.workspace.uri) return [];
      const request = isPlainObject(saved) && isPlainObject(saved.request) ? saved.request : null;
      return [{ actor: row.actor, operationId: row.operationId, completedSteps: row.completedSteps, request }];
    });
}

export function assertMayStartKind(kind: OperationKind, actorDid: string, workspace: WorkspaceRef): void {
  if (kind.actor === "authority" && actorDid !== workspace.authorityDid) {
    throw new OperatorAuthError("Only the workspace authority can run this operation.");
  }
}

export async function resumePendingWorkspaceCreations(
  grant: OAuthSession,
  workspace: string,
  registration?: RegistrationDeps,
): Promise<WorkspaceCreation[]> {
  const ref = parseWorkspaceRef(workspace);
  if (ref.authorityDid !== grant.did) throw new Error("Workspace creation recovery requires its authority's grant.");
  const operator: OperatorActor = { did: grant.did, session: grant, workspace: ref, canRecoverOperations: true };
  const results: WorkspaceCreation[] = [];
  for (const row of savedWorkspaceOperations(listRecoverableOperations(grant.did, workspace), operator, "")) {
    if (row.request?.kind !== createWorkspaceKind.kind && row.request?.kind !== bootstrapWorkspaceKind.kind) continue;
    const actor: OperatorActor = { ...operator, did: row.actor };
    let started: { kind: OperationKind; request: OperatorRequest };
    try {
      started = validateOperatorRequest(row.request, actor, "journal");
      assertMayStartKind(started.kind, row.actor, ref);
    } catch (error) {
      auditOperationEvent(operator, row.operationId, "operationResumeFailed", {
        originalActor: row.actor,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      continue;
    }
    const { kind, request } = started;
    const admission =
      kind === createWorkspaceKind ? creationAdmission(actor, String(request.name), row.operationId) : undefined;
    const view = await runJournaledOperation(
      actor,
      row.operationId,
      request,
      kind.steps,
      (context) => kind.run(actor, context, request),
      { admission },
    );
    if (registration) await safeAfterOperation(operator, actor, row.operationId, kind, request, view, registration);
    results.push(creationResult(actor, row.operationId, view));
  }
  return results;
}

async function safeAfterOperation(
  auditActor: OperatorActor,
  operationActor: OperatorActor,
  operationId: string,
  kind: Pick<OperationKind, "createsSpaces" | "archivesSpaces">,
  request: OperatorRequest,
  view: OperationView,
  registration: RegistrationDeps,
): Promise<void> {
  try {
    await afterOperation(operationActor, kind, request, view, registration);
  } catch (error) {
    auditOperationEvent(auditActor, operationId, "operationRegistrationFailed", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

export function assertMayResumeCreation(
  kind: OperationKind,
  recoveringDid: string,
  row: { actor: string; completedSteps: readonly string[] },
): void {
  if (
    kind.actor === "creator" &&
    recoveringDid !== row.actor &&
    row.completedSteps.length === 0 &&
    !row.completedSteps.includes("creator-admin")
  ) {
    throw new OperatorAuthError("Only its creator can resume a workspace creation before it has begun.");
  }
}

const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export const FIELD_RULES: Record<string, (value: unknown, actor: OperatorActor) => string | null> = {
  subject: (value) => (isDid(value) ? null : "Invalid subject DID."),
  member: (value) => (isDid(value) ? null : "Invalid member DID."),
  creator: (value) => (isDid(value) ? null : "Invalid creator DID."),
  roles: (value) =>
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= 64 &&
    value.every(isRecordKey) &&
    new Set(value).size === value.length
      ? null
      : "Roles must be 1 to 64 unique record keys.",
  active: (value) => (typeof value === "boolean" ? null : "Admin state must be boolean."),
  skey: (value) => (isSkey(value) ? null : "Invalid channel key."),
  extId: (value) => (isExtensionId(value) ? null : "Unknown extension id."),
  name: (value) =>
    typeof value === "string" && value.trim().length >= 1 && fitsDirectoryName(value)
      ? null
      : "Channel name must contain 1 to 80 characters.",
  visibility: (value) => (value === "public" || value === "private" ? null : "Invalid channel visibility."),
  members: (value) =>
    Array.isArray(value) && value.length <= 200 && value.every(isDid) && new Set(value).size === value.length
      ? null
      : "Channel members must be at most 200 unique DIDs.",
  channels: (value) =>
    Array.isArray(value) &&
    value.length <= WORKSPACE_ENVELOPE.channels &&
    value.every(isChannelGrant) &&
    new Set(value.map((grant) => grant.skey)).size === value.length
      ? null
      : `An app's channels must be at most ${WORKSPACE_ENVELOPE.channels} channels, each once, with a write flag.`,
  request: (value, actor) =>
    typeof value === "string" &&
    parseJoinRequestUri(value, actor.workspace.authorityDid, inboxUri(actor.workspace.authorityDid, actor.workspace.skey))
      ? null
      : "Invalid join request URI.",
  requestId: (value) => (typeof value === "string" && isTid(value) ? null : "Invalid request generation."),
  decision: (value) => (value === "approve" || value === "deny" ? null : "Invalid join decision."),
  expiresAt: (value) =>
    typeof value === "string" && ISO_DATETIME_RE.test(value) && Number.isFinite(Date.parse(value))
      ? null
      : "Invalid expiration datetime.",
  joinPolicy: (value) =>
    value === "open" || value === "approval" || value === "invite" ? null : "Invalid join policy.",
  publicMeta: (value) => (typeof value === "boolean" ? null : "publicMeta must be boolean."),
};

export function validateOperatorRequest(
  value: unknown,
  actor: OperatorActor,
  source: "execute" | "journal",
): { kind: OperationKind; request: OperatorRequest } {
  if (!isPlainObject(value)) throw new Error("Operation request must be an object.");
  if (typeof value.kind !== "string") throw new Error("Operation kind is required.");
  const kind = operationKind(value.kind);
  if (!kind || (source === "execute" && kind.submittedThrough !== "execute")) {
    throw new Error("Unsupported operation kind.");
  }
  const allowed = new Set(["kind", "$type", ...kind.required, ...(kind.optional ?? [])]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || kind.required.some((key) => !(key in value))) {
    throw new Error("Operation has missing or unexpected fields.");
  }
  if (value.$type !== undefined && value.$type !== `${OPERATOR_METHOD.execute}#operationRequest`) {
    throw new Error("Invalid operation type.");
  }
  for (const [field, fieldValue] of Object.entries(value)) {
    if (field === "kind" || field === "$type") continue;
    const problem = Object.hasOwn(FIELD_RULES, field)
      ? FIELD_RULES[field]!(fieldValue, actor)
      : `No rule checks the field ${field}.`;
    if (problem) throw new Error(problem);
  }
  const request = value as OperatorRequest;
  kind.validate?.(request);
  return { kind, request };
}

function isChannelGrant(value: unknown): value is { skey: string; write: boolean } {
  if (!isPlainObject(value) || !isSkey(value.skey) || typeof value.write !== "boolean") return false;
  return Object.keys(value).every(
    (key) => key === "skey" || key === "write" || (key === "$type" && value.$type === `${OPERATOR_METHOD.execute}#channelGrant`),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
