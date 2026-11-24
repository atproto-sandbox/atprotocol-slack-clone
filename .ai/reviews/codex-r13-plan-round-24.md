Rev 24 is not implementation-ready. Static tally: **0 Blocker, 2 High, 1 Medium, 1 Low**.

## High

1. **Standard migration still excludes conforming multi-key sources.**

   Rev 24’s zero-extension path supports only a single PLC rotation key. A source with two or more keys and no proprietary `/group-admin/public-group-keys` endpoint is rejected with `400 ProvenanceRequired`; the alternative `X-Group-Migration-Key-Provenance` is also proprietary ([plan:138](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:138), [test gate:379](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:379)).

   Upstream requires the standard account-migration flow, while the pinned `createAccount` contract has no host-key-provenance extension ([proposal.md:163](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/proposal.md:163), [createAccount.json:8](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/lexicons/com/atproto/server/createAccount.json:8)). Therefore a valid multi-key non-Flock group cannot migrate.

   Define an upstream-compatible provenance mechanism without weakening custody, or explicitly stop claiming complete Standard interoperability.

2. **The Standard target “capability probe” accepts ordinary PDSes as group hosts.**

   On failure of the proprietary migration-info endpoint, Rev 24 reads only `describeServer.did` and `blobUploadLimit`, then selects Standard mode ([plan:131](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:131)). `describeServer` exposes no OpenSocial policy capability ([describeServer.json:7](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/lexicons/com/atproto/server/describeServer.json:7)).

   Upstream says `group.opensocial.policy` is not expected to work on ordinary PDSes and that migration may target only a host implementing it ([proposal.md:9](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/proposal.md:9), [proposal.md:163](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/proposal.md:163)). The current preflight can freeze or transfer a group toward an incapable host.

   Require a verifiable policy-capability negotiation, bound to the target endpoint/service DID, before creating the source lease or staging anything.

## Medium

1. **Undefined incarnation acts as a stale-acceptance wildcard.**

   The roster predicate accepts a pair whenever either incarnation is absent, yet immediately claims stale incarnations are excluded ([plan:351](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:351)). Upstream acceptance records contain only `createdAt`, and stale/unpaired acceptance is permitted ([acceptance.json:9](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/lexicons/group/opensocial/acceptance.json:9), [validate-lexicons.mjs:142](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/scripts/validate-lexicons.mjs:142)).

   After eject/re-add, an old unversioned acceptance can therefore display the member immediately. Define a non-wildcard fallback for upstream-only records and test old unversioned acceptance against a fresh membership generation.

## Low

1. **Lost-response replay lengthens the access-token lifetime.**

   Initial staging issues a 15-minute access token, but replay signs both access and refresh tokens through the two-hour absolute deadline ([plan:138](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:138)). This is not a pinned-schema violation, but it is an internal least-privilege inconsistency. Use `min(now + 900s, absoluteDeadline)` for replayed access tokens.

## Round 23 disposition

| Round 23 item | Rev 24 disposition |
|---|---|
| High — Standard migration interoperability | **Partial; High remains.** One-key fallback added, multi-key standard sources still require extensions. |
| High — missing Standard deadline | **Resolved.** Standard branches now set `absoluteDeadlineAt = nowMs + 2 * HOUR`. |
| Medium — OAuth wildcard type mismatch | **Resolved.** The plan specifies the one-line patched dependency and parity coverage ([plan:123](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:123)). |
| Medium — missing acceptance pairing | **Partial; Medium remains.** Records are now paired, but undefined incarnation defeats freshness. |

The independent reviewer and fresh critic agreed on the counted findings. Caller-side authentication wording for the custom migration routes was treated as an unconfirmed clarification concern—not promoted to a defect because the receiver contracts can govern those calls.

All requested HEADs matched. Plan SHA-256 was `d15dcfa…bb45`; the Spaces overlay diff exactly matched `strict-credential-expiry.patch` at `3f413baa…32dd`. No files were modified and no tests, builds, generators, or writer scripts were run.

VERDICT: REVISE