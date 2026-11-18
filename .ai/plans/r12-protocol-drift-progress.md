# R12 Protocol Drift Plan & Progress (`bluesky-social/atproto#5187` @ `674761056`)

**Status:** Revised after Round 1 Codex (`gpt-6.1-sol`) + Claude Opus (`claude-opus-5-5-high`) plan reviews — ready for Round 2 review / execution
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
   - `../atproto-spaces-r12` has no `node_modules` or `dist/` yet and declares `devEngines` (`node ^22.23.4 || ^24.22.1 || ^26.12.1`, `pnpm 12.16.1`), whereas this project runs `Node v22.17.0` (`"engines": { "node": ">=22.12.0 <23" }`, native `better-sqlite3` ABI 127) and `pnpm 11.11.0`.
   - `R12a` must install & build `../atproto-spaces-r12` **under Node `v22.17.0`** (so native modules like `better-sqlite3` link ABI 127 compatible with `protocol-tests`) using `PUPPETEER_SKIP_DOWNLOAD=true` and ignoring upstream `devEngines` strictness (`COREPACK` or `pnpm_config_manage_package_manager_versions=false pnpm_config_engine_strict=false` — exact working flags recorded in Gate Log):
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
   - Add two columns to `notification_registration` via DB migration (preserving PK `(service_ref, space_uri)`):
     - `token TEXT NOT NULL DEFAULT ''`
     - `last_space_rev TEXT` (nullable checkpoint for gap catch-up; do NOT add `space_rev` to `space_notification`, preserving its `(space_uri, space_type, type_seq, repo_did, rev, notified_at)` schema!).
   - **Token lifecycle in `registerSpace`:** Read `(token, last_space_rev, expires_at)` from `notification_registration`. If `token` is empty (new registration or migrated legacy row), generate one 32-byte random base64url `token` and persist `(service_ref, space_uri, expires_at = 0, next_attempt_at = now, consecutive_failures = 0, token)` *before* calling `authorizeSpaceSync` so PDS's synchronous `confirmRegistration` succeeds inside `authorizeSpaceSync`. Reuse the exact persisted `token` on every subsequent renewal. If initial `authorizeSpaceSync` refuses permanently (`SpaceDeleted` while `expires_at === 0`), delete the placeholder row; on transient failure, keep `token` + record backoff. On `authorizeSpaceSync` success, persist exact `expires_at = credentialPayload.exp * 1000`.
   - **`unregisterSpace`:** Delete the `(service_ref, space_uri)` row from `notification_registration` (no PDS XRPC exists).
