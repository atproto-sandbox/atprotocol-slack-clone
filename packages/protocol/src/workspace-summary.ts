import type { ExtensionId } from "./extensions";
import {
  channelUri,
  groupMembersUri,
  groupMetaUri,
  isDid,
  isTid,
  parseWorkspaceUri,
  SELF_SKEY,
} from "./keys";
import { isTakendown, type ActiveSpaceLabel } from "./moderation";
import { ATPROTO_SPACE_COLLECTION, COLLECTION, OPENSOCIAL_COLLECTION, OPENSOCIAL_POLICY } from "./nsids";
import {
  decodeFlockAcceptanceExtensions,
  decodeFlockMembershipExtensions,
  validateSpacePolicy,
  validateSpaceRecord,
} from "./registry";
import {
  effectiveHumanAdmins,
  isEffectiveModeratorMember,
  type EffectiveGovernanceState,
  type GroupMembershipRecord,
  type GroupOpenSocialPolicy,
  type GroupRoleRecord,
} from "./scopes";

// What a workspace is, read from its OpenSocial group spaces (`meta/self`, `members/self`) and Flock `workspace/self`
// space, and whether it is inside the supported envelope. Both `@flock/client`, `@flock/reader`, and `apps/operator`
// summarize through this single pure function.

export const WORKSPACE_ENVELOPE = {
  members: 200,
  apps: 20,
  extensions: 20,
  memberList: 220,
  channels: 100,
  maxRolesPerMember: 100,
  maxPolicyGrantsPerSpace: 100,
  maxPrivateChannelsPerMember: 90,
  taskProjects: 100,
  tasks: 2_000,
  maxAncestorRefs: 256,
  maxOpsPerEntity: 1_000,
  maxCommentsPerTask: 200,
  maxStarArchiveBytes: 16 * 1024 * 1024,
  maxStarRecords: 20_000,
  maxRepoOpsPages: 128,
  maxListRecordsRetry: 3,
  authorityRecordScan: 1_000,
} as const;

export type WorkspaceExtensionSummary = {
  extId: ExtensionId;
  active: boolean;
  space: string;
  cleanupComplete: boolean;
  enabledBy: string;
  enabledAt: string;
  updatedAt: string;
  disabledAt?: string;
};

export type WorkspaceRoleSummary = {
  rkey: string;
  displayName: string;
  description?: string;
  default: boolean;
  scopes: string[];
  assignable: string[];
};

export type WorkspaceSummary = {
  uri: string;
  authorityDid: string;
  groupDid: string;
  skey: string;
  name: string;
  description?: string;
  joinPolicy: string;
  publicMeta: boolean;
  url?: string;
  isAdmin: boolean;
  isModerator: boolean;
  admins: string[];
  moderators: string[];
  /** Confirmed bidirectional human members (`membership/<did>` paired with valid post-admission `<did>`-authored `acceptance/self`, withholding `!takedown`-labeled accounts). */
  members: Array<{ did: string; active: boolean; roles: string[] }>;
  /** Admitted human members whose personal-PDS `acceptance/self` is absent or stale (still hold full `membership` access, withholding `!takedown`-labeled accounts). */
  pendingMembers: Array<{ did: string; roles: string[] }>;
  /** Admitted human member DIDs currently carrying an active `!takedown` account label in `members/self`. */
  takendownMembers?: string[];
  roles: WorkspaceRoleSummary[];
  channels: Array<{ uri: string; skey: string; name: string; visibility: string }>;
  /** Active installed apps (`active === true`). */
  installs: Array<{ did: string; channels: Array<{ skey: string; write: boolean }> }>;
  /** Valid extension install records (both enabled and disabled) written by `<groupDid>`. */
  extensions?: WorkspaceExtensionSummary[];
  degradedReasons: string[];
};

/** One collection of `<groupDid>`'s records, as a bounded scan returned it. */
export type ScannedRecords = {
  records: Array<{ rkey: string; cid?: string; value: Record<string, unknown> }>;
  truncated: boolean;
};

/** Member-authored `group.opensocial.acceptance/self` records synced across `members/self` writers. */
export type MemberAcceptanceEntry = {
  repoDid: string;
  rkey?: string;
  value: Record<string, unknown>;
};

