import {
  IncludeScope,
  isAtprotoOauthScope,
  normalizeAtprotoOauthScopeValue,
  RpcPermission,
  ScopePermissions,
  SpacePermission,
  type LexiconPermissionSet,
  type SpaceCollectionParam,
} from "@atproto/oauth-scopes";
import type { DidString, NsidString, RecordKeyString } from "@atproto/syntax";
import authManageGroupDoc from "../lexicons/group/opensocial/authManageGroup.json";
import authManageProfileDoc from "../lexicons/group/opensocial/authManageProfile.json";
import authModerateDoc from "../lexicons/group/opensocial/authModerate.json";
import authParticipateDoc from "../lexicons/group/opensocial/authParticipate.json";
import invitesSpaceDoc from "../lexicons/group/opensocial/invites.json";
import membersSpaceDoc from "../lexicons/group/opensocial/members.json";
import metaSpaceDoc from "../lexicons/group/opensocial/meta.json";
import appInboxSpaceDoc from "../lexicons/new/flock/app/inbox.json";
import channelSpaceDoc from "../lexicons/new/flock/channel.json";
import dmConversationSpaceDoc from "../lexicons/new/flock/dm/conversation.json";
import dmInboxSpaceDoc from "../lexicons/new/flock/dm/inbox.json";
import tasksSpaceDoc from "../lexicons/new/flock/ext/tasks.json";
import inboxSpaceDoc from "../lexicons/new/flock/inbox.json";
import flockMemberPermDoc from "../lexicons/new/flock/permissions/member.json";
import workspaceSpaceDoc from "../lexicons/new/flock/workspace.json";
import { groupMembersUri, isDid, parseSpaceUri } from "./keys";
import {
  ATPROTO_SPACE_COLLECTION,
  COLLECTION,
  FLOCK_PERMISSION_SET,
  OPENSOCIAL_COLLECTION,
  OPENSOCIAL_METHOD,
  OPENSOCIAL_PERMISSION_SET,
  OPENSOCIAL_SPACE_TYPE,
  OPERATOR_METHOD,
  REPO_COLLECTION,
  SPACE_TYPE,
} from "./nsids";

export type GroupRoleRecord = {
  displayName: string;
  description?: string;
  default?: boolean;
  scopes?: readonly string[];
  assignable?: readonly string[];
};

export type GroupMembershipRecord = {
  roles: readonly string[];
  createdAt: string;
  [key: string]: unknown;
};

export type GroupOpenSocialGrant = {
  role: string;
  read?: boolean;
  write?: boolean;
  scopes?: readonly string[];
};

export type GroupOpenSocialPolicy = {
  $type?: string;
  publicRead?: boolean;
  unlisted?: boolean;
  grants: readonly GroupOpenSocialGrant[];
};

export type EffectiveGovernanceState = {
  roles: ReadonlyMap<string, GroupRoleRecord>;
  memberships: ReadonlyMap<string, GroupMembershipRecord>;
  spacePolicies: ReadonlyMap<string, GroupOpenSocialPolicy>;
  knownAppSubjects?: ReadonlySet<string>;
};

export class InvalidScopeError extends Error {
  readonly status = 400;
  readonly code = "InvalidScope";

  constructor(message: string) {
    super(message);
    this.name = "InvalidScopeError";
  }
}

export class InvalidSpacePolicyScopeError extends Error {
  readonly status = 400;
  readonly code = "InvalidSpacePolicyScope";

  constructor(message: string) {
    super(message);
    this.name = "InvalidSpacePolicyScopeError";
  }
}

function extractPermissionSet(doc: { defs: { main: unknown } }): LexiconPermissionSet {
  return doc.defs.main as LexiconPermissionSet;
}

