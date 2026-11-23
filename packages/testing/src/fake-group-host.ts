import { createHash, randomUUID } from "node:crypto";
import type { P256Keypair } from "@atproto/crypto";
import { isCid, parseCid, toBase64, type LexMap } from "@atproto/lex-data";
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
import {
  appRoleKey,
  canonicalJson,
  groupMembersUri,
  groupMetaUri,
  isDid,
  isRecordKey,
  isTid,
  parseAnySpaceRecordUri,
  parsePersonalInvitesUri,
  parseSpaceUri,
  personalInvitesUri,
  SELF_SKEY,
  workspaceUri,
} from "@flock/protocol/keys";
import {
  ATPROTO_SPACE_COLLECTION,
  COLLECTION,
  FLOCK_EXTENSION_FIELD,
  OPENSOCIAL_COLLECTION,
  OPENSOCIAL_POLICY,
  OPENSOCIAL_SPACE_TYPE,
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
  SPACE_DECLARED_COLLECTIONS,
  type GroupMembershipRecord,
  type GroupOpenSocialPolicy,
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
  status: "open" | "resolved" | "escalated";
  reportCount: number;
  createdAt: string;
  updatedAt: string;
};

export type FakeModEventRow = {
  seq: number;
  subject: string;
  cidKey: string;
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
  modEvents: FakeModEventRow[];
  nextModSeq: number;
  actionTokens: Map<"delete_account" | "plc_operation", FakeActionTokenRow>;
  blobs: Map<string, { mimeType: string; size: number; bytes: Uint8Array }>;
};

export type GovernanceSnapshot = {
  roles: Map<string, GroupRoleRecord>;
  memberships: Map<string, GroupMembershipRecord>;
  spacePolicies: Map<string, GroupOpenSocialPolicy>;
  knownAppSubjects: Set<string>;
  allAppInstalls: Map<string, { subject: string; active: boolean; channels: Array<{ skey: string; write: boolean }> }>;
  activeAppInstalls: Map<string, { subject: string; active: boolean; channels: Array<{ skey: string; write: boolean }> }>;
  hasFlockWorkspace: boolean;
};

export function defaultBootstrapRoles(groupDid: string): Record<string, GroupRoleRecord & { $type: string }> {
  return {
    admin: {
      $type: OPENSOCIAL_COLLECTION.role,
      displayName: "Admin",
      description: "Full administrative control over the group.",
      assignable: ["*"],
      scopes: groupAdminScopes(groupDid),
    },
    moderator: {
      $type: OPENSOCIAL_COLLECTION.role,
      displayName: "Moderator",
      description: "Moderation queue, labels, join requests, and invitations.",
      assignable: ["member"],
      scopes: groupModeratorScopes(),
    },
    member: {
      $type: OPENSOCIAL_COLLECTION.role,
      displayName: "Member",
      description: "Standard group member.",
      default: true,
      scopes: [],
    },
  };
}

