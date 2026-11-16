import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// R10c's boundary: the webhooks app is built on `@flock/client` alone, like the echo bot, with no other workspace or npm
// dependency, so any third party can build the same kind of integration on `@flock/client`.
const root = fileURLToPath(new URL("..", import.meta.url));

test("the webhooks app depends on the client alone, and imports nothing else", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), ["@flock/client"]);
  assert.equal(manifest.devDependencies, undefined);
  for (const file of readdirSync(join(root, "src")).filter((name) => name.endsWith(".ts"))) {
    const source = readFileSync(join(root, "src", file), "utf8");
    for (const [, specifier] of source.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)) {
      assert.ok(
        specifier!.startsWith("./") || specifier!.startsWith("node:") || specifier!.startsWith("@flock/client/"),
        `${file} imports ${specifier}`,
      );
    }
  }
});
