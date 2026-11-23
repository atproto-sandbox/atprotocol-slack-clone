import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const EXPECTED_PIN = {
  commit: "6747610566eee1b6d743617bd8eb1136adccb362",
  patchPath: "protocol-tests/atproto/strict-credential-expiry.patch",
  patchSha256: "3f413baa779473b5466e8e6ca9edc92335f5056edbd13aa3d4bfc57a509b32dd",
  porcelainStatus: " M packages/space/src/credential.test.ts\n M packages/space/src/credential.ts\n",
  headObjects: {
    "packages/space/src/credential.ts": "3ee86eb9c38e80d0137920551d91fd7153499694a6367ef24548ffbb8d0002d8",
    "packages/space/src/credential.test.ts": "3e2bf642dcc9648ccadc6a253e25c9771d7c203a2ef9d5c6b67574db033b35b6",
  },
  workingTreeFiles: {
    "packages/space/src/credential.ts": "45b91e701942459675c923af665f5039f8d525c5ce3b5c01462f37606b48494d",
    "packages/space/src/credential.test.ts": "5fd14a9d04b4ca3ebcca1583e10348fee1bf8414d1aeb4c3f82d301c70b08eb3",
    "pnpm-lock.yaml": "a519b31150d0b978dd8c59c9ec3276a6f5418a98c5b118f6d6b1bcf269570864",
    "packages/lex-cli/dist/index.js": "3ee9586459253b4c337c398713ce3dc4d0b6f547ef80469c38735f3eb6b10249",
    "packages/space/dist/credential.js": "c7a97d2c3d354b10495458846b359d720aa2b1f17a32015d923615c75d3b95b6",
    "packages/star/dist/index.js": "8a44a47fc614b50244c59dd25346f74edabd46eb487d5bd2eb7b6d441795f415",
    "packages/dev-env/dist/index.js": "a8c9c16cfe2c5125ff1935b45a16ca23fb8e93fb184432df6064d00cefd5a62c",
  },
  distFileCount: 19_163,
  distManifestSha256: "308383a44a5df954b98384fd254806e7c9997a75348635decc9f9c9f2f738a73",
};

const DIST_EXTENSIONS = new Set([".js", ".mjs", ".ts", ".mts", ".json", ".map", ".css", ".html"]);

export function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

function compareUtf16(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toPosix(relPath) {
  return sep === "/" ? relPath : relPath.split(sep).join(posix.sep);
}

function hasDistExtension(relPath) {
  const dot = relPath.lastIndexOf(".");
  if (dot === -1) return false;
  return DIST_EXTENSIONS.has(relPath.slice(dot));
}

export function computeDistManifest(pinRoot) {
  const resolvedRoot = resolve(pinRoot);
  const packagesDir = join(resolvedRoot, "packages");
  if (!existsSync(packagesDir)) {
    throw new Error(`Pinned checkout missing packages directory: ${packagesDir}`);
  }
  const relPaths = [];

  function walk(currentDir, inDist) {
    const entries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const fullPath = join(currentDir, entry.name);
      const stat = lstatSync(fullPath);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        walk(fullPath, inDist || entry.name === "dist");
      } else if (inDist && stat.isFile()) {
        const rel = toPosix(relative(resolvedRoot, fullPath));
        if (hasDistExtension(rel)) {
          relPaths.push(rel);
        }
      }
    }
  }

  walk(packagesDir, false);
  relPaths.sort(compareUtf16);

  const manifestLines = relPaths.map((rel) => {
    const digest = sha256Hex(readFileSync(join(resolvedRoot, rel)));
    return `${digest}  ${rel}\n`;
  });
  const manifestText = manifestLines.join("");
  return {
    fileCount: relPaths.length,
    manifestSha256: sha256Hex(Buffer.from(manifestText, "utf8")),
    files: relPaths,
  };
}

let cachedVerifiedPinPath = null;

