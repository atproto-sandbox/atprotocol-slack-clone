Rev 7 is not ready. The three checkouts match the requested pins, and the raw Spaces porcelain output matches [plan line 8](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:8) byte-for-byte.

Several Round 6 corrections are now sound: `discoverCore()`, `cidForLex`, explicit root script wiring, 198-second DPoP retention/index/pruning, server-side join-request deletion, the non-roster bot contract, and revocation of existing OAuth sessions/refresh/access tokens. The deletion journal, app classification, leave generation, and terminal joining corrections remain incomplete as detailed below.

## Blocker

None.

## High

1. **The standard ATProto route lexicon/type closure is missing.**

   Rev 7 vendors the 27 OpenSocial files plus only three referenced ATProto schemas ([plan:48](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:48), [plan:55](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:55)), yet the Group Host implements many `server`, `identity`, `sync`, and `repo` methods beginning at [plan:122](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:122). Neither the declared dependencies at [plan:116](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:116) nor the current codegen inputs at [codegen-lex.mjs:41](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/scripts/codegen-lex.mjs:41) provide those schemas.

   **Fix:** vendor and pin the complete transitive lexicon closure for every implemented standard route, or declare an exact compatible `@atproto/api` dependency and its runtime lexicon registration source. Add a manifest proving every route in the matrix has exactly one registered schema and generated API type.

2. **The Round 6 transactional deletion authorization requirement is still contradicted by the detailed algorithm.**

   [Plan:132](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:132) promises a transactional `actorDid ∈ effectiveHumanAdmins` check on both endpoints. But [plan:173](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:173) performs the check before awaited PLC I/O, while its enumerated `IMMEDIATE` transaction consumes the token without rechecking the actor. `requestAccountDelete` also has no specified token mint/delivery transaction, and `group_action_token` has no specified actor, purpose, hash, or expiry schema at [plan:168](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:168). The pinned implementation uses a purpose-specific `delete_account` token ([requestAccountDelete.ts:56](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/api/com/atproto/server/requestAccountDelete.ts:56)). Gate 5 tests only `deleteAccount`, not `requestAccountDelete` ([plan:309](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:309)).

   **Fix:** store a hashed, single-use `{groupDid, actorDid, purpose:"delete_account", expiresAt}` token. Transactionally re-evaluate the effective-human-admin predicate when issuing it and again inside the deletion `IMMEDIATE` transaction after PLC precomputation. Test status-manage-only refusal on both endpoints, token cross-purpose/cross-actor use, and demotion between request and consumption.

3. **The PLC deletion state machine can be permanently stranded by a newer operation.**

   Tombstone signing samples `/log/last` once at [plan:173](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:173), while the independently exposed PLC submission path remains available at [plan:133](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:133). If another valid operation lands first, the stored tombstone has a stale `prev`. Reconciliation at [plan:174](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:174) handles only an existing tombstone or `404`, so it retries the invalid operation forever. The algorithm also fails to define an abort when the latest non-tombstone operation is no longer locally authoritative.

   **Fix:** serialize all PLC submissions and deletion per DID. On conflict, refetch `/log/last`, revalidate local authority, re-sign against the new CID, and transactionally replace the journaled tombstone. Refuse deletion explicitly if authority has moved.

4. **`purged` retains cryptographic keys and substantial account state.**

   `group_creation_journal` contains encrypted signing, KEM, and rotation keys ([plan:165](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:165), [plan:202](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:202)). The purge list at [plan:175](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:175) omits that table, `public_record_blob`, `space_record_blob`, `space_writer`, credentials, action tokens, pending OAuth/PAR/code/upstream state, replay tables, and invite-delivery rows. No foreign-key cascade contract is declared, yet the journal is subsequently called `purged` at [plan:176](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:176).

   **Fix:** define an exhaustive per-group purge manifest or explicit foreign keys with tested cascades. Retain only the deletion journal and self-contained terminal outbox rows, erase all key material and authorization artifacts, and assert zero residual rows in every group-keyed table.

5. **`knownAppSubjects` is current-record-derived, not “ever-recorded.”**

   Both definitions scan extant install records ([plan:107](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:107), [plan:230](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:230)). The direct-write guard permits deletion once the app membership has been removed ([plan:227](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:227)), and the schema has no durable app-subject ledger ([plan:168](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:168)). An admin can therefore uninstall, delete the inactive record, recreate the bot DID as an admin-capable “human,” and let the final real human leave.

   **Fix:** make inactive install tombstones non-deletable, or maintain a transactional, non-prunable `known_app_subject` ledger populated before any install membership is created. Use it in every `LastAdmin`, summary, activation, deletion, and recovery check.

