import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { serializedRecordBytes } from "@flock/protocol/atproto/space-credential-core";
import { memberspacePolicy } from "@flock/protocol/atproto/space-policy";
import { advanceHlc, buildEditClosure, MAX_ANCESTOR_REFS, opRef } from "@flock/protocol/entity-merge";
import { spaceRecordUri, subjectKey, tasksSpaceUri, tidNow } from "@flock/protocol/keys";
import { COLLECTION, SPACE_TYPE } from "@flock/protocol/nsids";
import { WORKSPACE_ENVELOPE } from "@flock/protocol/workspace-summary";
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
    engine.setAside.map((s) => [s.did, s.permanent, s.reason]),
    reader.setAside.map((s) => [s.did, s.permanent, s.reason]),
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
  const { space: workspace } = await owner.procedure<unknown, { space: string }>("com.atproto.space.createSpace", {
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
    await owner.procedure("com.atproto.memberspace.putMembers", {
      space: workspace,
      members: [{ did, read: true, write: true }],
    });
    if (enableTasks) {
      await owner.procedure("com.atproto.memberspace.putMembers", {
        space: tasksSpace,
        members: [{ did, read: true, write: true }],
      });
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
    await network.clientFor(AUTHORITY).procedure("com.atproto.memberspace.removeMembers", { space: tasksSpace, dids: [BOB] });
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
  await network.clientFor(AUTHORITY).procedure("com.atproto.memberspace.removeMembers", { space: tasksSpace, dids: [BOB] });
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

test("engine.tasks and readIndependentTasksSpace match on RepoStarLimitError and persistent STAR verification failures (cold & warm)", async () => {
  // 1. Cold + warm RepoStarLimitError parity: both classify permanent: true with "its answer is larger than this app reads", and warm purges cached records.
  {
    const network = new FakeNetwork();
    const { workspace } = await createTasksFixture(network, { members: [ALICE, BOB], skey: "star-limit" });
    const alice = createEngine(transportFor(network, ALICE));
    const bob = createEngine(transportFor(network, BOB));
    const reader = transportFor(network, ALICE);

    await alice.tasks.createTask(workspace, { title: "Alice task" });
    await bob.tasks.createTask(workspace, { title: "Bob small task" });

    // Seed warm cache under normal envelope.
    assert.equal((await alice.tasks.readSpace(workspace)).tasks.length, 2);

    // Bob adds a big description exceeding maxStarArchiveBytes: 900 on read -> both cold reader & warm engine agree on permanent: true & drop Bob's tasks.
    await bob.tasks.createTask(workspace, { title: "Bob oversized", description: "x".repeat(1200) });
    const engLimit = await alice.tasks.readSpace(workspace, { fresh: true, maxStarArchiveBytes: 900 });
    const indLimit = await readIndependentTasksSpace(reader, workspace, { maxStarArchiveBytes: 900 });
    assertTasksParity(engLimit, indLimit, "warm RepoStarLimitError parity");
    assert.deepEqual(engLimit.setAside, [
      { did: BOB, reason: "its answer is larger than this app reads", permanent: true },
    ]);
    assert.equal(engLimit.tasks.some((t) => t.repo === BOB), false, "warm engine purges cached records on permanent RepoStarLimitError");

    const coldAlice = createEngine(transportFor(network, ALICE));
    assertTasksParity(
      await coldAlice.tasks.readSpace(workspace, { maxStarArchiveBytes: 900 }),
      indLimit,
      "cold RepoStarLimitError parity",
    );
  }

  // 2. Cold + warm persistent RepoVerificationError/StarParseError parity: both classify permanent: true with "its records could not be authenticated".
  {
    const network = new FakeNetwork();
    const { workspace } = await createTasksFixture(network, { members: [ALICE, BOB], skey: "star-verify" });
    const alice = createEngine(transportFor(network, ALICE));
    const bob = createEngine(transportFor(network, BOB));
    const reader = transportFor(network, ALICE);

    await alice.tasks.createTask(workspace, { title: "Alice task" });
    await bob.tasks.createTask(workspace, { title: "Bob task" });
    // Warm cache includes Bob initially.
    assert.equal((await alice.tasks.readSpace(workspace)).tasks.length, 2);

    // Bob updates while host returns corrupted STAR archive on every retry.
    const bobView = (await bob.tasks.readSpace(workspace)).tasks.find((t) => t.repo === BOB)!;
    await bob.tasks.updateTask(workspace, { context: bobView.observedContext, title: "Bob v2" });
    network.interceptResponse = ({ method, params, response }) => {
      if (method === "com.atproto.space.getRepo" && params.repo === BOB && response.ok) {
        return new Response(new Uint8Array(64).fill(0xfe), { status: 200, headers: response.headers });
      }
      if (method === "com.atproto.space.listRepoOps" && params.repo === BOB && response.ok) {
        return new Response(JSON.stringify({ error: "MethodNotImplemented", message: "force star" }), { status: 501 });
      }
      return response;
    };

    const engVerify = await alice.tasks.readSpace(workspace, { fresh: true });
    const indVerify = await readIndependentTasksSpace(reader, workspace);
    assertTasksParity(engVerify, indVerify, "warm STAR verification failure parity");
    assert.deepEqual(engVerify.setAside, [
      { did: BOB, reason: "its records could not be authenticated", permanent: true },
    ]);
    assert.equal(engVerify.tasks.some((t) => t.repo === BOB), false, "warm engine drops cached records on persistent verification failure");

    const coldAlice = createEngine(transportFor(network, ALICE));
    assertTasksParity(
      await coldAlice.tasks.readSpace(workspace),
      indVerify,
      "cold STAR verification failure parity",
    );
  }

  // 3. Codex R2-#6 exact 16 MiB boundary parity: < 16 MiB CBOR record values where STAR framing pushes archive > 16 MiB
  //    MUST reject identically with permanent setAside across cold STAR, cold JSON fallback (501), and warm listRepoOps delta!
  {
    const network = new FakeNetwork();
    const { workspace, tasksSpace } = await createTasksFixture(network, { members: [ALICE, BOB], skey: "star-16mib-boundary" });
    const alice = createEngine(transportFor(network, ALICE));
    const reader = transportFor(network, ALICE);

    await alice.tasks.createTask(workspace, { title: "Alice seed task" });

    const maxBytes = WORKSPACE_ENVELOPE.maxStarArchiveBytes; // 16 * 1024 * 1024
    const totalCount = 2_100;
    const baseCount = 2_070;

    let hlc = "";
    const makeTaskRecord = (idx: number, descLen: number) => {
      hlc = advanceHlc({ ownLast: hlc || null, wallNowMs: BASE_HLC_MS + idx * 10 });
      const rkey = tidNow(BASE_HLC_MS + idx * 10, 0);
      const value = {
        $type: COLLECTION.task,
        title: `Task ${String(idx).padStart(4, "0")}`,
        status: "todo",
        priority: "none",
        description: "d".repeat(descLen),
        t: hlc,
        createdAt: TIMESTAMP,
      };
      return { collection: COLLECTION.task, rkey, value };
    };

    // Calibrate record size so 2,100 CBOR record values sum to (16 MiB - 1 KiB), strictly < 16 MiB in raw values
    // while STAR framing (~95 KiB across 2,100 entries + header) pushes total STAR archive > 16 MiB.
    const probe = makeTaskRecord(0, 7_900);
    const probeCborBytes = await serializedRecordBytes(probe.collection, probe.rkey, probe.value);
    const overheadPerRecord = probeCborBytes - 7_900;
    const targetTotalValuesBytes = maxBytes - 1024; // 16 MiB - 1 KiB
    const perRecordDesc = Math.floor((targetTotalValuesBytes - totalCount * overheadPerRecord) / totalCount);

    hlc = "";
    const allRecords: Array<{ collection: string; rkey: string; value: Record<string, unknown> }> = [];
    let sumValueBytes = 0;
    for (let i = 0; i < totalCount; i += 1) {
      const descLen = i < totalCount - 1
        ? perRecordDesc
        : Math.max(100, targetTotalValuesBytes - sumValueBytes - overheadPerRecord);
      const rec = makeTaskRecord(i, descLen);
      sumValueBytes += await serializedRecordBytes(rec.collection, rec.rkey, rec.value);
      allRecords.push(rec);
    }
    assert.ok(sumValueBytes <= maxBytes - 512 && sumValueBytes >= maxBytes - 2048, `raw CBOR values=${sumValueBytes} near 16 MiB - 1 KiB`);

    // Import first 2,070 records (well under 16 MiB even with STAR framing) so Alice's warm cache syncs cleanly.
    await network.importRepoAs(BOB, tasksSpace, allRecords.slice(0, baseCount));
    const warmInitial = await alice.tasks.readSpace(workspace, { fresh: true });
    assert.equal(warmInitial.complete, true);
    assert.equal(warmInitial.tasks.length, baseCount + 1);

    // Add final 30 records (~240 KiB delta) so CBOR values stay <= 16 MiB - 1 KiB while STAR archive crosses 16 MiB.
    await network.applyWritesAs(
      BOB,
      tasksSpace,
      allRecords.slice(baseCount).map((rec) => ({
        action: "create" as const,
        collection: rec.collection,
        rkey: rec.rkey,
        value: rec.value,
      })),
    );

    // 1) Warm Engine incremental listRepoOps delta rejects directly with 0 getRepo STAR calls and purges Bob's cache.
    let warmDelta!: TasksSpaceView;
    const warmCalls = await countCalls(network, async () => {
      warmDelta = await alice.tasks.readSpace(workspace);
    });
    assert.equal(warmCalls["com.atproto.space.getRepo"] ?? 0, 0, "warm delta rejects at exact STAR boundary without getRepo call");
    assert.deepEqual(warmDelta.setAside, [
      { did: BOB, reason: "its answer is larger than this app reads", permanent: true },
    ]);
    assert.equal(warmDelta.tasks.some((t) => t.repo === BOB), false);

    // 2) Cold STAR (Engine + Independent Reader) matches warm delta parity.
    const coldStarReader = await readIndependentTasksSpace(reader, workspace);
    const coldStarEngine = await createEngine(transportFor(network, ALICE)).tasks.readSpace(workspace);
    assertTasksParity(warmDelta, coldStarReader, "16 MiB STAR boundary warm delta vs cold STAR reader");
    assertTasksParity(coldStarEngine, coldStarReader, "16 MiB STAR boundary cold STAR engine vs reader");

    // 3) Cold JSON fallback (getRepo -> 501) on BOTH Engine and Independent Reader matches cold STAR & warm delta parity.
    network.interceptResponse = ({ method, params, response }) => {
      if (method === "com.atproto.space.getRepo" && params.space === tasksSpace && params.repo === BOB && response.ok) {
        return new Response(JSON.stringify({ error: "MethodNotImplemented", message: "no getRepo" }), {
          status: 501,
          headers: { "content-type": "application/json" },
        });
      }
      return response;
    };
    const coldFallbackReader = await readIndependentTasksSpace(reader, workspace);
    const coldFallbackEngine = await createEngine(transportFor(network, ALICE)).tasks.readSpace(workspace);
    assertTasksParity(coldFallbackEngine, coldFallbackReader, "16 MiB STAR boundary cold JSON fallback engine vs reader");
    assertTasksParity(coldFallbackEngine, coldStarReader, "16 MiB STAR boundary cold JSON fallback vs cold STAR");
  }

  // 4. Carbon R2-M2 parity: cross-engine disableExtension with no non-authority writers still matches independent reader after 10m credential expiry.
  {
    const network = new FakeNetwork();
    const { workspace, tasksSpace } = await createTasksFixture(network, { members: [ALICE, BOB], skey: "disable-parity" });
    const bob = createEngine(transportFor(network, BOB));
    const reader = transportFor(network, BOB);

    assert.equal((await bob.tasks.readSpace(workspace)).enabled, true);

    await network.writeAs(AUTHORITY, workspace, COLLECTION.extInstall, "tasks", {
      extId: "tasks",
      space: tasksSpace,
      active: false,
      updatedAt: TIMESTAMP,
      disabledAt: TIMESTAMP,
    });
    await network.clientFor(AUTHORITY).procedure("com.atproto.memberspace.removeMembers", {
      space: tasksSpace,
      dids: [ALICE, BOB],
    });

    network.advanceClock(15 * 60_000);
    const warmBob = await bob.tasks.readSpace(workspace);
    const coldReader = await readIndependentTasksSpace(reader, workspace);
    assert.equal(warmBob.enabled, false);
    assertTasksParity(warmBob, coldReader, "cross-engine disableExtension after credential expiry");
  }
});
