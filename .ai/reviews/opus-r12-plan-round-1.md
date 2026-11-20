# R12 Plan Review — Round 1 (r12-claude, adversarial, read-only)

**Plan:** `atproto-slack-clone-r12/.ai/plans/r12-protocol-drift-progress.md` @ `9e22476`
**Upstream:** `atproto-spaces-r12` @ `6747610566eee1b6d743617bd8eb1136adccb362` (clean)
**Flock baseline:** `chore/protocol-drift-6747610` @ `9e22476` (clean)
**Method:** I checked every D12.x claim against upstream source (`packages/space/src`, `packages/star/src`, `packages/pds/src/api/com/atproto/{space,memberspace}`, `packages/pds/src/{space-notifications.ts,space-policy/manager.ts,actor-store/space/*}`, lexicons), against upstream's own migration guides `alpha-migrations/prompt-11-5-26.md` and `prompt-11-12-26.md` (the plan does not cite them, though they are the normative migration references), and against the current Flock code.

> Disclosure: one `git log -S` in `atproto-spaces-r12` lazily fetched promisor objects into `.git/objects`. That is a partial-clone side effect. The working tree, HEAD (`674761056`) and `git status` are unchanged. No files were edited in either repo.

---

## Verified correct (no action)
- `authorizeSpaceSync` input `{space, credentialKey, delegationToken?, clientAttestation?, notify?{endpoint,token≤512}}` and output `{credential, spaceRev?}`. It answers `SpaceDeleted` before authorization. Errors include `RegistrationNotConfirmed`, `RepoTakendown` and `RepoDeactivated` (from `assertActiveSpaceHost`, used only by `authorizeSpaceSync` and `listWriters`).
- `confirmRegistration {space, token, challenge} → {challenge}` is sent synchronously with a 10 s timeout through `safeClient`. `notifySpaceUpdate` is the union `defs#repoWrite | defs#repoRemoved | #spaceDeleted | #registrationExpired{spaceRev}`. A registration expires with the credential (`exp`, 10 min by default).
- dev-env sets `devMode: true` and `disableSsrfProtection: true` (`packages/dev-env/src/pds.ts:42,61`).
- `listWriters` sets `cursor = writers.at(-1)?.spaceRev` whenever the page has entries, so `length < limit` is the right termination test.
- `listRepoOps` returns `commit` on every page, plus a commit MAC header when requested. It returns 400 `RepoNotFound` when `buildCommit` is undefined (never written) and when the account does not exist (`assertRepoAvailability`).
- `getRepo` responds with `application/vnd.dasl.star`. `writeRepoStar` frames each pair as `0x01` + varint(key) + key + varint(val) + val and ends the archive with `0x00`. `LTHASH_STATE_BYTES` (2048) is no longer exported from the package index.
- `createSpaceSigHeaders({authorization, audience, keypair}) → {headers}` signs under label `sig`. `verifyCredentialSig(headers, keyId)` finds the signature by tag. The HPKE info string `"atproto-mac"` is applied internally in `kem.ts`.
- `putMembers {space, members≤100}` and `removeMembers {space, dids≤100}` are single commits. `PolicyMismatch` is still declared.
- Renames: `uri→space`, `did→spaceDid`, `removeWriter.repo`, `listRecords` drops `reverse` (default order stays `uri desc`, which matches FakeNetwork), and the four error renames.
- `title` replaces `name` in all 7 Flock space lexicons. Upstream `lexSpace` is a non-strict `z.object`, so a leftover `name` is ignored.
- The strict-expiry patch no longer applies (`packages/space/tests/credential.test.ts` was moved to `src/`), and the guard at `credential.ts:296` is unchanged. The rebase step is needed and correctly scoped.
- npm `alpha` = `0.0.0-spaces-alpha-20261117141222` for every listed package. `223114799..674761056` has an empty diff on `lexicons/`, `space`, `star`, `crypto`, `xrpc-server` and `oauth-client*`. The non-empty diff is in lex-schema/lex-builder/lex-space/oauth-scopes, which Flock does not consume directly.

---

## Blocker

