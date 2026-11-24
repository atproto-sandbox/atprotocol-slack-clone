import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { serializedRecordBytes } from "@flock/protocol/atproto/space-credential-core";
import { advanceHlc, buildEditClosure, MAX_ANCESTOR_REFS, opRef } from "@flock/protocol/entity-merge";
import { groupMembersUri, SELF_SKEY, spaceRecordUri, tasksSpaceUri, tidNow, workspaceUri } from "@flock/protocol/keys";
import { ATPROTO_SPACE_COLLECTION, COLLECTION, OPENSOCIAL_COLLECTION, OPENSOCIAL_POLICY, SPACE_TYPE } from "@flock/protocol/nsids";
import { WORKSPACE_ENVELOPE } from "@flock/protocol/workspace-summary";
import { readIndependentTasksSpace, type IndependentTasksReadResult } from "@flock/reader/independent-tasks";
import { FakeNetwork } from "@flock/testing/fake-network";
import { createEngine } from "./engine";
import type { TasksSpaceView } from "./ext/tasks";
import { IndexedDbStore } from "./indexeddb-store";
import { AUTHORITY, countCalls, key, plcDidForLabel, transportFor } from "./testing/engine-fixture";

Object.assign(globalThis, { IDBKeyRange });

const ALICE = "did:plc:aliceaaaaaaaaaaaaaaaaaaa";
const BOB = "did:plc:bob2aaaaaaaaaaaaaaaaaaaa";
const CAROL = "did:plc:carolaaaaaaaaaaaaaaaaaaa";
const DAVE = "did:plc:dave2aaaaaaaaaaaaaaaaaaa";
const TIMESTAMP = "2026-11-16T12:00:00.000Z";
const BASE_HLC_MS = 1_700_000_000_000;

