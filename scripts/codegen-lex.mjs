import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { verifyPinnedCheckout } from "./verify-pinned-checkout.mjs";

const root = process.cwd();
const checkout = process.env.ATPROTO_PIN_CHECKOUT ?? process.env.ATPROTO_PINNED_CHECKOUT;
const pinnedCheckout = verifyPinnedCheckout(checkout);

const cli = resolve(pinnedCheckout, "packages/lex-cli/dist/index.js");
if (!existsSync(cli)) {
  throw new Error(
    "Build the pinned Lexicon CLI first with `pnpm build:tooling` in ATPROTO_PIN_CHECKOUT.",
  );
}

const SKIPPED_MAIN_TYPES = new Set(["record", "space", "permission-set"]);

const patterns = [
  "packages/protocol/lexicons/new/flock/operator/*.json",
  "packages/protocol/lexicons/group/opensocial/*.json",
  "packages/protocol/lexicons/com/atproto/space/*.json",
  "packages/protocol/lexicons/com/atproto/memberspace/*.json",
  "packages/protocol/lexicons/com/atproto/managedspace/*.json",
  "packages/protocol/lexicons/com/atproto/personalspace/*.json",
  "packages/protocol/lexicons/com/atproto/identity/*.json",
  "packages/protocol/lexicons/com/atproto/label/*.json",
  "packages/protocol/lexicons/com/atproto/repo/*.json",
  "packages/protocol/lexicons/com/atproto/server/*.json",
  "packages/protocol/lexicons/com/atproto/sync/*.json",
];

const inputs = patterns
  .flatMap((pattern) => {
    if (!pattern.includes("*")) return [pattern];
    const [directory, suffix] = pattern.split("/*");
    return readdirSync(resolve(root, directory))
      .filter((file) => file.endsWith(suffix))
      .sort()
      .map((file) => `${directory}/${file}`);
  })
  .filter((input) => {
    const doc = JSON.parse(readFileSync(resolve(root, input), "utf8"));
    const mainType = doc?.defs?.main?.type;
    return !SKIPPED_MAIN_TYPES.has(mainType);
  });

rmSync(resolve(root, "packages/protocol/src/lexicons/api"), { recursive: true, force: true });
execFileSync(
  process.execPath,
  [cli, "gen-api", "--yes", "packages/protocol/src/lexicons/api", ...inputs],
  { cwd: root, stdio: "inherit" },
);

// Bridge the draft LexiconDoc type across @atproto/lexicon snapshot versions.
const generatedLexicons = resolve(root, "packages/protocol/src/lexicons/api/lexicons.ts");
const source = readFileSync(generatedLexicons, "utf8");
const oldTypeGate =
  "} as const satisfies Record<string, LexiconDoc>\nexport const schemas = Object.values(schemaDict) satisfies LexiconDoc[]";
const newTypeGate =
  "} as const\nexport const schemas = Object.values(schemaDict) as unknown as LexiconDoc[]";
if (!source.includes(oldTypeGate)) {
  throw new Error("Pinned Lexicon CLI output changed; review the draft schema type bridge.");
}
writeFileSync(generatedLexicons, source.replace(oldTypeGate, newTypeGate));

// Remove the generated XrpcClient wrapper; callers import generated types and schemaDict/schemas directly.
rmSync(resolve(root, "packages/protocol/src/lexicons/api/index.ts"));
