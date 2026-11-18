"use client";

import { useState, type FormEvent } from "react";
import type { Engine } from "@flock/client/engine";
import {
  StaleEntityContextError,
  type FieldVersion,
  type MergedTaskView,
  type ObservedEntityContext,
  type TaskCommentView,
  type TaskPriority,
  type TaskScalarField,
  type TaskStatus,
} from "@flock/client/ext/tasks";
import { messageOf } from "../../client-api";
import {
  buildTaskUpdatePatch,
  formatFieldValue,
  PRIORITY_LABELS,
  shortDid,
  STATUS_LABELS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  taskToDraft,
  UNCERTAIN_ANCESTRY_WARNING,
  type ProjectDirectory,
  type TaskDraft,
} from "./tasks-ui-logic";

type TaskDetailViewProps = {
  workspaceUri: string;
  viewerDid: string;
  task: MergedTaskView;
  comments: readonly TaskCommentView[];
  allTasks: readonly MergedTaskView[];
  projects: ProjectDirectory;
  rosterMembers: readonly string[];
  tasksApi: Engine["tasks"];
  manualSyncSeq?: number;
  onBack: () => void;
  onMutated: () => Promise<void>;
  onStatus: (message: string) => void;
  onError: (message: string) => void;
};

export function TaskDetailView({
  workspaceUri,
  viewerDid,
  task,
  comments,
  allTasks,
  projects,
  rosterMembers,
  tasksApi,
  manualSyncSeq = 0,
  onBack,
  onMutated,
  onStatus,
  onError,
}: TaskDetailViewProps) {
  // Isolate formContext upon open, edit, or save, preserving D11.5 #2 form-chain independence even across LiveSpaces updates.
  const [viewBaseline, setViewBaseline] = useState<{
    task: MergedTaskView;
    draft: TaskDraft;
    context: ObservedEntityContext;
    syncSeq: number;
  }>(() => ({
    task,
    draft: taskToDraft(task),
    context: tasksApi.forkContext(task.observedContext),
    syncSeq: manualSyncSeq,
  }));
  const [dirtyState, setDirtyState] = useState<{ draft: TaskDraft; context: ObservedEntityContext } | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [commentBody, setCommentBody] = useState("");
  const [editingCommentUri, setEditingCommentUri] = useState<string | null>(null);
  const [editingCommentBody, setEditingCommentBody] = useState("");
  const [busy, setBusy] = useState(false);

  const isDirty = dirtyState !== null;
  if (manualSyncSeq !== viewBaseline.syncSeq) {
    setViewBaseline({
      task: isDirty ? viewBaseline.task : task,
      draft: isDirty ? viewBaseline.draft : taskToDraft(task),
      context: isDirty ? viewBaseline.context : tasksApi.forkContext(task.observedContext),
      syncSeq: manualSyncSeq,
    });
  }

  const draft = dirtyState?.draft ?? viewBaseline.draft;
  const activeContext = dirtyState?.context ?? viewBaseline.context;

  const tasksByUri = new Map(allTasks.map((entry) => [entry.uri, entry]));
  const availableAssignees = [...new Set([...rosterMembers, ...task.assignees, ...draft.assignees])].sort();
  const parentCandidates = allTasks.filter((entry) => entry.uri !== task.uri && !entry.deleted);
  const updatedElsewhere = task.maxHlc !== activeContext.maxHlc;

  function forkActiveContext(): ObservedEntityContext {
    return tasksApi.forkContext(activeContext);
  }

  function updateDraft(patch: Partial<TaskDraft>) {
    setDirtyState((current) => {
      const baseContext = current?.context ?? tasksApi.forkContext(viewBaseline.context);
      const baseDraft = current?.draft ?? viewBaseline.draft;
      return {
        context: baseContext,
        draft: { ...baseDraft, ...patch },
      };
    });
  }

  function resetToLatest() {
    setDirtyState(null);
    setViewBaseline({
      task,
      draft: taskToDraft(task),
      context: tasksApi.forkContext(task.observedContext),
      syncSeq: manualSyncSeq,
    });
  }

  async function saveTask(event: FormEvent) {
    event.preventDefault();
    const patch = buildTaskUpdatePatch(viewBaseline.task, draft);
    if (!patch) {
      onStatus("No changes to save.");
      return;
    }
    const submitContext = dirtyState?.context ?? forkActiveContext();
    setBusy(true);
    onError("");
    try {
      const result = await tasksApi.updateTask(workspaceUri, {
        context: submitContext,
        ...patch,
      });
      setViewBaseline({
        task: result.task,
        draft: taskToDraft(result.task),
        context: tasksApi.forkContext(result.observedContext),
        syncSeq: manualSyncSeq,
      });
      setDirtyState(null);
      onStatus("Task updated.");
      await onMutated();
    } catch (caught) {
      if (caught instanceof StaleEntityContextError) {
        onError(caught.message);
      } else {
        onError(messageOf(caught));
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    setBusy(true);
    onError("");
    try {
      const result = await tasksApi.deleteTask(workspaceUri, { context: forkActiveContext() });
      setViewBaseline({
        task: result.task,
        draft: taskToDraft(result.task),
        context: tasksApi.forkContext(result.observedContext),
        syncSeq: manualSyncSeq,
      });
      setDirtyState(null);
      onStatus("Task deleted.");
      await onMutated();
    } catch (caught) {
      onError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleRestore() {
    setBusy(true);
    onError("");
    try {
      const result = await tasksApi.restoreTask(workspaceUri, { context: tasksApi.forkContext(task.observedContext) });
      setViewBaseline({
        task: result.task,
        draft: taskToDraft(result.task),
        context: tasksApi.forkContext(result.observedContext),
        syncSeq: manualSyncSeq,
      });
      setDirtyState(null);
      onStatus("Task restored.");
      await onMutated();
    } catch (caught) {
      onError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleRestoreVersion(field: TaskScalarField, version: FieldVersion<string | undefined>) {
    setBusy(true);
    onError("");
    try {
      const result = await tasksApi.restoreFieldVersion(workspaceUri, {
        entityKind: "task",
        context: tasksApi.forkContext(task.observedContext),
        field,
        version,
      });
      if ("task" in result) {
        setViewBaseline({
          task: result.task,
          draft: taskToDraft(result.task),
          context: tasksApi.forkContext(result.observedContext),
          syncSeq: manualSyncSeq,
        });
        setDirtyState(null);
      }
      onStatus(`Restored ${field} version.`);
      await onMutated();
    } catch (caught) {
      onError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  function addLabel() {
    const trimmed = newLabel.trim();
    if (!trimmed) return;
    if (!draft.labels.includes(trimmed)) {
      updateDraft({ labels: [...draft.labels, trimmed] });
    }
    setNewLabel("");
  }

  function toggleAssignee(did: string) {
    const next = draft.assignees.includes(did)
      ? draft.assignees.filter((item) => item !== did)
      : [...draft.assignees, did];
    updateDraft({ assignees: next });
  }

  async function submitComment(event: FormEvent) {
    event.preventDefault();
    const body = commentBody.trim();
    if (!body) return;
    setBusy(true);
    onError("");
    try {
      await tasksApi.addComment(workspaceUri, { taskUri: task.uri, body: commentBody });
      setCommentBody("");
      onStatus("Comment posted.");
      await onMutated();
    } catch (caught) {
      onError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function saveCommentEdit(event: FormEvent, commentUri: string) {
    event.preventDefault();
    if (!editingCommentBody.trim()) return;
    setBusy(true);
    onError("");
    try {
      await tasksApi.updateComment(workspaceUri, { commentUri, body: editingCommentBody });
      setEditingCommentUri(null);
      setEditingCommentBody("");
      onStatus("Comment updated.");
      await onMutated();
    } catch (caught) {
      onError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function removeComment(commentUri: string) {
    setBusy(true);
    onError("");
    try {
      await tasksApi.deleteComment(workspaceUri, commentUri);
      onStatus("Comment deleted.");
      await onMutated();
    } catch (caught) {
      onError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  const renderVersions = (field: TaskScalarField) => {
    const versions = task.otherVersions[field];
    if (!versions || versions.length === 0) return null;
    return (
      <details className="tasks-versions-disclosure">
        <summary>Concurrent versions ({versions.length})</summary>
        <ul className="tasks-versions-list">
          {versions.map((version) => (
            <li key={version.opId} className="tasks-version-item">
              <span>
                <strong>{formatFieldValue(field, version.value, projects, tasksByUri)}</strong>{" "}
                <small>
                  by {shortDid(version.repo)} · {version.t}
                </small>
              </span>
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => void handleRestoreVersion(field, version)}
              >
                Restore this version
              </button>
            </li>
          ))}
        </ul>
      </details>
    );
  };

  return (
    <div className="tasks-detail">
      <div className="tasks-detail-bar">
        <button type="button" className="text-button" onClick={onBack}>
          ← Back to tasks
        </button>
        <div className="tasks-detail-meta">
          <span className="mono-note">{task.rkey}</span>
          {task.deleted ? (
            <button type="button" className="text-button" disabled={busy} onClick={() => void handleRestore()}>
              Restore task
            </button>
          ) : (
            <button type="button" className="text-button danger" disabled={busy} onClick={() => void handleDelete()}>
              Delete task
            </button>
          )}
        </div>
      </div>

      {task.uncertainAncestry && (
        <div className="envelope-alert" role="alert">
          <strong>{UNCERTAIN_ANCESTRY_WARNING}</strong>
        </div>
      )}

      {task.deleted && (
        <div className="operation-alert" role="status">
          This task is deleted. Restore it to resume edits or comments.
        </div>
      )}

      {updatedElsewhere && (
        <div className="status-note" role="status">
          This task received newer changes while your form was open. Saving preserves your edit in conflict history, or{" "}
          <button type="button" className="text-button" onClick={resetToLatest}>
            Reset form to latest
          </button>
          .
        </div>
      )}

      <form className="starter-card tasks-detail-form" onSubmit={(event) => void saveTask(event)}>
        <div className="tasks-field">
          <label htmlFor="task-detail-title">Task title</label>
          <input
            id="task-detail-title"
            aria-label="Task title"
            value={draft.title}
            disabled={busy || task.deleted}
            onChange={(event) => updateDraft({ title: event.target.value })}
            required
          />
          {renderVersions("title")}
        </div>

        <div className="tasks-field">
          <label htmlFor="task-detail-description">Description</label>
          <textarea
            id="task-detail-description"
            aria-label="Description"
            rows={4}
            value={draft.description}
            disabled={busy || task.deleted}
            onChange={(event) => updateDraft({ description: event.target.value })}
            placeholder="Add context, acceptance notes, or links…"
          />
          {renderVersions("description")}
        </div>

        <div className="tasks-field-grid">
          <div className="tasks-field">
            <label htmlFor="task-detail-status">Status</label>
            <select
              id="task-detail-status"
              aria-label="Status"
              value={draft.status}
              disabled={busy || task.deleted}
              onChange={(event) => updateDraft({ status: event.target.value as TaskStatus })}
            >
              {TASK_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {STATUS_LABELS[status]}
                </option>
              ))}
            </select>
            {renderVersions("status")}
          </div>

          <div className="tasks-field">
            <label htmlFor="task-detail-priority">Priority</label>
            <select
              id="task-detail-priority"
              aria-label="Priority"
              value={draft.priority}
              disabled={busy || task.deleted}
              onChange={(event) => updateDraft({ priority: event.target.value as TaskPriority })}
            >
              {TASK_PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {PRIORITY_LABELS[priority]}
                </option>
              ))}
            </select>
            {renderVersions("priority")}
          </div>

          <div className="tasks-field">
            <label htmlFor="task-detail-project">Project</label>
            <select
              id="task-detail-project"
              aria-label="Project"
              value={draft.project}
              disabled={busy || task.deleted}
              onChange={(event) => updateDraft({ project: event.target.value })}
            >
              <option value="">No project</option>
              {projects.allProjects.map((project) => (
                <option key={project.uri} value={project.uri}>
                  {projects.labelOf(project.uri)}
                </option>
              ))}
            </select>
            {renderVersions("project")}
          </div>

          <div className="tasks-field">
            <label htmlFor="task-detail-due-date">Due date</label>
            <input
              id="task-detail-due-date"
              type="date"
              aria-label="Due date"
              value={draft.dueDate}
              disabled={busy || task.deleted}
              onChange={(event) => updateDraft({ dueDate: event.target.value })}
            />
            {renderVersions("dueDate")}
          </div>

          <div className="tasks-field">
            <label htmlFor="task-detail-parent">Parent task</label>
            <select
              id="task-detail-parent"
              aria-label="Parent task"
              value={draft.parent}
              disabled={busy || task.deleted}
              onChange={(event) => updateDraft({ parent: event.target.value })}
            >
              <option value="">None</option>
              {parentCandidates.map((candidate) => (
                <option key={candidate.uri} value={candidate.uri}>
                  {candidate.title}
                </option>
              ))}
            </select>
            {renderVersions("parent")}
          </div>
        </div>

        <fieldset className="tasks-fieldset">
          <legend>Assignees</legend>
          <div className="tasks-assignee-list">
            {availableAssignees.length === 0 ? (
              <small>No workspace members available.</small>
            ) : (
              availableAssignees.map((did) => (
                <label key={did} className="tasks-checkbox-chip">
                  <input
                    type="checkbox"
                    checked={draft.assignees.includes(did)}
                    disabled={busy || task.deleted}
                    onChange={() => toggleAssignee(did)}
                  />
                  <span title={did}>{shortDid(did)}</span>
                </label>
              ))
            )}
          </div>
        </fieldset>

        <div className="tasks-field">
          <label htmlFor="task-detail-new-label">Labels</label>
          <div className="tasks-labels-row">
            {draft.labels.map((label) => (
              <span key={label} className="tasks-chip">
                {label}
                {!task.deleted && (
                  <button
                    type="button"
                    className="tasks-chip-remove"
                    aria-label={`Remove label ${label}`}
                    disabled={busy}
                    onClick={() => updateDraft({ labels: draft.labels.filter((item) => item !== label) })}
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
          </div>
          <div className="tasks-inline-input">
            <input
              id="task-detail-new-label"
              aria-label="New label"
              value={newLabel}
              disabled={busy || task.deleted}
              placeholder="Add label…"
              onChange={(event) => setNewLabel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addLabel();
                }
              }}
            />
            <button type="button" className="text-button" disabled={busy || task.deleted} onClick={addLabel}>
              Add label
            </button>
          </div>
        </div>

        <div className="tasks-form-actions">
          <button type="submit" className="primary-button" disabled={busy || task.deleted}>
            {busy ? "Saving…" : "Save task"}
          </button>
          {isDirty && (
            <button type="button" className="text-button" disabled={busy} onClick={resetToLatest}>
              Discard edits
            </button>
          )}
        </div>
      </form>

      <section className="starter-card tasks-comments-section" aria-label="Task comments">
        <h3>Comments ({comments.length})</h3>
        {comments.length === 0 ? (
          <p>No comments yet.</p>
        ) : (
          <div className="tasks-comments-list">
            {comments.map((comment) => (
              <article key={comment.uri} className="tasks-comment-card">
                <div className="message-meta">
                  <strong title={comment.repo}>{shortDid(comment.repo)}</strong>
                  <span>
                    <time>{comment.createdAt}</time>
                    {comment.editedAt && <em className="tasks-edited-badge"> · edited</em>}
                  </span>
                </div>
                {editingCommentUri === comment.uri ? (
                  <form className="inline-form" onSubmit={(event) => void saveCommentEdit(event, comment.uri)}>
                    <textarea
                      aria-label="Edit comment"
                      value={editingCommentBody}
                      onChange={(event) => setEditingCommentBody(event.target.value)}
                      required
                    />
                    <div className="tasks-form-actions">
                      <button type="submit" className="primary-button" disabled={busy}>
                        Save comment
                      </button>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => {
                          setEditingCommentUri(null);
                          setEditingCommentBody("");
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : (
                  <p>{comment.body}</p>
                )}
                {comment.repo === viewerDid && editingCommentUri !== comment.uri && (
                  <div className="message-actions">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setEditingCommentUri(comment.uri);
                        setEditingCommentBody(comment.body);
                      }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="danger"
                      disabled={busy}
                      onClick={() => void removeComment(comment.uri)}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </article>
            ))}
          </div>
        )}

        {!task.deleted && (
          <form className="inline-form" onSubmit={(event) => void submitComment(event)}>
            <label htmlFor="task-new-comment">Add a comment</label>
            <textarea
              id="task-new-comment"
              aria-label="Add a comment"
              rows={3}
              value={commentBody}
              disabled={busy}
              onChange={(event) => setCommentBody(event.target.value)}
              placeholder="Write a comment…"
              required
            />
            <button type="submit" className="primary-button" disabled={busy}>
              Post comment
            </button>
          </form>
        )}
      </section>
    </div>
  );
}
