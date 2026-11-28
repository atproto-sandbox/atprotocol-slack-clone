import { once } from "node:events";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  asAtprotoDid,
  asAtprotoOAuthScope,
  jwkSchema,
  NodeOAuthClient,
  oauthClientMetadataSchema,
  type NodeSavedSession,
  type NodeSavedState,
  type OAuthSession,
} from "@atproto/oauth-client-node";
import { DidNotFoundError } from "@flock/client/errors";
import { groupHostPdsServiceEndpoint, type GroupHostConfig } from "@flock/group-host/config";
import { startGroupHostServer, type RunningGroupHost } from "@flock/group-host/server";
import { kemKeyFromDidDocument } from "@flock/protocol/atproto/kem-key";
import { generateSpaceKey } from "@flock/protocol/atproto/space-key";
import { AtprotoClient } from "@flock/protocol/atproto/xrpc";
import { workspaceUri } from "@flock/protocol/keys";
import * as jose from "jose";
import { verifyPinnedCheckout } from "../../scripts/verify-pinned-checkout.mjs";
import { createFixtureTempRoot } from "../fixture-temp";

// The pinned PDS network + Atmosphere Groups Host without the Next app: two in-memory personal PDS hosts,
// a PLC directory, a real Atmosphere Groups Host (`apps/group-host`), and both `new.flock.*` and `org.atgrp.*`
// lexicons published to the fixture's lexicon authority. Personal PDSes never pre-create `org.atgrp.inbox/self`.

export type TestAgent = {
  com: {
    atproto: {
      server: {
        createAccount(input: Record<string, unknown>): Promise<{ data: { did: string; accessJwt: string } }>;
        createSession(input: Record<string, unknown>): Promise<{ data: { did: string; accessJwt: string } }>;
        createAppPassword(
          input: Record<string, unknown>,
          options: { headers: { authorization: string } },
        ): Promise<{ data: { name: string; password: string } }>;
      };
      repo: {
        createRecord(input: Record<string, unknown>, options: { headers: { authorization: string } }): Promise<unknown>;
        deleteRecord(input: Record<string, unknown>, options: { headers: { authorization: string } }): Promise<unknown>;
      };
    };
  };
};

type ProviderToken = { access_token: string; expires_in: number; refresh_token?: string; scope?: string };

export type TestPds = {
  url: string;
  getAgent(): TestAgent;
  ctx: {
    cfg: { service: { did: string }; oauth: { issuer: string }; lexicon?: { didAuthority?: string } };
    oauthProvider?: {
      issuer: string;
      lexiconManager: {
        getSpacesFromScope(scope?: string): Promise<Map<string, unknown>>;
        getPermissionSetsFromScope(scope?: string): Promise<Map<string, unknown>>;
      };
      authorize(
        query: Record<string, string | undefined>,
        deviceInfo: { deviceId: string; deviceMetadata: { ipAddress: string; userAgent?: string } },
      ): Promise<{
        issuer: string;
        parameters: { redirect_uri: string; state?: string; scope?: string };
        redirect?: { code: string };
        requestUri?: string;
        client?: unknown;
      }>;
      requestManager: {
        setAuthorized(
          requestUri: unknown,
          client: unknown,
          account: unknown,
          deviceId: string,
          deviceMetadata: { ipAddress: string; userAgent?: string },
          scopeOverride?: string,
        ): Promise<{ code: string }>;
      };
      tokenManager: {
        createToken(...args: unknown[]): Promise<ProviderToken>;
        findToken(token: string): Promise<{ id: unknown } | null>;
        deleteToken(tokenId: unknown): Promise<void>;
      };
      clientManager: {
        getClient(clientId: string): Promise<{ id: string; validateRequest(parameters: Record<string, unknown>): unknown }>;
      };
      accountManager: { getAccount(did: string): Promise<{ account: unknown }> };
    };
    accountManager: { db: { db: ProviderTokenTable } };
  };
};

export type OAuthProviderHost = { url: string; ctx: Pick<TestPds["ctx"], "cfg" | "oauthProvider"> };

type ProviderTokenTable = {
  updateTable(table: "token"): {
    set(values: Record<string, string>): {
      where(column: "tokenId", operator: "=", value: unknown): { execute(): Promise<unknown> };
    };
  };
};

export type TestNetwork = {
  plc: { url: string };
  pds: TestPds;
  extraPdses: TestPds[];
  lexiconAuthority?: { did: string };
  close(): Promise<void>;
};

export type NetworkActor = { did: string; handle: string; password: string; accessJwt: string; pds: TestPds };

export type BearerSession = { did: string; fetchHandler(path: string, init: RequestInit): Promise<Response> };

export type PdsNetwork = {
  network: TestNetwork;
  hosts: readonly [TestPds, TestPds];
  groupHost: RunningGroupHost;
  groupHostUrl: string;
  groupHostDatabasePath: string;
  plcUrl: string;
  databasePath: string;
  serviceRef: string;
  createActor(name: string, host: 0 | 1): Promise<NetworkActor>;
  startExtraGroupHost(overrides?: Partial<GroupHostConfig>): Promise<RunningGroupHost>;
  close(): Promise<void>;
};

