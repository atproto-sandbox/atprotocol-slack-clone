import type { OAuthSession } from "@atproto/oauth-client-node";
import type * as GetRecord from "@flock/protocol/lexicons/api/types/com/atproto/space/getRecord";
import { listBoundedRecords } from "@flock/protocol/atproto/record-pages";
import { classifyRepoFailure } from "@flock/protocol/atproto/repo-failure";
import { isMissingXrpcResource, XrpcError, type AtprotoClient } from "@flock/protocol/atproto/xrpc";
import {
  channelRoleKey,
  groupMembersUri,
  isDid,
  parseChannelUri,
  parseSpaceRecordUri,
  workspaceUri,
} from "@flock/protocol/keys";
import { mapLimited } from "@flock/protocol/map-limited";
import { COLLECTION, ATGRP_COLLECTION } from "@flock/protocol/nsids";
import { validateSpaceRecord } from "@flock/protocol/registry";
import {
  effectiveHumanAdmins,
  type EffectiveGovernanceState,
  type GroupMembershipRecord,
  type GroupAtgrpPolicy,
  type GroupRoleRecord,
} from "@flock/protocol/scopes";
import { WORKSPACE_ENVELOPE, WorkspaceEnvelopeError } from "@flock/protocol/workspace-summary";
import { sessionClient } from "../atproto/client";
import { resolvePds } from "../atproto/identity";
import { mintSpaceCredential } from "../atproto/space-credential";
import {
  deleteAuthorityRecord,
  inspectOpenSocialSpacePolicy,
  listOwnGroupSpaceUris,
  putAuthorityRecord,
} from "../atproto/space-ops";
import type { OperatorActor } from "./actor";
import { dropMemberList } from "./member-access";

const MAX_AUTHORITY_RECORD_SCAN = WORKSPACE_ENVELOPE.authorityRecordScan;

export type LiveGroupGovernanceState = EffectiveGovernanceState & {
  roles: Map<string, GroupRoleRecord>;
  memberships: Map<string, GroupMembershipRecord>;
  spacePolicies: Map<string, GroupAtgrpPolicy>;
  knownAppSubjects: Set<string>;
  invalidSpacePolicyUris: string[];
};

