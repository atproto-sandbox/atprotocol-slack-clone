import { listSpaceMembers } from "../../atproto/space-ops";
import { channelUri, inboxUri } from "@flock/protocol/keys";
import { COLLECTION } from "@flock/protocol/nsids";
import type { OperationContext } from "../journal";
import type { OperatorActor } from "../actor";
import { activeAdmins, activePrivateRoster, activeRoster, directoryRecords, writeRoster } from "../workspace-state";
import { activeInstalls, expectedChannelList, expectedInboxList, expectedWorkspaceList, listMatches, type Access } from "../membership";
import type { OperationKind } from "./kind";
import { putListMember, removeListMember } from "../members";

export const reconcileWorkspaceKind: OperationKind = {
  kind: "reconcileWorkspace",
  required: [],
  actor: "admin",
  submittedThrough: "execute",
  steps: [
    "workspace-set-{did}", "workspace-remove-{did}", "workspace-verified",
    "inbox-set-{did}", "inbox-remove-{did}", "inbox-verified",
    "channel-{skey}-set-{did}", "channel-{skey}-remove-{did}", "channel-{skey}-verified", "channel-{skey}-deactivate-stale-roster-{did}",
    "archived-{skey}-set-{did}", "archived-{skey}-remove-{did}", "archived-{skey}-verified", "archived-{skey}-deactivate-roster-{did}",
  ],
  run: (actor, context) => reconcileWorkspace(actor, context),
};

async function reconcileWorkspace(actor: OperatorActor, context: OperationContext): Promise<void> {
  const workspace = actor.workspace.uri;
  const inbox = inboxUri(actor.workspace.authorityDid, actor.workspace.skey);
  const members = await activeRoster(actor);
  const admins = await activeAdmins(actor);
  const installs = await activeInstalls(actor);
  await reconcileSpace(actor, context, "workspace", workspace, expectedWorkspaceList(members, installs));
  await reconcileSpace(actor, context, "inbox", inbox, expectedInboxList(members, admins));
  const channels = (await directoryRecords(actor)).sort((left, right) => left.value.skey.localeCompare(right.value.skey));
  for (const channel of channels) {
    const space = channelUri(actor.workspace.authorityDid, channel.value.skey);
    if (channel.value.visibility === "transitioning") continue;
    if (channel.value.visibility === "archived") {
      await reconcileSpace(actor, context, `archived-${channel.value.skey}`, space, expectedChannelList(channel.value, members, new Set(), installs));
      for (const did of await activePrivateRoster(actor, space)) {
        await context.step(`archived-${channel.value.skey}-deactivate-roster-${did}`, () => writeRoster(actor, space, did, false, COLLECTION.channelRoster));
      }
      continue;
    }
    const privateRoster = channel.value.visibility === "private" ? await activePrivateRoster(actor, space) : new Set<string>();
    for (const did of privateRoster) if (!members.has(did)) {
      await context.step(`channel-${channel.value.skey}-deactivate-stale-roster-${did}`, () => writeRoster(actor, space, did, false, COLLECTION.channelRoster));
    }
    await reconcileSpace(actor, context, `channel-${channel.value.skey}`, space, expectedChannelList(channel.value, members, privateRoster, installs));
  }
}

async function reconcileSpace(
  actor: OperatorActor,
  context: OperationContext,
  label: string,
  space: string,
  desired: ReadonlyMap<string, Access>,
): Promise<void> {
  const current = await listSpaceMembers(actor.session, space);
  const authorityDid = actor.workspace.authorityDid;
  const desiredNonOwner = new Map([...desired].filter(([did]) => did !== authorityDid));
  for (const [did, access] of desiredNonOwner) {
    const existing = current.find((member) => member.did === did);
    if (existing?.read !== access.read || existing?.write !== access.write) {
      await context.step(`${label}-set-${did}`, () => putListMember(actor.session, space, did, access.read, access.write));
    }
  }
  for (const member of current) {
    if (member.did !== authorityDid && !desiredNonOwner.has(member.did)) {
      await context.step(`${label}-remove-${member.did}`, () => removeListMember(actor.session, space, member.did));
    }
  }
  await context.step(`${label}-verified`, async () => {
    if (!listMatches(desired, await listSpaceMembers(actor.session, space), authorityDid)) throw new Error(`Membership reconciliation has not converged for ${label}.`);
  });
}
