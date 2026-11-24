import {
  appInboxSkey,
  appInboxUri,
  appRoleKey,
  channelRoleKey,
  channelUri,
  groupMembersUri,
  inboxUri,
} from "@flock/protocol/keys";
import { OPENSOCIAL_COLLECTION, SPACE_TYPE } from "@flock/protocol/nsids";
import {
  appInboxState,
  deleteAuthorityRecord,
  ensureOpenSocialSpace,
  getOpenSocialSpacePolicy,
  putAuthorityRecord,
  spaceExists,
  updateOpenSocialSpacePolicy,
} from "../../atproto/space-ops";
import type { OperatorActor } from "../actor";
import type { OperationContext } from "../journal";
import { dropMemberList } from "../member-access";
import {
  activeAppChannelGrants,
  activeAppRoleKeys,
  activeInstalls,
  allExtInstalls,
  allInstalls,
  readExtInstall,
  syncCoreSpaceAppRoleGrants,
  writeExtInstall,
  type AppInstall,
  type ExtInstall,
} from "../membership";
import {
  deleteMembershipRecord,
  directoryRecords,
  isSpaceNotFound,
  putMembershipRoles,
  readGroupGovernanceState,
} from "../workspace-state";
import {
  archivedChannelPolicy,
  defaultAppInboxPolicy,
  defaultExtensionSpacePolicy,
  defaultInboxSpacePolicy,
  defaultPrivateChannelPolicy,
  defaultPublicChannelPolicy,
  defaultWorkspaceSpacePolicy,
  disabledAppInboxPolicy,
  disabledExtensionSpacePolicy,
  ensureExtensionSpace,
} from "../workspace-spaces";
import type { OperationKind } from "./kind";

export const reconcileWorkspaceKind: OperationKind = {
  kind: "reconcileWorkspace",
  required: [],
  actor: "admin",
  submittedThrough: "execute",
  steps: [
    "workspace-set-{did}",
    "workspace-remove-{did}",
    "workspace-verified",
    "inbox-set-{did}",
    "inbox-remove-{did}",
    "inbox-verified",
    "channel-{skey}-set-{did}",
    "channel-{skey}-remove-{did}",
    "channel-{skey}-verified",
    "channel-{skey}-deactivate-stale-roster-{did}",
    "archived-{skey}-set-{did}",
    "archived-{skey}-remove-{did}",
    "archived-{skey}-verified",
    "archived-{skey}-deactivate-roster-{did}",
    "app-inbox-{did}-space",
    "app-inbox-{did}-set",
    "app-inbox-{did}-remove",
    "app-inbox-{did}-verified",
    "ext-{extId}-space",
    "ext-{extId}-set",
    "ext-{extId}-remove",
    "ext-{extId}-verified",
    "ext-{extId}-cleanup-complete",
  ],
  run: (actor, context) => reconcileWorkspace(actor, context),
};

export async function hasUncoveredAppInbox(actor: OperatorActor): Promise<boolean> {
  const installs = await activeInstalls(actor);
  const first = [...installs.values()][0];
  if (!first) return false;
  return (await appInboxState(actor.session, appInboxUri(actor.workspace.authorityDid, actor.workspace.skey, first.subject))) === "uncovered";
}

