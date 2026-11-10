import { NextResponse, type NextRequest } from "next/server";
import { requireSession } from "@/auth/session";
import { isAuthorityReauthorizationRequired, operatorRemoteHttpStatus, submitOperation } from "@/operator/client";
import { AUTHORIZATION_REQUIRED } from "@/lib/api-codes";
import { requireWorkspaceSummary } from "@/workspaces/read-model";
import { workspaceDegradedMessage } from "@/protocol/workspace-summary";
import { readRequestJson, RequestJsonError } from "@/lib/bounded-json";
import { AdminMutationsPausedError } from "@/operator/mutations-paused";
import { rejectCrossOriginMutation } from "@/lib/same-origin-mutation";
import type * as Execute from "@/lexicons/api/types/org/slack/operator/execute";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const rejected = rejectCrossOriginMutation(request);
  if (rejected) return rejected;
  try {
    const session = await requireSession();
    const body = await readRequestJson<Execute.InputSchema>(request, 256 * 1024);
    if (typeof body.workspace !== "string") return NextResponse.json({ error: "Workspace URI is required." }, { status: 400 });
    const summary = await requireWorkspaceSummary(session, body.workspace);
    if (summary.degradedReasons.length > 0) {
      return NextResponse.json({ error: workspaceDegradedMessage(summary.degradedReasons) }, { status: 409, headers: { "cache-control": "no-store" } });
    }
    const result = await submitOperation(session, body);
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to submit the workspace operation.";
    if (error instanceof RequestJsonError) return NextResponse.json({ error: message }, { status: error.status, headers: { "cache-control": "no-store" } });
    if (error instanceof AdminMutationsPausedError) return NextResponse.json({ error: message }, { status: error.status, headers: { "cache-control": "no-store" } });
    if (isAuthorityReauthorizationRequired(error)) {
      return NextResponse.json({
        error: "The workspace authority must approve its permission again before admin changes can run.",
        code: AUTHORIZATION_REQUIRED,
        action: "workspaceAuthority",
      }, { status: 403, headers: { "cache-control": "no-store" } });
    }
    let status = 400;
    if (error instanceof Error && error.message === "Unauthorized") status = 401;
    else status = operatorRemoteHttpStatus(error) ?? status;
    return NextResponse.json({ error: message }, { status, headers: { "cache-control": "no-store" } });
  }
}
