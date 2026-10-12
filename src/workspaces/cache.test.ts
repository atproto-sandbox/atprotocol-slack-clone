import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDb, getRawDb } from "@/lib/db";
import { markRepoStale, purgeCachesForUnlistedWorkspaces, purgeDeniedPermissionCache, purgeWorkspaceCache, registerWorkspaceChannel } from "./cache";

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
