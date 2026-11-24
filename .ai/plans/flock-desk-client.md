# Flock Desk — Independent OpenSocial & Spaces Browser Client

**Status:** Planned (Rev 4 — R13 `opensocial.group` baseline; incorporates Round 1–3 Claude & Codex review fixes)  
**Protocol Baseline:**
- ATProto Permissioned Spaces Proposal 0016 / `bluesky-social/atproto#5187` @ `6747610566eee1b6d743617bd8eb1136adccb362` (`0.0.0-spaces-alpha-20261117141222` + `strict-credential-expiry.patch`; see `docs/protocol/atproto-spaces-pin.md`)
- `opensocial.group` Atmospheric Groups Proposal @ `8df0cc82eb7708f090aa43522adf1d3ada3ed7e7` (merged to `main` at `8ae87a5`)
**UI Stack:** [Astryx](https://github.com/meta/astryx) (`@astryxdesign/core`, `@astryxdesign/theme-neutral`, `@stylexjs/stylex`), gated by a runnable D0 Next 16 / React 19 / CSP spike (`protocol-tests/browser/desk-csp.spec.ts`) with an explicit CSS Modules fallback.

---

## 1. Goal and the Claim This Client Must Prove

Ship a **second, genuinely independent browser client (`apps/desk`)** for the published `group.opensocial.*` and `new.flock.*` lexicons that is visibly and architecturally unrelated to `@flock/web` and **must not use `@flock/client`, `@flock/web`, or `@flock/operator`**:

- **Zero `@flock/client`:** no `SyncCore`, no `LiveSpaces`, no `WorkspaceClient`, no `GroupClient`, no `DmClient`, no IndexedDB protocol record cache.
- **Zero `@flock/operator` in v1:** Desk talks **only** to standard decentralized ATProto endpoints—the viewer's personal PDS, each group's `opensocial.group` Group Host, each channel writer's personal PDS (resolved via DID during channel reads), and PLC / `did:web` identity endpoints. Desk runs with **no Operator process** and **no server SQLite database**.

Today we have three layers of independence evidence, each with a remaining gap:

| Layer | What it proves | Remaining gap |
|---|---|---|
| `packages/reader/src/independent*.ts` | Canonical **read** state from published lexicons, PDS/Group Host, and space credentials alone | Headless library only; no UI, no writes, no OAuth UX |
| BDD `features/independent-app-and-launch.feature` | Two **browser origins** render the same workspace | `startSecondApp()` spawns a second `@flock/web` + second Operator process (same engine, same CSS, different OAuth `client_id` & SQLite DB) |
| `@flock/echo-bot` / `@flock/webhooks` | Third-party-style services using public APIs | Node bots depending on `@flock/client` and Operator `getChanges`, not an independent browser client |

**Flock Desk** closes that gap: a user (and protocol reviewers) can sign in on a separate origin, discover expiring cross-PDS invites (`group.opensocial.invites/self`), open direct-grant invite links, or join/leave an OpenSocial group directly on the Group Host, browse channels and private rosters, post/edit/delete messages, view moderated transcripts (`!hide` / `!takedown`), submit moderation reports, and verify byte-for-byte canonical parity against `@flock/web` and `@flock/reader`—without touching `@flock/client` or Flock's Operator at all.

Success is **not** pixel parity with `@flock/web`. Success is **canonical state & moderation parity** under `SPEC.md` § "Independent-app parity" and the BDD scenario *Render one workspace from two independent apps*, with the second browser origin serving **Flock Desk**.

---

## 2. Non-Goals (v1 of Desk)

- Replacing or deprecating `@flock/web` (the reference app remains the primary client for full workflows).
- Admin / Group-DID OAuth workflows (`prompt=create` group genesis, channel creation, role/policy editing, moderator queue resolution, Group Host migration, Operator pause switch / journal inspection). Desk v1 uses **personal-PDS OAuth only**.
- App installs, slash commands, interactive blocks, or echo-bot / webhook administration.
- Incremental sync engine, background `authorizeSpaceSync(notify)` push relays, or IndexedDB protocol record caches. (Desk performs bounded direct reads via `@flock/reader` on navigation, write completion, or manual/periodic refresh. The **only** browser persistence Desk holds is `@atproto/oauth-client-browser`'s origin-isolated OAuth store `@atproto-oauth-client`, a tiny per-viewer operational workflow journal `flock-desk-lifecycle:<viewerDid>` storing solely in-flight join/leave operation rows—never protocol records—and short-lived `sessionStorage` for pre-OAuth invite-link survival.)
- Shipping Desk or `@flock/shell` as standalone published npm packages outside this monorepo (both live in-repo as private workspace packages).

---

## 3. Architecture

### 3.1 Packages, Dependency Graph, and Hard Boundaries

```text
apps/desk (@flock/desk)              Next.js 16 App Router (--webpack), React 19, Astryx UI
  ├─ depends on: @flock/shell, @flock/reader, @flock/protocol, @flock/deployment,
  │              Astryx/StyleX, next, react, react-dom
  └─ MUST NOT import: @flock/client, @flock/web, @flock/operator, @flock/group-host, @flock/net

packages/shell (@flock/shell)        Thin browser-only protocol adapter (no sync engine, no Operator)
  ├─ Personal-PDS OAuth 2.1 browser session (`BrowserOAuthClient` with explicit loopback `allowHttp`,
  │  origin-isolated `@atproto-oauth-client` IDB, pure `buildDeskClientMetadata`, hardened `wellKnownHandleResolver`)
  ├─ Bounded, redirect-disabled, private-network-hardened DID / `#atproto_pds` / `#atproto_kem` resolver
  ├─ `SpaceCredentialDeps` factory structurally assignable to `@flock/reader`'s `IndependentDeps`
  │  (zero runtime or package.json dependency on `@flock/reader`)
  ├─ Minimal direct writes + group moderation metadata reader: `ensureInvitesSpace`, concurrency-safe &
  │  crash-/migration-safe `acceptDirectMembership`/`joinGroup`/`reconcileLifecycle`/`cancelPendingJoin`/
  │  `dismissJoinOperation`/`leaveGroup`, channel messages (`createRecord`/verified `putRecord`/`deleteRecord`
  │  with fresh credentials), `readGroupModerationConfig` + `reportSubject` (`createReport`)
  ├─ depends on: @flock/protocol, @atproto/oauth-client-browser (dev: @flock/testing, fake-indexeddb)
  └─ MUST NOT import: @flock/client, @flock/web, @flock/operator, @flock/group-host, @flock/net,
     @flock/deployment, @flock/reader, node:*

packages/reader (@flock/reader)      Unchanged contract: read-only, depends on @flock/protocol + @atproto/*
packages/protocol (@flock/protocol)  Published lexicons, least-privilege `deskMemberScopes()`, validation, moderation, credential core
packages/deployment (@flock/deployment) Adds `DESK_ENV_FILE_KEYS` + `getDeskConfig()` (no OPERATOR_URL / OPERATOR_SERVICE_REF)
```

Boundary enforcement (all fail CI):

1. **Recursive AST boundary tests (`packages/shell/src/boundary.test.ts` and `apps/desk/src/boundary.test.ts`):**
   - Both tests walk `src/` **recursively** across all `.ts`, `.tsx`, and `.mts` files and parse every file with the TypeScript compiler API (`ts.createSourceFile`, using root `devDependencies` via an `eslint.config.mjs` `import/no-extraneous-dependencies` `packageDir` override mirroring `packages/client/src/eslint-boundaries.test.ts`).
   - Extract **all** module specifiers from `ImportDeclaration`, `ExportDeclaration` (`export ... from`), dynamic `import(...)`, and `require(...)`:
     - **Production files** (excluding `*.test.{ts,tsx,mts}` and `__tests__/**`, mirroring ESLint's `NODE_TESTS` exemption so unit/boundary tests themselves may import `node:test`, `node:assert/strict`, `node:fs`, `typescript`, `@flock/testing`, and `fake-indexeddb`): fail on any computed dynamic `import(expr)` or any specifier outside the package's declared production allowlist (including forbidding `node:*` in `@flock/shell` production source and forbidding `@flock/deployment/*` in Desk browser/client components).
     - **All files (including tests):** fail if any file anywhere in `packages/shell/src/**` or `apps/desk/src/**` imports `@flock/client`, `@flock/web`, `@flock/operator`, `@flock/group-host`, or `@flock/net` (and for `packages/shell/src/**`, also `@flock/reader` and `@flock/deployment`).
   - **Package manifest & transitive production closure check:** Verify the package's own `dependencies` and `devDependencies` list zero forbidden `@flock/*` packages, and recursively traverse **production `dependencies` only** across every workspace package in the production dependency graph (never traversing transitive `devDependencies` of test-only devDependencies like `@flock/testing`, which dev-depends on `@flock/group-host` for its own test harness), asserting zero forbidden `@flock/*` packages are reachable.
2. **`eslint.config.mjs` updates (preserving D11.11 baseline rules without shadowing):**
   - Add `packages/shell/src/**/*.{ts,tsx}` to `BROWSER_CODE`, **and** add a dedicated `packages/shell/src/**/*.{ts,tsx}` boundary block (spreading `[NO_NODE_BUILTINS, NO_SERVER_CONFIG, NO_APP_LAYER, NO_CLIENT_NODE_ENTRY, NO_ENTITY_MERGE_IMPORT, NO_EXTENSION_IMPORT]` for production files, and forbidding `@flock/client`, `@flock/web`, `@flock/operator`, `@flock/group-host`, `@flock/net`, `@flock/deployment`, `@flock/reader` via BOTH static `no-restricted-imports` and literal dynamic `ImportExpression` `no-restricted-syntax` plus `NO_COMPUTED_DYNAMIC_IMPORT` across all Shell files including tests).
   - Add dedicated Desk boundary blocks that spread `[NO_ENTITY_MERGE_IMPORT, NO_EXTENSION_IMPORT]` plus Desk-forbidden static `no-restricted-imports` AND literal dynamic `ImportExpression` `no-restricted-syntax` rules AND `NO_COMPUTED_DYNAMIC_IMPORT`:
     - **All `apps/desk/src/**/*.{ts,tsx}`** (including server routes, `proxy.ts`, layouts/pages, and tests): forbid `@flock/client`, `@flock/web`, `@flock/operator`, `@flock/group-host`, `@flock/net` (both static imports/re-exports and dynamic `import(...)`).
     - **All Desk browser/client code** (`apps/desk/src/**/*.{ts,tsx}` ignoring **only** Next.js server entrypoints `apps/desk/src/proxy.ts`, `apps/desk/src/lib/loopback-redirect.ts`, `apps/desk/src/app/**/layout.tsx`, `apps/desk/src/app/**/page.tsx`, `apps/desk/src/app/**/route.{ts,tsx}`, and `NODE_TESTS`): additionally forbid `node:*`, `@flock/deployment`, and `@flock/deployment/*` (both static and literal dynamic `import(...)`), covering `apps/desk/src/browser/**`, `apps/desk/src/app/ui/**`, `apps/desk/src/components/**`, and every other non-entrypoint module under `apps/desk/src/**`.
   - Keep `flock-boundaries/no-legacy-memberspace` enabled everywhere in Desk and Shell, adding **only** `packages/shell/src/invites.ts` and `packages/shell/src/invites.test.ts` to `MEMBERSPACE_LIST_ONLY_ALLOWLIST` (`allowListMembers: true`) so `ensureInvitesSpace()` can verify zero members on personal `group.opensocial.invites/self` while `putMembers`/`removeMembers` remain forbidden.
   - Update `settings.next.rootDir` to `["apps/web/", "apps/desk/"]`. (`globalIgnores` already ignores `**/.next/**` and `**/next-env.d.ts`.)
3. **Browser type-purity & root TypeScript config (`package.json` `typecheck` + `tsconfig.json`):**
   - Add `packages/shell/tsconfig.json` (browser-only `lib`, no `@types/node`) and `apps/desk/tsconfig.json`, and include `apps/desk/next-env.d.ts`, `apps/desk/.next/types/**/*.ts`, and `apps/desk/.next/dev/types/**/*.ts` in root `tsconfig.json` alongside `apps/web`.
   - Extend `pnpm typecheck` with `tsc -p packages/shell && ! tsc -p packages/shell --listFilesOnly | grep -q /@types/node/` so `@flock/shell` stays 100% browser-pure alongside `@flock/protocol` and `@flock/client`.
4. **Root `package.json` build contract, `startDeskServer()` (D0), & `apps/desk/package.json` scripts:**
   - In `apps/desk/package.json`, pin local dev/start to unoccupied port **`3005`** (since `README.md` reserves `:3000` Web, `:3001` Operator, `:3002` Echo Bot, `:3003` Webhooks, `:3004` Group Host):
     - `"dev": "next dev --webpack --hostname 127.0.0.1 --port 3005"`
     - `"build": "next build --webpack"`
     - `"start": "next start --hostname 127.0.0.1 --port 3005"`
   - In root `package.json`, add `"build:web": "pnpm --filter @flock/web build"`, `"build:desk": "pnpm --filter @flock/desk build"`, `"dev:desk": "pnpm --filter @flock/desk dev"`, `"start:desk": "pnpm --filter @flock/desk start"`.
   - Starting in D0, update root `"build"` to `"pnpm --filter @flock/web build && pnpm --filter @flock/desk build"` so every downstream script (`test:browser`, `test:bdd`, `test:bdd:video`, `test:bdd:slow`, `test:bdd:chrome`, `test:acceptance`, and D7's bare `pnpm build`) always produces an up-to-date `apps/desk/.next` artifact automatically.
   - Starting in D0, add `startDeskServer(env)` to `protocol-tests/support/app-server.ts` launching `apps/desk/node_modules/next/dist/bin/next start apps/desk --hostname <host> --port <port>` and waiting on `/oauth/client-metadata.json` (used immediately by D0's `protocol-tests/browser/desk-csp.spec.ts` and later by `desk-parity.spec.ts`).
   - Add `"@flock/shell": "workspace:*"` and `"@flock/desk": "workspace:*"` to root `package.json` dependencies if needed by test/BDD imports (`pnpm-workspace.yaml` already covers `packages/*` and `apps/*`).

### 3.2 Read Path (Unchanged `@flock/reader` + Minimal Labeler/Rule Helper in `@flock/shell`)

All workspace, invite, channel, moderation-label projection, and (optional v1.1) DM/Tasks read models call existing `@flock/reader` functions directly—never reimplementing record parsing, RBAC/policy summarization, or label projection in Desk, and making **zero changes** to `packages/reader`:

| Surface | Read API | Exact Semantics & Notes |
|---|---|---|
| Joined workspaces | `@flock/reader/independent` `listIndependentWorkspaces(deps)` | Discovers bilaterally accepted groups via personal PDS `listSpaces({ spaceType: "group.opensocial.members" })`, checks own `acceptance/self` when `deps.did` is set, and reads each group via `readIndependentWorkspace`. *(Direct-grant members who have not yet written `acceptance/self` do not appear here until they accept via an invite link or Desk's "Join workspace" bar.)* |
| Single workspace detail / directory / roster / admins | `@flock/reader/independent` `readIndependentWorkspace(deps, workspaceUri)` | Reads `<groupDid>` `meta/self`, `members/self`, `workspace/self`, and `com.atproto.space.policy`; withholds `!takedown` members |
| Incoming cross-PDS expiring invites | `@flock/reader/independent` `readIndependentInvites(deps, viewerDid, nowMs?)` | Lists writers of the viewer's personal `group.opensocial.invites/self` space on the personal PDS, then fetches and validates `group.opensocial.invite` records from each writer group's PDS using the `invites/self` space credential (tombstone- and expiry-aware) |
| Channel transcript, reactions & moderation labels | `@flock/reader/independent` `readIndependentChannelPage(deps, workspaceUri, channelSkey, limit?)` | Lists channel writers, fetches each writer's personal PDS records, and projects `<groupDid>`-authored `com.atproto.label.record` (`!takedown` withheld; `!hide` flagged via `hidden: true`) |
| Private channel roster | `@flock/reader/independent` `readIndependentPrivateRoster(deps, workspaceUri, channelSkey)` | Intersects validated group memberships (excluding `!takedown` accounts and installed app subjects) with `group.opensocial.policy` read-grant roles *(does not gate on bilateral `acceptance/self`)* |
| Group report config (`labeler/self` + `rule/*`) | `@flock/shell/moderation` `readGroupModerationConfig(deps, groupDid)` | Small targeted read helper in `@flock/shell` (since `@flock/reader` stays unchanged): reads and validates `<groupDid>`'s `group.opensocial.labeler/self` and `group.opensocial.rule` records from `meta/self` via `mintSpaceCredentialWith` + `validateSpaceRecord` |
| DM conversation *(v1.1 / D6)* | `@flock/reader/independent-dm` `readIndependentDmConversation(deps, convKey, participants)` | Optional v1.1 read model |
| Tasks snapshot *(v1.1 stretch)* | `@flock/reader/independent-tasks` `readIndependentTasksWorkspaceSnapshot`, `readIndependentTasksSpace` | Optional v1.1 read model |

`@flock/shell` exposes `createBrowserSpaceCredentialDeps(session, config)` returning an object of type `SpaceCredentialDeps & { readonly did: string }` (structurally assignable to `@flock/reader/independent`'s `IndependentDeps`, with zero package dependency from `@flock/shell` onto `@flock/reader`):
- **Hardened browser URL & DID / `#atproto_pds` / `#atproto_kem` / handle resolution (`packages/shell/src/did-resolver.ts` + `packages/shell/src/session.ts`):**
  - Fetch-only with `redirect: "error"`, `256 KiB` body cap (`readUpstreamJson`), `forceRefresh` support for migrated hosts and KEM key rotation (`kemKeyFromDidDocument` from `@flock/protocol/atproto/kem-key`).
  - **Strict browser endpoint URL guard (`assertSafeBrowserEndpointUrl(url, loopbackAllowed)`), matching the complete canonical non-public CIDR denylist in `packages/net/src/safe-fetch.ts:344-357`:**
    - Forbids embedded credentials, query strings, and fragments in all modes.
    - **Always** rejects non-public IP literals and local hostnames **even when `loopbackAllowed === true`**:
      - Local hostnames: `*.local`, `*.internal`.
      - IPv4: `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `169.254.0.0/16`, `172.16.0.0/12`, `192.0.0.0/24`, `192.0.2.0/24`, `192.88.99.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`, `224.0.0.0/4`, `240.0.0.0/4`.
      - IPv6: `::/96` *(IPv4-compatible IPv6 & unspecified `::`; exact `::1` exempted only in loopback mode)*, `::ffff:0:0/96` *(IPv4-mapped IPv6; `::ffff:127.0.0.0/104` exempted only in loopback mode)*, `64:ff9b::/96` & `64:ff9b:1::/48` *(NAT64)*, `100::/64` *(discard)*, `2001::/32` *(Teredo)*, `2001:2::/48` *(benchmarking)*, `2001:db8::/32` *(documentation)*, `2002::/16` *(6to4)*, `fc00::/7` *(ULA)*, `fe80::/10` *(link-local)*, `ff00::/8` *(multicast)*.
    - When `loopbackAllowed === true`, permits HTTP and local addressing **strictly for exact loopback hosts only** (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`, and `::ffff:127.0.0.0/104`).
    - When `loopbackAllowed === false`, rejects loopback hosts as well and requires HTTPS everywhere.
  - **Applied to BOTH DID/PDS/KEM resolution AND OAuth handle resolution:** Desk's `wellKnownHandleResolver` (`https://<handle>/.well-known/atproto-did`, `redirect: "error"`, `512`-byte cap via `readUpstreamText`) validates the target URL with `assertSafeBrowserEndpointUrl(url, loopbackAllowed)` before calling `fetch()`, so handle sign-in cannot probe private, NAT64/6to4/Teredo, metadata, or disallowed loopback targets.
- **Credential minting & clock safety:** Because `@flock/reader` invokes `mintSpaceCredentialWith(deps, spaceUri)` directly on every read—and `mintSpaceCredentialWith` (`packages/protocol/src/atproto/space-credential-core.ts`) already handles issuer-clock lifetime calculation (`credentialLifetimeMs` deriving `exp - iat` on the issuer's clock added to `(deps.now ?? Date.now)()`, never comparing browser wall clock directly to raw JWT `exp`) plus migrated-host `forceRefresh` retry—`@flock/shell` does **not** add an unused reader credential cache. Every Desk read uses `@flock/reader` directly, and every Desk write mints a fresh credential immediately prior to mutation (see §3.3).

### 3.3 Write Path (Minimal, Direct Protocol Only — Zero Operator)

Every write in `@flock/shell` validates payloads via `validateSpaceRecord` (`@flock/protocol/registry`) and talks strictly to the user's personal PDS or the target Group Host:

1. **`ensureInvitesSpace()` (`packages/shell/src/invites.ts`):**
   - Serialized across tabs with `navigator.locks.request("flock-desk-invites-provision:" + viewerDid, { mode: "exclusive" }, ...)` when available and single-flight deduplicated in-memory.
   - Idempotently creates `at://<viewerDid>/space/group.opensocial.invites/self` on the user's personal PDS with `com.atproto.memberspace.policy { publicWrite: true, publicRead: false }` (no `allowedApps`), reads back `com.atproto.space.getSpace` + `com.atproto.memberspace.listMembers({ space, limit: 1 })`, and **fails closed** (`IncompatibleInvitesSpacePolicyError`) unless ALL four R13 invariants hold (matching `packages/client/src/workspace-client.ts:351-362`):
     1. `settings.publicWrite === true`
     2. `settings.publicRead === false`
     3. `settings.allowedApps === undefined` *(rejects even `[]`)*
     4. `(memberPage.members?.length ?? 0) === 0`
2. **Account-Scoped, Concurrency-Safe, Crash- & Migration-Safe Membership Lifecycle (`packages/shell/src/membership.ts` + `packages/shell/src/lifecycle-store.ts`):**
   - **Account-scoped operational journal (`flock-desk-lifecycle:<viewerDid>`):**
     - Partitioned strictly by `viewerDid` (one small IndexedDB database per signed-in DID), storing **only** tiny in-flight workflow rows (`joiningGroups` and `leavingGroups`)—never protocol records or sync state.
     - Every persisted row embeds `viewerDid`, and every lifecycle operation asserts `row.viewerDid === session.did` before issuing any network call.
     - On `signOut()`, Desk closes and deletes `flock-desk-lifecycle:<viewerDid>` (alongside `session.signOut()` and clearing `sessionStorage`), guaranteeing zero cross-account residue after an account switch.
   - **Per-viewer, per-group concurrency serialization (`withGroupLifecycleLock(viewerDid, groupDid, fn)`):**
     - **All** membership lifecycle mutations (`acceptDirectMembership`, `joinGroup`, `reconcileLifecycle`, `cancelPendingJoin`, `dismissJoinOperation`, `leaveGroup`) execute inside an in-process per-`(viewerDid, groupDid)` promise queue **and** cross-tab `navigator.locks.request("flock-desk-group:" + viewerDid + ":" + groupDid, { mode: "exclusive" }, ...)` when available (matching `WorkspaceClient.withGroupLifecycleLock`).
   - **`acceptDirectMembership({ groupDid })`** *(direct-grant membership via invite link or workspace URI, e.g., default `@flock/web` invite without `expiresAt` or re-admission after ejection)*:
     1. Mints a fresh space credential for `groupMembersUri(groupDid)` (`mintSpaceCredentialWith`).
     2. Reads live `membership/<viewerDid>` from `<groupDid>`'s Group Host (with `forceRefresh` retry on stale host codes), extracting `incarnation` (or fallback `"legacy-cid:" + cid` when present).
     3. **Unconditionally writes/overwrites** `group.opensocial.acceptance/self` on the user's personal PDS inside `groupMembersUri(groupDid)` stamped with the live incarnation—repairing **both** missing acceptance and stale-incarnation acceptance left over from a prior ejection + re-admission (matching `WorkspaceClient.accept()`).
   - **Crash-safe `joinGroup({ groupDid, inviteUri?, message? })` & durable `joiningGroups` state machine** *(mirroring `packages/client/src/store.ts:123-154` and `workspace-client.ts:1450-1588`)*:
     - If no `inviteUri` is supplied and the viewer already holds live `membership/<viewerDid>` on the Group Host (e.g., opening `/?invite=<workspaceUri>` after a direct-grant invite from `@flock/web` or after joining on another client), delegates directly to `acceptDirectMembership({ groupDid })` (repairing missing or stale incarnation) and returns `{ status: "admitted" }`.
     - Otherwise creates or resumes a durable `joiningGroups` row containing `{ viewerDid, operationId, mode: "open" | "invite" | "approval", intentHash, groupDid, inviteUri?, message?, authorityEndpoint?, currentIncarnation?, rawStatus?, phase, createdAt }`, advancing strictly through five active durable phases:
       1. `submitting`: persisted **before** calling `POST <groupHost>/xrpc/group.opensocial.requestJoin` (personal service JWT `aud: <groupDid>#atproto_pds`, `lxm: "group.opensocial.requestJoin"`, `Idempotency-Key: <operationId>`). A crash/reload before receiving the HTTP response safely replays `requestJoin` using the persisted `operationId`, `inviteUri`, and `message` without double-consuming an invite.
          - **HTTP/XRPC error handling (matching `workspace-client.ts:1468-1478`):**
            - `429 JoinOperationQuotaExceeded` → persists passive `phase: "quota_exceeded"` (never auto-retried on reload; user-dismissible via `dismissJoinOperation`) and throws `JoinOperationQuotaExceededError`.
            - Terminal XRPC codes (`TERMINAL_JOIN_XRPC_CODES`: `InvalidInvite`, `JoinClosed`, `NoDefaultRole`, `JoinRequestClosed`, `IdempotencyParameterMismatch`, `SubjectIsAppServicePrincipal`, `CannotTargetGroupSelf`) → **deletes** the `joiningGroups` row immediately and throws (never retried on reload!).
            - Transient network/5xx errors → keeps `submitting` row for safe idempotent retry.
          - **HTTP 200 response branching:**
            - `status === "admitted"` → persists `phase: "membership_verified"` (with `authorityEndpoint`) and continues.
            - `status === "pending"` → persists `phase: "pending_approval"` (with `authorityEndpoint`) and returns `{ status: "pending", operationId }`.
            - Any unknown future `status` string → persists passive `phase: "unsupported_status"` + `rawStatus` and **fails closed** with `UnsupportedJoinStatusError`.
       2. `pending_approval` *(never re-calls `requestJoin`!)*: polls `GET <groupHost>/group-member/join-status?group=<groupDid>&operationId=<operationId>` (`forceRefresh: true`, personal service JWT `lxm: "group.opensocial.requestJoin"`):
          - `state === "admitted"` → persists `phase: "membership_verified"` (recording `currentIncarnation`) and continues.
          - `state === "denied" | "cancelled"` → deletes journal row and surfaces terminal status.
          - `state === "pending"` → keeps journal row intact across reloads.
          - `state === "unknown"` → transitions to passive `orphaned_by_migration` (if `currentEndpoint !== entry.authorityEndpoint`) or passive `expired_unknown`.
       3. `membership_verified`: verifies live `membership/<viewerDid>` incarnation via a fresh space credential (deleting the row if membership is gone / 403 / 404 / `RepoDeactivated` / `RepoNotFound` / `GroupNotFound`), then persists `phase: "acceptance_pending"` with `currentIncarnation`.
       4. `acceptance_pending`: writes `group.opensocial.acceptance/self` stamped with `currentIncarnation`, then persists `phase: "discovery_verified"`.
       5. `discovery_verified` *(mirroring `workspace-client.ts:1567-1580`)*: verifies that the viewer's personal PDS exposes `groupMembersUri(groupDid)` (and confirms own `acceptance/self` readback) before deleting the completed `joiningGroups` row.
     - **Passive join phases & dismissal:** `PASSIVE_JOIN_PHASES = new Set(["orphaned_by_migration", "expired_unknown", "unsupported_status", "quota_exceeded"])`. `dismissJoinOperation(operationId)` clears passive rows under `withGroupLifecycleLock`.
     - **`reconcileLifecycle()`** runs on sign-in, page load, and Refresh, driving **all five active non-passive `joiningGroups` phases** (`submitting`, `pending_approval`, `membership_verified`, `acceptance_pending`, `discovery_verified`)—skipping `PASSIVE_JOIN_PHASES`—and **all active non-parked `leavingGroups` phases** (`leaving_group`, `deleting_acceptance`, `reconciling_post_delete`)—skipping parked `blocked_deactivated` rows—for `session.did` to completion under `withGroupLifecycleLock`.
   - **Admission-race-safe `cancelPendingJoin({ groupDid })`** *(mirroring `workspace-client.ts:1640-1689`)*:
     - Calls `POST <groupHost>/xrpc/group.opensocial.cancelJoinRequest` (personal service JWT `lxm: "group.opensocial.cancelJoinRequest"`).
     - On `400 JoinRequestNotFound` (e.g., an admin approved the request concurrently before Cancel arrived): does **not** blindly delete the journal row! Probes `/group-member/join-status` (falling back to live `membership/<viewerDid>` verification if `join-status` is `unknown` or 404):
       - `state === "admitted"` → **upgrades** the `pending_approval` row to `membership_verified` (recording `currentIncarnation`) so reconciliation completes `acceptance/self` instead of stranding an admitted member, and surfaces the race error cleanly.
       - `state === "cancelled" | "denied"` (or `unknown` + confirmed not admitted via live membership check) → deletes the `pending_approval` row.
       - `state === "pending"` or inconclusive → preserves the row and rethrows.
   - **Crash-, migration-, deactivation-, and cross-device-safe `leaveGroup({ groupDid })`** *(preflight + 3-phase flow mirroring `workspace-client.ts:1811-2078`)*:
     - **Preflight (`resolveCurrentLeaveIncarnation`, mirroring `workspace-client.ts:1811-1892`):** Reads own PDS `acceptance/self` (`ownIncarnation`) first, then resolves `<groupDid>`'s PDS and queries `/group-member/join-status` (rather than a bare membership GET that could 404 and block cleanup!):
       - If initial `resolvePds` is tombstoned (`404`/`410`) → returns `{ kind: "ready", expectedIncarnation: ownIncarnation }`.
       - If `/group-member/join-status` returns `RepoNotFound` / `GroupNotFound` / `RepoTakendown` / `RepoDeactivated`: force-refreshes `#atproto_pds` once; if tombstoned returns `ready`; if migrated retries `join-status` once at the new host; if still `RepoNotFound` / `GroupNotFound` returns `ready` (so orphaned local `acceptance/self` is cleaned up); if still `RepoTakendown` / `RepoDeactivated` returns `{ kind: "blocked", expectedIncarnation: ownIncarnation, error }` (persisting `phase: "blocked_deactivated"` and throwing on interactive leave).
       - If `join-status` succeeds with `state === "admitted"` and `currentIncarnation`, uses `currentIncarnation`; otherwise falls back to `ownIncarnation` and persists `{ viewerDid, groupDid, expectedIncarnation, phase: "leaving_group", createdAt }`.
       - If an existing `leavingGroups` row is parked at `blocked_deactivated`, background `reconcileLifecycle()` skips it, while an explicit interactive `leaveGroup({ groupDid })` call re-runs preflight and, if now ready, transitions back to `leaving_group` and executes.
     - **Phase 1 (`leaving_group`):** Resolves `<groupDid>`'s PDS; if tombstoned (`404`/`410`), advances straight to `phase: "deleting_acceptance"` (`workspace-client.ts:1902-1909`). Otherwise calls `POST <groupHost>/xrpc/group.opensocial.leaveGroup` with `If-Match-Membership-Incarnation: <expectedIncarnation>` when known (Group Host returns an idempotent HTTP 200 no-op when membership is already absent; there is no `NotAMember` error code). Error handling matches `workspace-client.ts:1927-2004`:
       - `400 LastAdmin`: deletes `leavingGroups` row and throws (never touches `acceptance/self`).
       - `409 MembershipIncarnationMismatch`: deletes `leavingGroups` row and throws on interactive call / stops cleanly on background resume (never touches `acceptance/self`).
       - `RepoDeactivated`: parks row at `phase: "blocked_deactivated"` (never deletes `acceptance/self` while group is deactivated).
       - `RepoTakendown`: force-refreshes `#atproto_pds` once; if DID is tombstoned advances to `deleting_acceptance`; if endpoint migrated retries `leaveGroup` once at the new host; otherwise parks at `blocked_deactivated`.
       - `RepoNotFound` / `GroupNotFound`: force-refreshes `#atproto_pds` once; if tombstoned advances to `deleting_acceptance`; if endpoint migrated retries `leaveGroup` once at the new host; if still missing advances to `deleting_acceptance` to clean up orphaned local `acceptance/self`.
       - On HTTP 200 success, advances to `deleting_acceptance`.
     - **Phase 2 (`deleting_acceptance`):** Re-reads live `/group-member/join-status` (with `forceRefresh: true`) AND own PDS `acceptance/self`. Skips deleting `acceptance/self` if the user was concurrently re-admitted on another device with a newer incarnation (`currentIncarnation !== expectedIncarnation`) or own `acceptance/self` already carries a newer incarnation; otherwise deletes own `acceptance/self`. Advances journal to `reconciling_post_delete`.
     - **Phase 3 (`reconciling_post_delete`, explicit branch boundary mirroring `workspace-client.ts:2050-2078`):** Re-checks live `/group-member/join-status` once more:
       - **Re-admitted branch** (`state === "admitted"` && `currentIncarnation !== undefined` && `currentIncarnation !== expectedIncarnation`): writes/restores own `acceptance/self` with `currentIncarnation`, deletes the `leavingGroups` row, and **returns early** (does **NOT** clear active `joiningGroups` rows).
       - **Non-readmitted branch:** deletes any active non-passive `joiningGroups` rows for `groupDid` and deletes the `leavingGroups` row.
3. **Channel Messages (`packages/shell/src/channel.ts`):**
   - **Mandatory fresh credential on EVERY write:** `postChannelMessage`, `editChannelMessage`, `deleteChannelMessage` (and D6 `toggleReaction`) MUST mint a brand-new, uncached channel space credential via `mintSpaceCredentialWith(deps, channelSpaceUri)` immediately before writing—ensuring a removed member cannot keep writing on a cached grant.
   - **`postChannelMessage(spaceUri, { text, parent? })`:**
     1. Mints fresh channel space credential (`credential`).
     2. If `parent !== undefined`: parses `parent` as a `new.flock.channel.message` URI in `spaceUri`, fetches and verifies the parent record from the parent author's PDS using `credential` (confirming it exists, passes `validateSpaceRecord`, and is a top-level message with no `parent`), and populates `knownMessages = new Set([parent])` and `knownTopLevelMessages = new Set([parent])`.
     3. Generates TID `rkey` (`tidNow`), validates with `validateSpaceRecord(COLLECTION.message, record, { authorityDid, spaceUri, repoDid: viewerDid, rkey, knownMessages, knownTopLevelMessages })`, and calls create-only **`com.atproto.space.createRecord`** (never `putRecord`, preventing silent TID-collision overwrites).
   - **`editChannelMessage(spaceUri, messageUri, { text })`:** Mints fresh channel credential, fetches and verifies the existing own message record first, preserves unknown third-party fields (`{ ...prior.value, text }`), re-verifies `prior.value.parent` if present so `knownMessages`/`knownTopLevelMessages` pass `validateSpaceRecord`, and calls `com.atproto.space.putRecord`.
   - **`deleteChannelMessage(spaceUri, messageUri)`:** Mints fresh channel credential, verifies own message URI, calls `com.atproto.space.deleteRecord`.
   - **`toggleReaction(spaceUri, { subject, emoji })` *(D6 / v1.1)*:** Mints fresh channel credential, fetches and verifies the target message exists in `spaceUri`, derives deterministic `rkey` via `reactionRecordKey(subject, emoji, viewerDid)`, validates with `validateSpaceRecord(COLLECTION.reaction, record, { ..., knownMessages: new Set([subject]) })`, and calls `putRecord` / `deleteRecord`.
4. **Content Reporting (`packages/shell/src/moderation.ts`):**
   - `readGroupModerationConfig(deps, groupDid)` fetches `<groupDid>`'s `group.opensocial.labeler/self` (if present) and `group.opensocial.rule` records from `group.opensocial.meta/self`.
   - Both the Report UI and `reportSubject({ groupDid, subject, cid?, reasonType, reason?, rule? })` enforce **all** Group Host `apps/group-host/src/moderation.ts:145-240` preconditions before calling `POST <groupHost>/xrpc/group.opensocial.createReport` (personal service JWT `aud: <groupDid>#atproto_pds`, `lxm: "group.opensocial.createReport"`):
     1. Caller currently holds read access to the subject's space.
     2. If `labeler.subjectTypes` is set, only offer/allow matching `"account"` or `"record"` reports.
     3. If `labeler.subjectCollections` is set for record reports, only offer/allow matching record collections (e.g. `new.flock.channel.message`).
     4. If `labeler.reasonTypes` is set, only offer/allow listed `reasonType`s.
     5. Account DID subjects MUST omit `cid`; `reasonType === "violation"` requires citing a valid `group.opensocial.rule` URI from `meta/self`.
5. **Refresh model:** No background sync engine or webhook relay. Desk refreshes on route load, after every user write, and via an explicit Refresh button (plus optional 30–60 s passive poll in D4 only if needed).

### 3.4 OAuth Scopes, Client Metadata, Invite Redirect Survival & Deployment Config

1. **Least-privilege Operator-free personal OAuth scopes (`packages/protocol/src/scopes.ts`):**
   - Define a dedicated minimal `DESK_MODALITY_SCOPES` constant (**never** spreading `FLOCK_MEMBER_MODALITY_SPACE_SCOPES`, which grants legacy `inbox` `joinRequest`, `reaction`, `tasks`, and `appInbox`):
     - `space:new.flock.workspace?authority=*&skey=self&action=read`
     - `space:new.flock.channel?authority=*&action=read`
     - `space:new.flock.channel?authority=*&collection=new.flock.channel.message&action=create&action=update&action=delete`
   - Export `deskMemberScopes(): string[]` returning strictly:
     - `"atproto"`
     - `...OPEN_SOCIAL_PARTICIPATE_SCOPES` (`meta/self` read, `members/self` acceptance CRUD, `invites/self` read + `manage=create`, `rpc?aud=*&lxm=group.opensocial.{cancelJoinRequest,createReport,leaveGroup,requestJoin}`)
     - `PERSONAL_PDS_LIST_GROUP_MEMBERS_SPACES_SCOPE` (`space:group.opensocial.members?authority=*&action=read_self` — required by real `@atproto/pds` `listSpaces`)
     - `...DESK_MODALITY_SCOPES`
   - Explicitly **omits** `operatorMethodsScope(...)`, `new.flock.inbox`, `new.flock.channel.reaction` (until D6), `new.flock.ext.tasks` (until D6), `new.flock.app.inbox`, and `DM_BROWSER_SCOPES` (until D6).
   - Verified with explicit negative assertions in `packages/protocol/src/scopes.test.ts`.
2. **Deployment config (`packages/deployment/src/config.ts`):**
   - Export `DESK_ENV_FILE_KEYS = ["DESK_APP_URL", "PLC_URL", "GROUP_HOST_URL"] as const` — explicitly **omitting** Web's `APP_URL` from root `.env` inheritance so a local developer's root `.env` with `APP_URL=http://127.0.0.1:3000` for `@flock/web` never hijacks `pnpm dev:desk`!
   - Export `getDeskConfig(): DeskConfig` reading `process.env.DESK_APP_URL ?? process.env.APP_URL ?? "http://127.0.0.1:3005"` (so tests/deployments can still pass either `DESK_APP_URL` or `APP_URL` directly in process env, while local `pnpm dev:desk` defaults cleanly to unoccupied `:3005`), `PLC_URL` (default `https://plc.directory`), and optional `GROUP_HOST_URL` (default `http://127.0.0.1:3004` on loopback)—**never** reading or requiring `OPERATOR_URL`, `OPERATOR_SERVICE_REF`, or `AUTH_ENCRYPTION_KEY`.
   - Keep `getConfig()` and `SHARED_ENVIRONMENT` unchanged for `@flock/web` and `@flock/operator`.
3. **Desk Next.js config, loopback normalization, CSP wiring, OAuth routes & invite survival (`apps/desk` + `packages/shell`):**
   - `apps/desk/next.config.ts`: mirrors `apps/web/next.config.ts` by loading root `../../.env` filtered strictly to `DESK_ENV_FILE_KEYS` (never Web's `APP_URL` and never Operator secrets), setting `outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url))`, and installing `securityHeaderRule()` from `@flock/deployment/security-headers`.
   - **Complete loopback normalization & CSP triad** (mirroring `apps/web` so `next start --hostname 127.0.0.1` never strips `http://127.0.0.1:<port>` on `localhost` requests AND default-env CSP allows local loopback HTTP origins):
     1. `apps/desk/src/lib/loopback-redirect.ts` (`LOOPBACK_PATH_HEADER`, `configuredDeskAppUrl()` using the exact `process.env.DESK_APP_URL ?? process.env.APP_URL ?? "http://127.0.0.1:3005"` precedence, `resolveLoopbackRedirect()`).
     2. `apps/desk/src/proxy.ts`: calls `webContentSecurityPolicy({ nonce, appUrl: configuredDeskAppUrl()?.origin, development: process.env.NODE_ENV !== "production" })`—explicitly passing `configuredDeskAppUrl()?.origin` rather than raw `process.env.APP_URL` so default local `http://127.0.0.1:3005` enables `connect-src 'self' https: http://localhost:* http://127.0.0.1:*` while HTTPS production deployments restrict `connect-src` to `'self' https:`—forwards `LOOPBACK_PATH_HEADER` inside Next's runtime (`"sourcePage" in request`), and returns `307` directly when invoked outside Next's runtime.
     3. `apps/desk/src/app/layout.tsx`: reads `host` + `LOOPBACK_PATH_HEADER` via `headers()` and calls Next's `redirect()` when `resolveLoopbackRedirect` returns a canonical `127.0.0.1` URL.
   - **Pure Desk OAuth client-metadata builder & session loader (`packages/shell/src/client-metadata.ts` + `packages/shell/src/session.ts`):**
     - `buildDeskClientMetadata({ appUrl, scope })` builds RFC 8252 loopback or HTTPS client metadata (zero import of `@flock/web/browser/client-metadata`), shared by Desk's route handler and browser session loader.
     - `BrowserOAuthClient.load(...)` explicitly passes `clientId: metadata.client_id`, `plcDirectoryUrl: config.plcUrl`, `allowHttp: new URL(config.appUrl).protocol === "http:"` (matching `apps/web/src/browser/session.ts:43` so loopback `http://127.0.0.1:3005` sign-in works while HTTPS deployments enforce HTTPS), and Desk's SSRF-hardened `wellKnownHandleResolver`.
   - `GET /oauth/client-metadata.json`: calls `getDeskConfig()` + `buildDeskClientMetadata({ appUrl: appUrl.origin, scope: deskMemberScopes().join(" ") })`, publishing Desk's own `client_id` and `redirect_uris` on `appUrl.origin`.
   - `GET /oauth/callback`: completes `@atproto/oauth-client-browser` (`BrowserOAuthClient`) callback into Desk's origin-isolated `@atproto-oauth-client` IndexedDB database, with zero server secrets or cookies. On sign-out, Desk revokes/clears the session via `session.signOut()`, deletes `flock-desk-lifecycle:<viewerDid>`, and clears `sessionStorage`.
   - **Pre-OAuth invite-link survival:** When an unauthenticated visitor lands on `/?invite=<workspaceUri>` (or `/invite?uri=<workspaceUri>`), Desk validates `workspaceUri` via `parseWorkspaceUri` (`@flock/protocol/keys`), renders `[data-testid="desk-invite-banner"]`, and persists the pending invite URI in `sessionStorage` (`flock.desk.pendingInvite`) before redirecting to the PDS OAuth authorize screen. When `/oauth/callback` returns the signed-in browser to `/`, Desk restores `flock.desk.pendingInvite` from `sessionStorage`, shows the join prompt (or immediately runs `acceptDirectMembership` / opens the workspace if already joined), and clears `flock.desk.pendingInvite` on completion, dismissal, or sign-out.
   - Public runtime config (`appUrl`, `plcUrl`) is serialized from server `layout.tsx`/`page.tsx` props into client components so zero `"use client"` modules ever import `@flock/deployment/*`.

### 3.5 UI Stack (Astryx + StyleX) & D0 Feasibility Gate

- Run `npx @astryxdesign/cli init` once in `apps/desk` and commit the generated agent guide alongside a cross-link from `CODE-MAP.md`.
- Pin exact versions of `@astryxdesign/core`, `@astryxdesign/theme-neutral`, and `@stylexjs/stylex` in `apps/desk/package.json` (and update `pnpm-workspace.yaml` `allowBuilds` / `onlyBuiltDependencies` if any build script is required).
- Visually distinct layout and theme tokens via CSS custom properties on `:root`; **zero** reuse of `@flock/web` class names (`.app-frame`, `.permission-box`, `.welcome-banner`, `.message-card`, `.private-roster`, etc.) or `globals.css`.
- Use Next 16 webpack mode (`next dev --webpack`, `next build --webpack`) matching `apps/web`.
- **D0 Runnable Hard Gate (`protocol-tests/browser/desk-csp.spec.ts`, wired into `package.json` `test:browser` in D0):** Before writing D1 features, D0 MUST prove that `pnpm build` (both `@flock/web` and `@flock/desk`) succeeds cleanly and `protocol-tests/browser/desk-csp.spec.ts` passes in real Chromium against `startDeskServer()`—asserting strict `Content-Security-Policy` with per-request nonce and zero `'unsafe-eval'`, default-env loopback `connect-src` vs production HTTPS-only `connect-src`, zero console errors, zero `securitypolicyviolation` events, and `localhost` → `127.0.0.1` loopback redirect preserving path & query. **Explicit fallback:** if Astryx/StyleX has an unresolvable incompatibility with Next 16 / React 19 / strict CSP, fall back to clean **CSS Modules + accessible semantic HTML/ARIA components** (still 100% visually distinct from `@flock/web`) rather than blocking D1–D4.
- **Accessible Test Contract:** Every interactive Desk surface exposes stable ARIA roles/labels (`region`, `navigation`, `heading`, `button`, `textbox`) and `data-testid="desk-*"` hooks (`desk-handle-input`, `desk-signin-button`, `desk-shell`, `desk-invite-banner`, `desk-join-button`, `desk-workspace-summary`, `desk-workspace-uri`, `desk-channel-nav`, `desk-channel-item`, `desk-message-item`, `desk-private-roster`, `desk-invites-inbox`, `desk-join-uri-input`, etc.) so Desk BDD helpers never share CSS selectors with `@flock/web`.

### 3.6 Playground and BDD Integration (`startDeskApp` vs `startSecondApp`)

**Critical R13 constraint:** `this.fixture.startSecondApp()` in `protocol-tests/support/app-fixture.ts` is currently called by four distinct scenarios:
1. `bdd/steps/independent-app.steps.ts:114` (*Render one workspace from two independent apps*) — **target for Flock Desk**.
2. `bdd/steps/independent-app.steps.ts:628` (*Stop new work with the operator pause switch* with `FLOCK_ADMIN_MUTATIONS_PAUSED=true`) — specifically tests a paused **Operator** + `@flock/web`.
3. `bdd/steps/dm-policy.steps.ts:681, 779` — tests DM / `AUTH_ENCRYPTION_KEY` across two `@flock/web` + Operator instances.
4. `bdd/support/channels-ui.ts:244` — tests two `@flock/web` sync-engine clients.

Therefore, D4 makes the following exact, non-breaking harness updates (building on `startDeskServer()` already added to `protocol-tests/support/app-server.ts` in D0):

1. **Backwards-compatible discriminated fixture types (`protocol-tests/support/app-fixture.ts`):**
   - Define discriminated types in `protocol-tests/support/app-fixture.ts`, preserving `export type SecondApp = SecondWebApp` so existing imports in `bdd/steps/dm-policy.steps.ts`, `bdd/support/channels-ui.ts`, and `bdd/steps/independent-app.steps.ts` compile with zero breakage:
     ```ts
     export type SecondWebApp = { kind: "web"; appUrl: URL; operatorUrl: URL; databasePath: string; serverOutput(): string };
     export type SecondApp = SecondWebApp;
     export type DeskApp = { kind: "desk"; appUrl: URL; operatorUrl: null; databasePath: null; serverOutput(): string };
     export type IndependentSecondApp = SecondWebApp | DeskApp;
     ```
   - Keep `startSecondApp(options?)` returning `Promise<SecondApp>` (callers 2–4 keep working without breakage).
   - Add `startDeskApp(options?)` returning `Promise<DeskApp>`—spawning **only** `next start apps/desk` with `APP_URL`, `PLC_URL`, and `GROUP_HOST_URL` (**no Operator child process**, **no `DATABASE_PATH` / SQLite file**).
2. **Desk-specific BDD UI drivers (`bdd/support/independent-app-ui.ts`):**
   - Keep existing `signInFromLoginFormAt`, `joinWorkspaceAt`, and `observeWorkspace` intact for `@flock/web` (primary app + `BDD_SECOND_APP=web` fallback).
   - Add three Desk-specific drivers using strictly Desk's `data-testid="desk-*"` and ARIA contract (zero `.app-frame`/`.permission-box`/`.welcome-banner`/`.message-card` reuse):
     - `signInDeskAt(viewer: AppViewer)`: fills `[data-testid="desk-handle-input"]`, submits `[data-testid="desk-signin-button"]`, completes PDS OAuth login/consent, and waits for `[data-testid="desk-shell"]` signed-in state.
     - `joinWorkspaceDeskAt(viewer: AppViewer, workspaceUri: string, workspaceName: string)`: navigates to `${viewer.origin}/?invite=${encodeURIComponent(workspaceUri)}`, waits for `[data-testid="desk-invite-banner"]`, runs `signInDeskAt(viewer)`, clicks `[data-testid="desk-join-button"]` if shown (or waits if direct membership auto-opens), and waits for the workspace heading.
     - `observeWorkspaceDesk(viewer: AppViewer, workspaceName: string, channels: string[])`: reads `[data-testid="desk-workspace-summary"]`, `[data-testid="desk-workspace-uri"]`, `[data-testid="desk-channel-item"]`, `[data-testid="desk-message-item"]`, and `[data-testid="desk-private-roster"]`, **and** runs the existing network-level `workspaceRead(viewer, workspaceUri, since)` assertion proving Desk's browser directly listed `profile`, `role`, `membership`, `directory`, `appInstall`, and `spacePolicy` strictly from `<groupDid>`'s repo.
3. **Updated BDD steps (`bdd/steps/independent-app.steps.ts`):**
   - `Given("two apps use published lexicons, OAuth, and space credentials")`: starts `this.fixture.startDeskApp()` by default, or `this.fixture.startSecondApp()` when `process.env.BDD_SECOND_APP === "web"`. Asserts distinct OAuth `client_id` and origin-bound `redirect_uris`, and when `second.kind === "desk"`, also asserts `/oauth/client-metadata.json`'s `scope` contains **zero** `new.flock.operator.` RPC scopes.
   - `When("each app syncs the same workspace")`: branches on `second.kind === "desk"` (`joinWorkspaceDeskAt` + `observeWorkspaceDesk`) vs `"web"` (`joinWorkspaceAt` + `observeWorkspace`).
   - `Then("neither app reads the other's database or private cache")`: explicitly branches on `second.kind`:
     - When `second.kind === "desk"`:
       1. Asserts `second.databasePath === null` and `second.operatorUrl === null` (Desk has no server DB and no Operator), and asserts `memberSessionTablesIn(this.fixture.databasePath)` is `[]`.
       2. Asserts Desk's browser holds **zero** IndexedDB protocol record caches (`browserStore(secondViewer).records` is empty / no `@flock/client` engine cache), **and** proves directly from `secondViewer.xrpc` that Desk's browser issued `com.atproto.space.listRecords` (`status === 200`) against the PDS/Group Host itself for the workspace and both `general` and `Vault` channels (nothing copied from `@flock/web`).
       3. Asserts `secondViewer` made **zero** HTTP requests to `this.appOrigin` or `this.operatorOrigin`, `firstViewer` made **zero** HTTP requests to `second.appUrl.origin`, and `reaches(secondViewer, second.appUrl.origin).length > 0`.
     - When `second.kind === "web"`: runs the existing two-SQLite-DB, two-Operator, and `heldRecordKeys` assertions unchanged.
   - **Same-profile origin IndexedDB isolation proof:** Because `openViewer` creates separate Playwright `BrowserContext`s, `protocol-tests/browser/desk-parity.spec.ts` (D3/D5) additionally opens `@flock/web` and `@flock/desk` in **two tabs of the same Playwright `BrowserContext`** and verifies `indexedDB.databases()` on Desk's origin exposes only `@atproto-oauth-client` (plus `flock-desk-lifecycle:<viewerDid>` while active) and **zero** `@flock/web` / `@flock/client` IndexedDB stores (and vice versa), and that sign-out erases `flock-desk-lifecycle:<viewerDid>`.

---

## 4. Functional Scope by Milestone

**In scope for "v1 complete" (D0–D5):**
- Sign-in & sign-out (personal PDS handle/DID → OAuth 2.1 DPoP, least-privilege `deskMemberScopes()`, explicit loopback `allowHttp`, hardened handle resolver, account-scoped lifecycle erasure on sign-out).
- Automatic `ensureInvitesSpace()` on sign-in (with all 4 R13 policy/zero-member invariants) + **Invites inbox** (`readIndependentInvites(deps, viewerDid)` for expiring cross-PDS invites) + **invite URL handler** (`/?invite=<workspaceUri>` persisted across OAuth redirect via `sessionStorage`) + **"Join workspace" URI/DID input** (supporting direct-grant membership acceptance/incarnation repair, open-group join, and crash-/race-safe approval-gated `pending` join + `/group-member/join-status` reconciliation + `cancelPendingJoin` + `dismissJoinOperation`).
- **Workspace switcher & home:** joined workspaces (`listIndependentWorkspaces`), summary line (`<N> active members · <M> channels · join policy: <policy>`), active member roster & admin list (`readIndependentWorkspace`), and crash-/migration-/deactivation-/cross-device-safe preflight + 3-phase **Leave group** (`leaveGroup` with `If-Match-Membership-Incarnation`).
- **Channel view (public & private):** message list (newest first, bounded page from `readIndependentChannelPage`), post/edit/delete text message (`createRecord` / verified `putRecord` / `deleteRecord`, mandatory fresh credential on every write, verified parent record for replies), private channel roster display (`readIndependentPrivateRoster`), **moderation label projection** (`!takedown` withheld; `!hide` collapsed with click-to-reveal warning), and **Report message/account** (`group.opensocial.createReport` honoring `labeler/self` `subjectTypes`, `subjectCollections`, `reasonTypes`, and `rule` citations for `violation`).

**Staged after v1 (still zero `@flock/client` / zero Operator):**
- **D6 (v1.1 optional):** Reactions (`toggleReaction`, adding `new.flock.channel.reaction` CRUD scope), direct messages read/post via `@flock/reader/independent-dm` (`readIndependentDmConversation`) + separate DM OAuth scope opt-in, and read-only Tasks view via `@flock/reader/independent-tasks`.

---

## 5. Milestones, Exit Evidence, and Verification Gates

| ID | Milestone | Concrete Exit Evidence |
|---|---|---|
| **D0** | Scaffold `packages/shell` + `apps/desk` (port `3005`, `@flock/protocol` + `react-dom` declared) + `getDeskConfig()`/`DESK_ENV_FILE_KEYS` + `deskMemberScopes()` + `buildDeskClientMetadata` + `startDeskServer()` + AST boundary tests + ESLint/tsconfig rules + root `build` update + Astryx/Next 16/CSP spike | `pnpm typecheck`, `pnpm lint`, `npx eslint --max-warnings=0 .`, `packages/shell/src/boundary.test.ts`, `apps/desk/src/boundary.test.ts`, `apps/desk/src/proxy.test.ts` (default-env loopback `connect-src` vs production HTTPS-only `connect-src`), `pnpm build` (both Web & Desk), `protocol-tests/suite-manifest.test.ts`, and `protocol-tests/browser/desk-csp.spec.ts` (wired into `test:browser`: Chromium renders Desk with 0 CSP/console errors + `localhost`→`127.0.0.1` redirect) all green |
| **D1** | Browser OAuth session (`allowHttp` + hardened handle resolver) + `createBrowserSpaceCredentialDeps` + workspace list, invites inbox & lifecycle store | Signed-in user sees `listIndependentWorkspaces` and `readIndependentInvites(deps, viewerDid)` in Desk UI; unit tests on `FakeNetwork` in `packages/shell` prove full canonical IPv4/IPv6 CIDR SSRF blocking (including NAT64/6to4/Teredo/IPv4-compatible/IPv4-mapped) in BOTH loopback and production modes for DID resolver and `wellKnownHandleResolver`, KEM rotation `forceRefresh` retry, `credentialLifetimeMs` handling, and `ensureInvitesSpace` 4-invariant fail-closed checks; `apps/desk/src/reader-parity.test.ts` proves `createBrowserSpaceCredentialDeps` parity with `@flock/reader` |
| **D2** | Direct OpenSocial join, crash-/race-safe pending-approval & cancel, stale-incarnation repair & preflight + 3-phase leave (zero Operator) | Both invite paths verified end-to-end without touching Operator: **(a)** default `@flock/web` direct-grant invite (no `expiresAt`) opened via `/?invite=<workspaceUri>` across signed-out OAuth redirect (`acceptDirectMembership` + stale-incarnation overwrite) and **(b)** explicitly seeded expiring cross-PDS invite (`expiresAt` set) discovered in Desk's Invites inbox and redeemed via `requestJoin` (`Idempotency-Key`) + `acceptance/self`; plus crash-safe resume across all 5 active join phases (`submitting`→`pending_approval`→`membership_verified`→`acceptance_pending`→`discovery_verified`), `TERMINAL_JOIN_XRPC_CODES` deletion, `429 JoinOperationQuotaExceeded` → passive `quota_exceeded` + dismiss, `cancelPendingJoin` `JoinRequestNotFound` admission-race upgrade, unknown status fail-closed, per-`(viewerDid, groupDid)` lock serialization, account-switch isolation/sign-out erasure, and preflight + 3-phase `leaveGroup` (initial tombstone, `LastAdmin`, `MembershipIncarnationMismatch`, `RepoDeactivated` → `blocked_deactivated` background skip & interactive retry, `RepoTakendown`/migration/tombstone, cross-device re-admission early-return preservation) |
| **D3** | Channel transcript, posting (`createRecord`), moderation projection & `desk-parity.spec.ts` | Cross-posting & reply/edit/delete between `@flock/web` and Desk matches `readIndependentChannelPage` (with fresh pre-write credential checks so a removed member cannot write); `!hide` and `!takedown` labels published in `@flock/web` project identically in Desk; `protocol-tests/browser/desk-parity.spec.ts` wired into `package.json` `test:browser` (passing `suite-manifest.test.ts`) passes 100%, including same-context two-tab origin IndexedDB isolation (`@atproto-oauth-client` + `flock-desk-lifecycle:<viewerDid>` erasure on sign-out) |
| **D4** | BDD *Render one workspace from two independent apps* swapped to Desk | `features/independent-app-and-launch.feature` passes with `startDeskApp()` (`DeskApp` discriminated fixture keeping `SecondApp = SecondWebApp`, `signInDeskAt`/`joinWorkspaceDeskAt`/`observeWorkspaceDesk`, rewritten Desk branch of `neither app reads the other's database or private cache`, zero Operator requests from Desk, `workspaceRead()` & UI parity green); `BDD_SECOND_APP=web` fallback also passes; all 77 BDD scenarios green |
| **D5** | Private channel roster + full labeler-aware reporting + cross-origin CSP verification | Private channel roster parity (`Vault`) and active-member `createReport` (honoring `labeler/self` `subjectTypes`, `subjectCollections`, `reasonTypes`, and `rule` URI for `violation`) verified against real Group Host in `protocol-tests/browser/desk-parity.spec.ts`; cross-origin preflight & CSP nonces green |
| **D6** | *(Optional v1.1)* Reactions, DM read (`readIndependentDmConversation`), read-only Tasks (`readIndependentTasksSpace`) | Parity tests against `independent-dm.ts` and `independent-tasks.ts` green; reaction write verifies subject exists and mints fresh credential |
| **D7** | Docs, `CODE-MAP.md`, `PLAN.md`, `SPEC.md` | `README.md` (including Desk on `:3005`), `CODE-MAP.md`, `PLAN.md` (M7 Flock Desk row), `SPEC.md`, and `docs/dev-onboarding.md` updated; `pnpm test`, `pnpm build`, `pnpm test:browser`, and `pnpm test:bdd` green |

---

## 6. Testing Strategy

1. **Unit & Boundary (`pnpm test`):**
   - `packages/shell/src/boundary.test.ts` and `apps/desk/src/boundary.test.ts` (recursive AST import/export/dynamic-import checks with `NODE_TESTS` exemption on production rules + forbidden-package check across all files + transitive production-only workspace dependency closure check).
   - `apps/desk/src/proxy.test.ts`: asserts `proxy.ts` passes `configuredDeskAppUrl()?.origin` to `webContentSecurityPolicy`, so default-env (no `APP_URL`/`DESK_APP_URL`) includes `http://localhost:* http://127.0.0.1:*` in `connect-src`, while HTTPS `DESK_APP_URL` restricts `connect-src` to `'self' https:`.
   - `apps/desk/src/reader-parity.test.ts`: verifies `createBrowserSpaceCredentialDeps` from `@flock/shell` integrates cleanly with `@flock/reader/independent` (`listIndependentWorkspaces`, `readIndependentWorkspace`, `readIndependentInvites`, `readIndependentChannelPage`, `readIndependentPrivateRoster`) on `FakeNetwork`.
   - `packages/shell/src/**/*.test.ts` on `FakeNetwork` (+ `fake-indexeddb`):
     - `did-resolver.test.ts` & `session.test.ts`: redirect rejection, 256 KiB / 512 B caps, HTTPS enforcement, full canonical IPv4/IPv6 CIDR denylist (including NAT64 `64:ff9b::a9fe:a9fe`, 6to4 `2002:a9fe:a9fe::1`, Teredo `2001::...`, IPv4-compatible `::a9fe:a9fe`, IPv4-mapped `::ffff:169.254.169.254`, RFC1918, CGNAT, ULA, link-local, multicast, `.local`/`.internal`) in **both** loopback and non-loopback modes for both DID/PDS/KEM endpoints and `wellKnownHandleResolver`, exact-loopback allowlist in loopback mode, KEM rotation `forceRefresh` retry, `buildDeskClientMetadata` loopback vs non-loopback output, `allowHttp` behavior.
     - `invites.test.ts`: all four `ensureInvitesSpace` invariants (`publicWrite === true`, `publicRead === false`, `allowedApps === undefined` including rejecting `[]`, zero explicit members).
     - `membership.test.ts`: direct-grant `acceptDirectMembership` (including stale-incarnation overwrite after ejection/re-admission), `joinGroup` crash-resume across all 5 active phases (`submitting` with `Idempotency-Key` replay, `pending_approval`, `membership_verified`, `acceptance_pending`, `discovery_verified`), `TERMINAL_JOIN_XRPC_CODES` immediate deletion, `429 JoinOperationQuotaExceeded` → passive `quota_exceeded` (skipped on reconcile, cleared via `dismissJoinOperation`), `"pending"` reconciliation (`admitted` / `denied` / `cancelled` / `unknown` / migration), `cancelPendingJoin` `JoinRequestNotFound` admission-race probe & upgrade, unknown `status` fail-closed (`UnsupportedJoinStatusError`), per-`(viewerDid, groupDid)` lock serialization, account-switch isolation (Alice → sign-out → Bob) + cross-actor row rejection, and preflight + 3-phase `leaveGroup` (preflight absent/404/tombstone/deactivated/migrated handling, Phase 1 initial `resolvePds` tombstone, `LastAdmin`, `MembershipIncarnationMismatch`, `RepoDeactivated` → `blocked_deactivated` background skip & interactive retry, `RepoTakendown` / `RepoNotFound` / `GroupNotFound` PLC refresh/migration/tombstone, idempotent 200 absent-membership no-op, cross-device re-admission Phase 3 early-return preservation without dropping active `joiningGroups`).
     - `channel.test.ts`: fresh credential mint before every write (removed member rejected immediately), `createRecord` for new messages, verified top-level parent for replies, field-preserving verified `putRecord` for edits, `deleteRecord`.
     - `moderation.test.ts`: `readGroupModerationConfig`, `labeler/self` filtering across `reasonTypes`, `subjectTypes`, and `subjectCollections`, `violation` requiring valid `meta/self` `rule` URI, account reports forbidding `cid`, active-reader precondition.
   - `packages/protocol/src/scopes.test.ts`: assert `deskMemberScopes()` satisfies real PDS `listSpaces({ spaceType: "group.opensocial.members" })` and contains **zero** `new.flock.operator.*`, `new.flock.inbox`, `new.flock.channel.reaction`, `new.flock.ext.tasks`, `new.flock.app.inbox`, or `new.flock.dm.*` scopes.
   - `packages/deployment/src/config.test.ts`: assert `getDeskConfig()` succeeds when `OPERATOR_URL`, `OPERATOR_SERVICE_REF`, and `AUTH_ENCRYPTION_KEY` are unset, defaults to `http://127.0.0.1:3005`, prioritizes `DESK_APP_URL` over `APP_URL`, and enforces HTTPS outside loopback.
2. **Real-Browser Gates (`test:browser` + `suite-manifest.test.ts`):**
   - `protocol-tests/browser/desk-csp.spec.ts` (D0): strict CSP nonce (no `'unsafe-eval'`), default-env loopback `connect-src`, zero console/CSP errors in real Chromium, `localhost` → `127.0.0.1` loopback normalization preserving path & query.
   - `protocol-tests/browser/desk-parity.spec.ts` (D3/D5): boots real personal PDSes + real `GroupHostServer` + `@flock/web` (+ Operator) + `@flock/desk` (no Operator!). Verifies direct-grant invite-link join (surviving signed-out OAuth redirect), seeded expiring cross-PDS invite inbox discovery + `requestJoin`, cross-posting + removed-member fresh-credential rejection, private roster, `!hide` / `!takedown` moderation projection, labeler-compliant `createReport`, same-context two-tab origin IndexedDB isolation (`@atproto-oauth-client` + `flock-desk-lifecycle:<viewerDid>` erasure on sign-out), strict CSP nonces, and **zero** requests from Desk to Operator origin.
3. **BDD (`features/independent-app-and-launch.feature`):**
   - *Render one workspace from two independent apps* runs with primary `@flock/web` + secondary `@flock/desk` (`startDeskApp()`, distinct OAuth `client_id` with zero operator scopes, zero Operator calls from Desk, `signInDeskAt`/`joinWorkspaceDeskAt`/`observeWorkspaceDesk`, rewritten Desk isolation assertions, `workspaceRead()` network proof, and `@flock/reader` oracle parity), plus `BDD_SECOND_APP=web` regression check.
   - Root `package.json` `build` builds both `@flock/web` and `@flock/desk` so `test:bdd`, `test:bdd:video`, `test:bdd:slow`, `test:bdd:chrome`, and `test:browser` always have a fresh Desk build.
   - No requirement to port all 77 BDD scenarios to Desk—only `independent-app-and-launch.feature` and future `@second-client` scenarios.

---

## 7. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Accidental `@flock/client`, `@flock/web`, or `@flock/operator` import (or client-component `node:*` / `@flock/deployment` leak) | Recursive TypeScript-AST boundary unit tests + dedicated `eslint.config.mjs` static & dynamic `import()` restrictions covering all Shell and Desk client components + `typecheck` `@types/node`-free check on `packages/shell` |
| Breaking Operator-pause / DM / multi-tab `startSecondApp()` BDD scenarios | Discriminated `SecondWebApp` (`export type SecondApp = SecondWebApp`, `startSecondApp()`) vs `DeskApp` (`startDeskApp()`); only *Render one workspace from two independent apps* switches to Desk, with `BDD_SECOND_APP=web` fallback |
| Astryx / StyleX incompatibility with Next 16, React 19, or strict CSP nonces | Mandatory runnable D0 gate (`protocol-tests/browser/desk-csp.spec.ts`) before D1; documented fallback to CSS Modules + semantic ARIA components |
| Drift between Desk UI and canonical protocol state | Unchanged `@flock/reader` is Desk's sole core read path (no duplicated parsing/RBAC/label code) and remains the test oracle |
| Browser DID / member-PDS / handle resolution DNS-rebinding residual risk | `assertSafeBrowserEndpointUrl` enforces the complete canonical IPv4/IPv6 non-public CIDR denylist (including NAT64, 6to4, Teredo, IPv4-compatible/IPv4-mapped IPv6) and `.local`/`.internal` in ALL modes (allowing HTTP/local only for exact loopback in dev), applied to both DID/PDS/KEM fetches and OAuth `wellKnownHandleResolver`, with redirects disabled and strict body caps. Residual limitation: browser `fetch()` cannot DNS-pin prior to connecting (unlike Node's `@flock/net` `safe-fetch.ts`), so DNS rebinding against a hostile hostname relies on browser Private Network Access and HTTPS certificate validation |
| Stale membership credentials, cross-tab/cross-account races, or mid-flight crashes | Every write mints a fresh credential (`mintSpaceCredentialWith`); per-viewer `flock-desk-lifecycle:<viewerDid>` journal deleted on sign-out; per-`(viewerDid, groupDid)` in-process + Web Lock serialization; full crash-safe 5-phase join / race-safe cancel / preflight + 3-phase leave state machines |
| Real PDS OAuth scope rejection (`authParticipate` `"skey": "self"` vs `listSpaces`) | `deskMemberScopes()` explicitly includes `PERSONAL_PDS_LIST_GROUP_MEMBERS_SPACES_SCOPE` while excluding all unused Flock/Operator scopes |
| Local port, CSP `connect-src`, or root `.env` `APP_URL` collision with `@flock/web` / Echo Bot | Desk uses unoccupied port `:3005`, `apps/desk/next.config.ts` loads only `DESK_ENV_FILE_KEYS` (`DESK_APP_URL`, `PLC_URL`, `GROUP_HOST_URL` — never Web's `APP_URL`), `getDeskConfig()` defaults to `http://127.0.0.1:3005`, and `proxy.ts` passes `configuredDeskAppUrl()?.origin` into `webContentSecurityPolicy` |
| Duplicate `memberspace` allowlist creep | `flock-boundaries/no-legacy-memberspace` blocks all `com.atproto.memberspace.*` across Desk/Shell except `allowListMembers: true` on `packages/shell/src/invites.ts` |
| Forgotten `suite-manifest.test.ts` registration or stale Desk `.next` build | Both `desk-csp.spec.ts` (D0) and `desk-parity.spec.ts` (D3) are wired into `test:browser`, and root `pnpm build` builds both `@flock/web` and `@flock/desk` from D0 onward |

---

## 8. Open Decisions (Resolved for v1)

| Decision | Resolution for v1 |
|---|---|
| Operator dependency in Desk v1 | **None** — Desk talks strictly to Personal PDSes + Group Hosts + PLC (`getDeskConfig()` + least-privilege `deskMemberScopes()`). |
| Package, app names & default local port | `packages/shell` (`@flock/shell`), `apps/desk` (`@flock/desk`), default port `127.0.0.1:3005`. |
| Reader contract & browser persistence | `@flock/reader` stays 100% unchanged; Desk holds zero protocol record cache (only `BrowserOAuthClient`'s origin-isolated `@atproto-oauth-client` IDB, tiny account-scoped `flock-desk-lifecycle:<viewerDid>` workflow journal deleted on sign-out, and `sessionStorage` for pre-OAuth invite-link survival). |
| Refresh model | On-navigation + post-write + manual Refresh button for D1–D3; add optional 30–60 s poll in D4 only if needed. |
| Astryx fallback trigger | If Astryx/StyleX fails Next 16 webpack build or emits CSP violations in `desk-csp.spec.ts` (D0), switch cleanly to CSS Modules + ARIA primitives. |
| DMs, Reactions & Tasks in Desk | Deferred to D6 (v1.1) — not blocking D4/D5 independence proof. |

---

## 9. Authoritative References

- Product & parity contract: `SPEC.md`, `ARCHITECTURE.md`, `CODE-MAP.md`
- R13 OpenSocial groups plan & feedback: `.ai/plans/r13-opensocial-groups.md`, `groups-proposal-feedback.md`, `protocol-authors-feedback.md`
- Independent readers: `packages/reader/src/independent.ts`, `packages/reader/src/independent-dm.ts`, `packages/reader/src/independent-tasks.ts`
- Reference client & network invariants (for contract parity only — never imported by Desk): `packages/client/src/workspace-client.ts`, `packages/client/src/channel-client.ts`, `packages/client/src/store.ts`, `packages/client/src/indexeddb-store.ts`, `packages/net/src/safe-fetch.ts`, `packages/protocol/src/atproto/space-credential-core.ts`, `apps/group-host/src/moderation.ts`, `apps/group-host/src/methods.ts`
- BDD & test fixtures: `features/independent-app-and-launch.feature`, `bdd/steps/independent-app.steps.ts`, `bdd/support/independent-app-ui.ts`, `protocol-tests/support/app-fixture.ts`, `protocol-tests/support/app-server.ts`, `protocol-tests/suite-manifest.test.ts`
- Deployment & CSP: `packages/deployment/src/config.ts`, `packages/deployment/src/security-headers.ts`, `apps/web/src/proxy.ts`, `apps/web/src/lib/loopback-redirect.ts`, `apps/web/src/app/layout.tsx`, `apps/web/next.config.ts`
- Astryx: https://github.com/meta/astryx
