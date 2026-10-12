import assert from "node:assert/strict";
import test from "node:test";
import {
  DM_BROWSER_SCOPES, memberSpaceScope, operatorMethodScope, permissionScopeFor,
  SLACK_SPACE_TYPES, WORKSPACE_DISCOVERY_SCOPE, workspaceAuthorityScopes,
} from "./permission-sets";

const serviceRef = "did:web:slack.example#atproto_slack_admin";

test("member leave authorization grants only execute", () => {
  assert.deepEqual(permissionScopeFor("operatorLeave", {
    workspaceDid: "did:plc:owner", workspaceSkey: "acme", serviceRef,
  }), ["rpc:org.slack.operator.execute?aud=did:web:slack.example%23atproto_slack_admin"]);
});

test("admin authorization includes only the three published operator methods", () => {
  const scopes = permissionScopeFor("operatorAdmin", { workspaceDid: "did:plc:owner", serviceRef });
  assert.equal(scopes.length, 1);
  assert.equal(scopes[0], "rpc?lxm=org.slack.operator.execute&lxm=org.slack.operator.getOperation&lxm=org.slack.operator.listInboxWriters&aud=did:web:slack.example%23atproto_slack_admin");
});

test("operator RPC scopes preserve percent-encoded DID web ports", () => {
  assert.deepEqual(permissionScopeFor("operatorLeave", {
    workspaceDid: "did:plc:owner",
    workspaceSkey: "acme",
    serviceRef: "did:web:localhost%3A3000#atproto_slack_admin",
  }), ["rpc:org.slack.operator.execute?aud=did:web:localhost%253A3000%23atproto_slack_admin"]);
});

test("workspace authority scopes contain no message or reaction writes", () => {
  const scopes = workspaceAuthorityScopes();
  assert.ok(scopes.some((scope) => scope.includes("manage=create&manage=update")));
  assert.ok(scopes.some((scope) => scope.includes("collection=org.slack.channel.roster")));
  assert.ok(scopes.every((scope) => !scope.includes("channel.message") && !scope.includes("channel.reaction")));
});

test("login discovery scope is read-self only across workspace authorities", () => {
  assert.equal(WORKSPACE_DISCOVERY_SCOPE, "space:org.slack.workspace?authority=*&collection=org.slack.acceptance&action=read_self");
});

test("workspace authority combines equivalent read actions into compact scopes", () => {
  const scopes = workspaceAuthorityScopes();
  assert.ok(scopes.includes("space:org.slack.workspace?authority=self&skey=*&action=read_self&action=read&manage=create&manage=update"));
  assert.ok(scopes.includes("space:org.slack.inbox?authority=self&skey=*&action=read_self&action=read&manage=create&manage=update"));
  assert.ok(scopes.includes("space:org.slack.channel?authority=self&skey=*&action=read_self&action=read&manage=create&manage=update"));
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
  }), ["space:org.slack.channel?authority=did:plc:owner&skey=general&collection=org.slack.channel.message&collection=org.slack.channel.reaction&action=create&action=update&action=delete"]);
});

test("DM_BROWSER_SCOPES is the exact browser-session grant (M3)", () => {
  assert.deepEqual(DM_BROWSER_SCOPES, [
    "atproto",
    "space:org.slack.dm.inbox?authority=*&collection=org.slack.dm.request&action=create&action=update&action=delete",
    "space:org.slack.dm.inbox?authority=self&action=read&manage=create&manage=update",
    "space:org.slack.dm.inbox?authority=*&action=read",
    "space:org.slack.dm.conversation?authority=self&collection=org.slack.dm.header&collection=org.slack.dm.message&collection=org.slack.dm.reaction&action=create&action=update&action=delete&manage=create&manage=update&manage=delete",
    "space:org.slack.dm.conversation?authority=*&action=read",
  ]);
});

test("memberSpaceScope refuses to mint a scope for either DM space type", () => {
  for (const spaceType of [SLACK_SPACE_TYPES.dmInbox, SLACK_SPACE_TYPES.dmConversation]) {
    assert.throws(() => memberSpaceScope({
      spaceType, authorityDid: "did:plc:owner", skey: "self", action: "read",
    }), /DM space types are never granted/);
  }
});

test("no server-side scope builder ever grants an org.slack.dm scope", () => {
  const serviceRef = "did:web:slack.example#atproto_slack_admin";
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
    ...permissionScopeFor("workspaceAuthority", { workspaceDid: "did:plc:owner" }),
    operatorMethodScope("org.slack.operator.execute", serviceRef),
    "atproto",
  ];
  assert.ok(nonDmScopes.length > 0);
  for (const scope of nonDmScopes) assert.ok(!scope.includes("org.slack.dm"), scope);
});

test("the server's login scope (src/auth/oauth.ts default + WORKSPACE_DISCOVERY_SCOPE) carries no DM scope", () => {
  const loginScope = ["atproto", WORKSPACE_DISCOVERY_SCOPE];
  for (const scope of loginScope) assert.ok(!scope.includes("org.slack.dm"), scope);
});
