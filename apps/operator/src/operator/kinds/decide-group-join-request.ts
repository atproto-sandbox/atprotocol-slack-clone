import { XrpcError } from "@flock/protocol/atproto/xrpc";
import { OPENSOCIAL_METHOD } from "@flock/protocol/nsids";
import { WORKSPACE_ENVELOPE } from "@flock/protocol/workspace-summary";
import { sessionClient } from "../../atproto/client";
import type { OperatorActor } from "../actor";
import { OperationRejectedError, type OperationContext } from "../journal";
import {
  defaultRoleKeys,
  humanMemberDids,
  putMembershipRoles,
  readGroupGovernanceState,
} from "../workspace-state";
import type { OperationKind, OperatorRequest } from "./kind";

/**
 * Distinct Operator kind for OpenSocial group `approval` admission (`proposal.md:103`, Rev 29 §3.2 item 6.5):
 * - `"approve"` writes `group.opensocial.membership/<member>` with header `If-Join-Request-Present: true` so Group Host
 *   atomically verifies an unexpired `join_request`, creates `membership/<member>`, deletes `join_request`, and updates
 *   `join_operation_state` inside one synchronous `IMMEDIATE` transaction (`409 JoinRequestNotFound` if absent/cancelled/expired).
 * - `"deny"` calls `group.opensocial.denyJoinRequest({ member })`.
 */
export const decideGroupJoinRequestKind: OperationKind = {
  kind: "decideGroupJoinRequest",
  required: ["member", "decision"],
  optional: ["roles"],
  actor: "admin",
  submittedThrough: "execute",
  steps: ["group-join-approve-membership", "group-join-deny-request"],
  run: (actor, context, request) =>
    decideGroupJoinRequest(
      actor,
      context,
      request as OperatorRequest & { member: string; decision: "approve" | "deny"; roles?: string[] },
    ),
};

async function decideGroupJoinRequest(
  actor: OperatorActor,
  context: OperationContext,
  operation: OperatorRequest & { member: string; decision: "approve" | "deny"; roles?: string[] },
): Promise<void> {
  const groupDid = actor.workspace.authorityDid;
  const { member, decision } = operation;
  if (member === groupDid) {
    throw new OperationRejectedError("CannotTargetGroupSelf");
  }

  const state = await readGroupGovernanceState(actor.session, groupDid);
  if (state.knownAppSubjects.has(member)) {
    throw new OperationRejectedError("SubjectIsAppServicePrincipal");
  }

  if (decision === "approve") {
    const assignedRoles = operation.roles ?? defaultRoleKeys(state);
    if (assignedRoles.length === 0) {
      throw new OperationRejectedError("NoDefaultRole");
    }
    if (assignedRoles.length > WORKSPACE_ENVELOPE.maxRolesPerMember) {
      throw new OperationRejectedError(
        `Assigned roles exceed maximum (${WORKSPACE_ENVELOPE.maxRolesPerMember}).`,
      );
    }
    for (const r of assignedRoles) {
      if (!state.roles.has(r)) {
        throw new OperationRejectedError(`UnknownRole: ${r}`);
      }
    }
    const humans = humanMemberDids(state, groupDid);
    if (!humans.has(member) && humans.size >= WORKSPACE_ENVELOPE.members) {
      throw new OperationRejectedError(`Workspace member limit reached (${WORKSPACE_ENVELOPE.members}).`);
    }

    await context.step("group-join-approve-membership", async () => {
      const latest = await readGroupGovernanceState(actor.session, groupDid);
      // Idempotent on step replay if `membership/<member>` was already created before a lost response!
      if (latest.memberships.has(member)) return;
      try {
        await putMembershipRoles(actor.session, groupDid, member, assignedRoles, {
          ifJoinRequestPresent: true,
          existingRecord: null,
        });
      } catch (error) {
        if (error instanceof XrpcError && error.code === "JoinRequestNotFound") {
          throw new OperationRejectedError("JoinRequestNotFound");
        }
        throw error;
      }
    });
    return;
  }

  await context.step("group-join-deny-request", async () => {
    try {
      await sessionClient(actor.session).procedure<{ member: string }, Record<string, never>>(
        OPENSOCIAL_METHOD.denyJoinRequest,
        { member },
      );
    } catch (error) {
      if (error instanceof XrpcError && error.code === "JoinRequestNotFound") {
        if (context.replaying) {
          const latest = await readGroupGovernanceState(actor.session, groupDid);
          if (!latest.memberships.has(member)) return;
          throw new OperationRejectedError("JoinRequestAlreadyAdmitted");
        }
        throw new OperationRejectedError("JoinRequestNotFound");
      }
      throw error;
    }
  });
}
