import { expect } from "@playwright/test";
import { readIndependentTasksSpace, type IndependentTasksReadResult } from "@flock/reader/independent-tasks";
import { refreshUntil } from "./channels-ui";
import { withIndependentReader } from "./independent-app-ui";
import type { Actor, AppWorld } from "./world";

export async function openTasksSection(actor: Actor): Promise<void> {
  const tasksBtn = actor.page.getByRole("button", { name: "Tasks", exact: true });
  await refreshUntil(actor, () => expect(tasksBtn).toBeVisible({ timeout: 3_000 }));
  await tasksBtn.click();
  await actor.page.getByRole("button", { name: "+ New task" }).waitFor({ state: "visible", timeout: 60_000 });
}

export async function syncTasksUntil(actor: Actor, check: () => Promise<void>, timeoutMs = 150_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
    }
    await actor.page.getByRole("button", { name: "Sync ↻", exact: true }).click();
  }
}

export async function readColdTasks(world: AppWorld, account: Actor): Promise<IndependentTasksReadResult> {
  return withIndependentReader(world, account, (_reader, deps) => readIndependentTasksSpace(deps, world.workspaceUri));
}
