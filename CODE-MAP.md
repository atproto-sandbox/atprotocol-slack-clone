# Code map

A Slack-style team workspace built directly on atproto (AT Protocol) permissioned data ("spaces"), plus a second, deliberately isolated direct-message feature. See `SPEC.md` for product scope, `ARCHITECTURE.md` for the runtime boundaries and data flow, and `.ai/plans/direct-messages.md` for the DM design and milestones.

## System boundaries

```
                         BROWSER                                    NEXT.JS SERVER                          EACH ACCOUNT'S PDS
  ┌──────────────────────────────────────────┐      ┌───────────────────────────────────────┐     ┌───────────────────────────────────┐
  │ React UI (src/app/ui/**)                   │      │ App Router pages/routes (src/app/**)   │     │ new.flock.workspace / .channel /   │
  │  - workspace-manager, sidebar, channel-view│◀────▶│  - page.tsx (entry), layout.tsx        │────▶│   .inbox spaces                    │
  │  - dm-sidebar/home/requests/settings/      │      │  - api/** authenticated JSON routes    │     │ new.flock.directory/.roster/.admin │
  │    conversation (src/app/ui/dm-*.tsx)      │      │  - xrpc/** operator + notices           │     │ new.flock.channel.message/.reaction│
  │                                             │      │  - oauth/** login/callback/metadata    │     │ (member-list read/write, open      │
  │ Workspace OAuth session (server-issued)     │      │                                         │     │  app access; member lists ARE the  │
  │  - used for channel/workspace reads+writes  │      │ Workspace authority operator            │     │  read gate)                        │
  │                                             │      │  (src/operator/**)                      │     ├───────────────────────────────────┤
  │ DM OAuth session (browser-held, M3)         │      │  - signs service-auth JWTs, journals,   │     │ new.flock.dm.inbox (self)          │
  │  - IndexedDB, non-extractable DPoP keys     │      │    resumes, reconciles PDS membership   │     │ new.flock.dm.conversation/<convKey>│
  │  - src/dm/browser-session.ts                │      │                                         │     │   header/message/reaction          │
  │  - scopes: DM_BROWSER_SCOPES only            │      │ SQLite (src/lib/db.ts)                  │     │ (member-list; convKey is a TID,    │
  │                                             │      │  - encrypted OAuth/session state,       │◀───▶│  not a secret — DM state lives     │
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
        │ 2. key-bound space credential (10 min default, 1 h max)
        ▼
 for each participant's conversation half (fan-out 8, src/lib/map-limited.ts):
   - read header, validate convKey + participant set match (validateDmHeaderMatchesRequest)
   - classify a failed mint as missing / deleted / revoked (SpaceCredentialError.code)
        │
        │ 3. sync and merge
        ▼
 src/client/sync.ts (the engine's sync core, used by DmClient.readConversation): each readable half is a
   source; every read checks each half's revision at its host and lists only halves that moved, between two
   revision reads; messages and reactions are validated on read and merged newest key first, then by URI
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
    oauth/                  Login, callback, and client-metadata routes (member sign-in + DM).
    authority/              The workspace authority flow: start, callback, client metadata, JWKS.
    xrpc/                   Server-published XRPC methods: the operator's own RPCs
                             (new.flock.operator.*), com.atproto.space.notifyWrite and com.atproto.space.notifySpaceDeleted.
    dm/callback/            Browser DM OAuth callback page (client component).
    .well-known/did.json/   The operator's did:web document (OPERATOR_SERVICE_REF), when the
                             operator DID is hosted as did:web on this app's own origin.
    ui/                     React components (client + server). workspace-manager.tsx is the
                             main stage; dm-*.tsx are the DM sidebar/home/requests/settings/
                             conversation views, wired in through dm-context.tsx / dm-session-bridge.tsx.
  atproto/                Low-level protocol clients, shared by server channel code and the
                           isomorphic DM engine.
    xrpc.ts                  Minimal XRPC client (query/procedure) over an injected fetch handler.
    space-key.ts             SpaceKey (WebCrypto P-256 did:key) that binds one credential. Signing,
                              KEM and MAC formats belong to @atproto/space (isomorphic).
    space-policy.ts          The one owner of the memberspace policy object the app sends and reads.
    kem-key.ts               `#atproto_kem` did:key from a DID document (server and browser share it).
    repo-failure.ts          The one classifier for "this one writer's repo cannot be read" (deactivated,
                              taken down, unauthenticated, oversized, host down): the sync, the admin inbox,
                              DM reads, the independent channel reader and the operator set the writer aside instead of failing for everyone.
    space-credential-core.ts Isomorphic space-credential mint/exchange (SpaceCredential,
                              SpaceCredentialError, mintSpaceCredentialWith) and the single owner of
                              MAC requests and verification for getRecord and getLatestCommit (listRepoOps
                              and getRepo are unsupported: nothing calls them); isAccessLost is the one
                              "this account lost access" predicate (refused credential or deleted space);
                              isCredentialRefused is the different question "did the host refuse this
                              credential itself" (so its holder mints another); credentialLifetimeMs reads
                              the authority's chosen lifetime from the token's iat and exp.
    space-credential.ts      Thin server adapter over space-credential-core.ts (Node session,
                              SSRF-guarded fetch).
    record-pages.ts          Bounded listRepos/listRecords/listMembers/listSpaces paging with
                              cursor/duplicate/limit assertions; the one listBoundedSpaces and
                              listAllSpaceUris (workspace discovery).
    identity.ts               Server-side DID→PDS resolution (SSRF-guarded; Node-only), and fetchValidatedEndpoint:
                              the one outbound fetch path, which ends every request at its time limit (30 s unless
                              the caller asks for longer; only the operator client's execute call does).
    space-ops.ts, valid-channel-messages.ts, client.ts
  protocol/               Pure, isomorphic protocol logic shared by everything above.
    keys.ts                  The one owner of URI and key syntax: parseSpaceUri / parseWorkspaceUri /
                              parseChannelUri / requireSpaceAuthority, isDid / isSkey / isTid, canonical
                              record keys, TID generation, canonicalParticipants. No other module
                              hand-writes an at:// regex.
    nsids.ts                  The one owner of NSIDs: NAMESPACE, SPACE_TYPE, COLLECTION, REPO_COLLECTION,
                              OPERATOR_METHOD. No other source module spells an NSID
                              (registry.test.ts enforces it).
    registry.ts               The one table of space records (REGISTRY): space type, author, key rule, sync
                              strategy and semantic rule per collection. validateSpaceRecord = shape from the
                              published lexicons (@atproto/lexicon) + the entry's meaning rule; records are
                              open (unknown fields kept); MAX_RECORD_BYTES bounds what a reader keeps.
    scopes.ts                 Scope builders for member, authority and operator sessions, derived from the
                              registry, and DM_BROWSER_SCOPES (asserted disjoint from every server scope).
    workspace-summary.ts      What a workspace is, summarized from its authority's records, and the v1
                              envelope check; the member read model and the operator both use it.
  auth/                   Server session, OAuth flow.
    session.ts, web-session.ts, oauth.ts, oauth-flow.ts, encrypted-store.ts, encrypted-cache.ts
  operator/               Workspace-authority operator: journaled, idempotent PDS mutations.
    authority-grant.ts       The one owner of the workspace authority grant: its own OAuth client (confidential
                              private_key_jwt outside loopback), the ticket -> /authority/start -> PDS consent ->
                              /authority/callback flow, and the `authority_grant` table. The operator, bootstrap and
                              the reconcile job restore the grant from here; a member sign-in never writes it.
    actor.ts                 OperatorActor and WorkspaceRef: who an operation runs for, through which session.
    journal.ts               runJournaledOperation: the workspace lock, the operation row, declared step names,
                              resume by name and request hash, "waiting for the authority's approval", and the
                              time limit after which a run starts no further step.
    kinds/                   One file per operation kind ({ fields, actor, steps, validate, authorizeMember,
                              endsOwnRole, run });
                              kinds/index.ts is the table every request and journal row dispatches through, and
                              kinds/kinds.test.ts pins every persisted kind, field and step name.
    operations.ts            Request validation from the kind table, recovery of pending rows, and execution.
    security.ts              Service-auth verification; authorizeOperationActor decides who may run an operation (an
                              admin; the authority alone for an authority kind; the member a member kind concerns,
                              through the kind's authorizeMember, after the request is validated).
                              authorizeSubmittedOperation adds the one exception: a submitter that current state
                              refuses may send again a journaled operation whose kind says it ends their own role.
    workspace-state.ts       The operator's reads and writes of rosters, admins and the directory.
    workspace-envelope.ts    The operator's own envelope check, read with the authority's grant.
    notices.ts               registerNotify bookkeeping; which write/deleted notices are accepted; the capped
                              write-notice table the change streams read.
    testing/fake-authority-pds.ts
                             In-memory authority PDS for operator unit tests; production code never imports it.
  workspaces/             Server-side channel/workspace sync, caching, and the read model.
  client/                 The engine (isomorphic, under the same lint boundary as src/dm; the SDK from R7). One owner each:
    transport.ts             ClientTransport: what the engine needs from its host (own client, DID resolution, fetch, keys).
    credentials.ts           CredentialCache: one space credential per space; a refused mint drops the space (onAccessLost).
    identity.ts              withIdentityCache: a DID's host and KEM key held in the store (across sessions) for
                              DID_DOCUMENT_TTL_MS, six resolutions at once per origin in the process, each given up after
                              ten seconds; a failed MAC forces a fresh key. The ten-minute bound has one owner,
                              src/atproto/kem-key.ts, shared with the browser's documents and the server's KEM keys.
    store.ts                 SyncStore contract: records, per-writer state (coverage per collection, syncedRev, generation),
                              per-space state, compare-and-set commits by generation, revision and space epoch.
    memory-store.ts, indexeddb-store.ts
                             The two stores: memory (DM spaces, tests) and IndexedDB (one database per account).
    merge.ts                 The merge order (newest key, then URI) and the opaque (key, uri) page cursor.
    sync.ts                  SyncCore: the writer set (full listRepos per session and truth interval, hints between),
                              bracketed refresh, backfill, set-aside writers, bounds, completeness.
    lifecycle.ts             When held copies stop being served: lost access, deletion, unlisted workspaces, archived
                              channels, retention sweep, sign-out.
    channel-client.ts, workspace-client.ts, operator-client.ts
                             The member's operations, each rule of the route table owned here; engine.ts wires them.
    accept-errors.ts, inbox-requests.ts, errors.ts
                             Accept refusal codes, one writer's join requests, ChannelUnavailableError.
  testing/                Test-only: fake-network.ts (the in-memory multi-host PDS network for every engine and DM
                           test), engine-fixture.ts (channels and workspaces on it), store-contract.ts.
  dm/                     The DM feature. Isomorphic engine + browser-only glue. See below.
  reader/                 Independent second-app readers (no app database, no DM-engine import).
    independent.ts           Channels/workspaces; takes injected transports (sessionCredentialDeps builds them from a
                              server session), so it runs on the fake network too.
    independent-dm.ts        DMs (M6 independence proof).
  lib/                    Cross-cutting utilities: config, db, bounded-json parsing,
                           map-limited concurrency, security headers, same-origin checks.
  lexicons/api/           Generated lexicon clients (do not hand-edit; see codegen:lex).

lexicons/                 Source NSID lexicon JSON (new.flock.*, new.flock.dm.*).
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
  `store`), so the same class runs in the browser and in Node tests/acceptance. `leave` removes
  the other participants from the caller's half and hides the conversation in the local store
  (off the list, not re-announced); starting a conversation with the same people readmits them.
- `request-policy.ts` — pure mapping between the inbox memberspace `publicWrite` flag/member state and the
  user-facing mode (`everyone` / `allowlist` / `nobody`).
- The inbox declaration (`new.flock.dm.declaration`, a public record in the owner's own repo, written by `enableDms`) is how a sender learns a recipient has an inbox: the authority answers a stranger asking for the inbox like a missing space.
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
- `pnpm authority` (`scripts/authority-grant.ts`) — generate an authority client key, or revoke an authority grant.
- `pnpm backup:db` (`scripts/backup-db.mjs`) — online SQLite backup.
- `pnpm test` — unit tests (`node --test` over every `src/**/*.test.ts`), plus `bdd/gate.test.ts`, which keeps the Gherkin features honest (below).
- `pnpm test:bdd` — builds, then runs the executable Gherkin scenarios in `features/` with `@cucumber/cucumber`, driving real browsers against a real pinned PDS network.
- `pnpm test:acceptance` — builds, then runs `protocol-tests/{app-acceptance,reconcile-workspaces,dm-acceptance,authority-grant,platform-capabilities,engine-acceptance}.test.ts` against a real pinned PDS network (needs `ATPROTO_PINNED_CHECKOUT`). `platform-capabilities` and `authority-grant` hold the platform refactor's capability checks (K1, K3, K7), and `engine-acceptance` the engine's parity with the independent reader on two real hosts, all on the network-only helper `protocol-tests/support/pds-network.ts` (`actorTransport` builds the engine's transport for a real account).
- `pnpm test:browser` — builds, then runs Playwright specs in `protocol-tests/browser/` (`--test-concurrency=1`, since the specs start real servers); `cross-origin.spec.ts` (K9) signs in through the real OAuth flow and sends every request from a separate web origin.
- `pnpm test:performance` — `protocol-tests/{performance-envelope,dm-performance}.test.ts` (slow; the channel envelope test is ~30 minutes); each latest-100 read is repeated ten times and reported as median and p95.
- `pnpm test:sync-budget` — `protocol-tests/sync-budget.ts` (K4, R4's gate): calls and time of the engine's first open, reopen and one new message at 20, 100 and 200 writers; it fails if a reopen's call count depends on the writer count.

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
  (`src/protocol/keys.ts` parsers/predicates, `src/protocol/registry.ts` validators); nothing
  parsed from a PDS response is trusted without going through them first.
- Every PDS list/page fetch goes through the bounded helpers in `src/atproto/record-pages.ts`,
  which assert cursor progress, page-size limits, and no duplicate keys,
  and report `truncated` rather than silently dropping data past a scan cap.
- Concurrency is `src/lib/map-limited.ts` (fixed fan-out, currently 8 for DM/channel fan-out),
  not ad hoc `Promise.all` over unbounded arrays.
- Imports point one way: `src/atproto/**` and `src/operator/**` never import `src/workspaces/**` (the member read
  model) or `src/app/**`; an `eslint.config.mjs` rule enforces it.
- Server-only code (`@/lib/db`, `@/auth/*`, `@/operator/*`, `@/workspaces/*`, `node:*`,
  `@atproto/oauth-client-node`, `undici`, `@/atproto/identity`) is off-limits to the isomorphic
  protocol/DM layer and to `src/reader/**`; `src/dm/**` is additionally off-limits to everything
  under `src/app/api/**`. All three boundaries are `eslint.config.mjs` rules, not just convention.
- DM invariants (no server session, no server cache, no app-decided access, independent-app
  parity) are treated as architectural constraints, not defaults to be revisited later; see
  `SPEC.md`'s "Direct-message invariants" and `.ai/plans/direct-messages.md` §1–§2.
