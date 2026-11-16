# R10 plan review, round 7 (agy CLI, gemini-4-carbon-high, 2026-11-15)

Reviewed commit `f579d6c`. Verdict READY. Raw output, links made repo-relative. Its two non-blocking findings were taken afterwards; see `.ai/plans/r10-interactions-progress.md`, "Review history".

---

### Round-6 resolution check

All four findings from round 6 (one blocking, three non-blocking) are resolved in [.ai/plans/r10-interactions-progress.md](.ai/plans/r10-interactions-progress.md):
- **Blocking (`Referrer-Policy` vs. `Origin` on `/admin`):** Replaced `Referrer-Policy: no-referrer` with `Referrer-Policy: same-origin` ([:279-280](.ai/plans/r10-interactions-progress.md#L279-L280)), so same-origin `<form method="POST">` submissions send their tuple `Origin` header under the WHATWG Fetch Standard while cross-origin navigations (including clicking the authorization link) still omit `Referer`.
- **Non-blocking:** Sign-in starts are rate-limited per address ([:262-263](.ai/plans/r10-interactions-progress.md#L262-L263)); `afterOperation` after `reconcileWorkspace` unregisters inactive inboxes only when registered ([:122-124](.ai/plans/r10-interactions-progress.md#L122-L124)); and new R10a/R10c acceptance/browser specs plus `@flock/webhooks` are wired into root `package.json` ([:383-384](.ai/plans/r10-interactions-progress.md#L383-L384)).

---

### 1. Fit with the code as built

- **NON-BLOCKING** (`verified`) — **Plan section:** `## Design → ### The app inbox → Lifecycle` ([.ai/plans/r10-interactions-progress.md:81-84](.ai/plans/r10-interactions-progress.md#L81-L84), [:106-111](.ai/plans/r10-interactions-progress.md#L106-L111)), `## Steps → ### R10a` ([:337](.ai/plans/r10-interactions-progress.md#L337)).
  - **Code:** [apps/operator/src/operator/kinds/app-access.test.ts:89](apps/operator/src/operator/kinds/app-access.test.ts#L89), [:219-238](apps/operator/src/operator/kinds/app-access.test.ts#L219-L238); [protocol-tests/apps.test.ts:21-24](protocol-tests/apps.test.ts#L21-L24), [:41-54](protocol-tests/apps.test.ts#L41-L54); [apps/operator/src/operator/journal.ts:141-151](apps/operator/src/operator/journal.ts#L141-L151).
  - **Why wrong/missing:** Placing `app-inbox-space` before `app-install-record` clashes with two existing R9 test setups that assume `app-install-record` is step 0 of `installApp`: `app-access.test.ts:89` asserts the first write is `putRecord ... new.flock.app.install/`, and both `app-access.test.ts:222-223` and `protocol-tests/apps.test.ts:21-22` simulate a pre-R9 authority grant by withholding only `new.flock.app.install` while leaving `authorityClientMetadata().scope`'s new `space:new.flock.app.inbox` token granted. Under the R10 step order, `app-inbox-space` completes first (`completedSteps = ["app-inbox-space"]`), so when `app-install-record` hits `ScopeMissingError`, `journal.ts:141` (`completedSteps.length === 0`) keeps the row `pending` instead of discarding it, failing `rowAfterRefusal === undefined` (`app-access.test.ts:235`, `apps.test.ts:52`).
  - **Recommended change:** Update those two pre-R9 test fixtures in R10a to withhold `space:new.flock.app.inbox` alongside `new.flock.app.install` (as a real pre-R9 grant lacked both) and update `app-access.test.ts:89` for `createSpace` preceding `putRecord`.

- **NON-BLOCKING** (`verified`) — **Plan section:** `## Design → ### The app's SDK` ([.ai/plans/r10-interactions-progress.md:211-212](.ai/plans/r10-interactions-progress.md#L211-L212)).
  - **Code:** [packages/client/src/channel-client.ts:150](packages/client/src/channel-client.ts#L150), [:172](packages/client/src/channel-client.ts#L172), [:308-313](packages/client/src/channel-client.ts#L308-L313); [packages/client/src/channel-client.test.ts:61-70](packages/client/src/channel-client.test.ts#L61-L70), [:211-220](packages/client/src/channel-client.test.ts#L211-L220); [packages/client/src/engine.ts:27-40](packages/client/src/engine.ts#L27-L40).
  - **Why wrong/missing:** Lines 211–212 state that an app's own write is applied to the local store only for a channel it follows for messages. In `ChannelClient`, member callers and `channel-client.test.ts:61, 216` call `channels.send` on a channel *before* `readPage` has ever opened it in `SyncCore`, relying on `applyOwnWrite` to surface the own write during authority `listRepos` lag. Gating `applyOwn` inside `ChannelClient` on `sync.opened` would break that contract.
  - **Recommended change:** Keep `applyOwnWrite` enabled by default for member engines and gate it via an explicit `createEngine` / `ChannelClient` option (or predicate) set by `runApp` and `apps/webhooks`.

---

### 2. Protocol feasibility on the pinned Spaces revision

Sound on the stated `d4def6e` baseline (and `5d88b414` fallback):
- **Verified in repository code and tests (`5d88b414`):** `{ read: false, write: true }` member writes into own repo, `notifyWrite` → `listRepos` tracking, and read-credential refusal (`SpaceNotFound`) ([protocol-tests/atproto/slack-inbox-conformance.test.ts:114-203](protocol-tests/atproto/slack-inbox-conformance.test.ts#L114-L203)); `{ read: true, write: false }` non-authority app reads while its own writes stay out of `listRepos` ([protocol-tests/apps.test.ts:56-98](protocol-tests/apps.test.ts#L56-L98)); implicit `authorityDid` access and omission from `listMembers`, plus absence of a space-archive XRPC ([docs/protocol/atproto-spaces-pin.md:110-121](docs/protocol/atproto-spaces-pin.md#L110-L121), [protocol-tests/atproto/slack-inbox-conformance.test.ts:204-215](protocol-tests/atproto/slack-inbox-conformance.test.ts#L204-L215), [apps/operator/src/operator/kinds/archive-channel.ts:21](apps/operator/src/operator/kinds/archive-channel.ts#L21), [:39-48](apps/operator/src/operator/kinds/archive-channel.ts#L39-L48)); `getSpace` owner `read_self` scope requirement, `SpaceNotFound`, and `ScopeMissingError` ([packages/protocol/lexicons/com/atproto/space/getSpace.json:7](packages/protocol/lexicons/com/atproto/space/getSpace.json#L7), [:42](packages/protocol/lexicons/com/atproto/space/getSpace.json#L42), [packages/protocol/src/atproto/xrpc.ts:65-67](packages/protocol/src/atproto/xrpc.ts#L65-L67)); 105-character colon-delimited `appInboxUri` skey under `isSkey`'s 128-character limit ([packages/protocol/src/keys.ts:12](packages/protocol/src/keys.ts#L12), [:30-32](packages/protocol/src/keys.ts#L30-L32)); and member, app, and collectionless authority `space:` scope strings, permission-set parity, and PDS `authority=self` / read-collection expansion once `workspace.json` includes `new.flock.app.install` ([packages/protocol/src/scopes.ts:10-86](packages/protocol/src/scopes.ts#L10-L86), [packages/protocol/src/scope-lexicons.test.ts:39-73](packages/protocol/src/scope-lexicons.test.ts#L39-L73), [packages/protocol/lexicons/new/flock/workspace.json:9](packages/protocol/lexicons/new/flock/workspace.json#L9), [apps/web/src/browser/session.test.ts:64-80](apps/web/src/browser/session.test.ts#L64-L80), [protocol-tests/atproto/slack-authority-oauth-conformance.test.ts:82-211](protocol-tests/atproto/slack-authority-oauth-conformance.test.ts#L82-L211)).
- **Assumed (and gated in R10a):** combining `{ read: false, write: true }` writers and a `{ read: true, write: false }` non-authority app reader in the same space with no non-owner admins ([.ai/plans/r10-interactions-progress.md:340-341](.ai/plans/r10-interactions-progress.md#L340-L341), [:403-404](.ai/plans/r10-interactions-progress.md#L403-L404)), D6's `d4def6e` migration (`putMembers`/`removeMembers`, `authorizeSpaceSync` notice registration, `title` on space declarations), and 20-install / 200-member envelope latency ([:20-28](.ai/plans/r10-interactions-progress.md#L20-L28), [:346-347](.ai/plans/r10-interactions-progress.md#L346-L347), [:405](.ai/plans/r10-interactions-progress.md#L405)).

---

### 3. Security

Sound — inbox read/write isolation, active-install-only plain-text block rendering, value-free clicks verified against MAC-checked own messages and fresh workspace/private-roster grants, pre-roster inbox eviction and per-author throttling, and the webhooks app's separate identity-only OAuth flow, `SameSite=Lax` + `Referrer-Policy: same-origin` + `Origin` + CSRF admin controls, hashed secrets, constant-time pre-validation secret check, synchronous body check, and fresh write-grant check close every reviewed attack vector.

---

### 4. Completeness and order

Sound — R10a → R10b → R10c step ordering, pre-R10 install and authority-grant reconciliation, diff-on-entry multi-call steps, notice registration/unregistration hooks, root test-runner wiring, and unit/acceptance/browser/BDD gates are complete and properly ordered.

---

### 5. Simplicity

Sound — the per-install inbox reuse of the join-request pattern, shared `key-window.ts`, synchronous `validateMessageInput`, exact `space:` scope check, and zero-JS webhooks admin page add nothing beyond what the goal needs.

VERDICT: READY
