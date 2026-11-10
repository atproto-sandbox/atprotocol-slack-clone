import { NextResponse, type NextRequest } from "next/server";
import { requireSession } from "@/auth/session";
import { submitOperation } from "@/operator/client";
import { tidNow } from "@/protocol/keys";
import { requireWorkspaceSummary } from "@/workspaces/read-model";
import { workspaceDegradedMessage } from "@/protocol/workspace-summary";
import { readRequestJson } from "@/lib/bounded-json";
import { rejectCrossOriginMutation } from "@/lib/same-origin-mutation";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const rejected = rejectCrossOriginMutation(request);
  if (rejected) return rejected;
  try {
    const session = await requireSession();
    const body = await readRequestJson<{ workspace?: unknown }>(request);
    if (typeof body.workspace !== "string") return NextResponse.json({ error: "Workspace URI is required." }, { status: 400 });
    const summary = await requireWorkspaceSummary(session, body.workspace);
    if (summary.degradedReasons.length > 0) {
      return NextResponse.json({ error: workspaceDegradedMessage(summary.degradedReasons) }, { status: 409, headers: { "cache-control": "no-store" } });
    }
    if (!summary.isAdmin) return NextResponse.json({ error: "Active workspace admin permission is required." }, { status: 403 });
    const result = await submitOperation(session, {
      workspace: summary.uri,
      operationId: tidNow(),
      request: { kind: "reconcileWorkspace" },
    });
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to reconcile workspace membership.";
    const status = message === "Unauthorized" ? 401 : error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : 400;
    return NextResponse.json({ error: message.slice(0, 500) }, { status, headers: { "cache-control": "no-store" } });
  }
}
