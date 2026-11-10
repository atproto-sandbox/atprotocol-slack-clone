# Implementation Plan: atproto Slack

Status: core app implementation, scoped OAuth metadata and returning-workspace reauthorization, patched pinned PDS conformance, real independent-app browser acceptance, a 52-case two-PDS lifecycle recovery matrix, and the reaction-complete supported-size workload are complete. Both readers probe beyond the reaction cap to distinguish an exact-cap history from actual overflow; the post-fix 2026-09-26 workload passed with exact latest-page parity. Typecheck, lint, and all 67 app unit tests pass after the fix. Earlier low-disk attempts and their cleanup are recorded below. Production deployment and limited-workspace pilot evidence remain pending.
Source: [atproto Slack PRD](./atproto-slack-clone.md)
Date: 2026-09-26

## Goal

Build a small, interoperable Slack-style workspace on atproto spaces. PDS member lists enforce read access; shared records define workspace/channel state; a workspace authority operator performs serialized administrative changes. Do not begin feature work until a compatible PDS implementation and exact lexicon/API revision pass Phase 0.

## Execution assumptions

- Build Slack in this dedicated `atproto-slack-clone` Git checkout. Use Bulletin only as a reference for OAuth, space credentials, lexicon code generation, multi-PDS development, and incremental sync. Do not add Slack product code to the Bulletin app.
- Keep the PRD and plan in this checkout with the app so the implementation and its acceptance criteria stay together.
- Target proposal 0016's split read/write semantics. Pin one atproto/PDS commit and generated lexicons before coding. Proposal 0016 and its implementation are drafts; an API-name mapping is not sufficient evidence by itself.
- The workspace owner provisions a dedicated DID and the authority operator's workspace-DID session with `manage=update` and the required record operations. The operator authenticates human admins separately and treats the PDS membership state as authoritative.
- The initial launch envelope is 200 members, 100 channels, 20,000 message records per channel, and 20,000 reaction records per channel. Attachment/blob handling is out of scope.
- Execute the phases in this document, preserving unrelated workspace and checkout state.

## Phase 0 — Pin and prove the protocol

**Purpose:** Resolve the only external dependency capable of invalidating the product model before building on it.

1. Select and pin a compatible atproto/PDS commit, its space lexicons, OAuth scopes implementation, and multi-PDS test environment. Record commit SHAs and setup commands in the app checkout.
2. Map proposal operations to the pinned implementation, including space create/update, member read/write state (`putMember` or equivalent), removal, `listMembers`, credential minting, record create/update/delete, writer-set enumeration, and account-level space discovery.
3. Prove workspace and channel member-list policies with independent read/write booleans, including the authority DID's own access and the owner's initial admin membership.
4. Prove the inbox configuration: ordinary workspace member has `read=false, write=true`; admin and workspace authority have `read=true, write=true`. A requester can write a request to their own PDS; `listRepos` exposes that repo to an inbox reader; requester and ordinary member cannot obtain an inbox read credential or fetch another request repo.
5. Prove that workspace acceptance markers make the workspace discoverable from a second app. Simulate both a dropped app notification (recovered from `listRepos`) and a dropped PDS-to-authority `notifyWrite` (absent from `listRepos`, recovered by an owner-authorized `listMembers` candidate sweep and a direct record read using an admin inbox credential). Prove that removing membership blocks new credential minting and the signed credential lifetime claim is capped at one hour, the protocol ceiling. Record and test any verifier clock-skew acceptance after `exp` against the product's exact cutoff requirement.
6. Prove the workspace DID OAuth session can perform management calls and authority-authored writes, and that a user admin record alone cannot grant protocol management access.
7. Define a stable authority-operator request contract that another app can call for admin actions, operation lookup, and inbox-writer candidate recovery. Authenticate each call with a PDS-issued service-auth JWT, derive the actor only from verified `iss`, recheck current authority records and memberships, serialize journaled operations, and list exact scopes. Pin stable-key/hash encoding in a short protocol note and generate the lexicon/client artifacts.

**Exit gate:** A multi-PDS conformance run passes every proof above; the exact commit, APIs, lexicon hashes, OAuth scopes, and failure recovery paths are documented; generated protocol artifacts exist; the authority operator has a concrete authenticated request contract. A `listRepos` sweep alone is not accepted as recovery for a writer that never reached the authority PDS's writer set. If the inbox cannot support read-only admins and write-only workspace members with member-list policies, stop and revise the PRD before feature work. Do not replace the PDS read gate with app-database checks.

## Phase 1 — App foundation and authority records

