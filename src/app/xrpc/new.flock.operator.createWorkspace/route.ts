import { NextResponse, type NextRequest } from "next/server";
import { AuthorityReauthorizationRequiredError, restoreAuthorityGrant } from "@/operator/authority-grant";
import { OperatorAuthError, operatorHttpFailure } from "@/operator/errors";
import { operatorError } from "@/operator/http";
import { OperationBusyError, OperationConflictError } from "@/operator/journal";
import { assertWorkspaceName, bootstrapWorkspace } from "@/operator/kinds/bootstrap-workspace";
import { AdminMutationsPausedError, assertAdminMutationsEnabled } from "@/operator/mutations-paused";
import { registrationDeps } from "@/operator/registrations";
import { authenticateOperatorRequest } from "@/operator/security";
import { readRequestJson, RequestJsonError } from "@/lib/bounded-json";
import { OPERATOR_METHOD } from "@/protocol/nsids";

export const runtime = "nodejs";

const AUTHORIZATION_REQUIRED = "Workspace setup needs the authority's approval first: start the authority flow to reauthorize, then retry with the same operation id.";

/** Creates a workspace with the caller as its authority, using the grant the caller's authority flow left. */
export async function POST(request: NextRequest) {
  try {
    const did = await authenticateOperatorRequest(request, OPERATOR_METHOD.createWorkspace);
    assertAdminMutationsEnabled();
    const body = await readRequestJson<Record<string, unknown>>(request);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "name" && key !== "operationId")) {
      return operatorError(400, "InvalidRequest", "The request takes a workspace name and an operation ID.");
    }
    if (typeof body.name !== "string" || typeof body.operationId !== "string") {
      return operatorError(400, "InvalidRequest", "A workspace name and operation ID are required.");
    }
    assertWorkspaceName(body.name);
    let grant;
    try {
      grant = await restoreAuthorityGrant(did);
    } catch (error) {
      if (error instanceof AuthorityReauthorizationRequiredError) return operatorError(403, "AuthorizationRequired", AUTHORIZATION_REQUIRED);
      throw error;
    }
    const result = await bootstrapWorkspace(grant, { name: body.name, operationId: body.operationId }, registrationDeps);
    if (result.authorizationRequired) return operatorError(403, "AuthorizationRequired", AUTHORIZATION_REQUIRED);
    const { operationId, workspace, channel, state, completedSteps, error } = result;
    return NextResponse.json({ operationId, workspace, channel, state, completedSteps, ...(error ? { error } : {}) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Workspace setup failed.";
    if (error instanceof AdminMutationsPausedError) return operatorError(error.status, "Paused", message);
    if (error instanceof RequestJsonError) return operatorError(error.status, "InvalidRequest", message);
    const upstreamFailure = operatorHttpFailure(error);
    if (upstreamFailure) return operatorError(upstreamFailure.status, upstreamFailure.name, upstreamFailure.message);
    if (error instanceof OperatorAuthError) return operatorError(403, "Unauthorized", message);
    if (error instanceof OperationConflictError) return operatorError(409, "OperationIdConflict", message);
    if (error instanceof OperationBusyError) return operatorError(503, "Busy", message);
    return operatorError(400, "InvalidRequest", message);
  }
}
