import { NextResponse, type NextRequest } from "next/server";
import { getOAuthClient } from "@/auth/oauth";
import { oauthFlowCookieName, startOAuthFlow } from "@/auth/oauth-flow";
import { MEMBER_SIGN_IN_SCOPES } from "@/auth/permission-sets";
import { canonicalOAuthScope } from "@/auth/oauth-scope";
import { classifyOAuthRouteError } from "@/auth/oauth-route-error";
import { getConfig } from "@/lib/config";
import { readRequestJson, RequestJsonError } from "@/lib/bounded-json";
import { rejectCrossOriginMutation } from "@/lib/same-origin-mutation";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const rejected = rejectCrossOriginMutation(request);
  if (rejected) return rejected;
  try {
    const body = await readRequestJson<{ handle?: unknown }>(request, 8 * 1024);
    if (typeof body.handle !== "string" || !body.handle.trim()) {
      return NextResponse.json({ error: "Enter your AT Protocol handle." }, { status: 400 });
    }
    const handle = body.handle.trim().replace(/^@/, "");
    const { appUrl, encryptionKey } = getConfig();
    const clientScope = canonicalOAuthScope(["atproto", ...MEMBER_SIGN_IN_SCOPES]);
    const flow = await startOAuthFlow(getOAuthClient(clientScope), handle, { scope: clientScope }, { kind: "login", clientScope }, encryptionKey);
    const response = NextResponse.json({ redirectUrl: flow.url.toString() });
    response.cookies.set(oauthFlowCookieName(flow.state), flow.cookieValue, {
      httpOnly: true,
      secure: appUrl.protocol === "https:",
      sameSite: "lax",
      path: "/oauth/callback",
      maxAge: 15 * 60,
    });
    return response;
  } catch (error) {
    if (error instanceof RequestJsonError) return NextResponse.json({ error: error.message }, { status: error.status });
    const details = classifyOAuthRouteError(error, "Unable to start sign in.");
    return NextResponse.json({ error: details.message }, {
      status: details.status,
      ...(details.retryAfterSeconds ? { headers: { "retry-after": String(details.retryAfterSeconds) } } : {}),
    });
  }
}
