# Proposal: Mitigating Decentralization, Completeness, and Lexicon-Drift Risks

**Status:** Proposed  
**Baseline Risk Analysis:** [`docs/decentralization-risks.md`](../../docs/decentralization-risks.md)  
**Target Scope:** `@flock/protocol`, `@flock/reader`, `@flock/shell`, `@flock/client`, `apps/desk`, `apps/web`, `apps/group-host`, and CI conformance tooling.

---

## 1. Objective

Make open, multi-client ATProto Spaces workspaces **provably resilient, completeness-aware, and backwards-compatible** as independent third-party clients join the ecosystem — without sacrificing Flock's core guarantee that workspaces, channels, messages, and governance live on the open protocol with zero vendor lock-in.

This proposal maps every open risk (`R1`–`R7`) in [`docs/decentralization-risks.md`](../../docs/decentralization-risks.md) to concrete, staged engineering deliverables with explicit acceptance tests.

---

## 2. Phase 1 — Completeness, Omission Detection & Fail-Visible UX (Mitigates R2a, R2b)

**Goal:** Users must always know *exactly* whose messages could not be verified, and clients must actively detect and recover from omitted writers or missing referenced records.

### M1.1 — Structured Per-Writer Completeness Diagnostics (`@flock/reader`, `apps/desk`, `apps/web`)
- **Problem:** `degradedReasons: string[]` tells the user a channel read was partial, not *which* writer DIDs failed, *why* (timeout, 5xx, truncated, KEM-MAC mismatch, schema invalid), or how to retry them.
- **Design:**
  - Extend `IndependentChannelPage` (additively — preserving `degradedReasons` for backwards compatibility) with:
    ```ts
    writerHealth: Array<{
      repoDid: string;
      status: "ok" | "offline" | "timeout" | "rate_limited" | "truncated" | "integrity_error";
      message?: string;
      lastVerifiedAt?: string;
    }>;
    ```
  - Render a compact, expandable **"Channel completeness"** indicator in Desk and Web showing `Verified N/M writers` when healthy and listing the exact unavailable writer DIDs + a **"Retry failed writers"** action when degraded.
- **Exit Gate:** Browser E2E test injects a single failing PDS among 3 writers and proves the UI names the exact failed writer DID, displays all healthy writers' messages, and clears the warning upon retry when the PDS recovers.

### M1.2 — Causal Missing-Reference Detection & Direct Fallback Fetch (`@flock/reader`, `@flock/client`)
- **Problem:** If a Group Host omits a writer from `listWriters` (bug or omission), a message from that writer could go unseen even when another member replies to it.
- **Design:**
  - During channel read/merge, inspect every `parent` URI (and reaction `subject` / task dependency URI) referenced by loaded messages.
  - If a referenced URI's `repoDid` was **not** in the fetched writer set (or the specific `rkey` was not returned):
    1. Attempt a targeted `com.atproto.space.getRecord` directly against that `repoDid`'s PDS (using the existing channel credential + HPKE KEM-MAC verification).
    2. If the record is recovered, include it (and flag `listWriters` staleness in diagnostics); if the PDS reports `RecordNotFound`, render an explicit **"Referenced message unavailable or deleted"** stub; if the PDS is unreachable or fails MAC verification, record a structured completeness warning.
- **Exit Gate:** Protocol parity test omits Bob from a mocked `listWriters` response while Alice replies to Bob's message; reader detects the missing `parent`, fetches Bob's message directly with KEM-MAC verification, and surfaces the `listWriters` discrepancy.

### M1.3 — Periodic Roster-vs-`listWriters` Reconciliation Audit (`@flock/reader`, `@flock/client`)
- **Problem:** Even without replies, a buggy or dishonest Group Host could omit a writer who posted a top-level message.
- **Design:**
  - Add an opt-in / periodic `auditChannelCompleteness(deps, workspaceUri, channelSkey)` mode (and a UI **"Deep verify channel"** action for small/medium channels up to configurable roster cap, e.g., ≤ 50 active members) that queries `com.atproto.space.getLatestCommit` directly against active roster members' PDSes not listed in `listWriters`.
  - If any member repo has commits in the channel space despite being absent from `listWriters`, surface an explicit **`GroupHostOmissionDetected`** alert and fetch the missing records directly.
