import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { canonicalJson } from "./keys";

export const MIN_HLC_MS = 1_000_000_000_000;
export const MAX_HLC_MS = 999_999_999_999_999;
export const DEFAULT_MAX_HLC_DRIFT_MS = 24 * 60 * 60 * 1000;
export const MAX_ANCESTOR_REFS = 256;

export const TASK_STATUSES = ["backlog", "todo", "in_progress", "done", "canceled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export type HlcParts = { ms: number; counter: number };

const HLC_PATTERN = /^(\d{15})\.([0-9a-f]{4})$/;
const OP_REF_PATTERN = /^[0-9a-f]{32}$/;

/** Thrown when an HLC timestamp or wall clock falls outside the supported fixed-width range. */
export class HlcRangeError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "HlcRangeError";
  }
}

export function opId(repo: string, rkey: string): string {
  return `${repo}/${rkey}`;
}

export function opRef(repo: string, rkey: string): string {
  return bytesToHex(sha256(utf8ToBytes(`${repo}\u0000${rkey}`)).slice(0, 16));
}

export function parseHlc(value: string): HlcParts | null {
  if (typeof value !== "string") return null;
  const match = HLC_PATTERN.exec(value);
  if (!match) return null;
  const ms = Number(match[1]);
  const counter = Number.parseInt(match[2]!, 16);
  if (!Number.isSafeInteger(ms) || ms < MIN_HLC_MS || ms > MAX_HLC_MS) return null;
  if (!Number.isInteger(counter) || counter < 0 || counter > 0xffff) return null;
  return { ms, counter };
}

export function isValidHlc(value: unknown): value is string {
  return typeof value === "string" && parseHlc(value) !== null;
}

export function formatHlc(parts: HlcParts): string {
  if (!Number.isSafeInteger(parts.ms) || parts.ms < MIN_HLC_MS || parts.ms > MAX_HLC_MS) {
    throw new HlcRangeError(`HLC physical milliseconds out of range: ${String(parts.ms)}.`);
  }
  if (!Number.isInteger(parts.counter) || parts.counter < 0 || parts.counter > 0xffff) {
    throw new HlcRangeError(`HLC logical counter out of range: ${String(parts.counter)}.`);
  }
  return `${String(parts.ms).padStart(15, "0")}.${parts.counter.toString(16).padStart(4, "0")}`;
}

export function compareHlc(left: string | HlcParts, right: string | HlcParts): number {
  const a = toHlcParts(left, "left");
  const b = toHlcParts(right, "right");
  if (a.ms !== b.ms) return a.ms < b.ms ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  return 0;
}

export function compareOpOrder(
  left: { t: string; repo: string; rkey: string },
  right: { t: string; repo: string; rkey: string },
): number {
  if (left.t !== right.t) return left.t < right.t ? -1 : 1;
  if (left.repo !== right.repo) return left.repo < right.repo ? -1 : 1;
  if (left.rkey !== right.rkey) return left.rkey < right.rkey ? -1 : 1;
  return 0;
}

export type AdvanceHlcInput = {
  wallNowMs: number;
  ownLast?: string | HlcParts | null;
  observedTs?: readonly (string | HlcParts)[];
  maxDriftMs?: number;
};

/**
 * Computes the next strictly monotonic HLC timestamp from the caller's wall clock, prior own timestamp,
 * and clamped observed remote timestamps. Pure (never calls Date.now).
 */
export function advanceHlc(input: AdvanceHlcInput): string {
  const wallMs = Math.floor(input.wallNowMs);
  if (!Number.isFinite(input.wallNowMs) || wallMs < MIN_HLC_MS || wallMs >= MAX_HLC_MS) {
    throw new HlcRangeError(`Wall clock out of HLC range: ${String(input.wallNowMs)}.`);
  }
  const maxDriftMs = input.maxDriftMs ?? DEFAULT_MAX_HLC_DRIFT_MS;
  if (!Number.isFinite(maxDriftMs) || maxDriftMs < 0) {
    throw new HlcRangeError(`Invalid maxDriftMs: ${String(maxDriftMs)}.`);
  }
  const driftCeiling = Math.min(MAX_HLC_MS, wallMs + Math.floor(maxDriftMs));

  let prev: HlcParts | null = input.ownLast != null ? toHlcParts(input.ownLast, "ownLast") : null;
  for (const observed of input.observedTs ?? []) {
    const parsed = toHlcParts(observed, "observedTs");
    const clamped: HlcParts = parsed.ms > driftCeiling ? { ms: driftCeiling, counter: 0 } : parsed;
    if (!prev || compareHlc(clamped, prev) > 0) {
      prev = clamped;
    }
  }

  if (!prev) return formatHlc({ ms: wallMs, counter: 0 });
  const nextMs = Math.max(wallMs, prev.ms);
  if (nextMs > prev.ms) return formatHlc({ ms: nextMs, counter: 0 });
  if (prev.counter < 0xffff) return formatHlc({ ms: nextMs, counter: prev.counter + 1 });
  if (nextMs + 1 > MAX_HLC_MS) {
    throw new HlcRangeError("HLC timestamp exceeded MAX_HLC_MS.");
  }
  return formatHlc({ ms: nextMs + 1, counter: 0 });
}

export type ProjectRecordValue = {
  name: string;
  description?: string;
  color?: string;
  t: string;
  createdAt: string;
};

export type ProjectEditRecordValue = {
  subject: string;
  t: string;
  s: readonly string[];
  sTruncated?: boolean;
  name?: string;
  description?: string;
  clearDescription?: boolean;
  color?: string;
  deleted?: boolean;
};