export const VENDORED_PERMISSION_SETS: Readonly<Record<string, LexiconPermissionSet>> = {
  [OPENSOCIAL_PERMISSION_SET.authParticipate]: extractPermissionSet(authParticipateDoc),
  [OPENSOCIAL_PERMISSION_SET.authManageProfile]: extractPermissionSet(authManageProfileDoc),
  [OPENSOCIAL_PERMISSION_SET.authModerate]: extractPermissionSet(authModerateDoc),
  [OPENSOCIAL_PERMISSION_SET.authManageGroup]: extractPermissionSet(authManageGroupDoc),
  [FLOCK_PERMISSION_SET.member]: extractPermissionSet(flockMemberPermDoc),
};

export const SPACE_DECLARED_COLLECTIONS: Readonly<Record<string, readonly SpaceCollectionParam[]>> = {
  [OPENSOCIAL_SPACE_TYPE.meta]: metaSpaceDoc.defs.main.collections as readonly SpaceCollectionParam[],
  [OPENSOCIAL_SPACE_TYPE.members]: membersSpaceDoc.defs.main.collections as readonly SpaceCollectionParam[],
  [OPENSOCIAL_SPACE_TYPE.invites]: invitesSpaceDoc.defs.main.collections as readonly SpaceCollectionParam[],
  [SPACE_TYPE.workspace]: workspaceSpaceDoc.defs.main.collections as readonly SpaceCollectionParam[],
  [SPACE_TYPE.inbox]: inboxSpaceDoc.defs.main.collections as readonly SpaceCollectionParam[],
  [SPACE_TYPE.channel]: channelSpaceDoc.defs.main.collections as readonly SpaceCollectionParam[],
  [SPACE_TYPE.appInbox]: appInboxSpaceDoc.defs.main.collections as readonly SpaceCollectionParam[],
  [SPACE_TYPE.tasks]: tasksSpaceDoc.defs.main.collections as readonly SpaceCollectionParam[],
  [SPACE_TYPE.dmInbox]: dmInboxSpaceDoc.defs.main.collections as readonly SpaceCollectionParam[],
  [SPACE_TYPE.dmConversation]: dmConversationSpaceDoc.defs.main.collections as readonly SpaceCollectionParam[],
};

// Personal-PDS DM permission set (unchanged on com.atproto.memberspace.policy).
export const DM_BROWSER_SCOPES: readonly string[] = [
  "atproto",
  `space:${SPACE_TYPE.dmInbox}?authority=*&collection=${COLLECTION.dmRequest}&action=create&action=update&action=delete`,
  `space:${SPACE_TYPE.dmInbox}?authority=self&action=read&manage=create&manage=update`,
  `repo:${REPO_COLLECTION.dmDeclaration}?action=create&action=update`,
  `space:${SPACE_TYPE.dmConversation}?authority=self&collection=${COLLECTION.dmHeader}&collection=${COLLECTION.dmMessage}&collection=${COLLECTION.dmReaction}&action=create&action=update&action=delete&manage=create&manage=update&manage=delete`,
  `space:${SPACE_TYPE.dmConversation}?authority=*&action=read`,
] as const;

/**
 * Exact spelled-out 1-for-1 expansion of `group.opensocial.authParticipate` for personal PDSes,
 * avoiding `include:group.opensocial.authParticipate` DNS permission-set resolution.
 */
export const OPEN_SOCIAL_PARTICIPATE_SCOPES: readonly string[] = [
  `space:${OPENSOCIAL_SPACE_TYPE.meta}?authority=*&skey=self&action=read`,
  `space:${OPENSOCIAL_SPACE_TYPE.members}?authority=*&skey=self&collection=${OPENSOCIAL_COLLECTION.acceptance}&action=read&action=create&action=update&action=delete`,
  `space:${OPENSOCIAL_SPACE_TYPE.invites}?authority=self&skey=self&action=read&manage=create`,
  `rpc?aud=*&lxm=${OPENSOCIAL_METHOD.cancelJoinRequest}&lxm=${OPENSOCIAL_METHOD.createReport}&lxm=${OPENSOCIAL_METHOD.leaveGroup}&lxm=${OPENSOCIAL_METHOD.requestJoin}`,
] as const;

