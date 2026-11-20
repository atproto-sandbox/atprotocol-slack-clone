# Feedback for the AT Protocol Permissioned Spaces Authors

**From:** The Flock PoC engineering effort (`atproto-sandbox/atprotocol-slack-clone`)  
**Target Upstream Revision:** Proposal 0016 & `bluesky-social/atproto#5187` through commit `6747610566` (`0.0.0-spaces-alpha-20261117141222`), migrated across five alpha snapshots (`787a730f` → `5b95b2f2` → `619c6e85` → `5d88b414` → `6747610566`).

---

## 1. What We Built with This PoC

We built **Flock**, a full-featured Slack-style team collaboration app plus a Linear-style Tasks extension and 1:1 / group Direct Messages, designed specifically to stress-test **AT Protocol permissioned spaces** under realistic product, security, and scale constraints:

- **No application database of record:** Every workspace, public channel, private channel, join-request inbox, app inbox, collaborative extension space, and DM conversation lives exclusively in spaces on members' own PDSes. PDS member lists are the sole read/write gate.
- **Browser-direct reads and writes (`@flock/client`, `apps/web`):** Users sign in with a browser-held OAuth session backed by non-extractable keys in IndexedDB. The browser mints key-bound space credentials (`authorizeSpaceSync`), writes records directly to the user's own PDS, and pulls directly from authority and writer PDSes while verifying **RFC 9421 HTTP Message Signatures**, **KEM-derived MACs**, **DRISL record CIDs**, **2048-byte LtHash / 32-byte digest commits**, and **STAR archives (`@atproto/star`)**.
- **Minimal separate-origin operator (`apps/operator`):** A small XRPC service that holds encrypted workspace-authority OAuth grants solely to execute journaled, idempotent membership/channel mutations (`createWorkspace`, `inviteMember`, `removeMember`, privacy transitions, app installs) and to serve content-free change cursors (`getChanges`).
- **Zero-knowledge Direct Messages (`@flock/client/dm`):** 1:1 and up to 100-participant group DMs modeled with per-recipient request inboxes (`everyone` / `allowlist` / `nobody`) and per-participant conversation halves (`write=true` only for the half owner). The operator stores **zero DM rows in SQLite**, relaying only ephemeral in-memory change cursors gated by RFC 9421 space-credential proof-of-possession.
- **CRDT-style collaborative Tasks extension (`new.flock.ext.tasks`):** Projects, Kanban boards, list/activity views, and comments built over append-only per-writer op records merged via a deterministic causal DAG + Hybrid Logical Clock (HLC) + add-wins OR-Set engine, synced via STAR snapshots and `listRepoOps`.
- **Apps, slash commands, and webhooks (`apps/echo-bot`, `apps/webhooks`):** Narrow app OAuth grants (`appGrantScopes`), per-app inboxes, `/command` dispatch, interactive message block actions, and incoming webhooks.
- **Three standalone "zero lock-in" readers (`@flock/reader`):** Independent implementations for workspaces/channels, DMs, and Tasks that depend *only* on `@flock/protocol` and `@atproto/{space,star}`—never on our app database or client engine—proving a second client can reconstruct full state from PDSes alone.
- **Verification & scale envelope:** `939` unit/component tests, `76` executable Gherkin scenarios driven through real Chromium against multi-PDS local fixtures, `13` backend acceptance suites, `8` browser CSP/CORS/OAuth specs, `5` real `@atproto/pds` conformance suites, warm-reopen sync budget gates (`1` `listWriters` call across `200` writers), and scale benchmarks at **200 members / 100 channels / 2,000,000 messages + 2,000,000 reactions** and **100-participant group DMs**.

---

## 2. What Worked Really Well

### 2.1 The Authority + Per-Writer Repo Split Scales Cleanly
The foundational model—one space authority minting short-lived credentials and tracking participating writers while each member writes into their own PDS-hosted space repo—proved remarkably versatile. It cleanly supported four very different topologies without protocol special-casing:
1. **Dedicated-account workspaces & channels** (many readers, many writers, authority-managed membership).
2. **Member-to-admin / user-to-app request inboxes** (`publicWrite` or member-gated write, restricted read).
3. **Serverless group DMs** (each participant is the authority of their own conversation half; leaving or revoking access is a local PDS policy update).
4. **Multi-writer CRDT state (`ext.tasks`)** (cold-booting from MAC-verified `getRepo` STAR archives and catching up via `listRepoOps`).

