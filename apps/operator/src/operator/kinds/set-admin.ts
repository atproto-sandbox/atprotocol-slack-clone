import { effectiveHumanAdmins, isEffectiveAdminMember } from "@flock/protocol/scopes";
import type { OperatorActor } from "../actor";
import { OperationRejectedError, type OperationContext } from "../journal";
import { defaultRoleKeys, putMembershipRoles, readGroupGovernanceState } from "../workspace-state";
import type { OperationKind } from "./kind";

export const setAdminKind: OperationKind = {
  kind: "setAdmin",
  required: ["subject", "active"],
  actor: "admin",
  submittedThrough: "execute",
  steps: ["write-admin-active", "grant-inbox-read", "remove-inbox-read", "write-admin-inactive", "admin-state-verified"],
  endsOwnRole: (request, actorDid) => request.subject === actorDid && request.active === false,
  run: (actor, context, request) => setAdmin(actor, context, request.subject as string, request.active as boolean),
};

async function setAdmin(actor: OperatorActor, context: OperationContext, subject: string, active: boolean): Promise<void> {
  const groupDid = actor.workspace.authorityDid;
  if (subject === groupDid) {
    throw new OperationRejectedError("The group account's bootstrap admin state cannot be changed.");
  }

  const state = await readGroupGovernanceState(actor.session, groupDid);
  if (state.knownAppSubjects.has(subject)) {
    throw new OperationRejectedError("An installed app is not an admin.");
  }

  const membership = state.memberships.get(subject);
  if (active) {
    if (!membership || membership.roles.length === 0) {
      throw new OperationRejectedError("Only an active workspace member can become an admin.");
    }
    if (!state.roles.has("admin")) {
      throw new OperationRejectedError("Role 'admin' does not exist in org.atgrp.members/self.");
    }
  } else {
    const admins = effectiveHumanAdmins(state, groupDid);
    if (admins.includes(subject) && admins.length <= 1) {
      throw new OperationRejectedError("The last active admin cannot be demoted.");
    }
  }

  if (active) {
    await context.step("write-admin-active", async () => {
      const latest = await readGroupGovernanceState(actor.session, groupDid);
      const cur = latest.memberships.get(subject);
      if (!cur) throw new OperationRejectedError("Target member is no longer in the group.");
      if (cur.roles.includes("admin")) return;
      await putMembershipRoles(actor.session, groupDid, subject, [...cur.roles, "admin"]);
    });
    if (context.completedSteps.includes("grant-inbox-read")) {
      await context.step("grant-inbox-read", async () => {});
    }
  } else {
    if (context.completedSteps.includes("remove-inbox-read")) {
      await context.step("remove-inbox-read", async () => {});
    }
    await context.step("write-admin-inactive", async () => {
      const latest = await readGroupGovernanceState(actor.session, groupDid);
      const cur = latest.memberships.get(subject);
      if (!cur || !cur.roles.includes("admin")) return;
      const remaining = cur.roles.filter((r) => r !== "admin");
      const fallback = defaultRoleKeys(latest);
      const nextRoles = remaining.length > 0 ? remaining : fallback.length > 0 ? fallback : ["member"];
      await putMembershipRoles(actor.session, groupDid, subject, nextRoles);
    });
  }

  await context.step("admin-state-verified", async () => {
    const latest = await readGroupGovernanceState(actor.session, groupDid);
    const hasAdmin = Boolean(latest.memberships.get(subject)?.roles.includes("admin"));
    const isAdmin = isEffectiveAdminMember(subject, latest, groupDid);
    if (active && (!hasAdmin || !isAdmin)) {
      throw new Error("Admin promotion has not converged.");
    }
    if (!active && hasAdmin) {
      throw new Error("Admin demotion has not converged.");
    }
  });
}
