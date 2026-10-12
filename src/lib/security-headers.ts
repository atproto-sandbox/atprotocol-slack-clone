export function securityHeaderRule() {
  return {
    source: "/:path*",
    headers: [
      {
        key: "Content-Security-Policy",
        value: `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob:; font-src 'self' data: https://fonts.gstatic.com; ${connectSrc()}`,
      },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Strict-Transport-Security", value: "max-age=31536000" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    ],
  };
}

// The browser DM session (M3) talks to PDS and PLC hosts directly, so
// connect-src must allow any HTTPS host. Loopback development additionally
// needs the HTTP loopback origins, mirroring the loopback check in
// src/lib/config.ts (APP_URL is HTTPS everywhere else, so this is exact).
function connectSrc(): string {
  const raw = process.env.APP_URL ?? "http://127.0.0.1:3000";
  let loopbackHttp = false;
  try {
    const url = new URL(raw);
    loopbackHttp = url.protocol === "http:" && isLoopbackHostname(url.hostname);
  } catch {
    loopbackHttp = false;
  }
  return loopbackHttp ? "connect-src 'self' https: http://localhost:* http://127.0.0.1:*" : "connect-src 'self' https:";
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}
