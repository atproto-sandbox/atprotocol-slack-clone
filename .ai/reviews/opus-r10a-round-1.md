# R10a code review, round 1 (swarm `opus-r10a`, `claude-opus-5-5-high`, 2026-11-15)

Reviewed commit `2cccab3` (`b1569e7..2cccab3`). Verdict: REVISE (2 blocking, 7 non-blocking).

---

**What checks out**
- Lexicons match the plan. `app.inbox` uses `name`, which is right for the `5d88b414` pin (plan `:31`). `command.text` may be empty. The block union is closed, with the plan's bounds. Declaration `commands` <= 25.
- Registry: TID keys; token checks for command names and actionIds; channel must be canonical, same authority; `parent`/`message` must be a TID message URI in that channel; actionIds unique across a message; declaration names unique plus a 64 KiB cap. `spaceCollections` exists, `workspace.json` gains `app.install`, and a test keeps every space lexicon equal to the registry.
- Key: `appInboxUri` is pinned with vectors, 105 chars, and still passes `isSkey` with a 128-char workspace key.
- Scopes: member gets create+delete on the inbox with no read or update. App gets `authority=*&action=read`. Authority gets only the manage/read token, with no collection token (`scopes.ts:36-47`). The permission JSONs are cross-checked by `scope-lexicons.test.ts`.
- `mayFollow` requires `read===true` (`member-access.ts:51`), so writers and admins can't follow an inbox.
- Install order is space -> record -> inbox-set -> access. Uninstall order is record -> app removed from the inbox -> writers -> access.
- `app-inbox-set`, `app-inbox-remove` and reconcile's set/remove read the current list on entry (diff on entry).
- invite/remove/leave skip any inbox that isn't `present`. Pre-R10 inactive installs get no inbox.
- `appInboxState` separates `SpaceNotFound` from `ScopeMissing`; any other error is rethrown.
- The fake host now refuses member-list calls on a missing space.
- The new step names fit the declared templates (`stepMatcher` `.+`), so the kind table holds.
- `unregisterSpace` purges the registration rows.

**BLOCKING**
1. `protocol-tests/app-inboxes.test.ts:162-164` is a tautological test. The comment says "the installed app is admitted by getChanges", but the call passes `follow: []` and only asserts that `head` is a string. Nothing proves the app is admitted to its inbox on the real network. That also makes the post-uninstall `denied` check (`:182-185`) and the member/admin denials (`:156-159`) empty: they would pass if `FOLLOWED_BY_MEMBER_LIST` lacked the type. Fix: before the uninstall, follow `appOneInbox` with the app session and assert `denied` is `[]`.
2. `app-access.test.ts:130` has silently lost coverage for `updateAppAccess`. The intercept counts every `WRITES` method, `createSpace` included. On update, `createSpace` answers `SpaceAlreadyExists`, so it is counted but never recorded as a write. The loop runs index `0..1` (`writes: 2`), so it only stops at `createSpace` and `putRecord`. The channel `putMember` (the 3rd call) is never interrupted, though R9 covered it. The R10a requirement "every changed kind resumed after a stop at every step" is unmet for update. Fix: count intercepted calls apart from recorded writes (3 stops, 2 writes).

**NON-BLOCKING**
3. A pre-R10 pending `installApp`/`updateAppAccess` row on a pre-R10 grant wedges the workspace. Its record step is already done, so when `app-inbox-space` hits `ScopeMissing` the row isn't discarded (`journal.ts:141` needs 0 completed steps). It stays pending with `authorizationRequired`, and `operations.ts:77` then refuses every admin operation, the scheduled reconcile included, until re-approval. This breaks plan `:112-113` ("no operation fails on, or waits behind..."). Fix: when the record step is already completed, check `appInboxState` and skip the inbox steps if `uncovered`. Also add an old-grant case to the replay test (`app-access.test.ts` "pending pre-R10 journal rows", which only uses a covering grant).
4. `registrations.ts:73/204-215`: `syncReconciledInboxRegistrations` does PDS I/O (`listRecords`, `getSpace`) that can throw. `afterOperation` is called unguarded at `operations.ts:41` and `:141`. So a transient read error after a completed reconcile surfaces as a failed `execute` or a failed job, contrary to the "registration failure doesn't fail the operation" contract (`:59-61`). Wrap it in try/catch and audit, as `:67-74` does.
5. `scripts/reconcile-workspaces.ts:54-56`: a transient error in `hasUncoveredAppInbox` lands in the catch and sets `failed=true` after a completed reconcile. It should only skip the warning.
6. `remove-member.ts:46-51` only covers active installs. A person stays a writer in a present inbox of an install whose uninstall was interrupted, until reconcile empties it. Harmless (nobody reads), and keeps `removeMember` within plan `:131` ("at most 20" active inboxes).
7. `reconcile-workspace.ts:70-71/118`: every inactive install with a present inbox costs a `getSpace`, two `listMembers` and a journal step on every reconcile, forever. Inactive installs aren't counted in the envelope. Reuse `current` for the verify step when nothing was written.
8. Test gaps:
   - The old-grant reconcile tests (`app-access.test.ts` pre-R10 matrix, acceptance `:224-227`) assert only "completed + WARN". Neither shows another space's drift being fixed.
   - Reconcile's app-first removal for an inactive inbox is never asserted (only uninstall's is, `:115`).
   - No exact-string test that `memberGrantScopes` has no inbox read; it's only compared with the co-authored `member.json`.
   - `app-access.test.ts:346` `mode === "invite" ? 6 : 6` is a no-op ternary.
9. Docs:
   - `CODE-MAP.md:218-219` still says `app-access` writes "its install record first"; the diagram doesn't mention `.app.inbox`.
   - The plan's status (`r10-interactions-progress.md:4`, "Nothing implemented") isn't updated for R10a.

VERDICT: REVISE.
