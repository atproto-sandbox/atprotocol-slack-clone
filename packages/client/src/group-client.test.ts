import assert from "node:assert/strict";
import test from "node:test";
import { XrpcError } from "@flock/protocol/atproto/xrpc";
import { groupMembersUri, groupMetaUri } from "@flock/protocol/keys";
import { groupAdminScopes } from "@flock/protocol/scopes";
import { FakeNetwork } from "@flock/testing/fake-network";
import {
  clearDefaultMigrationStateForTest,
  createInMemoryMigrationStateStore,
  GroupClient,
  PublicMetaReconciliationError,
  type InFlightGroupMigration,
} from "./group-client";

const GROUP_DID = "did:plc:groupmigtestaaaaaaaaaaaa";
const TARGET_ORIGIN = "https://groups2.example.com";
const TARGET_SERVICE_DID = "did:web:groups2.example.com";

function makeJwtWithExp(expSec: number, label = "tok"): string {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", typ: "at+jwt" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: GROUP_DID, exp: expSec, jti: label })).toString("base64url");
  return `${header}.${payload}.sig`;
}

function createMockMigrationHarness(options: {
  prepareImpl?: (body: Record<string, unknown>, attempt: number) => Response | Promise<Response>;
  sourceAbortImpl?: (body: Record<string, unknown>, attempt: number) => Response | Promise<Response>;
  signPlcImpl?: (body: Record<string, unknown>, attempt: number) => Response | Promise<Response>;
  createAccountTokens?: () => { accessJwt: string; refreshJwt: string };
  refreshSessionImpl?: (authHeader: string | null) => { accessJwt: string; refreshJwt?: string };
  onTargetRequest?: (url: URL, method: string, authHeader: string | null, rawBody: string) => Response | null;
  now?: () => number;
} = {}) {
  let prepareAttempts = 0;
  let sourceAbortAttempts = 0;
  let createAccountAttempts = 0;
  let importRepoAttempts = 0;
  let signPlcAttempts = 0;
  let submitPlcAttempts = 0;
  let activateAccountAttempts = 0;
  let claimPlcTokenAttempts = 0;
  const prepareBodies: Array<Record<string, unknown>> = [];
  const sourceAborts: Array<Record<string, unknown>> = [];
  const signPlcBodies: Array<Record<string, unknown>> = [];
  const submitPlcBodies: Array<Record<string, unknown>> = [];
  const targetAborts: Array<{ authHeader: string | null; body: Record<string, unknown> }> = [];
  const targetAuthHeaders: Array<{ path: string; authHeader: string | null }> = [];
  const createAccountHeaders: Array<Record<string, string>> = [];
  const refreshCalls: Array<string | null> = [];
  const nowFn = options.now ?? (() => 1_700_000_000_000);

  const fetchHandler = async (path: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(path, "https://groups1.example.com");
    if (url.pathname === "/xrpc/com.atproto.space.getSpace") {
      return Response.json({
        space: url.searchParams.get("space"),
        policy: { publicRead: url.searchParams.get("space") === groupMetaUri(GROUP_DID) ? false : false },
      });
    }
    if (url.pathname === "/group-admin/prepare-migration") {
      prepareAttempts += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      prepareBodies.push(body);
      if (options.prepareImpl) {
        return options.prepareImpl(body, prepareAttempts);
      }
      return Response.json({
        groupDid: GROUP_DID,
        operationId: body.operationId,
        mode: "coordinated",
        targetEndpoint: TARGET_ORIGIN,
        targetServiceDid: TARGET_SERVICE_DID,
        deadlineAtMs: nowFn() + 7_200_000,
        manifestDigest: "sha256:abc",
        migrationTicket: "v1.ticket-uuid-123.secret_token_xyz",
      });
    }
    if (url.pathname === "/group-admin/abort-migration") {
      sourceAbortAttempts += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      sourceAborts.push(body);
      if (options.sourceAbortImpl) {
        return options.sourceAbortImpl(body, sourceAbortAttempts);
      }
      return Response.json({ status: "aborted" });
    }
    if (url.pathname === "/xrpc/com.atproto.server.getServiceAuth") {
      return Response.json({ token: "service-create-jwt" });
    }
    if (url.pathname === "/xrpc/com.atproto.sync.getRepo") {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "application/vnd.ipld.car" },
      });
    }
    if (url.pathname === "/xrpc/com.atproto.sync.listBlobs") {
      return Response.json({ cids: ["bafkreitestblob"] });
    }
    if (url.pathname === "/xrpc/com.atproto.sync.getBlob") {
      return new Response(new Uint8Array([9, 8, 7]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }
    if (url.pathname === "/xrpc/com.atproto.space.listSpaces") {
      return Response.json({ spaces: [{ space: groupMetaUri(GROUP_DID) }, { space: groupMembersUri(GROUP_DID) }] });
    }
    if (url.pathname === "/xrpc/com.atproto.space.exportSpaceMeta") {
      return new Response(new Uint8Array([4, 5, 6]), {
        status: 200,
        headers: { "content-type": "application/vnd.dasl.star" },
      });
    }
    if (url.pathname === "/xrpc/com.atproto.space.getRepo") {
      return new Response(new Uint8Array([7, 8, 9]), {
        status: 200,
        headers: { "content-type": "application/vnd.dasl.star" },
      });
    }
    if (url.pathname === "/xrpc/com.atproto.identity.requestPlcOperationSignature") {
      return Response.json({});
    }
    if (url.pathname === "/group-admin/claim-action-token") {
      claimPlcTokenAttempts += 1;
      return Response.json({ token: `plc-step-up-token-${claimPlcTokenAttempts}`, expiresAt: "2026-11-22T00:00:00.000Z" });
    }
    if (url.pathname === "/xrpc/com.atproto.identity.signPlcOperation") {
      signPlcAttempts += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      signPlcBodies.push(body);
      if (options.signPlcImpl) {
        return options.signPlcImpl(body, signPlcAttempts);
      }
      return Response.json({ operation: { type: "plc_operation", sig: "signed" } });
    }
    return Response.json({ error: "NotFound", message: url.pathname }, { status: 404 });
  };

  const fetchEndpoint = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const authHeader = request.headers.get("authorization");
    const rawBody = request.method === "POST" ? await request.clone().text() : "";

    if (url.pathname === "/.well-known/did.json") {
      const interceptedDid = options.onTargetRequest?.(url, request.method, authHeader, rawBody) ?? null;
      if (interceptedDid) return interceptedDid;
      return Response.json({
        id: TARGET_SERVICE_DID,
        service: [
          { id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: TARGET_ORIGIN },
          { id: "#opensocial_group", type: "OpenSocialGroupHost", serviceEndpoint: TARGET_ORIGIN },
        ],
      });
    }
    if (url.pathname === "/xrpc/com.atproto.server.describeServer") {
      const interceptedDesc = options.onTargetRequest?.(url, request.method, authHeader, rawBody) ?? null;
      if (interceptedDesc) return interceptedDesc;
      return Response.json({ did: TARGET_SERVICE_DID });
    }
    if (url.pathname === "/xrpc/com.atproto.server.createAccount") {
      createAccountAttempts += 1;
      createAccountHeaders.push(Object.fromEntries(request.headers.entries()));
      const interceptedCreate = options.onTargetRequest?.(url, request.method, authHeader, rawBody) ?? null;
      if (interceptedCreate) return interceptedCreate;
      const tokens = options.createAccountTokens?.() ?? {
        accessJwt: makeJwtWithExp(Math.floor(nowFn() / 1000) + 900, "initial"),
        refreshJwt: "refresh-jwt-1",
      };
      return Response.json({
        did: GROUP_DID,
        handle: "team.groups2.example.com",
        ...tokens,
      });
    }
    if (url.pathname === "/xrpc/com.atproto.server.refreshSession") {
      refreshCalls.push(authHeader);
      const next = options.refreshSessionImpl?.(authHeader) ?? {
        accessJwt: makeJwtWithExp(Math.floor(nowFn() / 1000) + 900, `refreshed-${refreshCalls.length}`),
        refreshJwt: `refresh-jwt-${refreshCalls.length + 1}`,
      };
      return Response.json(next);
    }
    if (url.pathname === "/group-admin/abort-migration") {
      targetAborts.push({ authHeader, body: JSON.parse(rawBody || "{}") as Record<string, unknown> });
      const interceptedAbort = options.onTargetRequest?.(url, request.method, authHeader, rawBody) ?? null;
      if (interceptedAbort) return interceptedAbort;
      return Response.json({ status: "purged" });
    }

    if (url.pathname === "/xrpc/com.atproto.repo.importRepo") {
      importRepoAttempts += 1;
    }
    if (url.pathname === "/xrpc/com.atproto.identity.submitPlcOperation") {
      submitPlcAttempts += 1;
      submitPlcBodies.push(JSON.parse(rawBody || "{}") as Record<string, unknown>);
    }
    if (url.pathname === "/xrpc/com.atproto.server.activateAccount") {
      activateAccountAttempts += 1;
    }

    const intercepted = options.onTargetRequest?.(url, request.method, authHeader, rawBody) ?? null;
    if (intercepted) return intercepted;

    targetAuthHeaders.push({ path: url.pathname, authHeader });
    if (url.pathname === "/xrpc/com.atproto.identity.getRecommendedDidCredentials") {
      return Response.json({
        rotationKeys: ["did:key:zRot"],
        alsoKnownAs: ["at://team.groups2.example.com"],
        verificationMethods: { atproto: "did:key:zSig" },
        services: { atproto_pds: { type: "AtprotoPersonalDataServer", endpoint: TARGET_ORIGIN } },
      });
    }
    return Response.json({});
  };

  return {
    fetchHandler,
    fetchEndpoint,
    prepareBodies,
    sourceAborts,
    signPlcBodies,
    submitPlcBodies,
    targetAborts,
    targetAuthHeaders,
    createAccountHeaders,
    refreshCalls,
    counts: () => ({
      prepareAttempts,
      createAccountAttempts,
      importRepoAttempts,
      signPlcAttempts,
      submitPlcAttempts,
      activateAccountAttempts,
      claimPlcTokenAttempts,
    }),
    nowFn,
  };
}

test("GroupClient.getPublicMeta reads live meta/self publicRead without assuming true", async () => {
  let publicRead = false;
  const client = new GroupClient({
    groupDid: GROUP_DID,
    fetchHandler: async () => Response.json({ space: groupMetaUri(GROUP_DID), policy: { publicRead } }),
  });
  assert.equal(await client.getPublicMeta(), false);
  publicRead = true;
  assert.equal(await client.getPublicMeta(), true);
});

test("GroupClient.setPublicMeta serializes concurrent toggles, skips redundant writes on atomic hosts, and restores consistent invariants via CAS + rollback on third-party hosts", async () => {
  let publicRead = false;
  let hasDeclaration = true;
  let autoCoupleDeclaration = false;
  let failUpdateSpaceOnRollback = false;
  let failPutDeclaration = false;
  let failDeleteDeclaration = false;
  let mutationDelayMs = 0;
  const operations: string[] = [];
  const putSwapRecords: Array<unknown> = [];
  const deleteSwapRecords: Array<unknown> = [];

  const fetchHandler = async (path: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(path, "https://groups1.example.com");
    if (mutationDelayMs > 0 && init?.method === "POST") {
      await new Promise((r) => setTimeout(r, mutationDelayMs));
    }
    if (url.pathname === "/xrpc/com.atproto.space.getSpace") {
      return Response.json({ space: groupMetaUri(GROUP_DID), policy: { publicRead } });
    }
    if (url.pathname === "/xrpc/com.atproto.repo.getRecord") {
      if (!hasDeclaration) {
        return Response.json({ error: "RecordNotFound", message: "not found" }, { status: 400 });
      }
      return Response.json({
        uri: `at://${GROUP_DID}/group.opensocial.declaration/self`,
        cid: "bafyreidecl",
        value: { $type: "group.opensocial.declaration", meta: groupMetaUri(GROUP_DID) },
      });
    }
    if (url.pathname === "/xrpc/com.atproto.repo.deleteRecord") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      deleteSwapRecords.push(body.swapRecord);
      operations.push("deleteDeclaration");
      if (failDeleteDeclaration) {
        return Response.json({ error: "InternalServerError", message: "declaration delete failed" }, { status: 500 });
      }
      hasDeclaration = false;
      return Response.json({});
    }
    if (url.pathname === "/xrpc/com.atproto.repo.putRecord") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      putSwapRecords.push(body.swapRecord);
      operations.push("putDeclaration");
      if (failPutDeclaration) {
        return Response.json({ error: "InternalServerError", message: "declaration write failed" }, { status: 500 });
      }
      hasDeclaration = true;
      return Response.json({ uri: `at://${GROUP_DID}/group.opensocial.declaration/self`, cid: "bafyreidecl" });
    }
    if (url.pathname === "/xrpc/com.atproto.space.updateSpace") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { policy: { publicRead: boolean } };
      operations.push(`updateSpace:${String(body.policy.publicRead)}`);
      if (failUpdateSpaceOnRollback && operations.length > 2) {
        return Response.json({ error: "InternalServerError", message: "rollback updateSpace failed" }, { status: 500 });
      }
      publicRead = body.policy.publicRead;
      if (autoCoupleDeclaration) {
        hasDeclaration = body.policy.publicRead;
      }
      return Response.json({});
    }
    return Response.json({ error: "NotFound" }, { status: 404 });
  };

  const client = new GroupClient({
    groupDid: GROUP_DID,
    fetchHandler,
  });

  // 1. Drift detected when publicRead=false while declaration/self still exists!
  assert.deepEqual(await client.getPublicMetaStatus(), {
    publicRead: false,
    hasDeclaration: true,
    consistent: false,
  });

  // Repairing `setPublicMeta(false)` on a non-auto-coupling host uses `swapRecord` CAS and restores consistent private state!
  operations.length = 0;
  deleteSwapRecords.length = 0;
  await client.setPublicMeta(false);
  assert.deepEqual(operations, ["updateSpace:false", "deleteDeclaration"]);
  assert.deepEqual(deleteSwapRecords, ["bafyreidecl"]);
  assert.deepEqual(await client.getPublicMetaStatus(), {
    publicRead: false,
    hasDeclaration: false,
    consistent: true,
  });

  // 2. Against a non-auto-coupling host, `putRecord(declaration/self)` failure during `setPublicMeta(true)`
  //    rolls back `updateSpace(false)` and restores the exact prior consistent invariant (`consistent: true`)!
  failPutDeclaration = true;
  operations.length = 0;
  putSwapRecords.length = 0;
  await assert.rejects(client.setPublicMeta(true), /declaration write failed/);
  assert.deepEqual(operations, ["updateSpace:true", "putDeclaration", "updateSpace:false"]);
  assert.deepEqual(putSwapRecords, [null]);
  assert.deepEqual(await client.getPublicMetaStatus(), {
    publicRead: false,
    hasDeclaration: false,
    consistent: true,
  });

  // Succeeding `setPublicMeta(true)` transitions cleanly to `publicRead: true, hasDeclaration: true, consistent: true`!
  failPutDeclaration = false;
  operations.length = 0;
  await client.setPublicMeta(true);
  assert.deepEqual(operations, ["updateSpace:true", "putDeclaration"]);
  assert.deepEqual(await client.getPublicMetaStatus(), {
    publicRead: true,
    hasDeclaration: true,
    consistent: true,
  });

  // 3. Against a non-auto-coupling host, `deleteRecord(declaration/self)` failure during `setPublicMeta(false)`
  //    rolls back `updateSpace(true)` and restores the exact prior consistent invariant (`publicRead: true, hasDeclaration: true, consistent: true`)!
  failDeleteDeclaration = true;
  operations.length = 0;
  await assert.rejects(client.setPublicMeta(false), /declaration delete failed/);
  assert.deepEqual(operations, ["updateSpace:false", "deleteDeclaration", "updateSpace:true"]);
  assert.deepEqual(await client.getPublicMetaStatus(), {
    publicRead: true,
    hasDeclaration: true,
    consistent: true,
  });

  // If rollback ITSELF also fails, throws `PublicMetaReconciliationError` exposing `consistent: false`!
  failUpdateSpaceOnRollback = true;
  operations.length = 0;
  await assert.rejects(
    client.setPublicMeta(false),
    (err: unknown) => err instanceof PublicMetaReconciliationError && err.consistent === false,
  );
  failUpdateSpaceOnRollback = false;
  failDeleteDeclaration = false;
  await client.setPublicMeta(false);
  assert.deepEqual(await client.getPublicMetaStatus(), {
    publicRead: false,
    hasDeclaration: false,
    consistent: true,
  });

  // 4. Against Flock GroupHost / FakeNetwork (`autoCoupleDeclaration = true`), zero extra `putRecord`/`deleteRecord` round-trips occur!
  autoCoupleDeclaration = true;
  operations.length = 0;
  await client.setPublicMeta(true);
  await client.setPublicMeta(false);
  assert.deepEqual(operations, ["updateSpace:true", "updateSpace:false"]);

  // 5. Concurrent `Promise.all([client.setPublicMeta(true), client.setPublicMeta(false)])` (even against a slow non-auto-coupling host
  //    and across two separate `GroupClient` instances for the same `groupDid`) NEVER interleaves and ALWAYS finishes consistent!
  autoCoupleDeclaration = false;
  mutationDelayMs = 5;
  operations.length = 0;
  const secondClient = new GroupClient({ groupDid: GROUP_DID, fetchHandler });

  await Promise.all([client.setPublicMeta(true), secondClient.setPublicMeta(false)]);
  assert.deepEqual(operations, ["updateSpace:true", "putDeclaration", "updateSpace:false", "deleteDeclaration"]);
  assert.deepEqual(await client.getPublicMetaStatus(), {
    publicRead: false,
    hasDeclaration: false,
    consistent: true,
  });

  operations.length = 0;
  await Promise.all([secondClient.setPublicMeta(false), client.setPublicMeta(true)]);
  assert.deepEqual(await client.getPublicMetaStatus(), {
    publicRead: true,
    hasDeclaration: true,
    consistent: true,
  });
});

