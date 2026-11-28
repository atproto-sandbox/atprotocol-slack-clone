import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { chromium, type Browser, type Page } from "@playwright/test";
import { NodeOAuthClient, type NodeSavedSession, type NodeSavedState, type OAuthSession } from "@atproto/oauth-client-node";
import { verifyJwt } from "@atproto/xrpc-server";
import { Probe } from "../support/sync-dataset";
import { countByOrigin, watchPreflights, type Preflight } from "../support/browser-network";
import {
  acceptGroupMembership,
  bearerSession,
  combinedMemberScopes,
  createOpenSocialGroup,
  outcome,
  startPdsNetwork,
  type NetworkActor,
  type Outcome,
  type PdsNetwork,
} from "../support/pds-network";

// K9 of `.ai/plans/platform-refactor.md`, migrated to R13 OpenSocial groups: can a page on the web app's origin talk to
// the protocol hosts directly? The web origin, the two personal PDS hosts, the OpenSocial Group Host (`pds.groupHostUrl`),
// the PLC directory, and a stand-in for the operator are distinct origins. Each account signs in through the real OAuth flow
// in the browser with the combined member grant, and every request the client makes afterwards (PAR, token exchange,
// DPoP-bound XRPC, DID documents, Group Host credential exchange, MAC-bearing reads on both personal PDS and Group Host,
// direct OpenSocial XRPC to Group Host, and the operator call) is sent by the browser from the web origin.

const OPERATOR_METHOD = "new.flock.operator.getChanges";

type BrowserFailure = { method: string; url: string; error: string };
type BrowserMember = {
  actor: NetworkActor; page: Page; session: OAuthSession; browserFetch(request: Request): Promise<Response>; failures: BrowserFailure[]; preflights: Preflight[];
};

