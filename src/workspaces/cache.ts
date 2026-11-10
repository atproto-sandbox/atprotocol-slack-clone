import { getRawDb } from "@/lib/db";
import { isAccessLost } from "@/atproto/space-credential-core";
import { purgeExpiredNotificationRegistrations, purgeSpaceNotifications, purgeStaleNotifications } from "@/operator/notices";
import { getConfig } from "@/lib/config";
import { parseChannelUri, parseSpaceUri, parseWorkspaceUri } from "@/protocol/keys";
import { SPACE_TYPE } from "@/protocol/nsids";

const isWorkspace = (uri: string): boolean => parseWorkspaceUri(uri) !== null;
const isChannel = (uri: string): boolean => parseChannelUri(uri) !== null;
/** The authority of a channel or inbox space, which can belong to a workspace by authority alone. */
const relatedSpaceAuthority = (uri: string): string | undefined => {
  const parsed = parseSpaceUri(uri);
  return parsed && (parsed.type === SPACE_TYPE.channel || parsed.type === SPACE_TYPE.inbox) ? parsed.authorityDid : undefined;
};

/**
 * The next channel read re-fetches this repo instead of waiting out the freshness window. The empty revision matches
 * no real one, so a read already in flight cannot write its older snapshot back over this mark.
 */
export function markRepoStale(space: string, repo: string): void {
  getRawDb().prepare("UPDATE space_collection_cursor SET checked_at=0, rev='' WHERE space_uri=? AND repo_did=?").run(space, repo);
}

/**
 * Drops what was cached from one writer's repo in a space. A writer that is permanently unreadable (deactivated, taken down,
 * unauthenticated, oversized) must show nothing, and its rows must not count toward the fill cutoff or the history limit, or
 * valid writers would be crowded out.
 */
export function purgeRepoCache(account: string, space: string, repo: string): void {
  purgeWhere(account, "space_uri = ? AND repo_did = ?", [space, repo]);
}

export function purgeSpaceCache(account: string, space: string): void {
  purgeWhere(account, "space_uri = ?", [space]);
}

/**
 * The space authority said the space was deleted: every account's copy of it goes, whether or not that account ever comes back to
 * learn it from a refused credential renewal. A deleted workspace takes its channels' copies with it.
 */
export function purgeDeletedSpace(space: string): void {
  const db = getRawDb();
  db.transaction(() => {
    // A cached record always has a cursor row, so the cursor tables name every account that holds a copy.
    const accounts = db.prepare(`SELECT account_did FROM space_collection_cursor WHERE space_uri=?
      UNION SELECT account_did FROM sync_cursor WHERE space_uri=?
      UNION SELECT account_did FROM workspace_channel_cache WHERE space_uri=? OR workspace_uri=?`)
      .all(space, space, space, space) as Array<{ account_did: string }>;
    for (const { account_did: account } of accounts) {
      if (isWorkspace(space)) {
        purgeWorkspaceCache(account, space);
      } else {
        db.prepare("DELETE FROM workspace_channel_cache WHERE account_did=? AND space_uri=?").run(account, space);
        purgeSpaceCache(account, space);
      }
    }
    purgeSpaceNotifications(space);
  }).immediate();
}

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** Copies dropped per sweep, so the first sweep on a database that has never been swept cannot hold the write lock for long. */
const SWEEP_BATCH = 100;
/** When a sweep dropped a full batch there is more backlog, so the next one comes after this instead of the hour. */
const SWEEP_BACKLOG_RETRY_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
let lastSweepAt = 0;

/**
 * Drops each account's copy of every space it has not read for `CACHE_RETENTION_DAYS`. An account that never returns cannot learn
 * of a deleted space or of its own removal from a refused credential, so age is what bounds what is kept for it. A space an
 * account still reads is checked at least once a minute, so only abandoned copies reach the cutoff. The cursor tables are the
 * record of when a copy was last read (a cached record always has one), so the sweep never scans the record cache itself. It
 * drops at most `batch` copies per call. Returns how many copies went.
 */
