export type DmRequestMode = "everyone" | "allowlist" | "nobody";
export type DmWritePolicy = "public" | "memberList";
export type DmAllowlistMember = { did: string; write: boolean };

/** §3.6: the inbox `writePolicy` a request mode maps to. The read policy is always memberList, owner-only. */
export function writePolicyForMode(mode: DmRequestMode): DmWritePolicy {
  return mode === "everyone" ? "public" : "memberList";
}

/**
 * The inverse mapping, from what `getSpace` plus `listBoundedMembers` report
 * back to a request mode. A member survives a switch to "nobody" as a
 * dormant (`write: false`) entry rather than being removed, so the allowlist
 * is preserved across mode switches; `mode` itself is "allowlist" only while
 * at least one member is currently active (`write: true`), and "nobody"
 * when the list is empty or every member on it is dormant. This is
 * intentionally lossy in one direction: the PDS cannot distinguish "nobody"
 * from "allowlist with everyone dormant", which is correct, since they
 * behave identically until someone is reactivated.
 */
export function modeForInboxPolicy(writePolicy: DmWritePolicy, members: readonly DmAllowlistMember[]): DmRequestMode {
  if (writePolicy === "public") return "everyone";
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
