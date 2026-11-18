import assert from "node:assert/strict";
import test from "node:test";
import {
  ADMIN_FLOW_TTL_MS,
  ADMIN_SESSION_TTL_MS,
  createProcessCookieKey,
  flowCookieName,
  serializeAdminCookie,
  signFlowCookie,
  signSessionCookie,
  verifyCsrfToken,
  verifyFlowCookie,
  verifySessionCookie,
} from "./cookies";

test("flow and session cookies are HttpOnly, SameSite=Lax, Secure off loopback, expire on time, and fail after key rotation", () => {
  const key1 = createProcessCookieKey();
  const key2 = createProcessCookieKey();
  const now = 1_700_000_000_000;

  const flow = signFlowCookie("state-1", "app-state-1", key1, now);
  assert.deepEqual(verifyFlowCookie("state-1", flow, key1, now + 1_000), { appState: "app-state-1", exp: now + ADMIN_FLOW_TTL_MS });
  assert.equal(verifyFlowCookie("state-2", flow, key1, now + 1_000), null, "bound to protocol state");
  assert.equal(verifyFlowCookie("state-1", flow, key2, now + 1_000), null, "process restart invalidates flow cookies");
  assert.equal(verifyFlowCookie("state-1", flow, key1, now + ADMIN_FLOW_TTL_MS), null, "expires after ten minutes");

  const { cookieValue, session } = signSessionCookie("did:plc:admin", key1, now);
  assert.deepEqual(verifySessionCookie(cookieValue, key1, now + 60_000), session);
  assert.equal(verifySessionCookie(cookieValue, key2, now + 60_000), null, "process restart invalidates session cookies");
  assert.equal(verifySessionCookie(cookieValue, key1, now + ADMIN_SESSION_TTL_MS), null, "expires after thirty minutes");
  assert.equal(verifyCsrfToken(session.csrf, session.csrf), true);
  assert.equal(verifyCsrfToken(session.csrf, "wrong"), false);

  const loopbackHeader = serializeAdminCookie(flowCookieName("s"), flow, { maxAgeSeconds: 600, secure: false });
  assert.match(loopbackHeader, /HttpOnly/);
  assert.match(loopbackHeader, /SameSite=Lax/);
  assert.doesNotMatch(loopbackHeader, /Secure/);

  const httpsHeader = serializeAdminCookie("webhooks_admin", cookieValue, { maxAgeSeconds: 1800, secure: true });
  assert.match(httpsHeader, /HttpOnly/);
  assert.match(httpsHeader, /SameSite=Lax/);
  assert.match(httpsHeader, /Secure/);
});
