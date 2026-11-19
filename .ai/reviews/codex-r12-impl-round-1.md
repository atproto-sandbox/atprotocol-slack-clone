The implementation is not ready: the static audit found **0 Blocker, 1 High, 5 Medium, and 3 Low findings**. I inspected the frozen range, locked decisions, prior plan reviews, tests, and pinned upstream source without modifying files/git state or executing builds, tests, linters, typecheckers, servers, or Playwright.

## D12 compliance summary

| Decision | Status | Static assessment |
|---|---|---|
| [D12.1](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/.ai/plans/r12-protocol-drift-progress.md:14) | Compliant | Pin, package versions, overrides, checkout paths, and environment references align with `6747610566eee1b6d743617bd8eb1136adccb362`. |
| [D12.2](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/.ai/plans/r12-protocol-drift-progress.md:40) | Compliant | Strict credential expiry patch preserves delegation skew and applies zero skew to credentials. |
| [D12.3](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/.ai/plans/r12-protocol-drift-progress.md:47) | Non-compliant | Core webhook parsing/authentication is correct, but replay, registration concurrency, permanent DM capabilities, indefinite operator waits, and multi-process wake delivery have gaps. |
| [D12.4](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/.ai/plans/r12-protocol-drift-progress.md:120) | Compliant | Fresh KEM encapsulation and throwing record/commit/MAC verification match pinned APIs. |
| [D12.5](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/.ai/plans/r12-protocol-drift-progress.md:131) | Compliant | STAR framing and CID-less `starEntryBytes` accounting match upstream. |
| [D12.6](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/.ai/plans/r12-protocol-drift-progress.md:144) | Non-compliant | Authority grants can be deleted during suspension, full writer scans can false-truncate, and suspension suppression remains per-space. |
| [D12.7](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/.ai/plans/r12-protocol-drift-progress.md:158) | Compliant | Every `listRepoOps` page requires commit/MAC verification; `RepoNotFound` classification is preserved. |
| [D12.8](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/.ai/plans/r12-protocol-drift-progress.md:166) | Compliant | Batch membership and dormant-member reactivation semantics match the pin. |
| [D12.9](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/.ai/plans/r12-protocol-drift-progress.md:181) | Partial | Implemented fake routes enforce `ACCESS_FULL`, but four required routes are absent. |
| [D12.10](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/.ai/plans/r12-protocol-drift-progress.md:186) | Compliant | All four upstream lexicon directories match the pin; Flock space lexicons use `title`. |
| [D12.11](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/.ai/plans/r12-protocol-drift-progress.md:196) | Compliant | Reader dependency/import boundaries and direct STAR dependency are preserved. |
| [D12.12](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/.ai/plans/r12-protocol-drift-progress.md:201) | Not met | The plan records green gates, but they were not rerun under this review’s constraints, and the High finding invalidates readiness. |

## Blocker — 0

No Blocker findings.

## High — 1

### H1. Temporary authority suspension can delete the canonical encrypted grant

[authority-grant.ts:250](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/apps/operator/src/operator/authority-grant.ts:250) restores through the live `approvalView`; its `del` physically removes the row at [encrypted-store.ts:77](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/apps/operator/src/auth/encrypted-store.ts:77). The protection at [authority-grant.ts:390](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/apps/operator/src/operator/authority-grant.ts:390) only strips `invalid_token` from an already-received XRPC `401 AccountTakedown/AccountDeactivated`.

Pinned PDS takedown revokes refresh tokens and removes token rows at [account-manager.ts:440](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/account-manager/account-manager.ts:440). When the stored access token becomes stale, the actual OAuth dependency converts token-endpoint `400 invalid_grant` into `TokenRefreshError` and marks it for deletion at [session-getter.js:137](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/node_modules/.pnpm/@atproto+oauth-client@0.8.7/node_modules/@atproto/oauth-client/dist/session-getter.js:137) and [session-getter.js:166](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/node_modules/.pnpm/@atproto+oauth-client@0.8.7/node_modules/@atproto/oauth-client/dist/session-getter.js:166). The application catch runs only after deletion. Existing coverage at [authority-grant.test.ts:427](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/apps/operator/src/operator/authority-grant.test.ts:427) tests the management-response header case, not refresh during suspension.

**Failure scenario:** a reversible takedown lasts until the access token needs refresh. The next restore receives `invalid_grant` and deletes the only durable `authority_grant`, stranding every affected workspace until human reapproval.

