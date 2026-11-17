# R11 Implementation Review — Round 2 (`Gemini 4 Carbon (High)`)

- **Reviewer:** `@review-opus-2` running on **`gemini-4-carbon-high` (`Gemini 4 Carbon (High)`)**
  - *Auth check:* Checked `/Users/mikestaub/.local/bin/claude auth status` per Round 2 instructions (`"loggedIn": false`); performed Round 2 review directly on `Gemini 4 Carbon (High)`.
- **Mode:** Strictly read-only static, protocol, security, concurrency, causal-merge, sync, operator, URL-routing, UI/accessibility, ESLint-boundary, and test-sufficiency audit (no builds/tests run; zero tracked/untracked workspace modifications).
- **Reviewed Commit:** `17e8fe54fe47afdd3ae605e4945b35aa00a097d2` on `feat/r11-tasks`
  - **Round 1 -> Round 2 Fix Range:** `e19cbd9066a0319858acff3b50dd1927ada3c9d0..17e8fe54fe47afdd3ae605e4945b35aa00a097d2` (`2b84af4`, `b12123c`, `17e8fe5`)
  - **Full R11 Range:** `84cfff4..17e8fe54fe47afdd3ae605e4945b35aa00a097d2`
- **Reference Inputs Checked:** `.ai/reviews/carbon-r11-impl-round-1.md`, `.ai/reviews/codex-r11-impl-round-1.md`, `.ai/plans/r11-tasks-progress.md` (`D11.1`–`D11.14`), `.ai/plans/platform-refactor.md` (`D14`), `SPEC.md`, `eslint.config.mjs`, and pinned PDS `/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-phase3` (`5d88b414`).

---

## Verification of Round 1 Findings

### Carbon Round 1 Findings (`.ai/reviews/carbon-r11-impl-round-1.md`)

| ID | Round 1 Finding | Round 2 Status | Verification Notes |
| --- | --- | --- | --- |
| `Carbon H1` | Cached 60m workspace snapshot without invalidation bypassed `D14`, hid new roster writers, and allowed writes after `disableExtension` | **Mostly Fixed (Residual `M2` below)** | `LiveSpaces.onSpaceChanged` (`use-browser-session.ts:86`, `views.ts:193`), `useTasksSpace` watching `[workspaceUri, tasksSpaceUri]` (`use-tasks-space.ts:17-20`), `OperatorClient.execute` `onWorkspaceMutated` (`engine.ts:63`, `operator-client.ts:112`), `WorkspaceClient.summary({ fresh: true })` (`workspace-client.ts:132`), and `writerDisappeared` / `unexpectedWriter` detection (`tasks-client.ts:1232-1262`) close the `D14` Carol-removal trace (`tasks-acceptance.test.ts:570` passes with `aliceClockOffset = 0`) while keeping `D11.13` Gate 2 at `0` workspace HTTP calls on idle warm reopen (`tasks-performance.test.ts:663`). One cross-engine `disableExtension` gap remains when `prevListedSet` had no non-authority writers (see **M2**). |
| `Carbon H2` | `@flock/client` vs. `@flock/reader` `permanent` / `reason` divergence on `RepoStarLimitError` and `RepoVerificationError` / `StarParseError` | **Resolved** | Unified via `classifyVerifiedRepoFailure` (`packages/protocol/src/atproto/repo-failure.ts:63-72`), called by both `sync.ts:1029` and `independent-tasks.ts:214, 423, 447`. `RepoStarLimitError` (`UpstreamResponseTooLargeError`) -> `{ reason: "its answer is larger than this app reads", permanent: true }` (purging warm cached records via `dropRecordsOnPermanentFailure`); post-retry `RepoVerificationError` / `StarParseError` -> `{ reason: "its records could not be authenticated", permanent: true }`. Covered by cold & warm parity tests in `tasks-reader-parity.test.ts` and `tasks-performance.test.ts:997-1080`. |
| `Carbon M1` | `SyncCore.markSpaceStale` dead code in production (`ChangeFollower` ticks skipped `syncedRev: null` probes) | **Resolved** | `LiveSpaces` (`packages/client/src/views.ts:90, 193`) invokes `await this.onSpaceChanged?.(space)` before reloading bound keys, wired in `apps/web/src/browser/use-browser-session.ts:86` to `(space) => engine.sync.markSpaceStale(space)` and unit-tested in `views.test.ts`. |
| `Carbon M2` | False-positive `concurrentDeleteOverwrite` notices when multiple active deletes have asymmetric causal histories (+ duplicate oracle bug) | **Resolved** | Both `packages/protocol/src/entity-merge.ts:1083-1105` and `packages/protocol/src/entity-merge-oracle.test.ts:82-90` skip any op `i` that causally precedes *any* active un-restored delete (`activeDeletes.some((dIdx) => dag.happensBefore(i, dIdx))`) and evaluate concurrency per active delete. Tested in `entity-merge.test.ts:612-651`. |
| `Carbon L1` | `applyOwnWrite` invalidated `LtHash` delta continuity on the author's next sync/write | **Resolved** | `OptimisticOverlayEntry` (`store.ts:34-38, 217-293`, `memory-store.ts:89-97`, `indexeddb-store.ts:193-206`) records the pre-optimistic `prevRecord` per key on `applyOwnWrite` (`sync.ts:392-400`); `tryAdvanceViaRepoOps` (`sync.ts:1133-1142, 1209-1218`) inverts the overlay to match `state.setHash`, replays `listRepoOps` deltas with `0` `getRepo` calls, reconciles untouched optimistic keys, and clears the overlay on commit. Tested in `store-contract.ts` and `tasks-client.test.ts:668-743`. |

