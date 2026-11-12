import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// R9's gate: an app is built on the client alone. The echo bot depends on `@flock/client` and on nothing else of this
// repository or of npm, so what it does any third party can do with the same package.
const root = fileURLToPath(new URL("..", import.meta.url));

test("the echo bot depends on the client alone, and imports nothing else", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), ["@flock/client"]);
  assert.equal(manifest.devDependencies, undefined);
  for (const file of readdirSync(join(root, "src")).filter((name) => name.endsWith(".ts"))) {
    const source = readFileSync(join(root, "src", file), "utf8");
    for (const [, specifier] of source.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)) {
      assert.ok(specifier!.startsWith("./") || specifier!.startsWith("node:") || specifier!.startsWith("@flock/client/"), `${file} imports ${specifier}`);
    }
  }
});
