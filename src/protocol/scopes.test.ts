import assert from "node:assert/strict";
import test from "node:test";
import { SPACE_TYPE } from "./nsids";
import {
  DM_BROWSER_SCOPES, memberSpaceScope, operatorMethodScope, permissionScopeFor,
  MEMBER_SIGN_IN_SCOPES, WORKSPACE_DISCOVERY_SCOPE, workspaceAuthorityScopes,
} from "./scopes";

const serviceRef = "did:web:slack.example#atproto_flock_operator";

test("member leave authorization grants only execute", () => {
  assert.deepEqual(permissionScopeFor("operatorLeave", {
    workspaceDid: "did:plc:owner", workspaceSkey: "acme", serviceRef,
  }), ["rpc:new.flock.operator.execute?aud=did:web:slack.example%23atproto_flock_operator"]);
});

test("admin authorization includes only the three published operator methods", () => {
  const scopes = permissionScopeFor("operatorAdmin", { workspaceDid: "did:plc:owner", serviceRef });
  assert.equal(scopes.length, 1);
  assert.equal(scopes[0], "rpc?lxm=new.flock.operator.execute&lxm=new.flock.operator.getOperation&lxm=new.flock.operator.listInboxWriters&aud=did:web:slack.example%23atproto_flock_operator");
});

test("operator RPC scopes preserve percent-encoded DID web ports", () => {
  assert.deepEqual(permissionScopeFor("operatorLeave", {
    workspaceDid: "did:plc:owner",
    workspaceSkey: "acme",
    serviceRef: "did:web:localhost%3A3000#atproto_flock_operator",
  }), ["rpc:new.flock.operator.execute?aud=did:web:localhost%253A3000%23atproto_flock_operator"]);
});

test("workspace authority scopes contain no message or reaction writes", () => {
  const scopes = workspaceAuthorityScopes();
  assert.ok(scopes.some((scope) => scope.includes("manage=create&manage=update")));
  assert.ok(scopes.some((scope) => scope.includes("collection=new.flock.channel.roster")));
  assert.ok(scopes.every((scope) => !scope.includes("channel.message") && !scope.includes("channel.reaction")));
});

test("login discovery scope is read-self only across workspace authorities", () => {
  assert.equal(WORKSPACE_DISCOVERY_SCOPE, "space:new.flock.workspace?authority=*&collection=new.flock.acceptance&action=read_self");
});

test("workspace authority combines equivalent read actions into compact scopes", () => {
  const scopes = workspaceAuthorityScopes();
  assert.ok(scopes.includes("space:new.flock.workspace?authority=self&skey=*&action=read_self&action=read&manage=create&manage=update"));
  assert.ok(scopes.includes("space:new.flock.inbox?authority=self&skey=*&action=read_self&action=read&manage=create&manage=update"));
  assert.ok(scopes.includes("space:new.flock.channel?authority=self&skey=*&action=read_self&action=read&manage=create&manage=update"));
});

test("member permission scopes reject keys that can inject OAuth parameters", () => {
  for (const skey of ["general&action=create", "general=other", "*"]) {
    assert.throws(() => permissionScopeFor("channelRead", {
      workspaceDid: "did:plc:owner", skey,
    }), /Invalid space key/);
    assert.throws(() => permissionScopeFor("workspaceRead", {
      workspaceDid: "did:plc:owner", workspaceSkey: skey,
    }), /Invalid space key/);
  }
});

test("channel write scopes reject injected keys and preserve the exact valid scope", () => {
  for (const skey of ["*", "x&skey=*"]) {
    assert.throws(() => permissionScopeFor("channelWrite", {
      workspaceDid: "did:plc:owner", skey,
    }), /Invalid space key/);
  }
  assert.deepEqual(permissionScopeFor("channelWrite", {
    workspaceDid: "did:plc:owner", skey: "general",
  }), ["space:new.flock.channel?authority=did:plc:owner&skey=general&collection=new.flock.channel.message&collection=new.flock.channel.reaction&action=create&action=update&action=delete"]);
});

