# Gemini 4 Argon review of chore/protocol-drift-5d88b41

- Reviewer: `gemini-4-argon-high` through `agy --dangerously-skip-permissions` (agy 1.4.6), print mode, single pass.
- Date: 2026-11-01. Reviewed tree: HEAD `72a3411` (six commits on top of `5a9e21d`), clean working tree before and after.
- Prompt: read-only review, full plan and pin note named as required reading, the four owner decisions listed as not to re-raise, BDD/browser/acceptance/performance suites excluded. The repo was unchanged afterwards.
- This was one pass by one reviewer. It is not the plan's Opus + Codex adversarial-execution gate and does not replace it.

## Verification of the findings by the executor (a Sonnet code-review pass of the follow-up added the corrections noted in the rows) (read against the code at HEAD and the pinned PDS checkout)

| Finding | Result |
|---|---|
| Important: `readJoinRequest` (`src/operator/operations.ts:537-551`) rethrows `KemKeyError`/`SpaceMacError`; the journal stores that as `pending`, and every later admin operation then throws from `resumeRecoverableOperations` | **Confirmed and fixed** (`readJoinRequestRecord`, with a test). `isUnverifiableRepo` is handled only in `channel-sync.ts`, `dm-client.ts` and `independent-dm.ts`. The inbox list route reads join requests with `listRecords` (no MAC, no KEM lookup), so the request is shown to the admin. The failure is persistent, unlike the transient errors the replay design expects. |
| fake PDS: `requireSpace` ignores `deleted`; `createSpace` can re-create a deleted space | **Half confirmed.** The pinned `getActiveSpacePolicy` rejects a deleted space with `SpaceNotFound` and the fake does not. The re-create claim is **false**: the pinned `deleteSpace` drops the policy row, `createSpace` rejects only when a policy row exists, and `ensureSpace` clears `deletedAt`, so the pinned PDS and the fake both allow re-creating a deleted space. |
| fake PDS: `listRecords` demands a credential even for the owner's OAuth self-read | **Confirmed**: the fake is stricter than the pinned PDS (`authorizationOrSpaceCredential`, `isSpaceSelfRead`), so it cannot exercise the owner's self-read path. |
| `readChannelPage` has no end-to-end unverifiable-writer test | **Confirmed**, and already disclosed in the plan outcome. |
| PRD lines 43 and 116 claim `appAccess` is open and a two-hour credential window | **Confirmed and fixed.** A first check of this row truncated the lines before the phrases and wrongly called the claim false. `docs/prd/atproto-slack-implementation-plan.md` lines 28 and 108 had the same stale two-hour wording and are fixed too. |
| `src/auth/permission-sets.ts:41` comment still points at the phase0 checkout | **Confirmed** (plan P2 item 5 asked for these comments to be updated). |
| `PROGRESS.md:46` and the plan header still say "uncommitted" | **Confirmed**, stale since the commits. |
| Open question: `DmClient.readConversation` does not evict a cached credential the host rejects | **Not confirmed.** The reviewer could not trigger it either. |

Note on the raw report below: its PRD nit cites `src/app/ui/workspace-manager.tsx:766,806` as stating the credential window. That file has 698 lines and no UI text states the window anywhere; the raw text is kept as received.

---

## Raw report

### Verdict
approve with follow-ups

### Critical (must fix) / Important (should fix)

