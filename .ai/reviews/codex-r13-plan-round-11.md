Rev 11 is not ready: **0 Blocker, 3 High, 8 Medium, 2 Low**.

The three repositories match the requested revisions. The plan and Round 10 review are untracked local artifacts; I reviewed SHA-256 `06ba477f…731c2` and `4c44ec74…5aa0a`. The Spaces checkout has unrelated modifications in two credential files; they were excluded from evidence. No files were modified and no tests were run.

## Round 10 finding verification

| Finding | Disposition | Result |
|---|---|---|
| H1 cleanup acknowledgment | Resolved | First-hop HTTP 200 is no longer treated as downstream consumption; tombstone-aware pruning is required ([plan:189](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:189)). |
| H2 atomic migration | Partial | Freeze, notice drain, manifests, and invite-repo reconstruction were added, but cutover is not target-bound or crash-safe. |
| H3 PLC key custody | Resolved | All seven pinned validations and activation-time rotation-key verification are specified ([plan:139](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:139)). |
| H4 authoritative invite redemption | Partial | Canonicalization, expiry, and deletion serialization were added, but the database lookup omits the author/group. |
| M1 resumable join operations | Partial | IDs, aliases, and expiry exist; durable membership and atomic late-approval handling remain defective. |
| M2 refused/stale leave | Partial | Server-first ordering fixes `LastAdmin`, but the claimed acceptance CAS does not exist. |
| M3 abandoned migration sessions | Partial | Abort, deadline, GC, and rotation were added; refresh verification and post-PLC expiry recovery remain incomplete. |
| M4 blob compatibility | Resolved | Normal and migration limits are advertised and preflighted ([plan:129](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:129)). |
| M5 browser OAuth | Resolved originally | Public `none` and confidential `private_key_jwt` are separated; a new PKCE endpoint-scoping defect remains. |
| M6 memberspace hard cut | Resolved narrowly | Rev 11’s explicit DM/protocol/fixture allowlist covers the legitimate survivors ([plan:65](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:65)). |
| M7 protected methods | Resolved | Pinned denylist plus deletion/submission protections are specified ([plan:140](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:140)). |
| L1 recovery claim contradiction | Resolved | Recovery is restricted to `delete_account` ([plan:144](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:144)). |
| L2 legacy incarnation | Partial | A content CID is migration-stable but not lifecycle-occurrence-unique. |

## Blocker

None.

## High

1. **Migration cutover is not bound to the prepared target or operation.** The lease stores `operation_id`, target DID, and endpoint, but `getServiceAuth` and `signPlcOperation` do not require those values to match the issued JWT or proposed PLC operation ([plan:131](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:131), [plan:140](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:140), [plan:143](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:143)). A second administrator can prepare target A and cut over to target B. Lease expiry and expired target staging also lack durable post-PLC states, risking stale-source reopening or an authoritative but unactivatable target.

2. **Invite redemption is not author-scoped.** Although the URI parser verifies `repoDid === groupDid`, the lookup uses only `(space, collection, rkey)` ([plan:248](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:248), [plan:249](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:249)). Space records include an author DID ([aturi.ts:250](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/syntax/src/aturi.ts:250)); another hosted group can therefore satisfy a colliding TID lookup. Query the complete record identity, including `groupDid`.

3. **The `requestJoin` transaction is not an exhaustive or atomic implementation of the upstream contract.** It specifies existing operations, invite redemption, and approval aliases, but never defines open-policy admission, invite-policy `JoinClosed`, or creation of the first approval request ([plan:243](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:243)). Approval also performs `listJoinRequests` and membership creation as separate calls. Upstream requires open admission, valid-invite admission, and otherwise pending/closed behavior ([requestJoin.json:7](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/lexicons/group/opensocial/requestJoin.json:7)). An exhaustive decision table and transactional request consume/write are required.

## Medium

1. `com.atproto.space.deleteRecord` has no `swapRecord`; its pinned schema and handler provide no CAS ([schema:12](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/lexicons/com/atproto/space/deleteRecord.json:12), [handler:31](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/api/com/atproto/space/deleteRecord.ts:31)). The stale acceptance-deletion race therefore remains.

2. Operation-keyed join status terminalizes missing private state without first checking migrated durable membership ([plan:287](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:287)). Upstream explicitly migrates repos but not join state ([proposal:163](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/proposal.md:163)).

3. The migration verifier requires every route’s JTI to equal `access_jti`, while `refreshSession` consumes `refresh_jti` ([plan:138](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:138)). The pinned contract requires `refreshJwt` ([refreshSession.json:7](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/lexicons/com/atproto/server/refreshSession.json:7)).

4. PKCE S256 is worded as mandatory across PAR, token, and revoke ([plan:206](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:206)), but pinned refresh and revocation requests contain no PKCE fields ([oauth-server-agent.ts:92](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/oauth/oauth-client/src/oauth-server-agent.ts:92)). Challenge validation belongs at PAR and verifier validation at authorization-code exchange.

5. `createReport` treats `subject` as a `repoRef`/`strongRef` object, but the proposal defines it as a URI string with a separate optional `cid` property ([plan:257](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:257), [schema:12](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/lexicons/group/opensocial/createReport.json:12)).

6. `getSpaceNotifyTarget` is promised without an implementable schema, authorization/audience rule, allowed-space invariant, replay protection, client route, or dedicated test ([plan:73](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:73)).

7. The pinned manifest covers only the 27 group and 33 newly vendored ATProto files, while codegen also consumes 39 existing upstream-derived space lexicons ([plan:76](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:76)). Drift in those existing copies is not detected.

8. The retained pinned-PDS DM conformance suite is excluded from the suite manifest and from every mandatory gate ([plan:323](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:323)). Its own documentation identifies it as the real memberspace protocol gate ([README:1](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/protocol-tests/atproto/README.md:1)).

## Low

1. `"cid:" + recordCid` identifies record bytes, not a lifecycle occurrence; byte-identical legacy delete/recreate generations can collide ([plan:233](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:233)).

2. Wave 6 updates only four named documents while live architecture and protocol documents still describe governance modules and APIs the hard cut removes ([plan:322](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:322), [ARCHITECTURE.md:5](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/ARCHITECTURE.md:5)).

VERDICT: REVISE