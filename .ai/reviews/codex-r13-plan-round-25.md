Rev 25 is not implementation-ready. Static tally: **0 Blocker, 2 High, 2 Medium, 1 Low**.

## Round 24 disposition

| Round 24 item | Rev 25 disposition |
|---|---|
| High — multi-key Standard migration | **Resolved as an explicit scope limitation.** Rev 25 now states that unattested multi-key non-Flock sources are outside zero-extension v1 interoperability, satisfying Round 24’s alternative remedy ([plan:138](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:138)). |
| High — ordinary PDS accepted as target | **Original safety defect resolved, but replaced by a different High interoperability defect.** Rev 25 now rejects ordinary PDSes before leasing/staging, but also rejects conforming OpenSocial hosts without Flock-specific capability advertisements. |
| Medium — undefined incarnation wildcard | **Not fully resolved.** The wildcard is gone, but the timestamp fallback still accepts future-dated stale acceptance records. |
| Low — replayed migration access-token lifetime | **Resolved.** Replay now uses `min(now + 900s, absoluteDeadline)` ([plan:138](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:138)). |

## High

1. **“Standard” target discovery rejects compliant hosts that lack Flock-specific advertisements.**

   Rev 25 requires either `/group-admin/migration-info` with a signed `capabilityProofJwt` or a `#opensocial_group` DID service in both prepared and unleased Standard migration paths ([plan:131](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:131), [plan:143](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:143)). Upstream requires a target implementing `group.opensocial.policy`, but defines neither advertisement mechanism ([proposal.md:161](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/proposal.md:161)).

   Thus, the ordinary-PDS vulnerability is fixed, but a standards-compliant third-party host without the Flock extension is also rejected. Either preserve a genuine upstream-only Standard path that establishes support during target staging/import, or explicitly scope and name this as Flock-advertised target interoperability. Do not fall back to bare `describeServer`.

2. **The “crash-safe” `prompt=create` journal has no recovery after authorization-code expiry or a lost token response.**

   The `code_issued` transaction durably creates the group, reserves its handle, writes membership, scrubs creation keys, and stores a one-time OAuth code. The next step only replays the redirect before consumption, deletes the journal on redemption, and compensates stale `pending_plc`/`plc_published` states—not `code_issued` ([plan:217-222](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:217)). OAuth-code and creation-journal cleanup are also absent from the pruning contract ([plan:199](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:199)).

   The pinned OAuth implementation gives codes a five-minute lifetime, atomically consumes them, and rejects expired codes ([oauth-constants.ts:38](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/oauth/oauth-provider/src/oauth-constants.ts:38), [request-manager.ts:444](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/oauth/oauth-provider/src/request/request-manager.ts:444)). A replay after token redemption can also revoke the unseen session created before a lost response ([oauth-provider.ts:957](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/oauth/oauth-provider/src/oauth-provider.ts:957)).

   Define bounded code expiry plus fresh-code reissue or explicit existing-group reauthorization, token-response-loss recovery, stale-row cleanup, and failpoint coverage. Indefinitely retaining an active authorization code is not a safe substitute.

## Medium

1. **Round 24’s stale-acceptance defect survives via future-dated legacy records.**

   The fallback accepts an unversioned acceptance when `accMs >= memMs` and asserts that a pre-ejection record necessarily predates `lastEjectedAtMs` ([plan:351](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:351)). Upstream only requires `createdAt` to be a datetime and imposes no future bound ([acceptance.json:9](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/lexicons/group/opensocial/acceptance.json:9)).

   A pre-ejection acceptance dated in the future can therefore satisfy `accMs >= memMs` after re-admission and immediately restore roster display. Require an acceptance tied to the current incarnation or durable post-ejection generation/observation evidence. A simple `createdAt <= now` check is insufficient once that future timestamp arrives.

2. **`createReport` omits the personal-principal guard applied to the other personal methods.**

   Upstream defines reporting as a personal action and includes it in a permission set for sessions “acting as the user rather than the group” ([proposal.md:95-108](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/proposal.md:95), [authParticipate.json:7](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/lexicons/group/opensocial/authParticipate.json:7)). Rev 25 rejects `iss === body.group` for join, cancel, and leave—but not reporting ([plan:160](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:160)).

   Because an admin’s broad group session can mint service auth, this permits group-attributed synthetic reports. Apply the same self-principal rejection to `createReport`, or define a separate group-originated moderation method.

## Low

1. **The exact lexicon arithmetic double-counts an existing file.**

   The target already contains 40 `com.atproto.*` JSON files, including `server/getServiceAuth.json`. The listed 33-file closure includes that file again, so the correct unique arithmetic is **40 existing + 32 additions = 72**, not **39 + 33 = 72** ([plan:54](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:54), [plan:77](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:77)). The final 72/99 totals remain correct; clarify whether the existing file is replaced or counted as overlap.

All requested HEADs matched. The Spaces working diff exactly matched the committed overlay at SHA-256 `3f413baa…32dd`; declared source, lockfile, dist hashes, and the 19,163-file count also matched. Rev 25’s SHA-256 was `e086401d…519e`. No files were modified, and no tests, builds, generators, or writer scripts were run.

VERDICT: REVISE