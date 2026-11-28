import {
  AccountPermission,
  BlobPermission,
  IdentityPermission,
  IncludeScope,
  isAtprotoOauthScope,
  normalizeAtprotoOauthScopeValue,
  RepoPermission,
  RpcPermission,
  ScopePermissions,
  SpacePermission,
  type LexiconPermissionSet,
  type SpaceCollectionParam,
} from "@atproto/oauth-scopes";
import type { DidString, NsidString, RecordKeyString } from "@atproto/syntax";
import authManageAdminDoc from "../lexicons/org/atgrp/authManageAdmin.json";
import authManageBasicDoc from "../lexicons/org/atgrp/authManageBasic.json";
import authManageMembersDoc from "../lexicons/org/atgrp/authManageMembers.json";
import authModerateDoc from "../lexicons/org/atgrp/authModerate.json";
import authParticipateDoc from "../lexicons/org/atgrp/authParticipate.json";
import inboxSpaceDoc from "../lexicons/org/atgrp/inbox.json";
import membersSpaceDoc from "../lexicons/org/atgrp/members.json";
import metaSpaceDoc from "../lexicons/org/atgrp/meta.json";
import appInboxSpaceDoc from "../lexicons/new/flock/app/inbox.json";
import channelSpaceDoc from "../lexicons/new/flock/channel.json";
import dmConversationSpaceDoc from "../lexicons/new/flock/dm/conversation.json";
import dmInboxSpaceDoc from "../lexicons/new/flock/dm/inbox.json";
import tasksSpaceDoc from "../lexicons/new/flock/ext/tasks.json";
import flockInboxSpaceDoc from "../lexicons/new/flock/inbox.json";
import flockMemberPermDoc from "../lexicons/new/flock/permissions/member.json";
import workspaceSpaceDoc from "../lexicons/new/flock/workspace.json";
import { groupMembersUri, isDid, parseSpaceUri } from "./keys";
import {
  ATGRP_COLLECTION,
  ATGRP_METHOD,
  ATGRP_PERMISSION_SET,
  ATGRP_SPACE_TYPE,
  ATPROTO_SPACE_COLLECTION,
  COLLECTION,
  FLOCK_GROUP_METHOD,
  FLOCK_PERMISSION_SET,
  OPERATOR_METHOD,
  REPO_COLLECTION,
  SPACE_TYPE,
} from "./nsids";

export type GroupRoleRecord = {
  displayName?: string;
  description?: string;
  default?: boolean;
  permissions?: readonly string[];
  canAssign?: readonly string[];
};

export type GroupMembershipRecord = {
  roles: readonly string[];
  createdAt: string;
  [key: string]: unknown;
};

export type GroupAtgrpGrant = {
  role: string;
  read?: boolean;
  write?: boolean;
  permissions?: readonly string[];
};

export type GroupAtgrpPolicy = {
  $type?: string;
  publicRead?: boolean;
  unlisted?: boolean;
  grants: readonly GroupAtgrpGrant[];
};