export function pinnedCheckout(): string {
  const checkout = process.env.ATPROTO_PINNED_CHECKOUT ?? process.env.ATPROTO_PIN_CHECKOUT;
  assert.ok(checkout, "set ATPROTO_PINNED_CHECKOUT to the pinned atproto checkout");
  return verifyPinnedCheckout(checkout);
}

export async function startPdsNetwork(
  label: string,
  options: { appPort?: number; operatorPort?: number; groupHostPort?: number; groupHostOverrides?: Partial<GroupHostConfig> } = {},
): Promise<PdsNetwork> {
  const appPort = options.appPort ?? 3000;
  const useInProcessOperator = options.operatorPort === undefined;
  const operatorPort = options.operatorPort ?? (await getSharedInProcessOperatorPort());
  const serviceRef = `did:web:localhost%3A${operatorPort}#atproto_flock_operator`;
  const { TestNetworkNoAppView } = (await import(
    pathToFileURL(join(pinnedCheckout(), "packages/dev-env/src/index.ts")).href
  )) as {
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
  const envPlcUrl = useInProcessOperator ? await sharedPlcProxy(network.plc.url) : network.plc.url;
  const databaseDirectory = mkdtempSync(join(tmpdir(), `${label}-db-`));
  const databasePath = join(databaseDirectory, "app.db");
  const groupHostDatabasePath = join(databaseDirectory, "group-host.db");
  const groupHostEncryptionKey = "5b".repeat(32);

  let groupHost: RunningGroupHost | undefined;
  const extraGroupHosts: RunningGroupHost[] = [];
  let extraCounter = 0;

  try {
    groupHost = await startGroupHostServer({
      port: options.groupHostPort ?? 0,
      databasePath: groupHostDatabasePath,
      plcUrl: network.plc.url,
      encryptionKeyHex: groupHostEncryptionKey,
      handleDomain: "groups.localhost",
      allowLoopback: true,
      ...options.groupHostOverrides,
    });
  } catch (error) {
    await network.close().catch(() => undefined);
    rmSync(databaseDirectory, { recursive: true, force: true });
    fixtureTemp.cleanup();
    throw error;
  }

  const restoreEnvironment = setEnvironment({
    NODE_ENV: "test",
    ATPROTO_ACCEPTANCE_TEST: "true",
    APP_URL: `http://127.0.0.1:${appPort}`,
    OPERATOR_URL: `http://127.0.0.1:${operatorPort}`,
    GROUP_HOST_URL: groupHost.url,
    GROUP_HOST_DATABASE_PATH: groupHostDatabasePath,
    GROUP_HOST_ENCRYPTION_KEY: groupHostEncryptionKey,
    GROUP_HOST_HANDLE_DOMAIN: "groups.localhost",
    AUTH_ENCRYPTION_KEY: "4a".repeat(32),
    OPERATOR_SERVICE_REF: serviceRef,
    PLC_URL: envPlcUrl,
    DATABASE_PATH: databasePath,
  });
  (await import("@flock/operator/config")).resetOperatorConfigCacheForTest();

  const hosts = [network.pds, network.extraPdses[0]!] as const;
  const release = async () => {
    try {
      await Promise.all(extraGroupHosts.map((gh) => gh.close().catch(() => undefined)));
      await groupHost?.close().catch(() => undefined);
      await network.close();
    } finally {
      (await import("@flock/operator/lib/db")).closeDb();
      restoreEnvironment();
      (await import("@flock/operator/config")).resetOperatorConfigCacheForTest();
      rmSync(databaseDirectory, { recursive: true, force: true });
      fixtureTemp.cleanup();
    }
  };
  try {
    if (useInProcessOperator) await inProcessOperator();
    await publishAppLexicons(network, process.cwd());
  } catch (error) {
    await release();
    throw error;
  }
  return {
    network,
    hosts,
    groupHost,
    groupHostUrl: groupHost.url,
    groupHostDatabasePath,
    plcUrl: network.plc.url,
    databasePath,
    serviceRef,
    async createActor(name, host) {
      const handle = `${name}.test${host === 0 ? "" : "2"}`;
      const password = `${name}-spike-pass`;
      const { data } = await hosts[host]
        .getAgent()
        .com.atproto.server.createAccount({ handle, email: `${name}@spike.test`, password });
      return { did: data.did, handle, password, accessJwt: data.accessJwt, pds: hosts[host] };
    },
    async startExtraGroupHost(overrides = {}) {
      extraCounter += 1;
      const extraDbPath = overrides.databasePath ?? join(databaseDirectory, `group-host-extra-${extraCounter}.db`);
      const extra = await startGroupHostServer({
        port: 0,
        databasePath: extraDbPath,
        plcUrl: network.plc.url,
        encryptionKeyHex: overrides.encryptionKeyHex ?? "6c".repeat(32),
        handleDomain: overrides.handleDomain ?? `groups${extraCounter + 1}.localhost`,
        allowLoopback: true,
        ...overrides,
      });
      extraGroupHosts.push(extra);
      return extra;
    },
    close: release,
  };
}

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
  const lexiconRoots = [
    join(projectRoot, "packages/protocol/lexicons/new/flock"),
    join(projectRoot, "packages/protocol/lexicons/org/atgrp"),
  ];
  const published = new Set<string>();
  for (const root of lexiconRoots) {
    const files = await readdir(root, { recursive: true });
    for (const relative of files.filter((file) => file.endsWith(".json"))) {
      const lexicon = JSON.parse(await readFile(join(root, relative), "utf8")) as { id: string };
      if (published.has(lexicon.id)) continue;
      published.add(lexicon.id);
      await agent.com.atproto.repo.createRecord(
        {
          repo: network.lexiconAuthority.did,
          collection: "com.atproto.lexicon.schema",
          rkey: lexicon.id,
          record: lexicon,
        },
        { headers: { authorization: `Bearer ${session.data.accessJwt}` } },
      );
    }
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

export type BrowserSession = {
  session: OAuthSession;
  accessToken: string;
  restore(refresh?: boolean): Promise<OAuthSession>;
};

export async function mintBrowserSession(
  pds: TestPds,
  did: string,
  scopes: readonly string[],
  keyLabel: string,
): Promise<BrowserSession> {
  const [{ browserSessionConfig }, { buildBrowserClientMetadata }] = await Promise.all([
    import("@flock/web/app/browser-session-config"),
    import("@flock/web/browser/client-metadata"),
  ]);
  const { appUrl, plcUrl } = browserSessionConfig();
  const metadata = buildBrowserClientMetadata({
    appUrl,
    scope: ["atproto", ...scopes.filter((scope) => scope !== "atproto")].join(" "),
  });
  const { saved, accessToken } = await mintProviderSession(
    pds,
    did,
    { clientId: metadata.client_id, redirectUri: metadata.redirect_uris[0], scope: metadata.scope },
    keyLabel,
  );
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

export async function mintAppSession(
  pds: OAuthProviderHost,
  did: string,
  input: { serviceRef: string; plcUrl: string; stateFile: string },
  keyLabel: string,
) {
  const [{ appClientMetadata, appOAuthClient, StateFile }, { appGrantScope }] = await Promise.all([
    import("@flock/client/node/oauth"),
    import("@flock/client/app-runtime"),
  ]);
  const config = {
    appUrl: "http://127.0.0.1:3002",
    keys: [],
    name: "Test app",
    scope: appGrantScope(input.serviceRef),
    plcUrl: input.plcUrl,
    stateFile: input.stateFile,
  };
  const metadata = appClientMetadata(config);
  const { saved } = await mintProviderSession(
    pds,
    did,
    { clientId: metadata.client_id, redirectUri: metadata.redirect_uris[0], scope: config.scope },
    keyLabel,
  );
  await new StateFile(input.stateFile).store("sessions").set(did, saved);
  return (await appOAuthClient(config)).restore(did);
}

function inMemoryStore<V>(entries = new Map<string, V>()) {
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

export type DpopClient = {
  publicJwk: jose.JWK;
  privateJwk: jose.JWK;
  dpopJkt: string;
  keyPair: Awaited<ReturnType<typeof jose.generateKeyPair>>;
  signProof(params: {
    htm: string;
    htu: string;
    nonce?: string;
    accessToken?: string;
    jti?: string;
    iatSec?: number;
  }): Promise<string>;
  fetchWithDpop(url: string, init: RequestInit & { accessToken?: string }): Promise<Response>;
};

export async function createGroupDpopClient(keyLabel = `dpop-${randomUUID()}`): Promise<DpopClient> {
  const keyPair = await jose.generateKeyPair("ES256", { extractable: true });
  const publicJwk = await jose.exportJWK(keyPair.publicKey);
  const privateJwk = await jose.exportJWK(keyPair.privateKey);
  privateJwk.kid = keyLabel;
  privateJwk.alg = "ES256";
  delete publicJwk.alg;
  delete publicJwk.use;
  delete publicJwk.key_ops;
  const dpopJkt = await jose.calculateJwkThumbprint(publicJwk, "sha256");
  let cachedNonce: string | undefined;

  async function signProof(params: {
    htm: string;
    htu: string;
    nonce?: string;
    accessToken?: string;
    jti?: string;
    iatSec?: number;
  }): Promise<string> {
    const u = new URL(params.htu);
    const bareHtu = `${u.origin}${u.pathname}`;
    const claims: Record<string, unknown> = {
      htm: params.htm.toUpperCase(),
      htu: bareHtu,
      ...(params.nonce ? { nonce: params.nonce } : {}),
      ...(params.accessToken ? { ath: createHash("sha256").update(params.accessToken).digest("base64url") } : {}),
    };
    return new jose.SignJWT(claims)
      .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: publicJwk })
      .setIssuedAt(params.iatSec ?? Math.floor(Date.now() / 1000))
      .setJti(params.jti ?? randomUUID())
      .sign(keyPair.privateKey);
  }

  async function fetchWithDpop(url: string, init: RequestInit & { accessToken?: string }): Promise<Response> {
    const method = (init.method ?? "GET").toUpperCase();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const proof = await signProof({
        htm: method,
        htu: url,
        nonce: cachedNonce,
        accessToken: init.accessToken,
      });
      const headers = new Headers(init.headers);
      headers.set("DPoP", proof);
      if (init.accessToken) headers.set("Authorization", `DPoP ${init.accessToken}`);
      const res = await fetch(url, { ...init, method, headers, redirect: init.redirect ?? "manual" });
      const nextNonce = res.headers.get("dpop-nonce");
      if (nextNonce) cachedNonce = nextNonce;
      if (attempt === 0 && (res.status === 400 || res.status === 401) && nextNonce) {
        const cloned = res.clone();
        const wwwAuth = res.headers.get("www-authenticate") ?? "";
        const text = await cloned.text().catch(() => "");
        if (wwwAuth.includes("use_dpop_nonce") || text.includes("use_dpop_nonce")) continue;
      }
      return res;
    }
    throw new Error("Unreachable DPoP retry");
  }

  return { publicJwk, privateJwk, dpopJkt, keyPair, signProof, fetchWithDpop };
}

/**
 * Approves a real upstream authorization request at `actor.pds.ctx.oauthProvider` (`authorize()` + `setAuthorized()`),
 * running the pinned PDS's real `lexiconManager.getSpacesFromScope()` and `getPermissionSetsFromScope()` checks!
 */
export async function approveAtRealPersonalPds(actor: NetworkActor, authorizeUrl: URL | string): Promise<string> {
  const url = typeof authorizeUrl === "string" ? new URL(authorizeUrl) : authorizeUrl;
  const provider = actor.pds.ctx.oauthProvider;
  assert.ok(provider, "TestPds exposes its OAuthProvider");
  const deviceId = `dev-${createHash("sha256").update(actor.did).digest("hex").slice(0, 32)}`;
  const deviceMetadata = { ipAddress: "127.0.0.1", userAgent: "flock-acceptance" };
  const query = Object.fromEntries(url.searchParams.entries());
  const authorized = await provider.authorize(query, { deviceId, deviceMetadata });
  let code: string;
  if (authorized.redirect?.code) {
    code = authorized.redirect.code;
  } else {
    assert.ok(authorized.requestUri && authorized.client, "Expected requestUri and client from OAuthProvider.authorize()");
    const { account } = await provider.accountManager.getAccount(actor.did);
    const issued = await provider.requestManager.setAuthorized(
      authorized.requestUri,
      authorized.client,
      account,
      deviceId,
      deviceMetadata,
    );
    code = issued.code;
  }
  const cb = new URL(authorized.parameters.redirect_uri);
  cb.searchParams.set("code", code);
  if (authorized.parameters.state) cb.searchParams.set("state", authorized.parameters.state);
  cb.searchParams.set("iss", authorized.issuer);
  return cb.toString();
}

export async function completeRealGroupOAuthFlow(params: {
  groupHost: RunningGroupHost;
  actor: NetworkActor;
  scope: string;
  dpop?: DpopClient;
  clientId?: string;
  redirectUri?: string;
  clientAssertion?: { privateKey: Awaited<ReturnType<typeof jose.generateKeyPair>>["privateKey"]; kid: string };
  responseMode?: "query" | "fragment";
  prompt?: string;
  loginHint?: string;
  action?: "delete_account" | "plc_operation";
  createParams?: {
    displayName: string;
    handle?: string;
    joinPolicy?: "invite" | "approval" | "open";
    publicMeta?: boolean;
    creationKey?: string;
  };
  decision?: "approve" | "deny";
  keyLabel?: string;
}): Promise<{
  dpop: DpopClient;
  redirectLocation: string;
  code?: string;
  actionToken?: string;
  tokenResponse?: {
    access_token: string;
    refresh_token?: string;
    token_type: "DPoP";
    sub: string;
    scope: string;
    expires_in: number;
  };
  saved?: NodeSavedSession;
}> {
  const dpop = params.dpop ?? (await createGroupDpopClient(params.keyLabel));
  const redirectUri = params.redirectUri ?? "http://127.0.0.1:43123/callback";
  const clientId =
    params.clientId ??
    `http://localhost?${new URLSearchParams({ scope: params.scope, redirect_uri: redirectUri }).toString()}`;
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = `st-${randomUUID()}`;

  const signClientAssertion = async () => {
    if (!params.clientAssertion) return undefined;
    return new jose.SignJWT({ iss: clientId, sub: clientId, aud: params.groupHost.url })
      .setProtectedHeader({ alg: "ES256", kid: params.clientAssertion.kid })
      .setIssuedAt()
      .setExpirationTime("60s")
      .setJti(randomUUID())
      .sign(params.clientAssertion.privateKey);
  };

  const parAssertion = await signClientAssertion();
  const parBody = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: params.scope,
    state,
    ...(params.responseMode ? { response_mode: params.responseMode } : {}),
    ...(params.prompt ? { prompt: params.prompt } : {}),
    ...(params.loginHint ? { login_hint: params.loginHint } : {}),
    ...(params.action ? { action: params.action } : {}),
    ...(params.createParams?.creationKey ? { creation_key: params.createParams.creationKey } : {}),
    ...(params.createParams?.displayName ? { group_name: params.createParams.displayName } : {}),
    ...(params.createParams?.joinPolicy ? { join_policy: params.createParams.joinPolicy } : {}),
    ...(params.createParams?.publicMeta !== undefined ? { public_meta: String(params.createParams.publicMeta) } : {}),
    ...(parAssertion
      ? {
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: parAssertion,
        }
      : {}),
  });

  const parRes = await dpop.fetchWithDpop(`${params.groupHost.url}/oauth/par`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: parBody.toString(),
  });
  if (parRes.status !== 201) {
    throw new Error(`Group Host PAR failed (${parRes.status}): ${await parRes.text()}`);
  }
  const { request_uri: requestUri } = (await parRes.json()) as { request_uri: string };

  const getFormRes = await fetch(
    `${params.groupHost.url}/oauth/authorize?client_id=${encodeURIComponent(clientId)}&request_uri=${encodeURIComponent(requestUri)}`,
    { redirect: "manual" },
  );
  let authRes: Response;
  if (getFormRes.status >= 300 && getFormRes.status < 400) {
    authRes = getFormRes;
  } else {
    const formHtml = await getFormRes.text();
    const csrfMatch = /name="csrf_token"\s+value="([^"]+)"/.exec(formHtml);
    const creationKeyMatch = /name="creation_key"\s+value="([^"]+)"/.exec(formHtml);
    if (!csrfMatch?.[1]) {
      throw new Error(`Missing csrf_token in Group Host /oauth/authorize HTML: ${formHtml}`);
    }
    const postForm = new URLSearchParams({
      client_id: clientId,
      request_uri: requestUri,
      csrf_token: csrfMatch[1],
      actor: params.actor.did,
      decision: params.decision === "deny" && params.prompt === "create" ? "deny" : "approve",
    });
    if (params.prompt === "create") {
      postForm.set("creation_key", params.createParams?.creationKey ?? creationKeyMatch?.[1] ?? `ck-${randomUUID()}`);
      postForm.set("display_name", params.createParams?.displayName ?? "Workspace");
      postForm.set("join_policy", params.createParams?.joinPolicy ?? "invite");
      if (params.createParams?.publicMeta ?? true) postForm.set("public_meta", "true");
      if (params.createParams?.handle) postForm.set("handle", params.createParams.handle);
    } else if (!params.loginHint) {
      throw new Error("loginHint is required for non-create completeRealGroupOAuthFlow");
    }
    authRes = await fetch(`${params.groupHost.url}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: postForm.toString(),
      redirect: "manual",
    });
    if (params.decision === "deny" && params.prompt === "create") {
      return { dpop, redirectLocation: authRes.headers.get("location")! };
    }
  }
  if (authRes.status < 300 || authRes.status >= 400) {
    throw new Error(`Expected redirect from Group Host /oauth/authorize, got ${authRes.status}: ${await authRes.text()}`);
  }

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
  if (cbRes.status < 300 || cbRes.status >= 400) {
    throw new Error(`Group Host /oauth/upstream-callback failed (${cbRes.status}): ${await cbRes.text()}`);
  }
  const cbLoc = cbRes.headers.get("location")!;
  let finalRedirectLocation: string;
  if (cbLoc.startsWith(`${params.groupHost.url}/oauth/confirm-action`)) {
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
    if (getConfirmRes.status !== 200) {
      throw new Error(`GET /oauth/confirm-action failed (${getConfirmRes.status}): ${await getConfirmRes.text()}`);
    }
    const html = await getConfirmRes.text();
    const csrfMatch = /name="csrf_token"\s+value="([^"]+)"/.exec(html);
    const snapshotMatch = /name="consent_snapshot"\s+value="([^"]+)"/.exec(html);
    const confirmBody = new URLSearchParams({
      csrf_token: csrfMatch?.[1] ?? "",
      ...(snapshotMatch?.[1] ? { consent_snapshot: snapshotMatch[1] } : {}),
      decision: params.decision ?? "approve",
    });
    const confirmRes = await fetch(cbLoc, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: consentCookie },
      body: confirmBody.toString(),
      redirect: "manual",
    });
    if (confirmRes.status < 300 || confirmRes.status >= 400) {
      throw new Error(`POST /oauth/confirm-action failed (${confirmRes.status}): ${await confirmRes.text()}`);
    }
    finalRedirectLocation = confirmRes.headers.get("location")!;
  } else {
    finalRedirectLocation = cbLoc;
  }

  const parsedRedir = new URL(finalRedirectLocation);
  const redirParams =
    params.responseMode === "fragment"
      ? new URLSearchParams(parsedRedir.hash.replace(/^#/, ""))
      : parsedRedir.searchParams;
  const code = redirParams.get("code") ?? undefined;
  const actionToken = redirParams.get("action_token") ?? undefined;
  if (!code) {
    return { dpop, redirectLocation: finalRedirectLocation, actionToken };
  }

  const tokenAssertion = await signClientAssertion();
  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
    ...(tokenAssertion
      ? {
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: tokenAssertion,
        }
      : {}),
  });
  const tokRes = await dpop.fetchWithDpop(`${params.groupHost.url}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: tokenBody.toString(),
  });
  if (tokRes.status !== 200) {
    throw new Error(`Group Host /oauth/token failed (${tokRes.status}): ${await tokRes.text()}`);
  }
  const tokenResponse = (await tokRes.json()) as {
    access_token: string;
    refresh_token?: string;
    token_type: "DPoP";
    sub: string;
    scope: string;
    expires_in: number;
  };
  const saved: NodeSavedSession = {
    dpopJwk: jwkSchema.parse(dpop.privateJwk),
    authMethod: params.clientAssertion
      ? { method: "private_key_jwt" as const, kid: params.clientAssertion.kid }
      : { method: "none" as const },
    tokenSet: {
      iss: params.groupHost.url,
      sub: asAtprotoDid(tokenResponse.sub),
      aud: groupHostPdsServiceEndpoint(params.groupHost.config),
      scope: asAtprotoOAuthScope(tokenResponse.scope),
      access_token: tokenResponse.access_token,
      ...(tokenResponse.refresh_token ? { refresh_token: tokenResponse.refresh_token } : {}),
      token_type: "DPoP" as const,
      expires_at: new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString(),
    },
  };
  return { dpop, redirectLocation: finalRedirectLocation, code, actionToken, tokenResponse, saved };
}