export type TaskRecordValue = {
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  project?: string;
  dueDate?: string;
  parent?: string;
  assignees?: readonly string[];
  labels?: readonly string[];
  t: string;
  createdAt: string;
};

export type TaskEditRecordValue = {
  subject: string;
  t: string;
  s: readonly string[];
  sTruncated?: boolean;
  title?: string;
  description?: string;
  clearDescription?: boolean;
  status?: TaskStatus;
  priority?: TaskPriority;
  project?: string;
  clearProject?: boolean;
  dueDate?: string;
  clearDueDate?: boolean;
  parent?: string;
  clearParent?: boolean;
  addAssignees?: readonly string[];
  removeAssignees?: readonly string[];
  addLabels?: readonly string[];
  removeLabels?: readonly string[];
  deleted?: boolean;
};

export type TaskCommentRecordValue = {
  subject: string;
  body: string;
  createdAt: string;
  editedAt?: string;
};

export type StoredEntityRecord<V> = {
  uri: string;
  repo: string;
  rkey: string;
  value: V;
};

export type ClosureInputOp = {
  repo: string;
  rkey: string;
  t: string;
  s?: readonly string[];
  sTruncated?: boolean;
  deleted?: boolean;
  isRoot?: boolean;
};

export type BuildEditClosureInput = {
  observedOps: readonly ClosureInputOp[];
  inheritedRefs?: readonly string[];
  maxRefs?: number;
  alreadyTruncated?: boolean;
};

export type EditClosureResult = {
  s: string[];
  sTruncated: boolean;
  totalClosureSize: number;
};

/**
 * Packs a writer's observed causal closure into `s` (`<= 256` refs). When total closure exceeds 256 or saturation
 * already occurred, sets `sTruncated: true` and selects refs deterministically via the 3-tier retention policy.
 */
export function buildEditClosure(input: BuildEditClosureInput): EditClosureResult {
  const maxRefs = input.maxRefs ?? MAX_ANCESTOR_REFS;
  const liveByRef = new Map<string, ClosureInputOp & { opRef: string }>();
  for (const op of input.observedOps) {
    const ref = opRef(op.repo, op.rkey);
    if (!liveByRef.has(ref)) {
      liveByRef.set(ref, { ...op, opRef: ref });
    }
  }

  const liveOps = [...liveByRef.values()].sort(compareOpOrder);
  const fullClosure = new Set<string>();
  let anyTruncated = input.alreadyTruncated === true;

  for (const op of liveOps) {
    fullClosure.add(op.opRef);
    const refs = op.s ?? [];
    if (op.sTruncated === true || refs.length > maxRefs) anyTruncated = true;
    for (const ref of refs) {
      if (OP_REF_PATTERN.test(ref)) fullClosure.add(ref);
    }
  }
  for (const ref of input.inheritedRefs ?? []) {
    if (OP_REF_PATTERN.test(ref)) fullClosure.add(ref);
  }

  const dag = buildCausalDag(
    liveOps.map((op) => ({
      isRoot: op.isRoot === true,
      repo: op.repo,
      rkey: op.rkey,
      opId: opId(op.repo, op.rkey),
      opRef: op.opRef,
      t: op.t,
      s: op.s ?? [],
      sTruncated: op.sTruncated === true,
    })),
  );
  if (dag.cycleDetected) anyTruncated = true;

  const totalClosureSize = fullClosure.size;
  const unresolvedRefs = [...fullClosure]
    .filter((ref) => !liveByRef.has(ref))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  if (totalClosureSize <= maxRefs && !anyTruncated) {
    const sortedLiveRefs = [...liveOps].sort((left, right) => compareOpOrder(right, left)).map((op) => op.opRef);
    return {
      s: [...sortedLiveRefs, ...unresolvedRefs],
      sTruncated: false,
      totalClosureSize,
    };
  }

  const picked: string[] = [];
  const pickedSet = new Set<string>();
  const pushRef = (ref: string) => {
    if (picked.length < maxRefs && !pickedSet.has(ref)) {
      pickedSet.add(ref);
      picked.push(ref);
    }
  };

  // Tier 1: live synced un-superseded lifecycle ops (deleted: true | false), desc by (t, repo, rkey).
  const lifecycleIndices: number[] = [];
  for (let i = 0; i < dag.nodes.length; i += 1) {
    const d = liveOps[dag.nodes[i]!.sourceIndex]!.deleted;
    if (d === true || d === false) lifecycleIndices.push(i);
  }
  const unsupersededLifecycle = lifecycleIndices
    .filter((idx) => !lifecycleIndices.some((other) => other !== idx && dag.happensBefore(idx, other)))
    .sort((a, b) => compareOpOrder(dag.nodes[b]!, dag.nodes[a]!));
  for (const idx of unsupersededLifecycle) pushRef(dag.nodes[idx]!.opRef);

  // Tier 2: live minimal causal heads (antichain among synced records), desc by (t, repo, rkey).
  const heads = dag.headIndices.slice().sort((a, b) => compareOpOrder(dag.nodes[b]!, dag.nodes[a]!));
  for (const idx of heads) pushRef(dag.nodes[idx]!.opRef);

  // Tier 3: remaining live synced ops desc by (t, repo, rkey), then purged/unresolved opRefs by ASCII hex.
  const allLiveDesc = dag.nodes.map((_, idx) => idx).sort((a, b) => compareOpOrder(dag.nodes[b]!, dag.nodes[a]!));
  for (const idx of allLiveDesc) pushRef(dag.nodes[idx]!.opRef);
  for (const ref of unresolvedRefs) pushRef(ref);

  return {
    s: picked,
    sTruncated: true,
    totalClosureSize,
  };
}

