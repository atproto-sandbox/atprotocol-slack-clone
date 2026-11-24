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
const BROWSER_CODE = [
  "packages/protocol/src/**/*.{ts,tsx}",
  "packages/client/src/**/*.{ts,tsx}",
  "packages/shell/src/**/*.{ts,tsx}",
  "apps/web/src/browser/**/*.{ts,tsx}",
];
/** Tests and test fixtures, which run under Node's test runner and may use a package's dev dependencies. */
const NODE_TESTS = [
  "**/*.test.{ts,tsx}",
  "packages/client/src/testing/**",
  "apps/operator/src/operator/testing/**",
];
const BROWSER_TEST_FILES = [
  "packages/protocol/src/**/*.test.{ts,tsx}",
  "packages/client/src/**/*.test.{ts,tsx}",
  "packages/client/src/testing/**/*.{ts,tsx}",
  "packages/shell/src/**/*.test.{ts,tsx}",
  "apps/web/src/browser/**/*.test.{ts,tsx}",
];
/** Desk Next.js server entrypoints that are permitted to use server config (`@flock/deployment`) and `node:*`. */
const DESK_SERVER_ENTRYPOINTS = [
  "apps/desk/src/proxy.ts",
  "apps/desk/src/lib/loopback-redirect.ts",
  "apps/desk/src/app/**/layout.tsx",
  "apps/desk/src/app/**/page.tsx",
  "apps/desk/src/app/**/route.{ts,tsx}",
];
/** The client's Node entry (`@flock/client/node/*`): an app's OAuth session and transport, for apps that run on Node. */
const CLIENT_NODE_ENTRY = ["packages/client/src/node/**"];
/** D11.11: entity-merge may only be imported by Tasks extension client, independent Tasks reader, entity-merge tests, and parity/protocol tests. */
const ENTITY_MERGE_ALLOWED = [
  "packages/protocol/src/entity-merge*.ts",
  "packages/client/src/ext/tasks/**",
  "packages/reader/src/independent-tasks*.ts",
  "packages/client/src/tasks-reader-parity.test.ts",
  "protocol-tests/**",
];
/** D11.11: extension modules must remain isolated behind engine.tasks and extension UI boundaries. */
const EXTENSION_IMPORT_ALLOWED = [
  "packages/client/src/ext/tasks/**",
  "packages/client/src/engine.ts",
  "packages/client/src/tasks-reader-parity.test.ts",
  "apps/web/src/app/ui/ext/tasks/**",
  "apps/web/src/app/(shell)/**/ext/tasks/**",
  "apps/web/src/app/ui/workspace-manager.tsx",
  "apps/web/src/app/ui/client-api.{ts,tsx}",
  "protocol-tests/**",
];
const ALL_BOUNDARY_SOURCE = [
  "packages/*/src/**/*.{ts,tsx}",
  "apps/*/src/**/*.{ts,tsx}",
  "apps/*/scripts/**/*.ts",
  "apps/*/next.config.ts",
  "bdd/**/*.ts",
  "scripts/**/*.{ts,mjs}",
];
const ALL_MEMBERSPACE_CHECKED_SOURCE = [
  ...ALL_BOUNDARY_SOURCE,
  "protocol-tests/**/*.ts",
];
/**
 * R13 OpenSocial hard-cut allowlist: only personal-PDS DM spaces, protocol primitives,
 * FakeNetwork, and explicit DM/negative-fixture tests may use `com.atproto.memberspace.{putMembers,removeMembers,listMembers}`.
 */
const MEMBERSPACE_FULL_ALLOWLIST = [
  "packages/protocol/src/scopes.ts",
  "packages/protocol/src/opensocial-lexicons.test.ts",
  "packages/protocol/src/atproto/record-pages.ts",
  "packages/protocol/src/atproto/record-pages.test.ts",
  "packages/protocol/src/atproto/space-policy.ts",
  "packages/protocol/src/atproto/space-policy.test.ts",
  "packages/client/src/dm/**",
  "packages/reader/src/independent-dm.ts",
  "packages/reader/src/independent-dm.test.ts",
  "packages/testing/src/fake-network.ts",
  "packages/testing/src/fake-network.test.ts",
  "packages/testing/src/space-credential-core.test.ts",
  "protocol-tests/dm-acceptance.test.ts",
  "protocol-tests/dm-performance.test.ts",
  "protocol-tests/opensocial-groups.test.ts",
  "protocol-tests/atproto/slack-dm-conformance.test.ts",
  "bdd/steps/dm-conversations.steps.ts",
  "bdd/steps/dm-policy.steps.ts",
  "bdd/support/dm-conversations-ui.ts",
  "bdd/support/dm-policy-ui.ts",
];
/**
 * `WorkspaceClient.ensureInvitesSpace()` (and its unit test) may call `com.atproto.memberspace.listMembers`
 * ONLY to verify zero members on personal `group.opensocial.invites/self`; `putMembers` and `removeMembers` remain forbidden.
 */
