Rev 20 is not implementation-ready. Static tally: **1 Blocker, 3 High, 2 Medium, 2 Low**. Round 19 disposition: **4 resolved, 1 partial, 1 unresolved**.

## Findings

### Blocker

1. **Creator acceptance creates an unavoidable bootstrap deadlock.**

   Rev 20 requires every journaled Operator operation to verify `membership/*` plus member-authored `acceptance/self` before initial admission and every step ([plan:37](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:37)). But `prompt=create` creates only `membership/<creatorDid>` ([plan:222](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:222)); the client waits for `createWorkspace` to return before writing acceptance ([plan:320](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:320), [plan:328](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:328)). The existing target confirms `createWorkspace` is journaled ([create-workspace.ts:73](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/apps/operator/src/operator/kinds/create-workspace.ts:73)).

   Upstream also says acceptance gates roster appearance, not access ([proposal.md:195](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/proposal.md:195)). Authorization derives from membership, roles, policies, and `assignable` ([proposal.md:59](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/proposal.md:59)).

   Remove acceptance from Operator authority decisions, or specify a bounded bootstrap ordering/exception that lets the creator write acceptance before Operator admission.

### High

1. **Round 19 H1 remains partial: Standard migration still cannot guarantee sovereign-key preservation.**

   Coordinated migration now carries `sourceLocalRotationKey`, but Standard mode records the optional public response without the coordinated group/operation bindings ([plan:139](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:139)). The target merely recommends a key set ([plan:143](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:143)); preservation of every external sovereign key is enforced only when `lease.mode === "coordinated"` ([plan:144](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:144)).

   Consequently, a Standard client can drop every sovereign key for a human group, or all but one for a zero-human group, and still pass the target checks. Unknown-source migrations also need an explicit policy when five sovereign keys already consume PLC’s five-key maximum.

   Validate and persist the live source key set, enforce preservation during Standard signing/submission, verify source-local provenance, and reject impossible over-capacity transitions rather than silently selecting keys.

2. **The sole-member path breaks non-Flock zero-human governance.**

   Rev 20 says non-Flock groups may remove their final human and remain governed by an external sovereign PLC key ([plan:235](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:235), [plan:239](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:239)). Yet the sole-member branch is unconditional: it deactivates every group and records the departing member as recovery admin ([plan:244](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:244)). Reactivation then restores that departed member ([plan:247](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:247)).

   This conflicts with upstream `leaveGroup`, which deletes the caller’s membership, and with governance being out of scope ([proposal.md:169](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/proposal.md:169), [proposal.md:233](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/proposal.md:233)). Scope reversible deactivation to Flock workspaces; non-Flock groups satisfying `NoSovereignCustodyKey` should remain active and zero-human.

3. **Runtime `include:` permission expansion has no implementable contract.**

   Admin and moderator roles depend on `include:group.opensocial.authManageGroup` and `include:group.opensocial.authModerate` ([plan:94](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:94), [plan:108](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:108)). Rev 20 filters permission-set documents from code generation and omits them from the runtime registry ([plan:77](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:77), [plan:79](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:79)), then only refers to “expanded `ScopePermissions`” without specifying how expansion occurs ([plan:237](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:237)).

   Pinned `ScopePermissions` merely parses resource scopes ([scope-permissions.ts:44](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/oauth/oauth-scopes/src/scope-permissions.ts:44)); `IncludeScope` needs the actual permission-set document to expand it ([include-scope.ts:42](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/oauth/oauth-scopes/src/scopes/include-scope.ts:42)). Without this, core administration and moderation RPC grants disappear.

   Define a dedicated vendored permission-set registry and expansion step before issuance, live narrowing, role-union checks, and effective-admin evaluation.

### Medium

1. **Same-DID parallel upstream OAuth callbacks share and revoke each other’s temporary sessions.**

   Rev 20 uses one `upstream_oauth_session` store while claiming parallel-flow isolation, then immediately signs out by DID ([plan:211](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:211), [plan:212](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:212)). The pinned OAuth client revokes an existing session keyed by `tokenSet.sub` before storing the callback session. Existing target code already avoids this with a fresh throwaway map per callback ([authority-grant.ts:203](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/apps/operator/src/operator/authority-grant.ts:203), [authority-grant.ts:558](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/apps/operator/src/operator/authority-grant.ts:558)).

   Use an isolated per-callback session store and gate simultaneous callbacks for the same personal DID.

2. **An empty label value can poison moderation-history output.**

   Pinned `com.atproto.label.record` permits `val: ""` because it has no `minLength` ([record.json:23](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/lexicons/com/atproto/label/record.json:23)). Upstream `labelEvent.val` requires at least one character ([defs.json:117](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/lexicons/group/opensocial/defs.json:117)). Rev 20 accepts pinned-shape labels and records a `labelEvent` for every write ([plan:154](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:154)), so `getModSubjectHistory` can emit an upstream-invalid response ([plan:284](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:284)).

   Reject empty values during write and import, or specify a conformant history mapping.

### Low

1. **Round 19 L1 remains unresolved.** Legacy third-party membership records without `"new.flock.incarnation"` still receive a host-local incarnation, so stale-leave identity is not stable across migration ([plan:241](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:241)).

2. **The Group Host DID comment conflates two service identities.** The `did:web:localhost%3A3004` Group Host DID is described as matching `OPERATOR_SERVICE_REF` ([plan:130](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:130)), but `.env.example` defines the Operator at port 3001 with its own fragment ([.env.example:7](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.env.example:7)). The operational derivation is otherwise clear, so this is documentation-only.

## Round 19 disposition

| Round 19 item | Rev 20 disposition |
|---|---|
| Blocker — loopback callback used `localhost` | **Resolved.** The public URL and callback are normalized to `127.0.0.1`, while only the loopback client-ID origin remains `http://localhost` ([plan:293](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:293)). |
| High — source-local versus sovereign migration keys | **Partial; High remains.** Coordinated provenance improved, but Standard preservation and fail-closed provenance remain incomplete, as described above. |
| High — production lexicon publication dependency | **Resolved.** Live DNS/repo publication is now a mandatory fail-closed prerequisite and launch gate ([plan:12](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:12)). |
| Medium — quota error automatic retry loop | **Resolved.** `quota_exceeded` is passive and skipped by automatic resume/discovery ([plan:319](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:319), [plan:320](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:320)). |
| Low — legacy third-party incarnation | **Unresolved; Low remains.** |
| Low — absent `cancelJoinRequest` behavior | **Resolved.** Server behavior is explicitly `400 JoinRequestNotFound`, while the client treats it as terminal completion ([plan:274](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:274), [plan:321](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:321)). |

Review scope was frozen at plan SHA-256 `7e89f3bb5444a334d39a27aff0695119b59b55f74eef6016f736b2b6495ece0b`. All three requested commits matched. This was a read-only static review: no files were modified and no tests or builds were run. The pinned Spaces checkout’s pre-existing `credential.ts` changes were excluded by inspecting pinned Git objects where relevant.

VERDICT: REVISE