import assert from "node:assert/strict";
import test from "node:test";
import { acceptFailure } from "./accept-errors";
import { createEngine } from "./engine";
import {
  DidNotFoundError,
  IdempotencyParameterMismatchError,
  IncompatibleInvitesSpacePolicyError,
  JoinOperationQuotaExceededError,
  UnsupportedJoinStatusError,
} from "./errors";
import { GroupClient } from "./group-client";
import { OperatorRemoteError, type OperatorService } from "./operator-client";
import type { ClientTransport } from "./transport";
import { WRITER_WRITE_TYPE } from "@flock/protocol/atproto/record-pages";
import { XrpcError } from "@flock/protocol/atproto/xrpc";
import { extSpaceUriFor } from "@flock/protocol/extensions";
import { WorkspaceEnvelopeError } from "@flock/protocol/workspace-summary";
import {
  channelUri,
  decisionRecordKey,
  personalInvitesUri,
  requestRecordKey,
  SELF_SKEY,
  spaceRecordUri,
  workspaceUri,
} from "@flock/protocol/keys";
import {
  ATPROTO_SPACE_COLLECTION,
  COLLECTION,
  FLOCK_EXTENSION_FIELD,
  OPENSOCIAL_COLLECTION,
  OPENSOCIAL_POLICY,
  OPENSOCIAL_SPACE_TYPE,
  OPERATOR_METHOD,
  REPO_COLLECTION,
  SPACE_TYPE,
} from "@flock/protocol/nsids";
import { AUTHORITY, countCalls, createWorkspace, key, plcDidForLabel, transportFor, writeMessage } from "./testing/engine-fixture";
import { FakeNetwork } from "@flock/testing/fake-network";

// The workspace, OpenSocial lifecycle journals, invites provisioning, and operator rows on the fake network.

const ALICE = "did:plc:aliceaaaaaaaaaaaaaaaaaaa";
const BOB = "did:plc:bob2aaaaaaaaaaaaaaaaaaaa";
const CAROL = "did:plc:carolaaaaaaaaaaaaaaaaaaa";
const OPERATOR: OperatorService = { serviceRef: "did:web:operator.test#atproto_flock_operator", endpoint: "https://operator.test" };

/** A transport whose requests to the operator are answered by `handle`, after the service token is checked as the operator checks it. */
function withOperator(
  network: FakeNetwork,
  transport: ClientTransport,
  handle: (method: string, url: URL, iss: string, body: unknown) => unknown,
): ClientTransport {
  return {
    ...transport,
    fetchEndpoint: async (request) => {
      const url = new URL(request.url);
      if (url.origin !== OPERATOR.endpoint) return network.fetchEndpoint(request);
      const method = url.pathname.replace("/xrpc/", "");
      const token = network.readServiceToken(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
      if (!token || token.aud !== OPERATOR.serviceRef || token.lxm !== method) {
        return Response.json({ error: "Unauthorized", message: "bad token" }, { status: 403 });
      }
      const body = request.method === "POST" ? JSON.parse(await request.clone().text() || "{}") : undefined;
      try {
        const answer = await handle(method, url, token.iss, body);
        return answer instanceof Response ? answer : Response.json(answer);
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

  await network.clientFor(removed.groupDid).procedure("com.atproto.space.deleteRecord", {
    space: removed.members,
    repo: removed.groupDid,
    collection: OPENSOCIAL_COLLECTION.membership,
    rkey: ALICE,
  });
  await network.clientFor(deleted.groupDid).procedure("com.atproto.space.deleteSpace", { space: deleted.workspace });
  await network.clientFor(invalid.groupDid).procedure("com.atproto.space.deleteRecord", {
    space: invalid.meta,
    repo: invalid.groupDid,
    collection: OPENSOCIAL_COLLECTION.profile,
    rkey: SELF_SKEY,
  });

  const alice = createEngine(transportFor(network, ALICE));
  const found = await alice.workspaces.discover();
  assert.deepEqual(found.workspaces.map((workspace) => workspace.uri), [kept.workspace]);
  assert.deepEqual(found.workspaces[0]!.channels.map((channel) => channel.skey), ["general"]);
  assert.deepEqual(found.candidates.map((candidate) => candidate.uri), [removed.workspace]);
});

test("a workspace no longer listed after discovery is dropped with its channels, and so is a channel gone from the directory", async () => {
  const network = new FakeNetwork();
  const fixture = await createWorkspace(network, {
    members: [ALICE, BOB],
    channels: [{ skey: "general", visibility: "public" }, { skey: "old", visibility: "public" }],
  });
  await writeMessage(network, BOB, fixture.channels.general!, 1);
  await writeMessage(network, BOB, fixture.channels.old!, 1);
  const alice = createEngine(transportFor(network, ALICE));
  await alice.channels.readPage({ workspace: fixture.workspace, skey: "general" });
  await alice.channels.readPage({ workspace: fixture.workspace, skey: "old" });
  await network.writeAs(AUTHORITY, fixture.workspace, COLLECTION.directory, "old", { skey: "old", name: "old", visibility: "archived" });
  await alice.workspaces.discover();
  assert.deepEqual(await alice.sync.store.records(fixture.channels.old!, COLLECTION.message), [], "the archived channel went at the directory read");
  assert.equal((await alice.sync.store.records(fixture.channels.general!, COLLECTION.message)).length, 1);

  await network.clientFor(AUTHORITY).procedure("com.atproto.space.deleteRecord", {
    space: fixture.members,
    repo: AUTHORITY,
    collection: OPENSOCIAL_COLLECTION.membership,
    rkey: ALICE,
  });
  network.advanceClock(11 * 60 * 1000);
  await alice.workspaces.discover();
  assert.deepEqual(await alice.sync.store.records(fixture.channels.general!, COLLECTION.message), [], "a workspace refused at discovery takes its channels");
});

test("a deleted workspace takes its channels with it, learned from the refused credential", async () => {
  const network = new FakeNetwork();
  const fixture = await createWorkspace(network, { members: [ALICE, BOB], channels: [{ skey: "general", visibility: "public" }] });
  await writeMessage(network, BOB, fixture.channels.general!, 1);
  const alice = createEngine(transportFor(network, ALICE));
  await alice.channels.readPage({ workspace: fixture.workspace, skey: "general" });
  await network.clientFor(AUTHORITY).procedure("com.atproto.space.deleteSpace", { space: fixture.workspace });
  network.advanceClock(11 * 60 * 1000);
  await assert.rejects(alice.channels.readPage({ workspace: fixture.workspace, skey: "general" }));
  assert.deepEqual(await alice.sync.store.records(fixture.channels.general!, COLLECTION.message), []);
});

test("accept writes group.opensocial.acceptance/self only while membership is current, stamping incarnation, and names a refusal", async () => {
  const network = new FakeNetwork();
  const fixture = await createWorkspace(network, { members: [], channels: [] });
  const owner = network.clientFor(AUTHORITY);
  network.createAccount(ALICE, "pds1");
  const alice = createEngine(transportFor(network, ALICE));
  const refused = await alice.workspaces.accept(fixture.workspace).then(() => null, (error: unknown) => error);
  assert.equal(acceptFailure(refused)?.code, "workspace_unavailable");

  await owner.procedure("com.atproto.space.putRecord", {
    space: fixture.members,
    repo: AUTHORITY,
    collection: OPENSOCIAL_COLLECTION.membership,
    rkey: ALICE,
    record: { $type: OPENSOCIAL_COLLECTION.membership, roles: ["member"], createdAt: "2026-11-10T12:00:00.000Z" },
  });
  const accepted = await alice.workspaces.accept(fixture.workspace);
  assert.match(accepted.marker, new RegExp(`/${OPENSOCIAL_COLLECTION.acceptance}/self$`));
  const ownAcc = await network.clientFor(ALICE).query<{ value: Record<string, unknown> }>("com.atproto.space.getRecord", {
    space: fixture.members,
    repo: ALICE,
    collection: OPENSOCIAL_COLLECTION.acceptance,
    rkey: SELF_SKEY,
  });
  assert.equal(typeof ownAcc.value["new.flock.incarnation"], "string");
});

test("inboxRequests reads inbox/self writers directly for an admin, skipping an unreadable writer and hiding decided or !takedown requests", async () => {
  const network = new FakeNetwork();
  const dave = "did:plc:daveaaaaaaaaaaaaaaaaaaaa";
  const fixture = await createWorkspace(network, {
    members: [ALICE, BOB, CAROL, dave],
    admins: [ALICE],
    channels: [{ skey: "secret", visibility: "private", members: [ALICE] }],
  });
  const channel = channelUri(AUTHORITY, "secret");
  const request = async (did: string, requestId: string) => {
    await network.writeAs(did, fixture.inbox, COLLECTION.joinRequest, requestRecordKey(channel, did), {
      channelSkey: "secret",
      requestId,
      createdAt: "2026-11-10T12:00:00.000Z",
    });
    return spaceRecordUri(fixture.inbox, did, COLLECTION.joinRequest, requestRecordKey(channel, did));
  };
  const bobRequest = await request(BOB, "2222222222223");
  const carolRequest = await request(CAROL, "2222222222224");
  await request(dave, "2222222222225");
  await network.writeAs(AUTHORITY, fixture.inbox, COLLECTION.joinDecision, decisionRecordKey(carolRequest), {
    request: carolRequest,
    requestId: "2222222222224",
    decision: "deny",
    updatedAt: "2026-11-10T12:00:00.000Z",
  });
  network.setHostReachable(dave, false);

  const alice = createEngine(transportFor(network, ALICE));
  const inbox = await alice.workspaces.inboxRequests(fixture.workspace);
  assert.deepEqual(inbox.requests.map((entry) => entry.uri), [bobRequest]);
  assert.deepEqual(inbox.skipped.map((entry) => entry.did), [dave]);

  const bob = createEngine(transportFor(network, BOB));
  await assert.rejects(bob.workspaces.inboxRequests(fixture.workspace), /admin permission/);
});

test("the operator client sends a service token bound to the operator and to each method, including getSpaceNotifyTarget, and surfaces the operator's refusal", async () => {
  const network = new FakeNetwork();
  const seen: string[] = [];
  const transport = withOperator(network, transportFor(network, ALICE), (method, url) => {
    seen.push(method);
    if (method === OPERATOR_METHOD.getOperation) {
      return { operation: { operationId: url.searchParams.get("operationId"), state: "completed", completedSteps: [] } };
    }
    if (method === OPERATOR_METHOD.getSpaceNotifyTarget) {
      return { endpoint: "https://operator.test/xrpc/com.atproto.space.notifySpaceUpdate", token: "inv1.test" };
    }
    if (method === OPERATOR_METHOD.execute) throw new Error("Active workspace admin permission is required.");
    return {};
  });
  const engine = createEngine(transport, { operator: OPERATOR });
  const wsUri = workspaceUri(AUTHORITY);
  assert.equal((await engine.operator!.getOperation(wsUri, "2222222222222")).operation.operationId, "2222222222222");
  const notifyTarget = await engine.workspaces.invitesNotifyTarget(engine.operator!);
  assert.equal(notifyTarget.token, "inv1.test");
  await assert.rejects(
    engine.operator!.execute({
      workspace: wsUri,
      operationId: "2222222222222",
      request: { kind: "decideGroupJoinRequest", member: BOB, decision: "approve" },
    }),
    (error: unknown) => error instanceof OperatorRemoteError && error.status === 403 && /admin permission/.test(error.message),
  );
  assert.deepEqual(seen, [OPERATOR_METHOD.getOperation, OPERATOR_METHOD.getSpaceNotifyTarget, OPERATOR_METHOD.execute]);
});

test("spaces not opened for the retention period are swept", async () => {
  const network = new FakeNetwork();
  const fixture = await createWorkspace(network, {
    members: [ALICE, BOB],
    channels: [{ skey: "general", visibility: "public" }, { skey: "quiet", visibility: "public" }],
  });
  await writeMessage(network, BOB, fixture.channels.general!, 1);
  await writeMessage(network, BOB, fixture.channels.quiet!, 1);
  const alice = createEngine(transportFor(network, ALICE));
  await alice.channels.readPage({ workspace: fixture.workspace, skey: "quiet" });
  network.advanceClock(31 * 24 * 60 * 60 * 1000);
  await alice.channels.readPage({ workspace: fixture.workspace, skey: "general" });
  await alice.lifecycle.sweep(30 * 24 * 60 * 60 * 1000);
  assert.deepEqual(await alice.sync.store.records(fixture.channels.quiet!, COLLECTION.message), []);
  assert.equal((await alice.sync.store.records(fixture.channels.general!, COLLECTION.message)).length, 1);
});

test("inboxRequests is refused while the workspace is degraded", async () => {
  const network = new FakeNetwork();
  const fixture = await createWorkspace(network, { members: [ALICE], admins: [ALICE], channels: [] });
  for (let n = 0; n < 101; n += 1) {
    await network.writeAs(AUTHORITY, fixture.workspace, COLLECTION.directory, `c${n}`, { skey: `c${n}`, name: `c${n}`, visibility: "public" });
  }
  const alice = createEngine(transportFor(network, ALICE));
  await assert.rejects(alice.workspaces.inboxRequests(fixture.workspace), /degraded mode/);
});

test("appDeclaration reads 25 commands at their maximum bounds (~42 KiB) and rejects invalid declarations", async () => {
  const network = new FakeNetwork();
  const appDid = "did:plc:bigappaaaaaaaaaaaaaaaaaa";
  network.createAccount(ALICE, "pds1");
  network.createAccount(appDid, "pds2");
  const commands = Array.from({ length: 25 }, (_, index) => ({
    name: `cmd-${String(index).padStart(2, "0")}-${"a".repeat(25)}`,
    description: "👍".repeat(300),
    usage: "👍".repeat(100),
  }));
  const base = transportFor(network, ALICE);
  let storedRecord: Record<string, unknown> = {
    $type: REPO_COLLECTION.appDeclaration,
    name: "Big App",
    description: "Handles 25 commands.",
    commands,
    createdAt: "2026-11-10T12:00:00.000Z",
  };
  const alice = createEngine({
    ...base,
    fetchEndpoint: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/xrpc/com.atproto.repo.getRecord" && url.searchParams.get("repo") === appDid) {
        return Response.json({ uri: `at://${appDid}/${REPO_COLLECTION.appDeclaration}/self`, cid: "bafy", value: storedRecord });
      }
      return base.fetchEndpoint(request);
    },
  });
  const declaration = await alice.workspaces.appDeclaration(appDid);
  assert.equal(declaration?.name, "Big App");
  assert.equal(declaration?.commands?.length, 25);
  assert.deepEqual(declaration?.commands?.[0], commands[0]);

  storedRecord = { ...storedRecord, commands: [{ name: "dup" }, { name: "dup" }] };
  assert.equal(await alice.workspaces.appDeclaration(appDid), null);
});

test("operator client exposes enableExtension and disableExtension over execute", async () => {
  const network = new FakeNetwork();
  const requests: Array<{ method: string; body: unknown }> = [];
  const base = transportFor(network, ALICE);
  const wsUri = workspaceUri(AUTHORITY);
  const transport: ClientTransport = {
    ...base,
    fetchEndpoint: async (request) => {
      const url = new URL(request.url);
      if (url.origin !== OPERATOR.endpoint) return network.fetchEndpoint(request);
      const method = url.pathname.replace("/xrpc/", "");
      const body = request.body ? JSON.parse(await request.clone().text()) : undefined;
      requests.push({ method, body });
      return Response.json({
        operation: {
          operationId: (body as { operationId: string }).operationId,
          requestHash: "0".repeat(64),
          state: "completed",
          completedSteps: [],
          updatedAt: "2026-11-16T00:00:00.000Z",
        },
      });
    },
  };
  const { operator } = createEngine(transport, { operator: OPERATOR });
  const op1 = await operator!.enableExtension(wsUri, "tasks", "222222222222a");
  const op2 = await operator!.disableExtension(wsUri, "tasks", "222222222222b");
  assert.equal(op1.operation.state, "completed");
  assert.equal(op2.operation.state, "completed");
  assert.deepEqual(requests, [
    {
      method: OPERATOR_METHOD.execute,
      body: { workspace: wsUri, operationId: "222222222222a", request: { kind: "enableExtension", extId: "tasks" } },
    },
    {
      method: OPERATOR_METHOD.execute,
      body: { workspace: wsUri, operationId: "222222222222b", request: { kind: "disableExtension", extId: "tasks" } },
    },
  ]);
});

test("WorkspaceClient discovers extensions, tracks completeness flags against invalid/truncated records, and purges disabled extension spaces", async () => {
  const network = new FakeNetwork();
  const fixture = await createWorkspace(network, {
    members: [ALICE, BOB],
    channels: [{ skey: "general", visibility: "public" }],
  });
  const tasksSpace = extSpaceUriFor(AUTHORITY, SELF_SKEY, "tasks");
  const owner = network.clientFor(AUTHORITY);
  await owner.procedure("com.atproto.space.createSpace", {
    spaceType: SPACE_TYPE.tasks,
    skey: SELF_SKEY,
    policy: {
      $type: OPENSOCIAL_POLICY,
      publicRead: false,
      unlisted: false,
      grants: [{ role: "member", read: true, write: true }],
    },
  });
  const nowIso = "2026-11-16T00:00:00.000Z";
  await network.writeAs(AUTHORITY, fixture.workspace, COLLECTION.extInstall, "tasks", {
    extId: "tasks",
    active: true,
    space: tasksSpace,
    cleanupComplete: false,
    enabledBy: ALICE,
    enabledAt: nowIso,
    updatedAt: nowIso,
  });

  const alice = createEngine(transportFor(network, ALICE));
  await alice.sync.store.putSpace({
    space: tasksSpace,
    spaceRev: "1",
    writers: [{ did: ALICE, repoRev: "1" }],
    writersListedAt: 1_000,
    workspace: fixture.workspace,
    lastOpenedAt: 1_000,
  });

  const activeDiscovery = await alice.workspaces.discover();
  const activeSummary = activeDiscovery.workspaces[0]!;
  assert.deepEqual(activeSummary.extensions, [{
    extId: "tasks",
    active: true,
    space: tasksSpace,
    cleanupComplete: false,
    enabledBy: ALICE,
    enabledAt: nowIso,
    updatedAt: nowIso,
  }]);
  assert.equal(activeSummary.rosterComplete, true);
  assert.equal(activeSummary.extensionsComplete, true);
  assert.equal(activeSummary.invalidRosterRecords, 0);
  assert.equal(activeSummary.invalidExtInstallRecords, 0);
  assert.notEqual(await alice.sync.store.getSpace(tasksSpace), undefined, "active extension space is retained");

  // Inject malformed membership and ext.install records over wire to verify countInvalidAuthorityRecords drops completeness flags.
  const baseTransport = transportFor(network, ALICE);
  let injectMalformed = true;
  let forceExtTruncated = false;
  let extPage = 0;
  const inspectedEngine = createEngine({
    ...baseTransport,
    fetchEndpoint: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/xrpc/com.atproto.space.listRecords") {
        const col = url.searchParams.get("collection");
        if (injectMalformed && col === OPENSOCIAL_COLLECTION.membership) {
          const upstream = await baseTransport.fetchEndpoint(request);
          const json = (await upstream.json()) as { records: unknown[] };
          return Response.json({
            records: [
              ...json.records,
              { collection: OPENSOCIAL_COLLECTION.membership, rkey: "not-a-did", value: { roles: [], createdAt: nowIso } },
            ],
          });
        }
        if (injectMalformed && col === COLLECTION.extInstall) {
          const upstream = await baseTransport.fetchEndpoint(request);
          const json = (await upstream.json()) as { records: unknown[] };
          return Response.json({
            records: [
              ...json.records,
              { collection: COLLECTION.extInstall, rkey: "bad-ext", value: { extId: "tasks", active: true } },
            ],
          });
        }
        if (forceExtTruncated && col === COLLECTION.extInstall) {
          const page = extPage++;
          if (page < 2) {
            return Response.json({
              records: Array.from({ length: 500 }, (_, index) => ({
                collection: COLLECTION.extInstall,
                rkey: `ext-${page * 500 + index}`,
                value: { $type: COLLECTION.extInstall, extId: `ext-${page * 500 + index}` },
              })),
              cursor: `p${page + 1}`,
            });
          }
          return Response.json({
            records: [{ collection: COLLECTION.extInstall, rkey: "ext-1000", value: { $type: COLLECTION.extInstall, extId: "ext-1000" } }],
          });
        }
      }
      return baseTransport.fetchEndpoint(request);
    },
  }, { store: alice.sync.store });

  const malformedSummary = await inspectedEngine.workspaces.summary(fixture.workspace);
  assert.equal(malformedSummary?.rosterComplete, false);
  assert.equal(malformedSummary?.extensionsComplete, false);
  assert.equal(malformedSummary?.invalidRosterRecords, 1);
  assert.equal(malformedSummary?.invalidExtInstallRecords, 1);
  assert.match((malformedSummary?.degradedReasons ?? []).join(" "), /malformed entries/);

  injectMalformed = false;
  forceExtTruncated = true;
  const truncatedSummary = await inspectedEngine.workspaces.summary(fixture.workspace);
  assert.equal(truncatedSummary?.extensionsComplete, false);
  assert.match((truncatedSummary?.degradedReasons ?? []).join(" "), /extension list may be incomplete/);
  assert.notEqual(await alice.sync.store.getSpace(tasksSpace), undefined, "truncated extension scan does not purge space");
  forceExtTruncated = false;

  // Disabling the extension purges its space from the store on summary()!
  await network.writeAs(AUTHORITY, fixture.workspace, COLLECTION.extInstall, "tasks", {
    extId: "tasks",
    active: false,
    space: tasksSpace,
    cleanupComplete: true,
    enabledBy: ALICE,
    enabledAt: nowIso,
    updatedAt: nowIso,
    disabledAt: nowIso,
  });
  const disabledSummary = await alice.workspaces.summary(fixture.workspace);
  assert.equal(disabledSummary?.extensions?.[0]?.active, false);
  assert.equal(disabledSummary?.extensions?.[0]?.cleanupComplete, true);
  assert.equal(await alice.sync.store.getSpace(tasksSpace), undefined, "disabled extension space is purged");

  // Re-enable, put space back in store, and verify removing ALICE from workspace purges extension space on discover().
  await network.writeAs(AUTHORITY, fixture.workspace, COLLECTION.extInstall, "tasks", {
    extId: "tasks",
    active: true,
    space: tasksSpace,
    cleanupComplete: false,
    enabledBy: ALICE,
    enabledAt: nowIso,
    updatedAt: nowIso,
  });
  await alice.sync.store.putSpace({
    space: tasksSpace,
    spaceRev: "2",
    writers: [],
    writersListedAt: 2_000,
    workspace: fixture.workspace,
    lastOpenedAt: 2_000,
  });
  await owner.procedure("com.atproto.space.deleteRecord", {
    space: fixture.members,
    repo: AUTHORITY,
    collection: OPENSOCIAL_COLLECTION.membership,
    rkey: ALICE,
  });
  network.advanceClock(11 * 60 * 1000);
  await alice.workspaces.discover();
  assert.equal(await alice.sync.store.getSpace(tasksSpace), undefined, "losing workspace purges dependent extension space");
});

