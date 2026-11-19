# R12 Protocol Drift Plan & Progress (`bluesky-social/atproto#5187` @ `674761056`)

**Status:** Waves `R12a`–`R12e` + Gates 1–6 complete and 100% green — running Round 1 Codex + Claude adversarial implementation reviews
**Branch:** `chore/protocol-drift-6747610` in worktree `../atproto-slack-clone-r12`
**Baseline:** `origin/main` at `f4a4c16` (PRs #7 `feat/r10-interactions` -> `f7b7bdc` and #8 `feat/r11-tasks` -> `f4a4c16` merged cleanly; `908/908` unit/component tests green before drift)
**Target Upstream Pin:** `bluesky-social/atproto#5187` HEAD `6747610566eee1b6d743617bd8eb1136adccb362` (88 commits past `5d88b414`, detached worktree `../atproto-spaces-r12` — unbuilt on creation, built and patched in Wave `R12a`; `../atproto-spaces-phase3` stays untouched at `5d88b414`)
**Target NPM Snapshot:** `0.0.0-spaces-alpha-20261117141222` (published `2026-11-17T14:20:38Z`, matching commit `223114799`; zero diff against `674761056` across `lexicons/`, `packages/space/`, `packages/star/`, `packages/crypto/`, `packages/xrpc-server/`, `packages/oauth/oauth-client*`, `packages/oauth/jwk-jose/`, and `packages/oauth/oauth-provider/`)
**Normative References:** `../atproto-spaces-r12/alpha-migrations/prompt-11-5-26.md`, `../atproto-spaces-r12/alpha-migrations/prompt-11-12-26.md`, and the 88-commit `#5187` diff (`5d88b414..6747610566`).

---

## Locked Architectural Decisions (`D12.1`–`D12.12`)

### `D12.1` Pinning, Env Standardization, Upstream Build & Workspace Dependencies
1. **Env Vars & Checkout Paths:**
   - Standardize references across the repo to `../atproto-spaces-r12` (`6747610566eee1b6d743617bd8eb1136adccb362`). Leave `../atproto-spaces-phase3` untouched.
   - `scripts/codegen-lex.mjs` checks `ATPROTO_PIN_CHECKOUT` (update fallback/help or accept `ATPROTO_PIN_CHECKOUT ?? ATPROTO_PINNED_CHECKOUT`, keeping `ATPROTO_PIN_CHECKOUT` compatible with existing usage) and updates `expectedCommit = "6747610566eee1b6d743617bd8eb1136adccb362"`. All invocations pass explicit `ATPROTO_PIN_CHECKOUT=../atproto-spaces-r12`.
   - `protocol-tests/support/app-fixture.ts:51` updates its default fallback from `../atproto-spaces-phase3` to `../atproto-spaces-r12`.
   - `docs/protocol/atproto-spaces-pin.md` records `6747610566eee1b6d743617bd8eb1136adccb362`, snapshot `0.0.0-spaces-alpha-20261117141222`, rebased patch SHA-256, and production HTTPS notify endpoint requirements (`safeClient` SSRF protection blocks private/loopback webhook endpoints unless PDS runs `devMode: true, disableSsrfProtection: true`).
2. **Upstream Worktree Build (`../atproto-spaces-r12` in `R12a`):**
   - `../atproto-spaces-r12` has no `node_modules` or `dist/` yet and declares `devEngines` (`node ^22.23.4 || ^24.22.1 || ^26.12.1`, `pnpm 12.16.1`), with `undici@8.12.3` requiring `node >= 22.19`. Any Node `22.x` shares `NODE_MODULE_VERSION` 127 (`better-sqlite3` native ABI compatible with root `engines: ">=22.12.0 <23"`).
   - Host runtime check under `~/.nvm/versions/node/`: installed `v22.15.0` and `/Users/mikestaub/.nvm/versions/node/v22.17.0` (plus `/opt/homebrew/bin/node` `v25.4.0`; no Node `>= 22.23.4` currently present in `~/.nvm/versions/node/`). Prefer Node `>= 22.23.4 < 23` if installed in the environment; otherwise build & run on `/Users/mikestaub/.nvm/versions/node/v22.17.0` with `PUPPETEER_SKIP_DOWNLOAD=true` and `pnpm_config_manage_package_manager_versions=false pnpm_config_engine_strict=false` and verify zero `undici`/`devEngines` runtime failures across `@atproto/space` + Gate 2–4 PDS tests (recording exact runtime + flags in Gate Log):
     - Apply rebased `strict-credential-expiry.patch` first.
     - Run `pnpm build:tooling` (produces `packages/lex-cli/dist/index.js` required by `codegen-lex.mjs`) and build `@atproto/dev-env` + its `tsconfig.build.json` reference graph (`api`, `bsky`, `bsync`, `common-web`, `crypto`, `identity`, `lex-client`, `lex-schema`, `lexicon`, `ozone`, `pds`, `sync`, `syntax`, `xrpc-server`, plus `oauth-provider-ui` `i18n:compile`/build if required by `pds`/`dev-env`).
     - Run `pnpm --filter @atproto/space test` inside `../atproto-spaces-r12` to verify `credential.test.ts` with the rebased strict-expiry patch before moving to `R12b`.
3. **NPM Snapshot Equivalence & Workspace Package Pins:**
   - Snapshot `0.0.0-spaces-alpha-20261117141222` (`223114799`) has an empty diff against `674761056` across `lexicons/`, `packages/space/`, `packages/star/`, `packages/crypto/`, `packages/xrpc-server/`, `packages/oauth/oauth-client*`, `packages/oauth/jwk-jose/`, and `packages/oauth/oauth-provider/`. Post-alpha commits (`#5929` `lex-space`/`lex-builder`/`oauth-scopes` wildcard `collection: '*'`; `#5932` PDS `safeClient` webhooks, `importRepo`, taken-down authority `notifyRepoUpdate`) run inside built `../atproto-spaces-r12`, while `codegen-lex.mjs` runs `../atproto-spaces-r12/packages/lex-cli/dist/index.js`.
   - Per upstream `prompt-11-12-26.md` ("Upgrade only existing direct dependencies involved in Spaces"), upgrade existing alpha packages and add direct `@atproto/star` where imported directly:
     - Root `package.json`: `@atproto/crypto`, `@atproto/xrpc-server` -> `0.0.0-spaces-alpha-20261117141222`.
     - `packages/protocol/package.json`: `@atproto/crypto`, `@atproto/lex-data`, `@atproto/lexicon`, `@atproto/space` -> `0.0.0-spaces-alpha-20261117141222`, plus NEW `@atproto/star: "0.0.0-spaces-alpha-20261117141222"`.
     - `packages/reader/package.json`: `@atproto/lex-data`, `@atproto/lexicon`, `@atproto/space` -> `0.0.0-spaces-alpha-20261117141222`, plus NEW `@atproto/star: "0.0.0-spaces-alpha-20261117141222"` (required for `StarParseError` in `independent-tasks.ts` under ESLint `import/no-extraneous-dependencies`).
     - `packages/client/package.json`: `@atproto/crypto` -> `0.0.0-spaces-alpha-20261117141222`.
     - `packages/testing/package.json`: `@atproto/crypto`, `@atproto/lex-data`, `@atproto/lexicon`, `@atproto/space` -> `0.0.0-spaces-alpha-20261117141222`, plus NEW `@atproto/star: "0.0.0-spaces-alpha-20261117141222"`.
     - `apps/operator/package.json`: `@atproto/xrpc-server`, `@atproto/crypto`, `@atproto/space` -> `0.0.0-spaces-alpha-20261117141222`.
     - `apps/web/package.json`: `@atproto/crypto` -> `0.0.0-spaces-alpha-20261117141222`.
     - Leave stable non-alpha packages (`@atproto/oauth-client-node: 0.5.7`, `@atproto/oauth-client-browser: 0.5.7`, `@atproto/identity: 0.5.13`, `@atproto/jwk-jose: 0.2.4`, `@atproto/xrpc: 0.8.13`, `@atproto/lex-cli: 0.10.13`) on their existing stable pins unless `R12a` lockfile resolution surfaces a concrete peer/type clash with `lexicon`/`xrpc-server`.
   - **Never remove `overrides` in `pnpm-workspace.yaml`:** `^0.0.0-spaces-alpha-*` ranges match stray uninstallable `0.0.0` releases (`lex-cbor`, `lex-data`), so keep EVERY existing override re-pinned to `0.0.0-spaces-alpha-20261117141222` (plus `@atproto/star`, `@atproto/xrpc`, `@atproto/lex-client`, `@atproto/lex-schema`, `@atproto/ws-client`, etc. if resolved under `^0.0.0-spaces-alpha-*`).
   - Run `pnpm install --no-frozen-lockfile`, audit the full resolved lockfile closure for EVERY direct and transitive `0.0.0-spaces-alpha-20261117141222` package, populate `minimumReleaseAgeExclude` exhaustively (`@atproto/car`, `@atproto/common`, `@atproto/common-web`, `@atproto/crypto`, `@atproto/lex-cbor`, `@atproto/lex-client`, `@atproto/lex-data`, `@atproto/lex-json`, `@atproto/lex-schema`, `@atproto/lexicon`, `@atproto/space`, `@atproto/star`, `@atproto/syntax`, `@atproto/ws-client`, `@atproto/xrpc`, `@atproto/xrpc-server`, plus any additional `@atproto/*` or `@atproto-labs/*` packages resolved in `pnpm-lock.yaml`), and assert zero stale `20261029171913` and zero duplicate alpha versions remain in `pnpm-lock.yaml`.

### `D12.2` Strict Credential Expiry Patch Rebase (`protocol-tests/atproto/strict-credential-expiry.patch`)
1. Upstream `packages/space/src/credential.ts` (`verifySpaceToken` ~line 296) keeps `if (now - CLOCK_SKEW_SEC >= payload.exp)` for all token types, and PR `#5924` moved `packages/space/tests/credential.test.ts` to `packages/space/src/credential.test.ts`.
2. Rebase `protocol-tests/atproto/strict-credential-expiry.patch` cleanly onto `674761056`:
   - Apply exact cutoff for `'credential'` (`const expirationSkew = type === 'credential' ? 0 : CLOCK_SKEW_SEC`) in `packages/space/src/credential.ts` while retaining `CLOCK_SKEW_SEC` tolerance for `'delegation'` and `'clientAttestation'`.
   - Update `packages/space/src/credential.test.ts` to test delegation clock-skew tolerance and strict credential expiration at `payload.exp * 1000`.
3. Apply inside `../atproto-spaces-r12` before running `@atproto/space` unit tests and building `@atproto/dev-env`, and update the SHA-256 recorded in `docs/protocol/atproto-spaces-pin.md` and `protocol-tests/atproto/README.md`.

### `D12.3` Operator Webhook Notifications (`authorizeSpaceSync`, Stable Token Identity, Continuous 10-Min Renewal & Gap Catch-Up)
Upstream removed `com.atproto.space.registerNotify`, `unregisterNotify`, and `notifySpaceDeleted`, and renamed `notifyWrite` -> `notifyRepoUpdate` (PDS-to-authority only). App syncers register inline via `authorizeSpaceSync` (`notify: { endpoint, token }`, `token <= 512` chars), respond to PDS synchronous `confirmRegistration`, and receive `notifySpaceUpdate`. Registrations expire with the space credential (`exp`, `600 s` default, up to `3600 s`).

1. **Removed vs Retained `NOTICE_METHOD` Routes (`packages/protocol/src/nsids.ts`, `apps/operator/src/operator/{server,notices,space-notification}.ts`):**
   - `NOTICE_METHOD` defines ONLY inbound webhook XRPC endpoints served by the operator (`server.ts`, `methods.ts`):
     - `confirmRegistration: "com.atproto.space.confirmRegistration"`
     - `notifySpaceUpdate: "com.atproto.space.notifySpaceUpdate"`
   - Remove `notifyWrite` and `notifySpaceDeleted` from `NOTICE_METHOD`. Do NOT add `notifyRepoUpdate` or `notifyCredentialsRevoked` (those are PDS-to-PDS XRPC methods). Delete obsolete `unregisterNotify` / `registerNotify` calls everywhere (`notices.ts`, `registrations.ts`, `space-notification.ts`, `dm-client.ts`).
2. **Stable 1-Token-Per-Space Model & Schema (`apps/operator/src/lib/db.ts`, `registrations.ts`):**
   - Upstream identifies registrations by `(space, endpoint, token)` (`transactor.ts:490`), only sends `confirmRegistration` for *new* registrations, and renews existing ones when the same `(space, endpoint, token)` re-authorizes (`authorizeSpaceSync.json:104`, `prompt-11-12-26.md` §4b). Never rotate tokens on renewal!
   - Align strictly with existing SQLite tables (`notification_registration` + `notification_registration_failure(service_ref, space_uri, failures, next_attempt_at)` in `db.ts:167`):
     - Add three columns to `notification_registration` via DB migration (preserving PK `(service_ref, space_uri)`):
       - `token TEXT NOT NULL DEFAULT ''`
       - `renew_at INTEGER NOT NULL DEFAULT 0`
       - `last_space_rev TEXT` (nullable checkpoint for gap catch-up; do NOT add `space_rev` to `space_notification`, preserving its `(space_uri, space_type, type_seq, repo_did, rev, notified_at)` schema!).
     - In the migration itself, reset **`expires_at = 0, renew_at = 0` for all legacy rows with `token = ''`** so `registerNotify`-era rows (whose `expires_at` could be ~24 h in the future) are treated as immediately due on startup (`db-migration.test.ts` covers this upgrade path).
   - **Token lifecycle in `registerSpace`:** Read `(token, renew_at, last_space_rev, expires_at)` from `notification_registration`. If `token` is empty (new registration or migrated legacy row), generate one 32-byte random base64url `token` and persist `(service_ref, space_uri, expires_at = 0, renew_at = 0, token)` *before* calling `authorizeSpaceSync` so PDS's synchronous `confirmRegistration` succeeds inside `authorizeSpaceSync`. Reuse the exact persisted `token` on every subsequent renewal. If initial `authorizeSpaceSync` refuses permanently (`SpaceDeleted` while `expires_at === 0` and `token` newly staged), delete the placeholder row; on transient failure, retain `token` and record failure backoff in `notification_registration_failure` (`failures`, `next_attempt_at`). On `authorizeSpaceSync` success, compute `ttlMs = Math.max(0, (payload.exp - payload.iat) * 1000)`, `renewWithinMs = ttlMs > 0 ? Math.min(3 * 60 * 1000, Math.floor(ttlMs * 0.3)) : 3 * 60 * 1000`, persist `expires_at = payload.exp * 1000` and **`renew_at = payload.exp * 1000 - renewWithinMs`**, and delete any `notification_registration_failure` row for `(service_ref, space_uri)`.
   - **`unregisterSpace`:** Delete `(service_ref, space_uri)` from `notification_registration` and `notification_registration_failure` (no PDS XRPC exists).
3. **`confirmRegistration` & `notifySpaceUpdate` Handlers (`apps/operator/src/operator/notices.ts`, `server.ts`):**
   - **Token-only authentication (NEVER reuse `isNotificationAccepted`'s `expires_at > now - 5 min` check!):** Both routes use `auth: undefined` (`server.ts`) and authenticate `(space, token)` strictly by constant-time `crypto.timingSafeEqual` match against stored `notification_registration.token` (regardless of `expires_at`, so `expires_at = 0` initial placeholder confirmations and late `#registrationExpired` callbacks arriving >5 min after lapse are BOTH accepted!) OR valid per-caller `dm1` HMAC. Empty, missing, or mismatched tokens return HTTP **400** (`InvalidRequestError`).
   - Exact `#` discriminants & parsing (`{ space, token, update }`): Validate `{ space, token, update }` at the outer envelope first (`token` is NOT inside `update`), then dispatch strictly on `update.$type` (replacing `parseWriteNotification`'s `ALLOWED_KEYS` whitelist):
     - **`com.atproto.space.defs#repoWrite`** (`{ repo, repoRev, spaceRev, prevSpaceRev?, data }`):
       - Check gap: if `update.prevSpaceRev !== undefined && lastSpaceRev !== null && update.prevSpaceRev !== lastSpaceRev`, `recordWriteNotification({ space, repo: update.repo, repoRev: update.repoRev })` already appends a `space_notification` wake row so `ChangeFollower` runs `listWritersSince`; advance `last_space_rev = update.spaceRev`.
     - **`com.atproto.space.defs#repoRemoved`** (`{ repo, spaceRev, prevSpaceRev? }`):
       - Update `last_space_rev = update.spaceRev` and emit a synthetic wake row in `space_notification` (`recordSpaceWake(space, update.repo, "")` or empty `repo`) so active `ChangeFollower` clients immediately reconcile `listWritersSince` and drop the removed writer without treating missing records as errors.
     - **`com.atproto.space.notifySpaceUpdate#registrationExpired`** (`{ spaceRev }`):
       - For operator spaces: reconcile `last_space_rev`, mark `renew_at = 0` (leaving `expires_at` / `token` intact), emit a wake row (`recordSpaceWake`) so any event dropped during the lapse is caught via `listWritersSince`, and trigger immediate async `renewSpaceRegistration(space)` (serialized with per-space lock); return `200 {}`.
       - For DM tokens (`dm1.*`): return HTTP **400** (`InvalidRequestError`), triggering PDS `abandonSyncerNotice` (`space-notifications.ts:332`) so closed browser tabs drop PDS registrations instead of churning retries for 72h.
     - **`com.atproto.space.notifySpaceUpdate#spaceDeleted`** (`{}`):
       - Never purge on webhook alone (`prompt-11-12-26.md`, M9). For operator spaces, always confirm by calling `authorizeSpaceSync` through the workspace's restored authority grant; ONLY when `authorizeSpaceSync` returns `SpaceDeleted` do `purgeSpaceNotifications(space)`, `dropMemberList(space)`, and delete `notification_registration` / `notification_registration_failure`. If authority grant cannot be restored or host returns a transient error/`RepoTakendown`/`RepoDeactivated`, log and keep state intact. (`dm1.*` `#spaceDeleted` wakes any attached in-memory listeners cleanly and returns `200 {}`.)
   - **Accurate HTTP 400 PDS Semantics (`prompt-11-12-26.md`, M11):** Rejecting `confirmRegistration` returns `RegistrationNotConfirmed` synchronously; rejecting `#registrationExpired` (`400`) triggers `abandonSyncerNotice` and removes the PDS registration immediately; rejecting `#repoWrite` / `#repoRemoved` (`400`) is logged on PDS (`util.ts:443`) without immediately deleting an active registration (it lapses naturally at `exp`).
4. **Gap Detection & Startup Catch-Up (`H1`):**
   - `authorizeSpaceSync` returns `{ credential, spaceRev? }`. Whenever `authorizeSpaceSync` completes (initial registration, operator startup recovery, periodic renewal, `#registrationExpired` renewal) and `spaceRev` is present and differs from (`!==`) stored `last_space_rev` (including after downtime where events were missed), emit a `space_notification` wake (`recordSpaceWake`) so connected clients reconcile via `listWritersSince`, and persist `last_space_rev = spaceRev`. Note: `listWriters` retains >72h fallback (`M3`) so long outages recover completely.
5. **Lifetime-Aware Renewal & Fast SQL-First Sweep (`H2`):**
   - Persist `renew_at = exp * 1000 - min(3 * 60 * 1000, floor(ttlMs * 0.3))` per registration row (handles 10-min defaults as well as up to 1h credentials cleanly after restart without reading credentials first).
   - Shrink `FIRST_RETRY_MS` / `LONGEST_RETRY_MS` in `registrations.ts` from `30 min -> 60 min` down to **`15_000 ms -> 120_000 ms`** (`15 s -> 2 min`, capped well below `RENEW_WITHIN_MS`) so transient errors recover within the 10-min TTL.
   - Split sweeping cleanly:
     - **Fast renewal loop (`60 s` in `apps/operator/src/operator/main.ts`, `.unref()`, cleaned on shutdown):** Queries SQLite *first*:
       `SELECT r.* FROM notification_registration r LEFT JOIN notification_registration_failure f ON f.service_ref = r.service_ref AND f.space_uri = r.space_uri WHERE r.service_ref = ? AND (r.token = '' OR r.renew_at <= ?) AND COALESCE(f.next_attempt_at, 0) <= ?`
       Zero due rows = zero grant restores and zero PDS requests. Groups due rows by workspace authority, restores grant once per due authority, renews with bounded concurrency (e.g. `4`), wrapped in an in-process mutex + heartbeated renewable DB lease (extending lease while active so sweeps >60s never overlap).
     - **Discovery backfill sweep (`30 min`):** Retains full `sweepRegistrations` workspace discovery cadence (or workspace lifecycle triggers) to catch unseeded spaces without running `activeSpaces` across all workspaces every minute.

### `D12.3b` Stateless Per-Caller DM Notifications (`new.flock.operator.getDmNotifyTarget`, Credential PoP Auth, Non-Blocking Reads, Pre-R12 Session Compatibility)
1. **OAuth Scope Wiring & Pre-R12 Browser Session Compatibility (`H5`, Codex R2 #5):**
   - Add `OPERATOR_METHOD.getDmNotifyTarget = "new.flock.operator.getDmNotifyTarget"` to `packages/protocol/src/nsids.ts`, `packages/protocol/lexicons/new/flock/operator/getDmNotifyTarget.json`, and `packages/protocol/lexicons/new/flock/permissions/{member,workspaceAuthority}.json` (keep `DM_BROWSER_SCOPES` and `appGrantScopes` unchanged; `memberGrantScopes` automatically picks up `OPERATOR_METHODS` via `operatorMethodsScope`).
   - Because updating `memberGrantScopes` adds `new.flock.operator.getDmNotifyTarget` to the `rpc?lxm=...` token string, **`apps/web/src/browser/session.ts` (`restoreSession` + `missingScopes`) MUST explicitly tolerate a legacy pre-R12 grant whose `rpc` token covers the prior `OPERATOR_METHODS` set without `new.flock.operator.getDmNotifyTarget`** (recording a flag that optional push notify upgrade requires reconnect while still admitting the session!). Otherwise `restoreSession` returns `null` before clients can even reach polling fallback! Test this explicitly in `apps/web/src/browser/session.test.ts`.
   - Handle `ScopeMissingError` / `403` on `getDmNotifyTarget` non-destructively in `DmClient.watch` (fall back to un-notified polling without breaking DM reads).
2. **Access-Proven Per-Caller Stable DM Token (`B1(b)`, Codex R2 #1, Opus N5):**
   - **Access proof (`getDmNotifyTarget`):** Service auth (`callerDid`) + `authorizeDmSubscription(space, callerDid)` alone would permit any signed-in nonmember to obtain a wake token for a conversation half. Require `getDmNotifyTarget` to accept `{ space, credential, proof: { authorization, signatureInput, signature } }` where:
     - `credential` is a valid unexpired `SpaceCredential` JWT issued by the space authority (`iss === requireSpaceAuthority(space)`, `sub === space`, verified via `verifySpaceToken("credential", credential, { sub: space, getSigningKey })` with `@atproto/identity` key resolution + short TTL cache);
     - `proof` is a fresh RFC 9421 PoP created via `createSpaceSigHeaders({ authorization: "Atproto-Space-Credential " + credential, audience: operatorServiceRef, keypair })`, verified via `verifyCredentialSig(proofHeaders, payload.cnf.kid)` (checks `cnf.kid` key possession & audience `operatorServiceRef`) plus short-lived replay protection (reject stale `created` / cache `(jti, created)` window within `CLOCK_SKEW_SEC` / `60s`, or nonce).
   - Nonmembers and revoked callers cannot mint a valid `SpaceCredential` for `sub === space` (and cannot forge `cnf.kid` PoP), so `getDmNotifyTarget` rejects them (`403`).
   - **Stable per-caller token (zero rotation churn, `N5`):** Derive deterministic token per `(space, callerDid, keyVersion = dm1)` using HKDF-SHA256 from `AUTH_ENCRYPTION_KEY` (`"flock-dm-notify-v1"`):
     `dm1.<base64url(callerDid)>.<base64url(hmacSha256(dmNotifyKey, "dm1\0" + space + "\0" + callerDid))>`
     (length ~95 <= `512`). Because it is stable per `(space, callerDid)` rather than rotating every 20 minutes, renewals on `authorizeSpaceSync` reuse the same token cleanly without `confirmRegistration` round-trips or duplicate PDS registrations (`11-12` §4b).
   - **No DM storage (`db-member-tables.test.ts`, Codex R2 #3):** Operator SQLite stores **zero** DM rows in `notification_registration`, `notification_registration_failure`, `authority_grant`, `member_list`, or `oauth_session`. Clarify accurately that **all** DM write/wake feeds flow through a process-local in-memory DM wake emitter + monotonic sequence cursor combined/merged cleanly in `apps/operator/src/operator/feed.ts` — **OR** wait: check whether existing `notices.test.ts:112` tests `'new.flock.dm.inbox'` inside `space_notification`! Keep DM notification delivery strictly **non-persisted in SQLite** ONLY if `getChanges` still reconciles restarts (`getChanges` answers `{ head, reset: [...] }` on cursor mismatch or operator restart cleanly!) OR verify zero `space_notification` DM writes: specifically, handle DM `notifySpaceUpdate` (`#repoWrite`/`#repoRemoved`/`#spaceDeleted`) via an in-memory bounded ring/head tracker (`dm-feed-wakes.ts`, reset/signaling `reset: [space]` on operator restart so `ChangeFollower` always resyncs once on restart!) — guaranteeing literally **zero DM rows in ANY operator SQLite table** (`space_notification`, `notification_registration`, etc.) while keeping existing `notices.test.ts` workspace/channel coverage clean! Test BOTH: `0` DM rows in any SQLite table after DM webhook delivery + clean `reset` after operator restart!
3. **Non-Blocking `DmClient.watch` (`H5`):**
   - `DmClient.watch(spaces, opts?: { signal?: AbortSignal })` obtains/uses cached `SpaceCredential` (+ `keypair`) to fetch `{ endpoint, token }` from `getDmNotifyTarget`, then passes `notify` to `authorizeSpaceSync`.
   - **Never couple DM reads to operator availability:** Wrap `getDmNotifyTarget(space)` in `try/catch` AND catch `RegistrationNotConfirmed` on `authorizeSpaceSync(..., { notify })`: if webhook registration fails (`RegistrationNotConfirmed`, timeout, offline operator, `ScopeMissingError`, SSRF block), **immediately retry/mint `authorizeSpaceSync` WITHOUT `notify`** so `readConversation` / `listRequests` / `CredentialCache` **never fail**, and retry webhook registration in the background with backoff.
   - Maintain a periodic renewal loop inside `DmClient.watch` before cached `exp` (honoring `opts?.signal` / `.unref()`), reusing the same stable `(endpoint, token)` and bound to `AbortController` in `apps/web/src/app/ui/{dm-context,dm-conversation}.tsx`.

### `D12.3c` Cross-Wave `authorizeSpaceSync` Protocol Contract (`N4`, `packages/protocol` -> `packages/client` & `apps/operator`)
Owned by `r12-protocol` (`packages/protocol/src/atproto/space-credential-core.ts`) and consumed by `r12-operator`, `r12-reader`, and `r12-client`:
1. **Endpoint & Request/Response:** `AUTHORIZE_SPACE_SYNC = "/xrpc/com.atproto.space.authorizeSpaceSync"` (replaces `GET_SPACE_CREDENTIAL`).
   - `exchangeSpaceCredential(pdsClient, { space, credentialKey, delegationToken, clientAttestation?, notify? })` (field is **`credentialKey`**, NOT `credentialKid`) POSTs JSON and returns **`Promise<{ credential: string; spaceRev?: string }>`**.
   - `mintSpaceCredentialWith(deps, space, opts?: { notify?: SpaceNotifyTarget })` returns `SpaceCredential` exposing `{ token: string; keypair: Keypair; space: string; exp: number; spaceRev?: string; notify?: SpaceNotifyTarget; client(...) }`.
2. **`CREDENTIAL_REFUSALS` & Non-Refusal Errors:**
   - Update `CREDENTIAL_REFUSALS` (`SpaceCredentialError`): replace `"UserNotAuthorized"` with **`"AccountNotAuthorized"`** (keeping `"SpaceNotFound"`, `"SpaceDeleted"`, `"NotAuthorized"`, `"InvalidDelegationToken"`, `"InvalidClientAttestation"`, etc.).
   - Keep **`"RegistrationNotConfirmed"`, `"RepoTakendown"`, `"RepoDeactivated"`** OUT of `CREDENTIAL_REFUSALS` (thrown as non-refusal `XrpcError` / `XrpcFailure`, keeping `isAccessLost(err) === false` so DM fallback catches `RegistrationNotConfirmed` cleanly and host suspensions remain non-destructive).
3. **`CredentialCache` & Operator Credential Wrapper:**
   - `CredentialCache.get(space, opts?: { notify?: SpaceNotifyTarget })` (`packages/client/src/credentials.ts`): re-mints if cached entry exists *without* `notify` when `opts?.notify` is provided or if `notify` differs (`endpoint`/`token` changed); subsequent renewals retain the entry's `notify` (with `RegistrationNotConfirmed` fallback stripping `notify`).
   - `apps/operator/src/atproto/space-credential.ts`: expose `{ ..., spaceRev?: string }` and `notify?: SpaceNotifyTarget` passthrough cleanly from `mintSpaceCredential` so `registrations.ts` reads `spaceRev` & passes `notify` without duplicating core logic.

### `D12.4` HTTP Message Signature Credential Binding & RFC 9421 MACs (`@atproto/space`)
1. **Outbound Request Binding (`createSpaceSigHeaders`, `verifyCredentialSig`):**
   - `createSpaceSigHeaders({ authorization, audience: hostDid, keypair })` returns `{ headers }` (signs `'sig'` label; replaces old 2-arg `(opts, keypair)`).
   - `verifyCredentialSig(headers, keyDid)` enforces `tag="atproto-space-credential"`.
2. **Exact RFC 9421 Commit & Record MAC APIs (`mac.ts`, `kem.ts`, `repo-commit.ts`, `error.ts`):**
   - **Client request:** Generate an **ephemeral** keyshare per request using `encapsulate(authorKemKey)` (`{ keyShare, sharedSecret }`), and send `Accept-Signature: ${formatMacRequest(profile, keyShare)}` (`COMMIT_MAC_PROFILE = "atproto-space-commit"`, `RECORD_MAC_PROFILE = "atproto-space-record"`). (Do NOT pass `macKeyPair.did()`!)
   - **Server response:** Parse `const macReq = parseMacRequest(headers["accept-signature"], profile)`, compute `sharedSecret = decapsulate(kemKeypair, macReq.keyShare)`, call `createCommitMacHeaders(commit, { ...macReq, sharedSecret })` or `createRecordMacHeaders(uri, cid, { ...macReq, sharedSecret })`, returning `{ headers }` (`Atproto-Space-Commit` / `Atproto-Space-Record`, `Signature-Input`, `Signature`).
   - **Verification (now throwing):** `verifyCommitMac(commit, { keyShare, sharedSecret, headers })`, `verifyRecordMac(uri, cid, { keyShare, sharedSecret, headers })`, `verifyCommit(commit, { space, repo, keyShare, sharedSecret, headers })`, and `verifyRecord(record, { uri, keyShare, sharedSecret, headers })` all **throw** (`SpaceMacError` with `code = "InvalidSpaceMac"` or `SpaceRepoVerificationError` with `code = "InvalidSpaceRepo"`) instead of returning `boolean` (`verifyCommit` and `verifyRecord` invoke MAC verification internally, so all `VerifyMacParams` fields MUST be passed).
   - **HPKE `info: "atproto-mac"`, `SpaceKemError`, & type renames:** `kem.ts` applies `info: "atproto-mac"` inside `encapsulate`/`decapsulate`. Invalid KEM keys throw `SpaceKemError` — include `SpaceKemError` in `isUnverifiableRepo` (`packages/protocol/src/atproto/kem-key.ts:48`) and error mappers alongside `SpaceRepoVerificationError` & `SpaceMacError`. Update `fetchVerifiedRepoStar`'s retry check (`sync.ts`) from `error.message === "commit failed verification"` to `instanceof SpaceMacError`. Rename `Commit` -> `SpaceCommit` and adopt branded `@atproto/syntax` strings (`DidString`, `SpaceRefString`, `TidString`).
   - **CORS Headers (`FakeNetwork` & browser tests):** Expose `atproto-space-commit`, `atproto-space-record`, `signature-input`, `signature` in `Access-Control-Expose-Headers` and `Accept-Signature` in `Vary` + allowed headers (`protocol-tests/browser/dm.spec.ts:167` updated accordingly).

### `D12.5` STAR Framing (`@atproto/star`), `getRepo`, & Size Accounting
1. Update imports & constants in `packages/protocol/src/atproto/space-credential-core.ts` & `packages/reader`:
   - `serializeRepo` -> `writeRepoStar(commit, entries)` (`@atproto/space`).
   - `RepoVerificationError` -> `SpaceRepoVerificationError` (`@atproto/space`).
   - `StarParseError` imported from `@atproto/star` (added as direct dep of `@flock/{protocol,reader,testing}`).
   - `LTHASH_STATE_BYTES` removed from `@atproto/space` exports; derive `export const LTHASH_STATE_BYTES = new LtHash().state().byteLength` (`2048`).
   - Send `Accept: application/vnd.dasl.star` on `com.atproto.space.getRepo`; accept `application/vnd.dasl.star`.
2. **Exact `starEntryBytes` Formula (No CID):**
   - `@atproto/star/src/star.ts` encodes each record entry as `0x01` (`CONTROL_PAIR`) + unsigned varint(keyBytes.length) + keyBytes (UTF-8 `${collection}/${rkey}`) + unsigned varint(valBytes.length) + valBytes, and appends trailing `0x00` (`CONTROL_END`). There is **no CID** in a STAR entry!
   - Since `await starHeaderBytes(commit)` calls `writeRepoStar(commit, [])` (collecting the `AsyncGenerator<Uint8Array>`, which includes the 4-byte `2a 6c 01 00` magic header and trailing `0x00` EOF byte), define:
     `starEntryBytes(keyBytesLen, valBytesLen) = 1 + varintByteLength(keyBytesLen) + keyBytesLen + varintByteLength(valBytesLen) + valBytesLen`.
   - Assert exact byte-for-byte parity `(await starHeaderBytes(commit)) + sum(starEntryBytes(...)) === collectedByteLength(writeRepoStar(commit, entries))` in `space-credential-core.test.ts` (collecting the `AsyncGenerator<Uint8Array>` returned by `writeRepoStar`).

### `D12.6` Writer Set (`listWriters`), 72h Fallback, Suspension vs Takedown Parity, & Management `401`s
1. **`listRepos` -> `listWriters` & Union Discrimination (`record-pages.ts`, `sync.ts`, `independent*.ts`, `dm-client.ts`, `apps/operator`, `FakeNetwork`):**
   - Upstream output keeps array property name **`repos`**, whose union items have `repo` (not `did`), `spaceRev`, and `$type`:
     - `com.atproto.space.defs#repoWrite`: `{ repo, repoRev, spaceRev, data }` (`rev` -> `repoRev`).
     - `com.atproto.space.defs#repoRemoved`: `{ repo, spaceRev }`.
   - Keep `page.repos.length < limit` pagination termination (`listWriters.ts` emits `cursor: writers.at(-1)?.spaceRev` on every non-empty page).
   - **Full listing (`listBoundedWriters` without cursor, M3):** Must apply **latest-entry-wins per DID across all pages** — if a `#repoWrite` appears on page 1 and a `#repoRemoved` appears on page 2 for the same `repo`, delete that `repo` from the active writer map! Removed entries MUST NOT count toward `maxRepos` or `truncated`.
   - **Incremental `listWritersSince` (`M3`):** Keep `WriterUpdate = { kind: "write", repo, repoRev, spaceRev, data } | { kind: "removed", repo, spaceRev }`. Evict cached writer rows/cursor state when `#repoRemoved` arrives (without calling `getRepo`/`listRepoOps`). If the stored `spaceRev` checkpoint is **older than 72 hours** (per upstream cursor doc: removed entries may be GC'd after 72h) or yields `InvalidCursor`, **fall back to full `listBoundedWriters` reconciliation** so D14 writer removals are never missed.
2. **Per-Writer Takedown vs Authority Suspension vs Authority-as-Writer & Management 401 (`H3`, `N3`):**
   - **DO NOT weaken per-writer takedowns in `packages/protocol/src/atproto/repo-failure.ts`!** On repo reads (`listRepoOps`, `getRepo`, `getRecord`, `listRecords`, `getLatestCommit`), `RepoTakendown` / `RepoDeactivated` (`ACCOUNT_STATE`) describe a non-authority writer's account and MUST remain `permanent: true` so taken-down members' data is evicted/set aside (`SyncCore`). Keep explicit test coverage asserting a taken-down non-authority *writer* stays set aside.
   - **Authority-as-writer case (`N3`):** The space authority is also a writer in its own space (`directory`, `roster`, `admin` records), and existing credentials stay valid up to `exp` (`11-5` §2a). While the authority is suspended, repo reads on `repo === requireSpaceAuthority(space)` return `400 RepoTakendown` / `RepoDeactivated` even without hitting `authorizeSpaceSync` first! Therefore, both `SyncCore` and `packages/reader` MUST special-case `repo === requireSpaceAuthority(space)` so `RepoTakendown` / `RepoDeactivated` on the authority's own repo classifies as **transient suspension** (preserving local authority records until recovery!), while `repo !== authorityDid` keeps `permanent: true`. Test BOTH cases.
   - **Space authority endpoints (`authorizeSpaceSync`, `listWriters`):** Confirm `400 RepoTakendown` / `RepoDeactivated` from `assertActiveSpaceHost` maps to non-destructive host-unavailable errors (`XrpcFailure`, NOT `SpaceCredentialError`, NOT `isAccessLost`), keeping local synced data intact until recovery.
   - **Management `401` (`AccountTakedown` / `AccountDeactivated` from `authVerifier.authorization`):** Update `apps/operator` (`registrations.ts`, `journal.ts`, `member-access.ts`, `methods.ts`) so `401 AccountTakedown` / `AccountDeactivated` on `createSpace`, `updateSpace`, `deleteSpace`, `removeWriter`, `putMembers`, `removeMembers` is treated as account suspension (non-retried operation failure / registration backoff; NEVER deletes/revokes the encrypted `authority_grant` row and NEVER storms retries).

### `D12.7` `listRepoOps` Every-Page `commit` + `RepoNotFound` Simplification (`#5877`, `L2`)
1. Upstream `listRepoOps` now returns signed/MAC'd `commit` on **every** page (intermediate & final) and returns `400 RepoNotFound` for never-written repos (`listRepoOps#opEntry.rev` remains **`rev`**, NOT `repoRev`!).
2. Remove all three old unsigned-empty / intermediate-page workarounds cleanly:
   - Delete `UnsignedEmptyRepoOpsError` in `packages/client/src/sync.ts`.
   - Remove the `macVerifies` unsigned-empty bypass in `packages/protocol/src/atproto/space-credential-core.ts` (`fetchWithVerifiedMac` always requires and verifies the commit + MAC on every `listRepoOps` page).
   - Remove the intermediate-page `commit` + `cursor` rejection check in `fetchRepoOpsPages` (`packages/client/src/sync.ts`): verify every page's commit/MAC, collect ops across all pages, and reconcile head `(rev, data, root)` from the final page (`cursor === undefined`).
   - Preserve `XrpcFailure` (`RepoNotFound`) out of `fetchRepoOpsPages` so `SyncCore` & `packages/reader` apply `classifyRepoNotFoundOrFailure` (`empty` when unlisted & `prevRev === null`, `setAside` when previously listed).

### `D12.8` Batch Membership (`putMembers` / `removeMembers`), Field & Error Renames
1. **Batch Membership (`apps/operator/src/atproto/space-ops.ts`, `operator/members.ts`, `packages/client/src/dm/dm-client.ts`, `FakeAuthorityPds`):**
   - Replace `putMember` / `removeMember` with `putMembers` (`{ space, members }`) and `removeMembers` (`{ space, dids }`), chunking arrays to `<= 100` entries per call (`maxLength: 100`).
   - Preserve step-level idempotency in `apps/operator/src/operator/kinds/` and NEVER rename Flock's persisted `OperationRequest.kind = "removeMember"` (`execute.json` / `kinds.test.ts`).
   - Do **not** require `$type: "com.atproto.memberspace.defs#member"` on inbound `listMembers` items (upstream `listMembers.ts` omits `$type` on rows; outbound `putMembers` objects keep explicit `{ did, read, write }`).
2. **DM Inbox `publicWrite` vs Dormant Members (`H6`):**
   - Upstream `space-policy/manager.ts:287` excludes explicit members with `write: false` even when `policy.publicWrite === true`.
   - In `packages/client/src/dm/dm-client.ts` (`setRequestMode` / `applyRequestMode`), switching to `"everyone"` (`publicWrite: true`) MUST ALSO reactivate dormant (`write: false`, `read: false`) allowlist entries to `{ read: false, write: true }` via batched `putMembers` (while preserving dormant `{ read: false, write: false }` semantics in `"nobody"` mode). Add an explicit `nobody -> everyone -> request from previously-dormant contact` acceptance test in `protocol-tests/dm-acceptance.test.ts`.
3. **Field, Param, Error & Lexicon Renames:**
   - `createSpace` / `getSpace`: output `uri` -> `space`.
   - `listSpaces`: param `did` -> `spaceDid`, output `view.uri` -> `view.space` (optional `repoRev`, `data`, `spaceRev`).
   - `removeWriter`: input `did` -> `repo`.
   - `listRecords`: drop `reverse` parameter (server default `uri desc`).
   - Errors: `NotSpaceOwner` -> `NotAuthorized`, `UserNotAuthorized` -> `AccountNotAuthorized`, `BadSpaceMac` -> `InvalidSpaceMac`, `MalformedCursor` -> `InvalidCursor`.

### `D12.9` App-Password `ACCESS_FULL` Scope Enforcement (`#5923`, Codex #8, Opus M4)
1. Upstream enforces `ACCESS_FULL` (`InvalidToken: Bad token scope`) on account-authenticated PDS space/memberspace endpoints (`createRecord`, `putRecord`, `deleteRecord`, `applyWrites`, `clearRecords`, `createSpace`, `getSpace`, `listSpaces`, `updateSpace`, `deleteSpace`, `getDelegationToken`, `listRecords`, `listRepoOps`, `getRepo`, `getRecord`, `getLatestCommit`, `removeWriter`, `putMembers`, `removeMembers`, `listMembers`, `getBlob`, `listBlobs`, `exportSpaceMeta`, `importSpaceMeta`, `importRepo`).
2. Note endpoint nuance: `authorizeSpaceSync` has **no** OAuth session auth verifier (body `delegationToken` only), `listWriters` uses `spaceCredentialAuth` only, and `com.atproto.server.getServiceAuth` stays usable by app passwords.
3. Mirror these exact per-endpoint auth checks in `FakeNetwork` (`packages/testing/src/fake-network.ts`, no blanket session check on `authorizeSpaceSync`/`listWriters`!) and update `protocol-tests/platform-capabilities.test.ts` (K7 test) to assert app passwords are rejected with `InvalidToken: Bad token scope` on both `createRecord` and `getDelegationToken` while `getServiceAuth` still succeeds.

### `D12.10` Full Upstream Lexicon Sync & Flock Space `"name"` -> `"title"`
1. Rename `"name"` -> `"title"` in all 7 space lexicons under `packages/protocol/lexicons/new/flock/`: `workspace.json`, `channel.json`, `inbox.json`, `app/inbox.json`, `ext/tasks.json`, `dm/inbox.json`, `dm/conversation.json`. (Document in `D12`/`docs` that production OAuth consent deployments must republish updated Flock space lexicons (`L8`). Do NOT alter Flock record/UI fields like `workspace.name`, `channel.name`.)
2. Sync **all four** upstream lexicon directories into `packages/protocol/lexicons/com/atproto/` (`space/`, `memberspace/`, `managedspace/`, `personalspace/`) from `../atproto-spaces-r12/lexicons/com/atproto/`:
   - `space/`: remove 7 (`getSpaceCredential`, `listRepos`, `notifyCredentialRevoked`, `notifySpaceDeleted`, `notifyWrite`, `registerNotify`, `unregisterNotify`); add 6 (`authorizeSpaceSync`, `confirmRegistration`, `listWriters`, `notifyCredentialsRevoked`, `notifyRepoUpdate`, `notifySpaceUpdate`); update remaining files.
   - `memberspace/`: remove `putMember`, `removeMember`; add `defs`, `putMembers`, `removeMembers`; update `listMembers`, `member`, `policy`.
   - `managedspace/`: remove `checkUserAccess`; add `checkAccess`; update `policy`. Also update `FakeNetwork` if `managedspace`/`personalspace` ("authority and authorized apps") policy rules apply.
   - `personalspace/`: update `policy`.
3. Add `packages/protocol/lexicons/new/flock/operator/getDmNotifyTarget.json` and update `packages/protocol/lexicons/new/flock/permissions/{member,workspaceAuthority}.json`.
4. Run `ATPROTO_PIN_CHECKOUT=../atproto-spaces-r12 pnpm codegen:lex` cleanly.

### `D12.11` Package & Reader Dependency Boundaries (`H4`)
1. `@flock/reader` **explicitly depends on `@flock/protocol`** (`packages/reader/package.json` `"@flock/protocol": "workspace:*"`, per `eslint.config.mjs`: "the reader only the protocol") and MUST NEVER import `@flock/client`, `@flock/operator`, or UI. `@flock/reader` consumes R12b `@flock/protocol` primitives while keeping its own minimal reconstruction & merge paths (`independent.ts`, `independent-dm.ts`, `independent-tasks.ts`) independent of `@flock/client`.
2. Add `@atproto/star: "0.0.0-spaces-alpha-20261117141222"` directly to `packages/reader/package.json` (`StarParseError` in `independent-tasks.ts`) so `eslint` `import/no-extraneous-dependencies` passes.
3. Preserve `pnpm typecheck`'s `@types/node`-free guarantees for `packages/protocol` & `packages/client` and ESLint `no-restricted-imports` entity-merge / extension boundary rules.

### `D12.12` Acceptance Criteria & 6 Sequential Verification Gates
Every gate runs **after** the final edit against built `../atproto-spaces-r12` (`ATPROTO_PINNED_CHECKOUT=/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12`):
1. **Gate 1 — Static & Unit/Component:** `ATPROTO_PIN_CHECKOUT=../atproto-spaces-r12 pnpm codegen:lex && pnpm typecheck && pnpm lint && pnpm test` (`908+` tests, `0` failed, `0` skipped).
2. **Gate 2 — Protocol Acceptance (`ATPROTO_PINNED_CHECKOUT=../atproto-spaces-r12 pnpm test:acceptance`):** All 13 suites green.
3. **Gate 3 — Browser Playwright (`ATPROTO_PINNED_CHECKOUT=../atproto-spaces-r12 pnpm test:browser`):** All 8 specs green (`dm.spec.ts` RFC 9421 MAC assertions).
4. **Gate 4 — Upstream `@atproto/space` + Real PDS Conformance (`L6`, `N7`, Codex R2 #6):**
   - `pnpm -C ../atproto-spaces-r12 --filter @atproto/space test` (with rebased strict expiry patch applied).
   - Temporarily copy `protocol-tests/atproto/slack-{inbox,dm,authority-oauth}-conformance.test.ts` (and `platform-spike-k{2,5}*.test.ts` if maintained) into `../atproto-spaces-r12/packages/pds/tests/space/`, run `NODE_OPTIONS=--experimental-vm-modules pnpm -C ../atproto-spaces-r12 --filter @atproto/pds exec jest --runInBand tests/space/`, verify 100% pass, and remove temporary copies from `../atproto-spaces-r12` so `../atproto-spaces-r12` remains clean apart from the pinned patch.
5. **Gate 5 — BDD (`ATPROTO_PINNED_CHECKOUT=../atproto-spaces-r12 pnpm test:bdd`):** All scenarios green (`listWriters` wording, `NotAuthorized`, `putMembers`/`removeMembers`, `.space`).
6. **Gate 6 — Performance & Sync Budgets (`ATPROTO_PINNED_CHECKOUT=../atproto-spaces-r12`):** `pnpm test:sync-budget`, `pnpm test:sync-budget:browser`, `pnpm test:performance`.
7. **Independent Adversarial Reviews:** Fresh read-only Claude Opus + Codex passes over the full diff against `origin/main` (`f4a4c16`) before final PR creation.

---

## Parallel Execution Waves & Disjoint File Ownership

### Wave `R12a` — Pin, Patch Rebase, Upstream Build, Dependencies & Lexicons (Single Worker: `r12-pin-lex`)
- **Upstream `../atproto-spaces-r12` & `protocol-tests/atproto/strict-credential-expiry.patch`:**
  - Rebase `protocol-tests/atproto/strict-credential-expiry.patch` onto `674761056` (`credential.ts` + `src/credential.test.ts`), apply it inside `../atproto-spaces-r12`, install deps + build `build:tooling` & `@atproto/dev-env` graph (`D12.1.2`, Node 22 ABI 127, `PUPPETEER_SKIP_DOWNLOAD=true`), run `pnpm -C ../atproto-spaces-r12 --filter @atproto/space test`, and update `docs/protocol/atproto-spaces-pin.md` (with `674761056`, patch SHA-256, build recipe, and HTTPS notify requirement `L7`).
- **Workspace packages & lockfile (`../atproto-slack-clone-r12`):**
  - Update `package.json`, `packages/{protocol,reader,client,testing}/package.json`, `apps/{operator,web}/package.json`, and `pnpm-workspace.yaml` per `D12.1` (`0.0.0-spaces-alpha-20261117141222`, `@atproto/star`, re-pinned `overrides`, complete `minimumReleaseAgeExclude`). Run `pnpm install --no-frozen-lockfile` and audit `pnpm-lock.yaml` (0 stale alpha hashes, 0 duplicate versions).
- **Lexicons & Codegen:**
  - Sync `packages/protocol/lexicons/com/atproto/{space,memberspace,managedspace,personalspace}/*.json` from `../atproto-spaces-r12/lexicons/com/atproto/` (deleting removed JSONs).
  - Rename `"name"` -> `"title"` in the 7 `packages/protocol/lexicons/new/flock/*.json` space definitions.
  - Add `packages/protocol/lexicons/new/flock/operator/getDmNotifyTarget.json` (`{ space, credential, proof: { authorization, signatureInput, signature } }` -> `{ endpoint, token }`) and update `packages/protocol/lexicons/new/flock/permissions/{member,workspaceAuthority}.json`.
  - Update `scripts/codegen-lex.mjs` (`expectedCommit`, clean checkout env handling) and `protocol-tests/support/app-fixture.ts:51` (`../atproto-spaces-r12` fallback). Run `ATPROTO_PIN_CHECKOUT=../atproto-spaces-r12 pnpm codegen:lex`.

### Wave `R12b` — `@flock/protocol` & `@flock/testing` FakeNetwork (2 Disjoint Workers; `space-credential-core.test.ts` finalized after both land)
- **Worker `r12-protocol`** (owns ONLY `packages/protocol/src/**/*.ts` AND `packages/testing/src/space-credential-core.test.ts`, sequenced/aligned with `r12-fakenetwork` wire contract per `N8`):
  - `nsids.ts`, `scopes.ts`, `scopes.test.ts`, `scope-lexicons.test.ts`.
  - `atproto/space-credential-core.ts` (implementing full `D12.3c` `exchangeSpaceCredential`, `mintSpaceCredentialWith`, `CREDENTIAL_REFUSALS` without `RegistrationNotConfirmed`/`RepoTakendown`/`RepoDeactivated`), `atproto/kem-key.ts` (`SpaceKemError`), `atproto/repo-failure.ts` (keep per-writer `ACCOUNT_STATE` permanent!), `atproto/record-pages.ts`, `atproto/record-pages.test.ts`, `atproto/xrpc.ts`, `atproto/xrpc.test.ts`, `registry.ts`, `registry.test.ts`.
  - `packages/testing/src/space-credential-core.test.ts` (finalized & verified once `r12-fakenetwork` lands: RFC 9421 headers, throwing MAC/commit/record verifiers with full `VerifyMacParams`, `SpaceKemError` / `SpaceMacError` / `SpaceRepoVerificationError`, `starEntryBytes` exact byte parity with collected `writeRepoStar`, removal of unsigned-empty special cases).
- **Worker `r12-fakenetwork`** (owns ONLY `packages/testing/src/fake-network.ts` and `packages/testing/src/fake-network.test.ts`):
  - Mirror `#5187` accurately: `authorizeSpaceSync` (no session auth; `notify` + sync `confirmRegistration` + `notifySpaceUpdate` `#repoWrite`/`#repoRemoved`/`#registrationExpired`/`#spaceDeleted` + `exp` expiry + `400` expiry-notice abandonment + `Util` logging on write rejection), `listWriters` (`spaceCredentialAuth`, `#repoWrite`/`#repoRemoved` union with `spaceRev`, `RepoTakendown`/`RepoDeactivated` host check), `putMembers`/`removeMembers` (`<=100`), `getRepo` `application/vnd.dasl.star`, `listRepoOps` every-page commit+MAC & `RepoNotFound`, RFC 9421 MACs + CORS headers, `ACCESS_FULL` app-password refusal strictly on account-authenticated routes, `managedspace.checkAccess` / `personalspace` policy updates, `createSpace`/`getSpace`/`listSpaces` renames & error renames.
- **Wave `R12b` Exit Gate:**
  `node --import tsx --test 'packages/protocol/src/**/*.test.ts' 'packages/testing/src/**/*.test.ts' && tsc -p packages/protocol --noEmit && ! tsc -p packages/protocol --listFilesOnly | grep -q /@types/node/`

### Wave `R12c` — `apps/operator` & `@flock/reader` (2 Disjoint Workers)
- **Worker `r12-operator`** (owns ONLY `apps/operator/src/**/*.ts` and `apps/operator/scripts/**/*.ts`):
  - `lib/db.ts`, `lib/db-migration.test.ts`, `lib/db-member-tables.test.ts` (`notification_registration` columns `token`, `renew_at`, `last_space_rev`, reset `expires_at = 0, renew_at = 0` when `token = ''`; zero DM tables/rows across all SQLite tables).
  - `registrations.ts`, `main.ts`, `registrations.test.ts`, `atproto/space-credential.ts` (stable 1-token reuse, `15s -> 2min` backoff in `notification_registration_failure`, `renew_at` persistence, 60s SQL-first `LEFT JOIN` sweeper with mutex + heartbeated DB lease + 30-min backfill, `authorizeSpaceSync.spaceRev` gap catch-up).
  - `notices.ts`, `space-notification.ts`, `dm-feed-wakes.ts` (new, ephemeral in-memory DM wake ring/cursor merged into `feed.ts` with restart `reset`), `server.ts`, `methods.ts`, `security.ts`, `atproto/write-notification.ts`, and tests (`confirmRegistration` & `notifySpaceUpdate` **token-only** auth without 5-min expiry gate, outer `{ space, token, update }` + `$type` dispatch, authority `authorizeSpaceSync` confirmation before `#spaceDeleted` purge, `getDmNotifyTarget` cryptographic `SpaceCredential` + `verifyCredentialSig` PoP check + stable per-caller `dm1` HMAC + replay guard, `400` on DM `#registrationExpired`).
  - `atproto/space-ops.ts`, `operator/members.ts`, `operator/member-access.ts`, `operator/journal.ts`, `operator/testing/fake-authority-pds.ts`, `operator/kinds/*.ts`, and tests (batched `putMembers`/`removeMembers`, renames, `401 AccountTakedown`/`AccountDeactivated` graceful handling without revoking authority grants, preserving Flock `kind = "removeMember"`).
- **Worker `r12-reader`** (owns ONLY `packages/reader/src/**/*.ts`):
  - `independent.ts`, `independent-dm.ts`, `independent-dm.test.ts`, `independent-tasks.ts`, `independent-tasks.test.ts`: adopt R12b `@flock/protocol` primitives + `@atproto/star` `StarParseError`, `listWriters` (`#repoWrite`/`#repoRemoved` + 72h fallback + `RepoTakendown`/`RepoDeactivated` non-destructive host & `repo === authority` transient handling), throwing `verifyCommit`/`verifyRecord`/MAC checks (`VerifyMacParams` passed in full), every-page `listRepoOps` + `RepoNotFound`.
- **Wave `R12c` Exit Gate:**
  `node --import tsx --test 'apps/operator/src/**/*.test.ts' 'packages/reader/src/**/*.test.ts'`

### Wave `R12d` — `@flock/client` & `apps/web` (2 Disjoint Workers)
- **Worker `r12-client`** (owns ONLY `packages/client/src/**/*.ts`):
  - `credentials.ts`, `sync.ts`: `CredentialCache.get(space, { notify })` per `D12.3c`, remove `UnsignedEmptyRepoOpsError` & intermediate `commit`+`cursor` refusal, verify every `listRepoOps` page, `listWriters` `#repoWrite`/`#repoRemoved` + 72h full fallback, `SpaceMacError`/`SpaceKemError`/`SpaceRepoVerificationError` mapping, non-destructive authority suspension (`authorizeSpaceSync`/`listWriters` AND `repo === authorityDid` per `N3`) vs permanent per-writer takedown (`repo !== authorityDid`).
  - `operator-client.ts`, `dm/dm-client.ts`, `dm/ui-logic.ts`: `getDmNotifyTarget({ space, credential, proof })`, resilient non-blocking `DmClient.watch` (immediate `authorizeSpaceSync` fallback without `notify` on `getDmNotifyTarget` / `RegistrationNotConfirmed` / `ScopeMissingError`, background backoff retry, `AbortSignal` renewal loop reusing stable token), batched `putMembers`/`removeMembers`, `setRequestMode("everyone")` reactivating dormant allowlist members (`H6`).
  - `workspace-client.ts`, `feed.ts`, `accept-errors.ts`, `store.ts`, `testing/*`, and all `packages/client/src/**/*.test.ts`.
- **Worker `r12-web`** (owns ONLY `apps/web/src/**/*.ts`, `apps/web/src/**/*.tsx`, plus `apps/{echo-bot,webhooks}` only if unused/impacted check finds hits):
  - `apps/web/src/browser/session.ts` & `session.test.ts`: tolerate legacy pre-R12 sessions lacking `new.flock.operator.getDmNotifyTarget` in `missingScopes` / `restoreSession` so users are not logged out before hitting polling fallback (flag reconnect prompt cleanly).
  - `apps/web/src/app/ui/{dm-context,dm-conversation}.tsx`: wire `getDmNotifyTarget`, pass `AbortController.signal` into `client.watch`, degrade cleanly when `getDmNotifyTarget` / push registration is unavailable.
- **Wave `R12d` Exit Gate:**
  `pnpm typecheck && pnpm lint && pnpm test && pnpm build`

### Wave `R12e` — Protocol Tests, Conformance, Acceptance, Performance & BDD Suites (2 Disjoint Workers)
- **Worker `r12-protocol-tests`** (owns ONLY `protocol-tests/**/*.ts` and `protocol-tests/atproto/README.md`):
  - `protocol-tests/support/{pds-network,sync-dataset}.ts`, `protocol-tests/recover-pending-operation.ts`.
  - `protocol-tests/atproto/{README.md,slack-inbox-conformance.test.ts,slack-dm-conformance.test.ts,slack-authority-oauth-conformance.test.ts,platform-spike-k2-confidential-client.test.ts,platform-spike-k5-oplog.test.ts}` (updated for `674761056`).
  - `protocol-tests/app-acceptance.test.ts` (rewrite deleted-space webhook test around real `notifySpaceUpdate` `#spaceDeleted` + authority `authorizeSpaceSync` confirmation; `listWriters` + `putMembers`/`removeMembers`).
  - `protocol-tests/platform-capabilities.test.ts` (`#5923`: `createRecord` + `getDelegationToken` refused with `Bad token scope`; `getServiceAuth` allowed).
  - `protocol-tests/dm-acceptance.test.ts` (add `nobody -> everyone -> request from dormant contact` acceptance test `H6`).
  - `protocol-tests/browser/dm.spec.ts:167` (assert `atproto-space-commit`/`atproto-space-record`/`signature-input`/`signature` + `Vary: Accept-Signature`).
  - Remaining acceptance/browser/perf/budget tests (`verified-sync`, `app-inboxes`, `apps`, `extensions-operator`, `tasks-acceptance`, `tasks-performance`, `dm-performance`, `performance-envelope`, `sync-budget`, `browser/{cross-origin,real-client,sync-budget}*`).
- **Worker `r12-bdd`** (owns ONLY `features/**/*.feature` and `bdd/**/*.ts`):
  - `features/{independent-app-and-launch,private-channel-requests}.feature`.
  - `bdd/steps/*.steps.ts` and `bdd/support/*.ts` (`listWriters`, `putMembers`/`removeMembers`, `.space`, `NotAuthorized`).
- **Wave `R12e` Exit Gate:**
  `pnpm typecheck && pnpm lint && pnpm test`

### Wave `R12f` — Documentation Sync, Regression Suites, 6-Gate Run & Adversarial Code Reviews
1. Update remaining docs (`SPEC.md`, `ARCHITECTURE.md`, `CODE-MAP.md`, `docs/prd/{atproto-slack-clone,atproto-slack-implementation-plan}.md`, `docs/operations.md`, `docs/protocol/operator-contract.md`) cleanly to reflect verified `#5187` reality (including `L7` HTTPS public endpoint rule and `L8` OAuth lexicon republish note).
2. Add/verify R12 regression coverage (per `prompt-11-5-26.md` & `prompt-11-12-26.md` + Round 1 security findings):
   - Same-token operator renewal triggers 0 duplicate registrations and 0 re-confirmations (`authorizeSpaceSync`, `#registrationExpired` arriving >5 min after lapse, `confirmRegistration` on `expires_at = 0` placeholder, DB migration resetting `token = ''` -> `expires_at = 0, renew_at = 0`, and missed write during operator downtime reconciled via `last_space_rev`).
   - `#spaceDeleted` refuses purge if `authorizeSpaceSync` cannot confirm `SpaceDeleted`, and succeeds once authority confirms deletion.
   - Nonmember / revoked / stolen-credential / wrong-space / replay calls to `getDmNotifyTarget` rejected (`403`), cross-caller DM token isolation prevents registration withdrawal DoS, tampered/non-`dm1` DM token -> `400`, `RegistrationNotConfirmed`, `ScopeMissingError`, & legacy pre-R12 browser `restoreSession` never block DM reads, operator SQLite has 0 DM rows across all tables (verified alongside ephemeral restart `reset`), and `nobody -> everyone -> dormant contact request` works.
   - `listWriters` page 1 write overridden by page 2 `#repoRemoved`; >72h cursor falls back to full listing.
   - Authority `RepoTakendown`/`RepoDeactivated` (on `authorizeSpaceSync`/`listWriters` AND `repo === authorityDid`) keeps local data intact, non-authority per-writer `RepoTakendown` still sets writer aside, and `401 AccountTakedown`/`AccountDeactivated` on management ops preserves authority grant.
   - Every-page `listRepoOps` commit+MAC + `RepoNotFound`; exact `starEntryBytes` vs `writeRepoStar` byte identity; `ACCESS_FULL` app-password K7 assertions.
3. Run **Gates 1–6** sequentially after the final edit (`ATPROTO_PINNED_CHECKOUT=/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12` and `ATPROTO_PIN_CHECKOUT=...`), record exact observed counts/timings below, and run fresh Claude Opus + Codex adversarial code reviews before PR creation.

---

## Progress & Gate Log

- [x] **Phase 1 (Complete):** PR #7 (`feat/r10-interactions`) rebased cleanly onto `origin/main` (`762/762` green), merged (`f7b7bdc`); PR #8 (`feat/r11-tasks`) rebased cleanly onto `origin/main` (`908/908` green), merged (`f4a4c16`). `../atproto-slack-clone-r11` left clean on `feat/r11-tasks`.
- [x] **Phase 2 (Complete):** `../atproto-spaces-r12` created at `6747610566eee1b6d743617bd8eb1136adccb362` (`../atproto-spaces-phase3` untouched); `../atproto-slack-clone-r12` branched as `chore/protocol-drift-6747610` off `f4a4c16`; plan authored at `.ai/plans/r12-protocol-drift-progress.md`.
- [x] **Plan Review Round 1 (Complete):** Codex (`gpt-6.1-sol`) + Claude Opus (`claude-opus-5-5-high`) reviews archived under `.ai/reviews/{codex,opus}-r12-plan-round-1.md`; all Blocker, High, Medium, and Low findings resolved.
- [x] **Plan Review Round 2 (Complete):** Codex (`gpt-6.1-sol`) + Claude Opus (`claude-opus-5-5-high`) reviews archived under `.ai/reviews/{codex,opus}-r12-plan-round-2.md`; all N1–N9 / Round 2 High/Medium/Low items resolved cleanly in finalized plan (`D12.1`–`D12.12`).
- [x] **Wave `R12a` (Complete):** `strict-credential-expiry.patch` rebased onto `6747610566` (SHA-256 `3f413baa779473b5466e8e6ca9edc92335f5056edbd13aa3d4bfc57a509b32dd`) and applied in `../atproto-spaces-r12`; installed (`pnpm@12.16.1`) & built `tooling`, `dev-env`, `pds`, `bsky`, `ozone`, `space`, `star`, `lex-cli` cleanly (`oauth-provider-ui` Lingui prebuild under `/opt/homebrew/bin/node` `v25.4.0`, TypeScript/native ABI 127 build under Node `v22.17.0`); `@atproto/space` tests **9/9 files, 173/173 tests passing**; upgraded Flock workspace packages to `0.0.0-spaces-alpha-20261117141222` (+ direct `@atproto/star`, `pnpm install --frozen-lockfile` verified with zero stale `20261029171913` entries); synced all 4 upstream lexicon directories + Flock `"title"` + `getDmNotifyTarget.json` + permissions + regenerated API types cleanly via `ATPROTO_PIN_CHECKOUT=../atproto-spaces-r12 pnpm codegen:lex`.
- [x] **Wave `R12b` (Complete):** Cherry-picked `r12b-protocol` (`1bf5b228` -> `62d8958`) and `r12b-fakenetwork` (`0950cfcc` -> `679d6ef`) onto `chore/protocol-drift-6747610`; Wave `R12b` exit gate **100% green** (`187/187` combined tests across `packages/protocol/src/**/*.test.ts` and `packages/testing/src/**/*.test.ts`, `tsc -p packages/protocol --noEmit` 0 errors and `@types/node`-free, `eslint` clean).
- [x] **Wave `R12c` (Complete):** `apps/operator` & `@flock/reader` aligned (`83bc8bd`, `40f1f31`, plus `operatorNotifyEndpoint` loopback `localhost` mapping for `@atproto/pds` `safeClient` `allowIpHost: false`); Wave `R12c` exit gate **100% green** (`263/263` combined tests: `237/237` operator + `26/26` reader, `0` ESLint/TS errors).
- [x] **Wave `R12d` (Complete):** `@flock/client` & `apps/web` aligned (`40f1f31` + `session.ts` NSID JSDoc fix); Wave `R12d` exit gate **100% green** (`445/445` tests across `client` `368`, `web` `57`, `echo-bot` + `webhooks` `20`, `@types/node`-free `tsc -p packages/client --noEmit`, Next.js `pnpm build` green).
- [x] **Wave `R12e` (Complete):** `protocol-tests` (`r12-protocol-tests`) & `features`/`bdd` (`r12-bdd`) aligned and verified against real pinned `@atproto/pds` (`6747610566`).
- [ ] **Wave `R12f` (Gates 1–6 Green; Running Adversarial Reviews):**
  - **Docs & R12 Regression Coverage:** Updated all 8 docs (`SPEC.md`, `ARCHITECTURE.md`, `CODE-MAP.md`, `docs/operations.md`, `docs/prd/atproto-slack-clone.md`, `docs/prd/atproto-slack-implementation-plan.md`, `docs/protocol/operator-contract.md`, `docs/protocol/atproto-spaces-pin.md`) and added full R12 security/regression suites across `protocol`, `testing`, `reader`, `operator`, `client`, `web`, `protocol-tests`, and `bdd`.
  - **Gate 1 — Static & Unit/Component (`Node v22.17.0` ABI 127):** `ATPROTO_PIN_CHECKOUT=../atproto-spaces-r12 pnpm codegen:lex && pnpm typecheck && pnpm lint && pnpm test` -> **PASS (`917/917` tests, `0` failed, `0` skipped, `28,554.47 ms`)**.
  - **Gate 2 — Protocol Acceptance:** `ATPROTO_PINNED_CHECKOUT=../atproto-spaces-r12 pnpm test:acceptance` -> **PASS (`13/13` suites, `44/44` tests, `153.71 s`)**.
  - **Gate 3 — Browser Playwright:** `ATPROTO_PINNED_CHECKOUT=../atproto-spaces-r12 pnpm test:browser` -> **PASS (`8/8` specs, `10/10` tests, `179.79 s`)**.
  - **Gate 4 — Upstream `@atproto/space` + Real PDS Conformance:**
    - `pnpm --config.runtimeOnFail=ignore --pm-on-fail=ignore -C ../atproto-spaces-r12 --filter @atproto/space test` -> **PASS (`9/9` files, `173/173` tests, `655 ms`)**.
    - `NODE_OPTIONS=--experimental-vm-modules pnpm -C ../atproto-spaces-r12 --filter @atproto/pds exec jest --runInBand tests/space/{slack-*,platform-spike-k*}` -> **PASS (`5/5` suites, `12/12` tests, `128.77 s`; temporary copies removed cleanly)**.
  - **Gate 5 — BDD:** `ATPROTO_PINNED_CHECKOUT=../atproto-spaces-r12 pnpm test:bdd` -> **PASS (`74/74` scenarios, `537/537` steps, `2/2` hooks, `18m 19.41s`)**.
  - **Gate 6 — Performance & Sync Budgets:**
    - `pnpm test:sync-budget` -> **PASS (`177 s`; warm reopen = `1` `listWriters` call across `20`/`100`/`200` writers)**.
    - `pnpm test:sync-budget:browser` -> **PASS (`288 s`; warm reopen = `2` requests across `20`/`100`/`200` writers)**.
    - `pnpm test:performance` -> **PASS (`3/3` suites: `dm-performance` `77.24 s`, `performance-envelope` `1,752.49 s`, `tasks-performance` `23.27 s`; total `30m 54.25s`)**.
  - **Adversarial Code Reviews:** Pending Round 1 Codex + Claude reviews.
