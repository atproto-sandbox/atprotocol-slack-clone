import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";
import { configuredDeskAppUrl, LOOPBACK_PATH_HEADER, resolveLoopbackRedirect } from "./lib/loopback-redirect";

function extractScriptNonce(policy: string): string | null {
  const scriptDirective = policy
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith("script-src "));
  const match = scriptDirective?.match(/'nonce-([^']+)'/);
  return match?.[1] ?? null;
}

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

function connectSrcOf(policy: string): string {
  return policy.split(";").map((p) => p.trim()).find((p) => p.startsWith("connect-src ")) ?? "";
}

test("default-env (no DESK_APP_URL or APP_URL) defaults to :3005 in dev and fails closed (no loopback redirect, HTTPS-only connect-src) in production", () => {
  withEnv({ DESK_APP_URL: undefined, APP_URL: undefined, NODE_ENV: "development" }, () => {
    assert.equal(configuredDeskAppUrl()?.origin, "http://127.0.0.1:3005");

    const first = proxy(new NextRequest("http://127.0.0.1:3005/", { headers: { host: "127.0.0.1:3005" } }));
    const second = proxy(new NextRequest("http://127.0.0.1:3005/?invite=at%3A%2F%2Fdid%3Aplc%3Aabc", { headers: { host: "127.0.0.1:3005" } }));
    assert.equal(first.status, 200);
    const policy1 = first.headers.get("content-security-policy") ?? "";
    const policy2 = second.headers.get("content-security-policy") ?? "";
    const nonce1 = extractScriptNonce(policy1);
    const nonce2 = extractScriptNonce(policy2);
    assert.equal(nonce1?.length, 24);
    assert.notEqual(nonce1, nonce2);
    assert.equal(connectSrcOf(policy1), "connect-src 'self' https: http://localhost:* http://127.0.0.1:*");
  });

  withEnv({ DESK_APP_URL: undefined, APP_URL: undefined, NODE_ENV: "production" }, () => {
    assert.equal(configuredDeskAppUrl(), null);
    const prodRes = proxy(new NextRequest("https://desk.example.com/", { headers: { host: "desk.example.com" } }));
    assert.equal(prodRes.status, 200);
    assert.equal(prodRes.headers.get("location"), null);
    const prodPolicy = prodRes.headers.get("content-security-policy") ?? "";
    assert.equal(connectSrcOf(prodPolicy), "connect-src 'self' https:");
    assert.equal(prodPolicy.includes("'unsafe-eval'"), false);
    assert.equal(extractScriptNonce(prodPolicy)?.length, 24);
  });
});

test("HTTPS DESK_APP_URL restricts connect-src to 'self' https: and never runs HTTP loopback redirects", () => {
  withEnv({ DESK_APP_URL: "https://desk.example.com", APP_URL: "http://127.0.0.1:3000", NODE_ENV: "production" }, () => {
    assert.equal(configuredDeskAppUrl()?.origin, "https://desk.example.com");
    const res = proxy(new NextRequest("https://localhost:3005/?invite=1", { headers: { host: "localhost:3005" } }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("location"), null);
    const policy = res.headers.get("content-security-policy") ?? "";
    assert.equal(connectSrcOf(policy), "connect-src 'self' https:");
    assert.ok(extractScriptNonce(policy));
  });
});

test("localhost HTTP requests normalize to 127.0.0.1 preserving path & query and rejecting unsafe redirect paths", () => {
  withEnv({ DESK_APP_URL: "http://localhost:3005", APP_URL: undefined, NODE_ENV: "production" }, () => {
    const inviteRes = proxy(
      new NextRequest("http://localhost:3005/?invite=at%3A%2F%2Fdid%3Aplc%3Aabc%2Fspace%2Fnew.flock.workspace%2Fself", {
        headers: { host: "localhost:3005" },
      }),
    );
    assert.equal(inviteRes.status, 307);
    assert.equal(
      inviteRes.headers.get("location"),
      "http://127.0.0.1:3005/?invite=at%3A%2F%2Fdid%3Aplc%3Aabc%2Fspace%2Fnew.flock.workspace%2Fself",
    );

    const protocolRelative = proxy(new NextRequest("http://localhost:3005//evil.example/steal", { headers: { host: "localhost:3005" } }));
    assert.equal(protocolRelative.status, 307);
    assert.equal(protocolRelative.headers.get("location"), "http://127.0.0.1:3005/");

    const backslash = proxy(new NextRequest("http://localhost:3005/\\evil.example", { headers: { host: "localhost:3005" } }));
    assert.equal(backslash.status, 307);
    assert.equal(backslash.headers.get("location"), "http://127.0.0.1:3005/");
  });
});

test("when invoked via Next server adapter (NextRequestHint) with localhost Host, validated target forwards cleanly", () => {
  withEnv({ DESK_APP_URL: "http://127.0.0.1:3005", APP_URL: undefined, NODE_ENV: "production" }, () => {
    const req = Object.assign(
      new NextRequest("http://localhost:3005/?invite=at%3A%2F%2Fdid%3Aplc%3Aabc%2Fspace%2Fnew.flock.workspace%2Fself", {
        headers: { host: "localhost:3005" },
      }),
      { sourcePage: "/proxy" },
    );
    const proxyRes = proxy(req);
    assert.equal(proxyRes.status, 200);
    const forwardedPath = proxyRes.headers.get(`x-middleware-request-${LOOPBACK_PATH_HEADER}`);
    assert.equal(forwardedPath, "/?invite=at%3A%2F%2Fdid%3Aplc%3Aabc%2Fspace%2Fnew.flock.workspace%2Fself");
    assert.equal(
      resolveLoopbackRedirect("localhost:3005", forwardedPath!)?.toString(),
      "http://127.0.0.1:3005/?invite=at%3A%2F%2Fdid%3Aplc%3Aabc%2Fspace%2Fnew.flock.workspace%2Fself",
    );
    assert.equal(resolveLoopbackRedirect("localhost:3005", "//evil.example")?.toString(), "http://127.0.0.1:3005/");
  });
});
