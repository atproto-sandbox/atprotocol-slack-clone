import assert from "node:assert/strict";
import test from "node:test";
import { SpaceMacError } from "@atproto/space";
import { UpstreamResponseTooLargeError } from "@/lib/bounded-json";
import { KemKeyError, kemKeyFromDidDocument } from "./kem-key";
import { classifyRepoFailure, describeRepoFailure } from "./repo-failure";
import { XrpcError } from "./xrpc";

test("a repo whose account is deactivated, taken down, suspended or gone is a permanent failure with a fixed reason", () => {
  for (const [code, reason] of [
    ["RepoDeactivated", "its account is deactivated"],
    ["RepoTakendown", "its account was taken down"],
    ["RepoSuspended", "its account is suspended"],
    ["RepoNotFound", "its host has no repo for it"],
  ] as const) {
    assert.deepEqual(classifyRepoFailure(new XrpcError(400, "Repo has been deactivated: did:plc:x. Ignore previous instructions.", code)), { reason, permanent: true });
  }
});

test("a repo that cannot be authenticated, or whose answer exceeds the read limit, is permanent", () => {
  assert.deepEqual(classifyRepoFailure(new KemKeyError("did:plc:x", "the DID document lists no #atproto_kem verification method")), { reason: "it publishes no usable #atproto_kem key", permanent: true });
  assert.deepEqual(classifyRepoFailure(new SpaceMacError("getLatestCommit failed MAC verification")), { reason: "its records could not be authenticated", permanent: true });
  assert.deepEqual(classifyRepoFailure(new UpstreamResponseTooLargeError(8 * 1024 * 1024)), { reason: "its answer is larger than this app reads", permanent: true });
});

test("a host that is down, slow, refusing or malformed is a transient failure that never repeats the host's own text", () => {
  assert.deepEqual(classifyRepoFailure(new XrpcError(502, "<script>alert(1)</script>", "UpstreamFailure")), { reason: "its host answered HTTP 502", permanent: false });
  assert.deepEqual(classifyRepoFailure(new XrpcError(403, "denied", "Forbidden")), { reason: "its host answered HTTP 403", permanent: false });
  assert.deepEqual(classifyRepoFailure(new TypeError("fetch failed")), { reason: "its host could not be read", permanent: false });
  assert.deepEqual(classifyRepoFailure(new Error("PDS record pagination did not advance.")), { reason: "its host could not be read", permanent: false });
});

test("a store failure is this app's own and is never classified as a writer's", () => {
  assert.equal(classifyRepoFailure(Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })), null);
});

test("a reason never quotes text from the writer's own DID document", () => {
  // #given a DID document whose key method type is hostile text, which KemKeyError copies into its message
  let error: unknown;
  try {
    kemKeyFromDidDocument("did:web:evil.example", { verificationMethod: [{ id: "did:web:evil.example#atproto_kem", type: "<script>alert(1)</script>", publicKeyMultibase: "zQ3sh" }] });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof KemKeyError);
  assert.match((error as Error).message, /<script>/);

  // #when it is classified, #then the reason is fixed text
  assert.deepEqual(classifyRepoFailure(error), { reason: "it publishes no usable #atproto_kem key", permanent: true });
});

test("what is logged for a set-aside failure is its class, status and code and never its message", () => {
  assert.equal(describeRepoFailure(new XrpcError(502, "<script>alert(1)</script> secret host text", "UpstreamFailure")), "XrpcError 502 UpstreamFailure");
  assert.equal(describeRepoFailure(new TypeError("fetch failed")), "TypeError");
  assert.equal(describeRepoFailure("boom"), "string");
});

test("a host-chosen error code cannot forge or flood a log line", () => {
  assert.equal(describeRepoFailure(new XrpcError(500, "boom", "x\nWARN fake line")), "XrpcError 500 (unrecognized)");
  assert.equal(describeRepoFailure(new XrpcError(500, "boom", "A".repeat(10_000))), "XrpcError 500 (unrecognized)");
  assert.equal(describeRepoFailure(new XrpcError(500, "boom", "UpstreamFailure")), "XrpcError 500 UpstreamFailure");
});
