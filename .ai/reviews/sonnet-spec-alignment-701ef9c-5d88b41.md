# Spec-alignment review: proposal 0016 at `701ef9c6` against this repo (pinned PDS `5d88b414`)

- Reviewer: a read-only Sonnet subagent (selector `sonnet`; the harness does not report the resolved model), whole repo, one pass, 120 tool calls. Date: 2026-11-02. Instructions: the template `.claude/skills/align-app-against-protocol-spec/spec-review-prompt.md` with the four placeholders filled.
- Why Sonnet: the requested Codex run (`gpt-6.1-sol`, `xhigh`) was refused with `model_not_found` on the ChatGPT-account Codex login, and no other model was substituted. This report is one reviewer's pass. It is not the plan's Opus + Codex adversarial-execution gate.
- Upstream state on the day: proposal `main` = `701ef9c6` (the pinned commit); PDS PR #5187 head `d0097360` differs from `5d88b414` only by `alpha-migrations/prompt-10-29-26.md`; the newest `spaces-alpha` npm snapshot is the pinned one (checked by the executor with `git ls-remote`, a tree-only fetch and `npm view`; the reviewer had no network).

## Executor's check of the findings (read against the code at HEAD and the pinned checkout)

| Finding | Result |
|---|---|
| F1 one writer's account state or host makes a channel, the admin inbox list or a DM unreadable | **Confirmed as a code path, not executed.** The pinned `assertRepoAvailability` (`packages/pds/src/api/com/atproto/sync/util.ts`) answers a non-self read of a deactivated or taken-down account with 400 `RepoDeactivated` / `RepoTakendown`. `refreshAuthenticated` in `src/workspaces/channel-sync.ts` catches only `isUnverifiableRepo`; `isMissingXrpcResource` matches 404, `RecordNotFound` and `RepoNotFound` only; no test or fixture outside the generated Lexicon types mentions either code. Not re-checked by the executor: that the authority still issues credentials for such an account, that `listRepos` keeps listing it, and the oversize-page arithmetic. |
| F2 deletion and retention are met lazily | **Confirmed.** `src/app/xrpc/` holds `com.atproto.space.notifyWrite` and three operator methods only; there is no `notifySpaceDeleted` handler (the pin note, line 81, says so and scopes it out). `ARCHITECTURE.md:25` ("On failure to renew a private space credential, stop sync and remove that account's cached private data") overstates what runs. Retention for accounts that never return was not recorded as an owner decision. |
| F3 `notifyWrite` trusts the body's own space authority, with no registration check or rate limit | **Confirmed as a code path** (`src/app/xrpc/com.atproto.space.notifyWrite/route.ts`: the authority DID comes from the body and the only check is `issuer === authorityDid`). Low severity: it is table growth and resolution cost, and no data is exposed. Not tested. |
| F4 duplicate owners and unwired artifacts | **Confirmed.** Raw `at://…/space/…` regexes outside `src/protocol/keys.ts` in `reader/independent.ts`, `app/ui/client-api.ts`, `app/api/workspaces/accept/route.ts`, `app/api/channels/requests/route.ts`, `workspaces/{channels,cache,read-model,bootstrap}.ts`, `atproto/{space-ops,record-pages}.ts` and `operator/security.ts`. `operations.ts` `isSkey` requires an alphanumeric first character, `keys.ts` `isSkey` accepts `.`. Two `listBoundedSpaces` (`atproto/space-pages.ts`, `atproto/record-pages.ts`) and two `isAlreadyExists` (`atproto/space-ops.ts`, `dm/dm-client.ts`). `lexicons/space-types.json` has one entry with `"publicWrite": "owner-configured"` and no code reads the file; `lexicons/org/slack/permissions/*.json` are referenced by nothing. Caveat on the fix direction: those lexicons may be meant as published interoperability artifacts, so "wire or remove" is an owner decision, not a mechanical delete. |
| F5 docs that the code or spec contradicts | **Confirmed.** Pin note line 145 says one WebCrypto key signs the DPoP proofs and the HTTP message signatures "on the credential exchange", while the same note says the exchange is body-only. `PROGRESS.md:38` says `DM_BROWSER_SCOPES` has five scope strings; the array has six entries and no read-any-inbox grant. `docs/prd/atproto-slack-clone.md:104` says permission-set declarations publish the collections and operations, and none is wired. Not re-checked by the executor: the "unguessable conversation keys" claim in `CODE-MAP.md` and the pin note. |
| Conformance matrix (70 rows) | Not re-verified row by row. Rows 4, 9, 47 and 55 were confirmed through F2 and F4. |
| Skill nits | **Confirmed and applied** to the skill: `package.json` pins only `space`, `crypto` and `lex-data`; the re-pin grep must also match the 8-character prefix; the owner table lacked five files; the tree-diff command should fetch the recorded commit explicitly. |

---

## Raw report

### Verdict
**aligned with follow-ups.** No Critical defect. Credential, MAC and expiry handling is sound, and the pinned-PDS departures are documented. Five Important items remain, mostly availability, retention and duplicate-owner problems.

Inputs: proposal checkout at `701ef9c6be5a99c2d3e87e107fe2531459d1c984` (clean), PDS checkout at `5d88b414a98de1ada22c94c78fa0667a7028163c` plus the strict-expiry overlay (2 modified files) and 3 untracked copied conformance tests. The reviewer read the whole proposal README (957 lines), the pinned lexicons, `packages/space/src`, the PDS space and memberspace handlers, the policy manager and the auth verifier, both migration prompts in the pinned tree (not `prompt-10-29-26.md`, which is only on the PR head), the app's protocol modules, the fake PDS, the routes, the operator security code, the docs and the new skill.

### Critical (must fix)
None. No path where a non-member reads, a MAC is silently skipped, or a credential is replayed against another audience.

