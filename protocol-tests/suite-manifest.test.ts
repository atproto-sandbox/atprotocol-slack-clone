import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, posix, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROTOCOL_TESTS_DIR = join(REPO_ROOT, "protocol-tests");

export const KNOWN_NON_SUITE_HELPERS = [
  "protocol-tests/fixture-temp.ts",
  "protocol-tests/recover-pending-operation.ts",
] as const;

const ROOT_TEST_SCRIPTS = [
  "test",
  "test:sync-budget",
  "test:sync-budget:browser",
  "test:browser",
  "test:performance",
  "test:acceptance",
] as const;

type RootScriptName = (typeof ROOT_TEST_SCRIPTS)[number];

function toPosix(relPath: string): string {
  return sep === "/" ? relPath : relPath.split(sep).join(posix.sep);
}

function walkProtocolTestTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    const rel = toPosix(relative(REPO_ROOT, fullPath));
    // Exclude ONLY protocol-tests/support/**; everything else (including protocol-tests/atproto/**) is walked!
    if (rel === "protocol-tests/support" || rel.startsWith("protocol-tests/support/")) {
      continue;
    }
    if (entry.isDirectory()) {
      out.push(...walkProtocolTestTsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(rel);
    }
  }
  return out.sort();
}

function extractProtocolTestRefsFromScript(scriptCommand: string): string[] {
  const matches = scriptCommand.match(/protocol-tests\/[A-Za-z0-9_./-]+\.ts/g) ?? [];
  return matches;
}

function classifyExpectedScript(relPath: string): RootScriptName {
  if (relPath === "protocol-tests/suite-manifest.test.ts") return "test";
  if (relPath === "protocol-tests/sync-budget.ts") return "test:sync-budget";
  if (relPath === "protocol-tests/browser/sync-budget.ts") return "test:sync-budget:browser";
  if (/^protocol-tests\/browser\/[^/]+\.spec\.ts$/.test(relPath)) return "test:browser";
  if (/^protocol-tests\/[^/]*performance[^/]*\.test\.ts$/.test(relPath)) return "test:performance";
  if (/^protocol-tests\/(?:.+\/)?[^/]+\.test\.ts$/.test(relPath)) return "test:acceptance";
  throw new Error(
    `Unclassified file under protocol-tests/: ${relPath}. Either wire it into a root test script or move support code under protocol-tests/support/.`,
  );
}

test("zero-exclusion bidirectional 1-to-1 suite manifest across all 6 root test scripts and protocol-tests/**/*.ts", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string | undefined>;
  };

  const allTsFiles = walkProtocolTestTsFiles(PROTOCOL_TESTS_DIR);
  const helperSet = new Set<string>(KNOWN_NON_SUITE_HELPERS);

  // 1. Every KNOWN_NON_SUITE_HELPER must exist on disk, be absent from all root scripts, and be referenced by >= 1 suite/support file!
  for (const helper of KNOWN_NON_SUITE_HELPERS) {
    assert.ok(allTsFiles.includes(helper), `Expected helper ${helper} to exist in protocol-tests/`);
  }

  const scriptRefsByName = new Map<RootScriptName, string[]>();
  const allScriptRefs: Array<{ script: RootScriptName; file: string }> = [];

  for (const scriptName of ROOT_TEST_SCRIPTS) {
    const cmd = pkg.scripts[scriptName];
    assert.ok(typeof cmd === "string" && cmd.length > 0, `Missing root package.json script "${scriptName}"`);
    const refs = extractProtocolTestRefsFromScript(cmd);
    // Assert no duplicate references inside the same script
    assert.equal(new Set(refs).size, refs.length, `Duplicate protocol-tests file reference in "${scriptName}"`);
    for (const file of refs) {
      assert.equal(helperSet.has(file), false, `Helper ${file} must not appear in root script "${scriptName}"`);
      assert.ok(statSync(join(REPO_ROOT, file)).isFile(), `Script "${scriptName}" references missing file ${file}`);
      allScriptRefs.push({ script: scriptName, file });
    }
    scriptRefsByName.set(scriptName, [...refs].sort());
  }

  // 2. Assert every KNOWN_NON_SUITE_HELPER is referenced by at least one suite or support file under protocol-tests/**
  const allSourcesToScan: string[] = [];
  const collectAllSources = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) collectAllSources(full);
      else if (entry.isFile() && entry.name.endsWith(".ts")) allSourcesToScan.push(full);
    }
  };
  collectAllSources(PROTOCOL_TESTS_DIR);

  for (const helper of KNOWN_NON_SUITE_HELPERS) {
    const helperAbs = join(REPO_ROOT, helper);
    const stem = basename(helper, ".ts");
    const referenced = allSourcesToScan.some((srcPath) => {
      if (srcPath === helperAbs || srcPath === fileURLToPath(import.meta.url)) return false;
      const text = readFileSync(srcPath, "utf8");
      return text.includes(stem);
    });
    assert.equal(referenced, true, `KNOWN_NON_SUITE_HELPER ${helper} is unreferenced across protocol-tests/`);
  }

  // 3. Assert exact 1-to-1 partition: every non-helper file belongs to strictly 1 expected script, and no file appears in >1 script!
  const nonHelperFiles = allTsFiles.filter((f) => !helperSet.has(f));
  const seenAcrossScripts = new Map<string, RootScriptName>();
  for (const { script, file } of allScriptRefs) {
    const prior = seenAcrossScripts.get(file);
    assert.equal(prior, undefined, `File ${file} is wired in multiple root scripts: "${prior}" and "${script}"`);
    seenAcrossScripts.set(file, script);
  }

  const expectedByScript = new Map<RootScriptName, string[]>(ROOT_TEST_SCRIPTS.map((s) => [s, []]));
  for (const file of nonHelperFiles) {
    const expectedScript = classifyExpectedScript(file);
    expectedByScript.get(expectedScript)!.push(file);
  }

  for (const scriptName of ROOT_TEST_SCRIPTS) {
    const expectedFiles = expectedByScript.get(scriptName)!.sort();
    const actualFiles = scriptRefsByName.get(scriptName)!;
    assert.deepEqual(
      actualFiles,
      expectedFiles,
      `Mismatch between disk files and root script "${scriptName}"`,
    );
  }

  // 4. Explicitly confirm all 3 surviving atproto conformance suites and opensocial-groups suites are covered!
  const acceptanceSet = new Set(scriptRefsByName.get("test:acceptance"));
  assert.ok(acceptanceSet.has("protocol-tests/opensocial-groups.test.ts"));
  assert.ok(acceptanceSet.has("protocol-tests/atproto/slack-dm-conformance.test.ts"));
  assert.ok(acceptanceSet.has("protocol-tests/atproto/platform-spike-k2-confidential-client.test.ts"));
  assert.ok(acceptanceSet.has("protocol-tests/atproto/platform-spike-k5-oplog.test.ts"));

  const browserSet = new Set(scriptRefsByName.get("test:browser"));
  assert.ok(browserSet.has("protocol-tests/browser/opensocial-groups.spec.ts"));
});
