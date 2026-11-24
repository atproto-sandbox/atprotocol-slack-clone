import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { XrpcError } from "@flock/protocol/atproto/xrpc";
import { groupMembersUri, SELF_SKEY } from "@flock/protocol/keys";
import {
  FLOCK_EXTENSION_FIELD,
  OPENSOCIAL_COLLECTION,
  OPENSOCIAL_METHOD,
  OPENSOCIAL_POLICY,
  SPACE_TYPE,
} from "@flock/protocol/nsids";
import { FakeNetwork } from "@flock/testing/fake-network";
import { DidResolutionError } from "./did-resolver";
import {
  deskLifecycleDatabaseName,
  IndexedDbLifecycleStore,
  LifecycleActorMismatchError,
  MemoryLifecycleStore,
} from "./lifecycle-store";
import {
  acceptDirectMembership,
  cancelPendingJoin,
  dismissJoinOperation,
  joinGroup,
  JoinOperationQuotaExceededError,
  leaveGroup,
  parseJoinStatusResponse,
  reconcileLifecycle,
  retryJoinOperation,
  TERMINAL_JOIN_XRPC_CODES,
  UnsupportedJoinStatusError,
  withGroupLifecycleLock,
  type DeskShellDeps,
} from "./membership";

const GROUP = "did:plc:grplifecycleaaaaaaaaaaaa";
const GROUP2 = "did:plc:grplifecycle2aaaaaaaaaaa";
const ALICE = "did:plc:alicelifecycleaaaaaaaaaa";
const BOB = "did:plc:boblifecycleaaaaaaaaaaaa";

async function setupGroup(net: FakeNetwork, groupDid = GROUP) {
  if (!net.hasAccount(ALICE)) net.createAccount(ALICE, "pds1");
  if (!net.hasAccount(BOB)) net.createAccount(BOB, "pds2");
  await net.createGroupAccount(groupDid, {
    name: "Lifecycle Group",
    joinPolicy: "invite",
    publicMeta: true,
    sovereignRotationKeys: ["did:key:zDnaeLifecycleKey"],
  });
  const owner = net.clientFor(groupDid);
  await owner.procedure("com.atproto.space.createSpace", {
    spaceType: SPACE_TYPE.workspace,
    skey: SELF_SKEY,
    policy: {
      $type: OPENSOCIAL_POLICY,
      publicRead: false,
      unlisted: false,
      grants: [
        { role: "admin", read: true, write: true },
        { role: "member", read: true },
      ],
    },
  });
  return { owner, membersUri: groupMembersUri(groupDid) };
}

