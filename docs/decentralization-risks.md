# Decentralization Risks in Multi-Client ATProto Spaces Workspaces

**Scope:** Open-protocol multi-client collaboration on `group.opensocial.*` and `new.flock.*` (as proved by `@flock/web` + Flock Desk [`apps/desk`](../apps/desk) + `@flock/shell` [`packages/shell`](../packages/shell)).  
**Companion Mitigation Proposal:** [`.ai/plans/decentralization-risk-mitigations.md`](../.ai/plans/decentralization-risk-mitigations.md)

---

## 1. Executive Summary

Shipping **Flock Desk** alongside **`@flock/web`** proved that two completely independent browser clients — with different UI stacks, different OAuth `client_id`s, zero shared client SDKs, and zero shared backend servers — can interoperate on private workspaces, private channels, invites, messages, and moderation over ATProto Permissioned Spaces and OpenSocial Groups.

Moving from a single centralized application server to an open, multi-client, multi-PDS architecture removes vendor lock-in, **but introduces four fundamental categories of risk** that centralized apps do not face:

1. **Availability, fan-out latency, and distributed partial failures** (N writers across M personal PDSes + Group Hosts).
2. **Completeness and silent omission** (how a user knows they are seeing *all* messages they are entitled to see).
3. **Confidentiality, metadata, and client-side trust boundaries** (Spaces is access control, not E2EE; arbitrary third-party OAuth clients wield real write authority).
4. **Lexicon drift and cross-client version skew** (older and newer independent clients concurrently reading and mutating shared records).

This document catalogs every concrete risk, distinguishes **what the current codebase already mitigates** from **what remains open**, and provides the threat baseline for the mitigation proposal in [`.ai/plans/decentralization-risk-mitigations.md`](../.ai/plans/decentralization-risk-mitigations.md).

---

## 2. Risk Register

### R1 — Availability & N-PDS Fan-Out Latency

| Dimension | Details |
|---|---|
| **Failure Mode** | Reading a channel requires fanning out across every active writer's personal PDS. If one member's PDS is down, slow, rate-limiting, or misconfigured, their messages fail to load. For large workspaces, direct browser fan-out (as in stateless Desk) increases latency, connection count, and mobile battery/bandwidth cost. |
| **Already Mitigated Today** | Bounded pagination (`listBoundedRecords`, `listBoundedWriters`), latest-100-first channel reads (`protocol-tests/performance-envelope.test.ts`), and local IndexedDB verified sync (`@flock/client`) in `@flock/web`. |
| **Open Risk** | Stateless browser clients (`apps/desk` and third-party lightweight clients) pay full fan-out cost on every refresh; there is no standard untrusted read-through relay/cache protocol that preserves KEM-MAC/CID verification while avoiding N-PDS browser fan-out. |

---

### R2 — Message Completeness & Silent Omission (Honest Outages vs. Equivocation)

How can a user be sure they are seeing *every* message they should be? This splits into two distinct threats:

#### R2a — Honest Partial Reads (Outage, Timeout, Truncation, Validation Drop)
| Dimension | Details |
|---|---|
| **Failure Mode** | A writer's PDS times out, returns 5xx, truncates at safety byte/record limits, or contains malformed records. If a client silently drops those failures, users assume the timeline is complete and make decisions on missing context. |
| **Already Mitigated Today** | `@flock/reader` returns structured `degradedReasons` on partial reads; Desk renders a visible **"Partial channel read"** warning banner ([`desk-channel-view.tsx`](../apps/desk/src/app/ui/desk-channel-view.tsx)); invites inbox and moderation config fail visible/closed instead of collapsing errors into empty lists ([`desk-client.tsx`](../apps/desk/src/app/ui/desk-client.tsx)). |
| **Open Risk** | `degradedReasons` is currently a flat string list rather than structured per-writer status (which writer DIDs failed, whether cached prior records exist, and one-click per-writer retry). Users know *something* degraded, not *who* is missing. |