test("a page on the web origin signs in, reaches personal PDS hosts, Group Host, PLC, and operator origins directly (K9 / R13)", { timeout: 300_000 }, async (t) => {
  const pds = await startPdsNetwork("cross-origin");
  const servers: Server[] = [];
  let browser: Browser | undefined;
  try {
    const web = await listen((request, response) => { response.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>${request.url}</title>`); });
    servers.push(web.server);
    const operatorPreflights: string[] = [];
    const operator = await listen(operatorStandIn(pds.serviceRef, operatorPreflights));
    servers.push(operator.server);
    const unreachable = await closedOrigin();
    browser = await chromium.launch({ headless: true });

    // given an OpenSocial group on Group Host with a writer on PDS 0, a member on PDS 1, and an outsider on PDS 1
    const { groupDid, writer, member, outsider, channel, rkey } = await provision(pds);
    const memberSide = await signInThroughBrowser(browser, web.origin, pds, member);
    const outsiderSide = await signInThroughBrowser(browser, web.origin, pds, outsider);

    // when the member's and outsider's clients run each step through the browser
    const results = await steps(pds, { groupDid, writer, memberSide, outsiderSide, channel, rkey, operatorOrigin: operator.origin, unreachableOrigin: unreachable });

    // then each capability holds, and only the unreachable host fails at the network level. The OAuth client also checks
    // each handle at https://<handle>/.well-known/atproto-did; the fixture's handles are not real domains, so those lookups
    // fail in any client and are reported apart.
    const all = [...memberSide.failures, ...outsiderSide.failures];
    const handleChecks = all.filter((failure) => new URL(failure.url).pathname === "/.well-known/atproto-did" && /\.test2?$/.test(new URL(failure.url).hostname));
    const failures = all.filter((failure) => !handleChecks.includes(failure));
    const preflights = [...memberSide.preflights, ...outsiderSide.preflights];
    const byOrigin = countByOrigin(preflights);
    const failedPreflights = preflights.filter((preflight) => !/^2\d\d$/.test(preflight.outcome) && new URL(preflight.url).origin !== unreachable);
    for (const [step, result] of Object.entries(results)) t.diagnostic(`${step}: ${result.ok ? "ok" : result.error}`);
    t.diagnostic(`preflights the browser sent: ${preflights.length}, per origin: ${JSON.stringify(byOrigin)}`);
    t.diagnostic(`preflights that failed, apart from the unreachable host: ${failedPreflights.map((preflight) => `${preflight.url} (${preflight.outcome})`).join("; ") || "none"}`);
    t.diagnostic(`operator preflights: ${operatorPreflights.join(", ") || "none"}`);
    t.diagnostic(`fixture handle checks that cannot resolve: ${handleChecks.length}`);
    t.diagnostic(`browser-level fetch failures: ${failures.map((failure) => `${failure.method} ${failure.url} (${failure.error})`).join("; ") || "none"}`);
    assert.deepEqual(Object.entries(results).filter(([, result]) => !result.ok).map(([step]) => step), []);
    assert.ok((byOrigin[new URL(pds.groupHostUrl).origin] ?? 0) > 0, "browser sent CORS preflights to Group Host origin");
    assert.ok((byOrigin[new URL(writer.pds.url).origin] ?? 0) > 0, "browser sent CORS preflights to writer personal PDS origin");
    assert.ok((byOrigin[new URL(member.pds.url).origin] ?? 0) > 0, "browser sent CORS preflights to member personal PDS origin");
    assert.ok((byOrigin[operator.origin] ?? 0) > 0, "browser sent CORS preflights to operator origin");
    assert.deepEqual(failures.map((failure) => new URL(failure.url).origin), [unreachable], "only the unreachable host fails in the browser");
    assert.deepEqual(failedPreflights, [], "every preflight the browser sent succeeded");
  } finally {
    await browser?.close();
    await Promise.all(servers.map(close));
    await pds.close();
  }
});

async function steps(pds: PdsNetwork, input: {
  groupDid: string; writer: NetworkActor; memberSide: BrowserMember; outsiderSide: BrowserMember; channel: string; rkey: string; operatorOrigin: string; unreachableOrigin: string;
}): Promise<Record<string, Outcome>> {
  const [{ mintSpaceCredentialWith, isAccessLost }, { generateSpaceKey }, { kemKeyFromDidDocument }, { sessionClient }, { groupMetaUri, tidNow }, { ATGRP_COLLECTION, ATGRP_METHOD, COLLECTION }] = await Promise.all([
    import("@flock/protocol/atproto/space-credential-core"),
    import("@flock/protocol/atproto/space-key"),
    import("@flock/protocol/atproto/kem-key"),
    import("@flock/operator/atproto/client"),
    import("@flock/protocol/keys"),
    import("@flock/protocol/nsids"),
  ]);
  const deps = (side: BrowserMember) => ({
    memberClient: sessionClient(side.session),
    resolvePds: async (did: string) => pdsEndpoint(did, await didDocument(side, pds, did)),
    resolveKemKey: async (did: string) => kemKeyFromDidDocument(did, await didDocument(side, pds, did)),
    fetchEndpoint: side.browserFetch,
    generateKey: generateSpaceKey,
  });
  const { memberSide, outsiderSide } = input;
  const results: Record<string, Outcome> = {};
  results["mints a channel credential (member host, then Group Host)"] = await outcome(() => mintSpaceCredentialWith(deps(memberSide), input.channel));
  results["renews the credential and reads writer's record with the renewed one, verifying its MAC"] = await outcome(async () => {
    await mintSpaceCredentialWith(deps(memberSide), input.channel);
    const renewed = await mintSpaceCredentialWith(deps(memberSide), input.channel);
    const record = await renewed.client(input.writer.pds.url).query<{ value: { text?: string } }>("com.atproto.space.getRecord", {
      space: input.channel, repo: input.writer.did, collection: COLLECTION.message, rkey: input.rkey,
    });
    assert.equal(record.value.text, "k9 from the authority host");
  });
  results["reads group profile directly from Group Host with RFC 9421 MAC verification"] = await outcome(async () => {
    const metaSpace = groupMetaUri(input.groupDid);
    const metaCred = await mintSpaceCredentialWith(deps(memberSide), metaSpace);
    const about = await metaCred.client(pds.groupHostUrl).query<{ value: { displayName?: string } }>("com.atproto.space.getRecord", {
      space: metaSpace, repo: input.groupDid, collection: ATGRP_COLLECTION.about, rkey: "self",
    });
    assert.equal(about.value.displayName, "K9 Group");
  });
  results["lists writers at the Group Host authority"] = await outcome(async () => {
    const credential = await mintSpaceCredentialWith(deps(memberSide), input.channel);
    await credential.client(pds.groupHostUrl).query("com.atproto.space.listWriters", { space: input.channel });
  });
  results["writes a message to its own host with its DPoP-bound session"] = await outcome(() => sessionClient(memberSide.session).procedure("com.atproto.space.createRecord", {
    space: input.channel, repo: memberSide.actor.did, collection: COLLECTION.message, rkey: tidNow(),
    record: { $type: COLLECTION.message, text: "k9 from the browser", createdAt: new Date().toISOString() },
  }));
  results["calls Group Host Atmosphere Groups XRPC directly with a service token"] = await outcome(async () => {
    const { token } = await sessionClient(outsiderSide.session).query<{ token: string }>("com.atproto.server.getServiceAuth", {
      aud: `${input.groupDid}#atproto_pds`,
      lxm: ATGRP_METHOD.requestJoin,
    });
    const response = await outsiderSide.browserFetch(new Request(new URL(`/xrpc/${ATGRP_METHOD.requestJoin}`, pds.groupHostUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ group: input.groupDid, message: "k9 cross-origin join request" }),
    }));
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json() as { status?: string }).status, "pending");
  });
  results["calls the operator origin with a service token"] = await outcome(async () => {
    const { token } = await sessionClient(memberSide.session).query<{ token: string }>("com.atproto.server.getServiceAuth", { aud: pds.serviceRef, lxm: OPERATOR_METHOD });
    const response = await memberSide.browserFetch(new Request(new URL(`/xrpc/${OPERATOR_METHOD}?space=${encodeURIComponent(input.channel)}`, input.operatorOrigin), {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    }));
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json() as { issuer?: string }).issuer, memberSide.actor.did);
  });
  results["a non-member holding the same grant is refused at Group Host, and the page can read why"] = await outcome(async () => {
    const refusal = await mintSpaceCredentialWith(deps(outsiderSide), input.channel).then(() => null, (error: unknown) => error);
    assert.ok(refusal && isAccessLost(refusal), String(refusal));
  });
  results["an unreachable writer host fails as a network error"] = await outcome(async () => {
    const credential = await mintSpaceCredentialWith(deps(memberSide), input.channel);
    const failure = await credential.client(input.unreachableOrigin).query("com.atproto.space.listRecords", {
      space: input.channel, repo: memberSide.actor.did, collection: COLLECTION.message,
    }).then(() => null, (error: unknown) => error);
    assert.ok(failure instanceof TypeError, `expected a network-level TypeError, got ${String(failure)}`);
  });
  return results;
}

