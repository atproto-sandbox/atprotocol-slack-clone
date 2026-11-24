# Flock Operator Wire Contract (R13 `opensocial.group`)

Version: 2 (R13 `opensocial.group` atmospheric groups)  
Protocol pins: [`atproto-spaces-pin.md`](./atproto-spaces-pin.md)

## Service identity, authentication & live OpenSocial authorization

The Operator (`apps/operator`) publishes a `did:web` document (`/.well-known/did.json` at `OPERATOR_URL`) carrying service entry `#atproto_flock_operator` (`type: "AtprotoFlockOperator"`, `serviceEndpoint: OPERATOR_URL`). The canonical service reference is `OPERATOR_DID#atproto_flock_operator` (`OPERATOR_SERVICE_REF`).

Clients authenticate Operator XRPC calls with a personal-PDS service JWT minted via `com.atproto.server.getServiceAuth`:
- `iss`: caller's personal DID (verified against `iss`'s `#atproto` signing key; request bodies never carry an actor DID).
- `aud`: exact `OPERATOR_SERVICE_REF`.
- `lxm`: exact invoked `new.flock.operator.*` NSID.
- `exp`: valid within the method's window (`60 s` default; up to `15 min` on `new.flock.operator.getChanges` so long-polls reuse one token).

### Live `group.opensocial.*` capability checks & confused-deputy defense

Every workspace is anchored at `at://<groupDid>/space/new.flock.workspace/self`. Operator holds one shared Group-DID OAuth session per `<groupDid>` (encrypted in `authority_grant`), authorized at group creation (`prompt=create` on `GROUP_HOST_URL`) and reauthorizable by any active effective human admin via their own personal PDS.

