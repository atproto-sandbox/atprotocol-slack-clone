# R5 operator API: working notes and progress

Working file for phase R5 of `.ai/plans/platform-refactor.md` (sections "### R5", "### Operator service API", "### The
authority grant flow"). The plan's outcome section gets the summary at the end.

## Design decisions (taken from the code map, 2026-11-10)

- `getChanges` is a **procedure** (POST, JSON input), not a query: 200 entries of URL-encoded space URIs are about 24 KB,
  past Node's 16 KB request-header limit. Input `{ follow: [{ space, after }] }` (at most 200, each space once, `after` a
  decimal safe integer); output
  `{ head, changed: [{ space, cursor }], denied: [space], reset: [space] }`. Cursors are decimal strings of the global
  `space_notification.id`; a space's cursor in `changed` is its newest notice id. No entries: `head` at once.
- `reset`: a space whose `after` is below what was pruned for it, or above `head` (a cursor from another database). Pruning
  by age, authority or type raises a floor per space type (at most a handful of rows); a space's own 1,000 cap raises a
  floor for that space alone, so one busy channel does not reset everyone else's; a space floor at or below its type's is
  deleted, so the floor tables stay bounded. A spurious reset costs one sync; a missed change cannot happen. `head` is
  `sqlite_sequence`, so it never moves back when rows are deleted. An old table is replaced (notices are transient, D6).
- Caps: per space 1,000 and per authority 5,000 as today; the total cap of 50,000 becomes per space type (workspace,
  inbox, channel, DM inbox, DM conversation), so one busy type cannot evict another's (plan: "counted per space type").
- One shared poller per process: one `MAX(id)` read per second while any call waits; waiters re-check their spaces on a
  head change; a held call answers after about 25 s with empty lists.
- Authorization (`src/operator/member-access.ts`): DM spaces keep `authorizeDmSubscription`. Workspace, inbox and channel
  spaces need the authority's grant, a member list read with it, and the caller being the authority or `read: true` in
  it. Lists cached 60 s; `src/operator/members.ts` is the one way operator kinds change a member list and drops the
  cached list after each change; a deletion notice drops it too; a lookup failure denies; the check runs again on the
  spaces about to be answered.
- Service-token lifetime per method (`src/operator/security.ts`): 15 minutes for `getChanges`, 75 s for every other
  method, including the PDS's `notifyWrite` and `notifySpaceDeleted`. Clients ask `getServiceAuth` for `exp` (the
  pinned PDS allows up to an hour for a method-bound token) and reuse a `getChanges` token until a minute before expiry.
- Registration becomes the operator's: it mints a credential with the authority grant and registers its sink. The
  member-read paths that registered with member credentials stop doing so.
  - Creation: each kind that creates or archives spaces declares them (`createsSpaces`, `archivesSpaces`), and
    `afterOperation` registers or unregisters them once the operation completed. The request handlers that ran the
    operation pass the registration deps to `executeOperatorOperation` and `bootstrapWorkspace`; an operation resumed
    elsewhere (the reconcile job) is left to the sweep. Departure: the plan says registering is "one of that operation's
    steps"; `bootstrapWorkspace` must keep its step names, and a journal step would make the kinds' unit tests reach the
    network, so it follows the operation instead. It never takes the workspace lock either way. A failed registration does
    not fail the operation: it is recorded for the sweep.
  - Sweep: every journaled workspace's directory, read with the grant; registers active spaces whose registration is
    missing or within six hours of expiry. A lease row (`oauth_request_lock`, name `notify-sweep`) held for 30 minutes
    is both the mutual exclusion and the schedule. Runs at process start (`instrumentation.ts`) and from the reconcile
    script.
  - Failures: a `notification_registration_failure` row per space (workspace, failures, next attempt, last error),
    backoff per space, reported by `listStalledOperations`.
  - Archive and deletion unregister and drop the space's notices.
- `createWorkspace` runs `bootstrapWorkspace`; the caller (service token issuer) is the authority and needs its grant.
  `startAuthorityFlow` issues the ticket (the R1 rule stays: initiator = authority) and returns the start URL; the
  existing browser-start function is renamed `beginAuthorityFlow` to avoid two meanings of one name.
  `listStalledOperations` needs an active admin, as the route did.
- The cookie routes these methods replace stay until R6 deletes them, and each XRPC method and its cookie route call one
  shared operator function (as `/api/workspaces/bootstrap` already calls `bootstrapWorkspace`). Forwarding them through
  a service token was rejected: the server's member session carries an operator `rpc` scope only after an admin
  consent, so creating a workspace would gain a consent step. The SSE streams stay until R6.
- Engine: `OperatorClient` gains the four methods (with an `AbortSignal` for the long poll); `src/client/feed.ts`
  follows spaces in the stated order (head, sync, follow), mints on `denied` (a deleted space is then dropped by the
  credential cache) and syncs on `reset`.

## Steps

