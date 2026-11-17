import { verifyRecordCid } from "@flock/protocol/atproto/space-credential-core";
import { isMissingXrpcResource } from "@flock/protocol/atproto/xrpc";
import {
  advanceHlc,
  filterTaskComments,
  mergeProject,
  mergeTask,
  mergeTasksSpace,
  opId,
  opRef,
  packCausalClosure,
  type ClosureInputOp,
  type FieldVersion,
  type MergedProject,
  type MergedTask,
  type MergedTasksSpace,
  type ProjectEditRecordValue,
  type ProjectRecordValue,
  type ProjectScalarField,
  type StoredEntityRecord,
  type TaskActivityEvent,
  type TaskCommentRecordValue,
  type TaskCommentView,
  type TaskEditRecordValue,
  type TaskPriority,
  type TaskRecordValue,
  type TaskScalarField,
  type TaskStatus,
} from "@flock/protocol/entity-merge";
import { parseSpaceRecordUri, parseWorkspaceUri, spaceRecordUri, tasksSpaceUri } from "@flock/protocol/keys";
import { COLLECTION } from "@flock/protocol/nsids";
import { validateSpaceRecord } from "@flock/protocol/registry";
import { WORKSPACE_ENVELOPE, type WorkspaceExtensionSummary } from "@flock/protocol/workspace-summary";
import type { CredentialCache } from "../../credentials";
import type { Lifecycle } from "../../lifecycle";
import type { ActivityState, StoredRecord } from "../../store";
import type { SetAside, SyncCore, VerifiedSpaceSyncResult, VerifiedWorkspaceSnapshot } from "../../sync";
import { transportNow, type ClientTransport } from "../../transport";
import { WriteQueue } from "../../write-queue";

export const TASKS_COLLECTIONS = [
  COLLECTION.taskProject,
  COLLECTION.taskProjectEdit,
  COLLECTION.task,
  COLLECTION.taskEdit,
  COLLECTION.taskComment,
] as const;

const MAX_LISTED_SET_ASIDE = 20;
const MAX_TRACKED_FORM_CHAINS = 1_000;

export type ObservedEntityContext = {
  readonly entityUri: string;
  readonly formChainId: string;
  readonly baseClosure: readonly string[];
  readonly maxHlc: string;
  readonly baseUncertain: boolean;
};

export type ForeignUpdatePolicy = "preserve-conflict" | "reject-stale";

export type MergedProjectView = MergedProject & {
  readonly observedContext: ObservedEntityContext;
};

export type MergedTaskView = MergedTask & {
  readonly observedContext: ObservedEntityContext;
};

export type TaskDetailView = MergedTaskView & {
  readonly comments: TaskCommentView[];
};

export type TaskActivityItem = TaskActivityEvent & {
  readonly seen: boolean;
  readonly dismissed: boolean;
};

export type TasksReadOptions = {
  truthIntervalMs?: number;
  fresh?: boolean;
  maxStarArchiveBytes?: number;
  maxStarRecords?: number;
  signal?: AbortSignal;
};

export type TasksSpaceView = {
  workspaceUri: string;
  tasksSpaceUri: string;
  enabled: boolean;
  extInstall: WorkspaceExtensionSummary | null;
  workspaceSnapshotComplete: boolean;
  complete: boolean;
  degraded: boolean;
  degradedReasons: string[];
  hasUncertainAncestry: boolean;
  setAside: SetAside[];
  changing: string[];
  rosterMembers: string[];
  writerUniverse: string[];
  projects: MergedProjectView[];
  tasks: MergedTaskView[];
  commentsByTask: Map<string, TaskCommentView[]>;
  activities: TaskActivityItem[];
  unseenActivityCount: number;
  orphanedProjectEdits: number;
  orphanedTaskEdits: number;
  orphanedComments: number;
};

export type TasksActivityResult = {
  enabled: boolean;
  activities: TaskActivityItem[];
  unseenCount: number;
  complete: boolean;
  degraded: boolean;
  degradedReasons: string[];
};

export type CreateProjectInput = {
  name: string;
  description?: string;
  color?: string;
};

export type UpdateProjectInput = {
  context: ObservedEntityContext;
  name?: string;
  description?: string | null;
  clearDescription?: true;
  color?: string;
  onForeignUpdate?: ForeignUpdatePolicy;
};

export type LifecycleEditInput = {
  context: ObservedEntityContext;
  onForeignUpdate?: ForeignUpdatePolicy;
};

export type CreateTaskInput = {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  project?: string;
  dueDate?: string;
  parent?: string;
  assignees?: readonly string[];
  labels?: readonly string[];
};

export type UpdateTaskInput = {
  context: ObservedEntityContext;
  title?: string;
  description?: string | null;
  clearDescription?: true;
  status?: TaskStatus;
  priority?: TaskPriority;
  project?: string | null;
  clearProject?: true;
  dueDate?: string | null;
  clearDueDate?: true;
  parent?: string | null;
  clearParent?: true;
  addAssignees?: readonly string[];
  removeAssignees?: readonly string[];
  addLabels?: readonly string[];
  removeLabels?: readonly string[];
  onForeignUpdate?: ForeignUpdatePolicy;
};

export type AddCommentInput = {
  taskUri: string;
  body: string;
};

export type UpdateCommentInput = {
  commentUri: string;
  body: string;
};

export type RestoreFieldVersionInput =
  | {
      entityKind: "project";
      context: ObservedEntityContext;
      field: ProjectScalarField;
      version: FieldVersion<string | undefined>;
      onForeignUpdate?: ForeignUpdatePolicy;
    }
  | {
      entityKind: "task";
      context: ObservedEntityContext;
      field: TaskScalarField;
      version: FieldVersion<string | undefined>;
      onForeignUpdate?: ForeignUpdatePolicy;
    };

export type ProjectWriteResult = {
  uri: string;
  rkey: string;
  cid: string;
  project: MergedProjectView;
  observedContext: ObservedEntityContext;
};

export type TaskWriteResult = {
  uri: string;
  rkey: string;
  cid: string;
  task: MergedTaskView;
  observedContext: ObservedEntityContext;
};

export type CommentWriteResult = {
  uri: string;
  rkey: string;
  cid: string;
  comment: TaskCommentView;
};

export class TasksExtensionDisabledError extends Error {
  constructor(workspaceUri: string, reason?: string) {
    super(reason ?? `Tasks extension is not enabled for workspace ${workspaceUri}.`);
    this.name = "TasksExtensionDisabledError";
  }
}

export class EntityNotFoundError extends Error {
  constructor(readonly entityKind: "project" | "task" | "comment", readonly entityUri: string) {
    super(`${entityKind} not found: ${entityUri}`);
    this.name = "EntityNotFoundError";
  }
}

export class StaleEntityContextError extends Error {
  constructor(
    readonly entityKind: "project" | "task",
    readonly entityUri: string,
    readonly latestEntity: MergedProjectView | MergedTaskView,
    readonly foreignOpIds: readonly string[],
  ) {
    super("Updated elsewhere — Review & merge");
    this.name = "StaleEntityContextError";
  }
}

