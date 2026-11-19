# R12 Protocol Drift Implementation Review — Round 1 (`opus-r12`)

- **Reviewer:** `opus-r12` (independent adversarial read-only static audit)
- **Repository:** `/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12`
- **Branch / Range:** `chore/protocol-drift-6747610` (`f4a4c16..1c941c01b619d31c42cb5a371a2115a5db9db738`)
- **Pinned Upstream Reference:** `/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12` (`bluesky-social/atproto#5187` @ `6747610566eee1b6d743617bd8eb1136adccb362`, `prompt-11-5-26.md`, `prompt-11-12-26.md`)
- **Audit Mode:** Strictly read-only (`0` source/test/doc files modified, `0` git state mutations, `0` builds/tests/servers executed).

---

## 1. `D12.1`–`D12.12` Compliance Summary

| Decision | Scope | Status | Evidence & Notes |
|---|---|---|---|
| **`D12.1`** | Pinning (`6747610566`), env standardization, upstream build, npm snapshot `0.0.0-spaces-alpha-20261117141222`, `@atproto/star`, `pnpm-workspace.yaml` overrides & `minimumReleaseAgeExclude` | **Compliant** | `scripts/codegen-lex.mjs:8-15` (`ATPROTO_PIN_CHECKOUT ?? ATPROTO_PINNED_CHECKOUT`, `expectedCommit = "6747610566..."`), `protocol-tests/support/app-fixture.ts:51` (`../atproto-spaces-r12`), `docs/protocol/atproto-spaces-pin.md`, workspace `package.json` files + `pnpm-workspace.yaml` + `pnpm-lock.yaml` (`0` stale `20261029171913` entries; all `^0.0.0-spaces-alpha-*` overrides preserved; `@atproto/star` added to `protocol`, `reader`, `testing`). |
| **`D12.2`** | Rebased `strict-credential-expiry.patch` (`expirationSkew = 0` strictly for `'credential'`) | **Compliant** | `protocol-tests/atproto/strict-credential-expiry.patch` (`SHA-256: 3f413baa779473b5466e8e6ca9edc92335f5056edbd13aa3d4bfc57a509b32dd`) matches `git diff` in `../atproto-spaces-r12/packages/space/src/credential{,.test}.ts`, `docs/protocol/atproto-spaces-pin.md`, and `protocol-tests/atproto/README.md`. |
| **`D12.3`** | Operator inline webhooks (`authorizeSpaceSync`), stable 1-token-per-space, `confirmRegistration` & `notifySpaceUpdate` token-only auth, `#spaceDeleted` authority confirmation, `spaceRev` gap catch-up, 60s SQL-first renewal + 30m discovery sweep | **Compliant** | `apps/operator/src/lib/db.ts:177-213` (`token`, `renew_at`, `last_space_rev`; resets `expires_at = 0, renew_at = 0 WHERE token = ''`), `space-notification.ts:77-125` (constant-time token check, zero `expires_at` gate), `atproto/write-notification.ts:61-124` (outer `{ space, token, update }` + `$type` dispatch), `methods.ts:261-319` (`400` on DM `#registrationExpired`; `handleSpaceDeletedNotice` confirms via `authorizeSpaceSync`), `registrations.ts:137-452` & `main.ts:39-65` (15s->120s backoff, 60s SQL-first `LEFT JOIN` + heartbeated DB lease + per-space lock). |
| **`D12.3b`** | Stateless per-caller DM notifications (`getDmNotifyTarget`, `SpaceCredential` + RFC 9421 PoP + replay guard, `dm1` HKDF/HMAC token, zero DM SQLite rows, non-blocking `DmClient.watch`, pre-R12 browser session admission) | **Compliant (with Medium/Low notes)** | `apps/operator/src/operator/security.ts:117-308` (`iss`/`sub`/strict `exp` checked before DID lookup, `verifyCredentialSig` against `cnf.kid` & `operatorServiceRef`, `dmProofReplayCache`), `dm-feed-wakes.ts` + `feed.ts` (zero DM SQLite writes, 3-char boot epoch `reset` on restart), `apps/web/src/browser/session.ts:266-318` (admits pre-R12 grants missing only `getDmNotifyTarget`). See **M1**, **L1**, **L2**, **L4**, **L5**. |
| **`D12.3c`** | Cross-wave `authorizeSpaceSync` contract (`credentialKey`, `{ credential, spaceRev? }`, `CREDENTIAL_REFUSALS` with `AccountNotAuthorized` and without `RegistrationNotConfirmed`/`RepoTakendown`/`RepoDeactivated`, `CredentialCache`) | **Compliant (with M1)** | `packages/protocol/src/atproto/space-credential-core.ts:44-52, 162-222`, `packages/client/src/credentials.ts:33-96`, `apps/operator/src/atproto/space-credential.ts:1-27`. None of `RegistrationNotConfirmed`, `RepoTakendown`, or `RepoDeactivated` trigger `isAccessLost`. See **M1** on concurrent read latency during `{ notify }` re-mints. |
| **`D12.4`** | Outbound `createSpaceSigHeaders` / `verifyCredentialSig` & RFC 9421 MACs (`encapsulate`, `Accept-Signature`, throwing `verifyCommit`/`verifyRecord`, `SpaceKemError`/`SpaceMacError`, CORS headers) | **Compliant** | `packages/protocol/src/atproto/space-credential-core.ts:233-388` & `record-pages.ts:432-477` (fresh ephemeral `encapsulate(kemKey)` per attempt, full `{ keyShare, sharedSecret, headers }` passed to `verifyCommit`/`verifyRecord`/`verifyRepoStar`), `kem-key.ts:48` (`SpaceKemError` in `isUnverifiableRepo`), `fake-network.ts` + `protocol-tests/browser/dm.spec.ts` CORS headers. See **L6**. |
| **`D12.5`** | `@atproto/star` framing (`writeRepoStar`, `StarParseError`, `application/vnd.dasl.star`, CID-less `starEntryBytes`) | **Compliant** | `packages/protocol/src/atproto/space-credential-core.ts:57, 282, 542-545` (`1 + varint(k) + k + varint(v) + v`), byte-for-byte parity verified against collected `writeRepoStar(commit, entries)` in `packages/testing/src/space-credential-core.test.ts:891-920`. |
| **`D12.6`** | `listWriters` (`#repoWrite`/`#repoRemoved`, cross-page latest-wins, >72h fallback), authority-as-writer transient suspension vs non-authority permanent takedown, management `401` grant preservation | **Compliant (with M2, L3, L6)** | `packages/protocol/src/atproto/record-pages.ts:285-425`, `repo-failure.ts:39-121` (`repo === authorityDid` -> `permanent: false`; non-authority writer -> `permanent: true`), `packages/client/src/sync.ts:360-420`, `apps/operator/src/operator/{authority-grant,journal,member-access,errors}.ts`. See **M2** on OAuth refresh during prolonged authority takedown. |
| **`D12.7`** | `listRepoOps` every-page `commit` + MAC verification & `RepoNotFound` classification; removal of unsigned-empty workarounds | **Compliant** | `UnsignedEmptyRepoOpsError` and intermediate `commit`+`cursor` rejection removed; `record-pages.ts:468` & `space-credential-core.ts:354-390` verify commit + MAC on every page; `sync.ts` & `reader` preserve `RepoNotFound` through `classifyRepoNotFoundOrFailure`. |
| **`D12.8`** | Batch `putMembers`/`removeMembers` (`<=100`), `publicWrite` dormant allowlist reactivation (`H6`), field/param/error renames, preserving Flock `kind = "removeMember"` | **Compliant** | `apps/operator/src/atproto/space-ops.ts:71-111` (`MAX_MEMBER_BATCH = 100`), `packages/client/src/dm/dm-client.ts` (`applyRequestMode` reactivates dormant `{ read: false, write: false }` entries on `"everyone"` & `"allowlist"`), `protocol-tests/dm-acceptance.test.ts` (`nobody -> everyone` test), Flock `OperationRequest.kind = "removeMember"` untouched. |
| **`D12.9`** | App-password `ACCESS_FULL` (`InvalidToken: Bad token scope`) enforcement (`#5923`) | **Compliant** | `packages/testing/src/fake-network.ts:633, 669-671, 2011` enforces `scopes: "full"` on all account-authenticated space/memberspace endpoints, skips session checks on `authorizeSpaceSync` and `listWriters`, allows `getServiceAuth`, and `protocol-tests/platform-capabilities.test.ts` tests K7. |
| **`D12.10`** | Full upstream lexicon sync (`space`, `memberspace`, `managedspace`, `personalspace`), Flock space `"name"` -> `"title"`, `getDmNotifyTarget.json` + permissions | **Compliant** | `diff -r` between `packages/protocol/lexicons/com/atproto/` and `../atproto-spaces-r12/lexicons/com/atproto/` is completely empty across all 4 directories; all 7 `new/flock/**` space lexicons use `"title"`; `getDmNotifyTarget` added to `member.json` and `workspaceAuthority.json`. |
| **`D12.11`** | Package & `@flock/reader` dependency boundaries (`@types/node`-free `protocol`/`client`, direct `@atproto/star` in `reader`) | **Compliant** | `packages/reader/package.json` declares `@atproto/star` and `@flock/protocol` only (`0` imports from `@flock/client`, `@flock/operator`, or `apps/web`). See **L7**. |
| **`D12.12`** | 6 sequential verification gates, regression suites, and documentation updates (`L7` HTTPS notify endpoint, `L8` lexicon republish) | **Compliant (with M3, M4)** | All 6 gates recorded green in `.ai/plans/r12-protocol-drift-progress.md`; `ARCHITECTURE.md`, `SPEC.md`, `CODE-MAP.md`, `docs/operations.md`, `docs/protocol/{atproto-spaces-pin,operator-contract}.md` updated accurately. See **M3** and **M4** on test-double / conformance-test precision. |

