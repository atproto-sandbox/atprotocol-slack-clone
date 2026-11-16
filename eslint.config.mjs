import { readFileSync } from "node:fs";
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Package boundaries are the packages' own dependency lists: a package imports only what its package.json declares
// (`import/no-extraneous-dependencies`), so the protocol and client packages cannot reach the server, the reader only the
// protocol, and neither app the other. The rules below say what a dependency list cannot.

/** React is the web app's dependency, so its version is read from there. */
const WEB_REACT_VERSION = JSON.parse(readFileSync(new URL("./apps/web/package.json", import.meta.url), "utf8")).dependencies.react;

/** Code that runs in a browser. */
const BROWSER_CODE = ["packages/protocol/src/**/*.{ts,tsx}", "packages/client/src/**/*.{ts,tsx}", "apps/web/src/browser/**/*.{ts,tsx}"];
/** Tests and test fixtures, which run under Node's test runner and may use a package's dev dependencies. */
const NODE_TESTS = ["**/*.test.{ts,tsx}", "packages/client/src/testing/**"];
/** The client's Node entry (`@flock/client/node/*`): an app's OAuth session and transport, for apps that run on Node. */
const CLIENT_NODE_ENTRY = ["packages/client/src/node/**"];
const NO_NODE_BUILTINS = {
  group: ["node:*"],
  message: "This code runs in a browser and cannot import Node built-ins.",
};
const NO_SERVER_CONFIG = {
  group: ["@flock/deployment/*"],
  message: "Browser code reads its configuration from the page (browser-session-config.ts), not from the server's environment.",
};
const NO_APP_LAYER = {
  group: ["../app/*", "@flock/web/app/*"],
  message: "Browser code sits below the web app's UI: the UI imports it, not the other way round.",
};
const MEMBER_LIST_WRITES = {
  group: ["**/atproto/space-ops"],
  importNames: ["putSpaceMember", "putSpaceMembers", "removeSpaceMember", "removeSpaceMembers"],
  message: "The operator changes member lists through apps/operator/src/operator/members.ts, which drops the change feed's cached list.",
};
const NO_CLIENT_NODE_ENTRY = {
  group: ["**/node/*", "@flock/client/node/*", "@flock/net", "@flock/net/*"],
  message: "Only a Node process imports the client's Node entry or @flock/net; browser code and the web app never do.",
};
const NO_DM_IMPORT = {
  group: ["@flock/client/dm/*"],
  message: "M6 independence proof: this module must not import the DM engine (see .ai/plans/dm-tasks/m6.md).",
};

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores(["**/.next/**", "packages/protocol/src/lexicons/api/**", "**/next-env.d.ts"]),
  { settings: { react: { version: WEB_REACT_VERSION }, next: { rootDir: "apps/web/" } } },
  {
    files: ["packages/*/src/**/*.{ts,tsx}", "apps/*/src/**/*.{ts,tsx}", "apps/*/scripts/**/*.ts", "apps/*/next.config.ts"],
    rules: {
      "import/no-extraneous-dependencies": ["error", { includeTypes: true, devDependencies: NODE_TESTS, optionalDependencies: false, peerDependencies: false }],
      "import/no-relative-packages": "error",
    },
  },
  {
    // The root's own code (the suites and scripts) is held to the root's package.json, test code throughout.
    files: ["bdd/**/*.ts", "protocol-tests/**/*.ts", "scripts/**/*.{ts,mjs}"],
    ignores: ["protocol-tests/atproto/**"],
    rules: {
      "import/no-extraneous-dependencies": ["error", { includeTypes: true, devDependencies: true }],
    },
  },
  {
    // Browser code and its tests: neither the server's configuration nor the UI above it. (Listed before the next block,
    // which replaces this rule for non-test files and repeats these patterns.)
    files: BROWSER_CODE,
    rules: {
      "no-restricted-imports": ["error", { patterns: [NO_SERVER_CONFIG, NO_APP_LAYER] }],
    },
  },
  {
    files: BROWSER_CODE,
    ignores: [...NODE_TESTS, ...CLIENT_NODE_ENTRY],
    rules: {
      "no-restricted-imports": ["error", { patterns: [NO_NODE_BUILTINS, NO_SERVER_CONFIG, NO_APP_LAYER, NO_CLIENT_NODE_ENTRY] }],
    },
  },
  {
    files: ["apps/operator/src/**/*.{ts,tsx}"],
    ignores: ["apps/operator/src/operator/members.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [MEMBER_LIST_WRITES] }],
    },
  },
  {
    // The web app, above its browser code, is no Node process either.
    files: ["apps/web/src/**/*.{ts,tsx}"],
    ignores: ["apps/web/src/browser/**", ...NODE_TESTS],
    rules: {
      "no-restricted-imports": ["error", { patterns: [NO_CLIENT_NODE_ENTRY] }],
    },
  },
  {
    // M6: DMs never touch server routes, tables, or cache. No route handler the web app's server has (the sign-in client's
    // metadata) may import the DM engine.
    files: ["apps/web/src/app/**/route.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [NO_DM_IMPORT, NO_CLIENT_NODE_ENTRY] }],
    },
  },
]);
