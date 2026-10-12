import { NextResponse, type NextRequest } from "next/server";
import { requireSession } from "@/auth/session";
import { authorizeDmSubscription } from "@/lib/dm-subscription";
import { getRawDb } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 35;

// Content-free DM change stream. Inbox streams are owner-only; a conversation
// half is guarded by its random `convKey`. Events carry only a monotonic
// cursor, so this endpoint reveals change timing and nothing else: it never
// reads records, never mints credentials, and never touches DM content.
export async function GET(request: NextRequest) {
  try {
    const session = await requireSession();
    const requested = request.nextUrl.searchParams.get("space") ?? "";
    const decision = authorizeDmSubscription(requested, session.did);
    if (!decision.allowed) return NextResponse.json({ error: decision.reason }, { status: decision.status });
    const space = decision.space;
    const headerCursor = request.headers.get("last-event-id");
    const queryCursor = request.nextUrl.searchParams.get("after") ?? "0";
    const cursorText = headerCursor || queryCursor;
    let cursor = Number(cursorText);
    if (!Number.isSafeInteger(cursor) || cursor < 0) return NextResponse.json({ error: "Invalid notification cursor." }, { status: 400 });

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        const deadline = Date.now() + 30_000;
        let open = true;
        const close = () => {
          if (!open) return;
          open = false;
          try { controller.close(); } catch { /* The client disconnected. */ }
        };
        request.signal.addEventListener("abort", close, { once: true });
        const poll = async () => {
          while (open && !request.signal.aborted && Date.now() < deadline) {
            const row = getRawDb().prepare("SELECT COALESCE(MAX(id),0) AS cursor, SUM(CASE WHEN id > ? THEN 1 ELSE 0 END) AS changed FROM space_notification WHERE space_uri=?")
              .get(cursor, space) as { cursor: number; changed: number | null };
            if ((row.changed ?? 0) > 0) {
              cursor = row.cursor;
              controller.enqueue(encoder.encode(`id: ${cursor}\nevent: change\ndata: {"cursor":${cursor}}\n\n`));
            } else {
              controller.enqueue(encoder.encode(": keepalive\n\n"));
            }
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          }
          close();
        };
        void poll().catch(close);
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to open notification stream.";
    const status = message === "Unauthorized" ? 401 : error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : 400;
    if (request.headers.get("accept")?.includes("text/event-stream") && (status === 401 || status === 403)) {
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }
    return NextResponse.json({ error: message.slice(0, 500) }, { status });
  }
}
