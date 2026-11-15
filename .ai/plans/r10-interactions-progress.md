# R10 progress: interactions, blocks, webhooks

Plan: `.ai/plans/platform-refactor.md`, "### R10" and "### Apps" in the target design. This file is R10's own plan, which that
section asks for before any code. **Status: proposed, owner approval pending. Nothing implemented.** Three steps, each gated,
committed and reviewed as its own PR in the stack (`main` ← `feat/platform-refactor` ← `fix/script-policy-and-cors` ←
`feat/r10-interactions`).

Baseline: `fix/script-policy-and-cors` at `b150690` (R0 to R9c, the three plan amendments, the nonce script policy). Spaces pin `5d88b414`.

## Goal

An app does what a Slack app does with people, over the protocol and with no server of this product between them:

- a person runs one of its **commands** (`/echo hello`) in a channel, and only the app sees the command;
- the app answers with **blocks** (sections, context, dividers, buttons), and a person's click reaches only the app;
- a first-party **webhooks app** posts what an outside service sends into a channel.

Non-goals for R10, each its own later plan: ephemeral answers (visible to one person only); modals and forms; link buttons and
images in blocks; select menus; outgoing webhooks on every message; app home tabs; per-person app settings; apps in DMs.

## What exists and what R10 builds on

- An app is an account with an install record in the workspace space (R9a); `membership.ts` is the one owner of every member
  list, and an install puts the app in the workspace space (read) and its granted channels (its bits).
- The workspace **inbox** is the model for "people write, someone else reads": every roster person writes join requests
  (`write`, no `read`), admins also read (`expectedInboxList`). The pinned host lists a member without the write bit as no
  writer, so a record by someone off the list is synced by nobody.
- `runApp` follows an app's spaces through the change feed and gives it each new channel message from a person once, by a
  window over writer keys (R9b). Records a member writes carry keys the member chose; the same window applies to them.
- The browser engine writes a member's records through its session; the composer sends channel messages.

## Design

### The app inbox (one per install)

A new space type `new.flock.app.inbox`, owned by the workspace authority, one per install: key `<workspace skey>-<app key>`,
where the app key is a short, stable digest of the app's DID (`keys.ts`, beside `inboxUri` and `channelUri`).

- **Members** (`membership.ts`, `expectedAppInboxList`): every person on the roster with `write` and no `read`; the app with
  `read` and no `write`. Nobody else. So a person's command and click are visible to the app and to that person's own repo,
  and to no other person, not even an admin. An archived or uninstalled install has an empty list.
- **Collections:** `new.flock.app.command` and `new.flock.app.action`, both member-authored, keyed by TID.
- **Lifecycle:** `installApp` creates the inbox space and its list after the install record and before the channel entries
  (new steps, so a stopped install resumes); `uninstallApp` empties the list and archives the space; `updateAppAccess` does not
  touch it. `inviteMember`, `removeMember`, `leaveWorkspace` and `reconcileWorkspace` move each active inbox with the roster,
  from `membership.ts`, as they move the workspace inbox today. `createsSpaces`/`archivesSpaces` name it, so the operator
  registers its notices and the app hears of each command through `getChanges`.
- **Envelope:** at most 20 inboxes per workspace (one per install, D13), each at most the roster (200): 4,000 entries at the
  envelope, against today's 220 per list. An invite or removal now writes one entry in each active inbox (at most 20 more
  writes per operation, under the run limit); an install writes up to 200. See D1 and D6.

### Commands

- **Declared** in the app's declaration: `commands: [{ name, description, usage }]`, at most 25, `name` a lowercase token
  (`[a-z0-9-]{1,32}`). The declaration stays a label, never a grant (read at install and when shown, validated, never trusted).
- **Run** by writing `new.flock.app.command` in the app's inbox, in the person's own repo: `{ command, text, channel, parent?,
  createdAt }`, where `channel` is the channel's URI and `parent` a thread root in it. Nothing is written into the channel.
- **Offered** in a channel's composer only for an app granted that channel: `/` lists the commands of those apps, by app name
  where two apps declare the same name. A command in a channel the app cannot read is not offered.
- **Answered** in the channel, as the app's message (with blocks if it likes), where it may write. An app that may only read
  the channel cannot answer there; the person sees "sent to <app>" and nothing more (no ephemeral answers in R10, D3).
