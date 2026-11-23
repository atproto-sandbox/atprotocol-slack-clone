Rev 21 is not implementation-ready. Static tally: **0 Blocker, 3 High, 1 Medium, 1 Low**. Round 20 disposition: **6 resolved, 1 partial, 1 unresolved**.

## Remaining findings

### High

1. **Mandatory Gate 1 depends on a private dirty installation, not the declared Spaces commit.**

   The verifier requires exact uncommitted source hashes, exact dirty status, and a 118,418-entry `node_modules` digest ([plan:5](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:5)), then makes that verifier unconditional ([plan:371](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:371)).

   At commit `6747610`, the Git-object hashes are:

   - `credential.ts`: `3ee86eb9…`, not required `45b91e70…`
   - `credential.test.ts`: `3e2bf642…`, not required `5fd14a9d…`

   The required bytes exist only in this checkout’s two uncommitted modifications. This workstation can satisfy Gate 1, but a clean checkout or CI runner cannot reconstruct it from the declared pins. Commit the overlay as a pinned fork/patch and replace the whole-install digest with reproducible artifact and lockfile verification.

2. **Round 20’s Standard-migration sovereign-key High remains partial.**

   For a non-Flock source without the custom `public-group-keys` endpoint, Rev 21 sets `source_local_rotation_key = NULL` ([plan:139](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:139)), recommends only the target’s local key, and skips preservation checks ([plan:143](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:143)).

   Consequently:

   - A human-governed group can activate after silently dropping every prior sovereign rotation key.
   - A zero-human group reaches PLC cutover and then fails `NoSovereignCustodyKey` during activation ([plan:140](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:140)).
   - Five-key unknown-source groups still have no safe, fail-before-cutover capacity policy.

   Require authenticated source-local provenance or fail closed before staging/cutover when provenance or capacity cannot be established.

3. **Policy-grant scopes are omitted from effective authorization.**

   Upstream defines two scope sources: group-wide `role.scopes` and space-specific matching `policy.grants[].scopes` ([proposal:52](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/proposal.md:52), [policy.json:31](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/lexicons/group/opensocial/policy.json:31)).

   Rev 21 instead specifies role-only scope unions for Operator checks, effective-admin evaluation, and all five authorization boundaries ([plan:37](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:37), [plan:237](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:237), [plan:302](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:302)). Conforming imported groups whose capability exists only in a policy grant will be denied incorrectly.

   Define one canonical union of assigned role scopes plus every matching policy-grant scope and use it for issuance, live narrowing, Operator/effective-admin checks, and role/policy anti-escalation.

### Medium

1. **Demoted-actor recovery lacks an existing-database migration contract.**

   Rev 21 adds persistent state `aborted_actor_revoked` and `taken_over_by` ([plan:37](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:37)). The current Operator table permits only six states and has no takeover column ([db.ts:8](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/apps/operator/src/lib/db.ts:8), [db.ts:152](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/apps/operator/src/lib/db.ts:152)); journal identity is keyed to the original actor ([journal.ts:83](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/apps/operator/src/operator/journal.ts:83)).

   Wave 3 needs an explicit versioned SQLite table rebuild/backfill, separation of journal owner from executing takeover admin, and a pre-R13 database upgrade test.

### Low

1. **Legacy third-party membership incarnation remains host-local.**

   Untouched imported memberships without `new.flock.incarnation` still receive a random same-host identity, so stale-leave protection is not stable across migration ([plan:241](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:241)).

## Round 20 disposition

| Round 20 item | Rev 21 disposition |
|---|---|
| Blocker — creator acceptance bootstrap deadlock | **Resolved.** Operator authorization explicitly excludes acceptance; acceptance is written after membership/bootstrap. |
| High — Standard migration key preservation | **Partial; High remains.** Flock-source provenance is fixed, but unknown non-Flock sources remain unsafe as described above. |
| High — non-Flock zero-human sole-member governance | **Resolved.** Non-Flock and Flock leave paths now branch correctly. |
| High — runtime `include:` expansion | **Resolved.** Vendored permission sets and all five expansion boundaries are specified. |
| Medium — same-DID OAuth callbacks | **Resolved.** Each callback uses an isolated temporary session map. |
| Medium — empty moderation label | **Resolved.** Empty values are rejected on writes and imports. |
| Low — legacy incarnation stability | **Unresolved.** Remains the Low finding above. |
| Low — Group Host/Operator DID comment | **Resolved.** The service identities are now distinguished. |

The inherited Round 19 items recorded in Round 20 remain consistently dispositioned: loopback callback, production lexicon publication, quota retry, and absent cancellation are resolved; migration keys and legacy incarnation are represented above.

All requested HEADs matched exactly. Final frozen hashes were plan `e92faf56…` and Round 20 review `349ca3d5…`. This was a read-only static review: no files were modified and no tests or builds were run.

VERDICT: REVISE