- `[important] src/operator/operations.ts:537-551`
  - **Evidence:**
    1. `GET /api/inbox/requests` (`src/app/api/inbox/requests/route.ts:38-44`) scans each candidate join-request writer repo using `com.atproto.space.listRecords`, which carries no MAC and does not resolve `#atproto_kem` (`src/atproto/space-credential-core.ts:21,135`). A workspace member whose DID document has no usable `#atproto_kem` key (`KemKeyError`) or whose PDS returns a missing/invalid `Atproto-Space-Mac` header on `getRecord` (`SpaceMacError`) therefore still appears as a pending join request in the admin inbox UI.
    2. When an admin approves or denies that join request (`decideJoinRequest`, `src/operator/operations.ts:448,466`), `readJoinRequest` (`src/operator/operations.ts:537-551`) mints an inbox space credential and calls `com.atproto.space.getRecord` on `parsed.repo` (`repoDid`). That call runs through `SpaceCredential.client` (`src/atproto/space-credential-core.ts:135-161`), which resolves `repoDid`'s `#atproto_kem` key and verifies the record MAC.
    3. Unlike `src/workspaces/channel-sync.ts:149`, `src/dm/dm-client.ts:399`, and `src/reader/independent-dm.ts:146`, `readJoinRequest` catches only `isNotFound(error)` (`src/operator/operations.ts:548`) and rethrows `KemKeyError` / `SpaceMacError` (`isUnverifiableRepo(error)`).
    4. Because neither error is an `OperationRejectedError`, `runJournaledOperation` (`src/operator/journal.ts:105-109`) records the operation row in SQLite with `state = 'pending'`.
    5. On every subsequent `executeOperatorOperation` call for that workspace (`src/operator/operations.ts:30-32,38-69`), `resumeRecoverableOperations` replays the pending `decideJoinRequest`, hits the same `KemKeyError` or `SpaceMacError`, leaves the row `pending`, and throws `Pending workspace operations could not be resumed (...); membership reconciliation was skipped.` (while non-admin `leaveWorkspace` / `leaveChannel` calls throw `OperationBusyError` at `src/operator/operations.ts:32`).
  - **Impact:** A single non-admin workspace member with a missing/malformed `#atproto_kem` key or a misbehaving PDS host can cause an admin's Approve or Deny action on their join request to wedge all subsequent admin mutations and member leaves across the entire workspace until the member's DID document/host is fixed or the journal row is manually cleared.
  - **Fix direction:** In `readJoinRequest` (`src/operator/operations.ts:547-550`), catch `isUnverifiableRepo(error)` (from `src/atproto/kem-key.ts:31`) and return `null` (so `decideJoinRequest` runs `cleanupStaleJoinApproval` and throws `OperationRejectedError`, marking the operation `failed` rather than `pending`), or wrap `isUnverifiableRepo(error)` in `OperationRejectedError`.

### Scope or test gaps

- **`src/dm/testing/fake-pds.ts:253-256,307,356-362,509-510` — `FakeDmNetwork` diverges from the pinned PDS on deleted spaces and owner `listRecords` reads:**
  - `deleteSpace` (`src/dm/testing/fake-pds.ts:356-362`) sets `space.deleted = true`, but `requireSpace` (`src/dm/testing/fake-pds.ts:253-256`) checks only `!this.spaces.has(uri)` without checking `space.deleted`. Consequently, `getSpace` (`line 327`), `updateSpace` (`line 317`), `putMember` (`line 335`), `removeMember` (`line 346`), `listMembers` (`line 364`), `listRepos` (`line 520`), and `registerNotify` (`line 533`) succeed on a deleted space in `fake-pds.ts` (and `listRepos` keeps returning `space.trackedWriters`), whereas the pinned PDS rejects them with `400 SpaceNotFound` via `getActiveSpacePolicy` / `deletedAt` checks (`packages/pds/src/actor-store/space/reader.ts:36-43`, `packages/pds/src/api/com/atproto/space/listRepos.ts:26`, `packages/pds/src/api/com/atproto/space/registerNotify.ts:31`).
  - `createSpace` (`src/dm/testing/fake-pds.ts:307`) checks `if (existing && !existing.deleted)` and allows re-creating a deleted `(spaceType, skey)` URI, whereas the pinned PDS (`packages/pds/src/actor-store/space/transactor.ts:39-44`) checks `getSpace(uri)` (which returns the tombstone row with `deletedAt` set) and rejects re-creation with `SpaceAlreadyExists`.
  - `listRecords` (`src/dm/testing/fake-pds.ts:509-510`) calls `this.requireCredential(params, auth)` unconditionally without checking `this.isOwnRead(params, auth)`, whereas `getRecord` (`line 472`) and `getLatestCommit` (`line 489`) allow owner OAuth reads and the pinned PDS `listRecords` (`packages/pds/src/api/com/atproto/space/listRecords.ts:14,24`) accepts `authorizationOrSpaceCredential`.
- **`src/workspaces/channel-sync.test.ts:50-90` — `refreshWriterRepos` is unit-tested in isolation, but `readChannelPage` has no end-to-end test for an unverifiable writer repo:**
  - `src/workspaces/channel-sync.test.ts:50-90` tests `refreshWriterRepos` directly and verifies that `channel_record_cache`, `space_collection_cursor`, and `sync_cursor` rows are purged when a writer throws `SpaceMacError`. No test calls `readChannelPage` (`src/workspaces/channel-sync.ts:28-132`) with an unverifiable writer to verify that `degraded: true` and `degradedReasons: ["Messages from <did> were skipped: ..."]` are returned alongside the remaining writers' messages and reactions (noted as open in `.ai/plans/protocol-drift-5d88b41.md:197,211`).

