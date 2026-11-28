import assert from "node:assert/strict";
import test from "node:test";
import { GroupClient } from "@flock/client/group-client";
import { XrpcError } from "@flock/protocol/atproto/xrpc";
import { groupMembersUri, groupMetaUri } from "@flock/protocol/keys";
import { groupAdminScopes } from "@flock/protocol/scopes";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import {
  _resetInMemoryGroupAuthStateForNavigationTest,
  claimedActionTokenKey,
  deleteGroupOAuthDatabase,
  getGroupErasureEpoch,
  GROUP_OAUTH_ERASURE_EPOCH_PREFIX,
  GroupBrowserOAuthClient,
  groupOAuthDbName,
  GroupOAuthDeniedError,
  parseGroupCallbackAppState,
  parsePersistedGroupMigrationState,
  revokeAndEraseGroupOAuthSessions,
  serializePersistedGroupMigrationState,
} from "./group-session";
import { runBrowserOperatorReauthorization } from "./use-browser-session";

Object.assign(globalThis, { IDBKeyRange });

const ALICE = "did:plc:aliceaaaaaaaaaaaaaaaaaaa";
const BOB = "did:plc:bob2aaaaaaaaaaaaaaaaaaaa";
const GROUP_A = "did:plc:groupaaaaaaaaaaaaaaaaaaa";

test("GroupBrowserOAuthClient isolates IndexedDB per viewerDid, handles access_denied callbacks cleanly, and parses appState", async () => {
  const idb = new IDBFactory();
  const config = {
    appUrl: "http://127.0.0.1:3000",
    plcUrl: "http://127.0.0.1:2582",
    groupHostUrl: "http://127.0.0.1:3004",
    loopback: true,
  };

  const aliceClient = new GroupBrowserOAuthClient({ viewerDid: ALICE, config, idbFactory: idb });
  const bobClient = new GroupBrowserOAuthClient({ viewerDid: BOB, config, idbFactory: idb });

  assert.deepEqual(await aliceClient.listStoredGroupDids(), []);
  assert.equal(await aliceClient.restoreGroupClient(GROUP_A), null);

  await assert.rejects(
    aliceClient.completeCallback(new URLSearchParams({ error: "access_denied", error_description: "User declined" })),
    (err: unknown) => err instanceof GroupOAuthDeniedError && err.oauthError === "access_denied",
  );

  const parsed = parseGroupCallbackAppState(
    JSON.stringify({
      viewerDid: ALICE,
      returnTo: "/w/did%3Aplc%3Agroupaaaaaaaaaaaaaaaaaaa/self",
      purpose: "step_up",
      groupDid: GROUP_A,
      claimPurpose: "delete_account",
    }),
  );
  assert.deepEqual(parsed, {
    viewerDid: ALICE,
    returnTo: "/w/did%3Aplc%3Agroupaaaaaaaaaaaaaaaaaaa/self",
    purpose: "step_up",
    groupDid: GROUP_A,
    claimPurpose: "delete_account",
  });
  assert.equal(parseGroupCallbackAppState("not-json"), null);
  assert.equal(parseGroupCallbackAppState(JSON.stringify({ viewerDid: "invalid" })), null);
  assert.equal(claimedActionTokenKey(GROUP_A, "delete_account"), `spaces.claimedActionToken:${GROUP_A}:delete_account`);

  await bobClient.listStoredGroupDids();
  const dbsBefore = (await idb.databases()).map((d) => d.name).sort();
  assert.deepEqual(dbsBefore, [groupOAuthDbName(ALICE), groupOAuthDbName(BOB)].sort());

  await aliceClient.close();
  await deleteGroupOAuthDatabase(ALICE, idb);
  const dbsAfter = (await idb.databases()).map((d) => d.name);
  assert.deepEqual(dbsAfter, [groupOAuthDbName(BOB)]);
  await bobClient.close();
});

