# atproto Spaces Protocol Pin and Conformance

Status: pinned PDS API/policy and strict-expiry conformance pass with the checked-in verifier patch; the unmodified upstream base still fails the PRD cutoff  
Verified: 2026-10-21 (re-based from `5b95b2f2`, verified 2026-10-09; before that `787a730f`, verified 2026-09-25)

## Pinned source

| Component | Pin |
|---|---|
| Proposal 0016 | `bluesky-social/proposals` `main` at `c76714ac3bc30318496d5d7f29d9341d4d8c0c69` (previously `119fa6b6`) |
| PDS implementation | `bluesky-social/atproto` `permissioned-data`, PR [#5187](https://github.com/bluesky-social/atproto/pull/5187), commit `619c6e8556db7dd37bb7df1d92a5eae83da8d8b0` (previously `5b95b2f2`, `787a730f`) |
| `@atproto/pds` | `0.5.32` |
| `@atproto/oauth-scopes` | `0.5.11` |
| `@atproto/oauth-provider` | `0.22.6` |
| `@atproto/space` | `0.0.1` |
| PDS development environment | Same pinned monorepo commit; `@atproto/dev-env` multi-PDS fixture |
| Strict credential-expiry overlay | [`protocol-tests/atproto/strict-credential-expiry.patch`](../../protocol-tests/atproto/strict-credential-expiry.patch), SHA-256 `e9cfae5beb29d01c494087abf79eaf58fd48312956422c91ff29a405977aae3f` |

The proposal describes itself as a proposal, and PR #5187 (branch `permissioned-data`) is still marked Draft as of this verification. The unmodified `619c6e85` source still allows five seconds of expiry skew for credentials. The checked-in overlay changes `verifySpaceToken` in `packages/space/src/credential.ts` so a space credential is rejected at `exp` (zero skew) while delegation tokens and client attestations keep the five-second allowance, and it replaces the skew test in `packages/space/tests/credential.test.ts` with an at-`exp` rejection test plus a delegation-skew test. Space requests are signed with HTTP message signatures, not DPoP, so the overlay no longer mentions DPoP proofs. This is a local protocol fork requirement: any deployment must use this overlay or a compatible upstream revision and rerun conformance. Treat protocol drift as a release blocker.

The pinned PDS validates only lexicons in its built-in schema map; publishing third-party `org.slack.*` schemas does not make them dynamically available to record validation in this revision. App writes therefore leave the optional PDS `validate` parameter unset and run `validateSpaceRecord` locally before every write. Every reader validates author, schema, key, and cross-record references and ignores invalid records. Do not set `validate: true` on app-owned records unless the PDS revision adds dynamic third-party schema resolution.

The pinned PDS also rejects record keys matching its explicit-slur filter. A contiguous base32 digest can trigger that filter by chance, so every hash-derived record key inserts `:` between the lowercase base32 symbols. The filter does not remove colons when checking for words, and the pinned record-key syntax accepts them. This delimiter is part of the published canonical key encoding; interoperable apps must preserve it.

## Reproduce the PDS conformance run

Use Node 24 as selected by the pinned checkout's `.nvmrc` (the local proof also ran on Node 22.17.0) and pnpm 11.11.0. In a disposable clone (the app's checkout name for it is `atproto-spaces-phase2`):

```sh
git clone --filter=blob:none --no-checkout https://github.com/bluesky-social/atproto.git atproto-spaces-phase2
git -C atproto-spaces-phase2 fetch --depth=1 origin 619c6e8556db7dd37bb7df1d92a5eae83da8d8b0
git -C atproto-spaces-phase2 checkout --detach 619c6e8556db7dd37bb7df1d92a5eae83da8d8b0
cd atproto-spaces-phase2
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
  tests/space/simplespace.test.ts \
  tests/space/auth.test.ts \
  tests/space/sync.test.ts \
  tests/space-scope.test.ts \
  tests/space/slack-inbox-conformance.test.ts \
  tests/space/slack-authority-oauth-conformance.test.ts \
  tests/space/slack-dm-conformance.test.ts
```

Build notes (recorded on `5b95b2f2`): the install needs `PUPPETEER_SKIP_DOWNLOAD=1` (shown above) and `npm_config_enable_pre_post_scripts=true` for the `build:tooling` and package builds; `oauth-provider-ui` needs its Lingui catalogs compiled once with `pnpm --filter @atproto/oauth-provider-ui i18n:compile` under Node 26 (the codegen uses `import.meta.main`) before the Node 22 build.

