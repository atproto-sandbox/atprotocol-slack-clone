# R11 Draft v2 — Round 2 Architecture & Feasibility Review

**Artifact:** `.ai/plans/r11-tasks-progress.md`, SHA-256 `7ccaeea0ed786605aec0efd797018e79bbc9dd6b0d89b0450d206272736ed92f`.

**Baselines verified:** application `84cfff4e5258e9a59b5ac8a0fe9a0eddf2643223`; `../atproto-spaces-phase3` at `5d88b414a98de1ada22c94c78fa0667a7028163c`.

**Method:** Strict read-only source inspection, independent review, and critic pass. Artifact hashes remained unchanged. No files modified; no tests, builds, or oracle scripts executed. “Fixed” below means adequately corrected **in the plan**, not implemented or runtime-validated.

## Round 1 finding verification

“Draft” citations below link directly to `.ai/plans/r11-tasks-progress.md`.

| Codex finding | Opus finding | Status | Verification |
|---|---|---|---|
| **B1** | **#1** | Fixed | Separates 2,048-byte accumulator state from the 32-byte digest, reconstructs nonempty baselines from complete records/headers, specifies atomic persistence, and corrects the fake-network digest. [Draft:63](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:63), [Draft:66](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:66), [Draft:188](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:188). |
| **B2** | **#2** | **Partial** | Full ancestor closure fixes the ordinary `D → B → R` case after Bob disappears. Overflow and ancestry-uncertainty semantics remain contradictory; see **R2-B1**. |
| **H1** | **#3**, delta handling | Fixed | Response order, equal revisions, staged `prev` validation, superseded values, and materialized-set equality are explicit. These address the commutative-hash/reordered-materialization counterexample. [Draft:69](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:69), [Draft:78](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:78). |
| **H2** | **#4**, writer universe/orphans | Fixed | Requires a verified roster snapshot, preserves the roster/listRepos union through transitional removal, handles the authority separately, and drops orphan edits/comments consistently. [Draft:82](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:82), [Draft:83](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:83), [Draft:114](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:114). |
| **H3** | — | **Partial** | Immutable editing context fixes direct background-sync substitution, but session-own chaining can import unseen remote ancestry transitively; see **R2-H1**. |
| **H4** | **#5** | Fixed | Distinguishes current-state verification from retained-history ordering, defines baseline/reset behavior, deduplication, handler acknowledgment, retry/expiry, and throttle ownership. [Draft:85](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:85), [Draft:87](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:87), [Draft:88](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:88). |
| **H5** | — | Fixed | Distinguishes absent installs from active/pending-cleanup installs with uncovered grants; requires failed removal instead of skipped revocation and mandates cache-invalidating membership wrappers. Legacy workspace reads are unrestricted by collection (`packages/protocol/src/scopes.ts:40`), so install discovery is feasible. [Draft:145](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:145). |
| **H6** | **#4**, `RepoNotFound` | **Partial** | The HTTPS trust exception and pre-classifier interception are explicit. Missing-account versus unwritten-repo handling remains overstated; see **R2-M2**. |
| **H7** | — | Fixed | Every proposed acceptance/browser/performance suite now has an explicit root-script registration task. The script names match `package.json:22`–`:26`. [Draft:192](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:192), [Draft:206](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:206), [Draft:216](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:216), [Draft:220](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:220). |
| **M1** | **#9**, allocation | **Partial** | Adds account-scoped TID reservation and transactional persistence, but does not finish the shared-HLC or cross-device collision contract; see **R2-M1**. |
| **M2** | **#9**, HLC boundaries | Fixed | Specifies backward-clock behavior, persisted future clocks, remote clamping, counter carry, and range exhaustion. [Draft:99](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:99). |
| **M3** | **#2**, oracle | Fixed, subject to B2 | Replaces the mismatched oracle with a full-DAG reference and explicitly suppresses equal canonical values. Overflow uncertainty still needs an executable contract for the oracle to test. [Draft:117](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:117), [Draft:199](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:199). |
| **M4** | **#7** | Fixed | Covers relative/dynamic imports and re-exports, preserves overlapping flat-config restrictions, declares reader dependencies, and requires negative lint tests plus real-PDS parity. [Draft:163](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:163), [Draft:225](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:225). |
| **M5** | **#8** | Fixed | Guards existing stores, preserves epochs, separates clock/activity storage, extends cleanup, and requires populated-v1 migration, rollback, missing-hash recovery, and multi-tab handling. This addresses the actual unconditional creation in `packages/client/src/indexeddb-store.ts:21`. [Draft:167](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:167). |
| **M6** | **#6** | Fixed | Includes login/reconnect producers, capture before cleanup/query removal, single-use consumption, sign-out/failure cleanup, parsed-origin validation, and safe loopback redirects. CSP nonce preservation is explicit. [Draft:152](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:152), [Draft:159](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:159), [Draft:160](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:160). |
| **M7** | — | **Partial** | Workload totals and transport caps now exist; numerical performance pass thresholds remain absent. See **R2-M4**. |
| **L1** | **#11** | Fixed | Corrects 15→17 kinds, preserves released step identifiers, adds replay fixtures, bounds extension skeys, orders space creation before installation, and names registration integration points. [Draft:51](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:51), [Draft:142](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:142), [Draft:148](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:148). |
| **L2** | **#12** | Fixed | Distinguishes Flock’s 64 KiB cap from the protocol’s 1 MiB cap, correctly describes uncompressed STAR, parses CIDs, and requires full recovery for missing surviving values. [Draft:31](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:31), [Draft:59](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:59), [Draft:71](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:71), [Draft:79](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:79). |
| — | **#3**, transport | Fixed | Method-specific unsigned-page allowance, dedicated binary STAR transport, streaming bounds, EOF verification, full-repo fallback, and separation from partial channel windows are explicit. [Draft:58](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:58), [Draft:91](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:91). |
| — | **#9**, merge/schema edges | Fixed | Defines implicit root ancestry, clear-field rejection, self-parent rejection, overlapping set-mutation rejection, no-op rejection, set-conflict Activity, and comment mutation ownership. [Draft:96](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:96), [Draft:118](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:118), [Draft:120](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:120). |
| — | **#10** | Fixed | Segment encoding preserves literal `%3A` as `%253A` on the wire, forbids second decoding, and requires browser coverage. This matches Next’s decoding at `apps/web/node_modules/next/dist/shared/lib/router/utils/route-matcher.js:19`. [Draft:158](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:158). |

