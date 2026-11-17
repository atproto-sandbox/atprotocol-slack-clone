# R11 Plan — Verified Sync, First-Party Extensions, Tasks & URL Routing

- **Status:** READY — Draft v4 approved by both Codex (`gpt-6.1-sol`, xhigh) and Claude Opus (`claude-opus-5-5-high`); implementation deferred to a new branch & worktree
- **Date:** 2026-11-16
- **Baseline:** `feat/r10-interactions` (`84cfff4`, stacked cleanly on `fix/script-policy-and-cors` -> `feat/platform-refactor` -> `main`)
- **Pinned Protocol:** `atproto-spaces` @ `5d88b414a98de1ada22c94c78fa0667a7028163c` + `strict-credential-expiry.patch` (`docs/protocol/atproto-spaces-pin.md`)
- **Authoritative Inputs:**
  - `.ai/plans/platform-refactor.md` (`R11` specification at lines 388–391; R9b deferred oplog notes at lines 1145–1149)
  - `../atproto-slack-clone/.ai/plans/platform-extensions-tasks.md` (`P4`–`P9`)
  - `SPEC.md`, `CODE-MAP.md`, `eslint.config.mjs`
  - `../orbit/.ai/FEATURES.md`, `../orbit/.ai/UI_CONVENTIONS.md` (Tasks UX conventions adapted to ATProto Spaces)

---

## 1. Purpose & Architectural Delta vs. Pre-Refactor Plan

`.ai/plans/platform-refactor.md` mandates revising `platform-extensions-tasks.md` (`P4`–`P9`) onto the **post-R10 architecture** before any R11 implementation begins. Several assumptions in the Nov 4 `platform-extensions-tasks.md` draft no longer hold:

| Topic | Pre-Refactor (`platform-extensions-tasks.md`) | Post-R10 Codebase Reality | R11 Plan Resolution |
| :--- | :--- | :--- | :--- |
| Registry & sync kernel (`P2`, `P3`) | Proposed building registry, IDB store, and notice feed from scratch | **Already done in R2/R4/R5/R10**: `packages/protocol/src/registry.ts`, `packages/client/src/{sync,indexeddb-store,views,feed}.ts`, `apps/operator` | Extend existing `@flock/protocol` & `@flock/client` modules rather than creating parallel stacks |
| Member session & storage | Next.js `/api/*` held member sessions, stamped clocks on server, and stored channel cache + Activity seen/dismissed in app SQLite | **Eliminated in R6/R7**: app server has zero member sessions and zero member SQLite tables (`apps/operator/src/lib/db-member-tables.test.ts`) | All member reads, HLC clock stamping, causal view `s` construction, and client write serialization happen **client-side in `@flock/client`**; Activity seen/dismissed lives in per-DID `IndexedDbStore` |
| Merge model location | Shared app/server helper | Post-R10 requires pure browser/Node protocol package | Pure causal DAG + LWW + OR-Set + deletion-overwrite merge in **`packages/protocol/src/entity-merge.ts`** |
| Complete & verified sync | Assumed server cache | Partial channel `"window"` sync exists (`sync.ts`), no `listRepoOps`/`getRepo` STAR/`LtHash` accumulator/record-CID check | Build verified complete sync (`listRepoOps`, `getRepo` STAR, `getLatestCommit`, `serializeRecord` CID check, `LtHash` 2048B accumulator, staged `prev`-chain verification) in **`packages/client`** |
| Operator journal | Ad-hoc writes | Persistent journal with **15** prior `PERSISTED_KINDS` (`apps/operator/src/operator/kinds/kinds.test.ts`, static `checked === 89` check) | Append `enableExtension` / `disableExtension` (**17** kinds total); keep legacy pre-R11 request shapes/steps intact; fail safely with `AuthorityReauthorizationRequiredError` if an active or uncleaned extension loses scope |
| URL routing | Assumed Next.js server session views | `apps/web` holds selection only in React state (`selection.ts`, `workspace-manager.tsx`) except `/?invite=` and `/oauth/callback` | Add App Router URL routes for workspaces, channels, message permalinks, DMs, and Tasks views (including full `/p/[repo]/[rkey]` project identity) inside a persistent dynamic `(shell)` layout |

**Non-goals for R11 (explicit boundaries):**
- No bump of the `@atproto/space` pin (`5d88b414` -> `d4def6e9` remains outside R11; R11 relies solely on `5d88b414` primitives already present in `packages/protocol/node_modules/@atproto/space`).
- No arbitrary remote third-party iframe/JS plugin execution or marketplace; extensions in R11 are **first-party declarative manifests** (`"tasks"` first) with isolated UI/client modules and strict ESLint boundaries.
- No rich-text live Yjs co-editing server or binary task attachments unless scoped separately (`tasks` descriptions/comments use bounded plain/markdown text within Flock's **64 KiB** application record cap in `packages/protocol/src/registry.ts:77`, distinct from the pinned PDS protocol's **1 MiB** `MAX_RECORD_SIZE` in `@atproto/space/src/types.ts:29`).

---

## 2. Locked Architectural Decisions (`D11.1`–`D11.14`)

### `D11.1` — Pinned Protocol Compatibility & Trust Boundaries (`5d88b414`)
R11 builds strictly against pinned commit `5d88b414a98de1ada22c94c78fa0667a7028163c`:
- Primitives already in the pin: `com.atproto.space.{listRepoOps, getRepo, getLatestCommit, listRecords, getRecord, listRepos, clearRecords, importRepo}`, `RepoCommit`, `LtHash` (`LTHASH_STATE_BYTES = 2048`), `verifyCommit`, `verifyRepoStar`, `verifyRepoStarFull`, `serializeRecord`, `parseCid`, and `jsonToLex` (`@atproto/lexicon`).
- Pinned rules & trust boundaries explicitly enforced:
  1. `validate: true` does not run on third-party schemas on the PDS — `@flock/protocol/registry` validates all extension records locally on read and write, with Flock's 64 KiB application record cap (`registry.ts:77`).
  2. Base32 slur-filter delimiter rule (`packages/protocol/src/keys.ts`) applies to all deterministic hashed space keys and record keys.
  3. `listRepoOps` omits `commit` and `Atproto-Space-Mac` on full intermediate pages (`ops.length === limit` with response continuation `cursor`) and also omits `commit`/MAC on never-written empty repos (`state === null`, `{ ops: [], commit: undefined }`).
  4. **Explicit `RepoNotFound` HTTPS trust boundary (unwritten repo OR missing account on PDS):**
     - Under `5d88b414`, `getLatestCommit` returns un-MAC'd HTTP 400 `RepoNotFound` both when an existing account has never written to the space (`getLatestCommit.ts:43`) and when the host has no account for the DID (`api/com/atproto/sync/util.ts:15`).
     - Client code intercepts `RepoNotFound` **before** `classifyRepoFailure` (`repo-failure.ts:24`, which classifies `RepoNotFound` as `permanent: true` -> purges writer):
       - **Trusted empty / "no repo" (`complete: true`, 0 records, `syncedRev: null`):** accepted ONLY when `!listRepos.has(did)` **AND** `writerState.syncedRev === null` **AND** `resolvePds(did)` resolves a valid `#atproto_pds` HTTPS/loopback endpoint. Explicitly documented as a pinned-protocol HTTPS transport trust boundary covering **both** an unwritten space repo and an absent account on that PDS (`emptyReason: "unwrittenOrAbsent"`).
       - **Recheck policy:** such writers keep `syncedRev: null` in `SyncStore` and are re-probed whenever `truthIntervalMs` elapses, a space `ChangeFollower` tick fires, or `listRepos(space)` newly reports a `repoRev`.
       - **Fail closed (`setAside` + `incomplete: true`):** whenever `listRepos.has(did)` **OR** `writerState.syncedRev !== null` (`clearRecords`/`importRepo` preserve `space_repo` with a new signed empty commit, never `RepoNotFound`) **OR** `resolvePds(did)` fails!

