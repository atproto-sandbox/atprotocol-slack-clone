import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const ISOMORPHIC_PROTOCOL_MODULES = [
  "src/dm/**/*.{ts,tsx}",
  "src/protocol/**/*.{ts,tsx}",
  "src/atproto/space-key.ts",
  "src/atproto/kem-key.ts",
  "src/atproto/repo-failure.ts",
  "src/atproto/space-policy.ts",
  "src/atproto/space-credential-core.ts",
  "src/atproto/xrpc.ts",
  "src/atproto/record-pages.ts",
  "src/lib/bounded-json.ts",
  "src/atproto/valid-channel-messages.ts",
];
// Test files for the above run under Node's own test runner (`node --test`),
// so they need `node:*` imports even though the modules they exercise must
// stay browser-safe. They still may not reach into server-only app layers.
const ISOMORPHIC_PROTOCOL_TEST_FILES = ["src/dm/**/*.test.{ts,tsx}", "src/protocol/**/*.test.{ts,tsx}"];
const APP_LAYER_BOUNDARY = {
  group: [
    "@/lib/db", "@/lib/config", "@/auth/*", "@/operator/*", "@/workspaces/*",
    "@atproto/oauth-client-node", "undici", "@/atproto/identity",
  ],
  message: "Isomorphic DM/protocol modules must not depend on the server-only session, database, or SSRF-guarded fetch layer.",
};
const ONE_WAY_IMPORTS = {
  group: ["@/workspaces", "@/workspaces/*", "@/app", "@/app/*"],
  message: "Imports point one way: the atproto and operator layers must not depend on the member read model (src/workspaces) or the app.",
};
const NO_DM_IMPORT = {
  group: ["@/dm", "@/dm/*"],
  message: "M6 independence proof: this module must not import src/dm/** (see .ai/plans/dm-tasks/m6.md).",
};

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "src/lexicons/api/**", "next-env.d.ts"]),
  {
    // Listed before the isomorphic rule, which replaces this one for the isomorphic modules and repeats ONE_WAY_IMPORTS.
    files: ["src/atproto/**/*.{ts,tsx}", "src/operator/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [ONE_WAY_IMPORTS] }],
    },
  },
  {
    files: ISOMORPHIC_PROTOCOL_MODULES,
    ignores: ISOMORPHIC_PROTOCOL_TEST_FILES,
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          {
            group: ["node:*"],
            message: "Isomorphic DM/protocol modules must run in the browser and cannot import Node built-ins.",
          },
          APP_LAYER_BOUNDARY,
          ONE_WAY_IMPORTS,
        ],
      }],
    },
  },
  {
    files: ISOMORPHIC_PROTOCOL_TEST_FILES,
    rules: {
      "no-restricted-imports": ["error", { patterns: [APP_LAYER_BOUNDARY] }],
    },
  },
  {
    // M6: the independent reader must prove DM state is reconstructible from
    // published lexicons alone, without depending on the primary app's DM
    // engine (`src/dm/**`).
    files: ["src/reader/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [NO_DM_IMPORT] }],
    },
  },
  {
    // M6: DMs never touch server routes, tables, or cache. No handler under
    // `src/app/api/**` may import the DM engine.
    files: ["src/app/api/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [NO_DM_IMPORT] }],
    },
  },
]);
