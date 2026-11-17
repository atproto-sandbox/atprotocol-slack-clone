# R11 Implementation Review — Round 1 (`Gemini 4 Carbon (High)`)

- **Reviewer:** `@review-opus-2` running on **`gemini-4-carbon-high` (`Gemini 4 Carbon (High)`)**
  - *Model note:* Independent fallback reviewer assigned by `@coordinator` (`#84`) after all Claude Opus 5.5 surfaces were unavailable (`claude-opus-5-5-*` at `0%` AGY quota until `2026-11-22T23:52:43Z`; `opencode` `anthropic/claude-opus-5-5` & `claude` CLI OAuth tokens expired; `opencode/claude-opus-5-5` & `openrouter/anthropic/claude-opus-5.5` insufficient credits; `amazon-bedrock/anthropic.claude-opus-5-5` expired SSO token).
- **Mode:** Strictly read-only static, protocol, security, concurrency, causal-merge, sync, operator, routing, UI/accessibility, ESLint-boundary, and test-sufficiency audit.
- **Reviewed Range:** `git diff 84cfff4..e19cbd9066a0319858acff3b50dd1927ada3c9d0` on `feat/r11-tasks`
- **Reference Inputs Checked:** `.ai/plans/r11-tasks-progress.md` (`D11.1`–`D11.14`, Phases R11a–R11f), `SPEC.md`, `eslint.config.mjs`, and pinned PDS checkout `/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-phase3` (`5d88b414`).

---

## Findings by Severity

### Blocker

None.

---

### High

#### H1. `TasksClient` / `SyncCore` Caches Verified Workspace Snapshots for 60 Minutes Without Invalidation — Bypassing `D14` Member Eviction, Hiding Newly Invited Roster Writers, and Allowing Writes After `disableExtension`

- **Citations:**
  - `packages/client/src/ext/tasks/tasks-client.ts:1147-1168` (`executeSpaceSync`)
  - `packages/client/src/sync.ts:392-418, 832-838, 954-967` (`syncVerifiedWorkspaceSnapshot`, `syncVerifiedWriter`, `verifiedWriterNeedsCheck`)
  - `packages/client/src/workspace-client.ts:121-156` (`WorkspaceClient.summary`)
  - `packages/client/src/operator-client.ts:44-57` (`execute`, `enableExtension`, `disableExtension`)
  - `apps/web/src/app/ui/ext/tasks/use-tasks-space.ts:39` (`useTasksSpace`)
  - `packages/client/src/views.ts:100, 186-188` (`LiveSpaces`)
- **Problem:**
  Once `COLLECTION.extInstall` (`rkey = "tasks"`, `active: true`) is cached in `SyncStore`, `TasksClient.executeSpaceSync` sets `snapshotTruthInterval = defaultTruthInterval` (`60 * 60 * 1000` ms = 60 minutes) (`tasks-client.ts:1153-1162`). Unlike `syncVerifiedSpace` — which calls `resolveSpaceWriters` -> `listReposSince` on every read to detect and mark moved writers stale — `syncVerifiedWorkspaceSnapshot` (`sync.ts:400-418`) writes `writers: []` on `SpaceState` and calls `syncVerifiedWriter` directly without consulting `listReposSince(workspaceUri)`. Inside `syncVerifiedWriter` (`sync.ts:832-838`), `listedEntry` is therefore always `undefined`, so while `state.stale === false` and `now - state.checkedAt < 60 min`, `verifiedWriterNeedsCheck` returns `false` immediately.

  Nothing in the client invalidates `(workspaceUri, authorityDid)` in `SyncStore` when the workspace authority repo mutates:
  1. `WorkspaceClient.summary` (`workspace-client.ts:121-156`) queries `listBoundedRecords` directly and never updates or marks `(workspaceUri, authorityDid)` stale in `SyncStore`.
  2. `OperatorClient` (`operator-client.ts:44-57`) never marks `(workspaceUri, authorityDid)` stale after `removeMember`, `leaveWorkspace`, `inviteMember`, `enableExtension`, or `disableExtension`.
  3. `useTasksSpace` (`use-tasks-space.ts:39`) only binds `[tasksSpaceUri]` in `useLiveKey` (omitting `workspaceUri`), and `LiveSpaces` (`views.ts:186-188`) never marks changed spaces stale in `SyncStore`.
