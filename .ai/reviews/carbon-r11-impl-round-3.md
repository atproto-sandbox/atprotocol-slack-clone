# R11 Implementation Review — Round 3 (`Gemini 4 Carbon (High)`)

- **Reviewer:** `@review-opus-2` running on **`gemini-4-carbon-high` (`Gemini 4 Carbon (High)`)**
  - *Auth check:* Checked `/Users/mikestaub/.local/bin/claude auth status` per Round 3 instructions (`"loggedIn": false`); performed Round 3 review directly on `Gemini 4 Carbon (High)`.
- **Mode:** Strictly read-only static, protocol, security, concurrency, causal-merge, sync, operator, URL-routing, UI/accessibility, ESLint-boundary, and test-sufficiency audit (no builds/tests run; zero tracked/untracked workspace modifications).
- **Reviewed Commit:** `4b4c7aa8ee47c231fe9160c847d9f2ee7ee76e11` on `feat/r11-tasks`
  - **Round 2 -> Round 3 Fix Range:** `bd6086c0bd21b43f402f04fdcdb92d41854ef4a9..4b4c7aa8ee47c231fe9160c847d9f2ee7ee76e11`
  - **Full R11 Range:** `84cfff4..4b4c7aa8ee47c231fe9160c847d9f2ee7ee76e11`
- **Reference Inputs Checked:** `.ai/reviews/carbon-r11-impl-round-2.md`, `.ai/reviews/codex-r11-impl-round-2.md`, `.ai/plans/r11-tasks-progress.md` (`D11.1`–`D11.14`), `.ai/plans/platform-refactor.md` (`D14`), `SPEC.md`, `eslint.config.mjs`, and pinned PDS `/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-phase3` (`5d88b414`).

---

## Verification of Round 2 Findings

### Carbon Round 2 Findings (`.ai/reviews/carbon-r11-impl-round-2.md`)

| ID | Round 2 Finding | Round 3 Status | Verification Notes |
| --- | --- | --- | --- |
| `Carbon R2-H1` | `ChannelClient.getMessage` + permalink auto-lookup bypassed `D14` writer-set authorization and contacted arbitrary URL-supplied `did:web` hosts | **Resolved** | `packages/client/src/channel-client.ts:155-164` resolves `sync.writers(space, { workspace: ref.workspace })` and rejects `!writers.has(target.repo)` (and `!writers.has(parentTarget.repo)`) *before* `verifiedMessageRecord` / `resolvePds`. Tested for external `did:web` non-resolution/no-credential-leak, spoofed parent DIDs, `>5`-page older listed messages, pending own writes (`ownWriteAt`), and `D14`-evicted writers in `channel-client.test.ts:286-340`. |
| `Carbon R2-H2` | `followRepoOps` dropped first live messages/commands from new writers when any initial writer failed baseline, and replayed genesis oplogs after post-baseline permanent failures | **Resolved** | `needsInitialWriterSeed` (`sync.ts:612, 650-657, 712`) seeds initial writers with `unbaselined: true` while giving later `deliver: true` joiners `unbaselined: false`; `permanentFailure` (`sync.ts:686-693, 875-897, 938-946`) suppresses per-tick hammering while keeping `setAside`; post-baseline `failure.permanent` (`sync.ts:876, 886-890`) sets `unbaselined = true` + `resetOnBaseline = true` so recovery baselines via header-only `fetchOpsBaseline` instead of replaying `listRepoOps(since: undefined)`. Verified in `sync.test.ts:1308-1523` and `app-runtime.test.ts:1135-1233`. |
| `Carbon R2-M1` | `fetchRepoOpsPages` buffered up to 128 pages in `ops[]` before byte/record caps ran, and `followRepoOps` enforced neither cap | **Mostly Fixed (Residual `M1` below)** | Honest multi-page `listRepoOps` streams now enforce `maxOps` and `op.value` `maxPayloadBytes` page-by-page in both `tryAdvanceViaRepoOps` (`sync.ts:1292-1295`) and `fetchAndReplayOpsForFollow` (`sync.ts:1614-1617, 1646`). One hostile-host bypass remains when non-`value` fields carry the bytes (see **M1**). |
| `Carbon R2-M2` | Residual cross-engine `disableExtension` stale-snapshot failures on warm member `readSpace`, member/authority writes, and `deleteComment` | **Resolved** | `executeSpaceSync` (`tasks-client.ts:1236-1249`) catches `isAccessLost(error)` when `snapshotTruthInterval !== 0` and refreshes `workspaceUri` (returning `{ enabled: false }` if disabled, rethrowing `error` if still enabled); `ensureSyncedForWrite` (`tasks-client.ts:1159, 1169`) forces live workspace snapshot verification (`forWrite = true`), and `deleteComment` (`tasks-client.ts:762`) calls `ensureSyncedForWrite`. Idle warm reopen (`D11.13` Gate 2) preserves `0` workspace HTTP calls. Verified in `tasks-client.test.ts:745-823` and `tasks-reader-parity.test.ts:548-573`. |
| `Carbon R2-L1` | Escaped zero-expression template dynamic imports bypassed `TemplateElement[value.raw]` | **Resolved** | `eslint.config.mjs:86-93` inspects both `TemplateElement[value.raw=...]` and `TemplateElement[value.cooked=...]`, verified in `eslint-boundaries.test.ts`. |

