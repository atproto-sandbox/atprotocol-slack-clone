The stated checkouts match their pins. Rev 9 does not fully resolve Round 8: H3, M5–M8, and L2 are resolved in the written contract; H1 and H2 remain broken; H4, M1, M2, M4, and L1 are only partial. M3’s batching dimensions are correct, but deletion ordering prevents reliable delivery.

## Blocker

None.

## High

1. **The action-token claim destroys the envelope before returning it.**

   The SQL sets `claim_ciphertext_enc = NULL` and then returns that same post-update column, so the route receives `NULL`, not ciphertext to decrypt ([plan:140](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:140)). This leaves both standard outputless request flows unusable ([requestAccountDelete.json:5](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/lexicons/com/atproto/server/requestAccountDelete.json:5), [requestPlcOperationSignature.json:5](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/lexicons/com/atproto/identity/requestPlcOperationSignature.json:5)). The table also lacks uniqueness on `(group_did, actor_did, purpose)`, so multiple PLC requests can be consumed by one tuple-wide update ([plan:177](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:177)).

   **Fix:** use an `IMMEDIATE` transaction that selects the encrypted envelope and conditionally nulls exactly that row, or split delivery into a separate row consumable with `DELETE … RETURNING`. Enforce one active envelope per actor/purpose or require a claim identifier. Specify the request/response encoding and test duplicate requests and racing claims.

2. **The sole-member leave-to-recovery transition is absent, making the synthetic recovery state unreachable.**

   `effectiveStateForSession` can consume `group_recovery_admin` ([plan:224](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:224)), but Rev 9 never specifies an active `leaveGroup` transaction that inserts that row, deactivates the account, increments `auth_epoch`, or revokes sessions. The route only defines replay when such a row already exists ([plan:156](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:156)); the table is merely listed in the schema ([plan:177](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:177)). `reactivatingGroups` is likewise only named, without its promised four-phase state machine ([plan:264](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:264), [plan:302](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:302)).

   **Fix:** restore the exact sole-member `IMMEDIATE` transition: snapshot `recovery_did` and roles, delete membership, increment epoch, revoke OAuth and credentials, enqueue revocations, and deactivate atomically. Define the durable reactivation phases—activation, acceptance restoration, Operator reauthorization, and discovery—with crash-resume and lost-response behavior.

3. **`membership_incarnation` is not stable across migration.**

   Rev 9 says `importRepo` populates the counter ([plan:148](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:148)), but the migrated membership record contains only `roles` and `createdAt` ([membership.json:10](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/lexicons/group/opensocial/membership.json:10)), and the STAR archive contains only the commit and records ([provider.ts:20](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/space/src/sync/provider.ts:20)). Private host state intentionally does not migrate ([proposal.md:161](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/proposal.md:161)). Consequently, the target’s `COALESCE(MAX,0)+1` scheme resets imported memberships to `1` ([plan:227](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:227)). A stale pre-migration device holding incarnation `1` can then match and delete a newer imported membership.

   **Fix:** migrate the counters in an authenticated sidecar, or replace them with an opaque generation preserved in repo/migration data. Add a stale-device test covering leave, rejoin, migration, then replay against the target host.

4. **Deletion queues remote cleanup only after making its service-auth issuer unusable.**

   Rev 9 queues credential revocations, publishes a PLC tombstone, then queues invite clears and finally drains the outbox ([plan:190](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:190), [plan:191](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:191), [plan:192](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:192)). Recipients verify service JWTs by resolving the issuer’s current PLC `#atproto` key ([auth-verifier.ts:807](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/auth-verifier.ts:807)), while a PLC tombstone resolves to no document data ([data.ts:129](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/node_modules/.pnpm/@did-plc+lib@0.0.4_debug@4.4.3_supports-color@8.1.1_/node_modules/@did-plc/lib/src/data.ts:129)).

   Furthermore, `notifyRepoUpdate` has no `clearRecords` variant—only a revision and hash ([notifyRepoUpdate.json:12](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/lexicons/com/atproto/space/notifyRepoUpdate.json:12))—and Rev 9 purges the corresponding repo in the same transaction. The outbox schema also lacks the attempts, due time, expiry, status, and error fields required by its own bounded retry and terminal-drain claims ([plan:178](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:178), [plan:195](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:195)).

   **Fix:** add a pre-tombstone cleanup state that materializes final empty repo commits and drains authenticated notices while the DID remains resolvable, covering every previously attempted invitee space—not only extant invites. Alternatively define an explicit tombstone-aware cleanup protocol and client behavior. Add complete retry/lease/status/expiry fields and permanent-failure semantics.

## Medium

