# Plan: one client engine, a service-owned authority, and apps as members

Status: draft for approval. Reviewed by Codex in five rounds, the limit of the review procedure. Every round returned REVISE; the findings went from eleven to ten, three, two and one, and in the last round the reviewer reported no other blocking issue. That last finding is applied here and has not been re-reviewed, so the plan does not carry an APPROVED verdict. See "Review rounds". Nothing here is implemented. Written 2026-11-09 against `5113d60` on `chore/protocol-drift-5d88b41`, pinned PDS `5d88b414`, proposal `701ef9c6`. It turns the proposal in `.ai/reviews/fable-project-review-platform-refactor-5113d60.md` (findings F1 to F11) into phases.

## Decisions already made (owner, 2026-11-09)

1. The member session moves to the browser, as direct messages already work. The server stops holding member sessions.
2. The workspace authority grant is separated from the creator's sign-in now. A dedicated workspace account comes later (R8).
3. The first proof of the platform is a bot. This replaces decision 3 of `.ai/plans/platform-extensions-tasks.md` ("tasks first"); tasks become R11.
4. The lexicon namespace is the domain `flock.new`, so every NSID starts with `new.flock.`.

## Goal and non-goals

Goal: the product becomes a platform in Slack's sense. A third party can build an app that has its own identity, is granted access to chosen channels by an admin, reads and writes through published lexicons, and receives change events, using the same client library the first-party web app uses.

Not in this plan:

- Publishing anything outside the repository: lexicon records, DNS records, packages, upstream requests. Each is an owner action and is listed where it becomes a prerequisite.
- Visual redesign. UI changes are data flow and logic only; the styling stays as it is.
- Product features unrelated to the platform shape (profiles, mentions, unread state, files, search, a thread view). The engine makes them cheaper; they are separate plans.
- Backwards compatibility. Local databases and test PDS data are disposable (D6).

## Facts the design rests on

Read from the code and the pinned checkout on 2026-11-09. None was reproduced at runtime; R0 covers the ones a phase depends on. These are observations of one implementation at one commit, not guarantees about a deployment.

| Fact | Where | What it allows or forces |
|---|---|---|
| The operator acts with the creator's ordinary OAuth session, from the one DID-keyed session table | `src/operator/security.ts:78`, `:111`; `src/auth/oauth.ts:144-160`; `src/lib/db.ts:65-69` | Sign-out revokes and deletes that row (`src/app/api/oauth/logout/route.ts:14`). A new sign-in (`src/app/api/oauth/login/route.ts:23`) and the public-client lifetime (`src/auth/oauth.ts:53`) can leave it without the authority scopes or expired. Which admin operations then fail, and when, is what K1 establishes. R1. |
| The pinned provider supports `private_key_jwt` clients and gives them a two-year session and a three-month refresh window; loopback clients are always public | pinned `oauth-provider/src/client/client.ts:53`, `:101-105`, `client-manager.ts:329-337`; `keyset` option in `@atproto/oauth-client` | The authority client can be confidential in a real deployment. Loopback development stays public. |
| A space scope may name `authority=*` and omit the space key; an RPC scope takes repeated `lxm` parameters | pinned `oauth-scopes/src/scopes/space-permission.ts`, `rpc-permission.ts`; `DM_BROWSER_SCOPES` and `operatorMethodsScope` in `src/auth/permission-sets.ts:42-61`, `:167-170` | One consent at sign-in can carry every scope a member needs. A scope only says what this app may ask for; the space policy, the member list and the operation still decide each call. |
| `getDelegationToken` requires the OAuth `read` permission for the space | pinned `pds/src/api/com/atproto/space/getDelegationToken.ts:24` | An admin reading the join-request inbox needs inbox `read` in the grant. The published `permissions.member` set lacks it. |
| `registerNotify` is authenticated by a space credential, names a service, and lasts about a day | `lexicons/com/atproto/space/registerNotify.json`; pinned `registerNotify.ts:12`; `src/atproto/notifications.ts:17-37` | Registration does not need a member session. Whoever owns it must renew daily and notice failures; today a failure is swallowed (`notifications.ts:34`). |
| `listRepos` is paginated (1,000 per page), returns each writer's `repoRev` and `spaceRev` as last reported to the authority, and takes a `spaceRev` cursor. It is not authoritative and may lag the writer's host | `lexicons/com/atproto/space/listRepos.json:7`, `:17`, `:64` | A cheap hint about which writers changed. Not proof that a writer did not change, and not a bound on record keys: revisions come from the host's clock (pinned `transactor.ts:209`), message keys from the writing client (`src/app/api/channels/messages/write/route.ts:42`), and reaction keys are hashes. |
| `listRecords` orders by record URI and pages by a URI bound | pinned `pds/src/actor-store/space/reader.ts:105-128` | A listing can be repeated from the top down to a chosen key. It is not a snapshot: a write during paging is seen only by a later pass. |
| Removing a member, or setting `write: false`, also removes that account from the space's writer set | pinned `pds/src/space-policy/manager.ts:109-112`, `:124-129` | A client that starts fresh after someone was removed does not find their earlier records. This holds today for any account without a cache; the plan states it and makes every client behave the same way (D14). |
| `listRecords` responses carry no MAC; only `getRecord` and commits do | pinned `pds/src/api/com/atproto/space/listRecords.ts`; `src/atproto/space-credential-core.ts:32-40` | A listed record is as trustworthy as the writer's own host, today and after this plan, until the verified strategy in R11. |
| An oplog page that does not reach the head carries no MAC. The pinned host deletes the whole oplog on `importRepo` and `clearRecords`, leaves superseded values out, and gives no signal that a `since` revision is gone | pinned `listRepoOps.ts:46-77`, `transactor.ts:314`, `:381`, `reader.ts:159-175` | The oplog cannot by itself show a reader that it missed nothing. It can be a hint beside a listing that is correct on its own. |
| `@atproto/space` ships `RepoCommit` (`fromRecords`, `applyOps`, `matches`), `LtHash` and `verifyRepoStar`; `listRecords` has `excludeValues` | `node_modules/@atproto/space/dist/repo-commit.d.ts`, `sync/consumer.d.ts`; `lexicons/com/atproto/space/listRecords.json` | The primitives for a verified complete sync exist. Whether a sync built on them handles concurrent listings, commit races and resets is R11's design work. |
| PDS space routes accept access-token sessions as well as OAuth, but `getDelegationToken` requires full access | pinned `pds/src/api/com/atproto/space/util.ts:87`, `getDelegationToken.ts:11` | An app password cannot read a space (K7). A headless bot holds its own OAuth session. |
| `getServiceAuth` issues a method-bound token for up to an hour | pinned `pds/src/api/com/atproto/server/getServiceAuth.ts:68-85` | A 15-minute token for the change feed can be issued. The operator's own 75-second acceptance rule (`src/operator/security.ts:66`) is what has to change. |
| Operator invariants assume every PDS member is a roster member with read and write, and scan at most 200 members | `src/operator/operations.ts:592-618`, `:274-330`, `:332-354`, `:366-425`; `src/atproto/space-ops.ts:58-62` | An app in a member list breaks channel creation, transition, archive and reconcile until the membership model includes installs. |
| Inbox members are write-only unless they are admins | `src/operator/operations.ts:372` | "Is in the member list" is not "may read". |
| Lexicon `maxLength` counts bytes; the validator counts code points. Two lexicon files declare `org.slack.channel.roster` | `lexicons/org/slack/channelMessage.json`, `src/protocol/records.ts:170`; `lexicons/org/slack/channelRoster.json`, `channel/roster.json` | The lexicons are not yet a contract another client could follow. R2 and R3. |

## Target design

### Layout

```
packages/protocol   lexicons, generated types, the registry, keys, validation, scope builders, limits. Pure.
packages/client     the engine: transport types, credentials, sync core, store interface and stores,
                    WorkspaceClient, ChannelClient, DmClient, OperatorClient. Isomorphic. This is the SDK.
                    packages/client/node adds a session transport for bots.
packages/testing    the fake PDS network, generalized from src/dm/testing/fake-pds.ts
packages/reader     the independent readers; depends on protocol only

apps/web            Next.js UI and the browser OAuth client metadata. No database, no session.
apps/operator       the authority service: journal, operations, new.flock.operator.* XRPC, the authority
                    OAuth client and its grants, the notify sink, the change feed, the reconcile job
apps/echo-bot       the first app, built on packages/client only
```

### Identities and sessions

| Party | Credential | Held by | Scope |
|---|---|---|---|
| Member (person) | OAuth session, public browser client | the browser (IndexedDB, non-extractable DPoP key) | member set (below) plus the DM set |
| Workspace authority | OAuth session, confidential client outside loopback | `apps/operator`, table `authority_grant`, keyed by authority DID, encrypted like today's session rows | `workspaceAuthorityScopes()`: the same for every workspace, computed from the registry's authority-written collections |
| App or bot | its own account's session | the app's process | whatever its account can do; access to spaces is its member-list entries |
| Operator | none of its own; verifies PDS-issued service tokens | | |

The member scope set, requested once at sign-in, replaces `permissionScopeFor`'s per-space cases. It is produced by the existing builders (`memberSpaceScope`, `operatorMethodsScope`, with their audience escaping and their tests), not written by hand:

```
atproto
space:new.flock.workspace?authority=*&action=read
space:new.flock.workspace?authority=*&collection=new.flock.acceptance&action=create&action=update
space:new.flock.inbox?authority=*&action=read
space:new.flock.inbox?authority=*&collection=new.flock.joinRequest&action=create&action=update&action=delete
space:new.flock.channel?authority=*&action=read
space:new.flock.channel?authority=*&collection=new.flock.channel.message&collection=new.flock.channel.reaction&action=create&action=update&action=delete
rpc?lxm=<each new.flock.operator method>&aud=<operator service ref, escaped>
```

Inbox `read` is new: the PDS grants it only to admins, and without it an admin cannot mint an inbox credential. The `permissions.member` lexicon gains the same line.

### The authority grant flow

The grant can administer every space of an account, so the flow that creates it is bound end to end:

