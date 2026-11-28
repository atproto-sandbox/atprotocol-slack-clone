import { isDid, normalizeLegacySpaceUri, parseWorkspaceUri, workspaceUri } from "@flock/protocol/keys";
import { PENDING_INVITE_STORAGE_KEY } from "@flock/shell";

export { PENDING_INVITE_STORAGE_KEY };

export function isLegacyOpenSocialInviteUri(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return raw.includes("group.opensocial.");
}

/**
 * Validates and normalizes an invite input (either a canonical workspace space URI
 * or a bare group DID for the manual Join bar) into `{ groupDid, workspaceUri }`, or `null`.
 */
export function parseInviteTarget(raw: string | null | undefined, options: { allowBareDid?: boolean } = {}): {
  groupDid: string;
  workspaceUri: string;
} | null {
  const trimmed = raw?.trim();
  if (!trimmed || isLegacyOpenSocialInviteUri(trimmed)) return null;
  const parsedWs = parseWorkspaceUri(normalizeLegacySpaceUri(trimmed));
  if (parsedWs) {
    return { groupDid: parsedWs.authorityDid, workspaceUri: workspaceUri(parsedWs.authorityDid) };
  }
  if (options.allowBareDid && isDid(trimmed)) {
    return { groupDid: trimmed, workspaceUri: workspaceUri(trimmed) };
  }
  return null;
}

export function savePendingInvite(uri: string): void {
  if (typeof sessionStorage === "undefined") return;
  const normalized = normalizeLegacySpaceUri(uri.trim());
  if (!parseWorkspaceUri(normalized)) return;
  try {
    sessionStorage.setItem(PENDING_INVITE_STORAGE_KEY, normalized);
  } catch {
    // ignore storage quota/privacy mode errors
  }
}

export function loadPendingInvite(): string | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(PENDING_INVITE_STORAGE_KEY);
    if (!raw) return null;
    const normalized = normalizeLegacySpaceUri(raw.trim());
    return parseWorkspaceUri(normalized) ? normalized : null;
  } catch {
    return null;
  }
}

export function clearPendingInvite(): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(PENDING_INVITE_STORAGE_KEY);
  } catch {
    // ignore
  }
}