### B1 — D12.3 / D12.3b notify-token model contradicts upstream and opens a notification-withdrawal DoS
**(a) Rotating the token on every renewal (`pending_token → token`) is wrong.** Upstream identifies a registration by `(space, endpoint, token)`, confirms only *new* registrations, and renews whenever the same pair re-authorizes (`authorizeSpaceSync.ts` `getNotifyRegistration` → `confirmRegistration` → `putNotifyRegistration`). The 11-12 migration guide §4b is explicit: *"Use a different token for each space, and keep it stable across authorizations… A different token creates a separate registration… Renewals are not confirmed again."* With rotation, every renewal (~7 min per space) does all of the following:
- forces a synchronous confirm round trip;
- creates a new PDS registration while the old one stays active until its `exp`, so deliveries to the old token are duplicated and get 400s;
- opens a race between the sweeper and the out-of-band `#registrationExpired` renewal (D12.3 §3). Both overwrite `pending_token`, so one in-flight `confirmRegistration` fails and `authorizeSpaceSync` returns `RegistrationNotConfirmed`.

The `token`/`pending_token` migration exists only to support this rotation.

**(b) The stateless DM token is shared and handed out too widely.** `"dm." + HMAC(space)` is deterministic per space. `getDmNotifyTarget` is guarded by `authorizeDmSubscription`, which restricts **only inboxes** to their owner. Any authenticated Flock user is allowed for any conversation half (`apps/operator/src/lib/dm-subscription.ts`: "A conversation half cannot be checked here"). Upstream `authorizeSpaceSync` is **unauthenticated**, and on any policy refusal it calls `removeNotifyRegistration(space, notify)` (`authorizeSpaceSync.ts` ~L83–95). A member-only space with no delegation token is refused with `SpaceNotFound` (`space-policy/manager.ts:246`). The attack: obtain the token from `getDmNotifyTarget`, then POST `authorizeSpaceSync{space, credentialKey, notify:{operatorOrigin, token}}` with no delegation token. The participants' registration is deleted, and this can be repeated forever. The same token also lets anyone forge `notifySpaceUpdate` wakes.

**Fix:**
- Operator spaces: one random 32-byte token per space, generated once and persisted. Drop `pending_token`. Renew with the same `notify` every time.
- DM spaces: one token per caller, e.g. `"dm1." + base64url(callerDid) + "." + base64url(HMAC(k, space ‖ callerDid))`, bound to the authenticated DID in `getDmNotifyTarget`. This stays stateless (verify by recomputing), keeps the zero-DM-rows invariant, and lets an attacker withdraw only their own registration.
- Add regression tests for both: same-token renewal is not re-confirmed, and a refused foreign `authorizeSpaceSync` cannot withdraw a victim's registration.

---

## High

### H1 — No gap detection or catch-up for 10-minute best-effort registrations
- Upstream replaces the first update after a lapse with `#registrationExpired`; that update itself is never delivered (`util.ts` `deliverSpaceUpdate` → `claimLapsedNotifyRegistrations`).
- `#repoWrite` and `#repoRemoved` delivery is best effort, with no retry (failures only call `spaceLogger.warn`).
- The 11-12 guide (§4c) requires: *"reauthorize with notify and catch up through listWriters from the checkpoint"* and *"Detect gaps from prevSpaceRev, or by comparing the spaceRev from authorizeSpaceSync with the checkpoint."*

The plan has none of this. The operator's `space_notification` has **no `space_rev` column**: it stores `space_uri, space_type, type_seq, repo_did, rev, notified_at`, so D12.3b's claim that it stores `space_rev` is wrong. Specify:
- a per-registration `last_space_rev`;
- emit a wake (so `ChangeFollower` reconciles through `listWritersSince`) when any of these happen: `prevSpaceRev ≠ last_space_rev`, `authorizeSpaceSync.spaceRev > last_space_rev` on renew/re-register (including at operator start after downtime), or `#registrationExpired` arrives;
- tests for a missed delivery during an operator restart.

### H2 — The renewal loop is unchanged in ways that break a 10-minute TTL, and it scales badly
- **Backoff is too slow.** `registerSpace`'s failure backoff stays at `FIRST_RETRY_MS = 30 min` and `LONGEST_RETRY_MS = 60 min` (`registrations.ts`), and `isDue` honours `next_attempt_at`. One transient failure therefore means ≥30 min with no notifications. Shrink it to about 15 s → 2 min, capped below `RENEW_WITHIN_MS`.
- **The 60 s sweep is expensive.** It runs the full `sweepRegistrations`, which for every journaled workspace calls `restoreAuthorityGrant` and `activeSpaces` (`directoryRecords` + `activeInstalls` + `activeExtInstalls` + `appInboxState`/`spaceExists` per install) **before** `isDue` filters anything. That is O(workspaces × PDS reads) every minute even when nothing is due, on top of `getDelegationToken` + `authorizeSpaceSync` per space every ~7 min.
- **Fix:** split the loop into a DB-driven fast renewal (only rows with `expires_at − now ≤ RENEW_WITHIN_MS`, one grant restore per authority, parallelism-bounded) and the existing 30 min backfill sweep. Derive the renew window from the credential's own `exp − iat`, because the PDS may issue lifetimes up to 1 h.

