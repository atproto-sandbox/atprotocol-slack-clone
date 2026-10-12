# Architecture

## Runtime boundaries

- **Browser client:** renders channels and records; uses the signed-in member's OAuth session for writes to their own repo and member-authorized space operations. It never stores the workspace authority session.
- **Next.js server:** hosts the application UI, OAuth callback/session integration, authenticated API routes, and the workspace authority operator. Browser input is treated as untrusted.
- **PDS spaces:** hold the durable interoperable workspace, inbox, channel, roster, request, decision, message, and reaction state. Their member lists enforce reads.
- **Operator journal:** SQLite persists operation identity, canonical request hash, target state, completed step markers, status, and audit events. It is not a membership or role source. Authority OAuth session material is encrypted at rest with AES-256-GCM using a deployment key.
- **Independent reader:** a separate package consumes only published lexicons and protocol clients; no imports from application database/cache code.

## Data flow

1. A member signs in through atproto OAuth. Their session and refresh state are stored separately from the authority session.
2. The app requests the narrow operation scopes declared in `src/auth/permission-sets.ts`.
3. For reads, the signed-in user exchanges a PDS delegation token for a DPoP-bound space credential. A reader syncs writers and their records from each selected space, validating author, schema, key, and same-channel references.
4. For admin actions, the client obtains a `com.atproto.server.getServiceAuth` JWT with the operator DID service ref as `aud` and the exact method NSID as `lxm`. The operator verifies all claims and re-reads current authority records and PDS member lists before acting.
5. The operator journals the desired state and applies resumable PDS membership and authority-record writes. It completes only after read-back reconciliation.
6. Inbox clients reconcile `listRepos` and owner-authorized `listInboxWriters` at least once per minute, then fetch candidate request records directly with their own inbox credential.

## Storage rules

- SQLite tables are limited to encrypted auth state, per-account sync cursors, app cache data, operation journal, and audit history.
- Never persist a locally authoritative member/admin ACL.
- Message/request ownership remains in the member's PDS repo. The operator never reads or proxies request bodies.
- On failure to renew a private space credential, stop sync and remove that account's cached private data.
- None of the rules above apply to DMs, because no DM state is ever written to SQLite; see "Direct-message runtime boundary" below.

## Protocol compatibility

The protocol adapter isolates the draft `com.atproto.simplespace.*` membership APIs and `com.atproto.space.*` record/credential APIs. The implementation is pinned to PDS commit `787a730fcd22ed7791e2636beb509a943017ba1c` and the exact lexicon hashes in `docs/protocol/atproto-spaces-pin.md`. Proposal 0016 is still draft; any pin drift blocks release until the conformance suite passes again.

## Direct-message runtime boundary

DMs are person-scoped, not workspace-owned, and no app-operated component can read, gate, lose, or hold hostage one (`.ai/plans/direct-messages.md` §1). This is a stricter boundary than channels, held entirely by process and import isolation, not by policy alone:

- **A second, browser-held OAuth session.** `src/dm/browser-session.ts` dynamically imports `@atproto/oauth-client-browser` (so it never reaches a server bundle — verified by grepping the built `.next/server` output; see PROGRESS.md) and constructs a public OAuth client (`token_endpoint_auth_method: "none"`) whose metadata (`src/dm/client-metadata.ts`, served at `src/app/oauth/dm-client-metadata.json/route.ts`) requests only `DM_BROWSER_SCOPES` (`src/auth/permission-sets.ts`). This session's DPoP keys are non-extractable WebCrypto keys and it is stored in the browser's IndexedDB, never on the server. `connectDms`/`restoreDmSession` revoke and reject any session whose DID does not match the signed-in server session, so one browser profile can never hold DM permissions for a different account. The existing Next.js server session keeps its own, unrelated scopes and never gains a DM scope (`src/auth/permission-sets.test.ts` asserts this for every server-side scope builder).
- **The isomorphic engine, `src/dm/dm-client.ts`.** `DmClient` is constructed with injected transports (`memberClient`, `resolvePds`, `fetchEndpoint`, `generateKey`, `store`) so the identical class runs in the browser (production) and in Node (unit tests, `protocol-tests/dm-acceptance.test.ts`, `protocol-tests/dm-performance.test.ts`) against a fake or the real pinned PDS. It shares `src/protocol/keys.ts`, `src/protocol/records.ts`, `src/atproto/dpop.ts`, `src/atproto/space-credential-core.ts`, `src/atproto/xrpc.ts`, and `src/atproto/record-pages.ts` with the server's channel code; an ESLint `no-restricted-imports` rule in `eslint.config.mjs` keeps this isomorphic layer (and all of `src/dm/**`) from importing `node:*`, `@/lib/db`, `@/lib/config`, `@/auth/*`, `@/operator/*`, `@/workspaces/*`, `@atproto/oauth-client-node`, `undici`, or `@/atproto/identity`.
- **No server routes, tables, or cache for DM content.** There is no `src/app/api/dm*` content route; an ESLint `no-restricted-imports` rule scoped to `src/app/api/**` additionally forbids importing anything from `src/dm/**`, so no API handler can even reach the engine. The only server involvement is `src/app/api/notifications/dm/route.ts`, a content-free Server-Sent-Events stream: it requires the existing server web session, accepts one DM space URI (validated with the strict `parseDmSpaceUri` from `src/protocol/keys.ts`; an inbox stream is limited to its owner by `authorizeDmSubscription` in `src/lib/dm-subscription.ts`), and returns only a monotonic cursor for that exact space. It never mints a space credential and never reads a DM record. The underlying `space_notification` table (shared with channel notifications) does retain the writer DID of each notified write, so an operator with direct database access has a bounded, timing-only social-graph signal for spaces with an active notify registration; see "Direct messages: what an operator can and cannot see" in `docs/operations.md` for the full, precise statement of that residual exposure.
- **Independent second-app parity, `src/reader/independent-dm.ts`.** A separate reader that reconstructs the same conversation (messages, reactions, per-half status) from the `org.slack.dm.*` lexicons alone, sharing only the protocol layer above and never importing `src/dm/**` (enforced by the same ESLint boundary, scoped to `src/reader/**`) or `src/dm/merge.ts` (it implements its own full-history merge). `protocol-tests/dm-acceptance.test.ts` asserts this reader and `DmClient.readConversation` return identical state for the 1:1 and group flows, including every per-half status (`ok`, `missing`, `deleted`, `revoked`).
- **Data flow for a DM read:** browser DM session → `mintSpaceCredentialWith` exchanges a delegation token (signed by the browser session) for a DPoP-bound space credential at each participant's own PDS → the engine reads and validates each half's header/messages/reactions directly from that PDS → a pure k-way merge (`src/dm/merge.ts`) combines halves into the latest-N page. No step touches this app's server.

```
        BROWSER (per user)                    NEXT.JS SERVER                          EACH PARTICIPANT'S PDS
  ┌───────────────────────────┐        ┌───────────────────────────┐          ┌───────────────────────────────┐
  │ workspace OAuth session    │──────▶│ app UI, workspace OAuth    │          │ org.slack.dm.inbox (self)      │
  │ (existing, unrelated       │        │ callback, operator,       │          │ org.slack.dm.conversation/<key>│
  │  scopes; untouched by DMs) │        │ SQLite (no DM tables)     │          │  header / message / reaction   │
  ├───────────────────────────┤        ├───────────────────────────┤          │  (member-list read/write,      │
  │ DM OAuth session (M3)      │        │ /api/notifications/dm     │◀ notify──│   open app access)             │
  │  - IndexedDB, non-extract- │        │  content-free SSE: cursor │          └───────────────────────────────┘
  │    able DPoP keys          │        │  only, no record reads    │                    ▲          ▲
  │  - DM_BROWSER_SCOPES only  │        └───────────────────────────┘                    │          │
  │ DmClient (src/dm/*)  ───────────── mint space credential, read/write records ─────────┘          │
  │ independent-dm reader ──────────── mint space credential, read records (parity check) ───────────┘
  └───────────────────────────┘
```
