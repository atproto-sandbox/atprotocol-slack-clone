"use client";

import { useMemo, useState, type FormEvent } from "react";
import type { Engine } from "@flock/client/engine";
import type {
  FieldVersion,
  MergedProjectView,
  MergedTaskView,
  ProjectScalarField,
  TaskPriority,
  TaskStatus,
} from "@flock/client/ext/tasks";
import type { LiveSpaces, Snapshots } from "@flock/client/views";
import type { WorkspaceSummary } from "@flock/protocol/workspace-summary";
import { messageOf } from "../../client-api";
import { tasksProjectRoute, tasksRoute, tasksTaskRoute, type AppRoute } from "../../routes";
import { TaskDetailView } from "./task-detail-view";
import { TasksActivityView } from "./tasks-activity-view";
import { TasksBoardView } from "./tasks-board-view";
import { TasksListView } from "./tasks-list-view";
import {
  buildProjectDirectory,
  buildProjectUpdatePatch,
  collectWorkspaceAssignees,
  collectWorkspaceLabels,
  dateInputToIso,
  DEFAULT_TASK_FILTER,
  DEFAULT_TASK_SORT,
  filterAndSortTasks,
  openProjectEditor,
  PRIORITY_LABELS,
  resolveProjectRestoreContext,
  shortDid,
  STATUS_LABELS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  UNCERTAIN_ANCESTRY_WARNING,
  type ProjectEditorState,
  type TaskFilterState,
  type TaskSortKey,
  type TaskSortState,
} from "./tasks-ui-logic";
import { useTasksSpace } from "./use-tasks-space";

type TasksRoute = Extract<AppRoute, { kind: "tasks" }>;

type TasksWorkspaceViewProps = {
  did: string;
  engine: Engine;
  live: LiveSpaces | null;
  snapshots: Snapshots | null;
  workspace: WorkspaceSummary;
  route: TasksRoute;
  navigate: (url: string) => void;
  onEnableTasks?: () => void;
  setStatus: (message: string) => void;
  setError: (message: string) => void;
};