const MEMBERSPACE_LIST_ONLY_ALLOWLIST = [
  "packages/client/src/workspace-client.ts",
  "packages/client/src/workspace-client.test.ts",
  "packages/shell/src/invites.ts",
  "packages/shell/src/invites.test.ts",
];

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
const NO_CLIENT_NODE_ENTRY = {
  group: ["**/node/*", "@flock/client/node/*", "@flock/net", "@flock/net/*"],
  message: "Only a Node process imports the client's Node entry or @flock/net; browser code and the web app never do.",
};
const NO_DM_IMPORT = {
  group: ["@flock/client/dm/*"],
  message: "M6 independence proof: this module must not import the DM engine (see .ai/plans/dm-tasks/m6.md).",
};
const NO_ENTITY_MERGE_IMPORT = {
  group: ["@flock/protocol/entity-merge*", "**/entity-merge*", "./entity-merge*", "../entity-merge*"],
  message: "D11.11: entity-merge may only be imported by Tasks extension client, independent Tasks reader, entity-merge tests, and parity/protocol tests.",
};
const NO_EXTENSION_IMPORT = {
  group: ["@flock/client/ext/*", "@flock/client/ext", "**/ext/*", "./ext/*", "../ext/*", "!**/lexicons/**"],
  message: "D11.11: extension modules must remain isolated behind engine.tasks and extension UI boundaries.",
};
const NO_ENTITY_MERGE_DYNAMIC_IMPORT = {
  selector:
    "ImportExpression[source.value=/entity-merge/], ImportExpression:has(TemplateElement[value.raw=/entity-merge/]), ImportExpression:has(TemplateElement[value.cooked=/entity-merge/])",
  message: "D11.11: dynamic import of entity-merge is forbidden outside Tasks extension and independent reader boundaries.",
};
const NO_EXTENSION_DYNAMIC_IMPORT = {
  selector:
    "ImportExpression[source.value=/^(?!.*\\/lexicons\\/)(?:.*(?:^|\\/)ext(?:\\/|$)|@flock\\/client\\/ext(?:\\/|$))/], ImportExpression:has(TemplateElement[value.raw=/^(?!.*\\/lexicons\\/)(?:.*(?:^|\\/)ext(?:\\/|$)|@flock\\/client\\/ext(?:\\/|$))/]), ImportExpression:has(TemplateElement[value.cooked=/^(?!.*\\/lexicons\\/)(?:.*(?:^|\\/)ext(?:\\/|$)|@flock\\/client\\/ext(?:\\/|$))/])",
  message: "D11.11: dynamic import of client/UI extensions is forbidden outside extension boundaries.",
};
const NO_COMPUTED_DYNAMIC_IMPORT = {
  selector: 'ImportExpression:not([source.type="Literal"]):not([source.type="TemplateLiteral"][source.expressions.length=0])',
  message: "D11.11: non-static dynamic import() specifiers are forbidden in boundary-restricted modules.",
};
const NO_DESK_FORBIDDEN_IMPORTS = {
  group: [
    "@flock/client", "@flock/client/*",
    "@flock/web", "@flock/web/*",
    "@flock/operator", "@flock/operator/*",
    "@flock/group-host", "@flock/group-host/*",
    "@flock/net", "@flock/net/*",
  ],
  message: "Flock Desk independence boundary: Desk and Shell must never import @flock/client, @flock/web, @flock/operator, @flock/group-host, or @flock/net.",
};
const NO_SHELL_EXTRA_FORBIDDEN_IMPORTS = {
  group: [
    "@flock/reader", "@flock/reader/*",
    "@flock/deployment", "@flock/deployment/*",
  ],
  message: "Flock Shell independence boundary: @flock/shell must never import @flock/reader or @flock/deployment.",
};
const NO_DESK_CLIENT_SERVER_IMPORTS = {
  group: ["node:*", "@flock/deployment", "@flock/deployment/*"],
  message: "Desk browser/client modules must not import Node built-ins or @flock/deployment; pass public config via server page props.",
};
const NO_DESK_FORBIDDEN_DYNAMIC_IMPORT = {
  selector:
    "ImportExpression[source.value=/^@flock\\/(?:client|web|operator|group-host|net)(?:\\/|$)/], ImportExpression:has(TemplateElement[value.raw=/^@flock\\/(?:client|web|operator|group-host|net)(?:\\/|$)/]), ImportExpression:has(TemplateElement[value.cooked=/^@flock\\/(?:client|web|operator|group-host|net)(?:\\/|$)/])",
  message: "Flock Desk independence boundary: dynamic import of @flock/client, @flock/web, @flock/operator, @flock/group-host, or @flock/net is forbidden.",
};
const NO_SHELL_EXTRA_DYNAMIC_IMPORT = {
  selector:
    "ImportExpression[source.value=/^@flock\\/(?:reader|deployment)(?:\\/|$)/], ImportExpression:has(TemplateElement[value.raw=/^@flock\\/(?:reader|deployment)(?:\\/|$)/]), ImportExpression:has(TemplateElement[value.cooked=/^@flock\\/(?:reader|deployment)(?:\\/|$)/])",
  message: "Flock Shell independence boundary: dynamic import of @flock/reader or @flock/deployment is forbidden.",
};
const NO_DESK_CLIENT_SERVER_DYNAMIC_IMPORT = {
  selector:
    "ImportExpression[source.value=/^(?:node:|@flock\\/deployment(?:\\/|$))/], ImportExpression:has(TemplateElement[value.raw=/^(?:node:|@flock\\/deployment(?:\\/|$))/]), ImportExpression:has(TemplateElement[value.cooked=/^(?:node:|@flock\\/deployment(?:\\/|$))/])",
  message: "Desk browser/client modules must not dynamically import Node built-ins or @flock/deployment.",
};

