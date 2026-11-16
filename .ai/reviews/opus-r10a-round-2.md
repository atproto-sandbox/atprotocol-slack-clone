# R10a code review, round 2 (swarm `opus-r10a`, `claude-opus-5-5-high`, 2026-11-15)

Reviewed commit `fa61151` (`2cccab3..fa61151`). Verdict: **READY**.

---

**Resolved**
- #1 (BLOCKING), `app-inboxes.test.ts:145-172`: a notice is recorded for the inbox. The member and admin denials now run with that notice present, and the app follows `appOneInbox` and gets `denied: []` plus the inbox in `changed`. That positive control makes the post-uninstall `denied` meaningful. The notice is injected, not delivered by the host, but real registration is still asserted at `:119`. Acceptable.
- #2 (BLOCKING), `app-access.test.ts:129-136`: `stops` is now counted apart from `writes`. Update now has 3 stops (`createSpace`->`SpaceAlreadyExists`, `putRecord`, channel `putMember`) and 2 writes, so the channel write is interrupted again.
- #3, `app-access.ts:62-68` and `:76-81`: on a replay where the record step is done and the inbox is `uncovered`, `app-inbox-space` and `app-inbox-set` are skipped and so is the inbox verify. A row written after R10 always has `app-inbox-space` done before its record, so its inbox is present and the skip can't trigger for it. The new test (`app-access.test.ts`, "pending pre-R10 journal rows") replays a pending install row and a pending update row under an old grant through reconcile's recovery: both complete, the channels end where expected, and nothing wedges.
- #4, `operations.ts:41/:68/:136` plus `safeAfterOperation`: every `afterOperation` call in `operations.ts` is now guarded and audited, and a test injects a `getSpace` outage after completion and asserts `operationRegistrationFailed`. `create-workspace.ts:75` is still unguarded, but that is pre-existing and does no reconcile sync.
- #5, `reconcile-workspaces.ts:54-62`: a failed `hasUncoveredAppInbox` read no longer fails the run.
- #6: declined. I accept the rationale: `activeInstalls` is bounded, nobody reads an inactive inbox, and reconcile empties it app-first (now asserted, `app-access.test.ts:420-421`).
- #7, `reconcile-workspace.ts:119`: the verify step reuses `current` when nothing was written.
- #8: old-grant drift repair is now asserted in both the unit test (`:543-545`) and acceptance (`:232-238`). Reconcile's app-first removal for an inactive inbox is asserted. There is an exact member-scope test (`scopes.test.ts:154-160`). The no-op ternary is gone.
- #9: `CODE-MAP.md` diagram and `:219-220` updated; plan status updated.

**NON-BLOCKING (new, minor)**
- When an install or update replay skips an uncovered inbox, `createsSpaces` still tries to register that inbox, and the attempt fails. That leaves a `notification_registration_failure` row, which prints a WARN through `registrationProblems` until the next sweep drops it. The sweep drops it because the inbox is held but not in `activeSpaces`. It's harmless noise. Optional fix: skip the registration when the state is `uncovered`.
- `app-access.test.ts`: `registered` went from `deepEqual` to `includes(secondInbox)`. That is a looser assertion, but the reason holds: the third inbox is now registered too.

VERDICT: READY