- [x] 1 lexicons, NSIDs, scopes, permission sets, codegen, route-table test
- [x] 2 per-method token lifetime + tests
- [x] 3 member-list authorization cache + `members.ts` wrapper used by kinds + deletion hook + tests
- [x] 4 notices: per-type caps, floors, feed queries + tests
- [x] 5 feed (`getChanges`): validation, authorization, shared poller, held re-check, route + tests
- [x] 6 registration: operator sink, failures/backoff, creation hooks, archive unregister, sweep + lease + schedule,
      start hook, reconcile script; member-read registration removed; stalled report + tests
- [x] 7 `createWorkspace`, `startAuthorityFlow`, `listStalledOperations` routes; cookie routes forward + tests
- [x] 8 engine `OperatorClient` methods + `feed.ts` follower + tests
- [x] 9 gate: Node script following a channel live with only a member session; K3 against the real methods
- [x] 10 docs, CODE-MAP, plan outcome, review, gate suites, commit

## Results so far

- Gate, live follow (`protocol-tests/feed-follow.test.ts`, in `test:acceptance`): a reader with only its PDS session follows
  `#general` through `getChanges`; another member's message reached its page 154 ms after the write, on the first poll.
- K3 (`protocol-tests/platform-capabilities.test.ts`) calls the four new methods through their route handlers with the
  member grant's tokens: `getChanges` (head, and a space it may not follow denied at once), `listStalledOperations`,
  `startAuthorityFlow` (a ticket URL) and `createWorkspace` (refused with `AuthorizationRequired`, the token accepted, the
  admin holding no authority grant of its own). K3 and K7 pass.
- A feed call whose every space is denied now answers at once (found by K3: it waited the whole hold).

## Review round 1 (reviewer + critic) and what changed

- Critical, fixed: an existing database could not open (the new index ran before the old notice table was replaced). The
  replacement now runs first, inside the write lock, and only when the old table exists; `src/lib/db-migration.test.ts`.
- Fixed: the notice write took its transaction as a reader first (a second writer process could make it fail and lose the
  notice); `.immediate()`.
- Fixed: two client hot loops (a denied space the member can still mint for; a sync that keeps failing). A round that
  could not finish waits five seconds (abortable) before the next poll. The server still answers an all-denied call at once.
- Fixed: a client clock ahead of its PDS was refused its long-poll token. The operator now bounds a token by its age from
  the PDS's `iat` only; `exp` is the client's ask on the client's clock.
- Fixed (bounding, not limiting): a workspace, inbox or channel space the operator never registered is denied before any
  grant is restored or member list read, so a caller can make the operator read only real spaces' member lists, each
  cached 60 s. Not done here, recorded as a residual for R7 (the operator as its own service): a cap on held calls overall
  and a per-IP limit at the edge; the existing operator methods have none either.
- Fixed: the sweep drops what it holds for spaces no longer active (an archive finished by the reconcile job); a deleted
  space's failure row goes with it; retries are at most an hour apart (about six in the renewal window); the sweep does not
  run while mutations are paused (registering writes at the authority's host); registration problems are `WARN` lines that
  do not fail the reconcile run (a space without ticks falls back to the hourly check), and the admin screen lists them.
- Fixed: the poller's timer guards a failed read; cursors are bounded to safe integers (lexicon `maxLength` 16);
  `createWorkspace` lists `Paused` and `Busy`; tests for `members.ts`, the old database, the new cleanups; the per-type
  cap test no longer records 50,000 notices one by one (84 s to 9 s).
- By design, recorded: the authority and type caps raise a per-type floor (an idle follower pays one spurious sync per
  about 5,000 notices from a hot authority); the member-list cache is dropped per process (D12's 60 s across processes).

## Review round 2 (fix delta) and what changed

- Fixed: the sweep could unregister a space an operation registered while the sweep read the directory; it now reads what
  it holds before the directory (a directory record is written before its space is registered). Test reproduces the race.
- Fixed: my own edit had turned the lexicon's 200-entry `follow` limit into 160; a test now pins it to the code's bound.
- Fixed: operations the reconcile job resumes now register their spaces too (`resumePendingWorkspaceBootstraps` and the
  resume inside `executeOperatorOperation` take the registration deps), so the gap is only a crash between completing and
  registering, which the sweep covers.
- Fixed: the feed's registration check is scoped to this operator's service ref for the registration table (a primary-key
  lookup; the failure table has no service column, and a failure row still marks a real space), exported as
  `isRegisteredSpace` and tested against the database; expired member lists are pruned when a new one is cached; a deleted
  space's failure row goes with it (tested); the follower's pause after a still-followed denied space is tested; an unsafe
  cursor is refused (tested).

## Review round 3 (round-2 delta)

- No correctness defect. Done: a test that resumed operations register their spaces (`journal-replay.test.ts`); a failed
  registration after a resume is audited as `operationRegistrationFailed`, not as a failed resume; the member-list cache is
  pruned at most once a minute; the benign reverse race (an archive finishing during a sweep is registered again, dropped
  by the next sweep) is documented at the sweep.