/**
 * Personal-PDS scope allowing `com.atproto.space.listSpaces({ spaceType: "group.opensocial.members" })`
 * (pinned `@atproto/pds` asserts `skey: "*"` with `action: "read_self"` on `listSpaces`, whereas upstream
 * `group.opensocial.authParticipate` constrains `skey=self`; see `protocol-authors-feedback.md`).
 */
export const PERSONAL_PDS_LIST_GROUP_MEMBERS_SPACES_SCOPE =
  `space:${OPENSOCIAL_SPACE_TYPE.members}?authority=*&action=read_self` as const;

export const FLOCK_MEMBER_MODALITY_SPACE_SCOPES: readonly string[] = [
  `space:${SPACE_TYPE.workspace}?authority=*&skey=self&action=read`,
  `space:${SPACE_TYPE.inbox}?authority=*&skey=self&action=read`,
  `space:${SPACE_TYPE.inbox}?authority=*&skey=self&collection=${COLLECTION.joinRequest}&action=create&action=update&action=delete`,
  `space:${SPACE_TYPE.channel}?authority=*&action=read`,
  `space:${SPACE_TYPE.channel}?authority=*&collection=${COLLECTION.message}&collection=${COLLECTION.reaction}&action=create&action=update&action=delete`,
  `space:${SPACE_TYPE.tasks}?authority=*&action=read`,
  `space:${SPACE_TYPE.tasks}?authority=*&collection=${COLLECTION.taskProject}&collection=${COLLECTION.taskProjectEdit}&collection=${COLLECTION.task}&collection=${COLLECTION.taskEdit}&collection=${COLLECTION.taskComment}&action=create&action=update&action=delete`,
  `space:${SPACE_TYPE.appInbox}?authority=*&collection=${COLLECTION.appCommand}&collection=${COLLECTION.appAction}&action=create&action=delete`,
] as const;

export const OPERATOR_METHODS = Object.values(OPERATOR_METHOD);

/**
 * Operator RPC methods granted before `getDmNotifyTarget` / `getSpaceNotifyTarget` were added.
 * Older sessions remain admissible for reads and polling fallback without forcing sign-out.
 */
export const LEGACY_OPERATOR_METHODS = OPERATOR_METHODS.filter(
  (method) => method !== OPERATOR_METHOD.getDmNotifyTarget && method !== OPERATOR_METHOD.getSpaceNotifyTarget,
);

/**
 * Browser personal-PDS OAuth grant: DM scopes + OpenSocial participation scopes + Flock modality scopes + Operator RPC methods.
 */
export function memberGrantScopes(serviceRef: string): string[] {
  return memberScopesFor(OPERATOR_METHODS, serviceRef);
}

export function legacyMemberGrantScopes(serviceRef: string): string[] {
  return memberScopesFor(LEGACY_OPERATOR_METHODS, serviceRef);
}

function memberScopesFor(operatorMethods: readonly string[], serviceRef: string): string[] {
  return [
    ...DM_BROWSER_SCOPES,
    ...OPEN_SOCIAL_PARTICIPATE_SCOPES,
    PERSONAL_PDS_LIST_GROUP_MEMBERS_SPACES_SCOPE,
    ...FLOCK_MEMBER_MODALITY_SPACE_SCOPES,
    operatorMethodsScope(operatorMethods, serviceRef),
  ];
}

export function operatorMethodsScope(methods: readonly string[], serviceRef: string): string {
  const audience = serviceRef.replaceAll("%", "%25").replace("#", "%23");
  return `rpc?${methods.map((method) => `lxm=${method}`).join("&")}&aud=${audience}`;
}

/**
 * Personal-PDS OAuth grant for installed bot/app accounts:
 * reads OpenSocial `meta/self` + `members/self` and Flock `workspace/self`, `channel/*`, `app.inbox/*`,
 * writes channel messages/reactions and public `app.declaration`, and polls `operator.getChanges`.
 */
