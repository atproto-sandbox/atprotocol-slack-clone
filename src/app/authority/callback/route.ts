import { NextResponse, type NextRequest } from "next/server";
import { oauthFlowCookieName } from "@/auth/oauth-flow";
import { AUTHORITY_FLOW_PATHS, completeAuthorityFlow } from "@/operator/authority-grant";
import { getConfig } from "@/lib/config";

export const runtime = "nodejs";

/** The PDS returns here. Only a result code goes back to the web app; the grant stays with the operator. */
export async function GET(request: NextRequest) {
  const { appUrl } = getConfig();
  const cookieName = oauthFlowCookieName(request.nextUrl.searchParams.get("state") ?? "");
  let response: NextResponse;
  try {
    await completeAuthorityFlow(request.nextUrl.searchParams, request.cookies.get(cookieName)?.value);
    response = NextResponse.redirect(appUrl);
  } catch {
    response = NextResponse.redirect(new URL("/?authority=failed", appUrl));
  }
  response.cookies.set(cookieName, "", {
    httpOnly: true,
    secure: appUrl.protocol === "https:",
    sameSite: "lax",
    path: AUTHORITY_FLOW_PATHS.callback,
    maxAge: 0,
  });
  return response;
}
