# Validate third-party space records, and document the record-key filter

## Summary
The PDS validates only lexicons in its built-in schema map, so records for third-party space types are stored unchecked. Separately, its record-key filter rejects some randomly generated keys.

## Problem
1. **No dynamic validation.** Publishing our lexicons to the lexicon authority does not make them available for record validation, and writes report an unknown validation status. Every reader must therefore re-validate every record, and every writer must validate locally before writing. OAuth scopes already resolve the collections declared by a space type's lexicon dynamically, so the resolution machinery exists.
2. **Key filter.** The pinned PDS rejects record keys that match an explicit-slur filter. A contiguous base32 hash can trigger it by chance, and some keys we derive deterministically from hashes were rejected. We now insert a `:` between the symbols of every derived key, because the filter does not strip colons and the record-key syntax accepts them. That delimiter is now part of our published canonical key encoding and every interoperable client must reproduce it.

## Proposed change
1. When `validate: true` (or by space-type declaration), resolve the collections declared by the space type's lexicon and validate records against their schemas.
2. For record keys, either exempt keys of a collection whose lexicon declares a machine-generated key type, or document the exact rule and return a specific error code so clients can detect it and retry with a different key.

## Alternatives considered
- Keep local-only validation (what we do). It works but leaves every writer trusting every other reader's validation.

## Compatibility
Opt-in for item 1. Item 2 removes surprise failures.

## Open questions
- How stale a cached schema may be before writes are rejected.

## Internal references (remove before filing)
`docs/protocol/atproto-spaces-pin.md` ("Stable key encoding" and the paragraph on built-in schemas), `src/protocol/keys.ts` (`recordKeyHash`).
