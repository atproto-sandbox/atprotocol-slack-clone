# atproto Spaces & `opensocial.group` Protocol Pins and Conformance

Status: **R14 pinned & aligned — `@atproto` Spaces `f839c47e6523a1a7adb367ef70513a3c6688c38b` (`0.0.0-spaces-alpha-20261124235736` + `@atproto/star@0.0.1` + `@atproto/lex-{cbor,data}@0.1.11` + `strict-credential-expiry.patch`) and `opensocial.group/proposal` `8df0cc82eb7708f090aa43522adf1d3ada3ed7e7`**  
Verified: 2026-11-24 (R14 `at:space/` URI migration & `f839c47e` re-pin; prior pins `6747610566`, `5d88b414`, `619c6e85`, `5b95b2f2`, `787a730f`)

## Pinned upstream sources

| Component | Pin & Verification Gate |
|---|---|
| **`@atproto` Spaces PR / Commit** | `bluesky-social/atproto` `permissioned-data`, PR [#5187](https://github.com/bluesky-social/atproto/pull/5187), commit `f839c47e6523a1a7adb367ef70513a3c6688c38b` (`../atproto-spaces-r14`) |
| **Strict credential-expiry overlay** | [`protocol-tests/atproto/strict-credential-expiry.patch`](../../protocol-tests/atproto/strict-credential-expiry.patch), SHA-256 `a92f94fd95fd44f445b8de7f0c4f158352f8f578ce020942d10dee3e781f3cf7` (`packages/space/src/credential.ts` + `packages/space/src/credential.test.ts`). Note: `apps/group-host` (`verifyGroupSpaceCredential`) and `apps/operator` (`security.ts`) also enforce explicit zero-skew `Math.floor(Date.now() / 1000) >= payload.exp` in TypeScript because npm `@atproto/space` in `node_modules` is unpatched |
| **Cryptographic checkout preflight** | [`scripts/verify-pinned-checkout.mjs`](../../scripts/verify-pinned-checkout.mjs) (tested in `packages/protocol/src/pin-digest.test.ts`), invoked **unconditionally** by `scripts/codegen-lex.mjs` and `protocol-tests/support/pds-network.ts`: verifies `HEAD === f839c47e6523a1a7adb367ef70513a3c6688c38b`, base Git object SHA-256s, exact `git status --porcelain` & `git diff` SHA-256 (`a92f94fd...`), `pnpm-lock.yaml` & compiled entrypoint SHA-256s, and a reproducible `19,251`-file `packages/**/dist/**` manifest (`18275cb74339aaefc232cc085d9b201fd5a04f6e4481e64ec714261473592439`) |
| **`opensocial.group` specification** | [`https://tangled.org/opensocial.group/proposal`](https://tangled.org/opensocial.group/proposal) @ commit `8df0cc82eb7708f090aa43522adf1d3ada3ed7e7` (2026-11-19, *"Align with latest protocol spec. Split member access from scopes in grants"*). All `27` `group.opensocial.*` JSON lexicons + all `72` `com.atproto.*` JSON lexicons (`99` upstream files total, alongside `36` `new.flock.*` files = `135` total lexicons) are SHA-256-locked and validated in [`packages/protocol/src/opensocial-lexicons.test.ts`](../../packages/protocol/src/opensocial-lexicons.test.ts) |
| **App `@atproto/*` alpha packages** | `@atproto/{space,crypto,lexicon,xrpc,xrpc-server,repo,car,oauth-scopes,did,common,syntax}@0.0.0-spaces-alpha-20261124235736` (snapshot from `1f510f8e36`), plus graduated `@atproto/star@0.0.1` and `@atproto/lex-{cbor,data}@0.1.11`, listed in `pnpm-workspace.yaml` `minimumReleaseAgeExclude` (exact internal alpha deps eliminate `overrides` and upstream `SpaceCollectionParam` eliminates the former `@atproto/oauth-scopes` patch) |

### Production deployment prerequisites

1. **Public HTTPS origins (`L7`):** Upstream `authorizeSpaceSync` and `SpaceNotifications` deliver `confirmRegistration` and `notifySpaceUpdate` via `ctx.safeClient(endpoint)` (SSRF protection active outside `devMode: true, disableSsrfProtection: true`). Production `APP_URL`, `OPERATOR_URL`, and `GROUP_HOST_URL` must be publicly routable HTTPS origins.
2. **Mandatory public Lexicon DNS + XRPC publication (`pnpm verify:lexicons`):** On pinned personal PDSes, `OAuthProvider.authorize()` calls `lexiconManager.getSpacesFromScope()`, resolving **every non-wildcard `space:<spaceType>` NSID** (`group.opensocial.{meta,members,invites}` and `new.flock.*`) via `_lexicon.<authority>` DNS TXT → `com.atproto.lexicon.schema`. Run `corepack pnpm verify:lexicons` (`scripts/verify-public-lexicons.mjs`) as a mandatory fail-closed gate before serving public ATProto PDSes (`docs/operations.md`).

---

## Reproducing the pinned `@atproto` checkout (`../atproto-spaces-r14`)

Upstream `f839c47e` uses `pnpm@12.16.1` and declares `devEngines.runtime` `^22.23.4 || ^24.22.1 || ^26.12.1`. On hosts with Node `22.17.0` + `/opt/homebrew/bin/node` (`>= 24.2`), run `oauth-provider-ui` `prebuild` once under Node `>= 24.2` (for Lingui `import.meta.main`), then build native addons (`better-sqlite3`, `@swc/core`, `sharp`) and `@atproto/{dev-env,space,star,lex-cli}` under Node `22.x`:

```sh
git clone --filter=blob:none --no-checkout https://github.com/bluesky-social/atproto.git atproto-spaces-r14
git -C atproto-spaces-r14 fetch --depth=1 origin f839c47e6523a1a7adb367ef70513a3c6688c38b
git -C atproto-spaces-r14 checkout --detach f839c47e6523a1a7adb367ef70513a3c6688c38b
cd atproto-spaces-r14
shasum -a 256 /path/to/atproto-slack-clone/protocol-tests/atproto/strict-credential-expiry.patch
git apply /path/to/atproto-slack-clone/protocol-tests/atproto/strict-credential-expiry.patch
PUPPETEER_SKIP_DOWNLOAD=true pnpm --runtime-on-fail=ignore install --frozen-lockfile
pnpm --runtime-on-fail=ignore run build:tooling
# Run oauth-provider-ui prebuild with Node >= 24.2 if building on Node 22.17:
pnpm --runtime-on-fail=ignore --filter @atproto/oauth-provider-ui prebuild
pnpm --runtime-on-fail=ignore --filter @atproto/dev-env... --filter @atproto/space --filter @atproto/star prebuild
pnpm --runtime-on-fail=ignore --filter @atproto/dev-env... --filter @atproto/space --filter @atproto/star --filter @atproto/lex-cli build
pnpm --runtime-on-fail=ignore --filter @atproto/space test
```

Verify the resulting checkout cryptographically from this repository:

```sh
ATPROTO_PIN_CHECKOUT=../atproto-spaces-r14 node scripts/verify-pinned-checkout.mjs
```

---

## In-place pinned conformance suites (`protocol-tests/atproto/`)

In R13, all surviving `protocol-tests/atproto/*.test.ts` suites execute **directly in-place** under `node --import tsx --test` (via `protocol-tests/support/pinned-atproto-harness.ts` and `ATPROTO_PINNED_CHECKOUT=../atproto-spaces-r12 pnpm test:acceptance`) **without copying files into or mutating `$ATPROTO_PINNED_CHECKOUT`**:

1. **`protocol-tests/atproto/slack-dm-conformance.test.ts`:** Verifies personal-PDS sovereign DM conformance on `com.atproto.memberspace.policy` — cross-host symmetric conversation halves, closed existence oracle (`SpaceNotFound` vs `SpaceDeleted` + public `new.flock.dm.declaration`), public-write vs allowlist transitions (`putMembers` / `removeMembers` `#repoRemoved` + dormant allowlist reactivation), public browser OAuth (`token_endpoint_auth_method: "none"`), `credentialKey` (`cnf.kid`) PoP + HPKE KEM-MACs, 100-participant scaling, and strict zero-skew credential expiry after `removeMembers`.
2. **`protocol-tests/atproto/platform-spike-k2-confidential-client.test.ts`:** Verifies confidential `private_key_jwt` OAuth client flows, JWKS rotation, DPoP binding, and refresh semantics against real pinned PDS OAuth providers.
3. **`protocol-tests/atproto/platform-spike-k5-oplog.test.ts`:** Verifies per-page signed/MAC-authenticated `listRepoOps`, `getRepo` `application/vnd.dasl.star` (`@atproto/star`), `LtHash` set-hash equivalence, and `RepoNotFound` semantics on real pinned PDSes.

*(Note: R12's `slack-authority-oauth-conformance.test.ts` and `slack-inbox-conformance.test.ts`—which tested R12's bespoke personal-PDS `com.atproto.memberspace` workspace governance—were retired in R13 and superseded by `protocol-tests/opensocial-groups.test.ts` and `packages/testing/src/group-host-parity.test.ts`.)*

---

## API & authorization mapping (R13 `opensocial.group` + `6747610566` Spaces)

| Capability | Group Workspaces (`apps/group-host` — `group.opensocial.policy`) | Sovereign DMs & Personal `invites/self` (`TestPds` — `com.atproto.memberspace.policy`) |
|---|---|---|
| **Identity & hosting** | `1 Group == 1 did:plc:...` account publishing `#atproto`, `#atproto_kem`, `rotationKeys`, and `#atproto_pds` (`GROUP_HOST_URL`; host `did:web` also publishes `#opensocial_group`); signed `@atproto/repo` MST public repo (`declaration/self` when `publicMeta === true`) | Personal `did:plc:...` account on user's own PDS (`new.flock.dm.declaration/self` when DMs enabled) |
| **Space policies & RBAC** | Core `group.opensocial.{meta,members}/self` + Flock `new.flock.{workspace,inbox}/self`, `channel/<skey>`, `app.inbox/<appSkey>`, `ext.tasks/<tasksSkey>` governed by `group.opensocial.policy` (`{ publicRead, unlisted, grants: [{ role, read, write, scopes? }] }`), auto-published at `com.atproto.space.policy/self`. `O(1)` `membership/<did>` writes in `members/self`; losing `write` evicts writer (`#repoRemoved`) | `new.flock.dm.inbox/self`, `new.flock.dm.conversation/<convKey>`, and `group.opensocial.invites/self` (`{ publicRead: false, publicWrite: true }`, zero members) governed by `com.atproto.memberspace.policy` (`putMembers`, `removeMembers`, `listMembers`; ESLint `no-legacy-memberspace` blocks workspace use) |
| **Invitations & admission** | Outbound `group.opensocial.invite/<tid>` written by `<groupDid>` into `at:space/<inviteeDid>/group.opensocial.invites/self` (`notifyRepoUpdate` tracked in `invite_delivery`); redeemed via `group.opensocial.requestJoin` (`Idempotency-Key`, 6-case decision table across `open`/`approval`/`invite`), `cancelJoinRequest`, `listJoinRequests`, `denyJoinRequest`, `If-Join-Request-Present: true` approval (`decideGroupJoinRequest`), and `/group-member/join-status` | DM `new.flock.dm.request` written into recipient's `dm.inbox/self` |
| **Moderation** | `group.opensocial.createReport` (`space_record` for `<groupDid>` authors, `space_writer` for member/bot authors, `members/self` for accounts incl. `<groupDid>`), `listModSubjects`, `getModSubjectHistory`, `resolveModSubject`, and `<groupDid>`-authored `com.atproto.label.record` (`!takedown`, `!hide`) projected by latest `cts` (`packages/protocol/src/moderation.ts`) | Per-participant half ownership & `leave` / `deleteEverything` |
| **Space sync & MACs** | `authorizeSpaceSync` (`{ credential, spaceRev }`, inline `notify`, synchronous final epoch/lifecycle recheck), `listWriters`, `Atproto-Space-Credential` RFC 9421 PoP (`verifyGroupSpaceCredential` zero-skew `nowSec >= exp`), HPKE KEM-MACs (`Atproto-Space-Commit`/`Record`, `Atproto-Membership-Incarnation` on `membership` `getRecord`), `@atproto/star` `getRepo` / `exportSpaceMeta` / `importSpaceMeta` / `importRepo` | Identical `authorizeSpaceSync`, `listWriters`, RFC 9421 PoP (`strict-credential-expiry.patch`), HPKE KEM-MACs, and `@atproto/star` `getRepo` |

---

## OAuth scopes (`packages/protocol/src/scopes.ts`)

### 1. Personal PDS member session (`memberGrantScopes(serviceRef)`)

Combines `DM_BROWSER_SCOPES` (includes `"atproto"`), spelled-out `OPEN_SOCIAL_PARTICIPATE_SCOPES` (avoiding `include:` lookup while still requiring `_lexicon.opensocial.group` DNS publication for `space:` NSIDs), Flock modality member scopes, and one combined Operator RPC token:

```text
# OPEN_SOCIAL_PARTICIPATE_SCOPES (spelled-out expansion of group.opensocial.authParticipate)
space:group.opensocial.meta?authority=*&skey=self&action=read
space:group.opensocial.members?authority=*&skey=self&collection=group.opensocial.acceptance&action=read&action=create&action=update&action=delete
space:group.opensocial.invites?authority=self&skey=self&action=read&manage=create
rpc?aud=*&lxm=group.opensocial.cancelJoinRequest&lxm=group.opensocial.createReport&lxm=group.opensocial.leaveGroup&lxm=group.opensocial.requestJoin

# Operator RPC token (includes getDmNotifyTarget & getSpaceNotifyTarget)
rpc?lxm=new.flock.operator.execute&lxm=new.flock.operator.getOperation&lxm=new.flock.operator.getChanges&lxm=new.flock.operator.createWorkspace&lxm=new.flock.operator.startAuthorityFlow&lxm=new.flock.operator.listStalledOperations&lxm=new.flock.operator.getDmNotifyTarget&lxm=new.flock.operator.getSpaceNotifyTarget&aud=OPERATOR_DID%23atproto_flock_operator
```

### 2. Group-DID sessions (`groupAdminScopes` & `groupModeratorScopes`) and `effectiveMemberPermissions`

- **`groupAdminScopes(groupDid?)`** (used by Operator's shared Group-DID session, `prompt=create` PAR, and `GroupBrowserOAuthClient` admin sessions; never emits invalid `aud=self`):
  ```text
  atproto
  include:group.opensocial.authManageGroup
  repo:*
  blob:*/*
  identity:*
  account:repo?action=manage
  account:status?action=manage
  space:*?authority=*&action=read_self
  space:*?collection=*&action=read&action=create&action=update&action=delete&manage=create&manage=update&manage=delete
  rpc?aud=*&lxm=com.atproto.server.createAccount&lxm=com.atproto.space.notifyCredentialsRevoked&lxm=com.atproto.space.notifyRepoUpdate
  # Plus rpc:*?aud=<groupDid>%23atproto_pds once concrete groupDid is known (e.g. in role/admin)
  ```
- **`groupModeratorScopes()`:** `["atproto", "include:group.opensocial.authModerate", "space:*?collection=com.atproto.label.record&action=read&action=create&action=update&action=delete"]`.
- **Live narrowing (`effectiveMemberPermissions`):** On every Group-DID request, Group Host intersects the session's `approved_scope` with `effectiveMemberPermissions(state, groupDid, authorizingUserDid)`—the union of `expandGroupScopes` across assigned `role.scopes` and `expandPolicyGrantScopes` across every non-deleted space's matching `policy.grants[].scopes` (strictly clamped to that space). Neither Group Host nor Operator ever holds DM scopes.

---

## Stable key encoding (`packages/protocol/src/keys.ts`)

Protocol-level record keys validate against `@atproto/syntax` `isValidRecordKey` (`1..512` `[A-Za-z0-9._~:-]` chars, rejecting `"."` and `".."`), canonical TIDs validate against exact `isValidTid` (`^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$`, rejecting leading `k`–`z`), and Flock-minted space keys use `isSkey` (`1..128` chars). Hashed personal-PDS record keys insert `:` between lowercase RFC 4648 base32 characters so digests never match the personal PDS slur filter:

| Key / Prefix | Owner / Space | Construction |
|---|---|---|
| `self` | Singleton spaces & records | `group.opensocial.{meta,members,invites}/self`, `new.flock.{workspace,inbox,dm.inbox}/self`, `declaration/self`, `profile/self`, `labeler/self`, `acceptance/self` |
| `<memberDid>` | `group.opensocial.membership/<did>` | Canonical member or app DID (`isDid`) |
| `admin`, `moderator`, `member`, `channel-<skey>` | `group.opensocial.role/<rkey>` | Built-in role keys and per-private-channel role key |
| `app-<52-char-base32>` | `group.opensocial.role/<appRoleKey>` | `"app-" + base32Lower(sha256(utf8(appDid))).slice(0, 52)` (full 256-bit digest) |
| `d-` (`subjectKey`) | `new.flock.app.install`, DM request | `"d-" + colonBase32(sha256(did))` |
| `r-` (`requestRecordKey`) | `new.flock.joinRequest` | `"r-" + colonBase32(sha256(channelUri + "\0" + requesterDid))` |
| `q-` (`decisionRecordKey`) | `new.flock.joinDecision` | `"q-" + colonBase32(sha256(requestUri))` |
| `x-` (`reactionRecordKey`) | `channel.reaction`, `dm.reaction` | `"x-" + colonBase32(sha256(messageUri + "\0" + emoji + "\0" + authorDid))` |
| `i-` (`appInboxSkey`) | `new.flock.app.inbox/<skey>` | `"i-" + colonBase32(sha256(workspaceSkey + "\0" + appDid))` |
| `x-` (`extSpaceSkey`) | `new.flock.ext.tasks/<skey>` | `"x-" + colonBase32(sha256(extId + ":" + workspaceSkey))` |

---

## Historical Pin Log (`f839c47e` R14, `6747610566` R12–R13, `5d88b414`, `619c6e85`, `5b95b2f2`, `787a730f` — preserved for reference)

- **R14 (`f839c47e`, 2026-11-24):** Migrated all space & space-record URIs from `at://<did>/space/<spaceType>/<skey>` to canonical `at:space/<did>/<spaceType>/<skey>` (PR #6010 / `proposals#146`), upgraded npm dependencies to `0.0.0-spaces-alpha-20261124235736` (+ `@atproto/star@0.0.1`, `@atproto/lex-{cbor,data}@0.1.11`), dropped the former `@atproto/oauth-scopes` patch and `pnpm-workspace.yaml` overrides, and added idempotent URI migrations for Group Host SQLite, Operator SQLite (`SPACE_URI_MIGRATION = 5`), IndexedDB (`v4` / Desk lifecycle `v2`), and `HooksStore`.
- **R12 (`6747610566`, 2026-11-17):** Adopted `authorizeSpaceSync` (`{ credential, spaceRev }`, inline `notify`), `listWriters` (`#repoWrite` / `#repoRemoved`), batched `com.atproto.memberspace.{putMembers,removeMembers}`, every-page `listRepoOps` commit+MAC, `@atproto/star` `getRepo`, and `getDmNotifyTarget` (`dm1`).
- **`5d88b414` (2026-10-30):** Replaced `simplespace` with space policies, `Atproto-Space-Credential` RFC 9421 signatures, HPKE `#atproto_kem` MACs, `#atproto_pds` host service ID, closed `SpaceNotFound` existence oracle, and `new.flock.dm.declaration`.
- **`619c6e85` (2026-10-21) & `5b95b2f2` (2026-10-09) & `787a730f` (2026-09-25):** Initial Proposal 0016 pins, `spaceType`, `repoRev`/`spaceRev`, 600s default / 3600s max credential TTL, and strict zero-skew credential expiry overlay.