### Nits

- `docs/prd/atproto-slack-clone.md:43,116`: Line 43 still claims `` `appAccess` is open for all three space types `` (`appAccess` was removed with `simplespace`; `com.atproto.memberspace.policy` uses optional `allowedApps`, omitted when open), and line 116 still states `Cached credentials can work until they expire; the UI must state this two-hour maximum default` (contradicting line 25 of the same file and `src/app/ui/workspace-manager.tsx:766,806`, which state the ten-minute default and one-hour ceiling).
- `src/auth/permission-sets.ts:41`: Comment still references `../atproto-spaces-phase0/packages/oauth/oauth-scopes/src/scopes/space-permission.ts` instead of the `5d88b414` (`phase3`) checkout, although `.ai/plans/protocol-drift-5d88b41.md:72` (P2 item 5) called for updating comments in `src/auth/permission-sets.ts`.
- `PROGRESS.md:46` and `.ai/plans/protocol-drift-5d88b41.md:3`: Both still label the `chore/protocol-drift-5d88b41` branch status as `uncommitted`.

### What is sound

- **Single-owner credential exchange, presentation, and MAC verification (`src/atproto/space-credential-core.ts`, `src/atproto/kem-key.ts`, `src/atproto/space-key.ts`):**
  - `exchangeSpaceCredential` sends `POST /xrpc/com.atproto.space.getSpaceCredential` with `{ space, credentialKid: key.did(), delegationToken }` in the JSON body and no `Authorization`, `Signature`, or `DPoP` headers, matching `packages/pds/src/api/com/atproto/space/getSpaceCredential.ts`.
  - Refusal codes (`UserNotAuthorized`, `NotAuthorized`, `AppNotAuthorized`, `SpaceNotFound`) map to 403 `SpaceCredentialError`, `SpaceDeleted` maps to 410 `SpaceCredentialError`, and `InvalidDelegationToken` / `InvalidClientAttestation` remain 400 `XrpcError`s. `isAccessLost` and `isSpaceDeleted` are the single predicates used across workspace discovery, channel sync, cache eviction, and DM half classification.
  - Credentialed requests use `Atproto-Space-Credential <token>` and `createSpaceSigHeaders` from `@atproto/space` (`tag="atproto-space-credential"`), binding `Atproto-Space-Audience` to the `repo` query parameter on `GET` when it is a valid DID and to `authorityDid` otherwise.
  - `getRecord` and `getLatestCommit` generate a fresh ephemeral ECDH share per attempt via `encapsulate(recipientDidKey)` (`Atproto-Space-Want-Mac`), read the upstream body once within the 8 MiB bound (`readUpstreamText` + `replayed`), parse `Atproto-Space-Mac` (`parseMacHeader`), convert record JSON back to Lexicon form via `jsonToLex` before `verifyRecord(sharedSecret, uri, value)`, check `commit.repo === repo && commit.space === space` before `verifyCommit(sharedSecret, commit)`, and retry once with `forceRefresh = true` on `SpaceMacError` to handle `#atproto_kem` key rotation.
  - `kemKeyFromDidDocument` accepts both `Multikey` and `EcdsaSecp256r1VerificationKey2019` on `#atproto_kem` / `${did}#atproto_kem`, validates P-256 with `isP256DidKey`, and `cacheKemKeys` bounds the server cache to 1,024 entries / 10 minutes without caching failures.
- **Policy migration (`src/atproto/space-policy.ts`, `src/atproto/space-ops.ts`, `src/dm/dm-client.ts`):**
  - All `com.atproto.simplespace.*` calls and lexicons are removed and replaced by `com.atproto.space.{createSpace,updateSpace,getSpace,deleteSpace}` and `com.atproto.memberspace.{putMember,removeMember,listMembers}` with `com.atproto.memberspace.policy`. `setRequestMode` reads the existing memberspace policy and preserves `allowedApps`, `publishPolicy`, and `publishMembers` while forcing `publicRead: false` and updating `publicWrite`.
