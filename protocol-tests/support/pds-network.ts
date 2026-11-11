import { once } from "node:events";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { asAtprotoDid, asAtprotoOAuthScope, jwkSchema, NodeOAuthClient, oauthClientMetadataSchema, type NodeSavedSession, type NodeSavedState, type OAuthSession } from "@atproto/oauth-client-node";
import { kemKeyFromDidDocument } from "@flock/protocol/atproto/kem-key";
import { generateSpaceKey } from "@flock/protocol/atproto/space-key";
import { AtprotoClient } from "@flock/protocol/atproto/xrpc";
import { createFixtureTempRoot } from "../fixture-temp";

// The pinned PDS network without the Next app: two in-memory PDS hosts, a PLC directory and the app's lexicons published
// to the fixture's lexicon authority. Server-side app modules imported after `startPdsNetwork` see a configured
// environment (APP_URL, DATABASE_PATH, PLC_URL, the operator service ref and a fresh encryption key).

export type TestAgent = {
  com: { atproto: {
    server: {
      createAccount(input: Record<string, unknown>): Promise<{ data: { did: string; accessJwt: string } }>;
      createSession(input: Record<string, unknown>): Promise<{ data: { did: string; accessJwt: string } }>;
      createAppPassword(input: Record<string, unknown>, options: { headers: { authorization: string } }): Promise<{ data: { name: string; password: string } }>;
    };
    repo: { createRecord(input: Record<string, unknown>, options: { headers: { authorization: string } }): Promise<unknown> };
  } };
};

type ProviderToken = { access_token: string; expires_in: number; refresh_token?: string; scope?: string };

export type TestPds = {
  url: string;
  getAgent(): TestAgent;
  ctx: {
    cfg: { service: { did: string }; oauth: { issuer: string } };
    oauthProvider?: {
      tokenManager: {
        createToken(...args: unknown[]): Promise<ProviderToken>;
        findToken(token: string): Promise<{ id: unknown } | null>;
        deleteToken(tokenId: unknown): Promise<void>;
      };
      clientManager: { getClient(clientId: string): Promise<{ id: string; validateRequest(parameters: Record<string, unknown>): unknown }> };
      accountManager: { getAccount(did: string): Promise<{ account: unknown }> };
    };
    accountManager: { db: { db: ProviderTokenTable } };
  };
};

type ProviderTokenTable = {
  updateTable(table: "token"): { set(values: Record<string, string>): { where(column: "tokenId", operator: "=", value: unknown): { execute(): Promise<unknown> } } };
};

export type TestNetwork = { plc: { url: string }; pds: TestPds; extraPdses: TestPds[]; lexiconAuthority?: { did: string }; close(): Promise<void> };

export type NetworkActor = { did: string; handle: string; password: string; accessJwt: string; pds: TestPds };

/** A bearer-token session in the shape the app's server code calls (`did` and `fetchHandler`). */
export type BearerSession = { did: string; fetchHandler(path: string, init: RequestInit): Promise<Response> };

export type PdsNetwork = {
  network: TestNetwork;
  hosts: readonly [TestPds, TestPds];
  plcUrl: string;
  databasePath: string;
  serviceRef: string;
  createActor(name: string, host: 0 | 1): Promise<NetworkActor>;
  close(): Promise<void>;
};


export function pinnedCheckout(): string {
  const checkout = process.env.ATPROTO_PINNED_CHECKOUT;
  assert.ok(checkout, "set ATPROTO_PINNED_CHECKOUT to the pinned atproto checkout");
  return resolve(checkout);
}

/**
 * The pinned two-host network with this app's lexicons, and this process's environment pointed at it. `appPort` is where the
 * web app runs (`APP_URL`) and `operatorPort` where the operator does (`OPERATOR_URL`, its `did:web` service), for a test that
 * runs them there; a test that calls the operator's methods in its own process needs neither.
 */
