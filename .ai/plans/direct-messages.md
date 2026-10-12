# Direct messages — implementation plan

Status: **implemented 2026-09-28 (M0–M6 complete; see §6 "M6 results" for the independence proof, verification evidence, and deviations, and `PROGRESS.md` for exact command results).**
Protocol baseline: proposal 0016 draft, pinned PDS `787a730f` (see `docs/protocol/atproto-spaces-pin.md`).

## 1. Goal and the constraint that drives everything

Add 1:1 and group DMs (up to 100 participants) such that **no app-operated component can read, gate, lose, or hold hostage a DM**. Concretely, every DM must remain readable, writable, discoverable, and revocable by its participants if this app's server, database, operator, and notification endpoint all disappear, using only participants' PDSes, published lexicons, and any OAuth client.

Non-goals for v1: end-to-end encryption, attachments, DM search, presence/typing, message retention policies, workspace-admin export of DMs.

## 2. What "app-layer centralization" means here

| # | Risk | Where it exists today for channels | DM design answer |
|---|---|---|---|
| R1 | App/operator is the **space authority** (owns membership) | Channels live under the workspace DID and the operator holds its session | No shared authority. Each participant owns the space holding *their own* messages |
| R2 | App server **holds a session that can read the data** | Server-side `oauth-client-node` sessions | DM scopes are granted only to a **browser-held OAuth session**. The server session never requests DM scopes, and no server route touches DM content |
| R3 | App server **stores plaintext copies** | `channel_record_cache` (encrypted with an app-held key) | No server-side DM cache. Each half has exactly one writer, so reads go directly to the PDS. Browser-local caching (IndexedDB, per user) is allowed |
| R4 | App **decides access** | Rejected already (member lists gate reads) | Same: PDS member lists only. `managingAppPolicy` is explicitly forbidden for DM spaces |
| R5 | App is **needed for discovery or delivery** | Workspace invites are out-of-band URIs; the inbox recovery uses the operator | Recipient-owned inbox space discovered through `listRepos` on the recipient's own PDS. Sender-side re-notify handles dropped notifications. No app relay |
| R6 | App **sees the social graph** | Notification registrations name the app's service | Each user's app registers only for spaces its own user reads. Conversation keys are random, so space URIs cannot be computed to probe "do A and B talk?" |
| R7 | **Workspace admin** can read or kill DMs | N/A | DMs are person-scoped, not workspace-owned. Leaving or being removed from a workspace does not touch DMs |

## 3. Design

### 3.1 Two space types, both user-owned

**Personal DM inbox** — `at://<did>/space/org.slack.dm.inbox/self`
- Created once by each user when they enable DMs. The fixed `skey` is `self`, so any app can find it from a DID alone.
- `readPolicy: memberList` (owner only), `appAccess: open`. **`writePolicy` is user-configured** (§3.6) and changed with `com.atproto.simplespace.updateSpace`, so the setting lives on the user's PDS, not in any app.
- Senders write `org.slack.dm.request` records **in their own repo** scoped to the recipient's inbox (`com.atproto.space.putRecord` on the sender's PDS). The recipient's PDS learns the writer set from write notifications. The recipient reads it with `listRepos` plus direct record reads, which is the same pattern as the existing workspace inbox.
- If a user has no inbox, they have not enabled DMs, and the UI says so. There is no fallback path through an app.

**Conversation half** — `at://<did>/space/org.slack.dm.conversation/<convKey>`
- Every participant who posts owns one. It holds **only that participant's messages**.
- `readPolicy: memberList` (all participants read=true), `writePolicy: memberList` (owner only write=true), `appAccess: open`.
- `convKey` is a random TID chosen by the initiator and carried in the request. It is **not** a hash of the DIDs, because a deterministic key would let anyone who can probe space existence confirm who talks to whom.
- The **participant set is immutable** per conversation. Adding someone means starting a new conversation, which matches Slack group-DM semantics and removes every membership-mutation race.

This is **symmetric sovereignty**: each person controls exactly their own words. Removing others from your half revokes their read access to *your* messages ("unsend everything"). Nobody can revoke someone else's messages, add a reader to someone else's messages, or delete the conversation for everyone.

