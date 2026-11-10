import assert from "node:assert/strict";
import test from "node:test";
import { UpstreamResponseTooLargeError } from "@/lib/bounded-json";
import { OperatorRemoteError, operatorResponseFailure } from "@/client/operator-client";
import { operatorRemoteHttpStatus } from "./client";

test("operator proxy preserves valid remote statuses and maps invalid statuses to bad gateway", () => {
  assert.equal(operatorRemoteHttpStatus(new OperatorRemoteError(503, "Busy", "Try again")), 503);
  assert.equal(operatorRemoteHttpStatus(new OperatorRemoteError(409, "Conflict", "Conflict")), 409);
  assert.equal(operatorRemoteHttpStatus(new OperatorRemoteError(403, "Unauthorized", "Forbidden")), 403);
  assert.equal(operatorRemoteHttpStatus(new OperatorRemoteError(700, "Invalid", "Invalid")), 502);
  assert.equal(operatorRemoteHttpStatus(new OperatorRemoteError(502, "InvalidUpstreamResponse", "Operator service returned invalid JSON.")), 502);
  assert.equal(operatorRemoteHttpStatus(new UpstreamResponseTooLargeError(1024)), 502);
  assert.equal(operatorRemoteHttpStatus(new TypeError("fetch failed", {
    cause: Object.assign(new Error("DNS lookup failed"), { code: "ENOTFOUND" }),
  })), 503);
  assert.equal(operatorRemoteHttpStatus(new Error("local request error")), null);
  assert.equal(operatorResponseFailure(400, false, null)?.status, 502, "malformed JSON from an upstream 4xx is still an invalid upstream response");
  assert.equal(operatorResponseFailure(409, false, { error: "Conflict" })?.status, 409, "valid operator errors retain their service status");
});
