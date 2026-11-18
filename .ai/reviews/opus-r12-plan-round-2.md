# R12 Plan Review — Round 2 (r12-claude, adversarial, read-only)

**Plan:** `.ai/plans/r12-protocol-drift-progress.md` @ `83b15b3c` (diff `9e224765..83b15b3c`)
**Inputs:** `.ai/reviews/opus-r12-plan-round-1.md`, `.ai/reviews/codex-r12-plan-round-1.md`, upstream `atproto-spaces-r12` @ `674761056`, Flock tree @ `83b15b3`.
No files were modified in either repo; both working trees are clean.

---

## 1. Round 1 resolution matrix

| R1 finding | Status | Evidence in revised plan |
|---|---|---|
| Opus B1(a), Codex #5: rotating operator token | **Resolved** | D12.3.2: one token per space, persisted before the first `authorizeSpaceSync` and reused on every renewal. `pending_token` dropped. |
| Opus B1(b), Codex #2: shared DM token, cross-caller withdrawal | **Resolved for DoS** (see N5) | D12.3b.2: `dm1.<did>.<exp>.<hmac(space‖did‖exp)>`, bound to the caller. |
| Opus H1: no gap catch-up | **Resolved** | D12.3.3–4: `last_space_rev`, a `prevSpaceRev` gap wake, a wake on `authorizeSpaceSync.spaceRev` ≠ checkpoint, and a wake on `#registrationExpired`. |
| Opus H2, Codex #6: backoff and sweep cost/overlap | **Resolved in design** (see N1) | Backoff 15 s → 2 min, SQL-first 60 s loop, heartbeated lease, 30 min backfill. |
| Opus H3: per-writer takedown and management 401 | **Resolved** (see N3) | D12.6.2 |
| Opus H4, Codex #9: reader boundary and `@atproto/star` dep | **Resolved** | D12.1.3, D12.11, R12c (`independent-dm*` included) |
| Opus H5: DM reads coupled to operator; scope change | **Resolved** | D12.3b.1, D12.3b.3: fall back to minting without `notify`; `ScopeMissingError` degrades without breaking reads; phantom `dmScopes` removed. |
| Opus H6: `publicWrite` vs dormant members | **Resolved** | D12.8.2 (reactivate on "everyone"), plus an acceptance test. |
| Codex #4: discriminants | **Resolved** | D12.3.3: `notifySpaceUpdate#{registrationExpired,spaceDeleted}`, `defs#{repoWrite,repoRemoved}`. |
| Opus M1, Codex #3: MAC API | **Resolved** (one nit, N6) | D12.4.2 |
| Opus M2, Codex #11: `starEntryBytes` | **Resolved** | D12.5.2 |
| Opus M3: full-listing latest-wins and 72 h GC | **Resolved** | D12.6.1 |
| Opus M4, Codex #8: ACCESS_FULL | **Resolved** | D12.9 |
| Opus M5, Codex #1/#12: env var, managed/personal lexicons, `opEntry.rev`, `dm.spec.ts` | **Resolved** | D12.1.1, D12.10.2, D12.7.1, D12.4.2 |
| Opus M6: NOTICE_METHOD and `parseWriteNotification` | **Resolved** | D12.3.1, D12.3.3 |
| Opus M7, Codex #13: gates and ownership | **Resolved** (see N8) | Real `node --test` gates; `space-credential-core.test.ts` moved to r12-protocol; README has a single owner. |
| Opus M8: unowned docs | **Resolved** | R12f.1 |
| Opus M9: `#spaceDeleted` confirmation | **Resolved** | D12.3.3: always confirm through `authorizeSpaceSync`. |
| Opus M10: overrides | **Resolved** | D12.1.3 |
| Opus M11, Codex #7: 400 semantics | **Resolved** | D12.3.3 |
| Codex #10: dependency closure and dev-env build graph | **Resolved** | D12.1.2–3 |
| Opus L1–L8 | **Resolved** (L6 partially, see N7) | Header, citations, stable OAuth pins, `$type` note, HTTPS/republish docs. |