export function sweepStaleCache(now = Date.now(), retentionMs = getConfig().cacheRetentionDays * DAY_MS, batch = SWEEP_BATCH): number {
  const db = getRawDb();
  const cutoffSeconds = Math.floor((now - retentionMs) / 1000);
  const stale = db.prepare(`SELECT account_did, space_uri FROM (
      SELECT account_did, space_uri, checked_at AS seen FROM space_collection_cursor
      UNION ALL SELECT account_did, space_uri, updated_at AS seen FROM sync_cursor)
    GROUP BY account_did, space_uri HAVING max(seen) < ? LIMIT ?`).all(cutoffSeconds, batch) as Array<{ account_did: string; space_uri: string }>;
  db.transaction(() => {
    for (const { account_did: account, space_uri: space } of stale) purgeSpaceCache(account, space);
    db.prepare("DELETE FROM workspace_channel_cache WHERE updated_at < ?").run(now - retentionMs);
    purgeExpiredNotificationRegistrations(now - retentionMs);
    purgeStaleNotifications(Math.floor(now / 1000));
  })();
  return stale.length;
}

/**
 * `sweepStaleCache` at most once an hour per process, called from a read path. Housekeeping must never fail the read that
 * happened to trigger it, so a failure is logged and the next hour tries again.
 */
export function sweepStaleCacheOccasionally(now = Date.now()): void {
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  try {
    // A full batch means more is waiting: come back soon instead of after the hour.
    if (sweepStaleCache(now) >= SWEEP_BATCH) lastSweepAt = now - SWEEP_INTERVAL_MS + SWEEP_BACKLOG_RETRY_MS;
  } catch (error) {
    console.error("Stale cache sweep failed; it will be retried within the hour.", error);
  }
}

export function purgeDeniedPermissionCache(account: string, workspace: string, space: string, error: unknown): boolean {
  if (!isAccessLost(error)) return false;
  const workspaceDid = parseWorkspaceUri(workspace)?.authorityDid;
  if (!workspaceDid) return false;
  if (space === workspace) {
    purgeWorkspaceCache(account, workspace);
  } else if (relatedSpaceAuthority(space) === workspaceDid) {
    purgeSpaceCache(account, space);
  } else {
    purgeWorkspaceCache(account, workspace);
  }
  return true;
}

export function registerWorkspaceChannel(account: string, workspace: string, channel: string): void {
  const workspaceDid = parseWorkspaceUri(workspace)?.authorityDid;
  const channelDid = parseChannelUri(channel)?.authorityDid;
  if (!workspaceDid || workspaceDid !== channelDid) return;
  getRawDb().prepare(`INSERT OR IGNORE INTO workspace_channel_cache (account_did,workspace_uri,space_uri,updated_at)
    VALUES (?,?,?,?)`).run(account, workspace, channel, Date.now());
}

export function unregisterWorkspaceChannel(account: string, workspace: string, channel: string): void {
  const db = getRawDb();
  const transaction = db.transaction(() => {
    db.prepare("DELETE FROM workspace_channel_cache WHERE account_did=? AND workspace_uri=? AND space_uri=?")
      .run(account, workspace, channel);
    if (!hasWorkspaceAssociation(account, channel)) purgeSpaceCacheInTransaction(account, channel);
  });
  transaction();
}

export function replaceWorkspaceChannels(account: string, workspace: string, channels: string[]): void {
  const workspaceDid = parseWorkspaceUri(workspace)?.authorityDid;
  if (!workspaceDid) return;
  const validChannels = [...new Set(channels.filter((channel) => parseChannelUri(channel)?.authorityDid === workspaceDid))];
  const db = getRawDb();
  const transaction = db.transaction(() => {
    const previous = db.prepare("SELECT space_uri FROM workspace_channel_cache WHERE account_did=? AND workspace_uri=?")
      .all(account, workspace) as Array<{ space_uri: string }>;
    db.prepare("DELETE FROM workspace_channel_cache WHERE account_did=? AND workspace_uri=?").run(account, workspace);
    const insert = db.prepare(`INSERT INTO workspace_channel_cache (account_did,workspace_uri,space_uri,updated_at)
      VALUES (?,?,?,?)`);
    for (const channel of validChannels) insert.run(account, workspace, channel, Date.now());
    for (const { space_uri: space } of previous) {
      if (!validChannels.includes(space) && !hasWorkspaceAssociation(account, space)) purgeSpaceCacheInTransaction(account, space);
    }
  });
  transaction();
}

