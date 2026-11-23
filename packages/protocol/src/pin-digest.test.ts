import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  computeDistManifest,
  EXPECTED_PIN,
  sha256Hex,
  verifyPinnedCheckout,
} from "../../../scripts/verify-pinned-checkout.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function createSyntheticPinFixture() {
  const root = mkdtempSync(join(tmpdir(), "flock-pin-digest-"));
  const pinDir = join(root, "pin");
  const appRepoDir = join(root, "app");
  mkdirSync(join(pinDir, "packages/space/src"), { recursive: true });
  mkdirSync(join(pinDir, "packages/space/dist"), { recursive: true });
  mkdirSync(join(pinDir, "packages/lex-cli/dist"), { recursive: true });
  mkdirSync(join(pinDir, "packages/star/dist"), { recursive: true });
  mkdirSync(join(pinDir, "packages/dev-env/dist"), { recursive: true });
  mkdirSync(join(pinDir, "packages/space/node_modules/fake/dist"), { recursive: true });
  mkdirSync(join(appRepoDir, "protocol-tests/atproto"), { recursive: true });

  const baseCred = "export const skew = 5;\n";
  const baseCredTest = "export const testSkew = 5;\n";
  writeFileSync(join(pinDir, "packages/space/src/credential.ts"), baseCred);
  writeFileSync(join(pinDir, "packages/space/src/credential.test.ts"), baseCredTest);
  writeFileSync(join(pinDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(join(pinDir, "packages/lex-cli/dist/index.js"), "export const lexCli = true;\n");
  writeFileSync(join(pinDir, "packages/space/dist/credential.js"), "export const skew = 0;\n");
  writeFileSync(join(pinDir, "packages/star/dist/index.js"), "export const star = true;\n");
  writeFileSync(join(pinDir, "packages/dev-env/dist/index.js"), "export const devEnv = true;\n");
  // UTF-16 code-unit sort check: '-' (0x2D) < '/' (0x2F), so `a-b/dist/x.js` < `a/dist/x.js` in UTF-16!
  mkdirSync(join(pinDir, "packages/a-b/dist"), { recursive: true });
  mkdirSync(join(pinDir, "packages/a/dist"), { recursive: true });
  writeFileSync(join(pinDir, "packages/a-b/dist/x.js"), "export const ab = 1;\n");
  writeFileSync(join(pinDir, "packages/a/dist/x.js"), "export const a = 2;\n");

  execFileSync("git", ["init", "-q"], { cwd: pinDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: pinDir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: pinDir });
  writeFileSync(join(pinDir, ".gitignore"), "**/dist/\n**/node_modules/\n");
  execFileSync("git", ["add", ".gitignore", "pnpm-lock.yaml", "packages/space/src"], { cwd: pinDir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: pinDir });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: pinDir, encoding: "utf8" }).trim();

  // Apply two-file overlay
  const patchedCred = "export const skew = 0;\n";
  const patchedCredTest = "export const testSkew = 0;\n";
  writeFileSync(join(pinDir, "packages/space/src/credential.ts"), patchedCred);
  writeFileSync(join(pinDir, "packages/space/src/credential.test.ts"), patchedCredTest);
  // Ignored node_modules file must never affect dist manifest
  writeFileSync(join(pinDir, "packages/space/node_modules/fake/dist/ignored.js"), "ignored\n");

  const patchBytes = execFileSync("git", ["diff"], { cwd: pinDir });
  writeFileSync(join(appRepoDir, "protocol-tests/atproto/strict-credential-expiry.patch"), patchBytes);

  const dist = computeDistManifest(pinDir);
  const expected = {
    commit,
    patchPath: "protocol-tests/atproto/strict-credential-expiry.patch",
    patchSha256: sha256Hex(patchBytes),
    porcelainStatus: " M packages/space/src/credential.test.ts\n M packages/space/src/credential.ts\n",
    headObjects: {
      "packages/space/src/credential.ts": sha256Hex(Buffer.from(baseCred)),
      "packages/space/src/credential.test.ts": sha256Hex(Buffer.from(baseCredTest)),
    },
    workingTreeFiles: {
      "packages/space/src/credential.ts": sha256Hex(Buffer.from(patchedCred)),
      "packages/space/src/credential.test.ts": sha256Hex(Buffer.from(patchedCredTest)),
      "pnpm-lock.yaml": sha256Hex(Buffer.from("lockfileVersion: '9.0'\n")),
      "packages/lex-cli/dist/index.js": sha256Hex(Buffer.from("export const lexCli = true;\n")),
      "packages/space/dist/credential.js": sha256Hex(Buffer.from("export const skew = 0;\n")),
      "packages/star/dist/index.js": sha256Hex(Buffer.from("export const star = true;\n")),
      "packages/dev-env/dist/index.js": sha256Hex(Buffer.from("export const devEnv = true;\n")),
    },
    distFileCount: dist.fileCount,
    distManifestSha256: dist.manifestSha256,
  };

  return { root, pinDir, appRepoDir, dist, expected };
}

