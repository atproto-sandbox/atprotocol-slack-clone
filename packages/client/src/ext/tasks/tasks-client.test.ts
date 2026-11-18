import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { memberspacePolicy } from "@flock/protocol/atproto/space-policy";
import { advanceHlc, buildEditClosure, formatHlc, MAX_ANCESTOR_REFS, opRef } from "@flock/protocol/entity-merge";
import { spaceRecordUri, subjectKey, tasksSpaceUri } from "@flock/protocol/keys";
import { COLLECTION, OPERATOR_METHOD, SPACE_TYPE } from "@flock/protocol/nsids";
import { WORKSPACE_ENVELOPE } from "@flock/protocol/workspace-summary";
import { FakeNetwork } from "@flock/testing/fake-network";
import { createEngine } from "../../engine";
import { IndexedDbStore } from "../../indexeddb-store";
import type { OperatorService } from "../../operator-client";
import { countCalls, transportFor } from "../../testing/engine-fixture";
import {
  EntityNotFoundError,
  StaleEntityContextError,
  TasksExtensionDisabledError,
  TasksWorkspaceUnavailableError,
} from "./index";

Object.assign(globalThis, { IDBKeyRange });

const AUTHORITY = "did:plc:authority";
const ALICE = "did:plc:alice";
const BOB = "did:plc:bob2";
const CAROL = "did:plc:carol";
const TIMESTAMP = "2026-11-16T12:00:00.000Z";
const BASE_MS = 1_700_000_000_000;

async function setupTasksWorkspace(
  network: FakeNetwork,
  options: { members?: readonly string[]; enableTasks?: boolean; skey?: string } = {},
) {
  const members = options.members ?? [ALICE, BOB, CAROL];
  const skey = options.skey ?? "acme";
  const enableTasks = options.enableTasks ?? true;
  if (!network.hasAccount(AUTHORITY)) network.createAccount(AUTHORITY, "pds1");
  const owner = network.clientFor(AUTHORITY);

  const { uri: workspace } = await owner.procedure<unknown, { uri: string }>("com.atproto.space.createSpace", {
    spaceType: SPACE_TYPE.workspace,
    skey,
    policy: memberspacePolicy(),
  });
  await network.writeAs(AUTHORITY, workspace, COLLECTION.workspaceProfile, "self", {
    name: `Workspace ${skey}`,
    createdAt: TIMESTAMP,
  });
  await network.writeAs(AUTHORITY, workspace, COLLECTION.admin, subjectKey(AUTHORITY), {
    subject: AUTHORITY,
    active: true,
    updatedAt: TIMESTAMP,
  });

  const tasksSpace = tasksSpaceUri(AUTHORITY, skey);
  if (enableTasks) {
    await owner.procedure("com.atproto.space.createSpace", {
      spaceType: SPACE_TYPE.tasks,
      skey: tasksSpace.split("/").at(-1)!,
      policy: memberspacePolicy(),
    });
    await network.writeAs(AUTHORITY, workspace, COLLECTION.extInstall, "tasks", {
      extId: "tasks",
      active: true,
      space: tasksSpace,
      cleanupComplete: false,
      enabledBy: AUTHORITY,
      enabledAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    });
  }

  for (const did of [AUTHORITY, ...members]) {
    if (!network.hasAccount(did)) network.createAccount(did, did.endsWith("2") ? "pds2" : "pds1");
    await network.writeAs(AUTHORITY, workspace, COLLECTION.workspaceRoster, subjectKey(did), {
      subject: did,
      active: true,
      updatedAt: TIMESTAMP,
    });
    if (did === AUTHORITY) continue;
    await owner.procedure("com.atproto.memberspace.putMember", { space: workspace, did, read: true, write: true });
    if (enableTasks) {
      await owner.procedure("com.atproto.memberspace.putMember", { space: tasksSpace, did, read: true, write: true });
    }
  }

  return { workspace, tasksSpace, skey };
}

