# Pinned `@atproto` Spaces Conformance & Scale Suites

These suites verify protocol-level invariants directly against real `@atproto/dev-env` `TestNetworkNoAppView` / `TestPds` instances loaded from the pinned `bluesky-social/atproto` checkout (`6747610566eee1b6d743617bd8eb1136adccb362` + `strict-credential-expiry.patch`). Their source pin, cryptographic preflight (`scripts/verify-pinned-checkout.mjs`), and build instructions are documented in [`docs/protocol/atproto-spaces-pin.md`](../../docs/protocol/atproto-spaces-pin.md).

## Contents of `protocol-tests/atproto/`

- **[`strict-credential-expiry.patch`](./strict-credential-expiry.patch)** (SHA-256 `3f413baa779473b5466e8e6ca9edc92335f5056edbd13aa3d4bfc57a509b32dd`): Applied to the pinned `6747610566` checkout before building `@atproto/space` and `@atproto/dev-env`. Enforces zero-skew expiry (`type === 'credential' ? 0 : CLOCK_SKEW_SEC`) on `Atproto-Space-Credential` tokens while preserving the 5-second clock-skew allowance on delegation tokens and client attestations. Verified unconditionally by `scripts/verify-pinned-checkout.mjs` before codegen and test runs.
- **[`slack-dm-conformance.test.ts`](./slack-dm-conformance.test.ts):** Verifies personal-PDS sovereign Direct Message (`new.flock.dm.*`) conformance on `com.atproto.memberspace.policy` — cross-host symmetric conversation halves, closed existence oracle (`SpaceNotFound` vs `SpaceDeleted` + public `new.flock.dm.declaration`), public-write vs allowlist policy transitions (`putMembers` / `removeMembers` `#repoRemoved` + dormant allowlist reactivation under `publicWrite: true`), browser public OAuth (`token_endpoint_auth_method: "none"`) with non-extractable WebCrypto DPoP, RFC 9421 `Atproto-Space-Credential` PoP + HPKE KEM-MAC verification, 100-participant scaling, and strict zero-skew credential expiry.
- **[`platform-spike-k2-confidential-client.test.ts`](./platform-spike-k2-confidential-client.test.ts):** Verifies confidential `private_key_jwt` OAuth client authentication, JWKS rotation, DPoP proof binding, and token refresh against real pinned PDS OAuth providers.
- **[`platform-spike-k5-oplog.test.ts`](./platform-spike-k5-oplog.test.ts):** Verifies per-page signed/MAC-authenticated `listRepoOps`, `getRepo` `application/vnd.dasl.star` (`@atproto/star`), `LtHash` set-hash verification, and `RepoNotFound` semantics on real pinned PDSes.

*(Note: R12's `slack-authority-oauth-conformance.test.ts` and `slack-inbox-conformance.test.ts`—which exercised R12's bespoke personal-PDS `com.atproto.memberspace` workspace governance—were retired in R13 when workspaces moved to `opensocial.group` atmospheric Group DIDs. OpenSocial group OAuth, `getSpacesFromScope` DNS lexicon enforcement, cross-PDS `invites/self`, flat RBAC, moderation, lifecycle journals, and two-GroupHost migration are covered end-to-end against real pinned `TestPds` + `apps/group-host` instances in [`protocol-tests/opensocial-groups.test.ts`](../opensocial-groups.test.ts) and [`packages/testing/src/group-host-parity.test.ts`](../../packages/testing/src/group-host-parity.test.ts).)*

## Running in-place (zero mutation of `$ATPROTO_PINNED_CHECKOUT`)

In R13, all three `protocol-tests/atproto/*.test.ts` files run **directly in-place** from this repository via `node --import tsx --test` (using `protocol-tests/support/pinned-atproto-harness.ts` to resolve modules from `ATPROTO_PINNED_CHECKOUT` and creating isolated per-suite temporary directories cleaned up on teardown—never copying files into `$ATPROTO_PINNED_CHECKOUT/packages/pds/tests/space/`!). They are wired directly into `pnpm test:acceptance` (enforced 1-to-1 by `protocol-tests/suite-manifest.test.ts`):

```sh
# Run all 16 acceptance & pinned conformance suites (including the 3 protocol-tests/atproto/*.test.ts files):
ATPROTO_PINNED_CHECKOUT=../atproto-spaces-r12 corepack pnpm test:acceptance

# Or run just the 3 pinned PDS conformance suites directly in-place:
ATPROTO_PINNED_CHECKOUT=../atproto-spaces-r12 node --import tsx --test \
  protocol-tests/atproto/slack-dm-conformance.test.ts \
  protocol-tests/atproto/platform-spike-k2-confidential-client.test.ts \
  protocol-tests/atproto/platform-spike-k5-oplog.test.ts
```

## Sync-budget & full-envelope performance gates

Run the numeric sync-budget and supported-envelope performance suites against the same pinned checkout:

```sh
ATPROTO_PINNED_CHECKOUT=../atproto-spaces-r12 corepack pnpm test:sync-budget
ATPROTO_PINNED_CHECKOUT=../atproto-spaces-r12 corepack pnpm test:sync-budget:browser
ATPROTO_PINNED_CHECKOUT=../atproto-spaces-r12 corepack pnpm test:performance
```

`pnpm test:performance` runs:
- `protocol-tests/performance-envelope.test.ts` (`200` members, `100` channels, `20,000` messages/channel): asserts `O(1)` OpenSocial membership update across a `100`-channel group (`=== 1` XRPC write, `<= 250 ms`), writer eviction across `100` spaces (`<= 500 ms`), `1` Group-Host-to-Operator webhook per message at `200` members, and cold latest-`100` channel open (`<= 60,000 ms`) with exact parity between `@flock/client` and `@flock/reader`.
- `protocol-tests/dm-performance.test.ts` (`100` DM participants, `20,000` total messages).
- `protocol-tests/tasks-performance.test.ts` (`50`-writer Tasks STAR/oplog merge SLOs).
