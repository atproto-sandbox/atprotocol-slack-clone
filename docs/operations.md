# Operations

## Runtime configuration

Use the Node version in `.nvmrc` and install the locked dependency set with `corepack pnpm install --frozen-lockfile`. Configure `APP_URL`, `DATABASE_PATH`, `AUTH_ENCRYPTION_KEY`, `PLC_URL`, and `OPERATOR_SERVICE_REF` from `.env.example`. Public deployments require HTTPS for `APP_URL` and the operator DID service endpoint. The workspace authority DID must sign in and grant the space-management scopes before it can create spaces or authority records.

The SQLite database stores encrypted OAuth state/session blobs and encrypted message cache values, plus workspace-to-channel cache associations, the cross-process OAuth refresh lock, operation journal, cursors, web sessions, and audit events. Cache associations bind each locally retained channel cache to the exact workspace directory that exposed it, so revoking one workspace does not preserve its private cached content or erase a different workspace's cache under the same authority DID. All web workers and scheduled reconciliation processes that use the same OAuth sessions must share this local SQLite database file and encryption key. This SQLite deployment supports multiple processes on one host; multi-host replicas with separate local databases are unsupported. Keep the AES key outside the database and back it up in a separate secret store. Losing the key makes stored OAuth sessions and cached content unreadable; it does not change PDS membership or records.

The app resolves PDS endpoints from account DID documents. It requires HTTPS for remote endpoints, rejects private, loopback, link-local, and reserved address results, and pins the validated address set in the outbound dispatcher for each 30-second DNS cache window. Production DID/PLC resolution, OAuth, space-credential, and operator-service requests use this checked fetch path. Only the isolated loopback PDS fixture in `NODE_ENV=test` uses the platform fetcher for its loopback PLC directory. Keep the deployment network policy denying outbound connections to private, loopback, link-local, and cloud metadata ranges as defense in depth, and limit the app's outbound path to the public AT Protocol services required by the workspace.

## Membership reconciliation and alerts

Run `corepack pnpm reconcile` from the app checkout as a scheduled job every minute. It finds workspaces from the durable operator journal, reports operations stalled for five minutes before attempting recovery, restores each authority session from the encrypted store, resumes incomplete bootstrap operations with the authority session, checks current authority/admin records, resumes other saved operations, and reconciles stable workspace/inbox/channel membership. When `SLACK_ADMIN_MUTATIONS_PAUSED=true`, stalled-operation alerts and read-only authority/admin checks still run, while all mutations are skipped. Missing or revoked authority sessions and failed workspace checks produce stderr output and exit code 1. Forward stderr to the operator's alert channel. The admin screen also shows stalled operations and reconciles every five minutes while open after an authorized admin operation.

The OAuth client uses a per-DID SQLite lease to prevent simultaneous processes from consuming the same one-use refresh token. A stale lease left by a crashed process expires. OAuth state rows older than 30 minutes are pruned when state is read or written; browser flow cookies expire after 15 minutes. OAuth state/session writes and deletes retry SQLite busy/locked errors for three total attempts; lock, transport, timeout, and other recoverable restore failures preserve the web-session row and show a retry state. If refreshed-token persistence still fails after those attempts, the OAuth library revokes and removes that OAuth session, so the web-session row is invalidated and the user must sign in again. Authentication failures also invalidate the web session.

The operation journal is retry metadata. Each run retries recognized transient PDS/network failures for up to four total attempts with 100/200/400 ms backoff; permanent authorization and validation failures become pending/failed without retry. One exception: a workspace setup that fails because the account has not yet approved the required OAuth permission, before any step completed, is deleted from the journal (with an `operationDiscarded` audit event) and answered with a typed `authorization_required` response, so it never raises a stalled-operation alert. This also applies when recovery resumes such an empty row in the background; the user's retry simply creates a fresh one. A failure after some steps stays pending. Before an active admin starts a new mutation, the operator resumes earlier pending operations for that workspace so an old retry cannot override a newer decision. A member-scoped leave request does not trigger admin recovery; it waits with a busy response while an admin operation is pending. If an operation remains pending, preserve the database, inspect its recorded step names and last error, verify the corresponding PDS member lists and authority records, then retry with the same operation ID from the admin screen. Do not edit a journal row to claim completion.

