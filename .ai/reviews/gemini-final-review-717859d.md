# Final review of feat/platform-refactor at 717859d (agy CLI 1.5.5, gemini-4-carbon-high, 2026-11-15)

Raw output, links made repo-relative. Each finding was checked against the code before acting; the outcome is in `.ai/plans/platform-refactor.md`, "Final review".

---

## Findings

No critical findings were identified.

---

### High

#### 1. Scheduled reconciliation fails on every run for R8 dedicated-account workspaces — **verified**
- **Where:** [apps/operator/scripts/reconcile-workspaces.ts:36](../../apps/operator/scripts/reconcile-workspaces.ts#L36), [apps/operator/scripts/reconcile-workspaces.ts:47](../../apps/operator/scripts/reconcile-workspaces.ts#L47) (with [apps/operator/src/operator/kinds/create-workspace.ts:140-141](../../apps/operator/src/operator/kinds/create-workspace.ts#L140-L141) and [apps/operator/src/operator/security.ts:93-97](../../apps/operator/src/operator/security.ts#L93-L97))
- **Code:**
  ```ts
  if (mutationsPaused) {
    await requireActiveWorkspaceAdmin(workspace.uri, workspace.authorityDid);
    ...
  }
  const session = await restoreAuthorityGrant(workspace.authorityDid);
  ...
  const actor = await requireActiveWorkspaceAdmin(workspace.uri, session.did);
  await assertOperatorWorkspaceWithinEnvelope(actor);
  const operation = await executeOperatorOperation(actor, tidNow(), { kind: "reconcileWorkspace" }, registrationDeps);
  ```
- **Why it is wrong:** When a workspace is created under a dedicated account (`creator !== authorityDid`), `createWorkspace` writes `workspaceRoster` and `admin` records only for `creator`, never for `authorityDid`. In `reconcile-workspaces.ts`, both the paused check (`line 36`) and the active run (`line 47`) pass `workspace.authorityDid` (`session.did`) to `requireActiveWorkspaceAdmin`, which requires active `admin` and `workspaceRoster` records for that DID and throws `OperatorAuthError("Actor is not an active workspace admin.")`. Concrete sequence: create a workspace under a dedicated account via R8's flow and run `corepack pnpm reconcile` (paused or unpaused). Every 1-minute cron execution logs `${workspace.uri}: reconciliation failed (OperatorAuthError).` to `stderr`, exits `1` (triggering continuous operator alerts), and never reaches `executeOperatorOperation(..., { kind: "reconcileWorkspace" })` — so stalled post-creation operations and drifted member lists on dedicated-account workspaces are never reconciled in the background. R8's acceptance subtest ([protocol-tests/authority-grant.test.ts:62-108](../../protocol-tests/authority-grant.test.ts#L62-L108)) missed this because only the earlier self-owned subtests ([protocol-tests/authority-grant.test.ts:231](../../protocol-tests/authority-grant.test.ts#L231)) invoke `runReconcileJob`.
- **Smallest fix:** Add an operator-internal helper in `security.ts` (for `reconcile-workspaces.ts` only) that restores `authorityDid`'s grant and verifies `await spaceExists(session, workspace.uri)` without requiring `admin`/`workspaceRoster` records for `session.did`, use it in both branches of `reconcile-workspaces.ts`, and call `runReconcileJob` in the R8 subtest.

#### 2. Browser CSP retains `script-src 'unsafe-inline'` over the type-wide OAuth grant and 30-day message store, and widens `connect-src` if `APP_URL` is unset at build time — **verified**
- **Where:** [packages/deployment/src/security-headers.ts:18](../../packages/deployment/src/security-headers.ts#L18), [packages/deployment/src/security-headers.ts:36-44](../../packages/deployment/src/security-headers.ts#L36-L44), [apps/web/next.config.ts:20-22](../../apps/web/next.config.ts#L20-L22)
- **Code:**
  ```ts
  value: `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline'; ... ${connectSrc()}`,
  ...
  function connectSrc(): string {
    const raw = process.env.APP_URL ?? "http://127.0.0.1:3000";
    ...
    return loopbackHttp ? "connect-src 'self' https: http://localhost:* http://127.0.0.1:* http://[::1]:*" : "connect-src 'self' https:";
  }
  ```
- **Why it is wrong:**
  1. R6 moved `memberGrantScopes` ([packages/protocol/src/scopes.ts:49-55](../../packages/protocol/src/scopes.ts#L49-L55) — `authority=*` read/write across every workspace, channel, inbox, and DM space plus all operator XRPC methods) and 30 days of synced channel records (`flock-sync-<did>` in IndexedDB) into the browser. With `'unsafe-inline'` in `script-src` and `connect-src 'self' https:`, any HTML/DOM injection executes inline script immediately, reads every cached workspace/channel/DM record, signs DPoP requests via the live OAuth session, and exfiltrates over any HTTPS origin.
  2. Next.js evaluates `nextConfig.headers()` once during `next build` and bakes the static header string into `routes-manifest.json`. If a CI/container image runs `pnpm build` without `APP_URL` set and supplies `APP_URL=https://...` only at `pnpm start`, `connectSrc()` falls back to `"http://127.0.0.1:3000"` and permanently ships `http://localhost:* http://127.0.0.1:* http://[::1]:*` in production `connect-src`.
- **Smallest fix:** Move the web app's `Content-Security-Policy` to `apps/web/src/middleware.ts` with a per-request cryptographic nonce (`script-src 'self' 'nonce-...' 'strict-dynamic'`; [apps/web/src/app/page.tsx:7](../../apps/web/src/app/page.tsx#L7) is already `force-dynamic`), and compute `connectSrc()` at request time (or default to `"connect-src 'self' https:"` whenever `APP_URL` is unset under `NODE_ENV === "production"`).

---

### Medium

#### 3. `@flock/client/node/oauth` treats any `http:` URL as loopback, disabling HTTPS and SSRF loopback checks — **verified**
- **Where:** [packages/client/src/node/oauth.ts:40](../../packages/client/src/node/oauth.ts#L40), [packages/client/src/node/oauth.ts:66-71](../../packages/client/src/node/oauth.ts#L66-L71) (introduced in `49bacca` / R9b; see also [apps/echo-bot/src/main.ts:40](../../apps/echo-bot/src/main.ts#L40))
- **Code:**
  ```ts
  if (new URL(config.appUrl).protocol === "http:") {
    return {
      ...common,
      client_id: `http://localhost?${new URLSearchParams({ scope: config.scope, redirect_uri: redirectUri }).toString()}`,
      ...
    };
  }
  ...
  const loopback = new URL(config.appUrl).protocol === "http:";
  return new NodeOAuthClient({
    ...
    allowHttp: loopback,
    fetch: safeFetch(() => loopback),
  ```
- **Why it is wrong:** While `apps/echo-bot/src/config.ts:27-28` rejects non-loopback `http:` URLs, `@flock/client/node/oauth` is the public SDK entry for third-party Node apps. If a third-party app passes a non-loopback `http:` URL (e.g., `appUrl: "http://bot.internal:8787"` behind an ingress proxy), `appOAuthClient` sets `loopback = true` instead of rejecting it: `safeFetch(() => true)` permits plain-HTTP requests and connections to `127.0.0.1`, `::1`, and `localhost` on the bot host when resolving attacker-supplied DID/PDS/auth-server metadata, and `appClientMetadata` emits an invalid `http://localhost?...` public client ID with a non-loopback `redirect_uri`.
- **Smallest fix:** Validate `new URL(config.appUrl)` in `appClientMetadata` (called by `appOAuthClient`): require `protocol === "https:"` unless `protocol === "http:" && (hostname === "127.0.0.1" || hostname === "[::1]")`, throw otherwise, and derive `loopback` from that check.

#### 4. `AppRuntime` delivers another app's messages if a workspace summary read fails transiently or workspace cursor order flips after `defer` — **verified**
- **Where:** [packages/client/src/app-runtime.ts:223-227](../../packages/client/src/app-runtime.ts#L223-L227), [packages/client/src/app-runtime.ts:296-300](../../packages/client/src/app-runtime.ts#L296-L300), [packages/client/src/feed.ts:104-118](../../packages/client/src/feed.ts#L104-L118), [packages/client/src/feed.ts:143-163](../../packages/client/src/feed.ts#L143-L163)
- **Code:**
  ```ts
  // packages/client/src/feed.ts:108-118
  try {
    await this.deps.sync(space);
  } catch (error) {
    result.failed.push({ space, error });
    return;
  }
  ...
  for (const { space, cursor } of answer.changed) await syncTo(space, cursor);

  // packages/client/src/app-runtime.ts:296-298
  const apps = this.apps.get(grant.channel.workspace) ?? new Set<string>();
  for (const message of fresh.sort((left, right) => left.rkey.localeCompare(right.rkey))) {
    if (deliver && !apps.has(message.repo)) {
  ```
- **Why it is wrong:** `AppRuntime` suppresses app-to-app loops solely via `this.apps.get(grant.channel.workspace)`, updated only when `readGrants(workspace)` runs. Two sequences violate the R9b rule (*"Two apps never answer each other: an app is given no app's message"*):
  1. App A follows `[W, #general]`. An admin installs App B (`write: true` in `#general`) and App B posts a message. `getChanges` returns `changed: [W, #general]`. If `syncTo(W)` (`workspaces.summary`) hits a transient network/502 error, `ChangeFollower.poll` records `failed` and immediately continues to `syncTo(#general)`. `readChannel` reads `#general`'s live writer list (which already includes App B) against the stale `this.apps.get(W)` (which lacks App B) and delivers App B's message to App A's `onMessage`.
  2. If `W` is ever temporarily `deferred` (`feed.ts:144` deletes `W` from `this.cursors`) and re-followed 60 s later (`feed.ts:69` re-inserts `W` after `#general` in `this.cursors`), `[...this.cursors]` and `readNotices` ([apps/operator/src/operator/notices.ts:80-84](../../apps/operator/src/operator/notices.ts#L80-L84)) return `#general` *before* `W` on every subsequent poll, syncing `#general` before `readGrants(W)` updates `this.apps`.
- **Smallest fix:** Ensure `ChangeFollower.poll` / `AppRuntime` syncs workspace spaces before their channels in every poll batch, and if a workspace's `readGrants` failed (or `readChannel` sees a message author not in the last known human roster or `apps` set of `grant.channel.workspace`), refresh `readGrants(grant.channel.workspace)` before delivering — letting `readChannel` throw if that refresh fails so the channel cursor is retried rather than delivered with stale `apps`.

#### 5. `AppsPanel` leaks `removing`, `editing`, and `access` state across workspace switches and wedges when a selected channel archives or transitions — **verified**
- **Where:** [apps/web/src/app/ui/apps-panel.tsx:29-32](../../apps/web/src/app/ui/apps-panel.tsx#L29-L32), [apps/web/src/app/ui/apps-panel.tsx:59](../../apps/web/src/app/ui/apps-panel.tsx#L59), [apps/web/src/app/ui/apps-panel.tsx:79](../../apps/web/src/app/ui/apps-panel.tsx#L79), [apps/web/src/app/ui/workspace-home.tsx:45](../../apps/web/src/app/ui/workspace-home.tsx#L45) (commits `56b2fea` and `16ccc98`)
- **Code:**
  ```tsx
  // workspace-home.tsx:45
  <AppsPanel activeWorkspace={activeWorkspace} busy={busy} workspaceDegraded={workspaceDegraded} runOperation={runOperation} apps={apps} setError={setError} />

  // apps-panel.tsx:32, 59, 79
  const channels = activeWorkspace.channels.filter((channel) => channel.visibility === "public" || channel.visibility === "private");
  ...
  const grants = Object.entries(access).filter(([, level]) => level !== "none").map(([skey, level]) => ({ skey, write: level === "write" }));
  ...
  {removing && <div className="roster-row" role="alert">...<button ... onClick={() => { void runOperation({ kind: "uninstallApp", subject: removing }); setRemoving(null); }}>Remove app</button>...</div>}
  ```
- **Why it is wrong:**
  1. Neither `<WorkspaceHome>` nor `<AppsPanel>` is keyed by `activeWorkspace.uri`. If an admin clicks `Remove` on `did:plc:bot` in Workspace A (`removing = "did:plc:bot"`), switches to Workspace B in the sidebar where `did:plc:bot` is also installed, and clicks `Remove app` on the still-visible alert, `runOperation` ([apps/web/src/app/ui/workspace-manager.tsx:287](../../apps/web/src/app/ui/workspace-manager.tsx#L287)) targets `activeWorkspace?.uri` (Workspace B) and uninstalls the app from the wrong workspace. Likewise `editing` and `access` carry over into Workspace B.
  2. `channels` (`line 32`) hides `transitioning` and `archived` channels from the `<select>` controls, but `grants` (`line 59`) builds the request from `Object.entries(access)`. If an admin selects `#temp` (or clicks `Change access` on an app granted `#temp`) and `#temp` transitions or is archived before submit, `submit` sends `#temp`'s `skey`, the operator rejects `"Only an active channel can be granted to an app."` ([apps/operator/src/operator/kinds/app-access.ts:85](../../apps/operator/src/operator/kinds/app-access.ts#L85)), `16ccc98` preserves `access`, and no `<select>` exists to deselect `#temp`.
- **Smallest fix:** Add `key={activeWorkspace.uri}` to `<AppsPanel>` in `workspace-home.tsx:45`, and derive `grants` in `apps-panel.tsx:59` from `channels` (`channels.flatMap(({ skey }) => access[skey] && access[skey] !== "none" ? [{ skey, write: access[skey] === "write" }] : [])`).

#### 6. `@flock/net/safe-fetch` blocklist omits RFC 6052 Well-Known NAT64 (`64:ff9b::/96`), 6to4 (`2002::/16`), and Teredo (`2001::/32`) IPv6 ranges — **verified**
- **Where:** [packages/net/src/safe-fetch.ts:137-150](../../packages/net/src/safe-fetch.ts#L137-L150)
- **Code:**
  ```ts
  ["::1", 128, "ipv6"], ["::ffff:0:0", 96, "ipv6"], ["64:ff9b:1::", 48, "ipv6"],
  ["100::", 64, "ipv6"], ["2001:db8::", 32, "ipv6"], ["fc00::", 7, "ipv6"],
  ["fe80::", 10, "ipv6"], ["ff00::", 8, "ipv6"],
  ```
- **Why it is wrong:** `makeNonPublicAddressList()` blocks local-use NAT64 (`64:ff9b:1::/48`) and IPv4-mapped IPv6 (`::ffff:0:0/96`), but omits the RFC 6052 Well-Known NAT64 prefix `64:ff9b::/96` as well as 6to4 (`2002::/16`), Teredo (`2001::/32`), benchmarking (`2001:2::/48`), IPv4-compatible (`::/96`), and 6to4 relay anycast (`192.88.99.0/24`). In dual-stack cloud VPCs with NAT64 enabled, an attacker-controlled `did:web` or PDS domain returning `AAAA 64:ff9b::a9fe:a9fe` or `64:ff9b::a00:1` passes `nonPublicAddresses.check` and routes through the NAT64 gateway to `169.254.169.254` or RFC 1918 hosts.
- **Smallest fix:** Add `["64:ff9b::", 96, "ipv6"]`, `["2002::", 16, "ipv6"]`, `["2001::", 32, "ipv6"]`, `["2001:2::", 48, "ipv6"]`, `["::", 96, "ipv6"]`, and `["192.88.99.0", 24, "ipv4"]` to `makeNonPublicAddressList()`.

#### 7. Operator `/xrpc` CORS admits only `APP_URL`, blocking third-party browser apps — **verified**
- **Where:** [apps/operator/src/operator/server.ts:32](../../apps/operator/src/operator/server.ts#L32), [apps/operator/src/operator/server.ts:151-166](../../apps/operator/src/operator/server.ts#L151-L166)
- **Code:**
  ```ts
  app.use("/xrpc", allowWebOrigin(appUrl.origin));
  ...
  if (req.headers.origin === origin) {
    res.set("access-control-allow-origin", origin);
  ```
- **Why it is wrong:** Every `/xrpc` method authenticates exclusively via `Authorization: Bearer <service-jwt>` ([apps/operator/src/operator/methods.ts:44-125](../../apps/operator/src/operator/methods.ts#L44-L125)) and reads no cookies (the authority flow cookie is `Path=/authority/callback` at `server.ts:132`). Restricting `/xrpc` preflights to `appUrl.origin` does not add CSRF protection — bearer headers already force a preflight and omit ambient credentials — but prevents any independent browser client on another origin from calling `getChanges`, `execute`, or `createWorkspace`.
- **Smallest fix:** Serve `Access-Control-Allow-Origin: *` (with no `Access-Control-Allow-Credentials` and no `Vary: Origin`) on `/xrpc`, while keeping `/authority/*` without CORS.

---

### Low

#### 8. Ended, crashed, or re-consented browser sessions leave DM metadata in `localStorage` and expired-session records in `IndexedDB` — **verified**
- **Where:** [apps/web/src/browser/use-browser-session.ts:65](../../apps/web/src/browser/use-browser-session.ts#L65), [apps/web/src/browser/use-browser-session.ts:111-115](../../apps/web/src/browser/use-browser-session.ts#L111-L115), [apps/web/src/app/ui/account-gate.tsx:22-25](../../apps/web/src/app/ui/account-gate.tsx#L22-L25), [packages/client/src/dm/browser-store.ts:56-71](../../packages/client/src/dm/browser-store.ts#L56-L71)
- **Code:**
  ```ts
  // use-browser-session.ts:65
  await within(IndexedDbStore.deleteOtherAccounts(did), ERASE_WITHIN_MS).catch(() => undefined);
  ...
  // use-browser-session.ts:111-115
  // The session lacks a scope the app asks for. It is revoked first, so if another account is chosen at the host,
  // nothing of this one is left behind.
  await revoke({ appUrl, plcUrl, scope, serviceRef, operatorUrl, loopback }).catch(() => undefined);
  await signIn(did, { appUrl, plcUrl, scope, serviceRef, operatorUrl, loopback });
  ```
- **Why it is wrong:** When Account A's session ends without `signOutAccount` (browser crash, token expiry/revocation at the PDS, or scope-upgrade `connect()` where Account B is chosen at the host): (1) Account B signing in deletes `flock-sync-<didA>` from IndexedDB (`line 65`) but leaves `dm:<didA>:*` in `localStorage` forever (`renotify:<convKey>:<participantDid>` and `hidden-request:<atUri>`, which expose DM participant DIDs and timestamps); and (2) if nobody signs back in after token expiry (`AccountGate` gets `did === null` or a session error), `flock-sync-<didA>` (up to 30 days of private channel messages) and `dm:<didA>:*` both remain on disk.
- **Smallest fix:** Add `forgetOtherBrowserDmStores(keepDid?: string)` in `browser-store.ts`, call it alongside `IndexedDbStore.deleteOtherAccounts(did)` in `use-browser-session.ts:65`, and erase all leftover `flock-sync-*` and `dm:*` stores when `AccountGate` observes no active session (`did === null` or non-`ClientUnavailableError`).

#### 9. Retrying an already-completed `endsOwnRole` operation fails with `503 Busy` or `409` degraded when other workspace work is pending, and runs authority scans indefinitely — **verified**
- **Where:** [apps/operator/src/operator/methods.ts:101-103](../../apps/operator/src/operator/methods.ts#L101-L103), [apps/operator/src/operator/operations.ts:37-40](../../apps/operator/src/operator/operations.ts#L37-L40), [apps/operator/src/operator/security.ts:144-145](../../apps/operator/src/operator/security.ts#L144-L145) (commit `eb82ba6`)
- **Code:**
  ```ts
  const pending = listRecoverableOperations(actor.workspace.authorityDid, actor.workspace.uri).filter((row) => !current(row));
  if (actor.canRecoverOperations) await resumeRecoverableOperations(actor, operationId, registration);
  else if (pending.length > 0) throw new OperationBusyError("Pending admin operations must be recovered by an active admin before member leave can proceed.");
  const view = await runJournaledOperation(actor, operationId, request, kind.steps, (context) => kind.run(actor, context, request));
  ```
- **Why it is wrong:** If a member submits `leaveWorkspace` (or self-removal/demotion), the operator completes it, the HTTP response is lost, and an admin concurrently starts another operation that remains `pending` (or pushes the workspace over envelope), the member's retry of that `operationId` passes `authorizeSubmittedOperation` (`canRecoverOperations: false`), runs 5 bounded authority scans in `assertOperatorWorkspaceWithinEnvelope` (`methods.ts:102`), and throws `OperationBusyError` (`503`) at `operations.ts:39` *before* `runJournaledOperation` ([apps/operator/src/operator/journal.ts:86](../../apps/operator/src/operator/journal.ts#L86)) can return the recorded `completed` `OperationView`. Also, because `hasJournaledOperation` never ages out completed rows, a long-removed member can replay their old `operationId` at any time to trigger 5 authority collection scans and acquire `workspace_lock`.
- **Smallest fix:** Short-circuit already-`completed` journal rows (matching `actor.did`, `operationId`, and `requestHash`) in `execute` before `assertOperatorWorkspaceWithinEnvelope`, `pending.length > 0`, and `workspace_lock`.

#### 10. `@flock/client/node/oauth` and `echo-bot` expose `/oauth/callback` during `run`, never expire or atomically consume `states`, and do not check the signed-in DID — **verified**
- **Where:** [packages/client/src/node/oauth.ts:82-88](../../packages/client/src/node/oauth.ts#L82-L88), [packages/client/src/node/oauth.ts:109-118](../../packages/client/src/node/oauth.ts#L109-L118), [apps/echo-bot/src/main.ts:28-34](../../apps/echo-bot/src/main.ts#L28-L34), [apps/echo-bot/src/main.ts:39](../../apps/echo-bot/src/main.ts#L39), [apps/echo-bot/src/main.ts:77-86](../../apps/echo-bot/src/main.ts#L77-L86)
- **Code:**
  ```ts
  // oauth.ts:82-88
  export async function answerAppOAuthRoute(client: NodeOAuthClient, url: URL) {
    ...
    if (url.pathname !== APP_OAUTH_PATHS.callback) return null;
    const { session } = await client.callback(url.searchParams);
    return { status: 200, type: "text/plain; charset=utf-8", body: `Signed in as ${session.did}. This page can be closed.`, session };
  }
  ```
- **Why it is wrong:** During `echo-bot run`, `serve(client, settings.port)` (`main.ts:39`) listens on `0.0.0.0` for any HTTP method and keeps `/oauth/callback` live alongside `/oauth/client-metadata.json` and `/oauth/jwks.json`. `StateFile.store("states")` (`oauth.ts:109-118`) neither expires abandoned states nor consumes them atomically on read (`get` reads without deleting), so an abandoned `sign-in` state remains completable indefinitely during `run`, and `signIn(account)` (`main.ts:77-86`) accepts whatever `session.did` comes back (for example if `account` was passed as a PDS host URL and a different account approved).
- **Smallest fix:** Restrict `serve` to `GET`, serve `/oauth/callback` only during `sign-in`, consume `states` atomically on `get` with a 30-minute TTL in `StateFile`, and verify `session.did` when `sign-in` was given a DID or handle.

---

## The Three Unmet Plan Amendments ([.ai/plans/platform-refactor.md:509-512](../../.ai/plans/platform-refactor.md#L509-L512))

1. **R6 script policy (`script-src` without `'unsafe-inline'`):** **Confirmed unmet — High severity now.** [packages/deployment/src/security-headers.ts:18](../../packages/deployment/src/security-headers.ts#L18) still serves `script-src 'self' 'unsafe-inline'` while the browser now holds the full wildcard member + DM OAuth grant and 30-day IndexedDB message cache (Finding 2).
2. **R7 CORS rule (any origin, without credentials, for service-token-authenticated methods):** **Confirmed unmet — Medium severity now.** [apps/operator/src/operator/server.ts:32](../../apps/operator/src/operator/server.ts#L32) (`allowWebOrigin(appUrl.origin)`) restricts `/xrpc` CORS to `APP_URL`. Not a security exposure, but blocks any third-party browser app from calling the operator (Finding 7).
3. **R8 scheduled reconcile job for a workspace whose authority has no admin record:** **Confirmed unmet — High severity now.** [apps/operator/scripts/reconcile-workspaces.ts:36](../../apps/operator/scripts/reconcile-workspaces.ts#L36) and [47](../../apps/operator/scripts/reconcile-workspaces.ts#L47) call `requireActiveWorkspaceAdmin` on `workspace.authorityDid` / `session.did`, failing every scheduled reconcile run with exit code `1` whenever a dedicated-account workspace exists in the journal (Finding 1).

---

## Plan "Outcome" Claims vs. Code and Tests

- **R9b Outcome ([.ai/plans/platform-refactor.md:1114](../../.ai/plans/platform-refactor.md#L1114)) — *"Two apps never answer each other: an app is given no app's message"*:** Does not hold when `readGrants(workspace)` fails transiently during a batch poll or after `defer` reorders `this.cursors` (Finding 4).
- **R9b & Ported-Fixes Outcomes ([.ai/plans/platform-refactor.md:1088](../../.ai/plans/platform-refactor.md#L1088), [1094](../../.ai/plans/platform-refactor.md#L1094), [1171](../../.ai/plans/platform-refactor.md#L1171)) — `@flock/client/node/oauth` uses https except in loopback development and guards fetches via `@flock/net`:** `oauth.ts` keys both client type and `safeFetch(() => loopback)` on `protocol === "http:"` without checking for a loopback hostname (Finding 3).
- **R9c Outcome ([.ai/plans/platform-refactor.md:1154](../../.ai/plans/platform-refactor.md#L1154), [1160](../../.ai/plans/platform-refactor.md#L1160)) — `AppsPanel` form preservation (`16ccc98`):** Preserving `access` on failed operations wedges the form if a selected channel archived or transitioned meanwhile, and state is not scoped to the active workspace (Finding 5).
- **R3 Outcome ([.ai/plans/platform-refactor.md:569](../../.ai/plans/platform-refactor.md#L569)) — unit test requiring a route at each operator NSID and *none for an NSID the app does not define*:** When R7a replaced the Next.js `/xrpc` route files with `@atproto/xrpc-server`, [apps/operator/src/operator/methods.test.ts:10-12](../../apps/operator/src/operator/methods.test.ts#L10-L12) was rewritten to compare `Object.keys(OPERATOR_METHODS)` to the NSID constants; [apps/operator/src/operator/server.test.ts](../../apps/operator/src/operator/server.test.ts) no longer makes an HTTP probe against an undefined `/xrpc/<nsid>`. Every other unit, acceptance, browser, performance, sync-budget, and BDD test file named across R0–R9c exists in the tree.

---

## Sound Areas

- **Operator authorization, journal, and kinds** ([apps/operator/src/operator/security.ts](../../apps/operator/src/operator/security.ts), [operations.ts](../../apps/operator/src/operator/operations.ts), [journal.ts](../../apps/operator/src/operator/journal.ts), `kinds/*`): Sound — actor checks, creation claim/admission hooks, `creator-admin` resume barriers, last-admin protections, app/member mutual exclusion, and the 3-minute per-run lock limit hold.
- **Service-token verification and operator error logging** ([apps/operator/src/operator/security.ts:27-68](../../apps/operator/src/operator/security.ts#L27-L68), [methods.ts](../../apps/operator/src/operator/methods.ts), [server.ts:98-114](../../apps/operator/src/operator/server.ts#L98-L114)): Sound — `aud`, `lxm`, PDS signing keys, and `iat` age bounds (900 s for `getChanges`, 75 s elsewhere) are enforced and untrusted error messages are never logged.
- **Outbound fetch coverage across server processes** (`apps/operator`, `packages/client/src/node`, `apps/echo-bot`): Sound apart from Findings 3 and 6 — every non-test server fetch routes through `safeFetch` with DNS-to-socket IP pinning, `redirect: "error"`, bounded body reads, and disabled undici idle timeouts (`eb82ba6`).
- **Ported DM leave/rejoin, channel-name rule, and echo-bot log escaping** ([packages/client/src/dm/dm-client.ts:478-509](../../packages/client/src/dm/dm-client.ts#L478-L509), [operations.ts:164](../../apps/operator/src/operator/operations.ts#L164), [apps/echo-bot/src/failure-line.ts](../../apps/echo-bot/src/failure-line.ts)): Sound — `leave`/`rejoin` suppresses re-notifications until `startConversation` readmits removed peers, `fitsDirectoryName` unifies operator and lexicon bounds, and control/bidi/separator characters are escaped.
- **Browser OAuth flow, `APP` marker, and server DB migration** ([apps/web/src/browser/session.ts](../../apps/web/src/browser/session.ts), [channel-view.tsx](../../apps/web/src/app/ui/channel-view.tsx), `apps/operator/src/lib/db.ts`): Sound apart from Finding 8 — auth codes stay in URL fragments, space keys are non-extractable WebCrypto keys, uninstalled apps disappear from channel writers along with their messages, and legacy server member/cache tables are dropped and `VACUUM`ed.

---

## Overall Assessment

The branch is **not yet fit to merge**; the architecture, package boundaries, authority-grant isolation, and journaled membership model are strong, but two High-severity gaps and four targeted Medium fixes should land first. Specifically, before merging: (1) fix [apps/operator/scripts/reconcile-workspaces.ts](../../apps/operator/scripts/reconcile-workspaces.ts) so R8 dedicated-account workspaces do not fail every scheduled reconcile run on a missing authority admin record (and cover `runReconcileJob` in the R8 acceptance test); (2) replace `script-src 'unsafe-inline'` in [packages/deployment/src/security-headers.ts](../../packages/deployment/src/security-headers.ts) with a per-request nonce policy while stopping `connectSrc()` from baking loopback HTTP into builds where `APP_URL` was unset; and (3) tighten loopback hostname validation in [packages/client/src/node/oauth.ts](../../packages/client/src/node/oauth.ts), enforce workspace-before-channel grant refreshes in [packages/client/src/app-runtime.ts](../../packages/client/src/app-runtime.ts), key/filter `AppsPanel` by workspace and active channels in [apps/web/src/app/ui/apps-panel.tsx](../../apps/web/src/app/ui/apps-panel.tsx), and add the missing NAT64/6to4 IPv6 subnets in [packages/net/src/safe-fetch.ts](../../packages/net/src/safe-fetch.ts) (alongside widening `/xrpc` CORS in [apps/operator/src/operator/server.ts](../../apps/operator/src/operator/server.ts) if third-party browser clients are part of this release).
