# Let a space authority evict a writer from the tracked writer set

Status against `6747610566` + `opensocial.group` `8df0cc82` (R13, 2026-11-21): **Solved on Group Host (`apps/group-host`); narrow residual on personal-PDS `memberspace` DMs.** In R13, Flock's `opensocial.group` Group Host atomically evicts writers (`removeWriter` + `notifySpaceUpdate` `com.atproto.space.defs#repoRemoved`) whenever a member loses `write` on any group space—whether via `membership` deletion, role edit, `group.opensocial.policy` `updateSpace`, `leaveGroup`, or explicit `removeWriter`. On personal PDSes (`com.atproto.memberspace.policy`, used for sovereign DMs), `removeMembers` and `putMembers` (`write: false`) evict, while tightening `publicWrite: true -> false` via `updateSpace` still leaves prior `publicWrite` strangers tracked unless `removeWriter` is called explicitly.

Status against `5d88b414` (2026-10-30): Mostly resolved. `com.atproto.space.removeWriter` removes an account from the writer set (idempotent; the account is tracked again if it later writes while still authorized), and `memberspace.removeMember` and `putMember` with `write: false` now evict too. What remains is narrow: `updateSpace` does not re-evaluate the writer set, so a switch from a public to a member-list write policy leaves already-tracked strangers listed, and a `publicWrite` space tracks an evicted writer again on its next write, so a blocklist still needs an app-side filter. Our app keeps its sender filter for those two cases and drops nothing else.

Status against `5b95b2f2`: Still open. `simplespace.removeMember` only deletes the `simplespace_member` row; nothing removes a tracked writer, and `listRepos` (now keyed by `spaceRev`) keeps returning evicted writers. The only change is that a repo can reappear at a later `spaceRev`.

## Summary
Tightening a space's write policy, or removing a member's write access, stops *new* strangers from being tracked but leaves already-tracked writers in `listRepos` permanently. There is no call that removes them.

## Problem
Reproduction on `5d88b414`:
1. The owner creates a space with `publicWrite: true`.
2. An account on another host writes a record into its own repo in the space. The owner's `listRepos` lists that account.
3. The owner calls `updateSpace` with `publicWrite: false` (the policy is replaced wholesale).
4. `listRepos` still lists the account, and its later writes remain readable through the owner's credential. `removeMember` and `putMember` with `write: false` do evict now, and `removeWriter` exists, but a policy change alone does not re-evaluate the tracked writers.

Consequences for an application:
- The writer set can still hold strangers from a period when the space was open (for example an inbox that accepted requests from anyone), unless the owner enumerates and removes them.
- Applications keep an app-side sender filter and cap the scan to stay safe. In our app a single sender writing more records than the cap could take the owner's whole inbox view down until we added per-sender isolation.
- In a `publicWrite` space an evicted writer is tracked again on its next write, so a blocklist still needs an app-side filter.

## Proposed change
`com.atproto.space.removeWriter` now exists (idempotent; the account is tracked again if it later writes while still authorized). The remaining ask is narrow:

- State normatively that `updateSpace` to a stricter write policy does not by itself remove tracked writers, so applications know to call `removeWriter` per account, **or**
- add a documented bulk form such as `pruneWriters({ space, keep: 'authorized' })`, which removes every tracked writer that the current policy would not authorize.

## Alternatives considered
- Making `updateSpace` evict automatically. Simpler, but it silently changes what `listRepos` returns for spaces that want to keep a removed member's history discoverable. An explicit call avoids that. (`removeMember` already evicts; the app documents the cost, a departed member's earlier messages drop out of a rebuilt history.)
- Application-side blocklists. They hide senders but cannot stop the writer set from growing, and every application has to reimplement them.

## Compatibility
Additive. Existing spaces behave exactly as today until an owner calls `removeWriter` or the new bulk form.

## Open questions
- Should evicted writers' existing records stay readable to credential holders? (We would say yes: apps decide inclusion, as the proposal already says.)
- Should `pruneWriters` be part of the first version?

## Related work: opensocial.group
Adopted in Flock R13 (`apps/group-host` @ `opensocial.group/proposal` `8df0cc82`): losing `write` on any `group.opensocial.policy` space—via `membership` deletion, role edit, `updateSpace` policy change, or `leaveGroup`—atomically evicts the writer (`removeWriter` + `#repoRemoved`) while keeping member-authored records intact in the member's personal PDS repo.

## Internal references (remove before filing)
`apps/group-host/src/methods.ts`, `protocol-tests/atproto/slack-dm-conformance.test.ts` (policy switch checks); `docs/protocol/atproto-spaces-pin.md`.