async function reconcileWorkspace(actor: OperatorActor, context: OperationContext): Promise<void> {
  const groupDid = actor.workspace.authorityDid;
  const workspace = actor.workspace.uri;
  const inbox = inboxUri(groupDid, actor.workspace.skey);
  const membersSpace = groupMembersUri(groupDid);

  const all = await allInstalls(actor);
  const installs = new Map([...all].filter(([, install]) => install.active));
  const appRoles = activeAppRoleKeys(installs);
  const extInstalls = await allExtInstalls(actor);

  // Ensure active app roles exist BEFORE updating space policies that reference them!
  for (const install of [...installs.values()].sort((a, b) => a.subject.localeCompare(b.subject))) {
    const roleKey = appRoleKey(install.subject);
    await putAuthorityRecord(actor.session, membersSpace, OPENSOCIAL_COLLECTION.role, roleKey, {
      displayName: `App: ${install.subject}`,
    });
  }

  for (const install of [...extInstalls.values()].sort((left, right) => left.extId.localeCompare(right.extId))) {
    await reconcileExtension(actor, context, install);
  }

  await context.step("workspace-verified", async () => {
    await syncCoreSpaceAppRoleGrants(actor.session, groupDid, appRoles);
    await updateOpenSocialSpacePolicy(actor.session, workspace, defaultWorkspaceSpacePolicy(appRoles));
    dropMemberList(workspace);
    const wsPolicy = await getOpenSocialSpacePolicy(actor.session, workspace);
    if (!wsPolicy || !wsPolicy.grants.some((g) => g.role === "member" && g.read === true)) {
      throw new Error("Workspace policy reconciliation has not converged.");
    }
  });

  await context.step("inbox-verified", async () => {
    await updateOpenSocialSpacePolicy(actor.session, inbox, defaultInboxSpacePolicy());
    dropMemberList(inbox);
    const inboxPolicy = await getOpenSocialSpacePolicy(actor.session, inbox);
    if (!inboxPolicy || !inboxPolicy.grants.some((g) => g.role === "member" && g.write === true)) {
      throw new Error("Inbox policy reconciliation has not converged.");
    }
  });

  const channels = (await directoryRecords(actor)).sort((left, right) =>
    left.value.skey.localeCompare(right.value.skey),
  );
  for (const channel of channels) {
    const skey = channel.value.skey;
    const space = channelUri(groupDid, skey);
    const privRole = channelRoleKey(skey);
    if (channel.value.visibility === "transitioning") continue;

    if (channel.value.visibility === "archived") {
      await context.step(`archived-${skey}-verified`, async () => {
        await updateOpenSocialSpacePolicy(actor.session, space, archivedChannelPolicy());
        dropMemberList(space);
        const state = await readGroupGovernanceState(actor.session, groupDid);
        for (const [did, mem] of state.memberships.entries()) {
          if (did !== groupDid && mem.roles.includes(privRole)) {
            const next = mem.roles.filter((r) => r !== privRole);
            await putMembershipRoles(actor.session, groupDid, did, next.length > 0 ? next : ["member"]);
          }
        }
        await deleteAuthorityRecord(actor.session, membersSpace, OPENSOCIAL_COLLECTION.role, privRole);
      });
      continue;
    }

    await context.step(`channel-${skey}-verified`, async () => {
      const chGrants = activeAppChannelGrants(installs, skey);
      if (channel.value.visibility === "private") {
        await putAuthorityRecord(actor.session, membersSpace, OPENSOCIAL_COLLECTION.role, privRole, {
          displayName: `#${channel.value.name} member`,
        });
        await updateOpenSocialSpacePolicy(
          actor.session,
          space,
          defaultPrivateChannelPolicy(privRole, chGrants),
        );
      } else {
        await updateOpenSocialSpacePolicy(actor.session, space, defaultPublicChannelPolicy(chGrants));
      }
      dropMemberList(space);
    });
  }

  for (const install of [...all.values()].sort((left, right) => left.subject.localeCompare(right.subject))) {
    await reconcileAppInboxAndPrincipal(actor, context, install);
  }
}

