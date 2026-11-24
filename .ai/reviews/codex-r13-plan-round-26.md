Rev 26 is not implementation-ready. Static tally: **0 Blocker, 0 High, 1 Medium, 0 Low**. All five Round 25 findings are resolved, but the remaining Medium leaves a core fresh-account prerequisite undefined.

### Medium

1. **Fresh users never provision their personal invitations space.**

Upstream requires the user’s app to create `group.opensocial.invites/self` with `com.atproto.memberspace.policy`, `publicWrite: true`, and zero members ([proposal:155](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/proposal.md:155)).

Rev 26 assumes the space exists ([plan:23](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:23)), grants `manage=create` ([plan:297](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:297)), and defines subsequent registration/read/sync behavior ([plan:340](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:340), [plan:344](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:344)), but never assigns an onboarding or lazy `createSpace`/ensure flow. The pinned PDS requires an explicit authenticated creation call ([createSpace.ts:19](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/api/com/atproto/space/createSpace.ts:19)); granting scope alone does not create anything.

Consequently, a fresh personal PDS cannot receive/discover invitations unless a fixture or another application pre-creates the space. Gate 5 could false-green if its fixture does so implicitly.

Required revision: add an idempotent `WorkspaceClient` provisioning step before notify registration/read/sync, using the exact space URI and policy; handle `SpaceAlreadyExists` races by validating the existing policy; fail clearly on incompatible policy; and test a genuinely fresh PDS, concurrent creation, restart, and incompatible pre-existing space.

### Round 25 disposition

| Round 25 item | Rev 26 disposition |
|---|---|
| High — Flock-specific migration advertisements | **Resolved.** Outbound migration is explicitly scoped and named “Flock-Advertised Target Interoperability,” which was Round 25’s permitted alternative ([plan:131](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:131)). |
| High — `prompt=create` recovery | **Resolved.** Five-minute code expiry, lost-response pivot to existing-group reauthorization, cleanup, and failpoint coverage are specified ([plan:199](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:199), [plan:217](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:217), [plan:222](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:222)). |
| Medium — future-dated stale acceptance | **Resolved.** Incarnation/generation plus writer- and space-revision evidence replaces timestamp trust, with the `2099` case explicitly covered ([plan:351](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:351)). |
| Medium — `createReport` principal guard | **Resolved.** `iss === body.group` is rejected for all four personal methods ([plan:160](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:160)). |
| Low — lexicon arithmetic | **Resolved.** The plan now consistently states `40 + 32 = 72` and `27 + 72 = 99` ([plan:54](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:54), [plan:77](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:77)). |

Pins matched exactly. Rev 26 SHA-256 is `696161cedeaf64412d5c573345b7117bcebe60bf4f3b233a4246c1fa2da48d5b`; the overlay remains `3f413baa…b32dd`, with exactly the two declared Spaces files modified. The plan and Round 25 review remain untracked artifacts atop the pinned target commit. No files were modified, and no tests, builds, codegen, generators, or writer scripts were run.

VERDICT: REVISE