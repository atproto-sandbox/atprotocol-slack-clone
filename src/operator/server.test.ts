import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { Express } from "express";
import { oauthFlowCookieName } from "@/auth/oauth-flow";
import { closeDb } from "@/lib/db";
import { OPERATOR_METHOD } from "@/protocol/nsids";
import { AUTHORITY_FLOW_PATHS } from "./authority-grant";
import { OperatorAuthError } from "./errors";
import type { OperatorMethodDefinition } from "./methods";
import { createOperatorApp } from "./server";

// The operator's HTTP surface as a browser and a caller's host meet it: its did:web document, CORS for the web origin only,
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

after(() => {
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

test("the methods admit the web origin's browsers, with a bearer token, and no other origin", async () => {
  const preflight = (origin: string) => fetch(EXECUTE, {
    method: "OPTIONS",
    headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type" },
  });
  const web = await preflight(WEB_ORIGIN);
  assert.equal(web.status, 204);
  assert.equal(web.headers.get("access-control-allow-origin"), WEB_ORIGIN);
  assert.equal(web.headers.get("access-control-allow-headers"), "authorization, content-type");
  assert.equal(web.headers.get("access-control-allow-methods"), "GET, POST");

  const elsewhere = await preflight("https://elsewhere.example");
  assert.equal(elsewhere.headers.get("access-control-allow-origin"), null);
  assert.equal(elsewhere.headers.get("access-control-allow-headers"), null);
});

test("a call without a service token is refused as an XRPC error, with the security headers", async () => {
  const response = await fetch(EXECUTE, {
    method: "POST",
    headers: { "content-type": "application/json", origin: WEB_ORIGIN },
    body: executeBody({ kind: "decideJoinRequest", request: "at://did:plc:authority/space/new.flock.inbox/team/did:plc:member/new.flock.joinRequest/3kabcdefghij2", requestId: "3kabcdefghij3", decision: "approve" }),
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Unauthorized", message: "Bearer service authorization is required." });
  assert.equal(response.headers.get("access-control-allow-origin"), WEB_ORIGIN);
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

  const start = await fetch(`${base}${AUTHORITY_FLOW_PATHS.start}?ticket=not-a-ticket`, { redirect: "manual" });
  assert.equal(start.status, 302);
  assert.equal(start.headers.get("location"), `${WEB_ORIGIN}/?authority=failed`);
  assert.equal(start.headers.get("set-cookie"), null);
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
