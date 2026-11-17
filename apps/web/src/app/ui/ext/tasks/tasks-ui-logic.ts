import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  type MergedProjectView,
  type MergedTaskView,
  type ObservedEntityContext,
  type TaskActivityItem,
  type TaskPriority,
  type TaskStatus,
  type UpdateProjectInput,
  type UpdateTaskInput,
} from "@flock/client/ext/tasks";

export const UNCERTAIN_ANCESTRY_WARNING =
  "Task causal history limit reached — merge is best-effort and non-final; archive/duplicate to a fresh task";

export const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: "Backlog",
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
  canceled: "Canceled",
};

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};

const PRIORITY_RANK: Record<TaskPriority, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  urgent: 4,
};

const STATUS_RANK: Record<TaskStatus, number> = {
  in_progress: 0,
  todo: 1,
  backlog: 2,
  done: 3,
  canceled: 4,
};

export type TaskSortKey = "updated" | "created" | "priority" | "status" | "dueDate" | "title";
export type SortDirection = "asc" | "desc";
export type TaskSortState = { key: TaskSortKey; dir: SortDirection };

export type TaskFilterState = {
  projectUri: string; // "all" | "none" | exact project URI
  status: TaskStatus | "all";
  priority: TaskPriority | "all";
  assignee: string; // "all" | "unassigned" | exact DID
  label: string; // "all" | exact label
  query: string;
  includeDeleted: boolean;
};

export const DEFAULT_TASK_FILTER: TaskFilterState = {
  projectUri: "all",
  status: "all",
  priority: "all",
  assignee: "all",
  label: "all",
  query: "",
  includeDeleted: false,
};

export const DEFAULT_TASK_SORT: TaskSortState = {
  key: "updated",
  dir: "desc",
};

export type ActivityFilterState = {
  kind: "all" | "concurrentFieldOverwrite" | "concurrentDeleteOverwrite" | "concurrentSetConflict";
  visibility: "active" | "unseen" | "all";
};

export const DEFAULT_ACTIVITY_FILTER: ActivityFilterState = {
  kind: "all",
  visibility: "active",
};

export function shortDid(did: string): string {
  if (did.length <= 24) return did;
  return `${did.slice(0, 14)}…${did.slice(-6)}`;
}

export type ProjectDirectory = {
  activeProjects: MergedProjectView[];
  allProjects: MergedProjectView[];
  byUri: Map<string, MergedProjectView>;
  labelOf: (uri: string) => string;
};

/**
 * Indexes projects by unique URI (`p/[repo]/[rkey]`) and disambiguates projects that share a name across creators.
 */
export function buildProjectDirectory(projects: readonly MergedProjectView[]): ProjectDirectory {
  const byUri = new Map<string, MergedProjectView>();
  const activeNameCounts = new Map<string, number>();

  for (const project of projects) {
    byUri.set(project.uri, project);
    if (!project.deleted) {
      const normalized = project.name.trim().toLowerCase();
      activeNameCounts.set(normalized, (activeNameCounts.get(normalized) ?? 0) + 1);
    }
  }

  const labelOf = (uri: string): string => {
    const project = byUri.get(uri);
    if (!project) return uri;
    const normalized = project.name.trim().toLowerCase();
    const duplicateName = (activeNameCounts.get(normalized) ?? 0) > 1;
    const disambiguated = duplicateName ? `${project.name} (${shortDid(project.repo)})` : project.name;
    return project.deleted ? `${disambiguated} (deleted)` : disambiguated;
  };

  const sortProjects = (list: MergedProjectView[]) =>
    list.slice().sort((left, right) =>
      left.name.localeCompare(right.name)
      || left.createdAt.localeCompare(right.createdAt)
      || left.repo.localeCompare(right.repo)
      || left.rkey.localeCompare(right.rkey));

  const allProjects = sortProjects([...projects]);
  const activeProjects = allProjects.filter((project) => !project.deleted);
  return { activeProjects, allProjects, byUri, labelOf };
}

