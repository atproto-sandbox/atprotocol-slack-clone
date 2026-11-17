# R11 Implementation Review — Round 4 (`Gemini 4 Carbon (High)`, Strictly Read-Only)

- **Reviewer:** `@review-opus-2` (`gemini-4-carbon-high`)
- **Target Commit:** `00fc1fe535fa0bbbe3dbebaf60d85c3ec6728cf9` (`feat/r11-tasks`)
- **Delta Reviewed:** `git diff 667bb4c8cfa6df4e41886d2a71f9d7e006ef3815..00fc1fe535fa0bbbe3dbebaf60d85c3ec6728cf9` (and full branch context against `84cfff4` + pinned PDS `5d88b414`)
- **Prior Reviews Checked:** `.ai/reviews/carbon-r11-impl-round-3.md` (`M1`) and `.ai/reviews/codex-r11-impl-round-3.md` (`#1`–`#4`)

---

## 1. Verification of Round 3 Findings (`667bb4c..00fc1fe`)

| Round-3 Finding | Status | Verification Evidence (`00fc1fe`) |
|---|---|---|
| **Carbon `M1` / Codex `#1`** — Retained oplog metadata & extra fields bypass cumulative staging byte limit | **RESOLVED** | `fetchRepoOpsPages` (`packages/client/src/sync.ts:208-213, 1412, 1431-1472, 2561-2576`) validates `page.cursor` (`<= 1_024` chars) and every `rawOp` via `isValidRawOp` (`rev <= 64`, `collection <= 317`, `rkey <= 512`, `cid <= 256`, `prev <= 256`) before staging, charges UTF-8 byte lengths of `page.cursor`, `rev`, `collection`, `rkey`, `cid`, `prev`, and `JSON.stringify(value)` against `maxPayloadBytes`, and projects retained ops to `{ rev, collection, rkey, cid, prev, value? }` so unvalidated fields (e.g. `padding`) are stripped immediately. Covered by `packages/client/src/sync.test.ts:1525-1624`. |
| **Codex `#2`** — Delayed cold-sync permanent failure cleanup (`purgeWriter`) erases newer concurrent verified sync | **RESOLVED** | `dropRecordsOnPermanentFailure` (`packages/client/src/sync.ts:1172-1181, 1203-1230`) replaces unconditional `store.purgeWriter` with a CAS-guarded `store.commit` gated on `expectedGeneration: state.generation`, `expectedInvalidationSeq`, and `epoch`, clearing `[...Object.keys(state.coverage), ...collections]` while preserving `syncedRev: state.syncedRev` (`null` on cold failure, non-null on warm failure). Concurrent invalidations, epoch changes, or newer commits advance generation/seq so stale cleanup commits no-op. Covered by `packages/client/src/sync.test.ts:1626-1682`. |
| **Codex `#3`** — Stale hint (`stale: boolean`) defeats permanent-writer backoff indefinitely in `followRepoOps` | **RESOLVED** *(see Low `L1` for `prepare: () => false`)* | `RepoFollowState` (`packages/client/src/sync.ts:229-230, 379-380, 389-391, 692, 723, 743, 799, 835, 846, 869, 2646-2660`) replaces boolean `stale` with monotonic `staleSeq` / `ackedStaleSeq` (`isRepoFollowStale`), snapshots `seenStaleSeq = repoState.staleSeq` before polling `repo`, and advances `ackedStaleSeq = Math.max(repoState.ackedStaleSeq, seenStaleSeq)` across baseline, recovery, replay, reset, and `classifyRepoNotFoundOrFailure` (including permanent failure) while preserving newer concurrent hints (`staleSeq > seenStaleSeq`). Covered by `packages/client/src/sync.test.ts:1684-1775`. |
| **Codex `#4`** — Failed live activation verification permits authority writes on cached `ext.install` | **PARTIALLY RESOLVED** *(introduces Medium `M1`)* | `ensureSyncedForWrite` / `executeSpaceSync` (`packages/client/src/ext/tasks/tasks-client.ts:228-233, 1110-1119, 1223-1225`) reject writes with `TasksWorkspaceUnavailableError` when `!snapshot.workspaceSnapshotComplete`, while non-authority Tasks writer `setAside`s do not block writes (`packages/client/src/ext/tasks/tasks-client.test.ts:825-903`). However, throwing `TasksWorkspaceUnavailableError` inside `executeSpaceSync` poisons `this.inFlightSync` for concurrent readers — see **`M1`** below. |

---

## 2. Remaining / Newly Introduced Findings on `00fc1fe`

### Blocker
None.

### High
None.

### Medium