- **Exit Gate:** Unit + FakeNetwork test proving a Group Host that drops Bob from `listWriters` is caught by `auditChannelCompleteness()` and Bob's messages are recovered.

---

## 3. Phase 2 — Zero Lexicon Drift & Guaranteed Backwards Compatibility (Mitigates R4, R5, R6)

**Goal:** Make accidental breaking Lexicon edits, unknown-field clobbering, and policy-invariant drift **impossible to merge in CI**, and give external developers a single canonical protocol contract.

### M2.1 — Automated Lexicon Compatibility Gate (`scripts/verify-lexicon-compat.mjs`, CI)
- **Problem:** Nothing in CI currently stops a PR from removing a field, narrowing a type, tightening `maxLength`, or making an optional field required on an already-published NSID.
- **Design:**
  - Snapshot the published v1 Lexicon baseline (anchored to the published `_lexicon.*` release tag/manifest) and add `pnpm verify:lexicons:compat` enforcing ATProto evolution rules:
    - **Forbidden on existing NSIDs:** deleting properties, changing primitive/ref types, adding fields to `required`, shrinking `maxLength`/`maxGraphemes`, removing values from closed `enum`, or changing record `key` type (`tid` vs `literal:self`).
    - **Allowed on existing NSIDs:** adding new *optional* properties, adding `knownValues`, loosening bounds, adding optional error codes, or introducing new versioned NSIDs / sidecar collections.
  - Wire `pnpm verify:lexicons:compat` into root `pnpm test` / CI.
- **Exit Gate:** Unit tests verifying that every forbidden mutation fails the gate with an exact JSON path error while additive optional fields and new sidecar NSIDs pass.

### M2.2 — Single Canonical Owner for Shared Protocol Invariants (`packages/protocol`)
- **Problem:** `ensureInvitesSpace`'s 4 R13 invariants (and `IncompatibleInvitesSpacePolicyError`) are currently implemented separately in `packages/client/src/workspace-client.ts` and `packages/shell/src/invites.ts`. Future protocol updates could drift between Web and Desk.
- **Design:**
  - Extract pure, browser-safe invariant validators into `@flock/protocol`:
    - `assertCompatibleInvitesSpacePolicy(policy, memberCount)` + single canonical `IncompatibleInvitesSpacePolicyError` in `packages/protocol/src/atproto/invites-policy.ts`.
    - `STANDARD_REPORT_REASON_TYPES` and pure `validateReportPreconditions()` in `packages/protocol/src/moderation.ts` (shared across Group Host, Web, and Shell).
  - Refactor `@flock/client`, `@flock/shell`, and `apps/group-host` to import these single canonical owners (keeping zero forbidden cross-package imports).
- **Exit Gate:** `CODE-MAP.md` shows a single canonical owner for each invariant; existing `invites.test.ts`, `moderation.test.ts`, `boundary.test.ts`, and `eslint` pass with zero warnings.

### M2.3 — Cross-Version Forward/Backward Compatibility Test Matrix (`protocol-tests/compat/`)
- **Problem:** We verify Web vs. Desk on the *same* commit, but not how today's clients handle records written by a *future* client (with extra optional fields or unknown extension collections) or an *older* client (missing newly added optional fields).
- **Design:**
  - Add `protocol-tests/compat/lexicon-compat.test.ts`:
    1. **Forward compatibility (N reading N+1):** Inject unknown optional fields into `message`, `directory`, `membership`, `acceptance`, `profile`, `labeler`, and `rule` records plus unknown `new.flock.ext.future.*` collections; assert `@flock/reader`, `@flock/client`, and `@flock/shell` read cleanly without errors.
    2. **Read-modify-write preservation:** Assert `editChannelMessage` (both Web and Desk) preserves unknown third-party fields verbatim on `putRecord`.
    3. **Control-plane fail-closed:** Assert unknown `join-status` states park in `unsupported_status` and unknown incompatible `invites/self` policies fail closed without destructive mutation.
    4. **Backward compatibility (N+1 reading N):** Replay frozen minimal v1 fixture snapshots lacking all optional fields and assert identical projection across Web, Desk, and Reader.