### Important (should fix)

**F1. [Important] One writer's account state or host can make a whole channel, the admin inbox list or a DM unreadable for everyone.**
- Where: `src/workspaces/channel-sync.ts:139-155` and `:161-171` (only `isUnverifiableRepo` is isolated per writer); `:227-274` and `:304-317` (`fillLatest` and `fillOlder` have no isolation); `src/app/api/inbox/requests/route.ts:37-47` and `:66-82`; `src/dm/dm-client.ts:395-400` and `:701-720`; `src/reader/independent-dm.ts` (`getOptionalRecord`, `readIndependentDmReactions`); `src/atproto/xrpc.ts:69-73` (`isMissingXrpcResource` matches only 404, `RecordNotFound`, `RepoNotFound`).
- Evidence: the pinned PDS answers a non-self read of a deactivated or taken-down account with 400 `RepoDeactivated` or `RepoTakendown` (`packages/pds/src/api/com/atproto/sync/util.ts:6-37`, used by `getRecord`, `getLatestCommit`, `listRecords`). The authority still issues credentials for such an account (`space/util.ts` `assertSpaceHost` uses `includeDeactivated`). `listRepos` keeps listing the account, so `refresh()` (`channel-sync.ts:190`) throws and `readChannelPage` fails. Pages are also unbounded in bytes: the response cap is 8 MiB (`xrpc.ts:5`); page sizes are up to 100 messages, 1000 reactions (`channel-sync.ts:23,341`) and 101 join requests, against a legal 1 MiB per record (`packages/space/src/types.ts:29`). A hostile writer can therefore trigger `UpstreamResponseTooLargeError` permanently. Spec, "Account lifecycle": "If an account is deactivated, downstream services are expected to stop serving all data associated with it". Spec, "The sync boundary (writer set)": a syncer "confirms each repo by syncing it directly from its host". Not executed: a code-path finding. No test mentions `RepoDeactivated`, `RepoTakendown` or an oversize page, and the fake PDS has no availability model.
- Impact: any member who deactivates their account, or any member with write access who stores a few large records, denies reads to all other members. Admins cannot list the inbox to find the offender. Same class as the plan's open item 19(c). Direct messages already isolate this per sender in `scanRequests` (`dm-client.ts:226-239`), but `readConversation` does not.
- Fix direction: treat `RepoDeactivated`, `RepoTakendown`, `RepoSuspended`, `RepoNotFound`, an unresolvable DID, an oversize page and 5xx for one repo as a per-repo failure like `isUnverifiableRepo` (set it aside with a note, call `purgeRepoCache`, carry on). Apply in `fillLatest`, `fillOlder`, the inbox route and DM halves. Retry an oversize page with a smaller `limit`.

**F2. [Important] Deletion and retention duties are met only lazily, per returning account.**
- Where: `src/atproto/notifications.ts:19-21`, `src/app/xrpc/` (only `com.atproto.space.notifyWrite`), `src/workspaces/channel-sync.ts:36,49,129`, `src/workspaces/read-model.ts:65-67`, `src/lib/db.ts` (no TTL), `src/app/api/oauth/logout/route.ts:13-23` (no purge).
- Evidence: the app registers its operator service ref with `registerNotify`, so the authority posts `notifySpaceDeleted` to it (`packages/pds/src/space-notifications.ts:403-406`), but there is no handler. The only fallback is an account's own next credential renewal returning `SpaceDeleted`, which purges that account's rows. Spec, "Space deletion": "A syncer should delete every copy of the space's data it holds, both the repos it pulled and any derived state". Spec, "Account lifecycle": if an account is deleted, "downstream services are expected to delete all data associated with the account". The app has no account or identity event consumer.
- Impact: cached private messages (encrypted at rest with a key held on the same server) for a deleted space, a deleted or deactivated author, or a member removed while offline survive indefinitely for every account that never returns. `ARCHITECTURE.md` ("On failure to renew a private space credential, stop sync and remove that account's cached private data") overstates what runs. The pin note records the handler as scoped out of the migration. That is not an owner decision about retention for non-returning accounts.
- Fix direction: add `POST /xrpc/com.atproto.space.notifySpaceDeleted` reusing `authenticateOperatorRequest`, requiring `iss` to equal the space authority, deleting that space's rows for all accounts, idempotently. Add an age-based sweep (for example in `pnpm reconcile`) and optionally purge on logout. Alternatively record a retention TTL as an owner decision.

**F3. [Important, low] The notifyWrite endpoint accepts any DID's claim to be the authority of any space, with no registration check or rate limit.**
- Where: `src/app/xrpc/com.atproto.space.notifyWrite/route.ts:13-23`, `src/operator/security.ts:27-52`.
- Evidence: the authority DID is parsed from the body's own `space`, and the check is only `issuer === authorityDid`. Every call forces a DID resolution (the IdResolver has no cache) and an INSERT, and rows are kept 7 days. There is no rate limiter anywhere in `src`.
- Impact: table growth and PLC lookup amplification by any resolvable DID. No data is exposed, because the SSE routes only read rows for spaces the caller can already read.
- Fix direction: require a `notification_registration` row for (`OPERATOR_SERVICE_REF`, space) (`notifications.ts:14-16`) before inserting, cap rows per space, add a rate limit.