function omitKeys<T extends Record<string, unknown>>(items: readonly T[], keys: readonly string[]) {
  return items.map((item) =>
    Object.fromEntries(Object.entries(item).filter(([k]) => !keys.includes(k))),
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
  const label = input.skey ?? "parity";
  const groupDid = label === "parity" ? AUTHORITY : plcDidForLabel(label);
  await network.createGroupAccount(groupDid, {
    name: `Workspace ${label}`,
    joinPolicy: "invite",
    publicMeta: true,
    sovereignRotationKeys: ["did:key:zDnaeTestSovereignKey"],
  });
  const owner = network.clientFor(groupDid);
  const workspace = workspaceUri(groupDid);
  const membersSpace = groupMembersUri(groupDid);

  await owner.procedure("com.atproto.space.createSpace", {
    spaceType: SPACE_TYPE.workspace,
    skey: SELF_SKEY,
    policy: {
      $type: OPENSOCIAL_POLICY,
      publicRead: false,
      unlisted: false,
      grants: [
        { role: "admin", read: true, write: true },
        { role: "moderator", read: true, write: true },
        { role: "member", read: true },
      ],
    },
  });

  const tasksSpace = tasksSpaceUri(groupDid, SELF_SKEY);
  const enableTasks = input.enableTasks ?? true;
  if (enableTasks) {
    await owner.procedure("com.atproto.space.createSpace", {
      spaceType: SPACE_TYPE.tasks,
      skey: tasksSpace.split("/").at(-1)!,
      policy: {
        $type: OPENSOCIAL_POLICY,
        publicRead: false,
        unlisted: false,
        grants: [
          { role: "admin", read: true, write: true },
          { role: "moderator", read: true, write: true },
          { role: "member", read: true, write: true },
        ],
      },
    });
  }

  for (const [idx, did] of input.members.entries()) {
    if (!network.hasAccount(did)) network.createAccount(did, did.endsWith("2") || did.includes("bob2") || did.includes("dave2") ? "pds2" : "pds1");
    if (did === groupDid) continue;
    await owner.procedure("com.atproto.space.putRecord", {
      space: membersSpace,
      repo: groupDid,
      collection: OPENSOCIAL_COLLECTION.membership,
      rkey: did,
      record: {
        $type: OPENSOCIAL_COLLECTION.membership,
        roles: idx === 0 ? ["admin", "member"] : ["member"],
        createdAt: TIMESTAMP,
      },
    });
    const mem = await owner.query<{ value: Record<string, unknown> }>("com.atproto.space.getRecord", {
      space: membersSpace,
      repo: groupDid,
      collection: OPENSOCIAL_COLLECTION.membership,
      rkey: did,
    });
    const inc = mem.value["new.flock.incarnation"];
    await network.writeAs(did, membersSpace, OPENSOCIAL_COLLECTION.acceptance, SELF_SKEY, {
      createdAt: TIMESTAMP,
      ...(typeof inc === "string" ? { "new.flock.incarnation": inc } : {}),
    });
  }

  if (enableTasks) {
    await network.writeAs(groupDid, workspace, COLLECTION.extInstall, "tasks", {
      extId: "tasks",
      active: true,
      space: tasksSpace,
      cleanupComplete: false,
      enabledBy: input.members[0] ?? ALICE,
      enabledAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    });
  }

  return { groupDid, workspace, membersSpace, tasksSpace, skey: SELF_SKEY };
}

test("engine.tasks matches readIndependentTasksSpace across cold STAR, listRepoOps incremental, local writes, warm reopen, conflicts, moderation labels, delete/restore, and D14", async () => {
  const network = new FakeNetwork();
  const { groupDid, workspace, membersSpace, tasksSpace } = await createTasksFixture(network, { members: [ALICE, BOB, CAROL] });

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

    // Moderation `!hide` and `!takedown` labels on tasks/comments project identically across TasksClient & independent reader!
    const moderatedTask = await aliceEngine.tasks.createTask(workspace, { title: "Takendown task" });
    await network.clientFor(groupDid).procedure("com.atproto.space.putRecord", {
      space: tasksSpace,
      repo: groupDid,
      collection: ATPROTO_SPACE_COLLECTION.label,
      rkey: key(200),
      record: { $type: ATPROTO_SPACE_COLLECTION.label, src: groupDid, uri: task1.uri, val: "!hide", cts: "2026-11-16T12:05:00.000Z" },
    });
    await network.clientFor(groupDid).procedure("com.atproto.space.putRecord", {
      space: tasksSpace,
      repo: groupDid,
      collection: ATPROTO_SPACE_COLLECTION.label,
      rkey: key(201),
      record: { $type: ATPROTO_SPACE_COLLECTION.label, src: groupDid, uri: moderatedTask.uri, val: "!takedown", cts: "2026-11-16T12:05:00.000Z" },
    });
    await aliceEngine.sync.markSpaceStale(tasksSpace);
    const modPaired = await compare("moderation !hide and !takedown parity");
    assert.equal(modPaired.tasks.find((t) => t.uri === task1.uri)?.hidden, true);
    assert.equal(modPaired.tasks.some((t) => t.uri === moderatedTask.uri), false);

    // Negate `!hide` so clean state continues
    await network.clientFor(groupDid).procedure("com.atproto.space.putRecord", {
      space: tasksSpace,
      repo: groupDid,
      collection: ATPROTO_SPACE_COLLECTION.label,
      rkey: key(202),
      record: { $type: ATPROTO_SPACE_COLLECTION.label, src: groupDid, uri: task1.uri, val: "!hide", neg: true, cts: "2026-11-16T12:06:00.000Z" },
    });
    await aliceEngine.sync.markSpaceStale(tasksSpace);

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

    network.advanceClock(10);
    await carolEngine.tasks.updateTask(workspace, { context: carolTask2.observedContext, title: "Carol concurrent edit on deleted task" });
    await compare("after local writes + concurrentDeleteOverwrite");

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

    await network.clientFor(groupDid).procedure("com.atproto.space.deleteRecord", {
      space: membersSpace,
      repo: groupDid,
      collection: OPENSOCIAL_COLLECTION.membership,
      rkey: BOB,
    });
    await compare("after D14 intermediate writer removal");

    network.setAccountState(CAROL, "deactivated");
    network.advanceClock(aliceEngine.sync.options.truthIntervalMs);
    await compare("after Carol deactivated");
  } finally {
    idb.close();
  }
});