6. **The leave guard is neither monotonic nor atomic.**

   [Plan:265–267](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:265) compares independently authored wall-clock timestamps and then performs an unconditional `leaveGroup`. Clock skew, equal-millisecond timestamps, or a rejoin between preflight and RPC can delete a newer membership. Upstream membership and acceptance contain only caller-supplied datetimes ([membership.json:22](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/lexicons/group/opensocial/membership.json:22), [acceptance.json:13](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/lexicons/group/opensocial/acceptance.json:13)), while `leaveGroup` carries no expected generation ([leaveGroup.json:8](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/lexicons/group/opensocial/leaveGroup.json:8)). Tolerating `403` when deleting acceptance can also leave a stale acceptance while removing membership.

   **Fix:** journal the membership/acceptance CIDs or a host-issued monotonic generation, transmit the expected membership generation in a signed extension claim or companion RPC, and compare-and-delete atomically on the Group Host. Treat acceptance `403` as a durable blocked cleanup state rather than success.

7. **Terminal join denial/cancellation is not observable or idempotent.**

   The plan records only a short-lived server tombstone ([plan:244](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:244)) and claims that the client can detect “request no longer open / denied” at [plan:270](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:270). But pending requests are visible only through the group-admin method ([proposal.md:224](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/proposal.md:224), [plan:150](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:150)), and `requestJoin` has no operation ID ([requestJoin.json:12](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/lexicons/group/opensocial/requestJoin.json:12)). A lost response leaves the client at `started`; after moderator denial, its replay can recreate the request.

   **Fix:** add a member-authenticated status/idempotency extension keyed by a durable operation ID or generation. Persist terminal denial/cancellation until client acknowledgement, and make `requestJoin` for that operation return the terminal result rather than upserting a new request.

8. **Admission has no durable acceptance-completion phase.**

   Group creation commits creator membership without creator acceptance ([plan:204–209](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:204)). For response-lost open/invite admission, [plan:269](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:269) merely avoids replay when membership exists; only the `pending_approval` branch writes acceptance ([plan:270](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:270)). Discovery then skips candidates lacking acceptance ([plan:271](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:271)), contrary to upstream’s bidirectional membership model ([proposal.md:44](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/proposal.md:44)).

   **Fix:** use durable `membership_verified → acceptance_pending → discovery_verified → completed` phases for create, open, invite, and approval admissions. A replay that discovers membership must advance to acceptance creation, not silently stop.

9. **Deactivation/deletion revocation stops at local OAuth state.**

   Existing OAuth sessions are now correctly revoked at [plan:131](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:131), but pending `oauth_par`/`oauth_code` grants and issued space credentials remain in the schema ([plan:168](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:168)). Space credentials live for ten minutes ([plan:219](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:219)); a member PDS checks its local revoked-JTI table, not the remote group’s activation state ([auth-verifier.ts:451](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/auth-verifier.ts:451)). Although the revocation route exists at [plan:148](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:148), it is not integrated into deactivation, sole-member leave, or deletion.

   **Fix:** invalidate pending PAR/codes with an account authorization epoch, and durably fan out every unexpired issued credential JTI through `notifyCredentialsRevoked` on all three transitions. For permanent deletion, pre-sign/materialize revocation notices or retain the signing key until that outbox is terminal.

## Medium

1. **The app role’s policy grants do not satisfy `appGrantScopes`.**

   Installation grants only channel and app-inbox access at [plan:107](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:107), while `appGrantScopes` requires reads of meta, members, and workspace at [plan:260](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:260). OpenSocial makes each space policy’s grants authoritative ([proposal.md:52](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/proposal.md:52)). If those missing grants are added implicitly, uninstall’s stated ordering will hit `RoleInUse` ([plan:226](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:226)).

   **Fix:** enumerate every app-role policy grant during install/update, remove all grants before membership and role during uninstall, and define a collision-resistant role key instead of unspecified `app-<shortHash>`.

2. **Deletion notices do not supersede every older pending notice.**

   [Plan:175](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:175) and [plan:179](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:179) replace only queued `#registrationExpired`. Older `repoWrite` or `repoRemoved` notices can therefore be delivered after `#spaceDeleted`. The pinned implementation makes deletion replace whatever is pending ([space-notifications.ts:180](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/space-notifications.ts:180)).

   **Fix:** use one recipient/space coalescing key and atomically replace or cancel every older notice when queuing deletion.

3. **The leave terminal-error status is wrong.**

   [Plan:267](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:267) expects `404 GroupNotFound (RepoNotFound)`. The pinned stack maps `InvalidRequest` to HTTP 400 ([types.ts:35](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/xrpc/src/types.ts:35)) and throws `RepoNotFound` through `InvalidRequestError` ([util.ts:145](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/api/com/atproto/space/util.ts:145)). Matching HTTP 404 can strand the journal.

   **Fix:** classify terminality by typed XRPC error name, independently of HTTP status, and clear only after authoritative membership/group absence.

4. **The suite-manifest completeness assertion has no defined universe.**

   [Plan:295](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:295) and [plan:303](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:303) require “1-to-1 script coverage,” but do not define discovery roots, exclusions, or classification rules. A newly added acceptance/browser/performance suite can be omitted while the manifest still passes.

   **Fix:** define canonical suite globs and exclusions, then assert every discovered suite belongs to exactly one named root script and every script entry resolves to one discovered file.

## Low

None beyond the issues above.

This was a static, read-only review; no files were edited or tests executed.

VERDICT: REVISE