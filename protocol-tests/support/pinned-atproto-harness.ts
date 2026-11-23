import assert from "node:assert/strict";
import { join } from "node:path";
import { after, describe as nodeDescribe, it as nodeIt } from "node:test";
import { pathToFileURL } from "node:url";
import { P256Keypair } from "@atproto/crypto";
import {
  COMMIT_MAC_PROFILE,
  type MacProfile,
  RECORD_MAC_PROFILE,
  RepoCommit,
  createSpaceSigHeaders,
  encapsulate,
  formatMacRequest,
} from "@atproto/space";
import {
  type DidString,
  type HandleString,
  type NsidString,
  type RecordKeyString,
  SpaceRef,
  type SpaceRefString,
} from "@atproto/syntax";
import { pinnedCheckout } from "./pds-network";

const pin = pinnedCheckout();

const [devEnvMod, lexMod, lexDataMod, pdsLexiconsMod, oauthProviderMod, oauthClientClassMod, oauthCodeMod, commonMod] =
  await Promise.all([
    import(pathToFileURL(join(pin, "packages/dev-env/dist/index.js")).href),
    import(pathToFileURL(join(pin, "packages/lex/lex/dist/index.js")).href),
    import(pathToFileURL(join(pin, "packages/lex/lex-data/dist/index.js")).href),
    import(pathToFileURL(join(pin, "packages/pds/dist/lexicons.js")).href),
    import(pathToFileURL(join(pin, "packages/oauth/oauth-provider/dist/oauth-provider.js")).href),
    import(pathToFileURL(join(pin, "packages/oauth/oauth-provider/dist/client/client.js")).href),
    import(pathToFileURL(join(pin, "packages/oauth/oauth-provider/dist/request/code.js")).href),
    import(pathToFileURL(join(pin, "packages/common/dist/index.js")).href),
  ]);

export type LexMap = Record<string, unknown>;
export type ParsedCid = ReturnType<typeof RepoCommit.fromRecords> extends never ? never : Parameters<typeof RepoCommit.fromRecords>[0][number]["cid"];
export const parseCid = lexDataMod.parseCid as (cid: string) => ParsedCid;

export type LexClientInstance = {
  setLabelers(dids: readonly string[]): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  call(method: unknown, params?: Record<string, unknown>, opts?: Record<string, unknown>): Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  xrpc(method: unknown, opts?: Record<string, unknown>): Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  xrpcSafe(method: unknown, opts?: Record<string, unknown>): Promise<any>;
};

export type IdResolverLike = {
  did: { ensureResolve(did: string): Promise<unknown> };
};

export type OAuthProviderClientInstance = {
  isConfidential: boolean;
  sessionLifetime: number;
  refreshLifetime: number;
  authenticate(input: unknown, opts: { authorizationServerIdentifier: string }): Promise<{ method: string; kid?: string }>;
};

export type JoseKeyInstance = {
  publicJwk: Record<string, unknown>;
  bareJwk?: Record<string, string>;
  createJwt(header: Record<string, unknown>, payload: Record<string, unknown>): Promise<string>;
};

export type TestPds = {
  url: string;
  getClient(): LexClientInstance;
  getAgent(): {
    com: {
      atproto: {
        server: {
          createSession(input: Record<string, unknown>): Promise<{ data: { accessJwt: string } }>;
        };
        repo: {
          createRecord(input: Record<string, unknown>, opts: { headers: { authorization: string } }): Promise<unknown>;
        };
      };
    };
  };
  ctx: {
    idResolver: IdResolverLike;
    cfg: {
      service: { did: string };
      identity: { serviceHandleDomains: string[] };
      oauth: { issuer: string };
    };
    accountManager: {
      db: {
        db: {
          updateTable(table: string): {
            set(values: Record<string, unknown>): {
              where(col: string, op: string, val: unknown): { execute(): Promise<unknown> };
            };
          };
        };
      };
    };
    oauthProvider?: {
      accountManager: { getAccount(did: string): Promise<{ account: unknown }> };
      clientManager: { getClient(clientId: string): Promise<OAuthProviderClientInstance> };
      tokenManager: {
        createToken(
          ...args: unknown[]
        ): Promise<{ access_token: string; refresh_token?: string; expires_in: number; scope?: string }>;
        findToken(token: string): Promise<{ id: unknown } | null>;
      };
    };
  };
};

