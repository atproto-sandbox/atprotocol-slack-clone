import assert from "node:assert/strict";
import test from "node:test";
import { SpacePermission } from "@atproto/oauth-scopes";
import type { DidString, NsidString, RecordKeyString } from "@atproto/syntax";
import { groupMembersUri, groupMetaUri } from "./keys";
import { ATGRP_COLLECTION, ATGRP_METHOD, ATGRP_PERMISSION_SET, ATGRP_SPACE_TYPE, FLOCK_GROUP_METHOD, OPERATOR_METHOD } from "./nsids";
import {
  appGrantScopes,
  ATGRP_PARTICIPATE_SCOPES,
  DESK_MODALITY_SCOPES,
  deskMemberScopes,
  DM_BROWSER_SCOPES,
  effectiveMemberPermissions,
  expandGroupScopes,
  expandPolicyGrantScopes,
  groupAdminScopes,
  groupBasicEditorScopes,
  groupMembersManagerScopes,
  groupModeratorScopes,
  InvalidScopeError,
  InvalidSpacePolicyScopeError,
  isEffectiveAdminMember,
  isEffectiveModeratorMember,
  LEGACY_OPERATOR_METHODS,
  legacyMemberGrantScopes,
  MAX_ISSUED_SCOPE_TOKENS,
  memberGrantScopes,
  OPERATOR_METHODS,
  operatorMethodsScope,
  PERSONAL_PDS_LIST_GROUP_MEMBERS_SPACES_SCOPE,
  resolveAuthorizedGroupScope,
  UnauthorizedScopeError,
} from "./scopes";

const serviceRef = "did:web:slack.example#atproto_flock_operator";
const groupDid = "did:plc:abcdefghijklmnopqrstuvwx";
const aliceDid = "did:plc:aliceabcdefghijklmnopqrs";
const bobDid = "did:plc:bobabcdefghijklmnopqrstu";
const carolDid = "did:plc:carolabcdefghijklmnopqrs";

test("operatorMethodsScope lists all published operator methods including getSpaceNotifyTarget", () => {
  assert.equal(
    operatorMethodsScope(OPERATOR_METHODS, serviceRef),
    "rpc?lxm=new.flock.operator.execute&lxm=new.flock.operator.getOperation" +
      "&lxm=new.flock.operator.getChanges&lxm=new.flock.operator.createWorkspace&lxm=new.flock.operator.startAuthorityFlow" +
      "&lxm=new.flock.operator.listStalledOperations&lxm=new.flock.operator.getDmNotifyTarget&lxm=new.flock.operator.getSpaceNotifyTarget" +
      "&aud=did:web:slack.example%23atproto_flock_operator",
  );
});

test("legacyMemberGrantScopes matches memberGrantScopes except omitting notify-target methods", () => {
  assert.equal((LEGACY_OPERATOR_METHODS as readonly string[]).includes(OPERATOR_METHOD.getDmNotifyTarget), false);
  assert.equal((LEGACY_OPERATOR_METHODS as readonly string[]).includes(OPERATOR_METHOD.getSpaceNotifyTarget), false);
  const current = memberGrantScopes(serviceRef);
  const legacy = legacyMemberGrantScopes(serviceRef);
  assert.deepEqual(legacy.slice(0, -1), current.slice(0, -1));
  assert.equal(legacy.at(-1), operatorMethodsScope(LEGACY_OPERATOR_METHODS, serviceRef));
});

test("memberGrantScopes includes DM_BROWSER_SCOPES + ATGRP_PARTICIPATE_SCOPES + Flock modality scopes", () => {
  const scopes = memberGrantScopes(serviceRef);
  for (const dmScope of DM_BROWSER_SCOPES) {
    assert.ok(scopes.includes(dmScope), `missing DM scope ${dmScope}`);
  }
  for (const atgrpScope of ATGRP_PARTICIPATE_SCOPES) {
    assert.ok(scopes.includes(atgrpScope), `missing Atmosphere Groups participate scope ${atgrpScope}`);
  }
  assert.ok(scopes.includes("space:new.flock.workspace?authority=*&skey=self&action=read"));
  assert.ok(scopes.includes("space:new.flock.inbox?authority=*&skey=self&action=read"));
});

