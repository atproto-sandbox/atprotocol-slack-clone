The requested checkouts match the stated pins. This was a static, read-only adversarial review; no files were edited or tests executed.

Round 7 disposition: Rev 8 correctly specifies the 32-file transitive closure and route manifest ([plan:55](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:55), [plan:78](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:78)); action-token tuple and transactional checks; PLC serialization/null advancement/re-signing; durable app ledger, role key, guards, and grants; auth epochs and the three revocation triggers; CID header, blocked acceptance cleanup, and typed errors; join status and unified five-phase admission; and the defined `*.test.ts`/`*.spec.ts` suite partition. Several remain incomplete end-to-end as detailed below.

## Blocker

None.

## High

1. **Action tokens are generated but cannot reach the actor.**

   Both request procedures insert only `sha256Hex(rawToken)` ([plan:139](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:139), [plan:180](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:180)). Neither standard request lexicon has an output ([requestAccountDelete.json:5](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/lexicons/com/atproto/server/requestAccountDelete.json:5), [requestPlcOperationSignature.json:5](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/lexicons/com/atproto/identity/requestPlcOperationSignature.json:5)), while `deleteAccount` and `signPlcOperation` require that token. The pinned PDS sends it through email ([requestAccountDelete.ts:59](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/api/com/atproto/server/requestAccountDelete.ts:59)); Rev 8 defines no mailer, verified contact, notification, or compatible extension. Thus neither deletion nor migration can complete through a black-box client.

   **Fix:** specify a CSPRNG-token delivery mechanism—verified out-of-band delivery or an explicitly authenticated Flock extension—and its expiry/replay/CORS behavior. Add black-box round trips for both purposes. Migration must explicitly follow target `getRecommendedDidCredentials` → source request/sign → target submit/activate, matching the pinned choreography ([account-migration.test.ts:175](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/tests/account-migration.test.ts:175)).

2. **Recovery deletion is unreachable after sole-member leave.**

   Sole-member leave deletes the recovery actor’s membership and stores only `roles_json` ([plan:233](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:233)). But `isEffectiveAdminMember` unconditionally requires an extant membership ([plan:229](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:229)), and both deletion transactions apply that predicate ([plan:180](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:180)). This contradicts the recovery allowlist containing both deletion routes ([plan:234](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:234)) and regresses the synthetic recovery state previously credited as resolved ([Round 7 Opus:11](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/reviews/opus-r13-plan-round-7.md:11)).

   **Fix:** in both token issuance and consumption transactions, construct the same authorization state that `activateAccount` uses: synthesize the recovery DID’s membership from `group_recovery_admin.roles_json`, then evaluate it against current roles, policies, and `known_app_subject`. Test direct deletion immediately after sole-member leave.

3. **`authorizeSpaceSync` can mint a credential after deactivation or deletion.**

   The lifecycle check occurs before client-attestation resolution and a potentially 10-second `confirmRegistration` call ([plan:214](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:214), [plan:218](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:218)). Rev 8 then mints and inserts the credential without a stated final lifecycle, authorization, or epoch check ([plan:219](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:219)). Deactivation, sole-member leave, or deletion can commit meanwhile; its revocation snapshot misses the subsequently inserted JTI. The receiving PDS checks only its local revoked-JTI table ([auth-verifier.ts:451](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/auth-verifier.ts:451)).

   **Fix:** capture `auth_epoch`, perform external work, then use one synchronous `IMMEDIATE` transaction to re-read `activated`, takedown/deletion state, unchanged epoch, current policy/member authorization, and space status before inserting the credential and registration. Test barrier-controlled races against all three transitions and assert deletion cannot resurrect rows after purge.

4. **CID mismatch still leaves live access with the acceptance removed.**

   The client deletes `acceptance/self` first ([plan:262](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:262)), then clears its journal on `MembershipGenerationMismatch` ([plan:266](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:266)). A routine role update changes the membership CID without creating a new membership incarnation. The result is a surviving membership with no acceptance: the user retains access but disappears from the roster because acceptance gates visibility, not access ([proposal.md:44](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/proposal.md:44), [proposal.md:195](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/proposal.md:195)). A stale device can likewise delete a newer acceptance before discovering the mismatch.

   **Fix:** perform the conditional group leave before deleting acceptance, retaining a cleanup journal if the latter fails; or introduce a stable host-issued membership-incarnation value distinct from the mutable record CID. On mismatch, preserve/restore acceptance and surface or retry the incomplete leave. Also re-resolve the DID and confirm the contacted endpoint is authoritative before treating `RepoNotFound` as terminal ([plan:267](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:267)).

## Medium

1. **PLC authority loss and stale-`prev` errors are over-classified.**

   Rev 8 treats either a changed service endpoint or an absent local rotation key as migrated-away and advances to `plc_tombstoned`; it also sends every `400`/`409` through stale-`prev` recovery ([plan:183](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:183)). A key can be rotated out while `#atproto_pds` still points to this host, and a generic `400` can represent an invalid signature or malformed operation rather than a conflict.

   **Fix:** distinguish endpoint migration, already-tombstoned/404, same-host authority loss, and the exact PLC previous-operation conflict response. Same-host key loss needs an explicit `authority_lost`/local-only-deletion policy, not silent “PLC tombstoned” success; unrelated 4xx responses must be terminal rather than re-signed indefinitely.

