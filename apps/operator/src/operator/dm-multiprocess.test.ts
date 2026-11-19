import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, hkdfSync } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { Secp256k1Keypair } from "@atproto/crypto";
import { createServiceJwt } from "@atproto/xrpc-server";
import { dmConversationUri, dmInboxUri, tidNow } from "@flock/protocol/keys";
import { NOTICE_METHOD, OPERATOR_METHOD } from "@flock/protocol/nsids";
import { closeDb, getRawDb } from "../lib/db";
import {
  dmWakeSocketPath,
  ensureDmWakeReady,
  formatHubLeaseToken,
  HUB_LEASE_TTL_MS,
  recordDmWake,
  resetDmFeedWakesForTests,
} from "./dm-feed-wakes";
import { createOperatorApp } from "./server";
import { deriveDmNotifyToken } from "./space-notification";

const DIRECTORY = mkdtempSync(join(tmpdir(), "flock-dm-multiproc-test-"));
const DB_PATH = join(DIRECTORY, "multiproc.db");
const KEY_HEX = "5a".repeat(32);
const SERVICE_REF = "did:web:localhost%3A3001#atproto_flock_operator";
const ALICE_DID = "did:plc:alice2345678901234567890";
const BOB_DID = "did:plc:bob234567890123456789012";

const aliceKey = await Secp256k1Keypair.create();
const bobKey = await Secp256k1Keypair.create();

// Tiny loopback PLC directory so both Worker A and Worker B verify real getChanges Bearer service JWTs
const plcServer = http.createServer((req, res) => {
  const did = decodeURIComponent((req.url ?? "/").slice(1));
  const key = did === ALICE_DID ? aliceKey : did === BOB_DID ? bobKey : null;
  if (!key) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
      id: did,
      verificationMethod: [
        {
          id: `${did}#atproto`,
          type: "Multikey",
          controller: did,
          publicKeyMultibase: key.did().replace("did:key:", ""),
        },
      ],
    }),
  );
});
plcServer.listen(0, "127.0.0.1");
await once(plcServer, "listening");
const plcUrl = `http://127.0.0.1:${(plcServer.address() as AddressInfo).port}`;

const mutableEnv = process.env as Record<string, string | undefined>;
mutableEnv.NODE_ENV = "test";
process.env.DATABASE_PATH = DB_PATH;
process.env.AUTH_ENCRYPTION_KEY = KEY_HEX;
process.env.APP_URL = "http://127.0.0.1:3000";
process.env.OPERATOR_URL = "http://127.0.0.1:3001";
process.env.OPERATOR_SERVICE_REF = SERVICE_REF;
process.env.PLC_URL = plcUrl;

let workerAServer: http.Server | undefined;
let workerBChild: ChildProcess | undefined;

async function closeHttpServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolveClose) => {
    server.close(() => resolveClose());
    server.closeAllConnections();
  });
}

after(async () => {
  if (workerBChild && workerBChild.exitCode === null) {
    workerBChild.kill("SIGTERM");
    await once(workerBChild, "close").catch(() => undefined);
  }
  if (workerAServer) {
    await closeHttpServer(workerAServer);
  }
  closeDb();
  await closeHttpServer(plcServer);
  rmSync(DIRECTORY, { recursive: true, force: true });
});

async function spawnWorkerB(): Promise<{ url: string; child: ChildProcess }> {
  const serverModule = fileURLToPath(new URL("./server.ts", import.meta.url));
  const dbModule = fileURLToPath(new URL("../lib/db.ts", import.meta.url));
  const script = `
    import { createOperatorApp } from ${JSON.stringify(serverModule)};
    import { closeDb, getRawDb } from ${JSON.stringify(dbModule)};
    getRawDb();
    const server = createOperatorApp().listen(0, "127.0.0.1", () => {
      const addr = server.address();
      process.stdout.write("READY:" + addr.port + "\\n");
    });
    const shutdown = () => {
      server.close(() => {
        closeDb();
        process.exit(0);
      });
      server.closeAllConnections();
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  return new Promise((resolveReady, rejectReady) => {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      const match = /READY:(\d+)/.exec(stdout);
      if (match) {
        resolveReady({ url: `http://127.0.0.1:${match[1]}`, child });
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", rejectReady);
    child.once("close", (code) => {
      rejectReady(new Error(`Worker B exited early (${code}): ${stderr}`));
    });
  });
}

