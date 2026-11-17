import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  advanceHlc,
  buildEditClosure,
  compareHlc,
  compareOpOrder,
  DEFAULT_MAX_HLC_DRIFT_MS,
  formatHlc,
  HlcRangeError,
  MAX_ANCESTOR_REFS,
  MAX_HLC_MS,
  mergeProject,
  mergeTask,
  mergeTasksSpace,
  MIN_HLC_MS,
  opId,
  opRef,
  packCausalClosure,
  parseHlc,
  type ProjectEditRecordValue,
  type ProjectRecordValue,
  type StoredEntityRecord,
  type TaskCommentRecordValue,
  type TaskEditRecordValue,
  type TaskRecordValue,
} from "./entity-merge";
import { spaceRecordUri, tasksSpaceUri } from "./keys";
import { COLLECTION } from "./nsids";

const AUTHORITY = "did:plc:authority";
const ALICE = "did:plc:alice";
const BOB = "did:plc:bob";
const CAROL = "did:plc:carol";
const SPACE = tasksSpaceUri(AUTHORITY, "acme");
const CREATED_AT = "2026-11-16T00:00:00.000Z";

function tidFor(n: number): string {
  const alphabet = "234567abcdefghijklmnopqrstuvwxyz";
  let v = n;
  let suffix = "";
  for (let i = 0; i < 6; i += 1) {
    suffix = alphabet[v % 32] + suffix;
    v = Math.floor(v / 32);
  }
  return `3k22222${suffix}`;
}

function hlcAt(msOffset: number, counter = 0): string {
  return formatHlc({ ms: 1_700_000_000_000 + msOffset, counter });
}

function makeTask(
  repo: string,
  rkey: string,
  overrides: Partial<TaskRecordValue> = {},
): StoredEntityRecord<TaskRecordValue> {
  return {
    uri: spaceRecordUri(SPACE, repo, COLLECTION.task, rkey),
    repo,
    rkey,
    value: {
      title: "Initial task",
      status: "todo",
      priority: "none",
      t: hlcAt(0),
      createdAt: CREATED_AT,
      ...overrides,
    },
  };
}

function makeTaskEdit(
  subject: string,
  repo: string,
  rkey: string,
  value: Omit<TaskEditRecordValue, "subject">,
): StoredEntityRecord<TaskEditRecordValue> {
  return {
    uri: spaceRecordUri(SPACE, repo, COLLECTION.taskEdit, rkey),
    repo,
    rkey,
    value: {
      subject,
      ...value,
    },
  };
}

function makeProject(
  repo: string,
  rkey: string,
  overrides: Partial<ProjectRecordValue> = {},
): StoredEntityRecord<ProjectRecordValue> {
  return {
    uri: spaceRecordUri(SPACE, repo, COLLECTION.taskProject, rkey),
    repo,
    rkey,
    value: {
      name: "Core",
      t: hlcAt(0),
      createdAt: CREATED_AT,
      ...overrides,
    },
  };
}

function makeProjectEdit(
  subject: string,
  repo: string,
  rkey: string,
  value: Omit<ProjectEditRecordValue, "subject">,
): StoredEntityRecord<ProjectEditRecordValue> {
  return {
    uri: spaceRecordUri(SPACE, repo, COLLECTION.taskProjectEdit, rkey),
    repo,
    rkey,
    value: {
      subject,
      ...value,
    },
  };
}

function makeComment(
  subject: string,
  repo: string,
  rkey: string,
  body: string,
  createdAt = CREATED_AT,
  editedAt?: string,
): StoredEntityRecord<TaskCommentRecordValue> {
  return {
    uri: spaceRecordUri(SPACE, repo, COLLECTION.taskComment, rkey),
    repo,
    rkey,
    value: {
      subject,
      body,
      createdAt,
      ...(editedAt !== undefined ? { editedAt } : {}),
    },
  };
}

