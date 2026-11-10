import { putSpaceMember } from "@/atproto/space-ops";
import { channelUri, inboxUri } from "@/protocol/keys";
import { OperationRejectedError, type OperationContext } from "../journal";
import type { OperatorActor } from "../actor";
import { activeRoster, assertMembership, directoryRecords, writeRoster } from "../workspace-state";
import type { OperationKind } from "./kind";

export const inviteMemberKind: OperationKind = {
  kind: "inviteMember",
  required: ["subject"],
  actor: "admin",
  submittedThrough: "execute",
  steps: ["member-workspace", "member-inbox-writer", "member-public-channel-{skey}", "member-workspace-roster", "member-state-verified"],
  run: (actor, context, request) => inviteMember(actor, context, request.subject as string),
};

async function inviteMember(actor: OperatorActor, context: OperationContext, subject: string): Promise<void> {
  if (subject === actor.workspace.authorityDid) throw new OperationRejectedError("The workspace authority is already an implicit member.");
  const workspace = actor.workspace.uri;
  const inbox = inboxUri(actor.workspace.authorityDid, actor.workspace.skey);
  const channels = await directoryRecords(actor);
  const publicChannels = channels.filter((record) => record.value.visibility === "public");
  const current = await activeRoster(actor);
  if (!current.has(subject) && current.size >= 200) throw new OperationRejectedError("Workspace member limit reached (200).");

  await context.step("member-workspace", () => putSpaceMember(actor.session, workspace, subject, true, true));
  await context.step("member-inbox-writer", () => putSpaceMember(actor.session, inbox, subject, false, true));
  for (const channel of publicChannels) {
    const space = channelUri(actor.workspace.authorityDid, channel.value.skey);
    await context.step(`member-public-channel-${channel.value.skey}`, () => putSpaceMember(actor.session, space, subject, true, true));
  }
  await context.step("member-workspace-roster", async () => {
    await writeRoster(actor, workspace, subject, true);
  });
  await context.step("member-state-verified", async () => {
    await assertMembership(actor, workspace, subject, true, true);
    await assertMembership(actor, inbox, subject, false, true);
    for (const channel of publicChannels) await assertMembership(actor, channelUri(actor.workspace.authorityDid, channel.value.skey), subject, true, true);
  });
}