Because Operator uses a shared Group-DID session, it enforces strict confused-deputy checks **before initial admission, before every individual step, and before every crash-recovery resume**:
1. Re-reads live `at://<groupDid>/space/group.opensocial.members/self` (`role/*` and `membership/*`) **plus every non-deleted space's `com.atproto.space.policy/self` (`group.opensocial.policy`)** and `new.flock.workspace/self` (`new.flock.app.install/*`).
2. Verifies the actor is a live **human** member (`actor !== groupDid && !knownAppSubjects.has(actor)` and `membership/<actor>` exists with `roles.length >= 1`).
3. **Never gates Operator authorization on personal-PDS `group.opensocial.acceptance/self`:** per `opensocial.group` (`proposal.md:59,195`), authorization derives strictly from `membership`, `role`, `policy`, and `assignable` (while `acceptance/self` gates human roster display and client discovery), allowing `createWorkspace` and admin operations to succeed cleanly before `acceptance/self` is written.
4. Evaluates canonical **`effectiveMemberPermissions(state, groupDid, actor)`** (`packages/protocol/src/scopes.ts`, unioning `expandGroupScopes` across assigned `role.scopes` with `expandPolicyGrantScopes` across every non-deleted space's matching `policy.grants[].scopes`) plus **`assignable`** coverage over every target role/member.
5. Self-service exception: a non-admin human member may submit only `leaveChannel` (or legacy `leaveWorkspace`), removing only their own `channel-<skey>` role (or own membership). Operations marked `endsOwnRole` (`leaveChannel`, `leaveWorkspace`, self-`removeMember`, self-demoting `setAdmin`) remain readable/retryable by their original caller under the exact `(workspace, actor, operationId, requestHash)` tuple if interrupted mid-flight.

*(Note: R12's `new.flock.operator.listInboxWriters` and `reconcile-workspaces.ts` were retired in R13; OpenSocial group join requests use `group.opensocial.listJoinRequests`, private-channel requests in `new.flock.inbox/self` sync via `listWriters`, and `group.opensocial.policy` eliminates per-space member-list drift.)*

---

## XRPC methods

### 1. `new.flock.operator.startAuthorityFlow` (procedure)

Mints a single-use, 2-minute `/authority/start` browser ticket to either create a new `opensocial.group` account (`purpose: "createWorkspace"`, running two-sided OAuth `prompt=create` on `GROUP_HOST_URL` and recording a 15-minute `creation_authorization`) or reauthorize Operator's shared Group-DID session (`purpose: "reauthorize"` for an existing `authority: <groupDid>`).

- **Input:** `{ purpose: "createWorkspace" | "reauthorize", name?, authority?, joinPolicy?: "open" | "approval" | "invite", publicMeta?: boolean, creationKey? }`
- **Output:** `{ url: string }`

### 2. `new.flock.operator.createWorkspace` (procedure)

Provisions Flock workspace modality spaces (`at://<groupDid>/space/new.flock.workspace/self`, `at://<groupDid>/space/new.flock.inbox/self`, and the initial `#general` `new.flock.channel/<skey>` space + `new.flock.directory/<skey>`) inside an `opensocial.group` Group DID using Operator's shared Group-DID grant, and registers 1-webhook-per-space `notify` sinks (`meta/self`, `members/self`, `workspace/self`, `inbox/self`, and `#general`).

- **Input:** `{ name, operationId, authority?: DidString, joinPolicy?: "open" | "approval" | "invite", publicMeta?: boolean }`
- **Output:** `{ operationId, groupDid?, workspace, channel, state, completedSteps, takenOverBy?, error? }`
- **Errors:** `Unauthorized`, `AuthorizationRequired` (discarded cleanly with `0` steps so `operationId` can be reused after completing `startAuthorityFlow`), `OperationIdConflict`, `WorkspaceExists`, `Paused`, `Busy`.

### 3. `new.flock.operator.execute` (procedure)

Submits or replays an idempotent workspace operation (`input: { workspace, operationId, request }`, `output: { operation }`). Validated strictly by `kind` (rejecting missing or extra fields):

| `request.kind` | Fields | R13 `opensocial.group` Effect |
|---|---|---|
| `inviteMember` | `subject: DID`, `expiresAt?: datetime` | Writes `membership/<subject>` (default roles) or outbound `group.opensocial.invite/<tid>` in `at://<subject>/space/group.opensocial.invites/self`. |
| `removeMember` | `subject: DID` | Deletes `membership/<subject>` in `members/self` (`O(1)` removal across all channels; Group Host atomically evicts writer repos across group spaces). |
| `setAdmin` | `subject: DID`, `active: boolean` | Adds or removes the `admin` role on `membership/<subject>` in `members/self` (enforcing human `LastAdmin` and `assignable`). |
| `createChannel` | `skey`, `name`, `visibility`, `members?: DID[]` | Creates `new.flock.channel/<skey>` (`group.opensocial.policy`; for `private`, creates `role/channel-<skey>` with `unlisted: true` and assigns `channel-<skey>` to selected `members`), writes `directory/<skey>`, and registers `notify`. |
| `transitionChannel` | `skey`, `visibility`, `members?: DID[]` | Transitions channel between `public` and `private` (`role/channel-<skey>` + `group.opensocial.policy` `unlisted` toggle + app grant preservation) while preserving the space URI. |
| `archiveChannel` | `skey` | Strips app grants, revokes write/read access on `new.flock.channel/<skey>`, removes `role/channel-<skey>` references, and marks `directory/<skey>` `archived`. |
| `decideJoinRequest` | `request: AT-URI`, `requestId: TID`, `decision: "approve" \| "deny"` | **Private-channel join requests** in `new.flock.inbox/self`: preserves all 9 step names for pre-R13 journal upgrade compatibility, grants `channel-<skey>` on `membership/<requesterDid>` when approved, and writes `new.flock.joinDecision`. |
| `decideGroupJoinRequest` | `member: DID`, `decision: "approve" \| "deny"`, `roles?: RecordKey[] (1..64)` | **OpenSocial group `approval` admission** (`decide-group-join-request.ts`): `"approve"` writes `membership/<member>` (`roles ?? defaultRoles`) with header **`If-Join-Request-Present: true`** (single-transaction check + admission + `join_request` cleanup + `join_operation_state` `'admitted'` update on Group Host; `409 JoinRequestNotFound` if cancelled/expired); `"deny"` calls `group.opensocial.denyJoinRequest({ member })`. |
| `leaveChannel` | `skey` | Member self-service: removes only `channel-<skey>` from `membership/<callerDid>`. |
| `installApp` | `subject: DID`, `channels: [{ skey, write }]` | Writes active `new.flock.app.install` (registering `subject` in `known_app_subject`), ensures `role/<appRoleKey(subject)>`, creates `new.flock.app.inbox/<appSkey>`, grants `read` on `meta`/`members`/`workspace`/`app.inbox` + channel `read`/`write` policies, and writes `membership/<subject>` (`[appRoleKey]`). |
| `updateAppAccess` | `subject: DID`, `channels: [{ skey, write }]` | Updates `new.flock.app.install` and converges `role/<appRoleKey>` grants across channel policies. |
| `uninstallApp` | `subject: DID` | **`RoleInUse`-safe order:** (1) removes `appRoleKey` from all space policies, (2) deletes `membership/<subject>`, (3) deletes `role/<appRoleKey>`, (4) sets `new.flock.app.install` `{ active: false, channels: [] }` last. |
| `enableExtension` | `extId: string` | Creates extension space (e.g. `new.flock.ext.tasks/<tasksSkey>`) with `group.opensocial.policy`, writes active `new.flock.ext.install`, and registers `notify`. |
| `disableExtension` | `extId: string` | Marks `new.flock.ext.install` inactive and updates extension space policy to block new writes. |

*(Internal/legacy replay kinds `bootstrapWorkspace`, `leaveWorkspace`, and `reconcileWorkspace` also remain registered in `OPERATION_KINDS` so historical journal rows replay cleanly.)*

#### Operation view, `aborted_actor_revoked` & `operationAdminTakeover` (`OPERATION_TAKEOVER_MIGRATION = 4`)

```json
{
  "operation": {
    "operationId": "3mabchjk3xyz2",
    "requestHash": "<64-char lowercase SHA-256>",
    "state": "completed",
    "completedSteps": ["group-join-approve-membership"],
    "takenOverBy": "did:plc:recoveringadmin",
    "updatedAt": "2026-11-21T18:00:00.000Z"
  }
}
```

- `state` is one of `'queued' | 'running' | 'pending' | 'completed' | 'failed' | 'paused' | 'aborted_actor_revoked'`.
- **Deterministic demoted-actor recovery (preventing permanent workspace wedging):** Journal rows keep immutable `PRIMARY KEY (workspace, actor /* ownerDid */, operation_id)`. When `resumeRecoverableOperations` encounters a pending row whose `ownerDid` was subsequently demoted or removed:
  1. **Member self-leave (`leaveChannel`) already satisfied** (`ownerDid` ejected or already lacks `channel-<skey>`): marks `'completed'` (`operationSatisfiedByState`).
  2. **Zero side effects committed (`completedSteps.length === 0`):** transitions `(workspace, ownerDid, operation_id)` terminally to **`state = 'aborted_actor_revoked'`** (`operationAbortedActorRevoked` audit event).
  3. **Partial durable state committed (`completedSteps.length >= 1`):** verifies that the **recovering human admin (`executorActor.did`)** independently holds live `effectiveMemberPermissions` + `assignable` coverage for `row.request` (`403` until a sufficiently privileged admin triggers recovery), sets **`operation.taken_over_by = executorActor.did`** (`takenOverBy` on `OperationView`), records **`operationAdminTakeover`**, subsequent step events, and `operationCompleted` in `audit_event` under `audit_event.actor = executorActor.did`, and replays the remaining idempotent steps to completion.

### 4. `new.flock.operator.getOperation` & `listStalledOperations` (queries)

- `getOperation({ workspace, operationId })`: returns `{ operation }` for an active effective human admin (or the original caller of an `endsOwnRole` operation).
- `listStalledOperations({ workspace })`: returns operations pending `>= 5 minutes` and failed/lapsed `notification_registration` entries for an active effective human admin.

### 5. `new.flock.operator.getDmNotifyTarget` & `getSpaceNotifyTarget` (procedures)

Both endpoints have identical wire schemas (`input: { space, credential, proof: { authorization, signatureInput, signature } }`, `output: { endpoint, token }`, `errors: ["Unauthorized", "InvalidRequest"]`) and verify a valid unexpired `SpaceCredential` (`sub === space`) + fresh RFC 9421 PoP (`audience = OPERATOR_SERVICE_REF`, mandatory signed `;created=<unixSec>` within `±60 s` and `<= exp`, single-use `pop:<hmac>` TTL replay lock in `oauth_request_lock`):

- **`getDmNotifyTarget`:** Accepts `new.flock.dm.inbox` and `new.flock.dm.conversation` spaces; mints a 30-min-epoch stateless **`dm1.<epochHex>.<b64url(callerDid)>.<hmac>`** token (`hkdf("flock-dm-notify-v1")`) feeding ephemeral in-memory `dm-feed-wakes.ts` (**zero SQLite rows**).
- **`getSpaceNotifyTarget`:** Asserts **`space === "at://" + callerDid + "/space/group.opensocial.invites/self"`** (`400 InvalidRequest` for any other authority, `spaceType`, or `skey`!); mints a 30-min-epoch stateless **`inv1.<epochHex>.<b64url(callerDid)>.<hmac>`** token (`hkdf("flock-invite-notify-v1")`) waking `getChanges` when inviting groups write/delete `group.opensocial.invite` records.

### 6. `new.flock.operator.getChanges` (procedure)

Authenticated with a Bearer service JWT (`lxm=new.flock.operator.getChanges`, up to `15 min`). Accepts followed space cursors and optional long-poll timeout; returns `{ head, changed, denied, reset }` — cursors only, never record bodies:
- Group spaces (`group.opensocial.{meta,members}` and `new.flock.{workspace,inbox,channel,app.inbox,ext.tasks}`): backed by `space_notification`, checking live `group.opensocial.policy` + `membership` read access (guarded by the `15 s` suspension circuit breaker).
- Personal `invites/self` space: authorized strictly when `space === "at://" + callerDid + "/space/group.opensocial.invites/self"`, woken by `inv1` webhooks.
- Sovereign DM spaces: merged from caller-scoped `(callerDid, space)` ephemeral wakes (`dm-feed-wakes.ts`), emitting `reset` across hub restarts.

---

## Inbound space webhooks (`com.atproto.space.confirmRegistration` & `notifySpaceUpdate`)

- **Constant-time token authentication (`auth: undefined`):** Matches `(space, token)` via `timingSafeEqual` against `notification_registration.token` (1-webhook-per-space for group spaces), `dm1` `[currentEpoch, currentEpoch - 1]` (DM spaces), or `inv1` `[currentEpoch, currentEpoch - 1]` (`at://<callerDid>/space/group.opensocial.invites/self`).
- **`#registrationExpired`:** Triggers immediate async renewal (`200 {}`) for Operator-managed group spaces; returns HTTP **`400`** for `dm1.*` and `inv1.*` tokens so personal PDSes run `abandonSyncerNotice` and drop closed browser tabs immediately.
- **`#spaceDeleted`:** For group spaces, Operator confirms `SpaceDeleted` via `authorizeSpaceSync` under the shared Group-DID session before purging `notification_registration` and `space_notification` rows.
