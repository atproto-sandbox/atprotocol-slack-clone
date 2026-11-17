# R11 Architecture and Feasibility Review — Round 1

**Artifact:** `.ai/plans/r11-tasks-progress.md`, Draft v1, SHA-256 `f907d6916f8da4899490fd3ffe0c95166d3a57769c9fbee64c9f30e6f705f46d`.

**Verified baseline:** application `84cfff4e5258e9a59b5ac8a0fe9a0eddf2643223`; PDS checkout `5d88b414a98de1ada22c94c78fa0667a7028163c`.

**Method:** Read-only source review and counterexample analysis. No files modified; no builds, tests, or oracle scripts executed. Delegated review was unavailable because agent startup failed.

The architecture follows the requested post-R10 direction, but the locked sync and causal-context decisions contain implementation blockers. Several acceptance gates also need concrete changes before they can substantiate the promised behavior.

## Blocker

### B1 — The plan persists a digest where incremental replay requires the full LtHash state

**Plan:** `.ai/plans/r11-tasks-progress.md:71`, `.ai/plans/r11-tasks-progress.md:78`, `.ai/plans/r11-tasks-progress.md:80`.

**Evidence:** `LtHash` requires a **2,048-byte state**; `digest()` returns SHA-256 of that state. `RepoCommit.matches()` compares this digest with `commit.data`. Therefore, persisting `setHash: commit.data` makes the next `RepoCommit.fromState(setHash)` fail its length check. A successful `getLatestCommit` also provides insufficient information to initialize replay.

Sources: `packages/protocol/node_modules/@atproto/space/src/lthash.ts:6`, `packages/protocol/node_modules/@atproto/space/src/lthash.ts:19`, `packages/protocol/node_modules/@atproto/space/src/lthash.ts:47`, `packages/protocol/node_modules/@atproto/space/src/lthash.ts:52`, `packages/protocol/node_modules/@atproto/space/src/repo-commit.ts:59`.

**Required plan fix:** Store the verified accumulator’s `setHash.state()` separately from the commit digest. Cold sync must reconstruct that accumulator from the entire verified repo. Initialize nonempty tailing from such a snapshot, or an already verified full accumulator—not from `getLatestCommit` alone. Persist records, raw accumulator, revision, and verification metadata in one CAS transaction. Add cold → advance → reopen → advance tests.

### B2 — Compressed causal frontiers lose correctness when intermediate records disappear

**Plan:** `.ai/plans/r11-tasks-progress.md:93`, `.ai/plans/r11-tasks-progress.md:94`, `.ai/plans/r11-tasks-progress.md:97`.

**Counterexample:** Alice deletes a task in operation `D`. Bob observes `D` and writes `B`. Carol observes `B` and explicitly restores the task in `R`, whose compressed frontier contains only `B`. Bob is subsequently removed, deactivated, or clears his records. Alice’s `D` and Carol’s `R` remain readable, but the path proving `D → B → R` disappears. The proposed reducer now treats the deletion as un-restored.

This is reachable under existing purge behavior and the pinned protocol: writer purges delete records, member removal evicts writers, and clearing/importing records discards oplog history.

Sources: `packages/client/src/indexeddb-store.ts:119`, `packages/client/src/sync.ts:146`, `../atproto-spaces-phase3/packages/pds/src/space-policy/manager.ts:124`, `../atproto-spaces-phase3/packages/pds/src/actor-store/space/transactor.ts:303`, `../atproto-spaces-phase3/packages/pds/src/actor-store/space/transactor.ts:380`.

**Required plan fix:** Specify a persistent causal representation that survives permitted record/writer removal, or treat unresolved ancestry as incomplete and prohibit definitive merge/conflict claims. Cached intermediates alone cannot establish fresh-reader parity. Add deletion → intermediary → restore cases with intermediary removal, physical deletion, overwrite, clear, import, and cold independent reads.

Also remove the assertion that 200 members bounds frontier width: concurrent sessions for one DID can create multiple incomparable heads. Define overflow behavior without silently dropping causal knowledge.

## High

### H1 — LtHash equality does not prove that the materialized record delta is correct