function makeMockDeps(
  net: FakeNetwork,
  did: string,
  overrides: {
    resolvePds?: (targetDid: string, forceRefresh?: boolean) => Promise<string>;
    onEndpoint?: (request: Request) => Promise<Response | null>;
  } = {},
): DeskShellDeps {
  return {
    did,
    memberClient: net.clientFor(did),
    resolvePds: overrides.resolvePds ?? net.resolvePds,
    resolveKemKey: net.resolveKemKey,
    fetchEndpoint: async (request) => {
      if (overrides.onEndpoint) {
        const custom = await overrides.onEndpoint(request);
        if (custom) return custom;
      }
      return net.fetchEndpoint(request);
    },
    generateKey: net.generateKey,
    now: net.now,
  };
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("parseJoinStatusResponse accepts explicit null fields as absent and rejects malformed payloads with 502 InvalidJoinStatusResponse", () => {
  assert.deepEqual(
    parseJoinStatusResponse({ state: "pending", currentIncarnation: null, membership: null }),
    { state: "pending" },
  );
  assert.deepEqual(
    parseJoinStatusResponse({
      state: "admitted",
      currentIncarnation: "inc-2",
      membership: { uri: "at://did:plc:x/m", cid: "bafy123" },
    }),
    { state: "admitted", currentIncarnation: "inc-2", membership: { uri: "at://did:plc:x/m", cid: "bafy123" } },
  );
  assert.deepEqual(parseJoinStatusResponse({ state: "left_deactivated" }), { state: "left_deactivated" });

  for (const bad of [
    null,
    "pending",
    [],
    {},
    { state: "bogus" },
    { state: "admitted", currentIncarnation: "" },
    { state: "admitted", currentIncarnation: 42 },
    { state: "admitted", membership: { uri: "only-uri" } },
    { state: "admitted", membership: "bad" },
  ]) {
    assert.throws(
      () => parseJoinStatusResponse(bad),
      (err: unknown) => err instanceof XrpcError && err.status === 502 && err.code === "InvalidJoinStatusResponse",
      JSON.stringify(bad),
    );
  }
});

test("acceptDirectMembership repairs missing and stale-incarnation acceptance/self after ejection & re-admission", async () => {
  const net = new FakeNetwork();
  const { owner, membersUri } = await setupGroup(net);

  // Seed live membership with incarnation "inc-2" while Bob has stale acceptance "inc-1"
  await owner.procedure("com.atproto.space.putRecord", {
    space: membersUri,
    repo: GROUP,
    collection: OPENSOCIAL_COLLECTION.membership,
    rkey: BOB,
    record: {
      $type: OPENSOCIAL_COLLECTION.membership,
      roles: ["member"],
      [FLOCK_EXTENSION_FIELD.incarnation]: "inc-2",
      createdAt: "2026-11-20T00:00:00.000Z",
    },
  });
  await net.clientFor(BOB).procedure("com.atproto.space.putRecord", {
    space: membersUri,
    repo: BOB,
    collection: OPENSOCIAL_COLLECTION.acceptance,
    rkey: SELF_SKEY,
    record: {
      $type: OPENSOCIAL_COLLECTION.acceptance,
      [FLOCK_EXTENSION_FIELD.incarnation]: "inc-1",
      createdAt: "2026-11-19T00:00:00.000Z",
    },
  });

  const liveMembership = await owner.query<{ value: Record<string, unknown> }>("com.atproto.space.getRecord", {
    space: membersUri,
    repo: GROUP,
    collection: OPENSOCIAL_COLLECTION.membership,
    rkey: BOB,
  });
  const liveIncarnation = String(liveMembership.value[FLOCK_EXTENSION_FIELD.incarnation]);
  assert.ok(liveIncarnation.length > 0 && liveIncarnation !== "inc-1");

  const deps = makeMockDeps(net, BOB);
  const store = new MemoryLifecycleStore(BOB);
  const res = await acceptDirectMembership(deps, store, { groupDid: GROUP });
  assert.equal(res.status, "admitted");
  assert.equal(res.incarnation, liveIncarnation);

  const updatedAcc = await net.clientFor(BOB).query<{ value: Record<string, unknown> }>("com.atproto.space.getRecord", {
    space: membersUri,
    repo: BOB,
    collection: OPENSOCIAL_COLLECTION.acceptance,
    rkey: SELF_SKEY,
  });
  assert.equal(updatedAcc.value[FLOCK_EXTENSION_FIELD.incarnation], liveIncarnation);
});

test("joinGroup crash-resumes across all 5 phases, replays Idempotency-Key, handles quota/terminal/unknown/migration/retry/dismiss", async () => {
  const net = new FakeNetwork();
  const { owner, membersUri } = await setupGroup(net);
  const store = new MemoryLifecycleStore(BOB);

  let endpoint = "https://gh1.example";
  const seenKeys: string[] = [];
  let joinBehavior: "transient" | "admitted" | "pending" | "quota" | "unknown_status" | "terminal" = "transient";
  let statusBehavior: Record<string, unknown> = { state: "pending" };

  const deps = makeMockDeps(net, BOB, {
    resolvePds: async (did) => (did === GROUP ? endpoint : net.resolvePds(did)),
    onEndpoint: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === `/xrpc/${OPENSOCIAL_METHOD.requestJoin}`) {
        const key = request.headers.get("idempotency-key") ?? "";
        seenKeys.push(key);
        if (joinBehavior === "transient") return jsonRes({ error: "Internal", message: "boom" }, 503);
        if (joinBehavior === "quota") return jsonRes({ error: "JoinOperationQuotaExceeded", message: "quota" }, 429);
        if (joinBehavior === "terminal") return jsonRes({ error: "InvalidInvite", message: "bad invite" }, 400);
        if (joinBehavior === "unknown_status") return jsonRes({ status: "future_status" }, 200);
        if (joinBehavior === "pending") return jsonRes({ status: "pending" }, 200);
        // admitted: write membership on FakeNetwork
        await owner.procedure("com.atproto.space.putRecord", {
          space: membersUri,
          repo: GROUP,
          collection: OPENSOCIAL_COLLECTION.membership,
          rkey: BOB,
          record: {
            $type: OPENSOCIAL_COLLECTION.membership,
            roles: ["member"],
            [FLOCK_EXTENSION_FIELD.incarnation]: "inc-join-1",
            createdAt: "2026-11-20T00:00:00.000Z",
          },
        });
        return jsonRes({ status: "admitted" }, 200);
      }
      if (url.pathname === "/group-member/join-status") {
        return jsonRes(statusBehavior, 200);
      }
      if (url.origin === endpoint) {
        // Forward space credential / space record reads to FakeNetwork's actual group origin
        const realOrigin = await net.resolvePds(GROUP);
        const forwarded = new Request(new URL(`${url.pathname}${url.search}`, realOrigin), request);
        return net.fetchEndpoint(forwarded);
      }
      return null;
    },
  });

  // 1. Transient error keeps `submitting` row; replay uses exact same Idempotency-Key!
  await assert.rejects(() => joinGroup(deps, store, { groupDid: GROUP, inviteUri: "at://inv/1", message: "hi" }), XrpcError);
  const afterCrash = await store.listJoiningGroups();
  assert.equal(afterCrash.length, 1);
  assert.equal(afterCrash[0]!.phase, "submitting");
  const op1 = afterCrash[0]!.operationId;

  // Replay transitions to `pending_approval` with same Idempotency-Key
  joinBehavior = "pending";
  const pendingRes = await joinGroup(deps, store, { groupDid: GROUP, inviteUri: "at://inv/1", message: "hi" });
  assert.equal(pendingRes.status, "pending");
  assert.equal(seenKeys[0], op1);
  assert.equal(seenKeys[1], op1);
  assert.equal((await store.getJoiningGroup(op1))?.phase, "pending_approval");

  // 2. Malformed join-status fails closed with 502 and preserves journal row intact
  statusBehavior = { state: "invalid_state" };
  const recBad = await reconcileLifecycle(deps, store);
  assert.equal(recBad.joinErrors.length, 1);
  assert.equal((await store.getJoiningGroup(op1))?.phase, "pending_approval");

  // 3. `left_deactivated` preserves pending_approval row intact
  statusBehavior = { state: "left_deactivated" };
  await reconcileLifecycle(deps, store);
  assert.equal((await store.getJoiningGroup(op1))?.phase, "pending_approval");

  // 4. Migration + `unknown` -> passive `orphaned_by_migration` (never auto-retried on reconcile!)
  endpoint = "https://gh2.example";
  statusBehavior = { state: "unknown" };
  await reconcileLifecycle(deps, store);
  const orphaned = await store.getJoiningGroup(op1);
  assert.equal(orphaned?.phase, "orphaned_by_migration");
  const callsBeforeReconcile = seenKeys.length;
  await reconcileLifecycle(deps, store);
  assert.equal(seenKeys.length, callsBeforeReconcile, "passive orphaned_by_migration must not auto-retry");

  // 5. `retryJoinOperation`: allocates fresh operationId, preserves inviteUri/message, updates endpoint, atomically replaces row, and completes all 5 phases!
  joinBehavior = "admitted";
  const retried = await retryJoinOperation(deps, store, op1);
  assert.equal(retried.status, "admitted");
  assert.notEqual(retried.operationId, op1);
  assert.equal(await store.getJoiningGroup(op1), undefined);
  assert.equal((await store.listJoiningGroups()).length, 0, "completed row deleted after discovery_verified");

  // 6. Remove membership so we can test 429 quota_exceeded + dismissJoinOperation + terminal codes + unknown status
  await owner.procedure("com.atproto.space.deleteRecord", {
    space: membersUri,
    repo: GROUP,
    collection: OPENSOCIAL_COLLECTION.membership,
    rkey: BOB,
  });

  joinBehavior = "quota";
  await assert.rejects(() => joinGroup(deps, store, { groupDid: GROUP, inviteUri: "at://inv/2" }), JoinOperationQuotaExceededError);
  const quotaRows = await store.listJoiningGroups();
  assert.equal(quotaRows.length, 1);
  assert.equal(quotaRows[0]!.phase, "quota_exceeded");
  await dismissJoinOperation(deps, store, quotaRows[0]!.operationId);
  assert.equal((await store.listJoiningGroups()).length, 0);

  joinBehavior = "terminal";
  assert.ok(TERMINAL_JOIN_XRPC_CODES.has("InvalidInvite"));
  await assert.rejects(() => joinGroup(deps, store, { groupDid: GROUP, inviteUri: "at://inv/3" }), XrpcError);
  assert.equal((await store.listJoiningGroups()).length, 0, "terminal XRPC code deletes joiningGroups row immediately");

  joinBehavior = "unknown_status";
  await assert.rejects(
    () => joinGroup(deps, store, { groupDid: GROUP, inviteUri: "at://inv/4" }),
    UnsupportedJoinStatusError,
  );
  const unsupportedRows = await store.listJoiningGroups();
  assert.equal(unsupportedRows[0]?.phase, "unsupported_status");
  assert.equal(unsupportedRows[0]?.rawStatus, "future_status");
  await dismissJoinOperation(deps, store, unsupportedRows[0]!.operationId);
});

