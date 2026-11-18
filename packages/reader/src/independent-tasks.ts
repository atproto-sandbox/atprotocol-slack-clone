import { fromBase64 } from "@atproto/lex-data";
import { jsonToLex } from "@atproto/lexicon";
import { RepoCommit, RepoVerificationError, StarParseError, type Commit } from "@atproto/space";
import { listBoundedRepos } from "@flock/protocol/atproto/record-pages";
import { classifyVerifiedRepoFailure, MAX_LISTED_SET_ASIDE } from "@flock/protocol/atproto/repo-failure";
import {
  listVerifiedBoundedRecords,
  mintSpaceCredentialWith,
  RepoStarLimitError,
  SpaceCredentialError,
  starHeaderBytes,
  type SpaceCredential,
  type SpaceCredentialDeps,
} from "@flock/protocol/atproto/space-credential-core";
import { XrpcError } from "@flock/protocol/atproto/xrpc";
import {
  mergeTasksSpace,
  type MergedProject,
  type MergedTask,
  type MergedTasksSpace,
  type ProjectEditRecordValue,
  type ProjectRecordValue,
  type StoredEntityRecord,
  type TaskActivityEvent,
  type TaskCommentRecordValue,
  type TaskCommentView,
  type TaskEditRecordValue,
  type TaskRecordValue,
} from "@flock/protocol/entity-merge";
import { type ExtensionId } from "@flock/protocol/extensions";
import { parseWorkspaceUri, spaceRecordUri, tasksSpaceUri } from "@flock/protocol/keys";
import { mapLimited } from "@flock/protocol/map-limited";
import { COLLECTION } from "@flock/protocol/nsids";
import { validateSpaceRecord } from "@flock/protocol/registry";
import { WORKSPACE_ENVELOPE, type WorkspaceExtensionSummary } from "@flock/protocol/workspace-summary";

const MAX_TASKS_WRITERS = WORKSPACE_ENVELOPE.maxStarRecords;
const WRITER_READ_CONCURRENCY = 6;
const MAX_REPORTED_INVALID_RECORDS = 20;

export type IndependentDeps = SpaceCredentialDeps;

export type IndependentTasksSetAside = {
  did: string;
  reason: string;
  permanent: boolean;
};

export type IndependentTasksReadOptions = {
  /** Optional tighter cap for tests; clamped above by WORKSPACE_ENVELOPE.maxStarArchiveBytes. */
  maxStarArchiveBytes?: number;
  /** Optional tighter cap for tests; clamped above by WORKSPACE_ENVELOPE.maxStarRecords. */
  maxStarRecords?: number;
};

export type IndependentTasksWorkspaceSnapshot = {
  workspaceUri: string;
  authorityDid: string;
  workspaceSkey: string;
  tasksSpaceUri: string;
  enabled: boolean;
  extInstall: WorkspaceExtensionSummary | null;
  rosterMembers: string[];
  workspaceSnapshotComplete: boolean;
  degradedReasons: string[];
  setAside: IndependentTasksSetAside[];
};

export type IndependentTasksReadResult = {
  workspaceUri: string;
  tasksSpaceUri: string;
  enabled: boolean;
  extInstall: WorkspaceExtensionSummary | null;
  workspaceSnapshotComplete: boolean;
  complete: boolean;
  degraded: boolean;
  degradedReasons: string[];
  hasUncertainAncestry: boolean;
  setAside: IndependentTasksSetAside[];
  rosterMembers: string[];
  writerUniverse: string[];
  projects: MergedProject[];
  tasks: MergedTask[];
  commentsByTask: Map<string, TaskCommentView[]>;
  activities: TaskActivityEvent[];
  orphanedProjectEdits: number;
  orphanedTaskEdits: number;
  orphanedComments: number;
};

type VerifiedRecordEntry = {
  collection: string;
  rkey: string;
  cid: string;
  record: Record<string, unknown>;
};

type ValidatedTasksRecords = {
  projects: StoredEntityRecord<ProjectRecordValue>[];
  projectEdits: StoredEntityRecord<ProjectEditRecordValue>[];
  tasks: StoredEntityRecord<TaskRecordValue>[];
  taskEdits: StoredEntityRecord<TaskEditRecordValue>[];
  comments: StoredEntityRecord<TaskCommentRecordValue>[];
};

