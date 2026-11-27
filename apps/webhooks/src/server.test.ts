import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { sectionBlock } from "@flock/client/blocks";
import { WorkspaceEnvelopeError } from "@flock/client/errors";
import { ADMIN_STATE_TTL_MS, MAX_PENDING_ADMIN_STATES, PendingSignInCapError, type AdminIdentityOAuth } from "@flock/client/node/admin-oauth";
import type { WorkspaceSummary } from "@flock/client/workspace-client";
import { createProcessCookieKey, SESSION_COOKIE_NAME } from "./cookies";
import { HooksStore } from "./hooks-store";
import {
  ADMIN_CSP,
  createWebhooksHandler,
  DEFAULT_LOGIN_PER_ADDRESS,
  listenWebhooksServer,
  normalizeClientAddress,
  type WebhooksHandlerDeps,
} from "./server";

const directory = mkdtempSync(join(tmpdir(), "webhooks-server-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));

const GROUP_DID = "did:plc:groupacme";
const FOUNDER = "did:plc:founder";
const ADMIN = "did:plc:admin";
const OUTSIDER_ADMIN = "did:plc:outsideradmin";
const APP_DID = "did:plc:webhooksapp";
const WORKSPACE = `at:space/${GROUP_DID}/new.flock.workspace/self`;

type TestSummary = WorkspaceSummary & { takendownMembers?: string[] };

let testCounter = 0;

async function startTestHarness(overrides: Partial<WebhooksHandlerDeps> & {
  initialSummary?: TestSummary;
  privateRosters?: Record<string, string[]>;
} = {}) {
  testCounter += 1;
  let currentNow = 1_700_000_000_000;
  const advance = (ms: number) => { currentNow += ms; };
  const hooksPath = join(directory, `hooks-${testCounter}.json`);
  const hooks = new HooksStore(hooksPath, () => currentNow);

  const state = {
    summaryCalls: 0,
    rosterError: undefined as Error | undefined,
    workspacesList: [WORKSPACE] as string[],
    sendCalls: [] as Array<{ workspace: string; skey: string; text: string; blocks?: unknown }>,
    completeSignInCalls: 0,
    pendingCap: false,
    nextSignInDid: ADMIN,
    summary: (overrides.initialSummary ?? {
      uri: WORKSPACE,
      authorityDid: GROUP_DID,
      groupDid: GROUP_DID,
      skey: "self",
      name: "Acme",
      joinPolicy: "invite",
      publicMeta: true,
      isAdmin: true,
      isModerator: false,
      admins: [FOUNDER, ADMIN, OUTSIDER_ADMIN],
      moderators: [],
      members: [
        { did: FOUNDER, active: true, roles: ["admin", "member", "channel-secret"] },
        { did: ADMIN, active: true, roles: ["admin", "member", "channel-secret"] },
        { did: OUTSIDER_ADMIN, active: true, roles: ["admin", "member"] },
      ],
      pendingMembers: [],
      roles: [],
      channels: [
        { uri: `at:space/${GROUP_DID}/new.flock.channel/general`, skey: "general", name: "general", visibility: "public" },
        { uri: `at:space/${GROUP_DID}/new.flock.channel/secret`, skey: "secret", name: "secret", visibility: "private" },
        { uri: `at:space/${GROUP_DID}/new.flock.channel/moving`, skey: "moving", name: "moving", visibility: "transitioning" },
      ],
      installs: [
        {
          did: APP_DID,
          channels: [
            { skey: "general", write: true },
            { skey: "secret", write: true },
            { skey: "moving", write: true },
          ],
        },
      ],
      degradedReasons: [],
    }) satisfies TestSummary,
    privateRosters: new Map<string, string[]>(Object.entries(overrides.privateRosters ?? { secret: [FOUNDER, ADMIN] })),
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
      summary: async (_ws: string, options?: { fresh?: boolean }) => {
        assert.equal(options?.fresh, true, "every webhooks workspace summary read must pass { fresh: true }");
        state.summaryCalls += 1;
        return state.summary;
      },
    } as never,
    channels: {
      roster: async (ref: { skey: string }) => {
        if (state.rosterError) throw state.rosterError;
        return state.privateRosters.get(ref.skey) ?? [];
      },
      send: async (ref: { workspace: string; skey: string }, text: string, _parent?: string, blocks?: unknown) => {
        state.sendCalls.push({ workspace: ref.workspace, skey: ref.skey, text, ...(blocks ? { blocks } : {}) });
        return { uri: `at:space/${GROUP_DID}/new.flock.channel/${ref.skey}/${APP_DID}/new.flock.channel.message/2222222222222`, rkey: "2222222222222" };
      },
    } as never,
  };

  const cookieKey = overrides.cookieKey ?? createProcessCookieKey();
  const server = await listenWebhooksServer(
    {
      appUrl: "http://127.0.0.1:0",
      appDid: APP_DID,
      workspaces: state.workspacesList,
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
      workspaces: state.workspacesList,
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

  return { origin, hooksPath, hooks, state, pendingFlows, advance, signInAs, close };
}

test("admin security headers, browser-bound expiring/capped sign-in, CSRF and Origin checks, and one-time secret display", async () => {
  assert.ok(DEFAULT_LOGIN_PER_ADDRESS < MAX_PENDING_ADMIN_STATES, "one client address cannot fill the pending sign-in cap");
  const h = await startTestHarness({ trustProxy: true, limits: { loginPerAddress: 4, maxHooksPerWorkspace: 2 } });
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

    // Pending sign-in cap surfaces 429; per-address sliding login rate limit over ADMIN_STATE_TTL_MS surfaces 429 and leaves
    // room under MAX_PENDING_ADMIN_STATES for other client addresses!
    h.advance(60_000);
    h.state.pendingCap = true;
    const cappedRes = await fetch(`${h.origin}/admin/login`, {
      method: "POST",
      headers: { origin: h.origin, "x-forwarded-for": "198.51.100.99", "content-type": "application/x-www-form-urlencoded" },
      body: "handle=did:plc:admin",
    });
    assert.equal(cappedRes.status, 429);
    h.state.pendingCap = false;

    // Drive a single client address ("203.0.113.7") across multiple minutes within the 10-minute state lifetime up to its limit (4).
    for (let attempt = 0; attempt < 4; attempt++) {
      h.advance(90_000);
      const okLogin = await fetch(`${h.origin}/admin/login`, {
        method: "POST",
        headers: { origin: h.origin, "x-forwarded-for": "203.0.113.7", "content-type": "application/x-www-form-urlencoded" },
        body: "handle=did:plc:admin",
      });
      assert.equal(okLogin.status, 200);
    }
    const fifthFromSameIp = await fetch(`${h.origin}/admin/login`, {
      method: "POST",
      headers: { origin: h.origin, "x-forwarded-for": "203.0.113.7", "content-type": "application/x-www-form-urlencoded" },
      body: "handle=did:plc:admin",
    });
    assert.equal(fifthFromSameIp.status, 429, "per-address login limiter blocks single client over ADMIN_STATE_TTL_MS");
    assert.ok(h.pendingFlows.size < MAX_PENDING_ADMIN_STATES, "pending state store still has room under MAX_PENDING_ADMIN_STATES");
    const otherAddressLogin = await fetch(`${h.origin}/admin/login`, {
      method: "POST",
      headers: { origin: h.origin, "x-forwarded-for": "203.0.113.8", "content-type": "application/x-www-form-urlencoded" },
      body: "handle=did:plc:admin",
    });
    assert.equal(otherAddressLogin.status, 200, "another client address can still sign in");

    // 4. Sign in as ADMIN, verify CSRF + Origin checks on create, verify per-workspace hook cap, and verify secret is shown ONCE and hashed on disk.
    h.advance(ADMIN_STATE_TTL_MS);
    const { cookie, csrf } = await h.signInAs(ADMIN);

    const badCsrf = await fetch(`${h.origin}/admin/hooks/create`, {
      method: "POST",
      headers: { origin: h.origin, cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: "wrong", workspace: WORKSPACE, channelSkey: "general" }).toString(),
    });
    assert.equal(badCsrf.status, 403);

    const badOriginCreate = await fetch(`${h.origin}/admin/hooks/create`, {
      method: "POST",
      headers: { origin: "null", cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, workspace: WORKSPACE, channelSkey: "general" }).toString(),
    });
    assert.equal(badOriginCreate.status, 403);

    const createRes = await fetch(`${h.origin}/admin/hooks/create`, {
      method: "POST",
      headers: { origin: h.origin, cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, workspace: WORKSPACE, channelSkey: "general" }).toString(),
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

    // Per-workspace active hook cap (`maxHooksPerWorkspace: 2`): 2nd succeeds, 3rd returns 400.
    const secondHookRes = await fetch(`${h.origin}/admin/hooks/create`, {
      method: "POST",
      headers: { origin: h.origin, cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, workspace: WORKSPACE, channelSkey: "general" }).toString(),
    });
    assert.equal(secondHookRes.status, 200);
    const thirdHookRes = await fetch(`${h.origin}/admin/hooks/create`, {
      method: "POST",
      headers: { origin: h.origin, cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, workspace: WORKSPACE, channelSkey: "general" }).toString(),
    });
    assert.equal(thirdHookRes.status, 400, "workspace active hook cap enforced");
  } finally {
    await h.close();
  }
});

