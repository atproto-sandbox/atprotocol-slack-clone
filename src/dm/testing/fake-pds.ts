import { P256Keypair } from "@atproto/crypto";
import { toBase64 } from "@atproto/lex-data";
import { jsonToLex } from "@atproto/lexicon";
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
  serializeRecord,
  verifyCredentialSig,
  type MacType,
} from "@atproto/space";
import { SPACE_CREDENTIAL_LIFETIME_MS } from "@/atproto/space-credential-core";
import { generateSpaceKey } from "@/atproto/space-key";
import { MEMBERSPACE_POLICY } from "@/atproto/space-policy";
import { AtprotoClient } from "@/atproto/xrpc";

/**
 * An in-memory, multi-host fake of the DM-relevant slice of the pinned PDS
 * protocol. Test-only: production code (`dm-client.ts`) never imports this.
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

type FakeSpace = {
  type: string;
  skey: string;
  ownerDid: string;
  policy: { $type: string; publicRead: boolean; publicWrite: boolean; allowedApps?: string[]; publishPolicy?: boolean; publishMembers?: boolean };
  members: Map<string, { read: boolean; write: boolean }>;
  trackedWriters: Map<string, { repoRev: string; spaceRev: string }>;
  repoRevs: Map<string, string>;
  deleted: boolean;
  repos: Map<string, Map<string, Map<string, RecordEntry>>>;
};

type FakeAuth =
  | { kind: "self"; did: string }
  | { kind: "credential"; token: string; audience: string }
  | { kind: "none" }
  | { kind: "rejected"; error: FakeXrpcError };

const NOTIFY_REGISTRATION_TTL_MS = 24 * 60 * 60 * 1000;

const MAC_METHODS: Readonly<Record<string, MacType>> = {
  "com.atproto.space.getRecord": RECORD_MAC_TYPE,
  "com.atproto.space.getLatestCommit": COMMIT_MAC_TYPE,
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

export class FakeDmNetwork {
  private virtualNow = Date.now();

  private readonly accounts = new Map<string, string>();
  /** Accounts whose repo the host refuses to serve to anyone but the account itself, like the pinned PDS's `assertRepoAvailability`. */
  private readonly unavailable = new Map<string, "RepoDeactivated" | "RepoTakendown">();
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

  now = (): number => this.virtualNow;

  /** Advances the fake network's clock, used by tests exercising credential expiry and re-notify backoff. */
  advanceClock(ms: number): void {
    this.virtualNow += ms;
  }

  createAccount(did: string, host = "pds1"): void {
    this.accounts.set(did, host);
  }

  /** Deactivates or takes down an account: the authority still issues credentials for it, but its host refuses every other account's read of its repos. */
  setAccountState(did: string, state: "active" | "deactivated" | "takendown"): void {
    if (state === "active") this.unavailable.delete(did);
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
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
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
    if (auth.kind === "rejected") return errorResponse(auth.error);
    try {
      const handled = await this.handle(method, params, auth, requestHeaders);
      const [body, headers] = handled instanceof WithHeaders ? [handled.body, handled.headers] : [handled, {}];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });
    } catch (error) {
      if (error instanceof FakeXrpcError) return errorResponse(error);
      throw error;
    }
  }

  private async handle(method: string, params: Record<string, unknown>, auth: FakeAuth, requestHeaders: Headers | undefined): Promise<unknown> {
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
      case "com.atproto.space.deleteRecord": return this.deleteRecord(params, auth);
      case "com.atproto.space.getRecord": return this.getRecord(params, auth, requestHeaders);
      case "com.atproto.space.getLatestCommit": return this.getLatestCommit(params, auth, requestHeaders);
      case "com.atproto.space.listRecords": return this.listRecords(params, auth);
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
      members: new Map(), trackedWriters: new Map(), repoRevs: new Map(), deleted: false, repos: new Map(),
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
      .filter((space) => !space.deleted && (space.ownerDid === did || space.repos.has(did)))
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

  private async putRecord(params: Record<string, unknown>, auth: FakeAuth) {
    const did = this.requireSelf(auth);
    const repo = String(params.repo);
    if (repo !== did) throw new FakeXrpcError(400, "UserNotAuthorized", "Can only write to your own repo");
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
    records.set(rkey, { value: record, cid });
    space.repoRevs.set(repo, this.nextRev());
    if (this.currentlyAuthorizedWriter(space, repo)) space.trackedWriters.set(repo, { repoRev: space.repoRevs.get(repo)!, spaceRev: this.nextRev() });
    return { uri: `${spaceUri(space)}/${repo}/${collection}/${rkey}`, cid: cid.toString() };
  }

  private deleteRecord(params: Record<string, unknown>, auth: FakeAuth): Record<string, never> {
    const did = this.requireSelf(auth);
    const repo = String(params.repo);
    if (repo !== did) throw new FakeXrpcError(400, "UserNotAuthorized", "Can only delete from your own repo");
    const space = this.requireSpace(params.space);
    this.repoCollections(space, repo).get(String(params.collection))?.delete(String(params.rkey));
    space.repoRevs.set(repo, this.nextRev());
    return {};
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
    const state = this.unavailable.get(repo);
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
    const record = space.deleted ? undefined : this.repoCollections(space, repo).get(collection)?.get(rkey);
    if (!record) throw new FakeXrpcError(400, "RecordNotFound", "Record not found");
    const uri = `${spaceUri(space)}/${repo}/${collection}/${rkey}`;
    return new WithHeaders(
      { uri, cid: record.cid.toString(), value: record.value },
      sharedSecret ? macHeaders(formatMacHeader(RECORD_MAC_TYPE, computeRecordMac(sharedSecret, uri, record.cid))) : {},
    );
  }

  private async getLatestCommit(params: Record<string, unknown>, auth: FakeAuth, requestHeaders: Headers | undefined): Promise<WithHeaders> {
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

  private commitFor(space: FakeSpace, repo: string) {
    const rev = space.repoRevs.get(repo);
    if (space.deleted || !rev) throw new FakeXrpcError(400, "RepoNotFound", "Repo not found");
    const records = [...this.repoCollections(space, repo)].flatMap(([collection, entries]) =>
      [...entries].map(([rkey, entry]) => ({ collection: collection as never, rkey: rkey as never, cid: entry.cid })));
    return RepoCommit.fromRecords(records).toCommit({ space: spaceUri(space) as never, repo: repo as never, rev });
  }

  private listRecords(params: Record<string, unknown>, auth: FakeAuth) {
    // An account listing its own repo with its own OAuth session needs no credential, as on the pinned PDS.
    const own = this.isOwnRead(params, auth);
    if (!own) this.requireCredential(params, auth);
    this.assertRepoAvailability(String(params.repo), own);
    const space = this.requireSpace(params.space);
    const repo = String(params.repo);
    const collection = String(params.collection);
    const records = [...(space.deleted ? [] : this.repoCollections(space, repo).get(collection)?.entries() ?? [])]
      .sort(([left], [right]) => right.localeCompare(left))
      .map(([rkey, entry]) => ({ collection, rkey, cid: entry.cid.toString(), value: entry.value }));
    return paginate(records, params, (record) => record.rkey, "records");
  }

  private listRepos(params: Record<string, unknown>, auth: FakeAuth) {
    this.requireCredential(params, auth);
    const space = this.requireSpace(params.space);
    const limit = typeof params.limit === "number" ? params.limit : Number(params.limit ?? 100) || 100;
    const after = typeof params.cursor === "string" ? params.cursor : "";
    const updated = [...space.trackedWriters]
      .map(([did, revs]) => ({ did, ...revs, data: { $bytes: toBase64(new Uint8Array(32)) } }))
      .filter((repo) => repo.spaceRev > after)
      .sort((left, right) => left.spaceRev.localeCompare(right.spaceRev));
    const repos = updated.slice(0, limit);
    return { repos, ...(repos.length > 0 ? { cursor: repos[repos.length - 1]!.spaceRev } : {}) };
  }

  private registerNotify(params: Record<string, unknown>, auth: FakeAuth): { expiresAt: string } {
    this.requireCredential(params, auth);
    this.requireSpace(params.space);
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

  private currentlyAuthorizedWriter(space: FakeSpace, did: string): boolean {
    return did === space.ownerDid || space.policy.publicWrite || space.members.get(did)?.write === true;
  }
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

function paginate<T>(all: T[], params: Record<string, unknown>, key: (item: T) => string, field: string): Record<string, unknown> {
  const limit = typeof params.limit === "number" ? params.limit : Number(params.limit ?? 100) || 100;
  const cursor = typeof params.cursor === "string" ? params.cursor : undefined;
  const startIndex = cursor ? all.findIndex((item) => key(item) === cursor) + 1 : 0;
  const page = all.slice(startIndex, startIndex + limit);
  const nextIndex = startIndex + page.length;
  return { [field]: page, ...(nextIndex < all.length ? { cursor: key(page[page.length - 1]!) } : {}) };
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
