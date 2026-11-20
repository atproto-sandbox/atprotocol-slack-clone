import type { OAuthSession } from "@atproto/oauth-client-node";
import { memberspacePolicy } from "@flock/protocol/atproto/space-policy";
import { parseSpaceUri } from "@flock/protocol/keys";

// An authority's PDS held in memory, for operator unit tests: the spaces, records and member lists an operation reads and
// writes through the authority's session. Production code never imports it.

export type FakeMember = { did: string; read: boolean; write: boolean };

export type FakeAuthorityAccountStatus = {
  active: boolean;
  status?: "takendown" | "deactivated" | "suspended";
};

export type FakeAuthorityPds = {
  session: OAuthSession;
  /** Every write, in order, as `createSpace <uri>`, `putRecord <space> <collection>/<rkey>`, `putMembers <space> <did>` or `removeMembers <space> <did>`. */
  writes: string[];
  /** Every request, in order, as `<method> <space> [<collection>]`. */
  calls: string[];
  /** A space's records in one collection; a test that reaches for them makes the space exist, as if it was created. */
  recordsOf(space: string, collection: string): Map<string, Record<string, unknown>>;
  /** A space's member list; a test that reaches for it makes the space exist, as if it was created. */
  membersOf(space: string): Map<string, FakeMember>;
  /** Updates the authority's account status reported by `getRepoStatus` and `listSpaces`. */
  setAccountStatus(status: FakeAuthorityAccountStatus): void;
};

type RequestBody = {
  space?: string;
  spaceType?: string;
  skey?: string;
  collection?: string;
  rkey?: string;
  record?: Record<string, unknown>;
  members?: Array<{ did: string; read: boolean; write: boolean }>;
  dids?: string[];
};

export type FakeAuthorityPdsOptions = {
  onWrite?: () => void;
  /** Initial account status reported by `com.atproto.sync.getRepoStatus` and `com.atproto.space.listSpaces`. */
  accountStatus?: FakeAuthorityAccountStatus;
  /** Answers a request in place of the fake (a refusal, an outage), or returns undefined to let the fake answer it. */
  intercept?: (method: string, target: { space?: string; collection?: string; spaceType?: string }) => Response | undefined;
};