test("engine.tasks matches readIndependentTasksSpace across 255/256/257 saturation and saturated D14 eviction", async () => {
  const network = new FakeNetwork();
  const { groupDid, workspace, membersSpace, tasksSpace } = await createTasksFixture(network, { members: [ALICE, BOB, CAROL], skey: "saturation" });
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

  for (let i = 1; i <= 254; i += 1) {
    await seedEdit([BOB, CAROL, ALICE][i % 3]!, i);
  }
  assertTasksParity(await alice.tasks.readSpace(workspace), await readIndependentTasksSpace(reader, workspace), "255 ops");

  await seedEdit(BOB, 255);
  const view256 = await alice.tasks.readSpace(workspace);
  assert.equal(view256.tasks[0]!.closureRefs.length, MAX_ANCESTOR_REFS);
  assert.equal(view256.tasks[0]!.uncertainAncestry, false);
  assertTasksParity(view256, await readIndependentTasksSpace(reader, workspace), "256 ops exact boundary");

  await seedEdit(CAROL, 256);
  const view257 = await alice.tasks.readSpace(workspace);
  assert.equal(view257.tasks[0]!.uncertainAncestry, false);
  assertTasksParity(view257, await readIndependentTasksSpace(reader, workspace), "256 ancestors still final");

  await seedEdit(ALICE, 257);
  const viewSaturated = await alice.tasks.readSpace(workspace);
  assert.equal(viewSaturated.tasks[0]!.uncertainAncestry, true);
  assert.equal(viewSaturated.tasks[0]!.conflictFinal, false);
  assertTasksParity(viewSaturated, await readIndependentTasksSpace(reader, workspace), "257 ancestors saturated");

  await network.clientFor(groupDid).procedure("com.atproto.space.deleteRecord", {
    space: membersSpace,
    repo: groupDid,
    collection: OPENSOCIAL_COLLECTION.membership,
    rkey: BOB,
  });
  assertTasksParity(
    await alice.tasks.readSpace(workspace),
    await readIndependentTasksSpace(reader, workspace),
    "saturated task after D14 writer removal",
  );
});

test("engine.tasks matches readIndependentTasksSpace when Tasks is disabled or workspace snapshot exceeds member envelope", async () => {
  const network = new FakeNetwork();
  const disabled = await createTasksFixture(network, { members: [ALICE], enableTasks: false, skey: "disabled" });
  const alice = createEngine(transportFor(network, ALICE));
  const reader = transportFor(network, ALICE);

  assertTasksParity(
    await alice.tasks.readSpace(disabled.workspace),
    await readIndependentTasksSpace(reader, disabled.workspace),
    "disabled Tasks extension",
  );

  const overflow = await createTasksFixture(network, { members: [ALICE, BOB], skey: "malformed" });
  const t = await alice.tasks.createTask(overflow.workspace, { title: "Task before member overflow" });
  const bob = createEngine(transportFor(network, BOB));
  const bobView = (await bob.tasks.getTask(overflow.workspace, t.uri))!;
  await bob.tasks.updateTask(overflow.workspace, { context: bobView.observedContext, title: "Bob" });
  await alice.tasks.updateTask(overflow.workspace, { context: t.observedContext, title: "Alice" });

  for (let i = 0; i < 200; i += 1) {
    const extraDid = `did:plc:extra${String(i).padStart(4, "0")}aaaaaaaaaaaaaaa`;
    await network.clientFor(overflow.groupDid).procedure("com.atproto.space.putRecord", {
      space: overflow.membersSpace,
      repo: overflow.groupDid,
      collection: OPENSOCIAL_COLLECTION.membership,
      rkey: extraDid,
      record: { $type: OPENSOCIAL_COLLECTION.membership, roles: ["member"], createdAt: TIMESTAMP },
    });
  }
  network.advanceClock(alice.sync.options.truthIntervalMs);
  const engOverflow = await alice.tasks.readSpace(overflow.workspace);
  const indOverflow = await readIndependentTasksSpace(reader, overflow.workspace);
  assert.equal(engOverflow.workspaceSnapshotComplete, false);
  assert.deepEqual(engOverflow.activities, []);
  assertTasksParity(engOverflow, indOverflow, "overflowed membership envelope");
});

