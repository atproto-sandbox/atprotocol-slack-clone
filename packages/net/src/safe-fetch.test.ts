import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { assertSafeEndpoint, safeFetch } from "./safe-fetch";

const production = () => false;
const loopbackDevelopment = () => true;

async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port };
}
const close = (server: Server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

test("outside loopback development, plain http and private, loopback or metadata addresses are refused", async () => {
  await assert.rejects(assertSafeEndpoint("http://127.0.0.1:2583", production), /unsafe PDS endpoint/i);
  await assert.rejects(assertSafeEndpoint("https://10.0.0.8:2583", production), /non-public address/i);
  await assert.rejects(assertSafeEndpoint("https://169.254.169.254/latest/meta-data", production), /non-public address/i);
  await assert.rejects(assertSafeEndpoint("https://localhost:2583", production), /non-public PDS endpoint/i);
  await assert.rejects(safeFetch(production)("https://[::1]:2583/xrpc/x"), /non-public address/i);
});

test("loopback development reaches its loopback host, at the address it checked", async () => {
  const { server, port } = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("pinned");
  });
  try {
    const response = await safeFetch(loopbackDevelopment)(new Request(`http://127.0.0.1:${port}/xrpc/test?space=at%3A%2F%2Fdid%3Aplc%3Aowner%2Fspace%2Fnew.flock.channel%2Facme-general`));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "pinned");
    await assert.rejects(safeFetch(production)(`http://127.0.0.1:${port}/`), /unsafe PDS endpoint/i, "the same host outside development");
  } finally {
    await close(server);
  }
});

test("no redirect is followed", async () => {
  let reached = 0;
  const target = await listen((_request, response) => { reached += 1; response.end("must not be reached"); });
  const source = await listen((_request, response) => {
    response.writeHead(302, { location: `http://127.0.0.1:${target.port}/redirect-target` });
    response.end();
  });
  try {
    await assert.rejects(safeFetch(loopbackDevelopment)(new Request(`http://127.0.0.1:${source.port}/redirect-source`)));
    assert.equal(reached, 0);
  } finally {
    await Promise.all([close(source.server), close(target.server)]);
  }
});

test("a host checked under loopback development is checked again, not taken from the cache, outside it", async () => {
  await assertSafeEndpoint("https://127.0.0.1:2583", loopbackDevelopment);
  await assert.rejects(assertSafeEndpoint("https://127.0.0.1:2583", production), /non-public address/i);
});

test("a request whose host answers too slowly is given up at its deadline, its body included", async () => {
  const { server, port } = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    const drip = setInterval(() => response.write("."), 50);
    response.on("close", () => clearInterval(drip));
  });
  try {
    const started = Date.now();
    const response = await safeFetch(loopbackDevelopment, 300)(`http://127.0.0.1:${port}/slow`);
    await assert.rejects(response.text());
    assert.ok(Date.now() - started < 2_000, `given up at its deadline (${Date.now() - started} ms)`);
  } finally {
    server.closeAllConnections();
    await close(server);
  }
});

test("a request whose host never answers ends at its deadline as a timeout, which the operator does not retry under its lock", async () => {
  // #given a host that accepts the connection and never answers
  const { server, port } = await listen(() => undefined);
  try {
    // #when a request is sent to it with a short deadline
    const sent = safeFetch(loopbackDevelopment, 300)(`http://127.0.0.1:${port}/silent`);

    // #then it ends as a timeout, before any answer
    await assert.rejects(sent, { name: "TimeoutError" });
  } finally {
    server.closeAllConnections();
    await close(server);
  }
});
