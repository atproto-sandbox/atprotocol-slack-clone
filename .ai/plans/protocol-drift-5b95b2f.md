# Plan: follow the upstream protocol from `787a730f` to `5b95b2f2`

Branch `chore/protocol-drift-5b95b2f`, cut from `feat/direct-messages`. Upstream is PR #5187 (`bluesky-social/atproto`, `permissioned-data`, still a draft): 22 commits, 2026-09-28 to 2026-10-01. The drift survey is in the conversation record; the facts used here come from the upstream diff (`git diff 787a730f..5b95b2f2 -- lexicons packages/space packages/pds`).

**Goal.** The app, its tests and the Gherkin suite pass against the new revision, with no code left that speaks the old protocol. No compatibility shims: the pinned revision moves, the old shape is deleted.

## What changed upstream and where it hits us

| # | Upstream change | Our code |
|---|---|---|
| D1 | `type` renamed `spaceType` (`createSpace` input, `listSpaces` filter) | `src/atproto/space-ops.ts`, `space-pages.ts`, `record-pages.ts` callers, `src/dm/dm-client.ts`, `src/dm/testing/fake-pds.ts`, operator code, fixtures, generated lexicon types |
| D2 | `listRepos` returns `repoRev` + `spaceRev` (was `rev`); `cursor` now means "repos updated after this space revision"; ascending `spaceRev` order, a repo may reappear | `src/atproto/record-pages.ts` (`listBoundedRepos`), `src/workspaces/channel-sync.ts`, `src/reader/independent*.ts`, `src/dm/dm-client.ts` (`listRepos` users), fake PDS |
| D3 | `notifyWrite` body: `rev` becomes `repoRev`; forwarded notifications also carry `spaceRev`, `prevSpaceRev`; new errors `SpaceNotFound`, `FutureRev` | `src/atproto/write-notification.ts`, its route, `space_notification` table, SSE routes, tests |
| D4 | DPoP proofs on space requests replaced by HTTP message signatures (`signature-input`, `signature`, `atproto-space-audience`), key is a P-256 `did:key`, credential claim `cnf.jkt` becomes `cnf.kid`, `getSpaceCredential` no longer takes a DPoP proof, credential request scheme is `Atproto-Space <credential>` (delegation tokens stay `Bearer`) | `src/atproto/dpop.ts` (delete), `space-credential-core.ts`, `space-credential.ts`, `src/dm/use-dm-client.ts` (key generation), `src/dm/dm-client.ts`, `src/dm/testing/fake-pds.ts`, `src/dm/client-metadata.ts` (check: OAuth DPoP is unchanged and stays), `src/auth/oauth.ts` (check), conformance tests, `bdd/support/lifecycle-ui.ts` (`withSignedExpiry`/re-sign helpers) |
| D5 | Credential lifetime 7200 s becomes 600 s default, 3600 s hard maximum; `jti` required on every token; revocation endpoint + `notifyCredentialRevoked` | `CREDENTIAL_LIFETIME_MS` (core and fake PDS), `RENEW_BEFORE_MS` and renewal logic in `src/dm/dm-client.ts` and `src/atproto/notifications.ts`, docs ("two hours"), the Gherkin scenario text and the lifecycle steps, `protocol-tests/atproto/slack-inbox-conformance.test.ts` (asserts 7200) |
| D6 | Space host resolves from a `#atproto_space_host` service entry, falling back to the PDS | `src/atproto/identity.ts` `resolvePds`/DM `resolvePds`: no change needed unless DID docs publish the entry (note only) |
| D7 | `strict-credential-expiry.patch` no longer applies; upstream still subtracts 5 s skew from `exp` | Re-base the patch onto the new `credential.ts`/tests, or drop it if upstream now meets our requirement (it does not: skew is still 5 s) |

Out of scope, recorded as follow-ups: using `spaceRev`/`prevSpaceRev` gaps to drive sync recovery, calling the revocation endpoint from `removeMember`, publishing an `#atproto_space_host` entry.

## Phases

Each phase ends green (typecheck, lint, unit tests) and is committed on the branch.

### P0. Pin the new revision