---

## 2. Adversarial Security & Boundary Verification Notes

- **`new.flock.operator.getDmNotifyTarget` (`apps/operator/src/operator/methods.ts:182-203`, `security.ts:117-308`):**
  - *Forged `iss` / SSRF amplification:* `parseCredentialJwt` (`security.ts:219`) verifies `payload.iss === requireSpaceAuthority(input.space)` and `payload.sub === input.space` **before** calling `resolveSigningKey`, so an unauthenticated or forged issuer never triggers arbitrary DID document fetches.
  - *Nonmember / wrong-space / expired credential:* Rejected with `403 Unauthorized` (`OperatorAuthError`); `nowSec >= payload.exp` (`security.ts:239`) enforces strict zero-skew expiration matching `D12.2`.
  - *Stolen credential without private key / wrong audience:* `proof.authorization` must equal ``Atproto-Space-Credential ${input.credential}`` (`security.ts:163`), and `verifyCredentialSig` (`security.ts:169-177`) binds the RFC 9421 signature (`tag="atproto-space-credential"`) to `parsed.cnfKid` (`P-256 did:key`) and `atproto-space-audience: operatorServiceRef`.
  - *Cross-caller withdrawal isolation:* `deriveDmNotifyToken` (`space-notification.ts:46-61`) binds `dm1.<b64url(callerDid)>.<hmac("dm1\0" + space + "\0" + callerDid)>` to the authenticated `callerDid` from the Bearer service JWT (`authenticateOperatorRequest`). Upstream `authorizeSpaceSync.ts:88-92` removes only the exact `(space, endpoint, token)` presented on refusal, so a revoked user or third party can never withdraw another participant's PDS webhook registration.