test("DM_BROWSER_SCOPES is the exact browser-session grant (M3)", () => {
  assert.deepEqual(DM_BROWSER_SCOPES, [
    "atproto",
    "space:new.flock.dm.inbox?authority=*&collection=new.flock.dm.request&action=create&action=update&action=delete",
    "space:new.flock.dm.inbox?authority=self&action=read&manage=create&manage=update",
    "repo:new.flock.dm.declaration?action=create&action=update",
    "space:new.flock.dm.conversation?authority=self&collection=new.flock.dm.header&collection=new.flock.dm.message&collection=new.flock.dm.reaction&action=create&action=update&action=delete&manage=create&manage=update&manage=delete",
    "space:new.flock.dm.conversation?authority=*&action=read",
  ]);
});

test("memberSpaceScope refuses to mint a scope for either DM space type", () => {
  for (const spaceType of [SPACE_TYPE.dmInbox, SPACE_TYPE.dmConversation]) {
    assert.throws(() => memberSpaceScope({
      spaceType, authorityDid: "did:plc:owner", skey: "self", action: "read",
    }), /DM space types are never granted/);
  }
});

test("no server-side scope builder ever grants an new.flock.dm scope", () => {
  const serviceRef = "did:web:slack.example#atproto_flock_operator";
  const nonDmScopes = [
    ...workspaceAuthorityScopes(),
    WORKSPACE_DISCOVERY_SCOPE,
    ...permissionScopeFor("workspaceRead", { workspaceDid: "did:plc:owner" }),
    ...permissionScopeFor("channelRead", { workspaceDid: "did:plc:owner", skey: "general" }),
    ...permissionScopeFor("acceptanceWrite", { workspaceDid: "did:plc:owner" }),
    ...permissionScopeFor("requestJoin", { workspaceDid: "did:plc:owner" }),
    ...permissionScopeFor("joinWorkspace", { workspaceDid: "did:plc:owner", workspaceSkey: "acme" }),
    ...permissionScopeFor("channelWrite", { workspaceDid: "did:plc:owner", skey: "general" }),
    ...permissionScopeFor("channelAccess", { workspaceDid: "did:plc:owner", skey: "general" }),
    ...permissionScopeFor("operatorAdmin", { workspaceDid: "did:plc:owner", serviceRef }),
    ...permissionScopeFor("operatorLeave", { workspaceDid: "did:plc:owner", workspaceSkey: "acme", serviceRef }),
    ...MEMBER_SIGN_IN_SCOPES,
    operatorMethodScope("new.flock.operator.execute", serviceRef),
    "atproto",
  ];
  assert.ok(nonDmScopes.length > 0);
  for (const scope of nonDmScopes) assert.ok(!scope.includes("new.flock.dm"), scope);
});

test("the server's sign-in scope carries no DM scope", () => {
  for (const scope of ["atproto", ...MEMBER_SIGN_IN_SCOPES]) assert.ok(!scope.includes("new.flock.dm"), scope);
});

test("sign-in reads only the spaces the account is itself the authority of, and never administers them", () => {
  // given the scopes every sign-in requests
  const ownSpaceScopes = MEMBER_SIGN_IN_SCOPES.filter((scope) => scope !== WORKSPACE_DISCOVERY_SCOPE);

  // then each is a self-authority read and none can manage a space or write a record
  assert.equal(ownSpaceScopes.length, 3);
  for (const scope of ownSpaceScopes) {
    assert.match(scope, /^space:new\.flock\.(workspace|inbox|channel)\?authority=self&skey=\*&action=read_self&action=read$/);
  }
});

test("the workspace authority is no longer a member permission request", () => {
  assert.throws(() => permissionScopeFor("workspaceAuthority", { workspaceDid: "did:plc:owner" }), /Unknown permission request/);
});