1. Create the separate app checkout and establish build, lint, typecheck, deployment configuration, and the pinned PDS development environment.
2. Publish and generate `new.flock.*` lexicons and space-type permission sets. Define validators for stable record keys, request generations, same-channel reply references, message length, and authority authorship.
3. Implement OAuth login, narrowly scoped member permissions, space credential acquisition/renewal, and shared repo sync primitives. Keep user OAuth sessions, workspace authority sessions, and space credentials separate.
4. Implement the authority operator's authenticated admin request contract, operation lookup, and `listInboxWriters` recovery method. Persist only an operation journal and audit events; never use its database as the current membership or role source. The recovery method returns writer DIDs only; the admin client reads request records using its own inbox credential.
5. Implement canonical upsert/read helpers for the directory, workspace roster, admin state, private roster, join requests, and decisions. Stable keys use the PRD's exact hash encoding.

**Acceptance:** Two PDS accounts can create and read the protocol records. A record with an invalid schema, wrong authority author, noncanonical key, or cross-channel target is rejected or ignored as specified. Initial login asks for the read-self workspace discovery permission required by `listSpaces`; later OAuth consent asks only for operations needed by the current user action.

## Phase 2 — Workspace setup, invitations, and public channels

1. Create the workspace DID's workspace and inbox spaces with the pinned policies. Ensure the authority and owner have the required member-list entries; the owner becomes the first active admin.
2. Invite a DID through the authority operator. Apply workspace `read=true/write=true`, inbox `read=false/write=true`, and public-channel `read=true/write=true` membership before reporting invite completion. Write the workspace roster and send the workspace URI to the invitee. Membership begins on invite; acceptance is the recipient's later discovery marker.
3. Let the invitee write the workspace acceptance marker. Discover the workspace on a second account session using the account's spaces index, then read its directory and roster.
4. Create public channel spaces. Add all current workspace members with read/write membership before publishing the directory record as public.
5. Implement channel listing, private-name display, and member/channel navigation.

**Acceptance:** Adding a workspace member updates workspace, inbox, and all public channel member lists before the invite is reported complete. A forwarded workspace URI gives no access to a DID absent from the member list. A second app discovers the invited-and-accepted workspace and renders the same directory and roster. Removal fan-out is accepted in Phase 5.

## Phase 3 — Public-channel messages and sync

1. Implement text message create/edit/delete, one-level replies to top-level messages in the same channel, and per-user emoji reactions.
2. Restrict edits/deletes to the record author in the UI and validate all records when syncing.
3. Sync repos from `listRepos`, retain each repo revision, use notifications for prompt updates, and sweep at least once per minute. The inbox sync unions `listRepos` with `listInboxWriters` so it also recovers a writer whose PDS-to-authority notification was lost.
4. Page history and show the latest 100 messages first. Do not fetch every workspace channel when a user opens one channel. Scan reactions independently under the 20,000-record channel cap.

**Acceptance:** Two independent clients show the same public-channel messages and reactions. PDS-returned canonical space-record URIs round-trip as reply parents and reaction subjects. A user can create/update/delete only their own records through the app. A dropped notification is repaired on the next sweep. A reply referencing another channel or a nested reply is ignored. Text above 10,000 Unicode code points is rejected.

## Phase 4 — Private-channel requests and approvals

1. Add a private channel for selected members only, with a current authority-authored roster record for each active member.
2. Implement stable-key request upsert with a fresh TID `requestId` per submission, requester withdrawal/deletion, and stale-request grouping.
3. Sync the inbox only with an admin credential. Reconcile `listRepos` and `listInboxWriters` at least once per minute; fetch request repos only as an authorized inbox reader.
4. Implement admin approve/deny. Approval performs channel membership, roster, and matching-generation decision writes as one journaled operation. Denial writes only the decision. Expose pending/error status until the operation reaches its required state.
5. Give an approved requester channel credentials and render the full active private roster, including members with no messages.

**Acceptance:** Requester can read only their own request; ordinary members cannot mint inbox credentials or read request repos; admins can recover a request after a dropped notification; PDS-returned canonical join-request URIs identify the same request and decision across clients; stale decisions do not approve a resubmitted request; denied users receive no channel membership; approved users see the same messages and roster in two apps.

## Phase 5 — Membership, admin, privacy-transition, and archive lifecycle

