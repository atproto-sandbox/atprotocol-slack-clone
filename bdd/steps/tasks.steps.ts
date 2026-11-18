import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@playwright/test";
import { openTasksSection, readColdTasks, syncTasksUntil } from "../support/tasks-ui";
import { copyInviteLink, joinFromInvitation, openInviteLinkAndSignIn, ownerInvites } from "../support/ui";
import type { AppWorld } from "../support/world";

Given("a workspace with an admin and a joined member", { timeout: 300_000 }, async function (this: AppWorld) {
  const { owner, invitee: member } = await ownerInvites(this, "member");
  await openInviteLinkAndSignIn(this, member, await copyInviteLink(owner));
  await joinFromInvitation(member);
  await member.page.getByRole("heading", { name: this.workspaceName, exact: true }).waitFor({ state: "visible" });
});

When(
  "the admin enables the Tasks extension and creates project {string} with task {string}",
  { timeout: 300_000 },
  async function (this: AppWorld, projectName: string, taskTitle: string) {
    const owner = await this.actor("owner");
    await owner.page.getByRole("button", { name: "Enable Tasks", exact: true }).click();
    await owner.page.getByRole("button", { name: "Tasks", exact: true }).waitFor({ state: "visible", timeout: 60_000 });
    await owner.page.getByRole("button", { name: "Tasks", exact: true }).click();
    await owner.page.getByRole("button", { name: "+ New project" }).waitFor({ state: "visible", timeout: 60_000 });

    await owner.page.getByRole("button", { name: "+ New project" }).click();
    await owner.page.getByLabel("Project name").fill(projectName);
    const projectForm = owner.page.locator("form").filter({ has: owner.page.getByRole("heading", { name: "Create project" }) });
    await projectForm.getByRole("button", { name: "Create project" }).click();
    await owner.page.getByRole("heading", { name: projectName, exact: true }).waitFor({ state: "visible", timeout: 60_000 });

    await owner.page.getByRole("button", { name: "+ New task" }).click();
    await owner.page.getByLabel("Task title").fill(taskTitle);
    await owner.page.getByLabel("New task status").selectOption("todo");
    await owner.page.getByLabel("New task priority").selectOption("high");
    const taskForm = owner.page.locator("form").filter({ has: owner.page.getByRole("heading", { name: "New task" }) });
    await taskForm.getByRole("button", { name: "Create task" }).click();
    await owner.page.getByRole("button", { name: taskTitle, exact: true }).waitFor({ state: "visible", timeout: 60_000 });

    this.scratch.set("tasks:projectName", projectName);
    this.scratch.set("tasks:taskTitle", taskTitle);
  },
);