export type MemberWriterRev = {
  repoRev: string;
  spaceRev: string;
};

export type WorkspaceRecords = {
  profiles: ScannedRecords;
  roles: ScannedRecords;
  memberships: ScannedRecords;
  directory: ScannedRecords;
  installs: ScannedRecords;
  extInstalls?: ScannedRecords;
  acceptances?: ReadonlyArray<MemberAcceptanceEntry>;
  memberWriters?: ReadonlyMap<string, MemberWriterRev>;
  spacePolicies?: ReadonlyMap<string, GroupOpenSocialPolicy>;
  accountLabels?: ReadonlyArray<ActiveSpaceLabel>;
};

export class WorkspaceEnvelopeError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "WorkspaceEnvelopeError";
  }
}

export function workspaceDegradedMessage(reasons: readonly string[]): string {
  return `Workspace is in degraded mode because it exceeds the supported v1 envelope. ${reasons.join(" ")} Admin changes and inbox reconciliation are paused until the workspace is within the supported limits.`;
}

export function assertWorkspaceWithinEnvelope(summary: Pick<WorkspaceSummary, "degradedReasons">): void {
  if (summary.degradedReasons.length > 0) {
    throw new WorkspaceEnvelopeError(workspaceDegradedMessage(summary.degradedReasons));
  }
}

/**
 * Validates that a bounded scan of `com.atproto.space.policy` on an OpenSocial group space contains
 * exactly one `self` record whose outer wrapper and inner `group.opensocial.policy` both pass schema
 * and semantic validation.
 */
export function extractGroupSpacePolicyRecord(
  groupDid: string,
  spaceUri: string,
  scanned: ScannedRecords,
): { policy: GroupOpenSocialPolicy | null; valid: boolean } {
  if (scanned.truncated || scanned.records.length !== 1) {
    return { policy: null, valid: false };
  }
  const entry = scanned.records[0]!;
  if (
    entry.rkey !== SELF_SKEY ||
    !entry.value ||
    typeof entry.value !== "object" ||
    Array.isArray(entry.value) ||
    entry.value.$type !== ATPROTO_SPACE_COLLECTION.spacePolicy
  ) {
    return { policy: null, valid: false };
  }
  const check = validateSpaceRecord(ATPROTO_SPACE_COLLECTION.spacePolicy, entry.value, {
    authorityDid: groupDid,
    spaceUri,
    repoDid: groupDid,
    rkey: SELF_SKEY,
  });
  if (!check.valid) {
    return { policy: null, valid: false };
  }
  const rawPolicy = entry.value.policy;
  if (
    !rawPolicy ||
    typeof rawPolicy !== "object" ||
    Array.isArray(rawPolicy) ||
    (rawPolicy as Record<string, unknown>).$type !== OPENSOCIAL_POLICY
  ) {
    return { policy: null, valid: false };
  }
  return { policy: rawPolicy as GroupOpenSocialPolicy, valid: true };
}

