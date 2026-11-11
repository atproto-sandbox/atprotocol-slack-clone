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

Status: next.

- pnpm workspace: `packages/protocol` (src/protocol, the generated lexicons, the isomorphic atproto modules and
  bounded-json), `packages/client` (src/client and the isomorphic DM engine and stores), `packages/testing` (the fake
  network and fixtures), `packages/reader` (src/reader); `apps/web` (Next: the UI, the browser session, its config);
  `apps/operator` (src/operator, src/auth, the server-side atproto modules, the database, the reconcile and authority
  scripts). Package dependencies replace the path lists in `eslint.config.mjs`.
- Gate for r7b: `packages/client` and `packages/protocol` typecheck with no Node types and no Next; `packages/reader`
  depends on `packages/protocol` only; every suite passes.