3. **`confirmRegistration` & `notifySpaceUpdate` Handlers (`apps/operator/src/operator/notices.ts`, `server.ts`):**
   - Auth: `auth: undefined` on both XRPC routes (`server.ts`); authenticate by checking `(space, token)` with `crypto.timingSafeEqual` (pad/length-guarded) against stored `(token)` in `notification_registration` OR stateless per-caller DM token (`dm1.*`). Unknown/mismatched/expired tokens return HTTP **400** (`InvalidRequestError`).
   - Exact `#` discriminants for `notifySpaceUpdate` (`{ space, token, update }`):
     - **`com.atproto.space.defs#repoWrite`** (`{ repo, repoRev, spaceRev, prevSpaceRev?, data }`):
       - Check gap: if `update.prevSpaceRev !== undefined && lastSpaceRev !== null && update.prevSpaceRev !== lastSpaceRev`, record gap wake (handled cleanly because `recordWriteNotification({ space, repo: update.repo, repoRev: update.repoRev })` already appends to `space_notification` and notifies change followers to sync!). Advance `last_space_rev = update.spaceRev`. Replace `parseWriteNotification`'s old `ALLOWED_KEYS` whitelist so `$type`, `spaceRev`, `prevSpaceRev`, `repoRev`, `data`, `token` validate strictly without dropping writes.
     - **`com.atproto.space.defs#repoRemoved`** (`{ repo, spaceRev, prevSpaceRev? }`):
       - Update `last_space_rev = update.spaceRev` and emit a synthetic wake row in `space_notification` (`recordSpaceWake(space, update.repo, "")` or empty `repo`) so active `ChangeFollower` clients immediately reconcile `listWritersSince` and drop the removed writer without treating missing records as errors.
     - **`com.atproto.space.notifySpaceUpdate#registrationExpired`** (`{ spaceRev }`):
       - For operator spaces: advance/reconcile `last_space_rev`, mark `expires_at = Math.min(expires_at, Date.now())`, emit a wake row (`recordSpaceWake`) so any event dropped during the lapse is caught via `listWritersSince`, and trigger immediate async `renewSpaceRegistration(space)` (serialized with per-space lock); return `200 {}`.
       - For DM tokens (`dm1.*`): return HTTP **400** (`InvalidRequestError`), triggering PDS `abandonSyncerNotice` (`space-notifications.ts:332`) so closed browser tabs drop PDS registrations instead of churning retries for 72h.
     - **`com.atproto.space.notifySpaceUpdate#spaceDeleted`** (`{}`):
       - Never purge on webhook alone (`prompt-11-12-26.md`, M9). For operator spaces, always confirm by calling `authorizeSpaceSync` through the workspace's restored authority grant; ONLY when `authorizeSpaceSync` returns `SpaceDeleted` do `purgeSpaceNotifications(space)`, `dropMemberList(space)`, and delete `notification_registration` (`notification_registration`). If authority grant cannot be restored or host returns a transient error/`RepoTakendown`/`RepoDeactivated`, log and keep state intact. (`dm1.*` `#spaceDeleted` emits a non-DB wake and returns `200 {}`.)
   - **Accurate HTTP 400 PDS Semantics (`prompt-11-12-26.md`, M11):** Rejecting `confirmRegistration` returns `RegistrationNotConfirmed` synchronously; rejecting `#registrationExpired` (`400`) triggers `abandonSyncerNotice` and removes the PDS registration immediately; rejecting `#repoWrite` / `#repoRemoved` (`400`) is logged on PDS (`util.ts:443`) without immediately deleting an active registration (it lapses naturally at `exp`).
4. **Gap Detection & Startup Catch-Up (`H1`):**
   - `authorizeSpaceSync` returns `{ credential, spaceRev? }`. Whenever `authorizeSpaceSync` completes (initial registration, operator startup recovery, periodic renewal, `#registrationExpired` renewal) and `spaceRev` is present and differs from (`!==`) stored `last_space_rev` (including after downtime where events were missed), emit a `space_notification` wake (`recordSpaceWake`) so connected clients reconcile via `listWritersSince`, and persist `last_space_rev = spaceRev`. Note: `listWriters` retains >72h fallback (`M3`) so long outages recover completely.
5. **Lifetime-Aware Renewal & Fast SQL-First Sweep (`H2`):**
   - Derive `renewWithinMs` per row dynamically from credential lifetime `exp - iat`: `Math.min(3 * 60 * 1000, Math.floor(ttlMs * 0.3))` (default `3 min` for 10-min credentials, scales smoothly if host issues up to 1h).
   - Shrink `FIRST_RETRY_MS` / `LONGEST_RETRY_MS` in `registrations.ts` from `30 min -> 60 min` down to **`15_000 ms -> 120_000 ms`** (`15 s -> 2 min`, capped well below `RENEW_WITHIN_MS`) so transient errors recover within the 10-min TTL.
   - Split sweeping cleanly:
     - **Fast renewal loop (`60 s` in `apps/operator/src/operator/main.ts`, `.unref()`, cleaned on shutdown):** Queries SQLite *first* (`SELECT ... FROM notification_registration WHERE expires_at <= ? AND next_attempt_at <= ?`). Zero due rows = zero grant restores and zero PDS requests. Groups due rows by workspace authority, restores grant once per due authority, renews with bounded concurrency (e.g. `4`), wrapped in an in-process mutex + heartbeated renewable DB lease (extending lease while active so sweeps >60s never overlap).
     - **Discovery backfill sweep (`30 min`):** Retains full `sweepRegistrations` workspace discovery cadence (or workspace lifecycle triggers) to catch unseeded spaces without running `activeSpaces` across all workspaces every minute.