/**
 * Stateless verified cold reader for a workspace's Tasks extension space (`D11.1`, `D11.3`, `D11.4`, `D11.11`, `D11.13`).
 * Verifies the authority's `workspace` space snapshot and every writer's Tasks extension repo (`SPACE_TYPE.tasks`) via STAR/MAC
 * (or bounded full-repo `listRecords` + MAC-verified `getLatestCommit` + `verifyRecordCid` when `getRepo` is unsupported),
 * then runs pure `@flock/protocol/entity-merge`. Never imports `@flock/client` or touches any local cache.
 */
export async function readIndependentTasksSpace(
  deps: IndependentDeps,
  workspaceUri: string,
  options: IndependentTasksReadOptions = {},
): Promise<IndependentTasksReadResult> {
  const maxBytes = clampBound(options.maxStarArchiveBytes, WORKSPACE_ENVELOPE.maxStarArchiveBytes, 1);
  const maxRecords = clampBound(options.maxStarRecords, WORKSPACE_ENVELOPE.maxStarRecords, 0);

  const snapshot = await readIndependentTasksWorkspaceSnapshot(deps, workspaceUri);
  if (!snapshot.enabled) {
    return buildDisabledTasksResult(snapshot);
  }

  const tasksSpace = snapshot.tasksSpaceUri;
  const tasksCredential = await mintSpaceCredentialWith(deps, tasksSpace);
  const authorityPds = await resolveVerifiedPds(deps, snapshot.authorityDid);
  const repoScan = await listBoundedRepos(tasksCredential.client(authorityPds), {
    space: tasksSpace,
    maxRepos: MAX_TASKS_WRITERS,
  });
  if (repoScan.truncated) {
    throw new Error(`Tasks writer count exceeds the ${MAX_TASKS_WRITERS}-writer scan limit.`);
  }

  const listedRepos = new Set(repoScan.repos.map((repo) => repo.did));
  const writerUniverseSet = new Set<string>([...listedRepos, ...snapshot.rosterMembers]);
  if (listedRepos.has(snapshot.authorityDid)) {
    writerUniverseSet.add(snapshot.authorityDid);
  }
  const writerUniverse = [...writerUniverseSet].sort();

  const { perWriterRecords, writerSetAside } = await readTasksWriters(deps, tasksCredential, {
    tasksSpace,
    writerUniverse,
    listedRepos,
    maxBytes,
    maxRecords,
  });

  const allSetAside = [...snapshot.setAside, ...writerSetAside].sort((left, right) => left.did.localeCompare(right.did));
  const validated = collectValidatedTasksRecords(snapshot.authorityDid, tasksSpace, writerUniverse, perWriterRecords);

  const complete = snapshot.workspaceSnapshotComplete && allSetAside.length === 0;
  const merged = mergeTasksSpace({ ...validated, complete });
  const hasUncertainAncestry =
    merged.projects.some((project) => project.uncertainAncestry) ||
    merged.tasks.some((task) => task.uncertainAncestry);
  const degradedReasons = collectTasksDegradedReasons(snapshot, writerSetAside, merged, hasUncertainAncestry);

  return {
    workspaceUri: snapshot.workspaceUri,
    tasksSpaceUri: tasksSpace,
    enabled: true,
    extInstall: snapshot.extInstall,
    workspaceSnapshotComplete: snapshot.workspaceSnapshotComplete,
    complete,
    degraded: !complete || degradedReasons.length > 0,
    degradedReasons,
    hasUncertainAncestry,
    setAside: allSetAside,
    rosterMembers: snapshot.rosterMembers,
    writerUniverse,
    projects: merged.projects,
    tasks: merged.tasks,
    commentsByTask: merged.commentsByTask,
    activities: merged.activities,
    orphanedProjectEdits: merged.orphanedProjectEdits,
    orphanedTaskEdits: merged.orphanedTaskEdits,
    orphanedComments: merged.orphanedComments,
  };
}

/**
 * Verifies the workspace authority's `SPACE_TYPE.workspace` repo end-to-end and derives the active roster,
 * `tasks` `ext.install` status, and `workspaceSnapshotComplete` (`D11.3 #4`).
 */