/**
 * The real authorization-code flow for a public loopback client whose redirect lands on the web origin: the browser loads
 * the PDS sign-in and consent pages, and every request the OAuth client makes goes through the page.
 */
async function signInThroughBrowser(browser: Browser, webOrigin: string, pds: PdsNetwork, actor: NetworkActor): Promise<BrowserMember> {
  const page = await (await browser.newContext()).newPage();
  page.setDefaultTimeout(30_000);
  const preflights = await watchPreflights(page);
  await page.goto(webOrigin);
  const failures: BrowserFailure[] = [];
  const browserFetch = (request: Request) => fetchFromPage(page, request, failures);
  const scope = ["atproto", ...await combinedMemberScopes(pds.serviceRef)].join(" ");
  const redirectUri = `${webOrigin}/callback`;
  const states = new Map<string, NodeSavedState>();
  const sessions = new Map<string, NodeSavedSession>();
  const client = new NodeOAuthClient({
    clientMetadata: {
      client_id: `http://localhost?${new URLSearchParams({ scope, redirect_uri: redirectUri }).toString()}`,
      redirect_uris: [redirectUri],
      scope,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
      dpop_bound_access_tokens: true,
    },
    fetch: (input, init) => browserFetch(new Request(input, init)),
    allowHttp: true,
    plcDirectoryUrl: pds.plcUrl,
    stateStore: { get: async (key) => states.get(key), set: async (key, value) => { states.set(key, value); }, del: async (key) => { states.delete(key); } },
    sessionStore: { get: async (key) => sessions.get(key), set: async (key, value) => { sessions.set(key, value); }, del: async (key) => { sessions.delete(key); } },
  });
  await page.goto((await client.authorize(actor.did, { scope })).toString());
  await page.locator("input[name=password]").waitFor({ state: "visible" });
  await page.locator("input[name=password]").fill(actor.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Authorize", exact: true }).click();
  await page.waitForURL(`${redirectUri}?**`);
  const { session } = await client.callback(new URL(page.url()).searchParams);
  assert.equal(session.did, actor.did);
  return { actor, page, session, browserFetch, failures, preflights };
}

async function provision(pds: PdsNetwork): Promise<{ groupDid: string; writer: NetworkActor; member: NetworkActor; outsider: NetworkActor; channel: string; rkey: string }> {
  const [
    { restoreAuthorityGrant },
    { ensureOpenSocialSpace, putAuthorityRecord },
    { defaultPublicChannelPolicy },
    { AtprotoClient },
    { groupMembersUri, tidNow },
    { ATGRP_COLLECTION, COLLECTION, SPACE_TYPE },
  ] = await Promise.all([
    import("@flock/operator/operator/authority-grant"),
    import("@flock/operator/atproto/space-ops"),
    import("@flock/operator/operator/workspace-spaces"),
    import("@flock/protocol/atproto/xrpc"),
    import("@flock/protocol/keys"),
    import("@flock/protocol/nsids"),
  ]);
  const writer = await pds.createActor("k9owner", 0);
  const member = await pds.createActor("k9member", 1);
  const outsider = await pds.createActor("k9outsider", 1);

  const createdGroup = await createOpenSocialGroup(pds, writer, {
    name: "K9 Group",
    joinPolicy: "approval",
  });
  const groupSession = await restoreAuthorityGrant(createdGroup.groupDid);
  const channel = await ensureOpenSocialSpace(groupSession, SPACE_TYPE.channel, "general", defaultPublicChannelPolicy());
  await putAuthorityRecord(groupSession, groupMembersUri(createdGroup.groupDid), ATGRP_COLLECTION.membership, member.did, {
    roles: ["member"],
    createdAt: new Date().toISOString(),
  });
  await acceptGroupMembership(pds, member, createdGroup.groupDid);

  const rkey = tidNow();
  await new AtprotoClient(bearerSession(writer).fetchHandler).procedure("com.atproto.space.createRecord", {
    space: channel,
    repo: writer.did,
    collection: COLLECTION.message,
    rkey,
    record: { $type: COLLECTION.message, text: "k9 from the authority host", createdAt: new Date().toISOString() },
  });
  await new Probe(pds, member, channel).waitForCurrentRevision(writer.did);
  return { groupDid: createdGroup.groupDid, writer, member, outsider, channel, rkey };
}

async function didDocument(side: BrowserMember, pds: PdsNetwork, did: string): Promise<{ service?: Array<{ id?: string; serviceEndpoint?: unknown }>; verificationMethod?: unknown }> {
  const response = await side.browserFetch(new Request(new URL(`/${encodeURIComponent(did)}`, pds.plcUrl)));
  assert.equal(response.status, 200, `the page reads the DID document of ${did}`);
  return await response.json() as { service?: Array<{ id?: string; serviceEndpoint?: unknown }> };
}

function pdsEndpoint(did: string, document: { service?: Array<{ id?: string; serviceEndpoint?: unknown }> }): string {
  const endpoint = document.service?.find((service) => service.id === "#atproto_pds" || service.id === `${did}#atproto_pds`)?.serviceEndpoint;
  if (typeof endpoint !== "string") throw new Error(`No PDS in the DID document of ${did}.`);
  return endpoint;
}

/** Sends `request` with `fetch` inside the page, so the browser's CORS rules apply, and returns what the page could read. */
async function fetchFromPage(page: Page, request: Request, failures: BrowserFailure[]): Promise<Response> {
  const headers = Object.fromEntries(request.headers.entries());
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
  const answer = await page.evaluate(async ({ url, method, headers, body }) => {
    try {
      const response = await fetch(url, { method, headers, body, redirect: "error" });
      const readable: Record<string, string> = {};
      response.headers.forEach((value, name) => { readable[name] = value; });
      return { ok: true as const, status: response.status, headers: readable, body: await response.text() };
    } catch (error) {
      return { ok: false as const, error: String(error) };
    }
  }, { url: request.url, method: request.method, headers, body });
  if (!answer.ok) {
    failures.push({ method: request.method, url: request.url, error: answer.error });
    throw new TypeError(`${answer.error} (${request.method} ${request.url})`);
  }
  return new Response([101, 204, 205, 304].includes(answer.status) ? null : answer.body, { status: answer.status, headers: answer.headers });
}

/** A stand-in for the operator's methods, with its CORS rule: any origin, the bearer token's header admitted, no credentials. */
function operatorStandIn(serviceRef: string, preflights: string[]): (request: IncomingMessage, response: ServerResponse) => void {
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST" };
  return (request, response) => {
    if (request.method === "OPTIONS") {
      preflights.push(`${request.headers["access-control-request-method"]} ${request.url?.split("?")[0]} [${request.headers["access-control-request-headers"]}]`);
      response.writeHead(204, cors).end();
      return;
    }
    const token = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? "";
    void (async () => {
      const { getIdResolver } = await import("@flock/operator/atproto/identity");
      try {
        const payload = await verifyJwt(token, serviceRef, OPERATOR_METHOD, async (issuer) => getIdResolver().did.resolveAtprotoKey(issuer.split("#", 1)[0]!));
        response.writeHead(200, { ...cors, "content-type": "application/json" }).end(JSON.stringify({ issuer: payload.iss }));
      } catch (error) {
        response.writeHead(401, { ...cors, "content-type": "application/json" }).end(JSON.stringify({ error: "Unauthorized", message: String(error) }));
      }
    })();
  };
}

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ server: Server; origin: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function closedOrigin(): Promise<string> {
  const { server, origin } = await listen(() => undefined);
  await close(server);
  return origin;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
