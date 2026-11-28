import { createHash, randomUUID } from "node:crypto";
import type { P256Keypair } from "@atproto/crypto";
import { isCid, parseCid, toBase64, type LexMap } from "@atproto/lex-data";
import { ScopePermissions } from "@atproto/oauth-scopes";
import type { DidString } from "@atproto/syntax";
import {
  appRoleKey,
  canonicalJson,
  groupMembersUri,
  groupMetaUri,
  isDid,
  isRecordKey,
  isTid,
  parseAnySpaceRecordUri,
  parsePersonalInboxUri,
  parseSpaceUri,
  personalInboxUri,
  SELF_SKEY,
  workspaceUri,
} from "@flock/protocol/keys";
import {
  ATGRP_COLLECTION,
  ATGRP_POLICY,
  ATGRP_SPACE_TYPE,
  ATPROTO_SPACE_COLLECTION,
  COLLECTION,
  FLOCK_EXTENSION_FIELD,
} from "@flock/protocol/nsids";
import {
  decodeFlockMembershipExtensions,
  validateSpacePolicy,
} from "@flock/protocol/registry";
import {
  effectiveHumanAdmins,
  effectiveMemberPermissions,
  expandGroupScopes,
  expandPolicyGrantScopes,
  groupAdminScopes,
  groupModeratorScopes,
  isEffectiveAdminMember,
  isPermissionSubset,
  type GroupAtgrpPolicy,
  type GroupMembershipRecord,
  type GroupRoleRecord,
} from "@flock/protocol/scopes";

export const DAY_MS = 86_400_000;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export function isValidIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && IDEMPOTENCY_KEY_RE.test(value);
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export type FakeJoinRequestRow = {
  requesterDid: string;
  message: string | null;
  createdAt: string;
  expiresAt: number;
};

export type FakeJoinOperationRow = {
  requesterDid: string;
  operationId: string;
  requestHash: string;
  state: "pending" | "admitted" | "denied" | "cancelled";
  responseJson: string;
  expiresAt: number;
  updatedAt: number;
};

export type FakeInviteDeliveryRow = {
  inviteUri: string;
  spaceUri: string;
  inviteeDid: string;
  rkey: string;
  repoRev: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
};

export type FakeModSubjectRow = {
  subject: string;
  cidKey: string;
  status: "open" | "resolved";
  reportCount: number;
  tags: Set<string>;
  createdAt: string;
  updatedAt: string;
};

export type FakeModEventRow = {
  seq: number;
  eventId: string;
  subject: string;
  cidKey: string;
  subjectOwnerDid: string;
  isSelfVisible: boolean;
  createdAt: string;
  createdBy: string | null;
  event: Record<string, unknown>;
};

export type FakeActionTokenRow = {
  token: string | null;
  tokenHash: string;
  actorDid: string;
  purpose: "delete_account" | "plc_operation";
  expiresAt: number;
};

export type FakeSourceMigrationLease = {
  operationId: string;
  mode: "coordinated" | "standard";
  ticketId: string | null;
  ticketSecret: string | null;
  ticketSecretHash: string | null;
  targetServiceDid: string;
  targetEndpoint: string;
  status: "prepared" | "plc_signed";
  signedPlcOp: Record<string, unknown> | null;
  frozenAt: number;
  deadlineAt: number;
  expiresAt: number | null;
  manifestDigest: string;
  rootManifestJson: string;
};

export type FakeMigrationSession = {
  id: string;
  mode: "coordinated" | "standard";
  operationId: string | null;
  ticketId: string | null;
  ticketSecretHash: string | null;
  sourceEndpoint: string;
  sourceServiceDid: string | null;
  sourceLocalRotationKey: string | null;
  manifestDigest: string | null;
  expectedManifestJson: string | null;
  stagedSigningKey: P256Keypair;
  stagedKemKey: P256Keypair;
  accessJti: string;
  refreshJti: string;
  prevRefreshJti: string | null;
  refreshIdempotencyKey: string | null;
  refreshGraceExpiresAt: number | null;
  authEpoch: number;
  plcCutoverAt: number | null;
  absoluteDeadlineAt: number;
  createdAt: number;
};

