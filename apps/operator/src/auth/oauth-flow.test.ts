import assert from "node:assert/strict";
import { NodeOAuthClient, type NodeSavedState } from "@atproto/oauth-client-node";
import test from "node:test";
import {
  assertOAuthFlowAppState,
  createOAuthFlowCookieValue,
  createOAuthFlowState,
  oauthFlowCookieName,
  readOAuthFlowCookieValue,
  startOAuthFlow,
  trackOAuthStateStore,
} from "./oauth-flow";

test("OAuth flow cookie binds one browser to its state and expected permission DID", () => {
  const key = Buffer.from("55".repeat(32), "hex");
  const state = createOAuthFlowState();
  const appState = createOAuthFlowState();
  const flowLockToken = "11111111-1111-4111-8111-111111111111";
  const value = createOAuthFlowCookieValue(state, { kind: "permission", expectedDid: "did:plc:alice", appState, flowLockToken }, key);

  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(oauthFlowCookieName(state), oauthFlowCookieName(createOAuthFlowState()));
  assert.deepEqual(readOAuthFlowCookieValue(state, value, key), { kind: "permission", expectedDid: "did:plc:alice", appState, flowLockToken });
  assert.equal(readOAuthFlowCookieValue(createOAuthFlowState(), value, key), null);
  assert.equal(readOAuthFlowCookieValue(state, `${value}x`, key), null);
  assert.equal(readOAuthFlowCookieValue(state, value, Buffer.from("66".repeat(32), "hex")), null);
});

test("OAuth flow cookie supports browser-bound login without a preexisting DID", () => {
  const key = Buffer.from("77".repeat(32), "hex");
  const state = createOAuthFlowState();
  const appState = createOAuthFlowState();
  const value = createOAuthFlowCookieValue(state, { kind: "login", appState }, key);
  assert.deepEqual(readOAuthFlowCookieValue(state, value, key), { kind: "login", appState });
});

test("browser flow binds the SDK callback state separately from app state with and without PAR", async () => {
  const baseMetadata = {
    issuer: "https://pds.test",
    authorization_endpoint: "https://pds.test/authorize",
    token_endpoint: "https://pds.test/token",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    dpop_signing_alg_values_supported: ["ES256K"],
    scopes_supported: ["atproto"],
    client_id_metadata_document_supported: true,
  };
  const key = Buffer.from("88".repeat(32), "hex");
  for (const usePar of [false, true]) {
    const stateRecords = new Map<string, NodeSavedState>();
    const sessionRecords = new Map<string, unknown>();
    const stateStore = trackOAuthStateStore({
      get: async (key: string) => stateRecords.get(key),
      set: async (key: string, value: NodeSavedState) => { stateRecords.set(key, value); },
      del: async (key: string) => { stateRecords.delete(key); },
    });
    const metadata = usePar
      ? { ...baseMetadata, pushed_authorization_request_endpoint: "https://pds.test/par", require_pushed_authorization_requests: true }
      : baseMetadata;
    const client = new NodeOAuthClient({
      clientMetadata: {
        client_id: "https://app.test/oauth/client-metadata.json",
        client_name: "Test",
        client_uri: "https://app.test",
        redirect_uris: ["https://app.test/oauth/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        scope: "atproto",
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        application_type: "web",
        dpop_bound_access_tokens: true,
      },
      stateStore: stateStore.store,
      sessionStore: {
        get: async (key: string) => sessionRecords.get(key),
        set: async (key: string, value: unknown) => { sessionRecords.set(key, value); },
        del: async (key: string) => { sessionRecords.delete(key); },
      } as never,
      requestLock: async (_name, callback) => callback(),
      fetch: async (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname === "/.well-known/oauth-protected-resource") return new Response(null, { status: 404 });
        if (url.pathname === "/.well-known/oauth-authorization-server") {
          return Response.json(metadata, { headers: { "content-type": "application/json" } });
        }
        if (url.pathname === "/par") return Response.json({ request_uri: "urn:example:par-request", expires_in: 60 });
        throw new Error(`Unexpected OAuth fixture request: ${url}`);
      },
    });
    const flowClient = Object.assign(client, {
      takeProtocolStateForAppState: stateStore.takeProtocolStateForAppState,
    });
    const flow = await startOAuthFlow(flowClient, "https://pds.test", { scope: "atproto" }, { kind: "login", clientScope: "atproto" }, key);
    const sdkState = flow.state;
    assert.equal(flow.url.searchParams.get("state"), usePar ? null : sdkState);
    assert.notEqual(sdkState, flow.binding.appState);
    assert.deepEqual(readOAuthFlowCookieValue(sdkState, flow.cookieValue, key), flow.binding);

    const callbackParams = new URLSearchParams({ state: sdkState, error: "access_denied" });
    await assert.rejects(client.callback(callbackParams), (error: unknown) => {
      assert.equal((error as { state?: string }).state, flow.binding.appState);
      return true;
    });
    assert.doesNotThrow(() => assertOAuthFlowAppState(flow.binding, flow.binding.appState));
    assert.throws(() => assertOAuthFlowAppState(flow.binding, sdkState));
  }
});