- **`confirmRegistration` & `notifySpaceUpdate` (`space-notification.ts:77-125`, `methods.ts:261-319`, `atproto/write-notification.ts:47-124`):**
  - Constant-time comparison (`timingSafeEqual` over SHA-256 digests + length check for operator tokens; `timingSafeEqual` over raw 32-byte HMACs for `dm1` tokens).
  - Zero `expires_at` gate: staged placeholder rows (`expires_at = 0`) confirm synchronously during initial `authorizeSpaceSync`, and `#registrationExpired` arriving arbitrarily late (>5 min or hours after lapse) is accepted (`200`) for operator spaces and triggers `handleRegistrationExpiredNotice` (`renew_at = 0`, `recordSpaceWake`, serialized `renewSpaceRegistration`), while DM `dm1` `#registrationExpired` returns HTTP `400` (`WebhookAuthError`) so PDS `abandonSyncerNotice` (`space-notifications.ts:332-346`) cleans up closed browser tabs immediately.
  - `#spaceDeleted` (`registrations.ts:308-321`) never purges on webhook alone; it restores the authority grant and confirms `isSpaceDeleted` via `authorizeSpaceSync`, leaving state intact on network/host errors or `RepoTakendown`/`RepoDeactivated`.
- **Zero DM SQLite Persistence (`dm-feed-wakes.ts`, `notices.ts:32-34`, `feed.ts:99-145`):**
  - `recordWriteNotification` throws if handed a DM URI (`notices.ts:32`). All DM wakes stay in `dm-feed-wakes.ts` (`MAX_TRACKED_DM_SPACES = 50_000` LRU with `evictedFloor` reset protection and `MAX_DM_SEQ_PER_EPOCH = 36^4 - 1` epoch rollover, keeping `<epoch>.<dbBase36>.<dmBase36>` `<= 16` chars per `getChanges.json`).

