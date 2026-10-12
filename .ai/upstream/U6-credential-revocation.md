# Space credentials: strict expiry, per-space lifetime, and revocation

## Summary
A space credential carries no holder identity and is valid until it expires (default 2 hours), so removing a member cannot revoke a credential already issued. In the pinned implementation a credential is also accepted for a few seconds after `exp`.

## Problem
- After `removeMember`, the removed member can keep reading until their credential expires. For a private channel or a DM the owner cannot shorten that window.
- The credential deliberately does not name its holder (the user's DID is spent at mint time), so hosts have nothing to check a removal against.
- On `787a730f` the verifier allows about five seconds of clock skew after `exp`. Our requirement that access ends at expiry forced us to carry a local patch. That behavior should be a stated normative choice, not an implementation detail.

## Proposed change
1. State that a credential MUST be rejected at or after `exp` (skew tolerance applies to delegation tokens, client attestations and DPoP proofs only).
2. Add a per-space credential lifetime to the space configuration, bounded by the protocol (for example 5 minutes to 2 hours), so owners of sensitive spaces can choose shorter windows.
3. Optional, larger change: a membership epoch. The authority increments an integer in the space configuration whenever a read grant is removed, credentials carry it as a claim, and repo hosts compare it to the authority's current value (learned from `notifyWrite`-style pushes or a cached `getSpaceEpoch`) and reject older credentials after a grace period.

## Alternatives considered
- Very short lifetimes only (item 2). Simple, but costs one credential exchange per interval.
- Holder identifiers in credentials. Stronger, but it weakens the property that credentials do not identify the reader.

## Compatibility
Item 1 tightens behavior; items 2 and 3 are additive.

## Open questions
- Item 3 adds a dependency between repo hosts and the authority. Is the cost acceptable, given that "any repo host can verify without contacting the authority" is a current design goal?

## Internal references (remove before filing)
`protocol-tests/atproto/strict-credential-expiry.patch`, `docs/protocol/atproto-spaces-pin.md`, `SPEC.md` (credential expiry invariant).