test("cancelPendingJoin handles JoinRequestNotFound admission-race upgrade and preserves left_deactivated", async () => {
  const net = new FakeNetwork();
  await setupGroup(net);
  const store = new MemoryLifecycleStore(BOB);
  const opId = "2222222222224";

  await store.putJoiningGroup({
    viewerDid: BOB,
    operationId: opId,
    mode: "approval",
    intentHash: "hash1",
    groupDid: GROUP,
    authorityEndpoint: "https://gh1.example",
    phase: "pending_approval",
    createdAt: net.now(),
  });

  let probeState: Record<string, unknown> = { state: "left_deactivated" };
  const deps = makeMockDeps(net, BOB, {
    resolvePds: async () => "https://gh1.example",
    onEndpoint: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === `/xrpc/${OPENSOCIAL_METHOD.cancelJoinRequest}`) {
        return jsonRes({ error: "JoinRequestNotFound", message: "gone" }, 400);
      }
      if (url.pathname === "/group-member/join-status") {
        return jsonRes(probeState, 200);
      }
      return null;
    },
  });

  // `left_deactivated`: preserves pending_approval row intact and rethrows
  await assert.rejects(() => cancelPendingJoin(deps, store, { groupDid: GROUP }), XrpcError);
  assert.equal((await store.getJoiningGroup(opId))?.phase, "pending_approval");

  // `admitted`: upgrades pending_approval -> membership_verified with live incarnation!
  probeState = { state: "admitted", currentIncarnation: "inc-race-9" };
  await assert.rejects(() => cancelPendingJoin(deps, store, { groupDid: GROUP }), XrpcError);
  const upgraded = await store.getJoiningGroup(opId);
  assert.equal(upgraded?.phase, "membership_verified");
  assert.equal(upgraded?.currentIncarnation, "inc-race-9");
});