### `D12.3b` Stateless Per-Caller DM Notifications (`new.flock.operator.getDmNotifyTarget`, Resilient Non-Blocking Reads, Scope Compatibility)
1. **OAuth Scope Wiring & Pre-R12 Re-Consent Compatibility (`H5`):**
   - Add `OPERATOR_METHOD.getDmNotifyTarget = "new.flock.operator.getDmNotifyTarget"` to `packages/protocol/src/nsids.ts`, `packages/protocol/lexicons/new/flock/operator/getDmNotifyTarget.json`, and `packages/protocol/lexicons/new/flock/permissions/{member,workspaceAuthority}.json` (keep `DM_BROWSER_SCOPES` and `appGrantScopes` unchanged; `memberGrantScopes` automatically picks up `OPERATOR_METHODS` via `operatorMethodsScope` — note no `dmScopes` helper exists in `scopes.ts`).
   - Because updating `memberGrantScopes` adds `rpc?lxm=new.flock.operator.getDmNotifyTarget&...` to the required member grant, existing browser sessions issued before R12 lack that scope (`ScopeMissingError`) until re-consent. Handle `ScopeMissingError` / `403` on `getDmNotifyTarget` non-destructively (degrading cleanly to polling without breaking DM reads; prompt reconnect when appropriate).
2. **Per-Caller Bounded Stateless DM Token (`B1(b)`):**
   - Guard `getDmNotifyTarget({ space })` with service auth (`callerDid`) + `authorizeDmSubscription(space, callerDid)` (enforces `ownerDid === callerDid` on inbox URIs).
   - Derive per-caller, time-bounded token using HKDF-SHA256 from `AUTH_ENCRYPTION_KEY` (`"flock-dm-notify-v1"`):
     `dm1.<base64url(callerDid)>.<expiresAtSec>.<base64url(hmacSha256(dmNotifyKey, space + "\0" + callerDid + "\0" + expiresAtSec))>`
     (TTL ~`20 min`, total length ~105 <= `512`).
   - Properties: (a) **Zero DM rows/state** in operator SQLite (`db-member-tables.test.ts` preserved); (b) **Zero cross-caller DoS** because each caller gets a distinct `token`, so a refused `authorizeSpaceSync` by caller B cannot delete caller A's `(space, endpoint, token)` registration on PDS; (c) bounded expiry verified by `confirmRegistration` / `notifySpaceUpdate`, rejecting expired or tampered tokens with `400`.
3. **Non-Blocking `DmClient.watch` (`H5`):**
   - `DmClient.watch(spaces, opts?: { signal?: AbortSignal })` fetches `{ endpoint, token }` via `getDmNotifyTarget(space)` and passes `notify` to `authorizeSpaceSync`.
   - **Never couple DM reads to operator availability:** Wrap `getDmNotifyTarget(space)` in `try/catch` AND catch `RegistrationNotConfirmed` on `authorizeSpaceSync(..., { notify })`: if webhook registration fails (`RegistrationNotConfirmed`, timeout, offline operator, `ScopeMissingError`, SSRF block), **immediately retry/mint `authorizeSpaceSync` WITHOUT `notify`** so `readConversation` / `listRequests` / `CredentialCache` **never fail**, and retry webhook registration in the background with backoff.
   - Maintain a clean periodic renewal loop inside `DmClient.watch` before cached `exp` (honoring `opts?.signal` / `.unref()`), refreshing `getDmNotifyTarget` before token `expiresAtSec`, wired with `AbortController` in `apps/web/src/app/ui/{dm-context,dm-conversation}.tsx`.