- **Exit Gate:** Registered in `protocol-tests/suite-manifest.test.ts` and passing in CI.

### M2.4 — Standalone Third-Party Client Conformance Kit (`packages/conformance` / `docs/protocol/client-conformance.md`)
- **Problem:** External developers building their own Flock app have no turnkey test harness to verify their client satisfies security and protocol invariants.
- **Design:**
  - Document the mandatory **Flock Independent Client Contract** (least-privilege OAuth scopes, SSRF rules, authority `repoDid === groupDid` check, bilateral `membership + acceptance` pairing, fresh pre-write credential minting, 4 `invites/self` invariants, unknown-field preservation, `!hide`/`!takedown` handling).
  - Package a reusable black-box conformance runner (reusing `FakeNetwork` / local PDS+Group Host fixture) that any external client can point at via URL or CLI to verify all invariants automatically.
- **Exit Gate:** Both `@flock/web` and `@flock/desk` pass the conformance kit in CI.

---

## 4. Phase 3 — Scale, Equivocation Resistance & Optional E2EE (Mitigates R1, R2b, R3, R5, R7)

**Goal:** Support large workspaces, high-assurance integrity, and sensitive teams without compromising protocol openness.

### M3.1 — Verifiable Untrusted Read-Through Relay / Cache (Mitigates R1)
- **Problem:** Large channels (50–200 active writers) cause high fan-out latency for stateless browser or mobile clients.
- **Design:**
  - Define an optional, **untrusted** read-through channel cache XRPC (self-hostable by any user, workspace, or third party — never mandatory):
    - The cache aggregates paginated writer records/STAR bundles from member PDSes **along with each PDS's original signed commit/CID and KEM-MAC/proof metadata** (or delegates per-record verification back to writer PDSes for sensitive channels).
    - Clients verify record CIDs/signatures locally and fall back directly to writer PDSes if the cache is unreachable, stale, or fails verification.
  - Because the cache is cryptographically verified and optional, it gives centralized-like read speed with **zero vendor lock-in**.
- **Exit Gate:** Benchmark showing ≥5× reduction in browser request fan-out on a 100-writer channel, plus negative test proving a tampered cache response is rejected locally and falls back to direct PDS reads.

### M3.2 — Signed Channel Checkpoints / Lightweight Equivocation Detection (Mitigates R2b)
- **Problem:** A colluding PDS or Group Host could serve split views (withholding a recent valid commit from a specific viewer).
- **Design:**
  - Allow active members or an independent opt-in witness service to periodically publish signed lightweight checkpoint records (`(spaceUri, repoDid, rev, rootCid, observedAt)`) or include the latest observed channel frontier hash in new messages (causal frontier pointers, generalizing `parent`).
  - When a client sees a peer's frontier pointing to a `(repoDid, rev)` newer than what `repoDid`'s PDS served it, the client immediately flags a **`SplitViewEquivocationWarning`** with cryptographic evidence (both signed heads).
- **Exit Gate:** Adversarial test where a mock PDS serves an older commit head to Alice than to Bob; Alice's client detects the mismatch via Bob's message frontier and raises an explicit equivocation alert.

