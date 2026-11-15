# Code map

A Slack-style team workspace built directly on atproto (AT Protocol) permissioned data ("spaces"), plus a second, deliberately isolated direct-message feature. See `SPEC.md` for product scope, `ARCHITECTURE.md` for the runtime boundaries and data flow, and `.ai/plans/direct-messages.md` for the DM design and milestones.

## System boundaries

```
             BROWSER  (apps/web)                       WEB SERVER (apps/web, Next)           EACH ACCOUNT'S PDS
  ┌─────────────────────────────────────┐      ┌──────────────────────────────────┐   ┌──────────────────────────────┐
  │ React UI: apps/web/src/app/ui       │◀────▶│ page.tsx, layout.tsx, the        │   │ new.flock.workspace/.channel/│
  │  workspace-manager, sidebar,        │      │ oauth callback page and the      │   │  .inbox spaces; directory,   │
  │  channel-view, dm-*.tsx             │      │ browser client's metadata.       │   │  roster, admin; channel      │
  │                                     │      │ No database, no secret.          │   │  messages and reactions      │
  │ Browser session: apps/web/src/      │      └──────────────────────────────────┘   │ (member lists ARE the read   │
  │  browser (one OAuth grant: member   │                                             │  gate)                       │
  │  set, operator rpc, DM set),        │      OPERATOR (apps/operator, own process,  ├──────────────────────────────┤
  │  IndexedDB, non-extractable keys    │      own origin)                            │ new.flock.dm.inbox (self);   │
  │                                     │      ┌──────────────────────────────────┐   │ new.flock.dm.conversation/   │
  │ Engine: @flock/client (reads spaces │─────▶│ xrpc-server methods, service-    │   │  <convKey> header, message,  │
  │  itself; operator calls with        │ svc  │ token auth, journal, resumes,    │◀─▶│  reaction (DM state lives    │
  │  service tokens)                    │ token│ reconciles PDS membership;       │   │  only here, per participant) │
  │ DmClient: @flock/client/dm          │      │ the authority flow, did:web.     │   └──────────────────────────────┘
  │  (isomorphic; also runs in Node)    │ mint │ SQLite: authority grants,        │                 ▲
  │                                     │ cred.│ journal, audit, notices. NO      │  register notify│ mint space credential,
  │ Independent readers: @flock/reader  │──────┼▶ member session or record, NEVER │─────────────────┘ read/write records directly
  │  (channels, DMs; proof of no        │ feed │ a DM table or DM content.        │
  │  lock-in)                           │◀─────┼─ getChanges: cursors only        │
  └─────────────────────────────────────┘      └──────────────────────────────────┘
```

