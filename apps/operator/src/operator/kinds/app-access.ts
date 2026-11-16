import { appInboxState, ensureMemberListSpace, listSpaceMembers } from "../../atproto/space-ops";
import { appInboxSkey, appInboxUri, channelUri } from "@flock/protocol/keys";
import { SPACE_TYPE } from "@flock/protocol/nsids";
import { WORKSPACE_ENVELOPE } from "@flock/protocol/workspace-summary";
import { OperationRejectedError, type OperationContext } from "../journal";
import type { OperatorActor } from "../actor";
import { putListMember, putListMembers, removeListMember, removeListMembers } from "../members";
import { activeInstalls, appAccess, expectedAppInboxList, listMatches, readInstall, writeInstall, type Access, type AppInstall } from "../membership";
import { activeRoster, directoryRecords } from "../workspace-state";
import type { OperationKind, OperatorRequest } from "./kind";

// An app's access to a workspace: install and access updates ensure its inbox space first (so an old grant is refused with
// nothing written), write its install record, sync its inbox list, and move its workspace and channel entries to what the
// record says. Uninstall writes the record inactive, removes the app from its inbox before writers, and clears its entries.

const ACCESS_STEPS = ["app-workspace-set", "app-workspace-remove", "app-channel-{skey}-set", "app-channel-{skey}-remove", "app-access-verified"] as const;

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

/** Each granted channel's key, and whether the app may write there. */
function grantsOf(request: OperatorRequest): Map<string, boolean> {
  return new Map((request.channels as Array<{ skey: string; write: boolean }>).map((grant) => [grant.skey, grant.write]));
}

async function installApp(actor: OperatorActor, context: OperationContext, subject: string, channels: ReadonlyMap<string, boolean>): Promise<void> {
  await assertGrantable(actor, subject, channels);
  const existing = await readInstall(actor, subject);
  // The same install passes, so a resume (or a repeat) does; another grant of an installed app is a change of its access.
  if (existing?.active && !sameGrants(existing.channels, channels)) throw new OperationRejectedError("This app is already installed; change its access instead.");
  const installs = await activeInstalls(actor);
  if (!installs.has(subject) && installs.size >= WORKSPACE_ENVELOPE.apps) throw new OperationRejectedError(`Workspace app limit reached (${WORKSPACE_ENVELOPE.apps}).`);
  // A repeat of the same install keeps who installed it and when.
  const install: AppInstall = existing?.active ? existing : { subject, active: true, channels, installedBy: actor.did, installedAt: new Date().toISOString() };
  // A pending pre-R10 row already wrote its install record; under a pre-R10 grant it finishes its other entries without wedging on the inbox.
  const inbox = appInboxUri(actor.workspace.authorityDid, actor.workspace.skey, subject);
  const skipUncoveredReplay = context.completedSteps.includes("app-install-record") && await appInboxState(actor.session, inbox) === "uncovered";
  if (!skipUncoveredReplay) await context.step("app-inbox-space", () => ensureAppInboxSpace(actor, subject));
  await context.step("app-install-record", () => writeInstall(actor, install));
  if (!skipUncoveredReplay) await context.step("app-inbox-set", () => syncAppInboxMembers(actor, install));
  await applyAppAccess(actor, context, install, !skipUncoveredReplay);
}

async function updateAppAccess(actor: OperatorActor, context: OperationContext, subject: string, channels: ReadonlyMap<string, boolean>): Promise<void> {
  const existing = await readInstall(actor, subject);
  if (!existing?.active) throw new OperationRejectedError("This app is not installed.");
  await assertGrantable(actor, subject, channels);
  const install: AppInstall = { ...existing, channels };
  const inbox = appInboxUri(actor.workspace.authorityDid, actor.workspace.skey, subject);
  const skipUncoveredReplay = context.completedSteps.includes("app-access-record") && await appInboxState(actor.session, inbox) === "uncovered";
  if (!skipUncoveredReplay) await context.step("app-inbox-space", () => ensureAppInboxSpace(actor, subject));
  await context.step("app-access-record", () => writeInstall(actor, install));
  if (!skipUncoveredReplay) await context.step("app-inbox-set", () => syncAppInboxMembers(actor, install));
  await applyAppAccess(actor, context, install, !skipUncoveredReplay);
}

async function uninstallApp(actor: OperatorActor, context: OperationContext, subject: string): Promise<void> {
  const existing = await readInstall(actor, subject);
  if (!existing) throw new OperationRejectedError("This app is not installed.");
  const install: AppInstall = { ...existing, active: false, channels: new Map() };
  await context.step("app-uninstall-record", () => writeInstall(actor, install));
  const inbox = appInboxUri(actor.workspace.authorityDid, actor.workspace.skey, subject);
  const inboxPresent = await appInboxState(actor.session, inbox) === "present";
  if (inboxPresent) await context.step("app-inbox-remove", () => emptyAppInboxMembers(actor, inbox, subject));
  await applyAppAccess(actor, context, install, inboxPresent);
}

async function ensureAppInboxSpace(actor: OperatorActor, appDid: string): Promise<void> {
  await ensureMemberListSpace(actor.session, SPACE_TYPE.appInbox, appInboxSkey(actor.workspace.skey, appDid));
}

