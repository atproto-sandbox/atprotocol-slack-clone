import assert from "node:assert/strict";
import test from "node:test";
import type { ChangesAnswer } from "./operator-client";
import { LiveSpaces, Snapshots } from "./views";

// The engine's views for the UI: snapshots per key with a subscription, kept live by the change feed.

const GENERAL = "at://did:plc:owner/space/new.flock.channel/acme-general";
const RANDOM = "at://did:plc:owner/space/new.flock.channel/acme-random";
const answer = (head: string, parts: Partial<ChangesAnswer> = {}): ChangesAnswer => ({ head, changed: [], denied: [], reset: [], ...parts });

test("a snapshot keeps its identity until its key changes, keeps the last value while loading, and keeps it on an error", async () => {
  const snapshots = new Snapshots();
  const seen: unknown[] = [];
  snapshots.subscribe("k", () => seen.push(snapshots.get("k")));
  assert.equal(snapshots.get("k"), snapshots.get("k"));
  await snapshots.refresh("k", async () => 1);
  const loaded = snapshots.get<number>("k");
  assert.deepEqual(loaded, { value: 1, error: undefined, loading: false });
  assert.equal(snapshots.get("k"), loaded, "the same object until something changes");
  await snapshots.refresh("k", async () => { throw new Error("its host is down"); });
  assert.equal(snapshots.get<number>("k").value, 1);
  assert.match(String(snapshots.get("k").error), /host is down/);
  assert.deepEqual(seen.map((snapshot) => (snapshot as { loading: boolean }).loading), [true, false, true, false]);
});

test("refreshes asked for while one runs are folded into one more run, which answers the last ask", async () => {
  const snapshots = new Snapshots();
  let calls = 0;
  let release!: () => void;
  const load = () => {
    calls += 1;
    return calls === 1 ? new Promise<number>((resolve) => { release = () => resolve(1); }) : Promise.resolve(calls);
  };
  const first = snapshots.refresh("k", load);
  void snapshots.refresh("k", load);
  void snapshots.refresh("k", load);
  release();
  await first;
  assert.equal(calls, 2, "two asks during the first run make one more run, not two");
  assert.equal(snapshots.get<number>("k").value, 2);
});

/** An operator that answers from a queue, then holds every later call until the test is done. */
function scriptedOperator(answers: ChangesAnswer[]) {
  return {
    getChanges: (_follow: unknown, signal?: AbortSignal) => {
      const next = answers.shift();
      if (next) return Promise.resolve(next);
      return new Promise<ChangesAnswer>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    },
  };
}

test("a watched key is loaded once when its space is first followed, and again when the feed says the space changed", async () => {
  const snapshots = new Snapshots();
  let loads = 0;
  const live = new LiveSpaces(snapshots, { operator: scriptedOperator([answer("1"), answer("2", { changed: [{ space: GENERAL, cursor: "2" }] })]), credentials: { fresh: async () => ({}) as never } });
  await live.watch("channel", [GENERAL], async () => ++loads);
  assert.equal(loads, 1, "following the space is what loaded it");
  live.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  live.stop();
  assert.equal(loads, 2);
  assert.equal(snapshots.get<number>("channel").value, 2);
});

test("a key whose spaces are already followed is loaded directly, and a space nothing watches any more is no longer followed", async () => {
  const snapshots = new Snapshots();
  const asked: string[][] = [];
  const operator = {
    getChanges: (follow: ReadonlyArray<{ space: string }>, signal?: AbortSignal) => {
      asked.push(follow.map((entry) => entry.space));
      if (follow.length === 0) return Promise.resolve(answer("1"));
      return new Promise<ChangesAnswer>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    },
  };
  const live = new LiveSpaces(snapshots, { operator, credentials: { fresh: async () => ({}) as never } });
  const stopGeneral = await live.watch("general", [GENERAL], async () => "general");
  await live.watch("both", [GENERAL], async () => "both");
  assert.equal(snapshots.get("both").value, "both");
  assert.equal(asked.length, 1, "only the first watch read head");
  const stopRandom = await live.watch("random", [RANDOM], async () => "random");
  stopGeneral();
  stopRandom();
  assert.equal(snapshots.get("general").value, "general", "what was loaded stays until the UI forgets it");
  live.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  live.stop();
  assert.deepEqual(asked.at(-1), [GENERAL], "the poll follows the space still watched, not the one nothing reads");
});

test("a watched key is loaded while the operator cannot be reached, and its space is followed once the operator answers", async () => {
  // #given an operator that refuses the first call, then answers
  const snapshots = new Snapshots();
  let refusals = 1;
  const followed: string[][] = [];
  const operator = {
    getChanges: async (follow: ReadonlyArray<{ space: string }>, signal?: AbortSignal) => {
      if (refusals-- > 0) throw new Error("operator unreachable");
      followed.push(follow.map((entry) => entry.space));
      if (follow.length === 0) return answer("1");
      return new Promise<ChangesAnswer>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    },
  };
  const live = new LiveSpaces(snapshots, { operator, credentials: { fresh: async () => ({}) as never }, retryDelayMs: 0 });
  let loads = 0;

  // #when the key is watched and the poll loop runs
  await live.watch("inbox", [GENERAL], async () => ++loads);
  const loadedWithoutOperator = snapshots.get<number>("inbox").value;
  live.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  live.stop();

  // #then the key was loaded at once, and the loop followed its space and then polled it
  assert.deepEqual({ loadedWithoutOperator, followed }, { loadedWithoutOperator: 1, followed: [[], [GENERAL]] });
});

