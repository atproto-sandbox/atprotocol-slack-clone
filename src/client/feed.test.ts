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
  await follower.follow([SPACE]);
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
  await follower.follow([SPACE]);
  failing = false;
  await follower.follow([other]);
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
  await follower.follow([fixture.workspace]);
  await network.clientFor(AUTHORITY).procedure("com.atproto.space.deleteSpace", { space: fixture.workspace });
  const result = await follower.poll();
  assert.deepEqual(result.unfollowed, [fixture.workspace]);
  assert.deepEqual(follower.following, []);
  assert.deepEqual(await alice.sync.store.records(fixture.channels.general!, COLLECTION.message), [], "the workspace's channel went with it");
});

test("a denied space whose credential is refused only for now stays followed; one whose access is back is followed again from head after the wait", async () => {
  // #given a followed space the operator denies twice, while its credential first fails for now and then mints
  const synced: string[] = [];
  let mint: () => Promise<unknown> = async () => { throw Object.assign(new Error("its host is down"), { status: 503 }); };
  const operator = scriptedOperator([answer("1"), answer("2", { denied: [SPACE] }), answer("3", { denied: [SPACE] }), answer("4"), answer("5")]);
  const follower = new ChangeFollower({ operator, credentials: { fresh: async () => mint() as never }, sync: async (space) => { synced.push(space); }, retryDelayMs: 0, refollowDelayMs: 0 });
  await follower.follow([SPACE]);

  // #when the first denial meets a passing failure
  assert.deepEqual(await follower.poll(), { synced: [], unfollowed: [], failed: [] });
  assert.deepEqual(follower.following, [SPACE], "a passing failure keeps the space followed");

  // #when the second denial meets access that is back, and the wait is over by the next poll
  mint = async () => ({});
  assert.deepEqual((await follower.poll()).synced, [], "access back is not followed again within the same poll");
  const next = await follower.poll();

  // #then the space was followed again from a new head and synced
  assert.deepEqual(next.synced, [SPACE]);
  assert.deepEqual(operator.asked.at(-2), [], "regained access starts again from head");
  assert.equal(synced.length, 2);
});

test("a space the operator keeps denying while the account can read it is not asked about again until the wait is over", async () => {
  // #given an operator that denies a space the account can still read, and a one-minute wait
  const operator = scriptedOperator([answer("1"), answer("2", { denied: [SPACE] })]);
  const follower = new ChangeFollower({ operator, credentials: { fresh: async () => ({}) as never }, sync: async () => undefined, retryDelayMs: 0, refollowDelayMs: 60_000 });
  await follower.follow([SPACE]);
  await follower.poll();
  const controller = new AbortController();

  // #when the next poll runs and is abandoned while it waits
  const waiting = follower.poll(controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 50));
  controller.abort();
  await waiting;

  // #then the operator was asked nothing more, and the space stays followed
  assert.equal(operator.asked.length, 2);
  assert.deepEqual(follower.following, [SPACE]);
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
  await follower.follow([SPACE]);
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
  await follower.follow([SPACE]);
  const started = Date.now();
  await follower.poll();
  assert.ok(Date.now() - started >= 250 && Date.now() - started < 2_000, "it waits the configured delay, not the default");
  assert.deepEqual(follower.following, [SPACE]);
});

test("a space unfollowed while a poll was held is not followed again by that poll's answer", async () => {
  // #given a followed space whose poll answer names it as changed
  let release!: () => void;
  const synced: string[] = [];
  const operator = {
    getChanges: async (follow: ReadonlyArray<{ space: string }>) => {
      if (follow.length === 0) return answer("1");
      await new Promise<void>((resolve) => { release = resolve; });
      return answer("2", { changed: [{ space: SPACE, cursor: "2" }] });
    },
  };
  const follower = new ChangeFollower({ operator, credentials: { fresh: async () => ({}) as never }, sync: async (space) => { synced.push(space); }, retryDelayMs: 0 });
  await follower.follow([SPACE]);
  synced.length = 0;

  // #when the space is unfollowed before the answer arrives
  const polled = follower.poll();
  await new Promise((resolve) => setTimeout(resolve, 0));
  follower.unfollow(SPACE);
  release();
  const result = await polled;

  // #then nothing synced it and it stays unfollowed
  assert.deepEqual({ synced, result: result.synced, following: follower.following }, { synced: [], result: [], following: [] });
});

test("unfollowing a space waiting to be followed again after a denial forgets it", async () => {
  // #given a space the operator denied though the account can read it
  const operator = scriptedOperator([answer("1"), answer("2", { denied: [SPACE] })]);
  const follower = new ChangeFollower({ operator, credentials: { fresh: async () => ({}) as never }, sync: async () => undefined, retryDelayMs: 0 });
  await follower.follow([SPACE]);
  await follower.poll();
  assert.deepEqual(follower.following, [SPACE], "deferred spaces count as followed");

  // #when it is unfollowed
  follower.unfollow(SPACE);

  // #then it is no longer followed, deferred or not
  assert.deepEqual(follower.following, []);
});

