import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import dgram from "node:dgram";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  lexiconDnsHostname,
  loadVendoredPublicLexicons,
  nsidAuthorityDomain,
  parseLexiconDnsTxt,
  verifyPublicLexicons,
} from "../../../scripts/verify-public-lexicons.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const FLOCK_AUTH_DID = "did:plc:flocklexauthority2345672";
const OPENSOCIAL_AUTH_DID = "did:plc:opensoclexauth2345672345";

test("loadVendoredPublicLexicons discovers both _lexicon.flock.new and _lexicon.opensocial.group authorities", () => {
  const entries = loadVendoredPublicLexicons(REPO_ROOT);
  const opensocial = entries.filter((e) => e.id.startsWith("group.opensocial."));
  const flock = entries.filter((e) => e.id.startsWith("new.flock."));
  assert.equal(opensocial.length, 27);
  assert.ok(flock.length >= 30);
  assert.equal(nsidAuthorityDomain("group.opensocial.meta"), "opensocial.group");
  assert.equal(lexiconDnsHostname("group.opensocial.meta"), "_lexicon.opensocial.group");
  assert.equal(nsidAuthorityDomain("new.flock.workspace"), "flock.new");
  assert.equal(lexiconDnsHostname("new.flock.workspace"), "_lexicon.flock.new");
  assert.equal(lexiconDnsHostname("new.flock.channel.message"), "_lexicon.channel.flock.new");

  // Multi-chunk TXT join and single-record DID validation
  assert.equal(parseLexiconDnsTxt([[`did=${OPENSOCIAL_AUTH_DID.slice(0, 12)}`, OPENSOCIAL_AUTH_DID.slice(12)]]), OPENSOCIAL_AUTH_DID);
  assert.equal(parseLexiconDnsTxt([]), null);
  assert.equal(parseLexiconDnsTxt([[`did=${FLOCK_AUTH_DID}`], [`did=${OPENSOCIAL_AUTH_DID}`]]), null);
  assert.equal(parseLexiconDnsTxt([["did=not-a-valid-did"]]), null);
});

