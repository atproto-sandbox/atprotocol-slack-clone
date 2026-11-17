@coordinator [done] Round 1 strictly read-only plan review of `.ai/plans/r11-tasks-progress.md` against the post-R10 codebase and pinned PDS (`../atproto-spaces-phase3`).

## Summary
The overall R11 architecture (extending `@flock/protocol` + `@flock/client`, client-side HLC/frontier stamping under per-`(accountDid, entityUri)` serialization, IDB-backed Overwrite Activity, `Route Group (shell)` layout, and operator legacy-grant compatibility) aligns well with post-R10 reality. However, there are **2 Blockers** (one cryptographic `LtHash` byte-size mismatch that will crash/fail on first incremental sync, and one causal-merge transitivity/oracle flaw) plus **5 High** and **4 Medium** issues that should be fixed in the plan before implementation begins.

---

### Blocker

1. **`commit.data` (32-byte SHA-256 digest) vs. `LtHash` state (2048 bytes) in `SyncStore` and `followRepoOps`**
   - **Citations:** `.ai/plans/r11-tasks-progress.md:70,78,80`; `../atproto-spaces-phase3/packages/space/src/lthash.ts:6,19-29,48-54`; `../atproto-spaces-phase3/packages/space/src/repo-commit.ts:18-20,67-75`; `../atproto-spaces-phase3/packages/pds/src/api/com/atproto/space/getLatestCommit.ts:35-55`.
   - **Flaw A (`r11-tasks-progress.md:78`):** The plan commits `setHash: commit.data` to `SyncStore`. In `@atproto/space`, `commit.data` is `setHash.digest()` (`sha256(this.bytes)`, **32 bytes**), whereas `RepoCommit.fromState(writerState.setHash)` (`r11-tasks-progress.md:70`) passes `state` to `new LtHash(state)`, which requires the **2048-byte** internal state (`LTHASH_STATE_BYTES = 2048`, `setHash.state()`) and throws `LtHash state must be 2048 bytes, got 32` otherwise.
   - **Flaw B (`r11-tasks-progress.md:80`):** `SyncCore.followRepoOps` cannot *"initialize checkpoint from MAC-verified `getLatestCommit`"* and then advance via `RepoCommit.fromState(setHash).applyOps(ops)` on a non-empty repo, because `getLatestCommit` returns only `commit.data` (the 32-byte digest), not the 2048-byte `LtHash` state.
   - **Fix:** Store `replayed.setHash.state()` (2048 bytes) in `SyncStore` — never `commit.data`. On cold start or reset in both complete sync and `followRepoOps`, initialize `setHash` as empty `new RepoCommit().setHash.state()` **only** when `getLatestCommit` returns `RepoNotFound`; for any non-empty repo, seed `(rev, setHash)` from `getRepo` STAR (`fetchVerifiedRepoStar` -> `RepoCommit.fromRecords(records).setHash.state()`) or `listRecords` (all collections) matched against `getLatestCommit`. Also update `packages/testing/src/fake-network.ts:654` (`listRepos` currently stubs `data` as 32 zero bytes) to emit the real `commitFor(space, repo).data`.

