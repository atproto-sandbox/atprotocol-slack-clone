import {
  COMMIT_MAC_TYPE,
  MAC_HEADER,
  RECORD_MAC_TYPE,
  SpaceMacError,
  WANT_MAC_HEADER,
  createSpaceSigHeaders,
  encapsulate,
  formatWantMacHeader,
  parseMacHeader,
  verifyCommit,
  verifyRecord,
  type Commit,
  type MacType,
} from "@atproto/space";
import { fromBase64 } from "@atproto/lex-data";
import { jsonToLex } from "@atproto/lexicon";
import type * as GetDelegationToken from "@/lexicons/api/types/com/atproto/space/getDelegationToken";
import { readUpstreamJson, readUpstreamText } from "@/lib/bounded-json";
import { isDid, parseSpaceUri, spaceRecordUri, type Did } from "@/protocol/keys";
import type { SpaceKey } from "./space-key";
import { AtprotoClient, MAX_XRPC_RESPONSE_BYTES, XrpcError } from "./xrpc";

/** The PDS default lifetime of a space credential; the protocol ceiling is one hour. */
export const SPACE_CREDENTIAL_LIFETIME_MS = 10 * 60 * 1000;
/** A cached credential is replaced once less than this remains of its lifetime. */
export const SPACE_CREDENTIAL_RENEW_BEFORE_MS = SPACE_CREDENTIAL_LIFETIME_MS / 6;
/** The protocol ceiling on a credential's lifetime. */
const SPACE_CREDENTIAL_MAX_LIFETIME_MS = 60 * 60 * 1000;
const GET_SPACE_CREDENTIAL = "/xrpc/com.atproto.space.getSpaceCredential";

/**
 * The reads this app makes that a repo host only serves to a space credential together with a MAC request, and the MAC type
 * each answers with. `listRepoOps` and `getRepo` need one too, but nothing here calls them; a call would be refused by the host
 * rather than accepted half-verified (a `listRepoOps` page without a commit carries no MAC).
 */
const MAC_METHODS: Readonly<Record<string, MacType>> = {
  "com.atproto.space.getRecord": RECORD_MAC_TYPE,
  "com.atproto.space.getLatestCommit": COMMIT_MAC_TYPE,
};

/** The author's `#atproto_kem` did:key; `forceRefresh` bypasses cached DID documents after a failed MAC (the key may have rotated). */
export type ResolveKemKey = (did: string, forceRefresh: boolean) => Promise<string>;

export type SpaceCredentialDeps = {
  memberClient: AtprotoClient;
  resolvePds(did: string): Promise<string>;
  resolveKemKey: ResolveKemKey;
  fetchEndpoint(request: Request): Promise<Response>;
  generateKey(): Promise<SpaceKey>;
  now?: () => number;
};

export class SpaceCredentialError extends Error {
  constructor(message: string, readonly status: 401 | 403 | 410, readonly code?: string) {
    super(message);
    this.name = "SpaceCredentialError";
  }
}

/**
 * Whether the authority reported the space deleted. A syncer that missed the deletion notice learns of it when its credential
 * renewal fails with `SpaceDeleted` (status 410), and then drops every copy it holds.
 */
export function isSpaceDeleted(error: unknown): boolean {
  return error instanceof SpaceCredentialError && error.code === "SpaceDeleted";
}

/**
 * Whether a failure means this account can no longer read the space, so whatever it cached from the space must be
 * dropped: the credential was refused or the space was deleted. `exchangeSpaceCredential` reports every refusal to issue a
 * credential as 401 or 403, including the `SpaceNotFound` the reference authority gives a user the policy does not
 * authorize, so a removed member's refusal lands here. A record read that returns 404 is only a missing record.
 */
export function isAccessLost(error: unknown): boolean {
  return isSpaceDeleted(error) || (typeof error === "object" && error !== null && "status" in error && (error.status === 401 || error.status === 403));
}