test("opId and opRef compute canonical NUL-delimited SHA-256 128-bit prefixes", () => {
  assert.equal(opId(ALICE, "2222222222222"), `${ALICE}/2222222222222`);
  const expected = createHash("sha256").update(`${ALICE}\u00002222222222222`).digest().subarray(0, 16).toString("hex");
  assert.equal(opRef(ALICE, "2222222222222"), expected);
  assert.match(expected, /^[0-9a-f]{32}$/);
  assert.notEqual(opRef("did:plc:ab", "c"), opRef("did:plc:a", "bc"));
});

test("HLC parsing, formatting, comparison, and advanceHlc handle all boundary transitions", () => {
  const baseMs = 1_700_000_000_000;
  assert.equal(formatHlc({ ms: MIN_HLC_MS, counter: 0 }), "001000000000000.0000");
  assert.equal(formatHlc({ ms: MAX_HLC_MS, counter: 0xffff }), "999999999999999.ffff");
  assert.deepEqual(parseHlc("001700000000000.00ff"), { ms: baseMs, counter: 255 });
  assert.equal(parseHlc("000999999999999.0000"), null);
  assert.equal(parseHlc("001700000000000.000G"), null);
  assert.equal(compareHlc("001700000000000.000a", "001700000000000.000b"), -1);
  assert.equal(compareOpOrder({ t: hlcAt(1), repo: ALICE, rkey: "a" }, { t: hlcAt(1), repo: BOB, rkey: "a" }), -1);

  // Fresh write with no prior own or observed timestamps.
  assert.equal(advanceHlc({ wallNowMs: baseMs }), "001700000000000.0000");

  // Backward local wall clock still advances monotonically past ownLast.
  assert.equal(
    advanceHlc({ wallNowMs: baseMs - 5_000, ownLast: "001700000000000.0002" }),
    "001700000000000.0003",
  );

  // Persisted future ownLast far ahead of wall clock is never clamped down.
  assert.equal(
    advanceHlc({ wallNowMs: baseMs, ownLast: formatHlc({ ms: baseMs + DEFAULT_MAX_HLC_DRIFT_MS * 10, counter: 7 }) }),
    formatHlc({ ms: baseMs + DEFAULT_MAX_HLC_DRIFT_MS * 10, counter: 8 }),
  );

  // Extreme remote drift beyond maxDriftMs is clamped to wallNowMs + maxDriftMs (counter 0 -> incremented to 1).
  const farFuture = formatHlc({ ms: baseMs + DEFAULT_MAX_HLC_DRIFT_MS * 30, counter: 0x0042 });
  assert.equal(
    advanceHlc({ wallNowMs: baseMs, observedTs: [farFuture] }),
    formatHlc({ ms: baseMs + DEFAULT_MAX_HLC_DRIFT_MS, counter: 1 }),
  );

  // Counter rollover at 0xffff carries into ms + 1 with counter 0.
  assert.equal(
    advanceHlc({ wallNowMs: baseMs, ownLast: formatHlc({ ms: baseMs, counter: 0xffff }) }),
    formatHlc({ ms: baseMs + 1, counter: 0 }),
  );

  // Wall clock advancing past prev.ms resets counter to 0.
  assert.equal(
    advanceHlc({ wallNowMs: baseMs + 10, ownLast: formatHlc({ ms: baseMs, counter: 99 }) }),
    formatHlc({ ms: baseMs + 10, counter: 0 }),
  );

  // Ceiling errors.
  assert.throws(() => advanceHlc({ wallNowMs: MIN_HLC_MS - 1 }), HlcRangeError);
  assert.throws(() => advanceHlc({ wallNowMs: MAX_HLC_MS }), HlcRangeError);
  assert.throws(() => advanceHlc({ wallNowMs: Number.NaN }), HlcRangeError);
  assert.throws(
    () => advanceHlc({ wallNowMs: MAX_HLC_MS - 1, ownLast: formatHlc({ ms: MAX_HLC_MS, counter: 0xffff }) }),
    HlcRangeError,
  );
});