**Plan:** `.ai/plans/r11-tasks-progress.md:71`, `.ai/plans/r11-tasks-progress.md:72`, `.ai/plans/r11-tasks-progress.md:73`.

**Evidence:** `applyOp` merely subtracts `prev` and adds `cid`; it does not check that `prev` matches the staged record. These operations commute.

For two same-revision updates `C0 → C1 → C2`, reversing their received order still produces the correct final LtHash for `C2`, while “last operation per key” selects `C1` for storage. Both values can pass CID verification. The authenticated commit can therefore match while the stored records disagree with it.

The PDS orders by internal `(rev, idx)`, but does **not** return `idx` in each operation. Multiple operations legitimately share a revision.

Sources: `packages/protocol/node_modules/@atproto/space/src/repo-commit.ts:42`, `../atproto-spaces-phase3/packages/pds/src/actor-store/space/reader.ts:181`, `../atproto-spaces-phase3/packages/pds/src/api/com/atproto/space/listRepoOps.ts:63`, `../atproto-spaces-phase3/packages/pds/src/actor-store/space/transactor.ts:194`.

**Required plan fix:** Validate each operation’s `prev` against staged per-key CID state before applying it. Preserve response array order, allow equal revisions within a batch, retain opaque pagination cursors, and verify that the committed materialized state corresponds to the authenticated accumulator. Add reordered same-revision updates, duplicate operations, broken `prev` chains, and batches split across pages.

### H2 — The existing roster summary cannot establish the proposed writer-universe completeness

**Plan:** `.ai/plans/r11-tasks-progress.md:65`, `.ai/plans/r11-tasks-progress.md:207`, `.ai/plans/r11-tasks-progress.md:251`.

**Evidence:** `summarizeWorkspace` silently filters invalid roster records and exposes no roster-completeness flag. Its degraded reasons cover truncation and counts, not rejected roster records. `WorkspaceClient.summary` independently lists collections without commit verification or a consistent revision bracket. Its scan helper discards CIDs.

Sources: `packages/protocol/src/workspace-summary.ts:55`, `packages/protocol/src/workspace-summary.ts:60`, `packages/protocol/src/workspace-summary.ts:72`, `packages/client/src/workspace-client.ts:117`, `packages/protocol/src/atproto/record-pages.ts:12`, `packages/protocol/src/atproto/record-pages.ts:322`.

The prior baseline explicitly required a completeness flag covering invalid records as well as truncation and membership bounds: `../atproto-slack-clone/.ai/plans/platform-extensions-tasks.md:120`.

**Required plan fix:** Add one verified roster derivation with explicit completeness and snapshot provenance; feed that result into complete sync. Invalid, unverified, unavailable, truncated, or over-envelope rosters must prevent `complete: true`.

Preserve the actual union: a writer still returned by `listRepos` must remain a source even when absent from the roster. Only remove that source after authority writer-set eviction is established. Add transitional removal, deactivation, and stale-listing tests; distinguish those states from an unwritten roster-only repo.

### H3 — Fresh synchronization is incorrectly substituted for the user’s observed editing context

**Plan:** `.ai/plans/r11-tasks-progress.md:117`, `.ai/plans/r11-tasks-progress.md:119`.

**Evidence:** The plan constructs `s` from all currently known operations inside the write lock. If Alice opens a task, Bob edits it, and Alice submits her older form after a background sync, Alice’s operation acknowledges Bob’s unseen change. Bob’s edit is then discarded as causally superseded and produces no overwrite notice.

The prior baseline explicitly prohibited replacing the user’s displayed view with a newer cache: `../atproto-slack-clone/.ai/plans/platform-extensions-tasks.md:111`, with the corresponding review finding at `:267`.

**Required plan fix:** Reads must return an editing-context token/frontier, and mutation APIs must accept it. Keep the cold-start verified-sync requirement, but distinguish newly synchronized knowledge from user-observed context. Either preserve the submitted context or require explicit confirmation of intervening changes before acknowledging them. Test an edit form held open across another member’s update.

### H4 — Reset recovery cannot reconstruct a reliable host-ordered event history

**Plan:** `.ai/plans/r11-tasks-progress.md:80`, `.ai/plans/r11-tasks-progress.md:81`, `.ai/plans/r11-tasks-progress.md:213`.