export async function readIndependentTasksWorkspaceSnapshot(
  deps: IndependentDeps,
  workspaceUri: string,
  options: IndependentTasksReadOptions = {},
): Promise<IndependentTasksWorkspaceSnapshot> {
  const parsedWorkspace = parseWorkspaceUri(workspaceUri);
  if (!parsedWorkspace) {
    throw new Error("Invalid workspace URI.");
  }
  const { authorityDid, skey: workspaceSkey } = parsedWorkspace;
  const expectedTasksSpace = tasksSpaceUri(authorityDid, workspaceSkey);
  const maxBytes = clampBound(options.maxStarArchiveBytes, WORKSPACE_ENVELOPE.maxStarArchiveBytes, 1);
  const maxRecords = clampBound(options.maxStarRecords, WORKSPACE_ENVELOPE.maxStarRecords, 0);

  const wsCredential = await mintSpaceCredentialWith(deps, workspaceUri);

  let authorityRecords: VerifiedRecordEntry[];
  try {
    const authorityPds = await resolveVerifiedPds(deps, authorityDid);
    authorityRecords = await readVerifiedRepo(wsCredential, authorityPds, {
      space: workspaceUri,
      repo: authorityDid,
      maxBytes,
      maxRecords,
      maxRetries: WORKSPACE_ENVELOPE.maxListRecordsRetry,
    });
  } catch (error) {
    if (error instanceof SpaceCredentialError) throw error;
    const failure = classifyVerifiedRepoFailure(error);
    if (!failure) throw error;
    return {
      workspaceUri,
      authorityDid,
      workspaceSkey,
      tasksSpaceUri: expectedTasksSpace,
      enabled: false,
      extInstall: null,
      rosterMembers: [],
      workspaceSnapshotComplete: false,
      degradedReasons: [`Workspace snapshot from ${authorityDid} could not be verified: ${failure.reason}`],
      setAside: [{ did: authorityDid, reason: failure.reason, permanent: failure.permanent }],
    };
  }

  return summarizeVerifiedWorkspaceRecords({
    workspaceUri,
    authorityDid,
    workspaceSkey,
    expectedTasksSpace,
    authorityRecords,
  });
}

function buildDisabledTasksResult(snapshot: IndependentTasksWorkspaceSnapshot): IndependentTasksReadResult {
  const complete = snapshot.workspaceSnapshotComplete && snapshot.setAside.length === 0;
  const degradedReasons = [...snapshot.degradedReasons];
  return {
    workspaceUri: snapshot.workspaceUri,
    tasksSpaceUri: snapshot.tasksSpaceUri,
    enabled: false,
    extInstall: snapshot.extInstall,
    workspaceSnapshotComplete: snapshot.workspaceSnapshotComplete,
    complete,
    degraded: !complete || degradedReasons.length > 0,
    degradedReasons,
    hasUncertainAncestry: false,
    setAside: snapshot.setAside,
    rosterMembers: snapshot.rosterMembers,
    writerUniverse: [],
    projects: [],
    tasks: [],
    commentsByTask: new Map(),
    activities: [],
    orphanedProjectEdits: 0,
    orphanedTaskEdits: 0,
    orphanedComments: 0,
  };
}