test("GroupBrowserOAuthClient durably persists and validates full phase-resumable migration state in IndexedDB", async () => {
  const idb = new IDBFactory();
  const config = {
    appUrl: "http://127.0.0.1:3000",
    plcUrl: "http://127.0.0.1:2582",
    groupHostUrl: "http://127.0.0.1:3004",
    loopback: true,
  };

  const client1 = new GroupBrowserOAuthClient({ viewerDid: ALICE, config, idbFactory: idb });
  const store1 = client1.createMigrationStateStore();

  const fullPlcSignedState = {
    protocolVersion: "org.atgrp.v1" as const,
    operationId: "3lblbrowserop01",
    targetOrigin: "https://groups2.example.com",
    handle: "team.groups2.example.com",
    mode: "auto" as const,
    negotiatedMode: "coordinated" as const,
    targetServiceDid: "did:web:groups2.example.com",
    migrationTicket: "v1.ticket-id-99.secret_value_abc",
    ticketId: "ticket-id-99",
    phase: "plc_signed" as const,
    accessJwt: "access-jwt-rotated",
    refreshJwt: "refresh-jwt-rotated",
    plcToken: "plc-confirm-token",
    proposedPlcParams: {
      rotationKeys: ["did:key:zRotTarget"],
      alsoKnownAs: ["at://team.groups2.example.com"],
      verificationMethods: { atproto: "did:key:zSigTarget" },
      services: { atproto_pds: { type: "AtprotoPersonalDataServer", endpoint: "https://groups2.example.com" } },
    },
    signedPlcOp: {
      type: "plc_operation",
      sig: "signed-plc-op-bytes",
      prev: "bafyreiprev",
    },
  };

  await store1.set(GROUP_A, fullPlcSignedState);
  await client1.close();

  // Separate browser instance over the same IDBFactory restores identical full state!
  const client2 = new GroupBrowserOAuthClient({ viewerDid: ALICE, config, idbFactory: idb });
  const store2 = client2.createMigrationStateStore();
  const restored = await store2.get(GROUP_A);
  assert.deepEqual(restored, fullPlcSignedState);

  // Validation rejects invariant-violating states (e.g. plc_signed without signedPlcOp or without accessJwt, signing_plc without plcToken)
  assert.equal(
    parsePersistedGroupMigrationState({
      ...fullPlcSignedState,
      signedPlcOp: undefined,
    }),
    null,
  );
  assert.equal(
    parsePersistedGroupMigrationState({
      ...fullPlcSignedState,
      accessJwt: undefined,
    }),
    null,
  );
  assert.equal(
    parsePersistedGroupMigrationState({
      ...fullPlcSignedState,
      phase: "signing_plc",
      plcToken: undefined,
    }),
    null,
  );
  assert.equal(
    parsePersistedGroupMigrationState({
      ...fullPlcSignedState,
      targetOrigin: "https://groups2.example.com/with/path",
    }),
    null,
  );
  assert.throws(() =>
    serializePersistedGroupMigrationState({
      ...fullPlcSignedState,
      signedPlcOp: undefined,
    }),
  );

  // R15 cutover: pre-R15 migration state missing protocolVersion: "org.atgrp.v1" is rejected.
  const { protocolVersion: _omitted, ...legacyUnversioned } = fullPlcSignedState;
  void _omitted;
  assert.equal(parsePersistedGroupMigrationState(legacyUnversioned), null);

  await store2.delete(GROUP_A);
  assert.equal(await store2.get(GROUP_A), undefined);
  await client2.close();
});