test("a refresh folded into a running one runs with the loader last asked for", async () => {
  // #given a load in flight for a key
  const snapshots = new Snapshots();
  let release!: () => void;
  const first = snapshots.refresh("k", () => new Promise<string>((resolve) => { release = () => resolve("first"); }));

  // #when another refresh with a different loader is asked for while it runs
  void snapshots.refresh("k", async () => "latest");
  release();
  await first;

  // #then the folded run used the later loader
  assert.equal(snapshots.get<string>("k").value, "latest");
});

test("a key reading two spaces it does not follow yet is loaded once, from one head", async () => {
  // #given an operator answering a head, then holding every poll
  const snapshots = new Snapshots();
  const asked: number[] = [];
  const operator = {
    getChanges: (follow: ReadonlyArray<unknown>, signal?: AbortSignal) => {
      asked.push(follow.length);
      if (follow.length === 0) return Promise.resolve(answer("1"));
      return new Promise<ChangesAnswer>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    },
  };
  const live = new LiveSpaces(snapshots, { operator, credentials: { fresh: async () => ({}) as never } });
  let loads = 0;

  // #when a key over two unfollowed spaces is watched
  await live.watch("conversation", [GENERAL, RANDOM], async () => ++loads);

  // #then it was loaded once after a single head read
  assert.deepEqual({ loads, asked }, { loads: 1, asked: [0] });
});

test("stopping a watch that a later watch of the same key replaced leaves the later one in place", async () => {
  // #given a first watch whose follow is still waiting on the operator
  const snapshots = new Snapshots();
  let answerHead!: () => void;
  let heads = 0;
  const operator = {
    getChanges: (follow: ReadonlyArray<unknown>) => {
      if (follow.length > 0) return new Promise<ChangesAnswer>(() => undefined);
      heads += 1;
      return heads === 1 ? new Promise<ChangesAnswer>((resolve) => { answerHead = () => resolve(answer("1")); }) : Promise.resolve(answer("2"));
    },
  };
  const live = new LiveSpaces(snapshots, { operator, credentials: { fresh: async () => ({}) as never } });
  const loaded: string[] = [];
  const firstWatch = live.watch("inbox", [GENERAL], async () => loaded.push("first"));

  // #when a second watch replaces it, and the first one's stop runs after its follow ends
  const stopSecond = await live.watch("inbox", [GENERAL], async () => loaded.push("second"));
  answerHead();
  (await firstWatch)();
  await live.reload("inbox");

  // #then the key is still watched with the second loader
  assert.equal(loaded.at(-1), "second");
  stopSecond();
});

test("a poll held when a new space is followed is asked again with that space in it", async () => {
  // #given a live view following one space, its poll held by the operator
  const snapshots = new Snapshots();
  const polls: string[][] = [];
  const operator = {
    getChanges: (follow: ReadonlyArray<{ space: string }>, signal?: AbortSignal) => {
      if (follow.length === 0) return Promise.resolve(answer("1"));
      polls.push(follow.map((entry) => entry.space));
      return new Promise<ChangesAnswer>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    },
  };
  const live = new LiveSpaces(snapshots, { operator, credentials: { fresh: async () => ({}) as never }, retryDelayMs: 10_000 });
  await live.watch("general", [GENERAL], async () => "general");
  live.start();
  await new Promise((resolve) => setTimeout(resolve, 10));

  // #when another space is followed while that poll is held
  await live.watch("random", [RANDOM], async () => "random");
  await new Promise((resolve) => setTimeout(resolve, 10));
  live.stop();

  // #then the operator was asked again, at once, with both spaces
  assert.deepEqual(polls, [[GENERAL], [GENERAL, RANDOM]]);
});

test("the live loop waits the configured delay before asking an unreachable operator again", async () => {
  // #given an operator that is never reachable for polls, and a one-millisecond delay between attempts
  const snapshots = new Snapshots();
  let polls = 0;
  const operator = {
    getChanges: async (follow: ReadonlyArray<unknown>) => {
      if (follow.length === 0) return answer("1");
      polls += 1;
      throw new Error("operator unreachable");
    },
  };
  const live = new LiveSpaces(snapshots, { operator, credentials: { fresh: async () => ({}) as never }, retryDelayMs: 1 });
  await live.watch("general", [GENERAL], async () => "general");

  // #when the loop runs briefly
  live.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  live.stop();

  // #then it asked again and again, not once per five seconds
  assert.ok(polls > 3, `asked ${polls} times`);
});