Header-only `followRepoOps` seeding is feasible: the full `(uri,cid)` inventory supplies the headers needed by `RepoCommit.fromRecords`, which consumes only collection, rkey, and CID (`../atproto-spaces-phase3/packages/space/src/repo-commit.ts:22`). A dedicated persistent header store is not inherently required. Likewise, preserving released journal names while appending steps is compatible with existing replay (`apps/operator/src/operator/journal.ts:104`).

## Blocker

### R2-B1 — The 256-reference overflow policy is impossible in one permitted case and lacks finality semantics

**Evidence:** [Draft:109](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:109) requires retaining **all** unsuperseded lifecycle references while keeping at most 256 references. An entity with 257 concurrent valid deletes cannot satisfy both requirements. Member count does not bound concurrent operations.

The dangling-reference branch at [Draft:108](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:108) also lacks a defined merge result. `uncertainAncestry` is named but its persistence and propagation through subsequent writes, removals, and cold reads are unspecified. Meanwhile, deletion remains definitive at [Draft:112](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:112), and Activity requires only sync `complete === true` at [Draft:121](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:121).

**Impact:** Fully verified current records can still have unresolved ancestry. Transport completeness alone cannot justify definitive delete/restore or concurrency claims.

**Required revision:** Define a deterministic saturated result, durable/derivable uncertainty propagation, and non-final merge/Activity behavior when ancestry is unresolved. Cover 257 concurrent lifecycle operations, later writes, intermediate removal, and cold independent reads.

## High

### R2-H1 — Session-own chaining can acknowledge another author’s unseen edit transitively