### `D12.4` HTTP Message Signature Credential Binding & RFC 9421 MACs (`@atproto/space`)
1. **Outbound Request Binding (`createSpaceSigHeaders`, `verifyCredentialSig`):**
   - `createSpaceSigHeaders({ authorization, audience: hostDid, keypair })` returns `{ headers }` (signs `'sig'` label; replaces old 2-arg `(opts, keypair)`).
   - `verifyCredentialSig(headers, keyDid)` enforces `tag="atproto-space-credential"`.
2. **Exact RFC 9421 Commit & Record MAC APIs (`mac.ts`, `kem.ts`, `repo-commit.ts`, `error.ts`):**
   - **Client request:** Generate an **ephemeral** keyshare per request using `encapsulate(authorKemKey)` (`{ keyShare, sharedSecret }`), and send `Accept-Signature: ${formatMacRequest(profile, keyShare)}` (`COMMIT_MAC_PROFILE = "atproto-space-commit"`, `RECORD_MAC_PROFILE = "atproto-space-record"`). (Do NOT pass `macKeyPair.did()`!)
   - **Server response:** Parse `const macReq = parseMacRequest(headers["accept-signature"], profile)`, compute `sharedSecret = decapsulate(kemKeypair, macReq.keyShare)`, call `createCommitMacHeaders(commit, { ...macReq, sharedSecret })` or `createRecordMacHeaders(uri, cid, { ...macReq, sharedSecret })`, returning `{ headers }` (`Atproto-Space-Commit` / `Atproto-Space-Record`, `Signature-Input`, `Signature`).
   - **Verification (now throwing):** `verifyCommitMac(commit, { keyShare, sharedSecret, headers })`, `verifyRecordMac(uri, cid, { keyShare, sharedSecret, headers })`, `verifyCommit(commit, { space, repo })`, and `verifyRecord(record, ...)` all **throw** (`SpaceMacError` with `code = "InvalidSpaceMac"` or `SpaceRepoVerificationError` with `code = "InvalidSpaceRepo"`) instead of returning `boolean`.
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
   - Since `starHeaderBytes(commit)` calls `writeRepoStar(commit, [])` (which includes the 4-byte `2a 6c 01 00` magic header and trailing `0x00` EOF byte), define:
     `starEntryBytes(keyBytesLen, valBytesLen) = 1 + varintByteLength(keyBytesLen) + keyBytesLen + varintByteLength(valBytesLen) + valBytesLen`.
   - Assert exact byte-for-byte parity `starHeaderBytes(commit) + sum(starEntryBytes(...)) === writeRepoStar(commit, entries).byteLength` in `space-credential-core.test.ts`.

