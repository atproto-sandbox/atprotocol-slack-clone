import { listSpaceMembers, putAuthorityRecord, removeSpaceMember } from "@/atproto/space-ops";
import { channelUri } from "@/protocol/keys";
import { COLLECTION } from "@/protocol/nsids";
import { OperationRejectedError, type OperationContext } from "../journal";
import type { OperatorActor } from "../actor";
import { activePrivateRoster, getOwnerRecord, writeRoster } from "../workspace-state";
import type { OperationKind } from "./kind";

export const archiveChannelKind: OperationKind = {
  kind: "archiveChannel",
  required: ["skey"],
  actor: "admin",
  submittedThrough: "execute",
  steps: ["channel-archive-transition", "channel-archive-remove-{did}", "channel-archive-roster-{did}", "channel-archive-verified", "channel-archive-final"],
  run: (actor, context, request) => archiveChannel(actor, context, request.skey as string),
};

async function archiveChannel(actor: OperatorActor, context: OperationContext, skey: string): Promise<void> {
  const directory = await getOwnerRecord(actor.session, actor.workspace.uri, COLLECTION.directory, skey);
  if (!directory || typeof directory.name !== "string") throw new OperationRejectedError("Channel does not exist.");
  if (directory.visibility === "archived") return;
  const space = channelUri(actor.workspace.authorityDid, skey);
  await context.step("channel-archive-transition", () => putAuthorityRecord(actor.session, actor.workspace.uri, COLLECTION.directory, skey, {
    skey, name: directory.name, visibility: "transitioning",
  }).then(() => undefined));
  const members = await listSpaceMembers(actor.session, space);
  for (const member of members) {
    await context.step(`channel-archive-remove-${member.did}`, () => removeSpaceMember(actor.session, space, member.did));
  }
  for (const did of await activePrivateRoster(actor, space)) {
    await context.step(`channel-archive-roster-${did}`, () => writeRoster(actor, space, did, false, COLLECTION.channelRoster));
  }
  await context.step("channel-archive-verified", async () => {
    if ((await listSpaceMembers(actor.session, space)).length !== 0) throw new Error("Channel members remain after archive.");
    if ((await activePrivateRoster(actor, space)).size !== 0) throw new Error("Private channel roster remains active after archive.");
  });
  await context.step("channel-archive-final", () => putAuthorityRecord(actor.session, actor.workspace.uri, COLLECTION.directory, skey, {
    skey, name: directory.name, visibility: "archived",
  }).then(() => undefined));
}
