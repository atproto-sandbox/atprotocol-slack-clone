Rev 4 resolves the scope-syntax, route-inventory, strict delegation-audience, two-phase repo commit, bounded-fetch, deployment-config, invite-status, parity-suite, and citation issues from Round 3. It does not fully resolve pin integrity, OAuth/DPoP, crash recovery, LastAdmin, or reversible deactivation.

## Blocker

None.

## High

1. **The custom OAuth server never defines full DPoP verification.**

   The plan advertises DPoP, stores `dpop_jkt`, and declares a `dpop_jti` table, but never requires proof verification on PAR, token, revoke, or protected-resource requests ([Rev 4:165](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:165), [Rev 4:174](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:174), [Rev 4:176](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:176)). The pinned verifier checks `typ=dpop+jwt`, embedded JWK, freshness, `jti`, exact `htm`, canonical `htu`, optional nonce, and `ath` ([dpop-manager.ts:66](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/oauth/oauth-provider/src/dpop/dpop-manager.ts:66), [dpop-manager.ts:92](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/oauth/oauth-provider/src/dpop/dpop-manager.ts:92), [dpop-manager.ts:111](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/oauth/oauth-provider/src/dpop/dpop-manager.ts:111), [dpop-manager.ts:123](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/oauth/oauth-provider/src/dpop/dpop-manager.ts:123)). It also atomically rejects replay and binds `cnf.jkt` to the proof key ([oauth-verifier.ts:128](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/oauth/oauth-provider/src/oauth-verifier.ts:128), [oauth-verifier.ts:151](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/oauth/oauth-provider/src/oauth-verifier.ts:151)).

   **Fix:** specify a reusable DPoP verifier for every AS/resource route, canonical Group Host URL handling, atomic unique `jti` insertion, PAR→code→token→`cnf.jkt` binding, exact access-token `ath`, and nonce behavior. Add stale-proof, wrong-method/URL/key/`ath`, duplicate-header, and parallel-replay tests.

2. **Live imports can bypass LastAdmin, referential integrity, and anti-escalation.**

   `space.importSpaceMeta` and `space.importRepo` accept ordinary Group-DID OAuth, not just a migration credential ([Rev 4:136](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:136), [Rev 4:138](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:138)). Yet the exhaustive LastAdmin enforcement list only covers individual membership/role writes, policy updates, and `leaveGroup` ([Rev 4:194](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:194), [Rev 4:201](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:201)). Pinned `importRepo` replaces the complete repo after only scope checks ([importRepo.ts:39](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/api/com/atproto/space/importRepo.ts:39), [importRepo.ts:48](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/api/com/atproto/space/importRepo.ts:48)); `importSpaceMeta` similarly replaces policy configuration ([importSpaceMeta.ts:35](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/api/com/atproto/space/importSpaceMeta.ts:35)). A live admin could therefore import a members repo with no effective administrator, dangling role references, or escalated grants.

   **Fix:** make these full-replacement operations available only to an operation-bound migration session while the target is unactivated/deactivated, or stage and validate the complete imported post-state—including LastAdmin, role/policy references, assignability, core-space and index invariants—before atomic replacement. Apply equivalent post-state validation to bulk `clearRecords`.

3. **`LastAdmin` remains bypassable through empty or app-only role lists.**

   The human predicate is `!roles.every(r => r.startsWith("app-"))`, and the guard runs only if at least one such human remains ([Rev 4:200](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:200), [Rev 4:201](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:201)). `[].every(...)` is true, while the upstream schema permits an empty array because it has `maxLength` but no `minLength` ([membership.json:13](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/lexicons/group/opensocial/membership.json:13)). Admission also writes the exact default-role list, which may be empty ([Rev 4:205](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:205)). A final admin can self-strip to `[]` or app-only roles; the guard then sees zero humans and does not reject, but no recovery row is created.

   **Fix:** classify app identities from durable app-installation state rather than role-name inference; require admitted human memberships to have at least one role; and evaluate loss of the final effective human administrator before every membership transition, including empty/app-only role replacement.

4. **`prompt=create` still has two unjournaled crash boundaries.**

   The journal is written as `pending_plc`, PLC is called, and only afterward is it marked `plc_published` ([Rev 4:179](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:179), [Rev 4:180](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:180)). Startup compensation covers only stale `plc_published` rows, so a timeout after PLC accepted genesis but before the status update has no specified reconciliation path ([Rev 4:182](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:182)). More importantly, the local transaction deletes the journal before authorization-code creation or redirect is durably coupled to it ([Rev 4:181](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:181)). Gate 5 still has only pre/post-PLC failpoints ([Rev 4:266](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:266)), despite Round 3 explicitly requiring a before-code-issuance failpoint ([Round 3:40](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/reviews/codex-r13-plan-round-3.md:40)).

   **Fix:** retain a durable operation/request-URI record through `pending_plc`, unknown/external-outcome, local-ready, code-issued, and completed states. Reconcile PLC before retry/tombstone; atomically persist the single-use code or resumable authorization result before clearing the journal; add timeout-after-PLC, local-commit-before-code, code-before-redirect, and concurrent-resumer tests.

