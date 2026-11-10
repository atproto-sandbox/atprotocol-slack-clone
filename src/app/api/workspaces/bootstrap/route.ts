import { NextResponse, type NextRequest } from "next/server";
import { requireSession } from "@/auth/session";
import { assertWorkspaceName, bootstrapWorkspace, type BootstrapResult } from "@/workspaces/bootstrap";
import { readRequestJson } from "@/lib/bounded-json";
import { AuthorityReauthorizationRequiredError, restoreAuthorityGrant } from "@/operator/authority-grant";
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
    assertWorkspaceName(body.name);
    // The signed-in account creates the workspace as its own authority, with the grant the authority flow left, never
    // with its sign-in session.
    let result: BootstrapResult;
    try {
      result = await bootstrapWorkspace(await restoreAuthorityGrant(session.did), { name: body.name, operationId: body.operationId });
    } catch (error) {
      if (error instanceof AuthorityReauthorizationRequiredError) return authorizationRequired(body.operationId);
      throw error;
    }
    if (result.authorizationRequired) return authorizationRequired(result.operationId);
    return NextResponse.json(result, { status: result.state === "completed" ? 201 : 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Workspace setup failed.";
    const status = message === "Unauthorized" ? 401 : message === "OperationIdConflict" ? 409 : error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : 400;
    return NextResponse.json({ error: message }, { status });
  }
}

function authorizationRequired(operationId: string): NextResponse {
  return NextResponse.json({
    error: "Workspace setup needs your permission first.",
    code: AUTHORIZATION_REQUIRED,
    action: "workspaceAuthority",
    operationId,
  }, { status: 403 });
}
