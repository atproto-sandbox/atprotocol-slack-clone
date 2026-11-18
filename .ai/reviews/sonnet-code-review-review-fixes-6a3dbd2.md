# Code review: fixes for four defects from the Gemini project review

- **Reviewed:** the change set on top of `6a3dbd2` that fixes defects 1, 2, 3 and 5 of `.ai/reviews/gemini-project-review-6a3dbd2.md` and amends `.ai/plans/platform-refactor.md` (R6, R7, R8).
- **Date:** 2026-11-10.
- **Reviewers:** three independent Claude Sonnet agents, each read-only, each given the frozen diff and the code but not the author's conclusions: a reviewer and a critic on version 1, and a fresh reviewer on version 2. The author was Claude Fable.
- **Verdict:** approve with follow-ups, on both versions. No critical finding. Every confirmed finding below was fixed, except those listed under "Left as they are".
- **Limits of this record:** the changes made after the version 2 review (wording, one constant renamed, one test added) were not reviewed again. The change set was written and reviewed on `6a3dbd2`, then moved onto `ed58c47` (R4), where one conflict in `CODE-MAP.md` was resolved by hand; nothing was reviewed again after the move, and the suites were run again there.

## What the change set does

| Defect | Fix | Where |
|---|---|---|
| A stalling host could hold a request, and the workspace lock, without limit | Every outbound request ends after 30 s. One run of an operation starts no step after three minutes and is left pending. | `src/atproto/identity.ts`, `src/operator/journal.ts`, `src/operator/client.ts` |
| Leaving a DM wrote a key nothing read | A left conversation is off the list and is not re-announced. Starting it again readmits the others. | `src/dm/dm-client.ts` |
| A retry of an operation that removed its submitter's own role was refused | The submitter may send that operation again. The rule is per kind (`endsOwnRole`). | `src/operator/security.ts`, `src/operator/kinds/`, `src/app/api/operator/execute/route.ts` |
| Three length rules for a channel name | One rule, the directory lexicon's. The request lexicon repeats it. | `lexicons/new/flock/operator/execute.json`, `src/protocol/registry.ts`, `src/operator/operations.ts` |

## Version 1: reviewer findings and what the critic made of them

| Finding | Critic | Outcome |
|---|---|---|
| The 30 s limit also cut off the web app's `execute` call to the operator, which answers only when the operation stops | Confirmed. The proposed 12-minute limit could not work: the transport had its own five-minute limit. | Fixed. The transport's fixed limits are off, each request's own limit applies, and `execute` gets the operator's budget plus one request. |
| The lock hold limit was checked wherever the lock was refreshed, so it discarded a finished step, turned a completion into pending, and masked an error thrown after the limit | Confirmed by probe, with a smaller fix: check only where a step starts. | Fixed that way. The lock code is back to the base commit. |
| Starting a DM again could bring back a half that was left when another half with the same people was in use | Confirmed by probe. | Fixed: a half still in use is preferred. Test added. |
| "The new channel-name test cannot fail without the fix" | **Refuted.** The test string was `e` plus a combining mark (bytes `65 cc 81`), 160 code points, which the old rule rejects. The reviewer's probe had used the one-code-point form. | No defect. The test strings are now written as escapes so the source is unambiguous. |
| "No test replays a completed row after removal" | **Refuted**: the member-leave test does. | None needed. |
| The retry exception admitted any journaled operation of a refused submitter, wider than the documented reason | Confirmed, no exploit found; narrowing judged the more correct fix. | Narrowed to the four requests that end the submitter's own role. |
| No real-PDS coverage of readmitting a removed DM participant | Confirmed. | Added to `protocol-tests/dm-acceptance.test.ts`. |
| The stalled-body test could flake under load | Plausible, not reproduced. | Its limit was raised from 100 ms to 1 s. |

Missed by the reviewer and found by the critic:

- The web app's own check (`src/app/api/operator/execute/route.ts`) read the workspace with the caller's session before calling the operator, so a leave retry failed there once the caller's workspace access was gone. Fixed: losing access no longer stops the request, and the operator decides.
- Two statements in the plan amendments were inexact (the CORS preflight, and which pending rows the scheduled job may resume). Both reworded.

## Version 2: fresh reviewer findings

| Finding | Outcome |
|---|---|
| "`execute` answers within about five minutes" is a budget, not a bound: the step in flight still ends, reads happen outside steps, and earlier pending operations are resumed first | Docs and comments reworded. The constant is now `OPERATION_ANSWER_BUDGET_MS`. |
| The plan cited this record before it existed | This file. |
| No per-kind test of `endsOwnRole`; four mutants survived | Table test added in `src/operator/kinds/kinds.test.ts`. |
| The plan's list of open items omitted four of the eight defects | Added. |
| The code map called one function "the one owner" of request time limits although the operator client also chooses one | Reworded. |

The version 2 reviewer also confirmed by probe: the lock code is identical to the base commit; no request can pass through the pinned agent without a time limit; a stalled upload, a silent server and a stalled body all end at the limit; the four `endsOwnRole` rules are right and no other kind takes away its submitter's role; every new test except one fails against the base code.

## Left as they are

- **`src/operator/errors.test.ts`, "a request that ran out of time…"** passes against the base code. It pins the classification the time limit relies on, and proves no fix.
- **No test covers** the disabled transport timeouts, the longer limit on `execute`, or the access-lost branch of the web execute route. The first cannot be reached in a unit test, and the other two would need a session and network harness these routes do not have.
- **`src/app/api/operator/reconcile/route.ts`** answers 400, not 503, when its call to the operator times out. It did the same before this change for a transport timeout.
- **"Left" is per device**, as `.ai/plans/direct-messages.md` step 8 specifies: another device still lists the conversation.
- **A pause at the time limit** replaces an earlier transient error in the row's `error` text, and a member-kind message ("before member leave can proceed") is what a former admin sees if other operations are pending during a retry.
- **`fitsDirectoryName`** builds a whole directory record to check one field. A required field added to that lexicon would reject every name; the name test would catch it.

## Verification

- On `6a3dbd2`: typecheck clean; lint 0 errors and the 1 warning it had before; unit suite 436 of 436; against the pinned PDS the acceptance suite (12 of 12 tests) and the browser suite (4 of 4) pass.
- On `ed58c47`: typecheck clean; lint as before; unit suite 531 of 531; against the pinned PDS the acceptance suite (13 of 13 tests, now including `engine-acceptance`) and the browser suite (4 of 4) pass.
- Not run on either base: the BDD suite and the performance suites.
