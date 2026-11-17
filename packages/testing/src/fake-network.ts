import { P256Keypair } from "@atproto/crypto";
import { toBase64 } from "@atproto/lex-data";
import { jsonToLex, lexToJson } from "@atproto/lexicon";
import {
  COMMIT_MAC_TYPE,
  MAC_HEADER,
  RECORD_MAC_TYPE,
  RepoCommit,
  SpaceMacError,
  WANT_MAC_HEADER,
  computeCommitMac,
  computeRecordMac,
  decapsulate,
  formatMacHeader,
  isP256DidKey,
  parseWantMacHeader,
  readRepoStar,
  serializeRecord,
  serializeRepo,
  verifyCredentialSig,
  type MacType,
  type SerializedRecord,
} from "@atproto/space";
import { SPACE_CREDENTIAL_LIFETIME_MS } from "@flock/protocol/atproto/space-credential-core";
import { generateSpaceKey } from "@flock/protocol/atproto/space-key";
import { MEMBERSPACE_POLICY } from "@flock/protocol/atproto/space-policy";
import { AtprotoClient } from "@flock/protocol/atproto/xrpc";

/**
 * An in-memory, multi-host fake of the pinned PDS protocol for spaces of any type: the engine's channels, workspaces and
 * inboxes as well as DMs. Test-only: production code never imports this.
 *
 * Space management (`createSpace`/`updateSpace`/`getSpace`/`deleteSpace`, and
 * `putMember`/`removeMember`/`listMembers` under memberspace, plus `listSpaces`)
 * is authorized by the caller's own identity (`clientFor(did)`, standing in for
 * a self-authenticated OAuth session): only the space's owner may call them,
 * matching `authority=self` in DM_BROWSER_SCOPES.
 *
 * Repo content (`listRepos`/`listRecords`/`getRecord`/`getLatestCommit`/
 * `registerNotify`) always requires a minted space credential
 * (`getDelegationToken` at the caller's own host, then `getSpaceCredential` at
 * the authority's host), even for the authority's own space, matching the pinned
 * PDS's uniform credential mechanism (M0 conformance). `getRecord` and
 * `getLatestCommit` also require an `Atproto-Space-Want-Mac`
 * request and answer with an `Atproto-Space-Mac`, keyed by a shared secret
 * derived against the repo author's `#atproto_kem` key (`rotateKemKey` rotates it).
 *
 * The authority answers `SpaceNotFound` where a user the policy does not
 * authorize asks for a credential, like the reference PDS.
 *
 * Reproduces the M0-observed quirks: a `putRecord` into someone else's space
 * always succeeds (you always own your own repo) but is only added to
 * `trackedWriters` (and therefore `listRepos`) when the space's *current*
 * policy authorizes the writer. `removeMember` and `putMember` with
 * `write: false` evict a tracked writer, as the reference PDS now does;
 * `updateSpace` does not re-evaluate the writer set.
 */

const PERSONALSPACE_POLICY = "com.atproto.personalspace.policy";

type RecordEntry = { value: Record<string, unknown>; cid: Awaited<ReturnType<typeof serializeRecord>>["cid"] };

type FakeRepoOp = {
  rev: string;
  idx: number;
  collection: string;
  rkey: string;
  cid: string | null;
  prev: string | null;
};

type FakeSpace = {
  type: string;
  skey: string;
  ownerDid: string;
  policy: { $type: string; publicRead: boolean; publicWrite: boolean; allowedApps?: string[]; publishPolicy?: boolean; publishMembers?: boolean };
  members: Map<string, { read: boolean; write: boolean }>;
  trackedWriters: Map<string, { repoRev: string; spaceRev: string; data: Uint8Array }>;
  repoRevs: Map<string, string>;
  deleted: boolean;
  repos: Map<string, Map<string, Map<string, RecordEntry>>>;
  oplogs: Map<string, FakeRepoOp[]>;
};

export type ApplyWriteOp =
  | { action: "create"; collection: string; rkey?: string; value: Record<string, unknown> }
  | { action: "update"; collection: string; rkey: string; value: Record<string, unknown> }
  | { action: "delete"; collection: string; rkey: string };

type FakeAuth =
  | { kind: "self"; did: string }
  | { kind: "credential"; token: string; audience: string }
  | { kind: "none" }
  | { kind: "rejected"; error: FakeXrpcError };

const NOTIFY_REGISTRATION_TTL_MS = 24 * 60 * 60 * 1000;

const MAC_METHODS: Readonly<Record<string, MacType>> = {
  "com.atproto.space.getRecord": RECORD_MAC_TYPE,
  "com.atproto.space.getLatestCommit": COMMIT_MAC_TYPE,
  "com.atproto.space.listRepoOps": COMMIT_MAC_TYPE,
  "com.atproto.space.getRepo": COMMIT_MAC_TYPE,
};

export class FakeXrpcError extends Error {
  constructor(readonly status: number, readonly code: string, message = code) {
    super(message);
    this.name = "FakeXrpcError";
  }
}

/** A response body together with the headers the method sets (the MAC). */
/** The MAC header, plus what a browser needs to read it: the response varies on the request header and exposes the MAC. */
function macHeaders(mac: string): Record<string, string> {
  return { [MAC_HEADER]: mac, vary: WANT_MAC_HEADER, "access-control-expose-headers": MAC_HEADER };
}

class WithHeaders {
  constructor(readonly body: unknown, readonly headers: Record<string, string>) {}
}

class BinaryResponse {
  constructor(
    readonly body: ReadableStream<Uint8Array> | Uint8Array,
    readonly headers: Record<string, string>,
    readonly contentType = "application/octet-stream",
  ) {}
}

export class FakeNetwork {
  private virtualNow = Date.now();

