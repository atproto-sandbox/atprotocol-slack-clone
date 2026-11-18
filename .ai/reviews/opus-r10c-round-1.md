# Claude Opus Review — R10c (Round 1)

- **Reviewer:** `opus-r10c` (`claude-opus-5-5-high`, Swarm board `#14`)
- **Range:** `0d1d066..04b1837`
- **Verdict:** `REVISE` (`2 blocking`, `13 non-blocking`)

---

## Findings

### BLOCKING
- **B1.** Sign-in cap can be filled by one client, which the plan says must not happen. The plan (`progress.md:265`) says starting a sign-in "is rate-limited per address, so one client cannot fill the cap". The defaults allow 15 starts per address per 60s window, from a fixed-window limiter (`server.ts:80-82`, `rate-limit.ts:21-40`). The cap is 100 pending states and each one lives 10 minutes (`admin-oauth.ts:23-24`). So one address can hold up to 15×10 = 150 states at once. It fills the cap in about 7 minutes and keeps it full, and every real admin then gets `PendingSignInCapError` → 429 (`server.ts:290`). Fix: size the per-address budget over the state lifetime (`ADMIN_STATE_TTL_MS`) with a sliding window and a max well under the cap (e.g. 10), and add a unit test pinning that one address at its limit leaves room under `MAX_PENDING_ADMIN_STATES`.
- **B2.** The webhooks app's OAuth session file and hooks file are not git-ignored. `.env.example` sets `WEBHOOKS_STATE_FILE=./.webhooks-session.json` and `WEBHOOKS_HOOKS_FILE=./.webhooks-hooks.json` in the repo root, whereas `.gitignore` covers only `.echo-bot-session.json*`. Fix: add `.webhooks-session.json*` and `.webhooks-hooks.json*` to `.gitignore`.

### NON-BLOCKING (code)
- **N1.** `server.ts:190-201` / `hooks-store.ts:57,122-132`: cache parsed hooks in memory inside `HooksStore` (invalidated/updated on `change()`) so repeated `verifySecret` calls do not re-read and re-parse the whole hooks file from disk on every unauthenticated request.
- **N2.** `server.ts:742-744`: `clientAddress` uses `socket.remoteAddress`; behind a reverse proxy all clients share one address unless proxy forwarding is configured, and IPv6 addresses are not normalized by `/64`. Support opt-in `WEBHOOKS_TRUST_PROXY` (`trustProxy`) and normalize IPv4-mapped / IPv6 `/64` client keys.
- **N3.** `server.ts:597,670`: a private-created hook in a channel now `transitioning` took the public branch (`visibility: "public"`). Preserve `visibility: "private"` when `dir.visibility === "transitioning" && hook.privateChannel`.
- **N4.** `server.ts:236`: check `deps.workspaces.includes(matchedHook.workspace)` on `POST /hooks/<id>/<secret>` before accepting a hook, so dropping a workspace from `WEBHOOKS_WORKSPACES` stops its hooks immediately.
- **N5.** `server.ts:600-621`: archived private hooks remain `unavailable` and `canRevoke: false` per the plan text.
- **N6.** `channel-client.ts:330-331` / `server.ts:571-573`: `channels.roster` can throw `WorkspaceEnvelopeError`; catch it alongside `ChannelUnavailableError` and `isAccessLost` so `/admin` marks that channel's hooks unavailable rather than returning `500`.
- **N7.** Cap active hooks per workspace (`MAX_HOOKS_PER_WORKSPACE`) so `/admin/hooks/create` bounds workspace hook count.

### NON-BLOCKING (tests)
- **T1.** `server.test.ts`: test per-address login rate limit (`429`) and verify a saturated single address cannot fill `MAX_PENDING_ADMIN_STATES`.
- **T2.** `server.test.ts`: test valid hook succeeding while failed-attempt limiter is saturated (before advancing clock), global failed-attempt limit (`failedHooksTotal`), and wrong secret on an over-budget hook returning `404` (not `429`).
- **T3.** `server.test.ts`: assert `{ fresh: true }` in the `workspaces.summary` mock.
- **T4.** `admin-oauth.test.ts`: test `completeSignIn` revoking the session (`signOut`) and rejecting `state` / `appState` mismatches.
- **T5.** `server.test.ts`: test `POST /hooks/<id>/<secret>` on a private channel (`200` with write grant, `404` once archived).
- **T6.** `server.test.ts`: test `createWebhooksHandler` with an `https://` `appUrl` emitting `Secure` on flow and session cookies.
