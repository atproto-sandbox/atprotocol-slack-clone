import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { SpaceMacError } from "@atproto/space";
import { KemKeyError } from "@/atproto/kem-key";
import { closeDb, getRawDb } from "@/lib/db";
import { AtprotoClient, XrpcError } from "@/atproto/xrpc";
import { backfillPageLimit, channelPageHasMore, fillLatest, fillOlder, hasMoreCursor, SetAsideRepos } from "./channel-sync";

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

const ACCOUNT = "did:plc:reader";
const SPACE = "at://did:plc:owner/space/org.slack.channel/alpha";
const MESSAGES = "org.slack.channel.message";

// The configuration is read once per process, so every test in this file shares one database and starts from empty cache tables.
const DIRECTORY = mkdtempSync(join(tmpdir(), "slack-channel-sync-test-"));
process.env.DATABASE_PATH = join(DIRECTORY, "sync.db");
process.env.AUTH_ENCRYPTION_KEY = "33".repeat(32);
process.env.APP_URL = "http://127.0.0.1:3000";
process.env.OPERATOR_SERVICE_REF = "did:web:localhost%3A3000#atproto_slack_admin";
after(() => {
  closeDb();
  rmSync(DIRECTORY, { recursive: true, force: true });
});

function useEmptyCache(): void {
  for (const table of ["channel_record_cache", "space_collection_cursor", "sync_cursor"]) getRawDb().prepare(`DELETE FROM ${table}`).run();
}

