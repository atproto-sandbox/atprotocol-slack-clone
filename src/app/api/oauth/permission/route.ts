import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getOAuthClient } from "@/auth/oauth";
import { requireSession } from "@/auth/session";
import { acquireOAuthPermissionFlowLock, releaseOAuthPermissionFlowLock } from "@/auth/oauth-request-lock";
import { classifyOAuthRouteError } from "@/auth/oauth-route-error";
import { permissionScopeFor } from "@/auth/permission-sets";
import { canonicalOAuthScope } from "@/auth/oauth-scope";
import { oauthFlowCookieName, startOAuthFlow } from "@/auth/oauth-flow";
import { getConfig } from "@/lib/config";
import { isDid } from "@/protocol/keys";
import { authorityStartUrl, issueAuthorityTicket } from "@/operator/authority-grant";
import { readRequestJson, RequestJsonError } from "@/lib/bounded-json";
import { rejectCrossOriginMutation } from "@/lib/same-origin-mutation";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const rejected = rejectCrossOriginMutation(request);
  if (rejected) return rejected;
  let permissionLock: { did: string; token: string } | undefined;
  let callbackOwnsLock = false;
  try {
    const session = await requireSession();
    const body = await readRequestJson<{ action?: unknown; workspaceDid?: unknown; workspaceSkey?: unknown; skey?: unknown; workspaceName?: unknown }>(request);
    if (typeof body.action !== "string" || typeof body.workspaceDid !== "string" || !isDid(body.workspaceDid)) {
      return NextResponse.json({ error: "Invalid permission request." }, { status: 400 });
    }
    if (body.action === "workspaceAuthority") {
      // Not a widening of this sign-in: a ticket for the separate authority flow, which only this account can complete.
      const name = typeof body.workspaceName === "string" ? body.workspaceName.trim() : "";
      const ticket = issueAuthorityTicket({
        initiatorDid: session.did,
        authorityDid: session.did,
        purpose: name ? { kind: "createWorkspace", name } : { kind: "reauthorize" },
      });
      return NextResponse.json({ redirectUrl: authorityStartUrl(ticket).toString() });
    }
    if (body.skey !== undefined && typeof body.skey !== "string") {
      return NextResponse.json({ error: "Invalid channel key." }, { status: 400 });
    }
    if (body.workspaceSkey !== undefined && typeof body.workspaceSkey !== "string") {
      return NextResponse.json({ error: "Invalid workspace key." }, { status: 400 });
    }
    const scopes = permissionScopeFor(body.action, {
      workspaceDid: body.workspaceDid,
      ...(typeof body.workspaceSkey === "string" ? { workspaceSkey: body.workspaceSkey } : {}),
      ...(typeof body.skey === "string" ? { skey: body.skey } : {}),
      serviceRef: getConfig().operatorServiceRef,
    });
    const { appUrl, encryptionKey } = getConfig();
    const existingToken = await session.getTokenInfo();
    const clientScope = canonicalOAuthScope(["atproto", existingToken.scope, ...scopes]);
    const flowLockToken = randomUUID();
    if (!acquireOAuthPermissionFlowLock(session.did, flowLockToken)) {
      return NextResponse.json({ error: "A permission request is already in progress. Finish it or try again shortly." }, { status: 409 });
    }
    permissionLock = { did: session.did, token: flowLockToken };
    const flow = await startOAuthFlow(getOAuthClient(clientScope), session.did, { scope: clientScope }, {
      kind: "permission",
      expectedDid: session.did,
      clientScope,
      flowLockToken,
    }, encryptionKey);
    const response = NextResponse.json({ redirectUrl: flow.url.toString() });
    response.cookies.set(oauthFlowCookieName(flow.state), flow.cookieValue, {
      httpOnly: true,
      secure: appUrl.protocol === "https:",
      sameSite: "lax",
      path: "/oauth/callback",
      maxAge: 15 * 60,
    });
    callbackOwnsLock = true;
    return response;
  } catch (error) {
    if (error instanceof RequestJsonError) return NextResponse.json({ error: error.message }, { status: error.status });
    const details = classifyOAuthRouteError(error, "Unable to request permission.");
    return NextResponse.json({ error: details.message }, {
      status: details.status,
      ...(details.retryAfterSeconds ? { headers: { "retry-after": String(details.retryAfterSeconds) } } : {}),
    });
  } finally {
    if (permissionLock && !callbackOwnsLock) {
      try { releaseOAuthPermissionFlowLock(permissionLock.did, permissionLock.token); }
      catch { /* The bounded lease expires if cleanup encounters a database error. */ }
    }
  }
}
