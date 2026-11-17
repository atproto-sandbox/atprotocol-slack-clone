"use client";

import { useState } from "react";
import type { Engine } from "@flock/client/engine";
import type {
  MergedProjectView,
  MergedTaskView,
  ProjectScalarField,
  TaskActivityItem,
  TaskScalarField,
} from "@flock/client/ext/tasks";
import { messageOf } from "../../client-api";
import {
  DEFAULT_ACTIVITY_FILTER,
  describeActivityItem,
  filterActivities,
  type ActivityFilterState,
  type ProjectDirectory,
} from "./tasks-ui-logic";

type TasksActivityViewProps = {
  workspaceUri: string;
  activities: readonly TaskActivityItem[];
  projects: ProjectDirectory;
  tasks: readonly MergedTaskView[];
  tasksApi: Engine["tasks"];
  onOpenTask: (task: MergedTaskView) => void;
  onOpenProject: (project: MergedProjectView) => void;
  onMutated: () => Promise<void>;
  onStatus: (message: string) => void;
  onError: (message: string) => void;
};

export function TasksActivityView({
  workspaceUri,
  activities,
  projects,
  tasks,
  tasksApi,
  onOpenTask,
  onOpenProject,
  onMutated,
  onStatus,
  onError,
}: TasksActivityViewProps) {
  const [filter, setFilter] = useState<ActivityFilterState>(DEFAULT_ACTIVITY_FILTER);
  const [busy, setBusy] = useState(false);

  const tasksByUri = new Map(tasks.map((task) => [task.uri, task]));
  const visible = filterActivities(activities, filter);
  const unseenIds = activities.filter((item) => !item.seen && !item.dismissed).map((item) => item.id);

  async function markSeen(eventIds: readonly string[]) {
    if (eventIds.length === 0) return;
    setBusy(true);
    onError("");
    try {
      await tasksApi.markActivitySeen(workspaceUri, eventIds);
      await onMutated();
    } catch (caught) {
      onError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function dismiss(eventIds: readonly string[]) {
    if (eventIds.length === 0) return;
    setBusy(true);
    onError("");
    try {
      await tasksApi.dismissActivity(workspaceUri, eventIds);
      await onMutated();
    } catch (caught) {
      onError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function restore(item: TaskActivityItem) {
    setBusy(true);
    onError("");
    try {
      if (item.entityKind === "project") {
        const project = projects.byUri.get(item.entityUri);
        if (!project) throw new Error("Project no longer exists in this workspace.");
        const context = tasksApi.forkContext(project.observedContext);
        if (item.kind === "concurrentFieldOverwrite") {
          await tasksApi.restoreFieldVersion(workspaceUri, {
            entityKind: "project",
            context,
            field: item.field as ProjectScalarField,
            version: item.loser,
          });
        } else if (item.kind === "concurrentDeleteOverwrite") {
          await tasksApi.restoreProject(workspaceUri, { context });
        }
      } else {
        const task = tasksByUri.get(item.entityUri);
        if (!task) throw new Error("Task no longer exists in this workspace.");
        const context = tasksApi.forkContext(task.observedContext);
        if (item.kind === "concurrentFieldOverwrite") {
          await tasksApi.restoreFieldVersion(workspaceUri, {
            entityKind: "task",
            context,
            field: item.field as TaskScalarField,
            version: item.loser,
          });
        } else if (item.kind === "concurrentDeleteOverwrite") {
          await tasksApi.restoreTask(workspaceUri, { context });
        } else {
          await tasksApi.updateTask(workspaceUri, {
            context,
            ...(item.field === "assignees" ? { removeAssignees: [item.value] } : { removeLabels: [item.value] }),
          });
        }
      }
      await tasksApi.markActivitySeen(workspaceUri, [item.id]).catch(() => undefined);
      onStatus("Conflict restored.");
      await onMutated();
    } catch (caught) {
      onError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="tasks-activity">
      <div className="tasks-filter-bar">
        <select
          aria-label="Filter activity by kind"
          value={filter.kind}
          onChange={(event) => setFilter((cur) => ({ ...cur, kind: event.target.value as ActivityFilterState["kind"] }))}
        >
          <option value="all">All conflict types</option>
          <option value="concurrentFieldOverwrite">Field overwrites</option>
          <option value="concurrentDeleteOverwrite">Delete overwrites</option>
          <option value="concurrentSetConflict">Assignee / label conflicts</option>
        </select>
        <select
          aria-label="Filter activity by status"
          value={filter.visibility}
          onChange={(event) => setFilter((cur) => ({ ...cur, visibility: event.target.value as ActivityFilterState["visibility"] }))}
        >
          <option value="active">Active</option>
          <option value="unseen">Unseen only</option>
          <option value="all">All (including dismissed)</option>
        </select>
        {unseenIds.length > 0 && (
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() => void markSeen(unseenIds)}
          >
            Mark all seen ({unseenIds.length})
          </button>
        )}
      </div>

      {visible.length === 0 ? (
        <div className="starter-card tasks-empty">
          <p>No conflict activity matching the current filter.</p>
        </div>
      ) : (
        <div className="tasks-activity-list" role="list" aria-label="Conflict activity">
          {visible.map((item) => {
            const desc = describeActivityItem(item, projects, tasksByUri);
            const targetTask = item.entityKind === "task" ? tasksByUri.get(item.entityUri) : undefined;
            const targetProject = item.entityKind === "project" ? projects.byUri.get(item.entityUri) : undefined;
            const entityExists = Boolean(targetTask || targetProject);

            return (
              <article
                key={item.id}
                role="listitem"
                className={`starter-card tasks-activity-item ${!item.seen ? "tasks-activity-unseen" : ""}`}
              >
                <div className="tasks-activity-header">
                  <div>
                    <strong>{desc.title}</strong>
                    {!item.seen && !item.dismissed && <span className="tasks-chip tasks-chip-conflict">Unseen</span>}
                    {item.dismissed && <span className="tasks-chip">Dismissed</span>}
                  </div>
                  <div className="tasks-activity-actions">
                    {targetTask && (
                      <button type="button" className="text-button" onClick={() => onOpenTask(targetTask)}>
                        Open task →
                      </button>
                    )}
                    {targetProject && (
                      <button type="button" className="text-button" onClick={() => onOpenProject(targetProject)}>
                        Open project →
                      </button>
                    )}
                    {entityExists && (
                      <button
                        type="button"
                        className="text-button"
                        disabled={busy}
                        onClick={() => void restore(item)}
                      >
                        {desc.restoreLabel}
                      </button>
                    )}
                    {!item.seen && (
                      <button
                        type="button"
                        className="text-button"
                        disabled={busy}
                        onClick={() => void markSeen([item.id])}
                      >
                        Mark seen
                      </button>
                    )}
                    {!item.dismissed && (
                      <button
                        type="button"
                        className="text-button"
                        disabled={busy}
                        onClick={() => void dismiss([item.id])}
                      >
                        Dismiss
                      </button>
                    )}
                  </div>
                </div>
                <p>{desc.summary}</p>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
