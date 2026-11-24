import { channelRoleKey, channelUri, groupMembersUri } from "@flock/protocol/keys";
import { COLLECTION, OPENSOCIAL_COLLECTION } from "@flock/protocol/nsids";
import { WORKSPACE_ENVELOPE } from "@flock/protocol/workspace-summary";
import {
  deleteAuthorityRecord,
  getOpenSocialSpacePolicy,
  putAuthorityRecord,
  updateOpenSocialSpacePolicy,
} from "../../atproto/space-ops";
import type { OperatorActor } from "../actor";
import { OperationRejectedError, type OperationContext } from "../journal";
import { dropMemberList } from "../member-access";
import { activeAppChannelGrants, activeInstalls } from "../membership";
import {
  getOwnerRecord,
  humanMemberDids,
  putMembershipRoles,
  readGroupGovernanceState,
} from "../workspace-state";
import { defaultPrivateChannelPolicy, defaultPublicChannelPolicy } from "../workspace-spaces";
import type { OperationKind, OperatorRequest } from "./kind";

export const transitionChannelKind: OperationKind = {
  kind: "transitionChannel",
  required: ["skey", "visibility"],
  optional: ["members"],
  actor: "admin",
  submittedThrough: "execute",
  steps: [
    "channel-set-transitioning",
    "channel-public-add-{did}",
    "channel-remove-{did}",
    "channel-roster-inactive-{did}",
    "channel-private-add-{did}",
    "channel-roster-active-{did}",
    "channel-visibility-verified",
    "channel-set-final-visibility",
    "channel-app-{did}",
  ],
  validate(request) {
    if (request.visibility === "private" && !Array.isArray(request.members)) {
      throw new Error("Private transition requires the selected member list.");
    }
  },
  run: (actor, context, request) =>
    transitionChannel(
      actor,
      context,
      request as OperatorRequest & {
        skey: string;
        visibility: "public" | "private";
        members?: string[];
      },
    ),
};