test("GroupClient.setPublicMeta restores consistent invariants across unserialized multi-machine races on third-party hosts", async () => {
  let publicRead = false;
  let declarationCid: string | null = null;
  let cidSeq = 0;

  let pauseClientABeforePut = false;
  let notifyClientAPausedBeforePut!: () => void;
  const clientAPausedBeforePut = new Promise<void>((resolve) => {
    notifyClientAPausedBeforePut = resolve;
  });
  let releaseClientAPut!: () => void;
  const clientAPutGate = new Promise<void>((resolve) => {
    releaseClientAPut = resolve;
  });

  let pauseClientBBeforeDelete = false;
  let notifyClientBPausedBeforeDelete!: () => void;
  const clientBPausedBeforeDelete = new Promise<void>((resolve) => {
    notifyClientBPausedBeforeDelete = resolve;
  });
  let releaseClientBDelete!: () => void;
  const clientBDeleteGate = new Promise<void>((resolve) => {
    releaseClientBDelete = resolve;
  });

  const makeHandler = (actor: "A" | "B") => async (path: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(path, "https://thirdparty-host.example.com");
    if (url.pathname === "/xrpc/com.atproto.space.getSpace") {
      return Response.json({ space: groupMetaUri(GROUP_DID), policy: { publicRead } });
    }
    if (url.pathname === "/xrpc/com.atproto.repo.getRecord") {
      if (declarationCid === null) {
        return Response.json({ error: "RecordNotFound", message: "not found" }, { status: 400 });
      }
      return Response.json({
        uri: `at://${GROUP_DID}/group.opensocial.declaration/self`,
        cid: declarationCid,
        value: { $type: "group.opensocial.declaration", meta: groupMetaUri(GROUP_DID) },
      });
    }
    if (url.pathname === "/xrpc/com.atproto.space.updateSpace") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { policy: { publicRead: boolean } };
      publicRead = body.policy.publicRead;
      return Response.json({});
    }
    if (url.pathname === "/xrpc/com.atproto.repo.putRecord") {
      if (actor === "A" && pauseClientABeforePut) {
        pauseClientABeforePut = false;
        notifyClientAPausedBeforePut();
        await clientAPutGate;
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { swapRecord?: string | null };
      if (body.swapRecord !== undefined && body.swapRecord !== declarationCid) {
        return Response.json({ error: "InvalidSwap", message: "record cid mismatch" }, { status: 400 });
      }
      declarationCid = `bafyreidecl-${++cidSeq}`;
      return Response.json({ uri: `at://${GROUP_DID}/group.opensocial.declaration/self`, cid: declarationCid });
    }
    if (url.pathname === "/xrpc/com.atproto.repo.deleteRecord") {
      if (actor === "B" && pauseClientBBeforeDelete) {
        pauseClientBBeforeDelete = false;
        notifyClientBPausedBeforeDelete();
        await clientBDeleteGate;
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { swapRecord?: string };
      if (declarationCid === null) {
        return Response.json({ error: "RecordNotFound", message: "not found" }, { status: 400 });
      }
      if (body.swapRecord !== undefined && body.swapRecord !== declarationCid) {
        return Response.json({ error: "InvalidSwap", message: "record cid mismatch" }, { status: 400 });
      }
      declarationCid = null;
      return Response.json({});
    }
    return Response.json({ error: "NotFound" }, { status: 404 });
  };

  // Independent `withGroupLock` callbacks simulate two separate browsers / machines with zero shared local lock!
  const clientA = new GroupClient({
    groupDid: GROUP_DID,
    fetchHandler: makeHandler("A"),
    withGroupLock: (_did, fn) => fn(),
  });
  const clientB = new GroupClient({
    groupDid: GROUP_DID,
    fetchHandler: makeHandler("B"),
    withGroupLock: (_did, fn) => fn(),
  });

  // 1. Codex Round 5 Finding #1 exact interleaving starting from `(publicRead: false, hasDeclaration: false)`:
  //    - Client A (`setPublicMeta(true)`) sets `publicRead = true`, inspects `(true, false)`, and pauses right before `putRecord`.
  //    - Client B (`setPublicMeta(false)`) sets `publicRead = false`, sees `hasDeclaration = false`, and returns cleanly.
  //    - Client A resumes `putRecord(swapRecord: null)` -> creates declaration -> detects `(false, true)` -> deletes dangling declaration
  //      and rejects with `PublicMetaReconciliationError` (`consistent === true`), leaving server at `(false, false, consistent: true)`!
  pauseClientABeforePut = true;
  const enableRacePromise = clientA.setPublicMeta(true);
  await clientAPausedBeforePut;
  assert.equal(publicRead, true);
  assert.equal(declarationCid, null);

  await clientB.setPublicMeta(false);
  assert.equal(publicRead, false);
  assert.equal(declarationCid, null);

  releaseClientAPut();
  await assert.rejects(
    enableRacePromise,
    (err: unknown) => err instanceof PublicMetaReconciliationError && err.consistent === true,
  );
  assert.deepEqual(await clientA.getPublicMetaStatus(), {
    publicRead: false,
    hasDeclaration: false,
    consistent: true,
  });

  // 2. Mirror race starting from `(publicRead: true, hasDeclaration: true)`:
  //    - Client B (`setPublicMeta(false)`) sets `publicRead = false`, inspects `(false, true)`, and pauses before `deleteRecord`.
  //    - Client A (`setPublicMeta(true)`) sets `publicRead = true`, sees `hasDeclaration = true`, and returns cleanly.
  //    - Client B resumes `deleteRecord` -> detects `(true, false)` -> restores `declaration/self` and rejects with
  //      `PublicMetaReconciliationError` (`consistent === true`), leaving server at `(true, true, consistent: true)`!
  await clientA.setPublicMeta(true);
  assert.deepEqual(await clientA.getPublicMetaStatus(), {
    publicRead: true,
    hasDeclaration: true,
    consistent: true,
  });

  pauseClientBBeforeDelete = true;
  const disableRacePromise = clientB.setPublicMeta(false);
  await clientBPausedBeforeDelete;
  assert.equal(publicRead, false);
  assert.notEqual(declarationCid, null);

  await clientA.setPublicMeta(true);
  assert.equal(publicRead, true);
  assert.notEqual(declarationCid, null);

  releaseClientBDelete();
  await assert.rejects(
    disableRacePromise,
    (err: unknown) => err instanceof PublicMetaReconciliationError && err.consistent === true,
  );
  assert.deepEqual(await clientB.getPublicMetaStatus(), {
    publicRead: true,
    hasDeclaration: true,
    consistent: true,
  });
});

test("GroupClient.createInvite omits nonstandard group field and listInviteDeliveries supports cursor pagination", async () => {
  const inviteeDid = "did:plc:inviteeaaaaaaaaaaaaaaa12";
  const putBodies: Array<Record<string, unknown>> = [];
  const deliveryPaths: string[] = [];

  const client = new GroupClient({
    groupDid: GROUP_DID,
    now: () => 1_700_000_000_000,
    fetchHandler: async (path, init) => {
      const url = new URL(path, "https://groups1.example.com");
      if (url.pathname === "/xrpc/com.atproto.space.putRecord") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        putBodies.push(body);
        return Response.json({ uri: `${String(body.space)}/${GROUP_DID}/group.opensocial.invite/${String(body.rkey)}` });
      }
      if (url.pathname === "/group-admin/invite-deliveries") {
        deliveryPaths.push(`${url.pathname}${url.search}`);
        return Response.json({ deliveries: [], cursor: "next-deliv-cursor" });
      }
      return Response.json({ error: "NotFound" }, { status: 404 });
    },
  });

  await client.createInvite(inviteeDid, { message: "Welcome aboard!", expiresAt: "2027-01-01T00:00:00.000Z" });
  assert.equal(putBodies.length, 1);
  const writtenRecord = putBodies[0]!.record as Record<string, unknown>;
  assert.equal("group" in writtenRecord, false, "createInvite must omit nonstandard group property");
  assert.equal(writtenRecord.message, "Welcome aboard!");
  assert.equal(writtenRecord.expiresAt, "2027-01-01T00:00:00.000Z");

  const page = await client.listInviteDeliveries({ limit: 25, cursor: "cur-1" });
  assert.equal(page.cursor, "next-deliv-cursor");
  assert.equal(
    deliveryPaths[0],
    `/group-admin/invite-deliveries?group=${encodeURIComponent(GROUP_DID)}&limit=25&cursor=cur-1`,
  );
});

test("migrateToHost reuses persisted operationId across lost prepare-migration responses and clears on deterministic 4xx", async () => {
  clearDefaultMigrationStateForTest();
  const stateMap = new Map<string, InFlightGroupMigration>();
  const harness = createMockMigrationHarness({
    prepareImpl: (body, attempt) => {
      if (attempt === 1) {
        throw new TypeError("fetch failed: lost response after source lease committed");
      }
      return Response.json({
        groupDid: GROUP_DID,
        operationId: body.operationId,
        mode: "coordinated",
        targetEndpoint: TARGET_ORIGIN,
        targetServiceDid: TARGET_SERVICE_DID,
        deadlineAtMs: harness.nowFn() + 7_200_000,
        manifestDigest: "sha256:abc",
        migrationTicket: "v1.ticket-reuse-1.secret_xyz",
      });
    },
  });

  const client1 = new GroupClient({
    groupDid: GROUP_DID,
    fetchHandler: harness.fetchHandler,
    fetchEndpoint: harness.fetchEndpoint,
    migrationState: stateMap,
    now: harness.nowFn,
  });

  await assert.rejects(
    client1.migrateToHost(TARGET_ORIGIN, { handle: "team.groups2.example.com", mode: "auto" }),
    /lost response/,
  );
  assert.equal(harness.prepareBodies.length, 1);
  const firstOpId = String(harness.prepareBodies[0]!.operationId);
  assert.equal(stateMap.get(GROUP_DID)?.operationId, firstOpId);

  // A new GroupClient instance sharing `stateMap` retries with a later clock and reuses the EXACT SAME operationId!
  const client2 = new GroupClient({
    groupDid: GROUP_DID,
    fetchHandler: harness.fetchHandler,
    fetchEndpoint: harness.fetchEndpoint,
    migrationState: stateMap,
    now: () => harness.nowFn() + 5_000,
  });
  const res = await client2.migrateToHost(TARGET_ORIGIN, { handle: "team.groups2.example.com", mode: "auto" });
  assert.equal(res.mode, "coordinated");
  assert.equal(harness.prepareBodies.length, 2);
  assert.equal(harness.prepareBodies[1]!.operationId, firstOpId, "retry reuses persisted operationId");
  assert.equal(stateMap.get(GROUP_DID), undefined, "completed migration clears persisted state");

  // Deterministic 400 preflight error clears persisted state so the next attempt gets a fresh operationId.
  const preflightHarness = createMockMigrationHarness({
    prepareImpl: () =>
      Response.json({ error: "TargetMigrationLimitExceeded", message: "blob too large" }, { status: 400 }),
  });
  const preflightClient = new GroupClient({
    groupDid: GROUP_DID,
    fetchHandler: preflightHarness.fetchHandler,
    fetchEndpoint: preflightHarness.fetchEndpoint,
    migrationState: stateMap,
    now: preflightHarness.nowFn,
  });
  await assert.rejects(
    preflightClient.migrateToHost(TARGET_ORIGIN, { handle: "team.groups2.example.com" }),
    (err: unknown) => err instanceof XrpcError && err.code === "TargetMigrationLimitExceeded",
  );
  assert.equal(stateMap.get(GROUP_DID), undefined, "400 preflight failure clears migration state");
});

