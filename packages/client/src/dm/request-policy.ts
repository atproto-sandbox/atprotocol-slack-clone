export type DmRequestMode = "everyone" | "allowlist" | "nobody";
export type DmAllowlistMember = { did: string; write: boolean };

/** §3.6: whether the inbox's memberspace policy opens writes to anyone (`publicWrite`) for a request mode. Reads are always member-list, owner-only. */
export function publicWriteForMode(mode: DmRequestMode): boolean {
  return mode === "everyone";
}

/**
 * The inverse mapping, from what `getSpace` (its `publicWrite` flag) plus `listBoundedMembers` report
 * back to a request mode. A member survives a switch to "nobody" as a
 * dormant (`write: false`) entry rather than being removed, so the allowlist
 * is preserved across mode switches; `mode` itself is "allowlist" only while
 * at least one member is currently active (`write: true`), and "nobody"
 * when the list is empty or every member on it is dormant. This is
 * intentionally lossy in one direction: the PDS cannot distinguish "nobody"
 * from "allowlist with everyone dormant", which is correct, since they
 * behave identically until someone is reactivated.
 */
export function modeForInboxPolicy(publicWrite: boolean, members: readonly DmAllowlistMember[]): DmRequestMode {
  if (publicWrite) return "everyone";
  return members.some((member) => member.write) ? "allowlist" : "nobody";
}

/**
 * M0 finding (§6, plan adjustment to (f)): tightening or emptying the policy does
 * not evict writers the PDS already tracked. `listRequests` must therefore filter
 * every candidate sender against the *current* mode and allowlist itself,
 * including in "nobody" mode, rather than trusting PDS-side tracking.
 */
export function isSenderAllowedUnderMode(input: { mode: DmRequestMode; allowlist: readonly string[]; senderDid: string }): boolean {
  switch (input.mode) {
    case "everyone": return true;
    case "allowlist": return input.allowlist.includes(input.senderDid);
    case "nobody": return false;
  }
}