2. **Minimal `opId`-antichain `s` breaks transitivity when intermediate ops are missing, `>200` heads have no fallback, and oracle test is mismatched**
   - **Citations:** `.ai/plans/r11-tasks-progress.md:92-109,238`; `.ai/plans/platform-refactor.md:409`; `packages/client/src/sync.ts:147-150`; `../atproto-spaces-phase3/packages/pds/src/space-policy/manager.ts:124-138`; `../atproto-slack-clone/.ai/plans/platform-extensions-tasks.oracle.mjs:23-29,37-40`.
   - **Flaw:** Under `D14`, removing Bob purges Bob's repo from `SyncStore`. If Alice writes `op1`, Bob edits `op2` (`s: [op1]`), and Charlie edits `op3` (`s: [op2]`, since minimal antichain compressed `op1` away), then once Bob is removed (or `setAside`), `op2` is absent from the local DAG. Backwards reachability from `op3.s` stops at dangling `op2`, making `happensBefore(op1, op3)` return `false` — generating spurious `concurrentFieldOverwrite` conflicts and `otherVersions` between Alice and Charlie. Additionally: (a) >200 concurrent sibling ops (e.g., offline multi-device or hostile `s: []` burst) exceed `s.maxLength = 200` with no truncation rule specified; and (b) `oracle.mjs` proved equivalence of a transitive *per-author max-HLC* map (which survives missing intermediate authors) against a full-past DAG, whereas testing an `opId` DAG against an `opId` DAG is circular unless testing frontier compression and missing-op/permutation invariants.
   - **Fix:** Either (a) include a bounded per-author causal watermark alongside `opId` heads, or (b) explicitly specify dangling-ref behavior under `D14`/incomplete sync (gate Overwrite Activity emission on `complete === true` and define deterministic `>200` frontier overflow handling without dropping safety). Update `Phase R11b` (`entity-merge-oracle.test.ts`) to fuzz `causalFrontier` compression, multi-hop chains, and LWW/OR-Set/deletion-overwrite against an uncompressed full-history reference oracle.

---

### High

