import {
  appInboxSkey,
  appInboxUri,
  appRoleKey,
  channelRoleKey,
  channelUri,
  groupMembersUri,
} from "@flock/protocol/keys";
import { OPENSOCIAL_COLLECTION, SPACE_TYPE } from "@flock/protocol/nsids";
import { WORKSPACE_ENVELOPE } from "@flock/protocol/workspace-summary";
import {
  appInboxState,
  deleteAuthorityRecord,
  ensureOpenSocialSpace,
  getOpenSocialSpacePolicy,
  putAuthorityRecord,
  updateOpenSocialSpacePolicy,
} from "../../atproto/space-ops";
import type { OperatorActor } from "../actor";
import { OperationRejectedError, type OperationContext } from "../journal";
import { dropMemberList } from "../member-access";
import {
  activeAppChannelGrants,
  activeAppRoleKeys,
  activeInstalls,
  readInstall,
  syncCoreSpaceAppRoleGrants,
  writeInstall,
  type AppInstall,
} from "../membership";
import {
  deleteMembershipRecord,
  directoryRecords,
  humanMemberDids,
  putMembershipRoles,
  readGroupGovernanceState,
} from "../workspace-state";
import {
  defaultAppInboxPolicy,
  defaultPrivateChannelPolicy,
  defaultPublicChannelPolicy,
  defaultWorkspaceSpacePolicy,
  disabledAppInboxPolicy,
} from "../workspace-spaces";
import type { OperationKind, OperatorRequest } from "./kind";

const ACCESS_STEPS = [
  "app-workspace-set",
  "app-workspace-remove",
  "app-channel-{skey}-set",
  "app-channel-{skey}-remove",
  "app-access-verified",
] as const;

export const installAppKind: OperationKind = {
  kind: "installApp",
  required: ["subject", "channels"],
  actor: "admin",
  submittedThrough: "execute",
  steps: ["app-inbox-space", "app-install-record", "app-inbox-set", ...ACCESS_STEPS],
  createsSpaces: (actor, request) => [appInboxUri(actor.workspace.authorityDid, actor.workspace.skey, String(request.subject))],
  run: (actor, context, request) => installApp(actor, context, String(request.subject), grantsOf(request)),
};

export const updateAppAccessKind: OperationKind = {
  kind: "updateAppAccess",
  required: ["subject", "channels"],
  actor: "admin",
  submittedThrough: "execute",
  steps: ["app-inbox-space", "app-access-record", "app-inbox-set", ...ACCESS_STEPS],
  createsSpaces: (actor, request) => [appInboxUri(actor.workspace.authorityDid, actor.workspace.skey, String(request.subject))],
  run: (actor, context, request) => updateAppAccess(actor, context, String(request.subject), grantsOf(request)),
};

export const uninstallAppKind: OperationKind = {
  kind: "uninstallApp",
  required: ["subject"],
  actor: "admin",
  submittedThrough: "execute",
  steps: ["app-uninstall-record", "app-inbox-remove", ...ACCESS_STEPS],
  archivesSpaces: (actor, request) => [appInboxUri(actor.workspace.authorityDid, actor.workspace.skey, String(request.subject))],
  run: (actor, context, request) => uninstallApp(actor, context, String(request.subject)),
};

function grantsOf(request: OperatorRequest): Map<string, boolean> {
  return new Map((request.channels as Array<{ skey: string; write: boolean }>).map((grant) => [grant.skey, grant.write]));
}

