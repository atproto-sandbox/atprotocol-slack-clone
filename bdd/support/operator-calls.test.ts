import assert from "node:assert/strict";
import test from "node:test";
import type { OperationView } from "@flock/client/operator-client";
import { answerOf, decodeExecuted } from "./operator-calls";
import type { ApiCall } from "./world";

// How a step reads the operator's answer to an `execute` the page made, including when the browser would not hand over the
// answer's body (Playwright records that as "navigated-away", whether the page left or Chromium dropped the body).

const REQUEST = JSON.stringify({ workspace: "at:space/did:plc:owner/new.flock.workspace/team", operationId: "3kabcdefghij2", request: { kind: "createChannel", skey: "room" } });
const COMPLETED: OperationView = { operationId: "3kabcdefghij2", requestHash: "a".repeat(64), state: "completed", completedSteps: ["channel-space"], updatedAt: "2026-11-11T10:00:00.000Z" };

const call = (status: number, body: ApiCall["body"], responseBody = ""): ApiCall =>
  ({ method: "POST", path: "/xrpc/new.flock.operator.execute", query: "", status, requestBody: REQUEST, responseBody, body, origin: "http://127.0.0.1:3001" });
const noJournal = () => undefined;

test("an answer the page received is decoded as the operator sent it", () => {
  const executed = answerOf(call(200, "recorded", JSON.stringify({ operation: COMPLETED })), noJournal);
  assert.deepEqual(executed, { status: 200, operationId: "3kabcdefghij2", request: { kind: "createChannel", skey: "room" }, operation: COMPLETED, code: undefined, error: undefined });
  const refused = answerOf(call(409, "recorded", JSON.stringify({ error: "OperationIdConflict", message: "taken" })), noJournal);
  assert.deepEqual([refused.code, refused.error], ["OperationIdConflict", "taken"]);
});

test("an accepted call whose body was not handed over is answered by the journal's record of its operation", () => {
  const asked: string[] = [];
  const executed = answerOf(call(200, "navigated-away"), (operationId) => { asked.push(operationId); return COMPLETED; });
  assert.deepEqual(asked, ["3kabcdefghij2"]);
  assert.equal(executed.operation, COMPLETED);
});

test("a body that was not handed over is never decoded as an answer without an operation", () => {
  assert.throws(() => answerOf(call(200, "navigated-away"), noJournal), /recorded without its body \(navigated-away\), and the journal has no operation 3kabcdefghij2/);
  assert.throws(() => answerOf(call(403, "navigated-away"), () => COMPLETED), /HTTP 403\) was recorded without its body/);
  assert.throws(() => decodeExecuted(call(200, "navigated-away")), /recorded without its body/);
});
