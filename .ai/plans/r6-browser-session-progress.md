# R6 one member session in the browser: working notes and progress

Working file for phase R6 of `.ai/plans/platform-refactor.md` ("### R6", "### Identities and sessions", "### What the
member routes do today", "### What is deleted"). Owner sign-offs (2026-11-10): the data flow (engine snapshots and a
subscribe function per space, read through `useSyncExternalStore`; `workspace-manager.tsx` loses its fetch and refresh
state; logic only, no styling); the scenario changes "remove and rewrite"; the DM server-session scenario strengthened at
R6c. Three commits: R6a, R6b, R6c (R6c is one-way).

## Map (2026-11-10, from the code)

- Browser OAuth today is DM-only: `src/dm/browser-session.ts` (`BrowserOAuthClient`, `connectDms`, `restoreDmSession`,
  `disconnectDms`), `src/dm/client-metadata.ts`, `/oauth/dm-client-metadata.json`, `/dm/callback` (needs the server
  session's DID), `src/dm/use-dm-client.ts` (restores and builds `DmClient`), `DM_BROWSER_SCOPES`.
- Server member session: `src/auth/{session,web-session,oauth,encrypted-cache}.ts`, `/api/oauth/{login,logout,permission}`,
  `/oauth/callback`, tables `oauth_session`, `web_session`, `oauth_state` (member-only), caches.
- `src/app/ui/workspace-manager.tsx` (711 lines): every member read and write is an `/api` call (list in the R6 map
  report); refresh by 60 s intervals plus SSE; "Grant …" buttons call `/api/oauth/permission`.
- The engine has no snapshot/subscribe surface and no caller in `src/app`; `ChangeFollower` has no loop; the operator
  endpoint is not in the page config (until R7 it is the app origin).
- Rules in routes, not in the operator: `/api/operator/execute` and `/reconcile` check the workspace summary is not
  degraded (and admin for reconcile) before forwarding. Check the operator enforces them before deleting the routes.

## Design

- One browser grant: member set (`authority=*` lines of "Identities and sessions", inbox read included) plus the operator
  `rpc` scope plus the DM set, built by the scope builders (export `operatorMethodsScope`; a `memberGrantScopes(serviceRef)`
  builder; `combinedMemberScopes` in protocol-tests uses it; `member.json` permission set gains inbox read and rpc).
- Browser-only glue moves out of `src/dm` into `src/browser/` (session, identity, client metadata, engine bootstrap).
- React: an isomorphic `src/client/views.ts` holds snapshots per key (workspaces, a channel page, a roster, the inbox) with
  `get`/`subscribe`; a change-feed loop runs `ChangeFollower.poll` and refreshes the views of synced spaces; hooks in the
  app layer read views through `useSyncExternalStore`.
- R6a: reads (discovery, channel pages, roster, inbox requests, DM reads and the DM feed) come from the engine; writes and
  operator calls still go to the server routes, so a person signs in to the server and grants the browser session (two
  consents until R6c). "Grant channel read →" goes (reads need no per-channel consent).
- R6b: writes and operator calls go through the engine (browser → PDS, browser → operator with a service token).
- R6c: delete the server member session, the member routes and tables; sign-in is the browser flow; sign-out revokes the
  session, deletes the engine's IndexedDB database and the DM localStorage keys; `deleteOtherAccounts` at start.

## R6a concrete design (2026-11-10)

- a2 browser session: `src/dm/browser-session.ts` and `src/dm/browser-identity.ts` move to `src/browser/session.ts` and
  `src/browser/identity.ts` (the session is no longer DM-only): `BrowserSessionConfig` (was `DmConfig`; `scope` is now
  `memberGrantScopes(serviceRef)`), `connectSession`, `restoreSession`, `disconnectSession`, `sessionXrpcClient`,
  `AccountMismatchError`; `wellKnownHandleResolver` and `missingScopes` stay. The client metadata route and `/dm/callback`
  keep their paths until R6c (the server's OAuth routes free `/oauth/*` then). `src/browser/**` joins the isomorphic lint
  list (no `node:*`, no server layers). `src/dm/use-dm-client.ts` becomes `src/browser/use-browser-session.ts`: restores
  the session and builds `DmClient` and the engine (`createEngine` over `IndexedDbStore.open(did)`, operator
  `{ serviceRef, endpoint: appUrl }`), plus the live views. `dm-session-bridge.tsx` stays the only importer.
- a3 views: `src/client/views.ts` — `Snapshots` (per key: `{ value, error, loading }`, `get`, `subscribe`, `refresh(key,
  load)`), and `LiveSpaces` binding a key's loader to the spaces it reads, running `ChangeFollower.poll` in a loop with an
  `AbortController`, refreshing the bound keys when their space syncs. Keys: `workspaces`, `channel:<uri>`,
  `roster:<uri>`, `inbox:<workspace>`; DM keys for the inbox and the open conversation's halves. App hook
  `useSnapshot(snapshots, key)` through `useSyncExternalStore`.
- a4 UI: `workspace-manager.tsx` reads discovery, the channel page (cursor paging replaces offset/nextOffset/hasMore), the
  roster and the inbox requests from snapshots; SSE `/api/notifications` and `/api/notifications/dm` are replaced by the
  live loop; writes and operator calls stay on the server routes. The per-channel read grant goes; the private-channel
  "request access" path is decided by the engine's `ChannelUnavailableError`.
- a5 BDD: `signIn` also grants the browser session (the "connect" consent), per-channel read steps go, everything else
  keeps its wording; K9 repeated with the real `BrowserOAuthClient`.

## Steps

R6a
- [x] a1 member grant scope builder + permission set + tests
- [x] a2 browser session (member + DM), `src/browser/`, callback without the server DID dependency where possible
- [x] a3 engine bootstrap in the browser (IndexedDB store, operator endpoint = app origin) + views + feed loop + tests
- [x] a4 UI reads from the engine (discovery, channel page with cursor paging, roster, inbox), DM reads and DM feed
- [x] a5 BDD: sign-in grants the browser session; per-channel read steps rewritten; K9 with the real client
- [x] a6 gate, review, outcome, commit (R6a outcome in `.ai/plans/platform-refactor.md`)
R6b
- [ ] b1 writes and operator calls through the engine; remaining "Grant …" steps rewritten; review; gate; commit
R6c
- [ ] c1 delete routes/tables/session; sign-in/out in the browser; hardening tests; scenario rewrite; review; gate; commit

## Progress notes

- a1: `memberGrantScopes(serviceRef)` in `src/protocol/scopes.ts` (built from the registry's new `memberCollections`, the
  exported `operatorMethodsScope` and `DM_BROWSER_SCOPES`); `member.json` gains inbox read and the operator `rpc`; a test
  pins it to the builder; `combinedMemberScopes` in protocol-tests is the builder.
- a2: `src/browser/{session,identity,client-metadata,use-browser-session}.ts` (moved from `src/dm`, renamed:
  `BrowserSessionConfig`, `connectSession`, `restoreSession`, `disconnectSession`, `sessionXrpcClient`,
  `AccountMismatchError`, `buildBrowserClientMetadata`, `useBrowserSession`, `BrowserSessionState`); `src/browser` is under
  the isomorphic lint rule; the page and `/oauth/dm-client-metadata.json` request `memberGrantScopes`; client name "Spaces".
- a3: `src/client/views.ts` (`Snapshots`, `LiveSpaces`) with tests; `useBrowserSession` builds the engine over
  `IndexedDbStore.open(did)` (after `deleteOtherAccounts`), the operator at the app origin, `Snapshots` and a started
  `LiveSpaces`; the bridge passes `engine`, `snapshots`, `live` up through `DmProvider`'s session state.
- a4 (in progress): `src/app/ui/session-context.tsx` (`SessionProvider` renders the bridge; `useBrowserSessionContext`);
  `WorkspaceManager` wraps `WorkspaceShell` in it; `DmProvider` reads the session from it; the DM inbox SSE and the DM
  conversation SSEs are now `live.watch` (the DM client still registers its own DM spaces). The workspace shell reads
  discovery, the channel page (cursor paging: `nextCursor`), the private roster and the inbox requests from the engine; the
  workspace, channel and inbox SSEs are `followLive` watches (a 60 s rediscovery stays: a new invitation reaches no
  followed space; stalled operations stay a server call every minute); "Grant channel read" and `needChannelRead` are gone
  (a private channel the account is not on shows the roster card); `httpStatus` maps engine errors; the main stage shows
  "Connect this browser →" until the session is ready, and the start-up resume runs once when the engine exists;
  `src/app/browser-session-config.ts` is the one owner of the page's and the callback's session config.
- Sequencing decided: R6a moves the reads to the engine inside the existing imperative component; R6b, which rewrites the
  write and operator paths anyway, moves the component's state to snapshots read through `useSyncExternalStore`, so the
  approved end state ("loses its fetch and refresh state") is reached by the end of R6.
- Next (a5): BDD sign-in grants the browser session ("Connect this browser →" + consent); per-channel read steps go.

## a5 BDD migration plan

Reads no longer go through `/api`, so steps that waited on or inspected `/api/workspaces`, `/api/channels/messages`,
`/api/channels/roster`, `/api/inbox/requests` and `/api/notifications` keep their wording and assert the same fact where
it now lives:
- what a person sees (message cards, "Load older messages", the roster card, the inbox list);
- the browser's own requests to PDS hosts, recorded by a page listener (`trackXrpcRequests`: method and `space` of each
  `/xrpc/com.atproto.space.*` request), e.g. "every history request named the opened channel";
- the engine's IndexedDB store read with `page.evaluate` (`flock-sync-<did>`: spaces, writers, records), where a step read
  the server's `space_collection_cursor` or `channel_record_cache`.
Sign-in: `signInFromLoginForm` also clicks "Connect this browser →", consents, and waits past `/dm/callback`; the DM
connect helpers (`dmpConnectDms`, `dmcConnect`, the "Connect direct messages" clicks) find the session already connected
and only reconnect where a scenario disconnects. "Grant channel read →" clicks go (5 sites). Files: steps `channels`,
`independent-app`, `workspaces`, `dm-policy`, `private-requests`, `lifecycle`; support `private-requests-ui`,
`lifecycle-ui`, `independent-app-ui`, `channels-ui`, `ui`, `world`, `dm-policy-ui`, `dm-conversations-ui`.

## a5 progress

- Done: `bdd/support/world.ts` records the browser's own XRPC calls (PDS hosts, operator) into `actor.xrpc` (`getChanges`
  headers only), keeping `actor.calls` for the app server's /api so server leak scans stay meaningful; every actor copy
  gets its own `xrpc: []`. `ui.ts`: `waitForOrigin` (also past `/dm/callback`), `connectBrowser(actor, origin)` (clicks
  "Connect this browser →", consents, waits for the prompt to go); `signInFromLoginForm` and the second-site
  `signInFromLoginFormOn` (channels-ui) connect after sign-in; `waitForSite` uses `waitForOrigin`.
