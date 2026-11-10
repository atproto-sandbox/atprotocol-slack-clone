import type { OAuthSession } from "@atproto/oauth-client-node";
import { sessionClient } from "@/atproto/client";
import { resolvePds } from "@/atproto/identity";
import { listAllSpaceUris, listBoundedRecords } from "@/atproto/record-pages";
import { mintSpaceCredential } from "@/atproto/space-credential";
import { registerSpaceNotifications } from "@/operator/notices";
import { parseWorkspaceUri } from "@/protocol/keys";
import { summarizeWorkspace, WORKSPACE_ENVELOPE, type WorkspaceSummary } from "@/protocol/workspace-summary";
import { purgeCachesForUnlistedWorkspaces, purgeWorkspaceCache, replaceWorkspaceChannels } from "./cache";
import { mapLimited } from "@/lib/map-limited";
import { isAccessLost, isSpaceDeleted } from "@/atproto/space-credential-core";
import { COLLECTION, SPACE_TYPE } from "@/protocol/nsids";

export type WorkspaceCandidate = { uri: string; authorityDid: string; skey: string };
export type WorkspaceDiscovery = { workspaces: WorkspaceSummary[]; candidates: WorkspaceCandidate[] };

const MAX_DISCOVERABLE_WORKSPACES = 1_000;

export async function discoverWorkspaces(session: OAuthSession): Promise<WorkspaceSummary[]> {
  return (await discoverWorkspaceState(session)).workspaces;
}

export async function discoverWorkspaceState(session: OAuthSession): Promise<WorkspaceDiscovery> {
  const spaces = await listAllSpaceUris(sessionClient(session), { spaceType: SPACE_TYPE.workspace, maxSpaces: MAX_DISCOVERABLE_WORKSPACES });
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
  const workspace = parseWorkspaceUri(uri);
  return workspace ? { uri, ...workspace } : null;
}

async function readWorkspaceSummary(session: OAuthSession, uri: string): Promise<WorkspaceSummary | null> {
  const workspace = parseWorkspaceUri(uri);
  if (!workspace) return null;
  const { authorityDid } = workspace;
  const credential = await mintSpaceCredential(session, uri);
  await registerSpaceNotifications(credential, uri);
  const reader = credential.client(await resolvePds(authorityDid));
  const scan = (collection: string, maxRecords: number) => listBoundedRecords(reader, { space: uri, repo: authorityDid, collection, maxRecords });
  const [profiles, directory, roster, admins] = await Promise.all([
    scan(COLLECTION.workspaceProfile, 1),
    scan(COLLECTION.directory, WORKSPACE_ENVELOPE.authorityRecordScan),
    scan(COLLECTION.workspaceRoster, WORKSPACE_ENVELOPE.authorityRecordScan),
    scan(COLLECTION.admin, WORKSPACE_ENVELOPE.authorityRecordScan),
  ]);
  const summary = summarizeWorkspace(uri, session.did, { profiles, directory, roster, admins });
  if (summary) replaceWorkspaceChannels(session.did, uri, summary.channels.map((channel) => channel.uri));
  return summary;
}
