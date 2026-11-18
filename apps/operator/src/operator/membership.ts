import { listSpaceMembers, putAuthorityRecord } from "../atproto/space-ops";
import type { OAuthSession } from "@atproto/oauth-client-node";
import type { ExtensionId } from "@flock/protocol/extensions";
import { subjectKey } from "@flock/protocol/keys";
import { COLLECTION } from "@flock/protocol/nsids";
import { validateSpaceRecord } from "@flock/protocol/registry";
import { WORKSPACE_ENVELOPE, WorkspaceEnvelopeError } from "@flock/protocol/workspace-summary";
import type { OperatorActor } from "./actor";
import { OperationRejectedError } from "./journal";
import { putListMembers, removeListMembers } from "./members";
import { activeRoster, getOwnerRecord, listOwnerRecords } from "./workspace-state";

// The one owner of who belongs in a workspace's member lists, and with which bits: people from the roster, the admins and the
// private-channel rosters; apps from their install records. Every operation that moves a list, reconcile included, asks here.

export type Access = { read: boolean; write: boolean };

/** An app's install record: `channels` maps each granted channel's key to whether the app may write there. */
export type AppInstall = {
  subject: string;
  active: boolean;
  channels: ReadonlyMap<string, boolean>;
  installedBy: string;
  installedAt: string;
};

const READ_WRITE: Access = { read: true, write: true };

/** A space an app may be in: the workspace space, or one of its channels. */
export type AppSpace = { type: "workspace" } | { type: "channel"; skey: string; visibility: string };

/**
 * Where an app belongs, by its install record: while active, reading the workspace space, and in each channel it is granted,
 * with the grant's bits, unless that channel is archived. Null is no entry. The lists below and an app's own operations both
 * place apps through this.
 */
export function appAccess(install: AppInstall, space: AppSpace): Access | null {
  if (!install.active) return null;
  if (space.type === "workspace") return { read: true, write: false };
  const write = space.visibility === "archived" ? undefined : install.channels.get(space.skey);
  return write === undefined ? null : { read: true, write };
}

/** The workspace space: every person on the roster reads and writes; every active app reads. */
export function expectedWorkspaceList(roster: ReadonlySet<string>, installs: ReadonlyMap<string, AppInstall>): Map<string, Access> {
  return new Map<string, Access>([
    ...placedApps(installs, { type: "workspace" }),
    ...[...roster].map((did): [string, Access] => [did, READ_WRITE]),
  ]);
}

/** The inbox: every person writes join requests; admins also read them. Apps have no place in it. */
export function expectedInboxList(roster: ReadonlySet<string>, admins: ReadonlySet<string>): Map<string, Access> {
  return new Map([...roster].map((did): [string, Access] => [did, { read: admins.has(did), write: true }]));
}

/** An app's inbox: while the install is active, every roster person writes and only the app reads; when inactive, nobody. */
export function expectedAppInboxList(roster: ReadonlySet<string>, install: Pick<AppInstall, "subject" | "active">): Map<string, Access> {
  if (!install.active) return new Map();
  return new Map<string, Access>([
    ...[...roster].map((did): [string, Access] => [did, { read: false, write: true }]),
    [install.subject, { read: true, write: false }],
  ]);
}

/**
 * A channel: a public one's people are the roster, a private one's are its roster's members who are still on the workspace
 * roster, an archived one has nobody; and every active app that is granted it, with its grant's bits, unless it is archived.
 */
export function expectedChannelList(
  channel: { skey: string; visibility: string },
  roster: ReadonlySet<string>,
  privateRoster: ReadonlySet<string>,
  installs: ReadonlyMap<string, AppInstall>,
): Map<string, Access> {
  if (channel.visibility === "archived") return new Map();
  const people = channel.visibility === "public" ? [...roster] : [...privateRoster].filter((did) => roster.has(did));
  return new Map<string, Access>([
    ...placedApps(installs, { ...channel, type: "channel" }),
    ...people.map((did): [string, Access] => [did, READ_WRITE]),
  ]);
}

function placedApps(installs: ReadonlyMap<string, AppInstall>, space: AppSpace): Array<[string, Access]> {
  return [...installs.values()].flatMap((install) => {
    const access = appAccess(install, space);
    return access ? [[install.subject, access] as [string, Access]] : [];
  });
}

/**
 * Whether a member list holds exactly the expected entries, with their bits. The authority, who owns the space, is aside, and
 * so is an entry with neither bit, which grants nothing.
 */
