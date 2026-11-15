# R9 progress: apps

Plan: `.ai/plans/platform-refactor.md`, "### R9" and "### Apps" in the target design. Two steps, each gated and committed:
r9a is the protocol and the operator (an app can be installed, changed and removed, and every invariant knows it); r9b is
the app's runtime and the people's view of it (the Node transport, the event loop, `apps/echo-bot`, the admin screen, the
message marker).

## r9a: apps in the protocol and the operator

Status: done. Outcome, departures, gate and reviews: the plan's "### R9a" section.

### Records

- **`new.flock.app.declaration`**, key `self`, in the app account's own public repo (`REPO_COLLECTION`, like
  `dm.declaration`): `name` (1 to 64 graphemes), optional `description` (up to 300 graphemes), `createdAt`. It is a label,
  never a grant: the admin screen reads it before an install and installs no account without a valid one, and clients read
  it to show the app's name. The operator does not read it, as it reads no account's repo but a join request's.
- **`new.flock.app.install`**, in the workspace space, authority-written, key `subjectKey(app)`: `subject`, `active`,
  `channels` (each `{ skey, write }`: read always, write when granted; there is no write-only grant; at most 100),
  `installedBy`, `installedAt`, `updatedAt`. It is the grant, and what clients read to mark the account as an app.
  Archiving a channel takes it out of every install's `channels`.
- The registry gains both, so the workspace authority scope (built from the registry) now names the install collection,
  and `permissions/workspaceAuthority.json` with it. A grant approved before r9a lacks it; see "Reauthorization".

### One membership model

`apps/operator/src/operator/membership.ts` is the one owner of "who should be in this space's member list, with which
bits". Each list's expected entries are a function of the state it reads (roster, admins, a private roster, active
installs), and `appAccess` alone says where an app belongs, for these lists and for an app's own operations:

| Space | People | Apps |
|---|---|---|
| workspace | the roster, read and write | every active install, read only |
| inbox | the roster, write; admins also read | none |
| public channel | the roster, read and write | installs granting it, with their bits |
| private channel | its roster's members who are on the workspace roster, read and write | installs granting it |
| archived channel | none | none |

A channel being made public or private or archived (`transitioning`) is its operation's to move; reconcile skips it as
today. The authority is never listed (it owns the space).

Users of the model:
- `currentWorkspaceMembers`: compares the workspace space's list with the model, not the roster alone, and still returns
  the people. It is used by `createChannel`, `transitionChannel` and the reads that need the people.
- `transitionChannel`: an app granted the channel keeps its bits through a change of visibility (a new step,
  `channel-app-{did}`, sets them when they differ), and the convergence check counts it.
- `archiveChannel`: before removing members it takes the channel out of each install that grants it (a new step,
  `channel-archive-app-{did}`), then removes everyone as today.
- `reconcileWorkspace`: every space's desired list is the model's. Its existing step names already name any DID.
- `createChannel`: a new channel has no grants, so it changes only through `currentWorkspaceMembers`.

### Operations (persisted kinds, admins, through `execute`)

- **`installApp { subject, channels }`**:
  - It refuses the authority; an active roster member ("a workspace member cannot be installed"); a twenty-first active
    install; and a channel that is not active (archived, transitioning, missing).
  - It also refuses a different active install of that app ("already installed; change its access instead"). The same
    one passes, so a resume passes.
  - Steps: `app-install-record`, then the shared access steps.
- **`updateAppAccess { subject, channels }`**: an active install only, the same channel rules. Steps:
  `app-access-record`, then the shared access steps.
- **`uninstallApp { subject }`**: an install, active or not. Steps: `app-uninstall-record` (inactive, no channels), then
  the shared access steps.
- **The shared access steps** (`applyAppAccess`): for the workspace space and every active channel, the app's entry is
  set to what the install record now says, or removed (`app-workspace-set`, `app-workspace-remove`,
  `app-channel-{skey}-set`, `app-channel-{skey}-remove`), then `app-access-verified`.
  - It works from the PDS lists, not from the previous grant, so a resume after the record step is correct with nothing
    else remembered.