async function reconcileExtension(
  actor: OperatorActor,
  context: OperationContext,
  install: ExtInstall,
): Promise<void> {
  if (!install.active && install.cleanupComplete) return;
  if (install.active) {
    if (!(await spaceExists(actor.session, install.space))) {
      await context.step(`ext-${install.extId}-space`, async () => {
        await ensureExtensionSpace(actor.session, actor.workspace.skey, install.extId);
      });
    }
    await context.step(`ext-${install.extId}-set`, async () => {
      await updateOpenSocialSpacePolicy(actor.session, install.space, defaultExtensionSpacePolicy());
      dropMemberList(install.space);
    });
    await context.step(`ext-${install.extId}-verified`, async () => {
      const pol = await getOpenSocialSpacePolicy(actor.session, install.space);
      if (!pol || !pol.grants.some((g) => g.role === "member" && g.read && g.write)) {
        throw new Error(`Extension ${install.extId} policy has not converged.`);
      }
    });
    return;
  }

  await context.step(`ext-${install.extId}-remove`, async () => {
    try {
      await updateOpenSocialSpacePolicy(actor.session, install.space, disabledExtensionSpacePolicy());
      dropMemberList(install.space);
    } catch (error) {
      if (!isSpaceNotFound(error)) throw error;
    }
  });
  await context.step(`ext-${install.extId}-verified`, async () => {
    try {
      const pol = await getOpenSocialSpacePolicy(actor.session, install.space);
      if (pol && pol.grants.some((g) => g.role !== "admin")) {
        throw new Error(`Extension ${install.extId} grants remain after disable.`);
      }
    } catch (error) {
      if (!isSpaceNotFound(error)) throw error;
    }
  });
  await context.step(`ext-${install.extId}-cleanup-complete`, async () => {
    const latest = await readExtInstall(actor, install.extId);
    if (!latest || latest.active) return;
    await writeExtInstall(actor, {
      ...latest,
      active: false,
      cleanupComplete: true,
      disabledAt: latest.disabledAt ?? new Date().toISOString(),
    });
  });
}

async function reconcileAppInboxAndPrincipal(
  actor: OperatorActor,
  context: OperationContext,
  install: AppInstall,
): Promise<void> {
  const groupDid = actor.workspace.authorityDid;
  const membersSpace = groupMembersUri(groupDid);
  const roleKey = appRoleKey(install.subject);
  const inbox = appInboxUri(groupDid, actor.workspace.skey, install.subject);
  const state = await appInboxState(actor.session, inbox);
  if (state === "uncovered") return;

  if (install.active) {
    if (state === "missing") {
      await context.step(`app-inbox-${install.subject}-space`, async () => {
        await ensureOpenSocialSpace(
          actor.session,
          SPACE_TYPE.appInbox,
          appInboxSkey(actor.workspace.skey, install.subject),
          defaultAppInboxPolicy(roleKey),
        );
      });
    }
    await context.step(`app-inbox-${install.subject}-set`, async () => {
      await updateOpenSocialSpacePolicy(actor.session, inbox, defaultAppInboxPolicy(roleKey));
      dropMemberList(inbox);
    });
    await context.step(`app-inbox-${install.subject}-verified`, async () => {
      const gov = await readGroupGovernanceState(actor.session, groupDid);
      const curMem = gov.memberships.get(install.subject);
      if (!curMem || curMem.roles.length !== 1 || curMem.roles[0] !== roleKey) {
        await putMembershipRoles(actor.session, groupDid, install.subject, [roleKey]);
      }
      const pol = await getOpenSocialSpacePolicy(actor.session, inbox);
      if (!pol?.grants.some((g) => g.role === roleKey && g.read === true)) {
        throw new Error(`App inbox ${install.subject} policy has not converged.`);
      }
    });
    return;
  }

  // Inactive app tombstone: ensure policy grants, membership, and role are removed cleanly!
  if (state === "present") {
    await context.step(`app-inbox-${install.subject}-remove`, async () => {
      await updateOpenSocialSpacePolicy(actor.session, inbox, disabledAppInboxPolicy());
      dropMemberList(inbox);
    });
  }
  await context.step(`app-inbox-${install.subject}-verified`, async () => {
    await deleteMembershipRecord(actor.session, groupDid, install.subject);
    await deleteAuthorityRecord(actor.session, membersSpace, OPENSOCIAL_COLLECTION.role, roleKey);
  });
}
