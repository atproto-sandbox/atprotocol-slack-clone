import { getRawDb } from "@/lib/db";

const WORKSPACE_URI = /^at:\/\/(did:[^/]+)\/space\/org\.slack\.workspace\/[A-Za-z0-9._~:-]{1,128}$/;
const CHANNEL_URI = /^at:\/\/(did:[^/]+)\/space\/org\.slack\.channel\/[A-Za-z0-9._~:-]{1,128}$/;
const RELATED_SPACE_URI = /^at:\/\/(did:[^/]+)\/space\/(?:org\.slack\.channel|org\.slack\.inbox)\/[A-Za-z0-9._~:-]{1,128}$/;

/**
 * The next channel read re-fetches this repo instead of waiting out the freshness window. The empty revision matches
 * no real one, so a read already in flight cannot write its older snapshot back over this mark.
 */
export function markRepoStale(space: string, repo: string): void {
  getRawDb().prepare("UPDATE space_collection_cursor SET checked_at=0, rev='' WHERE space_uri=? AND repo_did=?").run(space, repo);
}

export function purgeSpaceCache(account: string, space: string): void {
  purgeWhere(account, "space_uri = ?", [space]);
}

export function purgeDeniedPermissionCache(account: string, workspace: string, space: string, error: unknown): boolean {
  if (!denied(error)) return false;
  const workspaceDid = WORKSPACE_URI.exec(workspace)?.[1];
  if (!workspaceDid) return false;
  if (space === workspace) {
    purgeWorkspaceCache(account, workspace);
  } else if (RELATED_SPACE_URI.exec(space)?.[1] === workspaceDid) {
    purgeSpaceCache(account, space);
  } else {
    purgeWorkspaceCache(account, workspace);
  }
  return true;
}

export function registerWorkspaceChannel(account: string, workspace: string, channel: string): void {
  const workspaceDid = WORKSPACE_URI.exec(workspace)?.[1];
  const channelDid = CHANNEL_URI.exec(channel)?.[1];
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
  if (!WORKSPACE_URI.test(workspace)) return;
  const workspaceDid = WORKSPACE_URI.exec(workspace)?.[1];
  const validChannels = [...new Set(channels.filter((channel) => CHANNEL_URI.exec(channel)?.[1] === workspaceDid))];
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
  if (!WORKSPACE_URI.test(workspace)) {
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
    const authorityDid = WORKSPACE_URI.exec(workspace)?.[1];
    const cachedChannels = db.prepare(`SELECT space_uri FROM channel_record_cache WHERE account_did=?
      UNION SELECT space_uri FROM space_collection_cursor WHERE account_did=?
      UNION SELECT space_uri FROM sync_cursor WHERE account_did=?`).all(account, account, account) as Array<{ space_uri: string }>;
    for (const { space_uri: channel } of cachedChannels) {
      if (CHANNEL_URI.exec(channel)?.[1] === authorityDid && !hasWorkspaceAssociation(account, channel)) {
        purgeSpaceCacheInTransaction(account, channel);
      }
    }
  });
  transaction();
}

export function purgeCachesForUnlistedWorkspaces(account: string, workspaceUris: string[]): void {
  const listed = [...new Set(workspaceUris.filter((uri) => WORKSPACE_URI.test(uri)))];
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
      if (CHANNEL_URI.test(channel) && !hasWorkspaceAssociation(account, channel)) purgeSpaceCacheInTransaction(account, channel);
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

function denied(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && (error.status === 401 || error.status === 403);
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