export const packCausalClosure = buildEditClosure;

export type OpStamp = {
  opId: string;
  opRef: string;
  repo: string;
  rkey: string;
  t: string;
};

export type FieldVersion<T = string | undefined> = OpStamp & {
  value: T;
};

export type FieldOverwriteActivity = {
  kind: "concurrentFieldOverwrite";
  id: string;
  entityKind: "project" | "task";
  entityUri: string;
  field: string;
  winner: FieldVersion<string | undefined>;
  loser: FieldVersion<string | undefined>;
};

export type DeleteOverwriteActivity = {
  kind: "concurrentDeleteOverwrite";
  id: string;
  entityKind: "project" | "task";
  entityUri: string;
  winner: OpStamp;
  loser: OpStamp;
};

export type SetConflictActivity = {
  kind: "concurrentSetConflict";
  id: string;
  entityKind: "task";
  entityUri: string;
  field: "assignees" | "labels";
  value: string;
  winner: OpStamp;
  loser: OpStamp;
};

export type TaskActivityEvent = FieldOverwriteActivity | DeleteOverwriteActivity | SetConflictActivity;

export type ProjectScalarField = "name" | "description" | "color";
export type TaskScalarField = "title" | "description" | "status" | "priority" | "project" | "dueDate" | "parent";

export type MergedProject = {
  uri: string;
  repo: string;
  rkey: string;
  createdAt: string;
  name: string;
  description?: string;
  color?: string;
  deleted: boolean;
  uncertainAncestry: boolean;
  lifecycleFinal: boolean;
  conflictFinal: boolean;
  otherVersions: Partial<Record<ProjectScalarField, FieldVersion<string | undefined>[]>>;
  activities: TaskActivityEvent[];
  closureRefs: string[];
  maxHlc: string;
  headRefs: string[];
};

export type MergedTask = {
  uri: string;
  repo: string;
  rkey: string;
  createdAt: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  project?: string;
  dueDate?: string;
  parent?: string;
  assignees: string[];
  labels: string[];
  deleted: boolean;
  uncertainAncestry: boolean;
  lifecycleFinal: boolean;
  conflictFinal: boolean;
  otherVersions: Partial<Record<TaskScalarField, FieldVersion<string | undefined>[]>>;
  activities: TaskActivityEvent[];
  closureRefs: string[];
  maxHlc: string;
  headRefs: string[];
};

export type TaskCommentView = {
  uri: string;
  repo: string;
  rkey: string;
  subject: string;
  body: string;
  createdAt: string;
  editedAt?: string;
};

export type MergeOptions = {
  complete?: boolean;
};

export type TasksSpaceSnapshotInput = {
  projects: readonly StoredEntityRecord<ProjectRecordValue>[];
  projectEdits: readonly StoredEntityRecord<ProjectEditRecordValue>[];
  tasks: readonly StoredEntityRecord<TaskRecordValue>[];
  taskEdits: readonly StoredEntityRecord<TaskEditRecordValue>[];
  comments: readonly StoredEntityRecord<TaskCommentRecordValue>[];
  complete?: boolean;
};

export type MergedTasksSpace = {
  projects: MergedProject[];
  tasks: MergedTask[];
  commentsByTask: Map<string, TaskCommentView[]>;
  activities: TaskActivityEvent[];
  complete: boolean;
  orphanedProjectEdits: number;
  orphanedTaskEdits: number;
  orphanedComments: number;
};

