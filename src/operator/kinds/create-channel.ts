import { listSpaceMembers, putAuthorityRecord, putSpaceMember, ensureMemberListSpace } from "@/atproto/space-ops";
import { channelUri } from "@/protocol/keys";
import { COLLECTION, SPACE_TYPE } from "@/protocol/nsids";
import { OperationRejectedError, type OperationContext } from "../journal";
import type { OperatorActor } from "../actor";
import { currentWorkspaceMembers, directoryRecords, writeRoster } from "../workspace-state";
import type { OperationKind, OperatorRequest } from "./kind";

export const createChannelKind: OperationKind = {
  kind: "createChannel",
  required: ["skey", "name", "visibility"],
  optional: ["members"],
  actor: "admin",
  submittedThrough: "execute",
  steps: ["channel-space", "channel-member-{did}", "channel-roster-{did}", "channel-directory", "channel-membership-verified"],
  run: (actor, context, request) => createChannel(actor, context, request as OperatorRequest & { skey: string; name: string; visibility: "public" | "private"; members?: string[] }),
};

async function createChannel(
  actor: OperatorActor,
  context: OperationContext,
  operation: OperatorRequest & { skey: string; name: string; visibility: "public" | "private"; members?: string[] },
): Promise<void> {
  const channels = await directoryRecords(actor);
  const skey = `${actor.workspace.skey}-${operation.skey}`;
  if (skey.length > 128) throw new OperationRejectedError("Channel key is too long for this workspace.");
  const existing = channels.find((record) => record.value.skey === skey);
  if (existing && (existing.value.name !== operation.name.trim() || existing.value.visibility !== operation.visibility)) {
    throw new OperationRejectedError("Channel key already belongs to a different channel.");
  }
  const activeChannelCount = channels.filter(({ value }) => value.visibility !== "archived").length;
  if (!existing && activeChannelCount >= 100) throw new OperationRejectedError("Workspace channel limit reached (100).");
  const workspaceMembers = await currentWorkspaceMembers(actor);
  const selected = operation.visibility === "public" ? [...workspaceMembers] : (operation.members ?? []);
  if (operation.visibility === "private" && selected.some((did) => !workspaceMembers.has(did))) throw new OperationRejectedError("Private channels can include only active workspace members.");
  const space = channelUri(actor.workspace.authorityDid, skey);
  await context.step("channel-space", async () => { await ensureMemberListSpace(actor.session, SPACE_TYPE.channel, skey); });
  for (const did of selected) {
    if (did === actor.workspace.authorityDid) continue;
    await context.step(`channel-member-${did}`, () => putSpaceMember(actor.session, space, did, true, true));
    if (operation.visibility === "private") {
      await context.step(`channel-roster-${did}`, () => writeRoster(actor, space, did, true, COLLECTION.channelRoster));
    }
  }
  await context.step("channel-directory", () => putAuthorityRecord(actor.session, actor.workspace.uri, COLLECTION.directory, skey, {
    skey, name: operation.name.trim(), visibility: operation.visibility,
  }).then(() => undefined));
  await context.step("channel-membership-verified", async () => {
    // One member-list read for every selected member, not one read each.
    const members = new Map((await listSpaceMembers(actor.session, space)).map((member) => [member.did, member]));
    for (const did of selected) {
      if (did === actor.workspace.authorityDid) continue;
      const member = members.get(did);
      if (!member?.read || !member.write) throw new Error("PDS membership has not converged to the requested state.");
    }
  });
}