test("causal dominance beats skewed HLC clocks without producing conflicts", () => {
  const root = makeTask(ALICE, tidFor(1), { t: hlcAt(0) });
  // Bob claims a skewed future timestamp far ahead of Alice's clamped clock.
  const skewed = makeTaskEdit(root.uri, BOB, tidFor(2), {
    t: hlcAt(DEFAULT_MAX_HLC_DRIFT_MS * 5, 0),
    s: [opRef(ALICE, tidFor(1))],
    title: "Skewed title",
  });
  // Alice observes Bob's edit, clamps her clock, and writes a causally later edit with a lower HLC.
  const aliceLaterT = advanceHlc({ wallNowMs: 1_700_000_001_000, observedTs: [skewed.value.t] });
  assert.ok(aliceLaterT < skewed.value.t);
  const later = makeTaskEdit(root.uri, ALICE, tidFor(3), {
    t: aliceLaterT,
    s: [opRef(ALICE, tidFor(1)), opRef(BOB, tidFor(2))],
    title: "Honest final title",
  });

  const merged = mergeTask(root, [skewed, later]);
  assert.ok(merged);
  assert.equal(merged.title, "Honest final title");
  assert.deepEqual(merged.otherVersions, {});
  assert.deepEqual(merged.activities, []);
});

test("equal canonical concurrent values suppress otherVersions and Overwrite Activity, while distinct values emit both", () => {
  const root = makeTask(ALICE, tidFor(1), { t: hlcAt(0) });
  const editA = makeTaskEdit(root.uri, ALICE, tidFor(2), {
    t: hlcAt(10),
    s: [opRef(ALICE, tidFor(1))],
    status: "done",
    title: "Alpha",
  });
  const editB = makeTaskEdit(root.uri, BOB, tidFor(3), {
    t: hlcAt(20),
    s: [opRef(ALICE, tidFor(1))],
    status: "done",
    title: "Beta",
  });

  const merged = mergeTask(root, [editA, editB]);
  assert.ok(merged);
  assert.equal(merged.status, "done");
  assert.equal(merged.otherVersions.status, undefined);
  assert.equal(merged.title, "Beta");
  assert.equal(merged.otherVersions.title?.length, 1);
  assert.equal(merged.otherVersions.title?.[0]?.value, "Alpha");
  assert.equal(merged.activities.length, 1);
  assert.equal(merged.activities[0]?.kind, "concurrentFieldOverwrite");
  assert.equal((merged.activities[0] as { field: string }).field, "title");

  // Incomplete sync keeps otherVersions for inspection but suppresses Activity notices and finality.
  const incomplete = mergeTask(root, [editA, editB], { complete: false });
  assert.ok(incomplete);
  assert.equal(incomplete.conflictFinal, false);
  assert.equal(incomplete.lifecycleFinal, false);
  assert.equal(incomplete.otherVersions.title?.length, 1);
  assert.deepEqual(incomplete.activities, []);
});

test("implicit root ancestry prevents s: [] edits from looking concurrent with delete or losing to root", () => {
  const root = makeTask(ALICE, tidFor(1), { t: hlcAt(100), title: "Root title" });
  // Minimal s: [] edit with lower skewed t still causally descends from root via implicit root ancestry.
  const minimalEdit = makeTaskEdit(root.uri, BOB, tidFor(2), {
    t: hlcAt(50),
    s: [],
    title: "Updated title",
  });
  const del = makeTaskEdit(root.uri, CAROL, tidFor(3), {
    t: hlcAt(200),
    s: [opRef(BOB, tidFor(2))],
    deleted: true,
  });

  const merged = mergeTask(root, [minimalEdit, del]);
  assert.ok(merged);
  assert.equal(merged.title, "Updated title");
  assert.equal(merged.deleted, true);
  assert.deepEqual(merged.otherVersions, {});
  assert.deepEqual(merged.activities, []);
});