When(
  "the member transitions {string} to {string} on the Kanban board and posts comment {string}",
  { timeout: 300_000 },
  async function (this: AppWorld, taskTitle: string, statusLabel: string, commentText: string) {
    const member = await this.actor("member");
    await openTasksSection(member);
    await syncTasksUntil(member, async () => {
      await expect(member.page.getByRole("button", { name: taskTitle, exact: true })).toBeVisible({ timeout: 3_000 });
    });

    await member.page.getByRole("tab", { name: "Board" }).click();
    await member.page.getByLabel(`Move ${taskTitle} to status`).selectOption("in_progress");
    await member.page.getByRole("region", { name: statusLabel }).getByText(taskTitle, { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
    await member.page.reload();
    await member.page.getByRole("region", { name: statusLabel }).getByText(taskTitle, { exact: true }).waitFor({ state: "visible", timeout: 60_000 });

    await member.page.getByRole("button", { name: taskTitle, exact: true }).click();
    await member.page.getByLabel("Add a comment").fill(commentText);
    await member.page.getByRole("button", { name: "Post comment" }).click();
    await member.page.getByText(commentText, { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
    this.scratch.set("tasks:commentText", commentText);
  },
);

Then("the admin sees the task comment {string}", { timeout: 300_000 }, async function (this: AppWorld, commentText: string) {
  const owner = await this.actor("owner");
  const taskTitle = this.scratch.get("tasks:taskTitle") as string;
  await owner.page.getByRole("button", { name: taskTitle, exact: true }).click();
  await syncTasksUntil(owner, async () => {
    await expect(owner.page.getByText(commentText, { exact: true })).toBeVisible({ timeout: 3_000 });
  });
});

Then("the independent cold Tasks reader matches the project, task status, and comment", { timeout: 300_000 }, async function (this: AppWorld) {
  const member = await this.actor("member");
  const projectName = this.scratch.get("tasks:projectName") as string;
  const taskTitle = this.scratch.get("tasks:taskTitle") as string;
  const commentText = this.scratch.get("tasks:commentText") as string;

  const cold = await readColdTasks(this, member);
  assert.equal(cold.enabled, true);
  assert.equal(cold.complete, true);
  assert.equal(cold.degraded, false);
  const project = cold.projects.find((entry) => !entry.deleted && entry.name === projectName);
  assert.ok(project, `cold reader finds project ${projectName}`);
  const task = cold.tasks.find((entry) => !entry.deleted && entry.title === taskTitle);
  assert.ok(task, `cold reader finds task ${taskTitle}`);
  assert.equal(task.status, "in_progress");
  assert.equal(task.priority, "high");
  assert.equal(task.project, project.uri);
  const comments = cold.commentsByTask.get(task.uri) ?? [];
  assert.ok(comments.some((comment) => comment.body === commentText && comment.repo === member.did));
});

Given(
  "two workspace members open the same task {string} in separate browsers",
  { timeout: 300_000 },
  async function (this: AppWorld, taskTitle: string) {
    const { owner, invitee: member } = await ownerInvites(this, "member");
    await openInviteLinkAndSignIn(this, member, await copyInviteLink(owner));
    await joinFromInvitation(member);
    await member.page.getByRole("heading", { name: this.workspaceName, exact: true }).waitFor({ state: "visible" });

    await owner.page.getByRole("button", { name: "Enable Tasks", exact: true }).click();
    await owner.page.getByRole("button", { name: "Tasks", exact: true }).waitFor({ state: "visible", timeout: 60_000 });
    await owner.page.getByRole("button", { name: "Tasks", exact: true }).click();
    await owner.page.getByRole("button", { name: "+ New task" }).waitFor({ state: "visible", timeout: 60_000 });

    await owner.page.getByRole("button", { name: "+ New task" }).click();
    await owner.page.getByLabel("Task title").fill(taskTitle);
    const taskForm = owner.page.locator("form").filter({ has: owner.page.getByRole("heading", { name: "New task" }) });
    await taskForm.getByRole("button", { name: "Create task" }).click();
    await owner.page.getByRole("button", { name: taskTitle, exact: true }).waitFor({ state: "visible", timeout: 60_000 });
    await owner.page.getByRole("button", { name: taskTitle, exact: true }).click();
    await owner.page.getByLabel("Task title").waitFor({ state: "visible" });
    const taskUrl = owner.page.url();

    await openTasksSection(member);
    await member.page.goto(taskUrl);
    await member.page.getByLabel("Task title").waitFor({ state: "visible", timeout: 60_000 });
    await expect(member.page.getByLabel("Task title")).toHaveValue(taskTitle);
    this.scratch.set("tasks:sharedUrl", taskUrl);
  },
);

When(
  "the first member saves title {string} and the second member concurrently saves title {string}",
  { timeout: 300_000 },
  async function (this: AppWorld, firstTitle: string, secondTitle: string) {
    const owner = await this.actor("owner");
    const member = await this.actor("member");

    await owner.page.getByLabel("Task title").fill(firstTitle);
    await owner.page.getByRole("button", { name: "Save task" }).click();
    await owner.page.getByText("Task updated.", { exact: true }).waitFor({ state: "visible", timeout: 60_000 });

    await member.page.getByLabel("Task title").fill(secondTitle);
    await member.page.getByRole("button", { name: "Save task" }).click();
    await member.page.getByText("Task updated.", { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
  },
);

Then(
  "syncing shows a Concurrent versions disclosure on the task and an unseen badge on Activity",
  { timeout: 300_000 },
  async function (this: AppWorld) {
    const owner = await this.actor("owner");
    const titleField = owner.page.locator(".tasks-field").filter({ has: owner.page.getByLabel("Task title") });
    const versions = titleField.locator(".tasks-versions-disclosure");
    const badge = owner.page.getByRole("tab", { name: /Activity/ }).locator(".tasks-badge");

    await syncTasksUntil(owner, async () => {
      await expect(versions).toBeVisible({ timeout: 3_000 });
      await expect(badge).toBeVisible({ timeout: 3_000 });
    });
  },
);

When(
  "the first member marks the Activity conflict seen, dismisses it across reloads, and restores the overwritten version",
  { timeout: 300_000 },
  async function (this: AppWorld) {
    const owner = await this.actor("owner");
    await owner.page.getByRole("tab", { name: /Activity/ }).click();
    const conflictItem = owner.page.locator(".tasks-activity-item").filter({ hasText: /Concurrent/ }).first();
    await conflictItem.waitFor({ state: "visible", timeout: 60_000 });

    await conflictItem.getByRole("button", { name: "Mark seen" }).click();
    await conflictItem.getByRole("button", { name: "Mark seen" }).waitFor({ state: "hidden" });
    await owner.page.reload();
    await owner.page.locator(".tasks-activity-item").filter({ hasText: /Concurrent/ }).first().waitFor({ state: "visible", timeout: 60_000 });
    assert.equal(await owner.page.locator(".tasks-activity-item").first().getByRole("button", { name: "Mark seen" }).count(), 0);

    await owner.page.locator(".tasks-activity-item").first().getByRole("button", { name: "Dismiss" }).click();
    await owner.page.locator(".tasks-activity-item").filter({ hasText: /Concurrent/ }).first().waitFor({ state: "hidden" });
    await owner.page.reload();
    await owner.page.getByLabel("Filter activity by status").waitFor({ state: "visible", timeout: 60_000 });
    await owner.page.locator(".tasks-empty, .tasks-activity-list").first().waitFor({ state: "visible" });
    assert.equal(await owner.page.locator(".tasks-activity-item").count(), 0);

    await owner.page.getByLabel("Filter activity by status").selectOption("all");
    const dismissedItem = owner.page.locator(".tasks-activity-item").filter({ hasText: "Dismissed" }).first();
    await dismissedItem.waitFor({ state: "visible", timeout: 60_000 });
    await dismissedItem.getByRole("button", { name: "Open task →" }).click();

    const titleField = owner.page.locator(".tasks-field").filter({ has: owner.page.getByLabel("Task title") });
    const versions = titleField.locator(".tasks-versions-disclosure");
    await versions.waitFor({ state: "visible", timeout: 60_000 });
    await versions.locator("summary").click();
    const restoredTitle = (await versions.locator(".tasks-version-item strong").first().innerText()).trim();
    this.scratch.set("tasks:restoredTitle", restoredTitle);

    await versions.getByRole("button", { name: "Restore this version" }).click();
    await owner.page.getByText("Restored title version.", { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
    await versions.waitFor({ state: "hidden" });
  },
);

Then(
  "the task displays the restored title with no remaining conflict versions and matches the independent cold reader",
  { timeout: 300_000 },
  async function (this: AppWorld) {
    const owner = await this.actor("owner");
    const member = await this.actor("member");
    const restoredTitle = this.scratch.get("tasks:restoredTitle") as string;

    await expect(owner.page.getByLabel("Task title")).toHaveValue(restoredTitle);
    const titleField = owner.page.locator(".tasks-field").filter({ has: owner.page.getByLabel("Task title") });
    assert.equal(await titleField.locator(".tasks-versions-disclosure").count(), 0);

    const cold = await readColdTasks(this, member);
    assert.equal(cold.enabled, true);
    assert.equal(cold.complete, true);
    assert.equal(cold.hasUncertainAncestry, false);
    const restoredTask = cold.tasks.find((entry) => !entry.deleted && entry.title === restoredTitle);
    assert.ok(restoredTask, `cold reader sees restored title "${restoredTitle}"`);
    assert.deepEqual(restoredTask.otherVersions, {});
  },
);