export type TasksClientDeps = {
  transport: ClientTransport;
  credentials: CredentialCache;
  sync: SyncCore;
  lifecycle: Lifecycle;
  writeQueue?: WriteQueue;
  applyOwnWrites?: boolean;
};

type ValidatedTasksRecords = {
  projects: StoredEntityRecord<ProjectRecordValue>[];
  projectEdits: StoredEntityRecord<ProjectEditRecordValue>[];
  tasks: StoredEntityRecord<TaskRecordValue>[];
  taskEdits: StoredEntityRecord<TaskEditRecordValue>[];
  comments: StoredEntityRecord<TaskCommentRecordValue>[];
};

type SyncedTasksContext = {
  authorityDid: string;
  workspaceUri: string;
  tasksSpace: string;
  snapshot: VerifiedWorkspaceSnapshot;
  extInstall: WorkspaceExtensionSummary;
  spaceSync: VerifiedSpaceSyncResult;
};

type FormChainEntry = {
  entityUri: string;
  ops: Array<ClosureInputOp & { opRef: string }>;
};

/**
 * First-party Tasks extension client (`D11.3`, `D11.4`, `D11.5`, `D11.7`, `D11.13`).
 * Isolates all Tasks causal merge, closure packing, write serialization, and IDB Activity persistence inside
 * `@flock/client/ext/tasks`.
 */
export class TasksClient {
  private readonly writeQueue: WriteQueue;
  private readonly applyOwnWrites: boolean;
  private readonly ownChainOpsByFormId = new Map<string, FormChainEntry>();
  private readonly inFlightSync = new Map<string, Promise<SyncedTasksContext | { disabled: TasksSpaceView }>>();
  private readonly syncedWorkspaces = new Set<string>();
  private formCounter = 0;

  constructor(private readonly deps: TasksClientDeps) {
    this.writeQueue =
      deps.writeQueue ??
      new WriteQueue({
        store: deps.sync.store,
        now: () => transportNow(deps.transport),
        advanceHlc,
      });
    this.applyOwnWrites = deps.applyOwnWrites ?? true;
  }

  /** Issues a distinct independent `formChainId` over the same `baseClosure` for a separate UI form/tab. */
  forkContext(ctx: ObservedEntityContext): ObservedEntityContext {
    return freezeContext({
      entityUri: ctx.entityUri,
      formChainId: this.nextFormChainId(),
      baseClosure: [...ctx.baseClosure],
      maxHlc: ctx.maxHlc,
      baseUncertain: ctx.baseUncertain,
    });
  }

  async readSpace(workspaceUri: string, options: TasksReadOptions = {}): Promise<TasksSpaceView> {
    const synced = await this.syncSpaceInternal(workspaceUri, options);
    if ("disabled" in synced) {
      return synced.disabled;
    }

    const { authorityDid, tasksSpace, snapshot, extInstall, spaceSync } = synced;
    const validated = collectValidatedRecordsFromByCollection(
      authorityDid,
      tasksSpace,
      spaceSync.byCollection,
    );
    const complete = snapshot.workspaceSnapshotComplete && spaceSync.complete;
    const merged = mergeTasksSpace({ ...validated, complete });
    const hasUncertainAncestry =
      merged.projects.some((project) => project.uncertainAncestry) ||
      merged.tasks.some((task) => task.uncertainAncestry);

    const activityState = await this.deps.sync.store.getActivityState(this.deps.transport.did, tasksSpace);
    const activities = decorateActivities(merged.activities, activityState);
    const unseenActivityCount = activities.filter((item) => !item.seen && !item.dismissed).length;

    const degradedReasons = collectTasksDegradedReasons(
      snapshot,
      spaceSync,
      merged,
      hasUncertainAncestry,
    );

    return {
      workspaceUri,
      tasksSpaceUri: tasksSpace,
      enabled: true,
      extInstall,
      workspaceSnapshotComplete: snapshot.workspaceSnapshotComplete,
      complete,
      degraded: !complete || degradedReasons.length > 0,
      degradedReasons,
      hasUncertainAncestry,
      setAside: [...snapshot.setAside, ...spaceSync.setAside].sort((left, right) => left.did.localeCompare(right.did)),
      changing: [...spaceSync.changing].sort(),
      rosterMembers: [...snapshot.rosterMembers].sort(),
      writerUniverse: spaceSync.writers,
      projects: merged.projects.map((project) => this.attachProjectContext(project)),
      tasks: merged.tasks.map((task) => this.attachTaskContext(task)),
      commentsByTask: merged.commentsByTask,
      activities,
      unseenActivityCount,
      orphanedProjectEdits: merged.orphanedProjectEdits,
      orphanedTaskEdits: merged.orphanedTaskEdits,
      orphanedComments: merged.orphanedComments,
    };
  }

  async getProject(
    workspaceUri: string,
    projectUri: string,
    options: TasksReadOptions = {},
  ): Promise<MergedProjectView | null> {
    const view = await this.readSpace(workspaceUri, options);
    if (!view.enabled) return null;
    return view.projects.find((project) => project.uri === projectUri) ?? null;
  }

  async getTask(
    workspaceUri: string,
    taskUri: string,
    options: TasksReadOptions = {},
  ): Promise<TaskDetailView | null> {
    const view = await this.readSpace(workspaceUri, options);
    if (!view.enabled) return null;
    const task = view.tasks.find((entry) => entry.uri === taskUri);
    if (!task) return null;
    return {
      ...task,
      comments: view.commentsByTask.get(task.uri) ?? [],
    };
  }

  async listActivity(workspaceUri: string, options: TasksReadOptions = {}): Promise<TasksActivityResult> {
    const view = await this.readSpace(workspaceUri, options);
    return {
      enabled: view.enabled,
      activities: view.activities,
      unseenCount: view.unseenActivityCount,
      complete: view.complete,
      degraded: view.degraded,
      degradedReasons: view.degradedReasons,
    };
  }

  async markActivitySeen(workspaceUri: string, eventIds: readonly string[]): Promise<ActivityState> {
    const { tasksSpace } = requireWorkspaceTasksSpace(workspaceUri);
    return this.deps.sync.store.markActivitySeen(
      this.deps.transport.did,
      tasksSpace,
      eventIds,
      transportNow(this.deps.transport),
    );
  }

  async dismissActivity(workspaceUri: string, eventIds: readonly string[]): Promise<ActivityState> {
    const { tasksSpace } = requireWorkspaceTasksSpace(workspaceUri);
    return this.deps.sync.store.dismissActivity(
      this.deps.transport.did,
      tasksSpace,
      eventIds,
      transportNow(this.deps.transport),
    );
  }