test("every request re-checks admin AND roster membership, takendownMembers denial, private-channel rosters, transitioning channels, and unreadable private rosters", async () => {
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

    // 2. Admitted admin (FOUNDER) sees private channel #secret; transitioning channel excluded.
    const authSession = await h.signInAs(FOUNDER);
    assert.equal(authSession.html.includes('value="secret"'), true, "admitted admin sees private channel #secret");
    assert.equal(authSession.html.includes('value="moving"'), false, "transitioning channel excluded");
    // Transitioning channel creation attempt via forged POST is refused too.
    const movingCreate = await fetch(`${h.origin}/admin/hooks/create`, {
      method: "POST",
      headers: { origin: h.origin, cookie: authSession.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: authSession.csrf, workspace: WORKSPACE, channelSkey: "moving" }).toString(),
    });
    assert.equal(movingCreate.status, 403);

    // Admitted admin creates a hook in #secret, and a valid POST to #secret delivers while active with write.
    const createSecret = await fetch(`${h.origin}/admin/hooks/create`, {
      method: "POST",
      headers: { origin: h.origin, cookie: authSession.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: authSession.csrf, workspace: WORKSPACE, channelSkey: "secret" }).toString(),
    });
    assert.equal(createSecret.status, 200);
    const [, secretHookId, secretHookSecret] = /\/hooks\/([A-Za-z0-9_-]{22})\/([A-Za-z0-9_-]{43})/.exec(await createSecret.text())!;
    const privateDelivery = await fetch(`${h.origin}/hooks/${secretHookId}/${secretHookSecret}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "private alert" }),
    });
    assert.equal(privateDelivery.status, 200);
    assert.equal(h.state.sendCalls.at(-1)?.skey, "secret");

    // 3. OUTSIDER_ADMIN (an admin NOT on #secret's roster) cannot see #secret, create in #secret, or rotate/revoke secretHookId!
    const outsiderSession = await h.signInAs(OUTSIDER_ADMIN);
    assert.equal(outsiderSession.html.includes('value="secret"'), false);
    assert.equal(outsiderSession.html.includes(secretHookId), false);
    const outsiderCreate = await fetch(`${h.origin}/admin/hooks/create`, {
      method: "POST",
      headers: { origin: h.origin, cookie: outsiderSession.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: outsiderSession.csrf, workspace: WORKSPACE, channelSkey: "secret" }).toString(),
    });
    assert.equal(outsiderCreate.status, 403);
    const outsiderRevoke = await fetch(`${h.origin}/admin/hooks/revoke`, {
      method: "POST",
      headers: { origin: h.origin, cookie: outsiderSession.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: outsiderSession.csrf, hookId: secretHookId }).toString(),
    });
    assert.equal(outsiderRevoke.status, 403);

    // 4a. When #secret transitions (`visibility: "transitioning"`), its private-created hook retains private visibility (`▣secret`, not `#secret`)
    //     and is marked unavailable; when `channels.roster` throws `WorkspaceEnvelopeError`, `/admin` marks the hook unavailable instead of 500;
    //     and once #secret is archived, POSTing to its hook returns 404!
    h.state.summary = {
      ...h.state.summary,
      channels: [
        { uri: `at:space/${GROUP_DID}/new.flock.channel/general`, skey: "general", name: "general", visibility: "public" },
        { uri: `at:space/${GROUP_DID}/new.flock.channel/secret`, skey: "secret", name: "secret", visibility: "transitioning" },
      ],
    };
    const transitioningPrivateHtml = await (await fetch(`${h.origin}/admin`, { headers: { cookie: authSession.cookie } })).text();
    assert.equal(transitioningPrivateHtml.includes("▣secret"), true, "private hook in transitioning channel retains private badge");
    assert.match(transitioningPrivateHtml, /unavailable · channel transitioning/);

    h.state.summary = {
      ...h.state.summary,
      channels: [
        { uri: `at:space/${GROUP_DID}/new.flock.channel/general`, skey: "general", name: "general", visibility: "public" },
        { uri: `at:space/${GROUP_DID}/new.flock.channel/secret`, skey: "secret", name: "secret", visibility: "private" },
      ],
    };
    h.state.rosterError = new WorkspaceEnvelopeError("private channel roster exceeds supported envelope");
    const envelopeRes = await fetch(`${h.origin}/admin`, { headers: { cookie: authSession.cookie } });
    assert.equal(envelopeRes.status, 200, "oversized private roster degrades hook to unavailable instead of 500");
    assert.match(await envelopeRes.text(), /unavailable · app cannot read private roster/);
    h.state.rosterError = undefined;

    // 4b. When the app loses its grant on #secret (cannot read private roster), the hook is listed as unavailable and cannot be managed!
    h.state.summary = {
      ...h.state.summary,
      installs: [{ did: APP_DID, channels: [{ skey: "general", write: true }] }],
    };
    const unavailableHtml = await (await fetch(`${h.origin}/admin`, { headers: { cookie: authSession.cookie } })).text();
    assert.match(unavailableHtml, /unavailable · app cannot read private roster/);
    const manageUnavailable = await fetch(`${h.origin}/admin/hooks/revoke`, {
      method: "POST",
      headers: { origin: h.origin, cookie: authSession.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: authSession.csrf, hookId: secretHookId! }).toString(),
    });
    assert.equal(manageUnavailable.status, 403);

    // Archiving #secret (removing it from directory) causes POST /hooks/<secretHookId>/<secretHookSecret> to return 404.
    h.state.summary = {
      ...h.state.summary,
      channels: [{ uri: `at:space/${GROUP_DID}/new.flock.channel/general`, skey: "general", name: "general", visibility: "public" }],
      installs: [{ did: APP_DID, channels: [{ skey: "general", write: true }, { skey: "secret", write: true }] }],
    };
    const archivedPrivatePost = await fetch(`${h.origin}/hooks/${secretHookId}/${secretHookSecret}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "archived private" }),
    });
    assert.equal(archivedPrivatePost.status, 404);

    // 5. Moderation `!takedown` label on ADMIN (`takendownMembers: [ADMIN]`) immediately denies `/admin` access (`403`)!
    const adminSession = await h.signInAs(ADMIN);
    h.state.summary = {
      ...h.state.summary,
      takendownMembers: [ADMIN],
    };
    const afterTakedown = await fetch(`${h.origin}/admin`, { headers: { cookie: adminSession.cookie } });
    assert.equal(afterTakedown.status, 403, "takendown admin loses /admin access immediately");
    h.state.summary = {
      ...h.state.summary,
      takendownMembers: undefined,
    };
    assert.equal((await fetch(`${h.origin}/admin`, { headers: { cookie: adminSession.cookie } })).status, 200);

    // 6. Demoting ADMIN takes effect on the very next request!
    h.state.summary = {
      ...h.state.summary,
      admins: [FOUNDER],
    };
    const afterDemotion = await fetch(`${h.origin}/admin`, { headers: { cookie: adminSession.cookie } });
    assert.equal(afterDemotion.status, 403, "demoted admin loses access on the very next request");
  } finally {
    await h.close();
  }
});

test("hook endpoint enforces constant-time identical 404s, rate-limit order, synchronous 64 KiB body validation before any network call, and fresh write-grant check", async () => {
  const h = await startTestHarness({
    trustProxy: true,
    limits: { failedHooksPerAddress: 3, failedHooksTotal: 5, validHookPerMinute: 2 },
  });
  try {
    const { cookie, csrf } = await h.signInAs(ADMIN);
    const createOne = await fetch(`${h.origin}/admin/hooks/create`, {
      method: "POST",
      headers: { origin: h.origin, cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, workspace: WORKSPACE, channelSkey: "general" }).toString(),
    });
    const [, id1, secret1] = /\/hooks\/([A-Za-z0-9_-]{22})\/([A-Za-z0-9_-]{43})/.exec(await createOne.text())!;

    const createTwo = await fetch(`${h.origin}/admin/hooks/create`, {
      method: "POST",
      headers: { origin: h.origin, cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, workspace: WORKSPACE, channelSkey: "general" }).toString(),
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
      headers: { "x-forwarded-for": "198.51.100.1", "content-type": "text/plain" },
      body: "not-json",
    });
    const wrongRes = await fetch(`${h.origin}/hooks/${id1}/${"b".repeat(43)}`, {
      method: "POST",
      headers: { "x-forwarded-for": "198.51.100.1", "content-type": "text/plain" },
      body: "not-json",
    });
    const revokedRes = await fetch(`${h.origin}/hooks/${revokedId}/${revokedSecret}`, {
      method: "POST",
      headers: { "x-forwarded-for": "198.51.100.1", "content-type": "text/plain" },
      body: "not-json",
    });
    const [uBody, wBody, rBody] = await Promise.all([unknownRes.text(), wrongRes.text(), revokedRes.text()]);
    assert.deepEqual([unknownRes.status, wrongRes.status, revokedRes.status], [404, 404, 404]);
    assert.equal(uBody, wBody);
    assert.equal(wBody, rBody);
    assert.equal(h.state.summaryCalls, summariesBefore, "failed secrets trigger zero workspace reads");

    // 4th failed attempt from 198.51.100.1 hits the per-address failed limiter (429), AND WITHOUT advancing the clock,
    // the VALID hook secret STILL works immediately (200)!
    const fourthFailed = await fetch(`${h.origin}/hooks/${id1}/${"c".repeat(43)}`, {
      method: "POST",
      headers: { "x-forwarded-for": "198.51.100.1" },
    });
    assert.equal(fourthFailed.status, 429);
    const validWhileFailedSaturated = await fetch(`${h.origin}/hooks/${id1}/${secret1}`, {
      method: "POST",
      headers: { "x-forwarded-for": "198.51.100.1", "content-type": "application/json" },
      body: JSON.stringify({ text: "unaffected by failed-attempt limiter" }),
    });
    assert.equal(validWhileFailedSaturated.status, 200, "valid hook succeeds even while failed-attempt limiter is saturated");

    // Global failed limiter (`failedHooksTotal: 5`): 4 failed calls happened above; 5th from a second IP returns 404, 6th returns 429!
    const fifthGlobalFailed = await fetch(`${h.origin}/hooks/${id1}/${"d".repeat(43)}`, {
      method: "POST",
      headers: { "x-forwarded-for": "198.51.100.2" },
    });
    assert.equal(fifthGlobalFailed.status, 404);
    const sixthGlobalFailed = await fetch(`${h.origin}/hooks/${id1}/${"e".repeat(43)}`, {
      method: "POST",
      headers: { "x-forwarded-for": "198.51.100.2" },
    });
    assert.equal(sixthGlobalFailed.status, 429, "global failed-attempt limiter triggers across addresses");

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

    // 3. Valid hook posts message with blocks, per-hook rate limit (max 2/min) returns 429 on 3rd valid call, AND a wrong secret
    //    for that over-budget hook STILL returns 404 (not 429), proving secret verification precedes per-hook rate limiting!
    h.advance(60_000);
    const sendsBeforeValidBurst = h.state.sendCalls.length;
    const valid1 = await fetch(`${h.origin}/hooks/${id1}/${secret1}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "deploy ok", blocks: [sectionBlock("deploy ok")] }),
    });
    assert.equal(valid1.status, 200);
    assert.equal(h.state.sendCalls.length, sendsBeforeValidBurst + 1);
    assert.equal(h.state.sendCalls.at(-1)!.text, "deploy ok");

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

    const wrongSecretWhileHookOverBudget = await fetch(`${h.origin}/hooks/${id1}/${"f".repeat(43)}`, {
      method: "POST",
      headers: { "x-forwarded-for": "198.51.100.3", "content-type": "application/json" },
      body: JSON.stringify({ text: "probe" }),
    });
    assert.equal(wrongSecretWhileHookOverBudget.status, 404, "wrong secret on an over-budget hook returns 404, never 429");

    // 4. Dropping the workspace from `deps.workspaces`, removing the write grant, or transitioning the channel returns 404 and writes nothing!
    h.advance(60_000);
    const sendsBeforeRefusals = h.state.sendCalls.length;
    h.state.workspacesList.length = 0;
    const droppedWorkspaceRes = await fetch(`${h.origin}/hooks/${id1}/${secret1}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "unconfigured workspace" }),
    });
    assert.equal(droppedWorkspaceRes.status, 404);
    h.state.workspacesList.push(WORKSPACE);

    h.advance(60_000);
    h.state.summary = {
      ...h.state.summary,
      installs: [{ did: APP_DID, channels: [{ skey: "general", write: false }] }],
    };
    const readOnlyRes = await fetch(`${h.origin}/hooks/${id1}/${secret1}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "blocked write" }),
    });
    assert.equal(readOnlyRes.status, 404);
    assert.equal(await readOnlyRes.text(), uBody, "identical 404 body when write grant is gone");
    assert.equal(h.state.sendCalls.length, sendsBeforeRefusals, "nothing written without write grant");

    h.state.summary = {
      ...h.state.summary,
      channels: [{ uri: `at:space/${GROUP_DID}/new.flock.channel/general`, skey: "general", name: "general", visibility: "transitioning" }],
      installs: [{ did: APP_DID, channels: [{ skey: "general", write: true }] }],
    };
    const transitioningRes = await fetch(`${h.origin}/hooks/${id1}/${secret1}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "blocked transitioning" }),
    });
    assert.equal(transitioningRes.status, 404);
    assert.equal(h.state.sendCalls.length, sendsBeforeRefusals);
  } finally {
    await h.close();
  }
});

test("https appUrl sets Secure on flow and session cookies, and normalizeClientAddress groups IPv6 by /64", async () => {
  assert.equal(normalizeClientAddress("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(normalizeClientAddress("::1"), "::1");
  assert.equal(
    normalizeClientAddress("2001:db8:abcd:0012:1111:2222:3333:4444"),
    normalizeClientAddress("2001:0db8:abcd:12::9999"),
  );
  assert.equal(normalizeClientAddress("2001:db8:abcd:12::1"), "2001:0db8:abcd:0012::/64");

  const h = await startTestHarness();
  try {
    // Re-mount handler with an `https://` appUrl and verify `Secure` is emitted on both flow and session Set-Cookie headers.
    const httpsOrigin = "https://hooks.example";
    const httpsServer = await listenWebhooksServer(
      {
        appUrl: httpsOrigin,
        appDid: APP_DID,
        workspaces: [WORKSPACE],
        engine: {
          workspaces: { summary: async (_ws: string, opts?: { fresh?: boolean }) => { assert.equal(opts?.fresh, true); return h.state.summary; } } as never,
          channels: { roster: async () => [ADMIN], send: async () => ({ uri: "at://x", rkey: "2222222222222" }) } as never,
        },
        hooks: h.hooks,
        adminOAuth: {
          client: {} as never,
          states: {} as never,
          answerMetadataRoute: () => null,
          startSignIn: async () => ({ url: new URL("https://pds.example/oauth/authorize?state=pstate_https_123456789012345"), state: "pstate_https_123456789012345", appState: "astate_https_12345678901234567890" }),
          completeSignIn: async () => ({ did: ADMIN }),
        },
      },
      { port: 0, host: "127.0.0.1" },
    );
    const { port } = httpsServer.address() as AddressInfo;
    try {
      const loginRes = await fetch(`http://127.0.0.1:${port}/admin/login`, {
        method: "POST",
        headers: { origin: httpsOrigin, "content-type": "application/x-www-form-urlencoded" },
        body: "handle=did:plc:admin",
      });
      assert.equal(loginRes.status, 200);
      const flowSetCookie = loginRes.headers.getSetCookie()[0]!;
      assert.match(flowSetCookie, /;\s*Secure\b/);

      const cbRes = await fetch(`http://127.0.0.1:${port}/admin/oauth/callback?code=ok&state=pstate_https_123456789012345`, {
        redirect: "manual",
        headers: { cookie: flowSetCookie.split(";")[0]! },
      });
      assert.equal(cbRes.status, 303);
      const sessionSetCookie = cbRes.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))!;
      assert.match(sessionSetCookie, /;\s*Secure\b/);
    } finally {
      httpsServer.closeAllConnections();
      await new Promise<void>((resolve) => httpsServer.close(() => resolve()));
    }
  } finally {
    await h.close();
  }
});
