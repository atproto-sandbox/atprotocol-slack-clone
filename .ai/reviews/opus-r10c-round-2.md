# Claude Opus Review — R10c (Round 2)

- **Reviewer:** `opus-r10c` (`claude-opus-5-5-high`, Swarm board `#18`)
- **Range:** `04b1837..767def9` (full R10c: `0d1d066..767def9`)
- **Verdict:** `READY` (`0 blocking`, `3 non-blocking`)

---

## Verification of Round 1 Findings

### BLOCKING items: both fixed
- **B1** (one client could fill the sign-in cap): `RateLimiter` is now a sliding window (`rate-limit.ts:26-70`). `loginLimiter` (`server.ts:87-96`) allows `DEFAULT_LOGIN_PER_ADDRESS = 10` per address over `ADMIN_STATE_TTL_MS`, well under the cap of `100`, so one address can hold at most 10 pending sign-ins. `server.test.ts:211` asserts `DEFAULT_LOGIN_PER_ADDRESS < MAX_PENDING_ADMIN_STATES`, and lines `274-297` send logins from one address 90s apart (6 minutes total), get `429` on the 5th, leave room under the cap, and verify another address still signs in.
- **B2** (session file not git-ignored): `.gitignore:18-19` now has `.webhooks-session.json*` and `.webhooks-hooks.json*`. `git check-ignore` matches `.webhooks-session.json`, `.webhooks-hooks.json`, and `.webhooks-session.json.hooks.json`.

### Round-1 notes and test gaps: all addressed
- **N1:** `HooksStore` caches the parsed file, and `change()` copies it, writes, and swaps the cache only after the write succeeds (`hooks-store.ts:125-176`), with a test for the cached path.
- **N2:** `WEBHOOKS_TRUST_PROXY` (`config.ts`, `main.ts:73`, `.env.example`) takes the rightmost valid `X-Forwarded-For` entry and otherwise uses the socket address; `::ffff:` mapping is stripped and IPv6 addresses are grouped by `/64` (`server.ts:778-838`), with tests.
- **N3:** A private-created hook in a transitioning channel stays private (`server.ts:631-633`), tested (`▣secret` shown as unavailable).
- **N4:** The hook endpoint checks `deps.workspaces.includes(...)` before any PDS call (`server.ts:249`); tested.
- **N6:** `WorkspaceEnvelopeError` from the roster read is caught and marks the hooks unavailable (`server.ts:604`); tested.
- **N7:** `MAX_HOOKS_PER_WORKSPACE = 100` is enforced on create (`server.ts:445`); tested.
- **T1–T6:** Login limit `429`, valid hook `200` while failed-attempt limiter is saturated with no clock advance, global failed limit across addresses, wrong secret on over-budget hook returning `404` (not `429`), `{ fresh: true }` asserted in summary mock, `completeSignIn` state/`appState` mismatch + `signOut` revocation on both failure and success paths, private-channel delivery `200` and `404` once archived, and `https` `appUrl` setting `Secure` on flow and session cookies.

---

## Non-Blocking Notes (Applied Post-Review)

- **R2-1 (`hooks-store.ts`):** Memoized cold disk load promise (`this.loading`) and guarded cache assignment with `this.cached ??= ...` so a cold `readAll()` racing `change()` shares one load and cannot overwrite a newer cache snapshot.
- **R2-2 (`hooks-store.ts`):** External edits to the hooks file require process restart (documented in `HooksStore`).
- **R2-3 (`hooks-store.ts`, `server.ts`):** Moved `maxForWorkspace` enforcement inside `HooksStore.create`'s serialized `change()` transaction (`WorkspaceHookCapError`) so concurrent creates cannot exceed the per-workspace hook cap.