/**
 * Whether a repo host refused the credential itself (expired by its clock, or minted for another audience), as opposed to refusing the
 * reader access to the space. A cached credential the host refuses is useless, so its holder drops it and mints another.
 */
export function isCredentialRefused(error: unknown): boolean {
  return error instanceof XrpcError && (error.status === 401 || error.code === "InvalidCredential" || error.code === "BadSpaceAudience");
}

export type SpaceCredentialInit = {
  space: string;
  token: string;
  key: SpaceKey;
  fetchEndpoint: (request: Request) => Promise<Response>;
  resolveKemKey: ResolveKemKey;
  expiresAt?: number;
  renewBeforeMs?: number;
};

export class SpaceCredential {
  readonly space: string;
  readonly token: string;
  readonly key: SpaceKey;
  readonly expiresAt: number;
  /** How long before `expiresAt` a holder should stop reusing the credential and mint another. */
  readonly renewBeforeMs: number;
  private readonly fetchEndpoint: (request: Request) => Promise<Response>;
  private readonly resolveKemKey: ResolveKemKey;

  constructor(init: SpaceCredentialInit) {
    this.space = init.space;
    this.token = init.token;
    this.key = init.key;
    this.fetchEndpoint = init.fetchEndpoint;
    this.resolveKemKey = init.resolveKemKey;
    this.expiresAt = init.expiresAt ?? Date.now() + SPACE_CREDENTIAL_LIFETIME_MS;
    this.renewBeforeMs = init.renewBeforeMs ?? SPACE_CREDENTIAL_RENEW_BEFORE_MS;
  }

  /**
   * A client whose every request is signed for this credential. Reads that a repo host serves only with a MAC
   * (`getRecord`, `getLatestCommit`) also ask for one and are verified here, so no caller can use an unauthenticated
   * commit or record.
   */
  client(service: string | URL): AtprotoClient {
    const authorization = `Atproto-Space-Credential ${this.token}`;
    const key = this.key;
    const authorityDid = parseSpaceUri(this.space)?.authorityDid;
    if (!authorityDid) throw new Error("Invalid permissioned space URI.");
    const base = service instanceof URL ? service : new URL(service);
    return new AtprotoClient(async (path, init) => {
      const request = new Request(new URL(path, base), { ...init, redirect: "error" });
      const repo = requestedRepo(request);
      const headers = await createSpaceSigHeaders(key, { authorization, audience: repo ?? authorityDid });
      for (const [name, value] of Object.entries(headers)) request.headers.set(name, value);
      const macType = MAC_METHODS[xrpcMethod(request)];
      if (!macType) return this.fetchEndpoint(request);
      if (!repo) throw new Error(`${xrpcMethod(request)} needs a repo DID.`);
      return this.fetchWithVerifiedMac(request, macType, repo);
    });
  }

  /**
   * A fresh ephemeral key share per attempt (never reused, retries included). A response that fails verification
   * is retried once against a freshly resolved DID document, since the author may have rotated `#atproto_kem`.
   */
  private async fetchWithVerifiedMac(request: Request, type: MacType, repo: string): Promise<Response> {
    for (const forceRefresh of [false, true]) {
      const { keyShare, sharedSecret } = await encapsulate(await this.resolveKemKey(repo, forceRefresh));
      const attempt = request.clone();
      attempt.headers.set(WANT_MAC_HEADER, formatWantMacHeader(type, keyShare));
      const response = await this.fetchEndpoint(attempt);
      if (!response.ok) return response;
      // The body is read once, within the bound, and handed on as a replay: reading a clone of a stream the caller has not
      // started on would leave an oversized body waiting on the other branch forever.
      const text = await readUpstreamText(response, MAX_XRPC_RESPONSE_BYTES);
      if (text !== null && await macVerifies(response.headers, text, request, type, repo, sharedSecret)) return replayed(response, text);
    }
    throw new SpaceMacError(`${xrpcMethod(request)} for ${repo} failed MAC verification; the response is not trusted.`);
  }
}