### 2.2 Recent `#5187` (R12) Protocol Refinements Solved Major Real-World Pain
Migrating from the late-October snapshot (`5d88b414`) to the mid-November snapshot (`6747610566`) eliminated hundreds of lines of fragile application workarounds:
- **Inline `authorizeSpaceSync` (`notify` + `spaceRev`) over standalone `registerNotify`:** Coupling webhook registration to authorization, running synchronous `confirmRegistration` *only* on new `(space, endpoint, token)` tuples, renewing silently when re-authorizing with the same token, abandoning lapsed registrations immediately when `#registrationExpired` returns HTTP `400`, and returning `spaceRev` inline made gap detection across operator restarts clean and deterministic.
- **`listWriters` (`#repoWrite` / `#repoRemoved`) + `removeWriter`:** Replacing `listRepos` with `listWriters` (carrying explicit `#repoRemoved` entries within the 72h cursor window) let incremental syncers drop evicted writers cleanly on warm reopen without re-listing every writer's records.
- **Batched `putMembers` / `removeMembers` (`<= 100`):** Turned `O(N)` sequential round-trips during workspace bootstrap, private-channel transitions, and 100-person group DM setup into single batched calls.
- **End-to-end cryptographic verification (`@atproto/space` + `@atproto/star`):** Ephemeral KEM encapsulation + RFC 9421 MAC headers (`Atproto-Space-Commit`, `Atproto-Space-Record`, `Signature-Input`, `Signature`) with `Vary: Accept-Signature` and browser CORS exposure worked end-to-end in real Chromium. Making unwritten repos return `RepoNotFound` on `listRepoOps` and signing every `listRepoOps` page closed earlier unsigned-empty-response ambiguities.
- **Scoped OAuth & `ACCESS_FULL` boundaries:** Parameterized `space:` scopes and refusing `getDelegationToken` under `ACCESS_FULL` app passwords gave clean privilege separation between human sessions, narrow bot sessions, and authority management grants.

---

## 3. Advice & Recommendations for Improving the Protocol

Below are the concrete friction points we hit, ordered by how much application-side complexity, privacy leakage, or operational risk each protocol improvement would remove. (Detailed standalone issue drafts with reproductions are also archived under [`.ai/upstream/`](.ai/upstream).)

### Priority 1: High-Impact Architecture, Privacy & Custody

#### 1. Add a Client-Direct Change Subscription (`subscribeSpace`)
- **What happens today:** `authorizeSpaceSync`'s `notify` mechanism delivers webhooks to an HTTPS service endpoint. Browser and mobile clients have no public webhook endpoint, so **every real-time Spaces app must operate a server relay**.
- **Why it matters:** Even when an app keeps zero content on its server (as we did for DMs), the relay still learns *social-graph timing and subscription metadata* (which conversation halves and inboxes `callerDid` is actively watching). Furthermore, building a safe multi-tenant webhook relay for untrusted callers required substantial defensive machinery: caller-scoped RFC 9421 credential proof-of-possession (`getDmNotifyTarget`), replay locks, epoch-rotating HMAC tokens (so a revoked member cannot keep triggering wakes indefinitely or withdraw another member's registration), and cross-worker IPC fan-out.
- **Recommendation:** Add a credential-authenticated streaming endpoint on the authority PDS (e.g., `com.atproto.space.subscribeSpace` over HTTP streaming / SSE so standard `Authorization` + RFC 9421 signature headers work natively in browsers, or WebSocket with first-frame credential auth) emitting the same `{ repo, repoRev, spaceRev }` / `#repoRemoved` / `#spaceDeleted` events as `notifySpaceUpdate`. Keep `notify` webhooks for backend indexers and bots, while letting browser/mobile clients subscribe directly to PDSes with zero middleman.

#### 2. Support Delegated Space Management Without Sharing the Authority's OAuth Session
- **What happens today:** Only the space authority DID itself can call `putMembers`, `removeMembers`, `removeWriter`, or `updateSpace`. For a team workspace owned by a dedicated identity (`did:plc:workspace`), human admins cannot act with their own accounts; an operator service must hold the workspace account's full OAuth session (including its refresh token) in custody. (`com.atproto.managedspace` solves dynamic read/write checks via an app callback, which puts the app in the read path rather than delegating *who may edit the PDS member list*.)
- **Operational sharp edge we hit in R12:** Upstream `@atproto/pds` **revokes OAuth refresh tokens when an account receives `AccountTakedown`**. Even after we built a quarantined session store and circuit breaker so temporary `AccountDeactivated` / `AccountTakedown` responses never wipe stored grants, a workspace authority that is briefly taken down by mistake and restored >1 hour later loses its refresh token permanently and freezes all admin operations until a human logs in as the workspace account again.
- **Recommendation:** Allow a space owner to designate manager DIDs on `memberspace` (e.g., `putManagers` / `removeManagers` or a `manage: true` member capability) and let a manager's PDS mint a short-lived `atproto-space-management+jwt` (parallel to `getDelegationToken`) accepted by `putMembers` / `removeMembers` / `updateSpace`. Human admins then act under their own sessions with zero shared OAuth custody.

#### 3. Provide Opt-In Cross-PDS Invitation / Membership Discovery
- **What happens today:** `com.atproto.space.listSpaces` only returns spaces an account has *written* into on its own PDS. When an admin adds `did:plc:bob` to a workspace on `did:plc:workspace`, Bob's PDS knows nothing about it. When Bob signs into any client—or switches to a second independent client—he sees an empty dashboard unless someone sends him an out-of-band invite link.
- **Recommendation:** Add an opt-in membership notification from the authority PDS to the added member's PDS (e.g., `com.atproto.space.notifyMembershipChanged`, stored in a private member-only index queryable via `listJoinedSpaces` with a user's OAuth scope), or standardize a minimal system invitation inbox space. That makes multi-app portability real from first sign-in.

