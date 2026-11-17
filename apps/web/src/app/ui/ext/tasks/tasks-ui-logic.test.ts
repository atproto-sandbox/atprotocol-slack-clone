import assert from "node:assert/strict";
import test from "node:test";
import type { MergedProjectView, MergedTaskView, TaskActivityItem } from "@flock/client/ext/tasks";
import {
  buildProjectDirectory,
  buildProjectUpdatePatch,
  buildTaskUpdatePatch,
  computeSetDiff,
  dateInputToIso,
  DEFAULT_ACTIVITY_FILTER,
  DEFAULT_TASK_FILTER,
  DEFAULT_TASK_SORT,
  describeActivityItem,
  filterActivities,
  filterAndSortTasks,
  groupTasksByStatus,
  isoToDateInput,
  taskToDraft,
} from "./tasks-ui-logic";

const ALICE = "did:plc:alice111111111111111111";
const BOB = "did:plc:bob22222222222222222222";
const SPACE = "at://did:plc:auth/space/new.flock.ext.tasks/x-1";

function makeProject(overrides: Partial<MergedProjectView> = {}): MergedProjectView {
  const repo = overrides.repo ?? ALICE;
  const rkey = overrides.rkey ?? "3k22222222222";
  const uri = overrides.uri ?? `${SPACE}/${repo}/new.flock.ext.tasks.project/${rkey}`;
  return {
    uri,
    repo,
    rkey,
    createdAt: "2026-11-16T00:00:00.000Z",
    name: "Roadmap",
    deleted: false,
    uncertainAncestry: false,
    lifecycleFinal: true,
    conflictFinal: true,
    otherVersions: {},
    activities: [],
    closureRefs: [],
    maxHlc: "001700000000000.0000",
    headRefs: [],
    observedContext: {
      entityUri: uri,
      formChainId: "form-1",
      baseClosure: [],
      maxHlc: "001700000000000.0000",
      baseUncertain: false,
    },
    ...overrides,
  };
}

function makeTask(overrides: Partial<MergedTaskView> = {}): MergedTaskView {
  const repo = overrides.repo ?? ALICE;
  const rkey = overrides.rkey ?? "3k33333333333";
  const uri = overrides.uri ?? `${SPACE}/${repo}/new.flock.ext.tasks.task/${rkey}`;
  return {
    uri,
    repo,
    rkey,
    createdAt: "2026-11-16T00:00:00.000Z",
    title: "Ship routing",
    status: "todo",
    priority: "medium",
    assignees: [],
    labels: [],
    deleted: false,
    uncertainAncestry: false,
    lifecycleFinal: true,
    conflictFinal: true,
    otherVersions: {},
    activities: [],
    closureRefs: [],
    maxHlc: "001700000000000.0000",
    headRefs: [],
    observedContext: {
      entityUri: uri,
      formChainId: "form-2",
      baseClosure: [],
      maxHlc: "001700000000000.0000",
      baseUncertain: false,
    },
    ...overrides,
  };
}

