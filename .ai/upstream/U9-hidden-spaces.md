# Optional: let a space hide its existence from non-members

Status against `6747610566` + `opensocial.group` `8df0cc82` (R13, 2026-11-21): **Done.** Upstream `authorizeSpaceSync` answers `SpaceNotFound` for both missing spaces and unauthorized callers (`SpaceDeleted` first), and Flock's R13 `opensocial.group` implementation supports both `publicMeta: false` (omitting `group.opensocial.declaration/self` from `<groupDid>`'s public repo) and `policy.unlisted: true` (omitting private spaces such as `channel-<skey>` from `group.opensocial.space/*` in `members/self`).

Status against `5d88b414` (2026-10-30): Resolved for non-members. `getSpaceCredential` now checks the user before the app and answers `SpaceNotFound` both for a missing space and for a user the policy does not authorize; without a delegation token every non-public space also answers `SpaceNotFound`. `SpaceDeleted` is answered before any policy check, so a deleted space is still distinguishable. This closed our own credential probe for DM inboxes; see U11.

Status against `5b95b2f2`: Not affected. `getSpaceCredential` still distinguishes `SpaceNotFound` from `UserNotAuthorized`.

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

## Related work: opensocial.group
Adopted in Flock R13 (`apps/group-host` @ `opensocial.group/proposal` `8df0cc82`): discoverable groups publish `group.opensocial.declaration/self` (`publicMeta: true`), nondiscoverable groups omit `declaration/self` and set `meta/self` `publicRead: false` (`publicMeta: false`), and private modality spaces set `policy.unlisted: true` so they are excluded from `group.opensocial.space/*`.

## Internal references (remove before filing)
`docs/protocol/atproto-spaces-pin.md`, "Direct-message conformance" (existence oracle row).