- Done (2026-11-10): `dm-policy-ui` (`dmpSignInAt` connects and reports the consent's scopes; `dmpConnectDms` waits for
  the connected session); `independent-app-ui` and `channels-ui` (`openChannel` waits for the channel view's `aria-busy`
  to clear and fails on a shown error; `openChannelReading`, `openChannelAs`, `grantChannelReadAs`, `channelSkeyOf`,
  `workspaceStateFor`, `cachedRows`, `trackApiRequests` are gone); new `bdd/support/browser-store.ts` (the account's
  IndexedDB store read in the page, or from an app-free page of the origin) and `bdd/support/engine.ts` (the engine run in
  node as one account, for read probes racing an operation); steps in `channels`, `independent-app`, `workspaces`,
  `lifecycle`, `private-requests`, `dm-policy` assert the same facts through the UI, the browser's own XRPC calls
  (credential requests, record listings, inbox sweeps = `listInboxWriters` calls) and the browser store.
- Found and fixed on the way: (1) the channel view had no settle signal once reads left `/api`: `ChannelView` marks the
  message list `aria-busy` while a read of the open channel is in flight (a counter in the shell; R6b's snapshots carry
  `loading`), and hides the off-roster card while reading; (2) leaving a private channel left the engine's cached space
  credential readable for up to ten minutes (the server had minted per read): `ChannelClient.left` mints afresh so the
  refusal drops the credential and the copy, called after a completed `leaveChannel`; (3) a4 had dropped the admin inbox's
  one-minute sweep, which the dropped-notification scenario needs: restored as `live.reload` every minute; (4) `LiveSpaces`
  never loaded a key when the operator was unreachable (`follow` threw before the load): a key now loads regardless and
  the run loop follows its spaces once the operator answers (spaces the feed lost are not re-followed until watched anew).
  (5) A space the operator denied while the account could still read it (an operator without the authority's grant, or
  a member-list answer up to a minute old) was re-minted, re-followed and reloaded every five seconds: `ChangeFollower`
  now defers it for `REFOLLOW_DELAY_MS` (60 s, the member-list window) and follows it again from a new head after that,
  pausing a poll that has nothing else to follow. (6) Opening a channel loaded it twice at once (the click's own load and
  the live watch's first load, which also ran a whole discovery): the channel's watch is now its only loader (content
  key bound to the channel space; a separate workspace watch keyed on the workspace refreshes the selection), the click
  marks the view busy until that load ends, and opening the open channel again asks its watch to load.
- K9 repeated with the real client: `protocol-tests/browser/real-client.spec.ts` (in `test:browser`), on shared helpers
  `protocol-tests/support/browser-app.ts` and `browser-network.ts` (the preflight watcher, moved out of `cross-origin.spec.ts`).
  K4 in a browser: `protocol-tests/browser/sync-budget.ts` (a measurement script like `protocol-tests/sync-budget.ts`; the
  dataset helpers moved to `protocol-tests/support/sync-dataset.ts`).
- Channel writes moved into R6a (was R6b): the first BDD run showed every post failing, because the server's message and
  reaction routes check membership with the server session's per-channel read scope, which only the removed "Grant
  channel read" step gave. The UI now sends, edits, deletes and reacts through `engine.channels` (the rules R4 moved
  there); the "Grant message posting" box is gone; the forged-write steps run the engine as that member around the page.
  `/api/channels/messages/write` and `/api/channels/reactions` have no caller left and go with R6c's deletions. R6b keeps
  operator calls, accepting, join requests and the move to snapshots.