test("migrateToHost refreshes accessJwt proactively within 120s of expiry and reactively on 401 ExpiredToken", async () => {
  clearDefaultMigrationStateForTest();
  const nowMs = 1_700_000_000_000;
  let expiredOnce = false;

  const harness = createMockMigrationHarness({
    now: () => nowMs,
    createAccountTokens: () => ({
      // Expires in 90s (< 120s lead window) -> must proactively refresh before first target staging call!
      accessJwt: makeJwtWithExp(Math.floor(nowMs / 1000) + 90, "initial-short"),
      refreshJwt: "refresh-initial",
    }),
    refreshSessionImpl: (authHeader) => {
      if (authHeader === "Bearer refresh-initial") {
        return {
          accessJwt: makeJwtWithExp(Math.floor(nowMs / 1000) + 900, "access-after-proactive"),
          refreshJwt: "refresh-rotated-2",
        };
      }
      return {
        accessJwt: makeJwtWithExp(Math.floor(nowMs / 1000) + 900, "access-after-401"),
        refreshJwt: "refresh-rotated-3",
      };
    },
    onTargetRequest: (url, _method, authHeader) => {
      if (url.pathname === "/xrpc/com.atproto.repo.uploadBlob" && !expiredOnce) {
        expiredOnce = true;
        assert.ok(authHeader?.includes("access-after-proactive") || authHeader?.startsWith("Bearer "));
        return Response.json({ error: "ExpiredToken", message: "token expired mid-staging" }, { status: 401 });
      }
      return null;
    },
  });

  const client = new GroupClient({
    groupDid: GROUP_DID,
    fetchHandler: harness.fetchHandler,
    fetchEndpoint: harness.fetchEndpoint,
    migrationState: new Map(),
    now: () => nowMs,
  });

  await client.migrateToHost(TARGET_ORIGIN, { handle: "team.groups2.example.com", mode: "coordinated" });
  assert.deepEqual(harness.refreshCalls, ["Bearer refresh-initial", "Bearer refresh-rotated-2"]);
  assert.equal(expiredOnce, true);
});

test("migrateToHost with mode: 'coordinated' sends mode to prepare-migration and throws if server downgrades to standard", async () => {
  clearDefaultMigrationStateForTest();
  const stateMap = new Map<string, InFlightGroupMigration>();
  const harness = createMockMigrationHarness({
    prepareImpl: (body) =>
      Response.json({
        groupDid: GROUP_DID,
        operationId: body.operationId,
        mode: "standard",
        targetEndpoint: TARGET_ORIGIN,
        targetServiceDid: TARGET_SERVICE_DID,
        deadlineAtMs: harness.nowFn() + 7_200_000,
        manifestDigest: "sha256:abc",
        migrationTicket: null,
      }),
  });

  const client = new GroupClient({
    groupDid: GROUP_DID,
    fetchHandler: harness.fetchHandler,
    fetchEndpoint: harness.fetchEndpoint,
    migrationState: stateMap,
    now: harness.nowFn,
  });

  await assert.rejects(
    client.migrateToHost(TARGET_ORIGIN, { handle: "team.groups2.example.com", mode: "coordinated" }),
    (err: unknown) => err instanceof XrpcError && err.code === "CoordinatedMigrationUnsupported",
  );
  assert.equal(harness.prepareBodies[0]?.mode, "coordinated");
  assert.equal(harness.sourceAborts.length, 1, "aborts source lease when explicit coordinated mode is downgraded");
  assert.equal(stateMap.get(GROUP_DID), undefined);
});

test("migrateToHost preserves state on transient 5xx staging failures and aborts both hosts on deterministic pre-PLC 4xx", async () => {
  clearDefaultMigrationStateForTest();
  const stateMap = new Map<string, InFlightGroupMigration>();
  let failTransient = true;
  const transientHarness = createMockMigrationHarness({
    onTargetRequest: (url) => {
      if (failTransient && url.pathname === "/xrpc/com.atproto.space.importSpaceMeta") {
        return Response.json({ error: "UpstreamFailure", message: "transient 500 during space meta import" }, { status: 500 });
      }
      return null;
    },
  });

  const transientClient = new GroupClient({
    groupDid: GROUP_DID,
    fetchHandler: transientHarness.fetchHandler,
    fetchEndpoint: transientHarness.fetchEndpoint,
    migrationState: stateMap,
    now: transientHarness.nowFn,
  });

  await assert.rejects(
    transientClient.migrateToHost(TARGET_ORIGIN, {
      handle: "team.groups2.example.com",
      operationId: "3lbltransient5",
      mode: "coordinated",
    }),
    /transient 500 during space meta import/,
  );
  assert.equal(transientHarness.targetAborts.length, 0, "transient 500 must NOT abort target staging");
  assert.equal(transientHarness.sourceAborts.length, 0, "transient 500 must NOT abort source lease");
  assert.equal(stateMap.get(GROUP_DID)?.phase, "account_created", "state remains at account_created for resume");

  // Retry resumes from account_created without re-running prepare-migration or createAccount!
  failTransient = false;
  await transientClient.migrateToHost(TARGET_ORIGIN, {
    handle: "team.groups2.example.com",
    mode: "coordinated",
  });
  assert.equal(transientHarness.counts().prepareAttempts, 1, "prepare-migration skipped on resume");
  assert.equal(transientHarness.counts().createAccountAttempts, 1, "createAccount skipped on resume");
  assert.equal(stateMap.get(GROUP_DID), undefined);

  // Deterministic 400 pre-PLC rejection aborts BOTH Target (operationId + ticketId) and Source (operationId), then deletes state.
  const detHarness = createMockMigrationHarness({
    onTargetRequest: (url) => {
      if (url.pathname === "/xrpc/com.atproto.space.importSpaceMeta") {
        return Response.json({ error: "InvalidSpaceArchive", message: "corrupt space meta archive" }, { status: 400 });
      }
      return null;
    },
  });

  const detClient = new GroupClient({
    groupDid: GROUP_DID,
    fetchHandler: detHarness.fetchHandler,
    fetchEndpoint: detHarness.fetchEndpoint,
    migrationState: stateMap,
    now: detHarness.nowFn,
  });

  await assert.rejects(
    detClient.migrateToHost(TARGET_ORIGIN, {
      handle: "team.groups2.example.com",
      operationId: "3lblrollback22",
      mode: "coordinated",
    }),
    /corrupt space meta archive/,
  );

  assert.equal(detHarness.targetAborts.length, 1);
  assert.ok(detHarness.targetAborts[0]!.authHeader?.startsWith("Bearer "));
  assert.deepEqual(detHarness.targetAborts[0]!.body, {
    group: GROUP_DID,
    operationId: "3lblrollback22",
    ticketId: "ticket-uuid-123",
  });
  assert.deepEqual(detHarness.sourceAborts, [{ group: GROUP_DID, operationId: "3lblrollback22" }]);
  assert.equal(stateMap.get(GROUP_DID), undefined);
});

test("migrateToHost resumes across signing_plc, plc_signed, and plc_submitted crash windows and never aborts post-cutover", async () => {
  clearDefaultMigrationStateForTest();
  const stateMap = new Map<string, InFlightGroupMigration>();
  let stage: "drop_sign" | "drop_submit" | "fail_activate" | "ok" = "drop_sign";

  const harness = createMockMigrationHarness({
    signPlcImpl: (body) => {
      if (stage === "drop_sign") {
        throw new TypeError("network drop after source committed plc_signed");
      }
      // Replayed response from Group Host when lease.status === 'plc_signed'
      return Response.json({
        operation: {
          type: "plc_operation",
          sig: "replayed-plc-sig",
          rotationKeys: body.rotationKeys,
        },
      });
    },
    onTargetRequest: (url) => {
      if (url.pathname === "/xrpc/com.atproto.identity.submitPlcOperation" && stage === "drop_submit") {
        throw new TypeError("network drop before submitPlcOperation response");
      }
      if (url.pathname === "/xrpc/com.atproto.server.activateAccount" && stage === "fail_activate") {
        return Response.json({ error: "UpstreamFailure", message: "activate failed transiently" }, { status: 503 });
      }
      return null;
    },
  });

  const makeClient = () =>
    new GroupClient({
      groupDid: GROUP_DID,
      fetchHandler: harness.fetchHandler,
      fetchEndpoint: harness.fetchEndpoint,
      migrationState: stateMap,
      now: harness.nowFn,
    });

  // 1. Crash during signPlcOperation -> state persisted at phase === "signing_plc" with plcToken + proposedPlcParams!
  await assert.rejects(
    makeClient().migrateToHost(TARGET_ORIGIN, { handle: "team.groups2.example.com", mode: "coordinated" }),
    /network drop after source committed plc_signed/,
  );
  const afterSignDrop = stateMap.get(GROUP_DID);
  assert.equal(afterSignDrop?.phase, "signing_plc");
  assert.equal(afterSignDrop?.plcToken, "plc-step-up-token-1");
  assert.deepEqual(afterSignDrop?.proposedPlcParams?.rotationKeys, ["did:key:zRot"]);
  assert.equal(harness.targetAborts.length, 0);
  assert.equal(harness.sourceAborts.length, 0);

  // Conflicting migration to another targetOrigin while in-progress fails closed with 409 MigrationInProgress!
  await assert.rejects(
    makeClient().migrateToHost("https://groups3.example.com", { handle: "team.groups3.example.com" }),
    (err: unknown) => err instanceof XrpcError && err.status === 409 && err.code === "MigrationInProgress",
  );
  assert.equal(stateMap.get(GROUP_DID)?.phase, "signing_plc", "conflicting call never overwrites in-progress state");

  // 2. Resume from "signing_plc", receive replayed signedPlcOp, then crash during submitPlcOperation -> phase === "plc_signed"!
  stage = "drop_submit";
  await assert.rejects(
    makeClient().migrateToHost(TARGET_ORIGIN, { handle: "team.groups2.example.com", mode: "coordinated" }),
    /network drop before submitPlcOperation response/,
  );
  const afterSubmitDrop = stateMap.get(GROUP_DID);
  assert.equal(afterSubmitDrop?.phase, "plc_signed");
  assert.deepEqual(afterSubmitDrop?.signedPlcOp, {
    type: "plc_operation",
    sig: "replayed-plc-sig",
    rotationKeys: ["did:key:zRot"],
  });
  assert.equal(harness.counts().prepareAttempts, 1, "did not re-run prepare-migration");
  assert.equal(harness.counts().createAccountAttempts, 1, "did not re-run createAccount");
  assert.equal(harness.counts().importRepoAttempts, 1, "did not re-run staging");
  assert.equal(harness.counts().claimPlcTokenAttempts, 1, "reused persisted plcToken");
  assert.equal(harness.signPlcBodies[1]?.token, "plc-step-up-token-1");

  // 3. Resume from "plc_signed" -> skips signPlcOperation completely, submits persisted signedPlcOp, persists "plc_submitted", then fails activateAccount!
  stage = "fail_activate";
  await assert.rejects(
    makeClient().migrateToHost(TARGET_ORIGIN, { handle: "team.groups2.example.com", mode: "coordinated" }),
    /activate failed transiently/,
  );
  assert.equal(stateMap.get(GROUP_DID)?.phase, "plc_submitted");
  assert.equal(harness.counts().signPlcAttempts, 2, "did not call signPlcOperation when resuming from plc_signed");
  assert.equal(harness.counts().submitPlcAttempts, 2);
  assert.deepEqual(harness.submitPlcBodies[1], {
    operation: {
      type: "plc_operation",
      sig: "replayed-plc-sig",
      rotationKeys: ["did:key:zRot"],
    },
  });
  assert.equal(harness.targetAborts.length, 0, "never aborts once plc_submitted");
  assert.equal(harness.sourceAborts.length, 0, "never aborts source once plc_submitted");

  // 4. Resume from "plc_submitted" -> skips straight to activateAccount and deletes stateStore ONLY after activateAccount succeeds!
  stage = "ok";
  const completed = await makeClient().migrateToHost(TARGET_ORIGIN, {
    handle: "team.groups2.example.com",
    mode: "coordinated",
  });
  assert.equal(completed.mode, "coordinated");
  assert.equal(completed.handle, "team.groups2.example.com");
  assert.equal(harness.counts().submitPlcAttempts, 2, "did not re-submit PLC operation when resuming from plc_submitted");
  assert.equal(harness.counts().activateAccountAttempts, 2);
  assert.equal(stateMap.get(GROUP_DID), undefined, "stateStore deleted after activateAccount succeeds");
});

test("migrateToHost in standard mode aborts both Target and Source with fenced operationId on pre-cutover 4xx and retains state if either abort fails", async () => {
  clearDefaultMigrationStateForTest();
  const stateMap = new Map<string, InFlightGroupMigration>();
  let sourceAbortShouldFail = true;

  const harness = createMockMigrationHarness({
    sourceAbortImpl: () => {
      if (sourceAbortShouldFail) {
        return Response.json({ error: "InternalServerError", message: "db busy" }, { status: 500 });
      }
      return Response.json({ status: "aborted" });
    },
    onTargetRequest: (url) => {
      if (url.pathname === "/xrpc/com.atproto.identity.submitPlcOperation") {
        return Response.json({ error: "InvalidPlcOperation", message: "bad rotation key" }, { status: 400 });
      }
      return null;
    },
  });

  const client = new GroupClient({
    groupDid: GROUP_DID,
    fetchHandler: harness.fetchHandler,
    fetchEndpoint: harness.fetchEndpoint,
    migrationState: stateMap,
    now: harness.nowFn,
  });

  // Attempt 1: Target abort succeeds (200), Source abort fails (500) -> stateStore MUST NOT be deleted!
  await assert.rejects(
    client.migrateToHost(TARGET_ORIGIN, {
      handle: "team.groups2.example.com",
      operationId: "3lblstdabort11",
      mode: "standard",
    }),
    (err: unknown) => err instanceof XrpcError && err.code === "InvalidPlcOperation",
  );
  assert.deepEqual(harness.targetAborts[0]?.body, {
    group: GROUP_DID,
    operationId: "3lblstdabort11",
  });
  assert.deepEqual(harness.sourceAborts[0], { group: GROUP_DID, operationId: "3lblstdabort11" });
  assert.equal(stateMap.get(GROUP_DID)?.phase, "plc_signed", "stateStore retained because source abort failed");

  // Attempt 2: Resumes from plc_signed, hits deterministic 400 again, and this time BOTH Target and Source aborts succeed -> stateStore deleted!
  sourceAbortShouldFail = false;
  await assert.rejects(
    client.migrateToHost(TARGET_ORIGIN, {
      handle: "team.groups2.example.com",
      mode: "standard",
    }),
    (err: unknown) => err instanceof XrpcError && err.code === "InvalidPlcOperation",
  );
  assert.equal(harness.targetAborts.length, 2);
  assert.deepEqual(harness.sourceAborts[1], { group: GROUP_DID, operationId: "3lblstdabort11" });
  assert.equal(stateMap.get(GROUP_DID), undefined, "stateStore deleted once both Target and Source aborts succeed");
});

