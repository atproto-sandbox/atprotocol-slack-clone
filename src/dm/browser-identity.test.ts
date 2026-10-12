import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { clearBrowserIdentityCache, resolveHandle, resolvePds, type BrowserIdentityConfig } from "./browser-identity";

type FetchCall = { url: string; redirect: string | undefined };

const config: BrowserIdentityConfig = { plcUrl: "https://plc.example", loopback: false };
const loopbackConfig: BrowserIdentityConfig = { plcUrl: "http://127.0.0.1:4000", loopback: true };

const realFetch = globalThis.fetch;
const realNow = Date.now;
let calls: FetchCall[] = [];
let responder: (url: string) => Response;

function fakeFetch(url: string, init?: RequestInit): Promise<Response> {
  calls.push({ url: String(url), redirect: init?.redirect ?? undefined });
  return Promise.resolve(responder(String(url)));
}

function jsonDocument(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  clearBrowserIdentityCache();
  calls = [];
  responder = () => jsonDocument({}, 404);
  globalThis.fetch = fakeFetch as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  Date.now = realNow;
});

test("resolvePds reads #atproto_pds for did:plc through the PLC directory and caches the document", async () => {
  responder = (url) => {
    assert.equal(url, "https://plc.example/did:plc:alice");
    return jsonDocument({
      id: "did:plc:alice",
      service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://pds.example" }],
    });
  };
  assert.equal(await resolvePds("did:plc:alice", config), "https://pds.example");
  assert.equal(await resolvePds("did:plc:alice", config), "https://pds.example");
  assert.equal(calls.length, 1, "the second resolution is served from the in-memory cache");
  assert.equal(calls[0]!.redirect, "error", "DID document fetches never follow redirects");
});

test("the DID document cache expires after ten minutes", async () => {
  let now = 1_000_000;
  Date.now = () => now;
  responder = () => jsonDocument({
    id: "did:plc:bob",
    service: [{ id: "#atproto_pds", serviceEndpoint: "https://pds.example" }],
  });
  await resolvePds("did:plc:bob", config);
  now += 9 * 60 * 1000;
  await resolvePds("did:plc:bob", config);
  assert.equal(calls.length, 1);
  now += 2 * 60 * 1000;
  await resolvePds("did:plc:bob", config);
  assert.equal(calls.length, 2, "the cache is re-fetched past the ten-minute TTL");
});

test("resolvePds resolves did:web through /.well-known/did.json", async () => {
  responder = (url) => {
    assert.equal(url, "https://spaces.example/.well-known/did.json");
    return jsonDocument({
      id: "did:web:spaces.example",
      service: [{ id: "did:web:spaces.example#atproto_pds", serviceEndpoint: "https://pds.spaces.example" }],
    });
  };
  assert.equal(await resolvePds("did:web:spaces.example", config), "https://pds.spaces.example");
});

test("did:web loopback hosts use http only when the app runs on loopback", async () => {
  responder = (url) => {
    assert.equal(url, "http://localhost:3000/.well-known/did.json");
    return jsonDocument({
      id: "did:web:localhost%3A3000",
      service: [{ id: "#atproto_pds", serviceEndpoint: "http://localhost:3000" }],
    });
  };
  assert.equal(await resolvePds("did:web:localhost%3A3000", loopbackConfig), "http://localhost:3000");
  assert.equal(calls[0]!.redirect, "error");

  clearBrowserIdentityCache();
  responder = () => jsonDocument({
    id: "did:web:localhost%3A3000",
    service: [{ id: "#atproto_pds", serviceEndpoint: "https://pds.example" }],
  });
  assert.equal(await resolvePds("did:web:localhost%3A3000", config), "https://pds.example");
  assert.equal(calls[1]!.url, "https://localhost:3000/.well-known/did.json", "without loopback development the document is fetched over https");
});

