# Add batch membership calls to `simplespace`

## Summary
`putMember` and `removeMember` change one member per call. Group and team products change hundreds of memberships at once, and each change is a separate authenticated request.

## Problem
Measured on a local two-host fixture with rate limits disabled:
- A 100-person group conversation where each participant owns a space needs 99 `putMember` calls per space. Creating 100 such spaces took 9,900 calls in 27.5 seconds.
- Inviting one person to a workspace with 100 public channels needs one call per space (workspace, inbox, and every public channel), about 102 calls, executed in order with recovery steps in between.
- Real deployments rate-limit these calls, and every interruption needs a resumable multi-step journal on the application side.

## Proposed change
```
com.atproto.simplespace.putMembers      input: { space, members: [{ did, read, write }] }   (max 100 to 1000)
com.atproto.simplespace.removeMembers   input: { space, dids: [did] }
```
Output should give per-item results, so partial failure is visible. All-or-nothing is optional. Same auth as the single-member calls.

## Alternatives considered
- Client-side concurrency. Already used, and it does not reduce load or rate-limit cost.

## Compatibility
Additive.

## Open questions
- Maximum batch size, and whether `listMembers` should gain a filter (for example `write=true`) so recovery scans stay cheap.

## Internal references (remove before filing)
`protocol-tests/atproto/slack-dm-conformance.test.ts` (100-participant test), `src/operator/operations.ts` (`inviteMember`).