---

## 3. Findings (Ranked by Severity)

### Blocker (`0`)

`0` Blocker findings.

---

### High (`0`)

`0` High findings.

---

### Medium (`4`)

#### `M1` — `CredentialCache.get` + `DmClient.watch` blocks concurrent DM reads during slow/blackholed `confirmRegistration` and never invalidates stale `dm1` targets after `RegistrationNotConfirmed`
- **Locations:**
  - `packages/client/src/credentials.ts:38-58, 86-96`
  - `packages/client/src/dm/dm-client.ts:723-771, 826`
  - `packages/client/src/operator-client.ts:118-120, 159-176`
- **Failure Scenario:**
  1. When a DM space already holds a valid un-notified `SpaceCredential` (minted by `refresh()` in `runDmCycle`) and `DmClient.watch` subsequently calls `this.credentials.get(space, { notify: target })` (`dm-client.ts:726, 761`) or `this.credentials.fresh(space, { notify: cachedTarget })` (`dm-client.ts:725, 730, 826`), `CredentialCache.get` deletes the valid entry from `this.credentials` (`credentials.ts:52`) and replaces it in the shared map with `this.mint(space, effectiveNotify)` (`credentials.ts:54-55`). If the operator webhook endpoint blackholes or hangs, `@atproto/pds` blocks `authorizeSpaceSync` on synchronous `confirmRegistration` for up to `10s` (`authorizeSpaceSync.ts:154`) before returning `RegistrationNotConfirmed` (followed by a second `authorizeSpaceSync` without `notify`). Every concurrent `readConversation` (`dm-client.ts:479`) or `scanRequests` (`dm-client.ts:292`) call on that space awaits `pending` and stalls for ~10s, repeating every `15s–60s` (`runWatchTick` backoff + `runDmCycle` interval) because `cred.notify` remains `undefined` (`needsNotifyUpdate === true` at `credentials.ts:41`). Furthermore, `OperatorClient.getDmNotifyTarget` (`operator-client.ts:165`) sets no request timeout, so a blackholed operator stalls `watch()` (and `ensureDeclaration()` behind it in `ui-logic.ts:128-139`) until browser TCP timeout.
  2. In `DmClient.authorizeWatchedSpace` (`dm-client.ts:760`), `this.notifyTargets.set(space, target)` is cached permanently and never cleared when `CredentialCache.mint` catches `RegistrationNotConfirmed` and returns `cred.notify === undefined`. If the operator rotates `AUTH_ENCRYPTION_KEY` or changes its public endpoint while browser tabs stay open, `authorizeWatchedSpace` (`dm-client.ts:723`) takes the `if (cachedTarget)` branch forever, retrying the dead `dm1` token on every tick (2 `authorizeSpaceSync` calls per tick) without ever calling `getDmNotifyTarget` again.