### 3.2 Lexicons (new, `org.slack.dm.*`)

| NSID | Kind | Key | Lives in | Purpose |
|---|---|---|---|---|
| `org.slack.dm.inbox` | space type | `self` | recipient | Request mailbox |
| `org.slack.dm.conversation` | space type | random TID | each participant | That participant's half |
| `org.slack.dm.request` | record | `convKey` | sender repo → recipient inbox | `{ convKey, participants[2..100], createdAt }`. Sorted, deduplicated DIDs that include both parties |
| `org.slack.dm.header` | record | `self` | owner repo → own half | `{ convKey, participants, createdAt }`. It must equal the request set, or readers ignore the half |
| `org.slack.dm.message` | record | TID | owner repo → own half | `{ text ≤ 10,000 code points, createdAt, parent? }`. Edits and deletes are by the author only (implicitly, since the record is in their repo) |
| `org.slack.dm.reaction` | record | canonical key (same scheme as channels) | owner repo → own half | Subject must be a message in the same conversation |

Validation lives in `src/protocol/records.ts`, next to the channel rules: authority == repo for every `header/message/reaction`, `convKey` equals the space `skey`, and participant counts and bounds are checked.

### 3.3 Flows

1. **Enable DMs:** create your inbox space and add yourself as a read member.
2. **Start a conversation** (initiator A; participants P, with 2 ≤ |P| ≤ 100):
   - Before creating anything new, check local conversations (from `listSpaces(type=org.slack.dm.conversation)` on A's own PDS) for the same participant set, and reuse one if found.
   - Create A's half with a fresh `convKey` and add P as read members. Write the header.
   - For each other participant, write `org.slack.dm.request` into their inbox.
3. **Discovery (recipient B):** B's client periodically runs `listRepos` on B's own inbox and fetches new requests. It then applies B's configured policy (§3.6), dropping writers who are not on the current allowlist when in allowlist mode, plus a local display filter: requests from DIDs that share a workspace with B, or that B has written to before, go to the main list; the rest go to a "Requests" folder. Nothing is decided server-side.
4. **Accept / reply:** B creates B's half with the same `convKey` and participants, writes a header, then posts. Declining is simply never creating a half; B can also hide the request locally.
5. **Read:** for each participant in P, mint a space credential for `at://<p>/space/org.slack.dm.conversation/<convKey>` (a missing half means "hasn't replied"), read that owner's records, validate them, and merge by TID. At the 100-person cap:
   - **Credentials:** up to 100 per conversation, fetched 8 at a time via `mapLimited`. They are cached in browser memory up to their ≤ 2 h expiry and minted lazily, only for halves that exist (tracked from headers) instead of all P.
   - **Paging:** the same k-way merge as the channel `fillLatest`. Take a small page from each half, merge, and extend only the halves whose oldest fetched record is still inside the visible window. The initial view loads the latest 100 messages.
   - **Budget:** open a 100-person conversation with 20,000 total messages in ≤ 5 s on the local two-PDS fixture (M4 exit evidence).
6. **Real-time:** the browser client registers **its own app's** notify service on the halves it reads, and renews only the registrations for the conversation that is currently open, plus the user's own inbox. On the server, the notify handler only fans out a content-free "space changed" SSE event, so the server never sees record bodies. Correctness never depends on notifications: the client also polls every 60 s and reads on open.
7. **Dropped-notification recovery:** A cannot read B's inbox, so an unaccepted request and an undelivered one look the same to A. For requests without a reply half, A's client re-puts the same record (same rkey, new rev, which triggers a fresh notification) on a bounded backoff: 1 min, 10 min, 1 h, 1 day, then stop. This is idempotent on B's side.
8. **Leave / block:** remove the other participants from your half (`removeMember`) and hide the conversation locally. **Delete everything:** delete your half. Copies other people already fetched are not recalled; this is the same caveat as in `SPEC.md`.
9. **Cross-app recovery:** everything above can be rebuilt from the user's own PDS (their `listSpaces` of their conversation halves, each half's member list, and their inbox) plus the other participants' halves. No app database is involved.

### 3.4 Client architecture