test("multi-device concurrent same-DID heads preserve both heads and resolve deterministically", () => {
  const root = makeTask(ALICE, tidFor(1), { t: hlcAt(0) });
  const device1 = makeTaskEdit(root.uri, ALICE, tidFor(2), {
    t: hlcAt(10),
    s: [opRef(ALICE, tidFor(1))],
    priority: "low",
  });
  const device2 = makeTaskEdit(root.uri, ALICE, tidFor(3), {
    t: hlcAt(10),
    s: [opRef(ALICE, tidFor(1))],
    priority: "urgent",
  });

  const mergedForward = mergeTask(root, [device1, device2]);
  const mergedReverse = mergeTask(root, [device2, device1]);
  assert.deepEqual(mergedForward, mergedReverse);
  assert.ok(mergedForward);
  assert.equal(mergedForward.priority, "urgent");
  assert.equal(mergedForward.otherVersions.priority?.length, 1);
  assert.equal(mergedForward.otherVersions.priority?.[0]?.value, "low");
  assert.equal(mergedForward.activities.length, 1);
  assert.equal(mergedForward.activities[0]?.kind, "concurrentFieldOverwrite");
});

test("deletion overwrite, restore, and OR-Set concurrent add/remove emit exact Activity", () => {
  const root = makeTask(ALICE, tidFor(1), {
    t: hlcAt(0),
    assignees: [ALICE],
    labels: ["bug", "keep"],
  });
  const addAndRemove = makeTaskEdit(root.uri, BOB, tidFor(2), {
    t: hlcAt(10),
    s: [opRef(ALICE, tidFor(1))],
    removeLabels: ["bug"],
    addAssignees: [BOB],
  });
  const concurrentAdd = makeTaskEdit(root.uri, CAROL, tidFor(3), {
    t: hlcAt(12),
    s: [opRef(ALICE, tidFor(1))],
    addLabels: ["bug"],
  });

  const mergedSet = mergeTask(root, [addAndRemove, concurrentAdd]);
  assert.ok(mergedSet);
  assert.deepEqual(mergedSet.labels, ["bug", "keep"]);
  assert.deepEqual(mergedSet.assignees, [ALICE, BOB]);
  assert.equal(mergedSet.activities.length, 1);
  assert.equal(mergedSet.activities[0]?.kind, "concurrentSetConflict");

  // Concurrent delete beats edit & restore and emits concurrentDeleteOverwrite for each.
  const del = makeTaskEdit(root.uri, ALICE, tidFor(4), {
    t: hlcAt(15),
    s: [opRef(ALICE, tidFor(1))],
    deleted: true,
  });
  const concurrentEdit = makeTaskEdit(root.uri, BOB, tidFor(5), {
    t: hlcAt(25),
    s: [opRef(ALICE, tidFor(1))],
    title: "Lost edit",
  });
  const mergedDel = mergeTask(root, [del, concurrentEdit]);
  assert.ok(mergedDel);
  assert.equal(mergedDel.deleted, true);
  assert.equal(mergedDel.activities.length, 1);
  assert.equal(mergedDel.activities[0]?.kind, "concurrentDeleteOverwrite");

  // Explicit restore after observing delete clears deleted cleanly.
  const restore = makeTaskEdit(root.uri, ALICE, tidFor(6), {
    t: hlcAt(30),
    s: [opRef(ALICE, tidFor(1)), opRef(ALICE, tidFor(4)), opRef(BOB, tidFor(5))],
    deleted: false,
  });
  const mergedRestored = mergeTask(root, [del, concurrentEdit, restore]);
  assert.ok(mergedRestored);
  assert.equal(mergedRestored.deleted, false);
  assert.deepEqual(mergedRestored.activities, []);
});