- **Ticket.** A signed-in member (the web session in R1, a service token from R5) asks the operator for a ticket. The ticket records the initiating DID, the intended authority DID and the purpose (`createWorkspace` with its name, or `reauthorize`). It is single-use and lasts two minutes. In R1 the intended authority must equal the initiator.
- **Start** is a top-level navigation to the operator's own origin carrying the ticket. The operator consumes the ticket, sets the per-flow cookie (`src/auth/oauth-flow.ts`: host-only, `HttpOnly`, `SameSite=Lax`, limited to the authority flow's path, 15 minutes) and redirects to the PDS. Because start and callback are both first-party navigations on the operator's origin, this works whether or not the web app shares a site with the operator, and needs no cross-site cookie. This cookie is the one exception to "no cookie": it binds one flow to one browser and is not a session.
- **Callback** checks the state, the cookie and the expiry, then that the account that signed in at the PDS is the intended authority. A different account is revoked and rejected. A state is consumed on first use. The callback redirects to the web app with a result code only.
- **What a completed flow allows.** A grant row is only written by a flow that signed in as that authority. A caller that is the authority account itself needs nothing more than the grant to create a workspace, as today: one approval, then any number of workspaces. From R8 a caller may be someone else, and then a `createWorkspace` flow also leaves one creation authorization, bound to the initiator, the authority and the workspace name, valid for 15 minutes. It is consumed in the same database transaction that inserts the creation's journal row and records that operation's id; a retry of that operation finds the row and needs no authorization. If the row is discarded because the first step was refused for a missing scope (next point), the authorization is restored in the transaction that discards the row, for 15 more minutes and only for the same operation id, so the creator can reauthorize and retry without a second creation flow. There is no standing list of who may create under an authority. A `reauthorize` flow grants nothing but a fresh session; anyone may start one, and it succeeds only for someone who can sign in as the authority. After a workspace exists, its admin records decide, as today.
- **When the scope grows.** The authority scope names each collection the authority writes (`src/auth/permission-sets.ts:95-111`), and the PDS checks the collection on every write (pinned `space-permission.ts:142`). So a release that adds an authority-written collection (the app install record in R9, more in R10 and R11) needs a scope that older grants do not have. A grant can also be short because the person removed a scope on the consent screen, which the pinned provider allows (`oauth-provider/src/request/request-manager.ts:434-441`), so what was requested proves nothing. The PDS is the judge: a step it refuses for a missing scope (`isScopeMissingError`, `src/atproto/xrpc.ts:65`) makes the operation answer "reauthorization required". If no step had completed, its journal row is discarded, which is today's rule for creation (`bootstrap.ts:121-127`) made an option of the runner in R2; otherwise the row stays pending and resumes after `reauthorize`. An operation that needs a new collection writes to it in its first step, so the usual outcome is no row. The admin screen offers `reauthorize`, and the same operation id is then retried.
- **Keys and recovery.** Grants are encrypted at rest with the existing key. The client's private key comes from the deployment secret store, never the database; the JWKS serves more than one key so a key can be rotated. Revoking a grant is a documented operator action that signs it out and deletes the row; admin operations then answer "reauthorization required".

### Registry and validation (`packages/protocol`)

