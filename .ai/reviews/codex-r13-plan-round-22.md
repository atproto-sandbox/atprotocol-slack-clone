Rev 22 is not implementation-ready. Static tally: **0 Blocker, 1 High, 1 Medium, 1 Low**.

## Remaining findings

### High

1. **Migration-target `createAccount` lacks an executable account/bootstrap/output transaction.**

   Rev 22 authenticates migration provenance and then only specifies creating `migration_session` ([plan:138](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:138)). It never defines:

   - validation/reservation of `body.handle`;
   - generation and encryption of target signing, KEM, and rotation keys;
   - creation or safe reinitialization of `group_account` with `activated = 0`, `takendown = 0`, and `auth_epoch`;
   - minting the access/refresh JWTs represented by `access_jti` and `refresh_jti`;
   - the required `{ accessJwt, refreshJwt, handle, did }` response;
   - atomic rollback, lost-response replay, or migration back to a previously used host.

   The next import routes already require an inactive `group_account`, while credential recommendation requires the missing local keys ([plan:136–142](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:136)). The pinned schema requires all four response fields ([createAccount.json:43](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/lexicons/com/atproto/server/createAccount.json:43)), and the pinned implementation explicitly creates storage, account, and session before returning them ([createAccount.ts:74](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/api/com/atproto/server/createAccount.ts:74), [createAccount.ts:95](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/api/com/atproto/server/createAccount.ts:95), [createAccount.ts:135](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/api/com/atproto/server/createAccount.ts:135)).

   Define a single atomic, retry-safe first-time/re-entry staging transaction covering those operations and A→B→A migration.

### Medium

2. **`recoveryKey === sourceLocalRotationKey` produces an impossible migration state.**

   The preservation formula removes `sourceLocalRotationKey` and then re-adds it through `body.recoveryKey` whenever it differs from only the target-local key ([plan:138](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:138)). The PLC operation must then both omit that key for `SourceRotationKeyRetained` and retain it for `SovereignRotationKeyDropped` ([plan:142](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:142)). No operation can pass.

   Reject this equality before staging/JTI consumption, or explicitly exclude the source-local key from the preserved set. `recoveryKey` is a valid optional standard input ([createAccount.json:32](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/lexicons/com/atproto/server/createAccount.json:32)).

### Low

3. **The legacy-incarnation CID expression uses the wrong pinned API.**

   Rev 22 specifies `cidForCbor(recordValue).toString()` ([plan:240](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:240)). The pinned function is asynchronous and accepts raw CBOR `Uint8Array`, not the decoded record ([cid.ts:541](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/lex/lex-data/src/cid.ts:541)). STAR verification already yields the CID computed from the original bytes ([consumer.ts:164](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/space/src/sync/consumer.ts:164)). Use the yielded `cid.toString()`.

## Round 21 disposition

| Round 21 item | Rev 22 disposition |
|---|---|
| High — private dirty Spaces installation | **Resolved.** The committed overlay, clean reconstruction instructions, exact base/patched hashes, lockfile, and 19,163-file dist manifest all verified ([plan:5](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:5), [pin instructions:21](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/docs/protocol/atproto-spaces-pin.md:21)). |
| High — sovereign-key preservation | **Resolved at High severity.** Authenticated Flock/non-Flock provenance, fail-before-staging behavior, capacity checks, and unconditional preservation checks are present. The recovery-key collision above remains Medium. |
| High — policy-grant scopes omitted | **Resolved.** Canonical effective permissions union role scopes with space-clamped policy-grant scopes across authorization, narrowing, administration, and anti-escalation ([plan:22](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:22), [plan:235](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:235)). |
| Medium — demoted-actor database migration | **Resolved.** Version 4 rebuild/backfill, owner/executor separation, Wave 3 ownership, and pre-R13 upgrade coverage are explicit ([plan:36](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:36), [plan:362](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:362)). |
| Low — host-local legacy incarnation | **Partial.** The deterministic CID design fixes host-local randomness, but its concrete pinned-API expression is defective as described above. |

The upstream commit and all 27 lexicons matched the plan’s inventory; no separate upstream-conformance defect was found. All requested repository HEADs matched exactly. The Spaces checkout contained only the two declared overlay modifications, whose diff matched committed patch SHA-256 `3f413baa…32dd`.

Reviewed plan SHA-256: `c0d9ea12…4380`; Round 21 review SHA-256: `3ba1f0e1…80e7`. This was a static, read-only review: no files were modified and no tests or builds were run.

VERDICT: REVISE