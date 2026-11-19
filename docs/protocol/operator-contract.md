# Workspace Authority Operator Contract

Version: 1  
Protocol pin: [`atproto-spaces-pin.md`](./atproto-spaces-pin.md)

## Service identity and authentication

The operator publishes a DID service entry with ID `#atproto_flock_operator` and type `AtprotoFlockOperator`, resolving to its XRPC base URL. The exact service reference is `OPERATOR_DID#atproto_flock_operator`.

An admin app obtains a one-minute-default service JWT from the user's PDS with `com.atproto.server.getServiceAuth`, setting `aud=OPERATOR_DID#atproto_flock_operator` and `lxm` to the exact operator method (`new.flock.operator.getChanges` accepts tokens up to 15 minutes so long-polls reuse one token). The user OAuth access token must contain the matching RPC scope (`rpc?lxm=...&aud=OPERATOR_DID%23atproto_flock_operator` or per-method `rpc:<method>?aud=...`; `com.atproto.server.getServiceAuth` also remains usable with app passwords even though account-authenticated space/memberspace endpoints enforce `ACCESS_FULL`). The app sends the resulting token as a Bearer service-auth token to that XRPC method.

The operator verifies the JWT signature against the issuer DID document and requires:

- `iss` is a valid actor DID.
- `aud` exactly equals the published operator service reference.
- `lxm` exactly equals the invoked method NSID.
- `exp` is valid and within the PDS-issued service-token window.

The actor DID comes only from verified `iss`; request bodies have no actor field. The operator loads the selected workspace from the request and resolves its authority DID from the space URI. Inbox-writer lookup and operation lookup require an active workspace admin. An admin execute request also checks current state. A member with the execute RPC scope may submit only `leaveWorkspace` or `leaveChannel`; the server verifies that the caller can remove only their own membership.

For admin-only methods and admin execute requests, the authority-authored `new.flock.admin` record for the actor has `active=true`.

The operator also requires:

1. The authority-authored `new.flock.workspace.roster` record for the actor has `active=true`.
2. `com.atproto.memberspace.listMembers` shows workspace `read=true, write=true` and inbox `read=true, write=true` for an admin. Self-leave calls require active workspace and inbox write membership; `leaveChannel` additionally requires current private-channel membership.

The authority DID session performs owner-only checks. A role record cannot replace protocol management scope or PDS membership.

One exception keeps a retry possible. Four requests take away the role that let their caller start them: `leaveWorkspace`, `leaveChannel`, `removeMember` naming the caller, and `setAdmin` demoting the caller. If one of them stops part-way, current state can refuse its caller. The operator therefore also accepts such a request from a caller it would otherwise refuse when the journal already holds that caller's operation under the same key and request hash. A journal row is written only after its caller passed the checks above. The caller can then finish or read back that one operation; they cannot start another or recover anyone else's. Every other request is decided by current state alone.

## XRPC methods

All requests carry the `workspace` URI and `operationId` where applicable. The workspace URI must parse as `at://<authority-did>/space/new.flock.workspace/<workspace-skey>`.

### `new.flock.operator.execute` (procedure)

Request:

```json
{
  "workspace": "at://did:plc:example/space/new.flock.workspace/acme",
  "operationId": "3mabchjk3xyz2",
  "request": {
    "$type": "new.flock.operator.execute#operationRequest",
    "kind": "inviteMember",
    "subject": "did:plc:invitee"
  }
}
```

The `request` object is discriminated by `kind` and rejects missing or extra fields:

| Variant | Fields | Effect |
|---|---|---|
| `#inviteMember` | `subject: DID` | Add workspace, inbox writer, and all public-channel memberships; upsert the active workspace roster. |
| `#removeMember` | `subject: DID` | Remove inbox and channel memberships, then workspace membership; deactivate roster and admin state. |
| `#setAdmin` | `subject: DID`, `active: boolean` | Promote/demote; preserve at least one active admin. |
| `#createChannel` | `skey`, `name`, `visibility`, optional `members: DID[]` | Create channel space and apply selected membership before publishing directory state. |
| `#transitionChannel` | `skey`, `visibility`, optional `members: DID[]` | Reconcile membership while directory state is `transitioning`; preserve the space URI. |
| `#archiveChannel` | `skey` | Transition, remove channel membership, mark archived. |
| `#leaveWorkspace` | none | Remove only the verified caller; enforce last-admin protection. |
| `#leaveChannel` | `skey` | Remove only the verified caller from that private channel. |
| `#reconcileWorkspace` | none | Resume journaled operations, then reconcile stable membership against current authority records. |
| `#decideJoinRequest` | `request: AT-URI`, `requestId: TID`, `decision: approve \| deny` | Apply only to the matching current request generation. |
| `#installApp` | `subject: DID`, `channels: [{ skey, write }]` | Write the app's install record, then make it a reader of the workspace space and a member of each granted channel, writing where granted. Refuses the workspace account, a person on the roster, a channel that is not public or private, another grant of an installed app, and a 21st app. |
| `#updateAppAccess` | `subject: DID`, `channels: [{ skey, write }]` | Rewrite an installed app's channels, then move its entries to match. |
| `#uninstallApp` | `subject: DID` | Mark the install inactive, then remove the app from every member list. |
| `#enableExtension` | `extId: string` | Ensure the first-party extension space (e.g. `tasks`), publish active `new.flock.ext.install`, and converge extension member list. |
| `#disableExtension` | `extId: string` | Mark `new.flock.ext.install` inactive and remove all members from the extension space. |