export type PinnedTestNetwork = {
  pds: TestPds;
  extraPdses: TestPds[];
  plc: { url: string };
  lexiconAuthority?: { did: string };
  close(): Promise<void>;
};

export const TestNetworkNoAppView = devEnvMod.TestNetworkNoAppView as {
  create(opts: Record<string, unknown>): Promise<PinnedTestNetwork>;
};
export const EXAMPLE_LABELER = devEnvMod.EXAMPLE_LABELER as DidString;
export const SeedClient = devEnvMod.SeedClient as { getHeaders(jwt: string): { authorization: string } };
export const LexClient = lexMod.Client as new (opts: {
  service: string;
  fetch?: typeof globalThis.fetch;
}) => LexClientInstance;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const com = pdsLexiconsMod.com as Record<string, any>;
export const JoseKey = oauthProviderMod.JoseKey as {
  generate(algs: string[], kid?: string): Promise<JoseKeyInstance>;
};
export const OAuthProviderClient = oauthClientClassMod.Client as new (
  clientId: string,
  metadata: Record<string, unknown>,
  jwks: unknown,
  info: { isFirstParty: boolean; isTrusted: boolean },
) => OAuthProviderClientInstance;
export const generateCode = oauthCodeMod.generateCode as () => Promise<string>;
export const TID = commonMod.TID as { nextStr(): string };
export const getVerificationMaterial = commonMod.getVerificationMaterial as (
  doc: unknown,
  id: string,
) => { publicKeyMultibase: string } | undefined;

export const TEST_COLLECTION = "com.example.spaceRecord" as NsidString;
export const TEST_SPACE_TYPE = "com.example.group" as NsidString;

const MAC_PROFILE_BY_METHOD: Record<string, MacProfile> = {
  [com.atproto.space.getLatestCommit.$lxm]: COMMIT_MAC_PROFILE,
  [com.atproto.space.getRepo.$lxm]: COMMIT_MAC_PROFILE,
  [com.atproto.space.listRepoOps.$lxm]: COMMIT_MAC_PROFILE,
  [com.atproto.space.getRecord.$lxm]: RECORD_MAC_PROFILE,
};

export type Actor = {
  name: string;
  did: DidString;
  password: string;
  headers: { authorization: string };
  pds: TestPds;
  client: LexClientInstance;
};

export const record = (collection: NsidString, text = "hello"): LexMap => ({
  $type: collection,
  text,
  createdAt: new Date().toISOString(),
});

export class SpaceCredential {
  constructor(
    public credential: string,
    public key: P256Keypair,
    public idResolver: IdResolverLike,
    public spaceRev?: string,
  ) {}

  clientFor(pds: TestPds): LexClientInstance {
    const client = new LexClient({ service: pds.url, fetch: this.fetch });
    client.setLabelers([EXAMPLE_LABELER]);
    return client;
  }

  async signedHeaders(audience: DidString, opts: { scheme?: string } = {}): Promise<Record<string, string>> {
    const scheme = opts.scheme ?? "Atproto-Space-Credential";
    const { headers } = await createSpaceSigHeaders({
      authorization: `${scheme} ${this.credential}`,
      audience,
      keypair: this.key,
    });
    return headers as Record<string, string>;
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const params =
      request.method === "GET"
        ? Object.fromEntries(new URL(request.url).searchParams)
        : ((await request.clone().json()) as Record<string, string>);
    const audience = (params.repo ?? SpaceRef.parse(params.space!).spaceDid) as DidString;
    for (const [name, value] of Object.entries(await this.signedHeaders(audience))) {
      request.headers.set(name, value);
    }
    const lxm = new URL(request.url).pathname.replace(/^\/xrpc\//, "");
    const profile = MAC_PROFILE_BY_METHOD[lxm];
    if (!profile || request.headers.has("accept-signature")) {
      return globalThis.fetch(request);
    }
    const encapsulation = await encapsulate(await this.resolveKemKey(params.repo!));
    request.headers.set("accept-signature", formatMacRequest(profile, encapsulation.keyShare));
    return globalThis.fetch(request);
  };

  async resolveKemKey(did: string): Promise<DidString> {
    const didDoc = await this.idResolver.did.ensureResolve(did);
    const kemKey = getVerificationMaterial(didDoc, "atproto_kem");
    if (!kemKey) throw new Error(`no #atproto_kem key for ${did}`);
    return `did:key:${kemKey.publicKeyMultibase}` as DidString;
  }
}

export class SpaceClient {
  constructor(public network: PinnedTestNetwork) {}

