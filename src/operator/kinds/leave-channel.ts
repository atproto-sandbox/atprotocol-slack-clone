import { listSpaceMembers, removeSpaceMember } from "@/atproto/space-ops";
import { channelUri } from "@/protocol/keys";
import { COLLECTION } from "@/protocol/nsids";
import { OperationRejectedError, type OperationContext } from "../journal";
import type { OperatorActor } from "../actor";
import { OperatorAuthError } from "../errors";
import { assertNoMembership, getOwnerRecord, writeRoster } from "../workspace-state";
import type { OperationKind } from "./kind";

export const leaveChannelKind: OperationKind = {
  kind: "leaveChannel",
  required: ["skey"],
  actor: "member",
  submittedThrough: "execute",
  steps: ["leave-channel-membership", "leave-channel-roster", "leave-channel-verified"],
  async authorizeMember(actor, request) {
    const directory = await getOwnerRecord(actor.session, actor.workspace.uri, COLLECTION.directory, request.skey as string);
    if (directory?.visibility !== "private") throw new OperatorAuthError("Only an active private channel can be left.");
    const members = await listSpaceMembers(actor.session, channelUri(actor.workspace.authorityDid, request.skey as string));
    if (!members.some((member) => member.did === actor.did && member.read && member.write)) throw new OperatorAuthError("Actor is not a member of this channel.");
  },
  run: (actor, context, request) => leaveChannel(actor, context, request.skey as string),
};

async function leaveChannel(actor: OperatorActor, context: OperationContext, skey: string): Promise<void> {
  const directory = await getOwnerRecord(actor.session, actor.workspace.uri, COLLECTION.directory, skey);
  if (!directory || directory.visibility !== "private") throw new OperationRejectedError("Only an active private channel can be left.");
  if (actor.did === actor.workspace.authorityDid) throw new OperationRejectedError("The workspace authority cannot leave its own channel.");
  const space = channelUri(actor.workspace.authorityDid, skey);
  await context.step("leave-channel-membership", () => removeSpaceMember(actor.session, space, actor.did));
  await context.step("leave-channel-roster", () => writeRoster(actor, space, actor.did, false, COLLECTION.channelRoster));
  await context.step("leave-channel-verified", () => assertNoMembership(actor, space, actor.did));
}