function seedCache(repo: string, options: { nextCursor?: string | null; finished?: number } = {}): void {
  const raw = getRawDb();
  raw.prepare(`INSERT OR REPLACE INTO channel_record_cache
    (account_did,space_uri,repo_did,collection,rkey,uri,value_cipher,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(ACCOUNT, SPACE, repo, MESSAGES, "r1", `at://${repo}/${MESSAGES}/r1`, "cipher", Date.now());
  raw.prepare(`INSERT OR REPLACE INTO space_collection_cursor
    (account_did,space_uri,repo_did,collection,rev,next_cursor,finished,checked_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(ACCOUNT, SPACE, repo, MESSAGES, "r1", options.nextCursor ?? null, options.finished ?? 1, Date.now());
  raw.prepare("INSERT OR REPLACE INTO sync_cursor (account_did,space_uri,repo_did,rev,updated_at) VALUES (?,?,?,?,?)")
    .run(ACCOUNT, SPACE, repo, "r1", Date.now());
}

function cacheRows(repo: string): number[] {
  return ["channel_record_cache", "space_collection_cursor", "sync_cursor"].map((table) =>
    (getRawDb().prepare(`SELECT count(*) AS count FROM ${table} WHERE account_did=? AND space_uri=? AND repo_did=?`).get(ACCOUNT, SPACE, repo) as { count: number }).count);
}

/** A host that answers every listRecords call with the next canned reply, or throws it. */
function hostAnswering(...replies: Array<Record<string, unknown> | Error>): AtprotoClient {
  return new AtprotoClient(async () => {
    const reply = replies.shift();
    if (!reply) throw new Error("unexpected extra request");
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  });
}

const messageRecord = (rkey: string) => ({ rkey, collection: MESSAGES, value: { text: rkey } });

test("a writer whose repo cannot be authenticated is set aside, and the other writers are still read", async () => {
  // #given four writers, two of which cannot be authenticated
  const repos = [{ did: "did:plc:a" }, { did: "did:plc:nokey" }, { did: "did:plc:badmac" }, { did: "did:plc:b" }];
  const refreshed: string[] = [];
  useEmptyCache();
  // #when the channel is refreshed
  const aside = new SetAsideRepos(ACCOUNT, SPACE);
  const readable = await aside.refresh(repos, 2, async (repo) => {
    if (repo.did === "did:plc:nokey") throw new KemKeyError(repo.did, "the DID document lists no #atproto_kem verification method");
    if (repo.did === "did:plc:badmac") throw new SpaceMacError("getLatestCommit failed MAC verification");
    refreshed.push(repo.did);
  });

  // #then the two good writers are read and the two others are reported
  assert.deepEqual(readable.map((repo) => repo.did), ["did:plc:a", "did:plc:b"]);
  assert.deepEqual(refreshed.sort(), ["did:plc:a", "did:plc:b"]);
  assert.deepEqual(aside.reasons().map(({ did }) => did).sort(), ["did:plc:badmac", "did:plc:nokey"]);
  assert.equal(aside.reasons().find(({ did }) => did === "did:plc:nokey")!.reason, "it publishes no usable #atproto_kem key");
});

test("a writer whose account was deactivated or taken down is set aside with a fixed reason, and the other writers are still read", async () => {
  // #given the pinned PDS answers a non-self read of such an account with 400 RepoDeactivated or RepoTakendown
  useEmptyCache();
  const aside = new SetAsideRepos(ACCOUNT, SPACE);

  // #when the channel is refreshed
  const readable = await aside.refresh([{ did: "did:plc:ok" }, { did: "did:plc:gone" }, { did: "did:plc:banned" }], 2, async (repo) => {
    if (repo.did === "did:plc:gone") throw new XrpcError(400, "Repo has been deactivated: did:plc:gone", "RepoDeactivated");
    if (repo.did === "did:plc:banned") throw new XrpcError(400, "Repo has been takendown: did:plc:banned", "RepoTakendown");
  });

  // #then only the healthy writer remains readable
  assert.deepEqual(readable.map((repo) => repo.did), ["did:plc:ok"]);
  assert.deepEqual(aside.reasons().sort((a, b) => a.did.localeCompare(b.did)), [
    { did: "did:plc:banned", reason: "its account was taken down" },
    { did: "did:plc:gone", reason: "its account is deactivated" },
  ]);
});

test("a store failure while refreshing a writer still fails the read instead of being blamed on the writer", async () => {
  useEmptyCache();
  const aside = new SetAsideRepos(ACCOUNT, SPACE);
  await assert.rejects(
    aside.refresh([{ did: "did:plc:a" }], 1, async () => { throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }); }),
    /database is locked/,
  );
});

test("a writer set aside for a permanent reason loses its cached rows, and a transient failure keeps them; the other writers keep theirs", async () => {
  // #given cached rows for a deactivated writer, a writer whose host is down, and a healthy writer
  useEmptyCache();
  seedCache("did:plc:gone");
  seedCache("did:plc:down");
  seedCache("did:plc:good");
  const aside = new SetAsideRepos(ACCOUNT, SPACE);

  // #when the channel is refreshed
  await aside.refresh([{ did: "did:plc:good" }, { did: "did:plc:gone" }, { did: "did:plc:down" }], 3, async (repo) => {
    if (repo.did === "did:plc:gone") throw new XrpcError(400, "Repo has been deactivated", "RepoDeactivated");
    if (repo.did === "did:plc:down") throw new XrpcError(502, "Bad Gateway", "UpstreamFailure");
  });

  // #then the deactivated writer is dropped from all three cache tables, the down writer is kept, and the good one is untouched
  assert.deepEqual(cacheRows("did:plc:gone"), [0, 0, 0]);
  assert.deepEqual(cacheRows("did:plc:down"), [1, 1, 1]);
  assert.deepEqual(cacheRows("did:plc:good"), [1, 1, 1]);
  assert.deepEqual(aside.reasons().find(({ did }) => did === "did:plc:down")?.reason, "its host answered HTTP 502");
});

test("filling the latest messages sets aside a writer whose host fails and still stores the other writer's page", async () => {
  // #given two writers with more pages to read, one of which answers 500
  useEmptyCache();
  seedCache("did:plc:bad", { nextCursor: "c1", finished: 0 });
  seedCache("did:plc:good", { nextCursor: "c1", finished: 0 });
  const clients = new Map([
    ["did:plc:bad", hostAnswering(new XrpcError(500, "boom", "InternalServerError"))],
    ["did:plc:good", hostAnswering({ records: [messageRecord("r0")] })],
  ]);
  const aside = new SetAsideRepos(ACCOUNT, SPACE);

  // #when the latest messages are filled
  await fillLatest(ACCOUNT, SPACE, [{ did: "did:plc:bad" }, { did: "did:plc:good" }] as never, async (did) => clients.get(did)!, 50, aside);

  // #then the read does not fail, the failing writer is reported, and the other writer's page was stored
  assert.deepEqual(aside.reasons(), [{ did: "did:plc:bad", reason: "its host answered HTTP 500" }]);
  const stored = getRawDb().prepare("SELECT rkey FROM channel_record_cache WHERE account_did=? AND space_uri=? AND repo_did=? ORDER BY rkey").all(ACCOUNT, SPACE, "did:plc:good") as Array<{ rkey: string }>;
  assert.deepEqual(stored.map((row) => row.rkey), ["r0"]);
});

test("backfilling older records sets aside a writer whose page cannot be read and still stores the other writer's page", async () => {
  // #given two writers with older pages to read, one of which answers a page larger than the request allows
  useEmptyCache();
  seedCache("did:plc:bad", { nextCursor: "c1", finished: 0 });
  seedCache("did:plc:good", { nextCursor: "c1", finished: 0 });
  const clients = new Map([
    ["did:plc:bad", hostAnswering({ records: Array.from({ length: 40 }, (_, index) => messageRecord(`b${index}`)) })],
    ["did:plc:good", hostAnswering({ records: [messageRecord("r0")] })],
  ]);
  const aside = new SetAsideRepos(ACCOUNT, SPACE);

  // #when older records are backfilled
  await fillOlder(ACCOUNT, SPACE, [{ did: "did:plc:bad" }, { did: "did:plc:good" }] as never, async (did) => clients.get(did)!, MESSAGES, 10, aside);

  // #then the oversized page set only that writer aside
  assert.deepEqual(aside.reasons().map(({ did }) => did), ["did:plc:bad"]);
  const stored = getRawDb().prepare("SELECT count(*) AS count FROM channel_record_cache WHERE account_did=? AND space_uri=? AND repo_did=?").get(ACCOUNT, SPACE, "did:plc:good") as { count: number };
  assert.equal(stored.count, 2);
});

test("a set-aside writer's unfinished cursor does not keep the history loop asking for more", async () => {
  // #given one writer that is fully read and one that was only partly synced before its host failed
  useEmptyCache();
  seedCache("did:plc:good");
  seedCache("did:plc:down", { nextCursor: "c1", finished: 0 });
  const aside = new SetAsideRepos(ACCOUNT, SPACE);
  assert.equal(hasMoreCursor(ACCOUNT, SPACE, MESSAGES, aside), true, "while the writer is still being read its cursor offers more");

  // #when its host fails during the refresh
  await aside.refresh([{ did: "did:plc:down" }], 1, async () => { throw new XrpcError(502, "Bad Gateway", "UpstreamFailure"); });

  // #then nothing is left to fetch, so the loop ends instead of growing its target until the history cap
  assert.equal(hasMoreCursor(ACCOUNT, SPACE, MESSAGES, aside), false);
});

test("a writer's host refusing the credential sets only that writer aside and keeps its cached copy; the mint is where lost access is decided", async () => {
  useEmptyCache();
  seedCache("did:plc:refusing");
  const aside = new SetAsideRepos(ACCOUNT, SPACE);

  const readable = await aside.refresh([{ did: "did:plc:refusing" }, { did: "did:plc:ok" }], 2, async (repo) => {
    if (repo.did === "did:plc:refusing") throw new XrpcError(403, "denied", "Forbidden");
  });

  assert.deepEqual(readable.map((repo) => repo.did), ["did:plc:ok"]);
  assert.deepEqual(aside.reasons(), [{ did: "did:plc:refusing", reason: "its host answered HTTP 403" }]);
  assert.deepEqual(cacheRows("did:plc:refusing"), [1, 1, 1]);
});
