# Code Map

> Collaborative workspaces built on `opensocial.group` atmospheric Group DIDs (`1 Group == 1 DID`) and ATProto permissioned spaces (`com.atproto.space.*`), plus sovereign personal-PDS Direct Messages (`new.flock.dm.*`). See `SPEC.md` for product scope and `ARCHITECTURE.md` for runtime boundaries.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend (`apps/web`) | React 19, Next.js 16 App Router, TypeScript 5.9 (stateless UI + browser IndexedDB/WebCrypto OAuth) |
| Group Host (`apps/group-host`) | Node.js 22, Express, `@atproto/xrpc-server`, `@atproto/repo`, `@atproto/space`, `@atproto/star`, `@atproto/oauth-scopes`, `@did-plc/lib`, `better-sqlite3` (`42` tables) |
| Operator (`apps/operator`) | Node.js 22, Express, `@atproto/xrpc-server`, `@atproto/oauth-client-node`, Kysely + `better-sqlite3` |
| Apps (`apps/echo-bot`, `apps/webhooks`) | Node.js 22, `@flock/client` (`@flock/client/node/*`) |
| Testing & Verification | `node:test`, Playwright, Cucumber BDD (`features/*.feature`), `FakeNetwork` (`@flock/testing`), pinned `@atproto` Spaces (`6747610566`) & `opensocial.group` (`8df0cc82`) |

## System boundaries

```
             BROWSER (apps/web)                        STATELESS WEB SERVER (apps/web, :3000)
  ┌─────────────────────────────────────────┐      ┌──────────────────────────────────────────┐
  │ React UI: apps/web/src/app/ui           │◀────▶│ (shell)/**/page.tsx, layout.tsx, proxy.ts│
  │  workspace-manager, group-governance-   │      │ /oauth/{client-metadata.json,callback},  │
  │  panel, moderation-panel, invite-banner,│      │ /oauth/{group-client-metadata.json,      │
  │  channel-view, dm-*.tsx, ui/ext/tasks/* │      │  group-callback}. Zero DB, zero secrets. │
  │ Browser OAuth:                          │      └──────────────────────────────────────────┘
  │  - session.ts (personal PDS OAuth)      │
  │  - group-session.ts (GroupBrowserOAuth  │      GROUP HOST (apps/group-host, :3004)
  │    Client, flock-group-oauth:<did> IDB) │      ┌──────────────────────────────────────────┐
  │ Isomorphic SDK (@flock/client):         │─────▶│ 1 Group == 1 did:plc account, 2-sided    │
  │  WorkspaceClient, GroupClient,          │ DPoP │ OAuth 2.1 AS (prompt=create, /oauth/     │
  │  ChannelClient, TasksClient, DmClient   │ /JWT │ confirm-action, live narrowing), signed  │
  │ Independent readers (@flock/reader):    │      │ MST public repo, meta/self, members/self │
  │  independent{,-dm,-tasks}.ts            │      │ (role, membership, space index), Flock   │
  └───────────┬──────────────────┬──────────┘      │ modality spaces, join/mod XRPCs, outbox, │
              │                  │                 │ Standard & Coordinated v1 host migration │
              │ svc JWT / feed   │                 │ SQLite: 42 classified tables (0 DM rows) │
              ▼                  │                 └────────────────────▲─────────────────────┘
  OPERATOR (apps/operator, :3001)│                                      │
  ┌──────────────────────────────┴──────────┐                           │ shared group OAuth
  │ Shared group OAuth session, 18 journaled│───────────────────────────┘ + 1-webhook/space
  │ kinds (aborted_actor_revoked & admin    │                             notifySpaceUpdate
  │ takeover), getChanges cursor feed,      │      EACH ACCOUNT'S PERSONAL PDS
  │ getDmNotifyTarget (dm1) &               │      ┌──────────────────────────────────────────┐
  │ getSpaceNotifyTarget (inv1) wakes.      │◀────▶│ Member space repos: channel.{message,    │
  │ SQLite: grants, journal, audit, notices │      │  reaction}, ext.tasks.*, joinRequest,    │
  │ (0 DM rows; ephemeral dm-feed-wakes).   │      │  app.{command,action}, acceptance/self   │
  └─────────────────────────────────────────┘      ├──────────────────────────────────────────┤
              ▲                                    │ group.opensocial.invites/self            │
              │ authorizeSpaceSync + HPKE MAC      │  (memberspace publicWrite, 0 members)    │
              └───────────────────────────────────▶├──────────────────────────────────────────┤
                                                   │ new.flock.dm.{inbox,conversation}        │
                                                   │  (sovereign memberspace DMs)             │
                                                   └──────────────────────────────────────────┘
```

