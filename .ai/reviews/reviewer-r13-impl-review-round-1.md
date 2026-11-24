# Adversarial Implementation Review — R13 OpenSocial Groups (`feat/r13-opensocial-groups`, Round 1 — Independent Reviewer Subagent)

Reviewed `/Users/mikestaub/code/peapods/bluesky/atproto-spaces/atproto-slack-clone-r13-opensocial` (read-only) against `.ai/plans/r13-opensocial-groups.md` (Rev 29) and `opensocial.group/proposal` (`8df0cc82eb7708f090aa43522adf1d3ada3ed7e7`).

## Findings Summary
1. **BLOCKER:** `abortMigrationOnTarget` (`apps/group-host/src/migration.ts:1201-1266`) cross-endpoint `#atproto` JWT confusion with unauthenticated `GET /group-admin/public-group-keys` (`aud`, `lxm`/`purpose`, `iat`/`exp`, `service_jwt_jti` replay, coordinated `operationId`+`ticketId`, and `reapExpiredPreparedMigrationLease` `target_service_did`).
2. **BLOCKER:** `assertPolicyWriteAntiEscalation` & `assertRoleWriteAntiEscalation` (`apps/group-host/src/rbac.ts:450-507`, `apps/group-host/src/repo-store.ts:1852-1855`, `packages/testing/src/fake-group-host.ts:446-477`) missing `assignable` diff on policy grants & role writes/deletes, `read`/`write` access anti-escalation on policy updates, and role self-`assignable` check (`proposal.md:102`).
3. **HIGH:** Account-level `!takedown` and `!hide` labels (`members/self`) in `ChannelClient`, `AppInboxClient`, `AppRuntime`/`EchoBot`, `WorkspaceClient.summary()`, `WorkspaceHome`, `useChannelContent`, and `readIndependentWorkspace`.
4. **HIGH:** TOCTOU live role narrowing & `putRecord` `create`/`update` action checks inside `withGroupRepoLock` / `tx.immediate()` (`apps/group-host/src/server.ts`, `repo-store.ts`).
5. **HIGH:** `GROUP_HOST_PORT` env handling and non-loopback `0.0.0.0` / IPv6 `[::1]` bind address in `apps/group-host/src/{config,server}.ts`.
6. **MEDIUM:** `GroupGovernancePanel` reading `publicMeta` from `meta/self` `policy/self` + `declaration/self` instead of defaulting to `true` on save; Operator `createWorkspace` forwarding `publicMeta` & journaling `joinPolicy`.
7. **MEDIUM:** Out-of-window permalink lookup (`workspace-manager.tsx:307-313`) preserving `hidden`, `labels`, and `cid`; `report-subject-modal.tsx:10` using OpenSocial `"nsfw"` instead of `"sexual"`.
8. **MEDIUM:** Strict Lexicon parameter & input validation (`limit` `1..100` bounds, `maxLength`/`maxGraphemes`, string type checks) on `apps/group-host` `/xrpc/group.opensocial.*` handlers.
9. **MEDIUM:** Reaping expired un-cutover `migration_session` rows in `pruneExpiredHostState`, `activated === 1` check on `resolveHandle`, `try/catch` `abortMigration` in `GroupAdminClient.migrateToHost`, and per-flow `gh_consent_<hash>` cookie name.
10. **LOW:** `verifyDpopProof` `maxTokenAge: 10` (`apps/group-host/src/oauth.ts:436`).

VERDICT: CHANGES_REQUIRED