2. **Permanent deletion does not exhaustively settle invite outbox work.**

   Invite writes create `notifyRepoUpdate` jobs ([plan:148](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:148)). Deletion purges `invite_delivery` but only replaces syncer notices associated with current `notify_registration` rows ([plan:184](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:184)); the terminal worker drains only `#spaceDeleted` and credential-revocation jobs ([plan:185](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:185)). Pending invite notifications can therefore survive their tracking rows, send after deletion, or prevent a genuinely empty purge.

   **Fix:** define typed outbox kinds and terminal treatment. The deletion transaction must cancel every pending invite job and either materialize any required invite-revocation/removal notification before key scrubbing or explicitly define remote stale-invite behavior. Assert no nonterminal group outbox rows at `purged`.

3. **Credential revocation does not specify mandatory batching dimensions.**

   `notifyCredentialsRevoked` accepts one `space` and at most 100 JTIs ([notifyCredentialsRevoked.json:12](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/lexicons/com/atproto/space/notifyCredentialsRevoked.json:12)). Rev 8 says only “all unexpired JTIs” to every writer PDS ([plan:137](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:137)).

   **Fix:** group by `(space_uri, writer_did/endpoint)`, chunk at 100, and give each batch a durable, non-coalescing identity separate from syncer deletion keys. Test 101+ JTIs spanning multiple spaces and writers through deactivation, sole-member leave, and deletion.

4. **Join operations strand across migration and lack a bounded idempotency contract.**

   The client preserves `state === "unknown"` indefinitely ([plan:272](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:272)), while both upstream and Rev 8 state that private join state does not migrate ([proposal.md:163](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/proposal.md:163), [plan:319](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:319)). After migration, the new host necessarily returns `unknown`, so the operation remains pending forever.

   Separately, the server schema stores no request-intent hash, canonical response, acknowledgement, expiry, or quota ([plan:175](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:175)) despite promising stored-result replay ([plan:241](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:241)). Arbitrary operation IDs can grow the table without bound, and reuse with changed input is ambiguous.

   **Fix:** record the authority endpoint/host epoch in the client journal and treat endpoint-change-plus-`unknown` as migrated/orphaned, offering a controlled new operation. Bind each server key to a canonical request hash and response, reject changed input, bound key length, and define acknowledgement/retention/rate limits.

5. **Standard repo routes reject handles allowed by their lexicons.**

   Rev 8 requires literal `sub === body.repo` ([plan:132](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:132)), but standard repo inputs use `at-identifier` and expressly accept either a handle or DID ([createRecord.json:14](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/lexicons/com/atproto/repo/createRecord.json:14)).

   **Fix:** resolve every `repo` at-identifier to its canonical DID before lookup and compare that DID with `sub`; cover handles on authenticated mutations and unauthenticated reads.

6. **`publicMeta` is validated but never applied to the initial policy.**

   Creation defaults `publicMeta` to `true` ([plan:205](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:205)), but bootstrap lists only meta grants and never writes `publicRead` ([plan:208](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:208)). The upstream policy default is `false` ([policy.json:10](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/lexicons/group/opensocial/policy.json:10)).

   **Fix:** persist the option in the creation journal and write `meta/self.publicRead = publicMeta` atomically. Test omitted/default-true, explicit false, and crash-resume cases.

7. **Deleting `new.flock.workspace/self` bypasses app-tombstone parity.**

   The workspace contains all app-install tombstones ([plan:68](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:68)), yet `deleteSpace` protects only `meta/self` and `members/self` ([plan:143](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:143)). After deleting the containing space, the host retains `known_app_subject`, while clients derive that set solely from install records ([plan:283](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:283)). Host and client can then disagree about which memberships are human.

   **Fix:** make `new.flock.workspace/self` a protected core space, or prohibit its deletion whenever the durable ledger is nonempty and provide an authoritative ledger surface to clients. Test deletion and recreation attempts with inactive tombstones.

8. **The purported 30-table purge manifest contains 35 tables.**

   The explicit list at [plan:184](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:184) contains 35 names, while both the prose and acceptance gate require scanning “all 30” ([plan:318](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:318)). This leaves the zero-residue acceptance test underdetermined.

   **Fix:** define one exported purge-manifest constant with the correct count, classify every schema table as group-purged, intentionally retained, or global/TTL, and have a schema-introspection test fail whenever an unclassified table appears.

## Low

1. **The suite universe omits nonstandard test runners.**

   The canonical manifest walks only `*.test.ts` and `*.spec.ts`, while `sync-budget.ts` and `browser/sync-budget.ts` are executable test suites outside that universe ([plan:303](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:303), [plan:320](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:320)). The Round 7 universe defect is resolved for conventional suites, but not for these special runners.

   **Fix:** explicitly classify these two files and assert bidirectional package-script-to-file coverage.

2. **`appRoleKey` overstates its entropy guarantee.**

   A SHA-256 digest has 256 bits, not 260, and collision resistance is not literally zero ([plan:110](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:110)).

   **Fix:** describe it as a full 256-bit SHA-256 digest encoded in 52 base32 characters, with no additional truncation-induced collisions.

VERDICT: REVISE