1. Implement promotion/demotion with inbox read-membership updates. Enforce the invariant that at least one active admin remains.
2. Implement workspace and private-channel self-leave, plus admin removal. Removal updates all applicable channel and inbox memberships, workspace roster, private rosters, and admin state through the serialized operator.
3. Implement public-to-private and private-to-public transitions. Publish `transitioning` first, reconcile the selected desired membership, then publish the final visibility. Clients stop new syncs while transitioning.
4. Implement archive by transitioning, removing channel members, and publishing archived. Keep message records in member repos.
5. Add bounded retries for transient PDS/network failures, restart recovery, per-workspace serialization, pending/failed status, and periodic reconciliation between directory/roster state and PDS member lists. Retry at most four total attempts with 100/200/400 ms delays, and persist `pending` after the bound; do not retry authorization, validation, or other permanent failures.

**Acceptance:** Every injected failure at each mutation step leaves an honest pending/transitioning state and converges after restart. New credentials fail after removal; an existing credential is usable only through its expiration. Public-to-private preserves the same URI and messages. Public membership follows workspace membership. Last-admin removal/leave/demotion is rejected. Archived channels do not issue new credentials.

## Phase 6 — Independent-app conformance, security, and launch

1. Build a small independent reader/conformance client that uses only published lexicons, OAuth, and space credentials; it must not read the first app's database or private cache.
2. Exercise the acceptance matrix from the PRD across at least two PDS hosts, including wrong-author records, absent members, inbox read/write separation, expired credentials, missed notifications, and partial operator failures.
3. Verify the 200-member/100-channel/20,000-message/20,000-reaction-record envelope, latest-100 initial rendering with matching reactions in both readers, 60-second writer-set recovery, and five-minute stalled-operation alert.
4. Review secrets handling, authority session encryption, OAuth scopes, audit events, plaintext exposure, cache purge after credential renewal fails, HTTPS, and backup/recovery of the operator journal.
5. Complete the deployment preflight and limited-workspace pilot in [operations](../operations.md#deployment-and-limited-pilot). Provide operators a pause switch for admin mutations, status view for pending operations, and recovery instructions. Record the deployed app and PDS revisions and pilot evidence. Expand only after the pilot acceptance criteria pass.

**Launch gate:** All PRD acceptance criteria pass against the pinned protocol revision; the independent reader agrees with the primary app; no app-database ACL is required for read access; operational recovery and credential expiry behavior are demonstrated. Record protocol drift as a release blocker.

**Deployment state:** Pending. The repository does not identify a hosting target, public domain, production PDS deployment, external alert destination, or pilot cohort. Do not treat local acceptance as deployment or pilot evidence. Resolve these inputs and complete the checklist in `docs/operations.md` before marking Phase 6 complete.

## Dependency order

`Phase 0 → Phase 1 → Phase 2 → Phase 3 and Phase 4 → Phase 5 → Phase 6`

Phase 3 and Phase 4 can proceed in parallel after Phase 2's channel and sync foundation is complete. Phase 5 depends on both because it reconciles message-bearing spaces and private-channel membership. Phase 6 depends on every product flow.

## Risks and responses

| Risk | Response |
|---|---|
| PDS API or policy semantics change while proposal 0016 is still draft | Pin a commit in Phase 0, hide API names behind a small adapter, and block release on conformance drift. |
| Workspace authority credential is compromised | Encrypt it at rest, limit scopes, separate operator auth from member OAuth, audit each mutation, and support credential rotation. |
| A multi-space update partially fails | Serialize by workspace/channel, journal desired state and completed steps, keep the UI pending/transitioning, and reconcile from PDS state after restart. |
| A revoked reader keeps an old credential or downloaded data | Stop compliant sync at transition/removal; document the ten-minute default token window (the protocol ceiling is one hour) and the impossibility of erasing prior copies. |
| Users grant broader OAuth scopes or write nonconforming records | Keep read access PDS-enforced, validate author and schema in every app, and ignore invalid records. |
| App notifications are lost or a PDS-to-authority writer notification is lost | Persist last revisions and sweep `listRepos` plus owner-authorized inbox writer candidates at least once per minute; retry transient errors and alert on five minutes of stalled operations. |
| Workspace/channel count or message/reaction history exceeds v1 envelope | Page per channel, load latest 100 first, expose degraded state, and do not silently truncate. |

## PRD traceability

| PRD requirement | Plan phase |
|---|---|
| Split policy behavior, inbox write-only membership, credential/revoke semantics | 0, 4, 5 |
| Workspace DID, roles, invite/discovery, authority records | 1, 2, 5 |
| Public channel records and cross-app consistency | 2, 3, 6 |
| Private requests, approvals, decisions, and hidden roster | 4, 6 |
| Member leave/removal and public/private fan-out | 5 |
| Transition, archive, recovery, and data retention | 5, 6 |
| Security, performance envelope, and launch acceptance | 6 |

## Readiness

Core app flows and operator tooling are implemented. The current source checks on Node 22.17.0 pass: 67 unit tests, typecheck, lint, production build, the browser OAuth acceptance, and the two-PDS app and reconciliation acceptance, including independent-reader reaction parity. The dependency audit reports zero advisories after the 2026-09-25 security update. Six pinned PDS conformance suites passed with the checked-in strict-expiry overlay: 108 tests passed and one upstream todo remains; the separate `@atproto/space` suite passed 101 tests. App lexicons were generated and validated against pinned base commit `787a730fcd22ed7791e2636beb509a943017ba1c` (the pin has since moved to `619c6e85`; see the pin note).

The checked-in Playwright acceptance uses real Chromium, the pinned PDS, and two separate production Next processes with isolated databases. It completes browser OAuth authorization-code callbacks for two DIDs, owner bootstrap and invitation, invitation acceptance and workspace discovery in the independent app, public-channel read and post, private-channel request, denial, resubmission with a distinct request generation, approval, private-channel read and post, and a 390px mobile overflow check. The expected PDS denials before narrower grants are exercised as part of the flow. Both app processes use the same checked-in build; the separate reader path is implemented in-repo and shares record validation and selection helpers. This demonstrates independent app instances and cross-account PDS reads, not interoperability with a separately authored external client. This is local two-app acceptance, not a production pilot.

The two-PDS backend acceptance passes against the pinned base plus the strict-expiry overlay. It covers cross-host discovery and reads, latest-100 paging, inbox read/write separation, recovery of a dropped PDS-to-authority writer notification from owner-authorized membership candidates, denial/resubmission generations, approval, private-roster access, credential revocation and removal behavior, cache and cursor purging, and recovery from a restored SQLite backup. Its lifecycle matrix injects four transient failures at 52 mutation boundaries: invite (4), removal (7), admin changes (4), channel creation (4), visibility transition (7), archive (4), join decisions (4), workspace self-leave (5), private-channel leave (2), and reconciliation (11). Each operation resumes in a fresh subprocess and reaches verified PDS state. These backend tests use OAuthSession adapters where noted and do not replace browser or pilot acceptance.

Record, member, workspace, and channel-writer scans have finite page/request limits and reject oversized or non-advancing PDS responses. Workspace discovery scans at most 1,000 workspace spaces with eight concurrent summary reads. Workspace and independent-reader summaries expose degradation; incomplete summaries disable operator changes and inbox recovery. The web API and direct operator XRPC paths enforce the same envelope check for mutations and inbox-writer recovery, returning 409 while keeping bounded read-only operation lookup available. Journal workspace discovery uses an indexed catalog; stalled and recoverable-operation scans use SQL-side limits and surface overflow. Channel creation and visibility transitions also require the active workspace roster to match current PDS read/write membership; mismatches stop the operation before channel changes.

The strict-expiry overlay sets zero expiration skew for space credentials only; delegation tokens and client attestations retain the five-second allowance. Tests reject a space credential at `exp` in unit coverage and at `exp + 2s` on both PDS hosts. The signed default credential lifetime is 600 seconds with a 3,600 second ceiling (it was 7,200 seconds before the move to `5b95b2f2`). The unmodified pinned upstream commit still accepts a credential five seconds after `exp`, so production must deploy the overlay or an equivalent upstream fix.

The workload harness provisions 200 logical members on two PDSes, creates 100 channels, writes 20,000 messages and 20,000 reactions per channel, scans all 199 inbox writer candidates, and checks exact latest-100 message and reaction equality through the independent and primary readers. It also asserts that the exact-cap reaction history is not degraded. The passing 2026-09-25 run covered 2,000,000 messages, inbox recovery, and message-page parity, but it seeded no reaction records; it is not evidence for the reaction cap or reaction parity. That message-only run measured account provisioning 6.181 s, direct membership setup 76.139 s, journaled invite 1.330 s, journaled channel creation 2.544 s, private request write 0.039 s, message writes 932.315 s, inbox writer reconciliation and candidate-repo reads 1.721 s, independent latest-100 read 1.936 s, primary latest-100 read 5.197 s, public-to-private transition 2.806 s, and archive 2.741 s.

A 2026-09-26 reaction-complete run wrote all 2,000,000 messages and reactions. The independent reader returned 100 reactions for the latest page but marked exactly 20,000 scanned records degraded; the test failed at that assertion, before primary-reader checks, parity, or the final report. The cause was the pinned PDS returning a continuation cursor for a full final page even when it had no next record. Both readers now probe one record beyond the cap to distinguish an exact limit from overflow. Typecheck, focused lint, and all 67 app unit tests pass after this fix.

The post-fix retry wrote all messages and 400,000 reactions across 20 channels, then was interrupted when available space reached 8.2 GiB. Its isolated root remained after interruption; it was removed after confirming the PDS processes had exited and `lsof` found no open handles. A prior 2026-09-26 reaction attempt stopped after 400,000 messages across 20 channels when free space fell to 776 MiB, before any reactions or reader comparison. An earlier `SQLITE_IOERR_SHMSIZE` attempt stopped during PDS startup before workload measurements. Normal completion closes both PDSes and removes the isolated temporary root. These are local fixture observations, not PRD latency targets or production SLOs; the fixture disables the PDS rate-limit bucket.

The subsequent post-fix `pnpm test:performance` run passed on Node 22.17.0. It wrote 2,000,000 messages and 2,000,000 reactions across 200 logical members, two PDSes, and 100 channels; verified all 199 inbox-writer candidates; and passed exact latest-100 message and reaction checks through both readers, including non-degraded exact-cap scanning and reader parity. The report measured account provisioning 5.474 s, direct membership setup 78.314 s, journaled invite 1.350 s, journaled channel creation 3.449 s, public-to-private transition 4.320 s, private-channel archive 3.055 s, message writes 767.123 s, reaction writes 707.621 s, private request write 0.034 s, inbox writer reconciliation 1.588 s, independent latest-100 read 15.477 s, and primary latest-100 read 43.543 s; the test completed in 1,642.119 s. Available space was 249 GiB at start, remained at least 243 GiB during the run, and returned to 251 GiB after normal fixture cleanup. No `slack-performance-fixture-*` roots remained afterward. These timings are local fixture observations, not latency targets or production SLOs.

The backup drill restores an online SQLite backup to a separate path, checks both databases with `integrity_check`, resumes a pending operation in a new process, rediscovers the workspace, and reconciles membership. The recovered Node OAuth session is PDS-issued, DPoP-bound, encrypted at rest, and restored with its encryption key supplied separately. Scheduled reconciliation reports stalled operations before the pause switch and fails visibly when required authority access is unavailable; it should run every minute. The external alert destination remains deployment-specific. No production deployment, live operator credential provisioning, external alert destination, or limited-workspace pilot was performed. The launch gate therefore remains pending; recheck the pinned protocol revision for drift before release.

The 2026-09-25 source security review upgraded the vulnerable Next.js dependency set, added global browser security headers, bound channel-cache AES-GCM ciphertext to its account/space/repo/collection/rkey/URI row context, and added a migration that purges legacy unbound ciphertext and paging cursors. Backups now use exclusive owner-only file creation on POSIX systems. Focused tests, typecheck, and the production build pass; `pnpm audit` reports zero advisories. Production TLS termination, egress firewall policy, encrypted backup storage, external alert delivery, live operator credentials, and pilot acceptance still require deployment-specific proof.

Application request JSON is read as a bounded stream: 64 KiB by default, 256 KiB for operator execution, and 8 KiB for OAuth login and PDS notifications; JSON endpoints require `application/json`. Cookie-authenticated API mutations require the exact configured app `Origin`. Operator XRPC authenticates before reading its body. Upstream PDS XRPC, operator-service, and credential-exchange JSON responses are capped at 8 MiB, 1 MiB, and 64 KiB respectively; DID, PLC, and handle resolver responses are capped at 256 KiB of streamed bytes. Operator proxy routes classify oversized or invalid upstream responses as 502 and recognized transient DNS/network failures as 503. Workspace discovery surfaces summary-read failures instead of returning an incomplete successful list. The pause guard is enforced in both operator execution and workspace bootstrap services, including recovery paths. Channel sync exposes message and reaction truncation separately; the independent reader returns page reactions and an explicit degraded state when an additional record proves reaction history exceeds the v1 cap. At the 20,000-record message scan boundary, pagination stops once all known valid messages have been paged, and the degraded reason remains visible. Space-record URIs use the pinned PDS form `at://<space>/<author DID>/<collection>/<rkey>` across channel history, replies, reactions, join requests, and decisions; legacy encrypted cache entries migrate to the canonical URI binding. The two-PDS acceptance now uses PDS-returned URIs for reply, reaction, and join-request references and verifies that legacy cache migration preserves the record.
