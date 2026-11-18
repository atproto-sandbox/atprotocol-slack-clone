"use client";

import { useState } from "react";
import type { MergedTaskView, TaskCommentView, TaskStatus } from "@flock/client/ext/tasks";
import {
  groupTasksByStatus,
  isoToDateInput,
  PRIORITY_LABELS,
  shortDid,
  STATUS_LABELS,
  TASK_STATUSES,
  type ProjectDirectory,
} from "./tasks-ui-logic";

type TasksBoardViewProps = {
  tasks: readonly MergedTaskView[];
  projects: ProjectDirectory;
  commentsByTask: ReadonlyMap<string, TaskCommentView[]>;
  busy: boolean;
  onOpenTask: (task: MergedTaskView) => void;
  onMoveTask: (task: MergedTaskView, status: TaskStatus) => Promise<void>;
};

export function TasksBoardView({
  tasks,
  projects,
  commentsByTask,
  busy,
  onOpenTask,
  onMoveTask,
}: TasksBoardViewProps) {
  const [dragOverStatus, setDragOverStatus] = useState<TaskStatus | null>(null);
  const [draggingUri, setDraggingUri] = useState<string | null>(null);
  const columns = groupTasksByStatus(tasks);
  const taskByUri = new Map(tasks.map((task) => [task.uri, task]));

  return (
    <div className="tasks-board" aria-label="Tasks Kanban board">
      {columns.map((column) => (
        <section
          key={column.status}
          className={`tasks-board-column ${dragOverStatus === column.status ? "tasks-board-column-over" : ""}`}
          aria-label={column.label}
          data-status={column.status}
          onDragOver={(event) => {
            event.preventDefault();
            if (dragOverStatus !== column.status) setDragOverStatus(column.status);
          }}
          onDragLeave={() => {
            if (dragOverStatus === column.status) setDragOverStatus(null);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragOverStatus(null);
            const droppedUri = event.dataTransfer.getData("text/plain") || draggingUri;
            setDraggingUri(null);
            if (!droppedUri) return;
            const task = taskByUri.get(droppedUri);
            if (!task || task.deleted || task.status === column.status) return;
            void onMoveTask(task, column.status);
          }}
        >
          <header className="tasks-board-column-header">
            <h3>{column.label}</h3>
            <span className="tasks-count-pill">{column.tasks.length}</span>
          </header>

          <div className="tasks-board-cards">
            {column.tasks.length === 0 ? (
              <p className="tasks-board-empty">No tasks</p>
            ) : (
              column.tasks.map((task) => {
                const statusIndex = TASK_STATUSES.indexOf(task.status);
                const prevStatus = statusIndex > 0 ? TASK_STATUSES[statusIndex - 1] : null;
                const nextStatus = statusIndex >= 0 && statusIndex < TASK_STATUSES.length - 1 ? TASK_STATUSES[statusIndex + 1] : null;
                const dueLabel = isoToDateInput(task.dueDate);
                const commentCount = commentsByTask.get(task.uri)?.length ?? 0;
                const conflictCount = Object.values(task.otherVersions).reduce((sum, list) => sum + (list?.length ?? 0), 0);

                return (
                  <article
                    key={task.uri}
                    className={`tasks-board-card ${task.deleted ? "tasks-row-deleted" : ""}`}
                    draggable={!task.deleted && !busy}
                    onDragStart={(event) => {
                      setDraggingUri(task.uri);
                      event.dataTransfer.setData("text/plain", task.uri);
                      event.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnd={() => {
                      setDraggingUri(null);
                      setDragOverStatus(null);
                    }}
                  >
                    <div className="tasks-board-card-top">
                      <button
                        type="button"
                        className="tasks-title-link"
                        onClick={() => onOpenTask(task)}
                      >
                        {task.title}
                      </button>
                      <span className={`tasks-priority tasks-priority-${task.priority}`}>
                        {PRIORITY_LABELS[task.priority]}
                      </span>
                    </div>

                    <div className="tasks-board-card-meta">
                      {task.project && <span className="tasks-chip">{projects.labelOf(task.project)}</span>}
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
                      {commentCount > 0 && <span className="tasks-meta-note">💬 {commentCount}</span>}
                      {conflictCount > 0 && <span className="tasks-chip tasks-chip-conflict">{conflictCount} conflict</span>}
                    </div>

                    <div className="tasks-board-card-actions">
                      <select
                        className="tasks-inline-select"
                        aria-label={`Move ${task.title} to status`}
                        value={task.status}
                        disabled={busy || task.deleted}
                        onChange={(event) => void onMoveTask(task, event.target.value as TaskStatus)}
                      >
                        {TASK_STATUSES.map((status) => (
                          <option key={status} value={status}>
                            {STATUS_LABELS[status]}
                          </option>
                        ))}
                      </select>
                      <div className="tasks-step-buttons">
                        {prevStatus && (
                          <button
                            type="button"
                            className="tasks-step-button"
                            aria-label={`Move ${task.title} to ${STATUS_LABELS[prevStatus]}`}
                            disabled={busy || task.deleted}
                            onClick={() => void onMoveTask(task, prevStatus)}
                          >
                            ←
                          </button>
                        )}
                        {nextStatus && (
                          <button
                            type="button"
                            className="tasks-step-button"
                            aria-label={`Move ${task.title} to ${STATUS_LABELS[nextStatus]}`}
                            disabled={busy || task.deleted}
                            onClick={() => void onMoveTask(task, nextStatus)}
                          >
                            →
                          </button>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
