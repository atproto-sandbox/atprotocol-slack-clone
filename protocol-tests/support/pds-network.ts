import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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

export const SPIKE_SERVICE_REF = "did:web:localhost%3A3000#atproto_flock_operator";

export function pinnedCheckout(): string {
  const checkout = process.env.ATPROTO_PINNED_CHECKOUT;
  assert.ok(checkout, "set ATPROTO_PINNED_CHECKOUT to the pinned atproto checkout");
  return resolve(checkout);
}

export async function startPdsNetwork(label: string): Promise<PdsNetwork> {
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
    APP_URL: "http://127.0.0.1:3000",
    AUTH_ENCRYPTION_KEY: "4a".repeat(32),
    OPERATOR_SERVICE_REF: SPIKE_SERVICE_REF,
    PLC_URL: network.plc.url,
    DATABASE_PATH: databasePath,
  });
  const hosts = [network.pds, network.extraPdses[0]!] as const;
  const release = async () => {
    try {
      await network.close();
    } finally {
      (await import("@/lib/db")).closeDb();
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
    serviceRef: SPIKE_SERVICE_REF,
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
  const root = join(projectRoot, "lexicons/new/flock");
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

type SessionTable = "oauth_session" | "authority_grant";

/**
 * Mints a real PDS-issued, DPoP-bound OAuth token set for `did` with exactly `scopes` (plus `atproto`) for the app's member
 * loopback client, and stores it where the app restores member sessions from. This is what a completed sign-in leaves
 * behind, without driving the consent screen.
 */
export async function storeOAuthSession(pds: TestPds, did: string, scopes: readonly string[], keyLabel: string): Promise<{ accessToken: string; clientScope: string }> {
  const [{ canonicalOAuthScope }, { getOAuthClient }, { oauthSqliteStore }] = await Promise.all([
    import("@/auth/oauth-scope"), import("@/auth/oauth"), import("@/auth/encrypted-store"),
  ]);
  const clientScope = canonicalOAuthScope(["atproto", ...scopes]);
  const metadata = getOAuthClient(clientScope).clientMetadata;
  const { saved, accessToken } = await mintProviderSession(pds, did, { clientId: metadata.client_id, redirectUri: metadata.redirect_uris[0], scope: clientScope }, keyLabel);
  await oauthSqliteStore("oauth_session").set(did, { ...saved, oauthClientScope: clientScope } as never);
  return { accessToken, clientScope };
}

/** The same, for the workspace-authority client: what a completed authority flow leaves in the grant table. */
export async function storeAuthorityGrant(pds: TestPds, did: string, keyLabel: string): Promise<{ accessToken: string }> {
  const [{ authorityClientMetadata }, { oauthSqliteStore }] = await Promise.all([import("@/operator/authority-grant"), import("@/auth/encrypted-store")]);
  const metadata = authorityClientMetadata();
  const { saved, accessToken } = await mintProviderSession(pds, did, { clientId: metadata.client_id, redirectUri: metadata.redirect_uris[0], scope: metadata.scope }, keyLabel);
  await oauthSqliteStore("authority_grant").set(did, saved as never);
  return { accessToken };
}

async function mintProviderSession(
  pds: TestPds,
  did: string,
  request: { clientId: string; redirectUri: string; scope: string },
  keyLabel: string,
): Promise<{ saved: Record<string, unknown>; accessToken: string }> {
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
      dpopJwk: key.privateJwk,
      authMethod: { method: "none" as const },
      tokenSet: {
        iss: pds.ctx.cfg.oauth.issuer,
        sub: did,
        aud: pds.url,
        scope: token.scope ?? request.scope,
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
 * measures a session's lifetime against, and marks the stored copy's access token expired so the next use refreshes. For
 * a public client, fifteen days is past its two-week lifetime.
 */
export async function ageOAuthSessionAtProvider(pds: TestPds, table: SessionTable, did: string, accessToken: string, ageMs: number): Promise<void> {
  assert.ok(pds.ctx.oauthProvider);
  const found = await pds.ctx.oauthProvider.tokenManager.findToken(accessToken);
  assert.ok(found, "the provider holds the token to age");
  const then = new Date(Date.now() - ageMs).toISOString();
  await pds.ctx.accountManager.db.db.updateTable("token").set({ createdAt: then, updatedAt: then }).where("tokenId", "=", found.id).execute();
  await expireStoredSession(table, did);
}

/** Marks the stored copy's access token expired, so its next use refreshes it at the provider. */
export async function expireStoredSession(table: SessionTable, did: string): Promise<void> {
  const { oauthSqliteStore } = await import("@/auth/encrypted-store");
  const store = oauthSqliteStore(table);
  const saved = await store.get(did);
  assert.ok(saved && "tokenSet" in saved && saved.tokenSet, `a session is stored in ${table}`);
  const expired = structuredClone(saved) as unknown as { tokenSet: Record<string, unknown> };
  expired.tokenSet.expires_at = new Date(Date.now() - 1_000).toISOString();
  await store.set(did, expired as never);
}

/** The scopes every sign-in requests (`/api/oauth/login`). */
export async function memberSignInScopes(): Promise<readonly string[]> {
  return (await import("@/protocol/scopes")).MEMBER_SIGN_IN_SCOPES;
}

export const SERVICE_METHODS_TODAY = ["new.flock.operator.execute", "new.flock.operator.getOperation", "new.flock.operator.listInboxWriters"] as const;
// Not built yet: a token must still be issued for them, and verified by whoever serves them.
export const SERVICE_METHODS_PLANNED = ["new.flock.operator.getChanges", "new.flock.operator.createWorkspace", "new.flock.operator.startAuthorityFlow", "new.flock.operator.listStalledOperations"] as const;

/** The member grant of the refactor plan's "Identities and sessions" section plus the browser DM set, as one consent (K3). */
export async function combinedMemberScopes(serviceRef: string): Promise<string[]> {
  const { DM_BROWSER_SCOPES } = await import("@/protocol/scopes");
  const audience = serviceRef.replaceAll("%", "%25").replace("#", "%23");
  return [
    "space:new.flock.workspace?authority=*&action=read",
    "space:new.flock.workspace?authority=*&collection=new.flock.acceptance&action=create&action=update",
    "space:new.flock.inbox?authority=*&action=read",
    "space:new.flock.inbox?authority=*&collection=new.flock.joinRequest&action=create&action=update&action=delete",
    "space:new.flock.channel?authority=*&action=read",
    "space:new.flock.channel?authority=*&collection=new.flock.channel.message&collection=new.flock.channel.reaction&action=create&action=update&action=delete",
    `rpc?${[...SERVICE_METHODS_TODAY, ...SERVICE_METHODS_PLANNED].map((method) => `lxm=${method}`).join("&")}&aud=${audience}`,
    ...DM_BROWSER_SCOPES.filter((scope) => scope !== "atproto"),
  ];
}

type OperatorMethod = (typeof SERVICE_METHODS_TODAY)[number];

/**
 * Calls one of the operator's XRPC methods through its real route handler, authenticated with a service token the caller's
 * own session obtains, and returns the parsed answer. Throws with the operator's answer on any status other than 200.
 */
export async function callOperatorMethod(
  session: { did: string; fetchHandler(path: string, init: RequestInit): Promise<Response> },
  serviceRef: string,
  method: OperatorMethod,
  query: Record<string, string>,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const [{ requestOperatorServiceAuth }, { NextRequest }] = await Promise.all([import("@/operator/client"), import("next/server")]);
  const token = await requestOperatorServiceAuth(session as never, serviceRef, method);
  const url = new URL(`http://127.0.0.1:3000/xrpc/${method}`);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  type Handler = (request: InstanceType<typeof NextRequest>) => Promise<Response>;
  const route = await import(`@/app/xrpc/${method}/route`) as { GET?: Handler; POST?: Handler };
  const handler = body === undefined ? route.GET : route.POST;
  assert.ok(handler, `${method} has a handler`);
  const response = await handler(new NextRequest(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
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