**Evidence:** Import and clear discard the oplog. A STAR snapshot restores current records, without their original host operation order. Furthermore, LtHash authenticates the final set, not an event history: omitted create/delete pairs can leave the same final hash.

Sources: `../atproto-spaces-phase3/packages/pds/src/actor-store/space/transactor.ts:289`, `../atproto-spaces-phase3/packages/pds/src/actor-store/space/transactor.ts:314`, `../atproto-spaces-phase3/packages/pds/src/actor-store/space/transactor.ts:380`, `packages/protocol/node_modules/@atproto/space/src/lthash.ts:8`.

The current runtime also has handler retry behavior that must survive replacement: `packages/client/src/key-window.ts:121`.

**Required plan fix:** Separate verified current-state recovery from event delivery. Define an explicit history-gap/reset result, baseline policy after recovery, checkpoint-versus-handler-acknowledgment ordering, retries, and treatment of newly discovered writers. Promise host ordering only within retained per-repo history, with an explicit transport trust boundary; do not claim authenticated historical completeness from a set hash.

Correct the ownership note too: throttling already lives in `AppRuntime.throttles`, independently of `KeyWindow` (`packages/client/src/app-runtime.ts:184`). Retaining `KeyWindow` “solely” for throttling misidentifies its responsibility.

### H5 — Treating an uncovered grant as an absent extension can leave removed members authorized

**Plan:** `.ai/plans/r11-tasks-progress.md:136`, `.ai/plans/r11-tasks-progress.md:249`.

**Evidence:** The existing `appInboxState` returns `"uncovered"` whenever `getSpace` raises a scope error. That result does not prove the space is absent. Its current reconcile branch skips uncovered inboxes.

Sources: `apps/operator/src/atproto/space-ops.ts:58`, `apps/operator/src/operator/kinds/reconcile-workspace.ts:83`.

For Tasks, an extension may already exist before an authority reconnects with narrowed permissions. Silently skipping its removal step leaves the former member in the Tasks member list. Feed authorization consults that list, rather than the workspace roster: `apps/operator/src/operator/member-access.ts:45`.

**Required plan fix:** Distinguish “never enabled/absent” from “enabled but grant uncovered.” Define recoverable handling for required extension revocations; do not report successful full removal when those revocations were skipped. Cover both genuinely pre-R11 workspaces and previously enabled Tasks spaces under narrowed grants.

Require all membership mutations to use the cache-invalidating wrappers in `apps/operator/src/operator/members.ts:8`, `:29`, including recovery and disable paths.

### H6 — `RepoNotFound` is neither an authenticated negative proof nor uniquely an unwritten-space result

**Plan:** `.ai/plans/r11-tasks-progress.md:43`, `.ai/plans/r11-tasks-progress.md:59`, `.ai/plans/r11-tasks-progress.md:67`.

**Evidence:** `getLatestCommit` throws `RepoNotFound` without a commit MAC. The credential transport returns unsuccessful responses before MAC verification. The same error code is also returned when the host has no account for the DID.

Sources: `../atproto-spaces-phase3/packages/pds/src/api/com/atproto/space/getLatestCommit.ts:43`, `packages/protocol/src/atproto/space-credential-core.ts:152`, `../atproto-spaces-phase3/packages/pds/src/api/com/atproto/sync/util.ts:15`.

Thus, a forged unsigned empty response followed by a forged `RepoNotFound` can satisfy the proposed corroboration rule without any authenticated repo state.

**Required plan fix:** State the trust exception explicitly if host-reported emptiness over authenticated HTTPS is accepted. Otherwise, retain incomplete/unverified status; the pinned API supplies no MAC-authenticated negative proof. Define how a missing account is distinguished from an existing account’s unwritten space repo, and test both.

A cleared repo must instead verify as a newer signed empty-set commit: clearing preserves repo state and advances its revision (`../atproto-spaces-phase3/packages/pds/src/actor-store/space/transactor.ts:364`).

### H7 — The final commands will omit the newly proposed acceptance and browser suites

**Plan:** `.ai/plans/r11-tasks-progress.md:217`, `.ai/plans/r11-tasks-progress.md:293`, `.ai/plans/r11-tasks-progress.md:308`, `.ai/plans/r11-tasks-progress.md:316`.

