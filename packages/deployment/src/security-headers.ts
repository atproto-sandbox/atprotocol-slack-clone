import { isLoopback } from "./config";

/** The headers every response of the web app and the operator carries, beside each one's own Content-Security-Policy. */
const COMMON_SECURITY_HEADERS = [
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=31536000" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
] as const;

export function securityHeaderRule() {
  return {
    source: "/:path*",
    headers: [
      {
        key: "Content-Security-Policy",
        value: `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob:; font-src 'self' data: https://fonts.gstatic.com; ${connectSrc()}`,
      },
      ...COMMON_SECURITY_HEADERS,
    ],
  };
}

/** The operator's headers: it answers with JSON and redirects only, so its documents may load nothing and be framed nowhere. */
export const OPERATOR_SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: "default-src 'none'; frame-ancestors 'none'" },
  ...COMMON_SECURITY_HEADERS,
] as const;

// The browser session (sign-in, the engine and DMs) talks to PDS, PLC and handle hosts directly, so
// connect-src must allow any HTTPS host. Loopback development additionally
// needs the HTTP loopback origins, by the configuration's own loopback rule
// (APP_URL is HTTPS everywhere else, so this is exact).
function connectSrc(): string {
  const raw = process.env.APP_URL ?? "http://127.0.0.1:3000";
  let loopbackHttp = false;
  try {
    const url = new URL(raw);
    loopbackHttp = url.protocol === "http:" && isLoopback(url.hostname);
  } catch {
    loopbackHttp = false;
  }
  return loopbackHttp ? "connect-src 'self' https: http://localhost:* http://127.0.0.1:* http://[::1]:*" : "connect-src 'self' https:";
}