### Codex Round 1 Findings (`.ai/reviews/codex-r11-impl-round-1.md`)

| ID | Round 1 Finding | Round 2 Status | Verification Notes |
| --- | --- | --- | --- |
| `Codex #1` | Unauthenticated HTTP 400 `RepoNotFound` deleted verified cached records | **Resolved** | `sync.ts:1025-1026`, `repo-failure.ts:65-67`, and `independent-tasks.ts:439-449` classify fail-closed `RepoNotFound` as `permanent: false` (`"its host has no repo for it"`) without calling `dropRecordsOnPermanentFailure`, preserving verified cached records while reporting `complete: false`. Verified in `sync.test.ts:681-715`. |
| `Codex #2` | Failed initial baselining deleted follower state and replayed historical commands on `deliver: true` | **Regressed in New-Writer & Post-Baseline Paths (`H2` below)** | Failed baseline writers now retain `repoState.unbaselined = true` (`sync.ts:682, 776`), preventing historical replay in the single-writer recovery test (`sync.test.ts`). However, gating `spaceFollow.baselined` on `setAside.length === 0` (`sync.ts:682, 815-819`) causes every new writer arriving while any initial writer is set aside to drop its first live message/command, and `failure.permanent` after baseline (`sync.ts:770-776`) wipes `rev = null` with `unbaselined = false` (see **H2**). |
| `Codex #3` | JSON fallback and incremental oplog sync bypassed the 16 MiB bound | **Mostly Fixed (Residual `M1` below)** | `listVerifiedBoundedRecords` (`space-credential-core.ts:449-556`) enforces cumulative CBOR `maxBytes` and `maxRecords` page-by-page in both `sync.ts:1349` and `independent-tasks.ts:589`, and `tryAdvanceViaRepoOps` (`sync.ts:1220-1237`) enforces `maxRecords` and `maxBytes` over surviving records (`permanent: true`). However, `fetchRepoOpsPages` (`sync.ts:1248-1293`) still buffers up to `128` pages (`<= 5 MiB` each) in `ops[]` before byte checking runs, and `followRepoOps` (`sync.ts:1457`) enforces neither cap (see **M1**). |
| `Codex #4` | Per-task history allocated quadratic ancestor bitsets before degraded checks | **Resolved** | `MAX_OPS_PER_ENTITY = 1_000` (`workspace-summary.ts:19`, `entity-merge.ts:10, 895-905`) short-circuits `buildCausalDag` before allocating `adj` or `Uint32Array` bitsets, resolving deterministically in `O(N log N)` across lifecycle, scalar LWW, OR-Set, and closure helpers with `uncertainAncestry: true` and `overloadedHistoryEntities` surfaced in `degradedReasons` (`tasks-client.ts:1544`, `independent-tasks.ts:523`, `entity-merge.test.ts:653-708`). |
| `Codex #5` | Retained `projectContext` could write a restored version onto another project | **Resolved** | `ProjectEditorState` (`tasks-ui-logic.ts:390-438`, `tasks-workspace-view.tsx:88, 107-117, 189, 249-265, 303-320`) clears editor state on close/save/cancel/route change and derives restore context from `selectedProject` (`resolveProjectRestoreContext`). Tested in `tasks-ui-logic.test.ts` and `protocol-tests/browser/tasks.spec.ts`. |
| `Codex #6` | Saving a project draft compared against live project instead of opening baseline | **Resolved** | `openProjectEditor` captures `baseline: project` (`tasks-ui-logic.ts:415`), and `submitEditProject` diffs `draft` against `activeProjectEditor.baseline` (`tasks-workspace-view.tsx:253`, `tasks-ui-logic.ts:444-477`). |
| `Codex #7` | Selecting one active delete hid overwritten concurrent edits under multiple deletes | **Resolved** | `entity-merge.ts:1083-1105` and `entity-merge-oracle.test.ts:82-90` evaluate each edit against `concurrentActiveDeletes` and pick the highest-ordered concurrent active delete. Tested in `entity-merge.test.ts:613-630`. |
| `Codex #8` | Local `replyTo` overrode URL thread state across browser Back/Forward | **Resolved** | `ScopedReplyDraft` + `resolveScopedReplyTo(routeKey, routeThread, replyDraft)` (`client-api.ts:13-22`, `workspace-manager.tsx:99-101, 182-191, 215-216, 672-696, 739`) scopes local reply drafts to the exact `routeKey`. Tested in `client-api.test.ts` and `protocol-tests/browser/url-routing.spec.ts`. |
| `Codex #9` | Older permalinks stopped after 5 pages while displaying `"Loading linked message…"` | **UI Hang Fixed, Exposed `D14` / Security Bug (`H1` below)** | `workspace-manager.tsx:243-333` and `channel-view.tsx:157-174` resolve older permalinks via `engine.channels.getMessage` and render `"The linked message was not found in this channel."` when missing. However, `ChannelClient.getMessage` (`channel-client.ts:151-186`) never checks `sync.writers(space)`, exposing **H1** below. |
| `Codex #10` | Missing-writer `MAX_HOLD_MS` expiry lost during follower migration | **Resolved** | `RepoFollowState.holdStartedAt` (`sync.ts:223, 667, 690-715, 777-800`) expires baselined writers after `MAX_HOLD_MS` (`10 min`) of transient fetch failures, re-baselining and emitting `{ kind: "reset" }` without delivering stale commands (`sync.test.ts`). |
| `Codex #11` | `FakeNetwork` cloned repo state before awaiting serialization and dropped concurrent batches | **Resolved** | `FakeNetwork.withRepoLock` (`fake-network.ts:154, 617-636`) serializes all mutations (`putRecord`, `createRecord`, `applyWrites`, `clearRecords`, `importRepo`, `deleteRecord`) per `(spaceUri, repoDid)`. Tested in `fake-network.test.ts:638-672`. |
| `Codex #12` | Computed dynamic `import(path)` bypassed ESLint extension boundaries | **Resolved (Minor Escape Note `L1` below)** | `NO_COMPUTED_DYNAMIC_IMPORT` (`eslint.config.mjs:94-97`) blocks all non-literal and interpolated `ImportExpression`s across restricted modules (`eslint-boundaries.test.ts:216-253`). |
| `Codex #13` | Shell-persistence tests only checked a `window` property rather than React mount/engine continuity | **Resolved** | `shell-lifecycle.ts` (`account-gate.tsx:22`, `use-browser-session.ts:93`) tracks `<AccountGate>` mount/unmount counts plus `WeakMap`-backed `Engine` and `LiveSpaces` instance tokens; both `url-routing.spec.ts` and `url-routing.steps.ts` assert unchanged `ShellLifecycleSnapshot` and DOM `.app-frame` `JSHandle` identity across route transitions and Back/Forward. |
| `SHA-256 Note` | Clarify `LtHash.digest()` is 32B SHA-256 while BLAKE3 XOF expands lanes | **Resolved** | Updated accurately in `.ai/plans/r11-tasks-progress.md:66`, `CODE-MAP.md:128-129`, and `packages/client/src/store.ts:54`. |