### H3 — The `repo-failure.ts` change would reverse per-writer takedown semantics; `AccountTakedown`/`AccountDeactivated` are missing
- **Per-writer errors must stay permanent.** R12b says "`repo-failure.ts` (`RepoTakendown`/`RepoDeactivated` non-lost classification!)". On space *repo reads* (`listRepoOps`, `getRepo`, `getRecord`, `listRecords`, `getLatestCommit`), these errors describe the **writer's** account (`sync/util.ts assertRepoAvailability`). The 11-5 guide §2a says *"already returned these errors for a taken-down or deactivated repo, and still do."* Flock's `classifyRepoFailure` deliberately treats them as `permanent: true`, so it stops serving a taken-down member's data. Only the *authority* errors on `authorizeSpaceSync` and `listWriters` must be non-destructive, and that is already true today: `exchangeSpaceCredential` maps them to `XrpcError(400)`, not `SpaceCredentialError`, so `isAccessLost` is false. Restrict the change to those two call sites, keep `ACCOUNT_STATE` intact, and add a test that a taken-down *writer* is still set aside.
- **New 401 errors are not handled.** Management methods (`createSpace`, `updateSpace`, `deleteSpace`, `removeWriter`, `putMembers`, `removeMembers`) now answer `AccountTakedown`/`AccountDeactivated` as **HTTP 401** (11-5 §2b). The plan does not mention this. Without handling, the operator may read the 401 as an expired authority grant (re-auth or a stalled-operation storm) instead of a suspension.

### H4 — The D12.11 reader boundary is false, and the reader is missing a dependency and a file
- **The boundary is wrong.** `@flock/reader` **depends on and imports `@flock/protocol`**: `packages/reader/package.json` lists `"@flock/protocol": "workspace:*"`, the `eslint.config.mjs` header says "the reader only the protocol", and `independent.ts`, `independent-tasks.ts` and `independent-dm.ts` import `space-credential-core`, `record-pages`, `repo-failure` and so on. Telling r12-reader to implement `authorizeSpaceSync`, `listWriters`, MAC and STAR logic "independently" would fork the protocol core and threaten `reader-parity`. Correct rule: the reader must not import `@flock/client`, `@flock/operator` or UI, and it consumes the R12b protocol APIs.
- **A dependency is missing.** `independent-tasks.ts:3` imports `StarParseError` from `@atproto/space`, which no longer exports it (it moved to `@atproto/star`, per 11-5 §3). Either add `@atproto/star` to `@flock/reader`, which D12.1 omits and `import/no-extraneous-dependencies` will catch, or use the protocol re-export.
- **A file is missing.** R12c does not list `independent-dm.ts` / `independent-dm.test.ts`.

### H5 — DM watch couples DM reads to operator availability; the scope change is unplanned
- **Operator failure breaks DM reads.** Routing `notify` through `CredentialCache.get(space, {notify})` means a `RegistrationNotConfirmed` (operator down or slow >10 s, SSRF in production, token mismatch) fails the **credential mint itself**, and with it every DM read on that tab. Specify a fallback: on `RegistrationNotConfirmed` (or any `getDmNotifyTarget` failure), mint without `notify` and retry registration with backoff. Never block reads.
- **The scope string changes for everyone.** `dmScopes` does not exist in `scopes.ts`. `memberGrantScopes()` already includes `operatorMethodsScope(OPERATOR_METHODS, …)`, so adding `OPERATOR_METHOD.getDmNotifyTarget` changes the member OAuth scope string. Every existing session then lacks `rpc:…lxm=new.flock.operator.getDmNotifyTarget` and gets `ScopeMissingError` until it re-consents. Plan for re-consent and graceful degradation, and fix the phantom `dmScopes` reference.

### H6 — Upstream `publicWrite` change silently breaks DM inbox mode switching
`space-policy/manager.ts:287`: *"A member without write access stays excluded even under publicWrite"* (11-12 §2a). Flock's `applyRequestMode` sets members dormant (`write:false`) in "nobody" mode, and "everyone" mode only flips `publicWrite` while leaving them dormant (`dm-client.ts` ~L141–175). After nobody → everyone, exactly the user's allowlisted contacts can no longer have requests tracked, while strangers can. The plan does not address this. Options: reactivate dormant entries when switching to "everyone", or remove instead of dormant. Add an acceptance test for nobody → everyone → request from a dormant contact.