1. Create `../atproto-spaces-phase1` as a `git worktree` of `../atproto-spaces-phase0` at `5b95b2f2723a2882824fbb0b819fd6aad884ef20`. Leave phase0 untouched so `main` and the DM branch keep building against their pin.
2. Install and build exactly as `docs/protocol/atproto-spaces-pin.md` says (pnpm 11.11.0, `@atproto/pds`, `@atproto/dev-env`, `@atproto/space`).
3. Re-base `protocol-tests/atproto/strict-credential-expiry.patch` onto the new `packages/space/src/credential.ts` and `packages/space/tests/credential.test.ts` (expiry check `now - CLOCK_SKEW_SEC >= exp` becomes `now >= exp` for credentials only; delegation tokens, attestations and signatures keep the skew). Regenerate its SHA-256 and record it in the pin doc.
4. Update `docs/protocol/atproto-spaces-pin.md`: new commit, new proposal commit if checked, what changed, new reproduction steps, patch checksum.
5. Point `ATPROTO_PINNED_CHECKOUT` documentation and defaults (`protocol-tests/support/app-fixture.ts` `pinnedCheckoutPath`, README) at `atproto-spaces-phase1`.

Exit: the upstream space tests and our three `protocol-tests/atproto/*.test.ts` conformance files can be run in the new checkout (they will fail until P2 to P4 update them; list failures).

### P1. Lexicon renames (D1, D2, D3)

1. Regenerate `src/lexicons/api` with `pnpm codegen:lex` against the new checkout's lexicons; review the generated diff.
2. `spaceType` in every `createSpace`/`listSpaces` call and in the fake PDS.
3. `listRepos`: new output shape and cursor semantics in `listBoundedRepos` and callers. `channel-sync.ts` keeps its own per-repo `getLatestCommit` rev for the compare-and-set cursor; only the listing shape changes. The independent readers use the new shape.
4. `notifyWrite`: parse `repoRev` (tid), optional `spaceRev`/`prevSpaceRev`; keep the `{"$bytes"}` hash check; store `repoRev` in `space_notification.rev` (no new column unless a consumer needs `spaceRev`). Update `write-notification.test.ts` with the real new body.
5. Unit tests follow the code; fake PDS mirrors the new shapes.

### P2. HTTP message signatures (D4)

1. New isomorphic module `src/atproto/space-signature.ts`: a `SpaceKey` (`did(): string` P-256 `did:key`, `sign(bytes): Promise<Uint8Array>` 64-byte compact ES256), a WebCrypto implementation with a non-extractable private key (same code in Node and the browser), `createSpaceSigHeaders({ authorization, audience? })` producing `authorization`, optional `atproto-space-audience`, `signature-input: atproto-space=("authorization" "atproto-space-audience")` / `...("authorization");keyid="<did:key>"` for the credential exchange, and `signature: atproto-space=:<base64>:`. Signature base is exactly the upstream `signatureBase`: lines `"authorization": <value>`, optional `"atproto-space-audience": <did>`, `"@signature-params": <input>`. Reuse `@atproto/crypto` (`formatDidKey`, P-256 compression) instead of hand-rolling multicodec; confirm it bundles for the browser (the isomorphic ESLint boundary applies).
2. `getSpaceCredential`: `authorization: Bearer <delegation token>`, signature without audience, with `keyid`; no DPoP header.
3. Credential requests: `authorization: Atproto-Space <credential>`, `atproto-space-audience: <space authority DID>` (default `toSpaceRef(space).spaceDid`), signature over both.
4. `SpaceCredential` and `SpaceCredentialDeps.generateKey()` switch from `DpopKey` to `SpaceKey`; `use-dm-client.ts` and the server adapter generate WebCrypto P-256 keys. Delete `src/atproto/dpop.ts` and `dpop.test.ts`; add `space-signature.test.ts` with vectors checked against the upstream verifier (copy a known-good vector produced by the new checkout).
5. OAuth DPoP for the user's own session (browser OAuth client, server OAuth client) is a different mechanism and is not touched. Verify, do not assume.
6. Fake PDS verifies the new signature the way the real one does (credential `cnf.kid` equals the signing did:key, audience present), so unit tests catch regressions.
7. Update the three conformance tests (they hand-roll DPoP today) to use `createSpaceSigHeaders` from the new checkout's `@atproto/space`.
8. `bdd/support/lifecycle-ui.ts` and `protocol-tests/support/app-fixture.ts` `resignSpaceCredential`: the re-signed credential keeps `jti` and `cnf.kid`; adjust the claim handling.

### P3. Credential lifetime and renewal (D5)