export function mergeProject(
  root: StoredEntityRecord<ProjectRecordValue> | null | undefined,
  edits: readonly StoredEntityRecord<ProjectEditRecordValue>[],
  options: MergeOptions = {},
): MergedProject | null {
  if (!root) return null;
  const complete = options.complete ?? true;
  const matchingEdits = edits.filter((edit) => edit.value.subject === root.uri);
  const rawOps = [
    {
      isRoot: true,
      repo: root.repo,
      rkey: root.rkey,
      opId: opId(root.repo, root.rkey),
      opRef: opRef(root.repo, root.rkey),
      t: root.value.t,
      s: [] as readonly string[],
      sTruncated: false,
      value: root.value as ProjectRecordValue | ProjectEditRecordValue,
    },
    ...matchingEdits.map((edit) => ({
      isRoot: false,
      repo: edit.repo,
      rkey: edit.rkey,
      opId: opId(edit.repo, edit.rkey),
      opRef: opRef(edit.repo, edit.rkey),
      t: edit.value.t,
      s: edit.value.s,
      sTruncated: edit.value.sTruncated === true,
      value: edit.value as ProjectRecordValue | ProjectEditRecordValue,
    })),
  ];

  const dag = buildCausalDag(rawOps);
  const ops = dag.nodes.map((node) => rawOps[node.sourceIndex]!);
  const uncertainAncestry = dag.hasTruncated || dag.cycleDetected;
  const lifecycleFinal = complete && !uncertainAncestry;
  const conflictFinal = complete && !uncertainAncestry;
  const activities: TaskActivityEvent[] = [];

  const lifecycle = resolveLifecycle(
    dag,
    ops.map((op) => (op.isRoot ? undefined : (op.value as ProjectEditRecordValue).deleted)),
    "project",
    root.uri,
    conflictFinal,
  );
  activities.push(...lifecycle.activities);

  const otherVersions: Partial<Record<ProjectScalarField, FieldVersion<string | undefined>[]>> = {};
  const nameRes = resolveScalarField(
    dag,
    ops,
    (op) => ({ touched: true, value: (op.value as { name?: string }).name }),
    "project",
    root.uri,
    "name",
    conflictFinal,
  );
  if (nameRes.otherVersions.length > 0) otherVersions.name = nameRes.otherVersions;
  activities.push(...nameRes.activities);

  const descriptionRes = resolveScalarField(
    dag,
    ops,
    (op) => {
      if (op.isRoot) {
        const v = (op.value as ProjectRecordValue).description;
        return v !== undefined ? { touched: true, value: v } : { touched: false, value: undefined };
      }
      const e = op.value as ProjectEditRecordValue;
      if (e.clearDescription === true) return { touched: true, value: undefined };
      if (e.description !== undefined) return { touched: true, value: e.description };
      return { touched: false, value: undefined };
    },
    "project",
    root.uri,
    "description",
    conflictFinal,
  );
  if (descriptionRes.otherVersions.length > 0) otherVersions.description = descriptionRes.otherVersions;
  activities.push(...descriptionRes.activities);

  const colorRes = resolveScalarField(
    dag,
    ops,
    (op) => {
      const v = (op.value as { color?: string }).color;
      return v !== undefined ? { touched: true, value: v } : { touched: false, value: undefined };
    },
    "project",
    root.uri,
    "color",
    conflictFinal,
  );
  if (colorRes.otherVersions.length > 0) otherVersions.color = colorRes.otherVersions;
  activities.push(...colorRes.activities);

  return {
    uri: root.uri,
    repo: root.repo,
    rkey: root.rkey,
    createdAt: root.value.createdAt,
    name: nameRes.value ?? root.value.name,
    ...(descriptionRes.value !== undefined ? { description: descriptionRes.value } : {}),
    ...(colorRes.value !== undefined ? { color: colorRes.value } : {}),
    deleted: lifecycle.deleted,
    uncertainAncestry,
    lifecycleFinal,
    conflictFinal,
    otherVersions,
    activities: sortActivities(activities),
    closureRefs: collectClosureRefs(dag.nodes),
    maxHlc: maxOpHlc(dag.nodes),
    headRefs: dag.headIndices.map((idx) => dag.nodes[idx]!.opRef).sort(),
  };
}

