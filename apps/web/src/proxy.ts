import { NextResponse, type NextRequest } from "next/server";
import { webContentSecurityPolicy } from "@flock/deployment/security-headers";

/**
 * Gives every page a Content-Security-Policy with a nonce of its own. Next reads the nonce from the request's policy and puts it
 * on the scripts it renders, so the page's own scripts run and a script injected into it does not. The policy is made per
 * request, from the environment the server runs with, not the one it was built with.
 */
export function proxy(request: NextRequest): NextResponse {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const policy = webContentSecurityPolicy({ nonce, appUrl: process.env.APP_URL, development: process.env.NODE_ENV !== "production" });
  const headers = new Headers(request.headers);
  headers.set("content-security-policy", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("content-security-policy", policy);
  return response;
}

export const config = {
  // Documents only: Next's static files and images need no policy of their own, and a prefetch renders no document.
  matcher: [{
    source: "/((?!_next/static|_next/image|favicon.ico).*)",
    missing: [{ type: "header", key: "next-router-prefetch" }, { type: "header", key: "purpose", value: "prefetch" }],
  }],
};
