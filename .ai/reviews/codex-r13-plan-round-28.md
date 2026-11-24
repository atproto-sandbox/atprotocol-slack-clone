Rev 28 is not implementation-ready. Static tally: **0 Blocker, 0 High, 3 Medium, 1 Low**.

## Findings

1. **Medium — “Canonical” TID validation remains too permissive.**

   Rev 28 uses `^[234567abcdefghijklmnopqrstuvwxyz]{13}$` for extension fields, notification ordering, and roster projection ([plan:78](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:78), [keys.ts:15](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/packages/protocol/src/keys.ts:15)). The pinned protocol permits only `[234567abcdefghij]` as the first character ([tid.ts:4](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/syntax/src/tid.ts:4)).

   An imported `afterWriterRev` or `admittedSpaceRev` beginning `k`–`z` passes Rev 28 validation but sorts above every valid TID, potentially preventing legitimate notifications or roster admission indefinitely.

   **Required correction:** use pinned `isValidTid` or its exact semantics everywhere and test leading `k`–`z` rejection across write, import, notification, and projection.

2. **Medium — `key: "any"` spaces are incorrectly limited to 128 characters.**

   Rev 28 applies Flock’s `isSkey` to every `key: "any"` space ([plan:78](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:78)); that helper caps keys at 128 characters ([keys.ts:10](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/packages/protocol/src/keys.ts:10)). Pinned record-key syntax permits 1–512 characters ([recordkey.ts:3](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/syntax/src/recordkey.ts:3)), and Lexicon `any` means any valid record key ([record-key.ts:5](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/lex/lex-schema/src/core/record-key.ts:5)).

   This rejects protocol-valid third-party modality spaces during creation, import, or activation.

   **Required correction:** use `isValidRecordKey` for protocol validation while retaining the 128-character limit only for Flock-created UI/operator keys. Test 129 and 512 as accepted and 513, `.` and `..` as rejected.

3. **Medium — `decideJoinRequest` is assigned two incompatible persisted meanings.**

   Rev 28 retains private-channel request orchestration but also assigns Operator `decideJoinRequest` to OpenSocial group admission ([plan:276](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:276)).

   The released operation requires `{request, requestId, decision}` and operates on a `new.flock.inbox` private-channel request ([decide-join-request.ts:13](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/apps/operator/src/operator/kinds/decide-join-request.ts:13)). OpenSocial pending requests expose only `{member, createdAt, message?}` ([defs.json:143](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/lexicons/group/opensocial/defs.json:143)). The target explicitly requires a new kind whenever persisted request shape or steps change ([kind.ts:7](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/apps/operator/src/operator/kinds/kind.ts:7)), and rejects missing or unexpected fields ([operations.ts:193](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/apps/operator/src/operator/operations.ts:193)).

   Repurposing the kind risks breaking private-channel behavior and replaying pre-R13 journal rows under different semantics.

   **Required correction:** preserve `decideJoinRequest`; add a distinct group-admission kind with exact fields, journal steps, client/UI mapping, and an upgrade test recovering a seeded R12 private-channel operation.

4. **Low — `createReport` rejects the implicit group account.**

   Rev 28 requires an explicit `membership/<subject>` for every account subject ([plan:279](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:279)). Upstream defines the group DID as an implicit member with no membership record ([proposal.md:46](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/proposal.md:46)), while `createReport` accepts account DIDs ([createReport.json:18](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/lexicons/group/opensocial/createReport.json:18)).

   **Required correction:** accept `subject === groupDid || membership exists`, retaining the no-`cid` and `members/self` read checks.

## Round 27 disposition

| Round 27 item | Disposition |
|---|---|
| `allowedApps: []` falsely accepted | **Fully resolved.** Rev 28 requires `allowedApps === undefined` and includes unit and real-PDS negative cases ([plan:341](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:341)). |
| Malformed `new.flock.*` extension values | **Partially resolved.** Boundary decoding is now specified, but the selected TID predicate still accepts protocol-invalid values. |
| Missing `literal:self` enforcement | **Fully resolved.** Shared validation now covers creation, import, activation, writes, and negative tests ([plan:78](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:78), [plan:139](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:139)). |

All requested commit pins matched. The Spaces checkout contained exactly the declared two-file overlay, and its diff matched the committed patch SHA-256 `3f413baa779473b5466e8e6ca9edc92335f5056edbd13aa3d4bfc57a509b32dd`. Rev 28 SHA-256 was `e6946544b06c9a85fb2ba164f094f02ee17ca50fcd5bd3f6492f72ca0ec49d4c`.

This was a static review corroborated by an independent reviewer and fresh critic. No files were modified; no tests, builds, code generation, generators, or writer scripts were run.

VERDICT: REVISE