---

## Medium

- **M1 — The D12.4 MAC API is mis-specified.**
  - `createCommitMacHeaders(commit, params)` and `createRecordMacHeaders(uri, cid, params)` take `CreateMacParams = MacRequest & {sharedSecret}`, i.e. `{label, keyShare, signatureParams, sharedSecret}` from `parseMacRequest` + `decapsulate`. They do not take `{secret, clientKeyShare, kemKeypair}`.
  - The `Accept-Signature` keyid is the per-request **ephemeral** `encapsulate(authorKemKey).keyShare`, not `macKeyPair.did()`.
  - `VerifyMacParams = {keyShare, sharedSecret, headers: Headers}`.
  - `unwrapMacKey` does not exist. Flock already uses `encapsulate`/`decapsulate`, so `info="atproto-mac"` comes with the dependency update.
  - Missing items:
    - An invalid KEM key now throws **`SpaceKemError`**, not `SpaceMacError`, so `isUnverifiableRepo` (`kem-key.ts:48`) and `getSpaceMacRequest`-style mapping must include it.
    - `verifyCommit` throws `SpaceRepoVerificationError` for a wrong repo or space.
    - `fetchVerifiedRepoStar`'s retry depends on `error.message === "commit failed verification"` and must switch to `instanceof SpaceMacError`.
    - Type renames: `Commit` → `SpaceCommit`, plus branded `DidString`/`SpaceRefString`/`TidString`.
- **M2 — The D12.5 `starEntryBytes` formula is wrong.** The plan says `1 + entryHeaderBytes + cidBytes + recordByteLength`, but a STAR pair has **no CID**. The correct formula is `1 + varint(keyLen) + keyLen + varint(valLen) + valLen`, where key is `collection/rkey`. Also, the magic is now 4 bytes (`2a 6c 01 00`), which `starHeaderBytes` handles because it uses `writeRepoStar(commit, [])`.
- **M3 — D12.6 full-listing semantics are wrong.**
  - "Ignore `#repoRemoved` in full listing" fails under pagination. `listBoundedRepos` is latest-entry-wins per DID, so a `#repoWrite` on page 1 followed by a later `#repoRemoved` must **delete** the entry.
  - Removed entries must not count toward `maxRepos` or `truncated`.
  - `listWriters.cursor`: *"Removed repos may be garbage collected after 72 hrs, so a syncer whose last seen space revision is older should list the whole writer set instead."* Incremental `listWritersSince` from a checkpoint older than 72 h must fall back to a full listing, otherwise D14 eviction can be missed.
- **M4 — D12.9 / R12f ACCESS_FULL facts are wrong.** `authorizeSpaceSync` has **no auth verifier**: it is body-authenticated by the delegation token. `listWriters` uses `spaceCredentialAuth`. Neither can return `Bad token scope`. Assert the app-password ban on `getDelegationToken`, `createRecord` and the other `authorization({scopes: ACCESS_FULL})` routes, and keep FakeNetwork's `authorizeSpaceSync` free of session auth.
- **M5 — Lexicon/codegen scope is incomplete, and the R12a command fails.**
  - `scripts/codegen-lex.mjs` also compiles `com/atproto/{managedspace,personalspace}`. Upstream renamed `managedspace.checkUserAccess` → `checkAccess` (new shape: `repo?`, `{read, write}`) and changed both `policy.json` files; `personalspace` reads are now "authority and authorized apps", which affects FakeNetwork's `PERSONALSPACE_POLICY` semantics. Add a sync step for these.
  - Codegen reads **`ATPROTO_PIN_CHECKOUT`**, but R12a runs `ATPROTO_PINNED_CHECKOUT=… pnpm codegen:lex`, so it will throw.
  - `protocol-tests/support/app-fixture.ts` still defaults to `../atproto-spaces-phase3`.
- **M6 — The `NOTICE_METHOD` / operator parsing facts are wrong.**
  - `NOTICE_METHOD` today has only `notifyWrite` and `notifySpaceDeleted`; `registerNotify`/`unregisterNotify` are not in it.
  - Adding `notifyRepoUpdate` (repo PDS → authority PDS) and `notifyCredentialsRevoked` (authority → repo PDS) is wrong: the operator receives neither, and `methods.ts` routes the entries in `NOTICE_METHOD`.
  - `parseWriteNotification`'s `ALLOWED_KEYS` rejects unknown keys, so passing the `update` union object (which carries `$type`) silently rejects every `#repoWrite`.
  - `recordWriteNotification` takes `{space, repo, repoRev}`, not `{rev, spaceRev, prevSpaceRev, data}`.
