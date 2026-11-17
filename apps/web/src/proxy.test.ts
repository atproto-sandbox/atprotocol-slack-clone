import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { getScriptNonceFromHeader } from "next/dist/server/app-render/get-script-nonce-from-header";
import { proxy } from "./proxy";
import { LOOPBACK_PATH_HEADER, resolveLoopbackRedirect } from "./lib/loopback-redirect";

function withEnv(values: Record<string, string | undefined>, fn: () => void): void {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("every page gets a script policy with a nonce of its own across root and deep routes", () => {
  for (const path of [
    "/",
    "/w/did%3Aplc%3Aalice/acme/c/general?thread=at%3A%2F%2F1",
    "/w/did%3Aweb%3Alocalhost%253A3000/acme/ext/tasks/board",
    "/dm/3k22222222222",
  ]) {
    const first = proxy(new NextRequest(`http://127.0.0.1:3000${path}`, { headers: { host: "127.0.0.1:3000" } }));
    const second = proxy(new NextRequest(`http://127.0.0.1:3000${path}`, { headers: { host: "127.0.0.1:3000" } }));
    assert.equal(first.status, 200);
    const policy = first.headers.get("content-security-policy") ?? "";
    const nonce = getScriptNonceFromHeader(policy);
    assert.equal(nonce?.length, 24);
    assert.notEqual(getScriptNonceFromHeader(second.headers.get("content-security-policy") ?? ""), nonce);
    assert.equal(first.headers.get("x-middleware-request-content-security-policy"), policy);
  }
});

test("localhost HTTP requests normalize to 127.0.0.1 with 307 preserving deep paths and queries", () => {
  withEnv({ APP_URL: "http://127.0.0.1:3000", OPERATOR_SERVICE_REF: undefined }, () => {
    const inviteRes = proxy(new NextRequest("http://localhost:3000/?invite=at%3A%2F%2Fdid%3Aplc%3Aabc%2Fspace%2Fnew.flock.workspace%2Facme", { headers: { host: "localhost:3000" } }));
    assert.equal(inviteRes.status, 307);
    assert.equal(inviteRes.headers.get("location"), "http://127.0.0.1:3000/?invite=at%3A%2F%2Fdid%3Aplc%3Aabc%2Fspace%2Fnew.flock.workspace%2Facme");

    const deepRes = proxy(new NextRequest("http://localhost:3000/w/did%3Aweb%3Alocalhost%253A3000/acme/c/general?thread=at%3A%2F%2Fmsg", { headers: { host: "localhost:3000" } }));
    assert.equal(deepRes.status, 307);
    assert.equal(deepRes.headers.get("location"), "http://127.0.0.1:3000/w/did%3Aweb%3Alocalhost%253A3000/acme/c/general?thread=at%3A%2F%2Fmsg");

    const dmRes = proxy(new NextRequest("http://localhost:3000/dm/3k22222222222", { headers: { host: "LOCALHOST:3000" } }));
    assert.equal(dmRes.status, 307);
    assert.equal(dmRes.headers.get("location"), "http://127.0.0.1:3000/dm/3k22222222222");

    const canonicalRes = proxy(new NextRequest("http://127.0.0.1:3000/w/did%3Aplc%3Aabc/acme", { headers: { host: "127.0.0.1:3000" } }));
    assert.equal(canonicalRes.status, 200);
    assert.ok(getScriptNonceFromHeader(canonicalRes.headers.get("content-security-policy") ?? ""));
  });
});

test("APP_URL=http://localhost:3000 normalizes to 127.0.0.1:3000 and rejects unsafe redirect paths", () => {
  withEnv({ APP_URL: "http://localhost:3000", OPERATOR_SERVICE_REF: undefined }, () => {
    const res = proxy(new NextRequest("http://localhost:3000/ext", { headers: { host: "localhost:3000" } }));
    assert.equal(res.status, 307);
    assert.equal(res.headers.get("location"), "http://127.0.0.1:3000/ext");

    const protocolRelative = proxy(new NextRequest("http://localhost:3000//evil.example/steal", { headers: { host: "localhost:3000" } }));
    assert.equal(protocolRelative.status, 307);
    assert.equal(protocolRelative.headers.get("location"), "http://127.0.0.1:3000/");

    const backslash = proxy(new NextRequest("http://localhost:3000/\\evil.example", { headers: { host: "localhost:3000" } }));
    assert.equal(backslash.status, 307);
    assert.equal(backslash.headers.get("location"), "http://127.0.0.1:3000/");

    const controlChar = proxy(new NextRequest("http://localhost:3000/w/acme%0a", { headers: { host: "localhost:3000" } }));
    assert.equal(controlChar.status, 307);
    assert.equal(controlChar.headers.get("location"), "http://127.0.0.1:3000/w/acme%0a");
  });
});

test("when invoked via Next server adapter (NextRequestHint) with localhost Host, validated target forwards cleanly", () => {
  withEnv({ APP_URL: "http://127.0.0.1:3000", OPERATOR_SERVICE_REF: undefined }, () => {
    const req = Object.assign(
      new NextRequest("http://localhost:3000/w/did%3Aweb%3Alocalhost%253A3000/acme?invite=1", {
        headers: { host: "localhost:3000" },
      }),
      { sourcePage: "/proxy" },
    );
    const proxyRes = proxy(req);
    assert.equal(proxyRes.status, 200);
    const forwardedPath = proxyRes.headers.get(`x-middleware-request-${LOOPBACK_PATH_HEADER}`);
    assert.equal(forwardedPath, "/w/did%3Aweb%3Alocalhost%253A3000/acme?invite=1");
    assert.equal(
      resolveLoopbackRedirect("localhost:3000", forwardedPath!)?.toString(),
      "http://127.0.0.1:3000/w/did%3Aweb%3Alocalhost%253A3000/acme?invite=1",
    );
    assert.equal(resolveLoopbackRedirect("127.0.0.1:3000", "//evil.example"), null);
    assert.equal(resolveLoopbackRedirect("localhost:3000", "//evil.example")?.toString(), "http://127.0.0.1:3000/");
  });
});

test("HTTPS APP_URL never runs HTTP loopback host redirect", () => {
  withEnv({ APP_URL: "https://spaces.example", OPERATOR_SERVICE_REF: undefined }, () => {
    const res = proxy(new NextRequest("https://localhost:3000/w/did%3Aplc%3Aabc/acme", { headers: { host: "localhost:3000" } }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("location"), null);
    assert.ok(getScriptNonceFromHeader(res.headers.get("content-security-policy") ?? ""));
  });
});
