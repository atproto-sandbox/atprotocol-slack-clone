import assert from "node:assert/strict";
import test from "node:test";
import { canonicalOAuthScope } from "./oauth-scope";

test("OAuth scopes are deduplicated and sorted into a stable client identity", () => {
  assert.equal(canonicalOAuthScope(["space:custom", "atproto", "space:custom"]), "atproto space:custom");
  assert.equal(canonicalOAuthScope("atproto space:custom"), "atproto space:custom");
  assert.throws(() => canonicalOAuthScope(["space:custom"]), /include "atproto"/);
  assert.throws(() => canonicalOAuthScope("atproto injected\nscope"), /Invalid OAuth scope/);
});

test("an OAuth scope too large for a client identity is refused", () => {
  assert.throws(() => canonicalOAuthScope(`atproto space:${"a".repeat(128 * 1024)}`), /scope is too large/);
});
