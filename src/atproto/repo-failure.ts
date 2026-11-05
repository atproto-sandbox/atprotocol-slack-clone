import { UpstreamResponseTooLargeError } from "@/lib/bounded-json";
import { KemKeyError, isUnverifiableRepo } from "./kem-key";
import { XrpcError } from "./xrpc";

/** How many set-aside writers a response names; the rest are summarized, so a space full of failing writers cannot flood a reply. */
export const MAX_LISTED_SET_ASIDE = 20;

export type RepoFailure = {
  /** Safe to show a user: it never repeats text the repo's host chose. */
  reason: string;
  /**
   * The repo will not become readable by asking again: its account is deactivated, taken down or gone, its records cannot be
   * authenticated, or its answers are larger than this app reads. Whatever was cached from it must stop being served, and a
   * journaled operation that depends on it can be rejected instead of retried. A host that is down or misbehaving is not
   * permanent: it may recover, so a cached copy stays.
   */
  permanent: boolean;
};

const ACCOUNT_STATE: Readonly<Record<string, string>> = {
  RepoDeactivated: "its account is deactivated",
  RepoTakendown: "its account was taken down",
  RepoSuspended: "its account is suspended",
  RepoNotFound: "its host has no repo for it",
};

/**
 * Classifies a failure to read one writer's repo, so that a single member's account state or host cannot make a space unreadable
 * for everyone else. The pinned PDS answers a read of a deactivated or taken-down account with 400 `RepoDeactivated` or
 * `RepoTakendown` even though the space authority still issues credentials for it, and a member-run host can be down, slow,
 * oversized or malformed.
 *
 * Returns `null` for a failure that is this app's own and must not be hidden behind a writer: a store (SQLite) error. A
 * credential refusal while reading a writer's repo is that host's answer about that repo; whether the *reader* lost access to
 * the space is decided where the credential is minted, so it is classified here as a host failure.
 */
export function classifyRepoFailure(error: unknown): RepoFailure | null {
  if (isStoreFailure(error)) return null;
  if (isUnverifiableRepo(error)) {
    // The error text can quote the writer's own DID document, so the reason is fixed.
    return { reason: error instanceof KemKeyError ? "it publishes no usable #atproto_kem key" : "its records could not be authenticated", permanent: true };
  }
  if (error instanceof UpstreamResponseTooLargeError) return { reason: "its answer is larger than this app reads", permanent: true };
  if (error instanceof XrpcError) {
    const accountState = ACCOUNT_STATE[error.code];
    if (accountState) return { reason: accountState, permanent: true };
    return { reason: `its host answered HTTP ${error.status}`, permanent: false };
  }
  return { reason: "its host could not be read", permanent: false };
}

/**
 * What an operator can read about a failure that was set aside: the error's class, HTTP status and code, never its message (which a
 * host may have written). Anything unexpected that was blamed on a writer shows up here instead of vanishing.
 */
export function describeRepoFailure(error: unknown): string {
  if (typeof error !== "object" || error === null) return typeof error;
  const { name, status, code } = error as { name?: unknown; status?: unknown; code?: unknown };
  return [safeToken(name) ?? "Error", typeof status === "number" ? status : undefined, safeToken(code)].filter(Boolean).join(" ");
}

/** An XRPC error name's shape, and nothing a host could use to forge or flood a log line: `code` is the host's own text. */
function safeToken(value: unknown): string | undefined {
  return typeof value === "string" ? (/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) ? value : "(unrecognized)") : undefined;
}

function isStoreFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && error.code.startsWith("SQLITE_");
}
