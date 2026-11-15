# R10 progress: interactions, blocks, webhooks

Plan: `.ai/plans/platform-refactor.md`, "### R10" and "### Apps" in the target design. This file is R10's own plan, which that
section asks for before any code. **Status: proposed, owner approval pending. Nothing implemented.** Three steps, each gated,
committed and reviewed as its own PR in the stack.

## Review history

| Round | Reviewer | Verdict | Outcome |
|---|---|---|---|
| 1 | agy CLI, `gemini-4-carbon-high` | REVISE (18 blocking, 2 not) | Every finding checked against the code; all held and are answered below: the operator's feed and notice sweep, scopes and scope drift, the self-owned authority, registry limits, the client APIs the plan needs, the webhooks app's identity client, the pin, the inbox key, the privacy boundary, forged click values, cross-workspace commands, click semantics, removed members, the webhooks app's security, step order, inactive inboxes, the kind table, the envelope test, the composer, and managing hooks on a page only. |

## Baseline and order

R10 is built **after the Spaces pin moves to `d4def6e`** (D6; `.ai/plans/protocol-drift-d4def6e.md`, a proposal in the
platform worktree, not on this branch). The stack is then `main` ← `feat/platform-refactor` ← `fix/script-policy-and-cors` ←
the migration ← `feat/r10-interactions`, and R10 is rebased onto the migration before R10a starts. What R10 takes from the new
pin: batch membership (`putMembers`/`removeMembers`, up to 100 members per call), notice registration inside
`authorizeSpaceSync` (the operator registers a space by authorizing a sync with a `notify` endpoint and token), and space
declarations carrying `title`. Every membership write goes through the owner functions in `apps/operator/src/atproto/space-ops.ts`
and every registration through `apps/operator/src/operator/registrations.ts`, so R10 adds calls there and nowhere else.

If you decline D6, R10a is built on `5d88b414` instead: one `putMember` per member, `registerNotify` per space, `name` on the
declaration, and R10a's gate must show the 20-inbox operations within the run limit (see R10a) before R10b starts.

## Goal

An app does what a Slack app does with people, over the protocol and with no server of this product between them:

- a person runs one of its **commands** (`/echo hello`) in a channel, and only the app sees the command;
- the app answers with **blocks** (sections, context, dividers, buttons), and a person's click reaches only the app;
- a first-party **webhooks app** posts what an outside service sends into a channel.

Non-goals for R10, each its own later plan: ephemeral answers (visible to one person only); modals and forms; link buttons,
images and select menus in blocks; outgoing webhooks; app home tabs; apps in DMs.

## What exists and what R10 builds on

- An app is an account with an install record in the workspace space (R9a). `apps/operator/src/operator/membership.ts` is the
  one owner of every member list: an install puts the app in the workspace space (read) and in its granted channels (its bits).
- The workspace **inbox** is the model for "people write, someone else reads": every roster person writes join requests (`write`,
  no `read`), admins also read (`expectedInboxList`). Verified on the pin (`protocol-tests/atproto/slack-inbox-conformance.test.ts`):
  a member with write and no read writes into their own repo and is listed as a writer, and is refused a read credential; a
  non-authority member with read and no write reads (`protocol-tests/apps.test.ts`). The authority is never in `listMembers` and
  always reads its own spaces (`docs/protocol/atproto-spaces-pin.md`).
- `runApp` follows an app's spaces through the change feed and gives it each new channel message from a person once, by a window
  over writer keys (R9b). Member-written records carry keys the member chose; the same window applies to them.
- Member-only writes into a space the member cannot read already exist: `ChannelClient.requestJoin` writes a join request with
  `com.atproto.space.createRecord` and neither mints a credential nor applies the write to the local store.

## Design

### The app inbox (one per install)

A new space type `new.flock.app.inbox`, owned by the workspace authority, one per install.

