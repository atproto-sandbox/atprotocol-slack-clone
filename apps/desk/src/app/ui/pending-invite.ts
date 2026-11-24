import { isDid, parseWorkspaceUri, workspaceUri } from "@flock/protocol/keys";
import { PENDING_INVITE_STORAGE_KEY } from "@flock/shell";

export { PENDING_INVITE_STORAGE_KEY };

/**
 * Validates and normalizes an invite input (either a canonical workspace space URI
 * or a bare group DID for the manual Join bar) into `{ groupDid, workspaceUri }`, or `null`.
 */
export function parseInviteTarget(raw: string | null | undefined, options: { allowBareDid?: boolean } = {}): {
  groupDid: string;
  workspaceUri: string;
} | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const parsedWs = parseWorkspaceUri(trimmed);
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
  if (!parseWorkspaceUri(uri)) return;
  try {
    sessionStorage.setItem(PENDING_INVITE_STORAGE_KEY, uri);
  } catch {
    // ignore storage quota/privacy mode errors
  }
}

export function loadPendingInvite(): string | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(PENDING_INVITE_STORAGE_KEY);
    return raw && parseWorkspaceUri(raw) ? raw : null;
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
