import { channelRoleKey, channelUri, groupMembersUri, SELF_SKEY } from "@flock/protocol/keys";
import { COLLECTION, ATGRP_COLLECTION, SPACE_TYPE } from "@flock/protocol/nsids";
import { WORKSPACE_ENVELOPE } from "@flock/protocol/workspace-summary";
import {
  ensureOpenSocialSpace,
  getOpenSocialSpacePolicy,
  putAuthorityRecord,
} from "../../atproto/space-ops";
import type { OperatorActor } from "../actor";
import { OperationRejectedError, type OperationContext } from "../journal";
import { dropMemberList } from "../member-access";
import {
  directoryRecords,
  humanMemberDids,
  putMembershipRoles,
  readGroupGovernanceState,
} from "../workspace-state";
import { defaultPrivateChannelPolicy, defaultPublicChannelPolicy } from "../workspace-spaces";
import type { OperationKind, OperatorRequest } from "./kind";

export const createChannelKind: OperationKind = {
  kind: "createChannel",
  required: ["skey", "name", "visibility"],
  optional: ["members"],
  actor: "admin",
  submittedThrough: "execute",
  steps: [
    "channel-space",
    "channel-member-{did}",
    "channel-roster-{did}",
    "channel-directory",
    "channel-membership-verified",
  ],
  run: (actor, context, request) =>
    createChannel(
      actor,
      context,
      request as OperatorRequest & {
        skey: string;
        name: string;
        visibility: "public" | "private";
        members?: string[];
      },
    ),
  createsSpaces: (actor, request) => {
    const rawSkey = String(request.skey);
    const skey = actor.workspace.skey === SELF_SKEY ? rawSkey : `${actor.workspace.skey}-${rawSkey}`;
    return [channelUri(actor.workspace.authorityDid, skey)];
  },
};

async function createChannel(
  actor: OperatorActor,
  context: OperationContext,
  operation: OperatorRequest & {
    skey: string;
    name: string;
    visibility: "public" | "private";
    members?: string[];
  },
): Promise<void> {
  const groupDid = actor.workspace.authorityDid;
  const channels = await directoryRecords(actor);
  const skey =
    actor.workspace.skey === SELF_SKEY ? operation.skey : `${actor.workspace.skey}-${operation.skey}`;
  if (skey.length > 128) throw new OperationRejectedError("Channel key is too long for this workspace.");

  const existing = channels.find((record) => record.value.skey === skey);
  if (existing && (existing.value.name !== operation.name.trim() || existing.value.visibility !== operation.visibility)) {
    throw new OperationRejectedError("Channel key already belongs to a different channel.");
  }
  const activeChannelCount = channels.filter(({ value }) => value.visibility !== "archived").length;
  if (!existing && activeChannelCount >= WORKSPACE_ENVELOPE.channels) {
    throw new OperationRejectedError(`Workspace channel limit reached (${WORKSPACE_ENVELOPE.channels}).`);
  }

  const state = await readGroupGovernanceState(actor.session, groupDid);
  const workspaceMembers = humanMemberDids(state, groupDid);
  const selected = operation.visibility === "private" ? (operation.members ?? []) : [];

  if (operation.visibility === "private") {
    if (selected.some((did) => !workspaceMembers.has(did))) {
      throw new OperationRejectedError("Private channels can include only active workspace members.");
    }
    const privRole = channelRoleKey(skey);
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

  const space = channelUri(groupDid, skey);
  const privRole = channelRoleKey(skey);
  const membersSpace = groupMembersUri(groupDid);

  await context.step("channel-space", async () => {
    if (operation.visibility === "private") {
      await putAuthorityRecord(actor.session, membersSpace, ATGRP_COLLECTION.role, privRole, {
        displayName: `#${operation.name.trim()} member`,
      });
      await ensureOpenSocialSpace(actor.session, SPACE_TYPE.channel, skey, defaultPrivateChannelPolicy(privRole));
    } else {
      await ensureOpenSocialSpace(actor.session, SPACE_TYPE.channel, skey, defaultPublicChannelPolicy());
    }
    dropMemberList(space);
  });

  if (operation.visibility === "private") {
    for (const did of selected) {
      if (did === groupDid) continue;
      await context.step(`channel-member-${did}`, async () => {
        const latest = await readGroupGovernanceState(actor.session, groupDid);
        const currentRoles = latest.memberships.get(did)?.roles;
        if (!currentRoles) throw new OperationRejectedError(`Member ${did} is no longer in the group.`);
        if (currentRoles.includes(privRole)) return;
        await putMembershipRoles(actor.session, groupDid, did, [...currentRoles, privRole]);
      });
      if (context.completedSteps.includes(`channel-roster-${did}`)) {
        await context.step(`channel-roster-${did}`, async () => {});
      }
    }
  }

  await context.step("channel-directory", () =>
    putAuthorityRecord(actor.session, actor.workspace.uri, COLLECTION.directory, skey, {
      skey,
      name: operation.name.trim(),
      visibility: operation.visibility,
    }).then(() => undefined),
  );

  await context.step("channel-membership-verified", async () => {
    const policy = await getOpenSocialSpacePolicy(actor.session, space);
    if (!policy) throw new Error("Channel space policy was not found.");
    if (operation.visibility === "public") {
      const hasMemberGrant = policy.grants.some((g) => g.role === "member" && g.read === true && g.write === true);
      if (!hasMemberGrant || policy.unlisted === true) {
        throw new Error("Public channel OpenSocial policy has not converged.");
      }
      return;
    }
    const hasPrivGrant = policy.grants.some((g) => g.role === privRole && g.read === true && g.write === true);
    if (!hasPrivGrant || policy.unlisted !== true) {
      throw new Error("Private channel OpenSocial policy has not converged.");
    }
    const latest = await readGroupGovernanceState(actor.session, groupDid);
    for (const did of selected) {
      if (did === groupDid) continue;
      if (!latest.memberships.get(did)?.roles.includes(privRole)) {
        throw new Error(`Member ${did} lacks private channel role ${privRole}.`);
      }
    }
  });
}
