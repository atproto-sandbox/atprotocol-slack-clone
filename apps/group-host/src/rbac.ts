import {
  AccountPermission,
  BlobPermission,
  IdentityPermission,
  RepoPermission,
  RpcPermission,
  ScopePermissions,
  SpacePermission,
} from "@atproto/oauth-scopes";
import type { DidString } from "@atproto/syntax";
import { appRoleKey, groupMembersUri, parseSpaceUri, spaceUri as makeSpaceUri, workspaceUri } from "@flock/protocol/keys";
import { COLLECTION, OPENSOCIAL_COLLECTION } from "@flock/protocol/nsids";
import { validateSpacePolicy } from "@flock/protocol/registry";
import {
  effectiveHumanAdmins,
  effectiveMemberPermissions,
  expandGroupScopes,
  expandPolicyGrantScopes,
  isEffectiveAdminMember,
  SPACE_DECLARED_COLLECTIONS,
  type EffectiveGovernanceState,
  type GroupMembershipRecord,
  type GroupOpenSocialPolicy,
  type GroupRoleRecord,
} from "@flock/protocol/scopes";
import type { GroupHostDb } from "./db";
import { GroupHostHttpError } from "./plc";

export class GroupRepoLockManager {
  private readonly queues = new Map<string, Promise<void>>();

  async withGroupRepoLock<T>(did: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = this.queues.get(did) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = prev.then(() => gate);
    this.queues.set(did, chained);

    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.queues.get(did) === chained) {
        this.queues.delete(did);
      }
    }
  }

  async withSortedGroupRepoLocks<T>(dids: readonly string[], fn: () => Promise<T> | T): Promise<T> {
    const uniqueSorted = [...new Set(dids)].sort();
    const runAt = async (idx: number): Promise<T> => {
      if (idx >= uniqueSorted.length) {
        return await fn();
      }
      return this.withGroupRepoLock(uniqueSorted[idx]!, () => runAt(idx + 1));
    };
    return runAt(0);
  }
}

export type AppInstallSnapshot = {
  subject: string;
  active: boolean;
  channels: Array<{ skey: string; write: boolean }>;
};

export type LiveGroupGovernanceState = EffectiveGovernanceState & {
  knownAppSubjects: Set<string>;
  allAppInstalls: Map<string, AppInstallSnapshot>;
  activeAppInstalls: Map<string, AppInstallSnapshot>;
  hasFlockWorkspace: boolean;
};

export type RecoveryAdminRow = {
  group_did: string;
  recovery_did: string;
  roles_json: string;
  deactivated_at: number;
};

export type ReapedPreparedLease = {
  group_did: string;
  operation_id: string;
  mode: "coordinated" | "standard";
  ticket_id: string | null;
  target_service_did: string;
  target_endpoint: string;
  deadline_at: number;
  expires_at: number;
  reaped_at: number;
};

const preparedLeaseReapHooks = new WeakMap<GroupHostDb, (reaped: ReapedPreparedLease) => void>();

export function registerPreparedLeaseReapHook(
  db: GroupHostDb,
  hook: (reaped: ReapedPreparedLease) => void,
): void {
  preparedLeaseReapHooks.set(db, hook);
}

export function reapExpiredPreparedMigrationLease(
  db: GroupHostDb,
  groupDid: string,
  nowMs = Date.now(),
): ReapedPreparedLease | null {
  const reaped = db.transaction(() => {
    const row = db
      .prepare(
        `SELECT group_did, operation_id, mode, ticket_id, target_service_did, target_endpoint, deadline_at, expires_at
         FROM source_migration_lease
         WHERE group_did = ? AND status = 'prepared' AND expires_at IS NOT NULL AND expires_at <= ?`,
      )
      .get(groupDid, nowMs) as ReapedPreparedLease | undefined;
    if (!row) return null;
    const info = db
      .prepare(
        "DELETE FROM source_migration_lease WHERE group_did = ? AND status = 'prepared' AND expires_at IS NOT NULL AND expires_at <= ?",
      )
      .run(groupDid, nowMs);
    if (info.changes <= 0) return null;
    if (row.operation_id) {
      const existing = db
        .prepare("SELECT expires_at FROM service_jwt_jti WHERE issuer_did = ? AND jti = ?")
        .get(groupDid, `aborted-op:${row.operation_id}`) as { expires_at: number } | undefined;
      db.prepare("INSERT OR REPLACE INTO service_jwt_jti (issuer_did, jti, group_did, expires_at) VALUES (?, ?, ?, ?)").run(
        groupDid,
        `aborted-op:${row.operation_id}`,
        groupDid,
        Math.max(existing?.expires_at ?? 0, row.deadline_at, nowMs + 2 * 3_600_000),
      );
    }
    return { ...row, reaped_at: nowMs };
  })();
  if (reaped) {
    preparedLeaseReapHooks.get(db)?.(reaped);
  }
  return reaped;
}