function isBidirectionalRosterAccepted(
  memberDid: string,
  membershipRecord: Record<string, unknown>,
  membershipCid: string | undefined,
  acceptanceRecord: Record<string, unknown> | undefined,
  writer: MemberWriterRev | undefined,
): boolean {
  void memberDid;
  if (!acceptanceRecord) return false;
  const memExt = decodeFlockMembershipExtensions(membershipRecord);
  if (!memExt.valid) return false;
  const accExt = decodeFlockAcceptanceExtensions(acceptanceRecord);
  if (!accExt.valid) return false;

  const explicitMembershipInc = memExt.incarnation;
  const effectiveMembershipInc =
    explicitMembershipInc ??
    (typeof membershipCid === "string" && membershipCid.length > 0 ? `legacy-cid:${membershipCid}` : undefined);
  const accInc = accExt.incarnation;
  const gen = memExt.generation ?? 1;
  const admittedSpaceRev = memExt.admittedSpaceRev;
  const afterWriterRev = memExt.afterWriterRev;

  // (a) Both carry incarnation stamps: exact match required against explicit membership incarnation.
  if (accInc !== undefined && explicitMembershipInc !== undefined) {
    return accInc === explicitMembershipInc;
  }
  // (a2) Imported/standard unversioned membership JSON paired with stamped acceptance:
  //      match strictly against deterministic `legacy-cid:<membershipCid>` fallback (rejecting stale/mismatched stamps).
  if (accInc !== undefined && explicitMembershipInc === undefined) {
    return effectiveMembershipInc !== undefined && accInc === effectiveMembershipInc;
  }

  // Unversioned acceptance (`accInc === undefined`):
  // (b) Re-admitted after prior ejection (`gen >= 2`): never trust self-reported `acceptance.createdAt`!
  // Requires durable post-ejection writer-advance evidence; if `afterWriterRev == null`, requires incarnation match (false here).
  if (gen >= 2) {
    if (afterWriterRev == null) return false;
    if (!writer || !isTid(writer.repoRev) || !isTid(writer.spaceRev)) return false;
    return (
      writer.repoRev > afterWriterRev &&
      (admittedSpaceRev === undefined || writer.spaceRev > admittedSpaceRev)
    );
  }

  // (c) First-generation admission (`gen === 1`) with unversioned third-party acceptance:
  if (!writer || !isTid(writer.repoRev) || !isTid(writer.spaceRev)) return false;
  return admittedSpaceRev === undefined || writer.spaceRev > admittedSpaceRev;
}

/**
 * Summarizes a Flock workspace hosted inside an OpenSocial atmospheric group (`groupDid`), as seen by `viewerDid`,
 * or `null` when `uri` is invalid or `group.opensocial.profile/self` is missing/invalid.
 */