test("D11.5 #2 (R2-H1): Form 1 / Form 2 + Bob regression prevents cross-view chaining leak while preserving same-form sequential chaining", async () => {
  const network = new FakeNetwork();
  const { workspace, tasksSpace } = await setupTasksWorkspace(network, { members: [ALICE, BOB] });

  const aliceEngine = createEngine(transportFor(network, ALICE));
  const bobEngine = createEngine(transportFor(network, BOB));

  const created = await aliceEngine.tasks.createTask(workspace, {
    title: "Initial title",
    status: "todo",
    priority: "none",
  });
  const rootRef = opRef(ALICE, created.rkey);

  // Open Form 1 (ctx1) and Form 2 (ctx2) both observing C0 = [rootRef].
  const form1Task = await aliceEngine.tasks.getTask(workspace, created.uri);
  assert.ok(form1Task);
  const ctx1 = form1Task.observedContext;
  const ctx2Forked = aliceEngine.tasks.forkContext(ctx1);
  assert.notEqual(ctx1.formChainId, ctx2Forked.formChainId);
  assert.equal(Object.isFrozen(ctx1), true);
  assert.equal(Object.isFrozen(ctx1.baseClosure), true);
  assert.deepEqual(ctx1.baseClosure, [rootRef]);

  // Bob reads T0 and writes edit B (`title: "Bob title"`).
  const bobView = await bobEngine.tasks.getTask(workspace, created.uri);
  assert.ok(bobView);
  network.advanceClock(10);
  const bobEdit = await bobEngine.tasks.updateTask(workspace, {
    context: bobView.observedContext,
    title: "Bob title",
  });
  const bobRef = opRef(BOB, bobEdit.rkey);

  // Form 2 refreshes (seeing C0 ∪ {B}) and submits A1 (`status: "in_progress"`).
  const form2Refreshed = await aliceEngine.tasks.getTask(workspace, created.uri);
  assert.ok(form2Refreshed);
  assert.deepEqual(form2Refreshed.observedContext.baseClosure, [rootRef, bobRef].sort());
  network.advanceClock(10);
  const a1 = await aliceEngine.tasks.updateTask(workspace, {
    context: form2Refreshed.observedContext,
    status: "in_progress",
  });
  const a1Ref = opRef(ALICE, a1.rkey);

  // Inspect A1 on PDS: A1 saw B, so A1.s includes [rootRef, bobRef].
  const a1Pds = await network.clientFor(ALICE).query<{ value: { s: string[] } }>("com.atproto.space.getRecord", {
    space: tasksSpace,
    repo: ALICE,
    collection: COLLECTION.taskEdit,
    rkey: a1.rkey,
  });
  assert.deepEqual([...a1Pds.value.s].sort(), [rootRef, bobRef].sort());

  // Form 1 (still holding stale C0 with its own formChainId) submits A2 (`title: "Alice Form 1"`).
  // A2.s MUST contain ONLY C0 ([rootRef]), NEVER Bob's B and NEVER Form 2's A1!
  network.advanceClock(10);
  const a2 = await aliceEngine.tasks.updateTask(workspace, {
    context: ctx1,
    title: "Alice Form 1",
  });
  const a2Ref = opRef(ALICE, a2.rkey);

  const a2Pds = await network.clientFor(ALICE).query<{ value: { s: string[] } }>("com.atproto.space.getRecord", {
    space: tasksSpace,
    repo: ALICE,
    collection: COLLECTION.taskEdit,
    rkey: a2.rkey,
  });
  assert.deepEqual(a2Pds.value.s, [rootRef], "A2.s must NOT leak Bob's B or Form 2's A1");
  assert.equal(a2Pds.value.s.includes(bobRef), false);
  assert.equal(a2Pds.value.s.includes(a1Ref), false);

  // Rapid sequential edit A3 from Form 1 (same formChainId) DOES chain onto A2, still excluding B and A1.
  network.advanceClock(10);
  const a3 = await aliceEngine.tasks.updateTask(workspace, {
    context: ctx1,
    priority: "urgent",
  });
  const a3Pds = await network.clientFor(ALICE).query<{ value: { s: string[] } }>("com.atproto.space.getRecord", {
    space: tasksSpace,
    repo: ALICE,
    collection: COLLECTION.taskEdit,
    rkey: a3.rkey,
  });
  assert.deepEqual([...a3Pds.value.s].sort(), [rootRef, a2Ref].sort(), "rapid sequential same-form edit chains A2 -> A3 without B or A1");
  assert.equal(a3Pds.value.s.includes(bobRef), false);
  assert.equal(a3Pds.value.s.includes(a1Ref), false);

  // Also test passing a2.observedContext (returned from Form 1 write) directly on a subsequent Form 1 write A4:
  network.advanceClock(10);
  const a4 = await aliceEngine.tasks.updateTask(workspace, {
    context: a2.observedContext,
    addLabels: ["urgent-bug"],
  });
  const a4Pds = await network.clientFor(ALICE).query<{ value: { s: string[] } }>("com.atproto.space.getRecord", {
    space: tasksSpace,
    repo: ALICE,
    collection: COLLECTION.taskEdit,
    rkey: a4.rkey,
  });
  assert.deepEqual(
    [...a4Pds.value.s].sort(),
    [rootRef, a2Ref, opRef(ALICE, a3.rkey)].sort(),
    "a2.observedContext remains scoped to Form 1 without leaking B or A1",
  );

  // Because A2 did NOT causally follow Bob's B, Bob's concurrent title edit is NOT silently superseded:
  // both Bob and Alice see proper concurrentFieldOverwrite Activity and otherVersions.title!
  const finalAlice = await aliceEngine.tasks.getTask(workspace, created.uri);
  const finalBob = await bobEngine.tasks.getTask(workspace, created.uri);
  assert.ok(finalAlice && finalBob);
  assert.equal(finalAlice.title, "Alice Form 1");
  assert.equal(finalBob.title, "Alice Form 1");
  assert.equal(finalAlice.status, "in_progress");
  assert.equal(finalAlice.priority, "urgent");
  assert.deepEqual(finalAlice.labels, ["urgent-bug"]);
  assert.deepEqual(finalAlice.otherVersions.title?.map((v) => v.value), ["Bob title"]);
  assert.equal(
    finalAlice.activities.some((a) => a.kind === "concurrentFieldOverwrite" && a.field === "title"),
    true,
  );
});

