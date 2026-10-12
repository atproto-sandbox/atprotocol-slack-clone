# App and protocol review — 2026-09-28

Branch reviewed: `feat/direct-messages` at `0fadc2c` (M0–M6 complete), plus the fixes listed under status below.
Pinned protocol: proposal 0016 at `119fa6b`, PDS PR #5187 at `787a730f` plus the strict-expiry overlay.

## Working rule: app issue or protocol issue

Every finding is sorted by where its root cause lives.
- **App issue:** the defect is in our code, or is an app-level decision. We fix it here.
- **Protocol issue:** the elegant fix is a change to the atproto core protocol. We request it upstream, document the interim exposure, and do **not** ship an app-side stopgap that would be thrown away when the protocol changes.
- **Split:** the app part is fixed, the protocol part is requested.

## Scope and evidence ceiling

Inspected directly: DM engine, browser session, SSE routes, notification ingestion, record validation and ordering, route guards, CSP, redirects, service-auth window, dependency audit, and the full upstream proposal text. One claim (message pinning) was reproduced with a runnable script.

Not re-audited: OAuth flow internals, encrypted cache, and operator journal internals, which had a dedicated security review on 2026-09-25 (`PROGRESS.md`). This is not a penetration test or an external audit.

## Verdict

The architecture holds. The DM invariants (no server DM scopes, no server DM content, independent reader parity) are enforced by tests and lint. The real weaknesses are bounded: three of them trace to protocol gaps and are waiting on upstream, and the app-side bugs are small. None involves the PDS read gate.

## Status at a glance

| # | Finding | Kind | Status |
|---|---|---|---|
| F5 | DM inbox stream not limited to its owner | App | **Fixed** |
| F2 | One hostile sender blanks the DM list | Split | App part **fixed**; eviction is **U1** |
| F1 | Future-dated keys pin messages to the top | Protocol | Interim rule tried and **backed out** (made it worse); real fix is **U5** |
| F3 | Live updates reveal conversation membership to the server | Protocol | Open; **U2** |
| F4 | One live connection per participant half | Protocol | Open; **U2** |
| F6 | CSP allows inline scripts | App | Open |
| F7 | Re-notify checks every minute, forever | App | Open |
| F8 | Service-auth tokens have no replay cache | App | Open |
| F9 | Leftovers (dialogs, stale docs, test flake) | App | Open |
| F10 | An invited member cannot find the workspace; accept failures were silent | Split | App part **fixed** 2026-10-07; discovery is **U10** (see `2026-10-07-invite-discovery.md`) |
| F11 | Gherkin features were never executed | App (process) | **Fixed** for `workspaces.feature`; 58 scenarios still `@unbound`, ratcheted by `bdd/gate.test.ts` |

---

# Part A — App issues

## Fixed

**F5. The DM stream route did not check inbox ownership.** Any signed-in user of the same server could watch when someone else's inbox received writes, if that person had registered notifications with this server. Now `authorizeDmSubscription` (`src/lib/dm-subscription.ts`) allows an inbox stream only for its owner (403 otherwise) and keeps conversation-half streams open to any signed-in user, because their random key is the guard and the server holds no DM credentials to check membership. Tests: `src/lib/dm-subscription.test.ts`.

**F2 (app part). One hostile sender could blank the whole DM list.** `listRequests` threw when a sender had more than 1,000 request records or the tracked writer set exceeded 10,000, and the UI loaded conversations, requests and the inbox with one `Promise.all`, so one throw failed all three. `listConversations` also called `listRequests` internally, and the UI discarded those entries anyway.
- `scanRequests()` now skips a sender with too many records or an unreachable host and reports it, and flags a truncated writer set instead of throwing. `listRequests()` is a thin wrapper.
- `listConversations()` lists only your own halves.
- The requests folder shows a plain note when senders were skipped.
- Tests: oversized sender, unreachable sender, scan-limit overflow, the wording helper, and `listConversations` isolation (`src/dm/dm-client.test.ts`, `src/dm/ui-logic.test.ts`).

## Open

**F6. The page CSP allows inline scripts, and the DM session lives in the page.** `script-src 'self' 'unsafe-inline'` and `connect-src 'self' https:` (`src/lib/security-headers.ts`). A non-extractable key stops key theft but not use, so an XSS bug would let an attacker operate the DM session. No nonce or integrity handling exists, and plan §5 lists SRI and reproducible builds as mitigations that are not implemented. Fix: nonce-based CSP through Next's proxy, then correct the plan text.