test("ensureInvitesSpace provisions fresh PDS invites/self, deduplicates concurrent SpaceAlreadyExists races, skips createSpace on restart, and rejects incompatible policies", async () => {
  // 1. Fresh personal PDS: getSpace(404) -> createSpace -> getSpace + listMembers; warm in-session call pays 0 XRPCs; restart calls getSpace + listMembers without createSpace.
  {
    const network = new FakeNetwork();
    network.createAccount(ALICE, "pds1");
    const alice = createEngine(transportFor(network, ALICE));
    const expectedUri = personalInvitesUri(ALICE);

    const firstCalls = await countCalls(network, async () => {
      const uri = await alice.workspaces.ensureInvitesSpace();
      assert.equal(uri, expectedUri);
    });
    assert.equal(firstCalls["com.atproto.space.createSpace"], 1);
    assert.equal(firstCalls["com.atproto.memberspace.listMembers"], 1);

    const warmCalls = await countCalls(network, async () => {
      await alice.workspaces.ensureInvitesSpace();
    });
    assert.deepEqual(warmCalls, {}, "warm in-session call pays 0 XRPCs");

    const restarted = createEngine(transportFor(network, ALICE));
    const restartCalls = await countCalls(network, async () => {
      await restarted.workspaces.ensureInvitesSpace();
    });
    assert.equal(restartCalls["com.atproto.space.createSpace"], undefined, "restart verifies without calling createSpace");
    assert.equal(restartCalls["com.atproto.space.getSpace"], 1);
    assert.equal(restartCalls["com.atproto.memberspace.listMembers"], 1);
  }

  // 2. Concurrent SpaceAlreadyExists race during createSpace falls through cleanly to getSpace + listMembers validation.
  {
    const network = new FakeNetwork();
    network.createAccount(ALICE, "pds1");
    const base = transportFor(network, ALICE);
    let interceptedCreate = false;
    const racing = createEngine({
      ...base,
      memberClient: {
        query: (nsid, params, opts) => base.memberClient.query(nsid, params, opts),
        procedure: async (nsid, body, opts) => {
          if (nsid === "com.atproto.space.createSpace" && !interceptedCreate) {
            interceptedCreate = true;
            await base.memberClient.procedure(nsid, body, opts);
            throw new XrpcError(409, "Space already exists", "SpaceAlreadyExists");
          }
          return base.memberClient.procedure(nsid, body, opts);
        },
      } as ClientTransport["memberClient"],
    });
    assert.equal(await racing.workspaces.ensureInvitesSpace(), personalInvitesUri(ALICE));
    assert.equal(interceptedCreate, true);
  }

  // 3. Pre-existing incompatible policies (`allowedApps: []`, `publicWrite: false`, `publicRead: true`, or non-empty members) throw IncompatibleInvitesSpacePolicyError.
  for (const badCase of [
    { label: "allowedApps: []", policy: { $type: "com.atproto.memberspace.policy", publicRead: false, publicWrite: true, allowedApps: [] }, addMember: false },
    { label: "publicWrite: false", policy: { $type: "com.atproto.memberspace.policy", publicRead: false, publicWrite: false }, addMember: false },
    { label: "publicRead: true", policy: { $type: "com.atproto.memberspace.policy", publicRead: true, publicWrite: true }, addMember: false },
    { label: "non-empty members", policy: { $type: "com.atproto.memberspace.policy", publicRead: false, publicWrite: true }, addMember: true },
  ]) {
    const network = new FakeNetwork();
    network.createAccount(ALICE, "pds1");
    network.createAccount(BOB, "pds1");
    const ownClient = network.clientFor(ALICE);
    await ownClient.procedure("com.atproto.space.createSpace", {
      spaceType: OPENSOCIAL_SPACE_TYPE.invites,
      skey: SELF_SKEY,
      policy: badCase.policy,
    });
    if (badCase.addMember) {
      network.seedPersonalSpaceMembers(ALICE, personalInvitesUri(ALICE), [
        { did: BOB, read: true, write: true },
      ]);
    }
    const alice = createEngine(transportFor(network, ALICE));
    await assert.rejects(
      alice.workspaces.ensureInvitesSpace(),
      (err: unknown) => err instanceof IncompatibleInvitesSpacePolicyError,
      `must reject ${badCase.label}`,
    );
    await assert.rejects(
      alice.workspaces.discover(),
      (err: unknown) => err instanceof IncompatibleInvitesSpacePolicyError,
      `discover() must surface IncompatibleInvitesSpacePolicyError on ${badCase.label}`,
    );
  }
});

test("listInvites reads cross-PDS invites, redirects across PLC host migration on RepoNotFound, and prunes tombstoned or deleted group invites", async () => {
  const network = new FakeNetwork();
  network.createAccount(ALICE, "pds1");
  const aliceBase = transportFor(network, ALICE);
  const tombstonedGroups = new Set<string>();
  const redirectedEndpoints = new Map<string, string>();
  let staleSourceOnce = false;

  const alice = createEngine({
    ...aliceBase,
    resolvePds: async (did, force) => {
      if (tombstonedGroups.has(did)) throw new DidNotFoundError(did);
      if (!force && staleSourceOnce && redirectedEndpoints.has(did)) {
        staleSourceOnce = false;
        return "https://migrated-away-source.test";
      }
      return redirectedEndpoints.get(did) ?? aliceBase.resolvePds(did, force);
    },
    fetchEndpoint: async (request) => {
      const url = new URL(request.url);
      if (url.origin === "https://migrated-away-source.test") {
        return Response.json({ error: "RepoNotFound", message: "migrated away" }, { status: 400 });
      }
      return aliceBase.fetchEndpoint(request);
    },
  });

  await alice.workspaces.ensureInvitesSpace();
  const group1 = await createWorkspace(network, { skey: "invone", admins: [BOB], members: [BOB], channels: [] });
  const group2 = await createWorkspace(network, { skey: "invtwo", admins: [BOB], members: [BOB], channels: [] });

  const makeGroupClient = (groupDid: string) => {
    const token = network.issueSessionToken(groupDid);
    return new GroupClient({
      groupDid,
      fetchHandler: async (path, init) => {
        const pds = await network.resolvePds(groupDid);
        const headers = new Headers(init?.headers);
        headers.set("authorization", `Bearer ${token}`);
        return network.fetchEndpoint(new Request(new URL(path, pds), { ...init, headers }));
      },
      fetchEndpoint: network.fetchEndpoint,
      now: network.now,
    });
  };
  const createdInv1 = await makeGroupClient(group1.groupDid).createInvite(ALICE, { message: "Join Group 1!" });
  await makeGroupClient(group2.groupDid).createInvite(ALICE);

  // Verify raw record emitted by createInvite omits nonstandard `group` property!
  const rawInv1 = await network.clientFor(group1.groupDid).query<{ value: Record<string, unknown> }>(
    "com.atproto.space.getRecord",
    {
      space: personalInvitesUri(ALICE),
      repo: group1.groupDid,
      collection: OPENSOCIAL_COLLECTION.invite,
      rkey: createdInv1.rkey,
    },
  );
  assert.equal("group" in rawInv1.value, false, "standards-conformant group.opensocial.invite omits group property");
  assert.equal(rawInv1.value.message, "Join Group 1!");

  // Spoofed invite record claiming a mismatched `group` DID is rejected, while legacy matching `group` is accepted!
  const spoofRkey = key(601);
  await network.clientFor(group1.groupDid).procedure("com.atproto.space.putRecord", {
    space: personalInvitesUri(ALICE),
    repo: group1.groupDid,
    collection: OPENSOCIAL_COLLECTION.invite,
    rkey: spoofRkey,
    record: {
      $type: OPENSOCIAL_COLLECTION.invite,
      group: group2.groupDid,
      createdAt: "2026-11-10T12:00:00.000Z",
    },
  });

  let invites = await alice.workspaces.listInvites();
  assert.deepEqual(invites.map((i) => i.groupDid).sort(), [group1.groupDid, group2.groupDid].sort());
  assert.equal(invites.some((i) => i.rkey === spoofRkey), false, "mismatched group property in invite record rejected");
  assert.equal(invites.find((i) => i.groupDid === group1.groupDid)?.message, "Join Group 1!");

  // Simulate stale initial endpoint returning RepoNotFound while PLC re-resolution points to the live Group Host -> invite survives!
  const realGroup1Endpoint = await network.resolvePds(group1.groupDid);
  let resolveCountForGroup1 = 0;
  const aliceMigration = createEngine({
    ...aliceBase,
    resolvePds: async (did, force) => {
      if (did === group1.groupDid) {
        resolveCountForGroup1 += 1;
        if (resolveCountForGroup1 === 1) return "https://migrated-away-source.test";
        return realGroup1Endpoint;
      }
      if (tombstonedGroups.has(did)) throw new DidNotFoundError(did);
      return aliceBase.resolvePds(did, force);
    },
    fetchEndpoint: async (request) => {
      if (new URL(request.url).origin === "https://migrated-away-source.test") {
        return Response.json({ error: "RepoNotFound", message: "migrated away" }, { status: 400 });
      }
      return aliceBase.fetchEndpoint(request);
    },
  }, { store: alice.sync.store });

  invites = await aliceMigration.workspaces.listInvites();
  assert.deepEqual(invites.map((i) => i.groupDid).sort(), [group1.groupDid, group2.groupDid].sort(), "migrated group invite survives via PLC re-resolution");

  // Tombstoning group2 on PLC authoritatively prunes group2's cached invite without needing getRepo to succeed!
  tombstonedGroups.add(group2.groupDid);
  invites = await aliceMigration.workspaces.listInvites();
  assert.deepEqual(invites.map((i) => i.groupDid), [group1.groupDid]);
  assert.deepEqual(await alice.sync.store.records(personalInvitesUri(ALICE), OPENSOCIAL_COLLECTION.invite, group2.groupDid), []);
});