export async function startPdsNetwork(label: string, options: { appPort?: number; operatorPort?: number } = {}): Promise<PdsNetwork> {
  const appPort = options.appPort ?? 3000;
  const operatorPort = options.operatorPort ?? 3001;
  const serviceRef = `did:web:localhost%3A${operatorPort}#atproto_flock_operator`;
  const { TestNetworkNoAppView } = await import(pathToFileURL(join(pinnedCheckout(), "packages/dev-env/src/index.ts")).href) as {
    TestNetworkNoAppView: { create(options: { extraPdses: number; lexiconAuthority: boolean }): Promise<TestNetwork> };
  };
  const fixtureTemp = createFixtureTempRoot(`${label}-fixture-`);
  let network: TestNetwork;
  try {
    network = await TestNetworkNoAppView.create({ extraPdses: 1, lexiconAuthority: true });
  } catch (error) {
    fixtureTemp.cleanup();
    throw error;
  }
  const databaseDirectory = mkdtempSync(join(tmpdir(), `${label}-db-`));
  const databasePath = join(databaseDirectory, "app.db");
  const restoreEnvironment = setEnvironment({
    NODE_ENV: "test",
    ATPROTO_ACCEPTANCE_TEST: "true",
    APP_URL: `http://127.0.0.1:${appPort}`,
    OPERATOR_URL: `http://127.0.0.1:${operatorPort}`,
    AUTH_ENCRYPTION_KEY: "4a".repeat(32),
    OPERATOR_SERVICE_REF: serviceRef,
    PLC_URL: network.plc.url,
    DATABASE_PATH: databasePath,
  });
  const hosts = [network.pds, network.extraPdses[0]!] as const;
  const release = async () => {
    try {
      await network.close();
    } finally {
      (await import("@flock/operator/lib/db")).closeDb();
      rmSync(databaseDirectory, { recursive: true, force: true });
      restoreEnvironment();
      fixtureTemp.cleanup();
    }
  };
  try {
    await publishAppLexicons(network, process.cwd());
  } catch (error) {
    await release();
    throw error;
  }
  return {
    network,
    hosts,
    plcUrl: network.plc.url,
    databasePath,
    serviceRef,
    async createActor(name, host) {
      const handle = `${name}.test${host === 0 ? "" : "2"}`;
      const password = `${name}-spike-pass`;
      const { data } = await hosts[host].getAgent().com.atproto.server.createAccount({ handle, email: `${name}@spike.test`, password });
      return { did: data.did, handle, password, accessJwt: data.accessJwt, pds: hosts[host] };
    },
    close: release,
  };
}

