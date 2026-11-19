import { P256Keypair, randomStr, verifySignature } from "@atproto/crypto";
import { toBase64 } from "@atproto/lex-data";
import { jsonToLex, lexToJson } from "@atproto/lexicon";
import {
  COMMIT_MAC_PROFILE,
  type CreateMacParams,
  MAC_COVERED_HEADER,
  type MacProfile,
  RECORD_MAC_PROFILE,
  RepoCommit,
  SPACE_CREDENTIAL_TYP,
  type SerializedRecord,
  type SpaceCommit,
  SpaceKemError,
  SpaceMacError,
  createCommitMacHeaders,
  createRecordMacHeaders,
  decapsulate,
  isP256DidKey,
  parseMacRequest,
  parseSpaceToken,
  readRepoStar,
  serializeRecord,
  verifyCredentialSig,
  writeRepoStar,
} from "@atproto/space";
import { generateSpaceKey } from "@flock/protocol/atproto/space-key";
import { MEMBERSPACE_POLICY } from "@flock/protocol/atproto/space-policy";
import { AtprotoClient } from "@flock/protocol/atproto/xrpc";
import { isDid, isSkey, isTid, parseSpaceUri } from "@flock/protocol/keys";

/**
 * An in-memory, multi-host fake of the pinned ATProto Spaces PDS protocol (`#5187`).
 * Test-only: production code never imports this.
 *
 * - Space management (`createSpace`, `updateSpace`, `getSpace`, `deleteSpace`,
 *   `removeWriter`, `putMembers`, `removeMembers`, `listMembers`, `listSpaces`)
 *   requires `ACCESS_FULL` account auth (`clientFor(did)` or full-access Bearer token).
 *   App-password sessions (`scope: "appPass" | "appPassPrivileged"`) are refused with
 *   `InvalidToken: Bad token scope` on all account-authenticated `com.atproto.space.*`
 *   and `com.atproto.memberspace.*` routes, while `com.atproto.server.getServiceAuth`
 *   and `com.atproto.repo.putRecord` remain allowed.
 * - `authorizeSpaceSync` has no OAuth session auth verifier (body `delegationToken`,
 *   `credentialKey`, optional `clientAttestation` and `notify` only), issues a 10-min
 *   `exp`-bound `atproto-space-credential+jwt`, returns `{ credential, spaceRev? }`,
 *   synchronously confirms unseen `(space, endpoint, token)` registrations via
 *   `confirmRegistration`, renews retained registrations (including lapsed ones) silently
 *   without re-confirming, and withdraws a matching registration on authorization refusals.
 * - `listWriters` requires `spaceCredentialAuth` only, returning `#repoWrite` and
 *   `#repoRemoved` entries ordered ascending by `spaceRev`, enforcing host availability.
 * - Repo reads (`getRecord`, `getLatestCommit`, `getRepo`, `listRepoOps`, `listRecords`)
 *   accept either the repo account's `ACCESS_FULL` session or a `space_credential`
 *   bound by RFC 9421 `verifyCredentialSig` and `Atproto-Space-Audience`. Credential
 *   reads on MAC-bearing methods require `Accept-Signature` and return RFC 9421 MAC
 *   headers (`Atproto-Space-Commit` / `Atproto-Space-Record`, `Signature-Input`,
 *   `Signature`) derived via HPKE `"atproto-mac"`, `Vary: Accept-Signature`, and CORS
 *   exposure/allow headers.
 */

const PERSONALSPACE_POLICY = "com.atproto.personalspace.policy";
const MANAGEDSPACE_POLICY = "com.atproto.managedspace.policy";
const STAR_MEDIA_TYPE = "application/vnd.dasl.star";
const SPACE_CREDENTIAL_LIFETIME_SEC = 600;
const DELEGATION_TOKEN_LIFETIME_SEC = 60;
const CLOCK_SKEW_SEC = 5;
const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const CORS_ALLOW_HEADERS =
  "authorization, content-type, accept-signature, atproto-space-audience, signature-input, signature";

const utf8Encoder = new TextEncoder();

export type SessionScope = "full" | "appPass" | "appPassPrivileged";

type RecordEntry = {
  value: Record<string, unknown>;
  cid: Awaited<ReturnType<typeof serializeRecord>>["cid"];
};

type FakeRepoOp = {
  rev: string;
  idx: number;
  collection: string;
  rkey: string;
  cid: string | null;
  prev: string | null;
};

type FakeAccountRepo = {
  rev: string;
  collections: Map<string, Map<string, RecordEntry>>;
  oplog: FakeRepoOp[];
};

type FakeWriterEntry =
  | { removed: false; repoRev: string; spaceRev: string; data: Uint8Array }
  | { removed: true; lastRepoRev: string; spaceRev: string };

type FakeNotifyRegistration = {
  endpoint: string;
  token: string;
  expiresAtMs: number;
  expiryNotified: boolean;
};

type FakeSpace = {
  type: string;
  skey: string;
  ownerDid: string;
  policy: {
    $type: string;
    publicRead: boolean;
    publicWrite: boolean;
    allowedApps?: string[];
    publishPolicy?: boolean;
    publishMembers?: boolean;
    managingApp?: string;
  };
  members: Map<string, { read: boolean; write: boolean }>;
  writers: Map<string, FakeWriterEntry>;
  deleted: boolean;
  notifyRegistrations: Map<string, FakeNotifyRegistration>;
};

export type ApplyWriteOp =
  | { action: "create"; collection: string; rkey?: string; value: Record<string, unknown> }
  | { action: "update"; collection: string; rkey: string; value: Record<string, unknown> }
  | { action: "delete"; collection: string; rkey: string };

type FakeAuth =
  | { kind: "self"; did: string; scope: SessionScope }
  | { kind: "credential-candidate"; token: string; headers: Headers }
  | { kind: "raw-token"; scheme: string }
  | { kind: "none" }
  | { kind: "rejected"; error: FakeXrpcError };

type PendingRepoUpdateRetry = {
  spaceUri: string;
  repo: string;
  repoRev: string;
  data: Uint8Array;
};

const MAC_METHODS: Readonly<Record<string, MacProfile>> = {
  "com.atproto.space.getRecord": RECORD_MAC_PROFILE,
  "com.atproto.space.getLatestCommit": COMMIT_MAC_PROFILE,
  "com.atproto.space.listRepoOps": COMMIT_MAC_PROFILE,
  "com.atproto.space.getRepo": COMMIT_MAC_PROFILE,
};

export class FakeXrpcError extends Error {
  constructor(readonly status: number, readonly code: string, message = code) {
    super(message);
    this.name = "FakeXrpcError";
  }
}

function macHeaders(profile: MacProfile, headers: Record<string, string>): Record<string, string> {
  return {
    ...headers,
    vary: "Accept-Signature",
    "access-control-expose-headers": `${MAC_COVERED_HEADER[profile]}, signature-input, signature`,
  };
}

class WithHeaders {
  constructor(readonly body: unknown, readonly headers: Record<string, string>) {}
}

class BinaryResponse {
  constructor(
    readonly body: ReadableStream<Uint8Array> | Uint8Array,
    readonly headers: Record<string, string>,
    readonly contentType = STAR_MEDIA_TYPE,
  ) {}
}

export class FakeNetwork {
  private virtualNow = Math.floor(Date.now() / 1000) * 1000;

  private readonly accounts = new Map<string, string>();
  /** Accounts whose repo the host refuses to serve (deactivated, taken down, or missing on PDS). */
  private readonly unavailable = new Map<string, "RepoDeactivated" | "RepoTakendown" | "RepoNotFound">();
  private readonly signingKeys = new Map<string, Promise<P256Keypair>>();
  private readonly publishedSigningKeys = new Map<string, string>();
  private readonly kemKeys = new Map<string, Promise<P256Keypair>>();
  /** What a DID-document cache holds for each account: stale after `rotateKemKey` until a forced refresh. */
  private readonly publishedKemKeys = new Map<string, string>();
  private readonly spaces = new Map<string, FakeSpace>();
  /** Per-`(repoDid, spaceUri)` repo storage, matching each account's own PDS actor store. */
  private readonly accountRepos = new Map<string, Map<string, FakeAccountRepo>>();
  /** Public repo records (`com.atproto.repo.*`), keyed by repo DID then `collection/rkey`. */
  private readonly publicRecords = new Map<string, Map<string, { value: unknown; cid: string }>>();
  private readonly delegations = new Map<string, { space: string; granteeDid: string; exp: number; used: boolean }>();
  private readonly credentials = new Map<string, { space: string; grantedDid: string; keyId: string; iat: number; exp: number; jti: string }>();
  private readonly revokedCredentials = new Set<string>();
  private readonly appPasswords = new Map<string, Map<string, { did: string; privileged: boolean }>>();
  private readonly sessions = new Map<string, { did: string; scope: SessionScope }>();
  private readonly clientApps = new Map<string, string>();
  private readonly usedAttestations = new Set<string>();
  private readonly endpoints = new Map<string, (request: Request) => Promise<Response> | Response>();
  private readonly services = new Map<string, string>();
  private readonly pendingRepoUpdateRetries = new Map<string, PendingRepoUpdateRetry>();
  private readonly pendingDeliveries = new Set<Promise<void>>();
  private tokenCounter = 0;
  private revCounter = 0;
  /** Spaces whose writes reach `listWriters` only on `flushListing`, so a reported revision lags the host. */
  private readonly lagging = new Set<string>();
  private readonly pendingListing = new Map<string, Array<{ did: string; repoRev: string }>>();
  /** Writer DIDs whose host is down: every read of their repo by another account fails. */
  private readonly unreachable = new Set<string>();
  private readonly withheldNotices = new Set<string>();
  /** Per-`(space, repo)` serialization queue so concurrent async mutations never interleave or clobber staged snapshots. */
  private readonly repoLocks = new Map<string, Promise<unknown>>();

  /** Requests served, by XRPC method. */
  readonly calls = new Map<string, number>();
  /** Recorded warnings from active `notifySpaceUpdate` deliveries that failed (e.g. HTTP 400). */
  readonly notifyWarnings: Array<{ space: string; endpoint: string; updateType: string; status?: number; error: string }> = [];
  /** Optional fallback/outbound transport for `confirmRegistration`, `notifySpaceUpdate`, and `checkAccess`. */
  outboundFetch: ((request: Request) => Promise<Response>) | undefined;
  /** Runs before each `listRecords` page is served, so a test can write between two pages of one listing. */
  beforeListRecords: ((params: { space: string; repo: string; collection?: string; excludeValues?: boolean; cursor?: string }) => Promise<void> | void) | undefined;
  /** Runs before each `listRepoOps` page is served, so a test can inject concurrent mutations or resets. */
  beforeListRepoOps: ((params: { space: string; repo: string; since?: string; cursor?: string; limit: number; excludeValues: boolean }) => Promise<void> | void) | undefined;
  /** Runs before `getLatestCommit` is served, so a test can race a write between `listRecords` and `getLatestCommit`. */
  beforeGetLatestCommit: ((params: { space: string; repo: string }) => Promise<void> | void) | undefined;
  /** Runs before `getRepo` is served, so a test can inject concurrent mutations or resets before STAR export. */
  beforeGetRepo: ((params: { space: string; repo: string }) => Promise<void> | void) | undefined;
  /** Optional response fault-injection hook for tests (tampered MACs, reordered/broken ops, forged CIDs, oversized streams). */
  interceptResponse: ((ctx: { method: string; params: Record<string, unknown>; response: Response }) => Promise<Response> | Response) | undefined;

  now = (): number => this.virtualNow;

  /** Registers an in-memory HTTP handler for outbound webhook / managing-app requests matching `baseUrl`. */
  registerEndpoint(baseUrl: string, handler: (request: Request) => Promise<Response> | Response): void {
    this.endpoints.set(normalizeBaseUrl(baseUrl), handler);
  }

  unregisterEndpoint(baseUrl: string): void {
    this.endpoints.delete(normalizeBaseUrl(baseUrl));
  }

  /** Registers a `did#serviceId` service endpoint (e.g. a managing app), optionally mounting its handler. */
  registerService(serviceRef: string, endpoint: string, handler?: (request: Request) => Promise<Response> | Response): void {
    this.services.set(serviceRef, normalizeBaseUrl(endpoint));
    if (handler) this.registerEndpoint(endpoint, handler);
  }

  /** Registers an OAuth client's public signing `did:key` for `clientAttestation` verification. */
  registerClientApp(clientId: string, didKey: string): void {
    this.clientApps.set(clientId, didKey);
  }

