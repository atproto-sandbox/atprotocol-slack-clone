const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const SAFE_RELATIVE_PATH = /^\/(?![\/\\])/;

export const LOOPBACK_PATH_HEADER = "x-flock-desk-loopback-path";

/**
 * Resolves the configured HTTP/HTTPS canonical Desk app URL using exact precedence
 * `DESK_APP_URL ?? APP_URL` (falling back to `"http://127.0.0.1:3005"` only outside production
 * so a misconfigured production deploy never 307-redirects visitors to loopback).
 * Normalizes loopback `localhost` -> `127.0.0.1`.
 */
export function configuredDeskAppUrl(): URL | null {
  const raw =
    process.env.DESK_APP_URL ??
    process.env.APP_URL ??
    (process.env.NODE_ENV !== "production" ? "http://127.0.0.1:3005" : undefined);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.protocol === "http:" && url.hostname.toLowerCase() === "localhost") {
      url.hostname = "127.0.0.1";
    }
    return url;
  } catch {
    return null;
  }
}

/**
 * Validates `rawPathAndQuery` as a safe same-origin relative target and returns the canonical loopback `URL` when
 * `appUrl` is HTTP and `requestHost` differs from `appUrl.host`.
 */
export function resolveLoopbackRedirect(
  requestHost: string | null,
  rawPathAndQuery: string,
  appUrl: URL | null = configuredDeskAppUrl(),
): URL | null {
  if (!appUrl || appUrl.protocol !== "http:") return null;
  if (!requestHost || requestHost.toLowerCase() === appUrl.host.toLowerCase()) return null;

  const safePathAndQuery = !CONTROL_CHARS.test(rawPathAndQuery) && SAFE_RELATIVE_PATH.test(rawPathAndQuery)
    ? rawPathAndQuery
    : "/";
  const redirectUrl = new URL(safePathAndQuery, appUrl.origin);
  if (redirectUrl.origin !== appUrl.origin) {
    return new URL("/", appUrl.origin);
  }
  return redirectUrl;
}
