import { NextResponse, type NextRequest } from "next/server";
import { requireSession } from "@/auth/session";
import { listStalledWork } from "@/operator/stalled";
import { requireActiveWorkspaceAdmin } from "@/operator/security";
import { stalledOperationsErrorResponse } from "@/operator/stalled-route-error";
import { requireWorkspaceSummary } from "@/workspaces/read-model";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const session = await requireSession();
    const workspace = request.nextUrl.searchParams.get("workspace") ?? "";
    const summary = await requireWorkspaceSummary(session, workspace);
    const actor = await requireActiveWorkspaceAdmin(summary.uri, session.did);
    return NextResponse.json(listStalledWork(actor.workspace.authorityDid, actor.workspace.uri), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return stalledOperationsErrorResponse(error);
  }
}
