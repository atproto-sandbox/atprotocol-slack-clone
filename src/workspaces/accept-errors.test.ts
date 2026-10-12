import assert from "node:assert/strict";
import test from "node:test";
import { SpaceCredentialError } from "@/atproto/space-credential-core";
import { XrpcError } from "@/atproto/xrpc";
import { acceptFailure } from "./accept-errors";

test("a refusal to issue a workspace credential becomes a specific, actionable answer", () => {
  assert.deepEqual(acceptFailure(new SpaceCredentialError("denied", 403, "UserNotAuthorized")), {
    status: 403, code: "not_a_member", error: "You haven't been added to this workspace yet. Ask an admin to invite your account, then open the invite link again.",
  });
  for (const code of ["SpaceNotFound", "SpaceDeleted"] as const) {
    const failure = acceptFailure(new SpaceCredentialError("gone", code === "SpaceNotFound" ? 404 : 410, code));
    assert.equal(failure?.code, "workspace_unavailable");
    assert.equal(failure?.status, 404);
  }
});

test("other failures are left to the generic handler", () => {
  assert.equal(acceptFailure(new SpaceCredentialError("denied", 401)), null);
  assert.equal(acceptFailure(new Error("boom")), null);
  assert.equal(acceptFailure(undefined), null);
});

test("declining the join permission is explained instead of surfacing a raw scope error", () => {
  const failure = acceptFailure(new XrpcError(403, 'Missing required scope "space:org.slack.workspace?authority=x"', "ScopeMissingError"));
  assert.equal(failure?.code, "permission_not_granted");
  assert.doesNotMatch(failure?.error ?? "", /Missing required scope/);
  assert.equal(acceptFailure(new XrpcError(403, "Denied.", "SomethingElse")), null);
});