/**
 * Writes `group.opensocial.acceptance/self` on `member`'s personal PDS for `groupDid`, stamping `"new.flock.incarnation"`
 * from `membership/<member.did>` on `groupHost` when readable.
 */
export async function acceptGroupMembership(
  pds: Pick<PdsNetwork, "plcUrl">,
  member: NetworkActor,
  groupDid: string,
): Promise<void> {
  const { createEngine } = await import("@flock/client/engine");
  await createEngine(actorTransport(pds, member)).workspaces.accept(workspaceUri(groupDid));
}

/**
 * Creates a real OpenSocial group (`did:plc:...`) on `pds.groupHost` via OAuth `prompt=create` for `owner`,
 * stores the Operator's `authority_grant` (unless `storeOperatorGrant === false`), and writes `owner`'s `acceptance/self`
 * on `owner.pds` (unless `skipAcceptance === true`).
 */
export async function createOpenSocialGroup(
  pds: Pick<PdsNetwork, "groupHost" | "plcUrl">,
  owner: NetworkActor,
  options: {
    name?: string;
    handle?: string;
    joinPolicy?: "invite" | "approval" | "open";
    publicMeta?: boolean;
    creationKey?: string;
    keyLabel?: string;
    storeOperatorGrant?: boolean;
    grantCreationAuth?: boolean;
    skipAcceptance?: boolean;
    scope?: string;
  } = {},
): Promise<{
  groupDid: string;
  workspace: string;
  handle: string;
  accessToken: string;
  refreshToken: string;
  dpop: DpopClient;
  saved: NodeSavedSession;
}> {
  const [{ authorityClientMetadata }, { oauthSqliteStore }, { grantCreationAuthorization }] = await Promise.all([
    import("@flock/operator/operator/authority-grant"),
    import("@flock/operator/auth/encrypted-store"),
    import("@flock/operator/operator/creation-authorization"),
  ]);
  const metadata = authorityClientMetadata();
  const scope = options.scope ?? metadata.scope;
  const redirectUri = metadata.redirect_uris[0];
  const clientId =
    scope === metadata.scope
      ? metadata.client_id
      : `http://localhost?${new URLSearchParams({ scope, redirect_uri: redirectUri }).toString()}`;
  const displayName = options.name ?? "Workspace";

  const completed = await completeRealGroupOAuthFlow({
    groupHost: pds.groupHost,
    actor: owner,
    scope,
    clientId,
    redirectUri,
    prompt: "create",
    createParams: {
      displayName,
      ...(options.handle ? { handle: options.handle } : {}),
      joinPolicy: options.joinPolicy ?? "invite",
      publicMeta: options.publicMeta ?? true,
      ...(options.creationKey ? { creationKey: options.creationKey } : {}),
    },
    keyLabel: options.keyLabel ?? `grp-${owner.handle}-${randomUUID().slice(0, 8)}`,
  });
  assert.ok(completed.tokenResponse && completed.saved, "Expected Group OAuth tokenResponse for prompt=create");
  const groupDid = completed.tokenResponse.sub;
  const acctRow = pds.groupHost.db
    .prepare("SELECT handle FROM group_account WHERE did = ?")
    .get(groupDid) as { handle: string } | undefined;

  if (options.storeOperatorGrant !== false) {
    await oauthSqliteStore("authority_grant").set(groupDid, completed.saved);
    if (options.grantCreationAuth !== false) {
      grantCreationAuthorization({ authorityDid: groupDid, initiatorDid: owner.did, name: displayName }, Math.floor(Date.now() / 1000));
    }
  }
  if (!options.skipAcceptance) {
    await acceptGroupMembership(pds, owner, groupDid);
  }
  return {
    groupDid,
    workspace: workspaceUri(groupDid),
    handle: acctRow?.handle ?? "",
    accessToken: completed.tokenResponse.access_token,
    refreshToken: completed.tokenResponse.refresh_token ?? "",
    dpop: completed.dpop,
    saved: completed.saved,
  };
}

