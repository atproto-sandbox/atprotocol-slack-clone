import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { P256Keypair } from "@atproto/crypto";
import { createServiceJwt } from "@atproto/xrpc-server";
import {
  formatDidDoc,
  getLastOpWithCid,
  validateOperationLog,
  type CompatibleOpOrTombstone,
} from "@did-plc/lib";
import express from "express";
import * as jose from "jose";
import { createGroupGenesisPlcOp } from "./plc";
import { startGroupHostServer, type RunningGroupHost } from "./server";

export const TEST_ENCRYPTION_KEY_HEX =
  "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

export type TestUser = {
  did: string;
  handle: string;
  pdsUrl: string;
  signingKey: P256Keypair;
  kemKey: P256Keypair;
  rotationKey: P256Keypair;
  signServiceJwt: (aud: string, lxm: string, expSec?: number, jti?: string) => Promise<string>;
};

export type MockPlcServer = {
  url: string;
  opsByDid: Map<string, CompatibleOpOrTombstone[]>;
  /** Optional hook to inject custom HTTP responses (e.g. 500/400/409) on `POST /:did` */
  interceptPost?: (did: string, op: CompatibleOpOrTombstone) => { status: number; body: unknown } | null;
  close: () => Promise<void>;
};

export async function startMockPlcServer(): Promise<MockPlcServer> {
  const opsByDid = new Map<string, CompatibleOpOrTombstone[]>();
  let interceptPost: MockPlcServer["interceptPost"];

  const app = express();
  app.use(express.json({ limit: "256kb" }));

  app.post("/:did", async (req, res) => {
    try {
      const did = decodeURIComponent(req.params.did);
      const op = req.body as CompatibleOpOrTombstone;
      if (interceptPost) {
        const custom = interceptPost(did, op);
        if (custom) {
          res.status(custom.status).json(custom.body);
          return;
        }
      }
      const existing = opsByDid.get(did) ?? [];
      if (existing.length > 0) {
        const last = await getLastOpWithCid(existing);
        if (last.op.type === "plc_tombstone") {
          res.status(409).json({ message: "DID is tombstoned" });
          return;
        }
        const proposedPrev = (op as { prev?: string | null }).prev ?? null;
        if (proposedPrev !== last.cid.toString()) {
          res.status(409).json({ message: `Stale prev CID: expected ${last.cid.toString()}, got ${String(proposedPrev)}` });
          return;
        }
      }
      const nextLog = [...existing, op];
      await validateOperationLog(did, nextLog);
      opsByDid.set(did, nextLog);
      res.status(200).json({ ok: true });
    } catch (err) {
      res.status(400).json({ message: err instanceof Error ? err.message : "Invalid PLC op" });
    }
  });

  app.get("/:did/log/last", (req, res) => {
    const did = decodeURIComponent(req.params.did);
    const ops = opsByDid.get(did);
    if (!ops || ops.length === 0) {
      res.status(404).json({ message: "DID not found" });
      return;
    }
    res.json(ops[ops.length - 1]);
  });

  app.get("/:did/log", (req, res) => {
    const did = decodeURIComponent(req.params.did);
    const ops = opsByDid.get(did);
    if (!ops || ops.length === 0) {
      res.status(404).json({ message: "DID not found" });
      return;
    }
    res.json(ops);
  });

  app.get("/:did", async (req, res) => {
    try {
      const did = decodeURIComponent(req.params.did);
      const ops = opsByDid.get(did);
      if (!ops || ops.length === 0) {
        res.status(404).json({ message: "DID not found" });
        return;
      }
      const docData = await validateOperationLog(did, ops);
      if (!docData) {
        res.status(410).json({ message: "DID tombstoned" });
        return;
      }
      res.type("application/did+ld+json").json(formatDidDoc(docData));
    } catch (err) {
      res.status(500).json({ message: err instanceof Error ? err.message : "PLC error" });
    }
  });

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;

  const plc: MockPlcServer = {
    url: `http://127.0.0.1:${port}`,
    opsByDid,
    get interceptPost() {
      return interceptPost;
    },
    set interceptPost(fn) {
      interceptPost = fn;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  return plc;
}

export type MockPersonalPds = {
  url: string;
  server: HttpServer;
  usersByDid: Map<string, TestUser>;
  usersByHandle: Map<string, TestUser>;
  revokedTokens: string[];
  receivedRepoUpdates: Array<{ space: string; repo: string; rev: string; authorization: string | undefined }>;
  receivedCredentialsRevoked: Array<{ credentials: string[]; jtis: string[]; authorization: string | undefined }>;
  receivedSpaceUpdates: Array<{ space: string; token: string; update: Record<string, unknown> }>;
  failInviteDeliveryForDid: Set<string>;
  registerUser: (handle: string) => Promise<TestUser>;
  close: () => Promise<void>;
};

export async function startMockPersonalPds(plc: MockPlcServer): Promise<MockPersonalPds> {
  const usersByDid = new Map<string, TestUser>();
  const usersByHandle = new Map<string, TestUser>();
  const revokedTokens: string[] = [];
  const receivedRepoUpdates: MockPersonalPds["receivedRepoUpdates"] = [];
  const receivedCredentialsRevoked: MockPersonalPds["receivedCredentialsRevoked"] = [];
  const receivedSpaceUpdates: MockPersonalPds["receivedSpaceUpdates"] = [];
  const failInviteDeliveryForDid = new Set<string>();

  const asKey = await jose.generateKeyPair("ES256", { extractable: true });
  const asPubJwk = await jose.exportJWK(asKey.publicKey);
  asPubJwk.kid = "pds-as-1";
  asPubJwk.alg = "ES256";
  asPubJwk.use = "sig";

  const parMap = new Map<
    string,
    {
      clientId: string;
      redirectUri: string;
      state?: string;
      loginHint?: string;
      codeChallenge: string;
    }
  >();
  const codeMap = new Map<string, { sub: string; clientId: string; redirectUri: string; codeChallenge: string }>();

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const pdsNonce = "pds-nonce-1";

  const app = express();
  app.use(express.json({ limit: "512kb" }));
  app.use(express.urlencoded({ extended: false }));

  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({
      resource: baseUrl,
      authorization_servers: [baseUrl],
      bearer_methods_supported: ["header"],
      scopes_supported: ["atproto"],
    });
  });

  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      pushed_authorization_request_endpoint: `${baseUrl}/oauth/par`,
      revocation_endpoint: `${baseUrl}/oauth/revoke`,
      jwks_uri: `${baseUrl}/oauth/jwks.json`,
      require_pushed_authorization_requests: true,
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      response_types_supported: ["code"],
      response_modes_supported: ["query", "fragment"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
      token_endpoint_auth_signing_alg_values_supported: ["ES256"],
      dpop_signing_alg_values_supported: ["ES256"],
      scopes_supported: ["atproto"],
    });
  });

  app.get("/oauth/jwks.json", (_req, res) => {
    res.json({ keys: [asPubJwk] });
  });

  app.get("/xrpc/com.atproto.identity.resolveHandle", (req, res) => {
    const handle = String(req.query.handle ?? "").toLowerCase();
    const user = usersByHandle.get(handle);
    if (!user) {
      res.status(400).json({ error: "InvalidRequest", message: "Unable to resolve handle" });
      return;
    }
    res.json({ did: user.did });
  });

  app.post("/oauth/par", (req, res) => {
    res.setHeader("DPoP-Nonce", pdsNonce);
    const dpop = req.headers.dpop;
    if (typeof dpop === "string") {
      const payload = JSON.parse(Buffer.from(dpop.split(".")[1]!, "base64url").toString("utf8")) as { nonce?: string };
      if (payload.nonce !== pdsNonce) {
        res.status(400).json({ error: "use_dpop_nonce", error_description: "Provide DPoP nonce" });
        return;
      }
    }
    const requestUri = `urn:ietf:params:oauth:request_uri:${randomUUID()}`;
    parMap.set(requestUri, {
      clientId: String(req.body.client_id),
      redirectUri: String(req.body.redirect_uri),
      state: typeof req.body.state === "string" ? req.body.state : undefined,
      loginHint: typeof req.body.login_hint === "string" ? req.body.login_hint : undefined,
      codeChallenge: String(req.body.code_challenge),
    });
    res.status(201).json({ request_uri: requestUri, expires_in: 60 });
  });

  app.get("/oauth/authorize", (req, res) => {
    const requestUri = String(req.query.request_uri ?? "");
    const par = parMap.get(requestUri);
    if (!par) {
      res.status(400).send("Unknown request_uri");
      return;
    }
    parMap.delete(requestUri);
    // Allow tests to override which personal user authenticates via `?as_did=`
    const overrideDid = typeof req.query.as_did === "string" ? req.query.as_did : undefined;
    const hint = overrideDid ?? par.loginHint ?? "";
    const user = usersByDid.get(hint) ?? usersByHandle.get(hint.toLowerCase()) ?? [...usersByDid.values()][0];
    if (!user) {
      res.status(400).send("Unknown user");
      return;
    }
    const code = `pds-code-${randomUUID()}`;
    codeMap.set(code, {
      sub: user.did,
      clientId: par.clientId,
      redirectUri: par.redirectUri,
      codeChallenge: par.codeChallenge,
    });
    const redir = new URL(par.redirectUri);
    redir.searchParams.set("code", code);
    if (par.state) redir.searchParams.set("state", par.state);
    redir.searchParams.set("iss", baseUrl);
    res.redirect(303, redir.toString());
  });

  app.post("/oauth/token", async (req, res) => {
    res.setHeader("DPoP-Nonce", pdsNonce);
    const dpop = req.headers.dpop;
    if (typeof dpop !== "string") {
      res.status(400).json({ error: "invalid_dpop_proof" });
      return;
    }
    const dpopPayload = JSON.parse(Buffer.from(dpop.split(".")[1]!, "base64url").toString("utf8")) as { nonce?: string };
    if (dpopPayload.nonce !== pdsNonce) {
      res.status(400).json({ error: "use_dpop_nonce" });
      return;
    }
    const code = String(req.body.code ?? "");
    const entry = codeMap.get(code);
    if (!entry) {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }
    codeMap.delete(code);
    const verifier = String(req.body.code_verifier ?? "");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (challenge !== entry.codeChallenge) {
      res.status(400).json({ error: "invalid_grant", error_description: "PKCE mismatch" });
      return;
    }
    const accessToken = await new jose.SignJWT({ scope: "atproto" })
      .setProtectedHeader({ alg: "ES256", typ: "at+jwt", kid: "pds-as-1" })
      .setIssuer(baseUrl)
      .setSubject(entry.sub)
      .setAudience(baseUrl)
      .setIssuedAt()
      .setExpirationTime("15m")
      .setJti(randomUUID())
      .sign(asKey.privateKey);
    res.json({
      access_token: accessToken,
      token_type: "DPoP",
      expires_in: 900,
      refresh_token: `pds-rt-${randomUUID()}`,
      scope: "atproto",
      sub: entry.sub,
    });
  });

  app.post("/oauth/revoke", (req, res) => {
    res.setHeader("DPoP-Nonce", pdsNonce);
    if (typeof req.body?.token === "string") {
      revokedTokens.push(req.body.token);
    }
    res.status(200).json({});
  });

  app.post("/xrpc/com.atproto.space.confirmRegistration", (req, res) => {
    res.json({ challenge: req.body?.challenge });
  });

  app.post("/xrpc/com.atproto.space.notifySpaceUpdate", (req, res) => {
    receivedSpaceUpdates.push({
      space: String(req.body?.space ?? ""),
      token: String(req.body?.token ?? ""),
      update: (req.body?.update ?? {}) as Record<string, unknown>,
    });
    res.json({});
  });

  app.post("/xrpc/com.atproto.space.notifyRepoUpdate", (req, res) => {
    const space = String(req.body?.space ?? "");
    for (const did of failInviteDeliveryForDid) {
      if (space.startsWith(`at://${did}/`)) {
        res.status(503).json({ error: "UpstreamUnavailable", message: "Simulated invite delivery failure" });
        return;
      }
    }
    receivedRepoUpdates.push({
      space,
      repo: String(req.body?.repo ?? ""),
      rev: String(req.body?.rev ?? ""),
      authorization: req.headers.authorization,
    });
    res.json({});
  });

  app.post("/xrpc/com.atproto.space.notifyCredentialsRevoked", (req, res) => {
    const credentials = req.body?.credentials;
    if (
      typeof req.body?.space !== "string" ||
      !Array.isArray(credentials) ||
      credentials.length < 1 ||
      credentials.length > 100 ||
      credentials.some((c: unknown) => typeof c !== "string" || c.length < 1)
    ) {
      res.status(400).json({ error: "InvalidRequest", message: "space and 1..100 credentials required" });
      return;
    }
    receivedCredentialsRevoked.push({
      credentials: credentials as string[],
      jtis: credentials as string[],
      authorization: req.headers.authorization,
    });
    res.json({});
  });

  server.on("request", app);

  return {
    url: baseUrl,
    server,
    usersByDid,
    usersByHandle,
    revokedTokens,
    receivedRepoUpdates,
    receivedCredentialsRevoked,
    receivedSpaceUpdates,
    failInviteDeliveryForDid,
    async registerUser(handle: string): Promise<TestUser> {
      const signingKey = await P256Keypair.create({ exportable: true });
      const kemKey = await P256Keypair.create({ exportable: true });
      const rotationKey = await P256Keypair.create({ exportable: true });
      const { did, genesisOp } = await createGroupGenesisPlcOp({
        handle,
        pdsEndpoint: baseUrl,
        signingKey,
        kemKey,
        rotationKey,
      });
      const plcRes = await fetch(`${plc.url}/${encodeURIComponent(did)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(genesisOp),
      });
      if (!plcRes.ok) {
        throw new Error(`Failed to register mock user on PLC: ${plcRes.status}`);
      }
      const user: TestUser = {
        did,
        handle: handle.toLowerCase(),
        pdsUrl: baseUrl,
        signingKey,
        kemKey,
        rotationKey,
        async signServiceJwt(aud: string, lxm: string, expSec = 60): Promise<string> {
          const nowSec = Math.floor(Date.now() / 1000);
          return createServiceJwt({
            iss: did,
            aud,
            lxm,
            iat: nowSec,
            exp: nowSec + expSec,
            keypair: signingKey,
          });
        },
      };
      usersByDid.set(did, user);
      usersByHandle.set(handle.toLowerCase(), user);
      return user;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export type DpopTestClient = {
  publicJwk: jose.JWK;
  dpopJkt: string;
  keyPair: jose.GenerateKeyPairResult<jose.KeyLike>;
  signProof: (params: {
    htm: string;
    htu: string;
    nonce?: string;
    accessToken?: string;
    jti?: string;
    iatSec?: number;
  }) => Promise<string>;
  fetchWithDpop: (
    url: string,
    init: RequestInit & { accessToken?: string },
  ) => Promise<Response>;
};

export async function createDpopTestClient(): Promise<DpopTestClient> {
  const keyPair = await jose.generateKeyPair("ES256", { extractable: true });
  const publicJwk = await jose.exportJWK(keyPair.publicKey);
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
      ...(params.accessToken
        ? { ath: createHash("sha256").update(params.accessToken).digest("base64url") }
        : {}),
    };
    const jwt = new jose.SignJWT(claims)
      .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: publicJwk })
      .setIssuedAt(params.iatSec ?? Math.floor(Date.now() / 1000))
      .setJti(params.jti ?? randomUUID());
    return jwt.sign(keyPair.privateKey);
  }

  async function fetchWithDpop(
    url: string,
    init: RequestInit & { accessToken?: string },
  ): Promise<Response> {
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
      if (init.accessToken) {
        headers.set("Authorization", `DPoP ${init.accessToken}`);
      }
      const res = await fetch(url, { ...init, method, headers, redirect: init.redirect ?? "manual" });
      const nextNonce = res.headers.get("dpop-nonce");
      if (nextNonce) cachedNonce = nextNonce;
      if (attempt === 0 && (res.status === 400 || res.status === 401) && nextNonce) {
        const cloned = res.clone();
        const wwwAuth = res.headers.get("www-authenticate") ?? "";
        const text = await cloned.text().catch(() => "");
        if (wwwAuth.includes("use_dpop_nonce") || text.includes("use_dpop_nonce")) {
          continue;
        }
      }
      return res;
    }
    throw new Error("Unreachable");
  }

  return {
    publicJwk,
    dpopJkt,
    keyPair,
    signProof,
    fetchWithDpop,
  };
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/**
 * End-to-end helper that runs full downstream + upstream OAuth `prompt=create` or `login_hint=<groupDid>`
 * against a live `RunningGroupHost` and `MockPersonalPds`!
 */
export async function completeGroupOAuthFlow(params: {
  groupHost: RunningGroupHost;
  pds: MockPersonalPds;
  user: TestUser;
  scope: string;
  dpop?: DpopTestClient;
  clientId?: string;
  redirectUri?: string;
  responseMode?: "query" | "fragment";
  prompt?: string;
  loginHint?: string;
  createParams?: {
    displayName: string;
    handle?: string;
    joinPolicy?: "invite" | "approval" | "open";
    publicMeta?: boolean;
    creationKey?: string;
  };
  decision?: "approve" | "deny";
}): Promise<{
  dpop: DpopTestClient;
  redirectLocation: string;
  tokenResponse?: {
    access_token: string;
    refresh_token: string;
    token_type: string;
    sub: string;
    scope: string;
    expires_in: number;
  };
}> {
  const dpop = params.dpop ?? (await createDpopTestClient());
  const redirectUri = params.redirectUri ?? "http://127.0.0.1:43123/callback";
  const clientId =
    params.clientId ??
    `http://localhost?redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(params.scope)}`;
  const pkce = createPkcePair();
  const state = `st-${randomUUID()}`;

  // 1. Downstream `/oauth/par`
  const parBody = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    scope: params.scope,
    state,
    ...(params.responseMode ? { response_mode: params.responseMode } : {}),
    ...(params.prompt ? { prompt: params.prompt } : {}),
    ...(params.loginHint ? { login_hint: params.loginHint } : {}),
    ...(params.createParams?.creationKey ? { creation_key: params.createParams.creationKey } : {}),
  });
  const parRes = await dpop.fetchWithDpop(`${params.groupHost.url}/oauth/par`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: parBody.toString(),
  });
  if (parRes.status !== 201) {
    throw new Error(`PAR failed (${parRes.status}): ${await parRes.text()}`);
  }
  const { request_uri: requestUri } = (await parRes.json()) as { request_uri: string };

  // 2. Downstream `/oauth/authorize` -> HTML form with CSRF token -> POST `/oauth/authorize` -> redirect to upstream PDS
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
      throw new Error(`Missing csrf_token in /oauth/authorize HTML: ${formHtml}`);
    }
    const postForm = new URLSearchParams({
      client_id: clientId,
      request_uri: requestUri,
      csrf_token: csrfMatch[1],
      actor: params.user.did,
      decision: params.decision === "deny" && params.prompt === "create" ? "deny" : "approve",
    });
    if (params.prompt === "create") {
      const creationKey = params.createParams?.creationKey ?? creationKeyMatch?.[1] ?? `ck-${randomUUID()}`;
      postForm.set("creation_key", creationKey);
      postForm.set("display_name", params.createParams?.displayName ?? "Engineering");
      postForm.set("join_policy", params.createParams?.joinPolicy ?? "invite");
      if (params.createParams?.publicMeta ?? true) {
        postForm.set("public_meta", "true");
      }
      if (params.createParams?.handle) {
        postForm.set("handle", params.createParams.handle);
      }
    } else if (!params.loginHint) {
      throw new Error("loginHint is required for non-create completeGroupOAuthFlow");
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
    throw new Error(`Expected redirect from /oauth/authorize, got ${authRes.status}: ${await authRes.text()}`);
  }
  const setCookieRaw = authRes.headers.getSetCookie();
  const cookieHeader = setCookieRaw.map((c) => c.split(";")[0]!).join("; ");
  const upstreamAuthorizeUrl = new URL(authRes.headers.get("location")!);
  upstreamAuthorizeUrl.searchParams.set("as_did", params.user.did);

  // 3. Follow redirect to MockPersonalPds `/oauth/authorize` -> redirects to Group Host `/oauth/upstream-callback`
  const pdsAuthRes = await fetch(upstreamAuthorizeUrl.toString(), { redirect: "manual" });
  if (pdsAuthRes.status < 300 || pdsAuthRes.status >= 400) {
    throw new Error(`Mock PDS authorize failed (${pdsAuthRes.status}): ${await pdsAuthRes.text()}`);
  }
  const upstreamCallbackUrl = pdsAuthRes.headers.get("location")!;

  // 4. Call Group Host `GET /oauth/upstream-callback` with CSRF cookie!
  const cbRes = await fetch(upstreamCallbackUrl, {
    method: "GET",
    headers: { cookie: cookieHeader },
    redirect: "manual",
  });
  if (cbRes.status < 300 || cbRes.status >= 400) {
    throw new Error(`upstream-callback failed (${cbRes.status}): ${await cbRes.text()}`);
  }
  const cbLoc = cbRes.headers.get("location")!;
  let finalRedirectLocation: string;
  if (cbLoc.startsWith(`${params.groupHost.url}/oauth/confirm-action`)) {
    const consentCookieHeader = cbRes.headers
      .getSetCookie()
      .filter((c) => !c.includes("Max-Age=0"))
      .map((c) => c.split(";")[0]!)
      .join("; ");
    const getConfirmRes = await fetch(cbLoc, {
      method: "GET",
      headers: { cookie: consentCookieHeader },
      redirect: "manual",
    });
    if (getConfirmRes.status !== 200) {
      throw new Error(`GET /oauth/confirm-action failed (${getConfirmRes.status}): ${await getConfirmRes.text()}`);
    }
    const html = await getConfirmRes.text();
    const csrfMatch = /name="csrf_token"\s+value="([^"]+)"/.exec(html);
    const confirmBody = new URLSearchParams({
      csrf_token: csrfMatch?.[1] ?? "",
      decision: params.decision ?? "approve",
    });
    const confirmRes = await fetch(`${params.groupHost.url}/oauth/confirm-action`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: consentCookieHeader,
      },
      body: confirmBody.toString(),
      redirect: "manual",
    });
    if (confirmRes.status < 300 || confirmRes.status >= 400) {
      throw new Error(`confirm-action failed (${confirmRes.status}): ${await confirmRes.text()}`);
    }
    finalRedirectLocation = confirmRes.headers.get("location")!;
  } else {
    finalRedirectLocation = cbLoc;
  }

  // Parse code (from query or fragment)
  const parsedRedir = new URL(finalRedirectLocation);
  const redirParams =
    params.responseMode === "fragment"
      ? new URLSearchParams(parsedRedir.hash.replace(/^#/, ""))
      : parsedRedir.searchParams;
  const code = redirParams.get("code");
  if (!code) {
    return { dpop, redirectLocation: finalRedirectLocation };
  }

  // 5. Exchange code at `/oauth/token`
  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: pkce.verifier,
  });
  const tokRes = await dpop.fetchWithDpop(`${params.groupHost.url}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: tokenBody.toString(),
  });
  if (tokRes.status !== 200) {
    throw new Error(`Token exchange failed (${tokRes.status}): ${await tokRes.text()}`);
  }
  const tokenResponse = (await tokRes.json()) as {
    access_token: string;
    refresh_token: string;
    token_type: string;
    sub: string;
    scope: string;
    expires_in: number;
  };
  return { dpop, redirectLocation: finalRedirectLocation, tokenResponse };
}

export async function startTestGroupHost(params: {
  plc: MockPlcServer;
  encryptionKeyHex?: string;
  handleDomain?: string;
  overrides?: Parameters<typeof startGroupHostServer>[0];
}): Promise<RunningGroupHost> {
  return startGroupHostServer({
    port: 0,
    databasePath: ":memory:",
    plcUrl: params.plc.url,
    encryptionKeyHex: params.encryptionKeyHex ?? TEST_ENCRYPTION_KEY_HEX,
    handleDomain: params.handleDomain ?? "groups.localhost",
    allowLoopback: true,
    ...params.overrides,
  });
}