test("GroupOAuthDatabase v1 -> v2 upgrade purges pre-R15 group.opensocial.* session and state records", async () => {
  const idb = new IDBFactory();
  const dbName = groupOAuthDbName(ALICE);
  // Seed a v1 database matching pre-R15 schema with legacy session and state records.
  await new Promise<void>((resolve, reject) => {
    const req = idb.open(dbName, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("state", { keyPath: "key" });
      db.createObjectStore("session", { keyPath: "key" });
      db.createObjectStore("dpopNonce", { keyPath: "key" });
      db.createObjectStore("migrationState", { keyPath: "groupDid" });
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(["session", "state"], "readwrite");
      tx.objectStore("session").put({ key: GROUP_A, value: { tokenSet: { scope: "include:group.opensocial.authAdmin" } } });
      tx.objectStore("state").put({ key: "old-state-1", value: { iss: "http://127.0.0.1:3004" } });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });

  const client = new GroupBrowserOAuthClient({
    viewerDid: ALICE,
    config: {
      appUrl: "http://127.0.0.1:3000",
      plcUrl: "http://127.0.0.1:2582",
      groupHostUrl: "http://127.0.0.1:3004",
      loopback: true,
    },
    idbFactory: idb,
  });
  try {
    assert.deepEqual(await client.listStoredGroupDids(), [], "v1->v2 upgrade purged legacy group.opensocial.* sessions");
  } finally {
    await client.close();
  }
});

test("runBrowserOperatorReauthorization does not leave reauthAttempted or pendingReactivateGroup set when startAuthorityFlow throws", async () => {
  const storageData = new Map<string, string>();
  const storage = {
    getItem: (key: string) => storageData.get(key) ?? null,
    setItem: (key: string, val: string) => {
      storageData.set(key, val);
    },
    removeItem: (key: string) => {
      storageData.delete(key);
    },
  };
  const navigated: string[] = [];
  let shouldThrow = true;

  const operator = {
    startAuthorityFlow: async (req: { purpose: "reauthorize"; authority: string }) => {
      if (shouldThrow) {
        throw new Error("Operator network unavailable");
      }
      return {
        url: `https://operator.example.com/authority/start?authority=${encodeURIComponent(req.authority)}`,
      };
    },
  };

  await assert.rejects(
    runBrowserOperatorReauthorization({
      groupDid: GROUP_A,
      operator,
      locationSearch: "",
      storage,
      navigate: (url) => navigated.push(url),
    }),
    /Operator network unavailable/,
  );

  assert.equal(storage.getItem(`spaces.reauthAttempted:${GROUP_A}`), null, "reauthAttempted is not left set after throw");
  assert.equal(storage.getItem("spaces.pendingReactivateGroup"), null, "pendingReactivateGroup is not set before startAuthorityFlow succeeds");
  assert.equal(navigated.length, 0);

  // Subsequent retry in the same session succeeds and sets both storage keys right before navigate()!
  shouldThrow = false;
  const started = await runBrowserOperatorReauthorization({
    groupDid: GROUP_A,
    operator,
    locationSearch: "",
    storage,
    navigate: (url) => navigated.push(url),
  });
  assert.equal(started, true);
  assert.equal(storage.getItem(`spaces.reauthAttempted:${GROUP_A}`), "1");
  assert.equal(storage.getItem("spaces.pendingReactivateGroup"), GROUP_A);
  assert.equal(navigated.length, 1);
});

test("IndexedDB GroupMigrationStateStore enforces single-readwrite-tx revision CAS, rejects phase regression, and serializes concurrent multi-tab migrations", async () => {
  const idb = new IDBFactory();
  const config = {
    appUrl: "http://127.0.0.1:3000",
    plcUrl: "http://127.0.0.1:2582",
    groupHostUrl: "http://127.0.0.1:3004",
    loopback: true,
  };

  const browserA = new GroupBrowserOAuthClient({ viewerDid: ALICE, config, idbFactory: idb });
  const browserB = new GroupBrowserOAuthClient({ viewerDid: ALICE, config, idbFactory: idb });
  const storeA = browserA.createMigrationStateStore();
  const storeB = browserB.createMigrationStateStore();

  // 1. Concurrent initial `compareAndSet(..., null, ...)` across two separate connections to shared IndexedDB:
  //    exactly ONE wins with `revision: 1`, and the other rejects with `409 MigrationInProgress`!
  const [initA, initB] = await Promise.allSettled([
    storeA.compareAndSet(GROUP_A, null, {
      operationId: "3lblidbcas0001",
      targetOrigin: "https://groups2.example.com",
      handle: "team.groups2.example.com",
      mode: "coordinated",
      ticketId: null,
      phase: "starting",
    }),
    storeB.compareAndSet(GROUP_A, null, {
      operationId: "3lblidbcas0002",
      targetOrigin: "https://groups2.example.com",
      handle: "team.groups2.example.com",
      mode: "coordinated",
      ticketId: null,
      phase: "starting",
    }),
  ]);
  const fulfilledInits = [initA, initB].filter((r) => r.status === "fulfilled");
  const rejectedInits = [initA, initB].filter((r) => r.status === "rejected");
  assert.equal(fulfilledInits.length, 1);
  assert.equal(rejectedInits.length, 1);
  assert.equal(fulfilledInits[0]!.value.revision, 1);
  assert.ok(rejectedInits[0]!.reason instanceof XrpcError && rejectedInits[0]!.reason.status === 409);

  const winnerOp = fulfilledInits[0]!.value.operationId;
  const rev2 = await storeA.compareAndSet(
    GROUP_A,
    { operationId: winnerOp, revision: 1 },
    {
      ...fulfilledInits[0]!.value,
      phase: "account_created",
      accessJwt: "idb-jwt-1",
      refreshJwt: "idb-ref-1",
    },
  );
  assert.equal(rev2.revision, 2);

  // Stale revision (`revision: 1`) from `storeB` rejects without overwriting `idb-jwt-1`!
  await assert.rejects(
    storeB.compareAndSet(
      GROUP_A,
      { operationId: winnerOp, revision: 1 },
      {
        ...rev2,
        phase: "staged",
        accessJwt: "stale-jwt",
      },
    ),
    (err: unknown) => err instanceof XrpcError && err.status === 409 && err.code === "MigrationInProgress",
  );

  // Phase regression (`account_created` -> `prepared`) rejects even with current `revision: 2`!
  await assert.rejects(
    storeB.compareAndSet(
      GROUP_A,
      { operationId: winnerOp, revision: 2 },
      {
        ...rev2,
        phase: "prepared",
      },
    ),
    (err: unknown) => err instanceof XrpcError && err.status === 409 && err.code === "MigrationInProgress",
  );
  assert.equal((await storeA.get(GROUP_A))?.accessJwt, "idb-jwt-1");
  assert.equal((await storeA.get(GROUP_A))?.revision, 2);

  // Stale `compareAndDelete` returns `false` without deleting; matching `compareAndDelete` deletes cleanly!
  assert.equal(await storeB.compareAndDelete(GROUP_A, { operationId: winnerOp, revision: 1 }), false);
  assert.notEqual(await storeA.get(GROUP_A), undefined);
  assert.equal(await storeB.compareAndDelete(GROUP_A, { operationId: winnerOp, revision: 2 }), true);
  assert.equal(await storeA.get(GROUP_A), undefined);

  // 2. End-to-end concurrent `migrateToHost` across two `GroupClient` instances backed by `storeA` and `storeB`
  //    over shared `IDBFactory`: Tab A fails transiently mid-staging after persisting `account_created`, and queued
  //    Tab B resumes cleanly from Tab A's persisted journal without replaying `prepareMigration` or `createAccount`!
  let prepareCalls = 0;
  let createCalls = 0;
  let failFirstImport = true;
  const sourceFetch = async (path: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(path, "http://127.0.0.1:3004");
    if (url.pathname === "/group-admin/prepare-migration") {
      prepareCalls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return Response.json({
        groupDid: GROUP_A,
        operationId: body.operationId,
        mode: "coordinated",
        targetEndpoint: "https://groups2.example.com",
        targetServiceDid: "did:web:groups2.example.com",
        deadlineAtMs: Date.now() + 7_200_000,
        manifestDigest: "sha256:abc",
        migrationTicket: "v1.idb-ticket-1.secret_xyz",
      });
    }
    if (url.pathname === "/xrpc/com.atproto.server.getServiceAuth") {
      return Response.json({ token: "svc-jwt" });
    }
    if (url.pathname === "/xrpc/com.atproto.sync.getRepo") {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "application/vnd.ipld.car" },
      });
    }
    if (url.pathname === "/xrpc/com.atproto.sync.listBlobs") {
      return Response.json({ cids: [] });
    }
    if (url.pathname === "/xrpc/com.atproto.space.listSpaces") {
      return Response.json({ spaces: [{ space: groupMetaUri(GROUP_A) }, { space: groupMembersUri(GROUP_A) }] });
    }
    if (url.pathname === "/xrpc/com.atproto.space.exportSpaceMeta" || url.pathname === "/xrpc/com.atproto.space.getRepo") {
      return new Response(new Uint8Array([4, 5, 6]), {
        status: 200,
        headers: { "content-type": "application/vnd.dasl.star" },
      });
    }
    if (url.pathname === "/xrpc/com.atproto.identity.requestPlcOperationSignature") {
      return Response.json({});
    }
    if (url.pathname === "/group-admin/claim-action-token") {
      return Response.json({ token: "plc-tok-1", expiresAt: "2027-01-01T00:00:00.000Z" });
    }
    if (url.pathname === "/xrpc/com.atproto.identity.signPlcOperation") {
      return Response.json({ operation: { type: "plc_operation", sig: "sig-1" } });
    }
    return Response.json({ error: "NotFound" }, { status: 404 });
  };

  const targetFetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === "/xrpc/com.atproto.server.createAccount") {
      createCalls += 1;
      return Response.json({
        did: GROUP_A,
        handle: "team.groups2.example.com",
        accessJwt: "target-access-1",
        refreshJwt: "target-refresh-1",
      });
    }
    if (url.pathname === "/xrpc/com.atproto.repo.importRepo" && failFirstImport) {
      failFirstImport = false;
      return Response.json({ error: "UpstreamFailure", message: "transient 503 during import" }, { status: 503 });
    }
    if (url.pathname === "/xrpc/com.atproto.identity.getRecommendedDidCredentials") {
      return Response.json({
        rotationKeys: ["did:key:zRot"],
        alsoKnownAs: ["at://team.groups2.example.com"],
        verificationMethods: { atproto: "did:key:zSig" },
        services: { atproto_pds: { type: "AtprotoPersonalDataServer", endpoint: "https://groups2.example.com" } },
      });
    }
    return Response.json({});
  };

  const gcA = new GroupClient({
    groupDid: GROUP_A,
    fetchHandler: sourceFetch,
    fetchEndpoint: targetFetch,
    migrationState: storeA,
  });
  const gcB = new GroupClient({
    groupDid: GROUP_A,
    fetchHandler: sourceFetch,
    fetchEndpoint: targetFetch,
    migrationState: storeB,
  });

  const [migA, migB] = await Promise.allSettled([
    gcA.migrateToHost("https://groups2.example.com", { handle: "team.groups2.example.com", mode: "coordinated" }),
    gcB.migrateToHost("https://groups2.example.com", { handle: "team.groups2.example.com", mode: "coordinated" }),
  ]);
  assert.equal(migA.status, "rejected");
  assert.equal(migB.status, "fulfilled");
  assert.equal(prepareCalls, 1, "prepareMigration ran once across concurrent tabs");
  assert.equal(createCalls, 1, "createAccount ran once across concurrent tabs without rotating ticket JTIs");
  assert.equal(await storeA.get(GROUP_A), undefined);

  await browserA.close();
  await browserB.close();
});

