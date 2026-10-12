# atproto Slack specification

## Product

Build a Slack-style team workspace on atproto permissioned data. Accounts own their messages and requests in their own PDS repos. PDS space membership is the read-access gate. Published records and lexicons define the shared view; application databases may hold OAuth state, sync cursors, caches, and operator operation journals, but never decide who can read.

## V1 scope

- Multiple workspaces, workspace invitations and acceptance markers. Being added to a workspace is invisible to the member (the protocol has no "spaces I was added to" lookup), so an admin sends an invite link (`/?invite=<workspace URI>`); opening it shows the member an invitation with a Join button (sign-in and the PDS's permission screen still apply). Creating the first workspace asks for the one-time workspace-authority permission in the same step.
- Public and private channels, text messages, one-level replies, reactions, and private-channel requests.
- Admin promotion/demotion, workspace and channel leave/removal, privacy transitions, archive, retries and restart recovery.
- Direct messages, 1:1 and group (2–100 participants), with no app-operated component able to read, gate, lose, or hold hostage a DM (see "Direct-message invariants" below).
- Independent app interoperability, for both channels and DMs. No uploads, presence, calls, search, internet-public channels, workspace transfer, DM end-to-end encryption, or guaranteed erasure of already copied data.

## Protocol invariants

- Workspace, channel, and inbox spaces use member-list read and write policies and open app access.
- Ordinary workspace members have inbox `read=false, write=true`; active admins and the workspace DID have both true.
- `listRepos` is a writer set, not membership. Inbox reconciliation unions it with the owner-authorized operator `listInboxWriters` candidate set; the admin client reads candidates itself using its inbox credential.
- Workspace and private-channel roster/admin/decision records count only when authored by the workspace DID. Message and reaction edits/deletes are limited to the author.
- Admin mutations go through an authenticated operator. Every call validates a PDS-issued service-auth JWT and derives the actor from its verified `iss`, then checks current workspace, inbox, and admin state.
- Mutations are serialized, journaled, idempotent by `(workspace DID, actor DID, operationId, canonical request hash)`, and remain pending until PDS state matches the desired state. One exception: a workspace setup that completed no steps because the account has not yet approved the required OAuth permission is discarded instead of left pending, since there is nothing to recover, so its operation ID can be reused.
- Removing membership blocks new credentials. Existing space credentials may work until their signed expiry, at most two hours by default.
- Stable mutable records use canonical deterministic record keys as defined in the PRD. Message text is plain text, at most 10,000 Unicode code points.

## Direct-message invariants

DMs belong to people, not workspaces, and every invariant below is enforced by PDS membership and record ownership, never by this app:

- **No shared authority.** Each participant owns the space holding *their own* messages: a personal inbox (`org.slack.dm.inbox`, fixed key `self`) for incoming requests, and one conversation half per conversation the participant has replied to (`org.slack.dm.conversation`, random-TID key). A conversation's participant set is immutable once the first half is created; adding someone starts a new conversation.
- **No server-held DM session.** DM permissions exist only in a browser-held OAuth session (`src/dm/browser-session.ts`, `@atproto/oauth-client-browser`) with DM-only scopes. The Next server session never requests, receives, or proxies DM scopes or DM content (`src/auth/permission-sets.test.ts` asserts no server-side scope builder ever contains `org.slack.dm`).
- **No server-side DM cache or database.** `src/dm/**` never imports `@/lib/db`, `@/auth/*`, `@/operator/*`, `@/workspaces/*`, or any Node-only module; an ESLint `no-restricted-imports` rule (`eslint.config.mjs`) enforces this, and `protocol-tests/dm-acceptance.test.ts` runs every DM flow with no Next server started and `DATABASE_PATH` pointed at a directory asserted to never be created. The only server involvement is a content-free SSE change stream (`src/app/api/notifications/dm/route.ts`) that emits a cursor and never reads DM records.
- **No app-decided access.** Reads are gated only by PDS member lists on each conversation half; `managingAppPolicy` is forbidden for DM spaces. The inbox request policy (Everyone / Only people I allow / Nobody) is stored as the inbox space's own `writePolicy` and member list on the owner's PDS, readable and editable by any app the user signs into.
- **No app-required discovery or delivery.** Requests are discovered by scanning the recipient's own inbox (`listRepos` plus direct record reads); a sender re-puts an undelivered request on a bounded backoff (1 min, 10 min, 1 h, 1 day) since a missing reply and a dropped notification look identical from the sender's side.
- **Independent-app parity.** `src/reader/independent-dm.ts` is a second, deliberately separate implementation that renders identical conversation state (message URIs, texts, reactions, per-half status) from the published `org.slack.dm.*` lexicons alone, sharing only the protocol layer (`src/protocol/*`, `src/atproto/xrpc.ts`, `record-pages.ts`, `space-credential-core.ts`) and never importing `src/dm/**`; `protocol-tests/dm-acceptance.test.ts` asserts this parity against the real pinned PDS.
- **Residual risk, stated not solved:** each participant's PDS host still sees their own messages in plaintext (no v1 end-to-end encryption), and a compromised app server could serve malicious browser JavaScript; the independent reader and the isomorphic protocol layer are the mitigation, not a fix. See `.ai/plans/direct-messages.md` §5 for the full list.

## Acceptance envelope

The launch envelope is 200 members, 100 channels, and 20,000 messages per channel, and 100 DM participants with 20,000 total DM messages per conversation. Channel open initially loads the latest 100 messages and pages older history; DM conversation open initially loads the latest 100 messages merged across halves. Writer-set recovery runs at least once per minute; operations stalled for five minutes alert an operator. Two independent apps must render the same canonical workspace state, and the same canonical DM conversation state, using only published lexicons, OAuth, and space credentials.

## Source documents

- Product details and acceptance criteria: `docs/prd/atproto-slack-clone.md`
- Execution order and phase gates: `docs/prd/atproto-slack-implementation-plan.md`
- Exact protocol pin and conformance evidence: `docs/protocol/atproto-spaces-pin.md`
- Operator wire contract: `docs/protocol/operator-contract.md`
- Direct-message design, milestones, and residual risks: `.ai/plans/direct-messages.md`
- BDD scenarios: `features/`
