export const RETURN_TO_KEY = "spaces.returnTo";

const TRANSIENT_QUERY_PARAMS = new Set(["invite", "signout", "authority"]);
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const SAFE_RELATIVE_PATH = /^\/(?![\/\\])/;

/**
 * Validates a relative post-login redirect target so open redirects (`//`, `https://`, `\`, control chars) and OAuth
 * loop targets (`/oauth`, `/oauth/...`) are always rejected. Returns normalized `pathname + search` or `null`.
 */
export function validateReturnTo(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (CONTROL_CHARS.test(raw) || raw.includes("\\")) return null;
  if (!SAFE_RELATIVE_PATH.test(raw)) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw, "https://local.invalid");
  } catch {
    return null;
  }
  if (parsed.origin !== "https://local.invalid") return null;
  if (!SAFE_RELATIVE_PATH.test(parsed.pathname) || parsed.pathname.includes("\\")) return null;

  const lowerPath = parsed.pathname.toLowerCase();
  if (lowerPath === "/oauth" || lowerPath.startsWith("/oauth/")) return null;

  return `${parsed.pathname}${parsed.search}`;
}

/** Strips transient sign-out/invite/authority query flags and returns a validated relative target, or `null`. */
export function sanitizeReturnTo(pathname: string, search = ""): string | null {
  const params = new URLSearchParams(search);
  for (const key of TRANSIENT_QUERY_PARAMS) params.delete(key);
  const query = params.toString();
  return validateReturnTo(query ? `${pathname}?${query}` : pathname);
}

/** Stores a validated deep return target in sessionStorage, or clears any stale one when at root `/`. */
export function captureReturnTo(
  pathname: string,
  search: string,
  storage: Pick<Storage, "setItem" | "removeItem">,
): string | null {
  const target = sanitizeReturnTo(pathname, search);
  if (target && target !== "/") {
    storage.setItem(RETURN_TO_KEY, target);
    return target;
  }
  storage.removeItem(RETURN_TO_KEY);
  return null;
}

/** Single-use consumption of a stored `returnTo` path on OAuth callback completion, defaulting to `"/"`. */
export function consumeReturnTo(storage: Pick<Storage, "getItem" | "removeItem">): string {
  const raw = storage.getItem(RETURN_TO_KEY);
  storage.removeItem(RETURN_TO_KEY);
  return validateReturnTo(raw) ?? "/";
}
