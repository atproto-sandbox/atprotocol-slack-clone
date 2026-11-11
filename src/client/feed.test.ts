import assert from "node:assert/strict";
import test from "node:test";
import { COLLECTION } from "@/protocol/nsids";
import { AUTHORITY, countCalls, createWorkspace, transportFor, writeMessage } from "@/testing/engine-fixture";
import { FakeNetwork } from "@/testing/fake-network";
import { createEngine } from "./engine";
import { ChangeFollower } from "./feed";
import type { ChangesAnswer, OperatorService } from "./operator-client";

// Following spaces through the change feed: the order that loses nothing, and what the client does with changed, reset and
// denied spaces.

const SPACE = "at://did:plc:owner/space/new.flock.channel/acme-general";
const ALICE = "did:plc:alice";

/** An operator that answers each call from a queue, recording what it was asked. */
function scriptedOperator(answers: ChangesAnswer[]) {
  const asked: Array<Array<{ space: string; after: string }>> = [];
  return {
    asked,
    getChanges: async (follow: ReadonlyArray<{ space: string; after: string }>) => {
      asked.push([...follow]);
      const answer = answers.shift();
      if (!answer) throw new Error("no answer scripted");
      return answer;
    },
  };
}
const answer = (head: string, parts: Partial<ChangesAnswer> = {}): ChangesAnswer => ({ head, changed: [], denied: [], reset: [], ...parts });

test("a space is followed from the head read before it was synced, so a change in between is reported again", async () => {
  const order: string[] = [];
  const operator = scriptedOperator([answer("7"), answer("9", { changed: [{ space: SPACE, cursor: "8" }] })]);
  const follower = new ChangeFollower({
    operator: { getChanges: async (follow) => { order.push("head"); return operator.getChanges(follow); } },
    credentials: { fresh: async () => { throw new Error("not used"); } },
    sync: async () => { order.push("sync"); },
  });
  await follower.follow(SPACE);
  assert.deepEqual(order, ["head", "sync"]);
  await follower.poll();
  assert.deepEqual(operator.asked[1], [{ space: SPACE, after: "7" }]);
});

test("a changed space is synced and followed from its cursor; a reset one from the answer's head; a failed sync keeps its cursor", async () => {
  const other = `${SPACE}-other`;
  let failing = true;
  const operator = scriptedOperator([
    answer("1"), answer("1"),
    answer("20", { changed: [{ space: SPACE, cursor: "15" }], reset: [other] }),
    answer("21"),
  ]);
  const follower = new ChangeFollower({
    operator, credentials: { fresh: async () => { throw new Error("not used"); } },
    sync: async (space) => { if (space === other && failing) throw new Error("its host is down"); },
    retryDelayMs: 0,
  });
  await follower.follow(SPACE);
  failing = false;
  await follower.follow(other);
  failing = true;
  const result = await follower.poll();
  assert.deepEqual(result.synced, [SPACE]);
  assert.deepEqual(result.failed.map((failure) => failure.space), [other]);
  await follower.poll();
  assert.deepEqual(operator.asked[3], [{ space: SPACE, after: "15" }, { space: other, after: "1" }]);
});

test("a deleted workspace comes back denied; the client's mint reports it deleted and drops it with its channels, and stops following it", async () => {
  const network = new FakeNetwork();
  const fixture = await createWorkspace(network, { members: [ALICE], channels: [{ skey: "general", visibility: "public" }] });
  await writeMessage(network, ALICE, fixture.channels.general!, 1);
  const alice = createEngine(transportFor(network, ALICE));
  await alice.channels.readPage({ workspace: fixture.workspace, skey: "acme-general" });
  const operator = scriptedOperator([answer("1"), answer("2", { denied: [fixture.workspace] })]);
  const follower = new ChangeFollower({ operator, credentials: alice.credentials, sync: async () => undefined });
  await follower.follow(fixture.workspace);
  await network.clientFor(AUTHORITY).procedure("com.atproto.space.deleteSpace", { space: fixture.workspace });
  const result = await follower.poll();
  assert.deepEqual(result.unfollowed, [fixture.workspace]);
  assert.deepEqual(follower.following, []);
  assert.deepEqual(await alice.sync.store.records(fixture.channels.general!, COLLECTION.message), [], "the workspace's channel went with it");
});