  private readonly accounts = new Map<string, string>();
  /** Accounts whose repo the host refuses to serve (deactivated, taken down, or missing on PDS), like the pinned PDS's `assertRepoAvailability`. */
  private readonly unavailable = new Map<string, "RepoDeactivated" | "RepoTakendown" | "RepoNotFound">();
  private readonly kemKeys = new Map<string, Promise<P256Keypair>>();
  /** What a DID-document cache holds for each account: stale after `rotateKemKey` until a forced refresh. */
  private readonly publishedKemKeys = new Map<string, string>();
  private readonly spaces = new Map<string, FakeSpace>();
  /** Public repo records (`com.atproto.repo.*`), keyed by repo DID then `collection/rkey`. */
  private readonly publicRecords = new Map<string, Map<string, { value: unknown; cid: string }>>();
  private readonly delegations = new Map<string, { space: string; granteeDid: string }>();
  private readonly credentials = new Map<string, { space: string; grantedDid: string; keyId: string; expiresAt: number }>();
  private tokenCounter = 0;
  private revCounter = 0;
  /** Spaces whose writes reach `listRepos` only on `flushListing`, so a reported revision lags the host. */
  private readonly lagging = new Set<string>();
  private readonly pendingListing = new Map<string, Array<{ did: string; repoRev: string }>>();
  /** Writer DIDs whose host is down: every read of their repo by another account fails. */
  private readonly unreachable = new Set<string>();
  private readonly notifyRegistrations = new Map<string, string>();
  private readonly withheldNotices = new Set<string>();
  /** Per-`(space, repo)` serialization queue so concurrent async mutations never interleave or clobber staged snapshots. */
  private readonly repoLocks = new Map<string, Promise<unknown>>();

  /** Requests served, by XRPC method. */
  readonly calls = new Map<string, number>();
  /** Called for every write notice the authority would send a registered service, unless the space's notices are withheld. */
  onNotifyWrite: ((notice: { space: string; repo: string; service: string }) => void) | undefined;
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

  /** Holds a space's writes back from `listRepos` until `flushListing`, as an authority that has not processed them yet. */
  setListingLag(space: string, lagging: boolean): void {
    if (lagging) this.lagging.add(space);
    else {
      this.lagging.delete(space);
      this.flushListing(space);
    }
  }

  flushListing(space: string): void {
    const target = this.spaces.get(space);
    for (const { did, repoRev } of this.pendingListing.get(space) ?? []) {
      if (target && this.currentlyAuthorizedWriter(target, did)) {
        const data = target.repoRevs.has(did) && !target.deleted ? this.commitFor(target, did).data : new Uint8Array(32);
        target.trackedWriters.set(did, { repoRev, spaceRev: this.nextRev(), data });
      }
    }
    this.pendingListing.delete(space);
  }

  /** Takes a writer's host down (or back up): every other account's read of its repo fails with 503. */
  setHostReachable(did: string, reachable: boolean): void {
    if (reachable) this.unreachable.delete(did);
    else this.unreachable.add(did);
  }

  /** Stops (or resumes) the authority's write notices for a space: a lost notice. */
  withholdNotices(space: string, withheld: boolean): void {
    if (withheld) this.withheldNotices.add(space);
    else this.withheldNotices.delete(space);
  }

  /** Writes a record into `did`'s repo in a space without a client: another app's write, or seeding. */
  async writeAs(did: string, space: string, collection: string, rkey: string, record: Record<string, unknown>): Promise<void> {
    await this.putRecord({ space, repo: did, collection, rkey, record: { $type: collection, ...record } }, { kind: "self", did });
  }

  async deleteAs(did: string, space: string, collection: string, rkey: string): Promise<void> {
    await this.deleteRecord({ space, repo: did, collection, rkey }, { kind: "self", did });
  }

  /** Applies an atomic multi-op batch into `did`'s repo sharing a single `rev`. */
  async applyWritesAs(did: string, space: string, writes: readonly ApplyWriteOp[]) {
    return this.applyWrites({
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
    }, { kind: "self", did });
  }

