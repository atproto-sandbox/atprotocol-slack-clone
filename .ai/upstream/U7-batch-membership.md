# Add batch membership calls to `memberspace`

Status against `6747610566` + `opensocial.group` `8df0cc82` (R13, 2026-11-21): **Resolved at both layers.** Upstream `6747610566` shipped batched `com.atproto.memberspace.putMembers` and `removeMembers` (`<= 100` entries per call, used by Flock's 100-participant sovereign group DMs), AND R13's `opensocial.group` flat union RBAC (`group.opensocial.policy` + `role/*` + `membership/*` in `members/self`) makes adding, removing, or changing roles across a 100-channel group workspace an **`O(1)` single `putRecord` / `deleteRecord` write** (`<= 250 ms` verified in `protocol-tests/performance-envelope.test.ts`).

Status against `5d88b414` (2026-10-30): Not affected. The calls moved to `com.atproto.memberspace.putMember` and `removeMember` (`simplespace` is gone) and still take one DID per call. `removeMember` and `putMember` with `write: false` now also evict a tracked writer, which makes one more call per removal worth batching.

Status against `5b95b2f2`: Not affected. `putMember` and `removeMember` still take one DID per call.

## Summary
`putMember` and `removeMember` change one member per call. Group and team products change hundreds of memberships at once, and each change is a separate authenticated request.

## Problem
Measured on a local two-host fixture with rate limits disabled:
- A 100-person group conversation where each participant owns a space needs 99 `putMember` calls per space. Creating 100 such spaces took 9,900 calls in 27.5 seconds.
- Inviting one person to a workspace with 100 public channels needs one call per space (workspace, inbox, and every public channel), about 102 calls, executed in order with recovery steps in between.
- Real deployments rate-limit these calls, and every interruption needs a resumable multi-step journal on the application side.

## Proposed change
```
com.atproto.memberspace.putMembers      input: { space, members: [{ did, read, write }] }   (max 100 to 1000)
com.atproto.memberspace.removeMembers   input: { space, dids: [did] }
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
