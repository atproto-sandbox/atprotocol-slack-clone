import assert from "node:assert/strict";
import test from "node:test";
import type { AtprotoDid, OAuthSession } from "@atproto/oauth-client-browser";
import { deskMemberScopes } from "@flock/protocol/scopes";
import { buildDeskClientMetadata, DESK_CLIENT_METADATA_PATH } from "./client-metadata";
import { UnsafeBrowserEndpointUrlError } from "./did-resolver";
import {
  createGuardedOAuthFetch,
  missingDeskScopes,
  restoreDeskSession,
  validateDeskLoginInput,
  wellKnownHandleResolver,
} from "./session";

const asDid = (value: string): null | (string & AtprotoDid) =>
  value.startsWith("did:") ? (value as string & AtprotoDid) : null;

test("buildDeskClientMetadata produces RFC 8252 loopback metadata on HTTP loopback and origin metadata on HTTPS", () => {
  const scope = deskMemberScopes().join(" ");

  const loopback = buildDeskClientMetadata({ appUrl: "http://localhost:3005", scope });
  assert.equal(loopback.client_name, "Flock Desk");
  assert.deepEqual(loopback.redirect_uris, ["http://127.0.0.1:3005/oauth/callback"]);
  assert.ok(loopback.client_id.startsWith("http://localhost?"));
  assert.equal(loopback.client_uri, undefined);
  assert.equal(loopback.dpop_bound_access_tokens, true);

  const prod = buildDeskClientMetadata({ appUrl: "https://desk.example.com", scope });
  assert.equal(prod.client_id, `https://desk.example.com${DESK_CLIENT_METADATA_PATH}`);
  assert.equal(prod.client_uri, "https://desk.example.com");
  assert.deepEqual(prod.redirect_uris, ["https://desk.example.com/oauth/callback"]);
});

test("wellKnownHandleResolver blocks all private/NAT64/6to4/Teredo/metadata/local/disallowed-loopback targets before fetch, enforces redirect:error and 512 B cap", async () => {
  const blockedHandles = [
    "printer.local",
    "meta.internal",
    "10.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "100.64.0.1",
    "[::ffff:169.254.169.254]",
    "[64:ff9b::a9fe:a9fe]",
    "[2002:a9fe:a9fe::1]",
    "[2001::1]",
    "[::a9fe:a9fe]",
    "[fc00::1]",
    "[fe80::1]",
    "[ff02::1]",
  ];

  let fetchCalls = 0;
  const prodResolver = wellKnownHandleResolver(asDid, {
    loopbackAllowed: false,
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response("did:plc:shouldneverreach", { status: 200 });
    },
  });
  const devResolver = wellKnownHandleResolver(asDid, {
    loopbackAllowed: true,
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response("did:plc:shouldneverreach", { status: 200 });
    },
  });

  for (const handle of blockedHandles) {
    assert.equal(await prodResolver.resolve(handle), null, `prod must block ${handle}`);
    assert.equal(await devResolver.resolve(handle), null, `loopback mode must also block ${handle}`);
  }
  // Loopback handles rejected in production mode before fetch
  for (const loopHandle of ["localhost", "alice.localhost", "127.0.0.1", "[::1]"]) {
    assert.equal(await prodResolver.resolve(loopHandle), null, `prod must block loopback ${loopHandle}`);
  }
  assert.equal(fetchCalls, 0, "blocked handles must never trigger fetch()");

  // Valid public handle passes redirect:error and returns parsed DID
  let seenRedirect: RequestRedirect | undefined;
  const okResolver = wellKnownHandleResolver(asDid, {
    loopbackAllowed: false,
    fetchImpl: async (input, init) => {
      seenRedirect = init?.redirect;
      assert.equal(String(input), "https://alice.example/.well-known/atproto-did");
      return new Response("did:plc:alice1234567890123456789\n", { status: 200 });
    },
  });
  assert.equal(await okResolver.resolve("alice.example"), "did:plc:alice1234567890123456789");
  assert.equal(seenRedirect, "error");

  // Oversized response (> 512 bytes) fails closed
  const oversizedResolver = wellKnownHandleResolver(asDid, {
    loopbackAllowed: false,
    fetchImpl: async () => new Response("did:plc:" + "a".repeat(600), { status: 200 }),
  });
  await assert.rejects(() => oversizedResolver.resolve("alice.example"), /512-byte/);
});