**F4. [Important] Duplicate owners and unwired protocol artifacts.**
- Duplicates: thirteen hand-written space-URI regexes outside `src/protocol/keys.ts:123-130` (`parseSpaceUri`): `reader/independent.ts:62`, `app/ui/client-api.ts:30`, `app/api/workspaces/accept/route.ts:22`, `app/api/channels/requests/route.ts:32`, `workspaces/channels.ts:18`, `workspaces/read-model.ts:92,97`, `workspaces/cache.ts:4-6`, `workspaces/bootstrap.ts:25`, `atproto/space-ops.ts:131`, `atproto/record-pages.ts:128`, `operator/security.ts:22`. Four duplicated predicates in `src/operator/operations.ts:683-703` (`inboxUri`, `isDid`, `isSkey`, `isTid`); that file's `isSkey` requires an alphanumeric first character, but `keys.ts:9-11` accepts `.` and `..`, so the two disagree. Two `listBoundedSpaces`: `src/atproto/space-pages.ts:6-33` (workspaces) and `src/atproto/record-pages.ts:137-180` (DMs, stricter); `space-pages.ts` does not validate URIs, duplicates or repeated cursors; `CODE-MAP.md` names `record-pages.ts` as the owner. Two `isAlreadyExists`: `space-ops.ts:125-128` matches status 409 or the message text, while `dm-client.ts:779-781` keys on the declared `SpaceAlreadyExists`.
- Unwired artifacts: `lexicons/org/slack/permissions/member.json` and `workspaceAuthority.json` are referenced by nothing (no `include:` scope). `workspaceAuthority.json` also contradicts the runtime scopes: it says `skey` is `workspace` or `inbox` and omits `action=read` and `manage=create`, while `permission-sets.ts:104-108` uses `skey=*` and the inbox skey equals the workspace skey (`operations.ts:683`, `keys.ts:55`). `lexicons/space-types.json` has no consumer. It restates policies, including `"publicWrite": "owner-configured"`, which is not a boolean and so not a valid memberspace value.
- Impact: the "second internal owner" and "dead stub" shapes. A scope or URI rule fixed in one copy silently diverges.
- Fix direction: delete or generate the two permission-set files and `space-types.json`. Collapse the regexes and predicates onto the `keys.ts` owners. Keep a single `listBoundedSpaces`. Key `isAlreadyExists` on `SpaceAlreadyExists`.

**F5. [Important, docs] Documents that state something the code or spec contradicts.**
- `docs/protocol/atproto-spaces-pin.md:145` ("Browser signing key") says the WebCrypto key that signs DPoP also signs "the HTTP message signatures on the credential exchange". The exchange is unsigned (body only, `space-credential-core.ts:251-256`, and pin lines 63 and 118). The credential key is a fresh per-credential key unrelated to DPoP (`space-key.ts:10-18`).
- `ARCHITECTURE.md` (Storage rules) says any failure to renew a private credential removes cached data. The code purges only on a refusal or a deleted space (`space-credential-core.ts:73-75`), and the spec says a renewal that fails for any other reason "says nothing about the space".
- `CODE-MAP.md` (system diagram) and the pin note's existence-oracle row call conversation keys "unguessable". `tidNow` (`keys.ts:158-169`) is a millisecond timestamp plus 10 random bits.
- `PROGRESS.md:38` still describes five DM scope strings, including the removed read-any-inbox grant. `DM_BROWSER_SCOPES` (`permission-sets.ts:42-61`) now has six and no such grant.
- `docs/prd/atproto-slack-clone.md:104` says "Space-type permission-set declarations publish the collections and operations", but no permission set is wired (F4).

### Conformance matrix
Status values: conforms, deviates, not used by design (NUBD), spec silent, cannot verify. `SC` is `src/atproto/space-credential-core.ts`. "PDS" is the pinned PDS under `packages/pds/src`.