**Evidence:** The root acceptance, browser, and performance scripts enumerate explicit filenames. Adding `verified-sync.test.ts`, `tasks-acceptance.test.ts`, `url-routing.spec.ts`, `tasks.spec.ts`, or a companion Tasks performance file does not register them.

Source: `package.json:22`, `package.json:23`, `package.json:24`.

**Required plan fix:** Add root `package.json` changes to the relevant phases and explicitly register every new suite, or introduce bounded discovery. Require final receipts showing those suites actually executed, including the operator acceptance suite whose filename is currently unspecified.

## Medium

### M1 — Per-entity locking does not protect shared clock and TID allocation

**Plan:** `.ai/plans/r11-tasks-progress.md:114`, `.ai/plans/r11-tasks-progress.md:118`, `.ai/plans/r11-tasks-progress.md:120`, `.ai/plans/r11-tasks-progress.md:265`.

Different entity locks can concurrently read and update the same space clock or account TID state. The existing `tidNow` is stateless and uses only a 10-bit random clock identifier; it does not provide the promised collision-free allocation.

Source: `packages/protocol/src/keys.ts:188`.

**Required plan fix:** Specify an atomic account-wide TID reservation and monotonic space-clock reservation, separate from entity serialization. Extend `SyncStore` with an explicit transaction contract; current `applyOwnWrite` performs separate space and writer writes (`packages/client/src/sync.ts:191`). Define recovery after remote acceptance followed by response loss or local persistence failure. Test different-entity concurrency, shared-store tabs, frozen/backward clocks, and ambiguous write completion.

### M2 — The HLC stamping algorithm leaves boundary behavior unspecified

**Plan:** `.ai/plans/r11-tasks-progress.md:88`, `.ai/plans/r11-tasks-progress.md:90`, `.ai/plans/r11-tasks-progress.md:234`.

The plan specifies formatting and remote skew capping, but omits the complete counter advancement algorithm, overflow beyond `ffff`, backward local clocks, previously persisted future local clocks, and physical-time range exhaustion.

**Required plan fix:** Provide executable transition rules for all these cases, including carry/refusal behavior and precedence among wall time, prior local state, and capped remote observations. Add exact-value tests at each boundary. Causal-frontier reduction before HLC winner selection is sound; preserve that ordering.

### M3 — The old oracle does not validate the new model, and equal-value edits generate false conflicts

**Plan:** `.ai/plans/r11-tasks-progress.md:107`, `.ai/plans/r11-tasks-progress.md:238`.

The existing oracle models one field, one current register per author, transitive vectors, and strictly increasing scalar clocks. It does not exercise the new operation DAG, deletion/restore reducer, OR-Set, missing intermediates, or bounded frontiers.

Sources: `../atproto-slack-clone/.ai/plans/platform-extensions-tasks.oracle.mjs:3`, `:23`, `:32`, `:43`; its limitation is explicitly documented in `../atproto-slack-clone/.ai/plans/platform-extensions-tasks.md:103`.

Separately, the new rule emits conflict activity whenever a field has multiple maximal operations, including concurrent operations setting the same value. The baseline excluded equal canonical values from conflicts (`../atproto-slack-clone/.ai/plans/platform-extensions-tasks.md:97`).

**Required plan fix:** Specify an independent event-history oracle for the actual DAG model and bounded exhaustive workloads. Include lifecycle, OR-Set, equal-value, missing-ancestor, and same-account concurrency cases. Separate concurrent provenance from actionable conflicting values; identical canonical values must not create overwrite notices.

### M4 — The proposed ESLint rules do not fully establish the claimed boundaries

**Plan:** `.ai/plans/r11-tasks-progress.md:164`, `.ai/plans/r11-tasks-progress.md:165`, `.ai/plans/r11-tasks-progress.md:278`.

Core extension restrictions name package/absolute-style imports, while these packages commonly use relative imports. A relative `./ext/tasks/...` import would bypass those named patterns. Additional flat-config blocks can also replace existing `no-restricted-imports` rules instead of extending them.

Sources: `packages/client/src/engine.ts:1`, `eslint.config.mjs:66`, `eslint.config.mjs:74`, `eslint.config.mjs:89`.