  /** Clears all records and oplog history for `did` in `space`, preserving `space_repo` with a new signed commit. */
  clearRecordsAs(did: string, space: string): void {
    this.clearRecords({ space, repo: did }, { kind: "self", did });
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
      for await (const chunk of serializeRepo(commit, serialized)) chunks.push(chunk);
      starBytes = concatBytes(chunks);
    }
    await this.importRepo({}, { kind: "self", did }, starBytes);
  }

  /** Simulates PDS oplog pruning/compaction for `(space, repo)`: drops all ops, or ops strictly before `keepFromRev`. */
  pruneOplog(space: string, repo: string, keepFromRev?: string): void {
    const target = this.spaces.get(space);
    if (!target) return;
    if (keepFromRev === undefined) {
      target.oplogs.set(repo, []);
      return;
    }
    const existing = target.oplogs.get(repo) ?? [];
    target.oplogs.set(repo, existing.filter((op) => op.rev >= keepFromRev));
  }

  /** Advances the fake network's clock, used by tests exercising credential expiry and re-notify backoff. */
  advanceClock(ms: number): void {
    this.virtualNow += ms;
  }

  createAccount(did: string, host = "pds1"): void {
    this.accounts.set(did, host);
  }

  /** Deactivates, takes down, or marks missing an account on its PDS: the authority may still issue credentials, while the PDS rejects reads appropriately. */
  setAccountState(did: string, state: "active" | "deactivated" | "takendown" | "missing"): void {
    if (state === "active") this.unavailable.delete(did);
    else if (state === "missing") this.unavailable.set(did, "RepoNotFound");
    else this.unavailable.set(did, state === "deactivated" ? "RepoDeactivated" : "RepoTakendown");
  }

  hasAccount(did: string): boolean {
    return this.accounts.has(did);
  }

  resolvePds = async (did: string): Promise<string> => {
    const host = this.accounts.get(did);
    if (!host) throw new Error(`fake-pds: no account registered for ${did}`);
    return `https://fake-pds.test/${host}`;
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

  private kemKeypair(did: string): Promise<P256Keypair> {
    let key = this.kemKeys.get(did);
    if (!key) {
      key = P256Keypair.create();
      this.kemKeys.set(did, key);
    }
    return key;
  }

  /** Stands in for a self-authenticated OAuth session client (the DM `memberClient`). */
  clientFor(did: string): AtprotoClient {
    if (!this.accounts.has(did)) throw new Error(`fake-pds: no account registered for ${did}`);
    return new AtprotoClient((path, init) => this.respond(path, init, { kind: "self", did }));
  }

  /** Stands in for `deps.fetchEndpoint`: routes a cross-host `Request` by its URL. */
  fetchEndpoint = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = `${url.pathname}${url.search}`;
    const contentType = request.headers.get("content-type") ?? "";
    const body = request.method === "GET" || request.method === "HEAD"
      ? undefined
      : contentType.includes("application/octet-stream")
        ? new Uint8Array(await request.arrayBuffer())
        : await request.text();
    return this.respond(path, { method: request.method, body }, await this.authFromRequest(request.headers), request.headers);
  };

  generateKey = generateSpaceKey;

  /**
   * Authenticates a cross-host request the way the pinned PDS does: only
   * `Atproto-Space-Credential` is a space scheme (any letter case), and it needs
   * the audience header and a tagged signature by the key the credential was
   * bound to when it was minted. The credential exchange itself carries no
   * authorization at all.
   */
  private async authFromRequest(headers: Headers): Promise<FakeAuth> {
    const authorization = headers.get("authorization");
    if (!authorization) return { kind: "none" };
    const [scheme, token] = authorization.split(" ");
    if (scheme?.toLowerCase() === "atproto-space") return rejected(400, "InvalidToken", "Unsupported authorization type");
    if (scheme?.toLowerCase() !== "atproto-space-credential" || !token) return { kind: "none" };
    const credential = this.credentials.get(token);
    const audience = headers.get("atproto-space-audience");
    if (!credential || !audience) return rejected(401, "BadSpaceSignature", "invalid HTTP message signature");
    try {
      await verifyCredentialSig(Object.fromEntries(headers.entries()), credential.keyId as `did:key:${string}`);
    } catch (error) {
      return rejected(401, "BadSpaceSignature", error instanceof Error ? error.message : "invalid HTTP message signature");
    }
    return { kind: "credential", token, audience };
  }

  private async respond(path: string, init: { method?: string; body?: unknown }, auth: FakeAuth, requestHeaders?: Headers): Promise<Response> {
    const url = new URL(path, "https://fake-pds.test");
    const method = url.pathname.replace(/^\/xrpc\//, "");
    const params: Record<string, unknown> = {};
    for (const [key, value] of url.searchParams.entries()) params[key] = value;
    if (typeof init.body === "string" && init.body.length > 0) Object.assign(params, JSON.parse(init.body));
    const rawBody = init.body instanceof Uint8Array ? init.body : undefined;
    this.calls.set(method, (this.calls.get(method) ?? 0) + 1);
    let response: Response;
    if (auth.kind === "rejected") {
      response = errorResponse(auth.error);
    } else if (typeof params.repo === "string" && this.unreachable.has(params.repo) && !(auth.kind === "self" && auth.did === params.repo)) {
      response = errorResponse(new FakeXrpcError(503, "ServiceUnavailable", "The repo host is down."));
    } else {
      try {
        const handled = await this.handle(method, params, auth, requestHeaders, rawBody);
        if (handled instanceof BinaryResponse) {
          const responseBody: BodyInit = handled.body instanceof Uint8Array ? new Uint8Array(handled.body) : handled.body;
          response = new Response(responseBody, {
            status: 200,
            headers: { "content-type": handled.contentType, ...handled.headers },
          });
        } else {
          const [body, headers] = handled instanceof WithHeaders ? [handled.body, handled.headers] : [handled, {}];
          response = new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });
        }
      } catch (error) {
        if (error instanceof FakeXrpcError) response = errorResponse(error);
        else throw error;
      }
    }
    return this.interceptResponse ? this.interceptResponse({ method, params, response }) : response;
  }

  private async handle(
    method: string,
    params: Record<string, unknown>,
    auth: FakeAuth,
    requestHeaders: Headers | undefined,
    rawBody?: Uint8Array,
  ): Promise<unknown> {
    switch (method) {
      case "com.atproto.repo.putRecord": return this.putPublicRecord(params, auth);
      case "com.atproto.repo.getRecord": return this.getPublicRecord(params);
      case "com.atproto.space.getDelegationToken": return this.getDelegationToken(params, auth);
      case "com.atproto.space.getSpaceCredential": return this.getSpaceCredential(params);
      case "com.atproto.space.createSpace": return this.createSpace(params, auth);
      case "com.atproto.space.updateSpace": return this.updateSpace(params, auth);
      case "com.atproto.space.getSpace": return this.getSpace(params, auth);
      case "com.atproto.memberspace.putMember": return this.putMember(params, auth);
      case "com.atproto.memberspace.removeMember": return this.removeMember(params, auth);
      case "com.atproto.space.deleteSpace": return this.deleteSpace(params, auth);
      case "com.atproto.memberspace.listMembers": return this.listMembers(params, auth);
      case "com.atproto.space.listSpaces": return this.listSpaces(params, auth);
      case "com.atproto.space.putRecord": return this.putRecord(params, auth);
      case "com.atproto.space.createRecord": return this.createRecord(params, auth);
      case "com.atproto.space.applyWrites": return this.applyWrites(params, auth);
      case "com.atproto.space.clearRecords": return this.clearRecords(params, auth);
      case "com.atproto.space.importRepo": return this.importRepo(params, auth, rawBody);
      case "com.atproto.server.getServiceAuth": return this.getServiceAuth(params, auth);
      case "com.atproto.space.deleteRecord": return this.deleteRecord(params, auth);
      case "com.atproto.space.getRecord": return this.getRecord(params, auth, requestHeaders);
      case "com.atproto.space.getLatestCommit": return this.getLatestCommit(params, auth, requestHeaders);
      case "com.atproto.space.getRepo": return this.getRepo(params, auth, requestHeaders);
      case "com.atproto.space.listRecords": return this.listRecords(params, auth);
      case "com.atproto.space.listRepoOps": return this.listRepoOps(params, auth, requestHeaders);
      case "com.atproto.space.listRepos": return this.listRepos(params, auth);
      case "com.atproto.space.registerNotify": return this.registerNotify(params, auth);
      default: throw new FakeXrpcError(501, "MethodNotImplemented", `fake-pds does not implement ${method}`);
    }
  }

  private requireSelf(auth: FakeAuth): string {
    if (auth.kind !== "self") throw new FakeXrpcError(401, "AuthenticationRequired");
    return auth.did;
  }

  private requireSpace(uri: unknown): FakeSpace {
    if (typeof uri !== "string" || !this.spaces.has(uri)) throw new FakeXrpcError(400, "SpaceNotFound", "Space not found");
    return this.spaces.get(uri)!;
  }

  private requireOwner(space: FakeSpace, did: string): void {
    if (space.ownerDid !== did) throw new FakeXrpcError(400, "NotSpaceOwner", "Not the space owner");
  }

  private requireMemberspace(space: FakeSpace): void {
    if (space.policy.$type !== MEMBERSPACE_POLICY) throw new FakeXrpcError(400, "PolicyMismatch", "The space is not governed by the memberspace policy.");
  }

  private getDelegationToken(params: Record<string, unknown>, auth: FakeAuth): { token: string } {
    const granteeDid = this.requireSelf(auth);
    const space = String(params.space);
    const token = `delegation-${this.tokenCounter++}`;
    this.delegations.set(token, { space, granteeDid });
    return { token };
  }

  /**
   * The exchange is authenticated by its body alone. A deleted space answers
   * `SpaceDeleted` first, then the user is checked: a user the policy does not
   * authorize (or no user, for a space that is not publicly readable) gets
   * `SpaceNotFound`, so a refusal discloses nothing about the space.
   */
  private getSpaceCredential(params: Record<string, unknown>): { credential: string } {
    const credentialKid = params.credentialKid;
    if (typeof credentialKid !== "string" || !isP256DidKey(credentialKid)) throw new FakeXrpcError(400, "InvalidRequest", "credentialKid must be a P-256 did:key");
    let userDid: string | undefined;
    if (typeof params.delegationToken === "string") {
      const delegation = this.delegations.get(params.delegationToken);
      if (!delegation || delegation.space !== params.space) throw new FakeXrpcError(400, "InvalidDelegationToken", "Delegation token subject does not match requested space");
      userDid = delegation.granteeDid;
    }
    const space = typeof params.space === "string" ? this.spaces.get(params.space) : undefined;
    if (space?.deleted) throw new FakeXrpcError(400, "SpaceDeleted", "Space has been deleted");
    if (!space) throw new FakeXrpcError(400, "SpaceNotFound", "Space not found");
    const authorized = userDid === undefined
      ? space.policy.publicRead
      : userDid === space.ownerDid || space.policy.publicRead || space.members.get(userDid)?.read === true;
    if (!authorized) throw new FakeXrpcError(400, "SpaceNotFound", "Space not found");
    const token = `credential-${this.tokenCounter++}`;
    this.credentials.set(token, { space: String(params.space), grantedDid: userDid ?? "", keyId: credentialKid, expiresAt: this.now() + SPACE_CREDENTIAL_LIFETIME_MS });
    return { credential: token };
  }

  private createSpace(params: Record<string, unknown>, auth: FakeAuth): { uri: string } {
    const ownerDid = this.requireSelf(auth);
    const type = String(params.spaceType);
    const skey = typeof params.skey === "string" ? params.skey : fakeTid(++this.revCounter);
    const uri = `at://${ownerDid}/space/${type}/${skey}`;
    const existing = this.spaces.get(uri);
    if (existing && !existing.deleted) throw new FakeXrpcError(400, "SpaceAlreadyExists", "Space already exists");
    this.spaces.set(uri, {
      type, skey, ownerDid,
      policy: toStoredPolicy(params.policy),
      members: new Map(), trackedWriters: new Map(), repoRevs: new Map(), deleted: false, repos: new Map(), oplogs: new Map(),
    });
    return { uri };
  }

  /** Replaces the whole policy. A different `$type` migrates the space and discards the member list; the writer set is not re-evaluated. */
  private updateSpace(params: Record<string, unknown>, auth: FakeAuth): Record<string, never> {
    const did = this.requireSelf(auth);
    const space = this.requireSpace(params.space);
    this.requireOwner(space, did);
    const next = toStoredPolicy(params.policy);
    if (next.$type !== space.policy.$type) space.members.clear();
    space.policy = next;
    return {};
  }

  private getSpace(params: Record<string, unknown>, auth: FakeAuth) {
    const did = this.requireSelf(auth);
    const space = this.requireSpace(params.space);
    this.requireOwner(space, did);
    const { $type, ...settings } = space.policy;
    return { uri: params.space as string, policy: $type === MEMBERSPACE_POLICY ? { $type, ...settings } : { $type } };
  }

  private putMember(params: Record<string, unknown>, auth: FakeAuth): Record<string, never> {
    const did = this.requireSelf(auth);
    const space = this.requireSpace(params.space);
    this.requireOwner(space, did);
    this.requireMemberspace(space);
    const write = Boolean(params.write);
    space.members.set(String(params.did), { read: Boolean(params.read), write });
    if (!write) space.trackedWriters.delete(String(params.did));
    return {};
  }

  private removeMember(params: Record<string, unknown>, auth: FakeAuth): Record<string, never> {
    const did = this.requireSelf(auth);
    const space = this.requireSpace(params.space);
    this.requireOwner(space, did);
    this.requireMemberspace(space);
    space.members.delete(String(params.did));
    space.trackedWriters.delete(String(params.did));
    return {};
  }

  private deleteSpace(params: Record<string, unknown>, auth: FakeAuth): Record<string, never> {
    const did = this.requireSelf(auth);
    const space = this.requireSpace(params.space);
    this.requireOwner(space, did);
    space.deleted = true;
    return {};
  }

  private listMembers(params: Record<string, unknown>, auth: FakeAuth) {
    const did = this.requireSelf(auth);
    const space = this.requireSpace(params.space);
    this.requireOwner(space, did);
    this.requireMemberspace(space);
    const all = [...space.members.entries()].map(([memberDid, access]) => ({ did: memberDid, ...access }));
    return paginate(all, params, (member) => member.did, "members");
  }

  /** Spaces the caller is the authority of or holds a repo in, as the reference PDS lists them. */
  private listSpaces(params: Record<string, unknown>, auth: FakeAuth) {
    const did = this.requireSelf(auth);
    const all = [...this.spaces.values()]
      .filter((space) => !space.deleted && (space.ownerDid === did || space.repoRevs.has(did)))
      .filter((space) => params.spaceType === undefined || space.type === params.spaceType)
      .filter((space) => params.did === undefined || space.ownerDid === params.did)
      .map((space) => ({ uri: `at://${space.ownerDid}/space/${space.type}/${space.skey}` }));
    return paginate(all, params, (space) => space.uri, "spaces");
  }

  /** A record in the account's ordinary public repo (outside any space), writable only by its owner. */
  private async putPublicRecord(params: Record<string, unknown>, auth: FakeAuth) {
    const did = this.requireSelf(auth);
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

  private async putRecordUnlocked(params: Record<string, unknown>, did: string) {
    const repo = String(params.repo);
    const collection = String(params.collection);
    const rkey = String(params.rkey);
    const record = params.record as Record<string, unknown>;
    // The host stores a record in its Lexicon form (`$link` and `$bytes` objects become CIDs and bytes) and answers in JSON,
    // so the CID covers the Lexicon form.
    const { cid } = await serializeRecord(collection as `${string}.${string}.${string}`, rkey as never, jsonToLex(record as Parameters<typeof jsonToLex>[0]) as never);
    if (typeof params.space === "string" && params.space.startsWith(`at://${did}/`) && (!this.spaces.has(params.space) || this.spaces.get(params.space)!.deleted)) {
      throw new FakeXrpcError(400, "SpaceNotFound", "Space not found");
    }
    if (typeof params.space !== "string" || !this.spaces.has(params.space) || this.spaces.get(params.space)!.deleted) {
      // Writing into another authority's space stores the record in the writer's own repo without asking the authority.
      return { uri: `${String(params.space)}/${repo}/${collection}/${rkey}`, cid: cid.toString() };
    }
    const space = this.requireSpace(params.space);
    const repoCollections = this.repoCollections(space, repo);
    const records = repoCollections.get(collection) ?? new Map<string, RecordEntry>();
    repoCollections.set(collection, records);
    const prev = records.get(rkey)?.cid.toString() ?? null;
    records.set(rkey, { value: record, cid });
    const rev = this.nextRev();
    space.repoRevs.set(repo, rev);
    this.repoOplog(space, repo).push({ rev, idx: 0, collection, rkey, cid: cid.toString(), prev });
    this.recordWrite(space, repo);
    return { uri: `${spaceUri(space)}/${repo}/${collection}/${rkey}`, cid: cid.toString() };
  }

  private async putRecord(params: Record<string, unknown>, auth: FakeAuth) {
    const did = this.requireSelf(auth);
    const repo = String(params.repo);
    if (repo !== did) throw new FakeXrpcError(400, "UserNotAuthorized", "Can only write to your own repo");
    return this.withRepoLock(String(params.space ?? ""), repo, () => this.putRecordUnlocked(params, did));
  }

  /** Like `putRecord`, but a record already at that key is refused, as the pinned PDS's `createRecord` does. */
  private async createRecord(params: Record<string, unknown>, auth: FakeAuth) {
    const did = this.requireSelf(auth);
    const repo = String(params.repo);
    if (repo !== did) throw new FakeXrpcError(400, "UserNotAuthorized", "Can only write to your own repo");
    return this.withRepoLock(String(params.space ?? ""), repo, () => {
      const space = typeof params.space === "string" ? this.spaces.get(params.space) : undefined;
      const rkey = typeof params.rkey === "string" ? params.rkey : fakeTid(++this.revCounter);
      if (space && !space.deleted && space.repos.get(repo)?.get(String(params.collection))?.has(rkey)) {
        throw new FakeXrpcError(400, "RecordAlreadyExists", "Record already exists");
      }
      return this.putRecordUnlocked({ ...params, rkey }, did);
    });
  }

  private async applyWrites(params: Record<string, unknown>, auth: FakeAuth) {
    const did = this.requireSelf(auth);
    const repo = String(params.repo);
    if (repo !== did) throw new FakeXrpcError(403, "Forbidden", "repo must match authenticated user");
    return this.withRepoLock(String(params.space ?? ""), repo, async () => {
      const space = this.requireSpace(params.space);
      if (space.deleted) throw new FakeXrpcError(400, "SpaceNotFound", "Space not found");
      const writes = Array.isArray(params.writes) ? (params.writes as Array<Record<string, unknown>>) : [];
      if (writes.length > 200) throw new FakeXrpcError(400, "InvalidRequest", "Too many writes. Max: 200");
      if (writes.length === 0) return { results: [] };

      const existingCollections = space.repos.get(repo);
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
          uri: `${spaceUri(space)}/${repo}/${collection}/${rkey}`,
          cid: cid.toString(),
        });
      }

      space.repos.set(repo, staged);
      space.repoRevs.set(repo, rev);
      this.repoOplog(space, repo).push(...ops);
      this.recordWrite(space, repo);
      return { results };
    });
  }

  private clearRecords(params: Record<string, unknown>, auth: FakeAuth): Record<string, never> | Promise<Record<string, never>> {
    const did = this.requireSelf(auth);
    const repo = String(params.repo);
    if (repo !== did) throw new FakeXrpcError(403, "Forbidden", "repo must match authenticated user");
    return this.withRepoLock(String(params.space ?? ""), repo, () => {
      const space = this.requireSpace(params.space);
      if (space.deleted) throw new FakeXrpcError(400, "SpaceNotFound", "Space not found");
      if (space.repoRevs.has(repo)) {
        space.repos.get(repo)?.clear();
        space.oplogs.set(repo, []);
        space.repoRevs.set(repo, this.nextRev());
        this.recordWrite(space, repo);
      }
      return {};
    });
  }

  private async importRepo(_params: Record<string, unknown>, auth: FakeAuth, rawBody?: Uint8Array): Promise<Record<string, never>> {
    const did = this.requireSelf(auth);
    if (!rawBody) throw new FakeXrpcError(400, "InvalidRequest", "STAR archive body is required");
    let parsed: Awaited<ReturnType<typeof readRepoStar>>;
    try {
      parsed = await readRepoStar([rawBody]);
    } catch (error) {
      throw new FakeXrpcError(400, "InvalidRequest", error instanceof Error ? error.message : "Invalid STAR archive");
    }
    try {
      if (parsed.commit.repo !== did) throw new FakeXrpcError(400, "InvalidRequest", "Repo does not match the authenticated account");
      return await this.withRepoLock(parsed.commit.space, did, async () => {
        const space = this.requireSpace(parsed.commit.space);
        if (space.deleted) throw new FakeXrpcError(400, "SpaceNotFound", "Space not found");
        const imported = new Map<string, Map<string, RecordEntry>>();
        for await (const entry of parsed.records) {
          let col = imported.get(entry.collection);
          if (!col) imported.set(entry.collection, col = new Map());
          col.set(entry.rkey, { value: lexToJson(entry.record) as Record<string, unknown>, cid: entry.cid });
        }
        space.repos.set(did, imported);
        space.oplogs.set(did, []);
        space.repoRevs.set(did, this.nextRev());
        return {};
      });
    } catch (error) {
      if (error instanceof FakeXrpcError) throw error;
      throw new FakeXrpcError(400, "InvalidRequest", error instanceof Error ? error.message : "Invalid STAR archive");
    } finally {
      await parsed.records.return?.(undefined).catch(() => undefined);
    }
  }

  /**
   * A service token for `aud` and `lxm`, as the caller's own PDS issues one. The token is readable by `readServiceToken`
   * instead of being a signed JWT; the fake operator a test runs trusts the network that issued it.
   */
  private getServiceAuth(params: Record<string, unknown>, auth: FakeAuth): { token: string } {
    const did = this.requireSelf(auth);
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

  private deleteRecord(params: Record<string, unknown>, auth: FakeAuth): Record<string, never> | Promise<Record<string, never>> {
    const did = this.requireSelf(auth);
    const repo = String(params.repo);
    if (repo !== did) throw new FakeXrpcError(400, "UserNotAuthorized", "Can only delete from your own repo");
    return this.withRepoLock(String(params.space ?? ""), repo, () => {
      const space = this.requireSpace(params.space);
      const collection = String(params.collection);
      const rkey = String(params.rkey);
      const entries = space.repos.get(repo)?.get(collection);
      const existing = entries?.get(rkey);
      entries?.delete(rkey);
      const rev = this.nextRev();
      if (existing) {
        this.repoOplog(space, repo).push({ rev, idx: 0, collection, rkey, cid: null, prev: existing.cid.toString() });
        space.repoRevs.set(repo, rev);
        this.recordWrite(space, repo);
      } else if (space.repoRevs.has(repo)) {
        space.repoRevs.set(repo, rev);
        this.recordWrite(space, repo);
      }
      return {};
    });
  }

  /** What the authority learns of a write: the writer set moves (now, or on `flushListing`) and registered services are told. */
  private recordWrite(space: FakeSpace, repo: string): void {
    const uri = spaceUri(space);
    if (!this.currentlyAuthorizedWriter(space, repo)) return;
    const repoRev = space.repoRevs.get(repo)!;
    const data = this.commitFor(space, repo).data;
    if (this.lagging.has(uri)) {
      const pending = this.pendingListing.get(uri) ?? [];
      pending.push({ did: repo, repoRev });
      this.pendingListing.set(uri, pending);
    } else {
      space.trackedWriters.set(repo, { repoRev, spaceRev: this.nextRev(), data });
    }
    const service = this.notifyRegistrations.get(uri);
    if (service && !this.withheldNotices.has(uri)) this.onNotifyWrite?.({ space: uri, repo, service });
  }

  private requireCredential(params: Record<string, unknown>, auth: FakeAuth): string {
    if (auth.kind !== "credential") throw new FakeXrpcError(401, "MissingJwt", "missing space credential");
    const credential = this.credentials.get(auth.token);
    if (!credential || credential.space !== params.space) throw new FakeXrpcError(403, "UserNotAuthorized", "credential does not authorize this space");
    if (credential.expiresAt <= this.now()) throw new FakeXrpcError(401, "ExpiredToken", "space credential expired");
    const audience = typeof params.repo === "string" ? params.repo : this.requireSpace(params.space).ownerDid;
    if (auth.audience !== audience) throw new FakeXrpcError(401, "BadSpaceAudience", "space audience does not match the request");
    return credential.grantedDid;
  }

  /**
   * The shared secret for a MAC-bearing read. A credential must ask for a MAC
   * (`BadSpaceMac` otherwise); the secret is derived against the repo author's
   * *current* `#atproto_kem` key, so a syncer holding a rotated-away key gets a
   * MAC it cannot verify.
   */
  private async macSecret(method: string, repo: string, requestHeaders: Headers | undefined): Promise<Uint8Array> {
    const type = MAC_METHODS[method]!;
    try {
      const keyShare = parseWantMacHeader(requestHeaders?.get(WANT_MAC_HEADER) ?? undefined, type);
      return decapsulate(await this.kemKeypair(repo), keyShare);
    } catch (error) {
      if (error instanceof SpaceMacError) throw new FakeXrpcError(400, "BadSpaceMac", error.message);
      throw error;
    }
  }

  /** An account reading its own repo with its own OAuth session: no credential, and a MAC only if it asks for one. */
  private isOwnRead(params: Record<string, unknown>, auth: FakeAuth): boolean {
    return auth.kind === "self" && params.repo === auth.did;
  }

  private assertRepoAvailability(repo: string, own: boolean): void {
    if (!this.accounts.has(repo)) throw new FakeXrpcError(400, "RepoNotFound", `Could not find repo for DID: ${repo}`);
    const state = this.unavailable.get(repo);
    if (state === "RepoNotFound") throw new FakeXrpcError(400, "RepoNotFound", `Could not find repo for DID: ${repo}`);
    if (state && !own) throw new FakeXrpcError(400, state, `Repo is not available: ${repo}`);
  }

  private async getRecord(params: Record<string, unknown>, auth: FakeAuth, requestHeaders: Headers | undefined): Promise<WithHeaders> {
    const own = this.isOwnRead(params, auth);
    if (!own) this.requireCredential(params, auth);
    this.assertRepoAvailability(String(params.repo), own);
    const space = this.requireSpace(params.space);
    const repo = String(params.repo);
    const collection = String(params.collection);
    const rkey = String(params.rkey);
    const sharedSecret = own && !requestHeaders?.has(WANT_MAC_HEADER) ? undefined : await this.macSecret("com.atproto.space.getRecord", repo, requestHeaders);
    const record = space.deleted ? undefined : space.repos.get(repo)?.get(collection)?.get(rkey);
    if (!record) throw new FakeXrpcError(400, "RecordNotFound", "Record not found");
    const uri = `${spaceUri(space)}/${repo}/${collection}/${rkey}`;
    return new WithHeaders(
      { uri, cid: record.cid.toString(), value: record.value },
      sharedSecret ? macHeaders(formatMacHeader(RECORD_MAC_TYPE, computeRecordMac(sharedSecret, uri, record.cid))) : {},
    );
  }

  private async getLatestCommit(params: Record<string, unknown>, auth: FakeAuth, requestHeaders: Headers | undefined): Promise<WithHeaders> {
    await this.beforeGetLatestCommit?.({ space: String(params.space), repo: String(params.repo) });
    const own = this.isOwnRead(params, auth);
    if (!own) this.requireCredential(params, auth);
    this.assertRepoAvailability(String(params.repo), own);
    const space = this.requireSpace(params.space);
    const repo = String(params.repo);
    const sharedSecret = own && !requestHeaders?.has(WANT_MAC_HEADER) ? undefined : await this.macSecret("com.atproto.space.getLatestCommit", repo, requestHeaders);
    const commit = this.commitFor(space, repo);
    return new WithHeaders(
      { commit: commitJson(commit) },
      sharedSecret ? macHeaders(formatMacHeader(COMMIT_MAC_TYPE, computeCommitMac(sharedSecret, commit))) : {},
    );
  }

  private async getRepo(params: Record<string, unknown>, auth: FakeAuth, requestHeaders: Headers | undefined): Promise<BinaryResponse> {
    await this.beforeGetRepo?.({ space: String(params.space), repo: String(params.repo) });
    const own = this.isOwnRead(params, auth);
    if (!own) this.requireCredential(params, auth);
    this.assertRepoAvailability(String(params.repo), own);
    const space = this.requireSpace(params.space);
    const repo = String(params.repo);
    const sharedSecret = own && !requestHeaders?.has(WANT_MAC_HEADER) ? undefined : await this.macSecret("com.atproto.space.getRepo", repo, requestHeaders);
    const commit = this.commitFor(space, repo);

    const encoder = new TextEncoder();
    const entries: Array<{ keyBytes: Uint8Array; collection: string; rkey: string; value: Record<string, unknown> }> = [];
    for (const [collection, records] of space.repos.get(repo) ?? []) {
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
    const generator = serializeRepo(commit, serialized);
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
    return new BinaryResponse(
      stream,
      sharedSecret ? macHeaders(formatMacHeader(COMMIT_MAC_TYPE, computeCommitMac(sharedSecret, commit))) : { vary: WANT_MAC_HEADER },
    );
  }

  private commitFor(space: FakeSpace, repo: string) {
    const rev = space.repoRevs.get(repo);
    if (space.deleted || !rev) throw new FakeXrpcError(400, "RepoNotFound", "Repo not found");
    const records = [...(space.repos.get(repo) ?? [])].flatMap(([collection, entries]) =>
      [...entries].map(([rkey, entry]) => ({ collection: collection as never, rkey: rkey as never, cid: entry.cid })));
    return RepoCommit.fromRecords(records).toCommit({ space: spaceUri(space) as never, repo: repo as never, rev });
  }

  private async listRecords(params: Record<string, unknown>, auth: FakeAuth) {
    const collection = typeof params.collection === "string" ? params.collection : undefined;
    const excludeValues = params.excludeValues === true || params.excludeValues === "true";
    const reverse = params.reverse === true || params.reverse === "true";
    await this.beforeListRecords?.({
      space: String(params.space),
      repo: String(params.repo),
      ...(collection !== undefined ? { collection } : {}),
      excludeValues,
      ...(typeof params.cursor === "string" ? { cursor: params.cursor } : {}),
    });
    // An account listing its own repo with its own OAuth session needs no credential, as on the pinned PDS.
    const own = this.isOwnRead(params, auth);
    if (!own) this.requireCredential(params, auth);
    this.assertRepoAvailability(String(params.repo), own);
    const space = this.requireSpace(params.space);
    const repo = String(params.repo);
    const prefix = `${spaceUri(space)}/${repo}`;
    const all: Array<{ uri: string; collection: string; rkey: string; entry: RecordEntry }> = [];
    if (!space.deleted) {
      const collections = space.repos.get(repo);
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
    }
    all.sort((left, right) => (reverse ? compareLex(left.uri, right.uri) : compareLex(right.uri, left.uri)));
    const cursor = typeof params.cursor === "string" ? params.cursor : undefined;
    const filtered = cursor ? all.filter((item) => (reverse ? item.uri > cursor : item.uri < cursor)) : all;
    const limit = clampLimit(params.limit, 100, 1000);
    const page = filtered.slice(0, limit);
    // Like the pinned PDS's listRecords, a full page carries a cursor even when nothing follows it.
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
    const own = this.isOwnRead(params, auth);
    if (!own) this.requireCredential(params, auth);
    this.assertRepoAvailability(String(params.repo), own);
    const space = this.requireSpace(params.space);
    const repo = String(params.repo);
    const sharedSecret = own && !requestHeaders?.has(WANT_MAC_HEADER) ? undefined : await this.macSecret("com.atproto.space.listRepoOps", repo, requestHeaders);
    const cursor = cursorStr !== undefined ? parseRepoOpsCursor(cursorStr) : undefined;

    const allOps = space.deleted ? [] : (space.oplogs.get(repo) ?? []);
    const filtered = allOps.filter((op) => {
      if (since !== undefined && op.rev <= since) return false;
      if (cursor !== undefined && !(op.rev > cursor.rev || (op.rev === cursor.rev && op.idx > cursor.idx))) return false;
      return true;
    });
    const page = filtered.slice(0, limit);
    const collections = space.repos.get(repo);
    const ops = page.map((op) => {
      const live = space.deleted ? undefined : collections?.get(op.collection)?.get(op.rkey);
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

    if (ops.length === limit) {
      const last = page[page.length - 1]!;
      return new WithHeaders(
        { ops, cursor: `${last.rev}/${last.idx}` },
        { vary: WANT_MAC_HEADER },
      );
    }

    const rev = space.repoRevs.get(repo);
    if (space.deleted || !rev) {
      return new WithHeaders({ ops: [] }, { vary: WANT_MAC_HEADER });
    }
    const commit = this.commitFor(space, repo);
    return new WithHeaders(
      { ops, commit: commitJson(commit) },
      sharedSecret ? macHeaders(formatMacHeader(COMMIT_MAC_TYPE, computeCommitMac(sharedSecret, commit))) : { vary: WANT_MAC_HEADER },
    );
  }

  private listRepos(params: Record<string, unknown>, auth: FakeAuth) {
    this.requireCredential(params, auth);
    const space = this.requireSpace(params.space);
    const limit = typeof params.limit === "number" ? params.limit : Number(params.limit ?? 100) || 100;
    const after = typeof params.cursor === "string" ? params.cursor : "";
    const updated = [...space.trackedWriters]
      .map(([did, entry]) => ({ did, repoRev: entry.repoRev, spaceRev: entry.spaceRev, data: { $bytes: toBase64(entry.data) } }))
      .filter((repo) => repo.spaceRev > after)
      .sort((left, right) => compareLex(left.spaceRev, right.spaceRev));
    const repos = updated.slice(0, limit);
    return { repos, ...(repos.length > 0 ? { cursor: repos[repos.length - 1]!.spaceRev } : {}) };
  }

  private registerNotify(params: Record<string, unknown>, auth: FakeAuth): { expiresAt: string } {
    this.requireCredential(params, auth);
    this.requireSpace(params.space);
    this.notifyRegistrations.set(String(params.space), String(params.service));
    return { expiresAt: new Date(this.now() + NOTIFY_REGISTRATION_TTL_MS).toISOString() };
  }

  private nextRev(): string {
    return fakeTid(++this.revCounter);
  }

  private repoCollections(space: FakeSpace, repo: string): Map<string, Map<string, RecordEntry>> {
    let collections = space.repos.get(repo);
    if (!collections) {
      collections = new Map();
      space.repos.set(repo, collections);
    }
    return collections;
  }

  private repoOplog(space: FakeSpace, repo: string): FakeRepoOp[] {
    let oplog = space.oplogs.get(repo);
    if (!oplog) {
      oplog = [];
      space.oplogs.set(repo, oplog);
    }
    return oplog;
  }

  private currentlyAuthorizedWriter(space: FakeSpace, did: string): boolean {
    return did === space.ownerDid || space.policy.publicWrite || space.members.get(did)?.write === true;
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
  if (slash <= 0) throw new FakeXrpcError(400, "MalformedCursor", "Malformed cursor");
  const rev = cursor.slice(0, slash);
  const idxStr = cursor.slice(slash + 1);
  if (!/^\d+$/.test(idxStr)) throw new FakeXrpcError(400, "MalformedCursor", "Malformed cursor");
  return { rev, idx: Number(idxStr) };
}

function spaceUri(space: FakeSpace): string {
  return `at://${space.ownerDid}/space/${space.type}/${space.skey}`;
}

/** The two baseline policies the fake implements; any other is refused like the reference PDS does. */
function toStoredPolicy(policy: unknown): FakeSpace["policy"] {
  const fields = (policy ?? {}) as { $type?: unknown; publicRead?: unknown; publicWrite?: unknown; allowedApps?: unknown; publishPolicy?: unknown; publishMembers?: unknown };
  if (fields.$type === MEMBERSPACE_POLICY) {
    return {
      $type: MEMBERSPACE_POLICY, publicRead: fields.publicRead === true, publicWrite: fields.publicWrite === true,
      ...(Array.isArray(fields.allowedApps) ? { allowedApps: fields.allowedApps.filter((app): app is string => typeof app === "string") } : {}),
      ...(fields.publishPolicy === true ? { publishPolicy: true } : {}),
      ...(fields.publishMembers === true ? { publishMembers: true } : {}),
    };
  }
  if (fields.$type === PERSONALSPACE_POLICY) return { $type: PERSONALSPACE_POLICY, publicRead: false, publicWrite: false };
  throw new FakeXrpcError(400, "UnsupportedPolicy", "The requested policy is not one the host implements.");
}

function commitJson(commit: { ver: number; repo: string; space: string; rev: string; data: Uint8Array }) {
  return { ver: commit.ver, repo: commit.repo, space: commit.space, rev: commit.rev, data: { $bytes: toBase64(commit.data) } };
}

function paginate<T>(
  all: T[],
  params: Record<string, unknown>,
  key: (item: T) => string,
  field: string,
  options: { cursorOnFullPage?: boolean } = {},
): Record<string, unknown> {
  const limit = typeof params.limit === "number" ? params.limit : Number(params.limit ?? 100) || 100;
  const cursor = typeof params.cursor === "string" ? params.cursor : undefined;
  const startIndex = cursor ? all.findIndex((item) => key(item) === cursor) + 1 : 0;
  const page = all.slice(startIndex, startIndex + limit);
  const nextIndex = startIndex + page.length;
  const more = nextIndex < all.length || (options.cursorOnFullPage === true && page.length > 0 && page.length === limit);
  return { [field]: page, ...(more ? { cursor: key(page[page.length - 1]!) } : {}) };
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
    status: error.status, headers: { "content-type": "application/json" },
  });
}

function rejected(status: number, code: string, message: string): FakeAuth {
  return { kind: "rejected", error: new FakeXrpcError(status, code, message) };
}