/**
 * Mints a real Group-DID OAuth grant for `groupDid` (authenticated via `actor` at `actor.pds`) and stores it in Operator's `authority_grant` table.
 */
export async function storeGroupAuthorityGrant(
  pds: Pick<PdsNetwork, "groupHost">,
  actor: NetworkActor,
  groupDid: string,
  keyLabel: string,
  options: { scope?: string; groupHost?: RunningGroupHost } = {},
): Promise<{ accessToken: string; refreshToken: string; saved: NodeSavedSession }> {
  const [{ authorityClientMetadata }, { oauthSqliteStore }] = await Promise.all([
    import("@flock/operator/operator/authority-grant"),
    import("@flock/operator/auth/encrypted-store"),
  ]);
  const metadata = authorityClientMetadata();
  const scope = options.scope ?? metadata.scope;
  const redirectUri = metadata.redirect_uris[0];
  const clientId =
    scope === metadata.scope
      ? metadata.client_id
      : `http://localhost?${new URLSearchParams({ scope, redirect_uri: redirectUri }).toString()}`;
  const completed = await completeRealGroupOAuthFlow({
    groupHost: options.groupHost ?? pds.groupHost,
    actor,
    scope,
    clientId,
    redirectUri,
    loginHint: groupDid,
    keyLabel,
  });
  assert.ok(completed.tokenResponse && completed.saved, `Expected Group OAuth grant for ${groupDid}`);
  await oauthSqliteStore("authority_grant").set(groupDid, completed.saved);
  return {
    accessToken: completed.tokenResponse.access_token,
    refreshToken: completed.tokenResponse.refresh_token ?? "",
    saved: completed.saved,
  };
}

