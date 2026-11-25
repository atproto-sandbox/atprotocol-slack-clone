import { createHash } from "node:crypto";
import type { OAuthSession } from "@atproto/oauth-client-node";
import type { DidString } from "@atproto/syntax";
import { XrpcError } from "@flock/protocol/atproto/xrpc";
import { groupMembersUri, parseSpaceUri } from "@flock/protocol/keys";
import {
  ATPROTO_SPACE_COLLECTION,
  OPENSOCIAL_COLLECTION,
  OPENSOCIAL_METHOD,
  OPENSOCIAL_POLICY,
} from "@flock/protocol/nsids";
import { groupAdminScopes, type GroupOpenSocialPolicy } from "@flock/protocol/scopes";
import { FakeNetwork } from "@flock/testing/fake-network";
import { setIdentityTestOverrides } from "../../atproto/identity";

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * Deterministic, human-readable valid `did:plc:[a-z2-7]{24}` for test fixtures.
 */
export function plcDid(label: string): DidString {
  const prefix = label
    .toLowerCase()
    .replace(/[^a-z2-7]/g, "")
    .slice(0, 10);
  const digest = createHash("sha256").update(label, "utf8").digest();
  let suffix = "";
  for (let i = 0; suffix.length + prefix.length < 24; i += 1) {
    suffix += BASE32_ALPHABET[digest[i % digest.length]! & 31]!;
  }
  return `did:plc:${prefix}${suffix}` as DidString;
}

export type FakeGroupTarget = {
  method: string;
  space?: string;
  spaceType?: string;
  skey?: string;
  collection?: string;
  rkey?: string;
  repo?: string;
  member?: string;
};

export type FakeGroupSessionOptions = {
  network?: FakeNetwork;
  creatorDid?: DidString;
  authorizingUserDid?: DidString;
  approvedScopes?: readonly string[];
  name?: string;
  joinPolicy?: "open" | "approval" | "invite";
  publicMeta?: boolean;
  intercept?: (
    method: string,
    target: FakeGroupTarget,
    init?: RequestInit,
  ) => Response | Promise<Response | undefined> | undefined;
  onWrite?: (entry: string) => void;
};

const MUTATING_METHODS = new Set([
  "com.atproto.space.createSpace",
  "com.atproto.space.updateSpace",
  "com.atproto.space.deleteSpace",
  "com.atproto.space.putRecord",
  "com.atproto.space.createRecord",
  "com.atproto.space.deleteRecord",
  "com.atproto.space.applyWrites",
  "com.atproto.space.clearRecords",
  "com.atproto.space.removeWriter",
  OPENSOCIAL_METHOD.denyJoinRequest,
]);