function summarizeVerifiedWorkspaceRecords(input: {
  workspaceUri: string;
  authorityDid: string;
  workspaceSkey: string;
  expectedTasksSpace: string;
  authorityRecords: readonly VerifiedRecordEntry[];
}): IndependentTasksWorkspaceSnapshot {
  const { workspaceUri, authorityDid, workspaceSkey, expectedTasksSpace, authorityRecords } = input;
  const degradedReasons: string[] = [];
  let workspaceSnapshotComplete = true;
  let invalidRecordCount = 0;

  const collectionCounts = new Map<string, number>();
  let validProfileCount = 0;
  const activeRosterMembers = new Set<string>();
  const activeAdmins = new Set<string>();
  const activeChannels = new Set<string>();
  const activeAppInstalls = new Set<string>();
  const activeExtensions = new Set<string>();
  let tasksExtInstall: WorkspaceExtensionSummary | null = null;

  for (const entry of authorityRecords) {
    collectionCounts.set(entry.collection, (collectionCounts.get(entry.collection) ?? 0) + 1);
    const validation = validateSpaceRecord(entry.collection, entry.record, {
      authorityDid,
      spaceUri: workspaceUri,
      repoDid: authorityDid,
      rkey: entry.rkey,
    });
    if (!validation.valid) {
      workspaceSnapshotComplete = false;
      invalidRecordCount += 1;
      if (invalidRecordCount <= MAX_REPORTED_INVALID_RECORDS) {
        degradedReasons.push(`Workspace snapshot contains an invalid ${entry.collection} record (${entry.rkey}): ${validation.reason}`);
      }
      continue;
    }

    switch (entry.collection) {
      case COLLECTION.workspaceProfile:
        validProfileCount += 1;
        break;
      case COLLECTION.workspaceRoster:
        if (entry.record.active === true && typeof entry.record.subject === "string") {
          activeRosterMembers.add(entry.record.subject);
        }
        break;
      case COLLECTION.admin:
        if (entry.record.active === true && typeof entry.record.subject === "string") {
          activeAdmins.add(entry.record.subject);
        }
        break;
      case COLLECTION.directory:
        if (entry.record.visibility !== "archived" && typeof entry.record.skey === "string") {
          activeChannels.add(entry.record.skey);
        }
        break;
      case COLLECTION.appInstall:
        if (entry.record.active === true && typeof entry.record.subject === "string") {
          activeAppInstalls.add(entry.record.subject);
        }
        break;
      case COLLECTION.extInstall: {
        const extSummary: WorkspaceExtensionSummary = {
          extId: entry.record.extId as ExtensionId,
          active: entry.record.active === true,
          space: String(entry.record.space),
          cleanupComplete: entry.record.cleanupComplete === true,
          enabledBy: String(entry.record.enabledBy),
          enabledAt: String(entry.record.enabledAt),
          updatedAt: String(entry.record.updatedAt),
          ...(typeof entry.record.disabledAt === "string" ? { disabledAt: entry.record.disabledAt } : {}),
        };
        if (extSummary.active) {
          activeExtensions.add(extSummary.extId);
        }
        if (entry.rkey === "tasks" && extSummary.extId === "tasks") {
          if (extSummary.space !== expectedTasksSpace) {
            workspaceSnapshotComplete = false;
            degradedReasons.push("Tasks ext.install space URI does not match canonical workspace tasks space.");
          } else {
            tasksExtInstall = extSummary;
          }
        }
        break;
      }
      default:
        break;
    }
  }

  if (invalidRecordCount > MAX_REPORTED_INVALID_RECORDS) {
    degradedReasons.push(`Workspace snapshot contains ${invalidRecordCount - MAX_REPORTED_INVALID_RECORDS} additional invalid authority records.`);
  }
  if (validProfileCount === 0) {
    workspaceSnapshotComplete = false;
    degradedReasons.push("Workspace profile record is missing or invalid.");
  }
  if ((collectionCounts.get(COLLECTION.workspaceProfile) ?? 0) > 1) {
    workspaceSnapshotComplete = false;
    degradedReasons.push("Workspace profile records exceed the expected single-record limit.");
  }
  for (const [collection, count] of collectionCounts.entries()) {
    if (collection !== COLLECTION.workspaceProfile && count > WORKSPACE_ENVELOPE.authorityRecordScan) {
      workspaceSnapshotComplete = false;
      degradedReasons.push(`Workspace ${collection} records exceed the ${WORKSPACE_ENVELOPE.authorityRecordScan}-record scan limit.`);
    }
  }

  const envelopeCaps: Array<[number, number, string]> = [
    [activeRosterMembers.size, WORKSPACE_ENVELOPE.members, `The active workspace roster exceeds ${WORKSPACE_ENVELOPE.members} members.`],
    [activeChannels.size, WORKSPACE_ENVELOPE.channels, `The active channel count exceeds ${WORKSPACE_ENVELOPE.channels} channels.`],
    [activeAdmins.size, WORKSPACE_ENVELOPE.members, `The active admin count exceeds ${WORKSPACE_ENVELOPE.members} members.`],
    [activeAppInstalls.size, WORKSPACE_ENVELOPE.apps, `The active app count exceeds ${WORKSPACE_ENVELOPE.apps}.`],
    [activeExtensions.size, WORKSPACE_ENVELOPE.extensions, `The active extension count exceeds ${WORKSPACE_ENVELOPE.extensions}.`],
  ];
  for (const [actual, cap, message] of envelopeCaps) {
    if (actual > cap) {
      workspaceSnapshotComplete = false;
      degradedReasons.push(message);
    }
  }

  const enabled = tasksExtInstall !== null && tasksExtInstall.active === true && tasksExtInstall.space === expectedTasksSpace;

  return {
    workspaceUri,
    authorityDid,
    workspaceSkey,
    tasksSpaceUri: expectedTasksSpace,
    enabled,
    extInstall: tasksExtInstall,
    rosterMembers: [...activeRosterMembers].sort(),
    workspaceSnapshotComplete,
    degradedReasons,
    setAside: [],
  };
}