- **Key** (`packages/protocol/src/keys.ts`, beside `inboxUri`): `appInboxUri(authorityDid, workspaceSkey, appDid)` =
  `spaceUri(authorityDid, SPACE_TYPE.appInbox, "i-" + recordKeyHash(joinParts(workspaceSkey, appDid)))`, the same digest and
  joining `subjectKey` and `requestRecordKey` use: fixed length (105 characters, under `isSkey`'s 128 for any workspace key),
  colon-separated so no run of letters can trip the host's record-key filter, and distinct for every (workspace, app) pair.
  Every client, app and the operator derive it the same way; a test pins the formula with fixed vectors.
- **Members** (`membership.ts`, `expectedAppInboxList(roster, install)`): while the install is active, every person on the
  roster with `write` and no `read`, and the app with `read` and no `write`; when it is not active, nobody. The workspace
  authority is never written to the list and is left out of every convergence check (`listMatches(…, authorityDid)`), as for
  channels.
- **Who reads it.** The app. The host refuses every other member, admins included. The authority account reads its own spaces
  on the host whatever the list says: in a workspace whose authority is a person (self-owned, pre-R8), that person's account
  could read the inbox at the host. The web app never does: the member grant asks no read on this space type, so a browser
  session cannot read it, and the operator's grant reads it only to register notices and never reads its records. The security
  copy and the docs say so.
- **Collections:** `new.flock.app.command` and `new.flock.app.action`, both member-authored, keyed by TID, written with
  `createRecord`.
- **Lifecycle.**
  - `installApp` creates the inbox **first**, before its install record (step `app-inbox-space`), then writes the record, then
    the inbox list (`app-inbox-set`), then the workspace and channel entries as today. An authority grant without the new space
    type fails the first step with nothing written, so the row is discarded and the authority is asked to approve again (R9a's
    path). A run stopped after the first step leaves an empty space that the retry reuses.
  - `uninstallApp` writes the record inactive, then removes the **app** from its inbox before anything else
    (`app-inbox-remove`, the app's entry first, then the writers), then the workspace and channel entries as today. A stopped
    run leaves an app that can no longer read its inbox.
  - There is no archive call for a space on the pin. An uninstalled app's inbox stays, with an empty list and no notice
    registration; a reinstall derives the same key and reuses it.
  - `inviteMember` adds the person to every active inbox after the workspace inbox (`member-app-inbox-{app}`).
    `removeMember` and `leaveWorkspace` remove them from every inbox **before** the roster record changes
    (`remove-app-inbox-{app}`, beside `remove-inbox-membership`), so the host stops listing their writes first.
  - `reconcileWorkspace` reads **every** valid install record: for an active one it creates a missing inbox and moves its list
    to the expected one; for an inactive one it empties the list. So an install made before R10 gets its inbox from the next
    reconcile, and an interrupted uninstall is finished by it.
  - The kind table (`kinds.test.ts`, `PERSISTED_KINDS`) gains these steps on `installApp`, `uninstallApp`, `inviteMember`,
    `removeMember`, `leaveWorkspace` and `reconcileWorkspace`. No step is renamed or removed, so a pending pre-R10 row replays:
    its recorded steps are still declared, and the new ones run. The table update is deliberate and reviewed with R10a.
- **Notices and the feed.** The operator registers each active inbox's notices like a channel's (`createsSpaces` on
  `installApp`, `archivesSpaces` on `uninstallApp`), and the sweep keeps them: `activeWorkspaceSpaces` in `registrations.ts`
  adds the inbox of every active install, so a lost registration is restored and an inactive inbox's is dropped. `getChanges`
  admits a follower of an inbox when its member list does (`FOLLOWED_BY_MEMBER_LIST` in `member-access.ts` gains the type).
- **Envelope:** at most 20 inboxes per workspace (one per install, D13), each at most the roster (200). With batches of 100, an
  install writes its list in two calls, an invite or removal one call per active inbox (at most 20), and a reconcile of 20
  drifted inboxes at most 40.

### Commands

- **Declared** in the app's declaration: `commands: [{ name, description, usage }]`, at most 25, names unique, each a token
  `[a-z0-9-]{1,32}`. The declaration stays a label, never a grant. `publishAppDeclaration` compares the commands too, so a
  changed command list is published.
- **Run** by writing `new.flock.app.command` in the app's inbox: `{ command, text, channel, parent?, createdAt }`. `text` may be
  empty (a command without arguments) and is bounded like a message's. `channel` is a channel space URI of the same authority;
  `parent`, if given, a message in that channel. Nothing is written into the channel.
- **Offered** in a channel's composer only for an app granted that channel. A message that starts with `/` is a command: one
  naming a single offered command goes to that app; a name two offered apps declare needs the picker; a name no offered app
  declares is not sent, and the composer says so. Text that starts with `/` is sent as a message by starting it with `//` (one
  `/` is kept).
- **Answered** in the channel, as the app's message, where it may write. An app that may only read the channel cannot answer
  there; the person sees "sent to <app>" (no ephemeral answers in R10, D3).
- **Checked by the app's SDK** before the app's handler runs, against state read fresh for that poll (below): the command is one
  the app declares; its author is on the workspace's roster; `channel` is a channel of **the workspace this inbox belongs to**,
  granted to the app; for a private channel, the author is on its roster (read fresh, `ChannelClient.roster`). Anything else is
  dropped and reported through `onError`.

### Blocks

- An optional `blocks` field on `new.flock.channel.message`, at most 20 blocks, beside `text`, which stays required and is the
  fallback for every client that does not render blocks and for notifications. A union of:
  - `#section` `{ text }`: up to 3,000 graphemes (12,000 bytes);
  - `#context` `{ elements }`: 1 to 10 texts of up to 300 graphemes (1,200 bytes);
  - `#divider`;
  - `#actions` `{ elements }`: 1 to 5 `#button` `{ actionId, label, value?, style? }`: `actionId` a token `[a-zA-Z0-9_-]{1,64}`
    unique across every button in the message, `label` up to 75 graphemes (300 bytes), `value` up to 2,000 bytes, `style`
    `primary` or `danger`.
  The whole message stays within the 64 KiB record limit (`MAX_RECORD_BYTES`).
- **Rendered only for an app's message**: a message whose author is an active install of the workspace (the APP marker's test).
  A person's message shows its `text` only, whatever `blocks` it carries, so no person can show a button that seems to be an
  app's. Everything is rendered as plain text: no markup, no links, no HTML.
- **A click** writes `new.flock.app.action` in the authoring app's inbox: `{ message, actionId, channel, createdAt }`, where
  `message` is the clicked message's URI in `channel`. **The record carries no value**: the SDK gives the app the button's
  `value` as its own message holds it. The button is disabled while its action is being written, so one click is one action;
  each click is its own record (TID key), so a button an app means to be pressed again (`Again`) works, and an app that wants a
  button pressed once enforces it, usually by editing its message.
- **Checked by the app's SDK**: the message is the app's own and is in `channel`, `channel` is in the inbox's workspace, the
  author can read it (roster, or the private roster), and the message, read fresh and verified, still has a button with that
  `actionId`.

### The app's SDK (`packages/client`)

- **Inbox records.** `runApp` follows each active install's inbox beside the workspace space and the granted channels, reads
  both collections through the engine's sync core (`SyncCore`), and gives each new command (`onCommand`) and action (`onAction`)
  once, by the key window. When an install becomes inactive its inbox is unfollowed with its channels (`readGrants`, `forget`).
- **Fresh state for checks.** When a poll brings inbox records, the SDK reads the workspace summary afresh once for that poll,
  and a private channel's roster afresh when a record names it, so a removed person or a stale cache never passes a check. The
  operator's removal order (inboxes before the roster) means the host stops listing a removed person's writes before the roster
  changes.
- **Throttle.** Each author gets at most 20 inbox records a minute per inbox by default (`AppRuntimeInput.maxRecordsPerAuthor`);
  more are dropped and reported once per minute per author.
- **The window over writer keys moves into its own module** (`packages/client/src/key-window.ts`), used by channel messages and
  inbox records alike; R9b's tests move with it unchanged. A second copy would be the drift the code map warns against.
- **`AppRuntimeInput`**: `onMessage`, `onCommand` and `onAction` are each optional; a runtime with no `onMessage` follows no
  channel for messages (it still follows the workspace for its grants).
- **Client additions** an app needs from `@flock/client` alone (its boundary test holds): `ChannelClient.send` and `edit` take
  `blocks` (an edit can replace or clear them, not only the text); a public `ChannelClient.getMessage(ref, uri)` reads one
  message by `getRecord` with a verified MAC, so a click on any message, however old, is checked; and an `AppInboxClient` in
  the engine writes and retracts a member's command or action as `requestJoin` writes a join request (no credential, no local
  store), and syncs an inbox for an app.
