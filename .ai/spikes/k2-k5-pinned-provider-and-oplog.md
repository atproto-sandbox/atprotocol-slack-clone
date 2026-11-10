# Spikes K2 and K5 against the pinned atproto PDS (commit 5d88b414 + local credential patch)

Test files (source of truth in the app repo, copied byte-identical into the pinned checkout's `packages/pds/tests/space/`):

- `protocol-tests/atproto/platform-spike-k2-confidential-client.test.ts` (1 test, passes, ~4 s)
- `protocol-tests/atproto/platform-spike-k5-oplog.test.ts` (2 tests, pass, ~56 s)

Run (from the pinned root, Node 22.17.0): `NODE_OPTIONS=--experimental-vm-modules corepack pnpm@11.11.0 --filter @atproto/pds exec jest --watchman=false --runInBand tests/space/<file>.test.ts`. `tsc -p packages/pds/tsconfig.test.json --noEmit` is clean for both files (the only error is pre-existing, in `slack-dm-conformance.test.ts:83`). Both files were run repeatedly (K5 four full or partial invocations, K2 several); the deterministic results were identical every time, and the K5 timings below are from separate runs.

All paths below are relative to the pinned checkout (`packages/...`) unless stated.

---

## K2: confidential `private_key_jwt` client in the pinned test network

### Question
Can the pinned test network serve an OAuth client using `token_endpoint_auth_method: 'private_key_jwt'` outside loopback, so a confidential client's two-year session lifetime can be asserted in a conformance test?

### Answer
Yes, but only through discovery of an `https://` client_id whose metadata the PDS can fetch. In the test network the only workable way to serve that metadata is to intercept `globalThis.fetch`. A real local http(s) server cannot serve it. Both lifetimes and refresh enforcement were asserted end to end through the real `/oauth/token` endpoint.

### How client ids resolve (read from source, then confirmed by the test)
`oauth/oauth-provider/src/client/client-manager.ts:156-164` (`getClientMetadata`) picks exactly one branch:
1. loopback id: `getLoopbackClientMetadata`
2. `isOAuthClientIdDiscoverable(id)`: fetch the metadata document
3. else, if a `ClientStore` is configured: stored client
4. else `InvalidClientMetadataError('Invalid client ID "<id>"')`

Observed consequences (all asserted in the K2 test):

| client_id | result in the test network |
|---|---|
| `https://public-client.dev/client-metadata.json`, `https://confidential-client.dev/client-metadata.json` (metadata served via the fetch intercept) | resolves |
| `http://public-client.dev/client-metadata.json` | `InvalidClientMetadataError: Invalid client ID "..."` (not discoverable, no store) |
| `https://127.0.0.1/client-metadata.json` | same `Invalid client ID` (IP host rejected by schema) |
| `https://localhost/client-metadata.json` | same `Invalid client ID` (loopback host with https rejected) |
| `https://workspace.test/client-metadata.json` | `InvalidClientIdError: The client_id's TLD must not be a local hostname` |
| `http://localhost` (loopback id) | resolves, but `isConfidential === false`, session lifetime 14 days |

Source explaining each row:
- Discoverable-id schema: `oauth/oauth-types/src/oauth-client-id-discoverable.ts:9-66` (https only via `httpsUriSchema`, no credentials, no fragment, path must not be `/`, no trailing slash, no IP hostname, canonical form). `oauth/oauth-types/src/uri.ts:62-107` (`httpsUriSchema` rejects loopback hosts and single-label hostnames).
- Local-hostname rule: `oauth-types/src/util.ts:29-39` (`isLocalHostname`: single label, or TLD `test`, `local`, `localhost`, `invalid`, `example`), applied in `oauth-provider/src/client/client-utils.ts:24`.
- Loopback clients are forced public: `client-manager.ts:650-656` ("Loopback clients are not allowed to use token_endpoint_auth_method ...") and `atproto-loopback-client-metadata.ts` hard-codes `'none'`. So loopback can never be confidential.
- The PDS has no static client registry: `pds/src/account-manager/oauth-store.ts` does not implement `findClient`, so `clientStore` is null (`oauth-provider.ts:325` `ifClientStore(store)`) and branch 3 never fires.
- `private_key_jwt` metadata rules: `client-manager.ts:329-345` (needs `jwks` or `jwks_uri`, at least one key, and `token_endpoint_auth_signing_alg`). Also `dpop_bound_access_tokens` must be true.

### Why discovery needs the fetch intercept
- Test network disables SSRF protection: `dev-env/src/pds.ts:50` (`disableSsrfProtection: true`), which flips `allowHttp`, `allowCustomPort`, `allowPrivateIps` on in the PDS's `safeFetch` (`pds/src/config/config.ts:255`, `internal/fetch-node/src/safe.ts:53-65`). That relaxes the fetch layer only; it does not relax the client_id rules above, which still demand an `https://` URL with a public-looking domain.
- The PDS's `safeFetch` delegates to `globalThis.fetch` at call time (`pds/src/context.ts:353`), so replacing `globalThis.fetch` for exactly the metadata URL works. The test restores it in `finally`. All other URLs fall through to the real fetch. No real network access is needed, and `*.dev` hosts are never resolved.
- Even with a real server you could not use `https://localhost:<port>` (rejected as a local hostname). A TLS server with a public-looking name would additionally need DNS and a trusted cert. Not attempted.
- Denylist: `internal/fetch/src/fetch-request.ts:181-190` blocks `example.com`, `example.org`, `example.net` (and subdomains) and `googleusercontent.com` in the PDS fetch pipeline. The existing `slack-authority-oauth-conformance.test.ts` uses `https://slack.example/client-metadata.json` with a hand-built `Client`. That id could never be discovered (TLD `example`), and the client is public (`token_endpoint_auth_method: 'none'`), so that test exercises the 14-day public lifetimes, not a confidential grant. Implication for production: the authority client_id must be a real, publicly fetchable `https://` URL on a non-local TLD.

### Lifetimes (observed, asserted)
Constants: `oauth/oauth-provider/src/oauth-constants.ts:42` (`SESSION_LIFETIME` 2 weeks), `:45` (`REFRESH_LIFETIME` 2 weeks), `:51` (`SESSION_LIFETIME_EXTENDED` 2 years), `:57` (`REFRESH_LIFETIME_EXTENDED` 3 months), `:36` (`TOKEN_MAX_AGE` 60 min). Getters: `client/client.ts:80` (`isConfidential`: `token_endpoint_auth_method !== 'none'`), `:91-95` (`refreshLifetime`), `:101-105` (`sessionLifetime`).

| | session lifetime | refresh lifetime |
|---|---|---|
| public (`none`) | 14 days | 14 days |
| confidential (`private_key_jwt`) | 2 * 365.25 days | 3 months (365.25/4 days = 91.3125 days) |

Surprise worth carrying into the plan: the extended refresh lifetime is only 3 months, not 2 years. It is measured from the last rotation (`updatedAt`). A confidential authority grant must refresh at least every ~91 days or it lapses with "Refresh token expired" even with ~21 months of session left.

Also by reading (not run): `isFirstParty && isTrusted` also yields the extended lifetimes without `private_key_jwt` (`client.ts:92`, `:102`), but the pinned PDS `getClientInfo` hook returns only `isTrusted` (`pds/src/context.ts:429-433`), so `isFirstParty` stays false. `trustedClients` config therefore cannot buy the extended lifetimes.

### What was run
Test: `platform-spike-k2-confidential-client.test.ts`. Constructs nothing by hand: both clients are resolved by `oauth.clientManager.getClient()` from metadata served through the fetch intercept. The confidential client's metadata has `token_endpoint_auth_method: 'private_key_jwt'`, `token_endpoint_auth_signing_alg: 'ES256'`, inline `jwks` from `JoseKey.generate(['ES256'], 'client-assertion-key')`.

Minting: `oauth.tokenManager.createToken(...)` with a DPoP-bound parameter set (`scope: 'atproto'`). For the confidential client the `clientAuth` object comes from `client.authenticate()` on a signed `client_assertion` (so it is exactly the `{method:'private_key_jwt', alg, kid, jkt, jti, exp}` shape the provider produces; shape in `client/client-auth.ts:4-50`), not hand-built.

Refreshing: real HTTP `POST {issuer}/oauth/token` with JSON body, a DPoP proof from a separate key (the provider rejects a DPoP key equal to the client-assertion key, `oauth-provider.ts:466`), DPoP-Nonce retry, and for the confidential client a fresh `client_assertion` per request (jti replay check at `oauth-provider.ts:478`).

Time manipulation (feasible): the provider reads `new Date()` internally (`oauth-provider.ts:1078`) and measures a session against the stored `token.created_at` and `token.updated_at` (`validateRefreshGrant`, `oauth-provider.ts:1097-1118`; session age at `:1108`, refresh age at `:1113`). The test backdates those two columns directly through `network.pds.ctx.accountManager.db.db.updateTable('token')`, which is equivalent to waiting. No clock mocking was needed.

### Observed refresh results (each case on a freshly minted session, via `/oauth/token`)

| client | created ago | last refresh ago | result |
|---|---|---|---|
| confidential | now | now | 200, DPoP token, new refresh token, `expires_in` in (3590, 3600] |
| confidential | 400 days | 1 day | 200 (past the public session lifetime) |
| confidential | 2 years - 10 min | 1 day | 200, `expires_in` in (540, 600] (observed 599): access token clipped to remaining session (`token-manager.ts:53-70`) |
| confidential | 2 years + 1 day | 1 day | 400 `invalid_grant` "Session expired" |
| confidential | 80 days | 80 days | 200 |
| confidential | 100 days | 100 days | 400 `invalid_grant` "Refresh token expired" |
| public | 13 days | 13 days | 200 |
| public | 15 days | 1 day | 400 `invalid_grant` "Session expired" (the confidential 400-day case above succeeded) |
| confidential, no `client_assertion` | now | now | 400 `invalid_request` `client authentication method "private_key_jwt" required a "client_assertion"` |
| confidential, assertion signed by a key not in the jwks | now | now | 400 `invalid_client` `Validation of "client_assertion" failed: signature verification failed` |

Other observations:
- A refresh that fails validation after the refresh token is consumed deletes the whole session: asserted for the "Session expired" case (`findToken(refreshToken)` returns null afterwards); code at `oauth-provider.ts:1078-1091`. Authentication failures (missing or bad assertion) happen earlier, in `authenticateClient` at the top of `token()`, before the token is consumed; by reading, they do not delete the session (not asserted).
- For a public client the refresh-lifetime check is unreachable: both lifetimes are 14 days and `updatedAt >= createdAt`, so "Session expired" always fires first.
- The confidential client's tokens are minted via `tokenManager.createToken`, not via the authorization-code flow. The authorize, PAR, code, `/oauth/token` exchange for a discovered confidential client was NOT exercised. Not determined.

---

## K5: oplog behavior across resets, and the cost of listing 10,000 records

### (a) What `listRepoOps` returns after `importRepo` and `clearRecords`

Source (verified by reading, then by the test):
- `actor-store/space/transactor.ts:296-` `importRepo`: deletes `space_record_blob`, `space_record` and the whole `space_record_oplog` for the space (`:314`), inserts the archive's records with no oplog rows, and moves the repo to a new rev (`TID.nextStr(prev)`).
- `transactor.ts:364-` `clearRecords`: deletes records outside `keep`, then deletes the whole oplog for the space (`:381`), writes no ops for the deletes, and moves the repo to a new rev with the remaining records' set hash.
- `transactor.ts:378`: `if (deleted.numDeletedRows === 0n) return null` runs BEFORE the oplog delete.
- `transactor.ts:198-275` `applyWrites`: the only writer of oplog rows (`:275`).
- Reader: `actor-store/space/reader.ts:159-201`; `since` is just `rev > since` (`:185-186`) with no notion of retention. Handler: `api/com/atproto/space/listRepoOps.ts`; commit is withheld on a full page (`:49`) and the cursor is emitted only without a commit (`:72`).

Observed, all asserted (`platform-spike-k5-oplog.test.ts`, first test; one PDS, writer `dan` in `alice`'s space, read as a space-credential syncer):

clearRecords:
1. Writer writes `a`, `b`, `c`: `listRepoOps` returns 3 ops, commit at rev R0 (checkpoint).
2. After `clearRecords`: earlier ops are gone: `ops = []`, one page, commit rev R1 > R0, commit data equals the empty repo's (`new RepoCommit().matches(commit)`).
3. `since = R0` (a revision from before the reset): no error, `ops = []`, commit rev R1. Same for `since` = the first op's rev. It is an empty list, not an error and not a partial list.
4. Writer then writes `d`: `since = R0` returns a silently partial list: exactly one op, `d` (create, `prev: null`). The last op's rev equals the commit's rev, so a rev comparison cannot reveal the gap. A stale syncer that applies these ops onto its local `{a,b,c}` ends with a set hash that does NOT match the commit. The set-hash comparison is the only detector. A from-scratch pull (no `since`) returns only `[d]`, which is consistent after a clear (the clear emptied everything).
5. Weak signal available right after the reset, before any new write: `ops = []` while commit rev != `since` (in the no-change case commit rev == `since`).

importRepo (same account, same host, STAR from `getRepo` imported back):
1. Records survive (listRecords returns `a`,`b`,`c`) but the oplog is empty: the import writes no ops for them. `listRepoOps` returns `ops = []`, commit rev > R0, and the commit data equals the pre-import commit data (same contents).
2. `since = R0`: `ops = []`, commit rev = the new rev. No error.
3. After one more write `d`: `since = R0` returns `[d]`, and the syncer that kept its checkpoint is still correct (hash matches). A syncer starting from the retained window (no `since`) gets one op (`d`) for a four-record repo, and its set hash does NOT match the commit. So after an import, the oplog cannot bootstrap a syncer; it must start from `listRecords` or `getRepo`.

clearRecords on an already-empty repo (surprise, contradicts `clearRecords.json` "its oplog is cleared"):
- A repo whose only record was deleted holds two ops (create `x`, delete `x`). After `clearRecords`, the rev is unchanged and BOTH ops are still returned, because the `numDeletedRows === 0n` early return (`transactor.ts:378`) skips the oplog delete.

Not tested (read-only inference): in the authority's own repo `clearRecords` keeps `com.atproto.space.policy` and `com.atproto.memberspace.member` (`clearRecords.ts:38`, `keep`) but the oplog delete at `transactor.ts:381` is unconditional on collection, so by reading the oplog loses ops for the kept collections too. A `since` newer than head, a cross-host import (different rev lineage), and a malformed `since` were not run.

Design implication: the oplog has no reset marker. Any verified sync built on it must treat "applied ops produce the commit's set hash" as the only authoritative check, and fall back to `listRecords` + `getLatestCommit` (or `getRepo`) on mismatch, exactly as the pinned `sync.test.ts` "recovers from a pruned oplog" test already does for a hand-pruned oplog. The lexicon itself says the oplog is "a transport optimization with no history guarantee" and "does not survive account migration".

### (b) Cost of listing 10,000 records of one writer in one space

Setup: one writer, one space, one collection, 10,000 records written with 50 `applyWrites` batches of 200 (200 is the endpoint's maximum, `applyWrites.ts:19,69`). Each record is about 340 JSON bytes of value (`{$type, text: "<n> " + 240 chars, createdAt}`); createdAt fixed so CIDs and bytes are deterministic. Reads use a space credential from a P-256 key (the production syncer path, one signed request per page). TestNetworkNoAppView on SQLite (no `dbPostgresSchema`), loopback HTTP, rate limits off, one process.

Write time: 10,000 records in 50 applyWrites calls: 3.86 to 4.04 s (3855, 3927, 4036 ms over three runs), about 2,500 records/s.

`com.atproto.space.listRecords`, all collections, wall time over three consecutive runs per cell (ms), pages include the final empty page:

| mode | limit | pages | decoded response bytes | gzip wire bytes | wall ms (3 runs) |
|---|---|---|---|---|---|
| excludeValues | 1000 | 11 | 1,252,694 | 383,508 | 601, 583, 583 (earlier runs: 597/575/660, 821/632/610) |
| with values | 1000 | 11 | 4,631,584 | 438,956 | 835, 768, 813 (earlier: 684/684/695, 926/768/772) |
| excludeValues | 50 (default) | 201 | 1,303,614 | 433,766 | 5035, 4913, 5136 |
| with values | 50 (default) | 201 | 4,682,504 | 511,149 | 6217, 5376, 4947 |

Reading the table:
- Pages: 11 at limit 1000 and 201 at limit 50. The listing returns a cursor whenever a page is full (`api/com/atproto/space/listRecords.ts:35`), so an exact multiple costs one extra empty request (10 full pages plus one empty).
- Bytes: values multiply decoded bytes by about 3.7x (463 vs 125 bytes per record, i.e. metadata is about 125 bytes: collection, rkey, cid, JSON framing). Under gzip (which the PDS enables, `pds/src/index.ts:204`; the wire-byte column was measured by replaying the same page URLs over raw HTTP with `accept-encoding: gzip`), the gap collapses to 1.14x (439 KB vs 384 KB), but my payload is synthetic and repetitive (`lorem ipsum ` x20, identical createdAt), so real chat text will compress much less. Treat the gzip row as a best case for values.
- Time: at the maximum page size, 10,000 records list in roughly 0.6 s without values and 0.8 s with values. At the default page size the same listing takes about 5 s because per-request cost (signature creation and verification, HTTP round trip) dominates: about 24 ms per page at limit 50 versus about 55 to 75 ms per page at limit 1000. Wall time includes client-side JSON decode and lex validation in the same Node process as the server, and a `response.clone().arrayBuffer()` for byte counting, so it overstates a standalone client a little; it is a loopback figure, not network latency.

Extra measurements on the same 10,000-record repo (one run each, since asked only for context):

| call | pages | decoded bytes | wall ms |
|---|---|---|---|
| `listRepoOps` excludeValues, limit 1000, no `since` | 11 | 1,590,727 | 556 to 571 |
| `listRepoOps` with values, limit 1000 | 11 | 4,969,617 | 696 to 778 |
| `getRepo` (STAR archive, one request) | 1 | 3,519,210 | 307 to 420 |

Notes: `listRepoOps` carries 10,000 ops in 11 pages (the last page is the one that returns the commit; it is withheld on a full page, `listRepoOps.ts:49`). It is about 27% larger than `listRecords` per excludeValues page because each op also carries `rev` and `prev`. The "values" `listRepoOps` response inlines values only for ops whose record is still current (join on cid, `reader.ts:174-178`).

Assertions in the test are deterministic only (10,000 distinct records returned in every cell, values present only when requested, equal page counts across modes, values-mode decoded bytes more than 2x excludeValues, every `listRepoOps` op count and a final commit). Timings are printed (`K5_RESULT` line) and never asserted, to avoid flakes.

### Not measured
- Postgres-backed PDS, non-loopback network latency, concurrent readers, production rate limits, records larger or less compressible than ~340 bytes, a repo with multiple collections or heavy churn (the oplog here holds only creates).
- Cross-host `importRepo` (different rev lineage) and `importRepo` of an archive whose contents differ from what a syncer already holds. Only the same-host re-import was run; in that case the content was identical.
- Wire bytes for `listRepoOps` and `getRepo` (they need a MAC header; the byte counts above are decoded sizes).
