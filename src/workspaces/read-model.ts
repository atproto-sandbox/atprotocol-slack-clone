import type { OAuthSession } from "@atproto/oauth-client-node";
import { sessionClient } from "@/atproto/client";
import { resolvePds } from "@/atproto/identity";
import { listBoundedRecords } from "@/atproto/record-pages";
import { listBoundedSpaces } from "@/atproto/space-pages";
import { mintSpaceCredential } from "@/atproto/space-credential";
import { registerSpaceNotifications } from "@/atproto/notifications";
import { channelUri } from "@/protocol/keys";
import { validateSpaceRecord } from "@/protocol/records";
import { purgeCachesForUnlistedWorkspaces, purgeWorkspaceCache, replaceWorkspaceChannels } from "./cache";
import { mapLimited } from "@/lib/map-limited";
import { isAccessLost, isSpaceDeleted } from "@/atproto/space-credential-core";

export type WorkspaceSummary = {
  uri: string;
  authorityDid: string;
  skey: string;
  name: string;
  isAdmin: boolean;
  admins: string[];
  members: Array<{ did: string; active: boolean }>;
  channels: Array<{ uri: string; skey: string; name: string; visibility: string }>;
  degradedReasons: string[];
};

export type WorkspaceCandidate = { uri: string; authorityDid: string; skey: string };
export type WorkspaceDiscovery = { workspaces: WorkspaceSummary[]; candidates: WorkspaceCandidate[] };

const MAX_SUPPORTED_MEMBERS = 200;
const MAX_SUPPORTED_CHANNELS = 100;
const MAX_AUTHORITY_RECORD_SCAN = 1_000;
const MAX_DISCOVERABLE_WORKSPACES = 1_000;

export function workspaceDegradedMessage(reasons: readonly string[]): string {
  return `Workspace is in degraded mode because it exceeds the supported v1 envelope. ${reasons.join(" ")} Admin changes and inbox reconciliation are paused until the workspace is within the supported limits.`;
}

export class WorkspaceEnvelopeError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "WorkspaceEnvelopeError";
  }
}

export function assertWorkspaceWithinEnvelope(summary: Pick<WorkspaceSummary, "degradedReasons">): void {
  if (summary.degradedReasons.length > 0) {
    throw new WorkspaceEnvelopeError(workspaceDegradedMessage(summary.degradedReasons));
  }
}

export async function discoverWorkspaces(session: OAuthSession): Promise<WorkspaceSummary[]> {
  return (await discoverWorkspaceState(session)).workspaces;
}

export async function discoverWorkspaceState(session: OAuthSession): Promise<WorkspaceDiscovery> {
  const spaces = await listBoundedSpaces(sessionClient(session), { spaceType: "org.slack.workspace", maxSpaces: MAX_DISCOVERABLE_WORKSPACES });
  const results = await mapLimited(spaces, 8, async (uri) => {
    try {
      const summary = await readWorkspaceSummary(session, uri);
      if (!summary) purgeWorkspaceCache(session.did, uri);
      return { summary, candidate: null };
    } catch (error) {
      if (!isAccessLost(error)) throw error;
      purgeWorkspaceCache(session.did, uri);
      return { summary: null, candidate: isSpaceDeleted(error) ? null : workspaceCandidate(uri) };
    }
  });
  purgeCachesForUnlistedWorkspaces(session.did, spaces);
  return {
    workspaces: results.flatMap(({ summary }) => summary ? [summary] : []).sort((left, right) => left.name.localeCompare(right.name)),
    candidates: results.flatMap(({ candidate }) => candidate ? [candidate] : []).sort((left, right) => left.uri.localeCompare(right.uri)),
  };
}

export async function requireWorkspaceSummary(session: OAuthSession, uri: string): Promise<WorkspaceSummary> {
  try {
    const summary = await readWorkspaceSummary(session, uri);
    if (!summary) {
      purgeWorkspaceCache(session.did, uri);
      throw new Error("Workspace could not be read or contains invalid authority records.");
    }
    return summary;
  } catch (error) {
    if (isAccessLost(error)) purgeWorkspaceCache(session.did, uri);
    throw error;
  }
}

function workspaceCandidate(uri: string): WorkspaceCandidate | null {
  const match = /^at:\/\/(did:[^/]+)\/space\/org\.slack\.workspace\/([A-Za-z0-9._~:-]{1,128})$/.exec(uri);
  return match ? { uri, authorityDid: match[1], skey: match[2] } : null;
}