- **Recommended Fix:**
  1. In `CredentialCache.get(space, opts)` (`packages/client/src/credentials.ts:38-58`), when upgrading an existing unexpired un-notified credential to `{ notify }`, run the `{ notify }` mint in a separate `pendingNotifyMints` map without deleting the valid un-notified `this.credentials.get(space)` promise; overwrite `this.credentials` only if the `{ notify }` mint succeeds, so plain `get(space)` callers (`readConversation`, `scanRequests`) return immediately with zero webhook latency.
  2. In `DmClient.authorizeWatchedSpace` (`packages/client/src/dm/dm-client.ts:723-762`), if `cred.notify === undefined` after requesting `{ notify }`, call `this.notifyTargets.delete(space)` so the next backoff retry fetches a fresh `{ endpoint, token }` from `getDmNotifyTarget`.
  3. Bound `getDmNotifyTarget` in `dm-client.ts:748` with `AbortSignal.timeout(10_000)` (combined via `AbortSignal.any` when `signal` is provided).

#### `M2` — Authority OAuth token refresh during prolonged `AccountTakedown` permanently deletes `authority_grant` despite `authorityOAuthFetch`
- **Locations:**
  - `apps/operator/src/operator/authority-grant.ts:389-409`
  - `apps/operator/src/operator/registrations.ts:255-261, 388-398, 432-442`
  - Upstream interaction: `../atproto-spaces-r12/packages/pds/src/account-manager/oauth-store.ts:329-336`
- **Failure Scenario:**
  - `authorityOAuthFetch` (`authority-grant.ts:389-409`) strips `WWW-Authenticate: ... invalid_token` on XRPC `401 AccountTakedown` / `AccountDeactivated` responses while the current OAuth access token is still unexpired. For `AccountDeactivated`, upstream `OAuthStore.getAccount` passes `includeDeactivated: true`, so token refreshes also succeed. However, upstream `OAuthStore.getAccount` passes **`includeTakenDown: false`** (`oauth-store.ts:334`). Once a taken-down authority's short-lived OAuth access token (~15–60 min) expires, the 60s `sweepDueRegistrations` loop (`registrations.ts:392`) calls `restoreAuthorityGrant(authorityDid)`, which triggers `@atproto/oauth-client-node` `/oauth/token` refresh; the PDS OAuth provider rejects the refresh with `400 invalid_grant` (`TokenRefreshError`), and `NodeOAuthClient` deletes the encrypted `authority_grant` session from SQLite. When the takedown is later lifted by moderation, the workspace remains broken until the authority manually re-runs the OAuth consent flow.
- **Recommended Fix:**
  - Track per-authority suspension state (`suspendedUntil` / `AccountTakedown` / `RepoTakendown`) when XRPC calls or unauthenticated `authorizeSpaceSync` probes report `AccountTakedown`/`RepoTakendown`, and skip `deps.grant(authorityDid)` in `sweepDueRegistrations`, `sweepRegistrations`, and `renewSpaceRegistration` while an unauthenticated probe (or backoff window) still reports the authority host is taken down — avoiding `/oauth/token` refresh attempts until the account is active again. Also document this upstream PDS OAuth refresh behavior (`includeTakenDown: false`) in `docs/operations.md`.

