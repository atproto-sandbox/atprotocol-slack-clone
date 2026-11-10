import { NextResponse, type NextRequest } from "next/server";
import { getOAuthClientForState } from "@/auth/oauth";
import { releaseOAuthPermissionFlowLock } from "@/auth/oauth-request-lock";
import { assertOAuthFlowAppState, oauthFlowCookieName, readOAuthFlowCookieValue } from "@/auth/oauth-flow";
import { getSession } from "@/auth/session";
import { createWebSession, WEB_SESSION_COOKIE } from "@/auth/web-session";
import { getConfig } from "@/lib/config";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const { appUrl, encryptionKey } = getConfig();
  const state = request.nextUrl.searchParams.get("state") ?? "";
  const cookieName = oauthFlowCookieName(state);
  const expireFlowCookie = (response: NextResponse): NextResponse => {
    response.cookies.set(cookieName, "", {
      httpOnly: true,
      secure: appUrl.protocol === "https:",
      sameSite: "lax",
      path: "/oauth/callback",
      maxAge: 0,
    });
    return response;
  };
  let permissionLock: { did: string; token: string } | undefined;
  try {
    const binding = readOAuthFlowCookieValue(state, request.cookies.get(cookieName)?.value, encryptionKey);
    if (!binding) throw new Error("OAuth callback is not bound to this browser.");
    if (binding.kind === "permission") permissionLock = { did: binding.expectedDid, token: binding.flowLockToken };
    const oauthClient = await getOAuthClientForState(state, binding.appState);
    const { session, state: appState } = await oauthClient.callback(request.nextUrl.searchParams);
    assertOAuthFlowAppState(binding, appState);
    if (binding.kind === "permission") {
      const currentSession = await getSession();
      if (session.did !== binding.expectedDid || currentSession?.did !== binding.expectedDid) {
        throw new Error("Permission reauthorization changed the signed-in account.");
      }
      return expireFlowCookie(NextResponse.redirect(appUrl));
    }
    if (binding.kind !== "login") throw new Error("This callback completes only sign-in and permission flows.");
    const token = await createWebSession(session.did);
    const response = NextResponse.redirect(appUrl);
    response.cookies.set(WEB_SESSION_COOKIE, token, {
      httpOnly: true,
      secure: appUrl.protocol === "https:",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    expireFlowCookie(response);
    return response;
  } catch {
    return expireFlowCookie(NextResponse.redirect(new URL("/?error=login", appUrl)));
  } finally {
    if (permissionLock) {
      try { releaseOAuthPermissionFlowLock(permissionLock.did, permissionLock.token); }
      catch { /* The bounded lease expires if cleanup encounters a database error. */ }
    }
  }
}