---

## Round 2 Findings by Severity

### Blocker

None.

---

### High

#### H1. `ChannelClient.getMessage` + Automatic Permalink Lookup (`workspace-manager.tsx:262`) Bypasses `D14` Writer-Set Authorization, Exfiltrates `Atproto-Space-Credential` Requests to Arbitrary URL-Supplied `did:web` Hosts, and Renders Spoofed Outsider / Evicted Messages Inside Channels

- **Citations:**
  - `apps/web/src/app/ui/workspace-manager.tsx:243-293` (`useEffect` calling `engine.channels.getMessage(ref, targetUri)` whenever `!inLoadedWindow`)
  - `apps/web/src/app/ui/channel-view.tsx:66-73, 157-162` (`linkedMessage` merged into `commandContent` and rendered in `<section aria-label="Linked message">`)
  - `packages/client/src/channel-client.ts:151-186` (`ChannelClient.getMessage`)
  - `apps/web/src/app/ui/routes.ts:182-200` (`parseDecodedSegments` accepting any `isDid(repo)` in `/w/[authority]/[workspaceSkey]/c/[channelSkey]/m/[repo]/[rkey]` and any `?thread=` URI)
- **Problem:**
  In Round 1, channel permalink resolution paged `openContent.loadOlder()` (`ChannelClient.readPage`), which strictly gates candidate authors through `const writers = await this.deps.sync.writers(space, { workspace: ref.workspace })` (`channel-client.ts:113`). In Round 2 (`b12123c`), to resolve Codex `#9`, `workspace-manager.tsx:262` switched to calling `engine.channels.getMessage(ref, targetUri)` automatically whenever `highlightedMessageUri` is not in the loaded 100-message window.

  However, `ChannelClient.getMessage` (`channel-client.ts:151-186`) **never checks `this.deps.sync.writers(space, { workspace: ref.workspace })`** for `target.repo` (or `parentTarget.repo`). Instead, it parses `target.repo` directly from the untrusted URI and immediately calls `this.verifiedMessageRecord(space, target.repo, target.rkey)` -> `resolvePds(target.repo)` + `credential.client(pds)`.
