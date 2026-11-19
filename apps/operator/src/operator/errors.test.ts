import assert from "node:assert/strict";
import test from "node:test";
import { TokenRefreshError } from "@atproto/oauth-client-node";
import { OAuthRequestLockError } from "../auth/oauth-request-lock";
import { XrpcError } from "@flock/protocol/atproto/xrpc";
import { OperatorInfrastructureError, isTransientOperatorInfrastructureError, operatorHttpFailure, operatorInfrastructureHttpStatus } from "./errors";
import { isTransientOperationError } from "./journal";

test("a request that ran out of time is a temporary upstream failure, and is not run again in a loop under the workspace lock", () => {
  // #given the error a request's deadline ends it with
  const timedOut = new DOMException("The operation was aborted due to timeout", "TimeoutError");

  // #then the operator answers it as a temporary upstream failure, and a journaled run does not retry it
  assert.equal(operatorHttpFailure(timedOut)?.name, "UpstreamUnavailable");
  assert.equal(isTransientOperationError(timedOut), false);
});

test("operator infrastructure failures are distinct from authorization and validation errors", () => {
  assert.equal(isTransientOperatorInfrastructureError(new OperatorInfrastructureError()), true);
  assert.equal(isTransientOperatorInfrastructureError(new OAuthRequestLockError("lock busy")), true);
  assert.equal(isTransientOperatorInfrastructureError(new XrpcError(503, "unavailable", "ServiceUnavailable")), true);
  assert.equal(isTransientOperatorInfrastructureError(new XrpcError(429, "rate limited", "RateLimited")), true);
  assert.equal(isTransientOperatorInfrastructureError(new TypeError("fetch failed", {
    cause: Object.assign(new Error("socket closed"), { code: "ECONNRESET" }),
  })), true);
  assert.equal(isTransientOperatorInfrastructureError(new XrpcError(403, "forbidden", "Unauthorized")), false);
  assert.equal(isTransientOperatorInfrastructureError(new XrpcError(400, "invalid", "InvalidRequest")), false);
  assert.equal(isTransientOperatorInfrastructureError(new Error("invalid operator request")), false);
  assert.equal(operatorInfrastructureHttpStatus(new XrpcError(503, "unavailable", "ServiceUnavailable")), 503);
  assert.equal(operatorInfrastructureHttpStatus(new XrpcError(400, "invalid", "InvalidRequest")), null);
  assert.equal(operatorInfrastructureHttpStatus(new XrpcError(401, "rejected", "AuthRequired")), 502);
  assert.equal(operatorInfrastructureHttpStatus(new XrpcError(403, "rejected", "Forbidden")), 502);
  assert.equal(isTransientOperatorInfrastructureError(new TokenRefreshError("did:plc:admin", "The session was revoked")), false);
  assert.equal(operatorInfrastructureHttpStatus(new TokenRefreshError("did:plc:admin", "The session was revoked")), 502);
  assert.deepEqual(operatorHttpFailure(new TokenRefreshError("did:plc:admin", "The session was revoked")), {
    status: 502,
    name: "AuthoritySessionUnavailable",
    message: "The workspace authority session was rejected and must be reauthorized.",
  });
  assert.equal(operatorHttpFailure(new XrpcError(503, "unavailable", "ServiceUnavailable"))?.name, "UpstreamUnavailable");
});

test("a scope the authority's grant lacks asks the authority to approve again, wherever the PDS refuses it", () => {
  // #given the PDS refusing an operator read or write for a missing scope
  const refused = new XrpcError(403, 'Missing required scope "space:new.flock.channel"', "ScopeMissingError");

  // #then the operator answers with the code the app turns into a reauthorization prompt, not a generic rejection
  assert.deepEqual(operatorHttpFailure(refused), {
    status: 502,
    name: "AuthoritySessionUnavailable",
    message: "The workspace authority must approve its permission again before this operation can run.",
  });
  assert.equal(operatorHttpFailure(new XrpcError(403, "forbidden", "Forbidden"))?.name, "AuthorityAccessRejected");
});

test("401 AccountTakedown, 401 AccountDeactivated, RepoTakendown, and RepoDeactivated report 503 UpstreamUnavailable without asking to reauthorize or retry-looping", () => {
  for (const suspended of [
    new XrpcError(401, "Account has been takendown", "AccountTakedown"),
    new XrpcError(401, "Account is deactivated", "AccountDeactivated"),
    new XrpcError(400, "Repo has been takendown", "RepoTakendown"),
    new XrpcError(400, "Repo is deactivated", "RepoDeactivated"),
  ]) {
    assert.deepEqual(operatorHttpFailure(suspended), {
      status: 503,
      name: "UpstreamUnavailable",
      message: "The workspace authority account is currently suspended or deactivated.",
    });
    assert.equal(isTransientOperationError(suspended), false, `${suspended.code} must not loop under the workspace lock`);
  }
});