export function summarizeWorkspace(uri: string, viewerDid: string, records: WorkspaceRecords): WorkspaceSummary | null {
  const workspace = parseWorkspaceUri(uri);
  if (!workspace) return null;
  const groupDid = workspace.authorityDid;
  const skey = workspace.skey;
  const metaSpaceUri = groupMetaUri(groupDid);
  const membersSpaceUri = groupMembersUri(groupDid);

  const validInSpace = (targetSpaceUri: string, collection: string, scanned: ScannedRecords) =>
    scanned.records.filter(
      (record) =>
        validateSpaceRecord(collection, record.value, {
          authorityDid: groupDid,
          spaceUri: targetSpaceUri,
          repoDid: groupDid,
          rkey: record.rkey,
        }).valid,
    );

  const validProfile = validInSpace(metaSpaceUri, OPENSOCIAL_COLLECTION.profile, records.profiles)[0]?.value;
  if (!validProfile || typeof validProfile.displayName !== "string") return null;

  const name = validProfile.displayName;
  const description = typeof validProfile.description === "string" ? validProfile.description : undefined;
  const joinPolicy = typeof validProfile.joinPolicy === "string" ? validProfile.joinPolicy : "invite";
  const url = typeof validProfile.url === "string" ? validProfile.url : undefined;

  // Roles in `members/self`
  const validRoleEntries = validInSpace(membersSpaceUri, OPENSOCIAL_COLLECTION.role, records.roles);
  const rolesMap = new Map<string, GroupRoleRecord>();
  const rolesSummary: WorkspaceRoleSummary[] = [];
  for (const { rkey, value } of validRoleEntries) {
    const scopes = Array.isArray(value.scopes) ? (value.scopes as string[]) : [];
    const assignable = Array.isArray(value.assignable) ? (value.assignable as string[]) : [];
    const roleObj: GroupRoleRecord = {
      displayName: String(value.displayName),
      ...(typeof value.description === "string" ? { description: value.description } : {}),
      default: value.default === true,
      scopes,
      assignable,
    };
    rolesMap.set(rkey, roleObj);
    rolesSummary.push({
      rkey,
      displayName: roleObj.displayName,
      ...(roleObj.description !== undefined ? { description: roleObj.description } : {}),
      default: Boolean(roleObj.default),
      scopes: [...scopes],
      assignable: [...assignable],
    });
  }
  rolesSummary.sort((a, b) => a.rkey.localeCompare(b.rkey));

  // Channels & App installs in `workspace/self`
  const validDirectoryEntries = validInSpace(uri, COLLECTION.directory, records.directory);
  const channels = validDirectoryEntries.flatMap(({ value }) =>
    value.visibility === "archived"
      ? []
      : [
          {
            uri: channelUri(groupDid, String(value.skey)),
            skey: String(value.skey),
            name: String(value.name),
            visibility: String(value.visibility),
          },
        ],
  );
  const openChannelKeys = new Set(channels.map((ch) => ch.skey));

  // Durable non-prunable `knownAppSubjects`: includes BOTH active and uninstalled (`active: false`) tombstones!
  const validAppInstalls = validInSpace(uri, COLLECTION.appInstall, records.installs);
  const knownAppSubjects = new Set<string>();
  const installs: Array<{ did: string; channels: Array<{ skey: string; write: boolean }> }> = [];
  for (const { value } of validAppInstalls) {
    const subjectDid = String(value.subject);
    if (subjectDid === groupDid) continue;
    knownAppSubjects.add(subjectDid);
    if (value.active === true) {
      installs.push({
        did: subjectDid,
        channels: (value.channels as Array<{ skey: string; write: boolean }>)
          .filter(({ skey: chKey }) => openChannelKeys.has(chKey))
          .map(({ skey: chKey, write }) => ({ skey: chKey, write })),
      });
    }
  }

  // Validate spacePolicies if supplied; ensure default `members/self` read+write grant fallback only if policies were not supplied
  const validatedSpacePolicies = new Map<string, GroupOpenSocialPolicy>();
  let maxPolicyGrants = 0;
  let invalidPolicyCount = 0;
  let missingCorePolicy = false;
  if (records.spacePolicies) {
    for (const [policySpaceUri, policy] of records.spacePolicies.entries()) {
      const parsed = policySpaceUri.startsWith(`at://${groupDid}/space/`)
        ? policySpaceUri.slice(`at://${groupDid}/space/`.length).split("/")
        : null;
      if (!parsed || parsed.length !== 2) {
        invalidPolicyCount += 1;
        continue;
      }
      const check = validateSpacePolicy(
        { $type: OPENSOCIAL_POLICY, ...policy },
        { groupDid, spaceType: parsed[0]!, skey: parsed[1]! },
      );
      if (!check.valid) {
        invalidPolicyCount += 1;
        continue;
      }
      if (policy.grants.length > maxPolicyGrants) {
        maxPolicyGrants = policy.grants.length;
      }
      validatedSpacePolicies.set(policySpaceUri, policy);
    }
    if (!validatedSpacePolicies.has(metaSpaceUri) || !validatedSpacePolicies.has(membersSpaceUri)) {
      missingCorePolicy = true;
    }
  } else {
    // Default synthetic `members/self` + `meta/self` policy when caller omits `spacePolicies` in pure unit tests
    validatedSpacePolicies.set(membersSpaceUri, {
      publicRead: false,
      unlisted: false,
      grants: [...rolesMap.keys()].map((role) => ({ role, read: true, write: true })),
    });
    validatedSpacePolicies.set(metaSpaceUri, {
      publicRead: true,
      unlisted: false,
      grants: [...rolesMap.keys()].map((role) => ({ role, read: true })),
    });
  }

  // Memberships in `members/self` (strictly excluding `groupDid` and `knownAppSubjects` from human sets)
  const validMembershipEntries = validInSpace(
    membersSpaceUri,
    OPENSOCIAL_COLLECTION.membership,
    records.memberships,
  );
  const membershipsMap = new Map<string, GroupMembershipRecord>();
  const membershipCidsMap = new Map<string, string>();
  let maxMemberRoles = 0;
  let maxPrivateChannels = 0;
  for (const { rkey: memberDid, cid, value } of validMembershipEntries) {
    if (!isDid(memberDid) || memberDid === groupDid) continue;
    const assignedRoles = (value.roles as string[]).filter((r) => typeof r === "string");
    if (assignedRoles.length > maxMemberRoles) maxMemberRoles = assignedRoles.length;
    if (!knownAppSubjects.has(memberDid)) {
      const privCount = assignedRoles.filter((r) => r.startsWith("channel-")).length;
      if (privCount > maxPrivateChannels) maxPrivateChannels = privCount;
    }
    if (typeof cid === "string" && cid.length > 0) {
      membershipCidsMap.set(memberDid, cid);
    }
    membershipsMap.set(memberDid, {
      ...(value as GroupMembershipRecord),
      roles: assignedRoles,
      createdAt: String(value.createdAt),
    });
  }

  // Valid member-authored `acceptance/self` records
  const validAcceptances = new Map<string, Record<string, unknown>>();
  for (const entry of records.acceptances ?? []) {
    const rkey = entry.rkey ?? SELF_SKEY;
    if (!isDid(entry.repoDid) || entry.repoDid === groupDid || knownAppSubjects.has(entry.repoDid)) {
      continue;
    }
    const check = validateSpaceRecord(OPENSOCIAL_COLLECTION.acceptance, entry.value, {
      authorityDid: groupDid,
      spaceUri: membersSpaceUri,
      repoDid: entry.repoDid,
      rkey,
    });
    if (check.valid) {
      validAcceptances.set(entry.repoDid, entry.value);
    }
  }

  const governanceState: EffectiveGovernanceState = {
    roles: rolesMap,
    memberships: membershipsMap,
    spacePolicies: validatedSpacePolicies,
    knownAppSubjects,
  };

  // Authorization derives strictly from `membership` + `effectiveMemberPermissions`, NEVER gated on `acceptance/self`!
  const admins = effectiveHumanAdmins(governanceState, groupDid);
  const moderators: string[] = [];
  const confirmedMembers: Array<{ did: string; active: boolean; roles: string[] }> = [];
  const pendingMembers: Array<{ did: string; roles: string[] }> = [];

  for (const [memberDid, membership] of membershipsMap.entries()) {
    if (memberDid === groupDid || knownAppSubjects.has(memberDid)) continue;
    if (isEffectiveModeratorMember(memberDid, governanceState, groupDid)) {
      moderators.push(memberDid);
    }
    const acceptance = validAcceptances.get(memberDid);
    const membershipCid = membershipCidsMap.get(memberDid);
    const writer = records.memberWriters?.get(memberDid);
    const roles = [...membership.roles];
    if (isBidirectionalRosterAccepted(memberDid, membership, membershipCid, acceptance, writer)) {
      confirmedMembers.push({ did: memberDid, active: true, roles });
    } else {
      pendingMembers.push({ did: memberDid, roles });
    }
  }
  moderators.sort();
  confirmedMembers.sort((a, b) => a.did.localeCompare(b.did));
  pendingMembers.sort((a, b) => a.did.localeCompare(b.did));

  const extInstallRecords = records.extInstalls ?? { records: [], truncated: false };
  const validExtInstallEntries = validInSpace(uri, COLLECTION.extInstall, extInstallRecords);
  const extensions: WorkspaceExtensionSummary[] = validExtInstallEntries
    .map(({ value }) => ({
      extId: value.extId as ExtensionId,
      active: value.active === true,
      space: String(value.space),
      cleanupComplete: value.cleanupComplete === true,
      enabledBy: String(value.enabledBy),
      enabledAt: String(value.enabledAt),
      updatedAt: String(value.updatedAt),
      ...(typeof value.disabledAt === "string" ? { disabledAt: value.disabledAt } : {}),
    }))
    .sort((left, right) => left.extId.localeCompare(right.extId));
  const activeExtensions = extensions.filter((extension) => extension.active).length;

  const invalidRoleCount = records.roles.records.length - validRoleEntries.length;
  const invalidMembershipCount = records.memberships.records.length - validMembershipEntries.length;
  const invalidDirectoryCount = records.directory.records.length - validDirectoryEntries.length;
  const invalidInstallCount = records.installs.records.length - validAppInstalls.length;
  const invalidExtInstallCount = extInstallRecords.records.length - validExtInstallEntries.length;

  const totalHumanMemberships = confirmedMembers.length + pendingMembers.length;
  const publicMeta = validatedSpacePolicies.get(metaSpaceUri)?.publicRead === true;
  const takendownMembers: string[] = [];
  if (records.accountLabels && records.accountLabels.length > 0) {
    for (const member of [...confirmedMembers, ...pendingMembers]) {
      if (isTakendown(records.accountLabels, member.did)) {
        takendownMembers.push(member.did);
      }
    }
    takendownMembers.sort();
  }
  const takendownSet = new Set(takendownMembers);
  const visibleMembers =
    takendownSet.size > 0 ? confirmedMembers.filter((member) => !takendownSet.has(member.did)) : confirmedMembers;
  const visiblePendingMembers =
    takendownSet.size > 0 ? pendingMembers.filter((member) => !takendownSet.has(member.did)) : pendingMembers;

  const scan = WORKSPACE_ENVELOPE.authorityRecordScan;
  const degradedReasons = [
    records.profiles.truncated && "Group profile records exceed the expected single-record limit.",
    records.roles.truncated && `Role records exceed the ${scan}-record scan limit; role governance may be incomplete.`,
    records.memberships.truncated && `Membership records exceed the ${scan}-record scan limit; the member list may be incomplete.`,
    records.directory.truncated && `The channel directory exceeds the ${scan}-record scan limit; the channel list may be incomplete.`,
    records.installs.truncated && `App install records exceed the ${scan}-record scan limit; the app list may be incomplete.`,
    extInstallRecords.truncated && `Extension install records exceed the ${scan}-record scan limit; the extension list may be incomplete.`,
    invalidRoleCount > 0 && "Role records contain malformed entries; role governance may be incomplete.",
    invalidMembershipCount > 0 && "Membership records contain malformed entries; the member list may be incomplete.",
    invalidDirectoryCount > 0 && "Channel directory records contain malformed entries; the channel list may be incomplete.",
    invalidInstallCount > 0 && "App install records contain malformed entries; the app list may be incomplete.",
    invalidExtInstallCount > 0 && "Extension install records contain malformed entries; the extension list may be incomplete.",
    (invalidPolicyCount > 0 || missingCorePolicy) &&
      "Space policy records contain malformed or missing entries; workspace access governance may be incomplete.",
    totalHumanMemberships > WORKSPACE_ENVELOPE.members && `The group membership count exceeds ${WORKSPACE_ENVELOPE.members} members.`,
    channels.length > WORKSPACE_ENVELOPE.channels && `The active channel count exceeds ${WORKSPACE_ENVELOPE.channels} channels.`,
    admins.length > WORKSPACE_ENVELOPE.members && `The active admin count exceeds ${WORKSPACE_ENVELOPE.members} members.`,
    installs.length > WORKSPACE_ENVELOPE.apps && `The active app count exceeds ${WORKSPACE_ENVELOPE.apps}.`,
    activeExtensions > WORKSPACE_ENVELOPE.extensions && `The active extension count exceeds ${WORKSPACE_ENVELOPE.extensions}.`,
    maxMemberRoles > WORKSPACE_ENVELOPE.maxRolesPerMember && `A member exceeds ${WORKSPACE_ENVELOPE.maxRolesPerMember} assigned roles.`,
    maxPrivateChannels > WORKSPACE_ENVELOPE.maxPrivateChannelsPerMember && `A member exceeds ${WORKSPACE_ENVELOPE.maxPrivateChannelsPerMember} private channel roles.`,
    maxPolicyGrants > WORKSPACE_ENVELOPE.maxPolicyGrantsPerSpace && `A space policy exceeds ${WORKSPACE_ENVELOPE.maxPolicyGrantsPerSpace} role grants.`,
  ].filter((reason): reason is string => typeof reason === "string");

  return {
    uri,
    authorityDid: groupDid,
    groupDid,
    skey,
    name,
    ...(description !== undefined ? { description } : {}),
    joinPolicy,
    publicMeta,
    ...(url !== undefined ? { url } : {}),
    isAdmin: admins.includes(viewerDid),
    isModerator: moderators.includes(viewerDid),
    admins,
    moderators,
    members: visibleMembers,
    pendingMembers: visiblePendingMembers,
    ...(takendownMembers.length > 0 ? { takendownMembers } : {}),
    roles: rolesSummary,
    channels: channels.sort((left, right) => left.name.localeCompare(right.name)),
    installs: installs.sort((left, right) => left.did.localeCompare(right.did)),
    extensions,
    degradedReasons,
  };
}
