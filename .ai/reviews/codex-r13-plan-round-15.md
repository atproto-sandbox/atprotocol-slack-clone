Rev 15 is not ready to execute. Static review found **0 Blocker, 6 High, 6 Medium, and 1 Low** defect classes.

All pins matched:

- OpenSocial proposal: `8df0cc82eb7708f090aa43522adf1d3ada3ed7e7`
- Spaces: `6747610566eee1b6d743617bd8eb1136adccb362`
- Target: `5ae1b7ca2522ab20b35b89ed2e471fc9b79f4575`
- Rev 15 SHA-256: `d136e9498405e0f973bb8aacc48775b9594df080950f01fc62dc7b98466b4297`

The disclosed Spaces modifications and target’s untracked plan/reviews were preserved. No files were modified and no tests or builds were run.

## Round 14 disposition

| # | Finding | Rev 15 result |
|---|---|---|
| 1 | Standard migration interoperability | **Partial — High remains.** Non-200 fallback is fixed, but two Rev 15 hosts still force proprietary coordination. |
| 2 | Manifest/JWT size preflight | **Partial — High remains.** Full manifest bounds are fixed; the serialized ticket is not safely bounded before freeze. |
| 3 | Abort binding/idempotency/deadline | **Partial — Medium remains.** Session binding and idempotent outcomes are fixed; the immutable shared deadline is lost. |
| 4 | App-subject lifecycle | **Resolved.** The invariant is now conditional and supports inactive tombstones at [plan:114](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:114). |
| 5 | Manifest migration selector | **Resolved.** Group, operation, ticket, digest, and target identity are bound at [plan:130](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:130). |
| 6 | Unknown `joinPolicy` | **Resolved.** Unknown values fail closed at [plan:265](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:265). |
| 7 | `requestJoin` replay/final response | **Partial — Medium remains.** Several admission paths are repaired, but direct membership writes can leave stale pending replays. |
| 8 | Idempotency quota eviction | **Resolved.** Only expired rows are pruned and the 200-row quota rejects without eviction at [plan:248](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:248). |
| 9 | Executable zero-skew validation | **Resolved.** The installed verifier is wrapped with an exact-expiry check at [plan:156](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:156). |
| 10 | Weighted bulk charging | **Resolved.** The pinned 3/2/1 charging is applied at [plan:135](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:135). |
| 11 | `importSpaceMeta` envelope | **Resolved.** Negotiation and endpoint caps are both 100 MiB at [plan:151](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:151). |
| 12 | Versioned canonical manifest | **Partial — Medium remains.** The outer format is canonicalized, but inner hash byte domains remain undefined. |
| 13 | Legacy third-party incarnation | **Unresolved — Low.** Cross-host continuity remains explicitly deferred at [plan:235](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:235). |

That is **7 resolved, 5 partial, and 1 explicitly deferred**.

## High

1. **Standard migration remains nonconformant.** Upstream requires standard account migration ([proposal:163](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/proposal.md:163)), but Rev 15 refuses unprepared migration when the target advertises v1 at [plan:140](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:140) and [plan:143](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:143). Target creation also tries to infer an active per-group lease from selector-free, host-wide capability metadata at [plan:138](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:138). On non-v1 peers, standard `describeServer` exposes only `blobUploadLimit`, yet preparation consumes four proprietary limit fields ([schema:22](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/lexicons/com/atproto/server/describeServer.json:22), [plan:131](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:131)).

2. **The migration ticket can exceed its transport cap after freeze.** The ticket includes `sourceServiceDid`, is signed only after the lease freezes writes, and is asserted to be below 1.2 KiB at [plan:131](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:131); the target caps it at 2 KiB at [plan:138](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:138). A valid DID may contain 2,048 characters ([did.ts:24](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/syntax/src/did.ts:24)); its base64url payload alone exceeds the cap. The actual compact JWT must be bounded or serialized before freezing.

