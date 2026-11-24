Rev 18 is not implementation-ready. Static result: **1 Blocker, 6 High, 7 Medium, and 2 Low**.

All three requested commits match exactly. I reviewed Rev 18 at SHA-256 `33caee46c29ce30931fd33f258754a2992f7b4ae4b8dd112475b64a1e23b0dce`. The Spaces worktree has local credential-file modifications, so pinned evidence was read from Git objects at `6747610`, not the working copies. No files were modified and no tests or builds were run.

## Blocker

1. **The pre-DID `prompt=create` admin scope is invalid.**  
   [Plan:295](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:295) substitutes `self` for the RPC audience before the group DID exists. The pinned parser accepts only `*` or an absolute DID reference for RPC `aud` ([rpc-permission.ts:22](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/oauth/oauth-scopes/src/scopes/rpc-permission.ts:22)), and silently drops unparseable scopes during normalization ([atproto-oauth-scope.ts:64](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/oauth/oauth-scopes/src/atproto-oauth-scope.ts:64)). Therefore the pre-DID PAR and promised scope gate cannot work as written. Creation needs a separate bootstrap authorization, followed by reauthorization using the concrete group service DID.

## High

1. **Coordinated migration removes the sovereign key required by its controller recovery path.**  
   The target attests only `[localRotationKey.did()]` ([plan:131](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:131)); source signing requires exact equality with that list ([plan:144](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:144)); but `controller-session` requires an external rotation key and explicitly rejects the local key ([plan:145](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:145)). Pinned recommended credentials likewise default to the target-local key ([getRecommendedDidCredentials.ts:27](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/api/com/atproto/identity/getRecommendedDidCredentials.ts:27)). Preserve and attest at least one external sovereign key.

2. **Non-Flock arbitrary governance remains rejected.**  
   Coordinated activation imposes a human-admin/nonempty-role invariant even without a Flock workspace ([plan:140](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:140)), and `LastAdmin` applies across every write and leave ([plan:239](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:239)). This blocks zero-human imports and transitions to external governance, despite the group DID’s implicit authority and governance being explicitly arbitrary upstream ([proposal:46](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/proposal.md:46), [proposal:169](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/proposal.md:169)). Scope these invariants to actual Flock workspaces.

3. **The downstream OAuth consent step is missing.**  
   Rev 18 advertises `prompt=consent`, but the upstream callback proceeds directly from personal-PDS authentication and role authorization to issuing the downstream code ([plan:203](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:203), [plan:212](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:212)). OpenSocial requires presenting consent before session issuance ([proposal:73](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/proposal.md:73)), and the pinned provider forces consent for public clients ([request-manager.ts:257](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/oauth/oauth-provider/src/request/request-manager.ts:257)). Add approve/deny interaction and persist the user-approved scope subset.

4. **`requestJoin` breaks the canonical client contract.**  
   Rev 18 requires `Idempotency-Key` on every request ([plan:254](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:254)), but the pinned lexicon requires only body field `group` and says nothing about that header ([requestJoin.json:8](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/lexicons/group/opensocial/requestJoin.json:8)). A conforming generated third-party client will omit it and be rejected. Make it optional while retaining base semantics, or introduce a versioned extension contract.

5. **The label write validator is protocol-invalid and can violate visibility boundaries.**  
   It accepts generic `record-key` rkeys ([plan:79](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:79)), while the pinned record requires `tid` ([record.json:8](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/lexicons/com/atproto/label/record.json:8)). More importantly, no explicit write/import check requires the label to be stored in its subject’s space; that requirement is upstream normative ([proposal:143](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/proposal.md:143)), while Rev 18 only states same-space enforcement in downstream projection ([plan:338](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:338)). Projection cannot repair invalid or wrongly visible stored state.

6. **The authoritative Group Host database has no backup/restore owner.**  
   Rev 18 places encrypted signing, KEM, PLC rotation keys, repositories, and lifecycle state in `group-host.db`, but Wave 6 does not extend backup/restore tooling. The current script backs up only `DATABASE_PATH` ([backup-db.mjs:5](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/scripts/backup-db.mjs:5)). Loss of this database means loss of group authority. The plan needs coordinated DB/key backup ownership and a restore drill.