### Codex Round 2 Findings (`.ai/reviews/codex-r11-impl-round-2.md`)

| ID | Round 2 Finding | Round 3 Status | Verification Notes |
| --- | --- | --- | --- |
| `Codex R2-#1` | Oplog payload staging appended pages without cumulative byte or operation limits | **Mostly Fixed (Residual `M1` below)** | `fetchRepoOpsPages` (`sync.ts:1413-1428`) enforces `bounds.maxOps` (`40,000`) and `bounds.maxPayloadBytes` (`16 MiB` over `rawOp.value`), but ignores bytes outside `rawOp.value` and retains unvalidated/unstripped `rawOp` objects (see **M1**). |
| `Codex R2-#2` | `markSpaceStale` missed cold generation-0 authority syncs already in flight | **Resolved** | `SpaceState.invalidationSeq` + `SyncStore.invalidateSpace(space, extraRepos)` + `WriterCommit.expectedInvalidationSeq` + non-regressing `putSpace` (`store.ts:75, 117, 148`, `memory-store.ts:40-46, 85-90, 136-152`, `indexeddb-store.ts:87-94, 195-201, 240-260`, `sync.ts:358-362, 379-380, 1055, 1080, 1116, 1145`) reject stale cold commits atomically and retry cleanly. Verified in `store-contract.ts` and `sync.test.ts:1239-1306`. |
| `Codex R2-#3` | Ordinary `workspaces.summary()` could contradict cached Tasks workspace state within `truthIntervalMs` | **Resolved** | `WorkspaceClient.summary` (`packages/client/src/workspace-client.ts:133`) unconditionally calls `await this.deps.sync?.markSpaceStale(uri)` regardless of `options.fresh`. Verified in `tasks-client.test.ts:787-792`. |
| `Codex R2-#4` | One failed initial writer suppressed newly arriving writers' commands | **Resolved** | Fixed via `needsInitialWriterSeed` (`sync.ts:612, 650-657, 712`); verified in `sync.test.ts:1309-1356` and `app-runtime.test.ts:1135-1180`. |
| `Codex R2-#5` | Hold-expiry recovery discarded commands newer than the expiry boundary | **Resolved** | `expiredFloorRkey` (`sync.ts:233, 755-807, 910, 1016`) records `tidNow(Math.floor(now), 0)` when a failed poll expires the 10-minute hold and recovers via `recoverFullVerifiedRepo`, dropping pre-expiry commands (`rkey < cutoff`) while delivering post-expiry commands (`rkey >= cutoff`) with handler-retry preservation. Verified in `sync.test.ts:1358-1467` and `app-runtime.test.ts:1182-1233`. |
| `Codex R2-#6` | Cold STAR vs. JSON fallback / warm delta byte accounting differed near `16 MiB` | **Resolved** | `varintByteLength`, `starHeaderBytes`, `starEntryBytes`, and `computeStarArchiveBytes` (`space-credential-core.ts:451-527, 571-576`, `sync.ts:1360-1372, 1510`, `independent-tasks.ts:620-623`) match `@atproto/space` `serializeRepo` (`star.ts:34-49`, `sync/provider.ts:25-47`) byte-for-byte. Verified at the exact `16 MiB` boundary in `space-credential-core.test.ts:691-740` and `tasks-reader-parity.test.ts:446-546`. |

---

## Round 3 Findings by Severity

### Blocker

None.