3. **Migration preflight is not an atomic snapshot.** Manifest and archive sizes are computed before the lease/freeze at [plan:131](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:131), without the repository’s lock/CAS pattern described at [plan:185](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:185). A concurrent repo, space, or blob mutation can invalidate both the digest and size decision; the later equality check discovers that only after freeze.

4. **The coordinated service identity and ticket trust contract are undefined.** The plan relies on `groupHostServiceDid`/`targetServiceDid` for ticket signing, manifest authentication, and attestations at [plan:130](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:130), but defines no persistent host signing key, DID publication, rotation, or restart behavior. It also omits exact ticket `typ`, algorithm, issuer, audience, group binding, key resolution, and equality checks against the PLC-resolved source and local target. The only specified host secret is the symmetric encryption key at [plan:178](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:178).

5. **Inbound migration rejects valid OpenSocial groups.** Activation requires `declaration/self` and a Flock-specific effective-human-admin condition at [plan:139](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:139). Upstream makes declaration optional discovery metadata ([proposal:133](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/proposal.md:133)), does not require particular role semantics ([proposal:123](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/proposal.md:123)), and permits arbitrary governance. A conforming nondiscoverable third-party group therefore cannot migrate in.

6. **Standard public-repo CAS semantics are missing.** The planned CRUD contract at [plan:135](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:135) omits caller-visible `swapCommit`, `swapRecord`, and `InvalidSwap`. These are defined by the pinned [applyWrites](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/lexicons/com/atproto/repo/applyWrites.json:31), [createRecord](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/lexicons/com/atproto/repo/createRecord.json:38), [putRecord](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/lexicons/com/atproto/repo/putRecord.json:39), and [deleteRecord](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/lexicons/com/atproto/repo/deleteRecord.json:29) contracts. Internal storage CAS does not implement client preconditions.

## Medium

1. **The shared migration deadline is not retained.** `expires_at` becomes `NULL` after `plc_signed`, after which abort substitutes a fresh `now + 2h` deadline at [plan:131](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:131). Persist an immutable source `deadline_at`.

2. **Direct membership admission can leave stale pending replay responses.** Ordinary membership writes update pending join operations only through the optional approval header at [plan:153](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:153). Replay returns stored `pending` before checking membership at [plan:249](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:249).

3. **Canonical inner hash inputs remain undefined.** RFC 8785 defines the outer manifest, but Rev 15 never defines ordering/framing for `publicRecordsSha256` or whether `spaceMetaSha256` hashes raw STAR bytes or canonical decoded state at [plan:131](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:131). Independent hosts can compute different values before the byte-exact check at [plan:139](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:139).

4. **Prepared source leases have no expiry transition.** A two-hour source expiry is stored, but only target staging GC is specified at [plan:138](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:138); some source paths reject whenever the row exists, including [plan:238](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:238). A dead client can leave the source frozen indefinitely.

5. **Forward-compatible `requestJoin` responses are unhandled.** `status` is open `knownValues` at [requestJoin.json:37](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/lexicons/group/opensocial/requestJoin.json:37), and generated types include `UnknownString` ([lex-def-builder.ts:907](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/lex/lex-builder/src/lex-def-builder.ts:907)). The client state machine handles only `admitted` and `pending` at [plan:305](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:305), allowing an unknown valid value to leave a retrying journal.

6. **Development deployment configuration is incomplete and conflicting.** Group Host defaults to port 3002 at [plan:283](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:283), already used by the echo bot in [.env.example:25](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.env.example:25). The example contains neither `GROUP_HOST_URL` nor required `GROUP_HOST_ENCRYPTION_KEY`, and `.env.example` is absent from the implementation-wave ownership list.

## Low

1. **Legacy third-party membership incarnation remains host-local.** Upstream membership has no incarnation field ([membership.json:10](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/lexicons/group/opensocial/membership.json:10)); Rev 15 explicitly provides only same-host protection for records lacking the extension at [plan:235](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:235).

VERDICT: REVISE