  /** Waits for any async `notifySpaceUpdate` deliveries kicked off by synchronous test helpers. */
  async flushNotifications(): Promise<void> {
    while (this.pendingDeliveries.size > 0) {
      await Promise.allSettled([...this.pendingDeliveries]);
    }
  }

  /** Retries queued PDS-to-authority `notifyRepoUpdate` notifications (e.g. after a managing app recovers). */
  async retryNotifications(): Promise<void> {
    const entries = [...this.pendingRepoUpdateRetries.entries()];
    for (const [key, retry] of entries) {
      const space = this.spaces.get(retry.spaceUri);
      if (!space || space.deleted) {
        this.pendingRepoUpdateRetries.delete(key);
        continue;
      }
      const delivery = await this.deliverRepoUpdateToSpace(space, retry.repo, retry.repoRev, retry.data);
      if (delivery !== "retryable") this.pendingRepoUpdateRetries.delete(key);
    }
    await this.flushNotifications();
  }

  /** Holds a space's writes back from `listWriters` until `flushListing`, as an authority that has not processed them yet. */
  setListingLag(space: string, lagging: boolean): void {
    if (lagging) this.lagging.add(space);
    else {
      this.lagging.delete(space);
      this.flushListing(space);
    }
  }

  flushListing(space: string): void {
    const target = this.spaces.get(space);
    const pending = this.pendingListing.get(space) ?? [];
    this.pendingListing.delete(space);
    for (const { did, repoRev } of pending) {
      if (!target || target.deleted) continue;
      const repoState = this.accountRepos.get(did)?.get(space);
      if (!repoState) continue;
      const data = this.commitForState(space, did, repoState).data;
      if (target.policy.$type === MANAGEDSPACE_POLICY) {
        this.trackDelivery(this.deliverRepoUpdateToSpace(target, did, repoRev, data).then(() => undefined));
      } else if (this.currentlyAuthorizedSyncWriter(target, did)) {
        const update = this.recordWriterEntry(target, did, repoRev, data);
        if (update) this.trackDelivery(this.deliverSpaceUpdate(target, update));
      }
    }
  }

  /** Takes a writer's host down (or back up): every other account's read of its repo fails with 503. */
  setHostReachable(did: string, reachable: boolean): void {
    if (reachable) this.unreachable.delete(did);
    else this.unreachable.add(did);
  }

  /** Stops (or resumes) the authority's `notifySpaceUpdate` deliveries for a space: a lost notice. */
  withholdNotices(space: string, withheld: boolean): void {
    if (withheld) this.withheldNotices.add(space);
    else this.withheldNotices.delete(space);
  }

  /** Writes a record into `did`'s repo in a space without a client: another app's write, or seeding. */
  async writeAs(did: string, space: string, collection: string, rkey: string, record: Record<string, unknown>): Promise<void> {
    const deliveries: Promise<void>[] = [];
    await this.putRecord({ space, repo: did, collection, rkey, record: { $type: collection, ...record } }, { kind: "self", did, scope: "full" }, deliveries);
    await Promise.allSettled(deliveries);
  }

  async deleteAs(did: string, space: string, collection: string, rkey: string): Promise<void> {
    const deliveries: Promise<void>[] = [];
    await this.deleteRecord({ space, repo: did, collection, rkey }, { kind: "self", did, scope: "full" }, deliveries);
    await Promise.allSettled(deliveries);
  }

  /** Applies an atomic multi-op batch into `did`'s repo sharing a single `rev`. */
  async applyWritesAs(did: string, space: string, writes: readonly ApplyWriteOp[]) {
    const deliveries: Promise<void>[] = [];
    const result = await this.applyWrites({
      space,
      repo: did,
      writes: writes.map((write) => {
        if (write.action === "delete") {
          return { $type: "com.atproto.space.applyWrites#delete", collection: write.collection, rkey: write.rkey };
        }
        if (write.action === "update") {
          return {
            $type: "com.atproto.space.applyWrites#update",
            collection: write.collection,
            rkey: write.rkey,
            value: { $type: write.collection, ...write.value },
          };
        }
        return {
          $type: "com.atproto.space.applyWrites#create",
          collection: write.collection,
          ...(write.rkey !== undefined ? { rkey: write.rkey } : {}),
          value: { $type: write.collection, ...write.value },
        };
      }),
    }, { kind: "self", did, scope: "full" }, deliveries);
    await Promise.allSettled(deliveries);
    return result;
  }

  /** Clears all records and oplog history for `did` in `space`, preserving `space_repo` with a new signed commit. */
  clearRecordsAs(did: string, space: string): void {
    const deliveries: Promise<void>[] = [];
    const result = this.clearRecords({ space, repo: did }, { kind: "self", did, scope: "full" }, deliveries);
    if (result instanceof Promise) {
      this.trackDelivery(result.then(() => Promise.allSettled(deliveries)).then(() => undefined));
    } else {
      for (const delivery of deliveries) this.trackDelivery(delivery);
    }
  }

  /** Imports a STAR archive or record set for `did` in `space`, replacing records and resetting oplog history. */
  async importRepoAs(
    did: string,
    space: string,
    input: Uint8Array | ReadonlyArray<{ collection: string; rkey: string; value: Record<string, unknown> }>,
  ): Promise<void> {
    let starBytes: Uint8Array;
    if (input instanceof Uint8Array) {
      starBytes = input;
    } else {
      const encoder = new TextEncoder();
      const sorted = [...input].sort((a, b) =>
        compareBytes(encoder.encode(`${a.collection}/${a.rkey}`), encoder.encode(`${b.collection}/${b.rkey}`)));
      const serialized: Array<SerializedRecord & { cid: Awaited<ReturnType<typeof serializeRecord>>["cid"] }> = [];
      for (const item of sorted) {
        const lex = jsonToLex({ $type: item.collection, ...item.value } as Parameters<typeof jsonToLex>[0]) as Parameters<typeof serializeRecord>[2];
        serialized.push(await serializeRecord(item.collection as never, item.rkey as never, lex));
      }
      const commit = RepoCommit.fromRecords(serialized).toCommit({
        space: space as never,
        repo: did as never,
        rev: this.nextRev(),
      });
      const chunks: Uint8Array[] = [];
      for await (const chunk of writeRepoStar(commit, serialized)) chunks.push(chunk);
      starBytes = concatBytes(chunks);
    }
    await this.importRepo({}, { kind: "self", did, scope: "full" }, undefined, starBytes);
  }

  /** Simulates PDS oplog pruning/compaction for `(space, repo)`: drops all ops, or ops strictly before `keepFromRev`. */
  pruneOplog(space: string, repo: string, keepFromRev?: string): void {
    const accountRepo = this.accountRepos.get(repo)?.get(space);
    if (!accountRepo) return;
    if (keepFromRev === undefined) {
      accountRepo.oplog = [];
      return;
    }
    accountRepo.oplog = accountRepo.oplog.filter((op) => op.rev >= keepFromRev);
  }

  /** Advances the fake network's clock, used by tests exercising credential expiry and registration lapse. */
  advanceClock(ms: number): void {
    this.virtualNow += ms;
  }

  createAccount(did: string, host = "pds1"): void {
    this.accounts.set(did, host);
  }

  /** Deactivates, takes down, or marks missing an account on its PDS. */
  setAccountState(did: string, state: "active" | "deactivated" | "takendown" | "missing"): void {
    if (state === "active") this.unavailable.delete(did);
    else if (state === "missing") this.unavailable.set(did, "RepoNotFound");
    else this.unavailable.set(did, state === "deactivated" ? "RepoDeactivated" : "RepoTakendown");
  }

  hasAccount(did: string): boolean {
    return this.accounts.has(did);
  }

  /** Revokes a credential by `jti` for `space` (matches `notifyCredentialsRevoked`). */
  revokeCredential(space: string, jti: string): void {
    this.revokedCredentials.add(`${space}\u0000${jti}`);
  }

  resolvePds = async (did: string): Promise<string> => {
    const host = this.accounts.get(did);
    if (!host) throw new Error(`fake-pds: no account registered for ${did}`);
    return `https://fake-pds.test/${host}`;
  };

  /** Resolves an account's `#atproto` signing key, caching until `forceRefresh`. */
  resolveSigningKey = async (did: string, forceRefresh = false): Promise<string> => {
    if (!this.accounts.has(did)) throw new Error(`fake-pds: no account registered for ${did}`);
    const published = this.publishedSigningKeys.get(did);
    if (published && !forceRefresh) return published;
    const current = (await this.signingKeypair(did)).did();
    this.publishedSigningKeys.set(did, current);
    return current;
  };

  /**
   * Stands in for a DID-document lookup of `#atproto_kem`. A cached key stays until `forceRefresh`, so a test can
   * observe a syncer holding a rotated-away key.
   */
  resolveKemKey = async (did: string, forceRefresh = false): Promise<string> => {
    if (!this.accounts.has(did)) throw new Error(`fake-pds: no account registered for ${did}`);
    const published = this.publishedKemKeys.get(did);
    if (published && !forceRefresh) return published;
    const current = (await this.kemKeypair(did)).did();
    this.publishedKemKeys.set(did, current);
    return current;
  };

  /** Replaces the account's `#atproto_kem` key. Resolvers that cached the old one fail verification until they refresh. */
  async rotateKemKey(did: string): Promise<void> {
    await this.resolveKemKey(did);
    this.kemKeys.set(did, P256Keypair.create());
  }

  private signingKeypair(did: string): Promise<P256Keypair> {
    let key = this.signingKeys.get(did);
    if (!key) {
      key = P256Keypair.create();
      this.signingKeys.set(did, key);
    }
    return key;
  }

  private kemKeypair(did: string): Promise<P256Keypair> {
    let key = this.kemKeys.get(did);
    if (!key) {
      key = P256Keypair.create();
      this.kemKeys.set(did, key);
    }
    return key;
  }

  /** Stands in for an authenticated account session client (`full` OAuth by default, or `appPass` / `appPassPrivileged`). */
  clientFor(did: string, options: { scope?: SessionScope; appPassword?: boolean } = {}): AtprotoClient {
    if (!this.accounts.has(did)) throw new Error(`fake-pds: no account registered for ${did}`);
    const scope: SessionScope = options.scope ?? (options.appPassword ? "appPass" : "full");
    return new AtprotoClient((path, init) => this.respond(path, init, { kind: "self", did, scope }));
  }

  /** Issues a Bearer session token usable over `fetchEndpoint` with the given scope. */
  issueSessionToken(did: string, scope: SessionScope = "full"): string {
    if (!this.accounts.has(did)) throw new Error(`fake-pds: no account registered for ${did}`);
    const token = `fake-session-${this.tokenCounter++}`;
    this.sessions.set(token, { did, scope });
    return token;
  }

