# Implementation plan

Historical baseline: `docs/prd/atproto-slack-implementation-plan.md` (M0–M6, R6–R12). R13 architectural upgrade: `.ai/plans/r13-opensocial-groups.md` (`feat/r13-opensocial-groups`). Detailed verification logs live in `PROGRESS.md`.

| Milestone / Release | Status | Exit evidence |
|---|---|---|
| M0–M6 Core Slack & Sovereign DMs | Complete (local/CI) | Personal-PDS spaces, sovereign DMs (`new.flock.dm.*`), browser-only OAuth, independent readers, and 200-member / 100-participant envelopes verified |
| R8–R12 Apps, Webhooks, Verified Sync, Tasks & `6747610566` Pin | Complete | Separate-origin Operator, `echo-bot` & `webhooks`, STAR/oplog LtHash verification, causal-DAG Tasks (`new.flock.ext.tasks`), `dm1` PoP wakes, and `6747610566` re-pin |
| R13 Wave 1 — Pin Verifier, `135`-Lexicon Closure & Protocol Core | Complete | `verify-pinned-checkout.mjs` (`19,163` dist digests), `27` `group.opensocial.*` + `72` `com.atproto.*` + `36` `new.flock.*` lexicons, `effectiveMemberPermissions`, `moderation.ts`, `migration-manifest.ts`, bilateral `WorkspaceSummary` |
| R13 Wave 2 — `boundedSafeFetch`, `apps/group-host` (`42` Tables) & `FakeNetwork` Parity | Complete | Reference `opensocial.group` Group Host (`:3004`), two-sided OAuth 2.1 AS (`prompt=create`, `/oauth/confirm-action`, `recovery`, `controller-session`), flat RBAC, join/mod XRPCs, 4-state `deleteAccount`, Standard & Coordinated v1 migration, `group-host-parity.test.ts` |
| R13 Wave 3 — `AppConfig.groupHostUrl`, Operator Migration & ESLint Hard-Cut | Complete | `OPERATION_TAKEOVER_MIGRATION = 4` (`aborted_actor_revoked` + `taken_over_by` `operationAdminTakeover`), `decideGroupJoinRequest` (`If-Join-Request-Present`), `getSpaceNotifyTarget` (`inv1`), `no-legacy-memberspace` ESLint rule; retired `reconcile-workspaces.ts` |
| R13 Wave 4 — `@flock/client`, `GroupClient`, Lifecycle Journals, Reader & Bots | Complete | `ensureInvitesSpace()`, 3-phase `leavingGroups`, 5-phase `joiningGroups`, 4-phase `reactivatingGroups`, tombstone-aware invite pruning, and latest-`cts` `!takedown`/`!hide` projection across client, reader, echo-bot, and webhooks |
| R13 Wave 5 — Dual Browser Group OAuth & Governance/Moderation UI | Complete | `GroupBrowserOAuthClient` (`flock-group-oauth:<did>`), `group-governance-panel.tsx`, `moderation-panel.tsx`, `report-subject-modal.tsx`, `invite-banner.tsx`, step-up claim & reactivation flows |
| R13 Wave 6 — Operations Tooling, Conformance/Acceptance/BDD Gates & Docs | Complete (local/CI); public DNS & live pilot pending | `backup-db.mjs --group-host` (`pnpm backup:group-host`), `verify-public-lexicons.mjs` (`pnpm verify:lexicons`), zero-exclusion `suite-manifest.test.ts`, `opensocial-groups.{test,spec}.ts`, in-place `protocol-tests/atproto/*.test.ts`, and full R13 documentation sweep |

## Remaining pre-launch production gates

Local build, unit, parity, multi-PDS/multi-Group-Host acceptance, browser Playwright, sync-budget, performance, and BDD suites do not substitute for production launch gates:
1. Publish live `_lexicon.opensocial.group` and `_lexicon.*.flock.new` DNS TXT + `com.atproto.lexicon.schema` records and verify `pnpm verify:lexicons` exits `0` (`docs/operations.md`).
2. Deploy `apps/web`, `apps/group-host`, and `apps/operator` on public HTTPS origins with `strict-credential-expiry.patch` (or upstream equivalent), production secrets/JWKS, scheduled Operator + Group Host backups/restore drills, and pilot acceptance.