- `publishAppDeclaration` takes the commands. The echo bot gains `/echo <text>` (answered in the channel) and an `Again` button.

### The people's client (`apps/web`)

- **Composer:** the command rules above; a sent command shows in the composer's status line only.
- **Message view:** blocks of an app's message rendered as above; a button disabled while its action is written.
- **Scopes** (`packages/protocol/src/scopes.ts` and `permissions/*.json`, built from the registry):
  - members: `space:new.flock.app.inbox?authority=*&collection=new.flock.app.command&collection=new.flock.app.action&action=create&action=delete`,
    with no read and no update;
  - apps: `space:new.flock.app.inbox?authority=*&action=read`;
  - the workspace authority: `space:new.flock.app.inbox?authority=self&skey=*&action=read_self&action=read&manage=create&manage=update`,
    and no collection token (it writes no record there); `workspaceAuthorityScopes` builds that shape for a type whose
    authority collections are empty.
- **Scope drift** (a session from before R10 lacks the new member scope). `missingScopes` in `apps/web/src/browser/session.ts`
  skips every `space:` token today, because the host rewrites `authority` and expands reads. It learns them: each requested
  `space:` token is reduced to its space type and its (collection, action) pairs, and is covered when the granted tokens of
  that type cover every pair, whatever their `authority`. Its tests refuse over-acceptance: a missing pair, a read taken for a
  write, another space type. A session without the inbox scope is then sent through consent once. For a Node app, a
  `ScopeMissingError` from its own host counts as a lost session (`isSessionLost`), so the echo bot stops and says to sign in
  again.