  /** Stands in for `deps.fetchEndpoint`: routes a cross-host `Request` by its URL. */
  fetchEndpoint = async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") {
      const requestedHeaders = request.headers.get("access-control-request-headers");
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": requestedHeaders ? `${requestedHeaders}, accept-signature` : CORS_ALLOW_HEADERS,
          "access-control-max-age": "86400",
        },
      });
    }
    const url = new URL(request.url);
    const path = `${url.pathname}${url.search}`;
    const contentType = request.headers.get("content-type") ?? "";
    const body = request.method === "GET" || request.method === "HEAD"
      ? undefined
      : contentType.includes(STAR_MEDIA_TYPE) || contentType.includes("application/octet-stream")
        ? new Uint8Array(await request.arrayBuffer())
        : await request.text();
    return this.respond(path, { method: request.method, body }, this.authFromRequest(request.headers), request.headers);
  };

  generateKey = generateSpaceKey;

  /**
   * Parses an HTTP `Authorization` header as the pinned PDS does (`auth-verifier.ts`):
   * `Atproto-Space-Credential` (case-insensitive) carries a space credential verified with
   * `verifyCredentialSig` on endpoints that accept space credentials; `Bearer` carries a
   * session token; `Atproto-Space` and malformed headers are rejected with `InvalidToken`.
   */
  private authFromRequest(headers: Headers): FakeAuth {
    const authorization = headers.get("authorization");
    if (!authorization) return { kind: "none" };
    const parts = authorization.split(" ");
    if (parts.length !== 2) return rejected(400, "InvalidToken", "Malformed authorization header");
    const [rawScheme, token] = parts;
    const scheme = rawScheme!.toLowerCase();
    if (scheme === "atproto-space-credential") {
      if (!token) return { kind: "none" };
      return { kind: "credential-candidate", token, headers };
    }
    if (scheme === "bearer") {
      const session = token ? this.sessions.get(token) : undefined;
      if (session) return { kind: "self", did: session.did, scope: session.scope };
      return { kind: "raw-token", scheme };
    }
    if (scheme === "dpop" || scheme === "basic") {
      return { kind: "raw-token", scheme };
    }
    return rejected(400, "InvalidToken", `Unsupported authorization type: ${rawScheme}`);
  }

  private async respond(
    path: string,
    init: { method?: string; body?: unknown },
    auth: FakeAuth,
    requestHeaders?: Headers,
  ): Promise<Response> {
    const url = new URL(path, "https://fake-pds.test");
    const xrpcMatch = /^\/(?:[^/]+\/)?xrpc\/(.+)$/.exec(url.pathname);
    const method = xrpcMatch ? xrpcMatch[1]! : url.pathname.replace(/^\/+/, "");
    const params: Record<string, unknown> = {};
    for (const [key, value] of url.searchParams.entries()) params[key] = value;
    if (typeof init.body === "string" && init.body.length > 0) Object.assign(params, JSON.parse(init.body));
    const rawBody = init.body instanceof Uint8Array ? init.body : undefined;
    this.calls.set(method, (this.calls.get(method) ?? 0) + 1);

    const callDeliveries: Promise<void>[] = [];
    let response: Response;
    if (
      typeof params.repo === "string" &&
      this.unreachable.has(params.repo) &&
      !(auth.kind === "self" && auth.did === params.repo)
    ) {
      response = errorResponse(new FakeXrpcError(503, "ServiceUnavailable", "The repo host is down."));
    } else {
      try {
        const handled = await this.handle(method, params, auth, requestHeaders, rawBody, callDeliveries);
        if (handled instanceof BinaryResponse) {
          const responseBody: BodyInit = handled.body instanceof Uint8Array ? new Uint8Array(handled.body) : handled.body;
          response = new Response(responseBody, {
            status: 200,
            headers: {
              "content-type": handled.contentType,
              "access-control-allow-origin": "*",
              "access-control-allow-headers": CORS_ALLOW_HEADERS,
              ...handled.headers,
            },
          });
        } else {
          const [body, headers] = handled instanceof WithHeaders ? [handled.body, handled.headers] : [handled, {}];
          response = new Response(JSON.stringify(body), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "access-control-allow-origin": "*",
              "access-control-allow-headers": CORS_ALLOW_HEADERS,
              ...headers,
            },
          });
        }
      } catch (error) {
        if (error instanceof FakeXrpcError) response = errorResponse(error);
        else throw error;
      }
    }
    if (callDeliveries.length > 0) {
      await Promise.allSettled(callDeliveries);
    }
    return this.interceptResponse ? this.interceptResponse({ method, params, response }) : response;
  }

  private async handle(
    method: string,
    params: Record<string, unknown>,
    auth: FakeAuth,
    requestHeaders: Headers | undefined,
    rawBody: Uint8Array | undefined,
    deliveries: Promise<void>[],
  ): Promise<unknown> {
    switch (method) {
      case "com.atproto.repo.putRecord": return this.putPublicRecord(params, auth);
      case "com.atproto.repo.getRecord": return this.getPublicRecord(params);
      case "com.atproto.server.getServiceAuth": return this.getServiceAuth(params, auth);
      case "com.atproto.server.createAppPassword": return this.createAppPassword(params, auth);
      case "com.atproto.server.createSession": return this.createSession(params);
      case "com.atproto.space.getDelegationToken": return this.getDelegationToken(params, auth);
      case "com.atproto.space.authorizeSpaceSync": return this.authorizeSpaceSync(params);
      case "com.atproto.space.createSpace": return this.createSpace(params, auth);
      case "com.atproto.space.updateSpace": return this.updateSpace(params, auth);
      case "com.atproto.space.getSpace": return this.getSpace(params, auth);
      case "com.atproto.space.deleteSpace": return this.deleteSpace(params, auth, deliveries);
      case "com.atproto.space.removeWriter": return this.removeWriter(params, auth, deliveries);
      case "com.atproto.space.listWriters": return this.listWriters(params, auth);
      case "com.atproto.space.listSpaces": return this.listSpaces(params, auth);
      case "com.atproto.memberspace.putMembers": return this.putMembers(params, auth, deliveries);
      case "com.atproto.memberspace.removeMembers": return this.removeMembers(params, auth, deliveries);
      case "com.atproto.memberspace.listMembers": return this.listMembers(params, auth);
      case "com.atproto.space.putRecord": return this.putRecord(params, auth, deliveries);
      case "com.atproto.space.createRecord": return this.createRecord(params, auth, deliveries);
      case "com.atproto.space.applyWrites": return this.applyWrites(params, auth, deliveries);
      case "com.atproto.space.clearRecords": return this.clearRecords(params, auth, deliveries);
      case "com.atproto.space.importRepo": return this.importRepo(params, auth, requestHeaders, rawBody);
      case "com.atproto.space.deleteRecord": return this.deleteRecord(params, auth, deliveries);
      case "com.atproto.space.getRecord": return this.getRecord(params, auth, requestHeaders);
      case "com.atproto.space.getLatestCommit": return this.getLatestCommit(params, auth, requestHeaders);
      case "com.atproto.space.getRepo": return this.getRepo(params, auth, requestHeaders);
      case "com.atproto.space.getBlob": return this.getBlob(params, auth);
      case "com.atproto.space.listBlobs": return this.listBlobs(params, auth);
      case "com.atproto.space.exportSpaceMeta": return this.exportSpaceMeta(params, auth);
      case "com.atproto.space.importSpaceMeta": return this.importSpaceMeta(auth);
      case "com.atproto.space.listRecords": return this.listRecords(params, auth);
      case "com.atproto.space.listRepoOps": return this.listRepoOps(params, auth, requestHeaders);
      default: throw new FakeXrpcError(501, "MethodNotImplemented", `fake-pds does not implement ${method}`);
    }
  }

  private requireSelf(
    auth: FakeAuth,
    opts: { scopes?: "full" | "standard"; checkTakedown?: boolean; checkDeactivated?: boolean } = {},
  ): string {
    if (auth.kind === "rejected") throw auth.error;
    if (auth.kind === "credential-candidate") {
      throw new FakeXrpcError(400, "InvalidToken", "Unexpected authorization type");
    }
    if (auth.kind === "none") throw new FakeXrpcError(401, "AuthMissing", "Authentication Required");
    if (auth.kind === "raw-token") throw new FakeXrpcError(401, "InvalidToken", "Token could not be verified");
    if ((opts.scopes ?? "full") === "full" && auth.scope !== "full") {
      throw new FakeXrpcError(400, "InvalidToken", "Bad token scope");
    }
    if (opts.checkTakedown || opts.checkDeactivated) {
      const state = this.unavailable.get(auth.did);
      if (state === "RepoNotFound") throw new FakeXrpcError(403, "AccountNotFound", "Account not found");
      if (opts.checkTakedown && state === "RepoTakendown") {
        throw new FakeXrpcError(401, "AccountTakedown", "Account has been taken down");
      }
      if (opts.checkDeactivated && state === "RepoDeactivated") {
        throw new FakeXrpcError(401, "AccountDeactivated", "Account is deactivated");
      }
    }
    return auth.did;
  }

  private assertActiveSpaceHost(authorityDid: string): void {
    if (!this.accounts.has(authorityDid) || this.unavailable.get(authorityDid) === "RepoNotFound") {
      throw new FakeXrpcError(400, "SpaceNotFound", "Space not found");
    }
    const state = this.unavailable.get(authorityDid);
    if (state === "RepoTakendown") {
      throw new FakeXrpcError(400, "RepoTakendown", `Repo has been takendown: ${authorityDid}`);
    }
    if (state === "RepoDeactivated") {
      throw new FakeXrpcError(400, "RepoDeactivated", `Repo has been deactivated: ${authorityDid}`);
    }
  }

  private requireSpaceRef(uri: unknown) {
    if (typeof uri !== "string") throw new FakeXrpcError(400, "InvalidSpaceUri", "Invalid space URI");
    const parsed = parseSpaceUri(uri);
    if (!parsed) throw new FakeXrpcError(400, "InvalidSpaceUri", `Not a space uri: ${uri}`);
    return parsed;
  }

  private requireSpaceAuthority(uri: unknown, did: string): void {
    const ref = this.requireSpaceRef(uri);
    if (ref.authorityDid !== did) throw new FakeXrpcError(400, "NotAuthorized", "Not the space authority");
  }

  private requireActiveSpace(uri: unknown): FakeSpace {
    if (typeof uri !== "string") throw new FakeXrpcError(400, "SpaceNotFound", "Space not found");
    const space = this.spaces.get(uri);
    if (!space || space.deleted) throw new FakeXrpcError(400, "SpaceNotFound", "Space not found");
    return space;
  }

  private requireMemberspace(space: FakeSpace): void {
    if (space.policy.$type !== MEMBERSPACE_POLICY) {
      throw new FakeXrpcError(400, "PolicyMismatch", "Space is not governed by the memberspace policy");
    }
  }

  private async requireCredential(
    params: Record<string, unknown>,
    auth: FakeAuth,
    expectedAudience?: string,
  ): Promise<{ grantedDid: string; space: string }> {
    if (auth.kind === "rejected") throw auth.error;
    if (auth.kind !== "credential-candidate") {
      throw new FakeXrpcError(401, "MissingJwt", "missing space credential");
    }
    const credential = this.credentials.get(auth.token);
    if (!credential) {
      throw new FakeXrpcError(401, "BadJwt", "invalid space credential");
    }
    const nowSec = Math.floor(this.now() / 1000);
    if (nowSec >= credential.exp) {
      throw new FakeXrpcError(401, "JwtExpired", "token expired");
    }
    const audience = auth.headers.get("atproto-space-audience");
    if (!isDid(audience)) {
      throw new FakeXrpcError(401, "BadSpaceSignature", "missing or invalid space audience DID");
    }
    try {
      await verifyCredentialSig(Object.fromEntries(auth.headers.entries()), credential.keyId as `did:key:${string}`);
    } catch (error) {
      throw new FakeXrpcError(401, "BadSpaceSignature", error instanceof Error ? error.message : "invalid HTTP message signature");
    }
    if (this.revokedCredentials.has(`${credential.space}\u0000${credential.jti}`)) {
      throw new FakeXrpcError(401, "CredentialRevoked", "space credential has been revoked");
    }
    if (credential.space !== params.space) {
      throw new FakeXrpcError(400, "InvalidCredential", "Credential is not scoped to this space");
    }
    const expected = expectedAudience ?? this.requireSpaceRef(params.space).authorityDid;
    if (audience !== expected) {
      throw new FakeXrpcError(401, "BadSpaceAudience", "space audience does not match the request");
    }
    return { grantedDid: credential.grantedDid, space: credential.space };
  }

  private async authorizeSpaceRead(params: Record<string, unknown>, auth: FakeAuth): Promise<{ own: boolean }> {
    const repo = String(params.repo);
    this.requireSpaceRef(params.space);
    if (auth.kind === "credential-candidate") {
      await this.requireCredential(params, auth, repo);
      return { own: false };
    }
    const callerDid = this.requireSelf(auth, { scopes: "full" });
    if (callerDid !== repo) {
      throw new FakeXrpcError(400, "RepoNotFound", `Could not find repo for DID: ${repo}`);
    }
    return { own: true };
  }

  private createAppPassword(params: Record<string, unknown>, auth: FakeAuth): { name: string; password: string; privileged: boolean } {
    const did = this.requireSelf(auth, { scopes: "full" });
    const name = String(params.name ?? "app");
    const privileged = params.privileged === true;
    const password = `app-pass-${randomStr(12, "hex")}`;
    let map = this.appPasswords.get(did);
    if (!map) this.appPasswords.set(did, map = new Map());
    map.set(password, { did, privileged });
    return { name, password, privileged };
  }

  private createSession(params: Record<string, unknown>): { accessJwt: string; did: string; handle: string } {
    const identifier = String(params.identifier ?? "");
    const password = String(params.password ?? "");
    const entry = this.appPasswords.get(identifier)?.get(password);
    if (!entry) throw new FakeXrpcError(401, "AuthenticationRequired", "Invalid identifier or password");
    const scope: SessionScope = entry.privileged ? "appPassPrivileged" : "appPass";
    return { accessJwt: this.issueSessionToken(entry.did, scope), did: entry.did, handle: entry.did };
  }

  private getDelegationToken(params: Record<string, unknown>, auth: FakeAuth): { token: string } {
    const granteeDid = this.requireSelf(auth, { scopes: "full", checkTakedown: true, checkDeactivated: true });
    const space = String(params.space);
    this.requireSpaceRef(space);
    const token = `delegation-${this.tokenCounter++}`;
    const exp = Math.floor(this.now() / 1000) + DELEGATION_TOKEN_LIFETIME_SEC;
    this.delegations.set(token, { space, granteeDid, exp, used: false });
    return { token };
  }

  /**
   * Authorizes syncing a space, exchanging an optional single-use `delegationToken` and
   * optional `clientAttestation` for a 10-min `exp`-bound `SpaceCredential` JWT, and
   * optionally registering/renewing `notify: { endpoint, token }`.
   */
  private async authorizeSpaceSync(params: Record<string, unknown>): Promise<{ credential: string; spaceRev?: string }> {
    const ref = this.requireSpaceRef(params.space);
    const spaceUriStr = String(params.space);
    const credentialKey = params.credentialKey;
    if (typeof credentialKey !== "string" || !isP256DidKey(credentialKey)) {
      throw new FakeXrpcError(400, "InvalidRequest", "credentialKey must be a P-256 did:key");
    }

    const notify = parseNotifyParam(params.notify);
    this.assertActiveSpaceHost(ref.authorityDid);

    const existingSpace = this.spaces.get(spaceUriStr);
    if (existingSpace?.deleted) {
      throw new FakeXrpcError(400, "SpaceDeleted", "Space has been deleted");
    }

    let userDid: string | undefined;
    if (params.delegationToken !== undefined) {
      if (typeof params.delegationToken !== "string") {
        throw new FakeXrpcError(400, "InvalidDelegationToken", "Invalid delegation token");
      }
      const delegation = this.delegations.get(params.delegationToken);
      const nowSec = Math.floor(this.now() / 1000);
      if (!delegation || delegation.used || delegation.space !== spaceUriStr || nowSec - CLOCK_SKEW_SEC >= delegation.exp) {
        throw new FakeXrpcError(400, "InvalidDelegationToken", "Delegation token is invalid, expired, replayed, or does not match requested space");
      }
      delegation.used = true;
      userDid = delegation.granteeDid;
    }

    let clientId: string | undefined;
    if (params.clientAttestation !== undefined) {
      clientId = await this.verifyClientAttestation(params.clientAttestation, ref.authorityDid);
    }

    const space = this.requireActiveSpace(spaceUriStr);
    try {
      await this.authorizeCredential(space, userDid, clientId);
    } catch (error) {
      if (notify && error instanceof FakeXrpcError && error.status === 400) {
        space.notifyRegistrations.delete(notifyKey(notify.endpoint, notify.token));
      }
      throw error;
    }

    if (notify) {
      const regKey = notifyKey(notify.endpoint, notify.token);
      const existingReg = space.notifyRegistrations.get(regKey);
      if (!existingReg) {
        await this.confirmRegistration(spaceUriStr, notify);
        if (space.deleted) {
          throw new FakeXrpcError(400, "SpaceDeleted", "Space has been deleted");
        }
      }
    }

    const iat = Math.floor(this.now() / 1000);
    const exp = iat + SPACE_CREDENTIAL_LIFETIME_SEC;
    const jti = randomStr(16, "hex");
    const signingKey = await this.signingKeypair(ref.authorityDid);
    const header = { alg: signingKey.jwtAlg, typ: SPACE_CREDENTIAL_TYP, kid: "#atproto" };
    const payload = {
      iss: ref.authorityDid,
      sub: spaceUriStr,
      cnf: { kid: credentialKey },
      iat,
      exp,
      jti,
    };
    const signingInput = `${jsonToB64Url(header)}.${jsonToB64Url(payload)}`;
    const sig = await signingKey.sign(utf8Encoder.encode(signingInput));
    const token = `${signingInput}.${toBase64(sig, "base64url")}`;

    this.credentials.set(token, {
      space: spaceUriStr,
      grantedDid: userDid ?? "",
      keyId: credentialKey,
      iat,
      exp,
      jti,
    });

    if (notify) {
      space.notifyRegistrations.set(notifyKey(notify.endpoint, notify.token), {
        endpoint: notify.endpoint,
        token: notify.token,
        expiresAtMs: exp * 1000,
        expiryNotified: false,
      });
    }

    const spaceRev = this.currentSpaceRev(space);
    return {
      credential: token,
      ...(spaceRev !== undefined ? { spaceRev } : {}),
    };
  }

  private async verifyClientAttestation(attestation: unknown, authorityDid: string): Promise<string> {
    if (typeof attestation !== "string" || attestation.length === 0) {
      throw new FakeXrpcError(400, "InvalidClientAttestation", "Invalid client attestation");
    }
    let parsed: ReturnType<typeof parseSpaceToken<"clientAttestation">>;
    try {
      parsed = parseSpaceToken("clientAttestation", attestation);
    } catch (error) {
      throw new FakeXrpcError(400, "InvalidClientAttestation", error instanceof Error ? error.message : "Invalid client attestation");
    }
    const { header, payload, signingInput, sig } = parsed;
    const nowSec = Math.floor(this.now() / 1000);
    if (nowSec - CLOCK_SKEW_SEC >= payload.exp) {
      throw new FakeXrpcError(400, "InvalidClientAttestation", `Invalid client attestation for "${payload.iss}"`);
    }
    if (payload.aud !== `${authorityDid}#atproto_pds`) {
      throw new FakeXrpcError(400, "InvalidClientAttestation", `Invalid client attestation for "${payload.iss}"`);
    }
    const replayKey = `${payload.iss}\u0000${payload.jti}`;
    if (this.usedAttestations.has(replayKey)) {
      throw new FakeXrpcError(400, "InvalidClientAttestation", `Invalid client attestation for "${payload.iss}"`);
    }
    const clientKey = this.clientApps.get(payload.iss);
    if (!clientKey) {
      throw new FakeXrpcError(400, "InvalidClientAttestation", `Invalid client attestation for "${payload.iss}"`);
    }
    const valid = await verifySignature(clientKey, signingInput, sig, { jwtAlg: header.alg }).catch(() => false);
    if (!valid) {
      throw new FakeXrpcError(400, "InvalidClientAttestation", `Invalid client attestation for "${payload.iss}"`);
    }
    this.usedAttestations.add(replayKey);
    return payload.iss;
  }

  private async confirmRegistration(space: string, notify: { endpoint: string; token: string }): Promise<void> {
    const challenge = randomStr(16, "base32");
    try {
      const response = await this.sendOutbound(
        `${normalizeBaseUrl(notify.endpoint)}/xrpc/com.atproto.space.confirmRegistration`,
        {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ space, token: notify.token, challenge }),
        },
      );
      if (response.ok) {
        const body = await response.json() as { challenge?: unknown };
        if (body && typeof body === "object" && body.challenge === challenge) return;
      }
    } catch {
      // Treated identically to challenge mismatch below.
    }
    throw new FakeXrpcError(400, "RegistrationNotConfirmed", "Notify endpoint did not confirm the registration");
  }

  private async authorizeCredential(space: FakeSpace, repo: string | undefined, clientId: string | undefined): Promise<void> {
    const repoAuthorized = await this.authorizeRepoAccess(space, repo, "read", clientId);
    if (!repoAuthorized) {
      throw new FakeXrpcError(400, "SpaceNotFound", "Space not found");
    }
    if (space.policy.$type === MEMBERSPACE_POLICY && space.policy.allowedApps !== undefined) {
      if (clientId === undefined || !space.policy.allowedApps.includes(clientId)) {
        throw new FakeXrpcError(400, "AppNotAuthorized", "Application not authorized for this space");
      }
    }
  }

  private async authorizeRepoAccess(
    space: FakeSpace,
    repo: string | undefined,
    access: "read" | "write",
    clientId?: string,
  ): Promise<boolean> {
    if (repo === space.ownerDid) return true;
    if (space.policy.$type === PERSONALSPACE_POLICY) return false;
    if (space.policy.$type === MEMBERSPACE_POLICY) {
      if (access === "read" && space.policy.publicRead) return true;
      if (!repo) return false;
      const member = space.members.get(repo);
      if (access === "read") return member?.read === true;
      // An explicit member with write:false stays excluded even when publicWrite is true.
      if (member) return member.write;
      return space.policy.publicWrite === true;
    }
    if (space.policy.$type === MANAGEDSPACE_POLICY) {
      const result = await this.checkManagedAccess(space, repo, clientId);
      return result[access];
    }
    return false;
  }

  private async checkManagedAccess(
    space: FakeSpace,
    repo: string | undefined,
    clientId?: string,
  ): Promise<{ read: boolean; write: boolean }> {
    const managingApp = space.policy.managingApp;
    const base = managingApp ? this.services.get(managingApp) : undefined;
    if (!managingApp || !base) {
      throw new FakeXrpcError(502, "UpstreamFailure", "Managing app did not answer");
    }
    const url = new URL(`${base}/xrpc/com.atproto.managedspace.checkAccess`);
    url.searchParams.set("space", spaceUri(space));
    if (repo !== undefined) url.searchParams.set("repo", repo);
    if (clientId !== undefined) url.searchParams.set("clientId", clientId);

    const exp = Math.floor(this.now() / 1000) + 60;
    const serviceJwt = `fake-service-token.${btoa(JSON.stringify({
      iss: space.ownerDid,
      aud: managingApp,
      lxm: "com.atproto.managedspace.checkAccess",
      exp,
    }))}`;
    try {
      const response = await this.sendOutbound(url.toString(), {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${serviceJwt}`,
        },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as { read?: unknown; write?: unknown };
      if (!body || typeof body.read !== "boolean" || typeof body.write !== "boolean") {
        throw new Error("Invalid checkAccess response");
      }
      return { read: body.read, write: body.write };
    } catch {
      throw new FakeXrpcError(502, "UpstreamFailure", "Managing app did not answer");
    }
  }

  private createSpace(params: Record<string, unknown>, auth: FakeAuth): { space: string } {
    const ownerDid = this.requireSelf(auth, { scopes: "full", checkTakedown: true, checkDeactivated: true });
    const type = String(params.spaceType);
    const skey = typeof params.skey === "string" ? params.skey : fakeTid(++this.revCounter);
    if (!isSkey(skey)) throw new FakeXrpcError(400, "InvalidRequest", "Invalid space key");
    const uri = `at://${ownerDid}/space/${type}/${skey}`;
    const existing = this.spaces.get(uri);
    if (existing && !existing.deleted) throw new FakeXrpcError(400, "SpaceAlreadyExists", "Space already exists");
    this.spaces.set(uri, {
      type,
      skey,
      ownerDid,
      policy: toStoredPolicy(params.policy),
      members: new Map(),
      writers: new Map(),
      deleted: false,
      notifyRegistrations: new Map(),
    });
    return { space: uri };
  }

  /** Replaces the whole policy. A different `$type` migrates the space and discards the member list; the writer set is not re-evaluated. */
  private updateSpace(params: Record<string, unknown>, auth: FakeAuth): Record<string, never> {
    const did = this.requireSelf(auth, { scopes: "full", checkTakedown: true, checkDeactivated: true });
    this.requireSpaceAuthority(params.space, did);
    const space = this.requireActiveSpace(params.space);
    const next = toStoredPolicy(params.policy);
    if (next.$type !== space.policy.$type) space.members.clear();
    space.policy = next;
    return {};
  }

  private getSpace(params: Record<string, unknown>, auth: FakeAuth) {
    const did = this.requireSelf(auth, { scopes: "full" });
    this.requireSpaceAuthority(params.space, did);
    const space = this.requireActiveSpace(params.space);
    return { space: spaceUri(space), policy: toPublicPolicy(space.policy) };
  }

  private putMembers(params: Record<string, unknown>, auth: FakeAuth, deliveries: Promise<void>[]): Record<string, never> {
    const did = this.requireSelf(auth, { scopes: "full", checkTakedown: true, checkDeactivated: true });
    this.requireSpaceAuthority(params.space, did);
    const space = this.requireActiveSpace(params.space);
    this.requireMemberspace(space);
    if (!Array.isArray(params.members) || params.members.length > 100) {
      throw new FakeXrpcError(400, "InvalidRequest", "members must be an array of at most 100 entries");
    }
    const accessByDid = new Map<string, { read: boolean; write: boolean }>();
    for (const raw of params.members) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new FakeXrpcError(400, "InvalidRequest", "Invalid member entry");
      }
      const member = raw as { did?: unknown; read?: unknown; write?: unknown };
      if (!isDid(member.did) || typeof member.read !== "boolean" || typeof member.write !== "boolean") {
        throw new FakeXrpcError(400, "InvalidRequest", "Member requires did, read, and write");
      }
      accessByDid.set(member.did, { read: member.read, write: member.write });
    }
    for (const [memberDid, access] of accessByDid) {
      space.members.set(memberDid, access);
      if (!access.write) {
        const removed = this.removeWriterEntry(space, memberDid);
        if (removed) deliveries.push(this.deliverSpaceUpdate(space, removed));
      }
    }
    return {};
  }

  private removeMembers(params: Record<string, unknown>, auth: FakeAuth, deliveries: Promise<void>[]): Record<string, never> {
    const did = this.requireSelf(auth, { scopes: "full", checkTakedown: true, checkDeactivated: true });
    this.requireSpaceAuthority(params.space, did);
    const space = this.requireActiveSpace(params.space);
    this.requireMemberspace(space);
    if (!Array.isArray(params.dids) || params.dids.length > 100) {
      throw new FakeXrpcError(400, "InvalidRequest", "dids must be an array of at most 100 DIDs");
    }
    for (const rawDid of params.dids) {
      if (!isDid(rawDid)) throw new FakeXrpcError(400, "InvalidRequest", "Invalid member DID");
      const wasMember = space.members.delete(rawDid);
      if (!wasMember) continue;
      const removed = this.removeWriterEntry(space, rawDid);
      if (removed) deliveries.push(this.deliverSpaceUpdate(space, removed));
    }
    return {};
  }

  private removeWriter(params: Record<string, unknown>, auth: FakeAuth, deliveries: Promise<void>[]): Record<string, never> {
    const did = this.requireSelf(auth, { scopes: "full", checkTakedown: true, checkDeactivated: true });
    this.requireSpaceAuthority(params.space, did);
    const space = this.requireActiveSpace(params.space);
    if (!isDid(params.repo)) throw new FakeXrpcError(400, "InvalidRequest", "repo must be a DID");
    const removed = this.removeWriterEntry(space, params.repo);
    if (removed) deliveries.push(this.deliverSpaceUpdate(space, removed));
    return {};
  }

  private deleteSpace(params: Record<string, unknown>, auth: FakeAuth, deliveries: Promise<void>[]): Record<string, never> {
    const did = this.requireSelf(auth, { scopes: "full", checkTakedown: true, checkDeactivated: true });
    this.requireSpaceAuthority(params.space, did);
    const uri = String(params.space ?? "");
    const space = this.spaces.get(uri);
    if (!space) throw new FakeXrpcError(400, "SpaceNotFound", "Space not found");
    if (space.deleted) return {};

    const registrations = [...space.notifyRegistrations.values()];
    space.deleted = true;
    space.members.clear();
    space.writers.clear();
    space.notifyRegistrations.clear();
    this.accountRepos.get(space.ownerDid)?.delete(uri);

    if (!this.withheldNotices.has(uri) && registrations.length > 0) {
      deliveries.push(
        this.deliverDeletionNotice(uri, registrations),
      );
    }
    return {};
  }

  private listMembers(params: Record<string, unknown>, auth: FakeAuth) {
    const did = this.requireSelf(auth, { scopes: "full" });
    this.requireSpaceAuthority(params.space, did);
    const space = this.requireActiveSpace(params.space);
    this.requireMemberspace(space);
    const cursor = typeof params.cursor === "string" ? params.cursor : undefined;
    if (cursor !== undefined && !isDid(cursor)) {
      throw new FakeXrpcError(400, "InvalidCursor", "Malformed cursor");
    }
    const limit = clampLimit(params.limit, 100, 1000);
    const sorted = [...space.members.entries()]
      .map(([memberDid, access]) => ({ did: memberDid, ...access }))
      .sort((left, right) => compareLex(left.did, right.did));
    const filtered = cursor !== undefined ? sorted.filter((member) => member.did > cursor) : sorted;
    const page = filtered.slice(0, limit);
    return {
      members: page,
      ...(page.length === limit && filtered.length > limit ? { cursor: page[page.length - 1]!.did } : {}),
    };
  }

  /** Spaces the caller is the authority of or holds a repo in, as the reference PDS lists them. */
  private listSpaces(params: Record<string, unknown>, auth: FakeAuth) {
    const did = this.requireSelf(auth, { scopes: "full" });
    const cursor = typeof params.cursor === "string" ? params.cursor : undefined;
    if (cursor !== undefined && !parseSpaceUri(cursor)) {
      throw new FakeXrpcError(400, "InvalidCursor", "Malformed cursor");
    }
    const spaceDidFilter = typeof params.spaceDid === "string" ? params.spaceDid : undefined;
    const spaceTypeFilter = typeof params.spaceType === "string" ? params.spaceType : undefined;
    const limit = clampLimit(params.limit, 50, 100);

    const uris = new Set<string>();
    for (const [uri, space] of this.spaces) {
      if (!space.deleted && space.ownerDid === did) uris.add(uri);
    }
    for (const uri of this.accountRepos.get(did)?.keys() ?? []) {
      uris.add(uri);
    }

    const entries = [...uris]
      .filter((uri) => {
        const parsed = parseSpaceUri(uri);
        if (!parsed) return false;
        if (spaceTypeFilter !== undefined && parsed.type !== spaceTypeFilter) return false;
        if (spaceDidFilter !== undefined && parsed.authorityDid !== spaceDidFilter) return false;
        return cursor === undefined || uri > cursor;
      })
      .sort(compareLex);

    const pageUris = entries.slice(0, limit);
    const callerRepos = this.accountRepos.get(did);
    const spaces = pageUris.map((uri) => {
      const repoState = callerRepos?.get(uri);
      const space = this.spaces.get(uri);
      const spaceRev = space && !space.deleted && space.ownerDid === did ? this.currentSpaceRev(space) : undefined;
      return {
        space: uri,
        ...(repoState ? { repoRev: repoState.rev, data: { $bytes: toBase64(this.commitForState(uri, did, repoState).data) } } : {}),
        ...(spaceRev !== undefined ? { spaceRev } : {}),
      };
    });
    return {
      spaces,
      ...(pageUris.length === limit ? { cursor: pageUris[pageUris.length - 1]! } : {}),
    };
  }

  /** A record in the account's ordinary public repo (outside any space), writable only by its owner. */
  private async putPublicRecord(params: Record<string, unknown>, auth: FakeAuth) {
    const did = this.requireSelf(auth, { scopes: "standard" });
    if (params.repo !== did) throw new FakeXrpcError(400, "InvalidRequest", "Can only write to your own repo");
    const { cid } = await serializeRecord(String(params.collection) as `${string}.${string}.${string}`, String(params.rkey) as never, params.record as never);
    let records = this.publicRecords.get(did);
    if (!records) this.publicRecords.set(did, records = new Map());
    records.set(`${String(params.collection)}/${String(params.rkey)}`, { value: params.record, cid: cid.toString() });
    return { uri: `at://${did}/${String(params.collection)}/${String(params.rkey)}`, cid: cid.toString() };
  }

  /** Public: any caller, session or not, may read a public repo record. */
  private getPublicRecord(params: Record<string, unknown>) {
    const record = this.publicRecords.get(String(params.repo))?.get(`${String(params.collection)}/${String(params.rkey)}`);
    if (!record) throw new FakeXrpcError(400, "RecordNotFound", "Record not found");
    return { uri: `at://${String(params.repo)}/${String(params.collection)}/${String(params.rkey)}`, cid: record.cid, value: record.value };
  }

  /**
   * Runs a mutation strictly serialized per `(spaceUri, repoDid)`.
   * Executes synchronously when no mutation is queued so sync test helpers (`clearRecordsAs`) keep working without `await`.
   */
  private withRepoLock<T>(spaceUri: string, repoDid: string, fn: () => T | Promise<T>): T | Promise<T> {
    const key = `${spaceUri}\u0000${repoDid}`;
    const prev = this.repoLocks.get(key);
    if (!prev) {
      const result = fn();
      if (result instanceof Promise) {
        const tracked = result.then(() => undefined, () => undefined).finally(() => {
          if (this.repoLocks.get(key) === tracked) this.repoLocks.delete(key);
        });
        this.repoLocks.set(key, tracked);
      }
      return result;
    }
    const next = prev.then(() => fn());
    const tracked = next.then(() => undefined, () => undefined).finally(() => {
      if (this.repoLocks.get(key) === tracked) this.repoLocks.delete(key);
    });
    this.repoLocks.set(key, tracked);
    return next;
  }

  private getOrCreateAccountRepo(repo: string, spaceUriStr: string): FakeAccountRepo {
    let bySpace = this.accountRepos.get(repo);
    if (!bySpace) this.accountRepos.set(repo, bySpace = new Map());
    let state = bySpace.get(spaceUriStr);
    if (!state) {
      state = { rev: this.nextRev(), collections: new Map(), oplog: [] };
      bySpace.set(spaceUriStr, state);
    }
    return state;
  }

  private assertOwnSpaceExistsForWrite(spaceUriStr: string, writerDid: string): void {
    const ref = this.requireSpaceRef(spaceUriStr);
    if (ref.authorityDid === writerDid) {
      const space = this.spaces.get(spaceUriStr);
      if (!space || space.deleted) throw new FakeXrpcError(400, "SpaceNotFound", "Space not found");
    }
  }

  private async putRecordUnlocked(
    params: Record<string, unknown>,
    did: string,
    deliveries: Promise<void>[],
  ) {
    const spaceUriStr = String(params.space);
    const repo = String(params.repo);
    const collection = String(params.collection);
    const rkey = String(params.rkey);
    const record = params.record as Record<string, unknown>;
    this.assertOwnSpaceExistsForWrite(spaceUriStr, did);

    const { cid } = await serializeRecord(
      collection as `${string}.${string}.${string}`,
      rkey as never,
      jsonToLex(record as Parameters<typeof jsonToLex>[0]) as never,
    );
    const accountRepo = this.getOrCreateAccountRepo(repo, spaceUriStr);
    let records = accountRepo.collections.get(collection);
    if (!records) accountRepo.collections.set(collection, records = new Map());
    const prev = records.get(rkey)?.cid.toString() ?? null;
    records.set(rkey, { value: record, cid });
    const rev = this.nextRev();
    accountRepo.rev = rev;
    accountRepo.oplog.push({ rev, idx: 0, collection, rkey, cid: cid.toString(), prev });
    this.recordWrite(spaceUriStr, repo, accountRepo, deliveries);
    return { uri: `${spaceUriStr}/${repo}/${collection}/${rkey}`, cid: cid.toString() };
  }

  private async putRecord(params: Record<string, unknown>, auth: FakeAuth, deliveries: Promise<void>[]) {
    const did = this.requireSelf(auth, { scopes: "full", checkTakedown: true, checkDeactivated: true });
    const repo = String(params.repo);
    if (repo !== did) throw new FakeXrpcError(403, "Forbidden", "repo must match authenticated user");
    return this.withRepoLock(String(params.space ?? ""), repo, () => this.putRecordUnlocked(params, did, deliveries));
  }

  /** Like `putRecord`, but a record already at that key is refused, as the pinned PDS's `createRecord` does. */
  private async createRecord(params: Record<string, unknown>, auth: FakeAuth, deliveries: Promise<void>[]) {
    const did = this.requireSelf(auth, { scopes: "full", checkTakedown: true, checkDeactivated: true });
    const repo = String(params.repo);
    if (repo !== did) throw new FakeXrpcError(403, "Forbidden", "repo must match authenticated user");
    const spaceUriStr = String(params.space ?? "");
    return this.withRepoLock(spaceUriStr, repo, () => {
      this.assertOwnSpaceExistsForWrite(spaceUriStr, did);
      const rkey = typeof params.rkey === "string" ? params.rkey : fakeTid(++this.revCounter);
      const existing = this.accountRepos.get(repo)?.get(spaceUriStr)?.collections.get(String(params.collection))?.has(rkey);
      if (existing) throw new FakeXrpcError(400, "RecordAlreadyExists", "Record already exists");
      return this.putRecordUnlocked({ ...params, rkey }, did, deliveries);
    });
  }

  private async applyWrites(params: Record<string, unknown>, auth: FakeAuth, deliveries: Promise<void>[]) {
    const did = this.requireSelf(auth, { scopes: "full", checkTakedown: true, checkDeactivated: true });
    const repo = String(params.repo);
    if (repo !== did) throw new FakeXrpcError(403, "Forbidden", "repo must match authenticated user");
    const spaceUriStr = String(params.space ?? "");
    return this.withRepoLock(spaceUriStr, repo, async () => {
      this.requireSpaceRef(spaceUriStr);
      this.assertOwnSpaceExistsForWrite(spaceUriStr, did);
      const writes = Array.isArray(params.writes) ? (params.writes as Array<Record<string, unknown>>) : [];
      if (writes.length > 200) throw new FakeXrpcError(400, "InvalidRequest", "Too many writes. Max: 200");
      if (writes.length === 0) return { results: [] };

      const existingCollections = this.accountRepos.get(repo)?.get(spaceUriStr)?.collections;
      const staged = new Map<string, Map<string, RecordEntry>>();
      for (const [col, entries] of existingCollections ?? []) staged.set(col, new Map(entries));

      const rev = this.nextRev();
      const ops: FakeRepoOp[] = [];
      const results: Array<Record<string, unknown>> = [];

      for (const write of writes) {
        const type = String(write.$type ?? "");
        const collection = String(write.collection ?? "");
        if (type === "com.atproto.space.applyWrites#delete") {
          const rkey = String(write.rkey ?? "");
          const col = staged.get(collection);
          const prevEntry = col?.get(rkey);
          if (!prevEntry) throw new FakeXrpcError(400, "RecordNotFound", `Record not found: ${collection}/${rkey}`);
          col!.delete(rkey);
          ops.push({ rev, idx: ops.length, collection, rkey, cid: null, prev: prevEntry.cid.toString() });
          results.push({ $type: "com.atproto.space.applyWrites#deleteResult" });
          continue;
        }

        const isCreate = type === "com.atproto.space.applyWrites#create";
        const isUpdate = type === "com.atproto.space.applyWrites#update";
        if (!isCreate && !isUpdate) throw new FakeXrpcError(400, "InvalidRequest", `Action not supported: ${type}`);

        const rkey = typeof write.rkey === "string" ? write.rkey : fakeTid(++this.revCounter);
        let col = staged.get(collection);
        if (!col) staged.set(collection, col = new Map());
        const prevEntry = col.get(rkey);
        if (isCreate && prevEntry) throw new FakeXrpcError(400, "RecordAlreadyExists", `Record already exists: ${collection}/${rkey}`);
        if (isUpdate && !prevEntry) throw new FakeXrpcError(400, "RecordNotFound", `Record not found: ${collection}/${rkey}`);

        const value = write.value as Record<string, unknown>;
        const { cid } = await serializeRecord(collection as never, rkey as never, jsonToLex(value as Parameters<typeof jsonToLex>[0]) as never);
        col.set(rkey, { value, cid });
        ops.push({
          rev,
          idx: ops.length,
          collection,
          rkey,
          cid: cid.toString(),
          prev: prevEntry?.cid.toString() ?? null,
        });
        results.push({
          $type: isCreate ? "com.atproto.space.applyWrites#createResult" : "com.atproto.space.applyWrites#updateResult",
          uri: `${spaceUriStr}/${repo}/${collection}/${rkey}`,
          cid: cid.toString(),
        });
      }

      const accountRepo = this.getOrCreateAccountRepo(repo, spaceUriStr);
      accountRepo.collections = staged;
      accountRepo.rev = rev;
      accountRepo.oplog.push(...ops);
      this.recordWrite(spaceUriStr, repo, accountRepo, deliveries);
      return { results };
    });
  }

  private clearRecords(
    params: Record<string, unknown>,
    auth: FakeAuth,
    deliveries: Promise<void>[],
  ): Record<string, never> | Promise<Record<string, never>> {
    const did = this.requireSelf(auth, { scopes: "full", checkTakedown: true, checkDeactivated: true });
    const repo = String(params.repo);
    if (repo !== did) throw new FakeXrpcError(403, "Forbidden", "repo must match authenticated user");
    const spaceUriStr = String(params.space ?? "");
    return this.withRepoLock(spaceUriStr, repo, () => {
      this.requireSpaceRef(spaceUriStr);
      const accountRepo = this.accountRepos.get(repo)?.get(spaceUriStr);
      if (!accountRepo) return {};
      let hadRecords = false;
      for (const entries of accountRepo.collections.values()) {
        if (entries.size > 0) {
          hadRecords = true;
          break;
        }
      }
      if (!hadRecords) return {};
      accountRepo.collections.clear();
      accountRepo.oplog = [];
      accountRepo.rev = this.nextRev();
      this.recordWrite(spaceUriStr, repo, accountRepo, deliveries);
      return {};
    });
  }

  private async importRepo(
    _params: Record<string, unknown>,
    auth: FakeAuth,
    requestHeaders: Headers | undefined,
    rawBody?: Uint8Array,
  ): Promise<Record<string, never>> {
    const did = this.requireSelf(auth, { scopes: "full", checkTakedown: true });
    if (requestHeaders) {
      const contentType = requestHeaders.get("content-type") ?? "";
      if (!contentType.includes(STAR_MEDIA_TYPE)) {
        throw new FakeXrpcError(400, "InvalidRequest", `Content-Type must be ${STAR_MEDIA_TYPE}`);
      }
    }
    if (!rawBody) throw new FakeXrpcError(400, "InvalidRepoFile", "STAR archive body is required");
    let parsed: Awaited<ReturnType<typeof readRepoStar>>;
    try {
      parsed = await readRepoStar([rawBody]);
    } catch (error) {
      throw new FakeXrpcError(400, "InvalidRepoFile", error instanceof Error ? error.message : "Invalid STAR archive");
    }
    try {
      if (parsed.commit.repo !== did) {
        throw new FakeXrpcError(400, "RepoMismatch", "Repo does not match the authenticated account");
      }
      return await this.withRepoLock(parsed.commit.space, did, async () => {
        this.assertOwnSpaceExistsForWrite(parsed.commit.space, did);
        const imported = new Map<string, Map<string, RecordEntry>>();
        for await (const entry of parsed.records) {
          let col = imported.get(entry.collection);
          if (!col) imported.set(entry.collection, col = new Map());
          col.set(entry.rkey, { value: lexToJson(entry.record) as Record<string, unknown>, cid: entry.cid });
        }
        const accountRepo = this.getOrCreateAccountRepo(did, parsed.commit.space);
        accountRepo.collections = imported;
        accountRepo.oplog = [];
        accountRepo.rev = this.nextRev();
        return {};
      });
    } catch (error) {
      if (error instanceof FakeXrpcError) throw error;
      throw new FakeXrpcError(400, "InvalidRepoFile", error instanceof Error ? error.message : "Invalid STAR archive");
    } finally {
      await parsed.records.return?.(undefined).catch(() => undefined);
    }
  }

  /**
   * A service token for `aud` and `lxm`, as the caller's own PDS issues one.
   * Remains usable by app passwords (`ACCESS_STANDARD`).
   */
  private getServiceAuth(params: Record<string, unknown>, auth: FakeAuth): { token: string } {
    const did = this.requireSelf(auth, { scopes: "standard" });
    if (typeof params.aud !== "string") throw new FakeXrpcError(400, "InvalidRequest", "aud is required");
    const exp = params.exp !== undefined ? Number(params.exp) : Math.floor(this.now() / 1000) + 60;
    return { token: `fake-service-token.${btoa(JSON.stringify({ iss: did, aud: params.aud, lxm: params.lxm ?? null, exp }))}` };
  }

  /** What a fake service token says, or null when it is not one this network issued. */
  readServiceToken(token: string): { iss: string; aud: string; lxm: string | null; exp: number } | null {
    if (!token.startsWith("fake-service-token.")) return null;
    try {
      return JSON.parse(atob(token.slice("fake-service-token.".length))) as { iss: string; aud: string; lxm: string | null; exp: number };
    } catch {
      return null;
    }
  }

  private deleteRecord(
    params: Record<string, unknown>,
    auth: FakeAuth,
    deliveries: Promise<void>[],
  ): Record<string, never> | Promise<Record<string, never>> {
    const did = this.requireSelf(auth, { scopes: "full", checkTakedown: true, checkDeactivated: true });
    const repo = String(params.repo);
    if (repo !== did) throw new FakeXrpcError(403, "Forbidden", "repo must match authenticated user");
    const spaceUriStr = String(params.space ?? "");
    return this.withRepoLock(spaceUriStr, repo, () => {
      this.requireSpaceRef(spaceUriStr);
      const accountRepo = this.accountRepos.get(repo)?.get(spaceUriStr);
      if (!accountRepo) return {};
      const collection = String(params.collection);
      const rkey = String(params.rkey);
      const entries = accountRepo.collections.get(collection);
      const existing = entries?.get(rkey);
      if (!existing) return {};
      entries!.delete(rkey);
      const rev = this.nextRev();
      accountRepo.oplog.push({ rev, idx: 0, collection, rkey, cid: null, prev: existing.cid.toString() });
      accountRepo.rev = rev;
      this.recordWrite(spaceUriStr, repo, accountRepo, deliveries);
      return {};
    });
  }

  /** Updates the space's writer set (unless lagging) and schedules `notifySpaceUpdate` deliveries. */
  private recordWrite(
    spaceUriStr: string,
    repo: string,
    accountRepo: FakeAccountRepo,
    deliveries: Promise<void>[],
  ): void {
    const space = this.spaces.get(spaceUriStr);
    if (!space || space.deleted) return;
    const repoRev = accountRepo.rev;
    if (this.lagging.has(spaceUriStr)) {
      if (space.policy.$type === MANAGEDSPACE_POLICY || this.currentlyAuthorizedSyncWriter(space, repo)) {
        const pending = this.pendingListing.get(spaceUriStr) ?? [];
        pending.push({ did: repo, repoRev });
        this.pendingListing.set(spaceUriStr, pending);
      }
      return;
    }
    const data = this.commitForState(spaceUriStr, repo, accountRepo).data;
    if (space.policy.$type === MANAGEDSPACE_POLICY) {
      deliveries.push(this.deliverRepoUpdateToSpace(space, repo, repoRev, data).then(() => undefined));
      return;
    }
    if (!this.currentlyAuthorizedSyncWriter(space, repo)) return;
    const update = this.recordWriterEntry(space, repo, repoRev, data);
    if (update) deliveries.push(this.deliverSpaceUpdate(space, update));
  }

  private async deliverRepoUpdateToSpace(
    space: FakeSpace,
    repo: string,
    repoRev: string,
    data: Uint8Array,
  ): Promise<"ok" | "rejected" | "retryable"> {
    try {
      const authorized = await this.authorizeRepoAccess(space, repo, "write");
      if (!authorized) return "rejected";
      const update = this.recordWriterEntry(space, repo, repoRev, data);
      if (update) await this.deliverSpaceUpdate(space, update);
      return "ok";
    } catch (error) {
      if (error instanceof FakeXrpcError && error.status >= 500) {
        const spaceUriStr = spaceUri(space);
        this.pendingRepoUpdateRetries.set(`${spaceUriStr}\u0000${repo}`, { spaceUri: spaceUriStr, repo, repoRev, data });
        return "retryable";
      }
      return "rejected";
    }
  }

  private recordWriterEntry(
    space: FakeSpace,
    repo: string,
    repoRev: string,
    data: Uint8Array,
  ): Record<string, unknown> | undefined {
    const existing = space.writers.get(repo);
    const existingRev = existing ? (existing.removed ? existing.lastRepoRev : existing.repoRev) : undefined;
    if (existingRev !== undefined && existingRev >= repoRev) return undefined;

    const { spaceRev, prevSpaceRev } = this.nextSpaceRev(space);
    space.writers.set(repo, { removed: false, repoRev, spaceRev, data });
    return {
      $type: "com.atproto.space.defs#repoWrite",
      repo,
      repoRev,
      spaceRev,
      ...(prevSpaceRev !== undefined ? { prevSpaceRev } : {}),
      data: { $bytes: toBase64(data) },
    };
  }

  private removeWriterEntry(space: FakeSpace, repo: string): Record<string, unknown> | undefined {
    const existing = space.writers.get(repo);
    if (!existing || existing.removed) return undefined;
    const { spaceRev, prevSpaceRev } = this.nextSpaceRev(space);
    space.writers.set(repo, { removed: true, lastRepoRev: existing.repoRev, spaceRev });
    return {
      $type: "com.atproto.space.defs#repoRemoved",
      repo,
      spaceRev,
      ...(prevSpaceRev !== undefined ? { prevSpaceRev } : {}),
    };
  }

  private currentSpaceRev(space: FakeSpace): string | undefined {
    let latest: string | undefined;
    for (const entry of space.writers.values()) {
      if (latest === undefined || entry.spaceRev > latest) latest = entry.spaceRev;
    }
    return latest;
  }

  private nextSpaceRev(space: FakeSpace): { spaceRev: string; prevSpaceRev?: string } {
    const prevSpaceRev = this.currentSpaceRev(space);
    return { spaceRev: this.nextRev(), ...(prevSpaceRev !== undefined ? { prevSpaceRev } : {}) };
  }

  private async deliverSpaceUpdate(space: FakeSpace, update: Record<string, unknown>): Promise<void> {
    const uri = spaceUri(space);
    if (this.withheldNotices.has(uri)) return;
    const registrations = [...space.notifyRegistrations.entries()];
    if (registrations.length === 0) return;

    const nowMs = this.now();
    const active: Array<{ endpoint: string; token: string }> = [];
    const lapsed: Array<{ key: string; reg: FakeNotifyRegistration }> = [];

    for (const [key, reg] of registrations) {
      if (reg.expiresAtMs > nowMs) {
        active.push({ endpoint: reg.endpoint, token: reg.token });
      } else if (!reg.expiryNotified) {
        reg.expiryNotified = true;
        lapsed.push({ key, reg });
      }
    }

    await Promise.all(
      active.map(async ({ endpoint, token }) => {
        try {
          const response = await this.sendNotifyUpdate(endpoint, { space: uri, token, update });
          if (!response.ok) {
            // Active write/removal rejection (including HTTP 400) is logged and ignored without dropping registration (`util.ts:443`).
            this.notifyWarnings.push({
              space: uri,
              endpoint,
              updateType: String(update.$type ?? ""),
              status: response.status,
              error: `notifySpaceUpdate failed with HTTP ${response.status}`,
            });
          }
        } catch (error) {
          this.notifyWarnings.push({
            space: uri,
            endpoint,
            updateType: String(update.$type ?? ""),
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );

    if (lapsed.length > 0) {
      const expiredUpdate = {
        $type: "com.atproto.space.notifySpaceUpdate#registrationExpired",
        spaceRev: String(update.spaceRev),
      };
      await Promise.all(
        lapsed.map(async ({ key, reg }) => {
          try {
            const response = await this.sendNotifyUpdate(reg.endpoint, {
              space: uri,
              token: reg.token,
              update: expiredUpdate,
            });
            if (!response.ok && !RETRYABLE_HTTP_STATUSES.has(response.status)) {
              const current = space.notifyRegistrations.get(key);
              if (current && current.expiresAtMs <= this.now()) {
                space.notifyRegistrations.delete(key);
              }
            }
          } catch (error) {
            this.notifyWarnings.push({
              space: uri,
              endpoint: reg.endpoint,
              updateType: expiredUpdate.$type,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }),
      );
    }
  }

  private async deliverDeletionNotice(
    uri: string,
    registrations: readonly FakeNotifyRegistration[],
  ): Promise<void> {
    const update = { $type: "com.atproto.space.notifySpaceUpdate#spaceDeleted" };
    await Promise.all(
      registrations.map(async ({ endpoint, token }) => {
        try {
          await this.sendNotifyUpdate(endpoint, { space: uri, token, update });
        } catch (error) {
          this.notifyWarnings.push({
            space: uri,
            endpoint,
            updateType: update.$type,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );
  }

  private async sendNotifyUpdate(
    endpoint: string,
    body: { space: string; token: string; update: Record<string, unknown> },
  ): Promise<Response> {
    return this.sendOutbound(`${normalizeBaseUrl(endpoint)}/xrpc/com.atproto.space.notifySpaceUpdate`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
  }

  private async sendOutbound(url: string, init: RequestInit): Promise<Response> {
    const request = new Request(url, init);
    const normalized = normalizeBaseUrl(url);
    let matchedEndpoint: string | undefined;
    let matchedHandler: ((request: Request) => Promise<Response> | Response) | undefined;
    for (const [base, handler] of this.endpoints) {
      if ((normalized === base || normalized.startsWith(`${base}/`)) && (!matchedEndpoint || base.length > matchedEndpoint.length)) {
        matchedEndpoint = base;
        matchedHandler = handler;
      }
    }
    if (matchedHandler) return matchedHandler(request);
    if (this.outboundFetch) return this.outboundFetch(request);
    throw new TypeError(`fake-pds: no endpoint registered for ${url}`);
  }

  private trackDelivery(promise: Promise<void>): void {
    const tracked = promise.catch(() => undefined).finally(() => {
      this.pendingDeliveries.delete(tracked);
    });
    this.pendingDeliveries.add(tracked);
  }

  /**
   * The shared secret for a MAC-bearing read. A credential must ask for a MAC via
   * `Accept-Signature` (`InvalidSpaceMac` otherwise); the secret is derived with HPKE
   * `"atproto-mac"` against the repo author's current `#atproto_kem` key.
   */
  private async spaceMacRequest(
    method: string,
    repo: string,
    own: boolean,
    requestHeaders: Headers | undefined,
  ): Promise<CreateMacParams | undefined> {
    const profile = MAC_METHODS[method]!;
    let request: ReturnType<typeof parseMacRequest>;
    try {
      request = parseMacRequest(requestHeaders?.get("accept-signature") ?? undefined, profile);
    } catch (error) {
      if (error instanceof SpaceMacError) throw new FakeXrpcError(400, "InvalidSpaceMac", error.message);
      throw error;
    }
    if (!request) {
      if (!own) {
        throw new FakeXrpcError(400, "InvalidSpaceMac", `A MAC must be requested with tag "${profile}"`);
      }
      return undefined;
    }
    try {
      const sharedSecret = decapsulate(await this.kemKeypair(repo), request.keyShare);
      return { ...request, sharedSecret };
    } catch (error) {
      if (error instanceof SpaceKemError || error instanceof SpaceMacError) {
        throw new FakeXrpcError(400, "InvalidSpaceMac", error.message);
      }
      throw error;
    }
  }

  private assertRepoAvailability(repo: string, own: boolean): void {
    if (!this.accounts.has(repo)) throw new FakeXrpcError(400, "RepoNotFound", `Could not find repo for DID: ${repo}`);
    const state = this.unavailable.get(repo);
    if (state === "RepoNotFound") throw new FakeXrpcError(400, "RepoNotFound", `Could not find repo for DID: ${repo}`);
    if (state && !own) throw new FakeXrpcError(400, state, `Repo is not available: ${repo}`);
  }

  private async getRecord(params: Record<string, unknown>, auth: FakeAuth, requestHeaders: Headers | undefined): Promise<WithHeaders> {
    const { own } = await this.authorizeSpaceRead(params, auth);
    const repo = String(params.repo);
    this.assertRepoAvailability(repo, own);
    const spaceUriStr = String(params.space);
    const mac = await this.spaceMacRequest("com.atproto.space.getRecord", repo, own, requestHeaders);

    const collection = String(params.collection);
    const rkey = String(params.rkey);
    const record = this.accountRepos.get(repo)?.get(spaceUriStr)?.collections.get(collection)?.get(rkey);
    if (!record) throw new FakeXrpcError(400, "RecordNotFound", "Record not found");

    const uri = `${spaceUriStr}/${repo}/${collection}/${rkey}`;
    const headers = mac
      ? macHeaders(RECORD_MAC_PROFILE, createRecordMacHeaders(uri as never, record.cid, mac).headers)
      : { vary: "Accept-Signature" };
    return new WithHeaders({ uri, cid: record.cid.toString(), value: record.value }, headers);
  }

  private async getLatestCommit(params: Record<string, unknown>, auth: FakeAuth, requestHeaders: Headers | undefined): Promise<WithHeaders> {
    await this.beforeGetLatestCommit?.({ space: String(params.space), repo: String(params.repo) });
    const { own } = await this.authorizeSpaceRead(params, auth);
    const repo = String(params.repo);
    this.assertRepoAvailability(repo, own);
    const spaceUriStr = String(params.space);
    const mac = await this.spaceMacRequest("com.atproto.space.getLatestCommit", repo, own, requestHeaders);

    const commit = this.commitForRepo(spaceUriStr, repo);
    const headers = mac
      ? macHeaders(COMMIT_MAC_PROFILE, createCommitMacHeaders(commit, mac).headers)
      : { vary: "Accept-Signature" };
    return new WithHeaders({ commit: commitJson(commit) }, headers);
  }

  private async getRepo(params: Record<string, unknown>, auth: FakeAuth, requestHeaders: Headers | undefined): Promise<BinaryResponse> {
    await this.beforeGetRepo?.({ space: String(params.space), repo: String(params.repo) });
    const { own } = await this.authorizeSpaceRead(params, auth);
    const repo = String(params.repo);
    this.assertRepoAvailability(repo, own);
    const spaceUriStr = String(params.space);
    const mac = await this.spaceMacRequest("com.atproto.space.getRepo", repo, own, requestHeaders);

    const accountRepo = this.accountRepos.get(repo)?.get(spaceUriStr);
    if (!accountRepo) throw new FakeXrpcError(400, "RepoNotFound", `Could not find repo for space: ${spaceUriStr}`);
    const commit = this.commitForState(spaceUriStr, repo, accountRepo);

    const encoder = new TextEncoder();
    const entries: Array<{ keyBytes: Uint8Array; collection: string; rkey: string; value: Record<string, unknown> }> = [];
    for (const [collection, records] of accountRepo.collections) {
      for (const [rkey, entry] of records) {
        entries.push({ keyBytes: encoder.encode(`${collection}/${rkey}`), collection, rkey, value: entry.value });
      }
    }
    entries.sort((left, right) => compareBytes(left.keyBytes, right.keyBytes));
    const serialized: SerializedRecord[] = [];
    for (const entry of entries) {
      const lex = jsonToLex(entry.value as Parameters<typeof jsonToLex>[0]) as Parameters<typeof serializeRecord>[2];
      serialized.push(await serializeRecord(entry.collection as never, entry.rkey as never, lex));
    }
    const generator = writeRepoStar(commit, serialized);
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await generator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      async cancel() {
        await generator.return?.(undefined);
      },
    });
    const headers = mac
      ? macHeaders(COMMIT_MAC_PROFILE, createCommitMacHeaders(commit, mac).headers)
      : { vary: "Accept-Signature" };
    return new BinaryResponse(stream, headers, STAR_MEDIA_TYPE);
  }

  private async getBlob(params: Record<string, unknown>, auth: FakeAuth): Promise<never> {
    if (auth.kind === "credential-candidate") {
      await this.authorizeSpaceRead(params, auth);
    } else {
      this.requireSelf(auth, { scopes: "full" });
    }
    throw new FakeXrpcError(501, "NotImplemented", "fake-pds does not implement com.atproto.space.getBlob");
  }

  private async listBlobs(params: Record<string, unknown>, auth: FakeAuth): Promise<never> {
    if (auth.kind === "credential-candidate") {
      await this.authorizeSpaceRead(params, auth);
    } else {
      this.requireSelf(auth, { scopes: "full" });
    }
    throw new FakeXrpcError(501, "NotImplemented", "fake-pds does not implement com.atproto.space.listBlobs");
  }

  private exportSpaceMeta(params: Record<string, unknown>, auth: FakeAuth): never {
    const did = this.requireSelf(auth, { scopes: "full" });
    this.requireSpaceAuthority(params.space, did);
    throw new FakeXrpcError(501, "NotImplemented", "fake-pds does not implement com.atproto.space.exportSpaceMeta");
  }

  private importSpaceMeta(auth: FakeAuth): never {
    this.requireSelf(auth, { scopes: "full", checkTakedown: true });
    throw new FakeXrpcError(501, "NotImplemented", "fake-pds does not implement com.atproto.space.importSpaceMeta");
  }

  private commitForRepo(spaceUriStr: string, repo: string): SpaceCommit {
    const accountRepo = this.accountRepos.get(repo)?.get(spaceUriStr);
    if (!accountRepo) throw new FakeXrpcError(400, "RepoNotFound", `Could not find repo for space: ${spaceUriStr}`);
    return this.commitForState(spaceUriStr, repo, accountRepo);
  }

  private commitForState(spaceUriStr: string, repo: string, accountRepo: FakeAccountRepo): SpaceCommit {
    const records = [...accountRepo.collections].flatMap(([collection, entries]) =>
      [...entries].map(([rkey, entry]) => ({ collection: collection as never, rkey: rkey as never, cid: entry.cid })));
    return RepoCommit.fromRecords(records).toCommit({
      space: spaceUriStr as SpaceCommit["space"],
      repo: repo as SpaceCommit["repo"],
      rev: accountRepo.rev as SpaceCommit["rev"],
    });
  }

  private async listRecords(params: Record<string, unknown>, auth: FakeAuth) {
    const collection = typeof params.collection === "string" ? params.collection : undefined;
    const excludeValues = params.excludeValues === true || params.excludeValues === "true";
    await this.beforeListRecords?.({
      space: String(params.space),
      repo: String(params.repo),
      ...(collection !== undefined ? { collection } : {}),
      excludeValues,
      ...(typeof params.cursor === "string" ? { cursor: params.cursor } : {}),
    });
    const { own } = await this.authorizeSpaceRead(params, auth);
    const repo = String(params.repo);
    this.assertRepoAvailability(repo, own);
    const spaceUriStr = String(params.space);
    const cursor = typeof params.cursor === "string" ? params.cursor : undefined;
    if (cursor !== undefined && !isSpaceRecordCursor(cursor)) {
      throw new FakeXrpcError(400, "InvalidCursor", "Malformed cursor");
    }

    const prefix = `${spaceUriStr}/${repo}`;
    const all: Array<{ uri: string; collection: string; rkey: string; entry: RecordEntry }> = [];
    const collections = this.accountRepos.get(repo)?.get(spaceUriStr)?.collections;
    if (collections) {
      if (collection !== undefined) {
        for (const [rkey, entry] of collections.get(collection)?.entries() ?? []) {
          all.push({ uri: `${prefix}/${collection}/${rkey}`, collection, rkey, entry });
        }
      } else {
        for (const [col, entries] of collections) {
          for (const [rkey, entry] of entries) {
            all.push({ uri: `${prefix}/${col}/${rkey}`, collection: col, rkey, entry });
          }
        }
      }
    }
    all.sort((left, right) => compareLex(right.uri, left.uri));
    const filtered = cursor !== undefined ? all.filter((item) => item.uri < cursor) : all;
    const limit = clampLimit(params.limit, 50, 1000);
    const page = filtered.slice(0, limit);
    const nextCursor = page.length < limit ? undefined : page.at(-1)?.uri;
    return {
      records: page.map((item) => ({
        collection: item.collection,
        rkey: item.rkey,
        cid: item.entry.cid.toString(),
        ...(excludeValues ? {} : { value: item.entry.value }),
      })),
      ...(nextCursor !== undefined ? { cursor: nextCursor } : {}),
    };
  }

  private async listRepoOps(params: Record<string, unknown>, auth: FakeAuth, requestHeaders: Headers | undefined): Promise<WithHeaders> {
    const limit = clampLimit(params.limit, 100, 1000);
    const excludeValues = params.excludeValues === true || params.excludeValues === "true";
    const since = typeof params.since === "string" ? params.since : undefined;
    const cursorStr = typeof params.cursor === "string" ? params.cursor : undefined;
    await this.beforeListRepoOps?.({
      space: String(params.space),
      repo: String(params.repo),
      ...(since !== undefined ? { since } : {}),
      ...(cursorStr !== undefined ? { cursor: cursorStr } : {}),
      limit,
      excludeValues,
    });
    const { own } = await this.authorizeSpaceRead(params, auth);
    const repo = String(params.repo);
    this.assertRepoAvailability(repo, own);
    const spaceUriStr = String(params.space);
    const mac = await this.spaceMacRequest("com.atproto.space.listRepoOps", repo, own, requestHeaders);
    const cursor = cursorStr !== undefined ? parseRepoOpsCursor(cursorStr) : undefined;

    const accountRepo = this.accountRepos.get(repo)?.get(spaceUriStr);
    if (!accountRepo) {
      throw new FakeXrpcError(400, "RepoNotFound", `Could not find repo for space: ${spaceUriStr}`);
    }
    const commit = this.commitForState(spaceUriStr, repo, accountRepo);

    const filtered = accountRepo.oplog.filter((op) => {
      if (since !== undefined && op.rev <= since) return false;
      if (cursor !== undefined && !(op.rev > cursor.rev || (op.rev === cursor.rev && op.idx > cursor.idx))) return false;
      return true;
    });
    const page = filtered.slice(0, limit);
    const ops = page.map((op) => {
      const live = accountRepo.collections.get(op.collection)?.get(op.rkey);
      const value = !excludeValues && op.cid !== null && live && live.cid.toString() === op.cid ? live.value : undefined;
      return {
        rev: op.rev,
        collection: op.collection,
        rkey: op.rkey,
        cid: op.cid,
        prev: op.prev,
        ...(value !== undefined ? { value } : {}),
      };
    });

    const nextCursor = ops.length === limit ? `${page[page.length - 1]!.rev}/${page[page.length - 1]!.idx}` : undefined;
    const headers = mac
      ? macHeaders(COMMIT_MAC_PROFILE, createCommitMacHeaders(commit, mac).headers)
      : { vary: "Accept-Signature" };
    return new WithHeaders(
      {
        ops,
        ...(nextCursor !== undefined ? { cursor: nextCursor } : {}),
        commit: commitJson(commit),
      },
      headers,
    );
  }

  private async listWriters(params: Record<string, unknown>, auth: FakeAuth) {
    const ref = this.requireSpaceRef(params.space);
    await this.requireCredential(params, auth, ref.authorityDid);
    this.assertActiveSpaceHost(ref.authorityDid);
    const space = this.requireActiveSpace(params.space);
    const limit = clampLimit(params.limit, 100, 1000);
    const after = typeof params.cursor === "string" ? params.cursor : undefined;
    if (after !== undefined && !isTid(after)) {
      throw new FakeXrpcError(400, "InvalidCursor", "Malformed cursor");
    }
    const updated = [...space.writers.entries()]
      .filter(([, entry]) => after === undefined || entry.spaceRev > after)
      .sort((left, right) => compareLex(left[1].spaceRev, right[1].spaceRev));
    const page = updated.slice(0, limit);
    const repos = page.map(([repo, entry]) =>
      entry.removed
        ? {
            $type: "com.atproto.space.defs#repoRemoved",
            repo,
            spaceRev: entry.spaceRev,
          }
        : {
            $type: "com.atproto.space.defs#repoWrite",
            repo,
            repoRev: entry.repoRev,
            spaceRev: entry.spaceRev,
            data: { $bytes: toBase64(entry.data) },
          });
    return {
      repos,
      ...(page.length > 0 ? { cursor: page[page.length - 1]![1].spaceRev } : {}),
    };
  }

  private nextRev(): string {
    return fakeTid(++this.revCounter);
  }

  private currentlyAuthorizedSyncWriter(space: FakeSpace, did: string): boolean {
    if (did === space.ownerDid) return true;
    if (space.policy.$type === PERSONALSPACE_POLICY) return false;
    if (space.policy.$type === MEMBERSPACE_POLICY) {
      const member = space.members.get(did);
      if (member) return member.write;
      return space.policy.publicWrite;
    }
    return false;
  }
}

function compareLex(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const len = Math.min(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    if (left[i] !== right[i]) return left[i]! - right[i]!;
  }
  return left.length - right.length;
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function clampLimit(raw: unknown, fallback: number, max: number): number {
  const value = typeof raw === "number" ? raw : raw !== undefined ? Number(raw) : fallback;
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(max, Math.floor(value));
}

function parseRepoOpsCursor(cursor: string): { rev: string; idx: number } {
  const slash = cursor.indexOf("/");
  if (slash <= 0) throw new FakeXrpcError(400, "InvalidCursor", "Malformed cursor");
  const rev = cursor.slice(0, slash);
  const idxStr = cursor.slice(slash + 1);
  if (!/^\d+$/.test(idxStr)) throw new FakeXrpcError(400, "InvalidCursor", "Malformed cursor");
  return { rev, idx: Number(idxStr) };
}

function isSpaceRecordCursor(value: string): boolean {
  return /^at:\/\/[^/\s]+\/[^/\s]+(?:\/[^/\s]+)*$/.test(value);
}

function spaceUri(space: FakeSpace): string {
  return `at://${space.ownerDid}/space/${space.type}/${space.skey}`;
}

function normalizeBaseUrl(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function notifyKey(endpoint: string, token: string): string {
  return `${endpoint}\u0000${token}`;
}

function parseNotifyParam(raw: unknown): { endpoint: string; token: string } | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new FakeXrpcError(400, "InvalidRequest", "Invalid notify registration");
  }
  const candidate = raw as { endpoint?: unknown; token?: unknown };
  if (typeof candidate.endpoint !== "string" || candidate.endpoint.length === 0) {
    throw new FakeXrpcError(400, "InvalidRequest", "notify.endpoint must be a URI");
  }
  try {
    new URL(candidate.endpoint);
  } catch {
    throw new FakeXrpcError(400, "InvalidRequest", "notify.endpoint must be a valid URI");
  }
  if (typeof candidate.token !== "string" || candidate.token.length > 512) {
    throw new FakeXrpcError(400, "InvalidRequest", "notify.token must be a string up to 512 characters");
  }
  return { endpoint: candidate.endpoint, token: candidate.token };
}

function isDidServiceRef(value: string): boolean {
  return /^did:[a-z0-9]+:[^\s#]+#[A-Za-z0-9._-]+$/.test(value);
}

function toStoredPolicy(policy: unknown): FakeSpace["policy"] {
  const fields = (policy ?? {}) as {
    $type?: unknown;
    publicRead?: unknown;
    publicWrite?: unknown;
    allowedApps?: unknown;
    publishPolicy?: unknown;
    publishMembers?: unknown;
    managingApp?: unknown;
  };
  if (fields.$type === MEMBERSPACE_POLICY) {
    let allowedApps: string[] | undefined;
    if (fields.allowedApps !== undefined) {
      if (!Array.isArray(fields.allowedApps)) {
        throw new FakeXrpcError(400, "InvalidRequest", "allowedApps must be an array of URIs");
      }
      allowedApps = fields.allowedApps.map((app) => {
        if (typeof app !== "string") throw new FakeXrpcError(400, "InvalidRequest", "allowedApps entries must be URIs");
        try {
          new URL(app);
        } catch {
          throw new FakeXrpcError(400, "InvalidRequest", `allowedApps entry is not a valid URI: ${app}`);
        }
        return app;
      });
    }
    return {
      $type: MEMBERSPACE_POLICY,
      publicRead: fields.publicRead === true,
      publicWrite: fields.publicWrite === true,
      ...(allowedApps !== undefined ? { allowedApps } : {}),
      ...(fields.publishPolicy === true ? { publishPolicy: true } : {}),
      ...(fields.publishMembers === true ? { publishMembers: true } : {}),
    };
  }
  if (fields.$type === PERSONALSPACE_POLICY) {
    return { $type: PERSONALSPACE_POLICY, publicRead: false, publicWrite: false };
  }
  if (fields.$type === MANAGEDSPACE_POLICY) {
    if (typeof fields.managingApp !== "string" || !isDidServiceRef(fields.managingApp)) {
      throw new FakeXrpcError(
        400,
        "InvalidRequest",
        `managingApp must be a did#serviceId reference, got: ${String(fields.managingApp)}`,
      );
    }
    return {
      $type: MANAGEDSPACE_POLICY,
      publicRead: false,
      publicWrite: false,
      managingApp: fields.managingApp,
      ...(fields.publishPolicy === true ? { publishPolicy: true } : {}),
    };
  }
  throw new FakeXrpcError(400, "UnsupportedPolicy", "The requested policy is not one the host implements.");
}

function toPublicPolicy(policy: FakeSpace["policy"]): Record<string, unknown> {
  if (policy.$type === MEMBERSPACE_POLICY) {
    return {
      $type: MEMBERSPACE_POLICY,
      publicRead: policy.publicRead,
      publicWrite: policy.publicWrite,
      ...(policy.allowedApps !== undefined ? { allowedApps: policy.allowedApps } : {}),
      ...(policy.publishPolicy === true ? { publishPolicy: true } : {}),
      ...(policy.publishMembers === true ? { publishMembers: true } : {}),
    };
  }
  if (policy.$type === MANAGEDSPACE_POLICY) {
    return {
      $type: MANAGEDSPACE_POLICY,
      managingApp: policy.managingApp,
      publishPolicy: policy.publishPolicy === true,
    };
  }
  return { $type: policy.$type };
}

function commitJson(commit: { ver: number; repo: string; space: string; rev: string; data: Uint8Array }) {
  return { ver: commit.ver, repo: commit.repo, space: commit.space, rev: commit.rev, data: { $bytes: toBase64(commit.data) } };
}

function jsonToB64Url(json: Record<string, unknown>): string {
  return toBase64(utf8Encoder.encode(JSON.stringify(json)), "base64url");
}

const TID_ALPHABET = "234567abcdefghijklmnopqrstuvwxyz";

/** A 13-character TID whose lexical order follows `counter`. */
function fakeTid(counter: number): string {
  let rest = counter;
  let tid = "";
  for (let i = 0; i < 13; i++) {
    tid = TID_ALPHABET[rest % 32]! + tid;
    rest = Math.floor(rest / 32);
  }
  return tid;
}

function errorResponse(error: FakeXrpcError): Response {
  return new Response(JSON.stringify({ error: error.code, message: error.message }), {
    status: error.status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": CORS_ALLOW_HEADERS,
    },
  });
}

function rejected(status: number, code: string, message: string): FakeAuth {
  return { kind: "rejected", error: new FakeXrpcError(status, code, message) };
}
