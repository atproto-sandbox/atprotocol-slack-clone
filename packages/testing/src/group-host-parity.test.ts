import assert from "node:assert/strict";
import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { readCarWithRoot } from "@atproto/car";
import { bytesToMultibase, P256Keypair, parseDidKey, Secp256k1Keypair } from "@atproto/crypto";
import type { LexMap } from "@atproto/lex-data";
import { jsonToLex } from "@atproto/lexicon";
import {
  createDelegationToken,
  createSpaceSigHeaders,
  readRepoStar,
  readSpaceMetaStar,
  RepoCommit,
  serializeRecord,
  spaceHostAud,
  writeRepoStar,
} from "@atproto/space";
import type { DidString, NsidString, RecordKeyString, SpaceRefString } from "@atproto/syntax";
import {
  completeGroupOAuthFlow,
  createDpopTestClient,
  startMockPersonalPds,
  startMockPlcServer,
  startTestGroupHost,
  type DpopTestClient,
} from "@flock/group-host/test-harness";
import { reapExpiredPreparedMigrationLease } from "@flock/group-host/rbac";
import { MEMBERSPACE_POLICY } from "@flock/protocol/atproto/space-policy";
import { AtprotoClient, XrpcError } from "@flock/protocol/atproto/xrpc";
import {
  appRoleKey,
  channelUri,
  groupMembersUri,
  groupMetaUri,
  personalInboxUri,
  SELF_SKEY,
  subjectKey,
  tidNow,
  workspaceUri,
} from "@flock/protocol/keys";
import {
  ATPROTO_SPACE_COLLECTION,
  COLLECTION,
  FLOCK_EXTENSION_FIELD,
  ATGRP_COLLECTION,
  ATGRP_METHOD,
  ATGRP_POLICY,
  ATGRP_SPACE_TYPE,
  REPO_COLLECTION,
  SPACE_TYPE,
} from "@flock/protocol/nsids";
import { groupAdminScopes, groupModeratorScopes } from "@flock/protocol/scopes";
import { FakeNetwork } from "./fake-network";

type ParityDriver = {
  kind: "fake" | "real";
  baseUrl: string;
  groupDid: string;
  groupHandle: string;
  peerMigrationEndpoint: string;
  aliceDid: string;
  bobDid: string;
  carolDid: string;
  botDid: string;
  adminClient: AtprotoClient;
  rawFetch: (url: string, init: RequestInit) => Promise<Response>;
  getLocalRotationKeyForTest: () => Promise<P256Keypair>;
  getGroupSigningKeyForTest: () => Promise<P256Keypair>;
  getPersonalSigningKeyForTest: (did: string) => Promise<P256Keypair>;
  clientForMemberWithScopes: (did: string, scopes: readonly string[]) => Promise<AtprotoClient>;
  moderatorClientFor: (did: string) => Promise<AtprotoClient>;
  recoveryClientFor: (did: string) => Promise<AtprotoClient>;
  personalServiceCall: <T = Record<string, unknown>>(params: {
    callerDid: string;
    method: string;
    httpMethod: "GET" | "POST";
    lxm: string;
    query?: Record<string, string>;
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
  }) => Promise<{ status: number; headers: Headers; json: T }>;
  groupHttpCall: (params: {
    path: string;
    method: "GET" | "POST";
    headers?: Record<string, string>;
    body?: Uint8Array | string;
  }) => Promise<{ status: number; headers: Headers; bytes: Uint8Array }>;
  unauthHttpCall: (params: {
    path: string;
    method: "GET" | "POST";
    headers?: Record<string, string>;
    body?: Uint8Array | string;
  }) => Promise<{ status: number; headers: Headers; bytes: Uint8Array }>;
  provisionPersonalInvitesSpace: (userDid: string) => Promise<void>;
  personalPdsEndpointForBob: string;
  getSourceServiceKeypairForTest: () => Promise<P256Keypair>;
  getPeerServiceKeypairForTest: () => Promise<P256Keypair>;
  setSourceOutboundInterceptor: (
    fn: ((url: string, init: RequestInit | undefined, forward: () => Promise<Response>) => Promise<Response>) | undefined,
  ) => void;
  setPeerOutboundInterceptor: (
    fn: ((url: string, init: RequestInit | undefined, forward: () => Promise<Response>) => Promise<Response>) | undefined,
  ) => void;
  flushSourceBackgroundWork: () => Promise<void>;
  flushPeerBackgroundWork: () => Promise<void>;
  expirePreparedSourceLeaseForTest: (expiresAtMs: number) => void;
  reapPreparedSourceLeaseWithClockSkewForTest: (skewedSourceNowMs: number) => void;
  getPeerGroupSigningKeyForTest: () => Promise<P256Keypair>;
  createSiblingGroupForTest: (where: "source" | "peer", slug: string) => Promise<string>;
  setPeerStagingDeadlineForTest: (deadlineAtMs: number, syncTicketExpiry?: boolean) => void;
  submitDirectPlcCutoverForTest: (signedOp: Record<string, unknown>) => Promise<void>;
  withSigningDelayClockAdvanceForTest: <T>(deltaMs: number, fn: () => Promise<T>) => Promise<T>;
  getPeerAbortStorageCountForTest: () => number;
  cleanup: () => Promise<void>;
};

async function createFakeDriver(opts: {
  joinPolicy?: "open" | "approval" | "invite";
  publicMeta?: boolean;
  withFlockWorkspace?: boolean;
}): Promise<ParityDriver> {
  const net = new FakeNetwork();
  let fakeClockOffsetMs = 0;
  net.now = () => Date.now() + fakeClockOffsetMs;
  const aliceDid = "did:plc:aliceparityaaaaaaaaaaaa2";
  const bobDid = "did:plc:bobparityaaaaaaaaaaaaaa3";
  const carolDid = "did:plc:carolparityaaaaaaaaaaaa4";
  const botDid = "did:plc:botparityaaaaaaaaaaaaaa5";
  const groupDid = "did:plc:groupparityaaaaaaaaaaaa6";

  net.createAccount(aliceDid, "pds-alice");
  net.createAccount(bobDid, "pds-bob");
  net.createAccount(carolDid, "pds-carol");
  net.createAccount(botDid, "pds-bot");

  const groupHandle = "parity-group.groups.test";
  await net.createGroupAccount(groupDid, {
    creatorDid: aliceDid,
    name: "Parity Group",
    handle: groupHandle,
    joinPolicy: opts.joinPolicy ?? "approval",
    publicMeta: opts.publicMeta ?? true,
  });

  const adminToken = net.issueGroupSessionToken(groupDid, aliceDid, {
    approvedScopes: groupAdminScopes(groupDid),
  });
  const groupBase = await net.resolvePds(groupDid);
  const adminClient = new AtprotoClient((path, init) =>
    net.fetchEndpoint(
      new Request(`${groupBase}${path}`, {
        method: init.method ?? "GET",
        headers: {
          ...init.headers,
          authorization: `Bearer ${adminToken}`,
        },
        body: init.body,
      }),
    ),
  );

  if (opts.withFlockWorkspace ?? true) {
    await adminClient.procedure("com.atproto.space.createSpace", {
      spaceType: SPACE_TYPE.workspace,
      skey: SELF_SKEY,
      policy: {
        $type: ATGRP_POLICY,
        publicRead: false,
        unlisted: false,
        grants: [
          { role: "admin", read: true, write: true },
          { role: "member", read: true },
        ],
      },
    });
  }

  const peerBase = "https://fake-pds.test/group-host-2";
  const peerNet = new FakeNetwork();
  peerNet.now = () => Date.now();
  let sourceOutboundInterceptor:
    | ((url: string, init: RequestInit | undefined, forward: () => Promise<Response>) => Promise<Response>)
    | undefined;
  let peerOutboundInterceptor:
    | ((url: string, init: RequestInit | undefined, forward: () => Promise<Response>) => Promise<Response>)
    | undefined;
  peerNet.shareHostServiceKeysWith(net);
  net.outboundFetch = async (request: Request) => {
    const defaultSourceForward = async (): Promise<Response> => {
      if (request.url.startsWith(`${peerBase}/`) || request.url === peerBase) {
        return peerNet.fetchEndpoint(request);
      }
      if (request.url.startsWith("https://fake-pds.test/")) {
        return net.fetchEndpoint(request);
      }
      return fetch(request);
    };
    if (sourceOutboundInterceptor) {
      return sourceOutboundInterceptor(request.url, request, defaultSourceForward);
    }
    return defaultSourceForward();
  };
  peerNet.outboundFetch = async (request: Request) => {
    const defaultForward = async (): Promise<Response> => {
      if (request.url.startsWith(`${peerBase}/`) || request.url === peerBase) {
        return peerNet.fetchEndpoint(request);
      }
      if (request.url.startsWith("https://fake-pds.test/")) {
        return net.fetchEndpoint(request);
      }
      return fetch(request);
    };
    if (peerOutboundInterceptor) {
      return peerOutboundInterceptor(request.url, request, defaultForward);
    }
    return defaultForward();
  };

  return {
    kind: "fake",
    baseUrl: groupBase,
    groupDid,
    groupHandle,
    peerMigrationEndpoint: peerBase,
    aliceDid,
    bobDid,
    carolDid,
    botDid,
    adminClient,
    rawFetch: (url: string, init: RequestInit) =>
      url.startsWith(`${peerBase}/`) || url === peerBase
        ? peerNet.fetchEndpoint(new Request(url, init))
        : net.fetchEndpoint(new Request(url, init)),
    async getLocalRotationKeyForTest() {
      return net.getGroupLocalRotationKeyForTest(groupDid);
    },
    async getGroupSigningKeyForTest() {
      return (net as unknown as { signingKeypair: (did: string) => Promise<P256Keypair> }).signingKeypair(groupDid);
    },
    async getPersonalSigningKeyForTest(did: string) {
      return (net as unknown as { signingKeypair: (did: string) => Promise<P256Keypair> }).signingKeypair(did);
    },
    async clientForMemberWithScopes(did: string, scopes: readonly string[]) {
      const tok = net.issueGroupSessionToken(groupDid, did, {
        approvedScopes: scopes,
      });
      return new AtprotoClient((path, init) =>
        net.fetchEndpoint(
          new Request(`${groupBase}${path}`, {
            method: init.method ?? "GET",
            headers: { ...init.headers, authorization: `Bearer ${tok}` },
            body: init.body,
          }),
        ),
      );
    },
    async moderatorClientFor(did: string) {
      const tok = net.issueGroupSessionToken(groupDid, did, {
        approvedScopes: groupModeratorScopes(),
      });
      return new AtprotoClient((path, init) =>
        net.fetchEndpoint(
          new Request(`${groupBase}${path}`, {
            method: init.method ?? "GET",
            headers: { ...init.headers, authorization: `Bearer ${tok}` },
            body: init.body,
          }),
        ),
      );
    },
    async recoveryClientFor(did: string) {
      const tok = net.issueGroupSessionToken(groupDid, did, {
        approvedScopes: groupAdminScopes(groupDid),
        sessionKind: "recovery",
      });
      return new AtprotoClient((path, init) =>
        net.fetchEndpoint(
          new Request(`${groupBase}${path}`, {
            method: init.method ?? "GET",
            headers: { ...init.headers, authorization: `Bearer ${tok}` },
            body: init.body,
          }),
        ),
      );
    },
    async personalServiceCall({ callerDid, method, httpMethod, lxm, query, body, headers }) {
      const callerClient = net.clientFor(callerDid);
      const svc = await callerClient.query<{ token: string }>("com.atproto.server.getServiceAuth", {
        aud: `${groupDid}#atproto_pds`,
        lxm,
      });
      const qs = query ? `?${new URLSearchParams(query).toString()}` : "";
      const pathPrefix = method.includes("/") ? `/${method}` : `/xrpc/${method}`;
      const res = await net.fetchEndpoint(
        new Request(`${groupBase}${pathPrefix}${qs}`, {
          method: httpMethod,
          headers: {
            authorization: `Bearer ${svc.token}`,
            ...(body ? { "content-type": "application/json" } : {}),
            ...headers,
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
      const text = await res.text();
      return {
        status: res.status,
        headers: res.headers,
        json: (text ? JSON.parse(text) : {}) as never,
      };
    },
    async groupHttpCall({ path, method, headers, body }) {
      const reqBody: BodyInit | undefined =
        body instanceof Uint8Array ? new Uint8Array(body) : body;
      const res = await net.fetchEndpoint(
        new Request(`${groupBase}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${adminToken}`,
            ...headers,
          },
          ...(reqBody !== undefined ? { body: reqBody } : {}),
        }),
      );
      return {
        status: res.status,
        headers: res.headers,
        bytes: new Uint8Array(await res.arrayBuffer()),
      };
    },
    async unauthHttpCall({ path, method, headers, body }) {
      const reqBody: BodyInit | undefined =
        body instanceof Uint8Array ? new Uint8Array(body) : body;
      const res = await net.fetchEndpoint(
        new Request(`${groupBase}${path}`, {
          method,
          headers,
          ...(reqBody !== undefined ? { body: reqBody } : {}),
        }),
      );
      return {
        status: res.status,
        headers: res.headers,
        bytes: new Uint8Array(await res.arrayBuffer()),
      };
    },
    async provisionPersonalInvitesSpace(userDid: string) {
      await net.clientFor(userDid).procedure("com.atproto.space.createSpace", {
        spaceType: ATGRP_SPACE_TYPE.inbox,
        skey: SELF_SKEY,
        policy: {
          $type: MEMBERSPACE_POLICY,
          publicRead: false,
          publicWrite: true,
        },
      });
    },
    personalPdsEndpointForBob: "https://fake-pds.test/pds-bob",
    async getSourceServiceKeypairForTest() {
      return (net as unknown as { hostServiceKeypair: (slug: string) => Promise<P256Keypair> }).hostServiceKeypair(
        "group-host",
      );
    },
    async getPeerServiceKeypairForTest() {
      return (peerNet as unknown as { hostServiceKeypair: (slug: string) => Promise<P256Keypair> }).hostServiceKeypair(
        "group-host-2",
      );
    },
    setSourceOutboundInterceptor(fn) {
      sourceOutboundInterceptor = fn;
    },
    setPeerOutboundInterceptor(fn) {
      peerOutboundInterceptor = fn;
    },
    async flushSourceBackgroundWork() {
      await net.flushNotifications();
    },
    async flushPeerBackgroundWork() {
      await peerNet.flushNotifications();
    },
    expirePreparedSourceLeaseForTest(expiresAtMs: number) {
      const grp = (net as unknown as { groups: Map<string, { sourceMigrationLease: { expiresAt: number | null } | null }> }).groups.get(
        groupDid,
      );
      if (grp?.sourceMigrationLease) {
        grp.sourceMigrationLease.expiresAt = expiresAtMs;
      }
    },
    reapPreparedSourceLeaseWithClockSkewForTest(skewedSourceNowMs: number) {
      const internal = net as unknown as {
        groups: Map<string, { sourceMigrationLease: { expiresAt: number | null } | null }>;
        reapFakeExpiredPreparedMigrationLease: (grp: unknown) => void;
      };
      const grp = internal.groups.get(groupDid);
      if (grp?.sourceMigrationLease) {
        grp.sourceMigrationLease.expiresAt = skewedSourceNowMs - 1_000;
        const prevNow = net.now;
        net.now = () => skewedSourceNowMs;
        try {
          internal.reapFakeExpiredPreparedMigrationLease(grp);
        } finally {
          net.now = prevNow;
        }
      }
    },
    async getPeerGroupSigningKeyForTest() {
      const grp = (
        peerNet as unknown as {
          groups: Map<string, { migrationSession: { stagedSigningKey: P256Keypair } | null }>;
          signingKeypair: (did: string) => Promise<P256Keypair>;
        }
      ).groups.get(groupDid);
      if (grp?.migrationSession?.stagedSigningKey) {
        return grp.migrationSession.stagedSigningKey;
      }
      return (peerNet as unknown as { signingKeypair: (did: string) => Promise<P256Keypair> }).signingKeypair(
        groupDid,
      );
    },
    async createSiblingGroupForTest(where, slug) {
      const b32Part = slug
        .toLowerCase()
        .replace(/[^a-z2-7]/g, "")
        .padEnd(21, "a")
        .slice(0, 21);
      const sibDid = `did:plc:sib${b32Part}`;
      if (where === "source") {
        await net.createGroupAccount(sibDid, {
          creatorDid: aliceDid,
          name: `Sibling ${slug}`,
          handle: `${slug}.groups.test`,
          joinPolicy: "open",
          publicMeta: true,
        });
      } else {
        await peerNet.createGroupAccount(sibDid, {
          host: "group-host-2",
          creatorDid: aliceDid,
          name: `Sibling ${slug}`,
          handle: `${slug}.groups.test`,
          joinPolicy: "open",
          publicMeta: true,
        });
      }
      return sibDid;
    },
    setPeerStagingDeadlineForTest(deadlineAtMs: number, syncTicketExpiry = false) {
      const internal = peerNet as unknown as {
        groups: Map<
          string,
          { migrationSession: { absoluteDeadlineAt: number; mode: string; ticketId: string | null } | null }
        >;
        fakeAbortStorageEntries: Map<string, number>;
      };
      const grp = internal.groups.get(groupDid);
      if (grp?.migrationSession) {
        grp.migrationSession.absoluteDeadlineAt = deadlineAtMs;
        if (syncTicketExpiry && grp.migrationSession.mode === "coordinated" && grp.migrationSession.ticketId) {
          const peerSlug = new URL(peerBase).pathname.replace(/^\/+|\/+$/g, "") || "group-host";
          const tKey = `${peerSlug}\u0000${groupDid}\u0000ticket:${grp.migrationSession.ticketId}`;
          if (internal.fakeAbortStorageEntries.has(tKey)) {
            internal.fakeAbortStorageEntries.set(tKey, deadlineAtMs);
          }
        }
      }
    },
    async submitDirectPlcCutoverForTest(signedOp: Record<string, unknown>) {
      const internal = peerNet as unknown as {
        accounts: Map<string, string>;
        groups: Map<
          string,
          {
            localRotationKey: P256Keypair;
            sovereignRotationKeys: Set<string>;
            migrationSession: { stagedSigningKey: P256Keypair; stagedKemKey: P256Keypair } | null;
          }
        >;
        signingKeys: Map<string, Promise<P256Keypair>>;
        kemKeys: Map<string, Promise<P256Keypair>>;
        publishedSigningKeys: Map<string, string>;
        publishedKemKeys: Map<string, string>;
      };
      const grp = internal.groups.get(groupDid);
      assert.ok(grp?.migrationSession, "Expected staged migration session on peer FakeNetwork");
      internal.accounts.set(groupDid, "group-host-2");
      internal.signingKeys.set(groupDid, Promise.resolve(grp.migrationSession.stagedSigningKey));
      internal.kemKeys.set(groupDid, Promise.resolve(grp.migrationSession.stagedKemKey));
      internal.publishedSigningKeys.set(groupDid, grp.migrationSession.stagedSigningKey.did());
      internal.publishedKemKeys.set(groupDid, grp.migrationSession.stagedKemKey.did());
      if (Array.isArray(signedOp.rotationKeys)) {
        const localDid = grp.localRotationKey.did();
        grp.sovereignRotationKeys = new Set(
          signedOp.rotationKeys.filter((k): k is string => typeof k === "string" && k !== localDid),
        );
      }
    },
    async cleanup() {
      await net.flushNotifications();
      await peerNet.flushNotifications();
    },
    getPeerAbortStorageCountForTest() {
      const peerSlug = new URL(peerBase).pathname.replace(/^\/+|\/+$/g, "") || "group-host";
      return peerNet.getAbortStorageCountForTest(groupDid, peerSlug);
    },
    async withSigningDelayClockAdvanceForTest<T>(deltaMs: number, fn: () => Promise<T>): Promise<T> {
      const internal = net as unknown as {
        signFakeServiceJwt: (...args: unknown[]) => Promise<string>;
      };
      const origSign = internal.signFakeServiceJwt.bind(net);
      let advanced = false;
      internal.signFakeServiceJwt = async (...args: unknown[]) => {
        const tok = await origSign(...args);
        if (!advanced) {
          advanced = true;
          fakeClockOffsetMs += deltaMs;
        }
        return tok;
      };
      try {
        return await fn();
      } finally {
        fakeClockOffsetMs = 0;
        internal.signFakeServiceJwt = origSign;
      }
    },
  };
}

async function createRealDriver(opts: {
  joinPolicy?: "open" | "approval" | "invite";
  publicMeta?: boolean;
  withFlockWorkspace?: boolean;
}): Promise<ParityDriver> {
  const plc = await startMockPlcServer();
  const pds = await startMockPersonalPds(plc);
  let sourceOutboundInterceptor:
    | ((url: string, init: RequestInit | undefined, forward: () => Promise<Response>) => Promise<Response>)
    | undefined;
  let peerOutboundInterceptor:
    | ((url: string, init: RequestInit | undefined, forward: () => Promise<Response>) => Promise<Response>)
    | undefined;
  const host = await startTestGroupHost({
    plc,
    overrides: {
      fetchImpl: async (input, init) => {
        const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const forward = () => fetch(input, init);
        if (sourceOutboundInterceptor) {
          return sourceOutboundInterceptor(urlStr, init, forward);
        }
        return forward();
      },
    },
  });
  const peerHost = await startTestGroupHost({
    plc,
    overrides: {
      fetchImpl: async (input, init) => {
        const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const forward = () => fetch(input, init);
        if (peerOutboundInterceptor) {
          return peerOutboundInterceptor(urlStr, init, forward);
        }
        return forward();
      },
    },
  });

  const alice = await pds.registerUser("alice.test");
  const bob = await pds.registerUser("bob.test");
  const carol = await pds.registerUser("carol.test");
  const bot = await pds.registerUser("bot.test");
  const users = new Map([
    [alice.did, alice],
    [bob.did, bob],
    [carol.did, carol],
    [bot.did, bot],
  ]);

  const created = await completeGroupOAuthFlow({
    groupHost: host,
    pds,
    user: alice,
    prompt: "create",
    scope: groupAdminScopes().join(" "),
    createParams: {
      displayName: "Parity Group",
      joinPolicy: opts.joinPolicy ?? "approval",
      publicMeta: opts.publicMeta ?? true,
    },
  });
  assert.ok(created.tokenResponse);
  const groupDid = created.tokenResponse.sub;

  // Obtain an explicit `prompt=login` step-up session for destructive parity operations
  const steppedUp = await completeGroupOAuthFlow({
    groupHost: host,
    pds,
    user: alice,
    prompt: "login",
    loginHint: groupDid,
    scope: groupAdminScopes().join(" "),
  });
  assert.ok(steppedUp.tokenResponse);
  const adminAccessToken = steppedUp.tokenResponse.access_token;

  const makeDpopAtprotoClient = (dpop: typeof steppedUp.dpop, accessToken: string) =>
    new AtprotoClient(async (path, init) => {
      const reqBody: BodyInit | undefined =
        init.body instanceof Uint8Array ? new Uint8Array(init.body) : (init.body ?? undefined);
      return dpop.fetchWithDpop(`${host.url}${path}`, {
        method: init.method ?? "GET",
        headers: init.headers,
        ...(reqBody !== undefined ? { body: reqBody } : {}),
        accessToken,
      });
    });

  const adminClient = makeDpopAtprotoClient(steppedUp.dpop, adminAccessToken);

  if (opts.withFlockWorkspace ?? true) {
    await adminClient.procedure("com.atproto.space.createSpace", {
      spaceType: SPACE_TYPE.workspace,
      skey: SELF_SKEY,
      policy: {
        $type: ATGRP_POLICY,
        publicRead: false,
        unlisted: false,
        grants: [
          { role: "admin", read: true, write: true },
          { role: "member", read: true },
        ],
      },
    });
  }

  const descRepo = await adminClient.query<{ handle: string }>("com.atproto.repo.describeRepo", {
    repo: groupDid,
  });

  return {
    kind: "real",
    baseUrl: host.url,
    groupDid,
    groupHandle: descRepo.handle,
    peerMigrationEndpoint: peerHost.url,
    aliceDid: alice.did,
    bobDid: bob.did,
    carolDid: carol.did,
    botDid: bot.did,
    adminClient,
    rawFetch: (url: string, init: RequestInit) => fetch(url, init),
    async getLocalRotationKeyForTest() {
      const kp = await host.repoStore.getGroupRotationKey(groupDid);
      assert.ok(kp, "Expected group rotation key on real host");
      return kp as P256Keypair;
    },
    async getGroupSigningKeyForTest() {
      const row = host.db
        .prepare("SELECT signing_key_enc FROM group_account WHERE did = ?")
        .get(groupDid) as { signing_key_enc: string } | undefined;
      assert.ok(row, "Expected group_account row on real host");
      return (await host.cryptoBox.decryptKeypair(
        "group_account",
        groupDid,
        "signing_key_enc",
        row.signing_key_enc,
      )) as P256Keypair;
    },
    async getPersonalSigningKeyForTest(did: string) {
      const u = users.get(did);
      assert.ok(u, `Unknown test user DID ${did}`);
      return u.signingKey;
    },
    async clientForMemberWithScopes(did: string, scopes: readonly string[]) {
      const u = users.get(did)!;
      const scopedWithoutGroupArg = scopes.filter((s) => !s.includes(encodeURIComponent(`${groupDid}#atproto_pds`)));
      const flow = await completeGroupOAuthFlow({
        groupHost: host,
        pds,
        user: u,
        prompt: "login",
        loginHint: groupDid,
        scope: scopedWithoutGroupArg.join(" "),
      });
      assert.ok(flow.tokenResponse);
      return makeDpopAtprotoClient(flow.dpop, flow.tokenResponse.access_token);
    },
    async moderatorClientFor(did: string) {
      const u = users.get(did)!;
      const flow = await completeGroupOAuthFlow({
        groupHost: host,
        pds,
        user: u,
        loginHint: groupDid,
        scope: groupModeratorScopes().join(" "),
      });
      assert.ok(flow.tokenResponse);
      return makeDpopAtprotoClient(flow.dpop, flow.tokenResponse.access_token);
    },
    async recoveryClientFor(did: string) {
      const u = users.get(did)!;
      const flow = await completeGroupOAuthFlow({
        groupHost: host,
        pds,
        user: u,
        loginHint: groupDid,
        scope: "atproto account:status?action=manage",
      });
      assert.ok(flow.tokenResponse);
      return makeDpopAtprotoClient(flow.dpop, flow.tokenResponse.access_token);
    },
    async personalServiceCall({ callerDid, method, httpMethod, lxm, query, body, headers }) {
      const u = users.get(callerDid)!;
      const jwt = await u.signServiceJwt(`${groupDid}#atproto_pds`, lxm);
      const qs = query ? `?${new URLSearchParams(query).toString()}` : "";
      const pathPrefix = method.includes("/") ? `/${method}` : `/xrpc/${method}`;
      const res = await fetch(`${host.url}${pathPrefix}${qs}`, {
        method: httpMethod,
        headers: {
          authorization: `Bearer ${jwt}`,
          ...(body ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      return {
        status: res.status,
        headers: res.headers,
        json: (text ? JSON.parse(text) : {}) as never,
      };
    },
    async groupHttpCall({ path, method, headers, body }) {
      const reqBody: BodyInit | undefined =
        body instanceof Uint8Array ? new Uint8Array(body) : body;
      const res = await steppedUp.dpop.fetchWithDpop(`${host.url}${path}`, {
        method,
        headers,
        ...(reqBody !== undefined ? { body: reqBody } : {}),
        accessToken: adminAccessToken,
      });
      return {
        status: res.status,
        headers: res.headers,
        bytes: new Uint8Array(await res.arrayBuffer()),
      };
    },
    async unauthHttpCall({ path, method, headers, body }) {
      const reqBody: BodyInit | undefined =
        body instanceof Uint8Array ? new Uint8Array(body) : body;
      const res = await fetch(`${host.url}${path}`, {
        method,
        headers,
        ...(reqBody !== undefined ? { body: reqBody } : {}),
      });
      return {
        status: res.status,
        headers: res.headers,
        bytes: new Uint8Array(await res.arrayBuffer()),
      };
    },
    async provisionPersonalInvitesSpace() {
      // MockPersonalPds accepts notifyRepoUpdate on invites/self automatically unless failInviteDeliveryForDid is set.
    },
    personalPdsEndpointForBob: pds.url,
    async getSourceServiceKeypairForTest() {
      return host.migration.serviceKeys.activeKeypair as P256Keypair;
    },
    async getPeerServiceKeypairForTest() {
      return peerHost.migration.serviceKeys.activeKeypair as P256Keypair;
    },
    setSourceOutboundInterceptor(fn) {
      sourceOutboundInterceptor = fn;
    },
    setPeerOutboundInterceptor(fn) {
      peerOutboundInterceptor = fn;
    },
    async flushSourceBackgroundWork() {
      await host.flushBackgroundWork();
    },
    async flushPeerBackgroundWork() {
      await peerHost.flushBackgroundWork();
    },
    expirePreparedSourceLeaseForTest(expiresAtMs: number) {
      host.db
        .prepare("UPDATE source_migration_lease SET expires_at = ? WHERE group_did = ? AND status = 'prepared'")
        .run(expiresAtMs, groupDid);
    },
    reapPreparedSourceLeaseWithClockSkewForTest(skewedSourceNowMs: number) {
      host.db
        .prepare("UPDATE source_migration_lease SET expires_at = ? WHERE group_did = ? AND status = 'prepared'")
        .run(skewedSourceNowMs - 1_000, groupDid);
      reapExpiredPreparedMigrationLease(host.db, groupDid, skewedSourceNowMs);
    },
    async getPeerGroupSigningKeyForTest() {
      return (await peerHost.repoStore.getGroupSigningKey(groupDid)) as P256Keypair;
    },
    async createSiblingGroupForTest(where, slug) {
      const targetHost = where === "source" ? host : peerHost;
      const sibFlow = await completeGroupOAuthFlow({
        groupHost: targetHost,
        pds,
        user: alice,
        prompt: "create",
        scope: groupAdminScopes().join(" "),
        createParams: {
          displayName: `Sibling ${slug}`,
          handle: `${slug}.${targetHost.config.handleDomain}`,
          joinPolicy: "open",
          publicMeta: true,
        },
      });
      assert.ok(sibFlow.tokenResponse);
      return sibFlow.tokenResponse.sub;
    },
    setPeerStagingDeadlineForTest(deadlineAtMs: number, syncTicketExpiry = false) {
      if (syncTicketExpiry) {
        const sess = peerHost.db
          .prepare("SELECT mode, ticket_id FROM migration_session WHERE group_did = ?")
          .get(groupDid) as { mode: string; ticket_id: string | null } | undefined;
        if (sess?.mode === "coordinated" && sess.ticket_id) {
          peerHost.db
            .prepare("UPDATE service_jwt_jti SET expires_at = ? WHERE issuer_did = ? AND jti = ?")
            .run(deadlineAtMs, groupDid, `ticket:${sess.ticket_id}`);
        }
      }
      peerHost.db
        .prepare("UPDATE migration_session SET absolute_deadline_at = ? WHERE group_did = ?")
        .run(deadlineAtMs, groupDid);
    },
    async submitDirectPlcCutoverForTest(signedOp: Record<string, unknown>) {
      const plcRes = await fetch(`${plc.url}/${encodeURIComponent(groupDid)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(signedOp),
      });
      assert.equal(plcRes.status, 200, `Direct PLC cutover failed: ${await plcRes.text()}`);
    },
    async cleanup() {
      await peerHost.close();
      await host.close();
      await pds.close();
      await plc.close();
    },
    getPeerAbortStorageCountForTest() {
      const row = peerHost.db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM service_jwt_jti
           WHERE issuer_did = ? AND expires_at > ?
             AND (jti LIKE 'abort-jwt:%' OR jti LIKE 'aborted-op:%' OR jti LIKE 'ticket:%' OR jti LIKE 'lease-attempt:%')`,
        )
        .get(groupDid, Date.now()) as { cnt: number };
      return row.cnt;
    },
    async withSigningDelayClockAdvanceForTest<T>(deltaMs: number, fn: () => Promise<T>): Promise<T> {
      const origGetKey = host.repoStore.getGroupSigningKey.bind(host.repoStore);
      const origDateNow = Date.now;
      let realClockOffsetMs = 0;
      let advanced = false;
      Date.now = () => origDateNow() + realClockOffsetMs;
      host.repoStore.getGroupSigningKey = async (did: string) => {
        const kp = await origGetKey(did);
        return new Proxy(kp, {
          get(target, prop, receiver) {
            if (prop === "sign") {
              return async (...args: unknown[]) => {
                const sig = await (target.sign as (...a: unknown[]) => Promise<Uint8Array>).apply(target, args);
                if (!advanced) {
                  advanced = true;
                  realClockOffsetMs += deltaMs;
                }
                return sig;
              };
            }
            const val = Reflect.get(target, prop, receiver);
            return typeof val === "function" ? val.bind(target) : val;
          },
        });
      };
      try {
        return await fn();
      } finally {
        Date.now = origDateNow;
        host.repoStore.getGroupSigningKey = origGetKey;
      }
    },
  };
}

async function captureErrorCode(fn: () => Promise<unknown>): Promise<{ status: number; code: string }> {
  try {
    await fn();
    assert.fail("Expected XrpcError");
  } catch (err) {
    assert.ok(err instanceof XrpcError, `Expected XrpcError, got ${String(err)}`);
    return { status: err.status, code: err.code };
  }
}

test("FakeNetwork vs real GroupHostServer parity: space indexing, RBAC anti-escalation, app principals & core-space protection", async () => {
  const fake = await createFakeDriver({ joinPolicy: "approval", publicMeta: true, withFlockWorkspace: true });
  const real = await createRealDriver({ joinPolicy: "approval", publicMeta: true, withFlockWorkspace: true });

  try {
    for (const d of [fake, real]) {
      // 1. Core spaces & public declaration exist; membership getRecord emits Atproto-Membership-Incarnation header
      const decl = await d.adminClient.query<{ value: { $type: string } }>("com.atproto.repo.getRecord", {
        repo: d.groupDid,
        collection: REPO_COLLECTION.groupDeclaration,
        rkey: SELF_SKEY,
      });
      assert.equal(decl.value.$type, REPO_COLLECTION.groupDeclaration);

      const memHttp = await d.groupHttpCall({
        path: `/xrpc/com.atproto.space.getRecord?space=${encodeURIComponent(groupMembersUri(d.groupDid))}&repo=${encodeURIComponent(d.groupDid)}&collection=${encodeURIComponent(ATGRP_COLLECTION.membership)}&rkey=${encodeURIComponent(d.aliceDid)}`,
        method: "GET",
      });
      assert.equal(memHttp.status, 200);
      const incHeader = memHttp.headers.get("atproto-membership-incarnation");
      assert.ok(typeof incHeader === "string" && incHeader.length > 0, `[${d.kind}] missing Atproto-Membership-Incarnation`);
      const memJson = JSON.parse(Buffer.from(memHttp.bytes).toString("utf8")) as { value: Record<string, unknown> };
      assert.equal(memJson.value[FLOCK_EXTENSION_FIELD.incarnation], incHeader);

      // 2. Modality space auto-indexing in members/self & unlisted de-indexing
      const chanUri = channelUri(d.groupDid, "general");
      await d.adminClient.procedure("com.atproto.space.createSpace", {
        spaceType: SPACE_TYPE.channel,
        skey: "general",
        policy: {
          $type: ATGRP_POLICY,
          publicRead: false,
          unlisted: false,
          grants: [
            { role: "admin", read: true, write: true },
            { role: "member", read: true, write: true },
          ],
        },
      });
      const idxBefore = await d.adminClient.query<{ records: Array<{ value: { space: string } }> }>(
        "com.atproto.space.listRecords",
        {
          space: groupMembersUri(d.groupDid),
          repo: d.groupDid,
          collection: ATGRP_COLLECTION.space,
        },
      );
      assert.ok(idxBefore.records.some((r) => r.value.space === chanUri), `[${d.kind}] listed channel must appear in space index`);
      assert.ok(!idxBefore.records.some((r) => r.value.space === groupMetaUri(d.groupDid)));
      assert.ok(!idxBefore.records.some((r) => r.value.space === groupMembersUri(d.groupDid)));

      await d.adminClient.procedure("com.atproto.space.updateSpace", {
        space: chanUri,
        policy: {
          $type: ATGRP_POLICY,
          publicRead: false,
          unlisted: true,
          grants: [{ role: "admin", read: true, write: true }],
        },
      });
      const idxAfter = await d.adminClient.query<{ records: Array<{ value: { space: string } }> }>(
        "com.atproto.space.listRecords",
        {
          space: groupMembersUri(d.groupDid),
          repo: d.groupDid,
          collection: ATGRP_COLLECTION.space,
        },
      );
      assert.ok(!idxAfter.records.some((r) => r.value.space === chanUri), `[${d.kind}] unlisted channel must be removed from index`);
    }

    // 3. Direct write to org.atgrp.space -> 400 IndexHostMaintained on both
    const fakeIdxErr = await captureErrorCode(() =>
      fake.adminClient.procedure("com.atproto.space.createRecord", {
        space: groupMembersUri(fake.groupDid),
        repo: fake.groupDid,
        collection: ATGRP_COLLECTION.space,
        record: { space: channelUri(fake.groupDid, "general"), createdAt: new Date().toISOString() },
      }),
    );
    const realIdxErr = await captureErrorCode(() =>
      real.adminClient.procedure("com.atproto.space.createRecord", {
        space: groupMembersUri(real.groupDid),
        repo: real.groupDid,
        collection: ATGRP_COLLECTION.space,
        record: { space: channelUri(real.groupDid, "general"), createdAt: new Date().toISOString() },
      }),
    );
    assert.deepEqual(fakeIdxErr, { status: 400, code: "IndexHostMaintained" });
    assert.deepEqual(realIdxErr, fakeIdxErr);

    // 4. Core spaces cannot be deleted -> 400 CannotDeleteCoreSpace
    const fakeDelCore = await captureErrorCode(() =>
      fake.adminClient.procedure("com.atproto.space.deleteSpace", { space: groupMetaUri(fake.groupDid) }),
    );
    const realDelCore = await captureErrorCode(() =>
      real.adminClient.procedure("com.atproto.space.deleteSpace", { space: groupMetaUri(real.groupDid) }),
    );
    assert.deepEqual(fakeDelCore, { status: 400, code: "CannotDeleteCoreSpace" });
    assert.deepEqual(realDelCore, fakeDelCore);

    // 5. LastAdmin protection on Flock workspace
    const fakeLastAdmin = await captureErrorCode(() =>
      fake.adminClient.procedure("com.atproto.space.putRecord", {
        space: groupMembersUri(fake.groupDid),
        repo: fake.groupDid,
        collection: ATGRP_COLLECTION.membership,
        rkey: fake.aliceDid,
        record: { roles: ["member"], createdAt: new Date().toISOString() },
      }),
    );
    const realLastAdmin = await captureErrorCode(() =>
      real.adminClient.procedure("com.atproto.space.putRecord", {
        space: groupMembersUri(real.groupDid),
        repo: real.groupDid,
        collection: ATGRP_COLLECTION.membership,
        rkey: real.aliceDid,
        record: { roles: ["member"], createdAt: new Date().toISOString() },
      }),
    );
    assert.deepEqual(fakeLastAdmin, { status: 400, code: "LastAdmin" });
    assert.deepEqual(realLastAdmin, fakeLastAdmin);

    // 6. Moderator anti-escalation (`RoleNotAssignable` & live narrowing)
    for (const d of [fake, real]) {
      await d.adminClient.procedure("com.atproto.space.putRecord", {
        space: groupMembersUri(d.groupDid),
        repo: d.groupDid,
        collection: ATGRP_COLLECTION.membership,
        rkey: d.bobDid,
        record: { roles: ["moderator", "member"], createdAt: new Date().toISOString() },
      });
    }
    const fakeMod = await fake.moderatorClientFor(fake.bobDid);
    const realMod = await real.moderatorClientFor(real.bobDid);

    // Moderator holds `authModerate` (delete membership) + `canAssign: ["member"]`:
    // trying to eject an `admin` (Alice) fails with `403 RoleNotAssignable`!
    const fakeEscalate = await captureErrorCode(() =>
      fakeMod.procedure("com.atproto.space.deleteRecord", {
        space: groupMembersUri(fake.groupDid),
        repo: fake.groupDid,
        collection: ATGRP_COLLECTION.membership,
        rkey: fake.aliceDid,
      }),
    );
    const realEscalate = await captureErrorCode(() =>
      realMod.procedure("com.atproto.space.deleteRecord", {
        space: groupMembersUri(real.groupDid),
        repo: real.groupDid,
        collection: ATGRP_COLLECTION.membership,
        rkey: real.aliceDid,
      }),
    );
    assert.deepEqual(fakeEscalate, { status: 403, code: "RoleNotAssignable" });
    assert.deepEqual(realEscalate, fakeEscalate);

    // 7. App service principal install + tombstone protection (`SubjectIsAppServicePrincipal` & `CannotDeleteWorkspaceWithAppTombstones`)
    for (const d of [fake, real]) {
      const botRole = appRoleKey(d.botDid);
      const nowIso = new Date().toISOString();
      await d.adminClient.procedure("com.atproto.space.putRecord", {
        space: workspaceUri(d.groupDid),
        repo: d.groupDid,
        collection: COLLECTION.appInstall,
        rkey: subjectKey(d.botDid),
        record: {
          subject: d.botDid,
          active: true,
          channels: [{ skey: "general", write: true }],
          installedBy: d.aliceDid,
          installedAt: nowIso,
          updatedAt: nowIso,
        },
      });
      await d.adminClient.procedure("com.atproto.space.putRecord", {
        space: groupMembersUri(d.groupDid),
        repo: d.groupDid,
        collection: ATGRP_COLLECTION.role,
        rkey: botRole,
        record: { displayName: `App: ${d.botDid}` },
      });
      await d.adminClient.procedure("com.atproto.space.putRecord", {
        space: groupMembersUri(d.groupDid),
        repo: d.groupDid,
        collection: ATGRP_COLLECTION.membership,
        rkey: d.botDid,
        record: { roles: [botRole], createdAt: new Date().toISOString() },
      });

      const botJoin = await d.personalServiceCall<{ error?: string }>({
        callerDid: d.botDid,
        method: ATGRP_METHOD.requestJoin,
        httpMethod: "POST",
        lxm: ATGRP_METHOD.requestJoin,
        body: { group: d.groupDid },
      });
      assert.equal(botJoin.status, 400);
      assert.equal(botJoin.json.error, "SubjectIsAppServicePrincipal");

      const delWs = await captureErrorCode(() =>
        d.adminClient.procedure("com.atproto.space.deleteSpace", { space: workspaceUri(d.groupDid) }),
      );
      assert.deepEqual(delWs, { status: 400, code: "CannotDeleteWorkspaceWithAppTombstones" });
    }
  } finally {
    await fake.cleanup();
    await real.cleanup();
  }
});

test("FakeNetwork vs real GroupHostServer parity: 6-case requestJoin, invitations, moderation, STAR export & sole-member deactivation", async () => {
  const fake = await createFakeDriver({ joinPolicy: "approval", publicMeta: true, withFlockWorkspace: true });
  const real = await createRealDriver({ joinPolicy: "approval", publicMeta: true, withFlockWorkspace: true });

  try {
    for (const d of [fake, real]) {
      await d.provisionPersonalInvitesSpace(d.carolDid);

      // 1. Approval join request + Idempotency-Key replay + mismatch (`409`)
      const req1 = await d.personalServiceCall<{ status: string; request: { member: string; message?: string } }>({
        callerDid: d.bobDid,
        method: ATGRP_METHOD.requestJoin,
        httpMethod: "POST",
        lxm: ATGRP_METHOD.requestJoin,
        body: { group: d.groupDid, message: "Please let me in" },
        headers: { "idempotency-key": "op-bob-1" },
      });
      assert.equal(req1.status, 200);
      assert.equal(req1.json.status, "pending");
      assert.equal(req1.json.request.member, d.bobDid);

      const mismatch = await d.personalServiceCall<{ error?: string }>({
        callerDid: d.bobDid,
        method: ATGRP_METHOD.requestJoin,
        httpMethod: "POST",
        lxm: ATGRP_METHOD.requestJoin,
        body: { group: d.groupDid, message: "Different message" },
        headers: { "idempotency-key": "op-bob-1" },
      });
      assert.equal(mismatch.status, 409);
      assert.equal(mismatch.json.error, "IdempotencyParameterMismatch");

      const statusPending = await d.personalServiceCall<{ state: string }>({
        callerDid: d.bobDid,
        method: "group-member/join-status",
        httpMethod: "GET",
        lxm: ATGRP_METHOD.requestJoin,
        query: { group: d.groupDid, operationId: "op-bob-1" },
      });
      assert.equal(statusPending.status, 200);
      assert.equal(statusPending.json.state, "pending");

      // 2. If-Join-Request-Present CAS succeeds for Bob (`200`) and fails for Carol (`409 JoinRequestNotFound`)
      const carolNoReq = await d.groupHttpCall({
        path: "/xrpc/com.atproto.space.putRecord",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "if-join-request-present": "true",
        },
        body: JSON.stringify({
          space: groupMembersUri(d.groupDid),
          repo: d.groupDid,
          collection: ATGRP_COLLECTION.membership,
          rkey: d.carolDid,
          record: { roles: ["member"], createdAt: new Date().toISOString() },
        }),
      });
      assert.equal(carolNoReq.status, 409);
      assert.equal(
        (JSON.parse(Buffer.from(carolNoReq.bytes).toString("utf8")) as { error: string }).error,
        "JoinRequestNotFound",
      );

      const bobApprove = await d.groupHttpCall({
        path: "/xrpc/com.atproto.space.putRecord",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "if-join-request-present": "true",
        },
        body: JSON.stringify({
          space: groupMembersUri(d.groupDid),
          repo: d.groupDid,
          collection: ATGRP_COLLECTION.membership,
          rkey: d.bobDid,
          record: { roles: ["member"], createdAt: new Date().toISOString() },
        }),
      });
      assert.equal(bobApprove.status, 200);

      const statusAdmitted = await d.personalServiceCall<{ state: string; currentIncarnation: string }>({
        callerDid: d.bobDid,
        method: "group-member/join-status",
        httpMethod: "GET",
        lxm: ATGRP_METHOD.requestJoin,
        query: { group: d.groupDid, operationId: "op-bob-1" },
      });
      assert.equal(statusAdmitted.status, 200);
      assert.equal(statusAdmitted.json.state, "admitted");
      assert.ok(typeof statusAdmitted.json.currentIncarnation === "string");

      // 3. Cross-PDS invitation write + invite-deliveries + requestJoin invite redemption
      const inviteSpace = personalInboxUri(d.carolDid);
      const createdInvite = await d.adminClient.procedure<Record<string, unknown>, { uri: string }>(
        "com.atproto.space.createRecord",
        {
          space: inviteSpace,
          repo: d.groupDid,
          collection: ATGRP_COLLECTION.invite,
          record: {
            group: d.groupDid,
            createdBy: d.aliceDid,
            createdAt: new Date().toISOString(),
          },
        },
      );
      const delivs = await d.groupHttpCall({ path: "/group-admin/invite-deliveries", method: "GET" });
      assert.equal(delivs.status, 200);
      const delivBody = JSON.parse(Buffer.from(delivs.bytes).toString("utf8")) as {
        deliveries: Array<{ inviteUri: string; status: string }>;
      };
      assert.ok(delivBody.deliveries.some((x) => x.inviteUri === createdInvite.uri));

      const carolRedeem = await d.personalServiceCall<{ status: string }>({
        callerDid: d.carolDid,
        method: ATGRP_METHOD.requestJoin,
        httpMethod: "POST",
        lxm: ATGRP_METHOD.requestJoin,
        body: { group: d.groupDid, invite: createdInvite.uri },
      });
      assert.equal(carolRedeem.status, 200);
      assert.equal(carolRedeem.json.status, "admitted");

      // 4. Moderation: submitReport, label.record -> labelEvent, eject -> ejectEvent, updateSubject
      const rep = await d.personalServiceCall<{ eventId: string }>({
        callerDid: d.bobDid,
        method: ATGRP_METHOD.modSubmitReport,
        httpMethod: "POST",
        lxm: ATGRP_METHOD.modSubmitReport,
        body: {
          group: d.groupDid,
          subject: d.carolDid,
          reasonType: "org.atgrp.mod.defs#reasonSpam",
          reason: "Spamming invites",
        },
      });
      assert.equal(rep.status, 200);
      assert.ok(rep.json.eventId.startsWith("ev-"));

      await d.adminClient.procedure("com.atproto.space.createRecord", {
        space: groupMembersUri(d.groupDid),
        repo: d.groupDid,
        collection: ATPROTO_SPACE_COLLECTION.label,
        record: {
          src: d.groupDid,
          uri: d.carolDid,
          val: "!hide",
          cts: new Date().toISOString(),
        },
      });

      await d.adminClient.procedure("com.atproto.space.deleteRecord", {
        space: groupMembersUri(d.groupDid),
        repo: d.groupDid,
        collection: ATGRP_COLLECTION.membership,
        rkey: d.carolDid,
      });

      const hist = await d.adminClient.query<{ events: Array<{ event: { $type: string } }> }>(
        ATGRP_METHOD.modQuerySubjectHistory,
        { subject: d.carolDid, sort: "oldest" },
      );
      assert.deepEqual(
        hist.events.map((e) => e.event.$type),
        [
          "org.atgrp.mod.defs#reportEvent",
          "org.atgrp.mod.defs#labelEvent",
          "org.atgrp.mod.defs#ejectEvent",
        ],
      );

      const resolved = await d.adminClient.procedure<Record<string, unknown>, { status: string }>(
        ATGRP_METHOD.modUpdateSubject,
        { subject: d.carolDid, status: "resolved", note: "Handled" },
      );
      assert.equal(resolved.status, "resolved");

      // 5. Blob upload + STAR exportSpaceMeta & getRepo round-trip
      const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
      const upBlob = await d.groupHttpCall({
        path: "/xrpc/com.atproto.repo.uploadBlob",
        method: "POST",
        headers: { "content-type": "image/png" },
        body: pngBytes,
      });
      assert.equal(upBlob.status, 200);
      const uploadedBlob = (JSON.parse(Buffer.from(upBlob.bytes).toString("utf8")) as { blob: Record<string, unknown> }).blob;

      await d.adminClient.procedure("com.atproto.space.putRecord", {
        space: groupMetaUri(d.groupDid),
        repo: d.groupDid,
        collection: ATGRP_COLLECTION.about,
        rkey: SELF_SKEY,
        record: {
          displayName: "Parity Group",
          avatar: uploadedBlob,
        },
      });

      const metaExport = await d.groupHttpCall({
        path: `/xrpc/com.atproto.space.exportSpaceMeta?space=${encodeURIComponent(groupMetaUri(d.groupDid))}`,
        method: "GET",
      });
      assert.equal(metaExport.status, 200);
      const parsedMeta = await readSpaceMetaStar([metaExport.bytes]);
      assert.equal(parsedMeta.space, groupMetaUri(d.groupDid));

      const repoExport = await d.groupHttpCall({
        path: `/xrpc/com.atproto.space.getRepo?space=${encodeURIComponent(groupMetaUri(d.groupDid))}&repo=${encodeURIComponent(d.groupDid)}`,
        method: "GET",
      });
      assert.equal(repoExport.status, 200);
      const parsedRepo = await readRepoStar([repoExport.bytes]);
      const exportedCols: string[] = [];
      for await (const rec of parsedRepo.records) {
        exportedCols.push(rec.collection);
      }
      assert.ok(exportedCols.includes(ATGRP_COLLECTION.about));

      // 6. LeaveGroup CAS mismatch (`409`) -> Bob leaves -> Alice sole-member leaves -> reversible deactivation + reactivation!
      const badLeave = await d.personalServiceCall<{ error?: string }>({
        callerDid: d.bobDid,
        method: ATGRP_METHOD.leaveGroup,
        httpMethod: "POST",
        lxm: ATGRP_METHOD.leaveGroup,
        body: { group: d.groupDid },
        headers: { "if-match-membership-incarnation": "wrong-incarnation" },
      });
      assert.equal(badLeave.status, 409);
      assert.equal(badLeave.json.error, "MembershipIncarnationMismatch");

      const bobLeave = await d.personalServiceCall({
        callerDid: d.bobDid,
        method: ATGRP_METHOD.leaveGroup,
        httpMethod: "POST",
        lxm: ATGRP_METHOD.leaveGroup,
        body: { group: d.groupDid },
        headers: { "if-match-membership-incarnation": statusAdmitted.json.currentIncarnation },
      });
      assert.equal(bobLeave.status, 200);

      const aliceLeave = await d.personalServiceCall({
        callerDid: d.aliceDid,
        method: ATGRP_METHOD.leaveGroup,
        httpMethod: "POST",
        lxm: ATGRP_METHOD.leaveGroup,
        body: { group: d.groupDid },
      });
      assert.equal(aliceLeave.status, 200);

      const aliceDeactStatus = await d.personalServiceCall<{ state: string }>({
        callerDid: d.aliceDid,
        method: "group-member/join-status",
        httpMethod: "GET",
        lxm: ATGRP_METHOD.requestJoin,
        query: { group: d.groupDid },
      });
      assert.equal(aliceDeactStatus.status, 200);
      assert.equal(aliceDeactStatus.json.state, "left_deactivated");

      const recClient = await d.recoveryClientFor(d.aliceDid);
      await recClient.procedure("com.atproto.server.activateAccount", {});

      const aliceRejoined = await d.personalServiceCall<{ state: string }>({
        callerDid: d.aliceDid,
        method: "group-member/join-status",
        httpMethod: "GET",
        lxm: ATGRP_METHOD.requestJoin,
        query: { group: d.groupDid },
      });
      assert.equal(aliceRejoined.status, 200);
      assert.equal(aliceRejoined.json.state, "admitted");
    }
  } finally {
    await fake.cleanup();
    await real.cleanup();
  }
});

test("FakeNetwork vs real GroupHostServer parity: policy read/write/assignable anti-escalation, role delete & structural wildcard containment", async () => {
  const fake = await createFakeDriver({ joinPolicy: "approval", publicMeta: true, withFlockWorkspace: true });
  const real = await createRealDriver({ joinPolicy: "approval", publicMeta: true, withFlockWorkspace: true });

  try {
    for (const d of [fake, real]) {
      // Seed an unassignable role (`secret-team`), a helper role (`channel-mgr`) holding exact probe permissions
      // + `manage=update` on `new.flock.channel` + role CRUD on `members/self`, and assign `bobDid` to `channel-mgr`.
      await d.adminClient.procedure("com.atproto.space.putRecord", {
        space: groupMembersUri(d.groupDid),
        repo: d.groupDid,
        collection: ATGRP_COLLECTION.role,
        rkey: "secret-team",
        record: { displayName: "Secret Team", permissions: [] },
      });
      await d.adminClient.procedure("com.atproto.space.putRecord", {
        space: groupMembersUri(d.groupDid),
        repo: d.groupDid,
        collection: ATGRP_COLLECTION.role,
        rkey: "channel-mgr",
        record: {
          displayName: "Channel Manager",
          canAssign: ["member"],
          permissions: [
            "space:new.flock.channel?manage=create&manage=update",
            "space:org.atgrp.members?authority=self&skey=self&collection=org.atgrp.role&action=create&action=update&action=delete",
            "blob:image/png",
            "repo:app.bsky.feed.post?action=create&action=update&action=delete",
            `rpc:app.bsky.actor.getProfile?aud=${encodeURIComponent(`${d.groupDid}#atproto_pds`)}`,
            "rpc:com.atproto.server.createAccount?aud=did:plc:zzzzzzzzzzzzzzzzzzzzzzzz%23atproto_pds",
            "space:com.example.probe?authority=self&skey=self&collection=com.example.probe.item&action=read&action=create&action=update&action=delete&manage=create&manage=update&manage=delete",
          ],
        },
      });
      await d.adminClient.procedure("com.atproto.space.putRecord", {
        space: groupMembersUri(d.groupDid),
        repo: d.groupDid,
        collection: ATGRP_COLLECTION.membership,
        rkey: d.bobDid,
        record: { roles: ["channel-mgr", "member"], createdAt: new Date().toISOString() },
      });

      const bobClient = await d.clientForMemberWithScopes(d.bobDid, [
        "atproto",
        "space:new.flock.channel?manage=create&manage=update",
        "space:org.atgrp.members?authority=self&skey=self&collection=org.atgrp.role&action=create&action=update&action=delete",
      ]);

      // 1. Role create / update / delete anti-escalation on unassignable roles + no self-assignable exemption!
      const createUnassignable = await captureErrorCode(() =>
        bobClient.procedure("com.atproto.space.putRecord", {
          space: groupMembersUri(d.groupDid),
          repo: d.groupDid,
          collection: ATGRP_COLLECTION.role,
          rkey: "rogue-role",
          record: { displayName: "Rogue", permissions: [] },
        }),
      );
      assert.deepEqual(createUnassignable, { status: 403, code: "PrivilegeEscalation" }, `[${d.kind}] create unassignable role`);

      const updateUnassignable = await captureErrorCode(() =>
        bobClient.procedure("com.atproto.space.putRecord", {
          space: groupMembersUri(d.groupDid),
          repo: d.groupDid,
          collection: ATGRP_COLLECTION.role,
          rkey: "secret-team",
          record: { displayName: "Tampered Secret Team", permissions: [] },
        }),
      );
      assert.deepEqual(updateUnassignable, { status: 403, code: "PrivilegeEscalation" }, `[${d.kind}] update unassignable role`);

      const deleteUnassignable = await captureErrorCode(() =>
        bobClient.procedure("com.atproto.space.deleteRecord", {
          space: groupMembersUri(d.groupDid),
          repo: d.groupDid,
          collection: ATGRP_COLLECTION.role,
          rkey: "secret-team",
        }),
      );
      assert.deepEqual(deleteUnassignable, { status: 403, code: "PrivilegeEscalation" }, `[${d.kind}] deleteRecord unassignable role`);

      const applyDeleteUnassignable = await captureErrorCode(() =>
        bobClient.procedure("com.atproto.space.applyWrites", {
          space: groupMembersUri(d.groupDid),
          repo: d.groupDid,
          writes: [
            {
              $type: "com.atproto.space.applyWrites#delete",
              collection: ATGRP_COLLECTION.role,
              rkey: "secret-team",
            },
          ],
        }),
      );
      assert.deepEqual(applyDeleteUnassignable, { status: 403, code: "PrivilegeEscalation" }, `[${d.kind}] applyWrites#delete unassignable role`);

      const grantUnassignableInAssignable = await captureErrorCode(() =>
        bobClient.procedure("com.atproto.space.putRecord", {
          space: groupMembersUri(d.groupDid),
          repo: d.groupDid,
          collection: ATGRP_COLLECTION.role,
          rkey: "member",
          record: {
            displayName: "Member",
            default: true,
            canAssign: ["secret-team"],
            permissions: [],
          },
        }),
      );
      assert.deepEqual(grantUnassignableInAssignable, { status: 403, code: "PrivilegeEscalation" }, `[${d.kind}] assignable escalation`);

      // Also verify there is no self-assignable exemption when creating/updating a role not in caller's assignable set!
      const selfAssignableBypass = await captureErrorCode(() =>
        bobClient.procedure("com.atproto.space.putRecord", {
          space: groupMembersUri(d.groupDid),
          repo: d.groupDid,
          collection: ATGRP_COLLECTION.role,
          rkey: "self-boot",
          record: {
            displayName: "Self Boot",
            canAssign: ["self-boot"],
            permissions: [],
          },
        }),
      );
      assert.deepEqual(selfAssignableBypass, { status: 403, code: "PrivilegeEscalation" }, `[${d.kind}] self-assignable bypass`);

      // 2. Structural wildcard containment (holding exact sampled probe strings MUST NOT allow minting wildcards!)
      const wildcardEscalations = [
        "blob:image/*",
        "blob:*/*",
        "repo:*",
        "rpc:*?aud=did:plc:zzzzzzzzzzzzzzzzzzzzzzzz%23atproto_pds",
        "rpc:app.bsky.actor.getProfile?aud=*",
        "space:*?collection=com.example.probe.item&action=read",
        "space:com.example.probe?authority=*&skey=self&collection=com.example.probe.item&action=read",
        "space:com.example.probe?authority=self&skey=*&collection=com.example.probe.item&action=read",
        "space:com.example.probe?authority=self&skey=self&collection=*&action=create",
      ];
      for (const candidateScope of wildcardEscalations) {
        const wcErr = await captureErrorCode(() =>
          bobClient.procedure("com.atproto.space.putRecord", {
            space: groupMembersUri(d.groupDid),
            repo: d.groupDid,
            collection: ATGRP_COLLECTION.role,
            rkey: "member",
            record: {
              displayName: "Member",
              default: true,
              permissions: [candidateScope],
            },
          }),
        );
        assert.deepEqual(
          wcErr,
          { status: 403, code: "PrivilegeEscalation" },
          `[${d.kind}] wildcard scope '${candidateScope}' must be rejected`,
        );
      }

      // Narrow subset of caller's exact scopes IS permitted on assignable `member`
      await bobClient.procedure("com.atproto.space.putRecord", {
        space: groupMembersUri(d.groupDid),
        repo: d.groupDid,
        collection: ATGRP_COLLECTION.role,
        rkey: "member",
        record: {
          displayName: "Member",
          default: true,
          permissions: ["blob:image/png", "repo:app.bsky.feed.post?action=create"],
        },
      });
      // Restore `member` to empty scopes
      await bobClient.procedure("com.atproto.space.putRecord", {
        space: groupMembersUri(d.groupDid),
        repo: d.groupDid,
        collection: ATGRP_COLLECTION.role,
        rkey: "member",
        record: { displayName: "Member", default: true, permissions: [] },
      });

      // 3. Policy `read` / `write` / `publicRead` / `unlisted` / `assignable` anti-escalation
      const secretChanUri = channelUri(d.groupDid, "secret-room");
      await d.adminClient.procedure("com.atproto.space.createSpace", {
        spaceType: SPACE_TYPE.channel,
        skey: "secret-room",
        policy: {
          $type: ATGRP_POLICY,
          publicRead: false,
          unlisted: true,
          grants: [
            { role: "admin", read: true, write: true },
            { role: "secret-team", read: true },
          ],
        },
      });

      // 3a. Cannot modify unassignable role (`secret-team`) or remove unassignable role (`admin`) in policy.grants
      const modUnassignableGrant = await captureErrorCode(() =>
        bobClient.procedure("com.atproto.space.updateSpace", {
          space: secretChanUri,
          policy: {
            $type: ATGRP_POLICY,
            publicRead: false,
            unlisted: true,
            grants: [
              { role: "admin", read: true, write: true },
              { role: "secret-team", read: true, write: true },
            ],
          },
        }),
      );
      assert.deepEqual(modUnassignableGrant, { status: 403, code: "PrivilegeEscalation" }, `[${d.kind}] modify unassignable grant`);

      const dropAdminGrant = await captureErrorCode(() =>
        bobClient.procedure("com.atproto.space.updateSpace", {
          space: secretChanUri,
          policy: {
            $type: ATGRP_POLICY,
            publicRead: false,
            unlisted: true,
            grants: [{ role: "secret-team", read: true }],
          },
        }),
      );
      assert.deepEqual(dropAdminGrant, { status: 403, code: "PrivilegeEscalation" }, `[${d.kind}] remove unassignable admin grant`);

      // 3b. Without holding `read` on `secret-room`, Bob cannot grant `read: true` to assignable `member`,
      //     enable `publicRead: true`, or flip `unlisted: false`!
      const grantReadWithoutRead = await captureErrorCode(() =>
        bobClient.procedure("com.atproto.space.updateSpace", {
          space: secretChanUri,
          policy: {
            $type: ATGRP_POLICY,
            publicRead: false,
            unlisted: true,
            grants: [
              { role: "admin", read: true, write: true },
              { role: "secret-team", read: true },
              { role: "member", read: true },
            ],
          },
        }),
      );
      assert.deepEqual(grantReadWithoutRead, { status: 403, code: "PrivilegeEscalation" }, `[${d.kind}] self-grant read on private channel`);

      const enablePublicRead = await captureErrorCode(() =>
        bobClient.procedure("com.atproto.space.updateSpace", {
          space: secretChanUri,
          policy: {
            $type: ATGRP_POLICY,
            publicRead: true,
            unlisted: true,
            grants: [
              { role: "admin", read: true, write: true },
              { role: "secret-team", read: true },
            ],
          },
        }),
      );
      assert.deepEqual(enablePublicRead, { status: 403, code: "PrivilegeEscalation" }, `[${d.kind}] enable publicRead without read`);

      const flipUnlisted = await captureErrorCode(() =>
        bobClient.procedure("com.atproto.space.updateSpace", {
          space: secretChanUri,
          policy: {
            $type: ATGRP_POLICY,
            publicRead: false,
            unlisted: false,
            grants: [
              { role: "admin", read: true, write: true },
              { role: "secret-team", read: true },
            ],
          },
        }),
      );
      assert.deepEqual(flipUnlisted, { status: 403, code: "PrivilegeEscalation" }, `[${d.kind}] flip unlisted without read`);

      // 3c. Admin grants `channel-mgr` `read: true` (but NOT `write: true`) on `secret-room`:
      //     Bob can now grant `member` `read: true`, but STILL cannot grant `member` `write: true`!
      await d.adminClient.procedure("com.atproto.space.updateSpace", {
        space: secretChanUri,
        policy: {
          $type: ATGRP_POLICY,
          publicRead: false,
          unlisted: true,
          grants: [
            { role: "admin", read: true, write: true },
            { role: "secret-team", read: true },
            { role: "channel-mgr", read: true },
          ],
        },
      });

      await bobClient.procedure("com.atproto.space.updateSpace", {
        space: secretChanUri,
        policy: {
          $type: ATGRP_POLICY,
          publicRead: false,
          unlisted: true,
          grants: [
            { role: "admin", read: true, write: true },
            { role: "secret-team", read: true },
            { role: "channel-mgr", read: true },
            { role: "member", read: true },
          ],
        },
      });

      const grantWriteWithoutWrite = await captureErrorCode(() =>
        bobClient.procedure("com.atproto.space.updateSpace", {
          space: secretChanUri,
          policy: {
            $type: ATGRP_POLICY,
            publicRead: false,
            unlisted: true,
            grants: [
              { role: "admin", read: true, write: true },
              { role: "secret-team", read: true },
              { role: "channel-mgr", read: true },
              { role: "member", read: true, write: true },
            ],
          },
        }),
      );
      assert.deepEqual(grantWriteWithoutWrite, { status: 403, code: "PrivilegeEscalation" }, `[${d.kind}] self-grant write without write`);

      // 3d. Policy `grant.scopes` exceeding caller's own permissions is also rejected with `403 PrivilegeEscalation`!
      const grantWildcardPolicyScope = await captureErrorCode(() =>
        bobClient.procedure("com.atproto.space.updateSpace", {
          space: secretChanUri,
          policy: {
            $type: ATGRP_POLICY,
            publicRead: false,
            unlisted: true,
            grants: [
              { role: "admin", read: true, write: true },
              { role: "secret-team", read: true },
              { role: "channel-mgr", read: true },
              {
                role: "member",
                read: true,
                permissions: [`space:${SPACE_TYPE.channel}?authority=self&skey=secret-room&collection=*&action=create`],
              },
            ],
          },
        }),
      );
      assert.deepEqual(
        grantWildcardPolicyScope,
        { status: 403, code: "PrivilegeEscalation" },
        `[${d.kind}] policy grant.scopes exceeding caller permissions`,
      );

      // 3e. Non-admin holding `manage=create` CANNOT self-grant `read`, `write`, or `publicRead` on a brand-new space (`prevPolicy === undefined`)!
      const createSelfReadErr = await captureErrorCode(() =>
        bobClient.procedure("com.atproto.space.createSpace", {
          spaceType: SPACE_TYPE.channel,
          skey: "submgr-self-read",
          policy: {
            $type: ATGRP_POLICY,
            publicRead: false,
            unlisted: false,
            grants: [{ role: "member", read: true }],
          },
        }),
      );
      assert.deepEqual(
        createSelfReadErr,
        { status: 403, code: "PrivilegeEscalation" },
        `[${d.kind}] non-admin createSpace self-grant read`,
      );

      const createSelfWriteErr = await captureErrorCode(() =>
        bobClient.procedure("com.atproto.space.createSpace", {
          spaceType: SPACE_TYPE.channel,
          skey: "submgr-self-write",
          policy: {
            $type: ATGRP_POLICY,
            publicRead: false,
            unlisted: false,
            grants: [{ role: "member", write: true }],
          },
        }),
      );
      assert.deepEqual(
        createSelfWriteErr,
        { status: 403, code: "PrivilegeEscalation" },
        `[${d.kind}] non-admin createSpace self-grant write`,
      );

      const createPubReadErr = await captureErrorCode(() =>
        bobClient.procedure("com.atproto.space.createSpace", {
          spaceType: SPACE_TYPE.channel,
          skey: "submgr-pub-read",
          policy: {
            $type: ATGRP_POLICY,
            publicRead: true,
            unlisted: false,
            grants: [],
          },
        }),
      );
      assert.deepEqual(
        createPubReadErr,
        { status: 403, code: "PrivilegeEscalation" },
        `[${d.kind}] non-admin createSpace publicRead`,
      );

      // Creating a new space with zero newly granted read/write/publicRead succeeds
      await bobClient.procedure("com.atproto.space.createSpace", {
        spaceType: SPACE_TYPE.channel,
        skey: "submgr-empty-grants",
        policy: {
          $type: ATGRP_POLICY,
          publicRead: false,
          unlisted: false,
          grants: [],
        },
      });
    }
  } finally {
    await fake.cleanup();
    await real.cleanup();
  }
});

test("FakeNetwork vs real GroupHostServer parity: account/identity/sync/migration routes, bare-<groupDid> service JWTs & migration staging", async () => {
  const fake = await createFakeDriver({ joinPolicy: "approval", publicMeta: true, withFlockWorkspace: true });
  const real = await createRealDriver({ joinPolicy: "approval", publicMeta: true, withFlockWorkspace: true });

  try {
    for (const d of [fake, real]) {
      // 1. `describeServer` & `resolveHandle`
      const descRes = await d.unauthHttpCall({
        path: "/xrpc/com.atproto.server.describeServer",
        method: "GET",
      });
      assert.equal(descRes.status, 200);
      const descBody = JSON.parse(Buffer.from(descRes.bytes).toString("utf8")) as {
        did: string;
        availableUserDomains: string[];
        blobUploadLimit: number;
      };
      assert.ok(descBody.did.startsWith("did:"), `[${d.kind}] describeServer must return service DID`);
      assert.ok(Array.isArray(descBody.availableUserDomains) && descBody.availableUserDomains.length > 0);
      assert.ok(typeof descBody.blobUploadLimit === "number" && descBody.blobUploadLimit > 0);

      const resolved = await d.unauthHttpCall({
        path: `/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(d.groupHandle.toUpperCase())}`,
        method: "GET",
      });
      assert.equal(resolved.status, 200);
      assert.equal(
        (JSON.parse(Buffer.from(resolved.bytes).toString("utf8")) as { did: string }).did,
        d.groupDid,
      );

      const missingHandle = await d.unauthHttpCall({
        path: "/xrpc/com.atproto.identity.resolveHandle?handle=nonexistent.groups.test",
        method: "GET",
      });
      assert.equal(missingHandle.status, 400);
      assert.equal(
        (JSON.parse(Buffer.from(missingHandle.bytes).toString("utf8")) as { error: string }).error,
        "UnableToResolveHandle",
      );

      // 2. Upload space-referenced blob + `checkAccountStatus` + `com.atproto.sync.{getRepoStatus,getLatestCommit,getRepo,listBlobs,getBlob}`
      const avatarBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9, 8, 7, 6]);
      const upRes = await d.groupHttpCall({
        path: "/xrpc/com.atproto.repo.uploadBlob",
        method: "POST",
        headers: { "content-type": "image/png" },
        body: avatarBytes,
      });
      assert.equal(upRes.status, 200);
      const uploadedBlob = (
        JSON.parse(Buffer.from(upRes.bytes).toString("utf8")) as {
          blob: { ref: { $link: string }; mimeType: string; size: number };
        }
      ).blob;
      const blobCid = uploadedBlob.ref.$link;

      await d.adminClient.procedure("com.atproto.space.putRecord", {
        space: groupMetaUri(d.groupDid),
        repo: d.groupDid,
        collection: ATGRP_COLLECTION.about,
        rkey: SELF_SKEY,
        record: {
          displayName: "Parity Group",
          avatar: uploadedBlob,
        },
      });

      const acctStatus = await d.adminClient.query<{
        activated: boolean;
        validDid: boolean;
        expectedBlobs: number;
        importedBlobs: number;
      }>("com.atproto.server.checkAccountStatus", {});
      assert.equal(acctStatus.activated, true);
      assert.equal(acctStatus.validDid, true);
      assert.equal(acctStatus.expectedBlobs, 1);
      assert.equal(acctStatus.importedBlobs, 1);

      const syncStatus = await d.unauthHttpCall({
        path: `/xrpc/com.atproto.sync.getRepoStatus?did=${encodeURIComponent(d.groupDid)}`,
        method: "GET",
      });
      assert.equal(syncStatus.status, 200);
      const syncStatusBody = JSON.parse(Buffer.from(syncStatus.bytes).toString("utf8")) as {
        did: string;
        active: boolean;
        rev?: string;
      };
      assert.equal(syncStatusBody.did, d.groupDid);
      assert.equal(syncStatusBody.active, true);
      assert.ok(typeof syncStatusBody.rev === "string");

      const latestCommit = await d.unauthHttpCall({
        path: `/xrpc/com.atproto.sync.getLatestCommit?did=${encodeURIComponent(d.groupDid)}`,
        method: "GET",
      });
      assert.equal(latestCommit.status, 200);
      const latestBody = JSON.parse(Buffer.from(latestCommit.bytes).toString("utf8")) as { cid: string; rev: string };
      assert.ok(latestBody.cid.length > 10);

      const carRes = await d.unauthHttpCall({
        path: `/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(d.groupDid)}`,
        method: "GET",
      });
      assert.equal(carRes.status, 200);
      assert.ok((carRes.headers.get("content-type") ?? "").includes("application/vnd.ipld.car"));
      const parsedCar = await readCarWithRoot(carRes.bytes);
      assert.equal(parsedCar.root.toString(), latestBody.cid);

      const syncBlobs = await d.unauthHttpCall({
        path: `/xrpc/com.atproto.sync.listBlobs?did=${encodeURIComponent(d.groupDid)}`,
        method: "GET",
      });
      assert.equal(syncBlobs.status, 200);
      const syncBlobsBody = JSON.parse(Buffer.from(syncBlobs.bytes).toString("utf8")) as { cids: string[] };
      assert.ok(syncBlobsBody.cids.includes(blobCid), `[${d.kind}] sync.listBlobs must include space-referenced blob`);

      const getBlobRes = await d.unauthHttpCall({
        path: `/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(d.groupDid)}&cid=${encodeURIComponent(blobCid)}`,
        method: "GET",
      });
      assert.equal(getBlobRes.status, 200);
      assert.equal(getBlobRes.headers.get("x-content-type-options"), "nosniff");
      assert.deepEqual(getBlobRes.bytes, avatarBytes);

      // 3. Import endpoints reject already-activated groups with `400 AlreadyActivated`
      const impCarRej = await d.groupHttpCall({
        path: "/xrpc/com.atproto.repo.importRepo",
        method: "POST",
        headers: { "content-type": "application/vnd.ipld.car" },
        body: carRes.bytes,
      });
      assert.equal(impCarRej.status, 400);
      assert.equal(
        (JSON.parse(Buffer.from(impCarRej.bytes).toString("utf8")) as { error: string }).error,
        "AlreadyActivated",
      );

      const metaStarRes = await d.groupHttpCall({
        path: `/xrpc/com.atproto.space.exportSpaceMeta?space=${encodeURIComponent(groupMetaUri(d.groupDid))}`,
        method: "GET",
      });
      assert.equal(metaStarRes.status, 200);

      const impMetaRej = await d.groupHttpCall({
        path: "/xrpc/com.atproto.space.importSpaceMeta",
        method: "POST",
        headers: { "content-type": "application/vnd.dasl.star" },
        body: metaStarRes.bytes,
      });
      assert.equal(impMetaRej.status, 400);
      assert.equal(
        (JSON.parse(Buffer.from(impMetaRej.bytes).toString("utf8")) as { error: string }).error,
        "AlreadyActivated",
      );

      const spaceStarRes = await d.groupHttpCall({
        path: `/xrpc/com.atproto.space.getRepo?space=${encodeURIComponent(groupMetaUri(d.groupDid))}&repo=${encodeURIComponent(d.groupDid)}`,
        method: "GET",
      });
      assert.equal(spaceStarRes.status, 200);

      const impSpaceRej = await d.groupHttpCall({
        path: "/xrpc/com.atproto.space.importRepo",
        method: "POST",
        headers: { "content-type": "application/vnd.dasl.star" },
        body: spaceStarRes.bytes,
      });
      assert.equal(impSpaceRej.status, 400);
      assert.equal(
        (JSON.parse(Buffer.from(impSpaceRej.bytes).toString("utf8")) as { error: string }).error,
        "AlreadyActivated",
      );

      // 4. `getServiceAuth` emits bare `<groupDid>` `iss` (never `#atproto_pds`) & rejects protected methods!
      const svcTokenRes = await d.adminClient.query<{ token: string }>("com.atproto.server.getServiceAuth", {
        aud: d.bobDid,
        lxm: "com.atproto.space.notifyCredentialsRevoked",
      });
      const jwtParts = svcTokenRes.token.split(".");
      assert.equal(jwtParts.length, 3, `[${d.kind}] group getServiceAuth must return a 3-part signed JWT`);
      const jwtClaims = JSON.parse(Buffer.from(jwtParts[1]!, "base64url").toString("utf8")) as {
        iss: string;
        aud: string;
        lxm: string;
      };
      assert.equal(jwtClaims.iss, d.groupDid, `[${d.kind}] JWT iss must be bare <groupDid>`);
      assert.ok(!jwtClaims.iss.includes("#"), `[${d.kind}] JWT iss must never contain #atproto_pds`);
      assert.equal(jwtClaims.aud, d.bobDid);
      assert.equal(jwtClaims.lxm, "com.atproto.space.notifyCredentialsRevoked");

      const protectedMethodErr = await captureErrorCode(() =>
        d.adminClient.query("com.atproto.server.getServiceAuth", {
          aud: "did:web:other.groups.test",
          lxm: "com.atproto.server.deleteAccount",
        }),
      );
      assert.deepEqual(protectedMethodErr, { status: 400, code: "InvalidRequest" });

      // 5. `/group-admin/{migration-info,public-group-keys,prepare-migration,abort-migration}`
      const migInfoRes = await d.unauthHttpCall({
        path: "/group-admin/migration-info",
        method: "GET",
      });
      assert.equal(migInfoRes.status, 200);
      const migInfo = JSON.parse(Buffer.from(migInfoRes.bytes).toString("utf8")) as {
        supportedSpacePolicies: string[];
        atomicMigrationVersion: number;
        capabilityProofJwt: string;
      };
      assert.ok(migInfo.supportedSpacePolicies.includes(ATGRP_POLICY));
      assert.equal(migInfo.atomicMigrationVersion, 1);
      assert.equal(migInfo.capabilityProofJwt.split(".").length, 3);

      const pubKeysRes = await d.unauthHttpCall({
        path: `/group-admin/public-group-keys?group=${encodeURIComponent(d.groupDid)}`,
        method: "GET",
      });
      assert.equal(pubKeysRes.status, 200);
      const pubKeys = JSON.parse(Buffer.from(pubKeysRes.bytes).toString("utf8")) as {
        groupDid: string;
        localRotationKey: string;
        proofJwt: string;
      };
      assert.equal(pubKeys.groupDid, d.groupDid);
      assert.ok(pubKeys.localRotationKey.startsWith("did:key:"));
      assert.equal(pubKeys.proofJwt.split(".").length, 3);

      const prepRes = await d.groupHttpCall({
        path: "/group-admin/prepare-migration",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          group: d.groupDid,
          operationId: "parity-mig-op-1",
          targetEndpoint: d.peerMigrationEndpoint,
        }),
      });
      assert.equal(prepRes.status, 200, `[${d.kind}] prepare-migration failed: ${Buffer.from(prepRes.bytes).toString("utf8")}`);
      const prepBody = JSON.parse(Buffer.from(prepRes.bytes).toString("utf8")) as {
        mode: string;
        manifestDigest: string;
        migrationTicket: string | null;
      };
      assert.equal(prepBody.mode, "coordinated");
      assert.match(prepBody.manifestDigest, /^(?:sha256:)?[0-9a-f]{64}$/);
      assert.ok(prepBody.migrationTicket?.startsWith("v1."));

      // Writes are frozen with `409 MigrationInProgress` while migration lease is active
      const frozenErr = await captureErrorCode(() =>
        d.adminClient.procedure("com.atproto.space.createSpace", {
          spaceType: SPACE_TYPE.channel,
          skey: "frozen-test",
          policy: {
            $type: ATGRP_POLICY,
            publicRead: false,
            unlisted: false,
            grants: [{ role: "admin", read: true, write: true }],
          },
        }),
      );
      assert.deepEqual(frozenErr, { status: 409, code: "MigrationInProgress" });

      const abortRes = await d.groupHttpCall({
        path: "/group-admin/abort-migration",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ group: d.groupDid, operationId: "parity-mig-op-1" }),
      });
      assert.equal(abortRes.status, 200);
      assert.equal(
        (JSON.parse(Buffer.from(abortRes.bytes).toString("utf8")) as { status: string }).status,
        "aborted",
      );

      // Writes succeed again once aborted!
      await d.adminClient.procedure("com.atproto.space.createSpace", {
        spaceType: SPACE_TYPE.channel,
        skey: "unfrozen-test",
        policy: {
          $type: ATGRP_POLICY,
          publicRead: false,
          unlisted: false,
          grants: [{ role: "admin", read: true, write: true }],
        },
      });

      // 6. `requestAccountDelete` -> `claim-action-token` -> `deleteAccount`
      await d.adminClient.procedure("com.atproto.server.requestAccountDelete", {});
      const claimRes = await d.groupHttpCall({
        path: "/group-admin/claim-action-token",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ group: d.groupDid, purpose: "delete_account" }),
      });
      assert.equal(claimRes.status, 200);
      const { token: delTok } = JSON.parse(Buffer.from(claimRes.bytes).toString("utf8")) as { token: string };

      await d.adminClient.procedure("com.atproto.server.deleteAccount", {
        did: d.groupDid,
        password: d.groupDid,
        token: delTok,
      });

      const handleAfterDel = await d.unauthHttpCall({
        path: `/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(d.groupHandle)}`,
        method: "GET",
      });
      assert.equal(handleAfterDel.status, 400);
      assert.equal(
        (JSON.parse(Buffer.from(handleAfterDel.bytes).toString("utf8")) as { error: string }).error,
        "UnableToResolveHandle",
      );
    }

    // 7. Also verify `FakeNetwork` migration staging round-trip (`createAccount` -> `repo.importRepo` -> `importSpaceMeta` -> `space.importRepo` -> `activateAccount`)!
    const migNet = new FakeNetwork();
    const srcGroupDid = "did:plc:migsrcgroupaaaaaaaaaaaa7";
    const adminUserDid = "did:plc:migadminaaaaaaaaaaaaaaa8";
    migNet.createAccount(adminUserDid, "pds1");
    await migNet.createGroupAccount(srcGroupDid, {
      host: "group-src",
      creatorDid: adminUserDid,
      name: "Migrating Group",
      handle: "mig-group.groups.test",
      publicMeta: true,
    });
    const srcSession = migNet.issueGroupSessionToken(srcGroupDid, adminUserDid);
    const exportCarRes = await migNet.fetchEndpoint(
      new Request(`https://fake-pds.test/group-src/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(srcGroupDid)}`),
    );
    const carBytes = new Uint8Array(await exportCarRes.arrayBuffer());
    const metaMetaBytes = new Uint8Array(
      await (
        await migNet.fetchEndpoint(
          new Request(
            `https://fake-pds.test/group-src/xrpc/com.atproto.space.exportSpaceMeta?space=${encodeURIComponent(groupMetaUri(srcGroupDid))}`,
            { headers: { authorization: `Bearer ${srcSession}` } },
          ),
        )
      ).arrayBuffer(),
    );
    const membersMetaBytes = new Uint8Array(
      await (
        await migNet.fetchEndpoint(
          new Request(
            `https://fake-pds.test/group-src/xrpc/com.atproto.space.exportSpaceMeta?space=${encodeURIComponent(groupMembersUri(srcGroupDid))}`,
            { headers: { authorization: `Bearer ${srcSession}` } },
          ),
        )
      ).arrayBuffer(),
    );
    const metaStarBytes = new Uint8Array(
      await (
        await migNet.fetchEndpoint(
          new Request(
            `https://fake-pds.test/group-src/xrpc/com.atproto.space.getRepo?space=${encodeURIComponent(groupMetaUri(srcGroupDid))}&repo=${encodeURIComponent(srcGroupDid)}`,
            { headers: { authorization: `Bearer ${srcSession}` } },
          ),
        )
      ).arrayBuffer(),
    );
    const membersStarBytes = new Uint8Array(
      await (
        await migNet.fetchEndpoint(
          new Request(
            `https://fake-pds.test/group-src/xrpc/com.atproto.space.getRepo?space=${encodeURIComponent(groupMembersUri(srcGroupDid))}&repo=${encodeURIComponent(srcGroupDid)}`,
            { headers: { authorization: `Bearer ${srcSession}` } },
          ),
        )
      ).arrayBuffer(),
    );

    // Stage into a second `FakeNetwork` (`group-dst`) using `com.atproto.server.createAccount`
    const dstNet = new FakeNetwork();
    // Register `srcGroupDid`'s signing key on `dstNet` via account creation then remove group so `createAccount` stages fresh
    const createJwtRes = await migNet.fetchEndpoint(
      new Request(
        `https://fake-pds.test/group-src/xrpc/com.atproto.server.getServiceAuth?aud=${encodeURIComponent("did:web:fake-pds.test:group-dst")}&lxm=com.atproto.server.createAccount`,
        { headers: { authorization: `Bearer ${srcSession}` } },
      ),
    );
    const { token: createAcctJwt } = (await createJwtRes.json()) as { token: string };
    // Share public signing key resolution across networks
    const srcPubSigningKey = await migNet.resolveSigningKey(srcGroupDid);
    dstNet.resolveSigningKey = async (did: string) => {
      if (did === srcGroupDid) return srcPubSigningKey;
      throw new Error(`unknown ${did}`);
    };

    const stagedAcctRes = await dstNet.fetchEndpoint(
      new Request("https://fake-pds.test/group-dst/xrpc/com.atproto.server.createAccount", {
        method: "POST",
        headers: {
          authorization: `Bearer ${createAcctJwt}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ did: srcGroupDid, handle: "mig-group.groups.test" }),
      }),
    );
    assert.equal(stagedAcctRes.status, 200);
    const { accessJwt: migAccessJwt } = (await stagedAcctRes.json()) as { accessJwt: string };

    assert.equal(
      (
        await dstNet.fetchEndpoint(
          new Request("https://fake-pds.test/group-dst/xrpc/com.atproto.repo.importRepo", {
            method: "POST",
            headers: {
              authorization: `Bearer ${migAccessJwt}`,
              "content-type": "application/vnd.ipld.car",
            },
            body: carBytes,
          }),
        )
      ).status,
      200,
    );
    for (const metaArchive of [metaMetaBytes, membersMetaBytes]) {
      assert.equal(
        (
          await dstNet.fetchEndpoint(
            new Request("https://fake-pds.test/group-dst/xrpc/com.atproto.space.importSpaceMeta", {
              method: "POST",
              headers: {
                authorization: `Bearer ${migAccessJwt}`,
                "content-type": "application/vnd.dasl.star",
              },
              body: metaArchive,
            }),
          )
        ).status,
        200,
      );
    }
    for (const spaceStar of [metaStarBytes, membersStarBytes]) {
      assert.equal(
        (
          await dstNet.fetchEndpoint(
            new Request("https://fake-pds.test/group-dst/xrpc/com.atproto.space.importRepo", {
              method: "POST",
              headers: {
                authorization: `Bearer ${migAccessJwt}`,
                "content-type": "application/vnd.dasl.star",
              },
              body: spaceStar,
            }),
          )
        ).status,
        200,
      );
    }
    assert.equal(
      (
        await dstNet.fetchEndpoint(
          new Request("https://fake-pds.test/group-dst/xrpc/com.atproto.server.activateAccount", {
            method: "POST",
            headers: { authorization: `Bearer ${migAccessJwt}` },
          }),
        )
      ).status,
      200,
    );
    const dstDecl = await dstNet.fetchEndpoint(
      new Request(
        `https://fake-pds.test/group-dst/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(srcGroupDid)}&collection=${encodeURIComponent(REPO_COLLECTION.groupDeclaration)}&rkey=self`,
      ),
    );
    assert.equal(dstDecl.status, 200);
  } finally {
    await fake.cleanup();
    await real.cleanup();
  }
});

test("FakeNetwork & GroupHostServer parity: authenticated notifyCredentialsRevoked & authorizeSpaceSync final revalidation", async () => {
  // Part A: Inbound & Outbound `notifyCredentialsRevoked` parity across `FakeNetwork` and `GroupHostServer`!
  const fake = await createFakeDriver({ joinPolicy: "open", publicMeta: true, withFlockWorkspace: true });
  const real = await createRealDriver({ joinPolicy: "open", publicMeta: true, withFlockWorkspace: true });

  try {
    const forgedKeypair = await P256Keypair.create();
    const signCustomJwt = async (
      kp: P256Keypair,
      claims: Record<string, unknown>,
      headerOverride?: Record<string, unknown>,
    ): Promise<string> => {
      const hdr = Buffer.from(
        JSON.stringify(headerOverride ?? { alg: kp.jwtAlg, typ: "JWT", kid: "#atproto" }),
      ).toString("base64url");
      const pld = Buffer.from(JSON.stringify(claims)).toString("base64url");
      const sig = await kp.sign(new TextEncoder().encode(`${hdr}.${pld}`));
      return `${hdr}.${pld}.${Buffer.from(sig).toString("base64url")}`;
    };

    for (const d of [fake, real]) {
      const targetSpace = groupMembersUri(d.groupDid);
      const nowSec = Math.floor(Date.now() / 1000);

      // 1. Unauthenticated request -> `401 AuthMissing`
      const noAuth = await d.unauthHttpCall({
        path: "/xrpc/com.atproto.space.notifyCredentialsRevoked",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ space: targetSpace, credentials: ["jti-unauth"] }),
      });
      assert.equal(noAuth.status, 401);
      assert.equal((JSON.parse(Buffer.from(noAuth.bytes).toString("utf8")) as { error: string }).error, "AuthMissing");

      // 2. `#atproto_pds` fragment in `aud` -> `401 InvalidToken`
      const fragAudJwt = await signCustomJwt(forgedKeypair, {
        iss: d.groupDid,
        aud: `${d.groupDid}#atproto_pds`,
        lxm: "com.atproto.space.notifyCredentialsRevoked",
        iat: nowSec,
        exp: nowSec + 60,
        jti: "jti-frag-aud",
      });
      const fragAudRes = await d.unauthHttpCall({
        path: "/xrpc/com.atproto.space.notifyCredentialsRevoked",
        method: "POST",
        headers: {
          authorization: `Bearer ${fragAudJwt}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ space: targetSpace, credentials: ["jti-1"] }),
      });
      assert.equal(fragAudRes.status, 401);
      assert.equal((JSON.parse(Buffer.from(fragAudRes.bytes).toString("utf8")) as { error: string }).error, "InvalidToken");

      // 3. Wrong `lxm` -> `401 InvalidToken`
      const wrongLxmSvc = await d.adminClient.query<{ token: string }>("com.atproto.server.getServiceAuth", {
        aud: d.groupDid,
        lxm: "com.atproto.space.notifyRepoUpdate",
      });
      const wrongLxmRes = await d.unauthHttpCall({
        path: "/xrpc/com.atproto.space.notifyCredentialsRevoked",
        method: "POST",
        headers: {
          authorization: `Bearer ${wrongLxmSvc.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ space: targetSpace, credentials: ["jti-2"] }),
      });
      assert.equal(wrongLxmRes.status, 401);
      assert.equal((JSON.parse(Buffer.from(wrongLxmRes.bytes).toString("utf8")) as { error: string }).error, "InvalidToken");

      // 4. Forged signature -> `401 InvalidSignature`
      const forgedJwt = await signCustomJwt(forgedKeypair, {
        iss: d.groupDid,
        aud: d.groupDid,
        lxm: "com.atproto.space.notifyCredentialsRevoked",
        iat: nowSec,
        exp: nowSec + 60,
        jti: "jti-forged-sig",
      });
      const forgedRes = await d.unauthHttpCall({
        path: "/xrpc/com.atproto.space.notifyCredentialsRevoked",
        method: "POST",
        headers: {
          authorization: `Bearer ${forgedJwt}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ space: targetSpace, credentials: ["jti-3"] }),
      });
      assert.equal(forgedRes.status, 401);
      assert.equal((JSON.parse(Buffer.from(forgedRes.bytes).toString("utf8")) as { error: string }).error, "InvalidSignature");

      // 5. Unhosted `aud` DID -> `403 Forbidden`
      const unhostedSvc = await d.adminClient.query<{ token: string }>("com.atproto.server.getServiceAuth", {
        aud: "did:plc:unhostedaccountaaaaaaaa9",
        lxm: "com.atproto.space.notifyCredentialsRevoked",
      });
      const unhostedRes = await d.unauthHttpCall({
        path: "/xrpc/com.atproto.space.notifyCredentialsRevoked",
        method: "POST",
        headers: {
          authorization: `Bearer ${unhostedSvc.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ space: targetSpace, credentials: ["jti-4"] }),
      });
      assert.equal(unhostedRes.status, 403);
      assert.equal((JSON.parse(Buffer.from(unhostedRes.bytes).toString("utf8")) as { error: string }).error, "Forbidden");

      // 6. Schema conformance (`credentials: string[]` 1..100 strings of 1..256 chars; legacy `jtis`-only or >256-char string rejected with `400 InvalidRequest`)
      const invalidPayloads: Array<Record<string, unknown>> = [
        { space: targetSpace, jtis: ["jti-legacy-field"] },
        { space: targetSpace, credentials: [] },
        { space: targetSpace, credentials: [""] },
        { space: targetSpace, credentials: ["x".repeat(257)] },
        { space: targetSpace, credentials: Array.from({ length: 101 }, (_, idx) => `jti-${idx}`) },
      ];
      for (const badBody of invalidPayloads) {
        const badSvc = await d.adminClient.query<{ token: string }>("com.atproto.server.getServiceAuth", {
          aud: d.groupDid,
          lxm: "com.atproto.space.notifyCredentialsRevoked",
        });
        const badRes = await d.unauthHttpCall({
          path: "/xrpc/com.atproto.space.notifyCredentialsRevoked",
          method: "POST",
          headers: {
            authorization: `Bearer ${badSvc.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(badBody),
        });
        assert.equal(badRes.status, 400, `[${d.kind}] non-conforming notifyCredentialsRevoked body must fail with 400`);
        assert.equal(
          (JSON.parse(Buffer.from(badRes.bytes).toString("utf8")) as { error: string }).error,
          "InvalidRequest",
          `[${d.kind}] non-conforming notifyCredentialsRevoked body must return InvalidRequest`,
        );
      }

      // 7. Full Service-JWT freshness, `typ === "JWT"`, `exp - iat <= 60`, `iat <= nowSec + 5`, and `jti` (1..256 chars) checks (`401 InvalidToken`)
      const groupSigKp = await d.getGroupSigningKeyForTest();
      const malformedClaimsCases: Array<{
        label: string;
        header?: Record<string, unknown>;
        claims: Record<string, unknown>;
      }> = [
        {
          label: "missing typ header",
          header: { alg: groupSigKp.jwtAlg, kid: "#atproto" },
          claims: {
            iss: d.groupDid,
            aud: d.groupDid,
            lxm: "com.atproto.space.notifyCredentialsRevoked",
            iat: nowSec,
            exp: nowSec + 60,
            jti: "jti-missing-typ",
          },
        },
        {
          label: "wrong typ header",
          header: { alg: groupSigKp.jwtAlg, typ: "at+jwt", kid: "#atproto" },
          claims: {
            iss: d.groupDid,
            aud: d.groupDid,
            lxm: "com.atproto.space.notifyCredentialsRevoked",
            iat: nowSec,
            exp: nowSec + 60,
            jti: "jti-wrong-typ",
          },
        },
        {
          label: "missing iat",
          claims: {
            iss: d.groupDid,
            aud: d.groupDid,
            lxm: "com.atproto.space.notifyCredentialsRevoked",
            exp: nowSec + 60,
            jti: "jti-missing-iat",
          },
        },
        {
          label: "future iat skew > 5s",
          claims: {
            iss: d.groupDid,
            aud: d.groupDid,
            lxm: "com.atproto.space.notifyCredentialsRevoked",
            iat: nowSec + 10,
            exp: nowSec + 60,
            jti: "jti-future-iat",
          },
        },
        {
          label: "lifetime exp - iat > 60s",
          claims: {
            iss: d.groupDid,
            aud: d.groupDid,
            lxm: "com.atproto.space.notifyCredentialsRevoked",
            iat: nowSec,
            exp: nowSec + 61,
            jti: "jti-long-exp",
          },
        },
        {
          label: "missing jti",
          claims: {
            iss: d.groupDid,
            aud: d.groupDid,
            lxm: "com.atproto.space.notifyCredentialsRevoked",
            iat: nowSec,
            exp: nowSec + 60,
          },
        },
        {
          label: "oversized jti (>256 chars)",
          claims: {
            iss: d.groupDid,
            aud: d.groupDid,
            lxm: "com.atproto.space.notifyCredentialsRevoked",
            iat: nowSec,
            exp: nowSec + 60,
            jti: "j".repeat(257),
          },
        },
      ];
      for (const badJwtCase of malformedClaimsCases) {
        const badJwt = await signCustomJwt(groupSigKp, badJwtCase.claims, badJwtCase.header);
        const badJwtRes = await d.unauthHttpCall({
          path: "/xrpc/com.atproto.space.notifyCredentialsRevoked",
          method: "POST",
          headers: {
            authorization: `Bearer ${badJwt}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ space: targetSpace, credentials: ["jti-claim-check"] }),
        });
        assert.equal(badJwtRes.status, 401, `[${d.kind}] ${badJwtCase.label} must fail with 401`);
        assert.equal(
          (JSON.parse(Buffer.from(badJwtRes.bytes).toString("utf8")) as { error: string }).error,
          "InvalidToken",
          `[${d.kind}] ${badJwtCase.label} must return InvalidToken`,
        );
      }

      // 8. Space/repo relationship enforcement (`403 Forbidden`):
      //    (a) Unrelated external space where `d.groupDid` has no repository -> `403 Forbidden`
      const carolKp = await d.getPersonalSigningKeyForTest(d.carolDid);
      const carolInviteSpace = personalInboxUri(d.carolDid);
      const carolUnrelatedJwt = await signCustomJwt(carolKp, {
        iss: d.carolDid,
        aud: d.groupDid,
        lxm: "com.atproto.space.notifyCredentialsRevoked",
        iat: nowSec,
        exp: nowSec + 60,
        jti: `carol-unrelated-${randomUUID()}`,
      });
      const carolUnrelatedRes = await d.unauthHttpCall({
        path: "/xrpc/com.atproto.space.notifyCredentialsRevoked",
        method: "POST",
        headers: {
          authorization: `Bearer ${carolUnrelatedJwt}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ space: carolInviteSpace, credentials: ["jti-unrelated-ext"] }),
      });
      assert.equal(carolUnrelatedRes.status, 403, `[${d.kind}] unrelated external space must fail with 403`);
      assert.equal(
        (JSON.parse(Buffer.from(carolUnrelatedRes.bytes).toString("utf8")) as { error: string }).error,
        "Forbidden",
      );

      //    (b) Nonexistent own group space -> `403 Forbidden`
      const missingOwnSpace = channelUri(d.groupDid, "nonexistent");
      const missingOwnJwt = await signCustomJwt(groupSigKp, {
        iss: d.groupDid,
        aud: d.groupDid,
        lxm: "com.atproto.space.notifyCredentialsRevoked",
        iat: nowSec,
        exp: nowSec + 60,
        jti: `own-missing-${randomUUID()}`,
      });
      const missingOwnRes = await d.unauthHttpCall({
        path: "/xrpc/com.atproto.space.notifyCredentialsRevoked",
        method: "POST",
        headers: {
          authorization: `Bearer ${missingOwnJwt}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ space: missingOwnSpace, credentials: ["jti-missing-own"] }),
      });
      assert.equal(missingOwnRes.status, 403, `[${d.kind}] nonexistent own group space must fail with 403`);

      // 9. Valid authority-signed JWT (`iss = groupDid` bare, `aud = groupDid` bare, `lxm = notifyCredentialsRevoked`, `credentials` 1..100) -> `200 OK`,
      //    and immediate replay of the same `jti` -> `401 ReplayDetected`!
      const validSvc = await d.adminClient.query<{ token: string }>("com.atproto.server.getServiceAuth", {
        aud: d.groupDid,
        lxm: "com.atproto.space.notifyCredentialsRevoked",
      });
      const validRes = await d.unauthHttpCall({
        path: "/xrpc/com.atproto.space.notifyCredentialsRevoked",
        method: "POST",
        headers: {
          authorization: `Bearer ${validSvc.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ space: targetSpace, credentials: ["jti-valid-revoked"] }),
      });
      assert.equal(validRes.status, 200);

      const replayRes = await d.unauthHttpCall({
        path: "/xrpc/com.atproto.space.notifyCredentialsRevoked",
        method: "POST",
        headers: {
          authorization: `Bearer ${validSvc.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ space: targetSpace, credentials: ["jti-replay-attempt"] }),
      });
      assert.equal(replayRes.status, 401, `[${d.kind}] replayed notifyCredentialsRevoked JWT must fail with 401`);
      assert.equal(
        (JSON.parse(Buffer.from(replayRes.bytes).toString("utf8")) as { error: string }).error,
        "ReplayDetected",
        `[${d.kind}] replayed notifyCredentialsRevoked JWT must return ReplayDetected`,
      );

      // 10. Sliding-window amplification & rate-limit enforcement (`429 RateLimitExceeded`):
      //     (a) Credential-ID cap (`2,000` IDs / 60s window): 1 ID was already pushed for `(groupDid, groupDid)` in step 9;
      //         19 batches of 100 (`1,901` total) succeed, and the 20th batch of 100 (`2,001 > 2,000`) fails with `429 RateLimitExceeded`!
      for (let batch = 0; batch < 19; batch += 1) {
        const batchJwt = await signCustomJwt(groupSigKp, {
          iss: d.groupDid,
          aud: d.groupDid,
          lxm: "com.atproto.space.notifyCredentialsRevoked",
          iat: nowSec,
          exp: nowSec + 60,
          jti: `amp-batch-${batch}-${randomUUID()}`,
        });
        const batchRes = await d.unauthHttpCall({
          path: "/xrpc/com.atproto.space.notifyCredentialsRevoked",
          method: "POST",
          headers: {
            authorization: `Bearer ${batchJwt}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            space: targetSpace,
            credentials: Array.from({ length: 100 }, (_, idx) => `amp-${batch}-${idx}`),
          }),
        });
        assert.equal(batchRes.status, 200, `[${d.kind}] batch ${batch} within 2,000-ID cap must succeed`);
      }
      const ampOverflowJwt = await signCustomJwt(groupSigKp, {
        iss: d.groupDid,
        aud: d.groupDid,
        lxm: "com.atproto.space.notifyCredentialsRevoked",
        iat: nowSec,
        exp: nowSec + 60,
        jti: `amp-overflow-${randomUUID()}`,
      });
      const ampOverflowRes = await d.unauthHttpCall({
        path: "/xrpc/com.atproto.space.notifyCredentialsRevoked",
        method: "POST",
        headers: {
          authorization: `Bearer ${ampOverflowJwt}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          space: targetSpace,
          credentials: Array.from({ length: 100 }, (_, idx) => `amp-over-${idx}`),
        }),
      });
      assert.equal(ampOverflowRes.status, 429, `[${d.kind}] >2,000 credential IDs in 60s window must fail with 429`);
      assert.equal(
        (JSON.parse(Buffer.from(ampOverflowRes.bytes).toString("utf8")) as { error: string }).error,
        "RateLimitExceeded",
      );

      //     (b) Request-count cap (`30` requests / 60s window) for an authorized external space (`bob`'s invites space):
      await d.provisionPersonalInvitesSpace(d.bobDid);
      const bobInviteSpace = personalInboxUri(d.bobDid);
      await d.adminClient.procedure("com.atproto.space.putRecord", {
        space: bobInviteSpace,
        repo: d.groupDid,
        collection: ATGRP_COLLECTION.invite,
        rkey: "3jzfcijpj2z2e",
        record: { $type: ATGRP_COLLECTION.invite, createdAt: new Date().toISOString() },
      });
      const bobKp = await d.getPersonalSigningKeyForTest(d.bobDid);
      for (let reqIdx = 0; reqIdx < 30; reqIdx += 1) {
        const bobJwt = await signCustomJwt(bobKp, {
          iss: d.bobDid,
          aud: d.groupDid,
          lxm: "com.atproto.space.notifyCredentialsRevoked",
          iat: nowSec,
          exp: nowSec + 60,
          jti: `bob-req-${reqIdx}-${randomUUID()}`,
        });
        const bobRes = await d.unauthHttpCall({
          path: "/xrpc/com.atproto.space.notifyCredentialsRevoked",
          method: "POST",
          headers: {
            authorization: `Bearer ${bobJwt}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ space: bobInviteSpace, credentials: [`bob-cred-${reqIdx}`] }),
        });
        assert.equal(bobRes.status, 200, `[${d.kind}] external issuer request ${reqIdx} within 30/min must succeed`);
      }
      const bobRateLimitJwt = await signCustomJwt(bobKp, {
        iss: d.bobDid,
        aud: d.groupDid,
        lxm: "com.atproto.space.notifyCredentialsRevoked",
        iat: nowSec,
        exp: nowSec + 60,
        jti: `bob-req-31-${randomUUID()}`,
      });
      const bobRateLimitRes = await d.unauthHttpCall({
        path: "/xrpc/com.atproto.space.notifyCredentialsRevoked",
        method: "POST",
        headers: {
          authorization: `Bearer ${bobRateLimitJwt}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ space: bobInviteSpace, credentials: ["bob-cred-31"] }),
      });
      assert.equal(bobRateLimitRes.status, 429, `[${d.kind}] 31st request in 60s window must fail with 429`);
      assert.equal(
        (JSON.parse(Buffer.from(bobRateLimitRes.bytes).toString("utf8")) as { error: string }).error,
        "RateLimitExceeded",
      );
    }

    // Part B: Verify `FakeNetwork` outbound `deliverCredentialsRevokedToPeer` emits bare `<groupDid>` `iss` & bare `<writerDid>` `aud`
    // and lexicon-conforming `{ space, credentials }` batches (`1..100` entries),
    // and verify `authorizeSpaceSync` (`getSpaceCredential`) final revalidation under concurrent revocation / deactivation / auth_epoch advance!
    const net = new FakeNetwork();
    net.now = () => Date.now();
    const aliceDid = "did:plc:revaliceaaaaaaaaaaaaaaa2";
    const bobDid = "did:plc:revbobaaaaaaaaaaaaaaaaa3";
    const groupDid = "did:plc:revgroupaaaaaaaaaaaaaaa4";
    net.createAccount(aliceDid, "pds-alice");
    net.createAccount(bobDid, "pds-bob");
    await net.createGroupAccount(groupDid, {
      creatorDid: aliceDid,
      name: "Revocation Group",
      joinPolicy: "open",
      publicMeta: false,
    });
    const adminClient = net.clientForGroupMember(groupDid, aliceDid);
    const membersSpace = groupMembersUri(groupDid);
    await adminClient.procedure("com.atproto.space.putRecord", {
      space: membersSpace,
      repo: groupDid,
      collection: ATGRP_COLLECTION.membership,
      rkey: bobDid,
      record: { roles: ["member"], createdAt: new Date().toISOString() },
    });

    // Capture outbound `notifyCredentialsRevoked` delivered to `pds-bob`
    const capturedRevocations: Array<{
      authHeader: string;
      body: { space: string; credentials: string[]; jtis?: unknown };
    }> = [];
    net.registerEndpoint("https://fake-pds.test/pds-bob", async (req) => {
      capturedRevocations.push({
        authHeader: req.headers.get("authorization") ?? "",
        body: (await req.json()) as { space: string; credentials: string[]; jtis?: unknown },
      });
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    });

    const bobPdsClient = net.clientFor(bobDid);
    const credKp1 = await P256Keypair.create();
    let liveCred1 = "";
    for (let i = 0; i < 105; i += 1) {
      const { token: delTok } = await bobPdsClient.procedure<Record<string, unknown>, { token: string }>(
        "com.atproto.space.getDelegationToken",
        { space: membersSpace },
      );
      const kp = i === 0 ? credKp1 : await P256Keypair.create();
      const { credential } = await net.getSpaceCredential({
        space: membersSpace,
        delegationToken: delTok,
        credentialKey: kp.did(),
      });
      if (i === 0) liveCred1 = credential;
    }

    // Eject Bob -> triggers `deliverCredentialsRevokedToPeer` chunked into `100` + `5` `credentials` batches
    await adminClient.procedure("com.atproto.space.deleteRecord", {
      space: membersSpace,
      repo: groupDid,
      collection: ATGRP_COLLECTION.membership,
      rkey: bobDid,
    });
    assert.deepEqual(
      capturedRevocations.map((entry) => entry.body.credentials.length),
      [100, 5],
      "Outbound notifyCredentialsRevoked must chunk 105 credentials into 100 + 5 batches",
    );
    for (const captured of capturedRevocations) {
      assert.equal(captured.body.jtis, undefined, "Outbound notifyCredentialsRevoked must serialize credentials, never jtis");
      assert.equal(captured.body.space, membersSpace);
    }
    const bearer = capturedRevocations[0]!.authHeader.replace(/^Bearer\s+/i, "");
    const outParts = bearer.split(".");
    assert.equal(outParts.length, 3, "Outbound notifyCredentialsRevoked token must be a 3-part ES256 JWT");
    const outHeader = JSON.parse(Buffer.from(outParts[0]!, "base64url").toString("utf8")) as {
      alg: string;
      typ: string;
    };
    assert.equal(outHeader.typ, "JWT", "Outbound notifyCredentialsRevoked header typ must be JWT");
    const outClaims = JSON.parse(Buffer.from(outParts[1]!, "base64url").toString("utf8")) as {
      iss: string;
      aud: string;
      lxm: string;
      iat: number;
      exp: number;
      jti: string;
    };
    assert.equal(outClaims.iss, groupDid, "Outbound notifyCredentialsRevoked iss must be bare <groupDid>");
    assert.equal(outClaims.aud, bobDid, "Outbound notifyCredentialsRevoked aud must be bare <writerDid>");
    assert.ok(!outClaims.iss.includes("#") && !outClaims.aud.includes("#"));
    assert.equal(outClaims.lxm, "com.atproto.space.notifyCredentialsRevoked");
    assert.equal(typeof outClaims.iat, "number");
    assert.equal(outClaims.exp - outClaims.iat, 60);
    assert.ok(typeof outClaims.jti === "string" && outClaims.jti.length > 0);

    // Credential is immediately rejected with `401 CredentialRevoked`
    const { headers: sigHeaders } = await createSpaceSigHeaders({
      keypair: credKp1,
      authorization: `Atproto-Space-Credential ${liveCred1}`,
      audience: groupDid as DidString,
    });
    const readRevoked = await net.fetchEndpoint(
      new Request(
        `https://fake-pds.test/group-host/xrpc/com.atproto.space.listRecords?space=${encodeURIComponent(membersSpace)}&repo=${encodeURIComponent(groupDid)}`,
        { headers: sigHeaders },
      ),
    );
    assert.equal(readRevoked.status, 401);
    assert.equal((await readRevoked.json() as { error: string }).error, "CredentialRevoked");

    // Re-admit Bob and test `authorizeSpaceSync` (`getSpaceCredential`) final revalidation races during `confirmRegistration`!
    await adminClient.procedure("com.atproto.space.putRecord", {
      space: membersSpace,
      repo: groupDid,
      collection: ATGRP_COLLECTION.membership,
      rkey: bobDid,
      record: { roles: ["member"], createdAt: new Date().toISOString() },
    });

    // Race 1: Bob's membership is deleted mid-flight during `confirmRegistration` -> `SpaceNotFound`
    net.registerEndpoint("https://syncer-race1.test", async (req) => {
      const { challenge } = (await req.json()) as { challenge: string };
      await adminClient.procedure("com.atproto.space.deleteRecord", {
        space: membersSpace,
        repo: groupDid,
        collection: ATGRP_COLLECTION.membership,
        rkey: bobDid,
      });
      return new Response(JSON.stringify({ challenge }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const { token: delRace1 } = await bobPdsClient.procedure<Record<string, unknown>, { token: string }>(
      "com.atproto.space.getDelegationToken",
      { space: membersSpace },
    );
    const credKpRace1 = await P256Keypair.create();
    await assert.rejects(
      () =>
        net.getSpaceCredential({
          space: membersSpace,
          delegationToken: delRace1,
          credentialKey: credKpRace1.did(),
          notify: { endpoint: "https://syncer-race1.test", token: "tok-race-1" },
        }),
      (err: unknown) => (err as { code?: string }).code === "SpaceNotFound",
    );

    // Re-admit Bob and test Race 2: `auth_epoch` advances (deactivate + reactivate) mid-flight during `confirmRegistration` -> `SpaceNotFound`!
    await adminClient.procedure("com.atproto.space.putRecord", {
      space: membersSpace,
      repo: groupDid,
      collection: ATGRP_COLLECTION.membership,
      rkey: bobDid,
      record: { roles: ["member"], createdAt: new Date().toISOString() },
    });
    net.registerEndpoint("https://syncer-race2.test", async (req) => {
      const { challenge } = (await req.json()) as { challenge: string };
      const freshAdmin = net.clientForGroupMember(groupDid, aliceDid);
      await freshAdmin.procedure("com.atproto.server.deactivateAccount", {});
      const recAdmin = net.clientForGroupMember(groupDid, aliceDid, { sessionKind: "recovery" });
      await recAdmin.procedure("com.atproto.server.activateAccount", {});
      return new Response(JSON.stringify({ challenge }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const { token: delRace2 } = await bobPdsClient.procedure<Record<string, unknown>, { token: string }>(
      "com.atproto.space.getDelegationToken",
      { space: membersSpace },
    );
    const credKpRace2 = await P256Keypair.create();
    await assert.rejects(
      () =>
        net.getSpaceCredential({
          space: membersSpace,
          delegationToken: delRace2,
          credentialKey: credKpRace2.did(),
          notify: { endpoint: "https://syncer-race2.test", token: "tok-race-2" },
        }),
      (err: unknown) => (err as { code?: string }).code === "SpaceNotFound",
    );
  } finally {
    await fake.cleanup();
    await real.cleanup();
  }
});

test("FakeNetwork & GroupHostServer parity: POST /group-admin/controller-session sovereign custody & strict migration service-JWT freshness/typ", async () => {
  // Use a zero-Flock-workspace group so zero-human governance & recovery are also exercised cleanly
  const fake = await createFakeDriver({ joinPolicy: "invite", publicMeta: true, withFlockWorkspace: false });
  const real = await createRealDriver({ joinPolicy: "invite", publicMeta: true, withFlockWorkspace: false });

  const sendParityDpop = async (
    driver: ParityDriver,
    dpop: DpopTestClient,
    state: { nonce?: string },
    targetBaseUrl: string,
    path: string,
    init: RequestInit & { accessToken?: string; forceAthForToken?: string },
  ): Promise<Response> => {
    const method = (init.method ?? "GET").toUpperCase();
    const fullUrl = `${targetBaseUrl}${path}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const proof = await dpop.signProof({
        htm: method,
        htu: fullUrl,
        nonce: state.nonce,
        accessToken: init.forceAthForToken ?? init.accessToken,
      });
      const headers = new Headers(init.headers);
      headers.set("DPoP", proof);
      if (init.accessToken) {
        headers.set("Authorization", `DPoP ${init.accessToken}`);
      }
      const res = await driver.rawFetch(fullUrl, { ...init, method, headers });
      const nextNonce = res.headers.get("dpop-nonce");
      if (nextNonce) state.nonce = nextNonce;
      if (attempt === 0 && (res.status === 400 || res.status === 401) && nextNonce) {
        const cloned = res.clone();
        const wwwAuth = res.headers.get("www-authenticate") ?? "";
        const bodyText = await cloned.text().catch(() => "");
        if (wwwAuth.includes("use_dpop_nonce") || bodyText.includes("use_dpop_nonce")) {
          continue;
        }
      }
      return res;
    }
    throw new Error("Unreachable");
  };

  const signRawCompactJwt = async (
    kp: P256Keypair,
    header: Record<string, unknown>,
    payload: Record<string, unknown>,
  ): Promise<string> => {
    const hdr = Buffer.from(JSON.stringify(header)).toString("base64url");
    const pld = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = await kp.sign(new TextEncoder().encode(`${hdr}.${pld}`));
    return `${hdr}.${pld}.${Buffer.from(sig).toString("base64url")}`;
  };

  try {
    for (const d of [fake, real]) {
      const didDocRes = await d.unauthHttpCall({ path: "/.well-known/did.json", method: "GET" });
      assert.equal(didDocRes.status, 200);
      const hostServiceDid = (JSON.parse(Buffer.from(didDocRes.bytes).toString("utf8")) as { id: string }).id;

      const peerDocRes = await d.rawFetch(`${d.peerMigrationEndpoint}/.well-known/did.json`, { method: "GET" });
      assert.equal(peerDocRes.status, 200);
      const peerServiceDid = ((await peerDocRes.json()) as { id: string }).id;

      // 1. Register an external sovereign PLC rotation key (`sovKey`) on `d.groupDid`
      const sovKey = await P256Keypair.create({ exportable: true });
      const outsiderKey = await P256Keypair.create({ exportable: true });
      const recCreds = await d.adminClient.query<{ rotationKeys: string[] }>(
        "com.atproto.identity.getRecommendedDidCredentials",
        {},
      );
      await d.adminClient.procedure("com.atproto.identity.requestPlcOperationSignature", {});
      const claimRes = await d.groupHttpCall({
        path: "/group-admin/claim-action-token",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ group: d.groupDid, purpose: "plc_operation" }),
      });
      assert.equal(claimRes.status, 200);
      const { token: plcTok } = JSON.parse(Buffer.from(claimRes.bytes).toString("utf8")) as { token: string };
      const { operation: signedOp } = await d.adminClient.procedure<
        Record<string, unknown>,
        { operation: Record<string, unknown> }
      >("com.atproto.identity.signPlcOperation", {
        token: plcTok,
        rotationKeys: [...recCreds.rotationKeys, sovKey.did()],
      });
      await d.adminClient.procedure("com.atproto.identity.submitPlcOperation", { operation: signedOp });

      const ctrlDpop = await createDpopTestClient();
      const ctrlNonceState: { nonce?: string } = {};
      const nowSec = Math.floor(Date.now() / 1000);

      // 2. Negative controller-session checks:
      //    (a) Missing `typ: "JWT"` -> `401 InvalidToken`
      const missingTypJwt = await signRawCompactJwt(
        sovKey,
        { alg: "ES256", kid: sovKey.did() },
        {
          iss: d.groupDid,
          aud: hostServiceDid,
          lxm: "com.atproto.server.createSession",
          iat: nowSec,
          exp: nowSec + 60,
          jti: randomUUID(),
        },
      );
      const missingTypRes = await sendParityDpop(d, ctrlDpop, ctrlNonceState, d.baseUrl, "/group-admin/controller-session", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${missingTypJwt}` },
        body: JSON.stringify({ group: d.groupDid }),
      });
      assert.equal(missingTypRes.status, 401, `[${d.kind}] controller-session must reject missing typ: "JWT"`);
      assert.equal(((await missingTypRes.json()) as { error: string }).error, "InvalidToken");

      //    (b) Future `iat > now + 5s` -> `401`
      const futureIatJwt = await signRawCompactJwt(
        sovKey,
        { typ: "JWT", alg: "ES256", kid: sovKey.did() },
        {
          iss: d.groupDid,
          aud: hostServiceDid,
          lxm: "com.atproto.server.createSession",
          iat: nowSec + 30,
          exp: nowSec + 60,
          jti: randomUUID(),
        },
      );
      const futureIatRes = await sendParityDpop(d, ctrlDpop, ctrlNonceState, d.baseUrl, "/group-admin/controller-session", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${futureIatJwt}` },
        body: JSON.stringify({ group: d.groupDid }),
      });
      assert.equal(futureIatRes.status, 401, `[${d.kind}] controller-session must reject future iat > now + 5s`);

      //    (c) Lifetime `exp - iat > 60s` -> `401`
      const longExpJwt = await signRawCompactJwt(
        sovKey,
        { typ: "JWT", alg: "ES256", kid: sovKey.did() },
        {
          iss: d.groupDid,
          aud: hostServiceDid,
          lxm: "com.atproto.server.createSession",
          iat: nowSec,
          exp: nowSec + 120,
          jti: randomUUID(),
        },
      );
      const longExpRes = await sendParityDpop(d, ctrlDpop, ctrlNonceState, d.baseUrl, "/group-admin/controller-session", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${longExpJwt}` },
        body: JSON.stringify({ group: d.groupDid }),
      });
      assert.equal(longExpRes.status, 401, `[${d.kind}] controller-session must reject exp - iat > 60s`);

      //    (d) Signed by host's own `localRotationKey` -> `403 Forbidden`
      const localRotKp = await d.getLocalRotationKeyForTest();
      const localRotJwt = await signRawCompactJwt(
        localRotKp,
        { typ: "JWT", alg: "ES256", kid: localRotKp.did() },
        {
          iss: d.groupDid,
          aud: hostServiceDid,
          lxm: "com.atproto.server.createSession",
          iat: nowSec,
          exp: nowSec + 60,
          jti: randomUUID(),
        },
      );
      const localRotRes = await sendParityDpop(d, ctrlDpop, ctrlNonceState, d.baseUrl, "/group-admin/controller-session", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${localRotJwt}` },
        body: JSON.stringify({ group: d.groupDid }),
      });
      assert.equal(localRotRes.status, 403, `[${d.kind}] controller-session must reject local host rotation key`);
      assert.equal(((await localRotRes.json()) as { error: string }).error, "Forbidden");

      //    (e) Signed by non-PLC `did:key` -> `403 Forbidden`
      const nonPlcJwt = await signRawCompactJwt(
        outsiderKey,
        { typ: "JWT", alg: "ES256", kid: outsiderKey.did() },
        {
          iss: d.groupDid,
          aud: hostServiceDid,
          lxm: "com.atproto.server.createSession",
          iat: nowSec,
          exp: nowSec + 60,
          jti: randomUUID(),
        },
      );
      const nonPlcRes = await sendParityDpop(d, ctrlDpop, ctrlNonceState, d.baseUrl, "/group-admin/controller-session", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${nonPlcJwt}` },
        body: JSON.stringify({ group: d.groupDid }),
      });
      assert.equal(nonPlcRes.status, 403, `[${d.kind}] controller-session must reject non-PLC rotation key`);
      assert.equal(((await nonPlcRes.json()) as { error: string }).error, "Forbidden");

      //    (f) Forged signature claiming `kid: sovKey.did()` -> `401 InvalidSignature`
      const forgedCtrlJwt = await signRawCompactJwt(
        outsiderKey,
        { typ: "JWT", alg: "ES256", kid: sovKey.did() },
        {
          iss: d.groupDid,
          aud: hostServiceDid,
          lxm: "com.atproto.server.createSession",
          iat: nowSec,
          exp: nowSec + 60,
          jti: randomUUID(),
        },
      );
      const forgedCtrlRes = await sendParityDpop(d, ctrlDpop, ctrlNonceState, d.baseUrl, "/group-admin/controller-session", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${forgedCtrlJwt}` },
        body: JSON.stringify({ group: d.groupDid }),
      });
      assert.equal(forgedCtrlRes.status, 401);
      assert.equal(((await forgedCtrlRes.json()) as { error: string }).error, "InvalidSignature");

      //    (g) Unexpected `ath` claim on `/group-admin/controller-session` DPoP proof -> `401 invalid_dpop_proof`
      const validForBadDpop = await signRawCompactJwt(
        sovKey,
        { typ: "JWT", alg: "ES256", kid: sovKey.did() },
        {
          iss: d.groupDid,
          aud: hostServiceDid,
          lxm: "com.atproto.server.createSession",
          iat: nowSec,
          exp: nowSec + 60,
          jti: randomUUID(),
        },
      );
      const badAthRes = await sendParityDpop(d, ctrlDpop, ctrlNonceState, d.baseUrl, "/group-admin/controller-session", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${validForBadDpop}` },
        body: JSON.stringify({ group: d.groupDid }),
        forceAthForToken: "unexpected-token-for-ath",
      });
      assert.equal(badAthRes.status, 401);
      assert.equal(((await badAthRes.json()) as { error: string }).error, "invalid_dpop_proof");

      // 3. Zero-human sovereign custody while `activated === 1` (`session_kind = 'group'`):
      //    Sole human (`aliceDid`) leaves the non-Flock group -> stays `activated === 1` with 0 human members!
      const leaveRes = await d.personalServiceCall<{ status: string }>({
        callerDid: d.aliceDid,
        method: ATGRP_METHOD.leaveGroup,
        httpMethod: "POST",
        lxm: ATGRP_METHOD.leaveGroup,
        body: { group: d.groupDid },
      });
      assert.equal(leaveRes.status, 200, `[${d.kind}] sole-member leave on sovereign non-Flock group`);

      const singleUseJti = `ctrl-jti-${randomUUID()}`;
      const activeCtrlJwt = await signRawCompactJwt(
        sovKey,
        { typ: "JWT", alg: "ES256", kid: sovKey.did() },
        {
          iss: d.groupDid,
          aud: hostServiceDid,
          lxm: "com.atproto.server.createSession",
          iat: nowSec,
          exp: nowSec + 60,
          jti: singleUseJti,
        },
      );
      const activeCtrlRes = await sendParityDpop(d, ctrlDpop, ctrlNonceState, d.baseUrl, "/group-admin/controller-session", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${activeCtrlJwt}` },
        body: JSON.stringify({ group: d.groupDid }),
      });
      assert.equal(activeCtrlRes.status, 200, `[${d.kind}] active controller-session failed: ${await activeCtrlRes.clone().text()}`);
      assert.ok(activeCtrlRes.headers.get("dpop-nonce"), `[${d.kind}] controller-session must emit DPoP-Nonce header`);
      const activeCtrlBody = (await activeCtrlRes.json()) as {
        access_token: string;
        token_type: string;
        sub: string;
        refresh_token: string;
      };
      assert.equal(activeCtrlBody.token_type, "DPoP");
      assert.equal(activeCtrlBody.sub, d.groupDid);
      assert.ok(activeCtrlBody.refresh_token.startsWith("ghr_"));

      // Replaying the same controller JWT `jti` -> `401 ReplayDetected`
      const replayCtrlRes = await sendParityDpop(d, ctrlDpop, ctrlNonceState, d.baseUrl, "/group-admin/controller-session", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${activeCtrlJwt}` },
        body: JSON.stringify({ group: d.groupDid }),
      });
      assert.equal(replayCtrlRes.status, 401);
      assert.equal(((await replayCtrlRes.json()) as { error: string }).error, "ReplayDetected");

      // DPoP-bound access_token presented as `Bearer` must be rejected (`401`)
      const bearerMisuse = await d.unauthHttpCall({
        path: "/xrpc/com.atproto.server.checkAccountStatus",
        method: "GET",
        headers: { authorization: `Bearer ${activeCtrlBody.access_token}` },
      });
      assert.equal(bearerMisuse.status, 401);

      // Administer zero-human group (`putRecord` on `profile/self`) using sovereign controller `group` session!
      const putProfileRes = await sendParityDpop(
        d,
        ctrlDpop,
        ctrlNonceState,
        d.baseUrl,
        "/xrpc/com.atproto.space.putRecord",
        {
          method: "POST",
          accessToken: activeCtrlBody.access_token,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            space: groupMetaUri(d.groupDid),
            repo: d.groupDid,
            collection: ATGRP_COLLECTION.about,
            rkey: SELF_SKEY,
            record: {
              $type: ATGRP_COLLECTION.about,
              displayName: "Zero-Human Sovereign Group",
              description: `Governed via ${d.kind} controller-session`,
            },
          }),
        },
      );
      assert.equal(putProfileRes.status, 200, `[${d.kind}] putRecord via controller-session failed`);

      // 4. Deactivate (`activated = 0`) and prove `controller-session` mints restricted `recovery` session & reactivates!
      const deactRes = await sendParityDpop(
        d,
        ctrlDpop,
        ctrlNonceState,
        d.baseUrl,
        "/xrpc/com.atproto.server.deactivateAccount",
        {
          method: "POST",
          accessToken: activeCtrlBody.access_token,
        },
      );
      assert.equal(deactRes.status, 200, `[${d.kind}] deactivateAccount via controller-session failed`);

      // Prior `auth_epoch` session is immediately invalidated (`401`)
      const staleEpochRes = await sendParityDpop(
        d,
        ctrlDpop,
        ctrlNonceState,
        d.baseUrl,
        "/xrpc/com.atproto.server.checkAccountStatus",
        {
          method: "GET",
          accessToken: activeCtrlBody.access_token,
        },
      );
      assert.equal(staleEpochRes.status, 401);

      const recDpop = await createDpopTestClient();
      const recNonceState: { nonce?: string } = {};
      const recCtrlJwt = await signRawCompactJwt(
        sovKey,
        { typ: "JWT", alg: "ES256", kid: sovKey.did() },
        {
          iss: d.groupDid,
          aud: hostServiceDid,
          lxm: "com.atproto.server.createSession",
          iat: nowSec,
          exp: nowSec + 60,
          jti: randomUUID(),
        },
      );
      const recCtrlRes = await sendParityDpop(d, recDpop, recNonceState, d.baseUrl, "/group-admin/controller-session", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${recCtrlJwt}` },
        body: JSON.stringify({ group: d.groupDid }),
      });
      assert.equal(recCtrlRes.status, 200, `[${d.kind}] recovery controller-session failed`);
      const recCtrlBody = (await recCtrlRes.json()) as { access_token: string };

      // Non-recovery mutation is blocked (`403 Forbidden`) while `session_kind === 'recovery'`
      const blockedOnRecovery = await sendParityDpop(
        d,
        recDpop,
        recNonceState,
        d.baseUrl,
        "/xrpc/com.atproto.space.putRecord",
        {
          method: "POST",
          accessToken: recCtrlBody.access_token,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            space: groupMetaUri(d.groupDid),
            repo: d.groupDid,
            collection: ATGRP_COLLECTION.about,
            rkey: SELF_SKEY,
            record: { $type: ATGRP_COLLECTION.about, displayName: "Blocked" },
          }),
        },
      );
      assert.equal(blockedOnRecovery.status, 403, `[${d.kind}] recovery session must reject general space writes`);

      const statusBeforeAct = await sendParityDpop(
        d,
        recDpop,
        recNonceState,
        d.baseUrl,
        "/xrpc/com.atproto.server.checkAccountStatus",
        {
          method: "GET",
          accessToken: recCtrlBody.access_token,
        },
      );
      assert.equal(statusBeforeAct.status, 200);
      assert.equal(((await statusBeforeAct.json()) as { activated: boolean }).activated, false);

      const actRes = await sendParityDpop(
        d,
        recDpop,
        recNonceState,
        d.baseUrl,
        "/xrpc/com.atproto.server.activateAccount",
        {
          method: "POST",
          accessToken: recCtrlBody.access_token,
        },
      );
      assert.equal(actRes.status, 200, `[${d.kind}] activateAccount via recovery controller-session failed`);

      // 5. Codex #9: Migration service-JWT `typ === "JWT"`, `iat <= now + 5s`, `0 < exp - iat <= 60s`
      //    enforced on `createAccount` and target `abort-migration` across BOTH `[fake, real]`!
      const groupSignKp = await d.getGroupSigningKeyForTest();
      const badJwtCases: Array<{
        label: string;
        header: Record<string, unknown>;
        iat: number;
        exp: number;
      }> = [
        { label: "missing typ", header: { alg: "ES256", kid: "#atproto" }, iat: nowSec, exp: nowSec + 60 },
        { label: "future iat > now + 5s", header: { typ: "JWT", alg: "ES256", kid: "#atproto" }, iat: nowSec + 30, exp: nowSec + 60 },
        { label: "exp - iat > 60s", header: { typ: "JWT", alg: "ES256", kid: "#atproto" }, iat: nowSec, exp: nowSec + 120 },
      ];

      for (const tc of badJwtCases) {
        const badCreateJwt = await signRawCompactJwt(groupSignKp, tc.header, {
          iss: d.groupDid,
          aud: peerServiceDid,
          lxm: "com.atproto.server.createAccount",
          iat: tc.iat,
          exp: tc.exp,
          jti: randomUUID(),
        });
        const badCreateRes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.createAccount`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${badCreateJwt}` },
          body: JSON.stringify({ did: d.groupDid, handle: d.groupHandle }),
        });
        assert.equal(badCreateRes.status, 401, `[${d.kind}] createAccount must reject ${tc.label} (got ${badCreateRes.status})`);

        const badAbortJwt = await signRawCompactJwt(groupSignKp, tc.header, {
          iss: d.groupDid,
          aud: peerServiceDid,
          lxm: "new.flock.group.abortMigration",
          iat: tc.iat,
          exp: tc.exp,
          jti: randomUUID(),
        });
        const badAbortRes = await d.rawFetch(`${d.peerMigrationEndpoint}/group-admin/abort-migration`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${badAbortJwt}` },
          body: JSON.stringify({ group: d.groupDid, operationId: "op-check-jwt" }),
        });
        assert.equal(badAbortRes.status, 401, `[${d.kind}] abort-migration must reject ${tc.label} (got ${badAbortRes.status})`);
      }

      const validAbortJwt = await signRawCompactJwt(
        groupSignKp,
        { typ: "JWT", alg: "ES256", kid: "#atproto" },
        {
          iss: d.groupDid,
          aud: peerServiceDid,
          lxm: "new.flock.group.abortMigration",
          iat: nowSec,
          exp: nowSec + 60,
          jti: randomUUID(),
        },
      );
      const validAbortRes = await d.rawFetch(`${d.peerMigrationEndpoint}/group-admin/abort-migration`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${validAbortJwt}` },
        body: JSON.stringify({ group: d.groupDid, operationId: "op-check-jwt" }),
      });
      assert.equal(validAbortRes.status, 200, `[${d.kind}] valid abort-migration service JWT must succeed`);
      assert.equal(((await validAbortRes.json()) as { status: string }).status, "already_absent");
    }
  } finally {
    await fake.cleanup();
    await real.cleanup();
  }
});

test("FakeNetwork & GroupHostServer Round 4 parity: atomic meta publicRead <-> declaration/self, Standard-mode operationId abort isolation, external invites/self collection enforcement, and localhost clientAttestation verification", async () => {
  const fake = await createFakeDriver({ joinPolicy: "open", publicMeta: true, withFlockWorkspace: true });
  const real = await createRealDriver({ joinPolicy: "open", publicMeta: true, withFlockWorkspace: true });

  const { publicKey: appPubKey, privateKey: appPrivKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const { privateKey: wrongPrivKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const appPubJwk = { ...appPubKey.export({ format: "jwk" }), kid: "parity-local-k1", use: "sig", alg: "ES256" };

  let appPort = 0;
  const appServer = createHttpServer((req, res) => {
    const clientId = `http://localhost:${appPort}/client-metadata.json`;
    if (req.url === "/client-metadata.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          client_id: clientId,
          client_name: "Parity Localhost App",
          jwks_uri: `http://localhost:${appPort}/jwks.json`,
        }),
      );
      return;
    }
    if (req.url === "/jwks.json") {
      res.writeHead(200, { "content-type": "application/jwk-set+json" });
      res.end(JSON.stringify({ keys: [appPubJwk] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => appServer.listen(0, "127.0.0.1", resolve));
  appPort = (appServer.address() as AddressInfo).port;
  const localhostClientId = `http://localhost:${appPort}/client-metadata.json`;

  const signAttestation = (privKey: typeof appPrivKey, claims: Record<string, unknown>): string => {
    const hdr = Buffer.from(
      JSON.stringify({ typ: "atproto-client-attestation+jwt", alg: "ES256", kid: "parity-local-k1" }),
    ).toString("base64url");
    const bdy = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signer = createSign("SHA256");
    signer.update(`${hdr}.${bdy}`);
    signer.end();
    const sig = signer.sign({ key: privKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
    return `${hdr}.${bdy}.${sig}`;
  };

  const signRawCompactJwt = async (
    kp: P256Keypair,
    header: Record<string, unknown>,
    payload: Record<string, unknown>,
  ): Promise<string> => {
    const hdr = Buffer.from(JSON.stringify(header)).toString("base64url");
    const pld = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = await kp.sign(new TextEncoder().encode(`${hdr}.${pld}`));
    return `${hdr}.${pld}.${Buffer.from(sig).toString("base64url")}`;
  };

  const sendParityDpop = async (
    driver: ParityDriver,
    dpop: DpopTestClient,
    state: { nonce?: string },
    targetBaseUrl: string,
    path: string,
    init: RequestInit & { accessToken?: string },
  ): Promise<Response> => {
    const method = (init.method ?? "GET").toUpperCase();
    const fullUrl = `${targetBaseUrl}${path}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const proof = await dpop.signProof({
        htm: method,
        htu: fullUrl,
        nonce: state.nonce,
        accessToken: init.accessToken,
      });
      const headers = new Headers(init.headers);
      headers.set("DPoP", proof);
      if (init.accessToken) {
        headers.set("Authorization", `DPoP ${init.accessToken}`);
      }
      const res = await driver.rawFetch(fullUrl, { ...init, method, headers });
      const nextNonce = res.headers.get("dpop-nonce");
      if (nextNonce) state.nonce = nextNonce;
      if (attempt === 0 && (res.status === 400 || res.status === 401) && nextNonce) {
        const wwwAuth = res.headers.get("www-authenticate") ?? "";
        const bodyText = await res.clone().text().catch(() => "");
        if (wwwAuth.includes("use_dpop_nonce") || bodyText.includes("use_dpop_nonce")) {
          continue;
        }
      }
      return res;
    }
    throw new Error("Unreachable");
  };

  try {
    for (const d of [fake, real]) {
      const metaSpace = groupMetaUri(d.groupDid);
      const membersSpace = groupMembersUri(d.groupDid);

      // =======================================================================
      // 1. Codex Round 4 Finding #1: Atomic coupling `meta/self` `publicRead` <-> `org.atgrp.declaration/self`
      // =======================================================================
      await d.adminClient.procedure("com.atproto.space.updateSpace", {
        space: metaSpace,
        policy: {
          $type: ATGRP_POLICY,
          publicRead: false,
          unlisted: false,
          grants: [
            { role: "admin", read: true },
            { role: "member", read: true },
          ],
        },
      });

      const declAfterPrivErr = await captureErrorCode(() =>
        d.adminClient.query("com.atproto.repo.getRecord", {
          repo: d.groupDid,
          collection: REPO_COLLECTION.groupDeclaration,
          rkey: SELF_SKEY,
        }),
      );
      assert.deepEqual(declAfterPrivErr, { status: 400, code: "RecordNotFound" }, `[${d.kind}] declaration/self must be deleted`);

      for (const writeCall of [
        () =>
          d.adminClient.procedure("com.atproto.repo.putRecord", {
            repo: d.groupDid,
            collection: REPO_COLLECTION.groupDeclaration,
            rkey: SELF_SKEY,
            record: { $type: REPO_COLLECTION.groupDeclaration },
          }),
        () =>
          d.adminClient.procedure("com.atproto.repo.createRecord", {
            repo: d.groupDid,
            collection: REPO_COLLECTION.groupDeclaration,
            rkey: SELF_SKEY,
            record: { $type: REPO_COLLECTION.groupDeclaration },
          }),
        () =>
          d.adminClient.procedure("com.atproto.repo.applyWrites", {
            repo: d.groupDid,
            writes: [
              {
                $type: "com.atproto.repo.applyWrites#create",
                collection: REPO_COLLECTION.groupDeclaration,
                rkey: SELF_SKEY,
                value: { $type: REPO_COLLECTION.groupDeclaration },
              },
            ],
          }),
      ]) {
        const declWriteErr = await captureErrorCode(writeCall);
        assert.deepEqual(
          declWriteErr,
          { status: 400, code: "InvalidRequest" },
          `[${d.kind}] publishing declaration/self while publicRead=false must fail with 400 InvalidRequest`,
        );
      }

      await d.adminClient.procedure("com.atproto.space.updateSpace", {
        space: metaSpace,
        policy: {
          $type: ATGRP_POLICY,
          publicRead: true,
          unlisted: false,
          grants: [
            { role: "admin", read: true },
            { role: "member", read: true },
          ],
        },
      });
      const restoredDecl = await d.adminClient.query<{ cid: string; value: { $type: string } }>(
        "com.atproto.repo.getRecord",
        {
          repo: d.groupDid,
          collection: REPO_COLLECTION.groupDeclaration,
          rkey: SELF_SKEY,
        },
      );
      assert.equal(restoredDecl.value.$type, REPO_COLLECTION.groupDeclaration);

      await new Promise((r) => setTimeout(r, 10));
      await d.adminClient.procedure("com.atproto.space.updateSpace", {
        space: metaSpace,
        policy: {
          $type: ATGRP_POLICY,
          publicRead: true,
          unlisted: false,
          grants: [
            { role: "admin", read: true },
            { role: "moderator", read: true },
            { role: "member", read: true },
          ],
        },
      });
      const preservedDecl = await d.adminClient.query<{ cid: string; value: { $type: string } }>("com.atproto.repo.getRecord", {
        repo: d.groupDid,
        collection: REPO_COLLECTION.groupDeclaration,
        rkey: SELF_SKEY,
      });
      assert.equal(preservedDecl.cid, restoredDecl.cid, `[${d.kind}] declaration CID must remain stable`);

      // Concurrent race: `updateSpace(publicRead: false)` racing `repo.putRecord(declaration/self)` must NEVER leave `publicRead: false` + live `declaration/self`!
      await Promise.allSettled([
        d.adminClient.procedure("com.atproto.space.updateSpace", {
          space: metaSpace,
          policy: {
            $type: ATGRP_POLICY,
            publicRead: false,
            unlisted: false,
            grants: [
              { role: "admin", read: true },
              { role: "member", read: true },
            ],
          },
        }),
        d.adminClient.procedure("com.atproto.repo.putRecord", {
          repo: d.groupDid,
          collection: REPO_COLLECTION.groupDeclaration,
          rkey: SELF_SKEY,
          record: { $type: REPO_COLLECTION.groupDeclaration },
        }),
      ]);
      const raceDeclErr = await captureErrorCode(() =>
        d.adminClient.query("com.atproto.repo.getRecord", {
          repo: d.groupDid,
          collection: REPO_COLLECTION.groupDeclaration,
          rkey: SELF_SKEY,
        }),
      );
      assert.deepEqual(raceDeclErr, { status: 400, code: "RecordNotFound" }, `[${d.kind}] race must not leave live declaration/self`);

      // Restore `publicRead: true`
      await d.adminClient.procedure("com.atproto.space.updateSpace", {
        space: metaSpace,
        policy: {
          $type: ATGRP_POLICY,
          publicRead: true,
          unlisted: false,
          grants: [
            { role: "admin", read: true },
            { role: "member", read: true },
          ],
        },
      });

      // =======================================================================
      // 2. Codex Round 4 Finding #3: Delayed Standard-mode `abort-migration` NEVER purges newer Standard session!
      // =======================================================================
      const peerDocRes = await d.rawFetch(`${d.peerMigrationEndpoint}/.well-known/did.json`, { method: "GET" });
      assert.equal(peerDocRes.status, 200);
      const peerServiceDid = ((await peerDocRes.json()) as { id: string }).id;
      const groupSignKp = await d.getGroupSigningKeyForTest();

      const makeTargetJwt = async (lxm: string) => {
        const nowSec = Math.floor(Date.now() / 1000);
        return signRawCompactJwt(
          groupSignKp,
          { typ: "JWT", alg: "ES256", kid: "#atproto" },
          {
            iss: d.groupDid,
            aud: peerServiceDid,
            lxm,
            iat: nowSec,
            exp: nowSec + 60,
            jti: randomUUID(),
          },
        );
      };

      // Malformed `X-Group-Migration-Operation-Id` -> `400 InvalidRequest`
      const badHdrRes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.createAccount`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await makeTargetJwt("com.atproto.server.createAccount")}`,
          "x-group-migration-operation-id": "bad header value!",
        },
        body: JSON.stringify({ did: d.groupDid, handle: d.groupHandle }),
      });
      assert.equal(badHdrRes.status, 400, `[${d.kind}] malformed X-Group-Migration-Operation-Id must return 400`);
      assert.equal(((await badHdrRes.json()) as { error: string }).error, "InvalidRequest");

      // Prepare Operation 1 (`mode: "standard"`) on source
      const prepOp1Res = await d.groupHttpCall({
        path: "/group-admin/prepare-migration",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          group: d.groupDid,
          operationId: "parity-std-op-1",
          targetEndpoint: d.peerMigrationEndpoint,
          mode: "standard",
        }),
      });
      assert.equal(prepOp1Res.status, 200, `[${d.kind}] prepare-migration standard mode failed`);
      const prepOp1 = JSON.parse(Buffer.from(prepOp1Res.bytes).toString("utf8")) as {
        mode: string;
        deadlineAtMs: number;
      };
      assert.equal(prepOp1.mode, "standard");

      // Stage Operation 1 on target with `X-Group-Migration-Operation-Id: parity-std-op-1`
      const stageOp1Res = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.createAccount`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await makeTargetJwt("com.atproto.server.createAccount")}`,
          "x-group-migration-operation-id": "parity-std-op-1",
        },
        body: JSON.stringify({ did: d.groupDid, handle: d.groupHandle }),
      });
      assert.equal(stageOp1Res.status, 200, `[${d.kind}] createAccount op-1 failed`);
      const stageOp1InitialToks = (await stageOp1Res.json()) as { accessJwt: string; refreshJwt: string };

      // Lost-response replay with same `operationId` -> `200`, preserving active generation without displacing `stageOp1InitialToks`!
      const replayOp1Res = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.createAccount`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await makeTargetJwt("com.atproto.server.createAccount")}`,
          "x-group-migration-operation-id": "parity-std-op-1",
        },
        body: JSON.stringify({ did: d.groupDid, handle: d.groupHandle }),
      });
      assert.equal(replayOp1Res.status, 200, `[${d.kind}] lost-response replay op-1 must succeed`);

      // Round 17 Fix #3 & #8: Both `stageOp1InitialToks.refreshJwt` and `Idempotency-Key` recovery work identically across GroupHost & FakeNetwork!
      const idemRot1Res = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.refreshSession`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${stageOp1InitialToks.refreshJwt}`,
          "idempotency-key": "parity-migref-idem-1",
        },
      });
      assert.equal(idemRot1Res.status, 200, `[${d.kind}] refreshSession with Idempotency-Key must succeed`);

      const idemRotRetryRes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.refreshSession`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${stageOp1InitialToks.refreshJwt}`,
          "idempotency-key": "parity-migref-idem-1",
        },
      });
      assert.equal(idemRotRetryRes.status, 200, `[${d.kind}] idempotent refreshSession retry must return 200`);
      const op1Toks = (await idemRotRetryRes.json()) as { accessJwt: string; refreshJwt: string };

      // First authenticated accessJwt call closes the refresh grace window on both GroupHost and FakeNetwork!
      const statusCloseGraceRes = await d.rawFetch(
        `${d.peerMigrationEndpoint}/xrpc/com.atproto.server.checkAccountStatus`,
        {
          method: "GET",
          headers: { authorization: `Bearer ${op1Toks.accessJwt}` },
        },
      );
      assert.equal(statusCloseGraceRes.status, 200);

      const competeOpRes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.createAccount`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await makeTargetJwt("com.atproto.server.createAccount")}`,
          "x-group-migration-operation-id": "parity-std-competing",
        },
        body: JSON.stringify({ did: d.groupDid, handle: d.groupHandle }),
      });
      assert.equal(competeOpRes.status, 409, `[${d.kind}] competing operationId must return 409 MigrationInProgress`);
      assert.equal(((await competeOpRes.json()) as { error: string }).error, "MigrationInProgress");

      // Clean up Operation 1 on target via migration Bearer & abort lease on source
      const purgeOp1Res = await d.rawFetch(`${d.peerMigrationEndpoint}/group-admin/abort-migration`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${op1Toks.accessJwt}` },
        body: JSON.stringify({ group: d.groupDid, operationId: "parity-std-op-1" }),
      });
      assert.equal(purgeOp1Res.status, 200);
      assert.equal(((await purgeOp1Res.json()) as { status: string }).status, "purged");

      // Round 18 Fix #1: Replaying Target `abort-migration` with the SAME `at+jwt` after purge returns `200 { status: "already_absent" }`!
      const replayPurgedOp1Res = await d.rawFetch(`${d.peerMigrationEndpoint}/group-admin/abort-migration`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${op1Toks.accessJwt}` },
        body: JSON.stringify({ group: d.groupDid, operationId: "parity-std-op-1" }),
      });
      assert.equal(replayPurgedOp1Res.status, 200, `[${d.kind}] replayed target abort-migration must be crash-idempotent`);
      assert.equal(((await replayPurgedOp1Res.json()) as { status: string }).status, "already_absent");

      await d.groupHttpCall({
        path: "/group-admin/abort-migration",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ group: d.groupDid, operationId: "parity-std-op-1" }),
      });

      const metaMetaStar = (
        await d.groupHttpCall({
          path: `/xrpc/com.atproto.space.exportSpaceMeta?space=${encodeURIComponent(metaSpace)}`,
          method: "GET",
        })
      ).bytes;
      const metaRepoStar = (
        await d.groupHttpCall({
          path: `/xrpc/com.atproto.space.getRepo?space=${encodeURIComponent(metaSpace)}&repo=${encodeURIComponent(d.groupDid)}`,
          method: "GET",
        })
      ).bytes;

      // Test BOTH Operation 2 WITH `X-Group-Migration-Operation-Id: parity-std-op-2` AND Operation 2 WITHOUT header (`operation_id = null`),
      // both created IMMEDIATELY (well before `prepOp1.deadlineAtMs`!):
      for (const op2Header of ["parity-std-op-2", undefined] as const) {
        const stageOp2Res = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.createAccount`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${await makeTargetJwt("com.atproto.server.createAccount")}`,
            ...(op2Header !== undefined ? { "x-group-migration-operation-id": op2Header } : {}),
          },
          body: JSON.stringify({ did: d.groupDid, handle: d.groupHandle }),
        });
        assert.equal(stageOp2Res.status, 200, `[${d.kind}] stage op2 (${String(op2Header)}) failed`);
        const op2Toks = (await stageOp2Res.json()) as { accessJwt: string };

        // Round 18 Fix #1: Replaying `op1Toks.accessJwt` after `op2` staged returns `200 { status: "superseded" }` without disturbing `op2`!
        const supersededAbortRes = await d.rawFetch(`${d.peerMigrationEndpoint}/group-admin/abort-migration`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${op1Toks.accessJwt}` },
          body: JSON.stringify({ group: d.groupDid, operationId: "parity-std-op-1" }),
        });
        assert.equal(supersededAbortRes.status, 200);
        assert.equal(((await supersededAbortRes.json()) as { status: string }).status, "superseded");

        const impMetaRes = await d.rawFetch(
          `${d.peerMigrationEndpoint}/xrpc/com.atproto.space.importSpaceMeta?space=${encodeURIComponent(metaSpace)}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/vnd.dasl.star",
              authorization: `Bearer ${op2Toks.accessJwt}`,
            },
            body: new Uint8Array(metaMetaStar),
          },
        );
        assert.equal(impMetaRes.status, 200);
        const impRepoRes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.space.importRepo`, {
          method: "POST",
          headers: {
            "content-type": "application/vnd.dasl.star",
            authorization: `Bearer ${op2Toks.accessJwt}`,
          },
          body: new Uint8Array(metaRepoStar),
        });
        assert.equal(impRepoRes.status, 200);

        // Delayed `#atproto` `abort-migration` for `"parity-std-op-1"` arrives BEFORE `prepOp1.deadlineAtMs`:
        // MUST return `200 { status: "superseded" }` and leave Operation 2's staged data intact!
        const delayedAbortRes = await d.rawFetch(`${d.peerMigrationEndpoint}/group-admin/abort-migration`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${await makeTargetJwt("new.flock.group.abortMigration")}`,
          },
          body: JSON.stringify({
            group: d.groupDid,
            operationId: "parity-std-op-1",
            deadlineAtMs: prepOp1.deadlineAtMs,
          }),
        });
        assert.equal(delayedAbortRes.status, 200);
        assert.equal(
          ((await delayedAbortRes.json()) as { status: string }).status,
          "superseded",
          `[${d.kind}] delayed op-1 abort must return superseded for op2Header=${String(op2Header)}`,
        );

        // Verify Operation 2's staged `profile/self` and session token are still 100% live!
        const checkStagedStatus = await d.rawFetch(
          `${d.peerMigrationEndpoint}/xrpc/com.atproto.server.checkAccountStatus`,
          {
            method: "GET",
            headers: { authorization: `Bearer ${op2Toks.accessJwt}` },
          },
        );
        assert.equal(checkStagedStatus.status, 200, `[${d.kind}] op2 session must survive delayed op-1 abort`);
        const statusJson = (await checkStagedStatus.json()) as { repoBlocks?: number; indexedRecords?: number };
        assert.ok((statusJson.indexedRecords ?? 1) >= 0);

        // While we have an active target staging session, also verify Codex Round 4 Finding #7 (`space.importRepo` rejects non-invite collection in external `invites/self` -> `400 InvalidRepoFile`)!
        if (op2Header === "parity-std-op-2") {
          const bobInvSpace = personalInboxUri(d.bobDid);
          const rogueSer = await serializeRecord(
            "app.bsky.feed.post" as NsidString,
            "3jzfcijpj2z2a" as RecordKeyString,
            jsonToLex({ $type: "app.bsky.feed.post", text: "Rogue", createdAt: "2026-01-01T00:00:00.000Z" }) as LexMap,
          );
          const rogueChunks: Buffer[] = [];
          for await (const chunk of writeRepoStar(
            RepoCommit.fromRecords([rogueSer]).toCommit({
              space: bobInvSpace as SpaceRefString,
              repo: d.groupDid as DidString,
              rev: "3kzzzzzzzzzzz",
            }),
            [rogueSer],
          )) {
            rogueChunks.push(Buffer.from(chunk));
          }
          const badImportRes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.space.importRepo`, {
            method: "POST",
            headers: {
              "content-type": "application/vnd.dasl.star",
              authorization: `Bearer ${op2Toks.accessJwt}`,
            },
            body: new Uint8Array(Buffer.concat(rogueChunks)),
          });
          assert.equal(badImportRes.status, 400, `[${d.kind}] external invites/self importRepo with unknown collection must return 400`);
          assert.equal(((await badImportRes.json()) as { error: string }).error, "InvalidRepoFile");
        }

        // Purge Operation 2 cleanly via migration Bearer
        const cleanOp2Res = await d.rawFetch(`${d.peerMigrationEndpoint}/group-admin/abort-migration`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${op2Toks.accessJwt}` },
          body: JSON.stringify({ group: d.groupDid }),
        });
        assert.equal(cleanOp2Res.status, 200);
        assert.equal(((await cleanOp2Res.json()) as { status: string }).status, "purged");
      }

      // =======================================================================
      // 3. Codex Round 4 Finding #7: Reject unknown collections & invalid invites in external `invites/self` even with `validate: false` & wildcard scopes!
      // =======================================================================
      await d.provisionPersonalInvitesSpace(d.bobDid);
      const bobInvSpace = personalInboxUri(d.bobDid);

      // Invalid invite record with `validate: false` -> `400 InvalidRequest`
      const badInvErr = await captureErrorCode(() =>
        d.adminClient.procedure("com.atproto.space.putRecord", {
          space: bobInvSpace,
          repo: d.groupDid,
          collection: ATGRP_COLLECTION.invite,
          rkey: "3jzfcijpj2z2a",
          validate: false,
          record: { unexpected: "missing createdAt" },
        }),
      );
      assert.deepEqual(badInvErr, { status: 400, code: "InvalidRequest" }, `[${d.kind}] validate: false must not bypass invite schema`);

      // Add wildcard `collection=*` invite scope via sovereign `controller-session` so OAuth passes, then verify `space.putRecord` still rejects `app.bsky.feed.post` with `400 InvalidRequest`!
      const didDocRes = await d.unauthHttpCall({ path: "/.well-known/did.json", method: "GET" });
      const hostServiceDid = (JSON.parse(Buffer.from(didDocRes.bytes).toString("utf8")) as { id: string }).id;
      const sovKey = await P256Keypair.create({ exportable: true });
      const recCreds = await d.adminClient.query<{ rotationKeys: string[] }>(
        "com.atproto.identity.getRecommendedDidCredentials",
        {},
      );
      await d.adminClient.procedure("com.atproto.identity.requestPlcOperationSignature", {});
      const claimPlc = JSON.parse(
        Buffer.from(
          (
            await d.groupHttpCall({
              path: "/group-admin/claim-action-token",
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ group: d.groupDid, purpose: "plc_operation" }),
            })
          ).bytes,
        ).toString("utf8"),
      ) as { token: string };
      const { operation: addSovOp } = await d.adminClient.procedure<
        Record<string, unknown>,
        { operation: Record<string, unknown> }
      >("com.atproto.identity.signPlcOperation", {
        token: claimPlc.token,
        rotationKeys: [...recCreds.rotationKeys, sovKey.did()],
      });
      await d.adminClient.procedure("com.atproto.identity.submitPlcOperation", { operation: addSovOp });

      const ctrlDpop = await createDpopTestClient();
      const ctrlNonce: { nonce?: string } = {};
      const nowSecCtrl = Math.floor(Date.now() / 1000);
      const ctrlJwt = await signRawCompactJwt(
        sovKey,
        { typ: "JWT", alg: "ES256", kid: sovKey.did() },
        {
          iss: d.groupDid,
          aud: hostServiceDid,
          lxm: "com.atproto.server.createSession",
          iat: nowSecCtrl,
          exp: nowSecCtrl + 60,
          jti: randomUUID(),
        },
      );
      const ctrlSessRes = await sendParityDpop(d, ctrlDpop, ctrlNonce, d.baseUrl, "/group-admin/controller-session", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ctrlJwt}` },
        body: JSON.stringify({ group: d.groupDid }),
      });
      assert.equal(ctrlSessRes.status, 200);
      const { access_token: ctrlTok } = (await ctrlSessRes.json()) as { access_token: string };

      const wildcardInviteScope =
        "space:org.atgrp.inbox?authority=*&skey=self&collection=*&action=create&action=update&action=delete";
      const updAdminRoleRes = await sendParityDpop(
        d,
        ctrlDpop,
        ctrlNonce,
        d.baseUrl,
        "/xrpc/com.atproto.space.putRecord",
        {
          method: "POST",
          accessToken: ctrlTok,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            space: membersSpace,
            repo: d.groupDid,
            collection: ATGRP_COLLECTION.role,
            rkey: "admin",
            record: {
              displayName: "Admin",
              canAssign: ["*"],
              permissions: [...groupAdminScopes(d.groupDid).filter((s) => s !== "atproto"), wildcardInviteScope],
            },
          }),
        },
      );
      assert.equal(updAdminRoleRes.status, 200, `[${d.kind}] controller-session admin role update failed`);

      const wildClient = await d.clientForMemberWithScopes(d.aliceDid, ["atproto", wildcardInviteScope]);
      const unknownColErr = await captureErrorCode(() =>
        wildClient.procedure("com.atproto.space.putRecord", {
          space: bobInvSpace,
          repo: d.groupDid,
          collection: "app.bsky.feed.post",
          rkey: "3jzfcijpj2z2a",
          validate: false,
          record: { text: "Forbidden external collection", createdAt: new Date().toISOString() },
        }),
      );
      assert.deepEqual(
        unknownColErr,
        { status: 400, code: "InvalidRequest" },
        `[${d.kind}] external invites/self must reject unknown collection even with wildcard scope and validate: false`,
      );

      // =======================================================================
      // 4. Codex Round 4 Finding #8: Cryptographic `clientAttestation` verification on `http://localhost:...`!
      // =======================================================================
      const gatedChanUri = channelUri(d.groupDid, "localhost-app-gated");
      await d.adminClient.procedure("com.atproto.space.createSpace", {
        spaceType: SPACE_TYPE.channel,
        skey: "localhost-app-gated",
        policy: {
          $type: ATGRP_POLICY,
          publicRead: false,
          unlisted: false,
          allowedApps: [localhostClientId],
          grants: [{ role: "admin", read: true, write: true }],
        },
      });

      const aliceSignKp = await d.getPersonalSigningKeyForTest(d.aliceDid);
      const credKp = await P256Keypair.create({ exportable: true });
      const nowSecAtt = Math.floor(Date.now() / 1000);
      const makeDelTok = () =>
        createDelegationToken({
          iss: d.aliceDid as DidString,
          sub: gatedChanUri as SpaceRefString,
          aud: spaceHostAud(d.groupDid as DidString),
          keypair: aliceSignKp,
        });

      for (const badAtt of [
        // Forged signature claiming `http://localhost:...`
        signAttestation(wrongPrivKey, {
          iss: localhostClientId,
          sub: localhostClientId,
          aud: spaceHostAud(d.groupDid as DidString),
          iat: nowSecAtt,
          exp: nowSecAtt + 60,
          jti: `forged-${randomUUID()}`,
        }),
        // Wrong `aud`
        signAttestation(appPrivKey, {
          iss: localhostClientId,
          sub: localhostClientId,
          aud: "did:plc:wronggroupaaaaaaaaaaaaaa",
          iat: nowSecAtt,
          exp: nowSecAtt + 60,
          jti: `wrong-aud-${randomUUID()}`,
        }),
        // Expired `exp` beyond 5s clock tolerance
        signAttestation(appPrivKey, {
          iss: localhostClientId,
          sub: localhostClientId,
          aud: spaceHostAud(d.groupDid as DidString),
          iat: nowSecAtt - 120,
          exp: nowSecAtt - 30,
          jti: `expired-${randomUUID()}`,
        }),
      ]) {
        const badRes = await d.unauthHttpCall({
          path: "/xrpc/com.atproto.space.authorizeSpaceSync",
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            space: gatedChanUri,
            delegationToken: await makeDelTok(),
            credentialKey: credKp.did(),
            clientAttestation: badAtt,
          }),
        });
        assert.equal(badRes.status, 400, `[${d.kind}] invalid localhost clientAttestation must return 400`);
        assert.equal(
          (JSON.parse(Buffer.from(badRes.bytes).toString("utf8")) as { error: string }).error,
          "InvalidClientAttestation",
        );
      }

      // Valid ES256-signed `http://localhost:...` `clientAttestation` -> `200 OK`!
      const validAtt = signAttestation(appPrivKey, {
        iss: localhostClientId,
        sub: localhostClientId,
        aud: spaceHostAud(d.groupDid as DidString),
        iat: nowSecAtt,
        exp: nowSecAtt + 60,
        jti: `valid-${randomUUID()}`,
      });
      const validAttRes = await d.unauthHttpCall({
        path: "/xrpc/com.atproto.space.authorizeSpaceSync",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          space: gatedChanUri,
          delegationToken: await makeDelTok(),
          credentialKey: credKp.did(),
          clientAttestation: validAtt,
        }),
      });
      assert.equal(
        validAttRes.status,
        200,
        `[${d.kind}] valid localhost clientAttestation failed: ${Buffer.from(validAttRes.bytes).toString("utf8")}`,
      );

      // Replaying the same `jti` -> `400 InvalidClientAttestation`!
      const replayAttRes = await d.unauthHttpCall({
        path: "/xrpc/com.atproto.space.authorizeSpaceSync",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          space: gatedChanUri,
          delegationToken: await makeDelTok(),
          credentialKey: credKp.did(),
          clientAttestation: validAtt,
        }),
      });
      assert.equal(replayAttRes.status, 400, `[${d.kind}] replayed localhost clientAttestation must return 400`);
      assert.equal(
        (JSON.parse(Buffer.from(replayAttRes.bytes).toString("utf8")) as { error: string }).error,
        "InvalidClientAttestation",
      );
    }
  } finally {
    await new Promise<void>((resolve) => appServer.close(() => resolve()));
    await fake.cleanup();
    await real.cleanup();
  }
});

test("FakeNetwork & GroupHostServer Round 5 parity: operation-ID tombstones block same-ID reuse and pre-arrival aborts, and migration key provenance fails closed against live PLC rotationKeys & JWT bounds", async () => {
  const fake = await createFakeDriver({ joinPolicy: "open", publicMeta: true, withFlockWorkspace: true });
  const real = await createRealDriver({ joinPolicy: "open", publicMeta: true, withFlockWorkspace: true });

  const signRawCompactJwt = async (
    kp: P256Keypair,
    header: Record<string, unknown>,
    payload: Record<string, unknown>,
  ): Promise<string> => {
    const hdr = Buffer.from(JSON.stringify(header)).toString("base64url");
    const pld = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = await kp.sign(new TextEncoder().encode(`${hdr}.${pld}`));
    return `${hdr}.${pld}.${Buffer.from(sig).toString("base64url")}`;
  };

  try {
    for (const d of [fake, real]) {
      const peerDidDoc = (await (await d.rawFetch(`${d.peerMigrationEndpoint}/.well-known/did.json`, { method: "GET" })).json()) as {
        id: string;
      };
      const peerServiceDid = peerDidDoc.id;
      const groupSignKp = await d.getGroupSigningKeyForTest();
      const localRotKp = await d.getLocalRotationKeyForTest();

      const makeTargetJwt = async (lxm: string) => {
        const nowSec = Math.floor(Date.now() / 1000);
        return signRawCompactJwt(
          groupSignKp,
          { typ: "JWT", alg: "ES256", kid: "#atproto" },
          {
            iss: d.groupDid,
            aud: peerServiceDid,
            lxm,
            iat: nowSec,
            exp: nowSec + 60,
            jti: randomUUID(),
          },
        );
      };

      // =====================================================================
      // 1. Codex Round 5 Finding #2: Operation-ID tombstones across [fake, real]
      // =====================================================================
      const stageOp1Res = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.createAccount`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await makeTargetJwt("com.atproto.server.createAccount")}`,
          "x-group-migration-operation-id": "parity-r5-op-1",
        },
        body: JSON.stringify({ did: d.groupDid, handle: d.groupHandle }),
      });
      assert.equal(stageOp1Res.status, 200, `[${d.kind}] stage parity-r5-op-1 failed`);
      const op1Toks = (await stageOp1Res.json()) as { accessJwt: string };

      // Bearer-abort `parity-r5-op-1` -> `200 { status: "purged" }`
      const bearerAbort1 = await d.rawFetch(`${d.peerMigrationEndpoint}/group-admin/abort-migration`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${op1Toks.accessJwt}` },
        body: JSON.stringify({ group: d.groupDid, operationId: "parity-r5-op-1" }),
      });
      assert.equal(bearerAbort1.status, 200);
      assert.equal(((await bearerAbort1.json()) as { status: string }).status, "purged");

      // Reuse `parity-r5-op-1` -> rejected `409 OperationIdAlreadyAborted`!
      const reuseOp1Res = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.createAccount`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await makeTargetJwt("com.atproto.server.createAccount")}`,
          "x-group-migration-operation-id": "parity-r5-op-1",
        },
        body: JSON.stringify({ did: d.groupDid, handle: d.groupHandle }),
      });
      assert.equal(reuseOp1Res.status, 409, `[${d.kind}] reusing aborted operationId must return 409`);
      assert.equal(
        ((await reuseOp1Res.json()) as { error: string }).error,
        "OperationIdAlreadyAborted",
        `[${d.kind}] reusing aborted operationId must return OperationIdAlreadyAborted`,
      );

      // Stage `parity-r5-op-2`
      const stageOp2Res = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.createAccount`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await makeTargetJwt("com.atproto.server.createAccount")}`,
          "x-group-migration-operation-id": "parity-r5-op-2",
        },
        body: JSON.stringify({ did: d.groupDid, handle: d.groupHandle }),
      });
      assert.equal(stageOp2Res.status, 200, `[${d.kind}] stage parity-r5-op-2 failed`);
      const op2Toks = (await stageOp2Res.json()) as { accessJwt: string };

      // Delayed `#atproto` reaper abort JWT for `parity-r5-op-1` arrives -> `200 { status: "superseded" }` and `op-2` stays intact!
      const delayedAbort1Res = await d.rawFetch(`${d.peerMigrationEndpoint}/group-admin/abort-migration`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await makeTargetJwt("new.flock.group.abortMigration")}`,
        },
        body: JSON.stringify({
          group: d.groupDid,
          operationId: "parity-r5-op-1",
          deadlineAtMs: Date.now() + 7_200_000,
        }),
      });
      assert.equal(delayedAbort1Res.status, 200);
      assert.equal(((await delayedAbort1Res.json()) as { status: string }).status, "superseded");

      const checkOp2Res = await d.rawFetch(
        `${d.peerMigrationEndpoint}/xrpc/com.atproto.server.checkAccountStatus`,
        {
          method: "GET",
          headers: { authorization: `Bearer ${op2Toks.accessJwt}` },
        },
      );
      assert.equal(checkOp2Res.status, 200, `[${d.kind}] parity-r5-op-2 must survive delayed reaper abort for parity-r5-op-1`);

      // Clean up `parity-r5-op-2` via Bearer abort; verify BOTH `parity-r5-op-1` and `parity-r5-op-2` remain tombstoned!
      const bearerAbort2 = await d.rawFetch(`${d.peerMigrationEndpoint}/group-admin/abort-migration`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${op2Toks.accessJwt}` },
        body: JSON.stringify({ group: d.groupDid }),
      });
      assert.equal(bearerAbort2.status, 200);
      for (const retiredOp of ["parity-r5-op-1", "parity-r5-op-2"]) {
        const retryRetired = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.createAccount`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${await makeTargetJwt("com.atproto.server.createAccount")}`,
            "x-group-migration-operation-id": retiredOp,
          },
          body: JSON.stringify({ did: d.groupDid, handle: d.groupHandle }),
        });
        assert.equal(retryRetired.status, 409, `[${d.kind}] ${retiredOp} must remain tombstoned`);
        assert.equal(((await retryRetired.json()) as { error: string }).error, "OperationIdAlreadyAborted");
      }

      // Pre-arrival `#atproto` abort JWT (`status: "already_absent"`) followed by late `createAccount` -> `409 OperationIdAlreadyAborted`!
      const preAbortRes = await d.rawFetch(`${d.peerMigrationEndpoint}/group-admin/abort-migration`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await makeTargetJwt("new.flock.group.abortMigration")}`,
        },
        body: JSON.stringify({
          group: d.groupDid,
          operationId: "parity-r5-op-pre",
          deadlineAtMs: Date.now() + 7_200_000,
        }),
      });
      assert.equal(preAbortRes.status, 200);
      assert.equal(((await preAbortRes.json()) as { status: string }).status, "already_absent");

      const latePreCreateRes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.createAccount`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await makeTargetJwt("com.atproto.server.createAccount")}`,
          "x-group-migration-operation-id": "parity-r5-op-pre",
        },
        body: JSON.stringify({ did: d.groupDid, handle: d.groupHandle }),
      });
      assert.equal(latePreCreateRes.status, 409, `[${d.kind}] pre-arrival abort must reject late createAccount`);
      assert.equal(((await latePreCreateRes.json()) as { error: string }).error, "OperationIdAlreadyAborted");

      // =====================================================================
      // 2. Codex Round 5 Finding #3: Fail-closed `public-group-keys` & `migration-manifest` provenance
      // =====================================================================
      const uninvolvedKey = await P256Keypair.create();
      const nowSec = Math.floor(Date.now() / 1000);

      for (const badPkCase of [
        {
          label: "missing typ: JWT",
          header: { alg: "ES256", kid: "#atproto" },
          localRotationKey: localRotKp.did(),
          claims: {
            iss: d.groupDid,
            groupDid: d.groupDid,
            localRotationKey: localRotKp.did(),
            iat: nowSec,
            exp: nowSec + 300,
          },
        },
        {
          label: "missing iat",
          header: { typ: "JWT", alg: "ES256", kid: "#atproto" },
          localRotationKey: localRotKp.did(),
          claims: {
            iss: d.groupDid,
            groupDid: d.groupDid,
            localRotationKey: localRotKp.did(),
            exp: nowSec + 300,
          },
        },
        {
          label: "future iat > now + 5s",
          header: { typ: "JWT", alg: "ES256", kid: "#atproto" },
          localRotationKey: localRotKp.did(),
          claims: {
            iss: d.groupDid,
            groupDid: d.groupDid,
            localRotationKey: localRotKp.did(),
            iat: nowSec + 30,
            exp: nowSec + 300,
          },
        },
        {
          label: "exp - iat > 300s",
          header: { typ: "JWT", alg: "ES256", kid: "#atproto" },
          localRotationKey: localRotKp.did(),
          claims: {
            iss: d.groupDid,
            groupDid: d.groupDid,
            localRotationKey: localRotKp.did(),
            iat: nowSec - 10,
            exp: nowSec + 310,
          },
        },
        {
          label: "localRotationKey not in live PLC rotationKeys",
          header: { typ: "JWT", alg: "ES256", kid: "#atproto" },
          localRotationKey: uninvolvedKey.did(),
          claims: {
            iss: d.groupDid,
            groupDid: d.groupDid,
            localRotationKey: uninvolvedKey.did(),
            iat: nowSec,
            exp: nowSec + 300,
          },
        },
      ]) {
        const forgedJwt = await signRawCompactJwt(groupSignKp, badPkCase.header, badPkCase.claims);
        d.setPeerOutboundInterceptor(async (urlStr, _init, forward) => {
          if (urlStr.includes("/group-admin/public-group-keys")) {
            return new Response(
              JSON.stringify({
                groupDid: d.groupDid,
                localRotationKey: badPkCase.localRotationKey,
                proofJwt: forgedJwt,
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          return forward();
        });

        const badPkRes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.createAccount`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${await makeTargetJwt("com.atproto.server.createAccount")}`,
            "x-group-migration-operation-id": `parity-bad-pk-${randomUUID().slice(0, 8)}`,
          },
          body: JSON.stringify({ did: d.groupDid, handle: d.groupHandle }),
        });
        assert.equal(badPkRes.status, 400, `[${d.kind}] public-group-keys (${badPkCase.label}) must fail closed with 400`);
        assert.equal(
          ((await badPkRes.json()) as { error: string }).error,
          "InvalidSourceKeyProof",
          `[${d.kind}] public-group-keys (${badPkCase.label}) must return InvalidSourceKeyProof`,
        );
      }
      d.setPeerOutboundInterceptor(undefined);

      // Coordinated `migration-manifest` fail-closed checks across [fake, real]
      const prepCoordRes = await d.groupHttpCall({
        path: "/group-admin/prepare-migration",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          group: d.groupDid,
          operationId: "parity-r5-coord-1",
          targetEndpoint: d.peerMigrationEndpoint,
          mode: "coordinated",
        }),
      });
      assert.equal(prepCoordRes.status, 200);
      const { migrationTicket: coordTicket } = JSON.parse(Buffer.from(prepCoordRes.bytes).toString("utf8")) as {
        migrationTicket: string;
      };

      for (const badManCase of [
        {
          label: "sourceLocalRotationKey not in live PLC rotationKeys",
          mutate: (body: Record<string, unknown>) => ({ ...body, sourceLocalRotationKey: uninvolvedKey.did() }),
          expectedCode: "InvalidSourceKeyProof",
        },
        {
          label: "expired deadlineAtMs",
          mutate: (body: Record<string, unknown>) => ({ ...body, deadlineAtMs: Date.now() - 5_000 }),
          expectedCode: "InvalidMigrationManifest",
        },
        {
          label: "excessive deadlineAtMs > now + 2h + 60s",
          mutate: (body: Record<string, unknown>) => ({ ...body, deadlineAtMs: Date.now() + 3 * 3_600_000 }),
          expectedCode: "InvalidMigrationManifest",
        },
        {
          label: "invalid operationId syntax",
          mutate: (body: Record<string, unknown>) => ({ ...body, operationId: "invalid op!" }),
          expectedCode: "InvalidMigrationManifest",
        },
      ]) {
        d.setPeerOutboundInterceptor(async (urlStr, _init, forward) => {
          const upstream = await forward();
          if (urlStr.includes("/group-admin/migration-manifest")) {
            const orig = (await upstream.json()) as Record<string, unknown>;
            return new Response(JSON.stringify(badManCase.mutate(orig)), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          return upstream;
        });

        const badCoordRes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.createAccount`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${await makeTargetJwt("com.atproto.server.createAccount")}`,
            "x-group-migration-ticket": coordTicket,
          },
          body: JSON.stringify({ did: d.groupDid, handle: d.groupHandle }),
        });
        assert.equal(badCoordRes.status, 400, `[${d.kind}] migration-manifest (${badManCase.label}) must fail closed with 400`);
        assert.equal(
          ((await badCoordRes.json()) as { error: string }).error,
          badManCase.expectedCode,
          `[${d.kind}] migration-manifest (${badManCase.label}) must return ${badManCase.expectedCode}`,
        );
      }
      d.setPeerOutboundInterceptor(undefined);

      // Verify zero target staging session was created on peer across all rejected provenance checks!
      const verifyNoStagingRes = await d.rawFetch(`${d.peerMigrationEndpoint}/group-admin/abort-migration`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await makeTargetJwt("new.flock.group.abortMigration")}`,
        },
        body: JSON.stringify({ group: d.groupDid, operationId: "parity-r5-verify-none" }),
      });
      assert.equal(verifyNoStagingRes.status, 200);
      assert.equal(
        ((await verifyNoStagingRes.json()) as { status: string }).status,
        "already_absent",
        `[${d.kind}] failed provenance checks must never stage a migration_session`,
      );
    }
  } finally {
    await fake.cleanup();
    await real.cleanup();
  }
});

test("FakeNetwork & GroupHostServer Round 6 parity: per-issuer clientAttestation & delegationToken JTI isolation and post-expiry JTI reuse", async () => {
  const { generateKeyPairSync, createSign } = await import("node:crypto");
  const { createServer } = await import("node:http");

  const appA = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const appB = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwkA = { ...(appA.publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: "app-a-1", alg: "ES256", use: "sig" };
  const jwkB = { ...(appB.publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: "app-b-1", alg: "ES256", use: "sig" };

  let appOrigin = "";
  const appServer = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/app-a/client-metadata.json") {
      res.end(
        JSON.stringify({
          client_id: `${appOrigin}/app-a/client-metadata.json`,
          jwks: { keys: [jwkA] },
        }),
      );
      return;
    }
    if (req.url === "/app-b/client-metadata.json") {
      res.end(
        JSON.stringify({
          client_id: `${appOrigin}/app-b/client-metadata.json`,
          jwks: { keys: [jwkB] },
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "NotFound" }));
  });
  await new Promise<void>((resolve) => appServer.listen(0, "127.0.0.1", () => resolve()));
  const addr = appServer.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  appOrigin = `http://localhost:${port}`;
  const clientIdA = `${appOrigin}/app-a/client-metadata.json`;
  const clientIdB = `${appOrigin}/app-b/client-metadata.json`;

  const signAttestation = (
    privKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
    kid: string,
    payload: Record<string, unknown>,
  ): string => {
    const header = { alg: "ES256", typ: "atproto-client-attestation+jwt", kid };
    const signingInput = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
    const sig = createSign("SHA256")
      .update(signingInput)
      .sign({ key: privKey, dsaEncoding: "ieee-p1363" });
    return `${signingInput}.${Buffer.from(sig).toString("base64url")}`;
  };

  const signDelegation = async (
    kp: P256Keypair,
    payload: Record<string, unknown>,
  ): Promise<string> => {
    const header = { alg: kp.jwtAlg, typ: "atproto-space-delegation+jwt", kid: "#atproto" };
    const signingInput = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
    const sig = await kp.sign(new TextEncoder().encode(signingInput));
    return `${signingInput}.${Buffer.from(sig).toString("base64url")}`;
  };

  const fake = await createFakeDriver({ joinPolicy: "open", publicMeta: true });
  const real = await createRealDriver({ joinPolicy: "open", publicMeta: true });

  try {
    for (const d of [fake, real]) {
      // Create a space allowing both `clientIdA` and `clientIdB` (`allowedApps`) and both `admin` and `member` roles!
      const chanUri = channelUri(d.groupDid, "r6-att-parity");
      await d.adminClient.procedure("com.atproto.space.createSpace", {
        spaceType: SPACE_TYPE.channel,
        skey: "r6-att-parity",
        policy: {
          $type: ATGRP_POLICY,
          publicRead: false,
          unlisted: false,
          allowedApps: [clientIdA, clientIdB],
          grants: [
            { role: "admin", read: true, write: true },
            { role: "member", read: true, write: true },
          ],
        },
      });

      // Grant `bobDid` `member` access in `members/self` so cross-issuer delegationToken JTI isolation can be tested too!
      await d.adminClient.procedure("com.atproto.space.putRecord", {
        space: `at:space/${d.groupDid}/org.atgrp.members/self`,
        repo: d.groupDid,
        collection: "org.atgrp.membership",
        rkey: d.bobDid,
        record: {
          $type: "org.atgrp.membership",
          roles: ["member"],
          createdAt: new Date().toISOString(),
        },
      });

      const aliceSignKp = await d.getPersonalSigningKeyForTest(d.aliceDid);
      const bobSignKp = await d.getPersonalSigningKeyForTest(d.bobDid);
      const credKp = await P256Keypair.create({ exportable: true });
      const nowSec = Math.floor(Date.now() / 1000);
      const sharedAttJti = `shared-att-jti-${d.kind}`;
      const sharedDelJti = `shared-del-jti-${d.kind}`;

      // Use `exp = nowSec - 4` (within 5s clock skew right now -> `expiresAtMs = (nowSec + 1) * 1000`)
      // so both immediate replay rejection AND post-expiry reuse (~1.4s later, without running any pruner!) are tested over real HTTP!
      const attA1 = signAttestation(appA.privateKey, "app-a-1", {
        iss: clientIdA,
        sub: clientIdA,
        aud: spaceHostAud(d.groupDid as DidString),
        iat: nowSec - 10,
        exp: nowSec - 4,
        jti: sharedAttJti,
      });
      const delAdmin1 = await signDelegation(aliceSignKp, {
        iss: d.aliceDid,
        sub: chanUri,
        aud: spaceHostAud(d.groupDid as DidString),
        iat: nowSec - 10,
        exp: nowSec - 4,
        jti: sharedDelJti,
      });

      // 1. First call with `(clientIdA, sharedAttJti)` and `(aliceDid, sharedDelJti)` -> 200 OK!
      const res1 = await d.unauthHttpCall({
        path: "/xrpc/com.atproto.space.authorizeSpaceSync",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          space: chanUri,
          delegationToken: delAdmin1,
          credentialKey: credKp.did(),
          clientAttestation: attA1,
        }),
      });
      assert.equal(res1.status, 200, `[${d.kind}] initial authorizeSpaceSync failed: ${Buffer.from(res1.bytes).toString("utf8")}`);

      // 2. Immediate same-issuer `clientAttestation` JTI replay -> 400 InvalidClientAttestation!
      const freshDelAdmin = await signDelegation(aliceSignKp, {
        iss: d.aliceDid,
        sub: chanUri,
        aud: spaceHostAud(d.groupDid as DidString),
        iat: nowSec,
        exp: nowSec + 60,
        jti: `fresh-del-${randomUUID()}`,
      });
      const replayAttRes = await d.unauthHttpCall({
        path: "/xrpc/com.atproto.space.authorizeSpaceSync",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          space: chanUri,
          delegationToken: freshDelAdmin,
          credentialKey: credKp.did(),
          clientAttestation: attA1,
        }),
      });
      assert.equal(replayAttRes.status, 400, `[${d.kind}] same-issuer clientAttestation JTI replay must return 400`);
      assert.equal(
        (JSON.parse(Buffer.from(replayAttRes.bytes).toString("utf8")) as { error: string }).error,
        "InvalidClientAttestation",
      );

      // 3. Immediate same-issuer `delegationToken` JTI replay -> 400 InvalidDelegationToken!
      const freshAttA = signAttestation(appA.privateKey, "app-a-1", {
        iss: clientIdA,
        sub: clientIdA,
        aud: spaceHostAud(d.groupDid as DidString),
        iat: nowSec,
        exp: nowSec + 60,
        jti: `fresh-att-${randomUUID()}`,
      });
      const replayDelRes = await d.unauthHttpCall({
        path: "/xrpc/com.atproto.space.authorizeSpaceSync",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          space: chanUri,
          delegationToken: delAdmin1,
          credentialKey: credKp.did(),
          clientAttestation: freshAttA,
        }),
      });
      assert.equal(replayDelRes.status, 400, `[${d.kind}] same-issuer delegationToken JTI replay must return 400`);
      assert.equal(
        (JSON.parse(Buffer.from(replayDelRes.bytes).toString("utf8")) as { error: string }).error,
        "InvalidDelegationToken",
      );

      // 4. Cross-issuer reuse of the EXACT SAME `sharedAttJti` (`clientIdB`) AND `sharedDelJti` (`bobDid`) -> 200 OK on BOTH!
      const attBWithSameJti = signAttestation(appB.privateKey, "app-b-1", {
        iss: clientIdB,
        sub: clientIdB,
        aud: spaceHostAud(d.groupDid as DidString),
        iat: nowSec,
        exp: nowSec + 60,
        jti: sharedAttJti,
      });
      const delMemberWithSameJti = await signDelegation(bobSignKp, {
        iss: d.bobDid,
        sub: chanUri,
        aud: spaceHostAud(d.groupDid as DidString),
        iat: nowSec,
        exp: nowSec + 60,
        jti: sharedDelJti,
      });
      const crossIssuerRes = await d.unauthHttpCall({
        path: "/xrpc/com.atproto.space.authorizeSpaceSync",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          space: chanUri,
          delegationToken: delMemberWithSameJti,
          credentialKey: credKp.did(),
          clientAttestation: attBWithSameJti,
        }),
      });
      assert.equal(
        crossIssuerRes.status,
        200,
        `[${d.kind}] cross-issuer JTI reuse must succeed: ${Buffer.from(crossIssuerRes.bytes).toString("utf8")}`,
      );

      // 5. Advance past `(exp + 5) * 1000` (~1.4s) and verify post-expiry JTI reuse by the SAME issuer (`clientIdA` & `aliceDid`) succeeds 200 OK on BOTH!
      await new Promise((r) => setTimeout(r, 1400));
      const laterSec = Math.floor(Date.now() / 1000);
      const attAPostExpiry = signAttestation(appA.privateKey, "app-a-1", {
        iss: clientIdA,
        sub: clientIdA,
        aud: spaceHostAud(d.groupDid as DidString),
        iat: laterSec,
        exp: laterSec + 60,
        jti: sharedAttJti,
      });
      const delAdminPostExpiry = await signDelegation(aliceSignKp, {
        iss: d.aliceDid,
        sub: chanUri,
        aud: spaceHostAud(d.groupDid as DidString),
        iat: laterSec,
        exp: laterSec + 60,
        jti: sharedDelJti,
      });
      const postExpiryRes = await d.unauthHttpCall({
        path: "/xrpc/com.atproto.space.authorizeSpaceSync",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          space: chanUri,
          delegationToken: delAdminPostExpiry,
          credentialKey: credKp.did(),
          clientAttestation: attAPostExpiry,
        }),
      });
      assert.equal(
        postExpiryRes.status,
        200,
        `[${d.kind}] post-expiry JTI reuse must succeed: ${Buffer.from(postExpiryRes.bytes).toString("utf8")}`,
      );
    }
  } finally {
    await new Promise<void>((resolve) => appServer.close(() => resolve()));
    await fake.cleanup();
    await real.cleanup();
  }
});

test("FakeNetwork & GroupHostServer Round 7 parity: signPlcOperation pre-side-effect validation, atomic concurrent refreshSession rotation, capabilityProofJwt JWT/kid/lifetime constraints, and publicRead notifyCredentialsRevoked fanout", async () => {
  const fake = await createFakeDriver({ joinPolicy: "open", publicMeta: true, withFlockWorkspace: true });
  const real = await createRealDriver({ joinPolicy: "open", publicMeta: true, withFlockWorkspace: true });

  const signRawCompactJwt = async (
    kp: P256Keypair,
    header: Record<string, unknown>,
    payload: Record<string, unknown>,
  ): Promise<string> => {
    const hdr = Buffer.from(JSON.stringify(header)).toString("base64url");
    const pld = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = await kp.sign(new TextEncoder().encode(`${hdr}.${pld}`));
    return `${hdr}.${pld}.${Buffer.from(sig).toString("base64url")}`;
  };

  try {
    for (const d of [fake, real]) {
      const membersSpace = groupMembersUri(d.groupDid);
      const metaSpace = groupMetaUri(d.groupDid);
      const peerDidDoc = (
        await (await d.rawFetch(`${d.peerMigrationEndpoint}/.well-known/did.json`, { method: "GET" })).json()
      ) as { id: string };
      const peerServiceDid = peerDidDoc.id;
      const peerSvcKeypair = await d.getPeerServiceKeypairForTest();
      const groupSignKp = await d.getGroupSigningKeyForTest();
      const localRotKp = await d.getLocalRotationKeyForTest();

      const makeTargetJwt = async (lxm: string) => {
        const nowSec = Math.floor(Date.now() / 1000);
        return signRawCompactJwt(
          groupSignKp,
          { typ: "JWT", alg: "ES256", kid: "#atproto" },
          {
            iss: d.groupDid,
            aud: peerServiceDid,
            lxm,
            iat: nowSec,
            exp: nowSec + 60,
            jti: randomUUID(),
          },
        );
      };

      // Admit Bob with a non-admin custom role granting `identity:*`
      await d.adminClient.procedure("com.atproto.space.putRecord", {
        space: membersSpace,
        repo: d.groupDid,
        collection: ATGRP_COLLECTION.role,
        rkey: "id-viewer-role",
        record: {
          displayName: "Identity Viewer",
          permissions: ["identity:*"],
        },
      });
      await d.adminClient.procedure("com.atproto.space.putRecord", {
        space: membersSpace,
        repo: d.groupDid,
        collection: ATGRP_COLLECTION.membership,
        rkey: d.bobDid,
        record: {
          roles: ["member", "id-viewer-role"],
          createdAt: new Date().toISOString(),
        },
      });
      const bobIdClient = await d.clientForMemberWithScopes(d.bobDid, ["atproto", "identity:*"]);

      // =====================================================================
      // 1. Codex Round 7 Finding #3 parity: `capabilityProofJwt` cryptographic, designated-key & lifetime checks
      // =====================================================================
      const auxKp = await P256Keypair.create({ exportable: true });
      const kemKp = await P256Keypair.create({ exportable: true });
      const auxMultibase = auxKp.did().replace(/^did:key:/, "");
      const kemMultibase = kemKp.did().replace(/^did:key:/, "");
      const nowSecCap = Math.floor(Date.now() / 1000);

      for (const badCap of [
        {
          label: "missing typ: JWT",
          signer: peerSvcKeypair,
          header: { alg: "ES256", kid: "#atproto" },
          claims: {
            iss: peerServiceDid,
            iat: nowSecCap,
            exp: nowSecCap + 300,
            endpoint: d.peerMigrationEndpoint,
            supportedSpacePolicies: [ATGRP_POLICY],
            atomicMigrationVersion: 1,
          },
        },
        {
          label: "auxiliary verificationMethod #aux",
          signer: auxKp,
          header: { typ: "JWT", alg: "ES256", kid: "#aux" },
          claims: {
            iss: peerServiceDid,
            iat: nowSecCap,
            exp: nowSecCap + 300,
            endpoint: d.peerMigrationEndpoint,
            supportedSpacePolicies: [ATGRP_POLICY],
            atomicMigrationVersion: 1,
          },
        },
        {
          label: "encryption verificationMethod #atproto_kem",
          signer: kemKp,
          header: { typ: "JWT", alg: "ES256", kid: "#atproto_kem" },
          claims: {
            iss: peerServiceDid,
            iat: nowSecCap,
            exp: nowSecCap + 300,
            endpoint: d.peerMigrationEndpoint,
            supportedSpacePolicies: [ATGRP_POLICY],
            atomicMigrationVersion: 1,
          },
        },
        {
          label: "missing iat",
          signer: peerSvcKeypair,
          header: { typ: "JWT", alg: "ES256", kid: "#atproto" },
          claims: {
            iss: peerServiceDid,
            exp: nowSecCap + 300,
            endpoint: d.peerMigrationEndpoint,
            supportedSpacePolicies: [ATGRP_POLICY],
            atomicMigrationVersion: 1,
          },
        },
        {
          label: "future iat > now + 5s",
          signer: peerSvcKeypair,
          header: { typ: "JWT", alg: "ES256", kid: "#atproto" },
          claims: {
            iss: peerServiceDid,
            iat: nowSecCap + 30,
            exp: nowSecCap + 300,
            endpoint: d.peerMigrationEndpoint,
            supportedSpacePolicies: [ATGRP_POLICY],
            atomicMigrationVersion: 1,
          },
        },
        {
          label: "excessive lifetime exp - iat > 300s",
          signer: peerSvcKeypair,
          header: { typ: "JWT", alg: "ES256", kid: "#atproto" },
          claims: {
            iss: peerServiceDid,
            iat: nowSecCap - 10,
            exp: nowSecCap + 295,
            endpoint: d.peerMigrationEndpoint,
            supportedSpacePolicies: [ATGRP_POLICY],
            atomicMigrationVersion: 1,
          },
        },
      ]) {
        const badProof = await signRawCompactJwt(badCap.signer, badCap.header, badCap.claims);
        d.setSourceOutboundInterceptor(async (urlStr, _init, forward) => {
          if (urlStr.endsWith("/group-admin/migration-info")) {
            const orig = (await (await forward()).json()) as Record<string, unknown>;
            return new Response(JSON.stringify({ ...orig, capabilityProofJwt: badProof }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          if (urlStr.endsWith("/.well-known/did.json")) {
            const origDoc = (await (await forward()).json()) as {
              id: string;
              verificationMethod?: Array<Record<string, unknown>>;
            };
            if (origDoc.id === peerServiceDid) {
              return new Response(
                JSON.stringify({
                  ...origDoc,
                  verificationMethod: [
                    ...(origDoc.verificationMethod ?? []),
                    { id: `${origDoc.id}#aux`, type: "Multikey", controller: origDoc.id, publicKeyMultibase: auxMultibase },
                    {
                      id: `${origDoc.id}#atproto_kem`,
                      type: "Multikey",
                      controller: origDoc.id,
                      publicKeyMultibase: kemMultibase,
                    },
                  ],
                }),
                { status: 200, headers: { "content-type": "application/did+ld+json" } },
              );
            }
          }
          return forward();
        });

        const badPrep = await d.groupHttpCall({
          path: "/group-admin/prepare-migration",
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            group: d.groupDid,
            operationId: `parity-r7-cap-${randomUUID().slice(0, 8)}`,
            targetEndpoint: d.peerMigrationEndpoint,
          }),
        });
        assert.equal(badPrep.status, 400, `[${d.kind}] prepare-migration must reject (${badCap.label})`);
        assert.equal(
          (JSON.parse(Buffer.from(badPrep.bytes).toString("utf8")) as { error: string }).error,
          "UnsupportedGroupHostTarget",
          `[${d.kind}] prepare-migration must return UnsupportedGroupHostTarget (${badCap.label})`,
        );

        const badSvcErr = await captureErrorCode(() =>
          d.adminClient.query("com.atproto.server.getServiceAuth", {
            aud: peerServiceDid,
            lxm: "com.atproto.server.createAccount",
          }),
        );
        assert.deepEqual(
          badSvcErr,
          { status: 400, code: "UnsupportedGroupHostTarget" },
          `[${d.kind}] getServiceAuth(createAccount) must reject (${badCap.label})`,
        );
      }
      d.setSourceOutboundInterceptor(undefined);

      // =====================================================================
      // 2. Codex Round 7 Finding #4 parity: `writer_did === null` publicRead `notifyCredentialsRevoked` fanout
      // =====================================================================
      const pubChanUri = channelUri(d.groupDid, "r7-public-fanout");
      await d.adminClient.procedure("com.atproto.space.createSpace", {
        spaceType: SPACE_TYPE.channel,
        skey: "r7-public-fanout",
        policy: {
          $type: ATGRP_POLICY,
          publicRead: true,
          unlisted: false,
          grants: [
            { role: "admin", read: true, write: true },
            { role: "member", read: true, write: true },
          ],
        },
      });

      const bobSignKp = await d.getPersonalSigningKeyForTest(d.bobDid);
      const bobNruJwt = await signRawCompactJwt(
        bobSignKp,
        { typ: "JWT", alg: "ES256", kid: "#atproto" },
        {
          iss: d.bobDid,
          aud: `${d.groupDid}#atproto_pds`,
          lxm: "com.atproto.space.notifyRepoUpdate",
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 60,
          jti: randomUUID(),
        },
      );
      const nruRes = await d.unauthHttpCall({
        path: "/xrpc/com.atproto.space.notifyRepoUpdate",
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${bobNruJwt}`,
        },
        body: JSON.stringify({
          space: pubChanUri,
          repo: d.bobDid,
          repoRev: "3jzfcijpj2z2a",
          data: { $bytes: Buffer.alloc(32, 5).toString("base64") },
        }),
      });
      assert.equal(nruRes.status, 200, `[${d.kind}] notifyRepoUpdate failed`);

      const anonCredKp = await P256Keypair.create({ exportable: true });
      const anonSyncRes = await d.unauthHttpCall({
        path: "/xrpc/com.atproto.space.authorizeSpaceSync",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          space: pubChanUri,
          credentialKey: anonCredKp.did(),
        }),
      });
      assert.equal(anonSyncRes.status, 200);
      const anonCredJwt = (JSON.parse(Buffer.from(anonSyncRes.bytes).toString("utf8")) as { credential: string })
        .credential;
      const anonJti = (
        JSON.parse(Buffer.from(anonCredJwt.split(".")[1]!, "base64url").toString("utf8")) as { jti: string }
      ).jti;

      const capturedBobRevocations: Array<{ aud: string; space: string; credentials: string[] }> = [];
      d.setSourceOutboundInterceptor(async (urlStr, init, forward) => {
        if (urlStr.endsWith("/xrpc/com.atproto.space.notifyCredentialsRevoked")) {
          const authHdr = new Headers(init?.headers).get("authorization") ?? "";
          const rawJwt = authHdr.replace(/^Bearer\s+/i, "");
          const claims = JSON.parse(Buffer.from(rawJwt.split(".")[1]!, "base64url").toString("utf8")) as {
            aud: string;
          };
          const rawBody =
            typeof init?.body === "string"
              ? init.body
              : init instanceof Request
                ? await init.clone().text()
                : "{}";
          const parsedBody = JSON.parse(rawBody) as { space: string; credentials: string[] };
          capturedBobRevocations.push({
            aud: claims.aud,
            space: parsedBody.space,
            credentials: parsedBody.credentials,
          });
        }
        return forward();
      });

      await d.adminClient.procedure("com.atproto.space.deleteSpace", { space: pubChanUri });
      await d.flushSourceBackgroundWork();
      d.setSourceOutboundInterceptor(undefined);

      assert.equal(
        capturedBobRevocations.length,
        1,
        `[${d.kind}] deleteSpace must fan out anonymous publicRead notifyCredentialsRevoked to external writer Bob`,
      );
      assert.equal(capturedBobRevocations[0]!.aud, d.bobDid);
      assert.equal(capturedBobRevocations[0]!.space, pubChanUri);
      assert.deepEqual(capturedBobRevocations[0]!.credentials, [anonJti]);

      // =====================================================================
      // 3. Codex Round 7 Finding #1 parity: `signPlcOperation` pre-side-effect validation
      //    (zero issued credentials revoked & valid token preserved on ANY failure!)
      // =====================================================================
      const liveMetaCredKp = await P256Keypair.create({ exportable: true });
      const liveMetaSyncRes = await d.unauthHttpCall({
        path: "/xrpc/com.atproto.space.authorizeSpaceSync",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          space: metaSpace,
          credentialKey: liveMetaCredKp.did(),
        }),
      });
      assert.equal(liveMetaSyncRes.status, 200);
      const liveMetaCredJwt = (
        JSON.parse(Buffer.from(liveMetaSyncRes.bytes).toString("utf8")) as { credential: string }
      ).credential;

      const assertMetaCredStillValid = async (reason: string) => {
        const { headers: sigHeaders } = await createSpaceSigHeaders({
          keypair: liveMetaCredKp,
          authorization: `Atproto-Space-Credential ${liveMetaCredJwt}`,
          audience: d.groupDid as DidString,
        });
        const lwRes = await d.unauthHttpCall({
          path: `/xrpc/com.atproto.space.listWriters?space=${encodeURIComponent(metaSpace)}`,
          method: "GET",
          headers: sigHeaders,
        });
        assert.equal(lwRes.status, 200, `[${d.kind}] (${reason}) failed signPlcOperation must NOT revoke issued credentials`);
      };

      await d.adminClient.procedure("com.atproto.identity.requestPlcOperationSignature", {});
      const claimPlcRes = await d.groupHttpCall({
        path: "/group-admin/claim-action-token",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ group: d.groupDid, purpose: "plc_operation" }),
      });
      assert.equal(claimPlcRes.status, 200);
      const { token: validPlcTok } = JSON.parse(Buffer.from(claimPlcRes.bytes).toString("utf8")) as { token: string };

      const candTargetRot = await P256Keypair.create();
      const candTargetSign = await P256Keypair.create();
      const candTargetKem = await P256Keypair.create();
      const baseCutoverReq = {
        rotationKeys: [candTargetRot.did()],
        alsoKnownAs: [`at://${d.groupHandle}`],
        verificationMethods: {
          atproto: candTargetSign.did(),
          atproto_kem: candTargetKem.did(),
        },
        services: {
          atproto_pds: { type: "AtprotoPersonalDataServer", endpoint: d.peerMigrationEndpoint },
          atgrp_host: { type: "AtmosphereGroupHostV1", endpoint: d.peerMigrationEndpoint },
        },
      };

      // (a) Invalid confirmation token -> `400 InvalidToken`
      const badTokErr = await captureErrorCode(() =>
        d.adminClient.procedure("com.atproto.identity.signPlcOperation", {
          token: "wrong-token",
          ...baseCutoverReq,
        }),
      );
      assert.deepEqual(badTokErr, { status: 400, code: "InvalidToken" }, `[${d.kind}] wrong token must return 400 InvalidToken`);
      await assertMetaCredStillValid("wrong token");

      // (b) Non-lifecycle-admin Bob -> `403 Forbidden`
      const nonAdminSignErr = await captureErrorCode(() =>
        bobIdClient.procedure("com.atproto.identity.signPlcOperation", {
          token: validPlcTok,
          ...baseCutoverReq,
        }),
      );
      assert.deepEqual(nonAdminSignErr, { status: 403, code: "Forbidden" }, `[${d.kind}] non-admin must return 403 Forbidden`);
      await assertMetaCredStillValid("non-admin caller");

      // (c) `SourceRotationKeyRetained` -> `400 SourceRotationKeyRetained`
      const retainRotErr = await captureErrorCode(() =>
        d.adminClient.procedure("com.atproto.identity.signPlcOperation", {
          token: validPlcTok,
          ...baseCutoverReq,
          rotationKeys: [candTargetRot.did(), localRotKp.did()],
        }),
      );
      assert.deepEqual(retainRotErr, { status: 400, code: "SourceRotationKeyRetained" });
      await assertMetaCredStillValid("SourceRotationKeyRetained");

      // (d) Bare personal PDS target -> `400 UnsupportedGroupHostTarget`
      const bareTargetErr = await captureErrorCode(() =>
        d.adminClient.procedure("com.atproto.identity.signPlcOperation", {
          token: validPlcTok,
          ...baseCutoverReq,
          services: {
            atproto_pds: { type: "AtprotoPersonalDataServer", endpoint: d.personalPdsEndpointForBob },
          },
        }),
      );
      assert.deepEqual(bareTargetErr, { status: 400, code: "UnsupportedGroupHostTarget" });
      await assertMetaCredStillValid("bare PDS target");

      // (e) Coordinated lease where target attestation has not staged yet -> `409 MigrationAttestationFailed`
      const prepAttFail = await d.groupHttpCall({
        path: "/group-admin/prepare-migration",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          group: d.groupDid,
          operationId: "parity-r7-att-fail",
          targetEndpoint: d.peerMigrationEndpoint,
        }),
      });
      assert.equal(prepAttFail.status, 200);
      const attFailErr = await captureErrorCode(() =>
        d.adminClient.procedure("com.atproto.identity.signPlcOperation", {
          token: validPlcTok,
          ...baseCutoverReq,
        }),
      );
      assert.deepEqual(attFailErr, { status: 409, code: "MigrationAttestationFailed" });
      await assertMetaCredStillValid("MigrationAttestationFailed");

      await d.groupHttpCall({
        path: "/group-admin/abort-migration",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ group: d.groupDid, operationId: "parity-r7-att-fail" }),
      });

      // =====================================================================
      // 4. Codex Round 7 Finding #2 parity: Atomic concurrent `refreshSession` rotation!
      // =====================================================================
      const stageRaceRes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.createAccount`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await makeTargetJwt("com.atproto.server.createAccount")}`,
          "x-group-migration-operation-id": "parity-r7-race-uncut",
        },
        body: JSON.stringify({ did: d.groupDid, handle: d.groupHandle }),
      });
      assert.equal(stageRaceRes.status, 200, `[${d.kind}] stage parity-r7-race-uncut failed`);
      const stageRaceToks = (await stageRaceRes.json()) as { accessJwt: string; refreshJwt: string };

      const [r1, r2] = await Promise.all([
        d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.refreshSession`, {
          method: "POST",
          headers: { authorization: `Bearer ${stageRaceToks.refreshJwt}` },
        }),
        d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.refreshSession`, {
          method: "POST",
          headers: { authorization: `Bearer ${stageRaceToks.refreshJwt}` },
        }),
      ]);
      assert.deepEqual(
        [r1.status, r2.status].sort((a, b) => a - b),
        [200, 401],
        `[${d.kind}] concurrent uncutover refreshSession must yield exact [200, 401]`,
      );

      // Verify uncutover replay purged target staging AND tombstoned `parity-r7-race-uncut`!
      const reuseRaceOp = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.createAccount`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await makeTargetJwt("com.atproto.server.createAccount")}`,
          "x-group-migration-operation-id": "parity-r7-race-uncut",
        },
        body: JSON.stringify({ did: d.groupDid, handle: d.groupHandle }),
      });
      assert.equal(reuseRaceOp.status, 409, `[${d.kind}] concurrent refresh replay must tombstone operationId`);
      assert.equal(((await reuseRaceOp.json()) as { error: string }).error, "OperationIdAlreadyAborted");

      // Also verify end-to-end post-cutover (`plc_cutover_at !== null`) concurrent `refreshSession` parity:
      // Stage full group on `peerMigrationEndpoint`, run `signPlcOperation` (using the STILL-UNCONSUMED `validPlcTok`!)
      // -> `submitPlcOperation` -> concurrent `refreshSession` (`[200, 401]`) -> winning `accessJwt` activates target (`200`)!
      const stageFullRes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.createAccount`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await makeTargetJwt("com.atproto.server.createAccount")}`,
          "x-group-migration-operation-id": "parity-r7-postcut-race",
        },
        body: JSON.stringify({ did: d.groupDid, handle: d.groupHandle }),
      });
      assert.equal(stageFullRes.status, 200);
      const fullToks = (await stageFullRes.json()) as { accessJwt: string; refreshJwt: string };

      const carRes = await d.unauthHttpCall({
        path: `/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(d.groupDid)}`,
        method: "GET",
      });
      assert.equal(carRes.status, 200);
      const impCar = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.repo.importRepo`, {
        method: "POST",
        headers: {
          "content-type": "application/vnd.ipld.car",
          authorization: `Bearer ${fullToks.accessJwt}`,
        },
        body: new Uint8Array(carRes.bytes),
      });
      assert.equal(impCar.status, 200);

      const listSp = await d.adminClient.query<{ spaces: Array<{ space: string }> }>(
        "com.atproto.space.listSpaces",
        {},
      );
      for (const sp of listSp.spaces) {
        if (sp.space.startsWith(`at:space/${d.groupDid}/`)) {
          const metaStar = await d.groupHttpCall({
            path: `/xrpc/com.atproto.space.exportSpaceMeta?space=${encodeURIComponent(sp.space)}`,
            method: "GET",
          });
          assert.equal(metaStar.status, 200);
          const impMeta = await d.rawFetch(
            `${d.peerMigrationEndpoint}/xrpc/com.atproto.space.importSpaceMeta?space=${encodeURIComponent(sp.space)}`,
            {
              method: "POST",
              headers: {
                "content-type": "application/vnd.dasl.star",
                authorization: `Bearer ${fullToks.accessJwt}`,
              },
              body: new Uint8Array(metaStar.bytes),
            },
          );
          assert.equal(impMeta.status, 200);
        }
        const repoStar = await d.groupHttpCall({
          path: `/xrpc/com.atproto.space.getRepo?space=${encodeURIComponent(sp.space)}&repo=${encodeURIComponent(d.groupDid)}`,
          method: "GET",
        });
        if (repoStar.status === 200) {
          const impRepo = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.space.importRepo`, {
            method: "POST",
            headers: {
              "content-type": "application/vnd.dasl.star",
              authorization: `Bearer ${fullToks.accessJwt}`,
            },
            body: new Uint8Array(repoStar.bytes),
          });
          assert.equal(impRepo.status, 200);
        }
      }

      const recTargetRes = await d.rawFetch(
        `${d.peerMigrationEndpoint}/xrpc/com.atproto.identity.getRecommendedDidCredentials`,
        {
          method: "GET",
          headers: { authorization: `Bearer ${fullToks.accessJwt}` },
        },
      );
      assert.equal(recTargetRes.status, 200);
      const recTarget = (await recTargetRes.json()) as Record<string, unknown>;

      // Notice `validPlcTok` WAS PRESERVED across all 5 rejected `signPlcOperation` calls above and now succeeds!
      const { operation: cutoverOp } = await d.adminClient.procedure<
        Record<string, unknown>,
        { operation: Record<string, unknown> }
      >("com.atproto.identity.signPlcOperation", {
        token: validPlcTok,
        ...recTarget,
      });

      const subTargetRes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.identity.submitPlcOperation`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${fullToks.accessJwt}`,
        },
        body: JSON.stringify({ operation: cutoverOp }),
      });
      assert.equal(subTargetRes.status, 200, `[${d.kind}] target submitPlcOperation failed`);

      // Concurrent post-cutover `refreshSession` -> exact `[200, 401]`, and winning `accessJwt` activates cleanly (`200`)!
      const [pcR1, pcR2] = await Promise.all([
        d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.refreshSession`, {
          method: "POST",
          headers: { authorization: `Bearer ${fullToks.refreshJwt}` },
        }),
        d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.refreshSession`, {
          method: "POST",
          headers: { authorization: `Bearer ${fullToks.refreshJwt}` },
        }),
      ]);
      assert.deepEqual(
        [pcR1.status, pcR2.status].sort((a, b) => a - b),
        [200, 401],
        `[${d.kind}] concurrent post-cutover refreshSession must yield exact [200, 401]`,
      );
      const winPostCut = (await (pcR1.status === 200 ? pcR1 : pcR2).json()) as {
        accessJwt: string;
        refreshJwt: string;
      };
      const actTargetRes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.activateAccount`, {
        method: "POST",
        headers: { authorization: `Bearer ${winPostCut.accessJwt}` },
      });
      assert.equal(
        actTargetRes.status,
        200,
        `[${d.kind}] winning post-cutover refreshSession accessJwt must remain unrevoked and activate target`,
      );
    }
  } finally {
    await fake.cleanup();
    await real.cleanup();
  }
});

test("FakeNetwork & GroupHostServer Round 8 parity: delayed Standard-mode source reaper abort never purges newer same-operationId session, and capabilityProofJwt enforces ES256 & #atproto/#atproto-<kid> only", async () => {
  const { Secp256k1Keypair } = await import("@atproto/crypto");
  const fake = await createFakeDriver({ joinPolicy: "open", publicMeta: true, withFlockWorkspace: true });
  const real = await createRealDriver({ joinPolicy: "open", publicMeta: true, withFlockWorkspace: true });

  const signRawCompactJwt = async (
    kp: { sign: (msg: Uint8Array) => Promise<Uint8Array> },
    header: Record<string, unknown>,
    payload: Record<string, unknown>,
  ): Promise<string> => {
    const hdr = Buffer.from(JSON.stringify(header)).toString("base64url");
    const pld = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = await kp.sign(new TextEncoder().encode(`${hdr}.${pld}`));
    return `${hdr}.${pld}.${Buffer.from(sig).toString("base64url")}`;
  };

  try {
    for (const d of [fake, real]) {
      const peerDidDoc = (
        await (await d.rawFetch(`${d.peerMigrationEndpoint}/.well-known/did.json`, { method: "GET" })).json()
      ) as { id: string };
      const peerServiceDid = peerDidDoc.id;
      const groupSignKp = await d.getGroupSigningKeyForTest();
      const k256Kp = await Secp256k1Keypair.create({ exportable: true });
      const k256Multibase = k256Kp.did().replace(/^did:key:/, "");
      const pdsFragKp = await P256Keypair.create({ exportable: true });
      const pdsFragMultibase = pdsFragKp.did().replace(/^did:key:/, "");

      const makeTargetJwt = async (lxm: string) => {
        const nowSec = Math.floor(Date.now() / 1000);
        return signRawCompactJwt(
          groupSignKp,
          { typ: "JWT", alg: "ES256", kid: "#atproto" },
          {
            iss: d.groupDid,
            aud: peerServiceDid,
            lxm,
            iat: nowSec,
            exp: nowSec + 60,
            jti: randomUUID(),
          },
        );
      };

      // =====================================================================
      // 1. Codex Round 8 Finding #2: Reject `ES256K` and `#atproto_pds` on `capabilityProofJwt`
      // =====================================================================
      const nowSecCap = Math.floor(Date.now() / 1000);
      for (const badR8Cap of [
        {
          label: "alg ES256K",
          signer: k256Kp,
          header: { typ: "JWT", alg: "ES256K", kid: "#atproto" },
          vmEntry: {
            id: `${peerServiceDid}#atproto`,
            type: "EcdsaSecp256k1VerificationKey2019",
            controller: peerServiceDid,
            publicKeyMultibase: k256Multibase,
          },
          replaceAtprotoVm: true,
        },
        {
          label: "service fragment #atproto_pds",
          signer: pdsFragKp,
          header: { typ: "JWT", alg: "ES256", kid: "#atproto_pds" },
          vmEntry: {
            id: `${peerServiceDid}#atproto_pds`,
            type: "EcdsaSecp256r1VerificationKey2019",
            controller: peerServiceDid,
            publicKeyMultibase: pdsFragMultibase,
          },
          replaceAtprotoVm: false,
        },
      ]) {
        const badProof = await signRawCompactJwt(badR8Cap.signer, badR8Cap.header, {
          iss: peerServiceDid,
          iat: nowSecCap,
          exp: nowSecCap + 300,
          endpoint: d.peerMigrationEndpoint,
          supportedSpacePolicies: [ATGRP_POLICY],
          atomicMigrationVersion: 1,
        });
        d.setSourceOutboundInterceptor(async (urlStr, _init, forward) => {
          if (urlStr.endsWith("/group-admin/migration-info")) {
            const orig = (await (await forward()).json()) as Record<string, unknown>;
            return new Response(JSON.stringify({ ...orig, capabilityProofJwt: badProof }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          if (urlStr.endsWith("/.well-known/did.json")) {
            const origDoc = (await (await forward()).json()) as {
              id: string;
              verificationMethod?: Array<Record<string, unknown>>;
            };
            if (origDoc.id === peerServiceDid) {
              const baseVms = badR8Cap.replaceAtprotoVm
                ? (origDoc.verificationMethod ?? []).filter(
                    (vm) => vm.id !== "#atproto" && vm.id !== `${peerServiceDid}#atproto`,
                  )
                : (origDoc.verificationMethod ?? []);
              return new Response(
                JSON.stringify({
                  ...origDoc,
                  verificationMethod: [...baseVms, badR8Cap.vmEntry],
                }),
                { status: 200, headers: { "content-type": "application/did+ld+json" } },
              );
            }
          }
          return forward();
        });

        const badPrepRes = await d.groupHttpCall({
          path: "/group-admin/prepare-migration",
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            group: d.groupDid,
            operationId: `r8-cap-${randomUUID().slice(0, 8)}`,
            targetEndpoint: d.peerMigrationEndpoint,
            mode: "auto",
          }),
        });
        assert.equal(badPrepRes.status, 400, `[${d.kind}] capabilityProofJwt (${badR8Cap.label}) must return 400`);
        assert.equal(
          (JSON.parse(Buffer.from(badPrepRes.bytes).toString("utf8")) as { error: string }).error,
          "UnsupportedGroupHostTarget",
        );
      }
      d.setSourceOutboundInterceptor(undefined);

      // =====================================================================
      // 2. Codex Round 8 Finding #1: Delayed Standard-mode source reaper abort vs newer same-operationId session!
      // =====================================================================
      const delayedOpId = "r8-delayed-std-op-1";
      const prep1Res = await d.groupHttpCall({
        path: "/group-admin/prepare-migration",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          group: d.groupDid,
          operationId: delayedOpId,
          targetEndpoint: d.peerMigrationEndpoint,
          mode: "standard",
        }),
      });
      assert.equal(prep1Res.status, 200, `[${d.kind}] initial standard prepare-migration must succeed`);

      // Hold Source's outbound reaper `/group-admin/abort-migration` call in flight while Source expires `delayedOpId`!
      let releaseDelayedAbort!: () => void;
      const delayedAbortGate = new Promise<void>((resolve) => {
        releaseDelayedAbort = resolve;
      });
      let delayedAbortSeen!: () => void;
      const delayedAbortInFlight = new Promise<void>((resolve) => {
        delayedAbortSeen = resolve;
      });
      let delayedAbortResponse: Response | null = null;

      d.setSourceOutboundInterceptor(async (urlStr, _init, forward) => {
        if (urlStr.endsWith("/group-admin/abort-migration")) {
          delayedAbortSeen();
          await delayedAbortGate;
          const res = await forward();
          delayedAbortResponse = res.clone();
          return res;
        }
        return forward();
      });

      const expiredLeaseMs = Date.now() - 1_000;
      d.expirePreparedSourceLeaseForTest(expiredLeaseMs);

      // (a) Trigger lazy reap on Source by attempting to reuse `delayedOpId` in `prepare-migration` -> `409 OperationIdAlreadyAborted`!
      const reusePrepRes = await d.groupHttpCall({
        path: "/group-admin/prepare-migration",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          group: d.groupDid,
          operationId: delayedOpId,
          targetEndpoint: d.peerMigrationEndpoint,
          mode: "standard",
        }),
      });
      assert.equal(reusePrepRes.status, 409, `[${d.kind}] reusing expired source operationId in prepare-migration must 409`);
      assert.equal(
        (JSON.parse(Buffer.from(reusePrepRes.bytes).toString("utf8")) as { error: string }).error,
        "OperationIdAlreadyAborted",
      );
      await delayedAbortInFlight;

      // (b) Attempting Standard-mode `createAccount` on Target with `delayedOpId` (while delayed abort is STILL held in flight!)
      //     contacts Source `/group-admin/public-group-keys?group=...&operationId=...` -> rejected `409 OperationIdAlreadyAborted`!
      const reusePkCreateRes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.createAccount`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await makeTargetJwt("com.atproto.server.createAccount")}`,
          "x-group-migration-operation-id": delayedOpId,
        },
        body: JSON.stringify({ did: d.groupDid, handle: d.groupHandle }),
      });
      assert.equal(
        reusePkCreateRes.status,
        409,
        `[${d.kind}] Standard createAccount reusing expired source operationId via public-group-keys must 409`,
      );
      assert.equal(((await reusePkCreateRes.json()) as { error: string }).error, "OperationIdAlreadyAborted");

      // (c) Even if Target stages `delayedOpId` WITHOUT contacting Source (`public-group-keys` 404 -> single-key fallback)
      //     while the old reaper abort is STILL delayed in flight, releasing the delayed abort returns `{ status: "superseded" }`
      //     (`created_at >= leaseExpiresAtMs`) and NEVER purges the newer Target staging session!
      d.setPeerOutboundInterceptor(async (urlStr, _init, forward) => {
        if (urlStr.includes("/group-admin/public-group-keys")) {
          return new Response(JSON.stringify({ error: "NotFound" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        }
        return forward();
      });
      // Ensure >= 2ms wall-clock advance past Source reap timestamp before staging offline Target session
      await new Promise((r) => setTimeout(r, 5));
      const offlineStageRes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.createAccount`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await makeTargetJwt("com.atproto.server.createAccount")}`,
          "x-group-migration-operation-id": delayedOpId,
        },
        body: JSON.stringify({ did: d.groupDid, handle: d.groupHandle }),
      });
      d.setPeerOutboundInterceptor(undefined);
      assert.equal(offlineStageRes.status, 200, `[${d.kind}] offline single-key Standard createAccount must stage cleanly`);
      const offlineStagedTokens = (await offlineStageRes.json()) as { accessJwt: string; refreshJwt: string };

      // Release the delayed reaper abort from the older expired source lease and flush background work!
      releaseDelayedAbort();
      await d.flushSourceBackgroundWork();
      d.setSourceOutboundInterceptor(undefined);

      assert.ok(delayedAbortResponse !== null, `[${d.kind}] delayed reaper abort must have delivered`);
      assert.equal((delayedAbortResponse as Response).status, 200);
      assert.equal(
        ((await (delayedAbortResponse as Response).json()) as { status: string }).status,
        "superseded",
        `[${d.kind}] delayed reaper abort from older expired lease must return superseded`,
      );

      // Prove the newer Target staging session `offlineStagedTokens` is STILL ALIVE and unpurged via `refreshSession`!
      const refreshAliveRes = await d.rawFetch(
        `${d.peerMigrationEndpoint}/xrpc/com.atproto.server.refreshSession`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${offlineStagedTokens.refreshJwt}` },
        },
      );
      assert.equal(
        refreshAliveRes.status,
        200,
        `[${d.kind}] newer same-operationId Target staging session must survive delayed reaper abort intact`,
      );
    }
  } finally {
    await fake.cleanup();
    await real.cleanup();
  }
});


test("FakeNetwork & GroupHostServer Round 9 parity: live-PLC verifyPersonalServiceJwt key binding, strict target cleanup on explicit source abort, commit-time streamed migration deadlines, and +10m clock-skewed Standard reaper abort isolation", async () => {
  const fake = await createFakeDriver({ joinPolicy: "open", publicMeta: true, withFlockWorkspace: true });
  const real = await createRealDriver({ joinPolicy: "open", publicMeta: true, withFlockWorkspace: true });

  const signJwtWithKey = async (
    kp: P256Keypair,
    claims: { iss: string; aud: string; lxm: string; iat: number; exp: number; jti: string },
  ): Promise<string> => {
    const hdr = Buffer.from(JSON.stringify({ alg: kp.jwtAlg, typ: "JWT", kid: "#atproto" })).toString("base64url");
    const pld = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const sig = await kp.sign(new TextEncoder().encode(`${hdr}.${pld}`));
    return `${hdr}.${pld}.${Buffer.from(sig).toString("base64url")}`;
  };

  const makeSlowStream = (bytes: Uint8Array, delayMs: number): ReadableStream<Uint8Array> => {
    const mid = Math.max(1, Math.floor(bytes.byteLength / 2));
    let step = 0;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (step === 0) {
          step = 1;
          controller.enqueue(bytes.slice(0, mid));
          return;
        }
        if (step === 1) {
          step = 2;
          await new Promise((r) => setTimeout(r, delayMs));
          controller.enqueue(bytes.slice(mid));
          controller.close();
        }
      },
    });
  };

  try {
    for (const d of [fake, real]) {
      const peerDescRes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.describeServer`, {
        method: "GET",
      });
      assert.equal(peerDescRes.status, 200);
      const peerServiceDid = ((await peerDescRes.json()) as { did: string }).did;
      const srcGroupKey = await d.getGroupSigningKeyForTest();

      const makeTargetCreateJwt = async () => {
        const nowSec = Math.floor(Date.now() / 1000);
        return signJwtWithKey(srcGroupKey, {
          iss: d.groupDid,
          aud: peerServiceDid,
          lxm: "com.atproto.server.createAccount",
          iat: nowSec,
          exp: nowSec + 60,
          jti: `r9-create-${randomUUID()}`,
        });
      };

      // =====================================================================
      // 1. Finding #8 parity: Explicit source `abort-migration` returns `502 TargetAbortFailed`
      //    and preserves `source_migration_lease` when Target cleanup fails, then succeeds on retry!
      // =====================================================================
      const prepStrict = await d.groupHttpCall({
        path: "/group-admin/prepare-migration",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          group: d.groupDid,
          operationId: "r9-parity-strict-abort",
          targetEndpoint: d.peerMigrationEndpoint,
        }),
      });
      assert.equal(prepStrict.status, 200, `[${d.kind}] prepare-migration failed`);
      const prepStrictBody = JSON.parse(Buffer.from(prepStrict.bytes).toString("utf8")) as {
        migrationTicket: string;
      };

      const stageStrictRes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.createAccount`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await makeTargetCreateJwt()}`,
          "x-group-migration-ticket": prepStrictBody.migrationTicket,
        },
        body: JSON.stringify({ did: d.groupDid, handle: d.groupHandle }),
      });
      assert.equal(stageStrictRes.status, 200, `[${d.kind}] coordinated createAccount failed`);

      // Round 18 Fix #4: Exact coordinated replay with matching ticket secret returns 200, whereas a wrong 43-char secret is rejected identically!
      const exactCoordReplayRes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.createAccount`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await makeTargetCreateJwt()}`,
          "x-group-migration-ticket": prepStrictBody.migrationTicket,
        },
        body: JSON.stringify({ did: d.groupDid, handle: d.groupHandle }),
      });
      assert.equal(exactCoordReplayRes.status, 200, `[${d.kind}] exact coordinated createAccount replay must return 200`);

      const ticketParts = prepStrictBody.migrationTicket.split(".");
      const forgedSecret = `${ticketParts[2]![0] === "A" ? "B" : "A"}${ticketParts[2]!.slice(1)}`;
      const forgedTicket = `${ticketParts[0]}.${ticketParts[1]}.${forgedSecret}`;
      const badSecretReplayRes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.createAccount`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await makeTargetCreateJwt()}`,
          "x-group-migration-ticket": forgedTicket,
        },
        body: JSON.stringify({ did: d.groupDid, handle: d.groupHandle }),
      });
      assert.notEqual(
        badSecretReplayRes.status,
        200,
        `[${d.kind}] coordinated createAccount replay with wrong 43-char ticket secret MUST NOT return 200`,
      );

      for (const failKind of ["503", "404-coord", "network"] as const) {
        d.setSourceOutboundInterceptor(async (urlStr, _init, forward) => {
          if (urlStr.endsWith("/group-admin/abort-migration")) {
            if (failKind === "503") {
              return new Response(JSON.stringify({ error: "ServiceUnavailable" }), {
                status: 503,
                headers: { "content-type": "application/json" },
              });
            }
            if (failKind === "404-coord") {
              return new Response(JSON.stringify({ error: "NotFound" }), {
                status: 404,
                headers: { "content-type": "application/json" },
              });
            }
            throw new Error("simulated target abort transport failure");
          }
          return forward();
        });

        const failAbortRes = await d.groupHttpCall({
          path: "/group-admin/abort-migration",
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ group: d.groupDid, operationId: "r9-parity-strict-abort" }),
        });
        assert.equal(failAbortRes.status, 502, `[${d.kind}] explicit source abort (${failKind}) must 502`);
        assert.equal(
          (JSON.parse(Buffer.from(failAbortRes.bytes).toString("utf8")) as { error: string }).error,
          "TargetAbortFailed",
        );

        // Group must STILL be frozen on Source (`source_migration_lease` preserved for retry!)
        const competingPrep = await d.groupHttpCall({
          path: "/group-admin/prepare-migration",
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            group: d.groupDid,
            operationId: "r9-parity-competing",
            targetEndpoint: d.peerMigrationEndpoint,
          }),
        });
        assert.equal(competingPrep.status, 409, `[${d.kind}] source lease must remain active after failed abort`);
      }

      d.setSourceOutboundInterceptor(undefined);
      const okAbortRes = await d.groupHttpCall({
        path: "/group-admin/abort-migration",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ group: d.groupDid, operationId: "r9-parity-strict-abort" }),
      });
      assert.equal(okAbortRes.status, 200, `[${d.kind}] retry abort must succeed once target recovers`);
      assert.equal(
        (JSON.parse(Buffer.from(okAbortRes.bytes).toString("utf8")) as { status: string }).status,
        "aborted",
      );

      // =====================================================================
      // 2. Finding #6 parity: `/group-admin/public-group-keys` fails closed (`502 SourceHostUnavailable`)
      //    on 503/network errors, AND +10m clock-skewed Standard reaper abort returns `superseded`!
      // =====================================================================
      for (const pkErr of ["503", "network"] as const) {
        d.setPeerOutboundInterceptor(async (urlStr, _init, forward) => {
          if (urlStr.includes("/group-admin/public-group-keys")) {
            if (pkErr === "503") {
              return new Response(JSON.stringify({ error: "ServiceUnavailable" }), {
                status: 503,
                headers: { "content-type": "application/json" },
              });
            }
            throw new Error("simulated public-group-keys network outage");
          }
          return forward();
        });
        const pkFailRes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.createAccount`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${await makeTargetCreateJwt()}`,
            "x-group-migration-operation-id": `r9-pk-${pkErr}`,
          },
          body: JSON.stringify({ did: d.groupDid, handle: d.groupHandle }),
        });
        assert.equal(pkFailRes.status, 502, `[${d.kind}] public-group-keys (${pkErr}) must fail closed with 502`);
        assert.equal(((await pkFailRes.json()) as { error: string }).error, "SourceHostUnavailable");
      }
      d.setPeerOutboundInterceptor(undefined);

      const skewOpId = "r9-parity-skewed-std";
      const prepSkew = await d.groupHttpCall({
        path: "/group-admin/prepare-migration",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          group: d.groupDid,
          operationId: skewOpId,
          targetEndpoint: d.peerMigrationEndpoint,
          mode: "standard",
        }),
      });
      assert.equal(prepSkew.status, 200);

      let releaseSkewAbort!: () => void;
      const skewAbortGate = new Promise<void>((resolve) => {
        releaseSkewAbort = resolve;
      });
      let skewAbortInFlightResolve!: () => void;
      const skewAbortInFlight = new Promise<void>((resolve) => {
        skewAbortInFlightResolve = resolve;
      });
      let skewAbortDeliveredRes: Response | null = null;

      d.setSourceOutboundInterceptor(async (urlStr, _init, forward) => {
        if (urlStr.endsWith("/group-admin/abort-migration")) {
          skewAbortInFlightResolve();
          await skewAbortGate;
          const res = await forward();
          skewAbortDeliveredRes = res.clone();
          return res;
        }
        return forward();
      });

      d.reapPreparedSourceLeaseWithClockSkewForTest(Date.now() + 10 * 60_000);
      await skewAbortInFlight;

      // Stage `skewOpId` on Target via 404 single-key fallback at real wall clock (10m behind Source reap clock!)
      d.setPeerOutboundInterceptor(async (urlStr, _init, forward) => {
        if (urlStr.includes("/group-admin/public-group-keys")) {
          return new Response(JSON.stringify({ error: "NotFound" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        }
        return forward();
      });
      const skewStageRes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.createAccount`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await makeTargetCreateJwt()}`,
          "x-group-migration-operation-id": skewOpId,
        },
        body: JSON.stringify({ did: d.groupDid, handle: d.groupHandle }),
      });
      d.setPeerOutboundInterceptor(undefined);
      assert.equal(skewStageRes.status, 200, `[${d.kind}] 404 single-key Standard stage must succeed`);
      const skewStageToks = (await skewStageRes.json()) as { accessJwt: string; refreshJwt: string };

      releaseSkewAbort();
      await d.flushSourceBackgroundWork();
      d.setSourceOutboundInterceptor(undefined);

      assert.ok(skewAbortDeliveredRes !== null, `[${d.kind}] skewed reaper abort must deliver`);
      assert.equal((skewAbortDeliveredRes as Response).status, 200);
      assert.equal(
        ((await (skewAbortDeliveredRes as Response).json()) as { status: string }).status,
        "superseded",
        `[${d.kind}] +10m clock-skewed reaper abort must return superseded via clock-free leaseAttemptId`,
      );

      // Clean up `skewStageToks` via Bearer target abort before next section
      const cleanSkewStage = await d.rawFetch(`${d.peerMigrationEndpoint}/group-admin/abort-migration`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${skewStageToks.accessJwt}`,
        },
        body: JSON.stringify({ group: d.groupDid }),
      });
      assert.equal(cleanSkewStage.status, 200);

      // =====================================================================
      // 3. Finding #3 parity: Streamed migration writes (`importRepo`, `uploadBlob`, `importSpaceMeta`,
      //    `space.importRepo`) begun BEFORE `absolute_deadline_at` and finishing AFTER -> `401 ExpiredToken`!
      // =====================================================================
      const carRes = await d.unauthHttpCall({
        path: `/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(d.groupDid)}`,
        method: "GET",
      });
      assert.equal(carRes.status, 200);
      const metaSpace = groupMetaUri(d.groupDid);
      const membersSpace = groupMembersUri(d.groupDid);
      const workspaceSpace = workspaceUri(d.groupDid);
      const metaArchiveRes = await d.groupHttpCall({
        path: `/xrpc/com.atproto.space.exportSpaceMeta?space=${encodeURIComponent(metaSpace)}`,
        method: "GET",
      });
      assert.equal(metaArchiveRes.status, 200);
      const metaRepoStarRes = await d.groupHttpCall({
        path: `/xrpc/com.atproto.space.getRepo?space=${encodeURIComponent(metaSpace)}&repo=${encodeURIComponent(d.groupDid)}`,
        method: "GET",
      });
      assert.equal(metaRepoStarRes.status, 200);

      const stageForStreamTest = async (opId: string, deadlineOffsetMs: number) => {
        const res = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.createAccount`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${await makeTargetCreateJwt()}`,
            "x-group-migration-operation-id": opId,
          },
          body: JSON.stringify({ did: d.groupDid, handle: d.groupHandle }),
        });
        assert.equal(res.status, 200, `[${d.kind}] stage ${opId} failed`);
        const toks = (await res.json()) as { accessJwt: string };
        d.setPeerStagingDeadlineForTest(Date.now() + deadlineOffsetMs);
        return toks.accessJwt;
      };

      // (a) `com.atproto.repo.importRepo`
      const carAccessJwt = await stageForStreamTest("r9-stream-car", 70);
      const expCarRes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.repo.importRepo`, {
        method: "POST",
        headers: {
          "content-type": "application/vnd.ipld.car",
          authorization: `Bearer ${carAccessJwt}`,
        },
        body: makeSlowStream(carRes.bytes, 120),
        duplex: "half",
      } as RequestInit);
      assert.equal(expCarRes.status, 401, `[${d.kind}] slow CAR import crossing deadline must 401`);
      assert.equal(((await expCarRes.json()) as { error: string }).error, "ExpiredToken");

      // (b) `com.atproto.repo.uploadBlob`
      const blobAccessJwt = await stageForStreamTest("r9-stream-blob", 70);
      const expBlobRes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.repo.uploadBlob`, {
        method: "POST",
        headers: {
          "content-type": "image/png",
          authorization: `Bearer ${blobAccessJwt}`,
        },
        body: makeSlowStream(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]), 120),
        duplex: "half",
      } as RequestInit);
      assert.equal(expBlobRes.status, 401, `[${d.kind}] slow uploadBlob crossing deadline must 401`);
      assert.equal(((await expBlobRes.json()) as { error: string }).error, "ExpiredToken");

      // (c) `com.atproto.space.importSpaceMeta`
      const metaAccessJwt = await stageForStreamTest("r9-stream-meta", 70);
      const expMetaRes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.space.importSpaceMeta`, {
        method: "POST",
        headers: {
          "content-type": "application/vnd.dasl.star",
          authorization: `Bearer ${metaAccessJwt}`,
        },
        body: makeSlowStream(metaArchiveRes.bytes, 120),
        duplex: "half",
      } as RequestInit);
      assert.equal(expMetaRes.status, 401, `[${d.kind}] slow importSpaceMeta crossing deadline must 401`);
      assert.equal(((await expMetaRes.json()) as { error: string }).error, "ExpiredToken");

      // (d) `com.atproto.space.importRepo`
      const starAccessJwt = await stageForStreamTest("r9-stream-star", 200);
      const preMetaOk = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.space.importSpaceMeta`, {
        method: "POST",
        headers: {
          "content-type": "application/vnd.dasl.star",
          authorization: `Bearer ${starAccessJwt}`,
        },
        body: new Uint8Array(metaArchiveRes.bytes),
      });
      assert.equal(preMetaOk.status, 200);
      const expStarRes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.space.importRepo`, {
        method: "POST",
        headers: {
          "content-type": "application/vnd.dasl.star",
          authorization: `Bearer ${starAccessJwt}`,
        },
        body: makeSlowStream(metaRepoStarRes.bytes, 240),
        duplex: "half",
      } as RequestInit);
      assert.equal(expStarRes.status, 401, `[${d.kind}] slow space.importRepo crossing deadline must 401`);
      assert.equal(((await expStarRes.json()) as { error: string }).error, "ExpiredToken");

      // =====================================================================
      // 4. Finding #1 parity: Co-hosted staged (`activated = 0`) AND migrated-away (`activated = 0`)
      //    group keys rejected with `401 InvalidSignature` on `verifyPersonalServiceJwt`!
      // =====================================================================
      const peerSiblingDid = await d.createSiblingGroupForTest("peer", "r9peersib");
      const sourceSiblingDid = await d.createSiblingGroupForTest("source", "r9srcsib");

      const finalStageRes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.createAccount`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await makeTargetCreateJwt()}`,
          "x-group-migration-operation-id": "r9-final-cutover",
        },
        body: JSON.stringify({ did: d.groupDid, handle: d.groupHandle }),
      });
      assert.equal(finalStageRes.status, 200, `[${d.kind}] final stage failed`);
      const finalStageToks = (await finalStageRes.json()) as { accessJwt: string };
      const stagedPeerGroupKey = await d.getPeerGroupSigningKeyForTest();
      assert.notEqual(stagedPeerGroupKey.did(), srcGroupKey.did());

      // Pre-cutover: Target's un-cutover staged key MUST fail `401 InvalidSignature` on `peerSiblingDid`!
      const nowSec1 = Math.floor(Date.now() / 1000);
      const badStagedJoinJwt = await signJwtWithKey(stagedPeerGroupKey, {
        iss: d.groupDid,
        aud: `${peerSiblingDid}#atproto_pds`,
        lxm: ATGRP_METHOD.requestJoin,
        iat: nowSec1,
        exp: nowSec1 + 60,
        jti: `r9-bad-staged-${randomUUID()}`,
      });
      const badStagedJoinRes = await d.rawFetch(
        `${d.peerMigrationEndpoint}/xrpc/${ATGRP_METHOD.requestJoin}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${badStagedJoinJwt}`,
          },
          body: JSON.stringify({ group: peerSiblingDid }),
        },
      );
      assert.equal(badStagedJoinRes.status, 401, `[${d.kind}] staged un-cutover key must fail 401 InvalidSignature`);
      assert.equal(((await badStagedJoinRes.json()) as { error: string }).error, "InvalidSignature");

      // Pre-cutover: Source's LIVE PLC `#atproto` key succeeds on `peerSiblingDid`!
      const goodPreCutoverJwt = await signJwtWithKey(srcGroupKey, {
        iss: d.groupDid,
        aud: `${peerSiblingDid}#atproto_pds`,
        lxm: ATGRP_METHOD.requestJoin,
        iat: nowSec1,
        exp: nowSec1 + 60,
        jti: `r9-good-pre-${randomUUID()}`,
      });
      const goodPreCutoverRes = await d.rawFetch(
        `${d.peerMigrationEndpoint}/xrpc/${ATGRP_METHOD.requestJoin}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${goodPreCutoverJwt}`,
          },
          body: JSON.stringify({ group: peerSiblingDid }),
        },
      );
      assert.equal(goodPreCutoverRes.status, 200, `[${d.kind}] live PLC #atproto key must succeed pre-cutover`);

      // Now complete cutover + activation onto Peer, retiring Source!
      assert.equal(
        (
          await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.repo.importRepo`, {
            method: "POST",
            headers: {
              "content-type": "application/vnd.ipld.car",
              authorization: `Bearer ${finalStageToks.accessJwt}`,
            },
            body: new Uint8Array(carRes.bytes),
          })
        ).status,
        200,
      );
      for (const spUri of [metaSpace, membersSpace, workspaceSpace]) {
        const spMeta = await d.groupHttpCall({
          path: `/xrpc/com.atproto.space.exportSpaceMeta?space=${encodeURIComponent(spUri)}`,
          method: "GET",
        });
        assert.equal(spMeta.status, 200);
        assert.equal(
          (
            await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.space.importSpaceMeta`, {
              method: "POST",
              headers: {
                "content-type": "application/vnd.dasl.star",
                authorization: `Bearer ${finalStageToks.accessJwt}`,
              },
              body: new Uint8Array(spMeta.bytes),
            })
          ).status,
          200,
        );
        const spRepo = await d.groupHttpCall({
          path: `/xrpc/com.atproto.space.getRepo?space=${encodeURIComponent(spUri)}&repo=${encodeURIComponent(d.groupDid)}`,
          method: "GET",
        });
        if (spRepo.status === 200) {
          assert.equal(
            (
              await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.space.importRepo`, {
                method: "POST",
                headers: {
                  "content-type": "application/vnd.dasl.star",
                  authorization: `Bearer ${finalStageToks.accessJwt}`,
                },
                body: new Uint8Array(spRepo.bytes),
              })
            ).status,
            200,
          );
        }
      }

      const recCredsRes = await d.rawFetch(
        `${d.peerMigrationEndpoint}/xrpc/com.atproto.identity.getRecommendedDidCredentials`,
        {
          method: "GET",
          headers: { authorization: `Bearer ${finalStageToks.accessJwt}` },
        },
      );
      assert.equal(recCredsRes.status, 200);
      const recCreds = (await recCredsRes.json()) as Record<string, unknown>;

      await d.adminClient.procedure("com.atproto.identity.requestPlcOperationSignature", {});
      const claimPlcRes = await d.groupHttpCall({
        path: "/group-admin/claim-action-token",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ group: d.groupDid, purpose: "plc_operation" }),
      });
      assert.equal(claimPlcRes.status, 200);
      const { token: plcSigTok } = JSON.parse(Buffer.from(claimPlcRes.bytes).toString("utf8")) as { token: string };
      const signedCutover = (await d.adminClient.procedure(
        "com.atproto.identity.signPlcOperation",
        {
          token: plcSigTok,
          ...recCreds,
        },
      )) as { operation: Record<string, unknown> };

      assert.equal(
        (
          await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.identity.submitPlcOperation`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${finalStageToks.accessJwt}`,
            },
            body: JSON.stringify({ operation: signedCutover.operation }),
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.activateAccount`, {
            method: "POST",
            headers: { authorization: `Bearer ${finalStageToks.accessJwt}` },
          })
        ).status,
        200,
      );
      await d.flushPeerBackgroundWork();

      // Ensure Source is finalized/deactivated on FakeNetwork as well
      const nowSec2 = Math.floor(Date.now() / 1000);
      const srcDesc = (await (
        await d.rawFetch(`${d.baseUrl}/xrpc/com.atproto.server.describeServer`, { method: "GET" })
      ).json()) as { did: string };
      const finJwt = await signJwtWithKey(stagedPeerGroupKey, {
        iss: d.groupDid,
        aud: srcDesc.did,
        lxm: "com.atproto.server.deactivateAccount",
        iat: nowSec2,
        exp: nowSec2 + 60,
        jti: `r9-fin-${randomUUID()}`,
      });
      assert.equal(
        (
          await d.rawFetch(`${d.baseUrl}/group-admin/finalize-migrated-source`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${finJwt}`,
            },
            body: JSON.stringify({ group: d.groupDid }),
          })
        ).status,
        200,
      );

      // Post-cutover: Source's RETIRED (`activated = 0`) key MUST fail `401 InvalidSignature` on `sourceSiblingDid`!
      const badRetiredJoinJwt = await signJwtWithKey(srcGroupKey, {
        iss: d.groupDid,
        aud: `${sourceSiblingDid}#atproto_pds`,
        lxm: ATGRP_METHOD.requestJoin,
        iat: nowSec2,
        exp: nowSec2 + 60,
        jti: `r9-bad-retired-${randomUUID()}`,
      });
      const badRetiredJoinRes = await d.rawFetch(`${d.baseUrl}/xrpc/${ATGRP_METHOD.requestJoin}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${badRetiredJoinJwt}`,
        },
        body: JSON.stringify({ group: sourceSiblingDid }),
      });
      assert.equal(badRetiredJoinRes.status, 401, `[${d.kind}] retired source key must fail 401 InvalidSignature`);
      assert.equal(((await badRetiredJoinRes.json()) as { error: string }).error, "InvalidSignature");

      // Post-cutover: Peer's new LIVE PLC `#atproto` key succeeds on `sourceSiblingDid`!
      const goodPostCutoverJwt = await signJwtWithKey(stagedPeerGroupKey, {
        iss: d.groupDid,
        aud: `${sourceSiblingDid}#atproto_pds`,
        lxm: ATGRP_METHOD.requestJoin,
        iat: nowSec2,
        exp: nowSec2 + 60,
        jti: `r9-good-post-${randomUUID()}`,
      });
      const goodPostCutoverRes = await d.rawFetch(`${d.baseUrl}/xrpc/${ATGRP_METHOD.requestJoin}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${goodPostCutoverJwt}`,
        },
        body: JSON.stringify({ group: sourceSiblingDid }),
      });
      assert.equal(goodPostCutoverRes.status, 200, `[${d.kind}] cut-over live PLC #atproto key must succeed`);
    }
  } finally {
    await fake.cleanup();
    await real.cleanup();
  }
});

test("Round 10 hardening parity: notifyRepoUpdate security/validation/retry contract and published com.atproto.space.policy/self migration integrity", async () => {
  const fake = await createFakeDriver({ joinPolicy: "open", publicMeta: true, withFlockWorkspace: true });
  const real = await createRealDriver({ joinPolicy: "open", publicMeta: true, withFlockWorkspace: true });

  const signCompactJwt = async (
    kp: P256Keypair,
    payload: Record<string, unknown>,
    header: Record<string, unknown> = { typ: "JWT", alg: "ES256", kid: "#atproto" },
  ): Promise<string> => {
    const hB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
    const pB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = await kp.sign(new Uint8Array(Buffer.from(`${hB64}.${pB64}`, "utf8")));
    return `${hB64}.${pB64}.${Buffer.from(sig).toString("base64url")}`;
  };

  try {
    for (const d of [fake, real]) {
      // Admit Bob as `member` (Carol remains non-member)
      await d.provisionPersonalInvitesSpace(d.bobDid);
      await d.personalServiceCall({
        callerDid: d.bobDid,
        method: ATGRP_METHOD.requestJoin,
        httpMethod: "POST",
        lxm: ATGRP_METHOD.requestJoin,
        body: { group: d.groupDid },
      });

      const chanUri = channelUri(d.groupDid, "r10-notify-chan");
      await d.adminClient.procedure("com.atproto.space.createSpace", {
        spaceType: SPACE_TYPE.channel,
        skey: "r10-notify-chan",
        policy: {
          $type: ATGRP_POLICY,
          publicRead: false,
          unlisted: false,
          grants: [
            { role: "admin", read: true, write: true },
            { role: "member", read: true, write: true },
          ],
        },
      });

      const bobSignKp = await d.getPersonalSigningKeyForTest(d.bobDid);
      const carolSignKp = await d.getPersonalSigningKeyForTest(d.carolDid);
      const validDigest32B64 = Buffer.alloc(32, 0x11).toString("base64");
      const validDigest32B64Next = Buffer.alloc(32, 0x22).toString("base64");
      const validDigest32B64Stale = Buffer.alloc(32, 0x33).toString("base64");
      const validRev1 = "3jzfcijpj2z2a";
      const validRev2 = "3jzfcijpj2z2b";
      const olderRev0 = "3jzfcijpj2z22";

      // =====================================================================
      // Part A: `notifyRepoUpdate` security, validation, and retry parity!
      // =====================================================================

      // 1. Missing Authorization -> `401 AuthMissing`
      const missingAuthRes = await d.unauthHttpCall({
        path: "/xrpc/com.atproto.space.notifyRepoUpdate",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          space: chanUri,
          repo: d.bobDid,
          repoRev: validRev1,
          data: { $bytes: validDigest32B64 },
        }),
      });
      assert.equal(missingAuthRes.status, 401, `[${d.kind}] missing auth must 401`);
      assert.equal(
        (JSON.parse(Buffer.from(missingAuthRes.bytes).toString("utf8")) as { error: string }).error,
        "AuthMissing",
      );

      // 2. `JWT iss !== body.repo` substitution -> `403 Forbidden`
      const nowSec = Math.floor(Date.now() / 1000);
      const bobValidJwtNoJti = await signCompactJwt(bobSignKp, {
        iss: d.bobDid,
        aud: `${d.groupDid}#atproto_pds`,
        lxm: "com.atproto.space.notifyRepoUpdate",
        iat: nowSec,
        exp: nowSec + 60,
      });
      const issMismatchRes = await d.unauthHttpCall({
        path: "/xrpc/com.atproto.space.notifyRepoUpdate",
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${bobValidJwtNoJti}`,
        },
        body: JSON.stringify({
          space: chanUri,
          repo: d.aliceDid,
          repoRev: validRev1,
          data: { $bytes: validDigest32B64 },
        }),
      });
      assert.equal(issMismatchRes.status, 403, `[${d.kind}] iss !== body.repo must 403`);
      assert.equal(
        (JSON.parse(Buffer.from(issMismatchRes.bytes).toString("utf8")) as { error: string }).error,
        "Forbidden",
      );

      // 3. `aud` mismatch -> `403 Forbidden`
      const wrongAudJwt = await signCompactJwt(bobSignKp, {
        iss: d.bobDid,
        aud: "did:plc:wrongauthorityaaaaaaaaaa#atproto_pds",
        lxm: "com.atproto.space.notifyRepoUpdate",
        iat: nowSec,
        exp: nowSec + 60,
      });
      const wrongAudRes = await d.unauthHttpCall({
        path: "/xrpc/com.atproto.space.notifyRepoUpdate",
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${wrongAudJwt}`,
        },
        body: JSON.stringify({
          space: chanUri,
          repo: d.bobDid,
          repoRev: validRev1,
          data: { $bytes: validDigest32B64 },
        }),
      });
      assert.equal(wrongAudRes.status, 403, `[${d.kind}] wrong aud must 403`);
      assert.equal(
        (JSON.parse(Buffer.from(wrongAudRes.bytes).toString("utf8")) as { error: string }).error,
        "Forbidden",
      );

      // 4. Wrong `lxm`, expired `exp`, and future `iat` -> `401`
      for (const [label, badClaims, expectedCode] of [
        [
          "wrong-lxm",
          {
            iss: d.bobDid,
            aud: `${d.groupDid}#atproto_pds`,
            lxm: ATGRP_METHOD.requestJoin,
            iat: nowSec,
            exp: nowSec + 60,
          },
          "InvalidToken",
        ],
        [
          "expired-exp",
          {
            iss: d.bobDid,
            aud: `${d.groupDid}#atproto_pds`,
            lxm: "com.atproto.space.notifyRepoUpdate",
            iat: nowSec - 120,
            exp: nowSec - 10,
          },
          "ExpiredToken",
        ],
        [
          "future-iat",
          {
            iss: d.bobDid,
            aud: `${d.groupDid}#atproto_pds`,
            lxm: "com.atproto.space.notifyRepoUpdate",
            iat: nowSec + 600,
            exp: nowSec + 660,
          },
          "InvalidToken",
        ],
      ] as const) {
        const badJwt = await signCompactJwt(bobSignKp, badClaims);
        const badRes = await d.unauthHttpCall({
          path: "/xrpc/com.atproto.space.notifyRepoUpdate",
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${badJwt}`,
          },
          body: JSON.stringify({
            space: chanUri,
            repo: d.bobDid,
            repoRev: validRev1,
            data: { $bytes: validDigest32B64 },
          }),
        });
        assert.equal(badRes.status, 401, `[${d.kind}] ${label} must 401`);
        assert.equal(
          (JSON.parse(Buffer.from(badRes.bytes).toString("utf8")) as { error: string }).error,
          expectedCode,
          `[${d.kind}] ${label} error code mismatch`,
        );
      }

      // 5. Malformed `repoRev`, non-canonical leading-`z` TID, and `FutureRev` -> `400`
      const futureTid = tidNow(Date.now() + 10 * 60_000);
      for (const [label, badRev, expectedCode] of [
        ["non-tid", "not-a-tid", "InvalidRequest"],
        ["high-bit-tid", "zzzzzzzzzzzzz", "InvalidRequest"],
        ["future-rev", futureTid, "FutureRev"],
      ] as const) {
        const badRevRes = await d.unauthHttpCall({
          path: "/xrpc/com.atproto.space.notifyRepoUpdate",
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${bobValidJwtNoJti}`,
          },
          body: JSON.stringify({
            space: chanUri,
            repo: d.bobDid,
            repoRev: badRev,
            data: { $bytes: validDigest32B64 },
          }),
        });
        assert.equal(badRevRes.status, 400, `[${d.kind}] ${label} must 400`);
        assert.equal(
          (JSON.parse(Buffer.from(badRevRes.bytes).toString("utf8")) as { error: string }).error,
          expectedCode,
          `[${d.kind}] ${label} error code mismatch`,
        );
      }

      // 6. Missing, malformed base64, 16-byte, and 33-byte `data` digests -> `400 InvalidRequest` (never zero-substituted!)
      for (const [label, badBody] of [
        ["missing-data", { space: chanUri, repo: d.bobDid, repoRev: validRev1 }],
        ["empty-object-data", { space: chanUri, repo: d.bobDid, repoRev: validRev1, data: {} }],
        [
          "malformed-b64-data",
          { space: chanUri, repo: d.bobDid, repoRev: validRev1, data: { $bytes: "not-valid-base64$$$" } },
        ],
        [
          "short-16b-data",
          {
            space: chanUri,
            repo: d.bobDid,
            repoRev: validRev1,
            data: { $bytes: Buffer.alloc(16, 0xaa).toString("base64") },
          },
        ],
        [
          "long-33b-data",
          {
            space: chanUri,
            repo: d.bobDid,
            repoRev: validRev1,
            data: { $bytes: Buffer.alloc(33, 0xbb).toString("base64") },
          },
        ],
      ] as const) {
        const badDataRes = await d.unauthHttpCall({
          path: "/xrpc/com.atproto.space.notifyRepoUpdate",
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${bobValidJwtNoJti}`,
          },
          body: JSON.stringify(badBody),
        });
        assert.equal(badDataRes.status, 400, `[${d.kind}] ${label} must 400`);
        assert.equal(
          (JSON.parse(Buffer.from(badDataRes.bytes).toString("utf8")) as { error: string }).error,
          "InvalidRequest",
        );
      }

      // 7. Unauthorized writer (`carolDid`, `iss === body.repo === carolDid`) -> `403 Forbidden`
      const carolNruJwt = await signCompactJwt(carolSignKp, {
        iss: d.carolDid,
        aud: `${d.groupDid}#atproto_pds`,
        lxm: "com.atproto.space.notifyRepoUpdate",
        iat: nowSec,
        exp: nowSec + 60,
      });
      const unauthWriterRes = await d.unauthHttpCall({
        path: "/xrpc/com.atproto.space.notifyRepoUpdate",
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${carolNruJwt}`,
        },
        body: JSON.stringify({
          space: chanUri,
          repo: d.carolDid,
          repoRev: validRev1,
          data: { $bytes: validDigest32B64 },
        }),
      });
      assert.equal(unauthWriterRes.status, 403, `[${d.kind}] non-writer Carol must 403 Forbidden`);
      assert.equal(
        (JSON.parse(Buffer.from(unauthWriterRes.bytes).toString("utf8")) as { error: string }).error,
        "Forbidden",
      );

      // 8. Valid JWT WITHOUT `jti` succeeds (`200`), AND valid JWT WITH `jti` succeeds TWICE (`200` on retry, NOT `401 ReplayDetected`),
      //    while older `repoRev` is ignored monotonically!
      const okNoJtiRes = await d.unauthHttpCall({
        path: "/xrpc/com.atproto.space.notifyRepoUpdate",
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${bobValidJwtNoJti}`,
        },
        body: JSON.stringify({
          space: chanUri,
          repo: d.bobDid,
          repoRev: validRev1,
          data: { $bytes: validDigest32B64 },
        }),
      });
      assert.equal(okNoJtiRes.status, 200, `[${d.kind}] valid notifyRepoUpdate without jti must 200`);

      const bobRetryableJwtWithJti = await signCompactJwt(bobSignKp, {
        iss: d.bobDid,
        aud: `${d.groupDid}#atproto_pds`,
        lxm: "com.atproto.space.notifyRepoUpdate",
        iat: nowSec,
        exp: nowSec + 60,
        jti: `r10-nru-retry-${randomUUID()}`,
      });
      const okFirstWithJti = await d.unauthHttpCall({
        path: "/xrpc/com.atproto.space.notifyRepoUpdate",
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${bobRetryableJwtWithJti}`,
        },
        body: JSON.stringify({
          space: chanUri,
          repo: d.bobDid,
          repoRev: validRev2,
          data: { $bytes: validDigest32B64Next },
        }),
      });
      assert.equal(okFirstWithJti.status, 200, `[${d.kind}] first notifyRepoUpdate with jti must 200`);

      const okRetrySameJwt = await d.unauthHttpCall({
        path: "/xrpc/com.atproto.space.notifyRepoUpdate",
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${bobRetryableJwtWithJti}`,
        },
        body: JSON.stringify({
          space: chanUri,
          repo: d.bobDid,
          repoRev: validRev2,
          data: { $bytes: validDigest32B64Next },
        }),
      });
      assert.equal(okRetrySameJwt.status, 200, `[${d.kind}] idempotent retry with same JWT/jti must 200`);

      const staleRevRes = await d.unauthHttpCall({
        path: "/xrpc/com.atproto.space.notifyRepoUpdate",
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${bobRetryableJwtWithJti}`,
        },
        body: JSON.stringify({
          space: chanUri,
          repo: d.bobDid,
          repoRev: olderRev0,
          data: { $bytes: validDigest32B64Stale },
        }),
      });
      assert.equal(staleRevRes.status, 200, `[${d.kind}] older repoRev must 200 no-op`);

      const chanMetaCheckRes = await d.groupHttpCall({
        path: `/xrpc/com.atproto.space.exportSpaceMeta?space=${encodeURIComponent(chanUri)}`,
        method: "GET",
      });
      assert.equal(chanMetaCheckRes.status, 200, `[${d.kind}] exportSpaceMeta failed`);
      const chanMetaCheck = await readSpaceMetaStar([chanMetaCheckRes.bytes]);
      const bobWriter = chanMetaCheck.writers.find((r) => r.did === d.bobDid);
      assert.ok(bobWriter, `[${d.kind}] Bob writer entry must exist`);
      assert.equal(bobWriter.repoRev, validRev2, `[${d.kind}] older repoRev must not regress writer rev`);
      assert.deepEqual(
        Buffer.from(bobWriter.data),
        Buffer.alloc(32, 0x22),
        `[${d.kind}] writer digest bytes must match latest rev`,
      );

      // =====================================================================
      // Part B: Published `com.atproto.space.policy/self` validation & migration integrity!
      // =====================================================================
      const srcGroupKey = await d.getGroupSigningKeyForTest();
      const peerDesc = (await (
        await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.describeServer`, { method: "GET" })
      ).json()) as { did: string };

      const createTargetJwt = await signCompactJwt(srcGroupKey, {
        iss: d.groupDid,
        aud: peerDesc.did,
        lxm: "com.atproto.server.createAccount",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 60,
        jti: `r10-create-${randomUUID()}`,
      });
      const stageRes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.createAccount`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${createTargetJwt}`,
          "x-group-migration-operation-id": "r10-policy-integrity",
        },
        body: JSON.stringify({ did: d.groupDid, handle: d.groupHandle }),
      });
      assert.equal(stageRes.status, 200, `[${d.kind}] target staging createAccount failed`);
      const { accessJwt: migJwt } = (await stageRes.json()) as { accessJwt: string };

      // Import public CAR + all space metadata + STAR archives for `meta/self`, `workspace/self`, and `r10-notify-chan`
      const carRes = await d.unauthHttpCall({
        path: `/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(d.groupDid)}`,
        method: "GET",
      });
      assert.equal(carRes.status, 200);
      assert.equal(
        (
          await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.repo.importRepo`, {
            method: "POST",
            headers: {
              "content-type": "application/vnd.ipld.car",
              authorization: `Bearer ${migJwt}`,
            },
            body: new Uint8Array(carRes.bytes),
          })
        ).status,
        200,
      );

      const metaSpace = groupMetaUri(d.groupDid);
      const membersSpace = groupMembersUri(d.groupDid);
      const workspaceSpace = workspaceUri(d.groupDid);
      const allOwnSpaces = [metaSpace, membersSpace, workspaceSpace, chanUri];

      let exportedMembersStarBytes: Uint8Array | null = null;
      let exportedMembersMetaPolicy: Record<string, unknown> | null = null;
      for (const spUri of allOwnSpaces) {
        const spMeta = await d.groupHttpCall({
          path: `/xrpc/com.atproto.space.exportSpaceMeta?space=${encodeURIComponent(spUri)}`,
          method: "GET",
        });
        assert.equal(spMeta.status, 200);
        if (spUri === membersSpace) {
          const parsedMeta = await readSpaceMetaStar([spMeta.bytes]);
          exportedMembersMetaPolicy = JSON.parse(JSON.stringify(parsedMeta.policy)) as Record<string, unknown>;
        }
        assert.equal(
          (
            await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.space.importSpaceMeta`, {
              method: "POST",
              headers: {
                "content-type": "application/vnd.dasl.star",
                authorization: `Bearer ${migJwt}`,
              },
              body: new Uint8Array(spMeta.bytes),
            })
          ).status,
          200,
        );

        const spRepo = await d.groupHttpCall({
          path: `/xrpc/com.atproto.space.getRepo?space=${encodeURIComponent(spUri)}&repo=${encodeURIComponent(d.groupDid)}`,
          method: "GET",
        });
        assert.equal(spRepo.status, 200);
        if (spUri === membersSpace) {
          exportedMembersStarBytes = new Uint8Array(spRepo.bytes);
        } else {
          assert.equal(
            (
              await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.space.importRepo`, {
                method: "POST",
                headers: {
                  "content-type": "application/vnd.dasl.star",
                  authorization: `Bearer ${migJwt}`,
                },
                body: new Uint8Array(spRepo.bytes),
              })
            ).status,
            200,
          );
        }
      }
      assert.ok(exportedMembersStarBytes && exportedMembersMetaPolicy);

      // Extract non-policy records from `members/self` so we can craft missing / malformed / non-self / stale policy STARs!
      const nonPolicyMembersRecords: Awaited<ReturnType<typeof serializeRecord>>[] = [];
      const parsedMembersRepo = await readRepoStar([exportedMembersStarBytes]);
      for await (const entry of parsedMembersRepo.records) {
        if (entry.collection === ATPROTO_SPACE_COLLECTION.spacePolicy) continue;
        nonPolicyMembersRecords.push(
          await serializeRecord(
            entry.collection as NsidString,
            entry.rkey as RecordKeyString,
            entry.record as LexMap,
          ),
        );
      }

      const buildMembersStar = async (
        extraRecords: Awaited<ReturnType<typeof serializeRecord>>[],
      ): Promise<Uint8Array> => {
        const allRecs = [...nonPolicyMembersRecords, ...extraRecords].sort((a, b) => {
          const ka = `${a.collection}/${a.rkey}`;
          const kb = `${b.collection}/${b.rkey}`;
          return ka < kb ? -1 : ka > kb ? 1 : 0;
        });
        const rc = RepoCommit.fromRecords(allRecs);
        const chunks: Buffer[] = [];
        for await (const ch of writeRepoStar(
          rc.toCommit({
            space: membersSpace as SpaceRefString,
            repo: d.groupDid as DidString,
            rev: parsedMembersRepo.commit.rev,
          }),
          allRecs,
        )) {
          chunks.push(Buffer.from(ch));
        }
        return new Uint8Array(Buffer.concat(chunks));
      };

      // 1. Non-`self` `com.atproto.space.policy/other` rejected by `space.importRepo` (`400 InvalidRepoFile`)!
      const nonSelfPolicyRec = await serializeRecord(
        ATPROTO_SPACE_COLLECTION.spacePolicy as NsidString,
        "other" as RecordKeyString,
        jsonToLex({
          $type: ATPROTO_SPACE_COLLECTION.spacePolicy,
          policy: exportedMembersMetaPolicy,
        }) as LexMap,
      );
      const nonSelfRes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.space.importRepo`, {
        method: "POST",
        headers: {
          "content-type": "application/vnd.dasl.star",
          authorization: `Bearer ${migJwt}`,
        },
        body: new Uint8Array(await buildMembersStar([nonSelfPolicyRec])),
      });
      assert.equal(nonSelfRes.status, 400, `[${d.kind}] non-self space.policy record must 400 on importRepo`);
      assert.equal(((await nonSelfRes.json()) as { error: string }).error, "InvalidRepoFile");

      // 2. Malformed `com.atproto.space.policy/self` (non-OpenSocial policy `$type` & invalid grant scope) rejected on `importRepo` (`400`)!
      for (const [label, badPol, expectedErr] of [
        [
          "non-opensocial-policy",
          { $type: MEMBERSPACE_POLICY, publicRead: false, publicWrite: false },
          "InvalidSpacePolicy",
        ],
        [
          "invalid-grant-scope",
          {
            $type: ATGRP_POLICY,
            publicRead: false,
            unlisted: false,
            grants: [{ role: "admin", read: true, write: true, permissions: ["identity:*"] }],
          },
          "InvalidSpacePolicyScope",
        ],
      ] as const) {
        const badPolRec = await serializeRecord(
          ATPROTO_SPACE_COLLECTION.spacePolicy as NsidString,
          SELF_SKEY as RecordKeyString,
          jsonToLex({
            $type: ATPROTO_SPACE_COLLECTION.spacePolicy,
            policy: badPol,
          }) as LexMap,
        );
        const badPolRes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.space.importRepo`, {
          method: "POST",
          headers: {
            "content-type": "application/vnd.dasl.star",
            authorization: `Bearer ${migJwt}`,
          },
          body: new Uint8Array(await buildMembersStar([badPolRec])),
        });
        assert.equal(badPolRes.status, 400, `[${d.kind}] ${label} must 400 on importRepo`);
        assert.equal(((await badPolRes.json()) as { error: string }).error, expectedErr);
      }

      // 3. Missing `com.atproto.space.policy/self`: import STAR without `policy/self`, prepare signed cutover PLC op,
      //    verify `submitPlcOperation` rejects `400 MissingSpacePolicyRecord`!
      const missingPolStar = await buildMembersStar([]);
      assert.equal(
        (
          await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.space.importRepo`, {
            method: "POST",
            headers: {
              "content-type": "application/vnd.dasl.star",
              authorization: `Bearer ${migJwt}`,
            },
            body: new Uint8Array(missingPolStar),
          })
        ).status,
        200,
      );

      const recCredsRes = await d.rawFetch(
        `${d.peerMigrationEndpoint}/xrpc/com.atproto.identity.getRecommendedDidCredentials`,
        {
          method: "GET",
          headers: { authorization: `Bearer ${migJwt}` },
        },
      );
      assert.equal(recCredsRes.status, 200);
      const recCreds = (await recCredsRes.json()) as Record<string, unknown>;

      await d.adminClient.procedure("com.atproto.identity.requestPlcOperationSignature", {});
      const claimPlcRes = await d.groupHttpCall({
        path: "/group-admin/claim-action-token",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ group: d.groupDid, purpose: "plc_operation" }),
      });
      assert.equal(claimPlcRes.status, 200);
      const { token: plcSigTok } = JSON.parse(Buffer.from(claimPlcRes.bytes).toString("utf8")) as { token: string };
      const signedCutover = (await d.adminClient.procedure("com.atproto.identity.signPlcOperation", {
        token: plcSigTok,
        ...recCreds,
      })) as { operation: Record<string, unknown> };

      const subMissingPolRes = await d.rawFetch(
        `${d.peerMigrationEndpoint}/xrpc/com.atproto.identity.submitPlcOperation`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${migJwt}`,
          },
          body: JSON.stringify({ operation: signedCutover.operation }),
        },
      );
      assert.equal(subMissingPolRes.status, 400, `[${d.kind}] submitPlcOperation must reject missing policy/self`);
      assert.equal(((await subMissingPolRes.json()) as { error: string }).error, "MissingSpacePolicyRecord");

      // 4. Stale / divergent `com.atproto.space.policy/self` (`publicRead` flipped relative to staged metadata policy):
      //    `space.importRepo` succeeds (syntactically valid record), `submitPlcOperation` rejects `400 SpacePolicyMismatch`!
      const staleMembersPolicy = {
        ...exportedMembersMetaPolicy,
        publicRead: !(exportedMembersMetaPolicy.publicRead === true),
      };
      const stalePolRec = await serializeRecord(
        ATPROTO_SPACE_COLLECTION.spacePolicy as NsidString,
        SELF_SKEY as RecordKeyString,
        jsonToLex({
          $type: ATPROTO_SPACE_COLLECTION.spacePolicy,
          policy: staleMembersPolicy,
        }) as LexMap,
      );
      assert.equal(
        (
          await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.space.importRepo`, {
            method: "POST",
            headers: {
              "content-type": "application/vnd.dasl.star",
              authorization: `Bearer ${migJwt}`,
            },
            body: new Uint8Array(await buildMembersStar([stalePolRec])),
          })
        ).status,
        200,
      );

      const subStalePolRes = await d.rawFetch(
        `${d.peerMigrationEndpoint}/xrpc/com.atproto.identity.submitPlcOperation`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${migJwt}`,
          },
          body: JSON.stringify({ operation: signedCutover.operation }),
        },
      );
      assert.equal(subStalePolRes.status, 400, `[${d.kind}] submitPlcOperation must reject stale policy/self`);
      assert.equal(((await subStalePolRes.json()) as { error: string }).error, "SpacePolicyMismatch");

      // 5. Direct-to-PLC cutover (bypassing `submitPlcOperation` via external PLC submission!):
      //    `activateAccount` ITSELF rejects BOTH `400 SpacePolicyMismatch` AND `400 MissingSpacePolicyRecord`!
      await d.submitDirectPlcCutoverForTest(signedCutover.operation);

      const actStalePolRes = await d.rawFetch(
        `${d.peerMigrationEndpoint}/xrpc/com.atproto.server.activateAccount`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${migJwt}` },
        },
      );
      assert.equal(actStalePolRes.status, 400, `[${d.kind}] activateAccount must reject stale policy/self`);
      assert.equal(((await actStalePolRes.json()) as { error: string }).error, "SpacePolicyMismatch");

      assert.equal(
        (
          await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.space.importRepo`, {
            method: "POST",
            headers: {
              "content-type": "application/vnd.dasl.star",
              authorization: `Bearer ${migJwt}`,
            },
            body: new Uint8Array(missingPolStar),
          })
        ).status,
        200,
      );
      const actMissingPolRes = await d.rawFetch(
        `${d.peerMigrationEndpoint}/xrpc/com.atproto.server.activateAccount`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${migJwt}` },
        },
      );
      assert.equal(actMissingPolRes.status, 400, `[${d.kind}] activateAccount must reject missing policy/self`);
      assert.equal(((await actMissingPolRes.json()) as { error: string }).error, "MissingSpacePolicyRecord");

      // 6. Semantically equivalent `com.atproto.space.policy/self` (omitted false booleans + reversed `grants` order)
      //    stages cleanly and `activateAccount` succeeds (`200 OK`)!
      const rawGrants = (exportedMembersMetaPolicy.grants as Array<Record<string, unknown>>).slice().reverse();
      const semanticallyEqualPolicy: Record<string, unknown> = {
        $type: ATGRP_POLICY,
        ...(exportedMembersMetaPolicy.publicRead === true ? { publicRead: true } : {}),
        ...(exportedMembersMetaPolicy.unlisted === true ? { unlisted: true } : {}),
        grants: rawGrants,
      };
      const eqPolRec = await serializeRecord(
        ATPROTO_SPACE_COLLECTION.spacePolicy as NsidString,
        SELF_SKEY as RecordKeyString,
        jsonToLex({
          $type: ATPROTO_SPACE_COLLECTION.spacePolicy,
          policy: semanticallyEqualPolicy,
        }) as LexMap,
      );
      assert.equal(
        (
          await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.space.importRepo`, {
            method: "POST",
            headers: {
              "content-type": "application/vnd.dasl.star",
              authorization: `Bearer ${migJwt}`,
            },
            body: new Uint8Array(await buildMembersStar([eqPolRec])),
          })
        ).status,
        200,
      );

      const actOkRes = await d.rawFetch(
        `${d.peerMigrationEndpoint}/xrpc/com.atproto.server.activateAccount`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${migJwt}` },
        },
      );
      assert.equal(actOkRes.status, 200, `[${d.kind}] activateAccount with semantically matching policy/self must 200`);
    }
  } finally {
    await fake.cleanup();
    await real.cleanup();
  }
});

test("Round 12 hardening parity: effective admins excluded from an existing private space cannot grant read/write access, enable publicRead, or list an unlisted space (proposal.md:102)", async () => {
  const fake = await createFakeDriver({ joinPolicy: "open", publicMeta: true, withFlockWorkspace: true });
  const real = await createRealDriver({ joinPolicy: "open", publicMeta: true, withFlockWorkspace: true });

  try {
    for (const d of [fake, real]) {
      await d.provisionPersonalInvitesSpace(d.bobDid);
      await d.personalServiceCall({
        callerDid: d.bobDid,
        method: ATGRP_METHOD.requestJoin,
        httpMethod: "POST",
        lxm: ATGRP_METHOD.requestJoin,
        body: { group: d.groupDid },
      });

      const membersSpace = groupMembersUri(d.groupDid);
      // Create private role `channel-secret` and assign ONLY to `bobDid` (`aliceDid` is an effective admin with `*`, NOT holding `channel-secret`!)
      await d.adminClient.procedure("com.atproto.space.putRecord", {
        space: membersSpace,
        repo: d.groupDid,
        collection: ATGRP_COLLECTION.role,
        rkey: "channel-secret",
        record: {
          $type: ATGRP_COLLECTION.role,
          displayName: "#secret member",
        },
      });
      await d.adminClient.procedure("com.atproto.space.putRecord", {
        space: membersSpace,
        repo: d.groupDid,
        collection: ATGRP_COLLECTION.membership,
        rkey: d.bobDid,
        record: {
          $type: ATGRP_COLLECTION.membership,
          roles: ["member", "channel-secret"],
          createdAt: "2026-11-22T00:00:00.000Z",
        },
      });

      // Bootstrap (`createSpace`, `prevPolicy === undefined`) is permitted for effective admin `aliceDid`:
      const secretUri = channelUri(d.groupDid, "secret");
      await d.adminClient.procedure("com.atproto.space.createSpace", {
        spaceType: SPACE_TYPE.channel,
        skey: "secret",
        policy: {
          $type: ATGRP_POLICY,
          publicRead: false,
          unlisted: true,
          grants: [{ role: "channel-secret", read: true, write: true }],
        },
      });

      // Now `secretUri` exists (`prevPolicy !== undefined`), and `aliceDid` does NOT hold `channel-secret` (`read: false, write: false`).
      // Every escalation vector MUST reject with `403 PrivilegeEscalation`!
      const escalationAttempts: Array<{ label: string; policy: Record<string, unknown> }> = [
        {
          label: "grant read to assignable role",
          policy: {
            $type: ATGRP_POLICY,
            publicRead: false,
            unlisted: true,
            grants: [
              { role: "channel-secret", read: true, write: true },
              { role: "admin", read: true },
            ],
          },
        },
        {
          label: "grant write to assignable role",
          policy: {
            $type: ATGRP_POLICY,
            publicRead: false,
            unlisted: true,
            grants: [
              { role: "channel-secret", read: true, write: true },
              { role: "admin", write: true },
            ],
          },
        },
        {
          label: "enable publicRead",
          policy: {
            $type: ATGRP_POLICY,
            publicRead: true,
            unlisted: true,
            grants: [{ role: "channel-secret", read: true, write: true }],
          },
        },
        {
          label: "list unlisted space (unlisted: false)",
          policy: {
            $type: ATGRP_POLICY,
            publicRead: false,
            unlisted: false,
            grants: [{ role: "channel-secret", read: true, write: true }],
          },
        },
      ];

      for (const attempt of escalationAttempts) {
        await assert.rejects(
          () =>
            d.adminClient.procedure("com.atproto.space.updateSpace", {
              space: secretUri,
              policy: attempt.policy,
            }),
          (err: unknown) =>
            err instanceof XrpcError && err.status === 403 && err.code === "PrivilegeEscalation",
          `[${d.kind}] excluded effective admin must fail 403 PrivilegeEscalation on ${attempt.label}`,
        );
      }

      // Once `aliceDid` holds `channel-secret` (which is in `aliceDid`'s `canAssign: ["*"]` union), `aliceDid` holds `rw` on `secretUri` and CAN grant access!
      await d.adminClient.procedure("com.atproto.space.putRecord", {
        space: membersSpace,
        repo: d.groupDid,
        collection: ATGRP_COLLECTION.membership,
        rkey: d.aliceDid,
        record: {
          $type: ATGRP_COLLECTION.membership,
          roles: ["admin", "member", "channel-secret"],
          createdAt: "2026-11-22T00:00:00.000Z",
        },
      });
      await d.adminClient.procedure("com.atproto.space.updateSpace", {
        space: secretUri,
        policy: {
          $type: ATGRP_POLICY,
          publicRead: false,
          unlisted: false,
          grants: [
            { role: "admin", read: true, write: true },
            { role: "channel-secret", read: true, write: true },
            { role: "member", read: true, write: true },
          ],
        },
      });
    }
  } finally {
    await fake.cleanup();
    await real.cleanup();
  }
});

test("FakeNetwork & GroupHostServer parity: browser-scoped groupAdminScopes() grants target-bound new.flock.group.abortMigration service JWTs for post-purge recovery", async () => {
  const fake = await createFakeDriver({ joinPolicy: "open", publicMeta: true });
  const real = await createRealDriver({ joinPolicy: "open", publicMeta: true });

  try {
    const quotaCountsByKind = new Map<string, number>();
    for (const d of [fake, real] as const) {
      // Authorize a session with exact browser `groupAdminScopes()` (no `groupDid`), plus a moderator session for negative check.
      const browserAdmin = await d.clientForMemberWithScopes(d.aliceDid, groupAdminScopes());
      await d.adminClient.procedure("com.atproto.space.putRecord", {
        space: groupMembersUri(d.groupDid),
        repo: d.groupDid,
        collection: ATGRP_COLLECTION.membership,
        rkey: d.bobDid,
        record: {
          $type: ATGRP_COLLECTION.membership,
          roles: ["moderator", "member"],
          createdAt: "2026-11-22T00:00:00.000Z",
        },
      });
      const modClient = await d.moderatorClientFor(d.bobDid);

      const peerDescRes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.describeServer`, {
        method: "GET",
      });
      assert.equal(peerDescRes.status, 200);
      const { did: peerServiceDid } = (await peerDescRes.json()) as { did: string };

      // 1. Moderator session cannot mint `new.flock.group.abortMigration` (`403`).
      await assert.rejects(
        () =>
          modClient.query("com.atproto.server.getServiceAuth", {
            aud: peerServiceDid,
            lxm: "new.flock.group.abortMigration",
          }),
        (err: unknown) => err instanceof XrpcError && err.status === 403,
        `[${d.kind}] moderator session must not mint abortMigration service JWT`,
      );

      // 2. Unleased `getServiceAuth(lxm = new.flock.group.abortMigration)` rejects non-GroupHost `aud` (`400 UnsupportedGroupHostTarget`).
      await assert.rejects(
        () =>
          browserAdmin.query("com.atproto.server.getServiceAuth", {
            aud: d.bobDid,
            lxm: "new.flock.group.abortMigration",
          }),
        (err: unknown) => err instanceof XrpcError && err.status === 400 && err.code === "UnsupportedGroupHostTarget",
        `[${d.kind}] unleased abortMigration service JWT must reject non-target audience`,
      );

      // 3. Stage coordinated migration on Target, verify leased `getServiceAuth(abortMigration)` enforces `aud === lease.target_service_did`,
      //    purge Target, then prove `browserAdmin` (`groupAdminScopes()`) mints a real `<groupDid>` `#atproto` `abortMigration` JWT
      //    accepted by Target (`200 { status: "already_absent" }`) and completes Source abort (`200 { status: "aborted" }`)!
      const prepRes = await d.groupHttpCall({
        path: "/group-admin/prepare-migration",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          group: d.groupDid,
          operationId: "r19-parity-abort",
          targetEndpoint: d.peerMigrationEndpoint,
        }),
      });
      assert.equal(prepRes.status, 200, `[${d.kind}] prepare-migration failed`);
      const prep = JSON.parse(Buffer.from(prepRes.bytes).toString("utf8")) as {
        operationId: string;
        targetServiceDid: string;
        migrationTicket: string;
      };
      const ticketId = prep.migrationTicket.split(".")[1]!;

      await assert.rejects(
        () =>
          browserAdmin.query("com.atproto.server.getServiceAuth", {
            aud: d.bobDid,
            lxm: "new.flock.group.abortMigration",
          }),
        (err: unknown) => err instanceof XrpcError && err.status === 409 && err.code === "MigrationInProgress",
        `[${d.kind}] leased abortMigration service JWT must restrict aud to lease.target_service_did`,
      );

      const { token: createJwt } = await browserAdmin.query<{ token: string }>("com.atproto.server.getServiceAuth", {
        aud: prep.targetServiceDid,
        lxm: "com.atproto.server.createAccount",
      });
      const stageRes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.createAccount`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${createJwt}`,
          "x-group-migration-operation-id": prep.operationId,
          "x-group-migration-ticket": prep.migrationTicket,
        },
        body: JSON.stringify({ did: d.groupDid, handle: d.groupHandle }),
      });
      assert.equal(stageRes.status, 200, `[${d.kind}] createAccount stage failed`);
      const stagedTokens = (await stageRes.json()) as { accessJwt: string; refreshJwt: string };

      // Target purges `migration_session` first (simulating lost response on attempt 1)
      const purgeRes = await d.rawFetch(`${d.peerMigrationEndpoint}/group-admin/abort-migration`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${stagedTokens.accessJwt}`,
        },
        body: JSON.stringify({ group: d.groupDid, operationId: prep.operationId, ticketId }),
      });
      assert.equal(purgeRes.status, 200);
      assert.equal(((await purgeRes.json()) as { status: string }).status, "purged");

      // `refreshSession` now returns `401` because Target purged `migration_session`
      const refreshAfterPurge = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.refreshSession`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${stagedTokens.refreshJwt}`,
          "idempotency-key": "r19-refresh-after-purge",
        },
      });
      assert.equal(refreshAfterPurge.status, 401, `[${d.kind}] refreshSession after purge must 401`);

      // Mint REAL `new.flock.group.abortMigration` service JWT via `browserAdmin` (`groupAdminScopes()`)
      const { token: abortSvcJwt } = await browserAdmin.query<{ token: string }>("com.atproto.server.getServiceAuth", {
        aud: prep.targetServiceDid,
        lxm: "new.flock.group.abortMigration",
      });
      const fallbackTargetAbort = await d.rawFetch(`${d.peerMigrationEndpoint}/group-admin/abort-migration`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${abortSvcJwt}`,
        },
        body: JSON.stringify({ group: d.groupDid, operationId: prep.operationId, ticketId }),
      });
      assert.equal(fallbackTargetAbort.status, 200, `[${d.kind}] real service-JWT abort on purged Target must 200`);
      assert.equal(((await fallbackTargetAbort.json()) as { status: string }).status, "already_absent");

      const sourceAbortRes = await d.groupHttpCall({
        path: "/group-admin/abort-migration",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ group: d.groupDid, operationId: prep.operationId }),
      });
      assert.equal(sourceAbortRes.status, 200);
      assert.equal(JSON.parse(Buffer.from(sourceAbortRes.bytes).toString("utf8")).status, "aborted");

      // 4. Round 20 Fix #1: Post-await commit-point revalidation in `getServiceAuth` refuses minting
      //    when actor is demoted during async target capability verification!
      await d.adminClient.procedure("com.atproto.space.putRecord", {
        space: groupMembersUri(d.groupDid),
        repo: d.groupDid,
        collection: ATGRP_COLLECTION.membership,
        rkey: d.bobDid,
        record: {
          $type: ATGRP_COLLECTION.membership,
          roles: ["admin", "member"],
          createdAt: "2026-11-22T00:00:00.000Z",
        },
      });
      const bobAdminClient = await d.clientForMemberWithScopes(d.bobDid, groupAdminScopes());

      let notifyInFlight!: () => void;
      const inFlightCapability = new Promise<void>((res) => {
        notifyInFlight = res;
      });
      let releaseCapability!: () => void;
      const capabilityGate = new Promise<void>((res) => {
        releaseCapability = res;
      });
      let pausedOnce = false;
      d.setSourceOutboundInterceptor(async (urlStr, _init, forward) => {
        if (!pausedOnce && urlStr.includes("/group-admin/migration-info")) {
          pausedOnce = true;
          notifyInFlight();
          await capabilityGate;
        }
        return forward();
      });

      const inFlightSvcAuth = bobAdminClient.query("com.atproto.server.getServiceAuth", {
        aud: peerServiceDid,
        lxm: "com.atproto.server.createAccount",
      });
      await inFlightCapability;

      // Demote `bobDid` from `["admin", "member"]` to `["member"]` WHILE `getServiceAuth` is awaiting target capability!
      await d.adminClient.procedure("com.atproto.space.putRecord", {
        space: groupMembersUri(d.groupDid),
        repo: d.groupDid,
        collection: ATGRP_COLLECTION.membership,
        rkey: d.bobDid,
        record: {
          $type: ATGRP_COLLECTION.membership,
          roles: ["member"],
          createdAt: "2026-11-22T00:00:00.000Z",
        },
      });
      releaseCapability();
      d.setSourceOutboundInterceptor(undefined);

      await assert.rejects(
        () => inFlightSvcAuth,
        (err: unknown) => err instanceof XrpcError && err.status === 403,
        `[${d.kind}] getServiceAuth must refuse minting when actor is demoted during async target verification`,
      );

      // 5. Round 21 Fix #3: Omitted-`exp` default (`now + 60s`) is revalidated unconditionally after signing so a
      //    >=60s signing stall rejects with `400 BadExpiration` instead of returning an already-expired token!
      await d.withSigningDelayClockAdvanceForTest(65_000, async () => {
        await assert.rejects(
          () =>
            browserAdmin.query("com.atproto.server.getServiceAuth", {
              aud: peerServiceDid,
              lxm: "com.atproto.server.createAccount",
            }),
          (err: unknown) => err instanceof XrpcError && err.status === 400 && err.code === "BadExpiration",
          `[${d.kind}] omitted-exp getServiceAuth crossing 60s default lifetime during signing must fail 400 BadExpiration`,
        );
      });

      // 6. Round 23 Fix #2: Standard-mode service-JWT `abort-migration` enforces fail-closed `leaseAttemptId` binding!
      //    (a) Leased Standard staging session: missing, empty/null/non-string, or mismatched `leaseAttemptId` with the
      //        EXACT SAME `operationId` MUST fail closed (`superseded` or `400 InvalidRequest`) without purging Target,
      //        while matching `leaseAttemptId` returns `200 { status: "purged" }`!
      const r23StdOpId = "r23-std-same-op";
      let capturedAttemptId: string | null = null;
      d.setPeerOutboundInterceptor(async (urlStr, _init, forward) => {
        const res = await forward();
        if (urlStr.includes("/group-admin/public-group-keys") && res.status === 200) {
          const cloned = (await res.clone().json()) as { leaseAttemptId?: string };
          if (typeof cloned.leaseAttemptId === "string") {
            capturedAttemptId = cloned.leaseAttemptId;
          }
        }
        return res;
      });

      const prepR23StdRes = await d.groupHttpCall({
        path: "/group-admin/prepare-migration",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          group: d.groupDid,
          operationId: r23StdOpId,
          targetEndpoint: d.peerMigrationEndpoint,
          mode: "standard",
        }),
      });
      assert.equal(prepR23StdRes.status, 200, `[${d.kind}] R23 standard prepare-migration failed`);

      const mintAbortJwt = async () => {
        const { token } = await browserAdmin.query<{ token: string }>("com.atproto.server.getServiceAuth", {
          aud: peerServiceDid,
          lxm: "new.flock.group.abortMigration",
        });
        return token;
      };
      const { token: r23CreateJwt } = await browserAdmin.query<{ token: string }>("com.atproto.server.getServiceAuth", {
        aud: peerServiceDid,
        lxm: "com.atproto.server.createAccount",
      });
      const r23StageRes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.createAccount`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${r23CreateJwt}`,
          "x-group-migration-operation-id": r23StdOpId,
        },
        body: JSON.stringify({ did: d.groupDid, handle: d.groupHandle }),
      });
      d.setPeerOutboundInterceptor(undefined);
      assert.equal(r23StageRes.status, 200, `[${d.kind}] R23 standard createAccount failed`);
      const r23Staged = (await r23StageRes.json()) as { accessJwt: string };
      const verifiedAttemptId = capturedAttemptId as string | null;
      assert.ok(verifiedAttemptId && verifiedAttemptId.length > 0, `[${d.kind}] public-group-keys must advertise leaseAttemptId`);

      // Missing `leaseAttemptId` + SAME `operationId` -> `200 { status: "superseded" }` (NEVER purges!)
      const omittedAttemptRes = await d.rawFetch(`${d.peerMigrationEndpoint}/group-admin/abort-migration`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await mintAbortJwt()}`,
        },
        body: JSON.stringify({ group: d.groupDid, operationId: r23StdOpId }),
      });
      assert.equal(omittedAttemptRes.status, 200, `[${d.kind}] omitted leaseAttemptId must return 200 superseded`);
      assert.equal(
        ((await omittedAttemptRes.json()) as { status: string }).status,
        "superseded",
        `[${d.kind}] omitted leaseAttemptId with matching operationId must fail closed as superseded`,
      );

      // Empty, whitespace, `null`, or non-string `leaseAttemptId` -> `400 InvalidRequest` (NEVER purges!)
      for (const badAttemptVal of ["", "   ", null, 123]) {
        const badAttemptRes = await d.rawFetch(`${d.peerMigrationEndpoint}/group-admin/abort-migration`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${await mintAbortJwt()}`,
          },
          body: JSON.stringify({
            group: d.groupDid,
            operationId: r23StdOpId,
            leaseAttemptId: badAttemptVal,
          }),
        });
        assert.equal(
          badAttemptRes.status,
          400,
          `[${d.kind}] malformed leaseAttemptId=${JSON.stringify(badAttemptVal)} must fail closed with 400`,
        );
        assert.equal(((await badAttemptRes.json()) as { error: string }).error, "InvalidRequest");
      }

      // Mismatched `leaseAttemptId` + SAME `operationId` -> `200 { status: "superseded" }` (NEVER purges!)
      const wrongAttemptRes = await d.rawFetch(`${d.peerMigrationEndpoint}/group-admin/abort-migration`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await mintAbortJwt()}`,
        },
        body: JSON.stringify({
          group: d.groupDid,
          operationId: r23StdOpId,
          leaseAttemptId: randomUUID(),
        }),
      });
      assert.equal(wrongAttemptRes.status, 200);
      assert.equal(((await wrongAttemptRes.json()) as { status: string }).status, "superseded");

      // Confirm staged Target session is STILL 100% live!
      const checkStillLive1 = await d.rawFetch(
        `${d.peerMigrationEndpoint}/xrpc/com.atproto.server.checkAccountStatus`,
        {
          method: "GET",
          headers: { authorization: `Bearer ${r23Staged.accessJwt}` },
        },
      );
      assert.equal(checkStillLive1.status, 200, `[${d.kind}] Standard target session must survive omitted/empty/wrong leaseAttemptId`);

      // Matching `leaseAttemptId` + SAME `operationId` -> `200 { status: "purged" }`!
      const matchingAttemptRes = await d.rawFetch(`${d.peerMigrationEndpoint}/group-admin/abort-migration`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await mintAbortJwt()}`,
        },
        body: JSON.stringify({
          group: d.groupDid,
          operationId: r23StdOpId,
          leaseAttemptId: capturedAttemptId,
        }),
      });
      assert.equal(matchingAttemptRes.status, 200);
      assert.equal(((await matchingAttemptRes.json()) as { status: string }).status, "purged");

      const cleanSourceLeaseRes = await d.groupHttpCall({
        path: "/group-admin/abort-migration",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ group: d.groupDid, operationId: r23StdOpId }),
      });
      assert.equal(cleanSourceLeaseRes.status, 200);

      //    (b) Null-session Standard staging (`ticket_id === null` via 1-key `404` fallback): BOTH omitted `leaseAttemptId`
      //        AND non-empty `leaseAttemptId` with the SAME `operationId` fail closed (`superseded`), while `at+jwt` purges!
      const r23NullOpId = "r23-std-null-sess-op";
      const { token: r23NullCreateJwt } = await browserAdmin.query<{ token: string }>(
        "com.atproto.server.getServiceAuth",
        {
          aud: peerServiceDid,
          lxm: "com.atproto.server.createAccount",
        },
      );
      d.setPeerOutboundInterceptor(async (urlStr, _init, forward) => {
        if (urlStr.includes("/group-admin/public-group-keys")) {
          return new Response(JSON.stringify({ error: "NotFound" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        }
        return forward();
      });
      const r23NullStageRes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.createAccount`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${r23NullCreateJwt}`,
          "x-group-migration-operation-id": r23NullOpId,
        },
        body: JSON.stringify({ did: d.groupDid, handle: d.groupHandle }),
      });
      d.setPeerOutboundInterceptor(undefined);
      assert.equal(r23NullStageRes.status, 200, `[${d.kind}] R23 null-ticket Standard createAccount failed`);
      const r23NullStaged = (await r23NullStageRes.json()) as { accessJwt: string };

      for (const nullSessBody of [
        { group: d.groupDid, operationId: r23NullOpId },
        { group: d.groupDid, operationId: r23NullOpId, leaseAttemptId: randomUUID() },
      ]) {
        const nullSessAbortRes = await d.rawFetch(`${d.peerMigrationEndpoint}/group-admin/abort-migration`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${await mintAbortJwt()}`,
          },
          body: JSON.stringify(nullSessBody),
        });
        assert.equal(nullSessAbortRes.status, 200);
        assert.equal(
          ((await nullSessAbortRes.json()) as { status: string }).status,
          "superseded",
          `[${d.kind}] null-ticket Standard session must fail closed as superseded on service-JWT abort (${JSON.stringify(nullSessBody)})`,
        );
      }

      const checkStillLive2 = await d.rawFetch(
        `${d.peerMigrationEndpoint}/xrpc/com.atproto.server.checkAccountStatus`,
        {
          method: "GET",
          headers: { authorization: `Bearer ${r23NullStaged.accessJwt}` },
        },
      );
      assert.equal(checkStillLive2.status, 200, `[${d.kind}] null-ticket Standard session must remain live`);

      const cleanNullSessRes = await d.rawFetch(`${d.peerMigrationEndpoint}/group-admin/abort-migration`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${r23NullStaged.accessJwt}`,
        },
        body: JSON.stringify({ group: d.groupDid }),
      });
      assert.equal(cleanNullSessRes.status, 200);
      assert.equal(((await cleanNullSessRes.json()) as { status: string }).status, "purged");

      // 7. Round 24 Fixes #1, #3, #4 parity across BOTH `[fake, real]`:
      //    (a) Retrying the SAME JWT after `400 InvalidRequest` on malformed `leaseAttemptId` succeeds cleanly (not `ReplayDetected`),
      //        and query-only `?leaseAttemptId=<matching>` with omitted JSON-body `leaseAttemptId` returns `superseded` (never purges)!
      const r24OpId = "r24-parity-op";
      let r24AttemptId: string | null = null;
      d.setPeerOutboundInterceptor(async (urlStr, _init, forward) => {
        const res = await forward();
        if (urlStr.includes("/group-admin/public-group-keys") && res.status === 200) {
          const cloned = (await res.clone().json()) as { leaseAttemptId?: string };
          if (typeof cloned.leaseAttemptId === "string") r24AttemptId = cloned.leaseAttemptId;
        }
        return res;
      });
      const prepR24Res = await d.groupHttpCall({
        path: "/group-admin/prepare-migration",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          group: d.groupDid,
          operationId: r24OpId,
          targetEndpoint: d.peerMigrationEndpoint,
          mode: "standard",
        }),
      });
      assert.equal(prepR24Res.status, 200);
      const { token: r24CreateJwt } = await browserAdmin.query<{ token: string }>("com.atproto.server.getServiceAuth", {
        aud: peerServiceDid,
        lxm: "com.atproto.server.createAccount",
      });
      const r24StageRes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.createAccount`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${r24CreateJwt}`,
          "x-group-migration-operation-id": r24OpId,
        },
        body: JSON.stringify({ did: d.groupDid, handle: d.groupHandle }),
      });
      d.setPeerOutboundInterceptor(undefined);
      assert.equal(r24StageRes.status, 200);
      const r24Staged = (await r24StageRes.json()) as { accessJwt: string };
      assert.ok(r24AttemptId);

      // Round 25 Fix #1a + Round 26 Fix #3: Repeated bearer `at+jwt` `superseded` requests with unique
      // `ticketId`/`leaseAttemptId` MUST persist ZERO rows (asserted directly against peer abort-storage count!)
      const countBeforeBearerSpam = d.getPeerAbortStorageCountForTest();
      for (let i = 0; i < 20; i += 1) {
        const bearerSupRes = await d.rawFetch(`${d.peerMigrationEndpoint}/group-admin/abort-migration`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${r24Staged.accessJwt}`,
          },
          body: JSON.stringify({
            group: d.groupDid,
            ticketId: `r25-bearer-spam-ticket-${i}`,
            leaseAttemptId: `r25-bearer-spam-att-${i}`,
          }),
        });
        assert.equal(bearerSupRes.status, 200);
        assert.equal(((await bearerSupRes.json()) as { status: string }).status, "superseded");
      }
      assert.equal(
        d.getPeerAbortStorageCountForTest(),
        countBeforeBearerSpam,
        `[${d.kind}] bearer superseded requests MUST write exactly 0 abort-storage entries`,
      );

      // Query-only `?leaseAttemptId=<matching>` MUST NOT satisfy JSON-body binding -> `200 { status: "superseded" }`!
      const queryOnlyRes = await d.rawFetch(
        `${d.peerMigrationEndpoint}/group-admin/abort-migration?leaseAttemptId=${encodeURIComponent(r24AttemptId)}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${await mintAbortJwt()}`,
          },
          body: JSON.stringify({ group: d.groupDid, operationId: r24OpId }),
        },
      );
      assert.equal(queryOnlyRes.status, 200);
      assert.equal(
        ((await queryOnlyRes.json()) as { status: string }).status,
        "superseded",
        `[${d.kind}] query-only leaseAttemptId must NOT bypass JSON-body binding`,
      );

      // Same JWT rejected with `400` on malformed `leaseAttemptId` MUST remain usable on immediate retry with valid `leaseAttemptId`!
      const reusedJwt = await mintAbortJwt();
      const firstBadRes = await d.rawFetch(`${d.peerMigrationEndpoint}/group-admin/abort-migration`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${reusedJwt}`,
        },
        body: JSON.stringify({ group: d.groupDid, operationId: r24OpId, leaseAttemptId: "" }),
      });
      assert.equal(firstBadRes.status, 400);
      const retryGoodRes = await d.rawFetch(`${d.peerMigrationEndpoint}/group-admin/abort-migration`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${reusedJwt}`,
        },
        body: JSON.stringify({ group: d.groupDid, operationId: r24OpId, leaseAttemptId: r24AttemptId }),
      });
      assert.equal(
        retryGoodRes.status,
        200,
        `[${d.kind}] retrying same JWT after 400 malformed leaseAttemptId must succeed (not ReplayDetected)`,
      );
      assert.equal(((await retryGoodRes.json()) as { status: string }).status, "purged");

      assert.equal(
        (
          await d.groupHttpCall({
            path: "/group-admin/abort-migration",
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ group: d.groupDid, operationId: r24OpId }),
          })
        ).status,
        200,
      );

      //    (b) Namespace collision (`jti = "lease-attempt:" + attemptId`) + canonical identifier length bounds + per-issuer 429 quota!
      const srcGroupKeyR24 = await d.getGroupSigningKeyForTest();
      const nowSecR24 = Math.floor(Date.now() / 1000);
      const makeCustomAbortJwt = async (jti: string) => {
        const hdr = Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256", kid: "#atproto" })).toString("base64url");
        const pay = Buffer.from(
          JSON.stringify({
            iss: d.groupDid,
            aud: peerServiceDid,
            lxm: "new.flock.group.abortMigration",
            iat: nowSecR24,
            exp: nowSecR24 + 60,
            jti,
          }),
        ).toString("base64url");
        const sig = Buffer.from(await srcGroupKeyR24.sign(Buffer.from(`${hdr}.${pay}`, "utf8"))).toString("base64url");
        return `${hdr}.${pay}.${sig}`;
      };

      const collidedAttemptId = randomUUID();
      const collidedRes = await d.rawFetch(`${d.peerMigrationEndpoint}/group-admin/abort-migration`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await makeCustomAbortJwt(`lease-attempt:${collidedAttemptId}`)}`,
        },
        body: JSON.stringify({
          group: d.groupDid,
          operationId: "r24-ns-op",
          leaseAttemptId: collidedAttemptId,
          deadlineAtMs: Date.now() + 365 * 86_400_000,
        }),
      });
      assert.equal(collidedRes.status, 200);
      assert.equal(((await collidedRes.json()) as { status: string }).status, "already_absent");

      // Overlong `operationId` (`> 128` chars) fails closed with `400 InvalidRequest` without consuming quota/JTI!
      const overlongRes = await d.rawFetch(`${d.peerMigrationEndpoint}/group-admin/abort-migration`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await makeCustomAbortJwt(`overlong-${randomUUID()}`)}`,
        },
        body: JSON.stringify({ group: d.groupDid, operationId: "a".repeat(200) }),
      });
      assert.equal(overlongRes.status, 400, `[${d.kind}] overlong operationId (>128 chars) must reject with 400`);

      // Round 26 Fixes #1 & #2: Standard-mode revoked-JTI replay-purge writes ONLY `aborted-op:` (+1, never a spurious `ticket:`!),
      // AND cross-`lxm` service JWTs (`createAccount` vs `abort-migration`) reuse distinct `jwt:` vs `abort-jwt:` replay namespaces!
      const r26ReplayOpId = "r26-std-replay-op";
      const prepR26Res = await d.groupHttpCall({
        path: "/group-admin/prepare-migration",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          group: d.groupDid,
          operationId: r26ReplayOpId,
          targetEndpoint: d.peerMigrationEndpoint,
          mode: "standard",
        }),
      });
      assert.equal(prepR26Res.status, 200);
      const sharedCrossLxmJti = `r26-cross-lxm-${randomUUID()}`;
      const makeCustomCreateJwt = async (jti: string) => {
        const hdr = Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256", kid: "#atproto" })).toString("base64url");
        const pay = Buffer.from(
          JSON.stringify({
            iss: d.groupDid,
            aud: peerServiceDid,
            lxm: "com.atproto.server.createAccount",
            iat: nowSecR24,
            exp: nowSecR24 + 60,
            jti,
          }),
        ).toString("base64url");
        const sig = Buffer.from(await srcGroupKeyR24.sign(Buffer.from(`${hdr}.${pay}`, "utf8"))).toString("base64url");
        return `${hdr}.${pay}.${sig}`;
      };
      const r26StageRes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.createAccount`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await makeCustomCreateJwt(sharedCrossLxmJti)}`,
          "x-group-migration-operation-id": r26ReplayOpId,
        },
        body: JSON.stringify({ did: d.groupDid, handle: d.groupHandle }),
      });
      assert.equal(r26StageRes.status, 200);
      const r26Staged = (await r26StageRes.json()) as { accessJwt: string; refreshJwt: string };
      // Rotate refresh token once, then replay the old refresh token -> triggers Standard replay-purge (+1 `aborted-op:` only!)
      const rotRes1 = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.refreshSession`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${r26Staged.refreshJwt}`,
          "idempotency-key": `r26-rot-1-${randomUUID()}`,
        },
      });
      assert.equal(rotRes1.status, 200);
      const rotToks1 = (await rotRes1.json()) as { refreshJwt: string };
      const rotRes2 = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.refreshSession`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${rotToks1.refreshJwt}`,
          "idempotency-key": `r26-rot-2-${randomUUID()}`,
        },
      });
      assert.equal(rotRes2.status, 200);
      const countBeforeReplayPurge = d.getPeerAbortStorageCountForTest();
      const replayOldRefreshRes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.refreshSession`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${r26Staged.refreshJwt}`,
          "idempotency-key": `r26-replay-${randomUUID()}`,
        },
      });
      assert.equal(replayOldRefreshRes.status, 401);
      assert.equal(
        d.getPeerAbortStorageCountForTest(),
        countBeforeReplayPurge + 1,
        `[${d.kind}] Standard replay-purge must add exactly +1 abort-storage entry (aborted-op only, never spurious ticket:)`,
      );
      assert.equal(
        (
          await d.groupHttpCall({
            path: "/group-admin/abort-migration",
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ group: d.groupDid, operationId: r26ReplayOpId }),
          })
        ).status,
        200,
      );
      // Reusing `sharedCrossLxmJti` (consumed in `jwt:` by `createAccount`) on `abort-migration` (`abort-jwt:`) MUST succeed on BOTH [fake, real]!
      const crossLxmAbortRes = await d.rawFetch(`${d.peerMigrationEndpoint}/group-admin/abort-migration`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await makeCustomAbortJwt(sharedCrossLxmJti)}`,
        },
        body: JSON.stringify({ group: d.groupDid, operationId: "r26-cross-lxm-op" }),
      });
      assert.equal(
        crossLxmAbortRes.status,
        200,
        `[${d.kind}] abort-migration (abort-jwt:) and createAccount (jwt:) must share identical cross-lxm replay scope`,
      );

      // Round 27 Fix #2: Post-deadline coordinated revoked-refresh replay-purge MUST NOT resurrect expired `ticket:` on FakeNetwork!
      // Both `[fake, real]` must prune expired `ticket:` and add ONLY `aborted-op:` (exact +1 delta over post-expiry count).
      const parseGroupHttpJson = <T,>(res: { bytes: Uint8Array }): T =>
        JSON.parse(Buffer.from(res.bytes).toString("utf8")) as T;
      const r27CoordOpId = "r27-coord-expired-replay";
      const prepR27CoordRes = await d.groupHttpCall({
        path: "/group-admin/prepare-migration",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          group: d.groupDid,
          operationId: r27CoordOpId,
          targetEndpoint: d.peerMigrationEndpoint,
          mode: "coordinated",
        }),
      });
      assert.equal(prepR27CoordRes.status, 200);
      const prepR27Coord = parseGroupHttpJson<{ migrationTicket: string }>(prepR27CoordRes);
      const r27CoordStageRes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.createAccount`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await makeCustomCreateJwt(`r27-coord-create-${randomUUID()}`)}`,
          "x-group-migration-operation-id": r27CoordOpId,
          "x-group-migration-ticket": prepR27Coord.migrationTicket,
        },
        body: JSON.stringify({ did: d.groupDid, handle: d.groupHandle }),
      });
      assert.equal(r27CoordStageRes.status, 200);
      const r27CoordStaged = (await r27CoordStageRes.json()) as { accessJwt: string; refreshJwt: string };
      // Rotate twice so the initial refresh JWT is revoked (while still cryptographically valid for 30d)
      const r27Rot1 = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.refreshSession`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${r27CoordStaged.refreshJwt}`,
          "idempotency-key": `r27-rot-1-${randomUUID()}`,
        },
      });
      assert.equal(r27Rot1.status, 200);
      const r27Toks1 = (await r27Rot1.json()) as { refreshJwt: string };
      const r27Rot2 = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.refreshSession`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${r27Toks1.refreshJwt}`,
          "idempotency-key": `r27-rot-2-${randomUUID()}`,
        },
      });
      assert.equal(r27Rot2.status, 200);
      // Simulate post-deadline passage (expiring both `absolute_deadline_at` and staging `ticket:` identically)
      d.setPeerStagingDeadlineForTest(Date.now() - 5_000, true);
      const countBeforeCoordExpiredReplay = d.getPeerAbortStorageCountForTest();
      const r27ExpiredReplayRes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.refreshSession`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${r27CoordStaged.refreshJwt}`,
          "idempotency-key": `r27-expired-replay-${randomUUID()}`,
        },
      });
      assert.equal(r27ExpiredReplayRes.status, 401);
      assert.equal(
        d.getPeerAbortStorageCountForTest(),
        countBeforeCoordExpiredReplay + 1,
        `[${d.kind}] post-deadline coordinated replay-purge must add ONLY aborted-op (+1) and never resurrect expired ticket:`,
      );
      assert.equal(
        (
          await d.groupHttpCall({
            path: "/group-admin/abort-migration",
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ group: d.groupDid, operationId: r27CoordOpId }),
          })
        ).status,
        200,
      );

      // Round 27 Fix #1: Unleased Standard `signPlcOperation` binds `X-Group-Migration-Operation-Id` to the created
      // `plc_signed` lease so fenced abort cleans up ONLY that operation, blocks re-signing the aborted op,
      // and stale Device A abort NEVER cancels Device B's newer lease!
      const r27StdOpA = "r27-unleased-std-op-a";
      const r27StageStdARes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.createAccount`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await makeCustomCreateJwt(`r27-std-a-${randomUUID()}`)}`,
          "x-group-migration-operation-id": r27StdOpA,
        },
        body: JSON.stringify({ did: d.groupDid, handle: d.groupHandle }),
      });
      assert.equal(r27StageStdARes.status, 200);
      const r27StdAToks = (await r27StageStdARes.json()) as { accessJwt: string };
      const r27FreshRot = await P256Keypair.create();
      const r27FreshSig = await P256Keypair.create();
      const r27FreshKem = await P256Keypair.create();
      const r27Rec: Record<string, unknown> = {
        rotationKeys: [r27FreshRot.did()],
        alsoKnownAs: [`at://${d.groupHandle}`],
        verificationMethods: {
          atproto: r27FreshSig.did(),
          atproto_kem: r27FreshKem.did(),
        },
        services: {
          atproto_pds: { type: "AtprotoPersonalDataServer", endpoint: d.peerMigrationEndpoint },
          atgrp_host: { type: "AtmosphereGroupHostV1", endpoint: d.peerMigrationEndpoint },
        },
      };
      assert.equal(
        (
          await d.groupHttpCall({
            path: "/xrpc/com.atproto.identity.requestPlcOperationSignature",
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
          })
        ).status,
        200,
      );
      const r27ClaimRes = await d.groupHttpCall({
        path: "/group-admin/claim-action-token",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ group: d.groupDid, purpose: "plc_operation" }),
      });
      assert.equal(r27ClaimRes.status, 200);
      const { token: r27PlcTok } = parseGroupHttpJson<{ token: string }>(r27ClaimRes);
      const r27SignARes = await d.groupHttpCall({
        path: "/xrpc/com.atproto.identity.signPlcOperation",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-group-migration-operation-id": r27StdOpA,
        },
        body: JSON.stringify({ token: r27PlcTok, ...r27Rec }),
      });
      assert.equal(r27SignARes.status, 200, `[${d.kind}] unleased Standard signPlcOperation with opId header must succeed`);
      // Competing signPlcOperation with a different X-Group-Migration-Operation-Id MUST reject 409 MigrationInProgress!
      const r27CompSignRes = await d.groupHttpCall({
        path: "/xrpc/com.atproto.identity.signPlcOperation",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-group-migration-operation-id": "r27-competing-op",
        },
        body: JSON.stringify({ token: r27PlcTok, ...r27Rec }),
      });
      assert.equal(r27CompSignRes.status, 409, `[${d.kind}] mismatched X-Group-Migration-Operation-Id on signPlcOperation must reject 409`);
      // Abort `r27StdOpA` on Target (Bearer) and Source (fenced `operationId`) -> both succeed!
      assert.equal(
        (
          await d.rawFetch(`${d.peerMigrationEndpoint}/group-admin/abort-migration`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${r27StdAToks.accessJwt}`,
            },
            body: JSON.stringify({ group: d.groupDid, operationId: r27StdOpA }),
          })
        ).status,
        200,
      );
      const r27AbortSrcARes = await d.groupHttpCall({
        path: "/group-admin/abort-migration",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ group: d.groupDid, operationId: r27StdOpA }),
      });
      assert.equal(r27AbortSrcARes.status, 200);
      assert.equal(parseGroupHttpJson<{ status: string }>(r27AbortSrcARes).status, "aborted");
      // Retrying signPlcOperation with already-aborted `r27StdOpA` MUST reject 409 OperationIdAlreadyAborted!
      assert.equal(
        (
          await d.groupHttpCall({
            path: "/xrpc/com.atproto.identity.requestPlcOperationSignature",
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
          })
        ).status,
        200,
      );
      const r27ClaimRes2 = await d.groupHttpCall({
        path: "/group-admin/claim-action-token",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ group: d.groupDid, purpose: "plc_operation" }),
      });
      assert.equal(r27ClaimRes2.status, 200);
      const { token: r27PlcTok2 } = parseGroupHttpJson<{ token: string }>(r27ClaimRes2);
      const r27ReuseAbortedSignRes = await d.groupHttpCall({
        path: "/xrpc/com.atproto.identity.signPlcOperation",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-group-migration-operation-id": r27StdOpA,
        },
        body: JSON.stringify({ token: r27PlcTok2, ...r27Rec }),
      });
      assert.equal(r27ReuseAbortedSignRes.status, 409);
      assert.equal(parseGroupHttpJson<{ error: string }>(r27ReuseAbortedSignRes).error, "OperationIdAlreadyAborted");
      // Device B opens a newer lease; stale Device A fenced abort (`r27StdOpA`) returns `already_absent` without cancelling Device B!
      const r27NewerOpB = "r27-newer-device-b";
      assert.equal(
        (
          await d.groupHttpCall({
            path: "/group-admin/prepare-migration",
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              group: d.groupDid,
              operationId: r27NewerOpB,
              targetEndpoint: d.peerMigrationEndpoint,
              mode: "standard",
            }),
          })
        ).status,
        200,
      );
      // Round 28 Fix #1: While `r27NewerOpB` is active on Source, an explicit mismatched `operationId` on
      // `/group-admin/public-group-keys` AND Target `createAccount` MUST reject `409 MigrationInProgress`
      // without staging Target (preserving header-omitted third-party fallback)!
      const mismatchPkRes = await d.groupHttpCall({
        path: `/group-admin/public-group-keys?group=${encodeURIComponent(d.groupDid)}&operationId=r28-mismatch-op`,
        method: "GET",
      });
      assert.equal(mismatchPkRes.status, 409, `[${d.kind}] public-group-keys must reject mismatched active-lease operationId with 409`);
      assert.equal(parseGroupHttpJson<{ error: string }>(mismatchPkRes).error, "MigrationInProgress");
      const omittedOpPkRes = await d.groupHttpCall({
        path: `/group-admin/public-group-keys?group=${encodeURIComponent(d.groupDid)}`,
        method: "GET",
      });
      assert.equal(omittedOpPkRes.status, 200, `[${d.kind}] public-group-keys must preserve header-omitted third-party fallback`);
      const mismatchStageRes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.createAccount`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await makeCustomCreateJwt(`r28-mismatch-create-${randomUUID()}`)}`,
          "x-group-migration-operation-id": "r28-mismatch-op",
        },
        body: JSON.stringify({ did: d.groupDid, handle: d.groupHandle }),
      });
      assert.equal(mismatchStageRes.status, 409, `[${d.kind}] mismatched Standard createAccount must reject 409 MigrationInProgress without pre-staging Target`);
      assert.equal(((await mismatchStageRes.json()) as { error: string }).error, "MigrationInProgress");
      // Prove Target remained unstaged so active lease `r27NewerOpB` can stage cleanly immediately!
      const leaseBStageRes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.createAccount`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await makeCustomCreateJwt(`r28-lease-b-create-${randomUUID()}`)}`,
          "x-group-migration-operation-id": r27NewerOpB,
        },
        body: JSON.stringify({ did: d.groupDid, handle: d.groupHandle }),
      });
      assert.equal(leaseBStageRes.status, 200, `[${d.kind}] active lease B must not be blocked on Target by rejected mismatched op`);

      const staleAbortARes = await d.groupHttpCall({
        path: "/group-admin/abort-migration",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ group: d.groupDid, operationId: r27StdOpA }),
      });
      assert.equal(staleAbortARes.status, 200);
      assert.equal(parseGroupHttpJson<{ status: string }>(staleAbortARes).status, "already_absent");
      const cleanAbortBRes = await d.groupHttpCall({
        path: "/group-admin/abort-migration",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ group: d.groupDid, operationId: r27NewerOpB }),
      });
      assert.equal(cleanAbortBRes.status, 200);
      assert.equal(
        parseGroupHttpJson<{ status: string }>(cleanAbortBRes).status,
        "aborted",
        `[${d.kind}] Device B's newer lease must remain live after stale Device A fenced abort`,
      );

      // Exceeding per-issuer active abort quota (256 entries) fails closed with `429 RateLimitExceeded` at the EXACT
      // mathematical threshold `Math.floor((256 - countBeforeQuotaLoop) / 3)` across `[fake, real]`, and caps `purged`!
      const countBeforeQuotaLoop = d.getPeerAbortStorageCountForTest();
      const expectedQuotaHits = Math.floor((256 - countBeforeQuotaLoop) / 3);
      let quotaHitsBefore429 = 0;
      let hit429 = false;
      for (let i = 0; i < 140; i += 1) {
        const qRes = await d.rawFetch(`${d.peerMigrationEndpoint}/group-admin/abort-migration`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${await makeCustomAbortJwt(`r24-quota-jti-${i}-${randomUUID()}`)}`,
          },
          body: JSON.stringify({
            group: d.groupDid,
            operationId: `r24-quota-op-${i}`,
            leaseAttemptId: `r24-quota-att-${i}`,
          }),
        });
        if (qRes.status === 429) {
          assert.equal(((await qRes.json()) as { error: string }).error, "RateLimitExceeded");
          hit429 = true;
          break;
        }
        assert.equal(qRes.status, 200, `[${d.kind}] abort before quota cap must return 200`);
        quotaHitsBefore429 += 1;
      }
      assert.equal(hit429, true, `[${d.kind}] repeated no-session target aborts must hit 429 per-issuer storage quota`);
      assert.equal(
        quotaHitsBefore429,
        expectedQuotaHits,
        `[${d.kind}] quota must trip at exact mathematical 256-entry threshold (before=${countBeforeQuotaLoop})`,
      );
      quotaCountsByKind.set(d.kind, quotaHitsBefore429);

      // Even a live staged session's `purged` abort respects the 256/issuer abort storage quota!
      const { token: r25PurgeCreateJwt } = await browserAdmin.query<{ token: string }>(
        "com.atproto.server.getServiceAuth",
        {
          aud: peerServiceDid,
          lxm: "com.atproto.server.createAccount",
        },
      );
      d.setPeerOutboundInterceptor(async (urlStr, _init, forward) => {
        if (urlStr.includes("/group-admin/public-group-keys")) {
          return new Response(JSON.stringify({ error: "NotFound" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        }
        return forward();
      });
      const r25StageAtCapRes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.createAccount`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${r25PurgeCreateJwt}`,
          "x-group-migration-operation-id": "r25-purge-at-cap-op",
        },
        body: JSON.stringify({ did: d.groupDid, handle: d.groupHandle }),
      });
      d.setPeerOutboundInterceptor(undefined);
      assert.equal(r25StageAtCapRes.status, 200, `[${d.kind}] staging at abort cap must succeed`);
      const r25StagedAtCap = (await r25StageAtCapRes.json()) as { accessJwt: string };
      // Fill remaining 1..2 slots to exact 256 cap via 1-entry-at-a-time aborts (no `leaseAttemptId`)
      for (let pad = 0; pad < 4; pad += 1) {
        const padRes = await d.rawFetch(`${d.peerMigrationEndpoint}/group-admin/abort-migration`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${await makeCustomAbortJwt(`r25-pad-jti-${pad}-${randomUUID()}`)}`,
          },
          body: JSON.stringify({ group: d.groupDid, operationId: "r24-quota-op-0" }),
        });
        if (padRes.status === 429) break;
      }
      assert.equal(d.getPeerAbortStorageCountForTest(), 256, `[${d.kind}] peer abort-storage must sit at exact 256 cap`);
      const purgeAtCapRes = await d.rawFetch(`${d.peerMigrationEndpoint}/group-admin/abort-migration`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${r25StagedAtCap.accessJwt}`,
        },
        body: JSON.stringify({ group: d.groupDid }),
      });
      assert.equal(purgeAtCapRes.status, 429, `[${d.kind}] live-session purged abort must also enforce 256/issuer quota`);
      assert.equal(((await purgeAtCapRes.json()) as { error: string }).error, "RateLimitExceeded");
      assert.equal(d.getPeerAbortStorageCountForTest(), 256, `[${d.kind}] rejected 429 purged abort must not exceed 256 cap`);
    }
    assert.equal(
      quotaCountsByKind.get("real"),
      quotaCountsByKind.get("fake"),
      "real and fake must hit the 256-entry abort storage quota at the exact same logical request count",
    );
  } finally {
    await fake.cleanup();
    await real.cleanup();
  }
});

test("Round 31 parity: coordinated peer-service-JWT verification enforces ES256-only, designated DID-doc kid, and #atproto_pds endpoint binding on manifest & attestation", async () => {
  const fake = await createFakeDriver({ joinPolicy: "invite", publicMeta: true, withFlockWorkspace: false });
  const real = await createRealDriver({ joinPolicy: "invite", publicMeta: true, withFlockWorkspace: false });

  try {
    for (const d of [fake, real]) {
      const srcDesc = (await (await d.rawFetch(`${d.baseUrl}/xrpc/com.atproto.server.describeServer`, { method: "GET" })).json()) as {
        did: string;
      };
      const peerDesc = (await (
        await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.describeServer`, { method: "GET" })
      ).json()) as { did: string };
      const peerSvcKey = await d.getPeerServiceKeypairForTest();
      const secpKey = await Secp256k1Keypair.create();

      const signCustomPeerJwt = async (params: {
        kp: P256Keypair | Secp256k1Keypair;
        iss: string;
        aud: string;
        lxm: string;
        kid?: string;
      }): Promise<string> => {
        const nowSec = Math.floor(Date.now() / 1000);
        const hdr = {
          alg: params.kp.jwtAlg,
          typ: "JWT",
          ...(params.kid !== undefined ? { kid: params.kid } : {}),
        };
        const pay = {
          iss: params.iss,
          aud: params.aud,
          lxm: params.lxm,
          iat: nowSec,
          exp: nowSec + 60,
          jti: `r31-peer-${randomUUID()}`,
        };
        const input = `${Buffer.from(JSON.stringify(hdr)).toString("base64url")}.${Buffer.from(JSON.stringify(pay)).toString("base64url")}`;
        const sig = await params.kp.sign(Buffer.from(input, "utf8"));
        return `${input}.${Buffer.from(sig).toString("base64url")}`;
      };

      const opId = `r31-peer-jwt-${randomUUID()}`;
      const prepRes = await d.groupHttpCall({
        path: "/group-admin/prepare-migration",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          group: d.groupDid,
          operationId: opId,
          targetEndpoint: d.peerMigrationEndpoint,
          mode: "coordinated",
        }),
      });
      assert.equal(prepRes.status, 200, `[${d.kind}] coordinated prepare-migration must succeed`);
      const prep = JSON.parse(Buffer.from(prepRes.bytes).toString("utf8")) as {
        migrationTicket: string;
        targetServiceDid: string;
      };
      const [, ticketId, ticketSecret] = prep.migrationTicket.split(".");
      assert.ok(ticketId && ticketSecret);

      const callManifest = async (jwt: string) =>
        d.rawFetch(
          `${d.baseUrl}/group-admin/migration-manifest?group=${encodeURIComponent(d.groupDid)}&ticketId=${encodeURIComponent(ticketId)}`,
          {
            method: "GET",
            headers: {
              authorization: `Bearer ${jwt}`,
              "x-group-migration-secret": ticketSecret,
            },
          },
        );

      // 1. ES256K peer JWT must be rejected with 401 InvalidToken on BOTH fake and real!
      const es256kRes = await callManifest(
        await signCustomPeerJwt({
          kp: secpKey,
          iss: peerDesc.did,
          aud: srcDesc.did,
          lxm: "com.atproto.server.createAccount",
          kid: "#atproto",
        }),
      );
      assert.equal(es256kRes.status, 401, `[${d.kind}] ES256K peer service JWT must be rejected`);
      assert.equal(((await es256kRes.json()) as { error: string }).error, "InvalidToken");

      // 2. Non-designated kid (`#other`) and nonexistent designated kid (`#atproto-missing`) must be rejected with 401 SigningKeyNotFound!
      for (const badKid of ["#other", "#atproto-missing"] as const) {
        const badKidRes = await callManifest(
          await signCustomPeerJwt({
            kp: peerSvcKey,
            iss: peerDesc.did,
            aud: srcDesc.did,
            lxm: "com.atproto.server.createAccount",
            kid: badKid,
          }),
        );
        assert.equal(badKidRes.status, 401, `[${d.kind}] kid=${badKid} must be rejected`);
        assert.equal(((await badKidRes.json()) as { error: string }).error, "SigningKeyNotFound");
      }

      // 3. Mismatched peer DID doc `#atproto_pds` endpoint must be rejected with 401 InvalidToken!
      d.setSourceOutboundInterceptor(async (urlStr, _init, forward) => {
        if (urlStr.includes("/.well-known/did.json")) {
          const origRes = await forward();
          const doc = (await origRes.json()) as {
            id: string;
            verificationMethod?: unknown[];
            service?: Array<{ id?: string; type?: string; serviceEndpoint?: string }>;
          };
          return Response.json({
            ...doc,
            service: (doc.service ?? []).map((s) =>
              s.id === "#atproto_pds" ? { ...s, serviceEndpoint: "https://wrong-peer.example" } : s,
            ),
          });
        }
        return forward();
      });
      const mismatchEpRes = await callManifest(
        await signCustomPeerJwt({
          kp: peerSvcKey,
          iss: peerDesc.did,
          aud: srcDesc.did,
          lxm: "com.atproto.server.createAccount",
          kid: "#atproto",
        }),
      );
      d.setSourceOutboundInterceptor(undefined);
      assert.equal(mismatchEpRes.status, 401, `[${d.kind}] mismatched peer DID #atproto_pds must be rejected`);
      assert.equal(((await mismatchEpRes.json()) as { error: string }).error, "InvalidToken");

      // 4a. Legacy `EcdsaSecp256r1VerificationKey2019` peer DID doc verificationMethod must ALSO succeed (200) on BOTH fake and real!
      const rawP256Multibase = bytesToMultibase(parseDidKey(peerSvcKey.did()).keyBytes, "base58btc");
      d.setSourceOutboundInterceptor(async (urlStr, _init, forward) => {
        if (urlStr.includes("/.well-known/did.json")) {
          const origRes = await forward();
          const doc = (await origRes.json()) as {
            id: string;
            verificationMethod?: Array<{ id?: string; type?: string; controller?: string; publicKeyMultibase?: string }>;
            service?: unknown[];
          };
          return Response.json({
            ...doc,
            verificationMethod: [
              {
                id: `${doc.id}#atproto`,
                type: "EcdsaSecp256r1VerificationKey2019",
                controller: doc.id,
                publicKeyMultibase: rawP256Multibase,
              },
            ],
          });
        }
        return forward();
      });
      const legacyVmManifestRes = await callManifest(
        await signCustomPeerJwt({
          kp: peerSvcKey,
          iss: peerDesc.did,
          aud: srcDesc.did,
          lxm: "com.atproto.server.createAccount",
          kid: "#atproto",
        }),
      );
      d.setSourceOutboundInterceptor(undefined);
      assert.equal(
        legacyVmManifestRes.status,
        200,
        `[${d.kind}] legacy EcdsaSecp256r1VerificationKey2019 peer DID doc must succeed`,
      );

      // 4b. Valid ES256 `#atproto` Multikey peer JWT with matching DID doc `#atproto_pds` must succeed (200)!
      const validManifestRes = await callManifest(
        await signCustomPeerJwt({
          kp: peerSvcKey,
          iss: peerDesc.did,
          aud: srcDesc.did,
          lxm: "com.atproto.server.createAccount",
          kid: "#atproto",
        }),
      );
      assert.equal(validManifestRes.status, 200, `[${d.kind}] valid ES256 #atproto peer JWT must succeed`);

      // 5. Same strict peer-service-JWT checks (negative + positive!) on Target `/group-admin/migration-attestation`!
      const srcSvcKey = await d.getSourceServiceKeypairForTest();
      const { token: createJwt } = await d.adminClient.query<{ token: string }>("com.atproto.server.getServiceAuth", {
        aud: peerDesc.did,
        lxm: "com.atproto.server.createAccount",
      });
      const stageRes = await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.server.createAccount`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${createJwt}`,
          "x-group-migration-operation-id": opId,
          "x-group-migration-ticket": prep.migrationTicket,
        },
        body: JSON.stringify({ did: d.groupDid, handle: d.groupHandle }),
      });
      assert.equal(stageRes.status, 200, `[${d.kind}] coordinated target createAccount must succeed`);
      const stagedSession = (await stageRes.json()) as { accessJwt: string };

      // Stage public repo + own spaces (`meta/self`, `members/self`) so positive `/group-admin/migration-attestation` returns 200!
      const carRes = await d.groupHttpCall({
        path: `/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(d.groupDid)}`,
        method: "GET",
      });
      assert.equal(carRes.status, 200);
      assert.equal(
        (
          await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.repo.importRepo`, {
            method: "POST",
            headers: {
              "content-type": "application/vnd.ipld.car",
              authorization: `Bearer ${stagedSession.accessJwt}`,
            },
            body: Buffer.from(carRes.bytes),
          })
        ).status,
        200,
      );
      for (const spUri of [groupMetaUri(d.groupDid), groupMembersUri(d.groupDid)]) {
        const metaExp = await d.groupHttpCall({
          path: `/xrpc/com.atproto.space.exportSpaceMeta?space=${encodeURIComponent(spUri)}`,
          method: "GET",
        });
        assert.equal(metaExp.status, 200);
        assert.equal(
          (
            await d.rawFetch(
              `${d.peerMigrationEndpoint}/xrpc/com.atproto.space.importSpaceMeta?space=${encodeURIComponent(spUri)}`,
              {
                method: "POST",
                headers: {
                  "content-type": "application/vnd.dasl.star",
                  authorization: `Bearer ${stagedSession.accessJwt}`,
                },
                body: Buffer.from(metaExp.bytes),
              },
            )
          ).status,
          200,
        );
        const repoExp = await d.groupHttpCall({
          path: `/xrpc/com.atproto.space.getRepo?space=${encodeURIComponent(spUri)}&repo=${encodeURIComponent(d.groupDid)}`,
          method: "GET",
        });
        if (repoExp.status === 200) {
          assert.equal(
            (
              await d.rawFetch(`${d.peerMigrationEndpoint}/xrpc/com.atproto.space.importRepo`, {
                method: "POST",
                headers: {
                  "content-type": "application/vnd.dasl.star",
                  authorization: `Bearer ${stagedSession.accessJwt}`,
                },
                body: Buffer.from(repoExp.bytes),
              })
            ).status,
            200,
          );
        }
      }

      const callAttestation = async (jwt: string) =>
        d.rawFetch(
          `${d.peerMigrationEndpoint}/group-admin/migration-attestation?group=${encodeURIComponent(d.groupDid)}&operationId=${encodeURIComponent(opId)}&ticketId=${encodeURIComponent(ticketId)}`,
          {
            method: "GET",
            headers: { authorization: `Bearer ${jwt}` },
          },
        );

      const attEs256kRes = await callAttestation(
        await signCustomPeerJwt({
          kp: secpKey,
          iss: srcDesc.did,
          aud: peerDesc.did,
          lxm: "com.atproto.identity.signPlcOperation",
          kid: "#atproto",
        }),
      );
      assert.equal(attEs256kRes.status, 401, `[${d.kind}] attestation ES256K peer JWT must be rejected`);
      assert.equal(((await attEs256kRes.json()) as { error: string }).error, "InvalidToken");

      const attBadKidRes = await callAttestation(
        await signCustomPeerJwt({
          kp: srcSvcKey,
          iss: srcDesc.did,
          aud: peerDesc.did,
          lxm: "com.atproto.identity.signPlcOperation",
          kid: "#other",
        }),
      );
      assert.equal(attBadKidRes.status, 401, `[${d.kind}] attestation non-designated kid must be rejected`);
      assert.equal(((await attBadKidRes.json()) as { error: string }).error, "SigningKeyNotFound");

      d.setPeerOutboundInterceptor(async (urlStr, _init, forward) => {
        if (urlStr.includes("/.well-known/did.json")) {
          const origRes = await forward();
          const doc = (await origRes.json()) as {
            id: string;
            verificationMethod?: unknown[];
            service?: Array<{ id?: string; type?: string; serviceEndpoint?: string }>;
          };
          return Response.json({
            ...doc,
            service: (doc.service ?? []).map((s) =>
              s.id === "#atproto_pds" ? { ...s, serviceEndpoint: "https://wrong-source.example" } : s,
            ),
          });
        }
        return forward();
      });
      const attMismatchEpRes = await callAttestation(
        await signCustomPeerJwt({
          kp: srcSvcKey,
          iss: srcDesc.did,
          aud: peerDesc.did,
          lxm: "com.atproto.identity.signPlcOperation",
          kid: "#atproto",
        }),
      );
      d.setPeerOutboundInterceptor(undefined);
      assert.equal(attMismatchEpRes.status, 401, `[${d.kind}] attestation mismatched source #atproto_pds must be rejected`);
      assert.equal(((await attMismatchEpRes.json()) as { error: string }).error, "InvalidToken");

      // Positive attestation case: valid ES256 `#atproto` source peer JWT must return 200 with manifestDigest & targetLocalRotationKey!
      const validAttRes = await callAttestation(
        await signCustomPeerJwt({
          kp: srcSvcKey,
          iss: srcDesc.did,
          aud: peerDesc.did,
          lxm: "com.atproto.identity.signPlcOperation",
          kid: "#atproto",
        }),
      );
      assert.equal(validAttRes.status, 200, `[${d.kind}] valid ES256 #atproto source peer JWT must succeed on attestation`);
      const validAttBody = (await validAttRes.json()) as {
        groupDid?: string;
        operationId?: string;
        manifestDigest?: string;
        targetLocalRotationKey?: string;
      };
      assert.equal(validAttBody.groupDid, d.groupDid);
      assert.equal(validAttBody.operationId, opId);
      assert.ok(typeof validAttBody.manifestDigest === "string" && validAttBody.manifestDigest.length > 0);
      assert.ok(typeof validAttBody.targetLocalRotationKey === "string" && validAttBody.targetLocalRotationKey.startsWith("did:key:"));
    }
  } finally {
    await fake.cleanup();
    await real.cleanup();
  }
});

test("FakeNetwork & GroupHostServer R15 parity: org.atgrp.mod.* appeals, self-history redaction, tags, optional status, Cache-Control, and eject/readmit/leave lifecycle", async () => {
  const fake = await createFakeDriver({ joinPolicy: "open", publicMeta: true, withFlockWorkspace: true });
  const real = await createRealDriver({ joinPolicy: "open", publicMeta: true, withFlockWorkspace: true });

  try {
    for (const d of [fake, real]) {
      const membersSpace = groupMembersUri(d.groupDid);

      // Admit Bob via open requestJoin
      const joinRes = await d.personalServiceCall<{ status: string }>({
        callerDid: d.bobDid,
        method: ATGRP_METHOD.requestJoin,
        httpMethod: "POST",
        lxm: ATGRP_METHOD.requestJoin,
        body: { group: d.groupDid },
      });
      assert.equal(joinRes.status, 200, `[${d.kind}] Bob join failed`);

      // Uniform 400 NotAppealable before any label or ejection
      const preAppeal = await d.personalServiceCall<{ error?: string }>({
        callerDid: d.bobDid,
        method: ATGRP_METHOD.modSubmitAppeal,
        httpMethod: "POST",
        lxm: ATGRP_METHOD.modSubmitAppeal,
        body: { group: d.groupDid, subject: d.bobDid, reason: "Nothing happened yet" },
      });
      assert.equal(preAppeal.status, 400, `[${d.kind}] Unlabeled member appeal must fail 400`);
      assert.equal(preAppeal.json.error, "NotAppealable", `[${d.kind}] Expected NotAppealable`);

      // Moderator ejects Bob -> Bob can appeal ejection -> opens bob.did with reportCount omitted
      await d.adminClient.procedure("com.atproto.space.deleteRecord", {
        space: membersSpace,
        repo: d.groupDid,
        collection: ATGRP_COLLECTION.membership,
        rkey: d.bobDid,
      });

      const ejectAppeal = await d.personalServiceCall<{ eventId: string; createdAt: string }>({
        callerDid: d.bobDid,
        method: ATGRP_METHOD.modSubmitAppeal,
        httpMethod: "POST",
        lxm: ATGRP_METHOD.modSubmitAppeal,
        body: { group: d.groupDid, subject: d.bobDid, reason: "Please reconsider" },
      });
      assert.equal(ejectAppeal.status, 200, `[${d.kind}] Former member ejection appeal must succeed`);
      assert.ok(ejectAppeal.json.eventId.startsWith("ev-"), `[${d.kind}] Opaque eventId required`);

      // Moderator adds tags + resolves with private note
      const upd = await d.adminClient.procedure<Record<string, unknown>, { status: string; tags?: string[]; reportCount?: number }>(
        ATGRP_METHOD.modUpdateSubject,
        {
          subject: d.bobDid,
          status: "resolved",
          note: "INTERNAL MOD NOTE",
          addTags: ["escalated", "appeal-reviewed"],
        },
      );
      assert.equal(upd.status, "resolved");
      assert.deepEqual(upd.tags, ["appeal-reviewed", "escalated"]);
      assert.equal("reportCount" in upd, false, `[${d.kind}] reportCount must be omitted when 0`);

      // `querySubjects` with repeated `tags` returns deduped match + `Cache-Control: no-store`
      const qsHttp = await d.groupHttpCall({
        path: `/xrpc/${ATGRP_METHOD.modQuerySubjects}?tags=escalated&tags=appeal-reviewed&sort=updated`,
        method: "GET",
      });
      assert.equal(qsHttp.status, 200);
      assert.equal(qsHttp.headers.get("cache-control"), "no-store", `[${d.kind}] querySubjects must set Cache-Control: no-store`);
      const qsBody = JSON.parse(Buffer.from(qsHttp.bytes).toString("utf8")) as { subjects: Array<{ subject: string }> };
      assert.equal(qsBody.subjects.length, 1, `[${d.kind}] ANY-tag filter must deduplicate`);
      assert.equal(qsBody.subjects[0]?.subject, d.bobDid);

      // `querySelfHistory` returns `#ejectEvent`, `#appealEvent`, `#statusEvent` ONLY (no `#tagEvent`), strips `createdBy` & `note`, and sets `Cache-Control: no-store`!
      const selfHist = await d.personalServiceCall<{
        events: Array<{ eventId: string; subject: string; createdBy?: string; event: Record<string, unknown> }>;
      }>({
        callerDid: d.bobDid,
        method: ATGRP_METHOD.modQuerySelfHistory,
        httpMethod: "GET",
        lxm: ATGRP_METHOD.modQuerySelfHistory,
        query: { group: d.groupDid, sort: "oldest" },
      });
      assert.equal(selfHist.status, 200, `[${d.kind}] querySelfHistory failed`);
      assert.equal(selfHist.headers.get("cache-control"), "no-store", `[${d.kind}] querySelfHistory must set Cache-Control: no-store`);
      assert.deepEqual(
        selfHist.json.events.map((e) => e.event.$type),
        [
          "org.atgrp.mod.defs#ejectEvent",
          "org.atgrp.mod.defs#appealEvent",
          "org.atgrp.mod.defs#statusEvent",
        ],
        `[${d.kind}] querySelfHistory must return exact self-visible event types`,
      );
      for (const ev of selfHist.json.events) {
        assert.equal("createdBy" in ev, false, `[${d.kind}] querySelfHistory must strip createdBy`);
        assert.equal("note" in ev.event, false, `[${d.kind}] querySelfHistory must strip note`);
      }

      // Readmit Bob -> voluntary leave -> NOT appealable!
      await d.adminClient.procedure("com.atproto.space.putRecord", {
        space: membersSpace,
        repo: d.groupDid,
        collection: ATGRP_COLLECTION.membership,
        rkey: d.bobDid,
        record: { $type: ATGRP_COLLECTION.membership, roles: ["member"], createdAt: new Date().toISOString() },
      });
      const leaveRes = await d.personalServiceCall({
        callerDid: d.bobDid,
        method: ATGRP_METHOD.leaveGroup,
        httpMethod: "POST",
        lxm: ATGRP_METHOD.leaveGroup,
        body: { group: d.groupDid },
      });
      assert.equal(leaveRes.status, 200);
      const afterLeaveAppeal = await d.personalServiceCall<{ error?: string }>({
        callerDid: d.bobDid,
        method: ATGRP_METHOD.modSubmitAppeal,
        httpMethod: "POST",
        lxm: ATGRP_METHOD.modSubmitAppeal,
        body: { group: d.groupDid, subject: d.bobDid },
      });
      assert.equal(afterLeaveAppeal.status, 400);
      assert.equal(afterLeaveAppeal.json.error, "NotAppealable");
    }
  } finally {
    await fake.cleanup();
    await real.cleanup();
  }
});
