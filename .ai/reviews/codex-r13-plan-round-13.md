Rev 13 is not ready to execute: **0 Blocker, 5 High, 3 Medium, 1 Low**.

The requested revisions match exactly:

- OpenSocial proposal: `8df0cc82eb7708f090aa43522adf1d3ada3ed7e7`
- Spaces: `6747610566eee1b6d743617bd8eb1136adccb362`, including only the two plan-declared credential modifications with matching hashes
- Target: `5ae1b7ca2522ab20b35b89ed2e471fc9b79f4575`
- Rev 13 SHA-256: `e1ebc44822d2a76352398aab48859c6e1cbf0e335dd60f469f40838b871ff8e2`
- Round 12 review SHA-256: `a55b7d3532b2a603a4798eef436aa8cdf83ca0bf94dfc857face1398a0276593`

This was a static, read-only review. No files were modified and no tests or builds were run.

## High

1. **The mandatory migration ticket breaks standard OpenSocial account-migration interoperability.**  
   OpenSocial requires the standard account migration flow ([proposal](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/proposal.md:161)); the pinned `createAccount` contract accepts standard JSON without a proprietary ticket ([lexicon](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/lexicons/com/atproto/server/createAccount.json:8)). Rev 13 instead requires Flock’s `/group-admin/migration-info`, source preparation, and `X-Group-Migration-Ticket`, rejecting standard requests with `MigrationTicketRequired` ([plan](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:131), [target requirement](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:138)). A compliant non-Flock OpenSocial host therefore cannot migrate to this target. Preserve a standard path or formally version and negotiate the extension.

2. **The complete migration manifest cannot safely be transported in an HTTP header.**  
   The ticket embeds every blob CID and every space’s URI/digests, then carries the JWT in `X-Group-Migration-Ticket` ([manifest](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:131), [header](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:138)). There is no serialized-size or count bound, while the declared envelope supports 100 channels plus blobs ([envelope](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:115)). The available Node runtime reports a 16,384-byte aggregate header limit; sufficiently large valid manifests will receive `431` before the handler executes. Keep only operation/source/target/digest claims in the ticket and transfer the bounded manifest in a body or authenticated fetch.

3. **Prepared abort does not revoke target staging or complete cross-operation binding.**  
   A prepared abort deletes only the source lease; it does not revoke the already-issued ticket or call the target abort endpoint ([plan](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:131)). The target session remains unique by group for up to two hours ([target session](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:138)), while source signing checks only the newly prepared target endpoint and current roots—not a target attestation carrying the target session’s `operationId`, digest, and generated keys ([signing](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:143)). A stale operation can block a retry or cross into a later same-target attempt when roots are unchanged. Abort must synchronously revoke/purge target state, and signing must consume a target-signed operation binding. Align the 30-minute source and two-hour target deadlines.

4. **An uninstalled app can rejoin as an ordinary member and bypass app revocation.**  
   Uninstall deliberately retains `known_app_subject` while removing membership and marking the install inactive ([app lifecycle](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:110)). The app-principal rejection occurs only when a membership already exists ([Case A](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:249)); invite, open, approval, and generic membership-write paths lack the same guard ([Cases B–E](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:250), [generic writes](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:153)). Enforce `known_app_subject ⇒ active install with the designated app role` atomically across every membership creation/import/approval path.

5. **`membership/<groupDid>` can bypass `LastAdmin` and strand the group.**  
   Upstream makes the group DID an implicit full member without membership or acceptance records ([proposal](/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/proposal.md:44)). Rev 13 permits generic/imported membership keys, while `effectiveHumanAdmins` excludes only known apps—not `groupDid` ([writes](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:152), [admin projection](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:230)). An admin-capable `membership/<groupDid>` can therefore count as human, allowing removal of the final actual human without triggering `LastAdmin` or the sole-member recovery path ([leave rule](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:237)). Reserve the group DID across writes, imports, app installs and activation validation, and unconditionally exclude it from human projections.

## Medium

1. **The supposedly exhaustive `requestJoin` table has an undefined path and a non-global quota.**  
   Case A defines only the already-member-with-invite branch; already-human/no-invite and invalid-invite outcomes are absent ([plan](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:249)). The 50-row quota applies only to approval Case E, although invite/open cases also create admitted operation rows ([Cases B/C](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:250), [quota](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:257)). Define every terminal outcome and enforce quota/expiry before every fresh operation-row insertion.

2. **Inbound space-credential verification is weaker than the pinned contract.**  
   Rev 13 lists type, subject, expiration, revocation, audience and signature checks ([plan](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:156)), but does not require finite `iat/exp`, `exp > iat`, the one-hour maximum lifetime, valid `cnf.kid`/`jti`, or the five-second future-issuance bound enforced by the pin ([parsing](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/space/src/credential.ts:241), [time checks](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/space/src/credential.ts:292)). Mandate the pinned verifier or enumerate these checks and negative tests.

3. **Bulk-write and import resource envelopes are underspecified.**  
   The pin caps `applyWrites` at 200 operations and 1 MB with per-operation rate points ([pin](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/api/com/atproto/space/applyWrites.ts:19)), preserves authority-published collections during `clearRecords` ([pin](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/api/com/atproto/space/clearRecords.ts:38)), and applies `maxImportSize` before reading STAR archives ([repo import](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/api/com/atproto/space/importRepo.ts:9), [meta import](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/api/com/atproto/space/importSpaceMeta.ts:13)). Rev 13’s corresponding routes do not preserve those exact bounds/semantics ([plan](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:151)). Adopt the pinned limits or specify equally strict replacements.

## Low

1. **Third-party legacy membership incarnation remains cross-host unstable.**  
   Records without embedded `"new.flock.incarnation"` receive a new target-side UUID on migration, preserving only same-host occurrence identity ([plan](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:234)).

## Round 12 finding verification

| Round 12 finding | Rev 13 disposition |
|---|---|
| 1. Target operation/manifest binding | **Partial** — target-side digest equality was added, but High 3 leaves abort and cross-operation binding incomplete. |
| 2. Signed PLC operation survives abort | **Resolved** by head advancement before deleting a `plc_signed` lease. |
| 3. Post-activation source remains readable | **Resolved** by cutover blocking, target finalizer, retry outbox and PLC watcher. |
| 4. `deactivateAccount` TOCTOU | **Resolved** by locked transactional admin revalidation. |
| 5. Demoted actor strands journal | **Resolved in plan** by zero-step abort and audited alternate-admin takeover ([plan](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:37)). |
| 6. K2/K5 excluded or unsatisfiable | **Resolved in plan**: all three suites are explicitly assigned adaptation to non-mutating in-place execution ([Wave 6](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:340)). Current files remain copy-in Jest suites, so runtime proof awaits implementation. |
| 7. Numeric suites not mandatory | **Resolved** by mandatory Commands 5a–5d ([gates](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:350)). |
| 8. Acceptance-deletion crash loses rejoin | **Resolved** by the explicit post-delete reconciliation phase ([plan](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:290)). |
| 9. Legacy incarnation migration instability | **Unresolved — Low 1.** |
| 10. `.ai/upstream/**` omitted | **Resolved** by the explicit Wave 6 sweep ([plan](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial/.ai/plans/r13-opensocial-groups.md:340)). |

VERDICT: REVISE

