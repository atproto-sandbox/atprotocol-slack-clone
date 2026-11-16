import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { sectionBlock } from "@flock/client/blocks";
import { PendingSignInCapError, type AdminIdentityOAuth } from "@flock/client/node/admin-oauth";
import type { WorkspaceSummary } from "@flock/client/workspace-client";
import { createProcessCookieKey, SESSION_COOKIE_NAME } from "./cookies";
import { HooksStore } from "./hooks-store";
import { ADMIN_CSP, createWebhooksHandler, listenWebhooksServer, type WebhooksHandlerDeps } from "./server";

const directory = mkdtempSync(join(tmpdir(), "webhooks-server-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));

const AUTHORITY = "did:plc:authority";
const ADMIN = "did:plc:admin";
const OUTSIDER_ADMIN = "did:plc:outsideradmin";
const APP_DID = "did:plc:webhooksapp";
const WORKSPACE = `at://${AUTHORITY}/space/new.flock.workspace/acme`;

let testCounter = 0;

async function startTestHarness(overrides: Partial<WebhooksHandlerDeps> & {
  initialSummary?: WorkspaceSummary;
  privateRosters?: Record<string, string[]>;
} = {}) {
  testCounter += 1;
  let currentNow = 1_700_000_000_000;
  const advance = (ms: number) => { currentNow += ms; };
  const hooksPath = join(directory, `hooks-${testCounter}.json`);
  const hooks = new HooksStore(hooksPath, () => currentNow);

  const state = {
    summaryCalls: 0,
    sendCalls: [] as Array<{ workspace: string; skey: string; text: string; blocks?: unknown }>,
    completeSignInCalls: 0,
    pendingCap: false,
    nextSignInDid: ADMIN,
    summary: overrides.initialSummary ?? {
      uri: WORKSPACE,
      authorityDid: AUTHORITY,
      skey: "acme",
      name: "Acme",
      isAdmin: true,
      admins: [AUTHORITY, ADMIN, OUTSIDER_ADMIN],
      members: [
        { did: AUTHORITY, active: true },
        { did: ADMIN, active: true },
        { did: OUTSIDER_ADMIN, active: true },
      ],
      channels: [
        { uri: `at://${AUTHORITY}/space/new.flock.channel/acme-general`, skey: "acme-general", name: "general", visibility: "public" },
        { uri: `at://${AUTHORITY}/space/new.flock.channel/acme-secret`, skey: "acme-secret", name: "secret", visibility: "private" },
        { uri: `at://${AUTHORITY}/space/new.flock.channel/acme-moving`, skey: "acme-moving", name: "moving", visibility: "transitioning" },
      ],
      installs: [
        {
          did: APP_DID,
          channels: [
            { skey: "acme-general", write: true },
            { skey: "acme-secret", write: true },
            { skey: "acme-moving", write: true },
          ],
        },
      ],
      degradedReasons: [],
    } satisfies WorkspaceSummary,
    privateRosters: new Map<string, string[]>(Object.entries(overrides.privateRosters ?? { "acme-secret": [ADMIN] })),
  };

  let stateSeq = 0;
  const pendingFlows = new Map<string, { appState: string; createdAt: number }>();
  const adminOAuth: AdminIdentityOAuth = {
    client: {} as never,
    states: {} as never,
    answerMetadataRoute(url) {
      if (url.pathname === "/admin/oauth/client-metadata.json") {
        return { status: 200, type: "application/json", body: JSON.stringify({ scope: "atproto" }) };
      }
      return null;
    },
    async startSignIn(handle) {
      if (state.pendingCap) throw new PendingSignInCapError();
      stateSeq += 1;
      const protocolState = `pstate_${stateSeq}_${"x".repeat(20)}`;
      const appState = `astate_${stateSeq}_${"y".repeat(30)}`;
      pendingFlows.set(protocolState, { appState, createdAt: currentNow });
      return {
        url: new URL(`https://pds.example/oauth/authorize?handle=${encodeURIComponent(handle)}&state=${protocolState}`),
        state: protocolState,
        appState,
      };
    },
    async completeSignIn(params, expected) {
      state.completeSignInCalls += 1;
      const protocolState = params.get("state") ?? "";
      const saved = pendingFlows.get(protocolState);
      if (!saved || protocolState !== expected.state || saved.appState !== expected.appState || currentNow - saved.createdAt >= 10 * 60_000) {
        throw new Error("invalid or expired flow");
      }
      pendingFlows.delete(protocolState);
      return { did: state.nextSignInDid };
    },
  };

  const engine: WebhooksHandlerDeps["engine"] = {
    workspaces: {
      summary: async () => {
        state.summaryCalls += 1;
        return state.summary;
      },
    } as never,
    channels: {
      roster: async (ref: { skey: string }) => state.privateRosters.get(ref.skey) ?? [],
      send: async (ref: { workspace: string; skey: string }, text: string, _parent?: string, blocks?: unknown) => {
        state.sendCalls.push({ workspace: ref.workspace, skey: ref.skey, text, ...(blocks ? { blocks } : {}) });
        return { uri: `at://${AUTHORITY}/space/new.flock.channel/${ref.skey}/${APP_DID}/new.flock.channel.message/2222222222222`, rkey: "2222222222222" };
      },
    } as never,
  };

  const cookieKey = overrides.cookieKey ?? createProcessCookieKey();
  const server = await listenWebhooksServer(
    {
      appUrl: "http://127.0.0.1:0",
      appDid: APP_DID,
      workspaces: [WORKSPACE],
      engine,
      hooks,
      adminOAuth,
      cookieKey,
      now: () => currentNow,
      onError: () => undefined,
      ...overrides,
    },
    { port: 0, host: "127.0.0.1" },
  );
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  // Re-bind handler with exact port origin so strict `Origin === origin` matches.
  server.removeAllListeners("request");
  server.on(
    "request",
    createWebhooksHandler({
      appUrl: origin,
      appDid: APP_DID,
      workspaces: [WORKSPACE],
      engine,
      hooks,
      adminOAuth,
      cookieKey,
      now: () => currentNow,
      onError: () => undefined,
      ...overrides,
    }),
  );

  const close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });

  async function signInAs(did: string): Promise<{ cookie: string; csrf: string; html: string }> {
    state.nextSignInDid = did;
    const loginRes = await fetch(`${origin}/admin/login`, {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ handle: did }).toString(),
    });
    assert.equal(loginRes.status, 200);
    const loginHtml = await loginRes.text();
    const flowCookie = (loginRes.headers.getSetCookie()[0] ?? "").split(";")[0]!;
    const authHref = /href="([^"]+)"/.exec(loginHtml)?.[1]?.replaceAll("&amp;", "&");
    assert.ok(authHref, "login response contains authorization link, not a redirect");
    const authState = new URL(authHref).searchParams.get("state")!;

    const cbRes = await fetch(`${origin}/admin/oauth/callback?code=ok&state=${encodeURIComponent(authState)}`, {
      redirect: "manual",
      headers: { cookie: flowCookie },
    });
    assert.equal(cbRes.status, 303);
    const sessionSet = cbRes.headers.getSetCookie().find((entry) => entry.startsWith(`${SESSION_COOKIE_NAME}=`))!;
    assert.ok(sessionSet);
    const cookie = sessionSet.split(";")[0]!;

    const dashRes = await fetch(`${origin}/admin`, { headers: { cookie } });
    assert.equal(dashRes.status, 200);
    const html = await dashRes.text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
    assert.ok(csrf);
    return { cookie, csrf, html };
  }

  return { origin, hooksPath, hooks, state, advance, signInAs, close };
}