const ALL_THREE_DOTTED_RE = /com\.atproto\.memberspace\.(putMembers|removeMembers|listMembers)\b/;
const MUTATE_ONLY_DOTTED_RE = /com\.atproto\.memberspace\.(putMembers|removeMembers)\b/;
const ALL_THREE_PATH_RE = /com\/atproto\/memberspace\/(putMembers|removeMembers|listMembers)(?:[./]|$)/;
const MUTATE_ONLY_PATH_RE = /com\/atproto\/memberspace\/(putMembers|removeMembers)(?:[./]|$)/;
const RECORD_PAGES_PATH_RE = /(?:^|\/)record-pages(?:\.[jt]s)?$/;

const flockBoundariesPlugin = {
  rules: {
    "no-legacy-memberspace": {
      meta: {
        type: "problem",
        schema: [
          {
            type: "object",
            properties: { allowListMembers: { type: "boolean" } },
            additionalProperties: false,
          },
        ],
      },
      create(context) {
        const allowListMembers = Boolean(context.options[0]?.allowListMembers);
        const dottedRe = allowListMembers ? MUTATE_ONLY_DOTTED_RE : ALL_THREE_DOTTED_RE;
        const pathRe = allowListMembers ? MUTATE_ONLY_PATH_RE : ALL_THREE_PATH_RE;
        const message =
          "R13 OpenSocial hard-cut: com.atproto.memberspace.{putMembers,removeMembers,listMembers} is forbidden outside personal-PDS DM and protocol boundaries; use group.opensocial.* governance.";

        function checkSourceSpecifier(node, value) {
          if (typeof value === "string" && pathRe.test(value)) {
            context.report({ node, message });
          }
        }

        return {
          Literal(node) {
            if (typeof node.value === "string" && (dottedRe.test(node.value) || pathRe.test(node.value))) {
              context.report({ node, message });
            }
          },
          TemplateElement(node) {
            const raw = node.value?.raw ?? "";
            const cooked = node.value?.cooked ?? "";
            if (dottedRe.test(raw) || dottedRe.test(cooked) || pathRe.test(raw) || pathRe.test(cooked)) {
              context.report({ node, message });
            }
          },
          ImportDeclaration(node) {
            const src = node.source?.value;
            checkSourceSpecifier(node, src);
            if (!allowListMembers && typeof src === "string" && RECORD_PAGES_PATH_RE.test(src)) {
              for (const spec of node.specifiers ?? []) {
                if (spec.type === "ImportSpecifier" && spec.imported?.name === "listMemberPages") {
                  context.report({ node: spec, message });
                }
              }
            }
          },
          ExportNamedDeclaration(node) {
            const src = node.source?.value;
            checkSourceSpecifier(node, src);
            if (!allowListMembers && typeof src === "string" && RECORD_PAGES_PATH_RE.test(src)) {
              for (const spec of node.specifiers ?? []) {
                if (spec.local?.name === "listMemberPages") {
                  context.report({ node: spec, message });
                }
              }
            }
          },
          ExportAllDeclaration(node) {
            checkSourceSpecifier(node, node.source?.value);
          },
        };
      },
    },
  },
};

