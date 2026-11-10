import { removeSpaceMember } from "@/atproto/space-ops";
import { channelUri, inboxUri } from "@/protocol/keys";
import { COLLECTION } from "@/protocol/nsids";
import { OperationRejectedError, type OperationContext } from "../journal";
import type { OperatorActor } from "../actor";
import { activeAdmins, assertNoMembership, directoryRecords, hasActiveAdminRecord, writeRoster } from "../workspace-state";
import type { OperationKind } from "./kind";

const REMOVAL_STEPS = [
  "remove-inbox-membership", "remove-channel-{skey}", "remove-workspace-membership", "deactivate-workspace-roster", "deactivate-admin", "removal-verified",
] as const;

export const removeMemberKind: OperationKind = {
  kind: "removeMember",
  required: ["subject"],
  actor: "admin",
  submittedThrough: "execute",
  steps: REMOVAL_STEPS,
  run: (actor, context, request) => removeMember(actor, context, request.subject as string),
};

/** A member removing themselves: the same steps as a removal, run for the member who asked. */
export const leaveWorkspaceKind: OperationKind = {
  kind: "leaveWorkspace",
  required: [],
  actor: "member",
  submittedThrough: "execute",
  steps: REMOVAL_STEPS,
  run: (actor, context) => removeMember(actor, context, actor.did),
};

async function removeMember(actor: OperatorActor, context: OperationContext, subject: string): Promise<void> {
  if (subject === actor.workspace.authorityDid) throw new OperationRejectedError("The workspace authority cannot be removed.");
  const admins = await activeAdmins(actor);
  const subjectIsEffectiveAdmin = admins.has(subject);
  const subjectHasActiveAdminRecord = await hasActiveAdminRecord(actor, subject);
  if (subjectIsEffectiveAdmin && admins.size <= 1) throw new OperationRejectedError("The last active admin cannot leave or be removed.");
  const inbox = inboxUri(actor.workspace.authorityDid, actor.workspace.skey);
  const channels = await directoryRecords(actor);
  const workspace = actor.workspace.uri;
  await context.step("remove-inbox-membership", () => removeSpaceMember(actor.session, inbox, subject));
  for (const channel of channels) {
    const channelSpace = channelUri(actor.workspace.authorityDid, channel.value.skey);
    await context.step(`remove-channel-${channel.value.skey}`, async () => {
      await removeSpaceMember(actor.session, channelSpace, subject);
      if (channel.value.visibility === "private") await writeRoster(actor, channelSpace, subject, false, COLLECTION.channelRoster);
    });
  }
  await context.step("remove-workspace-membership", () => removeSpaceMember(actor.session, workspace, subject));
  await context.step("deactivate-workspace-roster", () => writeRoster(actor, workspace, subject, false));
  if (subjectHasActiveAdminRecord) await context.step("deactivate-admin", () => writeRoster(actor, workspace, subject, false, COLLECTION.admin));
  await context.step("removal-verified", async () => {
    await assertNoMembership(actor, inbox, subject);
    await assertNoMembership(actor, workspace, subject);
    for (const channel of channels) await assertNoMembership(actor, channelUri(actor.workspace.authorityDid, channel.value.skey), subject);
  });
}
