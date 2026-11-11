import { NextResponse, type NextRequest } from "next/server";
import { FeedRequestError, getChanges, parseFollow } from "@/operator/feed";
import { OperatorAuthError, operatorHttpFailure } from "@/operator/errors";
import { operatorError } from "@/operator/http";
import { authenticateOperatorRequest } from "@/operator/security";
import { readRequestJson, RequestJsonError } from "@/lib/bounded-json";
import { OPERATOR_METHOD } from "@/protocol/nsids";

export const runtime = "nodejs";
/** A call waits up to 25 seconds for a change. */
export const maxDuration = 35;

export async function POST(request: NextRequest) {
  try {
    const did = await authenticateOperatorRequest(request, OPERATOR_METHOD.getChanges);
    const follow = parseFollow(await readRequestJson<unknown>(request, 128 * 1024));
    return NextResponse.json(await getChanges(did, follow, request.signal), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The change feed failed.";
    if (error instanceof RequestJsonError) return operatorError(error.status, "InvalidRequest", message);
    if (error instanceof FeedRequestError) return operatorError(400, "InvalidRequest", message);
    const upstreamFailure = operatorHttpFailure(error);
    if (upstreamFailure) return operatorError(upstreamFailure.status, upstreamFailure.name, upstreamFailure.message);
    if (error instanceof OperatorAuthError) return operatorError(403, "Unauthorized", message);
    return operatorError(500, "InternalServerError", "The change feed failed.");
  }
}