test("orphan edits/comments are dropped when root is missing, and comments hide on deleted tasks", () => {
  assert.equal(mergeTask(null, []), null);
  assert.equal(mergeProject(undefined, []), null);

  const liveTask = makeTask(ALICE, tidFor(1), { t: hlcAt(0) });
  const deletedTask = makeTask(ALICE, tidFor(2), { t: hlcAt(0) });
  const deleteEdit = makeTaskEdit(deletedTask.uri, BOB, tidFor(3), {
    t: hlcAt(10),
    s: [opRef(ALICE, tidFor(2))],
    deleted: true,
  });
  const missingTaskUri = spaceRecordUri(SPACE, BOB, COLLECTION.task, tidFor(9));
  const orphanTaskEdit = makeTaskEdit(missingTaskUri, ALICE, tidFor(4), {
    t: hlcAt(20),
    s: [opRef(BOB, tidFor(9))],
    title: "Ghost",
  });
  const missingProjUri = spaceRecordUri(SPACE, BOB, COLLECTION.taskProject, tidFor(10));
  const orphanProjEdit = makeProjectEdit(missingProjUri, ALICE, tidFor(5), {
    t: hlcAt(20),
    s: [opRef(BOB, tidFor(10))],
    name: "Ghost project",
  });

  const liveComment = makeComment(liveTask.uri, BOB, tidFor(6), "On live task");
  const deletedTaskComment = makeComment(deletedTask.uri, ALICE, tidFor(7), "On deleted task");
  const orphanComment = makeComment(missingTaskUri, ALICE, tidFor(8), "On missing task");

  const space = mergeTasksSpace({
    projects: [makeProject(ALICE, tidFor(11))],
    projectEdits: [orphanProjEdit],
    tasks: [liveTask, deletedTask],
    taskEdits: [deleteEdit, orphanTaskEdit],
    comments: [liveComment, deletedTaskComment, orphanComment],
  });

  assert.equal(space.orphanedProjectEdits, 1);
  assert.equal(space.orphanedTaskEdits, 1);
  assert.equal(space.orphanedComments, 1);
  assert.equal(space.commentsByTask.get(liveTask.uri)?.length, 1);
  assert.equal(space.commentsByTask.get(deletedTask.uri), undefined);
  assert.equal(space.commentsByTask.get(missingTaskUri), undefined);
});

