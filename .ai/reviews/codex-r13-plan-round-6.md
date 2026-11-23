Rev 6 is not ready. Most Round 5 amendments landed, but several are only partially resolved, and the revision introduces additional lifecycle and authorization defects. This was a static, read-only review; no files were changed or tests run.

### Round 5 resolution audit

| Round 5 area | Status |
|---|---|
| PLC genesis construction and `@did-plc/lib@0.0.4` | Genesis is resolved at [plan:116](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:116) and [plan:197](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:197), but compensation still names the wrong CID export at line 205. |
| Refresh/revoke versus resource DPoP | Resolved at [plan:189](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:189), [plan:190](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:190), with real-client coverage at [plan:302](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:302). |
| Human-effective-admin enforcement | Partially resolved: activation, signing, and `LastAdmin` use the right set, but deletion does not; inactive-app transitions also bypass it. |
| Recovery grounding and four-phase reactivation | Partially resolved: roles and the eight-route allowlist are correct at [plan:228](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:228), but the final phase recursively re-enters itself and leave replay is over-broad. |
| `policy.allowedApps` | Resolved at [plan:211](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:211). |
| `EmptyMemberRoles` ordering | Resolved at [plan:218](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:218) and [plan:225](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:225). |
| DPoP age, tolerance, and HTU normalization | Resolved at [plan:184](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:184); replay-row retention remains unspecified. |
| Pin status “or is clean” | Removed, but the stated exact porcelain receipt is still bytewise wrong. |
| Root suite-manifest glob | Resolved at [plan:290](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:290); the named acceptance/browser scripts remain unwired. |

## Blocker

None.

## High

1. **`deleteAccount` does not require the actor to be an effective human administrator.**

   [Plan line 132](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:132) calls `!activeInstalledAppSubjects.has(actorDid)` a “human effective-admin check.” That only proves the actor is not currently classified as an active app. It does not apply the full capability predicate defined at [line 223](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:223). A custom human role containing only `account:status?action=manage` can therefore request and consume a deletion token and permanently tombstone the group.

   **Fix:** transactionally require `actorDid ∈ effectiveHumanAdmins` both when issuing and consuming the deletion token. For recovery sessions, evaluate the same predicate against the synthetic membership restored from `group_recovery_admin.roles_json`. Add a negative test for a status-manage-only role.

2. **Permanent account deletion is not crash-safe across PLC and local state.**

   [Plan line 132](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:132) atomically consumes the one-use token, but the subsequent PLC submission, notice enqueue, and purge are unjournaled external/local steps. The schema at [line 168](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:168) contains no deletion journal, and [Gate 5](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:304) tests only successful deletion. A timeout after PLC accepts the tombstone leaves a consumed token and live local group; a crash before PLC submission produces the inverse retry problem.

   **Fix:** add a durable deletion state machine such as `requested → tombstone_signed → plc_tombstoned → notices_queued → purged`. Persist the signed tombstone before network I/O, reconcile `/log/last` after ambiguous responses, and retain materialized outbox endpoint/token data until notices become terminal. Test crashes and lost responses at every boundary.

3. **Changing an installed app to inactive defeats `LastAdmin`.**

   Apps are excluded only while `install.active === true` at [lines 107](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:107) and [224](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:224). An `active:true → false` write that leaves the app’s admin-capable membership in place increases the computed “human” count, so the pre/post-zero guard at [line 225](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:225) permits the final real human to leave. Direct app-install writes are expressly supported at [line 142](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:142). The current uninstall choreography already persists `active:false` before access cleanup at [app-access.ts:87](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/apps/operator/src/operator/kinds/app-access.ts:87).

   **Fix:** remove/strip the app membership and roles first, then persist `active:false` last. Reject direct deactivation/deletion of an install while that subject retains membership, or keep it classified as an app through a durable cleanup-pending state. Add direct-write, crash-after-each-step, and concurrent-final-human-leave tests.

4. **The final reactivation phase recursively invokes itself.**

   `refreshing_discovery` calls public `WorkspaceClient.discover()` at [line 233](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:233), while [line 266](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:266) requires every `discover()` call to resume `reactivatingGroups` first. The current journal entry still exists, so it re-enters `refreshing_discovery` indefinitely.

   **Fix:** split out a non-resuming `discoverCore()` or explicitly skip the current operation during nested discovery. Test re-entry, crashes, and lost responses in every phase—not only around `activateAccount`.

## Medium

