## Round 3 — Draft v3

**Scope:** Strict read-only source review against application `84cfff4` and PDS `5d88b414`. All three input hashes remained unchanged. No files modified; no tests or builds executed.

### Round 2 resolution

| Finding | Status | Verification |
|---|---|---|
| **R2-B1** | **Partial** | The 257-delete retention impossibility is removed and non-final results are defined. Overflow contradictions remain below. |
| **R2-H1** | Resolved | Immutable `baseClosure` and chaining restricted to each `formChainId` prevent Form 2’s ancestry entering Form 1’s concurrent submission. [Plan:143–148](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:143) |
| **R2-M1** | Resolved | Atomic stamp reservation, bounded collision retries, and ambiguous-write reconciliation are specified. The pinned duplicate-key code is **`RecordAlreadyExists`**. [Plan:140–148](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:140), [PDS:465–467](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-phase3/packages/pds/src/actor-store/space/transactor.ts:465) |
| **R2-M2** | Resolved | Explicitly accepts unwritten and absent-account responses, with fail-closed conditions and rechecks. [Plan:44–49](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:44) |
| **R2-M3** | Resolved | `/p/[repo]/[rkey]` and cross-repo collision coverage are explicit. [Plan:174–176](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:174), [Plan:244](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:244) |
| **R2-M4** | **Partial** | Numerical Tasks budgets now exist; counting and channel-regression gaps remain below. |
| **Opus #1** | **Partial** | Ordinary dangling references are benign, but the exactly-256 boundary contradicts that resolution. |
| **Opus #2** | Resolved | `baseClosure` and both metadata-page updates are explicit; an additional pagination edge remains below. [Plan:143](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:143), [Plan:214–215](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:214) |
| **Opus #3** | Resolved | Cleanup completion gates skipping disabled extensions; reader dependencies explicitly include `@atproto/lex-data`. [Plan:160–164](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:160), [Plan:182](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:182) |

### Remaining Medium findings

1. **R3-M1 — Exactly 256 ancestors is simultaneously normal and saturated.**  
   The normal regime permits `|closure| <= 256`, but saturation triggers on `s.length >= 256`, even without truncation. An intact 256-reference history therefore receives a false history-limit warning and loses final conflict reporting. Make the predicates consistent and test 255/256/257 explicitly. [Plan:110–125](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:110)

2. **R3-M2 — Overflow ordering cannot rank purged ancestors.**  
   Tier 3 sorts remaining `opRef`s by `(t, repo, rkey)`, but persisted references contain only hashes; benign D14 removal can erase those ordering fields. Define deterministic treatment of missing-reference metadata, and cover overflow after intermediary removal with cold-reader parity. [Plan:109–120](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:109)

3. **R3-M3 — Full-repo pagination needs collection-aware identity.**  
   The planned optional-collection change leaves an additional required correction: the helper rejects duplicate **rkeys**, although workspace roster/admin records legitimately share them. Fake pagination also uses rkey cursors, while the PDS uses record URIs. Specify `(collection, rkey)` duplicate detection, URI-compatible pagination, and a cross-collection same-rkey boundary test. [Helper:47–49](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/packages/protocol/src/atproto/record-pages.ts:47), [Workspace creation:140–141](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/apps/operator/src/operator/kinds/create-workspace.ts:140), [Roster key:130–131](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/apps/operator/src/operator/workspace-state.ts:130), [Fake:645](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/packages/testing/src/fake-network.ts:645), [PDS:35](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-phase3/packages/pds/src/api/com/atproto/space/listRecords.ts:35)

4. **R3-M4 — Performance gates still do not establish the stated budgets.**  
   Cold sync promises exactly one `listRepos`, whereas the existing helper follows the PDS’s nonempty cursor and makes a terminal second request. Explicitly plan that pagination change or revise the budget. Also, unchanged channel tests cannot prove zero regression: reopen-count invariance permits uniformly increased calls, and channel-read timings are reported without latency thresholds. Freeze measurement preconditions and add explicit baseline/count and latency comparisons. [Plan:197–202](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:197), [Pagination:108–111](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/packages/protocol/src/atproto/record-pages.ts:108), [PDS cursor:21](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-phase3/packages/pds/src/api/com/atproto/space/listRepos.ts:21), [Count gate:71–74](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/protocol-tests/sync-budget.ts:71), [Timing reports:378–385](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/protocol-tests/performance-envelope.test.ts:378)

**No new Blocker or High finding identified.**

VERDICT: REVISE