- **Browser DM session:** add `@atproto/oauth-client-browser` with a separate public `client_id` whose metadata requests **only** DM scopes:
  - own inbox: read
  - own conversation halves: create/update/delete, plus member management
  - requests: `create` on `org.slack.dm.inbox?authority=*` restricted to collection `org.slack.dm.request`
  - reads of other participants' halves

  DPoP keys are non-extractable WebCrypto keys. The Next server's session keeps its current workspace scopes and never gains DM scopes, so a compromised app server cannot read DMs using stored tokens.
- **Code sharing:** move `src/atproto/dpop.ts`, `space-credential.ts`, and `record-pages.ts` to isomorphic code (WebCrypto in place of `node:crypto`) so server channels and browser DMs share one audited implementation. `src/reader/independent.ts` gains a DM reader built from the same modules, which proves second-app parity.
- **No DM routes, tables, or cache on the server.** The only server involvement is the content-free SSE fan-out from step 6. A lint rule (an `eslint` `no-restricted-imports` boundary) keeps `src/dm/**` from importing `@/lib/db`, `@/auth/*`, or `@/operator/*`.
- **UI:** a DM section in the sidebar, filtered by default to co-members of the active workspace; a "Requests" folder; conversation view reusing `ChannelView` rendering where it fits.

### 3.5 Relationship to workspaces

DMs belong to people, not workspaces. The workspace is only a *UI filter* and a *default trust signal* for the request allow policy. Consequences: workspace admins cannot read or delete DMs, workspace removal does not cut off DMs, and there is no DM export for admins. This deliberately differs from Slack Enterprise; signed off in §7.

### 3.6 Configurable request policy (user setting)

The policy is stored in the inbox space's own configuration on the owner's PDS and is readable by any app the user signs into.

| Mode | Inbox `writePolicy` | Member list | Effect |
|---|---|---|---|
| **Everyone** | `publicPolicy` | owner only (read) | Anyone can send a request; the local filter sorts the results |
| **Only people I allow** (default) | `memberListPolicy` | owner (read) + allowed DIDs (`read=false, write=true`) | Requests from others are never tracked by the owner's PDS |
| **Nobody** | `memberListPolicy` | owner only | New requests are closed. Existing conversations keep working because they don't use the inbox |

- "Only people I allow" has a shortcut, "allow members of workspace X", which adds the current co-members with `putMember`. The client re-syncs this list when the app opens. New workspace members are added on the next open, not instantly. This is stated in the UI rather than hidden.
- Replying to a request automatically adds the requester to your allowlist, so later conversations from them aren't blocked.
- Switching modes calls `updateSpace` (and `putMember`/`removeMember` for allowlist edits). The client also filters by the current mode, because writers tracked under an earlier `public` policy may still appear in `listRepos` (verified in M0).
- Default for new users: **Only people I allow**, pre-filled with co-members of the workspaces they belong to. This is the safer default; confirm or override.

## 4. Rejected alternatives

| Alternative | Why rejected |
|---|---|
| DM spaces owned by the workspace DID and run by the operator | R1, R2 and R7: the operator/workspace owner could add itself as a reader and read every DM |
| One space owned by the initiator | Asymmetric: the initiator can remove the other party from history, add silent readers, or delete the whole conversation |
| App-run relay or `managingAppPolicy` for discovery/access | R4/R5: it puts the app back in the access path and makes the app a single point of failure |
| Deterministic `convKey = hash(sorted DIDs)` | Existence probing leaks the social graph (R6); local dedupe gives the same UX |
| Server-side DM cache (encrypted with an app key) | R3: the app holds the key, so this is custody in all but name. Small DM spaces don't need it |
| Mutable group membership | Needs cross-owner consensus on N halves; immutable sets remove the problem entirely |

## 5. Residual risks (stated, not solved in v1)

