# Workspace Authority Operator Contract

Version: 1  
Protocol pin: [`atproto-spaces-pin.md`](./atproto-spaces-pin.md)

## Service identity and authentication

The operator publishes a DID service entry with ID `#atproto_flock_operator` and type `AtprotoFlockOperator`, resolving to its XRPC base URL. The exact service reference is `OPERATOR_DID#atproto_flock_operator`.

An admin app obtains a one-minute-default service JWT from the user's PDS with `com.atproto.server.getServiceAuth`, setting `aud=OPERATOR_DID#atproto_flock_operator` and `lxm` to the exact operator method. The user OAuth access token must contain the matching `rpc:<method>?aud=OPERATOR_DID%23atproto_flock_operator` scope. The app sends the resulting token as a Bearer service-auth token to that XRPC method.

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

Parameter: `workspace`. Returns all current inbox member-list DIDs with `write=true` (at most the 200-member launch envelope). It calls owner-only `listMembers` using the workspace DID session. It never reads or returns request records. The admin app uses its own inbox space credential to read each candidate repo from its PDS. `listRepos` remains the fast writer index; this method recovers writes whose PDS-to-authority `notifyWrite` was lost.

## Idempotency, ordering, and journal

The operation key is `(workspace authority DID, verified actor DID, operationId)`. The operator computes the request hash over canonical JSON bytes for the validated `{ workspace, request }` object, then SHA-256. Replaying the same key and hash returns the current journal status, including for a caller whose own operation, one of the four above, has since removed their role. Reusing the key with a different hash returns `409 OperationIdConflict` and makes no PDS calls.

The operator serializes mutations per workspace. Each journal row stores the operation key, canonical request hash, desired state, ordered PDS steps, completed steps, status, last error, and timestamps. It stores no message content, join-request body, OAuth token, service JWT, or space credential. Periodic reconciliation first resumes incomplete journaled operations, then compares stable authority records with PDS member lists. The journal is retry metadata, never the membership or role source of truth. The admin view alerts after five minutes without progress.

One run of an operation starts no step once it has held the workspace's lock for three minutes. The operation is then answered as `pending`, with a time-limit error and the steps it completed, and sending it again continues it. A caller waits up to 100 seconds for the lock. A client should therefore allow about five minutes for an `execute` answer. That is a budget, not a bound: the step in flight at the limit still ends, and earlier pending operations are resumed first, each with its own wait and run. A client that gives up earlier loses nothing, because the operator carries on and the same operation sent again returns its state.

## OAuth scopes

The initial login includes `space:new.flock.workspace?authority=*&collection=new.flock.acceptance&action=read_self` so the app can discover a workspace from the account's spaces index before it knows the authority DID. `read_self` supports `listSpaces`; it does not grant access to workspace records. Later user actions request narrower workspace, channel, or inbox scopes for the selected workspace.

Admin user sessions request one scope for each XRPC method:

```text
rpc:new.flock.operator.execute?aud=OPERATOR_DID%23atproto_flock_operator
rpc:new.flock.operator.getOperation?aud=OPERATOR_DID%23atproto_flock_operator
rpc:new.flock.operator.listInboxWriters?aud=OPERATOR_DID%23atproto_flock_operator
```

The operator's separate workspace DID session has only the space-management, owner-read, and authority-record write scopes listed in [`atproto-spaces-pin.md`](./atproto-spaces-pin.md#authority-operator-scopes). It has no message, reaction, or join-request write access.

A member requesting self-leave receives only the `new.flock.operator.execute` scope. The operator limits that actor to self-only leave requests; the scope grants neither operation lookup nor inbox-writer access.
