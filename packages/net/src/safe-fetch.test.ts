import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import test from "node:test";
import {
  assertSafeEndpoint,
  boundedSafeFetch,
  BOUNDED_FETCH_PROFILES,
  safeFetch,
  UpstreamContentTypeError,
  UpstreamResponseTooLargeError,
} from "./safe-fetch";

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

test("an IPv6 address that a translation or tunnel turns into an IPv4 one is refused, whatever IPv4 address it carries", async () => {
  // #then NAT64's well-known prefix (here, the metadata address), 6to4, Teredo, IPv4-compatible and the 6to4 relay are all refused
  for (const endpoint of [
    "https://[64:ff9b::a9fe:a9fe]", "https://[64:ff9b::a00:1]", "https://[2002:a00:1::1]",
    "https://[2001:0:4136:e378:8000:63bf:3fff:fdd2]", "https://[::a9fe:a9fe]", "https://192.88.99.1",
  ]) await assert.rejects(assertSafeEndpoint(endpoint, production), /non-public address/i, endpoint);
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

test("boundedSafeFetch enforces allowedContentTypes, gzip-bomb decompressed maxResponseBytes, slow-loris deadlineMs, and no redirects", async () => {
  const gzipBomb = gzipSync(Buffer.alloc(128 * 1024, 0x41));
  assert.ok(gzipBomb.byteLength < 2048, "compressed payload fits well under maxResponseBytes");

  const { server, port } = await listen((req, res) => {
    if (req.url === "/ok-json") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === "/empty-ok") {
      res.writeHead(200, { "content-length": "0" });
      res.end();
      return;
    }
    if (req.url === "/wrong-mime") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>not json</html>");
      return;
    }
    if (req.url === "/missing-mime") {
      res.writeHead(200);
      res.write('{"surprise":true}');
      res.end();
      return;
    }
    if (req.url === "/large-header") {
      res.writeHead(200, { "content-type": "application/json", "content-length": "999999" });
      res.end("{}");
      return;
    }
    if (req.url === "/gzip-bomb") {
      res.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "gzip",
      });
      res.end(gzipBomb);
      return;
    }
    if (req.url === "/slow-loris") {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"a":"');
      const timer = setInterval(() => res.write("x"), 60);
      res.on("close", () => clearInterval(timer));
      return;
    }
    if (req.url === "/redirect") {
      res.writeHead(302, { location: `http://127.0.0.1:${port}/ok-json` });
      res.end();
      return;
    }
    res.writeHead(404).end();
  });

  try {
    const fetcher = boundedSafeFetch(loopbackDevelopment, {
      deadlineMs: 250,
      maxResponseBytes: 4096,
      allowedContentTypes: ["application/json"],
    });

    // Valid JSON and empty 200 succeed
    const okRes = await fetcher(`http://127.0.0.1:${port}/ok-json`);
    assert.deepEqual(await okRes.json(), { ok: true });
    const emptyRes = await fetcher(`http://127.0.0.1:${port}/empty-ok`);
    assert.equal(await emptyRes.text(), "");

    // Wrong MIME rejected before body read
    await assert.rejects(
      fetcher(`http://127.0.0.1:${port}/wrong-mime`),
      (err: unknown) => err instanceof UpstreamContentTypeError,
    );

    // Missing Content-Type on non-empty chunked body rejected
    await assert.rejects(
      async () => {
        const res = await fetcher(`http://127.0.0.1:${port}/missing-mime`);
        await res.text();
      },
      (err: unknown) => err instanceof UpstreamContentTypeError,
    );

    // Oversized Content-Length rejected before body read
    await assert.rejects(
      fetcher(`http://127.0.0.1:${port}/large-header`),
      (err: unknown) => err instanceof UpstreamResponseTooLargeError,
    );

    // Gzip bomb expanding past 4 KiB decompressed limit aborted mid-stream
    await assert.rejects(
      async () => {
        const res = await fetcher(`http://127.0.0.1:${port}/gzip-bomb`);
        await res.arrayBuffer();
      },
      (err: unknown) => err instanceof UpstreamResponseTooLargeError,
    );

    // Slow-loris chunked stream aborted at deadlineMs
    await assert.rejects(async () => {
      const res = await fetcher(`http://127.0.0.1:${port}/slow-loris`);
      await res.text();
    });

    // Redirect rejected
    await assert.rejects(fetcher(`http://127.0.0.1:${port}/redirect`));

    // Named profiles match plan specification
    assert.equal(BOUNDED_FETCH_PROFILES.oauthMetadata.maxResponseBytes, 262_144);
    assert.equal(BOUNDED_FETCH_PROFILES.migrationManifest.maxResponseBytes, 4_194_304);
  } finally {
    server.closeAllConnections();
    await close(server);
  }
});