export function filterAndSortTasks(
  tasks: readonly MergedTaskView[],
  filter: TaskFilterState,
  sort: TaskSortState,
): MergedTaskView[] {
  const needle = filter.query.trim().toLowerCase();
  const filtered = tasks.filter((task) => {
    if (!filter.includeDeleted && task.deleted) return false;
    if (filter.projectUri === "none") {
      if (task.project !== undefined) return false;
    } else if (filter.projectUri !== "all") {
      if (task.project !== filter.projectUri) return false;
    }
    if (filter.status !== "all" && task.status !== filter.status) return false;
    if (filter.priority !== "all" && task.priority !== filter.priority) return false;
    if (filter.assignee === "unassigned") {
      if (task.assignees.length > 0) return false;
    } else if (filter.assignee !== "all") {
      if (!task.assignees.includes(filter.assignee)) return false;
    }
    if (filter.label !== "all" && !task.labels.includes(filter.label)) return false;
    if (needle) {
      const haystacks = [task.title, task.description ?? "", task.rkey, ...task.labels];
      if (!haystacks.some((part) => part.toLowerCase().includes(needle))) return false;
    }
    return true;
  });

  const sign = sort.dir === "asc" ? 1 : -1;
  return filtered.slice().sort((left, right) => {
    let cmp = 0;
    switch (sort.key) {
      case "updated":
        cmp = left.maxHlc.localeCompare(right.maxHlc);
        break;
      case "created":
        cmp = left.createdAt.localeCompare(right.createdAt);
        break;
      case "priority":
        cmp = PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority];
        break;
      case "status":
        cmp = STATUS_RANK[left.status] - STATUS_RANK[right.status];
        break;
      case "dueDate": {
        if (left.dueDate && right.dueDate) cmp = left.dueDate.localeCompare(right.dueDate);
        else if (left.dueDate) cmp = -1 * sign;
        else if (right.dueDate) cmp = 1 * sign;
        break;
      }
      case "title":
        cmp = left.title.localeCompare(right.title);
        break;
    }
    if (cmp !== 0) return cmp * sign;
    return left.uri.localeCompare(right.uri);
  });
}

export function groupTasksByStatus(
  tasks: readonly MergedTaskView[],
): Array<{ status: TaskStatus; label: string; tasks: MergedTaskView[] }> {
  const buckets = new Map<TaskStatus, MergedTaskView[]>(TASK_STATUSES.map((status) => [status, []]));
  for (const task of tasks) {
    buckets.get(task.status)?.push(task);
  }
  return TASK_STATUSES.map((status) => ({
    status,
    label: STATUS_LABELS[status],
    tasks: buckets.get(status) ?? [],
  }));
}

export function collectWorkspaceAssignees(
  rosterMembers: readonly string[],
  tasks: readonly MergedTaskView[],
): string[] {
  const set = new Set<string>(rosterMembers);
  for (const task of tasks) {
    for (const did of task.assignees) set.add(did);
  }
  return [...set].sort();
}

export function collectWorkspaceLabels(tasks: readonly MergedTaskView[]): string[] {
  const set = new Set<string>();
  for (const task of tasks) {
    for (const label of task.labels) set.add(label);
  }
  return [...set].sort((left, right) => left.localeCompare(right));
}

export function isoToDateInput(iso: string | undefined): string {
  if (!iso) return "";
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return match ? match[1]! : "";
}

export function dateInputToIso(dateValue: string, existingIso?: string): string | undefined {
  const trimmed = dateValue.trim();
  if (!trimmed) return undefined;
  if (existingIso && isoToDateInput(existingIso) === trimmed) return existingIso;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return undefined;
  return `${trimmed}T12:00:00.000Z`;
}

export function computeSetDiff(
  before: readonly string[],
  after: readonly string[],
): { add: string[]; remove: string[] } {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const add = [...afterSet].filter((item) => !beforeSet.has(item)).sort();
  const remove = [...beforeSet].filter((item) => !afterSet.has(item)).sort();
  return { add, remove };
}

export type TaskDraft = {
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  project: string;
  dueDate: string; // YYYY-MM-DD or ""
  parent: string;
  assignees: string[];
  labels: string[];
};

export function taskToDraft(task: MergedTaskView): TaskDraft {
  return {
    title: task.title,
    description: task.description ?? "",
    status: task.status,
    priority: task.priority,
    project: task.project ?? "",
    dueDate: isoToDateInput(task.dueDate),
    parent: task.parent ?? "",
    assignees: [...task.assignees],
    labels: [...task.labels],
  };
}

