import { NextResponse, type NextRequest } from "next/server";
import { webContentSecurityPolicy } from "@flock/deployment/security-headers";
import { configuredDeskAppUrl, LOOPBACK_PATH_HEADER, resolveLoopbackRedirect } from "./lib/loopback-redirect";

/**
 * Normalizes loopback `localhost` requests to `127.0.0.1` preserving validated path & query, and gives every non-redirect
 * document response a strict Content-Security-Policy with a per-request nonce.
 * Passes `configuredDeskAppUrl()?.origin` so default local `:3005` enables loopback HTTP `connect-src` while HTTPS
 * production deployments restrict `connect-src` to `'self' https:`.
 */
export function proxy(request: NextRequest): NextResponse {
  const appUrl = configuredDeskAppUrl();
  const redirectUrl = appUrl
    ? resolveLoopbackRedirect(request.headers.get("host"), `${request.nextUrl.pathname}${request.nextUrl.search}`, appUrl)
    : null;

  // Inside Next's runtime (`NextRequestHint`, marked by `sourcePage`), forward the validated relative target so
  // RootLayout's `redirect()` emits the verbatim absolute `http://127.0.0.1:<port>` Location header.
  if (redirectUrl && !("sourcePage" in request)) {
    return NextResponse.redirect(redirectUrl, 307);
  }

  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const policy = webContentSecurityPolicy({
    nonce,
    appUrl: appUrl?.origin,
    development: process.env.NODE_ENV !== "production",
  });
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
  matcher: [{
    source: "/((?!_next/static|_next/image|favicon.ico).*)",
    missing: [{ type: "header", key: "next-router-prefetch" }, { type: "header", key: "purpose", value: "prefetch" }],
  }],
};