| # | Spec section | What the spec says | What the app does (file:line) | Status | Evidence |
|---|---|---|---|---|---|
| 1 | Introduction | Access control, not confidentiality; syncer, repo host, space host roles | App is a syncer plus member client; the PDS is repo host and space host (`ARCHITECTURE.md:5-9`, `SPEC.md` residual risk) | conforms | stated in docs |
| 2 | Relationship table | Record authority = user DID; URI authority = space authority | Authority-collection records valid only if repo = authority; member records only if repo = author (`protocol/records.ts:47,136,201,215,241`) | conforms | validators, unit tests |
| 3 | Spaces: identity | `(authority, type, skey)` triple | `parseSpaceUri` (`protocol/keys.ts:123-130`) | conforms | |
| 4 | skey | At most 512 bytes, rkey syntax | `isSkey` allows 1-128 chars including `.` and `..` (`keys.ts:9-11`) | deviates (narrower, lenient on `.`/`..`) | rkey syntax forbids `.` and `..`; the PDS enforces it |
| 5 | Addressing | `at://{authority}/space/{type}/{skey}/{author}/{collection}/{rkey}` | `spaceRecordUri` and `parseSpaceRecordUri` (`keys.ts:132-156`); type and collection only checked as `[A-Za-z0-9.-]+`, not NSIDs | conforms (loose) | |
| 6 | space-ref format | New Lexicon string format | Generated clients cast around the missing format (`scripts/codegen-lex.mjs:68-82`); app validates by regex | conforms with bridge | |
| 7 | Space authority | Resolved like any account; `#atproto_pds` is the space host | `resolvePds` (`identity.ts:30-34`, SSRF-guarded); app never verifies credential signatures (holder only) | conforms | |
| 8 | Space type declarations | Lexicon `type:"space"` with `key`, `name`, `collections`, no wildcard | `lexicons/org/slack/{workspace,inbox,channel}.json`, `dm/{inbox,conversation}.json`; published in fixtures (`protocol-tests/support/app-fixture.ts:168-186`) | conforms | declarations parse under the pinned `lexSpace`; `name` at most 64 |
| 9 | Declaration restated | (not in spec) | `lexicons/space-types.json` has no consumer and a non-boolean `publicWrite` | deviates | F4 |
| 10 | Credential gating | Read or sync needs a credential from the authority | Only construction site is `SC:231`; every cross-repo read goes through `SpaceCredential.client()` (grep found no other `Atproto-Space-Credential` or `createSpaceSigHeaders` outside the core, key and fake) | conforms | |
| 11 | Assertions | Authority may require delegation token, client attestation, both or neither | App always sends a delegation token, never an attestation (`SC:256`) | conforms | |
| 12 | "Authority MUST NOT reject a valid unrequired assertion" | Authority-side | PDS `authorizeCredential` (`space-policy/manager.ts:206-233`) | conforms (PDS); N/A to app | |
| 13 | Key binding | App supplies a P-256 `did:key`, new keypair per credential, discard after | `generateSpaceKey` WebCrypto non-extractable (`space-key.ts:10-18`); fresh key per mint (`SC:223`) | conforms | |
| 14 | Signature algorithm | `ecdsa-p256-sha256`, 64-byte `r\|\|s`, high-S accepted | WebCrypto returns P1363 (`space-key.ts:16`); host accepts malleable (`packages/space/src/http-signature.ts:84-88`) | conforms | |
| 15 | Delegation token | Minted by the user's PDS, 60 s, single use, aud `did#atproto_pds`, needs `read` grant | Fresh token per mint (`SC:218-221`); `read` grants in `permission-sets.ts:49,60,128-153` | conforms | |
| 16 | Client attestation | `private_key_jwt` signed by the app; only if the space gates on apps | Not used. App is a public OAuth client (`auth/oauth.ts:49-60`, `token_endpoint_auth_method:"none"`), so it cannot satisfy `allowedApps` | NUBD | `AppNotAuthorized` is treated as a refusal (`SC:240,271-275`) |
| 17 | Credential claims | `typ`, no `aud`, `cnf.kid`, default 10 min, max 60 min, `jti` | Token treated as opaque; lifetime is the constant 10 min (`SC:25,100,235`; `dm-client.ts:537-551`) | conforms for the reference PDS; assumption | spec lets the authority choose up to 60 min |
| 18 | Requesting | Body `{space, credentialKid, delegationToken?, clientAttestation?}`, no auth header | `exchangeSpaceCredential` (`SC:243-277`); refusals `UserNotAuthorized`, `NotAuthorized`, `AppNotAuthorized`, `SpaceNotFound`, `SpaceDeleted` map to 403 or 410; `InvalidDelegationToken`/`InvalidClientAttestation` stay `XrpcError` | conforms | tests `SC` test lines 61, 240, 253 |
| 19 | Presenting | `Authorization: Atproto-Space-Credential`, `Atproto-Space-Audience`, signature over exactly those two components, `tag` | `createSpaceSigHeaders` (`SC:117`); audience = repo DID for a GET with `repo`, else the authority (`SC:116,155-158`) | conforms | tests lines 75-103 |
| 20 | Host validation list | Type, issuer, signature, subject, expiry, covered list, tag, P-256, audience | PDS side (`auth-verifier.ts:361-411`, `http-signature.ts:69-152`, `util.ts:137-154`) | conforms (PDS); N/A to app | |
| 21 | Expiry | Validate expiration; short expiry is the revocation mechanism | App needs the zero-skew overlay; unmodified PDS allows 5 s past `exp` (`packages/space/src/credential.ts:66,220`) | conforms with overlay | see "Spec vs. pinned PDS" |
| 22 | Scheme case | Scheme recognised in any case | PDS side; fake mirrors (`fake-pds.ts:189-205`) | N/A to app | |
| 23 | Credential flow, reuse | One credential may serve many users | App mints per request and per user (no cross-user reuse) | conforms (cost only) | |
| 24 | Revocation by `jti` | Authority MAY send `notifyCredentialRevoked`; repo host MUST reject | PDS has the receiver only (`api/com/atproto/space/notifyCredentialRevoked.ts`); nothing in the PDS sends it | NUBD (spec ahead of PDS) | request draft U6 |
| 25 | Commit fields | `ver`, `repo`, `space`, `rev`, `data` | App reads `rev` (`channel-sync.ts:190-191`) and verifies the whole commit (`SC:190-192`) | conforms | |
| 26 | Repo lifecycle | Empty repo = nonexistent; no deletion; foreign space needs no existence check | DM tolerates `RepoNotFound` (`dm-client.ts:235`); channels and the inbox route do not (F1); `clearRecords` unused | deviates (partial) | |
| 27 | Commit digest (LtHash) | Host-maintained set hash | App never computes a set hash (lib `RepoCommit` used only by the fake) | NUBD | owner decisions 1 and 5 |
| 28 | Commit authenticity | MAC, not signature | `getLatestCommit` verified (`SC:130-143,190-192`); `listRecords` unauthenticated | conforms; `listRecords` per owner decision 1 | |
| 29 | KEM key | `{did}#atproto_kem`, `controller`, `type: Multikey`, `publicKeyMultibase` | `kem-key.ts:18-35` accepts `Multikey` and legacy `EcdsaSecp256r1VerificationKey2019`, a relative `#atproto_kem` id, and ignores `controller` | deviates (tolerant) | spec says MUST for all three |
| 30 | Shared secret | Ephemeral P-256 per request, HKDF as RFC 9180 | lib `encapsulate` per attempt (`SC:132`) | conforms | |
| 31 | Authenticity headers | `Want-Mac`/`Mac`, missing or malformed headers are errors | `SC:131-142,195-201`; no downgrade when the MAC is absent | conforms | test `SC` test line 170 |
| 32 | MAC failure | Refresh DID doc and retry with a new keypair | One forced refresh then fail (`SC:131-141`) | conforms | test line 192, 202 |
| 33 | Commit MAC | `repo`/`space` must match the request | `SC:191`, lib `repo-commit.ts:94-99` | conforms | tests 154-170 |
| 34 | Record MAC | URI matches, constant-time MAC, CID check | `SC:176-189` with Lexicon round-trip | conforms | tests 140-152, 284-299 |
| 35 | Repo serialization (STAR) | `getRepo` | Not used | NUBD | decision 5 |
| 36 | Incremental sync | `listRepoOps` with `since` | Not used; uses commit `rev` check then re-list (`channel-sync.ts:184-225`) | NUBD | |
| 37 | Full-state recovery and healing | `getRepo` or `excludeValues` diff | Not used | NUBD | |
| 38 | Blob sync | `getBlob`, `listBlobs` | Not used (no blobs) | NUBD | |
| 39 | `registerNotify` | Syncer registers; fixed duration | `notifications.ts:10-30`, DM `watch` (`dm-client.ts:493-504`); renews inside 1 h; PDS TTL is 1 day (`registerNotify.ts:13`); errors swallowed at `:27-29`; never unregisters | conforms | |
| 40 | `notifyWrite` receiver | Service auth; content-free | `route.ts:13-23`, `write-notification.ts:9-22` (strict allowed-key list rejects unknown fields) | conforms; see F3 and Nits | |
| 41 | Gap detection by `spaceRev` | `prevSpaceRev`, `listRepos` since | Not used; 60 s polling (`channel-sync.ts:189`) | NUBD | documented |
| 42 | Sync direct from the repo host | Syncer pulls from the host, not via the space host | `markRepoStale` then re-read (`workspaces/cache.ts:12-14`) | conforms | |
| 43 | Writer set `listRepos` | Enumerates writers with `rev` and `data` | `record-pages.ts:87-121` asserts order, limits and distinct DIDs; reads `repoRev` and `spaceRev`, ignores `data` | conforms | prose says `rev`, lexicon says `repoRev` |
| 44 | Writer set is a claim | Confirm each repo at its host | `channel-sync.ts:66-70` | deviates (fails the whole read on one repo) | F1 |
| 45 | `removeWriter` | `manage=update` | Not used; `removeMember` already evicts | NUBD | |
| 46 | Deletion, authority side | Stop credentials, delete own repo, notify syncers | DM `deleteEverything` (`dm-client.ts:473-476`); workspaces never delete (archive is app-level) | conforms | |
| 47 | Deletion, syncer side | Delete every copy; learn at renewal via `SpaceDeleted` | Renewal path purges (`SC:63-75`, `read-model.ts:65-67`); no `notifySpaceDeleted` handler | deviates (lazy) | F2 |
| 48 | Renewal fails otherwise | Retain copy | Purges only on 401, 403 or `SpaceDeleted` (`SC:73-75`); not on 5xx or network | conforms; predicate is broader than "authority refusal" | see Nits |
| 49 | Account deletion | Spaces under the authority go with it; learn via account events | No firehose or identity-event consumer | deviates | F2 |
| 50 | Scope grammar | `space:<type>?authority&skey&collection&action&manage` | `permission-sets.ts:34-35,42-61,65-85,95-111` verified against pinned `space-permission.ts` | conforms | `permission-sets.test.ts` |
| 51 | `read` vs `read_self` | `read_self` is own repo only, no delegation token | Discovery `read_self` (`:34-35`); own inbox `read` (`:49`) | conforms | |
| 52 | `manage` verbs | `create`, `update`, `delete` | DM scopes (`:49,56`); authority scopes (`:104-108`) | conforms | |
| 53 | Default collections | Bare grant widens with the declaration | App always lists `collection=` | conforms (does not exercise it) | |
| 54 | Consent presentation | `name`, handle, wildcard warning | PDS and oauth-provider concern | cannot verify | |
| 55 | Permission sets | `permission-set` lexicons bundle space grants | Two lexicons exist, unreferenced, contradict runtime scopes | deviates | F4 |
| 56 | `authority=` for `did:web` with a port | (spec silent) | `memberSpaceScope` (`:77-84`) does not percent-encode `%`, while `operatorMethodScope` does (`:87-91`) | cannot verify | open question |
| 57 | XRPC table: used | `getSpaceCredential`, `listRepos`, `getRecord`, `listRecords`, `getLatestCommit`, `getDelegationToken`, `createRecord`, `putRecord`, `deleteRecord`, `listSpaces`, `createSpace`, `updateSpace`, `deleteSpace`, `getSpace`, `registerNotify`, receive `notifyWrite` | grep of `src` for each NSID | conforms | |
| 58 | XRPC table: unused | `removeWriter`, `getBlob`, `listBlobs`, `getRepo`, `listRepoOps`, `applyWrites`, `clearRecords`, `importRepo`, `exportSpaceMeta`, `importSpaceMeta`, `unregisterNotify`, `notifySpaceDeleted`, `notifyCredentialRevoked` | grep | NUBD, except `notifySpaceDeleted` (F2) | |
| 59 | Policy object | Open-union `policy`; `createSpace`/`updateSpace` full object; `UnsupportedPolicy` | `space-policy.ts:6-50`, `space-ops.ts:26-30`, `dm-client.ts:145-152`; `UnsupportedPolicy` not specially handled | conforms | |
| 60 | Policy migration | Different `$type` discards state | App never changes `$type`; `withPublicWrite` refuses a non-memberspace policy (`space-policy.ts:47-50`) | conforms | |
| 61 | Authority always authorised | Without a member entry | Relied on (members list excludes the authority; pin note) | conforms | `manager.ts:245-247` |
| 62 | Baseline policies | PDS MUST support all three | App uses memberspace only; `personalspace`/`managedspace` unused | NUBD | decision 5 |
| 63 | Publishing to readers | `publishPolicy`, `publishMembers` | Unused; a space with them set is rejected as incompatible (`space-policy.ts:36-40`) | NUBD | |
| 64 | memberspace flags | `publicRead`, `publicWrite`, `allowedApps` | `publicRead` false always; `publicWrite` only for the DM inbox (`space-policy.ts:11-13`) | conforms | |
| 65 | memberspace methods | `putMember` replaces both booleans; `removeMember` SHOULD evict the writer | `space-ops.ts:39-61`; DM relies on eviction and keeps a client-side filter (`dm-client.ts:196-200`) | conforms | |
| 66 | `managedspace` | Delegates access to a managing app | Forbidden for DM spaces; unused | NUBD | |
| 67 | Account migration, meta archive | `getRepo`, `importRepo`, `exportSpaceMeta`, `importSpaceMeta` | Not used; app follows the DID document to the new PDS (`identity.ts:30-34`, `browser-identity.ts:32-46`) | NUBD | |
| 68 | Moderation | Labels stay inside the space | None implemented | spec silent for apps | |
| 69 | Key rotation | Replace `#atproto_kem`; retry | KEM cache 10 min plus forced refresh on MAC failure (`identity.ts:36-47`, `SC:131`) | conforms | |
| 70 | Identity and account events | Apps learn status changes through the firehose | Not consumed | deviates | F2 |

