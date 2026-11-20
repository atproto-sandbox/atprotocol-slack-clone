All evidence is in. The upstream pin at `6747610` confirms `spacePolicyManager.authorizeCredential` must succeed before `confirmRegistration` is ever reached — the premise justifying every new fence advance.

---

# R12 Final Verification — `chore/protocol-drift-6747610` @ `377c3ad` (diff `79fc37f..HEAD`)

Read-only static audit. No files modified, no git state touched, no builds/tests/servers run. Upstream worktree confirmed at exactly `6747610566eee1b6d743617bd8eb1136adccb362`.

## 1. Verification table

| Item | Status | File:line evidence |
|---|---|---|
| **Codex R10-M1 / R7-M1 residual** — `RegistrationNotConfirmed` fast path returned cached credential without advancing `settledFenceSeq`, letting an older pending sidecar's later denial purge valid state and fire `onAccessLost` | **RESOLVED** | Every exit of the RNC handler now fences: fast-path return (`packages/client/src/credentials.ts:624`), abort while awaiting the cached read (`:615-621`), abort during fallback mint (`:633-635`), fallback success (`:638`), non-authoritative fallback failure (`:653-655`); authoritative fallback failure fences via `recordAuthoritativeAccessLoss` (`:651,152-156`). Ordinary mints get the same via the new `onRegistrationNotConfirmed` callback (`:665-666,680-682`) fencing the aborted (`:375-379`) and non-authoritative-error (`:413-414`) paths. Premise verified against the pinned upstream: `authorizeCredential` must succeed before `confirmRegistration` runs (`atproto-spaces-r12 packages/pds/src/api/com/atproto/space/authorizeSpaceSync.ts:77-103`), so RNC is proof of authorized access. Regression test: op1 unnotified → op2 older sidecar hung → op3 RNC fast path → (±aborted op4) → op2 denies with a real `SpaceCredentialError` — `isAuthoritativeAccessLoss === false`, `onAccessLost` not invoked, cache intact (`packages/client/src/dm/dm-client.test.ts:3418-3528`); non-vacuous because 403 `NotAuthorized` is a genuine `SpaceCredentialError` (`packages/protocol/src/atproto/space-credential-core.ts:921-922,967-969`), and `OPERATOR` is in scope from the enclosing test (`dm-client.test.ts:3003-3004`) |
| **Codex R10-M2** — unnotified fallback self-fenced (`advanceSettledFence` before `ownsCredentialSlot` on the same seq) so it could never be stored | **RESOLVED** | `canStoreFallback` computed *before* the fence advance, then applied (`credentials.ts:637-643`) — same ordering as the proven `mintFreshUnnotified` pattern (`:275-285`). Test now asserts post-call cache state: fallback token cached, notified predecessor replaced (`dm-client.test.ts:1133-1137`) |
| **Codex R10-M3** — local-hub catch rethrew `DmRateLimitError` without revalidating the lease (pause after the line-928 CAS → stale authoritative 429) | **RESOLVED** | Catch now re-runs the synchronous SQLite CAS before trusting the 429 (`apps/operator/src/operator/dm-feed-wakes.ts:1795-1800`); on failure `assertAndRefreshHubLease` steps the hub down (clearing `rateBuckets`, `:796-833`) and the bounded 4-attempt loop (`:1760`) reconnects and forwards to the live hub. Symmetric with the peer-response revalidation (`:1094`). Residual post-refresh TOCTOU equals the irreducible 15 s-lease window already accepted on the peer path |
| **Codex R10-L1 / Opus R2-L1 / R9-L1** — mid-CAS race test could false-pass (hub heartbeat consuming `n=1`) or flake on heartbeat phase | **RESOLVED** | `HUB_HEARTBEAT_MS = 4_000` is a plain `setInterval` registered at election, first fire at +4000 ms, cleared on step-down (`dm-feed-wakes.ts:31,835-845,780`); the test captures `performance.now()` *before* the election request, so interval registration lies strictly inside the measured window, and `elapsed < 3_500` (`dm-multiprocess.test.ts:1061-1062,1117-1119`) makes any heartbeat firing physically impossible — a heartbeat-consumed count can no longer produce a pass. `preReqRow.n === 0` proves quiescence after arming (`:1108-1109`); `raceRow.n === stealAtUpdate` phase-locks the takeover (`:1121-1125`) |
| **Heartbeat-free monotonic window: both takeover points** | **VERIFIED** | CAS counting matches code exactly — `ensureDmWakeReady` hub-mode performs exactly one lease UPDATE (`dm-feed-wakes.ts:1658-1660`), entry CAS second (`:909`), full-bucket CAS third (`:928`). `stealAtUpdate=2` forces the line-928 CAS to fail → `HubOwnershipLostError` → step-down → forward → 200; `stealAtUpdate=3` lets n reach 3 (direct proof line 928 executed), throws the 429, and forces the *new catch-block CAS* to fail → `continue` → forward → 200; failed CASes match zero rows so the `AFTER UPDATE` trigger never miscounts, and hub2's CASes never match the `WHEN NEW.token` clause (`dm-multiprocess.test.ts:1053-1133`) |
| **Zero regressions elsewhere in the diff** | **VERIFIED** | Diff confined to the four files plus the two review artifacts; monotonic-only fence advances cannot lower any sequence (`credentials.ts:105-109`); unchanged fast-path/store conditions aside from the fence; stale notify target still cleared via `ownsNotifySlot` (`:606-609`); retry loop bounded with honest terminal `DmWakeIpcError` (`:1811-1813`); no type suppressions introduced |