- Review round 1 (Sonnet reviewer + critic, converged AGREE) and what changed:
  - `LiveSpaces.watch` returns an identity-checked stop (a later watch of the same key survives the earlier one's stop),
    releases the spaces a replaced or stopped watch alone read, follows all of a key's new spaces from one head with one
    load (`ChangeFollower.follow(spaces, load)`), and has a held poll asked again at once when it follows a new space.
    The run loop honors `retryDelayMs`. A poll ignores answers for spaces unfollowed while it was held. A refresh folded
    into a running one runs the latest loader.
  - The admin inbox watch reads its loaders through refs, so a discovery no longer re-watches it. `refreshSelectedChannel`
    only follows the selection (it bumps the channel epoch only for a transition), so a workspace tick no longer
    discards an in-flight channel read. Every content reload goes through the channel watch (`live.reload`). The busy flag
    is keyed by channel. A reload reads as many messages as the view shows (older pages a person loaded stay).
  - The invite link and the authority outcome are taken from the URL before the browser session is ready. One connect
    prompt (the DM sidebar no longer offers its own). "Disconnect this browser" says it revokes the one session.
    `useBrowserSession` stops and closes outside the state updater. An open store closes when another tab deletes it.
  - BDD: the two-app and spoof scenarios compare the roster and admins the page itself listed (and assert it listed them
    only from the authority's repo). The app-free page is the browser client's metadata, which outlives the server's
    client. One `connectBrowser`, which also reports the consent's scope.
  - Accepted, recorded: a second discovery at start-up (the resume's, then the workspace watch's first load) until R6b
    makes discovery one keyed view; LiveSpaces treats every follow or poll failure as "operator unreachable" and retries
    (no reporting path until R6b's snapshots carry errors); `Snapshots.get/subscribe/forget` wait for R6b's consumers.
- Review round 2 (fix delta): CHANGES_REQUIRED. The OAuth spec's connect wait passed while "connecting". Unfollows racing
  awaits in the follower, listener leaks, a closed store not reported to its tab, and a dev StrictMode URL capture were
  fixed, along with nits: pending follows count as following; the lost-wakeup guard; one constant for the browser
  client's metadata path; channel keys in the page-read comparison; a `retryDelayMs` test.
- Review round 3: APPROVE_WITH_FOLLOWUPS, all taken. The follower tracks each follow with a token and each space with a
  generation that every unfollow raises, so work begun before an unfollow never revives the space. There are regression
  tests for the guards after `sync`, the denial mint and the deferred re-follow, and the follower's retry delay has an
  upper bound. A store closed by another tab tears its engine down. `Snapshots.refresh` registers before it runs.
  `workspaceRead` reads recorded bodies only. The release test asserts the release.
- Gate after round 3: 39 BDD scenarios timed out waiting for "No pending join requests.", and the OAuth browser spec failed
  the same way. The browser's inbox read succeeded, but every discovery bumped `operatorDataEpoch`, which discards an inbox
  result in flight. Once the inbox watch stopped re-running on each discovery (round 1), nothing reloaded it, and the
  minute sweep raced the minute discovery. Inbox and operator results are now dropped only when discovery changes the
  account's admin standing (or fails), and the selection change still drops them. The BDD failure report now also
  attaches each actor's recent XRPC calls.
- A focused review of the epoch fix (CORRECT) found three more inbox gaps, fixed: a single in-flight flag across workspaces
  could make another workspace's first inbox load return as if done (the flag is gone: every inbox load goes through the
  inbox's live view, which runs one at a time per workspace, and "Sync inbox" asks it); an operation no longer reloaded
  the inbox and stalled operations (it now does); and choosing the selected workspace again wiped its inbox (it only
  returns to the home now).
- A last focused review (ISSUES) found a narrow race, fixed: the inbox loader took its workspace at call time and checked no
  admin standing, so a stale watch load after a quick switch, or a self-demotion, could show a false error. The inbox
  and stalled-operation loaders are now bound to their workspace (`loadInboxFor(uri)`, `loadStalledOperationsFor(uri)`)
  and check the latest discovery (a ref set with it) for selection and admin standing; the loader refs are gone. The
  inbox prompt for a refused read now offers to connect the browser again (the grant that reads it), not the server's
  admin grant. An inbox load no longer clears unrelated errors. The OAuth spec shows the admin grant is needed: an
  operation before it is refused.
- Kept for R6b (behavior still present in R6a): the "Declining the join permission" scenario (joining still opens the
  server's join grant until writes move to the engine), "Grant message posting →" and "Grant request access →" steps.
- Was to do: `dm-policy-ui` (`dmpSignInAt` connects and can report the consent's scopes; `dmpConnectDms` waits for the
  connected session; `dmpWaitForOrigin` → `waitForOrigin`; the "never holds DM scopes" step captures the scopes at sign-in);
  `independent-app-ui` (`waitForAppAt`, `signInFromLoginFormAt` connect); `channels-ui` `openChannel` (no history /api
  call: wait for the channel to settle) and `openChannelReading` (no grant); then each step listed in the plan above.