test("buildProjectDirectory disambiguates same-name same-rkey projects across creators", () => {
  const aliceProj = makeProject({ repo: ALICE, rkey: "3k22222222222", name: "Roadmap" });
  const bobProj = makeProject({ repo: BOB, rkey: "3k22222222222", name: "Roadmap" });
  const uniqueProj = makeProject({ repo: ALICE, rkey: "3k44444444444", name: "Ops" });

  const dir = buildProjectDirectory([aliceProj, bobProj, uniqueProj]);
  assert.notEqual(dir.labelOf(aliceProj.uri), dir.labelOf(bobProj.uri));
  assert.match(dir.labelOf(aliceProj.uri), /^Roadmap \(did:plc:alice/);
  assert.match(dir.labelOf(bobProj.uri), /^Roadmap \(did:plc:bob/);
  assert.equal(dir.labelOf(uniqueProj.uri), "Ops");
});

test("filterAndSortTasks filters by project, status, priority, assignee, label, query, deleted, and sorts cleanly", () => {
  const projA = makeProject({ repo: ALICE, rkey: "3k22222222221", name: "Alpha" });
  const projB = makeProject({ repo: BOB, rkey: "3k22222222221", name: "Alpha" });
  const tasks = [
    makeTask({ rkey: "t1", title: "Urgent bug", status: "in_progress", priority: "urgent", project: projA.uri, assignees: [ALICE], labels: ["bug"], maxHlc: "001700000000010.0000" }),
    makeTask({ rkey: "t2", title: "Low chore", status: "backlog", priority: "low", project: projB.uri, assignees: [BOB], labels: ["chore"], maxHlc: "001700000000020.0000" }),
    makeTask({ rkey: "t3", title: "Deleted note", status: "done", priority: "high", deleted: true, maxHlc: "001700000000030.0000" }),
  ];

  assert.deepEqual(
    filterAndSortTasks(tasks, DEFAULT_TASK_FILTER, DEFAULT_TASK_SORT).map((t) => t.rkey),
    ["t2", "t1"],
    "default hides deleted and sorts updated desc",
  );
  assert.deepEqual(
    filterAndSortTasks(tasks, { ...DEFAULT_TASK_FILTER, includeDeleted: true }, { key: "priority", dir: "desc" }).map((t) => t.rkey),
    ["t1", "t3", "t2"],
  );
  assert.deepEqual(
    filterAndSortTasks(tasks, { ...DEFAULT_TASK_FILTER, projectUri: projA.uri }, DEFAULT_TASK_SORT).map((t) => t.rkey),
    ["t1"],
  );
  assert.deepEqual(
    filterAndSortTasks(tasks, { ...DEFAULT_TASK_FILTER, assignee: BOB, label: "chore", query: "CHORE" }, DEFAULT_TASK_SORT).map((t) => t.rkey),
    ["t2"],
  );
});

test("groupTasksByStatus produces all 5 columns in canonical workflow order", () => {
  const cols = groupTasksByStatus([
    makeTask({ rkey: "a", status: "done" }),
    makeTask({ rkey: "b", status: "backlog" }),
  ]);
  assert.deepEqual(cols.map((c) => c.status), ["backlog", "todo", "in_progress", "done", "canceled"]);
  assert.deepEqual(cols.find((c) => c.status === "backlog")?.tasks.map((t) => t.rkey), ["b"]);
  assert.deepEqual(cols.find((c) => c.status === "done")?.tasks.map((t) => t.rkey), ["a"]);
});

test("buildTaskUpdatePatch & buildProjectUpdatePatch emit minimal changes and clear* flags without empty edits", () => {
  const proj = makeProject({ description: "Details", color: "#7659c8" });
  assert.equal(buildProjectUpdatePatch(proj, { name: "Roadmap", description: "Details", color: "#7659c8" }), null);
  assert.deepEqual(buildProjectUpdatePatch(proj, { name: "Roadmap v2", description: "", color: "#7659c8" }), {
    name: "Roadmap v2",
    clearDescription: true,
  });

  const task = makeTask({
    title: "Initial",
    description: "Long notes",
    project: proj.uri,
    dueDate: "2026-11-20T12:00:00.000Z",
    parent: `${SPACE}/${ALICE}/new.flock.ext.tasks.task/3kparent`,
    assignees: [ALICE],
    labels: ["ui", "r11"],
  });
  const unchangedDraft = taskToDraft(task);
  assert.equal(buildTaskUpdatePatch(task, unchangedDraft), null);

  const edited = {
    ...unchangedDraft,
    description: "",
    project: "",
    dueDate: "",
    parent: "",
    assignees: [BOB],
    labels: ["ui", "a11y"],
  };
  assert.deepEqual(buildTaskUpdatePatch(task, edited), {
    clearDescription: true,
    clearProject: true,
    clearDueDate: true,
    clearParent: true,
    addAssignees: [BOB],
    removeAssignees: [ALICE],
    addLabels: ["a11y"],
    removeLabels: ["r11"],
  });

  assert.equal(isoToDateInput("2026-11-20T12:00:00.000Z"), "2026-11-20");
  assert.equal(dateInputToIso("2026-11-25"), "2026-11-25T12:00:00.000Z");
  assert.deepEqual(computeSetDiff(["a", "b"], ["b", "c"]), { add: ["c"], remove: ["a"] });
});

test("filterActivities and describeActivityItem cover seen/dismissed filtering and all 3 conflict types", () => {
  const proj = makeProject();
  const task = makeTask();
  const dir = buildProjectDirectory([proj]);
  const taskMap = new Map([[task.uri, task]]);

  const fieldItem: TaskActivityItem = {
    kind: "concurrentFieldOverwrite",
    id: "field:1",
    entityKind: "task",
    entityUri: task.uri,
    field: "status",
    winner: { opId: `${ALICE}/1`, opRef: "a".repeat(32), repo: ALICE, rkey: "1", t: "001700000000002.0000", value: "done" },
    loser: { opId: `${BOB}/1`, opRef: "b".repeat(32), repo: BOB, rkey: "1", t: "001700000000001.0000", value: "in_progress" },
    seen: false,
    dismissed: false,
  };
  const delItem: TaskActivityItem = {
    kind: "concurrentDeleteOverwrite",
    id: "delete:1",
    entityKind: "task",
    entityUri: task.uri,
    winner: { opId: `${BOB}/2`, opRef: "c".repeat(32), repo: BOB, rkey: "2", t: "001700000000003.0000" },
    loser: { opId: `${ALICE}/2`, opRef: "d".repeat(32), repo: ALICE, rkey: "2", t: "001700000000002.0000" },
    seen: true,
    dismissed: false,
  };
  const setItem: TaskActivityItem = {
    kind: "concurrentSetConflict",
    id: "set:1",
    entityKind: "task",
    entityUri: task.uri,
    field: "labels",
    value: "urgent",
    winner: { opId: `${ALICE}/3`, opRef: "e".repeat(32), repo: ALICE, rkey: "3", t: "001700000000004.0000" },
    loser: { opId: `${BOB}/3`, opRef: "f".repeat(32), repo: BOB, rkey: "3", t: "001700000000003.0000" },
    seen: true,
    dismissed: true,
  };

  assert.deepEqual(filterActivities([fieldItem, delItem, setItem], DEFAULT_ACTIVITY_FILTER).map((i) => i.id), ["field:1", "delete:1"]);
  assert.deepEqual(filterActivities([fieldItem, delItem, setItem], { kind: "all", visibility: "unseen" }).map((i) => i.id), ["field:1"]);
  assert.deepEqual(filterActivities([fieldItem, delItem, setItem], { kind: "concurrentSetConflict", visibility: "all" }).map((i) => i.id), ["set:1"]);

  assert.match(describeActivityItem(fieldItem, dir, taskMap).summary, /"Done", overwriting "In progress"/);
  assert.match(describeActivityItem(delItem, dir, taskMap).summary, /deleted this task/);
  assert.match(describeActivityItem(setItem, dir, taskMap).summary, /added "urgent"/);
});