> **Wire compatibility note:** Flock's persisted `OperationRequest.kind = "removeMember"` (`#removeMember`) is intentionally retained for journal and wire compatibility, while the operator executes PDS member-list mutations via batched `com.atproto.memberspace.putMembers` and `com.atproto.memberspace.removeMembers` (`<= 100` entries per call).

An installed app is not a person: `#inviteMember`, `#removeMember` and `#setAdmin` refuse it, and a join request never takes a channel from it. `#transitionChannel` keeps a granted app in the channel with its bits, `#archiveChannel` ends every app's grant of the channel before removing its members, and `#reconcileWorkspace` places apps from their install records.

Response wraps the journal view in `operation`:

```json
{
  "operation": {
    "operationId": "3mabchjk3xyz2",
    "requestHash": "<lowercase SHA-256>",
    "state": "pending",
    "completedSteps": ["member-workspace"],
    "error": "<bounded error>",
    "updatedAt": "2026-09-24T16:00:00.000Z"
  }
}
```

`state` is one of `queued`, `running`, `pending`, `completed`, `failed`, or `paused`. A mutation is `completed` only after all required PDS member lists and authority records match the desired state. A pending response includes a bounded error; it never includes message bodies or credentials.

### `new.flock.operator.getOperation` (query)

Parameters: `workspace`, `operationId`. Returns operation status for a verified active workspace admin. The operation journal is keyed by `(workspace DID, actor DID, operationId)`.

### `new.flock.operator.listInboxWriters` (query)

Parameter: `workspace`. Returns all current inbox member-list DIDs with `write=true` (at most the 200-member launch envelope). It calls owner-only `listMembers` using the workspace DID session. It never reads or returns request records. The admin app uses its own inbox space credential to read each candidate repo from its PDS. `com.atproto.space.listWriters` remains the fast writer index; this method recovers writes whose PDS-to-authority `notifyRepoUpdate` was lost.

### `new.flock.operator.createWorkspace`, `startAuthorityFlow`, and `listStalledOperations`

- `createWorkspace` (procedure): creates a new workspace (`{ name, operationId, authority? }`) for its authenticated creator under their own DID or an approved dedicated workspace authority DID.
- `startAuthorityFlow` (procedure): mints a single-use two-minute `/authority/start` ticket to provision or reauthorize a workspace authority OAuth grant (`{ authority?, createWorkspaceName? }`).
- `listStalledOperations` (query): returns stalled journaled operations (`>= 5 min`) and failed/expired webhook `notification_registration` entries for an active workspace admin.

### `new.flock.operator.getChanges` (procedure)

Authenticated with a Bearer service JWT (`lxm=new.flock.operator.getChanges`, valid up to 15 minutes). Accepts followed space cursors and optional long-poll wait; returns `{ head, changed, denied, reset }` — cursors only, never record contents. Workspace/inbox/channel/app-inbox/extension cursors come from SQLite `space_notification` (with `denied` checked against the authority member list and guarded by an authority-keyed `15 s` suspension circuit breaker); DM cursors merge from caller-scoped `(callerDid, space)` ephemeral wakes (`apps/operator/src/operator/dm-feed-wakes.ts`, shared across multiple local operator processes over an HMAC-authenticated `0o600` Unix domain socket hub, emitting `reset` across hub restarts and storing **zero** DM rows in SQLite).

### `new.flock.operator.getDmNotifyTarget` (procedure)

Issues a stateless epoch-bounded per-caller PDS webhook target `{ endpoint, token }` for a DM space (`new.flock.dm.inbox` or `new.flock.dm.conversation`) after proving the caller holds read access to that space:

