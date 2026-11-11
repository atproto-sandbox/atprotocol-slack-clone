# Architecture

## Runtime boundaries

- **Browser client:** holds the member's one OAuth session (sign-in is the browser's own flow; `apps/web/src/browser/session.ts`), reads every space through the engine (`packages/client/src`) into the account's IndexedDB store, writes to the member's own repo, and calls the operator with service tokens. It never holds the workspace authority grant.
- **Next.js server:** serves the application UI and hosts the workspace authority operator (its XRPC methods, the authority flow and its callback). It holds no member session, no member token and no member record: it has no member routes, and the sign-in completes in the browser. Browser input is treated as untrusted.
- **PDS spaces:** hold the durable interoperable workspace, inbox, channel, roster, request, decision, message, and reaction state. Their member lists enforce reads.
- **Operator journal:** SQLite persists operation identity, canonical request hash, target state, completed step markers, status, and audit events. It is not a membership or role source. Authority OAuth session material is encrypted at rest with AES-256-GCM using a deployment key.
- **Independent reader:** a separate package consumes only published lexicons and protocol clients; no imports from application database/cache code.

## Data flow

1. A member signs in through atproto OAuth in the browser, with one grant (`memberGrantScopes` in `packages/protocol/src/scopes.ts`): every workspace, inbox and channel space the member lists admit them to, the collections a member writes, the operator's methods, and the DM set. The authorization code returns in the URL fragment and the tokens stay in the browser's IndexedDB. The workspace authority grant is separate: only the authority flow (`apps/operator/src/operator/authority-grant.ts`) writes it, and signing in or out never touches it.
2. For reads, the browser exchanges a PDS delegation token for a space credential bound to its own non-extractable signing key (ten minutes by default, one hour at most). Every request made with it carries an HTTP message signature over the credential and its audience. The engine syncs writers and their records from each selected space, validating author, schema, key, and same-channel references.
3. The browser follows its spaces through the operator's change feed and reads a space again when the feed names it.
4. For admin actions, the client obtains a `com.atproto.server.getServiceAuth` JWT with the operator DID service ref as `aud` and the exact method NSID as `lxm`. The operator verifies all claims and re-reads current authority records and PDS member lists before acting. The same kind of token, valid fifteen minutes and reused across polls, authenticates `new.flock.operator.getChanges`, the change feed a client without a cookie follows: it says only which followed spaces changed (each with its own cursor), which the caller may not follow (`denied`, decided from the space's member list read with the authority grant), and which to sync again (`reset`). The operator registers its own notice sink for every workspace, inbox and channel space it creates, and a sweep renews them.
5. The operator journals the desired state and applies resumable PDS membership and authority-record writes. It completes only after read-back reconciliation.
6. Inbox clients reconcile `listRepos` and owner-authorized `listInboxWriters` at least once per minute, then fetch candidate request records directly with their own inbox credential.

## Storage rules

- The server's SQLite tables are limited to the workspace authorities' encrypted grants and flow state, the operation journal, audit history, notice registrations and the content-free change notices. A database from before R6c drops the member session and cache tables and is rebuilt (`apps/operator/src/lib/db.ts`).
- Never persist a locally authoritative member/admin ACL.
- Message/request ownership remains in the member's PDS repo. The operator never reads or proxies request bodies.
- The account's copy of what it reads lives in its browser store (`packages/client/src/indexeddb-store.ts`), one store per account. When the authority refuses a private space credential (the account lost access) or reports the space deleted, stop sync and remove that account's cached copy of the space. A failure to renew for any other reason says nothing about the space and keeps the copy.
- The copy also goes when a writer's repo is permanently unreadable (deactivated, taken down, unauthenticated, or oversized), when the account signs out (its store is deleted), when another account starts in the same browser (a store another account left behind is deleted first), and at start-up for a space not opened for 30 days. A writer whose host is merely down, or whose DID cannot be resolved, keeps its cached rows.
- None of the rules above apply to DMs, whose state the DM client keeps in its own browser store; see "Direct-message runtime boundary" below.

## Protocol compatibility

The protocol adapter isolates the draft `com.atproto.space.*` lifecycle, record and credential APIs and the `com.atproto.memberspace.*` membership APIs (every space is governed by `packages/protocol/src/atproto/space-policy.ts`). A credential is minted by an unsigned, body-only exchange; every request that presents it is signed by `@atproto/space`, and `packages/protocol/src/atproto/space-credential-core.ts` is the only place that asks for and verifies a MAC. The implementation is pinned to PDS commit `5d88b414a98de1ada22c94c78fa0667a7028163c` and the exact lexicon hashes in `docs/protocol/atproto-spaces-pin.md`. Proposal 0016 is still draft; any pin drift blocks release until the conformance suite passes again.

## Direct-message runtime boundary

DMs are person-scoped, not workspace-owned, and no app-operated component can read, gate, lose, or hold hostage one (`.ai/plans/direct-messages.md` §1). This is a stricter boundary than channels, held entirely by process and import isolation, not by policy alone:

- **One browser-held OAuth session.** `apps/web/src/browser/session.ts` dynamically imports `@atproto/oauth-client-browser` (so it never reaches a server bundle) and constructs a public OAuth client (`token_endpoint_auth_method: "none"`) whose metadata (`apps/web/src/browser/client-metadata.ts`, served at `/oauth/client-metadata.json`) requests the one grant, of which `DM_BROWSER_SCOPES` is the DM part. Its DPoP keys are non-extractable WebCrypto keys and it is stored in the browser's IndexedDB. The server holds no member session at all; its only OAuth grants are the workspace authorities' grants to its operator, which carry no DM scope (`packages/protocol/src/scopes.test.ts`).
- **The isomorphic engine, `packages/client/src/dm/dm-client.ts`.** `DmClient` is constructed with injected transports (`memberClient`, `resolvePds`, `fetchEndpoint`, `generateKey`, `store`) so the identical class runs in the browser (production) and in Node (unit tests, `protocol-tests/dm-acceptance.test.ts`, `protocol-tests/dm-performance.test.ts`) against a fake or the real pinned PDS. It shares `packages/protocol/src/keys.ts`, `packages/protocol/src/registry.ts`, `packages/protocol/src/atproto/space-key.ts`, `packages/protocol/src/atproto/space-policy.ts`, `packages/protocol/src/atproto/kem-key.ts`, `packages/protocol/src/atproto/space-credential-core.ts`, `packages/protocol/src/atproto/xrpc.ts`, and `packages/protocol/src/atproto/record-pages.ts` with the server's channel code. It lives in `@flock/client`, which depends on `@flock/protocol` only, so it cannot import the operator, its database, its configuration or its OAuth client (`import/no-extraneous-dependencies` in `eslint.config.mjs` holds each package to its `package.json`); it typechecks with no Node types, and lint refuses a Node built-in in it.
- **No server routes, tables, or cache for DM content.** The server has no member routes at all. The only server involvement is the operator's change feed (`new.flock.operator.getChanges`), called with a service token: for each followed space it returns a cursor, or that the caller may not follow it (decided from the space's member list), and it never mints a member's space credential and never reads a DM record. The underlying `space_notification` table (shared with channel notifications) does retain the writer DID of each notified write, so an operator with direct database access has a bounded, timing-only social-graph signal for spaces with an active notify registration; see "Direct messages: what an operator can and cannot see" in `docs/operations.md` for the full, precise statement of that residual exposure.
- **Independent second-app parity, `packages/reader/src/independent-dm.ts`.** A separate reader that reconstructs the same conversation (messages, reactions, per-half status) from the `new.flock.dm.*` lexicons alone, sharing only the protocol layer above and never importing `packages/client/src/dm/**` (`@flock/reader` depends on `@flock/protocol` only, and lint holds it to that) or the engine's sync core (`packages/client/src`; it implements its own full-history merge). `protocol-tests/dm-acceptance.test.ts` asserts this reader and `DmClient.readConversation` return identical state for the 1:1 and group flows, including every per-half status (`ok`, `missing`, `deleted`, `revoked`).
- **Data flow for a DM read:** browser DM session → `mintSpaceCredentialWith` exchanges a delegation token (signed by the browser session) for a space credential bound to a non-extractable WebCrypto signing key at each participant's own PDS → the engine reads and validates each half's header/messages/reactions directly from that PDS → the engine's sync core (`packages/client/src/sync.ts`) checks each half's revision, lists only halves that moved, and merges them into the latest-N page. No step touches this app's server.

```
        BROWSER (per user)                    NEXT.JS SERVER                          EACH PARTICIPANT'S PDS
  ┌───────────────────────────┐        ┌───────────────────────────┐          ┌───────────────────────────────┐
  │ the one OAuth session      │──────▶│ app UI, operator, its     │          │ new.flock.dm.inbox (self)      │
  │  (sign-in in the browser;  │ svc.  │ authority flow; SQLite:   │          │ new.flock.dm.conversation/<key>│
  │   workspaces, channels,    │ token │ authority grants, journal │          │  header / message / reaction   │
  │   operator, DM set)        │        │ (no member session, no    │          │  (member-list read/write,      │
  │  - IndexedDB, non-extract- │        │  DM tables)               │◀ notify──│   open app access)             │
  │    able DPoP keys          │        │ getChanges: cursors only, │          └───────────────────────────────┘
  │                            │        │  no record reads          │                    ▲          ▲
  │                            │        └───────────────────────────┘                    │          │
  │ DmClient (packages/client/src/dm/*)  ───────────── mint space credential, read/write records ─────────┘          │
  │ independent-dm reader ──────────── mint space credential, read records (parity check) ───────────┘
  └───────────────────────────┘
```