async function readTasksWriters(
  deps: IndependentDeps,
  tasksCredential: SpaceCredential,
  input: {
    tasksSpace: string;
    writerUniverse: readonly string[];
    listedRepos: ReadonlySet<string>;
    maxBytes: number;
    maxRecords: number;
  },
): Promise<{ perWriterRecords: VerifiedRecordEntry[][]; writerSetAside: IndependentTasksSetAside[] }> {
  const writerSetAside: IndependentTasksSetAside[] = [];
  const perWriterRecords = await mapLimited(input.writerUniverse, WRITER_READ_CONCURRENCY, async (did) => {
    let pdsUrl: string;
    let pdsResolved = false;
    try {
      pdsUrl = await resolveVerifiedPds(deps, did);
      pdsResolved = true;
    } catch (error) {
      const failure = classifyVerifiedRepoFailure(error);
      if (!failure) throw error;
      writerSetAside.push({ did, reason: failure.reason, permanent: failure.permanent });
      return [] as VerifiedRecordEntry[];
    }

    try {
      return await readVerifiedRepo(tasksCredential, pdsUrl, {
        space: input.tasksSpace,
        repo: did,
        maxBytes: input.maxBytes,
        maxRecords: input.maxRecords,
        maxRetries: WORKSPACE_ENVELOPE.maxListRecordsRetry,
      });
    } catch (error) {
      if (error instanceof SpaceCredentialError) throw error;
      if (error instanceof XrpcError && error.code === "RepoNotFound") {
        // D11.1 #4 trust boundary: intercept before classifying.
        // Trusted empty (0 records, complete stays true) ONLY when the writer was NOT listed by listRepos
        // AND resolvePds succeeded with a valid HTTPS/loopback endpoint.
        if (!input.listedRepos.has(did) && pdsResolved) {
          return [] as VerifiedRecordEntry[];
        }
      }
      const failure = classifyVerifiedRepoFailure(error);
      if (!failure) throw error;
      writerSetAside.push({ did, reason: failure.reason, permanent: failure.permanent });
      return [] as VerifiedRecordEntry[];
    }
  });

  writerSetAside.sort((left, right) => left.did.localeCompare(right.did));
  return { perWriterRecords, writerSetAside };
}

function collectValidatedTasksRecords(
  authorityDid: string,
  tasksSpace: string,
  writerUniverse: readonly string[],
  perWriterRecords: readonly (readonly VerifiedRecordEntry[])[],
): ValidatedTasksRecords {
  const projects: StoredEntityRecord<ProjectRecordValue>[] = [];
  const projectEdits: StoredEntityRecord<ProjectEditRecordValue>[] = [];
  const tasks: StoredEntityRecord<TaskRecordValue>[] = [];
  const taskEdits: StoredEntityRecord<TaskEditRecordValue>[] = [];
  const comments: StoredEntityRecord<TaskCommentRecordValue>[] = [];

  for (let i = 0; i < writerUniverse.length; i += 1) {
    const repoDid = writerUniverse[i]!;
    for (const entry of perWriterRecords[i]!) {
      const validation = validateSpaceRecord(entry.collection, entry.record, {
        authorityDid,
        spaceUri: tasksSpace,
        repoDid,
        rkey: entry.rkey,
      });
      if (!validation.valid) continue;

      const uri = spaceRecordUri(tasksSpace, repoDid, entry.collection, entry.rkey);
      switch (entry.collection) {
        case COLLECTION.taskProject:
          projects.push({ uri, repo: repoDid, rkey: entry.rkey, value: entry.record as ProjectRecordValue });
          break;
        case COLLECTION.taskProjectEdit:
          projectEdits.push({ uri, repo: repoDid, rkey: entry.rkey, value: entry.record as ProjectEditRecordValue });
          break;
        case COLLECTION.task:
          tasks.push({ uri, repo: repoDid, rkey: entry.rkey, value: entry.record as TaskRecordValue });
          break;
        case COLLECTION.taskEdit:
          taskEdits.push({ uri, repo: repoDid, rkey: entry.rkey, value: entry.record as TaskEditRecordValue });
          break;
        case COLLECTION.taskComment:
          comments.push({ uri, repo: repoDid, rkey: entry.rkey, value: entry.record as TaskCommentRecordValue });
          break;
        default:
          break;
      }
    }
  }

  return { projects, projectEdits, tasks, taskEdits, comments };
}