test("migrateToHost rejects explicit operationId overrides whenever resumable state exists without overwriting or deleting it, until abortMigration unlocks it", async () => {
  clearDefaultMigrationStateForTest();
  const stateMap = new Map<string, InFlightGroupMigration>();
  let failCreateOnce = true;
  let failImportOnce = false;

  const harness = createMockMigrationHarness({
    onTargetRequest: (url) => {
      if (failCreateOnce && url.pathname === "/xrpc/com.atproto.server.createAccount") {
        return Response.json({ error: "UpstreamFailure", message: "transient 503 on createAccount" }, { status: 503 });
      }
      if (failImportOnce && url.pathname === "/xrpc/com.atproto.repo.importRepo") {
        return Response.json({ error: "UpstreamFailure", message: "transient 503 on importRepo" }, { status: 503 });
      }
      return null;
    },
  });

  const makeClient = () =>
    new GroupClient({
      groupDid: GROUP_DID,
      fetchHandler: harness.fetchHandler,
      fetchEndpoint: harness.fetchEndpoint,
      migrationState: stateMap,
      now: harness.nowFn,
    });

  // 1. Reach `prepared` phase with operationId `3lblorigop111` (createAccount fails transiently with 503)
  await assert.rejects(
    makeClient().migrateToHost(TARGET_ORIGIN, {
      handle: "team.groups2.example.com",
      operationId: "3lblorigop111",
      mode: "coordinated",
    }),
    /transient 503 on createAccount/,
  );
  const preparedSnapshot = structuredClone(stateMap.get(GROUP_DID));
  assert.equal(preparedSnapshot?.operationId, "3lblorigop111");
  assert.equal(preparedSnapshot?.phase, "prepared");
  assert.equal(preparedSnapshot?.ticketId, "ticket-uuid-123");
  assert.equal(harness.counts().prepareAttempts, 1);

  // Passing a DIFFERENT explicit operationId (`3lbloverride222`) MUST immediately throw 409 MigrationInProgress
  // BEFORE touching stateMap or calling prepareMigration!
  await assert.rejects(
    makeClient().migrateToHost(TARGET_ORIGIN, {
      handle: "team.groups2.example.com",
      operationId: "3lbloverride222",
      mode: "coordinated",
    }),
    (err: unknown) => err instanceof XrpcError && err.status === 409 && err.code === "MigrationInProgress",
  );
  assert.deepEqual(stateMap.get(GROUP_DID), preparedSnapshot, "prepared state preserved intact on operationId override");
  assert.equal(harness.counts().prepareAttempts, 1, "no competing prepareMigration sent");

  // 2. Advance `3lblorigop111` to `account_created` (importRepo fails transiently with 503)
  failCreateOnce = false;
  failImportOnce = true;
  await assert.rejects(
    makeClient().migrateToHost(TARGET_ORIGIN, {
      handle: "team.groups2.example.com",
      operationId: "3lblorigop111",
      mode: "coordinated",
    }),
    /transient 503 on importRepo/,
  );
  const accountCreatedSnapshot = structuredClone(stateMap.get(GROUP_DID));
  assert.equal(accountCreatedSnapshot?.operationId, "3lblorigop111");
  assert.equal(accountCreatedSnapshot?.phase, "account_created");
  assert.equal(typeof accountCreatedSnapshot?.accessJwt, "string");
  assert.equal(accountCreatedSnapshot?.refreshJwt, "refresh-jwt-1");

  // Passing a different operationId (`3lbloverride333`) in `account_created` ALSO throws 409 MigrationInProgress without touching tokens/ticket!
  await assert.rejects(
    makeClient().migrateToHost(TARGET_ORIGIN, {
      handle: "team.groups2.example.com",
      operationId: "3lbloverride333",
      mode: "coordinated",
    }),
    (err: unknown) => err instanceof XrpcError && err.status === 409 && err.code === "MigrationInProgress",
  );
  assert.deepEqual(
    stateMap.get(GROUP_DID),
    accountCreatedSnapshot,
    "account_created state (tokens + ticket) preserved intact on operationId override",
  );
  assert.equal(harness.targetAborts.length, 0);
  assert.equal(harness.sourceAborts.length, 0);

  // Calling abortMigration with an unrelated operationId does NOT delete `3lblorigop111` from stateStore!
  await makeClient().abortMigration("3lblunrelated999");
  assert.deepEqual(stateMap.get(GROUP_DID), accountCreatedSnapshot);

  // 3. Resuming the original `3lblorigop111` succeeds cleanly!
  failImportOnce = false;
  const resumedResult = await makeClient().migrateToHost(TARGET_ORIGIN, {
    handle: "team.groups2.example.com",
    operationId: "3lblorigop111",
    mode: "coordinated",
  });
  assert.equal(resumedResult.mode, "coordinated");
  assert.equal(stateMap.get(GROUP_DID), undefined);

  // 4. Start another migration `3lbltobeaborted` into `account_created`, call `abortMigration()` to abort Target + Source,
  //    and verify a brand-new `operationId` (`3lblfreshop444`) then succeeds cleanly!
  failImportOnce = true;
  await assert.rejects(
    makeClient().migrateToHost(TARGET_ORIGIN, {
      handle: "team.groups2.example.com",
      operationId: "3lbltobeaborted",
      mode: "coordinated",
    }),
    /transient 503 on importRepo/,
  );
  assert.equal(stateMap.get(GROUP_DID)?.operationId, "3lbltobeaborted");
  assert.equal(stateMap.get(GROUP_DID)?.phase, "account_created");

  const targetAbortsBefore = harness.targetAborts.length;
  const sourceAbortsBefore = harness.sourceAborts.length;
  await makeClient().abortMigration();
  assert.equal(harness.targetAborts.length, targetAbortsBefore + 1, "abortMigration aborts staged Target session");
  assert.deepEqual(harness.targetAborts.at(-1)?.body, {
    group: GROUP_DID,
    operationId: "3lbltobeaborted",
    ticketId: "ticket-uuid-123",
  });
  assert.equal(harness.sourceAborts.length, sourceAbortsBefore + 1, "abortMigration aborts Source lease");
  assert.deepEqual(harness.sourceAborts.at(-1), {
    group: GROUP_DID,
    operationId: "3lbltobeaborted",
  });
  assert.equal(stateMap.get(GROUP_DID), undefined, "abortMigration clears stateStore");

  failImportOnce = false;
  const freshResult = await makeClient().migrateToHost(TARGET_ORIGIN, {
    handle: "team.groups2.example.com",
    operationId: "3lblfreshop444",
    mode: "coordinated",
  });
  assert.equal(freshResult.mode, "coordinated");
  assert.equal(harness.prepareBodies.at(-1)?.operationId, "3lblfreshop444");
});

test("migrateToHost binds Standard and Coordinated createAccount calls with x-group-migration-operation-id and serializes concurrent multi-client migrations via CAS", async () => {
  clearDefaultMigrationStateForTest();
  const backingMap = new Map<string, InFlightGroupMigration>();
  const sharedStore = createInMemoryMigrationStateStore(backingMap);

  // 1. Direct CAS verification on `createInMemoryMigrationStateStore`: monotonic revision, no phase regression, conditional delete.
  const s1 = await sharedStore.compareAndSet(GROUP_DID, null, {
    operationId: "3lblcasop00001",
    targetOrigin: TARGET_ORIGIN,
    handle: "team.groups2.example.com",
    mode: "standard",
    ticketId: null,
    phase: "starting",
  });
  assert.equal(s1.revision, 1);

  await assert.rejects(
    sharedStore.compareAndSet(GROUP_DID, null, {
      operationId: "3lblcasop00002",
      targetOrigin: TARGET_ORIGIN,
      handle: "team.groups2.example.com",
      mode: "standard",
      ticketId: null,
      phase: "starting",
    }),
    (err: unknown) => err instanceof XrpcError && err.status === 409 && err.code === "MigrationInProgress",
  );

  const s2 = await sharedStore.compareAndSet(
    GROUP_DID,
    { operationId: "3lblcasop00001", revision: 1 },
    {
      ...s1,
      phase: "account_created",
      accessJwt: "jwt-1",
      refreshJwt: "ref-1",
    },
  );
  assert.equal(s2.revision, 2);

  // Stale revision rejects without overwriting!
  await assert.rejects(
    sharedStore.compareAndSet(
      GROUP_DID,
      { operationId: "3lblcasop00001", revision: 1 },
      { ...s2, phase: "staged" },
    ),
    (err: unknown) => err instanceof XrpcError && err.status === 409 && err.code === "MigrationInProgress",
  );
  // Phase regression rejects even with matching revision!
  await assert.rejects(
    sharedStore.compareAndSet(
      GROUP_DID,
      { operationId: "3lblcasop00001", revision: 2 },
      { ...s2, phase: "prepared" },
    ),
    (err: unknown) => err instanceof XrpcError && err.status === 409 && err.code === "MigrationInProgress",
  );
  assert.equal(await sharedStore.compareAndDelete(GROUP_DID, { operationId: "3lblcasop00001", revision: 1 }), false);
  assert.equal(await sharedStore.compareAndDelete(GROUP_DID, { operationId: "3lblcasop00001", revision: 2 }), true);
  assert.equal(await sharedStore.get(GROUP_DID), undefined);

  // 2. Two concurrent `GroupClient` instances sharing `sharedStore` serialize cleanly:
  //    Client A starts Standard migration (`3lblstdhdr0001`), sends `x-group-migration-operation-id`, rotates tokens,
  //    and fails transiently on `uploadBlob`; queued Client B resumes from Client A's exact rotated tokens without
  //    re-calling `createAccount` or stale-overwriting the journal!
  const nowMs = 1_700_000_000_000;
  let failFirstUploadBlob = true;
  const harness = createMockMigrationHarness({
    now: () => nowMs,
    createAccountTokens: () => ({
      accessJwt: makeJwtWithExp(Math.floor(nowMs / 1000) + 60, "short-lived-1"),
      refreshJwt: "refresh-tok-1",
    }),
    refreshSessionImpl: (authHeader) => {
      assert.equal(authHeader, "Bearer refresh-tok-1");
      return {
        accessJwt: makeJwtWithExp(Math.floor(nowMs / 1000) + 900, "rotated-tok-2"),
        refreshJwt: "refresh-tok-2",
      };
    },
    onTargetRequest: (url, _method, authHeader) => {
      if (url.pathname === "/xrpc/com.atproto.repo.uploadBlob" && failFirstUploadBlob) {
        failFirstUploadBlob = false;
        assert.ok(authHeader?.startsWith("Bearer "));
        return Response.json({ error: "UpstreamFailure", message: "transient 502 mid-staging" }, { status: 502 });
      }
      return null;
    },
  });

  const clientA = new GroupClient({
    groupDid: GROUP_DID,
    fetchHandler: harness.fetchHandler,
    fetchEndpoint: harness.fetchEndpoint,
    migrationState: sharedStore,
    now: () => nowMs,
  });
  const clientB = new GroupClient({
    groupDid: GROUP_DID,
    fetchHandler: harness.fetchHandler,
    fetchEndpoint: harness.fetchEndpoint,
    migrationState: sharedStore,
    now: () => nowMs,
  });

  const [resA, resB] = await Promise.allSettled([
    clientA.migrateToHost(TARGET_ORIGIN, {
      handle: "team.groups2.example.com",
      operationId: "3lblstdhdr0001",
      mode: "standard",
    }),
    clientB.migrateToHost(TARGET_ORIGIN, {
      handle: "team.groups2.example.com",
      mode: "standard",
    }),
  ]);

  assert.equal(resA.status, "rejected");
  assert.match(String(resA.reason), /transient 502 mid-staging/);
  assert.equal(resB.status, "fulfilled");
  assert.equal(resB.value.mode, "standard");

  // `createAccount` ran ONCE (never replayed by Client B!) and carried `x-group-migration-operation-id`!
  assert.equal(harness.counts().createAccountAttempts, 1);
  assert.equal(harness.createAccountHeaders[0]?.["x-group-migration-operation-id"], "3lblstdhdr0001");
  assert.equal(harness.refreshCalls.length, 1, "Client B reused rotated-tok-2 persisted via CAS by Client A");
  assert.equal(await sharedStore.get(GROUP_DID), undefined);
});