export function verifyPinnedCheckout(pinCheckoutPath, options = {}) {
  if (!pinCheckoutPath) {
    throw new Error(
      "Set ATPROTO_PIN_CHECKOUT (or ATPROTO_PINNED_CHECKOUT) to the pinned @atproto Spaces checkout.",
    );
  }
  const resolvedPin = resolve(pinCheckoutPath);
  const repoRoot = resolve(
    options.repoRoot ?? fileURLToPath(new URL("..", import.meta.url)),
  );
  const expected = { ...EXPECTED_PIN, ...options.expected };

  if (!options.force && cachedVerifiedPinPath === `${resolvedPin}\0${repoRoot}`) {
    return resolvedPin;
  }

  const headCommit = execFileSync("git", ["-C", resolvedPin, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (headCommit !== expected.commit) {
    throw new Error(
      `Pinned checkout HEAD mismatch: expected ${expected.commit}, found ${headCommit}.`,
    );
  }

  for (const [objectPath, expectedDigest] of Object.entries(expected.headObjects)) {
    const rawObject = execFileSync("git", ["-C", resolvedPin, "show", `HEAD:${objectPath}`], {
      maxBuffer: 16 * 1024 * 1024,
    });
    const actualDigest = sha256Hex(rawObject);
    if (actualDigest !== expectedDigest) {
      throw new Error(
        `Pinned checkout base object HEAD:${objectPath} digest mismatch: expected ${expectedDigest}, found ${actualDigest}.`,
      );
    }
  }

  const patchFullPath = resolve(repoRoot, expected.patchPath);
  if (!existsSync(patchFullPath)) {
    throw new Error(`Committed overlay patch missing at ${patchFullPath}.`);
  }
  const patchBytes = readFileSync(patchFullPath);
  const patchDigest = sha256Hex(patchBytes);
  if (patchDigest !== expected.patchSha256) {
    throw new Error(
      `Committed overlay patch ${expected.patchPath} digest mismatch: expected ${expected.patchSha256}, found ${patchDigest}.`,
    );
  }

  const statusOutput = execFileSync(
    "git",
    ["-C", resolvedPin, "status", "--porcelain", "--untracked-files=all"],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (statusOutput !== expected.porcelainStatus) {
    throw new Error(
      `Pinned checkout dirty/untracked file set mismatch.\nExpected:\n${JSON.stringify(expected.porcelainStatus)}\nActual:\n${JSON.stringify(statusOutput)}`,
    );
  }

  const diffBytes = execFileSync("git", ["-C", resolvedPin, "diff"], {
    maxBuffer: 16 * 1024 * 1024,
  });
  const diffDigest = sha256Hex(diffBytes);
  if (diffDigest !== expected.patchSha256) {
    throw new Error(
      `Pinned checkout git diff digest mismatch against ${expected.patchPath}: expected ${expected.patchSha256}, found ${diffDigest}.`,
    );
  }

  for (const [relPath, expectedDigest] of Object.entries(expected.workingTreeFiles)) {
    const fileFull = join(resolvedPin, relPath);
    if (!existsSync(fileFull)) {
      throw new Error(`Pinned checkout missing required file ${relPath} (did you build the pinned checkout?).`);
    }
    const actualDigest = sha256Hex(readFileSync(fileFull));
    if (actualDigest !== expectedDigest) {
      throw new Error(
        `Pinned checkout file ${relPath} digest mismatch: expected ${expectedDigest}, found ${actualDigest}.`,
      );
    }
  }

  const distManifest = computeDistManifest(resolvedPin);
  if (distManifest.fileCount !== expected.distFileCount) {
    throw new Error(
      `Pinned checkout dist file count mismatch: expected ${expected.distFileCount}, found ${distManifest.fileCount}.`,
    );
  }
  if (distManifest.manifestSha256 !== expected.distManifestSha256) {
    throw new Error(
      `Pinned checkout dist manifest digest mismatch: expected ${expected.distManifestSha256}, found ${distManifest.manifestSha256}.`,
    );
  }

  cachedVerifiedPinPath = `${resolvedPin}\0${repoRoot}`;
  return resolvedPin;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const checkout = process.argv[2] ?? process.env.ATPROTO_PIN_CHECKOUT ?? process.env.ATPROTO_PINNED_CHECKOUT;
  const verified = verifyPinnedCheckout(checkout, { force: true });
  process.stdout.write(`Verified pinned @atproto Spaces checkout at ${verified}\n`);
}