async function syncAppInboxMembers(actor: OperatorActor, install: AppInstall): Promise<void> {
  const inbox = appInboxUri(actor.workspace.authorityDid, actor.workspace.skey, install.subject);
  const authorityDid = actor.workspace.authorityDid;
  const desired = new Map([...expectedAppInboxList(await activeRoster(actor), install)].filter(([did]) => did !== authorityDid));
  const current = await listSpaceMembers(actor.session, inbox);
  const toPut = [...desired].flatMap(([did, access]) => {
    const existing = current.find((member) => member.did === did);
    return existing?.read === access.read && existing.write === access.write ? [] : [{ did, ...access }];
  });
  const toRemove = current.filter((member) => member.did !== authorityDid && !desired.has(member.did)).map((member) => member.did);
  await putListMembers(actor.session, inbox, toPut);
  await removeListMembers(actor.session, inbox, toRemove);
}

async function emptyAppInboxMembers(actor: OperatorActor, inbox: string, appDid: string): Promise<void> {
  const authorityDid = actor.workspace.authorityDid;
  const current = await listSpaceMembers(actor.session, inbox);
  if (current.some((member) => member.did === appDid)) await removeListMember(actor.session, inbox, appDid);
  const writers = current.filter((member) => member.did !== appDid && member.did !== authorityDid).map((member) => member.did);
  await removeListMembers(actor.session, inbox, writers);
}

/** An app is an account that is not a person here, granted only channels that are open: public or private, not archived. */
async function assertGrantable(actor: OperatorActor, subject: string, channels: ReadonlyMap<string, boolean>): Promise<void> {
  if (subject === actor.workspace.authorityDid) throw new OperationRejectedError("The workspace account cannot be installed as an app.");
  if ((await activeRoster(actor)).has(subject)) throw new OperationRejectedError("A workspace member cannot be installed as an app.");
  const open = new Set((await directoryRecords(actor))
    .filter(({ value }) => value.visibility === "public" || value.visibility === "private").map(({ value }) => value.skey));
  if ([...channels.keys()].some((skey) => !open.has(skey))) throw new OperationRejectedError("Only an active channel can be granted to an app.");
}

function sameGrants(left: ReadonlyMap<string, boolean>, right: ReadonlyMap<string, boolean>): boolean {
  return left.size === right.size && [...left].every(([skey, write]) => right.get(skey) === write);
}

/**
 * Moves the app's entries to what its install record says: read in the workspace space while active, and its grant in each
 * open channel; no entry anywhere else. It compares with the member lists themselves, so a resume needs nothing remembered.
 * A channel being archived or changing visibility is that operation's to move; it reads the install records when it runs.
 */
async function applyAppAccess(actor: OperatorActor, context: OperationContext, install: AppInstall, verifyInbox: boolean): Promise<void> {
  const { session } = actor;
  const { subject } = install;
  const workspace: Placement = { space: actor.workspace.uri, access: appAccess(install, { type: "workspace" }) };
  const channels = (await directoryRecords(actor))
    .filter(({ value }) => value.visibility === "public" || value.visibility === "private")
    .map(({ value }): Placement & { skey: string } => ({
      skey: value.skey, space: channelUri(actor.workspace.authorityDid, value.skey), access: appAccess(install, { ...value, type: "channel" }),
    }));

  const workspaceChange = await changeFor(actor, workspace, subject);
  if (workspaceChange === "set") await context.step("app-workspace-set", () => putListMember(session, workspace.space, subject, true, false));
  if (workspaceChange === "remove") await context.step("app-workspace-remove", () => removeListMember(session, workspace.space, subject));
  for (const channel of channels) {
    const change = await changeFor(actor, channel, subject);
    const access = channel.access;
    if (change === "set" && access) await context.step(`app-channel-${channel.skey}-set`, () => putListMember(session, channel.space, subject, access.read, access.write));
    if (change === "remove") await context.step(`app-channel-${channel.skey}-remove`, () => removeListMember(session, channel.space, subject));
  }
  await context.step("app-access-verified", async () => {
    for (const placement of [workspace, ...channels]) {
      if (await changeFor(actor, placement, subject) !== "none") throw new Error("The app's member-list entries have not converged with its install record.");
    }
    if (verifyInbox) {
      const inbox = appInboxUri(actor.workspace.authorityDid, actor.workspace.skey, subject);
      const expected = expectedAppInboxList(await activeRoster(actor), install);
      if (!listMatches(expected, await listSpaceMembers(actor.session, inbox), actor.workspace.authorityDid)) {
        throw new Error("The app's inbox member list has not converged with its install record.");
      }
    }
  });
}

/** Where an app should be in one member list: with these bits, or (null) not at all. */
type Placement = { space: string; access: Access | null };

async function changeFor(actor: OperatorActor, placement: Placement, subject: string): Promise<"set" | "remove" | "none"> {
  const current = (await listSpaceMembers(actor.session, placement.space)).find((member) => member.did === subject);
  if (!placement.access) return current ? "remove" : "none";
  return current?.read === placement.access.read && current.write === placement.access.write ? "none" : "set";
}
