import type { OAuthSession } from "@atproto/oauth-client-node";

// An authority's PDS held in memory, for operator unit tests: the spaces, records and member lists an operation reads and
// writes through the authority's session. Production code never imports it.

export type FakeMember = { did: string; read: boolean; write: boolean };

export type FakeAuthorityPds = {
  session: OAuthSession;
  /** Every write, in order, as `createSpace <uri>`, `putRecord <space> <collection>/<rkey>`, `putMember <space> <did>` or `removeMember <space> <did>`. */
  writes: string[];
  /** Every request, in order, as `<method> <space> [<collection>]`. */
  calls: string[];
  recordsOf(space: string, collection: string): Map<string, Record<string, unknown>>;
  membersOf(space: string): Map<string, FakeMember>;
};

type RequestBody = Record<string, string> & { record: Record<string, unknown>; read: boolean; write: boolean };

export type FakeAuthorityPdsOptions = {
  onWrite?: () => void;
  /** Answers a request in place of the fake (a refusal, an outage), or returns undefined to let the fake answer it. */
  intercept?: (method: string) => Response | undefined;
};

export function fakeAuthorityPds(did: string, options: FakeAuthorityPdsOptions = {}): FakeAuthorityPds {
  const records = new Map<string, Map<string, Record<string, unknown>>>();
  const members = new Map<string, Map<string, FakeMember>>();
  const writes: string[] = [];
  const calls: string[] = [];
  const recordsOf = (space: string, collection: string) => {
    const key = `${space} ${collection}`;
    if (!records.has(key)) records.set(key, new Map());
    return records.get(key)!;
  };
  const membersOf = (space: string) => {
    if (!members.has(space)) members.set(space, new Map());
    return members.get(space)!;
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
      calls.push([method, body?.space ?? params.get("space"), body?.collection ?? params.get("collection")].filter(Boolean).join(" "));
      const intercepted = options.intercept?.(method);
      if (intercepted) return intercepted;
      switch (method) {
        case "com.atproto.space.createSpace": {
          const uri = `at://${did}/space/${body!.spaceType}/${body!.skey}`;
          write(`createSpace ${uri}`);
          return Response.json({ uri });
        }
        case "com.atproto.space.putRecord":
          write(`putRecord ${body!.space} ${body!.collection}/${body!.rkey}`);
          recordsOf(body!.space, body!.collection).set(body!.rkey, body!.record);
          return Response.json({ uri: `${body!.space}/${body!.collection}/${body!.rkey}`, cid: "bafyreib2rxk3rybk3aobmv5cjuql3bm2twh4jo5uxgf5ss5c3sk6tkztoe" });
        case "com.atproto.space.getRecord": {
          const value = recordsOf(params.get("space")!, params.get("collection")!).get(params.get("rkey")!);
          return value
            ? Response.json({ uri: `${params.get("space")}/${params.get("collection")}/${params.get("rkey")}`, value })
            : Response.json({ error: "RecordNotFound", message: "Record not found" }, { status: 400 });
        }
        case "com.atproto.space.listRecords": {
          const collection = params.get("collection")!;
          return Response.json({ records: [...recordsOf(params.get("space")!, collection)].map(([rkey, value]) => ({ collection, rkey, value })) });
        }
        case "com.atproto.memberspace.listMembers":
          return Response.json({ members: [...membersOf(params.get("space")!).values()] });
        case "com.atproto.memberspace.putMember":
          write(`putMember ${body!.space} ${body!.did}`);
          membersOf(body!.space).set(body!.did, { did: body!.did, read: body!.read, write: body!.write });
          return Response.json({});
        case "com.atproto.memberspace.removeMember":
          write(`removeMember ${body!.space} ${body!.did}`);
          membersOf(body!.space).delete(body!.did);
          return Response.json({});
        default:
          throw new Error(`unexpected request: ${path}`);
      }
    },
  } as unknown as OAuthSession;
  return { session, writes, calls, recordsOf, membersOf };
}