  async createProject(workspaceUri: string, input: CreateProjectInput): Promise<ProjectWriteResult> {
    const { authorityDid, tasksSpace } = requireWorkspaceTasksSpace(workspaceUri);
    const synced = await this.ensureSyncedForWrite(workspaceUri);
    const did = this.deps.transport.did;
    await this.deps.credentials.fresh(tasksSpace);

    const createdAt = new Date(transportNow(this.deps.transport)).toISOString();
    const { stamp, record, responseCid } = await this.createSpaceRecordWithRetry({
      tasksSpace,
      authorityDid,
      did,
      collection: COLLECTION.taskProject,
      observedTs: [],
      buildRecord: (hlc) => ({
        $type: COLLECTION.taskProject,
        name: input.name,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        t: hlc,
        createdAt,
      }),
    });

    const cid = await this.verifyOrEmptyCid(COLLECTION.taskProject, stamp.tid, record, responseCid);
    const uri = spaceRecordUri(tasksSpace, did, COLLECTION.taskProject, stamp.tid);
    await this.persistOwnUpsert(workspaceUri, tasksSpace, COLLECTION.taskProject, stamp.tid, uri, cid, record);

    const rootEntry: StoredEntityRecord<ProjectRecordValue> = {
      uri,
      repo: did,
      rkey: stamp.tid,
      value: record as ProjectRecordValue,
    };
    const merged = mergeProject(rootEntry, [], { complete: synced.snapshot.workspaceSnapshotComplete && synced.spaceSync.complete })!;
    const project = this.attachProjectContext(merged);
    return {
      uri,
      rkey: stamp.tid,
      cid,
      project,
      observedContext: project.observedContext,
    };
  }