test("admin security headers, browser-bound expiring/capped sign-in, CSRF and Origin checks, and one-time secret display", async () => {
  const h = await startTestHarness({ limits: { loginPerAddress: 5 } });
  try {
    // 1. Security headers on /admin.
    const getRes = await fetch(`${h.origin}/admin`);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.headers.get("cache-control"), "no-store");
    assert.equal(getRes.headers.get("referrer-policy"), "same-origin");
    assert.equal(getRes.headers.get("content-security-policy"), ADMIN_CSP);

    // 2. Origin check refuses missing, null, or foreign Origin on login POST.
    for (const badOrigin of [undefined, "null", "https://evil.example"]) {
      const res = await fetch(`${h.origin}/admin/login`, {
        method: "POST",
        headers: {
          ...(badOrigin ? { origin: badOrigin } : {}),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "handle=alice.test",
      });
      assert.equal(res.status, 403);
    }

    // 3. Callback without the browser's flow cookie is refused BEFORE redeeming the code.
    const startedRes = await fetch(`${h.origin}/admin/login`, {
      method: "POST",
      headers: { origin: h.origin, "content-type": "application/x-www-form-urlencoded" },
      body: "handle=did:plc:admin",
    });
    const startedHtml = await startedRes.text();
    const stateParam = new URL(/href="([^"]+)"/.exec(startedHtml)![1]!.replaceAll("&amp;", "&")).searchParams.get("state")!;
    const noCookieCb = await fetch(`${h.origin}/admin/oauth/callback?code=steal&state=${stateParam}`);
    assert.equal(noCookieCb.status, 400);
    assert.equal(h.state.completeSignInCalls, 0, "code was not redeemed without the browser flow cookie");

    // Expired flow cookie (after 10 minutes) is also refused before redeeming.
    const flowCookie = startedRes.headers.getSetCookie()[0]!.split(";")[0]!;
    h.advance(10 * 60_000);
    const expiredCb = await fetch(`${h.origin}/admin/oauth/callback?code=late&state=${stateParam}`, {
      headers: { cookie: flowCookie },
    });
    assert.equal(expiredCb.status, 400);
    assert.equal(h.state.completeSignInCalls, 0);

    // Pending sign-in cap surfaces 429; per-address login rate limit also surfaces 429.
    h.advance(60_000);
    h.state.pendingCap = true;
    const cappedRes = await fetch(`${h.origin}/admin/login`, {
      method: "POST",
      headers: { origin: h.origin, "content-type": "application/x-www-form-urlencoded" },
      body: "handle=did:plc:admin",
    });
    assert.equal(cappedRes.status, 429);
    h.state.pendingCap = false;

    // 4. Sign in as ADMIN, verify CSRF + Origin checks on create, and verify secret is shown ONCE and hashed on disk.
    h.advance(60_000);
    const { cookie, csrf } = await h.signInAs(ADMIN);

    const badCsrf = await fetch(`${h.origin}/admin/hooks/create`, {
      method: "POST",
      headers: { origin: h.origin, cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: "wrong", workspace: WORKSPACE, channelSkey: "acme-general" }).toString(),
    });
    assert.equal(badCsrf.status, 403);

    const badOriginCreate = await fetch(`${h.origin}/admin/hooks/create`, {
      method: "POST",
      headers: { origin: "null", cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, workspace: WORKSPACE, channelSkey: "acme-general" }).toString(),
    });
    assert.equal(badOriginCreate.status, 403);

    const createRes = await fetch(`${h.origin}/admin/hooks/create`, {
      method: "POST",
      headers: { origin: h.origin, cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, workspace: WORKSPACE, channelSkey: "acme-general" }).toString(),
    });
    assert.equal(createRes.status, 200);
    const createHtml = await createRes.text();
    const hookUrlMatch = /\/hooks\/([A-Za-z0-9_-]{22})\/([A-Za-z0-9_-]{43})/.exec(createHtml);
    assert.ok(hookUrlMatch, "POST response shows full webhook URL once");
    const [, hookId, secret] = hookUrlMatch;

    // Subsequent GET /admin shows the hook ID, NEVER the secret!
    const nextGet = await (await fetch(`${h.origin}/admin`, { headers: { cookie } })).text();
    assert.equal(nextGet.includes(hookId!), true);
    assert.equal(nextGet.includes(secret!), false, "GET /admin never shows the secret");
    assert.equal(readFileSync(h.hooksPath, "utf8").includes(secret!), false, "disk file never stores plaintext secret");
  } finally {
    await h.close();
  }
});

