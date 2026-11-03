import { getRawDb } from "@/lib/db";
import { isAccessLost } from "@/atproto/space-credential-core";
import { parseChannelUri, parseSpaceUri, parseWorkspaceUri } from "@/protocol/keys";

const isWorkspace = (uri: string): boolean => parseWorkspaceUri(uri) !== null;
const isChannel = (uri: string): boolean => parseChannelUri(uri) !== null;
/** The authority of a channel or inbox space, which can belong to a workspace by authority alone. */
const relatedSpaceAuthority = (uri: string): string | undefined => {
  const parsed = parseSpaceUri(uri);
  return parsed && (parsed.type === "org.slack.channel" || parsed.type === "org.slack.inbox") ? parsed.authorityDid : undefined;
};

/**
 * The next channel read re-fetches this repo instead of waiting out the freshness window. The empty revision matches
 * no real one, so a read already in flight cannot write its older snapshot back over this mark.
 */
export function markRepoStale(space: string, repo: string): void {
  getRawDb().prepare("UPDATE space_collection_cursor SET checked_at=0, rev='' WHERE space_uri=? AND repo_did=?").run(space, repo);
}

/**
 * Drops what was cached from one writer's repo in a space. A writer that can no longer be authenticated must show nothing, and
 * its rows must not count toward the fill cutoff or the history limit, or valid writers would be crowded out.
 */
export function purgeRepoCache(account: string, space: string, repo: string): void {
  purgeWhere(account, "space_uri = ? AND repo_did = ?", [space, repo]);
}

export function purgeSpaceCache(account: string, space: string): void {
  purgeWhere(account, "space_uri = ?", [space]);
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
