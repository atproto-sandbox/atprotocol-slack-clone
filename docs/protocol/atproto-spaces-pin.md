# atproto Spaces Protocol Pin and Conformance

Status: **R12 pinned & aligned (`6747610566`, `0.0.0-spaces-alpha-20261117141222`); `@atproto/space` patched & passing (9/9 files, 173/173 tests); Flock protocol, operator, reader, client, web, and conformance suites aligned to `#5187` @ `6747610566`**  
Verified pin & patch: 2026-11-17 (updated from `5d88b414`, 2026-10-30; before that `619c6e85`, `5b95b2f2`, `787a730f`)

## Pinned source

| Component | Pin |
|---|---|
| Upstream PR / Commit | `bluesky-social/atproto` `permissioned-data`, PR [#5187](https://github.com/bluesky-social/atproto/pull/5187), commit `6747610566eee1b6d743617bd8eb1136adccb362` (previously `5d88b414a98de1ada22c94c78fa0667a7028163c`) |
| PDS development environment | Same pinned monorepo commit in `../atproto-spaces-r12`; `@atproto/dev-env` multi-PDS fixture (`devMode: true`, `disableSsrfProtection: true`) |
| App Spaces dependencies | `@atproto/space`, `@atproto/star`, `@atproto/crypto`, `@atproto/lex-data`, `@atproto/lexicon`, `@atproto/xrpc-server` at `0.0.0-spaces-alpha-20261117141222` (snapshot from `223114799`, byte-identical to `6747610566` across `lexicons/`, `packages/{space,star,crypto,xrpc-server}`, and `packages/oauth/{oauth-client*,jwk-jose,oauth-provider}`). Stable non-Spaces packages (`@atproto/oauth-client-{node,browser}`, `@atproto/identity`, `@atproto/jwk-jose`, `@atproto/xrpc`, `@atproto/lex-cli`) stay on their existing pins. `pnpm-workspace.yaml` pins all `^0.0.0-spaces-alpha-*` overrides and `minimumReleaseAgeExclude` entries to `0.0.0-spaces-alpha-20261117141222` to prevent matching stray uninstallable `0.0.0` releases |
| Strict credential-expiry overlay | [`protocol-tests/atproto/strict-credential-expiry.patch`](../../protocol-tests/atproto/strict-credential-expiry.patch), SHA-256 `3f413baa779473b5466e8e6ca9edc92335f5056edbd13aa3d4bfc57a509b32dd` (rebased onto `6747610566`: `packages/space/src/credential.ts` + `packages/space/src/credential.test.ts`) |

PR #5187 (`permissioned-data`) remains in active development, and unmodified `6747610566` still applies five seconds of expiry tolerance (`CLOCK_SKEW_SEC = 5`) to all space tokens including credentials (`packages/space/src/credential.ts:296`). The rebased overlay preserves strict zero-skew cutoff on `'credential'` (`type === 'credential' ? 0 : CLOCK_SKEW_SEC`) while keeping five-second tolerance on `'delegation'` and `'clientAttestation'`, and updates `packages/space/src/credential.test.ts` (moved from `packages/space/tests/` in upstream PR `#5924`). Any deployment must retain this overlay or an upstream fix and rerun Gate 4 conformance.

Production operator & webhook deployment notes:
- **Public HTTPS webhook endpoint (`L7`):** Upstream `authorizeSpaceSync` and `SpaceNotifications` deliver `confirmRegistration` and `notifySpaceUpdate` through `ctx.safeClient(endpoint)` (with `disableSsrfProtection` disabled outside `devMode: true`). Production `OPERATOR_URL` must therefore be a **public HTTPS origin**; loopback/private IPs are rejected in non-dev PDS deployments.
- **OAuth lexicon republish (`L8`):** Production deployments using OAuth space-permission consent screens must republish the 7 updated `new.flock.*` space lexicons carrying `"title"` (replacing `"name"`), together with `new.flock.operator.getDmNotifyTarget` and `new.flock.permissions.{member,workspaceAuthority}`.

## Reproduce the pinned checkout & build (`../atproto-spaces-r12`)

Upstream `6747610566` uses `pnpm@12.16.1` (`lockfileVersion: '9.0'`) and declares `devEngines.runtime` `^22.23.4 || ^24.22.1 || ^26.12.1` (with `undici@8.12.3`). Use Node `>= 22.23.4` (`< 23`, matching root `NODE_MODULE_VERSION` 127) if installed; on hosts with Node `22.17.0` + `/opt/homebrew/bin/node` (`v25.4.0`), `oauth-provider-ui` Lingui extraction (`lingui` CLI `import.meta.main`) runs once under Node `>= 24.2`, while native addons (`better-sqlite3`, `@swc/core`, `sharp`) and `dev-env` build under Node `22.x` (`PUPPETEER_SKIP_DOWNLOAD=true`, `--runtime-on-fail=ignore`):

```sh
git clone --filter=blob:none --no-checkout https://github.com/bluesky-social/atproto.git atproto-spaces-r12
git -C atproto-spaces-r12 fetch --depth=1 origin 6747610566eee1b6d743617bd8eb1136adccb362
git -C atproto-spaces-r12 checkout --detach 6747610566eee1b6d743617bd8eb1136adccb362
cd atproto-spaces-r12
shasum -a 256 /path/to/atproto-slack-clone-r12/protocol-tests/atproto/strict-credential-expiry.patch
git apply /path/to/atproto-slack-clone-r12/protocol-tests/atproto/strict-credential-expiry.patch
PUPPETEER_SKIP_DOWNLOAD=true pnpm --runtime-on-fail=ignore install --frozen-lockfile
pnpm --runtime-on-fail=ignore run build:tooling
# Run oauth-provider-ui prebuild with Node >= 24.2 if on Node 22.x:
pnpm --runtime-on-fail=ignore --filter @atproto/oauth-provider-ui prebuild
pnpm --runtime-on-fail=ignore --filter @atproto/dev-env... --filter @atproto/space --filter @atproto/star prebuild
pnpm --runtime-on-fail=ignore --filter @atproto/dev-env... --filter @atproto/space --filter @atproto/star --filter @atproto/lex-cli build
pnpm --runtime-on-fail=ignore --filter @atproto/space test
```

Verified on 2026-11-17: `@atproto/space` passed 9/9 test files, 173/173 tests (including 33 tests in `src/credential.test.ts` with strict expiry enforced). To run Gate 4 multi-PDS conformance against the built `../atproto-spaces-r12` checkout, temporarily copy `protocol-tests/atproto/slack-{inbox,dm,authority-oauth}-conformance.test.ts` into `../atproto-spaces-r12/packages/pds/tests/space/`, execute `NODE_OPTIONS=--experimental-vm-modules pnpm -C ../atproto-spaces-r12 --filter @atproto/pds exec jest --runInBand tests/space/`, and remove the temporary copies afterward so `../atproto-spaces-r12` stays clean apart from `strict-credential-expiry.patch`.

The pinned PDS validates only lexicons in its built-in schema map; app writes therefore leave `validate` unset and run `validateSpaceRecord` locally before every write, and every reader validates author, schema, key, and cross-record references. Hash-derived record keys retain `:` between adjacent lowercase base32 symbols so digests cannot trigger the PDS explicit-slur filter.

## What changed since `5d88b414` (to `6747610566` — Wave `R12`)

The drift from `5d88b414` to `6747610566` spans 88 commits on PR #5187 (`alpha-migrations/prompt-11-5-26.md` and `alpha-migrations/prompt-11-12-26.md`, published as npm snapshot `0.0.0-spaces-alpha-20261117141222`).

| Upstream change (`5d88b414..6747610566`) | Flock alignment |
|---|---|
| `getSpaceCredential`, `registerNotify`, `unregisterNotify`, `notifySpaceDeleted` removed; `notifyWrite` -> `notifyRepoUpdate` (PDS-to-authority only). New `com.atproto.space.authorizeSpaceSync` (`{ space, credentialKey, delegationToken?, clientAttestation?, notify? }` -> `{ credential, spaceRev? }`); inline `notify: { endpoint, token }` (`<= 512` chars) triggers sync `confirmRegistration` on first registration for `(space, endpoint, token)`, expires with `credential.exp` (`600 s` default, `3600 s` ceiling), and delivers `notifySpaceUpdate` (`#repoWrite`, `#repoRemoved`, `#registrationExpired`, `#spaceDeleted`). `safeClient` enforces SSRF protection (`L7`) | `exchangeSpaceCredential` & `mintSpaceCredentialWith` (`space-credential-core.ts`); `NOTICE_METHOD` serves only `confirmRegistration` and `notifySpaceUpdate` with constant-time `timingSafeEqual` token auth (`notices.ts`, `space-notification.ts`). Operator persists one stable random token per space in `notification_registration.{token, renew_at, last_space_rev}`, renews via 60s SQL-first loop (`15 s -> 2 min` backoff) + 30m discovery sweep, catches gaps via `spaceRev`, and confirms `#spaceDeleted` via authority `authorizeSpaceSync` before purging state |
| Browser DM push notifications need a public HTTPS webhook sink without server-held member sessions or SQLite DM rows | `new.flock.operator.getDmNotifyTarget` verifies a caller-held `SpaceCredential` (`sub === space`) + fresh RFC 9421 `verifyCredentialSig` PoP + replay guard and derives a deterministic stateless `dm1` HMAC token (`AUTH_ENCRYPTION_KEY`, `"flock-dm-notify-v1"`). Inbound DM wakes flow through ephemeral in-memory `apps/operator/src/operator/dm-feed-wakes.ts` (zero DM rows in any SQLite table, `reset` across restarts); DM `#registrationExpired` returns HTTP `400` (`abandonSyncerNotice`); `DmClient.watch` falls back immediately to `authorizeSpaceSync` without `notify`; `session.ts` keeps pre-R12 sessions lacking `getDmNotifyTarget` signed in |
| RFC 9421 HTTP message signatures & HPKE MACs: `createSpaceSigHeaders({ authorization, audience, keypair })` (`tag="atproto-space-credential"`); `Accept-Signature` (`COMMIT_MAC_PROFILE`, `RECORD_MAC_PROFILE`) with ephemeral `encapsulate` key share (`info: "atproto-mac"`, `SpaceKemError`); response headers `Atproto-Space-Commit` / `Atproto-Space-Record` + `Signature-Input` + `Signature`; throwing `verifyCommitMac` / `verifyRecordMac` / `verifyCommit` / `verifyRecord` (`SpaceMacError` `InvalidSpaceMac`, `SpaceRepoVerificationError` `InvalidSpaceRepo`) | `space-credential-core.ts`, `kem-key.ts`, `repo-failure.ts`, `FakeNetwork` (including CORS `Access-Control-Expose-Headers: atproto-space-commit, atproto-space-record, signature-input, signature` and `Vary: Accept-Signature`), and `@flock/reader` |
| `@atproto/star` extracted; `getRepo` serves `application/vnd.dasl.star`; `serializeRepo` -> `writeRepoStar(commit, entries)`; STAR record entries carry `0x01 + varint(keyLen) + key + varint(valLen) + val` (no CID); `LTHASH_STATE_BYTES` removed from `@atproto/space` | Direct `@atproto/star` dep in `@flock/{protocol,reader,testing}`; `starEntryBytes` exact byte parity with `writeRepoStar`; `LTHASH_STATE_BYTES = new LtHash().state().byteLength` (`2048`) |
| `listRepos` -> `listWriters` (`repos` union of `com.atproto.space.defs#repoWrite` `{ repo, repoRev, spaceRev, data }` and `#repoRemoved` `{ repo, spaceRev }`; `#repoRemoved` GC'd after 72h; `InvalidCursor`). `listRepoOps` includes signed/MAC'd `commit` on **every** page and returns `400 RepoNotFound` for unwritten repos | `listBoundedWriters` (latest-entry-wins per `repo` across pages) and `listWritersSince` (>72h or `InvalidCursor` full-reconciliation fallback); `UnsignedEmptyRepoOpsError` and intermediate-page `commit`+`cursor` workarounds removed so every `listRepoOps` page verifies commit+MAC |
| Account suspension vs takedown: `RepoTakendown` / `RepoDeactivated` on `authorizeSpaceSync` and `listWriters` indicates authority suspension (`assertActiveSpaceHost`); `401 AccountTakedown` / `AccountDeactivated` on management endpoints | `RepoTakendown`/`RepoDeactivated` on `authorizeSpaceSync`, `listWriters`, **and** repo reads where `repo === authorityDid` classify as transient suspension (preserving local cached state), while `repo !== authorityDid` remains `permanent: true` per-writer eviction; `401 AccountTakedown`/`AccountDeactivated` on operator management calls preserves `authority_grant` without retry storms |
| `putMember` / `removeMember` -> batched `putMembers` (`{ space, members }`, `<= 100`) and `removeMembers` (`{ space, dids }`, `<= 100`); explicit `write: false` entries stay excluded even when `publicWrite: true`; `managedspace.checkUserAccess` -> `checkAccess`; `.uri` -> `.space` (`createSpace`, `getSpace`, `listSpaces`), `did` -> `spaceDid` (`listSpaces`), `did` -> `repo` (`removeWriter`), `listRecords` drops `reverse`; `NotSpaceOwner` -> `NotAuthorized`, `UserNotAuthorized` -> `AccountNotAuthorized`; `ACCESS_FULL` enforced on account-authenticated space/memberspace endpoints (`#5923`); space lexicon `"name"` -> `"title"` | Updated across `space-ops.ts`, `members.ts`, `dm-client.ts` (`setRequestMode("everyone")` reactivates dormant allowlist rows to `{ read: false, write: true }`; Flock's `OperationRequest.kind = "removeMember"` preserved), `FakeNetwork`, 7 `new.flock.*` space lexicons (`L8`), and platform/conformance tests |

## API and authorization mapping (current `6747610566` pin)

| Product operation | Pinned API and observed behavior |
|---|---|
| Create/update a space | `com.atproto.space.createSpace`, `updateSpace`, `getSpace`, `deleteSpace`; output uses `space` (`at://<authority-did>/space/<type>/<skey>`). Every Flock space uses `com.atproto.memberspace.policy` (`packages/protocol/src/atproto/space-policy.ts`); `publicRead` and `publicWrite` default to `false`, and the DM inbox sets `publicWrite: true` for `"everyone"`. `updateSpace` replaces the whole policy; `getSpace` is owner-only (`NotAuthorized` for non-owners). Account-authenticated space/memberspace endpoints require `ACCESS_FULL` (refusing app passwords with `InvalidToken: Bad token scope`, `#5923`). |
| Set/remove membership | `com.atproto.memberspace.putMembers` (`{ space, members }`, `<= 100`) replaces `read` and `write` per member; `removeMembers` (`{ space, dids }`, `<= 100`) deletes members; `com.atproto.space.removeWriter` takes `{ space, repo }`. Removing a member or setting `write: false` emits `#repoRemoved` in `listWriters` (and explicit `write: false` entries remain excluded even under `publicWrite: true`, so switching a DM inbox to `"everyone"` reactivates dormant allowlist rows to `{ read: false, write: true }`). Requires the space authority DID and `manage=update` (`PolicyMismatch` on non-memberspace policies). |
| Read membership state | `com.atproto.memberspace.listMembers` returns `{ members: [{ did, read, write }], cursor? }` and requires the owner session with `action=read_self`. A space credential and non-owner member cannot call it. The authority is implicitly admitted for reads and credentials without being listed as a member. |
| Discover spaces | `com.atproto.space.listSpaces` (`spaceDid`, `spaceType`) returns `spaces` views carrying `space` (and optional `repoRev`, `data`, `spaceRev`) from the caller's own repo. The invitee's `new.flock.acceptance` record supplies that index entry; it is not a membership check. |
| Mint a read credential & register sync notifications | The account PDS issues `com.atproto.space.getDelegationToken`; the space authority exchanges it via `com.atproto.space.authorizeSpaceSync` (`{ space, credentialKey, delegationToken?, clientAttestation?, notify? }` -> `{ credential, spaceRev? }`, body-only POST with no session auth header). The member list (or `publicRead`) controls issuance; unauthorized callers and missing spaces both receive `SpaceNotFound` (`SpaceDeleted` first; `AccountNotAuthorized` for explicit policy denials). `RegistrationNotConfirmed` and authority `RepoTakendown`/`RepoDeactivated` remain non-refusal errors (`isAccessLost === false`). Credentials carry `cnf.kid` and `jti`, are presented with `createSpaceSigHeaders` (`tag="atproto-space-credential"`), and live 600 s by default (`3,600 s` ceiling). Optional `notify: { endpoint, token }` binds webhook delivery to `credential.exp`, running synchronous `confirmRegistration` on first registration of `(space, endpoint, token)` and delivering `notifySpaceUpdate`. |
| Read records & verify MACs / STAR | `listWriters` and `listRecords` (server default `uri desc`) require only a signed space-credential header. `getRecord` (`RECORD_MAC_PROFILE`), `getLatestCommit`, `listRepoOps` (`COMMIT_MAC_PROFILE` + signed `commit` on every page; `400 RepoNotFound` when unwritten), and `getRepo` (`Accept: application/vnd.dasl.star`, `@atproto/star`) send an ephemeral HPKE key share in `Accept-Signature` (`encapsulate` against `#atproto_kem`, `info: "atproto-mac"`) and verify `Atproto-Space-Commit` / `Atproto-Space-Record` + `Signature-Input` + `Signature` (`SpaceKemError`, `SpaceMacError` `InvalidSpaceMac`, `SpaceRepoVerificationError` `InvalidSpaceRepo`). |
| Write records | `com.atproto.space.createRecord`, `putRecord`, `deleteRecord`, and `applyWrites` address the author's own repo (`ACCESS_FULL` required; OAuth scope checks distinguish create/update/delete and target collection). Writes and read credentials are separate protocol permissions. |
| Synchronize writers & suspension | PDS-to-authority `com.atproto.space.notifyRepoUpdate` updates the authority's writer set; `com.atproto.space.listWriters` enumerates `repos` union items (`com.atproto.space.defs#repoWrite` `{ repo, repoRev, spaceRev, data }` and `#repoRemoved` `{ repo, spaceRev }`) in ascending `spaceRev` order (`InvalidCursor` or cursors >72h fall back to full `listBoundedWriters` latest-entry-wins reconciliation). If PDS-to-authority `notifyRepoUpdate` is dropped, owner-only `listMembers` (`listInboxWriters`) enumerates `write=true` inbox candidates. `RepoTakendown`/`RepoDeactivated` on `authorizeSpaceSync`, `listWriters`, or `repo === authorityDid` is treated as temporary authority suspension, whereas `repo !== authorityDid` remains permanent per-writer takedown. |

## Slack split-policy conformance

The retained multi-PDS inbox conformance suite (`protocol-tests/atproto/slack-inbox-conformance.test.ts`) creates a `new.flock.inbox` with `com.atproto.memberspace.policy`. The requester and ordinary member have `read=false, write=true` (via `putMembers`); the admin has `read=true, write=true`. The requester writes a request to their own PDS. The requester's repo appears as `#repoWrite` in `listWriters` when `notifyRepoUpdate` arrives, and an admin credential minted via `authorizeSpaceSync` reads and MAC-verifies the record. The requester can read their own repo but cannot mint an inbox credential (`SpaceNotFound`) or read another writer's repo. The authority owner has implicit access. An authority-authored `new.flock.admin` record does not let that human DID mutate the PDS member list (`NotAuthorized`).

The conformance test also drops the requester's PDS-to-authority notification: `listWriters` omits the requester while authority `listMembers` still reports `write=true`, and the admin credential reads that candidate repo directly. Membership removal (`removeMembers`) emits `#repoRemoved` and prevents minting a fresh credential; the rebased strict-expiry overlay (`3f413baa779473b5466e8e6ca9edc92335f5056edbd13aa3d4bfc57a509b32dd`) rejects an already-minted space credential at `exp` (`exp + 2s` on both PDS hosts) while preserving five-second clock-skew tolerance on delegation tokens and client attestations.

## Direct-message conformance

`protocol-tests/atproto/slack-dm-conformance.test.ts` verifies symmetric conversation halves across PDS hosts (`listWriters` lists only the half owner; foreign writes are untracked and rejected by author validation), closed existence oracle (`SpaceNotFound` for unauthorized/missing spaces, `SpaceDeleted` after deletion; public `new.flock.dm.declaration` indicates an enabled inbox), public-write vs allowlist policy transitions (`putMembers` / `removeMembers` emit `#repoRemoved`, and switching back to `publicWrite: true` reactivates dormant allowlist rows to `{ read: false, write: true }`), public browser OAuth scopes (`token_endpoint_auth_method: "none"`), non-extractable P-256 `credentialKey` (`cnf.kid`) binding on `authorizeSpaceSync`, and credential expiry after `removeMembers`.

## OAuth scope proof

`protocol-tests/atproto/slack-authority-oauth-conformance.test.ts` uses a real PDS OAuth `TokenManager` to sign a DPoP-bound OAuth access token (OAuth keeps DPoP; space-credential requests use RFC 9421 HTTP message signatures). The token calls `putMembers` and authority record-write handlers with `manage=update` plus the exact `new.flock.admin` collection actions, denies membership mutation when restricted to `action=read`, and mints a `com.atproto.server.getServiceAuth` JWT whose `iss`, `aud`, and `lxm` match the operator contract. `protocol-tests/platform-capabilities.test.ts` additionally verifies `#5923` app-password enforcement (`createRecord` and `getDelegationToken` rejected with `InvalidToken: Bad token scope`, while `getServiceAuth` remains allowed).

## Authority operator scopes

The operator's workspace-DID OAuth session (`workspaceAuthorityScopes` in `packages/protocol/src/scopes.ts`, mirrored in `new.flock.permissions.workspaceAuthority`) is limited to these scopes, where `authority=self` resolves to the workspace DID and `skey=*` covers only spaces under that authority:

```text
space:new.flock.workspace?authority=self&skey=*&action=read_self&action=read&manage=create&manage=update
space:new.flock.workspace?authority=self&skey=*&collection=new.flock.workspace.profile&collection=new.flock.directory&collection=new.flock.workspace.roster&collection=new.flock.admin&collection=new.flock.app.install&collection=new.flock.ext.install&action=create&action=update&action=delete

space:new.flock.inbox?authority=self&skey=*&action=read_self&action=read&manage=create&manage=update
space:new.flock.inbox?authority=self&skey=*&collection=new.flock.joinDecision&action=create&action=update&action=delete

space:new.flock.channel?authority=self&skey=*&action=read_self&action=read&manage=create&manage=update
space:new.flock.channel?authority=self&skey=*&collection=new.flock.channel.roster&action=create&action=update&action=delete

space:new.flock.app.inbox?authority=self&skey=*&action=read_self&action=read&manage=create&manage=update

space:new.flock.ext.tasks?authority=self&skey=*&action=read_self&action=read&manage=create&manage=update
```

The operator has no message, reaction, join-request, or DM scope. Browser member sessions request one combined operator RPC token (`memberGrantScopes` in `packages/protocol/src/scopes.ts`), replacing `OPERATOR_DID` with the DID publishing `#atproto_flock_operator`:

```text
rpc?lxm=new.flock.operator.execute&lxm=new.flock.operator.getOperation&lxm=new.flock.operator.listInboxWriters&lxm=new.flock.operator.getChanges&lxm=new.flock.operator.createWorkspace&lxm=new.flock.operator.startAuthorityFlow&lxm=new.flock.operator.listStalledOperations&lxm=new.flock.operator.getDmNotifyTarget&aud=OPERATOR_DID%23atproto_flock_operator
```

Pre-R12 browser sessions holding `LEGACY_OPERATOR_METHODS` (without `new.flock.operator.getDmNotifyTarget`) remain admissible in `apps/web/src/browser/session.ts` for reads, admin/member mutations, and polling fallback. For each operator call, the client calls `com.atproto.server.getServiceAuth` with `aud=OPERATOR_DID#atproto_flock_operator` and `lxm` equal to that method's NSID; the operator verifies the service JWT, takes the actor DID strictly from `iss`, and rechecks authority records and PDS membership on every admin method.

## Stable key encoding

For each hashed rkey, calculate SHA-256 over UTF-8 bytes and encode the 32-byte digest with RFC 4648 base32 using lowercase alphabet `abcdefghijklmnopqrstuvwxyz234567` and no padding. Insert `:` between every adjacent base32 symbol before adding the key prefix. Prefix the delimited string with:

| Key | Input |
|---|---|
| `d-` subject/roster | Canonical DID string |
| `r-` request | Canonical channel URI, NUL byte, requester DID |
| `a-` acceptance | Canonical workspace URI |
| `x-` reaction | Canonical message URI, NUL byte, emoji, NUL byte, author DID |
| `q-` decision | Canonical request URI |
| `i-` app inbox skey | Workspace `skey`, NUL byte, canonical app DID |
| `x-` extension space skey | `${extId}:${workspaceSkey}` |

Each string is already required to be valid UTF-8 and contain no NUL. URI values are parsed and serialized to the canonical atproto URI form before hashing. The workspace directory uses the literal channel `skey`; a request generation remains a fresh TID in the record value. The full canonical rule is also in the [PRD](../prd/atproto-slack-clone.md#lexicons-and-current-record-rules).

---

## Historical Pin Log (Prior `5d88b414`, `619c6e85`, `5b95b2f2`, `787a730f` verification notes — preserved for reference)

Status (historical `5d88b414`): pinned PDS API/policy and strict-expiry conformance pass with the checked-in verifier patch; the unmodified upstream base still fails the PRD cutoff  
Verified (`5d88b414`): 2026-10-30 (re-based from `619c6e85`, verified 2026-10-21; before that `5b95b2f2`, 2026-10-09, and `787a730f`, 2026-09-25)

The proposal describes itself as a proposal, and PR #5187 (branch `permissioned-data`) is still marked Draft as of this verification. The unmodified `5d88b414` source still allows five seconds of expiry skew for credentials. The checked-in overlay changes `verifySpaceToken` in `packages/space/src/credential.ts` so a space credential is rejected at `exp` (zero skew) while delegation tokens and client attestations keep the five-second allowance, and it replaces the skew test in `packages/space/tests/credential.test.ts` with an at-`exp` rejection test plus a delegation-skew test. Space credentials are presented with HTTP message signatures (tagged `atproto-space-credential`), not DPoP, so the overlay does not mention DPoP proofs. It applies to the `5d88b414` sources with line offsets only. This is a local protocol fork requirement: any deployment must use this overlay or a compatible upstream revision and rerun conformance. Treat protocol drift as a release blocker.

The pinned PDS validates only lexicons in its built-in schema map; publishing third-party `new.flock.*` schemas does not make them dynamically available to record validation in this revision. App writes therefore leave the optional PDS `validate` parameter unset and run `validateSpaceRecord` locally before every write. Every reader validates author, schema, key, and cross-record references and ignores invalid records. Do not set `validate: true` on app-owned records unless the PDS revision adds dynamic third-party schema resolution.

The pinned PDS also rejects record keys matching its explicit-slur filter. A contiguous base32 digest can trigger that filter by chance, so every hash-derived record key inserts `:` between the lowercase base32 symbols. The filter does not remove colons when checking for words, and the pinned record-key syntax accepts them. This delimiter is part of the published canonical key encoding; interoperable apps must preserve it.

### Reproduce the PDS conformance run (historical `5d88b414`)

Use Node 24 as selected by the pinned checkout's `.nvmrc` (the local proof also ran on Node 22.17.0) and pnpm 11.11.0. In a disposable clone (the app's checkout name for it is `atproto-spaces-phase3`; make it a standalone clone, not a `git worktree`, so deleting an older checkout cannot break it):

```sh
git clone --filter=blob:none --no-checkout https://github.com/bluesky-social/atproto.git atproto-spaces-phase3
git -C atproto-spaces-phase3 fetch --depth=1 origin 5d88b414a98de1ada22c94c78fa0667a7028163c
git -C atproto-spaces-phase3 checkout --detach 5d88b414a98de1ada22c94c78fa0667a7028163c
cd atproto-spaces-phase3
shasum -a 256 /path/to/atproto-slack-clone/protocol-tests/atproto/strict-credential-expiry.patch
git apply /path/to/atproto-slack-clone/protocol-tests/atproto/strict-credential-expiry.patch
PUPPETEER_SKIP_DOWNLOAD=1 corepack pnpm@11.11.0 install --frozen-lockfile --filter @atproto/pds... --filter @atproto/dev-env...
corepack pnpm@11.11.0 build:tooling
corepack pnpm@11.11.0 --filter @atproto/space build
corepack pnpm@11.11.0 --filter @atproto/pds... --filter @atproto/dev-env... build
```

Copy the three `protocol-tests/atproto/*.test.ts` files into `packages/pds/tests/space/`, run `corepack pnpm@11.11.0 --filter @atproto/space test`, then run:

```sh
NODE_OPTIONS=--experimental-vm-modules corepack pnpm@11.11.0 --filter @atproto/pds exec jest --watchman=false --runInBand \
  tests/space tests/space-scope.test.ts
```

`tests/space` holds the upstream space suites and our three. On `5d88b414` the run is 11 suites, 272 tests passing plus 1 upstream `todo`.

Build notes (recorded on `5b95b2f2`): the install needs `PUPPETEER_SKIP_DOWNLOAD=1` (shown above) and `npm_config_enable_pre_post_scripts=true` for the `build:tooling` and package builds; `oauth-provider-ui` needs its Lingui catalogs compiled once with `pnpm --filter @atproto/oauth-provider-ui i18n:compile` under Node 26 (the codegen uses `import.meta.main`) before the Node 22 build.

The verification recorded on `787a730f` passed 101 `@atproto/space` tests and six PDS suites with 108 tests passing and one upstream `todo`; the figures for `619c6e85` are in `PROGRESS.md`. It exercised independent accounts on up to three in-memory PDS hosts; the custom expiry test rejects at `exp + 2s` on both PDS hosts. The custom tests and exact source patch are retained in this checkout; see [protocol test instructions](../../protocol-tests/atproto/README.md).

### What changed since `619c6e85` (to `5d88b414`)

The drift to `5d88b414` is the October 22 and October 29 alpha releases (about 40 commits on PR #5187, still a draft). The upstream migration prompts are `alpha-migrations/prompt-10-22-26.md` and `prompt-10-29-26.md` in `permissioned-data`. The strict-expiry overlay applies with offsets only (same SHA-256). `getRepo` (now STAR, not CAR), account migration, `clearRecords`, `importRepo`, published policy and member records, and `personalspace`/`managedspace` are not used by this app.

| Upstream change | This app |
|---|---|
| `com.atproto.simplespace.*` is removed. `createSpace`/`updateSpace`/`getSpace`/`deleteSpace` are `com.atproto.space.*`; `putMember`/`removeMember`/`listMembers` are `com.atproto.memberspace.*` (`PolicyMismatch` on another policy). A space has one open-union `policy`; `updateSpace` replaces it wholesale; `getSpace` is owner-only and returns `{ uri, policy }` | `packages/protocol/src/atproto/space-policy.ts` is the one owner of the policy object. Every Slack space is `com.atproto.memberspace.policy`; the DM inbox sets `publicWrite` for "everyone". `updateSpace` sends the whole policy |
| `getSpaceCredential` takes `{ space, credentialKid, delegationToken?, clientAttestation? }` in its body, with no authorization header or signature; a bad token is `InvalidDelegationToken` | `exchangeSpaceCredential` in `packages/protocol/src/atproto/space-credential-core.ts` |
| Credentials are presented as `Atproto-Space-Credential` with signature label `atproto-space-credential`, a required `tag="atproto-space-credential"`, a required audience and padded base64. The old `Atproto-Space` scheme answers 400 `InvalidToken` | Signing is `createSpaceSigHeaders` from `@atproto/space`; `packages/protocol/src/atproto/space-key.ts` only supplies the WebCrypto key |
| `getRecord`, `getLatestCommit`, `listRepoOps` and `getRepo` need `Atproto-Space-Want-Mac` (a fresh ECDH key share against the author's `#atproto_kem` key) and return `Atproto-Space-Mac`; a syncer must not trust a commit or record without a verified MAC. Commits carry no signature; `hash` is renamed `data` | `SpaceCredential.client()` asks for and verifies the MAC on every call the app makes to `getRecord` and `getLatestCommit`; it does not support `listRepoOps` or `getRepo`, which nothing in the app calls, so a future caller of either must add them to `MAC_METHODS` first (the body is read once within the size bound and replayed, and a response that fails verification is retried once against a freshly resolved DID document, since the key may have rotated; a record value is converted from JSON back to its Lexicon form before its CID is checked); `packages/protocol/src/atproto/kem-key.ts` reads the key from a DID document on the server (`identity.ts`, remembered for ten minutes and refreshed on a failed MAC) and in the browser (`browser-identity.ts`). A PLC-backed document may list the key as `Multikey` or as the older `EcdsaSecp256r1VerificationKey2019`; both are read. `write-notification.ts` reads `data` |
| `#atproto_space` and `#atproto_space_host` are gone; the space host is `#atproto_pds`, signing key `#atproto` | Nothing to change: the app resolved the PDS only |
| The authority answers a user the policy does not authorize with `SpaceNotFound`, not `UserNotAuthorized` (the user is checked before the app; `SpaceDeleted` is still answered first) | The space-existence oracle is closed for non-members. `exchangeSpaceCredential` reports every refusal, `SpaceNotFound` included, as 403 (and a deleted space as 410), so the app's own API still answers 401 or 403 for "access needed", which the UI keys on. `isAccessLost` is the one predicate for "this account lost access" and replaces six copies of a 401/403 check, so a removed member's refusal still purges cached data. A DM half whose reader was removed reads as "hasn't replied or removed your access"; the join screen says the workspace may not exist or the account may not have been added |
| `removeMember` and `putMember` with `write: false` evict the account from the writer set; new `removeWriter`; `updateSpace` does not re-evaluate it | Resolves upstream request U1. A dormant (`write: false`) allowlist entry now also drops a tracked sender, who reappears when their client re-sends (the existing re-notify backoff) |
| `getSpaceCredential` with no delegation token issues a credential only for a `publicRead` memberspace; any other space answers `SpaceNotFound` | Not used; the app always sends a delegation token |

Because a stranger now gets the same answer for an inbox that exists and one that does not, a DM sender cannot probe the inbox. A recipient instead publishes `new.flock.dm.declaration` (key `self`, existence only) in their own public repo when they enable DMs, and the sender reads it before writing a request. The browser grant `space:new.flock.dm.inbox?authority=*&action=read` is replaced by `repo:new.flock.dm.declaration?action=create&action=update`. An inbox deleted outside the app leaves a stale declaration, so a request to it reads as delivered (the app never deletes an inbox; the owner chose on 2026-10-31 not to add a startup reconcile, which would need a `repo:` delete grant and send every DM session through consent again).

Three consequences of the new behavior need your attention. The owner decided on 2026-10-31 to keep the first and the third as described, so they are accepted limits, not open items:

- **Departed authors' history (a product decision, deliberately not worked around).** `removeMember` drops the account from the writer set, and the app builds a channel's history from `listRepos`. A member who leaves a private channel, is removed from a workspace, or is dropped by a public-to-private transition or an archive (both remove members through the same call) therefore stops contributing messages for any reader that rebuilds the history from scratch (a reader whose cache is warm keeps them). The same eviction is also what stops a removed member's *new* messages from appearing: message validity does not depend on current membership, and a removed member can still write into their own repo. Showing departed members' old messages again by reading their repos from the rosters (or from a remembered writer list) would bring their new messages back too, unless it is cut off at the time of removal, which needs a removal timestamp the app does not keep, and no timestamp in the departed member's own repo (a record's `createdAt`, its TID key, its `rev`) can serve as the cutoff, because that member and their host control them. The owner chose to keep this behavior and its documentation (2026-10-31); the alternative is making it strict and consistent by dropping cached rows of repos no longer in the writer set. The same gap applies to a member who is removed and later added back (a workspace re-invite, or a channel that goes private and public again): `putMember` with `write: true` does not list a writer again, so their earlier messages stay out of a rebuilt history until they write again.
- **Sessions and inboxes from before this pin.** A restored DM browser session is checked for the required scope tokens the PDS grants as requested (`atproto`, `repo:`, `rpc:`; it rewrites `space:` tokens, resolving `authority=self` and expanding read grants, so those cannot be compared) and is reported as not connected if one is missing, such as a session granted before `repo:new.flock.dm.declaration` existed; the user then goes back through consent. An inbox created before senders needed a declaration is repaired when the DM view first loads (one public read; it publishes only if the record is missing or invalid, so changing the request mode does not become a public commit) and whenever the request mode changes. The sender validates the record itself (`validateDmDeclaration`: type, only `createdAt`, a real timestamp), not just a 2xx answer.
- **Record bodies from `listRecords` are trusted on transport, as before this pin (a security decision, not worked around).** `listRecords` carries no MAC. The app requests and verifies a MAC on every method that does (`getRecord`, `getLatestCommit`), but the message, reaction, roster and request values it lists are accepted over TLS from the host the author's DID document names, and are validated for shape and ownership, not authenticated per record. The prompt's way to authenticate a whole repo is to rebuild the set hash from every `{collection}/{rkey}/{cid}` and compare it with the MAC-verified commit's `data` (`getRepo` as a STAR archive, or `listRepoOps`), which this app does not use because it reads partial windows; the other way is one MAC-verified `getRecord` per consumed record, which costs an ECDH on both sides for each of up to 20,000 records per channel. A MAC proves the response came from the holder of the author's KEM key, which is that author's own host, so neither closes a host that forges its own users' records. The owner chose to keep the present trust (2026-10-31); the alternatives are adopting STAR sync or verifying only the displayed window with `getRecord`.

The app also reads each active allowlist entry's repo directly when it scans the inbox, because switching an allowed sender off evicts them from the writer set and switching them back on does not list them again until they write. A member found without a repo is not asked again until the allowlist or request mode changes, five minutes pass, or they appear as a writer, so a poll costs one request per member who has something to read rather than one per co-member.

A credential renewal that returns `SpaceDeleted` drops the account's copies of that space from its browser store. The app's server also handles the authority's `notifySpaceDeleted` notice (`POST /xrpc/com.atproto.space.notifySpaceDeleted`, accepted only from the space's own authority, for a space the app registered or a DM space, which the member's browser registers), which drops the operator's notices and registration for the space; the server keeps no copy of any record. A workspace found deleted at discovery is dropped, not offered as a workspace to request access to.

Every account whose repo is read with a credential needs a published `#atproto_kem` key. The reference PDS backfills one for its existing accounts at first start after upgrading; an account whose PDS cannot publish it (did:web, no rotation key) must add it to its DID document. Without one a credentialed read fails with an error that names the DID.

### What changed since `5b95b2f2` (to `619c6e85`)

The drift to `619c6e85` is four upstream commits on PR #5187 (still a draft) plus a proposal revision. The overlay applies unchanged (same SHA-256), and the lexicons under `packages/protocol/lexicons/com/atproto/space`, `packages/protocol/lexicons/com/atproto/simplespace` and `packages/protocol/lexicons/com/atproto/server/getServiceAuth.json` are byte-identical, so the generated clients are unchanged.

| Upstream change | This app |
|---|---|
| `describeServer` returns `spacesAlpha: true` (`fb2cf002`) | Not used |
| An authority writing to its own missing or deleted space gets `SpaceNotFound` (`7bad5ee2`, merged as #5655); a write into another authority's space stays unchecked and is now specified behavior | No change at the time: nothing writes before creating its space. The DM probe (asking the recipient's inbox for a credential before sending a request) was then the only way to detect a missing foreign inbox; `5d88b414` closed it, and a public declaration record replaced it (see "What changed since `619c6e85`"). The fake PDS in the unit tests mirrors the rule |
| Proposal "Repo lifecycle" (#121): the first write creates a repo, an empty repo equals a missing one, a user deletes a repo by deleting its records | No change |

### What changed since `787a730f` (to `5b95b2f2`)

Old pin `787a730f` (verified 2026-09-25); the drift to `5b95b2f2` is 22 upstream commits from 2026-09-28 to 2026-10-01. The plan and review are in `.ai/plans/protocol-drift-5b95b2f.md`.

| Upstream change | This app |
|---|---|
| `type` renamed `spaceType` on `createSpace` and the `listSpaces` filter | Used everywhere |
| `listRepos` returns `repoRev` and `spaceRev` (was `rev`); cursor is a space revision; ascending order; a repo may reappear | Used: `listBoundedRepos` keeps the latest entry per DID and counts distinct DIDs. Not used: resuming a scan from a stored `spaceRev` |
| `notifyWrite` body carries `repoRev`; forwarded copies add `spaceRev` and `prevSpaceRev`; errors `SpaceNotFound`, `FutureRev` | `repoRev` used. Not used: `prevSpaceRev` gap detection and `listRepos` recovery by `spaceRev` (follow-up) |
| HTTP message signatures replace DPoP for space requests (`signature-input`, `signature`, `atproto-space-audience`; credential scheme `Atproto-Space`; claim `cnf.kid`) | Used; the audience is the repo DID for a request naming one repo, else the space authority |
| Credential lifetime 600 s default, 3600 s ceiling (was 7200 s); `jti` on every token | Used: a credential is kept for the lifetime its own `exp` minus `iat` gives (both from the authority's clock, so a wrong local clock does not matter; ten minutes when the token cannot be read, at most the one-hour ceiling), and renewal opens a hundred seconds before expiry, or a sixth of the lifetime for a credential shorter than 600 s, so a shorter lifetime an authority chooses is honored |
| Credential revocation endpoint and `notifyCredentialRevoked` | Not used (follow-up); membership removal still relies on credential expiry |
| Space host resolved from a `#atproto_space_host` service entry, falling back to the PDS | Not used: the app resolves the PDS only |
| Strict-expiry patch no longer applied; upstream still allows 5 s skew | Patch re-based; see the overlay description above |