- **Concrete Reproduction Traces:**
  1. **Security — Outsider `Atproto-Space-Credential` Disclosure & Spoofed Message Injection into Private Channels:**
     - `did:web:evil.example` is an external attacker who has **never** been a member or writer of workspace `acme` or private channel `secret`.
     - Attacker sends channel member `alice` a link to `/w/<authority>/acme/c/secret/m/did%3Aweb%3Aevil.example/3k33333aaaaaa` (or `/w/<authority>/acme/c/secret?thread=at%3A%2F%2F<authority>%2Fspace%2Fnew.flock.channel%2Fsecret%2Fdid%3Aweb%3Aevil.example%2Fnew.flock.channel.message%2F3k33333aaaaaa`).
     - `alice` opens the link. `inLoadedWindow` is `false`, so `workspace-manager.tsx:262` invokes `engine.channels.getMessage(ref, targetUri)`.
     - `alice`'s browser resolves `https://evil.example/.well-known/did.json`, mints/reuses `alice`'s live `SpaceCredential` for `secret`, and sends `GET https://evil.example/xrpc/com.atproto.space.getRecord?space=...&repo=did:web:evil.example&...` with `Authorization: Atproto-Space-Credential <jwt>` — leaking the authority-signed JWT, viewer claims, and private space URI directly to `evil.example`.
     - Because `evil.example` controls its own `#atproto_kem` key in `did.json`, `evil.example` can return a schema-valid `new.flock.channel.message` payload with a valid `RECORD_MAC_TYPE` `Atproto-Space-Mac` for `space`. `getMessage` returns the forged message, and `ChannelView` (`channel-view.tsx:158-162`) **renders the non-member's spoofed message inside `secret` under `LINKED MESSAGE`** (and injects it into `commandContent` at `channel-view.tsx:72`, `workspace-manager.tsx:754`).
  2. **Protocol (`D14`) — Resurrection of Evicted Members' & Uninstalled Apps' Messages:**
     - Member `bob` (or installed bot `app`) posts message `M1` in `#general`, and is later removed via `removeMember` / `leaveChannel` / `uninstallApp` (which removes `bob` from `space_writer` on the authority PDS per `D14`, `.ai/plans/platform-refactor.md:119, 409`).
     - `readPage` drops `bob`'s messages (`inLoadedWindow === false`).
     - Opening `/w/<authority>/acme/c/general/m/<bob>/<rkey>` triggers `getMessage`, which queries `bob`'s PDS directly with `alice`'s valid channel credential (`bob`'s PDS only verifies `alice`'s credential for `space`, not `bob`'s writer status) and **renders the evicted member's / uninstalled app's message in `ChannelView`**, violating `D14`.
- **Recommended Fix:**
  In `ChannelClient.getMessage` (`packages/client/src/channel-client.ts:151-186`), resolve `const writers = new Set((await this.deps.sync.writers(space, { workspace: ref.workspace })).map((w) => w.did));` and return `null` before calling `verifiedMessageRecord` / `resolvePds` whenever `!writers.has(target.repo)` (and likewise require `writers.has(parentTarget.repo)` when checking a reply's parent). Note that `sync.writers(space)` already includes `this.did` while `ownWriteAt` is pending (`sync.ts:351`), so reading a newly sent own message (`channel-client.test.ts:236`) continues to work with zero extra authority round-trips when `SpaceState.writers` is already warm.

---

#### H2. `SyncCore.followRepoOps` (`sync.ts:682, 770-776, 815`) Silently Drops First Live Messages/Commands From New Writers Whenever Any Initial Writer Fails Baseline, and Replays Genesis Oplogs After Post-Baseline Permanent Failures

- **Citations:**
  - `packages/client/src/sync.ts:600-611` (`spaceFollow.baselined = input.deliver`)
  - `packages/client/src/sync.ts:675-694` (`unbaselined: !input.deliver || !spaceFollow.baselined`, `shouldBaselineOnly`)
  - `packages/client/src/sync.ts:770-777` (`failure.permanent` wiping `repoState.rev = null` while setting `repoState.unbaselined ||= !input.deliver || !spaceFollow.baselined`)
  - `packages/client/src/sync.ts:815-819` (`spaceFollow.baselined ||= ... && setAside.length === 0 && ...`)
- **Problem:**
  Commit `2b84af4` fixed Codex `#2` by introducing `spaceFollow.baselined`, which only flips from `false` to `true` when **every** writer in `writersList` baselines with `setAside.length === 0` (`sync.ts:815-819`), and initializing any unseen writer `repo` with `unbaselined: !input.deliver || !spaceFollow.baselined` (`sync.ts:682`). This introduces two high-impact protocol bugs in `AppRuntime` channel/inbox event delivery:
- **Concrete Reproduction Traces:**
  1. **Silent drop of live slash commands & channel messages from new writers (`D11.3 #5` & `repo-failure.ts` isolation regression):**
     - An app inbox or channel contains one writer `bob` whose account is `RepoDeactivated` (`permanent: true`), lacks `#atproto_kem`, or whose PDS is temporarily returning `503`.
     - `AppRuntime` runs its initial `deliver: false` baseline (`app-runtime.ts:461`). `alice` baselines (`unbaselined = false`), while `bob` fails (`setAside = [bob]`, `repoState(bob).unbaselined = true`).
     - At `sync.ts:815-819`, because `setAside.length === 1` and `repoState(bob).unbaselined === true`, **`spaceFollow.baselined` stays `false`** — and if `bob` is deactivated (`RepoDeactivated`), `spaceFollow.baselined` stays `false` **for the entire lifetime of the bot process**.
     - Healthy workspace member `carol` (who had never previously written to the app inbox or channel) submits her first `/deploy` command. `ChangeFollower` wakes `AppRuntime`, which calls `followRepoOps({ space, deliver: true })`.
     - At `sync.ts:675-686`, `spaceFollow.repos.get(carol)` is `undefined`, so `carol` is created with `unbaselined: !true || !false` -> **`true`**.
     - At `sync.ts:689-706`, `shouldBaselineOnly` is `true`: `carol`'s live `/deploy` command is ingested via `fetchOpsBaseline` into `spaceFollow.seen` and **silently dropped (`events: []`) without ever invoking `onEvent`** — violating `D11.3 #5` (`.ai/plans/r11-tasks-progress.md:91`: *"Writers newly added after initial watch start with `deliver = true`"*) and allowing one deactivated member to blackhole the first command/message of every subsequent writer (`carol`, `dave`, ...).
     - Furthermore, because `repoState(bob).unbaselined` stays `true`, `writersToCheck` (`sync.ts:667`) re-queries `bob`'s permanently deactivated PDS on **every single `deliver: true` tick** from any healthy user, ignoring `truthIntervalMs`.
  2. **Post-baseline `failure.permanent` wipes `repoState.rev = null` while keeping `unbaselined = false`, replaying genesis oplogs & expired commands on recovery:**
     - Initial baseline succeeds (`spaceFollow.baselined === true`, `repoState(bob).rev = "rev50"`, `repoState(bob).unbaselined = false`).
     - At minute 1 (`deliver: true`), `bob` writes command `C_old` and `bob`'s account enters `RepoSuspended` (`permanent: true`) for 20 minutes (`> MAX_HOLD_MS = 10 min`), or hits a transient `SpaceMacError` (`permanent: true`) from a stale `#atproto_kem` DID cache / proxy fault.
     - At `sync.ts:770-776`, `failure.permanent` wipes `repoState.rev = null`, `repoState.setHash = 0`, and `repoState.cids = new Map()`, while `repoState.unbaselined ||= !true || !true` leaves **`repoState.unbaselined === false`** (and `holdStartedAt = null`).
     - When `bob` is unsuspended (or `#atproto_kem` recovers) at minute 21 (`deliver: true`), `shouldBaselineOnly` (`sync.ts:689`) is `false` and `holdExpired` (`sync.ts:690`) is `false`.
     - `fetchAndReplayOpsForFollow` (`sync.ts:718, 1457`) calls `fetchRepoOpsPages(space, bob, /* since */ undefined, /* excludeValues */ false)` — downloading `bob`'s **entire retained oplog with full inline values from genesis**, executing `C_old` from 20 minutes earlier (bypassing `MAX_HOLD_MS`), and re-delivering any historical records evicted past `MAX_OPS_SEEN_ENTRIES`.
- **Recommended Fix:**
  - Replace `spaceFollow.baselined` with `needsInitialSeed: !input.deliver`: once the initial writer scan (`resolveSpaceWriters` / `input.writers`) succeeds and every writer present in that initial `writersList` has been seeded in `spaceFollow.repos` with `unbaselined: true`, set `spaceFollow.needsInitialSeed = false`. Any initial writer whose baseline failed keeps its own `repoState.unbaselined = true` until it baselines (preserving Codex `#2`), while any new writer first appearing on a later `deliver: true` poll gets `unbaselined: false` and delivers immediately.
  - At `sync.ts:776`, set `repoState.unbaselined = true` unconditionally whenever `failure.permanent` wipes `repoState.rev = null` (matching `MAX_HOLD_MS` expiry at `sync.ts:785`), and track `permanentFailure: boolean` so `writersToCheck` (`sync.ts:667`) only re-probes a permanently failed writer when `!input.deliver || existing.stale || intervalElapsed || reportedSet.has(repo) || listedRevChanged`.

---

### Medium

#### M1. `SyncCore.fetchRepoOpsPages` (`sync.ts:1248-1293, 1457`) Buffers Up to 128 Pages (`~640 MiB`) of `listRepoOps` Payloads in Memory Before Byte/Record Caps Execute, and `followRepoOps` Enforces Neither Cap

- **Citations:**
  - `packages/client/src/sync.ts:1159, 1220-1237, 1248-1293` (`tryAdvanceViaRepoOps`, `fetchRepoOpsPages`)
  - `packages/client/src/sync.ts:1457, 1478-1489` (`fetchAndReplayOpsForFollow`)
  - `/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-phase3/packages/pds/src/actor-store/space/reader.ts:169-178` (pinned PDS `listRepoOps` joins `space_record` on `(uri, cid)` so only surviving live records carry `value`)
- **Problem:**
  To fix Codex `#3`, commit `2b84af4` added page-by-page byte/record enforcement in `listVerifiedBoundedRecords` (`space-credential-core.ts:495-512`) and added a post-replay `liveBytes > input.maxBytes` check in `tryAdvanceViaRepoOps` (`sync.ts:1224-1233`). However, `fetchRepoOpsPages` (`sync.ts:1256-1291`) still loops up to `WORKSPACE_ENVELOPE.maxRepoOpsPages = 128` pages (each up to `MAX_XRPC_RESPONSE_BYTES = 5 MiB`), pushing every page into `const ops: RawRepoOp[] = []` in RAM **before** returning to `tryAdvanceViaRepoOps` or `fetchAndReplayOpsForFollow`:
  1. **Unbounded staging memory in `tryAdvanceViaRepoOps`:** In Codex `#3`'s exact warm-client counterexample (a writer at `rev0` adds 19,900 comments × 10 KB = ~199 MB across ~40 pages, or up to 64,000 ops across 128 pages = ~640 MiB), `fetchRepoOpsPages` downloads and retains all 40–128 pages in `ops[]` before `sync.ts:1231` throws `RepoStarLimitError`. Because the pinned PDS (`reader.ts:169-178`) omits `value` on superseded ops, any `listRepoOps` stream whose cumulative `op.value` bytes exceed `maxBytes` (`16 MiB`) on a stable snapshot already exceeds the repo cap (or raced mid-pagination).
  2. **No byte or record bound in `fetchAndReplayOpsForFollow` (`sync.ts:1457, 1478`):** `AppRuntime` calls `fetchRepoOpsPages` with `excludeValues = false` and calls `replayValidatedRepoOps` without `maxRecords` or `maxBytes`, allowing a single writer in a watched channel or app inbox to force up to 128 × 5 MiB pages into `AppRuntime` memory in one tick.
- **Recommended Fix:**
  Pass a `maxValueBytes` bound (defaulting to `WORKSPACE_ENVELOPE.maxStarArchiveBytes` when `!excludeValues`) into `fetchRepoOpsPages`: track cumulative UTF-8/JSON byte size across non-null `op.value` entries page-by-page and throw `DeltaFallbackError("listRepoOps payload exceeded delta byte bound.")` immediately when exceeded. In `tryAdvanceViaRepoOps`, `DeltaFallbackError` cleanly triggers `recoverFullVerifiedRepo` -> `fetchVerifiedRepoStar` (which aborts mid-stream at `16 MiB` with `RepoStarLimitError`, `permanent: true`); in `fetchAndReplayOpsForFollow`, `DeltaFallbackError` cleanly triggers `{ kind: "reset" }` -> header-only `fetchOpsBaseline(excludeValues: true)` (which already enforces `maxStarRecords` at `sync.ts:1400`). Also pass `maxRecords: WORKSPACE_ENVELOPE.maxStarRecords` to `replayValidatedRepoOps` in `fetchAndReplayOpsForFollow` (`sync.ts:1478`).

---

#### M2. Cross-Engine `disableExtension` Leaves Two Residual Stale-Snapshot Failure Modes in `TasksClient` When `prevListedSet` Had No Non-Authority Writers

- **Citations:**
  - `packages/client/src/ext/tasks/tasks-client.ts:753-784` (`deleteComment` omitting `ensureSyncedForWrite`)
  - `packages/client/src/ext/tasks/tasks-client.ts:1102-1108` (`ensureSyncedForWrite` reusing cached 60m `snapshotTruthInterval`)
  - `packages/client/src/ext/tasks/tasks-client.ts:1215-1262` (`executeSpaceSync` not catching `isAccessLost` on `syncVerifiedSpace` when `snapshotTruthInterval !== 0`)
  - `apps/operator/src/operator/kinds/extension-access.ts:126` (`removeExtraMembers` keeping `authorityDid`)
- **Problem:**
  When `disableExtension(workspace, "tasks")` is executed by **another** admin/tab/engine (so `OperatorClient.onWorkspaceMutated` did not run on this `Engine` instance, and `ChangeFollower` has not fired or is absent in SDK usage) and `prevListedSet` on `tasksSpace` was empty `{}` or contained only `{ authorityDid }` (`removeExtraMembers` never removes `authorityDid` from `tasksSpace`, so `writerDisappeared` at `tasks-client.ts:1235` is `false`):
  1. **Warm member `readSpace` throws unhandled `SpaceCredentialError(403)` instead of returning `{ enabled: false }` (cold-reader parity failure):** Once member `bob`'s 10-minute `SpaceCredential` for `tasksSpace` expires (`T0 + 11m`, still inside the 60-minute `snapshotTruthInterval`), `bobEngine.tasks.readSpace(workspace)` reads cached `snapshot` (`enabled: true`), calls `syncVerifiedSpace(tasksSpace)` -> `credentials.clientFor(tasksSpace)`, and **rejects with `SpaceCredentialError(403, "SpaceNotFound")`** because `disableExtension` removed `bob` from `tasksSpace` — whereas `readIndependentTasksSpace` returns `{ enabled: false, complete: true }`.
  2. **Write methods fail with `SpaceCredentialError(403)` for members and write into the disabled space for `authorityDid`:** Because `ensureSyncedForWrite` (`tasks-client.ts:1103`) allows a 60-minute cached workspace snapshot (and `deleteComment` at `tasks-client.ts:753-784` skips `ensureSyncedForWrite` altogether):
     - A member calling `createTask` at `T0 + 5s` passes `ensureSyncedForWrite` via their cached 10m credential and then throws raw `SpaceCredentialError(403)` at `credentials.fresh(tasksSpace)` (`tasks-client.ts:489`) instead of `TasksExtensionDisabledError`.
     - If `authorityDid` (`ownerEngine`) calls `createTask`, `updateTask`, or `deleteComment` after another admin `alice` disabled Tasks, `credentials.fresh(tasksSpace)` succeeds (the authority always owns `tasksSpace`) and **`ownerEngine` writes new records into the disabled Tasks space** instead of throwing `TasksExtensionDisabledError`.
- **Recommended Fix (preserving `D11.13` Gate 2's `0` workspace HTTP calls on idle warm reopen):**
  1. In `TasksClient.executeSpaceSync` (`tasks-client.ts:1218`), catch `error` from `syncVerifiedSpace`: if `isAccessLost(error)` and `snapshotTruthInterval !== 0`, re-run `syncVerifiedWorkspaceSnapshot(workspaceUri, { truthIntervalMs: 0, fresh: true, signal: options.signal })` and return `buildDisabled(snapshot)` when Tasks is no longer enabled (rethrow `error` otherwise).
  2. Pass `{ truthIntervalMs: 0 }` (or a workspace-only `snapshotTruthInterval = 0` when `forWrite === true`) in `ensureSyncedForWrite` (`tasks-client.ts:1103`) — writes are explicit user mutations outside Gate 2 read benchmarks and cost only a 1-request `listRepoOps` check on `(workspaceUri, authorityDid)` — and call `await this.ensureSyncedForWrite(workspaceUri)` inside `deleteComment` (`tasks-client.ts:761`) before `credentials.fresh(tasksSpace)`.

---

### Low

#### L1. `NO_ENTITY_MERGE_DYNAMIC_IMPORT` and `NO_EXTENSION_DYNAMIC_IMPORT` (`eslint.config.mjs:86, 91`) Inspect `TemplateElement.value.raw` Only, Allowing Escaped Zero-Expression Template Specifiers

- **Citations:**
  - `eslint.config.mjs:85-97`
- **Problem:**
  `NO_COMPUTED_DYNAMIC_IMPORT` (`eslint.config.mjs:95`) permits expressionless template literals (`TemplateLiteral[expressions.length=0]`), while `NO_ENTITY_MERGE_DYNAMIC_IMPORT` and `NO_EXTENSION_DYNAMIC_IMPORT` check `TemplateElement[value.raw=/.../]`. Unlike `Literal[value=/.../]` (which inspects the cooked string and catches `import("./\x65xt/tasks")`), `TemplateElement.value.raw` preserves raw escape sequences, so ``import(`./\x65xt/tasks`)`` or ``import(`./entity-\u006derge`)`` passes all three selectors.
- **Recommended Fix:**
  Match `TemplateElement[value.cooked=/.../]` alongside `value.raw` in `NO_ENTITY_MERGE_DYNAMIC_IMPORT` and `NO_EXTENSION_DYNAMIC_IMPORT`.

---

VERDICT: REVISE
