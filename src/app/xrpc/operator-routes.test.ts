import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { NAMESPACE, OPERATOR_METHOD } from "@/protocol/nsids";

// Clients call the operator at /xrpc/<method NSID>, and the App Router serves a method only from a directory of that exact
// name, so a renamed method without a renamed directory answers 404.

const XRPC_ROUTES = join("src", "app", "xrpc");

test("every operator method is served at its NSID", () => {
  for (const method of Object.values(OPERATOR_METHOD)) {
    assert.ok(existsSync(join(XRPC_ROUTES, method, "route.ts")), `${method} has a route`);
  }
});

test("no route serves a method of this app's namespace that the app does not define", () => {
  const defined = new Set<string>(Object.values(OPERATOR_METHOD));
  const routes = readdirSync(XRPC_ROUTES, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  for (const route of routes.filter((name) => !name.startsWith("com.atproto."))) {
    assert.ok(route.startsWith(`${NAMESPACE}.`) && defined.has(route), `${route} is a method this app defines`);
  }
});