## 2. Remaining findings

**Blocker: 0**

**High: 0**

**Medium: 0**

**Low: 2**

1. **Multiprocess race test retains loud-failure-only timing sensitivity** — `apps/operator/src/operator/dm-multiprocess.test.ts:1070-1119`. The whole per-iteration choreography (120 fill webhooks in 3×40 waves, two elections, trigger arming, takeover request) must fit the 3 500 ms budget, and the ms-scale gap between the test's `expires_at = 0` reset and the next election races the *other* hub's live 4 s heartbeat (a heartbeat refresh landing in that gap blocks the intended election). Every such interference trips an explicit assertion (`elapsed < 3_500`, `preReqRow.n === 0`, token-inequality, `raceRow.n`) — a rare, self-detecting CI flake on a heavily loaded machine, never a false pass. Strictly weaker than the predecessor finding both reviewers rated Low.
2. **Pre-existing, narrowed by this commit (not a regression): an aborted-after-resolve *successful* mint still doesn't fence** — `packages/client/src/credentials.ts:375-380` throws on abort without advancing the fence unless `authorizedBeforeUnconfirmed`; the sidecar success path has the same shape (`:585`). If a mint resolves and the entry controller aborts in the same-tick window (requires *every* waiter to abort), the observed proof of access leaves no fence, so an older pending op's later `SpaceCredentialError` can still own the slot and purge shared state — the same class as R7-M1/R10-M1 but a sub-microtask interleave that ten prior review rounds declined to flag. The commit's own doctrine ("settled proof fences even when aborted", now applied to RNC) would justify fencing here too, should a future round want it.

## 3. Notes

- The fence-on-RNC design comment (`credentials.ts:654`) is factually accurate against the pinned upstream: a refused `authorizeCredential` throws before `confirmRegistration` is reachable, and a refusal carrying `notify` withdraws the registration rather than returning `RegistrationNotConfirmed`.
- The new catch-path lease CAS extends the lease on success; for a genuine owner 429 this is harmless (the heartbeat does the same every 4 s).
- A hook in this environment flagged "instruction in single-line comment" on `dm-feed-wakes.ts` output — false positive on the file's ordinary design comments; nothing in the reviewed content contains injected instructions.

VERDICT: READY