#### `M3` — `FakeNetwork` re-runs `confirmRegistration` on lapsed registrations instead of renewing silently when the registration row still exists
- **Locations:**
  - `packages/testing/src/fake-network.ts:46-47, 856-862`
- **Failure Scenario:**
  - In `FakeNetwork.authorizeSpaceSync` (`fake-network.ts:858`), `confirmRegistration` is called whenever `!existingReg || existingReg.expiresAtMs <= this.now()`. In real `@atproto/pds` (`packages/pds/src/api/com/atproto/space/authorizeSpaceSync.ts:96-103` + `actor-store/space/reader.ts:355-367`), `getNotifyRegistration` returns the stored `(space, endpoint, token)` row even after `expiresAt` has passed (rows are deleted only by `removeLapsedNotifyRegistration` upon `400` `#registrationExpired` rejection or 72h retry exhaustion), so re-authorizing a lapsed-but-unabandoned registration renews silently with **zero** `confirmRegistration` calls (`D12.3.2`). Tests against `FakeNetwork` therefore observe a spurious `confirmRegistration` round-trip after `600s` lapse that real PDS never sends.
- **Recommended Fix:**
  - Change `packages/testing/src/fake-network.ts:858` from `if (!existingReg || existingReg.expiresAtMs <= this.now())` to `if (!existingReg)` (updating the comment at lines `46-47`), and add a unit test in `packages/testing/src/fake-network.test.ts` advancing the clock by `600_001 ms` (with no `#registrationExpired` `400` abandonment) and asserting re-authorization with the same `(space, endpoint, token)` makes `0` additional `confirmRegistration` calls.

#### `M4` — `inProcessOperator` port-fallback leaves `OPERATOR_URL` pointing at a foreign port, and `slack-dm-conformance` dormant-writer negative assertion can race async `notifyRepoUpdate`
- **Locations:**
  - `protocol-tests/support/pds-network.ts:348-363, 412-425`
  - `protocol-tests/atproto/slack-dm-conformance.test.ts:314-321`
- **Failure Scenario:**
  1. `freeLoopbackPort()` (`pds-network.ts:348-360`) binds port `0`, reads the port, and closes the socket before `inProcessOperator()` binds it later (`pds-network.ts:413-421`). If another local process claims `preferredPort` in that window, `inProcessOperator` silently falls back to `candidatePort = 0`, binding a new random port while `process.env.OPERATOR_URL` (and `operatorNotifyEndpoint()`) still advertises `preferredPort` to the PDS — routing `confirmRegistration` and `notifySpaceUpdate` to the unrelated process on `preferredPort`.
  2. In `slack-dm-conformance.test.ts:314-320`, `dave` and `frank` write first and dormant `grace` writes *last* (`line 316`), then `settledWriters` stops polling as soon as `dave` and `frank` appear (`line 317`). Because PDS `notifyRepoUpdate` runs asynchronously after `putRecord`, `expect(everyoneWriters).not.toContain(grace.did)` (`line 320`) can pass while `grace`'s notification is still in flight even if dormant exclusion under `publicWrite: true` were broken.