/**
 * Computes a minimal `UpdateTaskInput` mutation diff against `task`, returning `null` when nothing changed so no empty
 * `taskEdit` record is ever submitted (`REGISTRY` forbids no-op edits).
 */
export function buildTaskUpdatePatch(
  task: MergedTaskView,
  draft: TaskDraft,
): Omit<UpdateTaskInput, "context"> | null {
  const patch: Omit<UpdateTaskInput, "context"> = {};
  let changed = false;

  const trimmedTitle = draft.title.trim();
  if (trimmedTitle && trimmedTitle !== task.title) {
    patch.title = trimmedTitle;
    changed = true;
  }

  const beforeDesc = task.description ?? "";
  if (draft.description !== beforeDesc) {
    if (draft.description.length === 0) {
      if (task.description !== undefined) {
        patch.clearDescription = true;
        changed = true;
      }
    } else {
      patch.description = draft.description;
      changed = true;
    }
  }

  if (draft.status !== task.status) {
    patch.status = draft.status;
    changed = true;
  }

  if (draft.priority !== task.priority) {
    patch.priority = draft.priority;
    changed = true;
  }

  const beforeProject = task.project ?? "";
  if (draft.project !== beforeProject) {
    if (!draft.project) {
      if (task.project !== undefined) {
        patch.clearProject = true;
        changed = true;
      }
    } else {
      patch.project = draft.project;
      changed = true;
    }
  }

  const beforeDate = isoToDateInput(task.dueDate);
  if (draft.dueDate !== beforeDate) {
    if (!draft.dueDate) {
      if (task.dueDate !== undefined) {
        patch.clearDueDate = true;
        changed = true;
      }
    } else {
      const iso = dateInputToIso(draft.dueDate, task.dueDate);
      if (iso) {
        patch.dueDate = iso;
        changed = true;
      }
    }
  }

  const beforeParent = task.parent ?? "";
  if (draft.parent !== beforeParent) {
    if (!draft.parent) {
      if (task.parent !== undefined) {
        patch.clearParent = true;
        changed = true;
      }
    } else if (draft.parent !== task.uri) {
      patch.parent = draft.parent;
      changed = true;
    }
  }

  const assigneeDiff = computeSetDiff(task.assignees, draft.assignees);
  if (assigneeDiff.add.length > 0) {
    patch.addAssignees = assigneeDiff.add;
    changed = true;
  }
  if (assigneeDiff.remove.length > 0) {
    patch.removeAssignees = assigneeDiff.remove;
    changed = true;
  }

  const labelDiff = computeSetDiff(task.labels, draft.labels);
  if (labelDiff.add.length > 0) {
    patch.addLabels = labelDiff.add;
    changed = true;
  }
  if (labelDiff.remove.length > 0) {
    patch.removeLabels = labelDiff.remove;
    changed = true;
  }

  return changed ? patch : null;
}

export type ProjectDraft = {
  name: string;
  description: string;
  color: string;
};

export type ProjectEditorState = {
  projectUri: string;
  baseline: MergedProjectView;
  draft: ProjectDraft;
  context: ObservedEntityContext;
};

export function projectToDraft(project: MergedProjectView): ProjectDraft {
  return {
    name: project.name,
    description: project.description ?? "",
    color: project.color ?? "",
  };
}

/**
 * Captures an immutable opening baseline snapshot, draft, and forked causal context when opening the project editor so
 * concurrent remote changes cannot cause spurious clears and retained contexts cannot bleed across projects.
 */
export function openProjectEditor(
  project: MergedProjectView,
  forkContext: (context: ObservedEntityContext) => ObservedEntityContext,
): ProjectEditorState {
  return {
    projectUri: project.uri,
    baseline: project,
    draft: projectToDraft(project),
    context: forkContext(project.observedContext),
  };
}

/**
 * Derives the causal context for restoring a project's concurrent version, rejecting any retained editor context from a
 * different project or stale observation head in favor of a fresh fork from `targetProject`.
 */
export function resolveProjectRestoreContext(
  targetProject: MergedProjectView,
  retainedContext: ObservedEntityContext | null,
  forkContext: (context: ObservedEntityContext) => ObservedEntityContext,
): ObservedEntityContext {
  if (
    retainedContext &&
    retainedContext.entityUri === targetProject.uri &&
    retainedContext.maxHlc === targetProject.observedContext.maxHlc
  ) {
    return forkContext(retainedContext);
  }
  return forkContext(targetProject.observedContext);
}