test("restoreDeskSession accepts matching deskMemberScopes and rejects sessions missing required Desk scopes", async () => {
  const scope = deskMemberScopes().join(" ");
  const alice = "did:plc:aliceaaaaaaaaaaaaaaaaaaa";
  assert.deepEqual(missingDeskScopes(scope, scope, alice), []);
  assert.ok(missingDeskScopes("atproto", scope, alice).length > 0);

  const mockSession = {
    did: alice,
    getTokenInfo: async () => ({ scope }),
  } as unknown as OAuthSession;

  const restored = await restoreDeskSession(
    { appUrl: "http://127.0.0.1:3005", plcUrl: "http://127.0.0.1:2582", scope },
    async () => mockSession,
  );
  assert.equal(restored?.did, alice);

  const incompleteSession = {
    did: alice,
    getTokenInfo: async () => ({ scope: "atproto" }),
  } as unknown as OAuthSession;
  const rejected = await restoreDeskSession(
    { appUrl: "http://127.0.0.1:3005", plcUrl: "http://127.0.0.1:2582", scope },
    async () => incompleteSession,
  );
  assert.equal(rejected, null);
});

test("createGuardedOAuthFetch blocks private PDS/issuer/metadata endpoints and enforces redirect:error", async () => {
  let calls = 0;
  let capturedPostBody = "";
  let capturedDpopHeader: string | null = null;
  const prodFetch = createGuardedOAuthFetch(false, async (input, init) => {
    calls += 1;
    const effectiveRedirect = init?.redirect ?? (input instanceof Request ? input.redirect : undefined);
    assert.ok(effectiveRedirect === "error" || effectiveRedirect === "manual", `unexpected redirect mode: ${effectiveRedirect}`);
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (urlStr.includes("/xrpc/com.atproto.space.putRecord")) {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      capturedDpopHeader = headers.get("dpop");
      if (init?.body instanceof ArrayBuffer) {
        capturedPostBody = new TextDecoder().decode(init.body);
      } else if (typeof init?.body === "string") {
        capturedPostBody = init.body;
      }
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  for (const unsafe of [
    "https://10.0.0.1/.well-known/oauth-authorization-server",
    "https://169.254.169.254/latest/meta-data/",
    "https://192.168.1.10/.well-known/oauth-protected-resource",
    "https://[fc00::1]/oauth/par",
    "https://[fe80::1]/oauth/token",
    "https://internal.local/.well-known/atproto-did",
    "https://service.internal/xrpc/com.atproto.server.describeServer",
    "http://127.0.0.1:2583/.well-known/oauth-protected-resource",
  ]) {
    await assert.rejects(() => prodFetch(unsafe), UnsafeBrowserEndpointUrlError, `must block ${unsafe}`);
    await assert.rejects(() => prodFetch(new Request(unsafe)), UnsafeBrowserEndpointUrlError, `must block Request(${unsafe})`);
  }
  await assert.rejects(
    () => prodFetch("https://user:pass@pds.example.com/xrpc/com.atproto.space.listRecords"),
    UnsafeBrowserEndpointUrlError,
    "must block URL with embedded credentials",
  );
  assert.equal(calls, 0, "blocked OAuth URLs must never reach fetch()");

  const ok = await prodFetch("https://pds.example.com/xrpc/com.atproto.space.listRecords?space=at%3A%2F%2Fdid%3Aplc%3Aabc&repo=did%3Aplc%3Aabc", { redirect: "follow" });
  assert.equal(ok.status, 200);
  const okReq = await prodFetch(
    new Request("https://auth.example.com/oauth/par", {
      method: "POST",
      body: "client_id=test",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    }),
  );
  assert.equal(okReq.status, 200);
  const okFollowReq = await prodFetch(
    new Request("https://auth.example.com/xrpc/com.atproto.space.putRecord", {
      method: "POST",
      body: JSON.stringify({ hello: "world" }),
      headers: { "content-type": "application/json", dpop: "proof-jwt" },
    }),
  );
  assert.equal(okFollowReq.status, 200);
  assert.equal(capturedDpopHeader, "proof-jwt");
  assert.equal(capturedPostBody, JSON.stringify({ hello: "world" }));
  assert.equal(calls, 3);
});

test("validateDeskLoginInput accepts handles and DIDs and rejects raw server URLs", () => {
  assert.equal(validateDeskLoginInput("  alice.example  "), "alice.example");
  assert.equal(validateDeskLoginInput("did:plc:alice1234567890123456789"), "did:plc:alice1234567890123456789");
  assert.equal(validateDeskLoginInput("did:web:alice.example"), "did:web:alice.example");

  for (const bad of ["", "   ", "https://pds.evil.example", "http://127.0.0.1:2583", "alice.example/path", "alice example"]) {
    assert.throws(() => validateDeskLoginInput(bad), /ATProto handle|sign in/i, `must reject ${JSON.stringify(bad)}`);
  }
});
