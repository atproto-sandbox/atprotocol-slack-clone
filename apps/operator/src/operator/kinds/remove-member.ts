import { appInboxState } from "../../atproto/space-ops";
import { appInboxUri, channelUri, inboxUri } from "@flock/protocol/keys";
import { COLLECTION } from "@flock/protocol/nsids";
import { OperationRejectedError, type OperationContext } from "../journal";
import type { OperatorActor } from "../actor";
import { activeAdmins, assertNoMembership, directoryRecords, hasActiveAdminRecord, writeRoster } from "../workspace-state";
import type { OperationKind } from "./kind";
import { removeListMember } from "../members";
import { activeInstalls, readInstall } from "../membership";

const REMOVAL_STEPS = [
  "remove-inbox-membership", "remove-app-inbox-{app}", "remove-channel-{skey}", "remove-workspace-membership", "deactivate-workspace-roster", "deactivate-admin", "removal-verified",
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

/** A member removing themselves: the same steps as a removal, run for the member who asked. */
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
  if (subject === actor.workspace.authorityDid) throw new OperationRejectedError("The workspace authority cannot be removed.");
  if ((await readInstall(actor, subject))?.active) throw new OperationRejectedError("An installed app is removed with uninstallApp.");
  const admins = await activeAdmins(actor);
  const subjectIsEffectiveAdmin = admins.has(subject);
  const subjectHasActiveAdminRecord = await hasActiveAdminRecord(actor, subject);
  if (subjectIsEffectiveAdmin && admins.size <= 1) throw new OperationRejectedError("The last active admin cannot leave or be removed.");
  const inbox = inboxUri(actor.workspace.authorityDid, actor.workspace.skey);
  const channels = await directoryRecords(actor);
  const workspace = actor.workspace.uri;
  const installs = await activeInstalls(actor);
  const appInboxes: Array<{ app: string; space: string }> = [];
  for (const install of [...installs.values()].sort((left, right) => left.subject.localeCompare(right.subject))) {
    const space = appInboxUri(actor.workspace.authorityDid, actor.workspace.skey, install.subject);
    if (await appInboxState(actor.session, space) === "present") appInboxes.push({ app: install.subject, space });
  }
  await context.step("remove-inbox-membership", () => removeListMember(actor.session, inbox, subject));
  for (const appInbox of appInboxes) {
    await context.step(`remove-app-inbox-${appInbox.app}`, () => removeListMember(actor.session, appInbox.space, subject));
  }
  for (const channel of channels) {
    const channelSpace = channelUri(actor.workspace.authorityDid, channel.value.skey);
    await context.step(`remove-channel-${channel.value.skey}`, async () => {
      await removeListMember(actor.session, channelSpace, subject);
      if (channel.value.visibility === "private") await writeRoster(actor, channelSpace, subject, false, COLLECTION.channelRoster);
    });
  }
  await context.step("remove-workspace-membership", () => removeListMember(actor.session, workspace, subject));
  await context.step("deactivate-workspace-roster", () => writeRoster(actor, workspace, subject, false));
  if (subjectHasActiveAdminRecord) await context.step("deactivate-admin", () => writeRoster(actor, workspace, subject, false, COLLECTION.admin));
  await context.step("removal-verified", async () => {
    await assertNoMembership(actor, inbox, subject);
    for (const appInbox of appInboxes) await assertNoMembership(actor, appInbox.space, subject);
    await assertNoMembership(actor, workspace, subject);
    for (const channel of channels) await assertNoMembership(actor, channelUri(actor.workspace.authorityDid, channel.value.skey), subject);
  });
}