test("3-phase leavingGroups preserves acceptance/self on LastAdmin and MembershipIncarnationMismatch, and reconciles cross-device rejoin in reconciling_post_delete", async () => {
  const network = new FakeNetwork();
  // 1. LastAdmin refused BEFORE touching own-PDS acceptance/self!
  const soleAdminWs = await createWorkspace(network, { skey: "soleadmin", admins: [ALICE], members: [ALICE, BOB], channels: [] });
  const alice = createEngine(transportFor(network, ALICE));
  await assert.rejects(
    alice.workspaces.leaveGroup(soleAdminWs.groupDid),
    (err: unknown) => err instanceof XrpcError && err.code === "LastAdmin",
  );
  assert.equal(await alice.sync.store.getLeavingGroup(soleAdminWs.groupDid), undefined, "leavingGroups cleared on LastAdmin");
  const intactAcc = await network.clientFor(ALICE).query<{ value: Record<string, unknown> }>("com.atproto.space.getRecord", {
    space: soleAdminWs.members,
    repo: ALICE,
    collection: OPENSOCIAL_COLLECTION.acceptance,
    rkey: SELF_SKEY,
  });
  assert.equal(typeof intactAcc.value.createdAt, "string", "own-PDS acceptance/self stayed untouched on LastAdmin");

  // 2. Stale expectedIncarnation (`409 MembershipIncarnationMismatch`) clears leavingGroups without deleting newer acceptance/self!
  const group2 = await createWorkspace(network, { skey: "incmismatch", admins: [BOB], members: [ALICE, BOB], channels: [] });
  await alice.sync.store.putLeavingGroup({
    groupDid: group2.groupDid,
    expectedIncarnation: "stale-incarnation-from-old-device",
    phase: "leaving_group",
    createdAt: network.now(),
  });
  await alice.workspaces.resumeJournals();
  assert.equal(await alice.sync.store.getLeavingGroup(group2.groupDid), undefined);
  const newerAcc = await network.clientFor(ALICE).query<{ value: Record<string, unknown> }>("com.atproto.space.getRecord", {
    space: group2.members,
    repo: ALICE,
    collection: OPENSOCIAL_COLLECTION.acceptance,
    rkey: SELF_SKEY,
  });
  assert.notEqual(newerAcc.value["new.flock.incarnation"], "stale-incarnation-from-old-device");

  // 3. Crash after Phase 2 deleted own-PDS acceptance/self (`phase = "reconciling_post_delete"`), while another device rejoined -> restores acceptance/self!
  const group3 = await createWorkspace(network, { skey: "rejoinrace", admins: [BOB], members: [ALICE, BOB], channels: [] });
  const memBefore = await network.clientFor(group3.groupDid).query<{ value: Record<string, unknown> }>("com.atproto.space.getRecord", {
    space: group3.members,
    repo: group3.groupDid,
    collection: OPENSOCIAL_COLLECTION.membership,
    rkey: ALICE,
  });
  const liveInc = String(memBefore.value["new.flock.incarnation"]);
  // Simulate own-PDS acceptance/self deleted just before crash while group3 holds a newer incarnation than expectedIncarnation
  await network.clientFor(ALICE).procedure("com.atproto.space.deleteRecord", {
    space: group3.members,
    repo: ALICE,
    collection: OPENSOCIAL_COLLECTION.acceptance,
    rkey: SELF_SKEY,
  });
  await alice.sync.store.putLeavingGroup({
    groupDid: group3.groupDid,
    expectedIncarnation: "pre-rejoin-incarnation",
    phase: "reconciling_post_delete",
    createdAt: network.now(),
  });
  const discovered = await alice.workspaces.discover();
  assert.equal(await alice.sync.store.getLeavingGroup(group3.groupDid), undefined);
  assert.equal(discovered.workspaces.some((w) => w.groupDid === group3.groupDid), true, "bilateral acceptance restored on cross-device rejoin");
  const restoredAcc = await network.clientFor(ALICE).query<{ value: Record<string, unknown> }>("com.atproto.space.getRecord", {
    space: group3.members,
    repo: ALICE,
    collection: OPENSOCIAL_COLLECTION.acceptance,
    rkey: SELF_SKEY,
  });
  assert.equal(restoredAcc.value["new.flock.incarnation"], liveInc);

  // 4. Normal leaveGroup completes all 3 phases, deletes own-PDS acceptance/self, and removes workspace from discovery.
  await alice.workspaces.leaveGroup(group3.groupDid);
  assert.equal(await alice.sync.store.getLeavingGroup(group3.groupDid), undefined);
  await assert.rejects(
    network.clientFor(ALICE).query("com.atproto.space.getRecord", {
      space: group3.members,
      repo: ALICE,
      collection: OPENSOCIAL_COLLECTION.acceptance,
      rkey: SELF_SKEY,
    }),
  );
});

test("5-phase joiningGroups handles open, invite, approval (pending survival, orphaned_by_migration, expired_unknown, cancelJoinRequest 400), unsupported_status, and 429 quota_exceeded", async () => {
  const network = new FakeNetwork();
  network.createAccount(ALICE, "pds1");
  const alice = createEngine(transportFor(network, ALICE));
  await alice.workspaces.ensureInvitesSpace();

  // 1. Open join completes all 5 phases and populates discovery.
  const openWs = await createWorkspace(network, { skey: "openjoin", joinPolicy: "open", admins: [BOB], members: [BOB], channels: [{ skey: "general", visibility: "public" }] });
  const openRes = await alice.workspaces.joinGroup({ groupDid: openWs.groupDid, mode: "open" });
  assert.equal(openRes.status, "admitted");
  assert.deepEqual(await alice.sync.store.listJoiningGroups(), []);

  // 2. Invite join on an invite-only group redeems invite and completes all 5 phases.
  const invWs = await createWorkspace(network, { skey: "invjoin", joinPolicy: "invite", admins: [BOB], members: [BOB], channels: [] });
  const invToken = network.issueSessionToken(invWs.groupDid);
  await new GroupClient({
    groupDid: invWs.groupDid,
    fetchHandler: async (path, init) => {
      const pds = await network.resolvePds(invWs.groupDid);
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${invToken}`);
      return network.fetchEndpoint(new Request(new URL(path, pds), { ...init, headers }));
    },
    fetchEndpoint: network.fetchEndpoint,
    now: network.now,
  }).createInvite(ALICE);
  const [invite] = await alice.workspaces.listInvites();
  assert.equal(invite?.groupDid, invWs.groupDid);
  const invRes = await alice.workspaces.joinGroup({ groupDid: invWs.groupDid, mode: "invite", inviteUri: invite!.uri });
  assert.equal(invRes.status, "admitted");
  assert.deepEqual(await alice.workspaces.listInvites(), [], "redeemed invite deleted");

  // 3. Approval join stays `pending_approval` across `discover()`, transitions to `admitted` once approved, and `cancelJoinRequest` treats 400 JoinRequestNotFound as terminal!
  const appWs = await createWorkspace(network, { skey: "appjoin", joinPolicy: "approval", admins: [BOB], members: [BOB], channels: [] });
  const pendingRes = await alice.workspaces.joinGroup({ groupDid: appWs.groupDid, mode: "approval", message: "let me in", operationId: key(50) });
  assert.equal(pendingRes.status, "pending");
  let d = await alice.workspaces.discover();
  assert.equal(d.joiningGroups?.find((j) => j.operationId === key(50))?.phase, "pending_approval", "pending_approval survives discover()");

  // Approve on Group Host with If-Join-Request-Present: true
  await network.fetchEndpoint(
    new Request(`${await network.resolvePds(appWs.groupDid)}/xrpc/com.atproto.space.putRecord`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${network.issueSessionToken(appWs.groupDid)}`,
        "content-type": "application/json",
        "if-join-request-present": "true",
      },
      body: JSON.stringify({
        space: appWs.members,
        repo: appWs.groupDid,
        collection: OPENSOCIAL_COLLECTION.membership,
        rkey: ALICE,
        record: { $type: OPENSOCIAL_COLLECTION.membership, roles: ["member"], createdAt: "2026-11-10T12:00:00.000Z" },
      }),
    }),
  );
  d = await alice.workspaces.discover();
  assert.equal(d.workspaces.some((w) => w.groupDid === appWs.groupDid), true, "approved request completes admission on discover()");
  assert.equal(await alice.sync.store.getJoiningGroup(key(50)), undefined);

  // cancelJoinRequest when already absent (400 JoinRequestNotFound) clears local pending_approval cleanly
  const cancelWs = await createWorkspace(network, { skey: "canceljoin", joinPolicy: "approval", admins: [BOB], members: [BOB], channels: [] });
  await alice.sync.store.putJoiningGroup({
    operationId: key(51),
    mode: "approval",
    intentHash: "hash",
    authorityEndpoint: await network.resolvePds(cancelWs.groupDid),
    groupDid: cancelWs.groupDid,
    phase: "pending_approval",
    createdAt: network.now(),
  });
  await alice.workspaces.cancelJoinRequest(cancelWs.groupDid);
  assert.equal(await alice.sync.store.getJoiningGroup(key(51)), undefined);

  // 4. `orphaned_by_migration` (unknown + changed endpoint) and `expired_unknown` (unknown + same endpoint) stay passive without auto-retry!
  await alice.sync.store.putJoiningGroup({
    operationId: key(52),
    mode: "approval",
    intentHash: "hash-mig",
    authorityEndpoint: "https://old-host-before-migration.test",
    groupDid: cancelWs.groupDid,
    phase: "pending_approval",
    createdAt: network.now(),
  });
  await alice.sync.store.putJoiningGroup({
    operationId: key(53),
    mode: "approval",
    intentHash: "hash-exp",
    authorityEndpoint: await network.resolvePds(cancelWs.groupDid),
    groupDid: cancelWs.groupDid,
    phase: "pending_approval",
    createdAt: network.now(),
  });
  d = await alice.workspaces.discover();
  assert.equal(d.joiningGroups?.find((j) => j.operationId === key(52))?.phase, "orphaned_by_migration");
  assert.equal(d.joiningGroups?.find((j) => j.operationId === key(53))?.phase, "expired_unknown");
  await alice.workspaces.dismissJoinOperation(key(52));
  await alice.workspaces.dismissJoinOperation(key(53));

  // 5. Unknown forward-compatible `status` -> `unsupported_status` & `429 JoinOperationQuotaExceeded` -> passive `quota_exceeded` surviving discover() without auto-retry!
  const base = transportFor(network, ALICE);
  let mockJoinMode: "unsupported" | "quota" | "normal" = "unsupported";
  let requestJoinCalls = 0;
  const mockedAlice = createEngine({
    ...base,
    fetchEndpoint: async (req) => {
      if (new URL(req.url).pathname === "/xrpc/group.opensocial.requestJoin") {
        requestJoinCalls += 1;
        if (mockJoinMode === "unsupported") {
          return Response.json({ status: "waitlisted_v2" });
        }
        if (mockJoinMode === "quota") {
          return Response.json({ error: "JoinOperationQuotaExceeded", message: "quota exceeded" }, { status: 429 });
        }
      }
      return base.fetchEndpoint(req);
    },
  }, { store: alice.sync.store });

  await assert.rejects(
    mockedAlice.workspaces.joinGroup({ groupDid: cancelWs.groupDid, mode: "approval", operationId: key(54) }),
    (err: unknown) => err instanceof UnsupportedJoinStatusError && err.rawStatus === "waitlisted_v2",
  );
  assert.equal((await alice.sync.store.getJoiningGroup(key(54)))?.phase, "unsupported_status");

  mockJoinMode = "quota";
  await assert.rejects(
    mockedAlice.workspaces.joinGroup({ groupDid: cancelWs.groupDid, mode: "approval", operationId: key(55) }),
    (err: unknown) => err instanceof JoinOperationQuotaExceededError,
  );
  assert.equal((await alice.sync.store.getJoiningGroup(key(55)))?.phase, "quota_exceeded");

  const callsBeforeDiscover = requestJoinCalls;
  await mockedAlice.workspaces.discover();
  assert.equal(requestJoinCalls, callsBeforeDiscover, "passive unsupported_status and quota_exceeded rows never auto-retry on discover()");

  mockJoinMode = "normal";
  const retried = await mockedAlice.workspaces.retryJoinOperation(key(55));
  assert.equal(retried.status, "pending");
  assert.equal(await alice.sync.store.getJoiningGroup(key(55)), undefined);
});

