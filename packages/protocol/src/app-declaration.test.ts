import assert from "node:assert/strict";
import test from "node:test";
import { validateAppDeclaration } from "./registry";

test("an app declaration names the app, and is nothing but its own record", () => {
  const declaration = { $type: "new.flock.app.declaration", name: "Echo", description: "Says it back.", createdAt: "2026-11-11T12:00:00.000Z" };
  assert.deepEqual(validateAppDeclaration(declaration), { valid: true });
  assert.deepEqual(validateAppDeclaration({ $type: "new.flock.app.declaration", name: "Echo", createdAt: "2026-11-11T12:00:00.000Z" }), { valid: true }, "the description is optional");
  const cases: unknown[] = [
    null, "Echo", [declaration],
    { ...declaration, $type: "new.flock.dm.declaration" },
    { ...declaration, $type: undefined },
    { ...declaration, name: "" },
    { ...declaration, name: "x".repeat(65) },
    { ...declaration, description: "x".repeat(301) },
    { ...declaration, name: undefined },
    { ...declaration, createdAt: "yesterday" },
  ];
  for (const value of cases) assert.equal(validateAppDeclaration(value).valid, false, JSON.stringify(value));
});
