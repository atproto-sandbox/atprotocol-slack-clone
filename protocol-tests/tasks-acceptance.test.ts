import assert from "node:assert/strict";
import test from "node:test";
import { createEngine, type Engine } from "@flock/client/engine";
import {
  EntityNotFoundError,
  type ObservedEntityContext,
  type TasksSpaceView,
} from "@flock/client/ext/tasks";
import { MemoryStore } from "@flock/client/memory-store";
import { OperatorRemoteError } from "@flock/client/operator-client";
import { mintSpaceCredentialWith } from "@flock/protocol/atproto/space-credential-core";
import { AtprotoClient } from "@flock/protocol/atproto/xrpc";
import { opRef } from "@flock/protocol/entity-merge";
import { extSpaceUriFor } from "@flock/protocol/extensions";
import { requestDigest, tidNow } from "@flock/protocol/keys";
import { COLLECTION, SPACE_TYPE } from "@flock/protocol/nsids";
import { readIndependentTasksSpace, type IndependentTasksReadResult } from "@flock/reader/independent-tasks";
import { availablePort, startOperatorServer, type AppServer } from "./support/app-server";
import {
  actorTransport,
  bearerSession,
  startPdsNetwork,
  storeAuthorityGrant,
  type NetworkActor,
  type PdsNetwork,
} from "./support/pds-network";

function omitKeys<T extends Record<string, unknown>>(items: readonly T[], keys: readonly string[]) {
  return items.map((item) =>
    Object.fromEntries(Object.entries(item).filter(([key]) => !keys.includes(key))),
  );
}

function assertTasksParity(engine: TasksSpaceView, reader: IndependentTasksReadResult, label: string): void {
  assert.equal(engine.workspaceUri, reader.workspaceUri, `${label}: workspaceUri`);
  assert.equal(engine.tasksSpaceUri, reader.tasksSpaceUri, `${label}: tasksSpaceUri`);
  assert.equal(engine.enabled, reader.enabled, `${label}: enabled`);
  assert.deepEqual(engine.extInstall, reader.extInstall, `${label}: extInstall`);
  assert.equal(engine.workspaceSnapshotComplete, reader.workspaceSnapshotComplete, `${label}: workspaceSnapshotComplete`);
  assert.equal(engine.complete, reader.complete, `${label}: complete`);
  assert.equal(engine.degraded, reader.degraded, `${label}: degraded`);
  assert.equal(engine.hasUncertainAncestry, reader.hasUncertainAncestry, `${label}: hasUncertainAncestry`);
  assert.deepEqual(
    engine.setAside.map((s) => [s.did, s.permanent]),
    reader.setAside.map((s) => [s.did, s.permanent]),
    `${label}: setAside`,
  );
  assert.deepEqual(engine.rosterMembers, reader.rosterMembers, `${label}: rosterMembers`);
  assert.deepEqual(engine.writerUniverse, reader.writerUniverse, `${label}: writerUniverse`);
  assert.deepEqual(omitKeys(engine.projects, ["observedContext"]), reader.projects, `${label}: projects`);
  assert.deepEqual(omitKeys(engine.tasks, ["observedContext"]), reader.tasks, `${label}: tasks`);
  assert.deepEqual([...engine.commentsByTask.entries()], [...reader.commentsByTask.entries()], `${label}: commentsByTask`);
  assert.deepEqual(omitKeys(engine.activities, ["seen", "dismissed"]), reader.activities, `${label}: activities`);
  assert.equal(engine.orphanedProjectEdits, reader.orphanedProjectEdits, `${label}: orphanedProjectEdits`);
  assert.equal(engine.orphanedTaskEdits, reader.orphanedTaskEdits, `${label}: orphanedTaskEdits`);
  assert.equal(engine.orphanedComments, reader.orphanedComments, `${label}: orphanedComments`);
}

function trackedTransport(
  pds: PdsNetwork,
  actor: NetworkActor,
  options: { now?: () => number } = {},
) {
  const globalCalls = new Map<string, number>();
  const spaceCalls = new Map<string, Map<string, number>>();
  const transport = actorTransport(pds, actor, {
    ...(options.now ? { now: options.now } : {}),
    fetchVia: async (request) => {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/xrpc/")) {
        const method = url.pathname.slice("/xrpc/".length);
        globalCalls.set(method, (globalCalls.get(method) ?? 0) + 1);
        const space = url.searchParams.get("space");
        if (space) {
          let map = spaceCalls.get(space);
          if (!map) {
            map = new Map<string, number>();
            spaceCalls.set(space, map);
          }
          map.set(method, (map.get(method) ?? 0) + 1);
        }
      }
      return fetch(request);
    },
  });

  const snapshotSpace = (space: string): Map<string, number> => new Map(spaceCalls.get(space) ?? []);
  const deltaOf = (before: Map<string, number>, after: Map<string, number>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const [method, total] of after) {
      const delta = total - (before.get(method) ?? 0);
      if (delta > 0) out[method] = delta;
    }
    return out;
  };

  const measure = async <T>(
    space: string,
    run: () => Promise<T>,
  ): Promise<{ result: T; globalByMethod: Record<string, number>; spaceByMethod: Record<string, number> }> => {
    const beforeGlobal = new Map(globalCalls);
    const beforeSpace = snapshotSpace(space);
    const result = await run();
    return {
      result,
      globalByMethod: deltaOf(beforeGlobal, globalCalls),
      spaceByMethod: deltaOf(beforeSpace, spaceCalls.get(space) ?? new Map()),
    };
  };

  return { transport, measure };
}