test("engine.tasks and readIndependentTasksSpace match on RepoStarLimitError and persistent STAR verification failures (cold & warm)", async () => {
  {
    const network = new FakeNetwork();
    const { workspace } = await createTasksFixture(network, { members: [ALICE, BOB], skey: "starlimit" });
    const alice = createEngine(transportFor(network, ALICE));
    const bob = createEngine(transportFor(network, BOB));
    const reader = transportFor(network, ALICE);

    await alice.tasks.createTask(workspace, { title: "Alice task" });
    await bob.tasks.createTask(workspace, { title: "Bob small task" });

    assert.equal((await alice.tasks.readSpace(workspace)).tasks.length, 2);

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

  {
    const network = new FakeNetwork();
    const { workspace } = await createTasksFixture(network, { members: [ALICE, BOB], skey: "starverify" });
    const alice = createEngine(transportFor(network, ALICE));
    const bob = createEngine(transportFor(network, BOB));
    const reader = transportFor(network, ALICE);

    await alice.tasks.createTask(workspace, { title: "Alice task" });
    await bob.tasks.createTask(workspace, { title: "Bob task" });
    assert.equal((await alice.tasks.readSpace(workspace)).tasks.length, 2);

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

  {
    const network = new FakeNetwork();
    const { workspace, tasksSpace } = await createTasksFixture(network, { members: [ALICE, BOB], skey: "star16mib" });
    const alice = createEngine(transportFor(network, ALICE));
    const reader = transportFor(network, ALICE);

    await alice.tasks.createTask(workspace, { title: "Alice seed task" });

    const maxBytes = WORKSPACE_ENVELOPE.maxStarArchiveBytes;
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

    const probe = makeTaskRecord(0, 7_900);
    const probeCborBytes = await serializedRecordBytes(probe.collection, probe.rkey, probe.value);
    const overheadPerRecord = probeCborBytes - 7_900;
    const targetTotalValuesBytes = maxBytes - 1024;
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

    await network.importRepoAs(BOB, tasksSpace, allRecords.slice(0, baseCount));
    const warmInitial = await alice.tasks.readSpace(workspace, { fresh: true });
    assert.equal(warmInitial.complete, true);
    assert.equal(warmInitial.tasks.length, baseCount + 1);

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

    let warmDelta!: TasksSpaceView;
    const warmCalls = await countCalls(network, async () => {
      warmDelta = await alice.tasks.readSpace(workspace);
    });
    assert.equal(warmCalls["com.atproto.space.getRepo"] ?? 0, 0, "warm delta rejects at exact STAR boundary without getRepo call");
    assert.deepEqual(warmDelta.setAside, [
      { did: BOB, reason: "its answer is larger than this app reads", permanent: true },
    ]);
    assert.equal(warmDelta.tasks.some((t) => t.repo === BOB), false);

    const coldStarReader = await readIndependentTasksSpace(reader, workspace);
    const coldStarEngine = await createEngine(transportFor(network, ALICE)).tasks.readSpace(workspace);
    assertTasksParity(warmDelta, coldStarReader, "16 MiB STAR boundary warm delta vs cold STAR reader");
    assertTasksParity(coldStarEngine, coldStarReader, "16 MiB STAR boundary cold STAR engine vs reader");

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

  {
    const network = new FakeNetwork();
    const { groupDid, workspace, tasksSpace } = await createTasksFixture(network, { members: [ALICE, BOB], skey: "disableparity" });
    const bob = createEngine(transportFor(network, BOB));
    const reader = transportFor(network, BOB);

    assert.equal((await bob.tasks.readSpace(workspace)).enabled, true);

    await network.writeAs(groupDid, workspace, COLLECTION.extInstall, "tasks", {
      extId: "tasks",
      space: tasksSpace,
      active: false,
      cleanupComplete: true,
      enabledBy: ALICE,
      enabledAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
      disabledAt: TIMESTAMP,
    });
    await network.clientFor(groupDid).procedure("com.atproto.space.updateSpace", {
      space: tasksSpace,
      policy: {
        $type: OPENSOCIAL_POLICY,
        publicRead: false,
        unlisted: true,
        grants: [],
      },
    });

    network.advanceClock(15 * 60_000);
    const warmBob = await bob.tasks.readSpace(workspace);
    const coldReader = await readIndependentTasksSpace(reader, workspace);
    assert.equal(warmBob.enabled, false);
    assertTasksParity(warmBob, coldReader, "cross-engine disableExtension after credential expiry");
  }
});