### `D11.2` — Extension Manifest, Isolated Space & Bounded Space Key
- Extensions register in a typed declarative catalog in `packages/protocol/src/extensions.ts` (zero NSID string literals outside `packages/protocol/src/nsids.ts`):
  - Initial extension: `id = "tasks"`, `spaceType = SPACE_TYPE.tasks` (`"new.flock.ext.tasks"`), `collections = [taskProject, taskProjectEdit, task, taskEdit, taskComment]`, `defaultRoute = "ext/tasks"`.
- **Bounded extension space `skey`:** `extSpaceSkey(workspaceSkey, extId)` MUST always satisfy `isSkey(...)` (`<= 128` chars even when `workspaceSkey` itself approaches 128 chars, unlike naive `${workspaceSkey}-tasks` which overflows when `workspaceSkey.length > 122`). Follow `appInboxSkey`'s deterministic hash pattern (`x-${recordKeyHash(`${extId}:${workspaceSkey}`)}`) with `:` delimiter.
- Activation is stored in `new.flock.workspace` as authority-owned **`new.flock.ext.install`** (rkey = `extId`, e.g., `"tasks"`), holding `{ extId, active, space, cleanupComplete?, enabledBy, enabledAt, updatedAt, disabledAt? }`.
- Isolated extension space preserves fast `"window"` sync on channels (`~20k` messages) and `"all"` verified complete sync on Tasks.

### `D11.3` — Verified & Complete Sync Strategy (`packages/protocol` + `packages/client`)
1. **MAC, Metadata Pagination & Binary STAR Transport (`packages/protocol`):**
   - Add `"com.atproto.space.listRepoOps"` to `MAC_METHODS` (`space-credential-core.ts`) (`COMMIT_MAC_TYPE`) so every credentialed `listRepoOps` sends `Atproto-Space-Want-Mac`.
   - In `fetchWithVerifiedMac`: gate any omitted `commit`/MAC **strictly** on `xrpcMethod(request) === "com.atproto.space.listRepoOps"` AND ONLY when either `(ops.length > 0 && typeof cursor === "string" && cursor.length > 0)` (intermediate full page) OR `(ops.length === 0 && cursor === undefined)` (empty/unwritten check; never allow `ops.length === 0 && cursor !== undefined` which could infinite-loop without MAC!). Calling `getLatestCommit` MUST ALWAYS carry a valid verified MAC on HTTP 200.
   - Extend `assertBoundedRecordPage` (`packages/protocol/src/atproto/record-pages.ts:42-49`) with optional `excludeValues?: boolean` and optional `collection` support (allowing omitted `value` when `excludeValues: true`, and keying duplicate detection by composite **`${record.collection}/${record.rkey}`** when `collection` is omitted because workspace `roster`/`admin` and task records legitimately share `rkey`s across collections!). Align `FakeNetwork.listRecords` (`packages/testing/src/fake-network.ts:639-646`) with pinned PDS `listRecords.ts:35` (optional `collection`, `excludeValues`, ordering and cursors by full record **`uri`** rather than `rkey` alone).
   - Add dedicated **`SpaceCredential.fetchVerifiedRepoStar(pdsUrl, { space, repo, maxBytes, maxRecords })`** (NOT via JSON `AtprotoClient.request`): reuses `createSpaceSigHeaders` + `WANT_MAC_HEADER` (`COMMIT_MAC_TYPE`) + 2-attempt `#atproto_kem` refresh on refusal, parses `Atproto-Space-Mac`, streams uncompressed varint/CBOR STAR-lite via `verifyRepoStar`, enforces byte/record limits *while streaming*, and buffers yielded `{ collection, rkey, cid, record }` in staging until `verifyRepoStar`'s EOF `repo.matches(commit)` completes **before** publishing anything to callers or `SyncStore`.
   - Add **`verifyRecordCid(collection, rkey, recordValue, expectedCid)`** converting XRPC JSON -> Lex (`jsonToLex`) and comparing `serializeRecord(collection, rkey, lexValue).cid` against `parseCid(expectedCid)`.
2. **2048-Byte `LtHash` Accumulator State vs. 32-Byte Commit Digest (`SyncStore`):**
   - **CRITICAL:** `RepoCommit.fromState(state)` requires the **2048-byte** `LtHash.state()` (`lthash.ts:6,19-28`), whereas `commit.data` (`state.digest()`, `lthash.ts:52-54`) is the **32-byte** SHA-256 digest!
   - Persist `setHash?: Uint8Array` (**exact 2048-byte `LtHash.state()`**) alongside `rev`, optional `commitDigest?: Uint8Array` (32B), and per-record `cid: string` in `WriterState` / `StoredRecord` inside ONE atomic `SyncStore` transaction.
   - **Never** initialize a non-empty writer's `setHash` from `getLatestCommit` alone (`getLatestCommit` only returns 32B `commit.data`!). Non-empty initial seeding or reset recovery MUST come from:
     - `fetchVerifiedRepoStar` -> `RepoCommit.fromRecords(records).setHash.state()` (`"all"` sync), OR
     - full-repo `listRecords` (no `collection` filter, with `excludeValues: false` for `"all"` sync or `excludeValues: true` for header-only oplog tailing!) matched against MAC-verified `getLatestCommit`, retrying bounded times (`<= 3`) if a concurrent write lands mid-scan.
     - Confirmed `RepoNotFound` per `D11.1 #4` -> empty `new RepoCommit().setHash.state()` (2048 zero bytes).