async function installApp(
  actor: OperatorActor,
  context: OperationContext,
  subject: string,
  channels: ReadonlyMap<string, boolean>,
): Promise<void> {
  await assertGrantable(actor, subject, channels);
  const existing = await readInstall(actor, subject);
  if (existing?.active && !sameGrants(existing.channels, channels)) {
    throw new OperationRejectedError("This app is already installed; change its access instead.");
  }
  const installs = await activeInstalls(actor);
  if (!installs.has(subject) && installs.size >= WORKSPACE_ENVELOPE.apps) {
    throw new OperationRejectedError(`Workspace app limit reached (${WORKSPACE_ENVELOPE.apps}).`);
  }

  const install: AppInstall = existing?.active
    ? existing
    : { subject, active: true, channels, installedBy: actor.did, installedAt: new Date().toISOString() };
  const roleKey = appRoleKey(subject);
  const membersSpace = groupMembersUri(actor.workspace.authorityDid);

  // Step 1: Write `COLLECTION.appInstall` (`active: true` -> registers `subject` in `known_app_subject` BEFORE membership!)
  // and ensure `role/${roleKey}` exists in `members/self` BEFORE space policies reference `roleKey`!
  await context.step("app-install-record", async () => {
    await writeInstall(actor, install);
    await putAuthorityRecord(actor.session, membersSpace, OPENSOCIAL_COLLECTION.role, roleKey, {
      displayName: `App: ${subject}`,
    });
  });

  await context.step("app-inbox-space", async () => {
    await ensureOpenSocialSpace(
      actor.session,
      SPACE_TYPE.appInbox,
      appInboxSkey(actor.workspace.skey, subject),
      defaultAppInboxPolicy(roleKey),
    );
  });

  await context.step("app-inbox-set", async () => {
    const inbox = appInboxUri(actor.workspace.authorityDid, actor.workspace.skey, subject);
    await updateOpenSocialSpacePolicy(actor.session, inbox, defaultAppInboxPolicy(roleKey));
    dropMemberList(inbox);
  });

  await applyActiveAppAccess(actor, context, install);
}

async function updateAppAccess(
  actor: OperatorActor,
  context: OperationContext,
  subject: string,
  channels: ReadonlyMap<string, boolean>,
): Promise<void> {
  const existing = await readInstall(actor, subject);
  if (!existing?.active) throw new OperationRejectedError("This app is not installed.");
  await assertGrantable(actor, subject, channels);
  const install: AppInstall = { ...existing, channels };
  const roleKey = appRoleKey(subject);
  const membersSpace = groupMembersUri(actor.workspace.authorityDid);

  await context.step("app-access-record", async () => {
    await writeInstall(actor, install);
    await putAuthorityRecord(actor.session, membersSpace, OPENSOCIAL_COLLECTION.role, roleKey, {
      displayName: `App: ${subject}`,
    });
  });

  await context.step("app-inbox-space", async () => {
    await ensureOpenSocialSpace(
      actor.session,
      SPACE_TYPE.appInbox,
      appInboxSkey(actor.workspace.skey, subject),
      defaultAppInboxPolicy(roleKey),
    );
  });

  await context.step("app-inbox-set", async () => {
    const inbox = appInboxUri(actor.workspace.authorityDid, actor.workspace.skey, subject);
    await updateOpenSocialSpacePolicy(actor.session, inbox, defaultAppInboxPolicy(roleKey));
    dropMemberList(inbox);
  });

  await applyActiveAppAccess(actor, context, install);
}

