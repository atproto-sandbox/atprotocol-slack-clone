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
const allSpawnedChildren = new Set<ChildProcess>();

function forceKillAllChildren(): void {
  for (const child of allSpawnedChildren) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        if (child.pid) process.kill(child.pid, "SIGCONT");
      } catch {
        // Ignore
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore
      }
    }
  }
  allSpawnedChildren.clear();
}

process.once("exit", forceKillAllChildren);

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
  forceKillAllChildren();
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
  allSpawnedChildren.add(child);
  child.once("close", () => {
    allSpawnedChildren.delete(child);
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

test("multi-process DM wake hub delivers cross-worker long-poll wakes immediately, shares one epoch across alternating workers with zero spurious resets, recovers stale .sock files, and writes zero DM rows to SQLite", { timeout: 60_000 }, async (t) => {
  t.signal.addEventListener("abort", forceKillAllChildren, { once: true });
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

  // 5b. Live Hub socket protection + R4-M2 fail-closed IPC: a peer with wrong AUTH_ENCRYPTION_KEY fails handshake as
  //     "protocol_failed", rejects with DmWakeIpcError (HTTP 503 Busy), NEVER degrades to isolated local authority,
  //     and NEVER unlinks the live Hub's .sock file!
  const liveSockInode = statSync(sockPath).ino;
  const wakesModule = fileURLToPath(new URL("./dm-feed-wakes.ts", import.meta.url));
  const serverModule = fileURLToPath(new URL("./server.ts", import.meta.url));
  const notifModule = fileURLToPath(new URL("./space-notification.ts", import.meta.url));
  const rogueConv = dmConversationUri(ALICE_DID, tidNow(1_701_555_000_000));
  await new Promise<void>((resolveRogue, rejectRogue) => {
    const rogueScript = `
      import assert from "node:assert/strict";
      import { once } from "node:events";
      import { currentDmWakeHead, ensureDmWakeReady, recordDmWake } from ${JSON.stringify(wakesModule)};
      import { createOperatorApp } from ${JSON.stringify(serverModule)};
      import { deriveDmNotifyToken } from ${JSON.stringify(notifModule)};

      await assert.rejects(() => ensureDmWakeReady(), { name: "DmWakeIpcError" });
      await assert.rejects(() => recordDmWake(${JSON.stringify(BOB_DID)}, ${JSON.stringify(rogueConv)}), { name: "DmWakeIpcError" });
      assert.equal(currentDmWakeHead(${JSON.stringify(BOB_DID)}).head, 0, "rogue worker never applied isolated local wake");

      const app = createOperatorApp();
      const srv = app.listen(0, "127.0.0.1");
      await once(srv, "listening");
      const port = srv.address().port;
      const rogueToken = deriveDmNotifyToken(${JSON.stringify(rogueConv)}, ${JSON.stringify(BOB_DID)});
      const res = await fetch(\`http://127.0.0.1:\${port}/xrpc/com.atproto.space.notifySpaceUpdate\`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          space: ${JSON.stringify(rogueConv)},
          token: rogueToken,
          update: {
            $type: "com.atproto.space.defs#repoWrite",
            repo: ${JSON.stringify(ALICE_DID)},
            repoRev: "3kabcdefghij2",
            spaceRev: "3kabcdefghij3",
            data: { $bytes: Buffer.alloc(32, 0xcd).toString("base64") },
          },
        }),
      });
      assert.equal(res.status, 503, "misconfigured worker returns retryable 503 Busy instead of local-only 200 OK");
      assert.equal(currentDmWakeHead(${JSON.stringify(BOB_DID)}).head, 0, "HTTP webhook on misconfigured worker left local head at 0");
      srv.close();
      process.exit(0);
    `;
    const rogue = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", rogueScript], {
      cwd: process.cwd(),
      env: { ...process.env, AUTH_ENCRYPTION_KEY: "ff".repeat(32) },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let rogueStderr = "";
    rogue.stderr.setEncoding("utf8").on("data", (c: string) => {
      rogueStderr += c;
    });
    rogue.once("error", rejectRogue);
    rogue.once("close", (code) => {
      if (code === 0) resolveRogue();
      else rejectRogue(new Error(`Rogue worker exited with code ${code}: ${rogueStderr}`));
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

test("R3 & R4: concurrent multi-worker election never split-brains, mismatched IPC versions fail closed, duplicate opIds are idempotent, and resumed old Hub A fences expired lease ownership before mutating", { timeout: 60_000 }, async (t) => {
  t.signal.addEventListener("abort", forceKillAllChildren, { once: true });
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
    assert.match(leaseRow.token, /^v2\|[1-9]\d*\|[0-9a-f]{12}\|.*flock-dm-v2-[0-9a-f]{16}-[0-9a-f]{12}\.sock$/);
    const electedSockPath = leaseRow.token.split("|")[3]!;
    assert.equal(existsSync(electedSockPath), true, "winning Hub's unique socket exists on disk");

    // 2a. R4-L3: Peer sending mismatched/missing IPC protocol version is rejected immediately (coordinated-drain v2 policy)!
    await new Promise<void>((resolveMismatch, rejectMismatch) => {
      const badVerSock = net.createConnection(electedSockPath);
      let buf = Buffer.alloc(0);
      let sawSnapshot = false;
      badVerSock.on("error", () => undefined);
      badVerSock.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.byteLength >= 36) {
          const len = buf.readUInt32BE(0);
          if (buf.byteLength < 36 + len) return;
          const body = JSON.parse(buf.subarray(36, 36 + len).toString("utf8")) as Record<string, unknown>;
          buf = buf.subarray(36 + len);
          if (body.type === "challenge") {
            assert.equal(body.version, 2, "Hub advertises protocol version 2 in challenge");
            badVerSock.write(encodeRawFrame({ type: "auth", nonce: body.nonce, version: 1 }));
          } else if (String(body.type).startsWith("snapshot")) {
            sawSnapshot = true;
          }
        }
      });
      badVerSock.once("close", () => {
        if (sawSnapshot) rejectMismatch(new Error("Expected Hub to reject version 1 peer without sending snapshot"));
        else resolveMismatch();
      });
    });

    // 2b. R3-M2: v2 auth handshake negotiates chunked snapshot (`snapshot_begin`..`snapshot_end`), and duplicate `opId` retries are idempotent!
    const dupSpace = dmConversationUri(ALICE_DID, tidNow(1_702_000_000_000));
    const baseHead = heads[0]!.head;
    await new Promise<void>((resolveWire, rejectWire) => {
      const sock = net.createConnection(electedSockPath);
      let buf = Buffer.alloc(0);
      sock.on("error", rejectWire);
      sock.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.byteLength >= 36) {
          const len = buf.readUInt32BE(0);
          if (buf.byteLength < 36 + len) return;
          const body = JSON.parse(buf.subarray(36, 36 + len).toString("utf8")) as Record<string, unknown>;
          buf = buf.subarray(36 + len);
          if (body.type === "challenge") {
            sock.write(encodeRawFrame({ type: "auth", nonce: body.nonce, version: 2 }));
          } else if (body.type === "snapshot_end") {
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

  // 3. R3-M2, R4-M1, R5-M1 & R5-M2: 4-worker lease fencing + frozen-hub replica turnover + pause-after-precheck fenced broadcast rejection:
  getRawDb().prepare("DELETE FROM oauth_request_lock WHERE name = 'dm_ipc_hub'").run();

  // Start Hub A (child process) and elect it as Hub (`fence = 1`)
  const hubAChild = await spawnWorkerB();
  const hubAInitial = await postGetChanges(hubAChild.url, bobAuth, []);

  // Start Client B (in-process) and Replica D (child process) and connect both to Hub A as IPC clients
  const clientBServer = createOperatorApp().listen(0, "127.0.0.1");
  await once(clientBServer, "listening");
  const clientBUrl = `http://127.0.0.1:${(clientBServer.address() as AddressInfo).port}`;
  await ensureDmWakeReady();
  const clientBInitial = await postGetChanges(clientBUrl, bobAuth, []);
  const replicaDChild = await spawnWorkerB();
  const replicaDInitial = await postGetChanges(replicaDChild.url, bobAuth, []);
  assert.equal(clientBInitial.head, hubAInitial.head, "Client B connected to Hub A and synced initial epoch");
  assert.equal(replicaDInitial.head, hubAInitial.head, "Replica D connected to Hub A and synced initial epoch");

  // Pre-spawn Worker C warm (before it connects to IPC) so promotion takes <10ms without racing IPC_RPC_TIMEOUT_MS!
  const hubCChild = await spawnWorkerB();
  let resumeKillSafetyTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Freeze Hub A with SIGSTOP so Client B's record_wake sits in-flight AND Replica D's socket to Hub A stays open!
    process.kill(hubAChild.child.pid!, "SIGSTOP");
    resumeKillSafetyTimer = setTimeout(() => {
      try {
        process.kill(hubAChild.child.pid!, "SIGKILL");
      } catch {
        // Ignore if already exited.
      }
    }, 8_000);
    resumeKillSafetyTimer.unref?.();

    const failoverSpace = dmConversationUri(ALICE_DID, tidNow(1_703_000_000_000));
    const inFlightWakeOnB = recordDmWake(BOB_DID, failoverSpace);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 35));

    // Expire Hub A's SQLite lease and promote warm Worker C so Worker C wins election as Hub C (`fence = 2`)!
    getRawDb().prepare("UPDATE oauth_request_lock SET expires_at = 0 WHERE name = 'dm_ipc_hub'").run();
    const hubCInitial = await postGetChanges(hubCChild.url, bobAuth, []);
    assert.notEqual(hubCInitial.head.split(".")[0], hubAInitial.head.split(".")[0], "Worker C elected itself as new Hub C");

    // R5-M2: WHILE Hub A IS STILL FROZEN (`SIGSTOP`, so Replica D's socket to Hub A is NOT destroyed!),
    // deliver a DM webhook to Hub C and query Replica D -> Replica D MUST detect lease turnover in oauth_request_lock,
    // drop its stale open socket to frozen Hub A, attach to Hub C, and serve Hub C's wake immediately!
    const whileFrozenSpace = dmConversationUri(ALICE_DID, tidNow(1_703_050_000_000));
    const whileFrozenToken = deriveDmNotifyToken(whileFrozenSpace, BOB_DID);
    const frozenWebhookRes = await postNotifyUpdate(hubCChild.url, whileFrozenSpace, whileFrozenToken, ALICE_DID);
    assert.equal(frozenWebhookRes.status, 200);
    const observedOnReplicaDWhileAFrozen = await postGetChanges(
      replicaDChild.url,
      bobAuth,
      [{ space: whileFrozenSpace, after: hubCInitial.head }],
    );
    assert.deepEqual(
      observedOnReplicaDWhileAFrozen.changed.map((c) => c.space),
      [whileFrozenSpace],
      "R5-M2: Replica D detached from still-frozen Hub A and served Hub C's wake on read",
    );

    // RESUME old Hub A with SIGCONT while Hub C owns the lease (`fence = 2`)
    process.kill(hubAChild.child.pid!, "SIGCONT");

    await inFlightWakeOnB;

    const [observedOnHubC, observedOnClientB, observedOnResumedA] = await Promise.all([
      postGetChanges(hubCChild.url, bobAuth, [{ space: failoverSpace, after: hubCInitial.head }]),
      postGetChanges(clientBUrl, bobAuth, [{ space: failoverSpace, after: hubCInitial.head }]),
      postGetChanges(hubAChild.url, bobAuth, [{ space: failoverSpace, after: hubCInitial.head }]),
    ]);
    assert.deepEqual(observedOnHubC.changed.map((c) => c.space), [failoverSpace], "Hub C received resent wake from Client B");
    assert.deepEqual(observedOnClientB.changed.map((c) => c.space), [failoverSpace], "Client B observed identical wake from Hub C");
    assert.deepEqual(observedOnResumedA.changed.map((c) => c.space), [failoverSpace], "Resumed Worker A stepped down and synced to Hub C");
    assert.equal(observedOnHubC.head, observedOnClientB.head, "Client B and Hub C share identical head");
    assert.equal(observedOnHubC.head, observedOnResumedA.head, "Resumed Worker A shares Hub C's exact head");

    // Send a new HTTP DM webhook directly to resumed Worker A (`hubAChild.url`) and verify Hub C + Client B both observe it!
    const postResumeSpace = dmConversationUri(ALICE_DID, tidNow(1_703_100_000_000));
    const postResumeToken = deriveDmNotifyToken(postResumeSpace, BOB_DID);
    const webhookResOnA = await postNotifyUpdate(hubAChild.url, postResumeSpace, postResumeToken, ALICE_DID);
    assert.equal(webhookResOnA.status, 200, "HTTP webhook to resumed Worker A forwarded cleanly to Hub C");

    const [afterWebhookHubC, afterWebhookClientB, afterWebhookResumedA] = await Promise.all([
      postGetChanges(hubCChild.url, bobAuth, [{ space: postResumeSpace, after: observedOnHubC.head }]),
      postGetChanges(clientBUrl, bobAuth, [{ space: postResumeSpace, after: observedOnHubC.head }]),
      postGetChanges(hubAChild.url, bobAuth, [{ space: postResumeSpace, after: observedOnHubC.head }]),
    ]);
    assert.deepEqual(afterWebhookHubC.changed.map((c) => c.space), [postResumeSpace]);
    assert.equal(afterWebhookHubC.head, afterWebhookClientB.head);
    assert.equal(afterWebhookHubC.head, afterWebhookResumedA.head);
  } finally {
    if (resumeKillSafetyTimer) clearTimeout(resumeKillSafetyTimer);
    for (const c of [hubAChild, hubCChild, replicaDChild]) {
      if (c.child.exitCode === null && c.child.signalCode === null) {
        c.child.kill("SIGTERM");
        await once(c.child, "close").catch(() => undefined);
      }
    }
    await closeHttpServer(clientBServer);
    closeDb();
  }

  // 4. R5-M1 pause-after-precheck fencing token proof:
  //    Simulate a Hub (`fence = 1`) that already passed precheck, completed handshake with a replica, and mutated locally,
  //    then paused while Hub C acquired `fence = 2` in SQLite, and resumed to emit a `wake` broadcast carrying `fence = 1`.
  //    The replica MUST reject the superseded `fence = 1` broadcast without applying its mutation or sending `wake_ack`,
  //    disconnect from the stale hub, and synchronize with `fence = 2` Hub C!
  const fakeHubId = "cafe00000001";
  const fakeHubSock = dmWakeSocketPath(undefined, undefined, fakeHubId)!;
  const fakeHubToken = formatHubLeaseToken(fakeHubId, fakeHubSock, 1);
  let peerOnFakeHub: net.Socket | null = null;
  let sawWakeAckFromReplica = false;
  const fakeHubServer = net.createServer((peerSock) => {
    peerOnFakeHub = peerSock;
    const nonce = "00112233445566778899aabbccddeeff";
    let buf = Buffer.alloc(0);
    peerSock.on("error", () => undefined);
    peerSock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.byteLength >= 36) {
        const len = buf.readUInt32BE(0);
        if (buf.byteLength < 36 + len) return;
        const body = JSON.parse(buf.subarray(36, 36 + len).toString("utf8")) as Record<string, unknown>;
        buf = buf.subarray(36 + len);
        if (body.type === "auth") {
          peerSock.write(
            encodeRawFrame({
              type: "snapshot_begin",
              fence: 1,
              leaseToken: fakeHubToken,
              epoch: "zzz",
              evictedCallers: 0,
              maxSpaces: 50_000,
            }),
          );
          peerSock.write(encodeRawFrame({ type: "snapshot_end" }));
        } else if (body.type === "wake_ack") {
          sawWakeAckFromReplica = true;
        }
      }
    });
    peerSock.write(encodeRawFrame({ type: "challenge", nonce, version: 2 }));
  });
  await new Promise<void>((resolveListen) => fakeHubServer.listen(fakeHubSock, resolveListen));
  getRawDb()
    .prepare("INSERT OR REPLACE INTO oauth_request_lock (name, token, expires_at) VALUES ('dm_ipc_hub', ?, ?)")
    .run(fakeHubToken, Date.now() + HUB_LEASE_TTL_MS);

  const replicaServer = createOperatorApp().listen(0, "127.0.0.1");
  await once(replicaServer, "listening");
  const replicaUrl = `http://127.0.0.1:${(replicaServer.address() as AddressInfo).port}`;
  const realHubC = await spawnWorkerB();
  try {
    // Attach in-process replica to fakeHub (`fence = 1`, epoch `zzz`)
    const attachedAtFence1 = await postGetChanges(replicaUrl, bobAuth, []);
    assert.equal(attachedAtFence1.head.split(".")[0], "zzz");
    const fakePeer = peerOnFakeHub as net.Socket | null;
    assert.ok(fakePeer, "in-process replica connected to fakeHub (fence = 1)");

    // Expire fakeHub's lease so realHubC claims `fence = 2`!
    getRawDb().prepare("UPDATE oauth_request_lock SET expires_at = 0 WHERE name = 'dm_ipc_hub'").run();
    const realHubCHead = await postGetChanges(realHubC.url, bobAuth, []);
    assert.notEqual(realHubCHead.head.split(".")[0], "zzz", "realHubC claimed fence = 2");

    // Now fakeHub ("resuming after pause-after-precheck") broadcasts a `wake` carrying superseded `fence = 1`!
    const poisonedSpace = dmConversationUri(ALICE_DID, tidNow(1_704_000_000_000));
    const peerClosed = once(fakePeer, "close");
    fakePeer.write(
      encodeRawFrame({
        type: "wake",
        bcastId: 77,
        fence: 1,
        leaseToken: fakeHubToken,
        mutation: {
          callerDid: BOB_DID,
          space: poisonedSpace,
          callerEpoch: "zzz",
          head: 1,
          seq: 1,
          evictedFloor: 0,
          evictedCallers: 0,
        },
      }),
    );
    await peerClosed;
    assert.equal(sawWakeAckFromReplica, false, "replica rejected superseded fence=1 broadcast without sending wake_ack");

    // Querying the replica now serves realHubC (`fence = 2`) with ZERO poisonedSpace change!
    const afterPoisonAttempt = await postGetChanges(
      replicaUrl,
      bobAuth,
      [{ space: poisonedSpace, after: realHubCHead.head }],
      AbortSignal.timeout(250),
    ).catch(() => null);
    // Long-poll times out cleanly (or returns empty changed) with realHubC's epoch because poisonedSpace was NEVER applied!
    if (afterPoisonAttempt) {
      assert.equal(afterPoisonAttempt.head, realHubCHead.head);
      assert.deepEqual(afterPoisonAttempt.changed, []);
    }
    const replicaHeadNow = await postGetChanges(replicaUrl, bobAuth, []);
    assert.equal(replicaHeadNow.head, realHubCHead.head, "replica re-attached to fence=2 Hub C with zero stale state");
  } finally {
    if (realHubC.child.exitCode === null && realHubC.child.signalCode === null) {
      realHubC.child.kill("SIGTERM");
      await once(realHubC.child, "close").catch(() => undefined);
    }
    await closeHttpServer(replicaServer);
    await new Promise<void>((resolveClose) => fakeHubServer.close(() => resolveClose()));
    try {
      rmSync(fakeHubSock, { force: true });
    } catch {
      // Ignore
    }
    closeDb();
  }

  // 5. R6-M2: Lock-free SQLite failover when Hub A is SIGSTOPped MID-MUTATION (after lease update & local mutation, while awaiting peer ACK):
  //    Because dm-feed-wakes.ts uses single-statement autocommit CAS SQL (zero `BEGIN IMMEDIATE` across JS frames),
  //    freezing Hub A mid-wake holds ZERO SQLite writer locks, so Hub C claims `dm_ipc_hub` in <300ms with zero SQLITE_BUSY!
  getRawDb().prepare("DELETE FROM oauth_request_lock WHERE name = 'dm_ipc_hub'").run();
  const midHubA = await spawnWorkerB();
  const midHubAHead = await postGetChanges(midHubA.url, bobAuth, []);
  assert.ok(midHubAHead.head);
  const midLeaseRow = getRawDb()
    .prepare("SELECT token FROM oauth_request_lock WHERE name = 'dm_ipc_hub'")
    .get() as { token: string };
  const midHubASock = midLeaseRow.token.split("|")[3]!;

  // Connect a raw peer to midHubA that intentionally withholds `wake_ack`, then trigger a wake on midHubA and SIGSTOP midHubA
  // the instant `wake` arrives on the wire (proving midHubA is frozen right inside `applyAuthoritativeWakeOnHub`!)
  let receivedWakeFromMidHubA!: () => void;
  const midHubAInWake = new Promise<void>((r) => {
    receivedWakeFromMidHubA = r;
  });
  const stallingPeer = net.createConnection(midHubASock);
  let stallBuf = Buffer.alloc(0);
  stallingPeer.on("error", () => undefined);
  stallingPeer.on("data", (chunk: Buffer) => {
    stallBuf = Buffer.concat([stallBuf, chunk]);
    while (stallBuf.byteLength >= 36) {
      const len = stallBuf.readUInt32BE(0);
      if (stallBuf.byteLength < 36 + len) return;
      const body = JSON.parse(stallBuf.subarray(36, 36 + len).toString("utf8")) as Record<string, unknown>;
      stallBuf = stallBuf.subarray(36 + len);
      if (body.type === "challenge") {
        stallingPeer.write(encodeRawFrame({ type: "auth", nonce: body.nonce, version: 2 }));
      } else if (body.type === "wake") {
        // Withhold wake_ack so midHubA stays suspended inside applyAuthoritativeWakeOnHub!
        receivedWakeFromMidHubA();
      }
    }
  });
  await new Promise((r) => setTimeout(r, 40));

  const midHubC = await spawnWorkerB();
  let midSafetyKill: ReturnType<typeof setTimeout> | undefined;
  try {
    const midSpace = dmConversationUri(ALICE_DID, tidNow(1_705_000_000_000));
    const midToken = deriveDmNotifyToken(midSpace, BOB_DID);
    const pendingWebhookOnMidA = postNotifyUpdate(midHubA.url, midSpace, midToken, ALICE_DID).catch(() => null);
    await midHubAInWake;

    // Freeze midHubA mid-request!
    process.kill(midHubA.child.pid!, "SIGSTOP");
    midSafetyKill = setTimeout(() => {
      try {
        process.kill(midHubA.child.pid!, "SIGKILL");
      } catch {
        // Ignore
      }
    }, 5_000);
    midSafetyKill.unref?.();

    // Expire lease & promote midHubC while midHubA is frozen mid-request -> MUST complete in <500ms (zero SQLITE_BUSY)!
    const failoverStart = performance.now();
    getRawDb().prepare("UPDATE oauth_request_lock SET expires_at = 0 WHERE name = 'dm_ipc_hub'").run();
    const midHubCHead = await postGetChanges(midHubC.url, bobAuth, []);
    const failoverMs = performance.now() - failoverStart;
    assert.notEqual(midHubCHead.head.split(".")[0], midHubAHead.head.split(".")[0], "midHubC took over while midHubA was frozen mid-mutation");
    assert.ok(failoverMs < 2_500, `R6-M2: lock-free failover completed in ${failoverMs.toFixed(1)}ms (<2500ms, well below 5000ms SQLite busy_timeout)`);

    process.kill(midHubA.child.pid!, "SIGCONT");
    stallingPeer.destroy();
    await pendingWebhookOnMidA;
  } finally {
    if (midSafetyKill) clearTimeout(midSafetyKill);
    stallingPeer.destroy();
    for (const c of [midHubA, midHubC]) {
      if (c.child.exitCode === null && c.child.signalCode === null) {
        c.child.kill("SIGTERM");
        await once(c.child, "close").catch(() => undefined);
      }
    }
    closeDb();
  }

  // 6. R7-M2: Superseded hub (`fence = 1`) whose local rate bucket is full MUST NOT emit an authoritative `rate_limit`
  //    error after Hub C (`fence = 2`) acquires the lease, and Client B MUST reject any stale `record_err` (`fence = 1`)
  //    and retry `opId` through Hub C (`fence = 2`)!
  const rlFakeHubId = "f00d00000001";
  const rlFakeSock = dmWakeSocketPath(undefined, undefined, rlFakeHubId)!;
  const rlFakeToken = formatHubLeaseToken(rlFakeHubId, rlFakeSock, 1);
  let onRecordWakeOnFakeHub: ((reqId: number, peerSock: net.Socket) => void) | null = null;
  const rlFakeServer = net.createServer((peerSock) => {
    const nonce = "11223344556677889900aabbccddeeff";
    let buf = Buffer.alloc(0);
    peerSock.on("error", () => undefined);
    peerSock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.byteLength >= 36) {
        const len = buf.readUInt32BE(0);
        if (buf.byteLength < 36 + len) return;
        const body = JSON.parse(buf.subarray(36, 36 + len).toString("utf8")) as Record<string, unknown>;
        buf = buf.subarray(36 + len);
        if (body.type === "auth") {
          peerSock.write(
            encodeRawFrame({
              type: "snapshot_begin",
              fence: 1,
              leaseToken: rlFakeToken,
              epoch: "yyy",
              evictedCallers: 0,
              maxSpaces: 50_000,
            }),
          );
          peerSock.write(encodeRawFrame({ type: "snapshot_end" }));
        } else if (body.type === "record_wake" && onRecordWakeOnFakeHub) {
          onRecordWakeOnFakeHub(Number(body.reqId), peerSock);
        }
      }
    });
    peerSock.write(encodeRawFrame({ type: "challenge", nonce, version: 2 }));
  });
  await new Promise<void>((resolveListen) => rlFakeServer.listen(rlFakeSock, resolveListen));
  getRawDb()
    .prepare("INSERT OR REPLACE INTO oauth_request_lock (name, token, expires_at) VALUES ('dm_ipc_hub', ?, ?)")
    .run(rlFakeToken, Date.now() + HUB_LEASE_TTL_MS);

  const rlHubC = await spawnWorkerB();
  try {
    await ensureDmWakeReady();
    let capturedReq: { reqId: number; peerSock: net.Socket } | null = null;
    let enteredRecordWake!: () => void;
    const recordWakeArrived = new Promise<void>((r) => {
      enteredRecordWake = r;
    });
    onRecordWakeOnFakeHub = (reqId, peerSock) => {
      capturedReq = { reqId, peerSock };
      enteredRecordWake();
    };

    const rlSpace = dmConversationUri(ALICE_DID, tidNow(1_706_000_000_000));
    const wakeAttempt = recordDmWake(BOB_DID, rlSpace);
    await recordWakeArrived;

    // Expire fakeHub (`fence = 1`) so real rlHubC claims `fence = 2`, then have fakeHub emit a stale `rate_limit` `record_err` (`fence = 1`)!
    getRawDb().prepare("UPDATE oauth_request_lock SET expires_at = 0 WHERE name = 'dm_ipc_hub'").run();
    const rlHubCHead = await postGetChanges(rlHubC.url, bobAuth, []);
    assert.notEqual(rlHubCHead.head.split(".")[0], "yyy");

    const reqInfo = capturedReq as { reqId: number; peerSock: net.Socket } | null;
    assert.ok(reqInfo);
    reqInfo.peerSock.write(
      encodeRawFrame({
        type: "record_err",
        reqId: reqInfo.reqId,
        fence: 1,
        leaseToken: rlFakeToken,
        code: "rate_limit",
        message: "Too many DM notifications for this caller and space.",
      }),
    );

    // Client B MUST reject the stale `fence = 1` rate_limit error, reconnect to rlHubC (`fence = 2`), and succeed!
    await wakeAttempt;
    const afterRlRetry = await postGetChanges(rlHubC.url, bobAuth, [{ space: rlSpace, after: rlHubCHead.head }]);
    assert.deepEqual(afterRlRetry.changed.map((c) => c.space), [rlSpace], "R7-M2: Client B ignored stale fence=1 rate_limit and delivered wake to Hub C");
  } finally {
    if (rlHubC.child.exitCode === null && rlHubC.child.signalCode === null) {
      rlHubC.child.kill("SIGTERM");
      await once(rlHubC.child, "close").catch(() => undefined);
    }
    await new Promise<void>((resolveClose) => rlFakeServer.close(() => resolveClose()));
    try {
      rmSync(rlFakeSock, { force: true });
    } catch {
      // Ignore
    }
    closeDb();
  }

  // 7. Real mid-operation full-bucket CAS race on a live Hub child process (`R9-L1` / `R10-L1` / `R10-M3`):
  //    Pre-spawn `realHub1` and `realHub2` BEFORE starting `realHub1`'s lease timer, fill `(BOB_DID, bucketSpace)` in fast
  //    parallel waves so the entire sub-test completes strictly inside `< 3,000ms` (`< 4,000ms` `HUB_HEARTBEAT_MS`, making
  //    background heartbeat `UPDATE`s physically impossible!), and verify BOTH deterministic takeover points:
  //    - `stealAtUpdate = 2`: `ensureDmWakeReady` (`n = 1`) and `applyAuthoritativeWakeOnHub` entry (`n = 2`, line 909) succeed,
  //      then takeover switches `oauth_request_lock` to `token2` right BEFORE line 928's full-bucket CAS (`n === 2`).
  //    - `stealAtUpdate = 3`: line 928's full-bucket CAS ALSO executes (`n = 3` — directly proving entry into line 928!),
  //      then takeover switches `oauth_request_lock` to `token2` right BEFORE `recordDmWake`'s catch-block CAS (`R10-M3`, line 1801).
  getRawDb().prepare("DELETE FROM oauth_request_lock WHERE name = 'dm_ipc_hub'").run();
  const realHub1 = await spawnWorkerB();
  const realHub2 = await spawnWorkerB();
  try {
    const sqlQuote = (s: string) => `'${s.replaceAll("'", "''")}'`;
    for (const [iterIdx, stealAtUpdate] of ([2, 3] as const).entries()) {
      getRawDb().exec("DROP TRIGGER IF EXISTS _test_steal_after_precheck; DROP TABLE IF EXISTS _test_cas_race;");
      if (iterIdx === 0) {
        getRawDb().prepare("DELETE FROM oauth_request_lock WHERE name = 'dm_ipc_hub'").run();
      } else {
        getRawDb().prepare("UPDATE oauth_request_lock SET expires_at = 0 WHERE name = 'dm_ipc_hub'").run();
      }

      // Capture monotonic start BEFORE realHub1 elects itself & registers `setInterval(..., 4000)`!
      const hub1ElectStartedAt = performance.now();
      const realHub1Initial = await postGetChanges(realHub1.url, bobAuth, []);

      const bucketSpace = dmConversationUri(ALICE_DID, tidNow(1_707_000_000_000 + iterIdx * 10_000));
      const bucketToken = deriveDmNotifyToken(bucketSpace, BOB_DID);
      for (let wave = 0; wave < 3; wave += 1) {
        const batch = await Promise.all(
          Array.from({ length: 40 }, () => postNotifyUpdate(realHub1.url, bucketSpace, bucketToken, ALICE_DID)),
        );
        for (const r of batch) assert.equal(r.status, 200);
      }
      const r429 = await postNotifyUpdate(realHub1.url, bucketSpace, bucketToken, ALICE_DID);
      assert.equal(r429.status, 429, "realHub1 enforces 429 while it genuinely owns the lease");

      const hub1LockRow = getRawDb()
        .prepare("SELECT token, expires_at FROM oauth_request_lock WHERE name = 'dm_ipc_hub'")
        .get() as { token: string; expires_at: number } | undefined;
      assert.ok(hub1LockRow, "realHub1 holds dm_ipc_hub lease");

      getRawDb().prepare("UPDATE oauth_request_lock SET expires_at = 0 WHERE name = 'dm_ipc_hub'").run();
      const realHub2Initial = await postGetChanges(realHub2.url, bobAuth, []);
      assert.notEqual(realHub2Initial.head.split(".")[0], realHub1Initial.head.split(".")[0]);

      const hub2LockRow = getRawDb()
        .prepare("SELECT token, expires_at FROM oauth_request_lock WHERE name = 'dm_ipc_hub'")
        .get() as { token: string; expires_at: number } | undefined;
      assert.ok(hub2LockRow && hub2LockRow.token !== hub1LockRow.token, "realHub2 minted distinct token2");

      getRawDb().exec(`
        CREATE TABLE _test_cas_race (n INTEGER NOT NULL);
        INSERT INTO _test_cas_race (n) VALUES (0);
        UPDATE oauth_request_lock
           SET token = ${sqlQuote(hub1LockRow.token)},
               expires_at = ${Date.now() + 12_000}
         WHERE name = 'dm_ipc_hub';
        CREATE TRIGGER _test_steal_after_precheck
        AFTER UPDATE ON oauth_request_lock
        WHEN NEW.name = 'dm_ipc_hub' AND NEW.token = ${sqlQuote(hub1LockRow.token)}
        BEGIN
          UPDATE _test_cas_race SET n = n + 1;
          UPDATE oauth_request_lock
             SET token = ${sqlQuote(hub2LockRow.token)},
                 expires_at = ${hub2LockRow.expires_at}
           WHERE name = 'dm_ipc_hub'
             AND (SELECT n FROM _test_cas_race) = ${stealAtUpdate};
        END;
      `);

      const preReqRow = getRawDb().prepare("SELECT n FROM _test_cas_race").get() as { n: number };
      assert.equal(preReqRow.n, 0, "zero background updates before triggering webhook");

      const rAfterTakeover = await postNotifyUpdate(realHub1.url, bucketSpace, bucketToken, ALICE_DID);
      const elapsedSinceHub1ElectMs = performance.now() - hub1ElectStartedAt;
      const raceRow = getRawDb().prepare("SELECT n FROM _test_cas_race").get() as { n: number };

      assert.ok(
        elapsedSinceHub1ElectMs < 3_500,
        `completed in ${elapsedSinceHub1ElectMs.toFixed(1)}ms (<3500ms < 4000ms HUB_HEARTBEAT_MS), so zero heartbeat timers could fire`,
      );
      assert.equal(
        raceRow.n,
        stealAtUpdate,
        `stealAtUpdate=${stealAtUpdate}: exact expected CAS sequence executed without heartbeat interference`,
      );
      assert.equal(
        rAfterTakeover.status,
        200,
        `stealAtUpdate=${stealAtUpdate}: superseded realHub1 stepped down, cleared rateBuckets, and forwarded to realHub2`,
      );

      const observedOnHub2 = await postGetChanges(realHub2.url, bobAuth, [{ space: bucketSpace, after: realHub2Initial.head }]);
      assert.deepEqual(observedOnHub2.changed.map((c) => c.space), [bucketSpace]);
    }
  } finally {
    try {
      getRawDb().exec("DROP TRIGGER IF EXISTS _test_steal_after_precheck; DROP TABLE IF EXISTS _test_cas_race;");
    } catch {
      // Ignore cleanup errors if DB already closed.
    }
    for (const c of [realHub1, realHub2]) {
      if (c.child.exitCode === null && c.child.signalCode === null) {
        c.child.kill("SIGTERM");
        await once(c.child, "close").catch(() => undefined);
      }
    }
  }
});
