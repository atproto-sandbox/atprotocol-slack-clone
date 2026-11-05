import { NextResponse, type NextRequest } from "next/server";
import { OperatorAuthError } from "@/operator/security";
import { authenticateSpaceNotification } from "@/operator/space-notification";
import { parseSpaceDeletedNotification } from "@/atproto/write-notification";
import { purgeDeletedSpace } from "@/workspaces/cache";
import { readRequestJson, RequestJsonError } from "@/lib/bounded-json";

export const runtime = "nodejs";

/**
 * The space authority says a registered space was deleted: every account's copy of it goes. Applying it twice changes nothing; the
 * registration is dropped with the copies, so a retry of an already-applied notice is refused, which loses nothing.
 */
export async function POST(request: NextRequest) {
  try {
    const notification = parseSpaceDeletedNotification(await readRequestJson<unknown>(request, 8 * 1024));
    if (!notification) return xrpcError(400, "InvalidRequest", "Invalid space deletion notification.");
    await authenticateSpaceNotification(request, "com.atproto.space.notifySpaceDeleted", notification.space);
    purgeDeletedSpace(notification.space);
    return NextResponse.json({}, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Notification rejected.";
    if (error instanceof OperatorAuthError) return xrpcError(403, "Unauthorized", message);
    if (error instanceof RequestJsonError) return xrpcError(error.status, "InvalidRequest", message);
    return xrpcError(500, "InternalServerError", "Unable to process the notification.");
  }
}

function xrpcError(status: number, error: string, message: string) {
  return NextResponse.json({ error, message: message.slice(0, 500) }, { status, headers: { "cache-control": "no-store" } });
}