test("every request re-checks admin AND roster membership, private-channel rosters (admitting authority), transitioning channels, and unreadable private rosters", async () => {
  const h = await startTestHarness();
  try {
    // 1. Admin record WITHOUT an active roster record is refused!
    const orphanAdmin = "did:plc:orphanadmin";
    h.state.summary = {
      ...h.state.summary,
      admins: [...h.state.summary.admins, orphanAdmin],
      // Note: orphanAdmin is NOT in h.state.summary.members!
    };
    h.state.nextSignInDid = orphanAdmin;
    const loginRes = await fetch(`${h.origin}/admin/login`, {
      method: "POST",
      headers: { origin: h.origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ handle: orphanAdmin }).toString(),
    });
    const flowCookie = loginRes.headers.getSetCookie()[0]!.split(";")[0]!;
    const authState = new URL(/href="([^"]+)"/.exec(await loginRes.text())![1]!.replaceAll("&amp;", "&")).searchParams.get("state")!;
    const orphanCb = await fetch(`${h.origin}/admin/oauth/callback?code=ok&state=${authState}`, {
      redirect: "manual",
      headers: { cookie: flowCookie },
    });
    assert.equal(orphanCb.status, 403, "admin record without roster record is refused");

    // 2. Workspace authority is admitted to private channel #secret even though not on channelRoster!
    const authSession = await h.signInAs(AUTHORITY);
    assert.equal(authSession.html.includes('value="acme-secret"'), true, "authority sees private channel #secret");
    assert.equal(authSession.html.includes('value="acme-moving"'), false, "transitioning channel excluded");
    // Transitioning channel creation attempt via forged POST is refused too.
    const movingCreate = await fetch(`${h.origin}/admin/hooks/create`, {
      method: "POST",
      headers: { origin: h.origin, cookie: authSession.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: authSession.csrf, workspace: WORKSPACE, channelSkey: "acme-moving" }).toString(),
    });
    assert.equal(movingCreate.status, 403);

    // Authority creates a hook in #secret.
    const createSecret = await fetch(`${h.origin}/admin/hooks/create`, {
      method: "POST",
      headers: { origin: h.origin, cookie: authSession.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: authSession.csrf, workspace: WORKSPACE, channelSkey: "acme-secret" }).toString(),
    });
    assert.equal(createSecret.status, 200);
    const secretHookId = /\/hooks\/([A-Za-z0-9_-]{22})\//.exec(await createSecret.text())![1]!;

    // 3. OUTSIDER_ADMIN (an admin NOT on #secret's roster) cannot see #secret, create in #secret, or rotate/revoke secretHookId!
    const outsiderSession = await h.signInAs(OUTSIDER_ADMIN);
    assert.equal(outsiderSession.html.includes('value="acme-secret"'), false);
    assert.equal(outsiderSession.html.includes(secretHookId), false);
    const outsiderCreate = await fetch(`${h.origin}/admin/hooks/create`, {
      method: "POST",
      headers: { origin: h.origin, cookie: outsiderSession.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: outsiderSession.csrf, workspace: WORKSPACE, channelSkey: "acme-secret" }).toString(),
    });
    assert.equal(outsiderCreate.status, 403);
    const outsiderRevoke = await fetch(`${h.origin}/admin/hooks/revoke`, {
      method: "POST",
      headers: { origin: h.origin, cookie: outsiderSession.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: outsiderSession.csrf, hookId: secretHookId }).toString(),
    });
    assert.equal(outsiderRevoke.status, 403);

    // 4. When the app loses its grant on #secret (cannot read private roster), the hook is listed as unavailable and cannot be managed!
    h.state.summary = {
      ...h.state.summary,
      installs: [{ did: APP_DID, channels: [{ skey: "acme-general", write: true }] }],
    };
    const unavailableHtml = await (await fetch(`${h.origin}/admin`, { headers: { cookie: authSession.cookie } })).text();
    assert.match(unavailableHtml, /unavailable · app cannot read private roster/);
    const manageUnavailable = await fetch(`${h.origin}/admin/hooks/revoke`, {
      method: "POST",
      headers: { origin: h.origin, cookie: authSession.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: authSession.csrf, hookId: secretHookId }).toString(),
    });
    assert.equal(manageUnavailable.status, 403);

    // 5. Demoting ADMIN takes effect on the very next request!
    const adminSession = await h.signInAs(ADMIN);
    h.state.summary = {
      ...h.state.summary,
      admins: [AUTHORITY],
    };
    const afterDemotion = await fetch(`${h.origin}/admin`, { headers: { cookie: adminSession.cookie } });
    assert.equal(afterDemotion.status, 403, "demoted admin loses access on the very next request");
  } finally {
    await h.close();
  }
});