- **DM declaration, allowlist inbox scan, and session scope checks (`src/dm/**`, `src/protocol/records.ts`, `src/auth/permission-sets.ts`):**
  - `DM_BROWSER_SCOPES` replaces the cross-authority inbox read scope with `repo:org.slack.dm.declaration?action=create&action=update`. `enableDms` and `setRequestMode` publish `org.slack.dm.declaration/self` via `ensureDeclaration` (which avoids rewriting a valid existing declaration), `recipientHasInbox` validates `uri`, `$type`, and `createdAt`, and `scanRequests` unions `listRepos` with `activeAllowlist` using a 5-minute negative cache invalidated on allowlist/mode changes.
  - `missingScopes` in `src/dm/browser-session.ts` checks restored and newly granted sessions for required non-`space:` tokens (`atproto`, `repo:`, `rpc:`), preventing silent disconnects when a pre-migration session lacks the declaration grant.
- **Per-repo isolation and cache invalidation (`src/workspaces/channel-sync.ts`, `src/workspaces/cache.ts`, `src/workspaces/read-model.ts`):**
  - `refreshWriterRepos` isolates writers that fail `isUnverifiableRepo` (`KemKeyError` / `SpaceMacError`) and calls `purgeRepoCache` so their cached messages, collection cursors, and sync cursors neither render nor crowd out the 20,000-record window. `isAccessLost` (including 410 `SpaceDeleted`) purges workspace and channel caches, and `discoverWorkspaceState` skips deleted workspaces.
- **Module boundaries (`eslint.config.mjs`, `package.json`, `pnpm-workspace.yaml`):**
  - `src/atproto/{space-key,kem-key,space-policy}.ts` are included in `ISOMORPHIC_PROTOCOL_MODULES` with `no-restricted-imports` forbidding `node:*` and server-only modules. All three conformance files in `protocol-tests/atproto/*.test.ts` are byte-identical to the copies in the pinned PDS checkout, and `strict-credential-expiry.patch` matches the documented SHA-256 (`e9cfae5beb29d01c494087abf79eaf58fd48312956422c91ff29a405977aae3f`).

### Verification

- **Commands run:**
  - `git status --short` -> clean working tree (`0` modified/untracked files before and after review).
  - `git log --oneline 5a9e21d..HEAD` -> verified 6 commits (`613ef6c`..`72a3411`).
  - `export PATH=$HOME/.nvm/versions/node/v22.17.0/bin:$PATH && node_modules/.bin/tsc --noEmit` -> passed with 0 errors.
  - `export PATH=$HOME/.nvm/versions/node/v22.17.0/bin:$PATH && node_modules/.bin/eslint .` -> passed with 0 errors and 1 pre-existing warning (`src/app/ui/logout-button.tsx:9:5` `@next/next/no-location-assign-relative-destination`).
  - `export PATH=$HOME/.nvm/versions/node/v22.17.0/bin:$PATH && node --import tsx --test 'src/**/*.test.ts' 'bdd/**/*.test.ts'` -> passed 297/297 unit tests (0 failures, 0 skipped, ~8.8s).
  - `shasum -a 256 protocol-tests/atproto/strict-credential-expiry.patch` -> `e9cfae5beb29d01c494087abf79eaf58fd48312956422c91ff29a405977aae3f` (matches `docs/protocol/atproto-spaces-pin.md:18`).
  - `cmp -s` of `protocol-tests/atproto/slack-{dm,inbox,authority-oauth}-conformance.test.ts` against `../atproto-spaces-phase3/packages/pds/tests/space/` at commit `5d88b414a98de1ada22c94c78fa0667a7028163c` -> byte-for-byte identical.
- **Checks skipped and why:**
  - `pnpm test:bdd`, `pnpm test:bdd:slow`, `pnpm test:browser`, `pnpm test:acceptance`, `pnpm test:performance`, and the upstream Jest suites inside `../atproto-spaces-phase3`: skipped per review instructions because they are long-running and timing-sensitive.
- **Residual uncertainty / open questions:**
  - **Open question (live PDS behavior on cached-credential errors in `DmClient.readConversation`):** In `src/dm/dm-client.ts:388-402`, `credentialFor(half)` reuses an in-memory credential until 60 seconds before its 10-minute expiry (`SPACE_CREDENTIAL_RENEW_BEFORE_MS`). If a repo host rejects a still-cached credential during `readRecord` or `listRecords` (for example, `401 ExpiredToken` under clock skew larger than 60 seconds, or if a future PDS wires `notifyCredentialRevoked` into `removeMember`), `readConversation` does not evict `this.credentials.get(half)` or classify the half as `"revoked"`. Because the pinned `5d88b414` PDS does not call `notifyCredentialRevoked` on `removeMember` and the 60-second renewal buffer exceeds normal clock skew, this could not be triggered without out-of-band revocation or >60s clock skew.
