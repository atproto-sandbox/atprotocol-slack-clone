import { effectiveHumanAdmins } from "@flock/protocol/scopes";
import type { OperatorActor } from "../actor";
import { OperationRejectedError, type OperationContext } from "../journal";
import { deleteMembershipRecord, readGroupGovernanceState } from "../workspace-state";
import type { OperationKind } from "./kind";

const REMOVAL_STEPS = [
  "remove-ext-{extId}",
  "remove-inbox-membership",
  "remove-app-inbox-{app}",
  "remove-channel-{skey}",
  "remove-workspace-membership",
  "deactivate-workspace-roster",
  "deactivate-admin",
  "removal-verified",
] as const;

export const removeMemberKind: OperationKind = {
  kind: "removeMember",
  required: ["subject"],
  actor: "admin",
  submittedThrough: "execute",
  steps: REMOVAL_STEPS,
  endsOwnRole: (request, actorDid) => request.subject === actorDid,
  run: (actor, context, request) => removeMember(actor, context, request.subject as string),
};

export const leaveWorkspaceKind: OperationKind = {
  kind: "leaveWorkspace",
  required: [],
  actor: "member",
  submittedThrough: "execute",
  steps: REMOVAL_STEPS,
  endsOwnRole: () => true,
  run: (actor, context) => removeMember(actor, context, actor.did),
};

async function removeMember(actor: OperatorActor, context: OperationContext, subject: string): Promise<void> {
  const groupDid = actor.workspace.authorityDid;
  if (subject === groupDid) {
    throw new OperationRejectedError("The group account cannot be removed.");
  }

  const state = await readGroupGovernanceState(actor.session, groupDid);
  if (state.knownAppSubjects.has(subject)) {
    throw new OperationRejectedError("An installed app is removed with uninstallApp.");
  }

  const admins = effectiveHumanAdmins(state, groupDid);
  if (admins.includes(subject) && admins.length <= 1) {
    throw new OperationRejectedError("The last active admin cannot leave or be removed.");
  }

  // Legacy step replay markers (no-ops under OpenSocial flat union RBAC):
  for (const prev of context.completedSteps) {
    if (prev.startsWith("remove-ext-")) {
      const extId = prev.slice("remove-ext-".length);
      await context.step(`remove-ext-${extId}`, async () => {});
    } else if (prev.startsWith("remove-app-inbox-")) {
      const app = prev.slice("remove-app-inbox-".length);
      await context.step(`remove-app-inbox-${app}`, async () => {});
    } else if (prev.startsWith("remove-channel-")) {
      const skey = prev.slice("remove-channel-".length);
      await context.step(`remove-channel-${skey}`, async () => {});
    }
  }
  if (context.completedSteps.includes("remove-inbox-membership")) {
    await context.step("remove-inbox-membership", async () => {});
  }

  // Single O(1) `deleteRecord(membership/<subject>)` evicts `subject` from all group space writer sets!
  await context.step("remove-workspace-membership", () =>
    deleteMembershipRecord(actor.session, groupDid, subject),
  );

  if (context.completedSteps.includes("deactivate-workspace-roster")) {
    await context.step("deactivate-workspace-roster", async () => {});
  }
  if (context.completedSteps.includes("deactivate-admin")) {
    await context.step("deactivate-admin", async () => {});
  }

  await context.step("removal-verified", async () => {
    const latest = await readGroupGovernanceState(actor.session, groupDid);
    if (latest.memberships.has(subject)) {
      throw new Error("Group membership removal has not converged.");
    }
  });
}
