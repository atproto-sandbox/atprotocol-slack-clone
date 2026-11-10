import { type NextRequest } from "next/server";
import { getActorOperation } from "@/operator/journal";
import { withOperatorActor, operatorError } from "@/operator/http";
import { OPERATOR_METHOD } from "@/protocol/nsids";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const workspace = request.nextUrl.searchParams.get("workspace") ?? "";
  const operationId = request.nextUrl.searchParams.get("operationId") ?? "";
  if (!/^[234567abcdefghijklmnopqrstuvwxyz]{13}$/.test(operationId)) return operatorError(400, "InvalidRequest", "Operation ID must be a protocol TID.");
  return withOperatorActor(request, OPERATOR_METHOD.getOperation, workspace, async (actor) => {
    const operation = getActorOperation(actor, operationId);
    if (!operation) throw new Error("Operation not found.");
    return { operation };
  });
}