function collectTasksDegradedReasons(
  snapshot: IndependentTasksWorkspaceSnapshot,
  writerSetAside: readonly IndependentTasksSetAside[],
  merged: MergedTasksSpace,
  hasUncertainAncestry: boolean,
): string[] {
  const degradedReasons: string[] = [...snapshot.degradedReasons];
  for (const entry of writerSetAside.slice(0, MAX_LISTED_SET_ASIDE)) {
    degradedReasons.push(`Task records from ${entry.did} may be missing or out of date: ${entry.reason}`);
  }
  if (writerSetAside.length > MAX_LISTED_SET_ASIDE) {
    degradedReasons.push(`${writerSetAside.length - MAX_LISTED_SET_ASIDE} more writers' task records may be missing or out of date.`);
  }
  if (hasUncertainAncestry) {
    degradedReasons.push("Task causal history limit reached — archive or split into a fresh task.");
  }
  if ((merged.overloadedHistoryEntities ?? 0) > 0) {
    degradedReasons.push(
      `${merged.overloadedHistoryEntities} entity(s) exceed the ${WORKSPACE_ENVELOPE.maxOpsPerEntity}-op causal history envelope.`,
    );
  }

  const activeProjectsCount = merged.projects.filter((project) => !project.deleted).length;
  const activeTasksCount = merged.tasks.filter((task) => !task.deleted).length;
  if (activeProjectsCount > WORKSPACE_ENVELOPE.taskProjects) {
    degradedReasons.push(`Active task projects (${activeProjectsCount}) exceed the ${WORKSPACE_ENVELOPE.taskProjects}-project envelope.`);
  }
  if (activeTasksCount > WORKSPACE_ENVELOPE.tasks) {
    degradedReasons.push(`Active tasks (${activeTasksCount}) exceed the ${WORKSPACE_ENVELOPE.tasks}-task envelope.`);
  }
  let overloadedCommentTasks = 0;
  for (const comments of merged.commentsByTask.values()) {
    if (comments.length > WORKSPACE_ENVELOPE.maxCommentsPerTask) {
      overloadedCommentTasks += 1;
    }
  }
  if (overloadedCommentTasks > 0) {
    degradedReasons.push(
      `${overloadedCommentTasks} task(s) exceed the ${WORKSPACE_ENVELOPE.maxCommentsPerTask}-comment per-task envelope.`,
    );
  }
  return degradedReasons;
}

async function readVerifiedRepo(
  credential: SpaceCredential,
  pdsUrl: string,
  input: { space: string; repo: string; maxBytes: number; maxRecords: number; maxRetries: number },
): Promise<VerifiedRecordEntry[]> {
  // Primary path: verified binary STAR stream bounded by maxBytes & maxRecords.
  let starUnsupported = false;
  for (let attempt = 0; attempt < input.maxRetries; attempt += 1) {
    try {
      const star = await credential.fetchVerifiedRepoStar(pdsUrl, {
        space: input.space,
        repo: input.repo,
        maxBytes: input.maxBytes,
        maxRecords: input.maxRecords,
      });
      return star.records;
    } catch (error) {
      if (isGetRepoUnsupported(error)) {
        starUnsupported = true;
        break;
      }
      // Mid-stream commit race on STAR can raise RepoVerificationError / StarParseError; retry bounded times.
      // Never fall back to listRecords on RepoStarLimitError, SpaceMacError, RepoNotFound, or verification errors.
      if ((error instanceof RepoVerificationError || error instanceof StarParseError) && attempt + 1 < input.maxRetries) {
        continue;
      }
      throw error;
    }
  }

  if (!starUnsupported) {
    throw new RepoVerificationError("STAR verification failed.");
  }

  // Fallback path (only when getRepo endpoint is unsupported): bounded full-repo listRecords
  // with per-page CID verification + aggregate byte/record caps + MAC-verified getLatestCommit + RepoCommit.fromRecords match.
  const repoClient = credential.client(pdsUrl);
  for (let attempt = 0; attempt < input.maxRetries; attempt += 1) {
    const listed = await listVerifiedBoundedRecords(repoClient, {
      space: input.space,
      repo: input.repo,
      maxRecords: input.maxRecords,
      maxBytes: input.maxBytes,
    });

    let rawLatest: { commit?: unknown };
    try {
      rawLatest = await repoClient.query<{ commit?: unknown }>("com.atproto.space.getLatestCommit", {
        space: input.space,
        repo: input.repo,
      });
    } catch (error) {
      if (error instanceof XrpcError && error.code === "RepoNotFound" && listed.records.length > 0) {
        throw new RepoVerificationError("getLatestCommit returned RepoNotFound despite non-empty listRecords.");
      }
      throw error;
    }

    const commit = parseCommit(rawLatest.commit, input.space, input.repo);
    const repoCommit = RepoCommit.fromRecords(
      listed.records.map((record) => ({
        collection: record.collection as never,
        rkey: record.rkey as never,
        cid: record.parsedCid,
      })),
    );
    if (repoCommit.matches(commit)) {
      const actualBytes = (await starHeaderBytes(commit)) + listed.recordsBytes;
      if (actualBytes > input.maxBytes) {
        throw new RepoStarLimitError("bytes", input.maxBytes, actualBytes);
      }
      return listed.records.map((record) => ({
        collection: record.collection,
        rkey: record.rkey,
        cid: record.cid,
        record: record.value,
      }));
    }
  }

  throw new RepoVerificationError("Full-repo listRecords did not match MAC-verified getLatestCommit after bounded retries.");
}