**Spec vs. pinned PDS (which one the app follows)**
- **Field names.** The spec prose calls the `listRepos` and `notifyWrite` fields `rev` and `data`; the lexicons say `repoRev`, `spaceRev` and `data`. The app follows the lexicons, which is right.
- **KEM key type.** The spec says `type` MUST be `Multikey`. The app's authors saw the dev-env PLC list the older `EcdsaSecp256r1VerificationKey2019` (plan item 3). The app accepts both, which is right for the alpha. It should still enforce `controller` and the id form. The reviewer could not check what the production PLC serves.
- **Unauthorised credential request.** The spec is silent on the error. The reference authority answers `SpaceNotFound`. The app maps every refusal to 403 and purges, which is right.
- **Expiry grace.** The unmodified verifier allows 5 s past `exp`. The app's contract needs the overlay. That is a deployment requirement, correctly recorded in the pin note.
- **Revocation.** The spec lets an authority fan out revocations. The pinned PDS only receives them (matrix row 24).
- **Spec ahead of the PDS.** The spec's separate account-events endpoint for space-only syncers does not exist yet. The latest proposal tweaks (`clearRecords` keeps published records, whole-archive import rejection) are already in the pinned PDS.
- **`listRepos` cursor.** The spec describes "since a space revision". The lexicon's `cursor` is exclusive and a repo can reappear, which the app handles (`record-pages.ts:82-121`).