test("committed strict-credential-expiry.patch matches EXPECTED_PIN.patchSha256", async () => {
  const { readFileSync } = await import("node:fs");
  const patchBytes = readFileSync(join(REPO_ROOT, EXPECTED_PIN.patchPath));
  assert.equal(sha256Hex(patchBytes), EXPECTED_PIN.patchSha256);
});

test("verifyPinnedCheckout validates UTF-16 sorted dist manifests and rejects HEAD, patch, dirty-file, or dist tampering", () => {
  const fixture = createSyntheticPinFixture();
  try {
    // UTF-16 code-unit sort places 'packages/a-b/dist/x.js' before 'packages/a/dist/x.js'
    const idxAb = fixture.dist.files.indexOf("packages/a-b/dist/x.js");
    const idxA = fixture.dist.files.indexOf("packages/a/dist/x.js");
    assert.ok(idxAb >= 0 && idxA >= 0 && idxAb < idxA, "UTF-16 code-unit sort order enforced");
    assert.ok(!fixture.dist.files.some((f: string) => f.includes("node_modules")), "node_modules excluded from dist manifest");

    // Clean pass
    assert.equal(
      verifyPinnedCheckout(fixture.pinDir, {
        repoRoot: fixture.appRepoDir,
        expected: fixture.expected,
        force: true,
      }),
      fixture.pinDir,
    );

    // 1. Wrong commit fails
    assert.throws(
      () =>
        verifyPinnedCheckout(fixture.pinDir, {
          repoRoot: fixture.appRepoDir,
          expected: { ...fixture.expected, commit: "0".repeat(40) },
          force: true,
        }),
      /HEAD mismatch/,
    );

    // 2. Untracked file in checkout fails porcelain check
    writeFileSync(join(fixture.pinDir, "packages/space/src/rogue.ts"), "rogue\n");
    assert.throws(
      () =>
        verifyPinnedCheckout(fixture.pinDir, {
          repoRoot: fixture.appRepoDir,
          expected: fixture.expected,
          force: true,
        }),
      /dirty\/untracked file set mismatch/,
    );
    rmSync(join(fixture.pinDir, "packages/space/src/rogue.ts"));

    // 3. Modified overlay content fails diff digest check
    writeFileSync(join(fixture.pinDir, "packages/space/src/credential.ts"), "export const skew = 999;\n");
    assert.throws(
      () =>
        verifyPinnedCheckout(fixture.pinDir, {
          repoRoot: fixture.appRepoDir,
          expected: fixture.expected,
          force: true,
        }),
      /git diff digest mismatch/,
    );
    writeFileSync(join(fixture.pinDir, "packages/space/src/credential.ts"), "export const skew = 0;\n");

    // 4. Tampered dist artifact fails dist manifest check
    writeFileSync(join(fixture.pinDir, "packages/a/dist/x.js"), "export const a = 999;\n");
    assert.throws(
      () =>
        verifyPinnedCheckout(fixture.pinDir, {
          repoRoot: fixture.appRepoDir,
          expected: fixture.expected,
          force: true,
        }),
      /dist manifest digest mismatch/,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("verifyPinnedCheckout validates live ATPROTO_PIN_CHECKOUT when configured", (t) => {
  const checkout = process.env.ATPROTO_PIN_CHECKOUT ?? process.env.ATPROTO_PINNED_CHECKOUT;
  if (!checkout) {
    t.skip("ATPROTO_PIN_CHECKOUT not set in environment");
    return;
  }
  const verified = verifyPinnedCheckout(checkout, { repoRoot: REPO_ROOT, force: true });
  assert.ok(verified.length > 0);
});