async function mintGetChangesAuth(did: string, keypair: Secp256k1Keypair): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const jwt = await createServiceJwt({
    iss: did,
    aud: SERVICE_REF,
    lxm: OPERATOR_METHOD.getChanges,
    keypair,
    iat,
    exp: iat + 600,
  });
  return `Bearer ${jwt}`;
}

type ChangesResponse = {
  head: string;
  changed: Array<{ space: string; cursor: string }>;
  denied: string[];
  reset: string[];
};

async function postGetChanges(
  baseUrl: string,
  authorization: string,
  follow: Array<{ space: string; after: string }>,
  signal?: AbortSignal,
): Promise<ChangesResponse> {
  const res = await fetch(`${baseUrl}/xrpc/${OPERATOR_METHOD.getChanges}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization },
    body: JSON.stringify({ follow }),
    signal,
  });
  assert.equal(res.status, 200, `getChanges on ${baseUrl} failed with HTTP ${res.status}`);
  return (await res.json()) as ChangesResponse;
}

async function postNotifyUpdate(baseUrl: string, space: string, token: string, repoDid: string): Promise<Response> {
  const digestB64 = Buffer.alloc(32, 0xcd).toString("base64");
  return fetch(`${baseUrl}/xrpc/${NOTICE_METHOD.notifySpaceUpdate}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      space,
      token,
      update: {
        $type: "com.atproto.space.defs#repoWrite",
        repo: repoDid,
        repoRev: "3kabcdefghij2",
        spaceRev: "3kabcdefghij3",
        data: { $bytes: digestB64 },
      },
    }),
  });
}