test("PDS endpoints must be https unless both endpoint and app are loopback", async () => {
  const expectEndpoint = async (did: string, serviceEndpoint: string, browser: BrowserIdentityConfig, expected: string | RegExp) => {
    clearBrowserIdentityCache();
    responder = () => jsonDocument({ id: did, service: [{ id: "#atproto_pds", serviceEndpoint }] });
    if (typeof expected === "string") assert.equal(await resolvePds(did, browser), expected);
    else await assert.rejects(resolvePds(did, browser), expected);
  };

  await expectEndpoint("did:plc:carol", "http://pds.example", config, /HTTPS outside loopback/);
  await expectEndpoint("did:plc:dave", "http://10.0.0.5", loopbackConfig, /HTTPS outside loopback/);
  await expectEndpoint("did:plc:erin", "http://127.0.0.1:4001", loopbackConfig, "http://127.0.0.1:4001");
  await expectEndpoint("did:plc:frank", "https://user:pass@pds.example", config, /unsafe components/);
  await expectEndpoint("did:plc:gina", "https://pds.example/steal?x=1", config, /unsafe components/);
  await expectEndpoint("did:plc:hank", "not a url", config, /invalid PDS endpoint/);
});

test("malformed or foreign DID documents are rejected", async () => {
  const respond = (body: unknown) => {
    clearBrowserIdentityCache();
    responder = () => jsonDocument(body);
  };

  respond({ id: "did:plc:mallory", service: [{ id: "#atproto_pds", serviceEndpoint: "https://pds.example" }] });
  await assert.rejects(resolvePds("did:plc:alice", config), /does not match the requested DID/);

  respond({ id: "did:plc:alice" });
  await assert.rejects(resolvePds("did:plc:alice", config), /no #atproto_pds service entry/);

  respond({ id: "did:plc:alice", service: [{ id: "#other", serviceEndpoint: "https://pds.example" }] });
  await assert.rejects(resolvePds("did:plc:alice", config), /no #atproto_pds service entry/);

  respond({ id: "did:plc:alice", service: [{ id: "#atproto_pds", serviceEndpoint: 42 }] });
  await assert.rejects(resolvePds("did:plc:alice", config), /no usable #atproto_pds service endpoint/);

  clearBrowserIdentityCache();
  responder = () => new Response("not-json", { status: 200, headers: { "content-type": "application/json" } });
  await assert.rejects(resolvePds("did:plc:alice", config), /not a JSON object/);

  clearBrowserIdentityCache();
  responder = () => jsonDocument({}, 500);
  await assert.rejects(resolvePds("did:plc:alice", config), /Could not resolve did:plc:alice \(500\)/);
});

test("oversized DID documents never reach the parser", async () => {
  responder = () => new Response(`{"id":"did:plc:alice","pad":"${"x".repeat(300 * 1024)}"}`, { status: 200, headers: { "content-type": "application/json" } });
  await assert.rejects(resolvePds("did:plc:alice", config), /exceeds the \d+-byte limit/);
});

test("only did:plc and single-segment did:web identifiers resolve", async () => {
  await assert.rejects(resolvePds("did:key:z6Mkf", config), /Only did:plc and did:web/);
  await assert.rejects(resolvePds("did:web:spaces.example:alice", config), /path segments are not supported/);
  await assert.rejects(resolvePds("did:web:", config), /Invalid DID/);
  await assert.rejects(resolvePds("did:web:%20x", config), /host is malformed/);
  await assert.rejects(resolvePds("did:web:evil.com%2F.attacker.com", config), /host is malformed/);
  await assert.rejects(resolvePds("did:web:evil.com%40attacker.com", config), /host is malformed/);
  await assert.rejects(resolvePds("not-a-did", config), /Invalid DID/);
  assert.equal(calls.length, 0, "rejected identifiers never produce a fetch");
});

test("resolveHandle reads the first at:// entry from alsoKnownAs for display", async () => {
  responder = () => jsonDocument({
    id: "did:plc:alice",
    alsoKnownAs: ["at://alice.test", "at://backup.test"],
    service: [{ id: "#atproto_pds", serviceEndpoint: "https://pds.example" }],
  });
  assert.equal(await resolveHandle("did:plc:alice", config), "alice.test");

  clearBrowserIdentityCache();
  responder = () => jsonDocument({ id: "did:plc:bob", alsoKnownAs: ["https://example.com/bob"] });
  assert.equal(await resolveHandle("did:plc:bob", config), null);

  clearBrowserIdentityCache();
  responder = () => jsonDocument({ id: "did:plc:carol" });
  assert.equal(await resolveHandle("did:plc:carol", config), null);
});
