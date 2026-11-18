import assert from "node:assert/strict";
import test from "node:test";
import { securityHeaderRule, webContentSecurityPolicy } from "./security-headers";

function headerMap(rule: ReturnType<typeof securityHeaderRule>): Map<string, string> {
  return new Map(rule.headers.map(({ key, value }) => [key.toLowerCase(), value]));
}

const directive = (policy: string, name: string) => policy.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name} `)) ?? "";

test("every route of the web app carries the fixed security headers, and no fixed script policy", () => {
  // #given the web app's header rule
  const rule = securityHeaderRule();
  const headers = headerMap(rule);

  // #then it covers every route with the fixed headers, and leaves the Content-Security-Policy to each request
  assert.equal(rule.source, "/:path*");
  assert.equal(headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.equal(headers.get("strict-transport-security"), "max-age=31536000");
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.equal(headers.get("x-frame-options"), "DENY");
  assert.equal(headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=()");
  assert.equal(headers.has("content-security-policy"), false);
});

test("a page's scripts run under its request's nonce only, never inline without it", () => {
  // #given the policy for a request in production
  const policy = webContentSecurityPolicy({ nonce: "bm9uY2Ux", appUrl: "https://spaces.example.com", development: false });

  // #then scripts need the nonce, inline and eval are not allowed, and the rest of the policy holds
  assert.equal(directive(policy, "script-src"), "script-src 'self' 'nonce-bm9uY2Ux' 'strict-dynamic'");
  assert.match(policy, /default-src 'self'/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /base-uri 'self'/);
  assert.match(directive(policy, "style-src"), /https:\/\/fonts\.googleapis\.com/);
  assert.match(directive(policy, "font-src"), /https:\/\/fonts\.gstatic\.com/);
});

test("the dev server may evaluate scripts; production never", () => {
  const policy = (development: boolean) => directive(webContentSecurityPolicy({ nonce: "bm9uY2Ux", appUrl: "http://127.0.0.1:3000", development }), "script-src");
  assert.equal(policy(true), "script-src 'self' 'nonce-bm9uY2Ux' 'strict-dynamic' 'unsafe-eval'");
  assert.doesNotMatch(policy(false), /unsafe-eval|unsafe-inline/);
});

test("connect-src allows any HTTPS host for the browser session, and loopback HTTP only for a loopback app", () => {
  const connect = (appUrl: string | undefined) => directive(webContentSecurityPolicy({ nonce: "bm9uY2Ux", appUrl, development: false }), "connect-src");

  // #then an HTTPS app reaches any HTTPS host, and only that
  assert.equal(connect("https://spaces.example.com"), "connect-src 'self' https:");

  // #then a loopback app also reaches the loopback hosts over HTTP
  for (const appUrl of ["http://127.0.0.1:3000", "http://localhost:3000"]) {
    assert.equal(connect(appUrl), "connect-src 'self' https: http://localhost:* http://127.0.0.1:*", appUrl);
  }

  // #then with no APP_URL, or one that does not parse, nothing is assumed
  for (const appUrl of [undefined, "", "not a url"]) assert.equal(connect(appUrl), "connect-src 'self' https:", String(appUrl));
});
