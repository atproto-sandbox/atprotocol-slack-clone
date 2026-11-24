Rev 23 is not implementation-ready. Static tally: **0 Blocker, 2 High, 2 Medium, 0 Low**.

## High

1. **The “Standard” migration path is not interoperable with a standard OpenSocial/ATProto source.**

   Upstream requires migration through the standard account-migration flow ([proposal.md:163](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/proposal.md:163)). The pinned canonical flow uses service authentication and the normal `createAccount` body ([account-migration.test.ts:91](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/tests/account-migration.test.ts:91)).

   Rev 23 instead rejects ticketless migration unless the source implements proprietary `/group-admin/public-group-keys` or the caller supplies `X-Group-Migration-Key-Provenance` signed by an external sovereign key ([plan:138](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:138)). A conforming non-Flock source need implement neither extension, and a valid group may not possess an external sovereign key. The proposed custom-header test therefore does not establish standard interoperability.

   Resolve the conflict between source-local-key identification and standard migration without silently weakening key custody. Either define and negotiate an upstream-compatible extension or provide a safe path using standard inputs and stop describing extension-only migration as Standard.

2. **Standard-mode `createAccount` still has no value for `absolute_deadline_at`.**

   Coordinated mode receives `deadlineAtMs` from its manifest ([plan:130](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:130)). The ticketless Standard branch obtains no deadline, but the staging transaction inserts `absolute_deadline_at` and derives the refresh-token expiry from it ([plan:138](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:138)). Imports then require that undefined deadline to remain live ([plan:151](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/.git), [plan:152](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:152)). The standard schema contains no deadline input ([createAccount.json:8](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/lexicons/com/atproto/server/createAccount.json:8)).

   Define a branch-local Standard deadline—or an explicit nullable/unbounded policy—before staging, and use that same value consistently for session persistence, refresh expiry, replay, imports, and expiry coverage.

## Medium

1. **The pinned OAuth-scopes type rejects the required `collection: "*"` call.**

   Rev 23 pins `@atproto/oauth-scopes@0.0.0-spaces-alpha-20261117141222` and requires strict typechecking ([plan:123](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:123)). Read-only inspection of snapshot commit `223114799` found `SpacePermissionMatchOperation.collection: NsidString`; therefore `{ collection: "*" }` in the required import authorization contract is not assignable. Current Spaces source later corrects this to `SpaceCollectionParam` ([space-permission.ts:97](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/oauth/oauth-scopes/src/scopes/space-permission.ts:97)), matching the pinned PDS’s own wildcard use ([importRepo.ts:43](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/api/com/atproto/space/importRepo.ts:43)).

   Pin/build the corrected package, vendor the type correction, or specify an audited compatibility adapter and parity test.

2. **`WorkspaceSummary` does not define acceptance/membership pairing for roster projection.**

   Rev 23 correctly states that acceptance gates roster display rather than authorization ([plan:36](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:36)), but its concrete summary contract names roles, memberships, policies, and app records without consuming acceptance records ([plan:348](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:348)).

   Upstream defines membership bidirectionally and explicitly makes acceptance the roster-display gate ([proposal.md:44](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/proposal.md:44), [proposal.md:195](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/proposal.md:195)); its validator permits stale/unpaired acceptance records ([validate-lexicons.mjs:142](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/scripts/validate-lexicons.mjs:142)). Specify paired-record projection while retaining membership-only authorization, and cover membership-only, acceptance-only, deletion, and stale-incarnation cases.

## Round 22 disposition

| Round 22 item | Rev 23 disposition |
|---|---|
| High — incomplete `createAccount` bootstrap transaction | **Partial; High remains.** Handle reservation, keys, account/repo initialization, JWT output, rollback/replay, expired staging, and A→B→A re-entry are now specified, but Standard-mode deadline derivation is missing. |
| Medium — `recoveryKey === sourceLocalRotationKey` | **Resolved.** Equality is rejected before staging/JTI consumption and the key is excluded from preservation. |
| Low — wrong legacy-incarnation CID API | **Resolved.** Rev 23 uses the already-verified `entry.cid.toString()` ([plan:240](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:240)). |

All requested HEADs matched exactly. The Spaces checkout contained only the declared two-file overlay, and its diff matched the committed patch SHA-256 `3f413baa…32dd`. No files were modified and no tests, builds, generators, or writer scripts were run.

VERDICT: REVISE