# Invited member could not find the workspace — 2026-10-07

## Report
After an admin invited Alice by DID, signing in as Alice and "accepting" took her to her dashboard with no workspace.

## What the evidence showed
Read from the playground's PDS hosts and the app's own SQLite database (all read-only), UTC:

| Time | Fact |
|---|---|
| 20:55:30 | Owner's first "Create workspace" was refused with the typed `authorization_required` response and discarded from the journal (the earlier fix working as intended). |
| 20:55:37 | Workspace created. |
| 20:56:28 | Invite of Alice completed; the PDS lists her on the workspace (read and write), the admin inbox (write-only) and the general channel. |
| 20:56:57 | Alice signed in. |
| until the investigation | Alice had no acceptance record and her PDS listed no spaces. The PDS log shows no failing call from her at all. |

So the invite was not the problem. Nothing from Alice reached the PDS after sign-in, which means no accept request got that far.

A headless run that followed the "Accept an invitation" form exactly as written worked: the workspace appeared with 2 members. That run also wrote Alice's acceptance, which changed the playground's state.

## Root cause
A journey gap, not a crash. Adding a DID makes the account a member, but nothing tells the member. The protocol offers no "spaces I have been added to" lookup (`listSpaces` returns only spaces the user has written to), so the only way to find the workspace was to be handed its `at://` URI and paste it into a form that exists only on an empty dashboard. The owner's screen never showed or offered that URI after inviting.

There was also a silent path: when accepting succeeded but the workspace was not listed, the app returned without saying anything.

What the evidence cannot show is exactly what was clicked. The fixes below are valid under either reading.

## App fixes
- The owner can copy an invite link (`/?invite=<workspace URI>`), and after an invite completes is told to send it.
- Opening the link, signed in or not, shows an invitation with a "Join this workspace" button. The link survives the sign-in redirects.
- A refusal because the account was never added now says so (`not_a_member`), instead of a raw credential error.
- Accepting never fails silently.

## Protocol gap
Invitation discovery is U10 in `.ai/upstream/`. The app deliberately does not add an invitee-owned invitation inbox: it cannot reach a brand-new user, and every application would reinvent it.

## Why the tests missed it
The Gherkin features were documentation. No runner, no step definitions: none of the 64 scenarios ever executed. The only browser coverage of invitations used a second app server and a member who had been handed the workspace URI directly, so it never exercised the real journey. See `bdd/` and `bdd/gate.test.ts`.
