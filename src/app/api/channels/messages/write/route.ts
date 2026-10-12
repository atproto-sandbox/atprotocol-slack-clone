import { NextResponse, type NextRequest } from "next/server";
import type * as CreateRecord from "@/lexicons/api/types/com/atproto/space/createRecord";
import type * as DeleteRecord from "@/lexicons/api/types/com/atproto/space/deleteRecord";
import type * as GetRecord from "@/lexicons/api/types/com/atproto/space/getRecord";
import type * as PutRecord from "@/lexicons/api/types/com/atproto/space/putRecord";
import { requireSession } from "@/auth/session";
import { sessionClient } from "@/atproto/client";
import { isMissingXrpcResource } from "@/atproto/xrpc";
import { resolvePds } from "@/atproto/identity";
import { mintSpaceCredential } from "@/atproto/space-credential";
import { parseSpaceRecordUri, tidNow } from "@/protocol/keys";
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
    const body = await readRequestJson<Record<string, unknown>>(request, 256 * 1024);
    if (typeof body.workspace !== "string" || typeof body.skey !== "string") return NextResponse.json({ error: "Workspace and channel references are required." }, { status: 400 });
    let current: Awaited<ReturnType<typeof requireReadableChannel>>;
    try {
      current = await requireReadableChannel(session, body.workspace, body.skey);
    } catch (error) {
      purgeDeniedPermissionCache(session.did, body.workspace, body.workspace, error);
      throw error;
    }
    const authorityDid = current.authorityDid;
    const space = current.channel;
    await requireCurrentChannelCredential(session, body.workspace, space);
    const client = sessionClient(session);

    if (body.action === "create") {
      if (typeof body.text !== "string") return NextResponse.json({ error: "Message text is required." }, { status: 400 });
      const rkey = tidNow();
      const record: Record<string, unknown> = { $type: "org.slack.channel.message", text: body.text, createdAt: new Date().toISOString() };
      const known = new Set<string>();
      if (body.parent !== undefined) {
        if (typeof body.parent !== "string") return NextResponse.json({ error: "Reply target must be an AT URI." }, { status: 400 });
        const parent = await readMessage(session, space, body.parent);
        if (!parent || parent.value.parent !== undefined) return NextResponse.json({ error: "Reply target must be a top-level message in this channel." }, { status: 400 });
        known.add(body.parent);
        record.parent = body.parent;
      }
      const validation = validateSpaceRecord("org.slack.channel.message", record, {
        authorityDid, spaceUri: space, repoDid: session.did, rkey, knownMessages: known, knownTopLevelMessages: known,
      });
      if (!validation.valid) return NextResponse.json({ error: validation.reason }, { status: 400 });
      const result = await client.procedure<CreateRecord.InputSchema, CreateRecord.OutputSchema>("com.atproto.space.createRecord", {
        space, repo: session.did, collection: "org.slack.channel.message", rkey, record,
      });
      markRepoStale(space, session.did);
      return NextResponse.json({ uri: result.uri, cid: result.cid }, { status: 201 });
    }

    if (body.action === "edit" || body.action === "delete") {
      if (typeof body.uri !== "string") return NextResponse.json({ error: "Message URI is required." }, { status: 400 });
      const target = parseMessageUri(body.uri, space);
      if (!target || target.repo !== session.did) return NextResponse.json({ error: "You can change only your own messages." }, { status: 403 });
      if (body.action === "delete") {
        await client.procedure<DeleteRecord.InputSchema, unknown>("com.atproto.space.deleteRecord", {
          space, repo: session.did, collection: "org.slack.channel.message", rkey: target.rkey,
        });
        markRepoStale(space, session.did);
        return NextResponse.json({ deleted: true });
      }
      if (typeof body.text !== "string") return NextResponse.json({ error: "Message text is required." }, { status: 400 });
      const prior = await readMessage(session, space, body.uri);
      if (!prior) return NextResponse.json({ error: "Message was not found in this channel." }, { status: 404 });
      const record: Record<string, unknown> = { ...prior.value, text: body.text };
      const knownMessages = new Set<string>();
      const knownTopLevelMessages = new Set<string>();
      if (typeof record.parent === "string") {
        const parent = await readMessage(session, space, record.parent);
        if (!parent || parent.value.parent !== undefined) return NextResponse.json({ error: "Reply target must remain a top-level message in this channel." }, { status: 400 });
        knownMessages.add(record.parent);
        knownTopLevelMessages.add(record.parent);
      }
      const validation = validateSpaceRecord("org.slack.channel.message", record, {
        authorityDid, spaceUri: space, repoDid: session.did, rkey: target.rkey, knownMessages, knownTopLevelMessages,
      });
      if (!validation.valid) return NextResponse.json({ error: validation.reason }, { status: 400 });
      const result = await client.procedure<PutRecord.InputSchema, PutRecord.OutputSchema>("com.atproto.space.putRecord", {
        space, repo: session.did, collection: "org.slack.channel.message", rkey: target.rkey, record,
      });
      markRepoStale(space, session.did);
      return NextResponse.json({ uri: result.uri, cid: result.cid });
    }
    return NextResponse.json({ error: "Unsupported message action." }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to write the message.";
    const status = message === "Unauthorized" ? 401 : error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : 400;
    return NextResponse.json({ error: message.slice(0, 500) }, { status });
  }
}

async function readMessage(session: Awaited<ReturnType<typeof requireSession>>, space: string, uri: string): Promise<GetRecord.OutputSchema | null> {
  const target = parseMessageUri(uri, space);
  if (!target) return null;
  try {
    const credential = await mintSpaceCredential(session, space);
    const client = credential.client(await resolvePds(target.repo));
    const record = await client.query<GetRecord.OutputSchema>("com.atproto.space.getRecord", {
      space, repo: target.repo, collection: "org.slack.channel.message", rkey: target.rkey,
    });
    return record.uri === uri ? record : null;
  } catch (error) {
    if (isMissingXrpcResource(error)) return null;
    if (isDenied(error)) purgeSpaceCache(session.did, space);
    throw error;
  }
}

function isDenied(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && (error.status === 401 || error.status === 403);
}

function parseMessageUri(uri: string, space: string): { repo: string; rkey: string } | null {
  return parseSpaceRecordUri(uri, space, "org.slack.channel.message");
}
