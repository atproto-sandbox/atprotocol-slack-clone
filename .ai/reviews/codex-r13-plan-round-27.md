Rev 27 is not implementation-ready. Static tally: **0 Blocker, 0 High, 3 Medium, 0 Low**.

### Medium

1. **Round 26’s invitation-space item is only partially resolved: `allowedApps: []` is falsely accepted.**

Rev 27 now specifies fresh provisioning, exact URI/policy, concurrent-create handling, restart verification, zero-member validation, and acceptance coverage ([plan:338](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:338)). However, its compatibility predicate accepts both absent and empty `allowedApps` ([plan:341](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:341)).

The pinned policy permits an empty array but defines any present array as an allow-list ([policy.json:19](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/lexicons/com/atproto/memberspace/policy.json:19)). The PDS treats only `undefined` as unrestricted; `[]` authorizes no application ([policy.ts:110](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/space-policy/policy.ts:110)) and returns `AppNotAuthorized` ([manager.ts:250](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/space-policy/manager.ts:250)). Consequently, Rev 27 can cache a deny-all space as verified and then fail invitation sync.

Require `settings.allowedApps === undefined` and add the empty-array case to both unit and real-PDS incompatible-policy tests. Thus the sole Round 26 Medium is **partially resolved**, not fully disposed.

2. **Lexicon-valid `new.flock.*` extension values can poison migration, notification, and roster projection.**

Upstream `membership` and `acceptance` are open objects that do not declare these extension fields ([membership.json:10](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/lexicons/group/opensocial/membership.json:10), [acceptance.json:10](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/lexicons/group/opensocial/acceptance.json:10)). Pinned Lexicon validation checks only declared properties and preserves unknown values ([complex.ts:97](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/lexicon/src/validators/complex.ts:97), [complex.ts:152](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/lexicon/src/validators/complex.ts:152)).

Rev 27 preserves imported extensions verbatim ([plan:152](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:152)) but directly supplies `afterWriterRev` and `admittedSpaceRev` to `TID.fromStr` in notification and projection paths ([plan:158](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:158), [plan:354](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:354)). `TID.fromStr` throws for wrong types/lengths and does not establish canonical TID characters ([tid.ts:9](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/common-web/src/tid.ts:9), [tid.ts:56](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/common-web/src/tid.ts:56)).

Define strict semantic decoding for all four extension fields at write, import, and projection boundaries, with typed rejection or deterministic legacy/fail-closed behavior. Add malformed-type and invalid-13-character migration/projection tests.

3. **Runtime creation/import does not enforce the OpenSocial space lexicons’ `literal:self` keys.**

The upstream `meta`, `members`, and `invites` space lexicons require `self` keys ([meta.json:6](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/lexicons/group/opensocial/meta.json:6), [members.json:6](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/lexicons/group/opensocial/members.json:6), [invites.json:6](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/lexicons/group/opensocial/invites.json:6)).

Rev 27 gives admins wildcard space creation authority ([plan:99](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:99)), while `createSpace` validates authorization and policy but not the space-type key contract ([plan:145](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:145)). Import and activation similarly do not reject extra `group.opensocial.meta/foo` or `members/foo` spaces ([plan:139](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:139), [plan:151](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:151)).

Add shared runtime space-type/key validation to creation and import, revalidate staged spaces before activation, and add negative cases for non-`self` reserved spaces.

All requested pins matched exactly. The Spaces checkout contained exactly the declared two-file overlay, whose diff matched the committed patch hash. Rev 27 SHA-256 is `17214a0960e49701b4d213aca2f1afa3b083480623de511c06e036716d63b128`. No files were modified and no tests, builds, codegen, generators, or writer scripts were run.

VERDICT: REVISE