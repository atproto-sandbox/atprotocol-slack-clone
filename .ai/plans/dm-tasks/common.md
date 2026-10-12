# Rules for every DM milestone task

You are implementing one milestone of `.ai/plans/direct-messages.md` (read it fully first, including "M0 results"). A reviewer will check your diff line by line, re-run every check, and reject work that breaks these rules.

## Environment
- Repo root: the current directory. Branch `feat/direct-messages` is already checked out.
- Always prefix Node commands with `PATH=$HOME/.nvm/versions/node/v22.17.0/bin:$PATH` (the system Node is the wrong version; native modules fail on it).
- Checks you must run and get green before finishing: `pnpm typecheck`, `pnpm lint` (0 errors; the pre-existing warning in `src/app/ui/logout-button.tsx` is allowed), `pnpm test`.
- Pinned PDS checkout (already built): `../atproto-spaces-phase0`. The protocol suites run by copying `protocol-tests/atproto/*.test.ts` into `../atproto-spaces-phase0/packages/pds/tests/space/` and running, from `../atproto-spaces-phase0`:
  `NODE_OPTIONS=--experimental-vm-modules corepack pnpm@11.11.0 --filter @atproto/pds exec jest --watchman=false --runInBand tests/space/<file>`
- App acceptance: `ATPROTO_PINNED_CHECKOUT=$(cd ../atproto-spaces-phase0 && pwd) pnpm test:acceptance`.

## Hard rules
- Do NOT run any git command that changes state (no commit, add, stash, checkout, reset, branch). The reviewer commits.
- Do NOT edit files outside this repo, except copying test files into the pinned checkout's `packages/pds/tests/space/` to run them.
- Do NOT weaken, skip, or delete existing tests or assertions to make things pass. Do NOT use `as any`, `@ts-ignore`, `@ts-expect-error`, or empty `catch {}` blocks that hide errors.
- Do NOT add dependencies unless the milestone task explicitly allows one; pin exact versions like the rest of `package.json`.
- Match the surrounding code style: dense, explicit TypeScript, named exports, kebab-case file names, no comments that restate code, `node:test` + `node:assert/strict` unit tests named `*.test.ts` next to the code.
- Never introduce path traversal, open redirects, or unvalidated URLs. Validate every externally supplied DID, URI, record key, and record before use.
- DM invariants from the plan are non-negotiable: DMs never touch the server database, server OAuth session, operator, or server cache; `src/dm/**` must not import `@/lib/db`, `@/auth/*`, `@/operator/*`, `@/workspaces/*`, or `node:*` modules.
- If something in the task is impossible or contradicts the protocol evidence, stop and explain in your final message instead of improvising a workaround.

## Final message
End with: files changed (one line each, with purpose), the exact commands you ran with pass/fail counts, and any open issues or deviations from the task. Be honest; the reviewer re-runs everything.
