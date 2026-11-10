import assert from "node:assert/strict";
import test from "node:test";
import { AtprotoClient, XrpcError } from "@/atproto/xrpc";
import { channelUri, inboxUri, requestRecordKey } from "@/protocol/keys";
import { readWriterJoinRequests } from "./inbox-requests";

const AUTHORITY = "did:plc:authority";
const INBOX = inboxUri(AUTHORITY, "team");
const CHANNELS = [{ skey: "secret", name: "secret-plans", visibility: "private" }, { skey: "general", name: "general", visibility: "public" }];
const COLLECTION = "new.flock.joinRequest";

function joinRequest(repoDid: string, channelSkey = "secret") {
  return {
    rkey: requestRecordKey(channelUri(AUTHORITY, channelSkey), repoDid),
    collection: COLLECTION,
    value: { channelSkey, requestId: "2222222222222", createdAt: "2026-11-01T00:00:00.000Z" },
  };
}

/** A host that answers the one listRecords call with `reply`, or throws it. */
function host(reply: Record<string, unknown> | Error): () => Promise<AtprotoClient> {
  return async () => new AtprotoClient(async () => {
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  });
}

const read = (repoDid: string, clientFor: () => Promise<AtprotoClient>) =>
  readWriterJoinRequests({ clientFor, inbox: INBOX, repoDid, authorityDid: AUTHORITY, channels: CHANNELS });

test("a writer's valid request for a private channel is listed with the channel's name", async () => {
  // #given a writer with one valid request for a private channel and one for a public channel
  const repoDid = "did:plc:writer";
  const clientFor = host({ records: [joinRequest(repoDid), joinRequest(repoDid, "general")] });

  // #when the writer's requests are read
  const result = await read(repoDid, clientFor);

  // #then only the private-channel request is listed
  assert.equal(result.skipped, undefined);
  assert.deepEqual(result.requests.map(({ channelSkey, channelName, repoDid: author }) => [channelSkey, channelName, author]), [["secret", "secret-plans", repoDid]]);
});

test("a writer with no repo yet has no requests and is not reported as skipped", async () => {
  const result = await read("did:plc:new", host(new XrpcError(404, "no repo", "RepoNotFound")));
  assert.deepEqual(result, { requests: [] });
});

test("a deactivated or taken-down writer is reported as skipped with a fixed reason instead of failing the list", async () => {
  // #given the pinned PDS answers a read of such an account with 400
  const deactivated = await read("did:plc:gone", host(new XrpcError(400, "Repo has been deactivated: did:plc:gone", "RepoDeactivated")));
  const takenDown = await read("did:plc:banned", host(new XrpcError(400, "Repo has been takendown: did:plc:banned", "RepoTakendown")));

  // #then each is skipped and names no text the host chose
  assert.deepEqual(deactivated, { requests: [], skipped: { did: "did:plc:gone", reason: "its account is deactivated" } });
  assert.deepEqual(takenDown, { requests: [], skipped: { did: "did:plc:banned", reason: "its account was taken down" } });
});

test("a writer whose host is down, whose DID cannot be resolved, or whose page is malformed is skipped, not fatal", async () => {
  assert.deepEqual((await read("did:plc:down", host(new XrpcError(502, "Bad Gateway", "UpstreamFailure")))).skipped, { did: "did:plc:down", reason: "its host answered HTTP 502" });
  assert.deepEqual((await read("did:plc:lost", async () => { throw new Error("Could not resolve did:plc:lost."); })).skipped, { did: "did:plc:lost", reason: "its host could not be read" });
  assert.deepEqual((await read("did:plc:odd", host({ records: "not-a-list" }))).skipped, { did: "did:plc:odd", reason: "its host could not be read" });
});

test("a writer with more than 100 current requests is skipped so the admin can still read everyone else", async () => {
  const repoDid = "did:plc:spammer";
  const records = Array.from({ length: 101 }, (_, index) => ({ ...joinRequest(repoDid), rkey: `r-${index}` }));
  const result = await read(repoDid, host({ records }));
  assert.deepEqual(result, { requests: [], skipped: { did: repoDid, reason: "it has more than 100 current request records" } });
});

test("a store failure is not blamed on the writer", async () => {
  await assert.rejects(
    read("did:plc:writer", async () => { throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }); }),
    /database is locked/,
  );
});