---

### High

None.

---

### Medium

#### M1. `SyncCore.fetchRepoOpsPages` (`sync.ts:1413-1428`) Measures Only `rawOp.value` and Retains Unvalidated/Unstripped `rawOp` Objects — Allowing a Hostile PDS to Bypass the Staging Byte Cap With Non-`value` Fields

- **Citations:**
  - `packages/client/src/sync.ts:1413-1428` (`fetchRepoOpsPages`)
  - `packages/protocol/src/atproto/space-credential-core.ts:588-599` (`macVerifies` accepting unsigned intermediate `listRepoOps` pages with `ops.length > 0 && cursor.length > 0`)
  - `packages/protocol/src/atproto/xrpc.ts:5` (`MAX_XRPC_RESPONSE_BYTES = 8 * 1024 * 1024`)
- **Problem:**
  In `fetchRepoOpsPages` (`sync.ts:1417-1428`):
  ```ts
  if (bounds?.maxPayloadBytes !== undefined) {
    for (const rawOp of pageOps) {
      const val = rawOp && typeof rawOp === "object" ? (rawOp as { value?: unknown }).value : undefined;
      if (val !== undefined && val !== null) {
        payloadBytes += utf8Encoder.encode(JSON.stringify(val)).byteLength;
        if (payloadBytes > bounds.maxPayloadBytes) {
          throw new DeltaFallbackError("listRepoOps exceeded cumulative payload byte staging bound.");
        }
      }
    }
  }
  ops.push(...pageOps);
  ```
  Unlike `listVerifiedBoundedRecords` (`space-credential-core.ts:571-584`) and `assertBoundedRecordPage` (`record-pages.ts:104-130`) — which validate bounded `collection`/`rkey`/`cid` fields per page and project each record to known properties — `fetchRepoOpsPages` only inspects `rawOp.value` and pushes the raw `JSON.parse`d `rawOp` objects directly onto `ops[]` without validating `isValidRawOp`, bounding header string lengths, or stripping extra properties.
- **Concrete Counterexample (Hostile Member PDS — Codex R2-#1 Threat Model):**
  A hostile writer-controlled PDS answers `listRepoOps` (in either `syncVerifiedSpace` or `AppRuntime` `followRepoOps`) with `128` (`WORKSPACE_ENVELOPE.maxRepoOpsPages`) unsigned intermediate pages (`cursor = "p1".."p128"`, `commit: undefined`), each containing a single op:
  ```json
  {
    "ops": [{ "rev": "3k...", "collection": "new.flock.channel.message", "rkey": "3k...", "cid": null, "prev": "bafy...", "pad": "<7.5 MiB string>" }],
    "cursor": "p1"
  }
  ```
  (or placing the `7.5 MiB` string inside `rkey`, `collection`, `rev`, `cid`, or `prev` with `value` omitted).
  1. Each page is `< 8 MiB` (`MAX_XRPC_RESPONSE_BYTES`) and passes `macVerifies` (`ops.length === 1 > 0`, non-empty `cursor`, `commit === undefined`).
  2. `ops.length + pageOps.length` reaches at most `128 <= 40,000` (`bounds.maxOps`).
  3. Because `rawOp.value` is `undefined`, **`payloadBytes` remains `0` across all 128 pages**.
  4. `ops.push(...pageOps)` retains all 128 raw objects in memory (**`~960 MiB` retained for a single writer**) before `maxRepoOpsPages` finally terminates the loop.
- **Recommended Fix:**
  Inside `fetchRepoOpsPages` (`sync.ts:1413-1428`), validate each `rawOp` per page (`isValidRawOp(rawOp)` with bounded string lengths, e.g. `rev.length <= 64`, `collection.length <= 317`, `rkey.length <= 512`, `(cid?.length ?? 0) <= 256`, `(prev?.length ?? 0) <= 256` — throwing `DeltaFallbackError` immediately on page 1 if malformed), project each retained op to `{ rev: rawOp.rev, collection: rawOp.collection, rkey: rawOp.rkey, cid: rawOp.cid, prev: rawOp.prev, ...(rawOp.value !== undefined ? { value: rawOp.value } : {}) }` so unknown properties are discarded immediately, and include the op header byte lengths alongside `rawOp.value` in `payloadBytes` when `bounds?.maxPayloadBytes !== undefined`.

---

### Low

None.

---

VERDICT: REVISE
