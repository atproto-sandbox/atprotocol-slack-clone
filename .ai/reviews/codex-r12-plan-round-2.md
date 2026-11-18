Reviewed `83b15b3c` against upstream `6747610566`. **The plan still needs revision.** Both worktrees remain clean; no files, builds, tests, installations, or network requests were performed.

`P` below means [the revised plan](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/.ai/plans/r12-protocol-drift-progress.md).

Every Round 1 finding is accounted for:

| Round 1 findings | Disposition | Revised-plan evidence |
|---|---|---|
| Codex #1; Opus M5 | Resolved: codegen variable, fixture default, four lexicon directories | P17–18, P166–172, P204 |
| Codex #2; Opus B1(b) | **Partial:** caller isolation and expiry fixed; nonmember issuance remains | P89–93; finding 1 below |
| Codex #3; Opus M1 | Factories corrected; **verification recipe still incomplete** | P104–107; finding 4 |
| Codex #4 | Resolved: exact callback discriminants | P65–73 |
| Codex #5; Opus B1(a) | Resolved: persisted operator token reused on renewal | P55–60 |
| Codex #6; Opus H2 | **Partial:** backoff/concurrency corrected; renewal schema remains inconsistent | P77–82; finding 2 |
| Codex #7; Opus M11 | Resolved: accurate callback-specific HTTP 400 semantics | P74 |
| Codex #8; Opus M4 | Resolved: exact `ACCESS_FULL` endpoint list and credential-only exceptions | P159–162 |
| Codex #9; Opus H4 | Resolved: reader uses protocol, adds STAR dependency, owns independent-DM files | P174–176, P223–224 |
| Codex #10 | Dependency closure audit and dev-env graph addressed; **new runtime gap** | P24, P38; finding 7 |
| Codex #11; Opus M2 | CID-free framing corrected; **new assertion error** | P118–121; finding 8 |
| Codex #12 | Resolved: managed/personal lexicons, `opEntry.rev`, browser MAC assertions | P137, P166–170, P245 |
| Codex #13; Opus M7–M8 | Resolved: real runners, disjoint parallel ownership, previously omitted files | P207–254 |
| Opus H1 | Resolved at design level: checkpoint and three catch-up triggers | P59, P66–76 |
| Opus H3 | Resolved: permanent writer failures versus temporary authority suspension; management 401 handling | P132–134 |
| Opus H5 | **Partial:** registration fallback specified; browser session preflight remains incompatible | P85–97; finding 5 |
| Opus H6 | Resolved: reactivate dormant contacts using batched `putMembers` | P149–151 |
| Opus M3 | Resolved: cross-page removal and >72h full reconciliation | P128–130 |
| Opus M6, M9 | Resolved: inbound routes/parser and unconditional deletion confirmation | P50–76 |
| Opus M10 | Resolved: retain/re-pin overrides | P37–38 |
| Opus L1, L4–L5 | Original issues addressed: build inventory, stable pins, normative references | P6–8, P21–36 |
| Opus L2–L3 | Resolved: precise unsigned-empty locations; no required member `$type` | P137–148 |
| Opus L6 | **Partial:** copy/run/cleanup specified; Jest command remains incomplete | P186; finding 6 |
| Opus L7–L8 | Resolved: HTTPS/SSRF documentation and lexicon republication requirement | P19, P165, P254 |

Remaining and newly introduced findings, ranked by severity:

1. **High — DM token issuance still permits nonmembers.** P89 retains `authorizeDmSubscription`, whose [implementation](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/apps/operator/src/lib/dm-subscription.ts:12) accepts every authenticated caller for conversation halves. Caller-bound HMACs prevent Mallory from withdrawing Alice’s distinct registration—upstream [withdraws only the supplied registration](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/src/api/com/atproto/space/authorizeSpaceSync.ts:83)—but Mallory can still obtain an accepted bearer for Alice’s conversation and forge/replay wakes. Require actual access proof, with nonmember, revoked-user, wrong-space, and replay coverage.

2. **High — Renewal SQL references columns absent from the proposed migration.** P57 adds only `token` and `last_space_rev`; P60 inserts `next_attempt_at`/`consecutive_failures` into `notification_registration`, and P81 queries `next_attempt_at` there. The [actual schema](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/apps/operator/src/lib/db.ts:167) stores `failures` and `next_attempt_at` in **`notification_registration_failure`**. Specify a consistent migration or join/upsert design. Also specify persisted lifetime/renewal timing so SQL can determine due rows after restart without first restoring credentials.

3. **Medium — Zero DM SQLite rows conflict with the notification delivery recipe.** P66 routes writes through `recordWriteNotification`; P68 persists removal wakes, while P93 promises zero DM rows. That helper [inserts into SQLite](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/apps/operator/src/operator/notices.ts:34), and the [existing feed](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/apps/operator/src/operator/feed.ts:65) consumes database notices exclusively. Only DM deletion has an explicit non-DB branch. Define the ephemeral DM wake/cursor path, including process/restart behavior, and test the actual no-DM-row invariant.

4. **Medium — `verifyCommit` still has an invalid signature.** P106 specifies `verifyCommit(commit, { space, repo })`. Upstream [requires `VerifyCommitParams = VerifyMacParams & {space, repo}`](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/space/src/repo-commit.ts:84) and invokes MAC verification internally. Supply `{ space, repo, keyShare, sharedSecret, headers }`; a preceding separate MAC check does not satisfy that call.

5. **Medium — Pre-R12 sessions can be rejected before reaching the promised polling fallback.** P87 handles `ScopeMissingError` at `getDmNotifyTarget`, but [restoreSession](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/apps/web/src/browser/session.ts:110) returns `null` when required scopes differ. [`missingScopes`](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r12/apps/web/src/browser/session.ts:214) compares RPC scope tokens exactly, so extending the combined `memberGrantScopes` token rejects existing sessions first. Explicitly tolerate the missing optional notification permission during session admission and test continued DM reads before re-consent.

6. **Medium — Gate 4 omits Jest’s required ESM option.** P186 invokes `exec jest`, bypassing upstream scripts that [set `NODE_OPTIONS=--experimental-vm-modules`](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/package.json:123). The [Jest configuration](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/pds/jest.config.cjs:13) emits ES modules. Prepend that option or invoke `test:sqlite`.

7. **Medium — The mandatory Node 22.17 build recipe violates a dependency’s supported minimum.** P22/P197 mandate 22.17 for ABI compatibility, but upstream resolves [Undici 8.12.3 requiring Node ≥22.19](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/pnpm-lock.yaml:10213). Disabling engine checks does not establish compatibility. Select a supported Node 22 patch for both checkouts or provide compatibility evidence. This is a prerequisite gap, not a demonstrated runtime crash.

8. **Low — STAR parity assertion treats a stream as bytes.** P121 uses `writeRepoStar(...).byteLength`, but [the function returns `AsyncGenerator<Uint8Array>`](/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12/packages/space/src/sync/provider.ts:26). Sum emitted chunk lengths or collect the stream, and await `starHeaderBytes`.

No remaining parallel file-ownership collisions were found across R12a–R12f.

VERDICT: REVISE