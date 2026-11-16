import assert from "node:assert/strict";
import test from "node:test";
import { validateAppDeclaration } from "./registry";

test("an app declaration names the app, optionally lists up to 25 unique commands, and is nothing but its own record", () => {
  const declaration = {
    $type: "new.flock.app.declaration",
    name: "Echo",
    description: "Says it back.",
    commands: [
      { name: "echo", description: "Repeats text in the channel.", usage: "<text>" },
      { name: "ping-2" },
    ],
    createdAt: "2026-11-11T12:00:00.000Z",
  };
  assert.deepEqual(validateAppDeclaration(declaration), { valid: true });
  assert.deepEqual(validateAppDeclaration({ $type: "new.flock.app.declaration", name: "Echo", createdAt: "2026-11-11T12:00:00.000Z" }), { valid: true }, "description and commands are optional");

  const maxCommands = Array.from({ length: 25 }, (_, index) => ({
    name: `cmd-${index}`,
    description: "😀".repeat(300),
    usage: "😀".repeat(100),
  }));
  assert.deepEqual(validateAppDeclaration({ ...declaration, commands: maxCommands }), { valid: true }, "25 commands at their bounds fit");

  const cases: unknown[] = [
    null, "Echo", [declaration],
    { ...declaration, $type: "new.flock.dm.declaration" },
    { ...declaration, $type: undefined },
    { ...declaration, name: "" },
    { ...declaration, name: "x".repeat(65) },
    { ...declaration, description: "x".repeat(301) },
    { ...declaration, name: undefined },
    { ...declaration, createdAt: "yesterday" },
    { ...declaration, commands: [{ name: "" }] },
    { ...declaration, commands: [{ name: "Echo" }] },
    { ...declaration, commands: [{ name: "with_underscore" }] },
    { ...declaration, commands: [{ name: "with space" }] },
    { ...declaration, commands: [{ name: "a".repeat(33) }] },
    { ...declaration, commands: [{ name: "dup" }, { name: "dup" }] },
    { ...declaration, commands: Array.from({ length: 26 }, (_, index) => ({ name: `c-${index}` })) },
    { ...declaration, commands: [{ name: "ok", description: "😀".repeat(301) }] },
    { ...declaration, commands: [{ name: "ok", usage: "😀".repeat(101) }] },
  ];
  for (const value of cases) assert.equal(validateAppDeclaration(value).valid, false, JSON.stringify(value).slice(0, 120));
});