- **Order:** the record is written first and every operation, reconcile included, holds the workspace lock. A run that
  stops leaves the lists behind the record, and the next run or reconcile moves them toward it, never away from it.
  - So a reconcile after an uninstall stopped midway finishes the removal.
- **The other kinds:**
  - `inviteMember` refuses an active install ("an installed app is not invited; it is installed").
  - `removeMember` refuses one too ("remove an app with uninstallApp"), since the record would put it back.
  - `setAdmin` already requires a roster member.
  - An app cannot start a member's kind: an actor needs read and write in the workspace list.
- **Limits:** at most 20 active installs, apart from the 200 people. `WORKSPACE_ENVELOPE` gains `apps: 20` and
  `memberList: 220`, the one bound every member-list read uses. Today 200 appears separately in `space-ops.ts`, the client
  (`channel-client.ts`) and the reader (`independent.ts`).
- **Lexicons:**
  - `execute`'s `operationRequest` gains the three kinds and `channels` (an array of `{ skey, write }`, at most 100).
  - `kinds.test.ts` pins the new kinds, fields and steps; the steps added to `transitionChannel` and `archiveChannel`
    are additions, and no step name changes.

### Reauthorization

An authority grant from before r9a lacks the install collection. `installApp`'s first step is the install record, so the
PDS refuses it for a missing scope, and the journal treats that as it does for any kind's first step:
- it discards the row with nothing done;
- it answers as `execute` always has for a grant short of a scope ("the workspace authority must approve its permission
  again", `AuthoritySessionUnavailable`), which the web app's approval path already takes;
- the admin's app runs the reauthorize flow, and the retry with the same operation id succeeds.

Unit tests cover this with the fake PDS refusing the install collection. The acceptance test stores a grant whose consent
left out the workspace records' permission (the pinned provider issues only scope strings the client declares, so the
grant from before r9a cannot be minted again; this is the same refusal at the same first step, and what a consent screen
with that scope removed leaves), and then a complete one.

### Tests (r9a)

- **Unit:**
  - the model, every row of the table;
  - each kind's refusals;
  - install, update and uninstall resumed after an outage at every step, with no write repeated;
  - a reconcile after an uninstall stopped after its record step, leaving the app in no list;
  - with an app installed: create a public and a private channel, make one private and public again, archive one,
    invite and remove a person, and reconcile, each leaving the app exactly where its record says;
  - the twenty-first install refused;
  - an installed app refused by `inviteMember` and `removeMember`, and a roster member refused by `installApp`;
  - the reauthorization path.
- **Acceptance on the real PDS network:**
  - install with an old grant (refused, no row) and after reauthorizing;
  - the app reading a granted channel and refused an ungranted one at the PDS;
  - after `uninstallApp`: in no member list, `denied` by `getChanges` at once, and its next credential refused.
- **The 200-person case:** an install at exactly 200 people, then a reconcile that changes nothing, in `apps.test.ts`. It
  sets the people up directly, as the performance envelope does, without the envelope's four million records.
- **Gate for r9a:**
  - unit, typecheck, lint;
  - acceptance and browser;
  - BDD, unchanged scenarios, since no screen changes yet.

## r9b: the app's runtime

Status: done. Outcome, departures, gate and reviews: the plan's "### R9b" section.

Found in r9a's acceptance run, and binding here: the pinned PDS keeps the write bit at the authority, which lists a member
without it as no writer (a record it writes into its own repo is accepted by its host and synced by nobody). An app reads
the workspace space only, so it is never a writer there: its acceptance record is never listed, and an app cannot find its
workspaces the way a person does. An app is told its workspaces, and reads its install record in each for its channels.

- **As built** (after review): the operator's guard on reaching other hosts moved into `packages/net`, which a Node app's
  transport uses too; the browser's and a Node app's transports are one `sessionTransport`; and the runtime reports every
  failure, idles with nothing to follow, follows each space on its own, and decides what is new by a window over writer keys
  (the last complete read less five seconds to the present plus five), after a page-based design kept falling to keys a
  writer chooses.