test("appGrantScopes includes meta/self and members/self read plus Flock app modality scopes without DM or inbox", () => {
  assert.deepEqual(appGrantScopes("did:web:operator.example#atproto_flock_operator"), [
    "atproto",
    "repo:new.flock.app.declaration?action=create&action=update",
    "space:org.atgrp.meta?authority=*&skey=self&action=read",
    "space:org.atgrp.members?authority=*&action=read_self",
    "space:org.atgrp.members?authority=*&skey=self&action=read",
    "space:new.flock.workspace?authority=*&skey=self&action=read",
    "space:new.flock.channel?authority=*&action=read",
    "space:new.flock.channel?authority=*&collection=new.flock.channel.message&collection=new.flock.channel.reaction&action=create&action=update&action=delete",
    "space:new.flock.app.inbox?authority=*&action=read",
    "rpc?lxm=new.flock.operator.getChanges&aud=did:web:operator.example%23atproto_flock_operator",
  ]);
});

test("deskMemberScopes is least-privilege, satisfies listSpaces(org.atgrp.members), and omits operator/unused scopes", () => {
  const scopes = deskMemberScopes();
  assert.deepEqual(scopes, [
    "atproto",
    ...ATGRP_PARTICIPATE_SCOPES,
    PERSONAL_PDS_LIST_GROUP_MEMBERS_SPACES_SCOPE,
    ...DESK_MODALITY_SCOPES,
  ]);
  const perms = expandGroupScopes(scopes);
  assert.equal(
    perms.allowsSpace(
      { spaceType: ATGRP_SPACE_TYPE.members as NsidString, authority: "*", skey: "*" },
      { action: "read_self" },
    ),
    true,
    "deskMemberScopes must satisfy real PDS listSpaces({ spaceType: 'org.atgrp.members' })",
  );
  assert.equal(
    perms.allowsSpace(
      { spaceDid: groupDid as DidString, spaceType: "new.flock.channel" as NsidString, skey: "general" as RecordKeyString },
      { action: "create", collection: "new.flock.channel.message" as NsidString },
    ),
    true,
  );
  const joined = scopes.join(" ");
  for (const forbidden of [
    "new.flock.operator.",
    "new.flock.inbox",
    "new.flock.channel.reaction",
    "new.flock.ext.tasks",
    "new.flock.app.inbox",
    "new.flock.dm.",
  ]) {
    assert.equal(joined.includes(forbidden), false, `deskMemberScopes must omit ${forbidden}`);
  }
});

test("@atproto/oauth-scopes SpaceCollectionParam accepts '*' collection on space.importRepo checks", () => {
  const wildcardPerm = SpacePermission.fromString(
    "space:*?collection=*&action=read&action=create&action=update&action=delete",
  )!.withResolvedAuthority(groupDid as DidString);
  assert.equal(
    wildcardPerm.matches({
      spaceType: "new.flock.channel" as NsidString,
      authority: groupDid as DidString,
      skey: "general" as RecordKeyString,
      action: "create",
      collection: "*",
    }),
    true,
  );

  const narrowPerm = SpacePermission.fromString(
    "space:new.flock.channel?collection=new.flock.channel.message&action=create",
  )!.withResolvedAuthority(groupDid as DidString);
  assert.equal(
    narrowPerm.matches({
      spaceType: "new.flock.channel" as NsidString,
      authority: groupDid as DidString,
      skey: "general" as RecordKeyString,
      action: "create",
      collection: "*",
    }),
    false,
  );
});