test("4-phase reactivatingGroups activates deactivated sole-member group, restores acceptance/self, runs reauthorizeOperator, and refreshes discovery via non-recursing discoverCore()", async () => {
  const network = new FakeNetwork();
  const groupDid = plcDidForLabel("reactgrp");
  await createWorkspace(network, { authority: groupDid, admins: [ALICE], members: [ALICE], channels: [{ skey: "general", visibility: "public" }] });
  const aliceTransport = transportFor(network, ALICE);
  const alice = createEngine(aliceTransport);

  // Sole-member leave deactivates the group and records ALICE as recoveryAdmin.
  await alice.workspaces.leaveGroup(groupDid);
  assert.equal((await alice.workspaces.discover()).workspaces.some((w) => w.groupDid === groupDid), false);

  let operatorReauthed = 0;
  const groupClient = new GroupClient({
    groupDid,
    fetchHandler: async (path, init) => {
      const pds = await network.resolvePds(groupDid);
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${network.issueGroupSessionToken(groupDid, ALICE, { sessionKind: "recovery" })}`);
      return network.fetchEndpoint(new Request(new URL(path, pds), { ...init, headers }));
    },
    fetchEndpoint: network.fetchEndpoint,
    now: network.now,
  });

  await alice.workspaces.reactivateGroup(groupDid, {
    operationId: key(60),
    getGroupClient: async () => groupClient,
    reauthorizeOperator: async (did) => {
      assert.equal(did, groupDid);
      operatorReauthed += 1;
      return true;
    },
  });

  assert.equal(operatorReauthed, 1);
  assert.equal(await alice.sync.store.getReactivatingGroup(key(60)), undefined);
  const after = await alice.workspaces.discover();
  assert.equal(after.workspaces.some((w) => w.groupDid === groupDid), true, "reactivated group is live in discovery");
});

test("lifecycle journals reject reused operationId with mismatched intentHash or groupDid via 409 IdempotencyParameterMismatch", async () => {
  const network = new FakeNetwork();
  const wsA = await createWorkspace(network, { skey: "idema", joinPolicy: "approval", admins: [BOB], members: [BOB], channels: [] });
  const wsB = await createWorkspace(network, { skey: "idemb", joinPolicy: "approval", admins: [BOB], members: [BOB], channels: [] });
  network.createAccount(ALICE, "pds1");
  const aliceIdemBase = transportFor(network, ALICE);
  const alice = createEngine(withOperator(network, aliceIdemBase, () => ({})), { operator: OPERATOR });

  const joinOpId = key(70);
  const pending = await alice.workspaces.joinGroup({
    groupDid: wsA.groupDid,
    mode: "approval",
    message: "original request",
    operationId: joinOpId,
  });
  assert.equal(pending.status, "pending");

  // Reusing `joinOpId` with a different groupDid or message throws 409 IdempotencyParameterMismatch without overwriting `wsA`!
  await assert.rejects(
    alice.workspaces.joinGroup({ groupDid: wsB.groupDid, mode: "approval", message: "original request", operationId: joinOpId }),
    (err: unknown) => err instanceof IdempotencyParameterMismatchError && err.status === 409 && err.code === "IdempotencyParameterMismatch",
  );
  await assert.rejects(
    alice.workspaces.joinGroup({ groupDid: wsA.groupDid, mode: "approval", message: "different message", operationId: joinOpId }),
    (err: unknown) => err instanceof IdempotencyParameterMismatchError && err.code === "IdempotencyParameterMismatch",
  );
  await assert.rejects(
    alice.workspaces.createGroupWorkspace(
      alice.operator!,
      { name: "Mismatch", joinPolicy: "invite", publicMeta: true },
      { operationId: joinOpId },
    ),
    (err: unknown) => err instanceof IdempotencyParameterMismatchError && err.code === "IdempotencyParameterMismatch",
  );
  await assert.rejects(
    alice.workspaces.reactivateGroup(wsA.groupDid, { operationId: joinOpId }),
    (err: unknown) => err instanceof IdempotencyParameterMismatchError && err.code === "IdempotencyParameterMismatch",
  );
  assert.equal((await alice.sync.store.getJoiningGroup(joinOpId))?.groupDid, wsA.groupDid, "original journal entry remains intact");

  // Reusing a reactivation operationId for a different groupDid also throws 409 IdempotencyParameterMismatch.
  const reactOpId = key(71);
  await alice.sync.store.putReactivatingGroup({
    operationId: reactOpId,
    groupDid: wsA.groupDid,
    phase: "reauthorizing_operator",
    createdAt: network.now(),
  });
  await assert.rejects(
    alice.workspaces.reactivateGroup(wsB.groupDid, { operationId: reactOpId }),
    (err: unknown) => err instanceof IdempotencyParameterMismatchError && err.code === "IdempotencyParameterMismatch",
  );
});

test("leaveGroup preserves leaving_group journal on 409 MigrationInProgress and completes on resumeJournals after migration finishes", async () => {
  const network = new FakeNetwork();
  const ws = await createWorkspace(network, { skey: "migleave", admins: [BOB], members: [ALICE, BOB], channels: [] });
  const base = transportFor(network, ALICE);
  let migrationActive = true;

  const alice = createEngine({
    ...base,
    fetchEndpoint: async (req) => {
      if (migrationActive && new URL(req.url).pathname === "/xrpc/group.opensocial.leaveGroup") {
        return Response.json(
          { error: "MigrationInProgress", message: "group repository frozen during host migration" },
          { status: 409 },
        );
      }
      return base.fetchEndpoint(req);
    },
  });

  await assert.rejects(
    alice.workspaces.leaveGroup(ws.groupDid),
    (err: unknown) => err instanceof XrpcError && err.status === 409 && err.code === "MigrationInProgress",
  );
  const preserved = await alice.sync.store.getLeavingGroup(ws.groupDid);
  assert.equal(preserved?.phase, "leaving_group", "409 MigrationInProgress keeps leaving_group durable");

  migrationActive = false;
  await alice.workspaces.resumeJournals();
  assert.equal(await alice.sync.store.getLeavingGroup(ws.groupDid), undefined, "resumeJournals completes leave once migration finishes");
  assert.equal((await alice.workspaces.discover()).workspaces.some((w) => w.groupDid === ws.groupDid), false);
});

test("reactivatingGroups reauthorizing_operator probes Operator session, stays in reauthorizing_operator until Operator has grant, and completes on return", async () => {
  const network = new FakeNetwork();
  const groupDid = plcDidForLabel("reactop");
  await createWorkspace(network, {
    authority: groupDid,
    admins: [ALICE],
    members: [ALICE],
    channels: [{ skey: "general", visibility: "public" }],
  });

  let operatorAuthorized = false;
  let stalledProbes = 0;
  const aliceBase = transportFor(network, ALICE);
  const aliceWithOp = withOperator(network, aliceBase, (method) => {
    if (method === OPERATOR_METHOD.listStalledOperations) {
      stalledProbes += 1;
      if (!operatorAuthorized) {
        return Response.json({ error: "AuthoritySessionUnavailable", message: "reauth required" }, { status: 502 });
      }
      return { operations: [], truncated: false };
    }
    return {};
  });

  const groupClient = new GroupClient({
    groupDid,
    fetchHandler: async (path, init) => {
      const pds = await network.resolvePds(groupDid);
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${network.issueGroupSessionToken(groupDid, ALICE, { sessionKind: "recovery" })}`);
      return network.fetchEndpoint(new Request(new URL(path, pds), { ...init, headers }));
    },
    fetchEndpoint: network.fetchEndpoint,
    now: network.now,
  });

  // Engine WITHOUT reauthorizeOperator hook must NOT advance past reauthorizing_operator when Operator lacks grant!
  const aliceNoHook = createEngine(aliceWithOp, {
    operator: OPERATOR,
    getGroupClient: async () => groupClient,
  });
  await aliceNoHook.workspaces.leaveGroup(groupDid);

  const opId = key(72);
  await assert.rejects(
    aliceNoHook.workspaces.reactivateGroup(groupDid, { operationId: opId }),
    (err: unknown) => err instanceof OperatorRemoteError && err.code === "AuthorizationRequired",
  );
  assert.equal((await aliceNoHook.sync.store.getReactivatingGroup(opId))?.phase, "reauthorizing_operator");

  // Async navigation hook that starts redirect BEFORE Operator callback completes also keeps phase === "reauthorizing_operator"!
  let navTriggered = 0;
  await assert.rejects(
    aliceNoHook.workspaces.reactivateGroup(groupDid, {
      operationId: opId,
      reauthorizeOperator: async () => {
        navTriggered += 1;
        // Browser navigation started, `/authority/callback` has not yet run!
      },
    }),
    (err: unknown) => err instanceof OperatorRemoteError && err.code === "AuthorizationRequired",
  );
  assert.equal(navTriggered, 1);
  assert.equal((await aliceNoHook.sync.store.getReactivatingGroup(opId))?.phase, "reauthorizing_operator");

  // Once `/authority/callback` grants Operator its session, probing `listStalledOperations` succeeds immediately without re-invoking navigation!
  operatorAuthorized = true;
  const probesBeforeReturn = stalledProbes;
  let secondNavTriggered = 0;
  await aliceNoHook.workspaces.reactivateGroup(groupDid, {
    operationId: opId,
    reauthorizeOperator: async () => {
      secondNavTriggered += 1;
    },
  });
  assert.equal(secondNavTriggered, 0, "already-authorized Operator advances directly without re-running redirect hook");
  assert.equal(stalledProbes > probesBeforeReturn, true);
  assert.equal(await aliceNoHook.sync.store.getReactivatingGroup(opId), undefined);
  assert.equal((await aliceNoHook.workspaces.discover()).workspaces.some((w) => w.groupDid === groupDid), true);
});

test("WorkspaceClient.summary exposes publicMeta accurately and withholds !takedown-labeled members", async () => {
  const network = new FakeNetwork();
  const ws = await createWorkspace(network, {
    skey: "summeta",
    admins: [ALICE],
    members: [ALICE, BOB, CAROL],
    channels: [{ skey: "general", visibility: "public" }],
  });
  const owner = network.clientFor(ws.groupDid);
  const alice = createEngine(transportFor(network, ALICE));

  // Default fixture creates publicMeta: true; flip meta/self to publicRead: false and publish !takedown on BOB.
  const currentMeta = await owner.query<{ policy: Record<string, unknown> }>("com.atproto.space.getSpace", {
    space: ws.meta,
  });
  await owner.procedure("com.atproto.space.updateSpace", {
    space: ws.meta,
    policy: { ...currentMeta.policy, publicRead: false },
  });
  await owner.procedure("com.atproto.space.putRecord", {
    space: ws.members,
    repo: ws.groupDid,
    collection: ATPROTO_SPACE_COLLECTION.label,
    rkey: key(75),
    record: {
      $type: ATPROTO_SPACE_COLLECTION.label,
      src: ws.groupDid,
      uri: BOB,
      val: "!takedown",
      cts: "2026-11-10T12:05:00.000Z",
    },
  });

  const summary = await alice.workspaces.summary(ws.workspace);
  assert.ok(summary);
  assert.equal(summary.publicMeta, false);
  assert.deepEqual(summary.members.map((m) => m.did).sort(), [ALICE, CAROL].sort());
  assert.equal(summary.takendownMembers?.includes(BOB), true);
});

test("leaveGroup fails closed on incarnation read failures and parks RepoTakendown in blocked_deactivated preserving expectedIncarnation", async () => {
  const network = new FakeNetwork();
  const ws = await createWorkspace(network, {
    skey: "leavetakedown",
    admins: [BOB],
    members: [ALICE, BOB],
    channels: [],
  });
  const base = transportFor(network, ALICE);

  // 1. Transient 500 reading own acceptance/self or join-status MUST fail closed without omitting If-Match-Membership-Incarnation!
  let failJoinStatus = true;
  const leaveHeadersSeen: Array<string | null> = [];
  const aliceFailClosed = createEngine({
    ...base,
    fetchEndpoint: async (req) => {
      const url = new URL(req.url);
      if (failJoinStatus && url.pathname === "/group-member/join-status") {
        return Response.json({ error: "UpstreamFailure", message: "join-status temporarily unavailable" }, { status: 503 });
      }
      if (url.pathname === "/xrpc/group.opensocial.leaveGroup") {
        leaveHeadersSeen.push(req.headers.get("if-match-membership-incarnation"));
      }
      return base.fetchEndpoint(req);
    },
  });

  await assert.rejects(
    aliceFailClosed.workspaces.leaveGroup(ws.groupDid),
    (err: unknown) => err instanceof XrpcError && err.status === 503,
  );
  assert.equal(leaveHeadersSeen.length, 0, "leaveGroup XRPC must never be sent when incarnation resolution fails");
  assert.equal(await aliceFailClosed.sync.store.getLeavingGroup(ws.groupDid), undefined);

  // 2. RepoTakendown on live Group Host parks journal in blocked_deactivated WITHOUT deleting acceptance/self!
  failJoinStatus = false;
  let takendownActive = true;
  const aliceTakendown = createEngine(
    {
      ...base,
      fetchEndpoint: async (req) => {
        const url = new URL(req.url);
        if (takendownActive && url.pathname === "/xrpc/group.opensocial.leaveGroup") {
          leaveHeadersSeen.push(req.headers.get("if-match-membership-incarnation"));
          return Response.json({ error: "RepoTakendown", message: "group temporarily taken down" }, { status: 400 });
        }
        if (url.pathname === "/xrpc/group.opensocial.leaveGroup") {
          leaveHeadersSeen.push(req.headers.get("if-match-membership-incarnation"));
        }
        return base.fetchEndpoint(req);
      },
    },
    { store: aliceFailClosed.sync.store },
  );

  await assert.rejects(
    aliceTakendown.workspaces.leaveGroup(ws.groupDid),
    (err: unknown) => err instanceof XrpcError && err.code === "RepoTakendown",
  );
  const parked = await aliceTakendown.sync.store.getLeavingGroup(ws.groupDid);
  assert.equal(parked?.phase, "blocked_deactivated");
  assert.equal(typeof parked?.expectedIncarnation, "string", "expectedIncarnation preserved in blocked_deactivated");
  const recordedIncarnation = parked!.expectedIncarnation!;

  // Own-PDS acceptance/self MUST still exist!
  const ownAccWhileParked = await network.clientFor(ALICE).query<{ value: Record<string, unknown> }>(
    "com.atproto.space.getRecord",
    {
      space: ws.members,
      repo: ALICE,
      collection: OPENSOCIAL_COLLECTION.acceptance,
      rkey: SELF_SKEY,
    },
  );
  assert.equal(ownAccWhileParked.value["new.flock.incarnation"], recordedIncarnation);

  // resumeJournals() leaves passive blocked_deactivated untouched
  await aliceTakendown.workspaces.resumeJournals();
  assert.equal((await aliceTakendown.sync.store.getLeavingGroup(ws.groupDid))?.phase, "blocked_deactivated");

  // 3. Once takedown is lifted, retrying leaveGroup reuses recorded expectedIncarnation and completes all 3 phases!
  takendownActive = false;
  await aliceTakendown.workspaces.leaveGroup(ws.groupDid);
  assert.equal(leaveHeadersSeen.at(-1), recordedIncarnation);
  assert.equal(await aliceTakendown.sync.store.getLeavingGroup(ws.groupDid), undefined);
  await assert.rejects(
    network.clientFor(ALICE).query("com.atproto.space.getRecord", {
      space: ws.members,
      repo: ALICE,
      collection: OPENSOCIAL_COLLECTION.acceptance,
      rkey: SELF_SKEY,
    }),
  );
});

