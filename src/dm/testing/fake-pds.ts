import type { DpopKey } from "@/atproto/dpop";
import { AtprotoClient } from "@/atproto/xrpc";

/**
 * An in-memory, multi-host fake of the DM-relevant slice of the pinned PDS
 * protocol. Test-only: production code (`dm-client.ts`) never imports this.
 *
 * Space management (`createSpace`/`updateSpace`/`getSpace`/`putMember`/
 * `removeMember`/`deleteSpace`/`listMembers`/`listSpaces`) is authorized by the
 * caller's own identity (`clientFor(did)`, standing in for a self-authenticated
 * OAuth session): only the space's owner may call them, matching
 * `authority=self` in DM_BROWSER_SCOPES.
 *
 * Repo content (`listRepos`/`listRecords`/`getRecord`/`registerNotify`) always
 * requires a minted space credential (`getDelegationToken` at the caller's own
 * host, then `getSpaceCredential` at the authority's host), even for the
 * authority's own space, matching the pinned PDS's uniform credential
 * mechanism (M0 conformance).
 *
 * Reproduces the M0-observed quirks: a `putRecord` into someone else's space
 * always succeeds (you always own your own repo) but is only added to
 * `trackedWriters` (and therefore `listRepos`) when the space's *current*
 * write policy authorizes the writer; once tracked, a writer is never evicted
 * by tightening the policy or removing them from the member list.
 */

type Policy = "public" | "memberList";

type FakeSpace = {
  type: string;
  skey: string;
  ownerDid: string;
  readPolicy: Policy;
  writePolicy: Policy;
  members: Map<string, { read: boolean; write: boolean }>;
  trackedWriters: Set<string>;
  deleted: boolean;
  repos: Map<string, Map<string, Map<string, { value: Record<string, unknown>; cid: string }>>>;
};

type FakeAuth = { kind: "self"; did: string } | { kind: "delegation"; token: string } | { kind: "credential"; token: string } | { kind: "none" };

const CREDENTIAL_LIFETIME_MS = 2 * 60 * 60 * 1000;

export class FakeXrpcError extends Error {
  constructor(readonly status: number, readonly code: string, message = code) {
    super(message);
    this.name = "FakeXrpcError";
  }
}

export class FakeDmNetwork {
  private virtualNow = Date.now();

  private readonly accounts = new Map<string, string>();
  private readonly spaces = new Map<string, FakeSpace>();
  private readonly delegations = new Map<string, { space: string; granteeDid: string }>();
  private readonly credentials = new Map<string, { space: string; grantedDid: string; expiresAt: number }>();
  private tokenCounter = 0;
  private cidCounter = 0;

  now = (): number => this.virtualNow;

  /** Advances the fake network's clock, used by tests exercising credential expiry and re-notify backoff. */
  advanceClock(ms: number): void {
    this.virtualNow += ms;
  }

  createAccount(did: string, host = "pds1"): void {
    this.accounts.set(did, host);
  }

  hasAccount(did: string): boolean {
    return this.accounts.has(did);
  }