The verification recorded on `787a730f` passed 101 `@atproto/space` tests and six PDS suites with 108 tests passing and one upstream `todo`; the figures for `619c6e85` are in `PROGRESS.md`. It exercised independent accounts on up to three in-memory PDS hosts; the custom expiry test rejects at `exp + 2s` on both PDS hosts. The custom tests and exact source patch are retained in this checkout; see [protocol test instructions](../../protocol-tests/atproto/README.md).

## What changed since `5b95b2f2`

The drift to `619c6e85` is four upstream commits on PR #5187 (still a draft) plus a proposal revision. The overlay applies unchanged (same SHA-256), and the lexicons under `lexicons/com/atproto/space`, `lexicons/com/atproto/simplespace` and `lexicons/com/atproto/server/getServiceAuth.json` are byte-identical, so the generated clients are unchanged.

| Upstream change | This app |
|---|---|
| `describeServer` returns `spacesAlpha: true` (`fb2cf002`) | Not used |
| An authority writing to its own missing or deleted space gets `SpaceNotFound` (`7bad5ee2`, merged as #5655); a write into another authority's space stays unchecked and is now specified behavior | No change: nothing writes before creating its space. The DM probe (asking the recipient's inbox for a credential before sending a request) is still the only way to detect a missing foreign inbox. The fake PDS in the unit tests mirrors the rule |
| Proposal "Repo lifecycle" (#121): the first write creates a repo, an empty repo equals a missing one, a user deletes a repo by deleting its records | No change |

## What changed since `787a730f`

Old pin `787a730f` (verified 2026-09-25); the drift to `5b95b2f2` is 22 upstream commits from 2026-09-28 to 2026-10-01. The plan and review are in `.ai/plans/protocol-drift-5b95b2f.md`.

| Upstream change | This app |
|---|---|
| `type` renamed `spaceType` on `createSpace` and the `listSpaces` filter | Used everywhere |
| `listRepos` returns `repoRev` and `spaceRev` (was `rev`); cursor is a space revision; ascending order; a repo may reappear | Used: `listBoundedRepos` keeps the latest entry per DID and counts distinct DIDs. Not used: resuming a scan from a stored `spaceRev` |
| `notifyWrite` body carries `repoRev`; forwarded copies add `spaceRev` and `prevSpaceRev`; errors `SpaceNotFound`, `FutureRev` | `repoRev` used. Not used: `prevSpaceRev` gap detection and `listRepos` recovery by `spaceRev` (follow-up) |
| HTTP message signatures replace DPoP for space requests (`signature-input`, `signature`, `atproto-space-audience`; credential scheme `Atproto-Space`; claim `cnf.kid`) | Used; the audience is the repo DID for a request naming one repo, else the space authority |
| Credential lifetime 600 s default, 3600 s ceiling (was 7200 s); `jti` on every token | Used: renewal opens at one sixth of the lifetime before expiry |
| Credential revocation endpoint and `notifyCredentialRevoked` | Not used (follow-up); membership removal still relies on credential expiry |
| Space host resolved from a `#atproto_space_host` service entry, falling back to the PDS | Not used: the app resolves the PDS only |
| Strict-expiry patch no longer applied; upstream still allows 5 s skew | Patch re-based; see the overlay description above |

## API and authorization mapping

| Product operation | Pinned API and observed behavior |
|---|---|
| Create/update a space | `com.atproto.simplespace.createSpace`, `updateSpace`; URI is anchored to the authenticated authority DID. Read and write member-list policies are independent. `createSpace` requires `manage=create`; updates require `manage=update`. |
| Set/remove membership | `com.atproto.simplespace.putMember` replaces both `read` and `write`; `removeMember` deletes the member. Both require the space authority DID and `manage=update`. |
| Read membership state | `com.atproto.simplespace.listMembers` requires the owner session with `action=read_self`. A space credential and non-owner member cannot call it. The authority is implicitly admitted for reads and credentials but is not listed as a member. |
| Discover spaces | `com.atproto.space.listSpaces` discovers spaces present in the caller's own repo. The invitee's `org.slack.acceptance` record supplies that index entry; it is not a membership check. |
| Mint a read credential | The account PDS issues `com.atproto.space.getDelegationToken`; the space authority exchanges it through `com.atproto.space.getSpaceCredential`. `readPolicy` controls issuance. Space credentials are bound to a P-256 `did:key` by an HTTP message signature (no DPoP), carry `cnf.kid` and a `jti`, and are valid for 600 seconds by default with a 3,600 second ceiling. |
| Write records | `com.atproto.space.createRecord`, `putRecord`, and `deleteRecord` address the author's own repo. OAuth scope checks distinguish create from update and match the target collection. Writes and read credentials are separate protocol permissions. |
| Synchronize writers | `com.atproto.space.notifyWrite` (body `repoRev`, `hash`) updates the authority's writer set; `com.atproto.space.listRepos` enumerates that set, not readers or all members, returning `repoRev` and `spaceRev` per repo in ascending `spaceRev` order. A repo updated while paginating reappears at a later `spaceRev`; `cursor` means "updated after this space revision". App-level notifications can be missed while `listRepos` still recovers the writer. If the writer's PDS-to-authority notification itself is dropped, the writer is absent from `listRepos`; owner-only `listMembers` enumerates inbox `write=true` candidates, and an admin's valid inbox credential can read a candidate repo directly. |

## Slack split-policy conformance

The retained multi-PDS inbox test creates an `org.slack.inbox` with member-list read and write policies. The requester and ordinary member are `read=false, write=true`; the admin is `read=true, write=true`. The requester writes a request to their own PDS. The requester's repo appears in `listRepos` when `notifyWrite` arrives, and an admin credential reads the record. The requester can read their own repo but cannot mint an inbox credential or read another writer's repo. The authority owner has implicit access. An authority-authored `org.slack.admin` record does not let that human DID mutate the PDS member list.

The conformance test also drops the requester's PDS-to-authority DID notification. `listRepos` then omits the requester, while authority `listMembers` still reports `write=true`; the admin credential can directly read that repo. This proves the recovery API must query owner-authorized membership candidates instead of claiming that a writer-set-only sweep recovers every dropped notification.

Membership removal prevents a fresh space credential. A default credential claims `exp - iat = 600`; the ceiling is 3600. The unmodified pinned verifier uses `CLOCK_SKEW_SEC = 5` and accepts a credential after its `exp`. The checked-in overlay applies zero expiry skew only to space credentials; delegation tokens and client attestations retain their five-second clock allowance. Unit tests prove the credential is rejected at `exp` and delegation skew remains accepted; the two-PDS conformance test proves a short-lived credential is rejected at `exp + 2s` on both hosts. Neither expiry nor removal can erase copies already downloaded.

## Direct-message conformance (DM plan M0)

Verified 2026-09-26 on the pinned commit plus overlay, Node 22.17.0. `slack-dm-conformance.test.ts` has 4 tests and all pass. Together with the two existing Slack suites, the result is 8/8 tests across 3 suites. The pnpm 11 build of the pinned checkout needs `npm_config_enable_pre_post_scripts=true` (otherwise package `prebuild` codegen is skipped) and `PUPPETEER_SKIP_DOWNLOAD=1`. `oauth-provider-ui`'s lingui codegen needs Node ≥ 24.2 (`import.meta.main`); on Node 22 it exits silently without generating locale files.

| Check | Observed on the pinned PDS | Consequence for the DM design |
|---|---|---|
| Symmetric halves across hosts | Each participant's `memberList` half is readable by the others with a credential minted at the owner's host. `listRepos` shows only the owner | Confirmed |
| Read-only member writes into a foreign half | `createRecord` **succeeds** (stored in the writer's own repo), but the authority never tracks it | Readers must reject half records whose repo is not the space owner |
| Existence oracle | Non-member credential request: `UserNotAuthorized` for an existing space, `SpaceNotFound` for a missing one, `SpaceDeleted` after deletion | **Space existence is probeable.** Conversation keys must be unguessable random TIDs; the `self` inbox's existence is public by design |
| Public-write inbox | A non-member on another host writes a request; the owner's `listRepos` lists them and the owner reads the record; the writer cannot get a read credential | Confirmed |
| Policy switch `public` → `memberList` (`updateSpace`) | New non-listed writers are not tracked. Writers tracked earlier **stay listed** | Clients must filter requests by the current mode/allowlist |
| Removing an allowlisted writer | The writer's later puts succeed on their PDS; they stay in `listRepos`, and the owner can still read their records | Same: allowlist enforcement for tracked writers is client-side |
| Switch back to `public` | A previously ignored writer is tracked after their next write | Confirmed |
| OAuth scopes (public client, `token_endpoint_auth_method: none`) | `space:org.slack.dm.inbox?authority=*&collection=org.slack.dm.request&action=create` allows request writes into another user's inbox and rejects other collections. `manage=create/update` on own conversation type allows `createSpace`/`putMember`. `authority=*&action=read` allows delegation tokens. A plain `atproto` token does none of these | Confirmed |
| Browser signing key | A non-extractable WebCrypto P-256 key signs OAuth access-token proofs (DPoP, unchanged for OAuth) and, as a `did:key`, the HTTP message signatures on the credential exchange at another host and on credential-bound reads | Confirmed |
| `removeMember` | Blocks new credentials for the revoker's half only | Confirmed |
| 100 participants | 100 halves × 99 members: setup 27.5 s (100 `createSpace`, 9,900 `putMember`, 100 writes). One reader minted 100 credentials and read 100 halves in 1.2 s at concurrency 8. `listMembers` returns 99 | Confirmed on the fixture (rate limits disabled; not a production result) |

## OAuth scope proof

The custom authority test uses a real PDS OAuth `TokenManager` to sign a DPoP-bound OAuth access token (OAuth keeps DPoP; only space requests moved to HTTP message signatures). The token calls the real `putMember` and authority record-write handlers successfully with `manage=update` plus the exact `org.slack.admin` collection actions. A correctly signed authority token with only `action=read` is denied the membership mutation. The same scoped session calls the real `com.atproto.server.getServiceAuth` endpoint with an RPC scope and receives a service JWT whose `iss`, service-reference `aud`, and `lxm` match the operator contract.

This test uses a synthetic granted OAuth scope to reach the PDS verifier and handlers. It does not automate the browser authorization/consent interaction; production consent must still present the narrow scopes listed below.

## Authority operator scopes

The operator's workspace-DID OAuth session is limited to these scopes. In each template, `authority=self` resolves to the workspace DID and `skey=*` covers only spaces under that authority:

```text
space:org.slack.workspace?authority=self&skey=*&action=read_self
space:org.slack.workspace?authority=self&skey=*&action=read
space:org.slack.workspace?authority=self&skey=*&action=read_self&manage=create&manage=update
space:org.slack.workspace?authority=self&skey=*&collection=org.slack.admin&collection=org.slack.directory&collection=org.slack.workspace.roster&action=create&action=update&action=delete

space:org.slack.inbox?authority=self&skey=*&action=read_self
space:org.slack.inbox?authority=self&skey=*&action=read
space:org.slack.inbox?authority=self&skey=*&action=read_self&manage=create&manage=update
space:org.slack.inbox?authority=self&skey=*&collection=org.slack.joinDecision&action=create&action=update&action=delete

space:org.slack.channel?authority=self&skey=*&action=read_self
space:org.slack.channel?authority=self&skey=*&action=read
space:org.slack.channel?authority=self&skey=*&action=read_self&manage=create&manage=update
space:org.slack.channel?authority=self&skey=*&collection=org.slack.channel.roster&action=create&action=update&action=delete
```

The operator has no message, reaction, or join-request write scope. Human admin clients request three exact RPC grants, replacing `OPERATOR_DID` with the DID that publishes `#atproto_slack_admin`:

```text
rpc:org.slack.operator.execute?aud=OPERATOR_DID%23atproto_slack_admin
rpc:org.slack.operator.getOperation?aud=OPERATOR_DID%23atproto_slack_admin
rpc:org.slack.operator.listInboxWriters?aud=OPERATOR_DID%23atproto_slack_admin
```

For each request, the client calls `com.atproto.server.getServiceAuth` with `aud=OPERATOR_DID#atproto_slack_admin` and `lxm` equal to that request's method NSID. The operator verifies the service JWT and takes the actor DID only from its verified `iss`. It rechecks the authority-authored admin record, workspace roster, and inbox `read=true` membership on every method. `listInboxWriters` returns only inbox member DIDs with `write=true`; the admin app fetches request data itself with its PDS-issued inbox credential.

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