test("verifyPublicLexicons succeeds when all DNS TXT authorities and XRPC schema records match local lexicons", async () => {
  const entries = loadVendoredPublicLexicons(REPO_ROOT);
  const schemaByDidAndNsid = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    const did = entry.id.startsWith("group.opensocial.") ? OPENSOCIAL_AUTH_DID : FLOCK_AUTH_DID;
    schemaByDidAndNsid.set(`${did}:${entry.id}`, {
      $type: "com.atproto.lexicon.schema",
      ...entry.schema,
    });
  }

  const result = await verifyPublicLexicons({
    repoRoot: REPO_ROOT,
    plcUrl: "https://plc.example",
    resolveTxt: async (hostname) => {
      if (hostname === "_lexicon.opensocial.group") return [[`did=${OPENSOCIAL_AUTH_DID}`]];
      if (hostname.endsWith(".flock.new")) return [[`did=${FLOCK_AUTH_DID}`]];
      throw Object.assign(new Error(`queryTxt ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
    },
    fetchImpl: async (input, init) => {
      assert.equal(init?.redirect, "error");
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      if (url.origin === "https://plc.example") {
        const did = decodeURIComponent(url.pathname.slice(1));
        const pdsEndpoint =
          did === OPENSOCIAL_AUTH_DID ? "https://pds.opensocial.example" : "https://pds.flock.example";
        return new Response(
          JSON.stringify({
            id: did,
            service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: pdsEndpoint }],
          }),
          { status: 200, headers: { "content-type": "application/did+ld+json" } },
        );
      }
      if (url.pathname === "/xrpc/com.atproto.repo.getRecord") {
        const repo = url.searchParams.get("repo") ?? "";
        const collection = url.searchParams.get("collection") ?? "";
        const rkey = url.searchParams.get("rkey") ?? "";
        assert.equal(collection, "com.atproto.lexicon.schema");
        const value = schemaByDidAndNsid.get(`${repo}:${rkey}`);
        if (!value) {
          return new Response(JSON.stringify({ error: "RecordNotFound" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({ uri: `at://${repo}/${collection}/${rkey}`, cid: "bafyreibogus", value }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    },
  });

  assert.equal(result.verifiedCount, entries.length);
  assert.equal(result.authorities["_lexicon.opensocial.group"], OPENSOCIAL_AUTH_DID);
  assert.equal(result.authorities["_lexicon.flock.new"], FLOCK_AUTH_DID);
});

test("verifyPublicLexicons fails closed on missing DNS TXT, missing schema record, or drifted schema definition", async () => {
  const entries = loadVendoredPublicLexicons(REPO_ROOT);

  // 1. Missing _lexicon.opensocial.group DNS TXT
  await assert.rejects(
    () =>
      verifyPublicLexicons({
        repoRoot: REPO_ROOT,
        plcUrl: "https://plc.example",
        resolveTxt: async (hostname) => {
          if (hostname.endsWith(".flock.new")) return [[`did=${FLOCK_AUTH_DID}`]];
          throw Object.assign(new Error(`queryTxt ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
        },
        fetchImpl: async (input) => {
          const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
          if (url.origin === "https://plc.example") {
            const did = decodeURIComponent(url.pathname.slice(1));
            return new Response(
              JSON.stringify({
                id: did,
                service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://pds.flock.example" }],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          const rkey = url.searchParams.get("rkey") ?? "";
          const local = entries.find((e) => e.id === rkey) ?? entries[0]!;
          return new Response(
            JSON.stringify({ value: { $type: "com.atproto.lexicon.schema", ...local.schema } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      }),
    /_lexicon\.opensocial\.group/,
  );

  // 2. Drifted remote schema definition for group.opensocial.meta
  await assert.rejects(
    () =>
      verifyPublicLexicons({
        repoRoot: REPO_ROOT,
        plcUrl: "https://plc.example",
        resolveTxt: async (hostname) =>
          hostname === "_lexicon.opensocial.group" ? [[`did=${OPENSOCIAL_AUTH_DID}`]] : [[`did=${FLOCK_AUTH_DID}`]],
        fetchImpl: async (input) => {
          const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
          if (url.origin === "https://plc.example") {
            const did = decodeURIComponent(url.pathname.slice(1));
            return new Response(
              JSON.stringify({
                id: did,
                service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://pds.example" }],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          const rkey = url.searchParams.get("rkey") ?? "";
          const local = entries.find((e) => e.id === rkey)!;
          const schema =
            rkey === "group.opensocial.meta"
              ? { ...local.schema, defs: { main: { type: "space", key: "any" } } }
              : local.schema;
          return new Response(JSON.stringify({ value: schema }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      }),
    /group\.opensocial\.meta: published schema .* differs from local vendored lexicon/,
  );
});

test("verifyPublicLexicons enforces DID-document identity binding and AtprotoPersonalDataServer service type", async () => {
  const resolveTxt = async (hostname: string) =>
    hostname === "_lexicon.opensocial.group" ? [[`did=${OPENSOCIAL_AUTH_DID}`]] : [[`did=${FLOCK_AUTH_DID}`]];

  // 1. DID mismatch (`didDoc.id !== authorityDid`)
  await assert.rejects(
    () =>
      verifyPublicLexicons({
        repoRoot: REPO_ROOT,
        plcUrl: "https://plc.example",
        resolveTxt,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              id: "did:plc:impersonator234567234567",
              service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://pds.example" }],
            }),
            { status: 200, headers: { "content-type": "application/did+json" } },
          ),
      }),
    /DID document identity mismatch/,
  );

  // 2. Wrong service type on #atproto_pds
  await assert.rejects(
    () =>
      verifyPublicLexicons({
        repoRoot: REPO_ROOT,
        plcUrl: "https://plc.example",
        resolveTxt,
        fetchImpl: async (input) => {
          const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
          const did = decodeURIComponent(url.pathname.slice(1));
          return new Response(
            JSON.stringify({
              id: did,
              service: [{ id: "#atproto_pds", type: "UntrustedService", serviceEndpoint: "https://pds.example" }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      }),
    /AtprotoPersonalDataServer/,
  );

  // 3. Non-HTTPS serviceEndpoint on non-loopback host rejected even if allowHttp is true
  await assert.rejects(
    () =>
      verifyPublicLexicons({
        repoRoot: REPO_ROOT,
        plcUrl: "https://plc.example",
        allowHttp: true,
        resolveTxt,
        fetchImpl: async (input) => {
          const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
          const did = decodeURIComponent(url.pathname.slice(1));
          return new Response(
            JSON.stringify({
              id: did,
              service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "http://pds.example" }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      }),
    /must use HTTPS/,
  );
});

test("verifyPublicLexicons rejects oversized responses (> 256 KiB) and disallowed MIME types", async () => {
  const resolveTxt = async (hostname: string) =>
    hostname === "_lexicon.opensocial.group" ? [[`did=${OPENSOCIAL_AUTH_DID}`]] : [[`did=${FLOCK_AUTH_DID}`]];

  // 1. Oversized streamed body without Content-Length header (> 256 * 1024 bytes)
  await assert.rejects(
    () =>
      verifyPublicLexicons({
        repoRoot: REPO_ROOT,
        plcUrl: "https://plc.example",
        resolveTxt,
        fetchImpl: async () => {
          const bigChunk = new Uint8Array(300 * 1024).fill(0x20);
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bigChunk);
              controller.close();
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      }),
    /exceeded maxBytes \(262144\)/,
  );

  // 2. Disallowed Content-Type (`text/html`)
  await assert.rejects(
    () =>
      verifyPublicLexicons({
        repoRoot: REPO_ROOT,
        plcUrl: "https://plc.example",
        resolveTxt,
        fetchImpl: async () =>
          new Response("<html>unexpected</html>", {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
      }),
    /Content-Type "text\/html" is not in allowed types/,
  );
});

test("verifyPublicLexicons rejects private-IP SSRF targets, default loopback, and HTTP redirects via boundedSafeFetch", async () => {
  const resolveTxt = async (hostname: string) =>
    hostname === "_lexicon.opensocial.group" ? [[`did=${OPENSOCIAL_AUTH_DID}`]] : [[`did=${FLOCK_AUTH_DID}`]];

  // 1. Private IP in DID document #atproto_pds serviceEndpoint is blocked
  await assert.rejects(
    () =>
      verifyPublicLexicons({
        repoRoot: REPO_ROOT,
        plcUrl: "https://plc.example",
        resolveTxt,
        fetchImpl: async (input) => {
          const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
          const did = decodeURIComponent(url.pathname.slice(1));
          return new Response(
            JSON.stringify({
              id: did,
              service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://10.0.0.42" }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      }),
    /non-public IP address/,
  );

  // 2. Real HTTP server on 127.0.0.1 exercising default boundedSafeFetch (no fetchImpl):
  //    (a) rejected when allowHttp/allowLoopback is omitted (production default = false)
  //    (b) HTTP 302 redirect rejected when allowHttp = true (`redirect: "error"`)
  const redirectServer = createServer((_req, res) => {
    res.writeHead(302, { location: "https://example.com/evil" });
    res.end();
  });
  await new Promise<void>((resolveListen) => redirectServer.listen(0, "127.0.0.1", resolveListen));
  const { port } = redirectServer.address() as AddressInfo;
  const loopbackOrigin = `http://127.0.0.1:${port}`;

  try {
    await assert.rejects(
      () =>
        verifyPublicLexicons({
          repoRoot: REPO_ROOT,
          plcUrl: loopbackOrigin,
          resolveTxt,
        }),
      /must use HTTPS|unsafe|non-public/i,
    );

    await assert.rejects(
      () =>
        verifyPublicLexicons({
          repoRoot: REPO_ROOT,
          plcUrl: loopbackOrigin,
          allowHttp: true,
          resolveTxt,
        }),
      /redirect|fetch failed/i,
    );
  } finally {
    await new Promise<void>((resolveClose) => redirectServer.close(() => resolveClose()));
  }
});

test("verifyPublicLexicons default production boundedSafeFetch wiring (no fetchImpl) enforces SSRF blocks, 256 KiB cap, and MIME allowlist", async () => {
  // 1. Default `allowLoopback: false` (omitted) with NO `fetchImpl`:
  //    loopback (`did:web:127.0.0.1`, `did:web:localhost`) and private-IP (`did:web:10.0.0.42`, `https://10.0.0.42`) targets fail closed.
  for (const evilDid of ["did:web:127.0.0.1", "did:web:localhost", "did:web:10.0.0.42"]) {
    await assert.rejects(
      () =>
        verifyPublicLexicons({
          repoRoot: REPO_ROOT,
          resolveTxt: async () => [[`did=${evilDid}`]],
        }),
      /non-public|loopback|unsafe/i,
    );
  }

  await assert.rejects(
    () =>
      verifyPublicLexicons({
        repoRoot: REPO_ROOT,
        plcUrl: "https://10.0.0.42",
        resolveTxt: async () => [[`did=${OPENSOCIAL_AUTH_DID}`]],
      }),
    /non-public IP address/i,
  );

  // 2. Real HTTP server exercising production `boundedSafeFetch` directly (NO `fetchImpl`) for:
  //    (a) private-IP `#atproto_pds` serviceEndpoint (`https://10.0.0.42`) rejected even when `allowLoopback: true`,
  //    (b) streamed body > 256 KiB (`UpstreamResponseTooLargeError`), and
  //    (c) disallowed `text/html` MIME (`UpstreamContentTypeError`).
  let mode: "private-ip-pds" | "oversized-body" | "html-mime" = "private-ip-pds";
  const srv = createServer((req, res) => {
    const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const did = decodeURIComponent(reqUrl.pathname.slice(1));
    if (mode === "private-ip-pds") {
      res.writeHead(200, { "content-type": "application/did+json" });
      res.end(
        JSON.stringify({
          id: did,
          service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://10.0.0.42" }],
        }),
      );
      return;
    }
    if (mode === "html-mime") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html>not json</html>");
      return;
    }
    // Stream > 256 KiB without Content-Length so `boundedSafeFetch`'s streaming reader enforces `maxResponseBytes`
    res.writeHead(200, { "content-type": "application/json" });
    res.write(Buffer.alloc(300 * 1024, 0x20));
    res.end();
  });
  await new Promise<void>((resolveListen) => srv.listen(0, "127.0.0.1", resolveListen));
  const { port } = srv.address() as AddressInfo;
  const localPlcOrigin = `http://127.0.0.1:${port}`;
  const resolveTxt = async (hostname: string) =>
    hostname === "_lexicon.opensocial.group" ? [[`did=${OPENSOCIAL_AUTH_DID}`]] : [[`did=${FLOCK_AUTH_DID}`]];

  try {
    mode = "private-ip-pds";
    await assert.rejects(
      () =>
        verifyPublicLexicons({
          repoRoot: REPO_ROOT,
          plcUrl: localPlcOrigin,
          allowHttp: true,
          resolveTxt,
        }),
      /non-public IP address/i,
    );

    mode = "html-mime";
    await assert.rejects(
      () =>
        verifyPublicLexicons({
          repoRoot: REPO_ROOT,
          plcUrl: localPlcOrigin,
          allowHttp: true,
          resolveTxt,
        }),
      /Content-Type "text\/html" is not in allowed types/,
    );

    mode = "oversized-body";
    await assert.rejects(
      () =>
        verifyPublicLexicons({
          repoRoot: REPO_ROOT,
          plcUrl: localPlcOrigin,
          allowHttp: true,
          resolveTxt,
        }),
      /exceeded maxResponseBytes \(262144\)/,
    );
  } finally {
    await new Promise<void>((resolveClose) => srv.close(() => resolveClose()));
  }
});

test("verifyPublicLexicons fails closed when authoritative DNS TXT resolution hangs past bounded timeout", async () => {
  // 1. Real unresponsive UDP DNS socket exercising `dns.promises.Resolver` + `resolver.cancel()` with NO `resolveTxt` override
  const blackholeDns = dgram.createSocket("udp4");
  await new Promise<void>((resolveBind) => blackholeDns.bind(0, "127.0.0.1", () => resolveBind()));
  const { port: dnsPort } = blackholeDns.address();
  const startedAt = Date.now();
  try {
    await assert.rejects(
      () =>
        verifyPublicLexicons({
          repoRoot: REPO_ROOT,
          dnsServers: [`127.0.0.1:${dnsPort}`],
          dnsTimeoutMs: 60,
          allowLoopback: true,
        }),
      /DNS TXT lookup .* timed out after 60ms/,
    );
    assert.ok(Date.now() - startedAt < 5_000, "DNS TXT timeout must abort promptly without hanging");
  } finally {
    await new Promise<void>((resolveClose) => blackholeDns.close(() => resolveClose()));
  }

  // 2. Hanging custom `resolveTxt` callback is also bounded by `dnsTimeoutMs`
  await assert.rejects(
    () =>
      verifyPublicLexicons({
        repoRoot: REPO_ROOT,
        dnsTimeoutMs: 50,
        resolveTxt: () => new Promise(() => {}),
      }),
    /DNS TXT lookup .* timed out after 50ms/,
  );
});

test("verify-public-lexicons CLI exits non-zero when DNS authorities cannot be resolved", () => {
  // Run with isolated NODE_OPTIONS / bogus DNS by pointing PLC_URL at closed loopback and exercising CLI fail-closed path
  const scriptPath = join(REPO_ROOT, "scripts/verify-public-lexicons.mjs");
  const run = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { verifyPublicLexicons } from ${JSON.stringify(scriptPath)};
       await verifyPublicLexicons({
         resolveTxt: async () => { throw new Error("DNS_UNPUBLISHED"); },
       }).catch((err) => { process.stderr.write(err.message + "\\n"); process.exit(1); });`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Public lexicon verification failed/);
});