test("a space unfollowed while it was being followed is not followed when that follow ends", async () => {
  // #given a follow whose load is still running
  let release!: () => void;
  const follower = new ChangeFollower({ operator: scriptedOperator([answer("1")]), credentials: { fresh: async () => ({}) as never }, sync: async () => undefined });
  const following = follower.follow([SPACE], () => new Promise<void>((resolve) => { release = resolve; }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(follower.following, [SPACE], "a follow under way counts as following");

  // #when the space is unfollowed before the load ends
  follower.unfollow(SPACE);
  release();
  await following;

  // #then the follow left it unfollowed
  assert.deepEqual(follower.following, []);
});

/** An operator whose answers are given one at a time by the test, recording what it was asked. */
function steppedOperator() {
  const asked: Array<Array<{ space: string; after: string }>> = [];
  const waiting: Array<{ resolve: (answer: ChangesAnswer) => void; reject: (error: Error) => void }> = [];
  return {
    asked,
    getChanges: (follow: ReadonlyArray<{ space: string; after: string }>) => {
      asked.push([...follow]);
      return new Promise<ChangesAnswer>((resolve, reject) => waiting.push({ resolve, reject }));
    },
    answer: async (next: ChangesAnswer) => { await until(() => waiting.length > 0); waiting.shift()!.resolve(next); },
    fail: async (error: Error) => { await until(() => waiting.length > 0); waiting.shift()!.reject(error); },
  };
}

async function until(check: () => boolean): Promise<void> {
  while (!check()) await new Promise((resolve) => setTimeout(resolve, 0));
}

test("a space unfollowed while its change was being synced stays unfollowed", async () => {
  // #given a followed space whose next sync is held
  const operator = steppedOperator();
  let hold = false;
  let release!: () => void;
  const follower = new ChangeFollower({ operator, credentials: { fresh: async () => ({}) as never }, retryDelayMs: 0, sync: async () => {
    if (hold) await new Promise<void>((resolve) => { release = resolve; });
  } });
  const followed = follower.follow([SPACE]);
  await operator.answer(answer("1"));
  await followed;
  hold = true;
  const polled = follower.poll();
  await operator.answer(answer("2", { changed: [{ space: SPACE, cursor: "2" }] }));

  // #when it is unfollowed during that sync
  await until(() => release !== undefined);
  follower.unfollow(SPACE);
  release();
  const result = await polled;

  // #then the answer did not follow it again
  assert.deepEqual({ synced: result.synced, following: follower.following }, { synced: [], following: [] });
});

test("a denial whose mint ends after the space was followed afresh leaves the new follow in place", async () => {
  // #given a followed space the operator denies, while the account's mint is held
  const operator = steppedOperator();
  let release!: () => void;
  const follower = new ChangeFollower({ operator, retryDelayMs: 0, sync: async () => undefined, credentials: { fresh: () => new Promise((resolve) => { release = () => resolve({} as never); }) } });
  const first = follower.follow([SPACE]);
  await operator.answer(answer("1"));
  await first;
  const polled = follower.poll();
  await operator.answer(answer("2", { denied: [SPACE] }));
  await until(() => release !== undefined);

  // #when it is unfollowed and followed again before the mint ends
  follower.unfollow(SPACE);
  const again = follower.follow([SPACE]);
  await operator.answer(answer("3"));
  await again;
  release();
  await polled;

  // #then the next poll still follows it from the new head, not deferred by the old denial
  const next = follower.poll();
  await until(() => operator.asked.length === 4);
  assert.deepEqual(operator.asked.at(-1), [{ space: SPACE, after: "3" }]);
  await operator.answer(answer("4"));
  await next;
});

test("a deferred space unfollowed while it was being followed again is not deferred again when that follow fails", async () => {
  // #given a space deferred after a denial, due to be followed again
  const operator = steppedOperator();
  const follower = new ChangeFollower({ operator, retryDelayMs: 0, refollowDelayMs: 0, sync: async () => undefined, credentials: { fresh: async () => ({}) as never } });
  const first = follower.follow([SPACE]);
  await operator.answer(answer("1"));
  await first;
  const denied = follower.poll();
  await operator.answer(answer("2", { denied: [SPACE] }));
  await denied;

  // #when the next poll's follow of it is under way, it is unfollowed, and the follow fails
  const refollowing = follower.poll();
  await until(() => operator.asked.length === 3);
  follower.unfollow(SPACE);
  await operator.fail(new Error("operator unreachable"));
  await refollowing;

  // #then nothing follows it any more
  assert.deepEqual(follower.following, []);
});