/**
 * Polls the space authority's `listWriters` until every writer with a committed rev on its own host
 * is listed at >= that rev, eliminating asynchronous `notifyRepoUpdate` lag before parity/incremental assertions.
 */
async function settled(
  pds: PdsNetwork,
  reader: NetworkActor,
  space: string,
  writers: readonly NetworkActor[],
): Promise<void> {
  const transport = actorTransport(pds, reader);
  const credential = await mintSpaceCredentialWith(transport, space);
  const authorityDid = space.slice("at://".length).split("/")[0]!;
  const authority = credential.client(await transport.resolvePds(authorityDid));
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const listed = await authority.query<{ repos: Array<{ $type?: string; repo: string; repoRev?: string }> }>(
      "com.atproto.space.listWriters",
      { space, limit: 500 },
    );
    let current = true;
    for (const writer of writers) {
      const host = credential.client(await transport.resolvePds(writer.did));
      const rev = await host
        .query<{ commit: { rev: string } }>("com.atproto.space.getLatestCommit", { space, repo: writer.did })
        .then((res) => res.commit.rev, () => null);
      if (rev === null) continue;
      const reported = listed.repos.find((entry) => entry.$type === "com.atproto.space.defs#repoWrite" && entry.repo === writer.did)?.repoRev ?? null;
      if (reported === null || reported < rev) {
        current = false;
        break;
      }
    }
    if (current) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Authority never settled listWriters for ${space}.`);
}

test("Tasks real-PDS acceptance & cold reader parity across two PDS hosts (R11f)", { timeout: 10 * 60_000 }, async (t) => {
  const port = await availablePort();
  const pds = await startPdsNetwork("tasks-acceptance", { operatorPort: port });
  let server: AppServer | undefined;

  try {
    server = await startOperatorServer();
    const [
      { authorityClientMetadata, AuthorityReauthorizationRequiredError, restoreAuthorityGrant },
      { createWorkspace },
      { parseWorkspaceRef },
      { registrationDeps },
      { executeOperatorOperation },
      { putAuthorityRecord },
      { getRawDb },
    ] = await Promise.all([
      import("@flock/operator/operator/authority-grant"),
      import("@flock/operator/operator/kinds/create-workspace"),
      import("@flock/operator/operator/actor"),
      import("@flock/operator/operator/registrations"),
      import("@flock/operator/operator/operations"),
      import("@flock/operator/atproto/space-ops"),
      import("@flock/operator/lib/db"),
    ]);

    const operatorService = { serviceRef: pds.serviceRef, endpoint: server.url };
    const fullAuthorityScope = authorityClientMetadata().scope;
    const legacyAuthorityScope = fullAuthorityScope
      .split(" ")
      .filter((scope) => !scope.startsWith(`space:${SPACE_TYPE.tasks}?`))
      .join(" ");
    assert.notEqual(legacyAuthorityScope, fullAuthorityScope);

    const owner = await pds.createActor("taowner", 0);
    const alice = await pds.createActor("taalice", 0);
    const bob = await pds.createActor("tabob", 1);
    const carol = await pds.createActor("tacarol", 1);

    await storeAuthorityGrant(pds.hosts[0], owner.did, "ta-owner-grant");
    const created = await createWorkspace(await restoreAuthorityGrant(owner.did), {
      creator: owner.did,
      name: "Tasks Acceptance",
      operationId: tidNow(),
    }, registrationDeps);
    assert.equal(created.state, "completed");
    const workspace = created.workspace;
    const workspaceRef = parseWorkspaceRef(workspace);
    const tasksSpace = extSpaceUriFor(owner.did, workspaceRef.skey, "tasks");

    const aliceClockOffset = 0;
    const aliceHarness = trackedTransport(pds, alice, { now: () => Date.now() + aliceClockOffset });
    const ownerEngine = createEngine(actorTransport(pds, owner), { operator: operatorService });
    const aliceEngine = createEngine(aliceHarness.transport, { operator: operatorService });
    const bobEngine = createEngine(actorTransport(pds, bob), { operator: operatorService });
    const carolEngine = createEngine(actorTransport(pds, carol), { operator: operatorService });

    for (const [member, eng] of [[alice, aliceEngine], [bob, bobEngine], [carol, carolEngine]] as const) {
      const invited = await ownerEngine.operator!.execute({
        workspace,
        operationId: tidNow(),
        request: { kind: "inviteMember", subject: member.did },
      });
      assert.equal(invited.operation.state, "completed");
      await eng.workspaces.accept(workspace);
    }

    const activeWriters: NetworkActor[] = [owner, alice, bob, carol];
    const compare = async (label: string, targetEngine: Engine = aliceEngine): Promise<TasksSpaceView> => {
      await settled(pds, alice, tasksSpace, activeWriters);
      const [engineView, readerView] = await Promise.all([
        targetEngine.tasks.readSpace(workspace),
        readIndependentTasksSpace(actorTransport(pds, alice), workspace),
      ]);
      assertTasksParity(engineView, readerView, label);
      return engineView;
    };

    // 1. Enable "tasks" extension, cross-host project/task CRUD, all clearable fields, OR-Set add/remove + concurrentSetConflict, comments.
    let project1Uri = "";
    let taskAUri = "";
    await t.test("enableExtension and cross-host CRUD, clearable fields, OR-Sets, concurrentSetConflict, and comments", async () => {
      const enabled = await ownerEngine.operator!.enableExtension(workspace, "tasks");
      assert.equal(enabled.operation.state, "completed");

      const proj1 = await aliceEngine.tasks.createProject(workspace, {
        name: "Platform Core",
        description: "Initial project desc",
        color: "#0044ff",
      });
      project1Uri = proj1.uri;
      await settled(pds, alice, tasksSpace, [alice]);

      const projBobView = await bobEngine.tasks.getProject(workspace, proj1.uri);
      assert.ok(projBobView);
      const projUpdated = await bobEngine.tasks.updateProject(workspace, {
        context: projBobView.observedContext,
        name: "Platform Core v2",
        clearDescription: true,
        color: "#22aa88",
      });
      assert.equal(projUpdated.project.description, undefined);

      const projDeleted = await bobEngine.tasks.deleteProject(workspace, { context: projUpdated.observedContext });
      assert.equal(projDeleted.project.deleted, true);
      const projRestored = await bobEngine.tasks.restoreProject(workspace, { context: projDeleted.observedContext });
      assert.equal(projRestored.project.deleted, false);

      const parentTask = await aliceEngine.tasks.createTask(workspace, {
        title: "Parent epic",
        status: "todo",
        priority: "medium",
        project: proj1.uri,
      });
      const taskA = await aliceEngine.tasks.createTask(workspace, {
        title: "Cross-host task A",
        description: "Initial task description",
        status: "todo",
        priority: "low",
        project: proj1.uri,
        dueDate: "2026-12-15T12:00:00.000Z",
        parent: parentTask.uri,
        assignees: [alice.did],
        labels: ["bug", "core"],
      });
      taskAUri = taskA.uri;
      await settled(pds, alice, tasksSpace, [alice]);

      // Bob (host 1) exercises scalar updates + all 4 clear* flags + OR-Set mutations.
      const bobReadA = await bobEngine.tasks.getTask(workspace, taskAUri);
      assert.ok(bobReadA);
      const bobClearedA = await bobEngine.tasks.updateTask(workspace, {
        context: bobReadA.observedContext,
        title: "Cross-host task A edited",
        status: "in_progress",
        priority: "high",
        clearDescription: true,
        clearProject: true,
        clearDueDate: true,
        clearParent: true,
        addAssignees: [bob.did],
        removeAssignees: [alice.did],
        addLabels: ["backend"],
        removeLabels: ["bug"],
      });
      assert.equal(bobClearedA.task.description, undefined);
      assert.equal(bobClearedA.task.project, undefined);
      assert.equal(bobClearedA.task.dueDate, undefined);
      assert.equal(bobClearedA.task.parent, undefined);
      assert.deepEqual(bobClearedA.task.assignees, [bob.did]);
      assert.deepEqual(bobClearedA.task.labels, ["backend", "core"]);

      // Concurrent OR-Set add vs remove across hosts -> add-wins + concurrentSetConflict Activity.
      await settled(pds, alice, tasksSpace, [alice, bob]);
      const [aliceOrView, bobOrView] = await Promise.all([
        aliceEngine.tasks.getTask(workspace, taskAUri),
        bobEngine.tasks.getTask(workspace, taskAUri),
      ]);
      assert.ok(aliceOrView && bobOrView);
      await aliceEngine.tasks.updateTask(workspace, {
        context: aliceOrView.observedContext,
        removeAssignees: [bob.did],
        removeLabels: ["core"],
      });
      await bobEngine.tasks.updateTask(workspace, {
        context: bobOrView.observedContext,
        addAssignees: [alice.did],
        removeLabels: ["backend"],
      });
      // Now read both, then perform true concurrent add vs remove on "urgent" / carol.did.
      await settled(pds, alice, tasksSpace, [alice, bob]);
      const [aliceSyncOr, bobSyncOr] = await Promise.all([
        aliceEngine.tasks.getTask(workspace, taskAUri),
        bobEngine.tasks.getTask(workspace, taskAUri),
      ]);
      assert.ok(aliceSyncOr && bobSyncOr);
      await aliceEngine.tasks.updateTask(workspace, {
        context: aliceSyncOr.observedContext,
        addLabels: ["triage"],
        addAssignees: [carol.did],
      });
      await bobEngine.tasks.updateTask(workspace, {
        context: bobSyncOr.observedContext,
        removeLabels: ["triage"],
        removeAssignees: [carol.did],
      });

      // Comments: create, update (editedAt), delete, and non-author rejection.
      const cAlice = await aliceEngine.tasks.addComment(workspace, { taskUri: taskAUri, body: "Alice first comment" });
      const cAliceEdited = await aliceEngine.tasks.updateComment(workspace, {
        commentUri: cAlice.uri,
        body: "Alice edited comment",
      });
      assert.ok(cAliceEdited.comment.editedAt);
      const cBob = await bobEngine.tasks.addComment(workspace, { taskUri: taskAUri, body: "Bob temporary comment" });
      await assert.rejects(
        () => bobEngine.tasks.updateComment(workspace, { commentUri: cAlice.uri, body: "Hijack attempt" }),
        /only edit your own comments/,
      );
      await bobEngine.tasks.deleteComment(workspace, cBob.uri);

      const view1 = await compare("step 1 CRUD + OR-Set + comments");
      const mergedA = view1.tasks.find((entry) => entry.uri === taskAUri)!;
      assert.equal(mergedA.labels.includes("triage"), true, "add-wins keeps concurrently added label");
      assert.equal(mergedA.assignees.includes(carol.did), true, "add-wins keeps concurrently added assignee");
      assert.equal(
        mergedA.activities.some((a) => a.kind === "concurrentSetConflict" && a.field === "labels" && a.value === "triage"),
        true,
      );
      assert.equal(
        mergedA.activities.some((a) => a.kind === "concurrentSetConflict" && a.field === "assignees" && a.value === carol.did),
        true,
      );
      assert.deepEqual(view1.commentsByTask.get(taskAUri)?.map((c) => c.body), ["Alice edited comment"]);
    });

    // 2. Concurrent conflicting scalar edits across PDS hosts + LWW + equal-value suppression + restoreFieldVersion.
    await t.test("concurrent scalar edits across hosts raise conflict, suppress equal values, and resolve via restoreFieldVersion", async () => {
      const taskB = await aliceEngine.tasks.createTask(workspace, {
        title: "Scalar conflict base",
        priority: "low",
        project: project1Uri,
      });
      await settled(pds, alice, tasksSpace, [alice]);

      const [aliceView, bobView] = await Promise.all([
        aliceEngine.tasks.getTask(workspace, taskB.uri),
        bobEngine.tasks.getTask(workspace, taskB.uri),
      ]);
      assert.ok(aliceView && bobView);

      await aliceEngine.tasks.updateTask(workspace, {
        context: aliceView.observedContext,
        title: "Alice title wins or loses",
        priority: "urgent",
      });
      await bobEngine.tasks.updateTask(workspace, {
        context: bobView.observedContext,
        title: "Bob concurrent title",
        priority: "urgent",
      });

      const conflictSpace = await compare("step 2 concurrent scalar conflict");
      const mergedB = conflictSpace.tasks.find((entry) => entry.uri === taskB.uri)!;
      assert.equal(mergedB.priority, "urgent");
      assert.equal(mergedB.otherVersions.priority, undefined, "equal canonical values suppress otherVersions");
      assert.equal(mergedB.otherVersions.title?.length, 1);

      const titleOverwrite = mergedB.activities.filter(
        (a) => a.kind === "concurrentFieldOverwrite" && a.field === "title",
      );
      assert.equal(titleOverwrite.length, 1);

      const losingTitle = mergedB.otherVersions.title![0]!;
      await aliceEngine.tasks.restoreFieldVersion(workspace, {
        entityKind: "task",
        context: mergedB.observedContext,
        field: "title",
        version: losingTitle,
      });

      const resolvedSpace = await compare("step 2 after restoreFieldVersion");
      const resolvedB = resolvedSpace.tasks.find((entry) => entry.uri === taskB.uri)!;
      assert.equal(resolvedB.title, losingTitle.value);
      assert.equal(resolvedB.otherVersions.title, undefined);
      assert.equal(
        resolvedB.activities.some((a) => a.kind === "concurrentFieldOverwrite" && a.field === "title"),
        false,
      );
    });

    // 3. Concurrent scalar edit vs deleteTask -> deletion-wins -> restoreTask causally supersedes delete.
    await t.test("concurrent edit vs deleteTask is deletion-wins with Activity, and restoreTask causally supersedes", async () => {
      const taskC = await aliceEngine.tasks.createTask(workspace, { title: "Delete race base" });
      await settled(pds, alice, tasksSpace, [alice]);

      const [aliceView, bobView] = await Promise.all([
        aliceEngine.tasks.getTask(workspace, taskC.uri),
        bobEngine.tasks.getTask(workspace, taskC.uri),
      ]);
      assert.ok(aliceView && bobView);

      await aliceEngine.tasks.deleteTask(workspace, { context: aliceView.observedContext });
      await bobEngine.tasks.updateTask(workspace, {
        context: bobView.observedContext,
        title: "Bob edit concurrent with delete",
      });

      const deletedSpace = await compare("step 3 concurrent delete overwrite");
      const mergedC = deletedSpace.tasks.find((entry) => entry.uri === taskC.uri)!;
      assert.equal(mergedC.deleted, true, "deletion-wins");
      assert.equal(
        mergedC.activities.some((a) => a.kind === "concurrentDeleteOverwrite"),
        true,
      );

      await aliceEngine.tasks.restoreTask(workspace, { context: mergedC.observedContext });
      const restoredSpace = await compare("step 3 after restoreTask");
      const restoredC = restoredSpace.tasks.find((entry) => entry.uri === taskC.uri)!;
      assert.equal(restoredC.deleted, false);
      assert.equal(restoredC.title, "Bob edit concurrent with delete");
      assert.equal(
        restoredC.activities.some((a) => a.kind === "concurrentDeleteOverwrite"),
        false,
      );
    });

    // 4. Two-view Form 1 / Form 2 + Bob edit isolation (D11.5 #2 / R2-H1) over real PDS.
    await t.test("Form 1 / Form 2 + Bob edit isolation over real PDS prevents cross-view chaining leak", async () => {
      const createdD = await aliceEngine.tasks.createTask(workspace, { title: "Form isolation base" });
      await settled(pds, alice, tasksSpace, [alice]);

      const form1View = (await aliceEngine.tasks.getTask(workspace, createdD.uri))!;
      const ctx1: ObservedEntityContext = form1View.observedContext;
      const rootRef = opRef(alice.did, createdD.rkey);
      assert.deepEqual(ctx1.baseClosure, [rootRef]);

      // Bob (host 1) reads and writes B.
      const bobView = (await bobEngine.tasks.getTask(workspace, createdD.uri))!;
      const bobEdit = await bobEngine.tasks.updateTask(workspace, {
        context: bobView.observedContext,
        title: "Bob edit B",
      });
      const bobRef = opRef(bob.did, bobEdit.rkey);
      await settled(pds, alice, tasksSpace, [bob]);

      // Alice's Form 2 refreshes (seeing C0 ∪ {B}) and submits A1.
      const form2Refreshed = (await aliceEngine.tasks.getTask(workspace, createdD.uri))!;
      assert.deepEqual(form2Refreshed.observedContext.baseClosure, [rootRef, bobRef].sort());
      const a1 = await aliceEngine.tasks.updateTask(workspace, {
        context: form2Refreshed.observedContext,
        status: "in_progress",
      });
      const a1Ref = opRef(alice.did, a1.rkey);

      // Stale Form 1 submits A2 using ctx1 -> A2.s MUST be [rootRef] only (no B, no A1).
      const a2 = await aliceEngine.tasks.updateTask(workspace, {
        context: ctx1,
        title: "Alice Form 1 A2",
      });
      const cred = await mintSpaceCredentialWith(actorTransport(pds, alice), tasksSpace);
      const aliceHostClient = cred.client(alice.pds.url);
      const a2Record = await aliceHostClient.query<{ value: { s: string[] } }>("com.atproto.space.getRecord", {
        space: tasksSpace,
        repo: alice.did,
        collection: COLLECTION.taskEdit,
        rkey: a2.rkey,
      });
      assert.deepEqual(a2Record.value.s, [rootRef], "Form 1 A2.s must exclude Bob B and Form 2 A1");
      assert.equal(a2Record.value.s.includes(bobRef), false);
      assert.equal(a2Record.value.s.includes(a1Ref), false);

      // Subsequent same-form write A3 chains onto A2 while still excluding B and A1.
      const a3 = await aliceEngine.tasks.updateTask(workspace, {
        context: ctx1,
        priority: "urgent",
      });
      const a3Record = await aliceHostClient.query<{ value: { s: string[] } }>("com.atproto.space.getRecord", {
        space: tasksSpace,
        repo: alice.did,
        collection: COLLECTION.taskEdit,
        rkey: a3.rkey,
      });
      assert.deepEqual([...a3Record.value.s].sort(), [rootRef, opRef(alice.did, a2.rkey)].sort());
      assert.equal(a3Record.value.s.includes(bobRef), false);
      assert.equal(a3Record.value.s.includes(a1Ref), false);

      const isolationView = await compare("step 4 Form 1 / Form 2 isolation");
      const mergedD = isolationView.tasks.find((entry) => entry.uri === createdD.uri)!;
      assert.equal(mergedD.status, "in_progress");
      assert.equal(mergedD.priority, "urgent");
      assert.deepEqual(mergedD.otherVersions.title?.map((v) => v.value), ["Bob edit B"]);
      assert.equal(
        mergedD.activities.some((a) => a.kind === "concurrentFieldOverwrite" && a.field === "title"),
        true,
      );
    });

    // 5. D14 member removal: intermediate writer B in D -> B -> R removed + missing root orphan drop.
    await t.test("D14 removeMember preserves D -> B -> R dominance and drops orphaned edits/comments on missing root", async () => {
      // D -> B -> R chain: Alice deletes (D), Carol edits (B), Bob restores (R).
      const d14Task = await aliceEngine.tasks.createTask(workspace, { title: "D14 Chain Task" });
      await aliceEngine.tasks.deleteTask(workspace, { context: d14Task.observedContext });
      await settled(pds, alice, tasksSpace, [alice]);

      const carolView = (await carolEngine.tasks.getTask(workspace, d14Task.uri))!;
      const carolMid = await carolEngine.tasks.updateTask(workspace, {
        context: carolView.observedContext,
        title: "Carol mid B",
      });
      await settled(pds, bob, tasksSpace, [carol]);

      const bobView = (await bobEngine.tasks.getTask(workspace, d14Task.uri))!;
      await bobEngine.tasks.restoreTask(workspace, { context: bobView.observedContext });

      // Task created by Carol whose root will disappear under D14, leaving Alice's edit + Bob's comment orphaned.
      const carolRoot = await carolEngine.tasks.createTask(workspace, { title: "Carol root to purge" });
      await settled(pds, alice, tasksSpace, [carol]);
      const aliceOnCarol = (await aliceEngine.tasks.getTask(workspace, carolRoot.uri))!;
      await aliceEngine.tasks.updateTask(workspace, {
        context: aliceOnCarol.observedContext,
        title: "Alice orphan edit",
      });
      await bobEngine.tasks.addComment(workspace, {
        taskUri: carolRoot.uri,
        body: "Bob orphan comment",
      });

      // Ensure Alice holds Carol's records locally before Carol is evicted.
      await compare("step 5 before Carol removal");

      const removed = await ownerEngine.operator!.execute({
        workspace,
        operationId: tidNow(),
        request: { kind: "removeMember", subject: carol.did },
      });
      assert.equal(removed.operation.state, "completed");
      activeWriters.splice(activeWriters.indexOf(carol), 1);

      // Cross-engine D14 Carol removal takes effect immediately without fast-forwarding Alice's clock:
      const postRemovalView = await compare("step 5 after D14 Carol removal");

      assert.equal(postRemovalView.rosterMembers.includes(carol.did), false);
      assert.equal(postRemovalView.writerUniverse.includes(carol.did), false);
      const carolWriterState = await aliceEngine.sync.store.getWriter(tasksSpace, carol.did);
      assert.equal(carolWriterState?.syncedRev ?? null, null);
      assert.deepEqual(carolWriterState?.coverage ?? {}, {});
      assert.equal((await aliceEngine.sync.store.records(tasksSpace, COLLECTION.task, carol.did)).length, 0);
      assert.equal((await aliceEngine.sync.store.records(tasksSpace, COLLECTION.taskEdit, carol.did)).length, 0);

      const survivingChain = postRemovalView.tasks.find((entry) => entry.uri === d14Task.uri)!;
      assert.equal(survivingChain.deleted, false, "R still causally dominates D after intermediate writer B is purged");
      assert.equal(survivingChain.lifecycleFinal, true);
      assert.equal(survivingChain.uncertainAncestry, false);
      assert.equal(survivingChain.closureRefs.includes(opRef(carol.did, carolMid.rkey)), true);

      assert.equal(postRemovalView.tasks.some((entry) => entry.uri === carolRoot.uri), false);
      assert.ok(postRemovalView.orphanedTaskEdits >= 1, "orphaned edit dropped cleanly");
      assert.ok(postRemovalView.orphanedComments >= 1, "orphaned comment dropped cleanly");
    });

    // 6. Warm fresh-Engine reopen, incremental listRepoOps advance, importRepo & clearRecords reset recovery.
    await t.test("warm reopen, incremental listRepoOps, importRepo reset, and clearRecords recovery match cold reader", async () => {
      const sharedStore = new MemoryStore();
      const makeTracked = () => {
        const harness = trackedTransport(pds, alice);
        return {
          harness,
          engine: createEngine(harness.transport, { store: sharedStore }),
        };
      };

      const cold = makeTracked();
      const coldRun = await cold.harness.measure(tasksSpace, () => cold.engine.tasks.readSpace(workspace));
      assert.equal(coldRun.result.complete, true);
      assert.ok((coldRun.spaceByMethod["com.atproto.space.getRepo"] ?? 0) >= 3);
      assert.equal(coldRun.spaceByMethod["com.atproto.space.getRecord"], undefined);

      // Warm fresh-Engine reopen within truthIntervalMs -> exact 1 listWriters on Tasks space, 0 writer calls!
      const warm1 = makeTracked();
      const warmRun = await warm1.harness.measure(tasksSpace, () => warm1.engine.tasks.readSpace(workspace));
      assert.equal(warmRun.spaceByMethod["com.atproto.space.listWriters"], 1);
      assert.equal(warmRun.spaceByMethod["com.atproto.space.getRepo"], undefined);
      assert.equal(warmRun.spaceByMethod["com.atproto.space.listRepoOps"], undefined);
      assert.equal(warmRun.spaceByMethod["com.atproto.space.getLatestCommit"], undefined);
      assert.equal(warmRun.spaceByMethod["com.atproto.space.listRecords"], undefined);
      assert.equal(warmRun.spaceByMethod["com.atproto.space.getRecord"], undefined);
      assertTasksParity(
        warmRun.result,
        await readIndependentTasksSpace(actorTransport(pds, alice), workspace),
        "step 6 warm reopen",
      );

      // Save Bob's STAR snapshot BEFORE his next write so we can test importRepo reset cleanly.
      const starResponse = await bearerSession(bob).fetchHandler(
        `/xrpc/com.atproto.space.getRepo?space=${encodeURIComponent(tasksSpace)}&repo=${encodeURIComponent(bob.did)}`,
        { method: "GET" },
      );
      assert.equal(starResponse.status, 200);
      const savedBobStar = new Uint8Array(await starResponse.arrayBuffer());

      // Bob writes a new task -> warm1 advances via listRepoOps with 0 getRepo calls!
      const bobPreImport = await bobEngine.tasks.createTask(workspace, { title: "Bob pre-import task" });
      await settled(pds, alice, tasksSpace, [bob]);
      const incRun = await warm1.harness.measure(tasksSpace, () => warm1.engine.tasks.readSpace(workspace));
      assert.equal(incRun.spaceByMethod["com.atproto.space.listRepoOps"], 1);
      assert.equal(incRun.spaceByMethod["com.atproto.space.getRepo"], undefined);
      assert.equal(incRun.result.tasks.some((entry) => entry.uri === bobPreImport.uri), true);
      assertTasksParity(
        incRun.result,
        await readIndependentTasksSpace(actorTransport(pds, alice), workspace),
        "step 6 incremental listRepoOps",
      );

      // Reset Bob's Tasks repo via com.atproto.space.importRepo (replaces records & clears oplog).
      const importRes = await bearerSession(bob).fetchHandler("/xrpc/com.atproto.space.importRepo", {
        method: "POST",
        headers: { "content-type": "application/vnd.dasl.star" },
        body: savedBobStar,
      });
      assert.equal(importRes.status, 200, `importRepo answered ${importRes.status}: ${await importRes.text()}`);

      const afterImportRun = await warm1.harness.measure(tasksSpace, () =>
        warm1.engine.tasks.readSpace(workspace, { truthIntervalMs: 0 }),
      );
      // truthIntervalMs: 0 recovers reset Bob via STAR (1) and re-probes unwritten owner (1, RepoNotFound per D11.1 #4), while Alice uses listRepoOps (0 getRepo).
      assert.equal(afterImportRun.spaceByMethod["com.atproto.space.getRepo"], 2, "importRepo reset recovers Bob via STAR (plus unwritten owner re-probe)");
      assert.equal(afterImportRun.spaceByMethod["com.atproto.space.listRepoOps"], 2, "Alice and Bob attempt listRepoOps first; Bob falls back to STAR");
      assert.equal(afterImportRun.result.tasks.some((entry) => entry.uri === bobPreImport.uri), false);
      assertTasksParity(
        afterImportRun.result,
        await readIndependentTasksSpace(actorTransport(pds, alice), workspace),
        "step 6 importRepo reset recovery",
      );

      // Reset Bob's Tasks repo via com.atproto.space.clearRecords, then Bob writes a fresh task.
      const bobClient = new AtprotoClient(bearerSession(bob).fetchHandler);
      await bobClient.procedure("com.atproto.space.clearRecords", { space: tasksSpace, repo: bob.did });
      const postClearTitle = "Bob post-clear task";
      const postClearRkey = tidNow(Date.now() + 50);
      await bobClient.procedure("com.atproto.space.createRecord", {
        space: tasksSpace,
        repo: bob.did,
        collection: COLLECTION.task,
        rkey: postClearRkey,
        record: {
          $type: COLLECTION.task,
          title: postClearTitle,
          status: "todo",
          priority: "medium",
          t: `${String(Date.now() + 50).padStart(15, "0")}.0000`,
          createdAt: new Date().toISOString(),
        },
      });
      await settled(pds, alice, tasksSpace, [bob]);

      // Reopen a fresh Engine over sharedStore after clearRecords -> recovers Bob via STAR cleanly!
      const warm2 = makeTracked();
      const afterClearRun = await warm2.harness.measure(tasksSpace, () => warm2.engine.tasks.readSpace(workspace));
      assert.equal(afterClearRun.spaceByMethod["com.atproto.space.getRepo"], 1, "clearRecords reset recovers Bob via STAR");
      assert.equal(afterClearRun.result.tasks.filter((entry) => entry.repo === bob.did).length, 1);
      assert.equal(afterClearRun.result.tasks.find((entry) => entry.repo === bob.did)?.title, postClearTitle);
      assertTasksParity(
        afterClearRun.result,
        await readIndependentTasksSpace(actorTransport(pds, alice), workspace),
        "step 6 clearRecords reset recovery",
      );
    });

    // 7. Legacy pre-R11 authority grant upgrade (AuthorityReauthorizationRequiredError -> re-authorize -> enableExtension).
    await t.test("legacy pre-R11 authority grant surfaces reauth error and enables Tasks cleanly after re-authorization", async () => {
      const legacyOwner = await pds.createActor("talegowner", 0);
      await storeAuthorityGrant(pds.hosts[0], legacyOwner.did, "ta-leg-init");
      const legacyCreated = await createWorkspace(await restoreAuthorityGrant(legacyOwner.did), {
        creator: legacyOwner.did,
        name: "Legacy Tasks Upgrade",
        operationId: tidNow(),
      }, registrationDeps);
      assert.equal(legacyCreated.state, "completed");
      const legacyWs = legacyCreated.workspace;
      const legacyRef = parseWorkspaceRef(legacyWs);
      const legacyTasksSpace = extSpaceUriFor(legacyOwner.did, legacyRef.skey, "tasks");
      const legacyOwnerEngine = createEngine(actorTransport(pds, legacyOwner), { operator: operatorService });

      assert.equal((await legacyOwnerEngine.operator!.execute({
        workspace: legacyWs,
        operationId: tidNow(),
        request: { kind: "inviteMember", subject: alice.did },
      })).operation.state, "completed");

      // Downgrade authority grant to legacy pre-R11 scope (missing Tasks space scope).
      await storeAuthorityGrant(pds.hosts[0], legacyOwner.did, "ta-leg-downgraded", { scope: legacyAuthorityScope });
      await assert.rejects(
        () => legacyOwnerEngine.operator!.enableExtension(legacyWs, "tasks"),
        (err: unknown) => err instanceof OperatorRemoteError && err.status === 502 && err.code === "AuthoritySessionUnavailable",
      );

      // Simulate an uncleaned/active extension state with a pending operation blocked on missing Tasks scope ->
      // recovery throws AuthorityReauthorizationRequiredError directly.
      const nowIso = new Date().toISOString();
      const fullGrant = await restoreAuthorityGrant(legacyOwner.did);
      await putAuthorityRecord(fullGrant, legacyWs, COLLECTION.extInstall, "tasks", {
        extId: "tasks",
        active: false,
        space: legacyTasksSpace,
        cleanupComplete: false,
        enabledBy: legacyOwner.did,
        enabledAt: nowIso,
        updatedAt: nowIso,
        disabledAt: nowIso,
      });
      const pendingOpId = tidNow();
      const pendingReq = { kind: "removeMember", subject: alice.did };
      getRawDb().prepare(`INSERT INTO operation (workspace, workspace_uri, actor, operation_id, request_hash, request_json, state, steps_json, error, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 'missing tasks scope', ?, ?)`).run(
        legacyOwner.did,
        legacyWs,
        legacyOwner.did,
        pendingOpId,
        requestDigest({ workspace: legacyWs, request: pendingReq }),
        JSON.stringify({ workspace: legacyWs, request: pendingReq }),
        JSON.stringify(["remove-inbox-membership"]),
        Math.floor(Date.now() / 1000) - 60,
        Math.floor(Date.now() / 1000) - 60,
      );
      try {
        await assert.rejects(
          () => executeOperatorOperation({
            did: legacyOwner.did,
            session: fullGrant,
            workspace: legacyRef,
            canRecoverOperations: true,
          }, tidNow(), { kind: "reconcileWorkspace" }, registrationDeps),
          AuthorityReauthorizationRequiredError,
        );
      } finally {
        getRawDb().prepare("DELETE FROM operation WHERE operation_id = ?").run(pendingOpId);
      }

      // Re-authorize with full R11 scope -> enableExtension("tasks") succeeds and Tasks CRUD matches cold reader.
      await storeAuthorityGrant(pds.hosts[0], legacyOwner.did, "ta-leg-regranted");
      const enabled = await legacyOwnerEngine.operator!.enableExtension(legacyWs, "tasks");
      assert.equal(enabled.operation.state, "completed");

      const legacyTask = await aliceEngine.tasks.createTask(legacyWs, { title: "Upgraded workspace task" });
      await settled(pds, alice, legacyTasksSpace, [alice]);
      const legacyView = await aliceEngine.tasks.readSpace(legacyWs);
      const legacyCold = await readIndependentTasksSpace(actorTransport(pds, alice), legacyWs);
      assert.equal(legacyView.tasks.some((entry) => entry.uri === legacyTask.uri), true);
      assertTasksParity(legacyView, legacyCold, "step 7 upgraded legacy workspace");
      await assert.rejects(
        () => aliceEngine.tasks.deleteTask(legacyWs, {
          context: { ...legacyTask.observedContext, entityUri: `${legacyTasksSpace}/${alice.did}/${COLLECTION.task}/3k22222222222` },
        }),
        EntityNotFoundError,
      );

      // Carbon H1: ownerEngine.operator.disableExtension immediately invalidates workspace cache -> readSpace sees enabled:false & createTask rejects.
      assert.equal((await legacyOwnerEngine.tasks.readSpace(legacyWs)).enabled, true);
      const disabled = await legacyOwnerEngine.operator!.disableExtension(legacyWs, "tasks");
      assert.equal(disabled.operation.state, "completed");
      assert.equal((await legacyOwnerEngine.tasks.readSpace(legacyWs)).enabled, false);
      await assert.rejects(
        () => legacyOwnerEngine.tasks.createTask(legacyWs, { title: "Rejected after disableExtension" }),
        /disabled/i,
      );
    });
  } finally {
    await server?.stop();
    await pds.close();
  }
});
