import assert from "node:assert/strict";
import test from "node:test";
import { SpacePermission } from "@atproto/oauth-scopes";
import type { DidString, NsidString, RecordKeyString } from "@atproto/syntax";
import { groupMembersUri, groupMetaUri } from "./keys";
import { OPERATOR_METHOD } from "./nsids";
import {
  appGrantScopes,
  DESK_MODALITY_SCOPES,
  deskMemberScopes,
  DM_BROWSER_SCOPES,
  effectiveMemberPermissions,
  expandGroupScopes,
  expandPolicyGrantScopes,
  groupAdminScopes,
  groupModeratorScopes,
  InvalidSpacePolicyScopeError,
  isEffectiveAdminMember,
  isEffectiveModeratorMember,
  LEGACY_OPERATOR_METHODS,
  legacyMemberGrantScopes,
  memberGrantScopes,
  OPEN_SOCIAL_PARTICIPATE_SCOPES,
  OPERATOR_METHODS,
  operatorMethodsScope,
  PERSONAL_PDS_LIST_GROUP_MEMBERS_SPACES_SCOPE,
} from "./scopes";

const serviceRef = "did:web:slack.example#atproto_flock_operator";
const groupDid = "did:plc:abcdefghijklmnopqrstuvwx";
const aliceDid = "did:plc:aliceabcdefghijklmnopqrs";
const bobDid = "did:plc:bobabcdefghijklmnopqrstu";

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

test("memberGrantScopes includes DM_BROWSER_SCOPES + OPEN_SOCIAL_PARTICIPATE_SCOPES + Flock modality scopes", () => {
  const scopes = memberGrantScopes(serviceRef);
  for (const dmScope of DM_BROWSER_SCOPES) {
    assert.ok(scopes.includes(dmScope), `missing DM scope ${dmScope}`);
  }
  for (const osScope of OPEN_SOCIAL_PARTICIPATE_SCOPES) {
    assert.ok(scopes.includes(osScope), `missing OpenSocial participate scope ${osScope}`);
  }
  assert.ok(scopes.includes("space:new.flock.workspace?authority=*&skey=self&action=read"));
  assert.ok(scopes.includes("space:new.flock.inbox?authority=*&skey=self&action=read"));
});

test("appGrantScopes includes meta/self and members/self read plus Flock app modality scopes without DM or inbox", () => {
  assert.deepEqual(appGrantScopes("did:web:operator.example#atproto_flock_operator"), [
    "atproto",
    "repo:new.flock.app.declaration?action=create&action=update",
    "space:group.opensocial.meta?authority=*&skey=self&action=read",
    "space:group.opensocial.members?authority=*&action=read_self",
    "space:group.opensocial.members?authority=*&skey=self&action=read",
    "space:new.flock.workspace?authority=*&skey=self&action=read",
    "space:new.flock.channel?authority=*&action=read",
    "space:new.flock.channel?authority=*&collection=new.flock.channel.message&collection=new.flock.channel.reaction&action=create&action=update&action=delete",
    "space:new.flock.app.inbox?authority=*&action=read",
    "rpc?lxm=new.flock.operator.getChanges&aud=did:web:operator.example%23atproto_flock_operator",
  ]);
});

test("deskMemberScopes is least-privilege, satisfies listSpaces(group.opensocial.members), and omits operator/unused scopes", () => {
  const scopes = deskMemberScopes();
  assert.deepEqual(scopes, [
    "atproto",
    ...OPEN_SOCIAL_PARTICIPATE_SCOPES,
    PERSONAL_PDS_LIST_GROUP_MEMBERS_SPACES_SCOPE,
    ...DESK_MODALITY_SCOPES,
  ]);
  const perms = expandGroupScopes(scopes);
  assert.equal(
    perms.allowsSpace(
      { spaceType: "group.opensocial.members" as NsidString, authority: "*", skey: "*" },
      { action: "read_self" },
    ),
    true,
    "deskMemberScopes must satisfy real PDS listSpaces({ spaceType: 'group.opensocial.members' })",
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

test("groupAdminScopes never emits invalid aud=self and expands cleanly with zero dropped permissions", () => {
  const preDidScopes = groupAdminScopes();
  assert.ok(preDidScopes.every((s) => !s.includes("aud=self")));
  const preDidPerms = expandGroupScopes(preDidScopes);
  assert.equal(preDidPerms.allowsAccount({ attr: "repo", action: "manage" }), true);
  assert.equal(preDidPerms.allowsIdentity({ attr: "*" }), true);
  assert.equal(
    preDidPerms.allowsRpc({
      aud: `${groupDid}#atproto_pds`,
      lxm: "group.opensocial.listJoinRequests",
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
      lxm: "group.opensocial.abortMigration",
    }),
    true,
  );
  const modPerms = expandGroupScopes(groupModeratorScopes());
  assert.equal(
    modPerms.allowsRpc({
      aud: "did:web:target.groups.example" as `${DidString}#${string}`,
      lxm: "group.opensocial.abortMigration",
    }),
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
  // Matches target space
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
  // NEVER leaks to another channel skey or spaceType!
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

  // Rejects non-space scopes, manage=create, and cross-space targets
  for (const bad of [
    "repo:*",
    "rpc?aud=*&lxm=group.opensocial.listModSubjects",
    "account:status?action=manage",
    "space:new.flock.channel?manage=create",
    "space:group.opensocial.meta?skey=self&action=read",
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

test("effectiveMemberPermissions unions role.scopes AND space-clamped policy.grants[].scopes across admin & moderator checks", () => {
  const roles = new Map([
    [
      "admin",
      {
        displayName: "Admin",
        scopes: groupAdminScopes(groupDid).filter((s) => s !== "atproto"),
        assignable: ["*"],
      },
    ],
    [
      "channel-mod",
      {
        displayName: "Channel Mod",
        scopes: groupModeratorScopes().filter((s) => s !== "atproto" && !s.startsWith("space:*")),
        assignable: [],
      },
    ],
  ]);

  const memberships = new Map([
    [aliceDid, { roles: ["admin"], createdAt: "2026-11-20T00:00:00.000Z" }],
    [bobDid, { roles: ["channel-mod"], createdAt: "2026-11-20T00:00:00.000Z" }],
  ]);

  const generalChannelUri = `at:space/${groupDid}/new.flock.channel/general`;
  const spacePolicies = new Map([
    [
      groupMembersUri(groupDid),
      { grants: [{ role: "admin", read: true, write: true }, { role: "channel-mod", read: true, write: true }] },
    ],
    [
      groupMetaUri(groupDid),
      { grants: [{ role: "admin", read: true }, { role: "channel-mod", read: true }] },
    ],
    [
      generalChannelUri,
      {
        grants: [
          {
            role: "channel-mod",
            read: true,
            write: true,
            // Capability granted ONLY via per-space policy.grants[].scopes!
            scopes: ["space:new.flock.channel?skey=general&collection=com.atproto.label.record&action=create&action=delete"],
          },
        ],
      },
    ],
  ]);

  const state = { roles, memberships, spacePolicies };
  assert.equal(isEffectiveAdminMember(aliceDid, state, groupDid), true);
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