#### R2b — Malicious or Buggy Omission & Split-View Equivocation
| Dimension | Details |
|---|---|
| **Failure Mode** | Even with valid record CIDs, RFC 9421 HPKE KEM-MACs, and STAR/oplog `LtHash` proofs: (1) a buggy or dishonest **Group Host** can omit a writer from `listWriters` so clients never poll that writer's PDS; (2) a dishonest **writer PDS** can serve a stale (but validly signed) repo head, withholding recent messages from specific viewers; (3) a Group Host or PDS can show Alice and Bob different views (split-view equivocation). |
| **Already Mitigated Today** | Integrity & anti-tampering on *returned* records via HPKE KEM-MAC, DRISL CID checks, and STAR/oplog `LtHash` (`packages/protocol/src/atproto/space-credential-core.ts`, `verified-sync.test.ts`); strict rule that absence from `listWriters` never implies absence from membership (`features/independent-app-and-launch.feature`). |
| **Open Risk** | Neither `@flock/web` nor Desk currently cross-checks `listWriters` against the active member roster on a schedule, detects missing `parent`/referenced messages by direct fallback fetch, or exchanges signed `(repo, rev/cid)` checkpoints to detect split-view equivocation. |

---

### R3 — Confidentiality & Metadata Leakage (Not End-to-End Encrypted)

| Dimension | Details |
|---|---|
| **Failure Mode** | Users often equate "private channel" with "end-to-end encrypted." ATProto Permissioned Spaces enforces *access control against unauthorized readers*, **not** cryptographic secrecy from infrastructure operators: each user's PDS sees plaintext records written by that user, and the Group Host sees membership rosters, channel directories, moderation reports, and credential-exchange timing/frequency metadata. |
| **Already Mitigated Today** | Unlisted private spaces return `SpaceNotFound` to non-members; private channel rosters are protected by space policy; Desk holds zero IndexedDB protocol caches and erases its local lifecycle journal on sign-out. |
| **Open Risk** | No protocol-level E2EE payload envelope (e.g., MLS-encrypted message records) exists yet for high-sensitivity groups that cannot trust personal PDSes or Group Hosts with plaintext content. |

---

### R4 — Third-Party Client Blast Radius, SSRF & Spoofed Authority

| Dimension | Details |
|---|---|
| **Failure Mode** | Opening the protocol to arbitrary third-party clients means: (1) an over-privileged or compromised client with broad OAuth scopes can read/write/delete across unintended modalities (DMs, tasks, invites, operator RPCs); (2) a browser client that blindly fetches untrusted DID documents, handles, or PDS URLs can be turned into a local-network SSRF/probing vector; (3) a malicious member can write forged membership, role, or join-decision records into their own personal PDS repo hoping a buggy third-party client accepts them. |
| **Already Mitigated Today** | Least-privilege `deskMemberScopes()` ([`scopes.ts`](../packages/protocol/src/scopes.ts)); canonical IPv4/IPv6/CIDR/NAT64/6to4/Teredo/metadata/`.local`/`.internal` SSRF guard in both DID resolution and OAuth fetch ([`did-resolver.ts`](../packages/shell/src/did-resolver.ts), [`session.ts`](../packages/shell/src/session.ts)); strict `repoDid === groupDid` validation (`validateSpaceRecord`) proved by `Ignore spoofed authority records` BDD scenario; strict CSP nonces (`desk-csp.spec.ts`); fail-closed `ensureInvitesSpace()` 4-invariant policy check. |
| **Open Risk** | Third-party developers writing clients outside this monorepo have no standalone published conformance test harness to verify their client enforces SSRF, authority-author checks, fresh pre-write credentials, and `invites/self` policy invariants before shipping. Also, browser DNS rebinding remains an inherent browser platform limit (documented in `.ai/plans/flock-desk-client.md`). |

---

### R5 — Distributed Cross-Host Partial Failures & Lifecycle Races

| Dimension | Details |
|---|---|
| **Failure Mode** | Joining a group, leaving a group, accepting invites, or migrating a Group Host spans both the user's personal PDS and the Group Host. Network drops, tab closes, or multi-device concurrent actions mid-flight can leave inconsistent state (e.g., a failed leave followed by a rejoin that later gets wiped by reconciliation, or a stale incarnation acceptance). |
| **Already Mitigated Today** | Account-scoped crash-resumable `IndexedDbLifecycleStore`, 5-phase `joinGroup`, admission-race `cancelPendingJoin`, preflight + 3-phase `leaveGroup`, same-group pending-leave barrier on direct acceptance/rejoin, strict leave-before-join `reconcileLifecycle`, and cross-tab Web Locks ([`membership.ts`](../packages/shell/src/membership.ts)). |
| **Open Risk** | Every new independent client must re-implement this non-trivial state machine unless the core protocol logic is packaged cleanly and validated by a reusable lifecycle conformance test suite. Additionally, multi-space *admin* workflows (workspace/channel creation) still rely on `@flock/operator`'s durable journal in `@flock/web`; an Operator-free admin client would need equivalent crash-resumable orchestration. |