  async updateProject(workspaceUri: string, input: UpdateProjectInput): Promise<ProjectWriteResult> {
    const mutation: Record<string, unknown> = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
    };
    applyClearableField(mutation, "description", "clearDescription", input.description, input.clearDescription);
    return this.mutateProject(workspaceUri, input.context, mutation, input.onForeignUpdate);
  }

  async deleteProject(workspaceUri: string, input: LifecycleEditInput): Promise<ProjectWriteResult> {
    return this.mutateProject(workspaceUri, input.context, { deleted: true }, input.onForeignUpdate);
  }

  async restoreProject(workspaceUri: string, input: LifecycleEditInput): Promise<ProjectWriteResult> {
    return this.mutateProject(workspaceUri, input.context, { deleted: false }, input.onForeignUpdate);
  }

  async createTask(workspaceUri: string, input: CreateTaskInput): Promise<TaskWriteResult> {
    const { authorityDid, tasksSpace } = requireWorkspaceTasksSpace(workspaceUri);
    const synced = await this.ensureSyncedForWrite(workspaceUri);
    const did = this.deps.transport.did;
    await this.deps.credentials.fresh(tasksSpace);

    const createdAt = new Date(transportNow(this.deps.transport)).toISOString();
    const status: TaskStatus = input.status ?? "todo";
    const priority: TaskPriority = input.priority ?? "none";

    const { stamp, record, responseCid } = await this.createSpaceRecordWithRetry({
      tasksSpace,
      authorityDid,
      did,
      collection: COLLECTION.task,
      observedTs: [],
      buildRecord: (hlc) => ({
        $type: COLLECTION.task,
        title: input.title,
        ...(input.description !== undefined ? { description: input.description } : {}),
        status,
        priority,
        ...(input.project !== undefined ? { project: input.project } : {}),
        ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
        ...(input.parent !== undefined ? { parent: input.parent } : {}),
        ...(input.assignees !== undefined && input.assignees.length > 0 ? { assignees: [...input.assignees] } : {}),
        ...(input.labels !== undefined && input.labels.length > 0 ? { labels: [...input.labels] } : {}),
        t: hlc,
        createdAt,
      }),
    });

    const cid = await this.verifyOrEmptyCid(COLLECTION.task, stamp.tid, record, responseCid);
    const uri = spaceRecordUri(tasksSpace, did, COLLECTION.task, stamp.tid);
    await this.persistOwnUpsert(workspaceUri, tasksSpace, COLLECTION.task, stamp.tid, uri, cid, record);

    const rootEntry: StoredEntityRecord<TaskRecordValue> = {
      uri,
      repo: did,
      rkey: stamp.tid,
      value: record as TaskRecordValue,
    };
    const merged = mergeTask(rootEntry, [], { complete: synced.snapshot.workspaceSnapshotComplete && synced.spaceSync.complete })!;
    const task = this.attachTaskContext(merged);
    return {
      uri,
      rkey: stamp.tid,
      cid,
      task,
      observedContext: task.observedContext,
    };
  }

  async updateTask(workspaceUri: string, input: UpdateTaskInput): Promise<TaskWriteResult> {
    const mutation: Record<string, unknown> = {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.addAssignees !== undefined && input.addAssignees.length > 0 ? { addAssignees: [...input.addAssignees] } : {}),
      ...(input.removeAssignees !== undefined && input.removeAssignees.length > 0
        ? { removeAssignees: [...input.removeAssignees] }
        : {}),
      ...(input.addLabels !== undefined && input.addLabels.length > 0 ? { addLabels: [...input.addLabels] } : {}),
      ...(input.removeLabels !== undefined && input.removeLabels.length > 0 ? { removeLabels: [...input.removeLabels] } : {}),
    };
    applyClearableField(mutation, "description", "clearDescription", input.description, input.clearDescription);
    applyClearableField(mutation, "project", "clearProject", input.project, input.clearProject);
    applyClearableField(mutation, "dueDate", "clearDueDate", input.dueDate, input.clearDueDate);
    applyClearableField(mutation, "parent", "clearParent", input.parent, input.clearParent);
    return this.mutateTask(workspaceUri, input.context, mutation, input.onForeignUpdate);
  }

  async deleteTask(workspaceUri: string, input: LifecycleEditInput): Promise<TaskWriteResult> {
    return this.mutateTask(workspaceUri, input.context, { deleted: true }, input.onForeignUpdate);
  }

  async restoreTask(workspaceUri: string, input: LifecycleEditInput): Promise<TaskWriteResult> {
    return this.mutateTask(workspaceUri, input.context, { deleted: false }, input.onForeignUpdate);
  }

  async restoreFieldVersion(
    workspaceUri: string,
    input: RestoreFieldVersionInput,
  ): Promise<ProjectWriteResult | TaskWriteResult> {
    const value = input.version.value;
    if (input.entityKind === "project") {
      if (input.field === "description") {
        return this.updateProject(workspaceUri, {
          context: input.context,
          ...(value === undefined ? { clearDescription: true } : { description: value }),
          onForeignUpdate: input.onForeignUpdate,
        });
      }
      if (value === undefined) {
        throw new TypeError(
          input.field === "name" ? "Cannot clear required project name." : "Project color cannot be cleared.",
        );
      }
      return this.updateProject(workspaceUri, {
        context: input.context,
        [input.field]: value,
        onForeignUpdate: input.onForeignUpdate,
      });
    }

    if (
      input.field === "description" ||
      input.field === "project" ||
      input.field === "dueDate" ||
      input.field === "parent"
    ) {
      const clearMap = {
        description: "clearDescription",
        project: "clearProject",
        dueDate: "clearDueDate",
        parent: "clearParent",
      } as const;
      return this.updateTask(workspaceUri, {
        context: input.context,
        ...(value === undefined ? { [clearMap[input.field]]: true } : { [input.field]: value }),
        onForeignUpdate: input.onForeignUpdate,
      });
    }
    if (value === undefined) {
      throw new TypeError(`Cannot clear required task ${input.field}.`);
    }
    return this.updateTask(workspaceUri, {
      context: input.context,
      [input.field]: value,
      onForeignUpdate: input.onForeignUpdate,
    });
  }

  async addComment(workspaceUri: string, input: AddCommentInput): Promise<CommentWriteResult> {
    const { authorityDid, tasksSpace } = requireWorkspaceTasksSpace(workspaceUri);
    const target = parseSpaceRecordUri(input.taskUri, tasksSpace, COLLECTION.task);
    if (!target) throw new TypeError("Invalid task URI for comment.");
    const did = this.deps.transport.did;

    return this.writeQueue.withEntityLock(did, input.taskUri, async () => {
      await this.ensureSyncedForWrite(workspaceUri);
      const root = await this.loadValidRoot<TaskRecordValue>(
        authorityDid,
        tasksSpace,
        COLLECTION.task,
        target.repo,
        target.rkey,
      );
      if (!root) throw new EntityNotFoundError("task", input.taskUri);
      const edits = await this.loadValidEdits<TaskEditRecordValue>(
        authorityDid,
        tasksSpace,
        COLLECTION.taskEdit,
        input.taskUri,
      );
      const merged = mergeTask(root, edits)!;
      if (merged.deleted) {
        throw new Error("Cannot comment on a deleted task.");
      }

      await this.deps.credentials.fresh(tasksSpace);
      const createdAt = new Date(transportNow(this.deps.transport)).toISOString();
      const { stamp, record, responseCid } = await this.createSpaceRecordWithRetry({
        tasksSpace,
        authorityDid,
        did,
        collection: COLLECTION.taskComment,
        observedTs: [],
        buildRecord: () => ({
          $type: COLLECTION.taskComment,
          subject: input.taskUri,
          body: input.body,
          createdAt,
        }),
      });

      const cid = await this.verifyOrEmptyCid(COLLECTION.taskComment, stamp.tid, record, responseCid);
      const uri = spaceRecordUri(tasksSpace, did, COLLECTION.taskComment, stamp.tid);
      await this.persistOwnUpsert(workspaceUri, tasksSpace, COLLECTION.taskComment, stamp.tid, uri, cid, record);

      return {
        uri,
        rkey: stamp.tid,
        cid,
        comment: {
          uri,
          repo: did,
          rkey: stamp.tid,
          subject: input.taskUri,
          body: String(record.body),
          createdAt,
        },
      };
    });
  }

  async updateComment(workspaceUri: string, input: UpdateCommentInput): Promise<CommentWriteResult> {
    const { authorityDid, tasksSpace } = requireWorkspaceTasksSpace(workspaceUri);
    const target = parseSpaceRecordUri(input.commentUri, tasksSpace, COLLECTION.taskComment);
    const did = this.deps.transport.did;
    if (!target || target.repo !== did) {
      throw new Error("You can only edit your own comments.");
    }

    return this.writeQueue.withEntityLock(did, input.commentUri, async () => {
      await this.ensureSyncedForWrite(workspaceUri);
      const stored = await this.deps.sync.store.getRecord(tasksSpace, target.repo, COLLECTION.taskComment, target.rkey);
      if (
        !stored ||
        !validateSpaceRecord(COLLECTION.taskComment, stored.value, {
          authorityDid,
          spaceUri: tasksSpace,
          repoDid: target.repo,
          rkey: target.rkey,
        }).valid
      ) {
        throw new EntityNotFoundError("comment", input.commentUri);
      }

      const editedAt = new Date(transportNow(this.deps.transport)).toISOString();
      const record: Record<string, unknown> = {
        ...stored.value,
        $type: COLLECTION.taskComment,
        body: input.body,
        editedAt,
      };
      const validation = validateSpaceRecord(COLLECTION.taskComment, record, {
        authorityDid,
        spaceUri: tasksSpace,
        repoDid: did,
        rkey: target.rkey,
      });
      if (!validation.valid) {
        throw new Error(validation.reason);
      }

      await this.deps.credentials.fresh(tasksSpace);
      let result: { uri: string; cid: string };
      try {
        result = await this.deps.transport.memberClient.procedure<unknown, { uri: string; cid: string }>(
          "com.atproto.space.putRecord",
          { space: tasksSpace, repo: did, collection: COLLECTION.taskComment, rkey: target.rkey, record },
        );
      } catch (error) {
        await this.deps.sync.markStale(tasksSpace, did).catch(() => undefined);
        throw error;
      }

      const cid = await this.verifyOrEmptyCid(COLLECTION.taskComment, target.rkey, record, result.cid);
      await this.persistOwnUpsert(workspaceUri, tasksSpace, COLLECTION.taskComment, target.rkey, input.commentUri, cid, record);

      return {
        uri: input.commentUri,
        rkey: target.rkey,
        cid,
        comment: {
          uri: input.commentUri,
          repo: did,
          rkey: target.rkey,
          subject: String(record.subject),
          body: String(record.body),
          createdAt: String(record.createdAt),
          editedAt,
        },
      };
    });
  }

  async deleteComment(workspaceUri: string, commentUri: string): Promise<void> {
    const { tasksSpace } = requireWorkspaceTasksSpace(workspaceUri);
    const target = parseSpaceRecordUri(commentUri, tasksSpace, COLLECTION.taskComment);
    const did = this.deps.transport.did;
    if (!target || target.repo !== did) {
      throw new Error("You can only delete your own comments.");
    }

    await this.writeQueue.withEntityLock(did, commentUri, async () => {
      await this.deps.credentials.fresh(tasksSpace);
      try {
        await this.deps.transport.memberClient.procedure("com.atproto.space.deleteRecord", {
          space: tasksSpace,
          repo: did,
          collection: COLLECTION.taskComment,
          rkey: target.rkey,
        });
      } catch (error) {
        if (!isMissingXrpcResource(error)) {
          await this.deps.sync.markStale(tasksSpace, did).catch(() => undefined);
          throw error;
        }
      }
      if (this.applyOwnWrites) {
        await this.deps.sync.applyOwnWrite(
          { space: tasksSpace, repo: did },
          { remove: [{ collection: COLLECTION.taskComment, rkey: target.rkey }] },
          { workspace: workspaceUri },
        );
      }
    });
  }

  private async mutateProject(
    workspaceUri: string,
    context: ObservedEntityContext,
    mutation: Record<string, unknown>,
    onForeignUpdate: ForeignUpdatePolicy = "preserve-conflict",
  ): Promise<ProjectWriteResult> {
    const result = await this.mutateEntity<ProjectRecordValue, ProjectEditRecordValue, MergedProject, MergedProjectView>({
      entityKind: "project",
      rootCollection: COLLECTION.taskProject,
      editCollection: COLLECTION.taskProjectEdit,
      mergeEntity: (root, edits, complete) => mergeProject(root, edits, { complete })!,
      withContext: (merged, ctx) => this.attachProjectContext(merged, ctx),
      workspaceUri,
      context,
      mutation,
      onForeignUpdate,
    });
    return {
      uri: result.uri,
      rkey: result.rkey,
      cid: result.cid,
      project: result.entity,
      observedContext: result.observedContext,
    };
  }

  private async mutateTask(
    workspaceUri: string,
    context: ObservedEntityContext,
    mutation: Record<string, unknown>,
    onForeignUpdate: ForeignUpdatePolicy = "preserve-conflict",
  ): Promise<TaskWriteResult> {
    const result = await this.mutateEntity<TaskRecordValue, TaskEditRecordValue, MergedTask, MergedTaskView>({
      entityKind: "task",
      rootCollection: COLLECTION.task,
      editCollection: COLLECTION.taskEdit,
      mergeEntity: (root, edits, complete) => mergeTask(root, edits, { complete })!,
      withContext: (merged, ctx) => this.attachTaskContext(merged, ctx),
      workspaceUri,
      context,
      mutation,
      onForeignUpdate,
    });
    return {
      uri: result.uri,
      rkey: result.rkey,
      cid: result.cid,
      task: result.entity,
      observedContext: result.observedContext,
    };
  }

  private async mutateEntity<
    TRoot extends { t: string },
    TEdit extends { subject: string; t: string; s: readonly string[]; sTruncated?: boolean; deleted?: boolean },
    TMerged extends MergedProject | MergedTask,
    TView extends MergedProjectView | MergedTaskView,
  >(input: {
    entityKind: "project" | "task";
    rootCollection: string;
    editCollection: string;
    mergeEntity: (
      root: StoredEntityRecord<TRoot>,
      edits: readonly StoredEntityRecord<TEdit>[],
      complete: boolean,
    ) => TMerged;
    withContext: (merged: TMerged, ctx?: ObservedEntityContext) => TView;
    workspaceUri: string;
    context: ObservedEntityContext;
    mutation: Record<string, unknown>;
    onForeignUpdate: ForeignUpdatePolicy;
  }): Promise<{
    uri: string;
    rkey: string;
    cid: string;
    entity: TView;
    observedContext: ObservedEntityContext;
  }> {
    const { authorityDid, tasksSpace } = requireWorkspaceTasksSpace(input.workspaceUri);
    const target = parseSpaceRecordUri(input.context.entityUri, tasksSpace, input.rootCollection);
    if (!target) {
      throw new TypeError(`Invalid ${input.entityKind} observedContext for this workspace.`);
    }
    const did = this.deps.transport.did;

    return this.writeQueue.withEntityLock(did, input.context.entityUri, async () => {
      const synced = await this.ensureSyncedForWrite(input.workspaceUri);
      const root = await this.loadValidRoot<TRoot>(
        authorityDid,
        tasksSpace,
        input.rootCollection,
        target.repo,
        target.rkey,
      );
      if (!root) {
        throw new EntityNotFoundError(input.entityKind, input.context.entityUri);
      }
      const validEdits = await this.loadValidEdits<TEdit>(
        authorityDid,
        tasksSpace,
        input.editCollection,
        input.context.entityUri,
      );
      const complete = synced.snapshot.workspaceSnapshotComplete && synced.spaceSync.complete;

      const allLiveOps: Array<ClosureInputOp & { opRef: string }> = [
        {
          opRef: opRef(root.repo, root.rkey),
          repo: root.repo,
          rkey: root.rkey,
          t: root.value.t,
          isRoot: true,
        },
        ...validEdits.map((edit) => ({
          opRef: opRef(edit.repo, edit.rkey),
          repo: edit.repo,
          rkey: edit.rkey,
          t: edit.value.t,
          s: edit.value.s,
          sTruncated: edit.value.sTruncated === true,
          ...(edit.value.deleted !== undefined ? { deleted: edit.value.deleted } : {}),
          isRoot: false,
        })),
      ];

      const { closure, observedTs, nextContextBase } = this.prepareFormCausalClosure({
        entityKind: input.entityKind,
        context: input.context,
        allLiveOps,
        onForeignUpdate: input.onForeignUpdate,
        buildLatestEntity: () => input.withContext(input.mergeEntity(root, validEdits, complete)),
      });

      await this.deps.credentials.fresh(tasksSpace);
      const { stamp, record, responseCid } = await this.createSpaceRecordWithRetry({
        tasksSpace,
        authorityDid,
        did,
        collection: input.editCollection,
        observedTs,
        buildRecord: (hlc) => ({
          $type: input.editCollection,
          subject: input.context.entityUri,
          t: hlc,
          s: closure.s,
          ...(closure.sTruncated ? { sTruncated: true } : {}),
          ...input.mutation,
        }),
      });

      const cid = await this.verifyOrEmptyCid(input.editCollection, stamp.tid, record, responseCid);
      const uri = spaceRecordUri(tasksSpace, did, input.editCollection, stamp.tid);
      await this.persistOwnUpsert(input.workspaceUri, tasksSpace, input.editCollection, stamp.tid, uri, cid, record);

      const newEditEntry: StoredEntityRecord<TEdit> = {
        uri,
        repo: did,
        rkey: stamp.tid,
        value: record as TEdit,
      };
      const newOpRef = opRef(did, stamp.tid);
      this.appendFormChainOp(input.context.formChainId, input.context.entityUri, {
        opRef: newOpRef,
        repo: did,
        rkey: stamp.tid,
        t: stamp.hlc,
        s: closure.s,
        sTruncated: closure.sTruncated,
        ...(typeof record.deleted === "boolean" ? { deleted: record.deleted } : {}),
        isRoot: false,
      });

      const nextContext = freezeContext({
        entityUri: input.context.entityUri,
        formChainId: input.context.formChainId,
        baseClosure: [...new Set([...nextContextBase.allowedRefs, newOpRef])].sort(),
        maxHlc: stamp.hlc > nextContextBase.maxHlc ? stamp.hlc : nextContextBase.maxHlc,
        baseUncertain: nextContextBase.baseUncertain || closure.sTruncated,
      });

      const merged = input.mergeEntity(root, [...validEdits, newEditEntry], complete);
      return {
        uri,
        rkey: stamp.tid,
        cid,
        entity: input.withContext(merged, nextContext),
        observedContext: nextContext,
      };
    });
  }

  /**
   * Enforces D11.5 #2 (`R2-H1`): builds `s` strictly from `context.baseClosure` plus prior writes emitted under the
   * SAME `context.formChainId`. Foreign updates (from remote users or other open `formChainId` forms) are NEVER
   * folded into `s`, preserving overwrite conflicts under `"preserve-conflict"` or throwing `StaleEntityContextError`
   * under `"reject-stale"`.
   */
  private prepareFormCausalClosure(input: {
    entityKind: "project" | "task";
    context: ObservedEntityContext;
    allLiveOps: ReadonlyArray<ClosureInputOp & { opRef: string }>;
    onForeignUpdate: ForeignUpdatePolicy;
    buildLatestEntity: () => MergedProjectView | MergedTaskView;
  }) {
    const chainOps = this.getFormChainOps(input.context.formChainId, input.context.entityUri);
    const allowedRefs = new Set<string>([
      ...input.context.baseClosure,
      ...chainOps.map((op) => op.opRef),
    ]);

    const foreignOpIds: string[] = [];
    for (const op of input.allLiveOps) {
      if (!allowedRefs.has(op.opRef)) {
        foreignOpIds.push(opId(op.repo, op.rkey));
      }
    }

    if (foreignOpIds.length > 0 && input.onForeignUpdate === "reject-stale") {
      throw new StaleEntityContextError(
        input.entityKind,
        input.context.entityUri,
        input.buildLatestEntity(),
        foreignOpIds.sort(),
      );
    }

    const observedOps: ClosureInputOp[] = [];
    const observedRefSet = new Set<string>();
    for (const op of input.allLiveOps) {
      if (allowedRefs.has(op.opRef)) {
        observedOps.push(op);
        observedRefSet.add(op.opRef);
      }
    }
    for (const ownOp of chainOps) {
      if (!observedRefSet.has(ownOp.opRef)) {
        observedOps.push(ownOp);
        observedRefSet.add(ownOp.opRef);
      }
    }

    const inheritedRefs = [...allowedRefs].filter((ref) => !observedRefSet.has(ref));
    const baseUncertain =
      input.context.baseUncertain || chainOps.some((op) => op.sTruncated === true);
    const closure = packCausalClosure({
      observedOps,
      inheritedRefs,
      alreadyTruncated: baseUncertain,
    });

    const observedTs: string[] = [input.context.maxHlc, ...chainOps.map((op) => op.t)];
    let maxHlc = input.context.maxHlc;
    for (const op of chainOps) {
      if (op.t > maxHlc) maxHlc = op.t;
    }

    return {
      closure,
      observedTs,
      nextContextBase: {
        allowedRefs,
        maxHlc,
        baseUncertain,
      },
    };
  }

  private async createSpaceRecordWithRetry(input: {
    tasksSpace: string;
    authorityDid: string;
    did: string;
    collection: string;
    observedTs: readonly string[];
    buildRecord: (hlc: string) => Record<string, unknown>;
  }): Promise<{
    stamp: { tid: string; tidMs: number; clockId: number; hlc: string };
    record: Record<string, unknown>;
    responseCid: string;
  }> {
    let lastRecord: Record<string, unknown> = {};
    try {
      const { stamp, result } = await this.writeQueue.createWithTidRetry({
        accountDid: input.did,
        observedTs: input.observedTs,
        advanceHlc,
        attemptCreate: async (reserved) => {
          const candidate = input.buildRecord(reserved.hlc);
          const validation = validateSpaceRecord(input.collection, candidate, {
            authorityDid: input.authorityDid,
            spaceUri: input.tasksSpace,
            repoDid: input.did,
            rkey: reserved.tid,
          });
          if (!validation.valid) {
            throw new Error(validation.reason);
          }
          lastRecord = candidate;
          return this.deps.transport.memberClient.procedure<unknown, { uri: string; cid: string }>(
            "com.atproto.space.createRecord",
            {
              space: input.tasksSpace,
              repo: input.did,
              collection: input.collection,
              rkey: reserved.tid,
              record: candidate,
            },
          );
        },
      });
      return { stamp, record: lastRecord, responseCid: result.cid };
    } catch (error) {
      await this.deps.sync.markStale(input.tasksSpace, input.did).catch(() => undefined);
      throw error;
    }
  }

  private async ensureSyncedForWrite(workspaceUri: string): Promise<SyncedTasksContext> {
    const synced = await this.syncSpaceInternal(workspaceUri, {}, true);
    if ("disabled" in synced) {
      throw new TasksExtensionDisabledError(workspaceUri, synced.disabled.degradedReasons[0]);
    }
    return synced;
  }

  private async syncSpaceInternal(
    workspaceUri: string,
    options: TasksReadOptions = {},
    forWrite = false,
  ): Promise<SyncedTasksContext | { disabled: TasksSpaceView }> {
    const existing = this.inFlightSync.get(workspaceUri);
    if (existing) {
      if (!options.fresh && options.truthIntervalMs === undefined && (!forWrite || !this.syncedWorkspaces.has(workspaceUri))) {
        return existing;
      }
      await existing.catch(() => undefined);
    }
    const run = this.executeSpaceSync(workspaceUri, options).then((result) => {
      if (!("disabled" in result)) {
        this.syncedWorkspaces.add(workspaceUri);
      }
      return result;
    });
    this.inFlightSync.set(workspaceUri, run);
    try {
      return await run;
    } finally {
      if (this.inFlightSync.get(workspaceUri) === run) {
        this.inFlightSync.delete(workspaceUri);
      }
    }
  }

  private async executeSpaceSync(
    workspaceUri: string,
    options: TasksReadOptions,
  ): Promise<SyncedTasksContext | { disabled: TasksSpaceView }> {
    const { authorityDid, tasksSpace } = requireWorkspaceTasksSpace(workspaceUri);
    const defaultTruthInterval = this.deps.sync.options.truthIntervalMs;

    // When Tasks was not yet known enabled in this store, re-check the workspace authority snapshot immediately so
    // enabling Tasks does not wait out the truth interval. Once enabled, warm reopens honor truthIntervalMs (`D11.13`).
    const cachedExt = await this.deps.sync.store.getRecord(
      workspaceUri,
      authorityDid,
      COLLECTION.extInstall,
      "tasks",
    );
    const cachedEnabled =
      cachedExt?.value.active === true && cachedExt?.value.space === tasksSpace;
    const snapshotTruthInterval =
      options.fresh === true
        ? 0
        : options.truthIntervalMs !== undefined
          ? options.truthIntervalMs
          : cachedEnabled
            ? defaultTruthInterval
            : 0;

    let snapshot = await this.deps.sync.syncVerifiedWorkspaceSnapshot(workspaceUri, {
      truthIntervalMs: snapshotTruthInterval,
      fresh: options.fresh,
      signal: options.signal,
    });

    const buildDisabled = async (currentSnapshot: VerifiedWorkspaceSnapshot) => {
      const currentExtInstall = currentSnapshot.extensions.find((ext) => ext.extId === "tasks") ?? null;
      if (currentSnapshot.workspaceSnapshotComplete) {
        const activeExtensions = currentSnapshot.extensions.filter((ext) => ext.active).map((ext) => ext.space);
        await this.deps.lifecycle.keepWorkspaceSpaces(workspaceUri, { extensions: activeExtensions });
      }
      const complete = currentSnapshot.workspaceSnapshotComplete && currentSnapshot.setAside.length === 0;
      const degradedReasons = [...(currentSnapshot.reason && !currentSnapshot.workspaceSnapshotComplete ? [currentSnapshot.reason] : [])];
      if (currentSnapshot.summary) {
        for (const reason of currentSnapshot.summary.degradedReasons) {
          if (!degradedReasons.includes(reason)) degradedReasons.push(reason);
        }
      }
      return {
        disabled: {
          workspaceUri,
          tasksSpaceUri: tasksSpace,
          enabled: false as const,
          extInstall: currentExtInstall,
          workspaceSnapshotComplete: currentSnapshot.workspaceSnapshotComplete,
          complete,
          degraded: !complete || degradedReasons.length > 0,
          degradedReasons,
          hasUncertainAncestry: false,
          setAside: currentSnapshot.setAside,
          changing: [],
          rosterMembers: [...currentSnapshot.rosterMembers].sort(),
          writerUniverse: [],
          projects: [],
          tasks: [],
          commentsByTask: new Map(),
          activities: [],
          unseenActivityCount: 0,
          orphanedProjectEdits: 0,
          orphanedTaskEdits: 0,
          orphanedComments: 0,
        },
      };
    };

    let extInstall = snapshot.extensions.find((ext) => ext.extId === "tasks") ?? null;
    if (!(extInstall !== null && extInstall.active === true && extInstall.space === tasksSpace)) {
      return buildDisabled(snapshot);
    }

    const prevSpaceState = await this.deps.sync.store.getSpace(tasksSpace);
    const prevListedSet = new Set(prevSpaceState?.writers.map((writer) => writer.did) ?? []);
    const spaceSyncTruthInterval = options.fresh ? 0 : (options.truthIntervalMs ?? defaultTruthInterval);
    let spaceSync = await this.deps.sync.syncVerifiedSpace({
      space: tasksSpace,
      collections: TASKS_COLLECTIONS,
      verifiedRosterMembers: snapshot.rosterMembers,
      workspaceSnapshotComplete: snapshot.workspaceSnapshotComplete,
      includeAuthority: false,
      workspace: workspaceUri,
      truthIntervalMs: spaceSyncTruthInterval,
      fullWriterScan: true,
      maxStarBytes: options.maxStarArchiveBytes,
      maxStarRecords: options.maxStarRecords,
      signal: options.signal,
    });

    if (snapshotTruthInterval !== 0) {
      const listedSet = new Set(spaceSync.listedWriters);
      const rosterSet = new Set(snapshot.rosterMembers);
      const writerDisappeared = [...prevListedSet].some((did) => !listedSet.has(did));
      const unexpectedWriter = spaceSync.listedWriters.some(
        (did) => !rosterSet.has(did) && (did !== authorityDid || !prevListedSet.has(did)),
      );
      if (writerDisappeared || unexpectedWriter) {
        snapshot = await this.deps.sync.syncVerifiedWorkspaceSnapshot(workspaceUri, {
          truthIntervalMs: 0,
          signal: options.signal,
        });
        extInstall = snapshot.extensions.find((ext) => ext.extId === "tasks") ?? null;
        if (!(extInstall !== null && extInstall.active === true && extInstall.space === tasksSpace)) {
          return buildDisabled(snapshot);
        }
        spaceSync = await this.deps.sync.syncVerifiedSpace({
          space: tasksSpace,
          collections: TASKS_COLLECTIONS,
          verifiedRosterMembers: snapshot.rosterMembers,
          workspaceSnapshotComplete: snapshot.workspaceSnapshotComplete,
          includeAuthority: false,
          workspace: workspaceUri,
          truthIntervalMs: spaceSyncTruthInterval,
          fullWriterScan: true,
          maxStarBytes: options.maxStarArchiveBytes,
          maxStarRecords: options.maxStarRecords,
          signal: options.signal,
        });
      }
    }

    await this.reconcileOwnClockFromSync(spaceSync);

    return {
      authorityDid,
      workspaceUri,
      tasksSpace,
      snapshot,
      extInstall: extInstall!,
      spaceSync,
    };
  }

  private async reconcileOwnClockFromSync(spaceSync: VerifiedSpaceSyncResult): Promise<void> {
    const did = this.deps.transport.did;
    const ownEntries: Array<{ rkey?: string; hlc?: string }> = [];
    for (const collection of TASKS_COLLECTIONS) {
      for (const record of spaceSync.byCollection[collection] ?? []) {
        if (record.repo !== did) continue;
        ownEntries.push({
          rkey: record.rkey,
          ...(typeof record.value.t === "string" ? { hlc: record.value.t } : {}),
        });
      }
    }
    if (ownEntries.length > 0) {
      await this.writeQueue.observeOwnHistory(did, ownEntries);
    }
  }

  private async loadValidRoot<V>(
    authorityDid: string,
    tasksSpace: string,
    collection: string,
    repo: string,
    rkey: string,
  ): Promise<StoredEntityRecord<V> | null> {
    const record = await this.deps.sync.store.getRecord(tasksSpace, repo, collection, rkey);
    if (!record) return null;
    const validation = validateSpaceRecord(collection, record.value, {
      authorityDid,
      spaceUri: tasksSpace,
      repoDid: repo,
      rkey,
    });
    if (!validation.valid) return null;
    return { uri: record.uri, repo: record.repo, rkey: record.rkey, value: record.value as V };
  }

  private async loadValidEdits<V extends { subject: string }>(
    authorityDid: string,
    tasksSpace: string,
    collection: string,
    subjectUri: string,
  ): Promise<StoredEntityRecord<V>[]> {
    const records = await this.deps.sync.store.records(tasksSpace, collection);
    const valid: StoredEntityRecord<V>[] = [];
    for (const record of records) {
      if (record.value.subject !== subjectUri) continue;
      const check = validateSpaceRecord(collection, record.value, {
        authorityDid,
        spaceUri: tasksSpace,
        repoDid: record.repo,
        rkey: record.rkey,
      });
      if (!check.valid) continue;
      valid.push({ uri: record.uri, repo: record.repo, rkey: record.rkey, value: record.value as V });
    }
    return valid;
  }

  private async verifyOrEmptyCid(
    collection: string,
    rkey: string,
    record: Record<string, unknown>,
    responseCid: string | undefined,
  ): Promise<string> {
    if (typeof responseCid === "string" && responseCid.length > 0) {
      if (await verifyRecordCid(collection, rkey, record, responseCid)) {
        return responseCid;
      }
    }
    return "";
  }

  private async persistOwnUpsert(
    workspaceUri: string,
    tasksSpace: string,
    collection: string,
    rkey: string,
    uri: string,
    cid: string,
    value: Record<string, unknown>,
  ): Promise<void> {
    if (!this.applyOwnWrites) return;
    await this.deps.sync.applyOwnWrite(
      { space: tasksSpace, repo: this.deps.transport.did },
      {
        upsert: [
          {
            space: tasksSpace,
            repo: this.deps.transport.did,
            collection,
            rkey,
            uri,
            cid,
            value,
          },
        ],
      },
      { workspace: workspaceUri },
    );
  }

  private attachProjectContext(project: MergedProject, ctx?: ObservedEntityContext): MergedProjectView {
    return {
      ...project,
      observedContext:
        ctx ??
        freezeContext({
          entityUri: project.uri,
          formChainId: this.nextFormChainId(),
          baseClosure: [...project.closureRefs],
          maxHlc: project.maxHlc,
          baseUncertain: project.uncertainAncestry,
        }),
    };
  }

  private attachTaskContext(task: MergedTask, ctx?: ObservedEntityContext): MergedTaskView {
    return {
      ...task,
      observedContext:
        ctx ??
        freezeContext({
          entityUri: task.uri,
          formChainId: this.nextFormChainId(),
          baseClosure: [...task.closureRefs],
          maxHlc: task.maxHlc,
          baseUncertain: task.uncertainAncestry,
        }),
    };
  }

  private getFormChainOps(
    formChainId: string,
    entityUri: string,
  ): ReadonlyArray<ClosureInputOp & { opRef: string }> {
    const entry = this.ownChainOpsByFormId.get(formChainId);
    if (!entry || entry.entityUri !== entityUri) return [];
    return entry.ops;
  }

  private appendFormChainOp(
    formChainId: string,
    entityUri: string,
    op: ClosureInputOp & { opRef: string },
  ): void {
    let entry = this.ownChainOpsByFormId.get(formChainId);
    if (!entry || entry.entityUri !== entityUri) {
      entry = { entityUri, ops: [] };
    } else {
      this.ownChainOpsByFormId.delete(formChainId);
    }
    entry.ops.push(op);
    this.ownChainOpsByFormId.set(formChainId, entry);
    while (this.ownChainOpsByFormId.size > MAX_TRACKED_FORM_CHAINS) {
      const oldestKey = this.ownChainOpsByFormId.keys().next().value;
      if (oldestKey === undefined) break;
      this.ownChainOpsByFormId.delete(oldestKey);
    }
  }

  private nextFormChainId(): string {
    this.formCounter += 1;
    return `tasks-form-${this.formCounter}`;
  }
}

