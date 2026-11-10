import assert from "node:assert/strict";
import test from "node:test";
import { SpaceMacError } from "@atproto/space";
import { KemKeyError } from "@/atproto/kem-key";
import { UpstreamResponseTooLargeError } from "@/lib/bounded-json";
import { XrpcError } from "@/atproto/xrpc";
import { channelUri, inboxUri, requestRecordKey } from "@/protocol/keys";
import { savedWorkspaceOperations, validateOperatorRequest } from "./operations";
import { assertWorkspaceRosterMatchesPds, readJoinRequestRecord } from "./workspace-state";
import type { OperatorActor } from "./actor";

const actor = { workspace: { authorityDid: "did:plc:owner" } } as OperatorActor;

test("operator accepts only exact self-leave shapes and reconciliation request", () => {
  assert.deepEqual(validateOperatorRequest({ kind: "leaveWorkspace" }, actor, "execute").request, { kind: "leaveWorkspace" });
  assert.deepEqual(validateOperatorRequest({ kind: "reconcileWorkspace" }, actor, "execute").request, { kind: "reconcileWorkspace" });
  assert.throws(() => validateOperatorRequest({ kind: "leaveWorkspace", subject: "did:plc:other" }, actor, "execute"), /unexpected fields/i);
  assert.throws(() => validateOperatorRequest({ kind: "leaveChannel", skey: "general", subject: "did:plc:other" }, actor, "execute"), /unexpected fields/i);
});

test("workspace creation is a journaled kind but is never submitted through execute", () => {
  // #given a bootstrap request, as a client would send it and as its journal row holds it
  const bootstrap = { kind: "bootstrapWorkspace", name: "Acme" };

  // #then execute refuses it, and journal recovery reads it
  assert.throws(() => validateOperatorRequest(bootstrap, actor, "execute"), /unsupported operation kind/i);
  assert.equal(validateOperatorRequest(bootstrap, actor, "journal").kind.kind, "bootstrapWorkspace");
  assert.throws(() => validateOperatorRequest({ kind: "bootstrapWorkspace", name: "Acme <script>" }, actor, "journal"), /1 to 60 plain-text characters/);
});

test("a kind outside the table, a wrong lexicon type, or a wrongly typed field is refused", () => {
  for (const kind of ["deleteWorkspace", "toString", "__proto__", 7]) {
    assert.throws(() => validateOperatorRequest({ kind }, actor, "execute"), /unsupported operation kind|operation kind is required/i, String(kind));
  }
  assert.throws(() => validateOperatorRequest({ kind: "reconcileWorkspace", $type: "org.example.other" }, actor, "execute"), /invalid operation type/i);
  assert.equal(validateOperatorRequest({ kind: "reconcileWorkspace", $type: "org.slack.operator.execute#operationRequest" }, actor, "execute").kind.kind, "reconcileWorkspace");
  assert.throws(() => validateOperatorRequest({ kind: "setAdmin", subject: "did:plc:member", active: "yes" }, actor, "execute"), /must be boolean/i);
  assert.throws(() => validateOperatorRequest({ kind: "inviteMember" }, actor, "execute"), /missing or unexpected fields/i);
  assert.throws(() => validateOperatorRequest({ kind: "createChannel", skey: "x", name: " ", visibility: "public" }, actor, "execute"), /1 to 80 characters/i);
});

test("private visibility transitions require a selected member list", () => {
  assert.throws(() => validateOperatorRequest({ kind: "transitionChannel", skey: "general", visibility: "private" }, actor, "execute"), /selected member list/i);
  assert.deepEqual(validateOperatorRequest({ kind: "transitionChannel", skey: "general", visibility: "private", members: ["did:plc:member"] }, actor, "execute").request.members, ["did:plc:member"]);
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

test("a join request from a repo that cannot be read for good reads as no current request instead of failing the operation", async () => {
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
  assert.equal(await read(() => { throw new XrpcError(400, "Repo has been deactivated", "RepoDeactivated"); }), null, "a deactivated account");
  assert.equal(await read(() => { throw new XrpcError(400, "Repo has been takendown", "RepoTakendown"); }), null, "a taken-down account");
  assert.equal(await read(() => { throw new UpstreamResponseTooLargeError(8 * 1024 * 1024); }), null, "an answer larger than this app reads");
  await assert.rejects(read(() => { throw new XrpcError(500, "upstream failure", "InternalServerError"); }), /upstream failure/, "a host that is down still fails the operation so it can be retried");
  await assert.rejects(read(() => { throw new TypeError("fetch failed"); }), /fetch failed/, "an unreachable host still fails the operation so it can be retried");
});