3. **Materialized Delta Integrity (`listRepoOps` Staging + `prev` Validation):**
   - Keep `ops` in exact PDS response array order (do NOT re-sort by `rev`, as multiple ops in one `applyWrites` batch share equal `rev` and `listRepoOps.ts:63` omits `idx`; allow equal consecutive `rev`, reject strictly decreasing `rev`).
   - Seed `stagedCids: Map<path, Cid | null>` from persisted `StoredRecord.cid` values for complete `"all"` writers.
   - Convert `op.cid` / `op.prev` via `parseCid`. For each op:
     - Validate state machine transition against `stagedCids.get(path) ?? null`:
       - Create (`op.prev === null && op.cid !== null`): requires staged CID is `null`.
       - Update (`op.prev !== null && op.cid !== null`): requires staged CID exists and equals `op.prev`.
       - Delete (`op.prev !== null && op.cid === null`): requires staged CID exists and equals `op.prev`.
     - Update `stagedCids`, `pendingValues`, and `replayed.applyOp({ collection, rkey, cid, prev })`.
     - **Superseded values:** `op.value` may legitimately be `undefined` when a later op in the same repo modified or deleted `(collection, rkey)` (`reader.ts:169-178`). Do NOT require `op.value` for intermediate superseded ops; require valid `op.value` passing `verifyRecordCid` ONLY on surviving final live entries (`stagedCids.get(path) !== null`).
   - After final short page (`commit` + MAC verified): verify `replayed.matches(commit)`, **AND** verify that `RepoCommit.fromRecords(allStagedLiveRecords).setHash.state()` equals `replayed.setHash.state()` before atomically committing `(recordsDelta, rev: commit.rev, setHash: replayed.setHash.state(), commitDigest: commit.data)` under `(generation, epoch)` CAS!
   - On ANY failure (broken `prev` chain, missing surviving value, non-monotonic `rev`, `!replayed.matches(commit)`, pruned oplog, `clearRecords`/`importRepo` reset) -> discard staged delta cleanly and run **Full Verified Recovery** (`fetchVerifiedRepoStar` primary, bounded full `listRecords + getLatestCommit` fallback).
4. **Verified Writer Universe & Roster Provenance:**
   - Do **not** rely on unverified `WorkspaceSummary` (`summarizeWorkspace` drops malformed roster records silently and `WorkspaceClient.summary` discards CIDs via `listBoundedRecords`).
   - Derive a **Verified Workspace Snapshot** (`workspaceSnapshotComplete: boolean`): verifies workspace space commit (`fetchVerifiedRepoStar` / `listRecords` + `getLatestCommit` + CID checks across ALL authority records in workspace), ensures zero malformed/invalid `workspace.roster` or `ext.install` records, zero truncated pages, and counts within `WORKSPACE_ENVELOPE`. Any failure sets `workspaceSnapshotComplete = false` (forcing `complete: false` for Tasks reads).
   - **Writer Universe = `union(listRepos(space), verifiedRosterMembers)`** (+ `authorityDid` if listed in `listRepos` or present in space policy/creators; wait until BOTH `listRepos` removes an evicted member AND `verifiedRosterMembers` omits them before purging under `D14`!).
