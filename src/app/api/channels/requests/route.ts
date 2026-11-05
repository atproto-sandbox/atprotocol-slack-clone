import { NextResponse, type NextRequest } from "next/server";
import type * as DeleteRecord from "@/lexicons/api/types/com/atproto/space/deleteRecord";
import type * as PutRecord from "@/lexicons/api/types/com/atproto/space/putRecord";
import { requireSession } from "@/auth/session";
import { isMissingXrpcResource } from "@/atproto/xrpc";
import { sessionClient } from "@/atproto/client";
import { inboxUri } from "@/protocol/keys";
import { channelUri, parseWorkspaceUri, requestRecordKey, tidNow } from "@/protocol/keys";
import { validateSpaceRecord } from "@/protocol/records";
import { requireChannelDirectory } from "@/workspaces/channels";
import { purgeDeniedPermissionCache } from "@/workspaces/cache";
import { readRequestJson } from "@/lib/bounded-json";
import { rejectCrossOriginMutation } from "@/lib/same-origin-mutation";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const rejected = rejectCrossOriginMutation(request);
  if (rejected) return rejected;
  try {
    const session = await requireSession();
    const body = await readRequestJson<Record<string, unknown>>(request);
    if (typeof body.workspace !== "string" || typeof body.skey !== "string") return NextResponse.json({ error: "Workspace and private channel are required." }, { status: 400 });
    let current: Awaited<ReturnType<typeof requireChannelDirectory>>;
    try {
      current = await requireChannelDirectory(session, body.workspace, body.skey);
    } catch (error) {
      purgeDeniedPermissionCache(session.did, body.workspace, body.workspace, error);
      throw error;
    }
    if (current.visibility !== "private" && body.action !== "withdraw") return NextResponse.json({ error: "Join requests are only used for private channels." }, { status: 400 });
    const parsedWorkspace = parseWorkspaceUri(body.workspace);
    if (!parsedWorkspace) return NextResponse.json({ error: "Invalid workspace URI." }, { status: 400 });
    const space = inboxUri(current.authorityDid, parsedWorkspace.skey);
    const rkey = requestRecordKey(channelUri(current.authorityDid, body.skey), session.did);
    if (body.action === "withdraw") {
      try {
        await sessionClient(session).procedure<DeleteRecord.InputSchema, unknown>("com.atproto.space.deleteRecord", {
          space, repo: session.did, collection: "org.slack.joinRequest", rkey,
        });
      } catch (error) {
        if (!isMissingXrpcResource(error)) throw error;
      }
      return NextResponse.json({ withdrawn: true });
    }
    const record = { $type: "org.slack.joinRequest", channelSkey: body.skey, requestId: tidNow(), createdAt: new Date().toISOString() };
    const validation = validateSpaceRecord("org.slack.joinRequest", record, {
      authorityDid: current.authorityDid, spaceUri: space, repoDid: session.did, rkey,
    });
    if (!validation.valid) return NextResponse.json({ error: validation.reason }, { status: 400 });
    const result = await sessionClient(session).procedure<PutRecord.InputSchema, PutRecord.OutputSchema>("com.atproto.space.putRecord", {
      space, repo: session.did, collection: "org.slack.joinRequest", rkey, record,
    });
    return NextResponse.json({ uri: result.uri, requestId: record.requestId }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to request channel access.";
    const status = message === "Unauthorized" ? 401 : error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : 400;
    return NextResponse.json({ error: message.slice(0, 500) }, { status });
  }
}