export function mergeTask(
  root: StoredEntityRecord<TaskRecordValue> | null | undefined,
  edits: readonly StoredEntityRecord<TaskEditRecordValue>[],
  options: MergeOptions = {},
): MergedTask | null {
  if (!root) return null;
  const complete = options.complete ?? true;
  const matchingEdits = edits.filter((edit) => edit.value.subject === root.uri);
  const rawOps = [
    {
      isRoot: true,
      repo: root.repo,
      rkey: root.rkey,
      opId: opId(root.repo, root.rkey),
      opRef: opRef(root.repo, root.rkey),
      t: root.value.t,
      s: [] as readonly string[],
      sTruncated: false,
      value: root.value as TaskRecordValue | TaskEditRecordValue,
    },
    ...matchingEdits.map((edit) => ({
      isRoot: false,
      repo: edit.repo,
      rkey: edit.rkey,
      opId: opId(edit.repo, edit.rkey),
      opRef: opRef(edit.repo, edit.rkey),
      t: edit.value.t,
      s: edit.value.s,
      sTruncated: edit.value.sTruncated === true,
      value: edit.value as TaskRecordValue | TaskEditRecordValue,
    })),
  ];

  const dag = buildCausalDag(rawOps);
  const ops = dag.nodes.map((node) => rawOps[node.sourceIndex]!);
  const uncertainAncestry = dag.hasTruncated || dag.cycleDetected;
  const lifecycleFinal = complete && !uncertainAncestry;
  const conflictFinal = complete && !uncertainAncestry;
  const activities: TaskActivityEvent[] = [];

  const lifecycle = resolveLifecycle(
    dag,
    ops.map((op) => (op.isRoot ? undefined : (op.value as TaskEditRecordValue).deleted)),
    "task",
    root.uri,
    conflictFinal,
  );
  activities.push(...lifecycle.activities);

  const otherVersions: Partial<Record<TaskScalarField, FieldVersion<string | undefined>[]>> = {};
  const scalarSpecs: Array<{
    field: TaskScalarField;
    extract: (op: (typeof ops)[number]) => { touched: boolean; value: string | undefined };
  }> = [
    {
      field: "title",
      extract: (op) => {
        const v = (op.value as { title?: string }).title;
        return v !== undefined ? { touched: true, value: v } : { touched: false, value: undefined };
      },
    },
    {
      field: "description",
      extract: (op) => {
        if (op.isRoot) {
          const v = (op.value as TaskRecordValue).description;
          return v !== undefined ? { touched: true, value: v } : { touched: false, value: undefined };
        }
        const e = op.value as TaskEditRecordValue;
        if (e.clearDescription === true) return { touched: true, value: undefined };
        if (e.description !== undefined) return { touched: true, value: e.description };
        return { touched: false, value: undefined };
      },
    },
    {
      field: "status",
      extract: (op) => {
        const v = (op.value as { status?: TaskStatus }).status;
        return v !== undefined ? { touched: true, value: v } : { touched: false, value: undefined };
      },
    },
    {
      field: "priority",
      extract: (op) => {
        const v = (op.value as { priority?: TaskPriority }).priority;
        return v !== undefined ? { touched: true, value: v } : { touched: false, value: undefined };
      },
    },
    {
      field: "project",
      extract: (op) => {
        if (op.isRoot) {
          const v = (op.value as TaskRecordValue).project;
          return v !== undefined ? { touched: true, value: v } : { touched: false, value: undefined };
        }
        const e = op.value as TaskEditRecordValue;
        if (e.clearProject === true) return { touched: true, value: undefined };
        if (e.project !== undefined) return { touched: true, value: e.project };
        return { touched: false, value: undefined };
      },
    },
    {
      field: "dueDate",
      extract: (op) => {
        if (op.isRoot) {
          const v = (op.value as TaskRecordValue).dueDate;
          return v !== undefined ? { touched: true, value: v } : { touched: false, value: undefined };
        }
        const e = op.value as TaskEditRecordValue;
        if (e.clearDueDate === true) return { touched: true, value: undefined };
        if (e.dueDate !== undefined) return { touched: true, value: e.dueDate };
        return { touched: false, value: undefined };
      },
    },
    {
      field: "parent",
      extract: (op) => {
        if (op.isRoot) {
          const v = (op.value as TaskRecordValue).parent;
          return v !== undefined ? { touched: true, value: v } : { touched: false, value: undefined };
        }
        const e = op.value as TaskEditRecordValue;
        if (e.clearParent === true) return { touched: true, value: undefined };
        if (e.parent !== undefined) return { touched: true, value: e.parent };
        return { touched: false, value: undefined };
      },
    },
  ];

  const scalarValues: Partial<Record<TaskScalarField, string | undefined>> = {};
  for (const spec of scalarSpecs) {
    const resolved = resolveScalarField(dag, ops, spec.extract, "task", root.uri, spec.field, conflictFinal);
    scalarValues[spec.field] = resolved.value;
    if (resolved.otherVersions.length > 0) otherVersions[spec.field] = resolved.otherVersions;
    activities.push(...resolved.activities);
  }

  const assigneesRes = resolveOrSet(
    dag,
    ops,
    (op) => op.isRoot ? ((op.value as TaskRecordValue).assignees ?? []) : ((op.value as TaskEditRecordValue).addAssignees ?? []),
    (op) => op.isRoot ? [] : ((op.value as TaskEditRecordValue).removeAssignees ?? []),
    root.uri,
    "assignees",
    conflictFinal,
  );
  activities.push(...assigneesRes.activities);

  const labelsRes = resolveOrSet(
    dag,
    ops,
    (op) => op.isRoot ? ((op.value as TaskRecordValue).labels ?? []) : ((op.value as TaskEditRecordValue).addLabels ?? []),
    (op) => op.isRoot ? [] : ((op.value as TaskEditRecordValue).removeLabels ?? []),
    root.uri,
    "labels",
    conflictFinal,
  );
  activities.push(...labelsRes.activities);

  return {
    uri: root.uri,
    repo: root.repo,
    rkey: root.rkey,
    createdAt: root.value.createdAt,
    title: scalarValues.title ?? root.value.title,
    ...(scalarValues.description !== undefined ? { description: scalarValues.description } : {}),
    status: (scalarValues.status as TaskStatus | undefined) ?? root.value.status,
    priority: (scalarValues.priority as TaskPriority | undefined) ?? root.value.priority,
    ...(scalarValues.project !== undefined ? { project: scalarValues.project } : {}),
    ...(scalarValues.dueDate !== undefined ? { dueDate: scalarValues.dueDate } : {}),
    ...(scalarValues.parent !== undefined ? { parent: scalarValues.parent } : {}),
    assignees: assigneesRes.values,
    labels: labelsRes.values,
    deleted: lifecycle.deleted,
    uncertainAncestry,
    lifecycleFinal,
    conflictFinal,
    otherVersions,
    activities: sortActivities(activities),
    closureRefs: collectClosureRefs(dag.nodes),
    maxHlc: maxOpHlc(dag.nodes),
    headRefs: dag.headIndices.map((idx) => dag.nodes[idx]!.opRef).sort(),
  };
}

export function filterTaskComments(
  comments: readonly StoredEntityRecord<TaskCommentRecordValue>[],
  tasksByUri: ReadonlyMap<string, Pick<MergedTask, "deleted">>,
): { commentsByTask: Map<string, TaskCommentView[]>; orphanedComments: number } {
  const commentsByTask = new Map<string, TaskCommentView[]>();
  let orphanedComments = 0;

  for (const comment of comments) {
    const target = tasksByUri.get(comment.value.subject);
    if (!target || target.deleted) {
      if (!target) orphanedComments += 1;
      continue;
    }
    const list = commentsByTask.get(comment.value.subject) ?? [];
    list.push({
      uri: comment.uri,
      repo: comment.repo,
      rkey: comment.rkey,
      subject: comment.value.subject,
      body: comment.value.body,
      createdAt: comment.value.createdAt,
      ...(comment.value.editedAt !== undefined ? { editedAt: comment.value.editedAt } : {}),
    });
    commentsByTask.set(comment.value.subject, list);
  }

  for (const list of commentsByTask.values()) {
    list.sort((left, right) => {
      if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
      if (left.rkey !== right.rkey) return left.rkey < right.rkey ? -1 : 1;
      if (left.repo !== right.repo) return left.repo < right.repo ? -1 : 1;
      return 0;
    });
  }

  return { commentsByTask, orphanedComments };
}

