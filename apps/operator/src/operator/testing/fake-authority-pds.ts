import type { OAuthSession } from "@atproto/oauth-client-node";
import { memberspacePolicy } from "@flock/protocol/atproto/space-policy";

// An authority's PDS held in memory, for operator unit tests: the spaces, records and member lists an operation reads and
// writes through the authority's session. Production code never imports it.

export type FakeMember = { did: string; read: boolean; write: boolean };

export type FakeAuthorityPds = {
  session: OAuthSession;
  /** Every write, in order, as `createSpace <uri>`, `putRecord <space> <collection>/<rkey>`, `putMember <space> <did>` or `removeMember <space> <did>`. */
  writes: string[];
  /** Every request, in order, as `<method> <space> [<collection>]`. */
  calls: string[];
  /** A space's records in one collection; a test that reaches for them makes the space exist, as if it was created. */
  recordsOf(space: string, collection: string): Map<string, Record<string, unknown>>;
  /** A space's member list; a test that reaches for it makes the space exist, as if it was created. */
  membersOf(space: string): Map<string, FakeMember>;
};

type RequestBody = Record<string, string> & { record: Record<string, unknown>; read: boolean; write: boolean };

export type FakeAuthorityPdsOptions = {
  onWrite?: () => void;
  /** Answers a request in place of the fake (a refusal, an outage), or returns undefined to let the fake answer it. */
  intercept?: (method: string, target: { space?: string; collection?: string }) => Response | undefined;
};

export function fakeAuthorityPds(did: string, options: FakeAuthorityPdsOptions = {}): FakeAuthorityPds {
  const records = new Map<string, Map<string, Record<string, unknown>>>();
  /** Spaces that exist: created through the fake, or reached for by a test. A request's read never creates one. */
  const spaces = new Set<string>();
  const members = new Map<string, Map<string, FakeMember>>();
  const writes: string[] = [];
  const calls: string[] = [];
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
      const target = { space: body?.space ?? params.get("space") ?? undefined, collection: body?.collection ?? params.get("collection") ?? undefined };
      calls.push([method, target.space, target.collection].filter(Boolean).join(" "));
      const intercepted = options.intercept?.(method, target);
      if (intercepted) return intercepted;
      switch (method) {
        case "com.atproto.space.createSpace": {
          const uri = `at://${did}/space/${body!.spaceType}/${body!.skey}`;
          if (spaces.has(uri)) return Response.json({ error: "SpaceAlreadyExists", message: "Space already exists" }, { status: 400 });
          spaces.add(uri);
          write(`createSpace ${uri}`);
          return Response.json({ uri });
        }
        case "com.atproto.space.putRecord":
          write(`putRecord ${body!.space} ${body!.collection}/${body!.rkey}`);
          recordMap(body!.space, body!.collection).set(body!.rkey, body!.record);
          return Response.json({ uri: `${body!.space}/${body!.collection}/${body!.rkey}`, cid: "bafyreib2rxk3rybk3aobmv5cjuql3bm2twh4jo5uxgf5ss5c3sk6tkztoe" });
        case "com.atproto.space.getRecord": {
          const value = recordMap(params.get("space")!, params.get("collection")!).get(params.get("rkey")!);
          return value
            ? Response.json({ uri: `${params.get("space")}/${params.get("collection")}/${params.get("rkey")}`, value })
            : Response.json({ error: "RecordNotFound", message: "Record not found" }, { status: 400 });
        }
        case "com.atproto.space.getSpace":
          return spaces.has(params.get("space")!)
            ? Response.json({ uri: params.get("space"), policy: memberspacePolicy() })
            : Response.json({ error: "SpaceNotFound", message: "Space not found" }, { status: 400 });
        case "com.atproto.space.listRecords": {
          const collection = params.get("collection")!;
          return Response.json({ records: [...recordMap(params.get("space")!, collection)].map(([rkey, value]) => ({ collection, rkey, value })) });
        }
        case "com.atproto.memberspace.listMembers":
          return Response.json({ members: [...memberMap(params.get("space")!).values()] });
        case "com.atproto.memberspace.putMember":
          write(`putMember ${body!.space} ${body!.did}`);
          memberMap(body!.space).set(body!.did, { did: body!.did, read: body!.read, write: body!.write });
          return Response.json({});
        case "com.atproto.memberspace.removeMember":
          write(`removeMember ${body!.space} ${body!.did}`);
          memberMap(body!.space).delete(body!.did);
          return Response.json({});
        default:
          throw new Error(`unexpected request: ${path}`);
      }
    },
  } as unknown as OAuthSession;
  return { session, writes, calls, recordsOf, membersOf };
}
