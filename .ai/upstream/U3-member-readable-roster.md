# Optional: let members list who else is in a space

## Summary
`listMembers` must be called on the authority's PDS with OAuth and a read grant, and the lexicon states that a space credential is not sufficient, so members hosted on other PDSes cannot enumerate the list. Applications that need a roster (any team or group product) must duplicate membership as records and keep them in sync with the authority's member list.

## Problem
The proposal is deliberate here: "Accounts that may read the space are never enumerated at the protocol-level, though applications may choose to enumerate them through records published in the space." That is right as a default. For spaces where membership is not secret, the workaround has real costs:
- We publish roster records that duplicate the member list (workspace and per-channel rosters), plus an administrative service that reconciles them with `putMember`/`removeMember`. The pair can disagree, so the app needs convergence checks and recovery paths. Our lifecycle test matrix injects failures at 52 boundaries, several of which exist because membership and roster are separate writes.
- An admin hosted on a different PDS cannot call `listMembers` at all, so to find writers whose `notifyWrite` was dropped we had to add a service method that reads the list as the owner and exposes just the write-capable members to admins.

## Proposed change
Add an owner-controlled visibility setting to the space configuration:

```
memberVisibility (open union, default #owner = current behavior)
  #owner    only the owner can list members
  #writers  any credential holder can list members with write = true
  #members  any credential holder can list all members (did, read, write)
```

`listMembers` (or a new read-only counterpart served by the space host) then also accepts a space credential when the space's visibility allows it, and returns only what that visibility permits.

## Alternatives considered
- Application-level roster records (what we do). They work but duplicate state and need reconciliation.
- A `managing-app` policy. It moves the decision to the application and puts it in the read path, which is a different trade-off.

## Compatibility
Additive and opt-in. The default keeps today's privacy behavior.

## Open questions
- Should a member be able to opt out of being listed?
- Should changes be reflected in `notifyWrite`-style notifications so that apps do not have to poll the roster?

## Internal references (remove before filing)
`src/protocol/records.ts` (roster records), `src/operator/operations.ts` (`assertWorkspaceRosterMatchesPds`), `features/lifecycle-and-recovery.feature`.
