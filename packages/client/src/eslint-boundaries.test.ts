import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ESLint, type Linter } from "eslint";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const eslint = new ESLint({ cwd: REPO_ROOT });

async function lintRestrictedRules(filePath: string, code: string): Promise<Linter.LintMessage[]> {
  const [result] = await eslint.lintText(code, { filePath });
  assert.ok(result, `Expected ESLint result for ${filePath}`);
  return result.messages.filter(
    (msg) => msg.ruleId === "no-restricted-imports" || msg.ruleId === "no-restricted-syntax",
  );
}

async function assertForbidden(filePath: string, code: string, expectedMessageFragment?: string): Promise<void> {
  const messages = await lintRestrictedRules(filePath, code);
  assert.ok(messages.length > 0, `Expected lint boundary error for ${filePath} on:\n${code}`);
  if (expectedMessageFragment) {
    assert.ok(
      messages.some((msg) => msg.message.includes(expectedMessageFragment)),
      `Expected message containing "${expectedMessageFragment}" for ${filePath}, got: ${messages.map((m) => m.message).join("; ")}`,
    );
  }
}

async function assertAllowed(filePath: string, code: string): Promise<void> {
  const messages = await lintRestrictedRules(filePath, code);
  assert.deepEqual(
    messages,
    [],
    `Expected no boundary errors for ${filePath} on:\n${code}\nGot: ${messages.map((m) => `${m.ruleId}: ${m.message}`).join("; ")}`,
  );
}

test("D11.11: forbidden static, relative, re-exported, and dynamic entity-merge / ext/* imports fail ESLint across restricted targets", async () => {
  const entityMergeTargets: Array<{ filePath: string; relativePath: string }> = [
    { filePath: "packages/protocol/src/registry.ts", relativePath: "./entity-merge" },
    { filePath: "packages/protocol/src/workspace-summary.ts", relativePath: "./entity-merge" },
    { filePath: "packages/client/src/channel-client.ts", relativePath: "../../protocol/src/entity-merge" },
    { filePath: "packages/client/src/dm/dm-client.ts", relativePath: "../../../protocol/src/entity-merge" },
    { filePath: "packages/client/src/engine.ts", relativePath: "../../protocol/src/entity-merge" },
    { filePath: "packages/client/src/write-queue.ts", relativePath: "../../protocol/src/entity-merge" },
    { filePath: "apps/operator/src/operator/operations.ts", relativePath: "../../../../packages/protocol/src/entity-merge" },
    { filePath: "apps/echo-bot/src/echo.ts", relativePath: "../../../packages/protocol/src/entity-merge" },
    { filePath: "apps/webhooks/src/main.ts", relativePath: "../../../packages/protocol/src/entity-merge" },
    { filePath: "apps/web/src/app/oauth/client-metadata.json/route.ts", relativePath: "../../../../../../packages/protocol/src/entity-merge" },
    { filePath: "apps/web/src/app/ui/channel-view.tsx", relativePath: "../../../../../packages/protocol/src/entity-merge" },
    { filePath: "apps/web/src/app/ui/dm-conversation.tsx", relativePath: "../../../../../packages/protocol/src/entity-merge" },
    { filePath: "apps/web/src/app/ui/ext/tasks/tasks-view.tsx", relativePath: "../../../../../../packages/protocol/src/entity-merge" },
    { filePath: "packages/reader/src/independent.ts", relativePath: "../../protocol/src/entity-merge" },
  ];

  for (const { filePath, relativePath } of entityMergeTargets) {
    await assertForbidden(filePath, `import { mergeTask } from "@flock/protocol/entity-merge";\nvoid mergeTask;\n`, "D11.11");
    await assertForbidden(filePath, `import { mergeTask } from "${relativePath}";\nvoid mergeTask;\n`, "D11.11");
    await assertForbidden(filePath, `export { mergeTask } from "${relativePath}";\n`, "D11.11");
    await assertForbidden(filePath, `export * from "@flock/protocol/entity-merge";\n`, "D11.11");
    await assertForbidden(filePath, `export async function load() { return import("@flock/protocol/entity-merge"); }\n`, "D11.11");
    await assertForbidden(filePath, `export async function load() { return import("${relativePath}"); }\n`, "D11.11");
    await assertForbidden(filePath, `export async function load() { return import(\`${relativePath}\`); }\n`, "D11.11");
  }

  const extensionTargets: Array<{ filePath: string; relativePath: string }> = [
    { filePath: "packages/protocol/src/registry.ts", relativePath: "../../client/src/ext/tasks" },
    { filePath: "packages/client/src/channel-client.ts", relativePath: "./ext/tasks" },
    { filePath: "packages/client/src/dm/dm-client.ts", relativePath: "../ext/tasks" },
    { filePath: "apps/operator/src/operator/operations.ts", relativePath: "../../../../packages/client/src/ext/tasks" },
    { filePath: "apps/echo-bot/src/echo.ts", relativePath: "../../../packages/client/src/ext/tasks" },
    { filePath: "apps/webhooks/src/main.ts", relativePath: "../../../packages/client/src/ext/tasks" },
    { filePath: "apps/web/src/app/oauth/client-metadata.json/route.ts", relativePath: "../../../ui/ext/tasks/view" },
    { filePath: "apps/web/src/app/ui/channel-view.tsx", relativePath: "./ext/tasks/view" },
    { filePath: "apps/web/src/app/ui/dm-conversation.tsx", relativePath: "./ext/tasks/view" },
    { filePath: "packages/reader/src/independent-tasks.ts", relativePath: "../../client/src/ext/tasks" },
  ];

  for (const { filePath, relativePath } of extensionTargets) {
    await assertForbidden(filePath, `import { TasksClient } from "@flock/client/ext/tasks";\nvoid TasksClient;\n`, "D11.11");
    await assertForbidden(filePath, `import { TasksClient } from "${relativePath}";\nvoid TasksClient;\n`, "D11.11");
    await assertForbidden(filePath, `export * from "@flock/client/ext/tasks";\n`, "D11.11");
    await assertForbidden(filePath, `export async function load() { return import("@flock/client/ext/tasks"); }\n`, "D11.11");
    await assertForbidden(filePath, `export async function load() { return import("${relativePath}"); }\n`, "D11.11");
    await assertForbidden(filePath, `export async function load() { return import(\`${relativePath}\`); }\n`, "D11.11");
  }
});