export async function readGroupGovernanceState(
  session: OAuthSession,
  groupDid: string = session.did,
): Promise<LiveGroupGovernanceState> {
  const membersSpace = groupMembersUri(groupDid);
  const wsSpace = workspaceUri(groupDid);

  const [roleRows, membershipRows, installRows, ownSpaceUris] = await Promise.all([
    listOwnerRecords(session, membersSpace, ATGRP_COLLECTION.role),
    listOwnerRecords(session, membersSpace, ATGRP_COLLECTION.membership),
    listOwnerRecords(session, wsSpace, COLLECTION.appInstall).catch((err: unknown) => {
      if (isSpaceNotFound(err)) return [];
      throw err;
    }),
    listOwnGroupSpaceUris(session),
  ]);

  const roles = new Map<string, GroupRoleRecord>();
  for (const { rkey, value } of roleRows) {
    if (
      !validateSpaceRecord(ATGRP_COLLECTION.role, value, {
        authorityDid: groupDid,
        spaceUri: membersSpace,
        repoDid: groupDid,
        rkey,
      }).valid
    ) {
      continue;
    }
    roles.set(rkey, {
      ...(typeof value.displayName === "string" ? { displayName: value.displayName } : {}),
      ...(typeof value.description === "string" ? { description: value.description } : {}),
      default: value.default === true,
      permissions: Array.isArray(value.permissions) ? (value.permissions as string[]) : [],
      canAssign: Array.isArray(value.canAssign) ? (value.canAssign as string[]) : [],
    });
  }

  const memberships = new Map<string, GroupMembershipRecord>();
  for (const { rkey, value } of membershipRows) {
    if (!isDid(rkey) || rkey === groupDid) continue;
    if (
      !validateSpaceRecord(ATGRP_COLLECTION.membership, value, {
        authorityDid: groupDid,
        spaceUri: membersSpace,
        repoDid: groupDid,
        rkey,
      }).valid
    ) {
      continue;
    }
    const assignedRoles = Array.isArray(value.roles)
      ? (value.roles as unknown[]).filter((r): r is string => typeof r === "string")
      : [];
    if (assignedRoles.length === 0) continue;
    memberships.set(rkey, {
      ...(value as GroupMembershipRecord),
      roles: assignedRoles,
      createdAt: String(value.createdAt),
    });
  }

  const knownAppSubjects = new Set<string>();
  for (const { rkey, value } of installRows) {
    if (
      !validateSpaceRecord(COLLECTION.appInstall, value, {
        authorityDid: groupDid,
        spaceUri: wsSpace,
        repoDid: groupDid,
        rkey,
      }).valid
    ) {
      continue;
    }
    const subjectDid = String(value.subject);
    if (isDid(subjectDid) && subjectDid !== groupDid) {
      knownAppSubjects.add(subjectDid);
    }
  }

  const policies = await mapLimited(ownSpaceUris, 8, async (space) => ({
    space,
    inspection: await inspectOpenSocialSpacePolicy(session, space),
  }));
  const spacePolicies = new Map<string, GroupAtgrpPolicy>();
  const invalidSpacePolicyUris: string[] = [];
  for (const { space, inspection } of policies) {
    if (inspection.status === "valid") {
      spacePolicies.set(space, inspection.policy);
    } else {
      invalidSpacePolicyUris.push(space);
    }
  }

  return { roles, memberships, spacePolicies, knownAppSubjects, invalidSpacePolicyUris };
}

export function defaultRoleKeys(state: Pick<LiveGroupGovernanceState, "roles">): string[] {
  return [...state.roles.entries()]
    .filter(([, role]) => role.default === true)
    .map(([rkey]) => rkey)
    .sort();
}

export function humanMemberDids(
  state: Pick<LiveGroupGovernanceState, "memberships" | "knownAppSubjects">,
  groupDid: string,
): Set<string> {
  const members = new Set<string>();
  for (const did of state.memberships.keys()) {
    if (did !== groupDid && !state.knownAppSubjects.has(did)) {
      members.add(did);
    }
  }
  return members;
}

export function assignableRolesForMember(
  state: Pick<LiveGroupGovernanceState, "roles" | "memberships">,
  memberDid: string,
): Set<string> {
  const out = new Set<string>();
  const membership = state.memberships.get(memberDid);
  if (!membership) return out;
  for (const roleKey of membership.roles) {
    const role = state.roles.get(roleKey);
    for (const a of role?.canAssign ?? []) {
      out.add(a);
    }
  }
  return out;
}

export function canAssignRole(assignable: ReadonlySet<string>, roleKey: string): boolean {
  return assignable.has("*") || assignable.has(roleKey);
}

export function liveSpaceAccess(
  state: Pick<LiveGroupGovernanceState, "memberships" | "spacePolicies">,
  groupDid: string,
  space: string,
  did: string,
): { read: boolean; write: boolean } {
  if (did === groupDid) return { read: true, write: true };
  const policy = state.spacePolicies.get(space);
  if (!policy) return { read: false, write: false };
  const membership = state.memberships.get(did);
  const roles = new Set(membership?.roles ?? []);
  const read =
    policy.publicRead === true ||
    policy.grants.some((grant) => roles.has(grant.role) && grant.read === true);
  const write = policy.grants.some((grant) => roles.has(grant.role) && grant.write === true);
  return { read, write };
}

