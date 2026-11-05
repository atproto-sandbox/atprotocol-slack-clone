import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { OPERATOR_METHODS, SLACK_COLLECTIONS, SLACK_SPACE_TYPES, workspaceAuthorityScopes } from "./permission-sets";

type LexPermission = { type: "permission"; resource: "space" | "rpc"; spaceType?: string; authority?: string; skey?: string; collection?: string[]; action?: string[]; manage?: string[]; lxm?: string[] };

function readPermissionSet(name: string): LexPermission[] {
  const document = JSON.parse(readFileSync(join(process.cwd(), "lexicons/org/slack/permissions", `${name}.json`), "utf8")) as { defs: { main: { permissions: LexPermission[] } } };
  return document.defs.main.permissions;
}

/** The pinned scope grammar's defaults: an omitted `authority` is `self`, an omitted `skey` is `*`. Parameters compare as sorted sets. */
function normalized(parts: { type?: string; authority?: string; skey?: string; collection?: readonly string[]; action?: readonly string[]; manage?: readonly string[] }): string {
  return JSON.stringify({
    type: parts.type,
    authority: parts.authority ?? "self",
    skey: parts.skey ?? "*",
    collection: [...(parts.collection ?? [])].sort(),
    action: [...(parts.action ?? [])].sort(),
    manage: [...(parts.manage ?? [])].sort(),
  });
}

function fromScopeString(scope: string): string {
  const [head, query = ""] = scope.split("?");
  const params = new URLSearchParams(query);
  return normalized({
    type: head.slice("space:".length),
    authority: params.get("authority") ?? undefined,
    skey: params.get("skey") ?? undefined,
    collection: params.getAll("collection"),
    action: params.getAll("action"),
    manage: params.getAll("manage"),
  });
}

test("the published workspaceAuthority permission set grants exactly the scopes the app requests for a workspace authority", () => {
  // #given the space grants of the published permission set and the scopes the app builds at runtime
  const published = readPermissionSet("workspaceAuthority").filter((permission) => permission.resource === "space")
    .map((permission) => normalized({ ...permission, type: permission.spaceType })).sort();
  const requested = workspaceAuthorityScopes().map(fromScopeString).sort();

  // #then they are the same set, so a client that includes the published set asks for what the app does
  assert.deepEqual(published, requested);
});

test("the published workspaceAuthority permission set grants the operator methods the app calls, with the audience inherited", () => {
  const rpc = readPermissionSet("workspaceAuthority").filter((permission) => permission.resource === "rpc");
  assert.equal(rpc.length, 1);
  assert.deepEqual([...rpc[0]!.lxm!].sort(), [...OPERATOR_METHODS].sort());
});

test("every space type and collection a published permission set names is one this app defines", () => {
  const spaceTypes = new Set<string>(Object.values(SLACK_SPACE_TYPES));
  const collections = new Set<string>(Object.values(SLACK_COLLECTIONS));
  for (const name of ["member", "workspaceAuthority"]) {
    for (const permission of readPermissionSet(name).filter((entry) => entry.resource === "space")) {
      assert.ok(spaceTypes.has(permission.spaceType!), `${name}: unknown space type ${permission.spaceType}`);
      for (const collection of permission.collection ?? []) assert.ok(collections.has(collection), `${name}: unknown collection ${collection}`);
    }
  }
});
