import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const ADMIN_SESSION_TTL_MS = 30 * 60_000;
export const ADMIN_FLOW_TTL_MS = 10 * 60_000;
export const SESSION_COOKIE_NAME = "webhooks_admin";

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type AdminSessionPayload = {
  did: string;
  csrf: string;
  exp: number;
};

export type AdminFlowPayload = {
  appState: string;
  exp: number;
};

export function createProcessCookieKey(): Buffer {
  return randomBytes(32);
}

export function flowCookieName(state: string): string {
  return `webhooks_oauth_${createHash("sha256").update(state, "utf8").digest("hex").slice(0, 32)}`;
}

export function parseCookieHeader(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name && !cookies.has(name)) cookies.set(name, value);
  }
  return cookies;
}

export function serializeAdminCookie(
  name: string,
  value: string,
  options: { maxAgeSeconds: number; secure: boolean },
): string {
  const attributes = [
    `${name}=${value}`,
    "Path=/admin",
    `Max-Age=${options.maxAgeSeconds}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(options.secure ? ["Secure"] : []),
  ];
  return attributes.join("; ");
}

export function clearAdminCookie(name: string, secure: boolean): string {
  return serializeAdminCookie(name, "", { maxAgeSeconds: 0, secure });
}

export function signFlowCookie(
  state: string,
  appState: string,
  key: Buffer,
  now = Date.now(),
  ttlMs = ADMIN_FLOW_TTL_MS,
): string {
  const payload: AdminFlowPayload = { appState, exp: now + ttlMs };
  return signPayload(`flow:${state}`, payload, key);
}

export function verifyFlowCookie(
  state: string,
  cookieValue: string | undefined,
  key: Buffer,
  now = Date.now(),
): AdminFlowPayload | null {
  const parsed = verifyPayload<AdminFlowPayload>(`flow:${state}`, cookieValue, key);
  if (!parsed || typeof parsed.appState !== "string" || !Number.isSafeInteger(parsed.exp) || parsed.exp <= now) {
    return null;
  }
  return parsed;
}

export function signSessionCookie(
  did: string,
  key: Buffer,
  now = Date.now(),
  ttlMs = ADMIN_SESSION_TTL_MS,
): { cookieValue: string; session: AdminSessionPayload } {
  const session: AdminSessionPayload = {
    did,
    csrf: randomBytes(32).toString("base64url"),
    exp: now + ttlMs,
  };
  return { cookieValue: signPayload("session", session, key), session };
}

export function verifySessionCookie(
  cookieValue: string | undefined,
  key: Buffer,
  now = Date.now(),
): AdminSessionPayload | null {
  const parsed = verifyPayload<AdminSessionPayload>("session", cookieValue, key);
  if (
    !parsed ||
    typeof parsed.did !== "string" ||
    !parsed.did.startsWith("did:") ||
    typeof parsed.csrf !== "string" ||
    !BASE64URL_PATTERN.test(parsed.csrf) ||
    !Number.isSafeInteger(parsed.exp) ||
    parsed.exp <= now
  ) {
    return null;
  }
  return parsed;
}

export function verifyCsrfToken(expectedCsrf: string, submitted: string | undefined): boolean {
  if (!submitted || !BASE64URL_PATTERN.test(submitted)) return false;
  const left = createHash("sha256").update(expectedCsrf, "utf8").digest();
  const right = createHash("sha256").update(submitted, "utf8").digest();
  return timingSafeEqual(left, right);
}

function signPayload(domain: string, payload: unknown, key: Buffer): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = hmac(domain, encoded, key);
  return `${encoded}.${signature}`;
}

function verifyPayload<T>(domain: string, value: string | undefined, key: Buffer): T | null {
  if (!value) return null;
  const [encoded, signature, extra] = value.split(".");
  if (extra !== undefined || !encoded || !signature || !BASE64URL_PATTERN.test(encoded) || !SIGNATURE_PATTERN.test(signature)) {
    return null;
  }
  const expected = Buffer.from(hmac(domain, encoded, key), "utf8");
  const actual = Buffer.from(signature, "utf8");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
}

function hmac(domain: string, encoded: string, key: Buffer): string {
  return createHmac("sha256", key).update(domain).update("\0").update(encoded).digest("base64url");
}