## Pause and resume

Set `SLACK_ADMIN_MUTATIONS_PAUSED=true` and restart/redeploy the app and operator process to reject administrative mutation requests, including workspace bootstrap and recovery. Reads, message sync, and existing PDS state remain available. Remove the variable and restart to resume. A pending operation can then be retried or picked up by the next reconciliation run.

## Database backup and recovery

Write backups to encrypted storage outside the live database directory. The script uses SQLite's online backup API, so it can run while the app is open. It creates a new destination file exclusively with owner-only permissions on POSIX systems and refuses to overwrite an existing file:

```sh
corepack pnpm backup:db /secure/backups/slack-2026-09-24.db
```

Back up the AES key separately with access controls at least as strict as the database backup. Retain enough versions to recover from accidental deletion or database corruption. Verify backups periodically by restoring one to an isolated path and starting the app against it; never test restoration over the live database.

For recovery, pause admin mutations, stop the app, restore the selected database backup and its matching AES key, start the app, verify workspace discovery and operation status, then run `corepack pnpm reconcile`. Resume admin mutations only after PDS member lists and authority records agree. PDS records and memberships are not rolled back by restoring this SQLite database.

## Direct messages: what an operator can and cannot see

DMs have no server-side route, table, cache, or session of their own (`ARCHITECTURE.md`, "Direct-message runtime boundary"). The only server-side DM component is `src/app/api/notifications/dm/route.ts`, a Server-Sent-Events stream served under the existing server web session:

- It accepts exactly one `space` query parameter, which must parse as a DM inbox or DM conversation AT-URI (`parseDmSpaceUri` in `src/protocol/keys.ts`); anything else is rejected with 400. An inbox stream is limited to its owner (403 otherwise, `authorizeDmSubscription` in `src/lib/dm-subscription.ts`); a conversation-half stream is open to any signed-in user because its random key is the guard and the server holds no DM credentials to check membership.
- It queries the same `space_notification` table channels already use for their own write notifications, filtered to that one space, and returns `event: change` to the caller with only a monotonic integer cursor (`{"cursor":<n>}`). It never queries `com.atproto.space.getRecord`/`listRecords`, never mints a space credential, and never returns DM message text, reaction emoji, or a participant list to the browser.
- **Known residual exposure, stated not solved:** `com.atproto.space.notifyWrite` (`src/app/xrpc/com.atproto.space.notifyWrite/route.ts`) is how a `space_notification` row is created in the first place, and it stores the writer's DID (`repo_did`) alongside the space URI — this is the same mechanism channel join-request notifications already use, not something new for DMs. The DM client (M5) registers this app's own notify service only on the conversation currently open plus the user's own inbox (`.ai/plans/direct-messages.md` §3.3 step 6), so while that registration is active, an operator with direct SQLite access (not just server logs, and not the SSE route itself, which never selects `repo_did`) can see which DID wrote into which of those specific spaces and when — for an inbox, that includes the DID of whoever just sent a request. This is a social-graph exposure through the database, not a content exposure, and it is bounded to spaces with an active notify registration; `space_notification` rows are pruned after seven days. Treat direct database access with the same care as PDS session material.
- **Second known residual exposure, stated not solved:** each stream request carries the signed-in user's session and the space being followed. The open-conversation view follows every existing half of that conversation, so an operator with access logs can learn which halves, and therefore which participants, a user follows. The cause is protocol-level: `registerNotify` needs a service endpoint, so a browser-only client has to relay through a server. The requested fix is a client-direct change subscription authenticated by a space credential (upstream request U2 in `.ai/reviews/2026-09-28-app-and-protocol-review.md`); we deliberately do not add an app-side workaround.
- An operator can see, from server access logs, which DIDs' browsers are polling this endpoint and roughly how often, and can disable the route entirely (no reconciliation job or admin action depends on it: `renotifyPending()` and the client's 60-second poll are the correctness path, not this stream).
- An operator cannot, through the app or its API: read any DM message, reaction, or inbox request body; enumerate a user's conversations; revoke, delete, or export anyone's DMs; or force a DM notification to be delivered. All of that requires a PDS-issued, DPoP-bound space credential minted from the DM-only browser OAuth session (`src/dm/browser-session.ts`), which the server never holds.
- Nothing under `src/app/api/**` may import `src/dm/**`; this is enforced by an ESLint `no-restricted-imports` rule in `eslint.config.mjs`, not only by convention.

