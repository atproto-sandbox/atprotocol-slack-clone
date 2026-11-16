# R10 plan review, round 6 (agy CLI, gemini-4-carbon-high, 2026-11-15)

Reviewed commit `76dbeb1`. Raw output, links made repo-relative. Each finding was checked; the outcome is in `.ai/plans/r10-interactions-progress.md`, "Review history".

---

### Round-5 resolution check

All five findings from round 5 (two blocking, three non-blocking) are resolved in [.ai/plans/r10-interactions-progress.md](.ai/plans/r10-interactions-progress.md):
- `updateAppAccess` now runs `app-inbox-space` then `app-access-record` then `app-inbox-set` and declares the inbox in `createsSpaces`, while `afterOperation` after `reconcileWorkspace` registers any present, unregistered active inbox using the operation's `RegistrationDeps` ([:105-109](.ai/plans/r10-interactions-progress.md#L105-L109), [:119-124](.ai/plans/r10-interactions-progress.md#L119-L124), [:326-328](.ai/plans/r10-interactions-progress.md#L326-L328), [:341-342](.ai/plans/r10-interactions-progress.md#L341-L342)).
- `runApp` follows active inboxes only when `onCommand` or `onAction` is given ([:189-190](.ai/plans/r10-interactions-progress.md#L189-L190)), and `onAction` checks the fresh `WorkspaceSummary` channel grant and receives `canWrite` ([:182-185](.ai/plans/r10-interactions-progress.md#L182-L185)).
- The webhooks admin sign-in replaces the off-site form redirect with a `200` link page, sets `SameSite=Lax` on both the flow-binding and session cookies, and runs R10c's gate in Chromium ([:257-266](.ai/plans/r10-interactions-progress.md#L257-L266), [:374-376](.ai/plans/r10-interactions-progress.md#L374-L376)). However, running that flow in real Chromium exposes one remaining header conflict between `Referrer-Policy: no-referrer` and the `Origin` check on HTML `<form method="POST">` submissions — see Section 3 below.

---

### 1. Fit with the code as built

Sound — every module, record, scope builder, sync path (`SyncCore` over two `window` collections, `Lifecycle`, `CredentialCache`, `isAccessLost` → `isSessionLost`), operator kind, lint boundary, and UI component fits the existing codebase cleanly.

---

### 2. Protocol feasibility on the pinned Spaces revision

Sound on the stated `d4def6e` baseline (and `5d88b414` fallback):
- **Verified in repository code and tests (`5d88b414`):** `{ read: false, write: true }` member writes, `notifyWrite` → `listRepos` tracking, and read-credential refusal (`SpaceNotFound`) ([protocol-tests/atproto/slack-inbox-conformance.test.ts:114-203](protocol-tests/atproto/slack-inbox-conformance.test.ts#L114-L203)); `{ read: true, write: false }` non-authority app reads while its own writes stay out of `listRepos` ([protocol-tests/apps.test.ts:56-98](protocol-tests/apps.test.ts#L56-L98)); implicit `authorityDid` reads and omission from `listMembers` ([docs/protocol/atproto-spaces-pin.md:116](docs/protocol/atproto-spaces-pin.md#L116)); `getSpace` owner `read_self` scope requirement ([packages/protocol/lexicons/com/atproto/space/getSpace.json:7](packages/protocol/lexicons/com/atproto/space/getSpace.json#L7)); 105-character `appInboxUri` skey under `isSkey`'s 128-character limit ([packages/protocol/src/keys.ts:12](packages/protocol/src/keys.ts#L12)); and member, app, and collectionless authority `space:` scope strings, permission-set parity, and PDS `authority=self` / read-collection expansion once `workspace.json` includes `new.flock.app.install` ([packages/protocol/src/scopes.ts:10-86](packages/protocol/src/scopes.ts#L10-L86), [packages/protocol/src/scope-lexicons.test.ts:39-73](packages/protocol/src/scope-lexicons.test.ts#L39-L73), [packages/protocol/lexicons/new/flock/workspace.json:9](packages/protocol/lexicons/new/flock/workspace.json#L9), [apps/web/src/browser/session.test.ts:64-80](apps/web/src/browser/session.test.ts#L64-L80), [protocol-tests/atproto/slack-authority-oauth-conformance.test.ts:82-211](protocol-tests/atproto/slack-authority-oauth-conformance.test.ts#L82-L211)).
- **Assumed (and gated in R10a):** combining `{ read: false, write: true }` writers and a `{ read: true, write: false }` non-authority reader in the same space with no non-owner admins ([.ai/plans/r10-interactions-progress.md:336-337](.ai/plans/r10-interactions-progress.md#L336-L337), [:397-398](.ai/plans/r10-interactions-progress.md#L397-L398)), D6's `d4def6e` migration (`putMembers`/`removeMembers`, `authorizeSpaceSync` notice registration, `title` on space declarations), and 20-install / 200-member envelope latency ([:21-27](.ai/plans/r10-interactions-progress.md#L21-L27), [:342-343](.ai/plans/r10-interactions-progress.md#L342-L343)).

---

### 3. Security

- **BLOCKING** (`verified`) — **Plan section:** `## Design → ### The webhooks app` ([.ai/plans/r10-interactions-progress.md:265-266](.ai/plans/r10-interactions-progress.md#L265-L266), [:273-278](.ai/plans/r10-interactions-progress.md#L273-L278)), `## Steps → ### R10c` ([:369](.ai/plans/r10-interactions-progress.md#L369), [:374-376](.ai/plans/r10-interactions-progress.md#L374-L376)).
  - **Code:** [packages/deployment/src/security-headers.ts:5](packages/deployment/src/security-headers.ts#L5).
  - **Why wrong/missing:** Line 277 locks the response header `Referrer-Policy: no-referrer` on the zero-JS admin page (pinned by the header unit test at `:369`), while lines 265 and 274 require an `Origin` check on every state-changing HTML `<form>` `POST` (`create`, `rotate`, `revoke`), and lines 374–376 gate R10c in real Chromium *"under the page's own policy and cookies"*. Under the WHATWG Fetch Standard (§ 3.1, *"append a request-origin header"*), any non-CORS, non-WebSocket request whose method is neither `GET` nor `HEAD` and whose referrer policy is `no-referrer` serializes its `Origin` header to `"null"` — **even on a same-origin `<form method="POST">`**. Chromium, Firefox, and Safari all implement this rule, so every `<form method="POST">` from `/admin` arrives with `Origin: null` and is rejected by `Origin === expectedOrigin` (whereas accepting `Origin: null` would defeat the `Origin` check, since cross-origin `<form referrerpolicy="no-referrer">` and sandboxed `<iframe>` submissions also send `Origin: null`, and a same-site sibling subdomain would also carry the `SameSite=Lax` session cookie).
  - **Recommended change:** Change `Referrer-Policy: no-referrer` on line 277 to `Referrer-Policy: same-origin` (or `strict-origin-when-cross-origin`, matching `security-headers.ts:5`). `Referrer-Policy: same-origin` still strips `Referer` completely on every cross-origin navigation (including clicking the `<a href>` link to the PDS authorization page), while sending the real tuple `Origin` header on same-origin `<form method="POST">` submissions so the server can strictly require `Origin === expectedOrigin`.

- **NON-BLOCKING** (`verified`) — **Plan section:** `## Design → ### The webhooks app` ([.ai/plans/r10-interactions-progress.md:257-261](.ai/plans/r10-interactions-progress.md#L257-L261), [:282](.ai/plans/r10-interactions-progress.md#L282)).
  - **Code:** [apps/operator/src/operator/methods.ts:192](apps/operator/src/operator/methods.ts#L192); [apps/operator/src/operator/authority-grant.ts:129-140](apps/operator/src/operator/authority-grant.ts#L129-L140).
  - **Why wrong/missing:** Unlike the operator's `/authority/start` (which requires a single-use ticket issued to an authenticated caller via `startAuthorityFlow`, `methods.ts:192`), the webhooks admin sign-in `<form>` is unauthenticated, triggers outbound handle/DID resolution via `@flock/net`, and refuses new sign-ins once 100 pending states are held (`:261`). Without a per-address rate limit on starting sign-in (like `POST /hooks`'s per-address rate limit at `:282`), a single unauthenticated client can send 100 rapid `POST`s to exhaust the pending-state cap and block admin sign-ins for ten minutes.
  - **Recommended change:** Rate-limit sign-in `POST`s per address alongside the hook endpoint's per-address limiter.

---

### 4. Completeness and order

- **NON-BLOCKING** (`verified`) — **Plan section:** `## Design → ### The app inbox → Notices and the feed` ([.ai/plans/r10-interactions-progress.md:120-124](.ai/plans/r10-interactions-progress.md#L120-L124)).
  - **Code:** [apps/operator/src/operator/registrations.ts:60-70](apps/operator/src/operator/registrations.ts#L60-L70), [:102-107](apps/operator/src/operator/registrations.ts#L102-L107), [:189-193](apps/operator/src/operator/registrations.ts#L189-L193); [apps/operator/src/operator/member-access.ts:24-27](apps/operator/src/operator/member-access.ts#L24-L27); [apps/web/src/app/ui/workspace-manager.tsx:262-269](apps/web/src/app/ui/workspace-manager.tsx#L262-L269).
  - **Why wrong/missing:** Line 121–122 checks `present` and `!isRegisteredSpace(inbox)` before registering an active install's inbox after `reconcileWorkspace`, whereas for inactive installs it says *"and drops the registration of every inactive one"* without gating on `isRegisteredSpace(inbox)`. Because `workspace-manager.tsx:268` runs `reconcileWorkspace` every five minutes while an admin tab is open, calling `unregisterSpace` unconditionally on every historical inactive install will attempt `deps.unregister` at the authority's PDS every five minutes for inboxes already unregistered or never created.
  - **Recommended change:** Gate the inactive-install branch in `afterOperation` on `isRegisteredSpace(inbox)` (symmetric with `!isRegisteredSpace(inbox)` for active installs).

- **NON-BLOCKING** (`verified`) — **Plan section:** `## Steps → ### R10a` ([.ai/plans/r10-interactions-progress.md:336](.ai/plans/r10-interactions-progress.md#L336)), `### R10c` ([:374](.ai/plans/r10-interactions-progress.md#L374), [:379](.ai/plans/r10-interactions-progress.md#L379)).
  - **Code:** [package.json:22-23](package.json#L22-L23), [:39-45](package.json#L39-L45).
  - **Why wrong/missing:** Unlike `pnpm test` (`package.json:17`), `test:acceptance` (`package.json:22`) and `test:browser` (`package.json:23`) enumerate each test file explicitly rather than using globs, and root `dependencies` (`package.json:39-45`) must list `@flock/webhooks` for `protocol-tests/` under `eslint.config.mjs:58-63`. Any new acceptance or browser spec file created in R10a or R10c will be skipped by `pnpm test:acceptance` / `pnpm test:browser` (`:379`) unless added to those script lists.
  - **Recommended change:** Add new R10a/R10c acceptance and browser spec paths (and `@flock/webhooks`) to root `package.json` when wiring those gates.

---

### 5. Simplicity

Sound — the R10a → R10b → R10c split, shared `key-window.ts`, synchronous `validateMessageInput`, exact `space:` scope coverage check, and zero-JS webhooks admin page add nothing beyond what the goal requires.

VERDICT: REVISE