export async function putMembershipRoles(
  session: OAuthSession,
  groupDid: string,
  memberDid: string,
  roles: readonly string[],
  options?: { createdAt?: string; ifJoinRequestPresent?: boolean; existingRecord?: Record<string, unknown> | null },
): Promise<void> {
  const membersSpace = groupMembersUri(groupDid);
  const uniqueRoles = [...new Set(roles)];
  const existing =
    options?.existingRecord !== undefined
      ? options.existingRecord
      : await getOwnerRecord(session, membersSpace, ATGRP_COLLECTION.membership, memberDid);
  const createdAt =
    options?.createdAt ??
    (typeof existing?.createdAt === "string" ? existing.createdAt : new Date().toISOString());
  const preservedExtensions: Record<string, unknown> = {};
  if (existing) {
    for (const [k, v] of Object.entries(existing)) {
      if (k !== "$type" && k !== "roles" && k !== "createdAt") {
        preservedExtensions[k] = v;
      }
    }
  }
  await putAuthorityRecord(
    session,
    membersSpace,
    ATGRP_COLLECTION.membership,
    memberDid,
    {
      ...preservedExtensions,
      roles: uniqueRoles,
      createdAt,
    },
    options?.ifJoinRequestPresent ? { ifJoinRequestPresent: true } : undefined,
  );
  dropMemberList(membersSpace);
}

export async function deleteMembershipRecord(
  session: OAuthSession,
  groupDid: string,
  memberDid: string,
): Promise<void> {
  const membersSpace = groupMembersUri(groupDid);
  await deleteAuthorityRecord(session, membersSpace, ATGRP_COLLECTION.membership, memberDid);
  dropMemberList(membersSpace);
}

export async function activePrivateRoster(actor: OperatorActor, channelSpaceOrSkey: string): Promise<Set<string>> {
  const parsed = parseChannelUri(channelSpaceOrSkey);
  const channelSkey = parsed ? parsed.skey : channelSpaceOrSkey;
  const roleKey = channelRoleKey(channelSkey);
  const state = await readGroupGovernanceState(actor.session, actor.workspace.authorityDid);
  const members = new Set<string>();
  for (const [did, membership] of state.memberships.entries()) {
    if (did === actor.workspace.authorityDid || state.knownAppSubjects.has(did)) continue;
    if (membership.roles.includes(roleKey)) {
      members.add(did);
    }
  }
  if (members.size > WORKSPACE_ENVELOPE.members) {
    throw new WorkspaceEnvelopeError(`Private-channel roster exceeds ${WORKSPACE_ENVELOPE.members} active members.`);
  }
  return members;
}

export async function readJoinRequest(
  session: OAuthSession,
  inbox: string,
  repoDid: string,
  rkey: string,
  authorityDid: string,
): Promise<Record<string, unknown> | null> {
  const credential = await mintSpaceCredential(session, inbox);
  return readJoinRequestRecord(credential.client(await resolvePds(repoDid)), inbox, repoDid, rkey, authorityDid);
}

export async function readJoinRequestRecord(
  client: Pick<AtprotoClient, "query">,
  inbox: string,
  repoDid: string,
  rkey: string,
  authorityDid: string,
): Promise<Record<string, unknown> | null> {
  try {
    const result = await client.query<GetRecord.OutputSchema>("com.atproto.space.getRecord", {
      space: inbox,
      repo: repoDid,
      collection: COLLECTION.joinRequest,
      rkey,
    });
    return validateSpaceRecord(COLLECTION.joinRequest, result.value, {
      authorityDid,
      spaceUri: inbox,
      repoDid,
      rkey,
    }).valid
      ? result.value
      : null;
  } catch (error) {
    if (isNotFound(error) || classifyRepoFailure(error)?.permanent) return null;
    throw error;
  }
}

