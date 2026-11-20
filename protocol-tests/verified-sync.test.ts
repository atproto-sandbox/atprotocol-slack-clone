import assert from "node:assert/strict";
import test from "node:test";
import { AppRuntime } from "@flock/client/app-runtime";
import { CredentialCache } from "@flock/client/credentials";
import { createEngine } from "@flock/client/engine";
import { MemoryStore } from "@flock/client/memory-store";
import { SyncCore } from "@flock/client/sync";
import { AtprotoClient } from "@flock/protocol/atproto/xrpc";
import { tidNow } from "@flock/protocol/keys";
import { COLLECTION } from "@flock/protocol/nsids";
import { actorTransport, bearerSession, startPdsNetwork, storeAuthorityGrant } from "./support/pds-network";
import { Probe } from "./support/sync-dataset";

function trackedTransport(
  pds: Awaited<ReturnType<typeof startPdsNetwork>>,
  actor: Awaited<ReturnType<Awaited<ReturnType<typeof startPdsNetwork>>["createActor"]>>,
) {
  const calls = new Map<string, number>();
  const transport = actorTransport(pds, actor, {
    fetchVia: async (request) => {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/xrpc/")) {
        const method = url.pathname.slice("/xrpc/".length);
        calls.set(method, (calls.get(method) ?? 0) + 1);
      }
      return fetch(request);
    },
  });
  const count = async <T>(run: () => Promise<T>): Promise<{ result: T; byMethod: Record<string, number> }> => {
    const before = new Map(calls);
    const result = await run();
    const byMethod: Record<string, number> = {};
    for (const [method, total] of calls) {
      const delta = total - (before.get(method) ?? 0);
      if (delta > 0) byMethod[method] = delta;
    }
    return { result, byMethod };
  };
  return { transport, count };
}