test("reconcileLifecycle enforces strict leave-before-join order, leave-completion barrier, and per-row error isolation", async () => {
  const net = new FakeNetwork();
  await setupGroup(net, GROUP);
  await setupGroup(net, GROUP2);
  const store = new MemoryLifecycleStore(BOB);

  let requestJoinCalls = 0;
  let leaveFailsTransiently = true;

  // Seed BOTH a leaving row and a stale submitting join row for GROUP
  await store.putLeavingGroup({
    viewerDid: BOB,
    groupDid: GROUP,
    expectedIncarnation: "inc-old",
    phase: "leaving_group",
    createdAt: net.now(),
  });
  await store.putJoiningGroup({
    viewerDid: BOB,
    operationId: "2222222222225",
    mode: "open",
    intentHash: "stale-join",
    groupDid: GROUP,
    authorityEndpoint: "https://gh1.example",
    phase: "submitting",
    createdAt: net.now(),
  });
  // Also seed a second group's leaving row that succeeds, proving per-row isolation!
  await store.putLeavingGroup({
    viewerDid: BOB,
    groupDid: GROUP2,
    expectedIncarnation: "inc-g2",
    phase: "leaving_group",
    createdAt: net.now(),
  });

  const deps = makeMockDeps(net, BOB, {
    resolvePds: async () => "https://gh1.example",
    onEndpoint: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === `/xrpc/${OPENSOCIAL_METHOD.requestJoin}`) {
        requestJoinCalls += 1;
        return jsonRes({ status: "admitted" }, 200);
      }
      if (url.pathname === `/xrpc/${OPENSOCIAL_METHOD.leaveGroup}`) {
        const body = (await req.json()) as { group: string };
        if (body.group === GROUP && leaveFailsTransiently) {
          return jsonRes({ error: "TemporaryError", message: "503" }, 503);
        }
        return jsonRes({}, 200);
      }
      if (url.pathname === "/group-member/join-status") {
        return jsonRes({ state: "unknown" }, 200);
      }
      return null;
    },
  });

  // 1. Transient leave failure on GROUP leaves GROUP's leave row in place:
  //    - GROUP2's leave still succeeds (per-row error isolation!)
  //    - GROUP's stale submitting join row is SKIPPED by leave-completion barrier (`requestJoinCalls === 0`)!
  const firstRun = await reconcileLifecycle(deps, store);
  assert.equal(firstRun.leaveErrors.length, 1);
  assert.equal(firstRun.leaveErrors[0]!.groupDid, GROUP);
  assert.equal(await store.getLeavingGroup(GROUP2), undefined, "GROUP2 succeeded despite GROUP failure");
  assert.equal(requestJoinCalls, 0, "leave-completion barrier prevented stale submitting join from calling requestJoin");

  // 1b. Direct acceptance / direct rejoin MUST also obey the same-group pending-leave barrier while leave fails!
  await assert.rejects(
    () => acceptDirectMembership(deps, store, { groupDid: GROUP }),
    /503|TemporaryError|pending leave/i,
  );
  await assert.rejects(
    () => joinGroup(deps, store, { groupDid: GROUP }),
    /503|TemporaryError|pending leave/i,
  );
  assert.equal(requestJoinCalls, 0, "direct rejoin must not bypass an unfinished pending leave");
  assert.ok(await store.getLeavingGroup(GROUP), "failed leave row remains persisted until completed");

  // 2. Once leave succeeds, Phase 3 clears the stale submitting join row AND deletes leaving row; requestJoin still NEVER called!
  leaveFailsTransiently = false;
  const secondRun = await reconcileLifecycle(deps, store);
  assert.equal(secondRun.leaveErrors.length, 0);
  assert.equal(await store.getLeavingGroup(GROUP), undefined);
  assert.equal(await store.getJoiningGroup("2222222222225"), undefined);
  assert.equal(requestJoinCalls, 0);
});

