# Binding Gherkin scenarios to real Playwright steps

Goal: every scenario in `features/*.feature` runs as an executable test against the real app, real PDS hosts and a real browser, so a green run is evidence that the product works. Today only `features/workspaces.feature` is bound; the other five files are tagged `@unbound`. You bind one assigned feature file.

## Environment (always)

```
cd <repo root>
export PATH=$HOME/.nvm/versions/node/v22.17.0/bin:$PATH      # Node 22.17 is required; the system Node breaks better-sqlite3
export ATPROTO_PINNED_CHECKOUT=$(cd ../atproto-spaces-phase0 && pwd)
NODE_OPTIONS=--import=tsx pnpm exec cucumber-js features/<file>.feature --name "<scenario name>" 2>&1 | tail -80
```

- The production build in `.next` is already current. **Never run `pnpm build`** (other agents share it). You may not change anything under `src/`.
- Several agents run at once on this machine, each starting its own fixture on random ports. Run only your own feature file. Add `BDD_HEADED=1 BDD_BROWSER_CHANNEL=chrome` to watch in real Chrome (optional).
- Default step timeout is 180 s. A single scenario normally takes 30-120 s.

## How the harness works (read these first)

- `bdd/support/hooks.ts` starts one fixture (two PDS hosts, PLC, the app via `next start`) and one browser per run.
- `bdd/support/world.ts` `AppWorld`: `this.actor(role, host)` creates a fresh account on PDS host 0 or 1 with its own browser context/page; `callsTo(actor, path)` returns recorded `/api/*` calls; `withAppDatabase(read)` is a read-only view of the app's SQLite; `pdsGet`/`pdsPost` talk to an account's PDS directly with that account's access JWT (an independent source of truth); `this.fixture.startSecondApp({env?})` starts a second fully independent app instance (own port, database, key) on the same PDS network (use a separate browser context for it: cookies are shared across ports on 127.0.0.1).
- `bdd/support/ui.ts`: one helper per thing a person does (`signIn`, `completeConsent`, `createWorkspaceAs`, `approveAdminControls`, `inviteMemberAs`, `joinFromInvitation`, `ownerInvites`, `eventually`, ...). **Do not edit it.** Put new helpers in your own file `bdd/support/<your-feature>-ui.ts`.
- `bdd/steps/workspaces.steps.ts` is the style reference (assertions read facts from the UI and independently from the PDS).
- Existing flows you can copy selectors and consent handling from: `protocol-tests/browser/oauth-callback.spec.ts` (workspace, channels, private requests, messages), `protocol-tests/browser/dm.spec.ts` (DMs), `protocol-tests/app-acceptance.test.ts`, `protocol-tests/dm-acceptance.test.ts` (backend flows and PDS calls). UI components: `src/app/ui/*.tsx`.
- OAuth reality: the PDS consent screen appears the first time an action needs a scope (workspace creation, admin controls, channel posting "Grant message posting →", join). `completeConsent(actor)` handles it. After consent the browser returns to the app.

## Rules for the steps you write

1. Drive the real UI wherever the product has one. Use direct PDS calls (`pdsGet`/`pdsPost`) or the app DB only (a) to verify a claim independently of the UI, or (b) to create adversarial/hostile conditions that no UI can create (a record written into your own repo by a malicious member, a forged request, a forwarded URI).
2. Every `Then`/`But` must assert the scenario's actual claim against a real observation, in both directions where the scenario says "only", "not", "never" or "absent". No vacuous assertions, no `assert.ok(true)`, no swallowing errors, no asserting on text the step itself typed.
3. Wait on observable conditions (`eventually`, Playwright auto-wait), never fixed sleeps. No `.catch(() => undefined)` around an assertion.
4. Negative control (mandatory): for every scenario, temporarily break one expectation (flip an expected value or skip the action that makes it true) and confirm the scenario goes red, then restore it. Report which control you used per scenario.
5. Step text must match the Gherkin exactly. Use Cucumber expressions or anchored regexes specific enough that no other feature file's steps can match them (cucumber fails the whole run on an ambiguous step). Before finishing, check no step text you define also matches steps in other feature files; where a Gherkin phrase is shared (e.g. "they edit or delete it"), make your regex carry the context (use the scenario's own wording) or share state through `this.scratch`.
6. State lives in `AppWorld`/`this.scratch`; nothing global between scenarios. Every scenario creates its own actors and workspace (`uniqueWorkspaceName()`), so scenarios are order independent.
7. Binding a feature: when every scenario in your file runs, remove `@unbound` from the feature's tag line and delete the two `# unbound:` / `# Bind a scenario...` comment lines at the top of the file. If a single scenario truly cannot be bound, leave `@unbound` on that scenario only, with a `# unbound: <reason>` comment directly above the tag line, and say so loudly in your report (the user expects ALL scenarios to run).
8. Code style: TypeScript, no `any`/`@ts-ignore`, named exports, explicit return types on exports, no comments that restate code. Reuse project dependencies; add none.
9. Never edit: `src/**`, `bdd/support/{world,ui,hooks}.ts`, `bdd/steps/workspaces.steps.ts`, `bdd/gate.test.ts`, `cucumber.mjs`, `package.json`, `protocol-tests/support/app-fixture.ts`, another agent's files, or Gherkin wording (except the tags/comments in rule 7). If you need a change in one of these, stop and describe the exact change in your report instead.
10. Never commit, push, or contact anything external.

## When the app is wrong

If a scenario fails because the app is wrong (not because your step is wrong), do not weaken the step and do not work around the app. Keep the correct step, keep the scenario red, and report: scenario, observed vs expected, evidence (UI text, API status/body, PDS response, server output tail), and the likely root-cause file/line in `src/` with a minimal proposed fix. Prove it is the app by checking your step against a manual reproduction (headed Chrome, or direct API calls).

## When a scenario cannot honestly run through the app

Some scenarios describe mechanisms no browser user can reach (injected PDS write failures with operator restarts, a 2,000,000-record workload). For these only, a step may run the existing protocol test as a child process (`node --import tsx --test protocol-tests/<file>`) and assert it exits 0. Run it at most once per cucumber process (cache the promise at module level) and tag those scenarios `@slow` in the feature file so they can be selected or excluded. Label the delegation in your report as delegated, never as UI-driven. Do this only after you have tried to reach the behavior through the app, the PDS, or the app database; say what you tried.

## Report format (your final message)

Per scenario: bound & green / red because of app bug / delegated; what the Then steps observe and from where (UI / PDS / app DB); the negative control you ran and the result. Then: files created, step-text collision check, the exact command and final summary line of your last full run of your feature file (scenarios and steps counts), app bugs found, requested changes to forbidden files. Keep it factual; no absolute paths or personal data.