test("Cross-tab sign-out erasure barrier closes in-flight GroupBrowserOAuthClient on versionchange/epoch bump and leaves zero resurrected sessions", async () => {
  const viewerDid = "did:plc:alicesignouteraseaaaaa";
  const sharedIdb = new IDBFactory();
  const config = {
    appUrl: "http://127.0.0.1:3000",
    plcUrl: "http://127.0.0.1:2582",
    groupHostUrl: "http://127.0.0.1:3004",
    loopback: true,
  };

  let capturedParState = "";
  let pauseTokenExchange = true;
  let notifyTokenExchangeStarted!: () => void;
  const tokenExchangeStarted = new Promise<void>((resolve) => {
    notifyTokenExchangeStarted = resolve;
  });
  let releaseTokenExchange!: () => void;
  const tokenExchangeGate = new Promise<void>((resolve) => {
    releaseTokenExchange = resolve;
  });
  const revokedTokens: string[] = [];

  const mockOAuthFetch: typeof globalThis.fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(req.url);

    if (url.origin === config.plcUrl && decodeURIComponent(url.pathname.slice(1)) === GROUP_A) {
      return Response.json({
        "@context": ["https://www.w3.org/ns/did/v1"],
        id: GROUP_A,
        alsoKnownAs: [],
        verificationMethod: [],
        service: [
          {
            id: "#atproto_pds",
            type: "AtprotoPersonalDataServer",
            serviceEndpoint: config.groupHostUrl,
          },
        ],
      });
    }
    if (url.origin === config.groupHostUrl && url.pathname === "/.well-known/oauth-protected-resource") {
      return Response.json({
        resource: config.groupHostUrl,
        authorization_servers: [config.groupHostUrl],
      });
    }
    if (url.origin === config.groupHostUrl && url.pathname === "/.well-known/oauth-authorization-server") {
      return Response.json({
        issuer: config.groupHostUrl,
        authorization_endpoint: `${config.groupHostUrl}/oauth/authorize`,
        token_endpoint: `${config.groupHostUrl}/oauth/token`,
        pushed_authorization_request_endpoint: `${config.groupHostUrl}/oauth/par`,
        revocation_endpoint: `${config.groupHostUrl}/oauth/revoke`,
        jwks_uri: `${config.groupHostUrl}/oauth/jwks.json`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        dpop_signing_alg_values_supported: ["ES256"],
        scopes_supported: ["atproto", ...groupAdminScopes()],
        authorization_response_iss_parameter_supported: true,
        require_pushed_authorization_requests: true,
        client_id_metadata_document_supported: true,
      });
    }
    if (url.origin === config.groupHostUrl && url.pathname === "/oauth/par") {
      const form = new URLSearchParams(await req.text());
      capturedParState = form.get("state") ?? "";
      return new Response(
        JSON.stringify({
          request_uri: "urn:ietf:params:oauth:request_uri:par-req-1",
          expires_in: 300,
        }),
        {
          status: 201,
          headers: {
            "content-type": "application/json",
            "dpop-nonce": "nonce-par-1",
          },
        },
      );
    }
    if (url.origin === config.groupHostUrl && url.pathname === "/oauth/token") {
      if (pauseTokenExchange) {
        notifyTokenExchangeStarted();
        await tokenExchangeGate;
      }
      return new Response(
        JSON.stringify({
          access_token: "group-oauth-access-1",
          refresh_token: "group-oauth-refresh-1",
          token_type: "DPoP",
          scope: groupAdminScopes().join(" "),
          sub: GROUP_A,
          expires_in: 3600,
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "dpop-nonce": "nonce-tok-2",
          },
        },
      );
    }
    if (url.origin === config.groupHostUrl && url.pathname === "/oauth/revoke") {
      const form = new URLSearchParams(await req.text());
      revokedTokens.push(form.get("token") ?? "");
      return new Response(null, {
        status: 200,
        headers: { "dpop-nonce": "nonce-rev-3" },
      });
    }
    return Response.json({ error: "NotFound", message: url.href }, { status: 404 });
  };

  // Tab 1 starts Group OAuth flow and begins `completeCallback`, pausing mid-flight during `/oauth/token` exchange!
  const tab1 = new GroupBrowserOAuthClient({
    viewerDid,
    config,
    idbFactory: sharedIdb,
    fetch: mockOAuthFetch,
  });
  const tab2 = new GroupBrowserOAuthClient({
    viewerDid,
    config,
    idbFactory: sharedIdb,
    fetch: mockOAuthFetch,
  });
  // Ensure Tab 2 also has an open IDB connection before sign-out.
  assert.deepEqual(await tab2.listStoredGroupDids(), []);

  const epochBefore = getGroupErasureEpoch(viewerDid);
  const authUrl = await tab1.authorizeGroup({
    groupOrHost: GROUP_A,
    roleScope: "admin",
    appState: { returnTo: "/w", purpose: "admin", groupDid: GROUP_A },
  });
  assert.ok(authUrl.href.startsWith(`${config.groupHostUrl}/oauth/authorize`));
  assert.ok(capturedParState.length > 0);

  const callbackPromise = tab1.completeCallback(
    new URLSearchParams({
      state: capturedParState,
      code: "oauth-code-xyz",
      iss: config.groupHostUrl,
    }),
  );

  // Wait until Tab 1 is mid-flight inside `/oauth/token` HTTP exchange!
  await tokenExchangeStarted;

  // Tab 2 signs out: bumps cross-tab erasure epoch and deletes `flock-group-oauth:<viewerDid>` on `sharedIdb`
  // (firing `onversionchange` with `newVersion: null` on open connections)!
  await tab2.close();
  await deleteGroupOAuthDatabase(viewerDid, sharedIdb);
  assert.equal(getGroupErasureEpoch(viewerDid), epochBefore + 1);

  // Resume Tab 1's token exchange -> Tab 1 MUST reject, revoke the exchanged token, and NOT resurrect IndexedDB!
  releaseTokenExchange();
  await assert.rejects(callbackPromise, /Signed out in another tab while Group OAuth callback was completing/);
  assert.equal(tab1.isClosed, true, "Tab 1 GroupBrowserOAuthClient permanently closed on cross-tab erasure");
  assert.equal(revokedTokens.length >= 1, true, "Newly issued token revoked at AS after cross-tab sign-out");

  // Shared IndexedDB MUST have zero resurrected databases / sessions for `viewerDid`!
  const remainingDbs = (await sharedIdb.databases()).map((d) => d.name);
  assert.equal(
    remainingDbs.includes(groupOAuthDbName(viewerDid)),
    false,
    "Deleted Group OAuth IndexedDB was never reopened or resurrected by in-flight callback",
  );

  // A fresh Tab 3 opened AFTER sign-out sees zero stored Group sessions (and can sign in cleanly at the new epoch)!
  pauseTokenExchange = false;
  const tab3 = new GroupBrowserOAuthClient({
    viewerDid,
    config,
    idbFactory: sharedIdb,
    fetch: mockOAuthFetch,
  });
  assert.deepEqual(await tab3.listStoredGroupDids(), []);
  await tab3.close();
});

