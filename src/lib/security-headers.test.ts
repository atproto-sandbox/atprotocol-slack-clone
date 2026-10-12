import assert from "node:assert/strict";
import test from "node:test";
import { securityHeaderRule } from "./security-headers";

function headerMap(rule: ReturnType<typeof securityHeaderRule>): Map<string, string> {
  return new Map(rule.headers.map(({ key, value }) => [key.toLowerCase(), value]));
}

test("all app routes receive browser security headers", () => {
  delete process.env.APP_URL;
  const rule = securityHeaderRule();
  assert.equal(rule.source, "/:path*");
  const headers = headerMap(rule);

  assert.match(headers.get("content-security-policy") ?? "", /default-src 'self'/);
  assert.match(headers.get("content-security-policy") ?? "", /object-src 'none'/);
  assert.match(headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.match(headers.get("content-security-policy") ?? "", /style-src[^;]*https:\/\/fonts\.googleapis\.com/);
  assert.match(headers.get("content-security-policy") ?? "", /font-src[^;]*https:\/\/fonts\.gstatic\.com/);
  assert.equal(headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.equal(headers.get("strict-transport-security"), "max-age=31536000");
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.equal(headers.get("x-frame-options"), "DENY");
  assert.equal(headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=()");
});

test("connect-src allows any HTTPS host for the browser DM session (M3)", () => {
  process.env.APP_URL = "https://spaces.example.com";
  const csp = headerMap(securityHeaderRule()).get("content-security-policy") ?? "";
  assert.ok(csp.endsWith("connect-src 'self' https:"));
});

test("connect-src additionally allows loopback HTTP origins in local development", () => {
  for (const appUrl of ["http://127.0.0.1:3000", "http://localhost:3000", undefined]) {
    if (appUrl) process.env.APP_URL = appUrl; else delete process.env.APP_URL;
    const headers = headerMap(securityHeaderRule());
    assert.match(headers.get("content-security-policy") ?? "", /connect-src 'self' https: http:\/\/localhost:\* http:\/\/127\.0\.0\.1:\*/);
  }
});
