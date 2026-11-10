import { listSpaceMembers, putSpaceMember, removeSpaceMember } from "@/atproto/space-ops";
import { channelUri, inboxUri } from "@/protocol/keys";
import { COLLECTION } from "@/protocol/nsids";
import type { OperationContext } from "../journal";
import type { OperatorActor } from "../actor";
import { activeAdmins, activePrivateRoster, activeRoster, directoryRecords, writeRoster } from "../workspace-state";
import type { OperationKind } from "./kind";

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
  await reconcileSpace(actor, context, "workspace", workspace, new Map([...members].map((did) => [did, { read: true, write: true }])));
  await reconcileSpace(actor, context, "inbox", inbox, new Map([...members].map((did) => [did, { read: admins.has(did), write: true }])));
  const channels = (await directoryRecords(actor)).sort((left, right) => left.value.skey.localeCompare(right.value.skey));
  for (const channel of channels) {
    const space = channelUri(actor.workspace.authorityDid, channel.value.skey);
    if (channel.value.visibility === "transitioning") continue;
    if (channel.value.visibility === "archived") {
      await reconcileSpace(actor, context, `archived-${channel.value.skey}`, space, new Map());
      for (const did of await activePrivateRoster(actor, space)) {
        await context.step(`archived-${channel.value.skey}-deactivate-roster-${did}`, () => writeRoster(actor, space, did, false, COLLECTION.channelRoster));
      }
      continue;
    }
    let desiredDids: Set<string>;
    if (channel.value.visibility === "public") desiredDids = members;
    else {
      const privateRoster = await activePrivateRoster(actor, space);
      desiredDids = new Set([...privateRoster].filter((did) => members.has(did)));
      for (const did of privateRoster) if (!members.has(did)) {
        await context.step(`channel-${channel.value.skey}-deactivate-stale-roster-${did}`, () => writeRoster(actor, space, did, false, COLLECTION.channelRoster));
      }
    }
    await reconcileSpace(actor, context, `channel-${channel.value.skey}`, space, new Map([...desiredDids].map((did) => [did, { read: true, write: true }])));
  }
}

async function reconcileSpace(
  actor: OperatorActor,
  context: OperationContext,
  label: string,
  space: string,
  desired: Map<string, { read: boolean; write: boolean }>,
): Promise<void> {
  const current = await listSpaceMembers(actor.session, space);
  const authorityDid = actor.workspace.authorityDid;
  const desiredNonOwner = new Map([...desired].filter(([did]) => did !== authorityDid));
  for (const [did, access] of desiredNonOwner) {
    const existing = current.find((member) => member.did === did);
    if (existing?.read !== access.read || existing?.write !== access.write) {
      await context.step(`${label}-set-${did}`, () => putSpaceMember(actor.session, space, did, access.read, access.write));
    }
  }
  for (const member of current) {
    if (member.did !== authorityDid && !desiredNonOwner.has(member.did)) {
      await context.step(`${label}-remove-${member.did}`, () => removeSpaceMember(actor.session, space, member.did));
    }
  }
  await context.step(`${label}-verified`, async () => {
    const actual = (await listSpaceMembers(actor.session, space)).filter((member) => member.did !== authorityDid);
    if (actual.length !== desiredNonOwner.size || [...desiredNonOwner].some(([did, access]) => {
      const member = actual.find((entry) => entry.did === did);
      return !member || member.read !== access.read || member.write !== access.write;
    })) throw new Error(`Membership reconciliation has not converged for ${label}.`);
  });
}