### M3.3 — Optional End-to-End Encrypted Spaces Overlay via MLS (Mitigates R3)
- **Problem:** Permissioned Spaces does not hide plaintext from a user's own PDS host or from the Group Host.
- **Design (Additive — Zero Breaking Changes to v1):**
  - Introduce an optional, capability-negotiated E2EE channel modality using **RFC 9420 MLS (Messaging Layer Security)**:
    - Key packages in personal PDS (`new.flock.e2ee.keyPackage`), MLS welcomes/commits in the channel space (`new.flock.e2ee.commit`), and encrypted payloads (`new.flock.channel.encryptedMessage` with ciphertext + epoch metadata).
    - Announced in `new.flock.directory` via an optional `encryption: "mls-v1"` field (additive!).
    - Non-E2EE clients (including v1 Desk) see the channel gracefully as **"End-to-end encrypted channel — requires an MLS-capable client"** instead of crashing or displaying garbage ciphertext.
- **Exit Gate:** Two MLS-capable clients exchange messages in an encrypted channel where neither the PDS SQLite DB nor the Group Host DB contains plaintext, while a v1 client degrades cleanly.

### M3.4 — Operator-Free Admin Workflows & Upstream Stabilization (Mitigates R5, R7)
- **Design:**
  - Extract a browser-pure, crash-resumable **Admin Orchestration Journal** (mirroring Desk's `IndexedDbLifecycleStore` pattern) for workspace/channel creation so third-party clients can also offer workspace admin flows without running `@flock/operator`.
  - Complete public launch prerequisites tracked in [`PLAN.md`](../../PLAN.md):
    1. Publish `_lexicon.opensocial.group` and `_lexicon.*.flock.new` DNS TXT + schema records and enforce `pnpm verify:lexicons` in CI.
    2. Upstream `strict-credential-expiry.patch` and `.ai/upstream/U1`–`U12` into `@atproto/space` and cut a non-alpha pinned release before inviting external production clients.

---

## 5. Risk-to-Mitigation Traceability Matrix

| Risk | Threat | Mitigation(s) | Phase |
|---|---|---|---|
| **R1** | N-PDS availability & fan-out latency | **M1.1** (per-writer status/retry) + **M3.1** (verifiable untrusted relay cache) | P1, P3 |
| **R2a** | Honest partial-read omission | **M1.1** (structured `writerHealth` UX) | P1 |
| **R2b** | Silent omission / Group Host or PDS equivocation | **M1.2** (causal reference fallback) + **M1.3** (roster audit) + **M3.2** (frontier/witness equivocation detection) | P1, P3 |
| **R3** | Plaintext exposure to PDS / Group Host | **M3.3** (additive MLS E2EE channel overlay) | P3 |
| **R4** | Rogue third-party clients, SSRF, spoofed records | **M2.4** (published client conformance kit) + existing least-privilege scopes & SSRF guards | P2 |
| **R5** | Cross-host partial failure & duplicated lifecycle logic | **M2.2** (canonical shared validators) + **M2.4** (conformance kit) + **M3.4** (Operator-free admin journal) | P2, P3 |
| **R6** | Lexicon drift & N-1/N+1 version breakage | **M2.1** (`verify:lexicons:compat` CI gate) + **M2.2** (single canonical owners) + **M2.3** (N-1/N+1 test matrix) | P2 |
| **R7** | Alpha upstream pin & unpublished DNS lexicons | **M3.4** (public `_lexicon.*` DNS + upstream Spaces stabilization) | P3 |

---

## 6. Recommended Execution Order

1. **Land Phase 2 first for anything touching schemas (`M2.1` + `M2.2` + `M2.3`)** — locking down Lexicon compatibility gates and single canonical owners *before* third-party clients depend on v1 schemas prevents irreversible drift.
2. **Ship Phase 1 (`M1.1` + `M1.2` + `M1.3`) next** — immediately upgrades user trust in message completeness across both `@flock/web` and Flock Desk with low protocol surface area.
3. **Execute Phase 3 (`M3.1` → `M3.4` → `M3.2` → `M3.3`) incrementally** — scale via verifiable caches and stabilize upstream Spaces before layering on optional MLS E2EE.
