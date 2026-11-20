import assert from "node:assert/strict";
import test from "node:test";
import { NOTICE_METHOD, OPERATOR_METHOD } from "@flock/protocol/nsids";
import { describeFailure, MethodError, OPERATOR_METHODS } from "./methods";
import { DmRateLimitError } from "./dm-feed-wakes";
import { OperatorAuthError, WebhookAuthError } from "./errors";
import { OperationBusyError, OperationConflictError } from "./journal";

// Clients call the operator at /xrpc/<method NSID>: every method the app defines is served, and nothing else is.

test("the operator serves exactly the operator methods and the two PDS webhooks (confirmRegistration and notifySpaceUpdate)", () => {
  assert.deepEqual(Object.keys(OPERATOR_METHODS).sort(), [...Object.values(OPERATOR_METHOD), ...Object.values(NOTICE_METHOD)].sort());
  assert.deepEqual(Object.values(NOTICE_METHOD).sort(), [
    "com.atproto.space.confirmRegistration",
    "com.atproto.space.notifySpaceUpdate",
  ]);
});

test("a failure answers with its own status and name, including named 400 WebhookAuthError, and hides internal stack messages", () => {
  assert.deepEqual(describeFailure(new MethodError(409, "OperationIdConflict", "taken"), "InvalidRequest"), { status: 409, error: "OperationIdConflict", message: "taken" });
  assert.deepEqual(describeFailure(new OperatorAuthError("not an admin"), "InvalidRequest"), { status: 403, error: "Unauthorized", message: "not an admin" });
  assert.deepEqual(describeFailure(new WebhookAuthError("Invalid notification token."), "InternalServerError"), {
    status: 400,
    error: "InvalidRequest",
    message: "Invalid notification token.",
  });
  assert.deepEqual(describeFailure(new DmRateLimitError(), "InternalServerError"), {
    status: 429,
    error: "RateLimitExceeded",
    message: "Too many DM notifications for this caller and space.",
  });
  assert.equal(describeFailure(new OperationConflictError(), "InvalidRequest").status, 409);
  assert.equal(describeFailure(new OperationBusyError(), "InvalidRequest").error, "Busy");
  const unnamed = new Error("Workspace not found.");
  assert.deepEqual(describeFailure(unnamed, "InvalidRequest"), { status: 400, error: "InvalidRequest", message: "Workspace not found.", unnamed: true });
  const bug = new TypeError("a stack trace");
  assert.deepEqual(describeFailure(bug, "InternalServerError"), { status: 500, error: "InternalServerError", message: "The operator request failed.", unnamed: true });
});

test("only a failure no method names keeps its cause, for the log; a named refusal is the caller's to read", () => {
  assert.equal(describeFailure(new OperatorAuthError("not an admin"), "InternalServerError").unnamed, undefined);
  assert.equal(describeFailure(new WebhookAuthError(), "InternalServerError").unnamed, undefined);
  assert.equal(describeFailure(new MethodError(400, "InvalidRequest", "bad"), "InvalidRequest").unnamed, undefined);
  assert.equal(describeFailure(undefined, "InternalServerError").unnamed, true);
});
