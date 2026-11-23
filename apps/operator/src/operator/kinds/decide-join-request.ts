import {
  channelRoleKey,
  channelUri,
  decisionRecordKey,
  groupMembersUri,
  inboxUri,
  requestRecordKey,
} from "@flock/protocol/keys";
import { COLLECTION, OPENSOCIAL_COLLECTION } from "@flock/protocol/nsids";
import { WORKSPACE_ENVELOPE } from "@flock/protocol/workspace-summary";
import { putAuthorityRecord } from "../../atproto/space-ops";
import type { OperatorActor } from "../actor";
import { OperationRejectedError, type OperationContext } from "../journal";
import {
  directoryRecords,
  getOwnerRecord,
  humanMemberDids,
  parseJoinRequestUri,
  putMembershipRoles,
  readGroupGovernanceState,
  readJoinRequest,
} from "../workspace-state";
import type { OperationKind, OperatorRequest } from "./kind";

/**
 * Preserved strictly for `SPACE_TYPE.inbox` private-channel join requests with its exact released shape
 * (`required: ["request", "requestId", "decision"]`) and exact 9 step names (Rev 29 §3.2 item 6.5), mapping
 * private-channel access onto `channel-<skey>` role assignment on `group.opensocial.membership/<requester>`
 * and making legacy channel-roster steps idempotent no-ops so pre-R13 pending journal rows replay cleanly!
 */
export const decideJoinRequestKind: OperationKind = {
  kind: "decideJoinRequest",
  required: ["request", "requestId", "decision"],
  actor: "admin",
  submittedThrough: "execute",
  steps: [
    "join-request-baseline-{state}",
    "join-request-inactive-revoke-membership",
    "join-request-inactive-deactivate-roster",
    "join-request-channel-membership",
    "join-request-private-roster",
    "join-request-decision",
    "join-request-approved-membership-verified",
    "join-request-stale-restore-membership",
    "join-request-stale-restore-roster",
  ],
  run: (actor, context, request) =>
    decideJoinRequest(
      actor,
      context,
      request as OperatorRequest & { request: string; requestId: string; decision: "approve" | "deny" },
    ),
};

