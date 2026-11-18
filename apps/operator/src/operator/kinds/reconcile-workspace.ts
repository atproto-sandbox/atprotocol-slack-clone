import { appInboxState, ensureMemberListSpace, listSpaceMembers } from "../../atproto/space-ops";
import { appInboxSkey, appInboxUri, channelUri, inboxUri } from "@flock/protocol/keys";
import { COLLECTION, SPACE_TYPE } from "@flock/protocol/nsids";
import type { OperationContext } from "../journal";
import type { OperatorActor } from "../actor";
import { activeAdmins, activePrivateRoster, activeRoster, directoryRecords, writeRoster } from "../workspace-state";
import {
  activeInstalls,
  allInstalls,
  expectedAppInboxList,
  expectedChannelList,
  expectedInboxList,
  expectedWorkspaceList,
  listMatches,
  type Access,
  type AppInstall,
} from "../membership";
import type { OperationKind } from "./kind";
import { putListMember, putListMembers, removeListMember, removeListMembers } from "../members";

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
    "app-inbox-{did}-space", "app-inbox-{did}-set", "app-inbox-{did}-remove", "app-inbox-{did}-verified",
  ],
  run: (actor, context) => reconcileWorkspace(actor, context),
};

/** Whether an active install's inbox cannot be created or read because the workspace authority's grant predates `app.inbox`. */
export async function hasUncoveredAppInbox(actor: OperatorActor): Promise<boolean> {
  const installs = await activeInstalls(actor);
  const first = [...installs.values()][0];
  if (!first) return false;
  return (await appInboxState(actor.session, appInboxUri(actor.workspace.authorityDid, actor.workspace.skey, first.subject))) === "uncovered";
}

async function reconcileWorkspace(actor: OperatorActor, context: OperationContext): Promise<void> {
  const workspace = actor.workspace.uri;
  const inbox = inboxUri(actor.workspace.authorityDid, actor.workspace.skey);
  const members = await activeRoster(actor);
  const admins = await activeAdmins(actor);
  const all = await allInstalls(actor);
  const installs = new Map([...all].filter(([, install]) => install.active));
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
  for (const install of [...all.values()].sort((left, right) => left.subject.localeCompare(right.subject))) {
    await reconcileAppInbox(actor, context, members, install);
  }
}

async function reconcileAppInbox(
  actor: OperatorActor,
  context: OperationContext,
  members: ReadonlySet<string>,
  install: AppInstall,
): Promise<void> {
  const authorityDid = actor.workspace.authorityDid;
  const inbox = appInboxUri(authorityDid, actor.workspace.skey, install.subject);
  const state = await appInboxState(actor.session, inbox);
  if (state === "uncovered" || (!install.active && state === "missing")) return;
  if (install.active && state === "missing") {
    await context.step(`app-inbox-${install.subject}-space`, async () => {
      await ensureMemberListSpace(actor.session, SPACE_TYPE.appInbox, appInboxSkey(actor.workspace.skey, install.subject));
    });
  }
  const desired = expectedAppInboxList(members, install);
  const desiredNonOwner = new Map([...desired].filter(([did]) => did !== authorityDid));
  const current = await listSpaceMembers(actor.session, inbox);
  const needsSet = [...desiredNonOwner].some(([did, access]) => {
    const existing = current.find((member) => member.did === did);
    return existing?.read !== access.read || existing?.write !== access.write;
  });
  if (needsSet) {
    await context.step(`app-inbox-${install.subject}-set`, async () => {
      const latest = await listSpaceMembers(actor.session, inbox);
      const toPut = [...desiredNonOwner].flatMap(([did, access]) => {
        const existing = latest.find((member) => member.did === did);
        return existing?.read === access.read && existing.write === access.write ? [] : [{ did, ...access }];
      });
      await putListMembers(actor.session, inbox, toPut);
    });
  }
  const needsRemove = current.some((member) => member.did !== authorityDid && !desiredNonOwner.has(member.did));
  if (needsRemove) {
    await context.step(`app-inbox-${install.subject}-remove`, async () => {
      const latest = await listSpaceMembers(actor.session, inbox);
      const extras = latest.filter((member) => member.did !== authorityDid && !desiredNonOwner.has(member.did)).map((member) => member.did);
      const ordered = extras.includes(install.subject)
        ? [install.subject, ...extras.filter((did) => did !== install.subject)]
        : extras;
      await removeListMembers(actor.session, inbox, ordered);
    });
  }
  await context.step(`app-inbox-${install.subject}-verified`, async () => {
    const finalList = needsSet || needsRemove ? await listSpaceMembers(actor.session, inbox) : current;
    if (!listMatches(desired, finalList, authorityDid)) {
      throw new Error(`Membership reconciliation has not converged for app-inbox-${install.subject}.`);
    }
  });
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