export function fakeAuthorityPds(did: string, options: FakeAuthorityPdsOptions = {}): FakeAuthorityPds {
  const records = new Map<string, Map<string, Record<string, unknown>>>();
  /** Spaces that exist: created through the fake, or reached for by a test. A request's read never creates one. */
  const spaces = new Set<string>();
  const members = new Map<string, Map<string, FakeMember>>();
  const writes: string[] = [];
  const calls: string[] = [];
  let accountStatus: FakeAuthorityAccountStatus = options.accountStatus ?? { active: true };
  const recordMap = (space: string, collection: string) => {
    const key = `${space} ${collection}`;
    if (!records.has(key)) records.set(key, new Map());
    return records.get(key)!;
  };
  const memberMap = (space: string) => {
    if (!members.has(space)) members.set(space, new Map());
    return members.get(space)!;
  };
  const recordsOf = (space: string, collection: string) => {
    spaces.add(space);
    return recordMap(space, collection);
  };
  const membersOf = (space: string) => {
    spaces.add(space);
    return memberMap(space);
  };
  const write = (entry: string) => {
    writes.push(entry);
    options.onWrite?.();
  };
  const session = {
    did,
    fetchHandler: async (path: string, init?: RequestInit) => {
      const url = new URL(path, "https://pds.invalid");
      const method = url.pathname.replace("/xrpc/", "");
      const params = url.searchParams;
      const body = init?.body ? JSON.parse(String(init.body)) as RequestBody : undefined;
      const space = body?.space ?? params.get("space") ?? undefined;
      const spaceType = body?.spaceType ?? (space ? parseSpaceUri(space)?.type : undefined);
      const target = {
        space,
        collection: body?.collection ?? params.get("collection") ?? undefined,
        ...(spaceType ? { spaceType } : {}),
      };
      calls.push([method, target.space, target.collection].filter(Boolean).join(" "));
      const intercepted = options.intercept?.(method, target);
      if (intercepted) return intercepted;
      switch (method) {
        case "com.atproto.space.createSpace": {
          const uri = `at://${did}/space/${body!.spaceType!}/${body!.skey!}`;
          if (spaces.has(uri)) return Response.json({ error: "SpaceAlreadyExists", message: "Space already exists" }, { status: 400 });
          spaces.add(uri);
          write(`createSpace ${uri}`);
          return Response.json({ space: uri });
        }
        case "com.atproto.space.putRecord":
          write(`putRecord ${body!.space!} ${body!.collection!}/${body!.rkey!}`);
          recordMap(body!.space!, body!.collection!).set(body!.rkey!, body!.record!);
          return Response.json({ uri: `${body!.space!}/${body!.collection!}/${body!.rkey!}`, cid: "bafyreib2rxk3rybk3aobmv5cjuql3bm2twh4jo5uxgf5ss5c3sk6tkztoe" });
        case "com.atproto.space.getRecord": {
          const value = recordMap(params.get("space")!, params.get("collection")!).get(params.get("rkey")!);
          return value
            ? Response.json({ uri: `${params.get("space")}/${params.get("collection")}/${params.get("rkey")}`, value })
            : Response.json({ error: "RecordNotFound", message: "Record not found" }, { status: 400 });
        }
        case "com.atproto.space.getSpace":
          return spaces.has(params.get("space")!)
            ? Response.json({ space: params.get("space"), policy: memberspacePolicy() })
            : Response.json({ error: "SpaceNotFound", message: "Space not found" }, { status: 400 });
        case "com.atproto.sync.getRepoStatus": {
          const targetDid = params.get("did") ?? did;
          if (targetDid !== did) {
            return Response.json({ error: "RepoNotFound", message: "Repo not found" }, { status: 400 });
          }
          if (!accountStatus.active) {
            return Response.json({ did, active: false, status: accountStatus.status ?? "takendown" });
          }
          return Response.json({ did, active: true, rev: "3kabcdefghij2" });
        }
        case "com.atproto.space.listSpaces": {
          if (!accountStatus.active) {
            const code = accountStatus.status === "deactivated" ? "RepoDeactivated" : "RepoTakendown";
            return Response.json({ error: code, message: "Repo is not active" }, { status: 400 });
          }
          const spaceDidFilter = params.get("spaceDid");
          const spaceTypeFilter = params.get("spaceType");
          const rawLimit = params.get("limit");
          const limit = rawLimit ? Number(rawLimit) : 50;
          const matching = [...spaces]
            .filter((uri) => {
              const parsed = parseSpaceUri(uri);
              if (!parsed) return false;
              if (spaceDidFilter && parsed.authorityDid !== spaceDidFilter) return false;
              if (spaceTypeFilter && parsed.type !== spaceTypeFilter) return false;
              return true;
            })
            .sort();
          const slice = matching.slice(0, limit);
          return Response.json({
            spaces: slice.map((spaceUri) => ({ space: spaceUri })),
            ...(slice.length < matching.length ? { cursor: slice.at(-1) } : {}),
          });
        }
        case "com.atproto.space.listRecords": {
          const collection = params.get("collection")!;
          return Response.json({ records: [...recordMap(params.get("space")!, collection)].map(([rkey, value]) => ({ collection, rkey, value })) });
        }
        case "com.atproto.memberspace.listMembers": {
          const spaceUri = params.get("space")!;
          if (!spaces.has(spaceUri)) return Response.json({ error: "SpaceNotFound", message: "Space not found" }, { status: 400 });
          const allMembers = [...memberMap(spaceUri).values()];
          const rawLimit = params.get("limit");
          const limit = rawLimit ? Number(rawLimit) : allMembers.length;
          const rawCursor = params.get("cursor");
          const start = rawCursor ? Number(rawCursor) : 0;
          const slice = allMembers.slice(start, start + limit);
          const next = start + slice.length;
          return Response.json({
            members: slice,
            ...(next < allMembers.length ? { cursor: String(next) } : {}),
          });
        }
        case "com.atproto.memberspace.putMembers": {
          const spaceUri = body!.space!;
          if (!spaces.has(spaceUri)) return Response.json({ error: "SpaceNotFound", message: "Space not found" }, { status: 400 });
          if (!Array.isArray(body!.members) || body!.members.length > 100) {
            return Response.json({ error: "InvalidRequest", message: "members must be an array of at most 100 entries" }, { status: 400 });
          }
          for (const entry of body!.members) {
            write(`putMembers ${spaceUri} ${entry.did}`);
            memberMap(spaceUri).set(entry.did, { did: entry.did, read: entry.read, write: entry.write });
          }
          return Response.json({});
        }
        case "com.atproto.memberspace.removeMembers": {
          const spaceUri = body!.space!;
          if (!spaces.has(spaceUri)) return Response.json({ error: "SpaceNotFound", message: "Space not found" }, { status: 400 });
          if (!Array.isArray(body!.dids) || body!.dids.length > 100) {
            return Response.json({ error: "InvalidRequest", message: "dids must be an array of at most 100 DIDs" }, { status: 400 });
          }
          for (const memberDid of body!.dids) {
            write(`removeMembers ${spaceUri} ${memberDid}`);
            memberMap(spaceUri).delete(memberDid);
          }
          return Response.json({});
        }
        default:
          throw new Error(`unexpected request: ${path}`);
      }
    },
  } as unknown as OAuthSession;
  return {
    session,
    writes,
    calls,
    recordsOf,
    membersOf,
    setAccountStatus(status) {
      accountStatus = status;
    },
  };
}