- **Concrete Reproduction Traces:**
  1. **`D14` member eviction bypass & cold-reader parity failure:**
     - Alice calls `aliceEngine.tasks.readSpace(workspace)` at `T0` (caching `rosterMembers = { owner, alice, bob, carol }` with `checkedAt = T0`).
     - At `T0 + 5s`, the admin executes `removeMember` for `carol` (removing `carol` from `tasksSpace` member list and writing `workspace.roster` `active: false` in `workspace`).
     - Even after `carol` disappears from `listRepos(tasksSpace)`, calling `aliceEngine.tasks.readSpace(workspace)` at `T0 + 10s` reuses the cached `T0` workspace snapshot: `snapshot.rosterMembers` still contains `carol`, `syncVerifiedSpace` passes `keepWriters` containing `carol` to `resolveSpaceWriters` (`sync.ts:310`), **skipping `purgeWriter(tasksSpace, carol)`**, and Alice continues seeing `carol`'s evicted tasks/edits and `rosterMembers` entry for up to 60 minutes (diverging from `readIndependentTasksSpace`! Note that `protocol-tests/tasks-acceptance.test.ts:571` and `packages/client/src/tasks-reader-parity.test.ts:256,331` masked this by fast-forwarding the clock by `truthIntervalMs`).
  2. **Disabled extension write-through by the workspace authority:**
     - Workspace authority (`did === authorityDid`) enables Tasks, reads `ownerEngine.tasks.readSpace(workspace)` at `T0`, and then disables Tasks via `ownerEngine.operator.disableExtension(workspace, "tasks")` (which writes `ext.install` `active: false` on the PDS via the operator).
     - Calling `ownerEngine.tasks.readSpace(workspace)` at `T0 + 5s` still returns `enabled: true` from cached `SyncStore`, and `ownerEngine.tasks.createTask(workspace, { title: "Ghost task" })` **succeeds in writing new records into the disabled Tasks space** (because `authorityDid` owns the space) instead of throwing `TasksExtensionDisabledError`.
  3. **Newly invited member omitted from `writerUniverse` (`D11.3 #4`):**
     - Admin runs `inviteMember` for `dave` at `T0 + 5s`. Alice's `engine.tasks` omits `dave` from `rosterMembers` and `writerUniverse` for up to 60 minutes.
