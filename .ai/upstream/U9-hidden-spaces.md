# Optional: let a space hide its existence from non-members

## Summary
A non-member can tell whether a space exists, because the credential exchange returns different errors for a space that does not exist, one that exists, and one that was deleted.

## Problem
Observed on `787a730f` at `getSpaceCredential` for an authenticated non-member:
- existing space: `UserNotAuthorized`
- missing space: `SpaceNotFound`
- deleted space: `SpaceDeleted`

Anyone who can guess a space URI can therefore confirm whether it exists. Our applications work around it with random, unguessable keys, and one space (a per-user inbox) has a well-known key by design. The richer errors are useful to authorized members (for example, telling "the other person has not replied yet" from "they left").

## Proposed change
An opt-in space setting (for example `discoverability: members`) under which the authority returns the same error for a missing space and an unauthorized caller. Members keep the specific statuses, since they are authorized before the state is revealed. The authority would need to keep a tombstone with its member list for a period after deletion for members to see `SpaceDeleted`.

## Alternatives considered
- Random keys only (what we do). Effective for unguessable keys, but it does not help spaces with predictable names.

## Compatibility
Additive and opt-in.

## Open questions
- The tombstone retention period, and the cost of keeping a member list for deleted spaces.
- Lower priority than the other requests. Included for completeness.

## Internal references (remove before filing)
`docs/protocol/atproto-spaces-pin.md`, "Direct-message conformance" (existence oracle row).