export type FakeGroupState = {
  did: string;
  handle: string;
  authEpoch: number;
  localRotationKey: P256Keypair;
  sovereignRotationKeys: Set<string>;
  knownAppSubjects: Set<string>;
  recoveryAdmin: { recoveryDid: string; roles: string[]; deactivatedAt: number } | null;
  sourceMigrationLease: FakeSourceMigrationLease | null;
  migrationSession: FakeMigrationSession | null;
  spaceIndexRkeys: Map<string, string>;
  priorEjectCounts: Map<string, { count: number; lastEvictedRepoRev: string | null }>;
  joinRequests: Map<string, FakeJoinRequestRow>;
  joinOperations: Map<string, FakeJoinOperationRow>;
  inviteDeliveries: Map<string, FakeInviteDeliveryRow>;
  modSubjects: Map<string, FakeModSubjectRow>;
  modEjectionEligibility: Map<string, string>;
  modEvents: FakeModEventRow[];
  nextModSeq: number;
  actionTokens: Map<"delete_account" | "plc_operation", FakeActionTokenRow>;
  blobs: Map<string, { mimeType: string; size: number; bytes: Uint8Array }>;
};

export type GovernanceSnapshot = {
  roles: Map<string, GroupRoleRecord>;
  memberships: Map<string, GroupMembershipRecord>;
  spacePolicies: Map<string, GroupAtgrpPolicy>;
  knownAppSubjects: Set<string>;
  allAppInstalls: Map<string, { subject: string; active: boolean; channels: Array<{ skey: string; write: boolean }> }>;
  activeAppInstalls: Map<string, { subject: string; active: boolean; channels: Array<{ skey: string; write: boolean }> }>;
  hasFlockWorkspace: boolean;
};

export function defaultBootstrapRoles(groupDid: string): Record<string, GroupRoleRecord & { $type: string }> {
  return {
    admin: {
      $type: ATGRP_COLLECTION.role,
      displayName: "Admin",
      description: "Full administrative control over the group.",
      canAssign: ["*"],
      permissions: groupAdminScopes(groupDid).filter((s) => s !== "atproto"),
    },
    moderator: {
      $type: ATGRP_COLLECTION.role,
      displayName: "Moderator",
      description: "Moderation queue, labels, and member ejection.",
      canAssign: ["member"],
      permissions: groupModeratorScopes().filter((s) => s !== "atproto"),
    },
    member: {
      $type: ATGRP_COLLECTION.role,
      displayName: "Member",
      description: "Standard group member.",
      default: true,
      permissions: [],
    },
  };
}

export function normalizeAtgrpPolicy(
  rawPolicy: unknown,
  context: { groupDid: string; spaceType: string; skey: string; importMode?: boolean },
  ErrorCtor: new (status: number, code: string, message?: string) => Error,
): GroupAtgrpPolicy {
  const check = validateSpacePolicy(rawPolicy, context);
  if (!check.valid) {
    throw new ErrorCtor(400, check.code ?? "InvalidSpacePolicy", check.reason);
  }
  const pol = rawPolicy as GroupAtgrpPolicy;
  return {
    $type: ATGRP_POLICY,
    publicRead: pol.publicRead === true,
    unlisted: pol.unlisted === true,
    grants: pol.grants.map((g) => ({
      role: g.role,
      ...(g.read !== undefined ? { read: Boolean(g.read) } : {}),
      ...(g.write !== undefined ? { write: Boolean(g.write) } : {}),
      ...(g.permissions && g.permissions.length > 0 ? { permissions: [...g.permissions] } : {}),
    })),
  };
}