1. **Ordinary deactivation leaves old OAuth sessions able to reactivate the group.**

   [Plan line 131](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:131) only flips `activated`, while [line 130](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:130) accepts Group-DID OAuth on `activateAccount`. Unlike sole-member leave, which revokes sessions at line 227, a pre-deactivation token remains usable. The pinned PDS explicitly deletes OAuth credentials during deactivation at [deactivateAccount.ts:40](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/api/com/atproto/server/deactivateAccount.ts:40) and [account-manager.ts:468](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/account-manager/account-manager.ts:468).

   **Fix:** revoke all session families and refresh tokens, and invalidate existing access JWTs during deactivation. Reactivation must require a newly authenticated recovery/group session or operation-bound migration credential. Add stale-token activation and refresh tests.

2. **The leave journal treats ambiguous deactivation as terminal and lacks a reactivation generation.**

   The route grants inactive idempotent success only to the matching recovery DID at [line 149](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:149), but [line 259](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:259) treats any `RepoDeactivated` as completed. A generic administrative deactivation leaves membership intact, so clearing the journal creates a membership/acceptance split. Separately, a stale journal on device A can replay after device B reactivates because leaves run first at [line 266](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:266), deactivating the group again.

   **Fix:** clear only after the special 200 response or authoritative membership absence; treat permanent `GroupNotFound` separately. Store an operation generation and suppress a leave superseded by newer acceptance/reactivation. Test generic deactivation and two-device replay.

3. **Join-request terminal transitions are incomplete.**

   [Lines 260–264](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:260) replay `requestJoin` whenever membership is absent, including entries already marked `pending_approval`. Thus cancellation or moderator denial is undone on the next restart/discovery. The server side also only explicitly clears `join_request` during invite redemption at [line 237](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:237), although upstream says writing membership approves the request at [proposal.md:226](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/proposal.md:226).

   **Fix:** replay only `status:"started"` entries; make cancel/deny terminal for the original operation; and atomically delete the private request whenever membership approval commits. Add cancel, deny, approval, and restart tests.

4. **PLC compensation names a nonexistent `@atproto/lex-cbor` export.**

   [Plan line 205](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:205) attributes `cidForCbor(lastOp)` to `@atproto/lex-cbor`. That package exports `cidForLex`, not `cidForCbor`, at [lex-cbor/index.ts:42](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/lex/lex-cbor/src/index.ts:42). The value-taking compatibility helper is exported by `@atproto/common` at [ipld.ts:54](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/common/src/ipld.ts:54).

   **Fix:** use `cidForLex(lastOp)` from `@atproto/lex-cbor`, or `cidForCbor(lastOp)` from `@atproto/common`, and pass the resulting CID to `tombstoneOp`.

5. **The mandatory acceptance and browser suites are not wired into their named gates.**

   Wave 6 only specifies changing the root `test` glob at [plan:290](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:290). Current [package.json:22](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/package.json:22) still runs the planned-deleted `reconcile-workspaces.test.ts` and omits `opensocial-groups.test.ts`; [package.json:23](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/package.json:23) omits the new browser spec. Consequently Gates 5 and 6 at [plan:301](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:301) and [plan:311](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:311) fail or skip their principal suites.

   **Fix:** explicitly replace the deleted test in `test:acceptance` and add the new browser spec to `test:browser`; have the manifest test verify both lists.

6. **DPoP replay retention and pruning remain unspecified.**

   [Lines 168](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:168) and [185](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:185) provide `expires_at` but define neither its value nor cleanup/indexing. The pin retains proofs for `1.1 × DPOP_NONCE_MAX_AGE` at [replay-manager.ts:36](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/oauth/oauth-provider/src/replay/replay-manager.ts:36), with a three-minute base at [oauth-constants.ts:74](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/oauth/oauth-provider/src/oauth-constants.ts:74): 198 seconds. Shorter retention can reopen replay; no pruning grows SQLite indefinitely.

   **Fix:** specify a pin-matching 198-second minimum retention from first use, add an expiry index and bounded pruning transaction, and test replay at the expiry boundary.

## Low

1. **The app service-principal exception to bidirectional membership is undocumented.**

   Upstream defines membership as bidirectional at [proposal.md:44](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/proposal.md:44), with member-authored acceptance gating roster visibility at [proposal.md:195](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/proposal.md:195). Installed bots receive memberships/roles, but [appGrantScopes at plan:254](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:254) grants no acceptance CRUD and defines no bot acceptance lifecycle.

   **Fix:** either add idempotent app acceptance creation/deletion or explicitly specify and test apps as non-roster service principals outside the normal OpenSocial membership contract.

2. **The “exact” pin status receipt is not the checkout’s raw porcelain output.**

   [Plan line 8](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:8) states `M credential.ts` followed by `M credential.test.ts`. The actual raw output is ` M credential.test.ts` followed by ` M credential.ts`: it includes the porcelain XY leading space and the opposite path order.

   **Fix:** either publish those exact bytes or specify parsing, per-line normalization, and sorting before comparison.

VERDICT: REVISE