- **Checked by the app** (the SDK does it before the app's handler runs): the command is one it declares; its author is on the
  workspace roster; the channel is one the app is granted; for a private channel, the author is on its roster. Anything else is
  dropped and reported.

### Blocks

- An optional `blocks` field on `new.flock.channel.message`, at most 20 blocks, beside `text`, which stays required and is the
  fallback for every client that does not render blocks and for notifications. A union of:
  - `#section` `{ text }` (plain text, up to 3,000 graphemes);
  - `#context` `{ elements: [text] }` (up to 10 short texts);
  - `#divider`;
  - `#actions` `{ elements: [#button] }` (up to 5), with `#button` `{ actionId, label, value?, style? }` (`primary` or
    `danger`), `actionId` unique in the message.
- **Rendered only for an app's message**: a message whose author is an active install of the workspace (the same test as the
  APP marker). A person's message shows its `text` only, whatever `blocks` it carries, so no person can show a button that
  seems to be an app's. Everything is rendered as text: no markup, no links, no HTML, nothing the script policy would have to
  stop.
- **A click** writes `new.flock.app.action` in the authoring app's inbox: `{ message, actionId, value?, channel, createdAt }`,
  `message` being the clicked message's URI. The button shows it was sent; what changes is the app's to say, usually by editing
  its message (an edit is a new version of the same record).
- **Checked by the app**: the message is its own, still carries a button with that `actionId`, and is in a channel the author
  can read (the roster, or the private roster). Clicks are deduplicated by the author's key, so a double click is one action.

### The app's SDK

- `runApp` gains `onCommand` and `onAction`. It follows each install's inbox beside the workspace space and the granted
  channels, and gives each new command and action once, checked as above.
- **The window over writer keys moves into its own module** (`packages/client/src/key-window.ts`), used by channel messages and
  by inbox records alike; R9b's tests move with it and keep passing unchanged. A second copy of that logic would be the drift
  the code map warns against.
- `publishAppDeclaration` takes the commands.
- The echo bot gains `/echo <text>` (answered in the channel) and an example button (`Again`, which posts the text once more),
  so the gate runs through a real app.

### The people's client

- **Composer:** `/` opens the command list for the channel; choosing one and sending writes the command record through the
  engine, never a channel message. A person sees their own sent command in the composer's status line, not in the channel.
- **Message view:** blocks of an app's message rendered as above; a button disabled while its action is being written.
- **Scopes:** the member grant gains create (and delete, for retracting) of the two collections in `new.flock.app.inbox` spaces
  of any authority; an existing session without it is sent through consent once (the existing scope-drift path). The app grant
  gains read of `new.flock.app.inbox`. The authority grant gains the new space type and its member management, through the
  existing reauthorization path (R9a's).

### The webhooks app (`apps/webhooks`)

A first-party app on `@flock/client` alone, like the echo bot, deployable on its own: **incoming webhooks only**.

- `/webhook new` in a channel it may write creates a webhook for that channel. The URL holds a secret, so it is never posted
  into the channel: the app answers "created; an admin can copy its URL at <page>".
- **Its page** is served by the app: an admin signs in with atproto OAuth (a second, identity-only client: `atproto` scope),
  the app checks that the DID is an active admin of the workspace by reading the workspace space it already reads, and shows
  the URL once, with revoke and rotate. Secrets are stored hashed in the app's own state file (owner-only, as the echo bot's).
- **A POST** to the URL with a JSON `{ text, blocks? }` (bounded, validated against the message lexicon) becomes the app's
  message in that channel. Wrong secret, unknown or revoked hook, or a channel the app can no longer write: refused, with no
  hint which.
- Outgoing webhooks are out of R10 (they reach outside hosts on every message; `@flock/net` makes that safe, but it is its own
  product question).

## Decisions I will take unless you object

