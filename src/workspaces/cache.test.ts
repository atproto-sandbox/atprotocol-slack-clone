import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { closeDb, getRawDb } from "@/lib/db";
import { SpaceCredentialError } from "@/atproto/space-credential-core";
import { markRepoStale, purgeCachesForUnlistedWorkspaces, purgeDeletedSpace, purgeDeniedPermissionCache, purgeRepoCache, purgeWorkspaceCache, registerWorkspaceChannel, sweepStaleCache, sweepStaleCacheOccasionally } from "./cache";

test("workspace cache revocation keeps other workspaces under the same authority", () => {
  const directory = mkdtempSync(join(tmpdir(), "slack-workspace-cache-test-"));
  process.env.DATABASE_PATH = join(directory, "cache.db");
  process.env.AUTH_ENCRYPTION_KEY = "33".repeat(32);
  process.env.APP_URL = "http://127.0.0.1:3000";
  process.env.OPERATOR_SERVICE_REF = "did:web:localhost%3A3000#atproto_slack_admin";
  const account = "did:plc:reader";
  const authority = "did:plc:owner";
  const workspaceA = `at://${authority}/space/org.slack.workspace/team-a`;
  const workspaceB = `at://${authority}/space/org.slack.workspace/team-b`;
  const channelA = `at://${authority}/space/org.slack.channel/alpha`;
  const channelB = `at://${authority}/space/org.slack.channel/beta`;
  const sharedChannel = `at://${authority}/space/org.slack.channel/shared`;
  const raw = getRawDb();
  const seed = (space: string, suffix: string) => {
    raw.prepare(`INSERT OR REPLACE INTO channel_record_cache
      (account_did,space_uri,repo_did,collection,rkey,uri,value_cipher,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(account, space, account, "org.slack.channel.message", suffix, `at://${account}/org.slack.channel.message/${suffix}`, "cipher", Date.now());
    raw.prepare(`INSERT OR REPLACE INTO space_collection_cursor
      (account_did,space_uri,repo_did,collection,rev,next_cursor,finished,checked_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(account, space, account, "org.slack.channel.message", suffix, null, 1, Date.now());
    raw.prepare("INSERT OR REPLACE INTO sync_cursor (account_did,space_uri,repo_did,rev,updated_at) VALUES (?,?,?,?,?)")
      .run(account, space, account, suffix, Date.now());
  };
  const counts = (table: string, space: string) => (raw.prepare(`SELECT count(*) AS count FROM ${table} WHERE account_did=? AND space_uri=?`)
    .get(account, space) as { count: number }).count;
  try {
    registerWorkspaceChannel(account, workspaceA, channelA);
    registerWorkspaceChannel(account, workspaceB, channelB);
    registerWorkspaceChannel(account, workspaceA, sharedChannel);
    registerWorkspaceChannel(account, workspaceB, sharedChannel);
    seed(channelA, "a1");
    seed(channelB, "b1");
    seed(sharedChannel, "shared1");

    purgeWorkspaceCache(account, workspaceA);
    assert.equal(counts("channel_record_cache", channelA), 0);
    assert.equal(counts("space_collection_cursor", channelA), 0);
    assert.equal(counts("sync_cursor", channelA), 0);
    assert.equal(counts("channel_record_cache", channelB), 1);
    assert.equal(counts("channel_record_cache", sharedChannel), 1, "a channel still mapped to another workspace remains cached");

    registerWorkspaceChannel(account, workspaceA, channelA);
    registerWorkspaceChannel(account, workspaceA, sharedChannel);
    seed(channelA, "a2");
    seed(sharedChannel, "shared2");
    purgeCachesForUnlistedWorkspaces(account, [workspaceB]);
    assert.equal(counts("channel_record_cache", channelA), 0, "the removed workspace's unique channel is purged");
    assert.equal(counts("space_collection_cursor", channelA), 0);
    assert.equal(counts("sync_cursor", channelA), 0);
    assert.equal(counts("channel_record_cache", channelB), 1);
    assert.equal(counts("channel_record_cache", sharedChannel), 2, "shared channel data remains while an accessible workspace references it");

    registerWorkspaceChannel(account, workspaceA, channelA);
    registerWorkspaceChannel(account, workspaceB, channelB);
    seed(channelA, "denied-a");
    seed(channelB, "denied-b");
    assert.equal(purgeDeniedPermissionCache(account, workspaceB, channelB, { status: 403 }), true);
    assert.equal(counts("channel_record_cache", channelB), 0, "a denied channel credential purges that channel's cache");
    assert.equal(counts("channel_record_cache", channelA), 1, "a denied channel credential leaves other channel data intact");
    assert.equal(purgeDeniedPermissionCache(account, workspaceA, workspaceA, { status: 403 }), true);
    assert.equal(counts("channel_record_cache", channelA), 0, "a denied workspace credential purges its associated channel cache");
    assert.equal(purgeDeniedPermissionCache(account, workspaceA, workspaceA, { status: 404 }), false);
    registerWorkspaceChannel(account, workspaceA, channelA);
    seed(channelA, "deleted-a");
    assert.equal(purgeDeniedPermissionCache(account, workspaceB, channelA, new SpaceCredentialError("gone", 410, "SpaceDeleted")), true, "a credential renewal that finds the space deleted drops its cached copies");
    assert.equal(counts("channel_record_cache", channelA), 0);
  } finally {
    closeDb();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("markRepoStale resets every account's cursor for one repo in one space and leaves everything else alone", () => {
  // #given cursors for two accounts on the same repo, plus another repo and another space
  const directory = mkdtempSync(join(tmpdir(), "slack-mark-stale-test-"));
  process.env.DATABASE_PATH = join(directory, "stale.db");
  process.env.AUTH_ENCRYPTION_KEY = "34".repeat(32);
  process.env.APP_URL = "http://127.0.0.1:3000";
  process.env.OPERATOR_SERVICE_REF = "did:web:localhost%3A3000#atproto_slack_admin";
  const space = "at://did:plc:owner/space/org.slack.channel/alpha";
  const otherSpace = "at://did:plc:owner/space/org.slack.channel/beta";
  const raw = getRawDb();
  const seed = (account: string, spaceUri: string, repo: string, collection: string) => raw.prepare(`INSERT INTO space_collection_cursor
    (account_did,space_uri,repo_did,collection,rev,next_cursor,finished,checked_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(account, spaceUri, repo, collection, "rev-1", null, 1, 1_000);
  try {
    seed("did:plc:reader-a", space, "did:plc:author", "org.slack.channel.message");
    seed("did:plc:reader-a", space, "did:plc:author", "org.slack.channel.reaction");
    seed("did:plc:reader-b", space, "did:plc:author", "org.slack.channel.message");
    seed("did:plc:reader-a", space, "did:plc:someone-else", "org.slack.channel.message");
    seed("did:plc:reader-a", otherSpace, "did:plc:author", "org.slack.channel.message");

    // #when
    markRepoStale(space, "did:plc:author");

    // #then
    const rows = raw.prepare("SELECT account_did, space_uri, repo_did, collection, rev, checked_at FROM space_collection_cursor").all() as Array<{ space_uri: string; repo_did: string; rev: string; checked_at: number }>;
    const stale = rows.filter((row) => row.checked_at === 0);
    assert.equal(stale.length, 3, "both collections for both accounts");
    assert.ok(stale.every((row) => row.rev === "" && row.space_uri === space && row.repo_did === "did:plc:author"));
    assert.equal(rows.filter((row) => row.rev === "rev-1").length, 2, "the other repo and the other space are untouched");
  } finally {
    closeDb();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("purgeRepoCache drops one writer's cached rows in a space and leaves the other writers and spaces alone", () => {
  const directory = mkdtempSync(join(tmpdir(), "slack-repo-cache-test-"));
  process.env.DATABASE_PATH = join(directory, "cache.db");
  process.env.AUTH_ENCRYPTION_KEY = "33".repeat(32);
  process.env.APP_URL = "http://127.0.0.1:3000";
  process.env.OPERATOR_SERVICE_REF = "did:web:localhost%3A3000#atproto_slack_admin";
  const account = "did:plc:reader";
  const channel = "at://did:plc:owner/space/org.slack.channel/alpha";
  const other = "at://did:plc:owner/space/org.slack.channel/beta";
  const raw = getRawDb();
  const seed = (space: string, repo: string) => {
    raw.prepare(`INSERT OR REPLACE INTO channel_record_cache
      (account_did,space_uri,repo_did,collection,rkey,uri,value_cipher,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(account, space, repo, "org.slack.channel.message", "r1", `at://${repo}/org.slack.channel.message/r1`, "cipher", Date.now());
    raw.prepare(`INSERT OR REPLACE INTO space_collection_cursor
      (account_did,space_uri,repo_did,collection,rev,next_cursor,finished,checked_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(account, space, repo, "org.slack.channel.message", "r1", null, 1, Date.now());
    raw.prepare("INSERT OR REPLACE INTO sync_cursor (account_did,space_uri,repo_did,rev,updated_at) VALUES (?,?,?,?,?)")
      .run(account, space, repo, "r1", Date.now());
  };
  const rows = (table: string, space: string, repo: string) => (raw.prepare(`SELECT count(*) AS count FROM ${table} WHERE account_did=? AND space_uri=? AND repo_did=?`)
    .get(account, space, repo) as { count: number }).count;
  try {
    seed(channel, "did:plc:bad");
    seed(channel, "did:plc:good");
    seed(other, "did:plc:bad");

    purgeRepoCache(account, channel, "did:plc:bad");

    for (const table of ["channel_record_cache", "space_collection_cursor", "sync_cursor"]) {
      assert.equal(rows(table, channel, "did:plc:bad"), 0, `${table}: the set-aside writer's rows are gone`);
      assert.equal(rows(table, channel, "did:plc:good"), 1, `${table}: another writer in the space is untouched`);
      assert.equal(rows(table, other, "did:plc:bad"), 1, `${table}: the same writer in another space is untouched`);
    }
  } finally {
    closeDb();
    rmSync(directory, { recursive: true, force: true });
  }
});

const CACHE_TABLES = ["channel_record_cache", "space_collection_cursor", "sync_cursor", "workspace_channel_cache", "space_notification", "notification_registration"];

// The configuration is read once per process, so these tests share the database the first test in this file configured, and clear it.
after(() => {
  closeDb();
  if (process.env.DATABASE_PATH) rmSync(dirname(process.env.DATABASE_PATH), { recursive: true, force: true });
});

function useEmptyCache(): void {
  if (!process.env.DATABASE_PATH) {
    process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "slack-cache-lifecycle-test-")), "cache.db");
    process.env.AUTH_ENCRYPTION_KEY = "33".repeat(32);
    process.env.APP_URL = "http://127.0.0.1:3000";
    process.env.OPERATOR_SERVICE_REF = "did:web:localhost%3A3000#atproto_slack_admin";
  }
  for (const table of CACHE_TABLES) getRawDb().prepare(`DELETE FROM ${table}`).run();
}

function seedSpace(account: string, space: string, checkedAtSeconds: number): void {
  const raw = getRawDb();
  raw.prepare(`INSERT OR REPLACE INTO channel_record_cache
    (account_did,space_uri,repo_did,collection,rkey,uri,value_cipher,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(account, space, "did:plc:writer", "org.slack.channel.message", "r1", `at://did:plc:writer/org.slack.channel.message/r1`, "cipher", checkedAtSeconds);
  raw.prepare(`INSERT OR REPLACE INTO space_collection_cursor
    (account_did,space_uri,repo_did,collection,rev,next_cursor,finished,checked_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(account, space, "did:plc:writer", "org.slack.channel.message", "r1", null, 1, checkedAtSeconds);
  raw.prepare("INSERT OR REPLACE INTO sync_cursor (account_did,space_uri,repo_did,rev,updated_at) VALUES (?,?,?,?,?)")
    .run(account, space, "did:plc:writer", "r1", checkedAtSeconds);
}

const cachedSpaces = (account: string): string[] => (getRawDb().prepare("SELECT DISTINCT space_uri FROM channel_record_cache WHERE account_did=? ORDER BY space_uri")
  .all(account) as Array<{ space_uri: string }>).map((row) => row.space_uri);

test("a deleted space is dropped from every account's cache, with its change notices, and a second notice changes nothing", () => {
  // #given two accounts that cached a channel the authority then deletes, and a channel that stays
  useEmptyCache();
  const now = Math.floor(Date.now() / 1000);
  const deleted = "at://did:plc:owner/space/org.slack.channel/doomed";
  const kept = "at://did:plc:owner/space/org.slack.channel/kept";
  for (const account of ["did:plc:a", "did:plc:b"]) {
    seedSpace(account, deleted, now);
    seedSpace(account, kept, now);
    registerWorkspaceChannel(account, "at://did:plc:owner/space/org.slack.workspace/team", deleted);
  }
  getRawDb().prepare("INSERT INTO space_notification (space_uri,repo_did,rev,notified_at) VALUES (?,?,?,?)").run(deleted, "did:plc:writer", "r1", now);
  getRawDb().prepare("INSERT INTO notification_registration (service_ref,space_uri,expires_at) VALUES (?,?,?)").run("did:web:localhost%3A3000#atproto_slack_admin", deleted, Date.now() + 3_600_000);

  // #when the authority's deletion notice is applied, twice
  purgeDeletedSpace(deleted);
  purgeDeletedSpace(deleted);

  // #then neither account keeps the deleted channel, its association or its notices; the other channel is untouched
  assert.deepEqual(cachedSpaces("did:plc:a"), [kept]);
  assert.deepEqual(cachedSpaces("did:plc:b"), [kept]);
  assert.equal((getRawDb().prepare("SELECT count(*) AS count FROM workspace_channel_cache WHERE space_uri=?").get(deleted) as { count: number }).count, 0);
  assert.equal((getRawDb().prepare("SELECT count(*) AS count FROM space_notification WHERE space_uri=?").get(deleted) as { count: number }).count, 0);
  assert.equal((getRawDb().prepare("SELECT count(*) AS count FROM notification_registration WHERE space_uri=?").get(deleted) as { count: number }).count, 0);
});

test("a deleted workspace takes its channels' cached copies with it", () => {
  useEmptyCache();
  const now = Math.floor(Date.now() / 1000);
  const workspace = "at://did:plc:owner/space/org.slack.workspace/team";
  const channel = "at://did:plc:owner/space/org.slack.channel/alpha";
  seedSpace("did:plc:a", workspace, now);
  seedSpace("did:plc:a", channel, now);
  registerWorkspaceChannel("did:plc:a", workspace, channel);

  purgeDeletedSpace(workspace);

  assert.deepEqual(cachedSpaces("did:plc:a"), []);
});

test("a copy an account has not read within the retention window is swept, and a copy it still reads is kept", () => {
  // #given one account that stopped reading a channel 40 days ago and another that read it a minute ago
  useEmptyCache();
  const nowMs = Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  const channel = "at://did:plc:owner/space/org.slack.channel/alpha";
  const other = "at://did:plc:owner/space/org.slack.channel/beta";
  seedSpace("did:plc:gone", channel, nowSeconds - 40 * 86_400);
  seedSpace("did:plc:active", channel, nowSeconds - 60);
  seedSpace("did:plc:mixed", channel, nowSeconds - 40 * 86_400);
  seedSpace("did:plc:mixed", other, nowSeconds - 60);
  getRawDb().prepare("INSERT INTO workspace_channel_cache (account_did,workspace_uri,space_uri,updated_at) VALUES (?,?,?,?)")
    .run("did:plc:gone", "at://did:plc:owner/space/org.slack.workspace/team", channel, nowMs - 40 * 86_400_000);

  // #when the cache is swept with a 30-day retention
  const swept = sweepStaleCache(nowMs, 30 * 86_400_000);

  // #then only the abandoned copies go, whole, and the stale association with them
  assert.equal(swept, 2);
  assert.deepEqual(cachedSpaces("did:plc:gone"), []);
  assert.deepEqual(cachedSpaces("did:plc:active"), [channel]);
  assert.deepEqual(cachedSpaces("did:plc:mixed"), [other]);
  assert.equal((getRawDb().prepare("SELECT count(*) AS count FROM workspace_channel_cache").get() as { count: number }).count, 0);
});

test("a sweep drops at most one batch of abandoned copies, and the next call finishes the backlog", () => {
  useEmptyCache();
  const nowMs = Date.now();
  const old = Math.floor(nowMs / 1000) - 40 * 86_400;
  for (let index = 0; index < 5; index += 1) seedSpace(`did:plc:gone${index}`, "at://did:plc:owner/space/org.slack.channel/alpha", old);

  assert.equal(sweepStaleCache(nowMs, 30 * 86_400_000, 3), 3);
  assert.equal(sweepStaleCache(nowMs, 30 * 86_400_000, 3), 2);
  assert.equal(sweepStaleCache(nowMs, 30 * 86_400_000, 3), 0);
});

test("the occasional sweep runs at most once an hour", () => {
  useEmptyCache();
  const nowMs = Date.now() + 10 * 365 * 86_400_000;
  const old = Math.floor(nowMs / 1000) - 40 * 86_400;
  const channel = "at://did:plc:owner/space/org.slack.channel/alpha";
  seedSpace("did:plc:first", channel, old);
  sweepStaleCacheOccasionally(nowMs);
  assert.deepEqual(cachedSpaces("did:plc:first"), [], "the first call sweeps");

  seedSpace("did:plc:second", channel, old);
  sweepStaleCacheOccasionally(nowMs + 60_000);
  assert.deepEqual(cachedSpaces("did:plc:second"), [channel], "a call within the hour does nothing");

  sweepStaleCacheOccasionally(nowMs + 2 * 3_600_000);
  assert.deepEqual(cachedSpaces("did:plc:second"), [], "a call after the hour sweeps again");
});

test("a space is kept while any writer's cursor in it was checked recently, and a stale sync cursor alone does not condemn it", () => {
  // #given one account's space where one writer's host has been down for 40 days (its cursors are old) while another writer is read every minute
  useEmptyCache();
  const nowMs = Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  const old = nowSeconds - 40 * 86_400;
  const channel = "at://did:plc:owner/space/org.slack.channel/alpha";
  const raw = getRawDb();
  const cursor = (repo: string, checkedAt: number) => raw.prepare(`INSERT OR REPLACE INTO space_collection_cursor
    (account_did,space_uri,repo_did,collection,rev,next_cursor,finished,checked_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run("did:plc:reader", channel, repo, "org.slack.channel.message", "r1", null, 1, checkedAt);
  const syncCursor = (repo: string, updatedAt: number) => raw.prepare("INSERT OR REPLACE INTO sync_cursor (account_did,space_uri,repo_did,rev,updated_at) VALUES (?,?,?,?,?)")
    .run("did:plc:reader", channel, repo, "r1", updatedAt);
  cursor("did:plc:down", old);
  syncCursor("did:plc:down", old);
  cursor("did:plc:live", nowSeconds - 60);
  syncCursor("did:plc:live", old);
  raw.prepare(`INSERT INTO channel_record_cache (account_did,space_uri,repo_did,collection,rkey,uri,value_cipher,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run("did:plc:reader", channel, "did:plc:live", "org.slack.channel.message", "r1", "at://x/y/r1", "cipher", old);

  // #when the cache is swept with a 30-day retention
  const swept = sweepStaleCache(nowMs, 30 * 86_400_000);

  // #then the space is kept whole, because its newest check is a minute old
  assert.equal(swept, 0);
  assert.deepEqual(cachedSpaces("did:plc:reader"), [channel]);
});

test("while more than a batch of abandoned copies waits, the occasional sweep comes back within a minute instead of an hour", () => {
  useEmptyCache();
  const nowMs = Date.now() + 20 * 365 * 86_400_000;
  const old = Math.floor(nowMs / 1000) - 40 * 86_400;
  for (let index = 0; index < 101; index += 1) seedSpace(`did:plc:gone${index}`, "at://did:plc:owner/space/org.slack.channel/alpha", old);
  const remaining = () => (getRawDb().prepare("SELECT count(DISTINCT account_did) AS count FROM space_collection_cursor").get() as { count: number }).count;

  sweepStaleCacheOccasionally(nowMs);
  assert.equal(remaining(), 1, "a full batch of 100 went and one is left");

  sweepStaleCacheOccasionally(nowMs + 30_000);
  assert.equal(remaining(), 1, "not yet: the retry waits a minute");

  sweepStaleCacheOccasionally(nowMs + 61_000);
  assert.equal(remaining(), 0, "a minute later the backlog is finished, long before the hourly interval");
});

test("the sweep drops change notices older than a week even when no new notice ever arrives", () => {
  useEmptyCache();
  const nowMs = Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  const insert = getRawDb().prepare("INSERT INTO space_notification (space_uri,repo_did,rev,notified_at) VALUES (?,?,?,?)");
  insert.run("at://did:plc:owner/space/org.slack.channel/alpha", "did:plc:writer", "r1", nowSeconds - 8 * 86_400);
  insert.run("at://did:plc:owner/space/org.slack.channel/alpha", "did:plc:writer", "r2", nowSeconds - 60);

  sweepStaleCache(nowMs, 30 * 86_400_000);

  assert.equal((getRawDb().prepare("SELECT count(*) AS count FROM space_notification").get() as { count: number }).count, 1);
});
