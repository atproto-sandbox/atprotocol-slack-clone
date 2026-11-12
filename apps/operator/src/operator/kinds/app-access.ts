import { listSpaceMembers } from "../../atproto/space-ops";
import { channelUri } from "@flock/protocol/keys";
import { WORKSPACE_ENVELOPE } from "@flock/protocol/workspace-summary";
import { OperationRejectedError, type OperationContext } from "../journal";
import type { OperatorActor } from "../actor";
import { putListMember, removeListMember } from "../members";
import { activeInstalls, appAccess, readInstall, writeInstall, type Access, type AppInstall } from "../membership";
import { activeRoster, directoryRecords } from "../workspace-state";
import type { OperationKind, OperatorRequest } from "./kind";

// An app's access to a workspace: its install record is written first, then its member-list entries are moved to what the
// record says. Every operation, reconcile included, holds the workspace lock, so a run that stops leaves the lists behind
// the record, and the next run moves them toward it, never away from it.

const ACCESS_STEPS = ["app-workspace-set", "app-workspace-remove", "app-channel-{skey}-set", "app-channel-{skey}-remove", "app-access-verified"] as const;

export const installAppKind: OperationKind = {
  kind: "installApp",
  required: ["subject", "channels"],
  actor: "admin",
  submittedThrough: "execute",
  steps: ["app-install-record", ...ACCESS_STEPS],
  run: (actor, context, request) => installApp(actor, context, String(request.subject), grantsOf(request)),
};

export const updateAppAccessKind: OperationKind = {
  kind: "updateAppAccess",
  required: ["subject", "channels"],
  actor: "admin",
  submittedThrough: "execute",
  steps: ["app-access-record", ...ACCESS_STEPS],
  run: (actor, context, request) => updateAppAccess(actor, context, String(request.subject), grantsOf(request)),
};

export const uninstallAppKind: OperationKind = {
  kind: "uninstallApp",
  required: ["subject"],
  actor: "admin",
  submittedThrough: "execute",
  steps: ["app-uninstall-record", ...ACCESS_STEPS],
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
  await context.step("app-install-record", () => writeInstall(actor, install));
  await applyAppAccess(actor, context, install);
}

async function updateAppAccess(actor: OperatorActor, context: OperationContext, subject: string, channels: ReadonlyMap<string, boolean>): Promise<void> {
  const existing = await readInstall(actor, subject);
  if (!existing?.active) throw new OperationRejectedError("This app is not installed.");
  await assertGrantable(actor, subject, channels);
  const install: AppInstall = { ...existing, channels };
  await context.step("app-access-record", () => writeInstall(actor, install));
  await applyAppAccess(actor, context, install);
}

async function uninstallApp(actor: OperatorActor, context: OperationContext, subject: string): Promise<void> {
  const existing = await readInstall(actor, subject);
  if (!existing) throw new OperationRejectedError("This app is not installed.");
  const install: AppInstall = { ...existing, active: false, channels: new Map() };
  await context.step("app-uninstall-record", () => writeInstall(actor, install));
  await applyAppAccess(actor, context, install);
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
async function applyAppAccess(actor: OperatorActor, context: OperationContext, install: AppInstall): Promise<void> {
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
  });
}

/** Where an app should be in one member list: with these bits, or (null) not at all. */
type Placement = { space: string; access: Access | null };

async function changeFor(actor: OperatorActor, placement: Placement, subject: string): Promise<"set" | "remove" | "none"> {
  const current = (await listSpaceMembers(actor.session, placement.space)).find((member) => member.did === subject);
  if (!placement.access) return current ? "remove" : "none";
  return current?.read === placement.access.read && current.write === placement.access.write ? "none" : "set";
}
