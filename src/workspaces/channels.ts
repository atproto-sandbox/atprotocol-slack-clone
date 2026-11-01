import type { OAuthSession } from "@atproto/oauth-client-node";
import type * as GetRecord from "@/lexicons/api/types/com/atproto/space/getRecord";
import { resolvePds } from "@/atproto/identity";
import { mintSpaceCredential } from "@/atproto/space-credential";
import { registerSpaceNotifications } from "@/atproto/notifications";
import { listBoundedRecords } from "@/atproto/record-pages";
import { isMissingXrpcResource } from "@/atproto/xrpc";
import { channelUri } from "@/protocol/keys";
import { validateSpaceRecord } from "@/protocol/records";
import { WorkspaceEnvelopeError } from "./read-model";
import { purgeDeniedPermissionCache, purgeSpaceCache, purgeWorkspaceCache, registerWorkspaceChannel, unregisterWorkspaceChannel } from "./cache";
import { isAccessLost } from "@/atproto/space-credential-core";

const MAX_SUPPORTED_MEMBERS = 200;
const MAX_PRIVATE_ROSTER_SCAN = 1_000;

export async function requireChannelDirectory(session: OAuthSession, workspace: string, skey: string): Promise<{ authorityDid: string; channel: string; visibility: "public" | "private" | "transitioning" | "archived" }> {
  const match = /^at:\/\/(did:[^/]+)\/space\/org\.slack\.workspace\/[A-Za-z0-9._~:-]{1,128}$/.exec(workspace);
  if (!match || !/^[A-Za-z0-9][A-Za-z0-9._~:-]{0,127}$/.test(skey)) throw new Error("Invalid workspace or channel reference.");
  const authorityDid = match[1];
  const directoryReader = await mintSpaceCredential(session, workspace);
  await registerSpaceNotifications(directoryReader, workspace);
  const directoryClient = directoryReader.client(await resolvePds(authorityDid));
  let result: GetRecord.OutputSchema | null;
  try {
    result = await directoryClient.query<GetRecord.OutputSchema>("com.atproto.space.getRecord", {
      space: workspace, repo: authorityDid, collection: "org.slack.directory", rkey: skey,
    });
  } catch (error) {
    if (isMissingXrpcResource(error)) result = null;
    else throw error;
  }
  if (!result || !validateSpaceRecord("org.slack.directory", result.value, {
    authorityDid, spaceUri: workspace, repoDid: authorityDid, rkey: skey,
  }).valid) {
    unregisterWorkspaceChannel(session.did, workspace, channelUri(authorityDid, skey));
    throw new Error("Channel directory record is missing or invalid.");
  }
  const visibility = result.value.visibility;
  if (visibility !== "public" && visibility !== "private" && visibility !== "transitioning" && visibility !== "archived") throw new Error("Invalid channel visibility.");
  const channel = channelUri(authorityDid, skey);
  if (visibility === "archived") unregisterWorkspaceChannel(session.did, workspace, channel);
  else registerWorkspaceChannel(session.did, workspace, channel);
  return { authorityDid, channel, visibility };
}

export async function requireReadableChannel(session: OAuthSession, workspace: string, skey: string): Promise<{ authorityDid: string; channel: string; visibility: "public" | "private" }> {
  const { authorityDid, channel, visibility } = await requireChannelDirectory(session, workspace, skey);
  if (visibility === "transitioning") throw new ChannelUnavailableError("Channel is transitioning; syncing and writes are temporarily paused.", "transitioning");
  if (visibility === "archived") throw new ChannelUnavailableError("Archived channels are unavailable for new sync.", "archived");
  return { authorityDid, channel, visibility };
}

export async function requireCurrentChannelCredential(session: OAuthSession, workspace: string, channel: string) {
  try {
    return await mintSpaceCredential(session, channel);
  } catch (error) {
    purgeDeniedPermissionCache(session.did, workspace, channel, error);
    throw error;
  }
}

export async function readPrivateChannelRoster(session: OAuthSession, workspace: string, skey: string): Promise<string[]> {
  let current: Awaited<ReturnType<typeof requireReadableChannel>>;
  try {
    current = await requireReadableChannel(session, workspace, skey);
  } catch (error) {
    if (isAccessLost(error)) purgeWorkspaceCache(session.did, workspace);
    throw error;
  }
  if (current.visibility !== "private") return [];
  try {
    const credential = await mintSpaceCredential(session, current.channel);
    await registerSpaceNotifications(credential, current.channel);
    const client = credential.client(await resolvePds(current.authorityDid));
    const roster = await listBoundedRecords(client, {
      space: current.channel, repo: current.authorityDid, collection: "org.slack.channel.roster", maxRecords: MAX_PRIVATE_ROSTER_SCAN,
    });
    const members = new Set(roster.records.flatMap((record) => validateSpaceRecord("org.slack.channel.roster", record.value, {
      authorityDid: current.authorityDid, spaceUri: current.channel, repoDid: current.authorityDid, rkey: record.rkey,
    }).valid && record.value.active === true && typeof record.value.subject === "string" ? [record.value.subject] : []));
    if (roster.truncated) throw new WorkspaceEnvelopeError(`Private-channel roster exceeds the ${MAX_PRIVATE_ROSTER_SCAN}-record scan limit; the roster may be incomplete.`);
    if (members.size > MAX_SUPPORTED_MEMBERS) throw new WorkspaceEnvelopeError(`Private-channel roster exceeds ${MAX_SUPPORTED_MEMBERS} members.`);
    return [...members].sort();
  } catch (error) {
    if (isAccessLost(error)) purgeSpaceCache(session.did, current.channel);
    throw error;
  }
}

export class ChannelUnavailableError extends Error {
  constructor(message: string, readonly visibility: "transitioning" | "archived") {
    super(message);
    this.name = "ChannelUnavailableError";
  }
}