export async function storeAuthorityGrant(
  pds: TestPds,
  did: string,
  keyLabel: string,
  options: { scope?: string } = {},
): Promise<{ accessToken: string }> {
  const [{ authorityClientMetadata }, { oauthSqliteStore }] = await Promise.all([
    import("@flock/operator/operator/authority-grant"),
    import("@flock/operator/auth/encrypted-store"),
  ]);
  const metadata = authorityClientMetadata();
  const scope = options.scope ?? metadata.scope;
  const { saved, accessToken } = await mintProviderSession(
    pds,
    did,
    { clientId: metadata.client_id, redirectUri: metadata.redirect_uris[0], scope },
    keyLabel,
  );
  await oauthSqliteStore("authority_grant").set(did, saved);
  return { accessToken };
}

async function mintProviderSession(
  pds: OAuthProviderHost,
  did: string,
  request: { clientId: string; redirectUri: string; scope: string },
  keyLabel: string,
): Promise<{ saved: NodeSavedSession; accessToken: string }> {
  assert.ok(pds.ctx.oauthProvider, "the local PDS test network exposes its OAuth provider");
  const [{ JoseKey }, { generateCode }] = await Promise.all([
    import("@atproto/jwk-jose"),
    import(pathToFileURL(join(pinnedCheckout(), "packages/oauth/oauth-provider/src/request/code.ts")).href) as Promise<{
      generateCode(): Promise<string>;
    }>,
  ]);
  const client = await pds.ctx.oauthProvider.clientManager.getClient(request.clientId);
  client.validateRequest({
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    response_type: "code",
    scope: request.scope,
  });
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
    {
      client_id: request.clientId,
      redirect_uri: request.redirectUri,
      response_type: "code",
      scope: request.scope,
      dpop_jkt: dpopJkt,
    },
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

export async function ageProviderSession(pds: TestPds, accessToken: string, ageMs: number): Promise<void> {
  assert.ok(pds.ctx.oauthProvider);
  const found = await pds.ctx.oauthProvider.tokenManager.findToken(accessToken);
  assert.ok(found, "the provider holds the token to age");
  const then = new Date(Date.now() - ageMs).toISOString();
  await pds.ctx.accountManager.db.db
    .updateTable("token")
    .set({ createdAt: then, updatedAt: then })
    .where("tokenId", "=", found.id)
    .execute();
}

export async function ageGroupSessionAtHost(groupHost: RunningGroupHost, groupDid: string, ageMs: number): Promise<void> {
  const pastMs = Date.now() - ageMs;
  groupHost.db
    .prepare("UPDATE oauth_session SET created_at = ? WHERE group_did = ?")
    .run(pastMs, groupDid);
  groupHost.db
    .prepare(
      "UPDATE oauth_refresh_token SET expires_at = ?, created_at = ? WHERE session_id IN (SELECT session_id FROM oauth_session WHERE group_did = ?)",
    )
    .run(pastMs, pastMs, groupDid);
}

export async function ageOAuthSessionAtProvider(
  pds: TestPds,
  table: SessionTable,
  did: string,
  accessToken: string,
  ageMs: number,
): Promise<void> {
  await ageProviderSession(pds, accessToken, ageMs);
  await expireStoredSession(table, did);
}

export async function expireStoredSession(table: SessionTable, did: string): Promise<void> {
  const { oauthSqliteStore } = await import("@flock/operator/auth/encrypted-store");
  const store = oauthSqliteStore(table);
  const saved = await store.get(did);
  assert.ok(saved && "tokenSet" in saved && saved.tokenSet, `a session is stored in ${table}`);
  const expired = structuredClone(saved) as unknown as { tokenSet: Record<string, unknown> };
  expired.tokenSet.expires_at = new Date(Date.now() - 1_000).toISOString();
  await store.set(did, expired as never);
}

export async function combinedMemberScopes(serviceRef: string): Promise<string[]> {
  return (await import("@flock/protocol/scopes")).memberGrantScopes(serviceRef).filter((scope) => scope !== "atproto");
}

let sharedInProcessOperatorPort: Promise<number> | undefined;
let activePlcOrigin: string | undefined;
let plcForwarderOrigin: Promise<string> | undefined;
let operatorServed: Promise<string> | undefined;

async function freeLoopbackPort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolvePort, rejectPort) => {
    probe.once("error", rejectPort);
    probe.listen(0, "127.0.0.1", resolvePort);
  });
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolveClose, rejectClose) => probe.close((err) => (err ? rejectClose(err) : resolveClose())));
  return port;
}