3. **`listRepoOps` MAC bypass risk & `getRepo` binary STAR transport mismatch**
   - **Citations:** `.ai/plans/r11-tasks-progress.md:57-60,76-82`; `packages/protocol/src/atproto/space-credential-core.ts:130-209`; `packages/protocol/src/atproto/xrpc.ts:41-54`; `../atproto-spaces-phase3/packages/pds/src/api/com/atproto/space/listRepoOps.ts:49,71-77`; `../atproto-spaces-phase3/packages/pds/src/api/com/atproto/space/getRepo.ts:61-65`; `../atproto-spaces-phase3/packages/space/src/sync/consumer.ts:88-118,182-184`.
   - **Flaws:**
     - `fetchWithVerifiedMac` / `macVerifies` (`space-credential-core.ts:146-209`) currently branch only on `MacType`. If `!commit` is permitted whenever `cursor !== undefined || ops.length === 0` without gating strictly on `xrpcMethod(request) === "com.atproto.space.listRepoOps"`, `getLatestCommit` could accept an unsigned 200 OK empty/cursor payload. Even on `listRepoOps`, `listRepoOps.ts:49,71-73` only omits `commit` when `(ops.length === limit && typeof cursor === "string" && cursor.length > 0)` or `(ops.length === 0 && cursor === undefined)` — accepting `ops.length === 0 && cursor !== undefined` enables infinite cursor loops without MAC.
     - `getRepo` returns `application/octet-stream`, whereas `SpaceCredential.client()` (`xrpc.ts:43`) parses JSON (`readUpstreamJson`). `fetchVerifiedRepoStar` must be a dedicated signed-request helper on `SpaceCredential` (reusing `createSpaceSigHeaders` + `WANT_MAC_HEADER` + 2-attempt KEM refresh), bounding bytes & record count *during* streaming and **never committing/trusting yielded records until `verifyRepoStar` finishes `repo.matches(commit)` at EOF** (`consumer.ts:182-184`).
     - In `D11.3 #3` (`r11-tasks-progress.md:77,82`): `listRecords` fallback must omit `collection` so `RepoCommit.fromRecords` covers *all* collections in the repo; and `ChannelClient` `"window"` reads (`r11-tasks-progress.md:82`) cannot seed `setHash` for incremental `listRepoOps` because `"window"` does not list full history (and un-MAC'd `listRecords` CID checks are self-consistency only, not cryptographic auth).
   - **Fix:** Scope omitted-`commit` allowance strictly to `listRepoOps` with the exact PDS `(ops.length > 0 && cursor)` vs `(ops.length === 0 && !cursor)` rule; specify dedicated `SpaceCredential.fetchVerifiedRepoStar` buffering/full-EOF verification; drop the impossible `"window"` `setHash` seeding claim.

4. **Writer universe (`listRepos` vs. roster), `RepoNotFound` purge collision, and orphan edits/comments**
   - **Citations:** `.ai/plans/r11-tasks-progress.md:62-67`; `packages/protocol/src/atproto/repo-failure.ts:20-25`; `packages/client/src/sync.ts:144-150,562-566`; `apps/operator/src/operator/kinds/create-workspace.ts:134-143`.
   - **Flaws:**
     - `D11.3 #2` unions `listRepos(space)` and `workspace.members`. On a non-reference authority (or mid-removal before `removeWriter`), `listRepos` can include a removed member whose PDS is unreachable/deactivated; unioning would violate `D14` (keep showing removed member's records) or wedge Tasks completeness (`incomplete: true`) indefinitely. Meanwhile, a dedicated `authorityDid` (`create-workspace.ts:134`) is not in `workspaceRoster`.
     - Existing `classifyRepoFailure` (`repo-failure.ts:24`) classifies `RepoNotFound` as `permanent: true`, causing `ReadRun.guard` (`sync.ts:565`) to `purgeWriter`. In complete sync, `RepoNotFound` must be handled *before* `classifyRepoFailure`: empty & `complete: true` only when absent from `listRepos` **and** `writerState.syncedRev === null`; if `listRepos` has a `repoRev` **or** `SyncStore` already held `syncedRev !== null` (PDS `clearRecords`/`importRepo` never deletes `space_repo`), `RepoNotFound` must set aside & mark `incomplete: true`.
     - **Orphaned edits/comments:** If Bob creates a `task` and is later removed (`D14` purges Bob's records), Alice's `taskEdit` / `taskComment` records still exist. The plan does not specify whether `entity-merge.ts`, `tasks-client.ts`, and `independent-tasks.ts` drop orphans or synthesize partial entities — risking divergence in `tasks-reader-parity.test.ts` (R11f).
   - **Fix:** Exclude non-roster removed writers from `listRepos` union per `D14` (allowing `authorityDid` only if listed or active), intercept `RepoNotFound` prior to `classifyRepoFailure`, and explicitly define orphan edit/comment handling when root `task`/`project` is missing.

5. **`AppRuntime` (`followRepoOps`) cold-start baseline, reset re-delivery, and handler retry semantics**
   - **Citations:** `.ai/plans/r11-tasks-progress.md:80-81,208`; `packages/client/src/app-runtime.ts:219,376-471,609-635`; `packages/client/src/key-window.ts:121-159`.
   - **Flaws:** Beyond the `getLatestCommit` `setHash` issue (#1), the plan omits: (a) distinguishing initial cold-start baseline (`deliver = false` — record `(rev, setHash)` without firing `onMessage`/`onCommand` on old history) from newly arriving writers/writes; (b) preventing historical re-delivery if `clearRecords`/`importRepo`/pruned oplog triggers `getRepo` STAR recovery; and (c) preserving retry-on-handler-failure (`KeyWindow` holds back delivery up to `MAX_ATTEMPTS = 3` / `MAX_HOLD_MS = 10 min`, whereas advancing `rev` in `SyncStore` before handler completion loses failed events). Also note `KeyWindow` (`key-window.ts`) does not perform rate throttling — `AppRuntime.admitAuthorRecord` (`app-runtime.ts:609-635`) does.
   - **Fix:** Specify `followRepoOps` baseline seeding, `(uri, cid)` seen-set deduplication across STAR reset recovery, and per-writer pending-delivery retry before advancing the committed cursor.

6. **OAuth `returnTo` capture/clear race in `LoginForm` and open-redirect hazard in loopback normalization**
   - **Citations:** `.ai/plans/r11-tasks-progress.md:156,158`; `apps/web/src/app/ui/login-form.tsx:18-22`; `apps/web/src/app/ui/oauth-callback-view.tsx:16-22`; `apps/web/src/app/page.tsx:10-15`; `apps/web/src/proxy.ts:9-17`.
   - **Flaws:**
     - `LoginForm` (`login-form.tsx:18,22`) calls `clearAccountScopedState(sessionStorage, [INVITE_LINK_KEY])` (wiping all other `"spaces.*"` keys) and `window.history.replaceState(..., window.location.pathname)` (stripping `?thread=...`). Storing `returnTo` under `"spaces.*"` without capturing `pathname + search` (excluding `?signout=`) *after* `clearAccountScopedState` (or keeping it on `signIn` and clearing on `signOutAccount` / `?signout=`) will lose deep links or leak a prior user's deep link to the next user. `OAuthCallbackView` must also reject `/oauth/*`, `//`, `/\`, and scheme-bearing targets.
     - Moving loopback normalization from `page.tsx` (`(shell)/layout.tsx` has no `searchParams` in Next.js) to `proxy.ts` is right, but `new URL(request.nextUrl.pathname + request.nextUrl.search, appUrl.origin)` turns `//evil.com` into `http://evil.com/` (open redirect!).
   - **Fix:** In `proxy.ts`, reject/normalize paths not matching `/^\/(?!\/|\\)/` and assert `redirectUrl.origin === appUrl.origin` before redirecting. In `LoginForm`/`OAuthCallbackView`, capture validated relative `returnTo` safely and clear it on sign-out.

7. **ESLint flat-config `"no-restricted-imports"` override trap**
   - **Citations:** `.ai/plans/r11-tasks-progress.md:163-165`; `eslint.config.mjs:66-79,88-94`.
   - **Flaw:** In ESLint flat config, a later block defining `"no-restricted-imports"` **replaces** (does not merge with) earlier blocks' `patterns` for matching files (`eslint.config.mjs:66-67`). Since `packages/client/src/{channel-client,sync,views,dm/*}.ts` already match `BROWSER_CODE` (`eslint.config.mjs:74-78`), adding an extension-isolation block without repeating `[NO_NODE_BUILTINS, NO_SERVER_CONFIG, NO_APP_LAYER, NO_CLIENT_NODE_ENTRY]` will silently drop Node-builtin and `@flock/net` enforcement on core client files.
   - **Fix:** Spread the existing `BROWSER_CODE` patterns alongside `NO_EXTENSION_IMPORT` in `eslint.config.mjs`, and verify `packages/protocol` never re-exports `entity-merge` from `registry.ts` or `workspace-summary.ts` so `packages/reader` cannot pull it in transitively.

---

### Medium

8. **`IndexedDbStore` v1 -> v2 `onupgradeneeded` `ConstraintError` & `meta` clearing**
   - **Citations:** `.ai/plans/r11-tasks-progress.md:168-172`; `packages/client/src/indexeddb-store.ts:21-28,147-153`.
   - **Flaw:** `IndexedDbStore.open` (`indexeddb-store.ts:21-28`) unconditionally calls `db.createObjectStore(...)` for all 5 stores in `onupgradeneeded`. Bumping `VERSION = 2` without `if (!db.objectStoreNames.contains(...))` / `oldVersion` checks will throw `ConstraintError` for existing R10 users. Also, `clear()` (`indexeddb-store.ts:147-153`) intentionally skips clearing `"meta"` (epoch counters), so storing `ownLastHlc`/`lastTidMs` in `"meta"` leaves stale clock entries after `store.clear()` unless explicitly deleted or stored in dedicated `clock`/`activity` objectStores.
   - **Fix:** Guard existing store creation in `onupgradeneeded`, use dedicated `activity` and `clock` stores (cleared in `clear()`), and add a v1 -> v2 migration test + `store-contract.ts` coverage.

9. **HLC step-back & counter rollover, `tidNow` same-ms collisions, and lexicon/merge edge cases**
   - **Citations:** `.ai/plans/r11-tasks-progress.md:88-91,107-109,118-124`; `packages/protocol/src/keys.ts:188-199`.
   - **Flaw:** (a) `advanceHlc` must use `Math.max(wallNowMs, ownLastMs, cappedRemoteMs)` so local clock step-back never decreases HLC, and roll `0xffff` counter overflow into `ms + 1`; (b) `tidNow(monotonicMs)` (`keys.ts:188-199`) uses random `clockId`, so `monotonicMs === lastTidMs` can still collide or sort backwards — use `Math.max(Date.now(), lastTidMs + 1)`; (c) implicitly treat `root.opId` as an ancestor of all `*Edit` ops on that entity (preventing `s: []` edits from making creation appear concurrent with delete); (d) reject `clearField: false`, self-parenting (`parent === task`), `add* ∩ remove* ≠ ∅`, and no-op edits in `REGISTRY`; clarify whether OR-Set concurrent add+remove emits Activity and how `taskComment` mutates (`putRecord`/`deleteRecord` vs `*Edit`) so `TasksClient` and `independent-tasks.ts` match.

10. **Next.js App Router `[authority]` param decoding for `did:web:localhost%3A3000`**
    - **Citations:** `.ai/plans/r11-tasks-progress.md:157,287,292-294`.
    - **Flaw:** Next.js App Router runs `decodeURIComponent` on `[authority]`, turning `/w/did:web:localhost%3A3000/...` into `did:web:localhost:3000`, while double-decoding in `routes.ts` would corrupt `did%3Aweb%3Alocalhost%253A3000`.
    - **Fix:** Encode with `encodeURIComponent(authority)` in route builders, do **not** `decodeURIComponent` `params.authority` again in `routes.ts`, and verify end-to-end in Playwright (`url-routing.spec.ts`) as well as unit tests.

11. **Extension `skey` > 128-char guard, `enableExtension` step order, and `kinds.test.ts` / `registrations.ts` invariants**
    - **Citations:** `.ai/plans/r11-tasks-progress.md:48,135-137,248-250`; `packages/protocol/src/keys.ts:11-13,66-68`; `apps/operator/src/operator/kinds/kinds.test.ts:14-93,140-193`; `apps/operator/src/operator/kinds/app-access.ts:65-68`; `apps/operator/src/operator/registrations.ts:71-76,207-236`.
    - **Flaw:** `${workspaceSkey}-tasks` exceeds `isSkey`'s 128-char cap if `workspaceSkey` > 122 chars (unlike `appInboxSkey` `i-${recordKeyHash(...)}`). `enableExtension` must create the extension space *before* writing `COLLECTION.extInstall` (like `installApp`) so pre-R11 grants fail cleanly at step 1 on `ScopeMissingError`. Also note `PERSISTED_KINDS` (`kinds.test.ts:14-93`) currently has **15** prior kinds (not 13 as `r11-tasks-progress.md:248` states), `kinds.test.ts:149-161` enforces inline `context.step("..."` calls and `checked === 89`, and `registrations.ts` must handle extension spaces in `afterOperation`, `syncReconciled*`, and `activeWorkspaceSpaces`.

---

### Low

12. **Terminology / minor implementation notes**
    - `r11-tasks-progress.md:60`: `@atproto/space` STAR-lite (`../atproto-spaces-phase3/packages/space/src/star.ts`) is an uncompressed varint/CBOR stream, not a compressed archive.
    - `r11-tasks-progress.md:72`: Note that `RepoCommit.applyOp` (`repo-commit.ts:42-46`) expects `Cid` instances (`parseCid`), not raw JSON strings from `listRepoOps`, and that a missing `value` on a surviving live key should always trigger Full Verified Recovery rather than partial `getRecord` patching.

---

**VERDICT: REVISE**