function parseTarget(url: URL, init?: RequestInit): FakeGroupTarget {
  const method = url.pathname.replace(/^\/xrpc\//, "");
  let body: Record<string, unknown> = {};
  if (typeof init?.body === "string" && init.body.length > 0) {
    try {
      const parsed: unknown = JSON.parse(init.body);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      // Non-JSON body
    }
  }
  const space =
    (typeof body.space === "string" ? body.space : undefined) ??
    url.searchParams.get("space") ??
    undefined;
  const parsedSpace = space ? parseSpaceUri(space) : null;
  const spaceType =
    (typeof body.spaceType === "string" ? body.spaceType : undefined) ??
    url.searchParams.get("spaceType") ??
    parsedSpace?.type;
  const skey =
    (typeof body.skey === "string" ? body.skey : undefined) ??
    url.searchParams.get("skey") ??
    parsedSpace?.skey;
  const collection =
    (typeof body.collection === "string" ? body.collection : undefined) ??
    url.searchParams.get("collection") ??
    undefined;
  const rkey =
    (typeof body.rkey === "string" ? body.rkey : undefined) ??
    url.searchParams.get("rkey") ??
    undefined;
  const repo =
    (typeof body.repo === "string" ? body.repo : undefined) ??
    url.searchParams.get("repo") ??
    undefined;
  const member =
    (typeof body.member === "string" ? body.member : undefined) ??
    url.searchParams.get("member") ??
    undefined;

  return { method, space, spaceType, skey, collection, rkey, repo, member };
}

function formatWriteEntry(groupDid: string, target: FakeGroupTarget): string {
  switch (target.method) {
    case "com.atproto.space.createSpace": {
      const uri = target.space ?? `at:space/${groupDid}/${target.spaceType}/${target.skey}`;
      return `createSpace ${uri}`;
    }
    case "com.atproto.space.updateSpace":
      return `updateSpace ${target.space}`;
    case "com.atproto.space.deleteSpace":
      return `deleteSpace ${target.space}`;
    case "com.atproto.space.putRecord":
      return `putRecord ${target.space} ${target.collection}/${target.rkey}`;
    case "com.atproto.space.createRecord":
      return `createRecord ${target.space} ${target.collection}/${target.rkey ?? "*"}`;
    case "com.atproto.space.deleteRecord":
      return `deleteRecord ${target.space} ${target.collection}/${target.rkey}`;
    case "com.atproto.space.applyWrites":
      return `applyWrites ${target.space}`;
    case "com.atproto.space.removeWriter":
      return `removeWriter ${target.space} ${target.repo}`;
    case OPENSOCIAL_METHOD.denyJoinRequest:
      return `denyJoinRequest ${target.member}`;
    default:
      return `${target.method} ${target.space ?? ""}`.trim();
  }
}

export async function fakeGroupHost(
  groupDid: DidString,
  options: FakeGroupSessionOptions = {},
) {
  const network = options.network ?? new FakeNetwork();
  setIdentityTestOverrides({
    resolvePds: (did) => network.resolvePds(did),
    resolveKemKey: (did, forceRefresh) => network.resolveKemKey(did, forceRefresh),
    resolveSigningKey: (did, forceRefresh) => network.resolveSigningKey(did, forceRefresh),
    fetchEndpoint: (input, init) => network.fetchEndpoint(input instanceof Request ? input : new Request(input, init)),
  });
  const ensurePersonalAccount = (did: string) => {
    if (did !== groupDid && did.startsWith("did:") && !network.hasAccount(did)) {
      network.createAccount(did);
    }
  };
  if (options.creatorDid) ensurePersonalAccount(options.creatorDid);
  if (options.authorizingUserDid) ensurePersonalAccount(options.authorizingUserDid);

  if (!network.hasAccount(groupDid)) {
    await network.createGroupAccount(groupDid, {
      creatorDid: options.creatorDid,
      name: options.name ?? "Group",
      joinPolicy: options.joinPolicy ?? "invite",
      publicMeta: options.publicMeta ?? true,
    });
  }

  let currentToken: string = options.authorizingUserDid || options.creatorDid
    ? network.issueGroupSessionToken(
        groupDid,
        (options.authorizingUserDid ?? options.creatorDid)!,
        { approvedScopes: options.approvedScopes ?? groupAdminScopes(groupDid) },
      )
    : network.issueSessionToken(groupDid, "full");

  const calls: string[] = [];
  const writes: string[] = [];

  const fetchHandler = async (path: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(path, "https://fake-pds.test/group-host");
    const target = parseTarget(url, init);
    if (target.space) {
      const spaceOwner = parseSpaceUri(target.space)?.authorityDid;
      if (spaceOwner) ensurePersonalAccount(spaceOwner);
    }
    if (target.rkey && target.rkey.startsWith("did:")) ensurePersonalAccount(target.rkey);
    if (target.member && target.member.startsWith("did:")) ensurePersonalAccount(target.member);

    calls.push(`${target.method} ${target.space ?? target.collection ?? ""}`.trim());
    const intercepted = await options.intercept?.(target.method, target, init);
    if (intercepted) return intercepted;

    const headers = new Headers(init?.headers);
    if (!headers.has("authorization")) {
      headers.set("authorization", `DPoP ${currentToken}`);
    }
    const req = new Request(url.toString(), {
      method: init?.method ?? "GET",
      headers,
      body: init?.body as BodyInit | null | undefined,
    });
    const res = await network.fetchEndpoint(req);
    if (res.ok && MUTATING_METHODS.has(target.method)) {
      const entry = formatWriteEntry(groupDid, target);
      writes.push(entry);
      options.onWrite?.(entry);
    }
    return res;
  };

  const session = { did: groupDid, fetchHandler } as unknown as OAuthSession;
  const selfClient = network.clientFor(groupDid);

  const getSpacePolicy = async (spaceUri: string): Promise<GroupOpenSocialPolicy | null> => {
    try {
      const out = await selfClient.query<{ policy?: Record<string, unknown> }>("com.atproto.space.getSpace", {
        space: spaceUri,
      });
      if (out.policy?.$type === OPENSOCIAL_POLICY) {
        return out.policy as unknown as GroupOpenSocialPolicy;
      }
      return null;
    } catch (err) {
      if (err instanceof XrpcError && (err.code === "SpaceNotFound" || err.code === "SpaceDeleted")) {
        return null;
      }
      throw err;
    }
  };

  const getRecord = async <T = Record<string, unknown>>(
    spaceUri: string,
    collection: string,
    rkey: string,
    repoDid: string = groupDid,
  ): Promise<T | undefined> => {
    try {
      const out = await selfClient.query<{ value: T }>("com.atproto.space.getRecord", {
        space: spaceUri,
        repo: repoDid,
        collection,
        rkey,
      });
      return out.value;
    } catch (err) {
      if (
        err instanceof XrpcError &&
        (err.code === "RecordNotFound" || err.code === "RepoNotFound" || err.code === "SpaceNotFound")
      ) {
        return undefined;
      }
      throw err;
    }
  };

  const putRecord = async (
    spaceUri: string,
    collection: string,
    rkey: string,
    record: Record<string, unknown>,
  ): Promise<void> => {
    const spaceOwner = parseSpaceUri(spaceUri)?.authorityDid;
    if (spaceOwner) ensurePersonalAccount(spaceOwner);
    if (rkey.startsWith("did:")) ensurePersonalAccount(rkey);
    await selfClient.procedure("com.atproto.space.putRecord", {
      space: spaceUri,
      repo: groupDid,
      collection,
      rkey,
      record: { $type: collection, ...record },
    });
  };

  const deleteRecord = async (
    spaceUri: string,
    collection: string,
    rkey: string,
  ): Promise<void> => {
    await selfClient.procedure("com.atproto.space.deleteRecord", {
      space: spaceUri,
      repo: groupDid,
      collection,
      rkey,
    });
  };

  const putMemberRecord = async (
    memberDid: string,
    spaceUri: string,
    collection: string,
    rkey: string,
    record: Record<string, unknown>,
  ): Promise<void> => {
    ensurePersonalAccount(memberDid);
    await network.clientFor(memberDid).procedure("com.atproto.space.putRecord", {
      space: spaceUri,
      repo: memberDid,
      collection,
      rkey,
      record: { $type: collection, ...record },
    });
  };

  const requestGroupJoin = async (
    memberDid: string,
    input: { invite?: string; message?: string; idempotencyKey?: string } = {},
  ): Promise<Record<string, unknown>> => {
    ensurePersonalAccount(memberDid);
    const { token } = await network.clientFor(memberDid).query<{ token: string }>(
      "com.atproto.server.getServiceAuth",
      {
        aud: `${groupDid}#atproto_pds`,
        lxm: OPENSOCIAL_METHOD.requestJoin,
      },
    );
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };
    if (input.idempotencyKey) headers["idempotency-key"] = input.idempotencyKey;
    const res = await network.fetchEndpoint(
      new Request(`https://fake-pds.test/group-host/xrpc/${OPENSOCIAL_METHOD.requestJoin}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          group: groupDid,
          ...(input.invite !== undefined ? { invite: input.invite } : {}),
          ...(input.message !== undefined ? { message: input.message } : {}),
        }),
      }),
    );
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      throw new XrpcError(res.status, String(json.message ?? json.error ?? "XrpcError"), String(json.error ?? "XrpcError"));
    }
    return json;
  };

  const effectiveAccess = async (spaceUri: string, subjectDid: string): Promise<"rw" | "r" | "-"> => {
    const policy = await getSpacePolicy(spaceUri);
    if (!policy) return "-";
    const membership = await getRecord<{ roles: string[] }>(
      groupMembersUri(groupDid),
      OPENSOCIAL_COLLECTION.membership,
      subjectDid,
    );
    if (!membership || !Array.isArray(membership.roles) || membership.roles.length === 0) {
      return policy.publicRead ? "r" : "-";
    }
    const roleSet = new Set(membership.roles);
    let canRead = Boolean(policy.publicRead);
    let canWrite = false;
    for (const grant of policy.grants ?? []) {
      if (roleSet.has(grant.role)) {
        if (grant.read) canRead = true;
        if (grant.write) canWrite = true;
      }
    }
    if (canWrite) return "rw";
    if (canRead) return "r";
    return "-";
  };

  const switchAuthorizer = (
    authorizingUserDid: DidString,
    approvedScopes?: readonly string[],
  ) => {
    ensurePersonalAccount(authorizingUserDid);
    currentToken = network.issueGroupSessionToken(groupDid, authorizingUserDid, {
      approvedScopes: approvedScopes ?? groupAdminScopes(groupDid),
    });
  };

  return {
    network,
    groupDid,
    session,
    selfClient,
    calls,
    writes,
    getSpacePolicy,
    getRecord,
    putRecord,
    deleteRecord,
    putMemberRecord,
    requestGroupJoin,
    effectiveAccess,
    switchAuthorizer,
    ATPROTO_SPACE_COLLECTION,
  };
}

export type FakeGroupHostHandle = Awaited<ReturnType<typeof fakeGroupHost>>;
