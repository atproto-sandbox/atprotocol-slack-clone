import assert from "node:assert/strict";
import test from "node:test";
import { TokenRefreshError } from "@atproto/oauth-client-node";
import { OAuthRequestLockError } from "@/auth/oauth-request-lock";
import { XrpcError } from "@/atproto/xrpc";
import { OperatorInfrastructureError, isTransientOperatorInfrastructureError, operatorHttpFailure, operatorInfrastructureHttpStatus } from "./errors";

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