  get authority(): TestPds {
    return this.network.pds;
  }

  get idResolver(): IdResolverLike {
    return this.authority.ctx.idResolver;
  }

  async createActor(name: string, pds = this.network.pds): Promise<Actor> {
    const [domain] = pds.ctx.cfg.identity.serviceHandleDomains;
    const password = `${name}-pass`;
    const client = pds.getClient();
    const { did, accessJwt } = await client.call(com.atproto.server.createAccount, {
      handle: `${name}${domain}` as HandleString,
      email: `${name}@test.com`,
      password,
    });
    return {
      name,
      did,
      password,
      headers: SeedClient.getHeaders(accessJwt),
      pds,
      client,
    };
  }

  async createSpace(
    authority: Actor,
    opts: {
      skey?: string;
      spaceType?: NsidString;
      members?: Actor[];
      policy?: unknown;
      ungoverned?: boolean;
    } = {},
  ): Promise<SpaceRefString> {
    const spaceType = opts.spaceType ?? TEST_SPACE_TYPE;
    const skey = (opts.skey ?? TID.nextStr()) as RecordKeyString;
    if (opts.ungoverned) {
      return new SpaceRef(authority.did, spaceType, skey).toString();
    }
    const { space } = await authority.client.call(
      com.atproto.space.createSpace,
      {
        spaceType,
        skey,
        policy: opts.policy ?? com.atproto.memberspace.policy.$build({}),
      },
      { headers: authority.headers },
    );
    for (const member of opts.members ?? []) {
      await this.putMember(authority, space, member);
    }
    return space;
  }

  async putMember(
    authority: Actor,
    space: SpaceRefString,
    member: Actor,
    access: { read: boolean; write: boolean } = { read: true, write: true },
  ) {
    return authority.client.call(
      com.atproto.memberspace.putMembers,
      { space, members: [{ did: member.did, ...access }] },
      { headers: authority.headers },
    );
  }

  async removeMember(authority: Actor, space: SpaceRefString, member: Actor) {
    return authority.client.call(
      com.atproto.memberspace.removeMembers,
      { space, dids: [member.did] },
      { headers: authority.headers },
    );
  }

  async write(
    actor: Actor,
    space: SpaceRefString,
    opts: {
      collection?: NsidString;
      rkey?: string;
      text?: string;
      record?: LexMap;
      validate?: boolean;
      headers?: { authorization: string };
    } = {},
  ) {
    const collection = opts.collection ?? TEST_COLLECTION;
    return actor.client.call(
      com.atproto.space.createRecord,
      {
        space,
        repo: actor.did,
        collection,
        rkey: opts.rkey as RecordKeyString | undefined,
        record: opts.record ?? record(collection, opts.text),
        validate: opts.validate,
      },
      { headers: opts.headers ?? actor.headers },
    );
  }

  async put(
    actor: Actor,
    space: SpaceRefString,
    opts: {
      collection?: NsidString;
      rkey?: string;
      text?: string;
      record?: LexMap;
      validate?: boolean;
      headers?: { authorization: string };
    } = {},
  ) {
    const collection = opts.collection ?? TEST_COLLECTION;
    return actor.client.call(
      com.atproto.space.putRecord,
      {
        space,
        repo: actor.did,
        collection,
        rkey: (opts.rkey ?? "self") as RecordKeyString,
        record: opts.record ?? record(collection, opts.text),
        validate: opts.validate,
      },
      { headers: opts.headers ?? actor.headers },
    );
  }