export function listMatches(expected: ReadonlyMap<string, Access>, actual: ReadonlyArray<{ did: string } & Access>, authorityDid: string): boolean {
  const others = actual.filter((member) => member.did !== authorityDid && (member.read || member.write));
  const wanted = [...expected].filter(([did]) => did !== authorityDid);
  return others.length === wanted.length && wanted.every(([did, access]) => {
    const member = others.find((entry) => entry.did === did);
    return member !== undefined && member.read === access.read && member.write === access.write;
  });
}

/** The people on the roster, once the workspace space's member list is checked to be what the model expects, apps included. */
export async function currentWorkspaceMembers(actor: OperatorActor): Promise<Set<string>> {
  const [roster, installs, listed] = await Promise.all([
    activeRoster(actor), activeInstalls(actor), listSpaceMembers(actor.session, actor.workspace.uri),
  ]);
  if (!listMatches(expectedWorkspaceList(roster, installs), listed, actor.workspace.authorityDid)) {
    throw new OperationRejectedError("Workspace roster has not converged with PDS membership.");
  }
  return roster;
}

/** Every valid install record in the workspace, active or not, by app DID. */
export async function allInstalls(actor: OperatorActor): Promise<Map<string, AppInstall>> {
  const rows = await listOwnerRecords(actor.session, actor.workspace.uri, COLLECTION.appInstall);
  const installs = new Map(rows.flatMap((row) => {
    const install = parseInstall(actor, row.rkey, row.value);
    return install ? [[install.subject, install] as const] : [];
  }));
  const activeCount = [...installs.values()].filter((install) => install.active).length;
  if (activeCount > WORKSPACE_ENVELOPE.apps) throw new WorkspaceEnvelopeError(`The active app count exceeds ${WORKSPACE_ENVELOPE.apps}.`);
  return installs;
}

/** The workspace's active installs, by app DID; an inactive one grants nothing. */
export async function activeInstalls(actor: OperatorActor): Promise<Map<string, AppInstall>> {
  return new Map([...await allInstalls(actor)].filter(([, install]) => install.active));
}

/** An app's install record, active or not, or null when it has none. */
export async function readInstall(actor: OperatorActor, app: string): Promise<AppInstall | null> {
  const key = subjectKey(app);
  return parseInstall(actor, key, await getOwnerRecord(actor.session, actor.workspace.uri, COLLECTION.appInstall, key));
}

export async function writeInstall(actor: OperatorActor, install: AppInstall): Promise<void> {
  await putAuthorityRecord(actor.session, actor.workspace.uri, COLLECTION.appInstall, subjectKey(install.subject), {
    subject: install.subject,
    active: install.active,
    channels: [...install.channels].sort(([left], [right]) => left.localeCompare(right)).map(([skey, write]) => ({ skey, write })),
    installedBy: install.installedBy,
    installedAt: install.installedAt,
    updatedAt: new Date().toISOString(),
  });
}

/** An extension's install record in the workspace space, keyed by `extId`. */
export type ExtInstall = {
  extId: ExtensionId;
  active: boolean;
  space: string;
  cleanupComplete: boolean;
  enabledBy: string;
  enabledAt: string;
  updatedAt: string;
  disabledAt?: string;
};

/** Every active roster person reads and writes in an extension space; installed apps are never granted extension access. */
export function expectedExtList(roster: ReadonlySet<string>): Map<string, Access> {
  return new Map([...roster].map((did): [string, Access] => [did, READ_WRITE]));
}

/** Computes the member-list writes needed to converge `current` to `desired` (excluding the space authority). */
export function diffMemberList(
  desired: ReadonlyMap<string, Access>,
  current: ReadonlyArray<{ did: string } & Access>,
  authorityDid: string,
): { toPut: Array<{ did: string } & Access>; toRemove: string[] } {
  const desiredNonOwner = new Map([...desired].filter(([did]) => did !== authorityDid));
  const toPut = [...desiredNonOwner].flatMap(([did, access]) => {
    const existing = current.find((member) => member.did === did);
    return existing?.read === access.read && existing.write === access.write ? [] : [{ did, ...access }];
  });
  const toRemove = current
    .filter((member) => member.did !== authorityDid && !desiredNonOwner.has(member.did))
    .map((member) => member.did);
  return { toPut, toRemove };
}

export async function putMissingMembers(
  session: OAuthSession,
  space: string,
  desired: ReadonlyMap<string, Access>,
  authorityDid: string,
): Promise<void> {
  const latest = await listSpaceMembers(session, space);
  const { toPut } = diffMemberList(desired, latest, authorityDid);
  await putListMembers(session, space, toPut);
}

