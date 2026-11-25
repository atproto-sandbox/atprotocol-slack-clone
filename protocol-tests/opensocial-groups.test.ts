import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { P256Keypair } from "@atproto/crypto";
import { JoseKey } from "@atproto/jwk-jose";
import {
  NodeOAuthClient,
  oauthClientMetadataSchema,
  type NodeSavedSession,
  type NodeSavedState,
} from "@atproto/oauth-client-node";
import { createServiceJwt } from "@atproto/xrpc-server";
import { didForCreateOp, formatAtprotoOp, signOperation } from "@did-plc/lib";
import { AppAccessLostError, publishAppDeclaration } from "@flock/client/app-runtime";
import { createEngine } from "@flock/client/engine";
import { IncompatibleInvitesSpacePolicyError, JoinOperationQuotaExceededError } from "@flock/client/errors";
import {
  createInMemoryMigrationStateStore,
  GroupClient,
  type InFlightGroupMigration,
} from "@flock/client/group-client";
import { MemoryStore } from "@flock/client/memory-store";
import { nodeTransport } from "@flock/client/node/transport";
import { ECHO_BOT_COMMANDS, startEchoBot } from "@flock/echo-bot/echo";
import { SCHEMA_TABLE_CLASSIFICATION } from "@flock/group-host/db";
import { startGroupHostServer, type RunningGroupHost } from "@flock/group-host/server";
import { sessionClient } from "@flock/operator/atproto/client";
import { getRawDb } from "@flock/operator/lib/db";
import { parseWorkspaceRef, type OperatorActor } from "@flock/operator/operator/actor";
import { restoreAuthorityGrant } from "@flock/operator/operator/authority-grant";
import { grantCreationAuthorization } from "@flock/operator/operator/creation-authorization";
import { OperatorAuthError } from "@flock/operator/operator/errors";
import { createWorkspace } from "@flock/operator/operator/kinds/create-workspace";
import { executeOperatorOperation } from "@flock/operator/operator/operations";
import { registrationDeps } from "@flock/operator/operator/registrations";
import { authorizeOperationActor } from "@flock/operator/operator/security";
import { createSpaceSigHeaders, isAccessLost, mintSpaceCredentialWith } from "@flock/protocol/atproto/space-credential-core";
import { AtprotoClient, XrpcError } from "@flock/protocol/atproto/xrpc";
import {
  channelUri,
  groupMembersUri,
  groupMetaUri,
  personalInvitesUri,
  requestDigest,
  SELF_SKEY,
  spaceRecordUri,
  subjectKey,
  tidNow,
  workspaceUri,
} from "@flock/protocol/keys";
import {
  ATPROTO_SPACE_COLLECTION,
  COLLECTION,
  OPENSOCIAL_COLLECTION,
  OPENSOCIAL_METHOD,
  OPENSOCIAL_POLICY,
  OPENSOCIAL_SPACE_TYPE,
  REPO_COLLECTION,
  SPACE_TYPE,
} from "@flock/protocol/nsids";
import { appGrantScopes, groupAdminScopes, groupModeratorScopes, memberGrantScopes } from "@flock/protocol/scopes";
import {
  listIndependentWorkspaces,
  readIndependentChannelPage,
  readIndependentInvites,
  readIndependentWorkspace,
} from "@flock/reader/independent";
import express from "express";
import * as jose from "jose";
import {
  acceptGroupMembership,
  actorTransport,
  approveAtRealPersonalPds,
  bearerSession,
  completeRealGroupOAuthFlow,
  createGroupDpopClient,
  createOpenSocialGroup,
  inProcessOperator,
  mintAppSession,
  startPdsNetwork,
  storeGroupAuthorityGrant,
  type DpopClient,
  type NetworkActor,
  type PdsNetwork,
} from "./support/pds-network";

const execFileAsync = promisify(execFile);
const MEMBERSPACE_POLICY = "com.atproto.memberspace.policy";

function clientTransport(
  network: Pick<PdsNetwork, "plcUrl">,
  actor: NetworkActor,
  options: { now?: () => number; fetchVia?: (request: Request) => Promise<Response> } = {},
) {
  return actorTransport(network, actor, options);
}

function makeSimpleStore<V>(entries = new Map<string, V>()) {
  return {
    get: async (key: string) => entries.get(key),
    set: async (key: string, value: V) => {
      entries.set(key, value);
    },
    del: async (key: string) => {
      entries.delete(key);
    },
  };
}

function makeGroupClient(host: RunningGroupHost, groupDid: string, dpop: DpopClient, accessToken: string): GroupClient {
  return new GroupClient({
    groupDid,
    fetchHandler: async (path, init) => {
      const reqBody: BodyInit | undefined =
        init.body instanceof Uint8Array ? new Uint8Array(init.body) : (init.body ?? undefined);
      return dpop.fetchWithDpop(`${host.url}${path}`, {
        method: init.method ?? "GET",
        headers: init.headers,
        ...(reqBody !== undefined ? { body: reqBody } : {}),
        accessToken,
      });
    },
  });
}

async function mintPersonalServiceJwt(actor: NetworkActor, aud: string, lxm: string): Promise<string> {
  const client = sessionClient(bearerSession(actor) as never);
  const { token } = await client.query<{ token: string }>("com.atproto.server.getServiceAuth", { aud, lxm });
  return token;
}

async function personalGroupCall<T = Record<string, unknown>>(params: {
  hostUrl: string;
  actor: NetworkActor;
  groupDid: string;
  path: string;
  httpMethod: "GET" | "POST";
  lxm: string;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
}): Promise<{ status: number; headers: Headers; json: T }> {
  const jwt = await mintPersonalServiceJwt(params.actor, `${params.groupDid}#atproto_pds`, params.lxm);
  const qs = params.query ? `?${new URLSearchParams(params.query).toString()}` : "";
  const fullPath = params.path.startsWith("/") ? params.path : `/xrpc/${params.path}`;
  const res = await fetch(`${params.hostUrl}${fullPath}${qs}`, {
    method: params.httpMethod,
    headers: {
      authorization: `Bearer ${jwt}`,
      ...(params.body ? { "content-type": "application/json" } : {}),
      ...params.headers,
    },
    ...(params.body ? { body: JSON.stringify(params.body) } : {}),
  });
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    json: (text ? JSON.parse(text) : {}) as T,
  };
}

async function captureXrpcError(fn: () => Promise<unknown>): Promise<{ status: number; code: string; message: string }> {
  try {
    await fn();
    assert.fail("Expected XrpcError");
  } catch (err) {
    assert.ok(err instanceof XrpcError, `Expected XrpcError, got ${String(err)}`);
    return { status: err.status, code: err.code, message: err.message };
  }
}

/**
 * Walks Group Host `/oauth/authorize` -> real personal PDS `approveAtRealPersonalPds` -> `/oauth/upstream-callback` ->
 * optional `/oauth/confirm-action` for an authorization URL produced by `NodeOAuthClient.authorize(...)`.
 */
async function walkGroupHostAuthorizeUrl(params: {
  groupHost: RunningGroupHost;
  actor: NetworkActor;
  authorizeUrl: URL;
  prompt?: "create" | "login" | "consent";
  targetGroup?: string;
  createParams?: {
    displayName: string;
    handle?: string;
    joinPolicy?: "invite" | "approval" | "open";
    publicMeta?: boolean;
    creationKey?: string;
  };
  authorizeDecision?: "approve" | "deny";
  confirmDecision?: "approve" | "deny";
}): Promise<string> {
  const getFormRes = await fetch(params.authorizeUrl, { redirect: "manual" });
  let authRes: Response;
  if (getFormRes.status >= 300 && getFormRes.status < 400) {
    authRes = getFormRes;
  } else {
    assert.equal(getFormRes.status, 200);
    const formHtml = await getFormRes.text();
    const csrfMatch = /name="csrf_token"\s+value="([^"]+)"/.exec(formHtml);
    const creationKeyMatch = /name="creation_key"\s+value="([^"]+)"/.exec(formHtml);
    const clientIdMatch = /name="client_id"\s+value="([^"]+)"/.exec(formHtml);
    const requestUriMatch = /name="request_uri"\s+value="([^"]+)"/.exec(formHtml);
    assert.ok(csrfMatch?.[1] && clientIdMatch?.[1] && requestUriMatch?.[1]);

    const decodeAttr = (v: string) =>
      v.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">");

    const postForm = new URLSearchParams({
      client_id: decodeAttr(clientIdMatch[1]),
      request_uri: decodeAttr(requestUriMatch[1]),
      csrf_token: decodeAttr(csrfMatch[1]),
      actor: params.actor.did,
      decision: params.authorizeDecision ?? "approve",
    });
    if (params.prompt === "create") {
      postForm.set(
        "creation_key",
        params.createParams?.creationKey ?? (creationKeyMatch?.[1] ? decodeAttr(creationKeyMatch[1]) : `ck-${randomUUID()}`),
      );
      postForm.set("display_name", params.createParams?.displayName ?? "OAuth Client Team");
      postForm.set("join_policy", params.createParams?.joinPolicy ?? "invite");
      if (params.createParams?.publicMeta ?? true) postForm.set("public_meta", "true");
      if (params.createParams?.handle) postForm.set("handle", params.createParams.handle);
    } else if (params.targetGroup && formHtml.includes('name="group"')) {
      postForm.set("group", params.targetGroup);
    }
    authRes = await fetch(`${params.groupHost.url}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: postForm.toString(),
      redirect: "manual",
    });
    if (params.authorizeDecision === "deny") {
      assert.ok(authRes.status >= 300 && authRes.status < 400);
      return authRes.headers.get("location")!;
    }
  }
  assert.ok(authRes.status >= 300 && authRes.status < 400);
  const flowCookie = authRes.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .join("; ");
  const upstreamAuthorizeUrl = new URL(authRes.headers.get("location")!);
  const upstreamCallbackUrl = await approveAtRealPersonalPds(params.actor, upstreamAuthorizeUrl);

  const cbRes = await fetch(upstreamCallbackUrl, {
    method: "GET",
    headers: { cookie: flowCookie },
    redirect: "manual",
  });
  assert.ok(cbRes.status >= 300 && cbRes.status < 400, `Expected upstream-callback redirect, got ${cbRes.status}`);
  const cbLoc = cbRes.headers.get("location")!;
  if (!cbLoc.startsWith(`${params.groupHost.url}/oauth/confirm-action`)) {
    return cbLoc;
  }

  const consentCookie = cbRes.headers
    .getSetCookie()
    .filter((c) => !c.includes("Max-Age=0"))
    .map((c) => c.split(";")[0]!)
    .join("; ");
  const getConfirmRes = await fetch(cbLoc, {
    method: "GET",
    headers: { cookie: consentCookie },
    redirect: "manual",
  });
  assert.equal(getConfirmRes.status, 200);
  const html = await getConfirmRes.text();
  const csrfMatch = /name="csrf_token"\s+value="([^"]+)"/.exec(html);
  const confirmRes = await fetch(`${params.groupHost.url}/oauth/confirm-action`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: consentCookie },
    body: new URLSearchParams({
      csrf_token: csrfMatch?.[1] ?? "",
      decision: params.confirmDecision ?? "approve",
    }).toString(),
    redirect: "manual",
  });
  assert.ok(confirmRes.status >= 300 && confirmRes.status < 400);
  return confirmRes.headers.get("location")!;
}

async function stepUpRealGroupClient(
  groupHost: GroupHostServer,
  actor: NetworkActor,
  groupDid: string,
): Promise<GroupClient> {
  const flow = await completeRealGroupOAuthFlow({
    groupHost,
    actor,
    scope: groupAdminScopes().join(" "),
    prompt: "login",
    loginHint: groupDid,
  });
  assert.ok(flow.tokenResponse, "Expected tokenResponse from prompt=login step-up");
  return makeGroupClient(groupHost, groupDid, flow.dpop, flow.tokenResponse.access_token);
}

async function createFullFlockWorkspace(
  pds: PdsNetwork,
  creator: NetworkActor,
  options: {
    name?: string;
    joinPolicy?: "invite" | "approval" | "open";
    publicMeta?: boolean;
    skipAcceptance?: boolean;
  } = {},
) {
  const name = options.name ?? `Team ${randomUUID().slice(0, 6)}`;
  const group = await createOpenSocialGroup(pds, creator, {
    name,
    joinPolicy: options.joinPolicy ?? "invite",
    publicMeta: options.publicMeta ?? true,
    skipAcceptance: true,
  });
  grantCreationAuthorization(
    {
      authorityDid: group.groupDid,
      initiatorDid: creator.did,
      name,
    },
    Math.floor(Date.now() / 1000),
  );
  const grant = await restoreAuthorityGrant(group.groupDid);
  const created = await createWorkspace(
    grant,
    {
      creator: creator.did,
      name,
      operationId: tidNow(),
      ...(options.joinPolicy ? { joinPolicy: options.joinPolicy } : {}),
    },
    registrationDeps,
  );
  assert.equal(created.state, "completed");
  if (!options.skipAcceptance) {
    await acceptGroupMembership(pds, creator, group.groupDid);
  }
  const groupClient = makeGroupClient(pds.groupHost, group.groupDid, group.dpop, group.accessToken);
  return {
    ...group,
    created,
    channel: created.channel,
    channelSkey: created.channel.split("/").at(-1)!,
    groupClient,
  };
}

async function listenHttp(app: ReturnType<typeof express>): Promise<{ server: Server; url: string; close(): Promise<void> }> {
  const server = createHttpServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  server.unref();
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

async function drainGroupHost(host: RunningGroupHost): Promise<void> {
  await host.flushBackgroundWork();
  for (let pass = 0; pass < 40; pass += 1) {
    const counts = host.db
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'leased' THEN 1 ELSE 0 END) AS leased,
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
         FROM outbox_notice`,
      )
      .get() as { leased: number | null; pending: number | null };
    const leased = counts.leased ?? 0;
    const pending = counts.pending ?? 0;
    if (leased === 0 && pending === 0) break;
    if (leased > 0) {
      await new Promise((r) => setTimeout(r, 25));
      continue;
    }
    host.db.prepare("UPDATE outbox_notice SET next_attempt_at = 0 WHERE status = 'pending'").run();
    await host.flushBackgroundWork();
  }
}