async function transitionChannel(
  actor: OperatorActor,
  context: OperationContext,
  operation: OperatorRequest & {
    skey: string;
    visibility: "public" | "private";
    members?: string[];
  },
): Promise<void> {
  const groupDid = actor.workspace.authorityDid;
  const directory = await getOwnerRecord(actor.session, actor.workspace.uri, COLLECTION.directory, operation.skey);
  if (!directory || typeof directory.name !== "string") {
    throw new OperationRejectedError("Channel does not exist.");
  }
  if (directory.visibility === "archived") {
    throw new OperationRejectedError("Archived channels cannot change visibility.");
  }

  const space = channelUri(groupDid, operation.skey);
  const privRole = channelRoleKey(operation.skey);
  const membersSpace = groupMembersUri(groupDid);

  const [state, installs] = await Promise.all([
    readGroupGovernanceState(actor.session, groupDid),
    activeInstalls(actor),
  ]);
  const activeMembers = humanMemberDids(state, groupDid);
  const selected = operation.visibility === "private" ? (operation.members ?? []) : [];

  if (operation.visibility === "private") {
    if (selected.some((did) => !activeMembers.has(did))) {
      throw new OperationRejectedError("Private channels can include only active workspace members.");
    }
    for (const did of selected) {
      const currentRoles = state.memberships.get(did)?.roles ?? [];
      if (!currentRoles.includes(privRole)) {
        if (currentRoles.length + 1 > WORKSPACE_ENVELOPE.maxRolesPerMember) {
          throw new OperationRejectedError(
            `Member ${did} exceeds maximum assigned roles (${WORKSPACE_ENVELOPE.maxRolesPerMember}).`,
          );
        }
        const privCount = currentRoles.filter((r) => r.startsWith("channel-")).length;
        if (privCount + 1 > WORKSPACE_ENVELOPE.maxPrivateChannelsPerMember) {
          throw new OperationRejectedError(
            `Member ${did} exceeds maximum private channels (${WORKSPACE_ENVELOPE.maxPrivateChannelsPerMember}).`,
          );
        }
      }
    }
  }

  const appGrants = activeAppChannelGrants(installs, operation.skey);
  const desiredPrivateSet = new Set(selected.filter((did) => did !== groupDid));

  await context.step("channel-set-transitioning", async () => {
    await putAuthorityRecord(actor.session, actor.workspace.uri, COLLECTION.directory, operation.skey, {
      skey: operation.skey,
      name: directory.name,
      visibility: "transitioning",
    });
    if (operation.visibility === "private") {
      await putAuthorityRecord(actor.session, membersSpace, OPENSOCIAL_COLLECTION.role, privRole, {
        displayName: `#${directory.name} member`,
      });
    } else {
      await updateOpenSocialSpacePolicy(actor.session, space, defaultPublicChannelPolicy(appGrants));
    }
    dropMemberList(space);
  });

  if (operation.visibility === "public") {
    // Strip `channel-<skey>` from all memberships, then delete `role/channel-<skey>` (`RoleInUse`-safe!).
    for (const [did, membership] of state.memberships.entries()) {
      if (did === groupDid || !membership.roles.includes(privRole)) continue;
      await context.step(`channel-remove-${did}`, async () => {
        const latest = await readGroupGovernanceState(actor.session, groupDid);
        const cur = latest.memberships.get(did);
        if (!cur || !cur.roles.includes(privRole)) return;
        const remaining = cur.roles.filter((r) => r !== privRole);
        await putMembershipRoles(
          actor.session,
          groupDid,
          did,
          remaining.length > 0 ? remaining : ["member"],
        );
      });
    }
    if (context.completedSteps.some((s) => s.startsWith("channel-public-add-"))) {
      for (const did of activeMembers) {
        if (context.completedSteps.includes(`channel-public-add-${did}`)) {
          await context.step(`channel-public-add-${did}`, async () => {});
        }
      }
    }
  } else {
    // Private: remove `privRole` from deselected members, add `privRole` to selected members.
    for (const [did, membership] of state.memberships.entries()) {
      if (did === groupDid || !membership.roles.includes(privRole) || desiredPrivateSet.has(did)) continue;
      await context.step(`channel-remove-${did}`, async () => {
        const latest = await readGroupGovernanceState(actor.session, groupDid);
        const cur = latest.memberships.get(did);
        if (!cur || !cur.roles.includes(privRole)) return;
        const remaining = cur.roles.filter((r) => r !== privRole);
        await putMembershipRoles(
          actor.session,
          groupDid,
          did,
          remaining.length > 0 ? remaining : ["member"],
        );
      });
      if (context.completedSteps.includes(`channel-roster-inactive-${did}`)) {
        await context.step(`channel-roster-inactive-${did}`, async () => {});
      }
    }
    for (const did of desiredPrivateSet) {
      await context.step(`channel-private-add-${did}`, async () => {
        const latest = await readGroupGovernanceState(actor.session, groupDid);
        const cur = latest.memberships.get(did);
        if (!cur) throw new OperationRejectedError(`Member ${did} is no longer in the group.`);
        if (cur.roles.includes(privRole)) return;
        await putMembershipRoles(actor.session, groupDid, did, [...cur.roles, privRole]);
      });
      if (context.completedSteps.includes(`channel-roster-active-${did}`)) {
        await context.step(`channel-roster-active-${did}`, async () => {});
      }
    }
  }

  if (context.completedSteps.some((s) => s.startsWith("channel-app-"))) {
    for (const install of installs.values()) {
      if (context.completedSteps.includes(`channel-app-${install.subject}`)) {
        await context.step(`channel-app-${install.subject}`, async () => {});
      }
    }
  }

  await context.step("channel-visibility-verified", async () => {
    // Ensure policy is converged (including if `channel-set-transitioning` ran on an earlier release before policy write).
    if (operation.visibility === "private") {
      await putAuthorityRecord(actor.session, membersSpace, OPENSOCIAL_COLLECTION.role, privRole, {
        displayName: `#${directory.name} member`,
      });
      await updateOpenSocialSpacePolicy(
        actor.session,
        space,
        defaultPrivateChannelPolicy(privRole, appGrants),
      );
    } else {
      await updateOpenSocialSpacePolicy(actor.session, space, defaultPublicChannelPolicy(appGrants));
      await deleteAuthorityRecord(actor.session, membersSpace, OPENSOCIAL_COLLECTION.role, privRole);
    }
    dropMemberList(space);

    const policy = await getOpenSocialSpacePolicy(actor.session, space);
    if (!policy) throw new Error("Channel space policy is missing.");
    if (operation.visibility === "private") {
      if (policy.unlisted !== true || !policy.grants.some((g) => g.role === privRole && g.read && g.write)) {
        throw new Error("Private channel policy has not converged.");
      }
      const latest = await readGroupGovernanceState(actor.session, groupDid);
      for (const did of desiredPrivateSet) {
        if (!latest.memberships.get(did)?.roles.includes(privRole)) {
          throw new Error(`Private channel role ${privRole} missing on ${did}.`);
        }
      }
    } else if (policy.unlisted === true || !policy.grants.some((g) => g.role === "member" && g.read && g.write)) {
      throw new Error("Public channel policy has not converged.");
    }
  });

  await context.step("channel-set-final-visibility", () =>
    putAuthorityRecord(actor.session, actor.workspace.uri, COLLECTION.directory, operation.skey, {
      skey: operation.skey,
      name: directory.name,
      visibility: operation.visibility,
    }).then(() => undefined),
  );
}
