import { getConfig } from "@flock/deployment/config";
import { listBoundedRecords } from "@flock/protocol/atproto/record-pages";
import {
  groupMembersUri,
  isDid,
  parseDmSpaceUri,
  parsePersonalInboxUri,
  parseSpaceUri,
} from "@flock/protocol/keys";
import { ATGRP_COLLECTION, ATGRP_SPACE_TYPE, SPACE_TYPE } from "@flock/protocol/nsids";
import { validateSpaceRecord } from "@flock/protocol/registry";
import { WORKSPACE_ENVELOPE, WorkspaceEnvelopeError } from "@flock/protocol/workspace-summary";
import { sessionClient } from "../atproto/client";
import { getOpenSocialSpacePolicy } from "../atproto/space-ops";
import { getRawDb } from "../lib/db";
import { authorizeDmSubscription } from "../lib/dm-subscription";
import { restoreAuthorityGrant } from "./authority-grant";
import {
  AUTHORITY_SUSPENDED_BACKOFF_MS,
  invalidateAuthorityHealth,
  isAuthoritySuspended,
  runThroughAuthorityBreaker,
} from "./authority-suspension";

/** How long a space's OpenSocial read-access snapshot answers who may follow it before re-reading (D12). */
export const MEMBER_LIST_TTL_MS = 60_000;
export const MEMBER_LIST_SUSPENDED_BACKOFF_MS = AUTHORITY_SUSPENDED_BACKOFF_MS;

const FOLLOWED_BY_GROUP_POLICY: ReadonlySet<string> = new Set([
  ATGRP_SPACE_TYPE.meta,
  ATGRP_SPACE_TYPE.members,
  SPACE_TYPE.workspace,
  SPACE_TYPE.inbox,
  SPACE_TYPE.channel,
  SPACE_TYPE.appInbox,
  SPACE_TYPE.tasks,
]);

export type SpaceAccessEntry = { did: string; read: boolean; write: boolean };

export type SpaceReadSnapshot = {
  publicRead: boolean;
  entries: SpaceAccessEntry[];
};

export type MemberAccessDeps = {
  /** Whether the operator registered (or tried to register) its notice sink for the space: it knows the space exists. */
  isRegistered(space: string): boolean;
  /** Reads the OpenSocial policy + role-based readers of `space` using its group's shared session. */
  readMembers(space: string, authorityDid: string): Promise<SpaceAccessEntry[] | SpaceReadSnapshot>;
  now(): number;
};

/** Whether the operator holds, or tried and failed to make, its notice registration for `space`. */
export function isRegisteredSpace(space: string): boolean {
  return Boolean(
    getRawDb()
      .prepare(`SELECT 1 FROM notification_registration WHERE service_ref=? AND space_uri=?
        UNION ALL SELECT 1 FROM notification_registration_failure WHERE space_uri=? LIMIT 1`)
      .get(getConfig().operatorServiceRef, space, space),
  );
}

async function readOpenSocialSpaceReaders(space: string, groupDid: string): Promise<SpaceReadSnapshot> {
  const session = await restoreAuthorityGrant(groupDid);
  const policy = await getOpenSocialSpacePolicy(session, space);
  if (!policy) {
    throw new Error("SpaceNotFound");
  }
  if (policy.publicRead === true) {
    return { publicRead: true, entries: [] };
  }
  const readableRoles = new Set(policy.grants.filter((g) => g.read === true).map((g) => g.role));
  const writableRoles = new Set(policy.grants.filter((g) => g.write === true).map((g) => g.role));
  if (readableRoles.size === 0 && writableRoles.size === 0) {
    return { publicRead: false, entries: [] };
  }
  const membersSpace = groupMembersUri(groupDid);
  const scan = await listBoundedRecords(sessionClient(session), {
    space: membersSpace,
    repo: groupDid,
    collection: ATGRP_COLLECTION.membership,
    maxRecords: WORKSPACE_ENVELOPE.authorityRecordScan,
  });
  if (scan.truncated) {
    throw new WorkspaceEnvelopeError(
      `Group membership scan exceeds its ${WORKSPACE_ENVELOPE.authorityRecordScan}-record limit.`,
    );
  }
  const entries: SpaceAccessEntry[] = [];
  for (const row of scan.records) {
    if (!isDid(row.rkey) || row.rkey === groupDid) continue;
    if (
      !validateSpaceRecord(ATGRP_COLLECTION.membership, row.value, {
        authorityDid: groupDid,
        spaceUri: membersSpace,
        repoDid: groupDid,
        rkey: row.rkey,
      }).valid
    ) {
      continue;
    }
    const roles = Array.isArray(row.value.roles) ? (row.value.roles as string[]) : [];
    const read = roles.some((r) => readableRoles.has(r));
    const write = roles.some((r) => writableRoles.has(r));
    if (read || write) {
      entries.push({ did: row.rkey, read, write });
    }
  }
  return { publicRead: false, entries };
}