export function hasActiveSourceMigrationLease(
  db: GroupHostDb,
  groupDid: string,
  nowMs = Date.now(),
): boolean {
  reapExpiredPreparedMigrationLease(db, groupDid, nowMs);
  const row = db
    .prepare("SELECT 1 AS ok FROM source_migration_lease WHERE group_did = ?")
    .get(groupDid) as { ok: number } | undefined;
  return Boolean(row);
}

export function loadLiveGovernanceState(db: GroupHostDb, groupDid: string): LiveGroupGovernanceState {
  const membersSpace = groupMembersUri(groupDid);
  const flockWsSpace = workspaceUri(groupDid);

  const spaceRows = db
    .prepare(
      "SELECT space_uri, space_type, skey, policy_json FROM group_space WHERE group_did = ? AND deleted_at IS NULL",
    )
    .all(groupDid) as Array<{ space_uri: string; space_type: string; skey: string; policy_json: string }>;

  const spacePolicies = new Map<string, GroupOpenSocialPolicy>();
  let hasFlockWorkspace = false;
  for (const row of spaceRows) {
    if (row.space_uri === flockWsSpace) {
      hasFlockWorkspace = true;
    }
    try {
      const parsed = JSON.parse(row.policy_json) as GroupOpenSocialPolicy;
      spacePolicies.set(row.space_uri, parsed);
    } catch {
      // Ignore corrupt policy JSON (prevented at write/import time)
    }
  }

  const roleRows = db
    .prepare(
      "SELECT rkey, value FROM space_record WHERE space_uri = ? AND repo_did = ? AND collection = ?",
    )
    .all(membersSpace, groupDid, OPENSOCIAL_COLLECTION.role) as Array<{ rkey: string; value: string }>;
  const roles = new Map<string, GroupRoleRecord>();
  for (const row of roleRows) {
    const val = JSON.parse(row.value) as GroupRoleRecord;
    roles.set(row.rkey, val);
  }

  const memRows = db
    .prepare(
      "SELECT rkey, value FROM space_record WHERE space_uri = ? AND repo_did = ? AND collection = ?",
    )
    .all(membersSpace, groupDid, OPENSOCIAL_COLLECTION.membership) as Array<{ rkey: string; value: string }>;
  const memberships = new Map<string, GroupMembershipRecord>();
  for (const row of memRows) {
    const val = JSON.parse(row.value) as GroupMembershipRecord;
    memberships.set(row.rkey, val);
  }

  const knownAppRows = db
    .prepare("SELECT subject_did FROM known_app_subject WHERE group_did = ?")
    .all(groupDid) as Array<{ subject_did: string }>;
  const knownAppSubjects = new Set<string>(knownAppRows.map((r) => r.subject_did));

  const allAppInstalls = new Map<string, AppInstallSnapshot>();
  const activeAppInstalls = new Map<string, AppInstallSnapshot>();
  if (hasFlockWorkspace) {
    const installRows = db
      .prepare(
        "SELECT value FROM space_record WHERE space_uri = ? AND repo_did = ? AND collection = ?",
      )
      .all(flockWsSpace, groupDid, COLLECTION.appInstall) as Array<{ value: string }>;
    for (const row of installRows) {
      const val = JSON.parse(row.value) as {
        subject: string;
        active: boolean;
        channels: Array<{ skey: string; write: boolean }>;
      };
      const snap: AppInstallSnapshot = {
        subject: val.subject,
        active: val.active === true,
        channels: Array.isArray(val.channels) ? val.channels : [],
      };
      knownAppSubjects.add(snap.subject);
      allAppInstalls.set(snap.subject, snap);
      if (snap.active) {
        activeAppInstalls.set(snap.subject, snap);
      }
    }
  }

  return {
    roles,
    memberships,
    spacePolicies,
    knownAppSubjects,
    allAppInstalls,
    activeAppInstalls,
    hasFlockWorkspace,
  };
}