test("Full-page OAuth redirect after prior sign-out succeeds without false-positive erasure while catching in-flight cross-tab sign-out via localStorage generation", async () => {
  const viewerDid = "did:plc:aliceredirectepochfixaa";
  const groupB = "did:plc:groupbbbbbbbbbbbbbbbbbbb";
  const sharedIdb = new IDBFactory();
  const config = {
    appUrl: "http://127.0.0.1:3000",
    plcUrl: "http://127.0.0.1:2582",
    groupHostUrl: "http://127.0.0.1:3004",
    loopback: true,
  };

  const prevDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const rawStorage = new Map<string, string>();
  const mockLocalStorage = {
    get length() {
      return rawStorage.size;
    },
    key: (index: number) => [...rawStorage.keys()][index] ?? null,
    getItem: (key: string) => rawStorage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      rawStorage.set(key, value);
    },
    removeItem: (key: string) => {
      rawStorage.delete(key);
    },
    clear: () => {
      rawStorage.clear();
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: mockLocalStorage,
    configurable: true,
    writable: true,
  });

  try {
    let lastParState = "";
    let nextTokenSub = GROUP_A;
    let tokenCounter = 0;
    const revokedTokens: string[] = [];

    const mockOAuthFetch: typeof globalThis.fetch = async (input, init) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(req.url);
      const didCandidate = decodeURIComponent(url.pathname.slice(1));

      if (url.origin === config.plcUrl && (didCandidate === GROUP_A || didCandidate === groupB)) {
        return Response.json({
          "@context": ["https://www.w3.org/ns/did/v1"],
          id: didCandidate,
          alsoKnownAs: [],
          verificationMethod: [],
          service: [
            {
              id: "#atproto_pds",
              type: "AtprotoPersonalDataServer",
              serviceEndpoint: config.groupHostUrl,
            },
          ],
        });
      }
      if (url.origin === config.groupHostUrl && url.pathname === "/.well-known/oauth-protected-resource") {
        return Response.json({
          resource: config.groupHostUrl,
          authorization_servers: [config.groupHostUrl],
        });
      }
      if (url.origin === config.groupHostUrl && url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: config.groupHostUrl,
          authorization_endpoint: `${config.groupHostUrl}/oauth/authorize`,
          token_endpoint: `${config.groupHostUrl}/oauth/token`,
          pushed_authorization_request_endpoint: `${config.groupHostUrl}/oauth/par`,
          revocation_endpoint: `${config.groupHostUrl}/oauth/revoke`,
          jwks_uri: `${config.groupHostUrl}/oauth/jwks.json`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          dpop_signing_alg_values_supported: ["ES256"],
          scopes_supported: ["atproto", ...groupAdminScopes()],
          authorization_response_iss_parameter_supported: true,
          require_pushed_authorization_requests: true,
          client_id_metadata_document_supported: true,
        });
      }
      if (url.origin === config.groupHostUrl && url.pathname === "/oauth/par") {
        const form = new URLSearchParams(await req.text());
        lastParState = form.get("state") ?? "";
        return new Response(
          JSON.stringify({
            request_uri: `urn:ietf:params:oauth:request_uri:par-${++tokenCounter}`,
            expires_in: 300,
          }),
          {
            status: 201,
            headers: {
              "content-type": "application/json",
              "dpop-nonce": `nonce-par-${tokenCounter}`,
            },
          },
        );
      }
      if (url.origin === config.groupHostUrl && url.pathname === "/oauth/token") {
        const idx = ++tokenCounter;
        return new Response(
          JSON.stringify({
            access_token: `access-${nextTokenSub}-${idx}`,
            refresh_token: `refresh-${nextTokenSub}-${idx}`,
            token_type: "DPoP",
            scope: groupAdminScopes().join(" "),
            sub: nextTokenSub,
            expires_in: 3600,
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "dpop-nonce": `nonce-tok-${idx}`,
            },
          },
        );
      }
      if (url.origin === config.groupHostUrl && url.pathname === "/oauth/revoke") {
        const form = new URLSearchParams(await req.text());
        revokedTokens.push(form.get("token") ?? "");
        return new Response(null, {
          status: 200,
          headers: { "dpop-nonce": `nonce-rev-${++tokenCounter}` },
        });
      }
      return Response.json({ error: "NotFound", message: url.href }, { status: 404 });
    };

    // 1. Viewer signs in to Group A via full-page redirect, then signs out (bumping in-memory epoch >= 1 and clearing localStorage).
    _resetInMemoryGroupAuthStateForNavigationTest();
    const initialTab = new GroupBrowserOAuthClient({
      viewerDid,
      config,
      idbFactory: sharedIdb,
      fetch: mockOAuthFetch,
    });
    nextTokenSub = GROUP_A;
    await initialTab.authorizeGroup({
      groupOrHost: GROUP_A,
      roleScope: "admin",
      appState: { returnTo: "/w", purpose: "admin", groupDid: GROUP_A },
    });
    await initialTab.close();

    _resetInMemoryGroupAuthStateForNavigationTest();
    const initialCallbackDoc = new GroupBrowserOAuthClient({
      viewerDid,
      config,
      idbFactory: sharedIdb,
      fetch: mockOAuthFetch,
    });
    await initialCallbackDoc.completeCallback(
      new URLSearchParams({ state: lastParState, code: "code-a-1", iss: config.groupHostUrl }),
    );
    assert.deepEqual(await initialCallbackDoc.listStoredGroupDids(), [GROUP_A]);
    await initialCallbackDoc.close();

    const signOutRes = await revokeAndEraseGroupOAuthSessions(viewerDid, {
      config,
      idbFactory: sharedIdb,
      fetch: mockOAuthFetch,
    });
    assert.deepEqual(signOutRes, { revokedAll: true, erased: true });
    assert.equal(getGroupErasureEpoch(viewerDid) >= 1, true, "prior sign-out bumped in-memory erasureEpoch >= 1");
    assert.equal(mockLocalStorage.getItem(`${GROUP_OAUTH_ERASURE_EPOCH_PREFIX}${viewerDid}`), null);

    // 2. Viewer signs back in on the SAME long-lived SPA tab (where in-memory `erasureEpoch >= 1`!):
    //    First establishes Group A (e.g. completed in another tab / same origin storage while this SPA tab retains `erasureEpoch >= 1`).
    const tab2 = new GroupBrowserOAuthClient({
      viewerDid,
      config,
      idbFactory: sharedIdb,
      fetch: mockOAuthFetch,
    });
    nextTokenSub = GROUP_A;
    await tab2.authorizeGroup({
      groupOrHost: GROUP_A,
      roleScope: "admin",
      appState: { returnTo: "/w", purpose: "admin", groupDid: GROUP_A },
    });
    await tab2.completeCallback(
      new URLSearchParams({ state: lastParState, code: "code-a-2", iss: config.groupHostUrl }),
    );
    assert.deepEqual(await tab2.listStoredGroupDids(), [GROUP_A]);
    await tab2.close();

    // Confirm our still-loaded SPA tab context STILL has `erasureEpoch >= 1` when starting Group B OAuth!
    assert.equal(getGroupErasureEpoch(viewerDid) >= 1, true);
    revokedTokens.length = 0;

    const longLivedAppTab = new GroupBrowserOAuthClient({
      viewerDid,
      config,
      idbFactory: sharedIdb,
      fetch: mockOAuthFetch,
    });
    nextTokenSub = groupB;
    await longLivedAppTab.authorizeGroup({
      groupOrHost: groupB,
      roleScope: "admin",
      prompt: "login",
      appState: { returnTo: "/w", purpose: "step_up", groupDid: groupB },
    });
    await longLivedAppTab.close();

    // 3. Simulate full-page OAuth redirect to `/oauth/group-callback`: fresh JS context has `erasureEpoch === 0` while `localStorage` + `IDBFactory` persist!
    _resetInMemoryGroupAuthStateForNavigationTest();
    assert.equal(getGroupErasureEpoch(viewerDid), 0);

    const freshCallbackDoc = new GroupBrowserOAuthClient({
      viewerDid,
      config,
      idbFactory: sharedIdb,
      fetch: mockOAuthFetch,
    });
    const completedB = await freshCallbackDoc.completeCallback(
      new URLSearchParams({ state: lastParState, code: "code-b-1", iss: config.groupHostUrl }),
    );
    assert.equal(completedB.groupDid, groupB);
    assert.equal(revokedTokens.length, 0, "legitimate callback after prior sign-out must NOT revoke new or existing group sessions");
    assert.deepEqual(
      await freshCallbackDoc.listStoredGroupDids(),
      [GROUP_A, groupB].sort(),
      "both Group A and Group B sessions remain intact in IndexedDB",
    );
    await freshCallbackDoc.close();

    // 4a. Now verify that if another tab removes `localStorage` `erasureGeneration` during sign-out while the full-page
    //     redirect is in flight (before `completeCallback` runs on the fresh document, while PKCE state is still exchanged),
    //     `completeCallback` detects `genNow !== appState.erasureGeneration`, revokes the issued token, and purges IndexedDB!
    const appTabBeforeSignout = new GroupBrowserOAuthClient({
      viewerDid,
      config,
      idbFactory: sharedIdb,
      fetch: mockOAuthFetch,
    });
    nextTokenSub = groupB;
    await appTabBeforeSignout.authorizeGroup({
      groupOrHost: groupB,
      roleScope: "admin",
      appState: { returnTo: "/w", purpose: "admin", groupDid: groupB },
    });
    await appTabBeforeSignout.close();

    // Another tab initiates sign-out (`deleteGroupOAuthDatabase` on an unshared/pending handle or clearing `localStorage` generation),
    // removing `localStorage` `erasureGeneration` BEFORE the fresh `/oauth/group-callback` document runs!
    await deleteGroupOAuthDatabase(viewerDid, undefined);
    assert.equal(mockLocalStorage.getItem(`${GROUP_OAUTH_ERASURE_EPOCH_PREFIX}${viewerDid}`), null);

    _resetInMemoryGroupAuthStateForNavigationTest();
    assert.equal(getGroupErasureEpoch(viewerDid), 0);
    revokedTokens.length = 0;

    const racedCallbackDoc = new GroupBrowserOAuthClient({
      viewerDid,
      config,
      idbFactory: sharedIdb,
      fetch: mockOAuthFetch,
    });
    await assert.rejects(
      racedCallbackDoc.completeCallback(
        new URLSearchParams({ state: lastParState, code: "code-b-raced", iss: config.groupHostUrl }),
      ),
      /Signed out in another tab while Group OAuth callback was completing/,
    );
    assert.equal(revokedTokens.length >= 1, true, "newly issued token is revoked when localStorage generation was cleared in flight");
    assert.equal(
      (await sharedIdb.databases()).some((d) => d.name === groupOAuthDbName(viewerDid)),
      false,
      "zero resurrected Group OAuth databases remain after in-flight sign-out",
    );

    // 4b. Also verify full `deleteGroupOAuthDatabase(viewerDid, sharedIdb)` completing while redirect is in flight
    //     (wiping both `localStorage` AND `sharedIdb` before `/oauth/group-callback` loads) leaves zero resurrected databases!
    const appTabFullWipe = new GroupBrowserOAuthClient({
      viewerDid,
      config,
      idbFactory: sharedIdb,
      fetch: mockOAuthFetch,
    });
    await appTabFullWipe.authorizeGroup({
      groupOrHost: GROUP_A,
      roleScope: "admin",
      appState: { returnTo: "/w", purpose: "admin", groupDid: GROUP_A },
    });
    await appTabFullWipe.close();

    await deleteGroupOAuthDatabase(viewerDid, sharedIdb);
    _resetInMemoryGroupAuthStateForNavigationTest();

    const wipedCallbackDoc = new GroupBrowserOAuthClient({
      viewerDid,
      config,
      idbFactory: sharedIdb,
      fetch: mockOAuthFetch,
    });
    await assert.rejects(
      wipedCallbackDoc.completeCallback(
        new URLSearchParams({ state: lastParState, code: "code-a-wiped", iss: config.groupHostUrl }),
      ),
      /Signed out in another tab while Group OAuth callback was completing/,
    );
    assert.equal(
      (await sharedIdb.databases()).some((d) => d.name === groupOAuthDbName(viewerDid)),
      false,
      "opening callback after full cross-tab IDB wipe does not leave an empty resurrected DB",
    );
  } finally {
    if (prevDescriptor) {
      Object.defineProperty(globalThis, "localStorage", prevDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  }
});