test("multi-process DM wake hub delivers cross-worker long-poll wakes immediately, shares one epoch across alternating workers with zero spurious resets, recovers stale .sock files, and writes zero DM rows to SQLite", { timeout: 20_000 }, async () => {
  const initialDb = getRawDb();
  const deadHubId = "dead00000001";
  const deadSockPath = dmWakeSocketPath(undefined, undefined, deadHubId)!;
  assert.ok(deadSockPath && deadSockPath.endsWith(".sock"));

  // Leave a dead stale .sock inode + unexpired crashed-hub lease in oauth_request_lock (simulating a SIGKILLed previous hub where connect yields ECONNREFUSED)
  await new Promise<void>((resolveStale, rejectStale) => {
    const staleChild = spawn(
      process.execPath,
      [
        "-e",
        `const net = require("node:net"); const s = net.createServer(); s.listen(${JSON.stringify(deadSockPath)}, () => process.kill(process.pid, "SIGKILL"));`,
      ],
      { stdio: "ignore" },
    );
    staleChild.once("error", rejectStale);
    staleChild.once("close", () => resolveStale());
  });
  initialDb
    .prepare("INSERT OR REPLACE INTO oauth_request_lock (name, token, expires_at) VALUES ('dm_ipc_hub', ?, ?)")
    .run(formatHubLeaseToken(deadHubId, deadSockPath), Date.now() + HUB_LEASE_TTL_MS);
  assert.equal(existsSync(deadSockPath), true, "dead stale .sock file exists on disk before Worker A starts");

  // Start Worker A (in-process HTTP server) and Worker B (child Node --import tsx process)
  workerAServer = createOperatorApp().listen(0, "127.0.0.1");
  await once(workerAServer, "listening");
  const workerAUrl = `http://127.0.0.1:${(workerAServer.address() as AddressInfo).port}`;

  const spawned = await spawnWorkerB();
  workerBChild = spawned.child;
  const workerBUrl = spawned.url;

  const bobAuth = await mintGetChangesAuth(BOB_DID, bobKey);
  const dmSpace = dmConversationUri(ALICE_DID, "3kabcdefghij2");
  const bobInbox = dmInboxUri(BOB_DID);
  const bobToken = deriveDmNotifyToken(dmSpace, BOB_DID);
  const aliceToken = deriveDmNotifyToken(dmSpace, ALICE_DID);

  // 1. Initialize hub on Worker A (atomically taking over dead lease, unlinking deadSockPath, and binding its own unique v2 .sock with 0o600 permissions) and connect Worker B!
  const headOnA = await postGetChanges(workerAUrl, bobAuth, []);
  const headOnB = await postGetChanges(workerBUrl, bobAuth, []);
  assert.equal(headOnA.head, headOnB.head, "Worker A and Worker B share the exact same initial epoch and cursor head");
  const sockPath = dmWakeSocketPath()!;
  assert.notEqual(sockPath, deadSockPath, "new Hub binds a fresh unique v2 socket path");
  assert.match(sockPath, /flock-dm-v2-[0-9a-f]{16}-[0-9a-f]{12}\.sock$/);
  assert.equal(existsSync(deadSockPath), false, "crashed Hub's dead .sock file was atomically cleaned up upon takeover");
  const sockMode = statSync(sockPath).mode & 0o777;
  assert.equal(sockMode, 0o600, "Unix domain socket is restricted to owner-only 0o600 permissions");

  // 2. Worker B holds a getChanges long-poll for Bob's DM space; notifySpaceUpdate hits Worker A with Bob's dm1 token ->
  //    Worker B wakes immediately (< 1.5s, well below the 25s holdMs) with changed: [dmSpace]!
  const startedPollB = Date.now();
  const pendingPollOnB = postGetChanges(workerBUrl, bobAuth, [
    { space: dmSpace, after: headOnA.head },
    { space: bobInbox, after: headOnA.head },
  ]);

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));

  // Verify Alice's dm1 token hitting Worker A does NOT wake Bob's held long-poll on Worker B!
  const aliceWebhookRes = await postNotifyUpdate(workerAUrl, dmSpace, aliceToken, ALICE_DID);
  assert.equal(aliceWebhookRes.status, 200);
  const racedAlice = await Promise.race([
    pendingPollOnB.then(() => "woke" as const),
    new Promise<"still-holding">((resolveTimer) => setTimeout(() => resolveTimer("still-holding"), 150)),
  ]);
  assert.equal(racedAlice, "still-holding", "Alice's dm1 webhook on Worker A MUST NOT wake Bob's long-poll on Worker B");

  // Now deliver Bob's dm1 webhook to Worker A -> Worker B wakes immediately!
  const bobWebhookOnA = await postNotifyUpdate(workerAUrl, dmSpace, bobToken, ALICE_DID);
  assert.equal(bobWebhookOnA.status, 200);
  const answerFromB = await pendingPollOnB;
  const elapsedB = Date.now() - startedPollB;
  assert.ok(elapsedB < 3_000, `expected Worker B long-poll to wake immediately (<3s, vs 25s hold), took ${elapsedB}ms`);
  assert.deepEqual(answerFromB.changed.map((c) => c.space), [dmSpace]);
  assert.deepEqual(answerFromB.reset, []);
  const cursor1 = answerFromB.changed[0]!.cursor;

  // 3. Reverse direction: Worker A holds a getChanges long-poll while notifySpaceUpdate hits Worker B (IPC client) ->
  //    Worker A wakes immediately with changed: [dmSpace] and zero resets!
  const startedPollA = Date.now();
  const pendingPollOnA = postGetChanges(workerAUrl, bobAuth, [
    { space: dmSpace, after: cursor1 },
    { space: bobInbox, after: headOnA.head },
  ]);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  const bobWebhookOnB = await postNotifyUpdate(workerBUrl, dmSpace, bobToken, ALICE_DID);
  assert.equal(bobWebhookOnB.status, 200);
  const answerFromA = await pendingPollOnA;
  assert.ok(Date.now() - startedPollA < 3_000, "Worker A long-poll wakes immediately from webhook handled by Worker B");
  assert.deepEqual(answerFromA.changed.map((c) => c.space), [dmSpace]);
  assert.deepEqual(answerFromA.reset, []);
  const cursor2 = answerFromA.changed[0]!.cursor;

  // 4. Alternating getChanges polls between Worker A and Worker B share the exact same epoch with ZERO spurious resets!
  const epochOf = (cursor: string) => cursor.split(".")[0];
  assert.equal(epochOf(headOnA.head), epochOf(cursor1));
  assert.equal(epochOf(cursor1), epochOf(cursor2));

  for (const [idx, workerUrl] of [workerAUrl, workerBUrl, workerAUrl, workerBUrl].entries()) {
    const abortAfterShortHold = new AbortController();
    const timer = setTimeout(() => abortAfterShortHold.abort(), 120);
    try {
      const pollRes = await postGetChanges(
        workerUrl,
        bobAuth,
        [{ space: dmSpace, after: cursor2 }],
        abortAfterShortHold.signal,
      );
      assert.deepEqual(pollRes.reset, [], `alternating poll ${idx} had zero resets`);
      assert.equal(epochOf(pollRes.head), epochOf(headOnA.head));
    } catch (err) {
      // Aborted after 120ms quiet hold (proving neither worker returned an immediate reset!)
      assert.equal((err as { name?: string }).name, "AbortError");
    } finally {
      clearTimeout(timer);
    }
    const quickHead = await postGetChanges(workerUrl, bobAuth, []);
    assert.equal(epochOf(quickHead.head), epochOf(headOnA.head), `worker ${idx} shares identical epoch`);
  }

  // 5. Verify ZERO DM rows exist in ANY SQLite table across DATABASE_PATH, and zero DM files exist in DIRECTORY!
  const db = getRawDb();
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>)
    .map((r) => r.name);
  for (const table of tables) {
    const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
    for (const col of cols) {
      const hit = db.prepare(`SELECT 1 FROM ${table} WHERE CAST(${col} AS TEXT) LIKE '%new.flock.dm.%' LIMIT 1`).get();
      assert.equal(hit, undefined, `expected zero DM entries in ${table}.${col}`);
      const didHit = db.prepare(`SELECT 1 FROM ${table} WHERE CAST(${col} AS TEXT) LIKE ? OR CAST(${col} AS TEXT) LIKE ? LIMIT 1`)
        .get(`%${ALICE_DID}%`, `%${BOB_DID}%`);
      assert.equal(didHit, undefined, `expected zero DM participant DIDs in ${table}.${col}`);
    }
  }
  const dirFiles = readdirSync(DIRECTORY);
  assert.ok(dirFiles.every((name) => name.startsWith("multiproc.db")), `expected only SQLite DB files in ${DIRECTORY}, saw ${dirFiles.join(", ")}`);

  // 5b. Live Hub socket protection: a peer with wrong AUTH_ENCRYPTION_KEY (or oversized/invalid frame) fails handshake as
  //     "protocol_failed" and MUST NEVER unlink the live Hub's .sock file!
  const liveSockInode = statSync(sockPath).ino;
  const wakesModule = fileURLToPath(new URL("./dm-feed-wakes.ts", import.meta.url));
  await new Promise<void>((resolveRogue, rejectRogue) => {
    const rogueScript = `
      import { ensureDmWakeReady } from ${JSON.stringify(wakesModule)};
      await ensureDmWakeReady();
      await ensureDmWakeReady();
      process.exit(0);
    `;
    const rogue = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", rogueScript], {
      cwd: process.cwd(),
      env: { ...process.env, AUTH_ENCRYPTION_KEY: "ff".repeat(32) },
      stdio: "ignore",
    });
    rogue.once("error", rejectRogue);
    rogue.once("close", (code) => {
      if (code === 0) resolveRogue();
      else rejectRogue(new Error(`Rogue worker exited with code ${code}`));
    });
  });
  // Also send an oversized frame header directly to the live hub socket and wait for close
  await new Promise<void>((resolveOversized) => {
    const badSock = net.createConnection(sockPath, () => {
      const badHeader = Buffer.alloc(40, 0xff);
      badSock.write(badHeader);
    });
    badSock.resume();
    badSock.once("close", () => resolveOversized());
    badSock.on("error", () => undefined);
  });
  assert.equal(existsSync(sockPath), true, "live Hub .sock file remains on disk after refused auth/protocol handshakes");
  assert.equal(statSync(sockPath).ino, liveSockInode, "live Hub .sock inode was NEVER unlinked or rebound");

  // 5c. Chunked IPC snapshot sync across >300 (callerDid, space) entries (including >250 spaces on one caller split across
  //     snapshot_chunk frames!) + global maxSpaces eviction replication to newly joined Worker C and existing Worker B!
  const aliceAuth = await mintGetChangesAuth(ALICE_DID, aliceKey);
  const bobSpaces = Array.from({ length: 280 }, (_, idx) => dmConversationUri(ALICE_DID, tidNow(1_700_000_000_000 + idx * 1_000)));
  const aliceSpaces = Array.from({ length: 70 }, (_, idx) => dmConversationUri(BOB_DID, tidNow(1_701_000_000_000 + idx * 1_000)));
  for (const sp of bobSpaces) await recordDmWake(BOB_DID, sp);
  for (const sp of aliceSpaces) await recordDmWake(ALICE_DID, sp);

  const spawnedC = await spawnWorkerB();
  try {
    const bobCheckFirstChunk = await postGetChanges(
      spawnedC.url,
      bobAuth,
      bobSpaces.slice(0, 150).map((space) => ({ space, after: headOnA.head })),
    );
    assert.equal(bobCheckFirstChunk.changed.length, 150, "Worker C synced first chunk of Bob's spaces");
    assert.deepEqual(bobCheckFirstChunk.reset, []);

    const bobCheckSecondChunk = await postGetChanges(
      spawnedC.url,
      bobAuth,
      bobSpaces.slice(150, 280).map((space) => ({ space, after: headOnA.head })),
    );
    assert.equal(bobCheckSecondChunk.changed.length, 130, "Worker C merged second split chunk of Bob's 280 spaces");
    assert.deepEqual(bobCheckSecondChunk.reset, []);

    const aliceCheckChunk = await postGetChanges(
      spawnedC.url,
      aliceAuth,
      aliceSpaces.map((space) => ({ space, after: headOnA.head })),
    );
    assert.equal(aliceCheckChunk.changed.length, 70, "Worker C synced Alice's 70 spaces across snapshot chunks (>350 total)");
    assert.deepEqual(aliceCheckChunk.reset, []);

    // Verify global aggregate maxSpaces eviction replicates cleanly from Hub to replicas (Worker B & Worker C)
    resetDmFeedWakesForTests({ maxSpaces: 4 });
    const freshBobHead = (await postGetChanges(workerAUrl, bobAuth, [])).head;
    const freshAliceHead = (await postGetChanges(workerAUrl, aliceAuth, [])).head;
    await recordDmWake(BOB_DID, bobSpaces[0]!);
    await recordDmWake(BOB_DID, bobSpaces[1]!);
    await recordDmWake(ALICE_DID, aliceSpaces[0]!);
    await recordDmWake(ALICE_DID, aliceSpaces[1]!);
    await recordDmWake(ALICE_DID, aliceSpaces[2]!); // 5th entry -> evicts oldest (BOB_DID, bobSpaces[0]) across cluster!

    const bobOnReplica = await postGetChanges(spawnedC.url, bobAuth, [
      { space: bobSpaces[0]!, after: freshBobHead },
      { space: bobSpaces[1]!, after: freshBobHead },
    ]);
    assert.deepEqual(bobOnReplica.reset, [bobSpaces[0]!], "replica evicted oldest global space and reports reset");
    assert.deepEqual(bobOnReplica.changed.map((c) => c.space), [bobSpaces[1]!], "replica retained newer space");
    const aliceOnReplica = await postGetChanges(spawnedC.url, aliceAuth, [
      { space: aliceSpaces[0]!, after: freshAliceHead },
      { space: aliceSpaces[2]!, after: freshAliceHead },
    ]);
    assert.deepEqual(aliceOnReplica.reset, []);
    assert.equal(aliceOnReplica.changed.length, 2);
    resetDmFeedWakesForTests();
  } finally {
    if (spawnedC.child.exitCode === null) {
      spawnedC.child.kill("SIGTERM");
      await once(spawnedC.child, "close").catch(() => undefined);
    }
  }

  // Re-establish a cursor on the post-reset epoch before testing Hub exit in step 6!
  const preExitHead = (await postGetChanges(workerBUrl, bobAuth, [])).head;
  await postNotifyUpdate(workerAUrl, dmSpace, bobToken, ALICE_DID);
  const preExitWake = await postGetChanges(workerBUrl, bobAuth, [{ space: dmSpace, after: preExitHead }]);
  const preExitCursor = preExitWake.changed[0]!.cursor;

  // 6. When Hub (Worker A) exits, Worker B detects hub loss, rotates epoch (triggering clean reset), and re-elects itself as Hub!
  closeDb();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  const afterHubExit = await postGetChanges(workerBUrl, bobAuth, [{ space: dmSpace, after: preExitCursor }]);
  assert.deepEqual(afterHubExit.reset, [dmSpace], "Worker B triggers clean reset when Hub exits");
  assert.notEqual(epochOf(afterHubExit.head), epochOf(preExitCursor), "new elected Hub epoch differs from exited Hub epoch");

  // Clean up Worker A HTTP server and Worker B child before next multi-process test
  if (workerBChild && workerBChild.exitCode === null) {
    workerBChild.kill("SIGTERM");
    await once(workerBChild, "close").catch(() => undefined);
    workerBChild = undefined;
  }
  if (workerAServer) {
    await closeHttpServer(workerAServer);
    workerAServer = undefined;
  }

  // Ensure net import is used
  assert.equal(typeof net.createConnection, "function");
});

