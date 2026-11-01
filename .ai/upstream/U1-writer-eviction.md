# Let a space authority evict a writer from the tracked writer set

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
`ejectMember` and `leaveGroup` in the `opensocial.group` draft stop issuing new read credentials and say "existing space credentials expire normally"; ejection does not delete member-authored records. That matches the gap here: removal changes who may read from now on, but nothing tells the space host to stop tracking the removed account as a writer.

## Internal references (remove before filing)
`protocol-tests/atproto/slack-dm-conformance.test.ts` (policy switch checks); `docs/protocol/atproto-spaces-pin.md`, "Direct-message conformance".