- **Recommended Fix:**
  1. In `pds-network.ts:414`, remove the silent `0` fallback when `preferredPort > 0` (fail fast on `EADDRINUSE` or keep the reservation server open until `createOperatorApp` attaches to it).
  2. In `slack-dm-conformance.test.ts:314-317`, execute `spaces.put(grace, ...)` *before* `dave` and `frank` (or perform a second sentinel write by `dave` after `grace` and wait for `dave`'s new `repoRev`) before asserting `expect(everyoneWriters).not.toContain(grace.did)`.

---

### Low (`8`)

1. **`L1` — DB migration leaves pre-R12 DM rows in `space_notification*` tables on upgraded databases** (`apps/operator/src/lib/db.ts:198-213`):
   - Pre-R12 operators wrote `new.flock.dm.*` rows into `space_notification` and `space_notification_space_floor`. While R12 never writes new DM rows (`notices.ts:32`), upgrading an existing pre-R12 SQLite file leaves historical `new.flock.dm.*` rows in `space_notification` (until the 7-day prune) and `space_notification_space_floor` / `space_notification_type_floor` indefinitely.
   - *Fix:* Execute `DELETE FROM space_notification WHERE space_type LIKE 'new.flock.dm.%'`, `DELETE FROM space_notification_space_floor WHERE space_type LIKE 'new.flock.dm.%'`, and `DELETE FROM space_notification_type_floor WHERE space_type LIKE 'new.flock.dm.%'` during the `db.ts` startup migration.

2. **`L2` — `assertProofSignatureTimestamps` (`PROOF_CREATED_WINDOW_SECONDS = 60`) is unexercised by `@atproto/space` and `dmProofReplayCache` uses FIFO eviction** (`apps/operator/src/operator/security.ts:25-26, 261-308`):
   - `@atproto/space`'s `createSpaceSigHeaders` (`http-signature.ts:48-51`) emits `("authorization" "atproto-space-audience");tag="atproto-space-credential"` with no `;created=` parameter. Because `security.ts:268` only validates `;created=` when present, real client proofs have no 60s timestamp bound of their own (they remain valid until `SpaceCredential.exp`, default `600s` / max `3600s`), and `16,384` calls can FIFO-evict `dmProofReplayCache` entries before `exp`.
   - *Fix:* Document in `security.ts` that proof lifetime is bounded by `SpaceCredential.exp` (and the 75s Bearer service token) when `@atproto/space` omits `;created=`, or include a signed timestamp/nonce field in `getDmNotifyTarget` if a strict 60s PoP window independent of cache size is desired.

3. **`L3` — `listBoundedWriters` / `listWritersSince` pagination edge cases when `#repoRemoved` tombstones accompany `> maxRepos` churn** (`packages/protocol/src/atproto/record-pages.ts:313-318, 386, 408`, `packages/client/src/sync.ts:2503`):
   - `listBoundedWriters` sets `truncated = true` and breaks immediately on the `(maxRepos + 1)`-th `#repoWrite` even if a later `#repoRemoved` on a subsequent page brings active writers back `<= maxRepos`. Similarly, `listWritersSince` throws when `updates.size > input.maxRepos` (counting `#repoRemoved` tombstones) instead of calling `fullReconciliation()`. Also, `isStoredWriterCursorStale` in `sync.ts:2503` falls back to `tidTimestampMs(spaceRev)` when `writersListedAt === null`, causing spaces idle `>72h` to run a full scan until `writersListedAt` is populated.
   - *Fix:* In `listWritersSince`, fall back to `fullReconciliation()` when incremental `updates.size > input.maxRepos`; in `listBoundedWriters`, continue scanning bounded pages while removals can bring `active.size <= input.maxRepos`; and update `state.writersListedAt = now` after clean incremental catch-ups.

4. **`L4` — `DmClient` retains `notifyTargets` after `unwatch()`/`close()` and leaks `DmWatchState` if one space in `watch()` rejects** (`packages/client/src/dm/dm-client.ts:623-634, 696-705`, `packages/client/src/credentials.ts:55`):
   - `clearWatchState` does not remove `this.notifyTargets` or `CredentialCache`'s cached `notifyTargets`, so later read-triggered renewals keep re-registering webhooks for unwatched spaces. Also, `watch()` calls `registerWatcher` before `authorizeWatchedSpace`; if one space throws `SpaceCredentialError`, its `DmWatchState` and abort listener remain registered.
   - *Fix:* Call `this.notifyTargets.delete(space)` and `this.credentials.drop(space, { clearNotify: true })` inside `clearWatchState` (or add a `clearNotifyOnly` helper so valid credentials stay cached without `notify`), and clean up `watchState` in `watch()` if `authorizeWatchedSpace` throws.

5. **`L5` — Concurrent initial `DmClient.watch` calls on the same space can submit duplicate deterministic PoP proofs** (`apps/web/src/app/ui/dm-context.tsx:101-111`, `apps/web/src/app/ui/dm-conversation.tsx:58-68`, `packages/client/src/dm/dm-client.ts:741-760`):
   - Mounting `DmProvider` and `DmConversation` simultaneously triggers concurrent `client.watch` calls including `dmInboxUri(did)`. Under deterministic ECDSA (`@atproto/crypto` `P256Keypair` in Node clients/tests; browser WebCrypto P-256 uses random `k`), signing the same cached `SpaceCredential` produces identical `(jti, signatureInput, signature)` and trips `dmProofReplayCache` (`403 Credential proof has already been used`) on the second in-flight call.
   - *Fix:* Coalesce concurrent `authorizeWatchedSpace` calls per `space` in `DmClient` when `forceFresh === false`.

6. **`L6` — First-pass `SpaceKemError` in `encapsulate` skips `forceRefresh` DID retry, and `AUTHORITY_SUSPENSION_CODES` omits `RepoSuspended`** (`packages/protocol/src/atproto/space-credential-core.ts:267-268, 356-357`, `packages/protocol/src/atproto/repo-failure.ts:39`):
   - If a cached `#atproto_kem` key throws `SpaceKemError` inside `encapsulate(...)` on `forceRefresh = false`, `fetchVerifiedRepoStar` and `fetchWithVerifiedMac` abort immediately instead of retrying once with `forceRefresh = true`. Separately, `AUTHORITY_SUSPENSION_CODES` (`repo-failure.ts:39`) lists `RepoTakendown` and `RepoDeactivated` but omits `RepoSuspended` (which is declared in upstream `getRecord`/`getLatestCommit`/`listRepoOps` lexicons and `ACCOUNT_STATE` at line `35`).
   - *Fix:* Catch `SpaceKemError` around `encapsulate` when `!forceRefresh` and `continue`, and add `"RepoSuspended"` to `AUTHORITY_SUSPENSION_CODES`.

7. **`L7` — `buildHostSuspendedTasksResult` in `@flock/reader` does not deduplicate `authorityDid` in `setAside`** (`packages/reader/src/independent-tasks.ts:281-289`):
   - Appends `{ did: snapshot.authorityDid, reason, permanent: false }` even if `snapshot.setAside` already contains `snapshot.authorityDid` (diverging from `tasks-client.ts`'s `dedupeSetAside`).
   - *Fix:* Filter `snapshot.setAside` by `entry.did !== snapshot.authorityDid` before appending.

8. **`L8` — Minor `FakeNetwork` upstream fidelity nits & stale `listRepos` wording in `getChanges.json` / `codegen-lex.mjs`** (`packages/testing/src/fake-network.ts:827, 841, 1064-1161, 2016-2018`, `packages/protocol/lexicons/new/flock/operator/getChanges.json:7`, `scripts/codegen-lex.mjs:11`):
   - `FakeNetwork` throws `InvalidCursor` on non-TID `listWriters` cursors (upstream `listWriters.ts` performs plain `spaceRev > cursor` without `InvalidCursor`), runs `requireActiveSpace` before `requireAuthority` (`SpaceNotFound` vs upstream `NotAuthorized` for non-owners on nonexistent spaces), and rejects `""` `delegationToken` where upstream checks truthiness. Also, `getChanges.json:7` still says `listRepos` in its prose description, and `scripts/codegen-lex.mjs:11` error text mentions only `ATPROTO_PIN_CHECKOUT` while line `8` also accepts `ATPROTO_PINNED_CHECKOUT`.

---

VERDICT: READY