One table owns every space type and collection. An entry declares: NSID, space type, who may author it (the authority, any member, the half owner), how its key is formed (TID, `self`, a derived key and its function), its sync strategy (`window` for TID-keyed history, `all` for a bounded set), and a semantic check for what a schema cannot say (a reference must point into the same space, a reaction's key must match its subject). `validateSpaceRecord`, `collectionSpaceType`, `AUTHORITY_COLLECTIONS`, the scope builders and the cache's kind tests all read the table. Later apps and extensions register through the same interface.

Validation has two layers. Shape comes from the lexicon documents through `@atproto/lexicon` (already a dependency), so a shape the published lexicon accepts is a shape this app accepts. Meaning comes from the entry's semantic check, which can still reject a well-shaped record. Objects are open: an unknown field is kept and ignored, and an edit writes it back (the edit route already spreads the prior value, `messages/write/route.ts:77`). `hasOnly` goes. To evolve a record: add optional fields freely; a change to a required field or to meaning takes a new NSID. A reader bounds what it keeps by record size, not by field list.

### Sync core (`packages/client`)

One implementation for channels, DMs and anything added later. It separates hints from truth.

**Truth** is each writer's own host. For a writer and a collection the store holds a **coverage**: the lowest key from which it holds one consistent state of the writer's records as that host reports them, a state no older than revision `syncedRev`; or "complete" when the listing reached the end. Consistent is not the same as authenticated; see "What is authenticated" below.

- **Refresh a writer.** Read the writer's revision at its host (`getLatestCommit`, MAC-verified, as today). List newest-first down to the lowest key an open view needs (for an `all` collection, to the end). Read the revision again. Only if the two revisions match is the listing one consistent state, because a listing is not a snapshot: a record inserted above a page already read, or deleted after the first read, would otherwise leave a mixture. On a match, in one store transaction: replace the held records in the listed range with what was listed, set the coverage to the lowest key listed, set `syncedRev`, and drop anything held below the new coverage. On a mismatch, try again, at most three times; a writer that keeps changing is reported as "changing, may be out of date" and tried again on the next tick. A record below the coverage is fetched again if someone pages back to it.
- **Backfill** extends the coverage downward under the same bracket: the revision read before and after must both equal `syncedRev`. If the writer moved, it is refreshed instead.
- **No stale commit.** Every writer state carries a generation. A refresh or backfill commits only if the generation is the one it started from and its revision is not older than the stored one; a committed refresh, a local write and a purge each advance the generation. So a slow refresh, in this tab or another, cannot overwrite newer state, undo a local write, or bring back purged records. This is the guard `markRepoStale` and the conditional updates in `channel-sync.ts:210-223` give today.
- **Own writes** are applied to the store when the host accepts them and advance the generation of the client's own writer state, which is then refreshed like any stale writer.
- **A window is complete** when every listed writer not set aside has coverage at or below the window's oldest key, or complete coverage, has been checked at its host within the truth interval, and no bounded scan was cut short. Otherwise the page is reported as filling or degraded, with the reason, as the degraded reasons are shown today.
- Records are validated on read and merged with the existing k-way merge (`src/dm/merge.ts`, generalized). Paging older uses a cursor of `(key, record URI)`, the full sort order. A key alone is not enough: `merge.ts:36` skips every record whose key equals the cursor, so two writers' records with the same key at a page boundary lose one of them, in DMs today as well. The cursor is handed to callers as one opaque string, so `DmClient.readConversation`'s `before` and `nextBefore` keep their types and its callers pass the value back unchanged. Offset paging goes.
- A writer whose repo cannot be read is set aside and reported, with the same permanent and transient distinction as today (`SetAsideRepos`, `src/atproto/repo-failure.ts`).

**The writer set** is what the authority lists, as today. A full `listRepos` is read when a space is first opened in a session and at each truth interval. Records held from an account that is no longer listed are dropped, so a long-lived client shows what a fresh one would. Two limits follow and are stated in the SDK contract: an account the authority never heard from is not read, and an account removed from a space, or reduced to read-only, takes its earlier records out of view (D14). "Complete" always means complete for the listed writers.

**Hints** decide which writers to check first; they never mark a writer fresh.

- `listRepos` with the stored `spaceRev` cursor names writers whose reported revision moved, and new writers.
- A change-feed tick for a space triggers that `listRepos` call.
- Writers are visited in descending reported revision, so the most recently active are read first and a page fills progressively. This is an ordering, not a cut-off: every listed writer is still visited.

**The truth interval.** A listed writer is checked at its own host when a hint names it, when the space is first opened in a session, and at least once an hour while the space stays open and the host can be reached (D12). A writer whose check is overdue is shown as possibly out of date. So for a writer the authority lists, a notice the authority never received costs about an hour of staleness, where today it costs about a minute at the price of asking every writer on every open.

**What is authenticated.** Commits and single-record reads are MAC-verified. Listed records are not, so they are as trustworthy as the writer's own host. The bracket above makes a listing consistent; it does not authenticate it. That is today's assurance, and it is written into the SDK contract until R11.

Reactions are an `all` collection: a writer's reactions in a space are listed in full, under the reaction bound for the space, as `fillOlder` does today.

The oplog is not used here. It becomes useful with a complete set hash, which is the **complete and verified** strategy for merged entities in R11.

Cost, measured in K4 and gated in R4: within the truth interval, reopening a space is one credential (when the cached one expired) and one `listRepos` page. A new message costs two revision reads and one or two listings of the writer that wrote. The first open in a session still asks every listed writer once.

### Store

The sync core writes through an interface: records by `(space, repo, collection, rkey)` with their CID, per-writer state (coverage, `syncedRev`, generation, last host check), per-space state (`spaceRev`, its feed cursor, the workspace a channel belongs to, last opened), and purges. Two implementations: memory and IndexedDB. The web app uses IndexedDB for workspace, inbox and channel spaces and memory for DM spaces, as DMs do today (D10). The 20,000-record bound stays as it is today: per collection per space, so 20,000 messages and 20,000 reactions (`channel-sync.ts:25`, `:117-123`; the supported-size fixture in `protocol-tests/performance-envelope.test.ts:34-35` holds exactly that and must stay non-degraded). When a scan stops at a bound the page says so and is not called complete, as the "exceeds the limit" reasons do today.

The lifecycle rules now in `src/workspaces/cache.ts` move to the engine, each with a test:

| Rule today | Where | In the engine |
|---|---|---|
| Access to a channel lost: drop that channel | `purgeSpaceCache`, `purgeDeniedPermissionCache` | same, on a refused credential |
| Access to a workspace lost: drop it and every channel that belongs only to it | `purgeWorkspaceCache` | same, using the stored workspace of each channel |
| A workspace no longer listed after a full discovery: drop it and its channels | `purgeCachesForUnlistedWorkspaces` | same |
| A channel archived or gone from the directory: drop it | `unregisterWorkspaceChannel`, `replaceWorkspaceChannels` | same, when the directory is read |
| A writer permanently unreadable: drop its records so they count toward no limit | `purgeRepoCache` | same |
| A space deleted: every copy goes | `purgeDeletedSpace`, on the authority's notice | the client learns it from its own credential: a mint or renewal refused with `SpaceDeleted` drops the space, and a deleted workspace takes its channels with it. For a workspace, inbox or channel space being followed, the feed answers `denied` and the client mints at once: within one poll when the operator received the deletion notice, and within the 60-second member-list cache when it did not. For a DM space, and for any space not being followed, it is the next mint: the next truth check while the space is open, or the next open. That is when a DM half's deletion is noticed today |
| A writer no longer listed by the authority | not handled: cached rows stay | its records are dropped at the next full `listRepos` |
| Not read for the retention period: dropped | `sweepStaleCache` | a sweep at start-up by last-opened time |
| Own write: next read re-fetches own repo | `markRepoStale` | own writes applied locally and own writer marked stale |
| Sign-out | deletes the session | the store for that account is deleted. A crash before sign-out leaves it; the next start for a different account deletes stores that are not its own |

### What the member routes do today, and who owns it after R6

Deleting a route must not delete a rule. Each row gets an engine test before the route goes.

| Route | Rules it enforces | Engine owner |
|---|---|---|
| `GET /api/workspaces` | discovery; a workspace whose credential is refused becomes an invitation candidate unless it was deleted; invalid authority records hide the workspace; the degraded reasons | `WorkspaceClient.discover` |
| `POST /api/workspaces/accept` | the acceptance record is valid; membership is current (a credential is minted) before writing; the known failure codes (`src/workspaces/accept-errors.ts`) | `WorkspaceClient.accept` |
| `GET /api/channels/messages` | directory record valid; reading refused while a channel is transitioning or archived; set-aside writers; degraded reasons; bounded pages and the malformed-host checks in `record-pages.ts` | `ChannelClient.readPage` |
| `POST /api/channels/messages/write` | same channel-state check and a current credential before any write; a reply target is a top-level message in this channel, fetched with a verified `getRecord`; only own messages are edited or deleted; an edit keeps the prior fields and re-checks the parent | `ChannelClient.send`, `edit`, `delete` |
| `POST /api/channels/reactions` | the subject is a message in this channel and exists; the key is derived; removing a missing reaction succeeds | `ChannelClient.react`, `unreact` |
| `POST /api/channels/requests` | join requests only for private channels; withdrawal always allowed; derived key; a new request id each time | `ChannelClient.requestJoin`, `withdrawJoin` |
| `GET /api/channels/roster` | private channels only; the roster envelope errors | `ChannelClient.roster` |
| `GET /api/inbox/requests` | admins only; refused while the workspace is degraded; writers are the union of the operator's inbox-writer list and `listRepos`; unreadable writers are skipped and reported; a request with a current decision is hidden | `WorkspaceClient.inboxRequests` |
| `POST /api/workspaces/bootstrap`, `/api/operator/*` | forward to the operator with a service token | `OperatorClient` |
| `GET /api/notifications`, `/dm` | see the change feed below | `OperatorClient.changes` |

The same-origin mutation check on these routes guarded cookie requests; it goes with the cookie.

### Operator service API

Everything a client needs from a server becomes a lexicon-described XRPC method authenticated by a PDS-issued service token. No cookie, with the one exception of the authority flow's per-flow cookie described above.

| Method | Replaces | Notes |
|---|---|---|
| `execute`, `getOperation`, `listInboxWriters` | themselves | unchanged apart from the namespace |
| `createWorkspace` | `/api/workspaces/bootstrap`, `src/workspaces/bootstrap.ts:51-86` | From R5 the method runs the existing persisted kind `bootstrapWorkspace` through `runJournaledOperation`, with its step names and request hash input unchanged; the caller is the authority. From R8 the same method issues a new persisted kind, also named `createWorkspace`, that carries the creator; `bootstrapWorkspace` keeps its handler for rows that exist |
| `startAuthorityFlow` | the `workspaceAuthority` case of `/api/oauth/permission` | returns the ticket URL for the flow above |
| `listStalledOperations` | `/api/operator/stalled` | also reports notice registrations that failed to renew |
| `getChanges` | `/api/notifications`, `/api/notifications/dm` | below |

**`getChanges`** is a long-poll query. Input: up to 200 entries of `{ space, after }`, each with that space's own cursor. Output, when something changed or after about 25 s: `{ head, changed: [{ space, cursor }], denied: [space], reset: [space] }`. It carries no writer, no revision and no content: a client that sees a space in `changed` asks the space's authority for `listRepos`, which is where its access is really checked. This is today's counter per space, for many spaces at once.

- **Cursors are per space**, as the two streams are today. One shared cursor would skip a space added after its last event. A call with no entries returns `head` at once. A client starts following a space in this order: read `head`, sync the space, then follow it with `after` set to that `head`; anything that happened in between is reported again, which costs one `listRepos` and loses nothing. The same order applies when access to a space is regained.
- A workspace, inbox or channel space is served only when the operator holds its authority's grant, the space's member list can be read with that grant, and the caller is the authority or has `read: true` in the list. The authority is not exempt from the read: it is how the operator knows the space still exists. The list is cached for 60 s; the operator's own journal drops a cached list the moment it changes one, and a deletion notice drops it too. A lookup failure denies. The check runs again when a held response is about to be sent, so a member removed during a poll gets `denied`, not `changed`.
- A DM space keeps today's rule (`src/lib/dm-subscription.ts`): an inbox only for its owner; a conversation half for any signed-in caller, because the answer is still only "this space changed". The operator cannot tell whether a DM half exists and does not try, so a deleted half is simply silent.
- A space the caller may not follow comes back in `denied`, its cursor does not move, and the rest of the request is served. That includes a deleted workspace, inbox or channel, for its authority as for anyone else. The client reacts to `denied` by minting a credential for that space, and the result tells it which case it is in: deleted, access lost, or a passing failure.
- A space whose cursor is older than its retained notices comes back in `reset`, and the client syncs that space. Notices keep today's caps, counted per space type so one busy kind cannot evict another's.
- The accepted service-token lifetime becomes a per-method setting, 15 minutes for `getChanges`, bound to that method and audience as today.

The operator still receives `notifySpaceDeleted` and, as today, drops that space's notices and registration. It no longer has copies to purge.

**Notice registration** is the operator's job for workspace, inbox and channel spaces: it mints a credential with the authority grant and registers its own sink. Registering is idempotent and changes no membership, so it never takes the workspace lock.

- When an operation creates a space, registering it is one of that operation's steps. It runs inside the lock the operation already holds and acquires nothing.
- A sweep covers backfill and renewal: for every journaled workspace it reads the directory and registers any active space whose registration is missing or within six hours of expiry. It runs when the operator process starts and every 30 minutes from the reconcile job, under its own short database lease (the `oauth_request_lock` pattern) so two processes do not sweep at once. A registration lasts about a day, so a renewal has many attempts before it lapses.
- A failed registration is retried on the next sweep with backoff per space, counted, and reported by `listStalledOperations`.
- Archiving or deleting a space unregisters it and removes its notices.
- `isNotificationAccepted` and its table stay as they are.
- While a registration is down, clients get no ticks for that space and fall back to the truth interval.

Clients still register for DM spaces themselves.

The authority OAuth flow (start, callback, client metadata, JWKS) is the only server-side OAuth flow left and lives with the operator.

### Apps

- **Identity.** An app is an atproto account. It publishes `new.flock.app.declaration` (key `self`) in its own public repo: name, description, and later its commands. It is read when the app is installed and when it is shown, validated like `dm.declaration`, and never trusted for access.
- **Install.** `new.flock.app.install` in the workspace space, authority-written, keyed by the app's DID: subject, active, the channels granted and whether each is read or read and write, who installed it, when. There is no write-only grant. It is the admin-visible grant and the marker clients use to label the account.
- **One membership model.** The expected member list of every space is computed in one place from the roster, the admins, the private-channel rosters and the active installs. An app is expected in the workspace space with read only, and in each granted channel with its granted bits. Every operator invariant uses it: `currentWorkspaceMembers` and `assertWorkspaceRosterMatchesPds`, the member checks in `createChannel`, the add and remove loops and the convergence check in `transitionChannel`, `archiveChannel`, and `reconcileWorkspace`. Making a channel private or public keeps its apps; archiving removes them and marks the grant for that channel ended in the install record.
- **Limits.** At most 20 active apps per workspace (D13), outside the 200-person envelope. The member-list scan bound becomes 220. An account cannot be both an active roster member and an active app: `installApp` refuses a roster member and `inviteMember` refuses an installed app.
- **Order.** `installApp` writes the install record first and then the member entries; `uninstallApp` and `updateAppAccess` write the record first and then remove or change entries. The record is the source of truth and every operation, reconcile included, runs under the workspace lock, so a crash leaves a state reconcile moves toward the record, never away from it.
- **Runtime.** The app runs `packages/client` with its own session, follows its spaces through `getChanges`, and reads and writes records like any member. No code of the app runs in this product, and no server of this product sits between the app and the PDS for content.
- **Revocation.** After `uninstallApp` the app is in no member list, its feed authorization is dropped at once, and its next credential is refused. A credential it already holds lasts until it expires (ten minutes by default, an hour at most, the authority's choice). That is the same residual a removed person has, and R9 measures it. Removing the app also takes its earlier messages out of view, because removal takes it out of the writer set (D14); the admin screen says so before an uninstall.

### What is deleted

`src/workspaces/**`, `src/auth/{session,web-session,encrypted-cache}.ts`, the member half of `src/auth/oauth.ts`, `/api/channels/*`, `/api/workspaces/*`, `/api/inbox/*`, `/api/notifications/*`, `/api/oauth/{login,logout,permission}`, and the tables `oauth_session`, `web_session`, `channel_record_cache`, `workspace_channel_cache`, `space_collection_cursor`, `sync_cursor`. The server can no longer read channel content.

## Phases

Every phase ends green on `pnpm typecheck`, `pnpm lint` and `pnpm test` (Node 22.17), plus the suites its gate names, then a `/code-review` round on the frozen diff. Commits only on approval, on a branch; secret scan before any push. A persisted operation kind never changes its name, request shape or step names (the journal replays by name and hash); a new shape gets a new kind. Sizes are relative.

### R0. Spikes and baseline (no product code) — S

Each spike is a conformance test under `protocol-tests/atproto/` or a throwaway script, and its result is appended here before the phase that depends on it starts.

- **K1** Reproduce F1 as failing scenarios and record exactly which operations fail in each: the creator signs out; the creator signs in again in a second browser; the session passes the public-client lifetime (clock-advanced in the conformance suite).
- **K2** Whether the pinned test network can serve a `private_key_jwt` client outside loopback, so the two-year lifetime can be asserted in a conformance test. If not, R1 covers the confidential path with unit tests of the metadata and JWKS and a staging check, and says so.
- **K3** One browser grant with exactly the final combined scope string (member set, DM set, an escaped service fragment, the names of the operator methods that do not exist yet) is accepted, and with it: discovery, accepting an invitation, reading and writing a channel, the admin inbox, the three operator methods that exist, and the DM operations all succeed; a service token for a not-yet-built method name is issued and verified by a throwaway endpoint; a non-member holding the grant is refused a credential. This proves the parser, the grant and the token. The same list is run again against the real methods as part of R5's gate.
- **K4** Sync budget in a real browser (Playwright against the fixture): calls and wall time for the first open in a session, a reopen, and one new message, at 20, 100 and 200 writers, using a prototype of refresh and hints. Report the browser's per-origin connection limit against the HTTP/1.1 fixture separately from the call count. Fixed dataset, ten runs each, median and 95th percentile. The result sets the truth interval (D12).
- **K5** What `listRepoOps` returns after `importRepo` and `clearRecords`, and the cost of a metadata-only listing of 10,000 records. It decides nothing before R11; it sizes the verified strategy and feeds an upstream request for a "since is gone" signal (drafted locally under `.ai/upstream/`, not posted).
- **K6** `lex-cli` output for one `new.flock.*` lexicon compiles (`new` is a reserved word in JavaScript).
- **K7** The whole bot path with an app-password session at the pin: `getDelegationToken`, a credential, reads, writes, `getServiceAuth` for an operator method, credential renewal, and refusal after its membership is removed.
- **K8** `@atproto/lexicon` validation against the hand validators over the existing fixtures: every disagreement listed, and the browser bundle cost.
- **K9** The browser against real hosts, as a capability check: with the web app and two PDS hosts on different origins, and a throwaway stand-in for the operator on a fourth, run the OAuth flow, mint and renew a credential, read with a verified `getRecord` (the MAC header must be readable across origins), write, call the stand-in with a service token, be refused as a non-member, and meet an unreachable writer host. Record every preflight that fails. It is repeated with the real client in R6a, where the operator still shares the web app's origin, and with the real operator process on its own origin in R7.
- **Baseline.** Unit count, executable scenario count, acceptance and browser results, and the channel and DM performance figures, re-measured the same way as K4, as the bar for later gates.

Gate: results recorded; any surprise changes the design before the phase it touches.

#### R0 results (2026-11-09, pin `5d88b414`, Node 22.17.0)

Spikes that run against the app live in `protocol-tests/` (K1 `authority-grant.test.ts`, K3 and K7 `platform-capabilities.test.ts`, K4 `sync-budget.ts`, K9 `browser/cross-origin.spec.ts`, all on the shared helper `protocol-tests/support/pds-network.ts`); K2 and K5 are pinned-checkout conformance tests (`protocol-tests/atproto/platform-spike-*.test.ts`, report in `.ai/spikes/k2-k5-pinned-provider-and-oplog.md`); K6 and K8 were throwaway scripts whose method, versions and results are kept in `.ai/spikes/k6-k8-lexicon-tooling.md` and `.ai/spikes/k8-disagreements-pinned.md`, and R2's schema-parity test turns the K8 corpus into a committed test.

- **K1, reproduced** (run against the pre-R1 code). Three scenarios, one per creator event, each running the same five admin operations against a workspace with a second admin. The setup and the event run outside any expected failure; a passing assertion records that the operations fail with a lost or narrowed session (F1), and a `todo` assertion states what R1 must make pass. *Signs out:* all five fail ("The session was deleted by another process" for the operator admin check behind `execute`, `getOperation` and `listInboxWriters`, channel creation and inbox writers; the reconcile job alerts "authority session is missing"). *Signs in again in a second browser:* the second admin's three operations fail with "Missing required scope space:org.slack.inbox?…&action=read_self" (the sign-in replaced the authority scopes); the authority's own admin check passes, and so does the reconcile job's paused check, which only runs that check. *Session passes its lifetime:* the provider session is aged fifteen days (its creation and last-refresh times, which is what the provider measures, as K2 does) and the stored access token expired; the first operation fails with "Session expired" and every later one with "The session was deleted by another process", because the failed refresh deletes the row; the reconcile job alerts. So F1 is as described, and it hits every admin of the workspace, not only the creator.
- **K2, yes, through discovery only.** The pinned provider gives a confidential client a two-year session but a **three-month refresh window** (`REFRESH_LIFETIME_EXTENDED`), measured from the last refresh: refresh succeeded at 400 days old and at 80 days idle, and failed with "Refresh token expired" at 100 days idle and "Session expired" at two years and a day. A public client fails at 15 days. A discoverable client ID must be `https://` on a public-looking domain; loopback IDs are forced public. The conformance test serves the metadata by stubbing `globalThis.fetch` for exactly those URLs, which the PDS calls at fetch time. *Design change:* a grant must be used at least once every three months; R1 documents it and the scheduled reconcile job uses every grant, and R5's 30-minute registration sweep makes it continuous. The full authorization-code flow of a discovered confidential client was not run; tokens were minted through the provider.
- **K3, passes with one ordering note.** One grant with the final combined scope string (member set with `authority=*`, the DM set, one `rpc` scope naming the three existing and four planned operator methods) was accepted by the provider's authorization-request check for the app's client and carried: accepting an invitation, discovery, writing and reading a channel, a member's join request into the inbox, an admin reading that request from the inbox with a MAC-verified `getRecord`, the three existing operator methods called through their route handlers with the member's service tokens (`execute` created a channel, `getOperation` returned it, `listInboxWriters` listed the requester), tokens for the four planned methods verified by a stand-in, a refusal for a non-member, and the DM round trip. Discovery finds a workspace only after the member's own acceptance record exists, as today (the protocol has no "spaces I was added to"). The tokens were minted through the provider rather than a consent screen; K9 runs the same scope string through the real consent screen in a browser. Run with today's `org.slack.*` names; R3 renames them and R5 re-runs this list against the real methods.
- **K4, measured, with one departure from the method.** The prototype ran in Node, not in Playwright: every request waits for one of six connections per origin (the browser's HTTP/1.1 limit), DID resolution goes through the PLC origin's own six, and K9 separately shows the browser reaches every host. The call counts are the requests the client sends; a browser adds CORS preflights on top (K9 saw them for credential-bearing requests to every host), so they undercount browser traffic, and R6a counts the real client's requests including preflights. The timings are loopback timings without a browser's own overhead, so R4's gate compares the engine against these figures measured the same way, and R6a measures the real client in a browser. Ten runs each on an otherwise idle machine, five messages per writer. The dataset is seeded and then waited on until the authority reports every writer at its final revision; each first open must read every writer with all five messages; each run writes one message, checks that the reopen read it, deletes it, and waits for the authority to report that revision, so every first open reads the same records; every run of a phase made the same number of calls:

  | writers | phase | calls | median | p95 |
  |---|---|---|---|---|
  | 20 | first open | 104 | 855 ms | 909 ms |
  | 20 | reopen within the truth interval | 1 | 8 ms | 8 ms |
  | 20 | one new message | 5 | 50 ms | 54 ms |
  | 100 | first open | 504 | 4,028 ms | 4,057 ms |
  | 100 | reopen | 1 | 8 ms | 9 ms |
  | 100 | one new message | 5 | 48 ms | 81 ms |
  | 200 | first open | 1,004 | 7,962 ms | 8,084 ms |
  | 200 | reopen | 1 | 8 ms | 8 ms |
  | 200 | one new message | 5 | 51 ms | 62 ms |

  Separately, a write reaches the authority's `listRepos` in about 20 ms (p95 at most 34 ms at every size, 25 ms polling), which is what a change-feed tick waits for before the reader's five calls. A first open is one credential (2 calls), one `listRepos`, one DID resolution per writer, and four calls per writer (two revision reads, two listings). A reopen is one `listRepos` whatever the writer count, which is R4's gate shape. An earlier run while the BDD suite shared the machine gave the same call counts and a 200-writer p95 of 30 s, so first-open time is sensitive to host load. These figures are for sparse writers: five messages each and no reactions, so every listing is one page. A truth check of a writer costs the same four calls while its newest window of messages and its reactions in the space each fit one page; at the supported envelope (20,000 reactions over 199 writers, about 100 each) a writer with more reactions than a page adds one listing per extra page. *Design changes:* the hourly truth interval (D12) stands on this evidence: a check of 200 sparse writers is about 800 calls, roughly eight seconds of background work an hour. The engine lists the `all` collections at the largest page size the host allows, and R4's gate re-measures the check against the envelope fixture, where reactions are dense. The first open of a 200-writer channel is slow enough that progressive filling (most recent writers first) is required, not optional. DID documents must be cached by the engine across sessions (one PLC call per writer per first open otherwise); the store gets a DID cache with a TTL. Without a per-origin limit on DID resolution the local PLC timed out at 100 writers, so the engine bounds it.
- **K5, both resets are silent.** `importRepo` and `clearRecords` delete the whole oplog and write no operation; `listRepoOps` with a `since` from before the reset returns an empty list, or, after a later write, only the later operations, with no error. The set hash recomputed from what a syncer holds catches the case where the content no longer matches the commit (after `clearRecords`, or a partial list applied to a stale state); it does not detect missing history as such, since after an `importRepo` of identical content a checkpointed syncer applying the later operations still matches. `clearRecords` on an already-empty repo leaves the oplog in place, contrary to its lexicon. Listing 10,000 records of one writer at `limit=1000`: 11 pages, about 0.6 s with `excludeValues` (1.25 MB decoded) and 0.8 s with values (4.6 MB); at the default `limit=50`, 201 pages and about 5 s. Upstream request drafted as `.ai/upstream/U12-oplog-reset-signal.md` (not filed). Nothing before R11 changes.
- **K6, compiles.** `lex-cli` output for `new.flock.*` type-checks and runs; `new` appears only as a class field name (`client.new.flock…`), which is legal. The pinned checkout's `lex-cli` is required (the installed 0.10.13 rejects `space-ref`), as `scripts/codegen-lex.mjs` already assumes.
- **K7, app passwords cannot read a space.** `getDelegationToken` requires full access (`ACCESS_FULL`, pinned `getDelegationToken.ts:11`), so an app-password session is refused with "Bad token scope", while the same session writes into its own repo in the space and gets a service token. A bot holding its own **OAuth** session with the member grant completed the whole path: mint, MAC-verified read, `listRepos`, write, renewal (a new credential that then serves a verified read), a service token, and refusal after removal. *Design change:* R9's Node transport is an OAuth session for the bot's account (the facts-table row on access-token sessions is corrected below); an access-token session would need the account password, which no third party should hold.
- **K8, lexicon validation needs the pinned snapshot.** The installed `@atproto/lexicon` 0.7.14 rejects every space record URI as an `at-uri` (so a valid reply, reaction or join decision fails) and never checks `space-ref`; the alpha snapshot `0.0.0-spaces-alpha-20261029171913`, the same family as the app's other pinned packages, agrees with the pinned checkout on all 1,693 corpus items and has neither problem. *Design change:* R2 pins that snapshot. Differences to reconcile in R2 (alpha runtime): text limits count UTF-8 bytes in the lexicon and code points (message text) or UTF-16 units (names, emoji) in the hand validator; the lexicon rejects `-00:00` offsets, DIDs with a digit in the method, and TIDs starting with k–z, which the hand validator accepts; the hand validator rejects unknown fields, lenient datetimes, open `knownValues`, skeys outside its alphabet, blank DM text and unsorted participants, which the lexicon accepts. Semantic rules (author, space type, derived keys, same-space references, nested replies, participants) stay in hand code. The two `org.slack.channel.roster` files are byte-identical; loading both throws, so `channelRoster.json` goes. One dead branch (`records.ts:138-140`) is unreachable. Marginal browser cost: the DM client already ships `@atproto/lexicon`, so adding the documents costs about 7 KB gzipped.
- **K9, passes.** A member and an outsider each signed in through the real OAuth flow in the browser (PDS sign-in and consent pages) with K3's combined scope string, for a public client whose redirect lands on a separate web origin. Every later request was sent by the browser from that origin: PAR and the token exchange, DPoP-bound XRPC to the member's own host, DID documents from the PLC, the credential exchange at the authority's host, a MAC-verified `getRecord` (the MAC header is exposed), `listRepos`, a write, and a call with a service token to a stand-in operator on a fourth origin, whose one preflight (`authorization`) it allowed. Watched through the DevTools protocol, the browser sent 14 preflights (to both PDS hosts, the operator and the unreachable host) and only the unreachable host's failed. The outsider's refusal was readable, and an unreachable host failed as a network error, the only browser-level failure apart from the OAuth client's handle checks against the fixture's handles, which are not real domains. Node held the keys and verified MACs; the browser decided reachability, preflights and readable headers.
- **Baseline.** Unit: 363 tests, all passing. BDD: 66 of 66 executable scenarios (471 steps) in 1,588 s. Acceptance (`app-acceptance`, `reconcile-workspaces`, `dm-acceptance`): 3 of 3 in 139 s. Browser: 2 of 2 in 68 s. Performance: "measured the same way as K4" is taken to mean repeated runs reported as median and 95th percentile, which is what R4's gate compares for the latest-100 read; the performance tests now repeat each latest-100 read ten times. They time today's readers, which are server-side and have no per-origin limit, so they are the bar for read time only; call counts are compared against K4's prototype, not against these runs. Results (pre-R1 code; every timed read is checked, after its timer, against the first fully checked page: the same messages and reactions and no degraded result): at the channel envelope (200 members, 20,000 messages and 20,000 reactions in the channel read), the independent reader's latest-100 read took a median of 16,896 ms and a p95 of 17,313 ms; the primary reader took 12,166 ms and 12,753 ms from an empty cache, and 999 ms and 1,037 ms warm. The DM latest-100 read over 100 halves and 20,000 messages, run on its own, took a median of 4,308 ms and a p95 of 4,910 ms across ten fresh clients. (`pnpm test:performance` runs the two files in parallel; there the DM p95 rose to 13,854 ms while the channel test was writing, so the DM bar is the run on its own.)

### R1. Authority grant separation — S to M

- One owner, `src/operator/authority-grant.ts`: its own OAuth client (one scope for every workspace, so one client ID, with no scope descriptor in it), its own state and session tables, its own callback, client-metadata and JWKS routes, and the flow binding described above. Outside loopback: `private_key_jwt`, ES256, key from a new `AUTHORITY_CLIENT_PRIVATE_JWK` (`.env.example` and `docs/operations.md` updated, including rotation and revocation).
- `security.ts:78` and `:111`, the bootstrap path and `scripts/reconcile-workspaces.ts` restore the grant from that owner. Sign-in no longer writes it; sign-out no longer revokes it; the `workspaceAuthority` permission action starts the authority flow.
- In this phase the authority account is still the creator's.

The flow is built in its final shape here (ticket, top-level navigation, callback); only how the ticket request is authenticated changes in R5.

Tests: sign-in and sign-out leave the grant row untouched; a member-session refresh cannot overwrite it; a ticket cannot be used twice or after two minutes; a callback for another account than the intended one is rejected and that session revoked; a state cannot be used twice or after expiry; a callback in a browser without the flow cookie is rejected; two flows at once in one browser both complete; two concurrent approvals for one account leave one valid grant; the authority account creates a second workspace with no further approval; metadata is confidential outside loopback and public on loopback; the acceptance cases around the authority session (`protocol-tests/app-acceptance.test.ts`) updated.
Gate: the K1 scenarios pass; existing workspace and lifecycle scenarios unchanged.
Rollback: revert; the old row is recreated by the next authority approval.

### R2. Registry, lexicon-driven validation, layering — M to L

- `src/protocol/registry.ts` and `src/protocol/scopes.ts` as designed above. No NSID string literal remains in non-test code outside the registry and the generated lexicon module.
- Each lexicon reconciled with its validator; the lexicon wins and every difference is listed in the change description (text length units first). `hasOnly` removed; a maximum record size enforced on read.
- Operator dispatch becomes a table of `{ fields, authorize, run }` per kind, one file per kind, with an invariant test that pins every persisted kind, request shape and step name. `createChannel` checks its members against one member-list read instead of one read per member (`operations.ts:269-271`, `:671-674`).
- Bootstrap runs through `runJournaledOperation`; its "waiting for approval, nothing done yet" case (`bootstrap.ts:121-127`) becomes an option of the runner.
- Imports point one way: `src/atproto` stops importing `src/workspaces` (`space-ops.ts:17`); the operator stops importing `src/workspaces` (`operations.ts:12-13`, `security.ts:13`, `http.ts:5`); the notice tables move out of `src/atproto/notifications.ts` to the operator.
- Not done: tidying `/api/channels/*` and the other member routes. They are deleted in R6.

Tests: schema parity (for every collection, a corpus of well- and ill-shaped records gets the same shape verdict from the registry's shape layer and from `@atproto/lexicon` alone); semantic rejection (for every semantic rule, a well-shaped record that breaks it is rejected: wrong author, wrong derived key, a reference outside the space, a nested reply); a record with an unknown field is accepted, kept, and survives an edit; journal rows written by the code before this phase, one pending with no step and one half-completed, for `bootstrapWorkspace` and `createChannel`, resume with the same hash, actor and lock and repeat no step.
Gate: behavior unchanged on the BDD and acceptance suites; independent-reader parity unchanged.

### R3. Namespace — M, mechanical

- `org.slack.` becomes `new.flock.` with the same suffixes. Lexicon files move to `lexicons/new/flock/**` with one file per NSID at the path its NSID implies; the duplicate roster file goes.
- Wire identifiers that carry the old name change in the same step (D7): the operator service fragment and service type, `SLACK_ADMIN_MUTATIONS_PAUSED`, the default database file name. Product strings, the package name and the directory stay.
- Regenerate the lexicon client; rename in tests, features, conformance suites and docs.
- Local databases and test PDS data are deleted at this step (D6). Before deleting anything, the phase lists the exact targets (the SQLite file at `DATABASE_PATH` and its sidecar files, and any fixture data directory that outlives a test run) and waits for the owner's confirmation. Nothing outside those is touched. Journal rows hold space URIs under the old names and are not carried over. Persisted operation kinds (`bootstrapWorkspace`, `createChannel`, …) contain no NSID and keep their names, so the rule that a kind never changes is untouched; R2's replay tests protect that rule from here on, not rows across this step.

Gate: `org.slack` and `slack_admin` appear nowhere outside `.ai/`; the conformance, acceptance and BDD suites pass under the new names.
Owner prerequisites before any deployment, not done here: control of `flock.new`; a `_lexicon` TXT record for each NSID group (`flock.new`, `workspace.`, `channel.`, `dm.`, `operator.`, `permissions.`, later `app.`), and the lexicon records published from the account those records name.

### R4. The engine — L

- `src/client/` (isomorphic, under the lint boundary until R7): transport types (today's `DmDeps` without the store), the credential cache lifted from `DmClient`, the sync core, the store interface with the memory and IndexedDB stores, the merge, the lifecycle rules.
- `WorkspaceClient`, `ChannelClient` and `OperatorClient` with the methods in the route table above. `DmClient` moves onto the same credential cache and sync core; its public methods and its tests keep their behavior.
- `src/dm/testing/fake-pds.ts` becomes the general fake network: spaces of any registered type, `listRepos` with revisions, cursor and a controllable lag, the create, put and delete record calls, `getServiceAuth`, a hook that delivers or withholds `notifyWrite`, and a way to write between two pages of a listing.
- The server routes are not rewired onto the engine (D11).

Tests, all on the fake network unless noted:
- sync: first sync; reopen; create, edit, delete; a record inserted below the oldest held key but inside the window; a writer with no records; a new writer; a delete at a page boundary; a record inserted above a page already read; a record deleted after the first revision read; a writer that keeps writing through three attempts (reported as changing, not complete); a failure between two pages (the previous state stands); a reported revision that lags; a notice that never arrives (caught by the truth interval); a notice that arrives during a refresh; a writer set aside and one that returns; future-dated and back-dated keys; a reaction older than the window on a message inside it; an imported repo.
- concurrency: two stores' worth of "tabs" refreshing one writer and committing out of order; an own write during a refresh; a purge followed by a late refresh; a backfill racing a refresh.
- paging: several writers' records with one key across a page boundary, for a channel and for a DM conversation; the bound reached with records spread unevenly across writers (the page reports the cut and is not complete).
- the writer set: a fresh client and a long-lived client agree after a member is removed, after one is reduced to read-only, and after an app is uninstalled; a writer the authority never listed stays unread and the page does not claim more than "complete for the listed writers".
- behavior: every row of the route table and of the lifecycle table.
- parity with the independent readers, for what they can express: a fresh read of a channel page (`src/reader/independent.ts`: messages, reactions, writers set aside) and of a DM conversation (`src/reader/independent-dm.ts`), over the sync and writer-set cases that end in such a read, on the fake network and, in `protocol-tests`, against two real PDS hosts. The concurrency, paging-cursor, lifecycle and long-lived-client cases have no second implementation to compare with; they assert stated expected results.
- the performance envelope re-run through the engine, measured as in K4: the existing exact-cap fixture (200 members, 20,000 messages and 20,000 reactions in a channel) with its assertions kept, namely every reaction on the latest page present, parity with the independent reader, and no degraded result.

Gate: every test above passes, with reader parity wherever a reader can express the case; within the truth interval a reopen makes the same number of upstream calls at 20 and at 200 writers; the latest-100 read at the envelope is no slower than the R0 baseline at the median and the 95th percentile.

### R5. Operator API for clients without a cookie — M

- `getChanges`, `createWorkspace` (running the existing `bootstrapWorkspace` kind), `startAuthorityFlow`, `listStalledOperations`, with lexicons. One shared poller per process feeds every waiting `getChanges` call.
- Per-method service-token lifetime. Member-list authorization with its cache, invalidation and the check at send time.
- Notice registration: the creation step, the sweep with its lease and schedule, failure reporting, unregistration.
- The ticket request for the authority flow is authenticated by a service token instead of the cookie session; the rest of the flow is unchanged.

Tests:
- feed authorization: a caller without `read` gets `denied` for that space and answers for the others; a write-only inbox member gets `denied` for the inbox; a member removed during a held poll gets `denied`; a lookup failure denies; a guessed channel URI is denied; a DM inbox is denied to a non-owner; a deleted workspace is `denied` to a member and to its authority alike, and the client's mint then reports it deleted and drops the workspace and its channels; a deleted DM half produces no feed answer and is dropped at the client's next mint.
- feed cursors: a space added after its last event is not missed when followed in the stated order; a space whose access is regained is synced before it is followed; a denied space's cursor does not move; a pruned cursor returns `reset` for that space only; more than 200 entries is refused.
- tokens: a token past its per-method lifetime, or bound to another method or audience, is refused.
- registration: a workspace created before this phase gets its registrations from the sweep; an idle workspace with no admin activity keeps its registrations past a day (clock-advanced); a registration that lapsed while the operator was down is restored at start and was reported meanwhile; two operator processes do not sweep at once; a registration step inside an operation does not wait on the workspace lock; an archived channel is unregistered; the notify sink still refuses a space it did not register.

Gate: a Node script with no cookie, holding only a member session, follows a channel live against the real fixture; the K3 list passes against the real methods.

### R6. One member session, in the browser — L

Before this phase starts I will show the owner the UI data-flow approach and wait for a yes: the engine exposes snapshots and a subscribe function per space, components read them through `useSyncExternalStore`, and `workspace-manager.tsx` loses its fetch and refresh state. Logic only; no styling changes.

- **R6a.** The browser client requests the member set and the DM set in one grant and replaces the DM-only browser session. Workspace discovery and channel reads come from the engine. Writes and operator calls still go through the server. Gate for this step: K9 repeated with the real client.
- **R6b.** Writes and operator calls go through the engine: browser to PDS, and browser to operator with a service token.
- **R6c.** Delete what "What is deleted" lists. `page.tsx` no longer resolves a server session; sign-in is the browser OAuth flow.

Browser hardening in this phase: the content security policy (`src/lib/security-headers.ts`) reviewed for the new connect targets; no third-party script; stores are per account and a test shows one account cannot read another's. After R6c, and not before (R6a still writes through the server), a test shows that no member token and no record content is sent to the web app's origin. Requests to the operator are excluded from that test, since service tokens go there by design and until R7 the operator shares the web app's origin.

Scenario changes, each needing the owner's sign-off because the behavior itself goes away: "Declining the join permission explains itself and keeps the invitation" (`features/workspaces.feature:45-49`) and every step that clicks a per-channel access button. All other scenarios keep their wording. Steps that read `channel_record_cache`, `web_session` or `oauth_session` (`bdd/steps/independent-app.steps.ts:166-172`, `bdd/support/dm-policy-ui.ts:486-508`, `bdd/support/lifecycle-ui.ts:349`, `protocol-tests/app-acceptance.test.ts`) assert the same facts against the browser store where the fact still exists (a lost credential purges the copy) and assert the table is gone where it does not.

Gate: every remaining scenario passes after each sub-step; the engine tests for the route and lifecycle tables are green before any route is deleted; after R6c the server database contains no message content and no member token; `SPEC.md`'s DM invariants restated for one session and still tested (no DM table, no DM content on the server, independent-reader parity).
Rollback: R6a and R6b are revertible one at a time; R6c is the point of no return and is its own commit.

### R7. Packages and the operator as its own service — M

- Moves only for `packages/{protocol,client,testing,reader}` and `apps/web`: pnpm workspace entries, package dependencies replace the path lists in `eslint.config.mjs`.
- `apps/operator` runs as its own process on `@atproto/xrpc-server` (already a dependency), serving the operator methods, the two notice methods, the authority flow and its `did:web` document. CORS for the web origin. The reconcile job lives here.

Gate: `packages/client` and `packages/protocol` build with no Node built-in and no Next import; `packages/reader` depends on `packages/protocol` only; the full suites pass with web and operator on different origins; K9 passes against the real operator process; and in a real browser with web and operator on different origins, once on the same site and once on different sites, the authority flow starts and completes, is rejected without its cookie, rejects a replayed ticket and a replayed state, and runs two flows at once.

### R8. Dedicated workspace account — S to M

Workspace creation takes the authority account and the creating person separately. The authority flow accepts an intended authority other than the initiator, under the binding above. The `createWorkspace` method now issues a new persisted kind of the same name, whose request carries the creator; it adds the creator to the workspace, inbox and first channel member lists and writes the roster and admin records for the creator, not for the authority. The journal row's actor is the creator and its workspace is the authority, so the existing key and lock apply. `bootstrapWorkspace` keeps its handler for rows that exist and is no longer issued. An existing workspace cannot change its authority (the DID is in every URI); that is documented, not migrated.

Recovery before an admin exists: the row is inserted in the transaction that consumes the creation authorization, so the row is the proof that its actor was allowed to create. Until the creator's admin record is written, only that actor may resume the row, as only the authority may resume a `bootstrapWorkspace` row today (`operations.ts:44-50`). Once the admin record exists, any active admin recovers it like every other kind, and the original actor stays the journal and audit principal.

Tests: a DID without a creation authorization cannot create a workspace under an authority that has a grant; an authorization for one name cannot create another; a second `createWorkspace` on one authorization is refused while a retry of the same operation resumes; a pending `bootstrapWorkspace` row still resumes for its authority; a pending `createWorkspace` row resumes for its creator at every step, is refused to anyone else before the admin record exists, and is recovered by another admin after it; when the authority's grant lacks the scope for the first step, the creation answers "reauthorization required" and leaves no row, the creator reauthorizes and retries the same operation id, and the workspace is created with no second creation flow; another DID, or another operation id, cannot use the restored authorization; a restored authorization that is not used expires.
Gate: a workspace whose authority never signs in to the web app is created, administered by two admins, and survives every admin signing out.

### R9. Apps — M

The install record and declaration lexicons, the install collection added to the registry and so to the authority scope, the membership model and the three operations, `packages/client/node` with an OAuth session transport for the bot's own account (K7: an app password cannot mint a space credential), a small event loop helper over `getChanges`, the admin screen that lists, installs and removes apps, a text marker on messages from app accounts, and `apps/echo-bot`.

Tests: with a grant issued before this phase, and with a new grant from which the install scope was removed on the consent screen (a conformance case), `installApp` answers "reauthorization required", leaves no journal row, and succeeds on retry with the same operation id after a complete `reauthorize`; with a full grant it succeeds at once; install at exactly 200 people; the twenty-first app is refused; with an app installed, create a public and a private channel, make one private and public again, archive one, invite and remove a person, and reconcile, each leaving the app exactly where its record says; install, update and uninstall each recover from a failure at every step; a reconcile started during an uninstall cannot restore access; an app cannot read a channel it was not granted (asserted at the PDS); an installed app cannot be invited and a roster member cannot be installed.
Gate: the bot's package imports nothing but `packages/client`; it answers in a granted channel within one poll; after `uninstallApp` it is in no member list, gets `denied` from the feed at once, and its next credential is refused; the lifetime of the credential it already held is measured and written down.

### R10. Interactions, blocks, webhooks — M to L, own plan first

An app inbox space per install (members write, the app reads; the join-request pattern), `new.flock.app.command` and `new.flock.app.action` records, a `blocks` field on messages with text as the fallback, client rendering, and a first-party webhooks app. Detailed in its own plan after R9's gate, because the block vocabulary and the command model deserve their own review.

### R11. UI surfaces and tasks — XL, the existing plan revised first

`.ai/plans/platform-extensions-tasks.md` P4 to P9, with these changes: its P2 registry and P3 kernel work are done by R2 and R4; the merge model lives in `packages/protocol`; the complete and verified sync strategy is designed and built in `packages/client` with its own conformance tests (concurrent listings, commit races, resets, superseded oplog values); clocks are stamped by the writing client, since no server writes for a member; per-entity write serialization happens in the engine. URL routing for channels, messages and extension views belongs here.

## Decisions I will take unless you object

| ID | Decision | Alternative |
|---|---|---|
| D1 | Registry (R2) before the rename (R3), so the rename touches one table and the lexicons instead of 25 files. | Rename first: simpler diff today, repeated in every literal. |
| D2 | The change feed is a long-poll XRPC query that says which spaces changed and nothing else. | Server-sent events (not describable by a lexicon, and `EventSource` cannot send a bearer token); a WebSocket subscription; or a richer payload naming the writer, which saves one call per change and tells an unverified caller who wrote. |
| D3 | `apps/operator` is built on `@atproto/xrpc-server`. | A second Next.js app with route handlers. |
| D4 | Chat syncs by asking each writer's host and re-listing; notices and `listRepos` are hints. The oplog waits for the verified strategy (R11). | Trust the authority's reported revisions or the oplog: fewer calls, and a missed notice or a reset oplog silently loses messages. |
| D5 | The member grant is type-wide (`authority=*`); member lists are the gate. Per-channel and per-workspace consent screens go. | Keep per-space scopes: least privilege for the app's token, at one redirect per channel. |
| D6 | No data migration for the rename or the cutover. Requires your confirmation that no deployment holds data anyone needs. | Write migrations. |
| D7 | Wire identifiers containing "slack" are renamed with the NSIDs; product strings and the package name are not. | Rename the product to Flock everywhere, or nothing but NSIDs. |
| D8 | Apps are not roster members; the install record is their source of truth. | Apps as roster entries with a kind field: one list, but every roster reader changes. |
| D9 | An app's channels are granted one by one. | Workspace-wide installs that follow new public channels. |
| D10 | Channel history is stored in the browser (IndexedDB); DM history stays in memory. | Memory only: nothing at rest on the device, slower reloads. |
| D11 | The engine is not placed behind the server routes on its way in (R4). | A strangler step with a server-side store adapter: the BDD suite exercises the engine earlier, at the cost of code written to be deleted. |
| D12 | Two bounded delays are accepted: a listed writer whose notice was lost is caught at the next truth check (hourly while the space is open and its host reachable, tuned by K4), and a removed member can see "this space changed" for up to 60 s. | Shorter intervals at more calls; or no cache on the feed check at one member-list read per poll. |
| D13 | At most 20 apps per workspace; grants are read or read and write; an account is a person or an app in a workspace, never both. | A higher bound, to be justified by a measured envelope. |
| D14 | History follows the authority's writer set, as it does today: when a person or an app is removed from a space, or reduced to read-only, their earlier records stop being shown, in every client alike. Never-reported writers stay unread. Both are stated in the product and the SDK contract. | Keep showing them from a second source of writers (a record the authority keeps of past writers, read directly at their hosts). That is a product change with its own review, and the hosts may refuse a removed member's repo. |

## Risks

- **Browser sync cost.** The first open of a busy channel in a session asks every writer once, from one browser. K4 measures it before R4; R4's gate holds the line; progressive filling and IndexedDB are the mitigations. If the numbers are bad the plan stops at R4 with a working engine and no cutover.
- **Tokens and history in the browser.** Injected same-origin script could use the member session and read stored history, even though the key cannot be exported, and the type-wide grant makes that every workspace the person is in. R6's hardening items are the controls; they reduce the risk and do not remove it. A browser crash or storage eviction can leave or drop a store outside the sign-out path.
- **Two tabs.** Two tabs share one store and may refresh the same writer twice. The generation check decides which result is kept; the duplicate requests are accepted.
- **Removed writers' history.** See D14. Uninstalling a bot or removing a person hides what they wrote. It is how the pinned protocol behaves and how this app behaves today for a fresh account; with apps it will be noticed more.
- **Two-week member sessions.** A public browser client is capped at two weeks by the pinned provider, so people sign in again every two weeks. This is today's DM behavior applied to everything.
- **What the server can no longer do.** Server-side search, push and unread counts need an app that is a visible member. That is the intended trade.
- **R6c is one-way.** The server member session cannot be brought back by a revert once clients depend on the browser session; hence the two reversible sub-steps before it.
- **Writers missing from `listRepos`.** The writer set is what the authority learned from notices. A writer the authority never heard of is invisible to chat, as it is today, and no interval bounds that. The verified strategy in R11 unions the roster.
- **Listings are not authenticated.** See "What is authenticated". A writer's host can serve any listing for that writer; this plan neither adds nor removes that trust.
- **Author-chosen keys.** Ordering still trusts keys the author chose (upstream request U5). Nothing in the sync uses a key to decide whether to read a writer.
- **The change feed leaks timing.** See D12. DM conversation feeds stay as open as they are now, and say no more than they do now.
- **Authority custody remains.** The operator still holds a grant that can administer the workspace. R1 and R8 make it durable, bound and separate from any person; only upstream delegated management (U4) removes it.
- **Loopback cannot exercise the confidential client.** The two-year lifetime may be testable only on staging (K2).
- **Lexicon publication.** Until the records and DNS entries exist, no outside party can resolve the lexicons; the code does not depend on resolution.
- **Protocol churn.** The pin is a draft. One registry and one sync core put each future re-pin in one place.

## Relation to the extensions plan

Kept: its survey, its registry idea (R2), its journal-name rule and recovery tests (R2), the purge and notice-cap hazards (the purge logic moves to the engine's lifecycle table; the notice cap becomes per space type in R5), and its merge model (R11). Changed: order (bot before tasks), where sync lives (the engine, not a second strategy in `channel-sync.ts`), and who stamps clocks. On approval of this plan that file should get a status line pointing here; I have not edited it.

## Not verified

- Nothing in the facts table was run; K1 to K9 exist to run the ones that matter.
- I did not re-read `src/reader/independent.ts`, the BDD step bodies or `protocol-tests` in full, so the test-migration lists in R6 are from searches, not from reading every step.
- Whether `@atproto/xrpc-server` at the installed version fits a small standalone service without pulling a second copy of shared dependencies.
- That the owner controls `flock.new`.

## Review rounds

### Round 1 (Codex CLI 0.167.0, `gpt-6.1-terra`, high reasoning; verdict REVISE)

The run was asked for a read-only sandbox (`-s read-only`), but its header reported `danger-full-access`, so read-only held by instruction only. No file in this repository or the pinned checkout was modified during it (checked by modification time and `git status`). Eleven blocking findings, each checked against the source before editing:

- B1 (a writer's `repoRev` cannot bound what it contributes to a window): valid. Revisions and keys come from different clocks, and reaction keys are hashes; a forward-dated message would have lost other people's reactions. The cut-off is gone; reported revisions only order the visits.
- B2 (the stale rule could miss changes for good): valid. Reported revisions lag, and re-listing "down to the oldest held key" misses a record inserted below it. The sync now has a coverage per writer, reads the revision at the writer's host before listing, commits a refresh atomically, treats notices and `listRepos` as hints, and re-checks each writer within a truth interval. Test list added to R4.
- B3 (the DM feed would reveal more than a counter): valid. The feed now names spaces only, for every kind of space.
- B4 (feed authorization confused membership with read access, and left cursors and revocation undefined): valid; inbox members are write-only (`operations.ts:372`). The feed requires `read: true`, fails closed, re-checks at send time, bounds the request, and defines `denied` and `reset` (a separate "deleted" answer was added here and withdrawn in round 2). The 60-second delay is D12.
- B5 (apps break more than reconcile): valid (`operations.ts:592-618`, `:274-354`; `space-ops.ts:58-62`). One membership model, limits, record-first ordering and the R9 tests.
- B6 (the member scope lacked inbox read): valid, added, and K3 now exercises the exact final grant. The second half, that `rpc?lxm=…&aud=…` is malformed, I did not take: the pinned parser takes repeated `lxm` parameters (`rpc-permission.ts`) and `operatorMethodsScope` (`permission-sets.ts:167-170`) emits that form today. The plan now says the builders produce the string.
- B7 (the authority flow was not bound to who started it, for whom, and why): valid. See "The authority grant flow" and the R1, R5 and R8 tests.
- B8 (deleting routes would delete rules): valid. The route table and the lifecycle table are the inventory, and R6 may not delete a route before its engine tests pass.
- B9 (registration needed backfill, renewal and visible failure): valid; a registration lasts about a day and a failure is swallowed today. One sweep, reported failures, unregistration, and the client's truth interval as the fallback.
- B10 (the journal rule conflicted with R8, and the R2 test conflated shape with meaning): valid. R8 adds a new kind instead of changing one; R2's tests are split.
- B11 (no gate proved the browser can talk to the real hosts): valid. K9, repeated as the R6a gate; the "nothing sent to our origin" check is reworded.

Facts table: rows 1, 3 to 9 reworded to what was read and no more; the `getServiceAuth` one-hour limit, the listing order, the membership invariants and the write-only inbox added. Non-blocking items taken: browser custody controls, app grant semantics and the held-credential residual, the measurement method for the performance gate, and both "simpler option" suggestions (names-only feed; no cut-off).

### Round 2 (same session and model; verdict REVISE)

The sandbox override was again not applied (`danger-full-access` in the header); again no file was changed by the run. The reviewer withdrew its round 1 claim about the RPC scope form. Ten blocking findings, each checked against the source:

- B1 (a listing bracketed by one revision read is not a snapshot): valid. Coverage is now "one consistent state no older than `syncedRev`", established by reading the revision before and after the listing, with bounded retries and a "changing" report; backfill has the same bracket.
- B2 (a transaction does not stop an older refresh overwriting newer state): valid; the current code guards this (`cache.ts:15-21`, `channel-sync.ts:210-223`). Writer state carries a generation checked at commit.
- B3 (a key-only `before` cursor drops same-key records of other writers): valid, and present in the DM merge today (`src/dm/merge.ts:36`). The cursor is `(key, record URI)`, tested for channels and DMs.
- B4 (removed and never-reported writers; "within an hour" overstated): valid; the pinned host removes a writer on removal and on `write: false` (`manager.ts:109-129`). The writer-set rule, D14 and the narrowed wording.
- B5 (no durable path for a `deleted` answer): valid. The feed no longer promises it; a client learns of a deletion from its own credential, prompted by `denied`.
- B6 (one cursor over a changing set of spaces can skip events): valid. Cursors are per space, with a stated order for starting to follow one.
- B7 (R0 gated on methods and a topology that arrive later): valid. K3 and K9 are capability checks with throwaway stand-ins, repeated at R5, R6a and R7.
- B8 (R5 and R8 disagreed on the persisted kind; recovery before an admin exists was undefined): valid. The method table says which kind each phase issues; R8 defines authorization, the journal principal and recovery.
- B9 (the sweep had no schedule and could re-enter the workspace lock): valid; `runJournaledOperation` takes the lock (`journal.ts:44-52`). Registration takes no workspace lock; the sweep has a start-up run, a 30-minute schedule and its own lease.
- B10 (a cookie-bound flow and a cross-origin deployment): valid. The flow starts by ticket and top-level navigation on the operator's origin, the cookie is named as the one exception, and R7 gates it in a real browser on same-site and cross-site origins.

Non-blocking items taken: what a page says when the bound is reached; creation authorizations are single-use and bound to a name, with no standing list; the truth interval worded as a maximum delay with an overdue state; the timing of the "nothing sent to our origin" check; R3 says outright that local data is discarded; listings stated as unauthenticated.

### Round 3 (same session and model; verdict REVISE)

Sandbox as before; the plan's hash was identical before and after the run and no other file changed. Three blocking findings, each checked against the source:

- B1 (the authority grant cannot write the install record): valid; the scope enumerates collections (`permission-sets.ts:95-111`) and the PDS checks them (`space-permission.ts:142`). The scope is computed from the registry, a short grant leads to reauthorization (how it is detected was corrected in round 4), and R9 tests a grant from before and after the change.
- B2 (a deleted space is not always `denied`): valid; the authority skipped the member-list read, and a DM half is never checked. The authority now passes only if the list can be read; for DM halves the plan says deletion is noticed at the client's next mint, as today, and R5 tests the three cases separately.
- B3 (the independent reader cannot be the oracle for every R4 case): valid; it only does a fresh channel read (`src/reader/independent.ts:115`). Parity is required where a reader can express the case; the rest assert stated results.

Non-blocking items taken: the paging cursor is one opaque string, so `DmClient`'s types do not change; the coverage definition says "as that host reports them"; R3 lists its targets and waits for confirmation before deleting.

### Round 4 (same session and model; verdict REVISE)

Sandbox as before; plan hash identical before and after; no other file changed. Two blocking findings, both checked against the source:

- B1 (the scope a grant was requested with is not the scope it was given): valid; the pinned provider lets the person drop scopes at consent (`request-manager.ts:434-441`). The comparison I added in round 3 is gone. A step the PDS refuses for a missing scope leads to reauthorization, with the journal row discarded when nothing had completed, which is the mechanism creation already uses. R9 tests a grant with the install scope removed at consent.
- B2 (one 20,000 bound for messages and reactions together breaks the supported envelope): valid, and my error in round 2; today's bounds are per collection and the fixture holds 20,000 of each. The bound is per collection again, and R4's gate keeps the fixture's assertions.

Non-blocking item taken: deletion is noticed within one poll only when the operator received the notice; otherwise within the 60-second cache.

### Round 5 (same session and model; verdict REVISE; the last round the procedure allows)

Sandbox as before; plan hash identical before and after; no other file changed. One blocking finding, and the reviewer's statement that it found no other issue meeting the blocking bar:

- B1 (discarding an empty creation row would also discard the only authorization to retry): valid; it follows from two rules added in rounds 2 and 4. The authorization is now restored in the transaction that discards the row, for the same operation id only, and R8 tests it.

While applying it I found and fixed an inconsistency the reviews had not raised: the creation authorization was written as if every creation needed one, which would have made the authority account approve again for each workspace. It applies only to a caller other than the authority, from R8; the R1 test that assumed otherwise is replaced.

Not re-reviewed: this round's change and that correction. The raw output of all five rounds is in `.ai/reviews/codex-plan-review-platform-refactor.md`.

## Outcome and departures from this plan

### R0 (2026-11-09)

Done: K1 to K9 and the baseline, recorded under "R0 results". Departures: K4 ran in Node with a six-connections-per-origin emulation instead of Playwright, and its call counts exclude browser-added preflights (R6a counts the real client in a browser); K6 and K8 ran as throwaway scripts whose reports are kept in `.ai/spikes/`; the performance tests gained repeated, checked reads so the baseline has a median and a p95. Design changes taken from the results: a grant is used at least every three months (K2); R2 pins the alpha `@atproto/lexicon` snapshot (K8); the engine caches DID documents across sessions and fills pages progressively (K4); the bot holds its own OAuth session, not an app password (K7).

Review: Codex CLI (`gpt-6.1-terra`, read-only sandbox, honored) reviewed the R0 artifact in five rounds, each verdict REVISE (CHANGES_REQUIRED). Round 1: an incomplete baseline, K4 not a fixed dataset and not checking it read the new message, K3 not invoking the operator methods or reading an inbox request, K9 bypassing OAuth, K1 deleting a token instead of ageing the session, K7 claiming more than it tested, and the helper leaking environment. Round 2: K4 figures stated for dense data they did not cover, the baseline method, K1's `todo` also covering setup, no direct preflight observation, and an overbroad U12 compatibility claim. Round 3: K4 counts excluding preflights, repeated performance reads not checked, K1 not pinning the exact outcome matrix. Round 4: K1 as a future gate (answered: R1 rewrites the fixture), K4's seed wait and completeness, K6 and K8 evidence. Round 5: preflights settled before the browser's CORS check, a notice race in K7, and an overstated K5 hash claim. All were valid and fixed; the round 5 fixes were re-run against the pre-R1 code but not re-reviewed.

### R1 (2026-11-10)

Done as planned: `src/operator/authority-grant.ts` owns the grant (its own OAuth client, tables `authority_grant`, `authority_grant_state` and `authority_ticket`, and the routes under `/authority/`); the operator, workspace creation and the reconcile job restore it; a sign-in never writes it and a sign-out never revokes it. The K1 scenarios are now R1's gate and pass: after the creator signs out (through the real logout route), signs in again elsewhere, or lets the sign-in lapse, a second admin's `execute`, `getOperation` and `listInboxWriters` calls and the reconcile job all succeed, and one grant creates any number of workspaces.

Departures and additions:
- The key variable is `AUTHORITY_CLIENT_PRIVATE_JWKS`, a JWK set, not `AUTHORITY_CLIENT_PRIVATE_JWK`, so several keys can be published for rotation. It is read only by the authority client, so a web app without it still starts. A grant stays bound to the key it was approved with (the pinned OAuth client signs every refresh with that key), so rotation is "publish, wait, switch, and remove an old key only after its grants were approved again"; a grant whose key is missing asks for approval and keeps its row.
- Sign-in now also asks to read the spaces the account is itself the authority of (`MEMBER_SIGN_IN_SCOPES`). Before R1 the creator read its own workspaces through the authority scopes on its sign-in; without them the creator's own workspace, inbox and channels would have disappeared from its view. A visible consequence: an authority opening a second app instance sees its workspace at once, without an invitation (one BDD helper changed; no scenario wording changed).
- Admin operations get a reauthorization path now, not only at R9: when the operator holds no usable grant, the app's `execute` route answers `authorization_required`, the UI sends the authority through the authority flow (`reauthorize`) and keeps the operation pending, and other admins are told the authority must approve again. Mapping a scope refused after journal steps stays with R2's runner option.
- The flow's states are consumed atomically on read; a wrong-account approval runs against a staged store, so that account's own grant is never touched; a replaced grant is signed out after the replacement is written, under the grant's refresh lock, and a sign-out that fails is recorded as an audit event; a revoke deletes the row under the same lock; an unreadable row (wrong `AUTH_ENCRYPTION_KEY`) is replaced by a new approval and deletable by `pnpm authority revoke`; `/authority/start` refuses `HEAD`.
- The pinned PDS sign-in page forces the hinted account (`forcedIdentifier` in `oauth-provider-ui`), so a wrong-account approval cannot be produced through it; that rejection is covered by unit tests. The confidential client is checked by building it with the pinned OAuth client from the deployment's metadata and keys; a staging run against an HTTPS PDS has not been done.

Tests: unit tests for tickets, flow binding and expiry, wrong-account rejection, replacement and revocation under the lock, unreadable rows, a missing key, and both client shapes; the K1 gate; a real-provider browser test in which two approvals at once leave one grant that then creates a workspace, and a used callback replayed with its own cookie restored is refused; the existing acceptance and browser flows moved onto the grant.

Review: Codex CLI round 1 (`gpt-6.1-terra`) found five issues (a revocation racing a replacement, no reauthorization path for existing workspaces, non-atomic state consumption, tests weaker than claimed, silent revocation failures); all were fixed. Round 2 could not run: the Codex CLI rejected the configured model for the account ("The 'gpt-6.1-terra' model is not supported when using Codex with a ChatGPT account", `model_not_found`), and the owner's instructions are not to retry or switch models on such an error. A fresh independent review (a Sonnet subagent, per the code-review procedure) verified all five fixes and found two more important issues (the rotation runbook would have destroyed every grant, and an unreadable row blocked recovery) and several minor ones; all were fixed. The fixes after that review were not reviewed again.

### R2 (2026-11-10)

Done as planned: `src/protocol/nsids.ts` owns every NSID and a test refuses an NSID spelled anywhere else in source; `src/protocol/registry.ts` is the one table of space records, and validation is the published lexicon's shape (through the pinned alpha `@atproto/lexicon`) plus the entry's meaning rule; records are open and a record over 64 KiB is not read; `src/protocol/scopes.ts` replaces `src/auth/permission-sets.ts` and derives the authority scopes from the table. The operator dispatches through a table of kinds, one file each under `src/operator/kinds/`, and workspace creation runs through the same journal runner. `src/atproto` and `src/operator` no longer import `src/workspaces`, and a lint rule now keeps it that way; the notice tables moved to `src/operator/notices.ts`, the workspace summary and envelope to `src/protocol/workspace-summary.ts`.

Differences between the old hand validator and the lexicons. The lexicon wins except where noted:
- Length units: message and DM text were at most 10,000 code points; now at most 10,000 graphemes and 40,000 UTF-8 bytes. Names were at most 80 UTF-16 units; now 80 graphemes and 320 bytes. A reaction emoji was at most 32 UTF-16 units; now 32 graphemes and 128 bytes. Everything the old limits accepted is still accepted. The published message lexicons said 10,000 bytes, less than the app itself wrote, and now say 40,000.
- Unknown fields: rejected before, accepted and kept now.
- Datetimes: the lexicon accepts forms the old check refused (no time zone, `24:00:00`, year 0000, impossible dates such as 31 February) and refuses a `-00:00` offset. Timestamps are only displayed, so nothing orders or crashes on them.
- The lexicon refuses DIDs with a digit in the method and TIDs starting k–z; this app writes neither.
- Channel keys in a directory or join request: the old check allowed only the app's key alphabet; the lexicon's `record-key` format allows `.`, `_`, `:` and `~`. Only the authority writes directory records, and a join request's key must still derive from its channel.
- Kept stricter than the lexicon, in the meaning layer: a roster, admin or channel-roster subject must be a DID of at most 512 characters (the lexicon's `did` format has no bound); DM text must not be blank; DM participants must be sorted and unique.
- Deliberately closed: `visibility` and `decision` became `enum` instead of open `knownValues`, since a new value changes who can read a channel or what a decision means; a new value takes a new NSID.

Departures and additions:
- Waiting for the authority's approval applies to every kind, not only to workspace creation as the plan's "an option of the runner" suggested; the runner's one option is `replay`, which recovery passes. A missing scope in any step marks the operation `authorizationRequired`. When its submitter is running it with no step done, the row is discarded and the same operation ID is retried after approval. A replay during recovery keeps another admin's row pending, and the current request answers "the authority must approve again" (403 `authorization_required` in the app). A missing scope outside a step gets the same answer.
- Who may run an operation is decided by `authorizeOperationActor`, from the kind: an admin may run any kind except one only the authority may start; a member may run a member kind once the request is valid and the kind's own check agrees. A member's invalid `leaveChannel` key now answers 400 instead of 403.
- Workspace creation now retries a transient PDS failure like every other operation, so one acceptance test's injected outage had to outlast the retries.
- `createChannel` checks its members with one member-list read.
- A DM edit now keeps fields another app added, like the channel-message edit. The operator still writes the authority's own records (rosters, admins, the directory) whole: only the operator writes them.
- `collectionSpaceType`, `isAuthorityCollection` and `PERMISSION_SET` were written and then deleted, because nothing read them. The registry's `sync` field stays for R4. `cache.ts` still tests space types itself, because R4 moves it into the engine.

Tests: the kind table is pinned (names, request fields, actor, steps), and a static check finds every step a run body records among its kind's declared steps; journal rows written by the pre-R2 code (workspace creation and channel creation, each with no step done and half done) resume under the same hash, actor and workspace lock and repeat no write; recovery that meets a missing scope keeps the other admin's row; the authorization rules, with the request validated before any read; schema parity (more than 150 generated records get the same verdict from the registry and from the lexicon documents read from disk alone, and an ill-shaped one never passes full validation); a well-shaped record that breaks each meaning rule is rejected for that rule; a record with an unknown field is accepted in every collection, and a BDD scenario checks that a field another app added survives this app's message edit.

Review: Codex could not run. The configured model (`gpt-6.1-terra`) is the one the Codex CLI rejected in R1 (`model_not_found`), and the owner's instructions are not to retry or switch models after such an error. Asked how to proceed, the owner said to continue, so R2 was committed after the independent review, as R1 was. Review followed the code-review procedure instead, with Sonnet subagents. The reviewer found no behavior change in the moved operator code. A 200,000-input differential fuzz of request validation against the pre-R2 code found no difference; a 400,000-input fuzz of the registry found only the intended ones. It reported two important gaps: the rewritten authorization had no test, and a recovery replay could discard another admin's row. It also reported several minor ones: the roster DID bound, dead exports, unchecked bootstrap replays, the authority kind enforced in one place, and no test that run bodies use declared steps. A critic confirmed most of these, corrected two (the datetime difference is listed in K8; `sync` is used by R4) and added four (a missing scope outside a step, fail-open field rules, DM edits dropping unknown fields, and the enum choice). All were fixed. A second-round reviewer of the fixes found no defect and five minor points, which were fixed too.

### R3 (2026-11-10)

Done as planned: every `org.slack.` NSID is `new.flock.` with the same suffix; the 25 lexicon documents moved to the path their NSID implies (so `channelMessage.json` and `channelReaction.json` became `channel/message.json` and `channel/reaction.json`); the operator's XRPC routes moved to `src/app/xrpc/new.flock.operator.*`; the lexicon client was regenerated with the pinned `lex-cli`. The wire identifiers changed with them: the operator service is `#atproto_flock_operator` of type `AtprotoFlockOperator`, the pause switch is `FLOCK_ADMIN_MUTATIONS_PAUSED` (now also in `.env.example`), and the default database is `./data/flock.db`. Product strings, the package name, test file names and temp-directory prefixes keep "slack" (D7). Outside `.ai/`, neither file contents nor tracked paths contain `org.slack` or `slack_admin`.

Data (D6): no local app database existed (no `data/` directory and no `DATABASE_PATH` in either checkout), and PDS fixtures live in memory or in temp roots removed after each run. The only data holding the old names were 51 unit-test temp directories that had outlived their runs; the owner confirmed the exact list and only those were deleted. Journal rows were not carried over. One pinned request hash in the replay test was recomputed, since the workspace URI it hashes now carries the new NSID; the kinds keep their names.

Departures: the review found that the first pass renamed file contents but not the three route directories named after operator NSIDs, so every operator call would have answered 404 (acceptance and browser failed on exactly that). They were moved, and a unit test now requires a route at each operator method's NSID and none for an NSID the app does not define. The project skill's stale pointer to `src/auth/permission-sets.ts` (left by R2) now names `src/protocol/scopes.ts`; `PROGRESS.md` keeps its historical paths.

Gate: the pinned-checkout conformance suites pass under the new names (13 suites, 275 tests and one upstream `todo`), as do unit, acceptance, browser and BDD. Not done here (owner prerequisites before any deployment): control of `flock.new`, the `_lexicon` TXT records, and publishing the lexicon records.

Review: Codex was not run (the configured model is the one rejected in R1; the owner said to continue). A Sonnet reviewer checked the rename's completeness and consistency, regenerated the client independently (byte-identical), and found the route-directory defect above.
