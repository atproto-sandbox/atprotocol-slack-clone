import { NextResponse, type NextRequest } from "next/server";
import { authorityFlowUrl } from "@/operator/authority-grant";
import { OperatorAuthError, operatorHttpFailure } from "@/operator/errors";
import { operatorError } from "@/operator/http";
import { assertWorkspaceName } from "@/operator/kinds/bootstrap-workspace";
import { authenticateOperatorRequest } from "@/operator/security";
import { readRequestJson, RequestJsonError } from "@/lib/bounded-json";
import { OPERATOR_METHOD } from "@/protocol/nsids";

export const runtime = "nodejs";

/** A ticket URL for the caller to grant the operator authority over its own workspaces, to create one or to reauthorize. */
export async function POST(request: NextRequest) {
  try {
    const did = await authenticateOperatorRequest(request, OPERATOR_METHOD.startAuthorityFlow);
    const body = await readRequestJson<Record<string, unknown>>(request, 4 * 1024);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "purpose" && key !== "name")) {
      return operatorError(400, "InvalidRequest", "The request takes a purpose and, to create a workspace, its name.");
    }
    if (body.purpose === "reauthorize" && body.name === undefined) {
      return NextResponse.json({ url: authorityFlowUrl(did, null).toString() }, { headers: { "cache-control": "no-store" } });
    }
    if (body.purpose !== "createWorkspace" || typeof body.name !== "string") {
      return operatorError(400, "InvalidRequest", "The purpose is createWorkspace with a workspace name, or reauthorize without one.");
    }
    assertWorkspaceName(body.name);
    return NextResponse.json({ url: authorityFlowUrl(did, body.name.trim()).toString() }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The authority flow could not be started.";
    if (error instanceof RequestJsonError) return operatorError(error.status, "InvalidRequest", message);
    const upstreamFailure = operatorHttpFailure(error);
    if (upstreamFailure) return operatorError(upstreamFailure.status, upstreamFailure.name, upstreamFailure.message);
    if (error instanceof OperatorAuthError) return operatorError(403, "Unauthorized", message);
    return operatorError(400, "InvalidRequest", message);
  }
}