test("a denied space whose credential is refused only for now stays followed; one whose access is back is synced and followed again", async () => {
  const synced: string[] = [];
  let mint: () => Promise<unknown> = async () => { throw Object.assign(new Error("its host is down"), { status: 503 }); };
  const operator = scriptedOperator([answer("1"), answer("2", { denied: [SPACE] }), answer("3", { denied: [SPACE] }), answer("4")]);
  const follower = new ChangeFollower({ operator, credentials: { fresh: async () => mint() as never }, sync: async (space) => { synced.push(space); }, retryDelayMs: 0 });
  await follower.follow(SPACE);
  assert.deepEqual(await follower.poll(), { synced: [], unfollowed: [], failed: [] });
  assert.deepEqual(follower.following, [SPACE]);
  mint = async () => ({});
  assert.deepEqual((await follower.poll()).synced, [SPACE]);
  assert.deepEqual(operator.asked.at(-1), [], "regained access starts again from head");
  assert.equal(synced.length, 2);
});

test("the long-poll token lasts fourteen minutes and is reused across polls; every other method's is fresh per call", async () => {
  const network = new FakeNetwork();
  const service: OperatorService = { serviceRef: "did:web:operator.test#atproto_flock_operator", endpoint: "https://operator.test" };
  const expiries: number[] = [];
  const engine = createEngine({
    ...transportFor(network, ALICE),
    fetchEndpoint: async (request) => {
      if (new URL(request.url).origin !== service.endpoint) return network.fetchEndpoint(request);
      expiries.push(network.readServiceToken(request.headers.get("authorization")!.replace(/^Bearer /, ""))!.exp);
      return Response.json(new URL(request.url).pathname.endsWith("getChanges") ? answer("1") : { writers: [] });
    },
  }, { operator: service });
  const issued = (run: () => Promise<unknown>) => countCalls(network, run).then((calls) => calls["com.atproto.server.getServiceAuth"] ?? 0);
  assert.equal(await issued(async () => { await engine.operator!.getChanges([]); await engine.operator!.getChanges([]); }), 1);
  assert.equal(expiries[0]! - Math.floor(network.now() / 1000), 14 * 60);
  assert.equal(await issued(async () => { await engine.operator!.listInboxWriters("at://w"); await engine.operator!.listInboxWriters("at://w"); }), 2);
  network.advanceClock(13.5 * 60 * 1000);
  assert.equal(await issued(() => engine.operator!.getChanges([])), 1, "renewed a minute before it runs out");
});

test("a round that could not finish waits before returning, so the next poll does not ask again at once; going away ends the wait", async () => {
  const operator = scriptedOperator([answer("1"), answer("2", { changed: [{ space: SPACE, cursor: "2" }] }), answer("2", { changed: [{ space: SPACE, cursor: "2" }] })]);
  let failing = false;
  const follower = new ChangeFollower({
    operator, credentials: { fresh: async () => ({}) as never }, retryDelayMs: 300,
    sync: async () => { if (failing) throw new Error("its host is down"); },
  });
  await follower.follow(SPACE);
  failing = true;
  let started = Date.now();
  await follower.poll();
  assert.ok(Date.now() - started >= 250, "a failed sync waits");
  const gone = new AbortController();
  setTimeout(() => gone.abort(), 50);
  started = Date.now();
  await follower.poll(gone.signal);
  assert.ok(Date.now() - started < 250);
});

test("a round that leaves a denied space followed waits too, since the operator answers such a call at once", async () => {
  const operator = scriptedOperator([answer("1"), answer("2", { denied: [SPACE] })]);
  const follower = new ChangeFollower({
    operator, retryDelayMs: 300, sync: async () => undefined,
    credentials: { fresh: async () => { throw Object.assign(new Error("its host is down"), { status: 503 }); } },
  });
  await follower.follow(SPACE);
  const started = Date.now();
  await follower.poll();
  assert.ok(Date.now() - started >= 250);
  assert.deepEqual(follower.following, [SPACE]);
});