export async function removeExtraMembers(
  session: OAuthSession,
  space: string,
  desired: ReadonlyMap<string, Access>,
  authorityDid: string,
): Promise<void> {
  const latest = await listSpaceMembers(session, space);
  const { toRemove } = diffMemberList(desired, latest, authorityDid);
  await removeListMembers(session, space, toRemove);
}

function parseInstall(actor: OperatorActor, rkey: string, value: Record<string, unknown> | null): AppInstall | null {
  if (!value || !validateSpaceRecord(COLLECTION.appInstall, value, {
    authorityDid: actor.workspace.authorityDid, spaceUri: actor.workspace.uri, repoDid: actor.workspace.authorityDid, rkey,
  }).valid) return null;
  const record = value as { subject: string; active: boolean; channels: Array<{ skey: string; write: boolean }>; installedBy: string; installedAt: string };
  return {
    subject: record.subject,
    active: record.active,
    channels: new Map(record.channels.map((grant) => [grant.skey, grant.write])),
    installedBy: record.installedBy,
    installedAt: record.installedAt,
  };
}

/** Every valid extension install record in the workspace, active or not, keyed by `extId`. */
export async function allExtInstalls(actor: OperatorActor): Promise<Map<ExtensionId, ExtInstall>> {
  const rows = await listOwnerRecords(actor.session, actor.workspace.uri, COLLECTION.extInstall);
  const installs = new Map(rows.flatMap((row) => {
    const install = parseExtInstall(actor, row.rkey, row.value);
    return install ? [[install.extId, install] as const] : [];
  }));
  const activeCount = [...installs.values()].filter((install) => install.active).length;
  if (activeCount > WORKSPACE_ENVELOPE.extensions) {
    throw new WorkspaceEnvelopeError(`The active extension count exceeds ${WORKSPACE_ENVELOPE.extensions}.`);
  }
  return installs;
}

/** Active extension installs, keyed by `extId`. */
export async function activeExtInstalls(actor: OperatorActor): Promise<Map<ExtensionId, ExtInstall>> {
  return new Map([...await allExtInstalls(actor)].filter(([, install]) => install.active));
}

/** Extension installs that are either active or still awaiting full member/notice cleanup, sorted by `extId`. */
export async function uncleanedExtInstalls(actor: OperatorActor): Promise<ExtInstall[]> {
  return [...(await allExtInstalls(actor)).values()]
    .filter((install) => install.active || !install.cleanupComplete)
    .sort((left, right) => left.extId.localeCompare(right.extId));
}

/** One extension's install record, or null when it has never been installed (or is invalid). */
export async function readExtInstall(actor: OperatorActor, extId: ExtensionId): Promise<ExtInstall | null> {
  return parseExtInstall(actor, extId, await getOwnerRecord(actor.session, actor.workspace.uri, COLLECTION.extInstall, extId));
}

export async function writeExtInstall(actor: OperatorActor, install: ExtInstall): Promise<void> {
  await putAuthorityRecord(actor.session, actor.workspace.uri, COLLECTION.extInstall, install.extId, {
    extId: install.extId,
    active: install.active,
    space: install.space,
    cleanupComplete: install.cleanupComplete,
    enabledBy: install.enabledBy,
    enabledAt: install.enabledAt,
    updatedAt: new Date().toISOString(),
    ...(install.disabledAt === undefined ? {} : { disabledAt: install.disabledAt }),
  });
}

function parseExtInstall(actor: OperatorActor, rkey: string, value: Record<string, unknown> | null): ExtInstall | null {
  if (!value || !validateSpaceRecord(COLLECTION.extInstall, value, {
    authorityDid: actor.workspace.authorityDid, spaceUri: actor.workspace.uri, repoDid: actor.workspace.authorityDid, rkey,
  }).valid) return null;
  const record = value as {
    extId: ExtensionId;
    active: boolean;
    space: string;
    cleanupComplete?: boolean;
    enabledBy: string;
    enabledAt: string;
    updatedAt: string;
    disabledAt?: string;
  };
  return {
    extId: record.extId,
    active: record.active,
    space: record.space,
    cleanupComplete: record.cleanupComplete === true,
    enabledBy: record.enabledBy,
    enabledAt: record.enabledAt,
    updatedAt: record.updatedAt,
    ...(typeof record.disabledAt === "string" ? { disabledAt: record.disabledAt } : {}),
  };
}