Every Round 1 Blocker and High is resolved. Below are the gaps and regressions introduced or left by the revision.

---

## 2. New / remaining findings

### Medium

**N1 — The D12.3 schema does not support the queries and lifecycle it specifies, and the upgrade path leaves legacy rows un-renewed for up to about 24 h**

The schema gap:
- D12.3.2 adds only `token` and `last_space_rev` to `notification_registration`.
- But the token lifecycle writes `next_attempt_at` and `consecutive_failures` into that row.
- The fast loop queries `notification_registration WHERE expires_at <= ? AND next_attempt_at <= ?`.
- D12.3.5 derives `renewWithinMs` per row from `exp − iat`.

None of `next_attempt_at`, `consecutive_failures` or the per-row TTL exist on that table today. Failures live in `notification_registration_failure(failures, next_attempt_at)`, and `iat`/TTL is not persisted. Also, `expires_at <= now` would select rows only *after* they lapse. It must be `expires_at − renewWithin <= now`.

The upgrade gap:
- Migrated legacy rows have `token = ''` and a registerNotify-era `expires_at` up to ~24 h in the future.
- Neither the due query nor the existing `isDue` (`expires_at − now <= RENEW_WITHIN_MS`) selects them.
- Upstream dropped all registerNotify registrations (actor-store migrations 007–009, per 11-12 §10).
- So after deploy, workspace notifications are dead until those stale `expires_at` values come due.

Fix:
- Add `renew_at` (or `credential_ttl_ms`) to the migration, or join `notification_registration_failure` for backoff.
- Make the due predicate `token = '' OR renew_at <= now`.
- In the same migration, set `expires_at = 0` for rows with `token = ''`.
- Add a db-migration test.

**N2 — The token check must replace the existing `isNotificationAccepted` expiry grace, or first registrations and expiry notices break**