const defaultDeps: MemberAccessDeps = {
  isRegistered: isRegisteredSpace,
  readMembers: readOpenSocialSpaceReaders,
  now: () => Date.now(),
};

const lists = new Map<string, { expiresAt: number; snapshot: Promise<SpaceReadSnapshot> }>();
let prunedAt = Number.NEGATIVE_INFINITY;

function normalizeSnapshot(raw: SpaceAccessEntry[] | SpaceReadSnapshot): SpaceReadSnapshot {
  if (Array.isArray(raw)) {
    return { publicRead: false, entries: raw };
  }
  return raw;
}

/**
 * Whether `did` may follow `space`'s changes:
 * - DM inbox / conversation: per `authorizeDmSubscription`.
 * - Personal `org.atgrp.inbox/self`: exclusively for its owner (`parsed.userDid === did`).
 * - Registered group/workspace spaces (`meta`, `members`, `workspace`, `inbox`, `channel`, `app.inbox`, `ext.tasks`):
 *   when `policy.publicRead === true`, `did === groupDid`, or `did` holds a role granted `read: true` on `space`.
 */
export async function mayFollow(space: string, did: string, deps: MemberAccessDeps = defaultDeps): Promise<boolean> {
  if (parseDmSpaceUri(space)) return authorizeDmSubscription(space, did).allowed;
  const personalInvites = parsePersonalInboxUri(space);
  if (personalInvites) return personalInvites.userDid === did;
  const parsed = parseSpaceUri(space);
  if (!parsed || !FOLLOWED_BY_GROUP_POLICY.has(parsed.type) || !deps.isRegistered(space)) return false;
  try {
    const snap = await readSpaceSnapshot(space, parsed.authorityDid, deps);
    return (
      did === parsed.authorityDid ||
      snap.publicRead === true ||
      snap.entries.some((member) => member.did === did && member.read === true)
    );
  } catch {
    return false;
  }
}

/**
 * Invalidates cached read-access snapshots:
 * when `members/self` changes (roles/memberships), drops every cached space under that `groupDid`;
 * when an individual space policy changes or is deleted, drops that space's cache entry.
 */
export function dropMemberList(space: string): void {
  const parsed = parseSpaceUri(space);
  if (!parsed) {
    lists.delete(space);
    return;
  }
  if (parsed.type === ATGRP_SPACE_TYPE.members) {
    const prefix = `at:space/${parsed.authorityDid}/`;
    for (const cached of lists.keys()) {
      if (cached.startsWith(prefix)) lists.delete(cached);
    }
  } else {
    lists.delete(space);
  }
  invalidateAuthorityHealth(parsed.authorityDid);
}

function readSpaceSnapshot(space: string, authorityDid: string, deps: MemberAccessDeps): Promise<SpaceReadSnapshot> {
  const now = deps.now();
  if (isAuthoritySuspended(authorityDid, now)) {
    return Promise.reject(new Error("AuthoritySuspended"));
  }
  const held = lists.get(space);
  if (held && now < held.expiresAt && held.expiresAt - now <= MEMBER_LIST_TTL_MS) return held.snapshot;
  if (now - prunedAt >= MEMBER_LIST_TTL_MS || now < prunedAt) {
    prunedAt = now;
    for (const [cached, { expiresAt }] of lists) {
      if (now >= expiresAt || expiresAt - now > MEMBER_LIST_TTL_MS) {
        lists.delete(cached);
        const parsedCached = parseSpaceUri(cached);
        if (parsedCached) invalidateAuthorityHealth(parsedCached.authorityDid);
      }
    }
  }
  const snapshotPromise = runThroughAuthorityBreaker(
    authorityDid,
    () => deps.now(),
    async () => normalizeSnapshot(await deps.readMembers(space, authorityDid)),
  );
  const entry = { expiresAt: now + MEMBER_LIST_TTL_MS, snapshot: snapshotPromise };
  lists.set(space, entry);
  entry.snapshot.catch(() => {
    if (lists.get(space) === entry) lists.delete(space);
  });
  return entry.snapshot;
}