export { filterTaskComments };

function requireWorkspaceTasksSpace(workspaceUri: string): {
  authorityDid: string;
  workspaceSkey: string;
  tasksSpace: string;
} {
  const parsed = parseWorkspaceUri(workspaceUri);
  if (!parsed) throw new Error("Invalid workspace URI.");
  return {
    authorityDid: parsed.authorityDid,
    workspaceSkey: parsed.skey,
    tasksSpace: tasksSpaceUri(parsed.authorityDid, parsed.skey),
  };
}

function freezeContext(ctx: ObservedEntityContext): ObservedEntityContext {
  return Object.freeze({
    entityUri: ctx.entityUri,
    formChainId: ctx.formChainId,
    baseClosure: Object.freeze([...ctx.baseClosure]),
    maxHlc: ctx.maxHlc,
    baseUncertain: ctx.baseUncertain,
  });
}

function applyClearableField(
  mutation: Record<string, unknown>,
  valueKey: string,
  clearKey: string,
  value: string | null | undefined,
  clearFlag: true | undefined,
): void {
  if (value !== undefined && value !== null && clearFlag === true) {
    throw new Error(`Cannot set both ${valueKey} and ${clearKey}.`);
  }
  if (clearFlag === true || value === null) {
    mutation[clearKey] = true;
    return;
  }
  if (value !== undefined) {
    mutation[valueKey] = value;
  }
}

