import { NextResponse } from "next/server";
import { OperatorAuthError } from "./errors";
import { authenticateOperatorRequest, requireActiveWorkspaceAdmin } from "./security";
import { OperationBusyError, OperationConflictError } from "./journal";
import { operatorHttpFailure } from "./errors";
import { assertOperatorWorkspaceWithinEnvelope } from "./workspace-envelope";
import { WorkspaceEnvelopeError } from "@/protocol/workspace-summary";
import { OPERATOR_METHOD, type OperatorMethod } from "@/protocol/nsids";

export async function withOperatorActor<T>(
  request: Request,
  method: OperatorMethod,
  workspace: string,
  action: (actor: Awaited<ReturnType<typeof requireActiveWorkspaceAdmin>>) => Promise<T>,
): Promise<NextResponse> {
  try {
    const did = await authenticateOperatorRequest(request, method);
    const actor = await requireActiveWorkspaceAdmin(workspace, did, { allowDegradedLookup: method === OPERATOR_METHOD.getOperation });
    if (method === OPERATOR_METHOD.execute || method === OPERATOR_METHOD.listInboxWriters) {
      await assertOperatorWorkspaceWithinEnvelope(actor);
    }
    const result = await action(actor);
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Operator request failed.";
    const upstreamFailure = operatorHttpFailure(error);
    if (upstreamFailure) return xrpcError(upstreamFailure.status, upstreamFailure.name, upstreamFailure.message);
    if (error instanceof OperatorAuthError) return xrpcError(403, "Unauthorized", message);
    if (error instanceof OperationConflictError) return xrpcError(409, "Conflict", message);
    if (error instanceof OperationBusyError) return xrpcError(503, "Busy", message);
    if (error instanceof WorkspaceEnvelopeError) return xrpcError(error.status, "Conflict", message);
    return xrpcError(400, "InvalidRequest", message);
  }
}

export function operatorError(status: number, name: string, message: string): NextResponse {
  return xrpcError(status, name, message);
}

function xrpcError(status: number, name: string, message: string): NextResponse {
  return NextResponse.json({ error: name, message: message.slice(0, 500) }, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