Two independent-app proofs exist side by side: `packages/reader/src/independent.ts` (channels/workspaces) and `packages/reader/src/independent-dm.ts` (DMs). Both talk only to PDSes through the published lexicons and space-credential protocol — never to this app's database — and the reader package depends on `@flock/protocol` only, so the DM proof cannot quietly depend on the DM engine it is supposed to be independent of.

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
 for each participant's conversation half (fan-out 8, packages/protocol/src/map-limited.ts):
   - read header, validate convKey + participant set match (validateDmHeaderMatchesRequest)
   - classify a failed mint as missing / deleted / revoked (SpaceCredentialError.code)
        │
        │ 3. sync and merge
        ▼
 packages/client/src/sync.ts (the engine's sync core, used by DmClient.readConversation): each readable half is a
   source; every read checks each half's revision at its host and lists only halves that moved, between two
   revision reads; messages and reactions are validated on read and merged newest key first, then by URI
   -- OR --
 packages/reader/src/independent-dm.ts: fetches each half's full bounded history up
   front, then one sort+slice (separate implementation, proves independence)
        │
        ▼
 { messages (newest first), reactions, halves: Record<did, status> }
```

Writes follow the mirror path: the engine validates a record locally with `validateSpaceRecord` before calling `com.atproto.space.putRecord`/`applyWrites` on the *caller's own* half or the *recipient's* inbox — never anyone else's conversation half, since only the half owner has `write=true` there.

## Directory map

A pnpm workspace. A package imports another by name (`@flock/<package>/<path>`, its TypeScript source; no build step) and
its own modules by relative path, and declares every package it imports; `import/no-extraneous-dependencies` holds each
to its `package.json`, so the dependency lists are the boundaries.

```
packages/                 Libraries. protocol and client run in a browser: they typecheck with no Node types
                           (`pnpm typecheck`) and may not import Node built-ins (lint).
  protocol/  @flock/protocol    Pure, isomorphic protocol logic; depends on no other workspace package.
    lexicons/                Source lexicon JSON (new.flock.*, new.flock.dm.*), the published set; imported as
                              `@flock/protocol/lexicons/<path>.json`.
    src/keys.ts              The one owner of URI and key syntax: parseSpaceUri / parseWorkspaceUri / parseChannelUri /
                              requireSpaceAuthority, isDid / isSkey / isTid, canonical record keys, TID generation,
                              canonicalParticipants. No other module hand-writes an at:// regex.
    src/nsids.ts             The one owner of NSIDs: NAMESPACE, SPACE_TYPE, COLLECTION, REPO_COLLECTION, OPERATOR_METHOD.
                              No other source module spells an NSID (registry.test.ts enforces it).
    src/registry.ts          The one table of space records (REGISTRY): space type, author, key rule, sync strategy and
                              semantic rule per collection. validateSpaceRecord = shape from the published lexicons
                              (@atproto/lexicon) + the entry's meaning rule; records are open (unknown fields kept);
                              MAX_RECORD_BYTES bounds what a reader keeps.
    src/scopes.ts            Scope builders for member, authority and operator sessions, derived from the registry,
                              DM_BROWSER_SCOPES (asserted disjoint from every server scope), memberGrantScopes: the
                              browser's one grant (member set, operator rpc, DM set), and appGrantScopes: an app's own
                              grant (its declaration, channel reads and writes, getChanges only).
    src/workspace-summary.ts What a workspace is, summarized from its authority's records, and the v1 envelope check; the
                              engine and the operator both use it.
    src/bounded-json.ts, src/map-limited.ts
                             Bounded JSON parsing of upstream answers; fixed fan-out concurrency.
    src/lexicons/api/        Generated lexicon types (do not hand-edit; `pnpm codegen:lex`).
    src/atproto/             Protocol clients shared by the engine, the readers and the operator.
      xrpc.ts                  Minimal XRPC client (query/procedure) over an injected fetch handler.
      space-key.ts             SpaceKey (WebCrypto P-256 did:key) that binds one credential. Signing, KEM and MAC formats
                                belong to @atproto/space (isomorphic).
      space-policy.ts          The one owner of the memberspace policy object the app sends and reads.
      kem-key.ts               `#atproto_kem` did:key from a DID document (server and browser share it).
      repo-failure.ts          The one classifier for "this one writer's repo cannot be read" (deactivated, taken down,
                                unauthenticated, oversized, host down): the sync, the admin inbox, DM reads, the
                                independent channel reader and the operator set the writer aside instead of failing for
                                everyone. describeRepoFailure is also what the operator logs about a failure it did not name.
      space-credential-core.ts Isomorphic space-credential mint/exchange (SpaceCredential, SpaceCredentialError,
                                mintSpaceCredentialWith) and the single owner of MAC requests and verification for getRecord
                                and getLatestCommit; isAccessLost is the one "this account lost access" predicate (refused
                                credential or deleted space); isCredentialRefused is the different question "did the host
                                refuse this credential itself"; credentialLifetimeMs reads the authority's chosen lifetime.
      record-pages.ts          Bounded listRepos/listRecords/listMembers/listSpaces paging with cursor/duplicate/limit
                                assertions; the one listBoundedSpaces and listAllSpaceUris (workspace discovery).
      valid-channel-messages.ts
  client/  @flock/client        The engine and the DM engine (isomorphic; the SDK). Depends on protocol.
    src/transport.ts         ClientTransport: what the engine needs from its host (own client, DID resolution, fetch, keys).
    src/credentials.ts       CredentialCache: one space credential per space; a refused mint drops the space (onAccessLost).
    src/identity.ts          withIdentityCache: a DID's host and KEM key held in the store (across sessions) for
                              DID_DOCUMENT_TTL_MS, six resolutions at once per origin in the process, each given up after
                              ten seconds; a failed MAC forces a fresh key. The ten-minute bound has one owner,
                              packages/protocol/src/atproto/kem-key.ts.
    src/store.ts             SyncStore contract: records, per-writer state (coverage per collection, syncedRev, generation),
                              per-space state, compare-and-set commits by generation, revision and space epoch.
    src/memory-store.ts, src/indexeddb-store.ts
                             The two stores: memory (DM spaces, tests) and IndexedDB (one database per account).
    src/merge.ts             The merge order (newest key, then URI) and the opaque (key, uri) page cursor.
    src/sync.ts              SyncCore: the writer set (full listRepos per session and truth interval, hints between),
                              bracketed refresh, backfill, set-aside writers, bounds, completeness.
    src/lifecycle.ts         When held copies stop being served: lost access, deletion, unlisted workspaces, archived
                              channels, the retention sweep (sign-out deletes the whole store: apps/web/src/browser/sign-out.ts).
    src/channel-client.ts, src/workspace-client.ts, src/operator-client.ts
                             The member's operations, each rule of the route table owned here; engine.ts wires them.
                              operator-client.ts calls every operator method, reusing one long-poll token for getChanges.
    src/feed.ts              ChangeFollower: follows spaces through getChanges in the order that loses nothing (head, sync,
                              follow), syncs changed and reset spaces, mints afresh for denied ones, and backs off a round
                              that could not finish.
    src/did-documents.ts     The one DID resolver for every client, browser or Node: a DID document fetched with no
                              redirects and a bounded body, cached; an account's PDS endpoint, KEM key and handle.
    src/session-transport.ts The engine's transport for an account's OAuth session, the browser's and a Node app's alike;
                              they differ only in the fetch they pass.
    src/app-runtime.ts       An app's runtime (R9): runApp follows the channels its install grants it in each workspace it
                              is told, gives it each new message from a person once (never an app's), follows grant
                              changes, and reports every failure; appGrantScope, publishAppDeclaration.
    src/node/                The client's only Node code (`@flock/client/node/*`, outside the browser lint rules and the
                              no-Node typecheck; browser code may not import it): transport.ts (the session transport with
                              every host reached through @flock/net) and oauth.ts (an app's OAuth client: confidential private_key_jwt
                              over https, a loopback client in development, its session in an owner-only state file, and
                              every host it reaches, the account's own PDS included, reached through @flock/net too).
    src/views.ts             Snapshots (one immutable snapshot per key, with subscriptions, for useSyncExternalStore) and
                              LiveSpaces (each watched key bound to the spaces it reads and loaded again when the feed names
                              one; a watch stops on its AbortSignal; the live loop waits until a followed space has a cursor).
    src/accept-errors.ts, src/inbox-requests.ts, src/errors.ts
                             Accept refusal codes, one writer's join requests, ChannelUnavailableError.
    src/dm/                  The DM feature (see below).
    src/testing/             Test fixtures over the fake network: engine-fixture.ts (channels and workspaces on it),
                              store-contract.ts (the SyncStore contract both stores pass).
  reader/  @flock/reader        Independent second-app readers; depends on protocol only.
    src/independent.ts       Channels/workspaces; takes injected transports (sessionCredentialDeps builds them from a
                              session), so it runs on the fake network too.
    src/independent-dm.ts    DMs (M6 independence proof).
  testing/  @flock/testing      The in-memory multi-host PDS network every engine and DM test runs on (fake-network.ts).
  net/  @flock/net              Node only: how a server process reaches a host someone else named (safe-fetch.ts): https to a
                              public address only (loopback in loopback development), the address checked is the one
                              connected to, no redirect, a minute's timeout. The operator and a Node app both use it.
  deployment/  @flock/deployment
                             What the web app and the operator share about how they are deployed: the public URLs and
                              their rules (config.ts: APP_URL, OPERATOR_URL, PLC_URL, OPERATOR_SERVICE_REF; HTTPS unless
                              loopback) and the security headers every response carries (security-headers.ts).

apps/
  echo-bot/  @flock/echo-bot    The first app (R9): depends on @flock/client alone (a test pins it). `pnpm echo-bot sign-in
                              <handle>` once, then `pnpm echo-bot run`; echo.ts is its answer and its runApp wiring.
  web/  @flock/web              The Next.js app (`pnpm dev` / `build` / `start` run `next` here). No database, no secret.
    next.config.ts           Security headers; the repository root's `.env` (Next itself reads only this app's directory).
    src/app/                 App Router: page.tsx (builds the browser session config and renders the client gate,
                              ui/account-gate.tsx), layout.tsx, oauth/ (the sign-in callback page, client-only, and the
                              browser client's metadata). The server has no member routes and no member session.
    src/app/ui/              React components. workspace-manager.tsx is the main stage; dm-*.tsx are the DM views, wired in
                              through dm-context.tsx / dm-session-bridge.tsx. The shell's data are the engine's keyed live
                              views, read through use-live-view.ts (useSyncExternalStore): use-discovery.ts,
                              use-channel-content.ts, use-admin-views.ts; selection.ts derives what is shown.
                              apps-panel.tsx is the admins' view of the workspace's apps (install only an account that
                              declares itself one, change access, remove after saying its messages leave the view);
                              channel-view.tsx marks an installed app's messages "APP".
    src/browser/             The account's browser session (R6a, R6c): one OAuth grant through
                              @atproto/oauth-client-browser (session.ts: one client and one init per page, signIn,
                              signOut), sign-out (sign-out.ts: deletes the account's store and DM state and revokes the
                              session), the client metadata builder, and useBrowserSession (identities resolve through @flock/client/did-documents).
                              The page's and callback's config has one owner: src/app/browser-session-config.ts.
    src/lib/within.ts        A bounded wait, used by sign-out.
  operator/  @flock/operator    The workspace-authority operator: its own process at OPERATOR_URL.
    src/config.ts            What only the operator reads: its database path, its encryption key, the authority client's
                              signing keys (the shared URLs come from @flock/deployment).
    src/operator/server.ts, main.ts, methods.ts
                             The process: xrpc-server with the app's lexicons, CORS for the web origin, the authority flow,
                              did:web; the methods as transport-free functions and describeFailure.
    src/operator/authority-grant.ts
                             The one owner of the workspace authority grant: its own OAuth client (confidential
                              private_key_jwt outside loopback), the ticket -> /authority/start -> PDS consent ->
                              /authority/callback flow (started by the account itself, or by someone creating a workspace
                              under it, R8), and the `authority_grant` table. Each restore is a client over a view of one
                              approval, so a session still in use after a new approval can neither use nor delete it.
    src/operator/creation-authorization.ts
                             The one owner of the approval to create a workspace under an account other than one's own: a
                              completed flow's single-use, 15-minute approval of one name for one person, consumed as the
                              creation's journal row is inserted and restored for that operation if its first step lacked a
                              scope. When a creation may start at all (the approval, a new workspace, no unfinished claim
                              on it) is creationAdmission in kinds/create-workspace.ts.
    src/operator/journal.ts  runJournaledOperation: the workspace lock, the operation row (an admission that verifies under
                              the lock, then admits in the insert transaction, and restores what let the row in), declared
                              step names, resume by name and request hash, "waiting for the authority's approval", and
                              the three-minute limit after which a run starts no further step; operationView.
    src/operator/kinds/      One file per operation kind; kinds/index.ts is the table every request and journal row
                              dispatches through, and kinds/kinds.test.ts pins every persisted kind, field and step name.
                              A kind whose request takes away its submitter's own role says so (endsOwnRole):
                              authorizeSubmittedOperation in src/operator/security.ts lets that submitter send the
                              journaled operation again after current state refuses them.
                              create-workspace.ts creates a workspace for its creator (its first admin and member) under
                              its account; bootstrap-workspace.ts only resumes rows begun before it. Their shared space
                              and record actions are src/operator/workspace-spaces.ts. app-access.ts installs, changes and
                              uninstalls an app: its install record first, then its member-list entries.
    src/operator/membership.ts
                             The one owner of who belongs in each member list, and with which bits: people from the roster,
                              admins and private rosters, apps from their install records (read and written here). Every
                              operation that moves a list, reconcile included, takes its expected list from here.
    src/operator/operations.ts, actor.ts, security.ts
                             Request validation and execution; who an operation runs for; service-auth verification with
                              each method's token lifetime and authorizeOperationActor.
    src/operator/feed.ts, member-access.ts, members.ts, notices.ts, registrations.ts
                             getChanges and who may follow a space (members.ts is the only way the operator changes a member
                              list, lint-enforced); the capped notice table; the notice registrations and their sweep.
    src/operator/workspace-state.ts, workspace-envelope.ts, stalled.ts, testing/fake-authority-pds.ts
    src/auth/                OAuth plumbing for the authority grant: the flow binding (oauth-flow.ts), the encrypted SQLite
                              stores (encrypted-store.ts, with a view that sees only the values it accepts), the
                              cross-process refresh lock, scope canonicalization.
    src/atproto/             Server-side atproto: identity.ts (DID→PDS resolution, every host reached through @flock/net), space-credential.ts (a
                              server adapter over the core), space-ops.ts, write-notification.ts, client.ts.
    src/lib/db.ts, dm-subscription.ts
                             The SQLite database and its migrations; DM change-notice subscriptions.
    scripts/                 reconcile-workspaces.ts (`pnpm reconcile`), authority-grant.ts (`pnpm authority`).

bdd/, features/           Executable Gherkin (below).
protocol-tests/           Backend acceptance/performance against the pinned PDS checkout, plus Playwright browser acceptance
                           (protocol-tests/browser/).
  atproto/                  Protocol conformance suites copied into the pinned checkout to run (its imports are that tree's).
docs/                     Operations runbook, protocol pin, and PRD/implementation-plan docs.
.ai/plans/                Design docs and per-milestone task specs (dm-tasks/m0.md..m6.md).
scripts/                  codegen-lex.mjs, backup-db.mjs, playground.ts, render-bdd-video.ts.
```

### `packages/client/src/dm` in detail

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
- The browser session and client metadata moved to `apps/web/src/browser` in R6a (one grant for the workspace engine and
  the DMs); identity resolution is the client's (`packages/client/src/did-documents.ts`, R9b).
- `browser-store.ts` — the `DmDeps.store` implementation: `localStorage`, per-DID prefixed,
  falling back to in-memory state (and saying so) when storage is unavailable.
- `ui-logic.ts` — pure UI helpers (participant-input parsing, conversation labels/visibility,
  co-member/allowlist edits) kept separate from the `dm-*.tsx` components for testability.

The DM engine is part of `@flock/client`, which depends on `@flock/protocol` only: it cannot reach the server's database,
operator or OAuth layers even by accident, and lint refuses a Node built-in in any of its modules except the tests.

## Entry points

- `apps/web/src/app/page.tsx` — the one page in the app; resolves session state and renders everything else.
- `pnpm dev` / `pnpm build` / `pnpm start` — the web app (Next.js dev/build/prod, see `package.json`). It holds no database
  and no secret.
- `pnpm operator` (`apps/operator/src/operator/main.ts`) — the operator's own process at `OPERATOR_URL`: `apps/operator/src/operator/server.ts` serves its
  methods (`apps/operator/src/operator/methods.ts`: `execute`, `getOperation`, `listInboxWriters`, `getChanges`, `createWorkspace`,
  `startAuthorityFlow`, `listStalledOperations`, each authenticated by a PDS-issued service token, and the two notices) on
  `@atproto/xrpc-server` with the app's lexicons, CORS for the web origin only, the authority flow (`/authority/*`) and its
  `did:web` document; it runs the notice-registration sweep at start.
- `pnpm playground` (`scripts/playground.ts`) — a local copy of the whole stack with ready-made accounts, for trying the app by hand (`ATPROTO_PINNED_CHECKOUT` must point at the built pinned checkout).
- `pnpm reconcile` (`apps/operator/scripts/reconcile-workspaces.ts`) — the scheduled membership-reconciliation job (`docs/operations.md`).
- `pnpm authority` (`apps/operator/scripts/authority-grant.ts`) — generate an authority client key, or revoke an authority grant.
- `pnpm backup:db` (`scripts/backup-db.mjs`) — online SQLite backup.
- `pnpm test` — unit tests (`node --test` over every `*.test.ts` in `packages/*/src` and `apps/*/src`), plus `bdd/gate.test.ts`, which keeps the Gherkin features honest (below).
- `pnpm typecheck` — the whole repository with Node types, then `packages/protocol` and `packages/client` with none (and a check that no `@types/node` reaches them).
- `pnpm test:bdd` — builds, then runs the executable Gherkin scenarios in `features/` with `@cucumber/cucumber`, driving real browsers against a real pinned PDS network.
- `pnpm test:acceptance` — builds, then runs `protocol-tests/{app-acceptance,reconcile-workspaces,dm-acceptance,authority-grant,platform-capabilities,engine-acceptance,feed-follow,apps,echo-bot}.test.ts` against a real pinned PDS network (needs `ATPROTO_PINNED_CHECKOUT`). `platform-capabilities` and `authority-grant` hold the platform refactor's capability checks (K1, K3, K7), `engine-acceptance` the engine's parity with the independent reader on two real hosts, `apps` (R9) an app installed, refused what it is not granted and uninstalled on two real hosts, `echo-bot` (R9's gate) the echo bot answering through the feed and refused once uninstalled, and `feed-follow` (R5's gate) a cookie-less member following a channel live through `getChanges` with `next start` receiving the PDS's notices (`protocol-tests/support/app-server.ts`), all on the network-only helper `protocol-tests/support/pds-network.ts` (`actorTransport` builds the engine's transport for a real account).
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
bdd/support/world.ts      per-scenario world: fresh accounts and browser contexts, PDS reads, read-only app DB, and a
                          teardown list for what a scenario runs in this process (features/apps.feature runs the echo bot)
bdd/support/hooks.ts      starts the shared fixture once; BDD_HEADED=1 BDD_BROWSER_CHANNEL=chrome opens real Chrome
bdd/gate.test.ts          runs in `pnpm test`: the @unbound count may only go down, every @unbound says why,
                          every bound scenario (including @slow) has a definition for every step
protocol-tests/support/app-fixture.ts
                          the stack (two PDS hosts, PLC, lexicons, `next start` and the operator process) used by the BDD run and
                          `pnpm playground`; `startSecondApp({env})` adds an independent app instance
```

Run: `pnpm test:bdd` (headless), `pnpm test:bdd:chrome` (visible Google Chrome), `pnpm test:bdd:slow` (the delegated failure-injection and 200-member envelope runs). Steps drive the real UI and assert on observable facts (the page, the PDS, the journal); a scenario that passes proves a journey works for a person. Where a browser cannot reach the mechanism (injected PDS write failures, a 2,000,000-record workload) the step runs the existing protocol test as a child process and says so. `protocol-tests/browser/*.spec.ts` and `protocol-tests/app-acceptance.test.ts` still carry their own copies of the stack set-up and should move onto the shared fixture.

## Conventions

- Dense, explicit TypeScript: named exports only, kebab-case file names, no default exports.
- Tests are `node:test` + `node:assert/strict`, named `*.test.ts` next to the code they cover.
- Comments explain *why*, not *what*; the surrounding code is expected to be self-documenting.
- Every externally supplied DID, AT-URI, record key, and record is validated before use
  (`packages/protocol/src/keys.ts` parsers/predicates, `packages/protocol/src/registry.ts` validators); nothing
  parsed from a PDS response is trusted without going through them first.
- Every PDS list/page fetch goes through the bounded helpers in `packages/protocol/src/atproto/record-pages.ts`,
  which assert cursor progress, page-size limits, and no duplicate keys,
  and report `truncated` rather than silently dropping data past a scan cap.
- Concurrency is `packages/protocol/src/map-limited.ts` (fixed fan-out, currently 8 for DM/channel fan-out),
  not ad hoc `Promise.all` over unbounded arrays.
- Package boundaries are dependency lists: protocol and net depend on no workspace package; client on protocol and net (net
  for its Node entry only); reader on protocol only; the operator on protocol, net and deployment; the web app on client,
  protocol and deployment; the echo bot on client only. No app imports another. Lint adds what a list cannot say: no Node
  built-ins or server configuration in browser code, no client Node entry or @flock/net in browser code or the web app,
  member lists changed only through `members.ts`, and no DM engine in the web app's route handlers
  (`apps/web/src/app/**/route.ts`).
- DM invariants (no server session, no server cache, no app-decided access, independent-app
  parity) are treated as architectural constraints, not defaults to be revisited later; see
  `SPEC.md`'s "Direct-message invariants" and `.ai/plans/direct-messages.md` §1–§2.