test("OpenSocial atmospheric groups real-network acceptance suite (Gate 5a)", { timeout: 120_000 }, async (t) => {
  const pds = await startPdsNetwork("opensocial-groups");
  const operatorUrl = await inProcessOperator();
  const operatorService = { serviceRef: pds.serviceRef, endpoint: operatorUrl };
  let actorSeq = 0;
  const nextActor = (prefix: string, host: 0 | 1 = 0) => pds.createActor(`${prefix}${++actorSeq}`, host);

  try {
    // =========================================================================
    // 1. Real OAuth, Lexicon Scope Checks, Consent, `prompt=create` Failpoints,
    //    Replay Cascade, Moderator Anti-Escalation & Governance Takeover
    // =========================================================================
    await t.test(
      "1. Real OAuth, lexicon scope checks, public/confidential clients, consent, prompt=create failpoints, replay & takeover",
      async () => {
        const alice = await nextActor("oauthalice", 0);
        const bob = await nextActor("oauthbob", 1);
        const carol = await nextActor("oauthcarol", 0);
        const dan = await nextActor("oauthdan", 1);

        // 1a. Positive & negative real-personal-PDS `OAuthProvider.authorize()` `lexiconManager.getSpacesFromScope` checks
        const memberScopeStr = memberGrantScopes(pds.serviceRef).join(" ");
        const appScopeStr = appGrantScopes(pds.serviceRef).join(" ");

        for (const [actor, fullScope] of [
          [alice, memberScopeStr],
          [bob, appScopeStr],
        ] as const) {
          const provider = actor.pds.ctx.oauthProvider!;
          const resolvedSpaces = await provider.lexiconManager.getSpacesFromScope(fullScope);
          assert.ok(resolvedSpaces.has(OPENSOCIAL_SPACE_TYPE.meta));
          assert.ok(resolvedSpaces.has(OPENSOCIAL_SPACE_TYPE.members));
          if (fullScope === memberScopeStr) {
            assert.ok(resolvedSpaces.has(OPENSOCIAL_SPACE_TYPE.invites));
          }

          const redirectUri = "http://127.0.0.1:43901/callback";
          const clientId = `http://localhost?${new URLSearchParams({ scope: fullScope, redirect_uri: redirectUri }).toString()}`;
          const challenge = createHash("sha256").update(randomBytes(32)).digest("base64url");
          const parDpop = await createGroupDpopClient();
          const parRes = await parDpop.fetchWithDpop(`${actor.pds.url}/oauth/par`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_id: clientId,
              redirect_uri: redirectUri,
              response_type: "code",
              code_challenge: challenge,
              code_challenge_method: "S256",
              scope: fullScope,
              state: `pos-${randomUUID()}`,
            }).toString(),
          });
          assert.equal(parRes.status, 201, `PAR failed for published scopes: ${await parRes.clone().text()}`);
          const { request_uri: requestUri } = (await parRes.json()) as { request_uri: string };
          const authUrl = new URL(`${actor.pds.url}/oauth/authorize`);
          authUrl.searchParams.set("client_id", clientId);
          authUrl.searchParams.set("request_uri", requestUri);

          const cbUrl = await approveAtRealPersonalPds(actor, authUrl);
          assert.ok(new URL(cbUrl).searchParams.get("code"), "Published OpenSocial + Flock scopes succeed at real PDS");
        }

        // Negative check: unpublished space NSID (`space:group.opensocial.unpublished?...`) MUST fail `OAuthProvider.authorize()`!
        {
          const badScope = "atproto space:group.opensocial.unpublished?authority=*&skey=self&action=read";
          const badRedirect = "http://127.0.0.1:43902/callback";
          const badClientId = `http://localhost?${new URLSearchParams({ scope: badScope, redirect_uri: badRedirect }).toString()}`;
          const challenge = createHash("sha256").update(randomBytes(32)).digest("base64url");
          const badDpop = await createGroupDpopClient();
          const badParRes = await badDpop.fetchWithDpop(`${alice.pds.url}/oauth/par`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_id: badClientId,
              redirect_uri: badRedirect,
              response_type: "code",
              code_challenge: challenge,
              code_challenge_method: "S256",
              scope: badScope,
              state: "neg-unpublished",
            }).toString(),
          });
          assert.equal(badParRes.status, 201, `PAR unexpectedly failed before authorize(): ${await badParRes.clone().text()}`);
          const { request_uri: badRequestUri } = (await badParRes.json()) as { request_uri: string };
          await assert.rejects(
            alice.pds.ctx.oauthProvider!.authorize(
              {
                client_id: badClientId,
                request_uri: badRequestUri,
              },
              { deviceId: "dev-neg-check", deviceMetadata: { ipAddress: "127.0.0.1", userAgent: "flock-test" } },
            ),
            (err: unknown) =>
              err instanceof Error &&
              (/Unable to retrieve space declarations|Lexicon|scope|invalid/i.test(err.message) ||
                /group\.opensocial\.unpublished/i.test(String((err as { cause?: unknown }).cause))),
            "Unpublished space NSID must fail OAuthProvider.authorize() getSpacesFromScope()",
          );
        }

        // 1b. Real `NodeOAuthClient` (`authorize()` + `callback()` + refresh + revocation) for Public `"none"` browser metadata
        const adminScopeStr = groupAdminScopes().join(" ");
        const pubRedirectUri = "http://127.0.0.1:43910/oauth/group-callback";
        const pubClientId = `http://localhost?${new URLSearchParams({
          scope: adminScopeStr,
          redirect_uri: pubRedirectUri,
        }).toString()}`;
        const pubSessions = new Map<string, NodeSavedSession>();
        const pubClient = new NodeOAuthClient({
          clientMetadata: oauthClientMetadataSchema.parse({
            client_id: pubClientId,
            client_name: "Flock Browser Group Client",
            redirect_uris: [pubRedirectUri],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            scope: adminScopeStr,
            token_endpoint_auth_method: "none",
            application_type: "native",
            dpop_bound_access_tokens: true,
          }),
          stateStore: makeSimpleStore<NodeSavedState>(),
          sessionStore: makeSimpleStore<NodeSavedSession>(pubSessions),
          plcDirectoryUrl: pds.plcUrl,
          allowHttp: true,
          requestLock: (_name, fn) => fn(),
        });

        // Public `prompt=create` with default `publicMeta` (`true`) via `NodeOAuthClient.authorize()` + `callback()`
        const pubAuthCreateUrl = await pubClient.authorize(pds.groupHostUrl, {
          scope: adminScopeStr,
          prompt: "create",
        });
        const pubCreateCbLocation = await walkGroupHostAuthorizeUrl({
          groupHost: pds.groupHost,
          actor: alice,
          authorizeUrl: pubAuthCreateUrl,
          prompt: "create",
          createParams: {
            displayName: "Public Meta Default Team",
            joinPolicy: "open",
            // Leave `publicMeta` omitted -> defaults to `true`!
          },
        });
        const pubCreateCbUrl = new URL(pubCreateCbLocation);
        assert.equal(pubCreateCbUrl.searchParams.get("iss"), pds.groupHostUrl, "query redirect carries exact iss");
        const { session: pubGroupSession } = await pubClient.callback(pubCreateCbUrl.searchParams);
        const publicGroupDid = pubGroupSession.did;
        assert.ok(publicGroupDid.startsWith("did:plc:"));

        // Verify `publicMeta: true` defaults: `declaration/self`, `labeler/self`, and `publicRead: true` on `meta/self`!
        const pubGroupXrpc = new AtprotoClient((path, init) => pubGroupSession.fetchHandler(path, init));
        const declRes = await pubGroupXrpc.query<{ value: { meta: string } }>("com.atproto.repo.getRecord", {
          repo: publicGroupDid,
          collection: REPO_COLLECTION.groupDeclaration,
          rkey: SELF_SKEY,
        });
        assert.equal(declRes.value.meta, groupMetaUri(publicGroupDid));
        const metaSpaceInfo = await pubGroupXrpc.query<{ policy: { publicRead: boolean } }>("com.atproto.space.getSpace", {
          space: groupMetaUri(publicGroupDid),
        });
        assert.equal(metaSpaceInfo.policy.publicRead, true);
        const labelerRes = await pubGroupXrpc.query<{ value: { $type: string } }>("com.atproto.space.getRecord", {
          space: groupMetaUri(publicGroupDid),
          repo: publicGroupDid,
          collection: OPENSOCIAL_COLLECTION.labeler,
          rkey: SELF_SKEY,
        });
        assert.equal(labelerRes.value.$type, OPENSOCIAL_COLLECTION.labeler);

        // Downstream `/oauth/confirm-action` Deny (`error=access_denied` + `iss`) & Approve on existing group, plus `fragment` `iss`!
        const denyConfirmRes = await completeRealGroupOAuthFlow({
          groupHost: pds.groupHost,
          actor: alice,
          scope: adminScopeStr,
          loginHint: publicGroupDid,
          decision: "deny",
        });
        const denyUrl = new URL(denyConfirmRes.redirectLocation);
        assert.equal(denyUrl.searchParams.get("error"), "access_denied");
        assert.equal(denyUrl.searchParams.get("iss"), pds.groupHostUrl);

        const fragApproveRes = await completeRealGroupOAuthFlow({
          groupHost: pds.groupHost,
          actor: alice,
          scope: adminScopeStr,
          loginHint: publicGroupDid,
          responseMode: "fragment",
          decision: "approve",
        });
        const fragUrl = new URL(fragApproveRes.redirectLocation);
        const fragParams = new URLSearchParams(fragUrl.hash.replace(/^#/, ""));
        assert.equal(fragParams.get("iss"), pds.groupHostUrl, "fragment redirect carries exact iss");
        assert.ok(fragApproveRes.tokenResponse?.access_token);

        // Verify refresh & revocation WITHOUT PKCE fields (and reject extraneous `code_verifier` on refresh!)
        const savedBeforeRefresh = structuredClone(pubSessions.get(publicGroupDid)!);
        const refreshedPubSession = await pubClient.restore(publicGroupDid, true);
        const savedAfterRefresh = pubSessions.get(publicGroupDid)!;
        assert.notEqual(savedAfterRefresh.tokenSet.access_token, savedBeforeRefresh.tokenSet.access_token);
        assert.notEqual(savedAfterRefresh.tokenSet.refresh_token, savedBeforeRefresh.tokenSet.refresh_token);

        // Extraneous PKCE `code_verifier` on `refresh_token` grant is rejected (`400 invalid_request`)
        const pkceOnRefreshRes = await fragApproveRes.dpop.fetchWithDpop(`${pds.groupHostUrl}/oauth/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: fragApproveRes.tokenResponse!.refresh_token!,
            client_id: `http://localhost?${new URLSearchParams({
              scope: adminScopeStr,
              redirect_uri: "http://127.0.0.1:43123/callback",
            }).toString()}`,
            code_verifier: "extraneous-pkce-verifier-should-fail",
          }).toString(),
        });
        assert.equal(pkceOnRefreshRes.status, 400);

        // Revoke via `refreshedPubSession.signOut()` (hits `/oauth/revoke` without PKCE)
        const revokedTok = savedAfterRefresh.tokenSet.access_token;
        await refreshedPubSession.signOut();
        assert.equal(pubSessions.get(publicGroupDid), undefined);
        void revokedTok;

        // 1c. Real `NodeOAuthClient` Confidential `"private_key_jwt"` client metadata + JWKS!
        const confJoseKey = await JoseKey.generate(["ES256"], "conf-op-kid-1");
        const confClientId = "https://conf-operator.example/client-metadata.json";
        const confJwksUri = "https://conf-operator.example/jwks.json";
        const confRedirectUri = "https://conf-operator.example/callback";
        const confMetaDoc = {
          client_id: confClientId,
          client_name: "Confidential Node Operator",
          redirect_uris: [confRedirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          scope: adminScopeStr,
          token_endpoint_auth_method: "private_key_jwt" as const,
          token_endpoint_auth_signing_alg: "ES256" as const,
          jwks_uri: confJwksUri,
          application_type: "web" as const,
          dpop_bound_access_tokens: true,
        };
        const confJwksDoc = { keys: [confJoseKey.publicJwk] };

        const ghConf = await pds.startExtraGroupHost({
          fetchImpl: async (input, init) => {
            const u = input instanceof Request ? input.url : String(input);
            if (u === confClientId) {
              return new Response(JSON.stringify(confMetaDoc), {
                status: 200,
                headers: { "content-type": "application/json" },
              });
            }
            if (u === confJwksUri) {
              return new Response(JSON.stringify(confJwksDoc), {
                status: 200,
                headers: { "content-type": "application/json" },
              });
            }
            return fetch(input, init);
          },
        });

        // Also verify loopback HTTP confidential client served over a real `127.0.0.1` HTTP server!
        const loopConfKey = await jose.generateKeyPair("ES256", { extractable: true });
        const loopConfPub = await jose.exportJWK(loopConfKey.publicKey);
        loopConfPub.kid = "loop-conf-1";
        loopConfPub.alg = "ES256";
        loopConfPub.use = "sig";
        const loopConfApp = express();
        const loopConfSrv = await listenHttp(loopConfApp);
        try {
          loopConfApp.get("/client-metadata.json", (_req, res) => {
            res.json({
              client_id: `${loopConfSrv.url}/client-metadata.json`,
              client_name: "Loopback Confidential Test",
              redirect_uris: [`${loopConfSrv.url}/callback`],
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
              scope: adminScopeStr,
              token_endpoint_auth_method: "private_key_jwt",
              token_endpoint_auth_signing_alg: "ES256",
              jwks_uri: `${loopConfSrv.url}/jwks.json`,
              dpop_bound_access_tokens: true,
            });
          });
          loopConfApp.get("/jwks.json", (_req, res) => {
            res.json({ keys: [loopConfPub] });
          });

          // Explicit `publicMeta: false` via loopback confidential `"private_key_jwt"` client!
          const privGroupFlow = await completeRealGroupOAuthFlow({
            groupHost: pds.groupHost,
            actor: alice,
            scope: adminScopeStr,
            clientId: `${loopConfSrv.url}/client-metadata.json`,
            redirectUri: `${loopConfSrv.url}/callback`,
            clientAssertion: { privateKey: loopConfKey.privateKey, kid: "loop-conf-1" },
            prompt: "create",
            createParams: {
              displayName: "Private Meta Team",
              joinPolicy: "invite",
              publicMeta: false,
            },
          });
          assert.ok(privGroupFlow.tokenResponse);
          const privateGroupDid = privGroupFlow.tokenResponse.sub;
          const privGroupClient = makeGroupClient(
            pds.groupHost,
            privateGroupDid,
            privGroupFlow.dpop,
            privGroupFlow.tokenResponse.access_token,
          );

          // Assert `publicMeta: false` omits `declaration/self` and sets `publicRead: false` on `meta/self`!
          const missingDeclErr = await captureXrpcError(() =>
            privGroupClient.xrpc.query("com.atproto.repo.getRecord", {
              repo: privateGroupDid,
              collection: REPO_COLLECTION.groupDeclaration,
              rkey: SELF_SKEY,
            }),
          );
          assert.equal(missingDeclErr.code, "RecordNotFound");
          const privMetaSpace = await privGroupClient.xrpc.query<{ policy: { publicRead: boolean } }>(
            "com.atproto.space.getSpace",
            { space: groupMetaUri(privateGroupDid) },
          );
          assert.equal(privMetaSpace.policy.publicRead, false);

          // Full `NodeOAuthClient` confidential `private_key_jwt` flow against `ghConf` (`authorize` -> `callback` -> refresh -> `signOut`)
          const confSessions = new Map<string, NodeSavedSession>();
          const confNodeClient = new NodeOAuthClient({
            clientMetadata: oauthClientMetadataSchema.parse(confMetaDoc),
            keyset: [confJoseKey],
            stateStore: makeSimpleStore<NodeSavedState>(),
            sessionStore: makeSimpleStore<NodeSavedSession>(confSessions),
            plcDirectoryUrl: pds.plcUrl,
            allowHttp: true,
            requestLock: (_name, fn) => fn(),
          });
          const confAuthUrl = await confNodeClient.authorize(ghConf.url, {
            scope: adminScopeStr,
            prompt: "create",
          });
          const confCbLoc = await walkGroupHostAuthorizeUrl({
            groupHost: ghConf,
            actor: alice,
            authorizeUrl: confAuthUrl,
            prompt: "create",
            createParams: { displayName: "Conf NodeOAuthClient Team", publicMeta: true },
          });
          const { session: confSession } = await confNodeClient.callback(new URL(confCbLoc).searchParams);
          const confGroupDid = confSession.did;
          const confStatusRes = await confSession.fetchHandler("/xrpc/com.atproto.server.checkAccountStatus", {
            method: "GET",
          });
          assert.equal(confStatusRes.status, 200);
          const confBeforeRefresh = confSessions.get(confGroupDid)!.tokenSet.refresh_token;
          await confNodeClient.restore(confGroupDid, true);
          assert.notEqual(confSessions.get(confGroupDid)!.tokenSet.refresh_token, confBeforeRefresh);
          await confSession.signOut();
          assert.equal(confSessions.get(confGroupDid), undefined);
        } finally {
          await loopConfSrv.close();
          await ghConf.close();
        }

        // 1d. Wrong `redirect_uri` / `client_id` rejection + Parallel & Sequential Code & Refresh Replay Family Cascade
        {
          const dpop = await createGroupDpopClient("wrong-redir-dpop");
          const challenge = createHash("sha256").update(randomBytes(32)).digest("base64url");
          const registeredRedir = "http://127.0.0.1:43920/cb";
          const cid = `http://localhost?${new URLSearchParams({ scope: "atproto", redirect_uri: registeredRedir }).toString()}`;

          // Wrong redirect_uri on PAR -> 400
          const badPar = await dpop.fetchWithDpop(`${pds.groupHostUrl}/oauth/par`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_id: cid,
              redirect_uri: "http://127.0.0.1:43999/wrong",
              response_type: "code",
              code_challenge: challenge,
              code_challenge_method: "S256",
              scope: "atproto",
            }).toString(),
          });
          assert.equal(badPar.status, 400);

          // Wrong client_id on PAR -> 400
          const badClientPar = await dpop.fetchWithDpop(`${pds.groupHostUrl}/oauth/par`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_id: "not-a-valid-client-url",
              redirect_uri: registeredRedir,
              response_type: "code",
              code_challenge: challenge,
              code_challenge_method: "S256",
              scope: "atproto",
            }).toString(),
          });
          assert.equal(badClientPar.status, 400);

          // Obtain a valid authorization code manually to test wrong redirect_uri/client_id on `/oauth/token` AND parallel code replay!
          const verifier = randomBytes(32).toString("base64url");
          const codeChallenge = createHash("sha256").update(verifier).digest("base64url");
          const replayRedir = "http://127.0.0.1:43921/cb";
          const replayCid = `http://localhost?${new URLSearchParams({
            scope: adminScopeStr,
            redirect_uri: replayRedir,
          }).toString()}`;
          const parOk = await dpop.fetchWithDpop(`${pds.groupHostUrl}/oauth/par`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_id: replayCid,
              redirect_uri: replayRedir,
              response_type: "code",
              code_challenge: codeChallenge,
              code_challenge_method: "S256",
              scope: adminScopeStr,
              login_hint: publicGroupDid,
              state: "st-replay",
            }).toString(),
          });
          assert.equal(parOk.status, 201);
          const { request_uri: reqUri } = (await parOk.json()) as { request_uri: string };
          const codeRedirLoc = await walkGroupHostAuthorizeUrl({
            groupHost: pds.groupHost,
            actor: alice,
            authorizeUrl: new URL(
              `${pds.groupHostUrl}/oauth/authorize?client_id=${encodeURIComponent(replayCid)}&request_uri=${encodeURIComponent(reqUri)}&actor=${encodeURIComponent(alice.did)}`,
            ),
          });
          const issuedCode = new URL(codeRedirLoc).searchParams.get("code")!;
          assert.ok(issuedCode);

          // Wrong redirect_uri at `/oauth/token` -> 400 (does not mint tokens)
          const wrongRedirTok = await dpop.fetchWithDpop(`${pds.groupHostUrl}/oauth/token`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code: issuedCode,
              redirect_uri: "http://127.0.0.1:43921/wrong",
              client_id: replayCid,
              code_verifier: verifier,
            }).toString(),
          });
          assert.equal(wrongRedirTok.status, 400);

          // Obtain fresh code and race 2 PARALLEL `/oauth/token` exchanges -> at most 1 succeeds and the replay revokes the family!
          const parRace = await dpop.fetchWithDpop(`${pds.groupHostUrl}/oauth/par`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_id: replayCid,
              redirect_uri: replayRedir,
              response_type: "code",
              code_challenge: codeChallenge,
              code_challenge_method: "S256",
              scope: adminScopeStr,
              login_hint: publicGroupDid,
              state: "st-parallel-code",
            }).toString(),
          });
          const { request_uri: raceReqUri } = (await parRace.json()) as { request_uri: string };
          const raceCodeLoc = await walkGroupHostAuthorizeUrl({
            groupHost: pds.groupHost,
            actor: alice,
            authorizeUrl: new URL(
              `${pds.groupHostUrl}/oauth/authorize?client_id=${encodeURIComponent(replayCid)}&request_uri=${encodeURIComponent(raceReqUri)}&actor=${encodeURIComponent(alice.did)}`,
            ),
          });
          const raceCode = new URL(raceCodeLoc).searchParams.get("code")!;

          const exchangeBody = new URLSearchParams({
            grant_type: "authorization_code",
            code: raceCode,
            redirect_uri: replayRedir,
            client_id: replayCid,
            code_verifier: verifier,
          }).toString();
          const [exA, exB] = await Promise.all([
            dpop.fetchWithDpop(`${pds.groupHostUrl}/oauth/token`, {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: exchangeBody,
            }),
            dpop.fetchWithDpop(`${pds.groupHostUrl}/oauth/token`, {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: exchangeBody,
            }),
          ]);
          const statuses = [exA.status, exB.status].sort((x, y) => x - y);
          assert.deepEqual(statuses, [200, 400], "Parallel authorization_code exchange must succeed once and reject replay");
          const winner = exA.status === 200 ? exA : exB;
          const winnerBody = (await winner.json()) as { access_token: string };
          const afterCodeCascade = await dpop.fetchWithDpop(`${pds.groupHostUrl}/xrpc/com.atproto.server.checkAccountStatus`, {
            method: "GET",
            accessToken: winnerBody.access_token,
          });
          assert.equal(afterCodeCascade.status, 401, "Code replay must cascade to revoke the issued session family");

          // Parallel & sequential `refresh_token` replay family cascade!
          const refreshFlow = await completeRealGroupOAuthFlow({
            groupHost: pds.groupHost,
            actor: alice,
            scope: adminScopeStr,
            clientId: replayCid,
            redirectUri: replayRedir,
            loginHint: publicGroupDid,
          });
          const r1 = refreshFlow.tokenResponse!.refresh_token!;
          const refreshReqBody = new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: r1,
            client_id: replayCid,
          }).toString();
          const [refA, refB] = await Promise.all([
            refreshFlow.dpop.fetchWithDpop(`${pds.groupHostUrl}/oauth/token`, {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: refreshReqBody,
            }),
            refreshFlow.dpop.fetchWithDpop(`${pds.groupHostUrl}/oauth/token`, {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: refreshReqBody,
            }),
          ]);
          assert.deepEqual([refA.status, refB.status].sort((x, y) => x - y), [200, 400]);
          const refWinner = (await (refA.status === 200 ? refA : refB).json()) as {
            access_token: string;
            refresh_token: string;
          };

          // Ensure sequential replay also cascades if parallel loser ran before winner committed or after:
          await refreshFlow.dpop.fetchWithDpop(`${pds.groupHostUrl}/oauth/token`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: refreshReqBody,
          });
          const cascadedAccessCheck = await refreshFlow.dpop.fetchWithDpop(
            `${pds.groupHostUrl}/xrpc/com.atproto.server.checkAccountStatus`,
            {
              method: "GET",
              accessToken: refWinner.access_token,
            },
          );
          assert.equal(cascadedAccessCheck.status, 401, "Refresh replay cascades to revoke active access_token");
        }

        // 1e. `prompt=create` failpoints:
        //     (i) Pre-genesis / stale uncommitted `plc_published` compensation (`compensateStaleCreationJournals`),
        //     (ii) Concurrent resumers (`Promise.all` for same `creation_key` & simultaneous callbacks for same personal DID),
        //     (iii) `5 min` `oauth_code`-expiry failpoint recovering via existing-group reauthorization,
        //     (iv) Lost-`/oauth/token`-response recovery via existing-group reauthorization!
        {
          // (i) Seed an uncommitted `plc_published` journal row (simulating crash right after PLC genesis before SQLite local commit)
          //     and verify `compensateStaleCreationJournals()` tombstones the uncommitted DID on PLC and frees the handle!
          const staleSign = await P256Keypair.create({ exportable: true });
          const staleKem = await P256Keypair.create({ exportable: true });
          const staleRot = await P256Keypair.create({ exportable: true });
          const staleHandle = `stale-${randomBytes(3).toString("hex")}.groups.localhost`;
          const baseGen = formatAtprotoOp({
            signingKey: staleSign.did(),
            handle: staleHandle,
            pds: pds.groupHostUrl,
            rotationKeys: [staleRot.did()],
            prev: null,
          });
          const signedGen = await signOperation(
            { ...baseGen, verificationMethods: { ...baseGen.verificationMethods, atproto_kem: staleKem.did() } },
            staleRot,
          );
          const staleDid = await didForCreateOp(signedGen);
          const plcCreateRes = await fetch(`${pds.network.plc.url}/${encodeURIComponent(staleDid)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(signedGen),
          });
          assert.equal(plcCreateRes.status, 200);

          const staleKey = `ck-stale-${randomUUID()}`;
          const staleRowKey = `${alice.did}:${pubClientId}:${staleKey}`;
          const sigEnc = await pds.groupHost.cryptoBox.encryptKeypair("group_creation_journal", staleRowKey, "signing_key_enc", staleSign);
          const kemEnc = await pds.groupHost.cryptoBox.encryptKeypair("group_creation_journal", staleRowKey, "kem_key_enc", staleKem);
          const rotEnc = await pds.groupHost.cryptoBox.encryptKeypair("group_creation_journal", staleRowKey, "rotation_key_enc", staleRot);
          const oldMs = Date.now() - 20 * 60_000;
          pds.groupHost.db
            .prepare(
              `INSERT INTO group_creation_journal (
                 initiator_did, client_id, creation_key, group_did, handle, display_name, join_policy, public_meta,
                 signing_key_enc, kem_key_enc, rotation_key_enc, genesis_op_json, status, auth_code, redirect_url,
                 code_expires_at, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, 'Stale Genesis', 'invite', 1, ?, ?, ?, ?, 'plc_published', NULL, NULL, NULL, ?, ?)`,
            )
            .run(
              alice.did,
              pubClientId,
              staleKey,
              staleDid,
              staleHandle,
              sigEnc,
              kemEnc,
              rotEnc,
              JSON.stringify(signedGen),
              oldMs,
              oldMs,
            );
          pds.groupHost.db
            .prepare("INSERT INTO handle_reservation (handle, group_did, created_at) VALUES (?, ?, ?)")
            .run(staleHandle, staleDid, oldMs);

          await pds.groupHost.oauth.compensateStaleCreationJournals();
          const compRow = pds.groupHost.db
            .prepare("SELECT status FROM group_creation_journal WHERE creation_key = ?")
            .get(staleKey) as { status: string };
          assert.equal(compRow.status, "compensated");
          const plcAfterComp = await fetch(`${pds.network.plc.url}/${encodeURIComponent(staleDid)}`);
          assert.equal(plcAfterComp.status, 404, "Compensated pre-commit genesis DID must be tombstoned on PLC");

          // Verify released `staleHandle` can now be claimed via crash-resumed `pending_plc` journal + simultaneous callbacks for same personal DID + concurrent resumers!
          const resumeSign = await P256Keypair.create({ exportable: true });
          const resumeKem = await P256Keypair.create({ exportable: true });
          const resumeRot = await P256Keypair.create({ exportable: true });
          const resumeBaseGen = formatAtprotoOp({
            signingKey: resumeSign.did(),
            handle: staleHandle,
            pds: `http://localhost:${pds.groupHost.port}`,
            rotationKeys: [resumeRot.did()],
            prev: null,
          });
          const resumeSignedGen = await signOperation(
            { ...resumeBaseGen, verificationMethods: { ...resumeBaseGen.verificationMethods, atproto_kem: resumeKem.did() } },
            resumeRot,
          );
          const expectedResumedDid = await didForCreateOp(resumeSignedGen);
          const pendingPlcKey = `ck-pendplc-${randomUUID()}`;
          const defaultFlowRedir = "http://127.0.0.1:43123/callback";
          const defaultFlowCid = `http://localhost?${new URLSearchParams({
            scope: adminScopeStr,
            redirect_uri: defaultFlowRedir,
          }).toString()}`;
          const pendRowKey = `${alice.did}:${defaultFlowCid}:${pendingPlcKey}`;
          const nowResumeMs = Date.now();
          pds.groupHost.db
            .prepare("INSERT INTO handle_reservation (handle, group_did, created_at) VALUES (?, ?, ?)")
            .run(staleHandle, expectedResumedDid, nowResumeMs);
          pds.groupHost.db
            .prepare(
              `INSERT INTO group_creation_journal (
                 initiator_did, client_id, creation_key, group_did, handle, display_name, join_policy, public_meta,
                 signing_key_enc, kem_key_enc, rotation_key_enc, genesis_op_json, status, auth_code, redirect_url,
                 code_expires_at, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, 'Pending PLC Resume Team', 'invite', 1, ?, ?, ?, ?, 'pending_plc', NULL, NULL, NULL, ?, ?)`,
            )
            .run(
              alice.did,
              defaultFlowCid,
              pendingPlcKey,
              expectedResumedDid,
              staleHandle,
              await pds.groupHost.cryptoBox.encryptKeypair("group_creation_journal", pendRowKey, "signing_key_enc", resumeSign),
              await pds.groupHost.cryptoBox.encryptKeypair("group_creation_journal", pendRowKey, "kem_key_enc", resumeKem),
              await pds.groupHost.cryptoBox.encryptKeypair("group_creation_journal", pendRowKey, "rotation_key_enc", resumeRot),
              JSON.stringify(resumeSignedGen),
              nowResumeMs,
              nowResumeMs,
            );

          // Simultaneous callbacks for the SAME personal DID (`alice`) across `pendingPlcKey` resume AND a parallel distinct group!
          const [resumedPendingPlc, otherGroupSameUser] = await Promise.all([
            completeRealGroupOAuthFlow({
              groupHost: pds.groupHost,
              actor: alice,
              scope: adminScopeStr,
              prompt: "create",
              createParams: {
                displayName: "Pending PLC Resume Team",
                handle: staleHandle,
                creationKey: pendingPlcKey,
              },
            }),
            completeRealGroupOAuthFlow({
              groupHost: pds.groupHost,
              actor: alice,
              scope: adminScopeStr,
              prompt: "create",
              createParams: {
                displayName: "Parallel Distinct Group",
              },
            }),
          ]);
          assert.ok(resumedPendingPlc.tokenResponse && otherGroupSameUser.tokenResponse);
          assert.equal(resumedPendingPlc.tokenResponse.sub, expectedResumedDid, "pending_plc journal resumes to exact pre-journaled groupDid");
          assert.notEqual(resumedPendingPlc.tokenResponse.sub, otherGroupSameUser.tokenResponse.sub);

          // Concurrent resumers racing `Promise.allSettled` on the SAME `creation_key` -> zero duplicate groups created!
          const sharedRaceHandle = `race-${randomBytes(3).toString("hex")}.groups.localhost`;
          const sharedCreationKey = `ck-concurrent-${randomUUID()}`;
          const settledResumers = await Promise.allSettled([
            completeRealGroupOAuthFlow({
              groupHost: pds.groupHost,
              actor: alice,
              scope: adminScopeStr,
              prompt: "create",
              createParams: {
                displayName: "Concurrent Resumer Team",
                handle: sharedRaceHandle,
                creationKey: sharedCreationKey,
              },
            }),
            completeRealGroupOAuthFlow({
              groupHost: pds.groupHost,
              actor: alice,
              scope: adminScopeStr,
              prompt: "create",
              createParams: {
                displayName: "Concurrent Resumer Team",
                handle: sharedRaceHandle,
                creationKey: sharedCreationKey,
              },
            }),
          ]);
          const fulfilledResumers = settledResumers.filter(
            (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof completeRealGroupOAuthFlow>>> => r.status === "fulfilled",
          );
          assert.equal(fulfilledResumers.length, 2, "Both concurrent resumers must succeed cleanly");
          const uniqueRaceDids = new Set(fulfilledResumers.map((r) => r.value.tokenResponse!.sub));
          assert.equal(uniqueRaceDids.size, 1, "Concurrent resumers must never mint distinct group DIDs");
          const raceAcctCount = pds.groupHost.db
            .prepare("SELECT COUNT(*) AS cnt FROM group_account WHERE handle = ?")
            .get(sharedRaceHandle) as { cnt: number };
          assert.equal(raceAcctCount.cnt, 1, "Zero duplicate group_account rows created under concurrent resumers");

          // (iii) `5 min` `oauth_code`-expiry failpoint:
          // Issue `oauth_code` on `prompt=create` without exchanging it, age `expires_at` & `code_expires_at` > 5 min,
          // then retry `prompt=create` with the same `creationKey` -> recovers via existing-group reauthorization!
          const expCreationKey = `ck-code-exp-${randomUUID()}`;
          const dpopExp = await createGroupDpopClient("exp-code-dpop");
          const expVerifier = randomBytes(32).toString("base64url");
          const expChallenge = createHash("sha256").update(expVerifier).digest("base64url");
          const expRedir = "http://127.0.0.1:43925/cb";
          const expCid = `http://localhost?${new URLSearchParams({ scope: adminScopeStr, redirect_uri: expRedir }).toString()}`;
          const expPar = await dpopExp.fetchWithDpop(`${pds.groupHostUrl}/oauth/par`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_id: expCid,
              redirect_uri: expRedir,
              response_type: "code",
              code_challenge: expChallenge,
              code_challenge_method: "S256",
              scope: adminScopeStr,
              prompt: "create",
              creation_key: expCreationKey,
              state: "st-exp-1",
            }).toString(),
          });
          const { request_uri: expReqUri } = (await expPar.json()) as { request_uri: string };
          await walkGroupHostAuthorizeUrl({
            groupHost: pds.groupHost,
            actor: alice,
            authorizeUrl: new URL(
              `${pds.groupHostUrl}/oauth/authorize?client_id=${encodeURIComponent(expCid)}&request_uri=${encodeURIComponent(expReqUri)}`,
            ),
            prompt: "create",
            createParams: { displayName: "Five Min Expiry Group", creationKey: expCreationKey },
          });
          const journalBeforeExp = pds.groupHost.db
            .prepare("SELECT group_did, status FROM group_creation_journal WHERE creation_key = ?")
            .get(expCreationKey) as { group_did: string; status: string };
          assert.equal(journalBeforeExp.status, "code_issued");

          // Age `oauth_code` and `code_expires_at` past 5 minutes!
          const expiredMs = Date.now() - 6 * 60_000;
          pds.groupHost.db
            .prepare("UPDATE oauth_code SET expires_at = ? WHERE group_did = ?")
            .run(expiredMs, journalBeforeExp.group_did);
          pds.groupHost.db
            .prepare("UPDATE group_creation_journal SET code_expires_at = ? WHERE creation_key = ?")
            .run(expiredMs, expCreationKey);

          const recoveredAfterCodeExp = await completeRealGroupOAuthFlow({
            groupHost: pds.groupHost,
            actor: alice,
            scope: adminScopeStr,
            clientId: expCid,
            redirectUri: expRedir,
            prompt: "create",
            createParams: { displayName: "Five Min Expiry Group", creationKey: expCreationKey },
          });
          assert.equal(
            recoveredAfterCodeExp.tokenResponse?.sub,
            journalBeforeExp.group_did,
            "5-min expired oauth_code retry must pivot to existing-group reauthorization for the same groupDid",
          );

          // (iv) Lost-`/oauth/token`-response failpoint: code ALREADY exchanged (`status = 'completed'`), client lost response ->
          // retrying with the same `creationKey` pivots to `/oauth/confirm-action` existing-group reauthorization for the same `groupDid`!
          const recoveredAfterLostToken = await completeRealGroupOAuthFlow({
            groupHost: pds.groupHost,
            actor: alice,
            scope: adminScopeStr,
            clientId: expCid,
            redirectUri: expRedir,
            prompt: "create",
            createParams: { displayName: "Five Min Expiry Group", creationKey: expCreationKey },
          });
          assert.equal(recoveredAfterLostToken.tokenResponse?.sub, journalBeforeExp.group_did);
        }

        // 1f. Per-user `moderator` session + `assignable` anti-escalation
        {
          const ws = await createFullFlockWorkspace(pds, alice, { name: "Moderation RBAC Team", joinPolicy: "open" });
          await ws.groupClient.putMembership(bob.did, ["member", "moderator"]);
          await acceptGroupMembership(pds, bob, ws.groupDid);

          const modFlow = await completeRealGroupOAuthFlow({
            groupHost: pds.groupHost,
            actor: bob,
            scope: groupModeratorScopes(ws.groupDid).join(" "),
            loginHint: ws.groupDid,
          });
          const bobModClient = makeGroupClient(
            pds.groupHost,
            ws.groupDid,
            modFlow.dpop,
            modFlow.tokenResponse!.access_token,
          );

          // Moderator CAN read moderation subjects and publish labels
          const modSubs = await bobModClient.listModSubjects();
          assert.deepEqual(modSubs.subjects, []);
          await bobModClient.publishLabel({ uri: dan.did, val: "!hide" });

          // Moderator CANNOT assign `admin` (`403 RoleNotAssignable` / `Forbidden`)
          const assignAdminErr = await captureXrpcError(() => bobModClient.putMembership(dan.did, ["member", "admin"]));
          assert.equal(assignAdminErr.status, 403);

          // Moderator CANNOT create a role granting `admin` scopes or `assignable: ["admin"]` (`403`)
          const escalateRoleErr = await captureXrpcError(() =>
            bobModClient.putRole("rogue-admin", {
              displayName: "Rogue Admin",
              scopes: groupAdminScopes(ws.groupDid).filter((s) => s !== "atproto"),
              assignable: ["admin"],
            }),
          );
          assert.equal(escalateRoleErr.status, 403);

          // Moderator CANNOT escalate space policy grants (`403`)
          const escalatePolicyErr = await captureXrpcError(() =>
            bobModClient.xrpc.procedure("com.atproto.space.updateSpace", {
              space: ws.workspace,
              policy: {
                $type: OPENSOCIAL_POLICY,
                publicRead: true,
                unlisted: false,
                grants: [{ role: "moderator", read: true, write: true }],
              },
            }),
          );
          assert.equal(escalatePolicyErr.status, 403);

          // Delegated sub-manager holding `manage=update` + `role` CRUD + `assignable: ["helper"]` (and NO `read`/`write` on private channel `secret-room`)
          // CANNOT: (i) grant `read`/`write` on `secret-room` to `helper` or themselves, (ii) edit/delete unassignable `moderator`, or (iii) convert probe scopes to wildcards!
          await ws.groupClient.putRole("helper", { displayName: "Helper" });
          await ws.groupClient.putRole("secret-member", { displayName: "Secret Member" });
          const secretSpace = channelUri(ws.groupDid, "secret-room");
          await ws.groupClient.xrpc.procedure("com.atproto.space.createSpace", {
            spaceType: SPACE_TYPE.channel,
            skey: "secret-room",
            policy: {
              $type: OPENSOCIAL_POLICY,
              publicRead: false,
              unlisted: true,
              grants: [{ role: "secret-member", read: true, write: true }],
            },
          });
          const subMgrScopes = [
            "space:new.flock.channel?manage=update",
            "space:group.opensocial.members?skey=self&collection=group.opensocial.role&action=read&action=create&action=update&action=delete",
            "blob?accept=image%2Fpng&accept=application%2Foctet-stream",
            "repo:com.atproto.probe.wildcard?action=create&action=update&action=delete",
          ];
          await ws.groupClient.putRole("sub-manager", {
            displayName: "Sub Manager",
            scopes: subMgrScopes,
            assignable: ["helper"],
          });
          await ws.groupClient.putMembership(carol.did, ["member", "sub-manager"]);
          await acceptGroupMembership(pds, carol, ws.groupDid);

          const subMgrFlow = await completeRealGroupOAuthFlow({
            groupHost: pds.groupHost,
            actor: carol,
            scope: ["atproto", ...subMgrScopes].join(" "),
            loginHint: ws.groupDid,
          });
          const carolSubMgr = makeGroupClient(
            pds.groupHost,
            ws.groupDid,
            subMgrFlow.dpop,
            subMgrFlow.tokenResponse!.access_token,
          );

          // (i) Sub-manager has `manage=update` on `new.flock.channel`, yet CANNOT self-grant `read`/`write` or grant `read` she lacks on `secret-room`!
          const selfGrantPrivErr = await captureXrpcError(() =>
            carolSubMgr.xrpc.procedure("com.atproto.space.updateSpace", {
              space: secretSpace,
              policy: {
                $type: OPENSOCIAL_POLICY,
                publicRead: false,
                unlisted: true,
                grants: [
                  { role: "secret-member", read: true, write: true },
                  { role: "sub-manager", read: true, write: true },
                ],
              },
            }),
          );
          assert.equal(selfGrantPrivErr.status, 403);
          assert.equal(selfGrantPrivErr.code, "PrivilegeEscalation");

          const helperReadPrivErr = await captureXrpcError(() =>
            carolSubMgr.xrpc.procedure("com.atproto.space.updateSpace", {
              space: secretSpace,
              policy: {
                $type: OPENSOCIAL_POLICY,
                publicRead: false,
                unlisted: true,
                grants: [
                  { role: "secret-member", read: true, write: true },
                  { role: "helper", read: true },
                ],
              },
            }),
          );
          assert.equal(helperReadPrivErr.status, 403);
          assert.equal(helperReadPrivErr.code, "PrivilegeEscalation");

          // (ii) Sub-manager CANNOT overwrite or delete unassignable `secret-member` / new role outside `assignable`, nor self-bootstrap `assignable: ["x"]`!
          const editUnassignableRoleErr = await captureXrpcError(() =>
            carolSubMgr.putRole("secret-member", { displayName: "Hijacked" }),
          );
          assert.equal(editUnassignableRoleErr.status, 403);
          assert.equal(editUnassignableRoleErr.code, "PrivilegeEscalation");

          await ws.groupClient.putRole("unused-unassignable", { displayName: "Unused" });
          const deleteUnassignableRoleErr = await captureXrpcError(() =>
            carolSubMgr.deleteRole("unused-unassignable"),
          );
          assert.equal(deleteUnassignableRoleErr.status, 403);
          assert.equal(deleteUnassignableRoleErr.code, "PrivilegeEscalation");

          // (iii) Sub-manager CANNOT escalate two specific blob MIMEs into `blob:*/*` or one collection into `repo:*`!
          const wildcardBlobEscErr = await captureXrpcError(() =>
            carolSubMgr.putRole("helper", {
              displayName: "Helper",
              scopes: ["blob:*/*"],
            }),
          );
          assert.equal(wildcardBlobEscErr.status, 403);
          assert.equal(wildcardBlobEscErr.code, "PrivilegeEscalation");

          const wildcardRepoEscErr = await captureXrpcError(() =>
            carolSubMgr.putRole("helper", {
              displayName: "Helper",
              scopes: ["repo:*?action=create"],
            }),
          );
          assert.equal(wildcardRepoEscErr.status, 403);
          assert.equal(wildcardRepoEscErr.code, "PrivilegeEscalation");
        }

        // 1g. Shared-session & `originalActor` demotion after durable steps:
        //     - Shared-session demotion -> `AuthorityReauthorizationRequiredError` -> alternate-admin reauthorization
        //     - `0`-step pending operation -> `aborted_actor_revoked` (`operationAbortedActorRevoked`)
        //     - `>= 1`-step (`1, 2, 3`) pending operation -> refuses under-privileged sub-admin (`403`), then completes via
        //       audited `operationAdminTakeover` under alternate full admin!
        {
          const ws = await createFullFlockWorkspace(pds, alice, { name: "Governance Takeover Team" });
          await ws.groupClient.putMembership(carol.did, ["member", "admin"]);
          await ws.groupClient.putMembership(dan.did, ["member"]);
          await acceptGroupMembership(pds, carol, ws.groupDid);
          await acceptGroupMembership(pds, dan, ws.groupDid);

          const carolGrantFlow = await completeRealGroupOAuthFlow({
            groupHost: pds.groupHost,
            actor: carol,
            scope: adminScopeStr,
            loginHint: ws.groupDid,
          });
          const carolGroupClient = makeGroupClient(
            pds.groupHost,
            ws.groupDid,
            carolGrantFlow.dpop,
            carolGrantFlow.tokenResponse!.access_token,
          );

          // Demote Alice (who authorized Operator's current `authority_grant`) -> Operator shared session narrows (`authorizationRequired: true` / HTTP 403) -> Carol reauthorizes!
          await carolGroupClient.putMembership(alice.did, ["member"]);
          const parsedWs = parseWorkspaceRef(ws.workspace);
          const brokenGrant = await restoreAuthorityGrant(ws.groupDid);
          const demotedOpView = await executeOperatorOperation(
            { did: carol.did, session: brokenGrant, workspace: parsedWs, canRecoverOperations: true },
            tidNow(),
            { kind: "createChannel", skey: "after-alice-demoted", name: "after-alice-demoted", visibility: "public" },
          );
          assert.equal(demotedOpView.state, "pending");
          assert.equal(
            demotedOpView.authorizationRequired,
            true,
            "Demoting the admin who authorized Operator's shared session must trigger authorizationRequired",
          );
          const carolEngineBeforeReauth = createEngine(clientTransport(pds, carol), { operator: operatorService });
          await assert.rejects(
            carolEngineBeforeReauth.operator!.execute({
              workspace: ws.workspace,
              operationId: tidNow(),
              request: { kind: "createChannel", skey: "http-refused", name: "http-refused", visibility: "public" },
            }),
            /403|AuthorityApprovalRequired|permission/i,
          );

          // Carol reauthorizes Operator's shared session via her own personal PDS -> operations succeed!
          await storeGroupAuthorityGrant(pds, carol, ws.groupDid, "carol-reauth-op");
          const carolSharedSession = await restoreAuthorityGrant(ws.groupDid);
          const carolOpActor: OperatorActor = {
            did: carol.did,
            session: carolSharedSession,
            workspace: parsedWs,
            canRecoverOperations: true,
          };
          const okAfterReauth = await executeOperatorOperation(carolOpActor, tidNow(), {
            kind: "createChannel",
            skey: "reauthed-chan",
            name: "reauthed-chan",
            visibility: "public",
          });
          assert.equal(okAfterReauth.state, "completed");

          // Restore Alice to `admin` so we can test `originalActor` demotion at `0` steps and after durable steps `1, 2, 3`!
          await carolGroupClient.putMembership(alice.did, ["member", "admin"]);

          // Provision a limited sub-admin (`bob` with `recruiter` role: can edit membership for `member`, cannot create private channels)
          await carolGroupClient.putRole("recruiter", {
            displayName: "Recruiter",
            scopes: [
              `space:${OPENSOCIAL_SPACE_TYPE.members}?skey=self&collection=${OPENSOCIAL_COLLECTION.membership}&action=read&action=create&action=update`,
            ],
            assignable: ["member"],
          });
          await carolGroupClient.putMembership(bob.did, ["member", "recruiter"]);

          // Branch A: `0`-step pending operation by Alice -> demote Alice -> Carol recovers -> `aborted_actor_revoked`!
          const zeroOpId = tidNow();
          const zeroReq = { kind: "createChannel", skey: "zero-abort", name: "zero-abort", visibility: "public" };
          const zeroHash = requestDigest({ workspace: ws.workspace, request: zeroReq });
          const nowSec = Math.floor(Date.now() / 1000) - 30;
          getRawDb()
            .prepare(
              `INSERT INTO operation (workspace, workspace_uri, actor, operation_id, request_hash, request_json, state, steps_json, error, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, 'pending', '[]', 'transient pre-step error', ?, ?)`,
            )
            .run(
              ws.groupDid,
              ws.workspace,
              alice.did,
              zeroOpId,
              zeroHash,
              JSON.stringify({ workspace: ws.workspace, request: zeroReq }),
              nowSec,
              nowSec,
            );
          getRawDb()
            .prepare("INSERT OR IGNORE INTO operation_workspace_catalog (workspace, workspace_uri) VALUES (?, ?)")
            .run(ws.groupDid, ws.workspace);

          await carolGroupClient.putMembership(alice.did, ["member"]);
          const recZero = await executeOperatorOperation(carolOpActor, tidNow(), { kind: "reconcileWorkspace" });
          assert.equal(recZero.state, "completed");
          const zeroRow = getRawDb()
            .prepare("SELECT actor, state, taken_over_by FROM operation WHERE operation_id = ?")
            .get(zeroOpId) as { actor: string; state: string; taken_over_by: string | null };
          assert.deepEqual(zeroRow, { actor: alice.did, state: "aborted_actor_revoked", taken_over_by: null });
          const zeroAudits = getRawDb()
            .prepare("SELECT actor, event FROM audit_event WHERE operation_id = ?")
            .all(zeroOpId) as Array<{ actor: string; event: string }>;
          assert.ok(zeroAudits.some((e) => e.actor === carol.did && e.event === "operationAbortedActorRevoked"));

          // Branch B: `>= 1`-step (`1, 2, 3`) durable-step interruption + `originalActor` demotion -> under-privileged `403` -> Carol `operationAdminTakeover`!
          for (const stopStep of [1, 2, 3] as const) {
            await carolGroupClient.putMembership(alice.did, ["member", "admin"]);
            const chanSkey = `priv-takeover-${stopStep}`;
            let interceptActive = true;
            let dirCommitted = false;

            const flakySession = {
              did: carolSharedSession.did,
              fetchHandler: async (path: string, init?: RequestInit) => {
                if (interceptActive && init?.body && typeof init.body === "string") {
                  const parsedBody = JSON.parse(init.body) as { collection?: string; rkey?: string };
                  if (stopStep === 1 && path.includes("com.atproto.space.putRecord") && parsedBody.collection === OPENSOCIAL_COLLECTION.membership) {
                    return Response.json({ error: "InternalServerError", message: "injected step-1 stop" }, { status: 500 });
                  }
                  if (stopStep === 2 && path.includes("com.atproto.space.putRecord") && parsedBody.collection === COLLECTION.directory) {
                    return Response.json({ error: "InternalServerError", message: "injected step-2 stop" }, { status: 500 });
                  }
                  if (path.includes("com.atproto.space.putRecord") && parsedBody.collection === COLLECTION.directory && parsedBody.rkey === chanSkey) {
                    dirCommitted = true;
                  }
                }
                if (
                  interceptActive &&
                  stopStep === 3 &&
                  dirCommitted &&
                  path.includes("com.atproto.space.getSpace") &&
                  decodeURIComponent(path).endsWith(`/${chanSkey}`)
                ) {
                  return Response.json({ error: "InternalServerError", message: "injected step-3 stop" }, { status: 500 });
                }
                return carolSharedSession.fetchHandler(path, init);
              },
            };

            const aliceActor: OperatorActor = {
              did: alice.did,
              session: flakySession as never,
              workspace: parsedWs,
              canRecoverOperations: true,
            };
            const opId = tidNow();
            const paused = await executeOperatorOperation(aliceActor, opId, {
              kind: "createChannel",
              skey: chanSkey,
              name: chanSkey,
              visibility: "private",
              members: [dan.did],
            });
            interceptActive = false;
            assert.equal(paused.state, "pending");
            assert.equal(paused.completedSteps.length, stopStep);

            // Demote Alice after `stopStep` durable steps!
            await carolGroupClient.putMembership(alice.did, ["member"]);

            // Under-privileged `recruiter` (`bob`) attempting an operation fails takeover with `OperatorAuthError`!
            const newRecruit = await nextActor(`cand${stopStep}`, 1);
            const bobRecruiterActor = await authorizeOperationActor(carolSharedSession, parsedWs, bob.did, {
              kind: "inviteMember",
              subject: newRecruit.did,
            });
            await assert.rejects(
              executeOperatorOperation(bobRecruiterActor, tidNow(), {
                kind: "inviteMember",
                subject: newRecruit.did,
              }),
              (err: unknown) => err instanceof OperatorAuthError,
            );

            // Full admin Carol recovers `(workspace, alice.did, opId)` via audited `operationAdminTakeover`!
            const resumed = await executeOperatorOperation(carolOpActor, tidNow(), { kind: "reconcileWorkspace" });
            assert.equal(resumed.state, "completed");

            const rowAfter = getRawDb()
              .prepare("SELECT actor, state, taken_over_by, steps_json FROM operation WHERE operation_id = ?")
              .get(opId) as { actor: string; state: string; taken_over_by: string | null; steps_json: string };
            assert.equal(rowAfter.actor, alice.did, "operation.actor remains immutable originalActor");
            assert.equal(rowAfter.state, "completed");
            assert.equal(rowAfter.taken_over_by, carol.did, "taken_over_by records recovering admin");
            assert.equal(JSON.parse(rowAfter.steps_json).length, 4);

            const audits = getRawDb()
              .prepare("SELECT actor, event, details_json FROM audit_event WHERE operation_id = ? ORDER BY id ASC")
              .all(opId) as Array<{ actor: string; event: string; details_json: string }>;
            const takeoverIdx = audits.findIndex((a) => a.event === "operationAdminTakeover");
            assert.ok(takeoverIdx >= 0);
            assert.deepEqual(JSON.parse(audits[takeoverIdx]!.details_json), {
              completedStepsBeforeTakeover: stopStep,
              originalActor: alice.did,
            });
            for (const pre of audits.slice(0, takeoverIdx)) assert.equal(pre.actor, alice.did);
            for (const post of audits.slice(takeoverIdx)) assert.equal(post.actor, carol.did);
            assert.equal(audits.at(-1)?.event, "operationCompleted");
          }
        }
      },
    );

    // =========================================================================
    // 2. Space Auto-Indexing, Role/Membership Integrity & Full Bot Lifecycle
    // =========================================================================
    await t.test(
      "2. Space auto-indexing, role/membership/app/self integrity invariants, and full bot install/update/uninstall/migration lifecycle",
      async () => {
        const alice = await nextActor("idxalice", 0);
        const humanMember = await nextActor("idxhuman", 1);
        const botActor = await nextActor("idxbot", 1);

        const ws = await createFullFlockWorkspace(pds, alice, { name: "Integrity & Bot Workspace", joinPolicy: "open" });
        await ws.groupClient.putMembership(humanMember.did, ["member"]);
        await acceptGroupMembership(pds, humanMember, ws.groupDid);

        // 2a. `group.opensocial.space` auto-indexing on `createSpace` / `updateSpace(unlisted)` / `deleteSpace` + `IndexHostMaintained`
        const tempSpaceSkey = "indexed-modality";
        const tempSpaceUri = channelUri(ws.groupDid, tempSpaceSkey);
        await ws.groupClient.xrpc.procedure("com.atproto.space.createSpace", {
          spaceType: SPACE_TYPE.channel,
          skey: tempSpaceSkey,
          policy: {
            $type: OPENSOCIAL_POLICY,
            publicRead: false,
            unlisted: false,
            grants: [
              { role: "admin", read: true, write: true },
              { role: "member", read: true, write: true },
            ],
          },
        });

        const listIndexedSpaces = async () => {
          const res = await ws.groupClient.xrpc.query<{ records: Array<{ rkey: string; value: { space: string } }> }>(
            "com.atproto.space.listRecords",
            {
              space: groupMembersUri(ws.groupDid),
              repo: ws.groupDid,
              collection: OPENSOCIAL_COLLECTION.space,
            },
          );
          return res.records;
        };

        const idx1 = await listIndexedSpaces();
        assert.ok(idx1.some((r) => r.value.space === tempSpaceUri), "Listed modality space auto-indexed");
        assert.equal(idx1.some((r) => r.value.space === groupMetaUri(ws.groupDid)), false, "meta/self excluded");
        assert.equal(idx1.some((r) => r.value.space === groupMembersUri(ws.groupDid)), false, "members/self excluded");

        // Direct CRUD write to `group.opensocial.space` rejected with `400 IndexHostMaintained`
        const hostMaintErr = await captureXrpcError(() =>
          ws.groupClient.xrpc.procedure("com.atproto.space.putRecord", {
            space: groupMembersUri(ws.groupDid),
            repo: ws.groupDid,
            collection: OPENSOCIAL_COLLECTION.space,
            rkey: tidNow(),
            record: {
              $type: OPENSOCIAL_COLLECTION.space,
              space: tempSpaceUri,
              createdAt: new Date().toISOString(),
            },
          }),
        );
        assert.equal(hostMaintErr.status, 400);
        assert.equal(hostMaintErr.code, "IndexHostMaintained");

        // `updateSpace({ unlisted: true })` de-indexes; `{ unlisted: false }` re-indexes; `deleteSpace` removes index!
        await ws.groupClient.xrpc.procedure("com.atproto.space.updateSpace", {
          space: tempSpaceUri,
          policy: {
            $type: OPENSOCIAL_POLICY,
            publicRead: false,
            unlisted: true,
            grants: [{ role: "admin", read: true, write: true }],
          },
        });
        assert.equal((await listIndexedSpaces()).some((r) => r.value.space === tempSpaceUri), false);

        await ws.groupClient.xrpc.procedure("com.atproto.space.updateSpace", {
          space: tempSpaceUri,
          policy: {
            $type: OPENSOCIAL_POLICY,
            publicRead: false,
            unlisted: false,
            grants: [{ role: "admin", read: true, write: true }],
          },
        });
        assert.equal((await listIndexedSpaces()).some((r) => r.value.space === tempSpaceUri), true);

        await ws.groupClient.xrpc.procedure("com.atproto.space.deleteSpace", { space: tempSpaceUri });
        assert.equal((await listIndexedSpaces()).some((r) => r.value.space === tempSpaceUri), false);

        // 2b. Role & Membership Integrity Invariants:
        //     `DuplicateRoleGrant`, `UnknownRole`, `EmptyMemberRoles`, `RoleInUse`, `NoDefaultRole`,
        //     `CannotTargetGroupSelf`, `SubjectAlreadyHumanMember`
        {
          // `DuplicateRoleGrant`
          const dupGrantErr = await captureXrpcError(() =>
            ws.groupClient.xrpc.procedure("com.atproto.space.createSpace", {
              spaceType: SPACE_TYPE.channel,
              skey: "dup-grant-chan",
              policy: {
                $type: OPENSOCIAL_POLICY,
                publicRead: false,
                unlisted: false,
                grants: [
                  { role: "member", read: true },
                  { role: "member", read: true, write: true },
                ],
              },
            }),
          );
          assert.equal(dupGrantErr.code, "DuplicateRoleGrant");

          // `UnknownRole` (on space policy AND on membership)
          const unknownPolRoleErr = await captureXrpcError(() =>
            ws.groupClient.xrpc.procedure("com.atproto.space.createSpace", {
              spaceType: SPACE_TYPE.channel,
              skey: "unknown-role-chan",
              policy: {
                $type: OPENSOCIAL_POLICY,
                publicRead: false,
                unlisted: false,
                grants: [{ role: "ghost-role", read: true }],
              },
            }),
          );
          assert.equal(unknownPolRoleErr.code, "UnknownRole");

          const unknownMemRoleErr = await captureXrpcError(() =>
            ws.groupClient.xrpc.procedure("com.atproto.space.putRecord", {
              space: groupMembersUri(ws.groupDid),
              repo: ws.groupDid,
              collection: OPENSOCIAL_COLLECTION.membership,
              rkey: humanMember.did,
              record: { $type: OPENSOCIAL_COLLECTION.membership, roles: ["ghost-role"], createdAt: new Date().toISOString() },
            }),
          );
          assert.equal(unknownMemRoleErr.code, "UnknownRole");

          // `EmptyMemberRoles` (with `validate: false` to reach host integrity check directly!)
          const emptyRolesErr = await captureXrpcError(() =>
            ws.groupClient.xrpc.procedure("com.atproto.space.putRecord", {
              space: groupMembersUri(ws.groupDid),
              repo: ws.groupDid,
              collection: OPENSOCIAL_COLLECTION.membership,
              rkey: humanMember.did,
              validate: false,
              record: { $type: OPENSOCIAL_COLLECTION.membership, roles: [], createdAt: new Date().toISOString() },
            }),
          );
          assert.ok(emptyRolesErr.code === "EmptyMemberRoles" || emptyRolesErr.status === 400);

          // `RoleInUse` (referenced by `humanMember` membership / space policies)
          const roleInUseErr = await captureXrpcError(() => ws.groupClient.deleteRole("member"));
          assert.equal(roleInUseErr.code, "RoleInUse");

          // `NoDefaultRole`: clear `default: true` on `member`, then let an outsider call `requestJoin` on this `open` group -> `NoDefaultRole`!
          const existingMemberRole = (await ws.groupClient.listRoles()).find((r) => r.rkey === "member")!;
          await ws.groupClient.putRole("member", {
            displayName: existingMemberRole.displayName,
            default: false,
            scopes: existingMemberRole.scopes,
            assignable: existingMemberRole.assignable,
          });
          const outsiderNoDef = await nextActor("nodef", 1);
          const noDefRes = await personalGroupCall<{ error?: string }>({
            hostUrl: pds.groupHostUrl,
            actor: outsiderNoDef,
            groupDid: ws.groupDid,
            path: OPENSOCIAL_METHOD.requestJoin,
            httpMethod: "POST",
            lxm: OPENSOCIAL_METHOD.requestJoin,
            body: { group: ws.groupDid },
          });
          assert.equal(noDefRes.status, 400);
          assert.equal(noDefRes.json.error, "NoDefaultRole");

          // Restore `default: true` on `member`
          await ws.groupClient.putRole("member", {
            displayName: existingMemberRole.displayName,
            default: true,
            scopes: existingMemberRole.scopes,
            assignable: existingMemberRole.assignable,
          });

          // `CannotTargetGroupSelf`:
          // (i) `membership/<groupDid>`
          const selfMemErr = await captureXrpcError(() =>
            ws.groupClient.xrpc.procedure("com.atproto.space.putRecord", {
              space: groupMembersUri(ws.groupDid),
              repo: ws.groupDid,
              collection: OPENSOCIAL_COLLECTION.membership,
              rkey: ws.groupDid,
              record: { $type: OPENSOCIAL_COLLECTION.membership, roles: ["member"], createdAt: new Date().toISOString() },
            }),
          );
          assert.equal(selfMemErr.code, "CannotTargetGroupSelf");

          // (ii) `acceptance/self` authored by `groupDid`
          const selfAccErr = await captureXrpcError(() =>
            ws.groupClient.xrpc.procedure("com.atproto.space.putRecord", {
              space: groupMembersUri(ws.groupDid),
              repo: ws.groupDid,
              collection: OPENSOCIAL_COLLECTION.acceptance,
              rkey: SELF_SKEY,
              record: { $type: OPENSOCIAL_COLLECTION.acceptance, createdAt: new Date().toISOString() },
            }),
          );
          assert.equal(selfAccErr.code, "CannotTargetGroupSelf");

          // (iii) `app.install` targeting `groupDid`
          const selfAppErr = await captureXrpcError(() =>
            ws.groupClient.xrpc.procedure("com.atproto.space.putRecord", {
              space: ws.workspace,
              repo: ws.groupDid,
              collection: COLLECTION.appInstall,
              rkey: subjectKey(ws.groupDid),
              record: {
                $type: COLLECTION.appInstall,
                subject: ws.groupDid,
                active: true,
                channels: [],
                installedBy: alice.did,
                installedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            }),
          );
          assert.equal(selfAppErr.code, "CannotTargetGroupSelf");

          // (iv) `requestJoin`, `cancelJoinRequest`, `leaveGroup`, `createReport` signed by `<groupDid>` itself!
          for (const [methodNsid, payload] of [
            [OPENSOCIAL_METHOD.requestJoin, { group: ws.groupDid }],
            [OPENSOCIAL_METHOD.cancelJoinRequest, { group: ws.groupDid }],
            [OPENSOCIAL_METHOD.leaveGroup, { group: ws.groupDid }],
            [OPENSOCIAL_METHOD.createReport, { group: ws.groupDid, subject: humanMember.did, reasonType: "spam" }],
          ] as const) {
            const selfJwt = await pds.groupHost.repoStore.signGroupServiceJwt({
              groupDid: ws.groupDid,
              aud: `${ws.groupDid}#atproto_pds`,
              lxm: methodNsid,
            });
            const selfCallRes = await fetch(`${pds.groupHostUrl}/xrpc/${methodNsid}`, {
              method: "POST",
              headers: { authorization: `Bearer ${selfJwt}`, "content-type": "application/json" },
              body: JSON.stringify(payload),
            });
            assert.equal(selfCallRes.status, 400);
            assert.equal(((await selfCallRes.json()) as { error: string }).error, "CannotTargetGroupSelf");
          }

          // `SubjectAlreadyHumanMember`: writing `app.install` for `humanMember.did` fails!
          const humanAsBotErr = await captureXrpcError(() =>
            ws.groupClient.xrpc.procedure("com.atproto.space.putRecord", {
              space: ws.workspace,
              repo: ws.groupDid,
              collection: COLLECTION.appInstall,
              rkey: subjectKey(humanMember.did),
              record: {
                $type: COLLECTION.appInstall,
                subject: humanMember.did,
                active: true,
                channels: [],
                installedBy: alice.did,
                installedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            }),
          );
          assert.equal(humanAsBotErr.code, "SubjectAlreadyHumanMember");
        }

        // 2c. Full real Bot Lifecycle (`installApp` -> echo reply -> `AppMembershipActive` & `InvalidAppMembership` ->
        //     `updateAppAccess` writer eviction -> `uninstallApp` -> tombstone invariants -> post-uninstall migration!)
        const botStateDir = mkdtempSync(join(tmpdir(), "opensocial-bot-test-"));
        const stopBot = new AbortController();
        let botRunning: Promise<void> | undefined;
        let extraHostForBotMigration: RunningGroupHost | undefined;
        try {
          const adminEngine = createEngine(clientTransport(pds, alice), { operator: operatorService });
          const humanEngine = createEngine(clientTransport(pds, humanMember), { operator: operatorService });
          const ref = { workspace: ws.workspace, skey: ws.channelSkey };

          // Install bot with `write: true` in `#general`
          const installRes = await adminEngine.operator!.execute({
            workspace: ws.workspace,
            operationId: tidNow(),
            request: {
              kind: "installApp",
              subject: botActor.did,
              channels: [{ skey: ws.channelSkey, write: true }],
            },
          });
          assert.equal(installRes.operation.state, "completed");

          // Start real `startEchoBot` with its own OAuth session on `botActor.pds` (`pds.hosts[1]`)!
          const botOAuthSession = await mintAppSession(
            botActor.pds,
            botActor.did,
            { serviceRef: pds.serviceRef, plcUrl: pds.plcUrl, stateFile: join(botStateDir, "bot.json") },
            "opensocial-echo-bot-dpop",
          );
          const botTransport = nodeTransport(botOAuthSession, { plcUrl: pds.plcUrl, loopback: true });
          const botEngine = createEngine(botTransport, { operator: operatorService });
          await publishAppDeclaration(botTransport, {
            name: "OpenSocial Echo",
            description: "Echoes channel messages.",
            commands: ECHO_BOT_COMMANDS,
          });

          const botFeed = botEngine.operator!;
          let botPolls = 0;
          const botErrors: unknown[] = [];
          botRunning = startEchoBot({
            engine: {
              ...botEngine,
              operator: {
                getChanges: (follow, signal) => {
                  if (follow.some((f) => f.space === ws.channel)) botPolls += 1;
                  return botFeed.getChanges(follow, signal);
                },
              },
            },
            did: botActor.did,
            workspaces: [ws.workspace],
            signal: stopBot.signal,
            onError: (e) => botErrors.push(e),
          });

          for (const started = Date.now(); botPolls === 0; await new Promise((r) => setTimeout(r, 80))) {
            assert.ok(Date.now() - started < 20_000, `Bot failed to follow #general: ${botErrors.map(String).join("; ")}`);
          }

          const sentMsg = await humanEngine.channels.send(ref, "hello opensocial bot");
          await drainGroupHost(pds.groupHost);
          let botReply: { value: Record<string, unknown> } | undefined;
          for (const started = Date.now(); !botReply; await new Promise((r) => setTimeout(r, 150))) {
            assert.ok(Date.now() - started < 30_000, `Bot did not answer: ${botErrors.map(String).join("; ")}`);
            await drainGroupHost(pds.groupHost);
            await humanEngine.sync.markSpaceStale(ws.channel);
            botReply = (await humanEngine.channels.readPage(ref)).messages.find((m) => m.repo === botActor.did);
          }
          assert.equal(botReply.value.text, "echo: hello opensocial bot");
          assert.equal(botReply.value.parent, sentMsg.uri);

          // Verify `InvalidAppMembership`: bot in `known_app_subject` CANNOT be assigned human `member` or `admin` role!
          const botHumanRoleErr = await captureXrpcError(() => ws.groupClient.putMembership(botActor.did, ["member"]));
          assert.equal(botHumanRoleErr.code, "InvalidAppMembership");

          // Verify `AppMembershipActive`: cannot mark `app.install` `active: false` while `membership/<botActor.did>` still exists!
          const installsScan = await ws.groupClient.xrpc.query<{
            records: Array<{ rkey: string; value: Record<string, unknown> }>;
          }>("com.atproto.space.listRecords", {
            space: ws.workspace,
            repo: ws.groupDid,
            collection: COLLECTION.appInstall,
          });
          const botInstall = installsScan.records.find((r) => r.value.subject === botActor.did)!;
          assert.ok(botInstall);
          const activeMemErr = await captureXrpcError(() =>
            ws.groupClient.xrpc.procedure("com.atproto.space.putRecord", {
              space: ws.workspace,
              repo: ws.groupDid,
              collection: COLLECTION.appInstall,
              rkey: botInstall.rkey,
              record: { ...botInstall.value, active: false, channels: [], updatedAt: new Date().toISOString() },
            }),
          );
          assert.equal(activeMemErr.code, "AppMembershipActive");

          // `updateAppAccess`: downgrade bot in `#general` from `write: true` to `write: false` (read-only) ->
          // verifies Group Host evicts bot from `space_writer` (`removed = 1` / `#repoRemoved`)!
          const updateAccessRes = await adminEngine.operator!.execute({
            workspace: ws.workspace,
            operationId: tidNow(),
            request: {
              kind: "updateAppAccess",
              subject: botActor.did,
              channels: [{ skey: ws.channelSkey, write: false }],
            },
          });
          assert.equal(updateAccessRes.operation.state, "completed");
          await drainGroupHost(pds.groupHost);

          const aliceChanCred = await mintSpaceCredentialWith(actorTransport(pds, alice), ws.channel);
          const writersAfterReadOnly = await aliceChanCred
            .client(pds.groupHostUrl)
            .query<{ repos: Array<{ $type: string; repo: string }> }>("com.atproto.space.listWriters", { space: ws.channel });
          assert.equal(
            writersAfterReadOnly.repos.some(
              (w) => w.repo === botActor.did && w.$type === "com.atproto.space.defs#repoWrite",
            ),
            false,
            "Downgrading bot to write: false must evict bot from channel active #repoWrite writers",
          );
          assert.equal(
            writersAfterReadOnly.repos.some(
              (w) => w.repo === botActor.did && w.$type === "com.atproto.space.defs#repoRemoved",
            ),
            true,
            "Downgrading bot to write: false must record a #repoRemoved tombstone in listWriters",
          );

          // Conditional `InvalidAppMembership`: while `botActor` is actively installed (`active: true`),
          // rewriting `membership/<botActor.did>` with any role other than `[appRoleKey(botActor.did)]` MUST fail!
          const wrongRoleOnActiveAppErr = await captureXrpcError(() =>
            ws.groupClient.putMembership(botActor.did, ["member"]),
          );
          assert.equal(wrongRoleOnActiveAppErr.code, "InvalidAppMembership");

          // `uninstallApp`: removes `membership/<bot>` & `role/app-<key>` and writes `active: false` tombstone!
          const uninstallRes = await adminEngine.operator!.execute({
            workspace: ws.workspace,
            operationId: tidNow(),
            request: { kind: "uninstallApp", subject: botActor.did },
          });
          assert.equal(uninstallRes.operation.state, "completed");
          await drainGroupHost(pds.groupHost);

          // Operator feed immediately denies `#general` to uninstalled bot & fresh credential mint is refused!
          const { head } = await botFeed.getChanges([]);
          assert.deepEqual((await botFeed.getChanges([{ space: ws.channel, after: head }])).denied, [ws.channel]);
          const credRefusal = await botEngine.credentials.fresh(ws.channel).then(() => null, (e: unknown) => e);
          assert.ok(credRefusal && isAccessLost(credRefusal));

          for (const started = Date.now(); !botErrors.some((e) => e instanceof AppAccessLostError); await new Promise((r) => setTimeout(r, 100))) {
            assert.ok(Date.now() - started < 20_000, "Bot runtime must observe AppAccessLostError");
          }

          // Post-uninstall tombstone invariants:
          // 1. `CannotDeleteAppInstallTombstone` blocks deleting `app.install`
          const delTombErr = await captureXrpcError(() =>
            ws.groupClient.xrpc.procedure("com.atproto.space.deleteRecord", {
              space: ws.workspace,
              repo: ws.groupDid,
              collection: COLLECTION.appInstall,
              rkey: botInstall.rkey,
            }),
          );
          assert.equal(delTombErr.code, "CannotDeleteAppInstallTombstone");

          // 2. `CannotDeleteWorkspaceWithAppTombstones` blocks deleting `workspace/self`
          const delWsTombErr = await captureXrpcError(() =>
            ws.groupClient.xrpc.procedure("com.atproto.space.deleteSpace", { space: ws.workspace }),
          );
          assert.equal(delWsTombErr.code, "CannotDeleteWorkspaceWithAppTombstones");

          // 3. `AppMembershipActive`: cannot write `membership/<botActor.did>` while `app.install.active === false`!
          await ws.groupClient.putRole("app-temp-role", { displayName: "App Temp", scopes: [] });
          const inactiveAppMemErr = await captureXrpcError(() =>
            ws.groupClient.putMembership(botActor.did, ["app-temp-role"]),
          );
          assert.equal(inactiveAppMemErr.code, "AppMembershipActive");

          // 4. `SubjectIsAppServicePrincipal`: uninstalled bot still cannot call `requestJoin` as a human!
          const botJoinAttempt = await personalGroupCall<{ error?: string }>({
            hostUrl: pds.groupHostUrl,
            actor: botActor,
            groupDid: ws.groupDid,
            path: OPENSOCIAL_METHOD.requestJoin,
            httpMethod: "POST",
            lxm: OPENSOCIAL_METHOD.requestJoin,
            body: { group: ws.groupDid },
          });
          assert.equal(botJoinAttempt.status, 400);
          assert.equal(botJoinAttempt.json.error, "SubjectIsAppServicePrincipal");

          // 5. Post-uninstall Group Host migration preserves `active: false` `app.install` tombstone & `known_app_subject`!
          extraHostForBotMigration = await pds.startExtraGroupHost();
          const stepUpBotMigClient = await stepUpRealGroupClient(pds.groupHost, alice, ws.groupDid);
          const migResult = await stepUpBotMigClient.migrateToHost(extraHostForBotMigration.url, {
            handle: `migrated-bot-ws.${extraHostForBotMigration.config.handleDomain}`,
            useCoordinated: true,
          });
          assert.equal(migResult.mode, "coordinated");
          await drainGroupHost(extraHostForBotMigration);

          const knownOnTarget = extraHostForBotMigration.db
            .prepare("SELECT subject_did FROM known_app_subject WHERE group_did = ? AND subject_did = ?")
            .get(ws.groupDid, botActor.did) as { subject_did: string } | undefined;
          assert.equal(knownOnTarget?.subject_did, botActor.did, "Target Group Host must reconstruct known_app_subject from migrated active: false tombstone");

          const botJoinOnTarget = await personalGroupCall<{ error?: string }>({
            hostUrl: extraHostForBotMigration.url,
            actor: botActor,
            groupDid: ws.groupDid,
            path: OPENSOCIAL_METHOD.requestJoin,
            httpMethod: "POST",
            lxm: OPENSOCIAL_METHOD.requestJoin,
            body: { group: ws.groupDid },
          });
          assert.equal(botJoinOnTarget.status, 400);
          assert.equal(botJoinOnTarget.json.error, "SubjectIsAppServicePrincipal");
        } finally {
          stopBot.abort();
          await Promise.race([botRunning?.catch(() => undefined), new Promise((r) => setTimeout(r, 2_000))]);
          await extraHostForBotMigration?.close();
          rmSync(botStateDir, { recursive: true, force: true });
        }
      },
    );

    // =========================================================================
    // 3. `ensureInvitesSpace()`, Cross-PDS Invites, Join Policies & 5-Phase
    //    `joiningGroups` Crash Recovery
    // =========================================================================
    await t.test(
      "3. ensureInvitesSpace on fresh PDSes, cross-PDS invites + retry + colliding TIDs + races, join policies & 5-phase joiningGroups crash recovery",
      async () => {
        // 3a. `ensureInvitesSpace()` on genuinely fresh personal PDSes (zero fixture pre-creation!)
        const freshHost0 = await nextActor("freshinv0", 0);
        const freshHost1 = await nextActor("freshinv1", 1);

        for (const freshActor of [freshHost0, freshHost1]) {
          const personalXrpc = sessionClient(bearerSession(freshActor) as never);
          const preCheckErr = await captureXrpcError(() =>
            personalXrpc.query("com.atproto.space.getSpace", { space: personalInvitesUri(freshActor.did) }),
          );
          assert.equal(preCheckErr.code, "SpaceNotFound", "Personal PDS fixture must NOT pre-create group.opensocial.invites/self");
        }

        // Concurrent `SpaceAlreadyExists` race across two independent `WorkspaceClient` instances + restart idempotency!
        {
          const engA = createEngine(clientTransport(pds, freshHost0), { operator: operatorService });
          const engB = createEngine(clientTransport(pds, freshHost0), { operator: operatorService });
          const [uriA, uriB] = await Promise.all([
            engA.workspaces.ensureInvitesSpace(),
            engB.workspaces.ensureInvitesSpace(),
          ]);
          assert.equal(uriA, personalInvitesUri(freshHost0.did));
          assert.equal(uriB, personalInvitesUri(freshHost0.did));

          // Restart idempotency (`resetInvitesVerificationCache()` + fresh engine)
          engA.workspaces.resetInvitesVerificationCache();
          assert.equal(await engA.workspaces.ensureInvitesSpace(), personalInvitesUri(freshHost0.did));
          const engC = createEngine(clientTransport(pds, freshHost0), { operator: operatorService });
          assert.equal(await engC.workspaces.ensureInvitesSpace(), personalInvitesUri(freshHost0.did));
        }

        // All 4 `IncompatibleInvitesSpacePolicyError` cases on fresh personal PDS accounts:
        // (i) `allowedApps: []`, (ii) `publicWrite: false`, (iii) `publicRead: true`, (iv) non-empty member list!
        for (const [idx, badCase] of (["allowedApps", "noPublicWrite", "publicReadTrue", "nonEmptyMembers"] as const).entries()) {
          const badActor = await nextActor(`badinv${idx}`, 1);
          const badXrpc = sessionClient(bearerSession(badActor) as never);
          const policy: Record<string, unknown> =
            badCase === "allowedApps"
              ? { $type: MEMBERSPACE_POLICY, publicRead: false, publicWrite: true, allowedApps: [] }
              : badCase === "noPublicWrite"
                ? { $type: MEMBERSPACE_POLICY, publicRead: false, publicWrite: false }
                : {
                    $type: MEMBERSPACE_POLICY,
                    publicRead: badCase === "publicReadTrue",
                    publicWrite: true,
                  };
          await badXrpc.procedure("com.atproto.space.createSpace", {
            spaceType: OPENSOCIAL_SPACE_TYPE.invites,
            skey: SELF_SKEY,
            policy,
          });
          if (badCase === "nonEmptyMembers") {
            await badXrpc.procedure("com.atproto.memberspace.putMembers", {
              space: personalInvitesUri(badActor.did),
              members: [{ did: freshHost0.did, read: true, write: false }],
            });
          }
          const badEngine = createEngine(clientTransport(pds, badActor), { operator: operatorService });
          await assert.rejects(
            badEngine.workspaces.ensureInvitesSpace(),
            (err: unknown) => err instanceof IncompatibleInvitesSpacePolicyError,
            `Expected IncompatibleInvitesSpacePolicyError for ${badCase}`,
          );
        }

        // 3b. Real-time `getSpaceNotifyTarget` wake on `invites/self`, simulated delivery failure -> `retryInviteDelivery` -> redemption,
        //     cross-group colliding-TID author isolation, wrong-recipient/wrong-authority/expired/revoked invites, & `deleteRecord` vs `requestJoin` race!
        {
          const alice = await nextActor("invalice", 0);
          const bob = await nextActor("invbob", 1);
          const carol = await nextActor("invcarol", 1);
          const dan = await nextActor("invdan", 0);

          const groupA = await createFullFlockWorkspace(pds, alice, { name: "Alpha Group", joinPolicy: "invite" });
          const groupB = await createFullFlockWorkspace(pds, alice, { name: "Bravo Group", joinPolicy: "invite" });

          const bobEngine = createEngine(clientTransport(pds, bob), { operator: operatorService });
          const bobInvitesSpace = await bobEngine.workspaces.watchInvites(bobEngine.operator!);
          const { head: headBeforeInvite } = await bobEngine.operator!.getChanges([]);

          // Send cross-PDS invite (`groupA` -> `bob` on `pds.hosts[1]`) -> wakes Operator feed in real time!
          const bobInvite = await groupA.groupClient.createInvite(bob.did);
          await drainGroupHost(pds.groupHost);

          const feedWake = await bobEngine.operator!.getChanges([{ space: bobInvitesSpace, after: headBeforeInvite }]);
          assert.ok(
            feedWake.changed.some((c) => c.space === bobInvitesSpace),
            "Cross-PDS invite notifyRepoUpdate must wake invitee's getSpaceNotifyTarget registration",
          );
          const listedBobInvites = await bobEngine.workspaces.listInvites();
          assert.equal(listedBobInvites.length, 1);
          assert.equal(listedBobInvites[0]?.uri, bobInvite.uri);
          assert.equal(listedBobInvites[0]?.groupName, "Alpha Group");

          // Simulated delivery failure -> `listInviteDeliveries` (`status: "failed"`) -> `retryInviteDelivery` -> redemption!
          let blockInviteNotify = true;
          const ghFlakyInvite = await pds.startExtraGroupHost({
            fetchImpl: async (input, init) => {
              const url = input instanceof Request ? input.url : String(input);
              if (blockInviteNotify && url.includes("/xrpc/com.atproto.space.notifyRepoUpdate")) {
                // Return non-retryable 400 so outbox immediately records status = 'failed' on invite_delivery!
                return Response.json({ error: "UpstreamUnavailable", message: "simulated delivery failure" }, { status: 400 });
              }
              return fetch(input, init);
            },
          });
          try {
            const flakyFlow = await completeRealGroupOAuthFlow({
              groupHost: ghFlakyInvite,
              actor: alice,
              scope: groupAdminScopes().join(" "),
              prompt: "create",
              createParams: { displayName: "Retry Delivery Group", joinPolicy: "invite", publicMeta: true },
            });
            const flakyGroupDid = flakyFlow.tokenResponse!.sub;
            const flakyGroupClient = makeGroupClient(
              ghFlakyInvite,
              flakyGroupDid,
              flakyFlow.dpop,
              flakyFlow.tokenResponse!.access_token,
            );

            const retryInvitee = await nextActor("retryinv", 1);
            const retryEngine = createEngine(clientTransport(pds, retryInvitee), { operator: operatorService });
            await retryEngine.workspaces.ensureInvitesSpace();

            const failedInv = await flakyGroupClient.createInvite(retryInvitee.did);
            await drainGroupHost(ghFlakyInvite);

            const delivBefore = await flakyGroupClient.listInviteDeliveries();
            const rowBefore = delivBefore.deliveries.find((d) => d.inviteUri === failedInv.uri);
            assert.equal(rowBefore?.status, "failed");

            blockInviteNotify = false;
            await flakyGroupClient.retryInviteDelivery(failedInv.uri);
            await drainGroupHost(ghFlakyInvite);

            const delivAfter = await flakyGroupClient.listInviteDeliveries();
            const rowAfter = delivAfter.deliveries.find((d) => d.inviteUri === failedInv.uri);
            assert.equal(rowAfter?.status, "delivered");

            const redeemRetry = await retryEngine.workspaces.joinGroup({
              groupDid: flakyGroupDid,
              mode: "invite",
              inviteUri: failedInv.uri,
            });
            assert.equal(redeemRetry.status, "admitted");
          } finally {
            await ghFlakyInvite.close();
          }

          // Cross-group colliding-TID author isolation + wrong-recipient / wrong-authority / expired / revoked invites!
          const carolEngine = createEngine(clientTransport(pds, carol), { operator: operatorService });
          await carolEngine.workspaces.ensureInvitesSpace();
          const sharedTid = tidNow();
          const invA = await groupA.groupClient.createInvite(carol.did, { rkey: sharedTid });
          const invB = await groupB.groupClient.createInvite(carol.did, { rkey: sharedTid });
          await drainGroupHost(pds.groupHost);

          const carolInvites = await carolEngine.workspaces.listInvites();
          assert.equal(carolInvites.length, 2, "Colliding TID across two groups must list both author-scoped invites");
          const carolIndInvites = await readIndependentInvites(actorTransport(pds, carol), carol.did);
          assert.equal(carolIndInvites.length, 2);

          // Wrong-authority: presenting `invB.uri` (`groupB` author) to `groupA` fails with `400 InvalidInvite`
          const wrongAuthErr = await personalGroupCall<{ error?: string }>({
            hostUrl: pds.groupHostUrl,
            actor: carol,
            groupDid: groupA.groupDid,
            path: OPENSOCIAL_METHOD.requestJoin,
            httpMethod: "POST",
            lxm: OPENSOCIAL_METHOD.requestJoin,
            body: { group: groupA.groupDid, invite: invB.uri },
          });
          assert.equal(wrongAuthErr.status, 400);
          assert.equal(wrongAuthErr.json.error, "InvalidInvite");

          // Wrong-recipient: `dan` presenting `carol`'s `invA.uri` fails with `400 InvalidInvite`
          const wrongRecipErr = await personalGroupCall<{ error?: string }>({
            hostUrl: pds.groupHostUrl,
            actor: dan,
            groupDid: groupA.groupDid,
            path: OPENSOCIAL_METHOD.requestJoin,
            httpMethod: "POST",
            lxm: OPENSOCIAL_METHOD.requestJoin,
            body: { group: groupA.groupDid, invite: invA.uri },
          });
          assert.equal(wrongRecipErr.status, 400);
          assert.equal(wrongRecipErr.json.error, "InvalidInvite");

          // Redeeming `invA` admits Carol into `groupA` and deletes ONLY `groupA`'s `sharedTid` invite, leaving `groupB`'s `sharedTid` invite intact!
          const carolJoinA = await carolEngine.workspaces.joinGroup({
            groupDid: groupA.groupDid,
            mode: "invite",
            inviteUri: invA.uri,
          });
          assert.equal(carolJoinA.status, "admitted");
          const remainingCarolInvites = await carolEngine.workspaces.listInvites();
          assert.deepEqual(
            remainingCarolInvites.map((i) => i.uri),
            [invB.uri],
            "Redeeming Group A's colliding-TID invite must leave Group B's colliding-TID invite untouched",
          );
          const carolJoinB = await carolEngine.workspaces.joinGroup({
            groupDid: groupB.groupDid,
            mode: "invite",
            inviteUri: invB.uri,
          });
          assert.equal(carolJoinB.status, "admitted");

          // Expired & revoked invites -> `400 InvalidInvite`
          const danEngine = createEngine(clientTransport(pds, dan), { operator: operatorService });
          await danEngine.workspaces.ensureInvitesSpace();
          const expiredInv = await groupA.groupClient.createInvite(dan.did, {
            expiresAt: new Date(Date.now() - 60_000).toISOString(),
          });
          const expJoinErr = await captureXrpcError(() =>
            danEngine.workspaces.joinGroup({ groupDid: groupA.groupDid, mode: "invite", inviteUri: expiredInv.uri }),
          );
          assert.equal(expJoinErr.code, "InvalidInvite");

          const revokedInv = await groupA.groupClient.createInvite(dan.did);
          await groupA.groupClient.revokeInvite(dan.did, revokedInv.rkey);
          const revJoinErr = await captureXrpcError(() =>
            danEngine.workspaces.joinGroup({ groupDid: groupA.groupDid, mode: "invite", inviteUri: revokedInv.uri }),
          );
          assert.equal(revJoinErr.code, "InvalidInvite");

          // Barrier-serialized `deleteRecord(invite)` vs `requestJoin` race (`locks.withGroupRepoLock`)!
          const raceInv = await groupA.groupClient.createInvite(dan.did);
          await drainGroupHost(pds.groupHost);
          let releaseLock!: () => void;
          const lockReady = new Promise<void>((resolveReady) => {
            void pds.groupHost.locks.withGroupRepoLock(groupA.groupDid, async () => {
              resolveReady();
              await new Promise<void>((r) => {
                releaseLock = r;
              });
            });
          });
          await lockReady;

          const revokePromise = groupA.groupClient.revokeInvite(dan.did, raceInv.rkey);
          const joinRacePromise = personalGroupCall<{ status?: string; error?: string }>({
            hostUrl: pds.groupHostUrl,
            actor: dan,
            groupDid: groupA.groupDid,
            path: OPENSOCIAL_METHOD.requestJoin,
            httpMethod: "POST",
            lxm: OPENSOCIAL_METHOD.requestJoin,
            body: { group: groupA.groupDid, invite: raceInv.uri },
          });
          releaseLock();

          const [, joinRaceOut] = await Promise.all([revokePromise, joinRacePromise]);
          if (joinRaceOut.status === 200) {
            assert.equal(joinRaceOut.json.status, "admitted");
          } else {
            assert.equal(joinRaceOut.status, 400);
            assert.equal(joinRaceOut.json.error, "InvalidInvite");
            assert.equal(await groupA.groupClient.getMembership(dan.did), null, "Revoke-first race must not admit applicant");
          }
        }

        // 3c. Join Policies (`open` / `approval` / `invite` / unknown `JoinClosed`), `Idempotency-Key` & E2 pending-alias resume,
        //     `JoinRequestClosed`, `IdempotencyParameterMismatch`, `200`-row quota cap (`429 JoinOperationQuotaExceeded`),
        //     single-transaction `If-Join-Request-Present: true`, `pending_approval` restart + approved-before-migration,
        //     `orphaned_by_migration`, `expired_unknown`, and 5-phase `joiningGroups` crash recovery!
        {
          const alice = await nextActor("jpalice", 0);
          const applicant1 = await nextActor("jpapp1", 1);
          const applicant2 = await nextActor("jpapp2", 1);
          const applicant3 = await nextActor("jpapp3", 0);
          const quotaActor = await nextActor("jpquota", 1);

          // Unknown `joinPolicy` (`"future-custom-mode"`) -> `400 JoinClosed`!
          const customPolicyGroup = await createFullFlockWorkspace(pds, alice, {
            name: "Custom Policy Group",
            joinPolicy: "invite",
          });
          await customPolicyGroup.groupClient.xrpc.procedure("com.atproto.space.putRecord", {
            space: groupMetaUri(customPolicyGroup.groupDid),
            repo: customPolicyGroup.groupDid,
            collection: OPENSOCIAL_COLLECTION.profile,
            rkey: SELF_SKEY,
            record: {
              $type: OPENSOCIAL_COLLECTION.profile,
              displayName: "Custom Policy Group",
              joinPolicy: "future-custom-mode",
            },
          });
          const unknownPolRes = await personalGroupCall<{ error?: string }>({
            hostUrl: pds.groupHostUrl,
            actor: applicant1,
            groupDid: customPolicyGroup.groupDid,
            path: OPENSOCIAL_METHOD.requestJoin,
            httpMethod: "POST",
            lxm: OPENSOCIAL_METHOD.requestJoin,
            body: { group: customPolicyGroup.groupDid },
          });
          assert.equal(unknownPolRes.status, 400);
          assert.equal(unknownPolRes.json.error, "JoinClosed");

          // `approval` policy: headerless canonical third-party `requestJoin` + `Idempotency-Key` replay + E2 fresh `operationId` pending-alias resume!
          const approvalGroup = await createFullFlockWorkspace(pds, alice, {
            name: "Approval Policy Group",
            joinPolicy: "approval",
          });

          // Headerless `requestJoin` returns `status: "pending"`
          const headerlessPending = await personalGroupCall<{ status?: string }>({
            hostUrl: pds.groupHostUrl,
            actor: applicant1,
            groupDid: approvalGroup.groupDid,
            path: OPENSOCIAL_METHOD.requestJoin,
            httpMethod: "POST",
            lxm: OPENSOCIAL_METHOD.requestJoin,
            body: { group: approvalGroup.groupDid, message: "Please let me join" },
          });
          assert.equal(headerlessPending.status, 200);
          assert.equal(headerlessPending.json.status, "pending");

          // Fresh `operationId` while already pending (`E2` pending-alias resume): returns `"pending"` AND binds alias so `join-status?operationId=<aliasOpId>` works!
          const aliasOpId = tidNow();
          const aliasResume = await personalGroupCall<{ status?: string }>({
            hostUrl: pds.groupHostUrl,
            actor: applicant1,
            groupDid: approvalGroup.groupDid,
            path: OPENSOCIAL_METHOD.requestJoin,
            httpMethod: "POST",
            lxm: OPENSOCIAL_METHOD.requestJoin,
            headers: { "idempotency-key": aliasOpId },
            body: { group: approvalGroup.groupDid, message: "Please let me join" },
          });
          assert.equal(aliasResume.status, 200);
          assert.equal(aliasResume.json.status, "pending");

          const aliasStatus = await personalGroupCall<{ state: string }>({
            hostUrl: pds.groupHostUrl,
            actor: applicant1,
            groupDid: approvalGroup.groupDid,
            path: "/group-member/join-status",
            httpMethod: "GET",
            lxm: OPENSOCIAL_METHOD.requestJoin,
            query: { group: approvalGroup.groupDid, operationId: aliasOpId },
          });
          assert.equal(aliasStatus.json.state, "pending");

          // `IdempotencyParameterMismatch` (`409`) when replaying `aliasOpId` with different `message`!
          const mismatchRes = await personalGroupCall<{ error?: string }>({
            hostUrl: pds.groupHostUrl,
            actor: applicant1,
            groupDid: approvalGroup.groupDid,
            path: OPENSOCIAL_METHOD.requestJoin,
            httpMethod: "POST",
            lxm: OPENSOCIAL_METHOD.requestJoin,
            headers: { "idempotency-key": aliasOpId },
            body: { group: approvalGroup.groupDid, message: "MUTATED MESSAGE" },
          });
          assert.equal(mismatchRes.status, 409);
          assert.equal(mismatchRes.json.error, "IdempotencyParameterMismatch");

          // Deny `applicant1` -> replaying `aliasOpId` returns `400 JoinRequestClosed`!
          await approvalGroup.groupClient.denyJoinRequest(applicant1.did);
          const closedReplay = await personalGroupCall<{ error?: string }>({
            hostUrl: pds.groupHostUrl,
            actor: applicant1,
            groupDid: approvalGroup.groupDid,
            path: OPENSOCIAL_METHOD.requestJoin,
            httpMethod: "POST",
            lxm: OPENSOCIAL_METHOD.requestJoin,
            headers: { "idempotency-key": aliasOpId },
            body: { group: approvalGroup.groupDid, message: "Please let me join" },
          });
          assert.equal(closedReplay.status, 400);
          assert.equal(closedReplay.json.error, "JoinRequestClosed");

          // Admitted `response_json` replay on `open` group!
          const openGroup = await createFullFlockWorkspace(pds, alice, { name: "Open Policy Group", joinPolicy: "open" });
          const openOpId = tidNow();
          const openAdmit1 = await personalGroupCall<{ status: string; membership?: { uri: string; cid: string } }>({
            hostUrl: pds.groupHostUrl,
            actor: applicant1,
            groupDid: openGroup.groupDid,
            path: OPENSOCIAL_METHOD.requestJoin,
            httpMethod: "POST",
            lxm: OPENSOCIAL_METHOD.requestJoin,
            headers: { "idempotency-key": openOpId },
            body: { group: openGroup.groupDid },
          });
          assert.equal(openAdmit1.status, 200);
          assert.equal(openAdmit1.json.status, "admitted");
          const openAdmit2 = await personalGroupCall<{ status: string; membership?: { uri: string; cid: string } }>({
            hostUrl: pds.groupHostUrl,
            actor: applicant1,
            groupDid: openGroup.groupDid,
            path: OPENSOCIAL_METHOD.requestJoin,
            httpMethod: "POST",
            lxm: OPENSOCIAL_METHOD.requestJoin,
            headers: { "idempotency-key": openOpId },
            body: { group: openGroup.groupDid },
          });
          assert.deepEqual(openAdmit2.json, openAdmit1.json, "Admitted Idempotency-Key replay returns cached response_json");

          // Single-transaction `If-Join-Request-Present: true` rejecting late/cancelled approval (`409 JoinRequestNotFound`)!
          await personalGroupCall({
            hostUrl: pds.groupHostUrl,
            actor: applicant2,
            groupDid: approvalGroup.groupDid,
            path: OPENSOCIAL_METHOD.requestJoin,
            httpMethod: "POST",
            lxm: OPENSOCIAL_METHOD.requestJoin,
            body: { group: approvalGroup.groupDid },
          });
          await personalGroupCall({
            hostUrl: pds.groupHostUrl,
            actor: applicant2,
            groupDid: approvalGroup.groupDid,
            path: OPENSOCIAL_METHOD.cancelJoinRequest,
            httpMethod: "POST",
            lxm: OPENSOCIAL_METHOD.cancelJoinRequest,
            body: { group: approvalGroup.groupDid },
          });
          const lateApproveErr = await captureXrpcError(() => approvalGroup.groupClient.approveJoinRequest(applicant2.did));
          assert.equal(lateApproveErr.status, 409);
          assert.equal(lateApproveErr.code, "JoinRequestNotFound");

          // Non-evicting `200`-row unexpired `join_operation_state` quota cap -> `429 JoinOperationQuotaExceeded` -> passive `quota_exceeded` surviving `discover()`!
          {
            const futureExp = Date.now() + 24 * 3600_000;
            const insQuota = pds.groupHost.db.prepare(
              `INSERT INTO join_operation_state (group_did, requester_did, operation_id, request_hash, state, response_json, expires_at, updated_at)
               VALUES (?, ?, ?, 'hash', 'cancelled', '{}', ?, ?)`,
            );
            const seedTx = pds.groupHost.db.transaction(() => {
              for (let i = 0; i < 200; i += 1) {
                insQuota.run(approvalGroup.groupDid, quotaActor.did, `quota-op-${i}`, futureExp, Date.now());
              }
            });
            seedTx();

            const quotaStore = new MemoryStore();
            let requestJoinHits = 0;
            const quotaEngine = createEngine(
              actorTransport(pds, quotaActor, {
                fetchVia: async (req) => {
                  if (req.url.includes(`/xrpc/${OPENSOCIAL_METHOD.requestJoin}`)) requestJoinHits += 1;
                  return fetch(req);
                },
              }),
              { store: quotaStore, operator: operatorService },
            );
            const quotaOpId = tidNow();
            await assert.rejects(
              quotaEngine.workspaces.joinGroup({
                groupDid: approvalGroup.groupDid,
                mode: "approval",
                operationId: quotaOpId,
              }),
              (err: unknown) => err instanceof JoinOperationQuotaExceededError,
            );
            assert.equal(requestJoinHits, 1);
            assert.equal((await quotaStore.getJoiningGroup(quotaOpId))?.phase, "quota_exceeded");

            // `discover()` preserves passive `quota_exceeded` without auto-retrying `requestJoin`!
            await quotaEngine.workspaces.discover();
            assert.equal(requestJoinHits, 1);
            assert.equal((await quotaStore.getJoiningGroup(quotaOpId))?.phase, "quota_exceeded");
          }

          // `pending_approval` surviving restart + `discover()` without calling `requestJoin` again,
          // PLUS **approved-before-migration resuming to `admitted` via durable-membership-first `join-status` on Target Host**!
          const ghMigTarget = await pds.startExtraGroupHost();
          try {
            const migJoinGroup = await createFullFlockWorkspace(pds, alice, {
              name: "Migrate Pending Approval Group",
              joinPolicy: "approval",
            });
            const app3Store = new MemoryStore();
            let app3RequestJoinCalls = 0;
            const makeApp3Engine = () =>
              createEngine(
                actorTransport(pds, applicant3, {
                  fetchVia: async (req) => {
                    if (req.url.includes(`/xrpc/${OPENSOCIAL_METHOD.requestJoin}`)) app3RequestJoinCalls += 1;
                    return fetch(req);
                  },
                }),
                { store: app3Store, operator: operatorService },
              );

            const app3Eng1 = makeApp3Engine();
            const pendingJoin = await app3Eng1.workspaces.joinGroup({
              groupDid: migJoinGroup.groupDid,
              mode: "approval",
              message: "Admit before migration",
            });
            assert.equal(pendingJoin.status, "pending");
            assert.equal(app3RequestJoinCalls, 1);

            // Simulated restart (`app3Eng2` over `app3Store`): `discover()` polls `join-status` WITHOUT calling `requestJoin` again!
            const app3Eng2 = makeApp3Engine();
            const discStillPending = await app3Eng2.workspaces.discover();
            assert.equal(app3RequestJoinCalls, 1, "pending_approval resume must NEVER call requestJoin again");
            assert.equal(discStillPending.joiningGroups?.[0]?.phase, "pending_approval");

            // Also seed a SECOND unapproved applicant (`orphanApplicant`) on `migJoinGroup` BEFORE migration so the same migration
            // simultaneously tests BOTH:
            //   (1) `applicant3` (approved BEFORE migration) -> resumes to `admitted` on `ghMigTarget` via durable-membership-first `join-status`!
            //   (2) `orphanApplicant` (NOT approved before migration) -> transitions to passive `orphaned_by_migration` on `ghMigTarget`!
            const orphanApplicant = await nextActor("jporphan", 1);
            const orphanStore = new MemoryStore();
            const orphanEng1 = createEngine(clientTransport(pds, orphanApplicant), {
              store: orphanStore,
              operator: operatorService,
            });
            const orphanJoin = await orphanEng1.workspaces.joinGroup({
              groupDid: migJoinGroup.groupDid,
              mode: "approval",
            });
            assert.equal(orphanJoin.status, "pending");

            // Approve ONLY `applicant3` on Source Host (`pds.groupHost`), then migrate `migJoinGroup` to `ghMigTarget`!
            await migJoinGroup.groupClient.approveJoinRequest(applicant3.did);
            const stepUpMigJoinClient = await stepUpRealGroupClient(pds.groupHost, alice, migJoinGroup.groupDid);
            await stepUpMigJoinClient.migrateToHost(ghMigTarget.url, {
              handle: `mig-join.${ghMigTarget.config.handleDomain}`,
              useCoordinated: true,
            });
            await drainGroupHost(ghMigTarget);

            // Confirm `join_operation_state` did NOT migrate to `ghMigTarget`, yet `applicant3` resumes to `admitted` via durable `membership`!
            const targetOpRows = ghMigTarget.db
              .prepare("SELECT COUNT(*) AS cnt FROM join_operation_state WHERE group_did = ?")
              .get(migJoinGroup.groupDid) as { cnt: number };
            assert.equal(targetOpRows.cnt, 0);

            const app3Eng3 = makeApp3Engine();
            const discAdmitted = await app3Eng3.workspaces.discover();
            assert.equal(app3RequestJoinCalls, 1);
            assert.ok(
              discAdmitted.workspaces.some((w) => w.groupDid === migJoinGroup.groupDid),
              "Approved-before-migration applicant must complete acceptance/self + discovery on Target Host",
            );
            assert.equal(discAdmitted.joiningGroups?.length ?? 0, 0);

            // Meanwhile `orphanApplicant` (unapproved before migration) transitions to passive `orphaned_by_migration`!
            const orphanEng2 = createEngine(clientTransport(pds, orphanApplicant), {
              store: orphanStore,
              operator: operatorService,
            });
            const discOrphan = await orphanEng2.workspaces.discover();
            assert.equal(discOrphan.joiningGroups?.[0]?.operationId, orphanJoin.operationId);
            assert.equal(discOrphan.joiningGroups?.[0]?.phase, "orphaned_by_migration");
          } finally {
            await ghMigTarget.close();
          }

          // Same-host `expired_unknown` terminal transition!
          {
            const expApplicant = await nextActor("jpexp", 1);
            const expStore = new MemoryStore();
            const expEng = createEngine(clientTransport(pds, expApplicant), {
              store: expStore,
              operator: operatorService,
            });
            const expJoin = await expEng.workspaces.joinGroup({
              groupDid: approvalGroup.groupDid,
              mode: "approval",
            });
            assert.equal(expJoin.status, "pending");

            // Expire both `join_request` and `join_operation_state` on the SAME host (`pds.groupHost`)
            pds.groupHost.db
              .prepare("DELETE FROM join_request WHERE group_did = ? AND requester_did = ?")
              .run(approvalGroup.groupDid, expApplicant.did);
            pds.groupHost.db
              .prepare("DELETE FROM join_operation_state WHERE group_did = ? AND requester_did = ?")
              .run(approvalGroup.groupDid, expApplicant.did);

            const discExp = await expEng.workspaces.discover();
            assert.equal(discExp.joiningGroups?.[0]?.operationId, expJoin.operationId);
            assert.equal(discExp.joiningGroups?.[0]?.phase, "expired_unknown");
          }

          // 3d. 5-phase `joiningGroups` crash recovery across EVERY phase
          //     (`submitting`, `pending_approval`, `membership_verified`, `acceptance_pending`, `discovery_verified`)
          //     for ALL 4 modes (`create`, `open`, `invite`, `approval`)!
          for (const mode of ["create", "open", "invite", "approval"] as const) {
            const phasesForMode =
              mode === "approval"
                ? (["submitting", "pending_approval", "membership_verified", "acceptance_pending", "discovery_verified"] as const)
                : (["submitting", "membership_verified", "acceptance_pending", "discovery_verified"] as const);

            for (const crashAtPhase of phasesForMode) {
              const joiner = await nextActor("crjn", 1);
              const rawStore = new MemoryStore();
              let injectedCrash = false;

              // Intercept `putJoiningGroup` so as soon as `entry.phase === crashAtPhase` is persisted, we simulate a crash!
              const origPut = rawStore.putJoiningGroup.bind(rawStore);
              let triggerCrashOnPhase: string | null = crashAtPhase;
              rawStore.putJoiningGroup = async (entry) => {
                await origPut(entry);
                if (triggerCrashOnPhase !== null && entry.phase === triggerCrashOnPhase) {
                  injectedCrash = true;
                  throw new Error(`Simulated crash right after persisting phase=${entry.phase}`);
                }
              };

              const eng1 = createEngine(clientTransport(pds, joiner), {
                store: rawStore,
                operator: operatorService,
              });
              await eng1.workspaces.ensureInvitesSpace();

              let targetGroupDid: string;
              const opId = tidNow();

              if (mode === "create") {
                const wsName = `Crash Create ${crashAtPhase}`;
                const preGroup = await createOpenSocialGroup(pds, joiner, {
                  name: wsName,
                  joinPolicy: "open",
                  skipAcceptance: true,
                });
                targetGroupDid = preGroup.groupDid;
                grantCreationAuthorization(
                  { authorityDid: targetGroupDid, initiatorDid: joiner.did, name: wsName },
                  Math.floor(Date.now() / 1000),
                );
                await assert.rejects(
                  eng1.workspaces.createGroupWorkspace(
                    eng1.operator!,
                    { name: wsName, joinPolicy: "open", publicMeta: true },
                    { operationId: opId, groupDid: targetGroupDid },
                  ),
                  /Simulated crash/,
                );
              } else {
                const hostWs = await createFullFlockWorkspace(pds, alice, {
                  name: `Crash ${mode} ${crashAtPhase}`,
                  joinPolicy: mode,
                });
                targetGroupDid = hostWs.groupDid;
                let inviteUri: string | undefined;
                if (mode === "invite") {
                  const inv = await hostWs.groupClient.createInvite(joiner.did);
                  inviteUri = inv.uri;
                }

                if (mode === "approval" && crashAtPhase !== "submitting" && crashAtPhase !== "pending_approval") {
                  // First reach `pending_approval` without crashing, approve on host, THEN crash at `crashAtPhase`!
                  triggerCrashOnPhase = null;
                  const firstStep = await eng1.workspaces.joinGroup({
                    groupDid: targetGroupDid,
                    mode: "approval",
                    operationId: opId,
                  });
                  assert.equal(firstStep.status, "pending");
                  await hostWs.groupClient.approveJoinRequest(joiner.did);
                  triggerCrashOnPhase = crashAtPhase;
                  await eng1.workspaces.resumeJournals();
                  assert.equal(injectedCrash, true);
                } else {
                  await assert.rejects(
                    eng1.workspaces.joinGroup({
                      groupDid: targetGroupDid,
                      mode,
                      ...(inviteUri ? { inviteUri } : {}),
                      operationId: opId,
                    }),
                    /Simulated crash/,
                  );
                  if (mode === "approval") {
                    // Ensure request is submitted & approved before final recovery if crashed at `submitting` or `pending_approval`
                    triggerCrashOnPhase = null;
                    if (crashAtPhase === "submitting") {
                      await eng1.workspaces.resumeJournals();
                    }
                    await hostWs.groupClient.approveJoinRequest(joiner.did);
                  }
                }
              }

              assert.equal(injectedCrash, true, `Must have triggered crash at ${mode}:${crashAtPhase}`);
              assert.equal((await rawStore.getJoiningGroup(opId))?.phase, mode === "approval" && crashAtPhase === "submitting" ? "pending_approval" : crashAtPhase);

              // Disable crash hook, boot a fresh `Engine` over `rawStore`, and run `discover()` to recover to completion!
              triggerCrashOnPhase = null;
              const engRecovered = createEngine(clientTransport(pds, joiner), {
                store: rawStore,
                operator: operatorService,
              });
              const recoveredDiscovery = await engRecovered.workspaces.discover({ operator: engRecovered.operator });
              assert.ok(
                recoveredDiscovery.workspaces.some((w) => w.groupDid === targetGroupDid),
                `Recovered ${mode}:${crashAtPhase} must discover active workspace`,
              );
              assert.equal(await rawStore.getJoiningGroup(opId), undefined, "Completed join journal entry must be cleaned up");
            }
          }
        }
      },
    );

    // =========================================================================
    // 4. 3-Phase Crash-Safe `leavingGroups`, Human `LastAdmin`, `105`-JTI
    //    Revocation, 4-Phase `reactivatingGroups` & Account Deletion (`39` Tables)
    // =========================================================================
    await t.test(
      "4. 3-phase STAR-preserved leavingGroups, human LastAdmin, barrier races + 105-JTI revocation, 4-phase reactivatingGroups, and deleteAccount + 39-table zero-row verification",
      async () => {
        const assertZeroGroupPurgedTables = (db: RunningGroupHost["db"], groupDid: string) => {
          assert.equal(SCHEMA_TABLE_CLASSIFICATION.GROUP_PURGED_TABLES.length, 39, "Expected exact 39 GROUP_PURGED_TABLES");
          const ownSpaceLike = `at:space/${groupDid}/%`;
          const repoAndSpaceTables = new Set(["space_record", "space_oplog", "space_repo"]);
          const groupAndSpaceTables = new Set(["notify_registration", "space_record_blob", "space_writer"]);
          for (const table of SCHEMA_TABLE_CLASSIFICATION.GROUP_PURGED_TABLES) {
            let row: { cnt: number };
            if (table === "group_account") {
              row = db.prepare(`SELECT COUNT(*) AS cnt FROM ${table} WHERE did = ?`).get(groupDid) as { cnt: number };
            } else if (repoAndSpaceTables.has(table)) {
              row = db
                .prepare(`SELECT COUNT(*) AS cnt FROM ${table} WHERE repo_did = ? OR space_uri LIKE ?`)
                .get(groupDid, ownSpaceLike) as { cnt: number };
            } else if (groupAndSpaceTables.has(table)) {
              row = db
                .prepare(`SELECT COUNT(*) AS cnt FROM ${table} WHERE group_did = ? OR space_uri LIKE ?`)
                .get(groupDid, ownSpaceLike) as { cnt: number };
            } else {
              row = db.prepare(`SELECT COUNT(*) AS cnt FROM ${table} WHERE group_did = ?`).get(groupDid) as { cnt: number };
            }
            assert.equal(row.cnt, 0, `Table '${table}' must have 0 rows for purged group ${groupDid}`);
          }
        };

        const readOwnAcceptance = async (actor: NetworkActor, groupDid: string): Promise<Record<string, unknown> | null> => {
          const xrpc = sessionClient(bearerSession(actor) as never);
          try {
            const res = await xrpc.query<{ value: Record<string, unknown> }>("com.atproto.space.getRecord", {
              space: groupMembersUri(groupDid),
              repo: actor.did,
              collection: OPENSOCIAL_COLLECTION.acceptance,
              rkey: SELF_SKEY,
            });
            return res.value;
          } catch {
            return null;
          }
        };

        // 4a. 3-phase STAR-preserved `"new.flock.incarnation"` `leavingGroups`:
        //     - `LastAdmin` refusal preserving own-PDS `acceptance/self` untouched
        //     - Concurrent in-place role edit preserving incarnation so leave succeeds cleanly
        //     - Stale-device leave -> rejoin -> Flock-to-Flock migration -> replay against Target Host rejected via
        //       `MembershipIncarnationMismatch` BEFORE touching own-PDS `acceptance/self`!
        //     - Crash after own-PDS `deleteRecord` + cross-device rejoin restoring bilateral `acceptance/self` via `"reconciling_post_delete"`
        //     - `RepoNotFound` on stale cached PDS origin re-resolving PLC DID!
        {
          const alice = await nextActor("lvalice", 0);
          const bob = await nextActor("lvbob", 1);
          const carol = await nextActor("lvcarol", 1);

          const ws = await createFullFlockWorkspace(pds, alice, { name: "Leave Machine Team", joinPolicy: "open" });
          const aliceEngine = createEngine(clientTransport(pds, alice), { operator: operatorService });
          const bobEngine = createEngine(clientTransport(pds, bob), { operator: operatorService });
          await bobEngine.workspaces.joinGroup({ groupDid: ws.groupDid, mode: "open" });
          const carolEngine = createEngine(clientTransport(pds, carol), { operator: operatorService });
          await carolEngine.workspaces.joinGroup({ groupDid: ws.groupDid, mode: "open" });

          // (i) `LastAdmin` refusal when other human members exist: Alice's own-PDS `acceptance/self` MUST remain untouched!
          const aliceAccBefore = await readOwnAcceptance(alice, ws.groupDid);
          assert.ok(aliceAccBefore, "Alice has acceptance/self before attempted leave");
          const lastAdminErr = await captureXrpcError(() => aliceEngine.workspaces.leaveGroup(ws.groupDid));
          assert.equal(lastAdminErr.code, "LastAdmin");
          const aliceAccAfterRefusal = await readOwnAcceptance(alice, ws.groupDid);
          assert.deepEqual(aliceAccAfterRefusal, aliceAccBefore, "LastAdmin refusal must NOT delete own-PDS acceptance/self");

          // (ii) Concurrent in-place role edit (`["member"]` -> `["member", "moderator"]`) preserves incarnation -> leave succeeds!
          const carolStore = new MemoryStore();
          const carolEngInPlace = createEngine(clientTransport(pds, carol), {
            store: carolStore,
            operator: operatorService,
          });
          const carolMemBeforeEdit = await ws.groupClient.getMembership(carol.did);
          assert.ok(carolMemBeforeEdit?.incarnation);
          await carolStore.putLeavingGroup({
            groupDid: ws.groupDid,
            expectedIncarnation: carolMemBeforeEdit.incarnation,
            phase: "leaving_group",
            createdAt: Date.now(),
          });
          // Edit Carol's roles in place before Carol's leave executes
          await ws.groupClient.putMembership(carol.did, ["member", "moderator"]);
          const carolMemAfterEdit = await ws.groupClient.getMembership(carol.did);
          assert.equal(carolMemAfterEdit?.incarnation, carolMemBeforeEdit.incarnation, "In-place role edit preserves incarnation");
          await carolEngInPlace.workspaces.leaveGroup(ws.groupDid);
          assert.equal(await ws.groupClient.getMembership(carol.did), null);
          assert.equal(await readOwnAcceptance(carol, ws.groupDid), null);

          // (iii) Stale-device leave -> rejoin -> Flock-to-Flock migration -> replay against Target Host rejected via
          //       `MembershipIncarnationMismatch` BEFORE touching own-PDS `acceptance/self`!
          const ghLeaveTarget = await pds.startExtraGroupHost();
          try {
            const bobMem1 = await ws.groupClient.getMembership(bob.did);
            assert.ok(bobMem1?.incarnation);

            // Stale Device 1 persists `leaving_group` with `inc1` while offline
            const staleDeviceStore = new MemoryStore();
            await staleDeviceStore.putLeavingGroup({
              groupDid: ws.groupDid,
              expectedIncarnation: bobMem1.incarnation,
              phase: "leaving_group",
              createdAt: Date.now(),
            });

            // Device 2: Bob leaves and rejoins (`inc2 !== inc1`)
            await bobEngine.workspaces.leaveGroup(ws.groupDid);
            await bobEngine.workspaces.joinGroup({ groupDid: ws.groupDid, mode: "open" });
            const bobMem2 = await ws.groupClient.getMembership(bob.did);
            assert.ok(bobMem2?.incarnation && bobMem2.incarnation !== bobMem1.incarnation);
            const bobAcc2 = await readOwnAcceptance(bob, ws.groupDid);
            assert.equal(bobAcc2?.["new.flock.incarnation"], bobMem2.incarnation);

            // Migrate group from `pds.groupHost` -> `ghLeaveTarget` (STAR preserves `bobMem2.incarnation` on Target Host!)
            const stepUpLeaveMigClient = await stepUpRealGroupClient(pds.groupHost, alice, ws.groupDid);
            await stepUpLeaveMigClient.migrateToHost(ghLeaveTarget.url, {
              handle: `leave-mig.${ghLeaveTarget.config.handleDomain}`,
              useCoordinated: true,
            });
            await drainGroupHost(ghLeaveTarget);

            // Stale Device 1 comes back online and replays `leaveGroup` against Target Host!
            let ownDeleteAttempted = false;
            const staleDeviceEngine = createEngine(
              clientTransport(pds, bob, {
                fetchVia: async (req) => {
                  if (req.url.includes("com.atproto.space.deleteRecord")) ownDeleteAttempted = true;
                  return fetch(req);
                },
              }),
              { store: staleDeviceStore, operator: operatorService },
            );
            const staleReplayErr = await captureXrpcError(() => staleDeviceEngine.workspaces.leaveGroup(ws.groupDid));
            assert.equal(staleReplayErr.status, 409);
            assert.equal(staleReplayErr.code, "MembershipIncarnationMismatch");
            assert.equal(ownDeleteAttempted, false, "Incarnation mismatch MUST abort before touching own-PDS acceptance/self");
            assert.deepEqual(await readOwnAcceptance(bob, ws.groupDid), bobAcc2);

            // (iv) Crash after own-PDS `deleteRecord(acceptance/self)` (`phase = "reconciling_post_delete"`) + cross-device rejoin
            //      restoring bilateral `acceptance/self`!
            const carolRejoinEng = createEngine(clientTransport(pds, carol), { operator: operatorService });
            await carolRejoinEng.workspaces.joinGroup({ groupDid: ws.groupDid, mode: "open" });
            const carolStatus1 = await carolRejoinEng.workspaces.getJoinStatus(ws.groupDid);
            assert.ok(carolStatus1.currentIncarnation);

            // Crash Carol's leave right when persisting `reconciling_post_delete` (AFTER own-PDS `acceptance/self` was deleted!)
            const crashLeaveStore = new MemoryStore();
            const origPutLeave = crashLeaveStore.putLeavingGroup.bind(crashLeaveStore);
            let crashOnReconcile = true;
            crashLeaveStore.putLeavingGroup = async (entry) => {
              await origPutLeave(entry);
              if (crashOnReconcile && entry.phase === "reconciling_post_delete") {
                throw new Error("Simulated crash after own-PDS deleteRecord");
              }
            };
            const carolCrashLeaveEng = createEngine(clientTransport(pds, carol), {
              store: crashLeaveStore,
              operator: operatorService,
            });
            await assert.rejects(carolCrashLeaveEng.workspaces.leaveGroup(ws.groupDid), /Simulated crash after own-PDS deleteRecord/);
            assert.equal(await readOwnAcceptance(carol, ws.groupDid), null, "Own-PDS acceptance/self was deleted in Phase 2");

            // Meanwhile on another device (or via admin/open join), Carol rejoins on `ghLeaveTarget` (`inc_new !== carolStatus1.currentIncarnation`),
            // and we simulate own-PDS not yet having the restored acceptance (or stale device overwriting it before reconciling):
            await personalGroupCall({
              hostUrl: ghLeaveTarget.url,
              actor: carol,
              groupDid: ws.groupDid,
              path: OPENSOCIAL_METHOD.requestJoin,
              httpMethod: "POST",
              lxm: OPENSOCIAL_METHOD.requestJoin,
              body: { group: ws.groupDid },
            });
            const carolStatusNew = await carolRejoinEng.workspaces.getJoinStatus(ws.groupDid);
            assert.ok(
              carolStatusNew.state === "admitted" &&
                carolStatusNew.currentIncarnation &&
                carolStatusNew.currentIncarnation !== carolStatus1.currentIncarnation,
            );

            // Resume crashed `"reconciling_post_delete"` -> detects new incarnation on Group Host and restores bilateral `acceptance/self`!
            crashOnReconcile = false;
            const carolResumeEng = createEngine(clientTransport(pds, carol), {
              store: crashLeaveStore,
              operator: operatorService,
            });
            await carolResumeEng.workspaces.discover();
            const restoredAcc = await readOwnAcceptance(carol, ws.groupDid);
            assert.equal(
              restoredAcc?.["new.flock.incarnation"],
              carolStatusNew.currentIncarnation,
              "reconciling_post_delete must restore bilateral acceptance/self when re-admitted with a newer incarnation",
            );

            // (v) `RepoNotFound` on stale cached PDS origin re-resolving PLC DID and completing `leaveGroup`!
            const staleCacheActor = await nextActor("lvstalepds", 1);
            const ws2 = await createFullFlockWorkspace(pds, alice, { name: "Stale PDS Leave Group", joinPolicy: "open" });
            const staleCacheTransport = clientTransport(pds, staleCacheActor);
            const staleCacheEng = createEngine(staleCacheTransport, { operator: operatorService });
            await staleCacheEng.workspaces.joinGroup({ groupDid: ws2.groupDid, mode: "open" });

            // Prime `staleCacheEng`'s identity cache with `pds.groupHostUrl`, then migrate `ws2` to `ghLeaveTarget` AND purge `ws2` row
            // from `pds.groupHost` (or `RepoNotFound` on an unhosted endpoint) so first attempt gets `RepoNotFound`!
            const stepUpWs2Client = await stepUpRealGroupClient(pds.groupHost, alice, ws2.groupDid);
            await stepUpWs2Client.migrateToHost(ghLeaveTarget.url, {
              handle: `stale-pds-lv.${ghLeaveTarget.config.handleDomain}`,
              useCoordinated: true,
            });
            await drainGroupHost(ghLeaveTarget);
            pds.groupHost.db.prepare("DELETE FROM group_account WHERE did = ?").run(ws2.groupDid);

            await staleCacheEng.workspaces.leaveGroup(ws2.groupDid);
            const postLeaveStatus = await staleCacheEng.workspaces.getJoinStatus(ws2.groupDid);
            assert.equal(postLeaveStatus.state, "unknown");
            assert.equal(await readOwnAcceptance(staleCacheActor, ws2.groupDid), null);
          } finally {
            await ghLeaveTarget.close();
          }
        }

        // 4b. Human `LastAdmin` (`known_app_subject` across active & uninstalled bots): bots NEVER count as human admins!
        {
          const alice = await nextActor("laalice", 0);
          const member = await nextActor("lamem", 1);
          const bot = await nextActor("labot", 1);
          const ws = await createFullFlockWorkspace(pds, alice, { name: "Human LastAdmin Team", joinPolicy: "open" });
          await ws.groupClient.putMembership(member.did, ["member"]);

          const adminEng = createEngine(clientTransport(pds, alice), { operator: operatorService });
          await adminEng.operator!.execute({
            workspace: ws.workspace,
            operationId: tidNow(),
            request: { kind: "installApp", subject: bot.did, channels: [{ skey: ws.channelSkey, write: true }] },
          });

          // Give the bot's `app-*` role full admin scopes so even if scopes were inspected, `known_app_subject` excludes bots from human `LastAdmin`!
          const botRoles = (await ws.groupClient.listRoles()).filter((r) => r.rkey.startsWith("app-"));
          assert.equal(botRoles.length, 1);
          await ws.groupClient.putRole(botRoles[0]!.rkey, {
            displayName: "Admin-Scoped Bot Role",
            scopes: groupAdminScopes(ws.groupDid).filter((s) => s !== "atproto"),
            assignable: ["admin", "member"],
          });

          // Attempting to demote sole human admin `alice` while bot holds admin-scoped role MUST still fail with `LastAdmin`!
          const demoteWithActiveBot = await captureXrpcError(() => ws.groupClient.putMembership(alice.did, ["member"]));
          assert.equal(demoteWithActiveBot.code, "LastAdmin");

          // Uninstall bot (leaving `known_app_subject` + `app.install` `active: false` tombstone) -> still `LastAdmin`!
          await adminEng.operator!.execute({
            workspace: ws.workspace,
            operationId: tidNow(),
            request: { kind: "uninstallApp", subject: bot.did },
          });
          const demoteWithUninstalledBot = await captureXrpcError(() => ws.groupClient.putMembership(alice.did, ["member"]));
          assert.equal(demoteWithUninstalledBot.code, "LastAdmin");
        }

        // 4c. Barrier/Race Checks on `authorizeSpaceSync`, `notifyRepoUpdate` (+ `StalePreEjectionRepo`),
        //     & `deactivateAccount` Admin-Demotion TOCTOU + `105`-JTI `notifyCredentialsRevoked` Batching (`100` + `5`)!
        {
          const alice = await nextActor("baralice", 0);
          const bob = await nextActor("barbob", 1);
          const carol = await nextActor("barcarol", 0);

          // (i) `authorizeSpaceSync` concurrent demotion during `confirmRegistration` webhook -> final `IMMEDIATE` recheck refuses (`403`)!
          let onConfirmInFlight: (() => Promise<void>) | null = null;
          const ghRace = await pds.startExtraGroupHost({
            fetchImpl: async (input, init) => {
              const url = input instanceof Request ? input.url : String(input);
              if (onConfirmInFlight && url.includes("/xrpc/com.atproto.space.confirmRegistration")) {
                const hook = onConfirmInFlight;
                onConfirmInFlight = null;
                await hook();
              }
              return fetch(input, init);
            },
          });

          const webhookApp = express();
          webhookApp.use(express.json());
          webhookApp.post("/xrpc/com.atproto.space.confirmRegistration", (req, res) => {
            res.json({ challenge: (req.body as { challenge: string }).challenge });
          });
          const webhookSrv = await listenHttp(webhookApp);

          try {
            const flow = await completeRealGroupOAuthFlow({
              groupHost: ghRace,
              actor: alice,
              scope: groupAdminScopes().join(" "),
              prompt: "create",
              createParams: { displayName: "Barrier Race Group", joinPolicy: "open", publicMeta: true },
            });
            const gDid = flow.tokenResponse!.sub;
            const gClient = makeGroupClient(ghRace, gDid, flow.dpop, flow.tokenResponse!.access_token);
            const chanSpace = channelUri(gDid, "race-chan");
            await gClient.xrpc.procedure("com.atproto.space.createSpace", {
              spaceType: SPACE_TYPE.channel,
              skey: "race-chan",
              policy: {
                $type: OPENSOCIAL_POLICY,
                publicRead: false,
                unlisted: false,
                grants: [
                  { role: "admin", read: true, write: true },
                  { role: "member", read: true, write: true },
                ],
              },
            });
            await gClient.putMembership(bob.did, ["member"]);

            // Mint a delegation token for Bob while Bob is an active member, then eject Bob WHILE `confirmRegistration` is in flight!
            const bobDeps = actorTransport(pds, bob);
            onConfirmInFlight = async () => {
              await gClient.deleteMembership(bob.did);
            };
            await assert.rejects(
              mintSpaceCredentialWith(bobDeps, chanSpace, {
                notify: { endpoint: webhookSrv.url, token: "race-tok-1" },
              }),
              (err: unknown) => isAccessLost(err) || (err instanceof Error && /403|Forbidden|NotAuthorized/i.test(err.message)),
              "Ejecting member during confirmRegistration must abort authorizeSpaceSync in final IMMEDIATE check",
            );

            // (ii) `notifyRepoUpdate` race (`locks.withGroupRepoLock`) + `StalePreEjectionRepo` (`409`)!
            await gClient.putMembership(bob.did, ["member"]);
            const bobCred = await mintSpaceCredentialWith(bobDeps, chanSpace);
            const bobPersonalXrpc = sessionClient(bearerSession(bob) as never);
            await bobPersonalXrpc.procedure("com.atproto.space.putRecord", {
              space: groupMembersUri(gDid),
              repo: bob.did,
              collection: OPENSOCIAL_COLLECTION.acceptance,
              rkey: SELF_SKEY,
              record: { $type: OPENSOCIAL_COLLECTION.acceptance, createdAt: new Date().toISOString() },
            });
            await bobPersonalXrpc.procedure("com.atproto.space.putRecord", {
              space: chanSpace,
              repo: bob.did,
              collection: COLLECTION.message,
              rkey: tidNow(),
              record: { $type: COLLECTION.message, text: "pre-eject write", createdAt: new Date().toISOString() },
            });
            await drainGroupHost(ghRace);
            void bobCred;

            const preEjectMembersWriterRow = ghRace.db
              .prepare("SELECT repo_rev FROM space_writer WHERE space_uri = ? AND writer_did = ?")
              .get(groupMembersUri(gDid), bob.did) as { repo_rev: string };
            assert.ok(preEjectMembersWriterRow?.repo_rev);

            // Hold `withGroupRepoLock`, queue Bob's ejection AND a concurrent `notifyRepoUpdate` from Bob!
            const bobNotifyJwt = await mintPersonalServiceJwt(bob, `${gDid}#atproto_pds`, "com.atproto.space.notifyRepoUpdate");
            let releaseRepoLock!: () => void;
            const repoLockHeld = new Promise<void>((ready) => {
              void ghRace.locks.withGroupRepoLock(gDid, async () => {
                ready();
                await new Promise<void>((r) => {
                  releaseRepoLock = r;
                });
              });
            });
            await repoLockHeld;

            const ejectBobPromise = gClient.deleteMembership(bob.did);
            // Let DPoP nonce preflight settle so `deleteMembership` is queued on `withGroupRepoLock` ahead of `notifyRepoUpdate`
            // while `releaseRepoLock` still holds the lock!
            await new Promise((r) => setTimeout(r, 40));
            const concurrentNotifyPromise = fetch(`${ghRace.url}/xrpc/com.atproto.space.notifyRepoUpdate`, {
              method: "POST",
              headers: { authorization: `Bearer ${bobNotifyJwt}`, "content-type": "application/json" },
              body: JSON.stringify({
                space: chanSpace,
                repo: bob.did,
                repoRev: tidNow(Date.now() + 5_000),
                data: { $bytes: Buffer.alloc(32).toString("base64") },
              }),
            });
            releaseRepoLock();
            const [, notifyAfterEjectRes] = await Promise.all([ejectBobPromise, concurrentNotifyPromise]);
            assert.equal(notifyAfterEjectRes.status, 403, "notifyRepoUpdate serialized after ejection must be refused with 403");

            // Re-admit Bob (`prior_eject_count` bumped, `afterWriterRev = preEjectMembersWriterRow.repo_rev` on `members/self`) ->
            // replaying stale `repoRev <= afterWriterRev` on `members/self` MUST fail with `409 StalePreEjectionRepo`!
            await gClient.putMembership(bob.did, ["member"]);
            const bobNotifyJwt2 = await mintPersonalServiceJwt(bob, `${gDid}#atproto_pds`, "com.atproto.space.notifyRepoUpdate");
            const staleRepoRevRes = await fetch(`${ghRace.url}/xrpc/com.atproto.space.notifyRepoUpdate`, {
              method: "POST",
              headers: { authorization: `Bearer ${bobNotifyJwt2}`, "content-type": "application/json" },
              body: JSON.stringify({
                space: groupMembersUri(gDid),
                repo: bob.did,
                repoRev: preEjectMembersWriterRow.repo_rev,
                data: { $bytes: Buffer.alloc(32).toString("base64") },
              }),
            });
            assert.equal(staleRepoRevRes.status, 409);
            assert.equal(((await staleRepoRevRes.json()) as { error: string }).error, "StalePreEjectionRepo");

            // (iii) `deactivateAccount` admin-demotion TOCTOU (`403`) + `MigrationInProgress` (`409`)!
            await gClient.putMembership(carol.did, ["member", "admin"]);
            const carolFlow = await completeRealGroupOAuthFlow({
              groupHost: ghRace,
              actor: carol,
              scope: groupAdminScopes().join(" "),
              loginHint: gDid,
            });
            const carolGClient = makeGroupClient(ghRace, gDid, carolFlow.dpop, carolFlow.tokenResponse!.access_token);

            // Hold lock, queue Alice demoting Carol + Carol calling `deactivateAccount` -> Carol's `deactivateAccount` gets `403`!
            let releaseDeactLock!: () => void;
            const deactLockHeld = new Promise<void>((ready) => {
              void ghRace.locks.withGroupRepoLock(gDid, async () => {
                ready();
                await new Promise<void>((r) => {
                  releaseDeactLock = r;
                });
              });
            });
            await deactLockHeld;

            const demoteCarolP = gClient.putMembership(carol.did, ["member"]);
            // Let `putMembership`'s preflight `getRecord` complete so `putRecord` queues on `withGroupRepoLock` first while held!
            await new Promise((r) => setTimeout(r, 40));
            const carolDeactP = captureXrpcError(() => carolGClient.deactivateAccount());
            releaseDeactLock();
            const [, carolDeactErr] = await Promise.all([demoteCarolP, carolDeactP]);
            assert.equal(carolDeactErr.status, 403);

            // Active migration lease blocks `deactivateAccount` with `409 MigrationInProgress`!
            const stepUpRaceClient = await stepUpRealGroupClient(ghRace, alice, gDid);
            await stepUpRaceClient.prepareMigration(pds.groupHostUrl, `prep-${randomUUID()}`);
            const deactDuringMigErr = await captureXrpcError(() => stepUpRaceClient.deactivateAccount());
            assert.equal(deactDuringMigErr.status, 409);
            assert.equal(deactDuringMigErr.code, "MigrationInProgress");
            await stepUpRaceClient.abortMigration();
          } finally {
            await webhookSrv.close();
            await ghRace.close();
          }

          // (iv) `105`-JTI `notifyCredentialsRevoked` batching (`100` + `5` chunks) across ALL 3 triggers:
          //      `deactivateAccount`, sole-member `leaveGroup`, and `deleteAccount`!
          for (const trigger of ["deactivateAccount", "soleMemberLeave", "deleteAccount"] as const) {
            const revBatches: number[] = [];
            const ghBatch = await pds.startExtraGroupHost({
              fetchImpl: async (input, init) => {
                const url = input instanceof Request ? input.url : String(input);
                if (url.includes("/xrpc/com.atproto.space.notifyCredentialsRevoked") && init?.body) {
                  const parsed = JSON.parse(String(init.body)) as {
                    space: string;
                    credentials: string[];
                    jtis?: unknown;
                  };
                  assert.equal(parsed.jtis, undefined, "notifyCredentialsRevoked payload must serialize credentials, not jtis");
                  assert.ok(
                    Array.isArray(parsed.credentials) && parsed.credentials.length >= 1 && parsed.credentials.length <= 100,
                    `notifyCredentialsRevoked credentials must be 1..100 items, got ${JSON.stringify(parsed)}`,
                  );
                  revBatches.push(parsed.credentials.length);
                }
                return fetch(input, init);
              },
            });
            try {
              const owner = await nextActor(`jti${trigger.slice(0, 4)}`, 0);
              const flow = await completeRealGroupOAuthFlow({
                groupHost: ghBatch,
                actor: owner,
                scope: groupAdminScopes().join(" "),
                prompt: "create",
                createParams: { displayName: `Batch 105 ${trigger}`, joinPolicy: "invite", publicMeta: true },
              });
              const gDid = flow.tokenResponse!.sub;
              const gClient = makeGroupClient(ghBatch, gDid, flow.dpop, flow.tokenResponse!.access_token);
              const ownerDeps = actorTransport(pds, owner);

              // Create `workspace/self` so `soleMemberLeave` exercises Flock sole-member reversible deactivation!
              await gClient.xrpc.procedure("com.atproto.space.createSpace", {
                spaceType: SPACE_TYPE.workspace,
                skey: SELF_SKEY,
                policy: {
                  $type: OPENSOCIAL_POLICY,
                  publicRead: false,
                  unlisted: false,
                  grants: [
                    { role: "admin", read: true, write: true },
                    { role: "member", read: true },
                  ],
                },
              });

              // Mint 105 distinct unexpired credentials on `members/self`!
              for (let i = 0; i < 105; i += 1) {
                await mintSpaceCredentialWith(ownerDeps, groupMembersUri(gDid));
              }

              if (trigger === "deactivateAccount") {
                await gClient.deactivateAccount();
                await drainGroupHost(ghBatch);
              } else if (trigger === "soleMemberLeave") {
                const soleLeaveRes = await personalGroupCall({
                  hostUrl: ghBatch.url,
                  actor: owner,
                  groupDid: gDid,
                  path: OPENSOCIAL_METHOD.leaveGroup,
                  httpMethod: "POST",
                  lxm: OPENSOCIAL_METHOD.leaveGroup,
                  body: { group: gDid },
                });
                assert.equal(soleLeaveRes.status, 200);
                await drainGroupHost(ghBatch);
              } else {
                const stepUpDelClient = await stepUpRealGroupClient(ghBatch, owner, gDid);
                await stepUpDelClient.requestAccountDelete();
                const { token } = await stepUpDelClient.claimActionToken("delete_account");
                await stepUpDelClient.deleteAccount(token);
              }

              assert.deepEqual(
                revBatches.sort((a, b) => b - a),
                [100, 5],
                `Trigger '${trigger}' must batch 105 revoked JTIs into [100, 5] chunks`,
              );
            } finally {
              await ghBatch.close();
            }
          }
        }

        // 4d. End-to-End 4-Phase `reactivatingGroups` Recovery Across All 4 Phases -> Admin Transfer -> Original Admin Leaves!
        {
          const alice = await nextActor("reactalice", 0);
          const successor = await nextActor("reactsucc", 1);

          // Test crash recovery across all 4 `reactivatingGroups` phases:
          // `activating` -> `restoring_acceptance` -> `reauthorizing_operator` -> `refreshing_discovery`!
          for (const crashPhase of [
            "activating",
            "restoring_acceptance",
            "reauthorizing_operator",
            "refreshing_discovery",
          ] as const) {
            const ws = await createFullFlockWorkspace(pds, alice, {
              name: `Reactivate ${crashPhase}`,
              joinPolicy: "open",
            });
            const store = new MemoryStore();
            const eng1 = createEngine(clientTransport(pds, alice), { store, operator: operatorService });

            // Sole member Alice leaves -> group enters reversible deactivation (`activated = 0`, `left_deactivated`)
            await eng1.workspaces.leaveGroup(ws.groupDid);
            const statusDeact = await eng1.workspaces.getJoinStatus(ws.groupDid);
            assert.equal(statusDeact.state, "left_deactivated");
            assert.equal(await readOwnAcceptance(alice, ws.groupDid), null);

            const makeRecoveryHooks = () => ({
              getGroupClient: async (gDid: string) => {
                const recFlow = await completeRealGroupOAuthFlow({
                  groupHost: pds.groupHost,
                  actor: alice,
                  scope: groupAdminScopes(gDid).join(" "),
                  prompt: "login",
                  loginHint: gDid,
                });
                return makeGroupClient(pds.groupHost, gDid, recFlow.dpop, recFlow.tokenResponse!.access_token);
              },
              reauthorizeOperator: async (gDid: string) => {
                await storeGroupAuthorityGrant(pds, alice, gDid, `reauth-${crashPhase}-${randomUUID().slice(0, 6)}`);
              },
            });

            const origPutReact = store.putReactivatingGroup.bind(store);
            let failAtPhase: string | null = crashPhase;
            let hitPhase = false;
            store.putReactivatingGroup = async (entry) => {
              await origPutReact(entry);
              if (failAtPhase !== null && entry.phase === failAtPhase) {
                hitPhase = true;
                throw new Error(`Simulated reactivation crash at ${entry.phase}`);
              }
            };

            const opId = tidNow();
            await assert.rejects(
              eng1.workspaces.reactivateGroup(ws.groupDid, { ...makeRecoveryHooks(), operationId: opId }),
              /Simulated reactivation crash/,
            );
            assert.equal(hitPhase, true);
            assert.equal((await store.getReactivatingGroup(opId))?.phase, crashPhase);

            // Resume via fresh `Engine.workspaces.discover(hooks)`!
            failAtPhase = null;
            const eng2 = createEngine(clientTransport(pds, alice), {
              store,
              operator: operatorService,
              ...makeRecoveryHooks(),
            });
            const disc = await eng2.workspaces.discover(makeRecoveryHooks());
            assert.ok(disc.workspaces.some((w) => w.groupDid === ws.groupDid), `Reactivation recovered from ${crashPhase}`);
            assert.equal(await store.getReactivatingGroup(opId), undefined);

            // On the final phase iteration, also complete admin transfer to `successor` and verify `alice` leaves cleanly!
            if (crashPhase === "refreshing_discovery") {
              const succEng = createEngine(clientTransport(pds, successor), { operator: operatorService });
              await succEng.workspaces.joinGroup({ groupDid: ws.groupDid, mode: "open" });
              const promoteOp = await eng2.operator!.execute({
                workspace: ws.workspace,
                operationId: tidNow(),
                request: { kind: "setAdmin", subject: successor.did, active: true },
              });
              assert.equal(promoteOp.operation.state, "completed");
              await storeGroupAuthorityGrant(pds, successor, ws.groupDid, "succ-admin-grant");

              await eng2.workspaces.leaveGroup(ws.groupDid);
              const succSummary = await succEng.workspaces.requireSummary(ws.workspace);
              assert.deepEqual(succSummary.admins, [successor.did]);
              assert.equal(succSummary.members.some((m) => m.did === alice.did), false);
            }
          }
        }

        // 4e. Black-Box `requestAccountDelete` -> `claim-action-token` -> `deleteAccount`:
        //     (i) Active admin deletion + pre-tombstone remote drain (`#spaceDeleted`, `notifyCredentialsRevoked`, cleared-commit `notifyRepoUpdate`)
        //         + delayed downstream consumer wake & delayed `getRepo` AFTER `plc_tombstoned` -> `purged` proving tombstone-aware invite pruning
        //         + `39`-table zero-row verification!
        //     (ii) Direct deletion from `recovery` session immediately after sole-member `leaveGroup` + `39`-table zero-row verification!
        //     (iii) PLC HTTP `409` automatic re-signing vs non-`409` `4xx` immediate `502 PlcTombstoneRejected` termination +
        //           corrupt/missing `rotation_key_enc` -> `authority_lost_local_purge`!
        {
          const alice = await nextActor("delalice", 0);
          const invitee = await nextActor("delinv", 1);

          // (i) Active admin deletion + delayed consumer tombstone invite pruning!
          let blockInviteClearToInvitee = false;
          const syncerEvents: Array<{ space: string; type: string; plcStatusDuringDrain: number }> = [];
          const webhookApp = express();
          webhookApp.use(express.json());
          webhookApp.post("/xrpc/com.atproto.space.confirmRegistration", (req, res) => {
            res.json({ challenge: (req.body as { challenge: string }).challenge });
          });

          const ghDel = await pds.startExtraGroupHost({
            fetchImpl: async (input, init) => {
              const url = input instanceof Request ? input.url : String(input);
              if (
                blockInviteClearToInvitee &&
                url.startsWith(invitee.pds.url) &&
                url.includes("/xrpc/com.atproto.space.notifyRepoUpdate")
              ) {
                // Simulate delayed / unreachable invitee PDS during deletion so invitee still holds stale writer pointer + cache!
                return Response.json({ error: "BadRequest", message: "invitee offline during delete" }, { status: 400 });
              }
              return fetch(input, init);
            },
          });

          let activeDelGroupDid = "";
          webhookApp.post("/xrpc/com.atproto.space.notifySpaceUpdate", async (req, res) => {
            const body = req.body as { space: string; update: { $type: string } };
            const plcProbe = activeDelGroupDid
              ? (await fetch(`${pds.network.plc.url}/${encodeURIComponent(activeDelGroupDid)}`)).status
              : 0;
            syncerEvents.push({ space: body.space, type: body.update.$type, plcStatusDuringDrain: plcProbe });
            res.status(200).end();
          });
          const webhookSrv = await listenHttp(webhookApp);

          try {
            const flow = await completeRealGroupOAuthFlow({
              groupHost: ghDel,
              actor: alice,
              scope: groupAdminScopes().join(" "),
              prompt: "create",
              createParams: { displayName: "Delete Active Group", joinPolicy: "invite", publicMeta: true },
            });
            activeDelGroupDid = flow.tokenResponse!.sub;
            const gClient = makeGroupClient(ghDel, activeDelGroupDid, flow.dpop, flow.tokenResponse!.access_token);

            // Register syncer webhook on `meta/self` and issue delegation credential
            await mintSpaceCredentialWith(actorTransport(pds, alice), groupMetaUri(activeDelGroupDid), {
              notify: { endpoint: webhookSrv.url, token: "del-syncer-tok" },
            });

            // Deliver cross-PDS invite to `invitee` AND populate `invitee`'s `WorkspaceClient` cache BEFORE deletion!
            const delayedInviteeStore = new MemoryStore();
            const delayedInviteeEng = createEngine(clientTransport(pds, invitee), {
              store: delayedInviteeStore,
              operator: operatorService,
            });
            await delayedInviteeEng.workspaces.ensureInvitesSpace();
            const sentInvite = await gClient.createInvite(invitee.did);
            await drainGroupHost(ghDel);

            const cachedBeforeDelete = await delayedInviteeEng.workspaces.listInvites();
            assert.equal(cachedBeforeDelete.length, 1);
            assert.equal(cachedBeforeDelete[0]?.uri, sentInvite.uri);

            // Also send an invite to a SECOND invitee (`liveCleanInvitee`) whose PDS stays online during `deleteAccount`
            // so we ALSO verify pre-tombstone cleared-commit `notifyRepoUpdate` delivery while PLC DID is `200`!
            const liveCleanInvitee = await nextActor("delliveinv", 0);
            const liveCleanEng = createEngine(clientTransport(pds, liveCleanInvitee), { operator: operatorService });
            await liveCleanEng.workspaces.ensureInvitesSpace();
            await gClient.createInvite(liveCleanInvitee.did);
            await drainGroupHost(ghDel);
            assert.equal((await liveCleanEng.workspaces.listInvites()).length, 1);

            // Block `notifyRepoUpdate` ONLY to `invitee.pds.url` (`pds.hosts[1]`) during `deleteAccount` so `invitee` wakes up
            // AFTER `plc_tombstoned` -> `purged` (while `invitee.pds` STILL lists `activeDelGroupDid` as a writer!), whereas
            // `liveCleanInvitee` (`pds.hosts[0]`) receives the pre-tombstone cleared commit while PLC is live (`200`)!
            blockInviteClearToInvitee = true;
            const stepUpActiveDelClient = await stepUpRealGroupClient(ghDel, alice, activeDelGroupDid);
            await stepUpActiveDelClient.requestAccountDelete();
            const { token: delTok } = await stepUpActiveDelClient.claimActionToken("delete_account");
            await stepUpActiveDelClient.deleteAccount(delTok);
            blockInviteClearToInvitee = false;

            // Verify `#spaceDeleted` drained WHILE PLC DID was still live (`plcStatusDuringDrain === 200`)!
            const spaceDeletedNotice = syncerEvents.find((e) => e.type.endsWith("#spaceDeleted"));
            assert.ok(spaceDeletedNotice, "deleteAccount must emit #spaceDeleted to registered syncers");
            assert.equal(
              spaceDeletedNotice.plcStatusDuringDrain,
              200,
              "#spaceDeleted must drain BEFORE PLC DID is tombstoned",
            );

            // Verify PLC DID is now tombstoned (`404`) AND delayed consumer (`delayedInviteeEng` with cached invite in `delayedInviteeStore` +
            // `readIndependentInvites` waking up AFTER `plc_tombstoned` -> `purged` when `getRepo` returns `RepoNotFound` and PLC returns `404`)
            // prunes the stale invite cleanly to `[]`!
            const plcAfterDel = await fetch(`${pds.network.plc.url}/${encodeURIComponent(activeDelGroupDid)}`);
            assert.equal(plcAfterDel.status, 404);
            const invCred = await mintSpaceCredentialWith(actorTransport(pds, invitee), personalInvitesUri(invitee.did));
            const { headers: spaceSigHeaders } = await createSpaceSigHeaders({
              authorization: `Atproto-Space-Credential ${invCred.token}`,
              audience: activeDelGroupDid as `did:${string}:${string}`,
              keypair: invCred.key,
            });
            const delayedGetRepo = await fetch(
              `${ghDel.url}/xrpc/com.atproto.space.getRepo?space=${encodeURIComponent(personalInvitesUri(invitee.did))}&repo=${encodeURIComponent(activeDelGroupDid)}`,
              { headers: spaceSigHeaders },
            );
            assert.equal(delayedGetRepo.status, 400);
            assert.equal(((await delayedGetRepo.json()) as { error: string }).error, "RepoNotFound");

            assert.deepEqual(
              await delayedInviteeEng.workspaces.listInvites(),
              [],
              "Delayed WorkspaceClient waking after plc_tombstoned -> purged must prune stale cached invites",
            );
            assert.deepEqual(
              await readIndependentInvites(actorTransport(pds, invitee), invitee.did),
              [],
              "Delayed IndependentReader waking after plc_tombstoned -> purged must prune stale invites",
            );
            assert.deepEqual(await liveCleanEng.workspaces.listInvites(), []);

            // Scan ALL `39` `GROUP_PURGED_TABLES` -> exact `0` rows!
            assertZeroGroupPurgedTables(ghDel.db, activeDelGroupDid);
            const delJournal = ghDel.db
              .prepare("SELECT status, plc_outcome FROM group_deletion_journal WHERE group_did = ?")
              .get(activeDelGroupDid) as { status: string; plc_outcome: string };
            assert.deepEqual(delJournal, { status: "purged", plc_outcome: "tombstoned" });
          } finally {
            await webhookSrv.close();
            await ghDel.close();
          }

          // (ii) Direct black-box `requestAccountDelete` -> `claim-action-token` -> `deleteAccount` from `recovery` session
          //      IMMEDIATELY after sole-member `leaveGroup`!
          {
            const soleOwner = await nextActor("delsole", 0);
            const wsSole = await createFullFlockWorkspace(pds, soleOwner, { name: "Delete From Recovery Group" });
            const soleEng = createEngine(clientTransport(pds, soleOwner), { operator: operatorService });
            await soleEng.workspaces.leaveGroup(wsSole.groupDid);

            const recFlow = await completeRealGroupOAuthFlow({
              groupHost: pds.groupHost,
              actor: soleOwner,
              scope: groupAdminScopes(wsSole.groupDid).join(" "),
              prompt: "login",
              loginHint: wsSole.groupDid,
            });
            const recGroupClient = makeGroupClient(
              pds.groupHost,
              wsSole.groupDid,
              recFlow.dpop,
              recFlow.tokenResponse!.access_token,
            );
            assert.equal((await recGroupClient.checkAccountStatus()).activated, false);

            await recGroupClient.requestAccountDelete();
            const { token: recDelToken } = await recGroupClient.claimActionToken("delete_account");
            await recGroupClient.deleteAccount(recDelToken);

            assertZeroGroupPurgedTables(pds.groupHost.db, wsSole.groupDid);
            const recDelJournal = pds.groupHost.db
              .prepare("SELECT status, plc_outcome FROM group_deletion_journal WHERE group_did = ?")
              .get(wsSole.groupDid) as { status: string; plc_outcome: string };
            assert.deepEqual(recDelJournal, { status: "purged", plc_outcome: "tombstoned" });
          }

          // (iii) PLC HTTP `409`-only automatic re-fetch + re-sign vs non-`409` `4xx` (`400`) immediate `502 PlcTombstoneRejected` termination
          //       + corrupt/missing `rotation_key_enc` -> `authority_lost_local_purge`!
          {
            let plcInterceptMode: "none" | "conflictOnce" | "badRequest400" = "none";
            let conflictTargetDid = "";
            const conflictTargetHostRef: { current?: RunningGroupHost } = {};

            const ghPlcModes = await pds.startExtraGroupHost({
              fetchImpl: async (input, init) => {
                const url = input instanceof Request ? input.url : String(input);
                const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
                if (
                  method === "POST" &&
                  conflictTargetDid &&
                  url === `${pds.network.plc.url}/${encodeURIComponent(conflictTargetDid)}`
                ) {
                  if (plcInterceptMode === "conflictOnce") {
                    plcInterceptMode = "none";
                    // Advance PLC head concurrently with a valid signed rotation/update op so the retry MUST genuinely re-fetch `/log/last` & re-sign!
                    const rotKey = (await conflictTargetHostRef.current!.repoStore.getGroupRotationKey(conflictTargetDid))!;
                    const lastRes = await fetch(`${pds.network.plc.url}/${encodeURIComponent(conflictTargetDid)}/log/last`);
                    const lastOp = (await lastRes.json()) as {
                      rotationKeys: string[];
                      verificationMethods: Record<string, string>;
                      alsoKnownAs: string[];
                      services: Record<string, { type: string; endpoint: string }>;
                    };
                    const logRes = await fetch(`${pds.network.plc.url}/${encodeURIComponent(conflictTargetDid)}/log/audit`);
                    const audit = (await logRes.json()) as Array<{ cid: string }>;
                    const headCid = audit.at(-1)!.cid;
                    const bumpOp = await signOperation(
                      {
                        type: "plc_operation",
                        rotationKeys: lastOp.rotationKeys,
                        verificationMethods: lastOp.verificationMethods,
                        alsoKnownAs: lastOp.alsoKnownAs,
                        services: lastOp.services,
                        prev: headCid,
                      },
                      rotKey,
                    );
                    const bumpRes = await fetch(url, {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify(bumpOp),
                    });
                    assert.equal(bumpRes.status, 200);
                    // Return HTTP `409` conflict on the now-stale first attempt; attempt 2 MUST genuinely re-fetch `/log/last`
                    // from the real `@did-plc/server` (whose head is now `bumpOp`!) and re-sign to pass real PLC verification!
                    return Response.json({ message: "Stale prev conflict" }, { status: 409 });
                  }
                  if (plcInterceptMode === "badRequest400") {
                    return Response.json({ message: "Non-409 4xx PLC rejection" }, { status: 400 });
                  }
                }
                return fetch(input, init);
              },
            });
            conflictTargetHostRef.current = ghPlcModes;

            try {
              const owner = await nextActor("delplc", 0);

              // Case A: HTTP `409` conflict on PLC -> re-fetches `/log/last`, re-signs tombstone, and succeeds!
              const f409 = await completeRealGroupOAuthFlow({
                groupHost: ghPlcModes,
                actor: owner,
                scope: groupAdminScopes().join(" "),
                prompt: "create",
                createParams: { displayName: "PLC 409 Retry Group" },
              });
              conflictTargetDid = f409.tokenResponse!.sub;
              const gc409 = await stepUpRealGroupClient(ghPlcModes, owner, conflictTargetDid);
              await gc409.requestAccountDelete();
              const { token: tok409 } = await gc409.claimActionToken("delete_account");
              plcInterceptMode = "conflictOnce";
              await gc409.deleteAccount(tok409);
              assertZeroGroupPurgedTables(ghPlcModes.db, conflictTargetDid);
              const j409 = ghPlcModes.db
                .prepare("SELECT status, plc_outcome FROM group_deletion_journal WHERE group_did = ?")
                .get(conflictTargetDid) as { status: string; plc_outcome: string };
              assert.deepEqual(j409, { status: "purged", plc_outcome: "tombstoned" });

              // Case B: Non-`409` `4xx` (`400`) on PLC -> terminates immediately with `502 PlcTombstoneRejected`!
              const f400 = await completeRealGroupOAuthFlow({
                groupHost: ghPlcModes,
                actor: owner,
                scope: groupAdminScopes().join(" "),
                prompt: "create",
                createParams: { displayName: "PLC 400 Fail Group" },
              });
              conflictTargetDid = f400.tokenResponse!.sub;
              const gc400 = await stepUpRealGroupClient(ghPlcModes, owner, conflictTargetDid);
              await gc400.requestAccountDelete();
              const { token: tok400 } = await gc400.claimActionToken("delete_account");
              plcInterceptMode = "badRequest400";
              const err400 = await captureXrpcError(() => gc400.deleteAccount(tok400));
              assert.equal(err400.status, 502);
              assert.equal(err400.code, "PlcTombstoneRejected");
              plcInterceptMode = "none";

              // Case C: Corrupt/missing `rotation_key_enc` -> settles as `plc_outcome = 'authority_lost_local_purge'` and purges all 39 tables!
              const fLost = await completeRealGroupOAuthFlow({
                groupHost: ghPlcModes,
                actor: owner,
                scope: groupAdminScopes().join(" "),
                prompt: "create",
                createParams: { displayName: "Missing Rotation Key Group" },
              });
              const lostDid = fLost.tokenResponse!.sub;
              const gcLost = await stepUpRealGroupClient(ghPlcModes, owner, lostDid);
              await gcLost.requestAccountDelete();
              const { token: tokLost } = await gcLost.claimActionToken("delete_account");
              ghPlcModes.db.prepare("UPDATE group_account SET rotation_key_enc = 'corrupted-not-valid-ciphertext' WHERE did = ?").run(lostDid);
              await gcLost.deleteAccount(tokLost);
              assertZeroGroupPurgedTables(ghPlcModes.db, lostDid);
              const jLost = ghPlcModes.db
                .prepare("SELECT status, plc_outcome FROM group_deletion_journal WHERE group_did = ?")
                .get(lostDid) as { status: string; plc_outcome: string };
              assert.deepEqual(jLost, { status: "purged", plc_outcome: "authority_lost_local_purge" });
            } finally {
              await ghPlcModes.close();
            }
          }
        }
      },
    );

    // =========================================================================
    // 5a. All 9 `group.opensocial.*` Methods, Moderation Labels (`!takedown` /
    //     `!hide` Latest-`cts` Across Client / Reader / Bot), All 4
    //     `notifySpaceUpdate` Variants, & Online `backup-db.mjs --group-host`
    //     Restore Drill
    // =========================================================================
    await t.test(
      "5a. All 9 group.opensocial.* methods, moderation labels across client/reader/bot, all 4 notifySpaceUpdate variants & online backup-db.mjs restore drill",
      async () => {
        const alice = await nextActor("modalice", 0);
        const writerMember = await nextActor("modwriter", 1);
        const silentMember = await nextActor("modsilent", 0);
        const outsider = await nextActor("modoutsider", 1);
        const botActor = await nextActor("modbot", 1);

        const ws = await createFullFlockWorkspace(pds, alice, { name: "Moderation & Methods Team", joinPolicy: "approval" });
        await ws.groupClient.putMembership(writerMember.did, ["member"]);
        await ws.groupClient.putMembership(silentMember.did, ["member"]);
        await acceptGroupMembership(pds, writerMember, ws.groupDid);
        await acceptGroupMembership(pds, silentMember, ws.groupDid);

        const aliceEngine = createEngine(clientTransport(pds, alice), { operator: operatorService });
        const writerEngine = createEngine(clientTransport(pds, writerMember), { operator: operatorService });
        const silentEngine = createEngine(clientTransport(pds, silentMember), { operator: operatorService });
        const chanRef = { workspace: ws.workspace, skey: ws.channelSkey };

        // Create a private channel admitting ONLY `alice` & `writerMember` (NOT `silentMember`)!
        await aliceEngine.operator!.execute({
          workspace: ws.workspace,
          operationId: tidNow(),
          request: {
            kind: "createChannel",
            skey: "vip-room",
            name: "vip-room",
            visibility: "private",
            members: [writerMember.did],
          },
        });
        const privChanUri = channelUri(ws.groupDid, "vip-room");

        // 1. `profile.url` HTTP/HTTPS validation (`https://` accepted; `javascript:`, `data:`, `ftp:` rejected with `400`)
        await ws.groupClient.updateProfile({ url: "https://opensocial.example/team" });
        assert.equal((await ws.groupClient.getProfile())?.url, "https://opensocial.example/team");
        for (const badUrl of ["javascript:alert(1)", "data:text/html,<h1>x</h1>", "ftp://files.example/x"]) {
          const badUrlErr = await captureXrpcError(() =>
            ws.groupClient.xrpc.procedure("com.atproto.space.putRecord", {
              space: groupMetaUri(ws.groupDid),
              repo: ws.groupDid,
              collection: OPENSOCIAL_COLLECTION.profile,
              rkey: SELF_SKEY,
              record: {
                $type: OPENSOCIAL_COLLECTION.profile,
                displayName: "Moderation & Methods Team",
                joinPolicy: "approval",
                url: badUrl,
              },
            }),
          );
          assert.equal(badUrlErr.status, 400, `Scheme '${badUrl}' must be rejected with 400`);
        }

        // 2. `com.atproto.label.record` `tid` rkey, `EmptyLabelValue`, & `CrossSpaceLabel` write/import rejection!
        {
          // Non-TID rkey rejected (`400`)
          const badRkeyLabelErr = await captureXrpcError(() =>
            ws.groupClient.xrpc.procedure("com.atproto.space.putRecord", {
              space: groupMembersUri(ws.groupDid),
              repo: ws.groupDid,
              collection: ATPROTO_SPACE_COLLECTION.label,
              rkey: "not-a-valid-tid",
              record: {
                $type: ATPROTO_SPACE_COLLECTION.label,
                src: ws.groupDid,
                uri: writerMember.did,
                val: "!hide",
                cts: new Date().toISOString(),
              },
            }),
          );
          assert.equal(badRkeyLabelErr.status, 400);

          // `EmptyLabelValue` (`val: ""`) rejected (`400`)
          const emptyValErr = await captureXrpcError(() =>
            ws.groupClient.xrpc.procedure("com.atproto.space.putRecord", {
              space: groupMembersUri(ws.groupDid),
              repo: ws.groupDid,
              collection: ATPROTO_SPACE_COLLECTION.label,
              rkey: tidNow(),
              validate: false,
              record: {
                $type: ATPROTO_SPACE_COLLECTION.label,
                src: ws.groupDid,
                uri: writerMember.did,
                val: "",
                cts: new Date().toISOString(),
              },
            }),
          );
          assert.equal(emptyValErr.status, 400);

          // `CrossSpaceLabel` rejected on write (`uri` in `ws.channel` written into `members/self`, OR account DID written into `ws.channel`)!
          const crossSpaceErr1 = await captureXrpcError(() =>
            ws.groupClient.xrpc.procedure("com.atproto.space.putRecord", {
              space: groupMembersUri(ws.groupDid),
              repo: ws.groupDid,
              collection: ATPROTO_SPACE_COLLECTION.label,
              rkey: tidNow(),
              record: {
                $type: ATPROTO_SPACE_COLLECTION.label,
                src: ws.groupDid,
                uri: spaceRecordUri(ws.channel, writerMember.did, COLLECTION.message, tidNow()),
                val: "!hide",
                cts: new Date().toISOString(),
              },
            }),
          );
          assert.equal(crossSpaceErr1.code, "CrossSpaceLabel");

          const crossSpaceErr2 = await captureXrpcError(() =>
            ws.groupClient.xrpc.procedure("com.atproto.space.putRecord", {
              space: ws.channel,
              repo: ws.groupDid,
              collection: ATPROTO_SPACE_COLLECTION.label,
              rkey: tidNow(),
              record: {
                $type: ATPROTO_SPACE_COLLECTION.label,
                src: ws.groupDid,
                uri: writerMember.did,
                val: "!hide",
                cts: new Date().toISOString(),
              },
            }),
          );
          assert.equal(crossSpaceErr2.code, "CrossSpaceLabel");
        }

        // 3. `createReport` precision checks:
        //    - Member-authored personal-PDS message & reaction in `space_writer` -> succeeds!
        //    - Non-writer member (`silentMember`, never wrote in `#general`) -> `400 InvalidSubject`!
        //    - `<groupDid>`-authored record (`rule`) + optional `cid` (matching vs mismatching `cid`) + implicit `subject === groupDid`!
        //    - Private-space read-auth check (`silentMember` reporting URI in `vip-room` gets identical `400 InvalidSubject` as nonexistent space — zero leak!)
        const postedMsg = await writerEngine.channels.send(chanRef, "reportable message");
        const postedReact = await writerEngine.channels.react(chanRef, postedMsg.uri, "👍");
        const postedReactUri = spaceRecordUri(ws.channel, writerMember.did, COLLECTION.reaction, postedReact.rkey);
        await drainGroupHost(pds.groupHost);

        const privSent = await writerEngine.channels.send({ workspace: ws.workspace, skey: "vip-room" }, "vip secret");
        await drainGroupHost(pds.groupHost);

        // Active `space_writer` message & reaction reports succeed!
        await silentEngine.workspaces.createReport({
          groupDid: ws.groupDid,
          subject: postedMsg.uri,
          reasonType: "spam",
          reason: "Spam message",
        });
        await silentEngine.workspaces.createReport({
          groupDid: ws.groupDid,
          subject: postedReactUri,
          reasonType: "other",
          reason: "Noisy reaction",
        });

        // Non-writer member (`silentMember` has never written to `ws.channel`) -> `400 InvalidSubject`!
        const fakeNonWriterMsgUri = spaceRecordUri(ws.channel, silentMember.did, COLLECTION.message, tidNow());
        const nonWriterRepErr = await captureXrpcError(() =>
          writerEngine.workspaces.createReport({
            groupDid: ws.groupDid,
            subject: fakeNonWriterMsgUri,
            reasonType: "spam",
          }),
        );
        assert.equal(nonWriterRepErr.status, 400);
        assert.equal(nonWriterRepErr.code, "InvalidSubject");

        // Private-space existence non-leak: `silentMember` lacks read on `vip-room` -> gets exact same `400 InvalidSubject` as nonexistent space!
        const privLeakErr = await captureXrpcError(() =>
          silentEngine.workspaces.createReport({
            groupDid: ws.groupDid,
            subject: privSent.uri,
            reasonType: "spam",
          }),
        );
        const nonExistentSpaceErr = await captureXrpcError(() =>
          silentEngine.workspaces.createReport({
            groupDid: ws.groupDid,
            subject: spaceRecordUri(channelUri(ws.groupDid, "does-not-exist"), writerMember.did, COLLECTION.message, tidNow()),
            reasonType: "spam",
          }),
        );
        assert.equal(privLeakErr.status, 400);
        assert.equal(privLeakErr.code, "InvalidSubject");
        assert.equal(privLeakErr.code, nonExistentSpaceErr.code, "Private space report refusal must not leak space existence");

        // `<groupDid>`-authored record (`rule`) + optional `cid` + implicit `subject === groupDid`!
        const createdRule = await ws.groupClient.putRule({ title: "Be Kind", text: "Respect everyone.", order: 1 });
        const ruleRec = await ws.groupClient.xrpc.query<{ cid: string }>("com.atproto.space.getRecord", {
          space: groupMetaUri(ws.groupDid),
          repo: ws.groupDid,
          collection: OPENSOCIAL_COLLECTION.rule,
          rkey: createdRule.rkey,
        });
        assert.ok(ruleRec.cid);

        // Mismatching `cid` on `<groupDid>`-authored record -> `400 InvalidSubject`
        const badCidErr = await captureXrpcError(() =>
          silentEngine.workspaces.createReport({
            groupDid: ws.groupDid,
            subject: createdRule.uri,
            cid: "bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
            reasonType: "other",
          }),
        );
        assert.equal(badCidErr.status, 400);
        assert.equal(badCidErr.code, "InvalidSubject");

        // Matching `cid` report + implicit `subject === ws.groupDid` account report succeed!
        await silentEngine.workspaces.createReport({
          groupDid: ws.groupDid,
          subject: createdRule.uri,
          cid: ruleRec.cid,
          reasonType: "other",
          rule: createdRule.uri,
          reason: "Typo in rule",
        });
        await silentEngine.workspaces.createReport({
          groupDid: ws.groupDid,
          subject: ws.groupDid,
          reasonType: "other",
          reason: "Group-level feedback",
        });

        // 4. Deterministic pagination & tie-breaking across `listJoinRequests`, `listModSubjects`, and `getModSubjectHistory` + `resolveModSubject`!
        {
          const jrA = await nextActor("jrpaga", 1);
          const jrB = await nextActor("jrpagb", 1);
          const jrC = await nextActor("jrpagc", 0);
          for (const u of [jrA, jrB, jrC]) {
            await personalGroupCall({
              hostUrl: pds.groupHostUrl,
              actor: u,
              groupDid: ws.groupDid,
              path: OPENSOCIAL_METHOD.requestJoin,
              httpMethod: "POST",
              lxm: OPENSOCIAL_METHOD.requestJoin,
              body: { group: ws.groupDid, message: `Hi from ${u.handle}` },
            });
          }
          // Force identical `created_at` on two join requests to exercise tie-breaking (`created_at ASC, requester_did ASC`)!
          const fixedIso = "2026-11-20T00:00:00.000Z";
          pds.groupHost.db
            .prepare("UPDATE join_request SET created_at = ? WHERE group_did = ? AND requester_did IN (?, ?)")
            .run(fixedIso, ws.groupDid, jrA.did, jrB.did);

          const jrPage1 = await ws.groupClient.listJoinRequests({ limit: 2 });
          assert.equal(jrPage1.requests.length, 2);
          assert.ok(jrPage1.cursor);
          const jrPage2 = await ws.groupClient.listJoinRequests({ limit: 2, cursor: jrPage1.cursor });
          assert.equal(jrPage2.requests.length, 1);
          const allJrDids = [...jrPage1.requests, ...jrPage2.requests].map((r) => r.member);
          assert.equal(new Set(allJrDids).size, 3);
          const expectedTieOrder = [jrA.did, jrB.did].sort();
          assert.deepEqual(allJrDids.slice(0, 2), expectedTieOrder, "listJoinRequests ties break deterministically by DID ASC");

          // Clean up join requests via `denyJoinRequest` & `cancelJoinRequest` (exercising both methods!)
          await ws.groupClient.denyJoinRequest(jrA.did);
          await personalGroupCall({
            hostUrl: pds.groupHostUrl,
            actor: jrB,
            groupDid: ws.groupDid,
            path: OPENSOCIAL_METHOD.cancelJoinRequest,
            httpMethod: "POST",
            lxm: OPENSOCIAL_METHOD.cancelJoinRequest,
            body: { group: ws.groupDid },
          });
          await ws.groupClient.denyJoinRequest(jrC.did);
          assert.equal((await ws.groupClient.listJoinRequests()).requests.length, 0);
          void outsider;

          // Paginate `listModSubjects` (with identical `updated_at` tie-break) + `getModSubjectHistory` + `resolveModSubject`!
          pds.groupHost.db
            .prepare("UPDATE mod_subject SET updated_at = ? WHERE group_did = ?")
            .run("2026-11-20T01:00:00.000Z", ws.groupDid);
          const ms1 = await ws.groupClient.listModSubjects({ status: "open", limit: 2 });
          assert.equal(ms1.subjects.length, 2);
          assert.ok(ms1.cursor);
          const ms2 = await ws.groupClient.listModSubjects({ status: "open", limit: 2, cursor: ms1.cursor });
          assert.equal(ms2.subjects.length, 2);

          // Add multiple reports/labels on `postedMsg.uri` and paginate `getModSubjectHistory`!
          await aliceEngine.workspaces.createReport({
            groupDid: ws.groupDid,
            subject: postedMsg.uri,
            reasonType: "rude",
            reason: "Second report",
          });
          await ws.groupClient.resolveModSubject({ subject: postedMsg.uri, status: "escalated" });
          const hist1 = await ws.groupClient.getModSubjectHistory({ subject: postedMsg.uri, limit: 2 });
          assert.equal(hist1.events.length, 2);
          assert.ok(hist1.cursor);
          const hist2 = await ws.groupClient.getModSubjectHistory({
            subject: postedMsg.uri,
            limit: 2,
            cursor: hist1.cursor,
          });
          assert.ok(hist2.events.length >= 1);

          // Version-specific `cid` history lookup on `createdRule.uri`
          const cidHist = await ws.groupClient.getModSubjectHistory({ subject: createdRule.uri, cid: ruleRec.cid });
          assert.equal(cidHist.events.length, 1);

          const resolvedRule = await ws.groupClient.resolveModSubject({
            subject: createdRule.uri,
            cid: ruleRec.cid,
            status: "resolved",
          });
          assert.equal(resolvedRule.status, "resolved");
        }

        // 5. `!takedown` and `!hide` latest-`cts` (`neg: true`) across `WorkspaceClient`/`ChannelClient`, `IndependentReader`, AND `startEchoBot`!
        const botTempDir = mkdtempSync(join(tmpdir(), "mod-echo-bot-"));
        const stopModBot = new AbortController();
        let modBotPromise: Promise<void> | undefined;
        try {
          await aliceEngine.operator!.execute({
            workspace: ws.workspace,
            operationId: tidNow(),
            request: { kind: "installApp", subject: botActor.did, channels: [{ skey: ws.channelSkey, write: true }] },
          });
          const botSess = await mintAppSession(
            botActor.pds,
            botActor.did,
            { serviceRef: pds.serviceRef, plcUrl: pds.plcUrl, stateFile: join(botTempDir, "bot.json") },
            "mod-bot-dpop",
          );
          const botTrans = nodeTransport(botSess, { plcUrl: pds.plcUrl, loopback: true });
          const botEng = createEngine(botTrans, { operator: operatorService });
          await publishAppDeclaration(botTrans, { name: "ModBot", commands: ECHO_BOT_COMMANDS });

          // Label `postedMsg.uri` with `!hide` and a second message `takedownMsg` with `!takedown` BEFORE starting bot!
          const takedownMsg = await writerEngine.channels.send(chanRef, "takendown secret text");
          await drainGroupHost(pds.groupHost);

          await ws.groupClient.publishLabel({ spaceUri: ws.channel, uri: postedMsg.uri, val: "!hide" });
          await ws.groupClient.publishLabel({ spaceUri: ws.channel, uri: takedownMsg.uri, val: "!takedown" });
          await drainGroupHost(pds.groupHost);

          // Check `ChannelClient.readPage` & `readIndependentChannelPage`:
          // - `takedownMsg` is WITHHELD from both!
          // - `postedMsg` is present with `hidden === true` on both!
          await silentEngine.sync.markSpaceStale(ws.channel);
          const clientPage1 = await silentEngine.channels.readPage(chanRef);
          assert.equal(clientPage1.messages.some((m) => m.uri === takedownMsg.uri), false, "Client withholds !takedown message");
          assert.equal(clientPage1.messages.find((m) => m.uri === postedMsg.uri)?.hidden, true, "Client marks !hide message hidden");

          const indDeps = actorTransport(pds, silentMember);
          const indPage1 = await readIndependentChannelPage(indDeps, ws.workspace, ws.channelSkey);
          assert.equal(indPage1.messages.some((m) => m.uri === takedownMsg.uri), false, "IndependentReader withholds !takedown message");
          assert.equal(indPage1.messages.find((m) => m.uri === postedMsg.uri)?.hidden, true, "IndependentReader marks !hide message hidden");
          assert.ok((await listIndependentWorkspaces(indDeps)).some((w) => w.groupDid === ws.groupDid));

          // Start bot and send a clean message `cleanMsg`: bot replies ONLY to `cleanMsg`, NEVER to `!hide` or `!takedown` messages!
          let modBotPolls = 0;
          modBotPromise = startEchoBot({
            engine: {
              ...botEng,
              operator: {
                getChanges: (follow, sig) => {
                  if (follow.some((f) => f.space === ws.channel)) modBotPolls += 1;
                  return botEng.operator!.getChanges(follow, sig);
                },
              },
            },
            did: botActor.did,
            workspaces: [ws.workspace],
            signal: stopModBot.signal,
            onError: () => undefined,
          });
          for (const st = Date.now(); modBotPolls === 0; await new Promise((r) => setTimeout(r, 80))) {
            assert.ok(Date.now() - st < 20_000);
          }

          const cleanMsg = await writerEngine.channels.send(chanRef, "clean visible text");
          await drainGroupHost(pds.groupHost);
          let cleanReply: { value: Record<string, unknown> } | undefined;
          for (const st = Date.now(); !cleanReply; await new Promise((r) => setTimeout(r, 150))) {
            assert.ok(Date.now() - st < 25_000);
            await drainGroupHost(pds.groupHost);
            await silentEngine.sync.markSpaceStale(ws.channel);
            const p = await silentEngine.channels.readPage(chanRef);
            cleanReply = p.messages.find((m) => m.repo === botActor.did && m.value.parent === cleanMsg.uri);
          }
          const pageWithBot = await silentEngine.channels.readPage(chanRef);
          assert.equal(
            pageWithBot.messages.some((m) => m.repo === botActor.did && m.value.parent === takedownMsg.uri),
            false,
            "Bot must never reply to !takedown message",
          );
          assert.equal(
            pageWithBot.messages.some((m) => m.repo === botActor.did && m.value.parent === postedMsg.uri),
            false,
            "Echo bot must skip hidden (!hide) message",
          );

          // Latest-`cts` negation (`neg: true` with strictly newer `cts`) restores both `takedownMsg` and un-hides `postedMsg`!
          await new Promise((r) => setTimeout(r, 15));
          await ws.groupClient.negateLabel({ spaceUri: ws.channel, uri: postedMsg.uri, val: "!hide" });
          await ws.groupClient.negateLabel({ spaceUri: ws.channel, uri: takedownMsg.uri, val: "!takedown" });
          await drainGroupHost(pds.groupHost);

          await silentEngine.sync.markSpaceStale(ws.channel);
          const clientPageAfterNeg = await silentEngine.channels.readPage(chanRef);
          assert.equal(clientPageAfterNeg.messages.some((m) => m.uri === takedownMsg.uri), true, "Negating !takedown restores message");
          assert.ok(!clientPageAfterNeg.messages.find((m) => m.uri === postedMsg.uri)?.hidden, "Negating !hide clears hidden flag");

          const indPageAfterNeg = await readIndependentChannelPage(indDeps, ws.workspace, ws.channelSkey);
          assert.equal(indPageAfterNeg.messages.some((m) => m.uri === takedownMsg.uri), true);
          assert.ok(!indPageAfterNeg.messages.find((m) => m.uri === postedMsg.uri)?.hidden);

          // Account-level `!takedown` in `members/self` (`proposal.md:148`): withholds the account from rosters AND
          // withholds ALL of `writerMember`'s records across `ChannelClient`, `IndependentReader`, and `startEchoBot`!
          await new Promise((r) => setTimeout(r, 15));
          await ws.groupClient.publishLabel({ uri: writerMember.did, val: "!takedown" });
          await drainGroupHost(pds.groupHost);

          await silentEngine.sync.markSpaceStale(groupMembersUri(ws.groupDid));
          await silentEngine.sync.markSpaceStale(ws.channel);
          const acctTakenPage = await silentEngine.channels.readPage(chanRef);
          assert.equal(
            acctTakenPage.messages.some((m) => m.repo === writerMember.did),
            false,
            "ChannelClient must withhold all messages from !takedown-labeled account",
          );
          const acctTakenSummary = await silentEngine.workspaces.summary(ws.workspace);
          assert.equal(
            acctTakenSummary.members.some((m) => m.did === writerMember.did),
            false,
            "WorkspaceSummary must withhold !takedown-labeled account from roster",
          );
          const indWsTaken = await readIndependentWorkspace(indDeps, ws.workspace);
          assert.equal(
            indWsTaken.members.some((m) => m.did === writerMember.did),
            false,
            "readIndependentWorkspace must withhold !takedown-labeled account",
          );
          const indPageAcctTaken = await readIndependentChannelPage(indDeps, ws.workspace, ws.channelSkey);
          assert.equal(
            indPageAcctTaken.messages.some((m) => m.repo === writerMember.did),
            false,
            "readIndependentChannelPage must withhold all messages from !takedown-labeled account",
          );

          // While `writerMember` has account `!takedown`, EchoBot must NOT reply to a new message from `writerMember`!
          const ignoredBotMsg = await writerEngine.channels.send(chanRef, "takendown account ping");
          await drainGroupHost(pds.groupHost);
          await new Promise((r) => setTimeout(r, 600));
          await silentEngine.sync.markSpaceStale(ws.channel);
          const pageDuringAcctTakedown = await silentEngine.channels.readPage(chanRef);
          assert.equal(
            pageDuringAcctTakedown.messages.some((m) => m.repo === botActor.did && m.value.parent === ignoredBotMsg.uri),
            false,
            "EchoBot must never reply to messages from !takedown-labeled account",
          );

          // Negating account `!takedown` restores `writerMember` and their messages!
          await new Promise((r) => setTimeout(r, 15));
          await ws.groupClient.negateLabel({ uri: writerMember.did, val: "!takedown" });
          await drainGroupHost(pds.groupHost);
          await silentEngine.sync.markSpaceStale(groupMembersUri(ws.groupDid));
          await silentEngine.sync.markSpaceStale(ws.channel);
          const acctRestoredPage = await silentEngine.channels.readPage(chanRef);
          assert.equal(
            acctRestoredPage.messages.some((m) => m.repo === writerMember.did),
            true,
            "Negating account !takedown restores member messages",
          );
          const acctRestoredSummary = await silentEngine.workspaces.summary(ws.workspace);
          assert.equal(
            acctRestoredSummary.members.some((m) => m.did === writerMember.did),
            true,
            "Negating account !takedown restores member to roster",
          );
          void privChanUri;
        } finally {
          stopModBot.abort();
          await Promise.race([modBotPromise?.catch(() => undefined), new Promise((r) => setTimeout(r, 2_000))]);
          rmSync(botTempDir, { recursive: true, force: true });
        }

        // 6. All 4 `notifySpaceUpdate` variants (`#repoWrite`, `#repoRemoved`, `#registrationExpired`, `#spaceDeleted`)!
        {
          const receivedVariants: string[] = [];
          const notifyApp = express();
          notifyApp.use(express.json());
          notifyApp.post("/xrpc/com.atproto.space.confirmRegistration", (req, res) => {
            res.json({ challenge: (req.body as { challenge: string }).challenge });
          });
          notifyApp.post("/xrpc/com.atproto.space.notifySpaceUpdate", (req, res) => {
            const body = req.body as { update: { $type: string } };
            receivedVariants.push(body.update.$type);
            res.status(200).end();
          });
          const notifySrv = await listenHttp(notifyApp);

          try {
            const varSpaceSkey = "four-variants-chan";
            const varSpaceUri = channelUri(ws.groupDid, varSpaceSkey);
            await ws.groupClient.xrpc.procedure("com.atproto.space.createSpace", {
              spaceType: SPACE_TYPE.channel,
              skey: varSpaceSkey,
              policy: {
                $type: OPENSOCIAL_POLICY,
                publicRead: false,
                unlisted: false,
                grants: [
                  { role: "admin", read: true, write: true },
                  { role: "member", read: true, write: true },
                ],
              },
            });

            // Register two tokens (`live-tok` and `expiring-tok`) on `varSpaceUri`
            await mintSpaceCredentialWith(actorTransport(pds, alice), varSpaceUri, {
              notify: { endpoint: notifySrv.url, token: "live-tok" },
            });
            await mintSpaceCredentialWith(actorTransport(pds, writerMember), varSpaceUri, {
              notify: { endpoint: notifySrv.url, token: "expiring-tok" },
            });

            // Variant 1: `#repoWrite`
            const writerXrpc = sessionClient(bearerSession(writerMember) as never);
            await writerXrpc.procedure("com.atproto.space.putRecord", {
              space: varSpaceUri,
              repo: writerMember.did,
              collection: COLLECTION.message,
              rkey: tidNow(),
              record: { $type: COLLECTION.message, text: "triggers repoWrite", createdAt: new Date().toISOString() },
            });
            await drainGroupHost(pds.groupHost);
            assert.ok(receivedVariants.some((v) => v.endsWith("#repoWrite")), "Observed #repoWrite");

            // Variant 2: `#repoRemoved` (narrow `member` grant to `write: false`, evicting `writerMember` from `varSpaceUri`!)
            await ws.groupClient.xrpc.procedure("com.atproto.space.updateSpace", {
              space: varSpaceUri,
              policy: {
                $type: OPENSOCIAL_POLICY,
                publicRead: false,
                unlisted: false,
                grants: [
                  { role: "admin", read: true, write: true },
                  { role: "member", read: true, write: false },
                ],
              },
            });
            await drainGroupHost(pds.groupHost);
            assert.ok(receivedVariants.some((v) => v.endsWith("#repoRemoved")), "Observed #repoRemoved");

            // Variant 3: `#registrationExpired` (age `expiring-tok` past `expires_at`, then write in `varSpaceUri`!)
            pds.groupHost.db
              .prepare("UPDATE notify_registration SET expires_at = ? WHERE space_uri = ? AND token = 'expiring-tok'")
              .run(Date.now() - 10_000, varSpaceUri);
            await ws.groupClient.xrpc.procedure("com.atproto.space.putRecord", {
              space: varSpaceUri,
              repo: ws.groupDid,
              collection: ATPROTO_SPACE_COLLECTION.label,
              rkey: tidNow(),
              record: {
                $type: ATPROTO_SPACE_COLLECTION.label,
                src: ws.groupDid,
                uri: spaceRecordUri(varSpaceUri, writerMember.did, COLLECTION.message, tidNow()),
                val: "!hide",
                cts: new Date().toISOString(),
              },
            });
            await drainGroupHost(pds.groupHost);
            assert.ok(receivedVariants.some((v) => v.endsWith("#registrationExpired")), "Observed #registrationExpired");

            // Variant 4: `#spaceDeleted`
            await ws.groupClient.xrpc.procedure("com.atproto.space.deleteSpace", { space: varSpaceUri });
            await drainGroupHost(pds.groupHost);
            assert.ok(receivedVariants.some((v) => v.endsWith("#spaceDeleted")), "Observed #spaceDeleted");
          } finally {
            await notifySrv.close();
          }
        }

        // 7. Online `scripts/backup-db.mjs --group-host` + Fresh `startGroupHostServer` Restore Drill!
        //    Verifies `0o600` file permissions + full CAR, space, blob, OAuth refresh/session, and key custody recovery!
        const backupDir = mkdtempSync(join(tmpdir(), "opensocial-backup-drill-"));
        let ghLiveBackupSource: RunningGroupHost | undefined;
        let ghRestored: RunningGroupHost | undefined;
        try {
          const sourceDbPath = join(backupDir, "live-source.db");
          const backupDestPath = join(backupDir, "restored-backup.db");
          const encKeyHex = "7d".repeat(32);

          ghLiveBackupSource = await startGroupHostServer({
            port: 0,
            databasePath: sourceDbPath,
            plcUrl: pds.network.plc.url,
            encryptionKeyHex: encKeyHex,
            handleDomain: "backup.groups.localhost",
            allowLoopback: true,
          });
          const livePort = ghLiveBackupSource.port;
          const livePublicUrl = ghLiveBackupSource.url;

          const bkFlow = await completeRealGroupOAuthFlow({
            groupHost: ghLiveBackupSource,
            actor: alice,
            scope: groupAdminScopes().join(" "),
            prompt: "create",
            createParams: { displayName: "Backup Drill Team", joinPolicy: "open", publicMeta: true },
          });
          const bkDid = bkFlow.tokenResponse!.sub;
          const bkTok = bkFlow.tokenResponse!.access_token;
          const bkRefresh = bkFlow.tokenResponse!.refresh_token!;
          const bkClient = makeGroupClient(ghLiveBackupSource, bkDid, bkFlow.dpop, bkTok);

          // Upload a binary blob and reference it in `profile/self`!
          const bkBlobBytes = randomBytes(64_000);
          const upRes = await bkFlow.dpop.fetchWithDpop(`${livePublicUrl}/xrpc/com.atproto.repo.uploadBlob`, {
            method: "POST",
            accessToken: bkTok,
            headers: { "content-type": "image/png" },
            body: Uint8Array.from(bkBlobBytes),
          });
          assert.equal(upRes.status, 200);
          const { blob: bkBlobRef } = (await upRes.json()) as {
            blob: { ref: { $link: string }; mimeType: string; size: number };
          };
          await bkClient.xrpc.procedure("com.atproto.space.putRecord", {
            space: groupMetaUri(bkDid),
            repo: bkDid,
            collection: OPENSOCIAL_COLLECTION.profile,
            rkey: SELF_SKEY,
            record: {
              $type: OPENSOCIAL_COLLECTION.profile,
              displayName: "Backup Drill Team",
              joinPolicy: "open",
              avatar: bkBlobRef,
            },
          });
          await bkClient.putRule({ title: "Backup Rule", text: "Must survive online SQLite backup." });

          const origSignDid = (await ghLiveBackupSource.repoStore.getGroupSigningKey(bkDid)).did();
          const origKemDid = (await ghLiveBackupSource.repoStore.getGroupKemKey(bkDid)).did();
          const origRotDid = (await ghLiveBackupSource.repoStore.getGroupRotationKey(bkDid))!.did();

          // Run `node scripts/backup-db.mjs --group-host <backupDestPath>` WHILE `ghLiveBackupSource` is online!
          const { stdout } = await execFileAsync(
            process.execPath,
            ["scripts/backup-db.mjs", "--group-host", backupDestPath],
            {
              cwd: process.cwd(),
              env: {
                ...process.env,
                GROUP_HOST_DATABASE_PATH: sourceDbPath,
              },
            },
          );
          assert.ok(stdout.trim().endsWith(backupDestPath), `Expected backup stdout to end with ${backupDestPath}, got: ${stdout}`);
          assert.equal(statSync(backupDestPath).mode & 0o777, 0o600, "Backup DB file must have 0600 permissions");

          // Stop original server and boot a FRESH `startGroupHostServer` at the same port/publicUrl over `backupDestPath`!
          ghLiveBackupSource.server.closeIdleConnections?.();
          await ghLiveBackupSource.close();
          ghLiveBackupSource = undefined;

          ghRestored = await startGroupHostServer({
            port: livePort,
            publicUrl: livePublicUrl,
            databasePath: backupDestPath,
            plcUrl: pds.network.plc.url,
            encryptionKeyHex: encKeyHex,
            handleDomain: "backup.groups.localhost",
            allowLoopback: true,
          });

          const fetchRestored = async (url: string, init?: RequestInit) => {
            try {
              return await fetch(url, init);
            } catch {
              // Evict any pooled pre-restart keep-alive socket on the rebound port and retry once
              return fetch(url, init);
            }
          };

          // Verify CAR export (`sync.getRepo`), space records, blob bytes (`sync.getBlob`), OAuth refresh/session, and key custody!
          const carRestored = await fetchRestored(
            `${ghRestored.url}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(bkDid)}`,
          );
          assert.equal(carRestored.status, 200);
          assert.ok((await carRestored.arrayBuffer()).byteLength > 100);

          const blobRestored = await fetchRestored(
            `${ghRestored.url}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(bkDid)}&cid=${encodeURIComponent(bkBlobRef.ref.$link)}`,
          );
          assert.equal(blobRestored.status, 200);
          assert.deepEqual(Buffer.from(await blobRestored.arrayBuffer()), bkBlobBytes, "Restored blob bytes match 100%");

          // Verify OAuth `refresh_token` & DPoP session work on the restored server!
          const bkClientId = `http://localhost?${new URLSearchParams({
            scope: groupAdminScopes().join(" "),
            redirect_uri: "http://127.0.0.1:43123/callback",
          }).toString()}`;
          const refreshRestoredRes = await bkFlow.dpop.fetchWithDpop(`${ghRestored.url}/oauth/token`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "refresh_token",
              refresh_token: bkRefresh,
              client_id: bkClientId,
            }).toString(),
          });
          assert.equal(refreshRestoredRes.status, 200, "OAuth refresh_token must recover cleanly on restored DB");
          const refreshedTok = ((await refreshRestoredRes.json()) as { access_token: string }).access_token;
          const restoredClient = makeGroupClient(ghRestored, bkDid, bkFlow.dpop, refreshedTok);
          const restoredRules = await restoredClient.listRules();
          assert.equal(restoredRules[0]?.title, "Backup Rule");

          assert.equal((await ghRestored.repoStore.getGroupSigningKey(bkDid)).did(), origSignDid);
          assert.equal((await ghRestored.repoStore.getGroupKemKey(bkDid)).did(), origKemDid);
          assert.equal((await ghRestored.repoStore.getGroupRotationKey(bkDid))?.did(), origRotDid);
        } finally {
          await ghLiveBackupSource?.close();
          await ghRestored?.close();
          rmSync(backupDir, { recursive: true, force: true });
        }
      },
    );

    // =========================================================================
    // 5b. Full Black-Box Two-GroupHost Migration:
    //     (a) v1-Scoped Inbound Standard / Outbound Flock-Advertised /
    //         Provenance-Assisted Mode + Non-Flock Zero-Human Group +
    //         `POST /group-admin/controller-session` Sovereign Custody
    //     (b) Opt-In v1 Coordinated Atomic Mode (`3 MiB` + Multi-Blob, Freeze,
    //         Replay, Abort, Partial-Import Mismatch, Barrier Post-Cutover
    //         Write Refusal, Deleted-Invite & Bot-Tombstone Migration, All 7
    //         PLC Negative Checks, & Target `activateAccount` Crash Failpoint)
    // =========================================================================
    await t.test(
      "5b. Full black-box two-GroupHost migration across Standard / Flock-Advertised / Provenance-Assisted & Opt-In v1 Coordinated Atomic modes",
      async () => {
        const alice = await nextActor("migalice", 0);
        const bob = await nextActor("migbob", 1);
        const carol = await nextActor("migcarol", 1);
        const botActor = await nextActor("migbot", 0);
        const adminScopeStr = groupAdminScopes().join(" ");

        // Helper to sign a controller JWT (`lxm: com.atproto.server.createSession`) with an external sovereign PLC rotation key!
        const signControllerJwt = async (sovKey: P256Keypair, groupDid: string, targetServiceDid: string) => {
          const nowSec = Math.floor(Date.now() / 1000);
          const hdr = Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256", kid: sovKey.did() })).toString("base64url");
          const pay = Buffer.from(
            JSON.stringify({
              iss: groupDid,
              aud: targetServiceDid,
              lxm: "com.atproto.server.createSession",
              iat: nowSec,
              exp: nowSec + 60,
              jti: randomUUID(),
            }),
          ).toString("base64url");
          const sig = await sovKey.sign(Buffer.from(`${hdr}.${pay}`, "utf8"));
          return `${hdr}.${pay}.${Buffer.from(sig).toString("base64url")}`;
        };

        // ---------------------------------------------------------------------
        // Part (a): v1-Scoped Inbound Standard / Outbound Flock-Advertised /
        //           Provenance-Assisted Mode & `controller-session` Custody
        // ---------------------------------------------------------------------
        {
          // 1. Outbound `400 UnsupportedGroupHostTarget` rejecting ordinary `@atproto/dev-env` `TestPds` (`pds.hosts[0].url`)
          //    AND an unadvertised plain HTTP server in ALL 3 outbound gates:
          //    `prepare-migration`, `getServiceAuth(lxm=createAccount)`, AND unleased `signPlcOperation`!
          const plainApp = express();
          let plainSrvDid = "";
          let plainSrvUrl = "";
          plainApp.get("/.well-known/did.json", (_req, res) => {
            res.json({
              "@context": ["https://www.w3.org/ns/did/v1"],
              id: plainSrvDid,
              service: [
                {
                  id: "#atproto_pds",
                  type: "AtprotoPersonalDataServer",
                  serviceEndpoint: plainSrvUrl,
                },
              ],
            });
          });
          plainApp.get("/xrpc/com.atproto.server.describeServer", (_req, res) => {
            res.json({ did: plainSrvDid, availableUserDomains: [".unadvertised.example"] });
          });
          const plainSrv = await listenHttp(plainApp);
          plainSrvUrl = plainSrv.url;
          plainSrvDid = `did:web:localhost%3A${new URL(plainSrv.url).port}`;

          try {
            const outCheckWs = await createFullFlockWorkspace(pds, alice, { name: "Outbound Target Check Group" });
            const outCheckClient = await stepUpRealGroupClient(pds.groupHost, alice, outCheckWs.groupDid);
            const testPdsPortDid = `did:web:localhost%3A${new URL(pds.hosts[0].url).port}`;

            for (const [badEndpoint, badServiceDid] of [
              [pds.hosts[0].url, testPdsPortDid],
              [plainSrv.url, plainSrvDid],
            ] as const) {
              const prepErr = await captureXrpcError(() =>
                outCheckClient.prepareMigration(badEndpoint, `bad-prep-${randomUUID()}`),
              );
              assert.equal(prepErr.status, 400);
              assert.equal(prepErr.code, "UnsupportedGroupHostTarget");

              const svcAuthErr = await captureXrpcError(() =>
                outCheckClient.xrpc.query("com.atproto.server.getServiceAuth", {
                  aud: badServiceDid,
                  lxm: "com.atproto.server.createAccount",
                }),
              );
              assert.equal(svcAuthErr.status, 400);
              assert.equal(svcAuthErr.code, "UnsupportedGroupHostTarget");

              const candidateNewRot = await P256Keypair.create({ exportable: true });
              await outCheckClient.xrpc.procedure("com.atproto.identity.requestPlcOperationSignature", {});
              const { token: plcTok } = await outCheckClient.claimActionToken("plc_operation");
              const signErr = await captureXrpcError(() =>
                outCheckClient.xrpc.procedure("com.atproto.identity.signPlcOperation", {
                  token: plcTok,
                  rotationKeys: [candidateNewRot.did()],
                  services: {
                    atproto_pds: {
                      type: "AtprotoPersonalDataServer",
                      endpoint: badEndpoint,
                    },
                  },
                }),
              );
              assert.equal(signErr.status, 400);
              assert.equal(signErr.code, "UnsupportedGroupHostTarget");
            }
          } finally {
            await plainSrv.close();
          }

          // 2. Zero-extension Inbound 1-Key Non-Flock Source HTTP Server migrating an Inbound Non-Flock Zero-Human /
          //    `<groupDid>`-Only / Nondiscoverable OpenSocial Group (`publicMeta: false`, NO `declaration/self`,
          //    NO `new.flock.workspace/self`, zero human `membership` records, governed by sovereign `recoveryKey`)
          //    + `POST /group-admin/controller-session` post-cutover `recovery` activation AND ongoing `group` custody!
          const scratchDir = mkdtempSync(join(tmpdir(), "nonflock-source-scratch-"));
          let scratchHost: RunningGroupHost | undefined;
          let nonFlockSrv: Awaited<ReturnType<typeof listenHttp>> | undefined;
          try {
            // Use a scratch local repo builder purely to materialize valid signed MST CAR & STAR archives, then shut it down
            // and serve ONLY standard ATProto XRPC routes (`404` on `/group-admin/*` and no `OpenSocialGroupHost` DID service)!
            scratchHost = await startGroupHostServer({
              port: 0,
              databasePath: join(scratchDir, "scratch.db"),
              plcUrl: pds.network.plc.url,
              encryptionKeyHex: "8e".repeat(32),
              handleDomain: "scratch.groups.localhost",
              allowLoopback: true,
            });
            const scratchFlow = await completeRealGroupOAuthFlow({
              groupHost: scratchHost,
              actor: alice,
              scope: adminScopeStr,
              prompt: "create",
              createParams: {
                displayName: "Zero Human Nondiscoverable Group",
                joinPolicy: "invite",
                publicMeta: false, // NO `declaration/self`, `publicRead: false` on `meta/self`!
              },
            });
            const zeroHumanDid = scratchFlow.tokenResponse!.sub;
            const scratchSignKey = await scratchHost.repoStore.getGroupSigningKey(zeroHumanDid);
            const scratchKemKey = await scratchHost.repoStore.getGroupKemKey(zeroHumanDid);
            const scratchRotKey = (await scratchHost.repoStore.getGroupRotationKey(zeroHumanDid))!;

            // Remove human `membership/<alice.did>` in SQLite/repoStore on scratch BEFORE exporting STAR so the exported group
            // genuinely has ZERO human members (`<groupDid>`-only, no `declaration/self`, no `new.flock.*` spaces)!
            scratchHost.repoStore.applySpaceRepoMutationsSync({
              groupDid: zeroHumanDid,
              spaceUri: groupMembersUri(zeroHumanDid),
              repoDid: zeroHumanDid,
              ops: [{ action: "delete", collection: OPENSOCIAL_COLLECTION.membership, rkey: alice.did }],
              isOwnAuthoritySpace: true,
              suppressNotices: true,
              nowMs: Date.now(),
            });

            const exportedCar = Buffer.from(
              await (
                await fetch(`${scratchHost.url}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(zeroHumanDid)}`)
              ).arrayBuffer(),
            );
            const coreSpaceUris = [groupMetaUri(zeroHumanDid), groupMembersUri(zeroHumanDid)];
            const exportedMetaStars = new Map<string, Buffer>();
            const exportedRepoStars = new Map<string, Buffer>();
            for (const spUri of coreSpaceUris) {
              exportedMetaStars.set(spUri, Buffer.from(await scratchHost.repoStore.exportSpaceMetaBytes(zeroHumanDid, spUri)));
              const repoStar = await scratchHost.repoStore.exportSpaceRepoStarBytes(spUri, zeroHumanDid);
              exportedRepoStars.set(spUri, Buffer.from(repoStar.starBytes));
            }
            await scratchHost.close();
            scratchHost = undefined;

            // Boot genuine zero-extension non-Flock HTTP server (`404` on `/group-admin/*`!)
            const nonFlockApp = express();
            nonFlockApp.get("/xrpc/com.atproto.server.describeServer", (_req, res) => {
              res.json({ did: "did:web:nonflock.example", availableUserDomains: [".nonflock.example"] });
            });
            nonFlockApp.get("/xrpc/com.atproto.sync.getRepo", (_req, res) => {
              res.setHeader("content-type", "application/vnd.ipld.car");
              res.send(exportedCar);
            });
            nonFlockApp.get("/xrpc/com.atproto.sync.listBlobs", (_req, res) => {
              res.json({ cids: [] });
            });
            nonFlockApp.get("/xrpc/com.atproto.space.listSpaces", (_req, res) => {
              res.json({ spaces: coreSpaceUris.map((s) => ({ space: s })) });
            });
            nonFlockApp.get("/xrpc/com.atproto.space.exportSpaceMeta", (req, res) => {
              const sp = String(req.query.space ?? "");
              res.setHeader("content-type", "application/vnd.dasl.star");
              res.send(exportedMetaStars.get(sp));
            });
            nonFlockApp.get("/xrpc/com.atproto.space.getRepo", (req, res) => {
              const sp = String(req.query.space ?? "");
              res.setHeader("content-type", "application/vnd.dasl.star");
              res.send(exportedRepoStars.get(sp));
            });
            nonFlockSrv = await listenHttp(nonFlockApp);
            const check404 = await fetch(`${nonFlockSrv.url}/group-admin/public-group-keys`);
            assert.equal(check404.status, 404, "Non-Flock source serves zero /group-admin/* extensions");

            // Point `zeroHumanDid`'s 1-key PLC DID document to `nonFlockSrv.url`!
            const auditRes = await fetch(`${pds.network.plc.url}/${encodeURIComponent(zeroHumanDid)}/log/audit`);
            const audit = (await auditRes.json()) as Array<{ cid: string }>;
            const pointToNonFlockOp = await signOperation(
              {
                type: "plc_operation",
                rotationKeys: [scratchRotKey.did()],
                verificationMethods: {
                  atproto: scratchSignKey.did(),
                  atproto_kem: scratchKemKey.did(),
                },
                alsoKnownAs: ["at://zerohuman.nonflock.example"],
                services: {
                  atproto_pds: {
                    type: "AtprotoPersonalDataServer",
                    endpoint: nonFlockSrv.url,
                  },
                },
                prev: audit.at(-1)!.cid,
              },
              scratchRotKey,
            );
            const subNonFlock = await fetch(`${pds.network.plc.url}/${encodeURIComponent(zeroHumanDid)}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(pointToNonFlockOp),
            });
            assert.equal(subNonFlock.status, 200);

            // External sovereign rotation key (`sovControllerKey`) for the zero-human group!
            const sovControllerKey = await P256Keypair.create({ exportable: true });

            // Standard `createAccount({ did, handle, recoveryKey: sovControllerKey.did() })` from 1-key non-Flock source -> `200`!
            const stdCreateJwt = await createServiceJwt({
              iss: zeroHumanDid,
              aud: pds.groupHost.config.serviceDid,
              lxm: "com.atproto.server.createAccount",
              keypair: scratchSignKey,
            });
            const stdCreateRes = await fetch(`${pds.groupHostUrl}/xrpc/com.atproto.server.createAccount`, {
              method: "POST",
              headers: { "content-type": "application/json", authorization: `Bearer ${stdCreateJwt}` },
              body: JSON.stringify({
                did: zeroHumanDid,
                handle: "zerohuman.groups.localhost",
                recoveryKey: sovControllerKey.did(),
              }),
            });
            assert.equal(stdCreateRes.status, 200, `Inbound 1-key createAccount failed: ${await stdCreateRes.clone().text()}`);
            const stdSess = (await stdCreateRes.json()) as { accessJwt: string; refreshJwt: string };

            // Import CAR + core spaces (`meta/self`, `members/self` — NO `declaration/self`, NO `workspace/self`, zero humans!)
            const impCar = await fetch(`${pds.groupHostUrl}/xrpc/com.atproto.repo.importRepo`, {
              method: "POST",
              headers: { "content-type": "application/vnd.ipld.car", authorization: `Bearer ${stdSess.accessJwt}` },
              body: Uint8Array.from(exportedCar),
            });
            assert.equal(impCar.status, 200);
            for (const spUri of coreSpaceUris) {
              const impM = await fetch(`${pds.groupHostUrl}/xrpc/com.atproto.space.importSpaceMeta`, {
                method: "POST",
                headers: { "content-type": "application/vnd.dasl.star", authorization: `Bearer ${stdSess.accessJwt}` },
                body: Uint8Array.from(exportedMetaStars.get(spUri)!),
              });
              assert.equal(impM.status, 200);
              const impR = await fetch(`${pds.groupHostUrl}/xrpc/com.atproto.space.importRepo`, {
                method: "POST",
                headers: { "content-type": "application/vnd.dasl.star", authorization: `Bearer ${stdSess.accessJwt}` },
                body: Uint8Array.from(exportedRepoStars.get(spUri)!),
              });
              assert.equal(impR.status, 200);
            }

            // Cut over PLC (`getRecommendedDidCredentials` includes `sovControllerKey.did()` + target local rotation key, dropping `scratchRotKey.did()`)!
            const recCredsRes = await fetch(`${pds.groupHostUrl}/xrpc/com.atproto.identity.getRecommendedDidCredentials`, {
              headers: { authorization: `Bearer ${stdSess.accessJwt}` },
            });
            assert.equal(recCredsRes.status, 200);
            const recCreds = (await recCredsRes.json()) as {
              rotationKeys: string[];
              alsoKnownAs: string[];
              verificationMethods: Record<string, string>;
              services: Record<string, { type: string; endpoint: string }>;
            };
            assert.ok(recCreds.rotationKeys.includes(sovControllerKey.did()));
            assert.equal(recCreds.rotationKeys.includes(scratchRotKey.did()), false);

            const auditBeforeCut = (await (
              await fetch(`${pds.network.plc.url}/${encodeURIComponent(zeroHumanDid)}/log/audit`)
            ).json()) as Array<{ cid: string }>;
            const signedCutover = await signOperation(
              {
                type: "plc_operation",
                rotationKeys: recCreds.rotationKeys,
                verificationMethods: recCreds.verificationMethods,
                alsoKnownAs: recCreds.alsoKnownAs,
                services: recCreds.services,
                prev: auditBeforeCut.at(-1)!.cid,
              },
              scratchRotKey,
            );
            const subCutover = await fetch(`${pds.groupHostUrl}/xrpc/com.atproto.identity.submitPlcOperation`, {
              method: "POST",
              headers: { "content-type": "application/json", authorization: `Bearer ${stdSess.accessJwt}` },
              body: JSON.stringify({ operation: signedCutover }),
            });
            assert.equal(subCutover.status, 200);

            // Before `activateAccount`, `activated === 0`: prove `POST /group-admin/controller-session` signed by `sovControllerKey`
            // mints a `recovery` session AND activates this zero-human nondiscoverable group!
            const ctrlDpop1 = await createGroupDpopClient("ctrl-rec-dpop");
            const ctrlJwt1 = await signControllerJwt(sovControllerKey, zeroHumanDid, pds.groupHost.config.serviceDid);
            const ctrlRes1 = await ctrlDpop1.fetchWithDpop(`${pds.groupHostUrl}/group-admin/controller-session`, {
              method: "POST",
              headers: { authorization: `Bearer ${ctrlJwt1}`, "content-type": "application/json" },
              body: JSON.stringify({ group: zeroHumanDid }),
            });
            assert.equal(ctrlRes1.status, 200, `controller-session recovery failed: ${await ctrlRes1.clone().text()}`);
            const ctrlTok1 = ((await ctrlRes1.json()) as { access_token: string }).access_token;
            const ctrlClient1 = makeGroupClient(pds.groupHost, zeroHumanDid, ctrlDpop1, ctrlTok1);
            assert.equal((await ctrlClient1.checkAccountStatus()).activated, false);
            await ctrlClient1.activateAccount();
            assert.equal((await ctrlClient1.checkAccountStatus()).activated, true);

            // Now while `activated === 1`, prove `POST /group-admin/controller-session` mints an ongoing `group` custody session
            // capable of administering `profile/self` and `rule` records on the `<groupDid>`-only group!
            const ctrlDpop2 = await createGroupDpopClient("ctrl-active-dpop");
            const ctrlJwt2 = await signControllerJwt(sovControllerKey, zeroHumanDid, pds.groupHost.config.serviceDid);
            const ctrlRes2 = await ctrlDpop2.fetchWithDpop(`${pds.groupHostUrl}/group-admin/controller-session`, {
              method: "POST",
              headers: { authorization: `Bearer ${ctrlJwt2}`, "content-type": "application/json" },
              body: JSON.stringify({ group: zeroHumanDid }),
            });
            assert.equal(ctrlRes2.status, 200);
            const ctrlTok2 = ((await ctrlRes2.json()) as { access_token: string }).access_token;
            const ctrlClient2 = makeGroupClient(pds.groupHost, zeroHumanDid, ctrlDpop2, ctrlTok2);
            await ctrlClient2.updateProfile({ description: "Administered via sovereign PLC controller-session" });
            assert.equal((await ctrlClient2.getProfile())?.description, "Administered via sovereign PLC controller-session");
          } finally {
            await scratchHost?.close();
            await nonFlockSrv?.close();
            rmSync(scratchDir, { recursive: true, force: true });
          }

          // 3. Multi-Key Non-Flock Source: `400 TooManyRotationKeys` (5-key full source), `400 ProvenanceRequired` (unattested 2-key source),
          //    and `200 OK` Opt-In Provenance-Assisted Migration (`X-Group-Migration-Key-Provenance`)!
          {
            // (i) 5-key full non-Flock PLC source without retiring local key -> `400 TooManyRotationKeys`!
            const s5 = await P256Keypair.create({ exportable: true });
            const k5 = await P256Keypair.create({ exportable: true });
            const rKeys5 = await Promise.all(Array.from({ length: 5 }, () => P256Keypair.create({ exportable: true })));
            const gen5Base = formatAtprotoOp({
              signingKey: s5.did(),
              handle: "fivekey.test",
              pds: pds.hosts[0].url,
              rotationKeys: rKeys5.map((k) => k.did()),
              prev: null,
            });
            const gen5 = await signOperation(
              { ...gen5Base, verificationMethods: { ...gen5Base.verificationMethods, atproto_kem: k5.did() } },
              rKeys5[0]!,
            );
            const did5 = await didForCreateOp(gen5);
            await fetch(`${pds.network.plc.url}/${encodeURIComponent(did5)}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(gen5),
            });
            const jwt5 = await createServiceJwt({
              iss: did5,
              aud: pds.groupHost.config.serviceDid,
              lxm: "com.atproto.server.createAccount",
              keypair: s5,
            });
            // Provide provenance naming `rKeys5[0]`? Without provenance on 5 keys it hits `ProvenanceRequired` OR with 5 sovereign keys + 1 host = 6;
            // let's test BOTH 2-key unattested (`ProvenanceRequired`), 6-key/5-sovereign (`TooManyRotationKeys`), and valid 2-key `X-Group-Migration-Key-Provenance`!
            const unattested5Res = await fetch(`${pds.groupHostUrl}/xrpc/com.atproto.server.createAccount`, {
              method: "POST",
              headers: { "content-type": "application/json", authorization: `Bearer ${jwt5}` },
              body: JSON.stringify({ did: did5, handle: "fivekey.groups.localhost" }),
            });
            assert.equal(unattested5Res.status, 400);
            assert.equal(((await unattested5Res.json()) as { error: string }).error, "ProvenanceRequired");

            // If 5 keys exist AND `recoveryKey` adds a new key (5 - 1 retired + 1 new recovery + 1 target local = 6 > 5) -> `400 TooManyRotationKeys`!
            const extraRec = await P256Keypair.create({ exportable: true });
            const nowSec = Math.floor(Date.now() / 1000);
            const makeProvJws = async (sovSigner: P256Keypair, subDid: string, retiredDidKey: string) => {
              const h = Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256", kid: sovSigner.did() })).toString("base64url");
              const p = Buffer.from(
                JSON.stringify({
                  iss: sovSigner.did(),
                  sub: subDid,
                  aud: pds.groupHost.config.serviceDid,
                  act: "migration_key_provenance",
                  sourceLocalRotationKey: retiredDidKey,
                  iat: nowSec,
                  exp: nowSec + 120,
                  jti: randomUUID(),
                }),
              ).toString("base64url");
              const s = await sovSigner.sign(Buffer.from(`${h}.${p}`, "utf8"));
              return `${h}.${p}.${Buffer.from(s).toString("base64url")}`;
            };

            const prov5 = await makeProvJws(rKeys5[1]!, did5, rKeys5[0]!.did());
            const jwt5b = await createServiceJwt({
              iss: did5,
              aud: pds.groupHost.config.serviceDid,
              lxm: "com.atproto.server.createAccount",
              keypair: s5,
            });
            const tooManyRes = await fetch(`${pds.groupHostUrl}/xrpc/com.atproto.server.createAccount`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${jwt5b}`,
                "x-group-migration-key-provenance": prov5,
              },
              body: JSON.stringify({
                did: did5,
                handle: "fivekey.groups.localhost",
                recoveryKey: extraRec.did(),
              }),
            });
            assert.equal(tooManyRes.status, 400);
            assert.equal(((await tooManyRes.json()) as { error: string }).error, "TooManyRotationKeys");

            // Valid 2-key Provenance-Assisted `createAccount` (`200 OK`)!
            const s2 = await P256Keypair.create({ exportable: true });
            const k2 = await P256Keypair.create({ exportable: true });
            const rotLocal2 = await P256Keypair.create({ exportable: true });
            const rotSov2 = await P256Keypair.create({ exportable: true });
            const gen2Base = formatAtprotoOp({
              signingKey: s2.did(),
              handle: "twokey.test",
              pds: pds.hosts[0].url,
              rotationKeys: [rotLocal2.did(), rotSov2.did()],
              prev: null,
            });
            const gen2 = await signOperation(
              { ...gen2Base, verificationMethods: { ...gen2Base.verificationMethods, atproto_kem: k2.did() } },
              rotLocal2,
            );
            const did2 = await didForCreateOp(gen2);
            await fetch(`${pds.network.plc.url}/${encodeURIComponent(did2)}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(gen2),
            });
            const prov2 = await makeProvJws(rotSov2, did2, rotLocal2.did());
            const jwt2 = await createServiceJwt({
              iss: did2,
              aud: pds.groupHost.config.serviceDid,
              lxm: "com.atproto.server.createAccount",
              keypair: s2,
            });

            // Negative check: `recoveryKey === sourceLocalRotationKey` (`rotLocal2.did()`) -> `400 SourceRotationKeyRetained` BEFORE staging or JTI consumption!
            const badRetainedRecRes = await fetch(`${pds.groupHostUrl}/xrpc/com.atproto.server.createAccount`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${jwt2}`,
                "x-group-migration-key-provenance": prov2,
              },
              body: JSON.stringify({
                did: did2,
                handle: "twokey.groups.localhost",
                recoveryKey: rotLocal2.did(),
              }),
            });
            assert.equal(badRetainedRecRes.status, 400);
            assert.equal(((await badRetainedRecRes.json()) as { error: string }).error, "SourceRotationKeyRetained");

            // Reusing the SAME `jwt2` + `prov2` (proving JTI was NOT consumed on pre-staging rejection!) succeeds (`200 OK`)!
            const okProvRes = await fetch(`${pds.groupHostUrl}/xrpc/com.atproto.server.createAccount`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${jwt2}`,
                "x-group-migration-key-provenance": prov2,
              },
              body: JSON.stringify({ did: did2, handle: "twokey.groups.localhost" }),
            });
            assert.equal(okProvRes.status, 200, `Provenance-assisted 2-key createAccount failed: ${await okProvRes.clone().text()}`);
          }
        }

        // ---------------------------------------------------------------------
        // Part (b): Opt-In v1 Coordinated Atomic Mode + Standard `A -> B -> A`
        //           Return Migration (`pds.groupHost` <-> `ghTarget`)
        // ---------------------------------------------------------------------
        let simulateTargetOutageForSource = false;
        let simulateSourceFinalizeOutage = false;

        const ghSource = await pds.startExtraGroupHost({
          handleDomain: "src-mig.groups.localhost",
          fetchImpl: async (input, init) => {
            const url = input instanceof Request ? input.url : String(input);
            if (simulateTargetOutageForSource && url.includes("/group-admin/migration-info")) {
              return Response.json({ error: "ServiceUnavailable", message: "target temporarily unreachable" }, { status: 503 });
            }
            return fetch(input, init);
          },
        });

        const ghTarget = await pds.startExtraGroupHost({
          handleDomain: "dst-mig.groups.localhost",
          fetchImpl: async (input, init) => {
            const url = input instanceof Request ? input.url : String(input);
            if (simulateSourceFinalizeOutage && url.includes("/group-admin/finalize-migrated-source")) {
              return Response.json({ error: "ServiceUnavailable", message: "source temporarily unreachable" }, { status: 503 });
            }
            return fetch(input, init);
          },
        });

        const ghCompeting = await pds.startExtraGroupHost({
          handleDomain: "comp-mig.groups.localhost",
        });

        const ghTinyLimit = await pds.startExtraGroupHost({
          handleDomain: "tiny-mig.groups.localhost",
          maxRepoImportSize: 128, // Forces `TargetMigrationLimitExceeded` preflight refusal!
        });

        try {
          // 1. Seed rich OpenSocial + Flock group on `ghSource`:
          //    - External sovereign PLC rotation key (`sovKey`)
          //    - `3 MiB` (`3_145_728` bytes > 2 MB) blob + second blob referenced in space records
          //    - Live external invite (`bob`) + PREVIOUSLY DELETED external invite (`carol`)
          //    - Uninstalled bot (`active: false` `app.install` tombstone + `known_app_subject`)
          //    - Private non-migrating state (`join_request`, `mod_subject`, `mod_event`, `oauth_session`)!
          const srcCreateFlow = await completeRealGroupOAuthFlow({
            groupHost: ghSource,
            actor: alice,
            scope: adminScopeStr,
            prompt: "create",
            createParams: {
              displayName: "Coordinated Full Migration Group",
              handle: "full.src-mig.groups.localhost",
              joinPolicy: "approval",
              publicMeta: true,
            },
          });
          const gDid = srcCreateFlow.tokenResponse!.sub;
          const srcFlow = await completeRealGroupOAuthFlow({
            groupHost: ghSource,
            actor: alice,
            scope: adminScopeStr,
            prompt: "login",
            loginHint: gDid,
          });
          const dpopSrc = srcFlow.dpop;
          const tokSrc = srcFlow.tokenResponse!.access_token;
          const refTokSrc = srcFlow.tokenResponse!.refresh_token!;
          const srcClient = makeGroupClient(ghSource, gDid, dpopSrc, tokSrc);

          // Add sovereign PLC rotation key (`sovKey`)
          const sovKey = await P256Keypair.create({ exportable: true });
          await srcClient.xrpc.procedure("com.atproto.identity.requestPlcOperationSignature", {});
          const { token: addSovTok } = await srcClient.claimActionToken("plc_operation");
          const initLastOp = (await (
            await fetch(`${pds.network.plc.url}/${encodeURIComponent(gDid)}/log/last`)
          ).json()) as { rotationKeys: string[] };
          const { operation: addSovOp } = await srcClient.xrpc.procedure<unknown, { operation: Record<string, unknown> }>(
            "com.atproto.identity.signPlcOperation",
            { token: addSovTok, rotationKeys: [...initLastOp.rotationKeys, sovKey.did()] },
          );
          await srcClient.xrpc.procedure("com.atproto.identity.submitPlcOperation", { operation: addSovOp });

          // Upload `3 MiB` (`3 * 1024 * 1024` bytes > 2 MB) blob + second `64 KiB` blob!
          const blob3MiBBytes = randomBytes(3 * 1024 * 1024);
          const blob2Bytes = randomBytes(64 * 1024);
          const up3MiB = await dpopSrc.fetchWithDpop(`${ghSource.url}/xrpc/com.atproto.repo.uploadBlob`, {
            method: "POST",
            accessToken: tokSrc,
            headers: { "content-type": "application/octet-stream" },
            body: Uint8Array.from(blob3MiBBytes),
          });
          assert.equal(up3MiB.status, 200, "3 MiB (> 2 MB) uploadBlob must succeed");
          const blob3MiBRef = ((await up3MiB.json()) as { blob: { ref: { $link: string } } }).blob;

          const upBlob2 = await dpopSrc.fetchWithDpop(`${ghSource.url}/xrpc/com.atproto.repo.uploadBlob`, {
            method: "POST",
            accessToken: tokSrc,
            headers: { "content-type": "image/png" },
            body: Uint8Array.from(blob2Bytes),
          });
          assert.equal(upBlob2.status, 200);
          const blob2Ref = ((await upBlob2.json()) as { blob: { ref: { $link: string } } }).blob;

          await srcClient.xrpc.procedure("com.atproto.space.putRecord", {
            space: groupMetaUri(gDid),
            repo: gDid,
            collection: OPENSOCIAL_COLLECTION.profile,
            rkey: SELF_SKEY,
            record: {
              $type: OPENSOCIAL_COLLECTION.profile,
              displayName: "Coordinated Full Migration Group",
              joinPolicy: "approval",
              avatar: blob2Ref,
              banner: blob3MiBRef,
            },
          });

          // Create `workspace/self` with an uninstalled bot tombstone (`active: false`)!
          await srcClient.xrpc.procedure("com.atproto.space.createSpace", {
            spaceType: SPACE_TYPE.workspace,
            skey: SELF_SKEY,
            policy: {
              $type: OPENSOCIAL_POLICY,
              publicRead: false,
              unlisted: false,
              grants: [
                { role: "admin", read: true, write: true },
                { role: "member", read: true },
              ],
            },
          });
          await srcClient.xrpc.procedure("com.atproto.space.putRecord", {
            space: workspaceUri(gDid),
            repo: gDid,
            collection: COLLECTION.appInstall,
            rkey: subjectKey(botActor.did),
            record: {
              $type: COLLECTION.appInstall,
              subject: botActor.did,
              active: false,
              channels: [],
              installedBy: alice.did,
              installedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          });

          // Provision `bob` & `carol` `invites/self`; send live invite to `bob`, and send + DELETE invite to `carol`!
          const bobEng = createEngine(clientTransport(pds, bob), { operator: operatorService });
          const carolEng = createEngine(clientTransport(pds, carol), { operator: operatorService });
          await bobEng.workspaces.ensureInvitesSpace();
          await carolEng.workspaces.ensureInvitesSpace();

          const bobLiveInv = await srcClient.createInvite(bob.did);
          const carolDeletedInv = await srcClient.createInvite(carol.did);
          await srcClient.revokeInvite(carol.did, carolDeletedInv.rkey);
          await drainGroupHost(ghSource);

          // Seed non-migrating private queue & moderation history on `ghSource`!
          const pendingOutsider = await nextActor("migpend", 1);
          await personalGroupCall({
            hostUrl: ghSource.url,
            actor: pendingOutsider,
            groupDid: gDid,
            path: OPENSOCIAL_METHOD.requestJoin,
            httpMethod: "POST",
            lxm: OPENSOCIAL_METHOD.requestJoin,
            body: { group: gDid, message: "Source-only pending request" },
          });
          await personalGroupCall({
            hostUrl: ghSource.url,
            actor: alice,
            groupDid: gDid,
            path: OPENSOCIAL_METHOD.createReport,
            httpMethod: "POST",
            lxm: OPENSOCIAL_METHOD.createReport,
            body: { group: gDid, subject: gDid, reasonType: "other", reason: "Source-only mod event" },
          });
          assert.equal((await srcClient.listJoinRequests()).requests.length, 1);
          assert.equal((await srcClient.listModSubjects()).subjects.length, 1);

          // 2. Limit preflight failure (`ghTinyLimit` -> `TargetMigrationLimitExceeded`) MUST leave `ghSource` unfrozen!
          const limitErr = await captureXrpcError(() =>
            srcClient.prepareMigration(ghTinyLimit.url, `op-limit-${randomUUID()}`),
          );
          assert.equal(limitErr.code, "TargetMigrationLimitExceeded");
          await srcClient.putRule({ rkey: "3jzfcijpj2z2a", title: "Still Unfrozen", text: "Writes still work after limit preflight error" });

          // 3. `'prepared'` lease expiry auto-thaw!
          const expLeaseOpId = `op-expire-${randomUUID()}`;
          await srcClient.prepareMigration(ghTarget.url, expLeaseOpId);
          ghSource.db
            .prepare("UPDATE source_migration_lease SET expires_at = ? WHERE group_did = ?")
            .run(Date.now() - 5_000, gDid);
          await ghSource.migration.sweepExpiredPreparedMigrationLeases();
          await srcClient.putRule({ rkey: "3jzfcijpj2z2b", title: "Thawed Rule", text: "Auto-thawed after lease expiry" });

          // 4. First Coordinated run to test:
          //    - `83`-byte `X-Group-Migration-Ticket`
          //    - Offline-safe idempotent `200` `prepare-migration` replay during Target outage
          //    - Atomic freeze (`409 MigrationInProgress` on space, repo, external-invite, and `leaveGroup` writes)
          //    - Competing-target `409` & target-mismatched `getServiceAuth(createAccount)` / `signPlcOperation` `409`
          //    - `getServiceAuth` `PROTECTED_METHODS` (`400`)
          //    - `refreshSession` (`access_jti` vs `refresh_jti`, rotated `refresh_jti` replay abort!)
          //    - Crash-idempotent `abort-migration` (`already_absent` / `purged` / `superseded`) + `'plc_signed'` PLC head-advance!
          const abortRunOpId = `op-abort-${randomUUID()}`;
          const prepAbortRun = await srcClient.prepareMigration(ghTarget.url, abortRunOpId);
          assert.equal(prepAbortRun.migrationTicket?.length, 83, "X-Group-Migration-Ticket is fixed 83 bytes");

          // Offline-safe idempotent `200` replay while `ghTarget` is unreachable (`simulateTargetOutageForSource = true`)!
          simulateTargetOutageForSource = true;
          const replayDuringOutage = await srcClient.prepareMigration(ghTarget.url, abortRunOpId);
          simulateTargetOutageForSource = false;
          assert.equal(replayDuringOutage.migrationTicket, prepAbortRun.migrationTicket);

          // Competing-target `prepare-migration` -> `409`!
          const compPrepErr = await captureXrpcError(() =>
            srcClient.prepareMigration(ghCompeting.url, `op-comp-${randomUUID()}`),
          );
          assert.equal(compPrepErr.status, 409);

          // Target-mismatched `getServiceAuth(createAccount)` -> `409`!
          const mismatchSvcAuthErr = await captureXrpcError(() =>
            srcClient.xrpc.query("com.atproto.server.getServiceAuth", {
              aud: ghCompeting.config.serviceDid,
              lxm: "com.atproto.server.createAccount",
            }),
          );
          assert.equal(mismatchSvcAuthErr.status, 409);

          // `getServiceAuth` `PROTECTED_METHODS` rejected (`400`)!
          for (const protectedLxm of [
            "com.atproto.server.deleteAccount",
            "com.atproto.identity.submitPlcOperation",
            "com.atproto.identity.signPlcOperation",
          ]) {
            const protErr = await captureXrpcError(() =>
              srcClient.xrpc.query("com.atproto.server.getServiceAuth", {
                aud: ghTarget.config.serviceDid,
                lxm: protectedLxm,
              }),
            );
            assert.equal(protErr.status, 400);
          }

          // Atomic freeze blocks space write, public repo write, external-invite write, AND `leaveGroup` (`409 MigrationInProgress`)!
          const frozenSpaceErr = await captureXrpcError(() =>
            srcClient.putRule({ title: "Blocked", text: "Frozen" }),
          );
          assert.equal(frozenSpaceErr.status, 409);
          assert.equal(frozenSpaceErr.code, "MigrationInProgress");

          const frozenPubErr = await captureXrpcError(() => srcClient.setPublicMeta(false));
          assert.equal(frozenPubErr.status, 409);

          const frozenInvErr = await captureXrpcError(() => srcClient.createInvite(pendingOutsider.did));
          assert.equal(frozenInvErr.status, 409);

          const frozenLeaveRes = await personalGroupCall<{ error?: string }>({
            hostUrl: ghSource.url,
            actor: alice,
            groupDid: gDid,
            path: OPENSOCIAL_METHOD.leaveGroup,
            httpMethod: "POST",
            lxm: OPENSOCIAL_METHOD.leaveGroup,
            body: { group: gDid },
          });
          assert.equal(frozenLeaveRes.status, 409);
          assert.equal(frozenLeaveRes.json.error, "MigrationInProgress");

          // Stage on `ghTarget` -> test `refreshSession` (`access_jti` 401, `refresh_jti` 200, rotated `refresh_jti` replay aborts staging!)
          const { token: stageJwt1 } = await srcClient.xrpc.query<{ token: string }>(
            "com.atproto.server.getServiceAuth",
            { aud: ghTarget.config.serviceDid, lxm: "com.atproto.server.createAccount" },
          );
          const stageRes1 = await fetch(`${ghTarget.url}/xrpc/com.atproto.server.createAccount`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${stageJwt1}`,
              "x-group-migration-ticket": prepAbortRun.migrationTicket!,
            },
            body: JSON.stringify({ did: gDid, handle: "full.dst-mig.groups.localhost" }),
          });
          assert.equal(stageRes1.status, 200);
          const stageToks1 = (await stageRes1.json()) as { accessJwt: string; refreshJwt: string };

          // `accessJwt` rejected on `refreshSession` (`401`)
          const badAccessRefresh = await fetch(`${ghTarget.url}/xrpc/com.atproto.server.refreshSession`, {
            method: "POST",
            headers: { authorization: `Bearer ${stageToks1.accessJwt}` },
          });
          assert.equal(badAccessRefresh.status, 401);

          // `refreshJwt` rotates session -> replaying old `stageToks1.refreshJwt` aborts and purges un-cutover staging!
          const rotatedStageRes = await fetch(`${ghTarget.url}/xrpc/com.atproto.server.refreshSession`, {
            method: "POST",
            headers: { authorization: `Bearer ${stageToks1.refreshJwt}` },
          });
          assert.equal(rotatedStageRes.status, 200);
          const replayOldRefreshRes = await fetch(`${ghTarget.url}/xrpc/com.atproto.server.refreshSession`, {
            method: "POST",
            headers: { authorization: `Bearer ${stageToks1.refreshJwt}` },
          });
          assert.equal(replayOldRefreshRes.status, 401);
          const checkPurgedOnReplay = ghTarget.db
            .prepare("SELECT 1 AS ok FROM group_account WHERE did = ?")
            .get(gDid);
          assert.equal(checkPurgedOnReplay, undefined, "Replaying rotated migration refreshJwt must abort & purge staging");

          // Crash-idempotent `abort-migration` on Target (`already_absent`) and Source (`aborted`)!
          const abortRunTicketId = prepAbortRun.migrationTicket!.split(".")[1]!;
          // Confused-deputy checks: unauthenticated `public-group-keys` proofJwt AND wrong-aud/wrong-lxm JWTs MUST be rejected!
          const pubKeysForAttack = (await (
            await fetch(`${ghSource.url}/group-admin/public-group-keys?group=${encodeURIComponent(gDid)}`)
          ).json()) as { proofJwt: string };
          const confusedPubKeyAbort = await fetch(`${ghTarget.url}/group-admin/abort-migration`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${pubKeysForAttack.proofJwt}` },
            body: JSON.stringify({ group: gDid, operationId: abortRunOpId, ticketId: abortRunTicketId }),
          });
          assert.ok(
            confusedPubKeyAbort.status === 401 || confusedPubKeyAbort.status === 403,
            `public-group-keys proofJwt must be rejected by abort-migration, got ${confusedPubKeyAbort.status}`,
          );
          const wrongLxmAbortJwt = await ghSource.repoStore.signGroupServiceJwt({
            groupDid: gDid,
            aud: bob.did,
            lxm: "com.atproto.space.notifyCredentialsRevoked",
          });
          const confusedRevokeAbort = await fetch(`${ghTarget.url}/group-admin/abort-migration`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${wrongLxmAbortJwt}` },
            body: JSON.stringify({ group: gDid, operationId: abortRunOpId, ticketId: abortRunTicketId }),
          });
          assert.ok(
            confusedRevokeAbort.status === 401 || confusedRevokeAbort.status === 403,
            `notifyCredentialsRevoked JWT must be rejected by abort-migration, got ${confusedRevokeAbort.status}`,
          );

          const targetAbortJwt = await ghSource.repoStore.signGroupServiceJwt({
            groupDid: gDid,
            aud: ghTarget.config.serviceDid,
            lxm: "group.opensocial.abortMigration",
          });
          const targetAbortAbsent = await fetch(`${ghTarget.url}/group-admin/abort-migration`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${targetAbortJwt}` },
            body: JSON.stringify({ group: gDid, operationId: abortRunOpId, ticketId: abortRunTicketId }),
          });
          assert.equal(targetAbortAbsent.status, 200);
          assert.equal(((await targetAbortAbsent.json()) as { status: string }).status, "already_absent");
          await srcClient.abortMigration(abortRunOpId);

          // Now also test `'plc_signed'` `abort-migration` advancing PLC head + Target `abort-migration` returning `superseded` vs `purged`!
          const plcSignedAbortOpId = `op-plcsigned-${randomUUID()}`;
          const prepPlcAbort = await srcClient.prepareMigration(ghTarget.url, plcSignedAbortOpId);
          const { token: stageJwt2 } = await srcClient.xrpc.query<{ token: string }>(
            "com.atproto.server.getServiceAuth",
            { aud: ghTarget.config.serviceDid, lxm: "com.atproto.server.createAccount" },
          );
          const stageRes2 = await fetch(`${ghTarget.url}/xrpc/com.atproto.server.createAccount`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${stageJwt2}`,
              "x-group-migration-ticket": prepPlcAbort.migrationTicket!,
            },
            body: JSON.stringify({ did: gDid, handle: "full.dst-mig.groups.localhost" }),
          });
          assert.equal(stageRes2.status, 200);
          const stageToks2 = (await stageRes2.json()) as { accessJwt: string };

          // Calling Target `abort-migration` with a DIFFERENT `operationId` (authenticated via `migration_session` `at+jwt`!)
          // returns `superseded` without purging `plcSignedAbortOpId`!
          const supAbortRes = await fetch(`${ghTarget.url}/group-admin/abort-migration`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${stageToks2.accessJwt}` },
            body: JSON.stringify({ group: gDid, operationId: "stale-earlier-op-id" }),
          });
          assert.equal(supAbortRes.status, 200);
          assert.equal(((await supAbortRes.json()) as { status: string }).status, "superseded");

          // Complete staging on `ghTarget` just far enough to sign PLC cutover on `ghSource`, then ABORT before submitting to PLC
          // -> proves Source `'plc_signed'` `abort-migration` advances PLC head so the signed cutover op becomes invalid on PLC!
          const carForAbort = new Uint8Array(
            await (await fetch(`${ghSource.url}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(gDid)}`)).arrayBuffer(),
          );
          await fetch(`${ghTarget.url}/xrpc/com.atproto.repo.importRepo`, {
            method: "POST",
            headers: { "content-type": "application/vnd.ipld.car", authorization: `Bearer ${stageToks2.accessJwt}` },
            body: carForAbort,
          });
          for (const [bBytes, bMime] of [
            [blob2Bytes, "image/png"],
            [blob3MiBBytes, "application/octet-stream"],
          ] as const) {
            await fetch(`${ghTarget.url}/xrpc/com.atproto.repo.uploadBlob`, {
              method: "POST",
              headers: { "content-type": bMime, authorization: `Bearer ${stageToks2.accessJwt}` },
              body: Uint8Array.from(bBytes),
            });
          }
          const srcSpacesList = (await srcClient.xrpc.query<{ spaces: Array<{ space: string }> }>(
            "com.atproto.space.listSpaces",
          )).spaces;
          assert.ok(srcSpacesList.some((s) => s.space === personalInvitesUri(bob.did)), "listSpaces includes live external invite space");
          assert.ok(srcSpacesList.some((s) => s.space === personalInvitesUri(carol.did)), "listSpaces includes previously deleted external invite space");

          // Verify `MigrationManifestMismatch` (`409`) on partial space import (before all spaces are imported)!
          const partialCredsRes = await fetch(`${ghTarget.url}/xrpc/com.atproto.identity.getRecommendedDidCredentials`, {
            headers: { authorization: `Bearer ${stageToks2.accessJwt}` },
          });
          assert.equal(partialCredsRes.status, 409, "Partial space staging must fail getRecommendedDidCredentials with 409");
          const partialErr = (await partialCredsRes.json()) as { error: string };
          assert.ok(
            partialErr.error === "MigrationManifestMismatch" || partialErr.error === "MigrationStagingIncomplete",
          );

          for (const sp of srcSpacesList) {
            if (sp.space.startsWith(`at:space/${gDid}/`)) {
              const expM = await dpopSrc.fetchWithDpop(
                `${ghSource.url}/xrpc/com.atproto.space.exportSpaceMeta?space=${encodeURIComponent(sp.space)}`,
                { method: "GET", accessToken: tokSrc },
              );
              assert.equal(expM.status, 200, `exportSpaceMeta(${sp.space}) failed: ${await expM.clone().text()}`);
              const mBytes = new Uint8Array(await expM.arrayBuffer());
              const impM = await fetch(`${ghTarget.url}/xrpc/com.atproto.space.importSpaceMeta`, {
                method: "POST",
                headers: { "content-type": "application/vnd.dasl.star", authorization: `Bearer ${stageToks2.accessJwt}` },
                body: mBytes,
              });
              assert.equal(impM.status, 200, `importSpaceMeta(${sp.space}) failed: ${await impM.clone().text()}`);
            }
            const expR = await dpopSrc.fetchWithDpop(
              `${ghSource.url}/xrpc/com.atproto.space.getRepo?space=${encodeURIComponent(sp.space)}&repo=${encodeURIComponent(gDid)}`,
              { method: "GET", accessToken: tokSrc },
            );
            assert.equal(expR.status, 200, `space.getRepo(${sp.space}) failed: ${await expR.clone().text()}`);
            const rBytes = new Uint8Array(await expR.arrayBuffer());
            const impR = await fetch(`${ghTarget.url}/xrpc/com.atproto.space.importRepo`, {
              method: "POST",
              headers: { "content-type": "application/vnd.dasl.star", authorization: `Bearer ${stageToks2.accessJwt}` },
              body: rBytes,
            });
            assert.equal(impR.status, 200, `space.importRepo(${sp.space}) failed: ${await impR.clone().text()}`);
          }

          const recAbortCredsRes = await fetch(`${ghTarget.url}/xrpc/com.atproto.identity.getRecommendedDidCredentials`, {
            headers: { authorization: `Bearer ${stageToks2.accessJwt}` },
          });
          assert.equal(
            recAbortCredsRes.status,
            200,
            `Expected 200 from getRecommendedDidCredentials: ${await recAbortCredsRes.clone().text()}`,
          );
          const recAbortCreds = (await recAbortCredsRes.json()) as {
            rotationKeys: string[];
            alsoKnownAs: string[];
            verificationMethods: Record<string, string>;
            services: Record<string, { type: string; endpoint: string }>;
          };

          // Target-mismatched `signPlcOperation` (`endpoint = ghCompeting.url`) -> `409`!
          await srcClient.xrpc.procedure("com.atproto.identity.requestPlcOperationSignature", {});
          const { token: plcAbortTok } = await srcClient.claimActionToken("plc_operation");
          const mismatchSignErr = await captureXrpcError(() =>
            srcClient.xrpc.procedure("com.atproto.identity.signPlcOperation", {
              token: plcAbortTok,
              ...recAbortCreds,
              services: {
                atproto_pds: { type: "AtprotoPersonalDataServer", endpoint: ghCompeting.url },
              },
            }),
          );
          assert.equal(
            mismatchSignErr.status,
            409,
            `Expected 409 on target-mismatched signPlcOperation, got ${mismatchSignErr.status} ${mismatchSignErr.code}: ${mismatchSignErr.message}`,
          );

          // Valid `signPlcOperation` transitions `source_migration_lease.status` to `'plc_signed'`!
          const { operation: abortedSignedCutoverOp } = await srcClient.xrpc.procedure<
            unknown,
            { operation: Record<string, unknown> }
          >("com.atproto.identity.signPlcOperation", {
            token: plcAbortTok,
            ...recAbortCreds,
          });

          // While in `'plc_signed'`, Source private reads (`listSpaces`, `listJoinRequests`, `listModSubjects`, `getSpace`) return `409 MigrationCutoverPending`!
          for (const checkFn of [
            () => srcClient.xrpc.query("com.atproto.space.listSpaces"),
            () => srcClient.listJoinRequests(),
            () => srcClient.listModSubjects(),
            () => srcClient.xrpc.query("com.atproto.space.getSpace", { space: groupMetaUri(gDid) }),
          ]) {
            const cutPendErr = await captureXrpcError(checkFn);
            assert.equal(cutPendErr.status, 409);
            assert.equal(cutPendErr.code, "MigrationCutoverPending");
          }

          // Abort `'plc_signed'` on Source + Target (`purged`): advances PLC head so `abortedSignedCutoverOp` is rejected by PLC (`409`)!
          const plcSignedTicketId = prepPlcAbort.migrationTicket!.split(".")[1]!;
          const abortJwt3 = await ghSource.repoStore.signGroupServiceJwt({
            groupDid: gDid,
            aud: ghTarget.config.serviceDid,
            lxm: "group.opensocial.abortMigration",
          });
          const targetPurgeRes = await fetch(`${ghTarget.url}/group-admin/abort-migration`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${abortJwt3}` },
            body: JSON.stringify({ group: gDid, operationId: plcSignedAbortOpId, ticketId: plcSignedTicketId }),
          });
          assert.equal(targetPurgeRes.status, 200);
          assert.equal(((await targetPurgeRes.json()) as { status: string }).status, "purged");
          await srcClient.abortMigration(plcSignedAbortOpId);

          const stalePlcReplay = await fetch(`${pds.network.plc.url}/${encodeURIComponent(gDid)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(abortedSignedCutoverOp),
          });
          assert.ok(
            stalePlcReplay.status === 400 || stalePlcReplay.status === 409,
            `Source plc_signed abort-migration must advance PLC head to invalidate signed cutover op (got ${stalePlcReplay.status})`,
          );

          // 5. Final Full Coordinated Cutover (`ghSource -> ghTarget`):
          //    - All 7 negative `submitPlcOperation` checks
          //    - `plc_cutover_at` & post-PLC `migration_session` exemption from `absolute_deadline_at`
          //    - Barrier-tested concurrent `repo.importRepo`, `space.importSpaceMeta`, `space.importRepo`, `repo.uploadBlob` rejected after `submitPlcOperation`
          //    - Post-PLC `recovery` OAuth session check on Target
          //    - Target `activateAccount` crash failpoint (transient Source outage -> `ghTarget.flushBackgroundWork()` automatic `/group-admin/finalize-migrated-source`)
          //    - `3 MiB` + multi-blob integrity, uninstalled-bot tombstone, previously deleted external invite tracking, & non-migration of private queues/sessions!
          const finalOpId = `op-final-${randomUUID()}`;
          const prepFinal = await srcClient.prepareMigration(ghTarget.url, finalOpId);
          const { token: finalStageJwt } = await srcClient.xrpc.query<{ token: string }>(
            "com.atproto.server.getServiceAuth",
            { aud: ghTarget.config.serviceDid, lxm: "com.atproto.server.createAccount" },
          );
          const finalCreateRes = await fetch(`${ghTarget.url}/xrpc/com.atproto.server.createAccount`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${finalStageJwt}`,
              "x-group-migration-ticket": prepFinal.migrationTicket!,
            },
            body: JSON.stringify({ did: gDid, handle: "full.dst-mig.groups.localhost" }),
          });
          assert.equal(finalCreateRes.status, 200);
          const finalSess = (await finalCreateRes.json()) as { accessJwt: string; refreshJwt: string };

          // Import CAR + `3 MiB` & `64 KiB` blobs + all spaces (except hold 1 space back briefly to verify `MigrationManifestMismatch` on `submitPlcOperation` / `getRecommendedDidCredentials`!)
          const finalCar = new Uint8Array(
            await (await fetch(`${ghSource.url}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(gDid)}`)).arrayBuffer(),
          );
          await fetch(`${ghTarget.url}/xrpc/com.atproto.repo.importRepo`, {
            method: "POST",
            headers: { "content-type": "application/vnd.ipld.car", authorization: `Bearer ${finalSess.accessJwt}` },
            body: finalCar,
          });
          for (const [bBytes, bMime] of [
            [blob2Bytes, "image/png"],
            [blob3MiBBytes, "application/octet-stream"],
          ] as const) {
            const up = await fetch(`${ghTarget.url}/xrpc/com.atproto.repo.uploadBlob`, {
              method: "POST",
              headers: { "content-type": bMime, authorization: `Bearer ${finalSess.accessJwt}` },
              body: Uint8Array.from(bBytes),
            });
            assert.equal(up.status, 200);
          }

          let sampleMetaStar!: Uint8Array;
          let sampleRepoStar!: Uint8Array;
          for (const sp of srcSpacesList) {
            if (sp.space.startsWith(`at:space/${gDid}/`)) {
              const mBytes = new Uint8Array(
                await (
                  await dpopSrc.fetchWithDpop(
                    `${ghSource.url}/xrpc/com.atproto.space.exportSpaceMeta?space=${encodeURIComponent(sp.space)}`,
                    { method: "GET", accessToken: tokSrc },
                  )
                ).arrayBuffer(),
              );
              sampleMetaStar = mBytes;
              assert.equal(
                (
                  await fetch(`${ghTarget.url}/xrpc/com.atproto.space.importSpaceMeta`, {
                    method: "POST",
                    headers: { "content-type": "application/vnd.dasl.star", authorization: `Bearer ${finalSess.accessJwt}` },
                    body: mBytes,
                  })
                ).status,
                200,
              );
            }
            const rBytes = new Uint8Array(
              await (
                await dpopSrc.fetchWithDpop(
                  `${ghSource.url}/xrpc/com.atproto.space.getRepo?space=${encodeURIComponent(sp.space)}&repo=${encodeURIComponent(gDid)}`,
                  { method: "GET", accessToken: tokSrc },
                )
              ).arrayBuffer(),
            );
            sampleRepoStar = rBytes;
            assert.equal(
              (
                await fetch(`${ghTarget.url}/xrpc/com.atproto.space.importRepo`, {
                  method: "POST",
                  headers: { "content-type": "application/vnd.dasl.star", authorization: `Bearer ${finalSess.accessJwt}` },
                  body: rBytes,
                })
              ).status,
              200,
            );
          }

          const finalStatusBeforeCut = await (
            await fetch(`${ghTarget.url}/xrpc/com.atproto.server.checkAccountStatus`, {
              headers: { authorization: `Bearer ${finalSess.accessJwt}` },
            })
          ).json();
          assert.equal((finalStatusBeforeCut as { activated: boolean; expectedBlobs: number; importedBlobs: number }).activated, false);
          assert.equal((finalStatusBeforeCut as { importedBlobs: number }).importedBlobs, 2);

          const finalRecCreds = (await (
            await fetch(`${ghTarget.url}/xrpc/com.atproto.identity.getRecommendedDidCredentials`, {
              headers: { authorization: `Bearer ${finalSess.accessJwt}` },
            })
          ).json()) as {
            rotationKeys: string[];
            alsoKnownAs: string[];
            verificationMethods: Record<string, string>;
            services: Record<string, { type: string; endpoint: string }>;
          };
          const srcLocalRotDid = (await ghSource.repoStore.getGroupRotationKey(gDid))!.did();
          assert.ok(finalRecCreds.rotationKeys.includes(sovKey.did()), "Preserves external sovereign rotation key");
          assert.equal(finalRecCreds.rotationKeys.includes(srcLocalRotDid), false, "Drops retiring source rotation key");

          // Sign valid cutover PLC operation on `ghSource` (pulls Target `/group-admin/migration-attestation`!)
          await srcClient.xrpc.procedure("com.atproto.identity.requestPlcOperationSignature", {});
          const { token: finalPlcTok } = await srcClient.claimActionToken("plc_operation");
          const { operation: validCutoverOp } = await srcClient.xrpc.procedure<
            unknown,
            { operation: Record<string, unknown> }
          >("com.atproto.identity.signPlcOperation", {
            token: finalPlcTok,
            ...finalRecCreds,
          });

          // Test ALL 7 negative `submitPlcOperation` validations on `ghTarget` before submitting `validCutoverOp`!
          const submitCandidateOp = async (op: Record<string, unknown>) =>
            fetch(`${ghTarget.url}/xrpc/com.atproto.identity.submitPlcOperation`, {
              method: "POST",
              headers: { "content-type": "application/json", authorization: `Bearer ${finalSess.accessJwt}` },
              body: JSON.stringify({ operation: op }),
            });

          const rogueKey = await P256Keypair.create({ exportable: true });
          const curPrev = String(validCutoverOp.prev);
          const negCases: Array<[string, Record<string, unknown>]> = [
            ["wrong prev", await signOperation({ ...(validCutoverOp as never), prev: "bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku" }, sovKey)],
            ["invalid signature", { ...validCutoverOp, sig: Buffer.from(randomBytes(64)).toString("base64url") }],
            ["retained source rotationKey", await signOperation({ ...(validCutoverOp as never), prev: curPrev, rotationKeys: [...finalRecCreds.rotationKeys, srcLocalRotDid] }, sovKey)],
            ["dropped sovereign rotationKey", await signOperation({ ...(validCutoverOp as never), prev: curPrev, rotationKeys: finalRecCreds.rotationKeys.filter((k) => k !== sovKey.did()) }, sovKey)],
            ["wrong #atproto_pds endpoint", await signOperation({ ...(validCutoverOp as never), prev: curPrev, services: { atproto_pds: { type: "AtprotoPersonalDataServer", endpoint: ghCompeting.url } } }, sovKey)],
            ["wrong #atproto / #atproto_kem keys", await signOperation({ ...(validCutoverOp as never), prev: curPrev, verificationMethods: { ...finalRecCreds.verificationMethods, atproto: rogueKey.did() } }, sovKey)],
            ["wrong alsoKnownAs handle", await signOperation({ ...(validCutoverOp as never), prev: curPrev, alsoKnownAs: ["at://wrong-handle.dst-mig.groups.localhost"] }, sovKey)],
          ];
          for (const [label, badOp] of negCases) {
            const negRes = await submitCandidateOp(badOp);
            assert.equal(negRes.ok, false, `Target submitPlcOperation must reject ${label}`);
          }

          // Submit valid cutover op -> sets `plc_cutover_at`!
          const okSubRes = await submitCandidateOp(validCutoverOp);
          assert.equal(okSubRes.status, 200, `Valid submitPlcOperation failed: ${await okSubRes.clone().text()}`);
          const migRowAfterPlc = ghTarget.db
            .prepare("SELECT plc_cutover_at FROM migration_session WHERE group_did = ?")
            .get(gDid) as { plc_cutover_at: number | null };
          assert.ok(typeof migRowAfterPlc.plc_cutover_at === "number" && migRowAfterPlc.plc_cutover_at > 0);

          // Barrier-tested concurrent `repo.importRepo`, `space.importSpaceMeta`, `space.importRepo`, & `repo.uploadBlob`
          // MUST be rejected after `submitPlcOperation` (`plc_cutover_at !== null`)!
          let releaseTargetLock!: () => void;
          const targetLockHeld = new Promise<void>((ready) => {
            void ghTarget.locks.withGroupRepoLock(gDid, async () => {
              ready();
              await new Promise<void>((r) => {
                releaseTargetLock = r;
              });
            });
          });
          await targetLockHeld;

          const postPlcImports = Promise.all([
            fetch(`${ghTarget.url}/xrpc/com.atproto.repo.importRepo`, {
              method: "POST",
              headers: { "content-type": "application/vnd.ipld.car", authorization: `Bearer ${finalSess.accessJwt}` },
              body: finalCar,
            }),
            fetch(`${ghTarget.url}/xrpc/com.atproto.space.importSpaceMeta`, {
              method: "POST",
              headers: { "content-type": "application/vnd.dasl.star", authorization: `Bearer ${finalSess.accessJwt}` },
              body: sampleMetaStar,
            }),
            fetch(`${ghTarget.url}/xrpc/com.atproto.space.importRepo`, {
              method: "POST",
              headers: { "content-type": "application/vnd.dasl.star", authorization: `Bearer ${finalSess.accessJwt}` },
              body: sampleRepoStar,
            }),
            fetch(`${ghTarget.url}/xrpc/com.atproto.repo.uploadBlob`, {
              method: "POST",
              headers: { "content-type": "image/png", authorization: `Bearer ${finalSess.accessJwt}` },
              body: Uint8Array.from(blob2Bytes),
            }),
          ]);
          releaseTargetLock();
          const postPlcResList = await postPlcImports;
          for (const r of postPlcResList) {
            assert.equal(r.ok, false, `Staging write after submitPlcOperation must be rejected (got ${r.status})`);
          }

          // Post-PLC `migration_session` is exempt from `absolute_deadline_at` expiry AND post-PLC `recovery` OAuth login works!
          const origDeadlineRow = ghTarget.db
            .prepare("SELECT absolute_deadline_at FROM migration_session WHERE group_did = ?")
            .get(gDid) as { absolute_deadline_at: number };
          ghTarget.db
            .prepare("UPDATE migration_session SET absolute_deadline_at = ? WHERE group_did = ?")
            .run(Date.now() - 10_000, gDid);
          const statusPastDeadline = await fetch(`${ghTarget.url}/xrpc/com.atproto.server.checkAccountStatus`, {
            headers: { authorization: `Bearer ${finalSess.accessJwt}` },
          });
          assert.equal(statusPastDeadline.status, 200, "Post-PLC migration_session must be exempt from absolute_deadline_at expiry");
          ghTarget.db
            .prepare("UPDATE migration_session SET absolute_deadline_at = ? WHERE group_did = ?")
            .run(origDeadlineRow.absolute_deadline_at, gDid);

          const postPlcRecoveryOAuth = await completeRealGroupOAuthFlow({
            groupHost: ghTarget,
            actor: alice,
            scope: adminScopeStr,
            prompt: "login",
            loginHint: gDid,
          });
          assert.ok(postPlcRecoveryOAuth.tokenResponse, "Post-PLC unactivated Target must allow recovery OAuth login");

          // Simulate transient Source outage during `activateAccount` AND client crash right after `activateAccount`
          // (client NEVER calls `deactivateAccount` on `ghSource`!) -> `ghTarget.flushBackgroundWork()` retries durable
          // `/group-admin/finalize-migrated-source` and shuts down `ghSource` automatically!
          simulateSourceFinalizeOutage = true;
          const actFinalRes = await fetch(`${ghTarget.url}/xrpc/com.atproto.server.activateAccount`, {
            method: "POST",
            headers: { authorization: `Bearer ${finalSess.accessJwt}` },
          });
          assert.equal(actFinalRes.status, 200, `Target activateAccount failed: ${await actFinalRes.clone().text()}`);

          // Advance outbox retry window and restore reachability -> `ghTarget.flushBackgroundWork()` finalizes `ghSource`!
          simulateSourceFinalizeOutage = false;
          ghTarget.db
            .prepare("UPDATE outbox_notice SET next_attempt_at = 0, lease_until = NULL WHERE group_did = ?")
            .run(gDid);
          await drainGroupHost(ghTarget);

          const srcAfterFin = ghSource.db
            .prepare("SELECT activated FROM group_account WHERE did = ?")
            .get(gDid) as { activated: number };
          assert.equal(srcAfterFin.activated, 0, "Source must be automatically finalized to activated=0 without client deactivateAccount");
          const srcLeaseAfterFin = ghSource.db
            .prepare("SELECT 1 AS ok FROM source_migration_lease WHERE group_did = ?")
            .get(gDid);
          assert.equal(srcLeaseAfterFin, undefined);

          // Source OAuth refresh is now rejected (`400 invalid_grant`)!
          const srcRefreshAfterFin = await dpopSrc.fetchWithDpop(`${ghSource.url}/oauth/token`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "refresh_token",
              refresh_token: refTokSrc,
              client_id: `http://localhost?${new URLSearchParams({
                scope: adminScopeStr,
                redirect_uri: "http://127.0.0.1:43123/callback",
              }).toString()}`,
            }).toString(),
          });
          assert.equal(srcRefreshAfterFin.status, 400);

          // Verify Target state:
          // - `3 MiB` + `64 KiB` blobs match byte-for-byte!
          // - Private queues/history/sessions (`join_request`, `mod_subject`, `mod_event`, Source `oauth_session`) did NOT migrate!
          // - Uninstalled-bot tombstone (`known_app_subject`) & previously deleted external invite (`carol` in `group_invite_target`) DID migrate!
          const fetched3MiB = Buffer.from(
            await (
              await fetch(
                `${ghTarget.url}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(gDid)}&cid=${encodeURIComponent(blob3MiBRef.ref.$link)}`,
              )
            ).arrayBuffer(),
          );
          assert.equal(fetched3MiB.length, blob3MiBBytes.length);
          assert.equal(fetched3MiB.equals(blob3MiBBytes), true, "3 MiB (> 2 MB) blob migrated byte-for-byte");

          const dstAdminFlow = await completeRealGroupOAuthFlow({
            groupHost: ghTarget,
            actor: alice,
            scope: adminScopeStr,
            prompt: "login",
            loginHint: gDid,
          });
          const dstClient = makeGroupClient(
            ghTarget,
            gDid,
            dstAdminFlow.dpop,
            dstAdminFlow.tokenResponse!.access_token,
          );
          assert.equal((await dstClient.listJoinRequests()).requests.length, 0, "Pending join_request queue must NOT migrate");
          assert.equal((await dstClient.listModSubjects()).subjects.length, 0, "Private mod_subject/mod_event history must NOT migrate");

          const botRowOnDst = ghTarget.db
            .prepare("SELECT subject_did FROM known_app_subject WHERE group_did = ? AND subject_did = ?")
            .get(gDid, botActor.did) as { subject_did: string } | undefined;
          assert.equal(botRowOnDst?.subject_did, botActor.did, "Uninstalled bot tombstone reconstructed in known_app_subject");

          const inviteTargetsOnDst = ghTarget.db
            .prepare("SELECT invitee_did FROM group_invite_target WHERE group_did = ? ORDER BY invitee_did ASC")
            .all(gDid) as Array<{ invitee_did: string }>;
          assert.deepEqual(
            inviteTargetsOnDst.map((r) => r.invitee_did),
            [bob.did, carol.did].sort(),
            "Both live (bob) and previously deleted (carol) external invite targets reconstructed on Target Host",
          );
          assert.equal((await bobEng.workspaces.listInvites())[0]?.uri, bobLiveInv.uri, "Live cross-PDS invite resolves from Target Host");

          // 6. Flock-to-Flock Standard / Negotiated `public-group-keys` Return Migration (`ghTarget -> ghSource`, `A -> B -> A` with `useCoordinated: false`)
          //    + Migrate-then-delete proving previously deleted external invite (`carol`) & live invite (`bob`) both receive cleared commits!
          const returnMig = await dstClient.migrateToHost(ghSource.url, {
            handle: "returned.src-mig.groups.localhost",
            useCoordinated: false,
          });
          assert.equal(returnMig.mode, "standard");
          await drainGroupHost(ghSource);

          const returnedFlow = await completeRealGroupOAuthFlow({
            groupHost: ghSource,
            actor: alice,
            scope: adminScopeStr,
            prompt: "login",
            loginHint: gDid,
          });
          const returnedClient = makeGroupClient(
            ghSource,
            gDid,
            returnedFlow.dpop,
            returnedFlow.tokenResponse!.access_token,
          );
          assert.equal((await returnedClient.checkAccountStatus()).activated, true);

          // Round 19 Fix #1 E2E: Real `GroupClient` against real `GroupHost` (`ghSource -> ghTarget`) with browser-scoped
          // `groupAdminScopes()` (`adminScopeStr`, no `groupDid`) recovers from lost Target purge response AFTER `accessJwt` expires!
          {
            let stopAfterCreate = true;
            let dropTargetPurgeOnce = false;
            let clientClockOffsetMs = 0;
            const r19StateMap = new Map<string, InFlightGroupMigration>();
            const makeR19E2eClient = () =>
              new GroupClient({
                groupDid: gDid,
                fetchHandler: (path, init) =>
                  returnedFlow.dpop.fetchWithDpop(`${ghSource.url}${path}`, {
                    method: init?.method ?? "GET",
                    headers: init?.headers as Record<string, string> | undefined,
                    ...(init?.body !== undefined ? { body: init.body as BodyInit } : {}),
                    accessToken: returnedFlow.tokenResponse!.access_token,
                  }),
                fetchEndpoint: async (req: Request) => {
                  const u = new URL(req.url);
                  if (stopAfterCreate && u.pathname === "/xrpc/com.atproto.repo.importRepo") {
                    throw new TypeError("stop after real createAccount staged on ghTarget");
                  }
                  const res = await fetch(req);
                  if (dropTargetPurgeOnce && u.pathname === "/group-admin/abort-migration") {
                    dropTargetPurgeOnce = false;
                    throw new TypeError("lost response after ghTarget purged migration_session");
                  }
                  return res;
                },
                migrationState: createInMemoryMigrationStateStore(r19StateMap),
                now: () => Date.now() + clientClockOffsetMs,
              });

            await assert.rejects(
              makeR19E2eClient().migrateToHost(ghTarget.url, {
                handle: "r19-abort.dst-mig.groups.localhost",
                operationId: "3lblr22e2eabt",
              }),
              /stop after real createAccount staged on ghTarget/,
            );
            stopAfterCreate = false;
            assert.equal(r19StateMap.get(gDid)?.phase, "account_created");

            dropTargetPurgeOnce = true;
            await assert.rejects(
              makeR19E2eClient().abortMigration(),
              /lost response after ghTarget purged migration_session/,
            );
            assert.equal(
              ghTarget.db.prepare("SELECT 1 FROM migration_session WHERE group_did = ?").get(gDid),
              undefined,
              "ghTarget already purged migration_session before HTTP response dropped",
            );

            // Advance GroupClient clock +20m past Target `accessJwt` expiry so `refreshSession` hits real 401 on `ghTarget`
            // and `GroupClient` mints a real `group.opensocial.abortMigration` service JWT via `ghSource` `getServiceAuth`!
            clientClockOffsetMs = 20 * 60_000;
            const recoveredAbort = await makeR19E2eClient().abortMigration();
            assert.equal(recoveredAbort.status, "aborted");
            assert.equal(r19StateMap.get(gDid), undefined);
            assert.equal(
              ghSource.db.prepare("SELECT 1 FROM source_migration_lease WHERE group_did = ?").get(gDid),
              undefined,
              "ghSource migration lease cleanly aborted via real service-JWT fallback",
            );
          }

          // Now run `deleteAccount` on `ghSource` after `A -> B -> A` migration -> drains cleared commits for both `bob` & `carol` and purges!
          await returnedClient.requestAccountDelete();
          const { token: finalDelTok } = await returnedClient.claimActionToken("delete_account");
          await returnedClient.deleteAccount(finalDelTok);
          assert.deepEqual(await bobEng.workspaces.listInvites(), []);
          assert.deepEqual(await carolEng.workspaces.listInvites(), []);
        } finally {
          await ghTinyLimit.close();
          await ghCompeting.close();
          await ghTarget.close();
          await ghSource.close();
        }
      },
    );
  } finally {
    await pds.close();
  }
});