async function readWorkspaceSummary(session: OAuthSession, uri: string): Promise<WorkspaceSummary | null> {
  const match = /^at:\/\/(did:[^/]+)\/space\/org\.slack\.workspace\/([A-Za-z0-9._~:-]{1,128})$/.exec(uri);
  if (!match) return null;
  const [, authorityDid, skey] = match;
  const credential = await mintSpaceCredential(session, uri);
  await registerSpaceNotifications(credential, uri);
  const reader = credential.client(await resolvePds(authorityDid));
  const [profiles, directory, roster, admins] = await Promise.all([
    listBoundedRecords(reader, { space: uri, repo: authorityDid, collection: "org.slack.workspace.profile", maxRecords: 1 }),
    listBoundedRecords(reader, { space: uri, repo: authorityDid, collection: "org.slack.directory", maxRecords: MAX_AUTHORITY_RECORD_SCAN }),
    listBoundedRecords(reader, { space: uri, repo: authorityDid, collection: "org.slack.workspace.roster", maxRecords: MAX_AUTHORITY_RECORD_SCAN }),
    listBoundedRecords(reader, { space: uri, repo: authorityDid, collection: "org.slack.admin", maxRecords: MAX_AUTHORITY_RECORD_SCAN }),
  ]);
  const validProfile = profiles.records.find((record) => validateSpaceRecord("org.slack.workspace.profile", record.value, {
    authorityDid, spaceUri: uri, repoDid: authorityDid, rkey: record.rkey,
  }).valid);
  const validDirectory = directory.records.filter((record) => validateSpaceRecord("org.slack.directory", record.value, {
    authorityDid, spaceUri: uri, repoDid: authorityDid, rkey: record.rkey,
  }).valid);
  const validRoster = roster.records.filter((record) => validateSpaceRecord("org.slack.workspace.roster", record.value, {
    authorityDid, spaceUri: uri, repoDid: authorityDid, rkey: record.rkey,
  }).valid);
  const validAdmins = admins.records.filter((record) => validateSpaceRecord("org.slack.admin", record.value, {
    authorityDid, spaceUri: uri, repoDid: authorityDid, rkey: record.rkey,
  }).valid);
  const name = validProfile?.value.name;
  if (typeof name !== "string") return null;
  const memberDidSet = new Set(validRoster.filter((record) => record.value.active === true).map((record) => String(record.value.subject)));
  const degradedReasons: string[] = [];
  if (profiles.truncated) degradedReasons.push("Workspace profile records exceed the expected single-record limit.");
  if (directory.truncated) degradedReasons.push(`The channel directory exceeds the ${MAX_AUTHORITY_RECORD_SCAN}-record scan limit; the channel list may be incomplete.`);
  if (roster.truncated) degradedReasons.push(`The workspace roster exceeds the ${MAX_AUTHORITY_RECORD_SCAN}-record scan limit; the member list may be incomplete.`);
  if (admins.truncated) degradedReasons.push(`Admin records exceed the ${MAX_AUTHORITY_RECORD_SCAN}-record scan limit; the admin list may be incomplete.`);
  if (memberDidSet.size > MAX_SUPPORTED_MEMBERS) degradedReasons.push(`The active workspace roster exceeds ${MAX_SUPPORTED_MEMBERS} members.`);
  const channels = validDirectory.flatMap((record) => {
    const value = record.value;
    if (typeof value.skey !== "string" || typeof value.name !== "string" || typeof value.visibility !== "string") return [];
    if (value.visibility === "archived") return [];
    return [{ uri: channelUri(authorityDid, value.skey), skey: value.skey, name: value.name, visibility: value.visibility }];
  });
  if (channels.length > MAX_SUPPORTED_CHANNELS) degradedReasons.push(`The active channel count exceeds ${MAX_SUPPORTED_CHANNELS} channels.`);
  replaceWorkspaceChannels(session.did, uri, channels.filter((channel) => channel.visibility !== "archived").map((channel) => channel.uri));
  const adminDids = validAdmins.flatMap((record) => record.value.active === true && typeof record.value.subject === "string" ? [record.value.subject] : []);
  if (adminDids.length > MAX_SUPPORTED_MEMBERS) degradedReasons.push(`The active admin count exceeds ${MAX_SUPPORTED_MEMBERS} members.`);
  return {
    uri,
    authorityDid,
    skey,
    name,
    isAdmin: adminDids.includes(session.did),
    admins: adminDids.sort(),
    members: [...memberDidSet].map((did) => ({ did, active: true })).sort((left, right) => left.did.localeCompare(right.did)),
    channels: channels.sort((left, right) => left.name.localeCompare(right.name)),
    degradedReasons,
  };
}