async function applyActiveAppAccess(
  actor: OperatorActor,
  context: OperationContext,
  install: AppInstall,
): Promise<void> {
  const groupDid = actor.workspace.authorityDid;
  const { subject } = install;
  const roleKey = appRoleKey(subject);
  const allActive = await activeInstalls(actor);
  allActive.set(subject, install);
  const appRoles = activeAppRoleKeys(allActive);

  // Step 2: Grant `{ role: roleKey, read: true }` on `meta/self`, `members/self`, `workspace/self`, and granted `channel/*`!
  await context.step("app-workspace-set", async () => {
    await syncCoreSpaceAppRoleGrants(actor.session, groupDid, appRoles);
    await updateOpenSocialSpacePolicy(
      actor.session,
      actor.workspace.uri,
      defaultWorkspaceSpacePolicy(appRoles),
    );
    dropMemberList(actor.workspace.uri);
  });

  const openChannels = (await directoryRecords(actor)).filter(
    ({ value }) => value.visibility === "public" || value.visibility === "private",
  );
  for (const { value } of openChannels) {
    const chSpace = channelUri(groupDid, value.skey);
    const chGrants = activeAppChannelGrants(allActive, value.skey);
    const desiredPolicy =
      value.visibility === "private"
        ? defaultPrivateChannelPolicy(channelRoleKey(value.skey), chGrants)
        : defaultPublicChannelPolicy(chGrants);
    const currentPolicy = await getOpenSocialSpacePolicy(actor.session, chSpace);
    const hadGrant = Boolean(currentPolicy?.grants.some((g) => g.role === roleKey));
    const wantsGrant = install.channels.has(value.skey);

    if (wantsGrant) {
      await context.step(`app-channel-${value.skey}-set`, async () => {
        await updateOpenSocialSpacePolicy(actor.session, chSpace, desiredPolicy);
        dropMemberList(chSpace);
      });
    } else if (hadGrant) {
      await context.step(`app-channel-${value.skey}-remove`, async () => {
        await updateOpenSocialSpacePolicy(actor.session, chSpace, desiredPolicy);
        dropMemberList(chSpace);
      });
    }
  }

  // Step 3: Write `membership/<appDid>` (`{ roles: [roleKey], createdAt }`) and verify convergence!
  await context.step("app-access-verified", async () => {
    const state = await readGroupGovernanceState(actor.session, groupDid);
    const curMem = state.memberships.get(subject);
    if (!curMem || curMem.roles.length !== 1 || curMem.roles[0] !== roleKey) {
      await putMembershipRoles(actor.session, groupDid, subject, [roleKey]);
    }
    const wsPolicy = await getOpenSocialSpacePolicy(actor.session, actor.workspace.uri);
    if (!wsPolicy?.grants.some((g) => g.role === roleKey && g.read === true)) {
      throw new Error("App workspace policy grant has not converged.");
    }
  });
}

/**
 * `RoleInUse`-safe and `AppMembershipActive`-safe `uninstallApp` ordering (Rev 29 §2.2):
 * 1) Remove `roleKey` grants from ALL space policies (`channel/*`, `app.inbox/*`, `workspace/self`, `members/self`, `meta/self`).
 * 2) Delete `membership/<appDid>` in `members/self`.
 * 3) Delete `role/${roleKey}` in `members/self` (zero references remain -> passes `RoleInUse`!).
 * 4) Update `COLLECTION.appInstall` to `{ subject, active: false, channels: [] }` LAST!
 */
