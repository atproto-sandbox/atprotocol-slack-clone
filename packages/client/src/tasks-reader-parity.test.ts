import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { memberspacePolicy } from "@flock/protocol/atproto/space-policy";
import { advanceHlc, buildEditClosure, MAX_ANCESTOR_REFS, opRef } from "@flock/protocol/entity-merge";
import { spaceRecordUri, subjectKey, tasksSpaceUri } from "@flock/protocol/keys";
import { COLLECTION, SPACE_TYPE } from "@flock/protocol/nsids";
import { readIndependentTasksSpace, type IndependentTasksReadResult } from "@flock/reader/independent-tasks";
import { FakeNetwork } from "@flock/testing/fake-network";
import { createEngine } from "./engine";
import type { TasksSpaceView } from "./ext/tasks";
import { IndexedDbStore } from "./indexeddb-store";
import { countCalls, transportFor } from "./testing/engine-fixture";

Object.assign(globalThis, { IDBKeyRange });

const AUTHORITY = "did:plc:authority";
const ALICE = "did:plc:alice";
const BOB = "did:plc:bob2";
const CAROL = "did:plc:carol";
const DAVE = "did:plc:dave2";
const TIMESTAMP = "2026-11-16T12:00:00.000Z";
const BASE_HLC_MS = 1_700_000_000_000;

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

