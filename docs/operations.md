# Operations

## Runtime topology & configuration

Use the Node.js version in `.nvmrc` (`22.17`) and install locked dependencies with `corepack pnpm install --frozen-lockfile`. A production Flock deployment runs three core services on separate public HTTPS origins (plus optional first-party bot processes):

1. **Web app (`apps/web`, `corepack pnpm build && corepack pnpm start`, default `:3000`):**
   - Stateless Next.js App Router UI, per-request nonce Content-Security-Policy (`apps/web/src/proxy.ts`), and static browser OAuth metadata/callbacks (`/oauth/client-metadata.json`, `/oauth/callback`, `/oauth/group-client-metadata.json`, `/oauth/group-callback`).
   - Reads only `APP_URL`, `OPERATOR_URL`, `GROUP_HOST_URL`, `OPERATOR_SERVICE_REF`, and `PLC_URL`. Holds **no database, no secret, and no member session**.
2. **Reference `opensocial.group` Group Host (`apps/group-host`, `corepack pnpm group-host`, default `:3004`):**
   - Hosts atmospheric Group DIDs (`1 Group == 1 did:plc:...`), two-sided OAuth 2.1 Authorization Server (`/oauth/*`), `com.atproto.{identity,repo,server,space,sync}.*` + `group.opensocial.*` XRPC endpoints, `/group-admin/*` lifecycle/migration routes, `/group-member/join-status`, and `/.well-known/did.json` (`#atproto_pds` + `#opensocial_group`).
   - Required env vars: `GROUP_HOST_URL` (canonical origin; `http://127.0.0.1:3004` in loopback dev—`localhost` is normalized to `127.0.0.1` on HTTP to satisfy RFC 8252 loopback redirect rules and `oauthIssuerIdentifierSchema` while deriving `did:web:localhost%3A3004`—and `https://<host>` in production), `GROUP_HOST_DATABASE_PATH` (default `./data/group-host.db`, created `0o600` in WAL mode across `42` classified tables), `GROUP_HOST_ENCRYPTION_KEY` (64-char hex / 32 bytes), `GROUP_HOST_HANDLE_DOMAIN` (e.g. `groups.example.com`), and `PLC_URL`.
   - Optional env vars: `GROUP_HOST_SERVICE_PRIVATE_JWKS` (`{"keys":[...]}` ES256 private JWK Set for overlap key rotation), `GROUP_HOST_PORT` (validated `0..65535` listen port behind a TLS-terminating reverse proxy; defaults to `GROUP_HOST_URL`'s port, binding `127.0.0.1`/`::1` on loopback origins and `0.0.0.0` on public `https:` origins), `ALLOW_LOOPBACK` (set `false` to enforce public-HTTPS-only validation in non-production; in `NODE_ENV=production`, loopback HTTP is hard-disabled unless `ATPROTO_ACCEPTANCE_TEST=true`), and `ATPROTO_ACCEPTANCE_TEST` (`true` only in isolated local acceptance or restore-drill runs that intentionally exercise loopback HTTP under `NODE_ENV=production`).
3. **Operator (`apps/operator`, `corepack pnpm operator`, default `:3001`):**
   - Serves `new.flock.operator.*` XRPC methods, inbound space webhooks (`com.atproto.space.{confirmRegistration,notifySpaceUpdate}`), shared Group-DID OAuth (`/authority/*`), and `/.well-known/did.json` (`OPERATOR_SERVICE_REF`).
   - Required env vars: `APP_URL`, `OPERATOR_URL`, `GROUP_HOST_URL`, `OPERATOR_SERVICE_REF`, `PLC_URL`, `DATABASE_PATH` (default `./data/flock.db`), `AUTH_ENCRYPTION_KEY` (64-char hex / 32 bytes), and—outside loopback development—`AUTHORITY_CLIENT_PRIVATE_JWKS` (`{"keys":[...]}`). Optional: `FLOCK_ADMIN_MUTATIONS_PAUSED` (`true`/`false`) and `PORT`.
   - Runs a continuous **60-second SQL-first `notify` registration renewal loop** and **30-minute discovery sweep** inside `apps/operator/src/operator/main.ts`. *(Note: R12's `pnpm reconcile` / `reconcile-workspaces.ts` cron job was removed in R13 because `group.opensocial.policy` evaluates live `role/*` and `membership/*` records directly in `O(1)` without per-space `com.atproto.memberspace` fan-out drift.)*

All Node services (`apps/group-host`, `apps/operator`, `apps/echo-bot`, `apps/webhooks`) perform outbound HTTP through `@flock/net/safe-fetch` (`boundedSafeFetch`), enforcing HTTPS outside loopback dev, rejecting private/loopback/link-local/metadata IPs with DNS-pinned connections, blocking HTTP redirects, checking `Content-Type` before reading bodies, and capping response bytes (`64 KiB`–`4 MiB` by profile) and deadlines (`5 s`–`15 s`). Public deployments **must** use publicly routable HTTPS origins for `APP_URL`, `OPERATOR_URL`, and `GROUP_HOST_URL` because personal PDSes also enforce SSRF checks on `confirmRegistration`, `notifySpaceUpdate`, and OAuth metadata fetches.

---

## Mandatory pre-launch gate: public Lexicon DNS + XRPC verification (`pnpm verify:lexicons`)

> [!IMPORTANT]
> **Fail-closed production launch blocker:** Do **not** point a production deployment at public ATProto personal PDSes until `corepack pnpm verify:lexicons` exits `0`.

### Why this gate is mandatory

On pinned ATProto personal PDSes (`oauth-provider.ts`, `lexicon-manager.ts`), `OAuthProvider.authorize()` calls `lexiconManager.getSpacesFromScope()`, which resolves **every non-wildcard `space:<spaceType>` NSID** in `memberGrantScopes` and `appGrantScopes` via DNS TXT (`_lexicon.<authority>`) → XRPC `com.atproto.repo.getRecord(collection="com.atproto.lexicon.schema")`. Using spelled-out `OPEN_SOCIAL_PARTICIPATE_SCOPES` avoids resolving `include:group.opensocial.authParticipate` on personal PDSes, **not** resolving `space:group.opensocial.{meta,members,invites}` or `space:new.flock.*`!

In local/CI tests and `pnpm playground`, `publishAppLexicons` seeds `TestNetworkNoAppView`'s in-memory `lexiconAuthority`. Because upstream `opensocial.group` is still a draft specification, public DNS publication must be verified explicitly before launch.

### Required DNS TXT authorities & `com.atproto.lexicon.schema` records

`scripts/verify-public-lexicons.mjs` loads all **`63` public schemas** vendored in this repository (**`36` `new.flock.*`** + **`27` `group.opensocial.*`**) and verifies all **9** corresponding `_lexicon.<authority>` DNS TXT records (`did=did:plc:...` or `did=did:web:...`, exactly one valid `did=` TXT record per hostname):

1. `_lexicon.opensocial.group` — all `27` `group.opensocial.*` schemas (`meta`, `members`, `invites`, `policy`, `defs`, `declaration`, `profile`, `rule`, `labeler`, `space`, `role`, `membership`, `acceptance`, `invite`, `authParticipate`, `authManageProfile`, `authModerate`, `authManageGroup`, and all `9` XRPC methods)
2. `_lexicon.flock.new` — `new.flock.{workspace,channel,directory,inbox,joinRequest,joinDecision}`
3. `_lexicon.app.flock.new` — `new.flock.app.{action,command,declaration,inbox,install}`
4. `_lexicon.channel.flock.new` — `new.flock.channel.{message,reaction}`
5. `_lexicon.dm.flock.new` — `new.flock.dm.{conversation,declaration,header,inbox,message,reaction,request}`
6. `_lexicon.ext.flock.new` — `new.flock.ext.{install,tasks}`
7. `_lexicon.operator.flock.new` — `new.flock.operator.{createWorkspace,execute,getChanges,getDmNotifyTarget,getOperation,getSpaceNotifyTarget,listStalledOperations,startAuthorityFlow}`
8. `_lexicon.permissions.flock.new` — `new.flock.permissions.member`
9. `_lexicon.tasks.ext.flock.new` — `new.flock.ext.tasks.{comment,project,projectEdit,task,taskEdit}`

*(Note: All Flock `new.flock.*` sub-authorities may point to the same Flock lexicon-authority DID.)*

### Running the pre-launch check

```sh
PLC_URL=https://plc.directory corepack pnpm verify:lexicons
```

`verify-public-lexicons.mjs` resolves each `_lexicon.*` TXT record with a bounded `10 s` DNS timeout, resolves the authority DID's `#atproto_pds` HTTPS endpoint via `PLC_URL` or `did:web` using `@flock/net/safe-fetch` (`boundedSafeFetch`: `10 s` deadline, `256 KiB` cap, `redirect: "error"`, private-address SSRF block, and strict DID-document `id === authorityDid` + `AtprotoPersonalDataServer` service binding), fetches every `com.atproto.lexicon.schema` record by NSID, and compares its canonicalized JSON (`lexicon`, `id`, `revision`, `description`, `defs`) byte-for-byte against `packages/protocol/lexicons/`. Any DNS timeout, missing/ambiguous TXT record, DID mismatch, HTTP error, or schema drift prints every failing NSID and exits `1`.

---

## Key custody & rotation

### 1. Group Host keys (`GROUP_HOST_ENCRYPTION_KEY` & `GROUP_HOST_SERVICE_PRIVATE_JWKS`)

- **`GROUP_HOST_ENCRYPTION_KEY` (required 64-char hex / 32 bytes, `openssl rand -hex 32`):**
  - Validated at startup (`apps/group-host/src/crypto-box.ts`). Derives HKDF-SHA256 subkeys for:
    - `"flock-group-host-aead-v1"` — AES-256-GCM (`v1.<iv>.<tag>.<ciphertext>`) with context-bound AAD `utf8("${table}\0${rowKey}\0${column}\0v1")` encrypting per-group `signing_key_enc` (`#atproto`), `kem_key_enc` (`#atproto_kem`), and `rotation_key_enc` (in `group_account` and `group_creation_journal`), `group_action_token.claim_ciphertext_enc`, `source_migration_lease.ticket_secret_enc`, and `upstream_oauth_state`.
    - `"flock-group-host-cookie-v1"` & `"flock-group-host-dpop-nonce-v1"` — HMAC keys for per-flow `/oauth/upstream-callback` & `/oauth/confirm-action` CSRF cookies and rolling DPoP nonces.
    - `"flock-group-host-service-signing-key-v1"` — default deterministic P-256 `Multikey` (`groupHostServiceDid#atproto`) when `GROUP_HOST_SERVICE_PRIVATE_JWKS` is unset.
  - **Custody warning:** Keep `GROUP_HOST_ENCRYPTION_KEY` in a hardened secret store backed up separately from `./data/group-host.db`. Losing `GROUP_HOST_ENCRYPTION_KEY` makes hosted group private keys undecryptable (recoverable only for groups that also registered external sovereign PLC `rotationKeys`).

- **Zero-downtime service signing key rotation (`GROUP_HOST_SERVICE_PRIVATE_JWKS`):**
  - When `GROUP_HOST_SERVICE_PRIVATE_JWKS` (`{"keys":[...]}` of ES256 P-256 private JWKs with unique `[a-zA-Z0-9_-]{1,64}` `kid`s, newest first) is configured, Group Host signs service JWTs (`capabilityProofJwt`, `migration_session` JWTs, peer migration service JWTs) and confidential upstream OAuth `private_key_jwt` assertions with **`keys[0]`** (`kid: "${groupHostServiceDid}#atproto-${keys[0].kid}"`), while publishing `keys[0]` as `#atproto` **plus every `k ∈ keys` as `#atproto-${k.kid}`** in `/.well-known/did.json` and all public JWKs in `/oauth/jwks.json`.
  - **Overlap rotation procedure:**
    1. Generate a new ES256 private JWK:
       ```sh
       corepack pnpm authority generate-key gh-2026-11
       ```
    2. **Stage overlap:** Append the new JWK **after** the currently active key in `GROUP_HOST_SERVICE_PRIVATE_JWKS='{"keys":[<activeJwk>,<newJwk>]}'` and restart `apps/group-host`. Wait at least **10 minutes** so remote PDS JWKS caches (`5 min`) and peer Group Host DID caches see `#atproto-gh-2026-11`. *(If transitioning from the default derived key for the first time, stage `[<initialJwk>]` during a brief maintenance window or before external peers cache `#atproto`, then use standard 2-key overlap for all subsequent rotations.)*
    3. **Promote:** Move `<newJwk>` to index `0` (`{"keys":[<newJwk>,<oldJwk>]}`) and restart `apps/group-host`. All new tokens and assertions now sign with `#atproto-gh-2026-11` while `#atproto-<old.kid>` remains verifiable.
    4. **Retire:** Wait at least **2 hours** (covering `10 min` upstream OAuth states, `60 s` peer service JWTs, and `2 h` `migration_session` refresh deadlines), then remove `<oldJwk>` from `GROUP_HOST_SERVICE_PRIVATE_JWKS`.

### 2. Operator keys & shared Group-DID OAuth grants (`AUTH_ENCRYPTION_KEY` & `AUTHORITY_CLIENT_PRIVATE_JWKS`)

- **Shared Group-DID session (`authority_grant`):** Operator holds one shared Group-DID OAuth session per workspace `<groupDid>` (authorized at `prompt=create` via `/authority/start` → Group Host `/oauth/authorize` → personal PDS sign-in → `/oauth/callback`, and reauthorizable by **any live effective human admin** via their own personal PDS—no shared account password ever exists!).
- **`AUTHORITY_CLIENT_PRIVATE_JWKS` rotation:** Generate a new ES256 JWK with `corepack pnpm authority generate-key <kid>`, stage it **second** in `AUTHORITY_CLIENT_PRIVATE_JWKS` for at least **10 minutes** (`/authority/jwks.json` cache window), then move it **first** so new group authorizations bind to it. Remove an older key only after groups authorized under it have reauthorized or been revoked (`corepack pnpm authority revoke <groupDid>`).
- **Quarantined `sessionStore` & suspension circuit breaker:** `authority_grant` never deletes canonical SQLite rows on transient failures (`15 s` suspension circuit breaker on `RepoTakendown` / `RepoDeactivated`). If the admin who authorized Operator's shared session is demoted or removed from the group, Group Host immediately narrows/refuses that session (`403`), surfacing an inline reauthorization prompt for any remaining active admin.
- **Demoted-actor operation recovery (`OPERATION_TAKEOVER_MIGRATION = 4`):** Operator's SQLite `operation` table upgrades automatically on startup to support `state = 'aborted_actor_revoked'` and `taken_over_by`. If an operation's original `actor` (`ownerDid`) loses admin rights before completion:
  - `0` completed steps → automatically marked `aborted_actor_revoked` (`operationAbortedActorRevoked`) so the workspace never wedges.
  - `>= 1` completed steps → any live effective human admin holding `assignable` coverage over the operation's targets can resume it to completion (`taken_over_by = executorActor.did`, audited via `operationAdminTakeover`).

---

## Online database backup & isolated restore drills

Both Operator (`DATABASE_PATH`, default `./data/flock.db`) and Group Host (`GROUP_HOST_DATABASE_PATH`, default `./data/group-host.db`) run SQLite in WAL mode. `scripts/backup-db.mjs` opens and pins the destination's parent directory once via `O_RDONLY | O_DIRECTORY | O_NOFOLLOW` (`dirFd`) before touching SQLite (rejecting symlinked parent directories with `ELOOP` and failing fast via `fstatat(dirFd, destBase, AT_SYMLINK_NOFOLLOW)` with `EEXIST` if the destination entry already exists), pre-creates a private `0o700` staging directory + empty `0o600` `O_CREAT | O_EXCL | O_RDWR | O_NOFOLLOW` staging inode strictly relative to `dirFd` while pinning a surviving `O_RDWR | O_NOFOLLOW` staging descriptor in the parent Node process before a single SQLite byte is copied, streams pages online via `better-sqlite3`'s `db.backup(..., { progress })` inside an `fchdir(stageDirFd)` worker in a dedicated process group (verifying on `progress(#1)` before any page transfer that `sqlite3_open_v2` opened the exact pre-staged `(dev, ino)` with `nlink === 1`), `fchmod(0o600)`s and `fsync`s the staged descriptor, atomically publishes via non-replacing `renameatx_np(..., RENAME_EXCL)` (macOS) / `renameat2(..., RENAME_NOREPLACE)` (Linux), removes the empty staging directory via `AT_REMOVEDIR` (`rmdir`), and checks `fsync(dirFd)`—while on any failure or abrupt helper death first terminating and reaping the entire worker process group (`ESRCH`) so no orphaned SQLite writer remains open, and then directly wiping the parent-held staging descriptor to `0` bytes via `ftruncateSync(parentStageFd, 0)` + `fsyncSync(parentStageFd)` without ever calling `unlink` on directory entries (so concurrent bystander files are never deleted or clobbered).

> **Runtime requirement (`python3` / `PYTHON3`):** Because Node's `node:fs` does not expose `dir_fd`-relative POSIX syscalls (`openat`, `fstatat`, `fchdir`, `renameatx_np` / `renameat2`, `unlinkat(..., AT_REMOVEDIR)`), `scripts/backup-db.mjs` invokes `python3` (configurable via optional `PYTHON3` environment variable, defaulting to `python3`, and failing closed if absent) with the pinned parent directory descriptor inherited on `fd 3`. Ensure `python3` is installed on any host or container image running `pnpm backup:db` or `pnpm backup:group-host`.

### Online backup commands

```sh
# 1. Back up Operator SQLite database (reads DATABASE_PATH; optional PYTHON3=/path/to/python3)
corepack pnpm backup:db /secure/backups/flock-operator-$(date -u +%Y%m%dT%H%M%SZ).db

# 2. Back up Group Host SQLite database (reads GROUP_HOST_DATABASE_PATH via --group-host; optional PYTHON3=/path/to/python3)
corepack pnpm backup:group-host /secure/backups/group-host-$(date -u +%Y%m%dT%H%M%SZ).db
```

Store `AUTH_ENCRYPTION_KEY`, `AUTHORITY_CLIENT_PRIVATE_JWKS`, `GROUP_HOST_ENCRYPTION_KEY`, and `GROUP_HOST_SERVICE_PRIVATE_JWKS` in a separate encrypted secret store with access controls at least as strict as the database backups.

### Periodic isolated restore drill (Operator + Group Host)

Never test a restore over live `./data/flock.db` or `./data/group-host.db`. Verify backups regularly in an isolated directory and loopback port pair:

1. Copy the Operator and Group Host backup files to `/tmp/drill/flock.db` and `/tmp/drill/group-host.db` (`chmod 600`).
2. Run SQLite integrity checks against both copies:
   ```sh
   sqlite3 /tmp/drill/flock.db "PRAGMA integrity_check;"
   sqlite3 /tmp/drill/group-host.db "PRAGMA integrity_check;"
   ```
3. Start an isolated Group Host instance against `/tmp/drill/group-host.db` with the matching `GROUP_HOST_ENCRYPTION_KEY` (and isolated `GROUP_HOST_URL=http://127.0.0.1:13004` under `NODE_ENV=development`—or `ATPROTO_ACCEPTANCE_TEST=true` when `NODE_ENV=production`—with `ALLOW_LOOPBACK` unset/`true` and outbound network egress blocked so outbox sweeps do not re-deliver historical notices to live peers) and verify:
   - `GET /xrpc/com.atproto.server.describeServer` and `GET /.well-known/did.json` respond `200`.
   - `GET /xrpc/com.atproto.sync.getRepo?did=<groupDid>` streams a valid CAR repository, `com.atproto.space.listSpaces` enumerates expected group spaces, blobs resolve from `blob_store`, and key decryption (`signing_key_enc`, `kem_key_enc`, `rotation_key_enc`) succeeds cleanly.
4. Start an isolated Operator instance against `/tmp/drill/flock.db` with matching `AUTH_ENCRYPTION_KEY` and verify `listStalledOperations` / `getOperation` and `authority_grant` decryption.
5. Delete `/tmp/drill` once verified.

### Production disaster recovery

1. Set `FLOCK_ADMIN_MUTATIONS_PAUSED=true` on Operator and stop `apps/operator` and `apps/group-host`.
2. Restore the selected `group-host.db` and `flock.db` backups (`0o600`) alongside their matching encryption keys.
3. **Critical PLC consistency check for Group Host restores:** Before reopening traffic, check `PLC_URL` (`/${groupDid}/log/last`) for any group hosted on the restored DB that may have completed a host migration or PLC tombstone *after* the backup timestamp:
   - Group Host's deletion and finalize paths check live `PLC_URL` (`plc_outcome = 'migrated_remote'` / `'tombstoned_or_absent'`) so a restored source host will not overwrite a migrated target host's PLC state, and `POST /group-admin/finalize-migrated-source` cleanly deactivates stale source state once PLC points at the new host.
4. Start `apps/group-host` and `apps/operator`, confirm health checks and `notify` renewals succeed, clear `FLOCK_ADMIN_MUTATIONS_PAUSED`, and resume normal traffic.

---

## Group lifecycle, moderation & two-GroupHost migration operations

### Pause switch & stalled operations

- Set `FLOCK_ADMIN_MUTATIONS_PAUSED=true` on `apps/operator` to pause administrative mutations (`createWorkspace`, `execute`, background operation recovery, and registration sweeps) while keeping direct space reads, message writes, DMs, `getOperation`, and `listStalledOperations` available.
- Monitor `new.flock.operator.listStalledOperations` (operations pending `>= 5 minutes`) and Operator `stderr` (`WARN notice registration` / `503 UpstreamUnavailable`). Never hand-edit `operation` rows in SQLite; retry with the same `operationId` or let an active effective human admin complete a demoted actor's partial operation (`operationAdminTakeover`).

### Deactivation, sole-member leave, reactivation & sovereign `rotationKeys` custody

- **Administrative deactivation (`com.atproto.server.deactivateAccount`):** Requires active Group-DID DPoP OAuth by a lifecycle admin (`isAuthorizedLifecycleAdmin` + `account:status?action=manage`); increments `auth_epoch`, revokes all OAuth sessions and unexpired space credentials (`100`-credential-batched `notifyCredentialsRevoked` `credentials` arrays), and sets `activated = 0` without deleting spaces.
- **Sole-human-member `leaveGroup`:**
  - On **Flock workspaces** (`new.flock.workspace/self` present), when the sole remaining human member calls `leaveGroup`, Group Host snapshots `group_recovery_admin` (`recovery_did`, `roles_json`) and reversibly deactivates the group (`activated = 0`).
  - On **non-Flock OpenSocial groups** (`new.flock.workspace/self` absent), if an external sovereign key is present in PLC `rotationKeys`, sole-member `leaveGroup` keeps `activated = 1` under external PLC governance (`400 NoSovereignCustodyKey` otherwise).
- **Reactivation & recovery (`session_kind = 'recovery'`):** While `activated === 0`, `recovery_did` (or any staged lifecycle admin, or an external PLC rotation key via `POST /group-admin/controller-session`) authenticates with `prompt=login` (`login_hint = groupDid`) to obtain a restricted `recovery` DPoP session allowing `checkAccountStatus`, `activateAccount` (driven end-to-end by `WorkspaceClient.reactivateGroup`'s 4-phase journal), `exportSpaceMeta`, `sync.{getRepo,listBlobs,getBlob}`, and `requestAccountDelete` / `claim-action-token(delete_account)` / `deleteAccount`.

### Pre-tombstone zero-residue `deleteAccount`

Group deletion runs a crash-safe 4-state machine (`group_deletion_journal`, resumed automatically on `apps/group-host` startup):
1. Fresh `prompt=login` (`<= 5 min`) → `com.atproto.server.requestAccountDelete` → `POST /group-admin/claim-action-token` (`purpose: "delete_account"`, single-claim encrypted token) → `com.atproto.server.deleteAccount`.
2. `remote_cleanup_queued` → `remote_cleanup_drained`: While `<groupDid>`'s PLC DID is **still live** (so remote PDSes can verify `<groupDid>#atproto` service JWTs), Group Host drains `#spaceDeleted` notices, `<= 100`-credential `notifyCredentialsRevoked` (`credentials`) batches, and empty cleared-commit `notifyRepoUpdate` notices across every historical `group_invite_target`.
3. `plc_tombstoned`: Submits signed `plc_tombstone` to `PLC_URL` (retrying only on HTTP `409` stale-`prev` conflicts or network timeouts; recording `'migrated_remote'` or `'authority_lost_local_purge'` safely if PLC already moved).
4. `purged`: Deletes all rows for `<groupDid>` across all **`39` `GROUP_PURGED_TABLES`**, leaving only the minimal tombstone row in `group_deletion_journal`.

### Two-GroupHost migration (`Standard` & `Coordinated v1`)

`apps/group-host` (`src/migration.ts`) and `GroupClient` support moving a live `<groupDid>` between Group Hosts without changing its DID or space URIs:

- **Target capability & key provenance guardrails:**
  - Outbound migration (`prepare-migration`, `getServiceAuth(createAccount)`, `signPlcOperation`) verifies via `verifyOpenSocialTargetCapability` that the target advertises `group.opensocial.policy` support (either signed `/group-admin/migration-info` `capabilityProofJwt` or `#opensocial_group` in the target's `did:web` document), rejecting ordinary personal PDSes with `400 UnsupportedGroupHostTarget`.
  - Inbound `com.atproto.server.createAccount` supports: (a) **Coordinated v1** (`X-Group-Migration-Ticket`: `83`-byte `"v1.<uuid>.<secret>"` + `/group-admin/migration-manifest` JCS snapshot), (b) **Standard mode** (`GET /group-admin/public-group-keys` `#atproto`-signed `proofJwt` across `1..5` PLC `rotationKeys`, or zero-extension 1-key OpenSocial sources), and (c) **Provenance-Assisted Multi-Key Standard mode** (`X-Group-Migration-Key-Provenance` JWS signed by an external sovereign `rotationKeys` entry when migrating from a non-Flock multi-key source without `public-group-keys`).
  - Across all modes, Group Host enforces `100 MiB` stream caps (`migrationBlobUploadLimit`, `maxRepoImportSize`, `maxSpaceMetaImportSize`), rejects retaining the retiring source host's rotation key (`400 SourceRotationKeyRetained`), preserves all external sovereign `rotationKeys` (`400 SovereignRotationKeyDropped`), verifies staged OpenSocial/Flock integrity before `submitPlcOperation` and `activateAccount`, and automatically calls `POST /group-admin/finalize-migrated-source` on the old host after activation. Before PLC cutover, `POST /group-admin/abort-migration` cleanly aborts and purges staged state. Private join queues, moderation history, and OAuth sessions intentionally do not migrate across hosts.

---

## Apps (`echo-bot` and `webhooks`)

Installed apps are non-roster service principals (`new.flock.app.install` in `new.flock.workspace/self`, tracked permanently in Group Host's `known_app_subject` ledger with role `appRoleKey(appDid)`). A workspace supports up to `20` active apps alongside `200` human members. `uninstallApp` removes policy grants first, deletes `membership/<appDid>`, deletes `role/<appRoleKey>`, and finally sets `app.install.active = false` (`RoleInUse`-safe).

- **Echo Bot (`apps/echo-bot`, `:3002`):** `corepack pnpm echo-bot sign-in <handle>` once, set `ECHO_BOT_DID` and `ECHO_BOT_WORKSPACES` (comma-separated `at://<groupDid>/space/new.flock.workspace/self` URIs), and run `corepack pnpm echo-bot run` (`ECHO_BOT_PRIVATE_JWKS` required on HTTPS; `ECHO_BOT_STATE_FILE` created `0o600`).
- **Incoming Webhooks (`apps/webhooks`, `:3003`):** `corepack pnpm webhooks sign-in <handle>` once, set `WEBHOOKS_DID` and `WEBHOOKS_WORKSPACES`, and run `corepack pnpm webhooks run` (`WEBHOOKS_PRIVATE_JWKS` on HTTPS; `WEBHOOKS_TRUST_PROXY=true` only behind a trusted reverse proxy). Serves `/admin` (identity-only OAuth verifying live group admin/private-channel access) and `POST /hooks/<id>/<secret>`. Both bots enforce `!takedown` label filtering via `@flock/protocol/moderation`.

---

## Direct messages & personal invite wakes: what Operator can and cannot see

- **Zero DM rows in SQLite (Operator & Group Host):** DMs (`new.flock.dm.*`) live exclusively on participants' personal PDSes (`com.atproto.memberspace.policy`). Neither Group Host nor Operator holds DM scopes or writes any DM rows to SQLite.
- **Stateless `dm1` (DMs) vs `inv1` (`invites/self`) webhook tokens:**
  - `new.flock.operator.getDmNotifyTarget` verifies a caller-held DM `SpaceCredential` + RFC 9421 PoP (`pop:<hmac>` TTL replay lock) and issues a 30-min-epoch `dm1` HMAC token (`hkdf("flock-dm-notify-v1")`) feeding Operator's in-memory `dm-feed-wakes.ts` ring (shared across local workers over a `0o600` Unix socket hub; returns HTTP `400` on `#registrationExpired` so PDSes drop closed tabs immediately).
  - `new.flock.operator.getSpaceNotifyTarget` identically verifies a caller-held `SpaceCredential` + RFC 9421 PoP strictly for `at://<callerDid>/space/group.opensocial.invites/self` and issues a 30-min-epoch `inv1` HMAC token (`hkdf("flock-invite-notify-v1")`) waking `getChanges` on inbound cross-PDS group invitations.
- **Residual metadata:** Live Operator memory (`dm-feed-wakes.ts`) and HTTP access logs can observe timing/URI metadata for watched spaces, never message, reaction, or invite record bodies. Both `DmClient` and `WorkspaceClient` remain fully functional via direct PDS polling if Operator push wakes are unavailable.

---

## Production pre-launch & pilot checklist

| Gate | Required evidence before opening to public users |
|---|---|
| **1. Public Lexicon DNS + XRPC** | All 9 `_lexicon.opensocial.group` & `_lexicon.*.flock.new` DNS TXT records + `63` `com.atproto.lexicon.schema` records published; `corepack pnpm verify:lexicons` exits `0`. |
| **2. Pinned protocol & expiry** | `ATPROTO_PIN_CHECKOUT` passes `scripts/verify-pinned-checkout.mjs`; deployed personal PDSes include `strict-credential-expiry.patch` (or upstream zero-skew fix); `pnpm test`, `pnpm test:acceptance`, `pnpm test:browser`, and `pnpm test:bdd` pass. |
| **3. HTTPS origins & DID docs** | `APP_URL`, `GROUP_HOST_URL` (`/.well-known/did.json` `#atproto_pds` + `#opensocial_group`), and `OPERATOR_URL` (`/.well-known/did.json` `OPERATOR_SERVICE_REF`) live over public HTTPS with egress firewall blocking private/metadata ranges. |
| **4. Secrets & JWKS** | `GROUP_HOST_ENCRYPTION_KEY`, `GROUP_HOST_SERVICE_PRIVATE_JWKS`, `AUTH_ENCRYPTION_KEY`, and `AUTHORITY_CLIENT_PRIVATE_JWKS` provisioned in secret manager outside repo/DB paths. |
| **5. Backups & restore drill** | Scheduled `pnpm backup:db` and `pnpm backup:group-host` writing `0o600` snapshots to encrypted off-host storage + verified isolated restore drill for both databases. |
| **6. Pause & alerting** | `FLOCK_ADMIN_MUTATIONS_PAUSED=true` drill verified; Operator & Group Host `stderr` and `listStalledOperations` wired to on-call alerting. |
