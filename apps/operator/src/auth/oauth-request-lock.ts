import { randomUUID } from "node:crypto";
import type { RuntimeLock } from "@atproto/oauth-client-node";
import { getRawDb } from "../lib/db";

const LEASE_SECONDS = 90;
const HEARTBEAT_MS = 20_000;
const ACQUIRE_TIMEOUT_MS = 120_000;
const POLL_MS = 50;
const TRANSIENT_INFRASTRUCTURE_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "EAI_FAIL", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "SQLITE_BUSY", "SQLITE_LOCKED",
]);

export class OAuthRequestLockError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OAuthRequestLockError";
  }
}

/** Claims the lease `name` for `leaseSeconds`, unless another holder's lease on it is still running. */
export function claimLease(name: string, token: string, leaseSeconds: number, now = unixNow()): boolean {
  const result = getRawDb().prepare(`
    INSERT INTO oauth_request_lock (name, token, expires_at) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at
    WHERE oauth_request_lock.expires_at <= ?
  `).run(name, token, now + leaseSeconds, now);
  return result.changes === 1;
}

export function isTransientOAuthInfrastructureError(error: unknown): boolean {
  const seen = new Set<object>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (current instanceof OAuthRequestLockError) return true;
    if ("status" in current && typeof current.status === "number" &&
        ([408, 425, 429].includes(current.status) || (current.status >= 500 && current.status <= 599))) return true;
    if ("code" in current && typeof current.code === "string" && TRANSIENT_INFRASTRUCTURE_CODES.has(current.code)) return true;
    if ("name" in current && (current.name === "TimeoutError" || current.name === "AbortError")) return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

/**
 * OAuth refresh tokens are single-use. This lease is stored in the same SQLite
 * database as the encrypted OAuth session so web workers and the reconciler
 * serialize refreshes for a DID across processes.
 */
export const oauthSqliteRequestLock: RuntimeLock = async <T>(name: string, action: () => T | PromiseLike<T>): Promise<T> => {
  const token = randomUUID();
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  while (true) {
    try {
      if (tryAcquire(name, token)) break;
    } catch (cause) {
      throw new OAuthRequestLockError("OAuth session request lock could not be acquired.", { cause });
    }
    if (Date.now() >= deadline) throw new OAuthRequestLockError("OAuth session request lock could not be acquired before the timeout.");
    await delay(POLL_MS);
  }

  let lockLost = false;
  const heartbeat = setInterval(() => {
    try {
      if (!refresh(name, token)) lockLost = true;
    } catch {
      lockLost = true;
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  try {
    const result = await action();
    if (lockLost) throw new OAuthRequestLockError("OAuth session request lock was lost.");
    try {
      if (!refresh(name, token)) throw new OAuthRequestLockError("OAuth session request lock was lost.");
    } catch (cause) {
      if (cause instanceof OAuthRequestLockError) throw cause;
      throw new OAuthRequestLockError("OAuth session request lock could not be refreshed.", { cause });
    }
    return result;
  } finally {
    clearInterval(heartbeat);
    try { release(name, token); }
    catch { /* An abandoned lease expires; do not replace the refresh result. */ }
  }
};

function tryAcquire(name: string, token: string): boolean {
  return claimLease(name, token, LEASE_SECONDS);
}

function refresh(name: string, token: string): boolean {
  const result = getRawDb().prepare("UPDATE oauth_request_lock SET expires_at = ? WHERE name = ? AND token = ?")
    .run(unixNow() + LEASE_SECONDS, name, token);
  return result.changes === 1;
}

function release(name: string, token: string): void {
  getRawDb().prepare("DELETE FROM oauth_request_lock WHERE name = ? AND token = ?").run(name, token);
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