/** The response a caller sees once its body has been read and verified. The length and encoding headers described the wire bytes. */
function replayed(response: Response, text: string): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(text, { status: response.status, statusText: response.statusText, headers });
}

/** A request for one repo is addressed to that repo's host; a space-wide request, to the space authority. */
function requestedRepo(request: Request): Did | undefined {
  const repo = request.method === "GET" ? new URL(request.url).searchParams.get("repo") : null;
  return isDid(repo) ? repo : undefined;
}

function xrpcMethod(request: Request): string {
  return new URL(request.url).pathname.replace(/^\/xrpc\//, "");
}

async function macVerifies(headers: Headers, text: string, request: Request, type: MacType, repo: string, sharedSecret: Uint8Array): Promise<boolean> {
  const params = new URL(request.url).searchParams;
  const space = params.get("space") ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const mac = macFromHeaders(headers, type);
  if (!mac) return false;
  if (type === RECORD_MAC_TYPE) {
    const record = parsed as { uri?: unknown; cid?: unknown; value?: unknown };
    if (typeof record.uri !== "string" || typeof record.cid !== "string" || typeof record.value !== "object" || record.value === null) return false;
    let uri: string;
    try {
      uri = spaceRecordUri(space, repo, params.get("collection") ?? "", params.get("rkey") ?? "");
    } catch {
      return false;
    }
    // The host stored the record in its Lexicon form (a `$link` is a CID, a `$bytes` is bytes) and answers in JSON, so the
    // value is converted back before its encoding is compared with the CID.
    const value = jsonToLex(record.value as Parameters<typeof jsonToLex>[0]) as Parameters<typeof verifyRecord>[0]["value"];
    return verifyRecord({ uri: record.uri, cid: record.cid, value }, { uri, sharedSecret, mac });
  }
  const commit = commitFromJson((parsed as { commit?: unknown }).commit);
  if (!commit || commit.repo !== repo || commit.space !== space) return false;
  return verifyCommit(commit, { space, repo, sharedSecret, mac });
}

function macFromHeaders(headers: Headers, type: MacType): Uint8Array | null {
  try {
    return parseMacHeader(headers.get(MAC_HEADER) ?? undefined, type);
  } catch {
    return null;
  }
}

function commitFromJson(value: unknown): Commit | null {
  if (typeof value !== "object" || value === null) return null;
  const commit = value as { ver?: unknown; repo?: unknown; space?: unknown; rev?: unknown; data?: unknown };
  const encoded = (commit.data as { $bytes?: unknown } | undefined)?.$bytes;
  if (typeof commit.ver !== "number" || typeof commit.repo !== "string" || typeof commit.space !== "string" || typeof commit.rev !== "string" || typeof encoded !== "string") return null;
  try {
    return { ver: commit.ver, repo: commit.repo, space: commit.space, rev: commit.rev, data: fromBase64(encoded) } as Commit;
  } catch {
    return null;
  }
}

/**
 * How long the authority made a credential last, from its own `iat` and `exp`, because the authority chooses the lifetime (ten
 * minutes by default, an hour at most) and a shorter one would otherwise be presented after it expired. Both claims come from the
 * issuer's clock, so the difference does not depend on the holder's, which a browser's often gets wrong; the holder adds it to its own
 * now. The token is read as its holder, never verified, and only to schedule renewal. `null` when it is not a JWT with a positive
 * lifetime within the protocol ceiling, and the default lifetime applies.
 */
export function credentialLifetimeMs(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    const claims = payload ? (JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as { iat?: unknown; exp?: unknown }) : undefined;
    if (typeof claims?.iat !== "number" || typeof claims.exp !== "number") return null;
    const lifetime = (claims.exp - claims.iat) * 1000;
    return Number.isFinite(lifetime) && lifetime > 0 && lifetime <= SPACE_CREDENTIAL_MAX_LIFETIME_MS ? lifetime : null;
  } catch {
    return null;
  }
}