export function appGrantScopes(serviceRef: string): string[] {
  return [
    "atproto",
    `repo:${REPO_COLLECTION.appDeclaration}?action=create&action=update`,
    `space:${OPENSOCIAL_SPACE_TYPE.meta}?authority=*&skey=self&action=read`,
    PERSONAL_PDS_LIST_GROUP_MEMBERS_SPACES_SCOPE,
    `space:${OPENSOCIAL_SPACE_TYPE.members}?authority=*&skey=self&action=read`,
    `space:${SPACE_TYPE.workspace}?authority=*&skey=self&action=read`,
    `space:${SPACE_TYPE.channel}?authority=*&action=read`,
    `space:${SPACE_TYPE.channel}?authority=*&collection=${COLLECTION.message}&collection=${COLLECTION.reaction}&action=create&action=update&action=delete`,
    `space:${SPACE_TYPE.appInbox}?authority=*&action=read`,
    operatorMethodsScope([OPERATOR_METHOD.getChanges], serviceRef),
  ];
}

/**
 * Group-DID admin OAuth scopes. Never emits invalid `aud=self`; appends concrete
 * `rpc:*?aud=<groupDid>%23atproto_pds` only when `groupDid` is known (e.g. in `role/admin`).
 */
export function groupAdminScopes(groupDid?: string): string[] {
  return [
    "atproto",
    `include:${OPENSOCIAL_PERMISSION_SET.authManageGroup}`,
    "repo:*",
    "blob:*/*",
    "identity:*",
    "account:repo?action=manage",
    "account:status?action=manage",
    "space:*?authority=*&action=read_self",
    "space:*?collection=*&action=read&action=create&action=update&action=delete&manage=create&manage=update&manage=delete",
    ...(groupDid
      ? [RpcPermission.scopeNeededFor({ aud: `${groupDid}#atproto_pds` as `${DidString}#${string}`, lxm: "*" as NsidString })]
      : []),
    "rpc?aud=*&lxm=com.atproto.server.createAccount&lxm=group.opensocial.abortMigration&lxm=com.atproto.space.notifyCredentialsRevoked&lxm=com.atproto.space.notifyRepoUpdate",
  ];
}

/** Group-DID moderator OAuth scopes (`role/moderator` and moderator browser sessions). */
export function groupModeratorScopes(): string[] {
  return [
    "atproto",
    `include:${OPENSOCIAL_PERMISSION_SET.authModerate}`,
    `space:*?collection=${ATPROTO_SPACE_COLLECTION.label}&action=read&action=create&action=update&action=delete`,
  ];
}

/** Group-DID profile-editor OAuth scopes. */
export function groupProfileEditorScopes(): string[] {
  return [
    "atproto",
    `include:${OPENSOCIAL_PERMISSION_SET.authManageProfile}`,
  ];
}

function expandRawIncludeTokens(rawScopes: readonly string[], onInvalid: (msg: string) => never): string[] {
  const expanded: string[] = [];
  for (const raw of rawScopes) {
    if (typeof raw !== "string" || raw.trim().length === 0) {
      onInvalid("Scope token must be a non-empty string.");
    }
    if (raw.startsWith("include:")) {
      const inc = IncludeScope.fromString(raw);
      if (!inc) {
        onInvalid(`Malformed include scope: ${raw}`);
      }
      const permSet = Object.hasOwn(VENDORED_PERMISSION_SETS, inc.nsid)
        ? VENDORED_PERMISSION_SETS[inc.nsid]
        : undefined;
      if (!permSet) {
        onInvalid(`Unknown permission-set NSID in include scope: ${inc.nsid}`);
      }
      const scopes = inc.toScopes(permSet!);
      if (scopes.length === 0) {
        onInvalid(`Permission set ${inc.nsid} expanded to zero valid scopes.`);
      }
      expanded.push(...scopes);
    } else {
      expanded.push(raw);
    }
  }
  return expanded;
}

/**
 * Expands `include:` tokens against `VENDORED_PERMISSION_SETS`, resolves `authority=self` to `groupDid`
 * (when supplied) and materializes space default collections on bare `space:<type>` grants, returning a
 * `ScopePermissions` matcher with zero dropped tokens.
 */