export function effectiveStateForSession(
  liveState: LiveGroupGovernanceState,
  session: { sessionKind: "group" | "recovery"; authorizingUserDid: string } | null | undefined,
  recoveryRow: RecoveryAdminRow | null | undefined,
): LiveGroupGovernanceState {
  if (
    session?.sessionKind === "recovery" &&
    recoveryRow &&
    recoveryRow.recovery_did === session.authorizingUserDid &&
    liveState.memberships.size === 0
  ) {
    const clonedMemberships = new Map(liveState.memberships);
    const roles = JSON.parse(recoveryRow.roles_json) as string[];
    clonedMemberships.set(recoveryRow.recovery_did, {
      roles,
      createdAt: new Date(recoveryRow.deactivated_at).toISOString(),
    });
    return {
      ...liveState,
      memberships: clonedMemberships,
    };
  }
  return liveState;
}

export function humanMemberships(
  state: LiveGroupGovernanceState,
  groupDid: string,
): Map<string, GroupMembershipRecord> {
  const humans = new Map<string, GroupMembershipRecord>();
  for (const [did, membership] of state.memberships.entries()) {
    if (did === groupDid || state.knownAppSubjects.has(did)) continue;
    humans.set(did, membership);
  }
  return humans;
}

export function isAuthorizedLifecycleAdmin(
  actorDid: string,
  state: LiveGroupGovernanceState,
  groupDid: string,
): boolean {
  if (actorDid === groupDid) {
    return true;
  }
  const admins = effectiveHumanAdmins(state, groupDid);
  if (admins.length >= 1) {
    return admins.includes(actorDid);
  }
  // Imported third-party OpenSocial groups with arbitrary role splits where effectiveHumanAdmins === 0
  return !state.knownAppSubjects.has(actorDid) && state.memberships.has(actorDid);
}

export function liveRoleGrantsRead(
  state: LiveGroupGovernanceState,
  spaceUri: string,
  actorDid: string,
  groupDid: string,
): boolean {
  if (actorDid === groupDid) return true;
  const policy = state.spacePolicies.get(spaceUri);
  if (!policy) return false;
  if (policy.publicRead === true) return true;
  const membership = state.memberships.get(actorDid);
  if (!membership) return false;
  const assigned = new Set(membership.roles);
  return policy.grants.some((g) => assigned.has(g.role) && g.read === true);
}

export function liveRoleGrantsWrite(
  state: LiveGroupGovernanceState,
  spaceUri: string,
  actorDid: string,
  groupDid: string,
): boolean {
  if (actorDid === groupDid) return true;
  const policy = state.spacePolicies.get(spaceUri);
  if (!policy) return false;
  const membership = state.memberships.get(actorDid);
  if (!membership) return false;
  const assigned = new Set(membership.roles);
  return policy.grants.some((g) => assigned.has(g.role) && g.write === true);
}

export function assignableSetForActor(
  actorDid: string,
  state: LiveGroupGovernanceState,
  groupDid: string,
): { all: boolean; roles: Set<string> } {
  if (actorDid === groupDid) {
    return { all: true, roles: new Set(["*"]) };
  }
  const membership = state.memberships.get(actorDid);
  if (!membership) {
    return { all: false, roles: new Set() };
  }
  const allowed = new Set<string>();
  for (const roleKey of membership.roles) {
    const role = state.roles.get(roleKey);
    for (const item of role?.assignable ?? []) {
      if (item === "*") return { all: true, roles: new Set(["*"]) };
      allowed.add(item);
    }
  }
  return { all: false, roles: allowed };
}

