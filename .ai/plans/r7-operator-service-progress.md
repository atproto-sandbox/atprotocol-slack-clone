# R7 progress: the operator as its own service, and the packages

Plan: `.ai/plans/platform-refactor.md`, "### R7". Two steps, each gated and committed.

## r7a: the operator runs as its own process (2026-11-11)

Status: done. Outcome, departures, gate and reviews: the plan's "### R7a" section.

What the Next app serves for the operator today, and where it goes:
- `src/app/xrpc/new.flock.operator.*` (seven methods) and `com.atproto.space.{notifyWrite,notifySpaceDeleted}`: each route's
  logic becomes a method function in `src/operator/methods.ts` that takes what the request carries (the `authorization`
  header, the query parameters, the JSON body) and returns its output or throws a typed error. One error map turns those
  into XRPC errors. `src/operator/server.ts` registers the methods on `@atproto/xrpc-server` with the app's lexicons, so
  inputs and outputs are checked against them, and serves the operator's other paths on the same Express app: the
  authority flow (`/authority/{start,callback,client-metadata.json,jwks.json}`) and its `did:web` document
  (`/.well-known/did.json`). CORS admits the web origin (and only it) for the XRPC methods; the authority flow is
  top-level navigation and needs none. The registration sweep at start-up moves from `src/instrumentation.ts` to the
  server's start.
- Configuration splits: the operator has its own public URL (`OPERATOR_URL`; its `did:web` and the authority client's
  redirect URIs derive from it) and the web origin it serves (`APP_URL`, for CORS and for the redirect back after the
  authority flow). The web app needs `APP_URL`, `PLC_URL`, `OPERATOR_SERVICE_REF` and the operator's endpoint
  (`OPERATOR_URL`); it no longer opens the database or holds the encryption key.
- The Next routes above are deleted; the browser's engine calls the operator at `OPERATOR_URL`.
- Tests: the BDD fixture, the acceptance suites and the browser specs start the operator process beside the web app, on
  its own origin; steps that read the operator's calls read them at the operator's origin. In-process tests call the
  method functions (or the Express app) instead of Next route modules.
- Gate for r7a: unit, typecheck, lint; acceptance; browser (K9 against the real operator process); BDD; and the authority
  flow in a real browser with web and operator on different origins, same site and cross site: starts and completes, is
  rejected without its cookie, rejects a replayed ticket and a replayed state, and runs two flows at once.

## r7b: packages and apps

Status: done. Outcome, departures, gate and reviews: the plan's "### R7b" section.

- pnpm workspace: `packages/protocol` (src/protocol, the generated lexicons, the isomorphic atproto modules and
  bounded-json), `packages/client` (src/client and the isomorphic DM engine and stores), `packages/testing` (the fake
  network and fixtures), `packages/reader` (src/reader); `apps/web` (Next: the UI, the browser session, its config);
  `apps/operator` (src/operator, src/auth, the server-side atproto modules, the database, the reconcile and authority
  scripts). Package dependencies replace the path lists in `eslint.config.mjs`.
- Gate for r7b: `packages/client` and `packages/protocol` typecheck with no Node types and no Next; `packages/reader`
  depends on `packages/protocol` only; every suite passes.

### r7b design (2026-11-11)

Where each module goes, from the import graph (`src/*` and the four root suites, counted per module):

| Package | From | Imported as |
|---|---|---|
| `packages/protocol` (`@flock/protocol`) | `src/protocol/*`; the lexicon JSON (`/lexicons`, now `packages/protocol/lexicons`); the generated `src/lexicons/api`; the isomorphic atproto modules (`kem-key`, `record-pages`, `repo-failure`, `space-credential-core`, `space-key`, `space-policy`, `valid-channel-messages`, `xrpc`); `lib/bounded-json`, `lib/map-limited` | `@flock/protocol/<module>`, `@flock/protocol/atproto/<module>`, `@flock/protocol/lexicons/...` |
| `packages/client` (`@flock/client`) | `src/client/*`, `src/dm/*`; the engine's test fixtures (`src/testing/{engine-fixture,store-contract}`) | `@flock/client/<module>`, `@flock/client/dm/<module>`, `@flock/client/testing/<module>` |
| `packages/reader` (`@flock/reader`) | `src/reader/*` | `@flock/reader/<module>` |
| `packages/testing` (`@flock/testing`) | `src/testing/fake-network`; the one protocol test that needs it (`space-credential-core.test.ts`) | `@flock/testing/<module>` |
| `packages/deployment` (`@flock/deployment`) | from `lib/config`: `getConfig`, `AppConfig`, `isLoopback` and the URL rules; `lib/security-headers` | `@flock/deployment/config`, `@flock/deployment/security-headers` |
| `apps/web` (`@flock/web`, Next) | `src/app/*`, `src/browser/*`, `lib/within`, `next.config.ts` | `@flock/web/app/...`, `@flock/web/browser/...` |
| `apps/operator` (`@flock/operator`) | `src/operator/*`, `src/auth/*`, the server-side atproto modules (`client`, `identity`, `space-credential`, `space-ops`, `write-notification`); `lib/db`, `lib/dm-subscription`; from `lib/config`, the operator's own (`getOperatorConfig`, the authority client keys); `scripts/{reconcile-workspaces,authority-grant}.ts` | `@flock/operator/<dir>/<module>` |