export function expandGroupScopes(rawScopes: readonly string[], groupDid?: string): ScopePermissions {
  if (groupDid !== undefined && !isDid(groupDid)) {
    throw new InvalidScopeError(`Invalid group DID for scope resolution: ${groupDid}`);
  }
  const tokens = expandRawIncludeTokens(rawScopes, (msg) => {
    throw new InvalidScopeError(msg);
  });
  const normalized: string[] = [];
  for (const token of tokens) {
    if (!isAtprotoOauthScope(token)) {
      throw new InvalidScopeError(`Invalid ATProto OAuth scope syntax: ${token}`);
    }
    if (token.startsWith("space:")) {
      let sp = SpacePermission.fromString(token);
      if (!sp) {
        throw new InvalidScopeError(`Invalid space permission syntax: ${token}`);
      }
      if (sp.spaceType !== "*" && !sp.hasCollections) {
        const declared = SPACE_DECLARED_COLLECTIONS[sp.spaceType] ?? (["*"] as const);
        sp = sp.withDefaultCollections(declared);
      }
      if (groupDid !== undefined && sp.isSelfAuthority) {
        sp = sp.withResolvedAuthority(groupDid as DidString);
      }
      normalized.push(sp.toString());
    } else {
      const norm = normalizeAtprotoOauthScopeValue(token);
      if (!norm) {
        throw new InvalidScopeError(`Could not normalize scope token: ${token}`);
      }
      normalized.push(norm);
    }
  }
  return new ScopePermissions(normalized);
}

/**
 * Validates and clamps `group.opensocial.policy` `grant.scopes` entries to concrete `(spaceType, groupDid, skey)`.
 * Rejects non-`space:` permissions, `manage=create`, or cross-space `(spaceType, authority, skey)` targets with
 * `InvalidSpacePolicyScopeError` (`400 InvalidSpacePolicyScope`), ensuring policy grants never leak across spaces.
 */
export function expandPolicyGrantScopes(
  rawScopes: readonly string[],
  target: { groupDid: string; spaceType: string; skey: string },
): SpacePermission[] {
  if (!isDid(target.groupDid)) {
    throw new InvalidSpacePolicyScopeError(`Invalid group DID: ${target.groupDid}`);
  }
  const tokens = expandRawIncludeTokens(rawScopes, (msg) => {
    throw new InvalidSpacePolicyScopeError(msg);
  });
  const clamped: SpacePermission[] = [];
  for (const token of tokens) {
    if (!token.startsWith("space:")) {
      throw new InvalidSpacePolicyScopeError(
        `Space policy grant scopes may only contain space: permissions (got ${token}).`,
      );
    }
    const sp = SpacePermission.fromString(token);
    if (!sp) {
      throw new InvalidSpacePolicyScopeError(`Malformed space permission in policy grant: ${token}`);
    }
    if (sp.manage?.includes("create")) {
      throw new InvalidSpacePolicyScopeError(
        `Space policy grant scopes cannot include manage=create (${token}).`,
      );
    }
    if (sp.spaceType !== "*" && sp.spaceType !== target.spaceType) {
      throw new InvalidSpacePolicyScopeError(
        `Space policy grant targets ${sp.spaceType}, expected ${target.spaceType}.`,
      );
    }
    if (sp.authority !== "*" && sp.authority !== "self" && sp.authority !== target.groupDid) {
      throw new InvalidSpacePolicyScopeError(
        `Space policy grant targets authority ${sp.authority}, expected ${target.groupDid}.`,
      );
    }
    if (sp.skey !== "*" && sp.skey !== target.skey) {
      throw new InvalidSpacePolicyScopeError(
        `Space policy grant targets skey ${sp.skey}, expected ${target.skey}.`,
      );
    }
    const declaredCols = SPACE_DECLARED_COLLECTIONS[target.spaceType] ?? (["*"] as const);
    const pinned = new SpacePermission(
      target.spaceType as NsidString,
      target.groupDid as DidString,
      target.skey as RecordKeyString,
      sp.collection,
      sp.action,
      sp.manage,
    ).withDefaultCollections(declaredCols);
    clamped.push(pinned);
  }
  return clamped;
}