#### `M1` — Throwing `TasksWorkspaceUnavailableError` inside `executeSpaceSync` rejects concurrent `readSpace` / `useTasksSpace` callers coalesced via `inFlightSync`
- **Location:** `packages/client/src/ext/tasks/tasks-client.ts:294, 320-325, 379, 389, 400, 1121-1147, 1223-1225` (UI caller: `apps/web/src/app/ui/ext/tasks/use-tasks-space.ts:45, 52, 67`).
- **Problem:** `syncSpaceInternal` stores `forWrite = true` executions of `executeSpaceSync` in the same `this.inFlightSync` map that default read callers (`readSpace(workspaceUri)`, `getProject`, `getTask`, `listActivity` with `forWrite = false`, `!options.fresh`, `options.truthIntervalMs === undefined`) join at `tasks-client.ts:1126-1130`:
  ```ts
  const existing = this.inFlightSync.get(workspaceUri);
  if (existing) {
    if (!forWrite && !options.fresh && options.truthIntervalMs === undefined) {
      return existing;
    }
    await existing.catch(() => undefined);
  }
  ```
  In `00fc1fe`, `executeSpaceSync` itself now throws write-only `TasksWorkspaceUnavailableError` at `tasks-client.ts:1223-1225`:
  ```ts
  if (forWrite && !snapshot.workspaceSnapshotComplete) {
    throw new TasksWorkspaceUnavailableError(workspaceUri, snapshot.reason);
  }
  ```
  By contract, `readSpace(workspaceUri)` must **not** throw when `snapshot.workspaceSnapshotComplete === false` (e.g., transient `503` on the workspace authority PDS, `changing`, invalid authority record, or workspace exceeding `WORKSPACE_ENVELOPE` such as `> 100` channels); standalone `readSpace` returns a degraded `TasksSpaceView` (`workspaceSnapshotComplete: false, complete: false, degraded: true`) over cached Tasks state (`packages/client/src/tasks-reader-parity.test.ts:430-445`).
- **Reproduction Trace:**
  1. Client `owner` (or `alice`) warms `workspace` with Tasks enabled and cached tasks.
  2. Workspace authority `listRepoOps`/`getRepo` encounters a transient `503` (or workspace enters envelope-degraded mode with `> 100` channels so `snapshot.workspaceSnapshotComplete === false`).
  3. Caller starts a write (`owner.tasks.createTask(workspace, ...)` or `deleteComment`), which calls `ensureSyncedForWrite` -> `syncSpaceInternal(workspace, {}, true)` and registers `run` (`forWrite = true`) in `this.inFlightSync`.
  4. Before `syncVerifiedWorkspaceSnapshot` finishes, `owner.tasks.readSpace(workspace)` (e.g., `useTasksSpace`'s `LiveSpaces` tick or 60s poll at `apps/web/src/app/ui/ext/tasks/use-tasks-space.ts:45,52`) calls `syncSpaceInternal(workspace, {}, false)` and receives `existing` (`run`).
  5. `syncVerifiedWorkspaceSnapshot` resolves with `workspaceSnapshotComplete: false`; `executeSpaceSync` throws `TasksWorkspaceUnavailableError` at `tasks-client.ts:1224`.
  6. Both `createTask` **and** `readSpace(workspace)` reject with `TasksWorkspaceUnavailableError`, flipping the UI snapshot into a fatal error state instead of rendering cached tasks with degraded status.
- **Fix:** Either:
  1. Tag `inFlightSync` entries with `{ run, forWrite }` so read callers (`!forWrite`) only coalesce onto `!existing.forWrite` runs and otherwise `await existing.run.catch(() => undefined)` before running their own `forWrite = false` sync; **or**
  2. Keep `executeSpaceSync` purely returning `SyncedTasksContext | { disabled: TasksSpaceView }` (never throwing `TasksWorkspaceUnavailableError`) and enforce `!workspaceSnapshotComplete` exclusively in `ensureSyncedForWrite` (`tasks-client.ts:1110-1119`, checking `!synced.disabled.workspaceSnapshotComplete` inside `"disabled" in synced` as well as `!synced.snapshot.workspaceSnapshotComplete`). *(Note: if Tasks was verified live as disabled with `setAside.length === 0` on an envelope-degraded workspace, throwing `TasksExtensionDisabledError` when `extInstall` is verified inactive/absent also preserves disabled-error precedence.)*

### Low

#### `L1` — `followRepoOps` acknowledges `seenStaleSeq` before `input.prepare` approves event delivery
- **Location:** `packages/client/src/sync.ts:799, 846, 975-980, 1020-1026`.
- **Problem:** For post-expiry recovery (`sync.ts:799`) and normal `fetchAndReplayOpsForFollow` batches (`sync.ts:846`), `repoState.ackedStaleSeq = Math.max(repoState.ackedStaleSeq, seenStaleSeq)` runs inside `mapLimited` before `if (input.prepare)` (`sync.ts:975-980`). If `input.prepare` returns `false`, `followRepoOps` exits early at `sync.ts:978` without advancing `repoState.rev` (`sync.ts:1021`) and without recording `repoState.attempts` (`sync.ts:988-1009`), while `repoState.checkedAt = now` and `ackedStaleSeq = seenStaleSeq` remain committed.
- **Reproduction Trace:** An unlisted writer (e.g. `ownPending` or caller-supplied `writers`) or a writer whose authority `listRepos` `repoRev` has not yet caught up (`listedRev === existing.rev`) is marked stale via `markStale(space, repo)` (`staleSeq = 1`) after publishing an event `E1`. `followRepoOps` polls `repo`, stages `E1`, sets `ackedStaleSeq = 1`, and invokes `input.prepare([E1])`, which returns `false`. On the next poll within `truthIntervalMs`, `stalePending` is `false`, `attempts.size` is `0`, and `intervalElapsed` is `false`, deferring retry until `truthIntervalMs` expires. (`AppRuntime.readInbox` at `packages/client/src/app-runtime.ts:468-475` only returns `false` when the app is uninstalled, keeping practical impact Low, though `SyncCore.followRepoOps` is a general engine API.)
- **Fix:** Defer `batch.repoState.ackedStaleSeq = Math.max(batch.repoState.ackedStaleSeq, batch.seenStaleSeq)` for event-bearing batches until after `input.prepare` succeeds (e.g., alongside `sync.ts:1011-1027`, while still acknowledging immediately when `events.length === 0`, on baseline/reset, or on `aside` failure).

---

VERDICT: REVISE