export type EffectiveGovernanceState = {
  roles: ReadonlyMap<string, GroupRoleRecord>;
  memberships: ReadonlyMap<string, GroupMembershipRecord>;
  spacePolicies: ReadonlyMap<string, GroupAtgrpPolicy>;
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

export class UnauthorizedScopeError extends Error {
  readonly status = 403;
  readonly code = "access_denied";

  constructor(message: string) {
    super(message);
    this.name = "UnauthorizedScopeError";
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

/** Hard ceiling on issued OAuth scope tokens after include-set narrowing and absorption. */
export const MAX_ISSUED_SCOPE_TOKENS = 200;

function extractPermissionSet(doc: { defs: { main: unknown } }): LexiconPermissionSet {
  return doc.defs.main as LexiconPermissionSet;
}

export const VENDORED_PERMISSION_SETS: Readonly<Record<string, LexiconPermissionSet>> = {
  [ATGRP_PERMISSION_SET.authParticipate]: extractPermissionSet(authParticipateDoc),
  [ATGRP_PERMISSION_SET.authManageBasic]: extractPermissionSet(authManageBasicDoc),
  [ATGRP_PERMISSION_SET.authManageMembers]: extractPermissionSet(authManageMembersDoc),
  [ATGRP_PERMISSION_SET.authModerate]: extractPermissionSet(authModerateDoc),
  [ATGRP_PERMISSION_SET.authManageAdmin]: extractPermissionSet(authManageAdminDoc),
  [FLOCK_PERMISSION_SET.member]: extractPermissionSet(flockMemberPermDoc),
};

/**
 * Default record collections materialized for bare `space:<type>` permissions.
 * Excludes `com.atproto.space.policy` on `org.atgrp.{meta,members}` because hosts reject direct
 * policy record writes (`updateSpace` manages policies).
 */
function writableSpaceCollections(collections: readonly string[]): readonly SpaceCollectionParam[] {
  return collections.filter(
    (col) => col !== ATPROTO_SPACE_COLLECTION.spacePolicy,
  ) as readonly SpaceCollectionParam[];
}

export const SPACE_DECLARED_COLLECTIONS: Readonly<Record<string, readonly SpaceCollectionParam[]>> = {
  [ATGRP_SPACE_TYPE.meta]: writableSpaceCollections(metaSpaceDoc.defs.main.collections),
  [ATGRP_SPACE_TYPE.members]: writableSpaceCollections(membersSpaceDoc.defs.main.collections),
  [ATGRP_SPACE_TYPE.inbox]: inboxSpaceDoc.defs.main.collections as readonly SpaceCollectionParam[],
  [SPACE_TYPE.workspace]: workspaceSpaceDoc.defs.main.collections as readonly SpaceCollectionParam[],
  [SPACE_TYPE.inbox]: flockInboxSpaceDoc.defs.main.collections as readonly SpaceCollectionParam[],
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
 * Exact spelled-out 1-for-1 expansion of `org.atgrp.authParticipate` for personal PDSes,
 * avoiding `include:org.atgrp.authParticipate` DNS permission-set resolution.
 */
export const ATGRP_PARTICIPATE_SCOPES: readonly string[] = [
  `space:${ATGRP_SPACE_TYPE.meta}?authority=*&skey=self&action=read`,
  `space:${ATGRP_SPACE_TYPE.members}?authority=*&skey=self&collection=${ATGRP_COLLECTION.confirmation}&action=read&action=create&action=update&action=delete`,
  `space:${ATGRP_SPACE_TYPE.inbox}?authority=self&skey=self&action=read&manage=create`,
  `rpc?aud=*&lxm=${ATGRP_METHOD.cancelJoinRequest}&lxm=${ATGRP_METHOD.leaveGroup}&lxm=${ATGRP_METHOD.modQuerySelfHistory}&lxm=${ATGRP_METHOD.modSubmitAppeal}&lxm=${ATGRP_METHOD.modSubmitReport}&lxm=${ATGRP_METHOD.requestJoin}`,
] as const;

/**
 * Personal-PDS scope allowing `com.atproto.space.listSpaces({ spaceType: "org.atgrp.members" })`
 * (pinned `@atproto/pds` asserts `skey: "*"` with `action: "read_self"` on `listSpaces`, whereas upstream
 * `org.atgrp.authParticipate` constrains `skey=self`; see `protocol-authors-feedback.md`).
 */
export const PERSONAL_PDS_LIST_GROUP_MEMBERS_SPACES_SCOPE =
  `space:${ATGRP_SPACE_TYPE.members}?authority=*&action=read_self` as const;

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

/**
 * Least-privilege Flock modality space scopes for Flock Desk v1:
 * workspace/self read, channel read, and channel message create/update/delete only.
 * Explicitly omits Operator RPCs, legacy inbox joinRequest, reactions, tasks, appInbox, and DMs.
 */
export const DESK_MODALITY_SCOPES: readonly string[] = [
  `space:${SPACE_TYPE.workspace}?authority=*&skey=self&action=read`,
  `space:${SPACE_TYPE.channel}?authority=*&action=read`,
  `space:${SPACE_TYPE.channel}?authority=*&collection=${COLLECTION.message}&action=create&action=update&action=delete`,
] as const;

/**
 * Least-privilege Operator-free personal-PDS OAuth scopes for Flock Desk v1.
 */
export function deskMemberScopes(): string[] {
  return [
    "atproto",
    ...ATGRP_PARTICIPATE_SCOPES,
    PERSONAL_PDS_LIST_GROUP_MEMBERS_SPACES_SCOPE,
    ...DESK_MODALITY_SCOPES,
  ];
}

export const OPERATOR_METHODS = Object.values(OPERATOR_METHOD);

/**
 * Operator RPC methods granted before `getDmNotifyTarget` / `getSpaceNotifyTarget` were added.
 * Older sessions remain admissible for reads and polling fallback without forcing sign-out.
 */
export const LEGACY_OPERATOR_METHODS = OPERATOR_METHODS.filter(
  (method) => method !== OPERATOR_METHOD.getDmNotifyTarget && method !== OPERATOR_METHOD.getSpaceNotifyTarget,
);

/**
 * Browser personal-PDS OAuth grant: DM scopes + Atmosphere Groups participation scopes + Flock modality scopes + Operator RPC methods.
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
    ...ATGRP_PARTICIPATE_SCOPES,
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
 * reads Atmosphere Groups `meta/self` + `members/self` and Flock `workspace/self`, `channel/*`, `app.inbox/*`,
 * writes channel messages/reactions and public `app.declaration`, and polls `operator.getChanges`.
 */
export function appGrantScopes(serviceRef: string): string[] {
  return [
    "atproto",
    `repo:${REPO_COLLECTION.appDeclaration}?action=create&action=update`,
    `space:${ATGRP_SPACE_TYPE.meta}?authority=*&skey=self&action=read`,
    PERSONAL_PDS_LIST_GROUP_MEMBERS_SPACES_SCOPE,
    `space:${ATGRP_SPACE_TYPE.members}?authority=*&skey=self&action=read`,
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
    `include:${ATGRP_PERMISSION_SET.authManageAdmin}`,
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
    `rpc?aud=*&lxm=com.atproto.server.createAccount&lxm=${FLOCK_GROUP_METHOD.abortMigration}&lxm=com.atproto.space.notifyCredentialsRevoked&lxm=com.atproto.space.notifyRepoUpdate`,
  ];
}

/**
 * Group-DID moderator OAuth scopes (`role/moderator` and moderator browser sessions).
 * Wildcard label grant is intentionally write-only (`create`/`update`/`delete`, no `action=read`)
 * because `@atproto/oauth-scopes` ignores `collection` on `action=read` — adding `read` on `space:*`
 * would expose private modality spaces. `authModerate` already grants `read` on `meta/self` and `members/self`.
 */
export function groupModeratorScopes(): string[] {
  return [
    "atproto",
    `include:${ATGRP_PERMISSION_SET.authModerate}`,
    `space:*?collection=${ATPROTO_SPACE_COLLECTION.label}&action=create&action=update&action=delete`,
  ];
}

/** Group-DID member-manager OAuth scopes (`authManageMembers`: memberships, invites, join requests). */
export function groupMembersManagerScopes(): string[] {
  return [
    "atproto",
    `include:${ATGRP_PERMISSION_SET.authManageMembers}`,
  ];
}

/** Group-DID basic-editor OAuth scopes (`authManageBasic`: group `about` and `rule` records). */
export function groupBasicEditorScopes(): string[] {
  return [
    "atproto",
    `include:${ATGRP_PERMISSION_SET.authManageBasic}`,
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

function normalizeScopeToken(token: string, groupDid: string | undefined, onInvalid: (msg: string) => never): string {
  if (!isAtprotoOauthScope(token)) {
    onInvalid(`Invalid ATProto OAuth scope syntax: ${token}`);
  }
  if (token.startsWith("space:")) {
    let sp = SpacePermission.fromString(token);
    if (!sp) {
      onInvalid(`Invalid space permission syntax: ${token}`);
    }
    if (sp.spaceType !== "*" && !sp.hasCollections) {
      const declared = SPACE_DECLARED_COLLECTIONS[sp.spaceType] ?? (["*"] as const);
      sp = sp.withDefaultCollections(declared);
    }
    if (groupDid !== undefined && sp.isSelfAuthority) {
      sp = sp.withResolvedAuthority(groupDid as DidString);
    }
    return sp.toString();
  }
  const norm = normalizeAtprotoOauthScopeValue(token);
  if (!norm) {
    onInvalid(`Could not normalize scope token: ${token}`);
  }
  return norm;
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
  const normalized = tokens.map((token) =>
    normalizeScopeToken(token, groupDid, (msg) => {
      throw new InvalidScopeError(msg);
    }),
  );
  return new ScopePermissions(normalized);
}

/**
 * Validates and clamps `org.atgrp.policy` `grant.permissions` entries to concrete `(spaceType, groupDid, skey)`.
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
        `Space policy grant permissions may only contain space: permissions (got ${token}).`,
      );
    }
    const sp = SpacePermission.fromString(token);
    if (!sp) {
      throw new InvalidSpacePolicyScopeError(`Malformed space permission in policy grant: ${token}`);
    }
    if (sp.manage?.includes("create")) {
      throw new InvalidSpacePolicyScopeError(
        `Space policy grant permissions cannot include manage=create (${token}).`,
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
 * Checks whether every permission in `candidatePerms` is covered by `actorPerms` for `groupDid`.
 * Shared across RBAC anti-escalation, OAuth include-set narrowing, and live session enforcement.
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

/**
 * Splits a single normalized permission token originating from an `include:` permission set
 * into atomic units so each individual `(space, collection, action)`, `(space, manage)`,
 * or `(rpc, aud, lxm)` entry can be filtered cleanly against `actorPerms`.
 */
function atomizeIncludePermission(normalizedToken: string, groupDid: string): string[] {
  if (normalizedToken === "atproto") return ["atproto"];
  if (normalizedToken.startsWith("space:") || normalizedToken.startsWith("space?")) {
    const sp = SpacePermission.fromString(normalizedToken);
    if (!sp) return [normalizedToken];
    const resolved = sp.isSelfAuthority ? sp.withResolvedAuthority(groupDid as DidString) : sp;
    const atoms: string[] = [];
    if (resolved.manage) {
      for (const manage of resolved.manage) {
        const manageOnly = SpacePermission.fromString(
          `space:${resolved.spaceType}?authority=${resolved.authority}&skey=${resolved.skey}&manage=${manage}`,
        );
        if (manageOnly) atoms.push(manageOnly.toString());
      }
    }
    for (const action of resolved.action) {
      if (action === "read" || action === "read_self") {
        atoms.push(
          new SpacePermission(
            resolved.spaceType,
            resolved.authority,
            resolved.skey,
            undefined,
            [action],
            undefined,
          ).toString(),
        );
      } else if (resolved.collection && resolved.collection.length > 0) {
        for (const col of resolved.collection) {
          atoms.push(
            new SpacePermission(
              resolved.spaceType,
              resolved.authority,
              resolved.skey,
              [col],
              [action],
              undefined,
            ).toString(),
          );
        }
      }
    }
    return atoms;
  }
  if (normalizedToken.startsWith("rpc:") || normalizedToken.startsWith("rpc?")) {
    const rp = RpcPermission.fromString(normalizedToken);
    if (!rp) return [normalizedToken];
    return rp.lxm.map((lxm) => new RpcPermission(rp.aud, [lxm]).toString());
  }
  if (normalizedToken.startsWith("repo:") || normalizedToken.startsWith("repo?")) {
    const rp = RepoPermission.fromString(normalizedToken);
    if (!rp) return [normalizedToken];
    const atoms: string[] = [];
    for (const col of rp.collection) {
      for (const action of rp.action) {
        atoms.push(new RepoPermission([col], [action]).toString());
      }
    }
    return atoms;
  }
  return [normalizedToken];
}

/**
 * Resolves a requested OAuth scope string/token list against an authorizer's live `actorPerms`:
 * - `include:` permission sets act as upper bounds (Atmosphere Groups spec §Permission sets):
 *   each expanded atomic permission is retained iff covered by `actorPerms`.
 * - Explicit (non-`include:`) permissions must each be covered by `actorPerms`, otherwise
 *   `UnauthorizedScopeError` (`403 access_denied`) is thrown (spec §Writing as the Group Account).
 * - Explicit `atproto`-only requests succeed for eligible members; requests containing
 *   non-`atproto` permissions that narrow to zero effective permissions throw `403 access_denied`.
 * - Redundant tokens subsumed by other retained tokens are absorbed, and issued token count is
 *   capped at `MAX_ISSUED_SCOPE_TOKENS`.
 */
export function resolveAuthorizedGroupScope(
  requestedTokens: readonly string[],
  actorPerms: ScopePermissions,
  groupDid: string,
  options: { ceilingPerms?: ScopePermissions } = {},
): { scope: string; tokens: string[]; permissions: ScopePermissions } {
  if (!isDid(groupDid)) {
    throw new InvalidScopeError(`Invalid group DID for scope resolution: ${groupDid}`);
  }
  const effectiveCeiling = options.ceilingPerms;
  const isAllowed = (candidate: ScopePermissions): boolean =>
    isPermissionSubset(candidate, actorPerms, groupDid) &&
    (!effectiveCeiling || isPermissionSubset(candidate, effectiveCeiling, groupDid));

  let hasAtproto = false;
  let requestedNonAtproto = false;
  const retained: string[] = [];

  for (const raw of requestedTokens) {
    if (typeof raw !== "string" || raw.trim().length === 0) {
      throw new InvalidScopeError("Scope token must be a non-empty string.");
    }
    if (raw === "atproto") {
      hasAtproto = true;
      continue;
    }
    requestedNonAtproto = true;

    if (raw.startsWith("include:")) {
      const expandedRaw = expandRawIncludeTokens([raw], (msg) => {
        throw new InvalidScopeError(msg);
      });
      const normalizedSet = expandedRaw.map((t) =>
        normalizeScopeToken(t, groupDid, (msg) => {
          throw new InvalidScopeError(msg);
        }),
      );
      // Fast path: if the entire expanded permission set is already allowed, retain its normalized entries compactly.
      if (isAllowed(new ScopePermissions(normalizedSet))) {
        retained.push(...normalizedSet);
      } else {
        for (const normToken of normalizedSet) {
          const single = new ScopePermissions([normToken]);
          if (isAllowed(single)) {
            retained.push(normToken);
            continue;
          }
          for (const atom of atomizeIncludePermission(normToken, groupDid)) {
            if (isAllowed(new ScopePermissions([atom]))) {
              retained.push(atom);
            }
          }
        }
      }
    } else {
      const norm = normalizeScopeToken(raw, groupDid, (msg) => {
        throw new InvalidScopeError(msg);
      });
      if (!isAllowed(new ScopePermissions([norm]))) {
        throw new UnauthorizedScopeError(
          `Requested permission '${raw}' exceeds the authorizing user's live group roles.`,
        );
      }
      retained.push(norm);
    }
  }

  // Deduplicate and absorb any token subsumed by another retained token.
  const unique = [...new Set(retained)];
  const minimized: string[] = [];
  for (let i = 0; i < unique.length; i += 1) {
    const candidate = unique[i]!;
    const others = unique.filter((_, idx) => idx !== i);
    if (others.length > 0 && isPermissionSubset(new ScopePermissions([candidate]), new ScopePermissions(others), groupDid)) {
      // Only drop if strictly absorbed by another token (if identical, dedupe already handled it;
      // guard against mutual subsumption by checking against already-kept + remaining unvisited).
      const remaining = [...minimized, ...unique.slice(i + 1)];
      if (remaining.length > 0 && isPermissionSubset(new ScopePermissions([candidate]), new ScopePermissions(remaining), groupDid)) {
        continue;
      }
    }
    minimized.push(candidate);
  }

  if (requestedNonAtproto && minimized.length === 0) {
    throw new UnauthorizedScopeError(
      "None of the requested group permissions are granted by the authorizing user's live roles.",
    );
  }

  const finalTokens = [...(hasAtproto ? ["atproto"] : []), ...minimized];
  if (finalTokens.length > MAX_ISSUED_SCOPE_TOKENS) {
    throw new InvalidScopeError(
      `Resolved OAuth scope exceeds the maximum of ${MAX_ISSUED_SCOPE_TOKENS} permission tokens.`,
    );
  }
  return {
    scope: finalTokens.join(" "),
    tokens: finalTokens,
    permissions: new ScopePermissions(finalTokens),
  };
}

/**
 * Single canonical effective permission union for a member acting as `groupDid`:
 * unions `expandGroupScopes` across all assigned `role.permissions` PLUS `expandPolicyGrantScopes`
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
  const rawRolePerms: string[] = [];
  for (const roleKey of assignedRoles) {
    const role = state.roles.get(roleKey);
    if (role?.permissions) {
      rawRolePerms.push(...role.permissions);
    }
  }
  const rolePerms = expandGroupScopes(rawRolePerms, groupDid);
  const unionTokens = new Set<string>(rolePerms.scopes);

  for (const [rawSpaceUri, policy] of state.spacePolicies.entries()) {
    const parsed = parseSpaceUri(rawSpaceUri);
    if (!parsed || parsed.authorityDid !== groupDid) continue;
    for (const grant of policy.grants ?? []) {
      if (!assignedRoles.has(grant.role) || !grant.permissions || grant.permissions.length === 0) continue;
      const clamped = expandPolicyGrantScopes(grant.permissions, {
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
 * Checks `read` and `write` on `org.atgrp.members/self` independently across assigned roles (flat union).
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
  let hasWildcardCanAssign = false;
  for (const roleKey of assignedRoles) {
    const role = state.roles.get(roleKey);
    if (role?.canAssign?.includes("*")) {
      hasWildcardCanAssign = true;
      break;
    }
  }
  if (!hasWildcardCanAssign) return false;

  const membersUri = groupMembersUri(groupDid);
  const membersPolicy = state.spacePolicies.get(membersUri);
  const hasMembersRead = Boolean(
    membersPolicy?.grants?.some((grant) => assignedRoles.has(grant.role) && grant.read === true),
  );
  const hasMembersWrite = Boolean(
    membersPolicy?.grants?.some((grant) => assignedRoles.has(grant.role) && grant.write === true),
  );
  if (!hasMembersRead || !hasMembersWrite) return false;

  const perms = effectiveMemberPermissions(state, groupDid, memberDid);
  const membersTarget = {
    spaceDid: groupDid as DidString,
    spaceType: ATGRP_SPACE_TYPE.members as NsidString,
    skey: "self" as RecordKeyString,
  };
  const metaTarget = {
    spaceDid: groupDid as DidString,
    spaceType: ATGRP_SPACE_TYPE.meta as NsidString,
    skey: "self" as RecordKeyString,
  };
  const wildcardTarget = {
    spaceType: "*" as const,
    authority: groupDid as DidString,
    skey: "*" as const,
  };

  if (!perms.allowsSpace(membersTarget, { action: "read" })) return false;
  if (!perms.allowsSpace(membersTarget, { manage: "update" })) return false;
  for (const col of [
    ATGRP_COLLECTION.role,
    ATGRP_COLLECTION.membership,
    ATGRP_COLLECTION.rule,
    ATGRP_COLLECTION.labeler,
  ] as const) {
    for (const action of ["create", "update", "delete"] as const) {
      if (!perms.allowsSpace(membersTarget, { action, collection: col as NsidString })) return false;
    }
  }

  if (!perms.allowsSpace(metaTarget, { action: "read" })) return false;
  if (!perms.allowsSpace(metaTarget, { manage: "update" })) return false;
  for (const col of [ATGRP_COLLECTION.about, ATGRP_COLLECTION.config] as const) {
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
 * Checks whether `memberDid` holds effective moderation capability:
 * label CRUD in `org.atgrp.members/self` (where account labels live) + `mod.querySubjects` + `mod.updateSubject`.
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
  const membersTarget = {
    spaceDid: groupDid as DidString,
    spaceType: ATGRP_SPACE_TYPE.members as NsidString,
    skey: "self" as RecordKeyString,
  };
  const groupAud = `${groupDid}#atproto_pds` as const;
  return (
    perms.allowsSpace(membersTarget, {
      action: "create",
      collection: ATPROTO_SPACE_COLLECTION.label as NsidString,
    }) &&
    perms.allowsRpc({
      aud: groupAud,
      lxm: ATGRP_METHOD.modQuerySubjects as NsidString,
    }) &&
    perms.allowsRpc({
      aud: groupAud,
      lxm: ATGRP_METHOD.modUpdateSubject as NsidString,
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