test("exact 255 vs 256 (final) vs 257 (saturated sTruncated: true, uncertainAncestry) boundaries", () => {
  function buildChain(totalOpsBeforeNewWrite: number) {
    const root = makeTask(ALICE, tidFor(1), { t: hlcAt(0) });
    const edits: StoredEntityRecord<TaskEditRecordValue>[] = [];
    const ops: Array<{ repo: string; rkey: string; t: string; s?: string[]; sTruncated?: boolean; isRoot?: boolean }> = [
      { repo: root.repo, rkey: root.rkey, t: root.value.t, isRoot: true },
    ];
    for (let i = 1; i < totalOpsBeforeNewWrite; i += 1) {
      const repo = i % 2 === 0 ? ALICE : BOB;
      const rkey = tidFor(i + 1);
      const t = hlcAt(i);
      const closure = buildEditClosure({ observedOps: ops });
      const edit = makeTaskEdit(root.uri, repo, rkey, {
        t,
        s: closure.s,
        ...(closure.sTruncated ? { sTruncated: true } : {}),
        title: `Title ${i}`,
      });
      edits.push(edit);
      ops.push({ repo, rkey, t, s: closure.s, sTruncated: closure.sTruncated });
    }
    const nextClosure = packCausalClosure({ observedOps: ops });
    const lastEdit = makeTaskEdit(root.uri, CAROL, tidFor(totalOpsBeforeNewWrite + 1), {
      t: hlcAt(totalOpsBeforeNewWrite),
      s: nextClosure.s,
      ...(nextClosure.sTruncated ? { sTruncated: true } : {}),
      title: "Final edit",
    });
    return { root, edits: [...edits, lastEdit], nextClosure };
  }

  // 255 prior ops -> s.length === 255, still normal & final.
  const c255 = buildChain(255);
  assert.equal(c255.nextClosure.totalClosureSize, 255);
  assert.equal(c255.nextClosure.s.length, 255);
  assert.equal(c255.nextClosure.sTruncated, false);
  const m255 = mergeTask(c255.root, c255.edits);
  assert.equal(m255?.uncertainAncestry, false);
  assert.equal(m255?.lifecycleFinal, true);
  assert.equal(m255?.conflictFinal, true);

  // 256 prior ops -> s.length === 256, STILL normal & final!
  const c256 = buildChain(256);
  assert.equal(c256.nextClosure.totalClosureSize, 256);
  assert.equal(c256.nextClosure.s.length, 256);
  assert.equal(c256.nextClosure.sTruncated, false);
  const m256 = mergeTask(c256.root, c256.edits);
  assert.equal(m256?.uncertainAncestry, false);
  assert.equal(m256?.lifecycleFinal, true);
  assert.equal(m256?.conflictFinal, true);

  // 257 prior ops -> saturated (sTruncated: true), non-final uncertainAncestry, Activity suppressed!
  const c257 = buildChain(257);
  assert.equal(c257.nextClosure.totalClosureSize, 257);
  assert.equal(c257.nextClosure.s.length, MAX_ANCESTOR_REFS);
  assert.equal(c257.nextClosure.sTruncated, true);
  const concurrentConflictEdit = makeTaskEdit(c257.root.uri, BOB, tidFor(999), {
    t: hlcAt(10),
    s: [opRef(ALICE, tidFor(1))],
    title: "Concurrent conflict on saturated task",
  });
  const m257 = mergeTask(c257.root, [...c257.edits, concurrentConflictEdit]);
  assert.equal(m257?.uncertainAncestry, true);
  assert.equal(m257?.lifecycleFinal, false);
  assert.equal(m257?.conflictFinal, false);
  assert.deepEqual(m257?.activities, []);
});

