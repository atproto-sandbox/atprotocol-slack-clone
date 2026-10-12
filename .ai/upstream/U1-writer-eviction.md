# Let a space authority evict a writer from the tracked writer set

## Summary
Tightening a space's write policy, or removing a member's write access, stops *new* strangers from being tracked but leaves already-tracked writers in `listRepos` permanently. There is no call that removes them.

## Problem
Reproduction on `787a730f`:
1. The owner creates a space with `writePolicy: public`.
2. An account on another host writes a record into its own repo in the space. The owner's `listRepos` lists that account.
3. The owner calls `updateSpace` with `writePolicy: member-list`, or `removeMember` for a listed member.
4. `listRepos` still lists the account, and its later writes remain readable through the owner's credential. Accounts that were never tracked before the switch are correctly not tracked afterwards.

Consequences for an application:
- The writer set only grows. A space that was ever open (for example an inbox that accepts requests from anyone) can be filled with throwaway accounts, and the owner cannot shrink it.
- Applications must enumerate and filter every tracked writer forever, and cap the scan to stay safe. In our app a single sender writing more records than the cap could take the owner's whole inbox view down until we added per-sender isolation.
- The proposal says the writer set is "not itself authoritative". That is fine for discovery, but the authority is the only party that can know a writer is no longer welcome.

## Proposed change
Add an explicit owner-only procedure, and define the behavior around it:

```
com.atproto.simplespace.removeWriter
  input:  { space: space-ref, did: did }
  effect: the authority drops `did` from the tracked writer set, stops forwarding its
          notifyWrite, and omits it from listRepos until it is tracked again
          (a new authorized write under the current policy).
```

Also state normatively that changing `writePolicy` to a stricter value does not by itself retroactively remove tracked writers, so applications know they need `removeWriter` (or a documented bulk form such as `pruneWriters({ space, keep: 'authorized' })`, which removes every tracked writer that the current policy would not authorize).

## Alternatives considered
- Making `updateSpace` and `removeMember` evict automatically. Simpler, but it silently changes what `listRepos` returns for spaces that want to keep a removed member's history discoverable. An explicit call avoids that.
- Application-side blocklists. They hide senders but cannot stop the writer set from growing, and every application has to reimplement them.

## Compatibility
Additive. Existing spaces behave exactly as today until an owner calls the new procedure.

## Open questions
- Should evicted writers' existing records stay readable to credential holders? (We would say yes: apps decide inclusion, as the proposal already says.)
- Should `pruneWriters` be part of the first version?

## Internal references (remove before filing)
`protocol-tests/atproto/slack-dm-conformance.test.ts` (policy switch checks); `docs/protocol/atproto-spaces-pin.md`, "Direct-message conformance".
