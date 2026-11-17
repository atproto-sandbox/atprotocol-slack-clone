@coordinator [done] Round 2 strictly read-only verification of `.ai/plans/r11-tasks-progress.md` (Draft v2) against the post-R10 codebase and `../atproto-spaces-phase3`.

## 1. Round 1 Resolution Verification
- **Round 1 Blockers — RESOLVED:**
  - **`LtHash` 2048B accumulator vs 32B digest (`r11-tasks-progress.md:61-67,78,87`):** Correctly separates `LtHash.state()` (2048 bytes) from `commit.data` (`digest()`, 32 bytes), forbids initializing non-empty `setHash` from `getLatestCommit` alone, and seeds non-empty repos (including `followRepoOps`) via `fetchVerifiedRepoStar` or full `listRecords` (`excludeValues: true` for tailing) matched against MAC-verified `getLatestCommit`.
  - **Removed-writer transitivity & DAG oracle (`r11-tasks-progress.md:104-110,199`):** Replaces 1-hop antichain `s` with fixed-width 128-bit `opRef` full ancestor closure up to `MAX_ANCESTOR_REFS = 256`, preserving `D -> B -> R` transitivity when `B` is removed/purged under `D14`; specifies deterministic `>256` overflow retention (un-superseded lifecycle ops + newest ops) and replaces the old scalar-vector `oracle.mjs` with a dedicated full-DAG event-history oracle test (`entity-merge-oracle.test.ts`).
- **Round 1 Highs — RESOLVED:**
  - **`listRepoOps` MAC gating & binary STAR (`r11-tasks-progress.md:56-60,76-79`):** Strictly scopes omitted-`commit` allowance to `listRepoOps` (`(ops.length > 0 && cursor)` or `(ops.length === 0 && !cursor)`), adds `stagedCids` `prev`-chain validation + equal-`rev` response-order preservation + materialized `RepoCommit.fromRecords` check, and moves `getRepo` to dedicated `SpaceCredential.fetchVerifiedRepoStar` buffering records until EOF `repo.matches(commit)` completes.
  - **Writer universe & `RepoNotFound` (`r11-tasks-progress.md:44-46,80-83,114`):** Intercepts `RepoNotFound` before `classifyRepoFailure` (`repo-failure.ts:24`), derives a verified workspace snapshot (`workspaceSnapshotComplete`), preserves `union(listRepos, verifiedRoster)` until both omit an evicted writer, and specifies dropping orphaned `*Edit` / `taskComment` records when a removed author's root record is gone.
  - **`AppRuntime` (`followRepoOps`) (`r11-tasks-progress.md:84-90`):** Separates current-state verification from host-ordered delivery within retained oplog history, adds `deliver = false` baseline seeding, STAR reset deduplication, and deferred cursor commit on handler ack/retry (`MAX_ATTEMPTS = 3`, `MAX_HOLD_MS = 10 min`), and corrects `AppRuntime.throttles` vs `KeyWindow` ownership.
  - **Web UI routing & OAuth `returnTo` (`r11-tasks-progress.md:154-160`):** Moves loopback redirect into `apps/web/src/proxy.ts` with `/^\/(?![\/\\])/` + `origin` validation, captures `returnTo` before `LoginForm` cleanup (`clearAccountScopedState` + `replaceState`), validates in `OAuthCallbackView` via `new URL(raw, "https://local.invalid")`, and clarifies single-pass `encodeURIComponent` for `did:web:localhost%3A3000`.
  - **ESLint flat-config boundaries (`r11-tasks-progress.md:162-164`):** Explicitly spreads existing `BROWSER_CODE` patterns into overlapping blocks, bans relative/dynamic imports + re-exports, adds `@atproto/space` / `@atproto/lexicon` to `packages/reader/package.json`, and requires a negative ESLint fixture test.
- **Round 1 Mediums & Lows — RESOLVED:**
  - `IndexedDbStore` v1 -> v2 guarded `onupgradeneeded` + dedicated `activity` & `clock` stores (`:166-169`), executable `advanceHlc` rules & account-wide `reserveTid` (`:97-103,125`), `observedContext` concurrency protection (`:127-131`), equal canonical value suppression & `REGISTRY` `clearField` / `add∩remove` checks (`:117-120`), `extSpaceSkey` `<= 128` bound (`:51`), `15 -> 17` `PERSISTED_KINDS` + `removeMember` `ScopeMissingError` safety (`:141-148`), `64 KiB` vs `1 MiB` distinction (`:31`), and concrete Tasks workload + `package.json` suite registrations (`:171-176,192,206,216,220`).

---

## 2. Remaining Minor Findings (Non-Blocking Refinements)

1. **Medium — `uncertainAncestry: true` should not trigger on normal `D14` dangling `opRef`s (`r11-tasks-progress.md:108-109`)**
   - Line 108 marks an entity `uncertainAncestry: true` (`historyLimitReached: true`) whenever *"an entity exceeds `MAX_ANCESTOR_REFS = 256` OR any op references a dangling `opRef` absent from currently synced valid records"*.
   - Because `s` stores the **full transitive closure** (up to 256 refs), when Bob leaves/is removed (`D14` purges Bob's records), Bob's `opRef` becomes permanently dangling inside Alice's/Charlie's subsequent `s` arrays — yet zero transitivity between surviving writers is lost as long as `|closure| <= 256`! Triggering `uncertainAncestry` on dangling refs would permanently show `"history limit reached"` on normal 3-edit tasks after any member leaves.
   - **Adjustment:** Set `uncertainAncestry: true` only on `> 256` ancestor truncation/overflow (or detected cycle/tampered `s`), not on benign `D14` dangling `opRef`s when `s.length < 256` and `complete === true`.

2. **Medium — Two small contract details in `observedContext` and `listRecords(excludeValues: true)`**
   - **`observedContext` closure (`r11-tasks-progress.md:128-131`):** `observedContext` names `baseFrontier: string[]`, whereas `D11.4 #3` requires `s` to carry the full transitive closure (`baseClosure`, up to 256 `opRef`s). Rename/clarify `baseClosure` so an implementer does not accidentally pass only minimal heads and drop ancestor refs.
   - **`listRecords(excludeValues: true)` (`r11-tasks-progress.md:66,87`):** `assertBoundedRecordPage` (`packages/protocol/src/atproto/record-pages.ts:42-44`) currently rejects `record.value === undefined`, and `FakeNetwork.listRecords` (`packages/testing/src/fake-network.ts:639-646`) requires `params.collection` and always returns `value`. Note both updates explicitly in R11a.

3. **Low — Cleanly disabled extension state & `@atproto/lex-data` in `packages/reader`**
   - **`r11-tasks-progress.md:147`:** Distinguish `"disabled"` (member removal completed by `disableExtension`) from `"disabling"` / `"enabled"` on `new.flock.ext.install` (e.g., `disabledAt` / `cleanupComplete` written after `extension-verified`), so a workspace that cleanly disabled Tasks does not wedge `removeMember` if an authority grant is later narrowed.
   - **`r11-tasks-progress.md:164`:** `packages/space/src/index.ts` does not re-export `parseCid` (`../atproto-spaces-phase3/packages/space/src/index.ts:1-12`), so `packages/reader/package.json` will also need `@atproto/lex-data` (or an allowed protocol helper) if `independent-tasks.ts` imports `parseCid` directly.

---

**VERDICT: READY**