export function mergeTasksSpace(input: TasksSpaceSnapshotInput): MergedTasksSpace {
  const complete = input.complete ?? true;
  const projectEditsBySubject = new Map<string, StoredEntityRecord<ProjectEditRecordValue>[]>();
  const projectUris = new Set(input.projects.map((p) => p.uri));
  let orphanedProjectEdits = 0;
  for (const edit of input.projectEdits) {
    if (!projectUris.has(edit.value.subject)) {
      orphanedProjectEdits += 1;
      continue;
    }
    const list = projectEditsBySubject.get(edit.value.subject) ?? [];
    list.push(edit);
    projectEditsBySubject.set(edit.value.subject, list);
  }

  const projects = input.projects
    .map((project) => mergeProject(project, projectEditsBySubject.get(project.uri) ?? [], { complete })!)
    .sort(compareEntityOrder);

  const taskEditsBySubject = new Map<string, StoredEntityRecord<TaskEditRecordValue>[]>();
  const taskUris = new Set(input.tasks.map((t) => t.uri));
  let orphanedTaskEdits = 0;
  for (const edit of input.taskEdits) {
    if (!taskUris.has(edit.value.subject)) {
      orphanedTaskEdits += 1;
      continue;
    }
    const list = taskEditsBySubject.get(edit.value.subject) ?? [];
    list.push(edit);
    taskEditsBySubject.set(edit.value.subject, list);
  }

  const tasks = input.tasks
    .map((task) => mergeTask(task, taskEditsBySubject.get(task.uri) ?? [], { complete })!)
    .sort(compareEntityOrder);

  const tasksByUri = new Map(tasks.map((task) => [task.uri, task]));
  const { commentsByTask, orphanedComments } = filterTaskComments(input.comments, tasksByUri);
  const activities = sortActivities([
    ...projects.flatMap((project) => project.activities),
    ...tasks.flatMap((task) => task.activities),
  ]);

  return {
    projects,
    tasks,
    commentsByTask,
    activities,
    complete,
    orphanedProjectEdits,
    orphanedTaskEdits,
    orphanedComments,
  };
}

type NormalizedDagOp = {
  sourceIndex: number;
  isRoot: boolean;
  repo: string;
  rkey: string;
  opId: string;
  opRef: string;
  t: string;
  s: readonly string[];
  sTruncated: boolean;
};

type CausalDag = {
  nodes: NormalizedDagOp[];
  hasTruncated: boolean;
  cycleDetected: boolean;
  headIndices: number[];
  happensBefore: (uIdx: number, vIdx: number) => boolean;
};

function buildCausalDag(rawOps: readonly Omit<NormalizedDagOp, "sourceIndex">[]): CausalDag {
  const deduped = new Map<string, NormalizedDagOp>();
  for (let index = 0; index < rawOps.length; index += 1) {
    const op = rawOps[index]!;
    if (!deduped.has(op.opId)) {
      deduped.set(op.opId, { ...op, sourceIndex: index });
    }
  }
  const nodes = [...deduped.values()].sort(compareOpOrder);
  const n = nodes.length;
  const refToIdx = new Map<string, number>();
  let rootIdx = -1;
  let hasTruncated = false;
  let selfLoop = false;

  for (let i = 0; i < n; i += 1) {
    const node = nodes[i]!;
    refToIdx.set(node.opRef, i);
    if (node.isRoot && rootIdx === -1) rootIdx = i;
    if (node.sTruncated || node.s.length > MAX_ANCESTOR_REFS) hasTruncated = true;
  }

  let adj: number[][] = Array.from({ length: n }, () => []);
  const seenEdge = Array.from({ length: n }, () => new Set<number>());
  const addEdge = (u: number, v: number) => {
    if (!seenEdge[u]!.has(v)) {
      seenEdge[u]!.add(v);
      adj[u]!.push(v);
    }
  };

  for (let v = 0; v < n; v += 1) {
    const node = nodes[v]!;
    if (!node.isRoot && rootIdx !== -1 && rootIdx !== v) {
      addEdge(rootIdx, v);
    }
    for (const ref of node.s) {
      if (ref === node.opRef) {
        selfLoop = true;
        continue;
      }
      const u = refToIdx.get(ref);
      if (u !== undefined) addEdge(u, v);
    }
  }

  let topo = topologicalOrder(adj, n);
  const cycleDetected = selfLoop || topo === null;

  if (topo === null) {
    const sccs = tarjanScc(adj, n);
    const cleanedAdj: number[][] = Array.from({ length: n }, () => []);
    for (let u = 0; u < n; u += 1) {
      for (const v of adj[u]!) {
        // Inside any SCC, remove edges going backwards in deterministic (t, repo, rkey) order to break all cycles identically.
        if (sccs[u] === sccs[v] && compareOpOrder(nodes[u]!, nodes[v]!) >= 0) continue;
        cleanedAdj[u]!.push(v);
      }
    }
    adj = cleanedAdj;
    topo = topologicalOrder(adj, n)!;
  }

  const words = Math.max(1, Math.ceil(n / 32));
  const ancestors: Uint32Array[] = Array.from({ length: n }, () => new Uint32Array(words));
  for (const u of topo) {
    const ancU = ancestors[u]!;
    const uWord = u >>> 5;
    const uMask = 1 << (u & 31);
    for (const v of adj[u]!) {
      const ancV = ancestors[v]!;
      for (let w = 0; w < words; w += 1) ancV[w] |= ancU[w]!;
      ancV[uWord] |= uMask;
    }
  }

  const happensBefore = (uIdx: number, vIdx: number): boolean =>
    uIdx !== vIdx && ((ancestors[vIdx]![uIdx >>> 5]! & (1 << (uIdx & 31))) !== 0);

  const headIndices: number[] = [];
  for (let i = 0; i < n; i += 1) {
    if (adj[i]!.length === 0) headIndices.push(i);
  }

  return { nodes, hasTruncated, cycleDetected, headIndices, happensBefore };
}