**Exact fix:** give the OAuth client a quarantined session view whose `del` never deletes canonical storage; persist successful refreshes using same-approval CAS, and classify `invalid_grant` using an out-of-band account-status probe before any destructive action. Explicit `revokeAuthorityGrant` should remain the only deletion path. Because pinned PDS actually destroys the refresh grant, either change upstream suspension semantics or revise the automatic-recovery requirement to require reapproval after a long suspension.

## Medium — 5

### M1. RFC 9421 replay protection can be bypassed by semantically equivalent signatures

[security.ts:169](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/apps/operator/src/operator/security.ts:169) verifies the proof, but [security.ts:261](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/apps/operator/src/operator/security.ts:261) makes `created` optional and [security.ts:288](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/apps/operator/src/operator/security.ts:288) keys replay state by raw `signatureInput` and signature bytes. The client proof at [dm-client.ts:743](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/packages/client/src/dm/dm-client.ts:743) supplies no freshness parameter.

Pinned verification says labels have no meaning at [http-signature.ts:153](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/space/src/http-signature.ts:153) and deliberately permits high-S P-256 signatures at [http-signature.ts:98](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/space/src/http-signature.ts:98).

**Exploit:** during the 75-second service-token window, a captured request can be relabeled or changed to the corresponding high-S signature. Verification still succeeds while the raw cache key changes. Another process or restart also accepts the original replay. Impact is bounded to obtaining the same deterministic callback target and subsequent wake spoofing, not DM content access.

**Exact fix:** require a signed `created`, mint a fresh credential/JTI for each target request, and atomically consume canonical `(jti, created)` values in a shared TTL replay store. Do not key replay identity on label serialization or raw ECDSA bytes. Add relabel, high-S, missing-created, cross-process, and restart tests.

### M2. `listBoundedWriters` can reject a terminal writer set that fits the bound

At [record-pages.ts:297](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/packages/protocol/src/atproto/record-pages.ts:297), a full active map requests one lookahead entry; any unseen write immediately sets `truncated` at line 317. Upstream orders mutable writer rows by `spaceRev` at [reader.ts:315](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/actor-store/space/reader.ts:315).

**Failure scenario:** with `maxRepos=2`, page one returns `A@2,B@3`. Concurrently, `C` writes at `@4` and `B` is removed at `@5`. Page two returns `C@4`; current code stops before reading `B#removed@5`, although the terminal set is `{A,C}`. Cold readers and warm synchronization falsely reject the space.

**Exact fix:** continue through the terminal page under an explicit raw-update/page cap, retaining latest state for provisional overflow writers. Compute `truncated` only from the final latest-wins active map. Add the exact write-then-later-removal interleaving.

### M3. Registration identity and archive lifecycle are not serialized across processes

The lock at [registrations.ts:76](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/apps/operator/src/operator/registrations.ts:76) is process-local. Token creation reads, generates, and overwrites through UPSERT at [registrations.ts:141](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/apps/operator/src/operator/registrations.ts:141). Renewal reads the row and awaits grant restoration outside that lock at [registrations.ts:246](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/apps/operator/src/operator/registrations.ts:246), while archive purges it at [notices.ts:103](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/apps/operator/src/operator/notices.ts:103).

**Failure scenarios:** two supported processes can stage and confirm different tokens, leaving multiple upstream registrations while SQLite retains only one; separately, a renewal waiting on a grant can resume after archive and recreate the purged row and registration.

**Exact fix:** claim the initial token in `BEGIN IMMEDIATE` using `INSERT … ON CONFLICT DO NOTHING`, then reread and reuse the winner. Add a registration generation/tombstone and condition every post-await success/failure write on the same extant generation; zero affected rows means cancellation. Test with two SQLite connections and deferred PDS/grant promises.

### M4. A removed member retains permanent authority to spoof cross-caller DM wakes

The `dm1` token at [space-notification.ts:42](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/apps/operator/src/operator/space-notification.ts:42) is a permanent HMAC over `(space, callerDid)`. Authentication recovers `callerDid`, but [methods.ts:278](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/apps/operator/src/operator/methods.ts:278) discards it. Wake state is keyed only by space at [dm-feed-wakes.ts:32](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/apps/operator/src/operator/dm-feed-wakes.ts:32).