Three independent-app proofs exist side by side in `packages/reader/src/`: `independent.ts` (OpenSocial groups/channels + `!takedown`/`!hide` label projection), `independent-dm.ts` (sovereign DMs), and `independent-tasks.ts` (Tasks extension via STAR/oplog verification + pure `entity-merge`). All three depend only on `@flock/protocol` and `@atproto/{space,star,lex-data,lexicon}` — never on `@flock/client` or any server database.

## DM data flow (read)

```
 browser personal OAuth session (DM_BROWSER_SCOPES)
        │
        │ 1. mintSpaceCredentialWith(deps, half-uri, { notify? })
        │    (watch optionally fetches stateless dm1 target via getDmNotifyTarget; falls back without notify)
        ▼
 getDelegationToken @ caller's own PDS  ──token──▶  authorizeSpaceSync @ half owner's PDS
        │
        │ 2. key-bound space credential (10 min default, 1 h max) + optional spaceRev
        ▼
 for each participant's conversation half (fan-out 8, packages/protocol/src/map-limited.ts):
   - read header, validate convKey + participant set match (validateDmHeaderMatchesRequest)
   - classify a failed mint as missing / deleted / revoked (SpaceCredentialError.code)
        │
        │ 3. sync and merge
        ▼
 packages/client/src/sync.ts (DmClient.readConversation)  -- OR --  packages/reader/src/independent-dm.ts
        │
        ▼
 { messages (newest first), reactions, halves: Record<did, status> }
```

## Directory map

A `pnpm` workspace. Packages import siblings by workspace name (`@flock/<package>/<path>`, TypeScript source directly) and own modules by relative path; `import/no-extraneous-dependencies` and `flockBoundariesPlugin` in `eslint.config.mjs` enforce every package, runtime, and `no-legacy-memberspace` boundary.