export function assertCanAssignRoleDiff(
  actorDid: string,
  preState: LiveGroupGovernanceState,
  groupDid: string,
  prevRoles: readonly string[] | undefined,
  nextRoles: readonly string[] | undefined,
): void {
  if (actorDid === groupDid) return;
  const assignable = assignableSetForActor(actorDid, preState, groupDid);
  if (assignable.all) return;
  const prevSet = new Set(prevRoles ?? []);
  const nextSet = new Set(nextRoles ?? []);
  const changed = new Set<string>();
  for (const r of nextSet) if (!prevSet.has(r)) changed.add(r);
  for (const r of prevSet) if (!nextSet.has(r)) changed.add(r);
  for (const roleKey of changed) {
    if (!assignable.roles.has(roleKey)) {
      throw new GroupHostHttpError(
        403,
        "RoleNotAssignable",
        `Caller ${actorDid} is not authorized to assign or remove role '${roleKey}'.`,
      );
    }
  }
}

/**
 * Checks that every permission inside `candidatePerms` is structurally contained within `actorPerms`.
 */
export function isPermissionSubset(
  candidatePerms: ScopePermissions,
  actorPerms: ScopePermissions,
  groupDid: string,
): boolean {
  const actorBlobPerms: BlobPermission[] = [];
  const actorRepoPerms: RepoPermission[] = [];
  const actorRpcPerms: RpcPermission[] = [];
  const actorSpacePerms: SpacePermission[] = [];

  for (const actorToken of actorPerms.scopes) {
    if (actorToken.startsWith("blob:") || actorToken.startsWith("blob?")) {
      const bp = BlobPermission.fromString(actorToken);
      if (bp) actorBlobPerms.push(bp);
    } else if (actorToken.startsWith("repo:") || actorToken.startsWith("repo?")) {
      const rp = RepoPermission.fromString(actorToken);
      if (rp) actorRepoPerms.push(rp);
    } else if (actorToken.startsWith("rpc:") || actorToken.startsWith("rpc?")) {
      const rpcp = RpcPermission.fromString(actorToken);
      if (rpcp) actorRpcPerms.push(rpcp);
    } else if (actorToken.startsWith("space:") || actorToken.startsWith("space?")) {
      let sp = SpacePermission.fromString(actorToken);
      if (sp) {
        if (sp.spaceType !== "*" && !sp.hasCollections) {
          const declared = SPACE_DECLARED_COLLECTIONS[sp.spaceType] ?? (["*"] as const);
          sp = sp.withDefaultCollections(declared);
        }
        actorSpacePerms.push(
          sp.isSelfAuthority ? sp.withResolvedAuthority(groupDid as DidString) : sp,
        );
      }
    }
  }

  for (const token of candidatePerms.scopes) {
    if (token === "atproto") continue;

    if (token.startsWith("account:") || token.startsWith("account?")) {
      const p = AccountPermission.fromString(token);
      if (!p) return false;
      for (const action of p.action) {
        if (!actorPerms.allowsAccount({ attr: p.attr, action })) return false;
      }
      continue;
    }

    if (token.startsWith("identity:") || token.startsWith("identity?")) {
      const p = IdentityPermission.fromString(token);
      if (!p) return false;
      if (!actorPerms.allowsIdentity({ attr: p.attr })) return false;
      continue;
    }

    if (token.startsWith("blob:") || token.startsWith("blob?")) {
      const p = BlobPermission.fromString(token);
      if (!p) return false;
      for (const accept of p.accept) {
        if (accept === "*/*") {
          if (!actorBlobPerms.some((ab) => ab.accept.includes("*/*"))) {
            return false;
          }
        } else if (accept.endsWith("/*")) {
          if (!actorBlobPerms.some((ab) => ab.accept.includes("*/*") || ab.accept.includes(accept))) {
            return false;
          }
        } else if (!actorPerms.allowsBlob({ mime: accept as `${string}/${string}` })) {
          return false;
        }
      }
      continue;
    }

    if (token.startsWith("repo:") || token.startsWith("repo?")) {
      const p = RepoPermission.fromString(token);
      if (!p) return false;
      for (const col of p.collection) {
        for (const action of p.action) {
          const covered = actorRepoPerms.some(
            (ar) =>
              ar.action.includes(action) &&
              (ar.collection.includes("*") || (col !== "*" && ar.collection.includes(col))),
          );
          if (!covered) return false;
        }
      }
      continue;
    }

    if (token.startsWith("rpc:") || token.startsWith("rpc?")) {
      const p = RpcPermission.fromString(token);
      if (!p) return false;
      for (const lxm of p.lxm) {
        const covered = actorRpcPerms.some(
          (arpc) =>
            (arpc.aud === "*" || (p.aud !== "*" && arpc.aud === p.aud)) &&
            (arpc.lxm.includes("*") || (lxm !== "*" && arpc.lxm.includes(lxm))),
        );
        if (!covered) return false;
      }
      continue;
    }

    if (token.startsWith("space:") || token.startsWith("space?")) {
      let rawSp = SpacePermission.fromString(token);
      if (!rawSp) return false;
      if (rawSp.spaceType !== "*" && !rawSp.hasCollections) {
        const declared = SPACE_DECLARED_COLLECTIONS[rawSp.spaceType] ?? (["*"] as const);
        rawSp = rawSp.withDefaultCollections(declared);
      }
      const p = rawSp.isSelfAuthority ? rawSp.withResolvedAuthority(groupDid as DidString) : rawSp;
      const matchesTarget = (asp: SpacePermission): boolean =>
        (asp.spaceType === "*" || (p.spaceType !== "*" && asp.spaceType === p.spaceType)) &&
        (asp.authority === "*" || (p.authority !== "*" && asp.authority === p.authority)) &&
        (asp.skey === "*" || (p.skey !== "*" && asp.skey === p.skey));

      if (p.manage) {
        for (const manage of p.manage) {
          const covered = actorSpacePerms.some(
            (asp) => matchesTarget(asp) && asp.manage != null && asp.manage.includes(manage),
          );
          if (!covered) return false;
        }
      }
      for (const action of p.action) {
        if (action === "read") {
          const covered = actorSpacePerms.some(
            (asp) => matchesTarget(asp) && asp.action.includes("read"),
          );
          if (!covered) return false;
        } else if (action === "read_self") {
          const covered = actorSpacePerms.some(
            (asp) =>
              matchesTarget(asp) &&
              (asp.action.includes("read") || asp.action.includes("read_self")),
          );
          if (!covered) return false;
        } else if (p.collection) {
          for (const col of p.collection) {
            const covered = actorSpacePerms.some(
              (asp) =>
                matchesTarget(asp) &&
                asp.action.includes(action) &&
                asp.collection != null &&
                (asp.collection.includes("*") || (col !== "*" && asp.collection.includes(col))),
            );
            if (!covered) return false;
          }
        }
      }
      continue;
    }

    return false;
  }
  return true;
}

