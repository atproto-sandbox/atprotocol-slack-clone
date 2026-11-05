import { parseDmSpaceUri } from "@/protocol/keys";

export type DmSubscriptionDecision = { allowed: true; space: string } | { allowed: false; status: 400 | 403; reason: string };

/**
 * An inbox URI is derivable from a DID, so its change stream is limited to its
 * owner. A conversation half cannot be checked here, because the server never holds
 * DM credentials, and its key is a TID (creation time plus 10 random bits), not a
 * secret. That is acceptable only because the stream is content-free: it carries a
 * change counter and nothing else.
 */
export function authorizeDmSubscription(space: string, sessionDid: string): DmSubscriptionDecision {
  const parsed = parseDmSpaceUri(space);
  if (!parsed) return { allowed: false, status: 400, reason: "The space must be a DM inbox or DM conversation URI." };
  if (parsed.kind === "inbox" && parsed.ownerDid !== sessionDid) return { allowed: false, status: 403, reason: "A DM inbox change stream is limited to its owner." };
  return { allowed: true, space };
}
