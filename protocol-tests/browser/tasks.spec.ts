import assert from "node:assert/strict";
import test from "node:test";
import { chromium, type Browser, type Page } from "@playwright/test";
import { createEngine } from "@flock/client/engine";
import { extSpaceUriFor } from "@flock/protocol/extensions";
import { advanceHlc } from "@flock/protocol/entity-merge";
import { tidNow } from "@flock/protocol/keys";
import { COLLECTION, SPACE_TYPE } from "@flock/protocol/nsids";
import { availablePort, startAppServer, startOperatorServer, type AppServer } from "../support/app-server";
import { consent, openChannel, signIn } from "../support/browser-app";
import { actorTransport, combinedMemberScopes, mintBrowserSession, startPdsNetwork, storeAuthorityGrant } from "../support/pds-network";

const WORKSPACE_NAME = "Tasks E2E Workspace";

test("Tasks UI end-to-end: legacy authority CTA, enable extension, cross-repo project collisions, board moves, detail edits/comments, concurrent conflicts, restore, and Activity persistence (R11e)", { timeout: 600_000 }, async () => {
  const appPort = await availablePort();
  const operatorPort = await availablePort();
  const pds = await startPdsNetwork("tasks-browser-e2e", { appPort, operatorPort });
  let operator: AppServer | undefined;
  let app: AppServer | undefined;
  let browser: Browser | undefined;

  try {
    operator = await startOperatorServer();
    app = await startAppServer(appPort);

    const [
      { authorityClientMetadata, restoreAuthorityGrant },
      { createWorkspace },
      { registrationDeps },
      { parseWorkspaceRef },
    ] = await Promise.all([
      import("@flock/operator/operator/authority-grant"),
      import("@flock/operator/operator/kinds/create-workspace"),
      import("@flock/operator/operator/registrations"),
      import("@flock/operator/operator/actor"),
    ]);

    const alice = await pds.createActor("tasksalice", 0);
    const bob = await pds.createActor("tasksbob", 1);

    // Provision workspace with a legacy pre-R11 authority grant lacking new.flock.ext.tasks.
    const fullScope = authorityClientMetadata().scope;
    const legacyScope = fullScope
      .split(" ")
      .filter((scope) => !scope.startsWith(`space:${SPACE_TYPE.tasks}?`))
      .join(" ");
    await storeAuthorityGrant(pds.hosts[0], alice.did, "tasks-legacy-auth", { scope: legacyScope });

    const created = await createWorkspace(
      await restoreAuthorityGrant(alice.did),
      { creator: alice.did, name: WORKSPACE_NAME, operationId: tidNow() },
      registrationDeps,
    );
    assert.equal(created.state, "completed");
    const workspaceUri = created.workspace;
    const workspaceSkey = parseWorkspaceRef(workspaceUri).skey;
    const tasksSpace = extSpaceUriFor(alice.did, workspaceSkey, "tasks");
    const generalSelection = { workspace: workspaceUri, skey: created.channel.split("/").at(-1)!, name: "general", visibility: "public" };

    const scopes = await combinedMemberScopes(pds.serviceRef);
    const aliceNodeSession = await mintBrowserSession(alice.pds, alice.did, scopes, "tasks-alice-node");
    const bobNodeSession = await mintBrowserSession(bob.pds, bob.did, scopes, "tasks-bob-node");
    const aliceEngine = createEngine(actorTransport(pds, alice, aliceNodeSession.session), {
      operator: { serviceRef: pds.serviceRef, endpoint: operator.url },
    });
    const bobEngine = createEngine(actorTransport(pds, bob, bobNodeSession.session), {
      operator: { serviceRef: pds.serviceRef, endpoint: operator.url },
    });

    await aliceEngine.channels.send(generalSelection, "Channel stays functional under legacy authority");
    assert.equal((await aliceEngine.operator!.execute({
      workspace: workspaceUri,
      operationId: tidNow(),
      request: { kind: "inviteMember", subject: bob.did },
    })).operation.state, "completed");
    await bobEngine.workspaces.accept(workspaceUri);

    browser = await chromium.launch({ headless: true });
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    pageA.setDefaultTimeout(30_000);
    pageB.setDefaultTimeout(30_000);

    // 1. Alice signs in, attempts Enable Tasks under legacy authority grant -> inline CTA appears without wedging channels!
    await signIn(pageA, app.url, alice, WORKSPACE_NAME);
    await pageA.getByRole("button", { name: "Enable Tasks", exact: true }).click();
    await pageA.getByText(/Workspace authority re-approval required/i).waitFor({ state: "visible" });
    const reauthButton = pageA.getByRole("button", { name: "Re-authorize workspace authority →" });
    await reauthButton.waitFor({ state: "visible" });

    // Channels remain completely usable while Tasks re-approval is pending.
    await openChannel(pageA, "general");
    await pageA.getByText("Channel stays functional under legacy authority", { exact: true }).waitFor({ state: "visible" });

    // Re-authorize authority, return, and retry enabling Tasks.
    await pageA.getByRole("button", { name: new RegExp(WORKSPACE_NAME) }).click();
    await pageA.getByRole("button", { name: "Enable Tasks", exact: true }).click();
    await reauthButton.waitFor({ state: "visible" });
    await reauthButton.click();
    await consent(pageA, alice);
    await pageA.waitForURL(`${app.url}/`, { timeout: 30_000 });
    await pageA.getByRole("button", { name: "Retry same operation ↻" }).click();
    await pageA.getByRole("button", { name: "Tasks", exact: true }).waitFor({ state: "visible", timeout: 30_000 });

    // 2. Seed cross-repo same-rkey same-name projects ("Roadmap" by Alice & "Roadmap" by Bob with identical rkey).
    const sharedProjectRkey = "3k2222222222a";
    const aliceTransport = actorTransport(pds, alice, aliceNodeSession.session);
    const bobTransport = actorTransport(pds, bob, bobNodeSession.session);
    await aliceEngine.tasks.readSpace(workspaceUri, { fresh: true });
    await bobEngine.tasks.readSpace(workspaceUri, { fresh: true });

    const aliceHlc = advanceHlc({ wallNowMs: Date.now() });
    const bobHlc = advanceHlc({ wallNowMs: Date.now() + 1 });
    await aliceTransport.memberClient.procedure("com.atproto.space.createRecord", {
      space: tasksSpace,
      repo: alice.did,
      collection: COLLECTION.taskProject,
      rkey: sharedProjectRkey,
      record: { $type: COLLECTION.taskProject, name: "Roadmap", t: aliceHlc, createdAt: new Date().toISOString() },
    });
    await bobTransport.memberClient.procedure("com.atproto.space.createRecord", {
      space: tasksSpace,
      repo: bob.did,
      collection: COLLECTION.taskProject,
      rkey: sharedProjectRkey,
      record: { $type: COLLECTION.taskProject, name: "Roadmap", t: bobHlc, createdAt: new Date().toISOString() },
    });
    const aliceProjUri = `${tasksSpace}/${alice.did}/${COLLECTION.taskProject}/${sharedProjectRkey}`;
    const bobProjUri = `${tasksSpace}/${bob.did}/${COLLECTION.taskProject}/${sharedProjectRkey}`;
    await aliceEngine.tasks.createTask(workspaceUri, { title: "Alice Roadmap Item", project: aliceProjUri, status: "todo", priority: "high" });
    await bobEngine.tasks.createTask(workspaceUri, { title: "Bob Roadmap Item", project: bobProjUri, status: "todo", priority: "medium" });

    await pageA.getByRole("button", { name: "Tasks", exact: true }).click();
    await pageA.getByRole("button", { name: "Sync ↻" }).click();
    await pageA.getByText("Alice Roadmap Item", { exact: true }).waitFor({ state: "visible" });
    await pageA.getByText("Bob Roadmap Item", { exact: true }).waitFor({ state: "visible" });

    // Navigate to /p/[alice]/[rkey] vs /p/[bob]/[rkey] and verify project scope disambiguation.
    const encAuth = encodeURIComponent(alice.did);
    const encWs = encodeURIComponent(workspaceSkey);
    await pageA.goto(`${app.url}/w/${encAuth}/${encWs}/ext/tasks/p/${encodeURIComponent(alice.did)}/${sharedProjectRkey}`);
    await pageA.getByText("Alice Roadmap Item", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await pageA.getByText("Bob Roadmap Item", { exact: true }).count(), 0);

    await pageA.goto(`${app.url}/w/${encAuth}/${encWs}/ext/tasks/p/${encodeURIComponent(bob.did)}/${sharedProjectRkey}`);
    await pageA.getByText("Bob Roadmap Item", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await pageA.getByText("Alice Roadmap Item", { exact: true }).count(), 0);

    // 3. Create tasks via UI, filter/sort, and perform accessible Kanban board status move.
    await pageA.goto(`${app.url}/w/${encAuth}/${encWs}/ext/tasks/list`);
    await createTaskInUi(pageA, { title: "UI Task High", priority: "high", status: "todo", labels: "ui, r11" });
    await createTaskInUi(pageA, { title: "Backend Task Low", priority: "low", status: "backlog", labels: "api" });

    await pageA.getByLabel("Filter by label").selectOption("ui");
    await pageA.getByText("UI Task High", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await pageA.getByText("Backend Task Low", { exact: true }).count(), 0);
    await pageA.getByLabel("Filter by label").selectOption("all");

    await pageA.getByRole("tab", { name: "Board" }).click();
    await pageA.getByLabel("Move UI Task High to status").selectOption("in_progress");
    await pageA.getByRole("region", { name: "In progress" }).getByText("UI Task High", { exact: true }).waitFor({ state: "visible" });
    await pageA.reload();
    await pageA.getByRole("region", { name: "In progress" }).getByText("UI Task High", { exact: true }).waitFor({ state: "visible" });

    // 4. Task detail edits & author-only comment create/edit/delete.
    await pageA.getByRole("button", { name: "UI Task High", exact: true }).click();
    await pageA.getByLabel("Description").fill("Detailed rollout notes");
    await pageA.getByLabel("Due date").fill("2026-12-01");
    await pageA.getByRole("button", { name: "Save task" }).click();
    await pageA.getByText("Task updated.", { exact: true }).waitFor({ state: "visible" });
    const sharedTaskUrl = pageA.url();

    await signIn(pageB, app.url, bob, WORKSPACE_NAME);
    await pageB.goto(sharedTaskUrl);
    await pageB.getByLabel("Add a comment").fill("Bob initial comment");
    await pageB.getByRole("button", { name: "Post comment" }).click();
    await pageB.getByText("Bob initial comment", { exact: true }).waitFor({ state: "visible" });

    const bobCommentCard = pageB.locator(".tasks-comment-card").filter({ hasText: "Bob initial comment" });
    await bobCommentCard.getByRole("button", { name: "Edit", exact: true }).click();
    const editingBobCommentCard = pageB.locator(".tasks-comment-card").filter({ has: pageB.getByLabel("Edit comment") });
    await editingBobCommentCard.getByLabel("Edit comment").fill("Bob edited comment");
    await editingBobCommentCard.getByRole("button", { name: "Save comment", exact: true }).click();
    await pageB.getByText("Bob edited comment", { exact: true }).waitFor({ state: "visible" });
    await pageB.locator(".tasks-comment-card").filter({ hasText: "Bob edited comment" }).getByText(/edited/).waitFor({ state: "visible" });

    await pageB.getByLabel("Add a comment").fill("Temporary comment");
    await pageB.getByRole("button", { name: "Post comment" }).click();
    const tempCard = pageB.locator(".tasks-comment-card").filter({ hasText: "Temporary comment" });
    await tempCard.waitFor({ state: "visible" });
    await tempCard.getByRole("button", { name: "Delete", exact: true }).click();
    await tempCard.waitFor({ state: "hidden" });

    await pageA.getByRole("button", { name: "Sync ↻" }).click();
    const aliceSeesBobComment = pageA.locator(".tasks-comment-card").filter({ hasText: "Bob edited comment" });
    await aliceSeesBobComment.waitFor({ state: "visible" });
    assert.equal(await aliceSeesBobComment.getByRole("button", { name: "Edit" }).count(), 0);
    assert.equal(await aliceSeesBobComment.getByRole("button", { name: "Delete" }).count(), 0);

    // 5. Two-browser-context concurrent conflicting edit -> Concurrent versions + Activity badge + one-click Restore!
    // Re-sync Bob so both start from the same head, then edit concurrently without syncing.
    await pageB.getByRole("button", { name: "Sync ↻" }).click();
    await pageA.getByLabel("Task title").fill("Alice Concurrent Title");
    await pageA.getByRole("button", { name: "Save task" }).click();
    await pageA.getByText("Task updated.", { exact: true }).waitFor({ state: "visible" });

    await pageB.getByLabel("Task title").fill("Bob Concurrent Title");
    await pageB.getByRole("button", { name: "Save task" }).click();
    await pageB.getByText("Task updated.", { exact: true }).waitFor({ state: "visible" });

    await pageA.getByRole("button", { name: "Sync ↻" }).click();
    const activityTabA = pageA.getByRole("tab", { name: /Activity/ });
    await activityTabA.locator(".tasks-badge").waitFor({ state: "visible" });
    const titleVersions = pageA.locator(".tasks-field").filter({ has: pageA.getByLabel("Task title") }).locator(".tasks-versions-disclosure");
    await titleVersions.locator("summary").click();
    await titleVersions.getByRole("button", { name: "Restore this version" }).click();
    await pageA.getByText("Restored title version.", { exact: true }).waitFor({ state: "visible" });
    await titleVersions.waitFor({ state: "hidden" });

    // 6. Concurrent edit vs delete -> Activity tab Seen, Restore, Dismiss persistence across reload.
    await pageA.getByRole("button", { name: "← Back to tasks" }).click();
    await pageA.getByRole("button", { name: "Backend Task Low", exact: true }).waitFor({ state: "visible" });
    await pageA.getByRole("button", { name: "Backend Task Low", exact: true }).click();
    await pageA.waitForURL((url) => url.pathname.includes("/ext/tasks/t/") && url.toString() !== sharedTaskUrl);
    await pageA.getByLabel("Task title").waitFor({ state: "visible" });
    const deleteTaskUrl = pageA.url();
    await pageB.goto(deleteTaskUrl);
    await pageB.getByLabel("Task title").waitFor({ state: "visible" });

    // Alice edits title concurrently while Bob deletes the same task.
    await pageA.getByLabel("Task title").fill("Alive Concurrent Edit");
    await pageA.getByRole("button", { name: "Save task" }).click();
    await pageA.getByText("Task updated.", { exact: true }).waitFor({ state: "visible" });

    await pageB.getByRole("button", { name: "Delete task" }).click();
    await pageB.getByText("Task deleted.", { exact: true }).waitFor({ state: "visible" });

    await pageA.getByRole("button", { name: "Sync ↻" }).click();
    await pageA.getByText(/This task is deleted/).waitFor({ state: "visible" });
    await activityTabA.click();
    const deleteConflictItem = pageA.locator(".tasks-activity-item").filter({ hasText: "Concurrent delete" });
    await deleteConflictItem.waitFor({ state: "visible" });

    // Mark seen and verify persistence across hard reload.
    await deleteConflictItem.getByRole("button", { name: "Mark seen" }).click();
    await deleteConflictItem.getByRole("button", { name: "Mark seen" }).waitFor({ state: "hidden" });
    await pageA.reload();
    await pageA.locator(".tasks-activity-item").filter({ hasText: "Concurrent delete" }).waitFor({ state: "visible" });
    assert.equal(
      await pageA.locator(".tasks-activity-item").filter({ hasText: "Concurrent delete" }).getByRole("button", { name: "Mark seen" }).count(),
      0,
      "seen state persists across reload",
    );

    // Dismiss and verify persistence across reload, then restore from All filter.
    await pageA.locator(".tasks-activity-item").filter({ hasText: "Concurrent delete" }).getByRole("button", { name: "Dismiss" }).click();
    await pageA.locator(".tasks-activity-item").filter({ hasText: "Concurrent delete" }).waitFor({ state: "hidden" });
    await pageA.reload();
    await pageA.getByLabel("Filter activity by status").waitFor({ state: "visible" });
    await pageA.locator(".tasks-empty, .tasks-activity-list").first().waitFor({ state: "visible" });
    assert.equal(await pageA.locator(".tasks-activity-item").filter({ hasText: "Concurrent delete" }).count(), 0, "dismissed state persists across reload");

    await pageA.getByLabel("Filter activity by status").selectOption("all");
    const dismissedItem = pageA.locator(".tasks-activity-item").filter({ hasText: "Concurrent delete" });
    await dismissedItem.waitFor({ state: "visible" });
    await dismissedItem.getByRole("button", { name: "Restore" }).click();
    await pageA.getByText("Conflict restored.", { exact: true }).waitFor({ state: "visible" });

    await pageA.getByRole("tab", { name: "List" }).click();
    await pageA.getByRole("button", { name: "Alive Concurrent Edit", exact: true }).waitFor({ state: "visible" });

    // 7. Codex #5 & #6: In-app project selector navigation clears projectContext/baseline; restoring Project B's
    // concurrent name never modifies Project A, and saving a project edit diffs against opening baseline.
    const createdProjA = await aliceEngine.tasks.createProject(workspaceUri, { name: "Project Alpha" });
    const createdProjB = await aliceEngine.tasks.createProject(workspaceUri, { name: "Project Beta" });
    const bobSpaceBeforeConflict = await bobEngine.tasks.readSpace(workspaceUri, { fresh: true });
    const bobProjA = bobSpaceBeforeConflict.projects.find((entry) => entry.uri === createdProjA.uri);
    const bobProjB = bobSpaceBeforeConflict.projects.find((entry) => entry.uri === createdProjB.uri);
    assert.ok(bobProjA && bobProjB, "Bob sees both seeded projects before concurrent edits");

    await aliceEngine.tasks.updateProject(workspaceUri, {
      context: createdProjB.observedContext,
      name: "Project Beta Alice",
    });
    await bobEngine.tasks.updateProject(workspaceUri, {
      context: bobProjB.observedContext,
      name: "Project Beta Bob",
    });

    await pageA.getByRole("button", { name: "Sync ↻" }).click();
    const projectSelector = pageA.getByLabel("Project scope");
    await projectSelector.locator(`option[value="${createdProjA.uri}"]`).waitFor({ state: "attached" });
    await projectSelector.selectOption(createdProjA.uri);
    await pageA.getByRole("heading", { name: "Project Alpha", exact: true }).waitFor({ state: "visible" });

    // Edit Project Alpha -> save -> reopen and cancel -> switch via selector (NO page reload) to Project Beta -> restore.
    await pageA.getByRole("button", { name: "Edit project", exact: true }).click();
    await pageA.locator("#edit-project-name").fill("Project Alpha Edited");
    await pageA.getByRole("button", { name: "Save project", exact: true }).click();
    await pageA.getByText("Project updated.", { exact: true }).waitFor({ state: "visible" });
    await pageA.getByRole("heading", { name: "Project Alpha Edited", exact: true }).waitFor({ state: "visible" });

    await pageA.getByRole("button", { name: "Edit project", exact: true }).click();
    await pageA.locator("#edit-project-name").fill("Unsaved Alpha Draft");
    await pageA.getByRole("button", { name: "Cancel", exact: true }).click();
    await pageA.locator("#edit-project-name").waitFor({ state: "hidden" });

    await projectSelector.selectOption(createdProjB.uri);
    const betaVersionDisclosure = pageA.locator(".tasks-project-banner .tasks-versions-disclosure");
    await betaVersionDisclosure.waitFor({ state: "visible" });
    await betaVersionDisclosure.locator("summary").click();
    const restoredBetaName = (await betaVersionDisclosure.locator(".tasks-version-item strong").first().innerText()).trim();
    await betaVersionDisclosure.getByRole("button", { name: "Restore this version" }).click();
    await pageA.getByText("Restored project name.", { exact: true }).waitFor({ state: "visible" });
    await pageA.getByRole("heading", { name: restoredBetaName, exact: true }).waitFor({ state: "visible" });
    await betaVersionDisclosure.waitFor({ state: "hidden" });

    // Switch back to Project Alpha via selector and confirm Project Alpha kept its exact edited name.
    await projectSelector.selectOption(createdProjA.uri);
    await pageA.getByRole("heading", { name: "Project Alpha Edited", exact: true }).waitFor({ state: "visible" });

    // Codex #6 E2E: open Project Alpha editor (no description), Bob adds a description remotely, Alice renames only.
    await pageA.getByRole("button", { name: "Edit project", exact: true }).click();
    await pageA.locator("#edit-project-name").waitFor({ state: "visible" });
    await bobEngine.tasks.updateProject(workspaceUri, {
      context: bobProjA.observedContext,
      description: "Bob remote project notes",
    });
    await pageA.getByRole("button", { name: "Sync ↻" }).click();
    await pageA.locator(".tasks-project-banner").getByText("Bob remote project notes", { exact: true }).waitFor({ state: "visible" });
    await pageA.locator("#edit-project-name").fill("Project Alpha Final");
    await pageA.getByRole("button", { name: "Save project", exact: true }).click();
    await pageA.getByText("Project updated.", { exact: true }).waitFor({ state: "visible" });

    const finalSpace = await aliceEngine.tasks.readSpace(workspaceUri, { fresh: true });
    const finalAlpha = finalSpace.projects.find((entry) => entry.uri === createdProjA.uri);
    const finalBeta = finalSpace.projects.find((entry) => entry.uri === createdProjB.uri);
    assert.equal(finalAlpha?.name, "Project Alpha Final", "Project Alpha retains its own edited name across Project Beta restore");
    assert.equal(finalAlpha?.description, "Bob remote project notes", "saving name-only draft never clears concurrent remote description");
    assert.equal(finalBeta?.name, restoredBetaName);

    await contextA.close();
    await contextB.close();
  } finally {
    await browser?.close();
    await app?.stop();
    await operator?.stop();
    await pds.close();
  }
});

async function createTaskInUi(
  page: Page,
  input: { title: string; status: string; priority: string; labels?: string },
): Promise<void> {
  await page.getByRole("button", { name: "+ New task" }).click();
  await page.getByLabel("Task title").fill(input.title);
  await page.getByLabel("New task status").selectOption(input.status);
  await page.getByLabel("New task priority").selectOption(input.priority);
  if (input.labels) {
    await page.getByLabel("New task labels").fill(input.labels);
  }
  const createForm = page.locator("form").filter({ has: page.getByRole("heading", { name: "New task" }) });
  await createForm.getByRole("button", { name: "Create task" }).click();
  await page.getByRole("button", { name: input.title, exact: true }).waitFor({ state: "visible" });
}
