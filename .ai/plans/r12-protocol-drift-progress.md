# R12 Protocol Drift Plan & Progress (`bluesky-social/atproto#5187` @ `674761056`)

**Status:** Planned — ready for Codex + Claude Opus plan review
**Branch:** `chore/protocol-drift-6747610` in worktree `../atproto-slack-clone-r12`
**Baseline:** `origin/main` at `f4a4c16` (PRs #7 `feat/r10-interactions` -> `f7b7bdc` and #8 `feat/r11-tasks` -> `f4a4c16` merged cleanly; `908/908` unit/component tests green before drift)
**Target Upstream Pin:** `bluesky-social/atproto#5187` HEAD `6747610566eee1b6d743617bd8eb1136adccb362` (88 commits past `5d88b414`, built in sibling worktree `../atproto-spaces-r12`; `../atproto-spaces-phase3` remains untouched at `5d88b414`)
**Target NPM Snapshot:** `0.0.0-spaces-alpha-20261117141222` (published `2026-11-17T14:20:38Z`, matching commit `223114799`; zero diff against `674761056` across `lexicons/`, `@atproto/space`, `@atproto/star`, `@atproto/crypto`, `@atproto/xrpc-server`, `@atproto/oauth-client*`, and `@atproto/jwk-jose`)

---

## Locked Architectural Decisions (`D12.1`–`D12.12`)

### `D12.1` Pinning & Workspace Dependencies
1. **`ATPROTO_PINNED_CHECKOUT` & `codegen-lex.mjs`:**
   - Default/reference upstream checkout is `../atproto-spaces-r12` checked out cleanly at `6747610566eee1b6d743617bd8eb1136adccb362` (HEAD of PR `#5187` as audited in board `#147`). Leave `../atproto-spaces-phase3` untouched.
   - `scripts/codegen-lex.mjs` updates `expectedCommit` from `5d88b414a98de1ada22c94c78fa0667a7028163c` to `6747610566eee1b6d743617bd8eb1136adccb362`.
   - Update `docs/protocol/atproto-spaces-pin.md` with the new commit, alpha snapshot timestamp, patch SHA-256, and protocol delta notes.
2. **NPM Snapshot Equivalence & Exact Package Pins:**
   - All `@atproto/*` alpha packages on npm (`dist-tags.alpha = 0.0.0-spaces-alpha-20261117141222`) match commit `223114799`. Across `223114799..674761056`, `git diff` is **empty** across `lexicons/`, `packages/space/`, `packages/star/`, `packages/crypto/`, `packages/xrpc-server/`, `packages/oauth/oauth-client`, `packages/oauth/oauth-client-node`, `packages/oauth/oauth-client-browser`, `packages/oauth/jwk-jose/`, and `packages/oauth/oauth-provider/`. The post-alpha commits (`#5929` `lex-space`/`lex-builder` + `space-permission.ts` wildcard `collection: '*'`; `#5932` PDS `safeClient` webhook hardening, `importRepo`, and taken-down/deactivated authority handling on `notifyRepoUpdate`) run inside the built `../atproto-spaces-r12` PDS during conformance/acceptance/browser/BDD gates. Meanwhile, `@atproto/lex-cli@0.0.0-spaces-alpha-20261117141222` and `@atproto/lex-schema@0.0.0-spaces-alpha-20261117141222` share the exact `223114799` `l.space(key, $nsid, collections, options)` signature (`title`, `'title:lang'`), avoiding any generated-type skew.
   - Pin all workspace `@atproto/*` dependencies consistently to `0.0.0-spaces-alpha-20261117141222` across `package.json`, `packages/*/package.json`, and `apps/*/package.json`:
     - Root `package.json`: `@atproto/crypto`, `@atproto/jwk-jose`, `@atproto/oauth-client-node`, `@atproto/xrpc-server`, and devDependency `@atproto/lex-cli` -> `0.0.0-spaces-alpha-20261117141222`.
     - `@flock/protocol`: `@atproto/crypto`, `@atproto/lex-data`, `@atproto/lexicon`, `@atproto/space`, `@atproto/xrpc` -> `0.0.0-spaces-alpha-20261117141222`, plus NEW direct dependency `@atproto/star: "0.0.0-spaces-alpha-20261117141222"`.
     - `@flock/reader`: `@atproto/lex-data`, `@atproto/lexicon`, `@atproto/space` -> `0.0.0-spaces-alpha-20261117141222`.
     - `@flock/client`: `@atproto/crypto`, `@atproto/oauth-client-node` -> `0.0.0-spaces-alpha-20261117141222`.
     - `@flock/testing`: `@atproto/crypto`, `@atproto/lex-data`, `@atproto/lexicon`, `@atproto/space` -> `0.0.0-spaces-alpha-20261117141222`, plus NEW direct dependency `@atproto/star: "0.0.0-spaces-alpha-20261117141222"`.
     - `@flock/operator`: `@atproto/identity`, `@atproto/jwk-jose`, `@atproto/oauth-client-node`, `@atproto/xrpc-server`, `@atproto/crypto`, `@atproto/space` -> `0.0.0-spaces-alpha-20261117141222`.
     - `@flock/web`: `@atproto/oauth-client-browser`, `@atproto/crypto` -> `0.0.0-spaces-alpha-20261117141222`.
   - Update `pnpm-workspace.yaml` `minimumReleaseAgeExclude` (and clean `overrides`) to list all direct and transitive `0.0.0-spaces-alpha-20261117141222` packages (`@atproto/{car,common,common-web,crypto,did,identity,jwk,jwk-jose,jwk-webcrypto,lex-builder,lex-cbor,lex-cli,lex-client,lex-data,lex-document,lex-installer,lex-json,lex-schema,lex-space,lexicon,oauth-client,oauth-client-browser,oauth-client-node,oauth-scopes,oauth-types,space,star,syntax,ws-client,xrpc,xrpc-server}` and `@atproto-labs/{did-resolver,fetch-node,handle-resolver,handle-resolver-node}`). Verify `pnpm-lock.yaml` contains zero stale `0.0.0-spaces-alpha-20261029171913` entries and zero duplicate versions of any alpha package.

### `D12.2` Strict Credential Expiry Patch (`protocol-tests/atproto/strict-credential-expiry.patch`)
1. Upstream `packages/space/src/credential.ts` (`verifySpaceToken`) still uses `if (now - CLOCK_SKEW_SEC >= payload.exp)` for all token types, and PR `#5924` moved `packages/space/tests/credential.test.ts` to `packages/space/src/credential.test.ts`.
2. Rebase `protocol-tests/atproto/strict-credential-expiry.patch` cleanly onto `674761056`:
   - Apply the exact credential-only strict expiry guard (`const expirationSkew = type === 'credential' ? 0 : CLOCK_SKEW_SEC`) in `packages/space/src/credential.ts`.
   - Update `packages/space/src/credential.test.ts` (delegation skew test + strict `credential` expiration test at `exp * 1000`).
3. Apply the rebased patch inside `../atproto-spaces-r12`, build `../atproto-spaces-r12`, verify its `@atproto/space` tests pass, and update the documented SHA-256 in `docs/protocol/atproto-spaces-pin.md`.
4. Note for runtime verification: upstream `dev-env` PDS (`packages/dev-env/src/pds.ts`) sets `devMode: true` and `disableSsrfProtection: true`, enabling webhook callbacks (`http://127.0.0.1` / loopback) during local acceptance/BDD/protocol suites.

### `D12.3` Webhook Notifications (`authorizeSpaceSync`, `confirmRegistration`, `notifySpaceUpdate`, Continuous Renewal, Stateless DM Tokens)
Upstream removed `com.atproto.space.registerNotify`, `com.atproto.space.unregisterNotify`, and `com.atproto.space.notifySpaceDeleted`, and renamed `notifyWrite` -> `notifyRepoUpdate` (PDS-to-authority only). App syncers now register inline via `authorizeSpaceSync` (`notify: { endpoint, token }`), respond to PDS synchronous challenge `confirmRegistration`, and receive `notifySpaceUpdate` (`#repoWrite` | `#repoRemoved` | `#spaceDeleted` | `#registrationExpired`). Every webhook registration expires with the space credential (`10 min` default!).

1. **Removed XRPC & Internal Protocol Methods:**
   - Remove `registerNotify`, `unregisterNotify`, and `notifySpaceDeleted` from `NOTICE_METHOD` (`packages/protocol/src/nsids.ts`), `apps/operator/src/operator/{space-notification.ts,server.ts,registrations.ts}`, `packages/client/src/dm/dm-client.ts`, and copied upstream lexicon JSONs.
   - Add `confirmRegistration: "com.atproto.space.confirmRegistration"` and `notifySpaceUpdate: "com.atproto.space.notifySpaceUpdate"` to `NOTICE_METHOD` / operator XRPC server routes (`auth: undefined`; authenticated per-space via constant-time shared `token` verification).
2. **Operator Space DB & Zero-Race Registration (`apps/operator/src/lib/db.ts`, `registrations.ts`, `main.ts`):**
   - Add DB migration adding `token TEXT NOT NULL DEFAULT ''` and `pending_token TEXT NOT NULL DEFAULT ''` to `notification_registration` (preserving existing PK `(service_ref, space_uri)`).
   - **Pre-authorize token persistence:** Before calling `authorizeSpaceSync` with `notify: { endpoint: operatorUrl.origin, token }`, generate a fresh 32-byte random base64url `token` and stage it in `notification_registration` (`pending_token = newToken` when updating an existing row, or insert `(service_ref, space_uri, expires_at = 0, token = newToken, pending_token = '')` for new spaces). That guarantees PDS's synchronous `confirmRegistration({ space, token, challenge })` callback succeeds *inside* `authorizeSpaceSync` while never clobbering a live `token` if renewal fails transiently. Upon `authorizeSpaceSync` success, promote `token = newToken, pending_token = '', expires_at = credentialPayload.exp * 1000`. If initial insertion fails (`SpaceDeleted`/refusal), clean up the unstamped placeholder row.
   - **Continuous renewal for 10-minute registrations (`registrations.ts`, `main.ts`):**
     - Upstream registrations expire when the space credential expires (`600 s` / `10 min` by default). Shrink `RENEW_WITHIN_MS` from `6 * 60 * 60 * 1000` to `3 * 60 * 1000` (`3 min` before `expires_at`) and `SWEEP_INTERVAL_SECONDS` from `1800` to `60` (`60 s`).
     - Start a background registration sweeper (`setInterval(..., 60_000).unref()`, guarded by the existing registration lease so overlapping ticks/processes never double-run, and cleared on shutdown) inside `apps/operator/src/operator/main.ts` so active workspace/channel/inbox/ext registrations continuously renew (~every 7 min) even when no requests hit `registerSpace`.
   - **`unregisterSpace` & stopped spaces:** Delete the `(service_ref, space_uri)` row from `notification_registration` (no PDS call). Any later PDS callback for an unregistered space returns **HTTP 400** (`InvalidRequestError`), causing upstream PDS (`SpaceNotifications`) to drop the registration immediately without retry loops.
3. **`confirmRegistration` & `notifySpaceUpdate` Handlers (`apps/operator/src/operator/notices.ts`, `server.ts`):**
   - Validate `(space, token)` with `crypto.timingSafeEqual` (pad/length-check safely so timing never leaks) against `(token, pending_token)` in `notification_registration` OR stateless DM HMAC derivation (`dm.*`).
   - Unknown space or mismatched/empty token -> **HTTP 400** (`InvalidRequestError`) so stale/unregistered/revoked PDS webhooks terminate cleanly.
   - On `confirmRegistration({ space, token, challenge })`: valid token -> `{ challenge }`.
   - On `notifySpaceUpdate({ space, token, update })`:
     - **`com.atproto.space.defs#repoWrite`:** Call `recordWriteNotification({ space, repo: update.repo, rev: update.repoRev, spaceRev: update.spaceRev, prevSpaceRev: update.prevSpaceRev, data: update.data })` (note field rename `rev` -> `repoRev` on wire).
     - **`com.atproto.space.defs#repoRemoved`:** Record a non-destructive space-change wake notice in `space_notification` (`repo: update.repo, rev: "", spaceRev: update.spaceRev, prevSpaceRev: update.prevSpaceRev`) and wake feed followers so clients immediately reconcile `listWritersSince` and prune the removed writer without misreading absence as missing-writer error.
     - **`com.atproto.space.defs#registrationExpired`:** For operator-managed spaces, mark `expires_at = Math.min(expires_at, Date.now())` and trigger an out-of-band asynchronous `renewSpaceRegistration(space)` immediately while still waking feed followers (return `200 {}` cleanly so PDS doesn't treat expiration delivery as server error). For DM spaces (`dm.*` token), return **HTTP 400** (`InvalidRequestError`) so closed tabs stop receiving PDS notifications while active browser tabs handle their own re-authorization (below).
     - **`com.atproto.space.defs#spaceDeleted`:** After validating `(space, token)` (plus confirming `SpaceDeleted` against the authority when an active authority grant exists for that space so a live space is never mistakenly purged), call `purgeSpaceNotifications(space)`, `dropMemberList(space)`, and delete `notification_registration`. (`dm.*` `#spaceDeleted` wakes open followers without persisting DB state and returns `200 {}`.)
4. **Stateless DM Space Notifications (`D12.3b` — Operator Zero-DM-Storage Invariant):**
   - Preserve the `db-member-tables.test.ts` / `ARCHITECTURE.md` invariant: the operator SQLite DB stores **zero** DM space rows, **zero** DM membership, and **zero** DM content (`space_notification` only stores `(space_uri, repo_did, rev, space_rev)` wakes as already established).
   - Add authenticated operator query/procedure `new.flock.operator.getDmNotifyTarget` (`packages/protocol/lexicons/new/flock/operator/getDmNotifyTarget.json`, `OPERATOR_METHOD.getDmNotifyTarget`, `packages/protocol/lexicons/new/flock/permissions/{member,workspaceAuthority}.json`, `dmScopes` in `packages/protocol/src/scopes.ts` — keep `DM_BROWSER_SCOPES` unchanged and do NOT add to `appGrantScopes`).
   - Guard `getDmNotifyTarget({ space })` with service-auth + `authorizeDmSubscription(space, callerDid)`. Derive deterministic constant-time token using HKDF-SHA256 from `AUTH_ENCRYPTION_KEY` (`"flock-dm-notify-v1"`): `"dm." + base64url(hmacSha256(dmNotifyKey, space))`. Return `{ endpoint: operatorUrl.origin, token }`.
   - `DmClient.watch(spaces, opts?: { signal?: AbortSignal })` in `packages/client/src/dm/dm-client.ts` (replacing `serviceRef` usage; accept optional `getNotifyTarget` dependency or call `operatorClient.getDmNotifyTarget(space)`):
     - Fetches & caches `{ endpoint, token }` per watched DM space.
     - Passes `notify: target` through `CredentialCache.get(space, { notify: target })`. `CredentialCache` stores `{ ...entry, notify }`; if a cached entry exists *without* `notify` when `watch` passes `notify` (or if `notify` changed), `CredentialCache` mints a fresh credential via `authorizeSpaceSync` once so the PDS registers the webhook.
     - Runs a clean periodic renewal loop while `watch` is active (before cached `exp`, e.g., within 3-min window, bound to `opts?.signal` / `.unref()` on timers so React unmounts in `apps/web/src/app/ui/dm-context.tsx` & `dm-conversation.tsx` and short-lived tests never leak handles).
     - Incoming DM `notifySpaceUpdate` (`#repoWrite` / `#repoRemoved` / `#spaceDeleted`) records change-counter notice and wakes `ChangeFollower` (`getChanges`) exactly as before.

### `D12.4` HTTP Message Signature Credential Binding & RFC 9421 MACs (`@atproto/space`)
1. **Outbound `Atproto-Space` Request Signatures (`packages/protocol/src/atproto/space-credential-core.ts`):**
   - `createSpaceSigHeaders` signature changed: `createSpaceSigHeaders({ authorization, audience: hostDid, keypair })` returning `{ headers }` (note `'sig'` label; `keypair` inside the options object).
   - Remove the old `(opts, keypair)` 2-argument call style everywhere (`space-credential-core.ts`, `FakeNetwork` helper tests).
2. **Inbound Verification (`packages/testing/src/fake-network.ts`, tests):**
   - `verifyCredentialSig(headers, keyDid)` verifies RFC 9421 credential binding (`tag="atproto-space-credential"`).
3. **RFC 9421 Commit & Record MACs (`#5862`, `#5865`):**
   - Replace custom `Atproto-Space-Mac` / `macRequest` headers with RFC 9421 headers from `@atproto/space`:
     - Request header: `Accept-Signature: ${formatMacRequest(profile, macKeyPair.did())}` (`COMMIT_MAC_PROFILE = "atproto-space-commit"`, `RECORD_MAC_PROFILE = "atproto-space-record"`).
     - Response headers: `Atproto-Space-Commit` (or `Atproto-Space-Record`), `Signature-Input`, `Signature`.
     - Server parsing/signing: `parseMacRequest(req.headers["accept-signature"], profile)`, `createCommitMacHeaders(commit, { secret, clientKeyShare, kemKeypair })`, `createRecordMacHeaders(uri, cid, { secret, clientKeyShare, kemKeypair })`.
     - Verification: `verifyCommitMac(commit, params)` and `verifyRecordMac(uri, cid, params)` along with `verifyCommit(commit, params)` and `verifyRecord(record, params)` now **throw** (`SpaceMacError` / `SpaceRepoVerificationError`) on failure rather than returning `boolean`! Wrap calls cleanly with explicit error mapping so existing `SpaceVerificationError` / classification semantics remain clear and tested.
   - **HPKE Domain Separation (`#5865`):** `@atproto/space` passes `info: "atproto-mac"` internally in `createCommitMacHeaders`/`createRecordMacHeaders`/`verifyCommitMac`/`verifyRecordMac`/`unwrapMacKey`. Update `space-credential-core.ts` & `FakeNetwork` so zero manual raw-ECDH / pre-#5865 key unwrapping diverges from `@atproto/space`.
   - **Error & CORS Header Parity (`packages/testing/src/fake-network.ts`):** Expose `atproto-space-commit`, `atproto-space-record`, `signature-input`, `signature` in `Access-Control-Expose-Headers` and `Accept-Signature` in `Vary` + CORS allowed request headers (matching upstream `cors` middleware for browser Playwright tests `cross-origin.spec.ts` / `real-client.spec.ts`!).

### `D12.5` STAR Framing (`@atproto/star`), `getRepo`, & Size Accounting
1. Update `packages/protocol/src/atproto/space-credential-core.ts`:
   - `serializeRepo` -> `writeRepoStar(commit, entries)` (`@atproto/space`).
   - `RepoVerificationError` -> `SpaceRepoVerificationError` (`@atproto/space`).
   - `LTHASH_STATE_BYTES` is no longer exported from `@atproto/space`; derive `export const LTHASH_STATE_BYTES = new LtHash().state().byteLength` (2048).
   - Send `Accept: application/vnd.dasl.star` on `com.atproto.space.getRepo` requests; accept `application/vnd.dasl.star` responses cleanly.
   - **Exact STAR framing byte accounting (`starEntryBytes`):** `@atproto/star` `0.0.0-spaces-alpha-20261117141222` prepends `0x01` (`CONTROL_PAIR`) before each record pair and appends `0x00` (`CONTROL_END`) at EOF. Because `starHeaderBytes(commit)` calls `writeRepoStar(commit, [])` (which includes the trailing `0x00` EOF byte), `starEntryBytes(collection, rkey, recordBytes)` MUST add `+ 1` (`1 + entryHeaderBytes + cidBytes + recordByteLength`) so `starHeaderBytes(commit) + sum(starEntryBytes(...))` equals `writeRepoStar(commit, records).byteLength` **byte-for-byte**. Lock this with a unit assertion in `space-credential-core.test.ts`.

### `D12.6` Writer Set (`listWriters`), Incremental Sync (`#repoWrite` / `#repoRemoved`), & Takedown Parity (`#5810`)
1. **`listRepos` -> `listWriters` (`record-pages.ts`, `sync.ts`, `independent.ts`, `independent-tasks.ts`, `dm-client.ts`, `apps/operator`, `FakeNetwork`):**
   - Discriminate `page.repos` entries by `$type`:
     - `com.atproto.space.defs#repoWrite`: `{ repo, repoRev, spaceRev, data }` (`did` renamed to `repo`!).
     - `com.atproto.space.defs#repoRemoved`: `{ repo, spaceRev }`.
   - Keep `page.repos.length < limit` pagination termination (upstream `listWriters.ts` STILL sets `cursor: writers.at(-1)?.spaceRev` whenever `writers.length > 0`).
   - Rename `listReposSince` -> `listWritersSince` returning discriminated `WriterUpdate` entries (`{ kind: "write", repo, repoRev, spaceRev, data } | { kind: "removed", repo, spaceRev }`).
   - On `#repoRemoved` during incremental `listWritersSince`: remove that repo from the active writer set and evict cached repo records/state cleanly without calling `getRepo`/`listRepoOps` (preventing spurious `RepoNotFound` failures). On full listing (`cursor === undefined`), only `#repoWrite` entries form the current writer set (`#repoRemoved` entries in full listing remain ignored/treated as absent, since `#repoRemoved` represents prior eviction history in the `space_rev` log).
2. **Non-Destructive Authority Takedown/Deactivation (`#5810`):**
   - `authorizeSpaceSync` and `listWriters` return `400 RepoTakendown` / `400 RepoDeactivated` when the *space authority* account itself is taken down or deactivated.
   - Ensure neither `RepoTakendown` nor `RepoDeactivated` is included in `CREDENTIAL_REFUSALS` / `isAccessLost` / `isSpaceDeletedError`. Keep previously synced workspace/channel/task data intact and surface the authority suspension as a temporary degraded/unavailable error until reactivated (extending `repo-failure.ts` / `accept-errors.ts` / `member-access.ts` / tests).

### `D12.7` `listRepoOps` Every-Page Commit + `RepoNotFound` Simplification (`#5877`)
1. Upstream `#5877` returns a signed/MAC'd `commit` on **every** `listRepoOps` page (including intermediate cursor pages and empty sets) and returns `400 RepoNotFound` for accounts that have never written to the space.
2. Simplify `packages/protocol/src/atproto/space-credential-core.ts`, `packages/protocol/src/atproto/record-pages.ts`, and `packages/client/src/sync.ts`:
   - **Remove `UnsignedEmptyRepoOpsError`** and all intermediate/empty unsigned-commit special cases from `space-credential-core.ts`, `sync.ts`, and `space-credential-core.test.ts`.
   - Always require and verify `commit` + MAC on EVERY `listRepoOps` page returned (`fetchWithVerifiedMac` unconditionally verifies `Atproto-Space-Commit` MAC + `verifyCommit`).
   - Verify `fetchRepoOpsPages` handles multi-page `listRepoOps` where intermediate pages carry `commit`: verify `commit` + MAC per page and validate/use the final page's `commit` (the page where `cursor === undefined`) as the terminal committed `rev`/`data`/`root`!
   - When `listRepoOps` returns `RepoNotFound`, preserve `XrpcFailure` (`error: "RepoNotFound"`) through `fetchRepoOpsPages` and classify via `classifyRepoFailure` / existing `!listed && prevRev === null` logic (`empty` if unwritten/unlisted, `setAside` if previously listed/synced).

### `D12.8` Batch Membership (`putMembers` / `removeMembers`) & Space Field / Error Renames
1. **Batch Membership Procedures (`apps/operator/src/atproto/space-ops.ts`, `apps/operator/src/operator/members.ts`, `packages/client/src/dm/dm-client.ts`, `apps/operator/src/operator/testing/fake-authority-pds.ts`):**
   - Replace `com.atproto.memberspace.putMember` / `removeMember` with `putMembers` (`{ space, members }`) and `removeMembers` (`{ space, dids }`), chunking arrays to `<= 100` items per XRPC call (lexicon `maxLength: 100`).
   - Preserve step granularity/idempotency semantics in `apps/operator/src/operator/kinds/` (do NOT rename Flock's persisted `OperationRequest.kind = "removeMember"` in `execute.json` / `kinds.test.ts`!). Update `FakeAuthorityPds` and tests accordingly.
   - `com.atproto.memberspace.listMembers` items now use `$type: "com.atproto.memberspace.defs#member"`.
2. **Field & Parameter Renames (`uri` -> `space`, `did` -> `spaceDid` / `repo`, drop `reverse`):**
   - `com.atproto.space.createSpace` & `getSpace`: output field `uri` -> `space`!
   - `com.atproto.space.listSpaces`: parameter `did` -> `spaceDid` (`com.atproto.space.listSpaces` view `uri` -> `space`, plus optional `repoRev`, `data`, `spaceRev`). Keep `FakeNetwork` aligned.
   - `com.atproto.space.removeWriter`: input `did` -> `repo`.
   - `com.atproto.space.listRecords`: remove `reverse` parameter from calls/types (`record-pages.ts`, `FakeNetwork`).
   - `com.atproto.space.defs#repoWrite` / `repoRemoved` / `recordOp` / `notifyRepoUpdate`: `did` -> `repo`, `rev` -> `repoRev` on wire.
3. **Error Code Renames:**
   - `NotSpaceOwner` -> `NotAuthorized`
   - `UserNotAuthorized` -> `AccountNotAuthorized`
   - `BadSpaceMac` -> `InvalidSpaceMac`
   - `MalformedCursor` -> `InvalidCursor`
   - `notifyCredentialRevoked` -> `notifyCredentialsRevoked` (lexicon sync).

### `D12.9` App-Password Restriction Parity (`ACCESS_FULL` in `#5923`)
1. Upstream `#5923` requires `ACCESS_FULL` (refusing all app passwords — even privileged ones — with `InvalidToken: Bad token scope`) across ALL `com.atproto.space.*` and `com.atproto.memberspace.*` endpoints (`createSpace`, `getSpace`, `listSpaces`, `createRecord`, `putRecord`, `deleteRecord`, `clearRecords`, `applyWrites`, `getRecord`, `listRecords`, `getLatestCommit`, `listRepoOps`, `getRepo`, `listWriters`, `getDelegationToken`, `putMembers`, `removeMembers`, `listMembers`, etc.), while `com.atproto.server.getServiceAuth` continues to work for app passwords.
2. Update `FakeNetwork` (`packages/testing/src/fake-network.ts`) to enforce this exact `ACCESS_FULL` / app-password refusal (`InvalidToken`, `"Bad token scope"`) on all `com.atproto.space.*` and `com.atproto.memberspace.*` routes, and update `protocol-tests/platform-capabilities.test.ts` (K7 test lines 50–76) to verify both `com.atproto.space.createRecord` and `authorizeSpaceSync`/`getDelegationToken` reject app-password sessions with `Bad token scope` while `getServiceAuth` still succeeds — proving bots MUST use OAuth (`createActor` / browser-style OAuth grant), never app passwords.

### `D12.10` Space Lexicons (`"name"` -> `"title"`) & `new.flock.operator.getDmNotifyTarget`
1. Upstream `#5812` replaced `"name"` with `"title"` (optional 1..64 char string shown on OAuth consent screens) on lexicon `"type": "space"` definitions (`lexicon-document.ts`).
2. Rename `"name"` -> `"title"` in all 7 space lexicons under `packages/protocol/lexicons/new/flock/`:
   - `workspace.json`
   - `channel.json`
   - `inbox.json`
   - `app/inbox.json`
   - `ext/tasks.json`
   - `dm/inbox.json`
   - `dm/conversation.json`
   (Leave Flock's own *record* schemas, UI props, directory fields, `workspace.name`, `channel.name`, `createChannel.name`, etc. untouched!)
3. Sync copied `packages/protocol/lexicons/com/atproto/{space,memberspace}/*.json` from `../atproto-spaces-r12/lexicons/com/atproto/{space,memberspace}/` (deleting removed files `getSpaceCredential.json`, `listRepos.json`, `notifyCredentialRevoked.json`, `notifySpaceDeleted.json`, `notifyWrite.json`, `registerNotify.json`, `unregisterNotify.json`, `putMember.json`, `removeMember.json`, and adding `authorizeSpaceSync.json`, `confirmRegistration.json`, `defs.json` in `memberspace`, `listWriters.json`, `notifyCredentialsRevoked.json`, `notifyRepoUpdate.json`, `notifySpaceUpdate.json`, `putMembers.json`, `removeMembers.json`).
4. Add `packages/protocol/lexicons/new/flock/operator/getDmNotifyTarget.json` and include `"new.flock.operator.getDmNotifyTarget"` in `packages/protocol/lexicons/new/flock/permissions/{member,workspaceAuthority}.json` so `scope-lexicons.test.ts` passes cleanly. Run `pnpm codegen:lex` to regenerate `packages/protocol/src/lexicons/`.

### `D12.11` `@flock/reader` Independence & `FakeNetwork` Fidelity
1. Preserve strict package & browser boundaries (`tsconfig.json`, `tsconfig.browser.json`, `eslint.config.mjs`):
   - `@flock/reader` (`packages/reader/src/{independent.ts,independent-tasks.ts}`) must NOT import `@flock/protocol`, `@flock/client`, or `@flock/operator`; update its direct `@atproto/space` / `@atproto/lex-*` / `authorizeSpaceSync` / `listWriters` / RFC 9421 MAC / `@atproto/star` / `RepoTakendown`/`RepoDeactivated` logic independently and keep `reader-parity.test.ts` & `tasks-reader-parity.test.ts` 100% green.
   - `packages/protocol` & `packages/client` must continue passing the `@types/node`-free `pnpm typecheck` check.
2. `FakeNetwork` (`packages/testing/src/fake-network.ts`) must mirror every wire change faithfully (inline `authorizeSpaceSync` + `confirmRegistration` + `notifySpaceUpdate`, 10-min expiry + `400` abandonment, `listWriters` union with `spaceRev`, `putMembers`/`removeMembers`, `getRepo` `application/vnd.dasl.star`, `listRepoOps` every-page commit+MAC & empty `RepoNotFound`, RFC 9421 `Atproto-Space-*` + `Signature*` + CORS `Access-Control-Expose-Headers`, `createSpace`/`getSpace`/`listSpaces` renames, `ACCESS_FULL` app-password ban, `RepoTakendown`/`RepoDeactivated` handling) and be tested directly in `fake-network.test.ts`.

### `D12.12` Acceptance Criteria & 6 Sequential Verification Gates
Every gate runs **after** the final edit on clean compiled `pnpm build` output (`atproto-spaces-r12` built with `strict-credential-expiry.patch` applied):
1. **Gate 1 — Static & Unit/Component:** `pnpm codegen:lex` (clean git diff on generated files), `pnpm typecheck`, `pnpm lint` (0 errors), `pnpm test` (`908+` unit/component tests, 0 failed, 0 skipped).
2. **Gate 2 — Protocol Acceptance (`ATPROTO_PINNED_CHECKOUT=../atproto-spaces-r12 pnpm test:acceptance`):** All 13 acceptance suites pass against real `../atproto-spaces-r12` PDS (updating `app-acceptance.test.ts` for `notifySpaceUpdate` `#spaceDeleted`, `platform-capabilities.test.ts` for `#5923`, `verified-sync.test.ts` for `listWriters`/`RepoNotFound`/MACs, `apps.test.ts`, `app-inboxes.test.ts`, `dm-acceptance.test.ts`, `tasks-acceptance.test.ts`).
3. **Gate 3 — Browser Specs (`ATPROTO_PINNED_CHECKOUT=../atproto-spaces-r12 pnpm test:browser`):** All 8 Playwright browser suites pass (`oauth-callback`, `dm`, `cross-origin`, `real-client`, `content-security-policy`, `webhooks`, `url-routing`, `tasks`).
4. **Gate 4 — Real Upstream Conformance + `@atproto/space` & PDS Space Suites:** Run `../atproto-spaces-r12` `@atproto/space` tests (including rebased strict-expiry tests) and our 3 conformance suites (`slack-inbox-conformance.test.ts`, `slack-dm-conformance.test.ts`, `slack-authority-oauth-conformance.test.ts` updated for `674761056`) against `../atproto-spaces-r12`.
5. **Gate 5 — BDD Suite (`ATPROTO_PINNED_CHECKOUT=../atproto-spaces-r12 pnpm test:bdd`):** Full Cucumber suite (all feature scenarios updated from `listRepos` -> `listWriters` where testing PDS writer-set semantics) passes without relaxing timeouts/assertions.
6. **Gate 6 — Performance & Sync Budgets (`ATPROTO_PINNED_CHECKOUT=../atproto-spaces-r12`):** `pnpm test:sync-budget`, `pnpm test:sync-budget:browser`, and `pnpm test:performance` (`dm-performance.test.ts`, `tasks-performance.test.ts`, and `performance-envelope.test.ts` if run / confirm no regressions).
7. **Independent Adversarial Verification:** Fresh read-only reviewer passes (`Claude Opus` + `Codex`, plus Playwright/real browser smoke against live operator/web) after Wave `R12f` lands.

---

## Parallel Execution Waves & Non-Overlapping File Ownership

Waves execute sequentially (`R12a` -> `R12b` -> `R12c` -> `R12d` -> `R12e` -> `R12f`). Within any wave with >1 worker, file ownership is strictly disjoint so two agents never touch the same file or run `pnpm` builds against each other's unsaved edits.

### Wave `R12a` — Pin, Upstream Worktree Build, Patch Rebase, Package Upgrades & Lexicons (Single Worker: `r12-pin-lex`)
- **Upstream worktree `../atproto-spaces-r12`:**
  - Rebase and commit/update `protocol-tests/atproto/strict-credential-expiry.patch` against `674761056`.
  - Apply patch cleanly inside `../atproto-spaces-r12`, install dependencies (`pnpm -C ../atproto-spaces-r12 install`), build required workspace packages (`@atproto/space`, `@atproto/star`, `@atproto/pds`, `@atproto/dev-env`, `@atproto/lex-*`, etc.), and run `@atproto/space` unit tests to prove the rebased patch passes on `674761056`.
- **Workspace packages & lockfile (in `../atproto-slack-clone-r12`):**
  - Update `package.json`, `packages/*/package.json`, `apps/*/package.json`, and `pnpm-workspace.yaml` per `D12.1` (`0.0.0-spaces-alpha-20261117141222`, `@atproto/star`, updated `minimumReleaseAgeExclude`, clean `overrides`).
  - Run `pnpm install --no-frozen-lockfile` and verify zero old `20261029171913` or duplicate alpha package versions in `pnpm-lock.yaml`.
- **Lexicons & Codegen:**
  - Sync `packages/protocol/lexicons/com/atproto/{space,memberspace}/` from `../atproto-spaces-r12/lexicons/com/atproto/{space,memberspace}/` (delete removed JSONs per `D12.10`).
  - Rename `"name"` -> `"title"` in the 7 `packages/protocol/lexicons/new/flock/{workspace,channel,inbox,app/inbox,ext/tasks,dm/inbox,dm/conversation}.json` space defs.
  - Add `packages/protocol/lexicons/new/flock/operator/getDmNotifyTarget.json` and update `packages/protocol/lexicons/new/flock/permissions/{member,workspaceAuthority}.json`.
  - Update `scripts/codegen-lex.mjs` (`expectedCommit = "6747610566eee1b6d743617bd8eb1136adccb362"`) and run `ATPROTO_PINNED_CHECKOUT=../atproto-spaces-r12 pnpm codegen:lex`.
- **Deliverable:** Clean lockfile, regenerated `packages/protocol/src/lexicons/`, built `../atproto-spaces-r12` with strict expiry patch verified. (Note: `tsc`/`pnpm test` will naturally show drifted consumer compile errors until `R12b`–`R12e` update downstream packages.)

### Wave `R12b` — `@flock/protocol` & `@flock/testing` FakeNetwork (2 Disjoint Workers)
- **Worker `r12-protocol`** (owns ONLY `packages/protocol/src/**/*.ts` and `packages/protocol/tsconfig*.json` if needed):
  - `nsids.ts`: replace `getSpaceCredential` -> `authorizeSpaceSync`, `listRepos` -> `listWriters`, `putMember`/`removeMember` -> `putMembers`/`removeMembers`; update `NOTICE_METHOD` (`confirmRegistration`, `notifySpaceUpdate`, `notifyRepoUpdate`, `notifyCredentialsRevoked`; drop `registerNotify`, `unregisterNotify`, `notifySpaceDeleted`, `notifyWrite`); add `OPERATOR_METHOD.getDmNotifyTarget`.
  - `scopes.ts` + `scopes.test.ts` + `scope-lexicons.test.ts`: add `getDmNotifyTarget` to `dmScopes` (`operatorMethodsScope`) while preserving `DM_BROWSER_SCOPES` and `appGrantScopes`; keep `OPERATOR_METHODS` synced.
  - `space-credential-core.ts`: update to `authorizeSpaceSync` (`credentialKey`, `delegationToken`, optional `notify`), `createSpaceSigHeaders({ authorization, audience, keypair })`, `verifyCredentialSig`, RFC 9421 MAC headers (`formatMacRequest`, `parseMacRequest`, `createCommitMacHeaders`, `createRecordMacHeaders`, throwing `verifyCommitMac` / `verifyRecordMac` / `verifyCommit` / `verifyRecord`), HPKE `"atproto-mac"`, `writeRepoStar` + `application/vnd.dasl.star`, local `LTHASH_STATE_BYTES = 2048`, `starEntryBytes` `+ 1` byte for `0x01`, `listRepoOps` every-page commit+MAC verification (remove `UnsignedEmptyRepoOpsError`), error code renames (`InvalidSpaceMac`, `NotAuthorized`, `AccountNotAuthorized`, `InvalidCursor`), and `registry.ts`/`registry.test.ts` + `xrpc.ts`/`xrpc.test.ts` + `repo-failure.ts` (`RepoTakendown`/`RepoDeactivated` non-lost classification!).
  - `record-pages.ts` & `record-pages.test.ts`: `listWriters` / `listWritersSince` (`#repoWrite` / `#repoRemoved`, `repo`, `repoRev`, `spaceRev`, `data`, keep `page.repos.length < limit` pagination termination), drop `reverse` in `listRecords`, preserve `XrpcFailure` (`RepoNotFound`) and every-page `commit` in `fetchRepoOpsPages`, update `listSpaces` (`spaceDid`, `space`) & `listMembers` (`$type: #member`).
- **Worker `r12-fakenetwork`** (owns ONLY `packages/testing/src/**/*.ts`):
  - `fake-network.ts` & `fake-network.test.ts`: update `FakeNetwork` per `D12.11` (`authorizeSpaceSync` + inline `notify` + synchronous `confirmRegistration` + `notifySpaceUpdate` delivery & 10-min expiry/400 abandonment, `listWriters` union with `spaceRev`, batched `putMembers`/`removeMembers`, `getRepo` `application/vnd.dasl.star` + `@atproto/star`, `listRepoOps` every-page commit+MAC + empty `RepoNotFound`, RFC 9421 MACs + CORS `Expose-Headers` + `Vary: Accept-Signature`, `ACCESS_FULL` app-password ban on space/memberspace endpoints, `RepoTakendown`/`RepoDeactivated` on `authorizeSpaceSync` & `listWriters`, `space`/`spaceDid`/`repo`/`repoRev` field renames & error renames).
  - `space-credential-core.test.ts`: update tests for throwing verifiers, RFC 9421 MAC headers, HPKE `"atproto-mac"`, `starEntryBytes` `+ 1` exact parity with `writeRepoStar`, removal of `UnsignedEmptyRepoOpsError`, and `RepoNotFound` handling.
- **Wave `R12b` Exit Gate:** `pnpm --filter @flock/protocol test && pnpm --filter @flock/testing test` + `tsc -p packages/protocol` clean (`! grep /@types/node/`).

### Wave `R12c` — `apps/operator` & `@flock/reader` (2 Disjoint Workers)
- **Worker `r12-operator`** (owns ONLY `apps/operator/src/**/*.ts` and `apps/operator/scripts/**/*.ts`):
  - `lib/db.ts` + `lib/db-migration.test.ts` + `lib/db-member-tables.test.ts`: add `token` and `pending_token` columns to `notification_registration`; verify zero DM member/content tables.
  - `registrations.ts` + `main.ts` + `registrations.test.ts`: inline `authorizeSpaceSync` webhook registration with staged `pending_token` -> `token`, 10-min credential TTL (`RENEW_WITHIN_MS = 3 * 60 * 1000`, `SWEEP_INTERVAL_SECONDS = 60`), lease-gated 60s background renewal timer in `main.ts` (cleanly stopped on shutdown), DB-only `unregisterSpace`, `listWriters` updates.
  - `notices.ts` + `space-notification.ts` + `server.ts` + `space-notification.test.ts` + `notices.test.ts` + `service-token.test.ts`: replace `registerNotify`/`unregisterNotify`/`notifySpaceDeleted` with `confirmRegistration` & `notifySpaceUpdate` (`timingSafeEqual` token check; 400 `InvalidRequest` on unknown/mismatched tokens; dispatch `#repoWrite`, `#repoRemoved`, `#registrationExpired`, `#spaceDeleted` with authority verification before `dropMemberList`); add `deriveDmNotifyTarget(space)` using `AUTH_ENCRYPTION_KEY` HKDF + HMAC (`"dm." + ...`, 400 on `#registrationExpired` for DM tokens).
  - `methods.ts` + `security.ts` + `security.test.ts`: add `OPERATOR_METHOD.getDmNotifyTarget` guarded by `authorizeDmSubscription`; update error code checks.
  - `atproto/space-ops.ts`, `atproto/write-notification.ts`, `operator/members.ts`, `operator/member-access.ts`, `operator/testing/fake-authority-pds.ts`, `operator/kinds/*.ts`: batch `putMembers`/`removeMembers` (chunks <= 100), `createSpace`/`getSpace` `space`, `listSpaces` `spaceDid`, `listMembers` `#member`, `NotAuthorized` / `AccountNotAuthorized`, keep non-destructive `RepoTakendown`/`RepoDeactivated` handling (and preserve Flock `OperationRequest.kind = "removeMember"`!). Update all operator unit tests (`members.test.ts`, `kinds.test.ts`, `app-access.test.ts`, `extension-access.test.ts`, `create-workspace.test.ts`, `journal-replay.test.ts`, `server.test.ts`).
- **Worker `r12-reader`** (owns ONLY `packages/reader/src/**/*.ts`):
  - `independent.ts`, `independent-tasks.ts`, `independent-tasks.test.ts`: update direct `@atproto/*` calls independently (`authorizeSpaceSync`, `listWriters` `#repoWrite`/`#repoRemoved`, `createSpaceSigHeaders`, throwing `verifyCommit`/`verifyRecord`/MAC verifiers, `writeRepoStar` / `@atproto/star`, `listRepoOps` every-page commit+MAC + `RepoNotFound` handling, non-destructive `RepoTakendown`/`RepoDeactivated`).
- **Wave `R12c` Exit Gate:** `pnpm --filter @flock/operator test && pnpm --filter @flock/reader test` clean.

### Wave `R12d` — `@flock/client` & `apps/web` (2 Disjoint Workers)
- **Worker `r12-client`** (owns ONLY `packages/client/src/**/*.ts`):
  - `credentials.ts`, `sync.ts`: `authorizeSpaceSync` (`notify` + re-mint once when upgrading a cached credential without `notify`), `listWriters` (`#repoWrite`/`#repoRemoved` including cached writer eviction on `#repoRemoved`), `listRepoOps` every-page `commit` + MAC + `RepoNotFound` (`UnsignedEmptyRepoOpsError` deleted), `@atproto/star` / `starEntryBytes` integration, non-destructive `RepoTakendown`/`RepoDeactivated`.
  - `operator-client.ts`, `dm/dm-client.ts`, `dm/ui-logic.ts`: add `getDmNotifyTarget(space)` on `OperatorClient`; refactor `DmClient.watch(spaces, opts)` to resolve `getDmNotifyTarget(space)`, authorize via `authorizeSpaceSync` with `notify`, and renew periodically while active (`AbortSignal` cleanup); batch `putMembers`/`removeMembers` in `DmClient`; map `listWriters` / `createSpace` (`space`) / `getSpace` (`space`) / `listSpaces` (`spaceDid`) / `removeWriter` (`repo`).
  - `workspace-client.ts`, `feed.ts`, `accept-errors.ts`, `store.ts`, `testing/engine-fixture.ts`, `testing/store-contract.ts`, plus all `packages/client/src/**/*.test.ts` (`sync.test.ts`, `sync-concurrency.test.ts`, `dm-client.test.ts`, `workspace-client.test.ts`, `reader-parity.test.ts`, `tasks-reader-parity.test.ts`, `accept-errors.test.ts`, `channel-client.test.ts`, `app-inbox-client.test.ts`, `app-runtime.test.ts`, `tasks-client.test.ts`, `memory-store.test.ts`, `indexeddb-store.test.ts`).
- **Worker `r12-web`** (owns ONLY `apps/web/src/**/*.ts` and `apps/web/src/**/*.tsx`, plus `apps/echo-bot` & `apps/webhooks` only if impacted — verify with `rg`):
  - `apps/web/src/browser/session.ts` & `apps/web/src/app/ui/{dm-context.tsx,dm-conversation.tsx}`: verify `@atproto/oauth-client-browser@0.0.0-spaces-alpha-20261117141222` session compatibility, wire `getDmNotifyTarget` into `DmClient` creation, pass `AbortController.signal` into `client.watch(spaces, { signal })` so open DM views renew continuously past 10 min and unmount cleanly.
- **Wave `R12d` Exit Gate:** `pnpm typecheck && pnpm lint && pnpm test && pnpm build` 100% green (`0` errors, `0` skipped, `! tsc -p packages/client --listFilesOnly | grep -q /@types/node/`).

### Wave `R12e` — Protocol Tests, Conformance, Acceptance, Performance & BDD Suites (2 Disjoint Workers)
- **Worker `r12-protocol-tests`** (owns ONLY `protocol-tests/**/*.ts` and `protocol-tests/atproto/README.md`):
  - `protocol-tests/support/{pds-network.ts,sync-dataset.ts}` & `protocol-tests/recover-pending-operation.ts`.
  - `protocol-tests/atproto/{slack-inbox-conformance.test.ts,slack-dm-conformance.test.ts,slack-authority-oauth-conformance.test.ts}` (`putMembers`/`removeMembers`, `listWriters`, `authorizeSpaceSync`, `NotAuthorized`, `listSpaces` `space`, `#5923` app password coverage if applicable).
  - `protocol-tests/app-acceptance.test.ts`: rewrite the deleted-space webhook test around real `com.atproto.space.notifySpaceUpdate` (`#spaceDeleted` + valid/missing/wrong-space/wrong-token assertions + authority confirmation guard) and update `listRepos` -> `listWriters` (`repos` array with `#repoWrite`/`#repoRemoved` entries, `did` -> `repo`) & `putMember`/`removeMember` -> `putMembers`/`removeMembers` (`dids`) matchers in fault-injection tests.
  - `protocol-tests/platform-capabilities.test.ts`: update K7 app-password capability test (`#5923` — assert both `createRecord` and delegation/credential requests return `Bad token scope`, while `getServiceAuth` still succeeds).
  - `protocol-tests/{verified-sync,dm-acceptance,app-inboxes,apps,extensions-operator,tasks-performance,dm-performance,performance-envelope,sync-budget}.ts` & `protocol-tests/browser/{cross-origin,real-client,sync-budget}*` as needed (`listWriters`, `putMembers`/`removeMembers`, RFC 9421 MAC / STAR checks).
- **Worker `r12-bdd`** (owns ONLY `features/**/*.feature`, `bdd/**/*.ts`, and `docs/prd/atproto-slack-clone.md` / `ARCHITECTURE.md` / `CODE-MAP.md` doc sync):
  - `features/{independent-app-and-launch,private-channel-requests}.feature` (`listRepos` -> `listWriters`, `notifyWrite` -> `notifyRepoUpdate`).
  - `bdd/steps/{independent-app,private-requests,dm-conversations,dm-policy,channels,workspaces,lifecycle,workspace-and-access}.steps.ts` and `bdd/support/{dm-conversations,dm-policy,private-requests,channels,lifecycle}-ui.ts`: update `listWriters`, `putMembers`/`removeMembers`, `getSpace`/`listSpaces` `.space`, `NotAuthorized`.
  - Update `docs/prd/atproto-slack-clone.md`, `docs/protocol/atproto-spaces-pin.md`, `ARCHITECTURE.md`, `CODE-MAP.md`, and `protocol-tests/atproto/README.md` with accurate `#5187` protocol semantics (e.g., 10-min webhook registration + renewal, continuous notifications, `listWriters`, `putMembers`/`removeMembers`, RFC 9421 MACs, STAR, app-password ban).

### Wave `R12f` — Sequential 6-Gate Acceptance, Conformance, Regressions & Adversarial Review
1. Run all 6 gates sequentially against built `../atproto-spaces-r12` (`ATPROTO_PINNED_CHECKOUT=/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-spaces-r12`) and record exact counts/timings in this file's Progress Log:
   - Gate 1: `pnpm codegen:lex && pnpm typecheck && pnpm lint && pnpm test`
   - Gate 2: `pnpm test:acceptance` (13 suites, concurrency 2)
   - Gate 3: `pnpm test:browser` (8 specs, concurrency 1)
   - Gate 4: Upstream `../atproto-spaces-r12` `@atproto/space` + PDS conformance tests (3 suites)
   - Gate 5: `pnpm test:bdd`
   - Gate 6: `pnpm test:sync-budget`, `pnpm test:sync-budget:browser`, `pnpm test:performance`
2. Add targeted R12 regression tests covering:
   - Operator space webhook expiry past 10 minutes / `#registrationExpired` proactive renewal (confirming notifications continue arriving after simulated expiry/renewal).
   - Unknown/unregistered space or wrong token on `confirmRegistration` & `notifySpaceUpdate` returning HTTP `400` (and `#repoRemoved` wake evicting writer cleanly).
   - Stateless DM `getDmNotifyTarget` + `DmClient.watch` renewal + closed/unregistered DM `#registrationExpired` returning `400` with zero DM rows in operator SQLite.
   - Multi-page `listRepoOps` with every-page commit+MAC + `RepoNotFound` on never-written writer.
   - `RepoTakendown` / `RepoDeactivated` on `authorizeSpaceSync` & `listWriters` keeping local synced data intact.
   - `ACCESS_FULL` app-password refusal on `createRecord` & `authorizeSpaceSync` in `platform-capabilities.test.ts` and `FakeNetwork`.
3. Run adversarial read-only reviews (Claude Opus + Codex) on the complete diff against `origin/main` (`f4a4c16`) and fix all legitimate findings, re-running affected gates before final sign-off.

---

## Progress & Gate Log

- [x] **Phase 1 (Complete):** PR #7 (`feat/r10-interactions`) rebased cleanly onto `origin/main` (`762/762` green), merged (`f7b7bdc`); PR #8 (`feat/r11-tasks`) rebased cleanly onto `origin/main` (`908/908` green), merged (`f4a4c16`). `../atproto-slack-clone-r11` left clean on `feat/r11-tasks`.
- [x] **Phase 2 (Complete):** `../atproto-spaces-r12` created at `6747610566eee1b6d743617bd8eb1136adccb362` (leaving `../atproto-spaces-phase3` untouched); npm `0.0.0-spaces-alpha-20261117141222` verified byte-identical to `674761056` across lexicons & shared packages; `../atproto-slack-clone-r12` branched as `chore/protocol-drift-6747610` off `f4a4c16`; plan authored at `.ai/plans/r12-protocol-drift-progress.md`.
- [ ] **Plan Review:** Codex + Claude Opus plan review
- [ ] **Wave `R12a`:** Pin, patch rebase, upstream build, package upgrades, lexicons & codegen
- [ ] **Wave `R12b`:** `@flock/protocol` & `@flock/testing` FakeNetwork
- [ ] **Wave `R12c`:** `apps/operator` & `@flock/reader`
- [ ] **Wave `R12d`:** `@flock/client` & `apps/web`
- [ ] **Wave `R12e`:** `protocol-tests` & `bdd` + docs
- [ ] **Wave `R12f`:** 6-Gate Acceptance, Conformance, R12 Regression Tests & Adversarial Code Reviews
