import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { COLLECTION, OPERATOR_METHOD, SPACE_TYPE } from "./nsids";
import {
  ATGRP_PARTICIPATE_SCOPES,
  DM_BROWSER_SCOPES,
  FLOCK_MEMBER_MODALITY_SPACE_SCOPES,
  LEGACY_OPERATOR_METHODS,
  legacyMemberGrantScopes,
  memberGrantScopes,
  OPERATOR_METHODS,
} from "./scopes";

type LexPermission = {
  type: "permission";
  resource: "space" | "rpc";
  spaceType?: string;
  authority?: string;
  skey?: string;
  collection?: string[];
  action?: string[];
  manage?: string[];
  lxm?: string[];
};

function readFlockPermissionSet(name: string): LexPermission[] {
  const document = JSON.parse(
    readFileSync(new URL(`../lexicons/new/flock/permissions/${name}.json`, import.meta.url), "utf8"),
  ) as { defs: { main: { permissions: LexPermission[] } } };
  return document.defs.main.permissions;
}

function readAtgrpPermissionSet(name: string): LexPermission[] {
  const document = JSON.parse(
    readFileSync(new URL(`../lexicons/org/atgrp/${name}.json`, import.meta.url), "utf8"),
  ) as { defs: { main: { permissions: LexPermission[] } } };
  return document.defs.main.permissions;
}

function normalized(parts: {
  type?: string;
  authority?: string;
  skey?: string;
  collection?: readonly string[];
  action?: readonly string[];
  manage?: readonly string[];
}): string {
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

test("ATGRP_PARTICIPATE_SCOPES matches org.atgrp.authParticipate 1-for-1", () => {
  const permissions = readAtgrpPermissionSet("authParticipate");
  const publishedSpaces = permissions
    .filter((p) => p.resource === "space")
    .map((p) => normalized({ ...p, type: p.spaceType }))
    .sort();
  const runtimeSpaces = ATGRP_PARTICIPATE_SCOPES.filter((s) => s.startsWith("space:"))
    .map(fromScopeString)
    .sort();
  assert.deepEqual(publishedSpaces, runtimeSpaces);

  const publishedRpc = [...permissions.find((p) => p.resource === "rpc")!.lxm!].sort();
  const runtimeRpcQuery = ATGRP_PARTICIPATE_SCOPES.find((s) => s.startsWith("rpc?"))!.split("?")[1]!;
  const runtimeParams = new URLSearchParams(runtimeRpcQuery);
  assert.equal(runtimeParams.get("aud"), "*");
  assert.deepEqual(runtimeParams.getAll("lxm").sort(), publishedRpc);
});

test("published new.flock.permissions.member matches FLOCK_MEMBER_MODALITY_SPACE_SCOPES and OPERATOR_METHODS", () => {
  const spaceTypes = new Set<string>(Object.values(SPACE_TYPE));
  const collections = new Set<string>(Object.values(COLLECTION));
  const permissions = readFlockPermissionSet("member");
  for (const permission of permissions.filter((entry) => entry.resource === "space")) {
    assert.ok(spaceTypes.has(permission.spaceType!), `unknown space type ${permission.spaceType}`);
    for (const collection of permission.collection ?? []) {
      assert.ok(collections.has(collection), `unknown collection ${collection}`);
    }
  }

  const published = permissions
    .filter((p) => p.resource === "space")
    .map((p) => normalized({ ...p, type: p.spaceType }))
    .sort();
  const requested = FLOCK_MEMBER_MODALITY_SPACE_SCOPES.map(fromScopeString).sort();
  assert.deepEqual(published, requested);
  assert.deepEqual([...permissions.find((p) => p.resource === "rpc")!.lxm!].sort(), [...OPERATOR_METHODS].sort());
});

test("legacyMemberGrantScopes keeps identical space permissions and omits notify-target RPC methods", () => {
  const serviceRef = "did:web:operator.test#atproto_flock_operator";
  const legacySpaces = legacyMemberGrantScopes(serviceRef)
    .filter((scope) => scope.startsWith("space:") && !DM_BROWSER_SCOPES.includes(scope))
    .map(fromScopeString)
    .sort();
  const currentSpaces = memberGrantScopes(serviceRef)
    .filter((scope) => scope.startsWith("space:") && !DM_BROWSER_SCOPES.includes(scope))
    .map(fromScopeString)
    .sort();
  assert.deepEqual(legacySpaces, currentSpaces);
  const publishedRpc = readFlockPermissionSet("member").find((p) => p.resource === "rpc")!.lxm!;
  assert.deepEqual(
    publishedRpc
      .filter((m) => m !== OPERATOR_METHOD.getDmNotifyTarget && m !== OPERATOR_METHOD.getSpaceNotifyTarget)
      .sort(),
    [...LEGACY_OPERATOR_METHODS].sort(),
  );
});