test("leaveGroup handles preflight + 3-phase errors: tombstone, LastAdmin, MembershipIncarnationMismatch, RepoDeactivated/blocked_deactivated, RepoTakendown migration, and Phase 3 cross-device re-admission preservation", async () => {
  const net = new FakeNetwork();
  const { membersUri } = await setupGroup(net);
  const store = new MemoryLifecycleStore(BOB);

  const writeAcc = async (incarnation: string) => {
    await net.clientFor(BOB).procedure("com.atproto.space.putRecord", {
      space: membersUri,
      repo: BOB,
      collection: OPENSOCIAL_COLLECTION.acceptance,
      rkey: SELF_SKEY,
      record: {
        $type: OPENSOCIAL_COLLECTION.acceptance,
        [FLOCK_EXTENSION_FIELD.incarnation]: incarnation,
        createdAt: "2026-11-20T00:00:00.000Z",
      },
    });
  };
  const readAcc = async () => {
    try {
      return (
        await net.clientFor(BOB).query<{ value: Record<string, unknown> }>("com.atproto.space.getRecord", {
          space: membersUri,
          repo: BOB,
          collection: OPENSOCIAL_COLLECTION.acceptance,
          rkey: SELF_SKEY,
        })
      ).value;
    } catch {
      return null;
    }
  };

  // A. LastAdmin deletes leaving row and preserves acceptance/self
  await writeAcc("inc-a");
  let leaveRes: Response = jsonRes({ error: "LastAdmin", message: "last admin" }, 400);
  let joinStatusRes: Response = jsonRes({ state: "admitted", currentIncarnation: "inc-a" }, 200);
  let groupEndpoint = "https://gh1.example";
  let tombstoned = false;

  const deps = makeMockDeps(net, BOB, {
    resolvePds: async (did) => {
      if (did === GROUP) {
        if (tombstoned) throw new DidResolutionError("gone", 410);
        return groupEndpoint;
      }
      return net.resolvePds(did);
    },
    onEndpoint: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === `/xrpc/${OPENSOCIAL_METHOD.leaveGroup}`) return leaveRes.clone();
      if (url.pathname === "/group-member/join-status") return joinStatusRes.clone();
      return null;
    },
  });

  await assert.rejects(() => leaveGroup(deps, store, { groupDid: GROUP }), (e: unknown) => e instanceof XrpcError && e.code === "LastAdmin");
  assert.equal(await store.getLeavingGroup(GROUP), undefined);
  assert.equal((await readAcc())?.[FLOCK_EXTENSION_FIELD.incarnation], "inc-a");

  // B. MembershipIncarnationMismatch deletes leaving row and preserves acceptance/self
  leaveRes = jsonRes({ error: "MembershipIncarnationMismatch", message: "mismatch" }, 409);
  await assert.rejects(() => leaveGroup(deps, store, { groupDid: GROUP }), (e: unknown) => e instanceof XrpcError && e.code === "MembershipIncarnationMismatch");
  assert.equal(await store.getLeavingGroup(GROUP), undefined);
  assert.equal((await readAcc())?.[FLOCK_EXTENSION_FIELD.incarnation], "inc-a");

  // C. RepoDeactivated parks at `blocked_deactivated`, background reconcile skips it, interactive retry completes once reactivated
  leaveRes = jsonRes({ error: "RepoDeactivated", message: "deactivated" }, 400);
  await assert.rejects(() => leaveGroup(deps, store, { groupDid: GROUP }), (e: unknown) => e instanceof XrpcError && e.code === "RepoDeactivated");
  assert.equal((await store.getLeavingGroup(GROUP))?.phase, "blocked_deactivated");
  assert.equal((await readAcc())?.[FLOCK_EXTENSION_FIELD.incarnation], "inc-a");
  await reconcileLifecycle(deps, store);
  assert.equal((await store.getLeavingGroup(GROUP))?.phase, "blocked_deactivated", "background reconcile skips blocked_deactivated");

  // Reactivated -> interactive leaveGroup succeeds and cleans up acceptance/self
  leaveRes = jsonRes({}, 200);
  joinStatusRes = jsonRes({ state: "unknown" }, 200);
  await leaveGroup(deps, store, { groupDid: GROUP });
  assert.equal(await store.getLeavingGroup(GROUP), undefined);
  assert.equal(await readAcc(), null);

  // D. Initial resolvePds tombstoned (410) still cleans up orphaned acceptance/self
  await writeAcc("inc-tomb");
  tombstoned = true;
  await leaveGroup(deps, store, { groupDid: GROUP });
  assert.equal(await readAcc(), null);
  tombstoned = false;

  // D2. RepoTakendown on old host followed by PLC refresh to migrated new host retries and completes!
  await writeAcc("inc-mig");
  let resolveCount = 0;
  const migratedDeps = makeMockDeps(net, BOB, {
    resolvePds: async (did, forceRefresh) => {
      if (did === GROUP) {
        resolveCount += 1;
        if (forceRefresh && resolveCount >= 2) {
          groupEndpoint = "https://gh2.example";
        }
        return groupEndpoint;
      }
      return net.resolvePds(did);
    },
    onEndpoint: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === `/xrpc/${OPENSOCIAL_METHOD.leaveGroup}`) {
        return url.origin === "https://gh1.example"
          ? jsonRes({ error: "RepoTakendown", message: "moved" }, 400)
          : jsonRes({}, 200);
      }
      if (url.pathname === "/group-member/join-status") {
        return url.origin === "https://gh1.example"
          ? jsonRes({ state: "admitted", currentIncarnation: "inc-mig" }, 200)
          : jsonRes({ state: "unknown" }, 200);
      }
      return null;
    },
  });
  await leaveGroup(migratedDeps, store, { groupDid: GROUP });
  assert.equal(groupEndpoint, "https://gh2.example");
  assert.equal(await readAcc(), null);

  // E. Phase 3 cross-device re-admission early return: restores acceptance/self with newer incarnation AND preserves active joiningGroups row!
  await store.putLeavingGroup({
    viewerDid: BOB,
    groupDid: GROUP,
    expectedIncarnation: "inc-old",
    phase: "reconciling_post_delete",
    createdAt: net.now(),
  });
  await store.putJoiningGroup({
    viewerDid: BOB,
    operationId: "2222222222229",
    mode: "open",
    intentHash: "active-join",
    groupDid: GROUP,
    phase: "pending_approval",
    createdAt: net.now(),
  });
  joinStatusRes = jsonRes({ state: "admitted", currentIncarnation: "inc-new" }, 200);
  await leaveGroup(deps, store, { groupDid: GROUP });
  assert.equal(await store.getLeavingGroup(GROUP), undefined);
  assert.equal((await readAcc())?.[FLOCK_EXTENSION_FIELD.incarnation], "inc-new");
  assert.ok(await store.getJoiningGroup("2222222222229"), "re-admitted Phase 3 early-return must NOT clear active joiningGroups");
});