export function assertRoleWriteAntiEscalation(
  actorDid: string,
  preState: LiveGroupGovernanceState,
  groupDid: string,
  roleRkey: string,
  nextRole: GroupRoleRecord | undefined,
): void {
  if (actorDid === groupDid) return;
  const assignable = assignableSetForActor(actorDid, preState, groupDid);
  if (!assignable.all && !assignable.roles.has(roleRkey)) {
    throw new GroupHostHttpError(
      403,
      "PrivilegeEscalation",
      `Caller ${actorDid} is not authorized to modify or delete unassignable role '${roleRkey}'.`,
    );
  }
  if (!nextRole) return;

  const prevRole = preState.roles.get(roleRkey);
  const prevAssignable = new Set(prevRole?.assignable ?? []);
  for (const targetRole of nextRole.assignable ?? []) {
    if (prevAssignable.has(targetRole)) continue;
    if (targetRole === "*") {
      if (!assignable.all) {
        throw new GroupHostHttpError(403, "PrivilegeEscalation", "Cannot grant assignable '*' without holding '*'.");
      }
    } else if (!assignable.all && !assignable.roles.has(targetRole)) {
      throw new GroupHostHttpError(
        403,
        "PrivilegeEscalation",
        `Cannot make unassignable role '${targetRole}' assignable.`,
      );
    }
  }
  if (nextRole.scopes && nextRole.scopes.length > 0) {
    const prevExpanded = prevRole?.scopes?.length
      ? new Set(expandGroupScopes(prevRole.scopes, groupDid).scopes)
      : new Set<string>();
    const nextExpanded = expandGroupScopes(nextRole.scopes, groupDid);
    const addedScopes = [...nextExpanded.scopes].filter((s) => !prevExpanded.has(s));
    if (addedScopes.length > 0) {
      const actorPerms = effectiveMemberPermissions(preState, groupDid, actorDid);
      const candidatePerms = new ScopePermissions(addedScopes);
      if (!isPermissionSubset(candidatePerms, actorPerms, groupDid)) {
        throw new GroupHostHttpError(
          403,
          "PrivilegeEscalation",
          `Role '${roleRkey}' grants scopes exceeding caller ${actorDid}'s own effective permissions.`,
        );
      }
    }
  }
}