test("D11.11: allowed boundary modules permit their sanctioned imports without loosening existing rules", async () => {
  await assertAllowed(
    "packages/protocol/src/registry.ts",
    `import extInstallLexicon from "../lexicons/new/flock/ext/install.json";\nimport taskLexicon from "../lexicons/new/flock/ext/tasks/task.json";\nvoid extInstallLexicon; void taskLexicon;\n`,
  );
  await assertAllowed(
    "packages/client/src/ext/tasks/tasks-client.ts",
    `import { mergeTasksSpace } from "@flock/protocol/entity-merge";\nimport { TasksClient } from "./index";\nvoid mergeTasksSpace; void TasksClient;\n`,
  );
  await assertAllowed(
    "packages/client/src/engine.ts",
    `import { TasksClient } from "./ext/tasks";\nvoid TasksClient;\n`,
  );
  await assertAllowed(
    "packages/reader/src/independent-tasks.ts",
    `import { mergeTasksSpace } from "@flock/protocol/entity-merge";\nvoid mergeTasksSpace;\n`,
  );
  await assertAllowed(
    "packages/client/src/tasks-reader-parity.test.ts",
    `import { mergeTasksSpace } from "@flock/protocol/entity-merge";\nimport { TasksClient } from "./ext/tasks";\nvoid mergeTasksSpace; void TasksClient;\n`,
  );
  await assertAllowed(
    "apps/web/src/app/ui/ext/tasks/tasks-view.tsx",
    `import type { MergedTaskView } from "@flock/client/ext/tasks";\nexport type X = MergedTaskView;\n`,
  );
  await assertAllowed(
    "apps/web/src/app/(shell)/w/[authority]/[workspaceSkey]/ext/tasks/page.tsx",
    `import type { MergedTaskView } from "@flock/client/ext/tasks";\nexport type X = MergedTaskView;\n`,
  );
  await assertAllowed(
    "apps/web/src/app/ui/workspace-manager.tsx",
    `import type { TasksSpaceView } from "@flock/client/ext/tasks";\nexport type X = TasksSpaceView;\n`,
  );
  await assertAllowed(
    "apps/web/src/app/ui/client-api.ts",
    `import type { TasksSpaceView } from "@flock/client/ext/tasks";\nexport type X = TasksSpaceView;\n`,
  );
});