The reader’s proposed direct `@atproto/space` import also requires a dependency decision: its manifest currently declares only `@flock/protocol`, and lint enforces declared dependencies.

Sources: `packages/reader/package.json:8`, `eslint.config.mjs:53`.

**Required plan fix:** Specify restrictions covering relative paths, re-exports, and dynamic imports; preserve existing browser/Node boundaries in every matching configuration. Add negative lint fixtures rather than treating a clean ordinary lint run as proof. Declare the reader’s pinned primitive dependencies or an explicitly permitted protocol primitive interface. Add real-PDS Tasks reader parity to the acceptance scope, beyond the proposed unit parity test.

### M5 — Existing IndexedDB tests do not verify an R10 → R11 upgrade

**Plan:** `.ai/plans/r11-tasks-progress.md:168`, `.ai/plans/r11-tasks-progress.md:172`.

The current version is `VERSION = 1`, and `onupgradeneeded` unconditionally creates all stores, including `meta`. Existing tests open fresh databases; retaining those passing tests would not catch duplicate-store creation or destructive upgrade behavior.

Sources: `packages/client/src/indexeddb-store.ts:7`, `packages/client/src/indexeddb-store.ts:21`, `packages/client/src/indexeddb-store.test.ts:12`.

**Required plan fix:** Define an `oldVersion`-guarded migration, retain existing stores/indexes and epoch metadata, and reuse the existing `meta` store appropriately. Add a populated version-1 fixture, upgrade/reopen preservation checks, missing-verification-metadata cold recovery, transaction failure, and another-tab version-change cases. Extend `clear` and space/workspace purge contracts to cover new Activity and clock state where appropriate; current cleanup enumerates stores explicitly (`packages/client/src/indexeddb-store.ts:127`, `:147`).

### M6 — OAuth return-path handling omits existing cleanup and reconnect paths

**Plan:** `.ai/plans/r11-tasks-progress.md:158`, `.ai/plans/r11-tasks-progress.md:288`.

`LoginForm` clears every account-scoped session key except `INVITE_LINK_KEY` and removes the entire query string. Reconnect starts OAuth through another path. Editing only the callback and `client-api.ts` does not establish reliable return-path persistence.

Sources: `apps/web/src/app/ui/login-form.tsx:18`, `apps/web/src/app/ui/login-form.tsx:22`, `apps/web/src/browser/use-browser-session.ts:105`, `apps/web/src/app/ui/client-api.ts:85`.

Also, adding Tasks scopes makes existing member sessions fail the global scope check before an extension-specific operation is attempted (`apps/web/src/browser/session.ts:110`).

**Required plan fix:** Include login and reconnect producers in the file/task list. Define capture-before-query-removal, controlled preservation through login cleanup, single-use consumption, failed/cancelled login handling, and sign-out/account-change deletion. Explicitly document and test the global legacy-member reconnect behavior.

Return-path validation must check the parsed destination’s origin and reject backslashes/control characters and protocol-relative targets; checking only a leading slash is insufficient.

### M7 — Performance and retention gates have no defined Tasks workload or limits

**Plan:** `.ai/plans/r11-tasks-progress.md:176`, `.ai/plans/r11-tasks-progress.md:309`.

“Bounded task/edit records,” “realistic task/edit counts,” and unspecified STAR/page limits do not define a reproducible acceptance workload. The new append-per-mutation model also grows historical records indefinitely unless a supported limit or safe compaction policy is defined.

The existing measured envelope is a concrete chat workload, not a Tasks workload: `protocol-tests/performance-envelope.test.ts:33`.

**Required plan fix:** Specify task counts, comments, edits per entity/writer, total repo bytes, response/page limits, retry budgets, and measured pass thresholds. Define user-visible behavior when append history reaches its bound. Include STAR mutation races, oversized archives, full fallback scans, and preservation of existing channel budgets.

## Low

### L1 — The journal baseline contains 15 prior kinds, not 13

**Plan:** `.ai/plans/r11-tasks-progress.md:248`.

`PERSISTED_KINDS` contains 15 entries, including the three app lifecycle kinds. The `checked === 89` assertion is correctly quoted, but counts static `context.step` call sites—not kinds or expanded runtime steps.