  resolvePds = async (did: string): Promise<string> => {
    const host = this.accounts.get(did);
    if (!host) throw new Error(`fake-pds: no account registered for ${did}`);
    return `https://fake-pds.test/${host}`;
  };

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
    return this.respond(path, { method: request.method, body }, this.authFromHeader(request.headers.get("authorization")));
  };

  generateKey = async (): Promise<DpopKey> => {
    const id = `fake-key-${this.tokenCounter++}`;
    return {
      bareJwk: { kty: "EC", crv: "P-256", x: id, y: id },
      algorithms: ["ES256"],
      createJwt: async (header, payload) => `${encodeSegment(header)}.${encodeSegment(payload)}.fake-signature`,
    };
  };

  private authFromHeader(header: string | null): FakeAuth {
    if (!header) return { kind: "none" };
    const [scheme, token] = header.split(" ");
    if (!token) return { kind: "none" };
    if (scheme === "Bearer") return { kind: "delegation", token };
    if (scheme === "DPoP") return { kind: "credential", token };
    return { kind: "none" };
  }

  private async respond(path: string, init: { method?: string; body?: unknown }, auth: FakeAuth): Promise<Response> {
    const url = new URL(path, "https://fake-pds.test");
    const method = url.pathname.replace(/^\/xrpc\//, "");
    const params: Record<string, unknown> = {};
    for (const [key, value] of url.searchParams.entries()) params[key] = value;
    if (typeof init.body === "string" && init.body.length > 0) Object.assign(params, JSON.parse(init.body));
    try {
      const body = this.handle(method, params, auth);
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    } catch (error) {
      if (error instanceof FakeXrpcError) {
        return new Response(JSON.stringify({ error: error.code, message: error.message }), {
          status: error.status, headers: { "content-type": "application/json" },
        });
      }
      throw error;
    }
  }

  private handle(method: string, params: Record<string, unknown>, auth: FakeAuth): unknown {
    switch (method) {
      case "com.atproto.space.getDelegationToken": return this.getDelegationToken(params, auth);
      case "com.atproto.space.getSpaceCredential": return this.getSpaceCredential(params, auth);
      case "com.atproto.simplespace.createSpace": return this.createSpace(params, auth);
      case "com.atproto.simplespace.updateSpace": return this.updateSpace(params, auth);
      case "com.atproto.simplespace.getSpace": return this.getSpace(params, auth);
      case "com.atproto.simplespace.putMember": return this.putMember(params, auth);
      case "com.atproto.simplespace.removeMember": return this.removeMember(params, auth);
      case "com.atproto.simplespace.deleteSpace": return this.deleteSpace(params, auth);
      case "com.atproto.simplespace.listMembers": return this.listMembers(params, auth);
      case "com.atproto.space.listSpaces": return this.listSpaces(params, auth);
      case "com.atproto.space.putRecord": return this.putRecord(params, auth);
      case "com.atproto.space.deleteRecord": return this.deleteRecord(params, auth);
      case "com.atproto.space.getRecord": return this.getRecord(params, auth);
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

  private getDelegationToken(params: Record<string, unknown>, auth: FakeAuth): { token: string } {
    const granteeDid = this.requireSelf(auth);
    const space = String(params.space);
    const token = `delegation-${this.tokenCounter++}`;
    this.delegations.set(token, { space, granteeDid });
    return { token };
  }

  private getSpaceCredential(params: Record<string, unknown>, auth: FakeAuth): { credential: string } {
    if (auth.kind !== "delegation") throw new FakeXrpcError(401, "MissingJwt", "missing space delegation token");
    const delegation = this.delegations.get(auth.token);
    if (!delegation || delegation.space !== params.space) throw new FakeXrpcError(400, "InvalidDelegationToken", "Delegation token subject does not match requested space");
    const space = this.requireSpace(params.space);
    if (space.deleted) throw new FakeXrpcError(400, "SpaceDeleted", "Space has been deleted");
    const authorized = delegation.granteeDid === space.ownerDid ||
      space.readPolicy === "public" ||
      space.members.get(delegation.granteeDid)?.read === true;
    if (!authorized) throw new FakeXrpcError(400, "UserNotAuthorized", "User not authorized for this space");
    const token = `credential-${this.tokenCounter++}`;
    this.credentials.set(token, { space: delegation.space, grantedDid: delegation.granteeDid, expiresAt: this.now() + CREDENTIAL_LIFETIME_MS });
    return { credential: token };
  }

  private createSpace(params: Record<string, unknown>, auth: FakeAuth): { uri: string } {
    const ownerDid = this.requireSelf(auth);
    const type = String(params.type);
    const skey = String(params.skey);
    const uri = `at://${ownerDid}/space/${type}/${skey}`;
    if (this.spaces.has(uri)) throw new FakeXrpcError(400, "SpaceAlreadyExists", "Space already exists");
    this.spaces.set(uri, {
      type, skey, ownerDid,
      readPolicy: policyKind(params.readPolicy),
      writePolicy: policyKind(params.writePolicy),
      members: new Map(), trackedWriters: new Set(), deleted: false, repos: new Map(),
    });
    return { uri };
  }

  private updateSpace(params: Record<string, unknown>, auth: FakeAuth): Record<string, never> {
    const did = this.requireSelf(auth);
    const space = this.requireSpace(params.space);
    this.requireOwner(space, did);
    if (params.readPolicy !== undefined) space.readPolicy = policyKind(params.readPolicy);
    if (params.writePolicy !== undefined) space.writePolicy = policyKind(params.writePolicy);
    return {};
  }

  private getSpace(params: Record<string, unknown>, auth: FakeAuth) {
    const did = this.requireSelf(auth);
    const space = this.requireSpace(params.space);
    this.requireOwner(space, did);
    return {
      uri: params.space as string,
      readPolicy: { $type: policyType(space.readPolicy) },
      writePolicy: { $type: policyType(space.writePolicy) },
      appAccess: { $type: "com.atproto.simplespace.defs#open" },
    };
  }

  private putMember(params: Record<string, unknown>, auth: FakeAuth): Record<string, never> {
    const did = this.requireSelf(auth);
    const space = this.requireSpace(params.space);
    this.requireOwner(space, did);
    space.members.set(String(params.did), { read: Boolean(params.read), write: Boolean(params.write) });
    return {};
  }

  private removeMember(params: Record<string, unknown>, auth: FakeAuth): Record<string, never> {
    const did = this.requireSelf(auth);
    const space = this.requireSpace(params.space);
    this.requireOwner(space, did);
    space.members.delete(String(params.did));
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
    const all = [...space.members.entries()].map(([memberDid, access]) => ({ did: memberDid, ...access }));
    return paginate(all, params, (member) => member.did, "members");
  }

  private listSpaces(params: Record<string, unknown>, auth: FakeAuth) {
    const did = this.requireSelf(auth);
    const all = [...this.spaces.values()]
      .filter((space) => space.ownerDid === did && !space.deleted)
      .filter((space) => params.type === undefined || space.type === params.type)
      .filter((space) => params.did === undefined || space.ownerDid === params.did)
      .map((space) => ({ uri: `at://${space.ownerDid}/space/${space.type}/${space.skey}` }));
    return paginate(all, params, (space) => space.uri, "spaces");
  }

  private putRecord(params: Record<string, unknown>, auth: FakeAuth) {
    const did = this.requireSelf(auth);
    const repo = String(params.repo);
    if (repo !== did) throw new FakeXrpcError(400, "UserNotAuthorized", "Can only write to your own repo");
    const collection = String(params.collection);
    const rkey = String(params.rkey);
    const record = params.record as Record<string, unknown>;
    if (typeof params.space !== "string" || !this.spaces.has(params.space) || this.spaces.get(params.space)!.deleted) {
      // The pinned PDS stores the record in the writer's own repo and swallows the authority's SpaceNotFound.
      return { uri: `${String(params.space)}/${repo}/${collection}/${rkey}`, cid: `cid-${this.cidCounter++}` };
    }
    const space = this.requireSpace(params.space);
    const repoCollections = this.repoCollections(space, repo);
    const records = repoCollections.get(collection) ?? new Map<string, { value: Record<string, unknown>; cid: string }>();
    repoCollections.set(collection, records);
    const cid = `cid-${this.cidCounter++}`;
    records.set(rkey, { value: record, cid });
    if (this.currentlyAuthorizedWriter(space, repo)) space.trackedWriters.add(repo);
    return { uri: `${spaceUri(space)}/${repo}/${collection}/${rkey}`, cid };
  }

  private deleteRecord(params: Record<string, unknown>, auth: FakeAuth): Record<string, never> {
    const did = this.requireSelf(auth);
    const repo = String(params.repo);
    if (repo !== did) throw new FakeXrpcError(400, "UserNotAuthorized", "Can only delete from your own repo");
    const space = this.requireSpace(params.space);
    this.repoCollections(space, repo).get(String(params.collection))?.delete(String(params.rkey));
    return {};
  }

  private requireCredential(params: Record<string, unknown>, auth: FakeAuth): string {
    if (auth.kind !== "credential") throw new FakeXrpcError(401, "MissingJwt", "missing space credential");
    const credential = this.credentials.get(auth.token);
    if (!credential || credential.space !== params.space) throw new FakeXrpcError(403, "UserNotAuthorized", "credential does not authorize this space");
    if (credential.expiresAt <= this.now()) throw new FakeXrpcError(401, "ExpiredToken", "space credential expired");
    return credential.grantedDid;
  }

  private getRecord(params: Record<string, unknown>, auth: FakeAuth) {
    this.requireCredential(params, auth);
    const space = this.requireSpace(params.space);
    const repo = String(params.repo);
    const collection = String(params.collection);
    const rkey = String(params.rkey);
    const record = space.deleted ? undefined : this.repoCollections(space, repo).get(collection)?.get(rkey);
    if (!record) throw new FakeXrpcError(400, "RecordNotFound", "Record not found");
    return { uri: `${spaceUri(space)}/${repo}/${collection}/${rkey}`, cid: record.cid, value: record.value };
  }

  private listRecords(params: Record<string, unknown>, auth: FakeAuth) {
    this.requireCredential(params, auth);
    const space = this.requireSpace(params.space);
    const repo = String(params.repo);
    const collection = String(params.collection);
    const records = [...(space.deleted ? [] : this.repoCollections(space, repo).get(collection)?.entries() ?? [])]
      .sort(([left], [right]) => right.localeCompare(left))
      .map(([rkey, entry]) => ({ collection, rkey, cid: entry.cid, value: entry.value }));
    return paginate(records, params, (record) => record.rkey, "records");
  }

  private listRepos(params: Record<string, unknown>, auth: FakeAuth) {
    this.requireCredential(params, auth);
    const space = this.requireSpace(params.space);
    const repos = [...space.trackedWriters].sort().map((did) => ({ did, rev: "fake-rev", hash: new Uint8Array(32) }));
    return paginate(repos, params, (repo) => repo.did, "repos");
  }

  private registerNotify(params: Record<string, unknown>, auth: FakeAuth): { expiresAt: string } {
    this.requireCredential(params, auth);
    this.requireSpace(params.space);
    return { expiresAt: new Date(this.now() + CREDENTIAL_LIFETIME_MS).toISOString() };
  }

  private repoCollections(space: FakeSpace, repo: string): Map<string, Map<string, { value: Record<string, unknown>; cid: string }>> {
    let collections = space.repos.get(repo);
    if (!collections) {
      collections = new Map();
      space.repos.set(repo, collections);
    }
    return collections;
  }

  private currentlyAuthorizedWriter(space: FakeSpace, did: string): boolean {
    return did === space.ownerDid || space.writePolicy === "public" || space.members.get(did)?.write === true;
  }
}

function spaceUri(space: FakeSpace): string {
  return `at://${space.ownerDid}/space/${space.type}/${space.skey}`;
}

function policyKind(policy: unknown): Policy {
  const type = (policy as { $type?: unknown } | undefined)?.$type;
  return type === "com.atproto.simplespace.defs#publicPolicy" ? "public" : "memberList";
}

function policyType(policy: Policy): string {
  return policy === "public" ? "com.atproto.simplespace.defs#publicPolicy" : "com.atproto.simplespace.defs#memberListPolicy";
}

function paginate<T>(all: T[], params: Record<string, unknown>, key: (item: T) => string, field: string): Record<string, unknown> {
  const limit = typeof params.limit === "number" ? params.limit : Number(params.limit ?? 100) || 100;
  const cursor = typeof params.cursor === "string" ? params.cursor : undefined;
  const startIndex = cursor ? all.findIndex((item) => key(item) === cursor) + 1 : 0;
  const page = all.slice(startIndex, startIndex + limit);
  const nextIndex = startIndex + page.length;
  return { [field]: page, ...(nextIndex < all.length ? { cursor: key(page[page.length - 1]!) } : {}) };
}

function encodeSegment(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
