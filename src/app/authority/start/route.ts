import { NextResponse, type NextRequest } from "next/server";
import { AUTHORITY_FLOW_PATHS, startAuthorityFlow } from "@/operator/authority-grant";
import { getConfig } from "@/lib/config";

export const runtime = "nodejs";

/** Only a real navigation may consume a ticket; a HEAD (a link preview, a prefetch) would otherwise be answered by GET. */
export function HEAD() {
  return new Response(null, { status: 405, headers: { allow: "GET" } });
}

/** A top-level navigation carrying a ticket: binds this browser to one authority flow and sends it to the PDS. */
export async function GET(request: NextRequest) {
  const { appUrl } = getConfig();
  try {
    const flow = await startAuthorityFlow(request.nextUrl.searchParams.get("ticket") ?? "");
    const response = NextResponse.redirect(flow.url);
    response.cookies.set(flow.cookieName, flow.cookieValue, {
      httpOnly: true,
      secure: appUrl.protocol === "https:",
      sameSite: "lax",
      path: AUTHORITY_FLOW_PATHS.callback,
      maxAge: 15 * 60,
    });
    return response;
  } catch {
    return NextResponse.redirect(new URL("/?authority=failed", appUrl));
  }
}
