# R4 engine: working notes and progress

Working file for phase R4 of `.ai/plans/platform-refactor.md` (section "### R4", design in "Sync core", "Store",
"What the member routes do today"). Updated as steps land; the plan's outcome section gets the summary at the end.

## Module layout (`src/client/`, isomorphic, under the lint boundary)

| Module | Owns |
|---|---|
| `transport.ts` | `ClientDeps`: did, memberClient, resolvePds, resolveKemKey, fetchEndpoint, generateKey, now (DmDeps minus the key-value store) |
| `credentials.ts` | `CredentialCache` lifted from `DmClient.credentialFor`: one in-flight mint per space, renew before expiry, drop on refusal |
| `identity.ts` | `withIdentityCache`: a DID's host and KEM key held in the store for one truth interval, six resolutions at once per origin (K4) |
| `store.ts` | `SyncStore` interface; `WriterState` (coverage, cursor, syncedRev, generation, checkedAt), `SpaceState` (spaceRev, listed writers, workspace, lastOpenedAt); atomic compare-and-set commits by generation |
| `memory-store.ts`, `indexeddb-store.ts` | the two stores |
| `merge.ts` | k-way merge of sources by (key desc, uri asc); opaque `(key, uri)` cursor; generalizes `src/dm/merge.ts` |
| `sync.ts` | `SyncCore`: writer set (full `listRepos` at first open and each truth interval, hints by `spaceRev`), bracketed refresh, backfill, generations, set-aside, completeness, bounds |
| `lifecycle.ts` | the purge rules of the lifecycle table |
| `channel-client.ts`, `workspace-client.ts`, `operator-client.ts` | the route-table methods |
| `src/testing/fake-network.ts` | the general fake network (moved from `src/dm/testing/fake-pds.ts`) |

Sources: the sync core reads `(space, repo, collection)` sources. A channel is one space with many listed writers; a DM
conversation is several half spaces with one writer each (the owner), so DMs skip the writer set.

## Decisions taken while building

- A refresh replaces everything held for the writer and collection with one consistent listing, newest first, down to
  the writer's previous coverage (or one page for a new writer); held records below the new coverage are dropped.
- The backfill cursor is the cursor the host returned with the page that reached the coverage, stored with the writer
  state; the client never assumes the cursor is an rkey.
- Purges keep a writer-state tombstone with an advanced generation, so a refresh that started before a purge cannot
  commit after it; each space also has an epoch (advanced by a purge and by `clear`) that every read's commits carry, so
  a read that started before a purge cannot retry its way back into the purged space.
- One generation and one `syncedRev` per writer per space, with a coverage per collection: the revision belongs to the
  repo, so one bracket covers all of a writer's collections (K4's four calls per writer).
- "Checked in this session" is a set in memory, not a clock comparison: the first open of a space in a session checks
  each writer once, then the truth interval applies.
- A transient set-aside keeps showing what is held of the writer (as today); a permanent one purges it.
- Writes take a freshly minted credential (`CredentialCache.fresh`), as the routes did, so a write never relies on
  membership checked up to ten minutes earlier.