### Scope or test gaps
- **Fake PDS is more lenient than the real one:**
  - `src/dm/testing/fake-pds.ts` has no `assertRepoAvailability`, so no `RepoDeactivated`, `RepoTakendown` or `RepoSuspended` (F1).
  - `getSpaceCredential` (`:280-300`) does not enforce single-use delegation tokens, their audience or expiry (real: `auth-verifier.ts:419-455`, `JwtReplayed`).
  - Credentials are opaque map keys, not JWTs, so `sub`, `cnf` and `exp` mismatches cannot be exercised.
  - There is no record size cap (real: 1 MiB, `jsonLimit` in `putRecord.ts`), no skey or rkey syntax checks, no OAuth scope enforcement (`self` auth only) and no rate limits.
  - A space-mismatched credential gets 403 `UserNotAuthorized` (`:443`), where the real PDS answers 400 `InvalidCredential` or 401 `BadSpaceAudience` (`space/util.ts:137-154`).
  - `listRecords` cursors are rkeys, where the real PDS returns the record URI.
- **Strengths of the fake:** it reuses the upstream library for signing, MACs and ECDH, which is why those tests catch real bugs, and the credential-core negative controls are strong. The real-PDS acceptance and BDD suites cover the rest. The reviewer did not run them.
- **No test for any of these:** the `notifyWrite` route (only `parseWriteNotification` has tests), a deactivated or taken-down writer, an oversize page, a rejected cached DM credential (plan open item 19(f)), and `UnsupportedPolicy`.
- **`space-pages.ts` coverage:** `space-pages.test.ts` covers only the weaker `listBoundedSpaces`.
- **Plan item 19(c):** the reviewer confirmed by code reading that the channel read and the admin inbox list also fail on a deactivated writer, which widens that item. Not executed.

### Adopt or plan for
1. Per-repo failure isolation for account lifecycle and size (F1).
2. A `notifySpaceDeleted` receiver, a retention sweep and logout purge (F2). Revisit once the spec's account-events endpoint exists.
3. Read `exp` (and optionally `cnf.kid`) from the credential instead of assuming 10 min. This matters if a non-reference authority issues shorter credentials: `dm-client.ts:537-551` would keep presenting an expired credential until its assumed expiry, and the reads would fail with 401.
4. Set-hash verification via `listRepoOps` or `getRepo`, and `spaceRev` gap detection. The owner chose transport trust (decision 1), so this is a plan item, not a defect.
5. Publish `publishMembers` and `publishPolicy` if the independent reader should enumerate members without owner-only `listMembers` (request draft U3).
6. A confidential client with a JWKS if workspaces ever need `allowedApps`.
7. Reuse one credential across users of an app session (spec allows it) to cut the per-request mint cost.
8. Remove or wire the permission-set lexicons (F4).

App assumptions the spec does not promise, which hold only because of the pinned PDS:
- Default `listRecords` order is newest-first by record path. `fillLatest` (`channel-sync.ts:227-257`) and the DM merge depend on it. The pinned `reader.ts` orders by `uri` descending, and the lexicon only documents `reverse`.
- The authority answers `SpaceNotFound` for unauthorised users.
- Eviction of a writer on `removeMember` and `putMember` with `write:false`, while `updateSpace` does not re-evaluate. The spec says apps "should not expect this".
- Every account has a published KEM key. The reference PDS backfills it with a `@TODO remove before beta` job (`kem-key-backfill.ts`).
- The credential lifetime is 10 min.
- Every writer's PDS stays reachable and serves bounded pages (F1).
- Third-party schemas are not validated by the PDS (pin note).

