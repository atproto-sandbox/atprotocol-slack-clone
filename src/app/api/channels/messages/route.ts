import { NextResponse, type NextRequest } from "next/server";
import { requireSession } from "@/auth/session";
import { readChannelPage } from "@/workspaces/channel-sync";
import { ChannelUnavailableError } from "@/client/errors";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const session = await requireSession();
    const workspace = request.nextUrl.searchParams.get("workspace") ?? "";
    const skey = request.nextUrl.searchParams.get("skey") ?? "";
    const offset = Number(request.nextUrl.searchParams.get("offset") ?? "0");
    const page = await readChannelPage(session, workspace, skey, offset);
    return NextResponse.json(page, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to sync channel messages.";
    const status = message === "Unauthorized" ? 401 : error instanceof ChannelUnavailableError ? 409 : error && typeof error === "object" && "status" in error && typeof error.status === "number" && error.status >= 400 && error.status <= 599 ? error.status : 400;
    return NextResponse.json({ error: message.slice(0, 500) }, { status, headers: { "cache-control": "no-store" } });
  }
}
