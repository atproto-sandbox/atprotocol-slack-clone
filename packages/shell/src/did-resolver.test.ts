import assert from "node:assert/strict";
import test from "node:test";
import { P256Keypair } from "@atproto/crypto";
import { credentialLifetimeMs } from "@flock/protocol/atproto/space-credential-core";
import { UpstreamResponseTooLargeError } from "@flock/protocol/bounded-json";
import {
  assertSafeBrowserEndpointUrl,
  createBrowserDidResolver,
  DidResolutionError,
  UnsafeBrowserEndpointUrlError,
} from "./did-resolver";

const ALWAYS_BLOCKED_URLS = [
  "https://printer.local",
  "https://service.internal",
  "https://0.0.0.1",
  "https://10.0.0.1",
  "https://100.64.0.1",
  "https://169.254.169.254",
  "https://172.16.0.1",
  "https://192.0.0.1",
  "https://192.0.2.1",
  "https://192.88.99.1",
  "https://192.168.1.1",
  "https://198.18.0.1",
  "https://198.51.100.1",
  "https://203.0.113.1",
  "https://224.0.0.1",
  "https://240.0.0.1",
  "https://[::]",
  "https://[::a9fe:a9fe]",
  "https://[::ffff:169.254.169.254]",
  "https://[::ffff:10.0.0.1]",
  "https://[64:ff9b::a9fe:a9fe]",
  "https://[64:ff9b:1::1]",
  "https://[100::1]",
  "https://[2001::1]",
  "https://[2001:2::1]",
  "https://[2001:db8::1]",
  "https://[2002:a9fe:a9fe::1]",
  "https://[fc00::1]",
  "https://[fd12:3456::1]",
  "https://[fe80::1]",
  "https://[ff02::1]",
  "https://user:pass@pds.example",
  "https://pds.example/?q=1",
  "https://pds.example/#frag",
  "http://pds.example",
];

const LOOPBACK_ONLY_URLS = [
  "http://localhost:3004",
  "http://groups.localhost:3004",
  "http://127.0.0.1:2582",
  "http://127.0.0.42:2582",
  "http://[::1]:3004",
  "http://[::ffff:127.0.0.1]:3004",
  "https://127.0.0.1:3004",
];

test("assertSafeBrowserEndpointUrl enforces full canonical IPv4/IPv6 CIDR denylist in BOTH loopback and non-loopback modes", () => {
  for (const url of ALWAYS_BLOCKED_URLS) {
    assert.throws(
      () => assertSafeBrowserEndpointUrl(url, false),
      UnsafeBrowserEndpointUrlError,
      `expected non-loopback rejection for ${url}`,
    );
    assert.throws(
      () => assertSafeBrowserEndpointUrl(url, true),
      UnsafeBrowserEndpointUrlError,
      `expected loopback-mode rejection for ${url}`,
    );
  }

  for (const url of LOOPBACK_ONLY_URLS) {
    assert.throws(
      () => assertSafeBrowserEndpointUrl(url, false),
      UnsafeBrowserEndpointUrlError,
      `expected non-loopback rejection for loopback URL ${url}`,
    );
    assert.ok(assertSafeBrowserEndpointUrl(url, true), `expected loopback-mode acceptance for ${url}`);
  }

  assert.equal(assertSafeBrowserEndpointUrl("https://pds.example", false).origin, "https://pds.example");
  assert.equal(assertSafeBrowserEndpointUrl("https://pds.example", true).origin, "https://pds.example");
  assert.equal(assertSafeBrowserEndpointUrl("https://1.1.1.1", false).origin, "https://1.1.1.1");
  assert.equal(assertSafeBrowserEndpointUrl("https://[2606:4700:4700::1111]", false).origin, "https://[2606:4700:4700::1111]");
});

test("createBrowserDidResolver enforces redirect:error, 256 KiB cap, KEM rotation forceRefresh, and preserves 404/410 status", async () => {
  const did = "did:plc:rotatetestaaaaaaaaaaaaaa";
  const key1 = await P256Keypair.create();
  const key2 = await P256Keypair.create();
  const multibase1 = key1.did().replace(/^did:key:/, "");
  const multibase2 = key2.did().replace(/^did:key:/, "");

  let activeKey = multibase1;
  let activeEndpoint = "https://pds1.example";
  let fetchCount = 0;
  let sawRedirectMode: RequestRedirect | undefined;
  let mode: "ok" | "oversized" | "tombstone" | "ssrf" = "ok";

  const resolver = createBrowserDidResolver({
    plcUrl: "https://plc.directory",
    loopbackAllowed: false,
    fetchImpl: async (_input, init) => {
      fetchCount += 1;
      sawRedirectMode = init?.redirect;
      if (mode === "tombstone") return new Response("gone", { status: 410 });
      if (mode === "oversized") {
        return new Response("x".repeat(257 * 1024), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const doc = {
        id: did,
        service: [
          {
            id: "#atproto_pds",
            type: "AtprotoPersonalDataServer",
            serviceEndpoint: mode === "ssrf" ? "https://169.254.169.254" : activeEndpoint,
          },
        ],
        verificationMethod: [
          {
            id: `${did}#atproto_kem`,
            type: "Multikey",
            publicKeyMultibase: activeKey,
          },
        ],
      };
      return new Response(JSON.stringify(doc), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.equal(await resolver.resolvePds(did), "https://pds1.example");
  assert.equal(sawRedirectMode, "error");
  assert.equal(await resolver.resolveKemKey(did, false), key1.did());
  assert.equal(fetchCount, 1, "cached DID doc serves both PDS and KEM");

  // Rotate KEM key and migrate PDS -> forceRefresh fetches updated doc immediately
  activeKey = multibase2;
  activeEndpoint = "https://pds2.example";
  assert.equal(await resolver.resolveKemKey(did, false), key1.did(), "still cached before forceRefresh");
  assert.equal(await resolver.resolveKemKey(did, true), key2.did(), "forceRefresh fetches rotated KEM key");
  assert.equal(await resolver.resolvePds(did, false), "https://pds2.example");
  assert.equal(fetchCount, 2);

  // SSRF endpoint inside DID doc is rejected
  mode = "ssrf";
  await assert.rejects(() => resolver.resolvePds(did, true), UnsafeBrowserEndpointUrlError);

  // Oversized DID document (> 256 KiB) rejected
  mode = "oversized";
  await assert.rejects(() => resolver.resolveDocument(did, true), UpstreamResponseTooLargeError);

  // Tombstoned DID preserves HTTP 410 status on DidResolutionError
  mode = "tombstone";
  await assert.rejects(
    () => resolver.resolvePds(did, true),
    (err: unknown) => err instanceof DidResolutionError && err.status === 410,
  );
});

test("credentialLifetimeMs derives issuer-clock lifetime independent of browser wall clock", () => {
  const payload = Buffer.from(JSON.stringify({ iat: 1_700_000_000, exp: 1_700_000_300 })).toString("base64url");
  assert.equal(credentialLifetimeMs(`hdr.${payload}.sig`), 300_000);
});