export function assertPolicyWriteAntiEscalation(
  actorDid: string,
  preState: LiveGroupGovernanceState,
  groupDid: string,
  spaceType: string,
  skey: string,
  policy: GroupOpenSocialPolicy,
): void {
  if (actorDid === groupDid) return;

  const targetSpaceUri = makeSpaceUri(groupDid, spaceType, skey);
  const prevPolicy = preState.spacePolicies.get(targetSpaceUri);
  const assignable = assignableSetForActor(actorDid, preState, groupDid);
  const actorPerms = effectiveMemberPermissions(preState, groupDid, actorDid);

  const canonicalizeGrantScopes = (rawScopes: readonly string[] | undefined): string[] => {
    if (!rawScopes || rawScopes.length === 0) return [];
    const clamped = expandPolicyGrantScopes(rawScopes, { groupDid, spaceType, skey });
    return [...new Set(clamped.map((p) => p.toString()))].sort();
  };

  const prevGrantsByRole = new Map<
    string,
    { read: boolean; write: boolean; canonicalScopes: string[] }
  >();
  for (const prevGrant of prevPolicy?.grants ?? []) {
    prevGrantsByRole.set(prevGrant.role, {
      read: Boolean(prevGrant.read),
      write: Boolean(prevGrant.write),
      canonicalScopes: canonicalizeGrantScopes(prevGrant.scopes),
    });
  }

  const nextGrantsByRole = new Map<
    string,
    { read: boolean; write: boolean; canonicalScopes: string[] }
  >();
  for (const grant of policy.grants ?? []) {
    nextGrantsByRole.set(grant.role, {
      read: Boolean(grant.read),
      write: Boolean(grant.write),
      canonicalScopes: canonicalizeGrantScopes(grant.scopes),
    });
  }

  const scopesEqual = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((item, idx) => item === b[idx]);

  const allRoles = new Set<string>([...prevGrantsByRole.keys(), ...nextGrantsByRole.keys()]);
  let newlyGrantsRead = false;
  let newlyGrantsWrite = false;

  for (const role of allRoles) {
    const prev = prevGrantsByRole.get(role);
    const next = nextGrantsByRole.get(role);
    const changed =
      !prev ||
      !next ||
      prev.read !== next.read ||
      prev.write !== next.write ||
      !scopesEqual(prev.canonicalScopes, next.canonicalScopes);

    if (changed && !assignable.all && !assignable.roles.has(role)) {
      throw new GroupHostHttpError(
        403,
        "PrivilegeEscalation",
        `Caller ${actorDid} is not authorized to change policy grants for unassignable role '${role}'.`,
      );
    }

    if (next) {
      if (next.read && !prev?.read) {
        newlyGrantsRead = true;
      }
      if (next.write && !prev?.write) {
        newlyGrantsWrite = true;
      }
      if ((!prev || !scopesEqual(prev.canonicalScopes, next.canonicalScopes)) && next.canonicalScopes.length > 0) {
        const prevScopeSet = new Set(prev?.canonicalScopes ?? []);
        const addedScopes = prev ? next.canonicalScopes.filter((s) => !prevScopeSet.has(s)) : next.canonicalScopes;
        if (addedScopes.length > 0) {
          const candidatePerms = new ScopePermissions(addedScopes);
          if (!isPermissionSubset(candidatePerms, actorPerms, groupDid)) {
            throw new GroupHostHttpError(
              403,
              "PrivilegeEscalation",
              `Policy grant for role '${role}' grants scopes exceeding caller ${actorDid}'s own effective permissions.`,
            );
          }
        }
      }
    }
  }

  const newlyPublicRead = policy.publicRead === true && prevPolicy?.publicRead !== true;
  if (prevPolicy === undefined) {
    // Initial space creation (`createSpace`): bootstrap exception narrowly confined to effective admins.
    if (
      (newlyPublicRead || newlyGrantsRead || newlyGrantsWrite) &&
      !isEffectiveAdminMember(actorDid, preState, groupDid)
    ) {
      throw new GroupHostHttpError(
        403,
        "PrivilegeEscalation",
        `Caller ${actorDid} cannot bootstrap space access grants on ${targetSpaceUri} without effective admin authority.`,
      );
    }
  } else {
    // Existing-space policy update (`updateSpace`, `proposal.md:102`): applies unconditionally to EVERY human actor!
    if (newlyPublicRead || newlyGrantsRead) {
      if (!liveRoleGrantsRead(preState, targetSpaceUri, actorDid, groupDid)) {
        throw new GroupHostHttpError(
          403,
          "PrivilegeEscalation",
          `Caller ${actorDid} cannot grant read access on ${targetSpaceUri} without already holding read access.`,
        );
      }
    }
    if (newlyGrantsWrite) {
      if (!liveRoleGrantsWrite(preState, targetSpaceUri, actorDid, groupDid)) {
        throw new GroupHostHttpError(
          403,
          "PrivilegeEscalation",
          `Caller ${actorDid} cannot grant write access on ${targetSpaceUri} without already holding write access.`,
        );
      }
    }
    if (Boolean(prevPolicy.unlisted) && !Boolean(policy.unlisted)) {
      if (!liveRoleGrantsRead(preState, targetSpaceUri, actorDid, groupDid)) {
        throw new GroupHostHttpError(
          403,
          "PrivilegeEscalation",
          `Caller ${actorDid} cannot list unlisted space ${targetSpaceUri} without holding read access.`,
        );
      }
    }
  }
}