- **Authentication & access proof:** Requires a Bearer service JWT (`aud=OPERATOR_DID#atproto_flock_operator`, `lxm=new.flock.operator.getDmNotifyTarget`) AND input `{ space, credential, proof: { authorization, signatureInput, signature } }` where:
  1. `credential` is a valid unexpired `SpaceCredential` JWT issued by `requireSpaceAuthority(space)` for `sub === space` (`verifySpaceToken("credential", ...)`).
  2. `proof` is a fresh RFC 9421 key-possession signature (`createTimestampedSpaceSigHeaders` / `verifyCredentialSig` with mandatory signed integer `;created=<unixSec>` within `+-60 s` and `<= exp`, `tag="atproto-space-credential"`, and `audience = OPERATOR_SERVICE_REF` over `cnf.kid`), atomically consumed once via a canonical shared TTL lock (`pop:<hmac(replayKey, iss + "\0" + jti)>` in `oauth_request_lock`, immune to RFC 9421 label relabeling and ECDSA high-S malleability and storing zero DM URIs, DIDs, or plaintext JTIs).
  Nonmembers, revoked callers, wrong-space credentials, missing/out-of-window `created`, and replayed proofs are rejected (`403 Unauthorized`). The operator never receives the caller's `cnf.kid` private key and stores zero DM state in SQLite.
- **Epoch-bounded `dm1` token:** Derives `dm1.<epochHex>.<base64url(callerDid)>.<base64url(hmacSha256(dmNotifyKey, "dm1\0" + epochHex + "\0" + space + "\0" + callerDid))>` (`<= 512` chars, `30 min` epochs) via HKDF-SHA256 from `AUTH_ENCRYPTION_KEY` (`"flock-dm-notify-v1"`). Inbound webhooks accept only `epoch === currentEpoch || epoch === currentEpoch - 1`, so renewals within an epoch reuse `(endpoint, token)` while revoked participants lose webhook capability once `[epoch, epoch - 1]` rolls past.

## Inbound PDS webhooks (`com.atproto.space.confirmRegistration` & `com.atproto.space.notifySpaceUpdate`)