function collectValidatedRecordsFromByCollection(
  authorityDid: string,
  tasksSpace: string,
  byCollection: Record<string, StoredRecord[]>,
): ValidatedTasksRecords {
  const validOf = <T>(collection: string): StoredEntityRecord<T>[] => {
    const valid: StoredEntityRecord<T>[] = [];
    for (const record of byCollection[collection] ?? []) {
      const check = validateSpaceRecord(collection, record.value, {
        authorityDid,
        spaceUri: tasksSpace,
        repoDid: record.repo,
        rkey: record.rkey,
      });
      if (!check.valid) continue;
      valid.push({
        uri: record.uri,
        repo: record.repo,
        rkey: record.rkey,
        value: record.value as T,
      });
    }
    return valid;
  };

  return {
    projects: validOf<ProjectRecordValue>(COLLECTION.taskProject),
    projectEdits: validOf<ProjectEditRecordValue>(COLLECTION.taskProjectEdit),
    tasks: validOf<TaskRecordValue>(COLLECTION.task),
    taskEdits: validOf<TaskEditRecordValue>(COLLECTION.taskEdit),
    comments: validOf<TaskCommentRecordValue>(COLLECTION.taskComment),
  };
}

function decorateActivities(
  events: readonly TaskActivityEvent[],
  state: ActivityState | undefined,
): TaskActivityItem[] {
  const seenSet = new Set(state?.seenIds ?? []);
  const dismissedSet = new Set(state?.dismissedIds ?? []);
  return events.map((event) => ({
    ...event,
    seen: seenSet.has(event.id),
    dismissed: dismissedSet.has(event.id),
  }));
}