5. **Host-Ordered Oplog Event Tailing for `AppRuntime` (`platform-refactor.md:1145-1149`):**
   - Explicitly separate **verified current-state sync** from **host-ordered event delivery (`SyncCore.followRepoOps`)**:
     - Acknowledge transport trust boundary honestly: `LtHash` authenticates cumulative set state, not immutable op history across resets (`clearRecords`/`importRepo` erase oplog). Within retained per-repo oplog history (`since` -> head without reset), ops follow exact PDS `(rev, idx)` host order.
     - Initial baseline follow (`deliver = false`): seed 2048-byte `setHash` via `listRecords(excludeValues: true)` + MAC-verified `getLatestCommit` (zero payload downloads on existing channel history!) or empty state per `D11.1 #4`, and record baseline `(uri, cid)` seen-set without invoking handlers. (Writers newly added *after* initial watch start with `deliver = true`.)
     - Incremental delivery (`{ kind: "ops" }`): compute net newly surviving created records in host response order (`op` creating or restoring record whose `uri/cid` wasn't delivered before) AND **advance persisted/in-memory repo `(rev, setHash)` ONLY AFTER the handler acknowledges completion or exhausts `MAX_ATTEMPTS = 3` / `MAX_HOLD_MS = 10 min`**, preserving `KeyWindow`'s exact retry & expiry guarantees (`key-window.ts:10-15,121-159`).
     - Reset / pruned recovery (`{ kind: "reset" }`): recover current state via STAR / `listRecords(excludeValues: true)` + `getLatestCommit`, refresh seen-set so historical records are **never** re-delivered as new events, emit `{ kind: "reset" }` diagnostic notice.
     - Keep `AppRuntime.throttles` (`app-runtime.ts:184`, NOT `KeyWindow`) for per-author command/action rate throttling; update `AppRuntime` (`runApp`) to consume `followRepoOps`.
   - Keep `ChannelClient` `"window"` reads (`channel.message`) strictly within existing `sync-budget.ts` / `performance-envelope.test.ts` budgets (no `setHash` seeding claimed on partial `"window"` reads; optionally verify returned record CIDs locally).

### `D11.4` — Pure Causal Merge Model, Saturated Overflow & Conflict Semantics (`packages/protocol/src/entity-merge.ts`)
1. **Unique Operation ID (`opId`) & Root Inheritance:**
   - Every mutation anchor/edit has `opId = "${repo}/${rkey}"` (with cross-device `rkey` collision protection via `D11.5 #1`).
   - **Implicit root ancestry:** Every valid `*Edit` targeting entity `subject` implicitly treats the valid root creation record's `opId` as a causal ancestor (`root ->* op`), preventing a malformed/minimal `s: []` edit from making entity creation appear concurrent with a delete.
2. **HLC Timestamp Format (`t`) & Executable Stamping Rules:**
   - Fixed-width ASCII string `"${15-digit zero-padded ms}.${4-digit zero-padded hex counter}"` (`MIN_HLC_MS = 1_000_000_000_000`, `MAX_HLC_MS = 999_999_999_999_999`). Validated by strict schema + range in `REGISTRY` (pure, no `Date.now()`).
   - **`advanceHlc({ wallNowMs, ownLast, observedTs, maxDriftMs = 24 * 60 * 60 * 1000 })`:**
     1. Validate finite `wallNowMs >= MIN_HLC_MS` and `< MAX_HLC_MS`.
     2. Compute `cappedRemote` = max `(ms, counter)` across `observedTs`, clamping any remote `t.ms > wallNowMs + maxDriftMs` down to `{ ms: wallNowMs + maxDriftMs, counter: 0 }` (causal dominance `A ->* B` ALWAYS runs *before* HLC tie-break, so an honest write observing a skewed remote record still causally beats it cleanly without poisoning future timestamps!).
     3. Let `prev = maxHlc(ownLast, cappedRemote)` and `nextMs = Math.max(wallNowMs, prev.ms)` (guarantees monotonicity across backward local clock jumps and persisted future `ownLast`!).
     4. If `nextMs > prev.ms` -> `{ ms: nextMs, counter: 0 }`; else if `prev.counter < 0xffff` -> `{ ms: nextMs, counter: prev.counter + 1 }`; else carry `{ ms: nextMs + 1, counter: 0 }` (throwing `HlcRangeError` if `nextMs + 1 > MAX_HLC_MS`).
3. **Closure Survival, Saturated Overflow (`> 256`) & Non-Final Uncertainty Semantics (`s`, `sTruncated`):**
   - Each `*Edit` stores **`s: string[]`** of deterministic 128-bit op hashes **`opRef(repo, rkey) = hex(sha256("${repo}\0${rkey}").slice(0, 16))`** (`32` hex chars per entry regardless of DID length) plus optional **`sTruncated?: true`** boolean (omitted or `true`; `false` forbidden by `REGISTRY`!).
   - **Normal regime (`|closure| <= 256` and `!op.sTruncated` across all valid ops on entity):**
     - `s` stores the **full observed causal ancestor closure** (`<= 256` entries -> `~8.7 KiB` max; exact `256` entries stays normal/final!).
     - Therefore when intermediate author `B` leaves or is purged under `D14`, path `D -> B -> R` survives **directly** via `D ∈ R.s` across cached and cold `@flock/reader` reads!
     - **Benign `D14` dangling `opRef`s:** If `complete === true`, no valid op has `sTruncated === true` (and `op.s.length <= 256`), and `!cycleDetected`, an absent `opRef` inside `op.s` (caused cleanly by a former member leaving under `D14`) does **NOT** trigger `uncertainAncestry` — causal reachability among all surviving records stays 100% exact!
   - **Saturated / Tampered regime (`|closure| > 256` on write, OR ANY valid op on entity has `sTruncated: true`, OR `op.s.length > 256`, OR a detected cycle):**
     - **Writing client saturation rule (bounded `<= 256`, zero unrankable metadata):** If `|closure| > 256` (including the 257+ concurrent deletes case!):
       1. Set **`sTruncated: true`** on the written `*Edit` record (durably recording overflow in the PDS record itself so ALL cold readers & subsequent writes see and inherit it!).
       2. Fill `s` deterministically up to **256 entries** via 3 prioritized caps:
          - **Tier 1 (capped at 256):** live synced **un-superseded** lifecycle ops (`deleted: true` / `deleted: false`), sorted descending by total order `(t, repo, rkey)` -> keeps the top 256 if `> 256` concurrent deletes exist, cleanly fitting `s.maxLength = 256`!
          - **Tier 2 (remaining slots up to 256):** live minimal causal heads (`antichain` among synced records), sorted descending by `(t, repo, rkey)`.
          - **Tier 3 (remaining slots up to 256):** remaining live synced `opRef`s sorted descending by `(t, repo, rkey)`, followed (if slots remain) by any unresolved/purged inherited `opRef`s (whose `(t, repo, rkey)` disappeared under `D14`) sorted deterministically by ASCII `opRef` hex string!
     - **Durable/Derivable Uncertainty Propagation & Merge Result (`uncertainAncestry === true`):**
       - Any entity with `any(op.sTruncated === true || op.s.length > 256)` OR a detected DAG cycle resolves deterministically on every client and `@flock/reader` to:
         - **`uncertainAncestry: true`**, **`lifecycleFinal: false`**, **`conflictFinal: false`**.
         - **Deterministic fallback state:** Compute reachable causal DAG edges present, remove cycle back-edges deterministically by ordering `(op.t, op.repo, op.rkey)`, apply deletion-wins-over-concurrent-edit across known causal edges + total order `(t, repo, rkey)` over incomparable/saturated ops (so all readers agree identically!).
         - **Non-final behavior:** Suppress per-field Overwrite Activity spam for the saturated entity (`uncertainAncestry` entities do not emit `concurrentFieldOverwrite` / `concurrentDeleteOverwrite` activity notices), and display a single non-final UI warning (**"Task causal history limit reached — merge is best-effort and non-final; archive/duplicate to a fresh task"**).
4. **Entity-Level Deletion Overwrite Rule & Orphan Handling:**
   - When `!uncertainAncestry`: **`merged.deleted === true`** iff at least one valid `deleted: true` op `D` is NOT causally dominated (`D ->* R`) by a valid `deleted: false` explicit restore op `R`.
   - Any concurrent edit/create/restore losing to an active un-superseded `D` emits a **`concurrentDeleteOverwrite`** Activity event (when `complete === true && conflictFinal === true`).
   - **Orphan rule (`D14` removed author):** If a root `task` or `project` record is absent (author removed/left), any orphaned `*Edit` / `taskComment` targeting that missing root is **ignored/dropped** in both `TasksClient` and `independent-tasks.ts` (never resurrecting partial/ghost entities).
5. **Per-Field LWW, Canonical Value Deduplication & Causal Add-Wins OR-Set:**
   - For each scalar field `f`: take maximal antichain `Max(f)` under `happensBefore`; break ties descending by total order `(op.t, op.repo, op.rkey)`.
   - **Equal-value suppression:** Compare field values canonically! Multiple concurrent maximal ops setting the **same canonical value** pick one deterministic winner and do **NOT** populate `otherVersions` or emit Overwrite Activity! Only distinct conflicting concurrent values populate `otherVersions` & emit **`concurrentFieldOverwrite`** (gated on `complete && conflictFinal`).
   - **Causal Add-Wins OR-Set (`assignees`, `labels`):** An item `x` is active iff at least one `add` op for `x` is not causally dominated by a `remove` op for `x`. If an active concurrent `add` overrides a concurrent `remove` of `x` (neither causally precedes the other), emit **`concurrentSetConflict`** Activity (`complete && conflictFinal`).
   - **`taskComment` mutations:** `new.flock.ext.tasks.comment` is author-owned (`createRecord` / author-only `putRecord` with `{ ..., editedAt }` / author-only `deleteRecord`), filtered cleanly when its target `task` is missing or deleted.
   - **`REGISTRY` semantic validation (`registry.ts`):** Reject `clearField: false` (must omit or `true`), `sTruncated: false` (must omit or `true`), setting both `field` and `clearField: true`, self-parenting (`parent === subject`), `add* ∩ remove* ≠ ∅`, and empty/no-op `*Edit` records carrying zero mutations!

### `D11.5` — Client Write Serialization, Account Clock/TID Reservation & Isolated Form Context (`packages/client`)
1. **Account-Wide Atomic HLC + TID Reservation + Cross-Device TID Collision Retry:**
   - Separate **short account-wide clock/TID reservation** from **per-`(accountDid, entityUri)` editing locks**:
     - **Account-wide `reserveStamp(accountDid, spaceUri, observedTs)`:** Serialized per `accountDid` (promise queue + optional `navigator.locks` `flock:clock:${accountDid}`) inside an atomic `SyncStore` `clock` transaction. Computes both `nextTid` (from persisted `(lastTidMs, lastClockId)`) AND `nextHlc = advanceHlc({ wallNowMs, ownLast, observedTs })`, persists updated `max(ownLastHlc)` + `max(lastTid)` immediately **before releasing the reservation** -> parallel writes to *different* entities or reordered remote HTTP completions can **never** regress `ownLastHlc` or produce duplicate local TIDs!
     - **Cross-device same-account TID collision retry:** Because two independent devices without shared storage can pick matching `ms + clockId`, `WriteQueue` catches duplicate-`rkey` rejection from `com.atproto.space.createRecord` and retries up to **`MAX_TID_COLLISION_RETRIES = 5`** times with freshly reserved strictly higher `(ms + 1, freshClockId)` while preserving `observedContext` and `s`!
2. **Isolated Editing Context (`observedContext.baseClosure` — Zero Two-View Chaining Leak!):**
   - Read APIs attach an immutable **`observedContext = { entityUri, formChainId, baseClosure: string[], maxHlc: string, baseUncertain: boolean }`** representing the full causal closure displayed to that open UI form/view (`baseClosure`, NOT just minimal heads!).
   - **Rule forbidding cross-view transitive chaining (`R2-H1`):**
     - Multiple rapid writes emitted from **the same form/card (`formChainId`)** chain onto `formChainId`'s own sequential write list (`baseClosure ∪ { ownWritesInSameFormChainId }`), NEVER importing writes made from *other* UI forms/tabs that might have seen newer remote edits!
     - If another view/member already updated that entity in the store with ops outside `formChainId`'s `baseClosure`: either (a) preserve `formChainId`'s submitted `baseClosure` cleanly so remote edits stay unacknowledged & raise proper overwrite conflicts, OR (b) explicitly require user review (`"Updated elsewhere — Review & merge"`) before acknowledging foreign closures! (Tested explicitly via the **two-view Form 1 / Form 2 + Bob edit regression**!)
   - Inside the per-`(accountDid, entityUri)` lock, enforce cold-start complete-sync verification first (`syncTasksSpace()`).
   - Persist `records`, `writers`, and monotonic `max` `clock` state atomically; if remote `createRecord` succeeded before response drop/local persistence failure (`ambiguous write`), next sync reconciles own PDS records and advances `max` `ownLastHlc`/`lastTid`.

### `D11.6` — ATProto Lexicon Compliance Without `null`
Use explicit `clearDescription?: boolean`, `clearProject?: boolean`, `clearDueDate?: boolean`, `clearParent?: boolean`, and `sTruncated?: boolean` booleans (`type: "boolean"`) rather than nullable fields; forbid `false` and forbid setting both value and `clear*` in `REGISTRY`.

### `D11.7` — Browser-Sovereign Overwrite Activity Persistence (`IndexedDbStore`)
- Seen & dismissed conflict markers live per-DID in `IndexedDbStore`'s `activity` store (and `MemoryStore` for tests), cleared on `signOutAccount` -> `IndexedDbStore.deleteAccount(did)` and on `store.clear()` / `purgeSpace()`. Zero server SQLite storage.
- Trade-off documented explicitly: Activity read/dismiss state is local to each signed-in browser.

### `D11.8` — Operator Extension Provisioning & Append-Only `PERSISTED_KINDS`
- Preserve all **15** prior `PERSISTED_KINDS` (`kinds.test.ts:14-93`) and existing request/step names identically; append `enableExtension` and `disableExtension` (**17** total), add inline `context.step(` calls only for new steps, update `kinds.test.ts`'s `checked` count assertion, and add replay fixtures for partially completed pre-R11 rows (`journal.ts:85,104`).
- `enableExtension` ensures extension space **before** writing `COLLECTION.extInstall` (`active: true, cleanupComplete: false`).
- `disableExtension` writes `COLLECTION.extInstall` (`active: false, cleanupComplete: false`), removes all member access from the extension space via `apps/operator/src/operator/members.ts` wrappers (`removeListMembers` -> `dropMemberList`), verifies zero remaining members, unregisters notices, and **then** updates `ext.install` with `cleanupComplete: true, disabledAt`!
- **Removal Safety (`removeMember`, `leaveWorkspace`, `reconcileWorkspace`):**
  - Read `COLLECTION.extInstall` records from `workspace` space (which pre-R11 grants already permit!).
  - If NO install record exists, OR `ext.active === false && ext.cleanupComplete === true` -> skip extension space cleanly (zero breakage on pre-R11 or cleanly disabled workspaces!).
  - If an extension has `active === true || cleanupComplete === false` AND `ScopeMissingError` prevents reading/updating the Tasks space member list -> **fail cleanly with `AuthorityReauthorizationRequiredError`** rather than reporting removal complete while leaving removed members authorized on the Tasks space!
  - Route ALL member list mutations exclusively through `apps/operator/src/operator/members.ts` wrappers and wire `FOLLOWED_BY_MEMBER_LIST` (`member-access.ts`), `registrations.ts` (`afterOperation`, `syncReconciled*`, `activeWorkspaceSpaces`), and `workspace-envelope.ts`.

### `D11.9` — OAuth Scopes, Legacy Member Reconnect & Least Privilege
- Extend `memberGrantScopes` and `workspaceAuthorityScopes` (`packages/protocol/src/scopes.ts` + `permissions/{member,workspaceAuthority}.json`); keep `appGrantScopes` unchanged.
- **Explicit Legacy Browser Session Behavior (`apps/web/src/browser/session.ts:110`):** When an existing R10 browser session restores (`restoreSession` checks configured scopes globally), missing new R11 extension scopes cleanly triggers reconnect flow preserving `returnTo` URL (tested explicitly in unit + Playwright browser specs!), while operator legacy authority grants surface inline re-consent CTAs without wedging channels.

### `D11.10` — Next.js App Router Routing, Security & OAuth Deep-Link Return (`apps/web`)
- Persistent dynamic layout `apps/web/src/app/(shell)/layout.tsx` (`export const dynamic = "force-dynamic"`, wrapping `<AppEntry>` / `<AccountGate>` + `LiveSpaces`) keeps long-poll & in-memory engine alive across channel/DM/Tasks transitions while `/oauth/callback` and `/oauth/client-metadata.json` remain outside `(shell)`.
- **URL Grammar (`apps/web/src/app/ui/routes.ts`):**
  - `/`, `/w/[authority]/[workspaceSkey]`, `/w/[authority]/[workspaceSkey]/c/[channelSkey]`, `/w/[authority]/[workspaceSkey]/c/[channelSkey]/m/[repo]/[rkey]`, `/w/[authority]/[workspaceSkey]/ext/tasks` (+ `/list`, `/board`, `/p/[repo]/[rkey]`, `/t/[repo]/[rkey]`, `/activity`), `/dm`, `/dm/[convKey]`.
  - Note **`/p/[repo]/[rkey]`** uniquely identifies project genesis records across creators (`packages/protocol/src/keys.ts:163`).
  - **DID encoding (`did:web:localhost%3A3000`):** Route builders encode each path segment with `encodeURIComponent(...)` (so `%3A` travels on wire as `%253A`, and Next App Router's single `decodeURIComponent` delivers `did:web:localhost%3A3000` untouched); `routes.ts` MUST NOT double-decode `params`.
- **Loopback Redirect (`apps/web/src/proxy.ts`):** Handle `localhost` -> `127.0.0.1` HTTP normalization in `proxy.ts` preserving validated pathname & query (`/?invite=...` and deep links!) using regex `/^\/(?![\/\\])/` and asserting `redirectUrl.origin === appUrl.origin` before redirecting. Keep per-request CSP nonces untouched on all deep routes.
- **`returnTo` OAuth Lifecycle:** Capture validated relative `returnTo` *before* `LoginForm`'s `clearAccountScopedState` clears storage and *before* `window.history.replaceState` strips `?thread=` query params, carry across BOTH initial sign-in and `useBrowserSession.connect()` reconnect, validate in `OAuthCallbackView` via `new URL(raw, "https://local.invalid")` (requiring `origin === "https://local.invalid"`, rejecting `\\`, control chars, `//`, `/oauth/*`), consume single-use, and clear on sign-out / failed login!

### `D11.11` — ESLint Boundaries & Reader Independence Proof (`eslint.config.mjs`, `packages/reader`)
- Declare explicit `NO_ENTITY_MERGE_IMPORT` and `NO_EXTENSION_IMPORT` pattern groups (blocking relative `./ext/*`, `../ext/*`, `**/entity-merge*`, package paths, re-exports, and `no-restricted-syntax` for dynamic `await import(...)`) **and spread all existing `BROWSER_CODE` patterns (`NO_NODE_BUILTINS`, `NO_SERVER_CONFIG`, `NO_APP_LAYER`, `NO_CLIENT_NODE_ENTRY`)** into any overlapping flat-config rule block so existing protections are never replaced/dropped!
- Verify `packages/protocol/src/{registry,workspace-summary}.ts` NEVER re-export `entity-merge.ts`. Explicitly add `@atproto/space`, `@atproto/lex-data`, and `@atproto/lexicon` to `packages/reader/package.json` (`parseCid` comes from `@atproto/lex-data`) matching `import/no-extraneous-dependencies`, AND add a **negative ESLint test** proving illegal relative/dynamic imports fail `pnpm lint`!

### `D11.12` — IndexedDB v1 -> v2 Migration (`packages/client/src/indexeddb-store.ts`)
- Bump `VERSION = 2` cleanly with `onupgradeneeded` guarding EVERY v1 objectStore (`if (!db.objectStoreNames.contains(...))`) so existing R10 stores never hit `ConstraintError` and retain cached records & `meta` epochs!
- Add `activity` store and `clock` store (explicitly enumerated in `clear()` and space-scoped `purgeSpace()` cleanup; `clock` stays separate from `meta` which `clear()` preserves!).
- Handle multi-tab `onversionchange` cleanly + test populated v1 -> v2 upgrade, missing `setHash` cold recovery, and transaction failure rollback.

### `D11.13` — Explicit Tasks Envelope, Retention & Quantitative Performance SLOs (`WORKSPACE_ENVELOPE`)
- Extend `WORKSPACE_ENVELOPE`:
  - `extensions: 20`, `taskProjects: 100`, `tasks: 2_000` per workspace, `maxAncestorRefs: 256` per `*Edit`, `maxCommentsPerTask: 200`.
  - STAR & verified sync bounds: `maxStarArchiveBytes: 16 * 1024 * 1024` (16 MiB), `maxStarRecords: 20_000`, `maxRepoOpsPages: 128` (page limit `500`), `maxListRecordsRetry: 3` on concurrent mutation races.
- When `tasks` count or per-entity ops hits cap -> `degraded` / `uncertainAncestry` surfaced prominently (`"Task causal history limit reached — archive or split into a follow-up task"`), never silently dropping records.
- **Frozen real-PDS Tasks workload (`protocol-tests/tasks-performance.test.ts`, two PDS instances, 6-connection-per-origin pool emulation `mapLimited(..., 6)`, `rateLimitsEnabled: false`):**
  - **Dataset & distribution:** `50` active members (`25` per PDS); `20` projects (`~32B` titles); `1,000` tasks (`20`/writer, `~250B` CBOR each); `3,000` `taskEdit`s (`2,900` across `999` tasks at ~`300B` each + `1` hot task with `100` sequential edits across `10` writers to stress `s` up to `100` refs / `~3.8 KiB`); `1,000` `taskComment`s (`~180B` each) = `5,020` total records (`~1.6 MiB` aggregate STAR across 50 repos).
  - **Sampling & Numerical Pass Thresholds (`1` warm-up + `3` measured runs; note pinned `listRepos.ts:21` always emits `cursor` on non-empty pages, so `listBoundedRepos` issues `2` calls for `50` writers `< limit 500`):**
    1. **Cold complete Tasks space load (`getRepo` STAR + verify + `entity-merge`):** **exact** `2 listRepos + 1 getRepo` per writer (`50` STAR calls, `0` N+1 `getRecord` calls); median **`<= 15_000 ms`**, max **`<= 30_000 ms`**.
    2. **Warm reopen within `truthIntervalMs`:** **exact** `2 listRepos` calls (`0` writer calls); median **`<= 250 ms`**.
    3. **Incremental advance (`10` new edits across `5` writers via `listRepoOps`):** `2 listRepos + <= 5 listRepoOps` pages (`0 getRepo` full downloads); median **`<= 1_500 ms`**.
    4. **Reset / concurrent STAR mutation recovery (`clearRecords` + mid-STAR race):** `<= 3` retry attempts, completes in **`<= 5_000 ms`**.
    5. **Oversized STAR rejection:** writer repo exceeding `16 MiB` (`maxStarArchiveBytes`) aborts mid-stream cleanly (`RSS delta < 32 MiB`, `SetAside` reported).
    6. **Channel regression comparison:** record a same-host baseline on `84cfff4` (`sync-budget.ts` + `performance-envelope.test.ts`); after R11 changes, assert **identical per-phase HTTP call counts (`first open`, `reopen`, `one new message`) across `20 / 100 / 200` writers** in `sync-budget.ts`, assert `engineLatest100WarmReads` median `<= 250 ms` & `engineLatest100ColdReads` median within `+15%` of same-host baseline (or `<= 15_000 ms`) alongside `inboxWriterReconciliationMs <= 60_000` in `performance-envelope.test.ts`.

### `D11.14` — Tasks UIUX & Accessibility (`apps/web/src/app/ui/ext/tasks/*`)
- Orbit-aligned compact header (`All tasks` / Project switcher + `+ New project`, `List` | `Board` | `Activity` with unseen badge, filter + sort, `"Sync ↻"`), List & Kanban Board (both drag-and-drop AND accessible keyboard/button status transitions), Task Detail (title, description, status, priority, project, due date, assignees, labels, comments, delete/restore, and per-field **"Concurrent versions"** disclosure with one-click restore), and Activity tab (filterable overwrite/delete/OR-Set conflict feed, Seen/Dismiss, one-click Restore).

---

## 3. Phased Implementation Plan

### Phase R11a — Verified & Complete Sync Engine (`@flock/protocol`, `@flock/testing`, `@flock/client`, `package.json`)
- **Files:**
  - `packages/protocol/src/atproto/space-credential-core.ts` — Verified `listRepoOps` (`MAC_METHODS` + exact short-page/unwritten gating), `SpaceCredential.fetchVerifiedRepoStar` (byte/record streaming bounds + EOF verification before emit), `verifyRecordCid`.
  - `packages/protocol/src/atproto/record-pages.ts` — Add optional `excludeValues?: boolean` & optional `collection` support on `assertBoundedRecordPage` (`:42-49`), checking duplicate identity by `${record.collection}/${record.rkey}` when `collection` is omitted (`record-pages.test.ts` tests shared `rkey` across collections).
  - `packages/testing/src/fake-network.ts` — Fix `listRepos` to emit real `commit.data` (`:654`); make `collection` optional, support `excludeValues`, and paginate/cursor by full record **`uri`** (matching `listRecords.ts:35`) in `listRecords` (`:639-646`); add `listRepoOps` (`(rev, idx)` order, superseded `value: undefined`, short-page commit+MAC, `commit: undefined` on unwritten repo), `getRepo` STAR+MAC, `clearRecords`, `importRepo`, and fault hooks (same-rev batched ops, broken `prev` chains, mid-page commit race, pruned oplog, forged CID/MAC, missing account vs unwritten space `RepoNotFound`).
  - `packages/client/src/{store,memory-store,indexeddb-store}.ts`, `testing/store-contract.ts` — Populated v1 -> v2 IDB upgrade with `setHash` (2048B), per-record `cid`, `activity`, `clock` stores, transactional `commit` + `clock` writes, `onversionchange` safety.
  - `packages/client/src/sync.ts` — Complete verified sync (`union(listRepos, verifiedRoster)`, `RepoNotFound` handling per `D11.1 #4` pre-`classifyRepoFailure`, `listRepoOps` staged `prev`-chain + equal-`rev` order + materialized-set `LtHash` match, STAR / `listRecords(all)` + `getLatestCommit` recovery), verified workspace snapshot derivation, and `followRepoOps` (seeding 2048B `setHash` from STAR/`listRecords(excludeValues: true)`, host-ordered event delivery within retained history, reset dedup, deferred cursor commit on handler ack).
  - `packages/client/src/app-runtime.ts` — Migrate new-record detection onto `SyncCore.followRepoOps` (retaining `AppRuntime.throttles` + retry/expiry behavior), closing `platform-refactor.md:1145-1149`.
  - `package.json` — Register `protocol-tests/verified-sync.test.ts` in `test:acceptance`.
- **Tests & Gate R11a:** Cold -> advance -> reopen -> advance; reordered same-rev ops & broken `prev` chain rejection; superseded `value: undefined` ops; STAR vs `listRecords` mid-page race retries; oversized STAR abort before commit; pruned oplog/`clearRecords`/`importRepo` recovery + `AppRuntime` non-redelivery on reset; forged CID/MAC/unsigned-empty rejection; missing-account vs unwritten-repo `RepoNotFound` + post-write recheck; populated v1 -> v2 IDB migration; real pinned-PDS `verified-sync.test.ts`; `pnpm typecheck && pnpm lint && pnpm test`.

### Phase R11b — Pure Causal Merge Model & Tasks Protocol (`@flock/protocol`)
- **Files:** `packages/protocol/src/nsids.ts`, `lexicons/new/flock/{ext/install,ext/tasks,ext/tasks/*,workspace,operator/execute,permissions/*}.json`, generated `lexicons/api/**`, `scopes.ts`, `extensions.ts`, `workspace-summary.ts`, `registry.ts`, `entity-merge.ts`.
- **Tests & Gate R11b:**
  - `entity-merge.test.ts` — HLC boundary transitions (step-back local clock, persisted future own clock, `0xffff` rollover carry, extreme remote drift clamp, ceiling error), causal-before-HLC dominance, equal canonical value conflict suppression, implicit root ancestry, multi-device concurrent same-DID heads, OR-Set concurrent add+remove Activity, orphan edit/comment drops, exact **`255` vs `256` (still final!) vs `257` (`sTruncated: true`, non-final `uncertainAncestry`)** boundary tests, benign `D14` dangling `opRef`s staying final, AND `> 256` overflow after intermediate writer removal (`opRef` lexicographic tie-break for purged refs) matching cold `@flock/reader`.
  - `entity-merge-oracle.test.ts` — **New brute-force full-DAG event-history reference oracle** testing scalar fields, lifecycle delete/restore, OR-Set, multi-device DIDs, intermediate writer removal `D -> B -> R` without `B`, equal values, arrival permutation invariance, exact `255`/`256`/`257` saturation transitions, AND saturated overflow after writer removal against cold independent read parity.
  - `registry.test.ts`, `registry-conformance.test.ts`, `scope-lexicons.test.ts`, `workspace-summary.test.ts`; `pnpm typecheck && pnpm lint && pnpm test`.

### Phase R11c — Operator Extension Lifecycle & Workspace Discovery (`apps/operator`, `@flock/client`, `package.json`)
- **Files:**
  - `apps/operator/src/operator/kinds/{extension-access.ts,index.ts,invite-member.ts,remove-member.ts,reconcile-workspace.ts,kinds.test.ts}`, `operations.ts`, `membership.ts`, `member-access.ts`, `registrations.ts`, `workspace-envelope.ts`.
  - `packages/client/src/{workspace-client,lifecycle}.ts` — Verified extension/roster discovery & completeness flags (`rosterComplete`), `Lifecycle.keepWorkspaceSpaces`.
  - `package.json` — Register `protocol-tests/extensions-operator.test.ts` in `test:acceptance`.
- **Tests & Gate R11c:** `kinds.test.ts` (17 persisted kinds, pre-R11 partial journal recovery fixtures, static step count); `member-access.test.ts`, `registrations.test.ts`, `membership.test.ts`; removal/leave fails safely with `AuthorityReauthorizationRequiredError` when enabled/uncleaned extension hits `ScopeMissingError` while pre-R11 & cleanly-disabled (`cleanupComplete: true`) workspaces succeed; `extensions-operator.test.ts` real-PDS acceptance; `pnpm typecheck && pnpm lint && pnpm test`.

### Phase R11d — Tasks Engine, Write Serialization & ESLint Boundaries (`@flock/client`, `eslint.config.mjs`)
- **Files:** `eslint.config.mjs`, `packages/client/src/write-queue.ts` (account-wide atomic HLC+TID reservation + cross-device `rkey` collision retry + per-`(account, entity)` lock + Web Locks), `packages/client/src/ext/tasks/{tasks-client,index}.ts`, `packages/client/src/engine.ts`, `apps/web/src/browser/sign-out.test.ts`.
- **Tests & Gate R11d:** Concurrent writes to *different* entities reserve non-colliding TIDs & non-regressing `ownLastHlc` even under reordered HTTP completions and without Web Locks; forced cross-device TID collision triggers PDS conflict retry cleanly; open Form 1 (`baseClosure` `C0`) + Form 2 (sees Bob `B` -> writes `A1`) -> Form 1 submits `A2` does NOT silently acknowledge Bob `B`; ambiguous write timeout/drop recovery on subsequent sync; IDB Activity state wipe on `signOutAccount`; negative ESLint fixture test proving forbidden relative/dynamic imports fail lint; `pnpm typecheck && pnpm lint && pnpm test`.

### Phase R11e — Tasks UI, Extension Admin Controls & Next.js URL Routing (`apps/web`, `protocol-tests/browser`, `package.json`)
- **Files:**
  - `apps/web/src/proxy.ts`, `apps/web/src/app/(shell)/layout.tsx` & App Router route pages (`/`, `/w/...`, `/c/...`, `/m/...`, `/ext/tasks/...`, `/ext/tasks/p/[repo]/[rkey]`, `/dm/...`), `apps/web/src/app/oauth/callback/page.tsx`, `apps/web/src/app/ui/{routes.ts,routes.test.ts,oauth-callback-view.tsx,login-form.tsx,client-api.ts,extensions-panel.tsx,workspace-manager.tsx,ext/tasks/*}`, `apps/web/src/browser/use-browser-session.ts`.
  - `package.json` — Register `protocol-tests/browser/url-routing.spec.ts` and `protocol-tests/browser/tasks.spec.ts` in `test:browser`.
- **Tests & Gate R11e:** `routes.test.ts` (`did:plc`, `did:web`, `did:web:localhost%3A3000` single-decode round-trip, `/p/[repo]/[rkey]` cross-repo same-rkey project uniqueness, `returnTo` open-redirect/backslash/control-char/`//`/`/oauth` rejection); `tasks-ui-logic.test.ts`; Playwright `url-routing.spec.ts` (cold deep links, reload, back/forward, loopback `localhost` -> `127.0.0.1` query/path preservation, legacy-scope session reconnect returning to deep route, CSP inline-script rejection on deep routes); Playwright `tasks.spec.ts` (enable extension, cross-repo project collision navigation, task list/board accessible moves/detail/comments, two-user concurrent edit/delete Activity, restore & dismiss); `pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm test:browser`.

### Phase R11f — Independent Reader Parity, Performance Envelope, BDD & Final Gate
- **Files:** `packages/reader/package.json` (adding `@atproto/space`, `@atproto/lex-data`, `@atproto/lexicon`), `packages/reader/src/independent-tasks.ts`, `packages/client/src/tasks-reader-parity.test.ts`, `protocol-tests/tasks-acceptance.test.ts`, `protocol-tests/tasks-performance.test.ts`, `features/{tasks,url-routing}.feature`, `bdd/`, `CODE-MAP.md`, `.ai/plans/platform-refactor.md`, `package.json` (register `tasks-acceptance.test.ts` & `tasks-performance.test.ts`).
- **Final 6-Gate Acceptance Criteria (run sequentially one suite at a time):**
  1. `pnpm typecheck` (`0` errors, zero `@types/node` in `@flock/protocol` and `@flock/client`)
  2. `pnpm lint` (including negative lint fixture test + `NO_ENTITY_MERGE_IMPORT` + `NO_EXTENSION_IMPORT`)
  3. `pnpm test` (unit + brute-force DAG oracle + IDB v1->v2 migration + reader parity tests)
  4. `pnpm test:acceptance` (includes `verified-sync.test.ts`, `extensions-operator.test.ts`, `tasks-acceptance.test.ts` with real-PDS reader parity, reset recovery, legacy grant upgrades)
  5. `pnpm test:browser` (includes `url-routing.spec.ts`, `tasks.spec.ts`, deep-route CSP check)
  6. `pnpm test:bdd && pnpm test:performance && pnpm test:sync-budget && pnpm test:sync-budget:browser` (Cucumber E2E + measured 50-writer/1k-task Tasks benchmark meeting frozen `D11.13` SLOs + STAR race/cap checks + unchanged channel regression gates)

---

## 4. Review Tracking
- **Round 1 — Codex (`gpt-6.1-sol`, xhigh, read-only):** `VERDICT: REVISE` ([codex-r11-plan-round-1.md](../reviews/codex-r11-plan-round-1.md))
- **Round 1 — Claude Opus (`claude-opus-5-5-high`, read-only):** `VERDICT: REVISE` ([opus-r11-plan-round-1.md](../reviews/opus-r11-plan-round-1.md))
- **Round 2 — Claude Opus (`claude-opus-5-5-high`, read-only):** `VERDICT: READY` ([opus-r11-plan-round-2.md](../reviews/opus-r11-plan-round-2.md))
- **Round 2 — Codex (`gpt-6.1-sol`, xhigh, read-only):** `VERDICT: REVISE` ([codex-r11-plan-round-2.md](../reviews/codex-r11-plan-round-2.md))
- **Round 3 — Claude Opus (`claude-opus-5-5-high`, read-only):** `VERDICT: READY` ([opus-r11-plan-round-3.md](../reviews/opus-r11-plan-round-3.md))
- **Round 3 — Codex (`gpt-6.1-sol`, xhigh, read-only):** `VERDICT: REVISE` ([codex-r11-plan-round-3.md](../reviews/codex-r11-plan-round-3.md))
- **Round 4 — Codex (`gpt-6.1-sol`, xhigh, read-only):** `VERDICT: READY` ([codex-r11-plan-round-4.md](../reviews/codex-r11-plan-round-4.md))
- **Round 4 — Claude Opus (`claude-opus-5-5-high`, read-only):** `VERDICT: READY` ([opus-r11-plan-round-4.md](../reviews/opus-r11-plan-round-4.md))