export function purgeWorkspaceCache(account: string, workspace: string): void {
  if (!isWorkspace(workspace)) {
    purgeSpaceCache(account, workspace);
    return;
  }
  const db = getRawDb();
  const transaction = db.transaction(() => {
    const channels = db.prepare("SELECT space_uri FROM workspace_channel_cache WHERE account_did=? AND workspace_uri=?")
      .all(account, workspace) as Array<{ space_uri: string }>;
    db.prepare("DELETE FROM workspace_channel_cache WHERE account_did=? AND workspace_uri=?").run(account, workspace);
    purgeSpaceCacheInTransaction(account, workspace);
    for (const { space_uri: channel } of channels) {
      if (!hasWorkspaceAssociation(account, channel)) purgeSpaceCacheInTransaction(account, channel);
    }
    const authorityDid = parseWorkspaceUri(workspace)?.authorityDid;
    const cachedChannels = db.prepare(`SELECT space_uri FROM channel_record_cache WHERE account_did=?
      UNION SELECT space_uri FROM space_collection_cursor WHERE account_did=?
      UNION SELECT space_uri FROM sync_cursor WHERE account_did=?`).all(account, account, account) as Array<{ space_uri: string }>;
    for (const { space_uri: channel } of cachedChannels) {
      if (parseChannelUri(channel)?.authorityDid === authorityDid && !hasWorkspaceAssociation(account, channel)) {
        purgeSpaceCacheInTransaction(account, channel);
      }
    }
  });
  transaction();
}

export function purgeCachesForUnlistedWorkspaces(account: string, workspaceUris: string[]): void {
  const listed = [...new Set(workspaceUris.filter(isWorkspace))];
  const db = getRawDb();
  const transaction = db.transaction(() => {
    const unlistedPredicate = listed.length === 0
      ? "account_did=?"
      : `account_did=? AND workspace_uri NOT IN (${listed.map(() => "?").join(",")})`;
    const parameters = [account, ...listed];
    const removed = db.prepare(`SELECT DISTINCT space_uri FROM workspace_channel_cache WHERE ${unlistedPredicate}`)
      .all(...parameters) as Array<{ space_uri: string }>;
    db.prepare(`DELETE FROM workspace_channel_cache WHERE ${unlistedPredicate}`).run(...parameters);
    for (const { space_uri: channel } of removed) {
      if (!hasWorkspaceAssociation(account, channel)) purgeSpaceCacheInTransaction(account, channel);
    }

    // Older cache rows may predate workspace-channel associations. Treat them
    // as unowned once discovery has successfully listed every accessible space.
    const cachedChannels = db.prepare(`SELECT space_uri FROM channel_record_cache WHERE account_did=?
      UNION SELECT space_uri FROM space_collection_cursor WHERE account_did=?
      UNION SELECT space_uri FROM sync_cursor WHERE account_did=?`).all(account, account, account) as Array<{ space_uri: string }>;
    for (const { space_uri: channel } of cachedChannels) {
      if (isChannel(channel) && !hasWorkspaceAssociation(account, channel)) purgeSpaceCacheInTransaction(account, channel);
    }
  });
  transaction();
}

function hasWorkspaceAssociation(account: string, channel: string): boolean {
  return Boolean(getRawDb().prepare("SELECT 1 FROM workspace_channel_cache WHERE account_did=? AND space_uri=? LIMIT 1").get(account, channel));
}

function purgeWhere(account: string, predicate: string, values: string[]): void {
  const db = getRawDb();
  const transaction = db.transaction(() => purgeWhereInTransaction(account, predicate, values));
  transaction();
}

function purgeSpaceCacheInTransaction(account: string, space: string): void {
  purgeWhereInTransaction(account, "space_uri = ?", [space]);
}

function purgeWhereInTransaction(account: string, predicate: string, values: string[]): void {
  const db = getRawDb();
  db.prepare(`DELETE FROM channel_record_cache WHERE account_did = ? AND ${predicate}`).run(account, ...values);
  db.prepare(`DELETE FROM space_collection_cursor WHERE account_did = ? AND ${predicate}`).run(account, ...values);
  db.prepare(`DELETE FROM sync_cursor WHERE account_did = ? AND ${predicate}`).run(account, ...values);
}