function topologicalOrder(adj: readonly (readonly number[])[], n: number): number[] | null {
  const inDegree = new Int32Array(n);
  for (let u = 0; u < n; u += 1) {
    for (const v of adj[u]!) inDegree[v] += 1;
  }
  const queue: number[] = [];
  for (let i = 0; i < n; i += 1) {
    if (inDegree[i] === 0) queue.push(i);
  }
  const order: number[] = [];
  for (let head = 0; head < queue.length; head += 1) {
    const u = queue[head]!;
    order.push(u);
    for (const v of adj[u]!) {
      inDegree[v] -= 1;
      if (inDegree[v] === 0) queue.push(v);
    }
  }
  return order.length === n ? order : null;
}

function tarjanScc(adj: readonly (readonly number[])[], n: number): Int32Array {
  const index = new Int32Array(n).fill(-1);
  const lowlink = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const sccId = new Int32Array(n).fill(-1);
  const tarjanStack: number[] = [];
  const callStack: Array<{ u: number; edgeIdx: number }> = [];
  let nextIndex = 0;
  let nextScc = 0;

  for (let start = 0; start < n; start += 1) {
    if (index[start] !== -1) continue;
    index[start] = lowlink[start] = nextIndex++;
    tarjanStack.push(start);
    onStack[start] = 1;
    callStack.push({ u: start, edgeIdx: 0 });

    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1]!;
      const neighbors = adj[frame.u]!;
      if (frame.edgeIdx < neighbors.length) {
        const v = neighbors[frame.edgeIdx++]!;
        if (index[v] === -1) {
          index[v] = lowlink[v] = nextIndex++;
          tarjanStack.push(v);
          onStack[v] = 1;
          callStack.push({ u: v, edgeIdx: 0 });
        } else if (onStack[v] === 1) {
          lowlink[frame.u] = Math.min(lowlink[frame.u]!, index[v]!);
        }
      } else {
        callStack.pop();
        if (callStack.length > 0) {
          const parent = callStack[callStack.length - 1]!.u;
          lowlink[parent] = Math.min(lowlink[parent]!, lowlink[frame.u]!);
        }
        if (lowlink[frame.u] === index[frame.u]) {
          const id = nextScc++;
          while (true) {
            const w = tarjanStack.pop()!;
            onStack[w] = 0;
            sccId[w] = id;
            if (w === frame.u) break;
          }
        }
      }
    }
  }
  return sccId;
}

function resolveLifecycle(
  dag: CausalDag,
  deletedFlags: readonly (boolean | undefined)[],
  entityKind: "project" | "task",
  entityUri: string,
  emitActivity: boolean,
): { deleted: boolean; activities: DeleteOverwriteActivity[] } {
  const deleteIndices: number[] = [];
  const restoreIndices: number[] = [];
  for (let i = 0; i < dag.nodes.length; i += 1) {
    if (deletedFlags[i] === true) deleteIndices.push(i);
    else if (deletedFlags[i] === false) restoreIndices.push(i);
  }
  const activeDeletes = deleteIndices.filter(
    (dIdx) => !restoreIndices.some((rIdx) => dag.happensBefore(dIdx, rIdx)),
  );
  if (activeDeletes.length === 0) return { deleted: false, activities: [] };

  const activities: DeleteOverwriteActivity[] = [];
  if (emitActivity) {
    const winningDeleteIdx = activeDeletes.reduce((best, cur) =>
      compareOpOrder(dag.nodes[cur]!, dag.nodes[best]!) > 0 ? cur : best,
    );
    const winner = toOpStamp(dag.nodes[winningDeleteIdx]!);
    for (let i = 0; i < dag.nodes.length; i += 1) {
      const node = dag.nodes[i]!;
      if (node.isRoot || deletedFlags[i] === true) continue;
      if (dag.happensBefore(i, winningDeleteIdx) || dag.happensBefore(winningDeleteIdx, i)) continue;
      const loser = toOpStamp(node);
      activities.push({
        kind: "concurrentDeleteOverwrite",
        id: `delete:${entityUri}:${winner.opId}:${loser.opId}`,
        entityKind,
        entityUri,
        winner,
        loser,
      });
    }
  }

  return { deleted: true, activities };
}