/**
 * Single canonical effective permission union for a member acting as `groupDid`:
 * unions `expandGroupScopes` across all assigned `role.scopes` PLUS `expandPolicyGrantScopes`
 * across every non-deleted space's `policy.grants` matching `membership.roles`.
 */
export function effectiveMemberPermissions(
  state: EffectiveGovernanceState,
  groupDid: string,
  memberDid: string,
): ScopePermissions {
  if (!isDid(groupDid) || !isDid(memberDid)) {
    return new ScopePermissions([]);
  }
  // Implicit self-membership of `<groupDid>` (e.g. sovereign controller-session).
  if (memberDid === groupDid) {
    return expandGroupScopes(groupAdminScopes(groupDid), groupDid);
  }
  const membership = state.memberships.get(memberDid);
  if (!membership || !Array.isArray(membership.roles) || membership.roles.length === 0) {
    return new ScopePermissions([]);
  }
  const assignedRoles = new Set(membership.roles);
  const rawRoleScopes: string[] = [];
  for (const roleKey of assignedRoles) {
    const role = state.roles.get(roleKey);
    if (role?.scopes) {
      rawRoleScopes.push(...role.scopes);
    }
  }
  const rolePerms = expandGroupScopes(rawRoleScopes, groupDid);
  const unionTokens = new Set<string>(rolePerms.scopes);

  for (const [rawSpaceUri, policy] of state.spacePolicies.entries()) {
    const parsed = parseSpaceUri(rawSpaceUri);
    if (!parsed || parsed.authorityDid !== groupDid) continue;
    for (const grant of policy.grants ?? []) {
      if (!assignedRoles.has(grant.role) || !grant.scopes || grant.scopes.length === 0) continue;
      const clamped = expandPolicyGrantScopes(grant.scopes, {
        groupDid,
        spaceType: parsed.type,
        skey: parsed.skey,
      });
      for (const perm of clamped) {
        unionTokens.add(perm.toString());
      }
    }
  }

  return new ScopePermissions(unionTokens);
}

/**
 * Canonical check whether `memberDid` holds full effective administrative governance over `groupDid`.
 */
export function isEffectiveAdminMember(
  memberDid: string,
  state: EffectiveGovernanceState,
  groupDid: string,
): boolean {
  const membership = state.memberships.get(memberDid);
  if (!membership || !Array.isArray(membership.roles) || membership.roles.length === 0) {
    return false;
  }
  const assignedRoles = new Set(membership.roles);
  let hasWildcardAssignable = false;
  for (const roleKey of assignedRoles) {
    const role = state.roles.get(roleKey);
    if (role?.assignable?.includes("*")) {
      hasWildcardAssignable = true;
      break;
    }
  }
  if (!hasWildcardAssignable) return false;

  const membersUri = groupMembersUri(groupDid);
  const membersPolicy = state.spacePolicies.get(membersUri);
  const hasMembersReadWrite = Boolean(
    membersPolicy?.grants?.some(
      (grant) => assignedRoles.has(grant.role) && grant.read === true && grant.write === true,
    ),
  );
  if (!hasMembersReadWrite) return false;

  const perms = effectiveMemberPermissions(state, groupDid, memberDid);
  const membersTarget = {
    spaceDid: groupDid as DidString,
    spaceType: OPENSOCIAL_SPACE_TYPE.members as NsidString,
    skey: "self" as RecordKeyString,
  };
  const metaTarget = {
    spaceDid: groupDid as DidString,
    spaceType: OPENSOCIAL_SPACE_TYPE.meta as NsidString,
    skey: "self" as RecordKeyString,
  };
  const wildcardTarget = {
    spaceType: "*" as const,
    authority: groupDid as DidString,
    skey: "*" as const,
  };

  if (!perms.allowsSpace(membersTarget, { action: "read" })) return false;
  if (!perms.allowsSpace(membersTarget, { manage: "update" })) return false;
  for (const col of [OPENSOCIAL_COLLECTION.role, OPENSOCIAL_COLLECTION.membership] as const) {
    for (const action of ["create", "update", "delete"] as const) {
      if (!perms.allowsSpace(membersTarget, { action, collection: col as NsidString })) return false;
    }
  }

  if (!perms.allowsSpace(metaTarget, { action: "read" })) return false;
  if (!perms.allowsSpace(metaTarget, { manage: "update" })) return false;
  for (const col of [
    OPENSOCIAL_COLLECTION.profile,
    OPENSOCIAL_COLLECTION.rule,
    OPENSOCIAL_COLLECTION.labeler,
  ] as const) {
    for (const action of ["create", "update", "delete"] as const) {
      if (!perms.allowsSpace(metaTarget, { action, collection: col as NsidString })) return false;
    }
  }

  for (const manage of ["create", "update", "delete"] as const) {
    if (!perms.allowsSpace(wildcardTarget, { manage })) return false;
  }

  if (!perms.allowsIdentity({ attr: "*" })) return false;
  if (!perms.allowsAccount({ attr: "repo", action: "manage" })) return false;
  if (!perms.allowsAccount({ attr: "status", action: "manage" })) return false;

  return true;
}

