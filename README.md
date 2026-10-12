# atproto Slack clone

A Slack-style team workspace built directly on atproto permissioned data ("spaces"), with direct messages that the app server cannot read, gate or lose.

There is no app database of record. Each workspace, channel and conversation lives in spaces on the members' own PDSes, and the member lists on those PDSes decide who can read. The app is a client plus a small operator service that makes journaled, resumable membership changes.

> **Status: alpha.** It targets proposal 0016 and the draft PDS implementation (PR [#5187](https://github.com/bluesky-social/atproto/pull/5187), commit `787a730f`), which is not a released protocol. Expect it to break when the protocol moves. Nothing here has been deployed or load-tested beyond local fixtures.

## What it does

- **Workspaces and channels:** public and private channels, messages, one-level replies, one reaction per author, message and emoji, private-channel join requests with admin approval, admin promote and demote, leave and remove, archive.
- **Invitations:** an admin adds a member by DID and copies an invite link. The member opens it, signs in and sees a banner offering to join. The PDS member list is the only gate; the link grants nothing by itself.
- **Direct messages:** one-to-one and groups of up to 100. Each participant owns only their own half of a conversation and their own inbox, with a write policy they set (everyone, only people I allow, nobody). Sign-in is a separate browser-held OAuth session, and the server relays only a content-free change cursor.
- **Independent readers:** `src/reader/` renders workspaces and DMs from the published lexicons and the PDS alone, without this app's database or DM engine, as a check that nothing is locked in.
- **Operator:** journaled, idempotent mutations, restart recovery, a scheduled reconcile job, a pause switch and stalled-operation alerts.

## How it is built

Next.js 16 (App Router) with SQLite for session state, caches and the operator journal. Lexicons are in `lexicons/org/slack/`. See [`ARCHITECTURE.md`](ARCHITECTURE.md) for runtime boundaries and data flow, [`CODE-MAP.md`](CODE-MAP.md) for the directory map and who owns what, and [`SPEC.md`](SPEC.md) for product scope.

## Run it locally

You need Node 22.17 (`.nvmrc`) and pnpm 11 (`corepack pnpm`). The local stack runs two in-memory PDS hosts, a PLC directory and this app, all from a pinned atproto checkout.

1. Check out and build the pinned atproto revision next to this repo as `atproto-spaces-phase0`, and apply `protocol-tests/atproto/strict-credential-expiry.patch`. The steps are in [`docs/protocol/atproto-spaces-pin.md`](docs/protocol/atproto-spaces-pin.md).
2. Install and build:

   ```sh
   corepack pnpm install --frozen-lockfile
   corepack pnpm build
   ```

3. Start the playground:

   ```sh
   ATPROTO_PINNED_CHECKOUT=../atproto-spaces-phase0 corepack pnpm playground
   ```

   It prints a local URL and four ready-made accounts, all with the password `playground-pass`. Type the account's DID (not the handle) into the sign-in box. Everything lives in memory and disappears when you stop it.

For a real deployment, copy `.env.example` and set `APP_URL`, `DATABASE_PATH`, `AUTH_ENCRYPTION_KEY`, `PLC_URL` and `OPERATOR_SERVICE_REF`. The operator DID must serve a `did:web` document that points at this app, and public deployments need HTTPS. See [`docs/operations.md`](docs/operations.md).

## Tests

| Command | What it runs |
|---|---|
| `pnpm typecheck`, `pnpm lint` | types and lint |
| `pnpm test` | unit tests and the Gherkin gate (`bdd/gate.test.ts`) |
| `pnpm test:bdd` | every Gherkin scenario through real Chromium against the local PDS stack |
| `pnpm test:bdd:chrome` | the same in visible Google Chrome |
| `pnpm test:bdd:video` | the same in Chrome, recorded to one mp4 under `test-results/videos/` |
| `pnpm test:bdd:slow` | the two scenarios that delegate to long protocol tests (about 25 minutes) |
| `pnpm test:acceptance`, `pnpm test:browser` | backend acceptance and Playwright specs |
| `pnpm test:performance` | the 200-member, 2,000,000-record envelope and the 100-participant DM budget |

The behavior contract is [`features/*.feature`](features). 68 of 69 scenarios are executable; the last one, that the final admin cannot leave, has no UI path and is covered by `protocol-tests/app-acceptance.test.ts`. The gate fails if that count grows or if a bound scenario has an undefined step. A recording of the full run is in [`docs/media/bdd-session.mp4`](docs/media/bdd-session.mp4) (Git LFS).

The suite needs the pinned checkout, so set `ATPROTO_PINNED_CHECKOUT` as above.

## Project notes

- [`PROGRESS.md`](PROGRESS.md): what was built and the verification evidence.
- [`.ai/upstream/`](.ai/upstream): eleven draft requests to the atproto core team (writer eviction, invitation discovery, write-target existence and others). None have been filed.
- [`.ai/reviews/`](.ai/reviews): the app and protocol reviews, and what the executable scenarios found.
- [`docs/prd/`](docs/prd): the product requirements and implementation plan.

## Known limits

- The pinned PDS allows five seconds of credential expiry skew. This repo carries a patch that makes credentials expire exactly at `exp`; a deployment must use it or a compatible upstream revision.
- With notifications working, the app database keeps the watched DM space URI and writer DID for 7 days. The URI contains the conversation key. This is documented in `docs/operations.md`.
- Permissioned spaces have no way to ask which spaces you were added to, so invitations depend on the invite link until the protocol adds discovery.