export function assertPostGovernanceInvariants(
  preState: LiveGroupGovernanceState,
  postState: LiveGroupGovernanceState,
  groupDid: string,
  options: {
    allowSoleMemberDeactivation?: boolean;
    deletedRoles?: ReadonlySet<string>;
  } = {},
): void {
  // 1. Group self-DID cannot have explicit membership or app install
  if (postState.memberships.has(groupDid)) {
    throw new GroupHostHttpError(400, "CannotTargetGroupSelf", "Group DID cannot have an explicit membership record.");
  }
  if (postState.allAppInstalls.has(groupDid)) {
    throw new GroupHostHttpError(400, "CannotTargetGroupSelf", "Group DID cannot be installed as an app.");
  }

  // 2. Role & Policy referential integrity (`RoleInUse`, `UnknownRole`, `DuplicateRoleGrant`, `EmptyMemberRoles`)
  const deletedRoles = options.deletedRoles ?? new Set<string>();
  for (const [spaceUri, policy] of postState.spacePolicies.entries()) {
    const parsed = parseSpaceUri(spaceUri);
    if (parsed) {
      const polCheck = validateSpacePolicy(
        { $type: "group.opensocial.policy", ...policy },
        { groupDid, spaceType: parsed.type, skey: parsed.skey },
      );
      if (!polCheck.valid) {
        throw new GroupHostHttpError(400, polCheck.code ?? "InvalidRequest", polCheck.reason);
      }
    }
    const seenGrantRoles = new Set<string>();
    for (const grant of policy.grants ?? []) {
      if (seenGrantRoles.has(grant.role)) {
        throw new GroupHostHttpError(400, "DuplicateRoleGrant", `Duplicate grant for role '${grant.role}' in ${spaceUri}.`);
      }
      seenGrantRoles.add(grant.role);
      if (!postState.roles.has(grant.role)) {
        const code = deletedRoles.has(grant.role) ? "RoleInUse" : "UnknownRole";
        throw new GroupHostHttpError(400, code, `Policy in ${spaceUri} references missing role '${grant.role}'.`);
      }
    }
  }

  for (const [roleKey, role] of postState.roles.entries()) {
    for (const target of role.assignable ?? []) {
      if (target !== "*" && target !== roleKey && !postState.roles.has(target)) {
        const code = deletedRoles.has(target) ? "RoleInUse" : "UnknownRole";
        throw new GroupHostHttpError(400, code, `Role '${roleKey}' assignable list references missing role '${target}'.`);
      }
    }
  }

  for (const [memberDid, membership] of postState.memberships.entries()) {
    if (!Array.isArray(membership.roles) || membership.roles.length < 1) {
      throw new GroupHostHttpError(400, "EmptyMemberRoles", `Membership for ${memberDid} must include at least one role.`);
    }
    for (const roleKey of membership.roles) {
      if (!postState.roles.has(roleKey)) {
        const code = deletedRoles.has(roleKey) ? "RoleInUse" : "UnknownRole";
        throw new GroupHostHttpError(400, code, `Membership for ${memberDid} references missing role '${roleKey}'.`);
      }
    }
  }

  // 3. Flock-modality invariants (enforced IFF Flock workspace/self exists and is not deleted!)
  if (postState.hasFlockWorkspace) {
    // Cannot delete app.install tombstones
    for (const priorSubject of preState.allAppInstalls.keys()) {
      if (!postState.allAppInstalls.has(priorSubject)) {
        throw new GroupHostHttpError(
          400,
          "CannotDeleteAppInstallTombstone",
          `Cannot delete app.install tombstone for ${priorSubject}; mark active: false instead.`,
        );
      }
    }

    // Cannot convert existing human member into an app service principal
    for (const [subjectDid, install] of postState.allAppInstalls.entries()) {
      if (!preState.knownAppSubjects.has(subjectDid) && preState.memberships.has(subjectDid)) {
        throw new GroupHostHttpError(
          400,
          "SubjectAlreadyHumanMember",
          `Account ${subjectDid} is already a human group member and cannot be installed as an app.`,
        );
      }
      if (!install.active && postState.memberships.has(subjectDid)) {
        throw new GroupHostHttpError(
          400,
          "AppMembershipActive",
          `Cannot mark app ${subjectDid} inactive while membership/${subjectDid} still exists.`,
        );
      }
    }

    // Conditional app-membership invariant:
    // (membership/<subjectDid> exists && subjectDid in known_app_subject) => (active app.install exists && roles === [appRoleKey(subjectDid)])
    for (const [memberDid, membership] of postState.memberships.entries()) {
      if (postState.knownAppSubjects.has(memberDid)) {
        const expectedRole = appRoleKey(memberDid);
        if (
          !postState.activeAppInstalls.has(memberDid) ||
          membership.roles.length !== 1 ||
          membership.roles[0] !== expectedRole
        ) {
          throw new GroupHostHttpError(
            400,
            "InvalidAppMembership",
            `App service principal ${memberDid} requires an active app.install and sole role '${expectedRole}'.`,
          );
        }
      }
    }

    // Human LastAdmin invariant
    if (!options.allowSoleMemberDeactivation) {
      const preAdmins = effectiveHumanAdmins(preState, groupDid);
      const postAdmins = effectiveHumanAdmins(postState, groupDid);
      if (preAdmins.length >= 1 && postAdmins.length === 0) {
        throw new GroupHostHttpError(
          400,
          "LastAdmin",
          "Cannot remove or demote the last effective human admin of a Flock workspace.",
        );
      }
    }
  }
}

export { isEffectiveAdminMember };