Decisions:
- **A fifth package, `packages/deployment`.** The web app and the operator both read the public URLs (`APP_URL`, `OPERATOR_URL`, `PLC_URL`, `OPERATOR_SERVICE_REF`) with the same rules (HTTPS unless loopback, the loopback default for `OPERATOR_URL`), and both send the same security headers. One app cannot import the other, and `protocol` must stay free of Node, so the rules get a package of their own instead of a copy in each app. What only the operator reads (its database, its key, the authority client keys) moves to `apps/operator`.
- **No `@/` alias.** Code in a package imports another package by name, and its own modules by relative path. Every package exports its TypeScript source (`"exports": { "./*": "./src/*.ts" }`): no build step, since tsx, Next (`transpilePackages`) and tsc all read TypeScript. A module reached both ways resolves to one file, because Node resolves a workspace symlink to its real path, so module state (the database handle, cached configuration) stays single.
- **Each package declares what it imports**, workspace packages and third-party ones alike. The root declares only what the root suites and scripts import. `import/no-extraneous-dependencies` (the plugin comes with `eslint-config-next`, the rule is enabled here, with type imports included and dev dependencies allowed only in tests and the client's fixtures) enforces this against the nearest `package.json`, which replaces the path lists in `eslint.config.mjs`; `import/no-relative-packages` refuses a relative path into another package. The browser-safe rule (no `node:*`, no server configuration) covers `packages/protocol`, `packages/client` and `apps/web/src/browser`; the member-list rule matches a path pattern now that imports are relative.
- **Typecheck:** `packages/protocol` and `packages/client` each get a `tsconfig.json` with `"types": []` and a DOM/ES lib, and without their tests. `pnpm typecheck` runs those two and the root project, which covers everything else with Node types. The gate's check then stays in every run.
- **Next** builds `apps/web` (`next build apps/web`, `next start apps/web`). Its config lists the workspace packages in `transpilePackages`, and it loads the repository root's `.env` (`loadEnvConfig`), so one `.env` still serves both processes in development.
- **The lexicon JSON moves into `packages/protocol/lexicons`**, so the package owns its published definitions (`@flock/protocol/lexicons/<path>.json`); codegen reads it there and writes `packages/protocol/src/lexicons`. (The design said it would stay at `/lexicons`; the review found the protocol package's own imports of it then escaping the package.)
- **No dependency cycle through `testing`:** it holds only the fake network, which imports protocol; the engine's fixtures, which import the client, are the client package's own (`src/testing`), and the one protocol test that needs the fake network lives in `testing`.
- **Every package is `"type": "module"`** (tests use top-level await), and **the web app owns its Next scripts**; the root's `dev`, `build` and `start` run them (`pnpm --filter @flock/web`), and the suites spawn `apps/web/node_modules/next/dist/bin/next start apps/web`.
- **Tests that read files find them from their own location** (`import.meta.url`), so they run from any directory.
- **Tests stay beside their modules**, so they move with them. The root `test` script globs `packages/*/src` and `apps/*/src`. The BDD, acceptance and browser suites and the fixtures start `apps/operator/src/operator/main.ts` and `next start apps/web`.

How: one migration script moves every file with `git mv` and rewrites every `@/...` specifier: to a relative path within a package, or to the package name across packages. Then the configs (`package.json`s, tsconfigs, `next.config.ts`, `eslint.config.mjs`, `cucumber.mjs`, the codegen script) and the fixtures' process paths are done by hand, and tsc, lint and the suites are run until they pass.