test("withGroupLifecycleLock serializes concurrent operations per (viewerDid, groupDid) and IndexedDbLifecycleStore isolates accounts & deletes on sign-out", async () => {
  const order: string[] = [];
  await Promise.all([
    withGroupLifecycleLock(ALICE, GROUP, async () => {
      order.push("start-1");
      await new Promise((r) => setTimeout(r, 20));
      order.push("end-1");
    }),
    withGroupLifecycleLock(ALICE, GROUP, async () => {
      order.push("start-2");
      order.push("end-2");
    }),
  ]);
  assert.deepEqual(order, ["start-1", "end-1", "start-2", "end-2"]);

  // Account-scoped IndexedDB lifecycle store isolation + sign-out erasure + cross-actor row rejection
  const idb = new IDBFactory();
  const aliceStore = await IndexedDbLifecycleStore.open(ALICE, idb);
  assert.equal(deskLifecycleDatabaseName(ALICE), `flock-desk-lifecycle:${ALICE}`);
  await aliceStore.putJoiningGroup({
    viewerDid: ALICE,
    operationId: "2222222222230",
    mode: "open",
    intentHash: "h",
    groupDid: GROUP,
    phase: "pending_approval",
    createdAt: 1,
  });
  await assert.rejects(
    () =>
      aliceStore.putJoiningGroup({
        viewerDid: BOB,
        operationId: "2222222222231",
        mode: "open",
        intentHash: "h",
        groupDid: GROUP,
        phase: "pending_approval",
        createdAt: 1,
      }),
    LifecycleActorMismatchError,
  );
  aliceStore.close();
  await IndexedDbLifecycleStore.deleteAccount(ALICE, idb);

  const bobStore = await IndexedDbLifecycleStore.open(BOB, idb);
  assert.deepEqual(await bobStore.listJoiningGroups(), []);
  bobStore.close();
  const dbs = (await idb.databases()).map((d) => d.name);
  assert.equal(dbs.includes(deskLifecycleDatabaseName(ALICE)), false);

  // Cross-actor injected row rejected during reconcileLifecycle
  const mem = new MemoryLifecycleStore(BOB);
  mem.injectUnsafeRowForTest({
    viewerDid: ALICE,
    operationId: "2222222222232",
    mode: "open",
    intentHash: "h",
    groupDid: GROUP,
    phase: "submitting",
    createdAt: 1,
  });
  const net = new FakeNetwork();
  net.createAccount(BOB, "pds2");
  const rec = await reconcileLifecycle(makeMockDeps(net, BOB), mem);
  assert.equal(rec.joinErrors.length, 1);
  assert.ok(rec.joinErrors[0]!.error instanceof LifecycleActorMismatchError);
});
