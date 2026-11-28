import { fromBase64 } from "@atproto/lex-data";
import { jsonToLex } from "@atproto/lexicon";
import { RepoCommit, SpaceRepoVerificationError, type SpaceCommit } from "@atproto/space";
import { StarParseError } from "@atproto/star";
import { listBoundedWriters, type BoundedWriters } from "@flock/protocol/atproto/record-pages";
import {
  classifySpaceHostFailure,
  classifyVerifiedRepoFailure,
  isAuthoritySuspendedError,
  MAX_LISTED_SET_ASIDE,
} from "@flock/protocol/atproto/repo-failure";
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
import {
  groupMembersUri,
  groupMetaUri,
  isDid,
  parseWorkspaceUri,
  SELF_SKEY,
  spaceRecordUri,
  tasksSpaceUri,
} from "@flock/protocol/keys";
import { mapLimited } from "@flock/protocol/map-limited";
import {
  isHidden,
  isTakendown,
  labelsForResource,
  projectActiveLabels,
  type ActiveSpaceLabel,
} from "@flock/protocol/moderation";
import { ATGRP_COLLECTION, ATPROTO_SPACE_COLLECTION, COLLECTION } from "@flock/protocol/nsids";
import { validateSpaceRecord } from "@flock/protocol/registry";
import type { GroupAtgrpPolicy } from "@flock/protocol/scopes";
import {
  extractGroupSpacePolicyRecord,
  summarizeWorkspace,
  WORKSPACE_ENVELOPE,
  type MemberConfirmationEntry,
  type MemberWriterRev,
  type ScannedRecords,
  type WorkspaceExtensionSummary,
} from "@flock/protocol/workspace-summary";

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
  accountLabels?: ActiveSpaceLabel[];
};

export type IndependentMergedProject = MergedProject & {
  hidden?: boolean;
  moderationLabels?: string[];
};

export type IndependentMergedTask = MergedTask & {
  hidden?: boolean;
  moderationLabels?: string[];
};

