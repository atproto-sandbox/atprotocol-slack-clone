import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { assertSafePdsEndpoint, fetchIdResolverEndpoint, fetchValidatedEndpoint } from "./identity";
import { UpstreamResponseTooLargeError } from "@/lib/bounded-json";

test("PDS endpoints reject HTTP and private address literals in production config", async () => {
  Reflect.set(process.env, "NODE_ENV", "production");
  process.env.APP_URL = "http://127.0.0.1:3000";
  process.env.AUTH_ENCRYPTION_KEY = "44".repeat(32);
  process.env.OPERATOR_SERVICE_REF = "did:web:spaces.example#atproto_flock_operator";
  process.env.PLC_URL = "https://plc.directory";
  await assert.rejects(assertSafePdsEndpoint("http://127.0.0.1:2583"), /unsafe PDS endpoint/i);
  await assert.rejects(assertSafePdsEndpoint("https://10.0.0.8:2583"), /non-public address/i);
  await assert.rejects(assertSafePdsEndpoint("https://169.254.169.254/latest/meta-data"), /non-public address/i);
});

test("PDS fetch uses the validated address through its pinned dispatcher", async () => {
  Reflect.set(process.env, "NODE_ENV", "development");
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("pinned");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const response = await fetchValidatedEndpoint(new Request(`http://127.0.0.1:${address.port}/xrpc/test?space=at%3A%2F%2Fdid%3Aplc%3Aowner%2Fspace%2Fnew.flock.channel%2Facme-general`));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "pinned");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("validated endpoint fetch rejects redirects", async () => {
  Reflect.set(process.env, "NODE_ENV", "development");
  let redirectedRequestCount = 0;
  const target = createServer((_request, response) => {
    redirectedRequestCount += 1;
    response.end("must not be reached");
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const targetPort = (target.address() as AddressInfo).port;
  const source = createServer((_request, response) => {
    response.writeHead(302, { location: `http://127.0.0.1:${targetPort}/redirect-target` });
    response.end();
  });
  await new Promise<void>((resolve) => source.listen(0, "127.0.0.1", resolve));
  try {
    const sourcePort = (source.address() as AddressInfo).port;
    await assert.rejects(fetchValidatedEndpoint(new Request(`http://127.0.0.1:${sourcePort}/redirect-source`)));
    assert.equal(redirectedRequestCount, 0);
  } finally {
    await Promise.all([source, target].map((server) =>
      new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  }
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
