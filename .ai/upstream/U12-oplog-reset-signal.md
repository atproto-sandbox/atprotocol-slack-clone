# Tell an incremental syncer that its `since` revision is gone

Status against `5d88b414` (2026-11-09): Open. Measured by spike K5 of `.ai/plans/platform-refactor.md` (`protocol-tests/atproto/platform-spike-k5-oplog.test.ts`).

## Summary
`listRepoOps` answers a `since` revision that predates an `importRepo` or a `clearRecords` with an empty or partial list and no error, so an incremental syncer cannot tell "nothing changed" from "your checkpoint no longer exists".

## Problem
- `importRepo` and `clearRecords` delete the writer's whole oplog for the space and write no operation of their own; the repo moves to a new revision that no operation carries.
- After a reset, `listRepoOps` with an old `since` returns `ops: []` and the newer commit. If the writer has written again since the reset, it returns only the post-reset operations, and the last operation's revision equals the commit's, so a revision check cannot catch the gap.
- After `importRepo` the records survive but the oplog is empty, so a syncer that starts from the oplog sees one operation for a repo of many records.
- Today the only reliable detector is to recompute the set hash from everything held locally and compare it with the MAC-verified commit's `data`, then fall back to a full listing on mismatch. That works, but it turns a cheap incremental read into a full hash on every poll.
- `clearRecords` on a repo that already holds no records leaves the oplog in place with an unchanged revision (the early return when nothing was deleted), while the lexicon text says the oplog is cleared.

## Proposed change
1. When the history after `since` is not fully retained (a reset happened after it, or retention dropped operations after it), answer a distinct error (for example `SinceUnavailable`) instead of a list. A `since` that merely predates the repo's first operation, with nothing dropped in between, is answered as today.
2. Record a reset as an operation (or as a field on the commit) so a syncer reading forward from an old checkpoint sees it.
3. State the oplog's retention, so a syncer knows how stale a checkpoint may be.
4. Make `clearRecords` behave as documented on an empty repo, or document the exception.

## Compatibility
The error is new for requests whose history is incomplete. Some of those answers happen to be right today (after an `importRepo` of identical content, the post-import operations applied to a correct checkpoint reproduce the commit), so a syncer that gets the error resyncs where it did not strictly need to; it never gets a silently partial list. The reset marker is additive.

## Internal references (remove before filing)
Pinned `pds/src/actor-store/space/transactor.ts:314`, `:378-381`; `pds/src/api/com/atproto/space/listRepoOps.ts:46-77`. Spike report: K5 in `.ai/plans/platform-refactor.md`.
