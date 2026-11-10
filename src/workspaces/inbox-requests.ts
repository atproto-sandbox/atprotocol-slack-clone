import type * as ListRecords from "@/lexicons/api/types/com/atproto/space/listRecords";
import { assertBoundedRecordPage } from "@/atproto/record-pages";
import { classifyRepoFailure, describeRepoFailure } from "@/atproto/repo-failure";
import { isMissingXrpcResource, type AtprotoClient } from "@/atproto/xrpc";
import { channelUri, requestRecordKey, spaceRecordUri } from "@/protocol/keys";
import { validateSpaceRecord } from "@/protocol/registry";
import { COLLECTION } from "@/protocol/nsids";

const REQUEST_COLLECTION = COLLECTION.joinRequest;
const MAX_REQUESTS_PER_WRITER = 100;

export type InboxJoinRequest = { uri: string; repoDid: string; channelSkey: string; channelName: string; requestId: string; createdAt: string };
export type SkippedInboxWriter = { did: string; reason: string };

/**
 * One inbox writer's join requests for the private channels of a workspace. A writer whose repo cannot be read (deactivated,
 * taken down, unauthenticated, oversized or on a host that is down or misbehaving), or who has filed more than 100 current
 * requests, is reported as skipped instead of failing the list, so the admin can still see and decide everyone else's requests
 * and find the offender. A writer with no repo yet has no requests.
 */
export async function readWriterJoinRequests(input: {
  clientFor: () => Promise<AtprotoClient>;
  inbox: string;
  repoDid: string;
  authorityDid: string;
  channels: ReadonlyArray<{ skey: string; name: string; visibility: string }>;
}): Promise<{ requests: InboxJoinRequest[]; skipped?: SkippedInboxWriter }> {
  const { inbox, repoDid, authorityDid } = input;
  try {
    const client = await input.clientFor();
    const page = await client.query<ListRecords.OutputSchema>("com.atproto.space.listRecords", {
      space: inbox, repo: repoDid, collection: REQUEST_COLLECTION, limit: MAX_REQUESTS_PER_WRITER + 1,
    }).catch((error) => {
      if (isMissingXrpcResource(error)) return { records: [], cursor: undefined };
      throw error;
    });
    assertBoundedRecordPage(page, { collection: REQUEST_COLLECTION, limit: MAX_REQUESTS_PER_WRITER + 1 });
    if (page.records.length > MAX_REQUESTS_PER_WRITER || page.cursor) {
      return { requests: [], skipped: { did: repoDid, reason: `it has more than ${MAX_REQUESTS_PER_WRITER} current request records` } };
    }
    const privateChannels = new Map(input.channels.filter((channel) => channel.visibility === "private").map((channel) => [channel.skey, channel.name]));
    return {
      requests: page.records.flatMap((record) => {
        const value = record.value;
        if (!value || typeof value.channelSkey !== "string" || !privateChannels.has(value.channelSkey)) return [];
        if (record.rkey !== requestRecordKey(channelUri(authorityDid, value.channelSkey), repoDid)) return [];
        if (!validateSpaceRecord(REQUEST_COLLECTION, value, { authorityDid, spaceUri: inbox, repoDid, rkey: record.rkey }).valid) return [];
        return [{
          uri: spaceRecordUri(inbox, repoDid, REQUEST_COLLECTION, record.rkey),
          repoDid,
          channelSkey: value.channelSkey,
          channelName: privateChannels.get(value.channelSkey) ?? value.channelSkey,
          requestId: String(value.requestId),
          createdAt: String(value.createdAt),
        }];
      }),
    };
  } catch (error) {
    const failure = classifyRepoFailure(error);
    if (!failure) throw error;
    console.warn(`Admin inbox skipped a writer (${failure.permanent ? "permanent" : "transient"}): ${describeRepoFailure(error)}`);
    return { requests: [], skipped: { did: repoDid, reason: failure.reason } };
  }
}