Sources: `apps/operator/src/operator/kinds/kinds.test.ts:14`, `:81`, `:89`, `:159`.

**Required plan fix:** Correct the baseline to 15 kinds and 17 after adding extension operations. Preserve every released request shape and step identifier, append required extension steps, and update the checked-call count to the verified new total. Require recovery fixtures for partially completed pre-R11 rows; request hashes and completed-step names govern replay (`apps/operator/src/operator/journal.ts:85`, `:104`).

### L2 — The plan mislabels the application’s 64 KiB bound as the pinned protocol limit

**Plan:** `.ai/plans/r11-tasks-progress.md:31`.

The application registry limits records to 64 KiB, while the pinned space protocol allows 1 MiB CBOR records.

Sources: `packages/protocol/src/registry.ts:77`, `packages/protocol/node_modules/@atproto/space/src/types.ts:29`, `../atproto-spaces-phase3/packages/pds/src/repo/prepare.ts:180`.

**Required plan fix:** Label 64 KiB as the Flock application limit and distinguish it from transport verification limits.

## Verified sound decisions and necessary boundaries

| Area | Source-backed assessment |
|---|---|
| `listRepoOps` MAC rules | Full pages legitimately omit commit/MAC; short pages carry a commit when written state exists. Historical superseded values are omitted. Sources: `../atproto-spaces-phase3/packages/pds/src/api/com/atproto/space/listRepoOps.ts:46`, `:75`; `../atproto-spaces-phase3/packages/pds/src/actor-store/space/reader.ts:169`. The plan should explicitly mean the **response** continuation cursor when accepting unsigned intermediate pages. |
| STAR and JSON CID verification | `jsonToLex` followed by `serializeRecord` is appropriate for JSON record CID checks. STAR verification must consume the entire generator before publishing records; final set verification happens at EOF. Sources: `packages/protocol/src/atproto/space-credential-core.ts:201`; `packages/protocol/node_modules/@atproto/space/src/sync/provider.ts:49`; `packages/protocol/node_modules/@atproto/space/src/sync/consumer.ts:79`, `:182`. PDS STAR reads are not snapshot-transaction protected: `../atproto-spaces-phase3/packages/pds/src/api/com/atproto/space/getRepo.ts:42`, `:54`; race failures need bounded recovery. |
| Causal merge equations | Per-field maximal-frontier reduction followed by deterministic HLC ordering, delete-until-observed-restore, and causal add-wins observed-remove semantics are coherent **when causal ancestry is intact**. Sources: `.ai/plans/r11-tasks-progress.md:97`, `:105`, `:109`. B2 prevents extending that conclusion to missing ancestry. |
| App Router persistence and CSP | A persistent shell layout with dynamic server rendering and a browser-owned client subtree is feasible. `force-dynamic` does not itself require remounting the client shell. Preserve the browser-only entry boundary and request/response nonce headers. Sources: `apps/web/src/app/ui/app-entry.tsx:6`, `apps/web/src/proxy.ts:9`; [Next.js 16.3.6 CSP guidance](https://github.com/vercel/next.js/blob/v16.3.6/docs/01-app/02-guides/content-security-policy.mdx). |
| DID encoding and loopback redirects | Encode the raw DID as one path segment: literal `%3A` inside a DID must become `%253A` on the URL wire and survive Next’s parameter decoding. Do not decode an already decoded parameter again. Source: `apps/web/node_modules/next/dist/shared/lib/router/utils/route-matcher.js:17`. Redirect to the configured canonical origin while preserving validated path/query; current home redirect drops them (`apps/web/src/app/page.tsx:13`). OAuth callback metadata already canonicalizes loopback to `127.0.0.1` (`apps/web/src/browser/client-metadata.ts:25`). |
| Browser package constraints | The browser compiler configuration excludes ambient Node types, and the root typecheck explicitly checks for `@types/node`. The client’s intentional Node entry is excluded from that browser boundary. Sources: `tsconfig.browser.json:9`, `packages/client/tsconfig.json:7`, `package.json:15`, `eslint.config.mjs:17`. These are inspected safeguards, not fresh passing execution results. |

VERDICT: REVISE