test("hook endpoint enforces constant-time identical 404s, rate-limit order, synchronous 64 KiB body validation before any network call, and fresh write-grant check", async () => {
  const h = await startTestHarness({
    limits: { failedHooksPerAddress: 3, failedHooksTotal: 5, validHookPerMinute: 2 },
  });
  try {
    const { cookie, csrf } = await h.signInAs(ADMIN);
    const createOne = await fetch(`${h.origin}/admin/hooks/create`, {
      method: "POST",
      headers: { origin: h.origin, cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, workspace: WORKSPACE, channelSkey: "acme-general" }).toString(),
    });
    const [, id1, secret1] = /\/hooks\/([A-Za-z0-9_-]{22})\/([A-Za-z0-9_-]{43})/.exec(await createOne.text())!;

    const createTwo = await fetch(`${h.origin}/admin/hooks/create`, {
      method: "POST",
      headers: { origin: h.origin, cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, workspace: WORKSPACE, channelSkey: "acme-general" }).toString(),
    });
    const [, revokedId, revokedSecret] = /\/hooks\/([A-Za-z0-9_-]{22})\/([A-Za-z0-9_-]{43})/.exec(await createTwo.text())!;
    await fetch(`${h.origin}/admin/hooks/revoke`, {
      method: "POST",
      headers: { origin: h.origin, cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, hookId: revokedId! }).toString(),
    });

    // 1. Unknown hook, wrong secret, and revoked hook return identical 404 status + body, even with non-JSON Content-Type
    //    (proving secret comparison runs BEFORE anything else answers), and make ZERO workspace summary calls!
    const summariesBefore = h.state.summaryCalls;
    const unknownRes = await fetch(`${h.origin}/hooks/${"a".repeat(22)}/${secret1}`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "not-json",
    });
    const wrongRes = await fetch(`${h.origin}/hooks/${id1}/${"b".repeat(43)}`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "not-json",
    });
    const revokedRes = await fetch(`${h.origin}/hooks/${revokedId}/${revokedSecret}`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "not-json",
    });
    const [uBody, wBody, rBody] = await Promise.all([unknownRes.text(), wrongRes.text(), revokedRes.text()]);
    assert.deepEqual([unknownRes.status, wrongRes.status, revokedRes.status], [404, 404, 404]);
    assert.equal(uBody, wBody);
    assert.equal(wBody, rBody);
    assert.equal(h.state.summaryCalls, summariesBefore, "failed secrets trigger zero workspace reads");

    // 4th failed attempt in the same minute hits the failed-attempt per-address limiter (429), while the VALID hook secret
    // STILL works because failed attempts never consume the valid hook's per-hook budget!
    const fourthFailed = await fetch(`${h.origin}/hooks/${id1}/${"c".repeat(43)}`, { method: "POST" });
    assert.equal(fourthFailed.status, 429);

    // 2. Body bounds and validation run BEFORE any workspace summary read!
    h.advance(60_000);
    const beforeBadBodies = h.state.summaryCalls;
    const wrongType = await fetch(`${h.origin}/hooks/${id1}/${secret1}`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: '{"text":"hi"}',
    });
    assert.equal(wrongType.status, 415);

    h.advance(60_000);
    const hugeBody = await fetch(`${h.origin}/hooks/${id1}/${secret1}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(70_000) }),
    });
    assert.equal(hugeBody.status, 413);

    h.advance(60_000);
    const extraField = await fetch(`${h.origin}/hooks/${id1}/${secret1}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi", unexpected: true }),
    });
    assert.equal(extraField.status, 400);
    assert.equal(h.state.summaryCalls, beforeBadBodies, "bad media type, oversized stream, and invalid body make zero PDS calls");

    // 3. Valid hook posts message with blocks, and per-hook rate limit (max 2/min) returns 429 on 3rd valid call!
    h.advance(60_000);
    const valid1 = await fetch(`${h.origin}/hooks/${id1}/${secret1}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "deploy ok", blocks: [sectionBlock("deploy ok")] }),
    });
    assert.equal(valid1.status, 200);
    assert.equal(h.state.sendCalls.length, 1);
    assert.equal(h.state.sendCalls[0]!.text, "deploy ok");

    const valid2 = await fetch(`${h.origin}/hooks/${id1}/${secret1}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "deploy 2" }),
    });
    assert.equal(valid2.status, 200);

    const valid3 = await fetch(`${h.origin}/hooks/${id1}/${secret1}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "deploy 3" }),
    });
    assert.equal(valid3.status, 429, "per-hook rate limit triggers once secret matched");

    // 4. Write-grant check and channel-transition check: read-only grant or transitioning channel returns 404 and writes nothing!
    h.advance(60_000);
    const sendsBeforeReadOnly = h.state.sendCalls.length;
    h.state.summary = {
      ...h.state.summary,
      installs: [{ did: APP_DID, channels: [{ skey: "acme-general", write: false }] }],
    };
    const readOnlyRes = await fetch(`${h.origin}/hooks/${id1}/${secret1}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "blocked write" }),
    });
    assert.equal(readOnlyRes.status, 404);
    assert.equal(await readOnlyRes.text(), uBody, "identical 404 body when write grant is gone");
    assert.equal(h.state.sendCalls.length, sendsBeforeReadOnly, "nothing written without write grant");

    h.state.summary = {
      ...h.state.summary,
      channels: [{ uri: `at://${AUTHORITY}/space/new.flock.channel/acme-general`, skey: "acme-general", name: "general", visibility: "transitioning" }],
      installs: [{ did: APP_DID, channels: [{ skey: "acme-general", write: true }] }],
    };
    const transitioningRes = await fetch(`${h.origin}/hooks/${id1}/${secret1}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "blocked transitioning" }),
    });
    assert.equal(transitioningRes.status, 404);
    assert.equal(h.state.sendCalls.length, sendsBeforeReadOnly);
  } finally {
    await h.close();
  }
});
