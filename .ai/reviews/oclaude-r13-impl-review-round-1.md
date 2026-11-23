I have completed a read-only, adversarial audit across the listed packages, including the security-critical Group Host OAuth/DPoP/RBAC paths, client crash-recovery journals, Operator takeover, vendored lexicons/codegen, and the test/manifest wiring. Below are the findings with exact evidence.

## Findings

### 1. BLOCKING — Policy updates skip two mandated anti-escalation checks (`read`/`write` and `assignable`-role coverage)

`assertPolicyWriteAntiEscalation` only checks `grant.scopes`:

- `apps/group-host/src/rbac.ts:485-507` — iterates `policy.grants`, and for each grant with `scopes` it calls `expandedPolicyGrantScopes`/`isPermissionSubset`. It never inspects `grant.read`/`grant.write`, nor whether the role whose grant changes is within the actor's `assignable` union.
- Invoked at `apps/group-host/src/repo-store.ts:1497-1504` for both `createSpace` and `updateSpace`, with `actorDid = session.authorizingUserDid` (e.g., `apps/group-host/src/server.ts:1342-1366`, `1358`).
- Space access is driven by exactly those booleans: `apps/group-host/src/rbac.ts:265-279` (`liveRoleGrantsRead`) and `:281-294` (`liveRoleGrantsWrite`), and writer-set reconciliation is in `repo-store.ts:1639`/`:2205`.

The upstream spec requires both checks on a policy update:
- `/Users/mikestaub/.gemini/antigravity-cli/brain/5c01d4ea-d701-4209-9ea2-ba5e390aac54/scratch/opensocial-proposal/proposal.md:102` — “*In a role write or a policy update, the user may change grants only for roles in their `assignable` union … Any `read` or `write` access they grant on a space must already be theirs on that space.*”
- Approved plan §1.2.2 (`...enforces `assignable` and scope/access anti-escalation on every write`) and §4.1 item 4 (policy write anti-escalation in `rbac.ts`).

Concrete escalation: a role holding `manage=update` on space S (a real grant type—`expandPolicyGrantScopes` permits `manage=update`, only rejecting `manage=create` at `packages/protocol/src/scopes.ts:352-356`; the default `admin` and any custom role can carry it) but lacking `read`/`write` on S can `updateSpace` with a policy adding `{ role: "their-role", read: true, write: true }`. `assertSpace(..., { manage: "update" })` passes (`server.ts:1358`), `assertPolicyWriteAntiEscalation` sees no `scopes` and passes, and `reconcileAllSpaceWritersSync` then adds the role's holders to the private space's writer set. This is precisely the self-grant the spec forbids. The same gap lets the actor change grants for roles outside their `assignable` union.

Tests do not cover this: anti-escalation coverage only exercises role/membership writes (`packages/testing/src/group-host-parity.test.ts:499-530`, `protocol-tests/opensocial-groups.test.ts:1167-1210`), not policy `read`/`write` or policy role `assignable` constraints.

### 2. NON-BLOCKING (plan deviation) — DPoP `maxTokenAge` is 60s, not the plan’s 10s

`apps/group-host/src/oauth.ts:433-438` verifies DPoP proofs with `maxTokenAge: 60, clockTolerance: 180`; the approved plan §3.2 item 4 specifies `maxTokenAge: 10`. Replay is still blocked by the single-use `jti` row (`oauth.ts:530-549`) and rolling nonce (`crypto-box.ts:231-252`), so this widens the acceptance window rather than enabling replay; it is a real deviation but not independently exploitable.

### 3. MINOR (spec edge) — role self-assignable exemption

`apps/group-host/src/rbac.ts:459-471` exempts `targetRole === roleRkey` when validating `role.assignable`, allowing a holder of role `X` to add `X` to its own `assignable` list even when `X` is not in the actor’s own assignable union. `proposal.md:102` says “Any role they add to an `assignable` list must already be in their own `assignable` union.” Lower impact than #1, but it is the same class of under-enforcement.

## Areas I checked and found consistent

- Vendored lexicons byte-identical to upstream (`diff -rq` clean); 99-file manifest and route-schema manifest are real (`packages/protocol/src/opensocial-lexicons.test.ts:332-379`).
- Pin verifier is fail-closed and digests match (`scripts/verify-pinned-checkout.mjs:7-27,108-189`; patch SHA `3f413baa…` verified).
- `boundedSafeFetch` enforces deadline, pre-body MIME/content-length checks, streaming byte cap, and DNS pinning (`packages/net/src/safe-fetch.ts:117-301`).
- Full DPoP verifier, PAR/PKCE S256, endpoint-scoped PKCE absence on refresh/revoke, `ath`/nonce, single-use JTIs, `auth_epoch` invalidation, family cascade, and per-callback isolated upstream session store with `signOut()` (`apps/group-host/src/oauth.ts:411-552,1314-1390,2558-2934`).
- Group-DID live narrowing, `effectiveMemberPermissions` union, `assignable` diff checks on membership writes, `CannotTargetGroupSelf`, `LastAdmin`, app-principal invariants, and core-space protection (`apps/group-host/src/rbac.ts:123-638`, `repo-store.ts:1743-2230,2644-3010`).
- `requestJoin` 6-case table, non-evicting 200-row quota, invite redemption, `If-Join-Request-Present` single-transaction approval, `leaveGroup` incarnation CAS and sole-member reversible deactivation (`apps/group-host/src/methods.ts:256-1091`).
- Moderation: createReport space/writer checks, label same-space/non-empty enforcement, deterministic pagination/tie-breakers (`apps/group-host/src/moderation.ts`, `packages/protocol/src/registry.ts:808-855`).
- Client 3-phase leave / 5-phase join / 4-phase reactivation journals and `ensureInvitesSpace` (`packages/client/src/workspace-client.ts:274-350,627-1201,1253-1452`); browser Group OAuth uses base `OAuthClient` + isolated `flock-group-oauth:<did>` DB (`apps/web/src/browser/group-session.ts`).
- Operator `OPERATION_TAKEOVER_MIGRATION = 4`, 0-step abort vs audited `operationAdminTakeover`, and distinct `decideGroupJoinRequest` (`apps/operator/src/lib/db.ts:268-304`, `journal.ts:81-264`, `operations.ts:335-480`, `kinds/decide-group-join-request.ts`).
- Suite manifest partition and root scripts line up (`protocol-tests/suite-manifest.test.ts:65-151` vs `package.json`), and the acceptance/browser/atproto suites are wired.

VERDICT: CHANGES_REQUIRED