`notices.ts:19 isNotificationAccepted` accepts only rows with `expires_at > now − 5 min`. If the new `confirmRegistration` and `notifySpaceUpdate` handlers keep that gate, which is the natural reuse, two things break:
- The first-time confirm against the placeholder row (`expires_at = 0`) fails. Every new registration then gets `RegistrationNotConfirmed`.
- A `#registrationExpired` arriving more than 5 min after lapse (operator downtime, the PDS's 1 min → 12 h retry backoff) gets a 400. The PDS's `abandonSyncerNotice` then drops the registration, which defeats D12.3.3's renew-on-notice.

The plan should state that the **token match alone** (stored `token` for operator spaces, valid HMAC and unexpired `dm1` for DM) authenticates both handlers, regardless of `expires_at`. Add regression tests for confirm on a placeholder and for `#registrationExpired` arriving more than 5 min after lapse.

**N3 — Authority suspension also hits the authority's own repo as a writer; the D12.6.2 "keep data intact" promise fails there**

The space authority is also a writer in its own space (directory, roster, admin records and so on). While it is suspended:
- `listRepoOps`, `getRepo`, `getRecord` and `getLatestCommit` against the **authority's repo** return 400 `RepoTakendown`/`RepoDeactivated`. This comes from `assertRepoAvailability(ctx, repo, false)` under credential auth.
- Credentials already issued stay valid (11-5 §2a), so incremental follow paths can reach these reads without first going through `authorizeSpaceSync`/`listWriters`.

With `ACCOUNT_STATE` kept `permanent: true` for every writer, the authority's records are set aside. That contradicts D12.6.2 and the R12f regression "Authority RepoTakendown/RepoDeactivated keeps local data intact". Specify: when `repo === requireSpaceAuthority(space)`, classify `RepoTakendown`/`RepoDeactivated` as transient suspension, in both `SyncCore` and the reader. Keep `permanent` for every other writer, and add a test for each case.

**N4 — The cross-wave `authorizeSpaceSync` interface contract was dropped from the plan**

The revision removed R1's explicit R12b item for the protocol-layer exchange. It is now specified nowhere, yet R12c (operator renewal, `spaceRev` catch-up) and R12d (DM `notify`, the `RegistrationNotConfirmed` fallback) both depend on it. Pin this in D12.4 or a new D12.3c, owned by r12-protocol:
- `exchangeSpaceCredential` POSTs to `/xrpc/com.atproto.space.authorizeSpaceSync` (replacing `GET_SPACE_CREDENTIAL`) with `{space, credentialKey, delegationToken, notify?}`, not `credentialKid`. It returns `{credential, spaceRev?}`.
- `mintSpaceCredentialWith(deps, space, opts?: {notify?})` returns a `SpaceCredential` that exposes `spaceRev`.
- `CREDENTIAL_REFUSALS`: `UserNotAuthorized` → `AccountNotAuthorized`. `RegistrationNotConfirmed`, `RepoTakendown` and `RepoDeactivated` stay non-refusal `XrpcError`s (400).
- `CredentialCache.get(space, {notify})` semantics: re-mint when `notify` changes or is newly added.
- The operator's `apps/operator/src/atproto/space-credential.ts` (`mintSpaceCredential`) consumes this. R12c does not list that file.

### Low

- **N5 — The DM token's built-in `exp` brings back token rotation.**
  - The ~20 min TTL changes the token on every refresh. Each refresh creates a new PDS registration, a synchronous `confirmRegistration`, and an overlap window with duplicate deliveries. That is the churn B1(a) removed, against 11-12 §4b ("keep it stable").
  - Per-caller binding already prevents cross-caller withdrawal, so a stable per-caller token (rotated only on a key-version bump) is simpler.
  - If the `exp` stays, add `expiresAt` to the `getDmNotifyTarget` output.
  - Residual risk: non-members can still obtain a token for any conversation half (`authorizeDmSubscription` checks only inbox ownership) and forge content-free wakes. Today any DID can already file notices for its own DM spaces (`notices.ts` comment), so this is not a new class, but document it in SPEC/ARCHITECTURE.
- **N6** D12.4.2 writes `verifyCommit(commit, {space, repo})`. The real `VerifyCommitParams` is `VerifyMacParams & {space, repo}` and also needs `{keyShare, sharedSecret, headers}`. Likewise `verifyRecord(record, {uri, keyShare, sharedSecret, headers})`.
- **N7** The D12.1.2 requirement to build "under Node v22.17.0" is unnecessary and conflicts with upstream `devEngines` (`node ^22.23.4`). Every Node 22.x has `NODE_MODULE_VERSION` 127, so Node ≥22.23.4 satisfies both upstream and the root `engines` (`>=22.12.0 <23`) without bypassing engine checks. Gate 4's jest command also drops `NODE_OPTIONS=--experimental-vm-modules … --runInBand`, which the pin doc records as required.
- **N8** `packages/testing/src/space-credential-core.test.ts` (now r12-protocol) imports `FakeNetwork`, which r12-fakenetwork rewrites in parallel. Expect red until both land; have the two workers agree the wire fixtures first.
- **N9** D12.3.3 lists `token` among `parseWriteNotification` keys, but `token` is in the outer `notifySpaceUpdate` body, not in `update`. Parse `{space, token, update}` first, then validate `update` by `$type`.

---

## 3. Verdict rationale
The revision resolves every Round 1 Blocker and High, and nearly all Mediums and Lows, accurately against upstream. No new Blocker or High was introduced. Four Medium spec defects remain in locked decisions:
- **N1:** the schema/query mismatch would leave notifications dead for up to ~24 h after upgrade;
- **N2:** reusing the grace gate breaks first registrations and expiry notices;
- **N3:** the authority-as-writer case contradicts a stated acceptance criterion;
- **N4:** the cross-wave API contract is missing.

Each would very likely become a production bug or a gate failure. They are small targeted edits, not a redesign; after those edits the plan is ready to execute.

VERDICT: REVISE