test("groupAdminScopes, groupModeratorScopes (write-only wildcard labels), groupMembersManagerScopes, and groupBasicEditorScopes expand cleanly", () => {
  const preDidScopes = groupAdminScopes();
  assert.ok(preDidScopes.every((s) => !s.includes("aud=self")));
  const preDidPerms = expandGroupScopes(preDidScopes);
  assert.equal(preDidPerms.allowsAccount({ attr: "repo", action: "manage" }), true);
  assert.equal(preDidPerms.allowsIdentity({ attr: "*" }), true);
  assert.equal(
    preDidPerms.allowsRpc({
      aud: `${groupDid}#atproto_pds`,
      lxm: ATGRP_METHOD.listJoinRequests,
    }),
    true,
  );
  assert.equal(
    preDidPerms.allowsRpc({
      aud: "did:web:target.groups.example" as `${DidString}#${string}`,
      lxm: "com.atproto.server.createAccount",
    }),
    true,
  );
  assert.equal(
    preDidPerms.allowsRpc({
      aud: "did:web:target.groups.example" as `${DidString}#${string}`,
      lxm: FLOCK_GROUP_METHOD.abortMigration,
    }),
    true,
  );

  // Moderator: write-only wildcard labels (NO action=read on space:*!), no abortMigration, no listJoinRequests
  const modPerms = expandGroupScopes(groupModeratorScopes(), groupDid);
  assert.equal(
    modPerms.allowsRpc({
      aud: "did:web:target.groups.example" as `${DidString}#${string}`,
      lxm: FLOCK_GROUP_METHOD.abortMigration,
    }),
    false,
  );
  assert.equal(
    modPerms.allowsRpc({
      aud: `${groupDid}#atproto_pds`,
      lxm: ATGRP_METHOD.listJoinRequests,
    }),
    false,
  );
  assert.equal(
    modPerms.allowsSpace(
      { spaceDid: groupDid as DidString, spaceType: "new.flock.channel", skey: "secret" },
      { action: "read" },
    ),
    false,
    "moderator must NOT receive wildcard action=read on private channels",
  );
  assert.equal(
    modPerms.allowsSpace(
      { spaceDid: groupDid as DidString, spaceType: "new.flock.channel", skey: "secret" },
      { action: "create", collection: "com.atproto.label.record" },
    ),
    true,
  );

  // Members manager: invites & join requests, no moderation RPCs
  const membersMgrPerms = expandGroupScopes(groupMembersManagerScopes(), groupDid);
  assert.equal(
    membersMgrPerms.allowsRpc({ aud: `${groupDid}#atproto_pds`, lxm: ATGRP_METHOD.listJoinRequests }),
    true,
  );
  assert.equal(
    membersMgrPerms.allowsRpc({ aud: `${groupDid}#atproto_pds`, lxm: ATGRP_METHOD.denyJoinRequest }),
    true,
  );
  assert.equal(
    membersMgrPerms.allowsRpc({ aud: `${groupDid}#atproto_pds`, lxm: ATGRP_METHOD.modQuerySubjects }),
    false,
  );

  // Basic editor: about + rule, no config/role/membership
  const basicPerms = expandGroupScopes(groupBasicEditorScopes(), groupDid);
  assert.equal(
    basicPerms.allowsSpace(
      { spaceDid: groupDid as DidString, spaceType: ATGRP_SPACE_TYPE.meta, skey: "self" },
      { action: "update", collection: ATGRP_COLLECTION.about },
    ),
    true,
  );
  assert.equal(
    basicPerms.allowsSpace(
      { spaceDid: groupDid as DidString, spaceType: ATGRP_SPACE_TYPE.members, skey: "self" },
      { action: "create", collection: ATGRP_COLLECTION.rule },
    ),
    true,
  );
  assert.equal(
    basicPerms.allowsSpace(
      { spaceDid: groupDid as DidString, spaceType: ATGRP_SPACE_TYPE.meta, skey: "self" },
      { action: "update", collection: ATGRP_COLLECTION.config },
    ),
    false,
  );

  const postDidPerms = expandGroupScopes(groupAdminScopes(groupDid), groupDid);
  assert.equal(
    postDidPerms.allowsSpace(
      { spaceDid: groupDid as DidString, spaceType: "new.flock.channel", skey: "general" },
      { action: "create", collection: "*" },
    ),
    true,
  );
  assert.equal(
    postDidPerms.allowsRpc({
      aud: `${groupDid}#atproto_pds`,
      lxm: "com.atproto.space.exportSpaceMeta",
    }),
    true,
  );
});

