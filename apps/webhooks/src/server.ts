import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { validateMessageInput, type MessageBlock } from "@flock/client/blocks";
import type { Engine } from "@flock/client/engine";
import { ChannelUnavailableError, isAccessLost } from "@flock/client/errors";
import { ADMIN_OAUTH_PATHS, PendingSignInCapError, type AdminIdentityOAuth } from "@flock/client/node/admin-oauth";
import { answerAppOAuthRoute, type NodeOAuthClient } from "@flock/client/node/oauth";
import type { WorkspaceSummary } from "@flock/client/workspace-client";
import {
  clearAdminCookie,
  createProcessCookieKey,
  flowCookieName,
  parseCookieHeader,
  serializeAdminCookie,
  SESSION_COOKIE_NAME,
  signFlowCookie,
  signSessionCookie,
  verifyCsrfToken,
  verifyFlowCookie,
  verifySessionCookie,
} from "./cookies";
import { failureLine } from "./failure-line";
import type { HooksStore } from "./hooks-store";
import {
  renderAdminDashboard,
  renderAuthorizeLinkPage,
  renderErrorPage,
  renderLoginPage,
  type AdminHookRow,
  type AdminWorkspaceView,
  type WritableChannelOption,
} from "./html";
import { RateLimiter } from "./rate-limit";

export const ADMIN_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'";
export const MAX_HOOK_BODY_BYTES = 64 * 1024;
const MAX_FORM_BODY_BYTES = 16 * 1024;

const ADMIN_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "cache-control": "no-store",
  "referrer-policy": "same-origin",
  "content-security-policy": ADMIN_CSP,
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

const JSON_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

export type WebhooksEngine = Pick<Engine, "channels" | "workspaces">;

export type WebhooksHandlerDeps = {
  appUrl: string;
  appDid: string;
  workspaces: readonly string[];
  engine: WebhooksEngine;
  hooks: HooksStore;
  adminOAuth: AdminIdentityOAuth;
  appOAuth?: NodeOAuthClient;
  cookieKey?: Buffer;
  now?: () => number;
  onError?: (error: unknown) => void;
  limits?: {
    loginPerAddress?: number;
    failedHooksPerAddress?: number;
    failedHooksTotal?: number;
    validHookPerMinute?: number;
    windowMs?: number;
  };
};