function getSharedInProcessOperatorPort(): Promise<number> {
  sharedInProcessOperatorPort ??= freeLoopbackPort();
  return sharedInProcessOperatorPort;
}

function sharedPlcProxy(targetOrigin: string): Promise<string> {
  activePlcOrigin = targetOrigin;
  plcForwarderOrigin ??= (async () => {
    const server = createHttpServer(async (req, res) => {
      try {
        const target = new URL(req.url ?? "/", activePlcOrigin!);
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
        const hopByHop = new Set(["host", "connection", "keep-alive", "transfer-encoding", "content-length", "upgrade"]);
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) {
          if (hopByHop.has(name.toLowerCase()) || value === undefined) continue;
          headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
        const upstream = await fetch(target, {
          method: req.method,
          headers,
          ...(body && req.method !== "GET" && req.method !== "HEAD" ? { body } : {}),
        });
        const outHeaders: Record<string, string> = {};
        upstream.headers.forEach((value, name) => {
          if (hopByHop.has(name.toLowerCase()) || name.toLowerCase() === "content-encoding") return;
          outHeaders[name] = value;
        });
        res.writeHead(upstream.status, outHeaders);
        res.end(Buffer.from(await upstream.arrayBuffer()));
      } catch (error) {
        res.writeHead(502, { "content-type": "text/plain" }).end(String(error));
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    server.unref();
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return `http://127.0.0.1:${address.port}`;
  })();
  return plcForwarderOrigin;
}

export function inProcessOperator(): Promise<string> {
  operatorServed ??= (async () => {
    const { createOperatorApp } = await import("@flock/operator/operator/server");
    const app = createOperatorApp();
    const preferredPort = process.env.OPERATOR_URL ? Number(new URL(process.env.OPERATOR_URL).port) : 0;
    const listenPort = preferredPort > 0 ? preferredPort : 0;
    const server = createHttpServer(app);
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(listenPort, "127.0.0.1", () => resolveListen());
    });
    server.unref();
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return `http://127.0.0.1:${address.port}`;
  })().catch((error) => {
    operatorServed = undefined;
    throw error;
  });
  return operatorServed;
}

export async function callOperatorMethod(
  session: { did: string; fetchHandler(path: string, init: RequestInit): Promise<Response> },
  serviceRef: string,
  method: import("@flock/protocol/nsids").OperatorMethod,
  query: Record<string, string>,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const { sessionClient } = await import("@flock/operator/atproto/client");
  const { token } = await sessionClient(session as never).query<{ token: string }>("com.atproto.server.getServiceAuth", {
    aud: serviceRef,
    lxm: method,
  });
  const url = new URL(`/xrpc/${method}`, await inProcessOperator());
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const answer = (await response.json()) as Record<string, unknown>;
  if (response.status !== 200) throw new Error(`${method} answered ${response.status}: ${JSON.stringify(answer)}`);
  return answer;
}

export type Outcome = { ok: true } | { ok: false; error: string };

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

export function actorTransport(
  network: Pick<PdsNetwork, "plcUrl">,
  actor: Pick<NetworkActor, "did" | "accessJwt"> & { pds: { url: string } },
  options: { now?: () => number; fetchVia?: (request: Request) => Promise<Response> } = {},
): import("@flock/client/transport").ClientTransport {
  const send = options.fetchVia ?? ((request: Request) => fetch(request));
  const documents = new Map<
    string,
    Promise<{ service?: Array<{ id?: string; serviceEndpoint?: unknown }>; verificationMethod?: unknown }>
  >();
  const document = (did: string, forceRefresh: boolean) => {
    const cached = documents.get(did);
    if (cached && !forceRefresh) return cached;
    let docUrl: URL;
    if (did.startsWith("did:web:")) {
      const hostPort = decodeURIComponent(did.slice("did:web:".length));
      const normalizedHostPort = hostPort.replace(/^localhost(?=:|$)/i, "127.0.0.1");
      docUrl = new URL("/.well-known/did.json", `http://${normalizedHostPort}`);
    } else {
      docUrl = new URL(`/${encodeURIComponent(did)}`, network.plcUrl);
    }
    const resolved = send(new Request(docUrl)).then(async (response) => {
      if (response.status === 404 || response.status === 410) {
        throw new DidNotFoundError(did, `PLC answered ${response.status} for ${did}.`);
      }
      if (!response.ok) throw new Error(`PLC answered ${response.status} for ${did}.`);
      return (await response.json()) as {
        service?: Array<{ id?: string; serviceEndpoint?: unknown }>;
        verificationMethod?: unknown;
      };
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
    resolvePds: async (did, forceRefresh = false) => {
      const endpoint = (await document(did, forceRefresh)).service?.find(
        (service) => service.id === "#atproto_pds" || service.id === `${did}#atproto_pds`,
      )?.serviceEndpoint;
      if (typeof endpoint !== "string") throw new Error(`No PDS in the DID document of ${did}.`);
      return endpoint;
    },
    resolveKemKey: async (did, forceRefresh = false) => kemKeyFromDidDocument(did, await document(did, forceRefresh)),
    fetchEndpoint: send,
    generateKey: generateSpaceKey,
    ...(options.now ? { now: options.now } : {}),
  };
}
