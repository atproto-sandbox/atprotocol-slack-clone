Rev 19 is not implementation-ready. Final static tally: **1 Blocker, 2 High, 1 Medium, 2 Low**. Round 18 disposition: **14 resolved, 1 partial, 1 unresolved**.

## Findings

### Blocker

1. **The mandatory loopback OAuth callback is rejected by the pinned OAuth stack.**

   Rev 19 constructs the loopback client with `${groupHostPublicUrl}/oauth/upstream-callback` while defaulting `groupHostPublicUrl` to `http://localhost:3004` ([plan:210](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:210), [plan:293](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:293)). The pinned validator explicitly rejects `localhost` redirect hosts ([oauth-redirect-uri.ts:25](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/oauth/oauth-types/src/oauth-redirect-uri.ts:25)), and the loopback client-ID parser applies that validator to the embedded `redirect_uri` ([oauth-client-id-loopback.ts:139](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/oauth/oauth-types/src/oauth-client-id-loopback.ts:139)).

   Therefore the required real OAuth acceptance flow at [plan:373](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:373) cannot begin. Use a callback origin containing `127.0.0.1` or `[::1]`; the loopback client-ID origin itself may remain `http://localhost`.

### High

1. **Round 18 H1 remains partially unresolved: migration cannot reliably distinguish sovereign keys from the old host’s local key.**

   The target is told to return `[localRotationKey, ...externalSovereignRotationKeysFromLivePlc]` ([plan:143](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:143)), but the live PLC list contains opaque key strings with no source-host/sovereign marker. Neither the coordinated manifest/attestation ([plan:131](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:131)) nor `migration_session` ([plan:184](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:184)) communicates the source-local key.

   This conflicts with the source requirement to exclude its local key while retaining every sovereign key ([plan:144](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:144)):

   - Preserving every live key causes coordinated signing to reject the source-local key.
   - Guessing which key to remove can discard sovereign custody.
   - Standard migration can retain the old host’s authority indefinitely.

   Additionally, zero-human activation is allowed without proving that any supported external key survives, while `controller-session` rejects the target-local key ([plan:140](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:140), [plan:145](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:145)). Losing the migration session can therefore leave a zero-human group unrecoverable.

   The migration contract needs authenticated source-local-key provenance and either a required supported sovereign key or a defined target-local recovery mechanism.

2. **Spelled-out scopes do not remove the production lexicon-publication dependency.**

   Rev 19 treats granular `space:group.opensocial.*` scopes as the production mitigation for unavailable `include:` expansion ([plan:12](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:12), [plan:295](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:295)). However, the pinned PDS invokes `getSpacesFromScope()` during every authorization ([oauth-provider.ts:789](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/oauth/oauth-provider/src/oauth-provider.ts:789)), which extracts and resolves every non-wildcard space NSID even when collections are spelled out ([lexicon-manager.ts:179](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/oauth/oauth-provider/src/lexicon/lexicon-manager.ts:179)).

   Local gates seed `TestNetworkNoAppView`, while the upstream repository describes these as draft schemas ([upstream README:27](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/README.md:27)). The plan needs a DNS-publication prerequisite or another deployable resolver, plus a real public-PDS authorization gate.

### Medium

1. **`JoinOperationQuotaExceeded` leaves a durable client journal in an automatic retry loop.**

   The server returns `429 JoinOperationQuotaExceeded` for the 201st unexpired operation ([plan:256](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:256)). The client persists `"submitting"` before network I/O, but its terminal error handling omits that response ([plan:319](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:319), [plan:320](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:320)). It will retry on every resume/discovery cycle, potentially until the 30-day server rows expire.

   Add an explicit passive/quota-wait disposition with user recovery or a bounded retry time, and gate its restart behavior.

### Low

1. **Legacy third-party incarnation remains host-local.** Records without `"new.flock.incarnation"` receive a new host-local value, so stale-leave identity is not stable across migration ([plan:241](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:241)).

2. **Absent `cancelJoinRequest` behavior remains unspecified.** Rev 19 unconditionally describes deletion ([plan:274](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:274)), while the canonical lexicon declares `JoinRequestNotFound` ([cancelJoinRequest.json:21](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/lexicons/group/opensocial/cancelJoinRequest.json:21)). Specify whether absent/expired cancellation is idempotent success or returns that error, and parity-test it.

## Round 18 disposition

| Round 18 item | Rev 19 disposition |
|---|---|
| B1 — pre-DID `aud=self` | **Resolved** by finite `aud=*` scopes and post-creation concrete audience ([plan:299](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:299)). |
| H1 — sovereign migration custody | **Partial; High remains**, as described above ([plan:143](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:143)). |
| H2 — non-Flock arbitrary governance | **Resolved**; human-admin rules are Flock-workspace scoped ([plan:140](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:140)). |
| H3 — downstream consent | **Resolved** with approve/deny and persisted narrowing ([plan:212](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:212)). |
| H4 — mandatory idempotency header | **Resolved**; headerless canonical clients are supported ([plan:254](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:254)). |
| H5 — label rkey/placement | **Resolved** at write and import time ([plan:79](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:79)). |
| H6 — backup/restore ownership | **Resolved** with Group Host backup and restore drill ([plan:361](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:361)). |
| M1 — outage-safe replay | **Resolved**; lease replay precedes target probing ([plan:132](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:132)). |
| M2 — report writer authority | **Resolved** with exact `space_writer` validation ([plan:279](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:279)). |
| M3 — pagination | **Resolved** with complete ordering, cursors, and tie-breakers ([plan:281](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:281)). |
| M4 — unknown join status | **Resolved** via durable `unsupported_status` ([plan:320](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:320)). |
| M5 — typed custom errors | **Resolved for the cited issue** by distinguishing schema-declared and generic XRPC errors ([plan:320](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:320)). |
| M6 — empty membership roles | **Resolved** universally ([plan:235](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:235)). |
| M7 — unbounded credential/outbox retention | **Resolved** with indexed bounded pruning ([plan:200](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:200)). |
| L1 — legacy incarnation | **Unresolved; Low remains** ([plan:241](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:241)). |
| L2 — deployed conference deck | **Resolved** by the documentation sweep ([plan:361](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:361)). |

Review scope was frozen at plan SHA-256 `476819a31c4700c016cee608a3c2f320939fd3ca9974d994eca5b0306571221c`; all three requested commits matched. This was a read-only static review: no files were modified and no tests or builds were run. The pinned Spaces checkout’s pre-existing `credential.ts` changes were excluded by reading pinned Git objects where relevant. An independent reviewer and fresh critic agreed on the final tally; the critic corrected H1 from “resolved” to “partial.”

VERDICT: REVISE