  async del(
    actor: Actor,
    space: SpaceRefString,
    opts: { collection?: NsidString; rkey: string; headers?: { authorization: string } },
  ) {
    return actor.client.call(
      com.atproto.space.deleteRecord,
      {
        space,
        repo: actor.did,
        collection: opts.collection ?? TEST_COLLECTION,
        rkey: opts.rkey as RecordKeyString,
      },
      { headers: opts.headers ?? actor.headers },
    );
  }

  async clear(actor: Actor, space: SpaceRefString, opts: { headers?: { authorization: string } } = {}) {
    return actor.client.call(
      com.atproto.space.clearRecords,
      { space, repo: actor.did },
      { headers: opts.headers ?? actor.headers },
    );
  }

  async delegationTokenFor(actor: Actor, space: SpaceRefString): Promise<string> {
    const res = await actor.client.call(
      com.atproto.space.getDelegationToken,
      { space },
      { headers: actor.headers },
    );
    return res.token;
  }

  async authorize(
    space: SpaceRefString,
    opts: { delegationToken?: string; clientAttestation?: string; notify?: unknown; key?: P256Keypair } = {},
  ): Promise<SpaceCredential> {
    const key = opts.key ?? (await P256Keypair.create());
    const res = await this.authority.getClient().call(com.atproto.space.authorizeSpaceSync, {
      space,
      credentialKey: key.did(),
      delegationToken: opts.delegationToken,
      clientAttestation: opts.clientAttestation,
      notify: opts.notify,
    });
    return new SpaceCredential(res.credential, key, this.idResolver, res.spaceRev);
  }

  async credentialFor(
    actor: Actor,
    space: SpaceRefString,
    opts: { clientAttestation?: string; notify?: unknown; key?: P256Keypair } = {},
  ): Promise<SpaceCredential> {
    const delegationToken = await this.delegationTokenFor(actor, space);
    return this.authorize(space, { ...opts, delegationToken });
  }

  async latestCommit(actor: Actor, space: SpaceRefString): Promise<{ rev: string; data: unknown } | null> {
    const res = await actor.client.xrpcSafe(com.atproto.space.getLatestCommit, {
      params: { space, repo: actor.did },
      headers: actor.headers,
    });
    if (res.success) return res.body.commit;
    if (res.error === "RepoNotFound") return null;
    throw res;
  }

  async expectCommitMatchesRecords(actor: Actor, space: SpaceRefString) {
    const { records } = await actor.client.call(
      com.atproto.space.listRecords,
      { space, repo: actor.did, limit: 1000, excludeValues: true },
      { headers: actor.headers },
    );
    const commit = await this.latestCommit(actor, space);
    const fromRecords = RepoCommit.fromRecords(records.map((r: { cid: string }) => ({ ...r, cid: parseCid(r.cid) })) as never);
    assert.equal(Boolean(commit && fromRecords.matches(commit as never)), true);
  }
}

const OBJECT_CONTAINING = Symbol("expect.objectContaining");

function matchesShape(actual: unknown, expected: unknown): boolean {
  if (expected && typeof expected === "object" && OBJECT_CONTAINING in (expected as Record<symbol, unknown>)) {
    const subset = (expected as Record<symbol, Record<string, unknown>>)[OBJECT_CONTAINING]!;
    if (!actual || typeof actual !== "object") return false;
    return Object.entries(subset).every(([k, v]) => matchesShape((actual as Record<string, unknown>)[k], v));
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((item, idx) => matchesShape(actual[idx], item));
  }
  if (expected && typeof expected === "object" && !(expected instanceof RegExp)) {
    if (!actual || typeof actual !== "object") return false;
    const expKeys = Object.keys(expected as Record<string, unknown>);
    const actKeys = Object.keys(actual as Record<string, unknown>);
    if (expKeys.length !== actKeys.length) return false;
    return expKeys.every(
      (k) =>
        Object.prototype.hasOwnProperty.call(actual, k) &&
        matchesShape((actual as Record<string, unknown>)[k], (expected as Record<string, unknown>)[k]),
    );
  }
  return Object.is(actual, expected);
}

function matchesSubset(actual: unknown, subset: Record<string, unknown>): boolean {
  if (!actual || typeof actual !== "object") return false;
  return Object.entries(subset).every(([k, v]) => {
    const val = (actual as Record<string, unknown>)[k];
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      !(v instanceof RegExp) &&
      !(OBJECT_CONTAINING in (v as Record<symbol, unknown>))
    ) {
      return matchesSubset(val, v as Record<string, unknown>);
    }
    return matchesShape(val, v);
  });
}