test("R3-M1 & R3-M2: concurrent multi-worker election never split-brains, v1 peers negotiate snapshot fallback, duplicate opIds are idempotent, and 3-worker Hub failover resends mid-flight recordDmWake through newly elected Hub C", { timeout: 25_000 }, async () => {
  const bobAuth = await mintGetChangesAuth(BOB_DID, bobKey);
  const ipcKey = Buffer.from(hkdfSync("sha256", Buffer.from(KEY_HEX, "hex"), "", "flock-dm-ipc-v2", 32));
  const encodeRawFrame = (frame: Record<string, unknown>): Buffer => {
    const payload = Buffer.from(JSON.stringify(frame), "utf8");
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(payload.byteLength, 0);
    const mac = createHmac("sha256", ipcKey).update(payload).digest();
    return Buffer.concat([header, mac, payload]);
  };

  // 1. R3-M1: 4 concurrent workers starting simultaneously against a vacant lease elect strictly ONE Hub and share ONE epoch!
  getRawDb().prepare("DELETE FROM oauth_request_lock WHERE name = 'dm_ipc_hub'").run();
  const inProcServer1 = createOperatorApp().listen(0, "127.0.0.1");
  await once(inProcServer1, "listening");
  const inProcUrl1 = `http://127.0.0.1:${(inProcServer1.address() as AddressInfo).port}`;
  const children = await Promise.all([spawnWorkerB(), spawnWorkerB(), spawnWorkerB()]);
  try {
    const heads = await Promise.all([
      postGetChanges(inProcUrl1, bobAuth, []),
      postGetChanges(children[0]!.url, bobAuth, []),
      postGetChanges(children[1]!.url, bobAuth, []),
      postGetChanges(children[2]!.url, bobAuth, []),
    ]);
    const distinctHeads = new Set(heads.map((h) => h.head));
    assert.equal(distinctHeads.size, 1, `expected all 4 concurrent workers to share 1 epoch/head, got ${[...distinctHeads].join(", ")}`);

    const leaseRow = getRawDb()
      .prepare("SELECT token, expires_at FROM oauth_request_lock WHERE name = 'dm_ipc_hub'")
      .get() as { token: string; expires_at: number } | undefined;
    assert.ok(leaseRow && leaseRow.expires_at > Date.now(), "active dm_ipc_hub lease recorded in oauth_request_lock");
    assert.match(leaseRow.token, /^v2\|[0-9a-f]{12}\|.*flock-dm-v2-[0-9a-f]{16}-[0-9a-f]{12}\.sock$/);
    const electedSockPath = leaseRow.token.split("|")[2]!;
    assert.equal(existsSync(electedSockPath), true, "winning Hub's unique socket exists on disk");

    // 2. R3-M1 & R3-M2 wire checks: v1 auth handshake negotiates single-frame `snapshot`, and duplicate `opId` retries are idempotent!
    const dupSpace = dmConversationUri(ALICE_DID, tidNow(1_702_000_000_000));
    const baseHead = heads[0]!.head;
    await new Promise<void>((resolveWire, rejectWire) => {
      const sock = net.createConnection(electedSockPath);
      let buf = Buffer.alloc(0);
      const received: Array<Record<string, unknown>> = [];
      sock.on("error", rejectWire);
      sock.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.byteLength >= 36) {
          const len = buf.readUInt32BE(0);
          if (buf.byteLength < 36 + len) return;
          const body = JSON.parse(buf.subarray(36, 36 + len).toString("utf8")) as Record<string, unknown>;
          buf = buf.subarray(36 + len);
          received.push(body);
          if (body.type === "challenge") {
            assert.equal(body.version, 2, "Hub advertises protocol version 2 in challenge");
            // Omit `version` to simulate a v1 peer -> Hub must answer with single-frame `snapshot`!
            sock.write(encodeRawFrame({ type: "auth", nonce: body.nonce }));
          } else if (body.type === "snapshot") {
            // Send 3 `record_wake` frames carrying the EXACT SAME `opId`!
            for (const reqId of [101, 102, 103]) {
              sock.write(
                encodeRawFrame({
                  type: "record_wake",
                  reqId,
                  opId: "idempotent-op-000000000001",
                  callerDid: BOB_DID,
                  space: dupSpace,
                  nowMs: Date.now(),
                }),
              );
            }
          } else if (body.type === "wake") {
            sock.write(encodeRawFrame({ type: "wake_ack", bcastId: body.bcastId }));
          } else if (body.type === "record_ok" && body.reqId === 103) {
            sock.destroy();
            resolveWire();
          }
        }
      });
    });

    const afterDup = await postGetChanges(children[1]!.url, bobAuth, [{ space: dupSpace, after: baseHead }]);
    assert.deepEqual(afterDup.changed.map((c) => c.space), [dupSpace]);
    const headSeq = Number.parseInt(afterDup.head.split(".")[2]!, 36);
    assert.equal(headSeq, 1, "3 retries with identical opId incremented caller head strictly once");
  } finally {
    for (const c of children) {
      if (c.child.exitCode === null && c.child.signalCode === null) {
        c.child.kill("SIGTERM");
        await once(c.child, "close").catch(() => undefined);
      }
    }
    await closeHttpServer(inProcServer1);
    closeDb();
  }

  // 3. R3-M2: 3-worker failover (Hub A + Client B + Client C):
  //    Kill Hub A while Client B has an in-flight `recordDmWake` AND Worker C wins hub election ->
  //    Client B resends `opId` through newly elected Hub C so BOTH Client B and Hub C observe the wake with zero divergence!
  getRawDb().prepare("DELETE FROM oauth_request_lock WHERE name = 'dm_ipc_hub'").run();

  // Start Hub A (child process) and elect it as Hub
  const hubAChild = await spawnWorkerB();
  const hubAInitial = await postGetChanges(hubAChild.url, bobAuth, []);

  // Start Client B (in-process) and connect it to Hub A as IPC client
  const clientBServer = createOperatorApp().listen(0, "127.0.0.1");
  await once(clientBServer, "listening");
  const clientBUrl = `http://127.0.0.1:${(clientBServer.address() as AddressInfo).port}`;
  await ensureDmWakeReady();
  const clientBInitial = await postGetChanges(clientBUrl, bobAuth, []);
  assert.equal(clientBInitial.head, hubAInitial.head, "Client B connected to Hub A and synced initial epoch");

  // Pre-spawn Worker C warm (before it connects to IPC) so promotion takes <10ms without racing IPC_RPC_TIMEOUT_MS!
  const hubCChild = await spawnWorkerB();
  let resumeKillSafetyTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Freeze Hub A with SIGSTOP so Client B's record_wake sits genuinely in-flight on the socket!
    process.kill(hubAChild.child.pid!, "SIGSTOP");
    resumeKillSafetyTimer = setTimeout(() => {
      try {
        process.kill(hubAChild.child.pid!, "SIGKILL");
      } catch {
        // Ignore if already exited.
      }
    }, 5_000);
    resumeKillSafetyTimer.unref?.();

    const failoverSpace = dmConversationUri(ALICE_DID, tidNow(1_703_000_000_000));
    const inFlightWakeOnB = recordDmWake(BOB_DID, failoverSpace);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 35));

    // Expire Hub A's SQLite lease and promote warm Worker C so Worker C deterministically wins election as Hub C!
    getRawDb().prepare("UPDATE oauth_request_lock SET expires_at = 0 WHERE name = 'dm_ipc_hub'").run();
    const hubCInitial = await postGetChanges(hubCChild.url, bobAuth, []);
    assert.notEqual(hubCInitial.head.split(".")[0], hubAInitial.head.split(".")[0], "Worker C elected itself as new Hub C");

    // Now SIGKILL frozen Hub A -> Client B's in-flight request rejects on socket close, reconnects to Hub C, and resends opId!
    process.kill(hubAChild.child.pid!, "SIGKILL");
    await once(hubAChild.child, "close").catch(() => undefined);

    await inFlightWakeOnB;

    const [observedOnHubC, observedOnClientB] = await Promise.all([
      postGetChanges(hubCChild.url, bobAuth, [{ space: failoverSpace, after: hubCInitial.head }]),
      postGetChanges(clientBUrl, bobAuth, [{ space: failoverSpace, after: hubCInitial.head }]),
    ]);
    assert.deepEqual(observedOnHubC.changed.map((c) => c.space), [failoverSpace], "Hub C received resent wake from Client B");
    assert.deepEqual(observedOnClientB.changed.map((c) => c.space), [failoverSpace], "Client B observed identical wake from Hub C");
    assert.equal(observedOnHubC.head, observedOnClientB.head, "Client B and Hub C share identical head after mid-flight failover");
    assert.equal(
      observedOnHubC.changed[0]!.cursor,
      observedOnClientB.changed[0]!.cursor,
      "Client B and Hub C report identical cursor for resent wake",
    );
  } finally {
    if (resumeKillSafetyTimer) clearTimeout(resumeKillSafetyTimer);
    if (hubAChild.child.exitCode === null && hubAChild.child.signalCode === null) {
      hubAChild.child.kill("SIGKILL");
      await once(hubAChild.child, "close").catch(() => undefined);
    }
    if (hubCChild.child.exitCode === null && hubCChild.child.signalCode === null) {
      hubCChild.child.kill("SIGTERM");
      await once(hubCChild.child, "close").catch(() => undefined);
    }
    await closeHttpServer(clientBServer);
  }
});
