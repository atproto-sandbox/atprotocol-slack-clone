import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { Express } from "express";
import { oauthFlowCookieName } from "../auth/oauth-flow";
import { closeDb, getRawDb } from "../lib/db";
import { dmConversationUri } from "@flock/protocol/keys";
import { NOTICE_METHOD, OPERATOR_METHOD } from "@flock/protocol/nsids";
import { AUTHORITY_FLOW_PATHS } from "./authority-grant";
import { currentDmWakeHead, DM_WAKE_RATE_LIMIT_MAX, resetDmFeedWakesForTests } from "./dm-feed-wakes";
import { OperatorAuthError } from "./errors";
import type { OperatorMethodDefinition } from "./methods";
import { readNotices } from "./notices";
import { flushPendingRenewals } from "./registrations";
import { createOperatorApp } from "./server";
import { deriveDmNotifyToken, DM_TOKEN_EPOCH_MS } from "./space-notification";

// The operator's HTTP surface as a browser and a caller's host meet it: its did:web document, CORS for any origin on the methods and none on the authority flow,
// its security headers, the lexicon checks in front of its methods, and the authority flow's navigations.

const DIRECTORY = mkdtempSync(join(tmpdir(), "operator-server-test-"));
process.env.DATABASE_PATH = join(DIRECTORY, "operator.db");
process.env.AUTH_ENCRYPTION_KEY = "66".repeat(32);
process.env.APP_URL = "http://127.0.0.1:3000";
process.env.OPERATOR_URL = "http://127.0.0.1:3001";
process.env.OPERATOR_SERVICE_REF = "did:web:localhost%3A3001#atproto_flock_operator";

const WEB_ORIGIN = "http://127.0.0.1:3000";