### `D12.6` Writer Set (`listWriters`), 72h Fallback, Suspension vs Takedown Parity, & Management `401`s
1. **`listRepos` -> `listWriters` & Union Discrimination (`record-pages.ts`, `sync.ts`, `independent*.ts`, `dm-client.ts`, `apps/operator`, `FakeNetwork`):**
   - Upstream output keeps array property name **`repos`**, whose union items have `repo` (not `did`), `spaceRev`, and `$type`:
     - `com.atproto.space.defs#repoWrite`: `{ repo, repoRev, spaceRev, data }` (`rev` -> `repoRev`).
     - `com.atproto.space.defs#repoRemoved`: `{ repo, spaceRev }`.
   - Keep `page.repos.length < limit` pagination termination (`listWriters.ts` emits `cursor: writers.at(-1)?.spaceRev` on every non-empty page).
   - **Full listing (`listBoundedWriters` without cursor, M3):** Must apply **latest-entry-wins per DID across all pages** — if a `#repoWrite` appears on page 1 and a `#repoRemoved` appears on page 2 for the same `repo`, delete that `repo` from the active writer map! Removed entries MUST NOT count toward `maxRepos` or `truncated`.
   - **Incremental `listWritersSince` (`M3`):** Keep `WriterUpdate = { kind: "write", repo, repoRev, spaceRev, data } | { kind: "removed", repo, spaceRev }`. Evict cached writer rows/cursor state when `#repoRemoved` arrives (without calling `getRepo`/`listRepoOps`). If the stored `spaceRev` checkpoint is **older than 72 hours** (per upstream cursor doc: removed entries may be GC'd after 72h) or yields `InvalidCursor`, **fall back to full `listBoundedWriters` reconciliation** so D14 writer removals are never missed.
2. **Per-Writer Takedown vs Authority Suspension vs Management 401 (`H3`):**
   - **DO NOT weaken per-writer takedowns in `packages/protocol/src/atproto/repo-failure.ts`!** On repo reads (`listRepoOps`, `getRepo`, `getRecord`, `listRecords`, `getLatestCommit`), `RepoTakendown` / `RepoDeactivated` (`ACCOUNT_STATE`) describe the writer's account and MUST remain `permanent: true` so taken-down members' data is evicted/set aside (`SyncCore`). Keep explicit test coverage asserting a taken-down *writer* stays set aside.
   - Only **space authority** errors on `authorizeSpaceSync` and `listWriters` (`400 RepoTakendown` / `400 RepoDeactivated` from `assertActiveSpaceHost`) are temporary host suspensions: confirm both map to transient degraded/host-unavailable errors (`XrpcFailure`, NOT `SpaceCredentialError`, NOT `isAccessLost`), keeping local synced data intact until the authority recovers.
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
4. **Gate 4 — Upstream `@atproto/space` + Real PDS Conformance (`L6`):**
   - `pnpm -C ../atproto-spaces-r12 --filter @atproto/space test` (with rebased strict expiry patch applied).
   - Temporarily copy `protocol-tests/atproto/slack-{inbox,dm,authority-oauth}-conformance.test.ts` (and `platform-spike-k{2,5}*.test.ts` if maintained) into `../atproto-spaces-r12/packages/pds/tests/space/`, run `pnpm -C ../atproto-spaces-r12 --filter @atproto/pds exec jest tests/space/`, verify 100% pass, and remove temporary copies from `../atproto-spaces-r12` so `../atproto-spaces-r12` remains clean apart from the pinned patch.
5. **Gate 5 — BDD (`ATPROTO_PINNED_CHECKOUT=../atproto-spaces-r12 pnpm test:bdd`):** All scenarios green (`listWriters` wording, `NotAuthorized`, `putMembers`/`removeMembers`, `.space`).
6. **Gate 6 — Performance & Sync Budgets (`ATPROTO_PINNED_CHECKOUT=../atproto-spaces-r12`):** `pnpm test:sync-budget`, `pnpm test:sync-budget:browser`, `pnpm test:performance`.
7. **Independent Adversarial Reviews:** Fresh read-only Claude Opus + Codex passes over the full diff against `origin/main` (`f4a4c16`) before final PR creation.

---

## Parallel Execution Waves & Disjoint File Ownership

### Wave `R12a` — Pin, Patch Rebase, Upstream Build, Dependencies & Lexicons (Single Worker: `r12-pin-lex`)
- **Upstream `../atproto-spaces-r12` & `protocol-tests/atproto/strict-credential-expiry.patch`:**
  - Rebase `protocol-tests/atproto/strict-credential-expiry.patch` onto `674761056` (`credential.ts` + `src/credential.test.ts`), apply it inside `../atproto-spaces-r12`, install deps + build `build:tooling` & `@atproto/dev-env` graph under Node `v22.17.0` (`PUPPETEER_SKIP_DOWNLOAD=true`), run `pnpm -C ../atproto-spaces-r12 --filter @atproto/space test`, and update `docs/protocol/atproto-spaces-pin.md` (with `674761056`, patch SHA-256, build recipe, and HTTPS notify requirement `L7`).
- **Workspace packages & lockfile (`../atproto-slack-clone-r12`):**
  - Update `package.json`, `packages/{protocol,reader,client,testing}/package.json`, `apps/{operator,web}/package.json`, and `pnpm-workspace.yaml` per `D12.1` (`0.0.0-spaces-alpha-20261117141222`, `@atproto/star`, re-pinned `overrides`, complete `minimumReleaseAgeExclude`). Run `pnpm install --no-frozen-lockfile` and audit `pnpm-lock.yaml` (0 stale alpha hashes, 0 duplicate versions).
- **Lexicons & Codegen:**
  - Sync `packages/protocol/lexicons/com/atproto/{space,memberspace,managedspace,personalspace}/*.json` from `../atproto-spaces-r12/lexicons/com/atproto/` (deleting removed JSONs).
  - Rename `"name"` -> `"title"` in the 7 `packages/protocol/lexicons/new/flock/*.json` space definitions.
  - Add `packages/protocol/lexicons/new/flock/operator/getDmNotifyTarget.json` and update `packages/protocol/lexicons/new/flock/permissions/{member,workspaceAuthority}.json`.
  - Update `scripts/codegen-lex.mjs` (`expectedCommit`, clean checkout env handling) and `protocol-tests/support/app-fixture.ts:51` (`../atproto-spaces-r12` fallback). Run `ATPROTO_PIN_CHECKOUT=../atproto-spaces-r12 pnpm codegen:lex`.

### Wave `R12b` — `@flock/protocol` & `@flock/testing` FakeNetwork (2 Disjoint Workers)
- **Worker `r12-protocol`** (owns ONLY `packages/protocol/src/**/*.ts` AND `packages/testing/src/space-credential-core.test.ts`):
  - `nsids.ts`, `scopes.ts`, `scopes.test.ts`, `scope-lexicons.test.ts`.
  - `atproto/space-credential-core.ts`, `atproto/kem-key.ts`, `atproto/repo-failure.ts` (keep writer `ACCOUNT_STATE` permanent!), `atproto/record-pages.ts`, `atproto/record-pages.test.ts`, `atproto/xrpc.ts`, `atproto/xrpc.test.ts`, `registry.ts`, `registry.test.ts`.
  - `packages/testing/src/space-credential-core.test.ts` (RFC 9421 headers, throwing MAC/commit verifiers, `SpaceKemError` / `SpaceMacError` / `SpaceRepoVerificationError`, `starEntryBytes` exact byte parity with `writeRepoStar`, removal of unsigned-empty special cases).
- **Worker `r12-fakenetwork`** (owns ONLY `packages/testing/src/fake-network.ts` and `packages/testing/src/fake-network.test.ts`):
  - Mirror `#5187` accurately: `authorizeSpaceSync` (no session auth; `notify` + sync `confirmRegistration` + `notifySpaceUpdate` `#repoWrite`/`#repoRemoved`/`#registrationExpired`/`#spaceDeleted` + `exp` expiry + `400` expiry-notice abandonment + `Util` logging on write rejection), `listWriters` (`spaceCredentialAuth`, `#repoWrite`/`#repoRemoved` union with `spaceRev`, `RepoTakendown`/`RepoDeactivated` host check), `putMembers`/`removeMembers` (`<=100`), `getRepo` `application/vnd.dasl.star`, `listRepoOps` every-page commit+MAC & `RepoNotFound`, RFC 9421 MACs + CORS headers, `ACCESS_FULL` app-password refusal strictly on account-authenticated routes, `managedspace.checkAccess` / `personalspace` policy updates, `createSpace`/`getSpace`/`listSpaces` renames & error renames.
- **Wave `R12b` Exit Gate:**
  `node --import tsx --test 'packages/protocol/src/**/*.test.ts' 'packages/testing/src/**/*.test.ts' && tsc -p packages/protocol --noEmit && ! tsc -p packages/protocol --listFilesOnly | grep -q /@types/node/`

### Wave `R12c` — `apps/operator` & `@flock/reader` (2 Disjoint Workers)
- **Worker `r12-operator`** (owns ONLY `apps/operator/src/**/*.ts` and `apps/operator/scripts/**/*.ts`):
  - `lib/db.ts`, `lib/db-migration.test.ts`, `lib/db-member-tables.test.ts` (`notification_registration.token` + `last_space_rev`).
  - `registrations.ts`, `main.ts`, `registrations.test.ts` (stable 1-token persistence/reuse, `15s -> 2min` backoff, lifetime-aware `renewWithinMs`, 60s SQL-first sweeper with mutex + heartbeated DB lease + 30-min backfill, `authorizeSpaceSync.spaceRev` gap catch-up).
  - `notices.ts`, `space-notification.ts`, `server.ts`, `methods.ts`, `security.ts`, `atproto/write-notification.ts`, and tests (`confirmRegistration` & `notifySpaceUpdate` exact `$type` dispatch, `parseWriteNotification` replaced by strict variant parser, authority `authorizeSpaceSync` confirmation before `#spaceDeleted` purge, `getDmNotifyTarget` with `dm1.<didB64>.<exp>.<hmac>` bounded token & `authorizeDmSubscription`, `400` on DM `#registrationExpired`).
  - `atproto/space-ops.ts`, `operator/members.ts`, `operator/member-access.ts`, `operator/journal.ts`, `operator/testing/fake-authority-pds.ts`, `operator/kinds/*.ts`, and tests (batched `putMembers`/`removeMembers`, renames, `401 AccountTakedown`/`AccountDeactivated` graceful handling without revoking authority grants, preserving Flock `kind = "removeMember"`).
- **Worker `r12-reader`** (owns ONLY `packages/reader/src/**/*.ts`):
  - `independent.ts`, `independent-dm.ts`, `independent-dm.test.ts`, `independent-tasks.ts`, `independent-tasks.test.ts`: adopt R12b `@flock/protocol` primitives + `@atproto/star` `StarParseError`, `listWriters` (`#repoWrite`/`#repoRemoved` + 72h fallback + `RepoTakendown`/`RepoDeactivated` non-destructive host handling), throwing `verifyCommit`/`verifyRecord`/MAC checks, every-page `listRepoOps` + `RepoNotFound`.
- **Wave `R12c` Exit Gate:**
  `node --import tsx --test 'apps/operator/src/**/*.test.ts' 'packages/reader/src/**/*.test.ts'`

### Wave `R12d` — `@flock/client` & `apps/web` (2 Disjoint Workers)
- **Worker `r12-client`** (owns ONLY `packages/client/src/**/*.ts`):
  - `credentials.ts`, `sync.ts`: remove `UnsignedEmptyRepoOpsError` & intermediate `commit`+`cursor` refusal, verify every `listRepoOps` page, `listWriters` `#repoWrite`/`#repoRemoved` + 72h full fallback, `SpaceMacError`/`SpaceKemError`/`SpaceRepoVerificationError` mapping, non-destructive authority suspension (`authorizeSpaceSync`/`listWriters`) vs permanent per-writer takedown (`RepoTakendown`).
  - `operator-client.ts`, `dm/dm-client.ts`, `dm/ui-logic.ts`: `getDmNotifyTarget`, resilient non-blocking `DmClient.watch` (immediate `authorizeSpaceSync` fallback without `notify` on `getDmNotifyTarget` / `RegistrationNotConfirmed` / `ScopeMissingError`, background backoff retry, `AbortSignal` renewal loop before `exp`), batched `putMembers`/`removeMembers`, `setRequestMode("everyone")` reactivating dormant allowlist members (`H6`).
  - `workspace-client.ts`, `feed.ts`, `accept-errors.ts`, `store.ts`, `testing/*`, and all `packages/client/src/**/*.test.ts`.
- **Worker `r12-web`** (owns ONLY `apps/web/src/**/*.ts` and `apps/web/src/**/*.tsx`):
  - `apps/web/src/browser/session.ts`, `apps/web/src/app/ui/{dm-context,dm-conversation}.tsx`: wire `getDmNotifyTarget`, pass `AbortController.signal` into `client.watch`, handle pre-R12 `ScopeMissingError` gracefully until user re-consents.
  - Verify `apps/{echo-bot,webhooks}` require no edits (assign only if `rg` turns up anything before launch).
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
   - Same-token operator renewal triggers 0 duplicate registrations and 0 re-confirmations (`authorizeSpaceSync` + `#registrationExpired` + missed write during operator downtime reconciled on restart/renew via `last_space_rev`).
   - `#spaceDeleted` refuses purge if `authorizeSpaceSync` cannot confirm `SpaceDeleted`, and succeeds once authority confirms deletion.
   - Cross-caller DM token isolation (Mallory refusing `authorizeSpaceSync` cannot withdraw Alice's registration), expired/tampered DM token -> `400`, `RegistrationNotConfirmed` & `ScopeMissingError` never block DM reads, and operator SQLite maintains 0 DM rows.
   - `nobody -> everyone -> dormant contact request` works; `listWriters` page 1 write overridden by page 2 `#repoRemoved`; >72h cursor falls back to full listing.
   - Authority `RepoTakendown`/`RepoDeactivated` keeps local data intact, per-writer `RepoTakendown` still sets writer aside, and `401 AccountTakedown`/`AccountDeactivated` on management ops preserves authority grant.
   - Every-page `listRepoOps` commit+MAC + `RepoNotFound`; exact `starEntryBytes` vs `writeRepoStar` byte identity; `ACCESS_FULL` app-password K7 assertions.
3. Run **Gates 1–6** sequentially after the final edit (`ATPROTO_PINNED_CHECKOUT=/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12` and `ATPROTO_PIN_CHECKOUT=...`), record exact observed counts/timings below, and run fresh Claude Opus + Codex adversarial code reviews before PR creation.

---

## Progress & Gate Log

- [x] **Phase 1 (Complete):** PR #7 (`feat/r10-interactions`) rebased cleanly onto `origin/main` (`762/762` green), merged (`f7b7bdc`); PR #8 (`feat/r11-tasks`) rebased cleanly onto `origin/main` (`908/908` green), merged (`f4a4c16`). `../atproto-slack-clone-r11` left clean on `feat/r11-tasks`.
- [x] **Phase 2 (Complete):** `../atproto-spaces-r12` created at `6747610566eee1b6d743617bd8eb1136adccb362` (`../atproto-spaces-phase3` untouched); `../atproto-slack-clone-r12` branched as `chore/protocol-drift-6747610` off `f4a4c16`; plan authored at `.ai/plans/r12-protocol-drift-progress.md`.
- [x] **Plan Review Round 1 (Complete):** Codex (`gpt-6.1-sol`) + Claude Opus (`claude-opus-5-5-high`) reviews archived under `.ai/reviews/{codex,opus}-r12-plan-round-1.md`; all Blocker, High, Medium, and Low findings resolved in this revision.
- [ ] **Plan Review Round 2:** Codex + Claude Opus re-verification -> target `VERDICT: READY`
- [ ] **Wave `R12a`:** Pin, patch rebase, upstream build, package upgrades, lexicons & codegen
- [ ] **Wave `R12b`:** `@flock/protocol` & `@flock/testing` FakeNetwork
- [ ] **Wave `R12c`:** `apps/operator` & `@flock/reader`
- [ ] **Wave `R12d`:** `@flock/client` & `apps/web`
- [ ] **Wave `R12e`:** `protocol-tests` & `bdd`
- [ ] **Wave `R12f`:** Docs, R12 regression tests, 6-Gate Acceptance & Adversarial Code Reviews