test("migrateToHost persists normalized handle & recoveryKey across lost createAccount responses, rejects conflicting overrides without deleting journal, and replays persisted recoveryKey when omitted on resume", async () => {
  clearDefaultMigrationStateForTest();
  const stateMap = new Map<string, InFlightGroupMigration>();
  const createAccountBodies: Array<Record<string, unknown>> = [];
  let committedTargetAccount: { handle: string; recoveryKey?: string } | null = null;
  let dropFirstCreateResponse = true;

  const harness = createMockMigrationHarness({
    onTargetRequest: (url, _method, _authHeader, rawBody) => {
      if (url.pathname === "/xrpc/com.atproto.server.createAccount") {
        const parsed = JSON.parse(rawBody || "{}") as { did: string; handle: string; recoveryKey?: string };
        createAccountBodies.push(parsed);
        if (!committedTargetAccount) {
          committedTargetAccount = {
            handle: parsed.handle,
            ...(parsed.recoveryKey !== undefined ? { recoveryKey: parsed.recoveryKey } : {}),
          };
        } else if (
          committedTargetAccount.handle !== parsed.handle ||
          committedTargetAccount.recoveryKey !== parsed.recoveryKey
        ) {
          return Response.json(
            { error: "MigrationInProgress", message: "Replay parameters do not match committed migration session." },
            { status: 409 },
          );
        }
        if (dropFirstCreateResponse) {
          dropFirstCreateResponse = false;
          throw new TypeError("network drop after target committed createAccount");
        }
      }
      return null;
    },
  });

  const makeClient = () =>
    new GroupClient({
      groupDid: GROUP_DID,
      fetchHandler: harness.fetchHandler,
      fetchEndpoint: harness.fetchEndpoint,
      migrationState: stateMap,
      now: harness.nowFn,
    });

  // 1. Initial call normalizes handle casing/whitespace, persists `recoveryKey`, commits on Target, and loses the HTTP response.
  await assert.rejects(
    makeClient().migrateToHost(TARGET_ORIGIN, {
      handle: "  Team.Groups2.Example.COM  ",
      recoveryKey: "did:key:zDnaPersistedRecoveryKey1",
      operationId: "3lblr6intent01",
      mode: "standard",
    }),
    /network drop after target committed createAccount/,
  );
  assert.equal(createAccountBodies.length, 1);
  assert.deepEqual(createAccountBodies[0], {
    did: GROUP_DID,
    handle: "team.groups2.example.com",
    recoveryKey: "did:key:zDnaPersistedRecoveryKey1",
  });
  const journalSnapshot = stateMap.get(GROUP_DID);
  assert.equal(journalSnapshot?.phase, "prepared");
  assert.equal(journalSnapshot?.handle, "team.groups2.example.com");
  assert.equal(journalSnapshot?.recoveryKey, "did:key:zDnaPersistedRecoveryKey1");

  // 2. Re-entering a DIFFERENT handle fails closed with 409 MigrationInProgress BEFORE any network request and WITHOUT deleting the journal!
  await assert.rejects(
    makeClient().migrateToHost(TARGET_ORIGIN, {
      handle: "other.groups2.example.com",
      mode: "standard",
    }),
    (err: unknown) => err instanceof XrpcError && err.status === 409 && err.code === "MigrationInProgress",
  );
  assert.equal(createAccountBodies.length, 1, "mismatched handle rejected before network call");
  assert.equal(harness.targetAborts.length, 0);
  assert.equal(harness.sourceAborts.length, 0);
  assert.deepEqual(stateMap.get(GROUP_DID), journalSnapshot, "journal preserved on mismatched handle");

  // 3. Explicitly passing a DIFFERENT recoveryKey (or empty string) ALSO fails closed before any network request without deleting the journal!
  await assert.rejects(
    makeClient().migrateToHost(TARGET_ORIGIN, {
      handle: "team.groups2.example.com",
      recoveryKey: "did:key:zDnaDifferentKey2",
      mode: "standard",
    }),
    (err: unknown) => err instanceof XrpcError && err.status === 409 && err.code === "MigrationInProgress",
  );
  assert.equal(createAccountBodies.length, 1, "mismatched recoveryKey rejected before network call");
  assert.deepEqual(stateMap.get(GROUP_DID), journalSnapshot, "journal preserved on mismatched recoveryKey");

  // 4. Resuming with matching handle (even mixed case) while OMITTING `recoveryKey` replays persisted `handle` + `recoveryKey` and completes!
  const completed = await makeClient().migrateToHost(TARGET_ORIGIN, {
    handle: "TEAM.Groups2.Example.Com",
    mode: "standard",
  });
  assert.equal(completed.mode, "standard");
  assert.equal(completed.handle, "team.groups2.example.com");
  assert.equal(createAccountBodies.length, 2);
  assert.deepEqual(createAccountBodies[1], {
    did: GROUP_DID,
    handle: "team.groups2.example.com",
    recoveryKey: "did:key:zDnaPersistedRecoveryKey1",
  });
  assert.equal(stateMap.get(GROUP_DID), undefined, "journal cleared after successful completion");
});

test("Round 16 Fix #2: migrateToHost persists pendingRefreshKey before refreshSession and recovers lost refresh responses without replaying old accessJwt", async () => {
  clearDefaultMigrationStateForTest();
  const stateMap = new Map<string, InFlightGroupMigration>();
  const nowMs = 1_700_000_000_000;
  let activeAccessSub = "initial";
  let activeRefreshJwt = "refresh-jwt-1";
  let lastGraceRefreshJwt: string | null = null;
  let lastGraceIdempotencyKey: string | null = null;
  let dropFirstRefreshResponse = true;
  let rejectInitialAccessAsExpired = true;
  const seenRefreshIdemKeys: Array<string | null> = [];

  const harness = createMockMigrationHarness({
    now: () => nowMs,
    createAccountTokens: () => ({
      // Expiration is 900s in the future (> 120s lead), so refresh is triggered by 401 ExpiredToken on importRepo!
      accessJwt: makeJwtWithExp(Math.floor(nowMs / 1000) + 900, "initial"),
      refreshJwt: "refresh-jwt-1",
    }),
  });

  const wrappedFetchEndpoint = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const auth = request.headers.get("authorization");
    if (url.pathname === "/xrpc/com.atproto.server.refreshSession") {
      const idemKey = request.headers.get("idempotency-key");
      seenRefreshIdemKeys.push(idemKey);
      const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
      if (token === activeRefreshJwt) {
        lastGraceRefreshJwt = activeRefreshJwt;
        lastGraceIdempotencyKey = idemKey;
        activeRefreshJwt = "refresh-jwt-2";
        activeAccessSub = "refreshed-1";
        if (dropFirstRefreshResponse) {
          dropFirstRefreshResponse = false;
          throw new TypeError("network drop after target committed refreshSession");
        }
        return Response.json({
          accessJwt: makeJwtWithExp(Math.floor(nowMs / 1000) + 900, activeAccessSub),
          refreshJwt: activeRefreshJwt,
        });
      }
      if (token === lastGraceRefreshJwt && idemKey && idemKey === lastGraceIdempotencyKey) {
        return Response.json({
          accessJwt: makeJwtWithExp(Math.floor(nowMs / 1000) + 900, activeAccessSub),
          refreshJwt: activeRefreshJwt,
        });
      }
      // Simulate Target replay purge if replayed without matching Idempotency-Key!
      return Response.json({ error: "InvalidToken", message: "Revoked migration token JTI replayed." }, { status: 401 });
    }

    if (url.pathname === "/xrpc/com.atproto.repo.importRepo") {
      const bearer = auth?.replace(/^Bearer\s+/i, "") ?? "";
      const payload = JSON.parse(Buffer.from(bearer.split(".")[1]!, "base64url").toString("utf8")) as { jti?: string };
      if (payload.jti === "initial") {
        if (rejectInitialAccessAsExpired) {
          rejectInitialAccessAsExpired = false;
          return Response.json({ error: "ExpiredToken", message: "Clock-skewed expired token" }, { status: 401 });
        }
        // If resumed client ever sent the old revoked `initial` accessJwt BEFORE finishing pending refresh, Target would 401 InvalidToken!
        return Response.json({ error: "InvalidToken", message: "Revoked old accessJwt sent before pending refresh!" }, { status: 401 });
      }
    }
    return harness.fetchEndpoint(request);
  };

  const makeClient = () =>
    new GroupClient({
      groupDid: GROUP_DID,
      fetchHandler: harness.fetchHandler,
      fetchEndpoint: wrappedFetchEndpoint,
      migrationState: stateMap,
      now: () => nowMs,
    });

  // 1. First run creates account, hits 401 ExpiredToken on importRepo, persists pendingRefreshKey, rotates on Target, and drops response!
  await assert.rejects(
    makeClient().migrateToHost(TARGET_ORIGIN, {
      handle: "team.groups2.example.com",
      operationId: "3lblr16ref0001",
      mode: "coordinated",
    }),
    /network drop after target committed refreshSession/,
  );
  const paused = stateMap.get(GROUP_DID);
  assert.equal(paused?.phase, "account_created");
  assert.equal(paused?.refreshJwt, "refresh-jwt-1");
  assert.match(paused?.pendingRefreshKey ?? "", /^migref-/);
  assert.equal(seenRefreshIdemKeys.length, 1);
  assert.equal(seenRefreshIdemKeys[0], paused?.pendingRefreshKey);

  // 2. Resume: even though `accessJwt` exp is >120s in the future, `hasPendingRefresh` forces `refreshTargetSession()` FIRST
  //    using the exact persisted `pendingRefreshKey`, recovers `refresh-jwt-2`, and completes migration without Target/Source abort!
  const finished = await makeClient().migrateToHost(TARGET_ORIGIN, {
    handle: "team.groups2.example.com",
    operationId: "3lblr16ref0001",
    mode: "coordinated",
  });
  assert.equal(finished.mode, "coordinated");
  assert.equal(seenRefreshIdemKeys.length, 2);
  assert.equal(seenRefreshIdemKeys[1], seenRefreshIdemKeys[0], "Retry MUST replay the exact persisted Idempotency-Key");
  assert.equal(harness.targetAborts.length, 0);
  assert.equal(harness.sourceAborts.length, 0);
  assert.equal(stateMap.get(GROUP_DID), undefined);

  // 3. Round 17 Fix #2: `abortMigration()` ALSO persists `pendingRefreshKey` before calling `refreshSession`
  //    and recovers cleanly across a dropped refresh response without failing Target or Source abort!
  activeRefreshJwt = "abort-refresh-1";
  activeAccessSub = "abort-initial";
  lastGraceRefreshJwt = null;
  lastGraceIdempotencyKey = null;
  let dropAbortRefreshOnce = true;
  let expireAbortAccessOnce = true;
  const abortRefreshIdemKeys: Array<string | null> = [];

  stateMap.set(GROUP_DID, {
    revision: 1,
    operationId: "3lblr17abort01",
    targetOrigin: TARGET_ORIGIN,
    handle: "team.groups2.example.com",
    mode: "coordinated",
    negotiatedMode: "coordinated",
    targetServiceDid: TARGET_SERVICE_DID,
    migrationTicket: "v1.ticket-uuid-123.secret_token_xyz",
    ticketId: "ticket-uuid-123",
    phase: "account_created",
    accessJwt: makeJwtWithExp(Math.floor(nowMs / 1000) + 900, "abort-initial"),
    refreshJwt: "abort-refresh-1",
  });

  const abortWrappedEndpoint = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const auth = request.headers.get("authorization");
    if (url.pathname === "/xrpc/com.atproto.server.refreshSession") {
      const idemKey = request.headers.get("idempotency-key");
      abortRefreshIdemKeys.push(idemKey);
      const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
      if (token === activeRefreshJwt) {
        lastGraceRefreshJwt = activeRefreshJwt;
        lastGraceIdempotencyKey = idemKey;
        activeRefreshJwt = "abort-refresh-2";
        activeAccessSub = "abort-refreshed";
        if (dropAbortRefreshOnce) {
          dropAbortRefreshOnce = false;
          throw new TypeError("network drop during abortMigration refreshSession");
        }
        return Response.json({
          accessJwt: makeJwtWithExp(Math.floor(nowMs / 1000) + 900, activeAccessSub),
          refreshJwt: activeRefreshJwt,
        });
      }
      if (token === lastGraceRefreshJwt && idemKey && idemKey === lastGraceIdempotencyKey) {
        return Response.json({
          accessJwt: makeJwtWithExp(Math.floor(nowMs / 1000) + 900, activeAccessSub),
          refreshJwt: activeRefreshJwt,
        });
      }
      return Response.json({ error: "InvalidToken", message: "Revoked migration token JTI replayed." }, { status: 401 });
    }
    if (url.pathname === "/group-admin/abort-migration") {
      const bearer = auth?.replace(/^Bearer\s+/i, "") ?? "";
      const payload = JSON.parse(Buffer.from(bearer.split(".")[1]!, "base64url").toString("utf8")) as { jti?: string };
      if (payload.jti === "abort-initial") {
        if (expireAbortAccessOnce) {
          expireAbortAccessOnce = false;
          return Response.json({ error: "ExpiredToken", message: "Access token expired" }, { status: 401 });
        }
        return Response.json({ error: "InvalidToken", message: "Revoked old accessJwt sent on abort!" }, { status: 401 });
      }
    }
    return harness.fetchEndpoint(request);
  };

  const makeAbortClient = () =>
    new GroupClient({
      groupDid: GROUP_DID,
      fetchHandler: harness.fetchHandler,
      fetchEndpoint: abortWrappedEndpoint,
      migrationState: createInMemoryMigrationStateStore(stateMap),
      now: () => nowMs,
    });

  await assert.rejects(
    makeAbortClient().abortMigration(),
    /network drop during abortMigration refreshSession/,
  );
  const pausedAbort = stateMap.get(GROUP_DID);
  assert.match(pausedAbort?.pendingRefreshKey ?? "", /^migref-/);
  assert.equal(abortRefreshIdemKeys.length, 1);
  assert.equal(abortRefreshIdemKeys[0], pausedAbort?.pendingRefreshKey);

  const abortDone = await makeAbortClient().abortMigration();
  assert.equal(abortDone.status, "aborted");
  assert.equal(harness.targetAborts.length, 1);
  assert.equal(harness.sourceAborts.length, 1);
  assert.equal(abortRefreshIdemKeys.length, 2);
  assert.equal(abortRefreshIdemKeys[1], abortRefreshIdemKeys[0]);
  assert.equal(stateMap.get(GROUP_DID), undefined);

  // 4. Round 18 Fix #1 & Round 19 Fix #1: Crash-idempotent Target abort after Target already purged `migration_session`
  //    using real unstubbed `FakeNetwork` scope enforcement (`groupAdminScopes()` WITHOUT `groupDid`) both BEFORE and AFTER `accessJwt` expiry!
  for (const expiredAfterPurge of [false, true] as const) {
    const srcNet = new FakeNetwork();
    let clockMs = 1_700_000_000_000;
    srcNet.now = () => clockMs;

    const adminDid = "did:plc:aliceabortparitya2222222";
    const grpDid = `did:plc:grpabortparitya22222222${expiredAfterPurge ? "b" : "a"}`;
    srcNet.createAccount(adminDid, "pds-alice");
    await srcNet.createGroupAccount(grpDid, {
      creatorDid: adminDid,
      name: "Abort Recovery Group",
      handle: "abort-rec.groups.test",
      joinPolicy: "invite",
      publicMeta: true,
    });
    const origHostEndpoint = (srcNet as unknown as { hostEndpointUrl: (slug: string) => string }).hostEndpointUrl.bind(srcNet);
    (srcNet as unknown as { hostEndpointUrl: (slug: string) => string }).hostEndpointUrl = (slug: string) =>
      slug === "group-host-2" ? TARGET_ORIGIN : origHostEndpoint(slug);
    const mapToFakeHost2 = (req: Request): Request => {
      const u = new URL(req.url);
      if (u.origin === TARGET_ORIGIN) {
        return new Request(`https://fake-pds.test/group-host-2${u.pathname}${u.search}`, req);
      }
      return req;
    };
    srcNet.outboundFetch = (req: Request) => srcNet.fetchEndpoint(mapToFakeHost2(req));

    // Browser-style OAuth session scope (`groupAdminScopes()` WITHOUT `groupDid`) — zero stubs!
    const browserAdminToken = srcNet.issueGroupSessionToken(grpDid, adminDid, {
      approvedScopes: groupAdminScopes(),
    });
    const srcBase = await srcNet.resolvePds(grpDid);
    const realStateMap = new Map<string, InFlightGroupMigration>();
    let dropTargetAbortResponseOnce = false;
    let stopAfterStage = true;

    const makeRealClient = () =>
      new GroupClient({
        groupDid: grpDid,
        fetchHandler: (path, init) =>
          srcNet.fetchEndpoint(
            new Request(`${srcBase}${path}`, {
              method: init?.method ?? "GET",
              headers: {
                ...(init?.headers as Record<string, string> | undefined),
                authorization: `Bearer ${browserAdminToken}`,
              },
              body: init?.body,
            }),
          ),
        fetchEndpoint: async (request: Request) => {
          const u = new URL(request.url);
          if (stopAfterStage && u.pathname === "/xrpc/com.atproto.repo.importRepo") {
            throw new TypeError("pause migration after createAccount staged");
          }
          const res = await srcNet.fetchEndpoint(mapToFakeHost2(request));
          if (dropTargetAbortResponseOnce && u.pathname === "/group-admin/abort-migration") {
            dropTargetAbortResponseOnce = false;
            throw new TypeError("lost HTTP response after Target committed abort purge");
          }
          return res;
        },
        migrationState: createInMemoryMigrationStateStore(realStateMap),
        now: () => clockMs,
      });

    await assert.rejects(
      makeRealClient().migrateToHost(TARGET_ORIGIN, {
        handle: "abort-rec-dst.groups.test",
        operationId: expiredAfterPurge ? "3lblr22abtexp" : "3lblr22abtliv",
      }),
      /pause migration after createAccount staged/,
    );
    stopAfterStage = false;
    assert.equal(realStateMap.get(grpDid)?.phase, "account_created");

    dropTargetAbortResponseOnce = true;
    await assert.rejects(
      makeRealClient().abortMigration(),
      /lost HTTP response after Target committed abort purge/,
    );
    assert.ok(realStateMap.get(grpDid), "journal remains until Source abort completes");

    if (expiredAfterPurge) {
      clockMs += 20 * 60_000;
    }

    const retryRes = await makeRealClient().abortMigration();
    assert.equal(retryRes.status, "aborted");
    assert.equal(realStateMap.get(grpDid), undefined);
  }
});