test("GroupOAuthDatabase migration state store preserves recoveryKey (string and null) across IndexedDB CAS round-trips", async () => {
  const viewerDid = "did:plc:viewerrecoveryroundtrip1";
  const idb = new IDBFactory();
  const client = new GroupBrowserOAuthClient({
    viewerDid,
    config: {
      appUrl: "http://127.0.0.1:3000",
      plcUrl: "https://plc.example.com",
      loopback: true,
      groupHostUrl: "https://groups.example.com",
    },
    idbFactory: idb,
  });

  try {
    const store = client.createMigrationStateStore();
    const savedWithKey = await store.compareAndSet("did:plc:grouprec1111111111111111", null, {
      operationId: "3lblidbrec0001",
      targetOrigin: "https://groups2.example.com",
      handle: "team.groups2.example.com",
      recoveryKey: "did:key:zDnaIdbPersistedKey",
      mode: "standard",
      ticketId: null,
      phase: "prepared",
      negotiatedMode: "standard",
      targetServiceDid: "did:web:groups2.example.com",
      migrationTicket: null,
    });
    assert.equal(savedWithKey.recoveryKey, "did:key:zDnaIdbPersistedKey");
    const loadedWithKey = await store.get("did:plc:grouprec1111111111111111");
    assert.equal(loadedWithKey?.recoveryKey, "did:key:zDnaIdbPersistedKey");

    const savedNullKey = await store.compareAndSet("did:plc:grouprec2222222222222222", null, {
      operationId: "3lblidbrec0002",
      targetOrigin: "https://groups2.example.com",
      handle: "nokey.groups2.example.com",
      recoveryKey: null,
      mode: "coordinated",
      ticketId: null,
      phase: "starting",
    });
    assert.equal(savedNullKey.recoveryKey, null);
    const loadedNullKey = await store.get("did:plc:grouprec2222222222222222");
    assert.equal(loadedNullKey?.recoveryKey, null);
  } finally {
    await client.close();
  }
});

