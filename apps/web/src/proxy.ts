import { NextResponse, type NextRequest } from "next/server";
import { webContentSecurityPolicy } from "@flock/deployment/security-headers";
import { configuredAppUrl, LOOPBACK_PATH_HEADER, resolveLoopbackRedirect } from "./lib/loopback-redirect";

/**
 * Normalizes loopback `localhost` requests to `127.0.0.1` preserving validated path & query, and gives every non-redirect
 * page response a Content-Security-Policy with a per-request nonce so Next's own scripts run while injected scripts do not.
 */
export function proxy(request: NextRequest): NextResponse {
  const appUrl = configuredAppUrl();
  const redirectUrl = appUrl
    ? resolveLoopbackRedirect(request.headers.get("host"), `${request.nextUrl.pathname}${request.nextUrl.search}`, appUrl)
    : null;

  // Next's middleware runtime (`resolve-routes.js` + `adapter.js`) constructs `initUrl` from `--hostname` rather than
  // `Host`, so when `next start --hostname 127.0.0.1` serves a `localhost` request it strips `http://127.0.0.1:<port>`
  // off a middleware `307` Location header. Direct calls return `NextResponse.redirect(redirectUrl, 307)`; inside
  // Next's server runtime (`NextRequestHint`, marked by `sourcePage`) forward the validated relative target so RootLayout's
  // `redirect()` emits the verbatim absolute `http://127.0.0.1:<port>` Location header (`app-render.js`).
  if (redirectUrl && !("sourcePage" in request)) {
    return NextResponse.redirect(redirectUrl, 307);
  }

  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const policy = webContentSecurityPolicy({ nonce, appUrl: process.env.APP_URL, development: process.env.NODE_ENV !== "production" });
  const headers = new Headers(request.headers);
  headers.set("content-security-policy", policy);
  if (redirectUrl) {
    headers.set(LOOPBACK_PATH_HEADER, `${redirectUrl.pathname}${redirectUrl.search}`);
  } else {
    headers.delete(LOOPBACK_PATH_HEADER);
  }
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