/** Serves `app` on a free loopback port until the file's tests end. */
async function listen(app: Express): Promise<string> {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  after(() => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const base = await listen(createOperatorApp());

after(async () => {
  await flushPendingRenewals();
  closeDb();
  rmSync(DIRECTORY, { recursive: true, force: true });
});

const EXECUTE = `${base}/xrpc/${OPERATOR_METHOD.execute}`;
const executeBody = (request: Record<string, unknown>) => JSON.stringify({
  workspace: "at://did:plc:authority/space/new.flock.workspace/team",
  operationId: "3kabcdefghij2",
  request,
});

function assertSecurityHeaders(response: Response): void {
  assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'none'");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.equal(response.headers.get("x-powered-by"), null);
}

test("the did:web document names the operator at its own origin", async () => {
  const response = await fetch(`${base}/.well-known/did.json`);
  const document = await response.json() as { id: string; service: unknown };
  assert.equal(document.id, "did:web:localhost%3A3001");
  assert.deepEqual(document.service, [{ id: "did:web:localhost%3A3001#atproto_flock_operator", type: "AtprotoFlockOperator", serviceEndpoint: "http://127.0.0.1:3001" }]);
  assertSecurityHeaders(response);
});

test("the methods admit a browser of any origin with a bearer token, the same for every origin, and never with credentials", async () => {
  const preflight = (origin: string) => fetch(EXECUTE, {
    method: "OPTIONS",
    headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type" },
  });
  // #then the web app and a third-party client on another origin get the same answer
  for (const origin of [WEB_ORIGIN, "https://third-party.example"]) {
    const answer = await preflight(origin);
    assert.equal(answer.status, 204, origin);
    assert.equal(answer.headers.get("access-control-allow-origin"), "*", origin);
    assert.equal(answer.headers.get("access-control-allow-headers"), "authorization, content-type", origin);
    assert.equal(answer.headers.get("access-control-allow-methods"), "GET, POST", origin);
    assert.equal(answer.headers.get("access-control-allow-credentials"), null, origin);
    assert.doesNotMatch(answer.headers.get("vary") ?? "", /origin/i, origin);
  }
});

test("a call without a service token is refused as an XRPC error, with the security headers", async () => {
  const response = await fetch(EXECUTE, {
    method: "POST",
    headers: { "content-type": "application/json", origin: WEB_ORIGIN },
    body: executeBody({ kind: "decideJoinRequest", request: "at://did:plc:authority/space/new.flock.inbox/team/did:plc:member/new.flock.joinRequest/3kabcdefghij2", requestId: "3kabcdefghij3", decision: "approve" }),
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Unauthorized", message: "Bearer service authorization is required." });
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assertSecurityHeaders(response);
});

test("the lexicon refuses a body that is not JSON before the method runs", async () => {
  const response = await fetch(EXECUTE, { method: "POST", headers: { "content-type": "text/plain" }, body: executeBody({ kind: "reconcileWorkspace" }) });
  assert.equal(response.status, 400);
  assert.equal((await response.json() as { error: string }).error, "InvalidRequest");
});

test("a channel name is bounded in characters, as the directory record bounds it, not in bytes", async () => {
  const create = (name: string) => fetch(EXECUTE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: executeBody({ kind: "createChannel", skey: "general", name, visibility: "public" }),
  });
  // Eighty two-byte characters pass the lexicon and reach authentication; eighty-one do not.
  assert.equal((await create("é".repeat(80))).status, 403);
  const tooLong = await create("é".repeat(81));
  assert.equal(tooLong.status, 400);
  assert.match((await tooLong.json() as { message: string }).message, /request\/name/);
});

test("only a navigation starts the authority flow, and a ticket that is not valid sends the browser back to the web app", async () => {
  const head = await fetch(`${base}${AUTHORITY_FLOW_PATHS.start}?ticket=anything`, { method: "HEAD" });
  assert.equal(head.status, 405);
  assert.equal(head.headers.get("allow"), "GET");

  const start = await fetch(`${base}${AUTHORITY_FLOW_PATHS.start}?ticket=not-a-ticket`, { redirect: "manual", headers: { origin: "https://third-party.example" } });
  assert.equal(start.status, 302);
  assert.equal(start.headers.get("location"), `${WEB_ORIGIN}/?authority=failed`);
  assert.equal(start.headers.get("set-cookie"), null);
  // The flow works on its own cookie, so no page on any origin may read its answers.
  assert.equal(start.headers.get("access-control-allow-origin"), null);
});

test("a callback whose flow cookie is not valid percent-encoding fails the flow and clears the cookie", async () => {
  const state = "a-state";
  const cookieName = oauthFlowCookieName(state);
  const response = await fetch(`${base}${AUTHORITY_FLOW_PATHS.callback}?state=${state}&code=a-code`, {
    redirect: "manual",
    headers: { cookie: `${cookieName}=%E0%A4%A` },
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), `${WEB_ORIGIN}/?authority=failed`);
  const cleared = response.headers.get("set-cookie") ?? "";
  assert.ok(cleared.startsWith(`${cookieName}=;`), cleared);
  for (const attribute of ["Max-Age=0", `Path=${AUTHORITY_FLOW_PATHS.callback}`, "HttpOnly", "SameSite=Lax"]) assert.ok(cleared.includes(attribute), attribute);
  // Loopback development is plain HTTP, so the cookie cannot be Secure there.
  assert.equal(cleared.includes("Secure"), false);
});

/** An operator serving only a stand-in change feed, so a test can see what the server hands a method and does with its answer. */
async function changeFeed(serve: OperatorMethodDefinition["serve"]): Promise<(follow: unknown[], signal?: AbortSignal) => Promise<Response>> {
  const stand = await listen(createOperatorApp({ [OPERATOR_METHOD.getChanges]: { type: "procedure", unexpected: "InternalServerError", serve } }));
  return (follow, signal) => fetch(`${stand}/xrpc/${OPERATOR_METHOD.getChanges}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ follow }), signal,
  });
}

const NO_CHANGES = { head: "0", changed: [], denied: [], reset: [] };
const A_SPACE = { space: "at://did:plc:authority/space/new.flock.channel/general", after: "0" };

// The timeout turns a signal that never aborts into a failure rather than a hang.
test("a long poll stops when its caller goes away, though it is a procedure, and a call that was answered is not aborted", { timeout: 10_000 }, async () => {
  // given a change feed that answers a call following nothing at once, and otherwise waits until its signal aborts
  const signals: AbortSignal[] = [];
  let reached: () => void = () => undefined;
  const waitingReached = new Promise<void>((resolve) => { reached = resolve; });
  let callerGone: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => { callerGone = resolve; });
  const getChanges = await changeFeed((call) => {
    signals.push(call.signal);
    if ((call.body as { follow: unknown[] }).follow.length === 0) return Promise.resolve(NO_CHANGES);
    reached();
    return new Promise((resolve) => call.signal.addEventListener("abort", () => { callerGone(); resolve(NO_CHANGES); }, { once: true }));
  });

  // when one call is answered, and the caller of another leaves while it waits
  assert.equal((await getChanges([])).status, 200);
  const leaving = new AbortController();
  const waiting = getChanges([A_SPACE], leaving.signal).catch(() => undefined);
  await waitingReached;
  leaving.abort();
  await Promise.all([waiting, stopped]);

  // then only the waiting call's signal aborted
  assert.deepEqual(signals.map((signal) => signal.aborted), [false, true]);
});

test("in loopback development an answer that breaks its method's lexicon is not sent", async () => {
  const getChanges = await changeFeed(async () => ({ ...NO_CHANGES, changed: "not a list" }));
  const response = await getChanges([]);
  assert.equal(response.status, 500);
  assert.equal((await response.json() as { error: string }).error, "InternalServerError");
});

test("a failure no method names is logged by its class and where it was thrown, not its message, and a named refusal is not logged", async (t) => {
  // given a change feed that fails with a bug for one call and refuses the other
  const logged = t.mock.method(console, "error", () => undefined);
  const bug = new TypeError("a message a host wrote\n    at forged (evil.js:1:1)");
  const getChanges = await changeFeed(async (call) => {
    if ((call.body as { follow: unknown[] }).follow.length === 0) throw bug;
    throw new OperatorAuthError("not a member");
  });

  // when both are called
  assert.equal((await getChanges([])).status, 500);
  assert.equal((await getChanges([A_SPACE])).status, 403);

  // then only the bug is logged: its class and its frames in this file, never its message
  const operatorCalls = logged.mock.calls.filter((call) => String(call.arguments[0]).startsWith("operator method"));
  assert.deepEqual(operatorCalls.map((call) => call.arguments.length), [1], "one line, and nothing beside it");
  const operatorLines = operatorCalls.map((call) => String(call.arguments[0]));
  const [heading, ...frames] = operatorLines[0].split("\n");
  assert.equal(heading, `operator method ${OPERATOR_METHOD.getChanges} failed: TypeError`);
  assert.ok(frames.length > 0 && frames.every((frame) => /^\s+at /.test(frame)), operatorLines[0]);
  assert.ok(frames.some((frame) => frame.includes("server.test.ts")), operatorLines[0]);
  assert.equal(operatorLines[0].includes("a host wrote") || operatorLines[0].includes("evil.js"), false);
});

test("an error whose stack no longer begins with its own message is logged without frames", async (t) => {
  // given a bug whose name a host changed after its stack was taken, so the header's lines no longer match the message
  const logged = t.mock.method(console, "error", () => undefined);
  const bug = new TypeError("a message a host wrote\n    at forged (evil.js:1:1)");
  void bug.stack;
  bug.message = "short";
  const getChanges = await changeFeed(async () => { throw bug; });

  // when it is thrown
  assert.equal((await getChanges([])).status, 500);

  // then its line names its class and carries no frame
  const operatorLines = logged.mock.calls.map((call) => String(call.arguments[0])).filter((line) => line.startsWith("operator method"));
  assert.deepEqual(operatorLines, [`operator method ${OPERATOR_METHOD.getChanges} failed: TypeError`]);
});

test("an operation's steps about one member are valid answers at their longest: a 128-character space key and the longest DID AT Protocol permits", async () => {
  // given an execute that answers with the longest step the reconcile names
  const longestStep = `channel-${"k".repeat(128)}-deactivate-stale-roster-did:web:${"d".repeat(2040)}`;
  const operation = { operationId: "3kabcdefghij2", requestHash: "a".repeat(64), state: "completed", completedSteps: [longestStep], updatedAt: new Date().toISOString() };
  const stand = await listen(createOperatorApp({ [OPERATOR_METHOD.execute]: { type: "procedure", unexpected: "InvalidRequest", serve: async () => ({ operation }) } }));

  // when it is called
  const response = await fetch(`${stand}/xrpc/${OPERATOR_METHOD.execute}`, { method: "POST", headers: { "content-type": "application/json" }, body: executeBody({ kind: "reconcileWorkspace" }) });

  // then the answer passes its lexicon
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { operation: { completedSteps: string[] } }).operation.completedSteps[0].length, longestStep.length);
});

test("confirmRegistration and notifySpaceUpdate authenticate via inline token without bearer headers, enforce DM #registrationExpired 400 abandonment, and write zero DM rows to SQLite", async () => {
  resetDmFeedWakesForTests();
  const db = getRawDb();
  const operatorSpace = "at://did:plc:authority/space/new.flock.channel/general";
  const operatorToken = "operator-inline-webhook-token-abc123";
  const serviceRef = "did:web:localhost%3A3001#atproto_flock_operator";

  // Seed staged placeholder registration (expires_at = 0)
  db.prepare("INSERT OR REPLACE INTO notification_registration (service_ref, space_uri, expires_at, workspace_uri, token, renew_at) VALUES (?, ?, 0, ?, ?, 0)")
    .run(serviceRef, operatorSpace, "at://did:plc:authority/space/new.flock.workspace/team", operatorToken);

  const postWebhook = (nsid: string, body: unknown) =>
    fetch(`${base}/xrpc/${nsid}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  // 1. confirmRegistration succeeds on staged expires_at=0 placeholder and fails with 400 on bad token
  const confirmOk = await postWebhook(NOTICE_METHOD.confirmRegistration, {
    space: operatorSpace,
    token: operatorToken,
    challenge: "challenge-xyz",
  });
  assert.equal(confirmOk.status, 200);
  assert.deepEqual(await confirmOk.json(), { challenge: "challenge-xyz" });

  const confirmBad = await postWebhook(NOTICE_METHOD.confirmRegistration, {
    space: operatorSpace,
    token: "wrong-token",
    challenge: "challenge-xyz",
  });
  assert.equal(confirmBad.status, 400);
  assert.equal((await confirmBad.json() as { error: string }).error, "InvalidRequest");

  // 2. notifySpaceUpdate #repoWrite, #repoRemoved, and #registrationExpired (>5 min past expiry!) succeed with HTTP 200 empty body
  const digestB64 = Buffer.alloc(32, 0xab).toString("base64");
  const headBefore = readNotices([]).head;
  const writeRes = await postWebhook(NOTICE_METHOD.notifySpaceUpdate, {
    space: operatorSpace,
    token: operatorToken,
    update: {
      $type: "com.atproto.space.defs#repoWrite",
      repo: "did:plc:member",
      repoRev: "3kabcdefghij2",
      spaceRev: "3kabcdefghij3",
      data: { $bytes: digestB64 },
    },
  });
  assert.equal(writeRes.status, 200);
  assert.equal(await writeRes.text(), "");
  assert.equal(readNotices([]).head, headBefore + 1);

  const removedRes = await postWebhook(NOTICE_METHOD.notifySpaceUpdate, {
    space: operatorSpace,
    token: operatorToken,
    update: {
      $type: "com.atproto.space.defs#repoRemoved",
      repo: "did:plc:member",
      spaceRev: "3kabcdefghij4",
    },
  });
  assert.equal(removedRes.status, 200);
  assert.equal(readNotices([]).head, headBefore + 2);

  // Set expires_at 30 minutes in the past -> #registrationExpired still accepted!
  db.prepare("UPDATE notification_registration SET expires_at = ? WHERE space_uri = ?").run(Date.now() - 30 * 60_000, operatorSpace);
  const expiredRes = await postWebhook(NOTICE_METHOD.notifySpaceUpdate, {
    space: operatorSpace,
    token: operatorToken,
    update: {
      $type: "com.atproto.space.notifySpaceUpdate#registrationExpired",
      spaceRev: "3kabcdefghij5",
    },
  });
  assert.equal(expiredRes.status, 200);
  await flushPendingRenewals();
  const revAfter = (db.prepare("SELECT last_space_rev FROM notification_registration WHERE space_uri = ?").get(operatorSpace) as { last_space_rev: string }).last_space_rev;
  assert.equal(revAfter, "3kabcdefghij5");

  // 3. DM space webhooks with epoch-bounded dm1.* token: caller-isolated wakes, 429 flood cap, 400 expired epoch, and 400 #registrationExpired!
  const aliceDid = "did:plc:alice";
  const bobDid = "did:plc:bob";
  const dmSpace = dmConversationUri(aliceDid, "3kabcdefghij2");
  const dmToken = deriveDmNotifyToken(dmSpace, aliceDid);
  const bobDmToken = deriveDmNotifyToken(dmSpace, bobDid);

  const dmConfirm = await postWebhook(NOTICE_METHOD.confirmRegistration, {
    space: dmSpace,
    token: dmToken,
    challenge: "dm-challenge-1",
  });
  assert.equal(dmConfirm.status, 200);
  assert.deepEqual(await dmConfirm.json(), { challenge: "dm-challenge-1" });

  const aliceDmHeadBefore = currentDmWakeHead(aliceDid).head;
  const bobDmHeadBefore = currentDmWakeHead(bobDid).head;
  const dmWrite = await postWebhook(NOTICE_METHOD.notifySpaceUpdate, {
    space: dmSpace,
    token: dmToken,
    update: {
      $type: "com.atproto.space.defs#repoWrite",
      repo: bobDid,
      repoRev: "3kabcdefghij2",
      spaceRev: "3kabcdefghij3",
      data: { $bytes: digestB64 },
    },
  });
  assert.equal(dmWrite.status, 200);
  assert.equal(currentDmWakeHead(aliceDid).head, aliceDmHeadBefore + 1);
  assert.equal(currentDmWakeHead(bobDid).head, bobDmHeadBefore, "Alice's dm1 token NEVER advances Bob's DM wake head");

  const dmDeleted = await postWebhook(NOTICE_METHOD.notifySpaceUpdate, {
    space: dmSpace,
    token: dmToken,
    update: { $type: "com.atproto.space.notifySpaceUpdate#spaceDeleted" },
  });
  assert.equal(dmDeleted.status, 200);
  assert.equal(currentDmWakeHead(aliceDid).head, aliceDmHeadBefore + 2);
  assert.equal(currentDmWakeHead(bobDid).head, bobDmHeadBefore, "Alice's #spaceDeleted dm1 webhook NEVER affects Bob's DM state");

  // Rate limit per (callerDid, space): exhausting Alice's 120/60s budget returns 429 while Bob's token still succeeds (200)
  for (let i = 2; i < DM_WAKE_RATE_LIMIT_MAX; i += 1) {
    const ok = await postWebhook(NOTICE_METHOD.notifySpaceUpdate, {
      space: dmSpace,
      token: dmToken,
      update: { $type: "com.atproto.space.notifySpaceUpdate#spaceDeleted" },
    });
    assert.equal(ok.status, 200);
  }
  const aliceFlood = await postWebhook(NOTICE_METHOD.notifySpaceUpdate, {
    space: dmSpace,
    token: dmToken,
    update: { $type: "com.atproto.space.notifySpaceUpdate#spaceDeleted" },
  });
  assert.equal(aliceFlood.status, 429);
  assert.equal((await aliceFlood.json() as { error: string }).error, "RateLimitExceeded");

  const bobWriteDuringAliceFlood = await postWebhook(NOTICE_METHOD.notifySpaceUpdate, {
    space: dmSpace,
    token: bobDmToken,
    update: { $type: "com.atproto.space.notifySpaceUpdate#spaceDeleted" },
  });
  assert.equal(bobWriteDuringAliceFlood.status, 200);
  assert.equal(currentDmWakeHead(bobDid).head, bobDmHeadBefore + 1);

  // Expired epoch token (2 epochs old, past [epoch, epoch - 1]) is rejected with HTTP 400!
  const staleEpochToken = deriveDmNotifyToken(dmSpace, aliceDid, undefined, Date.now() - 2 * DM_TOKEN_EPOCH_MS);
  const staleRes = await postWebhook(NOTICE_METHOD.notifySpaceUpdate, {
    space: dmSpace,
    token: staleEpochToken,
    update: { $type: "com.atproto.space.notifySpaceUpdate#spaceDeleted" },
  });
  assert.equal(staleRes.status, 400, "dm1 token past [epoch, epoch - 1] is rejected with 400");

  const dmExpired = await postWebhook(NOTICE_METHOD.notifySpaceUpdate, {
    space: dmSpace,
    token: dmToken,
    update: {
      $type: "com.atproto.space.notifySpaceUpdate#registrationExpired",
      spaceRev: "3kabcdefghij6",
    },
  });
  assert.equal(dmExpired.status, 400, "DM #registrationExpired returns 400 so PDS runs abandonSyncerNotice");

  // Verify zero DM rows exist across every SQLite table
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>)
    .map((r) => r.name);
  for (const table of tables) {
    const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
    for (const col of cols) {
      const hit = db.prepare(`SELECT 1 FROM ${table} WHERE CAST(${col} AS TEXT) LIKE '%new.flock.dm.%' LIMIT 1`).get();
      assert.equal(hit, undefined, `unexpected DM entry in ${table}.${col}`);
    }
  }
});
