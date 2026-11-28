import { channelRoleKey, channelUri, groupMembersUri } from "@flock/protocol/keys";
import { COLLECTION, ATGRP_COLLECTION } from "@flock/protocol/nsids";
import {
  deleteAuthorityRecord,
  getOpenSocialSpacePolicy,
  putAuthorityRecord,
  updateOpenSocialSpacePolicy,
} from "../../atproto/space-ops";
import type { OperatorActor } from "../actor";
import { OperationRejectedError, type OperationContext } from "../journal";
import { dropMemberList } from "../member-access";
import { activeInstalls, writeInstall } from "../membership";
import { getOwnerRecord, putMembershipRoles, readGroupGovernanceState } from "../workspace-state";
import { archivedChannelPolicy } from "../workspace-spaces";
import type { OperationKind } from "./kind";

export const archiveChannelKind: OperationKind = {
  kind: "archiveChannel",
  required: ["skey"],
  actor: "admin",
  submittedThrough: "execute",
  steps: [
    "channel-archive-transition",
    "channel-archive-remove-{did}",
    "channel-archive-roster-{did}",
    "channel-archive-verified",
    "channel-archive-final",
    "channel-archive-app-{did}",
  ],
  run: (actor, context, request) => archiveChannel(actor, context, request.skey as string),
  archivesSpaces: (actor, request) => [channelUri(actor.workspace.authorityDid, String(request.skey))],
};

async function archiveChannel(actor: OperatorActor, context: OperationContext, skey: string): Promise<void> {
  const groupDid = actor.workspace.authorityDid;
  const directory = await getOwnerRecord(actor.session, actor.workspace.uri, COLLECTION.directory, skey);
  if (!directory || typeof directory.name !== "string") {
    throw new OperationRejectedError("Channel does not exist.");
  }
  if (directory.visibility === "archived") return;

  const space = channelUri(groupDid, skey);
  const privRole = channelRoleKey(skey);
  const membersSpace = groupMembersUri(groupDid);

  await context.step("channel-archive-transition", async () => {
    await putAuthorityRecord(actor.session, actor.workspace.uri, COLLECTION.directory, skey, {
      skey,
      name: directory.name,
      visibility: "transitioning",
    });
    // Step 1: clear channel space grants (`unlisted: true, grants: []`) so writers are evicted and role reference in policy is gone.
    await updateOpenSocialSpacePolicy(actor.session, space, archivedChannelPolicy());
    dropMemberList(space);
  });

  for (const install of (await activeInstalls(actor)).values()) {
    if (!install.channels.has(skey)) continue;
    const channels = new Map(install.channels);
    channels.delete(skey);
    await context.step(`channel-archive-app-${install.subject}`, () => writeInstall(actor, { ...install, channels }));
  }

  // Step 2: remove `channel-<skey>` from any member holding it.
  const state = await readGroupGovernanceState(actor.session, groupDid);
  for (const [did, membership] of state.memberships.entries()) {
    if (did === groupDid || !membership.roles.includes(privRole)) continue;
    await context.step(`channel-archive-remove-${did}`, async () => {
      const latest = await readGroupGovernanceState(actor.session, groupDid);
      const cur = latest.memberships.get(did);
      if (!cur || !cur.roles.includes(privRole)) return;
      const remaining = cur.roles.filter((r) => r !== privRole);
      await putMembershipRoles(actor.session, groupDid, did, remaining.length > 0 ? remaining : ["member"]);
    });
    if (context.completedSteps.includes(`channel-archive-roster-${did}`)) {
      await context.step(`channel-archive-roster-${did}`, async () => {});
    }
  }

  await context.step("channel-archive-verified", async () => {
    await updateOpenSocialSpacePolicy(actor.session, space, archivedChannelPolicy());
    dropMemberList(space);
    // Step 3: delete `role/channel-<skey>` now that zero policies or memberships reference it (`RoleInUse`-safe!).
    await deleteAuthorityRecord(actor.session, membersSpace, ATGRP_COLLECTION.role, privRole);

    const policy = await getOpenSocialSpacePolicy(actor.session, space);
    if (!policy || policy.grants.length !== 0 || policy.unlisted !== true) {
      throw new Error("Archived channel policy still holds grants.");
    }
    const latest = await readGroupGovernanceState(actor.session, groupDid);
    for (const membership of latest.memberships.values()) {
      if (membership.roles.includes(privRole)) {
        throw new Error(`Archived channel role ${privRole} remains assigned.`);
      }
    }
  });

  await context.step("channel-archive-final", () =>
    putAuthorityRecord(actor.session, actor.workspace.uri, COLLECTION.directory, skey, {
      skey,
      name: directory.name,
      visibility: "archived",
    }).then(() => undefined),
  );
}