### Drift-watch list
Verified locally by the reviewer (all read-only): the pin-note lines, lexicon byte equality, npm-snapshot-versus-checkout equality, overlay hash and applicability, conformance-test copies and the package versions. The network commands were not run by the reviewer (the executor ran the three upstream-head checks; see the header).

| Upstream artifact | App mapping | Detection command | State now |
|---|---|---|---|
| Proposal `main`, `0016-permissioned-data/README.md` (only file in the dir) | pin note line 10, `lexicons/space-types.json:2`, all matrix rows | `git ls-remote https://github.com/bluesky-social/proposals.git refs/heads/main`, then `git -C ../atproto-proposals fetch origin && git -C ../atproto-proposals diff 701ef9c6be5a99c2d3e87e107fe2531459d1c984 origin/main -- 0016-permissioned-data`, plus `git -C ../atproto-proposals ls-tree -r --name-only origin/main 0016-permissioned-data` for new files | unchanged (executor) |
| Recorded pins | pin note lines 10, 11, 17 | `grep -nE "Proposal 0016\|PDS implementation\|App dependencies" docs/protocol/atproto-spaces-pin.md` | verified, 3 lines |
| PR #5187 head and branch `permissioned-data` | pin note line 11, `scripts/codegen-lex.mjs:7`, `lexicons/space-types.json:3` | `git ls-remote https://github.com/bluesky-social/atproto.git refs/pull/5187/head refs/heads/permissioned-data` | head `d0097360` (prompt-only difference), recorded only in the plan |
| Tree diff of the PR head | | the skill's `git diff --stat <recorded> FETCH_HEAD -- lexicons packages/space packages/pds packages/oauth packages/dev-env alpha-migrations`, which needs the recorded commit fetched as well | |
| `alpha-migrations/prompt-*.md` | plan "Sources" | `git ls-tree --name-only FETCH_HEAD alpha-migrations/` | pinned tree has `prompt-10-1-26.md` and `prompt-10-22-26.md`; the head adds `prompt-10-29-26.md` |
| npm snapshot `0.0.0-spaces-alpha-20261029171913` | `package.json:30,34,39`, `pnpm-workspace.yaml:9-14,24-25`, `pnpm-lock.yaml` | `npm view @atproto/space versions --json \| grep spaces-alpha \| tail -3` | latest is the pinned snapshot (executor); installed `@atproto/space` dist equals the pinned build except `credential.js` (the overlay) |
| `lexicons/com/atproto/{space,memberspace,managedspace,personalspace}/**`, `server/getServiceAuth.json` | `lexicons/com/**`, generated `src/lexicons/api/**`, `scripts/codegen-lex.mjs:50-60` | `for f in $(cd lexicons && find com -type f); do cmp lexicons/$f ../atproto-spaces-phase3/lexicons/$f; done` | byte-identical, none missing; 30 of 31 space types generated (`policy.json` excluded on purpose) |
| `packages/space/src/{credential,http-signature,mac,kem,repo-commit,types,sync/*}.ts` | `SC:1-15`, `kem-key.ts`, `space-key.ts`, fake PDS imports | diff of that directory between pins | |
| `packages/space/src/credential.ts` expiry (`:66`, `:220`) | `protocol-tests/atproto/strict-credential-expiry.patch` | `shasum -a 256` the patch (`e9cfae5beb29d01c494087abf79eaf58fd48312956422c91ff29a405977aae3f`) and `git -C ../atproto-spaces-phase3 apply --check --reverse` | matches; hunk offset is 4 lines (patch says `-210`, tree has `-214`), harmless |
| `packages/pds/src/api/com/atproto/space/**`, `memberspace/**`, `space-policy/**`, `auth-verifier.ts` (`spaceCredentialAuth`, `verifyDelegationToken`), `api/com/atproto/sync/util.ts` | fake PDS, conformance tests, F1 handling | tree diff | |
| `packages/pds/src/space-notifications.ts`, `registerNotify.ts` TTL | `notifications.ts:8`, `xrpc/notifyWrite/route.ts`, `write-notification.ts` | tree diff | |
| `packages/oauth/oauth-scopes/src/scopes/space-permission.ts`, `oauth-provider` | `src/auth/permission-sets.ts`, `dm/browser-session.ts:88` (`missingScopes`) | tree diff | |
| `packages/dev-env` | `protocol-tests/support/app-fixture.ts:46` | tree diff | |
| `packages/pds/src/kem-key-backfill.ts`, PLC output for `atproto_kem` | `kem-key.ts:18-35` | tree diff | |
| `packages/pds/tests/space/**` (11 suites, 272 passing, 1 todo) and `packages/space` (179 passing) | pin note lines 50 and 133; copies in `protocol-tests/atproto/*.test.ts` | `cmp` each copy against `../atproto-spaces-phase3/packages/pds/tests/space/` | copies identical |
| Version strings `@atproto/pds` 0.5.32, `oauth-scopes` 0.5.11, `oauth-provider` 0.22.6, `space` 0.0.1 | pin note lines 12-15 | `grep -m1 '"version"'` in each package | verified |

