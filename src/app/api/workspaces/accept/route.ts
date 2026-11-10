import { NextResponse, type NextRequest } from "next/server";
import type * as PutRecord from "@/lexicons/api/types/com/atproto/space/putRecord";
import { requireSession } from "@/auth/session";
import { sessionClient } from "@/atproto/client";
import { mintSpaceCredential } from "@/atproto/space-credential";
import { acceptanceRecordKey, parseWorkspaceUri } from "@/protocol/keys";
import { validateSpaceRecord } from "@/protocol/registry";
import { purgeDeniedPermissionCache } from "@/workspaces/cache";
import { readRequestJson } from "@/lib/bounded-json";
import { rejectCrossOriginMutation } from "@/lib/same-origin-mutation";
import { acceptFailure } from "@/workspaces/accept-errors";
import { COLLECTION } from "@/protocol/nsids";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const rejected = rejectCrossOriginMutation(request);
  if (rejected) return rejected;
  try {
    const session = await requireSession();
    const body = await readRequestJson<{ workspace?: unknown }>(request);
    if (typeof body.workspace !== "string") return NextResponse.json({ error: "Workspace URI is required." }, { status: 400 });
    const parsedWorkspace = parseWorkspaceUri(body.workspace);
    if (!parsedWorkspace) return NextResponse.json({ error: "Invalid workspace URI." }, { status: 400 });
    const { authorityDid } = parsedWorkspace;
    const record = { $type: COLLECTION.acceptance, workspace: body.workspace, createdAt: new Date().toISOString() };
    const rkey = acceptanceRecordKey(body.workspace);
    const validation = validateSpaceRecord(COLLECTION.acceptance, record, {
      authorityDid, spaceUri: body.workspace, repoDid: session.did, rkey,
    });
    if (!validation.valid) return NextResponse.json({ error: validation.reason }, { status: 400 });
    try {
      // Acceptance records aid discovery; invitation membership must still be current.
      await mintSpaceCredential(session, body.workspace);
    } catch (error) {
      purgeDeniedPermissionCache(session.did, body.workspace, body.workspace, error);
      throw error;
    }
    const result = await sessionClient(session).procedure<PutRecord.InputSchema, PutRecord.OutputSchema>(
      "com.atproto.space.putRecord",
      { space: body.workspace, repo: session.did, collection: COLLECTION.acceptance, rkey, record },
    );
    return NextResponse.json({ workspace: body.workspace, marker: result.uri }, { status: 201 });
  } catch (error) {
    const known = acceptFailure(error);
    if (known) return NextResponse.json({ error: known.error, code: known.code }, { status: known.status });
    const message = error instanceof Error ? error.message : "Unable to accept the workspace invitation.";
    const status = message === "Unauthorized" ? 401 : error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