**F7. `renotifyPending` never stops.** It runs `isPending` (a credential mint attempt) for every pending participant every minute, before checking the backoff schedule, and continues after the schedule ends. Fix: check the schedule first and persist "gave up."

**F8. Service-auth tokens have no replay cache.** Tokens are accepted within a 75-second window without a `jti` check (`src/operator/security.ts`). Safe today because operations are idempotent by workspace, actor, operation id and request hash, and reads are read-only. A small cache would remove the reliance.

**F9. Leftovers.** Two `window.prompt`/`window.confirm` calls in channel edit and delete (DMs use in-page forms), a stale `PLAN.md` with no DM entry, `test:acceptance` lacking `--test-concurrency=1` (the dev-env port-lock race showed up in the browser run), and `workspace-manager.tsx` still at 605 lines. Also a latent timing race in `protocol-tests/app-acceptance.test.ts` (around line 265): the "reply" message's key is `Date.now() - 100` taken after two network round trips, so if they take over 100 ms the reply sorts as the newest message and the assertion on the latest message fails. It failed once under concurrent CPU load and passed 3/3 on an idle re-run of the same tree.

---

# Part B — Core protocol issues (upstream)

Each item names the app finding it would resolve, the evidence, and the proposed shape. Nothing has been filed.

## Findings caused by protocol gaps

**F1 → U5. Message ordering trusts the author.**
- Evidence: `listRecords` returns `collection`, `rkey`, `cid`, `value` only. Readers sort by the author-chosen TID key (`src/dm/merge.ts`, `src/workspaces/channel-sync.ts`, `src/reader/independent-dm.ts`), and validation only checks the key's shape. A script using the real validator and merge showed a key 50 years ahead passes and a latest-4 page came back as 3 attacker messages and 1 honest one.
- Impact: with 100 such records, the whole first page of a channel (up to 200 members) or a DM belongs to the attacker.
- **Interim rule tried, then backed out (2026-09-28).** We implemented "readers ignore message keys dated more than 10 minutes ahead of their clock" for channels and DMs, with tests. An independent review of the diff found it converts pinning into something worse:
  - DM reads: dropping future-keyed records after fetching them leaves the half looking unfinished, so the reader keeps paging through the attacker's pile. One participant with N such records forces about N divided by the page size sequential requests per read, and past 10,000 rounds the read throws, making the conversation unreadable.
  - Server channel sync (`src/workspaces/channel-sync.ts`): the paging cutoff and the 20,000-record cap are computed from raw, unfiltered cached records, so an attacker's future-dated pile still forces every latest-page read to fetch and cache up to 20,000 records, and can fill the cap so honest messages are missing.
  - Fixing both properly means new "skip the hostile prefix" paging logic in three places, and `listRecords` has no key-range or seek parameter (only an opaque cursor, `reverse` and `limit`), so a reader cannot jump past a hostile range and must page through it.
  - The change was not committed. The patch was kept only in the session scratchpad.
- Current exposure: pinning only. It needs a channel member or a DM participant, so it is griefing by an already-admitted account. Admins can remove a member; a DM participant can leave.
- This strengthens U5: the fix needs a host-assigned ordering value **and** a way to seek or bound a `listRecords` range.

**F3, F4 → U2. Live updates need a relay that sees who follows what.**
- Evidence: `registerNotify` needs a service endpoint, so a browser-only client must relay through the app server. `dm-conversation.tsx:46-63` opens one `EventSource` per existing half of the open conversation plus the user's inbox, each authenticated with the server session. The server can log which halves, and so which participants, a signed-in user follows. `docs/operations.md` discloses the database side (`repo_did` in `space_notification`) but not this. A 100-person group opens about 101 connections, each polling SQLite every second.
- Why no app stopgap: multiplexing the relay only makes a leaky design cheaper, and it disappears when clients can subscribe directly.
- Interim options, not taken: make live updates an opt-in with a plain disclosure and default to polling; add the subscription exposure to `docs/operations.md`.

**F2 (protocol part) → U1. Tracked writers are never evicted.**
- Evidence: M0 checks f and g. Tightening the write policy or removing a writer from the allowlist leaves them in `listRepos`, and no call removes them.
- Impact: the tracked writer set only grows, so the scan bounds are the only defense left in the app.

