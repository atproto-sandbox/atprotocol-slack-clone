import assert from "node:assert/strict";
import test from "node:test";
import { validateDmDeclaration } from "./records";

test("a declaration with the right type and a timestamp is valid", () => {
  assert.deepEqual(validateDmDeclaration({ $type: "org.slack.dm.declaration", createdAt: "2026-10-30T12:00:00.000Z" }), { valid: true });
});

test("a declaration that is malformed in any way is refused", () => {
  const good = { $type: "org.slack.dm.declaration", createdAt: "2026-10-30T12:00:00.000Z" };
  const cases: unknown[] = [
    null, undefined, "declaration", [], {},
    { ...good, $type: "app.bsky.actor.profile" },
    { ...good, createdAt: undefined },
    { ...good, createdAt: "yesterday" },
    { ...good, mode: "everyone" },
  ];
  for (const value of cases) assert.equal(validateDmDeclaration(value).valid, false, JSON.stringify(value));
});