export function liveRoleGrantsAccess(
  state: GovernanceSnapshot,
  spaceUriStr: string,
  actorDid: string | undefined,
  groupDid: string,
  mode: "read" | "write",
): boolean {
  if (actorDid === groupDid) return true;
  const pol = state.spacePolicies.get(spaceUriStr);
  if (!pol) return false;
  if (mode === "read" && pol.publicRead === true) return true;
  if (!actorDid) return false;
  const mem = state.memberships.get(actorDid);
  if (!mem) return false;
  const roleSet = new Set(mem.roles);
  return pol.grants.some((g) => roleSet.has(g.role) && (mode === "read" ? g.read === true : g.write === true));
}

export function checkPostGovernanceInvariants(
  preState: GovernanceSnapshot,
  postState: GovernanceSnapshot,
  groupDid: string,
  options: {
    allowSoleMemberDeactivation?: boolean;
    deletedRoles?: ReadonlySet<string>;
    importMode?: boolean;
  } = {},
  ErrorCtor: new (status: number, code: string, message?: string) => Error,
): void {
  if (postState.memberships.has(groupDid)) {
    throw new ErrorCtor(400, "CannotTargetGroupSelf", "Group DID cannot have an explicit membership record.");
  }
  if (postState.allAppInstalls.has(groupDid)) {
    throw new ErrorCtor(400, "CannotTargetGroupSelf", "Group DID cannot be installed as an app.");
  }

  const deletedRoles = options.deletedRoles ?? new Set<string>();
  for (const [spUri, pol] of postState.spacePolicies) {
    const parsed = parseSpaceUri(spUri);
    if (parsed) {
      const polCheck = validateSpacePolicy(
        { $type: ATGRP_POLICY, ...pol },
        { groupDid, spaceType: parsed.type, skey: parsed.skey, importMode: options.importMode },
      );
      if (!polCheck.valid) {
        throw new ErrorCtor(400, polCheck.code ?? "InvalidRequest", polCheck.reason);
      }
    }
    const seenGrantRoles = new Set<string>();
    for (const g of pol.grants) {
      if (seenGrantRoles.has(g.role)) {
        throw new ErrorCtor(400, "DuplicateRoleGrant", `Duplicate grant for role '${g.role}' in ${spUri}.`);
      }
      seenGrantRoles.add(g.role);
      if (!postState.roles.has(g.role)) {
        throw new ErrorCtor(
          400,
          deletedRoles.has(g.role) ? "RoleInUse" : "UnknownRole",
          `Policy on ${spUri} references missing role '${g.role}'`,
        );
      }
    }
  }
  for (const [rkey, role] of postState.roles) {
    for (const target of role.canAssign ?? []) {
      if (target !== "*" && target !== rkey && !postState.roles.has(target)) {
        throw new ErrorCtor(
          400,
          deletedRoles.has(target) ? "RoleInUse" : "UnknownRole",
          `role/${rkey} canAssign references unknown role '${target}'`,
        );
      }
    }
  }
  for (const [memberDid, mem] of postState.memberships) {
    if (!Array.isArray(mem.roles) || mem.roles.length < 1) {
      throw new ErrorCtor(400, "EmptyMemberRoles", `membership/${memberDid} must assign at least one role.`);
    }
    for (const r of mem.roles) {
      if (!postState.roles.has(r)) {
        throw new ErrorCtor(
          400,
          deletedRoles.has(r) ? "RoleInUse" : "UnknownRole",
          `membership/${memberDid} references missing role '${r}'`,
        );
      }
    }
  }

  if (postState.hasFlockWorkspace) {
    for (const [subjDid] of preState.allAppInstalls) {
      if (!postState.allAppInstalls.has(subjDid)) {
        throw new ErrorCtor(
          400,
          "CannotDeleteAppInstallTombstone",
          `App install record for ${subjDid} must be deactivated rather than deleted.`,
        );
      }
    }
    for (const [subjDid, inst] of postState.allAppInstalls) {
      if (!preState.knownAppSubjects.has(subjDid) && preState.memberships.has(subjDid)) {
        throw new ErrorCtor(400, "SubjectAlreadyHumanMember", `${subjDid} is already a human member.`);
      }
      if (!inst.active && postState.memberships.has(subjDid)) {
        throw new ErrorCtor(400, "AppMembershipActive", `Deactivated app ${subjDid} cannot retain membership.`);
      }
    }
    for (const [memberDid, mem] of postState.memberships) {
      if (postState.knownAppSubjects.has(memberDid)) {
        const activeInst = postState.activeAppInstalls.get(memberDid);
        const expectedRole = appRoleKey(memberDid);
        if (!activeInst || mem.roles.length !== 1 || mem.roles[0] !== expectedRole) {
          throw new ErrorCtor(400, "InvalidAppMembership", `App principal ${memberDid} requires active app.install and [${expectedRole}].`);
        }
      }
    }

    if (!options.allowSoleMemberDeactivation) {
      const preAdmins = effectiveHumanAdmins(preState, groupDid);
      const postAdmins = effectiveHumanAdmins(postState, groupDid);
      if (preAdmins.length >= 1 && postAdmins.length === 0) {
        throw new ErrorCtor(400, "LastAdmin", "Flock workspace must retain at least one effective human admin.");
      }
    }
  }
}