async function createTasksFixture(
  network: FakeNetwork,
  input: { members: readonly string[]; enableTasks?: boolean; skey?: string },
) {
  const skey = input.skey ?? "parity";
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
  const enableTasks = input.enableTasks ?? true;
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

  for (const did of [AUTHORITY, ...input.members]) {
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

test("engine.tasks matches readIndependentTasksSpace across cold STAR, listRepoOps incremental, local writes, warm reopen, conflicts, delete/restore, and D14", async () => {
  const network = new FakeNetwork();
  const { workspace, tasksSpace } = await createTasksFixture(network, { members: [ALICE, BOB, CAROL] });

  const idb = await IndexedDbStore.open(ALICE, new IDBFactory());
  try {
    const aliceEngine = createEngine(transportFor(network, ALICE), { store: idb });
    const bobEngine = createEngine(transportFor(network, BOB));
    const carolEngine = createEngine(transportFor(network, CAROL));
    const readerTransport = transportFor(network, ALICE);

    const compare = async (label: string, targetEngine = aliceEngine) => {
      const [eng, ind] = await Promise.all([
        targetEngine.tasks.readSpace(workspace),
        readIndependentTasksSpace(readerTransport, workspace),
      ]);
      assertTasksParity(eng, ind, label);
      return eng;
    };

    // 1. Seed initial project, task, and comments, then verify cold STAR parity.
    const proj = await bobEngine.tasks.createProject(workspace, {
      name: "Core",
      description: "Initial",
      color: "#112233",
    });
    const task1 = await bobEngine.tasks.createTask(workspace, {
      title: "Base Task",
      description: "Details",
      status: "todo",
      priority: "low",
      project: proj.uri,
      assignees: [ALICE],
      labels: ["bug", "core"],
    });
    const comment1 = await carolEngine.tasks.addComment(workspace, { taskUri: task1.uri, body: "Carol initial comment" });

    // Orphan & invalid records alongside valid records must match independent reader behavior.
    const missingTaskUri = spaceRecordUri(tasksSpace, DAVE, COLLECTION.task, "3k22222222222");
    await network.writeAs(CAROL, tasksSpace, COLLECTION.taskEdit, (await carolEngine.writeQueue.reserveStamp(CAROL)).tid, {
      subject: missingTaskUri,
      t: advanceHlc({ wallNowMs: BASE_HLC_MS + 10 }),
      s: [opRef(DAVE, "3k22222222222")],
      title: "Orphan task edit",
    });
    await network.writeAs(CAROL, tasksSpace, COLLECTION.taskComment, (await carolEngine.writeQueue.reserveStamp(CAROL)).tid, {
      subject: missingTaskUri,
      body: "Orphan comment",
      createdAt: TIMESTAMP,
    });
    await network.writeAs(BOB, tasksSpace, COLLECTION.task, (await bobEngine.writeQueue.reserveStamp(BOB)).tid, {
      title: "   ",
      status: "todo",
      priority: "none",
      t: advanceHlc({ wallNowMs: BASE_HLC_MS + 20 }),
      createdAt: TIMESTAMP,
    });

    const coldCalls = await countCalls(network, () => aliceEngine.tasks.readSpace(workspace));
    assert.ok((coldCalls["com.atproto.space.getRepo"] ?? 0) >= 3, "cold load uses STAR getRepo");
    await compare("cold STAR initial load");

    // 2. Remote incremental writes by Bob & Carol -> Alice advances via listRepoOps (0 getRepo calls!).
    const bobTask1View = (await bobEngine.tasks.getTask(workspace, task1.uri))!;
    const carolTask1View = (await carolEngine.tasks.getTask(workspace, task1.uri))!;
    network.advanceClock(10);
    await bobEngine.tasks.updateTask(workspace, {
      context: bobTask1View.observedContext,
      title: "Bob concurrent title",
      priority: "high",
      removeLabels: ["bug"],
      addAssignees: [BOB],
    });
    network.advanceClock(10);
    await carolEngine.tasks.updateTask(workspace, {
      context: carolTask1View.observedContext,
      title: "Carol concurrent title",
      priority: "high",
      addLabels: ["bug"],
    });
    network.advanceClock(10);
    await carolEngine.tasks.updateComment(workspace, {
      commentUri: comment1.uri,
      body: "Carol edited comment",
    });

    const incCalls = await countCalls(network, () => aliceEngine.tasks.readSpace(workspace));
    assert.equal(incCalls["com.atproto.space.getRepo"] ?? 0, 0, "incremental sync uses listRepoOps, zero getRepo calls");
    assert.ok((incCalls["com.atproto.space.listRepoOps"] ?? 0) >= 2);
    await compare("incremental listRepoOps after remote conflicts");

    // 3. Local writes via aliceEngine: update project, add/delete comment, create+delete+restore task, concurrent delete overwrite.
    const aliceSpace = await aliceEngine.tasks.readSpace(workspace);
    const aliceProj = aliceSpace.projects.find((p) => p.uri === proj.uri)!;
    await aliceEngine.tasks.updateProject(workspace, {
      context: aliceProj.observedContext,
      clearDescription: true,
      color: "#445566",
    });
    const cAlice = await aliceEngine.tasks.addComment(workspace, { taskUri: task1.uri, body: "Alice comment" });
    await aliceEngine.tasks.deleteComment(workspace, cAlice.uri);

    const task2 = await aliceEngine.tasks.createTask(workspace, { title: "Delete/Restore target" });
    const carolTask2 = (await carolEngine.tasks.getTask(workspace, task2.uri))!;
    const delTask2 = await aliceEngine.tasks.deleteTask(workspace, { context: task2.observedContext });
    await aliceEngine.tasks.addComment(workspace, { taskUri: task1.uri, body: "Alice permanent comment" });

    // Carol concurrently edits task2 without seeing delete -> concurrentDeleteOverwrite Activity!
    network.advanceClock(10);
    await carolEngine.tasks.updateTask(workspace, { context: carolTask2.observedContext, title: "Carol concurrent edit on deleted task" });
    await compare("after local writes + concurrentDeleteOverwrite");

    // Restore task2 and verify parity.
    await aliceEngine.tasks.restoreTask(workspace, { context: delTask2.observedContext });
    await compare("after restoreTask");

    // 4. Warm reopen: brand-new Engine over the SAME persisted IndexedDbStore within truthIntervalMs -> 0 writer calls!
    const warmReopened = createEngine(transportFor(network, ALICE), { store: idb });
    let warmView!: TasksSpaceView;
    const warmCalls = await countCalls(network, async () => {
      warmView = await warmReopened.tasks.readSpace(workspace);
    });
    const readerWarmView = await readIndependentTasksSpace(readerTransport, workspace);
    assertTasksParity(warmView, readerWarmView, "warm reopen within truthIntervalMs");
    assert.equal(warmCalls["com.atproto.space.getRepo"] ?? 0, 0, "warm reopen makes 0 getRepo calls");
    assert.equal(warmCalls["com.atproto.space.listRepoOps"] ?? 0, 0, "warm reopen makes 0 listRepoOps calls");
    assert.equal(warmCalls["com.atproto.space.listRecords"] ?? 0, 0, "warm reopen makes 0 listRecords calls");

    // 5. D14 intermediate writer eviction parity: D (Alice) -> B (Bob) -> R (Carol), then Bob removed.
    const d14Task = await aliceEngine.tasks.createTask(workspace, { title: "D14 Parity" });
    await aliceEngine.tasks.deleteTask(workspace, { context: d14Task.observedContext });
    const bobViewD14 = (await bobEngine.tasks.getTask(workspace, d14Task.uri))!;
    await bobEngine.tasks.updateTask(workspace, { context: bobViewD14.observedContext, title: "Bob saw delete" });
    const carolViewD14 = (await carolEngine.tasks.getTask(workspace, d14Task.uri))!;
    await carolEngine.tasks.restoreTask(workspace, { context: carolViewD14.observedContext });

    await network.writeAs(AUTHORITY, workspace, COLLECTION.workspaceRoster, subjectKey(BOB), {
      subject: BOB,
      active: false,
      updatedAt: TIMESTAMP,
    });
    await network.clientFor(AUTHORITY).procedure("com.atproto.memberspace.removeMember", { space: tasksSpace, did: BOB });
    network.advanceClock(aliceEngine.sync.options.truthIntervalMs);
    await compare("after D14 intermediate writer removal");

    // 6. Set-aside deactivated writer parity.
    network.setAccountState(CAROL, "deactivated");
    network.advanceClock(aliceEngine.sync.options.truthIntervalMs);
    await compare("after Carol deactivated");
  } finally {
    idb.close();
  }
});

test("engine.tasks matches readIndependentTasksSpace across 255/256/257 saturation and saturated D14 eviction", async () => {
  const network = new FakeNetwork();
  const { workspace, tasksSpace } = await createTasksFixture(network, { members: [ALICE, BOB, CAROL] });
  const alice = createEngine(transportFor(network, ALICE));
  const bob = createEngine(transportFor(network, BOB));
  const carol = createEngine(transportFor(network, CAROL));
  const reader = transportFor(network, ALICE);

  const created = await alice.tasks.createTask(workspace, { title: "Saturation Parity" });
  network.advanceClock(1);
  const ops: Array<{ repo: string; rkey: string; t: string; s?: string[]; sTruncated?: boolean; isRoot?: boolean }> = [
    { repo: ALICE, rkey: created.rkey, t: created.task.maxHlc, isRoot: true },
  ];
  let lastT = created.task.maxHlc;

  const seedEdit = async (repo: string, idx: number) => {
    const queue = repo === ALICE ? alice.writeQueue : repo === BOB ? bob.writeQueue : carol.writeQueue;
    const rkey = (await queue.reserveStamp(repo)).tid;
    lastT = advanceHlc({ wallNowMs: BASE_HLC_MS + idx * 10, observedTs: [lastT] });
    const closure = buildEditClosure({ observedOps: ops });
    await network.writeAs(repo, tasksSpace, COLLECTION.taskEdit, rkey, {
      subject: created.uri,
      t: lastT,
      s: closure.s,
      ...(closure.sTruncated ? { sTruncated: true } : {}),
      title: `Step ${idx}`,
    });
    ops.push({ repo, rkey, t: lastT, s: closure.s, sTruncated: closure.sTruncated });
  };

  // Seed 254 edits -> 255 ops total (root + 254).
  for (let i = 1; i <= 254; i += 1) {
    await seedEdit([BOB, CAROL, ALICE][i % 3]!, i);
  }
  assertTasksParity(await alice.tasks.readSpace(workspace), await readIndependentTasksSpace(reader, workspace), "255 ops");

  // 255th edit -> 256 ops total (closureRefs = 256, still final).
  await seedEdit(BOB, 255);
  const view256 = await alice.tasks.readSpace(workspace);
  assert.equal(view256.tasks[0]!.closureRefs.length, MAX_ANCESTOR_REFS);
  assert.equal(view256.tasks[0]!.uncertainAncestry, false);
  assertTasksParity(view256, await readIndependentTasksSpace(reader, workspace), "256 ops exact boundary");

  // 256th edit -> 257 ops total (s.length = 256, still final).
  await seedEdit(CAROL, 256);
  const view257 = await alice.tasks.readSpace(workspace);
  assert.equal(view257.tasks[0]!.uncertainAncestry, false);
  assertTasksParity(view257, await readIndependentTasksSpace(reader, workspace), "256 ancestors still final");

  // 257th edit -> 257 ancestors (> 256), triggers sTruncated: true & uncertainAncestry: true.
  await seedEdit(ALICE, 257);
  const viewSaturated = await alice.tasks.readSpace(workspace);
  assert.equal(viewSaturated.tasks[0]!.uncertainAncestry, true);
  assert.equal(viewSaturated.tasks[0]!.conflictFinal, false);
  assertTasksParity(viewSaturated, await readIndependentTasksSpace(reader, workspace), "257 ancestors saturated");

  // Remove intermediate writer Bob under D14 on the saturated task and verify exact parity!
  await network.writeAs(AUTHORITY, workspace, COLLECTION.workspaceRoster, subjectKey(BOB), {
    subject: BOB,
    active: false,
    updatedAt: TIMESTAMP,
  });
  await network.clientFor(AUTHORITY).procedure("com.atproto.memberspace.removeMember", { space: tasksSpace, did: BOB });
  network.advanceClock(alice.sync.options.truthIntervalMs);
  assertTasksParity(
    await alice.tasks.readSpace(workspace),
    await readIndependentTasksSpace(reader, workspace),
    "saturated task after D14 writer removal",
  );
});

test("engine.tasks matches readIndependentTasksSpace when Tasks is disabled or workspace snapshot is malformed", async () => {
  const network = new FakeNetwork();
  const disabled = await createTasksFixture(network, { members: [ALICE], enableTasks: false, skey: "disabled" });
  const alice = createEngine(transportFor(network, ALICE));
  const reader = transportFor(network, ALICE);

  assertTasksParity(
    await alice.tasks.readSpace(disabled.workspace),
    await readIndependentTasksSpace(reader, disabled.workspace),
    "disabled Tasks extension",
  );

  const malformed = await createTasksFixture(network, { members: [ALICE, BOB], skey: "malformed" });
  const t = await alice.tasks.createTask(malformed.workspace, { title: "Task before malformed roster" });
  const bob = createEngine(transportFor(network, BOB));
  const bobView = (await bob.tasks.getTask(malformed.workspace, t.uri))!;
  await bob.tasks.updateTask(malformed.workspace, { context: bobView.observedContext, title: "Bob" });
  await alice.tasks.updateTask(malformed.workspace, { context: t.observedContext, title: "Alice" });

  await network.writeAs(AUTHORITY, malformed.workspace, COLLECTION.workspaceRoster, "bad-roster-key", {
    subject: CAROL,
    active: true,
    updatedAt: TIMESTAMP,
  });
  network.advanceClock(alice.sync.options.truthIntervalMs);
  const engMalformed = await alice.tasks.readSpace(malformed.workspace);
  const indMalformed = await readIndependentTasksSpace(reader, malformed.workspace);
  assert.equal(engMalformed.workspaceSnapshotComplete, false);
  assert.deepEqual(engMalformed.activities, []);
  assertTasksParity(engMalformed, indMalformed, "malformed workspace.roster");
});