1. **PDS hosts see plaintext.** Each participant's PDS stores their messages. This is the same trust level as all atproto data. The follow-up is MLS-based E2EE as a new record type (`org.slack.dm.encryptedMessage`), and the design above needs no structural change to add it.
2. **Served JavaScript.** The app server delivers the browser client and could ship malicious code. Mitigations: independent clients work through the published lexicons, releases have Subresource Integrity (SRI) and reproducible builds, and the independent reader proves parity.
3. **Inbox spam in "Everyone" mode.** A public inbox lets anyone grow a user's writer set. Mitigations: bounded `listRepos` scans (existing `listBoundedRepos`), the local filter, the requests folder, and switching modes at any time. PDS-level rate limits are out of our control.
4. **Draft protocol.** Every assumption below must pass conformance on the pinned PDS before any app code is written.
5. **Large-group cost.** At 100 participants, each reader holds up to 100 credentials and notify registrations, and creating a half costs 99 `putMember` calls (there is no batch API in the pinned lexicons). Starting a group writes 99 inbox requests. Immutable membership means adding the 101st person, or any new person, starts a new conversation. At this size a private channel may fit better, so the UI should suggest one above about 20 people without blocking the group.

## 6. Milestones

Each milestone ends with the stated evidence recorded in `PROGRESS.md`. M0 is a hard gate.

**M0 — Protocol conformance (gate).** Extend `protocol-tests/atproto/` against the pinned PDS and prove:
- (a) a non-member can `putRecord` into a `writePolicy: public` space from their own PDS, and the authority's `listRepos` reports them;
- (b) a `memberList` read space denies a non-member credential with the same error whether or not the space exists (no existence oracle; if this fails, document the leak);
- (c) the `authority=*` scope with collection restriction works for request writes;
- (d) `removeMember` blocks new credentials, and existing ones expire at the strict cutoff (the overlay already exists);
- (e) a browser-style public OAuth client can obtain delegation tokens and space credentials with WebCrypto DPoP;
- (f) `updateSpace` switches an inbox between `public` and `memberList` write policies, and it is established whether writers tracked under the old policy remain in `listRepos`;
- (g) under `memberList` write, a non-listed writer's `putRecord` is not tracked by the authority (no `listRepos` entry, no notification forwarded);
- (h) a member-list space accepts 100 members, and credential minting for 100 halves stays within PDS rate limits on the fixture.

Exit: all pass, or the plan is revised.

**M0 results (2026-09-26): passed.** Details are in `docs/protocol/atproto-spaces-pin.md` under "Direct-message conformance". All of (a), (c), (d), (e), (g) and (h) hold. Plan adjustments forced by what was observed:
- **(b) fails: space existence is probeable** (`SpaceNotFound` vs `UserNotAuthorized`, plus `SpaceDeleted`). Random, unguessable conversation keys are now a hard requirement, not just a precaution. Inbox existence (`self`) remains public by design.
- **(f): tightening the policy does not evict tracked writers**, and neither does removal from the allowlist. §3.6 enforcement is therefore split: the PDS stops *new* strangers, and the client **must** filter already-tracked writers against the current mode and allowlist, including in "Nobody" mode.
- **Read-only members can store records scoped to someone else's half** in their own repo; the authority just never tracks them. The M1 validator rule "record repo == half owner" is now mandatory and gets a dedicated test.

**M1 — Lexicons and validation.** Add the six lexicons, codegen, and record validators with unit tests (participant bounds 2–100, key rules, authority == repo, header/request equality). Add a BDD `features/direct-messages.feature` covering start, request, accept, read, edit/delete, leave, delete-all, group, each request-policy mode and mode switch, and the 100-participant bound.

**M2 — Isomorphic protocol core.** Port DPoP, space credentials, and record paging to WebCrypto. Server channel code switches to the shared modules, and the existing unit and acceptance suites must stay green. Add the lint boundary rule.

**M3 — Browser DM session.** Add the `oauth-client-browser` integration, public client metadata route, DM permission set, and consent UX. Test: the server session's granted scopes contain no DM scope (asserted).

**M4 — DM engine (`src/dm/`).** Covers enabling DMs, the request-policy setting (§3.6), starting (with local dedupe), inbox discovery, accept (with auto-allow), send/edit/delete, reactions, the k-way read merge with validation, leave, delete-all, and re-notify backoff. Unit tests use protocol fakes. The two-PDS backend acceptance runs 1:1, 3-person, and 100-person flows across hosts; the 100-person case must meet the §3.3 read budget.

**M5 — UI.** Sidebar DM list, requests folder, request-policy settings panel, conversation view, and SSE fan-out (content-free). Playwright: two browsers on two PDSes complete a DM round trip, then one side revokes and the other loses access after credential expiry.