export function createWebhooksHandler(deps: WebhooksHandlerDeps): (request: IncomingMessage, response: ServerResponse) => void {
  const origin = new URL(deps.appUrl).origin;
  const secureCookies = new URL(deps.appUrl).protocol === "https:";
  const cookieKey = deps.cookieKey ?? createProcessCookieKey();
  const now = deps.now ?? Date.now;
  const onError = deps.onError ?? ((error) => process.stderr.write(failureLine(error)));
  const windowMs = deps.limits?.windowMs ?? 60_000;

  const loginLimiter = new RateLimiter({ max: deps.limits?.loginPerAddress ?? 15, windowMs, now });
  const failedPerAddress = new RateLimiter({ max: deps.limits?.failedHooksPerAddress ?? 30, windowMs, now });
  const failedGlobal = new RateLimiter({ max: deps.limits?.failedHooksTotal ?? 300, windowMs, now });
  const perHookLimiter = new RateLimiter({ max: deps.limits?.validHookPerMinute ?? 30, windowMs, now });

  return (request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      onError(error);
      if (!response.headersSent) {
        sendJson(response, 500, { error: "InternalServerError" });
      } else {
        response.end();
      }
    });
  };

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", origin);
    } catch {
      sendJson(response, 400, { error: "BadRequest" });
      return;
    }

    // 1. Identity-only OAuth metadata & JWKS for `/admin/oauth/*`.
    const adminMeta = deps.adminOAuth.answerMetadataRoute(url);
    if (adminMeta) {
      response.writeHead(adminMeta.status, { ...JSON_SECURITY_HEADERS, "content-type": adminMeta.type }).end(adminMeta.body);
      return;
    }

    // 2. The webhooks app's own OAuth metadata & JWKS (`/oauth/*`), which its PDS reads on token refresh.
    if (deps.appOAuth && (url.pathname === "/oauth/client-metadata.json" || url.pathname === "/oauth/jwks.json")) {
      const appMeta = await answerAppOAuthRoute(deps.appOAuth, url);
      if (appMeta) {
        response.writeHead(appMeta.status, { ...JSON_SECURITY_HEADERS, "content-type": appMeta.type }).end(appMeta.body);
        return;
      }
    }

    // 3. Incoming webhook endpoint: `POST /hooks/<id>/<secret>`.
    const hookMatch = /^\/hooks\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (hookMatch) {
      await handleHookPost(request, response, hookMatch[1]!, hookMatch[2]!);
      return;
    }

    // 4. Admin OAuth callback: `GET /admin/oauth/callback`.
    if (url.pathname === ADMIN_OAUTH_PATHS.callback) {
      if (request.method !== "GET") {
        sendHtml(response, 405, renderErrorPage("Method not allowed", "Use GET for the OAuth callback."));
        return;
      }
      await handleAdminCallback(request, response, url);
      return;
    }

    // 5. Admin routes: `/admin`, `/admin/login`, `/admin/logout`, `/admin/hooks/{create,rotate,revoke}`.
    if (url.pathname === "/admin" && request.method === "GET") {
      await handleAdminGet(request, response);
      return;
    }
    if (url.pathname === "/admin/login" && request.method === "POST") {
      await handleAdminLogin(request, response);
      return;
    }
    if (
      request.method === "POST" &&
      (url.pathname === "/admin/logout" ||
        url.pathname === "/admin/hooks/create" ||
        url.pathname === "/admin/hooks/rotate" ||
        url.pathname === "/admin/hooks/revoke")
    ) {
      await handleAdminAction(request, response, url.pathname);
      return;
    }

    if (url.pathname.startsWith("/admin")) {
      sendHtml(response, 404, renderErrorPage("Not found", "No admin page exists at this path."));
      return;
    }
    sendJson(response, 404, { error: "NotFound" });
  }

  async function handleHookPost(
    request: IncomingMessage,
    response: ServerResponse,
    rawId: string,
    rawSecret: string,
  ): Promise<void> {
    if (request.method !== "POST") {
      request.resume();
      sendJson(response, 405, { error: "MethodNotAllowed" });
      return;
    }
    let id: string;
    let secret: string;
    try {
      id = decodeURIComponent(rawId);
      secret = decodeURIComponent(rawSecret);
    } catch {
      id = "";
      secret = "";
    }

    // Secret is compared in constant time BEFORE anything else answers. Unknown, wrong-secret, and revoked hooks all get
    // the exact same `404`, rate-limited per address and globally.
    const matchedHook = await deps.hooks.verifySecret(id, secret);
    if (!matchedHook) {
      request.resume();
      const addressAllowed = failedPerAddress.admit(clientAddress(request));
      const totalAllowed = failedGlobal.admit("global");
      if (!addressAllowed || !totalAllowed) {
        sendJson(response, 429, { error: "RateLimitExceeded" });
        return;
      }
      sendNotFound(response);
      return;
    }

    // Valid hook rate limit (`429` ONLY once the secret matched).
    if (!perHookLimiter.admit(matchedHook.id)) {
      request.resume();
      sendJson(response, 429, { error: "RateLimitExceeded" });
      return;
    }

    // Only `application/json`, at most 64 KiB read from the stream before parsing, and synchronous `validateMessageInput`
    // BEFORE any network call is made.
    if (mediaType(request.headers["content-type"]) !== "application/json") {
      request.resume();
      sendJson(response, 415, { error: "UnsupportedMediaType" });
      return;
    }
    const rawBody = await readBoundedBody(request, MAX_HOOK_BODY_BYTES);
    if (rawBody === null) {
      sendJson(response, 413, { error: "PayloadTooLarge" });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      sendJson(response, 400, { error: "InvalidBody", message: "Request body must be valid JSON." });
      return;
    }
    const validation = validateMessageInput(parsed);
    if (!validation.valid) {
      sendJson(response, 400, { error: "InvalidBody", message: validation.reason });
      return;
    }

    // Fresh write-grant and channel-visibility check BEFORE posting.
    const summary = await readFreshSummary(matchedHook.workspace);
    const ownInstall = summary?.installs.find((install) => install.did === deps.appDid);
    const channelGrant = ownInstall?.channels.find((grant) => grant.skey === matchedHook.channelSkey);
    const directoryEntry = summary?.channels.find((channel) => channel.skey === matchedHook.channelSkey);
    if (
      !summary ||
      !channelGrant ||
      !channelGrant.write ||
      !directoryEntry ||
      (directoryEntry.visibility !== "public" && directoryEntry.visibility !== "private")
    ) {
      sendNotFound(response);
      return;
    }

    const { text, blocks } = parsed as { text: string; blocks?: MessageBlock[] };
    const sent = await deps.engine.channels.send(
      { workspace: matchedHook.workspace, skey: matchedHook.channelSkey },
      text,
      undefined,
      blocks,
    );
    sendJson(response, 200, { ok: true, uri: sent.uri });
  }

  async function handleAdminLogin(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!hasSameOriginHeader(request, origin)) {
      request.resume();
      sendHtml(response, 403, renderErrorPage("Forbidden", "Origin check failed."));
      return;
    }
    if (!loginLimiter.admit(clientAddress(request))) {
      request.resume();
      sendHtml(response, 429, renderLoginPage({ error: "Too many sign-in attempts from this address. Wait a minute and try again." }));
      return;
    }
    const form = await readFormBody(request);
    if (!form) {
      sendHtml(response, 400, renderLoginPage({ error: "Invalid sign-in form submission." }));
      return;
    }
    const handle = (form.get("handle") ?? "").trim();
    if (!handle || handle.length > 256) {
      sendHtml(response, 400, renderLoginPage({ error: "Enter a valid AT Protocol handle or DID." }));
      return;
    }
    try {
      const started = await deps.adminOAuth.startSignIn(handle);
      const cookieName = flowCookieName(started.state);
      const cookieValue = signFlowCookie(started.state, started.appState, cookieKey, now());
      sendHtml(response, 200, renderAuthorizeLinkPage(started.url.href, handle), [
        serializeAdminCookie(cookieName, cookieValue, { maxAgeSeconds: 600, secure: secureCookies }),
      ]);
    } catch (error) {
      if (error instanceof PendingSignInCapError) {
        sendHtml(response, 429, renderLoginPage({ error: error.message }));
        return;
      }
      onError(error);
      sendHtml(response, 400, renderLoginPage({ error: "Could not start sign-in for that account." }));
    }
  }

  async function handleAdminCallback(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const state = url.searchParams.get("state") ?? "";
    const cookies = parseCookieHeader(request.headers.cookie);
    const cookieName = flowCookieName(state);
    const verifiedFlow = state ? verifyFlowCookie(state, cookies.get(cookieName), cookieKey, now()) : null;
    if (!verifiedFlow) {
      sendHtml(
        response,
        400,
        renderErrorPage("Sign-in refused", "This sign-in flow is missing, expired, or was started in another browser."),
      );
      return;
    }

    const clearedFlowCookie = clearAdminCookie(cookieName, secureCookies);
    let did: string;
    try {
      const completed = await deps.adminOAuth.completeSignIn(url.searchParams, {
        state,
        appState: verifiedFlow.appState,
      });
      did = completed.did;
    } catch (error) {
      onError(error);
      sendHtml(response, 400, renderErrorPage("Sign-in failed", "The authorization callback could not be verified."), [clearedFlowCookie]);
      return;
    }

    const workspaces = await loadAdminWorkspaces(did);
    if (workspaces.length === 0) {
      sendHtml(
        response,
        403,
        renderErrorPage("Access denied", "Your account is not an active admin on the roster of any workspace where this app is installed."),
        [clearedFlowCookie],
      );
      return;
    }

    const { cookieValue } = signSessionCookie(did, cookieKey, now());
    const sessionCookie = serializeAdminCookie(SESSION_COOKIE_NAME, cookieValue, {
      maxAgeSeconds: 1800,
      secure: secureCookies,
    });
    response
      .writeHead(303, {
        ...ADMIN_SECURITY_HEADERS,
        location: "/admin",
        "set-cookie": [clearedFlowCookie, sessionCookie],
      })
      .end();
  }

  async function handleAdminGet(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const cookies = parseCookieHeader(request.headers.cookie);
    const session = verifySessionCookie(cookies.get(SESSION_COOKIE_NAME), cookieKey, now());
    if (!session) {
      sendHtml(response, 200, renderLoginPage());
      return;
    }
    const workspaces = await loadAdminWorkspaces(session.did);
    if (workspaces.length === 0) {
      sendHtml(
        response,
        403,
        renderErrorPage("Access denied", "Active workspace admin membership is required."),
        [clearAdminCookie(SESSION_COOKIE_NAME, secureCookies)],
      );
      return;
    }
    sendHtml(response, 200, renderAdminDashboard({ did: session.did, csrf: session.csrf, workspaces }));
  }

  async function handleAdminAction(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
    if (!hasSameOriginHeader(request, origin)) {
      request.resume();
      sendHtml(response, 403, renderErrorPage("Forbidden", "Origin check failed."));
      return;
    }
    const cookies = parseCookieHeader(request.headers.cookie);
    const session = verifySessionCookie(cookies.get(SESSION_COOKIE_NAME), cookieKey, now());
    if (!session) {
      request.resume();
      sendHtml(response, 401, renderLoginPage({ error: "Your admin session ended. Sign in again." }));
      return;
    }
    const form = await readFormBody(request);
    if (!form || !verifyCsrfToken(session.csrf, form.get("csrf") ?? undefined)) {
      sendHtml(response, 403, renderErrorPage("Forbidden", "CSRF verification failed."));
      return;
    }

    if (pathname === "/admin/logout") {
      sendHtml(response, 200, renderLoginPage(), [clearAdminCookie(SESSION_COOKIE_NAME, secureCookies)]);
      return;
    }

    // Re-check fresh admin + roster + private-channel rosters on EVERY state-changing POST.
    const workspaces = await loadAdminWorkspaces(session.did);
    if (workspaces.length === 0) {
      sendHtml(
        response,
        403,
        renderErrorPage("Access denied", "Active workspace admin membership is required."),
        [clearAdminCookie(SESSION_COOKIE_NAME, secureCookies)],
      );
      return;
    }

    if (pathname === "/admin/hooks/create") {
      const workspaceUri = (form.get("workspace") ?? "").trim();
      const channelSkey = (form.get("channelSkey") ?? "").trim();
      const wsView = workspaces.find((ws) => ws.uri === workspaceUri);
      const channel = wsView?.writableChannels.find((ch) => ch.skey === channelSkey);
      if (!wsView || !channel) {
        sendHtml(
          response,
          403,
          renderAdminDashboard({
            did: session.did,
            csrf: session.csrf,
            workspaces,
            error: "That channel is not writable by this app or you do not have access to it.",
          }),
        );
        return;
      }
      const created = await deps.hooks.create({
        workspace: workspaceUri,
        channelSkey: channel.skey,
        channelName: channel.name,
        privateChannel: channel.visibility === "private",
        createdBy: session.did,
      });
      const updatedWorkspaces = await loadAdminWorkspaces(session.did);
      sendHtml(
        response,
        200,
        renderAdminDashboard({
          did: session.did,
          csrf: session.csrf,
          workspaces: updatedWorkspaces,
          oneTimeHookUrl: {
            hookId: created.hook.id,
            channelName: channel.name,
            url: `${origin}/hooks/${created.hook.id}/${created.secret}`,
          },
        }),
      );
      return;
    }

    const hookId = (form.get("hookId") ?? "").trim();
    const matchedRow = workspaces.flatMap((ws) => ws.hooks).find((row) => row.id === hookId);
    if (!matchedRow) {
      sendHtml(
        response,
        403,
        renderAdminDashboard({
          did: session.did,
          csrf: session.csrf,
          workspaces,
          error: "Webhook was not found or you cannot manage it.",
        }),
      );
      return;
    }

    if (pathname === "/admin/hooks/rotate") {
      if (!matchedRow.canRotate) {
        sendHtml(
          response,
          403,
          renderAdminDashboard({
            did: session.did,
            csrf: session.csrf,
            workspaces,
            error: "Cannot rotate a webhook whose channel is currently unavailable.",
          }),
        );
        return;
      }
      const rotated = await deps.hooks.rotate(hookId, {
        channelName: matchedRow.channelName,
        privateChannel: matchedRow.visibility === "private",
      });
      const updatedWorkspaces = await loadAdminWorkspaces(session.did);
      if (!rotated) {
        sendHtml(response, 404, renderAdminDashboard({ did: session.did, csrf: session.csrf, workspaces: updatedWorkspaces, error: "Webhook was not found." }));
        return;
      }
      sendHtml(
        response,
        200,
        renderAdminDashboard({
          did: session.did,
          csrf: session.csrf,
          workspaces: updatedWorkspaces,
          oneTimeHookUrl: {
            hookId: rotated.hook.id,
            channelName: matchedRow.channelName,
            url: `${origin}/hooks/${rotated.hook.id}/${rotated.secret}`,
          },
        }),
      );
      return;
    }

    // `/admin/hooks/revoke`
    if (!matchedRow.canRevoke) {
      sendHtml(
        response,
        403,
        renderAdminDashboard({
          did: session.did,
          csrf: session.csrf,
          workspaces,
          error: "Cannot manage a private channel's webhook while its roster cannot be verified.",
        }),
      );
      return;
    }
    await deps.hooks.revoke(hookId);
    const updatedWorkspaces = await loadAdminWorkspaces(session.did);
    sendHtml(
      response,
      200,
      renderAdminDashboard({
        did: session.did,
        csrf: session.csrf,
        workspaces: updatedWorkspaces,
        notice: `Revoked webhook ${hookId}.`,
      }),
    );
  }

  async function readFreshSummary(workspace: string): Promise<WorkspaceSummary | null> {
    try {
      return await deps.engine.workspaces.summary(workspace, { fresh: true });
    } catch (error) {
      if (isAccessLost(error)) return null;
      throw error;
    }
  }

  async function loadAdminWorkspaces(viewerDid: string): Promise<AdminWorkspaceView[]> {
    const views: AdminWorkspaceView[] = [];
    for (const workspaceUri of deps.workspaces) {
      const summary = await readFreshSummary(workspaceUri);
      if (!summary) continue;
      const ownInstall = summary.installs.find((install) => install.did === deps.appDid);
      if (!ownInstall) continue;
      // Must be BOTH listed as an active admin AND on the active workspace roster.
      const onRoster = summary.members.some((member) => member.did === viewerDid && member.active);
      if (!summary.admins.includes(viewerDid) || !onRoster) continue;

      const grants = new Map(ownInstall.channels.map((grant) => [grant.skey, grant.write]));
      const directory = new Map(summary.channels.map((channel) => [channel.skey, channel]));
      const privateRosters = new Map<string, Promise<{ readable: true; admitted: boolean } | { readable: false }>>();
      const checkPrivateChannel = (skey: string) => {
        let pending = privateRosters.get(skey);
        if (!pending) {
          const dir = directory.get(skey);
          if (!dir || dir.visibility !== "private" || !grants.has(skey)) {
            pending = Promise.resolve({ readable: false });
          } else {
            pending = deps.engine.channels
              .roster({ workspace: workspaceUri, skey })
              .then((members): { readable: true; admitted: boolean } => ({
                readable: true,
                admitted: viewerDid === summary.authorityDid || members.includes(viewerDid),
              }))
              .catch((error: unknown): { readable: false } => {
                if (error instanceof ChannelUnavailableError || isAccessLost(error)) return { readable: false };
                throw error;
              });
          }
          privateRosters.set(skey, pending);
        }
        return pending;
      };

      const writableChannels: WritableChannelOption[] = [];
      for (const channel of summary.channels) {
        if (channel.visibility !== "public" && channel.visibility !== "private") continue;
        if (grants.get(channel.skey) !== true) continue;
        if (channel.visibility === "private") {
          const check = await checkPrivateChannel(channel.skey);
          if (!check.readable || !check.admitted) continue;
        }
        writableChannels.push({ skey: channel.skey, name: channel.name, visibility: channel.visibility });
      }

      const storedHooks = await deps.hooks.listActiveForWorkspace(workspaceUri);
      const hooks: AdminHookRow[] = [];
      for (const hook of storedHooks) {
        const dir = directory.get(hook.channelSkey);
        const channelName = dir?.name ?? hook.channelName;
        const isPrivate = dir ? dir.visibility === "private" : hook.privateChannel;
        const writeGrant = grants.get(hook.channelSkey);

        if (isPrivate) {
          const check = await checkPrivateChannel(hook.channelSkey);
          if (!check.readable) {
            const reason = !dir
              ? "channel archived"
              : dir.visibility === "transitioning"
                ? "channel transitioning"
                : "app cannot read private roster";
            hooks.push({
              id: hook.id,
              channelSkey: hook.channelSkey,
              channelName,
              visibility: "private",
              status: "unavailable",
              unavailableReason: reason,
              canRotate: false,
              canRevoke: false,
              createdAt: hook.createdAt,
              updatedAt: hook.updatedAt,
            });
            continue;
          }
          if (!check.admitted) continue;
          if (writeGrant === true) {
            hooks.push({
              id: hook.id,
              channelSkey: hook.channelSkey,
              channelName,
              visibility: "private",
              status: "active",
              canRotate: true,
              canRevoke: true,
              createdAt: hook.createdAt,
              updatedAt: hook.updatedAt,
            });
          } else {
            hooks.push({
              id: hook.id,
              channelSkey: hook.channelSkey,
              channelName,
              visibility: "private",
              status: "unavailable",
              unavailableReason: "read-only grant",
              canRotate: false,
              canRevoke: true,
              createdAt: hook.createdAt,
              updatedAt: hook.updatedAt,
            });
          }
          continue;
        }

        if (!dir) {
          hooks.push({
            id: hook.id,
            channelSkey: hook.channelSkey,
            channelName,
            visibility: "public",
            status: "unavailable",
            unavailableReason: "channel archived",
            canRotate: false,
            canRevoke: true,
            createdAt: hook.createdAt,
            updatedAt: hook.updatedAt,
          });
        } else if (dir.visibility === "transitioning") {
          hooks.push({
            id: hook.id,
            channelSkey: hook.channelSkey,
            channelName,
            visibility: "public",
            status: "unavailable",
            unavailableReason: "channel transitioning",
            canRotate: false,
            canRevoke: false,
            createdAt: hook.createdAt,
            updatedAt: hook.updatedAt,
          });
        } else if (writeGrant !== true) {
          hooks.push({
            id: hook.id,
            channelSkey: hook.channelSkey,
            channelName,
            visibility: "public",
            status: "unavailable",
            unavailableReason: writeGrant === false ? "read-only grant" : "no channel access",
            canRotate: false,
            canRevoke: true,
            createdAt: hook.createdAt,
            updatedAt: hook.updatedAt,
          });
        } else {
          hooks.push({
            id: hook.id,
            channelSkey: hook.channelSkey,
            channelName,
            visibility: "public",
            status: "active",
            canRotate: true,
            canRevoke: true,
            createdAt: hook.createdAt,
            updatedAt: hook.updatedAt,
          });
        }
      }

      views.push({ uri: workspaceUri, name: summary.name, writableChannels, hooks });
    }
    return views;
  }
}

