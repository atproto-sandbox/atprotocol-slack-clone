# atproto Spaces Protocol Pin and Conformance

Status: pinned PDS API/policy and strict-expiry conformance pass with the checked-in verifier patch; the unmodified upstream base still fails the PRD cutoff  
Verified: 2026-10-30 (re-based from `619c6e85`, verified 2026-10-21; before that `5b95b2f2`, 2026-10-09, and `787a730f`, 2026-09-25)

## Pinned source

| Component | Pin |
|---|---|
| Proposal 0016 | `bluesky-social/proposals` `main` at `701ef9c6be5a99c2d3e87e107fe2531459d1c984` (the October 29 combined proposal; previously `c76714ac`, `119fa6b6`) |
| PDS implementation | `bluesky-social/atproto` `permissioned-data`, PR [#5187](https://github.com/bluesky-social/atproto/pull/5187), commit `5d88b414a98de1ada22c94c78fa0667a7028163c` (the "combined implementation" of the October 29 alpha; previously `619c6e85`, `5b95b2f2`, `787a730f`) |
| `@atproto/pds` | `0.5.32` |
| `@atproto/oauth-scopes` | `0.5.11` |
| `@atproto/oauth-provider` | `0.22.6` |
| `@atproto/space` | `0.0.1` |
| PDS development environment | Same pinned monorepo commit; `@atproto/dev-env` multi-PDS fixture |
| App dependencies | `@atproto/space`, `@atproto/crypto` and `@atproto/lex-data` at `0.0.0-spaces-alpha-20261029171913`, the npm snapshot built from this commit. Other `@atproto/*` copies remain at their own versions because the unchanged packages depend on them (`crypto` 0.5.5 for `identity` and `xrpc-server`, `lex-data` 0.1.7 and `lex-cbor` 0.1.6 for `lex-client`, `xrpc` and friends, `syntax` 0.7.6); the alpha copies serve `@atproto/space` and the app's own signing and MAC code. Their `^0.0.0-spaces-alpha-…` ranges also match stray `0.0.0` releases of `@atproto/lex-cbor` and `@atproto/lex-data` that still list `workspace:*` dependencies and cannot install, so `pnpm-workspace.yaml` overrides both ranges to the snapshot |
| Strict credential-expiry overlay | [`protocol-tests/atproto/strict-credential-expiry.patch`](../../protocol-tests/atproto/strict-credential-expiry.patch), SHA-256 `e9cfae5beb29d01c494087abf79eaf58fd48312956422c91ff29a405977aae3f` |

The proposal describes itself as a proposal, and PR #5187 (branch `permissioned-data`) is still marked Draft as of this verification. The unmodified `5d88b414` source still allows five seconds of expiry skew for credentials. The checked-in overlay changes `verifySpaceToken` in `packages/space/src/credential.ts` so a space credential is rejected at `exp` (zero skew) while delegation tokens and client attestations keep the five-second allowance, and it replaces the skew test in `packages/space/tests/credential.test.ts` with an at-`exp` rejection test plus a delegation-skew test. Space credentials are presented with HTTP message signatures (tagged `atproto-space-credential`), not DPoP, so the overlay does not mention DPoP proofs. It applies to the `5d88b414` sources with line offsets only. This is a local protocol fork requirement: any deployment must use this overlay or a compatible upstream revision and rerun conformance. Treat protocol drift as a release blocker.

The pinned PDS validates only lexicons in its built-in schema map; publishing third-party `new.flock.*` schemas does not make them dynamically available to record validation in this revision. App writes therefore leave the optional PDS `validate` parameter unset and run `validateSpaceRecord` locally before every write. Every reader validates author, schema, key, and cross-record references and ignores invalid records. Do not set `validate: true` on app-owned records unless the PDS revision adds dynamic third-party schema resolution.

The pinned PDS also rejects record keys matching its explicit-slur filter. A contiguous base32 digest can trigger that filter by chance, so every hash-derived record key inserts `:` between the lowercase base32 symbols. The filter does not remove colons when checking for words, and the pinned record-key syntax accepts them. This delimiter is part of the published canonical key encoding; interoperable apps must preserve it.

## Reproduce the PDS conformance run

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

## What changed since `619c6e85`

The drift to `5d88b414` is the October 22 and October 29 alpha releases (about 40 commits on PR #5187, still a draft). The upstream migration prompts are `alpha-migrations/prompt-10-22-26.md` and `prompt-10-29-26.md` in `permissioned-data`. The strict-expiry overlay applies with offsets only (same SHA-256). `getRepo` (now STAR, not CAR), account migration, `clearRecords`, `importRepo`, published policy and member records, and `personalspace`/`managedspace` are not used by this app.

| Upstream change | This app |
|---|---|
| `com.atproto.simplespace.*` is removed. `createSpace`/`updateSpace`/`getSpace`/`deleteSpace` are `com.atproto.space.*`; `putMember`/`removeMember`/`listMembers` are `com.atproto.memberspace.*` (`PolicyMismatch` on another policy). A space has one open-union `policy`; `updateSpace` replaces it wholesale; `getSpace` is owner-only and returns `{ uri, policy }` | `src/atproto/space-policy.ts` is the one owner of the policy object. Every Slack space is `com.atproto.memberspace.policy`; the DM inbox sets `publicWrite` for "everyone". `updateSpace` sends the whole policy |
| `getSpaceCredential` takes `{ space, credentialKid, delegationToken?, clientAttestation? }` in its body, with no authorization header or signature; a bad token is `InvalidDelegationToken` | `exchangeSpaceCredential` in `src/atproto/space-credential-core.ts` |
| Credentials are presented as `Atproto-Space-Credential` with signature label `atproto-space-credential`, a required `tag="atproto-space-credential"`, a required audience and padded base64. The old `Atproto-Space` scheme answers 400 `InvalidToken` | Signing is `createSpaceSigHeaders` from `@atproto/space`; `src/atproto/space-key.ts` only supplies the WebCrypto key |
| `getRecord`, `getLatestCommit`, `listRepoOps` and `getRepo` need `Atproto-Space-Want-Mac` (a fresh ECDH key share against the author's `#atproto_kem` key) and return `Atproto-Space-Mac`; a syncer must not trust a commit or record without a verified MAC. Commits carry no signature; `hash` is renamed `data` | `SpaceCredential.client()` asks for and verifies the MAC on every call the app makes to `getRecord` and `getLatestCommit`; it does not support `listRepoOps` or `getRepo`, which nothing in the app calls, so a future caller of either must add them to `MAC_METHODS` first (the body is read once within the size bound and replayed, and a response that fails verification is retried once against a freshly resolved DID document, since the key may have rotated; a record value is converted from JSON back to its Lexicon form before its CID is checked); `src/atproto/kem-key.ts` reads the key from a DID document on the server (`identity.ts`, remembered for ten minutes and refreshed on a failed MAC) and in the browser (`browser-identity.ts`). A PLC-backed document may list the key as `Multikey` or as the older `EcdsaSecp256r1VerificationKey2019`; both are read. `write-notification.ts` reads `data` |
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

A credential renewal that returns `SpaceDeleted` drops the account's cached copies of that space; the app also handles the authority's `notifySpaceDeleted` notice (`POST /xrpc/com.atproto.space.notifySpaceDeleted`, accepted only from the space's own authority, for a space the app registered or a DM space, which the member's browser registers), which drops every account's copy at once, so a deletion is no longer learned only by an account that comes back. A copy no account has read for `CACHE_RETENTION_DAYS` is swept (see `docs/operations.md`). A workspace found deleted at discovery is dropped, not offered as a workspace to request access to.

Every account whose repo is read with a credential needs a published `#atproto_kem` key. The reference PDS backfills one for its existing accounts at first start after upgrading; an account whose PDS cannot publish it (did:web, no rotation key) must add it to its DID document. Without one a credentialed read fails with an error that names the DID.

## What changed since `5b95b2f2` (to `619c6e85`)

The drift to `619c6e85` is four upstream commits on PR #5187 (still a draft) plus a proposal revision. The overlay applies unchanged (same SHA-256), and the lexicons under `lexicons/com/atproto/space`, `lexicons/com/atproto/simplespace` and `lexicons/com/atproto/server/getServiceAuth.json` are byte-identical, so the generated clients are unchanged.

| Upstream change | This app |
|---|---|
| `describeServer` returns `spacesAlpha: true` (`fb2cf002`) | Not used |
| An authority writing to its own missing or deleted space gets `SpaceNotFound` (`7bad5ee2`, merged as #5655); a write into another authority's space stays unchecked and is now specified behavior | No change at the time: nothing writes before creating its space. The DM probe (asking the recipient's inbox for a credential before sending a request) was then the only way to detect a missing foreign inbox; `5d88b414` closed it, and a public declaration record replaced it (see "What changed since `619c6e85`"). The fake PDS in the unit tests mirrors the rule |
| Proposal "Repo lifecycle" (#121): the first write creates a repo, an empty repo equals a missing one, a user deletes a repo by deleting its records | No change |

## What changed since `787a730f`

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

## API and authorization mapping

| Product operation | Pinned API and observed behavior |
|---|---|
| Create/update a space | `com.atproto.space.createSpace`, `updateSpace`; URI is anchored to the authenticated authority DID. Every Slack space is `com.atproto.memberspace.policy`; `publicRead` and `publicWrite` are independent flags, both false by default, and the DM inbox sets `publicWrite` for "everyone". `updateSpace` replaces the whole policy and `getSpace` is owner-only. `createSpace` requires `manage=create`; updates require `manage=update`. |
| Set/remove membership | `com.atproto.memberspace.putMember` replaces both `read` and `write`; `removeMember` deletes the member. `removeMember` and `putMember` with `write: false` also evict the account from the writer set. Both require the space authority DID and `manage=update`, and are refused with `PolicyMismatch` on a space under another policy. |
| Read membership state | `com.atproto.memberspace.listMembers` requires the owner session with `action=read_self`. A space credential and non-owner member cannot call it. The authority is implicitly admitted for reads and credentials but is not listed as a member. |
| Discover spaces | `com.atproto.space.listSpaces` discovers spaces present in the caller's own repo. The invitee's `new.flock.acceptance` record supplies that index entry; it is not a membership check. |
| Mint a read credential | The account PDS issues `com.atproto.space.getDelegationToken`; the space authority exchanges it through `com.atproto.space.getSpaceCredential`, with the token and the P-256 `did:key` to bind (`credentialKid`) in the request body and no authorization header. The member list (or `publicRead`) controls issuance; a user the policy does not authorize, and a missing space, both get `SpaceNotFound`, and a deleted space gets `SpaceDeleted` first. Credentials carry `cnf.kid` and a `jti`, are presented as `Atproto-Space-Credential` with a tagged HTTP message signature (no DPoP), and are valid for 600 seconds by default with a 3,600 second ceiling. |
| Read records | `listRecords` and `listRepos` need only a credential. `getRecord`, `getLatestCommit` and `listRepoOps` also need `Atproto-Space-Want-Mac` and return `Atproto-Space-Mac`; the client verifies it for the two the app calls, `getRecord` and `getLatestCommit`. |
| Write records | `com.atproto.space.createRecord`, `putRecord`, and `deleteRecord` address the author's own repo. OAuth scope checks distinguish create from update and match the target collection. Writes and read credentials are separate protocol permissions. |
| Synchronize writers | `com.atproto.space.notifyWrite` (body `repoRev`, `data`) updates the authority's writer set; `com.atproto.space.listRepos` enumerates that set, not readers or all members, returning `repoRev` and `spaceRev` per repo in ascending `spaceRev` order. A repo updated while paginating reappears at a later `spaceRev`; `cursor` means "updated after this space revision". App-level notifications can be missed while `listRepos` still recovers the writer. If the writer's PDS-to-authority notification itself is dropped, the writer is absent from `listRepos`; owner-only `listMembers` enumerates inbox `write=true` candidates, and an admin's valid inbox credential can read a candidate repo directly. |

## Slack split-policy conformance

The retained multi-PDS inbox test creates an `new.flock.inbox` with a memberspace policy (member-list read and write). The requester and ordinary member are `read=false, write=true`; the admin is `read=true, write=true`. The requester writes a request to their own PDS. The requester's repo appears in `listRepos` when `notifyWrite` arrives, and an admin credential reads the record. The requester can read their own repo but cannot mint an inbox credential (the refusal is `SpaceNotFound`, which no longer confirms the inbox exists) or read another writer's repo. The authority owner has implicit access. An authority-authored `new.flock.admin` record does not let that human DID mutate the PDS member list.

The conformance test also drops the requester's PDS-to-authority DID notification. `listRepos` then omits the requester, while authority `listMembers` still reports `write=true`; the admin credential can directly read that repo. This proves the recovery API must query owner-authorized membership candidates instead of claiming that a writer-set-only sweep recovers every dropped notification.

Membership removal prevents a fresh space credential. A default credential claims `exp - iat = 600`; the ceiling is 3600. The unmodified pinned verifier uses `CLOCK_SKEW_SEC = 5` and accepts a credential after its `exp`. The checked-in overlay applies zero expiry skew only to space credentials; delegation tokens and client attestations retain their five-second clock allowance. Unit tests prove the credential is rejected at `exp` and delegation skew remains accepted; the two-PDS conformance test proves a short-lived credential is rejected at `exp + 2s` on both hosts. Neither expiry nor removal can erase copies already downloaded.

## Direct-message conformance (DM plan M0)

Verified 2026-10-30 on the pinned commit plus overlay, Node 22.17.0 (first verified 2026-09-26). `slack-dm-conformance.test.ts` has 5 tests, the inbox suite 3 and the authority OAuth suite 1; all 9 pass. Run with the other upstream space suites the result is 11 suites, 272 passed and 1 upstream `todo`; `@atproto/space` passes 179. The pnpm 11 build of the pinned checkout needs `npm_config_enable_pre_post_scripts=true` (otherwise package `prebuild` codegen is skipped) and `PUPPETEER_SKIP_DOWNLOAD=1`. `oauth-provider-ui`'s lingui codegen needs Node ≥ 24.2 (`import.meta.main`); on Node 22 it exits silently without generating locale files.

| Check | Observed on the pinned PDS | Consequence for the DM design |
|---|---|---|
| Symmetric halves across hosts | Each participant's `memberList` half is readable by the others with a credential minted at the owner's host. `listRepos` shows only the owner | Confirmed |
| Read-only member writes into a foreign half | `createRecord` **succeeds** (stored in the writer's own repo), but the authority never tracks it | Readers must reject half records whose repo is not the space owner |
| Existence oracle | Non-member credential request: `SpaceNotFound` for an existing space and for a missing one (identical status and message), `SpaceDeleted` after deletion, even for a user the policy never admitted | **Closed for non-members** (it was open on `619c6e85` and before). A deleted space is still distinguishable. A conversation key is a TID (its creation time plus 10 random bits), so it gives little protection against someone who knows roughly when the conversation began (a one-second window is about a million candidates); the DM change stream behind it carries a change counter only, which shows timing and, because the counter is shared, app-wide notice volume. A DM sender can no longer probe an inbox, so a recipient publishes `new.flock.dm.declaration` in their own repo and the sender reads it |
| Public-write inbox | A non-member on another host writes a request; the owner's `listRepos` lists them and the owner reads the record; the writer cannot get a read credential | Confirmed |
| Policy switch `publicWrite` → member list (`updateSpace`) | New non-listed writers are not tracked. Writers tracked earlier **stay listed**: `updateSpace` does not re-evaluate the writer set | Clients must filter requests by the current mode/allowlist |
| Removing an allowlisted writer | The writer is dropped from `listRepos` immediately (`removeMember`, and `putMember` with `write: false`, evict). Their later puts succeed on their own PDS but are not tracked again while unauthorized, and the owner can still read their records | Fixes the earlier gap (upstream request U1). A switch of the policy alone still leaves tracked writers listed, so the client keeps its filter |
| Switch back to `publicWrite` | A previously ignored or evicted writer is tracked after their next write | Confirmed |
| OAuth scopes (public client, `token_endpoint_auth_method: none`) | `space:new.flock.dm.inbox?authority=*&collection=new.flock.dm.request&action=create` allows request writes into another user's inbox and rejects other collections. `manage=create/update` on own conversation type allows `createSpace`/`putMember`. `authority=*&action=read` allows delegation tokens. A plain `atproto` token does none of these | Confirmed |
| Space credential key | A fresh non-extractable WebCrypto P-256 key per credential (`generateSpaceKey`) is named in the request body as the credential's `cnf.kid` (a `did:key`) and signs the HTTP message signatures on every read made with that credential. The exchange itself is an unsigned body-only POST. OAuth access-token DPoP proofs use the key `oauth-client-browser` keeps for itself, not this one | Confirmed |
| `removeMember` | Blocks new credentials for the revoker's half only; an already-minted credential keeps working until it expires (600 s by default) | Confirmed |
| 100 participants (measured on `787a730f`; `pnpm test:performance` reruns it) | 100 halves × 99 members: setup 27.5 s (100 `createSpace`, 9,900 `putMember`, 100 writes). One reader minted 100 credentials and read 100 halves in 1.2 s at concurrency 8. `listMembers` returns 99 | Confirmed on the fixture (rate limits disabled; not a production result) |

## OAuth scope proof

The custom authority test uses a real PDS OAuth `TokenManager` to sign a DPoP-bound OAuth access token (OAuth keeps DPoP; only space requests moved to HTTP message signatures). The token calls the real `putMember` and authority record-write handlers successfully with `manage=update` plus the exact `new.flock.admin` collection actions. A correctly signed authority token with only `action=read` is denied the membership mutation. The same scoped session calls the real `com.atproto.server.getServiceAuth` endpoint with an RPC scope and receives a service JWT whose `iss`, service-reference `aud`, and `lxm` match the operator contract.

This test uses a synthetic granted OAuth scope to reach the PDS verifier and handlers. It does not automate the browser authorization/consent interaction; production consent must still present the narrow scopes listed below.

## Authority operator scopes

The operator's workspace-DID OAuth session is limited to these scopes. In each template, `authority=self` resolves to the workspace DID and `skey=*` covers only spaces under that authority:

```text
space:new.flock.workspace?authority=self&skey=*&action=read_self
space:new.flock.workspace?authority=self&skey=*&action=read
space:new.flock.workspace?authority=self&skey=*&action=read_self&manage=create&manage=update
space:new.flock.workspace?authority=self&skey=*&collection=new.flock.admin&collection=new.flock.directory&collection=new.flock.workspace.roster&action=create&action=update&action=delete

space:new.flock.inbox?authority=self&skey=*&action=read_self
space:new.flock.inbox?authority=self&skey=*&action=read
space:new.flock.inbox?authority=self&skey=*&action=read_self&manage=create&manage=update
space:new.flock.inbox?authority=self&skey=*&collection=new.flock.joinDecision&action=create&action=update&action=delete

space:new.flock.channel?authority=self&skey=*&action=read_self
space:new.flock.channel?authority=self&skey=*&action=read
space:new.flock.channel?authority=self&skey=*&action=read_self&manage=create&manage=update
space:new.flock.channel?authority=self&skey=*&collection=new.flock.channel.roster&action=create&action=update&action=delete
```

The operator has no message, reaction, or join-request write scope. Human admin clients request three exact RPC grants, replacing `OPERATOR_DID` with the DID that publishes `#atproto_flock_operator`:

```text
rpc:new.flock.operator.execute?aud=OPERATOR_DID%23atproto_flock_operator
rpc:new.flock.operator.getOperation?aud=OPERATOR_DID%23atproto_flock_operator
rpc:new.flock.operator.listInboxWriters?aud=OPERATOR_DID%23atproto_flock_operator
```

For each request, the client calls `com.atproto.server.getServiceAuth` with `aud=OPERATOR_DID#atproto_flock_operator` and `lxm` equal to that request's method NSID. The operator verifies the service JWT and takes the actor DID only from its verified `iss`. It rechecks the authority-authored admin record, workspace roster, and inbox `read=true` membership on every method. `listInboxWriters` returns only inbox member DIDs with `write=true`; the admin app fetches request data itself with its PDS-issued inbox credential.

## Stable key encoding

For each hashed rkey, calculate SHA-256 over UTF-8 bytes and encode the 32-byte digest with RFC 4648 base32 using lowercase alphabet `abcdefghijklmnopqrstuvwxyz234567` and no padding. Insert `:` between every adjacent base32 symbol before adding the key prefix. Prefix the delimited string with:

| Key | Input |
|---|---|
| `d-` subject/roster | Canonical DID string |
| `r-` request | Canonical channel URI, NUL byte, requester DID |
| `a-` acceptance | Canonical workspace URI |
| `x-` reaction | Canonical message URI, NUL byte, emoji, NUL byte, author DID |
| `q-` decision | Canonical request URI |

Each string is already required to be valid UTF-8 and contain no NUL. URI values are parsed and serialized to the canonical atproto URI form before hashing. The workspace directory uses the literal channel `skey`; a request generation remains a fresh TID in the record value. The full canonical rule is also in the [PRD](../prd/atproto-slack-clone.md#lexicons-and-current-record-rules).
