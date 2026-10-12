# Code map

A Slack-style team workspace built directly on atproto (AT Protocol) permissioned data ("spaces"), plus a second, deliberately isolated direct-message feature. See `SPEC.md` for product scope, `ARCHITECTURE.md` for the runtime boundaries and data flow, and `.ai/plans/direct-messages.md` for the DM design and milestones.

## System boundaries

```
                         BROWSER                                    NEXT.JS SERVER                          EACH ACCOUNT'S PDS
  ┌──────────────────────────────────────────┐      ┌───────────────────────────────────────┐     ┌───────────────────────────────────┐
  │ React UI (src/app/ui/**)                   │      │ App Router pages/routes (src/app/**)   │     │ org.slack.workspace / .channel /   │
  │  - workspace-manager, sidebar, channel-view│◀────▶│  - page.tsx (entry), layout.tsx        │────▶│   .inbox spaces                    │
  │  - dm-sidebar/home/requests/settings/      │      │  - api/** authenticated JSON routes    │     │ org.slack.directory/.roster/.admin │
  │    conversation (src/app/ui/dm-*.tsx)      │      │  - xrpc/** operator + notifyWrite      │     │ org.slack.channel.message/.reaction│
  │                                             │      │  - oauth/** login/callback/metadata    │     │ (member-list read/write, open      │
  │ Workspace OAuth session (server-issued)     │      │                                         │     │  app access; member lists ARE the  │
  │  - used for channel/workspace reads+writes  │      │ Workspace authority operator            │     │  read gate)                        │
  │                                             │      │  (src/operator/**)                      │     ├───────────────────────────────────┤
  │ DM OAuth session (browser-held, M3)         │      │  - signs service-auth JWTs, journals,   │     │ org.slack.dm.inbox (self)          │
  │  - IndexedDB, non-extractable DPoP keys     │      │    resumes, reconciles PDS membership   │     │ org.slack.dm.conversation/<convKey>│
  │  - src/dm/browser-session.ts                │      │                                         │     │   header/message/reaction          │
  │  - scopes: DM_BROWSER_SCOPES only            │      │ SQLite (src/lib/db.ts)                  │     │ (member-list; convKey is a random, │
  │                                             │      │  - encrypted OAuth/session state,       │◀───▶│  unguessable TID — DM state lives  │
  │ DmClient (src/dm/dm-client.ts)              │──────┼─▶  sync cursors, channel-message cache,│     │  only here, per participant)       │
  │  isomorphic engine; runs unmodified here    │ mint │    operator journal, audit,             │     └───────────────────────────────────┘
  │  and in Node tests/acceptance               │ space│    space_notification (write pings)     │                 ▲
  │                                             │ cred.│  - NEVER a DM table, NEVER DM content   │                 │ mint space credential,
  │ Independent readers (proof of no lock-in)   │──────┼─▶ /api/notifications/dm: content-free   │  register notify│ read/write records directly
  │  src/reader/independent.ts (channels)       │ SSE  │   SSE — only a change cursor, no        │─────────────────┘
  │  src/reader/independent-dm.ts (DMs)         │◀─────┼── record reads, no credential minted    │
  └──────────────────────────────────────────┘      └───────────────────────────────────────┘
```

Two independent-app proofs exist side by side: `src/reader/independent.ts` (channels/workspaces) and `src/reader/independent-dm.ts` (DMs). Both talk only to PDSes through the published lexicons and space-credential protocol — never to this app's database — and an ESLint rule additionally forbids `src/reader/**` from importing `src/dm/**`, so the DM proof cannot quietly depend on the DM engine it is supposed to be independent of.

## DM data flow (read)

