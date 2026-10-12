import { NextResponse, type NextRequest } from "next/server";
import { authenticateOperatorRequest, OperatorAuthError } from "@/operator/security";
import { parseSpaceAuthority } from "@/atproto/notifications";
import { parseWriteNotification } from "@/atproto/write-notification";
import { markRepoStale } from "@/workspaces/cache";
import { getRawDb } from "@/lib/db";
import { readRequestJson, RequestJsonError } from "@/lib/bounded-json";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const issuer = await authenticateOperatorRequest(request, "com.atproto.space.notifyWrite");
    const notification = parseWriteNotification(await readRequestJson<unknown>(request, 8 * 1024));
    if (!notification) return xrpcError(400, "InvalidRequest", "Invalid space write notification.");
    const authorityDid = parseSpaceAuthority(notification.space);
    if (issuer !== authorityDid) return xrpcError(403, "Unauthorized", "Notification issuer is not the space authority.");
    const now = Math.floor(Date.now() / 1000);
    const db = getRawDb();
    db.prepare("INSERT INTO space_notification (space_uri,repo_did,rev,notified_at) VALUES (?,?,?,?)")
      .run(notification.space, notification.repo, notification.rev, now);
    markRepoStale(notification.space, notification.repo);
    db.prepare("DELETE FROM space_notification WHERE notified_at < ?").run(now - 7 * 24 * 60 * 60);
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