5. **The clean immutable pin remains optional, so Round 3’s executable-integrity defect is not resolved.**

   `ATPROTO_IMMUTABLE_PIN=1` is only described as an optional mode ([Rev 4:9](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:9)). Mandatory Gates 1, 5, and 6 set only the checkout path ([Rev 4:260](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:260), [Rev 4:265](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:265), [Rev 4:275](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:275)); none invokes the detached frozen install/build. Consequently local unverified `node_modules` can still affect required gates.

   The aggregate digest is also not independently reproducible from the description at [Rev 4:8](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:8): it omits the inner-digest encoding, path root, sort semantics, and entry framing. Neither the raw nor lowercase-hex natural interpretation over the current 19,163 files produced the published digest.

   **Fix:** make immutable bootstrap mandatory for every pin-consuming gate, propagate the clean checkout path into fixtures, and check in or precisely specify one canonical digest script plus test vectors.

6. **Sole-member deactivation is not end-to-end reversible.**

   Leave deletes the personal-PDS `acceptance/self` before removing membership ([Rev 4:227](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:227)). Deactivation then deletes membership, revokes sessions, emits `#spaceDeleted`, and drops registrations; activation restores only membership ([Rev 4:169](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:169), [Rev 4:202](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:202)). Discovery explicitly skips groups lacking personal acceptance ([Rev 4:230](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:230)), contradicting upstream’s bidirectional membership requirement ([proposal.md:44](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/proposal.md:44)). `#spaceDeleted` is explicitly a deletion signal ([notifySpaceUpdate.json:36](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/lexicons/com/atproto/space/notifySpaceUpdate.json:36)) backed by a persistent tombstone in the pinned implementation ([manager.ts:303](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/space-policy/manager.ts:303)).

   **Fix:** define a nonterminal deactivation protocol, an exact restricted recovery-OAuth session, and a journaled reactivation workflow that recreates acceptance and registrations. Alternatively preserve acceptance/registrations during reversible deactivation. Reserve `#spaceDeleted` and tombstoning for permanent deletion.

## Medium

1. **The client-attestation JWT type is wrong.**

   Rev 4 requires `oauth-client-attestation+jwt` ([Rev 4:188](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:188)); the pinned constant and verifier require `atproto-client-attestation+jwt` ([credential.ts:22](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/space/src/credential.ts:22), [client-attestation-verifier.ts:95](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/client-attestation-verifier.ts:95)). Following the plan literally rejects every valid attestation.

   **Fix:** import `CLIENT_ATTESTATION_TYP` from the pinned package or use the exact literal, and add positive/wrong-type parity tests.

2. **Two OAuth client/session-family bindings remain underspecified.**

   `/oauth/authorize` requires a valid `request_uri`, but does not explicitly require the incoming `client_id` to equal the PAR row’s client ID ([Rev 4:176](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:176)); the pinned manager rejects this mismatch ([request-manager.ts:355](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/oauth/oauth-provider/src/request/request-manager.ts:355)). Code replay also claims family-wide revocation but specifies only `DELETE FROM oauth_session`, despite a separate `oauth_refresh_token` table ([Rev 4:165](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:165), [Rev 4:177](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:177)).

   **Fix:** require exact authorize-time client equality before UI or redirect. Add a durable family revocation marker or explicit transactional cascade covering sessions, refresh tokens, and already-issued access tokens; test parallel replay and subsequent use of every token type.

3. **`joiningGroups` still cannot recover all promised response-loss windows.**

   `requestJoin` is journaled before the call, but creation is journaled only after `groupDid` is returned, and each entry stores only `{mode, createdAt}` ([Rev 4:228](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:228)). A lost creation response leaves no keyed entry; an invite retry lacks the invite URI or request identity. This does not fully satisfy the Round 3 requirement to journal before creation and cover response loss ([Round 3:64](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/reviews/codex-r13-plan-round-3.md:64)).

   **Fix:** persist an operation ID and complete hashed intent before creation/join, store the resolved `groupDid` and invite URI/result afterward, and define idempotent replay plus terminal-error cleanup.

## Low

1. **Renewed registrations can still receive a stale expiry notice.**

   Rev 4 prevents deleting a renewed registration but does not recheck whether the queued notice is still owed before each delivery attempt ([Rev 4:169](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:169)). The pinned worker performs that check ([space-notifications.ts:302](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/space-notifications.ts:302)) and lets deletion supersede pending expiry ([space-notifications.ts:180](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/space-notifications.ts:180)).

   **Fix:** re-evaluate expiry immediately before sending and coalesce pending notices so `#spaceDeleted` supersedes `#registrationExpired`.

2. **OAuth metadata advertises fragment responses, while the redirect contract only specifies query responses.**

   Metadata advertises `response_modes_supported: ["query", "fragment"]` ([Rev 4:174](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:174)), but success/error handling is defined only as `?code`/`?error` redirects ([Rev 4:176](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:176)).

   **Fix:** either remove fragment mode or specify and test fragment-mode `code`, `error`, `state`, and `iss` placement.

Read-only review completed; no files were edited or created.

VERDICT: REVISE