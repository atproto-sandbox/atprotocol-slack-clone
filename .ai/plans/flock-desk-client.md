# Flock Desk — Independent OpenSocial & Spaces Browser Client

**Status:** Planned (Rev 1 — R13 `opensocial.group` baseline)  
**Protocol Baseline:**
- ATProto Permissioned Spaces Proposal 0016 / `bluesky-social/atproto#5187` @ `6747610566eee1b6d743617bd8eb1136adccb362` (`0.0.0-spaces-alpha-20261117141222` + `strict-credential-expiry.patch`; see `docs/protocol/atproto-spaces-pin.md`)
- `opensocial.group` Atmospheric Groups Proposal @ `8df0cc82eb7708f090aa43522adf1d3ada3ed7e7` (merged to `main` at `8ae87a5`)
**UI Stack:** [Astryx](https://github.com/meta/astryx) (`@astryxdesign/core`, `@astryxdesign/theme-neutral`, `@stylexjs/stylex`), gated by a D0 Next 16 / React 19 / CSP spike with an explicit CSS Modules fallback.

---

## 1. Goal and the Claim This Client Must Prove

Ship a **second, genuinely independent browser client (`apps/desk`)** for the published `group.opensocial.*` and `new.flock.*` lexicons that is visibly and architecturally unrelated to `@flock/web` and **must not use `@flock/client`, `@flock/web`, or `@flock/operator`**:

- **Zero `@flock/client`:** no `SyncCore`, no `LiveSpaces`, no `WorkspaceClient`, no `GroupClient`, no `DmClient`, no engine cache.
- **Zero `@flock/operator` in v1:** Desk talks **only** to the user's personal PDS, each group's `opensocial.group` Group Host, and PLC / `did:web` identity endpoints. Desk runs with **no Operator process** and **no server SQLite database**.

Today we have three layers of independence evidence, each with a remaining gap:

| Layer | What it proves | Remaining gap |
|---|---|---|
| `packages/reader/src/independent*.ts` | Canonical **read** state from published lexicons, PDS/Group Host, and space credentials alone | Headless library only; no UI, no writes, no OAuth UX |
| BDD `features/independent-app-and-launch.feature` | Two **browser origins** render the same workspace | `startSecondApp()` spawns a second `@flock/web` + second Operator process (same engine, same CSS, different OAuth `client_id` & SQLite DB) |
| `@flock/echo-bot` / `@flock/webhooks` | Third-party-style services using public APIs | Node bots depending on `@flock/client` and Operator `getChanges`, not an independent browser client |

**Flock Desk** closes that gap: a user (and protocol reviewers) can sign in on a separate origin, discover cross-PDS invites (`group.opensocial.invites/self`) or open an invite link, join/leave an OpenSocial group directly on the Group Host, browse channels and private rosters, post/react to messages, view moderated transcripts (`!hide` / `!takedown`), and verify byte-for-byte canonical parity against `@flock/web` and `@flock/reader`—without touching `@flock/client` or Flock's Operator at all.

Success is **not** pixel parity with `@flock/web`. Success is **canonical state & moderation parity** under `SPEC.md` § "Independent-app parity" and the BDD scenario *Render one workspace from two independent apps*, with the second browser origin serving **Flock Desk**.

---

## 2. Non-Goals (v1 of Desk)

- Replacing or deprecating `@flock/web` (the reference app remains the primary client for full workflows).
- Admin / Group-DID OAuth workflows (`prompt=create` group genesis, channel creation, role/policy editing, moderator queue resolution, Group Host migration, Operator pause switch / journal inspection). Desk v1 uses **personal-PDS OAuth only**.
- App installs, slash commands, interactive blocks, or echo-bot / webhook administration.
- Incremental sync engine, background `authorizeSpaceSync(notify)` push relays, or IndexedDB record caches (Desk performs bounded direct reads via `@flock/reader` on navigation, write completion, or manual/periodic refresh).
- Shipping Desk or `@flock/shell` as standalone published npm packages outside this monorepo (both live in-repo as private workspace packages).

---

## 3. Architecture

### 3.1 Packages, Dependency Graph, and Hard Boundaries

```text
apps/desk (@flock/desk)              Next.js 16 App Router (--webpack), React 19, Astryx UI
  ├─ depends on: @flock/shell, @flock/reader, @flock/deployment, Astryx/StyleX, next, react
  └─ MUST NOT import: @flock/client, @flock/web, @flock/operator, @flock/group-host, @flock/net

packages/shell (@flock/shell)        Thin browser-only protocol adapter (no sync engine, no Operator)
  ├─ Personal-PDS OAuth 2.1 browser session (`@atproto/oauth-client-browser`, Desk-isolated IDB)
  ├─ Bounded, redirect-disabled DID / `#atproto_pds` / `#atproto_kem` resolver
  ├─ `SpaceCredentialDeps` / `IndependentDeps` adapter for `@flock/reader` (exact zero-skew exp cache)
  ├─ Minimal direct writes: `ensureInvitesSpace`, `requestJoin`/`acceptance`, `leaveGroup`,
  │  channel messages/reactions (`validateSpaceRecord` + `putRecord`/`deleteRecord`), `createReport`
  ├─ depends on: @flock/protocol, @atproto/oauth-client-browser (dev: @flock/testing)
  └─ MUST NOT import: @flock/client, @flock/web, @flock/operator, @flock/group-host, @flock/net,
     @flock/deployment, node:*

packages/reader (@flock/reader)      Unchanged contract: read-only, depends on @flock/protocol + @atproto/*
packages/protocol (@flock/protocol)  Published lexicons, scopes, validation, moderation, credential core
packages/deployment (@flock/deployment) Adds `getDeskConfig()` (no OPERATOR_URL / OPERATOR_SERVICE_REF)
```

Boundary enforcement (all fail CI):

1. **`packages/shell/src/boundary.test.ts`** — verifies `packages/shell/package.json` dependencies and static/dynamic import graph reach only `@flock/protocol` and `@atproto/oauth-client-browser` (and `@flock/testing` in dev/tests).
2. **`apps/desk/src/boundary.test.ts`** — mirrors `apps/echo-bot/src/boundary.test.ts`: verifies `apps/desk/package.json` dependencies and import graph reach only `@flock/shell`, `@flock/reader`, `@flock/deployment`, Next/React, and Astryx/StyleX packages.
3. **`eslint.config.mjs` updates:**
   - Add `packages/shell/src/**/*.{ts,tsx}` and `apps/desk/src/browser/**/*.{ts,tsx}` to `BROWSER_CODE` (forbidding `node:*`, `@flock/deployment/*`, `@flock/net/*`, `@flock/client/*`).
   - Add explicit `no-restricted-imports` + dynamic-`import()` `no-restricted-syntax` blocks for `packages/shell/src/**` and `apps/desk/src/**` forbidding `@flock/client`, `@flock/client/*`, `@flock/web`, `@flock/web/*`, `@flock/operator`, `@flock/operator/*`, `@flock/group-host`, `@flock/group-host/*`, `@flock/net`, `@flock/net/*`.
   - Keep `flock-boundaries/no-legacy-memberspace` enabled everywhere in Desk and Shell, adding **only** `packages/shell/src/invites.ts` (and `invites.test.ts`) to `MEMBERSPACE_LIST_ONLY_ALLOWLIST` (`allowListMembers: true`) so `ensureInvitesSpace()` can verify zero members on personal `group.opensocial.invites/self` while `putMembers`/`removeMembers` remain forbidden.
   - Update `settings.next.rootDir` to `["apps/web/", "apps/desk/"]`.
4. **Browser type-purity gate (`package.json` `typecheck`):**
   - Extend `pnpm typecheck` with `tsc -p packages/shell && ! tsc -p packages/shell --listFilesOnly | grep -q /@types/node/` so `@flock/shell` stays 100% browser-pure alongside `@flock/protocol` and `@flock/client`.

### 3.2 Read Path (100% `@flock/reader`)

All workspace, invite, channel, moderation, and (optional v1.1) DM/Tasks read models call existing `@flock/reader` functions directly—never reimplementing record parsing, RBAC/policy summarization, or label projection in Desk:

| Surface | `@flock/reader` API | Notes |
|---|---|---|
| Joined workspaces | `listIndependentWorkspaces(deps)` | Discovers joined groups via personal PDS `listSpaces({ spaceType: "group.opensocial.members" })` + Group Host reads |
| Single workspace detail / directory / roster / admins | `readIndependentWorkspace(deps, workspaceUri)` | Reads `<groupDid>` `meta/self`, `members/self`, `workspace/self`, and `com.atproto.space.policy`; withholds `!takedown` members |
| Incoming cross-PDS group invites | `readIndependentInvites(deps)` | Reads personal `group.opensocial.invites/self` directly — eliminates R12's empty-dashboard problem |
| Channel transcript, reactions & moderation labels | `readIndependentChannelPage(deps, workspaceUri, channelSkey)` | Projects `<groupDid>`-authored `com.atproto.label.record` (`!takedown` withheld; `!hide` flagged via `hidden: true`) |
| Private channel roster | `readIndependentPrivateRoster(deps, workspaceUri, channelSkey)` | Evaluates `group.opensocial.policy` grants + active bilateral memberships |
| DM conversation *(v1.1 / D6)* | `readIndependentDmConversation(deps, convKey, participants)` | From `@flock/reader/independent-dm` |
| Tasks snapshot *(v1.1 stretch)* | `readIndependentTasksWorkspaceSnapshot`, `readIndependentTasksSpace` | From `@flock/reader/independent-tasks` |

`@flock/shell` wires `IndependentDeps` (`SpaceCredentialDeps` + `did`) on top of the browser's personal PDS OAuth `fetchHandler`:
- **DID / `#atproto_pds` / `#atproto_kem` resolution:** fetch-only with `redirect: "error"`, `256 KiB` body cap (`readUpstreamJson`), strict HTTPS outside loopback, and `forceRefresh` support for KEM key rotation (`kemKeyFromDidDocument` from `@flock/protocol/atproto/kem-key`).
- **Space credential caching:** minimal in-memory per-space cache keyed by `spaceUri`, respecting exact zero-skew `exp` expiry (`nowMs < expMs`, proportional early renewal, automatic cache eviction and single retry on host credential refusal) using `mintSpaceCredentialWith` from `@flock/protocol/atproto/space-credential-core`.

### 3.3 Write Path (Minimal, Direct Protocol Only — Zero Operator)

Every write in `@flock/shell` validates payloads via `validateSpaceRecord` (`@flock/protocol/registry`) and talks strictly to the user's personal PDS or the target Group Host:

1. **`ensureInvitesSpace()` (`packages/shell/src/invites.ts`):**
   - Idempotently creates `at://<viewerDid>/space/group.opensocial.invites/self` on the user's personal PDS with `com.atproto.memberspace.policy { publicWrite: true }` and verifies zero explicit members via `com.atproto.memberspace.listMembers` (matching R13 `WorkspaceClient.ensureInvitesSpace()` invariants).
2. **Join & Leave (`packages/shell/src/membership.ts`):**
   - `joinGroup({ groupDid, inviteUri?, message? })`:
     1. Resolves `<groupDid>`'s `#atproto_pds` Group Host endpoint (with `forceRefresh` retry on stale host codes).
     2. Mints a personal service JWT (`com.atproto.server.getServiceAuth` with `aud: <groupDid>#atproto_pds`, `lxm: "group.opensocial.requestJoin"`).
     3. Calls `POST <groupHost>/xrpc/group.opensocial.requestJoin` with a deterministic/persisted `Idempotency-Key` header (`1..128` `[A-Za-z0-9._:-]`) so lost HTTP responses on invite redemption retry safely without hitting `400 InvalidInvite`.
     4. If `{ status: "admitted" }`, reads live `membership/<viewerDid>` (extracting `incarnation` / fallback `"legacy-cid:" + cid` when present) and writes `group.opensocial.acceptance/self` to the user's personal PDS inside `at://<groupDid>/space/group.opensocial.members/self`.
     5. If `{ status: "pending" }`, returns pending state cleanly so the UI displays *"Request pending approval"*.
     6. If the user is already a member (e.g., opening an invite link for a workspace they already joined on `@flock/web`), detects existing `membership/<viewerDid>`, ensures `acceptance/self` is written if missing, and opens the workspace directly (matching `joinWorkspaceAt` semantics).
   - `leaveGroup({ groupDid })`:
     1. Reads current `membership/<viewerDid>` incarnation if present.
     2. Calls `group.opensocial.leaveGroup` on the Group Host (with `If-Match-Membership-Incarnation` when known) **first**—only deleting own-PDS `acceptance/self` after `leaveGroup` succeeds (so `400 LastAdmin` or `409 MembershipIncarnationMismatch` never corrupts `acceptance/self`).
3. **Channel Messages & Reactions (`packages/shell/src/channel.ts`):**
   - `postChannelMessage(spaceUri, { text, parent? })`: generates TID `rkey` (`tidNow`), validates with `validateSpaceRecord(COLLECTION.message, ...)`, calls `com.atproto.space.putRecord` on the user's personal PDS.
   - `editChannelMessage` / `deleteChannelMessage`: own-repo `putRecord` / `deleteRecord`.
   - `toggleReaction(spaceUri, { subject, emoji })` *(D5 / stretch)*: deterministic reaction key per `(author, subject, emoji)`.
4. **Content Reporting (`packages/shell/src/moderation.ts`):**
   - `reportSubject({ groupDid, subject, cid?, reasonType, reason?, rule? })`: personal service JWT (`lxm: "group.opensocial.createReport"`) → `POST <groupHost>/xrpc/group.opensocial.createReport`.
5. **Refresh model:** No background sync engine or webhook relay. Desk refreshes on route load, after every user write, and via an explicit Refresh button (plus optional 30–60 s passive poll in D4 only if needed).

### 3.4 OAuth Scopes, Client Metadata & Deployment Config

1. **Operator-free personal OAuth scopes (`packages/protocol/src/scopes.ts`):**
   - Add `deskMemberScopes(): string[]` exporting strictly:
     - `"atproto"`
     - `...OPEN_SOCIAL_PARTICIPATE_SCOPES` (`meta/self` read, `members/self` acceptance CRUD, `invites/self` read + `manage=create`, `rpc?aud=*&lxm=group.opensocial.{cancelJoinRequest,createReport,leaveGroup,requestJoin}`)
     - `PERSONAL_PDS_LIST_GROUP_MEMBERS_SPACES_SCOPE` (`space:group.opensocial.members?authority=*&action=read_self` — required by real `@atproto/pds` `listSpaces`, avoiding the `authParticipate.json` `"skey": "self"` mismatch)
     - Flock modality member read/write scopes (`workspace/self` read, `inbox/self` read + `joinRequest` CRUD, `channel/*` read + `message`/`reaction` CRUD)
   - **Explicitly omits `operatorMethodsScope(...)`** (and omits `DM_BROWSER_SCOPES` until optional D6 DMs are added).
2. **Deployment config (`packages/deployment/src/config.ts`):**
   - Add `getDeskConfig(): DeskConfig` reading only `APP_URL`, `PLC_URL` (default `https://plc.directory`), and optional `GROUP_HOST_URL` (default `http://127.0.0.1:3004` on loopback)—**never** reading or requiring `OPERATOR_URL` or `OPERATOR_SERVICE_REF`.
   - Keep `getConfig()` unchanged for `@flock/web` and `@flock/operator`.
3. **Desk OAuth routes & security headers (`apps/desk`):**
   - `GET /oauth/client-metadata.json`: publishes Desk's own `client_id` (`${appUrl.origin}/oauth/client-metadata.json` outside loopback; RFC 8252 `http://localhost?...` loopback client metadata on loopback) and `redirect_uris` on `appUrl.origin` with `scope: deskMemberScopes().join(" ")`.
   - `GET /oauth/callback`: completes `@atproto/oauth-client-browser` callback into Desk's own origin-isolated IndexedDB (`flock-desk-oauth`), with zero server secrets or cookies.
   - `src/proxy.ts` + `next.config.ts`: reuses `webContentSecurityPolicy` and `securityHeaderRule()` from `@flock/deployment/security-headers`, plus loopback `localhost` → `127.0.0.1` normalization.

### 3.5 UI Stack (Astryx + StyleX) & D0 Feasibility Gate

- Run `npx @astryxdesign/cli init` once in `apps/desk` and commit the generated agent guide alongside a cross-link from `CODE-MAP.md`.
- Pin exact versions of `@astryxdesign/core`, `@astryxdesign/theme-neutral`, and `@stylexjs/stylex` in `apps/desk/package.json` (and update `pnpm-workspace.yaml` `allowBuilds` / `onlyBuiltDependencies` if any build script is required).
- Visually distinct layout and theme tokens via CSS custom properties on `:root`; **zero** reuse of `@flock/web` class names or `globals.css`.
- Use Next 16 webpack mode (`next dev --webpack`, `next build --webpack`) matching `apps/web`.
- **D0 Hard Gate (Astryx + Next 16 + React 19 + CSP Nonce Check):** Before writing D1 features, D0 MUST prove that `pnpm --filter @flock/desk build` succeeds cleanly and that the signed-out landing page renders in real Chromium under `webContentSecurityPolicy` with **zero console errors and zero CSP violations** (no `'unsafe-eval'` in production). **Explicit fallback:** if Astryx/StyleX has an unresolvable incompatibility with Next 16 / React 19 / strict CSP, fall back to clean **CSS Modules + accessible semantic HTML/ARIA components** (still 100% visually distinct from `@flock/web`) rather than blocking D1–D4.
- **Accessible Test Contract:** Every interactive surface exposes stable ARIA roles/labels (`region`, `navigation`, `heading`, `button`, `textbox`) and `data-testid="desk-*"` hooks so `observeWorkspaceDesk` is resilient to visual/skin changes and never shares CSS selectors with `@flock/web`.

### 3.6 Playground and BDD Integration (`startDeskApp` vs `startSecondApp`)

**Critical R13 constraint:** `this.fixture.startSecondApp()` in `protocol-tests/support/app-fixture.ts` is currently called by four distinct scenarios:
1. `bdd/steps/independent-app.steps.ts:114` (*Render one workspace from two independent apps*) — **target for Flock Desk**.
2. `bdd/steps/independent-app.steps.ts:628` (*Stop new work with the operator pause switch* with `FLOCK_ADMIN_MUTATIONS_PAUSED=true`) — specifically tests a paused **Operator** + `@flock/web`.
3. `bdd/steps/dm-policy.steps.ts:681, 779` — tests DM / `AUTH_ENCRYPTION_KEY` across two `@flock/web` + Operator instances.
4. `bdd/support/channels-ui.ts:244` — tests two `@flock/web` sync-engine clients.

Therefore:
- **Do NOT break callers 2–4.** Add `startDeskApp()` (or `startSecondApp({ kind: "desk" })`) to `protocol-tests/support/app-fixture.ts`, spawning **only** `next start apps/desk` with `APP_URL`, `PLC_URL`, and `GROUP_HOST_URL` (**no Operator child process**, **no `DATABASE_PATH` / SQLite file**, `databasePath: null`).
- Switch `bdd/steps/independent-app.steps.ts:114` (*Render one workspace from two independent apps*) to `startDeskApp()` by default, preserving an env escape hatch `BDD_SECOND_APP=web` for debugging.
- In `independent-app.steps.ts`:
  - Assert Desk's `/oauth/client-metadata.json` publishes a distinct `client_id` with Desk's own `redirect_uris` and **zero** `new.flock.operator.*` RPC scopes.
  - Assert Desk's browser makes **zero** HTTP requests to `this.fixture.operatorUrl.origin` (proving zero Operator dependency on the wire!).
  - Add `observeWorkspaceDesk` in `bdd/support/independent-app-ui.ts` reading Desk's rendered workspace summary, sidebar directory, channel messages (newest first), moderation state (`!hide` / `!takedown`), and private channel roster, **and** running the existing network-level `workspaceRead()` assertion proving Desk's browser directly listed `profile`, `role`, `membership`, `directory`, `appInstall`, and `spacePolicy` strictly from `<groupDid>`'s repo.

---

## 4. Functional Scope by Milestone

**In scope for "v1 complete" (D0–D5):**
- Sign-in & sign-out (personal PDS handle/DID → OAuth 2.1 DPoP, `deskMemberScopes()`).
- Automatic `ensureInvitesSpace()` on sign-in + **Invites inbox** (`readIndependentInvites`) **and** invite URL handler (`?invite=<workspaceUri>` / `/invite`) supporting direct `requestJoin` + `acceptance/self` join without Operator.
- **Workspace switcher & home:** joined workspaces (`listIndependentWorkspaces`), summary line (`<N> active members · <M> channels · join policy: <policy>`), active member roster & admin list (`readIndependentWorkspace`), and **Leave group** (`leaveGroup` with incarnation guard).
- **Channel view (public & private):** message list (newest first, bounded page from `readIndependentChannelPage`), post/edit/delete text message, private channel roster display (`readIndependentPrivateRoster`), **moderation label projection** (`!takedown` withheld; `!hide` collapsed with click-to-reveal warning), and **Report message/account** (`group.opensocial.createReport`).

**Staged after v1 (still zero `@flock/client` / zero Operator):**
- **D6 (v1.1 optional):** Reactions (`toggleReaction`), direct messages read/post via `@flock/reader/independent-dm` (`readIndependentDmConversation`) + separate DM OAuth scope opt-in, and read-only Tasks view via `@flock/reader/independent-tasks`.

---

## 5. Milestones, Exit Evidence, and Verification Gates

| ID | Milestone | Concrete Exit Evidence |
|---|---|---|
| **D0** | Scaffold `packages/shell` + `apps/desk` + `getDeskConfig()` + `deskMemberScopes()` + ESLint/boundary rules + Astryx/Next 16/CSP spike | `pnpm typecheck`, `pnpm lint`, `npx eslint --max-warnings=0 .`, `packages/shell/src/boundary.test.ts`, `apps/desk/src/boundary.test.ts`, and `pnpm --filter @flock/desk build` all green; Chromium renders Desk landing page with 0 CSP/console errors |
| **D1** | Browser OAuth session + `@flock/reader` `IndependentDeps` wiring + workspace list & invites inbox | Signed-in user sees `listIndependentWorkspaces` and `readIndependentInvites` in Desk UI; unit tests on `FakeNetwork` prove zero-skew `exp` caching, KEM rotation retry, and parity with reader |
| **D2** | Direct OpenSocial join & leave (zero Operator) | Member invited from `@flock/web` sees invite in Desk's Invites inbox (and via invite link), joins via `requestJoin` (`Idempotency-Key`) + `acceptance/self`, and can leave via `leaveGroup` (`If-Match-Membership-Incarnation`) without touching Operator |
| **D3** | Channel transcript, posting, moderation projection & `desk-parity.spec.ts` | Cross-posting between `@flock/web` and Desk matches `readIndependentChannelPage`; `!hide` and `!takedown` labels published in `@flock/web` project identically in Desk; new `protocol-tests/browser/desk-parity.spec.ts` wired into `package.json` `test:browser` (passing `suite-manifest.test.ts`) passes 100% |
| **D4** | BDD *Render one workspace from two independent apps* swapped to Desk | `features/independent-app-and-launch.feature` passes with `startDeskApp()` (zero second Operator, zero second DB, zero Operator HTTP requests from Desk, `workspaceRead()` & UI parity green); `BDD_SECOND_APP=web` fallback also passes; all 75 BDD scenarios green |
| **D5** | Private channel roster + reporting + cross-origin CSP verification | Private channel roster parity (`Vault`) and `createReport` from Desk verified against real Group Host; Desk passes CSP nonce & cross-origin preflight checks (`protocol-tests/browser/desk-parity.spec.ts`) |
| **D6** | *(Optional v1.1)* Reactions, DM read (`readIndependentDmConversation`), read-only Tasks (`readIndependentTasksSpace`) | Parity tests against `independent-dm.ts` and `independent-tasks.ts` green |
| **D7** | Docs, `CODE-MAP.md`, `PLAN.md`, `SPEC.md` | `README.md`, `CODE-MAP.md`, `PLAN.md` (M7 Flock Desk row), `SPEC.md`, and `docs/dev-onboarding.md` updated; `pnpm test`, `pnpm build`, `pnpm test:browser`, and `pnpm test:bdd` green |

---

## 6. Testing Strategy

1. **Unit & Boundary (`pnpm test`):**
   - `packages/shell/src/boundary.test.ts` and `apps/desk/src/boundary.test.ts` (dependency & import-graph enforcement).
   - `packages/shell/src/**/*.test.ts` on `FakeNetwork`: `SpaceCredentialDeps` zero-skew `exp` cache + KEM retry, `ensureInvitesSpace` zero-member guard, `joinGroup` `Idempotency-Key` replay & `"pending"` handling, `leaveGroup` ordering (`leaveGroup` before `acceptance/self` delete, preserving `acceptance/self` on `LastAdmin` / `MembershipIncarnationMismatch`), `postChannelMessage` validation, `reportSubject`.
   - `packages/protocol/src/scopes.test.ts`: assert `deskMemberScopes()` contains zero `new.flock.operator.*` RPC scopes and satisfies real PDS `listSpaces({ spaceType: "group.opensocial.members" })`.
   - `packages/deployment/src/config.test.ts`: assert `getDeskConfig()` succeeds when `OPERATOR_URL` and `OPERATOR_SERVICE_REF` are unset.
2. **Real-Browser Parity (`protocol-tests/browser/desk-parity.spec.ts`, wired into `test:browser` + `suite-manifest.test.ts`):**
   - Boots real personal PDSes + real `GroupHostServer` + `@flock/web` (+ Operator) + `@flock/desk` (no Operator!).
   - Verifies cross-PDS invite discovery + invite-link join + cross-posting + private roster + `!hide` / `!takedown` moderation projection + `createReport` + strict CSP nonces + **zero** requests from Desk to Operator origin.
3. **BDD (`features/independent-app-and-launch.feature`):**
   - `Render one workspace from two independent apps` runs with primary `@flock/web` + secondary `@flock/desk` (asserting distinct OAuth `client_id`, zero Operator calls from Desk, `observeWorkspaceDesk` UI parity, `workspaceRead()` network proof, and `@flock/reader` oracle parity).
   - Root `package.json` `test:bdd` builds both `@flock/web` and `@flock/desk` (`pnpm build && pnpm --filter @flock/desk build`) once D4 lands.
   - No requirement to port all 75 BDD scenarios to Desk—only `independent-app-and-launch.feature` and future `@second-client` scenarios.

---

## 7. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Accidental `@flock/client`, `@flock/web`, or `@flock/operator` import | Boundary unit tests + `eslint.config.mjs` static & dynamic import restrictions + `typecheck` `@types/node`-free check on `packages/shell` |
| Breaking Operator-pause / DM / multi-tab `startSecondApp()` BDD scenarios | Add dedicated `startDeskApp()` (zero Operator) for `Render one workspace from two independent apps`; keep `startSecondApp()` on `@flock/web` for Operator/DM scenarios |
| Astryx / StyleX incompatibility with Next 16, React 19, or strict CSP nonces | Mandatory D0 build + real-Chromium CSP spike before D1; documented fallback to CSS Modules + semantic ARIA components |
| Drift between Desk UI and canonical protocol state | `@flock/reader` is Desk's sole read path (no duplicated parsing/RBAC/label code) and remains the test oracle |
| Real PDS OAuth scope rejection (`authParticipate` `"skey": "self"` vs `listSpaces`) | `deskMemberScopes()` explicitly includes `PERSONAL_PDS_LIST_GROUP_MEMBERS_SPACES_SCOPE` (verified against real `@atproto/pds` in D1/D3) |
| Duplicate `memberspace` allowlist creep | `flock-boundaries/no-legacy-memberspace` blocks all `com.atproto.memberspace.*` across Desk/Shell except `allowListMembers: true` on `packages/shell/src/invites.ts` |
| Forgotten `suite-manifest.test.ts` registration | Any new `protocol-tests/browser/desk-parity.spec.ts` is wired directly into root `package.json` `test:browser` in the same milestone (D3) |

---

## 8. Open Decisions (Resolved for v1)

| Decision | Resolution for v1 |
|---|---|
| Operator dependency in Desk v1 | **None** — Desk talks strictly to Personal PDS + Group Host + PLC (`getDeskConfig()` + `deskMemberScopes()`). |
| Package & app names | `packages/shell` (`@flock/shell`) and `apps/desk` (`@flock/desk`). |
| Refresh model | On-navigation + post-write + manual Refresh button for D1–D3; add optional 30–60 s poll in D4 only if needed. |
| Astryx fallback trigger | If Astryx/StyleX fails Next 16 webpack build or emits CSP violations under `webContentSecurityPolicy` in D0, switch cleanly to CSS Modules + ARIA primitives. |
| DMs & Tasks in Desk | Deferred to D6 (v1.1) — not blocking D4/D5 independence proof. |

---

## 9. Authoritative References

- Product & parity contract: `SPEC.md`, `ARCHITECTURE.md`, `CODE-MAP.md`
- R13 OpenSocial groups plan & feedback: `.ai/plans/r13-opensocial-groups.md`, `groups-proposal-feedback.md`, `protocol-authors-feedback.md`
- Independent readers: `packages/reader/src/independent.ts`, `packages/reader/src/independent-dm.ts`, `packages/reader/src/independent-tasks.ts`
- BDD & test fixtures: `features/independent-app-and-launch.feature`, `bdd/steps/independent-app.steps.ts`, `bdd/support/independent-app-ui.ts`, `protocol-tests/support/app-fixture.ts`, `protocol-tests/suite-manifest.test.ts`
- Deployment & CSP: `packages/deployment/src/config.ts`, `packages/deployment/src/security-headers.ts`, `apps/web/src/proxy.ts`
- Astryx: https://github.com/meta/astryx