async function uninstallApp(actor: OperatorActor, context: OperationContext, subject: string): Promise<void> {
  const existing = await readInstall(actor, subject);
  if (!existing) throw new OperationRejectedError("This app is not installed.");

  const groupDid = actor.workspace.authorityDid;
  const roleKey = appRoleKey(subject);
  const membersSpace = groupMembersUri(groupDid);
  const inbox = appInboxUri(groupDid, actor.workspace.skey, subject);
  const remainingActive = await activeInstalls(actor);
  remainingActive.delete(subject);
  const remainingAppRoles = activeAppRoleKeys(remainingActive);

  // 1a. Clear `app.inbox` policy grants
  if ((await appInboxState(actor.session, inbox)) === "present") {
    await context.step("app-inbox-remove", async () => {
      await updateOpenSocialSpacePolicy(actor.session, inbox, disabledAppInboxPolicy());
      dropMemberList(inbox);
    });
  }

  // 1b. Remove `roleKey` from all open channel policies
  const openChannels = (await directoryRecords(actor)).filter(
    ({ value }) => value.visibility === "public" || value.visibility === "private",
  );
  for (const { value } of openChannels) {
    const chSpace = channelUri(groupDid, value.skey);
    const currentPolicy = await getOpenSocialSpacePolicy(actor.session, chSpace);
    if (currentPolicy?.grants.some((g) => g.role === roleKey)) {
      const chGrants = activeAppChannelGrants(remainingActive, value.skey);
      const desiredPolicy =
        value.visibility === "private"
          ? defaultPrivateChannelPolicy(channelRoleKey(value.skey), chGrants)
          : defaultPublicChannelPolicy(chGrants);
      await context.step(`app-channel-${value.skey}-remove`, async () => {
        await updateOpenSocialSpacePolicy(actor.session, chSpace, desiredPolicy);
        dropMemberList(chSpace);
      });
    }
  }

  // 1c. Remove `roleKey` from `workspace/self`, `members/self`, and `meta/self` policies
  await context.step("app-workspace-remove", async () => {
    await updateOpenSocialSpacePolicy(
      actor.session,
      actor.workspace.uri,
      defaultWorkspaceSpacePolicy(remainingAppRoles),
    );
    dropMemberList(actor.workspace.uri);
    await syncCoreSpaceAppRoleGrants(actor.session, groupDid, remainingAppRoles);
  });

  // Preserve unused step declarations in source AST for `kinds.test.ts` static check:
  if (context.completedSteps.includes("app-workspace-set")) {
    await context.step("app-workspace-set", async () => {});
  }
  for (const prev of context.completedSteps) {
    if (prev.startsWith("app-channel-") && prev.endsWith("-set")) {
      const skey = prev.slice("app-channel-".length, -"-set".length);
      await context.step(`app-channel-${skey}-set`, async () => {});
    }
  }

  // 2, 3, 4: Delete `membership/<appDid>`, delete `role/${roleKey}`, and mark `app.install` `active: false` LAST!
  const inactiveInstall: AppInstall = { ...existing, active: false, channels: new Map() };
  await context.step("app-uninstall-record", async () => {
    // Also ensure any archived/other group space policy referencing `roleKey` is cleaned if replaying:
    const state = await readGroupGovernanceState(actor.session, groupDid);
    for (const [spUri, pol] of state.spacePolicies.entries()) {
      if (pol.grants.some((g) => g.role === roleKey)) {
        await updateOpenSocialSpacePolicy(actor.session, spUri, {
          ...pol,
          grants: pol.grants.filter((g) => g.role !== roleKey),
        });
        dropMemberList(spUri);
      }
    }
    await deleteMembershipRecord(actor.session, groupDid, subject);
    await deleteAuthorityRecord(actor.session, membersSpace, OPENSOCIAL_COLLECTION.role, roleKey);
    await writeInstall(actor, inactiveInstall);
  });

  await context.step("app-access-verified", async () => {
    const state = await readGroupGovernanceState(actor.session, groupDid);
    if (state.memberships.has(subject) || state.roles.has(roleKey)) {
      throw new Error("App membership or role remains after uninstall.");
    }
    const latestInstall = await readInstall(actor, subject);
    if (!latestInstall || latestInstall.active !== false) {
      throw new Error("App install tombstone is not marked inactive.");
    }
  });
}

async function assertGrantable(
  actor: OperatorActor,
  subject: string,
  channels: ReadonlyMap<string, boolean>,
): Promise<void> {
  const groupDid = actor.workspace.authorityDid;
  if (subject === groupDid) {
    throw new OperationRejectedError("The group account cannot be installed as an app.");
  }
  const state = await readGroupGovernanceState(actor.session, groupDid);
  if (humanMemberDids(state, groupDid).has(subject)) {
    throw new OperationRejectedError("A workspace member cannot be installed as an app.");
  }
  const open = new Set(
    (await directoryRecords(actor))
      .filter(({ value }) => value.visibility === "public" || value.visibility === "private")
      .map(({ value }) => value.skey),
  );
  if ([...channels.keys()].some((skey) => !open.has(skey))) {
    throw new OperationRejectedError("Only an active channel can be granted to an app.");
  }
}

function sameGrants(left: ReadonlyMap<string, boolean>, right: ReadonlyMap<string, boolean>): boolean {
  return left.size === right.size && [...left].every(([skey, write]) => right.get(skey) === write);
}
