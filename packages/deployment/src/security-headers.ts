import { isLoopback } from "./config";

/** The headers every response of the web app and the operator carries, beside each one's own Content-Security-Policy. */
const COMMON_SECURITY_HEADERS = [
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=31536000" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
] as const;

/**
 * The web app's fixed headers, on every route. Its Content-Security-Policy is not among them: it carries a nonce made for each
 * request, so the web app's proxy sets it (`webContentSecurityPolicy`).
 */
export function securityHeaderRule() {
  return { source: "/:path*", headers: [...COMMON_SECURITY_HEADERS] };
}

/**
 * The web app's Content-Security-Policy for one request. A script runs only under that request's nonce, which Next gives the
 * scripts it renders, or when such a script loads it (`'strict-dynamic'`); nothing inline runs without the nonce. The browser
 * holds the member's grant and synced history, so a script injected into a page must not run. `'unsafe-eval'` is added in
 * development only, for the dev server. Styles keep `'unsafe-inline'`.
 */
export function webContentSecurityPolicy(input: { nonce: string; appUrl: string | undefined; development: boolean }): string {
  const scriptSrc = `script-src 'self' 'nonce-${input.nonce}' 'strict-dynamic'${input.development ? " 'unsafe-eval'" : ""}`;
  return `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; ${scriptSrc}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob:; font-src 'self' data: https://fonts.gstatic.com; ${connectSrc(input.appUrl)}`;
}

/** The operator's headers: it answers with JSON and redirects only, so its documents may load nothing and be framed nowhere. */
export const OPERATOR_SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: "default-src 'none'; frame-ancestors 'none'" },
  ...COMMON_SECURITY_HEADERS,
] as const;

// The browser session (sign-in, the engine and DMs) talks to PDS, PLC and handle hosts directly, so connect-src must allow
// any HTTPS host. Loopback development additionally needs the HTTP loopback origins, by the configuration's own loopback rule
// (APP_URL is HTTPS everywhere else, so this is exact). With no APP_URL nothing is assumed, and no loopback origin is allowed.
// A CSP source cannot name an IPv6 literal, so `[::1]` is not listed: browsers ignore such a source and report it as invalid.
function connectSrc(appUrl: string | undefined): string {
  let loopbackHttp = false;
  try {
    const url = new URL(appUrl ?? "");
    loopbackHttp = url.protocol === "http:" && isLoopback(url.hostname);
  } catch {
    loopbackHttp = false;
  }
  return loopbackHttp ? "connect-src 'self' https: http://localhost:* http://127.0.0.1:*" : "connect-src 'self' https:";
}
