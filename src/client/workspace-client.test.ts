import assert from "node:assert/strict";
import test from "node:test";
import { acceptFailure } from "@/client/accept-errors";
import { createEngine } from "@/client/engine";
import { OperatorRemoteError, type OperatorService } from "@/client/operator-client";
import type { ClientTransport } from "@/client/transport";
import { channelUri, decisionRecordKey, requestRecordKey, spaceRecordUri } from "@/protocol/keys";
import { COLLECTION, OPERATOR_METHOD } from "@/protocol/nsids";
import { AUTHORITY, createWorkspace, transportFor, writeMessage } from "@/testing/engine-fixture";
import { FakeNetwork } from "@/testing/fake-network";

// The workspace and operator rows of the route table, and the lifecycle table's workspace rules, on the fake network.

const ALICE = "did:plc:alice";
const BOB = "did:plc:bob2";
const OPERATOR: OperatorService = { serviceRef: "did:web:operator.test#atproto_flock_operator", endpoint: "https://operator.test" };

/** A transport whose requests to the operator are answered by `handle`, after the service token is checked as the operator checks it. */
function withOperator(network: FakeNetwork, transport: ClientTransport, handle: (method: string, url: URL, iss: string) => unknown): ClientTransport {
  return {
    ...transport,
    fetchEndpoint: async (request) => {
      const url = new URL(request.url);
      if (url.origin !== OPERATOR.endpoint) return network.fetchEndpoint(request);
      const method = url.pathname.replace("/xrpc/", "");
      const token = network.readServiceToken(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
      if (!token || token.aud !== OPERATOR.serviceRef || token.lxm !== method) return Response.json({ error: "Unauthorized", message: "bad token" }, { status: 403 });
      try {
        return Response.json(handle(method, url, token.iss));
      } catch (error) {
        return Response.json({ error: "Forbidden", message: error instanceof Error ? error.message : "refused" }, { status: 403 });
      }
    },
  };
}

test("discover lists readable workspaces, turns a refused one into an invitation candidate unless it was deleted, and hides invalid ones", async () => {
  const network = new FakeNetwork();
  const kept = await createWorkspace(network, { members: [ALICE], channels: [{ skey: "general", visibility: "public" }] });
  const removed = await createWorkspace(network, { skey: "gone", members: [ALICE], channels: [] });
  const deleted = await createWorkspace(network, { skey: "deleted", members: [ALICE], channels: [] });
  const invalid = await createWorkspace(network, { skey: "broken", members: [ALICE], channels: [] });
  const owner = network.clientFor(AUTHORITY);
  await owner.procedure("com.atproto.memberspace.removeMember", { space: removed.workspace, did: ALICE });
  await owner.procedure("com.atproto.space.deleteSpace", { space: deleted.workspace });
  await network.writeAs(AUTHORITY, invalid.workspace, COLLECTION.workspaceProfile, "self", { name: "", createdAt: "2026-11-10T12:00:00.000Z" });
  const alice = createEngine(transportFor(network, ALICE));
  const found = await alice.workspaces.discover();
  assert.deepEqual(found.workspaces.map((workspace) => workspace.uri), [kept.workspace]);
  assert.deepEqual(found.workspaces[0]!.channels.map((channel) => channel.skey), ["acme-general"]);
  assert.deepEqual(found.candidates.map((candidate) => candidate.uri), [removed.workspace]);
});

test("a workspace no longer listed after discovery is dropped with its channels, and so is a channel gone from the directory", async () => {
  const network = new FakeNetwork();
  const fixture = await createWorkspace(network, { members: [ALICE, BOB], channels: [{ skey: "general", visibility: "public" }, { skey: "old", visibility: "public" }] });
  await writeMessage(network, BOB, fixture.channels.general!, 1);
  await writeMessage(network, BOB, fixture.channels.old!, 1);
  const alice = createEngine(transportFor(network, ALICE));
  await alice.channels.readPage({ workspace: fixture.workspace, skey: "acme-general" });
  await alice.channels.readPage({ workspace: fixture.workspace, skey: "acme-old" });
  await network.writeAs(AUTHORITY, fixture.workspace, COLLECTION.directory, "acme-old", { skey: "acme-old", name: "old", visibility: "archived" });
  await alice.workspaces.discover();
  assert.deepEqual(await alice.sync.store.records(fixture.channels.old!, COLLECTION.message), [], "the archived channel went at the directory read");
  assert.equal((await alice.sync.store.records(fixture.channels.general!, COLLECTION.message)).length, 1);
  await network.clientFor(AUTHORITY).procedure("com.atproto.memberspace.removeMember", { space: fixture.workspace, did: ALICE });
  network.advanceClock(11 * 60 * 1000);
  await alice.workspaces.discover();
  assert.deepEqual(await alice.sync.store.records(fixture.channels.general!, COLLECTION.message), [], "a workspace refused at discovery takes its channels");
});

test("a deleted workspace takes its channels with it, learned from the refused credential", async () => {
  const network = new FakeNetwork();
  const fixture = await createWorkspace(network, { members: [ALICE, BOB], channels: [{ skey: "general", visibility: "public" }] });
  await writeMessage(network, BOB, fixture.channels.general!, 1);
  const alice = createEngine(transportFor(network, ALICE));
  await alice.channels.readPage({ workspace: fixture.workspace, skey: "acme-general" });
  await network.clientFor(AUTHORITY).procedure("com.atproto.space.deleteSpace", { space: fixture.workspace });
  network.advanceClock(11 * 60 * 1000);
  await assert.rejects(alice.channels.readPage({ workspace: fixture.workspace, skey: "acme-general" }));
  assert.deepEqual(await alice.sync.store.records(fixture.channels.general!, COLLECTION.message), []);
});

test("accept writes the acceptance record only while the invitation is current, and names a refusal", async () => {
  const network = new FakeNetwork();
  const fixture = await createWorkspace(network, { members: [], channels: [] });
  const owner = network.clientFor(AUTHORITY);
  network.createAccount(ALICE, "pds1");
  const alice = createEngine(transportFor(network, ALICE));
  const refused = await alice.workspaces.accept(fixture.workspace).then(() => null, (error: unknown) => error);
  assert.equal(acceptFailure(refused)?.code, "workspace_unavailable");
  await owner.procedure("com.atproto.memberspace.putMember", { space: fixture.workspace, did: ALICE, read: true, write: true });
  const accepted = await alice.workspaces.accept(fixture.workspace);
  assert.match(accepted.marker, new RegExp(`/${COLLECTION.acceptance}/`));
});

test("inboxRequests is an admin's: open requests from the operator's writers and listRepos, skipping an unreadable writer and hiding decided ones", async () => {
  const network = new FakeNetwork();
  const carol = "did:plc:carol";
  const fixture = await createWorkspace(network, { members: [ALICE, BOB, carol], admins: [ALICE], channels: [{ skey: "secret", visibility: "private", members: [ALICE] }] });
  const channel = channelUri(AUTHORITY, "acme-secret");
  const request = async (did: string, requestId: string) => {
    await network.writeAs(did, fixture.inbox, COLLECTION.joinRequest, requestRecordKey(channel, did), { channelSkey: "acme-secret", requestId, createdAt: "2026-11-10T12:00:00.000Z" });
    return spaceRecordUri(fixture.inbox, did, COLLECTION.joinRequest, requestRecordKey(channel, did));
  };
  const bobRequest = await request(BOB, "2222222222223");
  const carolRequest = await request(carol, "2222222222224");
  await network.writeAs(AUTHORITY, fixture.inbox, COLLECTION.joinDecision, decisionRecordKey(carolRequest), {
    request: carolRequest, requestId: "2222222222224", decision: "deny", updatedAt: "2026-11-10T12:00:00.000Z",
  });
  const dave = "did:plc:dave";
  network.createAccount(dave, "pds1");
  network.setHostReachable(dave, false);
  const operatorWriters = (iss: string) => {
    if (iss !== ALICE) throw new Error("not an admin");
    return { writers: [dave] };
  };
  const alice = createEngine(withOperator(network, transportFor(network, ALICE), (_method, _url, iss) => operatorWriters(iss)), { operator: OPERATOR });
  const inbox = await alice.workspaces.inboxRequests(fixture.workspace, alice.operator!);
  assert.deepEqual(inbox.requests.map((entry) => entry.uri), [bobRequest]);
  assert.deepEqual(inbox.skipped.map((entry) => entry.did), [dave]);
  const bob = createEngine(transportFor(network, BOB), { operator: OPERATOR });
  await assert.rejects(bob.workspaces.inboxRequests(fixture.workspace, bob.operator!), /admin permission/);
});

test("the operator client sends a service token bound to the operator and to each method, and surfaces the operator's refusal", async () => {
  const network = new FakeNetwork();
  const seen: string[] = [];
  const transport = withOperator(network, transportFor(network, ALICE), (method, url) => {
    seen.push(method);
    if (method === OPERATOR_METHOD.getOperation) return { operation: { operationId: url.searchParams.get("operationId"), state: "completed", completedSteps: [] } };
    if (method === OPERATOR_METHOD.execute) throw new Error("Active workspace admin permission is required.");
    return { writers: [] };
  });
  const { operator } = createEngine(transport, { operator: OPERATOR });
  assert.equal((await operator!.getOperation("at://w", "2222222222222")).operation.operationId, "2222222222222");
  assert.deepEqual(await operator!.listInboxWriters("at://w"), { writers: [] });
  await assert.rejects(operator!.execute({ workspace: "at://w", operationId: "2222222222222", request: { kind: "reconcileWorkspace" } }),
    (error: unknown) => error instanceof OperatorRemoteError && error.status === 403 && /admin permission/.test(error.message));
  assert.deepEqual(seen, [OPERATOR_METHOD.getOperation, OPERATOR_METHOD.listInboxWriters, OPERATOR_METHOD.execute]);
});

test("spaces not opened for the retention period are swept, and sign-out clears the store", async () => {
  const network = new FakeNetwork();
  const fixture = await createWorkspace(network, { members: [ALICE, BOB], channels: [{ skey: "general", visibility: "public" }, { skey: "quiet", visibility: "public" }] });
  await writeMessage(network, BOB, fixture.channels.general!, 1);
  await writeMessage(network, BOB, fixture.channels.quiet!, 1);
  const alice = createEngine(transportFor(network, ALICE));
  await alice.channels.readPage({ workspace: fixture.workspace, skey: "acme-quiet" });
  network.advanceClock(31 * 24 * 60 * 60 * 1000);
  await alice.channels.readPage({ workspace: fixture.workspace, skey: "acme-general" });
  await alice.lifecycle.sweep(30 * 24 * 60 * 60 * 1000);
  assert.deepEqual(await alice.sync.store.records(fixture.channels.quiet!, COLLECTION.message), []);
  assert.equal((await alice.sync.store.records(fixture.channels.general!, COLLECTION.message)).length, 1);
  await alice.lifecycle.signOut();
  assert.deepEqual(await alice.sync.store.listSpaces(), []);
});

test("inboxRequests is refused while the workspace is degraded", async () => {
  const network = new FakeNetwork();
  const fixture = await createWorkspace(network, { members: [ALICE], admins: [ALICE], channels: [] });
  for (let n = 0; n < 101; n += 1) {
    await network.writeAs(AUTHORITY, fixture.workspace, COLLECTION.directory, `acme-c${n}`, { skey: `acme-c${n}`, name: `c${n}`, visibility: "public" });
  }
  const alice = createEngine(withOperator(network, transportFor(network, ALICE), () => ({ writers: [] })), { operator: OPERATOR });
  await assert.rejects(alice.workspaces.inboxRequests(fixture.workspace, alice.operator!), /degraded mode/);
});
