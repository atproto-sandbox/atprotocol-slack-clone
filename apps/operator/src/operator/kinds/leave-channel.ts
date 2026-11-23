import { channelRoleKey, channelUri } from "@flock/protocol/keys";
import { COLLECTION } from "@flock/protocol/nsids";
import type { OperatorActor } from "../actor";
import { OperatorAuthError } from "../errors";
import { OperationRejectedError, type OperationContext } from "../journal";
import { dropMemberList } from "../member-access";
import { getOwnerRecord, putMembershipRoles, readGroupGovernanceState } from "../workspace-state";
import type { OperationKind } from "./kind";

export const leaveChannelKind: OperationKind = {
  kind: "leaveChannel",
  required: ["skey"],
  actor: "member",
  submittedThrough: "execute",
  steps: ["leave-channel-membership", "leave-channel-roster", "leave-channel-verified"],
  async authorizeMember(actor, request) {
    const skey = String(request.skey);
    const directory = await getOwnerRecord(actor.session, actor.workspace.uri, COLLECTION.directory, skey);
    if (directory?.visibility !== "private") {
      throw new OperatorAuthError("Only an active private channel can be left.");
    }
    const state = await readGroupGovernanceState(actor.session, actor.workspace.authorityDid);
    const membership = state.memberships.get(actor.did);
    if (!membership || !membership.roles.includes(channelRoleKey(skey))) {
      throw new OperatorAuthError("Actor is not a member of this channel.");
    }
  },
  endsOwnRole: () => true,
  run: (actor, context, request) => leaveChannel(actor, context, request.skey as string),
};

async function leaveChannel(actor: OperatorActor, context: OperationContext, skey: string): Promise<void> {
  const groupDid = actor.workspace.authorityDid;
  const directory = await getOwnerRecord(actor.session, actor.workspace.uri, COLLECTION.directory, skey);
  if (!directory || directory.visibility !== "private") {
    throw new OperationRejectedError("Only an active private channel can be left.");
  }
  if (actor.did === groupDid) {
    throw new OperationRejectedError("The group account cannot leave its own channel.");
  }
  const privRole = channelRoleKey(skey);
  const space = channelUri(groupDid, skey);

  await context.step("leave-channel-membership", async () => {
    const state = await readGroupGovernanceState(actor.session, groupDid);
    const cur = state.memberships.get(actor.did);
    if (!cur || !cur.roles.includes(privRole)) return;
    const remaining = cur.roles.filter((r) => r !== privRole);
    await putMembershipRoles(actor.session, groupDid, actor.did, remaining.length > 0 ? remaining : ["member"]);
    dropMemberList(space);
  });

  if (context.completedSteps.includes("leave-channel-roster")) {
    await context.step("leave-channel-roster", async () => {});
  }

  await context.step("leave-channel-verified", async () => {
    const state = await readGroupGovernanceState(actor.session, groupDid);
    if (state.memberships.get(actor.did)?.roles.includes(privRole)) {
      throw new Error("Private channel role removal has not converged.");
    }
  });
}