**Exploit:** a former member keeps the browser-visible token and can POST forged `#spaceDeleted` or write notifications indefinitely without PDS service authentication. Every current follower receives a change/reset and resynchronizes. This does not expose or mutate DM content, but provides unbounded cross-caller network/CPU amplification.

**Exact fix:** carry `callerDid` through webhook handling and key wakes/cursors by `(callerDid, space)`. Replace the permanent token with bounded HMAC epochs, accepting only the current and brief previous epoch, and renew the target before epoch rollover. Add per-token rate limits and a test proving Alice’s revoked token cannot change Bob’s feed.

### M5. `DmClient.watch()` can wait forever instead of taking its fallback path

[dm-client.ts:618](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/packages/client/src/dm/dm-client.ts:618) awaits notification setup, including `getDmNotifyTarget` at [dm-client.ts:748](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/packages/client/src/dm/dm-client.ts:748). [operator-client.ts:162](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/packages/client/src/operator-client.ts:162) has no deadline; the supplied signal normally lasts for the component lifetime.

**Failure scenario:** a blackholed operator never rejects, so the valid unnotified credential is never returned and live-feed subscription never starts. The 60-second UI cycle at [dm-context.tsx:99](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/apps/web/src/app/ui/dm-context.tsx:99) can accumulate additional stalled calls.

**Exact fix:** return the valid unnotified credential immediately and run notification registration as one deduplicated background task per space. Apply a composed deadline to both service-token minting and operator fetch; timeout must enter the existing unnotified fallback and schedule bounded background retry. Test a never-resolving transport.

## Low — 3

### L1. In-memory DM wakes do not work consistently across supported processes

The deployment documentation supports multiple processes sharing SQLite at [operations.md:20](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/docs/operations.md:20), but the wake epoch, map, and listeners are module-local at [dm-feed-wakes.ts:32](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/apps/operator/src/operator/dm-feed-wakes.ts:32). [feed.ts:173](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/apps/operator/src/operator/feed.ts:173) polls SQLite only for persisted non-DM notices.

A webhook handled by worker A does not wake a long poll on B, and alternating workers produce epoch resets. The direct 60-second PDS poll preserves eventual correctness, limiting severity.

**Exact fix:** add content-free host-local IPC with a single shared epoch, or route both notification and `getChanges` endpoints through one designated worker. Add a two-process acceptance test while retaining zero DM SQLite rows.

### L2. Suspension backoff is per-space, allowing authority-wide request fan-out

`getChanges` accepts 200 spaces at [feed.ts:8](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/apps/operator/src/operator/feed.ts:8), while suspension state is cached per space at [member-access.ts:44](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/apps/operator/src/operator/member-access.ts:44). Registration renewal groups rows by authority but still calls every row at [registrations.ts:375](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/apps/operator/src/operator/registrations.ts:375).

One suspended authority can therefore receive up to 200 equivalent management requests from one feed call and another fan-out on each renewal round.

**Exact fix:** introduce an authority-keyed circuit breaker. Stop a group after its first suspension response, bulk-backoff all due rows for that authority, and release the group only after one successful probe.

### L3. `FakeNetwork` diverges from pinned PDS in two R12 cases

First, [fake-network.ts:855](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/packages/testing/src/fake-network.ts:855) reconfirms an expired retained registration. Real PDS confirms only an absent row at [authorizeSpaceSync.ts:96](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/api/com/atproto/space/authorizeSpaceSync.ts:96), and its reader explicitly includes lapsed rows at [reader.ts:344](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/actor-store/space/reader.ts:344).

Second, the dispatch table at [fake-network.ts:626](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/packages/testing/src/fake-network.ts:626) omits `getBlob`, `listBlobs`, `exportSpaceMeta`, and `importSpaceMeta`. Fake app-password calls return `501` before auth, while pinned PDS applies `ACCESS_FULL` and returns `400 InvalidToken: Bad token scope`.

**Exact fix:** confirm only when `existingReg` is absent; implement the four routes or a route-specific authentication gate before their stub behavior. Extend the table-driven test with retained-lapsed renewal and all four missing endpoints.

The audit found no additional defect in wrong issuer/space/audience/expiry checks, constant-time webhook token comparison, zero-expiry registration confirmation, outer notification parsing, authority-confirmed space deletion, DM-expiry `400`, every-page commit/MAC verification, authority-versus-member suspension classification, zero DM SQLite storage, dormant-member reactivation, or legacy browser-session admission.

VERDICT: CHANGES_REQUESTED