async function decideJoinRequest(
  actor: OperatorActor,
  context: OperationContext,
  operation: OperatorRequest & { request: string; requestId: string; decision: "approve" | "deny" },
): Promise<void> {
  const groupDid = actor.workspace.authorityDid;
  const inbox = inboxUri(groupDid, actor.workspace.skey);
  const parsed = parseJoinRequestUri(operation.request, groupDid, inbox);
  if (!parsed) throw new OperationRejectedError("Join request must refer to this workspace inbox.");

  const initialState = await readGroupGovernanceState(actor.session, groupDid);
  if (initialState.knownAppSubjects.has(parsed.repo)) {
    throw new OperationRejectedError("An installed app is given channels by changing its access, not by a join request.");
  }

  const matchingChannels = (await directoryRecords(actor)).filter(
    (record) => requestRecordKey(channelUri(groupDid, record.value.skey), parsed.repo) === parsed.rkey,
  );
  if (matchingChannels.length !== 1) {
    throw new OperationRejectedError("Join request key is not canonical for this workspace.");
  }
  const channelSkey = matchingChannels[0]!.value.skey;
  const channelName = matchingChannels[0]!.value.name;
  const privRole = channelRoleKey(channelSkey);

  const request = await readJoinRequest(actor.session, inbox, parsed.repo, parsed.rkey, groupDid);
  const requestIsCurrent = request?.requestId === operation.requestId && request.channelSkey === channelSkey;
  if (!requestIsCurrent) {
    await cleanupStaleJoinApproval(actor, context, operation.decision, parsed.repo, privRole);
    throw new OperationRejectedError("Join request generation is no longer current.");
  }

  const directory = await getOwnerRecord(actor.session, actor.workspace.uri, COLLECTION.directory, channelSkey);
  if (!directory || directory.visibility !== "private") {
    throw new OperationRejectedError("Join requests are valid only for an active private channel.");
  }

  const decisionKey = decisionRecordKey(operation.request);
  if (operation.decision === "approve" && !joinRequestBaseline(context.completedSteps)) {
    const hadRole = Boolean(initialState.memberships.get(parsed.repo)?.roles.includes(privRole));
    const membershipTag = hadRole ? "11" : "none";
    await context.step(`join-request-baseline-${membershipTag}-${Number(hadRole)}`, async () => {});
  }

  const ensureRequestCurrent = async () => {
    const latest = await readJoinRequest(actor.session, inbox, parsed.repo, parsed.rkey, groupDid);
    if (latest?.requestId === operation.requestId && latest.channelSkey === channelSkey) return;
    await cleanupStaleJoinApproval(actor, context, operation.decision, parsed.repo, privRole);
    throw new OperationRejectedError("Join request generation is no longer current.");
  };

  const ensureApprovalEligible = async () => {
    await ensureRequestCurrent();
    const state = await readGroupGovernanceState(actor.session, groupDid);
    const humans = humanMemberDids(state, groupDid);
    if (humans.has(parsed.repo)) {
      const curRoles = state.memberships.get(parsed.repo)?.roles ?? [];
      if (!curRoles.includes(privRole)) {
        if (curRoles.length + 1 > WORKSPACE_ENVELOPE.maxRolesPerMember) {
          throw new OperationRejectedError(
            `Member ${parsed.repo} exceeds maximum assigned roles (${WORKSPACE_ENVELOPE.maxRolesPerMember}).`,
          );
        }
        const privCount = curRoles.filter((r) => r.startsWith("channel-")).length;
        if (privCount + 1 > WORKSPACE_ENVELOPE.maxPrivateChannelsPerMember) {
          throw new OperationRejectedError(
            `Member ${parsed.repo} exceeds maximum private channels (${WORKSPACE_ENVELOPE.maxPrivateChannelsPerMember}).`,
          );
        }
      }
      return;
    }

    await context.step("join-request-inactive-revoke-membership", async () => {
      const cur = state.memberships.get(parsed.repo);
      if (cur && cur.roles.includes(privRole)) {
        const next = cur.roles.filter((r) => r !== privRole);
        await putMembershipRoles(actor.session, groupDid, parsed.repo, next.length > 0 ? next : ["member"]);
      }
    });
    await context.step("join-request-inactive-deactivate-roster", async () => {});
    throw new OperationRejectedError("Only an active workspace member can be approved for a private channel.");
  };

  if (operation.decision === "approve") {
    await context.step("join-request-channel-membership", async () => {
      await ensureApprovalEligible();
      const state = await readGroupGovernanceState(actor.session, groupDid);
      if (!state.roles.has(privRole)) {
        await putAuthorityRecord(
          actor.session,
          groupMembersUri(groupDid),
          OPENSOCIAL_COLLECTION.role,
          privRole,
          { displayName: `#${channelName} member` },
        );
      }
      const cur = state.memberships.get(parsed.repo);
      if (!cur) throw new OperationRejectedError("Only an active workspace member can be approved for a private channel.");
      if (!cur.roles.includes(privRole)) {
        await putMembershipRoles(actor.session, groupDid, parsed.repo, [...cur.roles, privRole]);
      }
    });
    await context.step("join-request-private-roster", async () => {
      await ensureApprovalEligible();
    });
  }

  await context.step("join-request-decision", async () => {
    if (operation.decision === "approve") await ensureApprovalEligible();
    else await ensureRequestCurrent();
    await putAuthorityRecord(actor.session, inbox, COLLECTION.joinDecision, decisionKey, {
      request: operation.request,
      requestId: operation.requestId,
      decision: operation.decision,
      updatedAt: new Date().toISOString(),
    });
  });

  if (operation.decision === "approve") {
    await context.step("join-request-approved-membership-verified", async () => {
      await ensureApprovalEligible();
      const state = await readGroupGovernanceState(actor.session, groupDid);
      if (!state.memberships.get(parsed.repo)?.roles.includes(privRole)) {
        throw new Error("Private channel role assignment has not converged.");
      }
    });
  }
}

async function cleanupStaleJoinApproval(
  actor: OperatorActor,
  context: OperationContext,
  decision: "approve" | "deny",
  repoDid: string,
  privRole: string,
): Promise<void> {
  const baseline = joinRequestBaseline(context.completedSteps);
  if (decision !== "approve" || !baseline) return;
  const groupDid = actor.workspace.authorityDid;

  await context.step("join-request-stale-restore-membership", async () => {
    const state = await readGroupGovernanceState(actor.session, groupDid);
    const cur = state.memberships.get(repoDid);
    if (!cur) return;
    const hadRole = baseline.membership === "11" || baseline.rosterActive;
    const hasRoleNow = cur.roles.includes(privRole);
    if (!hadRole && hasRoleNow) {
      const next = cur.roles.filter((r) => r !== privRole);
      await putMembershipRoles(actor.session, groupDid, repoDid, next.length > 0 ? next : ["member"]);
    } else if (hadRole && !hasRoleNow) {
      await putMembershipRoles(actor.session, groupDid, repoDid, [...cur.roles, privRole]);
    }
  });

  await context.step("join-request-stale-restore-roster", async () => {});
}

function joinRequestBaseline(steps: string[]): { membership: "none" | string; rosterActive: boolean } | null {
  const marker = steps.find((step) => step.startsWith("join-request-baseline-"));
  const match = /^join-request-baseline-(none|[01]{2})-([01])$/.exec(marker ?? "");
  if (!match) return null;
  return { membership: match[1]!, rosterActive: match[2] === "1" };
}