## Requests that remove app machinery

**U1. Writer eviction (high).** Drop the writer from the tracked set and stop forwarding on policy tightening or member removal, or add an explicit `removeWriter`.

**U2. Client-direct change subscription (high).** A stream on the repo host and space host, authenticated by a space credential, with a resume cursor. It fits the proposal's stance: it is `listRepoOps` as a stream, not a relay.

**U3. Member-readable roster, opt-in (high).** `listMembers` needs OAuth with a read grant on the authority's own PDS, and a space credential is explicitly not enough (lexicon), so members hosted elsewhere cannot list it; the proposal also says readers are never enumerated at the protocol level. We built shadow roster records plus a reconciliation operator (tested at 52 injected failure boundaries) because members cannot see membership. Ask for a per-space option letting credential holders list members (at least the write-capable ones). It would also let admins recover writers whose write notification was dropped without an operator.

**U4. Delegated space management (high).** The operator stores the workspace DID's OAuth session to run `putMember`/`removeMember`. The proposal's `managing-app` policy decides read and write access, not management, and using it would put the app in the read gate. Ask that an owner can delegate `manage` to other DIDs (or accept a scoped service-auth token) so admin actions need no custody of the owner's session.

**U5. Host-assigned per-record `rev` and a range bound (medium).** Include the commit `rev` that last wrote each record in `listRecords`/`getRecord`, add a way to seek or bound a `listRecords` range (by key or by `rev`), and state a minimum retention for the `listRepoOps` `since` log so incremental sync can rely on it. The range bound matters because a reader-side rule against hostile keys needs it: without it a reader must page through the hostile range.

**U6. Holder-aware credential revocation (medium).** A credential carries no holder identity, so a removed member keeps read access until expiry (up to 2 hours), and the pinned PDS accepted credentials 5 seconds past `exp`, which forced our overlay patch. Ask for strict expiry as normative, a per-space credential lifetime, and a membership-epoch claim that repo hosts can check.

**U7. Batch membership calls (medium).** A 100-person half needs 99 `putMember` calls, and 100 halves took 9,900 (27.5 s with rate limits off). Ask for `putMembers`/`removeMembers` with a bounded batch size.

**U8. Third-party record validation and key filter (medium).** The PDS validates only built-in schemas, and its explicit-slur filter rejects some random base32 keys, forcing us to insert colons into every hash-derived key (`docs/protocol/atproto-spaces-pin.md`). Ask that declared space collections resolve dynamically, and that machine-generated keys are exempt or the exact rule is documented.

**U9. Optional hidden spaces (low, trade-off).** Missing, deleted and unauthorized are distinguishable to a non-member (`SpaceNotFound`, `SpaceDeleted`, `UserNotAuthorized`), so existence can be probed. We use random keys as a workaround, and members benefit from the richer statuses. Ask for an opt-in setting that returns one uniform error to non-members.

**Endorse only (already acknowledged upstream).** The proposal already lists an account and identity events endpoint for space-only syncers as future work, and describes permission-set-style dynamic scope resolution. Both would help this app; a +1 is enough.

**U10. Invitation discovery (high).** A member's PDS lists only spaces the user has written to, so being added to a space is invisible to the member. Add a best-effort `notifyMembership` from the authority host to the member's PDS and a `listMemberships` query on the PDS. Draft: `.ai/upstream/U10-invitation-discovery.md`.

## Suggested order

Send U1–U4 and U10 first, since they remove the most app-side machinery (writer bounds, the relay, shadow rosters, custody of the workspace session). Filing anything publicly needs an explicit go-ahead.

---

## Verified sound

- `pnpm audit`: no known vulnerabilities, including the new browser OAuth, WebCrypto and hash dependencies.
- All 10 non-XRPC POST routes import and use `rejectCrossOriginMutation`. XRPC routes authenticate by service auth.
- Redirects are fixed to the configured app URL. No `dangerouslySetInnerHTML` or `innerHTML` in app code.
- Service-auth verification checks issuer, audience, method, and a 75-second `iat`/`exp` window.
- The server OAuth session never requests DM scopes (asserted by unit test), and `src/app/api/**` cannot import `src/dm/**` (lint).
- DM flows pass with no app server and no database, and the independent reader matches the engine on every half status.