- **Recommended Fix (preserving Gate 2's `0` workspace HTTP calls on idle warm reopen):**
  - Wire `LiveSpaces` (`views.ts`) to accept an optional `onSpaceChanged?: (space: string) => Promise<void> | void` hook (`(space) => engine.sync.markSpaceStale(space)`) invoked when `ChangeFollower` reports `changed`/`reset`, and watch `[workspaceUri, ...(tasksSpaceUri ? [tasksSpaceUri] : [])]` in `useTasksSpace`.
  - Mark `(workspaceUri, authorityDid)` stale in `SyncCore` whenever `OperatorClient` completes an operation on `workspaceUri` (on that engine) or when `WorkspaceClient.summary` observes authority state changes, and/or use `resolveSpaceWriters` (`listReposSince`) on `workspaceUri` when appropriate while keeping idle warm reopen within `D11.13` Gate 2 (`2 listRepos` on `tasksSpace`, `0` writer calls).

---

#### H2. `@flock/client` vs. `@flock/reader` Failure-Classification & Cache-Purge Divergence on `RepoStarLimitError` and `RepoVerificationError` / `StarParseError`

- **Citations:**
  - `packages/client/src/sync.ts:539, 552, 945-948, 1219-1222, 2169-2174`
  - `packages/reader/src/independent-tasks.ts:579-583, 737-745`
  - `packages/protocol/src/atproto/repo-failure.ts:12-18, 43`
  - `packages/client/src/tasks-reader-parity.test.ts:40-44`
- **Problem:**
  `@flock/client` (`SyncCore`) and `@flock/reader` (`readIndependentTasksSpace`) classify STAR limit and STAR verification/parse failures with opposite `permanent` flags — breaking cold `setAside` parity (`assertTasksParity`) and causing warm `TasksClient` reads to keep serving stale cached records from oversized writers:
  1. **`RepoStarLimitError` (`maxStarArchiveBytes` / `maxStarRecords` exceeded):**
     - `RepoStarLimitError` extends `UpstreamResponseTooLargeError` (`space-credential-core.ts:66`).
     - `repo-failure.ts:12-16, 43` specifies that `UpstreamResponseTooLargeError` is **`permanent: true`** (*"its answers are larger than this app reads. Whatever was cached from it must stop being served"*). `readIndependentTasksSpace` (`independent-tasks.ts:744`) delegates to `classifyRepoFailure`, producing `{ did, reason: "its answer is larger than this app reads", permanent: true }`.
     - However, `sync.ts:2170-2172` (`classifyVerifiedFailure`) overrides `RepoStarLimitError` to **`{ reason: error.message, permanent: false }`**.
     - **Reproduction trace:**
       - *Cold read:* Bob's Tasks STAR stream exceeds `16 MiB` (`maxStarArchiveBytes`) or `20,000` records (`maxStarRecords`). `engine.tasks.readSpace` reports `setAside = [{ did: bob, permanent: false, reason: "STAR archive exceeds..." }]`, while `readIndependentTasksSpace` reports `setAside = [{ did: bob, permanent: true, reason: "its answer is larger than this app reads" }]` — failing `assertTasksParity` (`tasks-reader-parity.test.ts:40-44`). (`tasks-performance.test.ts:968, 1067` hid this by manually calling `purgeWriter` and only asserting `.some(...)`.)
       - *Warm read:* Bob previously synced valid tasks `T1..T5`, then imports/writes an archive exceeding `16 MiB` (causing `listRepoOps` or reset recovery to hit `fetchVerifiedRepoStar` -> `RepoStarLimitError`). Because `sync.ts` classifies this as `permanent: false`, `dropRecordsOnPermanentFailure` (`sync.ts:947`) is skipped and `syncVerifiedSpace` (`sync.ts:539, 552`) **continues serving Bob's stale `T1..T5` records** (`!permanentAside.has(bob)`), diverging in merged `tasks`/`projects`/`activities` from `readIndependentTasksSpace` and violating `repo-failure.ts:12-16`.
  2. **`RepoVerificationError` / `StarParseError` after bounded retries (`maxListRecordsRetry = 3`):**
     - When a writer's STAR archive persistently fails verification across all 3 attempts (e.g., corrupted CBOR value, out-of-order STAR keys, or EOF `records do not match the commit data` under a valid commit header MAC), `sync.ts:1219-1221` throws `SpaceMacError` -> **`{ reason: "its records could not be authenticated", permanent: true }`** and purges cached records.
     - Conversely, `independent-tasks.ts:579-582, 741-743` rethrows `RepoVerificationError` / `StarParseError` and maps them to **`{ reason: "its records could not be verified", permanent: false }`** — again diverging on `setAside[i].permanent` and `reason`.
- **Recommended Fix:**
  Align `SyncCore` and `readIndependentTasksSpace` on a single shared failure semantics (in `@flock/protocol/atproto/repo-failure.ts` or consistent helpers): treat `RepoStarLimitError` as `permanent: true` (so cached records from oversized repos stop being served and match `repo-failure.ts:43`), and align post-retry `RepoVerificationError` / `StarParseError` classification (`permanent: true` when record/commit authentication fails vs. `permanent: false` if due to mid-stream concurrent mutation) across both `sync.ts` and `independent-tasks.ts`, adding both cases to `tasks-reader-parity.test.ts`.

---

### Medium

#### M1. `SyncCore.markSpaceStale` Has Zero Production Callers — `ChangeFollower` Ticks Do Not Re-Probe `syncedRev: null` Trusted-Empty Writers (`D11.1 #4`)

- **Citations:**
  - `packages/client/src/sync.ts:355-364, 954-967`
  - `packages/client/src/views.ts:100, 186-188`
  - `apps/web/src/browser/use-browser-session.ts:81`
- **Problem:**
  `D11.1 #4` (`.ai/plans/r11-tasks-progress.md:48`) requires:
  > **Recheck policy:** such writers keep `syncedRev: null` in `SyncStore` and are re-probed whenever `truthIntervalMs` elapses, **a space `ChangeFollower` tick fires**, or `listRepos(space)` newly reports a `repoRev`.

  `SyncCore.markSpaceStale(space)` (`sync.ts:355-364`) was written to mark all tracked writers (including `syncedRev: null` unwritten/absent probes) stale when a space change tick arrives, but it has **zero callers outside test files** (`sync.test.ts`, `verified-sync.test.ts`). When `LiveSpaces` (`views.ts:186-188`) receives a `ChangeFollower` tick for `tasksSpaceUri`, it invokes `engine.tasks.readSpace(workspaceUri)` directly without calling `engine.sync.markSpaceStale(space)`.
- **Reproduction Trace:**
  1. Member Bob (hosted on `pds2`) is on the verified workspace roster and initially has no Tasks repo (`syncedRev: null`, `checkedAt = T0`, `stale: false` in Alice's `SyncStore`).
  2. Bob writes his first task (or runs `importRepo` on `pds2`); the operator change feed delivers a `ChangeFollower` tick for `tasksSpaceUri` to Alice's browser before `pds1`'s `listRepos(tasksSpace)` reflects Bob's `repoRev` (e.g., cross-host notification lag or `importRepo` without authority push, the exact scenario tested in `verified-sync.test.ts:235` via manual `markSpaceStale`).
  3. Alice's `LiveSpaces` triggers `readSpace(workspaceUri)`: `listReposSince` returns empty, and `verifiedWriterNeedsCheck` (`sync.ts:961-966`) sees `state.stale === false`, `listedRepoRev === undefined`, and `now - state.checkedAt < 60 min`, skipping Bob completely until the 60-minute `truthIntervalMs` expires.
- **Recommended Fix:**
  Pass an `onSpaceChanged: (space) => engine.sync.markSpaceStale(space)` callback into `LiveSpaces` (`use-browser-session.ts:81` / `views.ts:100, 186`) so every `ChangeFollower` `changed` / `reset` event marks the space stale in `SyncStore` before reloading bound snapshots.

---

#### M2. `resolveLifecycle` Emits False-Positive `concurrentDeleteOverwrite` Activity Events When Multiple Active Deletes Have Different Causal Ancestors (Masked by Duplicate Logic in `entity-merge-oracle.test.ts`)

- **Citations:**
  - `packages/protocol/src/entity-merge.ts:1033-1052` (`resolveLifecycle`)
  - `packages/protocol/src/entity-merge-oracle.test.ts:81-88` (`evaluateGroundTruthOracle`)
- **Problem:**
  In `resolveLifecycle` (`entity-merge.ts:1034-1051`), when `activeDeletes.length > 0` and `emitActivity === true`, the implementation selects a single `winningDeleteIdx` (highest `(t, repo, rkey)` among `activeDeletes`) and checks causal ordering **only against `winningDeleteIdx`**:
  ```ts
  if (dag.happensBefore(i, winningDeleteIdx) || dag.happensBefore(winningDeleteIdx, i)) continue;
  ```
  It fails to check whether op `i` already happened causally before *another* active un-restored delete (`activeDeletes.some((dIdx) => dag.happensBefore(i, dIdx))`).
- **Reproduction Trace:**
  1. Alice creates root task `T0` (`t = 001700000000000.0000`).
  2. Alice writes sequential edits `E1` (`t = ...0010`, `s = [opRef(T0)]`, `title: "Draft"`) and `E2` (`t = ...0020`, `s = [opRef(T0), opRef(E1)]`, `title: "Final"`), then intentionally deletes the task in `D1` (`t = ...0030`, `s = [opRef(T0), opRef(E1), opRef(E2)]`, `deleted: true`). At this point `mergeTask` emits `0` conflict activities because `E1 -> E2 -> D1`.
  3. Bob (offline since `T0`, having seen neither `E1`/`E2` nor `D1`) also deletes `T0` in `D2` (`t = ...0040`, `s = [opRef(T0)]`, `deleted: true`).
  4. Both users deleted the task; zero edits were concurrent with Alice's deletion of `E1` and `E2`. Yet `activeDeletes = [D1, D2]`, `winningDeleteIdx = D2` (`t = 40 > 30`), and `happensBefore(E1, D2) === false` & `happensBefore(E2, D2) === false`.
  5. `mergeTask` fabricates two false-positive `concurrentDeleteOverwrite` Activity notices (`delete:...:D2:E1` and `delete:...:D2:E2`), incrementing the unseen conflict badge for edits that were already causally superseded and intentionally deleted by `D1`.
  6. `evaluateGroundTruthOracle` (`entity-merge-oracle.test.ts:82-87`) copied the identical `happensBefore(op, winningDelete)` check instead of checking `activeDeletes.some((d) => happensBefore(op, d))`, masking this bug during exhaustive DAG state-space exploration.
- **Recommended Fix:**
  Skip any op `i` that causally precedes *any* active un-superseded delete (`if (activeDeletes.some((dIdx) => dag.happensBefore(i, dIdx)) || dag.happensBefore(winningDeleteIdx, i)) continue;` — or skip ops causally dominated by any active delete in both `entity-merge.ts` and `entity-merge-oracle.test.ts`), and add a regression test for concurrent deletes with asymmetric causal histories.

---

### Low

#### L1. `applyOwnWrite` Invalidates `LtHash` Delta Sync on the Author's Next Read/Write, Forcing a Full `getRepo` STAR Download of Own Repo

- **Citations:**
  - `packages/client/src/ext/tasks/tasks-client.ts:776-782, 1310-1337` (`deleteComment`, `persistOwnUpsert`)
  - `packages/client/src/sync.ts:375-380, 1042-1059` (`applyOwnWrite`, `tryAdvanceViaRepoOps`)
- **Problem:**
  After every local task/project/comment mutation, `TasksClient` calls `sync.applyOwnWrite`, which mutates `StoredRecord`s in `SyncStore` and sets `stale: true` while keeping `WriterState.syncedRev` and `WriterState.setHash` at the **pre-write** revision (`sync.ts:195-203, 379`). On the next `readSpace` or `mutateEntity` (`ensureSyncedForWrite`), `tryAdvanceViaRepoOps` (`sync.ts:1053-1059`) recomputes `persistedSetHash` over `StoredRecord`s (which now include the optimistic own write), detects `!bytesEqual(persistedSetHash, state.setHash!)`, returns `{ applied: false }`, and falls back to `recoverFullVerifiedRepo` (`getRepo` STAR).
- **Impact:**
  Cryptographically safe (state never corrupts), and incremental sync across *other* writers (`D11.13` Gate 3) still uses `listRepoOps`. However, a user making consecutive edits in the Tasks UI re-downloads their own full Tasks STAR archive on every subsequent sync/edit rather than replaying a 1-op `listRepoOps` delta.

---

## Verified Clean Areas

- **`LtHash` 2048B vs. 32B Commit Digest & STAR Streaming (`space-credential-core.ts`, `store.ts`, `sync.ts`):** `LTHASH_STATE_BYTES = 2048` is strictly separated from 32-byte `commit.data`, never initialized from `getLatestCommit` alone, and `fetchVerifiedRepoStar` enforces `maxBytes` and `maxRecords` mid-stream while staging all entries until `verifyRepoStar` EOF `repo.matches(commit)` completes.
- **`listRepoOps` MAC Gating & `prev`-Chain Replay (`space-credential-core.ts:424-435`, `sync.ts:1972-2118`):** Unsigned `listRepoOps` pages are restricted to non-empty intermediate pages with non-empty `cursor` or unwritten empty repos (`ops: [], cursor: undefined`); equal-`rev` batch ordering, `prev` transitions, superseded `value: undefined` handling, surviving `verifyRecordCid`, and `RepoCommit.fromRecords` == `replayed.setHash.state()` checks are all sound.
- **`RepoNotFound` Trust Boundary (`D11.1 #4`, `sync.ts:918-943, 969-996`, `independent-tasks.ts:447-456`):** Trusted empty (`syncedRev: null`) is accepted only when `!listed.has(did) && syncedRev === null && validPds !== null`, and `dropRecordsOnPermanentFailure` preserves non-null `syncedRev` so a previously non-empty writer answering `RepoNotFound` continues failing closed.
- **`followRepoOps` & `AppRuntime` (`sync.ts:570-816`, `app-runtime.ts:388-500`):** Header-only `excludeValues: true` + MAC-verified `getLatestCommit` baseline avoids historical payload downloads; host `(rev, idx)` order is preserved per repo; `(rev, setHash, cids)` only advance once `attempts.size === 0` (`MAX_ATTEMPTS = 3`, `MAX_HOLD_MS = 10 min`); resets re-baseline without re-delivering historical records; `AppRuntime.throttles` is preserved.
- **`entity-merge.ts` Core Algebra & `WriteQueue` / `R2-H1` Form Isolation (`entity-merge.ts`, `write-queue.ts`, `tasks-client.ts:983-1051`):** Fixed-width HLC with remote drift clamping, implicit root ancestry (`root ->* edit`), exact `255`/`256` (final) vs `257` (`sTruncated: true`, `uncertainAncestry: true`, Activity suppressed) 3-tier closure packing, benign `D14` dangling `opRef`s, Tarjan SCC deterministic cycle breaking, canonical equal-value conflict suppression, OR-Set add-wins, account-wide atomic HLC+TID reservation with `MAX_TID_COLLISION_RETRIES = 5`, and `formChainId`-isolated `baseClosure` chaining (`R2-H1`) are all cleanly implemented.
- **Operator Extension Lifecycle & Journal Safety (`apps/operator`):** All 15 pre-R11 persisted kinds remain intact (`17` total); `enableExtension`, `inviteMember`, `removeMember`, `leaveWorkspace`, and `reconcileWorkspace` execute extension space steps first (`completedSteps.length === 0` discard on `ScopeMissingError`), failing closed with `authorizationRequired: true` (`AuthorityReauthorizationRequiredError`) when an active or uncleaned (`cleanupComplete: false`) extension lacks scope while leaving pre-R11 and `cleanupComplete: true` workspaces unaffected; all member-list writes go through `members.ts`.
- **App Router `(shell)`, DID Single-Decode, `returnTo` & Loopback Redirect Security, CSP Nonces, IDB v1->v2, & ESLint Boundaries (`apps/web`, `indexeddb-store.ts`, `eslint.config.mjs`):** `(shell)/layout.tsx` (`force-dynamic`) preserves live engine state while keeping `/oauth/*` outside; `did:web:localhost%3A3000` round-trips via single-decode `parseRoute`/`parseDecodedSegments`; `loopback-redirect.ts` and `return-to.ts` block `//`, `\`, control chars, cross-origin targets, and `/oauth/*`; CSP nonces apply on all deep routes; IDB `VERSION = 2` guards all v1 stores/indexes and wipes `activity`/`clock` on `clear()`/`signOutAccount`; and `eslint.config.mjs` + `eslint-boundaries.test.ts` enforce static, re-export, and dynamic import isolation without shadowing existing browser/node/operator/DM rules.

---

VERDICT: REVISE
