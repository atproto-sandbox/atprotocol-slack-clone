import type * as MemberspaceDefs from "@flock/protocol/lexicons/api/types/com/atproto/memberspace/defs";
import { isAccountSuspendedError } from "@flock/protocol/atproto/xrpc";
import { listSpaceMembers } from "../atproto/space-ops";
import { getConfig } from "@flock/deployment/config";
import { getRawDb } from "../lib/db";
import { authorizeDmSubscription } from "../lib/dm-subscription";
import { parseDmSpaceUri, parseSpaceUri } from "@flock/protocol/keys";
import { SPACE_TYPE } from "@flock/protocol/nsids";
import { restoreAuthorityGrant } from "./authority-grant";

/** How long a space's member list answers who may follow it before it is read again (D12). */
export const MEMBER_LIST_TTL_MS = 60_000;
/** Short negative backoff when an authority account is suspended (`AccountTakedown` / `AccountDeactivated`), avoiding PDS retry storms. */
export const MEMBER_LIST_SUSPENDED_BACKOFF_MS = 15_000;

const FOLLOWED_BY_MEMBER_LIST: ReadonlySet<string> = new Set([
  SPACE_TYPE.workspace,
  SPACE_TYPE.inbox,
  SPACE_TYPE.channel,
  SPACE_TYPE.appInbox,
  SPACE_TYPE.tasks,
]);

export type MemberAccessDeps = {
  /** Whether the operator registered (or tried to register) its notice sink for the space: it knows the space exists. */
  isRegistered(space: string): boolean;
  /** The space's member list, read with its authority's grant; throws when there is no grant or the list cannot be read. */
  readMembers(space: string, authorityDid: string): Promise<MemberspaceDefs.Member[]>;
  now(): number;
};

/** Whether the operator holds, or tried and failed to make, its notice registration for `space`. */
export function isRegisteredSpace(space: string): boolean {
  return Boolean(getRawDb().prepare(`SELECT 1 FROM notification_registration WHERE service_ref=? AND space_uri=?
    UNION ALL SELECT 1 FROM notification_registration_failure WHERE space_uri=? LIMIT 1`).get(getConfig().operatorServiceRef, space, space));
}

const defaultDeps: MemberAccessDeps = {
  isRegistered: isRegisteredSpace,
  readMembers: async (space, authorityDid) => listSpaceMembers(await restoreAuthorityGrant(authorityDid), space),
  now: () => Date.now(),
};

const lists = new Map<string, { expiresAt: number; members: Promise<MemberspaceDefs.Member[]> }>();
let prunedAt = Number.NEGATIVE_INFINITY;

/**
 * Whether `did` may follow `space`'s changes. A DM inbox only for its owner and a DM conversation half for anyone, as the
 * DM stream allowed. A workspace, inbox or channel only when the operator registered its notice sink for it (so a guessed
 * space costs no grant restore and no read at its authority), its member list can be read with the authority's grant, and
 * the caller is the authority or may read it: the authority is not exempt from the read, which is how the operator learns
 * the space still exists. Any other space, and any failure to decide, is refused.
 */
export async function mayFollow(space: string, did: string, deps: MemberAccessDeps = defaultDeps): Promise<boolean> {
  if (parseDmSpaceUri(space)) return authorizeDmSubscription(space, did).allowed;
  const parsed = parseSpaceUri(space);
  if (!parsed || !FOLLOWED_BY_MEMBER_LIST.has(parsed.type) || !deps.isRegistered(space)) return false;
  try {
    const members = await memberList(space, parsed.authorityDid, deps);
    return did === parsed.authorityDid || members.some((member) => member.did === did && member.read === true);
  } catch {
    return false;
  }
}

/** Forgets a space's member list: the operator changed it, or the space was deleted. */
export function dropMemberList(space: string): void {
  lists.delete(space);
}

function memberList(space: string, authorityDid: string, deps: MemberAccessDeps): Promise<MemberspaceDefs.Member[]> {
  const now = deps.now();
  const held = lists.get(space);
  if (held && now < held.expiresAt && held.expiresAt - now <= MEMBER_LIST_TTL_MS) return held.members;
  // Lists past their minute are dropped at most once a minute, so a call with many uncached spaces walks the cache once.
  if (now - prunedAt >= MEMBER_LIST_TTL_MS || now < prunedAt) {
    prunedAt = now;
    for (const [cached, { expiresAt }] of lists) if (now >= expiresAt || expiresAt - now > MEMBER_LIST_TTL_MS) lists.delete(cached);
  }
  const entry = { expiresAt: now + MEMBER_LIST_TTL_MS, members: deps.readMembers(space, authorityDid) };
  lists.set(space, entry);
  // A failed read is not kept (unless the authority account is suspended, which backs off briefly to avoid storming the PDS).
  entry.members.catch((error: unknown) => {
    if (lists.get(space) !== entry) return;
    if (isAccountSuspendedError(error)) {
      entry.expiresAt = deps.now() + MEMBER_LIST_SUSPENDED_BACKOFF_MS;
    } else {
      lists.delete(space);
    }
  });
  return entry.members;
}
