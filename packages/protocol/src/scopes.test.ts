import assert from "node:assert/strict";
import test from "node:test";
import { appGrantScopes, DM_BROWSER_SCOPES, OPERATOR_METHODS, operatorMethodsScope, workspaceAuthorityScopes } from "./scopes";

const serviceRef = "did:web:slack.example#atproto_flock_operator";

test("the operator scope lists exactly the published operator methods", () => {
  assert.equal(operatorMethodsScope(OPERATOR_METHODS, serviceRef), "rpc?lxm=new.flock.operator.execute&lxm=new.flock.operator.getOperation&lxm=new.flock.operator.listInboxWriters"
    + "&lxm=new.flock.operator.getChanges&lxm=new.flock.operator.createWorkspace&lxm=new.flock.operator.startAuthorityFlow"
    + "&lxm=new.flock.operator.listStalledOperations&aud=did:web:slack.example%23atproto_flock_operator");
});

test("operator RPC scopes preserve percent-encoded DID web ports", () => {
  assert.equal(operatorMethodsScope(["new.flock.operator.execute"], "did:web:localhost%3A3000#atproto_flock_operator"),
    "rpc?lxm=new.flock.operator.execute&aud=did:web:localhost%253A3000%23atproto_flock_operator");
});

test("workspace authority scopes contain no message or reaction writes", () => {
  const scopes = workspaceAuthorityScopes();
  assert.ok(scopes.some((scope) => scope.includes("manage=create&manage=update")));
  assert.ok(scopes.some((scope) => scope.includes("collection=new.flock.channel.roster")));
  assert.ok(scopes.every((scope) => !scope.includes("channel.message") && !scope.includes("channel.reaction")));
});

test("workspace authority combines equivalent read actions into compact scopes and emits no collection scope for app inboxes", () => {
  const scopes = workspaceAuthorityScopes();
  assert.ok(scopes.includes("space:new.flock.workspace?authority=self&skey=*&action=read_self&action=read&manage=create&manage=update"));
  assert.ok(scopes.includes("space:new.flock.inbox?authority=self&skey=*&action=read_self&action=read&manage=create&manage=update"));
  assert.ok(scopes.includes("space:new.flock.channel?authority=self&skey=*&action=read_self&action=read&manage=create&manage=update"));
  assert.ok(scopes.includes("space:new.flock.app.inbox?authority=self&skey=*&action=read_self&action=read&manage=create&manage=update"));
  assert.equal(scopes.filter((scope) => scope.startsWith("space:new.flock.app.inbox?")).length, 1, "the authority writes no records in an app inbox");
});

test("DM_BROWSER_SCOPES is the exact DM part of the browser grant (M3)", () => {
  assert.deepEqual(DM_BROWSER_SCOPES, [
    "atproto",
    "space:new.flock.dm.inbox?authority=*&collection=new.flock.dm.request&action=create&action=update&action=delete",
    "space:new.flock.dm.inbox?authority=self&action=read&manage=create&manage=update",
    "repo:new.flock.dm.declaration?action=create&action=update",
    "space:new.flock.dm.conversation?authority=self&collection=new.flock.dm.header&collection=new.flock.dm.message&collection=new.flock.dm.reaction&action=create&action=update&action=delete&manage=create&manage=update&manage=delete",
    "space:new.flock.dm.conversation?authority=*&action=read",
  ]);
});

test("the workspace authority grant, which the server holds, never carries a DM scope", () => {
  for (const scope of workspaceAuthorityScopes()) assert.ok(!scope.includes("new.flock.dm"), scope);
});

test("an app asks for its declaration, workspace/channel/app-inbox reads, channel writes, and the change feed: no workspace inbox and no DM", () => {
  assert.deepEqual(appGrantScopes("did:web:operator.example#atproto_flock_operator"), [
    "atproto",
    "repo:new.flock.app.declaration?action=create&action=update",
    "space:new.flock.workspace?authority=*&action=read",
    "space:new.flock.channel?authority=*&action=read",
    "space:new.flock.channel?authority=*&collection=new.flock.channel.message&collection=new.flock.channel.reaction&action=create&action=update&action=delete",
    "space:new.flock.app.inbox?authority=*&action=read",
    "rpc?lxm=new.flock.operator.getChanges&aud=did:web:operator.example%23atproto_flock_operator",
  ]);
});