---

### R6 — Lexicon Drift & Cross-Client Backwards/Forwards Compatibility

| Dimension | Details |
|---|---|
| **Failure Mode** | Once multiple independent clients exist on different release cadences, schema or behavioral drift can silently corrupt or break interoperability: (1) a client removes, renames, or retypes a field on a published NSID; (2) an older client performs a read-modify-write (`putRecord`) and strips new optional fields written by a newer client; (3) clients diverge on moderation `reasonTypes`, `join-status` states, or `invites/self` policy invariants; (4) copied protocol logic (such as `ensureInvitesSpace`) silently diverges across packages or repos over time. |
| **Already Mitigated Today** | DNS/authority Lexicon verification (`pnpm verify:lexicons`), canonical NSID registry enforcement (`packages/protocol/src/registry.test.ts`), field-preserving message edits (`{ ...prior.value, text }` in [`channel.ts`](../packages/shell/src/channel.ts#L159)), fail-closed `unsupported_status` passive parking for unknown `join-status` states, open `knownValues` + `labeler/self` discovery for moderation reports, and dual-client E2E parity (`desk-parity.spec.ts`, `features/flock-desk.feature`). |
| **Open Risk** | (1) No automated CI **breaking-change Lexicon diff gate** prevents accidental non-additive edits to published JSON schemas before merge; (2) no **N-1 / N+1 compatibility matrix** tests older client builds against newer records containing unknown optional fields across all collections; (3) `ensureInvitesSpace` policy invariant logic is currently duplicated between `@flock/client` and `@flock/shell` rather than owned by a single pure validator in `@flock/protocol`. |

---

### R7 — Ecosystem & Upstream Protocol Dependencies

| Dimension | Details |
|---|---|
| **Failure Mode** | Flock currently pins an alpha ATProto Spaces checkout (`f839c47e` + `strict-credential-expiry.patch`) and OpenSocial Groups proposal (`8df0cc82`). Upstream breaking changes in `@atproto/space`, PDS endpoints, or `group.opensocial.*` before stabilization could break deployed independent clients; conversely, public PDSes must adopt Permissioned Spaces before general users can connect without custom PDSes. |
| **Already Mitigated Today** | Cryptographic pin verification (`verify-pinned-checkout.mjs`), tracked upstream protocol requests (`.ai/upstream/U1`–`U12`), and strict separation of `group.opensocial.*` vs `new.flock.*` lexicons. |
| **Open Risk** | Production launch requires public DNS `_lexicon.*` publication, upstream landing of `strict-credential-expiry.patch` (and U1–U12 items), and a formal Lexicon versioning/deprecation policy before third-party clients ship to end users. |

---

## 3. Summary Matrix: Current Coverage vs. Open Gaps

| Risk ID | Risk Area | Current Status | Primary Remaining Gap |
|---|---|---|---|
| **R1** | N-PDS availability & fan-out latency | Partially mitigated | No verifiable untrusted read-through relay/cache for stateless clients |
| **R2a** | Honest partial-read visibility | Mitigated (basic banner) | Needs structured per-writer failure status & targeted retry UX |
| **R2b** | Silent omission & equivocation | Integrity verified; omission open | Missing causal-reference fallback fetch, roster audit, & witness heads |
| **R3** | Confidentiality vs. PDS / Group Host | Access control only (not E2EE) | No optional E2EE (MLS) overlay lexicon for sensitive workspaces |
| **R4** | Rogue clients, SSRF, spoofed authority | Strongly mitigated in-repo | No standalone published conformance kit for external client authors |
| **R5** | Cross-host lifecycle partial failures | Mitigated in `@flock/client` & `@flock/shell` | Logic duplicated; Operator-free admin orchestration not yet standardized |
| **R6** | Lexicon drift & N-1/N+1 compatibility | Guarded manually + Desk parity | No CI schema-compat diff gate, no N-1/N+1 test matrix, duplicated invite validator |
| **R7** | Upstream Spaces & DNS publication | Pinned & verified locally | Public DNS lexicon publishing + upstream patch stabilization pending |

See [`.ai/plans/decentralization-risk-mitigations.md`](../.ai/plans/decentralization-risk-mitigations.md) for the concrete phased engineering proposal addressing **R1–R7**.