test("expandPolicyGrantScopes clamps policy grants to concrete (spaceType, groupDid, skey) and rejects non-space, manage=create, and cross-space scopes", () => {
  const clamped = expandPolicyGrantScopes(
    ["space:*?collection=com.atproto.label.record&action=create&manage=update"],
    { groupDid, spaceType: "new.flock.channel", skey: "general" },
  );
  assert.equal(clamped.length, 1);
  assert.equal(
    clamped[0]!.matches({
      spaceType: "new.flock.channel",
      authority: groupDid as DidString,
      skey: "general",
      action: "create",
      collection: "com.atproto.label.record",
    }),
    true,
  );
  assert.equal(
    clamped[0]!.matches({
      spaceType: "new.flock.channel",
      authority: groupDid as DidString,
      skey: "random",
      action: "create",
      collection: "com.atproto.label.record",
    }),
    false,
  );

  for (const bad of [
    "repo:*",
    `rpc?aud=*&lxm=${ATGRP_METHOD.modQuerySubjects}`,
    "account:status?action=manage",
    "space:new.flock.channel?manage=create",
    `space:${ATGRP_SPACE_TYPE.meta}?skey=self&action=read`,
    "space:new.flock.channel?skey=other&action=read",
    "space:new.flock.channel?authority=did:plc:other&action=read",
  ]) {
    assert.throws(
      () => expandPolicyGrantScopes([bad], { groupDid, spaceType: "new.flock.channel", skey: "general" }),
      (err: unknown) => err instanceof InvalidSpacePolicyScopeError && err.code === "InvalidSpacePolicyScope",
      bad,
    );
  }
});

test("effectiveMemberPermissions unions role.permissions and policy.grants[].permissions; isEffectiveAdminMember uses flat union for members/self read+write", () => {
  const roles = new Map([
    [
      "admin",
      {
        displayName: "Admin",
        permissions: groupAdminScopes(groupDid).filter((s) => s !== "atproto"),
        canAssign: ["*"],
      },
    ],
    [
      "split-admin-reader",
      {
        permissions: groupAdminScopes(groupDid).filter((s) => s !== "atproto"),
        canAssign: ["*"],
      },
    ],
    [
      "split-admin-writer",
      {
        permissions: [],
        canAssign: [],
      },
    ],
    [
      "channel-mod",
      {
        displayName: "Channel Mod",
        permissions: groupModeratorScopes().filter((s) => s !== "atproto" && !s.startsWith("space:*")),
        canAssign: [],
      },
    ],
  ]);

  const memberships = new Map([
    [aliceDid, { roles: ["admin"], createdAt: "2026-11-20T00:00:00.000Z" }],
    [bobDid, { roles: ["channel-mod"], createdAt: "2026-11-20T00:00:00.000Z" }],
    [carolDid, { roles: ["split-admin-reader", "split-admin-writer"], createdAt: "2026-11-20T00:00:00.000Z" }],
  ]);

  const generalChannelUri = `at:space/${groupDid}/new.flock.channel/general`;
  const spacePolicies = new Map([
    [
      groupMembersUri(groupDid),
      {
        grants: [
          { role: "admin", read: true, write: true },
          { role: "channel-mod", read: true, write: true },
          // Split across two roles: reader grants read, writer grants write!
          { role: "split-admin-reader", read: true },
          { role: "split-admin-writer", write: true },
        ],
      },
    ],
    [
      groupMetaUri(groupDid),
      { grants: [{ role: "admin", read: true }, { role: "channel-mod", read: true }, { role: "split-admin-reader", read: true }] },
    ],
    [
      generalChannelUri,
      {
        grants: [
          {
            role: "channel-mod",
            read: true,
            write: true,
            permissions: ["space:new.flock.channel?skey=general&collection=com.atproto.label.record&action=create&action=delete"],
          },
        ],
      },
    ],
  ]);

  const state = { roles, memberships, spacePolicies };
  assert.equal(isEffectiveAdminMember(aliceDid, state, groupDid), true);
  assert.equal(isEffectiveAdminMember(carolDid, state, groupDid), true, "flat union across roles satisfies members/self read + write");
  assert.equal(isEffectiveAdminMember(bobDid, state, groupDid), false);
  assert.equal(isEffectiveModeratorMember(bobDid, state, groupDid), true);

  const bobPerms = effectiveMemberPermissions(state, groupDid, bobDid);
  assert.equal(
    bobPerms.allowsSpace(
      { spaceDid: groupDid as DidString, spaceType: "new.flock.channel", skey: "general" },
      { action: "create", collection: "com.atproto.label.record" },
    ),
    true,
  );
  assert.equal(
    bobPerms.allowsSpace(
      { spaceDid: groupDid as DidString, spaceType: "new.flock.channel", skey: "random" },
      { action: "create", collection: "com.atproto.label.record" },
    ),
    false,
  );
});