- `selectValidChannelMessages` breaks key ties by URI, so the engine and the independent reader order a page the same way.
- A refresh lists the window down to the lowest key the open view needs: the bottom of the latest page this session
  showed for the space (or the read's cursor when paging back); a writer's first listing, with no such floor yet, asks for
  its share of the page (at least ten records). Collections held in full are listed to their end, side by side with the
  window inside the one bracket. What was held below is dropped and backfilled again only if a read pages there. A new
  message costs two revision reads and one or two listings per collection, whatever the scroll depth. (The first gate run
  listed a full page from every writer on a first open, about 20,000 messages at the envelope, and the cold read missed the
  R0 baseline; this is the fix.)
- A listing whose `alongside` collection fails (a channel's or DM half's reactions) still commits the window under the same
  bracket and reports the writer as partial; a DM half then keeps its messages and is flagged missing, as before R4.
- The bound reserves each page's room before it is fetched; a listing that finds no room while others are fetching waits
  for those fetches. A collection held in full that a writer holds only in part is reported as cut on every read.
- The reader's own writer stays a source, and is not purged by a full listing, while one of its writes waits for the
  authority to list it (`SpaceState.ownWriteAt`), for at most one truth interval; after that an account the authority
  still does not list is out of view like anyone else (D14).
- A full `listRepos` marks moved writers stale like a hint; a purge of a writer during a read takes it out of that read.
- DM message history per half is bounded by the same 20,000 records; past it a read fails with a named error instead of
  ending silently (HEAD's DM reader had no message bound; recorded as a departure).
- The read re-sorts what a view's `select` returns into merge order, so a page and its cursor never disagree.
- The independent channel reader takes `SpaceCredentialDeps` like the DM reader, so it runs on the fake network and,
  later, as `packages/reader` with protocol-only dependencies.
- The operator client takes the operator's endpoint as configuration; resolving it from the operator DID's document
  comes with R5/R6 when the browser needs it.
- Collections held in full are listed at the host's largest page (1,000, `allPageSize`), as K4 asked; the window keeps
  pages of 100. At the envelope one writer holds all 20,000 reactions, which took 200 pages in sequence at 100 and is
  why the second gate run missed the R0 cold baseline (29.4 s median); at 1,000 it is 20 pages.
- DID resolution goes through the store (`withIdentityCache`), as K4 asked: a host and a KEM key stay current for
  `DID_DOCUMENT_TTL_MS` (ten minutes, the bound the browser's documents and the server's KEM keys already used, now one
  constant), across sessions; a failed MAC forces a fresh key; at most six resolutions run at once per origin in the process,
  and one not answered in ten seconds fails and frees its slot. `DmClient` uses it over its memory store. A longer TTL with
  re-resolution on a host's failure was built and reviewed, then dropped: following a moved account correctly needs a hook at
  every call to an authority's or writer's host (reads, `listRepos`, summaries, the credential exchange, DM headers), which
  is more than K4 asked for. Over a host resolver that caches documents itself (the browser's, ten minutes) a host can be
  served for up to twice the bound; KEM keys are unaffected, since a failed MAC skips both caches. A resolution still in
  flight at sign-out can write one public DID-to-host entry after the store was cleared.
- DM reads check every half each read (truth interval 0), since DM halves have no `listRepos` hint until R5/R6 add the
  feed; listings still happen only for halves whose revision moved.

## Steps

- [x] 1 store interface, memory store, IndexedDB store (`fake-indexeddb@6.2.6` dev dependency for its tests), shared contract `src/testing/store-contract.ts` (15 tests over both)
- [x] 2 merge order and `(key, uri)` cursor (`merge.ts`, 3 tests); `src/dm/merge.ts` deleted (dead after the DmClient move)
- [x] 3 general fake network (`src/testing/fake-network.ts`; createRecord, getServiceAuth, notify hook, listing lag, beforeListRecords, host down, call counts) and `src/testing/engine-fixture.ts`
- [x] 4 credential cache + sync core; `src/client/sync.test.ts` (16) and `sync-concurrency.test.ts` (8) pass
- [x] 5 lifecycle rules (`lifecycle.ts`; the credential cache's `onAccessLost` drops a refused or deleted space) + tests
- [x] 6 ChannelClient, WorkspaceClient, OperatorClient (`createEngine` wires them) + route-table tests (`channel-client.test.ts` 10, `workspace-client.test.ts` 7); `accept-errors`, `inbox-requests`, `ChannelUnavailableError`, `OperatorRemoteError` now owned by `src/client`
- [x] 7 DmClient on the credential cache and sync core; DM tests pass (one changed, see departures); DM UI no longer reads `nextBefore` as a key
- [x] 8 reader parity on the fake network (`reader-parity.test.ts`; `src/reader/independent.ts` now takes injected transports, `sessionCredentialDeps` builds them from a server session); writer-set and paging tests in `sync-concurrency.test.ts` and `channel-client.test.ts`
- [x] 9 protocol-tests: `engine-acceptance.test.ts` (parity on two real hosts) passes; `sync-budget.ts` drives the engine and gates the reopen call count (passed before the review fixes: 1 call at 20, 100 and 200 writers); `performance-envelope.test.ts` reads through the engine cold and warm (rerun on the final code at the gate)
- [x] review: round 1 (reviewer + critic) and round 2 (fix delta) findings fixed with tests; final gate running
- [x] 10 lint boundary, docs, CODE-MAP, plan outcome; late changes (reaction page size, identity cache) reviewed in four
  more rounds; final gate on the final code (unit 520, acceptance 13, browser 4, BDD 66, conformance 275, sync budget,
  performance)
- [ ] commit