function isGetRepoUnsupported(error: unknown): boolean {
  if (!(error instanceof XrpcError)) return false;
  return (
    error.status === 404 ||
    error.status === 405 ||
    error.status === 501 ||
    error.code === "MethodNotImplemented" ||
    error.code === "XRPCNotSupported" ||
    error.code === "Unsupported"
  );
}

function parseCommit(raw: unknown, expectedSpace: string, expectedRepo: string): Commit {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new RepoVerificationError("getLatestCommit returned a malformed commit.");
  }
  const candidate = raw as { ver?: unknown; repo?: unknown; space?: unknown; rev?: unknown; data?: unknown };
  if (
    candidate.ver !== 1 ||
    candidate.repo !== expectedRepo ||
    candidate.space !== expectedSpace ||
    typeof candidate.rev !== "string" ||
    candidate.rev.length === 0
  ) {
    throw new RepoVerificationError("getLatestCommit commit metadata mismatch.");
  }

  let dataBytes: Uint8Array;
  if (candidate.data instanceof Uint8Array) {
    dataBytes = candidate.data;
  } else if (
    typeof candidate.data === "object" &&
    candidate.data !== null &&
    "$bytes" in candidate.data &&
    typeof (candidate.data as { $bytes?: unknown }).$bytes === "string"
  ) {
    try {
      const converted = jsonToLex(candidate.data as Parameters<typeof jsonToLex>[0]);
      dataBytes = converted instanceof Uint8Array
        ? converted
        : fromBase64((candidate.data as { $bytes: string }).$bytes);
    } catch {
      throw new RepoVerificationError("getLatestCommit returned invalid commit data bytes.");
    }
  } else {
    throw new RepoVerificationError("getLatestCommit returned missing commit data.");
  }

  if (dataBytes.byteLength !== 32) {
    throw new RepoVerificationError("getLatestCommit commit digest must be 32 bytes.");
  }

  return {
    ver: candidate.ver,
    repo: candidate.repo as Commit["repo"],
    space: candidate.space as Commit["space"],
    rev: candidate.rev,
    data: dataBytes,
  };
}

async function resolveVerifiedPds(deps: IndependentDeps, did: string): Promise<string> {
  const resolved = await deps.resolvePds(did);
  if (typeof resolved !== "string" || resolved.length === 0) {
    throw new Error(`Invalid PDS endpoint resolved for ${did}.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(resolved);
  } catch {
    throw new Error(`Malformed PDS endpoint URL resolved for ${did}.`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`Unsafe PDS endpoint URL components resolved for ${did}.`);
  }
  const isHttps = parsed.protocol === "https:";
  const isLoopbackHttp = parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname);
  if (!isHttps && !isLoopbackHttp) {
    throw new Error(`PDS endpoint for ${did} must use HTTPS or loopback HTTP.`);
  }
  return resolved;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function clampBound(override: number | undefined, envelopeMax: number, min: number): number {
  if (override === undefined) return envelopeMax;
  if (!Number.isSafeInteger(override) || override < min) {
    throw new RangeError(`Bound override must be a safe integer >= ${min}.`);
  }
  return Math.min(override, envelopeMax);
}
