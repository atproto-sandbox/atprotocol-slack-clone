// Executable Gherkin. Scenarios tagged @unbound have no step definitions yet and are excluded from the run;
// bdd/gate.test.ts keeps that set from growing and fails if any other scenario lacks step definitions.
// @slow scenarios delegate to a long protocol test (minutes to an hour), so the default run skips them;
// `--profile slow` runs only those. Cucumber AND-merges tag expressions of the default profile and the command line,
// so the gate checks step definitions with `--profile bound`, whose expression is exactly "every scenario that is bound".
const base = {
  import: ["bdd/support/**/*.ts", "bdd/steps/**/*.ts"],
  format: ["progress-bar", "html:test-results/bdd-report.html"],
  strict: true,
};

const config = { ...base, tags: "not @unbound and not @slow" };

export default config;
export const slow = { ...base, tags: "@slow and not @unbound" };
export const bound = { ...base, tags: "not @unbound" };
