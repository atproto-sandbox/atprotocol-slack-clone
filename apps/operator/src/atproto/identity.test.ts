import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { assertSafePdsEndpoint, fetchIdResolverEndpoint, resolvePds, setIdentityTestOverrides } from "./identity";
import { UpstreamResponseTooLargeError } from "@flock/protocol/bounded-json";

test("the operator's endpoint check refuses a private address outside loopback development", async () => {
  Reflect.set(process.env, "NODE_ENV", "production");
  process.env.APP_URL = "http://127.0.0.1:3000";
  process.env.AUTH_ENCRYPTION_KEY = "44".repeat(32);
  process.env.OPERATOR_SERVICE_REF = "did:web:spaces.example#atproto_flock_operator";
  process.env.PLC_URL = "https://plc.directory";
  await assert.rejects(assertSafePdsEndpoint("http://127.0.0.1:2583"), /unsafe PDS endpoint/i);
  await assert.rejects(assertSafePdsEndpoint("https://10.0.0.8:2583"), /non-public address/i);
});

test("identity resolver fetch preserves response metadata and caps actual streamed bytes", async () => {
  Reflect.set(process.env, "NODE_ENV", "development");
  const server = createServer((request, response) => {
    if (request.url === "/small") {
      response.writeHead(201, { "content-type": "application/json", "x-resolver": "preserved" });
      response.end('{"ok":true}');
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(Buffer.alloc(256 * 1024 + 1, "x"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const small = await fetchIdResolverEndpoint(`http://127.0.0.1:${address.port}/small`);
    assert.equal(small.status, 201);
    assert.equal(small.headers.get("x-resolver"), "preserved");
    assert.deepEqual(await small.json(), { ok: true });

    const oversized = await fetchIdResolverEndpoint(`http://127.0.0.1:${address.port}/large`);
    await assert.rejects(oversized.text(), UpstreamResponseTooLargeError);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("resolvePds forwards { forceRefresh: true } to resolver overrides", async () => {
  const seen: Array<{ did: string; forceRefresh?: boolean }> = [];
  setIdentityTestOverrides({
    resolvePds: async (did, options) => {
      seen.push({ did, ...(options?.forceRefresh !== undefined ? { forceRefresh: options.forceRefresh } : {}) });
      return options?.forceRefresh ? "https://groups2.example" : "https://groups1.example";
    },
    resolveKemKey: async () => "did:key:zKem",
    resolveSigningKey: async () => "did:key:zSig",
    fetchEndpoint: async () => new Response("{}", { status: 200 }),
  });
  try {
    assert.equal(await resolvePds("did:plc:group1"), "https://groups1.example");
    assert.equal(await resolvePds("did:plc:group1", { forceRefresh: true }), "https://groups2.example");
    assert.deepEqual(seen, [
      { did: "did:plc:group1" },
      { did: "did:plc:group1", forceRefresh: true },
    ]);
  } finally {
    setIdentityTestOverrides(undefined);
  }
});