#### 4. Add a Write-Target Existence Signal on Cross-Host Writes
- **What happens today:** By design, `putRecord` into another authority's space writes locally to the caller's PDS and returns `200 OK` without blocking on whether the target space exists, and non-members probing `authorizeSpaceSync` now rightly receive `SpaceNotFound` whether or not a hidden space exists. Consequently, when Bob sends a DM request to `at://did:plc:alice/space/new.flock.dm.inbox/self`, Bob's client cannot tell *"delivered to Alice's inbox"* from *"Alice has never enabled DMs and nothing will ever track this write."*
- **Workaround cost:** Every Flock DM user has to publish a separate public repo record (`new.flock.dm.declaration`) just so senders can check inbox existence, and that record drifts if the space is deleted outside the app.
- **Recommendation:** Either return an optional `spaceStatus: "confirmed" | "notFound" | "unknown"` hint from `putRecord` when the writer's PDS synchronously notifies or caches the authority's response, or provide a lightweight `getSpaceWriteStatus({ space })` query scoped to callers holding a `write` grant for that space type.

---

### Priority 2: Sync, Policy & Revocation Correctness

#### 5. Enforce Exact `exp` Cutoff on Space Credentials (No Post-Expiry Clock-Skew Grace)
- **What happens today:** `verifySpaceToken` applies a 5-second `CLOCK_SKEW_SEC` grace to `exp` (`now - CLOCK_SKEW_SEC >= payload.exp`) for all token types—delegation tokens, client attestations, *and* space credentials.
- **Why it matters:** Clock skew tolerance is essential on `iat` / `nbf` and on 60-second single-hop delegation tokens, where issuer and verifier clocks may drift slightly. Applying it to `exp` on 10–60 minute space credentials means a removed member's credential continues to read private records *after* its stated `exp` timestamp, which breaks deterministic revocation SLAs and conformance tests (we carry [`strict-credential-expiry.patch`](protocol-tests/atproto/strict-credential-expiry.patch) solely to set `expirationSkew = 0` for `type === 'credential'`).
- **Recommendation:** Keep `CLOCK_SKEW_SEC` on `iat` and on `'delegation'` / `'clientAttestation'` tokens, and enforce strict `now >= payload.exp` for `'credential'` tokens.

