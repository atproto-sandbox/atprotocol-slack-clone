import { NextResponse, type NextRequest } from "next/server";
import type * as DeleteRecord from "@/lexicons/api/types/com/atproto/space/deleteRecord";
import type * as GetRecord from "@/lexicons/api/types/com/atproto/space/getRecord";
import type * as PutRecord from "@/lexicons/api/types/com/atproto/space/putRecord";
import { requireSession } from "@/auth/session";
import { sessionClient } from "@/atproto/client";
import { isMissingXrpcResource } from "@/atproto/xrpc";
import { resolvePds } from "@/atproto/identity";
import { parseSpaceRecordUri, reactionRecordKey } from "@/protocol/keys";
import { validateSpaceRecord } from "@/protocol/records";
import { requireCurrentChannelCredential, requireReadableChannel } from "@/workspaces/channels";
import { markRepoStale, purgeDeniedPermissionCache, purgeSpaceCache } from "@/workspaces/cache";
import { readRequestJson } from "@/lib/bounded-json";
import { rejectCrossOriginMutation } from "@/lib/same-origin-mutation";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const rejected = rejectCrossOriginMutation(request);
  if (rejected) return rejected;
  try {
    const session = await requireSession();
    const body = await readRequestJson<Record<string, unknown>>(request);
    if (typeof body.workspace !== "string" || typeof body.skey !== "string" || typeof body.subject !== "string" || typeof body.emoji !== "string" || typeof body.active !== "boolean") {
      return NextResponse.json({ error: "Workspace, channel, message, emoji, and active state are required." }, { status: 400 });
    }
    let current: Awaited<ReturnType<typeof requireReadableChannel>>;
    try {
      current = await requireReadableChannel(session, body.workspace, body.skey);
    } catch (error) {
      purgeDeniedPermissionCache(session.did, body.workspace, body.workspace, error);
      throw error;
    }
    const authorityDid = current.authorityDid;
    const space = current.channel;
    const target = parseSpaceRecordUri(body.subject, space, "org.slack.channel.message");
    if (!target) return NextResponse.json({ error: "Invalid message URI." }, { status: 400 });
    const credential = await requireCurrentChannelCredential(session, body.workspace, space);
    const rkey = reactionRecordKey(body.subject, body.emoji, session.did);
    const client = sessionClient(session);
    if (!body.active) {
      try {
        await client.procedure<DeleteRecord.InputSchema, unknown>("com.atproto.space.deleteRecord", {
          space, repo: session.did, collection: "org.slack.channel.reaction", rkey,
        });
      } catch (error) {
        if (!isMissingXrpcResource(error)) throw error;
      }
      markRepoStale(space, session.did);
      return NextResponse.json({ active: false });
    }
    try {
      const targetClient = credential.client(await resolvePds(target.repo));
      await targetClient.query<GetRecord.OutputSchema>("com.atproto.space.getRecord", {
        space, repo: target.repo, collection: "org.slack.channel.message", rkey: target.rkey,
      });
    } catch (error) {
      if (isDenied(error)) purgeSpaceCache(session.did, space);
      throw error;
    }
    const record = { $type: "org.slack.channel.reaction", subject: body.subject, emoji: body.emoji, createdAt: new Date().toISOString() };
    const validation = validateSpaceRecord("org.slack.channel.reaction", record, {
      authorityDid, spaceUri: space, repoDid: session.did, rkey, knownMessages: new Set([body.subject]),
    });
    if (!validation.valid) return NextResponse.json({ error: validation.reason }, { status: 400 });
    await client.procedure<PutRecord.InputSchema, PutRecord.OutputSchema>("com.atproto.space.putRecord", {
      space, repo: session.did, collection: "org.slack.channel.reaction", rkey, record,
    });
    markRepoStale(space, session.did);
    return NextResponse.json({ active: true, rkey });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update the reaction.";
    const status = message === "Unauthorized" ? 401 : error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : 400;
    return NextResponse.json({ error: message.slice(0, 500) }, { status });
  }
}

function isDenied(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && (error.status === 401 || error.status === 403);
}
