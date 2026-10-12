# Expose a host-assigned revision on every record, and let readers bound a listing

## Summary
`listRecords` and `getRecord` return `collection`, `rkey`, `cid` and `value`. Nothing tells a reader when a record was written, so applications that order by time must trust the author-chosen key.

## Problem
- Chat-style apps use TID record keys as the ordering key and page "newest first". Record keys are chosen by the author, and hosts do not check them against any clock.
- A participant can write keys dated decades ahead and permanently occupy the top of the "latest N" page. Reproduced against the real validator and merge code: with a key 50 years ahead, a latest-4 page returned three attacker messages and one honest message. With enough such records the whole first page belongs to the attacker.
- The only defense available to an application is a reader-side rule ("ignore keys dated more than N minutes ahead of my clock"). We implemented and tested one, and an independent review showed it makes things worse: the hostile records are still returned first (newest first), so a reader has to page through all of them before reaching honest history. One attacker with many such records forced many sequential requests per read in the conversation reader, and made our server's channel sync fetch and cache up to its 20,000-record cap. `listRecords` has no key-range or seek parameter (only `cursor`, `reverse` and `limit`), so there is no way to skip a hostile key range. We backed the rule out.
- `listRepoOps` does carry a `rev` per operation, but the log is described as "recent writes" with no stated retention, so it cannot be used to order history.

## Proposed change
1. Add `rev` (the commit revision that last wrote the record, host-assigned) to the record view returned by `listRecords`, `getRecord` and the inlined values in `listRepoOps`.
2. State a minimum retention for the `listRepoOps` `since` log, or define an explicit "too old, resync" error, so incremental sync can rely on it.

3. Add a range bound to `listRecords` (for example `until` and `since`, by key or by `rev`), so a reader can ask for records at or below a chosen point and skip a hostile range in one request.

Applications can then order by `rev`, which the author does not control, and bound their reads. Cross-repo ordering still compares different hosts' clocks, but those are semi-trusted infrastructure, not the writer.

## Alternatives considered
- Per-application reader-side clock rules (what we do as a stopgap).
- Server-side rejection of non-current TID keys at write time. Stronger, but it constrains legitimate clients and does not work for non-TID keys.

## Compatibility
Additive fields.

## Open questions
- Whether the range bound should be by key, by `rev`, or both. (Keys sort by time for TIDs, but not for other key types.)

## Internal references (remove before filing)
`src/dm/merge.ts`, `src/workspaces/channel-sync.ts`; the backed-out interim rule and the review findings are in `.ai/reviews/2026-09-28-app-and-protocol-review.md` (F1).
