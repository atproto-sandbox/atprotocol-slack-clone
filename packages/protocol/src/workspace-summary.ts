import type { ExtensionId } from "./extensions";
import { channelUri, parseWorkspaceUri } from "./keys";
import { COLLECTION } from "./nsids";
import { validateSpaceRecord } from "./registry";

// What a workspace is, read from its authority's own records, and whether it is inside the supported envelope. The member
// read model and the operator both read the same records and summarize them here, so they agree on the workspace and on
// when admin changes must pause.

export const WORKSPACE_ENVELOPE = {
  members: 200,
  apps: 20,
  extensions: 20,
  memberList: 220,
  channels: 100,
  taskProjects: 100,
  tasks: 2_000,
  maxAncestorRefs: 256,
  maxOpsPerEntity: 1_000,
  maxCommentsPerTask: 200,
  maxStarArchiveBytes: 16 * 1024 * 1024,
  maxStarRecords: 20_000,
  maxRepoOpsPages: 128,
  maxListRecordsRetry: 3,
  authorityRecordScan: 1_000,
} as const;

export type WorkspaceExtensionSummary = {
  extId: ExtensionId;
  active: boolean;
  space: string;
  cleanupComplete: boolean;
  enabledBy: string;
  enabledAt: string;
  updatedAt: string;
  disabledAt?: string;
};

export type WorkspaceSummary = {
  uri: string;
  authorityDid: string;
  skey: string;
  name: string;
  isAdmin: boolean;
  admins: string[];
  members: Array<{ did: string; active: boolean }>;
  channels: Array<{ uri: string; skey: string; name: string; visibility: string }>;
  /** The active apps: each account the workspace installed, and the channels it may read, writing where `write` is true. */
  installs: Array<{ did: string; channels: Array<{ skey: string; write: boolean }> }>;
  /** Valid extension install records (both enabled and disabled) written by the workspace authority. */
  extensions?: WorkspaceExtensionSummary[];
  degradedReasons: string[];
};

/** One collection of the authority's records, as a bounded scan returned it. */
export type ScannedRecords = { records: Array<{ rkey: string; value: Record<string, unknown> }>; truncated: boolean };

export type WorkspaceRecords = {
  profiles: ScannedRecords;
  directory: ScannedRecords;
  roster: ScannedRecords;
  admins: ScannedRecords;
  installs: ScannedRecords;
  extInstalls?: ScannedRecords;
};

export class WorkspaceEnvelopeError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "WorkspaceEnvelopeError";
  }
}

export function workspaceDegradedMessage(reasons: readonly string[]): string {
  return `Workspace is in degraded mode because it exceeds the supported v1 envelope. ${reasons.join(" ")} Admin changes and inbox reconciliation are paused until the workspace is within the supported limits.`;
}

export function assertWorkspaceWithinEnvelope(summary: Pick<WorkspaceSummary, "degradedReasons">): void {
  if (summary.degradedReasons.length > 0) throw new WorkspaceEnvelopeError(workspaceDegradedMessage(summary.degradedReasons));
}

/**
 * The workspace its authority's records describe, as seen by `viewerDid`, or null when there is no valid profile. Records that
 * fail validation are ignored; scans cut short, and counts beyond the envelope, become degraded reasons.
 */