function collectTasksDegradedReasons(
  snapshot: VerifiedWorkspaceSnapshot,
  spaceSync: VerifiedSpaceSyncResult,
  merged: MergedTasksSpace,
  hasUncertainAncestry: boolean,
): string[] {
  const reasons: string[] = [];
  if (!snapshot.workspaceSnapshotComplete && snapshot.reason) {
    reasons.push(snapshot.reason);
  }
  if (snapshot.summary) {
    for (const reason of snapshot.summary.degradedReasons) {
      if (!reasons.includes(reason)) reasons.push(reason);
    }
  }
  for (const entry of spaceSync.setAside.slice(0, MAX_LISTED_SET_ASIDE)) {
    reasons.push(`Task records from ${entry.did} may be missing or out of date: ${entry.reason}`);
  }
  if (spaceSync.setAside.length > MAX_LISTED_SET_ASIDE) {
    reasons.push(
      `${spaceSync.setAside.length - MAX_LISTED_SET_ASIDE} more writers' task records may be missing or out of date.`,
    );
  }
  for (const did of spaceSync.changing) {
    reasons.push(`Task records from ${did} kept changing during verification and may be out of date.`);
  }
  if (hasUncertainAncestry) {
    reasons.push("Task causal history limit reached — archive or split into a fresh task.");
  }
  if ((merged.overloadedHistoryEntities ?? 0) > 0) {
    reasons.push(
      `${merged.overloadedHistoryEntities} entity(s) exceed the ${WORKSPACE_ENVELOPE.maxOpsPerEntity}-op causal history envelope.`,
    );
  }

  const activeProjectsCount = merged.projects.filter((project) => !project.deleted).length;
  const activeTasksCount = merged.tasks.filter((task) => !task.deleted).length;
  if (activeProjectsCount > WORKSPACE_ENVELOPE.taskProjects) {
    reasons.push(
      `Active task projects (${activeProjectsCount}) exceed the ${WORKSPACE_ENVELOPE.taskProjects}-project envelope.`,
    );
  }
  if (activeTasksCount > WORKSPACE_ENVELOPE.tasks) {
    reasons.push(`Active tasks (${activeTasksCount}) exceed the ${WORKSPACE_ENVELOPE.tasks}-task envelope.`);
  }
  let overloadedCommentTasks = 0;
  for (const comments of merged.commentsByTask.values()) {
    if (comments.length > WORKSPACE_ENVELOPE.maxCommentsPerTask) {
      overloadedCommentTasks += 1;
    }
  }
  if (overloadedCommentTasks > 0) {
    reasons.push(
      `${overloadedCommentTasks} task(s) exceed the ${WORKSPACE_ENVELOPE.maxCommentsPerTask}-comment per-task envelope.`,
    );
  }
  return reasons;
}
