@coordinator [done] Round 4 strictly read-only final delta verification of `.ai/plans/r11-tasks-progress.md` (Draft v4).

## Verification of Draft v4 Edits
All 4 Codex Round 3 items (`R3-M1`–`R3-M4`) are cleanly resolved and consistent with the codebase and pinned PDS (`5d88b414`):

1. **`R3-M1` — Exact 256 vs. 257 saturation boundary (`:110-122`, `:225-226`):** Normal regime holds cleanly through `<= 256` entries (`!op.sTruncated && op.s.length <= 256`), saturation triggers only on `> 256` (`|closure| > 256` / `op.s.length > 256`), `sTruncated: true`, or cycle detection, and `255` / `256` (final) / `257` (saturated, non-final) boundary tests are included in `entity-merge.test.ts` and `entity-merge-oracle.test.ts`.
2. **`R3-M2` — Overflow Tier 3 ranking for purged `opRef`s (`:118-120`, `:225`):** Tier 3 deterministically ranks live synced `opRef`s descending by `(t, repo, rkey)` first, then any remaining unresolved/purged `D14` `opRef`s by ASCII `opRef` hex string, with parity coverage after intermediate writer removal.
3. **`R3-M3` — Collection-aware `listRecords` pagination (`:62`, `:214-215`):** `assertBoundedRecordPage` (`packages/protocol/src/atproto/record-pages.ts:42-49`) uses composite `${record.collection}/${record.rkey}` duplicate detection when `collection` is omitted (covering shared `rkey`s across collections), and `FakeNetwork.listRecords` (`packages/testing/src/fake-network.ts:639-646`) orders and cursors by full record `uri` matching `../atproto-spaces-phase3/packages/pds/src/api/com/atproto/space/listRecords.ts:35`.
4. **`R3-M4` — `listRepos` call count & channel regression baseline (`:196-202`):** Cold/warm/incremental call budgets accurately reflect `2 listRepos` calls matching `listRepos.ts:21` + `listBoundedRepos` (`packages/protocol/src/atproto/record-pages.ts:108-111`), and channel regression checks compare identical per-phase call counts (`first open`, `reopen`, `one new message` across `20 / 100 / 200` writers) plus warm/cold latency thresholds against a same-host `84cfff4` baseline.

No remaining issues found.

**VERDICT: READY**