1. Lifetime constants become 600 s (default) with the 3600 s ceiling; renewal windows (`CREDENTIAL_RENEW_BEFORE_MS`, `RENEW_BEFORE_MS`) must be well inside 600 s so a credential is renewed before it dies, not an hour early (an hour is longer than the lifetime): derive both from one exported constant and test the boundary.
2. Notification registration (`registerNotify`) expiry is separate from credential lifetime; confirm it has not changed and leave it alone if so.
3. Gherkin and docs: "two hour maximum lifetime" becomes the real maximum. Change the scenario wording in `features/lifecycle-and-recovery.feature`, the step text and constants in `bdd/steps/lifecycle.steps.ts`/`lifecycle-ui.ts`, `SPEC.md`, `CODE-MAP.md`, `docs/protocol/atproto-spaces-pin.md`, `protocol-tests/app-acceptance.test.ts`. The expiry scenario re-signs with a short `exp`; keep it within the new maximum.
4. Update upstream drafts: U6 (credential lifetime and revocation) is now half-done upstream; rewrite it to ask only for what is still missing (exact-at-`exp` expiry, no skew on credentials). Re-read U1, U5 and U11 against the new revision and mark what upstream resolved. Draft edits only, nothing is filed.

### P4. Verification (no skipping)

Order, each against the new checkout:

1. `pnpm typecheck`, `pnpm lint`, `pnpm test`.
2. The upstream space tests and our three conformance tests in the new checkout (jest, `--runInBand`, as in the pin doc).
3. `pnpm test:acceptance` and `pnpm test:browser`.
4. `pnpm test:bdd` (all 66 scenarios, headless) and the full headed Chrome run.
5. `pnpm test:bdd:slow` last (about 25 minutes).

Failures are root-caused, not worked around. If a step proves the new protocol breaks a documented guarantee, stop and record it rather than weakening the test.

### P5. Review and docs

1. Independent code review of the branch diff against `feat/direct-messages`: a fresh Sonnet reviewer, then a fresh critic (see the code-review skill), focusing on the signature module, the credential renewal arithmetic, the browser key handling, and the removed DPoP code.
2. Fix confirmed findings, re-run P4 steps 1 to 4.
3. Update `PROGRESS.md`, `CODE-MAP.md`, `ARCHITECTURE.md` (DPoP-bound credential wording), `docs/operations.md`, and add a short drift note to `.ai/reviews/`.

## Acceptance criteria

- No `dpop` code path for space requests remains; `grep -ri "cnf.jkt\|createSpaceDpopProof\|spaceType" ` shows only the intended names.
- Every suite in P4 passes on the new checkout; the patch applies cleanly there.
- `git diff feat/direct-messages --stat` is limited to the files named above plus tests and docs.
- The pin doc names the new commit and checksum.

## Risks

- **Browser key handling.** The DM session keeps a non-extractable key. Moving to a WebCrypto P-256 key must keep it non-extractable; `did:key` needs only the public key.
- **Signature byte-compat.** One wrong space or newline in the signature base fails every request. Mitigated by vectors generated from the upstream implementation and by running the real PDS in P4.
- **Credential churn.** A 600 s lifetime raises mint rates (the DM read fans out to up to 100 halves). Measure with `pnpm test:performance` after P3; if the DM budget regresses, treat it as a finding.
- **Moving target.** The PR is a draft and may move again during this work; the plan pins `5b95b2f2` and does not chase newer commits.

## Review outcomes

Fixed after an independent reviewer and critic:

- `listBoundedRepos` counted a reappearing repo (updated at a later `spaceRev`) toward `maxRepos` and could report false truncation. The bound and the truncation flag now count distinct DIDs, the latest entry wins, and the lookahead keeps scanning past known DIDs within the page cap.
- `DmClient.credentialFor` could mint twice when two callers awaited the same expired entry. After the await it re-reads the cache and uses a fresher entry another caller already installed.
- `requestedRepo` in `space-credential-core.ts` parsed a POST body for a `repo` that no credential POST carries. Only the GET `repo` query now selects the audience, and it must be a DID.
- Deleted the dead `credentialClientForMember` export and removed the unused `@atproto/jwk-webcrypto` dependency (`@atproto/jwk-jose` stays for the OAuth tests).

Deliberately not changed:

- Credential `expiresAt` is estimated from mint time: the lexicon gives clients no lifetime choice, and the 100 s renewal window absorbs the round trip.
- `readConversation` holds the credentials it minted for the duration of one read: the DM read budget is 5 s against a 100 s margin.
- Long server scans hold one 600 s credential; that is fine unless a single scan exceeds about 500 s.