/** Sets each variable and returns a function that puts back what was there before (including absence). */
function setEnvironment(values: Record<string, string>): () => void {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

export async function publishAppLexicons(network: TestNetwork, projectRoot: string): Promise<void> {
  if (!network.lexiconAuthority) throw new Error("The fixture must expose its lexicon authority.");
  const agent = network.pds.getAgent();
  const session = await agent.com.atproto.server.createSession({ identifier: "lex-authority.test", password: "hunter2" });
  const root = join(projectRoot, "packages/protocol/lexicons/new/flock");
  const files = await readdir(root, { recursive: true });
  const published = new Set<string>();
  for (const relative of files.filter((file) => file.endsWith(".json"))) {
    const lexicon = JSON.parse(await readFile(join(root, relative), "utf8")) as { id: string };
    if (published.has(lexicon.id)) continue;
    published.add(lexicon.id);
    await agent.com.atproto.repo.createRecord({
      repo: network.lexiconAuthority.did,
      collection: "com.atproto.lexicon.schema",
      rkey: lexicon.id,
      record: lexicon,
    }, { headers: { authorization: `Bearer ${session.data.accessJwt}` } });
  }
}

export function bearerSession(actor: { did: string; accessJwt: string; pds: TestPds }): BearerSession {
  return {
    did: actor.did,
    fetchHandler: async (path, init) => {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${actor.accessJwt}`);
      return fetch(new URL(path, actor.pds.url), { ...init, headers, redirect: "error" });
    },
  };
}

type SessionTable = "authority_grant";

/** The member's OAuth session as the browser holds it: restored through the OAuth client over in-memory stores. */
export type BrowserSession = {
  session: OAuthSession;
  /** The access token the provider issued, which is how a test finds (and ages or revokes) the session at the provider. */
  accessToken: string;
  /** Restores the stored session again; `refresh: true` makes it refresh at the provider, which a lapsed or revoked session refuses. */
  restore(refresh?: boolean): Promise<OAuthSession>;
};

/**
 * Mints a real PDS-issued, DPoP-bound OAuth token set for `did` with exactly `scopes` (plus `atproto`) for the browser's own
 * OAuth client (`buildBrowserClientMetadata` over the app's browser config), and restores it with `NodeOAuthClient` over
 * in-memory stores, as the browser restores its session. This is what a completed browser sign-in leaves behind, without
 * driving the consent screen.
 */
export async function mintBrowserSession(pds: TestPds, did: string, scopes: readonly string[], keyLabel: string): Promise<BrowserSession> {
  const [{ browserSessionConfig }, { buildBrowserClientMetadata }] = await Promise.all([import("@flock/web/app/browser-session-config"), import("@flock/web/browser/client-metadata")]);
  const { appUrl, plcUrl } = browserSessionConfig();
  const metadata = buildBrowserClientMetadata({ appUrl, scope: ["atproto", ...scopes.filter((scope) => scope !== "atproto")].join(" ") });
  const { saved, accessToken } = await mintProviderSession(pds, did, { clientId: metadata.client_id, redirectUri: metadata.redirect_uris[0], scope: metadata.scope }, keyLabel);
  const client = new NodeOAuthClient({
    clientMetadata: oauthClientMetadataSchema.parse(metadata),
    stateStore: inMemoryStore<NodeSavedState>(),
    sessionStore: inMemoryStore<NodeSavedSession>(new Map([[did, saved]])),
    plcDirectoryUrl: plcUrl,
    allowHttp: true,
    requestLock: (_name, run) => run(),
  });
  const restore = (refresh?: boolean) => client.restore(did, refresh);
  return { accessToken, restore, session: await restore() };
}

function inMemoryStore<V>(entries = new Map<string, V>()) {
  return {
    get: async (key: string) => entries.get(key),
    set: async (key: string, value: V) => { entries.set(key, value); },
    del: async (key: string) => { entries.delete(key); },
  };
}

/** Mints the same kind of session for the workspace-authority client and stores it in the grant table, as a completed authority flow does. */
export async function storeAuthorityGrant(pds: TestPds, did: string, keyLabel: string): Promise<{ accessToken: string }> {
  const [{ authorityClientMetadata }, { oauthSqliteStore }] = await Promise.all([import("@flock/operator/operator/authority-grant"), import("@flock/operator/auth/encrypted-store")]);
  const metadata = authorityClientMetadata();
  const { saved, accessToken } = await mintProviderSession(pds, did, { clientId: metadata.client_id, redirectUri: metadata.redirect_uris[0], scope: metadata.scope }, keyLabel);
  await oauthSqliteStore("authority_grant").set(did, saved);
  return { accessToken };
}

async function mintProviderSession(
  pds: TestPds,
  did: string,
  request: { clientId: string; redirectUri: string; scope: string },
  keyLabel: string,
): Promise<{ saved: NodeSavedSession; accessToken: string }> {
  assert.ok(pds.ctx.oauthProvider, "the local PDS test network exposes its OAuth provider");
  const [{ JoseKey }, { generateCode }] = await Promise.all([
    import("@atproto/jwk-jose"),
    import(pathToFileURL(join(pinnedCheckout(), "packages/oauth/oauth-provider/src/request/code.ts")).href) as Promise<{ generateCode(): Promise<string> }>,
  ]);
  const client = await pds.ctx.oauthProvider.clientManager.getClient(request.clientId);
  // What the PDS checks when the authorization request arrives: this client may ask for exactly this scope.
  client.validateRequest({ client_id: request.clientId, redirect_uri: request.redirectUri, response_type: "code", scope: request.scope });
  const key = await JoseKey.generate(["ES256"], keyLabel);
  const publicJwk = key.bareJwk;
  assert.ok(publicJwk && publicJwk.kty === "EC" && publicJwk.crv === "P-256" && publicJwk.x && publicJwk.y);
  const dpopJkt = createHash("sha256")
    .update(JSON.stringify({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x, y: publicJwk.y }))
    .digest("base64url");
  const { account } = await pds.ctx.oauthProvider.accountManager.getAccount(did);
  const token = await pds.ctx.oauthProvider.tokenManager.createToken(
    client,
    { method: "none" },
    { ipAddress: "127.0.0.1", port: 443 },
    account,
    null,
    { client_id: request.clientId, redirect_uri: request.redirectUri, response_type: "code", scope: request.scope, dpop_jkt: dpopJkt },
    await generateCode(),
  );
  return {
    accessToken: token.access_token,
    saved: {
      dpopJwk: jwkSchema.parse(key.privateJwk),
      authMethod: { method: "none" as const },
      tokenSet: {
        iss: pds.ctx.cfg.oauth.issuer,
        sub: asAtprotoDid(did),
        aud: pds.url,
        scope: asAtprotoOAuthScope(token.scope ?? request.scope),
        access_token: token.access_token,
        ...(token.refresh_token ? { refresh_token: token.refresh_token } : {}),
        token_type: "DPoP" as const,
        expires_at: new Date(Date.now() + token.expires_in * 1000).toISOString(),
      },
    },
  };
}

/**
 * Ages the provider-side session behind `accessToken` by `ageMs` (creation and last refresh), which is what the provider
 * measures a session's lifetime against. For a public client, fifteen days is past its two-week lifetime.
 */
export async function ageProviderSession(pds: TestPds, accessToken: string, ageMs: number): Promise<void> {
  assert.ok(pds.ctx.oauthProvider);
  const found = await pds.ctx.oauthProvider.tokenManager.findToken(accessToken);
  assert.ok(found, "the provider holds the token to age");
  const then = new Date(Date.now() - ageMs).toISOString();
  await pds.ctx.accountManager.db.db.updateTable("token").set({ createdAt: then, updatedAt: then }).where("tokenId", "=", found.id).execute();
}

/** The same, for a session the app stores: the stored copy's access token is also marked expired so the next use refreshes. */
export async function ageOAuthSessionAtProvider(pds: TestPds, table: SessionTable, did: string, accessToken: string, ageMs: number): Promise<void> {
  await ageProviderSession(pds, accessToken, ageMs);
  await expireStoredSession(table, did);
}

/** Marks the stored copy's access token expired, so its next use refreshes it at the provider. */
export async function expireStoredSession(table: SessionTable, did: string): Promise<void> {
  const { oauthSqliteStore } = await import("@flock/operator/auth/encrypted-store");
  const store = oauthSqliteStore(table);
  const saved = await store.get(did);
  assert.ok(saved && "tokenSet" in saved && saved.tokenSet, `a session is stored in ${table}`);
  const expired = structuredClone(saved) as unknown as { tokenSet: Record<string, unknown> };
  expired.tokenSet.expires_at = new Date(Date.now() - 1_000).toISOString();
  await store.set(did, expired as never);
}

/** The one browser grant (R6), from the app's own builder: the member set, the operator methods and the DM set (K3). */
export async function combinedMemberScopes(serviceRef: string): Promise<string[]> {
  return (await import("@flock/protocol/scopes")).memberGrantScopes(serviceRef).filter((scope) => scope !== "atproto");
}

let operatorServed: Promise<string> | undefined;

/**
 * The operator's app served in this process on a free port, so a test reaches its methods as a browser does (lexicon checks,
 * routing and error answers included) with the database and keys this process's environment names. Started once, after the
 * network has set that environment; it does not keep the process alive.
 */
export function inProcessOperator(): Promise<string> {
  operatorServed ??= (async () => {
    const { createOperatorApp } = await import("@flock/operator/operator/server");
    const server = createOperatorApp().listen(0, "127.0.0.1");
    await once(server, "listening");
    server.unref();
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return `http://127.0.0.1:${address.port}`;
  })();
  return operatorServed;
}

/**
 * Calls one of the operator's XRPC methods on the in-process operator, authenticated with a service token the caller's own
 * session obtains, and returns the parsed answer. Throws with the operator's answer on any status other than 200.
 */
export async function callOperatorMethod(
  session: { did: string; fetchHandler(path: string, init: RequestInit): Promise<Response> },
  serviceRef: string,
  method: import("@flock/protocol/nsids").OperatorMethod,
  query: Record<string, string>,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const { sessionClient } = await import("@flock/operator/atproto/client");
  // A service token from the caller's own session, bound to the operator's service and to exactly this method.
  const { token } = await sessionClient(session as never).query<{ token: string }>("com.atproto.server.getServiceAuth", { aud: serviceRef, lxm: method });
  const url = new URL(`/xrpc/${method}`, await inProcessOperator());
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const answer = await response.json() as Record<string, unknown>;
  if (response.status !== 200) throw new Error(`${method} answered ${response.status}: ${JSON.stringify(answer)}`);
  return answer;
}

export type Outcome = { ok: true } | { ok: false; error: string };

/** Runs one operation and records whether it succeeded, so a scenario can report every failure instead of the first. */
export async function outcome(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    await run();
    return { ok: true };
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `${name}: ${message}`.slice(0, 200) };
  }
}

