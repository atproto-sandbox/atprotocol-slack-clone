---
name: align-app-against-protocol-spec
description: Keep this app aligned with the upstream atproto permissioned-data spec (proposal 0016) and the alpha PDS (PR #5187) while both keep changing. Use when asked whether the app is current with the spec or the alpha, when upstream may have published a new proposal commit, PDS commit, migration prompt or npm snapshot, before any re-pin, and as the periodic upstream check. Covers drift detection, the spec-conformance review, the re-pin checklist, the verification gates and the record to leave behind.
---

# Align the app against the protocol spec

Three sources matter, in this order for "what the protocol is":

1. **The pinned PDS** (`bluesky-social/atproto` PR #5187, a draft): what the alpha actually does. The app speaks exactly one pinned commit and its tests run against a standalone checkout of it.
2. **The spec** (`bluesky-social/proposals`, `0016-permissioned-data/README.md`): what upstream says it intends. It can run ahead of or behind the PDS.
3. **The app**: this repo.

Where the spec and the pinned PDS disagree, the app follows the pinned PDS, and the difference is written down. Upstream has shipped several breaking waves in a few weeks; the answer to a wave is a new pin and a plan, never a compatibility shim.

## 0. Read first

- `CODE-MAP.md`: canonical module owners. A change belongs in the owner, never in a second copy.
- `docs/protocol/atproto-spaces-pin.md`: the one record of the current pins (proposal commit, PDS commit, npm snapshot, strict-expiry overlay hash), the build and conformance commands, the "What changed since" table, and the accepted limits.
- The newest `.ai/plans/protocol-drift-*.md`: the template for a plan, and its "Outcome and departures" section lists the owner's decisions and what is still open. Do not re-raise a recorded decision.
- `.ai/upstream/README.md`: the local drafts of requests to the core team, each with a "Status against <sha>" line.

## 1. Detect drift (read-only, no checkout needed)

Read the recorded pins from the pin note, then compare them with upstream:

```sh
grep -nE "Proposal 0016|PDS implementation|App dependencies" docs/protocol/atproto-spaces-pin.md
git ls-remote https://github.com/bluesky-social/proposals.git refs/heads/main
git ls-remote https://github.com/bluesky-social/atproto.git refs/pull/5187/head refs/heads/permissioned-data
npm view @atproto/space versions --json | grep spaces-alpha | tail -3
```

| Signal | Moved means |
|---|---|
| Proposal `main` differs from the recorded proposal commit | The spec changed. Clone it next to this repo (`../atproto-proposals`, outside the repo) and run `git diff <recorded>..HEAD -- 0016-permissioned-data`. |
| PR head differs from the recorded PDS commit | Compare it with the PR head the newest plan records (its "Sources" list, as `d0097360` for the current pin) first; a head that differs from the pin only by a prompt file is already explained there. Otherwise fetch only trees into a scratch directory: `git init -q . && git fetch --depth=1 --filter=blob:none https://github.com/bluesky-social/atproto.git refs/pull/5187/head <recorded>`, then `git diff --stat <recorded> FETCH_HEAD -- lexicons packages/space packages/pds packages/oauth packages/dev-env alpha-migrations` and `git ls-tree --name-only FETCH_HEAD alpha-migrations/`. |
| A new `alpha-migrations/prompt-*.md` | Read it even when no code moved: the core team publishes the next wave's migration there, and the file can land on the PR head before the code does. A head that differs only by a prompt file is not code drift. |
| A newer `spaces-alpha` npm snapshot | `package.json` pins one snapshot of `@atproto/space`, `crypto` and `lex-data`, built from the pinned commit; `pnpm-workspace.yaml` also lists it for `car`, `lex-cbor` and `syntax` (release-age exclusions and range overrides). A newer snapshot belongs to a newer commit, so treat it as PDS drift. |

Nothing moved: say so with the three values and the date, and stop (do not edit the pin note's "Verified" line; that line means the test suites were run). Something moved: continue.

## 2. Survey, then write a plan and stop

Diff the PDS areas above and build a table "upstream change → app owner" (see the newest plan's first table). Typical owners:

| Upstream area | App owner |
|---|---|
| credential request, presentation, MAC, KEM keys | `src/atproto/space-credential-core.ts`, `space-key.ts`, `kem-key.ts` |
| change notifications (`registerNotify`, `notifyWrite`, `notifySpaceDeleted`) | `src/atproto/notifications.ts`, `write-notification.ts`, `src/app/xrpc/com.atproto.space.notifyWrite/route.ts` |
| policy object, space methods, record and repo paging | `src/atproto/space-policy.ts`, `space-ops.ts`, `record-pages.ts` |
| DID and PDS resolution | `src/atproto/identity.ts` |
| scope grammar, permission sets | `src/auth/permission-sets.ts` |
| lexicons | `lexicons/**` (the `org.slack.permissions.*` permission sets must keep matching `src/auth/permission-sets.ts`; a unit test checks it), generated `src/lexicons/**` (`pnpm codegen:lex`) |
| direct messages and their test double | `src/dm/**` (browser side: `browser-identity.ts`, `browser-session.ts`), `src/dm/testing/fake-pds.ts` (mirror the real PDS) |
| workspaces, operator journal, independent reader | `src/workspaces/**`, `src/operator/**`, `src/reader/**` |

Write `.ai/plans/protocol-drift-<short sha>.md` in the shape of the newest one: what changed and where it hits us, decisions needed from the owner, out of scope, phases P0 to P8, risks. Present it and wait for approval before implementing. Product decisions (for example what a departing member's history does) go to the owner; do not decide them in the plan.

## 3. Spec-conformance review (the "are we aligned" question)

1. Read the proposal `README.md` completely at the current commit.
2. Fill `spec-review-prompt.md` (same directory as this file) and run it with an independent reviewer. Use the reviewers and models the `adversarial-execution` skill names. Record the selector, the resolved model and the reasoning level from the run output. A read-only reviewer usually has no network, so run step 1 yourself and give it the results. A Sonnet subagent run with the template made about 120 tool calls over roughly 17 minutes and returned a usable report. If a required model is refused (for example `model_not_found` on the Codex login), stop and report the error. Do not retry in a loop and do not substitute another model without the owner saying so.
3. Save the report under `.ai/reviews/`.
4. Check every finding yourself against the full text of the file or the spec before acting, never a truncated line or a summary. A review is evidence, not a verdict; reviewers have been wrong in both directions on this repo.
5. Put each spec-vs-PDS difference, each spec feature to adopt later, and each app assumption the spec does not promise into the plan's outcome or the pin note.

## 4. Re-pin checklist

1. Make a standalone clone of the PDS at the new commit (not a `git worktree`, so deleting an older checkout cannot break it), apply `protocol-tests/atproto/strict-credential-expiry.patch`, and build it with the commands in the pin note (pnpm 11.11.0, `PUPPETEER_SKIP_DOWNLOAD=1`, Node 22.17 on `PATH`). The patch should apply with offsets only; if a hunk moved, re-base it and update its SHA-256 everywhere it is recorded.
2. Copy the three `protocol-tests/atproto/*.test.ts` files into the checkout's `packages/pds/tests/space/` and run the upstream `@atproto/space` and PDS space suites first, to learn which of ours fail before any app change.
3. Move every recorded pin. Find them with `grep -rIl "<old pdsCommit>\|<old pdsCommit first 8>\|<old snapshot>\|<old proposal sha>\|<old proposal first 8>" --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git .`; many files use the 8-character form, and `protocol-tests/support/app-fixture.ts` names the checkout directory instead of a sha. Expect at least `docs/protocol/atproto-spaces-pin.md`, `README.md`, `ARCHITECTURE.md`, `PROGRESS.md`, `docs/prd/atproto-slack-clone.md`, `scripts/codegen-lex.mjs` (`expectedCommit`), `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` (the snapshot appears in `minimumReleaseAgeExclude` and `overrides`), `protocol-tests/atproto/README.md`, `protocol-tests/support/app-fixture.ts` (default checkout directory), and the "Status against" line of each `.ai/upstream/U*.md`.
4. Regenerate the Lexicon clients (`src/lexicons/api`) with `ATPROTO_PIN_CHECKOUT=<checkout> pnpm codegen:lex` once `pnpm build:tooling` has run in the checkout; the script refuses a checkout whose HEAD is not its `expectedCommit`. Note the two names: codegen reads `ATPROTO_PIN_CHECKOUT`; the acceptance, BDD, browser and performance runs read `ATPROTO_PINNED_CHECKOUT`.
5. Change the app in the owner modules and delete the old protocol shape. Check `@atproto/space` and the other installed `@atproto/*` packages (types and docs) before writing any protocol code by hand.
6. Update the fake PDS to match the new real behavior, and keep it no more lenient than the real PDS.

## 5. Verification gates

Run in this order, with Node 22.17 on `PATH` and `ATPROTO_PINNED_CHECKOUT` set to the new checkout, and report counts against the baselines in `PROGRESS.md` and the pin note:

1. `pnpm typecheck`, `pnpm lint`, `pnpm test`.
2. The upstream `@atproto/space` suite and the PDS space suites with our three conformance files (jest, `--runInBand`, commands in the pin note).
3. `pnpm test:acceptance` and `pnpm test:browser`.
4. `pnpm test:bdd`, then `pnpm test:bdd:slow`. Run them alone: the suite is long, timing sensitive and has failed intermittently before, so do not run it next to another run. Report any slowdown; do not raise a timeout or perf budget to hide it.
5. `pnpm test:performance` when the change touches sync, paging or credentials.
6. Check record-size limits in `src/protocol` against any new PDS record cap.

## 6. Review, then record

- Run the project's code-review process on the frozen diff, then the `adversarial-execution` skill against the plan. Save the reports under `.ai/reviews/`.
- Update the pin note (new pins, "Verified" date and the suite counts, a "What changed since" table), the plan's "Outcome and departures" (including the last-seen PR head and any prompt-only difference from the pin), `PROGRESS.md`, and each `.ai/upstream/U*.md` status line (still needed, resolved upstream, or changed).
- Commit and push only on the owner's explicit approval. Scan for secrets before any push. The upstream request drafts stay local: do not file or post anything upstream or anywhere public unless the owner asks for it in that conversation.
