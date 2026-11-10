import { listSpaceMembers, putAuthorityRecord, putSpaceMember, removeSpaceMember } from "@/atproto/space-ops";
import { channelUri } from "@/protocol/keys";
import { COLLECTION } from "@/protocol/nsids";
import { OperationRejectedError, type OperationContext } from "../journal";
import type { OperatorActor } from "../actor";
import { activePrivateRoster, currentWorkspaceMembers, getOwnerRecord, writeRoster } from "../workspace-state";
import type { OperationKind, OperatorRequest } from "./kind";

export const transitionChannelKind: OperationKind = {
  kind: "transitionChannel",
  required: ["skey", "visibility"],
  optional: ["members"],
  actor: "admin",
  submittedThrough: "execute",
  steps: [
    "channel-set-transitioning", "channel-public-add-{did}", "channel-remove-{did}", "channel-roster-inactive-{did}", "channel-private-add-{did}",
    "channel-roster-active-{did}", "channel-visibility-verified", "channel-set-final-visibility",
  ],
  validate(request) {
    if (request.visibility === "private" && !Array.isArray(request.members)) throw new Error("Private transition requires the selected member list.");
  },
  run: (actor, context, request) => transitionChannel(actor, context, request as OperatorRequest & { skey: string; visibility: "public" | "private"; members?: string[] }),
};

async function transitionChannel(
  actor: OperatorActor,
  context: OperationContext,
  operation: OperatorRequest & { skey: string; visibility: "public" | "private"; members?: string[] },
): Promise<void> {
  const directory = await getOwnerRecord(actor.session, actor.workspace.uri, COLLECTION.directory, operation.skey);
  if (!directory || typeof directory.name !== "string") throw new OperationRejectedError("Channel does not exist.");
  if (directory.visibility === "archived") throw new OperationRejectedError("Archived channels cannot change visibility.");
  const space = channelUri(actor.workspace.authorityDid, operation.skey);
  const activeMembers = await currentWorkspaceMembers(actor);
  const selected = operation.visibility === "public" ? [...activeMembers] : (operation.members ?? []);
  if (operation.visibility === "private" && selected.some((did) => !activeMembers.has(did))) throw new OperationRejectedError("Private channels can include only active workspace members.");
  await context.step("channel-set-transitioning", async () => {
    await putAuthorityRecord(actor.session, actor.workspace.uri, COLLECTION.directory, operation.skey, {
      skey: operation.skey, name: directory.name, visibility: "transitioning",
    });
  });
  const currentMembers = await listSpaceMembers(actor.session, space);
  const desired = new Set(selected.filter((did) => did !== actor.workspace.authorityDid));
  if (operation.visibility === "public") {
    for (const did of desired) await context.step(`channel-public-add-${did}`, () => putSpaceMember(actor.session, space, did, true, true));
  }
  for (const member of currentMembers) {
    if (!desired.has(member.did)) await context.step(`channel-remove-${member.did}`, () => removeSpaceMember(actor.session, space, member.did));
  }
  if (operation.visibility === "private") {
    const roster = await activePrivateRoster(actor, space);
    for (const did of roster) if (!desired.has(did)) {
      await context.step(`channel-roster-inactive-${did}`, () => writeRoster(actor, space, did, false, COLLECTION.channelRoster));
    }
    for (const did of selected) {
      if (did === actor.workspace.authorityDid) continue;
      await context.step(`channel-private-add-${did}`, () => putSpaceMember(actor.session, space, did, true, true));
      await context.step(`channel-roster-active-${did}`, () => writeRoster(actor, space, did, true, COLLECTION.channelRoster));
    }
  }
  await context.step("channel-visibility-verified", async () => {
    const actual = (await listSpaceMembers(actor.session, space)).filter((member) => member.did !== actor.workspace.authorityDid);
    const actualByDid = new Map(actual.map((member) => [member.did, member]));
    if (actualByDid.size !== desired.size || actualByDid.size !== actual.length || [...desired].some((did) => {
      const member = actualByDid.get(did);
      return !member || !member.read || !member.write;
    })) {
      throw new Error("Channel member list has not converged.");
    }
    if (operation.visibility === "private") {
      const currentRoster = await activePrivateRoster(actor, space);
      const desiredRoster = new Set(selected.filter((did) => did !== actor.workspace.authorityDid));
      if (currentRoster.size !== desiredRoster.size || [...desiredRoster].some((did) => !currentRoster.has(did))) {
        throw new Error("Private channel roster has not converged.");
      }
    }
  });
  await context.step("channel-set-final-visibility", () => putAuthorityRecord(actor.session, actor.workspace.uri, COLLECTION.directory, operation.skey, {
    skey: operation.skey, name: directory.name, visibility: operation.visibility,
  }).then(() => undefined));
}