#### 6. Signal Oplog Resets Explicitly in `listRepoOps`
- **What happens today:** `clearRecords` and `importRepo` wipe a writer's oplog for a space without recording a reset entry. If a syncer subsequently calls `listRepoOps({ since: oldRev })`:
  - If no new writes occurred after `clearRecords`, it receives `ops: []` and the new `commit`—indistinguishable at the op-list level from "nothing changed" unless the client recomputes the full `LtHash` over its local store and notices `localDigest !== commit.data`.
  - If new writes *did* occur after `importRepo` / `clearRecords`, `listRepoOps` returns only the post-reset ops whose final `rev` matches `commit.rev`, silently omitting the wipe unless verified against `LtHash`.
  - Calling `clearRecords` on an already-empty repo returns early without clearing the existing oplog, contradicting the lexicon description.
- **Recommendation:** Return a typed error (e.g., `SinceUnavailable` / `InvalidCursor`, matching `listWriters` >72h cursor expiry!) whenever `since` predates an oplog reset or retention purge, or emit an explicit `#repoReset` operation in the oplog so incremental readers know immediately to fall back to `getRepo` STAR / `listRecords`.

#### 7. Smooth Out `memberspace` Policy-Switch & Dormant-Entry Sharp Edges
Building full 3-mode DM privacy controls (`everyone` ↔ `allowlist` ↔ `nobody`) surfaced three subtle `memberspace` interactions that every app will otherwise trip over independently:
1. **Empty allowlist vs `nobody` ambiguity:** A `memberspace` policy with `publicWrite: false` and zero members cannot distinguish *"Only people I allow (currently 0 people)"* from *"Nobody."* Apps have to park dormant entries (`read: false, write: false`) or external state to preserve mode intent.
2. **Dormant member entries silently block `publicWrite: true` (`nobody` → `everyone`):** If Alice previously allowed Carol, switched to `nobody` (updating Carol's member entry to `write: false` so Carol's allowlist membership isn't forgotten), and later switches to `everyone` (`publicWrite: true`), **Carol's explicit `write: false` member row overrides `publicWrite: true`**—silently blackholing Alice's closest contacts while letting total strangers write! Either `publicWrite: true` should be purely additive (`publicWrite || member.write`) unless an explicit `deny`/`block` bit is set, or `memberspace` should separate `allow` from `block` / `dormant`.
3. **Tightening `publicWrite: true` → `false` via `updateSpace`:** Updating the space policy does not prune writers tracked during the `publicWrite: true` window. Adding an optional `pruneUnauthorizedWriters: true` flag on `updateSpace` (or a bulk `pruneWriters` method) would save apps from manually diffing `listWriters` against `listMembers` and calling `removeWriter` in loops.

#### 8. Per-Record Host-Assigned Monotonic Sequence & Third-Party Record Validation
- **Ordering (`U5`):** `spaceRev` is a great space-wide checkpoint, and `repoRev` tracks repo commits, but within `listRecords` ordering is still by writer-chosen `rkey`. A buggy or hostile writer choosing lexicographically maximal keys (`~~~...`) pins their messages to the top of naive time-sorted feeds and can consume pagination budgets unless clients maintain custom key-syntax filters and per-writer caps. Exposing the host-assigned commit `rev` on each record in `listRecords` (and/or key prefix/range bounds beyond `cursor`) would give clients trustworthy host-observed ordering.
- **Schema & key validation (`U8`):** Because PDSes treat third-party `new.flock.*` space records as `validationStatus: unknown`, every reader must validate every record and `rkey` defensively on read (`@atproto/lexicon` + bounded byte caps). Opt-in lexicon/rkey enforcement on space creation (or collection-scoped write rules in policy) would prevent garbage records from entering tracked repos in the first place.

---

### Priority 3: Webhook, OAuth & Local-Dev Ergonomics

#### 9. Decouple Server-Operator Webhook TTL from Short-Lived Read Credential TTL
- **What happens today:** `authorizeSpaceSync` ties webhook registration lifetime directly to the space credential's `exp` (`10 minutes` default, `1 hour` ceiling).
- **Operational impact:** While `10 minutes` is an ideal default for browser read credentials (bounding post-removal read access), tying server-to-server webhook survival to the same `10-minute` credential forces an app operator managing `1,000` mostly-idle channels to wake up every few minutes, restore authority OAuth grants, mint delegation tokens, and re-run `authorizeSpaceSync` across all `1,000` spaces forever—even when zero users are online and zero messages are being sent.
- **Recommendation:** Either allow `authorizeSpaceSync` to accept a separate `notifyTtl` (e.g., up to `24h` when confirmed by an HTTPS endpoint, while keeping the returned read `credential` at `10m`), or allow confidential `did:web` syncers to batch-renew active `( endpoint, token )` registrations for spaces under one authority in a single XRPC call (`renewSpaceRegistrations`).

#### 10. Resolve the Loopback `127.0.0.1` vs `localhost` Split Between OAuth and Webhooks
- **What happens today:** During local development without TLS tunnels:
  - `@atproto/oauth-provider` / RFC 8252 loopback rules **require IP literals** (`http://127.0.0.1:<port>`) for loopback OAuth clients and reject `localhost`.
  - `@atproto/pds`'s outbound webhook client (`safeFetchWrap({ allowIpHost: false })`) **rejects IP literals** (`127.0.0.1`) even in `devMode` and requires `http://localhost:<port>`!
- **Impact:** Local services have to bind loopback and advertise *two different origins* (`http://127.0.0.1:<port>` for OAuth vs `http://localhost:<port>` for `did:web` and `authorizeSpaceSync.notify.endpoint`).
- **Recommendation:** In PDS `devMode` (when `disableSsrfProtection` / loopback dev mode is active), permit `127.0.0.1` / `[::1]` in `safeFetchWrap` for space webhook delivery so local OAuth and local webhooks can share a single loopback origin.

#### 11. Ship Server-Resolved Permission Sets Before Freezing Client Scopes
- **What happens today:** Permission sets (`new.flock.permissions.member`) expand client-side into explicit `rpc?lxm=...` scope strings at login time. When we added a single new operator XRPC method (`new.flock.operator.getDmNotifyTarget`) in R12, every existing browser session's cached OAuth grant lacked that `lxm` entry—which would have forced a hard sign-out across all users unless we shipped a `LEGACY_OPERATOR_METHODS` fallback shim in session restoration and degraded push registration gracefully until reconnect.
- **Recommendation:** Strong `+1` to the proposal's planned PDS-resolved permission sets (`include:new.flock.permissions.member`), which will let apps add non-escalating helper methods within an approved namespace without invalidating live user sessions.

---

## 4. Summary Table for Triage

| Area | Current Behavior (`6747610566`) | Suggested Protocol Improvement | App Machinery Removed |
|---|---|---|---|
| **Browser real-time** | Webhook-only (`authorizeSpaceSync.notify`) | `subscribeSpace` stream (HTTP SSE / WS) | App-operated relay server, PoP token endpoint, multi-worker wake IPC |
| **Multi-admin custody** | Owner OAuth session required for `putMembers` / `updateSpace`; takedown revokes refresh token | `memberspace` manager list + `getManagementToken` | Encrypted authority OAuth custody & takedown re-auth cliff |
| **Invite onboarding** | `listSpaces` only shows spaces written to locally | Opt-in `notifyMembershipChanged` / `listJoinedSpaces` | Out-of-band invite URLs required before spaces appear |
| **Cross-host inbox writes** | `putRecord` returns `200 OK` even if target space doesn't exist | `spaceStatus` hint on `putRecord` or write-scoped `getSpaceWriteStatus` | Public `dm.declaration` repo record per user |
| **Credential expiry** | 5s `CLOCK_SKEW_SEC` grace applied to `exp` on credentials | `expirationSkew = 0` for `type === 'credential'` | Local `strict-credential-expiry.patch` on PDS |
| **Oplog resets** | `clearRecords` / `importRepo` leave no reset marker for `listRepoOps(since)` | `SinceUnavailable` error or `#repoReset` op | Mandatory full `LtHash` recomputation to detect wiped history |
| **`memberspace` modes** | `write: false` row overrides `publicWrite: true`; empty allowlist == `nobody` | Additive `publicWrite` (separate `block` bit) + optional `pruneWriters` | Client-side dormant-member reactivation & stranger sender filters |
| **Idle webhook churn** | Webhook TTL == credential `exp` (10m default) | Separate `notifyTtl` or batch `renewSpaceRegistrations` per authority | Continuous 60s background OAuth + delegation sweeps for idle spaces |
| **Local dev loopback** | OAuth requires `127.0.0.1`; webhook `safeFetchWrap` requires `localhost` | Allow `127.0.0.1` / `[::1]` in PDS `devMode` webhook client | Dual-hostname (`127.0.0.1` vs `localhost`) loopback URL translation |