test("WorkspaceClient.summary withholds roster on truncated accountLabelScan, listInvites preserves cached invites on truncated writer/record scans, and operator-less reactivateGroup honors false reauthorizeOperator", async () => {
  const network = new FakeNetwork();
  const ws = await createWorkspace(network, {
    skey: "truncws",
    admins: [ALICE],
    members: [ALICE, BOB],
    channels: [{ skey: "general", visibility: "public" }],
  });
  const base = transportFor(network, ALICE);

  // 1. Truncated accountLabelScan sets rosterComplete: false and withholds members & pendingMembers!
  const aliceTruncLabels = createEngine({
    ...base,
    fetchEndpoint: async (req) => {
      const url = new URL(req.url);
      if (
        url.pathname === "/xrpc/com.atproto.space.listRecords" &&
        url.searchParams.get("space") === ws.members &&
        url.searchParams.get("collection") === ATPROTO_SPACE_COLLECTION.label
      ) {
        const offset = Number((url.searchParams.get("cursor") ?? "off-0").replace("off-", "")) || 0;
        const limit = Number(url.searchParams.get("limit") ?? "100");
        const total = 2_001;
        const count = Math.max(0, Math.min(limit, total - offset));
        const records = Array.from({ length: count }, (_, idx) => {
          const rkey = key(10_000 + offset + idx);
          return {
            uri: `${ws.members}/${ws.groupDid}/${ATPROTO_SPACE_COLLECTION.label}/${rkey}`,
            cid: "bafyreitest",
            collection: ATPROTO_SPACE_COLLECTION.label,
            rkey,
            value: {
              $type: ATPROTO_SPACE_COLLECTION.label,
              src: ws.groupDid,
              uri: BOB,
              val: "custom-tag",
              cts: "2026-11-10T12:00:00.000Z",
            },
          };
        });
        return Response.json({
          records,
          ...(offset + count < total ? { cursor: `off-${offset + count}` } : {}),
        });
      }
      return base.fetchEndpoint(req);
    },
  });

  const truncatedSummary = await aliceTruncLabels.workspaces.summary(ws.workspace);
  assert.ok(truncatedSummary);
  assert.equal(truncatedSummary.rosterComplete, false);
  assert.deepEqual(truncatedSummary.members, [], "members withheld when account label scan is truncated");
  assert.deepEqual(truncatedSummary.pendingMembers, [], "pendingMembers withheld when account label scan is truncated");
  assert.ok(truncatedSummary.degradedReasons.some((r) => r.includes("Account moderation label records exceed")));

  // 2. listInvites throws WorkspaceEnvelopeError on truncated writerScan / recordScan while preserving cached writers/records in SyncStore!
  const aliceInvites = createEngine(base);
  await aliceInvites.workspaces.ensureInvitesSpace();
  const invGroupA = await createWorkspace(network, { skey: "invtrunca", joinPolicy: "invite", admins: [BOB], members: [BOB], channels: [] });
  const invGroupB = await createWorkspace(network, { skey: "invtruncb", joinPolicy: "invite", admins: [BOB], members: [BOB], channels: [] });
  for (const grp of [invGroupA, invGroupB]) {
    const tok = network.issueSessionToken(grp.groupDid);
    await new GroupClient({
      groupDid: grp.groupDid,
      fetchHandler: async (path, init) => {
        const pds = await network.resolvePds(grp.groupDid);
        const headers = new Headers(init?.headers);
        headers.set("authorization", `Bearer ${tok}`);
        return network.fetchEndpoint(new Request(new URL(path, pds), { ...init, headers }));
      },
      fetchEndpoint: network.fetchEndpoint,
      now: network.now,
    }).createInvite(ALICE);
  }

  const initialInvites = await aliceInvites.workspaces.listInvites();
  assert.equal(initialInvites.length, 2);
  const initialGroupBCached = await aliceInvites.sync.store.records(
    personalInvitesUri(ALICE),
    OPENSOCIAL_COLLECTION.invite,
    invGroupB.groupDid,
  );
  assert.equal(initialGroupBCached.length, 1);

  const aliceTruncInvites = createEngine(
    {
      ...base,
      resolvePds: async (did, force) => {
        if (did.startsWith("did:web:fillerinv-")) {
          throw new DidNotFoundError(did);
        }
        return base.resolvePds(did, force);
      },
      fetchEndpoint: async (req) => {
        const url = new URL(req.url);
        if (
          url.pathname === "/xrpc/com.atproto.space.listWriters" &&
          url.searchParams.get("space") === personalInvitesUri(ALICE)
        ) {
          const offset = Number((url.searchParams.get("cursor") ?? "w-0").replace("w-", "")) || 0;
          const limit = Number(url.searchParams.get("limit") ?? "100");
          const total = 2_001;
          const count = Math.max(0, Math.min(limit, total - offset));
          const repos = Array.from({ length: count }, (_, idx) => ({
            $type: WRITER_WRITE_TYPE,
            repo:
              offset === 0 && idx === 0
                ? invGroupA.groupDid
                : `did:web:fillerinv-${offset + idx}.example`,
            repoRev: key(90),
            spaceRev: key(90),
          }));
          return Response.json({
            repos,
            ...(offset + count < total ? { cursor: `w-${offset + count}` } : {}),
          });
        }
        return base.fetchEndpoint(req);
      },
    },
    { store: aliceInvites.sync.store },
  );

  await assert.rejects(
    aliceTruncInvites.workspaces.listInvites(),
    (err: unknown) =>
      err instanceof WorkspaceEnvelopeError &&
      /exceeded bounded scan limits; invitation list is incomplete/.test(err.message),
  );
  assert.equal(
    (
      await aliceInvites.sync.store.records(
        personalInvitesUri(ALICE),
        OPENSOCIAL_COLLECTION.invite,
        invGroupB.groupDid,
      )
    ).length,
    1,
    "cached writer invGroupB is NOT purged from SyncStore when writerScan is truncated",
  );

  // Per-writer record scan truncation (> 100 records) ALSO rejects with WorkspaceEnvelopeError while retaining cached records!
  const initialGroupACachedRkey = (
    await aliceInvites.sync.store.records(
      personalInvitesUri(ALICE),
      OPENSOCIAL_COLLECTION.invite,
      invGroupA.groupDid,
    )
  )[0]!.rkey;

  const aliceTruncPerWriterInvites = createEngine(
    {
      ...base,
      fetchEndpoint: async (req) => {
        const url = new URL(req.url);
        if (
          url.pathname === "/xrpc/com.atproto.space.listRecords" &&
          url.searchParams.get("space") === personalInvitesUri(ALICE) &&
          url.searchParams.get("repo") === invGroupA.groupDid &&
          url.searchParams.get("collection") === OPENSOCIAL_COLLECTION.invite
        ) {
          const offset = Number((url.searchParams.get("cursor") ?? "r-0").replace("r-", "")) || 0;
          const limit = Number(url.searchParams.get("limit") ?? "100");
          const total = 101;
          const count = Math.max(0, Math.min(limit, total - offset));
          const records = Array.from({ length: count }, (_, idx) => {
            const rkey = key(20_000 + offset + idx);
            return {
              uri: `${personalInvitesUri(ALICE)}/${invGroupA.groupDid}/${OPENSOCIAL_COLLECTION.invite}/${rkey}`,
              cid: "bafyreiinv",
              collection: OPENSOCIAL_COLLECTION.invite,
              rkey,
              value: { $type: OPENSOCIAL_COLLECTION.invite, createdAt: "2026-11-10T12:00:00.000Z" },
            };
          });
          return Response.json({
            records,
            ...(offset + count < total ? { cursor: `r-${offset + count}` } : {}),
          });
        }
        return base.fetchEndpoint(req);
      },
    },
    { store: aliceInvites.sync.store },
  );

  await assert.rejects(
    aliceTruncPerWriterInvites.workspaces.listInvites(),
    (err: unknown) =>
      err instanceof WorkspaceEnvelopeError &&
      /exceeded bounded scan limits; invitation list is incomplete/.test(err.message),
  );
  const mergedGroupACached = await aliceInvites.sync.store.records(
    personalInvitesUri(ALICE),
    OPENSOCIAL_COLLECTION.invite,
    invGroupA.groupDid,
  );
  assert.equal(
    mergedGroupACached.some((r) => r.rkey === initialGroupACachedRkey),
    true,
    "previously cached invite record retained on truncated per-writer scan",
  );

  // 3. Operator-less reactivateGroup stays parked in reauthorizing_operator unless reauthorizeOperator returns strict `true`!
  const soloWs = await createWorkspace(network, {
    skey: "oplessreact",
    admins: [ALICE],
    members: [ALICE],
    channels: [],
  });
  await aliceInvites.workspaces.leaveGroup(soloWs.groupDid);
  const soloGroupClient = new GroupClient({
    groupDid: soloWs.groupDid,
    fetchHandler: async (path, init) => {
      const pds = await network.resolvePds(soloWs.groupDid);
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${network.issueGroupSessionToken(soloWs.groupDid, ALICE, { sessionKind: "recovery" })}`);
      return network.fetchEndpoint(new Request(new URL(path, pds), { ...init, headers }));
    },
    fetchEndpoint: network.fetchEndpoint,
    now: network.now,
  });

  const reactOp = key(95);
  // (a) Missing reauthorizeOperator hook when operator is absent -> stays in reauthorizing_operator!
  await assert.rejects(
    aliceInvites.workspaces.reactivateGroup(soloWs.groupDid, {
      operationId: reactOp,
      getGroupClient: () => soloGroupClient,
    }),
    (err: unknown) => err instanceof OperatorRemoteError && err.code === "AuthorizationRequired",
  );
  assert.equal((await aliceInvites.sync.store.getReactivatingGroup(reactOp))?.phase, "reauthorizing_operator");

  // Passive background resumeJournals() without operator or hook ALSO stays parked in reauthorizing_operator!
  await aliceInvites.workspaces.resumeJournals({ getGroupClient: () => soloGroupClient });
  assert.equal((await aliceInvites.sync.store.getReactivatingGroup(reactOp))?.phase, "reauthorizing_operator");

  // (b) reauthorizeOperator returning `undefined` -> stays in reauthorizing_operator!
  await assert.rejects(
    aliceInvites.workspaces.reactivateGroup(soloWs.groupDid, {
      operationId: reactOp,
      getGroupClient: () => soloGroupClient,
      reauthorizeOperator: async () => undefined,
    }),
    (err: unknown) => err instanceof OperatorRemoteError && err.code === "AuthorizationRequired",
  );
  assert.equal((await aliceInvites.sync.store.getReactivatingGroup(reactOp))?.phase, "reauthorizing_operator");

  // (c) reauthorizeOperator returning `false` -> stays in reauthorizing_operator!
  await assert.rejects(
    aliceInvites.workspaces.reactivateGroup(soloWs.groupDid, {
      operationId: reactOp,
      getGroupClient: () => soloGroupClient,
      reauthorizeOperator: async () => false,
    }),
    (err: unknown) => err instanceof OperatorRemoteError && err.code === "AuthorizationRequired",
  );
  assert.equal((await aliceInvites.sync.store.getReactivatingGroup(reactOp))?.phase, "reauthorizing_operator");

  // (d) Explicit `true` proof advances to refreshing_discovery and completes reactivation!
  await aliceInvites.workspaces.reactivateGroup(soloWs.groupDid, {
    operationId: reactOp,
    getGroupClient: () => soloGroupClient,
    reauthorizeOperator: async () => true,
  });
  assert.equal(await aliceInvites.sync.store.getReactivatingGroup(reactOp), undefined);
  assert.equal((await aliceInvites.workspaces.discover()).workspaces.some((w) => w.groupDid === soloWs.groupDid), true);
});

test("imported unversioned STAR memberships complete bilateral acceptance via legacy-cid:<cid> and reject stale CIDs on re-import", async () => {
  const network = new FakeNetwork();
  network.createAccount(ALICE, "pds1");
  network.createAccount(BOB, "pds2");
  network.createAccount(CAROL, "pds1");

  const ws = await createWorkspace(network, {
    skey: "legacystar",
    admins: [BOB],
    members: [BOB],
    channels: [{ skey: "general", visibility: "public" }],
  });

  // Read baseline non-membership records in `members/self` (`role/*`, `space/*`, `spacePolicy/self`)
  const baseListing = await network.clientFor(ws.groupDid).query<{
    records: Array<{ collection: string; rkey: string; value: Record<string, unknown> }>;
  }>("com.atproto.space.listRecords", {
    space: ws.members,
    repo: ws.groupDid,
    limit: 100,
  });
  const baseNonMemberships = baseListing.records
    .filter((rec) => rec.collection !== OPENSOCIAL_COLLECTION.membership)
    .map((rec) => {
      const { $type: _type, ...rest } = rec.value;
      void _type;
      return { collection: rec.collection, rkey: rec.rkey, value: rest };
    });

  // Import unversioned OpenSocial `membership` records via STAR (`importRepoAs`) with NO `new.flock.incarnation` field!
  await network.importRepoAs(ws.groupDid, ws.members, [
    ...baseNonMemberships,
    {
      collection: OPENSOCIAL_COLLECTION.membership,
      rkey: BOB,
      value: { roles: ["admin", "member"], createdAt: "2026-01-01T00:00:00.000Z" },
    },
    {
      collection: OPENSOCIAL_COLLECTION.membership,
      rkey: ALICE,
      value: { roles: ["member"], createdAt: "2026-01-01T00:00:00.000Z" },
    },
    {
      collection: OPENSOCIAL_COLLECTION.membership,
      rkey: CAROL,
      value: { roles: ["member"], createdAt: "2026-01-01T00:00:00.000Z" },
    },
  ]);

  const importedAliceMem = await network.clientFor(ws.groupDid).query<{
    cid: string;
    value: Record<string, unknown>;
  }>("com.atproto.space.getRecord", {
    space: ws.members,
    repo: ws.groupDid,
    collection: OPENSOCIAL_COLLECTION.membership,
    rkey: ALICE,
  });
  assert.equal(importedAliceMem.value[FLOCK_EXTENSION_FIELD.incarnation], undefined);

  const alice = createEngine(transportFor(network, ALICE));
  const bob = createEngine(transportFor(network, BOB));
  await bob.workspaces.accept(ws.workspace);

  // Before Alice accepts, Alice is in `pendingMembers`, not `members`
  const beforeSummary = await bob.workspaces.summary(ws.workspace, { fresh: true });
  assert.ok(beforeSummary);
  assert.deepEqual(beforeSummary.members.map((m) => m.did), [BOB]);
  assert.deepEqual(beforeSummary.pendingMembers.map((m) => m.did), [ALICE, CAROL].sort());

  // Alice accepts -> stamps `legacy-cid:<importedAliceMem.cid>` on own-PDS `acceptance/self`
  await alice.workspaces.accept(ws.workspace);
  const aliceAcc = await network.clientFor(ALICE).query<{ value: Record<string, unknown> }>(
    "com.atproto.space.getRecord",
    {
      space: ws.members,
      repo: ALICE,
      collection: OPENSOCIAL_COLLECTION.acceptance,
      rkey: SELF_SKEY,
    },
  );
  assert.equal(aliceAcc.value[FLOCK_EXTENSION_FIELD.incarnation], `legacy-cid:${importedAliceMem.cid}`);

  // Both `WorkspaceClient.summary`/`discover` AND `SyncCore.syncVerifiedWorkspaceSnapshot` place Alice + Bob in `members`!
  const afterSummary = await alice.workspaces.summary(ws.workspace, { fresh: true });
  assert.ok(afterSummary);
  assert.deepEqual(afterSummary.members.map((m) => m.did), [ALICE, BOB].sort());
  assert.deepEqual(afterSummary.pendingMembers.map((m) => m.did), [CAROL]);

  const discovered = await alice.workspaces.discover();
  assert.deepEqual(
    discovered.workspaces.find((w) => w.groupDid === ws.groupDid)?.members.map((m) => m.did),
    [ALICE, BOB].sort(),
  );

  const verifiedSnap = await alice.sync.syncVerifiedWorkspaceSnapshot(ws.workspace, { fresh: true });
  assert.deepEqual(verifiedSnap.summary?.members.map((m) => m.did), [ALICE, BOB].sort());
  assert.deepEqual([...verifiedSnap.rosterMembers].sort(), [ALICE, BOB].sort());

  // Re-importing a modified unversioned membership for Alice (new CID!) invalidates her prior `legacy-cid:<old>` stamp!
  await network.importRepoAs(ws.groupDid, ws.members, [
    ...baseNonMemberships,
    {
      collection: OPENSOCIAL_COLLECTION.membership,
      rkey: BOB,
      value: { roles: ["admin", "member"], createdAt: "2026-01-01T00:00:00.000Z" },
    },
    {
      collection: OPENSOCIAL_COLLECTION.membership,
      rkey: ALICE,
      value: { roles: ["member"], createdAt: "2026-02-01T00:00:00.000Z" },
    },
    {
      collection: OPENSOCIAL_COLLECTION.membership,
      rkey: CAROL,
      value: { roles: ["member"], createdAt: "2026-01-01T00:00:00.000Z" },
    },
  ]);

  const afterReimport = await bob.workspaces.summary(ws.workspace, { fresh: true });
  assert.ok(afterReimport);
  assert.deepEqual(afterReimport.members.map((m) => m.did), [BOB]);
  assert.deepEqual(afterReimport.pendingMembers.map((m) => m.did), [ALICE, CAROL].sort());
});

test("cancelJoinRequest deletes ONLY pending_approval journals while preserving post-admission, create, and passive journals", async () => {
  const network = new FakeNetwork();
  network.createAccount(ALICE, "pds1");
  const alice = createEngine(transportFor(network, ALICE));
  await alice.workspaces.ensureInvitesSpace();

  const targetWs = await createWorkspace(network, {
    skey: "canceltarget",
    joinPolicy: "approval",
    admins: [BOB],
    members: [BOB],
    channels: [],
  });
  const otherWs = await createWorkspace(network, {
    skey: "cancelother",
    joinPolicy: "approval",
    admins: [BOB],
    members: [BOB],
    channels: [],
  });

  // 1. Live approval join + passive/create/other-group journals: `cancelJoinRequest` deletes ONLY `pending_approval` for `targetWs`!
  const livePending = await alice.workspaces.joinGroup({
    groupDid: targetWs.groupDid,
    mode: "approval",
    operationId: key(201),
  });
  assert.equal(livePending.status, "pending");

  const otherPending = await alice.workspaces.joinGroup({
    groupDid: otherWs.groupDid,
    mode: "approval",
    operationId: key(202),
  });
  assert.equal(otherPending.status, "pending");

  const preservedNonPendingPhases = [
    { op: key(203), mode: "create" as const, phase: "submitting" as const },
    { op: key(204), mode: "open" as const, phase: "submitting" as const },
    { op: key(205), mode: "approval" as const, phase: "orphaned_by_migration" as const },
    { op: key(206), mode: "approval" as const, phase: "expired_unknown" as const },
    { op: key(207), mode: "approval" as const, phase: "unsupported_status" as const },
    { op: key(208), mode: "approval" as const, phase: "quota_exceeded" as const },
  ];
  for (const item of preservedNonPendingPhases) {
    await alice.sync.store.putJoiningGroup({
      operationId: item.op,
      mode: item.mode,
      intentHash: `hash-${item.op}`,
      groupDid: targetWs.groupDid,
      ...(item.mode === "create" ? { createParams: { name: "Creating" } } : {}),
      phase: item.phase,
      createdAt: network.now(),
    });
  }

  await alice.workspaces.cancelJoinRequest(targetWs.groupDid);
  assert.equal(await alice.sync.store.getJoiningGroup(key(201)), undefined, "target pending_approval deleted");
  assert.equal(
    (await alice.sync.store.getJoiningGroup(key(202)))?.phase,
    "pending_approval",
    "other group pending_approval untouched",
  );
  for (const item of preservedNonPendingPhases) {
    assert.equal(
      (await alice.sync.store.getJoiningGroup(item.op))?.phase,
      item.phase,
      `non-pending_approval journal (${item.mode}/${item.phase}) preserved`,
    );
    await alice.sync.store.deleteJoiningGroup(item.op);
  }
  await alice.workspaces.cancelJoinRequest(otherWs.groupDid);

  // 2. Post-admission phases (`membership_verified`, `acceptance_pending`, `discovery_verified`) are NEVER deleted
  //    and rethrow `JoinRequestNotFound` when no pending join request exists on the server!
  for (const [idx, postPhase] of (
    ["membership_verified", "acceptance_pending", "discovery_verified"] as const
  ).entries()) {
    const postWs = await createWorkspace(network, {
      skey: `postadm${["a", "b", "c"][idx]!}`,
      joinPolicy: "approval",
      admins: [BOB],
      members: [BOB, ALICE],
      channels: [],
    });
    // Simulate crash before bilateral acceptance completed (or right after acceptance for discovery_verified)
    if (postPhase !== "discovery_verified") {
      await network.deleteAs(ALICE, postWs.members, OPENSOCIAL_COLLECTION.acceptance, SELF_SKEY);
    }
    const memRec = await network.clientFor(postWs.groupDid).query<{ value: Record<string, unknown> }>(
      "com.atproto.space.getRecord",
      {
        space: postWs.members,
        repo: postWs.groupDid,
        collection: OPENSOCIAL_COLLECTION.membership,
        rkey: ALICE,
      },
    );
    const opId = key(220 + idx);
    await alice.sync.store.putJoiningGroup({
      operationId: opId,
      mode: "approval",
      intentHash: `hash-post-${idx}`,
      authorityEndpoint: await network.resolvePds(postWs.groupDid),
      groupDid: postWs.groupDid,
      ...(typeof memRec.value[FLOCK_EXTENSION_FIELD.incarnation] === "string"
        ? { currentIncarnation: memRec.value[FLOCK_EXTENSION_FIELD.incarnation] as string }
        : {}),
      phase: postPhase,
      createdAt: network.now(),
    });

    await assert.rejects(
      alice.workspaces.cancelJoinRequest(postWs.groupDid),
      (err: unknown) => err instanceof XrpcError && err.code === "JoinRequestNotFound",
      `JoinRequestNotFound rethrown when post-admission ${postPhase} journal exists`,
    );
    assert.equal(
      (await alice.sync.store.getJoiningGroup(opId))?.phase,
      postPhase,
      `post-admission ${postPhase} journal preserved intact`,
    );

    // Recovery on `discover()` completes post-admission work cleanly!
    const recovered = await alice.workspaces.discover();
    assert.equal(recovered.workspaces.some((w) => w.groupDid === postWs.groupDid), true);
    assert.equal(await alice.sync.store.getJoiningGroup(opId), undefined);
  }

  // 3. Concurrent moderator approval while local journal is still `pending_approval`:
  //    `cancelJoinRequest` rethrows `JoinRequestNotFound` and advances `pending_approval` -> `membership_verified` instead of erasing it!
  const raceWs = await createWorkspace(network, {
    skey: "cancelrace",
    joinPolicy: "approval",
    admins: [BOB],
    members: [BOB],
    channels: [],
  });
  await alice.workspaces.joinGroup({
    groupDid: raceWs.groupDid,
    mode: "approval",
    operationId: key(230),
  });
  await network.fetchEndpoint(
    new Request(`${await network.resolvePds(raceWs.groupDid)}/xrpc/com.atproto.space.putRecord`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${network.issueSessionToken(raceWs.groupDid)}`,
        "content-type": "application/json",
        "if-join-request-present": "true",
      },
      body: JSON.stringify({
        space: raceWs.members,
        repo: raceWs.groupDid,
        collection: OPENSOCIAL_COLLECTION.membership,
        rkey: ALICE,
        record: { $type: OPENSOCIAL_COLLECTION.membership, roles: ["member"], createdAt: "2026-11-10T12:00:00.000Z" },
      }),
    }),
  );

  await assert.rejects(
    alice.workspaces.cancelJoinRequest(raceWs.groupDid),
    (err: unknown) => err instanceof XrpcError && err.code === "JoinRequestNotFound",
  );
  assert.equal((await alice.sync.store.getJoiningGroup(key(230)))?.phase, "membership_verified");

  const raceDiscovered = await alice.workspaces.discover();
  assert.equal(raceDiscovered.workspaces.some((w) => w.groupDid === raceWs.groupDid), true);
  assert.equal(await alice.sync.store.getJoiningGroup(key(230)), undefined);

  // 4. Inconclusive follow-up probe on `JoinRequestNotFound` (e.g. transient 503 on `/group-member/join-status`)
  //    MUST rethrow and preserve `pending_approval` journal rows so post-approval recovery is never lost!
  const transientWs = await createWorkspace(network, {
    skey: "cancelprobe503",
    joinPolicy: "approval",
    admins: [BOB],
    members: [BOB],
    channels: [],
  });
  await alice.workspaces.joinGroup({
    groupDid: transientWs.groupDid,
    mode: "approval",
    operationId: key(231),
  });
  await network.fetchEndpoint(
    new Request(`${await network.resolvePds(transientWs.groupDid)}/xrpc/com.atproto.space.putRecord`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${network.issueSessionToken(transientWs.groupDid)}`,
        "content-type": "application/json",
        "if-join-request-present": "true",
      },
      body: JSON.stringify({
        space: transientWs.members,
        repo: transientWs.groupDid,
        collection: OPENSOCIAL_COLLECTION.membership,
        rkey: ALICE,
        record: { $type: OPENSOCIAL_COLLECTION.membership, roles: ["member"], createdAt: "2026-11-10T12:00:00.000Z" },
      }),
    }),
  );

  let failJoinStatusOnce = true;
  network.interceptResponse = ({ method, response }) => {
    if (failJoinStatusOnce && method === "group-member/join-status") {
      failJoinStatusOnce = false;
      return Response.json({ error: "ServiceUnavailable", message: "transient join-status outage" }, { status: 503 });
    }
    return response;
  };

  await assert.rejects(
    alice.workspaces.cancelJoinRequest(transientWs.groupDid),
    (err: unknown) => err instanceof XrpcError && err.status === 503,
    "transient join-status failure must rethrow without deleting pending_approval journal",
  );
  network.interceptResponse = undefined;
  assert.equal(
    (await alice.sync.store.getJoiningGroup(key(231)))?.phase,
    "pending_approval",
    "pending_approval journal preserved across transient probe failure",
  );

  // Subsequent recovery (`discover()`) completes bilateral acceptance using the preserved journal!
  const recoveredAfter503 = await alice.workspaces.discover();
  assert.equal(recoveredAfter503.workspaces.some((w) => w.groupDid === transientWs.groupDid), true);
  assert.equal(await alice.sync.store.getJoiningGroup(key(231)), undefined);
});

test("Round 9 Finding #4: WorkspaceClient.createWorkspace keeps joiningGroups at submitting on Operator pending, recovers crashed creations via discover(), and safely dismisses only unstarted creations", async () => {
  const network = new FakeNetwork();
  network.createAccount(ALICE, "pds1");
  const aliceBase = transportFor(network, ALICE);

  // 1. Operator returning `state: "pending"` keeps `joiningGroups` in `phase: "submitting"` (recording `groupDid`),
  //    NEVER writes `acceptance/self` prematurely, and subsequent `discover()` completes creation + `acceptance/self` + deletes journal!
  const pendingGroupDid = plcDidForLabel("r9pendcreate");
  let operatorPhase: "pending" | "completed" = "pending";
  const operatorCalls: Array<{ name: string; operationId: string; authority?: string }> = [];

  const alice = createEngine(
    withOperator(network, aliceBase, async (method, _url, iss, body) => {
      if (method === OPERATOR_METHOD.createWorkspace) {
        const req = body as {
          name: string;
          operationId: string;
          authority?: string;
          joinPolicy?: "open" | "approval" | "invite";
          publicMeta?: boolean;
        };
        operatorCalls.push({
          name: req.name,
          operationId: req.operationId,
          ...(req.authority ? { authority: req.authority } : {}),
        });
        if (operatorPhase === "pending") {
          return {
            operationId: req.operationId,
            groupDid: pendingGroupDid,
            workspace: workspaceUri(pendingGroupDid),
            channel: channelUri(pendingGroupDid, "general"),
            state: "pending",
            completedSteps: ["workspace-space", "inbox-space"],
            error: "Group Host temporarily unavailable",
          };
        }
        await createWorkspace(network, {
          authority: pendingGroupDid,
          name: req.name,
          joinPolicy: req.joinPolicy ?? "open",
          admins: [iss],
          members: [iss],
          channels: [{ skey: "general", visibility: "public" }],
        });
        // Simulate Operator bootstrap: membership/<creator> exists on Group Host, personal acceptance/self is NOT written by Operator!
        await network.deleteAs(iss, `at://${pendingGroupDid}/space/group.opensocial.members/self`, OPENSOCIAL_COLLECTION.acceptance, SELF_SKEY);
        return {
          operationId: req.operationId,
          groupDid: pendingGroupDid,
          workspace: workspaceUri(pendingGroupDid),
          channel: channelUri(pendingGroupDid, "general"),
          state: "completed",
          completedSteps: [
            "workspace-space",
            "inbox-space",
            "general-channel-space",
            "workspace-profile",
            "creator-admin",
            "general-directory",
          ],
        };
      }
      return {};
    }),
    { operator: OPERATOR },
  );

  const pendingOpId = key(301);
  const firstAttempt = await alice.workspaces.createWorkspace(
    { name: "Pending Workspace", joinPolicy: "open", publicMeta: true },
    { operationId: pendingOpId },
  );
  assert.equal(firstAttempt.state, "pending");
  assert.equal(firstAttempt.groupDid, pendingGroupDid);
  assert.equal(firstAttempt.workspace, workspaceUri(pendingGroupDid));
  assert.deepEqual(firstAttempt.completedSteps, ["workspace-space", "inbox-space"]);
  assert.equal(firstAttempt.error, "Group Host temporarily unavailable");

  const journalAfterPending = await alice.sync.store.getJoiningGroup(pendingOpId);
  assert.equal(journalAfterPending?.mode, "create");
  assert.equal(journalAfterPending?.phase, "submitting", "must stay in submitting when Operator returns pending");
  assert.equal(journalAfterPending?.groupDid, pendingGroupDid, "partial groupDid recorded for resume");
  assert.equal(
    await alice.workspaces.dismissUnstartedCreateOperation(pendingOpId),
    "in_progress",
    "must refuse to dismiss once groupDid is bound",
  );

  // Personal PDS `acceptance/self` was NOT written while Operator was pending!
  await assert.rejects(
    network.clientFor(ALICE).query("com.atproto.space.getRecord", {
      space: `at://${pendingGroupDid}/space/group.opensocial.members/self`,
      repo: ALICE,
      collection: OPENSOCIAL_COLLECTION.acceptance,
      rkey: SELF_SKEY,
    }),
  );

  // Outage clears; simulated fresh tab startup (`discover()` using `this.deps.operator` with zero sessionStorage) completes everything!
  operatorPhase = "completed";
  const recoveredDiscovery = await alice.workspaces.discover();
  assert.equal(operatorCalls.at(-1)?.authority, pendingGroupDid, "resumed call forwards recorded authority groupDid");
  assert.equal(
    recoveredDiscovery.workspaces.some((w) => w.groupDid === pendingGroupDid && w.name === "Pending Workspace"),
    true,
    "discover() resumes pending createWorkspace, writes own acceptance/self, and discovers workspace",
  );
  assert.equal(await alice.sync.store.getJoiningGroup(pendingOpId), undefined, "journal deleted after discovery_verified");

  const ownAcceptance = await network.clientFor(ALICE).query<{ value: Record<string, unknown> }>(
    "com.atproto.space.getRecord",
    {
      space: `at://${pendingGroupDid}/space/group.opensocial.members/self`,
      repo: ALICE,
      collection: OPENSOCIAL_COLLECTION.acceptance,
      rkey: SELF_SKEY,
    },
  );
  assert.equal(typeof ownAcceptance.value[FLOCK_EXTENSION_FIELD.incarnation], "string");

  // 2. Crash AFTER Operator returns `state: "completed"` BEFORE `writeOwnAcceptance` runs:
  //    `discover()` recovers via durable `joiningGroups` journal and writes `acceptance/self`!
  const crashedGroupDid = plcDidForLabel("r9crashcreate");
  const crashOpId = key(302);
  let failAcceptanceWriteOnce = true;
  const aliceCrashEngine = createEngine(
    {
      ...withOperator(network, aliceBase, async (method, _url, iss, body) => {
        if (method === OPERATOR_METHOD.createWorkspace) {
          const req = body as { name: string; operationId: string };
          await createWorkspace(network, {
            authority: crashedGroupDid,
            name: req.name,
            admins: [iss],
            members: [iss],
            channels: [{ skey: "general", visibility: "public" }],
          });
          await network.deleteAs(iss, `at://${crashedGroupDid}/space/group.opensocial.members/self`, OPENSOCIAL_COLLECTION.acceptance, SELF_SKEY);
          return {
            operationId: req.operationId,
            groupDid: crashedGroupDid,
            workspace: workspaceUri(crashedGroupDid),
            channel: channelUri(crashedGroupDid, "general"),
            state: "completed",
            completedSteps: ["workspace-space", "creator-admin", "general-directory"],
          };
        }
        return {};
      }),
      memberClient: {
        query: (nsid, params, opts) => aliceBase.memberClient.query(nsid, params, opts),
        procedure: async (nsid, reqBody, params, opts) => {
          if (
            failAcceptanceWriteOnce &&
            nsid === "com.atproto.space.putRecord" &&
            (reqBody as { collection?: string })?.collection === OPENSOCIAL_COLLECTION.acceptance
          ) {
            failAcceptanceWriteOnce = false;
            throw new XrpcError(503, "Tab crashed / transient PDS write failure before acceptance", "ServiceUnavailable");
          }
          return aliceBase.memberClient.procedure(nsid, reqBody, params, opts);
        },
      } as ClientTransport["memberClient"],
    },
    { operator: OPERATOR, store: alice.sync.store },
  );

  await assert.rejects(
    aliceCrashEngine.workspaces.createWorkspace({ name: "Crash Recovery Team" }, { operationId: crashOpId }),
    (err: unknown) => err instanceof XrpcError && err.status === 503,
  );
  assert.equal((await alice.sync.store.getJoiningGroup(crashOpId))?.phase, "acceptance_pending");

  // Fresh startup `discover()` completes `writeOwnAcceptance` -> `discovery_verified` -> deletes journal!
  const afterCrashDiscover = await aliceCrashEngine.workspaces.discover();
  assert.equal(afterCrashDiscover.workspaces.some((w) => w.groupDid === crashedGroupDid), true);
  assert.equal(await alice.sync.store.getJoiningGroup(crashOpId), undefined);

  // 3. Unapproved `403 AuthorizationRequired` keeps unstarted `submitting` row across OAuth redirect,
  //    and `dismissUnstartedCreateOperation` removes it cleanly when authorization is cancelled!
  const unauthedOpId = key(303);
  const aliceUnauthed = createEngine(
    withOperator(network, aliceBase, () =>
      Response.json({ error: "AuthorizationRequired", message: "Approve group authority first" }, { status: 403 }),
    ),
    { operator: OPERATOR, store: alice.sync.store },
  );
  await assert.rejects(
    aliceUnauthed.workspaces.createWorkspace({ name: "Unapproved Team" }, { operationId: unauthedOpId }),
    (err: unknown) => err instanceof OperatorRemoteError && err.code === "AuthorizationRequired",
  );
  const unstarted = await alice.sync.store.getJoiningGroup(unauthedOpId);
  assert.equal(unstarted?.phase, "submitting");
  assert.equal(unstarted?.groupDid, undefined);
  assert.equal(await aliceUnauthed.workspaces.dismissUnstartedCreateOperation(unauthedOpId), "dismissed");
  assert.equal(await alice.sync.store.getJoiningGroup(unauthedOpId), undefined);
  assert.equal(await aliceUnauthed.workspaces.dismissUnstartedCreateOperation(unauthedOpId), "not_found");
});

test("Round 9 Finding #5: discoverCore() and discover() rethrow transient acceptance/self read failures without calling keepWorkspaces or purging cached state", async () => {
  const network = new FakeNetwork();
  const ws = await createWorkspace(network, {
    skey: "r9accpurge",
    admins: [ALICE],
    members: [ALICE, BOB],
    channels: [{ skey: "general", visibility: "public" }],
  });
  await writeMessage(network, BOB, ws.channels.general!, 1);

  const base = transportFor(network, ALICE);
  const alice = createEngine(base);
  const initial = await alice.workspaces.discover();
  assert.deepEqual(initial.workspaces.map((w) => w.uri), [ws.workspace]);
  await alice.channels.readPage({ workspace: ws.workspace, skey: "general" });
  assert.equal((await alice.sync.store.records(ws.channels.general!, COLLECTION.message)).length, 1);

  // Inject transient 503, network TypeError, and 403 ScopeMissingError on personal `acceptance/self` getRecord:
  // NONE of them may masquerade as false or purge cached workspace/channel/message state!
  let injectedError: Error | null = new XrpcError(503, "Personal PDS temporarily unavailable", "UpstreamFailure");
  const aliceFlaky = createEngine(
    {
      ...base,
      memberClient: {
        query: async (nsid, params, opts) => {
          if (
            injectedError !== null &&
            nsid === "com.atproto.space.getRecord" &&
            params?.collection === OPENSOCIAL_COLLECTION.acceptance
          ) {
            throw injectedError;
          }
          return base.memberClient.query(nsid, params, opts);
        },
        procedure: (nsid, body, params, opts) => base.memberClient.procedure(nsid, body, params, opts),
      } as ClientTransport["memberClient"],
    },
    { store: alice.sync.store },
  );

  for (const errToInject of [
    new XrpcError(503, "Personal PDS temporarily unavailable", "UpstreamFailure"),
    new TypeError("fetch failed: network socket disconnected"),
    new XrpcError(403, "Missing acceptance read scope", "ScopeMissingError"),
  ]) {
    injectedError = errToInject;
    await assert.rejects(
      aliceFlaky.workspaces.discover(),
      (err: unknown) => err === errToInject,
    );
    assert.notEqual(
      await alice.sync.store.getSpace(ws.workspace),
      undefined,
      `workspace space preserved on ${errToInject.message}`,
    );
    assert.equal(
      (await alice.sync.store.records(ws.channels.general!, COLLECTION.message)).length,
      1,
      `cached channel messages preserved on ${errToInject.message}`,
    );
  }

  // Once transient failure resolves, discovery succeeds with cached state intact!
  injectedError = null;
  const recovered = await aliceFlaky.workspaces.discover();
  assert.deepEqual(recovered.workspaces.map((w) => w.uri), [ws.workspace]);
});

test("Round 9 Finding #7: queryJoinStatusAt rejects schema-invalid 2xx JSON and cancelJoinRequest preserves/upgrades pending_approval on malformed or raced unknown probes", async () => {
  const network = new FakeNetwork();
  network.createAccount(ALICE, "pds1");
  const alice = createEngine(transportFor(network, ALICE));
  await alice.workspaces.ensureInvitesSpace();

  const raceWs = await createWorkspace(network, {
    skey: "r9joinschema",
    joinPolicy: "approval",
    admins: [BOB],
    members: [BOB],
    channels: [],
  });
  const opId = key(310);
  await alice.workspaces.joinGroup({
    groupDid: raceWs.groupDid,
    mode: "approval",
    operationId: opId,
  });

  // Moderator concurrently approves ALICE on Group Host (so `join_request` is consumed -> `cancelJoinRequest` gets `400 JoinRequestNotFound`!)
  await network.fetchEndpoint(
    new Request(`${await network.resolvePds(raceWs.groupDid)}/xrpc/com.atproto.space.putRecord`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${network.issueSessionToken(raceWs.groupDid)}`,
        "content-type": "application/json",
        "if-join-request-present": "true",
      },
      body: JSON.stringify({
        space: raceWs.members,
        repo: raceWs.groupDid,
        collection: OPENSOCIAL_COLLECTION.membership,
        rkey: ALICE,
        record: { $type: OPENSOCIAL_COLLECTION.membership, roles: ["member"], createdAt: "2026-11-10T12:00:00.000Z" },
      }),
    }),
  );

  // 1. Schema-invalid `200 {}`, `{ state: "bogus" }`, `{ state: "admitted", currentIncarnation: 123 }`, and `{ state: "admitted", currentIncarnation: "" }`
  //    MUST throw `502 InvalidJoinStatusResponse` and NEVER erase `pending_approval`!
  for (const invalidBody of [
    {},
    { state: "bogus_state" },
    { state: "admitted", currentIncarnation: 123 },
    { state: "admitted", currentIncarnation: "" },
    { state: "admitted", membership: "not-an-object" },
  ]) {
    network.interceptResponse = ({ method, response }) => {
      if (method === "group-member/join-status") {
        return Response.json(invalidBody, { status: 200 });
      }
      return response;
    };
    await assert.rejects(
      alice.workspaces.cancelJoinRequest(raceWs.groupDid),
      (err: unknown) => err instanceof XrpcError && err.status === 502 && err.code === "InvalidJoinStatusResponse",
    );
    assert.equal(
      (await alice.sync.store.getJoiningGroup(opId))?.phase,
      "pending_approval",
      `pending_approval journal must survive malformed 200 ${JSON.stringify(invalidBody)}`,
    );
  }

  // 2. `{ state: "left_deactivated" }` also preserves `pending_approval` and rethrows `JoinRequestNotFound`!
  network.interceptResponse = ({ method, response }) => {
    if (method === "group-member/join-status") {
      return Response.json({ state: "left_deactivated" }, { status: 200 });
    }
    return response;
  };
  await assert.rejects(
    alice.workspaces.cancelJoinRequest(raceWs.groupDid),
    (err: unknown) => err instanceof XrpcError && err.code === "JoinRequestNotFound",
  );
  assert.equal((await alice.sync.store.getJoiningGroup(opId))?.phase, "pending_approval");

  // 3. `{ state: "unknown" }` when membership actually exists on Group Host (`members/self`) probes live membership,
  //    upgrades `pending_approval` -> `membership_verified`, and rethrows `JoinRequestNotFound` instead of erasing the journal!
  network.interceptResponse = ({ method, response }) => {
    if (method === "group-member/join-status") {
      return Response.json({ state: "unknown" }, { status: 200 });
    }
    return response;
  };
  await assert.rejects(
    alice.workspaces.cancelJoinRequest(raceWs.groupDid),
    (err: unknown) => err instanceof XrpcError && err.code === "JoinRequestNotFound",
  );
  network.interceptResponse = undefined;

  const upgraded = await alice.sync.store.getJoiningGroup(opId);
  assert.equal(upgraded?.phase, "membership_verified", "unknown join-status with live membership upgrades journal");
  assert.equal(typeof upgraded?.currentIncarnation, "string");

  // Subsequent `discover()` completes bilateral `acceptance/self` and surfaces the workspace!
  const discovered = await alice.workspaces.discover();
  assert.equal(discovered.workspaces.some((w) => w.groupDid === raceWs.groupDid), true);
  assert.equal(await alice.sync.store.getJoiningGroup(opId), undefined);
});

test("Round 12 Finding #3 & #4: unknown-DID createWorkspace rekeys to groupDid lifecycle lock before acceptance/cleanup, and reactivateGroup refreshes Operator registrations before leaving reauthorizing_operator", async () => {
  const network = new FakeNetwork();
  network.createAccount(ALICE, "pds1");
  network.createAccount(BOB, "pds2");

  // --- Part A (Finding #3, Schedule 1): `createWorkspace` binds `groupDid` and acquires `withGroupLifecycleLock(groupDid)` BEFORE `leaveGroup` runs ---
  //     `leaveGroup(groupDid)` started while `createWorkspace` is in Phases 3-5 MUST wait on `withGroupLifecycleLock(groupDid)`
  //     and execute AFTER `createWorkspace`, leaving ZERO stale `acceptance/self`!
  const createdGroupA = plcDidForLabel("r12createrace1");
  let leavePromiseDuringAccept: Promise<void> | null = null;

  const aliceBaseA = transportFor(network, ALICE);
  const aliceA = createEngine(
    withOperator(
      network,
      {
        ...aliceBaseA,
        memberClient: {
          query: aliceBaseA.memberClient.query.bind(aliceBaseA.memberClient),
          procedure: (async (...args: Parameters<typeof aliceBaseA.memberClient.procedure>) => {
            const [method, input] = args;
            if (
              method === "com.atproto.space.putRecord" &&
              (input as { space?: string; collection?: string })?.space ===
                `at://${createdGroupA}/space/group.opensocial.members/self` &&
              (input as { collection?: string })?.collection === OPENSOCIAL_COLLECTION.acceptance
            ) {
              leavePromiseDuringAccept = aliceA.workspaces.leaveGroup(createdGroupA);
              // Yield macrotask so `leaveGroup` attempts to enter `withGroupLifecycleLock(createdGroupA)` while Phase 4 is mid-flight!
              await new Promise((r) => setTimeout(r, 15));
            }
            return aliceBaseA.memberClient.procedure(...args);
          }) as typeof aliceBaseA.memberClient.procedure,
        } as typeof aliceBaseA.memberClient,
      },
      async (method, _url, iss, body) => {
        if (method === OPERATOR_METHOD.createWorkspace) {
          const req = body as { name: string; operationId: string };
          await createWorkspace(network, {
            authority: createdGroupA,
            name: req.name,
            joinPolicy: "open",
            admins: [iss, BOB],
            members: [iss, BOB],
            channels: [{ skey: "general", visibility: "public" }],
          });
          await network.deleteAs(
            iss,
            `at://${createdGroupA}/space/group.opensocial.members/self`,
            OPENSOCIAL_COLLECTION.acceptance,
            SELF_SKEY,
          );
          return {
            operationId: req.operationId,
            groupDid: createdGroupA,
            workspace: workspaceUri(createdGroupA),
            channel: channelUri(createdGroupA, "general"),
            state: "completed",
            completedSteps: ["workspace-space", "creator-admin"],
          };
        }
        return {};
      },
    ),
    { operator: OPERATOR },
  );

  const createOpA = key(401);
  const resA = await aliceA.workspaces.createWorkspace(
    { name: "Rekeyed Create A", joinPolicy: "open", publicMeta: true },
    { operationId: createOpA },
  );
  assert.equal(resA.state, "completed");
  assert.ok(leavePromiseDuringAccept, "concurrent leaveGroup must have been triggered during Phase 4");
  await leavePromiseDuringAccept;

  // After `leaveGroup` finishes, `ALICE` MUST NOT have stale `acceptance/self` or membership!
  await assert.rejects(
    network.clientFor(ALICE).query("com.atproto.space.getRecord", {
      space: `at://${createdGroupA}/space/group.opensocial.members/self`,
      repo: ALICE,
      collection: OPENSOCIAL_COLLECTION.acceptance,
      rkey: SELF_SKEY,
    }),
    "concurrent leaveGroup queued behind groupDid lock must remove acceptance/self cleanly",
  );
  assert.equal((await aliceA.workspaces.discover()).workspaces.some((w) => w.groupDid === createdGroupA), false);

  // --- Part B (Finding #3, Schedule 2): `leaveGroup` wins `withGroupLifecycleLock(groupDid)` BEFORE `createWorkspace` enters `withGroupLifecycleLock(groupDid)` ---
  //     `createWorkspace` MUST observe removed membership under `withGroupLifecycleLock(groupDid)`, delete its journal, and NEVER write stale `acceptance/self`!
  const createdGroupB = plcDidForLabel("r12createrace2");
  const aliceBaseB = transportFor(network, ALICE);
  const aliceB: ReturnType<typeof createEngine> = createEngine(
    withOperator(network, aliceBaseB, async (method, _url, iss, body) => {
      if (method === OPERATOR_METHOD.createWorkspace) {
        const req = body as { name: string; operationId: string };
        await createWorkspace(network, {
          authority: createdGroupB,
          name: req.name,
          joinPolicy: "open",
          admins: [iss, BOB],
          members: [iss, BOB],
          channels: [{ skey: "general", visibility: "public" }],
        });
        await network.deleteAs(
          iss,
          `at://${createdGroupB}/space/group.opensocial.members/self`,
          OPENSOCIAL_COLLECTION.acceptance,
          SELF_SKEY,
        );
        // Simulate another tab running `leaveGroup(createdGroupB)` to completion right as `operator.createWorkspace` returns!
        await aliceB.workspaces.leaveGroup(createdGroupB);
        return {
          operationId: req.operationId,
          groupDid: createdGroupB,
          workspace: workspaceUri(createdGroupB),
          channel: channelUri(createdGroupB, "general"),
          state: "completed",
          completedSteps: ["workspace-space", "creator-admin"],
        };
      }
      return {};
    }),
    { operator: OPERATOR },
  );

  const createOpB = key(402);
  await assert.rejects(
    aliceB.workspaces.createWorkspace(
      { name: "Rekeyed Create B", joinPolicy: "open", publicMeta: true },
      { operationId: createOpB },
    ),
    "createWorkspace after interleaved leaveGroup must reject instead of writing stale acceptance",
  );
  assert.equal(await aliceB.sync.store.getJoiningGroup(createOpB), undefined, "superseded create journal cleaned up");
  await assert.rejects(
    network.clientFor(ALICE).query("com.atproto.space.getRecord", {
      space: `at://${createdGroupB}/space/group.opensocial.members/self`,
      repo: ALICE,
      collection: OPENSOCIAL_COLLECTION.acceptance,
      rkey: SELF_SKEY,
    }),
    "must NEVER write stale acceptance/self after interleaved leaveGroup",
  );

  // --- Part C (Finding #4): `reactivateGroup` calls `listStalledOperations` with `refreshRegistrations=true` and stays in `reauthorizing_operator` until `registrations` is empty ---
  const reactWs = await createWorkspace(network, {
    skey: "r12reactreg",
    admins: [ALICE],
    members: [ALICE],
    channels: [{ skey: "general", visibility: "public" }],
  });
  const seenRefreshParams: string[] = [];
  let operatorAuthorized = false;
  let registrationFailures = [{ space: reactWs.channels.general!, failures: 1, error: "503 Group Host unavailable" }];

  const aliceReact = createEngine(
    withOperator(network, transportFor(network, ALICE), (method, url) => {
      if (method === OPERATOR_METHOD.listStalledOperations) {
        seenRefreshParams.push(url.searchParams.get("refreshRegistrations") ?? "");
        if (!operatorAuthorized) {
          return Response.json({ error: "AuthoritySessionUnavailable", message: "reauth required" }, { status: 502 });
        }
        return { operations: [], registrations: registrationFailures, truncated: false };
      }
      return {};
    }),
    { operator: OPERATOR },
  );

  await aliceReact.workspaces.leaveGroup(reactWs.groupDid);
  const reactGroupClient = new GroupClient({
    groupDid: reactWs.groupDid,
    fetchHandler: async (path, init) => {
      const pds = await network.resolvePds(reactWs.groupDid);
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${network.issueGroupSessionToken(reactWs.groupDid, ALICE, { sessionKind: "recovery" })}`);
      return network.fetchEndpoint(new Request(new URL(path, pds), { ...init, headers }));
    },
    fetchEndpoint: network.fetchEndpoint,
    now: network.now,
  });

  const reactOpId = key(403);
  await assert.rejects(
    aliceReact.workspaces.reactivateGroup(reactWs.groupDid, {
      operationId: reactOpId,
      getGroupClient: async () => reactGroupClient,
      reauthorizeOperator: async () => {
        operatorAuthorized = true;
        return true;
      },
    }),
    (err: unknown) => err instanceof OperatorRemoteError && err.code === "RegistrationRefreshFailed",
  );
  assert.deepEqual(seenRefreshParams, ["true", "true"], "must pass refreshRegistrations=true on Operator probes");
  assert.equal(
    (await aliceReact.sync.store.getReactivatingGroup(reactOpId))?.phase,
    "reauthorizing_operator",
    "journal MUST remain at reauthorizing_operator while space registrations have not converged",
  );

  // Passive `resumeJournals()` while registration refresh still fails ALSO keeps `reauthorizing_operator` intact!
  await aliceReact.workspaces.resumeJournals({ getGroupClient: async () => reactGroupClient });
  assert.equal((await aliceReact.sync.store.getReactivatingGroup(reactOpId))?.phase, "reauthorizing_operator");

  // Once all group-space registrations refresh cleanly (`registrations: []`), `resumeJournals()` / `reactivateGroup` advances and deletes journal!
  registrationFailures = [];
  await aliceReact.workspaces.reactivateGroup(reactWs.groupDid, {
    operationId: reactOpId,
    getGroupClient: async () => reactGroupClient,
  });
  assert.equal(await aliceReact.sync.store.getReactivatingGroup(reactOpId), undefined);
  assert.equal((await aliceReact.workspaces.discover()).workspaces.some((w) => w.groupDid === reactWs.groupDid), true);
});

test("round-13: dismissJoinOperation and retryJoinOperation serialize under withGroupLifecycleLock and reject active phases", async () => {
  const network = new FakeNetwork();
  network.createAccount(ALICE, "pds1");
  network.createAccount(BOB, "pds2");
  const raceJoinWs = await createWorkspace(network, {
    skey: "r13joinlock",
    joinPolicy: "open",
    admins: [BOB],
    members: [BOB],
    channels: [{ skey: "general", visibility: "public" }],
  });

  // 1. In-flight `joinGroup` holding `withGroupLifecycleLock(groupDid)` blocks concurrent `dismissJoinOperation` & `retryJoinOperation`
  //    so neither can delete or race with the active state machine!
  let releaseAcceptanceWrite!: () => void;
  const acceptanceWriteGate = new Promise<void>((resolve) => {
    releaseAcceptanceWrite = resolve;
  });
  let notifyAcceptanceGateReached!: () => void;
  const acceptanceGateReached = new Promise<void>((resolve) => {
    notifyAcceptanceGateReached = resolve;
  });

  const aliceBase = transportFor(network, ALICE);
  const gatedMemberClient = {
    query: aliceBase.memberClient.query.bind(aliceBase.memberClient),
    procedure: async (...args: Parameters<typeof aliceBase.memberClient.procedure>) => {
      const [nsid, body] = args;
      if (
        nsid === "com.atproto.space.putRecord" &&
        typeof body === "object" &&
        body !== null &&
        (body as { space?: string; collection?: string }).space === raceJoinWs.members &&
        (body as { collection?: string }).collection === OPENSOCIAL_COLLECTION.acceptance
      ) {
        notifyAcceptanceGateReached();
        await acceptanceWriteGate;
      }
      return aliceBase.memberClient.procedure(...args);
    },
  } as unknown as ClientTransport["memberClient"];

  const aliceRace = createEngine(
    { ...aliceBase, memberClient: gatedMemberClient },
    { operator: OPERATOR },
  );

  const opActive = key(420);
  const inFlightJoin = aliceRace.workspaces.joinGroup({
    groupDid: raceJoinWs.groupDid,
    operationId: opActive,
  });

  await acceptanceGateReached;
  assert.equal((await aliceRace.sync.store.getJoiningGroup(opActive))?.phase, "acceptance_pending");

  let dismissSettledBeforeGateRelease = false;
  let retrySettledBeforeGateRelease = false;
  const concurrentDismiss = aliceRace.workspaces.dismissJoinOperation(opActive).finally(() => {
    dismissSettledBeforeGateRelease = true;
  });
  const concurrentRetry = aliceRace.workspaces
    .retryJoinOperation(opActive)
    .then(
      () => "resolved" as const,
      (err: unknown) => err,
    )
    .finally(() => {
      retrySettledBeforeGateRelease = true;
    });

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(dismissSettledBeforeGateRelease, false, "dismissJoinOperation must wait on withGroupLifecycleLock");
  assert.equal(retrySettledBeforeGateRelease, false, "retryJoinOperation must wait on withGroupLifecycleLock");
  assert.equal(
    (await aliceRace.sync.store.getJoiningGroup(opActive))?.phase,
    "acceptance_pending",
    "in-flight journal row must NOT be deleted while locked join is running",
  );

  releaseAcceptanceWrite();
  const joinOut = await inFlightJoin;
  assert.equal(joinOut.status, "admitted");
  await concurrentDismiss;
  const retryErr = await concurrentRetry;
  assert.ok(retryErr instanceof Error && /cannot be retried/i.test(retryErr.message));
  assert.equal(await aliceRace.sync.store.getJoiningGroup(opActive), undefined, "completed join row stays deleted without resurrection");
  const ownAcc = await network.clientFor(ALICE).query("com.atproto.space.getRecord", {
    space: raceJoinWs.members,
    repo: ALICE,
    collection: OPENSOCIAL_COLLECTION.acceptance,
    rkey: SELF_SKEY,
  });
  assert.ok(ownAcc);

  // 2. Non-passive phases (`pending_approval`, `acceptance_pending`, and `mode === "create"`) reject both `dismissJoinOperation` & `retryJoinOperation`!
  const otherWs = await createWorkspace(network, {
    skey: "r13passivecheck",
    joinPolicy: "open",
    admins: [BOB],
    members: [BOB],
    channels: [],
  });

  for (const [idx, activeEntry] of [
    {
      operationId: key(421),
      mode: "approval" as const,
      intentHash: "h-pend",
      groupDid: otherWs.groupDid,
      phase: "pending_approval" as const,
      createdAt: network.now(),
    },
    {
      operationId: key(422),
      mode: "open" as const,
      intentHash: "h-acc",
      groupDid: otherWs.groupDid,
      phase: "acceptance_pending" as const,
      createdAt: network.now(),
    },
    {
      operationId: key(423),
      mode: "create" as const,
      intentHash: "h-create",
      createParams: { name: "Unfinished Create" },
      groupDid: otherWs.groupDid,
      phase: "membership_verified" as const,
      createdAt: network.now(),
    },
  ].entries()) {
    await aliceRace.sync.store.putJoiningGroup(activeEntry);
    await assert.rejects(
      aliceRace.workspaces.dismissJoinOperation(activeEntry.operationId),
      /cannot be dismissed/i,
      `active entry #${idx} must reject dismissJoinOperation`,
    );
    await assert.rejects(
      aliceRace.workspaces.retryJoinOperation(activeEntry.operationId),
      /cannot be retried/i,
      `active entry #${idx} must reject retryJoinOperation`,
    );
    assert.ok(
      await aliceRace.sync.store.getJoiningGroup(activeEntry.operationId),
      `active entry #${idx} must remain intact in store`,
    );
    await aliceRace.sync.store.deleteJoiningGroup(activeEntry.operationId);
  }

  // 3. Passive `orphaned_by_migration` atomically replaces old operationId under lock and completes admission on the new host!
  const opOrphaned = key(424);
  await aliceRace.sync.store.putJoiningGroup({
    operationId: opOrphaned,
    mode: "open",
    intentHash: "h-orphaned",
    authorityEndpoint: "https://migrated-from-old-host.test",
    groupDid: otherWs.groupDid,
    phase: "orphaned_by_migration",
    createdAt: network.now(),
  });
  const retriedOpen = await aliceRace.workspaces.retryJoinOperation(opOrphaned);
  assert.notEqual(retriedOpen.operationId, opOrphaned);
  assert.equal(retriedOpen.status, "admitted");
  assert.equal(await aliceRace.sync.store.getJoiningGroup(opOrphaned), undefined);
  assert.equal(await aliceRace.sync.store.getJoiningGroup(retriedOpen.operationId), undefined);
  assert.equal((await aliceRace.workspaces.discover()).workspaces.some((w) => w.groupDid === otherWs.groupDid), true);
});

test("Round 17 hardening: listInvites serializes concurrent scans and guards writer purges with CAS, and summary flags missing or malformed space.policy/self records", async () => {
  const network = new FakeNetwork();
  network.createAccount(ALICE, "pds1");
  const aliceBase = transportFor(network, ALICE);
  const invitesUri = personalInvitesUri(ALICE);

  const group1 = await createWorkspace(network, { skey: "r17inv1", admins: [BOB], members: [BOB], channels: [] });
  const group2 = await createWorkspace(network, { skey: "r17inv2", admins: [BOB], members: [BOB], channels: [] });

  const makeGroupClient = (groupDid: string) => {
    const token = network.issueSessionToken(groupDid);
    return new GroupClient({
      groupDid,
      fetchHandler: async (path, init) => {
        const pds = await network.resolvePds(groupDid);
        const headers = new Headers(init?.headers);
        headers.set("authorization", `Bearer ${token}`);
        return network.fetchEndpoint(new Request(new URL(path, pds), { ...init, headers }));
      },
      fetchEndpoint: network.fetchEndpoint,
      now: network.now,
    });
  };

  let holdWritersResponse = false;
  let releaseWritersResponse!: () => void;
  const writersGate = new Promise<void>((resolve) => {
    releaseWritersResponse = resolve;
  });
  let writersCallSeq = 0;
  let activeWritersInFlight = 0;
  let maxConcurrentWritersInFlight = 0;
  let omitGroup2FromWriters = false;

  const alice = createEngine({
    ...aliceBase,
    fetchEndpoint: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/xrpc/com.atproto.space.listWriters" && url.searchParams.get("space") === invitesUri) {
        writersCallSeq += 1;
        activeWritersInFlight += 1;
        if (activeWritersInFlight > maxConcurrentWritersInFlight) {
          maxConcurrentWritersInFlight = activeWritersInFlight;
        }
        try {
          const res = await aliceBase.fetchEndpoint(request);
          const body = (await res.json()) as { repos: Array<{ repo: string; repoRev: string; spaceRev: string }> };
          const filtered = omitGroup2FromWriters
            ? { repos: body.repos.filter((r) => r.repo !== group2.groupDid) }
            : body;
          if (holdWritersResponse) {
            holdWritersResponse = false;
            await writersGate;
          }
          return Response.json(filtered);
        } finally {
          activeWritersInFlight -= 1;
        }
      }
      return aliceBase.fetchEndpoint(request);
    },
  });

  await alice.workspaces.ensureInvitesSpace();
  await makeGroupClient(group1.groupDid).createInvite(ALICE, { message: "G1 invite" });
  const g2Inv = await makeGroupClient(group2.groupDid).createInvite(ALICE, { message: "G2 initial" });

  const initialInvites = await alice.workspaces.listInvites();
  assert.equal(initialInvites.length, 2);

  // Simulate a stale/delayed writer scan omitting `group2` while another tab invalidates `invitesUri` and commits a newer generation for `group2`!
  omitGroup2FromWriters = true;
  holdWritersResponse = true;
  const scan1Promise = alice.workspaces.listInvites();
  const scan2Promise = alice.workspaces.listInvites();

  // Wait until scan1 enters `listWriters`, then simulate cross-tab invalidation + newer generation commit for `group2`
  while (writersCallSeq < 2) {
    await new Promise((r) => setTimeout(r, 5));
  }
  await alice.sync.store.invalidateSpace(invitesUri);
  await alice.sync.store.purgeWriter(invitesUri, group2.groupDid);
  const freshRkey = key(917);
  await alice.sync.store.commit({
    space: invitesUri,
    repo: group2.groupDid,
    expectedGeneration: null,
    rev: freshRkey,
    next: {
      syncedRev: freshRkey,
      checkedAt: network.now(),
      stale: false,
      coverage: {
        [OPENSOCIAL_COLLECTION.invite]: { strategy: "all", lowest: null, complete: true, cursor: null },
      },
    },
    replace: {
      [OPENSOCIAL_COLLECTION.invite]: [
        {
          space: invitesUri,
          repo: group2.groupDid,
          collection: OPENSOCIAL_COLLECTION.invite,
          rkey: freshRkey,
          uri: spaceRecordUri(invitesUri, group2.groupDid, OPENSOCIAL_COLLECTION.invite, freshRkey),
          cid: "",
          value: {
            $type: OPENSOCIAL_COLLECTION.invite,
            message: "G2 fresh generation",
            createdAt: "2026-11-16T00:00:00.000Z",
          },
        },
      ],
    },
  });
  void g2Inv;
  // Restore live writer visibility before `scan2` runs behind the lock
  omitGroup2FromWriters = false;
  releaseWritersResponse();

  const [, scan2Invites] = await Promise.all([scan1Promise, scan2Promise]);
  assert.equal(maxConcurrentWritersInFlight, 1, "listInvites must serialize concurrent calls via withGroupLifecycleLock");
  // Even right after `scan1` completed with `omitGroup2FromWriters`, `scan1`'s stale writer purge MUST NOT have wiped the newer generation!
  assert.equal(scan2Invites.some((i) => i.groupDid === group2.groupDid), true);

  // Direct CAS check without scan2 overwriting: pause a single stale scan omitting `group1` while bumping invalidationSeq -> `group1` cached records survive!
  let holdSingle = true;
  let releaseSingle!: () => void;
  const singleGate = new Promise<void>((r) => {
    releaseSingle = r;
  });
  const aliceCas = createEngine(
    {
      ...aliceBase,
      fetchEndpoint: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/xrpc/com.atproto.space.listWriters" && url.searchParams.get("space") === invitesUri) {
          const res = await aliceBase.fetchEndpoint(request);
          const body = (await res.json()) as { repos: Array<{ repo: string; repoRev: string; spaceRev: string }> };
          if (holdSingle) {
            holdSingle = false;
            await singleGate;
            return Response.json({ repos: [] });
          }
          return Response.json(body);
        }
        return aliceBase.fetchEndpoint(request);
      },
    },
    { store: alice.sync.store },
  );
  const casScan = aliceCas.workspaces.listInvites();
  while (holdSingle) {
    await new Promise((r) => setTimeout(r, 5));
  }
  await alice.sync.store.invalidateSpace(invitesUri);
  releaseSingle();
  await casScan;
  const survivingGroup1Records = await alice.sync.store.records(invitesUri, OPENSOCIAL_COLLECTION.invite, group1.groupDid);
  assert.equal(survivingGroup1Records.length, 1, "Superseded listInvites scan must NOT purge cached writer records after invalidationSeq advance");

  // Part B (Round 17 Fix #5): Missing, non-`self`, or malformed outer `com.atproto.space.policy` record marks workspace degraded (`rosterComplete === false`)!
  const policyWs = await createWorkspace(network, {
    skey: "r17polws",
    members: [ALICE],
    admins: [ALICE],
    channels: [{ skey: "general", visibility: "public" }],
  });
  let policyRecordMode: "valid" | "missing" | "non_self" | "wrong_outer_type" = "missing";
  const alicePol = createEngine({
    ...aliceBase,
    fetchEndpoint: async (request) => {
      const url = new URL(request.url);
      if (
        policyRecordMode !== "valid" &&
        url.pathname === "/xrpc/com.atproto.space.listRecords" &&
        url.searchParams.get("collection") === ATPROTO_SPACE_COLLECTION.spacePolicy &&
        url.searchParams.get("space") === policyWs.workspace
      ) {
        if (policyRecordMode === "missing") {
          return Response.json({ records: [] });
        }
        if (policyRecordMode === "non_self") {
          return Response.json({
            records: [
              {
                collection: ATPROTO_SPACE_COLLECTION.spacePolicy,
                rkey: "other",
                value: {
                  $type: ATPROTO_SPACE_COLLECTION.spacePolicy,
                  policy: {
                    $type: OPENSOCIAL_POLICY,
                    publicRead: false,
                    unlisted: false,
                    grants: [{ role: "member", read: true }],
                  },
                },
              },
            ],
          });
        }
        return Response.json({
          records: [
            {
              collection: ATPROTO_SPACE_COLLECTION.spacePolicy,
              rkey: SELF_SKEY,
              value: {
                $type: "wrong.wrapper.type",
                policy: {
                  $type: OPENSOCIAL_POLICY,
                  publicRead: false,
                  unlisted: false,
                  grants: [{ role: "member", read: true }],
                },
              },
            },
          ],
        });
      }
      return aliceBase.fetchEndpoint(request);
    },
  });

  for (const badMode of ["missing", "non_self", "wrong_outer_type"] as const) {
    policyRecordMode = badMode;
    const deg = await alicePol.workspaces.summary(policyWs.workspace);
    assert.ok(deg);
    assert.equal(deg.rosterComplete, false, `rosterComplete must be false when space.policy is ${badMode}`);
    assert.match(
      deg.degradedReasons.join(" "),
      /Space policy records contain malformed or missing entries/,
      `degradedReasons must report missing/malformed policy when ${badMode}`,
    );
  }
  policyRecordMode = "valid";
  const healthy = await alicePol.workspaces.summary(policyWs.workspace);
  assert.ok(healthy);
  assert.equal(healthy.rosterComplete, true);
  assert.deepEqual(healthy.degradedReasons, []);
});
