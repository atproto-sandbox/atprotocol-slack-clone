# Executable Gherkin: what ran, what it found, what is still weak

Date: 2026-10-08. Branch `feat/direct-messages`, uncommitted.

## Result

| Run | Scope | Outcome |
|---|---|---|
| `pnpm test:bdd:chrome` (visible Google Chrome) | 66 scenarios, every bound scenario except the two `@slow` | 66 passed, 470 steps, 18m49s, final build |
| `pnpm test:bdd:slow` | 2 `@slow` scenarios | 2 passed, 13 steps, 25m22s |
| unit + gate (`pnpm test`) | 198 tests | all pass |
| typecheck, lint | | clean (1 pre-existing lint warning) |
| DM acceptance, reconcile, 2 browser specs | | all pass |

69 scenarios exist. 68 are bound. One stays `@unbound`: "The final admin cannot leave or be demoted" has no user path (the UI offers no way to remove the last admin); `protocol-tests/app-acceptance.test.ts` covers it. `bdd/gate.test.ts` fails if that count grows, if any bound scenario (including `@slow`) has an undefined step, or if the `@slow` set changes.

Two scenarios are **delegated, not UI-driven**: they run an existing protocol test as a child process, because a browser cannot reach the mechanism. "Recover after every injected mutation failure" runs `protocol-tests/app-acceptance.test.ts` (52 injected PDS-write failures with subprocess restarts). "Meet the workspace size envelope" runs `protocol-tests/performance-envelope.test.ts` (200 members, 100 channels, 20,000 messages per channel). Their evidence is the child's exit code and its own assertions.

## Real app bugs the scenarios found (all fixed)

1. `com.atproto.space.notifyWrite` rejected every real PDS notification: the lexicon types `hash` as `bytes` (JSON `{"$bytes": ...}`) and the route required a string. Live updates never worked, only the 60 s poll. Now `src/atproto/write-notification.ts`; internal errors return 500 instead of 400.
2. A poster's own channel message stayed hidden for up to 60 s (the per-repo freshness throttle). The write routes now call `markRepoStale`.
3. An open DM conversation ignored edits, deletes and removed reactions until reopened, and overlapping refreshes could drop messages. `retainAfterRefresh` plus a latest-wins ticket.
4. A DM request to a user without an inbox was reported "delivered": the pinned PDS accepts a `putRecord` into a nonexistent space. The sender now asks the inbox for a credential first; that needs a new browser DM scope (`space:org.slack.dm.inbox?authority=*&action=read`). Found only by the real-browser run: the Node-level tests could not see the scope gap. Protocol ask drafted as U11.
5. A deleted DM half read "hasn't replied" instead of "left" while a cached credential was still valid.
6. Replies were a flat list; they now render under their parent.
7. A private-channel member returning from a permission screen had no roster until reopening the channel.
8. `protocol-tests/app-acceptance.test.ts` derived a TID from a second clock read and failed on a loaded machine.

Also fixed from review: the notification and cursor tables gained indexes; `markRepoStale` invalidates the compare-and-set revision so a read in flight cannot write an older snapshot back over a mark; sign-in clears a previous account's half-finished create/join state.

## Test bugs found by running the suite

The last two full headed runs failed one scenario, "Render one workspace from two independent apps". After bisecting the app and finding it innocent, server-side logging showed the cause was in the test helper: it took the first `/api/channels/messages` response after clicking a channel, and a refresh of the previously open channel finished first. The helper now matches responses to the channel by `skey` (`ApiCall.query`).

Two UI guards added on a wrong theory during that investigation (`acceptWorkspace` selection, a `loadMessages` ordering ticket) were reverted: they were unproven.

## How the suite was checked

Every step group has a negative control: temporarily break an expectation or the behaviour and confirm the scenario goes red. Three independent reviewers audited the new steps and the source changes; three critics checked each review against the code; a final reviewer checked the fixes. Strengthened after review, among others: DM request-list reads wait for the first scan and pair each empty result with a positive sentinel; an old credential is now observed to expire (the fixture re-signs the member's credential with a 5 s `exp` and the PDS answers 401 `JwtExpired`); the "listRepos finds the writer" scenario makes the operator's member list and `listRepos` disjoint; "Ignore spoofed authority records" has a positive control (the authority writes the same records and the app honours them); credential refusals require 403 `UserNotAuthorized`; child processes are killed on timeout and exit.

## Known limits (not fixed)

- The 101-participant DM request is rejected by the app's own validation, not by the PDS (the PDS stores it with `validationStatus: unknown`).
- Transition recovery is exercised after the first PDS write only; later write points are covered by the delegated matrix.
- "Approved only after all three writes" is sampled in-process (a gap shorter than one sample is covered only by the journal order).
- The 7-day `space_notification` retention table stores the watched space URI and writer DID, including DM half URIs that contain the conversation key. This is the residual exposure documented in `docs/operations.md`; it only became real when finding 1 was fixed. The "Discover a request" step now asserts the key appears only in `space_notification.space_uri` and that no request content is stored. If that exposure is unacceptable the alternative is to stop registering DM spaces for push and accept the 60 s poll.
- A DM browser session granted before the new inbox scope keeps the old scope and reports sends as failed until it reconnects.
- Raw `Missing required scope` text still shows on a first-time workspace leave before the "Authorize leave control" button; a non-admin hitting `/api/operator/stalled` gets 400 rather than 403.
- A private-channel member briefly sees "You are not on this channel's active roster" while the roster loads.