```
 browser DM session (per-user OAuth, DM scopes only)
        │
        │ 1. mintSpaceCredentialWith(deps, half-uri)  — deps = { memberClient, resolvePds, fetchEndpoint, generateKey }
        ▼
 getDelegationToken @ caller's own PDS  ──token──▶  getSpaceCredential @ half owner's PDS
        │
        │ 2. DPoP-bound space credential (≤ 2h)
        ▼
 for each participant's conversation half (fan-out 8, src/lib/map-limited.ts):
   - read header, validate convKey + participant set match (validateDmHeaderMatchesRequest)
   - page org.slack.dm.message / org.slack.dm.reaction, validate every record (validateSpaceRecord)
   - classify a failed mint as missing / deleted / revoked (SpaceCredentialError.code)
        │
        │ 3. merge
        ▼
 src/dm/merge.ts: incremental k-way merge, pages only the halves the current
   window still needs (production path, used by DmClient.readConversation)
   -- OR --
 src/reader/independent-dm.ts: fetches each half's full bounded history up
   front, then one sort+slice (separate implementation, proves independence)
        │
        ▼
 { messages (newest first), reactions, halves: Record<did, status> }
```

Writes follow the mirror path: the engine validates a record locally with `validateSpaceRecord` before calling `com.atproto.space.putRecord`/`applyWrites` on the *caller's own* half or the *recipient's* inbox — never anyone else's conversation half, since only the half owner has `write=true` there.

## Directory map

```
src/
  app/                    Next.js App Router (server): pages, layouts, and route handlers.
    page.tsx                Entry point: resolves the server session, builds dmConfig, renders
                             LoginForm or WorkspaceManager.
    layout.tsx               Root HTML shell, security headers wiring.
    api/                    Authenticated JSON + SSE routes for the signed-in member.
      workspaces/, channels/*, inbox/requests/, notifications/, notifications/dm/
      operator/*             Admin-only routes that call into src/operator/.
    oauth/                  Login, callback, and client-metadata routes (workspace + DM).
    xrpc/                   Server-published XRPC methods: the operator's own RPCs
                             (org.slack.operator.*) and com.atproto.space.notifyWrite.
    dm/callback/            Browser DM OAuth callback page (client component).
    .well-known/did.json/   The operator's did:web document (OPERATOR_SERVICE_REF), when the
                             operator DID is hosted as did:web on this app's own origin.
    ui/                     React components (client + server). workspace-manager.tsx is the
                             main stage; dm-*.tsx are the DM sidebar/home/requests/settings/
                             conversation views, wired in through dm-context.tsx / dm-session-bridge.tsx.
  atproto/                Low-level protocol clients, shared by server channel code and the
                           isomorphic DM engine.
    xrpc.ts                  Minimal XRPC client (query/procedure) over an injected fetch handler.
    dpop.ts                  DPoP proof creation (WebCrypto-based; isomorphic).
    space-credential-core.ts Isomorphic space-credential mint/exchange (SpaceCredential,
                              SpaceCredentialError, mintSpaceCredentialWith).
    space-credential.ts      Thin server adapter over space-credential-core.ts (Node session,
                              SSRF-guarded fetch).
    record-pages.ts          Bounded listRepos/listRecords/listMembers/listSpaces paging with
                              cursor/duplicate/limit assertions.
    identity.ts               Server-side DID→PDS resolution (SSRF-guarded; Node-only).
    notifications.ts, space-ops.ts, space-pages.ts, valid-channel-messages.ts, client.ts
  protocol/               Pure, isomorphic protocol logic shared by everything above.
    keys.ts                  URI builders/parsers (workspace/channel/dm), canonical record
                              keys, TID generation, canonicalParticipants.
    records.ts                validateSpaceRecord: schema + authorship + key-derivation checks
                              for every org.slack.* and org.slack.dm.* collection.
  auth/                   Server session, OAuth flow, and scope definitions.
    permission-sets.ts       Scope builders for workspace/admin/operator sessions and
                              DM_BROWSER_SCOPES (asserted disjoint from every server scope).
    session.ts, web-session.ts, oauth.ts, oauth-flow.ts, encrypted-store.ts, encrypted-cache.ts
  operator/               Workspace-authority operator: journaled, idempotent PDS mutations.
  workspaces/             Server-side channel/workspace sync, caching, and the read model.
  dm/                     The DM feature. Isomorphic engine + browser-only glue. See below.
  reader/                 Independent second-app readers (no app database, no DM-engine import).
    independent.ts           Channels/workspaces.
    independent-dm.ts        DMs (M6 independence proof).
  lib/                    Cross-cutting utilities: config, db, bounded-json parsing,
                           map-limited concurrency, security headers, same-origin checks.
  lexicons/api/           Generated lexicon clients (do not hand-edit; see codegen:lex).

lexicons/                 Source NSID lexicon JSON (org.slack.*, org.slack.dm.*).
protocol-tests/           Backend acceptance/performance against the pinned PDS checkout, plus
                           Playwright browser acceptance (protocol-tests/browser/).
  atproto/                  Protocol conformance suites copied into the pinned checkout to run.
docs/                     Operations runbook, protocol pin, and PRD/implementation-plan docs.
features/                 BDD scenario files (Gherkin-style), including direct-messages.feature.
.ai/plans/                Design docs and per-milestone task specs (dm-tasks/m0.md..m6.md).
scripts/                  codegen-lex.mjs, backup-db.mjs, reconcile-workspaces.ts.
```