1. **PLC conflict recovery still infers conflict from a changed head rather than the actual error.**

   Any failed POST is retried if the refetched CID changed ([plan:191](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:191)). Thus an unrelated malformed/signature `4xx` coinciding with another operation is misclassified. The pinned PLC server’s actual stale-`prev` conflict is `409` ([db/index.ts:128](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/node_modules/.pnpm/@did-plc+server@0.0.1_debug@4.4.3_supports-color@8.1.1__supports-color@8.1.1/node_modules/@did-plc/server/src/db/index.ts:128)). The preflight also dereferences `rotationKey.did()` without defining the null/unreadable-key case ([plan:185](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:185)).

   **Fix:** classify explicit conflict status/body signatures before re-signing; terminate every other `4xx` regardless of concurrent head movement. Classify missing/decryption-failed rotation keys before use and normalize endpoint URLs before comparing authority.

2. **Join idempotency remains unbounded and has missing terminal branches.**

   The quota caps only terminal rows, allowing unlimited pending operation IDs ([plan:230](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:230)). After TTL pruning or state loss, `unknown` is handled only when the endpoint changed; same-endpoint `unknown` has no transition ([plan:258](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:258)). Multiple pending operations also cannot be targeted by standard `cancelJoinRequest`, whose input contains only `group` ([cancelJoinRequest.json:12](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/lexicons/group/opensocial/cancelJoinRequest.json:12)).

   **Fix:** cap all live rows, preferably allow one active pending request per group/requester, prune before admission, define expired/unknown-same-host behavior, and make cancellation cancel all pending keys or add a documented operation-ID extension. Specify resume behavior for every final client-journal phase.

3. **A concurrent `notifyRepoUpdate` can re-add an evicted writer.**

   Rev 9 promises atomic writer eviction ([plan:22](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:22)), but its notification contract only performs a live authorization check before recording the writer ([plan:154](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:154)). The pinned implementation performs those operations separately ([util.ts:345](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/api/com/atproto/space/util.ts:345)), and `recordWriter` explicitly re-adds a removed writer ([transactor.ts:153](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/actor-store/space/transactor.ts:153)).

   **Fix:** serialize notification recording with role/policy mutation, or capture a policy version and re-authorize inside the same `IMMEDIATE` transaction that records the writer. Add a barrier-controlled revoke-versus-notify test.

4. **Migration-session JWTs have no enforceable lifecycle contract.**

   `createAccount` returns vaguely “operation-bound” JWTs ([plan:135](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:135)), but those bearer sessions are subsequently accepted for `deactivateAccount` and every PLC identity route ([plan:137](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:137), [plan:139](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:139)). No `typ`, audience, operation ID, expiry, JTI/replay rule, epoch binding, or invalidation upon activation is defined. The standard output also requires explicit `accessJwt`, `refreshJwt`, `handle`, and `did` fields ([createAccount.json:43](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/lexicons/com/atproto/server/createAccount.json:43)).

   **Fix:** define the exact standard output mapping and signed claims, persist migration-operation state/JTIs, restrict import tokens to unactivated accounts, and invalidate them at activation or failed migration. Test replay, expiry, and post-activation identity/deactivation attempts.

5. **The hard-coded 2 MB blob limit can make valid migrations impossible.**

   Rev 9 caps every upload at `2_000_000` bytes ([plan:133](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:133)), while the pinned PDS limit is configurable and defaults to 5 MiB ([config.ts:41](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/config/config.ts:41)); standard migration copies every listed blob through `uploadBlob` ([account-migration.test.ts:147](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/tests/account-migration.test.ts:147)). This contradicts the requirement that all repo content move ([proposal.md:163](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/proposal.md:163)).

   **Fix:** use a configurable and advertised `blobUploadLimit`, preflight source compatibility, or provide a migration import path capable of preserving all referenced blobs. Test a blob above 2 MB and verify reference integrity after activation.

6. **`createReport` omits the upstream read-authorization requirement.**

   The plan authenticates `createReport` like the other personal service methods and validates only violation-rule existence ([plan:156](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:156), [plan:233](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:233)). Upstream requires the caller to be able to read the subject’s space and defines `InvalidSubject` ([createReport.json:7](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/lexicons/group/opensocial/createReport.json:7), [createReport.json:71](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/lexicons/group/opensocial/createReport.json:71)).

   **Fix:** resolve the subject to its group space, verify live read authorization and subject membership, validate any supplied CID, and return `InvalidSubject` without leaking private-space existence.

## Low

1. **The six-script manifest still classifies executable helpers as suites.**

   It walks every `protocol-tests/**/*.ts` while excluding only `support/**` and `atproto/**` ([plan:287](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:287)). That includes the imported helper [fixture-temp.ts:1](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/protocol-tests/fixture-temp.ts:1) and subprocess entrypoint [recover-pending-operation.ts:1](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/protocol-tests/recover-pending-operation.ts:1), neither of which belongs to a root test-script partition.

   **Fix:** move these under the excluded support tree or explicitly classify helper/subprocess entrypoints while retaining bidirectional coverage for actual suites.

VERDICT: REVISE