test("verified sync engine, workspace snapshot, listRepoOps, warm reopen, RepoNotFound boundary, and AppRuntime followRepoOps at the pinned PDS (R11a)", { timeout: 5 * 60_000 }, async () => {
  const pds = await startPdsNetwork("verified-sync");
  try {
    const [
      { restoreAuthorityGrant },
      { createWorkspace },
      { registrationDeps },
      { requireActiveWorkspaceAdmin },
      { executeOperatorOperation },
    ] = await Promise.all([
      import("@flock/operator/operator/authority-grant"),
      import("@flock/operator/operator/kinds/create-workspace"),
      import("@flock/operator/operator/registrations"),
      import("@flock/operator/operator/security"),
      import("@flock/operator/operator/operations"),
    ]);

    const authority = await pds.createActor("vsowner", 0);
    const alice = await pds.createActor("vsalice", 0);
    const bob = await pds.createActor("vsbob", 1);
    const carol = await pds.createActor("vscarol", 1);
    const reader = await pds.createActor("vsreader", 0);
    const app = await pds.createActor("vsapp", 1);

    await storeAuthorityGrant(pds.hosts[0], authority.did, "vs-authority-dpop");
    const created = await createWorkspace(await restoreAuthorityGrant(authority.did), {
      creator: authority.did,
      name: "Verified Sync",
      operationId: tidNow(),
    }, registrationDeps);
    assert.equal(created.state, "completed");

    const admin = await requireActiveWorkspaceAdmin(created.workspace, authority.did);
    const generalSkey = created.channel.split("/").at(-1)!;
    for (const member of [alice, bob, carol, reader]) {
      const res = await executeOperatorOperation(admin, tidNow(), { kind: "inviteMember", subject: member.did }, registrationDeps);
      assert.equal(res.state, "completed", `invite ${member.handle}`);
    }
    const appInstallRes = await executeOperatorOperation(admin, tidNow(), {
      kind: "installApp",
      subject: app.did,
      channels: [{ skey: generalSkey, write: true }],
    }, registrationDeps);
    assert.equal(appInstallRes.state, "completed");

    const aliceClient = new AtprotoClient(bearerSession(alice).fetchHandler);
    const bobClient = new AtprotoClient(bearerSession(bob).fetchHandler);
    const carolClient = new AtprotoClient(bearerSession(carol).fetchHandler);
    const probe = new Probe(pds, reader, created.channel);

    // Seed Alice with 1 record and Bob (on second PDS) with 2 records in one applyWrites commit; keep Carol unwritten.
    const a1Rkey = tidNow();
    await aliceClient.procedure("com.atproto.space.createRecord", {
      space: created.channel,
      repo: alice.did,
      collection: COLLECTION.message,
      rkey: a1Rkey,
      record: { $type: COLLECTION.message, text: "alice-1", createdAt: new Date().toISOString() },
    });
    const b1Rkey = tidNow(Date.now() + 10);
    const b2Rkey = tidNow(Date.now() + 20);
    await bobClient.procedure("com.atproto.space.applyWrites", {
      space: created.channel,
      repo: bob.did,
      writes: [
        {
          $type: "com.atproto.space.applyWrites#create",
          collection: COLLECTION.message,
          rkey: b1Rkey,
          value: { $type: COLLECTION.message, text: "bob-1", createdAt: new Date().toISOString() },
        },
        {
          $type: "com.atproto.space.applyWrites#create",
          collection: COLLECTION.message,
          rkey: b2Rkey,
          value: { $type: COLLECTION.message, text: "bob-2", createdAt: new Date().toISOString() },
        },
      ],
    });
    await probe.waitForCurrentRevision(alice.did);
    await probe.waitForCurrentRevision(bob.did);

    // 1. syncVerifiedWorkspaceSnapshot verifies authority workspace repo end-to-end via STAR primary (0 getRecord).
    const sharedStore = new MemoryStore();
    const coldHarness = trackedTransport(pds, reader);
    const coldCore = new SyncCore({
      transport: coldHarness.transport,
      credentials: new CredentialCache(coldHarness.transport),
      store: sharedStore,
    });
    const { result: snapshot, byMethod: snapCalls } = await coldHarness.count(() =>
      coldCore.syncVerifiedWorkspaceSnapshot(created.workspace),
    );
    assert.equal(snapshot.workspaceSnapshotComplete, true);
    assert.equal(snapCalls["com.atproto.space.getRepo"], 1);
    assert.equal(snapCalls["com.atproto.space.getRecord"], undefined);
    for (const did of [authority.did, alice.did, bob.did, carol.did, reader.did]) {
      assert.equal(snapshot.rosterMembers.has(did), true, `roster contains ${did}`);
    }

    // 2. Cold verified space sync uses STAR for Alice/Bob and accepts unwritten Carol (RepoNotFound + valid PDS + omitted from listWriters).
    const { result: coldSync, byMethod: coldCalls } = await coldHarness.count(() =>
      coldCore.syncVerifiedSpace({
        space: created.channel,
        collections: [COLLECTION.message],
        verifiedRosterMembers: snapshot.rosterMembers,
        workspaceSnapshotComplete: snapshot.workspaceSnapshotComplete,
      }),
    );
    assert.equal(coldSync.complete, true);
    assert.equal(coldSync.records.length, 3);
    assert.equal(coldSync.emptyReasons[carol.did], "unwrittenOrAbsent");
    assert.ok((coldCalls["com.atproto.space.getRepo"] ?? 0) >= 3, "STAR called for written and unwritten roster writers");
    assert.equal(coldCalls["com.atproto.space.getRecord"], undefined);

    // 3. Warm reopen on a fresh SyncCore over the same persisted SyncStore within truthIntervalMs:
    // exact 1 listWriters call, 0 writer calls!
    const warmHarness = trackedTransport(pds, reader);
    const warmCore = new SyncCore({
      transport: warmHarness.transport,
      credentials: new CredentialCache(warmHarness.transport),
      store: sharedStore,
    });
    const { result: warmSync, byMethod: warmCalls } = await warmHarness.count(() =>
      warmCore.syncVerifiedSpace({
        space: created.channel,
        collections: [COLLECTION.message],
        verifiedRosterMembers: snapshot.rosterMembers,
        workspaceSnapshotComplete: snapshot.workspaceSnapshotComplete,
      }),
    );
    assert.equal(warmSync.complete, true);
    assert.equal(warmSync.records.length, 3);
    assert.equal(warmCalls["com.atproto.space.listWriters"], 1);
    assert.equal(warmCalls["com.atproto.space.getRepo"], undefined);
    assert.equal(warmCalls["com.atproto.space.listRepoOps"], undefined);
    assert.equal(warmCalls["com.atproto.space.listRecords"], undefined);
    assert.equal(warmCalls["com.atproto.space.getLatestCommit"], undefined);
    assert.equal(warmCalls["com.atproto.space.getRecord"], undefined);

    // 4. Incremental listRepoOps via same-rev applyWrites (update b1, delete b2, create b3) -> 1 listRepoOps, 0 getRepo!
    const b3Rkey = tidNow(Date.now() + 30);
    await bobClient.procedure("com.atproto.space.applyWrites", {
      space: created.channel,
      repo: bob.did,
      writes: [
        {
          $type: "com.atproto.space.applyWrites#update",
          collection: COLLECTION.message,
          rkey: b1Rkey,
          value: { $type: COLLECTION.message, text: "bob-1-edited", createdAt: new Date().toISOString() },
        },
        {
          $type: "com.atproto.space.applyWrites#delete",
          collection: COLLECTION.message,
          rkey: b2Rkey,
        },
        {
          $type: "com.atproto.space.applyWrites#create",
          collection: COLLECTION.message,
          rkey: b3Rkey,
          value: { $type: COLLECTION.message, text: "bob-3", createdAt: new Date().toISOString() },
        },
      ],
    });
    await probe.waitForCurrentRevision(bob.did);

    const { result: deltaSync, byMethod: deltaCalls } = await warmHarness.count(() =>
      warmCore.syncVerifiedSpace({
        space: created.channel,
        collections: [COLLECTION.message],
        verifiedRosterMembers: snapshot.rosterMembers,
        workspaceSnapshotComplete: snapshot.workspaceSnapshotComplete,
      }),
    );
    assert.equal(deltaSync.complete, true);
    assert.deepEqual(
      deltaSync.records.filter((r) => r.repo === bob.did).map((r) => ({ rkey: r.rkey, text: r.value.text })),
      [{ rkey: b1Rkey, text: "bob-1-edited" }, { rkey: b3Rkey, text: "bob-3" }],
    );
    assert.equal(deltaCalls["com.atproto.space.listRepoOps"], 1);
    assert.equal(deltaCalls["com.atproto.space.getRepo"], undefined);

    // 5. Unwritten Carol writes her first record on PDS host 1 -> next sync promotes her cleanly.
    const c1Rkey = tidNow(Date.now() + 40);
    await carolClient.procedure("com.atproto.space.createRecord", {
      space: created.channel,
      repo: carol.did,
      collection: COLLECTION.message,
      rkey: c1Rkey,
      record: { $type: COLLECTION.message, text: "carol-first", createdAt: new Date().toISOString() },
    });
    await probe.waitForCurrentRevision(carol.did);
    await warmCore.markSpaceStale(created.channel);
    const afterCarolWrite = await warmCore.syncVerifiedSpace({
      space: created.channel,
      collections: [COLLECTION.message],
      verifiedRosterMembers: snapshot.rosterMembers,
      workspaceSnapshotComplete: snapshot.workspaceSnapshotComplete,
    });
    assert.equal(afterCarolWrite.complete, true);
    assert.equal(afterCarolWrite.emptyReasons[carol.did], undefined);
    assert.equal(afterCarolWrite.records.find((r) => r.repo === carol.did)?.value.text, "carol-first");

    // 6. clearRecords reset on Bob recovers via STAR in syncVerifiedSpace, leaving Bob empty cleanly.
    await bobClient.procedure("com.atproto.space.clearRecords", { space: created.channel, repo: bob.did });
    await probe.waitForCurrentRevision(bob.did);
    const { result: afterClear, byMethod: clearCalls } = await warmHarness.count(() =>
      warmCore.syncVerifiedSpace({
        space: created.channel,
        collections: [COLLECTION.message],
        verifiedRosterMembers: snapshot.rosterMembers,
        workspaceSnapshotComplete: snapshot.workspaceSnapshotComplete,
      }),
    );
    assert.equal(afterClear.complete, true);
    assert.equal(afterClear.records.some((r) => r.repo === bob.did), false);
    assert.equal(clearCalls["com.atproto.space.getRepo"], 1, "clearRecords reset falls back cleanly to STAR");

    // 7. AppRuntime using real SyncCore.followRepoOps against the two pinned PDS hosts:
    // delivers same-rev applyWrites with reverse-TID rkeys in host (rev, idx) order and handles clearRecords reset cleanly.
    const appDelivered: string[] = [];
    const appResets: string[] = [];
    const appEngine = createEngine(actorTransport(pds, app));
    const runtime = new AppRuntime({
      did: app.did,
      workspaces: [created.workspace],
      engine: {
        ...appEngine,
        operator: {
          getChanges: async (follow) => ({
            head: "1",
            changed: follow.map((f) => ({ space: f.space, cursor: "1" })),
            denied: [],
            reset: [],
          }),
        },
      },
      onMessage: async (msg) => {
        appDelivered.push(String(msg.message.value.text));
      },
      onReset: (notice) => appResets.push(notice.repo),
      onError: (error) => assert.fail(`Unexpected AppRuntime error: ${String(error)}`),
    });
    // Poll 1: workspace grants -> starts following channel; Poll 2: baseline channel (deliver: false).
    await runtime.poll();
    await runtime.poll();
    assert.equal(appDelivered.length, 0);

    // Same-rev applyWrites with reverse-sorted valid ATProto TIDs (`j...` before `3...`) -> delivered in host order!
    await aliceClient.procedure("com.atproto.space.applyWrites", {
      space: created.channel,
      repo: alice.did,
      writes: [
        {
          $type: "com.atproto.space.applyWrites#create",
          collection: COLLECTION.message,
          rkey: "jzzzzzzzzzzzz",
          value: { $type: COLLECTION.message, text: "pds-host-first", createdAt: new Date().toISOString() },
        },
        {
          $type: "com.atproto.space.applyWrites#create",
          collection: COLLECTION.message,
          rkey: "3aaaaaaaaaaaa",
          value: { $type: COLLECTION.message, text: "pds-host-second", createdAt: new Date().toISOString() },
        },
      ],
    });
    await probe.waitForCurrentRevision(alice.did);
    await runtime.poll();
    assert.deepEqual(appDelivered, ["pds-host-first", "pds-host-second"]);

    // clearRecords on real PDS -> AppRuntime emits reset notice without re-delivering prior messages, then delivers new write!
    await aliceClient.procedure("com.atproto.space.clearRecords", { space: created.channel, repo: alice.did });
    await probe.waitForCurrentRevision(alice.did);
    await runtime.poll();
    assert.deepEqual(appResets, [alice.did]);
    assert.deepEqual(appDelivered, ["pds-host-first", "pds-host-second"]);

    await aliceClient.procedure("com.atproto.space.createRecord", {
      space: created.channel,
      repo: alice.did,
      collection: COLLECTION.message,
      rkey: tidNow(Date.now() + 60),
      record: { $type: COLLECTION.message, text: "post-clear-new", createdAt: new Date().toISOString() },
    });
    await probe.waitForCurrentRevision(alice.did);
    await runtime.poll();
    assert.deepEqual(appDelivered, ["pds-host-first", "pds-host-second", "post-clear-new"]);
  } finally {
    await pds.close();
  }
});
