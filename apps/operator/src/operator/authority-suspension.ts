import { isAuthoritySuspendedError } from "@flock/protocol/atproto/repo-failure";
import { isAccountSuspendedError, XrpcError } from "@flock/protocol/atproto/xrpc";

/** Backoff window for an authority-wide suspension circuit breaker (`AccountTakedown` / `AccountDeactivated` / `RepoTakendown` / `RepoDeactivated`). */
export const AUTHORITY_SUSPENDED_BACKOFF_MS = 15_000;
const AUTHORITY_HEALTHY_TTL_MS = 60_000;

export class AuthoritySuspensionUnavailableError extends Error {
  constructor(message = "Could not verify workspace authority account status.", options?: ErrorOptions) {
    super(message, options);
    this.name = "AuthoritySuspensionUnavailableError";
  }
}

export function isSuspensionError(error: unknown): boolean {
  return isAccountSuspendedError(error)
    || isAuthoritySuspendedError(error)
    || (error instanceof XrpcError && error.code === "RepoSuspended")
    || error instanceof AuthoritySuspensionUnavailableError;
}

type AuthorityBreakerEntry = {
  suspendedAt?: number;
  suspendedUntil?: number;
  suspensionError?: Error;
  healthyAt?: number;
  healthyUntil?: number;
  probeInFlight?: Promise<void>;
};

const breakerByAuthority = new Map<string, AuthorityBreakerEntry>();

function normalizeClock(entry: AuthorityBreakerEntry, now: number): void {
  if (entry.suspendedAt !== undefined && now < entry.suspendedAt) {
    entry.suspendedAt = undefined;
    entry.suspendedUntil = undefined;
    entry.suspensionError = undefined;
  }
  if (entry.healthyAt !== undefined && now < entry.healthyAt) {
    entry.healthyAt = undefined;
    entry.healthyUntil = undefined;
  }
}

function isActivelySuspended(entry: AuthorityBreakerEntry | undefined, now: number): boolean {
  if (!entry) return false;
  normalizeClock(entry, now);
  return entry.suspendedAt !== undefined
    && entry.suspendedUntil !== undefined
    && now >= entry.suspendedAt
    && now < entry.suspendedUntil;
}

function isActivelyHealthy(entry: AuthorityBreakerEntry | undefined, now: number): boolean {
  if (!entry) return false;
  normalizeClock(entry, now);
  return entry.healthyAt !== undefined
    && entry.healthyUntil !== undefined
    && now >= entry.healthyAt
    && now < entry.healthyUntil;
}

function ensureEntry(authorityDid: string): AuthorityBreakerEntry {
  let entry = breakerByAuthority.get(authorityDid);
  if (!entry) {
    entry = {};
    breakerByAuthority.set(authorityDid, entry);
  }
  return entry;
}

export function isAuthoritySuspended(authorityDid: string, now = Date.now()): boolean {
  return isActivelySuspended(breakerByAuthority.get(authorityDid), now);
}

export function getAuthoritySuspensionError(authorityDid: string, now = Date.now()): Error | undefined {
  const entry = breakerByAuthority.get(authorityDid);
  if (!isActivelySuspended(entry, now)) return undefined;
  return entry?.suspensionError;
}

export function tripAuthoritySuspension(authorityDid: string, error: unknown, now = Date.now()): Error {
  const normalized = error instanceof Error && isSuspensionError(error)
    ? error
    : new XrpcError(401, "The workspace authority account is currently suspended or deactivated.", "AccountTakedown");
  const entry = ensureEntry(authorityDid);
  entry.suspendedAt = now;
  entry.suspendedUntil = now + AUTHORITY_SUSPENDED_BACKOFF_MS;
  entry.suspensionError = normalized;
  entry.healthyAt = undefined;
  entry.healthyUntil = undefined;
  return normalized;
}

export function markAuthorityHealthy(authorityDid: string, now = Date.now()): void {
  const entry = ensureEntry(authorityDid);
  entry.suspendedAt = undefined;
  entry.suspendedUntil = undefined;
  entry.suspensionError = undefined;
  entry.healthyAt = now;
  entry.healthyUntil = now + AUTHORITY_HEALTHY_TTL_MS;
}

export function invalidateAuthorityHealth(authorityDid: string): void {
  const entry = breakerByAuthority.get(authorityDid);
  if (!entry) return;
  entry.healthyAt = undefined;
  entry.healthyUntil = undefined;
}

/**
 * Gates concurrent requests for `authorityDid` through the authority suspension circuit breaker:
 * - Immediately throws the cached suspension error while within the 15s backoff window (0 PDS calls).
 * - Uses a single-flight probe when cold or releasing after backoff so a 200-space fan-out makes at most 1 PDS call
 *   when the authority is suspended, while running at full concurrency once 1 probe confirms the authority is active.
 */
export async function runThroughAuthorityBreaker<T>(
  authorityDid: string,
  nowFn: () => number,
  action: () => Promise<T>,
): Promise<T> {
  while (true) {
    const existing = breakerByAuthority.get(authorityDid);
    const now = nowFn();
    if (isActivelyHealthy(existing, now) || !existing?.probeInFlight) break;
    await existing.probeInFlight;
  }

  const now = nowFn();
  const suspendedErr = getAuthoritySuspensionError(authorityDid, now);
  if (suspendedErr) throw suspendedErr;

  const entry = ensureEntry(authorityDid);
  if (isActivelyHealthy(entry, now)) {
    try {
      const result = await action();
      markAuthorityHealthy(authorityDid, nowFn());
      return result;
    } catch (error) {
      if (isSuspensionError(error)) {
        tripAuthoritySuspension(authorityDid, error, nowFn());
      }
      throw error;
    }
  }

  let resolveProbe!: () => void;
  const probePromise = new Promise<void>((resolve) => {
    resolveProbe = resolve;
  });
  entry.probeInFlight = probePromise;
  try {
    const result = await action();
    markAuthorityHealthy(authorityDid, nowFn());
    return result;
  } catch (error) {
    const afterNow = nowFn();
    if (isSuspensionError(error)) {
      tripAuthoritySuspension(authorityDid, error, afterNow);
    } else if (entry.suspendedUntil !== undefined && afterNow >= entry.suspendedUntil) {
      entry.suspendedAt = undefined;
      entry.suspendedUntil = undefined;
      entry.suspensionError = undefined;
    }
    throw error;
  } finally {
    if (entry.probeInFlight === probePromise) {
      entry.probeInFlight = undefined;
    }
    resolveProbe();
  }
}

export function resetAuthoritySuspensionForTests(): void {
  breakerByAuthority.clear();
}
