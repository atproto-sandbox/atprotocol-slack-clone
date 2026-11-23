Round 5 result: Rev 5 is not ready. No files were changed.

## Blocker

None.

## High

1. **`LastAdmin` still counts installed apps as administrators.**

   The predicate counts every capability-bearing DID, without excluding DIDs classified as apps ([plan:218–219](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:218)). Durable app classification is defined separately from active `new.flock.app.install` records ([plan:107](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:107), [install schema:7–18](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/packages/protocol/lexicons/new/flock/app/install.json:7)), but is not used by Group Host RBAC. Because `admin` can assign `"*"` ([plan:86–102](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:86)), an installed app can hold `admin` or a custom effective-admin role, allowing the final human administrator to leave while `effectiveAdmins(postState)` remains nonzero. Gate 5 only covers a bot with a non-admin/bot-only role ([plan:294](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:294)).

   **Fix:** derive `effectiveHumanAdmins` transactionally by subtracting subjects of active, group-authored `new.flock.app.install` records. Use it in `LastAdmin`, activation/import validation, and recovery validation. Add tests where an active bot holds both the built-in admin role and a custom capability-equivalent role.

2. **The sole-member leave/reactivation journals cannot recover the failure states they claim to cover.**

   Three contradictions remain:

   - After sole-member leave commits, the group is inactive and sessions are revoked ([plan:221](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:221)). If the response is lost, `leavingGroups` replays `leaveGroup` ([plan:249](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:249)), but that route requires `activated === 1` ([plan:148](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:148)). It therefore cannot reach the promised idempotent outcome.
   - If `activateAccount` never committed, the reactivate resumer groups `"reactivate"` with ordinary admission and replays `requestJoin` ([plan:250–255](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:250)). Both the membership probe and `requestJoin` require an active group, so neither can reactivate it.
   - The journal is deleted before Operator registration refresh and `discover()` ([plan:223](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:223)). A crash in that window loses the remaining work. Moreover, all sessions—including the separate Operator shared session—were revoked, but only the browser recovery session is upgraded.

   **Fix:** give `reactivate` a dedicated phase machine. While inactive, obtain/reuse recovery OAuth and replay `activateAccount`; while active, verify restored membership, restore acceptance, explicitly reauthorize or replace the Operator shared session, restore registrations, run discovery, and only then clear the journal. Permit an inactive, matching recovery DID to obtain an idempotent committed result for a replayed sole-member `leaveGroup`, or reconcile it through recovery-authenticated status. Test lost responses before and after both leave and activation commits, plus crashes between every post-activation phase.

3. **The refresh-token DPoP contract is incompatible with the pinned real OAuth client.**

   Rev 5 correctly says AS proofs have no `ath` ([plan:183](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:183)), but then requires refresh requests to carry `Authorization: DPoP <token>` and compare an access-token `payload.cnf` ([plan:185](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:185)). The pinned client sends the refresh token in the form body ([oauth-server-agent.ts:145–165](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/oauth/oauth-client/src/oauth-server-agent.ts:145)) and its DPoP wrapper only produces `ath` when an Authorization header exists ([fetch-dpop.ts:59–62](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/oauth/oauth-client/src/fetch-dpop.ts:59)). The pinned provider consequently compares the proof to the stored original grant rather than an access-token payload ([oauth-provider.ts:1059–1088](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/oauth/oauth-provider/src/oauth-provider.ts:1059)).

   **Fix:** reserve `Authorization: DPoP <access-token>` plus mandatory `ath`/`payload.cnf` for resource requests. For refresh and revoke, accept the token in the form body, require a DPoP proof without `ath`, and compare `proof.jkt` and client authentication against the stored token/family grant. Add successful real-client refresh/revoke tests, not only replay tests.

## Medium

1. **The PLC construction uses real function names with an invalid call shape, and compensation lacks the required CID derivation.**

   Rev 5 passes custom `verificationMethods` and `services` through `atprotoOp` ([plan:192](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:192)). In pinned `@did-plc/lib@0.0.4`, `atprotoOp` accepts only `signingKey`, `handle`, `pds`, `rotationKeys`, `prev`, and `signer`, and signs immediately ([operations.ts:26–59](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/node_modules/.pnpm/@did-plc+lib@0.0.4_debug@4.4.3_supports-color@8.1.1_/node_modules/@did-plc/lib/src/operations.ts:26)). The pinned Spaces implementation instead calls `formatAtprotoOp`, adds `atproto_kem`, and then calls `signOperation` ([plc.ts:9–21](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/util/plc.ts:9)). Likewise, `tombstoneOp` requires a `CID` ([operations.ts:165–175](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/node_modules/.pnpm/@did-plc+lib@0.0.4_debug@4.4.3_supports-color@8.1.1_/node_modules/@did-plc/lib/src/operations.ts:165)), but the startup path only records `genesis_op_json` and later refers to an unexplained `genesisCid` ([plan:192,200](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:192)).

   **Fix:** pin `@did-plc/lib@0.0.4`; use `formatAtprotoOp` → add `verificationMethods.atproto_kem` → `signOperation` → `didForCreateOp`; derive the compensation CID with `cidForCbor(genesisOp)` before calling `tombstoneOp`.

2. **`policy.allowedApps` is not part of the pinned `group.opensocial.policy` wire schema.**

   Rev 5 promises to enforce it ([plan:206](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:206)), but the upstream policy defines only `publicRead`, `unlisted`, and `grants` ([policy.json:7–28](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/lexicons/group/opensocial/policy.json:7)). `allowedApps` belongs to the older baseline `com.atproto.memberspace.policy` ([memberspace policy:19–25](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/lexicons/com/atproto/memberspace/policy.json:19)).

   **Fix:** remove this check from `group.opensocial.policy`, or define a separate versioned Flock extension/host-private policy field and specify its storage, publication, migration, and client-attestation semantics.

## Low

1. **The DPoP implementation is not actually “matching” the cited pinned implementation.**

   Rev 5 specifies `maxTokenAge: 60`, `clockTolerance: 5`, and rejection of query/fragment-bearing `htu` values ([plan:180–183](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:180)). The pin uses a 10-second maximum age, 180-second clock tolerance, and deliberately normalizes away query and fragment components for legacy compatibility ([dpop-manager.ts:66–76](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/oauth/oauth-provider/src/dpop/dpop-manager.ts:66), [dpop-manager.ts:163–202](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/oauth/oauth-provider/src/dpop/dpop-manager.ts:163)).

   **Fix:** either align the parameters and normalization or label these as deliberate custom policy, with explicit interoperability tests.

2. **The “clean checkout” alternative cannot satisfy the same pin receipt.**

   The verifier permits the status to be clean after checking the two modified-file hashes ([plan:8](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:8)), but clean `HEAD` versions have different hashes and therefore a different full-tree digest than the mandatory value at [plan:11](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:11).

   **Fix:** remove “or is clean,” or publish a second complete clean-tree receipt with its own two file hashes and aggregate digest.

Aside from the findings above, the other Round 4 requirements are genuinely closed: bootstrap grants and five journal states are explicit; code issuance is transactionally coupled to bootstrap; both pre-PLC states are reconciled; required direct dependencies are listed; import routes are inactive-migration-only with activation/clear validation; exact attestation type, authorize-time client equality, response modes, family cascade, expiry/coalescing, new configuration helpers, and corrected citations are present. I also independently reproduced the `a0fbb073…` 19,163-file digest and `8bd005f5…` 118,418-entry digest; all 7,272 observed symlinks resolve inside the pinned checkout.

VERDICT: REVISE