**M6 — Independence proof.** The independent reader renders identical DM state from lexicons only. A "server off" test runs the full DM flow with the Next server's DB deleted and its notify endpoint down (only the static client is served) and must pass. Update `SPEC.md`, `ARCHITECTURE.md`, and `CODE-MAP.md`.

**M6 results (2026-09-28): passed.** `src/reader/independent-dm.ts` renders a conversation (messages, reactions, per-half status) from the published `org.slack.dm.*` lexicons alone, sharing only the protocol layer with `src/dm/dm-client.ts` (`src/protocol/*`, `src/atproto/xrpc.ts`, `record-pages.ts`, `space-credential-core.ts`) and implementing its own full-history merge instead of reusing `src/dm/merge.ts`. `protocol-tests/dm-acceptance.test.ts` asserts `DmClient.readConversation` and `readIndependentDmConversation` return identical message URIs/texts, reactions, and half statuses at six checkpoints across the 1:1 flow (missing, ok with edits/reactions, ok after delete/unreact, revoked after leave, deleted after delete-everything) and the 3-person group flow (ok). Two ESLint `no-restricted-imports` rules enforce the independence boundaries statically: `src/reader/**` cannot import `src/dm/**`, and `src/app/api/**` cannot import `src/dm/**`; both were proven to fire (temporarily added a forbidden import, confirmed lint failed, removed it) and both pass on the real tree. The existing `protocol-tests/dm-acceptance.test.ts` "server off" run (no Next server process started at all, `DATABASE_PATH` pointed at an asserted-never-created directory) already covered every listed flow (enable, all three policy modes, start, request discovery, accept, send, edit, delete, react, read, leave, delete-everything, re-notify) before this milestone; no gap was found, so it was only extended with the parity assertions above. Exact command results are in `PROGRESS.md`.

Deviations from this plan, carried forward from M2–M5 and confirmed still accurate at M6:
- `DmConfig` (`src/dm/browser-session.ts`) carries `{ appUrl, plcUrl, scope, serviceRef, loopback }`, passed from the server (`src/app/page.tsx`) rather than being reconstructed client-side; no new environment variable was needed (`.env.example` unchanged).
- `SpaceCredentialError` (`src/atproto/space-credential-core.ts`) gained `404` (`SpaceNotFound`) and `410` (`SpaceDeleted`) status codes, beyond the `401`/`403` the channel code originally used, so `readConversation`'s per-half status (`missing`/`deleted`/`revoked`) can be derived from one credential-mint failure instead of a separate probe.
- The empty-allowlist-vs-"nobody" ambiguity (an inbox with a `memberListPolicy` and zero members can't be told apart from one deliberately closed) is handled by keeping dormant (`write:false`) member entries instead of removing them on `setRequestMode("nobody")`, and the M5 settings UI always re-applies the user's selected mode after any allow/disallow edit so the stored PDS state never drifts from what the user chose.
- A well-known-only handle resolver (`wellKnownHandleResolver` in `src/dm/browser-session.ts`) was added solely to satisfy `BrowserOAuthClient`'s required `handleResolver` option; `connectDms`/`restoreDmSession` always sign in with a DID already known from the server session, so this resolver's `resolve()` is never actually exercised in the app's own flow, and it deliberately avoids any third-party AppView relay (only the handle's own `https://<handle>/.well-known/atproto-did`).
- `pnpm test:browser` runs with `--test-concurrency=1` because both Playwright specs (`oauth-callback.spec.ts`, `dm.spec.ts`) start their own real `next start` server subprocess on its own port; running them concurrently is unnecessary contention, not a correctness requirement.

## 7. Decisions (resolved 2026-09-26)

1. **DM tokens:** a browser-held OAuth session with DM-only scopes. The server session never receives DM scopes.
2. **Inbox policy:** user-configurable (§3.6), with three modes: Everyone, Only people I allow, Nobody. Default: "Only people I allow," pre-filled with workspace co-members.
3. **Scope:** DMs belong to people, not workspaces. Workspaces are only a UI filter and a trust signal.
4. **Group cap:** 100 participants, including the initiator.