| ID | Decision | Alternative |
|---|---|---|
| D1 | One inbox per install, its list kept by the operator from the roster (the join-request pattern): the host itself keeps out writes by anyone off the roster. | One open-write inbox (`publicWrite`) per install: no list to keep and no fan-out on roster changes, but anyone can write into it, and the app must drop what is not from the roster, as the DM inbox does today. |
| D2 | Blocks are rendered only for an active install's messages; a person's message shows its text. | Render any author's blocks: richer messages from people, and buttons anyone can fake. |
| D3 | No ephemeral answers in R10: an app answers in the channel or not at all. | A per-person response space: private answers, at one more space per person per app (up to 4,000 at the envelope). |
| D4 | Webhook URLs are shown on the webhooks app's own page to an admin who signs in there. | Post them in the channel (anyone there could post as the app), or send them by DM (apps have no DM scope, by R9b's design). |
| D5 | A command is offered only in channels its app is granted. | Workspace-wide commands: the app could be asked where it can neither read nor answer. |
| D6 | **R10 runs after the pin moves to `d4def6e`** (`.ai/plans/protocol-drift-d4def6e.md`): batch membership (`putMembers`, 100 per call) turns an install's 200 member writes into two, notices for the new space type are registered the new way once instead of twice, and the new space declaration is written with `title` from the start. | Build R10 on `5d88b414` now and redo its membership writes, notice registration and declaration in the migration. |
| D7 | Commands and actions are retracted by deleting the record; an app gives a command or action once and does not react to its deletion. | Treat a deletion as cancel: an app would have to undo work. |

## Steps

### R10a: the protocol and the operator

- Lexicons: `new.flock.app.inbox` (space), `app.command`, `app.action`, `blocks` on `channel.message`, `commands` on
  `app.declaration`; the registry entries and semantics (command name declared; `actionId` unique in a message; blocks bounded);
  codegen; key derivation for the inbox.
- `membership.ts`: `expectedAppInboxList`; every roster-moving operation and reconcile move each active inbox.
- Operator kinds: the inbox steps in `installApp`/`uninstallApp`, its notices registered and dropped; the authority scope.
- Member, app and authority scopes; the permission sets.
- **Tests:** unit for the lexicons and semantics; the membership table with inboxes (every row); install, uninstall, invite,
  remove and reconcile resumed after a stop at every step, no write repeated; the 20th install at a 200-person roster within
  the run limit.
- **Gate (acceptance, real PDS network):** after an install, a member's command record in the inbox is read by the app and by
  nobody else (another member and an admin are refused); a person removed from the workspace can no longer write there (the
  host lists them as no writer); after an uninstall the inbox is archived and its list empty.

### R10b: the SDK and the client

- `key-window.ts` (moved, not copied), `onCommand`/`onAction` with their checks, `publishAppDeclaration` with commands, the
  echo bot's `/echo` and button.
- The composer's command list and command write; blocks rendering; button clicks; consent for the new member scope.
- **Tests:** unit for each check (an undeclared command, an author off the roster, a private channel's outsider, a click on
  someone else's message or a button that is gone, a double click); blocks rendering (an app's rendered, a person's as text);
  the key window's existing tests in their new home.
- **Gate (BDD, real UI):** a member types `/echo hello` in #general and sees the echo bot's answer, and no command message
  appears in the channel for anyone; the member clicks the answer's `Again` button and the bot posts again; a second member
  sees the answer but not the command; a person's message with blocks shows its text only.

### R10c: the webhooks app

- `apps/webhooks`: `/webhook new|list|revoke`, the admin page with its identity-only sign-in, hashed secrets, the POST
  endpoint (bounded body, validated, rate-limited per hook).
- **Tests:** unit for the secret handling (hashed at rest, compared in constant time, shown once), the body bounds and
  validation, the admin check.
- **Gate (acceptance):** an admin creates a hook with `/webhook new`, copies its URL from the page after signing in (a member
  who is not an admin is refused the page), and a POST to it appears in the channel as the app's message; after `revoke` the
  same POST is refused.

Each step: typecheck, lint, unit, acceptance, browser and the full BDD suite, one at a time, then an independent review of
the step's diff before its PR is marked ready.

## Risks

- **Membership fan-out.** Inboxes multiply member-list writes (D1, D6). Measured at R10a's gate against the run limit; if it
  does not fit, D1's alternative is the fallback.
- **Author-chosen keys** apply to commands and actions as to messages: a command keyed in the past is never given, one keyed
  ahead is given when its time comes (R9b's window, now shared).
- **App load.** A member can write commands as fast as their host accepts them. The SDK gives each once; throttling a noisy
  author is the app's choice, with a default limit in the SDK.
- **A webhook secret is a credential.** Whoever holds the URL posts as the app in that channel. Shown once, hashed at rest,
  revocable, rate-limited.
- **Protocol churn.** D6; and upstream may standardize interactions differently (none is proposed today).

## Not verified

- That the pinned host accepts a member with `write` and no `read` in a space whose only reader is another member (the inbox's
  readers today are admins on the same list). R10a's first test.
- The cost of 20 inboxes at a 200-person roster under the run limit, on the current pin and after the migration.
