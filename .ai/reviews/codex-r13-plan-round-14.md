Rev 14 is not ready to execute. I found **0 Blocker, 5 High, 7 Medium, and 1 Low** remaining defect classes.

All requested pins matched:

- OpenSocial proposal: `8df0cc82eb7708f090aa43522adf1d3ada3ed7e7`
- Spaces: `6747610566eee1b6d743617bd8eb1136adccb362`
- Target: `5ae1b7ca2522ab20b35b89ed2e471fc9b79f4575`
- Reviewed plan SHA-256: `de02777838caeb3e5286bb99091767842c3215c7053924a250f027832a913f6f`

The Spaces checkout has the two disclosed credential source modifications; the target plan and Round 13 review are untracked. No files were modified and no builds or tests were run.

## Round 13 findings

| # | Finding | Rev 14 result | Highest residual |
|---|---|---|---|
| 1 | Standard migration interoperability | Partial | High |
| 2 | Manifest transported in JWT header | Partial | High |
| 3 | Abort/cross-operation binding | Partial | High |
| 4 | App revocation and rejoin protection | Partial; internally contradictory | High |
| 5 | `membership/<groupDid>` LastAdmin bypass | Resolved | — |
| 6 | `requestJoin` decision table and quota | Partial | Medium |
| 7 | Inbound credential parity | Partial; wrong runtime artifact | Medium |
| 8 | Bulk/import resource envelopes | Partial | Medium |
| 9 | Legacy third-party incarnation identity | Explicitly deferred | Low |

## High

1. **Standard migration still depends on proprietary error behavior.**  
   The upstream proposal requires ordinary AT Protocol account migration, while `createAccount` defines no Flock negotiation extension ([proposal:161](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/proposal.md:161), [createAccount.json:8](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/lexicons/com/atproto/server/createAccount.json:8)). Rev 14 treats an exact `404` from `/group-admin/migration-info` as the standard-mode signal ([plan:130](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:130), [plan:353](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:353)). A compliant non-Flock host may return 401, 405, 501, or another response. Coordinated mode must require affirmative, valid v1 negotiation; absence of that affirmation must preserve standard migration.

2. **Migration-manifest size is not safely preflighted.**  
   The JWT is now scalar, but its `operationId` and endpoint fields remain unbounded relative to the asserted header limit. More importantly, the source checks individual blob sizes but has no blob-count or complete serialized-manifest bound, while the target applies a 4 MiB manifest cap ([plan:131](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:131), [plan:173](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:173)). A valid large group can therefore be frozen before discovering that transfer is impossible.

3. **Abort is not fully bound or crash-idempotent.**  
   `migration_session` lacks `ticket_jti`, and abort does not require the submitted operation/ticket identity to match the live session ([plan:143](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:143), [plan:182](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:182)). A stale group-signed request could affect later staging. The target’s purge is also not specified as idempotently successful after staging has already disappeared, leaving a crash window before the source advances the PLC head and clears its lease. The two-hour expiries are separately computed, not a shared absolute deadline.

4. **The app-subject invariant makes legitimate lifecycle states impossible.**  
   Installation creates an active install and durable `known_app_subject`; uninstall removes membership but intentionally retains that ledger ([plan:112](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:112), [plan:113](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:113)). Yet the proposed invariant requires every known subject to have both an active install and an exact-role membership on every write ([plan:114](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:114)). It therefore rejects uninstall and migration of valid inactive tombstones. The invariant should be conditional: if membership exists for a known app subject, an active install and exact role must exist; `requestJoin` should continue rejecting known app subjects unconditionally.

5. **The manifest retrieval route does not identify a migration.**  
   `/group-admin/migration-manifest` has no group or operation selector, while its service authentication identifies only the target service DID ([plan:130](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:130)). Concurrent migrations from one source to the same target are ambiguous. The request must bind `groupDid`, `operationId`, ticket identity, and expected digest.

## Medium

1. Future `joinPolicy` values have no fail-closed terminal branch. This matters because the lexicon uses `knownValues`, which the pinned runtime deliberately does not validate ([profile.json:33](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/lexicons/group/opensocial/profile.json:33), [lex-def-builder.ts:849](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/lex/lex-builder/src/lex-def-builder.ts:849)).

2. Several `requestJoin` branches omit the required request hash/final response or leave a pending response after admission, so replay semantics are incomplete ([plan:249](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:249)).

3. Quota eviction may delete unexpired terminal idempotency keys, allowing previously consumed invitations or final denials to be re-executed.

4. Strict zero-skew credential rejection is not wired into the executable dependency. The plan depends on the registry package, whose installed `verifySpaceToken` retains clock skew ([installed credential.js:164](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/node_modules/.pnpm/@atproto+space@0.0.0-spaces-alpha-20261117141222/node_modules/@atproto/space/dist/credential.js:164)); the stricter implementation exists only in the separate Spaces checkout ([pinned credential.js:164](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/space/dist/credential.js:164)).

5. Bulk writes have count/byte caps but omit the pinned weighted create/update/delete rate charging of 3/2/1 ([space applyWrites.ts:22](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/api/com/atproto/space/applyWrites.ts:22)).

6. Negotiation advertises a general 100 MiB import envelope, but `importSpaceMeta` is silently constrained to 1 MiB. Valid OpenSocial policies can exceed that, so a migration can pass negotiation and fail after freeze ([plan:151](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:151), [policy.json:20](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/lexicons/group/opensocial/policy.json:20)).

7. `root_manifest_json` lacks a versioned schema and canonical serialization/ordering algorithm, despite requiring digest and exact-equality checks across independent hosts.

## Low

Third-party memberships without `new.flock.incarnation` receive only a target-local UUID. Rev 14 guarantees same-host retry stability but still does not provide cross-host incarnation continuity ([plan:234](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:234)).

VERDICT: REVISE