Upstream `#5187` removes `registerNotify`, `unregisterNotify`, `notifyWrite`, and `notifySpaceDeleted`. Syncers register webhooks inline via `com.atproto.space.authorizeSpaceSync` (`notify: { endpoint, token }`, sharing the credential's `600 s` default / `3600 s` max `exp`). In production, `OPERATOR_URL` must be a publicly routable HTTPS origin because PDS `ctx.safeClient(endpoint)` enforces SSRF protection unless `devMode: true` and `disableSsrfProtection: true` (`L7`).

- **Token-only constant-time authentication (`auth: undefined`):** Both `/xrpc/com.atproto.space.confirmRegistration` and `/xrpc/com.atproto.space.notifySpaceUpdate` verify `(space, token)` strictly via `crypto.timingSafeEqual` against `notification_registration.token` (with no `expires_at` gate, accepting both `expires_at = 0` initial placeholders and `#registrationExpired` notices arriving >5 minutes after lapse) OR a valid epoch-bounded `dm1` HMAC token (`epoch` in `[currentEpoch, currentEpoch - 1]`). Missing, empty, expired-epoch, or mismatched tokens return HTTP `400` (`InvalidRequest`).
- **Operator registration & renewal lifecycle:** For workspace, inbox, channel, app-inbox, and extension spaces, the operator claims one stable random `token` per `(service_ref, space_uri)` in `notification_registration.{token, renew_at, last_space_rev, generation}` inside `BEGIN IMMEDIATE` before calling `authorizeSpaceSync` (so racing processes converge on one winning token and post-await updates CAS on `(token, generation)` so archived spaces are never recreated), reconciles missed writes whenever `authorizeSpaceSync.spaceRev !== last_space_rev`, and renews due rows via a 60-second SQL-first loop (`renew_at = exp * 1000 - min(3 min, floor(0.3 * ttlMs))`, `15 s -> 2 min` retry backoff in `notification_registration_failure`, stopping per-authority sweeps after 1 suspended request and bulk-backing off remaining due rows) plus a 30-minute discovery sweep.
- **`notifySpaceUpdate` outer `{ space, token, update }` dispatch by `update.$type`:**
  - `com.atproto.space.defs#repoWrite` (`{ repo, repoRev, spaceRev, prevSpaceRev?, data }`): appends a wake row (and advances `last_space_rev`) for operator spaces, or records a caller-scoped `(callerDid, space)` wake in `dm-feed-wakes` (capped at `120` wakes per `60 s` per `(callerDid, space)` with `429 RateLimitExceeded`) for `dm1` tokens.
  - `com.atproto.space.defs#repoRemoved` (`{ repo, spaceRev, prevSpaceRev? }`): emits a synthetic wake row (or caller-scoped DM wake) so active `ChangeFollower` clients run `listWritersSince` and drop the removed writer.
  - `com.atproto.space.notifySpaceUpdate#registrationExpired` (`{ spaceRev }`): for operator spaces, reconciles `last_space_rev`, sets `renew_at = 0`, emits a wake row, triggers immediate async renewal, and returns `200 {}`; for `dm1.*` tokens, returns HTTP **`400`** (`InvalidRequest`), triggering PDS `abandonSyncerNotice` so closed browser tabs drop stale PDS registrations immediately instead of retrying for 72 hours.
  - `com.atproto.space.notifySpaceUpdate#spaceDeleted` (`{}`): for operator spaces, **never** purges state on the webhook alone — the operator confirms deletion by calling `authorizeSpaceSync` with the workspace's restored authority grant and purges notices, cached member list, and registration rows **only** when the authority returns `SpaceDeleted` (leaving state intact on transient errors or `RepoTakendown`/`RepoDeactivated`); for `dm1.*` tokens, wakes attached caller-scoped listeners and returns `200 {}`.

## Idempotency, ordering, account suspension, and journal

The operation key is `(workspace authority DID, verified actor DID, operationId)`. The operator computes the request hash over canonical JSON bytes for the validated `{ workspace, request }` object, then SHA-256. Replaying the same key and hash returns the current journal status, including for a caller whose own operation, one of the four above, has since removed their role. Reusing the key with a different hash returns `409 OperationIdConflict` and makes no PDS calls.

The operator serializes mutations per workspace. Each journal row stores the operation key, canonical request hash, desired state, ordered PDS steps, completed steps, status, last error, and timestamps. It stores no message content, join-request body, OAuth token, service JWT, or space credential. Periodic reconciliation first resumes incomplete journaled operations, then compares stable authority records with PDS member lists. `authority_grant` uses a quarantined `sessionStore` (`del` never deletes canonical storage; only explicit `revokeAuthorityGrant` deletes it), an out-of-band account-status probe (`com.atproto.sync.getRepoStatus` / `listSpaces`) on OAuth refresh `invalid_grant`, and an authority-wide `15 s` suspension circuit breaker (`503 UpstreamUnavailable`). `AccountDeactivated` and short takedowns within the current OAuth access-token lifetime recover automatically; if a moderation `AccountTakedown` outlives the short-lived access token, upstream `@atproto/pds` (`account-manager.ts:440`) revokes server-side refresh tokens at takedown time, requiring re-approval once restored. The journal is retry metadata, never the membership or role source of truth. The admin view alerts after five minutes without progress.

One run of an operation starts no step once it has held the workspace's lock for three minutes. The operation is then answered as `pending`, with a time-limit error and the steps it completed, and sending it again continues it. A caller waits up to 100 seconds for the lock. A client should therefore allow about five minutes for an `execute` answer. That is a budget, not a bound: the step in flight at the limit still ends, and earlier pending operations are resumed first, each with its own wait and run. A client that gives up earlier loses nothing, because the operator carries on and the same operation sent again returns its state.

## OAuth scopes

The browser requests one combined grant (`memberGrantScopes` in `packages/protocol/src/scopes.ts`): `DM_BROWSER_SCOPES`, member read/write scopes for `new.flock.workspace`, `new.flock.inbox`, `new.flock.channel`, and `new.flock.ext.tasks` (`action=read` implies `read_self` for `listSpaces` workspace discovery), write-only `new.flock.app.inbox` commands/actions, and one combined operator RPC token:

```text
rpc?lxm=new.flock.operator.execute&lxm=new.flock.operator.getOperation&lxm=new.flock.operator.listInboxWriters&lxm=new.flock.operator.getChanges&lxm=new.flock.operator.createWorkspace&lxm=new.flock.operator.startAuthorityFlow&lxm=new.flock.operator.listStalledOperations&lxm=new.flock.operator.getDmNotifyTarget&aud=OPERATOR_DID%23atproto_flock_operator
```

Pre-R12 browser sessions whose `rpc` token covers `LEGACY_OPERATOR_METHODS` (omitting `new.flock.operator.getDmNotifyTarget`) remain valid in `apps/web/src/browser/session.ts` for reads, mutations, and polling fallback (flagging optional reconnect only to enable DM push wakeups). Production OAuth consent deployments must republish the updated `new.flock.*` space lexicons (`"title"` replacing `"name"`), `new.flock.operator.getDmNotifyTarget`, and `new.flock.permissions.{member,workspaceAuthority}` (`L8`).

The operator's separate workspace DID session has only the space-management, owner-read, and authority-record write scopes listed in [`atproto-spaces-pin.md`](./atproto-spaces-pin.md#authority-operator-scopes). It has no message, reaction, or join-request write access.

A member calling `new.flock.operator.execute` without admin role may submit only self-leave requests (`leaveWorkspace` or `leaveChannel`); the scope grants neither operation lookup nor inbox-writer access.