/**
 * The engine's transport for an actor on the real network: its own bearer client, DID documents from the PLC directory
 * (cached, refetched when asked), and plain fetch for every other host. `fetchVia` lets a measurement count or limit
 * requests; `now` lets a test move the engine's clock past a truth interval.
 */
export function actorTransport(
  network: Pick<PdsNetwork, "plcUrl">,
  actor: Pick<NetworkActor, "did" | "accessJwt"> & { pds: { url: string } },
  options: { now?: () => number; fetchVia?: (request: Request) => Promise<Response> } = {},
): import("@flock/client/transport").ClientTransport {
  const send = options.fetchVia ?? ((request: Request) => fetch(request));
  const documents = new Map<string, Promise<{ service?: Array<{ id?: string; serviceEndpoint?: unknown }>; verificationMethod?: unknown }>>();
  const document = (did: string, forceRefresh: boolean) => {
    const cached = documents.get(did);
    if (cached && !forceRefresh) return cached;
    const resolved = send(new Request(new URL(`/${encodeURIComponent(did)}`, network.plcUrl))).then(async (response) => {
      if (!response.ok) throw new Error(`PLC answered ${response.status} for ${did}.`);
      return await response.json() as { service?: Array<{ id?: string; serviceEndpoint?: unknown }>; verificationMethod?: unknown };
    });
    documents.set(did, resolved);
    resolved.catch(() => documents.delete(did));
    return resolved;
  };
  return {
    did: actor.did,
    memberClient: new AtprotoClient((path, init) => {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${actor.accessJwt}`);
      return send(new Request(new URL(path, actor.pds.url), { ...init, headers, redirect: "error" }));
    }),
    resolvePds: async (did) => {
      const endpoint = (await document(did, false)).service?.find((service) => service.id === "#atproto_pds" || service.id === `${did}#atproto_pds`)?.serviceEndpoint;
      if (typeof endpoint !== "string") throw new Error(`No PDS in the DID document of ${did}.`);
      return endpoint;
    },
    resolveKemKey: async (did, forceRefresh) => kemKeyFromDidDocument(did, await document(did, forceRefresh)),
    fetchEndpoint: send,
    generateKey: generateSpaceKey,
    ...(options.now ? { now: options.now } : {}),
  };
}