export async function listenWebhooksServer(
  deps: WebhooksHandlerDeps,
  listen: { port: number; host?: string },
): Promise<Server> {
  const server = createServer(createWebhooksHandler(deps));
  await new Promise<void>((resolve) => server.listen(listen.port, listen.host, resolve));
  return server;
}

function sendHtml(response: ServerResponse, status: number, html: string, setCookies?: string[]): void {
  const headers: Record<string, string | string[]> = {
    ...ADMIN_SECURITY_HEADERS,
    "content-type": "text/html; charset=utf-8",
  };
  if (setCookies && setCookies.length > 0) headers["set-cookie"] = setCookies;
  response.writeHead(status, headers).end(html);
}

function sendJson(response: ServerResponse, status: number, payload: Record<string, unknown>): void {
  response.writeHead(status, JSON_SECURITY_HEADERS).end(JSON.stringify(payload));
}

function sendNotFound(response: ServerResponse): void {
  sendJson(response, 404, { error: "NotFound" });
}

function hasSameOriginHeader(request: IncomingMessage, expectedOrigin: string): boolean {
  return typeof request.headers.origin === "string" && request.headers.origin === expectedOrigin;
}

function clientAddress(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? "unknown";
}

function mediaType(contentType: string | undefined): string {
  if (!contentType) return "";
  return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}

async function readFormBody(request: IncomingMessage): Promise<URLSearchParams | null> {
  if (mediaType(request.headers["content-type"]) !== "application/x-www-form-urlencoded") {
    request.resume();
    return null;
  }
  const raw = await readBoundedBody(request, MAX_FORM_BODY_BYTES);
  if (raw === null) return null;
  return new URLSearchParams(raw);
}

/**
 * Reads at most `maxBytes` from `request`. As soon as more than `maxBytes` arrive, reading stops immediately and `null` is
 * returned without buffering the rest of the stream.
 */
function readBoundedBody(request: IncomingMessage, maxBytes: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const onData = (chunk: Buffer | string) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        settled = true;
        request.off("data", onData);
        request.resume();
        resolve(null);
        return;
      }
      chunks.push(buf);
    };
    request.on("data", onData);
    request.once("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, total).toString("utf8"));
    });
    request.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}