export const isPermissionSubsetLocal = isPermissionSubset;

function canonicalizePolicyGrantScopes(
  rawScopes: readonly string[] | undefined,
  target: { groupDid: string; spaceType: string; skey: string },
): string[] {
  if (!rawScopes || rawScopes.length === 0) return [];
  const clamped = expandPolicyGrantScopes(rawScopes, target);
  return [...new Set(clamped.map((p) => p.toString()))].sort();
}

function scopesArraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, idx) => v === b[idx]);
}

export function checkRoleAndAssignmentEscalation(params: {
  actorDid: string;
  preState: GovernanceSnapshot;
  groupDid: string;
  roleWrites: Array<{ rkey: string; role: GroupRoleRecord }>;
  roleDeletes?: readonly string[];
  policyWrite?: {
    spaceUri?: string;
    spaceType: string;
    skey: string;
    policy: GroupAtgrpPolicy;
    prevPolicy?: GroupAtgrpPolicy;
    isEffectiveAdmin?: boolean;
  };
  membershipDiffs: Array<{ prevRoles?: readonly string[]; nextRoles: readonly string[] }>;
  ErrorCtor: new (status: number, code: string, message?: string) => Error;
}): void {
  const { actorDid, preState, groupDid, ErrorCtor } = params;
  if (actorDid === groupDid) return;

  const actorPerms = effectiveMemberPermissions(preState, groupDid, actorDid);
  const actorRoles = preState.memberships.get(actorDid)?.roles ?? [];
  const assignable = new Set<string>();
  for (const r of actorRoles) {
    for (const target of preState.roles.get(r)?.canAssign ?? []) {
      assignable.add(target);
    }
  }
  const hasWildcard = assignable.has("*");

  for (const delRkey of params.roleDeletes ?? []) {
    if (!hasWildcard && !assignable.has(delRkey)) {
      throw new ErrorCtor(403, "PrivilegeEscalation", `Caller cannot delete unassignable role '${delRkey}'.`);
    }
  }

  for (const rw of params.roleWrites) {
    if (!hasWildcard && !assignable.has(rw.rkey)) {
      throw new ErrorCtor(403, "PrivilegeEscalation", `Caller cannot create or modify unassignable role '${rw.rkey}'.`);
    }
    const prevRole = preState.roles.get(rw.rkey);
    const prevCanAssign = new Set(prevRole?.canAssign ?? []);
    for (const a of rw.role.canAssign ?? []) {
      if (prevCanAssign.has(a)) continue;
      if (a === "*" && !hasWildcard) {
        throw new ErrorCtor(403, "PrivilegeEscalation", "Only wildcard-assignable admins can grant canAssign=['*'].");
      }
      if (a !== "*" && !hasWildcard && !assignable.has(a)) {
        throw new ErrorCtor(403, "PrivilegeEscalation", `Caller cannot grant canAssign over '${a}'.`);
      }
    }
    if (rw.role.permissions && rw.role.permissions.length > 0) {
      const prevExpanded = prevRole?.permissions?.length
        ? new Set(expandGroupScopes(prevRole.permissions, groupDid as DidString).scopes)
        : new Set<string>();
      const nextExpanded = expandGroupScopes(rw.role.permissions, groupDid as DidString);
      const addedScopes = [...nextExpanded.scopes].filter((s) => !prevExpanded.has(s));
      if (addedScopes.length > 0) {
        const targetPerms = new ScopePermissions(addedScopes);
        if (!isPermissionSubset(targetPerms, actorPerms, groupDid)) {
          throw new ErrorCtor(403, "PrivilegeEscalation", `Role '${rw.rkey}' grants permissions exceeding caller's own permissions.`);
        }
      }
    }
  }

  if (params.policyWrite) {
    const pw = params.policyWrite;
    const spaceUri = pw.spaceUri ?? `at:space/${groupDid}/${pw.spaceType}/${pw.skey}`;
    const prevPolicy = pw.prevPolicy;
    const isEffAdmin = pw.isEffectiveAdmin ?? isEffectiveAdminMember(actorDid, preState, groupDid);
    const scopeTarget = { groupDid, spaceType: pw.spaceType, skey: pw.skey };

    const prevByRole = new Map<string, { read: boolean; write: boolean; canonicalScopes: string[] }>();
    for (const g of prevPolicy?.grants ?? []) {
      prevByRole.set(g.role, {
        read: Boolean(g.read),
        write: Boolean(g.write),
        canonicalScopes: canonicalizePolicyGrantScopes(g.permissions, scopeTarget),
      });
    }
    const nextByRole = new Map<string, { read: boolean; write: boolean; canonicalScopes: string[] }>();
    for (const g of pw.policy.grants ?? []) {
      nextByRole.set(g.role, {
        read: Boolean(g.read),
        write: Boolean(g.write),
        canonicalScopes: canonicalizePolicyGrantScopes(g.permissions, scopeTarget),
      });
    }

    const touchedRoles = new Set<string>([...prevByRole.keys(), ...nextByRole.keys()]);
    for (const role of touchedRoles) {
      const prevG = prevByRole.get(role);
      const nextG = nextByRole.get(role);
      const changed =
        !prevG ||
        !nextG ||
        prevG.read !== nextG.read ||
        prevG.write !== nextG.write ||
        !scopesArraysEqual(prevG.canonicalScopes, nextG.canonicalScopes);
      if (!changed) continue;

      if (!hasWildcard && !assignable.has(role)) {
        throw new ErrorCtor(403, "PrivilegeEscalation", `Caller cannot modify policy grant for unassignable role '${role}'.`);
      }

      if (
        nextG &&
        nextG.canonicalScopes.length > 0 &&
        (!prevG || !scopesArraysEqual(prevG.canonicalScopes, nextG.canonicalScopes))
      ) {
        const prevScopeSet = new Set(prevG?.canonicalScopes ?? []);
        const addedScopes = prevG
          ? nextG.canonicalScopes.filter((s) => !prevScopeSet.has(s))
          : nextG.canonicalScopes;
        if (addedScopes.length > 0) {
          const candidatePerms = new ScopePermissions(addedScopes);
          if (!isPermissionSubset(candidatePerms, actorPerms, groupDid)) {
            throw new ErrorCtor(403, "PrivilegeEscalation", `Policy grant for '${role}' exceeds caller's permissions.`);
          }
        }
      }

      if (prevPolicy === undefined) {
        if (!isEffAdmin && (nextG?.read === true || nextG?.write === true)) {
          throw new ErrorCtor(
            403,
            "PrivilegeEscalation",
            `Caller cannot bootstrap space access grants on ${spaceUri} without effective admin authority.`,
          );
        }
      } else {
        if (nextG?.read === true && prevG?.read !== true) {
          if (!liveRoleGrantsAccess(preState, spaceUri, actorDid, groupDid, "read")) {
            throw new ErrorCtor(403, "PrivilegeEscalation", `Caller lacks read access to grant read on ${spaceUri}.`);
          }
        }
        if (nextG?.write === true && prevG?.write !== true) {
          if (!liveRoleGrantsAccess(preState, spaceUri, actorDid, groupDid, "write")) {
            throw new ErrorCtor(403, "PrivilegeEscalation", `Caller lacks write access to grant write on ${spaceUri}.`);
          }
        }
      }
    }

    if (prevPolicy === undefined) {
      if (!isEffAdmin && pw.policy.publicRead === true) {
        throw new ErrorCtor(403, "PrivilegeEscalation", `Caller lacks authority to enable publicRead on ${spaceUri}.`);
      }
    } else {
      if (pw.policy.publicRead === true && prevPolicy.publicRead !== true) {
        if (!liveRoleGrantsAccess(preState, spaceUri, actorDid, groupDid, "read")) {
          throw new ErrorCtor(403, "PrivilegeEscalation", `Caller lacks read access to enable publicRead on ${spaceUri}.`);
        }
      }
      if (Boolean(prevPolicy.unlisted) && !Boolean(pw.policy.unlisted)) {
        if (!liveRoleGrantsAccess(preState, spaceUri, actorDid, groupDid, "read")) {
          throw new ErrorCtor(403, "PrivilegeEscalation", `Caller lacks read access to list unlisted space ${spaceUri}.`);
        }
      }
    }
  }

  for (const diff of params.membershipDiffs) {
    const prevSet = new Set(diff.prevRoles ?? []);
    const nextSet = new Set(diff.nextRoles);
    for (const r of nextSet) {
      if (!prevSet.has(r) && !hasWildcard && !assignable.has(r)) {
        throw new ErrorCtor(403, "RoleNotAssignable", `Caller cannot assign role '${r}'.`);
      }
    }
    for (const r of prevSet) {
      if (!nextSet.has(r) && !hasWildcard && !assignable.has(r)) {
        throw new ErrorCtor(403, "RoleNotAssignable", `Caller cannot revoke role '${r}'.`);
      }
    }
  }
}