/**
 * Computes a minimal `UpdateProjectInput` mutation diff against the opening `baseline` snapshot, returning `null` when
 * nothing changed so no empty `projectEdit` or spurious `clearDescription` for concurrent remote edits is submitted.
 */
export function buildProjectUpdatePatch(
  baseline: MergedProjectView,
  draft: ProjectDraft,
): Omit<UpdateProjectInput, "context"> | null {
  const patch: Omit<UpdateProjectInput, "context"> = {};
  let changed = false;

  const trimmedName = draft.name.trim();
  if (trimmedName && trimmedName !== baseline.name) {
    patch.name = trimmedName;
    changed = true;
  }

  const beforeDesc = baseline.description ?? "";
  if (draft.description !== beforeDesc) {
    if (draft.description.length === 0) {
      if (baseline.description !== undefined) {
        patch.clearDescription = true;
        changed = true;
      }
    } else {
      patch.description = draft.description;
      changed = true;
    }
  }

  const trimmedColor = draft.color.trim();
  if (trimmedColor && trimmedColor !== (baseline.color ?? "")) {
    patch.color = trimmedColor;
    changed = true;
  }

  return changed ? patch : null;
}

export function filterActivities(
  activities: readonly TaskActivityItem[],
  filter: ActivityFilterState,
): TaskActivityItem[] {
  return activities.filter((item) => {
    if (filter.kind !== "all" && item.kind !== filter.kind) return false;
    if (filter.visibility === "active" && item.dismissed) return false;
    if (filter.visibility === "unseen" && (item.dismissed || item.seen)) return false;
    return true;
  });
}

export function formatFieldValue(
  field: string,
  value: string | undefined,
  projects: ProjectDirectory,
  tasksByUri: ReadonlyMap<string, MergedTaskView>,
): string {
  if (value === undefined) return "(cleared)";
  if (field === "status" && value in STATUS_LABELS) return STATUS_LABELS[value as TaskStatus];
  if (field === "priority" && value in PRIORITY_LABELS) return PRIORITY_LABELS[value as TaskPriority];
  if (field === "project") return projects.labelOf(value);
  if (field === "parent") return tasksByUri.get(value)?.title ?? value;
  if (field === "dueDate") return isoToDateInput(value) || value;
  return value;
}

export type ActivityDescription = {
  title: string;
  summary: string;
  entityLabel: string;
  restoreLabel: string;
};

export function describeActivityItem(
  item: TaskActivityItem,
  projects: ProjectDirectory,
  tasksByUri: ReadonlyMap<string, MergedTaskView>,
): ActivityDescription {
  const entityLabel =
    item.entityKind === "project"
      ? projects.labelOf(item.entityUri)
      : tasksByUri.get(item.entityUri)?.title ?? item.entityUri;

  if (item.kind === "concurrentFieldOverwrite") {
    const winnerVal = formatFieldValue(item.field, item.winner.value, projects, tasksByUri);
    const loserVal = formatFieldValue(item.field, item.loser.value, projects, tasksByUri);
    return {
      title: `Concurrent ${item.field} edit on ${entityLabel}`,
      summary: `${shortDid(item.winner.repo)} kept "${winnerVal}", overwriting "${loserVal}" from ${shortDid(item.loser.repo)}.`,
      entityLabel,
      restoreLabel: "Restore",
    };
  }

  if (item.kind === "concurrentDeleteOverwrite") {
    return {
      title: `Concurrent delete on ${entityLabel}`,
      summary: `${shortDid(item.winner.repo)} deleted this ${item.entityKind}, overwriting concurrent edit from ${shortDid(item.loser.repo)}.`,
      entityLabel,
      restoreLabel: "Restore",
    };
  }

  return {
    title: `Concurrent ${item.field} conflict on ${entityLabel}`,
    summary: `${shortDid(item.winner.repo)} added "${item.value}", while ${shortDid(item.loser.repo)} concurrently removed it (add-wins kept it).`,
    entityLabel,
    restoreLabel: "Restore",
  };
}

export { TASK_PRIORITIES, TASK_STATUSES };