### Nits
- `kem-key.ts:18-35` accepts the relative id `#atproto_kem` and ignores `controller`. `browser-identity.ts:84` checks the DID document `id` only if present.
- `write-notification.ts:9-12` rejects any unknown body key. Lexicon evolution allows added fields, and this strictness caused silent degradation before (plan C6).
- `isAccessLost` (`SC:73-75`) matches any error with status 401 or 403, including one from the member's own PDS (`getDelegationToken`) or a host rejecting an expired credential. That over-purges, which is the safe direction.
- `route.ts:16-23` and `operator/security.ts:27-52` do not enforce `jti` uniqueness. Harmless for `notifyWrite`. The spec is silent.
- Comment at `record-pages.ts:9` ("500 shared by listRepos/listMembers/listRecords") is stale: the lexicon maxima are 1000, and 500 is the app's own cap.
- `docs/protocol/atproto-spaces-pin.md` line 145 and the other stale statements are listed in F5.
- The NAT64 prefix `64:ff9b::/96` and 6to4 are not in the non-public address list (`identity.ts:192-204`). Only relevant in NAT64 environments. Open question.
- Skill review (`.claude/skills/align-app-against-protocol-spec`; not a review subject, applied afterwards):
  - Step 1's tree-diff row (`git diff --stat <recorded> FETCH_HEAD`) depends on the recorded commit being present; a `--depth=1` fetch of the PR head does not fetch it. Add `git fetch --depth=1 --filter=blob:none <url> <recorded>`.
  - The PR head already differs from the recorded commit (prompt-only, `d0097360`), but only the plan records that sha. Record "last seen PR head" so each run need not re-investigate.
  - The re-pin grep with a 40-character sha misses files that use the short form (`README.md`, `docs/prd/atproto-slack-clone.md`, `protocol-tests/atproto/README.md`, `protocol-tests/dm-performance.test.ts`, `.ai/upstream/U*.md`, `.ai/plans/direct-messages.md`). Grep the full sha and the 8-character prefix. `protocol-tests/support/app-fixture.ts` matches by directory name instead.
  - The owner table omits `src/dm/browser-identity.ts`, `src/dm/browser-session.ts`, `src/atproto/write-notification.ts`, `src/atproto/notifications.ts` and `src/app/xrpc/com.atproto.space.notifyWrite/route.ts`.
  - The skill said the app pins `car`, `lex-cbor` and `syntax`. `package.json` pins only `space`, `crypto` and `lex-data` (`:30,34,39`); the other three appear only in release-age exclusions (`pnpm-workspace.yaml:9-14`), and `lex-cbor`/`lex-data` are range overrides (`:24-25`).
  - The two env var names (`ATPROTO_PIN_CHECKOUT` for codegen, `ATPROTO_PINNED_CHECKOUT` for the rest) match the code. The re-pin file list is otherwise accurate.
- The pinned checkout holds three untracked conformance test copies, matching the pin note.

### What is sound
- **Credential and MAC handling:** all credentialed requests have a single owner. Missing or malformed MAC headers fail closed with no downgrade, and one forced DID-document refresh handles key rotation. Commit `repo`/`space` and record URI are bound, and the CID is checked after the Lexicon round-trip. A fresh ephemeral key is used per attempt. The credential key is per credential and non-extractable. The audience is the repo DID for single-repo reads and the authority otherwise.
- **SSRF and identity resolution:** DNS-pinned agents, redirect errors, a non-public address block list, bounded bodies, and the identity library fetch (covering `did:web`) all route through the guarded fetcher.
- **Cache and authorisation:** every channel read re-mints a credential before touching the cache, and an access-lost or deleted result purges that account's rows. Rows are encrypted with row-bound context. Every route requires a session or service auth, and mutations reject cross-origin requests.
- **Records and scopes:** authority-only records are accepted only from the authority's repo. Scope strings match the pinned grammar and always list collections explicitly.
- **Checked-in artifacts:** app lexicon copies are byte-identical to the pinned tree. The npm `@atproto/space` snapshot equals the pinned build except for the overlay. The overlay hash and applicability match the pin note, and the three conformance copies are identical.
- **Owner decisions** match the code and docs, including the 8 s DM read budget.
- **Docs and tests:** README's "68 of 69 scenarios executable" is accurate (69 scenarios, 1 unbound). The credential-core test file has negative controls for tampering, wrong type, absent MAC, rotation and oversize bodies.

### Verification
Commands the reviewer ran, all read-only:
- `git rev-parse HEAD` in both sibling checkouts: both match the given SHAs. The pinned checkout carries only the expected overlay and 3 untracked copies.
- `shasum -a 256` of the overlay: `e9cfae5b…ae3f`, same as the pin note. `git apply --check --reverse`: the in-tree overlay matches the checked-in patch.
- `cmp` of the three conformance tests, all app `lexicons/com/**` files, and every `@atproto/space` dist file: identical, except `credential.js` (the overlay).
- `node_modules/.bin/tsc --noEmit`: exit 0, no errors. `node_modules/.bin/eslint .`: 0 errors, 1 warning (`logout-button.tsx`), the recorded baseline.
- `node --import tsx --test 'src/**/*.test.ts' 'bdd/**/*.test.ts'`: 298 pass, 0 fail, matching `PROGRESS.md`.
- Greps and file reads across the app, the pinned PDS and the docs as cited.

Not run, and why:
- The BDD, browser, acceptance and performance suites and the pinned jest suites. The first four were excluded by instruction; the jest suites need the full build.
- `git ls-remote`, `npm view` and any fetch: external contact was disallowed, so "nothing moved" is not asserted by the reviewer.
- Everything about `prompt-10-29-26.md` beyond the pin note and plan.
- F1 and F3 are code-path conclusions, not executed. F1's per-writer failure is deduced from the pinned PDS code. The oversize page figures come from the stated caps.

Unconfirmed, labelled as open questions: the percent-encoding of a `did:web` authority with a port in `memberSpaceScope`; what the production PLC serves for `#atproto_kem`; whether the pinned consent screen shows the declared space-type `name` for the app's lexicons; NAT64 coverage; and whether a deactivated writer also breaks the DM conversation view in the browser (same code, not run).

Side effect disclosed by the reviewer: one log file (unit-test output) written to the session scratchpad by shell redirect, outside the repo and both sibling checkouts. Nothing else was created or changed.