test("benign D14 dangling opRefs stay final, and >256 overflow after writer removal matches cold reader", () => {
  const root = makeTask(ALICE, tidFor(1), { t: hlcAt(0) });
  const del = makeTaskEdit(root.uri, ALICE, tidFor(2), {
    t: hlcAt(10),
    s: [opRef(ALICE, tidFor(1))],
    deleted: true,
  });
  const intermediateB = makeTaskEdit(root.uri, BOB, tidFor(3), {
    t: hlcAt(20),
    s: [opRef(ALICE, tidFor(1)), opRef(ALICE, tidFor(2))],
    title: "Bob saw delete",
  });
  const restoreC = makeTaskEdit(root.uri, CAROL, tidFor(4), {
    t: hlcAt(30),
    s: [opRef(ALICE, tidFor(1)), opRef(ALICE, tidFor(2)), opRef(BOB, tidFor(3))],
    deleted: false,
  });

  // Remove Bob under D14: opRef(Bob) inside restoreC.s is dangling, yet D -> B -> R survives and stays final.
  const afterBobPurged = mergeTask(root, [del, restoreC]);
  assert.ok(afterBobPurged);
  assert.equal(afterBobPurged.deleted, false);
  assert.equal(afterBobPurged.uncertainAncestry, false);
  assert.equal(afterBobPurged.lifecycleFinal, true);
  assert.equal(afterBobPurged.conflictFinal, true);
  assert.deepEqual(afterBobPurged.activities, []);
  void intermediateB;

  // >256 overflow with purged Bob refs: Tier 3 ranks live refs desc by (t, repo, rkey) then purged refs by ASCII opRef.
  const bobPurgedRefs = Array.from({ length: 12 }, (_, i) => opRef(BOB, tidFor(100 + i)));
  const liveEdits = Array.from({ length: 250 }, (_, i) =>
    makeTaskEdit(root.uri, i % 2 === 0 ? ALICE : CAROL, tidFor(200 + i), {
      t: hlcAt(50 + i),
      s: [opRef(ALICE, tidFor(1)), ...bobPurgedRefs.slice(0, (i % 12) + 1)],
      title: `Live ${i}`,
    }),
  );
  const opsForClosure = [
    { repo: root.repo, rkey: root.rkey, t: root.value.t, isRoot: true },
    ...liveEdits.map((e) => ({ repo: e.repo, rkey: e.rkey, t: e.value.t, s: e.value.s })),
  ];
  const packedA = buildEditClosure({ observedOps: opsForClosure });
  const packedB = buildEditClosure({ observedOps: [...opsForClosure].reverse() });
  assert.equal(packedA.sTruncated, true);
  assert.equal(packedA.s.length, MAX_ANCESTOR_REFS);
  assert.deepEqual(packedA.s, packedB.s);
  const expectedPurgedTail = [...bobPurgedRefs].sort().slice(0, MAX_ANCESTOR_REFS - 251);
  assert.deepEqual(packedA.s.slice(251), expectedPurgedTail);

  // 260 concurrent deletes fit cleanly into 256-entry Tier 1 saturation.
  const concurrentDeletes = Array.from({ length: 260 }, (_, i) => ({
    repo: i % 2 === 0 ? ALICE : BOB,
    rkey: tidFor(500 + i),
    t: hlcAt(1000 + i),
    s: [opRef(ALICE, tidFor(1))],
    deleted: true,
  }));
  const delClosure = buildEditClosure({
    observedOps: [{ repo: root.repo, rkey: root.rkey, t: root.value.t, isRoot: true }, ...concurrentDeletes],
  });
  assert.equal(delClosure.sTruncated, true);
  assert.equal(delClosure.s.length, MAX_ANCESTOR_REFS);
  assert.equal(delClosure.s[0], opRef(concurrentDeletes[259]!.repo, concurrentDeletes[259]!.rkey));
  assert.equal(delClosure.s[255], opRef(concurrentDeletes[4]!.repo, concurrentDeletes[4]!.rkey));
});

test("cycle detection removes back-edges deterministically and supports project clearDescription", () => {
  const project = makeProject(ALICE, tidFor(1), { t: hlcAt(0), description: "Initial", color: "#111111" });
  const clearEdit = makeProjectEdit(project.uri, BOB, tidFor(2), {
    t: hlcAt(10),
    s: [opRef(ALICE, tidFor(1))],
    clearDescription: true,
    color: "#222222",
  });
  const mergedProj = mergeProject(project, [clearEdit]);
  assert.ok(mergedProj);
  assert.equal(mergedProj.description, undefined);
  assert.equal(mergedProj.color, "#222222");

  // Tampered cycle between edit1 (t=10) and edit2 (t=20): edge edit2 -> edit1 is removed deterministically.
  const edit1 = makeProjectEdit(project.uri, ALICE, tidFor(3), {
    t: hlcAt(10),
    s: [opRef(ALICE, tidFor(1)), opRef(BOB, tidFor(4))],
    name: "Cycle A",
  });
  const edit2 = makeProjectEdit(project.uri, BOB, tidFor(4), {
    t: hlcAt(20),
    s: [opRef(ALICE, tidFor(1)), opRef(ALICE, tidFor(3))],
    name: "Cycle B",
  });
  const forward = mergeProject(project, [edit1, edit2]);
  const reverse = mergeProject(project, [edit2, edit1]);
  assert.deepEqual(forward, reverse);
  assert.equal(forward?.uncertainAncestry, true);
  assert.equal(forward?.lifecycleFinal, false);
  assert.equal(forward?.conflictFinal, false);
  assert.equal(forward?.name, "Cycle B");
  assert.deepEqual(forward?.activities, []);
});
