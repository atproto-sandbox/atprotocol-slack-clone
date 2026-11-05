import { NextResponse, type NextRequest } from "next/server";
import { OperatorAuthError } from "@/operator/security";
import { authenticateSpaceNotification } from "@/operator/space-notification";
import { recordWriteNotification } from "@/atproto/notifications";
import { parseWriteNotification } from "@/atproto/write-notification";
import { markRepoStale } from "@/workspaces/cache";
import { readRequestJson, RequestJsonError } from "@/lib/bounded-json";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const notification = parseWriteNotification(await readRequestJson<unknown>(request, 8 * 1024));
    if (!notification) return xrpcError(400, "InvalidRequest", "Invalid space write notification.");
    await authenticateSpaceNotification(request, "com.atproto.space.notifyWrite", notification.space);
    recordWriteNotification(notification);
    markRepoStale(notification.space, notification.repo);
    return NextResponse.json({}, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Notification rejected.";
    if (error instanceof OperatorAuthError) return xrpcError(403, "Unauthorized", message);
    if (error instanceof RequestJsonError) return xrpcError(error.status, "InvalidRequest", message);
    return xrpcError(500, "InternalServerError", "Unable to record the notification.");
  }
}

function xrpcError(status: number, error: string, message: string) {
  return NextResponse.json({ error, message: message.slice(0, 500) }, { status, headers: { "cache-control": "no-store" } });
}