function restrictedBoundaryRules(patterns, syntax = []) {
  return {
    ...(patterns.length > 0 ? { "no-restricted-imports": ["error", { patterns }] } : {}),
    ...(syntax.length > 0 ? { "no-restricted-syntax": ["error", ...syntax] } : {}),
  };
}

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores(["**/.next/**", "packages/protocol/src/lexicons/api/**", "**/next-env.d.ts"]),
  { settings: { react: { version: WEB_REACT_VERSION }, next: { rootDir: ["apps/web/", "apps/desk/"] } } },
  {
    files: ["packages/*/src/**/*.{ts,tsx}", "apps/*/src/**/*.{ts,tsx}", "apps/*/scripts/**/*.ts", "apps/*/next.config.ts"],
    rules: {
      "import/no-extraneous-dependencies": ["error", { includeTypes: true, devDependencies: NODE_TESTS, optionalDependencies: false, peerDependencies: false }],
      "import/no-relative-packages": "error",
    },
  },
  {
    files: ["packages/client/src/eslint-boundaries.test.ts"],
    rules: {
      "import/no-extraneous-dependencies": ["error", { includeTypes: true, devDependencies: true, packageDir: [".", "./packages/client"] }],
    },
  },
  {
    files: ["packages/shell/src/boundary.test.ts"],
    rules: {
      "import/no-extraneous-dependencies": ["error", { includeTypes: true, devDependencies: true, packageDir: [".", "./packages/shell"] }],
    },
  },
  {
    files: ["apps/desk/src/boundary.test.ts"],
    rules: {
      "import/no-extraneous-dependencies": ["error", { includeTypes: true, devDependencies: true, packageDir: [".", "./apps/desk"] }],
    },
  },
  {
    files: [
      "packages/protocol/src/pin-digest.test.ts",
      "packages/protocol/src/verify-public-lexicons.test.ts",
      "packages/testing/src/backup-db.test.ts",
    ],
    rules: {
      "import/no-relative-packages": "off",
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
    // D11.11 baseline: block entity-merge and ext/* everywhere outside their explicit allowlists.
    // Every more-specific block below spreads all applicable patterns rather than shadowing this baseline.
    files: ALL_BOUNDARY_SOURCE,
    ignores: [
      ...ENTITY_MERGE_ALLOWED,
      ...EXTENSION_IMPORT_ALLOWED,
      "apps/operator/src/**/*.test.{ts,tsx}",
      "apps/operator/src/operator/testing/**",
    ],
    rules: restrictedBoundaryRules(
      [NO_ENTITY_MERGE_IMPORT, NO_EXTENSION_IMPORT],
      [NO_ENTITY_MERGE_DYNAMIC_IMPORT, NO_EXTENSION_DYNAMIC_IMPORT, NO_COMPUTED_DYNAMIC_IMPORT],
    ),
  },
  {
    // Independent Tasks reader may import entity-merge, never client/UI extensions.
    files: ["packages/reader/src/independent-tasks*.ts"],
    rules: restrictedBoundaryRules([NO_EXTENSION_IMPORT], [NO_EXTENSION_DYNAMIC_IMPORT, NO_COMPUTED_DYNAMIC_IMPORT]),
  },
  {
    // Browser tests/fixtures (except entity-merge tests, ext/tasks tests, and tasks-reader-parity.test.ts).
    files: BROWSER_TEST_FILES,
    ignores: [...ENTITY_MERGE_ALLOWED, ...EXTENSION_IMPORT_ALLOWED],
    rules: restrictedBoundaryRules(
      [NO_SERVER_CONFIG, NO_APP_LAYER, NO_ENTITY_MERGE_IMPORT, NO_EXTENSION_IMPORT],
      [NO_ENTITY_MERGE_DYNAMIC_IMPORT, NO_EXTENSION_DYNAMIC_IMPORT, NO_COMPUTED_DYNAMIC_IMPORT],
    ),
  },
  {
    files: ["packages/protocol/src/entity-merge*.test.ts"],
    rules: restrictedBoundaryRules(
      [NO_SERVER_CONFIG, NO_APP_LAYER, NO_EXTENSION_IMPORT],
      [NO_EXTENSION_DYNAMIC_IMPORT, NO_COMPUTED_DYNAMIC_IMPORT],
    ),
  },
  {
    files: ["packages/client/src/ext/tasks/**/*.test.ts", "packages/client/src/tasks-reader-parity.test.ts"],
    rules: restrictedBoundaryRules([NO_SERVER_CONFIG, NO_APP_LAYER], [NO_COMPUTED_DYNAMIC_IMPORT]),
  },
  {
    // The client's Node entry (non-test): may import node:* and @flock/net, never server config, app layer, entity-merge, or ext/*.
    files: CLIENT_NODE_ENTRY,
    ignores: NODE_TESTS,
    rules: restrictedBoundaryRules(
      [NO_SERVER_CONFIG, NO_APP_LAYER, NO_ENTITY_MERGE_IMPORT, NO_EXTENSION_IMPORT],
      [NO_ENTITY_MERGE_DYNAMIC_IMPORT, NO_EXTENSION_DYNAMIC_IMPORT, NO_COMPUTED_DYNAMIC_IMPORT],
    ),
  },
  {
    // Browser production code outside entity-merge and ext/tasks boundaries.
    files: BROWSER_CODE,
    ignores: [...NODE_TESTS, ...CLIENT_NODE_ENTRY, ...ENTITY_MERGE_ALLOWED, ...EXTENSION_IMPORT_ALLOWED],
    rules: restrictedBoundaryRules(
      [NO_NODE_BUILTINS, NO_SERVER_CONFIG, NO_APP_LAYER, NO_CLIENT_NODE_ENTRY, NO_ENTITY_MERGE_IMPORT, NO_EXTENSION_IMPORT],
      [NO_ENTITY_MERGE_DYNAMIC_IMPORT, NO_EXTENSION_DYNAMIC_IMPORT, NO_COMPUTED_DYNAMIC_IMPORT],
    ),
  },
  {
    files: ["packages/protocol/src/entity-merge*.ts"],
    ignores: NODE_TESTS,
    rules: restrictedBoundaryRules(
      [NO_NODE_BUILTINS, NO_SERVER_CONFIG, NO_APP_LAYER, NO_CLIENT_NODE_ENTRY, NO_EXTENSION_IMPORT],
      [NO_EXTENSION_DYNAMIC_IMPORT, NO_COMPUTED_DYNAMIC_IMPORT],
    ),
  },
  {
    files: ["packages/client/src/engine.ts"],
    rules: restrictedBoundaryRules(
      [NO_NODE_BUILTINS, NO_SERVER_CONFIG, NO_APP_LAYER, NO_CLIENT_NODE_ENTRY, NO_ENTITY_MERGE_IMPORT],
      [NO_ENTITY_MERGE_DYNAMIC_IMPORT, NO_COMPUTED_DYNAMIC_IMPORT],
    ),
  },
  {
    files: ["packages/client/src/ext/tasks/**/*.{ts,tsx}"],
    ignores: NODE_TESTS,
    rules: restrictedBoundaryRules(
      [NO_NODE_BUILTINS, NO_SERVER_CONFIG, NO_APP_LAYER, NO_CLIENT_NODE_ENTRY],
      [NO_COMPUTED_DYNAMIC_IMPORT],
    ),
  },
  {
    files: ["apps/operator/src/**/*.{ts,tsx}"],
    ignores: NODE_TESTS,
    rules: restrictedBoundaryRules(
      [NO_ENTITY_MERGE_IMPORT, NO_EXTENSION_IMPORT],
      [NO_ENTITY_MERGE_DYNAMIC_IMPORT, NO_EXTENSION_DYNAMIC_IMPORT, NO_COMPUTED_DYNAMIC_IMPORT],
    ),
  },
  {
    files: ["apps/operator/src/**/*.test.{ts,tsx}", "apps/operator/src/operator/testing/**"],
    rules: restrictedBoundaryRules(
      [NO_ENTITY_MERGE_IMPORT, NO_EXTENSION_IMPORT],
      [NO_ENTITY_MERGE_DYNAMIC_IMPORT, NO_EXTENSION_DYNAMIC_IMPORT],
    ),
  },
  {
    files: ["apps/web/src/app/ui/ext/tasks/**/*.test.{ts,tsx}", "apps/web/src/app/(shell)/**/ext/tasks/**/*.test.{ts,tsx}"],
    rules: restrictedBoundaryRules([NO_ENTITY_MERGE_IMPORT], [NO_ENTITY_MERGE_DYNAMIC_IMPORT, NO_COMPUTED_DYNAMIC_IMPORT]),
  },
  {
    // The web app, above its browser code, is no Node process and stays isolated from ext/* and entity-merge outside extension UI boundaries.
    files: ["apps/web/src/**/*.{ts,tsx}"],
    ignores: ["apps/web/src/browser/**", ...NODE_TESTS, ...EXTENSION_IMPORT_ALLOWED, "apps/web/src/app/**/route.{ts,tsx}"],
    rules: restrictedBoundaryRules(
      [NO_CLIENT_NODE_ENTRY, NO_ENTITY_MERGE_IMPORT, NO_EXTENSION_IMPORT],
      [NO_ENTITY_MERGE_DYNAMIC_IMPORT, NO_EXTENSION_DYNAMIC_IMPORT, NO_COMPUTED_DYNAMIC_IMPORT],
    ),
  },
  {
    files: [
      "apps/web/src/app/ui/ext/tasks/**/*.{ts,tsx}",
      "apps/web/src/app/(shell)/**/ext/tasks/**/*.{ts,tsx}",
      "apps/web/src/app/ui/workspace-manager.tsx",
      "apps/web/src/app/ui/client-api.{ts,tsx}",
    ],
    ignores: NODE_TESTS,
    rules: restrictedBoundaryRules(
      [NO_CLIENT_NODE_ENTRY, NO_ENTITY_MERGE_IMPORT],
      [NO_ENTITY_MERGE_DYNAMIC_IMPORT, NO_COMPUTED_DYNAMIC_IMPORT],
    ),
  },
  {
    // M6 + D11.11: Route handlers never touch DMs, Node-only client entries, entity-merge, or extension modules.
    files: ["apps/web/src/app/**/route.{ts,tsx}"],
    rules: restrictedBoundaryRules(
      [NO_DM_IMPORT, NO_CLIENT_NODE_ENTRY, NO_ENTITY_MERGE_IMPORT, NO_EXTENSION_IMPORT],
      [NO_ENTITY_MERGE_DYNAMIC_IMPORT, NO_EXTENSION_DYNAMIC_IMPORT, NO_COMPUTED_DYNAMIC_IMPORT],
    ),
  },
  {
    // Flock Shell production code: browser-pure, zero @flock/client/@flock/web/@flock/operator/@flock/group-host/@flock/net/@flock/reader/@flock/deployment.
    files: ["packages/shell/src/**/*.{ts,tsx,mts}"],
    ignores: NODE_TESTS,
    rules: restrictedBoundaryRules(
      [
        NO_NODE_BUILTINS,
        NO_SERVER_CONFIG,
        NO_APP_LAYER,
        NO_CLIENT_NODE_ENTRY,
        NO_ENTITY_MERGE_IMPORT,
        NO_EXTENSION_IMPORT,
        NO_DESK_FORBIDDEN_IMPORTS,
        NO_SHELL_EXTRA_FORBIDDEN_IMPORTS,
      ],
      [
        NO_ENTITY_MERGE_DYNAMIC_IMPORT,
        NO_EXTENSION_DYNAMIC_IMPORT,
        NO_DESK_FORBIDDEN_DYNAMIC_IMPORT,
        NO_SHELL_EXTRA_DYNAMIC_IMPORT,
        NO_COMPUTED_DYNAMIC_IMPORT,
      ],
    ),
  },
  {
    // Flock Shell tests: still forbid all restricted @flock/* packages and computed dynamic imports.
    files: ["packages/shell/src/**/*.test.{ts,tsx,mts}"],
    rules: restrictedBoundaryRules(
      [
        NO_SERVER_CONFIG,
        NO_APP_LAYER,
        NO_ENTITY_MERGE_IMPORT,
        NO_EXTENSION_IMPORT,
        NO_DESK_FORBIDDEN_IMPORTS,
        NO_SHELL_EXTRA_FORBIDDEN_IMPORTS,
      ],
      [
        NO_ENTITY_MERGE_DYNAMIC_IMPORT,
        NO_EXTENSION_DYNAMIC_IMPORT,
        NO_DESK_FORBIDDEN_DYNAMIC_IMPORT,
        NO_SHELL_EXTRA_DYNAMIC_IMPORT,
        NO_COMPUTED_DYNAMIC_IMPORT,
      ],
    ),
  },
  {
    // Flock Desk server entrypoints & tests: forbid @flock/client, @flock/web, @flock/operator, @flock/group-host, @flock/net.
    files: [...DESK_SERVER_ENTRYPOINTS, "apps/desk/src/**/*.test.{ts,tsx,mts}"],
    rules: restrictedBoundaryRules(
      [NO_ENTITY_MERGE_IMPORT, NO_EXTENSION_IMPORT, NO_DESK_FORBIDDEN_IMPORTS],
      [NO_ENTITY_MERGE_DYNAMIC_IMPORT, NO_EXTENSION_DYNAMIC_IMPORT, NO_DESK_FORBIDDEN_DYNAMIC_IMPORT, NO_COMPUTED_DYNAMIC_IMPORT],
    ),
  },
  {
    // Flock Desk browser/client code (everything outside Next server entrypoints and tests): additionally forbid node:* and @flock/deployment.
    files: ["apps/desk/src/**/*.{ts,tsx,mts}"],
    ignores: [...DESK_SERVER_ENTRYPOINTS, ...NODE_TESTS],
    rules: restrictedBoundaryRules(
      [NO_ENTITY_MERGE_IMPORT, NO_EXTENSION_IMPORT, NO_DESK_FORBIDDEN_IMPORTS, NO_DESK_CLIENT_SERVER_IMPORTS],
      [
        NO_ENTITY_MERGE_DYNAMIC_IMPORT,
        NO_EXTENSION_DYNAMIC_IMPORT,
        NO_DESK_FORBIDDEN_DYNAMIC_IMPORT,
        NO_DESK_CLIENT_SERVER_DYNAMIC_IMPORT,
        NO_COMPUTED_DYNAMIC_IMPORT,
      ],
    ),
  },
  {
    // R13 OpenSocial hard-cut: forbid com.atproto.memberspace.{putMembers,removeMembers,listMembers} outside DM/protocol/fixture allowlist.
    plugins: { "flock-boundaries": flockBoundariesPlugin },
    files: ALL_MEMBERSPACE_CHECKED_SOURCE,
    ignores: [
      ...MEMBERSPACE_FULL_ALLOWLIST,
      ...MEMBERSPACE_LIST_ONLY_ALLOWLIST,
      "packages/client/src/eslint-boundaries.test.ts",
    ],
    rules: {
      "flock-boundaries/no-legacy-memberspace": ["error", { allowListMembers: false }],
    },
  },
  {
    // WorkspaceClient.ensureInvitesSpace() (and its test) may call `listMembers` ONLY; `putMembers`/`removeMembers` remain forbidden.
    plugins: { "flock-boundaries": flockBoundariesPlugin },
    files: MEMBERSPACE_LIST_ONLY_ALLOWLIST,
    rules: {
      "flock-boundaries/no-legacy-memberspace": ["error", { allowListMembers: true }],
    },
  },
]);