export async function mintSpaceCredentialWith(deps: SpaceCredentialDeps, space: string): Promise<SpaceCredential> {
  const parsed = parseSpaceUri(space);
  if (!parsed) throw new Error("Invalid permissioned space URI.");
  const delegation = await deps.memberClient.query<GetDelegationToken.OutputSchema>(
    "com.atproto.space.getDelegationToken",
    { space },
  );
  const authorityPds = await deps.resolvePds(parsed.authorityDid);
  const key = await deps.generateKey();
  const token = await exchangeSpaceCredential({
    authorityPds,
    delegationToken: delegation.token,
    space,
    key,
    fetchEndpoint: deps.fetchEndpoint,
  });
  const lifetime = credentialLifetimeMs(token) ?? SPACE_CREDENTIAL_LIFETIME_MS;
  return new SpaceCredential({
    space, token, key,
    fetchEndpoint: deps.fetchEndpoint,
    resolveKemKey: deps.resolveKemKey,
    expiresAt: (deps.now ?? Date.now)() + lifetime,
    // A credential shorter than six renewal margins renews proportionally earlier instead of never being reused.
    renewBeforeMs: Math.min(SPACE_CREDENTIAL_RENEW_BEFORE_MS, lifetime / 6),
  });
}

const CREDENTIAL_REFUSALS: ReadonlySet<string> = new Set(
  ["UserNotAuthorized", "NotAuthorized", "AppNotAuthorized", "SpaceNotFound", "SpaceDeleted"],
);

export async function exchangeSpaceCredential(input: {
  authorityPds: string;
  delegationToken: string;
  space: string;
  key: SpaceKey;
  fetchEndpoint: (request: Request) => Promise<Response>;
}): Promise<string> {
  const endpoint = new URL(GET_SPACE_CREDENTIAL, input.authorityPds);
  // The exchange is authenticated by the body alone: the delegation token and the key to bind both travel in it.
  const request = new Request(endpoint, {
    method: "POST",
    redirect: "error",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ space: input.space, credentialKid: input.key.did(), delegationToken: input.delegationToken }),
  });
  const response = await input.fetchEndpoint(request);
  const body = await readUpstreamJson<{ credential?: unknown; message?: unknown; error?: unknown }>(response, 64 * 1024);
  if (!response.ok || typeof body?.credential !== "string" || body.credential.length === 0) {
    const message = typeof body?.message === "string" ? body.message : `Space credential exchange failed (${response.status}).`;
    const code = typeof body?.error === "string" ? body.error : undefined;
    // The PDS reports every credential-exchange denial as HTTP 400 with a protocol-specific error code. Normalize
    // each to the status the app's own API answers with: 410 for a deleted space, and 401 or 403 for every other
    // refusal. SpaceNotFound is a refusal like the rest, because the reference authority answers it for a missing
    // space and for a user the policy does not authorize alike, and the UI treats 401 and 403 as "access needed".
    // The code still tells callers apart (a DM half that is missing, deleted, or refused). A bad delegation token or
    // client attestation is a bug in the request, not a denial, so it stays an `XrpcError` with its own code.
    // UserNotAuthorized and NotAuthorized are denials other authorities may answer; AppNotAuthorized is the reference
    // authority's answer when the space limits which apps may use it.
    if (response.status === 401 || response.status === 403 || (response.status === 400 && code !== undefined && CREDENTIAL_REFUSALS.has(code))) {
      const status = code === "SpaceDeleted" ? 410 : response.status === 401 ? 401 : 403;
      throw new SpaceCredentialError(message, status, code);
    }
    throw new XrpcError(response.status, message, code ?? "CredentialExchangeFailed");
  }
  return body.credential;
}