function createMatchers(actual: unknown, negated = false) {
  const check = (cond: boolean, message: string) => {
    if (negated ? cond : !cond) {
      throw new assert.AssertionError({ message, actual });
    }
  };
  return {
    toBe(expected: unknown) {
      check(
        Object.is(actual, expected),
        `Expected ${JSON.stringify(actual)} ${negated ? "not " : ""}toBe ${JSON.stringify(expected)}`,
      );
    },
    toEqual(expected: unknown) {
      check(
        matchesShape(actual, expected),
        `Expected ${JSON.stringify(actual)} ${negated ? "not " : ""}toEqual ${JSON.stringify(expected)}`,
      );
    },
    toMatchObject(subset: Record<string, unknown>) {
      check(
        matchesSubset(actual, subset),
        `Expected ${JSON.stringify(actual)} ${negated ? "not " : ""}toMatchObject ${JSON.stringify(subset)}`,
      );
    },
    toHaveLength(len: number) {
      const actualLen = (actual as { length?: number } | null | undefined)?.length;
      check(actualLen === len, `Expected length ${String(actualLen)} ${negated ? "not " : ""}to be ${len}`);
    },
    toContain(item: unknown) {
      const arr = Array.isArray(actual) ? actual : [];
      check(
        arr.some((el) => matchesShape(el, item)),
        `Expected ${JSON.stringify(actual)} ${negated ? "not " : ""}toContain ${JSON.stringify(item)}`,
      );
    },
    toBeDefined() {
      check(actual !== undefined, `Expected value ${negated ? "not " : ""}toBeDefined`);
    },
    toBeNull() {
      check(actual === null, `Expected ${JSON.stringify(actual)} ${negated ? "not " : ""}toBeNull`);
    },
    toBeGreaterThan(n: number) {
      check(typeof actual === "number" && actual > n, `Expected ${String(actual)} > ${n}`);
    },
    toBeLessThanOrEqual(n: number) {
      check(typeof actual === "number" && actual <= n, `Expected ${String(actual)} <= ${n}`);
    },
    toBeInstanceOf(ctor: abstract new (...args: never[]) => unknown) {
      check(actual instanceof ctor, `Expected value ${negated ? "not " : ""}toBeInstanceOf ${ctor.name}`);
    },
  };
}

export function expect(actual: unknown) {
  const base = createMatchers(actual, false);
  return {
    ...base,
    not: createMatchers(actual, true),
    resolves: {
      async toBeInstanceOf(ctor: abstract new (...args: never[]) => unknown) {
        const val = await (actual as Promise<unknown>);
        createMatchers(val, false).toBeInstanceOf(ctor);
      },
    },
    rejects: {
      async toMatchObject(subset: Record<string, unknown>) {
        let threw = false;
        let caught: unknown;
        try {
          await (actual as Promise<unknown>);
        } catch (err) {
          threw = true;
          caught = err;
        }
        assert.equal(threw, true, "Expected promise to reject, but it resolved");
        createMatchers(caught, false).toMatchObject(subset);
      },
      async toThrow(pattern?: RegExp | string) {
        let threw = false;
        let caught: unknown;
        try {
          await (actual as Promise<unknown>);
        } catch (err) {
          threw = true;
          caught = err;
        }
        assert.equal(threw, true, "Expected promise to reject, but it resolved");
        if (pattern !== undefined) {
          const msg = caught instanceof Error ? caught.message : String(caught);
          if (pattern instanceof RegExp) assert.match(msg, pattern);
          else assert.ok(msg.includes(pattern), `Expected "${msg}" to include "${pattern}"`);
        }
      },
    },
  };
}

expect.objectContaining = (subset: Record<string, unknown>) => ({ [OBJECT_CONTAINING]: subset });

export const describe = nodeDescribe;
export const afterAll = after;
export function it(name: string, fn: () => Promise<void> | void, timeoutMs?: number) {
  return nodeIt(name, timeoutMs ? { timeout: timeoutMs } : {}, fn);
}