test("Round 27: Standard migration binds signPlcOperation and all source aborts to operationId so stale Device A cleanup cannot cancel Device B's newer lease", async () => {
  // 1. Unit check: `signPlcOperation` sends `x-group-migration-operation-id` and all 3 Standard abort paths
  //    (deterministic 4xx on createAccount, deterministic 4xx post-createAccount, and explicit abortMigration())
  //    ALWAYS pass the fenced `operationId` to Source `/group-admin/abort-migration` (never omitting it!).
  let capturedSignOpIdHeader: string | null = null;
  const capturedSourceAborts: Array<Record<string, unknown>> = [];
  let failCreate4xx = true;
  let failSubmit4xx = false;

  const baseFetchHandler = async (path: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(`https://src.group.test${path}`);
    if (url.pathname === "/group-admin/abort-migration") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      capturedSourceAborts.push(body);
      return Response.json({ status: "already_absent" });
    }
    if (url.pathname === "/xrpc/com.atproto.server.getServiceAuth") {
      return Response.json({ token: "svc-jwt" });
    }
    if (url.pathname === "/xrpc/com.atproto.sync.getRepo") {
      return new Response(new Uint8Array([1, 2]), { status: 200, headers: { "content-type": "application/vnd.ipld.car" } });
    }
    if (url.pathname === "/xrpc/com.atproto.sync.listBlobs") {
      return Response.json({ cids: [] });
    }
    if (url.pathname === "/xrpc/com.atproto.space.listSpaces") {
      return Response.json({ spaces: [] });
    }
    if (url.pathname === "/xrpc/com.atproto.identity.requestPlcOperationSignature") {
      return Response.json({});
    }
    if (url.pathname === "/group-admin/claim-action-token") {
      return Response.json({ token: "plc-tok-1", expiresAt: "2026-11-22T00:00:00.000Z" });
    }
    if (url.pathname === "/xrpc/com.atproto.identity.signPlcOperation") {
      capturedSignOpIdHeader = new Headers(init?.headers).get("x-group-migration-operation-id");
      return Response.json({ operation: { type: "plc_operation", sig: "signed-std" } });
    }
    return Response.json({ error: "NotFound" }, { status: 404 });
  };

  const baseFetchEndpoint = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === "/.well-known/did.json") {
      return Response.json({
        id: TARGET_SERVICE_DID,
        service: [
          { id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: TARGET_ORIGIN },
          { id: "#opensocial_group", type: "OpenSocialGroupHost", serviceEndpoint: TARGET_ORIGIN },
        ],
      });
    }
    if (url.pathname === "/xrpc/com.atproto.server.describeServer") {
      return Response.json({ did: TARGET_SERVICE_DID });
    }
    if (url.pathname === "/xrpc/com.atproto.server.createAccount") {
      if (failCreate4xx) {
        return Response.json({ error: "HandleNotAvailable", message: "taken" }, { status: 400 });
      }
      return Response.json({
        did: GROUP_DID,
        handle: "std-dst.groups.test",
        accessJwt: makeJwtWithExp(Math.floor(Date.now() / 1000) + 900, "std-a"),
        refreshJwt: "ref-std-a",
      });
    }
    if (url.pathname === "/xrpc/com.atproto.repo.importRepo") {
      return Response.json({});
    }
    if (url.pathname === "/xrpc/com.atproto.identity.getRecommendedDidCredentials") {
      return Response.json({
        rotationKeys: ["did:key:zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169"],
        alsoKnownAs: ["at://std-dst.groups.test"],
        verificationMethods: { atproto: "did:key:zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169" },
        services: { atproto_pds: { type: "AtprotoPersonalDataServer", endpoint: TARGET_ORIGIN } },
      });
    }
    if (url.pathname === "/xrpc/com.atproto.identity.submitPlcOperation") {
      if (failSubmit4xx) {
        return Response.json({ error: "InvalidPlcOp", message: "bad op" }, { status: 400 });
      }
      return Response.json({});
    }
    if (url.pathname === "/group-admin/abort-migration") {
      return Response.json({ status: "purged" });
    }
    return Response.json({});
  };

  // Path A: deterministic 4xx on createAccount sends fenced operationId
  const store1 = createInMemoryMigrationStateStore();
  const c1 = new GroupClient({
    groupDid: GROUP_DID,
    fetchHandler: baseFetchHandler,
    fetchEndpoint: baseFetchEndpoint,
    migrationState: store1,
  });
  await assert.rejects(
    c1.migrateToHost(TARGET_ORIGIN, { handle: "std-dst.groups.test", mode: "standard", operationId: "op-std-create4xx" }),
    /taken/,
  );
  assert.equal(capturedSourceAborts.at(-1)?.operationId, "op-std-create4xx");

  // Path B: deterministic 4xx post-createAccount (after signPlcOperation) sends x-group-migration-operation-id AND fenced operationId
  failCreate4xx = false;
  failSubmit4xx = true;
  const store2 = createInMemoryMigrationStateStore();
  const c2 = new GroupClient({
    groupDid: GROUP_DID,
    fetchHandler: baseFetchHandler,
    fetchEndpoint: baseFetchEndpoint,
    migrationState: store2,
  });
  await assert.rejects(
    c2.migrateToHost(TARGET_ORIGIN, { handle: "std-dst.groups.test", mode: "standard", operationId: "op-std-submit4xx" }),
    /bad op/,
  );
  assert.equal(capturedSignOpIdHeader, "op-std-submit4xx");
  assert.equal(capturedSourceAborts.at(-1)?.operationId, "op-std-submit4xx");

  // Path C: Real two-host FakeNetwork multi-device fencing — stale Device A Standard journal abort CANNOT cancel Device B's newer lease!
  const net = new FakeNetwork();
  const dstNet = new FakeNetwork();
  dstNet.shareHostServiceKeysWith(net);
  const adminDid = "did:plc:alicer27fencingaaaaaaaa2";
  const grpDid = "did:plc:grpr27fencingaaaaaaaaaa3";
  net.createAccount(adminDid, "pds-alice");
  await net.createGroupAccount(grpDid, {
    creatorDid: adminDid,
    name: "Fencing Group",
    handle: "fencing.groups.test",
    joinPolicy: "invite",
    publicMeta: true,
  });
  const origDstHostEndpoint = (dstNet as unknown as { hostEndpointUrl: (slug: string) => string }).hostEndpointUrl.bind(dstNet);
  (dstNet as unknown as { hostEndpointUrl: (slug: string) => string }).hostEndpointUrl = (slug: string) =>
    slug === "group-host-2" ? TARGET_ORIGIN : origDstHostEndpoint(slug);
  const origDstHostDid = (dstNet as unknown as { hostServiceDid: (slug: string) => string }).hostServiceDid.bind(dstNet);
  (dstNet as unknown as { hostServiceDid: (slug: string) => string }).hostServiceDid = (slug: string) =>
    slug === "group-host-2" ? TARGET_SERVICE_DID : origDstHostDid(slug);
  const mapTarget = (req: Request): Request => {
    const u = new URL(req.url);
    return u.origin === TARGET_ORIGIN
      ? new Request(`https://fake-pds.test/group-host-2${u.pathname}${u.search}`, req)
      : req;
  };
  const fetchDst = (req: Request): Promise<Response> => dstNet.fetchEndpoint(mapTarget(req));
  net.outboundFetch = (req: Request) => fetchDst(req);
  dstNet.outboundFetch = (req: Request) => net.fetchEndpoint(req);
  const adminToken = net.issueGroupSessionToken(grpDid, adminDid, { approvedScopes: groupAdminScopes() });
  const srcBase = await net.resolvePds(grpDid);
  const makeNetFetchHandler =
    () =>
    (path: string, init?: RequestInit): Promise<Response> =>
      net.fetchEndpoint(
        new Request(`${srcBase}${path}`, {
          method: init?.method ?? "GET",
          headers: {
            ...(init?.headers as Record<string, string> | undefined),
            authorization: `Bearer ${adminToken}`,
          },
          body: init?.body,
        }),
      );

  // Device B holds a newer active lease (`op-device-b-live`) on Source.
  const deviceB = new GroupClient({
    groupDid: grpDid,
    fetchHandler: makeNetFetchHandler(),
    fetchEndpoint: fetchDst,
  });
  const preparedB = await deviceB.prepareMigration(TARGET_ORIGIN, "op-device-b-live");
  assert.equal(preparedB.operationId, "op-device-b-live");

  // Sub-case 1 (Round 28 #1 + #2): Stale Device A at `phase: "prepared"` (no `accessJwt`) attempts `createAccount`
  // recovery during abort -> Source `public-group-keys` rejects mismatched `op-device-a-stale` with `409 MigrationInProgress`,
  // so Device A neither blocks Target nor cancels Device B's lease, and retains its journal!
  const deviceAUnprovenStore = createInMemoryMigrationStateStore(
    new Map([
      [
        grpDid,
        {
          operationId: "op-device-a-stale",
          targetOrigin: TARGET_ORIGIN,
          targetServiceDid: TARGET_SERVICE_DID,
          handle: "fencing-a.groups.test",
          recoveryKey: null,
          mode: "standard",
          negotiatedMode: "standard",
          ticketId: null,
          phase: "prepared",
        },
      ],
    ]),
  );
  const deviceAUnproven = new GroupClient({
    groupDid: grpDid,
    fetchHandler: makeNetFetchHandler(),
    fetchEndpoint: fetchDst,
    migrationState: deviceAUnprovenStore,
  });
  await assert.rejects(
    deviceAUnproven.abortMigration(),
    (err: unknown) => err instanceof XrpcError && err.status === 409 && err.code === "MigrationInProgress",
  );
  assert.ok(deviceAUnprovenStore.get(grpDid), "unproven Standard abort retains journal on 409 MigrationInProgress");

  // Sub-case 2: Stale Device A at `phase: "starting"` (never called createAccount) clears its journal with
  // fenced `operationId` -> Source returns `already_absent` without cancelling Device B's newer lease!
  const deviceAStore = createInMemoryMigrationStateStore(
    new Map([
      [
        grpDid,
        {
          operationId: "op-device-a-stale",
          targetOrigin: TARGET_ORIGIN,
          handle: "fencing-a.groups.test",
          recoveryKey: null,
          mode: "standard",
          ticketId: null,
          phase: "starting",
        },
      ],
    ]),
  );
  const deviceA = new GroupClient({
    groupDid: grpDid,
    fetchHandler: makeNetFetchHandler(),
    fetchEndpoint: fetchDst,
    migrationState: deviceAStore,
  });
  const abortARes = await deviceA.abortMigration();
  assert.equal(abortARes.status, "already_absent", "stale Device A Standard abort must NOT match Device B's newer lease");
  assert.equal(deviceAStore.get(grpDid), undefined, "stale Device A local journal is cleared");

  // Device B's lease MUST still be live on Source (proving Device A did not cancel it!)
  const abortBRes = await deviceB.abortMigration("op-device-b-live");
  assert.equal(abortBRes.status, "aborted", "Device B's newer lease must survive stale Device A Standard abort");

  // Path D (Round 28 #2): Unleased Standard `createAccount` commits on Target and drops the HTTP response,
  // leaving the journal at `phase: "prepared"` with NO `accessJwt`. `abortMigration()` MUST retain the journal
  // on transient recovery failure, then recover the Target bearer via idempotent `createAccount` replay,
  // purge Target staging cleanly, and clear the journal!
  const lostCreateStore = createInMemoryMigrationStateStore();
  let dropCreateOnce = true;
  let failRecoverOnce = false;
  const makeLostCreateClient = () =>
    new GroupClient({
      groupDid: grpDid,
      fetchHandler: makeNetFetchHandler(),
      fetchEndpoint: async (req: Request) => {
        const u = new URL(req.url);
        if (u.pathname === "/xrpc/com.atproto.server.createAccount") {
          if (failRecoverOnce) {
            failRecoverOnce = false;
            return Response.json({ error: "UpstreamUnavailable", message: "transient 503" }, { status: 503 });
          }
          const res = await fetchDst(req);
          if (dropCreateOnce) {
            dropCreateOnce = false;
            throw new TypeError("network drop after Target committed unleased Standard createAccount");
          }
          return res;
        }
        return fetchDst(req);
      },
      migrationState: lostCreateStore,
    });

  await assert.rejects(
    makeLostCreateClient().migrateToHost(TARGET_ORIGIN, {
      handle: "lost-create.groups.test",
      operationId: "op-r28-lost-create",
      mode: "standard",
    }),
    /network drop after Target committed unleased Standard createAccount/,
  );
  const lostSnapshot = await lostCreateStore.get(grpDid);
  assert.equal(lostSnapshot?.phase, "prepared");
  assert.equal(lostSnapshot?.accessJwt, undefined);

  // Transient failure during `abortMigration()` recovery retains the journal!
  failRecoverOnce = true;
  await assert.rejects(
    makeLostCreateClient().abortMigration(),
    (err: unknown) => err instanceof XrpcError && err.status === 503,
  );
  assert.ok(lostCreateStore.get(grpDid), "journal must be retained until Target cleanup is proven");

  // Retry `abortMigration()` recovers Target bearer via idempotent `createAccount` replay, purges Target, clears journal!
  const recoveredAbort = await makeLostCreateClient().abortMigration();
  assert.equal(recoveredAbort.status, "already_absent");
  assert.equal(lostCreateStore.get(grpDid), undefined, "journal cleared only after Target staging was purged");

  // Prove Target staging was genuinely purged (not abandoned!) by starting a fresh migration immediately:
  const freshPrep = await deviceB.prepareMigration(TARGET_ORIGIN, "op-r28-after-purge");
  assert.equal(freshPrep.operationId, "op-r28-after-purge");
  const { token: verifySvcJwt } = await new GroupClient({
    groupDid: grpDid,
    fetchHandler: makeNetFetchHandler(),
  }).xrpc.query<{ token: string }>("com.atproto.server.getServiceAuth", {
    aud: freshPrep.targetServiceDid,
    lxm: "com.atproto.server.createAccount",
  });
  const verifyStageRes = await fetchDst(
    new Request(`${TARGET_ORIGIN}/xrpc/com.atproto.server.createAccount`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${verifySvcJwt}`,
        "x-group-migration-operation-id": "op-r28-after-purge",
        ...(freshPrep.migrationTicket ? { "x-group-migration-ticket": freshPrep.migrationTicket } : {}),
      },
      body: JSON.stringify({ did: grpDid, handle: "after-purge.groups.test" }),
    }),
  );
  assert.equal(verifyStageRes.status, 200, "Target must accept a new migration immediately after unleased Standard abort purge");
  await deviceB.abortMigration("op-r28-after-purge");

  // Path E (Round 29 #2): Strict recovery & target abort acknowledgement validation!
  // 1. `createAccount` recovery returning `{ accessJwt }` WITHOUT `refreshJwt` rejects 502 and retains journal.
  const incompleteStore = createInMemoryMigrationStateStore(
    new Map([
      [
        GROUP_DID,
        {
          operationId: "op-r29-missing-refresh",
          targetOrigin: TARGET_ORIGIN,
          targetServiceDid: TARGET_SERVICE_DID,
          handle: "missing-ref.groups.test",
          recoveryKey: null,
          mode: "standard",
          negotiatedMode: "standard",
          ticketId: null,
          phase: "prepared",
        },
      ],
    ]),
  );
  const incompleteClient = new GroupClient({
    groupDid: GROUP_DID,
    fetchHandler: baseFetchHandler,
    fetchEndpoint: async (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/.well-known/did.json") {
        return Response.json({
          id: TARGET_SERVICE_DID,
          service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: TARGET_ORIGIN }],
        });
      }
      if (u.pathname === "/xrpc/com.atproto.server.createAccount") {
        return Response.json({
          did: GROUP_DID,
          handle: "missing-ref.groups.test",
          accessJwt: makeJwtWithExp(Math.floor(Date.now() / 1000) + 900, "only-access"),
        });
      }
      return Response.json({});
    },
    migrationState: incompleteStore,
  });
  await assert.rejects(
    incompleteClient.abortMigration(),
    (err: unknown) => err instanceof XrpcError && err.status === 502 && err.code === "InvalidResponse",
  );
  assert.ok(incompleteStore.get(GROUP_DID), "incomplete createAccount recovery without refreshJwt must retain journal");

  // 2. Service-JWT fallback returning `200 { status: "superseded" }`, malformed 2xx, or `404` MUST NOT delete journal!
  for (const badFallback of [
    { label: "superseded", res: () => Response.json({ status: "superseded" }, { status: 200 }) },
    { label: "malformed 2xx", res: () => Response.json({ ok: true }, { status: 200 }) },
    { label: "404 on fallback", res: () => Response.json({ error: "NotFound" }, { status: 404 }) },
  ] as const) {
    const fbStore = createInMemoryMigrationStateStore(
      new Map([
        [
          GROUP_DID,
          {
            operationId: `op-r29-fb-${badFallback.label.replace(/\s+/g, "-")}`,
            targetOrigin: TARGET_ORIGIN,
            targetServiceDid: TARGET_SERVICE_DID,
            handle: "fb.groups.test",
            recoveryKey: null,
            mode: "coordinated",
            negotiatedMode: "coordinated",
            ticketId: "ticket-r29",
            phase: "account_created",
            accessJwt: makeJwtWithExp(Math.floor(Date.now() / 1000) + 900, "stale-at"),
          },
        ],
      ]),
    );
    let abortCall = 0;
    const fbClient = new GroupClient({
      groupDid: GROUP_DID,
      fetchHandler: baseFetchHandler,
      fetchEndpoint: async (req) => {
        const u = new URL(req.url);
        if (u.pathname === "/.well-known/did.json") {
          return Response.json({
            id: TARGET_SERVICE_DID,
            service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: TARGET_ORIGIN }],
          });
        }
        if (u.pathname === "/group-admin/abort-migration") {
          abortCall += 1;
          if (abortCall === 1) {
            return Response.json({ error: "InvalidToken" }, { status: 401 });
          }
          return badFallback.res();
        }
        return Response.json({});
      },
      migrationState: fbStore,
    });
    await assert.rejects(fbClient.abortMigration(), XrpcError);
    assert.ok(fbStore.get(GROUP_DID), `service-JWT fallback (${badFallback.label}) must retain journal`);
  }

  // 3. Real two-host FakeNetwork: Unleased Standard session whose persisted bearer is expired/unusable (missing refreshJwt)
  //    recovers fresh `(accessJwt, refreshJwt)` via `createAccount` replay and PURGES live Target staging
  //    (instead of falling back to service-JWT `superseded` and abandoning Target!).
  const expiredBearerStore = createInMemoryMigrationStateStore();
  const makeUnleasedClient = () =>
    new GroupClient({
      groupDid: grpDid,
      fetchHandler: makeNetFetchHandler(),
      fetchEndpoint: async (req) => {
        const u = new URL(req.url);
        if (u.pathname === "/xrpc/com.atproto.repo.importRepo") {
          throw new TypeError("pause after account_created");
        }
        return fetchDst(req);
      },
      migrationState: expiredBearerStore,
    });
  await assert.rejects(
    makeUnleasedClient().migrateToHost(TARGET_ORIGIN, {
      handle: "r29-exp-bearer.groups.test",
      operationId: "op-r29-exp-bearer",
      mode: "standard",
    }),
    /pause after account_created/,
  );
  // Corrupt persisted bearer + drop refreshJwt so Bearer abort returns 401 and must recover via createAccount replay!
  const savedUnleased = await expiredBearerStore.get(grpDid);
  assert.ok(savedUnleased);
  await expiredBearerStore.set(grpDid, {
    ...savedUnleased,
    accessJwt: makeJwtWithExp(Math.floor(Date.now() / 1000) - 600, "expired-unusable"),
    refreshJwt: undefined,
  });
  const expAbortOut = await makeUnleasedClient().abortMigration();
  assert.equal(expAbortOut.status, "already_absent");
  assert.equal(expiredBearerStore.get(grpDid), undefined, "journal cleared only after Target staging was genuinely purged");
  // Prove live Target staging was genuinely purged (not left behind via superseded!)
  const afterExpPrep = await deviceB.prepareMigration(TARGET_ORIGIN, "op-r29-after-exp-purge");
  const { token: afterExpSvcJwt } = await new GroupClient({
    groupDid: grpDid,
    fetchHandler: makeNetFetchHandler(),
  }).xrpc.query<{ token: string }>("com.atproto.server.getServiceAuth", {
    aud: afterExpPrep.targetServiceDid,
    lxm: "com.atproto.server.createAccount",
  });
  const afterExpStage = await fetchDst(
    new Request(`${TARGET_ORIGIN}/xrpc/com.atproto.server.createAccount`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${afterExpSvcJwt}`,
        "x-group-migration-operation-id": "op-r29-after-exp-purge",
        ...(afterExpPrep.migrationTicket ? { "x-group-migration-ticket": afterExpPrep.migrationTicket } : {}),
      },
      body: JSON.stringify({ did: grpDid, handle: "after-exp.groups.test" }),
    }),
  );
  assert.equal(afterExpStage.status, 200, "Target staging must be genuinely purged after expired-bearer unleased Standard abort");
  await deviceB.abortMigration("op-r29-after-exp-purge");

  // Path F (Round 30 #1–#4):
  // 1. Service-JWT fallback & direct bearer returning non-200 2xx (`201`/`202 { status: "purged" }`) MUST reject and retain journal!
  for (const statusCode of [201, 202] as const) {
    const non200Store = createInMemoryMigrationStateStore(
      new Map([
        [
          GROUP_DID,
          {
            operationId: `op-r30-fb-${statusCode}`,
            targetOrigin: TARGET_ORIGIN,
            targetServiceDid: TARGET_SERVICE_DID,
            handle: "r30.groups.test",
            recoveryKey: null,
            mode: "coordinated",
            negotiatedMode: "coordinated",
            ticketId: "ticket-r30",
            phase: "account_created",
            accessJwt: makeJwtWithExp(Math.floor(Date.now() / 1000) + 900, "stale-r30"),
          },
        ],
      ]),
    );
    let callN = 0;
    const non200Client = new GroupClient({
      groupDid: GROUP_DID,
      fetchHandler: baseFetchHandler,
      fetchEndpoint: async (req) => {
        const u = new URL(req.url);
        if (u.pathname === "/.well-known/did.json") {
          return Response.json({
            id: TARGET_SERVICE_DID,
            service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: TARGET_ORIGIN }],
          });
        }
        if (u.pathname === "/group-admin/abort-migration") {
          callN += 1;
          if (callN === 1) return Response.json({ error: "InvalidToken" }, { status: 401 });
          return Response.json({ status: "purged" }, { status: statusCode });
        }
        return Response.json({});
      },
      migrationState: non200Store,
    });
    await assert.rejects(
      non200Client.abortMigration(),
      (err: unknown) => err instanceof XrpcError && err.status === 502 && err.code === "InvalidResponse",
    );
    assert.ok(await non200Store.get(GROUP_DID), `service-JWT fallback HTTP ${statusCode} must retain journal`);
  }

  // 2. Source abort returning non-200 2xx (`202 { status: "aborted" }`) or malformed `200 { ok: true }` MUST reject & retain journal!
  for (const badSrc of [
    { label: "202", res: () => Response.json({ status: "aborted" }, { status: 202 }) },
    { label: "malformed 200", res: () => Response.json({ ok: true }, { status: 200 }) },
  ] as const) {
    const srcBadStore = createInMemoryMigrationStateStore(
      new Map([
        [
          GROUP_DID,
          {
            operationId: `op-r30-src-${badSrc.label.replace(/\s+/g, "-")}`,
            targetOrigin: TARGET_ORIGIN,
            targetServiceDid: TARGET_SERVICE_DID,
            handle: "r30-src.groups.test",
            recoveryKey: null,
            mode: "coordinated",
            negotiatedMode: "coordinated",
            ticketId: "ticket-r30-src",
            phase: "prepared",
          },
        ],
      ]),
    );
    const srcBadClient = new GroupClient({
      groupDid: GROUP_DID,
      fetchHandler: async (path) => {
        if (path === "/group-admin/abort-migration") return badSrc.res();
        return Response.json({ error: "NotFound" }, { status: 404 });
      },
      fetchEndpoint: async () => Response.json({ status: "purged" }, { status: 200 }),
      migrationState: srcBadStore,
    });
    await assert.rejects(
      srcBadClient.abortMigration(),
      (err: unknown) => err instanceof XrpcError && err.status === 502 && err.code === "InvalidResponse",
    );
    assert.ok(await srcBadStore.get(GROUP_DID), `source abort (${badSrc.label}) must retain journal`);
  }

  // 3. Deterministic pre-cutover rollback MUST retain journal if target returns `202` or malformed `200 {}`!
  const rollbackBadStore = createInMemoryMigrationStateStore();
  const rollbackBadClient = new GroupClient({
    groupDid: GROUP_DID,
    fetchHandler: baseFetchHandler,
    fetchEndpoint: async (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/.well-known/did.json") {
        return Response.json({
          id: TARGET_SERVICE_DID,
          service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: TARGET_ORIGIN }],
        });
      }
      if (u.pathname === "/xrpc/com.atproto.server.describeServer") {
        return Response.json({ did: TARGET_SERVICE_DID });
      }
      if (u.pathname === "/xrpc/com.atproto.server.createAccount") {
        return Response.json({
          did: GROUP_DID,
          handle: "r30-rb.groups.test",
          accessJwt: makeJwtWithExp(Math.floor(Date.now() / 1000) + 900, "rb-at"),
          refreshJwt: "rb-rt",
        });
      }
      if (u.pathname === "/xrpc/com.atproto.repo.importRepo") {
        return Response.json({ error: "InvalidCar", message: "corrupt car" }, { status: 400 });
      }
      if (u.pathname === "/group-admin/abort-migration") {
        return Response.json({ ok: true }, { status: 202 });
      }
      return Response.json({});
    },
    migrationState: rollbackBadStore,
  });
  await assert.rejects(
    rollbackBadClient.migrateToHost(TARGET_ORIGIN, {
      handle: "r30-rb.groups.test",
      operationId: "op-r30-rb-bad-ack",
      mode: "standard",
    }),
    /corrupt car/,
  );
  assert.ok(
    await rollbackBadStore.get(GROUP_DID),
    "deterministic pre-cutover rollback must retain journal when target abort returns non-200/malformed ack",
  );

  // 4. Auto-negotiated leased Standard (`mode: "auto"`, `negotiatedMode: "standard"`) after expired/unusable bearer
  //    MUST recover via `createAccount` replay instead of wedging on service-JWT `superseded`!
  const autoStdStore = createInMemoryMigrationStateStore();
  // Downgrade `dstNet`'s migration-info temporarily so `mode: "auto"` negotiates `"standard"` with a source lease!
  const origDstFetch = dstNet.fetchEndpoint.bind(dstNet);
  const fetchDstStandardOnly = async (req: Request): Promise<Response> => {
    const mapped = mapTarget(req);
    if (new URL(mapped.url).pathname.endsWith("/group-admin/migration-info")) {
      return Response.json({ error: "NotFound" }, { status: 404 });
    }
    return origDstFetch(mapped);
  };
  net.outboundFetch = (req: Request) => fetchDstStandardOnly(req);
  const makeAutoStdClient = () =>
    new GroupClient({
      groupDid: grpDid,
      fetchHandler: makeNetFetchHandler(),
      fetchEndpoint: async (req) => {
        if (new URL(req.url).pathname === "/xrpc/com.atproto.repo.importRepo") {
          throw new TypeError("pause auto->standard after account_created");
        }
        return fetchDstStandardOnly(req);
      },
      migrationState: autoStdStore,
    });
  await assert.rejects(
    makeAutoStdClient().migrateToHost(TARGET_ORIGIN, {
      handle: "r30-auto-std.groups.test",
      operationId: "op-r30-auto-std",
      mode: "auto",
    }),
    /pause auto->standard after account_created/,
  );
  const savedAutoStd = await autoStdStore.get(grpDid);
  assert.ok(savedAutoStd);
  assert.equal(savedAutoStd.mode, "auto");
  assert.equal(savedAutoStd.negotiatedMode, "standard");
  await autoStdStore.set(grpDid, {
    ...savedAutoStd,
    accessJwt: makeJwtWithExp(Math.floor(Date.now() / 1000) - 600, "expired-auto-std"),
    refreshJwt: undefined,
  });
  const autoStdAbortOut = await makeAutoStdClient().abortMigration();
  assert.equal(autoStdAbortOut.status, "aborted", "auto->standard abort must recover bearer, purge target, and abort source lease");
  assert.equal(await autoStdStore.get(grpDid), undefined, "auto->standard journal cleared after proven target+source abort");
  net.outboundFetch = (req: Request) => fetchDst(req);

  // 5. Round 30 #4: FakeNetwork step-up guard rejects generic `issueSessionToken` (`loginStepUpAtMs === undefined`) with 403 FreshAuthRequired!
  const genericToken = net.issueSessionToken(grpDid, "full");
  const genericPrepRes = await net.fetchEndpoint(
    new Request(`${srcBase}/group-admin/prepare-migration`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${genericToken}`,
      },
      body: JSON.stringify({
        group: grpDid,
        operationId: "op-r30-generic-blocked",
        targetEndpoint: TARGET_ORIGIN,
      }),
    }),
  );
  assert.equal(genericPrepRes.status, 403, "FakeNetwork must fail closed (403 FreshAuthRequired) when loginStepUpAtMs is undefined");
  assert.equal(((await genericPrepRes.json()) as { error: string }).error, "FreshAuthRequired");

  // Path G (Round 31 #1 + additional abort/rollback coverage):
  // 1. Explicit Standard migration MUST bind requested target origin to its service DID `#atproto_pds` BEFORE calling
  //    `getServiceAuth` or disclosing any group-signed JWT to an untrusted origin!
  const evilOrigin = "https://evil-relay.example";
  let spoofServiceAuthCalls = 0;
  let spoofCreateAccountCalls = 0;
  const spoofStore = createInMemoryMigrationStateStore();
  const spoofClient = new GroupClient({
    groupDid: GROUP_DID,
    fetchHandler: async (path, init) => {
      if (path.startsWith("/xrpc/com.atproto.server.getServiceAuth")) {
        spoofServiceAuthCalls += 1;
      }
      return baseFetchHandler(path, init);
    },
    fetchEndpoint: async (req) => {
      const u = new URL(req.url);
      if (u.origin === evilOrigin && u.pathname === "/xrpc/com.atproto.server.describeServer") {
        // Malicious origin claims legitimate host's service DID!
        return Response.json({ did: TARGET_SERVICE_DID });
      }
      if (u.origin === TARGET_ORIGIN && u.pathname === "/.well-known/did.json") {
        // Legitimate DID document binds #atproto_pds to TARGET_ORIGIN (NOT evilOrigin)!
        return Response.json({
          id: TARGET_SERVICE_DID,
          service: [
            { id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: TARGET_ORIGIN },
            { id: "#opensocial_group", type: "OpenSocialGroupHost", serviceEndpoint: TARGET_ORIGIN },
          ],
        });
      }
      if (u.pathname === "/xrpc/com.atproto.server.createAccount") {
        spoofCreateAccountCalls += 1;
      }
      return Response.json({ error: "NotFound" }, { status: 404 });
    },
    migrationState: spoofStore,
  });
  await assert.rejects(
    spoofClient.migrateToHost(evilOrigin, {
      handle: "spoofed.groups.test",
      operationId: "op-r31-spoof-did",
      mode: "standard",
    }),
    (err: unknown) => err instanceof XrpcError && err.status === 400 && err.code === "UnsupportedGroupHostTarget",
  );
  assert.equal(spoofServiceAuthCalls, 0, "must NEVER mint group service JWT before binding target origin to DID #atproto_pds");
  assert.equal(spoofCreateAccountCalls, 0, "must NEVER send createAccount to mismatched target origin");
  assert.equal(await spoofStore.get(GROUP_DID), undefined, "deterministic UnsupportedGroupHostTarget clears starting journal");

  // 2. Pre-populated unverified journal (`targetOrigin: evilOrigin`, `targetServiceDid: TARGET_SERVICE_DID`) MUST also
  //    fail closed BEFORE calling `getServiceAuth` on BOTH `migrateToHost` resume AND `abortMigration`!
  const makeUnverifiedSpoofJournal = () =>
    createInMemoryMigrationStateStore(
      new Map([
        [
          GROUP_DID,
          {
            operationId: "op-r31-prepop-spoof",
            targetOrigin: evilOrigin,
            targetServiceDid: TARGET_SERVICE_DID,
            handle: "spoofed.groups.test",
            recoveryKey: null,
            mode: "standard",
            negotiatedMode: "standard",
            ticketId: null,
            phase: "prepared",
          },
        ],
      ]),
    );
  const prepopResumeClient = new GroupClient({
    groupDid: GROUP_DID,
    fetchHandler: async (path, init) => {
      if (path.startsWith("/xrpc/com.atproto.server.getServiceAuth")) spoofServiceAuthCalls += 1;
      return baseFetchHandler(path, init);
    },
    fetchEndpoint: async (req) => {
      const u = new URL(req.url);
      if (u.origin === TARGET_ORIGIN && u.pathname === "/.well-known/did.json") {
        return Response.json({
          id: TARGET_SERVICE_DID,
          service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: TARGET_ORIGIN }],
        });
      }
      return Response.json({ error: "NotFound" }, { status: 404 });
    },
    migrationState: makeUnverifiedSpoofJournal(),
  });
  await assert.rejects(
    prepopResumeClient.migrateToHost(evilOrigin, { handle: "spoofed.groups.test", mode: "standard" }),
    (err: unknown) => err instanceof XrpcError && err.status === 400 && err.code === "UnsupportedGroupHostTarget",
  );
  await assert.rejects(
    new GroupClient({
      groupDid: GROUP_DID,
      fetchHandler: async (path, init) => {
        if (path.startsWith("/xrpc/com.atproto.server.getServiceAuth")) spoofServiceAuthCalls += 1;
        return baseFetchHandler(path, init);
      },
      fetchEndpoint: async (req) => {
        const u = new URL(req.url);
        if (u.origin === TARGET_ORIGIN && u.pathname === "/.well-known/did.json") {
          return Response.json({
            id: TARGET_SERVICE_DID,
            service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: TARGET_ORIGIN }],
          });
        }
        return Response.json({ error: "NotFound" }, { status: 404 });
      },
      migrationState: makeUnverifiedSpoofJournal(),
    }).abortMigration(),
    (err: unknown) => err instanceof XrpcError && err.status === 400 && err.code === "UnsupportedGroupHostTarget",
  );
  assert.equal(spoofServiceAuthCalls, 0, "pre-populated spoofed journals must never mint service JWTs");

  // 3. Direct-Bearer target abort returning `202` AND deterministic rollback returning malformed `200 {}` BOTH retain journal!
  const direct202Store = createInMemoryMigrationStateStore(
    new Map([
      [
        GROUP_DID,
        {
          operationId: "op-r31-direct-202",
          targetOrigin: TARGET_ORIGIN,
          targetServiceDid: TARGET_SERVICE_DID,
          targetOriginVerified: true,
          handle: "r31.groups.test",
          recoveryKey: null,
          mode: "standard",
          negotiatedMode: "standard",
          ticketId: null,
          phase: "account_created",
          accessJwt: makeJwtWithExp(Math.floor(Date.now() / 1000) + 900, "r31-at"),
        },
      ],
    ]),
  );
  await assert.rejects(
    new GroupClient({
      groupDid: GROUP_DID,
      fetchHandler: baseFetchHandler,
      fetchEndpoint: async (req) => {
        if (new URL(req.url).pathname === "/group-admin/abort-migration") {
          return Response.json({ status: "purged" }, { status: 202 });
        }
        return Response.json({});
      },
      migrationState: direct202Store,
    }).abortMigration(),
    (err: unknown) => err instanceof XrpcError && err.status === 502 && err.code === "InvalidResponse",
  );
  assert.ok(await direct202Store.get(GROUP_DID), "direct-Bearer 202 target abort must retain journal");

  const rollbackMalformed200Store = createInMemoryMigrationStateStore();
  await assert.rejects(
    new GroupClient({
      groupDid: GROUP_DID,
      fetchHandler: baseFetchHandler,
      fetchEndpoint: async (req) => {
        const u = new URL(req.url);
        if (u.pathname === "/.well-known/did.json") {
          return Response.json({
            id: TARGET_SERVICE_DID,
            service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: TARGET_ORIGIN }],
          });
        }
        if (u.pathname === "/xrpc/com.atproto.server.describeServer") {
          return Response.json({ did: TARGET_SERVICE_DID });
        }
        if (u.pathname === "/xrpc/com.atproto.server.createAccount") {
          return Response.json({
            did: GROUP_DID,
            handle: "r31-malformed.groups.test",
            accessJwt: makeJwtWithExp(Math.floor(Date.now() / 1000) + 900, "r31-rb-at"),
            refreshJwt: "r31-rb-rt",
          });
        }
        if (u.pathname === "/xrpc/com.atproto.repo.importRepo") {
          return Response.json({ error: "InvalidCar", message: "corrupt car r31" }, { status: 400 });
        }
        if (u.pathname === "/group-admin/abort-migration") {
          return Response.json({ ok: true }, { status: 200 });
        }
        return Response.json({});
      },
      migrationState: rollbackMalformed200Store,
    }).migrateToHost(TARGET_ORIGIN, {
      handle: "r31-malformed.groups.test",
      operationId: "op-r31-rb-malformed-200",
      mode: "standard",
    }),
    /corrupt car r31/,
  );
  assert.ok(
    await rollbackMalformed200Store.get(GROUP_DID),
    "deterministic rollback receiving malformed 200 {} from target abort must retain journal",
  );

  // 4. Round 32 #1: Resumed `account_created` journals lacking `targetOriginVerified` MUST verify DID->#atproto_pds
  //    BEFORE sending stored bearer to `targetOrigin` on BOTH `migrateToHost` AND `abortMigration`, AND resumed
  //    `signing_plc` journals MUST verify `proposedPlcParams.services.atproto_pds.endpoint` BEFORE `signPlcOperation`!
  let evilBearerLeakCount = 0;
  let evilSourceAbortCount = 0;
  let evilSignPlcCount = 0;
  const makeResumedUnverifiedAcctStore = () =>
    createInMemoryMigrationStateStore(
      new Map([
        [
          GROUP_DID,
          {
            operationId: "op-r32-resumed-acct-spoof",
            targetOrigin: evilOrigin,
            targetServiceDid: TARGET_SERVICE_DID,
            handle: "spoofed.groups.test",
            recoveryKey: null,
            mode: "standard",
            negotiatedMode: "standard",
            ticketId: null,
            phase: "account_created",
            accessJwt: makeJwtWithExp(Math.floor(Date.now() / 1000) + 900, "leaked-bearer-r32"),
            refreshJwt: "leaked-refresh-r32",
          },
        ],
      ]),
    );
  const evilResumedFetchEndpoint = async (req: Request): Promise<Response> => {
    const u = new URL(req.url);
    if (u.origin === evilOrigin) {
      evilBearerLeakCount += 1;
      return Response.json({ status: "purged" });
    }
    if (u.origin === TARGET_ORIGIN && u.pathname === "/.well-known/did.json") {
      return Response.json({
        id: TARGET_SERVICE_DID,
        service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: TARGET_ORIGIN }],
      });
    }
    return Response.json({ error: "NotFound" }, { status: 404 });
  };
  const evilResumedFetchHandler = async (path: string, init?: RequestInit): Promise<Response> => {
    if (path === "/group-admin/abort-migration") evilSourceAbortCount += 1;
    if (path === "/xrpc/com.atproto.identity.signPlcOperation") evilSignPlcCount += 1;
    return baseFetchHandler(path, init);
  };

  const resumedMigrateStore = makeResumedUnverifiedAcctStore();
  await assert.rejects(
    new GroupClient({
      groupDid: GROUP_DID,
      fetchHandler: evilResumedFetchHandler,
      fetchEndpoint: evilResumedFetchEndpoint,
      migrationState: resumedMigrateStore,
    }).migrateToHost(evilOrigin, { handle: "spoofed.groups.test", mode: "standard" }),
    (err: unknown) => err instanceof XrpcError && err.status === 400 && err.code === "UnsupportedGroupHostTarget",
  );
  const resumedAbortStore = makeResumedUnverifiedAcctStore();
  await assert.rejects(
    new GroupClient({
      groupDid: GROUP_DID,
      fetchHandler: evilResumedFetchHandler,
      fetchEndpoint: evilResumedFetchEndpoint,
      migrationState: resumedAbortStore,
    }).abortMigration(),
    (err: unknown) => err instanceof XrpcError && err.status === 400 && err.code === "UnsupportedGroupHostTarget",
  );
  assert.equal(evilBearerLeakCount, 0, "must NEVER send stored bearer to unverified targetOrigin on resumed migrate or abort");
  assert.equal(evilSourceAbortCount, 0, "must NEVER abort Source after unverified targetOrigin rejection");
  assert.ok(await resumedAbortStore.get(GROUP_DID), "unverified abort rejection must retain journal");

  const resumedSigningPlcStore = createInMemoryMigrationStateStore(
    new Map([
      [
        GROUP_DID,
        {
          operationId: "op-r32-resumed-sign-plc",
          targetOrigin: TARGET_ORIGIN,
          targetServiceDid: TARGET_SERVICE_DID,
          targetOriginVerified: true,
          handle: "r32-sign.groups.test",
          recoveryKey: null,
          mode: "standard",
          negotiatedMode: "standard",
          ticketId: null,
          phase: "signing_plc",
          accessJwt: makeJwtWithExp(Math.floor(Date.now() / 1000) + 900, "r32-sign-at"),
          refreshJwt: "r32-sign-rt",
          plcToken: "plc-tok-resumed",
          proposedPlcParams: {
            rotationKeys: ["did:key:zRot"],
            alsoKnownAs: ["at://r32-sign.groups.test"],
            verificationMethods: { atproto: "did:key:zSig" },
            services: { atproto_pds: { type: "AtprotoPersonalDataServer", endpoint: evilOrigin } },
          },
        },
      ],
    ]),
  );
  await assert.rejects(
    new GroupClient({
      groupDid: GROUP_DID,
      fetchHandler: evilResumedFetchHandler,
      fetchEndpoint: baseFetchEndpoint,
      migrationState: resumedSigningPlcStore,
    }).migrateToHost(TARGET_ORIGIN, { handle: "r32-sign.groups.test", mode: "standard" }),
    (err: unknown) => err instanceof XrpcError && err.status === 400 && err.code === "UnsupportedGroupHostTarget",
  );
  assert.equal(evilSignPlcCount, 0, "resumed signing_plc with mismatched proposedPlcParams.services.atproto_pds must NOT call signPlcOperation");
});