### The webhooks app (`apps/webhooks`)

A first-party app on `@flock/client` alone, like the echo bot, deployable on its own: **incoming webhooks only**, managed only on
its own admin page. It runs no commands and follows no inbox; it posts messages in the channels it may write.

- **Its admin page**, served by the app:
  - **Sign-in** with atproto OAuth through a second, identity-only client (`atproto` scope), from a new helper in
    `packages/client/src/node/` with its own paths (`/admin/oauth/client-metadata.json`, `/admin/oauth/callback`), so it never
    collides with the app's own client. Its sign-in state is bound to the browser by a cookie, expires after ten minutes, and is
    capped (a hundred pending sign-ins; more are refused). After the callback the app checks that the DID is an active admin of
    a workspace the app is installed in (it reads the workspace space it already reads), revokes the OAuth session at once (only
    the identity was needed), and sets its own session cookie: signed, `HttpOnly`, `SameSite=Strict`, `Secure` off loopback,
    thirty minutes.
  - **What it does**: lists the hooks of the channels the app may write in that admin's workspaces, and creates, rotates and
    revokes them, each by a `POST` carrying a CSRF token and checked for its `Origin`. For a private channel the admin must
    also be on its roster. A new or rotated hook's URL is shown once, in the `POST`'s answer; only `sha256` of its secret is
    stored, in the app's own hooks file (owner-only, beside, not inside, its OAuth state file).
  - **Headers**: `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, and `Content-Security-Policy: default-src 'none';
    style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'` (the page runs no script).
