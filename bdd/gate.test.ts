import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { loadConfiguration, loadSources, runCucumber } from "@cucumber/cucumber/api";

// The Gherkin scenarios are the product's behavior contract only if they run. This gate keeps them honest:
// a scenario is either executable (it has step definitions and runs in `pnpm test:bdd`) or explicitly tagged
// @unbound with a stated reason, and the number of unbound scenarios can only go down.

// Lower this when a scenario gets step definitions. Raising it needs a reviewer to agree the new scenario cannot run yet.
const MAX_UNBOUND_SCENARIOS = 1;

async function plan(tagExpression: string): Promise<string[]> {
  const { runConfiguration } = await loadConfiguration({ file: "cucumber.mjs" });
  const { plan: planned, errors } = await loadSources({ ...runConfiguration.sources, tagExpression });
  assert.deepEqual(errors, [], "every feature file parses");
  return planned.map((pickle) => `${pickle.uri}: ${pickle.name}`);
}

test("the number of scenarios without step definitions never grows", async () => {
  await plan(""); // every feature file parses, including the ones excluded from the run
  const unbound = await plan("@unbound");
  const executable = await plan("not @unbound");
  assert.ok(executable.length > 0, "at least some scenarios are executable");
  assert.ok(unbound.length <= MAX_UNBOUND_SCENARIOS, `${unbound.length} unbound scenarios exceeds the limit of ${MAX_UNBOUND_SCENARIOS}; bind them instead of tagging new ones @unbound`);
  if (unbound.length < MAX_UNBOUND_SCENARIOS) assert.fail(`${unbound.length} scenarios are unbound; lower MAX_UNBOUND_SCENARIOS in bdd/gate.test.ts so the ratchet keeps the gain`);
});

/** The comment block directly above a line, with nothing in between. */
function commentBlockAbove(lines: string[], index: number): string {
  const block: string[] = [];
  for (let i = index - 1; i >= 0 && /^\s*#/.test(lines[i]!); i -= 1) block.unshift(lines[i]!);
  return block.join("\n");
}

test("every unbound scenario says why, and the coverage it points to exists", () => {
  const problems: string[] = [];
  for (const file of readdirSync("features").filter((name) => name.endsWith(".feature"))) {
    const lines = readFileSync(join("features", file), "utf8").split("\n");
    lines.forEach((line, index) => {
      if (!/^\s*@/.test(line) || !/(^|\s)@unbound(\s|$)/.test(line)) return;
      const reason = commentBlockAbove(lines, index);
      if (!/(unbound:|Covered by)/.test(reason)) problems.push(`${file}:${index + 1} has no '# unbound:' or '# Covered by' comment directly above it`);
      for (const cited of reason.match(/\b(?:protocol-tests|src|bdd)\/[\w./-]+\.ts\b/g) ?? []) {
        if (!existsSync(cited)) problems.push(`${file}:${index + 1} cites ${cited}, which does not exist`);
      }
    });
  }
  assert.deepEqual(problems, []);
});

test("every executable scenario, @slow ones included, has a step definition for every step", async () => {
  // Cucumber's dry run exits successfully even when a step has no definition, so count the step results.
  // The `bound` profile alone selects the scenarios: the default profile would AND its own `not @slow` into the expression.
  const { runConfiguration: configured } = await loadConfiguration({ file: "cucumber.mjs", profiles: ["bound"], provided: { dryRun: true } });
  // Formats from cucumber.mjs are additive, so replace them: this must not print or rewrite the real run's report.
  const runConfiguration = { ...configured, formats: { ...configured.formats, stdout: "snippets", files: {} } };
  let finishedSteps = 0;
  const unusable: string[] = [];
  await runCucumber(runConfiguration, undefined, (message) => {
    const status = message.testStepFinished?.testStepResult.status;
    if (!status) return;
    finishedSteps += 1;
    if (status === "UNDEFINED" || status === "AMBIGUOUS" || status === "PENDING") unusable.push(status);
  });
  assert.ok(finishedSteps > 0, "the dry run saw the executable steps");
  assert.deepEqual(unusable, [], "a step has no definition, or more than one (run `pnpm test:bdd` for details)");
});

// @slow scenarios delegate to protocol tests that take minutes to an hour. The default run skips them, so they are the
// one place a scenario can rot unseen: keep the set small and named, and keep a script that runs it.
const SLOW_SCENARIOS = [
  "features/independent-app-and-launch.feature: Meet the workspace size envelope",
  "features/lifecycle-and-recovery.feature: Recover after every injected mutation failure",
];

async function planFor(profile: string | undefined): Promise<string[]> {
  const { runConfiguration } = await loadConfiguration({ file: "cucumber.mjs", profiles: profile ? [profile] : [] });
  const { plan: planned, errors } = await loadSources(runConfiguration.sources);
  assert.deepEqual(errors, [], "every feature file parses");
  return planned.map((pickle) => `${pickle.uri}: ${pickle.name}`).sort();
}

test("the @slow scenarios are the listed ones, skipped by the default run and selected by `--profile slow`", async () => {
  assert.deepEqual(await plan("@slow"), [...SLOW_SCENARIOS].sort(), "the @slow set changed: a new @slow scenario needs a reviewer's agreement and an entry in SLOW_SCENARIOS");
  assert.deepEqual(await planFor("slow"), [...SLOW_SCENARIOS].sort(), "`--profile slow` runs exactly the @slow scenarios");
  const defaultRun = await planFor(undefined);
  assert.ok(defaultRun.length > 0 && defaultRun.every((name) => !SLOW_SCENARIOS.includes(name)), "the default run skips every @slow scenario");
  const bound = await planFor("bound");
  assert.deepEqual(bound, [...defaultRun, ...SLOW_SCENARIOS].sort(), "the `bound` profile used by the step-definition check covers the default run plus the @slow scenarios");

  const { scripts } = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
  assert.ok(Object.values(scripts).some((script) => /\bcucumber-js\b.*--profile slow\b/.test(script)), "package.json has a script that runs `cucumber-js --profile slow`");
});