export function normalizeOpenSocialPolicy(
  rawPolicy: unknown,
  context: { groupDid: string; spaceType: string; skey: string },
  ErrorCtor: new (status: number, code: string, message?: string) => Error,
): GroupOpenSocialPolicy {
  const check = validateSpacePolicy(rawPolicy, context);
  if (!check.valid) {
    throw new ErrorCtor(400, check.code ?? "InvalidSpacePolicy", check.reason);
  }
  const pol = rawPolicy as GroupOpenSocialPolicy;
  return {
    $type: OPENSOCIAL_POLICY,
    publicRead: pol.publicRead === true,
    unlisted: pol.unlisted === true,
    grants: pol.grants.map((g) => ({
      role: g.role,
      ...(g.read !== undefined ? { read: Boolean(g.read) } : {}),
      ...(g.write !== undefined ? { write: Boolean(g.write) } : {}),
      ...(g.scopes && g.scopes.length > 0 ? { scopes: [...g.scopes] } : {}),
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
        { $type: OPENSOCIAL_POLICY, ...pol },
        { groupDid, spaceType: parsed.type, skey: parsed.skey },
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
    for (const target of role.assignable ?? []) {
      if (target !== "*" && target !== rkey && !postState.roles.has(target)) {
        throw new ErrorCtor(
          400,
          deletedRoles.has(target) ? "RoleInUse" : "UnknownRole",
          `role/${rkey} assignable references unknown role '${target}'`,
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

/**
 * Exact structural wildcard containment check (zero sampled probes):
 * verifies every permission in `candidatePerms` is structurally covered by `actorPerms`.
 */
export function isPermissionSubsetLocal(
  candidatePerms: ScopePermissions,
  actorPerms: ScopePermissions,
  groupDid: string,
): boolean {
  const actorIdentity: IdentityPermission[] = [];
  const actorBlob: BlobPermission[] = [];
  const actorRepo: RepoPermission[] = [];
  const actorRpc: RpcPermission[] = [];
  const actorSpace: SpacePermission[] = [];

  for (const actorToken of actorPerms.scopes) {
    if (actorToken === "atproto") continue;
    if (actorToken.startsWith("identity:") || actorToken.startsWith("identity?")) {
      const parsed = IdentityPermission.fromString(actorToken);
      if (parsed) actorIdentity.push(parsed);
    } else if (actorToken.startsWith("blob:") || actorToken.startsWith("blob?")) {
      const parsed = BlobPermission.fromString(actorToken);
      if (parsed) actorBlob.push(parsed);
    } else if (actorToken.startsWith("repo:") || actorToken.startsWith("repo?")) {
      const parsed = RepoPermission.fromString(actorToken);
      if (parsed) actorRepo.push(parsed);
    } else if (actorToken.startsWith("rpc:") || actorToken.startsWith("rpc?")) {
      const parsed = RpcPermission.fromString(actorToken);
      if (parsed) actorRpc.push(parsed);
    } else if (actorToken.startsWith("space:") || actorToken.startsWith("space?")) {
      let parsed = SpacePermission.fromString(actorToken);
      if (parsed) {
        if (parsed.spaceType !== "*" && !parsed.hasCollections) {
          const declared = SPACE_DECLARED_COLLECTIONS[parsed.spaceType] ?? (["*"] as const);
          parsed = parsed.withDefaultCollections(declared);
        }
        if (parsed.isSelfAuthority) {
          parsed = parsed.withResolvedAuthority(groupDid as DidString);
        }
        actorSpace.push(parsed);
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
      const ok = actorIdentity.some((a) => (p.attr === "*" ? a.attr === "*" : a.attr === "*" || a.attr === p.attr));
      if (!ok) return false;
      continue;
    }

    if (token.startsWith("blob:") || token.startsWith("blob?")) {
      const p = BlobPermission.fromString(token);
      if (!p) return false;
      for (const accept of p.accept) {
        if (accept === "*/*") {
          if (!actorBlob.some((a) => a.accept.includes("*/*"))) return false;
        } else if (accept.endsWith("/*")) {
          if (!actorBlob.some((a) => a.accept.includes("*/*") || a.accept.includes(accept))) return false;
        } else {
          const baseWild = `${accept.split("/", 1)[0]}/*` as typeof accept;
          if (
            !actorBlob.some(
              (a) => a.accept.includes("*/*") || a.accept.includes(baseWild) || a.accept.includes(accept),
            )
          ) {
            return false;
          }
        }
      }
      continue;
    }

    if (token.startsWith("repo:") || token.startsWith("repo?")) {
      const p = RepoPermission.fromString(token);
      if (!p) return false;
      for (const col of p.collection) {
        for (const action of p.action) {
          if (col === "*") {
            if (!actorRepo.some((a) => a.action.includes(action) && a.collection.includes("*"))) {
              return false;
            }
          } else if (
            !actorRepo.some((a) => a.action.includes(action) && (a.collection.includes("*") || a.collection.includes(col)))
          ) {
            return false;
          }
        }
      }
      continue;
    }

    if (token.startsWith("rpc:") || token.startsWith("rpc?")) {
      const p = RpcPermission.fromString(token);
      if (!p) return false;
      for (const lxm of p.lxm) {
        const ok = actorRpc.some(
          (a) =>
            (p.aud === "*" ? a.aud === "*" : a.aud === "*" || a.aud === p.aud) &&
            (lxm === "*" ? a.lxm.includes("*") : a.lxm.includes("*") || a.lxm.includes(lxm)),
        );
        if (!ok) return false;
      }
      continue;
    }

    if (token.startsWith("space:") || token.startsWith("space?")) {
      let p = SpacePermission.fromString(token);
      if (!p) return false;
      if (p.spaceType !== "*" && !p.hasCollections) {
        const declared = SPACE_DECLARED_COLLECTIONS[p.spaceType] ?? (["*"] as const);
        p = p.withDefaultCollections(declared);
      }
      const pType = p.spaceType;
      const pAuth = p.authority === "self" ? (groupDid as DidString) : p.authority;
      const pSkey = p.skey;

      const targetCovered = (a: SpacePermission): boolean => {
        const aAuth = a.authority === "self" ? (groupDid as DidString) : a.authority;
        return (
          (pType === "*" ? a.spaceType === "*" : a.spaceType === "*" || a.spaceType === pType) &&
          (pAuth === "*" ? aAuth === "*" : aAuth === "*" || aAuth === pAuth) &&
          (pSkey === "*" ? a.skey === "*" : a.skey === "*" || a.skey === pSkey)
        );
      };

      if (p.manage) {
        for (const manage of p.manage) {
          if (!actorSpace.some((a) => targetCovered(a) && Boolean(a.manage?.includes(manage)))) {
            return false;
          }
        }
      }
      for (const action of p.action) {
        if (action === "read") {
          if (!actorSpace.some((a) => targetCovered(a) && a.action.includes("read"))) return false;
        } else if (action === "read_self") {
          if (
            !actorSpace.some(
              (a) => targetCovered(a) && (a.action.includes("read") || a.action.includes("read_self")),
            )
          ) {
            return false;
          }
        } else if (p.collection) {
          for (const col of p.collection) {
            const ok = actorSpace.some(
              (a) =>
                targetCovered(a) &&
                a.action.includes(action) &&
                Boolean(a.collection && (col === "*" ? a.collection.includes("*") : a.collection.includes("*") || a.collection.includes(col))),
            );
            if (!ok) return false;
          }
        }
      }
      continue;
    }

    return false;
  }
  return true;
}

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
    policy: GroupOpenSocialPolicy;
    prevPolicy?: GroupOpenSocialPolicy;
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
    for (const target of preState.roles.get(r)?.assignable ?? []) {
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
    const prevAssignable = new Set(prevRole?.assignable ?? []);
    for (const a of rw.role.assignable ?? []) {
      if (prevAssignable.has(a)) continue;
      if (a === "*" && !hasWildcard) {
        throw new ErrorCtor(403, "PrivilegeEscalation", "Only wildcard-assignable admins can grant assignable=['*'].");
      }
      if (a !== "*" && !hasWildcard && !assignable.has(a)) {
        throw new ErrorCtor(403, "PrivilegeEscalation", `Caller cannot grant assignable over '${a}'.`);
      }
    }
    if (rw.role.scopes && rw.role.scopes.length > 0) {
      const prevExpanded = prevRole?.scopes?.length
        ? new Set(expandGroupScopes(prevRole.scopes, groupDid as DidString).scopes)
        : new Set<string>();
      const nextExpanded = expandGroupScopes(rw.role.scopes, groupDid as DidString);
      const addedScopes = [...nextExpanded.scopes].filter((s) => !prevExpanded.has(s));
      if (addedScopes.length > 0) {
        const targetPerms = new ScopePermissions(addedScopes);
        if (!isPermissionSubsetLocal(targetPerms, actorPerms, groupDid)) {
          throw new ErrorCtor(403, "PrivilegeEscalation", `Role '${rw.rkey}' grants scopes exceeding caller's own permissions.`);
        }
      }
    }
  }

  if (params.policyWrite) {
    const pw = params.policyWrite;
    const spaceUri = pw.spaceUri ?? `at://${groupDid}/space/${pw.spaceType}/${pw.skey}`;
    const prevPolicy = pw.prevPolicy;
    const isEffAdmin = pw.isEffectiveAdmin ?? isEffectiveAdminMember(actorDid, preState, groupDid);
    const scopeTarget = { groupDid, spaceType: pw.spaceType, skey: pw.skey };

    const prevByRole = new Map<string, { read: boolean; write: boolean; canonicalScopes: string[] }>();
    for (const g of prevPolicy?.grants ?? []) {
      prevByRole.set(g.role, {
        read: Boolean(g.read),
        write: Boolean(g.write),
        canonicalScopes: canonicalizePolicyGrantScopes(g.scopes, scopeTarget),
      });
    }
    const nextByRole = new Map<string, { read: boolean; write: boolean; canonicalScopes: string[] }>();
    for (const g of pw.policy.grants ?? []) {
      nextByRole.set(g.role, {
        read: Boolean(g.read),
        write: Boolean(g.write),
        canonicalScopes: canonicalizePolicyGrantScopes(g.scopes, scopeTarget),
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
          if (!isPermissionSubsetLocal(candidatePerms, actorPerms, groupDid)) {
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
  OPENSOCIAL_COLLECTION,
  OPENSOCIAL_POLICY,
  OPENSOCIAL_SPACE_TYPE,
  parseAnySpaceRecordUri,
  parsePersonalInvitesUri,
  parseSpaceUri,
  personalInvitesUri,
  randomUUID,
  SELF_SKEY,
  workspaceUri,
};
