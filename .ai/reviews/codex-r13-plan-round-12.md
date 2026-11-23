Rev 12 is not ready to execute: **0 Blocker, 7 High, 1 Medium, 2 Low**.

The requested revisions match:

- OpenSocial proposal: `8df0cc82eb7708f090aa43522adf1d3ada3ed7e7`
- Spaces: `6747610566eee1b6d743617bd8eb1136adccb362`
- Target: `5ae1b7ca2522ab20b35b89ed2e471fc9b79f4575`
- Rev 12 SHA-256: `cfc7cd1f2c21735506af47e4cea33680fda40fb66722202881bc8eb8e0a18e57`
- Round 11 SHA-256: `33d7d2e7373e93fe317e5262b2788fcb01cc5097e5cf7a5a125580f7dea55c78`

This was a static, read-only review. No files were modified and no tests were run.

## Round 11 verification

| Round 11 finding | Rev 12 disposition |
|---|---|
| H1 Migration target/operation binding and crash safety | **Partial** — High 1–3 remain |
| H2 Author-scoped invite redemption | **Resolved** by canonical URI validation and four-key lookup ([plan](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:251)) |
| H3 Exhaustive/atomic `requestJoin` | **Resolved** by the serialized decision table and transactional approval ([plan](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:245)) |
| M1 Acceptance deletion without CAS | **Partial** — Medium 1 remains |
| M2 Durable-membership-first join status | **Resolved** ([plan](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:162)) |
| M3 `access_jti` versus `refresh_jti` | **Resolved** ([plan](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:138)) |
| M4 PKCE applied to refresh/revoke | **Resolved**; PKCE is now authorization-code-only ([plan](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:209)) |
| M5 `createReport` schema | **Resolved** ([plan](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:264)) |
| M6 `getSpaceNotifyTarget` contract | **Resolved** ([plan](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:306)) |
| M7 Missing 39 existing Spaces lexicons | **Resolved** by the 99-file manifest ([plan](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:78)) |
| M8 DM conformance not mandatory | **Resolved narrowly**; a broader mandatory-suite contradiction remains as High 6 |
| L1 Lifecycle occurrence identity | **Partial** — Low 1 remains |
| L2 Incomplete documentation sweep | **Partial** — Low 2 remains |

## High

1. **Target migration state is still not bound to the prepared operation or source manifest.**  
   The source lease stores `operation_id` and `root_manifest_json`, but the target session stores neither; the service JWT carries only `iss/aud/lxm`, and activation checks staged self-consistency rather than equality with the prepared source roots ([lease](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:131), [target session](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:138), [activation](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:139)). An expired operation’s token/staging can cross into a later same-target attempt, and an internally valid but incomplete import can cut over. Bind a source-signed `{operationId, target, manifestDigest}` to the target session and require exact manifest equality before PLC submission and activation.

2. **A signed PLC operation survives abort or lifecycle transitions.**  
   `signPlcOperation` returns and persists a signed operation, but source abort is allowed while PLC still points at the source; `deactivateAccount` and sole-member leave also delete the lease ([signing](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:143), [abort](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:131), [deactivation](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:140)). Because signing and submission are separate operations in the pin ([sign handler](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/api/com/atproto/identity/signPlcOperation.ts:53), [submit handler](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/api/com/atproto/identity/submitPlcOperation.ts:56)), a retained signed operation can later cut over to purged or incomplete staging. Once `plc_signed`, forbid lease release until cutover or first invalidate the signed operation by advancing the PLC head safely.

3. **A crash after target activation leaves the source readable with refreshable OAuth sessions.**  
   Preparation freezes writes and revokes space credentials, but does not advance `auth_epoch` or revoke OAuth sessions. Source private read/query routes remain available until the final client-driven `deactivateAccount` ([prepare](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:131), [session validation](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:205), [final deactivation](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:140)). A crash between activation and deactivation exposes stale private membership/moderation data indefinitely at the old endpoint. Add an authenticated target-to-source finalizer or PLC-observing automatic source shutdown, with a crash failpoint test.

4. **`deactivateAccount` has an authorization-revocation TOCTOU.**  
   Rev 12 performs live-narrowed authorization before, but not inside, the destructive transaction ([plan](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:140)). The pinned implementation likewise separates middleware authorization from account mutation ([route](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/api/com/atproto/server/deactivateAccount.ts:9), [mutation](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/account-manager/account-manager.ts:468)). An administrator can pass authorization, be demoted, then deactivate the group. Re-read the effective actor under the group lock inside the same `IMMEDIATE` transaction.

5. **Demoting an operation actor can permanently strand partially applied Operator state.**  
   Every resume must revalidate the original actor ([plan](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:37)), while completed steps are persisted individually and failed replays remain pending ([journal](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/apps/operator/src/operator/journal.ts:103)). Existing recovery leaves such rows pending and blocks later operations ([operations](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/apps/operator/src/operator/operations.ts:64)). Reauthorizing the shared session through another admin does not reauthorize the original actor. Define deterministic compensation or explicit audited takeover, and test demotion after every durable step.

6. **The zero-exclusion suite gate is unsatisfiable as written.**  
   Rev 12 assigns every remaining `protocol-tests/**/*.test.ts` to a root script but adapts only the DM conformance suite for in-place execution ([plan](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:336)). K2 and K5 still depend on their copied-into-pin locations and imports ([K2](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/protocol-tests/atproto/platform-spike-k2-confidential-client.test.ts:5), [K5](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/protocol-tests/atproto/platform-spike-k5-oplog.test.ts:5)); their README confirms that execution model ([README](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/protocol-tests/atproto/README.md:3)). Adapt, archive, or explicitly classify both.

7. **The mandatory numeric performance suites have no mandatory invocation.**  
   Gate 5 explicitly invokes only `test:acceptance`; the three performance scripts are merely named below it ([Gate 5](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:346), [thresholds](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:353)). They are separate package scripts ([package.json](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/package.json:24)). All stated commands can therefore pass without exercising any hard numeric threshold.

## Medium

1. **Acceptance deletion recovery still loses the newer bilateral acceptance after a crash.**  
   If deletion commits, another device rejoins, and the client crashes before post-delete repair, resume sees the newer membership plus missing acceptance and clears the journal without restoring it ([phase 2](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:291)). The pinned PDS commits deletion before notification/response ([handler](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/api/com/atproto/space/deleteRecord.ts:49)). Every resume must reconcile current membership against acceptance before clearing, with an explicit post-delete phase.

## Low

1. **Legacy incarnation remains migration-unstable.** A legacy record without the embedded field receives a fresh target-side UUID on each migration ([plan](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:234)); STAR carries commit and record bytes, not the source sidecar incarnation ([provider](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/space/src/sync/provider.ts:20)).

2. **The documentation sweep still omits `.ai/upstream/**`.** Those live drafts remain linked and still state that the application does not implement `opensocial.group` ([stale text](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/upstream/upstream-protocol-requests.md:62)), but they are absent from Wave 6’s sweep ([plan](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:336)).

VERDICT: REVISE