```
packages/                 Shared libraries. `protocol` and `client` (outside `client/src/node/*`) typecheck with zero
                           `@types/node` (`pnpm typecheck`) and forbid Node built-ins (`pnpm lint`).
  protocol/  @flock/protocol    Pure, isomorphic protocol schemas, validators, scopes, moderation, and summary logic.
    lexicons/                135 JSON lexicons: 36 `new.flock.*` (modality spaces, records, operator XRPCs including
                              `getSpaceNotifyTarget` & `getDmNotifyTarget`, `permissions/member.json`), 27 vendored
                              `group.opensocial.*` (`meta`, `members`, `invites`, `policy`, `declaration`, `profile`,
                              `rule`, `labeler`, `space`, `role`, `membership`, `acceptance`, `invite`, 4 permission sets,
                              9 join/moderation XRPCs), and 72 vendored `com.atproto.{space,memberspace,managedspace,
                              personalspace,identity,label,repo,server,sync}.*` schemas (`99` upstream files pinned by
                              SHA-256 in `opensocial-lexicons.test.ts`).
    src/keys.ts              Canonical URI/key syntax: `isDid`, `isRecordKey` (`1..512` chars), `isSkey` (`1..128` chars
                              for Flock-minted channel/app/extension keys), exact `isTid` (`^[234567abcdefghij]...`),
                              `parseSpaceUri`, `spaceRecordUri`, `parseSpaceRecordUri`, `appRoleKey` (52-char base32 SHA-256),
                              `canonicalParticipants`.
    src/nsids.ts             Single owner of every NSID (`NAMESPACE`, `OPEN_SOCIAL_NAMESPACE`, `SPACE_TYPE`, `COLLECTION`,
                              `REPO_COLLECTION`, `OPERATOR_METHOD`, `OPEN_SOCIAL_METHOD`, `ATPROTO_METHOD`, `NOTICE_METHOD`).
    src/registry.ts          Runtime `@atproto/lexicon` `Lexicons` validator + `REGISTRY`: `validateSpaceTypeKey`
                              (`literal:self` enforcement, rejecting `<groupDid>`-owned `invites`),
                              `decodeFlockMembershipExtensions` / `decodeFlockAcceptanceExtensions` (`new.flock.incarnation`,
                              `generation`, `admittedSpaceRev`, `afterWriterRev`), `validateSpacePolicy`, `validateSpaceRecord`,
                              `validateGroupDeclaration`, `validatePublicRecord`, `MAX_RECORD_BYTES`.
    src/scopes.ts            Canonical `@atproto/oauth-scopes` builders & evaluators: `VENDORED_PERMISSION_SETS`,
                              `OPEN_SOCIAL_PARTICIPATE_SCOPES`, `memberGrantScopes`, `appGrantScopes`, `groupAdminScopes`,
                              `groupModeratorScopes`, `expandGroupScopes`, `expandPolicyGrantScopes`, and
                              `effectiveMemberPermissions` (union of `role.scopes` + space-clamped `policy.grants[].scopes`).
    src/moderation.ts        ATProto `com.atproto.label.record` latest-`cts` projection, expiry, same-space validation,
                              and `!takedown` / `!hide` filtering across client, reader, web, echo-bot, and webhooks.
    src/migration-manifest.ts RFC 8785 JCS canonical migration manifest builder & digest helpers for Coordinated v1 cutover.
    src/workspace-summary.ts Summarizes a group/workspace from `meta/self`, `members/self` (`role/*`, `membership/*`,
                              member-authored `acceptance/self` + `memberWriters` rev evidence), `spacePolicies`, and
                              `workspace/self` (`directory/*`, `app.install/*`, `ext.install/*`), excluding `<groupDid>`
                              and `knownAppSubjects` from human rosters and enforcing `WORKSPACE_ENVELOPE`.
    src/extensions.ts, src/entity-merge.ts, src/bounded-json.ts, src/map-limited.ts
                             Declarative extension catalog (`tasks`), causal DAG/HLC/OR-Set merge (`entity-merge.ts`,
                              lint-isolated to Tasks + `independent-tasks`), bounded JSON reader, fixed-concurrency fan-out.
    src/lexicons/api/        Generated XRPC schema dict & types (`ATPROTO_PIN_CHECKOUT=../atproto-spaces-r12 pnpm codegen:lex`).
    src/atproto/             Isomorphic space protocol helpers: `xrpc.ts`, `space-key.ts`, `space-policy.ts`, `kem-key.ts`,
                              `repo-failure.ts`, `space-credential-core.ts` (`authorizeSpaceSync`, RFC 9421 credential PoP,
                              HPKE KEM-MAC verification, `fetchVerifiedRepoStar`), `record-pages.ts`, `valid-channel-messages.ts`.
  net/  @flock/net              Node-only SSRF-safe HTTP transport (`safe-fetch.ts`): DNS-pinned IP validation (HTTPS in
                              prod, loopback allowed only in dev/test), redirect blocking, and `boundedSafeFetch` enforcing
                              `deadlineMs`, `allowedContentTypes` before body read, and streaming `maxResponseBytes` caps.
  deployment/  @flock/deployment
                             Shared deployment config (`config.ts`: `APP_URL`, `OPERATOR_URL`, `GROUP_HOST_URL` defaulting
                              to `http://127.0.0.1:3004`, `PLC_URL`, `OPERATOR_SERVICE_REF`) and CSP/security headers
                              (`security-headers.ts`).
  client/  @flock/client        Isomorphic workspace, group, channel, Tasks, app-runtime, and DM SDK.
    src/workspace-client.ts  Discovery (`discover` -> `resumeJournals` -> `discoverCore`), `ensureInvitesSpace()` (idempotent
                              personal `group.opensocial.invites/self` provisioning + `IncompatibleInvitesSpacePolicyError`),
                              `getSpaceNotifyTarget` `inv1` registration, tombstone-aware invite pruning, 3-phase
                              `leavingGroups`, 5-phase `joiningGroups`, 4-phase `reactivatingGroups`, and Operator calls.
    src/group-client.ts      Direct client for `opensocial.group` governance & moderation (`listJoinRequests`,
                              `denyJoinRequest`, `listModSubjects`, `getModSubjectHistory`, `resolveModSubject`, profile/
                              rules/roles/membership/labels/invites CRUD, `inviteDeliveries`, `retryInviteDelivery`,
                              step-up `claimActionToken`, `deleteAccount`, and Standard/Coordinated host migration).
    src/channel-client.ts, src/app-inbox-client.ts, src/operator-client.ts, src/ext/tasks/tasks-client.ts
                             Channel messaging/reactions (filtering `!takedown` and surfacing `!hide`), app commands/actions,
                              Operator XRPC client (`getChanges`, `getDmNotifyTarget`, `getSpaceNotifyTarget`, `execute`),
                              and lint-isolated Tasks client.
    src/sync.ts, src/store.ts, src/memory-store.ts, src/indexeddb-store.ts, src/credentials.ts, src/lifecycle.ts
                             Verified space/oplog/STAR sync, `SyncStore` (`leavingGroups`, `joiningGroups`,
                              `reactivatingGroups`, records, writers, HLC `clock`, `activity`), per-account IndexedDB,
                              credential cache, and space retention lifecycle.
    src/app-runtime.ts, src/node/{transport,oauth,admin-oauth}.ts
                             Bot/app runtime (`runApp` tailing `followRepoOps` with `!takedown` filtering) and Node-only
                              `@flock/net`-backed confidential OAuth / admin OAuth helpers.
    src/dm/                  Sovereign personal-PDS DM engine (`dm-client.ts`, `request-policy.ts`, `backoff.ts`,
                              `browser-store.ts`, `ui-logic.ts`).
    src/testing/             `engine-fixture.ts` and `store-contract.ts` over `@flock/testing`.
  reader/  @flock/reader        Zero-lock-in independent readers (`independent.ts`, `independent-dm.ts`, `independent-tasks.ts`).
  testing/  @flock/testing      In-memory multi-PDS + OpenSocial Group Host test network (`fake-network.ts`, `fake-group-host.ts`),
                              verified 1-for-1 against `apps/group-host` by `group-host-parity.test.ts`.

apps/
  group-host/  @flock/group-host Reference `opensocial.group` Group Host (`pnpm group-host`, `:3004`).
    src/config.ts, src/crypto-box.ts
                             `GROUP_HOST_URL` (`127.0.0.1` loopback normalization), `did:web` service DID, `32`-byte
                              `GROUP_HOST_ENCRYPTION_KEY` HKDF-SHA256 subkeys (AES-256-GCM with table/row/column AAD +
                              deterministic `#atproto` service keypair), optional `GROUP_HOST_SERVICE_PRIVATE_JWKS`
                              overlap rotation, `GROUP_HOST_HANDLE_DOMAIN`, and upload/import byte caps.
    src/db.ts, src/repo-store.ts
                             `42`-table SQLite schema (`SCHEMA_TABLE_CLASSIFICATION`), `SqlStagingRepoStorage` two-phase
                              async MST precompute + synchronous `BEGIN IMMEDIATE` commit under `withGroupRepoLock(did)`,
                              bounded `60s` expiry/retention sweeps, and `outbox_notice` delivery worker.
    src/oauth.ts             Two-sided OAuth 2.1 AS (`/.well-known/*`, `/oauth/{par,authorize,upstream-callback,
                              confirm-action,token,revoke,jwks.json,client-metadata.json}`), reusable `verifyDpopProof`
                              (`198s` `dpop_jti` replay window), 5-state `prompt=create` `group_creation_journal`,
                              `session_kind = 'recovery'`, and `/group-admin/controller-session` sovereign `rotationKeys` auth.
    src/rbac.ts, src/methods.ts, src/moderation.ts, src/plc.ts, src/migration.ts, src/server.ts, src/main.ts
                             Live `effectiveMemberPermissions` & `assignable` enforcement, `known_app_subject` & Flock-scoped
                              `LastAdmin`, `com.atproto.{identity,repo,server,space,sync}.*` + `group.opensocial.*` XRPCs,
                              6-case `requestJoin` (`Idempotency-Key` + `If-Join-Request-Present` + `/group-member/join-status`),
                              `If-Match-Membership-Incarnation` `leaveGroup`, 4-state pre-tombstone `deleteAccount`,
                              moderation queue/history/labels, and Standard + Coordinated v1 two-GroupHost migration.
  operator/  @flock/operator    Shared-session modality orchestrator & notification hub (`pnpm operator`, `:3001`).
    src/config.ts, src/lib/db.ts
                             Operator config (`DATABASE_PATH`, `AUTH_ENCRYPTION_KEY`, `AUTHORITY_CLIENT_PRIVATE_JWKS`,
                              `FLOCK_ADMIN_MUTATIONS_PAUSED`) and SQLite schema including `OPERATION_TAKEOVER_MIGRATION = 4`
                              (`aborted_actor_revoked` state + `taken_over_by` column, zero DM rows).
    src/operator/authority-grant.ts, creation-authorization.ts
                             Shared Group-DID OAuth flow (`/authority/start` -> Group Host OAuth -> `/authority/callback`),
                              quarantined encrypted `authority_grant` store, and 15-minute `creation_authorization`.
    src/operator/journal.ts, operations.ts, kinds/*
                             18 journaled operation kinds (`createWorkspace`, `bootstrapWorkspace`, `inviteMember`,
                              `removeMember`, `setAdmin`, `createChannel`, `transitionChannel`, `archiveChannel`,
                              private-channel `decideJoinRequest`, group-level `decideGroupJoinRequest`, `leaveWorkspace`,
                              `leaveChannel`, `reconcileWorkspace`, `installApp`, `updateAppAccess`, `uninstallApp`,
                              `enableExtension`, `disableExtension`), live `effectiveMemberPermissions` re-verification,
                              `0`-step `aborted_actor_revoked`, and `>=1`-step audited `operationAdminTakeover`.
    src/operator/registrations.ts, space-notification.ts, dm-feed-wakes.ts, feed.ts, security.ts, methods.ts, server.ts
                             1-webhook-per-space `notify` renewal (`60s` loop + `30m` sweep), `getDmNotifyTarget` (`dm1`) &
                              `getSpaceNotifyTarget` (`inv1` exclusively for `at://<callerDid>/space/group.opensocial.invites/self`),
                              ephemeral `dm-feed-wakes`, and `getChanges`.
    scripts/authority-grant.ts  `pnpm authority generate-key <kid> | revoke <did>`.
  web/  @flock/web              Stateless Next.js UI (`pnpm dev` / `build` / `start`, `:3000`).
    src/browser/             `session.ts` (personal PDS OAuth), `group-session.ts` (`GroupBrowserOAuthClient`),
                              `client-metadata.ts`, `sign-out.ts` (clears personal store, DM store, and `flock-group-oauth:<did>`).
    src/app/oauth/           `/oauth/client-metadata.json`, `/oauth/callback`, `/oauth/group-client-metadata.json`,
                              `/oauth/group-callback`.
    src/app/ui/              `workspace-manager.tsx`, `workspace-onboarding.tsx`, `group-governance-panel.tsx` (roles,
                              join policy, join requests, outbound invite delivery status/retry, reactivation, deletion,
                              migration), `moderation-panel.tsx`, `report-subject-modal.tsx`, `invite-banner.tsx`,
                              `channel-view.tsx`, `apps-panel.tsx`, `extensions-panel.tsx`, `ext/tasks/*`, `dm-*.tsx`.
  echo-bot/  @flock/echo-bot    First-party bot app (`pnpm echo-bot sign-in <handle>` / `run`, `:3002`); depends on `@flock/client` only.
  webhooks/  @flock/webhooks    First-party incoming-webhooks app (`pnpm webhooks sign-in <handle>` / `run`, `:3003`); depends on `@flock/client` only.

scripts/                  `verify-pinned-checkout.mjs`, `codegen-lex.mjs` (`pnpm codegen:lex`), `backup-db.mjs`
                           (`pnpm backup:db` & `pnpm backup:group-host`), `verify-public-lexicons.mjs`
                           (`pnpm verify:lexicons`), `playground.ts` (`pnpm playground`), `render-bdd-video.ts`.
protocol-tests/           Real multi-PDS + Group Host acceptance (`opensocial-groups.test.ts`, `app-acceptance.test.ts`,
                           `dm-acceptance.test.ts`, etc.), `atproto/{slack-dm-conformance,platform-spike-k2-confidential-client,
                           platform-spike-k5-oplog}.test.ts` + `strict-credential-expiry.patch`, Playwright `browser/*.spec.ts`
                           (incl. `opensocial-groups.spec.ts`), `sync-budget.ts`, `performance-envelope.test.ts`, and
                           zero-exclusion `suite-manifest.test.ts`.
features/, bdd/           Executable Gherkin scenarios (`MAX_UNBOUND_SCENARIOS = 0` in `bdd/gate.test.ts`).
docs/                     `dev-onboarding.md`, `operations.md`, `protocol/{atproto-spaces-pin,operator-contract}.md`,
                           historical R12 `prd/*` & `presentation/r12-atproto-conference-deck.html` (with R13 banners).
```

## Canonical owners

One row per behavior that must have a single home. A second implementation of a listed behavior is drift.

| Behavior | Owner | Must not grow a copy in |
|----------|-------|-------------------------|
| AT-URI, DID, TID (`isTid`), `isRecordKey` (`1..512`), `isSkey` (`1..128`), and `appRoleKey` syntax | `packages/protocol/src/keys.ts` | `packages/client/`, `apps/group-host/`, `apps/operator/`, `apps/web/` |
| NSID constants (`new.flock.*`, `group.opensocial.*`, `com.atproto.*`) | `packages/protocol/src/nsids.ts` | `packages/client/`, `packages/reader/`, `apps/*` |
| Runtime Lexicon validation, `validateSpaceTypeKey`, and `"new.flock.*"` membership/acceptance extension decoding | `packages/protocol/src/registry.ts` | `packages/client/`, `apps/group-host/`, `apps/operator/` |
| Scope expansion (`expandGroupScopes`, `expandPolicyGrantScopes`) and `effectiveMemberPermissions` union | `packages/protocol/src/scopes.ts` | `apps/group-host/src/rbac.ts`, `apps/operator/src/operator/`, `apps/web/` |
| `com.atproto.label.record` latest-`cts` projection and `!takedown` / `!hide` moderation filtering | `packages/protocol/src/moderation.ts` | `packages/client/`, `packages/reader/`, `apps/web/`, `apps/echo-bot/`, `apps/webhooks/` |
| Bilateral `membership` + `acceptance` roster pairing, `<groupDid>`/`knownAppSubjects` exclusion, and `WORKSPACE_ENVELOPE` | `packages/protocol/src/workspace-summary.ts` | `packages/client/`, `apps/operator/`, `apps/web/` |
| Space-credential exchange (`authorizeSpaceSync`), RFC 9421 credential signatures, and HPKE KEM-MAC verification | `packages/protocol/src/atproto/space-credential-core.ts` | `packages/client/`, `packages/reader/`, `apps/operator/` |
| Tasks causal DAG / HLC / OR-Set entity merge | `packages/protocol/src/entity-merge.ts` | Outside `packages/client/src/ext/tasks/` and `packages/reader/src/independent-tasks.ts` (ESLint-enforced) |
| SSRF-safe DNS-pinned HTTP fetch and `boundedSafeFetch` byte/MIME/deadline caps | `packages/net/src/safe-fetch.ts` | `apps/group-host/`, `apps/operator/`, `packages/client/src/node/` |
| Atmospheric Group DID storage, two-sided Group OAuth 2.1 AS, OpenSocial RBAC/moderation XRPCs, and host migration | `apps/group-host/src/` | `apps/operator/`, `apps/web/` |
| Shared-session multi-space modality journal, `operationAdminTakeover`, and `dm1`/`inv1` push-wake routing | `apps/operator/src/operator/` | `apps/group-host/`, `apps/web/` |
| Personal `invites/self` provisioning (`ensureInvitesSpace`) and 3/5/4-phase leave/join/reactivation client journals | `packages/client/src/workspace-client.ts` | `apps/web/`, `packages/client/src/group-client.ts` |
| Browser personal-PDS OAuth vs isolated per-viewer Group-DID OAuth (`GroupBrowserOAuthClient`) | `apps/web/src/browser/{session,group-session}.ts` | `apps/web/src/app/ui/` |
| `com.atproto.memberspace.{putMembers,removeMembers,listMembers}` usage (sovereign DMs + `ensureInvitesSpace` zero-member check) | `packages/client/src/dm/`, `packages/protocol/src/atproto/` | `apps/group-host/`, `apps/operator/`, workspace/channel client & UI (`no-legacy-memberspace` ESLint rule) |

## Entry points

| Command | Target | Description |
|---------|--------|-------------|
| `pnpm dev` / `pnpm build` / `pnpm start` | `apps/web` (`:3000`) | Stateless Next.js UI and static browser/group OAuth metadata & callbacks |
| `pnpm group-host` | `apps/group-host/src/main.ts` (`:3004`) | Reference `opensocial.group` Group Host (`GROUP_HOST_URL`) |
| `pnpm operator` | `apps/operator/src/operator/main.ts` (`:3001`) | Shared-session modality operator, webhook renewal loop, and `getChanges` feed (`OPERATOR_URL`) |
| `pnpm echo-bot` / `pnpm webhooks` | `apps/{echo-bot,webhooks}/src/main.ts` (`:3002`, `:3003`) | First-party non-roster bot apps (`sign-in <handle>`, then `run`) |
| `pnpm playground` | `scripts/playground.ts` | Full local stack (`2` personal PDSes + Group Host + PLC + Operator + Next.js) with 4 seeded accounts |
| `pnpm authority` | `apps/operator/scripts/authority-grant.ts` | `generate-key <kid>` (ES256 private JWK) or `revoke <did>` |
| `pnpm backup:db` / `pnpm backup:group-host` | `scripts/backup-db.mjs` | Online `0o600` SQLite backup for Operator (`DATABASE_PATH`) or Group Host (`--group-host`, `GROUP_HOST_DATABASE_PATH`) |
| `pnpm verify:lexicons` | `scripts/verify-public-lexicons.mjs` | Fail-closed pre-launch check resolving `_lexicon.opensocial.group` & `_lexicon.*.flock.new` DNS TXT + XRPC schemas |
| `pnpm codegen:lex` | `scripts/codegen-lex.mjs` | Verifies `$ATPROTO_PIN_CHECKOUT` (`verify-pinned-checkout.mjs`) and regenerates `packages/protocol/src/lexicons/api/` |
| `pnpm typecheck` / `pnpm lint` / `pnpm test` | Workspace-wide | Strict TS (`@types/node`-free `protocol`/`client`), ESLint boundaries, unit tests, `suite-manifest.test.ts`, and `bdd/gate.test.ts` (`0` `@unbound`) |
| `pnpm test:acceptance` | `protocol-tests/*.test.ts` + `protocol-tests/atproto/*.test.ts` | Real multi-PDS + Group Host acceptance, migration, and in-place pinned conformance (`slack-dm-conformance`, `K2`, `K5`) |
| `pnpm test:browser` / `pnpm test:bdd` / `pnpm test:bdd:slow` | Playwright & Cucumber | Real-browser CORS/CSP/dual-OAuth specs (`opensocial-groups.spec.ts`, etc.) and executable Gherkin scenarios |
| `pnpm test:performance` / `pnpm test:sync-budget` / `pnpm test:sync-budget:browser` | `protocol-tests/` | `200`-member/`100`-channel `O(1)` membership & sync call-count/latency gates |

## Conventions

- Dense, explicit TypeScript: named exports only, kebab-case file names, no default exports outside Next.js App Router conventions.
- Tests use `node:test` + `node:assert/strict`, named `*.test.ts` next to the code they cover; every file under `protocol-tests/**/*.ts` (outside `support/`) is partitioned 1-to-1 across root `package.json` scripts by `protocol-tests/suite-manifest.test.ts`.
- Every externally supplied DID, AT-URI, record key, record, and `"new.flock.*"` open-object extension is validated through `packages/protocol/src/keys.ts` and `packages/protocol/src/registry.ts` before use; every upstream HTTP fetch in Node goes through `@flock/net/safe-fetch` (`boundedSafeFetch`), and every XRPC list fetch goes through `packages/protocol/src/atproto/record-pages.ts`.
- Package and protocol boundaries are enforced mechanically by `package.json` dependencies + `eslint.config.mjs` (`no-legacy-memberspace`, `NO_ENTITY_MERGE_IMPORT`, `NO_EXTENSION_IMPORT`, `NO_DM_IMPORT`, `NO_NODE_BUILTINS`, `NO_CLIENT_NODE_ENTRY`) and tested in `packages/client/src/eslint-boundaries.test.ts`.