export async function directoryRecords(
  actor: OperatorActor,
): Promise<Array<{ rkey: string; value: Record<string, unknown> & { skey: string; name: string; visibility: string } }>> {
  const rows = await listOwnerRecords(actor.session, actor.workspace.uri, COLLECTION.directory);
  const channels = rows.filter(
    (row): row is typeof row & { value: Record<string, unknown> & { skey: string; name: string; visibility: string } } =>
      Boolean(
        row.value &&
          validateSpaceRecord(COLLECTION.directory, row.value, {
            authorityDid: actor.workspace.authorityDid,
            spaceUri: actor.workspace.uri,
            repoDid: actor.workspace.authorityDid,
            rkey: row.rkey,
          }).valid,
      ) &&
      typeof row.value?.skey === "string" &&
      typeof row.value.name === "string" &&
      typeof row.value.visibility === "string",
  );
  if (channels.filter(({ value }) => value.visibility !== "archived").length > WORKSPACE_ENVELOPE.channels) {
    throw new WorkspaceEnvelopeError(`The active channel count exceeds ${WORKSPACE_ENVELOPE.channels} channels.`);
  }
  return channels;
}

export async function activeRoster(actor: OperatorActor): Promise<Set<string>> {
  const state = await readGroupGovernanceState(actor.session, actor.workspace.authorityDid);
  const members = humanMemberDids(state, actor.workspace.authorityDid);
  if (members.size > WORKSPACE_ENVELOPE.members) {
    throw new WorkspaceEnvelopeError(`The active workspace roster exceeds ${WORKSPACE_ENVELOPE.members} members.`);
  }
  return members;
}

export async function activeAdmins(actor: OperatorActor): Promise<Set<string>> {
  const state = await readGroupGovernanceState(actor.session, actor.workspace.authorityDid);
  const admins = new Set(effectiveHumanAdmins(state, actor.workspace.authorityDid));
  if (admins.size === 0) throw new Error("Workspace has no active effective human admin.");
  if (admins.size > WORKSPACE_ENVELOPE.members) {
    throw new WorkspaceEnvelopeError(`The active admin count exceeds ${WORKSPACE_ENVELOPE.members} members.`);
  }
  return admins;
}

export async function hasActiveAdminRecord(actor: OperatorActor, subject: string): Promise<boolean> {
  const state = await readGroupGovernanceState(actor.session, actor.workspace.authorityDid);
  const membership = state.memberships.get(subject);
  return Boolean(membership?.roles.includes("admin"));
}

export async function listOwnerRecords(
  session: OAuthSession,
  space: string,
  collection: string,
  maxRecords = MAX_AUTHORITY_RECORD_SCAN,
): Promise<Array<{ rkey: string; value: Record<string, unknown> }>> {
  const result = await listBoundedRecords(sessionClient(session), { space, repo: session.did, collection, maxRecords });
  if (result.truncated) {
    throw new WorkspaceEnvelopeError(
      `The ${collection} record scan exceeds its ${maxRecords}-record limit; operator state may be incomplete.`,
    );
  }
  return result.records;
}

export async function getOwnerRecord(
  session: OAuthSession,
  space: string,
  collection: string,
  rkey: string,
): Promise<Record<string, unknown> | null> {
  try {
    const result = await sessionClient(session).query<GetRecord.OutputSchema>("com.atproto.space.getRecord", {
      space,
      repo: session.did,
      collection,
      rkey,
    });
    return validateSpaceRecord(collection, result.value, {
      authorityDid: session.did,
      spaceUri: space,
      repoDid: session.did,
      rkey,
    }).valid
      ? result.value
      : null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export function parseJoinRequestUri(uri: string, authorityDid: string, inbox: string): { repo: string; rkey: string } | null {
  const parsed = parseSpaceRecordUri(uri, inbox, COLLECTION.joinRequest);
  return !parsed || parsed.repo === authorityDid ? null : parsed;
}

export function isNotFound(error: unknown): boolean {
  return isMissingXrpcResource(error);
}

export function isSpaceNotFound(error: unknown): boolean {
  return error instanceof XrpcError && error.code === "SpaceNotFound";
}
