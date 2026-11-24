import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const APP_ROOT = join(REPO_ROOT, "apps", "desk");
const SRC_ROOT = join(APP_ROOT, "src");

const FORBIDDEN_PACKAGES = new Set([
  "@flock/client",
  "@flock/web",
  "@flock/operator",
  "@flock/group-host",
  "@flock/net",
]);

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join(posix.sep);
}

function walkSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkSourceFiles(full));
    } else if (entry.isFile() && /\.(?:ts|tsx|mts)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out.sort();
}

function isTestFile(relFromSrc: string): boolean {
  return /\.test\.(?:ts|tsx|mts)$/.test(relFromSrc);
}

function isServerEntrypoint(relFromSrc: string): boolean {
  if (relFromSrc === "proxy.ts" || relFromSrc === "lib/loopback-redirect.ts") return true;
  if (/^app\/(?:.+\/)?(?:layout|page)\.tsx$/.test(relFromSrc)) return true;
  if (/^app\/(?:.+\/)?route\.tsx?$/.test(relFromSrc)) return true;
  return false;
}

function packageRootOf(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return null;
  if (specifier.startsWith("node:")) return "node:*";
  const parts = specifier.split("/");
  if (specifier.startsWith("@") && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return parts[0] ?? null;
}

type ExtractedSpecifiers = {
  staticSpecifiers: string[];
  computedDynamicImports: string[];
};

function extractModuleSpecifiers(filePath: string): ExtractedSpecifiers {
  const sourceText = readFileSync(filePath, "utf8");
  const sf = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const staticSpecifiers: string[] = [];
  const computedDynamicImports: string[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      staticSpecifiers.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      staticSpecifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isRequire) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) {
          staticSpecifiers.push(arg.text);
        } else {
          computedDynamicImports.push(node.getText(sf));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { staticSpecifiers, computedDynamicImports };
}

test("@flock/desk AST boundary: zero forbidden @flock/* imports anywhere and browser modules forbid node:* and @flock/deployment", () => {
  const pkgJson = JSON.parse(readFileSync(join(APP_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const prodAllowlist = new Set(Object.keys(pkgJson.dependencies ?? {}));

  const files = walkSourceFiles(SRC_ROOT);
  assert.ok(files.length > 0, "expected source files in apps/desk/src");

  for (const fullPath of files) {
    const relFromSrc = toPosix(relative(SRC_ROOT, fullPath));
    const relFromRepo = toPosix(relative(REPO_ROOT, fullPath));
    const isTest = isTestFile(relFromSrc);
    const serverEntry = isServerEntrypoint(relFromSrc);
    const { staticSpecifiers, computedDynamicImports } = extractModuleSpecifiers(fullPath);

    if (!isTest) {
      assert.deepEqual(
        computedDynamicImports,
        [],
        `Computed dynamic import/require is forbidden in production file ${relFromRepo}`,
      );
    }

    for (const spec of staticSpecifiers) {
      const root = packageRootOf(spec);
      if (root && FORBIDDEN_PACKAGES.has(root)) {
        assert.fail(`Forbidden package import "${spec}" in ${relFromRepo}`);
      }
      if (!isTest && root !== null) {
        if (!serverEntry && (root === "node:*" || root === "@flock/deployment")) {
          assert.fail(`Server-only import "${spec}" is forbidden in Desk browser/client module ${relFromRepo}`);
        }
        if (root !== "node:*" && !prodAllowlist.has(root)) {
          assert.fail(`Undeclared production dependency "${spec}" (${root}) in ${relFromRepo}`);
        }
      }
    }
  }
});

test("@flock/desk manifest & transitive production dependency closure contain zero forbidden @flock/* packages", () => {
  const workspacePkgDirs = new Map<string, string>();
  for (const group of ["packages", "apps"]) {
    const groupDir = join(REPO_ROOT, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgPath = join(groupDir, entry.name, "package.json");
      if (!existsSync(pkgPath)) continue;
      const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
      if (parsed.name) workspacePkgDirs.set(parsed.name, join(groupDir, entry.name));
    }
  }

  const deskPkg = JSON.parse(readFileSync(join(APP_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  for (const dep of [...Object.keys(deskPkg.dependencies ?? {}), ...Object.keys(deskPkg.devDependencies ?? {})]) {
    assert.equal(FORBIDDEN_PACKAGES.has(dep), false, `Forbidden package ${dep} declared in apps/desk/package.json`);
  }

  // Traverse production `dependencies` only across workspace packages.
  const visited = new Set<string>(["@flock/desk"]);
  const queue = Object.keys(deskPkg.dependencies ?? {});
  while (queue.length > 0) {
    const dep = queue.shift()!;
    assert.equal(FORBIDDEN_PACKAGES.has(dep), false, `Transitive production dependency reaches forbidden package ${dep}`);
    if (visited.has(dep)) continue;
    visited.add(dep);
    const wsDir = workspacePkgDirs.get(dep);
    if (!wsDir) continue;
    const depPkg = JSON.parse(readFileSync(join(wsDir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    for (const next of Object.keys(depPkg.dependencies ?? {})) {
      if (!visited.has(next)) queue.push(next);
    }
  }
});