export type IndependentTaskComment = TaskCommentView & {
  hidden?: boolean;
  moderationLabels?: string[];
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
  projects: IndependentMergedProject[];
  tasks: IndependentMergedTask[];
  commentsByTask: Map<string, IndependentTaskComment[]>;
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
  let tasksCredential: SpaceCredential;
  let authorityPds: string;
  let repoScan: BoundedWriters;
  try {
    tasksCredential = await mintSpaceCredentialWith(deps, tasksSpace);
    authorityPds = await resolveVerifiedPds(deps, snapshot.authorityDid);
    repoScan = await listBoundedWriters(tasksCredential.client(authorityPds), {
      space: tasksSpace,
      maxRepos: MAX_TASKS_WRITERS,
    });
  } catch (error) {
    if (isAuthoritySuspendedError(error)) {
      const failure = classifySpaceHostFailure(error)!;
      return buildHostSuspendedTasksResult(snapshot, failure.reason);
    }
    throw error;
  }
  if (repoScan.truncated) {
    throw new Error(`Tasks writer count exceeds the ${MAX_TASKS_WRITERS}-writer scan limit.`);
  }

  const listedRepos = new Set(repoScan.writers.map((writer) => writer.repo));
  const writerUniverseSet = new Set<string>([...listedRepos, ...snapshot.rosterMembers, snapshot.authorityDid]);
  const writerUniverse = [...writerUniverseSet].sort();

  const { perWriterRecords, writerSetAside } = await readTasksWriters(deps, tasksCredential, {
    tasksSpace,
    authorityDid: snapshot.authorityDid,
    writerUniverse,
    listedRepos,
    maxBytes,
    maxRecords,
  });

  const writerSetAsideDids = new Set(writerSetAside.map((entry) => entry.did));
  const allSetAside = [
    ...snapshot.setAside.filter((entry) => !writerSetAsideDids.has(entry.did)),
    ...writerSetAside,
  ].sort((left, right) => left.did.localeCompare(right.did));

  const authorityIdx = writerUniverse.indexOf(snapshot.authorityDid);
  const authorityTasksRecords = authorityIdx >= 0 ? perWriterRecords[authorityIdx]! : [];
  const tasksPolicyRecords = authorityTasksRecords.filter(
    (e) => e.collection === ATPROTO_SPACE_COLLECTION.spacePolicy,
  );
  const tasksPolicyCheck = extractGroupSpacePolicyRecord(snapshot.authorityDid, tasksSpace, {
    records: tasksPolicyRecords.map((e) => ({
      rkey: e.rkey,
      ...(e.cid.length > 0 ? { cid: e.cid } : {}),
      value: e.record,
    })),
    truncated: tasksPolicyRecords.length > 1,
  });
  const tasksPolicyInvalid = !writerSetAsideDids.has(snapshot.authorityDid) && !tasksPolicyCheck.valid;

  const rawLabelEntries = authorityTasksRecords
    .filter((e) => e.collection === ATPROTO_SPACE_COLLECTION.label)
    .map((e) => ({ repoDid: snapshot.authorityDid, rkey: e.rkey, value: e.record }));
  const tasksLabels = projectActiveLabels(rawLabelEntries, {
    groupDid: snapshot.authorityDid,
    spaceUri: tasksSpace,
  });
  const accountLabels = snapshot.accountLabels ?? [];

  const validated = collectValidatedTasksRecords(
    snapshot.authorityDid,
    tasksSpace,
    writerUniverse,
    perWriterRecords,
    tasksLabels,
    accountLabels,
  );

  const complete = snapshot.workspaceSnapshotComplete && allSetAside.length === 0 && !tasksPolicyInvalid;
  const merged = mergeTasksSpace({ ...validated, complete });
  const hasUncertainAncestry =
    merged.projects.some((project) => project.uncertainAncestry) ||
    merged.tasks.some((task) => task.uncertainAncestry);
  const degradedReasons = collectTasksDegradedReasons(snapshot, writerSetAside, merged, hasUncertainAncestry);
  if (tasksPolicyInvalid && !degradedReasons.some((r) => r.includes("Space policy records"))) {
    degradedReasons.push(
      "Space policy records contain malformed or missing entries; workspace access governance may be incomplete.",
    );
  }

  const projects: IndependentMergedProject[] = merged.projects.map((p) => {
    const vals = [
      ...new Set([
        ...labelsForResource(tasksLabels, p.uri).map((l) => l.val),
        ...labelsForResource(accountLabels, p.repo).map((l) => l.val),
      ]),
    ].sort();
    const hidden = isHidden(tasksLabels, p.uri) || isHidden(accountLabels, p.repo);
    return {
      ...p,
      ...(hidden ? { hidden: true } : {}),
      ...(vals.length > 0 ? { moderationLabels: vals } : {}),
    };
  });

  const tasks: IndependentMergedTask[] = merged.tasks.map((t) => {
    const vals = [
      ...new Set([
        ...labelsForResource(tasksLabels, t.uri).map((l) => l.val),
        ...labelsForResource(accountLabels, t.repo).map((l) => l.val),
      ]),
    ].sort();
    const hidden = isHidden(tasksLabels, t.uri) || isHidden(accountLabels, t.repo);
    return {
      ...t,
      ...(hidden ? { hidden: true } : {}),
      ...(vals.length > 0 ? { moderationLabels: vals } : {}),
    };
  });

  const commentsByTask = new Map<string, IndependentTaskComment[]>();
  for (const [taskUri, comments] of merged.commentsByTask.entries()) {
    commentsByTask.set(
      taskUri,
      comments.map((c) => {
        const vals = [
          ...new Set([
            ...labelsForResource(tasksLabels, c.uri).map((l) => l.val),
            ...labelsForResource(accountLabels, c.repo).map((l) => l.val),
          ]),
        ].sort();
        const hidden = isHidden(tasksLabels, c.uri) || isHidden(accountLabels, c.repo);
        return {
          ...c,
          ...(hidden ? { hidden: true } : {}),
          ...(vals.length > 0 ? { moderationLabels: vals } : {}),
        };
      }),
    );
  }

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
    projects,
    tasks,
    commentsByTask,
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
  const metaUri = groupMetaUri(authorityDid);
  const membersUri = groupMembersUri(authorityDid);
  const expectedTasksSpace = tasksSpaceUri(authorityDid, workspaceSkey);
  const maxBytes = clampBound(options.maxStarArchiveBytes, WORKSPACE_ENVELOPE.maxStarArchiveBytes, 1);
  const maxRecords = clampBound(options.maxStarRecords, WORKSPACE_ENVELOPE.maxStarRecords, 0);

  let metaCred: SpaceCredential;
  let membersCred: SpaceCredential;
  let wsCredential: SpaceCredential;
  try {
    [metaCred, membersCred, wsCredential] = await Promise.all([
      mintSpaceCredentialWith(deps, metaUri),
      mintSpaceCredentialWith(deps, membersUri),
      mintSpaceCredentialWith(deps, workspaceUri),
    ]);
  } catch (error) {
    if (isAuthoritySuspendedError(error)) {
      const failure = classifySpaceHostFailure(error)!;
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
    throw error;
  }

  let authorityPds: string;
  let metaRecords: VerifiedRecordEntry[];
  let membersAuthorityRecords: VerifiedRecordEntry[];
  let wsAuthorityRecords: VerifiedRecordEntry[];
  let membersWriterScan: BoundedWriters;
  try {
    authorityPds = await resolveVerifiedPds(deps, authorityDid);
    [metaRecords, membersAuthorityRecords, wsAuthorityRecords, membersWriterScan] = await Promise.all([
      readVerifiedRepo(metaCred, authorityPds, {
        space: metaUri,
        repo: authorityDid,
        maxBytes,
        maxRecords,
        maxRetries: WORKSPACE_ENVELOPE.maxListRecordsRetry,
      }),
      readVerifiedRepo(membersCred, authorityPds, {
        space: membersUri,
        repo: authorityDid,
        maxBytes,
        maxRecords,
        maxRetries: WORKSPACE_ENVELOPE.maxListRecordsRetry,
      }),
      readVerifiedRepo(wsCredential, authorityPds, {
        space: workspaceUri,
        repo: authorityDid,
        maxBytes,
        maxRecords,
        maxRetries: WORKSPACE_ENVELOPE.maxListRecordsRetry,
      }),
      listBoundedWriters(membersCred.client(authorityPds), {
        space: membersUri,
        maxRepos: MAX_TASKS_WRITERS,
      }),
    ]);
  } catch (error) {
    if (error instanceof SpaceCredentialError) throw error;
    const failure = classifyVerifiedRepoFailure(error, {
      space: workspaceUri,
      repo: authorityDid,
      authorityDid,
    });
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

  const memberWriters = new Map<string, MemberWriterRev>();
  for (const w of membersWriterScan.writers) {
    memberWriters.set(w.repo, { repoRev: w.repoRev, spaceRev: w.spaceRev });
  }
  const knownApps = new Set<string>(
    wsAuthorityRecords
      .filter((e) => e.collection === COLLECTION.appInstall && typeof e.record.subject === "string")
      .map((e) => String(e.record.subject)),
  );
  const admittedHumans = membersAuthorityRecords
    .filter((e) => e.collection === ATGRP_COLLECTION.membership)
    .map((e) => e.rkey)
    .filter((did) => isDid(did) && did !== authorityDid && !knownApps.has(did));

  const memberSetAside: IndependentTasksSetAside[] = [];
  const confirmations: MemberConfirmationEntry[] = [];
  await mapLimited(
    admittedHumans.filter((did) => memberWriters.has(did)),
    WRITER_READ_CONCURRENCY,
    async (memberDid) => {
      try {
        const pdsUrl = await resolveVerifiedPds(deps, memberDid);
        const entries = await readVerifiedRepo(membersCred, pdsUrl, {
          space: membersUri,
          repo: memberDid,
          maxBytes,
          maxRecords,
          maxRetries: WORKSPACE_ENVELOPE.maxListRecordsRetry,
        });
        const conf = entries.find((e) => e.collection === ATGRP_COLLECTION.confirmation && e.rkey === SELF_SKEY);
        if (conf) {
          confirmations.push({ repoDid: memberDid, rkey: SELF_SKEY, value: conf.record });
        }
      } catch (error) {
        if (error instanceof SpaceCredentialError) throw error;
        const failure = classifyVerifiedRepoFailure(error, {
          space: membersUri,
          repo: memberDid,
          authorityDid,
        });
        if (!failure) throw error;
        memberSetAside.push({ did: memberDid, reason: failure.reason, permanent: failure.permanent });
      }
    },
  );

  return summarizeVerifiedWorkspaceRecords({
    workspaceUri,
    authorityDid,
    workspaceSkey,
    expectedTasksSpace,
    metaUri,
    membersUri,
    metaRecords,
    membersAuthorityRecords,
    wsAuthorityRecords,
    confirmations,
    memberWriters,
    membersWriterScanTruncated: membersWriterScan.truncated,
    memberSetAside,
    nowMs: deps.now ? deps.now() : Date.now(),
  });
}

export function buildHostSuspendedTasksResult(
  snapshot: IndependentTasksWorkspaceSnapshot,
  reason: string,
): IndependentTasksReadResult {
  const setAside: IndependentTasksSetAside[] = [
    ...snapshot.setAside.filter((entry) => entry.did !== snapshot.authorityDid),
    { did: snapshot.authorityDid, reason, permanent: false },
  ].sort((left, right) => left.did.localeCompare(right.did));
  const degradedReasons = [
    ...snapshot.degradedReasons,
    `Tasks space host ${snapshot.authorityDid} is unavailable: ${reason}`,
  ];
  return {
    workspaceUri: snapshot.workspaceUri,
    tasksSpaceUri: snapshot.tasksSpaceUri,
    enabled: true,
    extInstall: snapshot.extInstall,
    workspaceSnapshotComplete: snapshot.workspaceSnapshotComplete,
    complete: false,
    degraded: true,
    degradedReasons,
    hasUncertainAncestry: false,
    setAside,
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

export function summarizeVerifiedWorkspaceRecords(input: {
  workspaceUri: string;
  authorityDid: string;
  workspaceSkey: string;
  expectedTasksSpace: string;
  metaUri: string;
  membersUri: string;
  metaRecords: readonly VerifiedRecordEntry[];
  membersAuthorityRecords: readonly VerifiedRecordEntry[];
  wsAuthorityRecords: readonly VerifiedRecordEntry[];
  confirmations: readonly MemberConfirmationEntry[];
  memberWriters: ReadonlyMap<string, MemberWriterRev>;
  membersWriterScanTruncated: boolean;
  memberSetAside: readonly IndependentTasksSetAside[];
  nowMs?: number;
}): IndependentTasksWorkspaceSnapshot {
  const {
    workspaceUri,
    authorityDid,
    workspaceSkey,
    expectedTasksSpace,
    metaUri,
    membersUri,
    metaRecords,
    membersAuthorityRecords,
    wsAuthorityRecords,
    confirmations,
    memberWriters,
    membersWriterScanTruncated,
    memberSetAside,
    nowMs,
  } = input;

  const degradedReasons: string[] = [];
  let workspaceSnapshotComplete = memberSetAside.length === 0 && !membersWriterScanTruncated;
  if (membersWriterScanTruncated) {
    degradedReasons.push(
      `Members space writer set exceeds the ${MAX_TASKS_WRITERS}-repo scan limit; member confirmation state may be incomplete.`,
    );
  }
  let invalidRecordCount = 0;
  let tasksExtInstall: WorkspaceExtensionSummary | null = null;

  const checkInSpace = (targetSpace: string, entries: readonly VerifiedRecordEntry[], collection: string) => {
    const out: Array<{ rkey: string; cid?: string; value: Record<string, unknown> }> = [];
    for (const entry of entries) {
      if (entry.collection !== collection) continue;
      const validation = validateSpaceRecord(collection, entry.record, {
        authorityDid,
        spaceUri: targetSpace,
        repoDid: authorityDid,
        rkey: entry.rkey,
      });
      if (!validation.valid) {
        workspaceSnapshotComplete = false;
        invalidRecordCount += 1;
        if (invalidRecordCount <= MAX_REPORTED_INVALID_RECORDS) {
          degradedReasons.push(
            `Workspace snapshot contains an invalid ${collection} record (${entry.rkey}): ${validation.reason}`,
          );
        }
        continue;
      }
      if (collection === COLLECTION.extInstall && entry.rkey === "tasks" && entry.record.extId === "tasks") {
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
        if (extSummary.space !== expectedTasksSpace) {
          workspaceSnapshotComplete = false;
          degradedReasons.push("Tasks ext.install space URI does not match canonical workspace tasks space.");
        } else {
          tasksExtInstall = extSummary;
        }
      }
      out.push({
        rkey: entry.rkey,
        ...(entry.cid.length > 0 ? { cid: entry.cid } : {}),
        value: entry.record,
      });
    }
    const cap =
      collection === ATGRP_COLLECTION.about || collection === ATGRP_COLLECTION.config
        ? 1
        : WORKSPACE_ENVELOPE.authorityRecordScan;
    return { records: out, truncated: out.length > cap };
  };

  const spacePolicies = new Map<string, GroupAtgrpPolicy>();
  let invalidPolicyScan = false;
  for (const [spUri, entries] of [
    [metaUri, metaRecords],
    [membersUri, membersAuthorityRecords],
    [workspaceUri, wsAuthorityRecords],
  ] as const) {
    const polEntries = entries.filter((e) => e.collection === ATPROTO_SPACE_COLLECTION.spacePolicy);
    const polScanned: ScannedRecords = {
      records: polEntries.map((e) => ({
        rkey: e.rkey,
        ...(e.cid.length > 0 ? { cid: e.cid } : {}),
        value: e.record,
      })),
      truncated: polEntries.length > 1,
    };
    const extracted = extractGroupSpacePolicyRecord(authorityDid, spUri, polScanned);
    if (extracted.valid && extracted.policy) {
      spacePolicies.set(spUri, extracted.policy);
    } else {
      invalidPolicyScan = true;
    }
  }

  const abouts = checkInSpace(metaUri, metaRecords, ATGRP_COLLECTION.about);
  const configs = checkInSpace(metaUri, metaRecords, ATGRP_COLLECTION.config);
  const roles = checkInSpace(membersUri, membersAuthorityRecords, ATGRP_COLLECTION.role);
  const memberships = checkInSpace(membersUri, membersAuthorityRecords, ATGRP_COLLECTION.membership);
  const accountLabelScan = checkInSpace(membersUri, membersAuthorityRecords, ATPROTO_SPACE_COLLECTION.label);
  const directory = checkInSpace(workspaceUri, wsAuthorityRecords, COLLECTION.directory);
  const installs = checkInSpace(workspaceUri, wsAuthorityRecords, COLLECTION.appInstall);
  const extInstalls = checkInSpace(workspaceUri, wsAuthorityRecords, COLLECTION.extInstall);

  if (invalidPolicyScan) {
    workspaceSnapshotComplete = false;
  }

  if (accountLabelScan.truncated) {
    workspaceSnapshotComplete = false;
    degradedReasons.push(
      `Account moderation label records exceed the ${WORKSPACE_ENVELOPE.authorityRecordScan}-record scan limit; the member list is withheld.`,
    );
  }

  if (invalidRecordCount > MAX_REPORTED_INVALID_RECORDS) {
    degradedReasons.push(
      `Workspace snapshot contains ${invalidRecordCount - MAX_REPORTED_INVALID_RECORDS} additional invalid authority records.`,
    );
  }

  const accountLabels = projectActiveLabels(
    accountLabelScan.records.map((e) => ({ repoDid: authorityDid, rkey: e.rkey, value: e.value })),
    { groupDid: authorityDid, spaceUri: membersUri, ...(nowMs !== undefined ? { nowMs } : {}) },
  );

  const summary = summarizeWorkspace(workspaceUri, "", {
    abouts,
    configs,
    roles,
    memberships,
    directory,
    installs,
    extInstalls,
    confirmations,
    memberWriters,
    accountLabels,
    spacePolicies,
  });

  if (!summary) {
    workspaceSnapshotComplete = false;
    degradedReasons.push("Workspace profile record is missing or invalid.");
  } else {
    for (const reason of summary.degradedReasons) {
      workspaceSnapshotComplete = false;
      if (!degradedReasons.includes(reason)) degradedReasons.push(reason);
    }
  }
  if (invalidPolicyScan && !degradedReasons.some((r) => r.includes("Space policy records"))) {
    degradedReasons.push(
      "Space policy records contain malformed or missing entries; workspace access governance may be incomplete.",
    );
  }

  const enabled =
    tasksExtInstall !== null &&
    (tasksExtInstall as WorkspaceExtensionSummary).active === true &&
    (tasksExtInstall as WorkspaceExtensionSummary).space === expectedTasksSpace;

  return {
    workspaceUri,
    authorityDid,
    workspaceSkey,
    tasksSpaceUri: expectedTasksSpace,
    enabled,
    extInstall: tasksExtInstall,
    rosterMembers: summary && !accountLabelScan.truncated ? summary.members.map((m) => m.did).sort() : [],
    workspaceSnapshotComplete,
    degradedReasons,
    setAside: [...memberSetAside].sort((a, b) => a.did.localeCompare(b.did)),
    accountLabels,
  };
}

async function readTasksWriters(
  deps: IndependentDeps,
  tasksCredential: SpaceCredential,
  input: {
    tasksSpace: string;
    authorityDid: string;
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
      const failure = classifyVerifiedRepoFailure(error, {
        space: input.tasksSpace,
        repo: did,
        authorityDid: input.authorityDid,
      });
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
        // Trusted empty (0 records, complete stays true) ONLY when the writer was NOT listed by listWriters
        // AND resolvePds succeeded with a valid HTTPS/loopback endpoint.
        if (!input.listedRepos.has(did) && pdsResolved) {
          return [] as VerifiedRecordEntry[];
        }
      }
      const failure = classifyVerifiedRepoFailure(error, {
        space: input.tasksSpace,
        repo: did,
        authorityDid: input.authorityDid,
      });
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
  tasksLabels: readonly ActiveSpaceLabel[] = [],
  accountLabels: readonly ActiveSpaceLabel[] = [],
): ValidatedTasksRecords {
  const projects: StoredEntityRecord<ProjectRecordValue>[] = [];
  const projectEdits: StoredEntityRecord<ProjectEditRecordValue>[] = [];
  const tasks: StoredEntityRecord<TaskRecordValue>[] = [];
  const taskEdits: StoredEntityRecord<TaskEditRecordValue>[] = [];
  const comments: StoredEntityRecord<TaskCommentRecordValue>[] = [];

  for (let i = 0; i < writerUniverse.length; i += 1) {
    const repoDid = writerUniverse[i]!;
    if (isTakendown(accountLabels, repoDid)) continue;
    for (const entry of perWriterRecords[i]!) {
      const uri = spaceRecordUri(tasksSpace, repoDid, entry.collection, entry.rkey);
      if (isTakendown(tasksLabels, uri, entry.cid || undefined)) continue;
      const validation = validateSpaceRecord(entry.collection, entry.record, {
        authorityDid,
        spaceUri: tasksSpace,
        repoDid,
        rkey: entry.rkey,
      });
      if (!validation.valid) continue;
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
      // Mid-stream commit race on STAR can raise SpaceRepoVerificationError / StarParseError; retry bounded times.
      // Never fall back to listRecords on RepoStarLimitError, SpaceMacError, RepoNotFound, or verification errors.
      if ((error instanceof SpaceRepoVerificationError || error instanceof StarParseError) && attempt + 1 < input.maxRetries) {
        continue;
      }
      throw error;
    }
  }

  if (!starUnsupported) {
    throw new SpaceRepoVerificationError("STAR verification failed.");
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
        throw new SpaceRepoVerificationError("getLatestCommit returned RepoNotFound despite non-empty listRecords.");
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

  throw new SpaceRepoVerificationError("Full-repo listRecords did not match MAC-verified getLatestCommit after bounded retries.");
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

function parseCommit(raw: unknown, expectedSpace: string, expectedRepo: string): SpaceCommit {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SpaceRepoVerificationError("getLatestCommit returned a malformed commit.");
  }
  const candidate = raw as { ver?: unknown; repo?: unknown; space?: unknown; rev?: unknown; data?: unknown };
  if (
    candidate.ver !== 1 ||
    candidate.repo !== expectedRepo ||
    candidate.space !== expectedSpace ||
    typeof candidate.rev !== "string" ||
    candidate.rev.length === 0
  ) {
    throw new SpaceRepoVerificationError("getLatestCommit commit metadata mismatch.");
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
      throw new SpaceRepoVerificationError("getLatestCommit returned invalid commit data bytes.");
    }
  } else {
    throw new SpaceRepoVerificationError("getLatestCommit returned missing commit data.");
  }

  if (dataBytes.byteLength !== 32) {
    throw new SpaceRepoVerificationError("getLatestCommit commit digest must be 32 bytes.");
  }

  return {
    ver: candidate.ver,
    repo: candidate.repo as SpaceCommit["repo"],
    space: candidate.space as SpaceCommit["space"],
    rev: candidate.rev as SpaceCommit["rev"],
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
