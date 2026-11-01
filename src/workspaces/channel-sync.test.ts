import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SpaceMacError } from "@atproto/space";
import { KemKeyError } from "@/atproto/kem-key";
import { closeDb, getRawDb } from "@/lib/db";
import { backfillPageLimit, channelPageHasMore, refreshAuthenticated, refreshWriterRepos } from "./channel-sync";

test("channel history pagination stops at the configured cap while retaining earlier pages", () => {
  assert.equal(channelPageHasMore(19_800, 100, 19_900, 19_900, true), true);
  assert.equal(channelPageHasMore(19_900, 100, 20_000, 20_000, true), false);
  assert.equal(channelPageHasMore(19_950, 100, 20_000, 20_000, true), false);
});

test("channel history pagination stops offering empty pages after raw invalid records exhaust the scan cap", () => {
  assert.equal(channelPageHasMore(0, 100, 500, 20_000, true), true);
  assert.equal(channelPageHasMore(400, 100, 500, 20_000, true), false);
  assert.equal(channelPageHasMore(500, 100, 500, 20_000, true), false);
});

test("reaction backfill pages split the remaining cap across writer repos without overshooting it", () => {
  assert.equal(backfillPageLimit(20_000, 1), 1_000);
  assert.equal(backfillPageLimit(20_000, 199), 100);
  assert.equal(backfillPageLimit(150, 199), 1);
  assert.equal(backfillPageLimit(999, 3), 333);
  assert.ok(backfillPageLimit(999, 3) * 3 <= 999);
});

test("a writer whose repo cannot be authenticated is set aside, and the other writers are still read", async () => {
  const repos = [{ did: "did:plc:a" }, { did: "did:plc:nokey" }, { did: "did:plc:badmac" }, { did: "did:plc:b" }];
  const refreshed: string[] = [];
  const { readable, unverified } = await refreshAuthenticated(repos, 2, async (repo) => {
    if (repo.did === "did:plc:nokey") throw new KemKeyError(repo.did, "the DID document lists no #atproto_kem verification method");
    if (repo.did === "did:plc:badmac") throw new SpaceMacError("getLatestCommit failed MAC verification");
    refreshed.push(repo.did);
  });
  assert.deepEqual(readable.map((repo) => repo.did), ["did:plc:a", "did:plc:b"]);
  assert.deepEqual(refreshed.sort(), ["did:plc:a", "did:plc:b"]);
  assert.deepEqual(unverified.map(({ did }) => did).sort(), ["did:plc:badmac", "did:plc:nokey"]);
  assert.match(unverified.find(({ did }) => did === "did:plc:nokey")!.reason, /no usable #atproto_kem key/);
});

test("any other failure while refreshing a writer still fails the read", async () => {
  await assert.rejects(refreshAuthenticated([{ did: "did:plc:a" }], 1, async () => { throw new Error("PDS unreachable"); }), /PDS unreachable/);
  await assert.rejects(refreshAuthenticated([{ did: "did:plc:a" }], 1, async () => { throw Object.assign(new Error("denied"), { status: 403 }); }), /denied/);
});

test("a writer set aside during a channel refresh loses its cached rows, and the other writers keep theirs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "slack-channel-sync-test-"));
  process.env.DATABASE_PATH = join(directory, "sync.db");
  process.env.AUTH_ENCRYPTION_KEY = "33".repeat(32);
  process.env.APP_URL = "http://127.0.0.1:3000";
  process.env.OPERATOR_SERVICE_REF = "did:web:localhost%3A3000#atproto_slack_admin";
  const account = "did:plc:reader";
  const space = "at://did:plc:owner/space/org.slack.channel/alpha";
  const raw = getRawDb();
  const seed = (repo: string) => {
    raw.prepare(`INSERT OR REPLACE INTO channel_record_cache
      (account_did,space_uri,repo_did,collection,rkey,uri,value_cipher,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(account, space, repo, "org.slack.channel.message", "r1", `at://${repo}/org.slack.channel.message/r1`, "cipher", Date.now());
    raw.prepare(`INSERT OR REPLACE INTO space_collection_cursor
      (account_did,space_uri,repo_did,collection,rev,next_cursor,finished,checked_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(account, space, repo, "org.slack.channel.message", "r1", null, 1, Date.now());
    raw.prepare("INSERT OR REPLACE INTO sync_cursor (account_did,space_uri,repo_did,rev,updated_at) VALUES (?,?,?,?,?)")
      .run(account, space, repo, "r1", Date.now());
  };
  const rows = (repo: string) => ["channel_record_cache", "space_collection_cursor", "sync_cursor"].map((table) =>
    (raw.prepare(`SELECT count(*) AS count FROM ${table} WHERE account_did=? AND space_uri=? AND repo_did=?`).get(account, space, repo) as { count: number }).count);
  try {
    seed("did:plc:bad");
    seed("did:plc:good");

    const { readable, unverified } = await refreshWriterRepos(account, space, [{ did: "did:plc:good" }, { did: "did:plc:bad" }], 2, async (repo) => {
      if (repo.did === "did:plc:bad") throw new SpaceMacError("getLatestCommit failed MAC verification");
    });

    assert.deepEqual(readable.map((repo) => repo.did), ["did:plc:good"]);
    assert.deepEqual(unverified.map(({ did }) => did), ["did:plc:bad"]);
    assert.deepEqual(rows("did:plc:bad"), [0, 0, 0], "the set-aside writer's rows are gone from all three cache tables");
    assert.deepEqual(rows("did:plc:good"), [1, 1, 1], "the readable writer's rows are untouched");

    seed("did:plc:down");
    await assert.rejects(refreshWriterRepos(account, space, [{ did: "did:plc:down" }], 1, async () => { throw new Error("PDS unreachable"); }), /PDS unreachable/);
    assert.deepEqual(rows("did:plc:down"), [1, 1, 1], "a failure that is not an authentication failure purges nothing");
  } finally {
    closeDb();
    rmSync(directory, { recursive: true, force: true });
  }
});