- **One DID resolver for every client.** `apps/web/src/browser/identity.ts` (PLC and `did:web` documents fetched and cached,
  the PDS endpoint, the KEM key, the handle) is fetch-only and not the browser's: it moves to
  `packages/client/src/did-documents.ts`, and the web app and a Node app both use it.
- **`@flock/client/node/*`** (`packages/client/src/node/`): the only part of the client that runs on Node, outside the
  browser lint rules and the no-Node typecheck of the rest, with `@atproto/oauth-client-node` as the client's one Node
  dependency.
  - `transport.ts`: `nodeTransport(session, identity)`, the engine's transport for an OAuth session. It is the same
    shape as the browser's: the session's own client, the shared resolver, `fetch` with no redirects, and
    `generateSpaceKey`.
  - `oauth.ts`: the app's OAuth client.
    - A confidential `private_key_jwt` client whose metadata and JWKS the app serves itself, as the operator's
      authority client does; or, on loopback, the public loopback client. The provider gives the latter a two-week session.
    - Sessions and flow state live in one file, created with mode 0600. It holds the DPoP keys and is never logged.
    - `signIn(handle)` returns the authorization URL and completes on the loopback callback; `restore()` returns the
      session.
    - A refused refresh throws, and the app stops and says to sign in again.
- **`app-runtime.ts`** (`packages/client/src/`, runs anywhere): `runApp({ engine, operator, workspaces, onMessage, signal })`.
  - For each workspace it reads the app's own install record, through a new `installs` in the workspace summary, the
    same records the web app shows.
  - It follows the workspace space and each granted channel with `ChangeFollower`, and syncs the granted channel list
    again when the workspace space changes.
  - It reads each changed channel's newest page and calls `onMessage` once per message it has not seen. Messages
    present when a channel is first followed count as seen, so a restart answers nothing old.
  - It stops following a channel whose grant ends, and stops altogether on `signal`.
  - It answers nothing an app wrote: messages from any active install, itself included, so two apps never talk in a loop.
- **`apps/echo-bot`**, a Node package that depends on `@flock/client` alone (its `package.json`; lint's
  no-extraneous-dependencies holds it there).
  - `sign-in <handle>` runs the OAuth flow once.
  - `run` publishes its `app.declaration` unless it already says the same, then runs `runApp` over the workspaces in `ECHO_BOT_WORKSPACES`.
    It replies `echo: <text>` in the thread of each message from a person, in channels it may write.
  - Configuration is in the root `.env.example`.
- **Tests:**
  - unit tests for the transport, with a fake session;
  - the runtime, with a fake engine and feed: seen messages, grant changes, apps not answered, stop;
  - the echo reply.
- **Gate:** an acceptance test on the real PDS network runs the echo bot's own `run` with a session minted for its
  account.
  - It answers a person's message in a granted channel within one poll of the feed.
  - Once uninstalled, it is in no member list, the feed denies it, it is refused its next credential, and its loop stops
    following the channel.
  - The residual of a credential it held is r9a's measurement.

## r9c: the people's view of apps

Status: done. Outcome, gate and review: the plan's "### R9c" section.

- `WorkspaceSummary.installs` (from r9b) drives both parts.
- **Admin screen.** An "Apps" section lists each install: its declared name (read from its repo, its DID when
  there is none), its channels, and read or read-and-write for each.
  - Installing takes an account (handle or DID) and the channels.
  - The app reads its declaration first and installs nothing without a valid one.
  - Changing access and removing reuse the same form. Before a removal, the screen says the app's earlier messages leave
    every channel's view.
- **The marker.** A message whose author is an active install shows "APP" after the author's name, as text.
- **Gate:** a BDD scenario through the real UI.
  - An admin installs the echo bot in #general (the harness runs its `run` in-process with a session for its account).
  - A member posts, and sees the bot's answer marked as an app's.
  - The admin removes it, and the answer leaves the view.