test("resolveAuthorizedGroupScope narrows include: sets to live roles, rejects excess explicit perms, absorbs redundancies, and caps issued tokens", () => {
  const basicPerms = expandGroupScopes(groupBasicEditorScopes(), groupDid);

  // 1. Basic editor requesting include:org.atgrp.authManageAdmin gets narrowed ONLY to what basicPerms allows!
  const narrowed = resolveAuthorizedGroupScope(
    ["atproto", `include:${ATGRP_PERMISSION_SET.authManageAdmin}`],
    basicPerms,
    groupDid,
  );
  assert.ok(narrowed.tokens.includes("atproto"));
  assert.equal(
    narrowed.permissions.allowsSpace(
      { spaceDid: groupDid as DidString, spaceType: ATGRP_SPACE_TYPE.meta, skey: "self" },
      { action: "update", collection: ATGRP_COLLECTION.about },
    ),
    true,
  );
  assert.equal(
    narrowed.permissions.allowsSpace(
      { spaceDid: groupDid as DidString, spaceType: ATGRP_SPACE_TYPE.meta, skey: "self" },
      { action: "update", collection: ATGRP_COLLECTION.config },
    ),
    false,
  );
  assert.equal(
    narrowed.permissions.allowsRpc({ aud: `${groupDid}#atproto_pds`, lxm: ATGRP_METHOD.modQuerySubjects }),
    false,
  );

  // 2. Explicit non-include permission exceeding live roles throws 403 access_denied
  assert.throws(
    () =>
      resolveAuthorizedGroupScope(
        ["atproto", `space:${ATGRP_SPACE_TYPE.meta}?skey=self&collection=${ATGRP_COLLECTION.config}&action=update`],
        basicPerms,
        groupDid,
      ),
    (err: unknown) => err instanceof UnauthorizedScopeError && err.status === 403 && err.code === "access_denied",
  );

  // 3. Explicit atproto-only succeeds even with empty role permissions; non-atproto narrowing to 0 throws 403
  const emptyPerms = expandGroupScopes([], groupDid);
  const atprotoOnly = resolveAuthorizedGroupScope(["atproto"], emptyPerms, groupDid);
  assert.deepEqual(atprotoOnly.tokens, ["atproto"]);
  assert.throws(
    () => resolveAuthorizedGroupScope(["atproto", `include:${ATGRP_PERMISSION_SET.authManageBasic}`], emptyPerms, groupDid),
    (err: unknown) => err instanceof UnauthorizedScopeError && err.status === 403,
  );

  // 4. Redundant token absorption
  const adminPerms = expandGroupScopes(groupAdminScopes(groupDid), groupDid);
  const absorbed = resolveAuthorizedGroupScope(
    [
      "atproto",
      `space:${ATGRP_SPACE_TYPE.meta}?skey=self&collection=${ATGRP_COLLECTION.about}&action=create&action=update&action=delete`,
      `space:${ATGRP_SPACE_TYPE.meta}?skey=self&collection=${ATGRP_COLLECTION.about}&action=update`,
    ],
    adminPerms,
    groupDid,
  );
  assert.equal(absorbed.tokens.length, 2, "narrower duplicate scope absorbed into wider token");

  // 5. Hard token ceiling enforcement (MAX_ISSUED_SCOPE_TOKENS)
  const manyExplicit = Array.from(
    { length: MAX_ISSUED_SCOPE_TOKENS + 5 },
    (_, i) => `space:new.flock.channel?authority=${groupDid}&skey=ch-${i}&collection=new.flock.channel.message&action=create`,
  );
  assert.throws(
    () => resolveAuthorizedGroupScope(["atproto", ...manyExplicit], adminPerms, groupDid),
    (err: unknown) => err instanceof InvalidScopeError && err.status === 400,
  );
});