## Release checks

The PDS implementation and lexicons are pinned in [`protocol/atproto-spaces-pin.md`](./protocol/atproto-spaces-pin.md). Any pin change blocks release until the multi-PDS suites and app acceptance matrix pass again. Deployment, pilot enrollment, and an external alert destination are release tasks; this repository supplies the app, reconciliation command, local alert output, pause switch, and recovery instructions.

## Deployment and limited pilot

### Preflight inputs

Record and review these values before provisioning production resources. Store credentials in the deployment secret store; do not put secret values in this checklist, source control, or issue comments.

| Input | Required value or evidence |
|---|---|
| Hosting target | One supported single-host deployment with persistent local storage for SQLite; app and scheduled reconciliation process share the same database file and `AUTH_ENCRYPTION_KEY`. |
| Public endpoint | Production HTTPS `APP_URL`, DNS/TLS ownership, and the matching operator `did:web` service endpoint. |
| Protocol backend | Production PDS host(s), deployed revision, and evidence that the strict credential-expiry overlay or a compatible upstream fix is present. Re-run the pinned protocol drift checks against the deployed revision. |
| Authority and operator | Workspace authority DID, authorized human admin DIDs, and secure provisioning/reauthorization path for the authority session with required scopes. Never transfer the session through this document. |
| Network policy | Deployment egress rules deny private, loopback, link-local, reserved, and metadata ranges; confirm the app can reach only the required public AT Protocol services. |
| Reconciliation alerts | Named on-call destination and a test showing `pnpm reconcile` stderr/nonzero exits arrive there. Schedule reconciliation every minute. |
| Pilot scope | Workspace owner, initial member DIDs, pilot operator, enrollment window, and named person authorized to pause or roll back the app. |
| Recovery | Previous app artifact/revision, encrypted SQLite backup location, separately stored matching encryption key, and a recent isolated restore result. App rollback does not undo PDS records or memberships. |

### Deployment and acceptance sequence

1. Build the reviewed revision with the locked Node and pnpm versions. Configure production secrets outside the checkout and enforce the documented network policy.
2. Deploy the app and the one-minute reconciliation job on the same host and shared database/key. Confirm the public app responds over HTTPS, OAuth callbacks complete, DID service resolution and PDS connectivity work, and the authority's read-only checks succeed.
3. Exercise the pause switch, pending-operation status and retry, alert delivery, encrypted backup, and isolated restore before inviting pilot members. Confirm a paused reconcile still reports stalled operations and performs no mutations.
4. Enroll only the named pilot DIDs. Record evidence for two-app workspace discovery, public message/reaction parity, private request and approval/denial, membership removal and credential expiry, missed-notification recovery, and restart/reconciliation recovery.
5. Observe the pilot for the agreed window. Track reconciliation completion within 60 seconds, stalled-operation alerting at five minutes, failed OAuth/PDS calls, and any membership mismatch. Pause admin mutations and follow the recovery procedure if PDS and authority state diverge.
6. Expand only after the workspace owner and pilot operator record acceptance of the PRD criteria, review the evidence, and confirm the deployed PDS revision still satisfies the pinned protocol checks.

Keep a restricted release record containing app commit/build identity, PDS revisions and strict-expiry evidence, deployment URL, backup/restore result, alert test, pilot window and cohort identifier, acceptance evidence, incidents, and owner/operator sign-off. Keep the member enrollment list access-controlled and separate. Do not include credentials or private message contents in the release record.