- **M7 — The wave exit gates cannot run.** No workspace package defines a `test` script (`packages/*`, `apps/*` scripts are `[]`, apart from web dev/build/start), so `pnpm --filter @flock/protocol test` and the others fail. Use `node --import tsx --test 'packages/protocol/src/**/*.test.ts'` and similar. Also, R12b runs r12-fakenetwork (which owns `packages/testing/src/space-credential-core.test.ts`) in parallel with r12-protocol rewriting the API under test. Move that test to r12-protocol or sequence the two.
- **M8 — File ownership conflict and unowned files.** `protocol-tests/atproto/README.md` is owned by **both** r12-protocol-tests (L217) and r12-bdd (L226). No worker owns these stale files: `SPEC.md`, `docs/protocol/operator-contract.md`, `docs/operations.md`, `docs/prd/atproto-slack-implementation-plan.md`, `protocol-tests/atproto/platform-spike-k{2,5}*.test.ts`.
- **M9 — `#spaceDeleted` confirmation.** Upstream says *"Only a SpaceDeleted answer confirms the deletion… Don't drop data on the notice alone."* The plan confirms only "when an active authority grant exists". It must always confirm through `authorizeSpaceSync`, and never purge when confirmation is impossible.
- **M10 — "Clean overrides" is unsafe.** `pnpm-workspace.yaml` documents that the overrides exist because `^0.0.0-spaces-alpha-*` ranges match stray `0.0.0` releases that cannot install. Re-pin every override to `20261117141222`; do not remove them.
- **M11 — The 400 semantics are overstated.** A 400 on `#repoWrite`/`#repoRemoved` is only logged and does not drop the registration. Only rejecting `#registrationExpired` drops it (`space-notifications.ts abandonSyncerNotice` / `removeLapsedNotifyRegistration`), and expiry and deletion notices are retried for ≥72 h. An unregistered space keeps receiving best-effort calls until `exp` plus the next update. Fix D12.3 §2 ("drop immediately") and the matching test expectations.

## Low
- **L1** The header says `../atproto-spaces-r12` is "built", but it has no `node_modules` and no `dist`; R12a must build it. Upstream build quirks (`PUPPETEER_SKIP_DOWNLOAD`, `oauth-provider-ui i18n:compile`, `build:tooling` for `packages/lex-cli/dist`) should be noted.
- **L2** `UnsignedEmptyRepoOpsError` exists only in `client/src/sync.ts`. The protocol-side special case is `macVerifies` (`space-credential-core.ts` L652–663), plus `fetchRepoOpsPages` L1482–1497 rejecting `commit` together with `cursor`. Name these precisely.
- **L3** Upstream `listMembers.ts` does not emit `$type`; do not require `#member` `$type` on items.
- **L4** Moving stable `oauth-client-node/browser`, `identity`, `xrpc`, `jwk-jose` and `lex-cli` to alpha is outside Spaces scope (11-12: "Upgrade only existing direct dependencies involved in Spaces"). Codegen uses the checkout's `packages/lex-cli`, not npm. Justify the move or drop it.
- **L5** Cite `alpha-migrations/prompt-11-5-26.md` and `prompt-11-12-26.md` as the normative checklist, especially their regression-test menus.
- **L6** Gate 4 needs the concrete steps (copy `slack-*` into `packages/pds/tests/space/`, then `pnpm --filter @atproto/pds exec jest … tests/space`).
- **L7** In production the notify endpoint must be public HTTPS (`safeClient` SSRF). Document this in ops and pin docs.
- **L8** Republish the space lexicons (`title`) wherever Flock publishes them for consent screens.

---

## Summary
The breadth is good: the plan catches most wire renames, STAR, every-page commit, putMembers, title, and the patch rebase. But the core new mechanism, continuous notification registration (D12.3/D12.3b), is designed against upstream's normative guidance:
- rotating tokens and a shared, widely issued DM token (B1);
- no gap catch-up (H1);
- renewal and backoff unfit for a 10-minute TTL (H2);
- DM reads coupled to operator liveness (H5).

Separately:
- the takedown reclassification would regress per-writer moderation semantics (H3);
- the reader-boundary decision is factually false (H4);
- an upstream `publicWrite` semantic change breaks DM request modes (H6).

Several API signatures and test facts (M1, M2, M4, M6) and the wave gates and ownership (M7, M8) also need correcting before the waves start.

VERDICT: REVISE
