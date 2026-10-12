# PRD: atproto-slack-clone

Status: core app and browser OAuth authorization-code acceptance complete; production deployment and limited-workspace pilot evidence remain pending  
Date: 2026-09-25  
Protocol baseline: atproto permissioned data proposal 0016 draft semantics, reviewed on 2026-09-24 and verified against pinned PDS commit `5b95b2f2` plus the checked-in strict-expiry overlay in [`docs/protocol/atproto-spaces-pin.md`](../protocol/atproto-spaces-pin.md). API/policy and strict credential-expiry conformance pass with that overlay; the unmodified upstream base still accepts five seconds after `exp`, so production must use the overlay or a compatible upstream revision. Proposal and implementation drift remains a release blocker. [Proposal 0016](https://github.com/bluesky-social/proposals/blob/main/0016-permissioned-data/README.md)

## Problem

Small teams need a shared workspace on atproto with channels visible to workspace members, private channels that hide messages and rosters until approval, and join requests visible only to workspace admins. The same records must produce the same workspace in independent apps. PDS member lists control who can read each space; app databases do not decide read access.

## Users

- **Workspace owner.** Creates and controls the dedicated workspace DID, appoints admins, and grants the workspace authority operator the OAuth `manage=update` permission it needs to manage spaces under that DID.
- **Workspace admin.** A workspace member with a current authority-authored admin record. Can invite/remove workspace members, manage channels, and decide private-channel requests through an authorized workspace authority operator.
- **Workspace member.** Reads public channels, sees private-channel names, posts in channels they can read, and requests entry to private channels.
- **Second-app developer.** Reads the same lexicons and records and renders the same workspace. For administrative writes, the app must obtain workspace-authority authorization and apply the same state transition rules; it cannot use its own database as the membership source.
- **Workspace authority operator.** A trusted service controlled by the workspace owner. It serializes administrative mutations, checks the caller's admin record, and performs member-list and authority-record writes with the workspace DID's authorized session. It also lists inbox write-member DIDs for notification recovery, but never reads or returns request bodies. It is not consulted when a PDS decides whether to mint a read credential.

## Product behavior

1. The owner creates a workspace with a dedicated DID and becomes its first admin. An admin invites a DID; invitation grants that DID workspace membership. The recipient opens the workspace link and writes an acceptance marker into their own permissioned repo so other apps can discover the workspace from that account. Declining means leaving the workspace.
2. Each channel has its own space under the workspace DID. A workspace member can see every channel name and whether it is public, private, transitioning, or archived. They can read a public channel. They can read a private channel only after an admin approves them.
3. A member requests a private channel. The request is visible to admins and its author only. Other workspace members cannot read the inbox space or enumerate its request repos.
4. An admin approves or denies a request. Approval adds read and write membership to that channel. An approved member sees the current channel roster, including members who have never posted.
5. An admin can make a public channel private without changing its space URI or relocating messages. During conversion, compliant apps show the channel as transitioning and do not begin new syncs. Removed members cannot mint new credentials after removal propagates; existing credentials may continue to work until their expiry, ten minutes by default (the protocol ceiling is one hour).
6. A member can leave the workspace or one private channel. An admin can remove or demote a member. Workspace removal revokes access to the workspace, every public channel, and every private channel the member belongs to. PDS membership is the read gate; authority-authored roster records update the display.
7. A workspace always has at least one active admin. The last admin cannot leave, be removed, or be demoted until another admin is active.
8. A channel can be archived. Archived channels are removed from normal navigation and new credentials are no longer issued to members; existing credentials retain the protocol's expiry behavior. The channel records remain in their authors' repos.
9. Members may edit or delete their own messages and reactions. They cannot edit or delete another member's records. V1 messages are text-only; attachment upload and blob serving are deferred.

## Scope

V1 includes multiple workspaces per account, workspace invitations, public and private channels, text messages, one-level thread replies, reactions, private-channel requests, member and admin management, channel privacy transitions, archive, and cross-app read interoperability.

V1 does not include internet-public channels, direct messages, nested threads, file uploads, presence, calls, search, push notifications, external workspaces, workspace transfer, or guaranteed erasure of data already copied by a previously authorized reader.

“Public channel” means readable by every current workspace member. No channel is readable by every atproto account. Private channel names are visible to workspace members; private messages, member rosters, and request records are not.

## Protocol and authority model

Each space is anchored on the dedicated workspace DID. Members write records to their own permissioned repos. Apps assemble a view by syncing the writer set and reading each repo with a space credential. `readPolicy` controls credential issuance. `writePolicy` controls whether a writer is tracked in `listRepos` and its notifications are forwarded; it does not prevent an account from writing to its own repo. OAuth scopes limit the record actions a compliant app requests, while apps must also validate record authors and schema semantics. A space credential is a read capability, not a message-write grant.

The current proposal's member-list entries have separate `read` and `write` booleans. The workspace and channel spaces use member-list policies. Workspace members have `read=true, write=true` in the workspace, `read=false, write=true` in the inbox, and `read=true, write=true` in each public channel. Active admins have `read=true, write=true` in the inbox. Approved private-channel members have `read=true, write=true` in that channel. Thus a requester appears in the inbox writer set admins sync without receiving inbox read access. `appAccess` is open for all three space types. The implementation must use the pinned proposal/PDS revision rather than infer membership methods from the incomplete local schema subset.

| Space | Type NSID | Read policy | Write policy | Read members | Purpose |
|---|---|---|---|---|---|
| Workspace | `org.slack.workspace` | `member-list` | `member-list` | Current workspace members | Channel directory, workspace roster, admin records, acceptance markers |
| Channel | `org.slack.channel` | `member-list` | `member-list` | Public: all workspace members; private: approved channel members | Messages, replies, reactions, and private roster |
| Admin inbox | `org.slack.inbox` | `member-list` | `member-list` | Read: active admins and workspace authority. Write: all workspace members. | Join requests and authority-authored decisions |

The authority operator is the only v1 service allowed to mutate membership and authority-owned records. The operator uses a workspace DID session authorized by the owner. It authenticates the acting person's DID, reads the current `org.slack.admin` state from the workspace space, verifies current workspace and inbox membership, rejects inactive/non-admin callers, and then applies the mutation. An admin record by itself does not grant a protocol `manage` scope. The operator stores only an operation journal for retries; current membership and roles are derived from the PDS member list and authority-authored records. It does not answer credential or read-access checks.

`putMember` sets a member's current read/write booleans; `removeMember` removes the member. Implementations must map these semantics to the exact method names and lexicons in the pinned PDS revision. All administrative transitions are serialized per workspace. Operations are idempotent and resumable after partial failure. The operator reconciles desired membership from authority records and space member lists; it reports an operation as complete only after all affected spaces agree.

`listRepos` is a writer set, not a membership list. It can omit silent readers. Its contents are maintained from `notifyWrite` calls received by the authority PDS. A dropped app-level notification is repaired by the next `listRepos` sweep, but a dropped PDS-to-authority `notifyWrite` is absent from `listRepos` until another notification arrives. The owner-only recovery method enumerates inbox members with `write=true`; an admin then reads candidate repos using its inbox credential. A workspace/channel credential does not grant an app authority-only `listMembers` access. The workspace roster and private channel roster records are the display sources; PDS member lists are the read gate.

### Discovery and privacy

The workspace owner or admin shares the workspace URI out of band after the authority operator has granted membership. The invitee opens that URI and writes one `org.slack.acceptance` marker in their own repo. A later app discovers the workspace through the account's spaces index and reads the directory with a workspace credential. Membership begins when the operator completes the invite; acceptance records discovery, and declining is a leave operation.

The directory has one current record per channel, keyed by `skey`, with `name` and `visibility`. It contains no member DIDs. Private names are intentionally visible to workspace members. A private roster has one current authority-authored record per DID, keyed by a stable hash of that DID, with `active: true|false`. Apps show active roster entries only after obtaining the channel credential. They ignore roster records authored by anyone other than the workspace DID.

For a join request, the requester's repo holds at most one current request record per `(channel, requester)`, at a deterministic record key. The record includes a fresh `requestId` and `createdAt`. Retrying or resubmitting updates that record with a new `requestId`; a request is pending only when its current `requestId` has no matching authority-authored decision. The decision references both the request URI and `requestId`, so a late decision cannot approve a replacement request. Admin clients group duplicate/stale notifications by the current request record instead of showing them as separate requests. A requester may withdraw or delete their request at any time; the operator never deletes a requester-owned repo record.

The inbox member list gives every workspace member `write=true`; ordinary members have `read=false`, while active admins have both `read=true` and `write=true`. Thus a requester can write their own request and appear in the writer set without receiving an inbox credential. The requester reads only their own record from their own repo. Other members cannot obtain inbox credentials. Notifications are best-effort. Inbox syncers reconcile `listRepos` at least once per minute for missed app notifications and reconcile the operator's writer-candidate list at least once per minute for PDS-to-authority notification loss. They read candidate request records directly from member repos using an inbox credential. Leaving the workspace removes the member from the inbox writer list.

## Lexicons and current-record rules

All records use stable keys for mutable state so independent apps read the same current value without inventing event-order rules. Timestamp fields are informational; they do not decide which state wins. Hash keys use SHA-256 over UTF-8 bytes, encoded as lowercase RFC 4648 base32 without `=` padding, with `:` between every base32 symbol. The separators keep accidental words in a digest from triggering the pinned PDS's explicit slur check; they are part of the canonical key. Inputs with multiple components join the canonical URI/DID/emoji strings using one NUL byte (`U+0000`). For a DID, `subjectKey` is `d-` plus the delimited hash; a request key is `r-` plus the delimited hash of `channel URI + NUL + requester DID`; an acceptance key is `a-` plus the delimited hash of the workspace URI. A request's fresh `requestId` is a TID. A reaction key is `x-` plus the delimited hash of `message URI + NUL + emoji + NUL + author DID`. A decision key is `q-` plus the delimited hash of the request URI. The private roster uses `subjectKey`; the directory key equals its `skey`. Apps use these exact canonical encodings.

**`org.slack.workspace`**

- `org.slack.workspace.profile`: one authority-authored workspace display name, stored at key `self`. It supplies a stable name to independent apps; the workspace space key remains the protocol identity.
- `org.slack.directory`: one record per channel, `skey`, `name`, `visibility` (`public` | `private` | `transitioning` | `archived`). `transitioning` is excluded from new sync and credential requests by compliant apps.
- `org.slack.workspace.roster`: one record per DID, `subject`, `active`, `updatedAt`; author must be the workspace DID.
- `org.slack.admin`: one record per DID, `subject`, `active`, `updatedAt`; author must be the workspace DID. Only active records confer admin status in compatible apps.
- `org.slack.acceptance`: one marker per workspace in each accepted member's repo, `workspace`, `createdAt`.

**`org.slack.inbox`**

- `org.slack.joinRequest`: `channelSkey`, `requestId`, `createdAt`; author is the requester. One stable record key per channel/requester.
- `org.slack.joinDecision`: `request` URI, `requestId`, `decision` (`approve` | `deny`), `updatedAt`; author must be the workspace DID. One current decision per request URI.

**`org.slack.channel`**

- `org.slack.channel.message`: `text`, `createdAt`, optional `parent` URI. Replies point directly to a top-level message in the same channel; nested replies are invalid.
- `org.slack.channel.reaction`: `subject` message URI, `emoji`, `createdAt`. One current record per `(author DID, message URI, emoji)`; deleting that record removes the reaction.
- `org.slack.channel.roster`: one current record per DID, `subject`, `active`, `updatedAt`; used only for private channels and authored by the workspace DID.

Unknown collections, malformed records, records with cross-channel references, and authority-only records with the wrong author are ignored by compliant apps. V1 text is plain text, not HTML, and is limited to 10,000 Unicode code points per message. The UI escapes markup and validates text length before writing. Message/reaction updates and deletes are permitted only for the record's author.

## Permissions

The OAuth permission sets are scoped to the workspace/channel type, authority DID, `skey` where applicable, collection, and action. The operator's workspace DID session is provisioned with `action=read_self` for owner-only `listMembers`, `action=read` for owner-authorized reads and delegation-token issuance, and `action=read_self` combined with `manage=create` plus `manage=update` for each of the three space types. Combining the management grant with `read_self` avoids the scope grammar's default record actions. It receives create/update/delete only for `org.slack.directory`, `org.slack.workspace.roster`, `org.slack.admin`, `org.slack.joinDecision`, and `org.slack.channel.roster` in their respective space types. `authority=self` resolves to the workspace DID; `skey=*` covers its workspace, inbox, and channels. It has no message or reaction write scope.

Human admins authenticate to the operator with short-lived service-auth JWTs. Each admin's OAuth grant includes one RPC permission per method, scoped to the operator's published DID service reference: `org.slack.operator.execute`, `org.slack.operator.getOperation`, and `org.slack.operator.listInboxWriters`. The app calls `com.atproto.server.getServiceAuth` with that exact audience and the method NSID as `lxm`; the operator verifies the JWT signature, `iss`, audience, expiry, and method. The actor DID comes only from verified `iss`, never a request field. The operator rechecks current workspace roster, active admin record, and inbox read membership on every method. It keys idempotency by `(workspace DID, actor DID, operationId)`; a replay with the same canonical request hash returns the existing journal row, and reuse with a different hash is a conflict. `listInboxWriters` returns only current inbox member DIDs with `write=true`, not record data.

A normal member requests only:

- Workspace read plus create/update for their own `org.slack.acceptance` record.
- Inbox create/update/delete for `org.slack.joinRequest`; no inbox read or list permission.
- Channel read plus create/update/delete for `org.slack.channel.message` and `org.slack.channel.reaction`; no write permission for channel roster, directory, or admin records.

An active admin's app additionally needs an authorized workspace DID session with `manage=update` for member operations and create/update/delete for directory, roster, admin, and join-decision records. Space-type permission-set declarations publish the collections and operations. Implementations must request only the narrow scopes needed for the current operation; the user must be able to deny or revoke those grants.

The permission set is an app authorization request, not role-based enforcement against arbitrary clients. A user can use another client or a broader OAuth grant to write records into their own repo. Therefore, authority-owned records count only when the workspace DID authored them, and every compatible app applies the current channel/member rules before displaying content. PDS member lists remain the enforceable read boundary.

## Administrative workflows and failure behavior

### Invite and join the workspace

The admin service validates the caller's active admin record and workspace DID authorization. It calls `putMember` for workspace read/write membership, inbox write-only membership, and read/write membership in each public channel; it then writes the workspace roster as active and sends the invitation URI to the invitee. The invitee records acceptance by writing the marker. Retry after a write conflict by reading the current record and applying the same desired state. If the PDS operation fails, the UI reports the invite as pending and the operator resumes reconciliation; it never reports a completed invite before all required membership is present.

### Add or remove a workspace member

The serialized operator records the desired state, updates workspace membership, inbox write membership, and public-channel membership, and updates the workspace roster. For removal it removes access from the inbox and all directory channels, including private channels where the member is present, then removes workspace access and marks the workspace roster inactive. Completion is reported only after `listMembers` on every affected space matches the desired read/write state. A failed or interrupted operation remains visibly pending and resumes automatically. Cached credentials can work until they expire; the UI must state this two-hour maximum default.

### Create or change a channel

The operator creates one channel space and its directory record. For a public channel, it adds every current workspace member with read/write membership before publishing the channel as public. For a private channel, it adds only selected members and writes their active private roster records before publishing it as private. Membership changes and directory changes run as one serialized operation per channel.

### Request, approve, or deny private-channel access

The requester upserts their stable join-request record and notifies admins best-effort. Admin inbox sync periodically reconciles `listRepos` and unions it with `listInboxWriters` from the operator; this recovers a writer missing from the authority PDS's writer set. The admin app reads candidate records with its own inbox credential, and the admin service reads the current request record and verifies the matching `requestId` before deciding. For approval, it adds read/write channel membership, writes the active private roster record, then writes an `approve` decision for that request generation. For denial, it writes a `deny` decision and does not add channel membership. A failed approval remains pending until membership, roster, and matching decision are all present; clients do not treat the request as approved before they can mint a channel credential.

### Make a public channel private

The operator sets the directory to `transitioning`, writes the selected private roster snapshot, removes all other members from the channel, then sets `visibility=private`. A failed step leaves the directory transitioning and the operator resumes from current PDS state. A second app does not label the channel private until the final record is present. Previously issued credentials may remain valid until expiry; a compliant app stops syncing once it observes `transitioning`.

### Make a private channel public or archive it

To make a channel public, the operator sets it to transitioning, synchronizes read/write membership to the current workspace roster, then publishes `visibility=public`. Old private roster records are ignored while public and replaced from the new current membership set if the channel later becomes private. To archive, it sets `visibility=transitioning`, removes all channel members, then publishes `visibility=archived`. Archived messages remain in author repos; no new member credentials are issued.

### Leave, demote, or remove an admin

Members can request to leave their own private channel or workspace through the authority operator; the operator verifies the caller DID and applies the same removal fan-out as an admin removal. A member cannot use this flow to remove anyone else. The operator prevents the last active admin from leaving, being removed, or being demoted until another admin is active. It updates the inbox `read` membership and the admin record as one resumable operation. On promotion, it writes the active admin record and grants inbox read access; on demotion it removes inbox read access before marking the admin inactive. Workspace/channel member read/write access is unchanged by a demotion. Admin status is the current authority-authored record, not an event-log reduction. Any app that cannot read the current workspace records cannot safely offer admin controls.

## Sync, retention, and operations

Syncers use notifications for prompt updates and periodic reconciliation every 60 seconds. The admin inbox unions `listRepos` with the operator's owner-authorized writer-candidate list, so it recovers both a missed app notification and a dropped PDS-to-authority `notifyWrite`. It retains the last successfully synced revision per repo and avoids full re-fetch when the revision has not changed. Clients page message history and load the latest 100 messages first. V1 supports workspaces up to 200 members, 100 channels, and 20,000 messages per channel; exceeding the envelope is a documented degraded mode, not silent truncation.

The authority operator keeps a durable operation journal containing operation ID, target spaces, desired membership/state, completed steps, and last error. It contains no message bodies and is not the membership source of truth. It retries transient PDS/network failures for up to four total attempts with 100/200/400 ms backoff, exposes pending/failed state to admins, and alerts after five minutes without progress. Retries cover HTTP 408, 425, 429, 5xx, and recognized temporary socket/DNS timeout errors; authorization, validation, and other permanent failures are not retried. Journaled mutation steps use stable keys and desired-state writes so retries are idempotent. A periodic reconciliation compares directory, roster, and member lists and repairs drift. The operator never marks a transition complete when any affected PDS mutation is unknown.

An app that has cached private data must stop new sync immediately on transition/removal and discard its cached copy after its credential can no longer be renewed. Previously authorized users can retain copies they already downloaded; the product does not promise remote erasure. PDSes and syncer transport use HTTPS. The operator encrypts its workspace credential at rest, never logs credentials or message bodies, and records an audit entry for each admin mutation (actor DID, action, target URI, result, timestamp).

## Interoperability rules

A compatible app:

- Implements the pinned proposal 0016/PDS behavior for read and write policies, credentials, member operations, and writer-set sync.
- Treats each channel as a separate `org.slack.channel` space and uses the workspace directory to locate it.
- Treats `listRepos` as a writer set only; it never infers silent membership from it.
- Uses PDS member lists as the read gate and validates current workspace-DID-authored roster, admin, directory, and decision records.
- Shows the workspace roster in public channels and the channel roster only in private channels after credential issuance.
- Does not copy channel messages, private rosters, join requests, or decisions into another space.
- Uses the authority operator only for serialized administrative mutation and inbox writer-candidate recovery, never as a credential/read-access oracle.
- Reconciles missed notifications and treats transitioning channels as unavailable for new sync.

If the pinned PDS does not implement any required operation or security behavior, the feature is blocked at the protocol gate; the app must not emulate a missing read gate in its own database.

## Threat model and limits

| Actor | Can | Cannot |
|---|---|---|
| Workspace member | Read workspace directory/roster, public channels, and private channels they joined | Read private messages/rosters or inbox requests without a credential |
| Join requester | Write and read their own request record | Read the inbox writer set or other requesters' repos |
| Admin | Review requests and request authority mutations | Mint a credential for a DID absent from the channel member list |
| Removed channel member | Use an already issued credential until expiry and retain previously downloaded copies | Mint a new credential after member removal propagates |
| Workspace authority operator | Manage the workspace DID's spaces and authority records | Override PDS read policy or grant themselves membership records not present in the authority state |
| Author's PDS host | Read plaintext records authored by its account | Read other members' repos without a credential |
| Workspace PDS host | Read its authority repo, member lists, and records it hosts | Be removed from the trust required to host the workspace DID |
| Rogue member client | Write records to its own repo when the user grants OAuth permission | Make its records count as workspace authority records |

There is no end-to-end encryption. The workspace PDS, author PDSes, authority operator, and every approved reader may see plaintext they host or sync. The protocol cannot erase records already copied by a former reader.

## Acceptance criteria

- Two independent apps, using only the published lexicons, user OAuth, space credentials, and the workspace authority operator for authorized mutations, render the same workspace directory, current roster, channel messages, and private-channel roster.
- A workspace member sees private channel names but cannot mint a credential or sync a private channel they have not joined.
- A non-admin workspace member cannot mint an inbox credential or read another member's join request. An admin discovers a request after 60 seconds when either the app notification or the PDS-to-authority writer notification is dropped; the latter is recovered by enumerating `write=true` inbox members through the operator and reading repos with the admin's inbox credential.
- Approval adds channel read/write membership and the active roster entry before the request is shown as approved; denial grants no channel membership.
- A read request/write member policy configuration allows a requester to write their own request without granting them inbox read access, and the PDS tracks that repo for inbox readers.
- Removing a member prevents new credential issuance after the PDS membership update; an already issued credential works no longer than its expiry. Push/record writes and read access are tested as separate protocol behaviors.
- Making a public channel private preserves its URI and messages, blocks new credentials for removed members after transition completion, and displays transition state during partial failure.
- A failed multi-space membership update is visible as pending, resumes after operator restart, and converges to PDS member lists matching authority records.
- An app ignores spoofed authority records and does not infer membership from `listRepos`.
- Stopping either UI app does not change PDS member lists or records; stopping the authority operator pauses mutations but does not change already committed state.
- V1 performance remains within the stated envelope and renders the latest 100 messages first without requiring an unbounded workspace-wide message download.

## Implementation gate and release status

The unmodified pinned PDS source accepts credentials for five seconds after signed `exp`. The checked-in verifier patch removes that allowance for space credentials, and the strict cutoff now passes unit and two-PDS conformance at the pinned base revision. The overlay must be included in any deployed PDS build unless upstream adopts equivalent behavior. Six pinned PDS conformance suites passed with 108 tests passing and one upstream todo across the API, policy, OAuth, writer-recovery, and patched expiry behavior. The exact base revision, patch hash, measured expiry boundary, and operator contract are recorded in `docs/protocol/`. Core app implementation and local build checks are complete, but the launch gate remains open.

The pinned protocol and implementation remain subject to drift. Before release, rerun conformance against the intended deployment revision and demonstrate the two-app acceptance matrix and supported-size performance envelope in a deployed pilot. Do not substitute app-database access checks for PDS read authorization if the pinned behavior changes.