**Evidence:** [Draft:131](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:131) unions the submitted context with this session’s subsequent writes, while [Draft:106](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:106) requires full ancestor closure.

Counterexample:

1. An old form displays context `C0`.
2. Another view displays Bob’s new edit `B`; Alice writes `A1`, whose closure includes `B`.
3. Alice submits the old form as `A2`.
4. Session-own chaining includes `A1`, so full closure necessarily includes `B`.

**Impact:** `A2` causally supersedes Bob despite the submitted form never displaying his edit—the original silent-overwrite defect returns indirectly.

**Required revision:** Limit automatic chaining to the form’s write sequence without importing unobserved remote ancestry, or require explicit review when an intervening own write introduces it. Add this two-view regression alongside the direct background-sync test at [Draft:211](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:211).

## Medium

### R2-M1 — Shared HLC reservation and cross-device TID collisions remain unresolved

**Evidence:** [Draft:125](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:125) serializes TID reservation, while entity writes use separate locks. Atomic persistence at [Draft:132](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:132) does not itself serialize reading and advancing shared `ownLastHlc`. Reordered remote completions can persist an older computed clock after a newer one.

Furthermore, browser queues/Web Locks do not coordinate separate devices. `tidNow` uses millisecond time plus a 10-bit random clock identifier (`packages/protocol/src/keys.ts:188`), so independent devices can select identical keys despite the global-uniqueness claim at [Draft:95](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:95).

**Required revision:** Specify atomic HLC reservation/max-update behavior and a PDS allocation or collision-retry policy. Test reordered completions, shared-store tabs without Web Locks, and forced cross-device key collisions.

### R2-M2 — Successful DID resolution does not establish an existing account with an unwritten repo

**Evidence:** [Draft:45](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:45) labels the result “confirmed empty unwritten” when DID resolution succeeds. `resolvePds` only obtains and validates the service endpoint (`packages/client/src/did-documents.ts:35`). The pinned PDS returns `RepoNotFound` both for a missing account (`../atproto-spaces-phase3/packages/pds/src/api/com/atproto/sync/util.ts:15`) and an existing account without that space repo (`../atproto-spaces-phase3/packages/pds/src/api/com/atproto/space/getLatestCommit.ts:43`).

**Impact:** The branch does not distinguish the cases requested by Round 1. The explicit HTTPS trust exception resolves the cryptographic objection, but does not establish “never written.”

**Required revision:** Either corroborate account existence or explicitly accept missing-account responses as trusted “no repo” results too. Define and test both cases and their recheck behavior.

### R2-M3 — Project URLs omit part of the project identity

**Evidence:** [Draft:157](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:157) specifies `/p/[projectRkey]`. Record identity includes the creator repo (`packages/protocol/src/keys.ts:163`), and the authoritative entity design places genesis records in their creator’s repo (`../atproto-slack-clone/.ai/plans/platform-extensions-tasks.md:80`).

**Impact:** Two creators can use the same rkey; the URL cannot select one project unambiguously.

**Required revision:** Use `/p/[repo]/[rkey]` or a canonical encoded project URI, with a cross-repo collision test.

### R2-M4 — Performance acceptance still lacks numerical pass thresholds

**Evidence:** [Draft:176](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r10/.ai/plans/r11-tasks-progress.md:176) supplies workload totals and promises latency/HTTP assertions, but supplies no latency or request-count thresholds. It also leaves payload sizes and per-writer/edit distribution unspecified. Existing chat measurements cannot supply Tasks thresholds automatically; for example, `protocol-tests/performance-envelope.test.ts:185` asserts a specific inbox-recovery SLO, while `protocol-tests/sync-budget.ts:71` checks reopen call-count invariance.

**Impact:** Implementers can choose materially different workloads and thresholds while claiming the same gate passed. “Zero regression” remains unquantified.

**Required revision:** Freeze workload distribution, payload sizes, sampling procedure, and numerical latency/request budgets for cold, incremental, and recovery cases. Define the comparison used for channel regression.

## Low

No remaining or newly introduced Low findings identified.

VERDICT: REVISE