export function TasksWorkspaceView({
  did,
  engine,
  live,
  snapshots,
  workspace,
  route,
  navigate,
  onEnableTasks,
  setStatus,
  setError,
}: TasksWorkspaceViewProps) {
  const tasksInstall = (workspace.extensions ?? []).find((ext) => ext.extId === "tasks");
  const tasksEnabled = Boolean(tasksInstall?.active);
  const { tasksView, reload } = useTasksSpace(
    { engine, live, snapshots },
    workspace.uri,
    tasksEnabled && tasksInstall ? tasksInstall.space : null,
  );

  const [filter, setFilter] = useState<TaskFilterState>(DEFAULT_TASK_FILTER);
  const [sort, setSort] = useState<TaskSortState>(DEFAULT_TASK_SORT);
  const [preferredLayout, setPreferredLayout] = useState<"list" | "board">("list");
  const [creatingProject, setCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectDesc, setNewProjectDesc] = useState("");
  const [newProjectColor, setNewProjectColor] = useState("#7659c8");

  const [projectEditor, setProjectEditor] = useState<ProjectEditorState | null>(null);

  const [creatingTask, setCreatingTask] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [newTaskDesc, setNewTaskDesc] = useState("");
  const [newTaskStatus, setNewTaskStatus] = useState<TaskStatus>("todo");
  const [newTaskPriority, setNewTaskPriority] = useState<TaskPriority>("none");
  const [newTaskProject, setNewTaskProject] = useState("");
  const [newTaskDueDate, setNewTaskDueDate] = useState("");
  const [newTaskLabels, setNewTaskLabels] = useState("");
  const [manualSyncSeq, setManualSyncSeq] = useState(0);
  const [busy, setBusy] = useState(false);

  const spaceView = tasksView.value;
  const projectDirectory = useMemo(() => buildProjectDirectory(spaceView?.projects ?? []), [spaceView?.projects]);
  const selectedProject = route.view === "project" ? projectDirectory.byUri.get(route.projectUri) ?? null : null;
  const selectedProjectUri = selectedProject?.uri ?? null;
  const selectedTask = route.view === "task" ? (spaceView?.tasks ?? []).find((t) => t.uri === route.taskUri) ?? null : null;

  if (projectEditor && projectEditor.projectUri !== selectedProjectUri) {
    setProjectEditor(null);
  }

  const activeProjectEditor =
    selectedProject &&
    projectEditor &&
    projectEditor.projectUri === selectedProject.uri &&
    projectEditor.context.entityUri === selectedProject.uri
      ? projectEditor
      : null;

  const effectiveFilter = useMemo<TaskFilterState>(() => {
    if (route.view === "project") {
      return { ...filter, projectUri: route.projectUri };
    }
    return filter;
  }, [filter, route]);

  const filteredTasks = useMemo(
    () => filterAndSortTasks(spaceView?.tasks ?? [], effectiveFilter, sort),
    [spaceView?.tasks, effectiveFilter, sort],
  );
  const assignees = useMemo(
    () => collectWorkspaceAssignees(spaceView?.rosterMembers ?? [], spaceView?.tasks ?? []),
    [spaceView?.rosterMembers, spaceView?.tasks],
  );
  const labels = useMemo(() => collectWorkspaceLabels(spaceView?.tasks ?? []), [spaceView?.tasks]);

  if (!tasksEnabled) {
    return (
      <div className="starter-card tasks-disabled">
        <h2>Tasks extension is not enabled</h2>
        <p>Enable the Tasks extension in workspace controls to create projects, track tasks, and review conflicts.</p>
        {workspace.isAdmin && onEnableTasks && (
          <button type="button" className="primary-button" onClick={onEnableTasks}>
            Enable Tasks in Workspace settings →
          </button>
        )}
      </div>
    );
  }

  const activeLayout: "list" | "board" =
    route.view === "board"
      ? "board"
      : route.view === "list"
        ? "list"
        : route.view === "project"
          ? (route.layout ?? preferredLayout)
          : preferredLayout;

  const activeTab: "list" | "board" | "activity" | "task" =
    route.view === "activity"
      ? "activity"
      : route.view === "task"
        ? "task"
        : activeLayout;

  function openListTab() {
    setPreferredLayout("list");
    if (route.view === "project") {
      navigate(tasksProjectRoute({ authority: route.authority, workspaceSkey: route.workspaceSkey, repo: route.repo, rkey: route.rkey, layout: "list" }));
    } else {
      navigate(tasksRoute(route.authority, route.workspaceSkey, "list"));
    }
  }

  function openBoardTab() {
    setPreferredLayout("board");
    if (route.view === "project") {
      navigate(tasksProjectRoute({ authority: route.authority, workspaceSkey: route.workspaceSkey, repo: route.repo, rkey: route.rkey, layout: "board" }));
    } else {
      navigate(tasksRoute(route.authority, route.workspaceSkey, "board"));
    }
  }

  function openActivityTab() {
    navigate(tasksRoute(route.authority, route.workspaceSkey, "activity"));
  }

  function switchProjectScope(value: string) {
    setProjectEditor(null);
    if (value === "all" || value === "none") {
      setFilter((current) => ({ ...current, projectUri: value }));
      if (route.view === "project" || route.view === "task" || route.view === "activity") {
        navigate(tasksRoute(route.authority, route.workspaceSkey, activeLayout));
      }
      return;
    }
    const project = projectDirectory.byUri.get(value);
    if (!project) return;
    setFilter((current) => ({ ...current, projectUri: "all" }));
    navigate(
      tasksProjectRoute({
        authority: route.authority,
        workspaceSkey: route.workspaceSkey,
        repo: project.repo,
        rkey: project.rkey,
        layout: activeLayout,
      }),
    );
  }

  async function submitCreateProject(event: FormEvent) {
    event.preventDefault();
    if (!newProjectName.trim()) return;
    setBusy(true);
    setError("");
    try {
      const result = await engine.tasks.createProject(workspace.uri, {
        name: newProjectName.trim(),
        ...(newProjectDesc.trim() ? { description: newProjectDesc.trim() } : {}),
        ...(newProjectColor.trim() ? { color: newProjectColor.trim() } : {}),
      });
      setCreatingProject(false);
      setNewProjectName("");
      setNewProjectDesc("");
      setStatus("Project created.");
      await reload();
      navigate(
        tasksProjectRoute({
          authority: route.authority,
          workspaceSkey: route.workspaceSkey,
          repo: result.project.repo,
          rkey: result.rkey,
          layout: activeLayout,
        }),
      );
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  function startEditProject(project: MergedProjectView) {
    setProjectEditor(openProjectEditor(project, (ctx) => engine.tasks.forkContext(ctx)));
  }

  async function submitEditProject(event: FormEvent, project: MergedProjectView) {
    event.preventDefault();
    if (!activeProjectEditor || activeProjectEditor.projectUri !== project.uri || activeProjectEditor.context.entityUri !== project.uri) {
      setProjectEditor(null);
      return;
    }
    const patch = buildProjectUpdatePatch(activeProjectEditor.baseline, activeProjectEditor.draft);
    if (!patch) {
      setProjectEditor(null);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await engine.tasks.updateProject(workspace.uri, {
        context: activeProjectEditor.context,
        ...patch,
      });
      setProjectEditor(null);
      setStatus("Project updated.");
      await reload();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function toggleProjectDelete(project: MergedProjectView, shouldDelete: boolean) {
    setBusy(true);
    setError("");
    try {
      const context = engine.tasks.forkContext(project.observedContext);
      if (shouldDelete) {
        setProjectEditor((cur) => (cur?.projectUri === project.uri ? null : cur));
        await engine.tasks.deleteProject(workspace.uri, { context });
      } else {
        await engine.tasks.restoreProject(workspace.uri, { context });
      }
      setStatus(shouldDelete ? "Project deleted." : "Project restored.");
      await reload();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function restoreProjectVersion(
    project: MergedProjectView,
    field: ProjectScalarField,
    version: FieldVersion<string | undefined>,
  ) {
    setBusy(true);
    setError("");
    try {
      const context = resolveProjectRestoreContext(
        project,
        activeProjectEditor?.context ?? null,
        (ctx) => engine.tasks.forkContext(ctx),
      );
      const result = await engine.tasks.restoreFieldVersion(workspace.uri, {
        entityKind: "project",
        context,
        field,
        version,
      });
      if ("project" in result) {
        setProjectEditor((cur) =>
          cur && cur.projectUri === project.uri
            ? openProjectEditor(result.project, () => engine.tasks.forkContext(result.observedContext))
            : null,
        );
      }
      setStatus(`Restored project ${field}.`);
      await reload();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function submitCreateTask(event: FormEvent) {
    event.preventDefault();
    if (!newTaskTitle.trim()) return;
    setBusy(true);
    setError("");
    try {
      const parsedLabels = newTaskLabels
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      const projectChoice = newTaskProject || (route.view === "project" ? route.projectUri : "");
      const dueDateIso = newTaskDueDate ? dateInputToIso(newTaskDueDate) : undefined;
      await engine.tasks.createTask(workspace.uri, {
        title: newTaskTitle.trim(),
        ...(newTaskDesc.trim() ? { description: newTaskDesc.trim() } : {}),
        status: newTaskStatus,
        priority: newTaskPriority,
        ...(projectChoice ? { project: projectChoice } : {}),
        ...(dueDateIso ? { dueDate: dueDateIso } : {}),
        ...(parsedLabels.length > 0 ? { labels: parsedLabels } : {}),
      });
      setCreatingTask(false);
      setNewTaskTitle("");
      setNewTaskDesc("");
      setNewTaskDueDate("");
      setNewTaskLabels("");
      setStatus("Task created.");
      await reload();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function moveTaskStatus(task: MergedTaskView, status: TaskStatus) {
    if (task.status === status || task.deleted) return;
    setBusy(true);
    setError("");
    try {
      const context = engine.tasks.forkContext(task.observedContext);
      await engine.tasks.updateTask(workspace.uri, { context, status });
      await reload();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function restoreTaskInline(task: MergedTaskView) {
    setBusy(true);
    setError("");
    try {
      const context = engine.tasks.forkContext(task.observedContext);
      await engine.tasks.restoreTask(workspace.uri, { context });
      setStatus("Task restored.");
      await reload();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  const loadingInitial = tasksView.loading && !spaceView;
  const currentProjectSelectValue = route.view === "project" ? route.projectUri : filter.projectUri;
  const nonUncertainDegradedReasons = (spaceView?.degradedReasons ?? []).filter(
    (reason) => !reason.toLowerCase().includes("causal history limit"),
  );

  return (
    <div className="tasks-shell">
      <header className="tasks-header">
        <div className="tasks-header-left">
          <div className="eyebrow">
            <span className="eyebrow-line" /> TASKS EXTENSION
          </div>
          <div className="tasks-title-row">
            <h2>{selectedProject ? projectDirectory.labelOf(selectedProject.uri) : "Tasks"}</h2>
            <select
              className="tasks-scope-select"
              aria-label="Project scope"
              value={currentProjectSelectValue}
              onChange={(event) => switchProjectScope(event.target.value)}
            >
              <option value="all">All tasks</option>
              <option value="none">No project</option>
              {projectDirectory.allProjects.map((project) => (
                <option key={project.uri} value={project.uri}>
                  {projectDirectory.labelOf(project.uri)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setCreatingProject((open) => !open);
                setCreatingTask(false);
              }}
            >
              + New project
            </button>
          </div>
        </div>

        <div className="tasks-header-actions">
          <nav className="tasks-tabs" role="tablist" aria-label="Tasks views">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "list"}
              className={`tasks-tab ${activeTab === "list" ? "active" : ""}`}
              onClick={openListTab}
            >
              List
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "board"}
              className={`tasks-tab ${activeTab === "board" ? "active" : ""}`}
              onClick={openBoardTab}
            >
              Board
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "activity"}
              className={`tasks-tab ${activeTab === "activity" ? "active" : ""}`}
              onClick={openActivityTab}
            >
              Activity
              {spaceView && spaceView.unseenActivityCount > 0 && (
                <span className="tasks-badge" aria-label={`${spaceView.unseenActivityCount} unseen conflicts`}>
                  {spaceView.unseenActivityCount}
                </span>
              )}
            </button>
          </nav>

          <button
            type="button"
            className="primary-button tasks-new-task-button"
            onClick={() => {
              setNewTaskProject(route.view === "project" ? route.projectUri : "");
              setCreatingTask((open) => !open);
              setCreatingProject(false);
            }}
          >
            + New task
          </button>
          <button
            type="button"
            className="text-button"
            disabled={tasksView.loading || busy}
            onClick={() =>
              void reload({ fresh: true })
                .then(() => setManualSyncSeq((cur) => cur + 1))
                .catch((caught) => setError(messageOf(caught)))
            }
          >
            Sync ↻
          </button>
        </div>
      </header>

      {tasksView.error !== undefined && (
        <p className="form-error" role="alert">
          {messageOf(tasksView.error)}
        </p>
      )}

      {spaceView?.hasUncertainAncestry && (
        <div className="envelope-alert" role="alert">
          <strong>{UNCERTAIN_ANCESTRY_WARNING}</strong>
        </div>
      )}

      {spaceView && (!spaceView.complete || nonUncertainDegradedReasons.length > 0) && (
        <div className="envelope-alert" role="status">
          <strong>Tasks sync notice:</strong>
          {nonUncertainDegradedReasons.length > 0 ? (
            <ul>
              {nonUncertainDegradedReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : (
            <p>Some writer records could not be verified completely; results may be incomplete.</p>
          )}
        </div>
      )}

      {route.view === "project" && !selectedProject && spaceView && (
        <div className="operation-alert" role="alert">
          Project not found in this workspace.
        </div>
      )}

      {selectedProject && (
        <div className="starter-card tasks-project-banner">
          <div className="tasks-project-banner-top">
            <div>
              <strong>{projectDirectory.labelOf(selectedProject.uri)}</strong>
              {selectedProject.description && <p>{selectedProject.description}</p>}
              <small className="mono-note">
                Creator: {shortDid(selectedProject.repo)} · Key: {selectedProject.rkey}
              </small>
            </div>
            <div className="tasks-project-actions">
              <button
                type="button"
                className="text-button"
                disabled={busy || selectedProject.deleted}
                onClick={() => startEditProject(selectedProject)}
              >
                Edit project
              </button>
              {selectedProject.deleted ? (
                <button type="button" className="text-button" disabled={busy} onClick={() => void toggleProjectDelete(selectedProject, false)}>
                  Restore project
                </button>
              ) : (
                <button type="button" className="text-button danger" disabled={busy} onClick={() => void toggleProjectDelete(selectedProject, true)}>
                  Delete project
                </button>
              )}
            </div>
          </div>

          {selectedProject.uncertainAncestry && (
            <p className="form-error" role="alert">
              {UNCERTAIN_ANCESTRY_WARNING}
            </p>
          )}

          {Object.entries(selectedProject.otherVersions).map(([field, versions]) =>
            versions && versions.length > 0 ? (
              <details key={field} className="tasks-versions-disclosure">
                <summary>
                  Concurrent {field} versions ({versions.length})
                </summary>
                <ul className="tasks-versions-list">
                  {versions.map((version) => (
                    <li key={version.opId} className="tasks-version-item">
                      <span>
                        <strong>{version.value ?? "(cleared)"}</strong> <small>by {shortDid(version.repo)}</small>
                      </span>
                      <button
                        type="button"
                        className="text-button"
                        disabled={busy}
                        onClick={() => void restoreProjectVersion(selectedProject, field as ProjectScalarField, version)}
                      >
                        Restore this version
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null,
          )}

          {activeProjectEditor && (
            <form className="inline-form" onSubmit={(event) => void submitEditProject(event, selectedProject)}>
              <label htmlFor="edit-project-name">Project name</label>
              <input
                id="edit-project-name"
                value={activeProjectEditor.draft.name}
                onChange={(event) =>
                  setProjectEditor((cur) =>
                    cur && cur.projectUri === selectedProject.uri
                      ? { ...cur, draft: { ...cur.draft, name: event.target.value } }
                      : cur,
                  )
                }
                required
              />
              <label htmlFor="edit-project-desc">Project description</label>
              <textarea
                id="edit-project-desc"
                rows={2}
                value={activeProjectEditor.draft.description}
                onChange={(event) =>
                  setProjectEditor((cur) =>
                    cur && cur.projectUri === selectedProject.uri
                      ? { ...cur, draft: { ...cur.draft, description: event.target.value } }
                      : cur,
                  )
                }
              />
              <label htmlFor="edit-project-color">Project color</label>
              <input
                id="edit-project-color"
                value={activeProjectEditor.draft.color}
                onChange={(event) =>
                  setProjectEditor((cur) =>
                    cur && cur.projectUri === selectedProject.uri
                      ? { ...cur, draft: { ...cur.draft, color: event.target.value } }
                      : cur,
                  )
                }
              />
              <div className="tasks-form-actions">
                <button type="submit" className="primary-button" disabled={busy}>
                  Save project
                </button>
                <button type="button" className="text-button" onClick={() => setProjectEditor(null)}>
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {creatingProject && (
        <form className="starter-card inline-form" onSubmit={(event) => void submitCreateProject(event)}>
          <h3>Create project</h3>
          <label htmlFor="new-project-name">Project name</label>
          <input
            id="new-project-name"
            aria-label="Project name"
            value={newProjectName}
            onChange={(event) => setNewProjectName(event.target.value)}
            placeholder="Roadmap"
            required
          />
          <label htmlFor="new-project-desc">Project description (optional)</label>
          <textarea
            id="new-project-desc"
            aria-label="Project description"
            rows={2}
            value={newProjectDesc}
            onChange={(event) => setNewProjectDesc(event.target.value)}
          />
          <label htmlFor="new-project-color">Color</label>
          <input
            id="new-project-color"
            aria-label="Project color"
            value={newProjectColor}
            onChange={(event) => setNewProjectColor(event.target.value)}
          />
          <div className="tasks-form-actions">
            <button type="submit" className="primary-button" disabled={busy}>
              Create project
            </button>
            <button type="button" className="text-button" onClick={() => setCreatingProject(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {creatingTask && (
        <form className="starter-card inline-form" onSubmit={(event) => void submitCreateTask(event)}>
          <h3>New task</h3>
          <label htmlFor="new-task-title">Task title</label>
          <input
            id="new-task-title"
            aria-label="Task title"
            value={newTaskTitle}
            onChange={(event) => setNewTaskTitle(event.target.value)}
            placeholder="Write integration spec"
            required
          />
          <label htmlFor="new-task-desc">Description (optional)</label>
          <textarea
            id="new-task-desc"
            aria-label="Task description"
            rows={2}
            value={newTaskDesc}
            onChange={(event) => setNewTaskDesc(event.target.value)}
          />
          <div className="tasks-field-grid">
            <div className="tasks-field">
              <label htmlFor="new-task-status">Status</label>
              <select
                id="new-task-status"
                aria-label="New task status"
                value={newTaskStatus}
                onChange={(event) => setNewTaskStatus(event.target.value as TaskStatus)}
              >
                {TASK_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {STATUS_LABELS[status]}
                  </option>
                ))}
              </select>
            </div>
            <div className="tasks-field">
              <label htmlFor="new-task-priority">Priority</label>
              <select
                id="new-task-priority"
                aria-label="New task priority"
                value={newTaskPriority}
                onChange={(event) => setNewTaskPriority(event.target.value as TaskPriority)}
              >
                {TASK_PRIORITIES.map((priority) => (
                  <option key={priority} value={priority}>
                    {PRIORITY_LABELS[priority]}
                  </option>
                ))}
              </select>
            </div>
            <div className="tasks-field">
              <label htmlFor="new-task-project">Project</label>
              <select
                id="new-task-project"
                aria-label="New task project"
                value={newTaskProject}
                onChange={(event) => setNewTaskProject(event.target.value)}
              >
                <option value="">No project</option>
                {projectDirectory.activeProjects.map((project) => (
                  <option key={project.uri} value={project.uri}>
                    {projectDirectory.labelOf(project.uri)}
                  </option>
                ))}
              </select>
            </div>
            <div className="tasks-field">
              <label htmlFor="new-task-due">Due date</label>
              <input
                id="new-task-due"
                type="date"
                aria-label="New task due date"
                value={newTaskDueDate}
                onChange={(event) => setNewTaskDueDate(event.target.value)}
              />
            </div>
          </div>
          <label htmlFor="new-task-labels">Labels (comma separated)</label>
          <input
            id="new-task-labels"
            aria-label="New task labels"
            value={newTaskLabels}
            onChange={(event) => setNewTaskLabels(event.target.value)}
            placeholder="ui, r11"
          />
          <div className="tasks-form-actions">
            <button type="submit" className="primary-button" disabled={busy}>
              Create task
            </button>
            <button type="button" className="text-button" onClick={() => setCreatingTask(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {loadingInitial ? (
        <p className="status-note" role="status">
          Syncing tasks space…
        </p>
      ) : !spaceView ? null : route.view === "task" ? (
        selectedTask ? (
          <TaskDetailView
            key={selectedTask.uri}
            workspaceUri={workspace.uri}
            viewerDid={did}
            task={selectedTask}
            comments={spaceView.commentsByTask.get(selectedTask.uri) ?? []}
            allTasks={spaceView.tasks}
            projects={projectDirectory}
            rosterMembers={spaceView.rosterMembers}
            tasksApi={engine.tasks}
            manualSyncSeq={manualSyncSeq}
            onBack={() => navigate(tasksRoute(route.authority, route.workspaceSkey, preferredLayout))}
            onMutated={() => reload()}
            onStatus={setStatus}
            onError={setError}
          />
        ) : (
          <div className="starter-card">
            <p className="form-error" role="alert">
              Task not found.
            </p>
            <button
              type="button"
              className="text-button"
              onClick={() => navigate(tasksRoute(route.authority, route.workspaceSkey, preferredLayout))}
            >
              ← Back to tasks
            </button>
          </div>
        )
      ) : route.view === "activity" ? (
        <TasksActivityView
          workspaceUri={workspace.uri}
          activities={spaceView.activities}
          projects={projectDirectory}
          tasks={spaceView.tasks}
          tasksApi={engine.tasks}
          onOpenTask={(task) =>
            navigate(
              tasksTaskRoute({
                authority: route.authority,
                workspaceSkey: route.workspaceSkey,
                repo: task.repo,
                rkey: task.rkey,
              }),
            )
          }
          onOpenProject={(project) =>
            navigate(
              tasksProjectRoute({
                authority: route.authority,
                workspaceSkey: route.workspaceSkey,
                repo: project.repo,
                rkey: project.rkey,
                layout: preferredLayout,
              }),
            )
          }
          onMutated={() => reload()}
          onStatus={setStatus}
          onError={setError}
        />
      ) : (
        <>
          <div className="tasks-filter-bar">
            <input
              type="search"
              aria-label="Filter tasks"
              placeholder="Filter tasks…"
              value={filter.query}
              onChange={(event) => setFilter((cur) => ({ ...cur, query: event.target.value }))}
            />
            <select
              aria-label="Filter by status"
              value={filter.status}
              onChange={(event) => setFilter((cur) => ({ ...cur, status: event.target.value as TaskFilterState["status"] }))}
            >
              <option value="all">All statuses</option>
              {TASK_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {STATUS_LABELS[status]}
                </option>
              ))}
            </select>
            <select
              aria-label="Filter by priority"
              value={filter.priority}
              onChange={(event) => setFilter((cur) => ({ ...cur, priority: event.target.value as TaskFilterState["priority"] }))}
            >
              <option value="all">All priorities</option>
              {TASK_PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {PRIORITY_LABELS[priority]}
                </option>
              ))}
            </select>
            <select
              aria-label="Filter by assignee"
              value={filter.assignee}
              onChange={(event) => setFilter((cur) => ({ ...cur, assignee: event.target.value }))}
            >
              <option value="all">All assignees</option>
              <option value="unassigned">Unassigned</option>
              {assignees.map((memberDid) => (
                <option key={memberDid} value={memberDid}>
                  {shortDid(memberDid)}
                </option>
              ))}
            </select>
            <select
              aria-label="Filter by label"
              value={filter.label}
              onChange={(event) => setFilter((cur) => ({ ...cur, label: event.target.value }))}
            >
              <option value="all">All labels</option>
              {labels.map((label) => (
                <option key={label} value={label}>
                  {label}
                </option>
              ))}
            </select>
            <select
              aria-label="Sort tasks"
              value={sort.key}
              onChange={(event) => setSort((cur) => ({ ...cur, key: event.target.value as TaskSortKey }))}
            >
              <option value="updated">Sort: Updated</option>
              <option value="created">Sort: Created</option>
              <option value="priority">Sort: Priority</option>
              <option value="status">Sort: Status</option>
              <option value="dueDate">Sort: Due date</option>
              <option value="title">Sort: Title</option>
            </select>
            <button
              type="button"
              className="tasks-sort-dir"
              aria-label={`Sort direction: ${sort.dir === "asc" ? "ascending" : "descending"}`}
              onClick={() => setSort((cur) => ({ ...cur, dir: cur.dir === "asc" ? "desc" : "asc" }))}
            >
              {sort.dir === "asc" ? "↑" : "↓"}
            </button>
            <label className="tasks-show-deleted">
              <input
                type="checkbox"
                checked={filter.includeDeleted}
                onChange={(event) => setFilter((cur) => ({ ...cur, includeDeleted: event.target.checked }))}
              />
              Show deleted
            </label>
          </div>

          {activeLayout === "board" ? (
            <TasksBoardView
              tasks={filteredTasks}
              projects={projectDirectory}
              commentsByTask={spaceView.commentsByTask}
              busy={busy}
              onOpenTask={(task) =>
                navigate(
                  tasksTaskRoute({
                    authority: route.authority,
                    workspaceSkey: route.workspaceSkey,
                    repo: task.repo,
                    rkey: task.rkey,
                  }),
                )
              }
              onMoveTask={moveTaskStatus}
            />
          ) : (
            <TasksListView
              tasks={filteredTasks}
              projects={projectDirectory}
              commentsByTask={spaceView.commentsByTask}
              busy={busy}
              onOpenTask={(task) =>
                navigate(
                  tasksTaskRoute({
                    authority: route.authority,
                    workspaceSkey: route.workspaceSkey,
                    repo: task.repo,
                    rkey: task.rkey,
                  }),
                )
              }
              onOpenProject={(projectUri) => switchProjectScope(projectUri)}
              onChangeStatus={moveTaskStatus}
              onRestoreTask={restoreTaskInline}
            />
          )}
        </>
      )}
    </div>
  );
}