test("D11.11: existing browser, node, operator, and DM rules are never shadowed by extension boundaries", async () => {
  // NO_NODE_BUILTINS
  for (const filePath of [
    "packages/protocol/src/registry.ts",
    "packages/protocol/src/entity-merge.ts",
    "packages/client/src/channel-client.ts",
    "packages/client/src/engine.ts",
    "packages/client/src/ext/tasks/tasks-client.ts",
    "apps/web/src/browser/sign-out.ts",
  ]) {
    await assertForbidden(filePath, `import { readFileSync } from "node:fs";\nvoid readFileSync;\n`, "Node built-ins");
  }

  // NO_SERVER_CONFIG
  for (const filePath of [
    "packages/protocol/src/registry.ts",
    "packages/client/src/channel-client.ts",
    "packages/client/src/ext/tasks/tasks-client.ts",
    "packages/client/src/channel-client.test.ts",
    "packages/client/src/tasks-reader-parity.test.ts",
    "apps/web/src/browser/sign-out.ts",
  ]) {
    await assertForbidden(filePath, `import { getConfig } from "@flock/deployment/config";\nvoid getConfig;\n`, "configuration");
  }

  // NO_APP_LAYER
  for (const filePath of [
    "packages/client/src/channel-client.ts",
    "packages/client/src/ext/tasks/tasks-client.ts",
    "packages/client/src/tasks-reader-parity.test.ts",
    "apps/web/src/browser/sign-out.ts",
  ]) {
    await assertForbidden(filePath, `import { messageOf } from "@flock/web/app/ui/client-api";\nvoid messageOf;\n`, "web app's UI");
    await assertForbidden(filePath, `import { messageOf } from "../app/ui/client-api";\nvoid messageOf;\n`, "web app's UI");
  }

  // NO_CLIENT_NODE_ENTRY
  for (const filePath of [
    "packages/client/src/channel-client.ts",
    "packages/client/src/engine.ts",
    "packages/client/src/ext/tasks/tasks-client.ts",
    "apps/web/src/app/ui/channel-view.tsx",
    "apps/web/src/app/ui/ext/tasks/tasks-view.tsx",
    "apps/web/src/app/oauth/client-metadata.json/route.ts",
  ]) {
    await assertForbidden(filePath, `import { nodeTransport } from "@flock/client/node/transport";\nvoid nodeTransport;\n`, "Only a Node process");
    await assertForbidden(filePath, `import { safeFetch } from "@flock/net/fetch";\nvoid safeFetch;\n`, "Only a Node process");
  }

  // MEMBER_LIST_WRITES
  await assertForbidden(
    "apps/operator/src/operator/operations.ts",
    `import { putSpaceMember } from "../atproto/space-ops";\nvoid putSpaceMember;\n`,
    "apps/operator/src/operator/members.ts",
  );
  await assertAllowed(
    "apps/operator/src/operator/members.ts",
    `import { putSpaceMember } from "../atproto/space-ops";\nvoid putSpaceMember;\n`,
  );

  // NO_DM_IMPORT
  await assertForbidden(
    "apps/web/src/app/oauth/client-metadata.json/route.ts",
    `import { DmClient } from "@flock/client/dm/dm-client";\nvoid DmClient;\n`,
    "DM engine",
  );

  // CLIENT_NODE_ENTRY allows node:* and @flock/net, while still enforcing NO_SERVER_CONFIG, NO_APP_LAYER, entity-merge, ext/*
  await assertAllowed(
    "packages/client/src/node/transport.ts",
    `import { readFileSync } from "node:fs";\nimport { safeFetch } from "@flock/net/fetch";\nvoid readFileSync; void safeFetch;\n`,
  );
  await assertForbidden(
    "packages/client/src/node/transport.ts",
    `import { getConfig } from "@flock/deployment/config";\nvoid getConfig;\n`,
    "configuration",
  );
  await assertForbidden(
    "packages/client/src/node/transport.ts",
    `import { mergeTask } from "@flock/protocol/entity-merge";\nvoid mergeTask;\n`,
    "D11.11",
  );
  await assertForbidden(
    "packages/client/src/node/transport.ts",
    `import { TasksClient } from "../ext/tasks";\nvoid TasksClient;\n`,
    "D11.11",
  );
});

test("D11.11: computed dynamic import() specifiers are blocked while static literal dynamic imports remain allowed", async () => {
  for (const filePath of [
    "packages/client/src/channel-client.ts",
    "packages/client/src/engine.ts",
    "packages/client/src/ext/tasks/tasks-client.ts",
    "packages/protocol/src/entity-merge.ts",
    "packages/reader/src/independent-tasks.ts",
    "apps/operator/src/operator/operations.ts",
    "apps/web/src/app/ui/channel-view.tsx",
    "apps/web/src/app/oauth/client-metadata.json/route.ts",
  ]) {
    await assertForbidden(
      filePath,
      `export async function loadMod(name: string) { return import(name); }\n`,
      "non-static dynamic import()",
    );
    await assertForbidden(
      filePath,
      `const base = "merge";\nexport const p = import(\`./entity-\${base}\`);\n`,
      "non-static dynamic import()",
    );
    await assertForbidden(
      filePath,
      `export const p = import("./entity-" + "merge");\n`,
      "non-static dynamic import()",
    );
  }

  // Static literal and expressionless template dynamic imports stay permitted.
  await assertAllowed(
    "packages/client/src/channel-client.ts",
    `export const p = import("./store");\nexport const q = import(\`./store\`);\n`,
  );
  await assertAllowed(
    "apps/web/src/browser/use-browser-session.ts",
    `export const s = import("./account-gate");\n`,
  );
});
