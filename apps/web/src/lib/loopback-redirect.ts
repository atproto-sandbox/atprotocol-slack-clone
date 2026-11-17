import { isLoopback } from "@flock/deployment/config";

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const SAFE_RELATIVE_PATH = /^\/(?![\/\\])/;

export const LOOPBACK_PATH_HEADER = "x-flock-loopback-path";

/** Resolves the configured HTTP/HTTPS canonical app URL, normalizing loopback `localhost` -> `127.0.0.1`. */
export function configuredAppUrl(): URL | null {
  const raw = process.env.APP_URL ?? (process.env.OPERATOR_SERVICE_REF ? "http://127.0.0.1:3000" : undefined);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol === "http:" && isLoopback(url.hostname) && url.hostname.toLowerCase() === "localhost") {
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
  appUrl: URL | null = configuredAppUrl(),
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