## Medium

1. **Lost-response replay still depends on the target being reachable.** Rev 18 now stores the encrypted ticket secret, but probes the target before checking and replaying the existing lease ([plan:132](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:132)). A lost response followed by target outage still leaves the source frozen until recovery or expiry.

2. **`createReport` accepts membership as a substitute for space-writer authority.** The fallback at [plan:279](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:279) permits a non-writer member to fabricate a record URI. Upstream says only roles with `write` enter a space’s writer set ([proposal:57](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/proposal.md:57)).

3. **Pagination is not implementation-complete.** Rev 18 gives broad ordering at [plan:281](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:281), but not cursor encoding, deterministic tie-breakers, terminal behavior, or complete output mapping for the three paginated methods. This permits Group Host/FakeNetwork divergence and duplicate or skipped rows.

4. **An unknown forward-compatible join status destroys recovery state.** The lexicon uses open `knownValues`, but Rev 18 deletes the durable journal before throwing ([plan:316](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:316)). Preserve the raw status and operation ID in an `unsupported_status` state.

5. **The claimed typed custom join errors cannot be generated.** Upstream declares only `GroupNotFound`, `InvalidInvite`, and `JoinClosed` ([requestJoin.json:54](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/lexicons/group/opensocial/requestJoin.json:54)), while Rev 18 expects several additional errors to be typed at [plan:316](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:316). They can travel as generic XRPC errors, but strict generated handler/client types will not contain them.

6. **Empty membership roles contradict the proposal.** Rev 18 deliberately permits `roles: []` for non-Flock groups ([plan:235](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:235)); the proposal assigns one or more roles to each member ([proposal:40](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/proposal.md:40)). The schema’s missing `minLength` does not resolve that prose/schema conflict.

7. **Credential and terminal-delivery tables have no retention contract.** Ten-minute credentials and fresh-JTI operations continually insert `issued_credential`; revocation and delivery add further rows. The expiry-index/pruning list omits `issued_credential`, `revoked_credential`, and terminal `outbox_notice` rows ([plan:200](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:200)). Long-lived groups therefore grow these tables without bound.

## Low

1. **Legacy third-party membership incarnation remains host-local.** Rev 18 explicitly preserves cross-host identity only for records carrying the Flock extension ([plan:241](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:241)).

2. **The claimed complete documentation sweep omits a deployed live deck.** Wave 6 omits `docs/presentation/r12-atproto-conference-deck.html`, which still advertises retired `new.flock.acceptance`, `new.flock.admin`, and `listInboxWriters` contracts ([deck:376](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/docs/presentation/r12-atproto-conference-deck.html:376)).

## Round 17 disposition

| Round 17 item | Rev 18 disposition |
|---|---|
| H1 — Atomic migration freeze | **Resolved.** Space/repo/external writes and leave now share locks and final lease checks. |
| H2 — Zero-human custody | **Partial.** Controller support was added, but coordinated key replacement and human-governance invariants leave it unusable in required cases. |
| H3 — Personal-PDS OAuth half | **Resolved for the cited omission** at [plan:209](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:209). Downstream consent is a separate new High. |
| M1 — Personal-PDS scopes | **Resolved** at [plan:291](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:291). The Blocker above concerns a different pre-DID Group Host scope. |
| M2 — Token response | **Resolved** at [plan:208](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:208). |
| M3 — Lost prepare response | **Partial.** Secret persistence/replay was added, but target-first probing still defeats replay during an outage. |
| M4 — Ticket length | **Resolved.** Rev 18 consistently uses 83 bytes. |
| M5 — Bootstrap labeler | **Resolved** with a structurally valid value at [plan:222](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:222). |
| L1 — Legacy incarnation | **Unresolved.** |

Round 17 tally: **6 resolved, 2 partial, 1 unresolved**.

VERDICT: REVISE