- **A hook** is `POST /hooks/<id>/<secret>`:
  - only `application/json`, at most 64 KiB read from the stream before parsing;
  - the secret is compared in constant time **before** anything else answers, and an unknown hook, a wrong secret and a revoked
    hook all get the same `404`; failed attempts are rate-limited per address and in total;
  - a valid hook is rate-limited per hook (`429` only once the secret matched);
  - the body is `{ text, blocks? }` and nothing else; the message is built from it (`$type`, `text`, `blocks`, `createdAt`),
    validated by the registry, and posted as the app's in the hook's channel. A channel the app can no longer write refuses the
    hook (`404`), and its hooks are listed as such on the page.

## Decisions I will take unless you object

| ID | Decision | Alternative |
|---|---|---|
| D1 | One inbox per install, its list kept by the operator from the roster (the join-request pattern): the host itself keeps out writes by anyone off the roster. | One open-write inbox (`publicWrite`) per install: no list to keep and no fan-out on roster changes, but anyone can write into it, and the app must drop what is not from the roster, as the DM inbox does. |
| D2 | Blocks are rendered only for an active install's messages; a person's message shows its text. | Render any author's blocks: richer messages from people, and buttons anyone can fake. |
| D3 | No ephemeral answers in R10: an app answers in the channel or not at all. | A per-person response space: private answers, at one more space per person per app (up to 4,000 at the envelope). |
| D4 | Webhooks are managed only on the webhooks app's own page, by an admin who signs in there; URLs are shown once. | Chat commands as well: more surface, and a secret cannot be shown in a channel. |
| D5 | A command is offered only in channels its app is granted. | Workspace-wide commands: the app could be asked where it can neither read nor answer. |
| D6 | **R10 runs after the pin moves to `d4def6e`** (batch membership, the new notice registration, `title`). | Build R10 on `5d88b414` now (one call per member, `registerNotify`, `name`), and redo those in the migration. |
| D7 | Commands and actions are retracted by deleting the record; an app gives each once and does not react to a deletion. | Treat a deletion as cancel: an app would have to undo work. |
| D8 | No data migration: installs made before R10 get their inbox from the next reconcile, and the kind table gains steps without renaming any (as the platform plan's D6 accepted for earlier phases). | Version the changed kinds. |

## Steps

### R10a: the protocol and the operator

- Lexicons: the space type (with `title`), `app.command`, `app.action`, `blocks` on `channel.message`, `commands` on
  `app.declaration`; codegen; `appInboxUri` with fixed test vectors.
- Registry semantics (synchronous, no I/O, as `validateSpaceRecord` is): a command's and an action's key is a TID; `channel` is a
  channel space URI of the record's authority; `parent` and `message` are records of the right collection in that channel;
  button `actionId`s are unique across a message; declaration command names are unique. Whether a command is declared is the
  SDK's check, not the registry's.
- `membership.ts`: `expectedAppInboxList`. The operator steps and orders above in `installApp`, `uninstallApp`, `inviteMember`,
  `removeMember`, `leaveWorkspace`, `reconcileWorkspace`; the kind table; `member-access.ts` and `registrations.ts`.
- Scopes and permission sets for members, apps and the authority, and `workspaceAuthorityScopes` for a type without authority
  collections.
- **Tests:** unit for the lexicons, the semantics and the key; the membership table with inboxes, active and inactive; every
  changed kind resumed after a stop at every step with no write repeated; a pending pre-R10 row replayed; the self-owned
  authority left out of every inbox list; install with a grant that lacks the new type discarded with nothing written; the
  sweep keeping an active inbox's registration and dropping an inactive one's; `getChanges` admitting the app to its inbox; the
  authority scope shape.
- **Gate (acceptance, real PDS network):** after an install, a member's command record in the inbox is read by the app, and a
  second member and a non-authority admin are refused it; a person removed from the workspace is no longer listed as a writer
  there; after an uninstall the inbox list is empty, its registration gone, and the app refused by `getChanges` and the host; a
  reconcile gives a pre-R10 install its inbox. **The envelope:** with 20 installs at a 200-person roster, `inviteMember`,
  `removeMember` and `reconcileWorkspace` (of 20 drifted inboxes) each finish within the run limit.

### R10b: the SDK and the client

- `key-window.ts` (moved), the inbox following, `onCommand`/`onAction` with their checks, fresh state and throttle; optional
  handlers; `ChannelClient` `blocks`, `getMessage`; `AppInboxClient`; `publishAppDeclaration` with commands; `isSessionLost`
  on a missing scope; the echo bot's `/echo` and `Again`.
- The composer's commands, blocks rendering, clicks; `missingScopes` for `space:` tokens.
- **Tests:** unit for each check (an undeclared command, an author off the roster, a removed author still in a stale summary, a
  private channel's outsider, a channel of another workspace of the same authority, a click on someone else's message, on a
  button that is gone, on a message older than any page, an action naming a value it does not have, the throttle); blocks
  rendering (an app's rendered, a person's as text); the composer's command rules; `missingScopes` coverage and its
  over-acceptance cases; the key window's existing tests in their new home.
- **Gate (BDD, real UI):** a member types `/echo hello` in #general and sees the echo bot's answer, and no command message
  appears in the channel for anyone; the member clicks the answer's `Again` and the bot posts again; a second member sees the
  answer but not the command; a person's message with blocks shows its text only; a session from before R10 is sent through
  consent and then runs a command.

### R10c: the webhooks app

- `apps/webhooks`, the identity-only OAuth helper, the admin page, the hooks file, the hook endpoint.
- **Tests:** unit for the secret (shown once, hashed at rest, compared in constant time), the sign-in state (browser-bound,
  expiring, capped), the session cookie, CSRF and `Origin` checks, the headers, the admin and private-roster checks, the body
  bounds and validation, the identical answers for unknown, wrong and revoked, and the rate limits' order.
- **Gate (acceptance):** an admin signs in on the page, creates a hook for #general and sees its URL once; a member who is not an
  admin is refused the page; a `POST` to the URL appears in #general as the app's message; a wrong secret and a revoked hook
  get the same answer; after the app loses write in #general the hook is refused.

Each step: typecheck, lint, unit, acceptance, browser and the full BDD suite, one at a time, then an independent review of the
step's diff before its PR is marked ready.

## Risks

- **Membership fan-out.** Inboxes multiply member-list writes (D1). R10a's envelope gate measures it; if it does not fit, D1's
  alternative is the fallback.
- **The authority reads its own spaces.** In a self-owned workspace the founder's account can read app inboxes at the host (see
  "Who reads it"); R8's dedicated accounts avoid it for new workspaces.
- **Author-chosen keys** apply to commands and actions as to messages: one keyed in the past is never given, one keyed ahead is
  given when its time comes (the shared window).
- **App load.** The SDK's per-author throttle bounds it; a host accepts writes as fast as a member makes them.
- **A webhook URL is a credential.** Whoever holds it posts as the app in that channel. Shown once, hashed at rest, revocable,
  rate-limited.
- **Protocol churn.** D6; and upstream may standardize interactions differently (none is proposed today).

## Not verified

- On the pin R10 runs on: a space whose only reader is a non-authority member with read and no write, beside writers with write
  and no read. Each half is verified today in a separate space; R10a's first acceptance test puts them in one.
- The envelope's cost, until R10a's gate measures it.
