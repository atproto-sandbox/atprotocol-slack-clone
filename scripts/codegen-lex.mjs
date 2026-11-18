import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const checkout = process.env.ATPROTO_PIN_CHECKOUT ?? process.env.ATPROTO_PINNED_CHECKOUT;
const expectedCommit = "6747610566eee1b6d743617bd8eb1136adccb362";

if (!checkout) {
  throw new Error(
    "Set ATPROTO_PIN_CHECKOUT to the atproto checkout at the protocol pin before regenerating Lexicon clients.",
  );
}

const pinnedCheckout = resolve(checkout);
const actualCommit = execFileSync(
  "git",
  ["-C", pinnedCheckout, "rev-parse", "HEAD"],
  { encoding: "utf8" },
).trim();
if (actualCommit !== expectedCommit) {
  throw new Error(
    `Lexicon client generation requires ${expectedCommit}; found ${actualCommit}.`,
  );
}

const cli = resolve(pinnedCheckout, "packages/lex-cli/dist/index.js");
if (!existsSync(cli)) {
  throw new Error(
    "Build the pinned Lexicon CLI first with `pnpm build:tooling` in ATPROTO_PIN_CHECKOUT.",
  );
}

// Records the authority's PDS may publish into a space (policy and member list). The app never reads them, and
// generating a record type also generates a com.atproto.repo client that this app does not bundle.
const PUBLISHED_RECORD_TYPES = new Set([
  "packages/protocol/lexicons/com/atproto/space/policy.json",
  "packages/protocol/lexicons/com/atproto/memberspace/member.json",
]);

const inputs = [
  "packages/protocol/lexicons/new/flock/operator/*.json",
  "packages/protocol/lexicons/com/atproto/space/*.json",
  "packages/protocol/lexicons/com/atproto/memberspace/*.json",
  "packages/protocol/lexicons/com/atproto/managedspace/*.json",
  "packages/protocol/lexicons/com/atproto/personalspace/*.json",
  "packages/protocol/lexicons/com/atproto/server/getServiceAuth.json",
].flatMap((pattern) => {
  if (!pattern.includes("*")) return [pattern];
  const [directory, suffix] = pattern.split("/*");
  return readdirSync(resolve(root, directory))
    .filter((file) => file.endsWith(suffix))
    .map((file) => `${directory}/${file}`);
}).filter((input) => !PUBLISHED_RECORD_TYPES.has(input));

rmSync(resolve(root, "packages/protocol/src/lexicons/api"), { recursive: true, force: true });
execFileSync(
  process.execPath,
  [cli, "gen-api", "--yes", "packages/protocol/src/lexicons/api", ...inputs],
  { cwd: root, stdio: "inherit" },
);

// The published Lexicon runtime does not yet include the draft space-ref
// format used by this pinned protocol. The generated API types remain useful;
// this cast only bridges that type-version gap. App requests use the small
// draft-aware XRPC transport instead of constructing this Lexicons runtime.
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

// The generated XrpcClient class is not used: the app imports the generated types only, and sends requests through its own
// draft-aware transport (packages/protocol/src/atproto/xrpc.ts). Its constructor is typed against @atproto/xrpc's own (release) Lexicon
// package, which no longer matches the pinned draft Lexicon runtime the app validates records with, so it is not kept.
rmSync(resolve(root, "packages/protocol/src/lexicons/api/index.ts"));
