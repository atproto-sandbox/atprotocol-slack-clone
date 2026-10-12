import { NextResponse, type NextRequest } from "next/server";
import { requireSession } from "@/auth/session";
import { bootstrapWorkspace } from "@/workspaces/bootstrap";
import { readRequestJson } from "@/lib/bounded-json";
import { assertAdminMutationsEnabled } from "@/operator/mutations-paused";
import { rejectCrossOriginMutation } from "@/lib/same-origin-mutation";
import { AUTHORIZATION_REQUIRED } from "@/lib/api-codes";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const rejected = rejectCrossOriginMutation(request);
  if (rejected) return rejected;
  try {
    const session = await requireSession();
    assertAdminMutationsEnabled();
    const body = await readRequestJson<{ name?: unknown; operationId?: unknown }>(request);
    if (typeof body.name !== "string" || typeof body.operationId !== "string") {
      return NextResponse.json({ error: "A workspace name and operation ID are required." }, { status: 400 });
    }
    const result = await bootstrapWorkspace(session, { name: body.name, operationId: body.operationId });
    if (result.authorizationRequired) {
      return NextResponse.json({
        error: "Workspace setup needs your permission first.",
        code: AUTHORIZATION_REQUIRED,
        action: "workspaceAuthority",
        operationId: result.operationId,
      }, { status: 403 });
    }
    return NextResponse.json(result, { status: result.state === "completed" ? 201 : 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Workspace setup failed.";
    const status = message === "Unauthorized" ? 401 : message === "OperationIdConflict" ? 409 : error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