export const assertFakeAntiEscalation = checkRoleAndAssignmentEscalation;

export function plainJsonToLexDataLocal(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (isCid(value) || value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return value.map(plainJsonToLexDataLocal);
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 1 && typeof obj.$link === "string") return parseCid(obj.$link);
  if (keys.length === 1 && typeof obj.$bytes === "string") {
    return Uint8Array.from(Buffer.from(obj.$bytes, "base64"));
  }
  const out: LexMap = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = plainJsonToLexDataLocal(v) as LexMap[string];
  }
  return out;
}

export function lexDataToPlainJsonLocal(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (isCid(value)) return { $link: value.toString() };
  if (value instanceof Uint8Array) return { $bytes: toBase64(value) };
  if (Array.isArray(value)) return value.map(lexDataToPlainJsonLocal);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = lexDataToPlainJsonLocal(v);
  }
  return out;
}

export {
  appRoleKey,
  ATGRP_COLLECTION,
  ATGRP_POLICY,
  ATGRP_SPACE_TYPE,
  ATPROTO_SPACE_COLLECTION,
  canonicalJson,
  COLLECTION,
  decodeFlockMembershipExtensions,
  FLOCK_EXTENSION_FIELD,
  groupMembersUri,
  groupMetaUri,
  isDid,
  isEffectiveAdminMember,
  isRecordKey,
  isTid,
  parseAnySpaceRecordUri,
  parsePersonalInboxUri,
  parseSpaceUri,
  personalInboxUri,
  randomUUID,
  SELF_SKEY,
  workspaceUri,
};