export function effectiveAdmins(state: EffectiveGovernanceState, groupDid: string): string[] {
  const admins: string[] = [];
  for (const memberDid of state.memberships.keys()) {
    if (isEffectiveAdminMember(memberDid, state, groupDid)) {
      admins.push(memberDid);
    }
  }
  return admins.sort();
}

export function effectiveHumanAdmins(state: EffectiveGovernanceState, groupDid: string): string[] {
  const apps = state.knownAppSubjects;
  return effectiveAdmins(state, groupDid).filter(
    (did) => did !== groupDid && !(apps?.has(did)),
  );
}

/**
 * Checks whether `memberDid` holds effective moderation capability (in-space label CRUD + moderation RPCs).
 */
export function isEffectiveModeratorMember(
  memberDid: string,
  state: EffectiveGovernanceState,
  groupDid: string,
): boolean {
  if (memberDid === groupDid) return true;
  const membership = state.memberships.get(memberDid);
  if (!membership || membership.roles.length === 0) return false;
  const perms = effectiveMemberPermissions(state, groupDid, memberDid);
  const metaTarget = {
    spaceDid: groupDid as DidString,
    spaceType: OPENSOCIAL_SPACE_TYPE.meta as NsidString,
    skey: "self" as RecordKeyString,
  };
  const groupAud = `${groupDid}#atproto_pds` as const;
  return (
    perms.allowsSpace(metaTarget, {
      action: "create",
      collection: ATPROTO_SPACE_COLLECTION.label as NsidString,
    }) &&
    perms.allowsRpc({
      aud: groupAud,
      lxm: OPENSOCIAL_METHOD.listModSubjects as NsidString,
    }) &&
    perms.allowsRpc({
      aud: groupAud,
      lxm: OPENSOCIAL_METHOD.resolveModSubject as NsidString,
    })
  );
}

export function permissionsAllowSpace(
  perms: ScopePermissions,
  target: { spaceDid: string; spaceType: string; skey: string },
  op:
    | { action: "read" | "read_self" }
    | { action: "create" | "update" | "delete"; collection: string }
    | { manage: "create" | "update" | "delete" },
): boolean {
  return perms.allowsSpace(
    {
      spaceDid: target.spaceDid as DidString,
      spaceType: target.spaceType as NsidString,
      skey: target.skey as RecordKeyString,
    },
    op as Parameters<ScopePermissions["allowsSpace"]>[1],
  );
}

export function permissionsAllowRpc(
  perms: ScopePermissions,
  aud: string,
  lxm: string,
): boolean {
  return perms.allowsRpc({
    aud: (aud.includes("#") ? aud : `${aud}#atproto_pds`) as `${DidString}#${string}`,
    lxm: lxm as NsidString,
  });
}