test("onForeignUpdate reject-stale throws StaleEntityContextError with latest entity and allows same-form rapid edits", async () => {
  const network = new FakeNetwork();
  const { workspace } = await setupTasksWorkspace(network, { members: [ALICE, BOB] });

  const alice = createEngine(transportFor(network, ALICE));
  const bob = createEngine(transportFor(network, BOB));

  const created = await alice.tasks.createTask(workspace, { title: "Draft" });
  const form1 = (await alice.tasks.getTask(workspace, created.uri))!;

  // Same-form rapid edit succeeds under reject-stale.
  const firstEdit = await alice.tasks.updateTask(workspace, {
    context: form1.observedContext,
    priority: "high",
    onForeignUpdate: "reject-stale",
  });
  const secondEdit = await alice.tasks.updateTask(workspace, {
    context: form1.observedContext,
    status: "in_progress",
    onForeignUpdate: "reject-stale",
  });
  assert.equal(secondEdit.task.priority, "high");
  assert.equal(secondEdit.task.status, "in_progress");

  // Bob writes remotely; Form 1 attempting reject-stale must throw StaleEntityContextError without writing.
  const bobRead = (await bob.tasks.getTask(workspace, created.uri))!;
  network.advanceClock(5);
  await bob.tasks.updateTask(workspace, {
    context: bobRead.observedContext,
    title: "Bob updated",
  });

  const beforeCalls = network.calls.get("com.atproto.space.createRecord") ?? 0;
  let caught: unknown;
  try {
    await alice.tasks.updateTask(workspace, {
      context: firstEdit.observedContext,
      title: "Alice stale",
      onForeignUpdate: "reject-stale",
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof StaleEntityContextError);
  assert.equal(caught.entityKind, "task");
  assert.equal(caught.entityUri, created.uri);
  assert.equal((caught.latestEntity as typeof form1).title, "Bob updated");
  assert.equal(caught.foreignOpIds.length, 1);
  assert.equal(network.calls.get("com.atproto.space.createRecord") ?? 0, beforeCalls);

  // User reviews latestEntity and saves cleanly with latestEntity.observedContext.
  const mergedSave = await alice.tasks.updateTask(workspace, {
    context: caught.latestEntity.observedContext,
    title: "Alice merged with Bob",
    onForeignUpdate: "reject-stale",
  });
  assert.equal(mergedSave.task.title, "Alice merged with Bob");
  assert.equal(mergedSave.task.otherVersions.title, undefined);
});

test("TasksClient CRUD lifecycle: projects, tasks, clearable fields, comments, restoreFieldVersion, and Activity IDB persistence", async () => {
  const network = new FakeNetwork();
  const { workspace, tasksSpace } = await setupTasksWorkspace(network, { members: [ALICE, BOB] });

  const aliceIdb = await IndexedDbStore.open(ALICE, new IDBFactory());
  try {
    const alice = createEngine(transportFor(network, ALICE), { store: aliceIdb });
    const bob = createEngine(transportFor(network, BOB));

    const project = await alice.tasks.createProject(workspace, {
      name: "Roadmap",
      description: "Q4 goals",
      color: "#0055ff",
    });
    assert.equal(project.project.name, "Roadmap");
    assert.equal(project.project.description, "Q4 goals");

    const updatedProj = await alice.tasks.updateProject(workspace, {
      context: project.observedContext,
      description: null,
      color: "#ff5500",
    });
    assert.equal(updatedProj.project.description, undefined);
    assert.equal(updatedProj.project.color, "#ff5500");

    const deletedProj = await alice.tasks.deleteProject(workspace, { context: updatedProj.observedContext });
    assert.equal(deletedProj.project.deleted, true);
    const restoredProj = await alice.tasks.restoreProject(workspace, { context: deletedProj.observedContext });
    assert.equal(restoredProj.project.deleted, false);

    const parentTask = await alice.tasks.createTask(workspace, {
      title: "Parent epic",
      project: project.uri,
      assignees: [ALICE],
      labels: ["epic"],
    });
    const childTask = await alice.tasks.createTask(workspace, {
      title: "Child task",
      description: "Initial desc",
      project: project.uri,
      parent: parentTask.uri,
      dueDate: "2026-12-01T00:00:00.000Z",
      assignees: [ALICE, BOB],
      labels: ["bug", "ui"],
    });
    assert.equal(childTask.task.parent, parentTask.uri);
    assert.equal(childTask.task.dueDate, "2026-12-01T00:00:00.000Z");

    const cleared = await alice.tasks.updateTask(workspace, {
      context: childTask.observedContext,
      clearDescription: true,
      clearProject: true,
      clearDueDate: true,
      clearParent: true,
      removeAssignees: [BOB],
      addLabels: ["p1"],
      removeLabels: ["ui"],
    });
    assert.equal(cleared.task.description, undefined);
    assert.equal(cleared.task.project, undefined);
    assert.equal(cleared.task.dueDate, undefined);
    assert.equal(cleared.task.parent, undefined);
    assert.deepEqual(cleared.task.assignees, [ALICE]);
    assert.deepEqual(cleared.task.labels, ["bug", "p1"]);

    // Comments: add, update, delete, reject edit by non-author, reject comment on deleted task.
    const c1 = await alice.tasks.addComment(workspace, { taskUri: childTask.uri, body: "First comment" });
    network.advanceClock(10);
    const c1Edited = await alice.tasks.updateComment(workspace, { commentUri: c1.uri, body: "Edited comment" });
    assert.equal(c1Edited.comment.body, "Edited comment");
    assert.ok(c1Edited.comment.editedAt);
    await assert.rejects(
      () => bob.tasks.updateComment(workspace, { commentUri: c1.uri, body: "Hijack" }),
      /only edit your own comments/,
    );
    await alice.tasks.deleteComment(workspace, c1.uri);
    const detailAfterDelete = await alice.tasks.getTask(workspace, childTask.uri);
    assert.deepEqual(detailAfterDelete?.comments, []);

    // Deleting a task prevents new comments, restoring re-allows them.
    const deletedTask = await alice.tasks.deleteTask(workspace, { context: cleared.observedContext });
    assert.equal(deletedTask.task.deleted, true);
    await assert.rejects(
      () => alice.tasks.addComment(workspace, { taskUri: childTask.uri, body: "Blocked" }),
      /deleted task/,
    );
    const restoredTask = await alice.tasks.restoreTask(workspace, { context: deletedTask.observedContext });
    assert.equal(restoredTask.task.deleted, false);

    // Trigger concurrent conflict to test restoreFieldVersion + IDB Activity seen/dismiss persistence.
    const bobView = (await bob.tasks.getTask(workspace, childTask.uri))!;
    const aliceView = (await alice.tasks.getTask(workspace, childTask.uri))!;
    network.advanceClock(10);
    await bob.tasks.updateTask(workspace, { context: bobView.observedContext, title: "Bob Version" });
    network.advanceClock(10);
    await alice.tasks.updateTask(workspace, { context: aliceView.observedContext, title: "Alice Version" });

    const spaceView1 = await alice.tasks.readSpace(workspace);
    assert.equal(spaceView1.unseenActivityCount, 1);
    assert.equal(spaceView1.activities.length, 1);
    assert.equal(spaceView1.activities[0]!.seen, false);
    assert.equal(spaceView1.activities[0]!.dismissed, false);

    const conflictTask = spaceView1.tasks.find((t) => t.uri === childTask.uri)!;
    const losingVersion = conflictTask.otherVersions.title![0]!;
    assert.equal(losingVersion.value, "Bob Version");

    // Mark seen & dismiss in IndexedDbStore, verify warm reopen retains state, and Bob's store is isolated.
    await alice.tasks.markActivitySeen(workspace, [spaceView1.activities[0]!.id]);
    const afterSeen = await alice.tasks.listActivity(workspace);
    assert.equal(afterSeen.unseenCount, 0);
    assert.equal(afterSeen.activities[0]!.seen, true);

    await alice.tasks.dismissActivity(workspace, [spaceView1.activities[0]!.id]);
    const warmAlice = createEngine(transportFor(network, ALICE), { store: aliceIdb });
    const afterReopen = await warmAlice.tasks.listActivity(workspace);
    assert.equal(afterReopen.unseenCount, 0);
    assert.equal(afterReopen.activities[0]!.seen, true);
    assert.equal(afterReopen.activities[0]!.dismissed, true);

    const bobActivity = await bob.tasks.listActivity(workspace);
    assert.equal(bobActivity.unseenCount, 1, "Activity seen/dismissed state is per-DID");

    // Restore Bob's losing title via restoreFieldVersion.
    await warmAlice.tasks.restoreFieldVersion(workspace, {
      entityKind: "task",
      context: conflictTask.observedContext,
      field: "title",
      version: losingVersion,
    });
    const resolvedTask = (await warmAlice.tasks.getTask(workspace, childTask.uri))!;
    assert.equal(resolvedTask.title, "Bob Version");
    assert.equal(resolvedTask.otherVersions.title, undefined);
    assert.equal(resolvedTask.activities.length, 0);
    assert.ok(tasksSpace.length > 0);
  } finally {
    aliceIdb.close();
  }
});

test("TasksClient retries cross-device TID collision (RecordAlreadyExists) while preserving s", async () => {
  const network = new FakeNetwork();
  const { workspace, tasksSpace } = await setupTasksWorkspace(network, { members: [ALICE] });
  const alice = createEngine(transportFor(network, ALICE));

  const created = await alice.tasks.createTask(workspace, { title: "Collision target" });
  const initialTask = (await alice.tasks.getTask(workspace, created.uri))!;

  let createFailures = 0;
  const originalFetch = network.fetchEndpoint;
  const clientTransport = transportFor(network, ALICE);
  const originalMemberProcedure = clientTransport.memberClient.procedure.bind(clientTransport.memberClient);
  const collisionEngine = createEngine({
    ...clientTransport,
    fetchEndpoint: originalFetch,
    memberClient: {
      ...clientTransport.memberClient,
      query: clientTransport.memberClient.query.bind(clientTransport.memberClient),
      procedure: async <TInput, TOutput>(method: string, input: TInput, params?: Record<string, string>) => {
        if (method === "com.atproto.space.createRecord" && createFailures < 2) {
          createFailures += 1;
          // Simulate another device having already written the colliding TID to the PDS.
          const payload = input as { space: string; collection: string; rkey: string };
          if (payload.space === tasksSpace && payload.collection === COLLECTION.taskEdit) {
            await network.writeAs(ALICE, tasksSpace, COLLECTION.taskEdit, payload.rkey, {
              subject: created.uri,
              t: formatHlc({ ms: BASE_MS, counter: 0 }),
              s: [opRef(ALICE, created.rkey)],
              priority: "low",
            });
          }
        }
        return originalMemberProcedure<TInput, TOutput>(method, input, params);
      },
    } as typeof clientTransport.memberClient,
  });

  const result = await collisionEngine.tasks.updateTask(workspace, {
    context: initialTask.observedContext,
    title: "Succeeded after collision",
  });
  assert.equal(createFailures, 2);
  assert.equal(result.task.title, "Succeeded after collision");

  const stored = await network.clientFor(ALICE).query<{ value: { s: string[] } }>("com.atproto.space.getRecord", {
    space: tasksSpace,
    repo: ALICE,
    collection: COLLECTION.taskEdit,
    rkey: result.rkey,
  });
  assert.deepEqual(stored.value.s, initialTask.observedContext.baseClosure);
});

test("TasksClient recovers cleanly from ambiguous write timeout/drop on subsequent sync", async () => {
  const network = new FakeNetwork();
  const { workspace, tasksSpace } = await setupTasksWorkspace(network, { members: [ALICE] });
  const alice = createEngine(transportFor(network, ALICE));

  const task = await alice.tasks.createTask(workspace, { title: "Ambiguous base" });
  const beforeClock = (await alice.writeQueue.reserveStamp(ALICE)).hlc;

  // Simulate createRecord succeeding on PDS, then HTTP response dropping before client receives ack.
  const baseTransport = transportFor(network, ALICE);
  const baseProc = baseTransport.memberClient.procedure.bind(baseTransport.memberClient);
  let dropNext = true;
  const flakyEngine = createEngine({
    ...baseTransport,
    memberClient: {
      ...baseTransport.memberClient,
      query: baseTransport.memberClient.query.bind(baseTransport.memberClient),
      procedure: async <TInput, TOutput>(method: string, input: TInput, params?: Record<string, string>) => {
        const res = await baseProc<TInput, TOutput>(method, input, params);
        if (method === "com.atproto.space.createRecord" && dropNext) {
          dropNext = false;
          throw new Error("Socket timeout after PDS commit");
        }
        return res;
      },
    } as typeof baseTransport.memberClient,
  }, { store: alice.sync.store });

  await assert.rejects(
    () =>
      flakyEngine.tasks.updateTask(workspace, {
        context: task.observedContext,
        title: "Committed remotely before drop",
      }),
    /Socket timeout/,
  );

  // Even when a brand-new Engine (fresh local store, simulating device/tab restart) syncs,
  // it reconciles the ambiguously committed edit AND advances clock state monotonically past it.
  const recoveredEngine = createEngine(transportFor(network, ALICE));
  const recovered = await recoveredEngine.tasks.getTask(workspace, task.uri);
  assert.ok(recovered);
  assert.equal(recovered.title, "Committed remotely before drop");

  const nextStamp = await recoveredEngine.writeQueue.reserveStamp(ALICE);
  assert.ok(nextStamp.hlc > recovered.maxHlc);
  assert.ok(nextStamp.hlc > beforeClock);

  // Original engine also reconciles on next readSpace even if listing lagged.
  network.setListingLag(tasksSpace, true);
  const reconciledSame = await flakyEngine.tasks.getTask(workspace, task.uri);
  assert.equal(reconciledSame?.title, "Committed remotely before drop");
});

test("TasksClient handles 256/257 saturation, D14 purged inherited refs, disabled workspace, and envelope caps", async () => {
  const network = new FakeNetwork();
  const { workspace, tasksSpace } = await setupTasksWorkspace(network, { members: [ALICE, BOB] });
  const alice = createEngine(transportFor(network, ALICE));
  const bob = createEngine(transportFor(network, BOB));

  // Build a task with 254 edits (total 255 ops with root), then test exact 255 -> 256 (still final) -> 257 ancestors (saturated!).
  const created = await alice.tasks.createTask(workspace, { title: "Hot task" });
  network.advanceClock(1);
  const ops: Array<{ repo: string; rkey: string; t: string; s?: string[]; sTruncated?: boolean; isRoot?: boolean }> = [
    { repo: ALICE, rkey: created.rkey, t: created.task.maxHlc, isRoot: true },
  ];
  let lastT = created.task.maxHlc;
  const writeSeedEdit = async (repo: string, idx: number) => {
    const queue = repo === ALICE ? alice.writeQueue : bob.writeQueue;
    const rkey = (await queue.reserveStamp(repo)).tid;
    lastT = advanceHlc({ wallNowMs: BASE_MS + idx * 10, observedTs: [lastT] });
    const closure = buildEditClosure({ observedOps: ops });
    await network.writeAs(repo, tasksSpace, COLLECTION.taskEdit, rkey, {
      subject: created.uri,
      t: lastT,
      s: closure.s,
      ...(closure.sTruncated ? { sTruncated: true } : {}),
      title: `Seed ${idx}`,
    });
    ops.push({ repo, rkey, t: lastT, s: closure.s, sTruncated: closure.sTruncated });
    return rkey;
  };

  for (let i = 1; i <= 254; i += 1) {
    await writeSeedEdit(i % 2 === 0 ? ALICE : BOB, i);
  }

  // Edit with 255 ancestors -> s.length = 255, total closureRefs = 256, stays non-truncated & final!
  const before256 = (await alice.tasks.getTask(workspace, created.uri))!;
  assert.equal(before256.closureRefs.length, 255);
  assert.equal(before256.uncertainAncestry, false);

  const edit255Anc = await alice.tasks.updateTask(workspace, {
    context: before256.observedContext,
    title: "Ancestors 255",
  });
  assert.equal(edit255Anc.task.uncertainAncestry, false);
  assert.equal(edit255Anc.task.conflictFinal, true);
  assert.equal(edit255Anc.task.closureRefs.length, MAX_ANCESTOR_REFS);

  // Edit with exact 256 ancestors -> s.length = 256, STILL non-truncated & final per D11.4!
  const edit256Anc = await alice.tasks.updateTask(workspace, {
    context: edit255Anc.observedContext,
    title: "Exact 256 ancestors",
  });
  const rec256Anc = await network.clientFor(ALICE).query<{ value: { s: string[]; sTruncated?: boolean } }>("com.atproto.space.getRecord", {
    space: tasksSpace,
    repo: ALICE,
    collection: COLLECTION.taskEdit,
    rkey: edit256Anc.rkey,
  });
  assert.equal(rec256Anc.value.s.length, MAX_ANCESTOR_REFS);
  assert.equal(rec256Anc.value.sTruncated, undefined);
  assert.equal(edit256Anc.task.uncertainAncestry, false);
  assert.equal(edit256Anc.task.lifecycleFinal, true);
  assert.equal(edit256Anc.task.conflictFinal, true);
  assert.equal(edit256Anc.task.closureRefs.length, MAX_ANCESTOR_REFS + 1);

  // Edit with 257 ancestors -> saturates (> 256), caps s at 256, and persists sTruncated: true!
  const edit257Anc = await alice.tasks.updateTask(workspace, {
    context: edit256Anc.observedContext,
    title: "Saturated 257 ancestors",
  });
  const rec257Anc = await network.clientFor(ALICE).query<{ value: { s: string[]; sTruncated?: boolean } }>("com.atproto.space.getRecord", {
    space: tasksSpace,
    repo: ALICE,
    collection: COLLECTION.taskEdit,
    rkey: edit257Anc.rkey,
  });
  assert.equal(rec257Anc.value.s.length, MAX_ANCESTOR_REFS);
  assert.equal(rec257Anc.value.sTruncated, true);
  assert.equal(edit257Anc.task.uncertainAncestry, true);
  assert.equal(edit257Anc.task.lifecycleFinal, false);
  assert.equal(edit257Anc.task.conflictFinal, false);

  const saturatedView = await alice.tasks.readSpace(workspace);
  assert.equal(saturatedView.hasUncertainAncestry, true);
  assert.equal(saturatedView.degraded, true);
  assert.ok(saturatedView.degradedReasons.some((r) => r.includes("causal history limit")));

  // D14 writer eviction: D (Alice) -> B (Bob) -> R (Alice), then Bob removed under D14 ->
  // Alice's subsequent edit retains opRef(Bob) in inheritedRefs and keeps D ->* R causal dominance final!
  const d14Task = await alice.tasks.createTask(workspace, { title: "D14 root" });
  const delOp = await alice.tasks.deleteTask(workspace, { context: d14Task.observedContext });
  const bobD14Read = (await bob.tasks.getTask(workspace, d14Task.uri))!;
  const bobD14Edit = await bob.tasks.updateTask(workspace, { context: bobD14Read.observedContext, title: "Bob mid" });
  const aliceAfterBob = (await alice.tasks.getTask(workspace, d14Task.uri))!;
  const restoreOp = await alice.tasks.restoreTask(workspace, { context: aliceAfterBob.observedContext });

  await network.writeAs(AUTHORITY, workspace, COLLECTION.workspaceRoster, subjectKey(BOB), {
    subject: BOB,
    active: false,
    updatedAt: TIMESTAMP,
  });
  await network.clientFor(AUTHORITY).procedure("com.atproto.memberspace.removeMember", { space: tasksSpace, did: BOB });
  network.advanceClock(alice.sync.options.truthIntervalMs);

  const postPurgeRead = (await alice.tasks.getTask(workspace, d14Task.uri))!;
  assert.equal(postPurgeRead.deleted, false);
  assert.equal(postPurgeRead.uncertainAncestry, false);
  assert.equal(postPurgeRead.lifecycleFinal, true);
  assert.equal(postPurgeRead.closureRefs.includes(opRef(BOB, bobD14Edit.rkey)), true);

  const postPurgeEdit = await alice.tasks.updateTask(workspace, {
    context: postPurgeRead.observedContext,
    title: "After Bob D14 purge",
  });
  const postPurgeEditRec = await network.clientFor(ALICE).query<{ value: { s: string[] } }>("com.atproto.space.getRecord", {
    space: tasksSpace,
    repo: ALICE,
    collection: COLLECTION.taskEdit,
    rkey: postPurgeEdit.rkey,
  });
  assert.equal(postPurgeEditRec.value.s.includes(opRef(BOB, bobD14Edit.rkey)), true, "purged D14 opRef inherited");
  assert.equal(postPurgeEditRec.value.s.includes(opRef(ALICE, delOp.rkey)), true);
  assert.equal(postPurgeEditRec.value.s.includes(opRef(ALICE, restoreOp.rkey)), true);

  // Disabled workspace behavior + envelope check on disabled workspace.
  const disabledWs = await setupTasksWorkspace(network, { members: [ALICE], enableTasks: false, skey: "disabled" });
  const disabledView = await alice.tasks.readSpace(disabledWs.workspace);
  assert.equal(disabledView.enabled, false);
  assert.equal(disabledView.complete, true);
  await assert.rejects(
    () => alice.tasks.createTask(disabledWs.workspace, { title: "Should fail" }),
    TasksExtensionDisabledError,
  );
  await assert.rejects(
    () => alice.tasks.deleteTask(workspace, { context: { ...before256.observedContext, entityUri: spaceRecordUri(tasksSpace, ALICE, COLLECTION.task, "3k22222222222") } }),
    EntityNotFoundError,
  );

  // Envelope: > WORKSPACE_ENVELOPE.taskProjects (100) marks degraded without dropping.
  const envWs = await setupTasksWorkspace(network, { members: [ALICE], skey: "envelope" });
  for (let i = 0; i <= WORKSPACE_ENVELOPE.taskProjects; i += 1) {
    await alice.tasks.createProject(envWs.workspace, { name: `Proj ${i}` });
  }
  const envView = await alice.tasks.readSpace(envWs.workspace);
  assert.equal(envView.projects.length, WORKSPACE_ENVELOPE.taskProjects + 1);
  assert.equal(envView.degraded, true);
  assert.ok(envView.degradedReasons.some((r) => r.includes("task projects")));
});

test("own optimistic writes preserve listRepoOps LtHash delta continuity and disableExtension invalidates workspace immediately", async () => {
  const network = new FakeNetwork();
  const { workspace, tasksSpace } = await setupTasksWorkspace(network, { members: [AUTHORITY, ALICE] });

  const operatorService: OperatorService = {
    serviceRef: "did:web:operator.test#atproto_flock_operator",
    endpoint: "https://operator.test",
  };
  const ownerTransport = transportFor(network, AUTHORITY);
  const ownerWithOperator = {
    ...ownerTransport,
    fetchEndpoint: async (request: Request) => {
      const url = new URL(request.url);
      if (url.origin !== operatorService.endpoint) return network.fetchEndpoint(request);
      if (url.pathname === `/xrpc/${OPERATOR_METHOD.execute}`) {
        const body = await request.json() as { workspace: string; request: { kind: string; extId?: string } };
        if (body.request.kind === "disableExtension" && body.request.extId === "tasks") {
          await network.writeAs(AUTHORITY, body.workspace, COLLECTION.extInstall, "tasks", {
            extId: "tasks",
            space: tasksSpace,
            active: false,
            enabledBy: AUTHORITY,
            enabledAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
            disabledAt: TIMESTAMP,
          });
          return Response.json({
            operation: {
              operationId: "op-disable",
              workspace: body.workspace,
              kind: "disableExtension",
              state: "completed",
              createdAt: TIMESTAMP,
              updatedAt: TIMESTAMP,
              steps: [],
            },
          });
        }
      }
      return Response.json({ error: "NotFound", message: "unknown operator method" }, { status: 404 });
    },
  };

  const alice = createEngine(transportFor(network, ALICE));
  await alice.tasks.createTask(workspace, { title: "Initial seed task" });
  const initialRead = await alice.tasks.readSpace(workspace);
  assert.equal(initialRead.complete, true);
  assert.equal(initialRead.tasks.length, 1);

  // Carbon L1: own optimistic writes (create + double update) capture optimisticOverlay and next readSpace
  // reconciles via listRepoOps delta with ZERO full STAR getRepo downloads!
  const created = await alice.tasks.createTask(workspace, { title: "Optimistic Task" });
  const u1 = await alice.tasks.updateTask(workspace, { context: created.observedContext, title: "Optimistic v2" });
  await alice.tasks.updateTask(workspace, { context: u1.observedContext, title: "Optimistic v3" });

  let syncedView!: Awaited<ReturnType<typeof alice.tasks.readSpace>>;
  const calls = await countCalls(network, async () => {
    syncedView = await alice.tasks.readSpace(workspace);
  });
  assert.equal(syncedView.complete, true);
  assert.equal(syncedView.tasks.find((t) => t.uri === created.uri)?.title, "Optimistic v3");
  assert.equal(calls["com.atproto.space.getRepo"] ?? 0, 0, "optimistic overlay allows listRepoOps without getRepo STAR fallback");
  assert.ok((calls["com.atproto.space.listRepoOps"] ?? 0) >= 1, "verified via incremental listRepoOps");

  // Carbon H1: Owner disables Tasks via OperatorClient -> same engine immediately sees enabled: false and rejects createTask without clock advance.
  const owner = createEngine(ownerWithOperator, { operator: operatorService });
  await owner.tasks.createTask(workspace, { title: "Before disable" });
  const ownerEnabled = await owner.tasks.readSpace(workspace);
  assert.equal(ownerEnabled.enabled, true);

  await owner.operator!.disableExtension(workspace, "tasks");
  const ownerAfterDisable = await owner.tasks.readSpace(workspace);
  assert.equal(ownerAfterDisable.enabled, false);
  await assert.rejects(
    () => owner.tasks.createTask(workspace, { title: "Must reject after disable" }),
    TasksExtensionDisabledError,
  );
});

test("workspaces.summary invalidates workspace snapshot cleanly and cross-engine disableExtension handles warm member 10m expiry and authority writes/deleteComment (Codex R2-#3 + Carbon R2-M2)", async () => {
  const network = new FakeNetwork();
  const { workspace, tasksSpace } = await setupTasksWorkspace(network, { members: [ALICE, BOB] });

  const owner = createEngine(transportFor(network, AUTHORITY));
  const alice = createEngine(transportFor(network, ALICE));
  const bob = createEngine(transportFor(network, BOB));

  // 1. Seed warm caches with Tasks enabled and zero writer repos on tasksSpace!
  const ownerInit = await owner.tasks.readSpace(workspace);
  assert.equal(ownerInit.enabled, true);
  assert.equal(ownerInit.tasks.length, 0);
  const bobInit = await bob.tasks.readSpace(workspace);
  assert.equal(bobInit.enabled, true);
  assert.equal(bobInit.tasks.length, 0);

  // Create one comment as authority before disabling so we can test authority deleteComment refusal too.
  const seededTask = await owner.tasks.createTask(workspace, { title: "Owner pre-disable task" });
  const seededComment = await owner.tasks.addComment(workspace, {
    taskUri: seededTask.uri,
    body: "Owner pre-disable comment",
  });

  // Also test zero-writer-repo summary coherency on alice (never wrote to tasksSpace, read empty tasksSpace).
  assert.equal((await alice.tasks.readSpace(workspace)).enabled, true);

  // 2. Disable Tasks out-of-band on PDS (simulating another admin/engine) and revoke non-authority members just like extension-access removeExtraMembers.
  await network.writeAs(AUTHORITY, workspace, COLLECTION.extInstall, "tasks", {
    extId: "tasks",
    space: tasksSpace,
    active: false,
    enabledBy: AUTHORITY,
    enabledAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    disabledAt: TIMESTAMP,
  });
  for (const did of [ALICE, BOB]) {
    await network.clientFor(AUTHORITY).procedure("com.atproto.memberspace.removeMember", {
      space: tasksSpace,
      did,
    });
  }

  // Codex R2-#3: ordinary alice.workspaces.summary() (NO fresh: true) invalidates workspace snapshot so next readSpace sees enabled: false!
  const aliceSummary = await alice.workspaces.summary(workspace);
  assert.equal(aliceSummary?.extensions?.find((e) => e.extId === "tasks")?.active, false);
  const aliceTasksAfterSummary = await alice.tasks.readSpace(workspace);
  assert.equal(aliceTasksAfterSummary.enabled, false);

  // Carbon R2-M2 read path: Bob's cached 60m snapshot has only AUTHORITY or {} in prevListedSet; advance clock past 10m credential expiry (still inside 60m truth interval).
  network.advanceClock(15 * 60_000);
  const bobAfterDisable = await bob.tasks.readSpace(workspace);
  assert.equal(bobAfterDisable.enabled, false, "warm member readSpace returns { enabled: false } instead of throwing SpaceCredentialError(403)");
  assert.equal(bobAfterDisable.complete, true);

  // Carbon R2-M2 write path: authorityDid (even with warm snapshot) must reject createTask AND deleteComment with TasksExtensionDisabledError without mutating tasksSpace!
  await assert.rejects(
    () => owner.tasks.createTask(workspace, { title: "Must not write as authority after disable" }),
    TasksExtensionDisabledError,
  );
  await assert.rejects(
    () => owner.tasks.deleteComment(workspace, seededComment.uri),
    TasksExtensionDisabledError,
  );
  const tasksRecords = await network.clientFor(AUTHORITY).query<{ records: Array<{ collection: string; rkey: string }> }>(
    "com.atproto.space.listRecords",
    { space: tasksSpace, repo: AUTHORITY },
  );
  assert.equal(
    tasksRecords.records.some((r) => r.collection === COLLECTION.taskComment),
    true,
    "deleteComment must NOT delete comment when Tasks extension is disabled",
  );
  assert.equal(
    tasksRecords.records.filter((r) => r.collection === COLLECTION.task).length,
    1,
    "createTask must NOT write task when Tasks extension is disabled",
  );
});

test("ensureSyncedForWrite refuses writes when live workspace snapshot verification fails while allowing writes when only non-authority Tasks writer is set aside (Codex R3-#4)", async () => {
  const network = new FakeNetwork();
  const { workspace, tasksSpace } = await setupTasksWorkspace(network, { members: [ALICE, BOB] });

  const owner = createEngine(transportFor(network, AUTHORITY));
  const alice = createEngine(transportFor(network, ALICE));

  // Warm cache says enabled: true for both owner and alice.
  const seededTask = await owner.tasks.createTask(workspace, { title: "Seeded task" });
  const seededComment = await owner.tasks.addComment(workspace, { taskUri: seededTask.uri, body: "Seeded comment" });
  assert.equal((await alice.tasks.readSpace(workspace)).enabled, true);

  // Another admin disables Tasks, AND workspace listRepoOps/getRepo transiently returns 503 while tasksSpace endpoints stay reachable!
  await network.writeAs(AUTHORITY, workspace, COLLECTION.extInstall, "tasks", {
    extId: "tasks",
    space: tasksSpace,
    active: false,
    enabledBy: AUTHORITY,
    enabledAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    disabledAt: TIMESTAMP,
  });

  network.interceptResponse = ({ method, params, response }) => {
    if (
      params.space === workspace &&
      (method === "com.atproto.space.listRepoOps" || method === "com.atproto.space.getRepo")
    ) {
      return new Response(JSON.stringify({ error: "UpstreamUnavailable", message: "transient 503" }), { status: 503 });
    }
    return response;
  };

  await assert.rejects(
    () => owner.tasks.createTask(workspace, { title: "Must not write on incomplete workspace verification" }),
    TasksWorkspaceUnavailableError,
  );
  await assert.rejects(
    () => owner.tasks.deleteComment(workspace, seededComment.uri),
    TasksWorkspaceUnavailableError,
  );
  network.interceptResponse = undefined;

  const afterRefused = await network.clientFor(AUTHORITY).query<{ records: Array<{ collection: string }> }>(
    "com.atproto.space.listRecords",
    { space: tasksSpace, repo: AUTHORITY },
  );
  assert.equal(afterRefused.records.filter((r) => r.collection === COLLECTION.task).length, 1);
  assert.equal(afterRefused.records.some((r) => r.collection === COLLECTION.taskComment), true);

  // Re-enable Tasks and verify that a transient 503 affecting ONLY non-authority member BOB's Tasks PDS does NOT block ALICE's write!
  await network.writeAs(AUTHORITY, workspace, COLLECTION.extInstall, "tasks", {
    extId: "tasks",
    space: tasksSpace,
    active: true,
    enabledBy: AUTHORITY,
    enabledAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  });
  await network.writeAs(BOB, tasksSpace, COLLECTION.task, "3kbbbbbbbbbbb", {
    title: "Bob task before 503",
    status: "todo",
    priority: "none",
    t: "1700000000000-0001-b",
    createdAt: TIMESTAMP,
  });
  network.interceptResponse = ({ params, response }) => {
    if (params.space === tasksSpace && params.repo === BOB) {
      return new Response(JSON.stringify({ error: "UpstreamUnavailable", message: "bob pds 503" }), { status: 503 });
    }
    return response;
  };
  const aliceCreated = await alice.tasks.createTask(workspace, { title: "Alice write succeeds with Bob setAside" });
  network.interceptResponse = undefined;
  assert.equal(aliceCreated.task.title, "Alice write succeeds with Bob setAside");
});

test("concurrent readSpace coalescing onto forWrite resolves degraded TasksSpaceView during workspace 503 while createTask rejects with TasksWorkspaceUnavailableError (Carbon R4-M1)", async () => {
  const network = new FakeNetwork();
  const { workspace } = await setupTasksWorkspace(network, { members: [ALICE] });
  const warmAlice = createEngine(transportFor(network, ALICE));
  const coldAlice = createEngine(transportFor(network, ALICE));

  await warmAlice.tasks.createTask(workspace, { title: "Seed task" });

  // 1. Warm workspace + 503: concurrent readSpace coalescing onto forWrite resolves degraded view while createTask rejects.
  let markWarmInFlight!: () => void;
  const warmInFlight = new Promise<void>((resolve) => {
    markWarmInFlight = resolve;
  });
  let releaseWarm!: () => void;
  const warmGate = new Promise<void>((resolve) => {
    releaseWarm = resolve;
  });
  let pausedWarm = false;
  network.interceptResponse = async ({ params, response }) => {
    if (params.space === workspace) {
      if (!pausedWarm) {
        pausedWarm = true;
        markWarmInFlight();
        await warmGate;
      }
      return new Response("upstream unavailable", { status: 503 });
    }
    return response;
  };

  const warmWrite = warmAlice.tasks.createTask(workspace, { title: "Blocked warm write" });
  const warmWriteCheck = assert.rejects(warmWrite, TasksWorkspaceUnavailableError);
  await warmInFlight;
  const warmRead = warmAlice.tasks.readSpace(workspace);
  releaseWarm();

  const warmView = await warmRead;
  assert.equal(warmView.enabled, true);
  assert.equal(warmView.workspaceSnapshotComplete, false);
  assert.equal(warmView.complete, false);
  assert.equal(warmView.degraded, true);
  assert.equal(warmView.tasks.some((task) => task.title === "Seed task"), true);
  await warmWriteCheck;

  // 2. Cold workspace + 503: concurrent readSpace resolves degraded disabled view while createTask rejects with TasksWorkspaceUnavailableError (not TasksExtensionDisabledError).
  let markColdInFlight!: () => void;
  const coldInFlight = new Promise<void>((resolve) => {
    markColdInFlight = resolve;
  });
  let releaseCold!: () => void;
  const coldGate = new Promise<void>((resolve) => {
    releaseCold = resolve;
  });
  let pausedCold = false;
  network.interceptResponse = async ({ params, response }) => {
    if (params.space === workspace) {
      if (!pausedCold) {
        pausedCold = true;
        markColdInFlight();
        await coldGate;
      }
      return new Response("upstream unavailable", { status: 503 });
    }
    return response;
  };

  const coldWrite = coldAlice.tasks.createTask(workspace, { title: "Blocked cold write" });
  const coldWriteCheck = assert.rejects(coldWrite, TasksWorkspaceUnavailableError);
  await coldInFlight;
  const coldRead = coldAlice.tasks.readSpace(workspace);
  releaseCold();

  const coldView = await coldRead;
  network.interceptResponse = undefined;
  assert.equal(coldView.enabled, false);
  assert.equal(coldView.workspaceSnapshotComplete, false);
  assert.equal(coldView.complete, false);
  assert.equal(coldView.degraded, true);
  await coldWriteCheck;
});
