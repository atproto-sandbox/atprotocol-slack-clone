import { NextResponse, type NextRequest } from "next/server";
import { executeOperatorOperation } from "@/operator/operations";
import { OperationBusyError, OperationConflictError } from "@/operator/journal";
import { authenticateOperatorRequest, requireWorkspaceActorForOperation } from "@/operator/security";
import { AUTHORITY_APPROVAL_REQUIRED, OperatorAuthError, operatorHttpFailure } from "@/operator/errors";
import { operatorError } from "@/operator/http";
import { AdminMutationsPausedError, assertAdminMutationsEnabled } from "@/operator/mutations-paused";
import { assertOperatorWorkspaceWithinEnvelope } from "@/operator/workspace-envelope";
import { WorkspaceEnvelopeError } from "@/protocol/workspace-summary";
import { readRequestJson, RequestJsonError } from "@/lib/bounded-json";
import { OPERATOR_METHOD } from "@/protocol/nsids";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const did = await authenticateOperatorRequest(request, OPERATOR_METHOD.execute);
    assertAdminMutationsEnabled();
    const body = await readRequestJson<Record<string, unknown>>(request, 256 * 1024);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !["workspace", "operationId", "request"].includes(key))) {
      return operatorError(400, "InvalidRequest", "Unexpected operator request fields.");
    }
    if (typeof body.workspace !== "string" || typeof body.operationId !== "string" || !/^[234567abcdefghijklmnopqrstuvwxyz]{13}$/.test(body.operationId)) {
      return operatorError(400, "InvalidRequest", "Workspace URI and protocol TID operation ID are required.");
    }
    const actor = await requireWorkspaceActorForOperation(body.workspace, did, body.request);
    await assertOperatorWorkspaceWithinEnvelope(actor);
    const operation = await executeOperatorOperation(actor, body.operationId, body.request);
    if (operation.authorizationRequired) {
      return operatorError(AUTHORITY_APPROVAL_REQUIRED.status, AUTHORITY_APPROVAL_REQUIRED.name, AUTHORITY_APPROVAL_REQUIRED.message);
    }
    return NextResponse.json({ operation }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Operator request failed.";
    if (error instanceof AdminMutationsPausedError) return operatorError(error.status, "Paused", message);
    if (error instanceof RequestJsonError) return operatorError(error.status, "InvalidRequest", message);
    const upstreamFailure = operatorHttpFailure(error);
    if (upstreamFailure) return operatorError(upstreamFailure.status, upstreamFailure.name, upstreamFailure.message);
    if (error instanceof OperatorAuthError) return operatorError(403, "Unauthorized", message);
    if (error instanceof OperationConflictError) return operatorError(409, "Conflict", message);
    if (error instanceof OperationBusyError) return operatorError(503, "Busy", message);
    if (error instanceof WorkspaceEnvelopeError) return operatorError(error.status, "Conflict", message);
    return operatorError(400, "InvalidRequest", message);
  }
}
