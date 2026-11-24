"use client";

import { useState } from "react";
import type { MergedTaskView, TaskCommentView, TaskStatus } from "@flock/client/ext/tasks";
import {
  isoToDateInput,
  PRIORITY_LABELS,
  shortDid,
  STATUS_LABELS,
  TASK_STATUSES,
  type ProjectDirectory,
} from "./tasks-ui-logic";

type TasksListViewProps = {
  tasks: readonly MergedTaskView[];
  projects: ProjectDirectory;
  commentsByTask: ReadonlyMap<string, TaskCommentView[]>;
  busy: boolean;
  onOpenTask: (task: MergedTaskView) => void;
  onOpenProject: (projectUri: string) => void;
  onChangeStatus: (task: MergedTaskView, status: TaskStatus) => Promise<void>;
  onRestoreTask: (task: MergedTaskView) => Promise<void>;
};

export function TasksListView({
  tasks,
  projects,
  commentsByTask,
  busy,
  onOpenTask,
  onOpenProject,
  onChangeStatus,
  onRestoreTask,
}: TasksListViewProps) {
  const [revealedHidden, setRevealedHidden] = useState<ReadonlySet<string>>(() => new Set());
  if (tasks.length === 0) {
    return (
      <div className="starter-card tasks-empty">
        <p>No tasks match the current filters.</p>
      </div>
    );
  }

  return (
    <div className="tasks-list" role="list" aria-label="Tasks list">
      {tasks.map((task) => {
        const conflictCount = Object.values(task.otherVersions).reduce((sum, list) => sum + (list?.length ?? 0), 0);
        const commentCount = commentsByTask.get(task.uri)?.length ?? 0;
        const dueLabel = isoToDateInput(task.dueDate);
        const isHiddenCollapsed = Boolean(task.hidden) && !revealedHidden.has(task.uri);
        if (isHiddenCollapsed) {
          return (
            <article key={task.uri} role="listitem" className="tasks-row" data-hidden="true">
              <span className="status-note">
                Hidden by group moderation —{" "}
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setRevealedHidden((prev) => new Set([...prev, task.uri]))}
                >
                  Show
                </button>
              </span>
            </article>
          );
        }
        return (
          <article
            key={task.uri}
            role="listitem"
            className={`tasks-row ${task.deleted ? "tasks-row-deleted" : ""}`}
            data-hidden={task.hidden ? "true" : undefined}
          >
            <div className="tasks-row-main">
              <select
                className="tasks-inline-select"
                aria-label={`Status for ${task.title}`}
                value={task.status}
                disabled={busy || task.deleted}
                onChange={(event) => void onChangeStatus(task, event.target.value as TaskStatus)}
              >
                {TASK_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {STATUS_LABELS[status]}
                  </option>
                ))}
              </select>

              <button
                type="button"
                className="tasks-title-link"
                onClick={() => onOpenTask(task)}
              >
                {task.title}
              </button>

              {task.deleted && <span className="tasks-chip tasks-chip-danger">Deleted</span>}
              {task.uncertainAncestry && (
                <span className="tasks-chip tasks-chip-warn" title="Causal history limit reached">
                  Non-final
                </span>
              )}
              {conflictCount > 0 && (
                <span className="tasks-chip tasks-chip-conflict">
                  {conflictCount} {conflictCount === 1 ? "conflict" : "conflicts"}
                </span>
              )}
            </div>

            <div className="tasks-row-meta">
              <span className={`tasks-priority tasks-priority-${task.priority}`}>
                {PRIORITY_LABELS[task.priority]}
              </span>
              {task.project && (
                <button
                  type="button"
                  className="tasks-chip tasks-chip-link"
                  onClick={() => onOpenProject(task.project!)}
                >
                  {projects.labelOf(task.project)}
                </button>
              )}
              {task.labels.map((label) => (
                <span key={label} className="tasks-chip">
                  {label}
                </span>
              ))}
              {task.assignees.map((did) => (
                <span key={did} className="tasks-chip" title={did}>
                  @{shortDid(did)}
                </span>
              ))}
              {dueLabel && <span className="tasks-meta-note">Due {dueLabel}</span>}
              {commentCount > 0 && (
                <span className="tasks-meta-note">
                  {commentCount} {commentCount === 1 ? "comment" : "comments"}
                </span>
              )}
              {task.deleted && (
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => void onRestoreTask(task)}
                >
                  Restore task
                </button>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}