### `src/dm/` in detail

- `dm-client.ts` — `DmClient`: the isomorphic DM engine (inbox/policy, discovery, start/accept,
  messages/reactions, `readConversation`'s k-way merge, leave/delete, re-notify). Constructed
  with injected transports (`memberClient`, `resolvePds`, `fetchEndpoint`, `generateKey`,
  `store`), so the same class runs in the browser and in Node tests/acceptance.
- `merge.ts` — the pure k-way merge `readConversation` uses (paginate-only-what's-needed).
- `request-policy.ts` — pure mapping between the inbox `writePolicy`/member state and the
  user-facing mode (`everyone` / `allowlist` / `nobody`).
- `backoff.ts` — the re-notify backoff schedule (1 min, 10 min, 1 h, 1 day, then stop).
- `browser-session.ts` — `@atproto/oauth-client-browser` wiring: `connectDms`, `restoreDmSession`,
  `disconnectDms`, the well-known-only handle resolver, `DmConfig`.
- `browser-identity.ts` — browser-side DID→PDS and DID→handle resolution (`did:plc` via the
  configured PLC directory, `did:web` via `/.well-known/did.json`), bounded and HTTPS-only
  outside loopback development.
- `browser-store.ts` — the `DmDeps.store` implementation: `localStorage`, per-DID prefixed,
  falling back to in-memory state (and saying so) when storage is unavailable.
- `use-dm-client.ts` — the React hook that restores/builds a browser `DmClient`.
- `client-metadata.ts` — pure OAuth client-metadata builder (production + loopback forms),
  served by `src/app/oauth/dm-client-metadata.json/route.ts`.
- `ui-logic.ts` — pure UI helpers (participant-input parsing, conversation labels/visibility,
  co-member/allowlist edits) kept separate from the `dm-*.tsx` components for testability.
- `testing/fake-pds.ts` — an in-memory, multi-host fake of the DM-relevant PDS surface, used only
  by `src/dm/*.test.ts` unit tests; production code never imports it.
- `index.ts` — `export {};` only, so the ESLint isomorphic-boundary rule has a stable target.

Every module above except the `*.test.ts` files is covered by an `eslint.config.mjs`
`no-restricted-imports` rule forbidding `node:*`, `@/lib/db`, `@/lib/config`, `@/auth/*`,
`@/operator/*`, `@/workspaces/*`, `@atproto/oauth-client-node`, `undici`, and
`@/atproto/identity` — the DM engine cannot reach the server's session, database, operator, or
workspace layers even by accident.

## Entry points

- `src/app/page.tsx` — the one page in the app; resolves session state and renders everything else.
- `pnpm dev` / `pnpm build` / `pnpm start` — Next.js dev/build/prod (see `package.json`).
- `pnpm playground` (`scripts/playground.ts`) — a local copy of the whole stack with ready-made accounts, for trying the app by hand (`ATPROTO_PINNED_CHECKOUT` must point at the built pinned checkout).
- `pnpm reconcile` (`scripts/reconcile-workspaces.ts`) — the scheduled membership-reconciliation job (`docs/operations.md`).
- `pnpm backup:db` (`scripts/backup-db.mjs`) — online SQLite backup.
- `pnpm test` — unit tests (`node --test` over every `src/**/*.test.ts`), plus `bdd/gate.test.ts`, which keeps the Gherkin features honest (below).
- `pnpm test:bdd` — builds, then runs the executable Gherkin scenarios in `features/` with `@cucumber/cucumber`, driving real browsers against a real pinned PDS network.
- `pnpm test:acceptance` — builds, then runs `protocol-tests/{app-acceptance,reconcile-workspaces,dm-acceptance}.test.ts` against a real pinned PDS network (needs `ATPROTO_PINNED_CHECKOUT`).
- `pnpm test:browser` — builds, then runs Playwright specs in `protocol-tests/browser/` (`--test-concurrency=1`, since both specs start real Next.js server subprocesses).
- `pnpm test:performance` — `protocol-tests/{performance-envelope,dm-performance}.test.ts` (slow; the channel envelope test is ~30 minutes).

## Executable Gherkin

`features/*.feature` are the behavior contract. Every scenario is executable except the ones tagged `@unbound` (currently one: the UI offers no way to remove the last admin, so `protocol-tests/app-acceptance.test.ts` covers it):

```
features/*.feature        scenarios; @unbound = no step definitions yet (needs a "# unbound:" reason above it);
                          @slow = delegates to a long protocol test, run with `pnpm test:bdd:slow`
bdd/steps/*.steps.ts      step definitions per feature, written as what a person does and sees
bdd/support/ui.ts         shared helpers, one per user action (sign in, consent, create, invite, join)
bdd/support/*-ui.ts       per-feature helpers (channels, private requests, lifecycle, independent app, DMs)
bdd/support/world.ts      per-scenario world: fresh accounts and browser contexts, PDS reads, read-only app DB
bdd/support/hooks.ts      starts the shared fixture once; BDD_HEADED=1 BDD_BROWSER_CHANNEL=chrome opens real Chrome
bdd/gate.test.ts          runs in `pnpm test`: the @unbound count may only go down, every @unbound says why,
                          every bound scenario (including @slow) has a definition for every step
protocol-tests/support/app-fixture.ts
                          the stack (two PDS hosts, PLC, lexicons, `next start`) used by the BDD run and
                          `pnpm playground`; `startSecondApp({env})` adds an independent app instance
```

Run: `pnpm test:bdd` (headless), `pnpm test:bdd:chrome` (visible Google Chrome), `pnpm test:bdd:slow` (the delegated failure-injection and 200-member envelope runs). Steps drive the real UI and assert on observable facts (the page, the PDS, the journal); a scenario that passes proves a journey works for a person. Where a browser cannot reach the mechanism (injected PDS write failures, a 2,000,000-record workload) the step runs the existing protocol test as a child process and says so. `protocol-tests/browser/*.spec.ts` and `protocol-tests/app-acceptance.test.ts` still carry their own copies of the stack set-up and should move onto the shared fixture.

## Conventions

- Dense, explicit TypeScript: named exports only, kebab-case file names, no default exports.
- Tests are `node:test` + `node:assert/strict`, named `*.test.ts` next to the code they cover.
- Comments explain *why*, not *what*; the surrounding code is expected to be self-documenting.
- Every externally supplied DID, AT-URI, record key, and record is validated before use
  (`src/protocol/keys.ts` parsers/predicates, `src/protocol/records.ts` validators); nothing
  parsed from a PDS response is trusted without going through them first.
- Every PDS list/page fetch goes through the bounded helpers in `src/atproto/record-pages.ts`
  (or `space-pages.ts`), which assert cursor progress, page-size limits, and no duplicate keys,
  and report `truncated` rather than silently dropping data past a scan cap.
- Concurrency is `src/lib/map-limited.ts` (fixed fan-out, currently 8 for DM/channel fan-out),
  not ad hoc `Promise.all` over unbounded arrays.
- Server-only code (`@/lib/db`, `@/auth/*`, `@/operator/*`, `@/workspaces/*`, `node:*`,
  `@atproto/oauth-client-node`, `undici`, `@/atproto/identity`) is off-limits to the isomorphic
  protocol/DM layer and to `src/reader/**`; `src/dm/**` is additionally off-limits to everything
  under `src/app/api/**`. All three boundaries are `eslint.config.mjs` rules, not just convention.
- DM invariants (no server session, no server cache, no app-decided access, independent-app
  parity) are treated as architectural constraints, not defaults to be revisited later; see
  `SPEC.md`'s "Direct-message invariants" and `.ai/plans/direct-messages.md` §1–§2.