function resolveScalarField<Op extends { isRoot: boolean }>(
  dag: CausalDag,
  ops: readonly Op[],
  extract: (op: Op) => { touched: boolean; value: string | undefined },
  entityKind: "project" | "task",
  entityUri: string,
  field: string,
  emitActivity: boolean,
): {
  value: string | undefined;
  otherVersions: FieldVersion<string | undefined>[];
  activities: FieldOverwriteActivity[];
} {
  const touching: Array<{ idx: number; value: string | undefined }> = [];
  for (let i = 0; i < ops.length; i += 1) {
    const extracted = extract(ops[i]!);
    if (extracted.touched) touching.push({ idx: i, value: extracted.value });
  }
  if (touching.length === 0) return { value: undefined, otherVersions: [], activities: [] };

  const maximal = touching.filter(
    (item) => !touching.some((other) => other.idx !== item.idx && dag.happensBefore(item.idx, other.idx)),
  );
  maximal.sort((left, right) => compareOpOrder(dag.nodes[right.idx]!, dag.nodes[left.idx]!));

  const winnerEntry = maximal[0]!;
  const winnerCanonical = canonicalJson(winnerEntry.value ?? null);
  const winnerStamp = toOpStamp(dag.nodes[winnerEntry.idx]!);
  const winnerVersion: FieldVersion<string | undefined> = { ...winnerStamp, value: winnerEntry.value };

  const otherVersions: FieldVersion<string | undefined>[] = [];
  const activities: FieldOverwriteActivity[] = [];
  for (let i = 1; i < maximal.length; i += 1) {
    const entry = maximal[i]!;
    if (canonicalJson(entry.value ?? null) === winnerCanonical) continue;
    const loserVersion: FieldVersion<string | undefined> = { ...toOpStamp(dag.nodes[entry.idx]!), value: entry.value };
    otherVersions.push(loserVersion);
    if (emitActivity) {
      activities.push({
        kind: "concurrentFieldOverwrite",
        id: `field:${entityUri}:${field}:${winnerVersion.opId}:${loserVersion.opId}`,
        entityKind,
        entityUri,
        field,
        winner: winnerVersion,
        loser: loserVersion,
      });
    }
  }

  return { value: winnerEntry.value, otherVersions, activities };
}

function resolveOrSet<Op>(
  dag: CausalDag,
  ops: readonly Op[],
  getAdds: (op: Op) => readonly string[],
  getRemoves: (op: Op) => readonly string[],
  entityUri: string,
  field: "assignees" | "labels",
  emitActivity: boolean,
): { values: string[]; activities: SetConflictActivity[] } {
  const addsByItem = new Map<string, number[]>();
  const removesByItem = new Map<string, number[]>();

  for (let i = 0; i < ops.length; i += 1) {
    for (const item of getAdds(ops[i]!)) {
      const list = addsByItem.get(item) ?? [];
      list.push(i);
      addsByItem.set(item, list);
    }
    for (const item of getRemoves(ops[i]!)) {
      const list = removesByItem.get(item) ?? [];
      list.push(i);
      removesByItem.set(item, list);
    }
  }

  const activeItems: string[] = [];
  const activities: SetConflictActivity[] = [];
  for (const [item, addIndices] of addsByItem.entries()) {
    const removeIndices = removesByItem.get(item) ?? [];
    const activeAdds = addIndices.filter(
      (aIdx) => !removeIndices.some((rIdx) => dag.happensBefore(aIdx, rIdx)),
    );
    if (activeAdds.length === 0) continue;
    activeItems.push(item);

    if (!emitActivity || removeIndices.length === 0) continue;
    const unresolvedRemoves = removeIndices.filter(
      (rIdx) => !activeAdds.some((aIdx) => dag.happensBefore(rIdx, aIdx)),
    );
    if (unresolvedRemoves.length === 0) continue;

    const winnerIdx = activeAdds.reduce((best, cur) =>
      compareOpOrder(dag.nodes[cur]!, dag.nodes[best]!) > 0 ? cur : best,
    );
    const loserIdx = unresolvedRemoves.reduce((best, cur) =>
      compareOpOrder(dag.nodes[cur]!, dag.nodes[best]!) > 0 ? cur : best,
    );
    const winner = toOpStamp(dag.nodes[winnerIdx]!);
    const loser = toOpStamp(dag.nodes[loserIdx]!);
    activities.push({
      kind: "concurrentSetConflict",
      id: `set:${entityUri}:${field}:${item}:${winner.opId}:${loser.opId}`,
      entityKind: "task",
      entityUri,
      field,
      value: item,
      winner,
      loser,
    });
  }

  activeItems.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return { values: activeItems, activities };
}

function toOpStamp(node: NormalizedDagOp): OpStamp {
  return {
    opId: node.opId,
    opRef: node.opRef,
    repo: node.repo,
    rkey: node.rkey,
    t: node.t,
  };
}

function collectClosureRefs(ops: readonly NormalizedDagOp[]): string[] {
  const refs = new Set<string>();
  for (const op of ops) {
    refs.add(op.opRef);
    for (const ref of op.s) {
      if (OP_REF_PATTERN.test(ref)) refs.add(ref);
    }
  }
  return [...refs].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function maxOpHlc(ops: readonly NormalizedDagOp[]): string {
  let best = ops[0]!.t;
  for (let i = 1; i < ops.length; i += 1) {
    if (ops[i]!.t > best) best = ops[i]!.t;
  }
  return best;
}

function sortActivities<T extends TaskActivityEvent>(activities: readonly T[]): T[] {
  return [...activities].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function compareEntityOrder(left: { createdAt: string; repo: string; rkey: string }, right: { createdAt: string; repo: string; rkey: string }): number {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  if (left.rkey !== right.rkey) return left.rkey < right.rkey ? -1 : 1;
  if (left.repo !== right.repo) return left.repo < right.repo ? -1 : 1;
  return 0;
}

function toHlcParts(value: string | HlcParts, label: string): HlcParts {
  if (typeof value === "string") {
    const parsed = parseHlc(value);
    if (!parsed) throw new HlcRangeError(`Invalid HLC timestamp for ${label}: ${value}.`);
    return parsed;
  }
  formatHlc(value);
  return value;
}