export function summarizeWorkspace(uri: string, viewerDid: string, records: WorkspaceRecords): WorkspaceSummary | null {
  const workspace = parseWorkspaceUri(uri);
  if (!workspace) return null;
  const { authorityDid, skey } = workspace;
  const valid = (collection: string, scanned: ScannedRecords) => scanned.records.filter((record) => validateSpaceRecord(collection, record.value, {
    authorityDid, spaceUri: uri, repoDid: authorityDid, rkey: record.rkey,
  }).valid);
  const name = valid(COLLECTION.workspaceProfile, records.profiles)[0]?.value.name;
  if (typeof name !== "string") return null;
  const members = new Set(valid(COLLECTION.workspaceRoster, records.roster).filter((record) => record.value.active === true).map((record) => String(record.value.subject)));
  const channels = valid(COLLECTION.directory, records.directory).flatMap(({ value }) => value.visibility === "archived" ? [] : [{
    uri: channelUri(authorityDid, String(value.skey)), skey: String(value.skey), name: String(value.name), visibility: String(value.visibility),
  }]);
  const admins = valid(COLLECTION.admin, records.admins).flatMap((record) => record.value.active === true ? [String(record.value.subject)] : []);
  // An archived channel grants nothing (archiving ends every grant of it; a record that still lists one is not followed).
  const open = new Set(channels.map((channel) => channel.skey));
  const installs = valid(COLLECTION.appInstall, records.installs).flatMap(({ value }) => value.active === true ? [{
    did: String(value.subject),
    channels: (value.channels as Array<{ skey: string; write: boolean }>).filter(({ skey }) => open.has(skey)).map(({ skey, write }) => ({ skey, write })),
  }] : []);
  const extInstallRecords = records.extInstalls ?? { records: [], truncated: false };
  const extensions: WorkspaceExtensionSummary[] = valid(COLLECTION.extInstall, extInstallRecords)
    .map(({ value }) => ({
      extId: value.extId as ExtensionId,
      active: value.active === true,
      space: String(value.space),
      cleanupComplete: value.cleanupComplete === true,
      enabledBy: String(value.enabledBy),
      enabledAt: String(value.enabledAt),
      updatedAt: String(value.updatedAt),
      ...(typeof value.disabledAt === "string" ? { disabledAt: value.disabledAt } : {}),
    }))
    .sort((left, right) => left.extId.localeCompare(right.extId));
  const activeExtensions = extensions.filter((extension) => extension.active).length;
  const scan = WORKSPACE_ENVELOPE.authorityRecordScan;
  const degradedReasons = [
    records.profiles.truncated && "Workspace profile records exceed the expected single-record limit.",
    records.directory.truncated && `The channel directory exceeds the ${scan}-record scan limit; the channel list may be incomplete.`,
    records.roster.truncated && `The workspace roster exceeds the ${scan}-record scan limit; the member list may be incomplete.`,
    records.admins.truncated && `Admin records exceed the ${scan}-record scan limit; the admin list may be incomplete.`,
    records.installs.truncated && `App install records exceed the ${scan}-record scan limit; the app list may be incomplete.`,
    extInstallRecords.truncated && `Extension install records exceed the ${scan}-record scan limit; the extension list may be incomplete.`,
    members.size > WORKSPACE_ENVELOPE.members && `The active workspace roster exceeds ${WORKSPACE_ENVELOPE.members} members.`,
    channels.length > WORKSPACE_ENVELOPE.channels && `The active channel count exceeds ${WORKSPACE_ENVELOPE.channels} channels.`,
    admins.length > WORKSPACE_ENVELOPE.members && `The active admin count exceeds ${WORKSPACE_ENVELOPE.members} members.`,
    installs.length > WORKSPACE_ENVELOPE.apps && `The active app count exceeds ${WORKSPACE_ENVELOPE.apps}.`,
    activeExtensions > WORKSPACE_ENVELOPE.extensions && `The active extension count exceeds ${WORKSPACE_ENVELOPE.extensions}.`,
  ].filter((reason): reason is string => typeof reason === "string");
  return {
    uri,
    authorityDid,
    skey,
    name,
    isAdmin: admins.includes(viewerDid),
    admins: admins.sort(),
    members: [...members].map((did) => ({ did, active: true })).sort((left, right) => left.did.localeCompare(right.did)),
    channels: channels.sort((left, right) => left.name.localeCompare(right.name)),
    installs: installs.sort((left, right) => left.did.localeCompare(right.did)),
    extensions,
    degradedReasons,
  };
}