test("GroupBrowserOAuthClient forwards plcUrl into wrapped GroupClient for did:plc Standard target DID verification", async () => {
  const viewerDid = "did:plc:viewerplcurlfwd111111111";
  const groupDid = "did:plc:groupplcurlfwd1111111111";
  const targetPlcDid = "did:plc:targethostdid11111111111";
  const targetOrigin = "https://plc-target.example.com";
  const plcUrl = "https://plc.example.com";
  const fetchedUrls: string[] = [];

  const browserClient = new GroupBrowserOAuthClient({
    viewerDid,
    config: {
      appUrl: "http://127.0.0.1:3000",
      plcUrl,
      loopback: true,
      groupHostUrl: "https://groups.example.com",
    },
    idbFactory: new IDBFactory(),
    fetch: (async (input: RequestInfo | URL) => {
      const reqUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      fetchedUrls.push(reqUrl);
      if (reqUrl === `${targetOrigin}/xrpc/com.atproto.server.describeServer`) {
        return Response.json({ did: targetPlcDid });
      }
      if (reqUrl === `${plcUrl}/${encodeURIComponent(targetPlcDid)}`) {
        return Response.json({
          id: targetPlcDid,
          service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: targetOrigin }],
        });
      }
      if (reqUrl === `${targetOrigin}/xrpc/com.atproto.server.createAccount`) {
        return Response.json({ error: "HandleNotAvailable", message: "stop after verified plc binding" }, { status: 400 });
      }
      return Response.json({ error: "NotFound" }, { status: 404 });
    }) as typeof globalThis.fetch,
  });

  try {
    const wrapped = (
      browserClient as unknown as {
        wrapGroupClient: (
          did: string,
          session: { fetchHandler: (pathname: string, init?: RequestInit) => Promise<Response> },
        ) => GroupClient;
      }
    ).wrapGroupClient(groupDid, {
      fetchHandler: async (pathname) => {
        if (pathname.startsWith("/xrpc/com.atproto.server.getServiceAuth")) {
          return Response.json({ token: "plc-bound-svc-jwt" });
        }
        if (pathname === "/group-admin/abort-migration") {
          return Response.json({ status: "already_absent" });
        }
        return Response.json({ error: "NotFound" }, { status: 404 });
      },
    });

    await assert.rejects(
      wrapped.migrateToHost(targetOrigin, {
        handle: "team.plc-target.example.com",
        mode: "standard",
        operationId: "op-r32-browser-plc-target",
      }),
      /stop after verified plc binding/,
    );
    assert.ok(
      fetchedUrls.includes(`${plcUrl}/${encodeURIComponent(targetPlcDid)}`),
      "wrapped browser GroupClient must resolve did:plc target DIDs via config.plcUrl",
    );
  } finally {
    await browserClient.close();
  }
});
