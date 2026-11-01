import assert from "node:assert/strict";
import test from "node:test";
import { SpaceMacError } from "@atproto/space";
import { KemKeyError } from "@/atproto/kem-key";
import { XrpcError } from "@/atproto/xrpc";
import { channelUri, inboxUri, requestRecordKey } from "@/protocol/keys";
import { assertWorkspaceRosterMatchesPds, readJoinRequestRecord, savedWorkspaceOperations, validateOperatorRequest } from "./operations";
import type { OperatorActor } from "./security";

const actor = { workspace: { authorityDid: "did:plc:owner" } } as OperatorActor;

test("operator accepts only exact self-leave shapes and reconciliation request", () => {
  assert.deepEqual(validateOperatorRequest({ kind: "leaveWorkspace" }, actor), { kind: "leaveWorkspace" });
  assert.deepEqual(validateOperatorRequest({ kind: "reconcileWorkspace" }, actor), { kind: "reconcileWorkspace" });
  assert.throws(() => validateOperatorRequest({ kind: "leaveWorkspace", subject: "did:plc:other" }, actor), /unexpected fields/i);
  assert.throws(() => validateOperatorRequest({ kind: "leaveChannel", skey: "general", subject: "did:plc:other" }, actor), /unexpected fields/i);
});

test("private visibility transitions require a selected member list", () => {
  assert.throws(() => validateOperatorRequest({ kind: "transitionChannel", skey: "general", visibility: "private" }, actor), /selected member list/i);
  assert.deepEqual(validateOperatorRequest({ kind: "transitionChannel", skey: "general", visibility: "private", members: ["did:plc:member"] }, actor).members, ["did:plc:member"]);
});

test("workspace channel grants require the roster and live PDS membership to match", () => {
  const authority = "did:plc:owner";
  const member = "did:plc:member";
  assert.doesNotThrow(() => assertWorkspaceRosterMatchesPds(
    new Set([authority, member]),
    [{ did: member, read: true, write: true }],
    authority,
  ));
  assert.throws(() => assertWorkspaceRosterMatchesPds(
    new Set([member]),
    [],
    authority,
  ), /roster has not converged/i);
  assert.throws(() => assertWorkspaceRosterMatchesPds(
    new Set(),
    [{ did: member, read: true, write: true }],
    authority,
  ), /roster has not converged/i);
  assert.throws(() => assertWorkspaceRosterMatchesPds(
    new Set([member]),
    [{ did: member, read: true, write: false }],
    authority,
  ), /roster has not converged/i);
});

test("recovery keeps unreadable journal rows visible instead of silently skipping them", () => {
  const workspace = "at://did:plc:owner/space/org.slack.workspace/team";
  const recoveringActor = { did: "did:plc:admin", workspace: { authorityDid: "did:plc:owner", uri: workspace } } as OperatorActor;
  const rows = [
    { actor: "did:plc:admin", operationId: "current", requestJson: JSON.stringify({ workspace, request: { kind: "reconcileWorkspace" } }) },
    { actor: "did:plc:other", operationId: "valid", requestJson: JSON.stringify({ workspace, request: { kind: "leaveWorkspace" } }) },
    { actor: "did:plc:other", operationId: "corrupt", requestJson: "{not json" },
    { actor: "did:plc:other", operationId: "no-request", requestJson: JSON.stringify({ workspace }) },
    { actor: "did:plc:other", operationId: "elsewhere", requestJson: JSON.stringify({ workspace: `${workspace}-2`, request: { kind: "leaveWorkspace" } }) },
  ];
  assert.deepEqual(savedWorkspaceOperations(rows, recoveringActor, "current"), [
    { actor: "did:plc:other", operationId: "valid", request: { kind: "leaveWorkspace" } },
    { actor: "did:plc:other", operationId: "corrupt", request: null },
    { actor: "did:plc:other", operationId: "no-request", request: null },
  ]);
});

test("a join request from a repo that cannot be authenticated reads as no current request instead of failing the operation", async () => {
  const authority = "did:plc:owner";
  const requester = "did:plc:requester";
  const inbox = inboxUri(authority);
  const rkey = requestRecordKey(channelUri(authority, "secret"), requester);
  const request = { channelSkey: "secret", requestId: "2222222222222", createdAt: "2026-11-01T00:00:00.000Z" };
  const read = (outcome: () => unknown) => readJoinRequestRecord(
    { query: async () => outcome() as never },
    inbox, requester, rkey, authority,
  );

  assert.deepEqual(await read(() => ({ uri: "", value: request })), request, "a verified request is returned");
  assert.equal(await read(() => { throw new KemKeyError(requester, "the DID document lists no #atproto_kem verification method"); }), null, "no usable KEM key");
  assert.equal(await read(() => { throw new SpaceMacError("getRecord failed MAC verification"); }), null, "a MAC that does not verify");
  assert.equal(await read(() => { throw new XrpcError(404, "not found", "RecordNotFound"); }), null, "no such record");
  assert.equal(await read(() => ({ uri: "", value: { ...request, requestId: "not-a-tid" } })), null, "an invalid record");
  await assert.rejects(read(() => { throw new XrpcError(500, "upstream failure", "InternalServerError"); }), /upstream failure/, "other failures still fail the operation so it can be retried");
});
