import assert from "node:assert/strict";
import test from "node:test";
import { tidNow } from "@flock/protocol/keys";
import { KeyWindow, type WindowClock, type WindowItem, type WindowPage } from "./key-window";
import type { SetAside } from "./sync";

const SPACE = "at://did:plc:authority/space/new.flock.channel/acme-general";
const PERSON = "did:plc:person";
const PAGE = 3;

let seq = 0;
const keyAt = (at: number) => tidNow(at, (seq += 1) % 1024);

type Item = WindowItem & { text: string };

function item(repo: string, text: string, at: number, collection = "new.flock.channel.message"): Item {
  const rkey = keyAt(at);
  return { uri: `${SPACE}/${repo}/${collection}/${rkey}`, repo, rkey, text };
}

function testClock(): { clock: WindowClock & { wall: number; passed: number }; advance: (ms: number) => void } {
  const clock = { wall: Date.now(), passed: 0, now: () => clock.wall, elapsed: () => clock.passed };
  return { clock, advance: (ms: number) => { clock.wall += ms; clock.passed += ms; } };
}

function harness(customClock?: WindowClock & { wall: number }) {
  const { clock } = customClock ? { clock: customClock } : testClock();
  const state = {
    items: [] as Item[],
    secondary: [] as Item[],
    incomplete: false,
    setAside: [] as SetAside[],
    failing: new Set<string>(),
  };
  const given: Item[] = [];
  const errors: unknown[] = [];
  const window = new KeyWindow(clock, (error) => errors.push(error));
  const pageFrom = (list: Item[]) => async (options: { before: string }): Promise<WindowPage<Item>> => {
    const bound = options.before.split(" ")[0];
    const older = [...list]
      .sort((left, right) => left.rkey.localeCompare(right.rkey))
      .filter((entry) => bound === undefined || entry.rkey < bound);
    const onPage = older.slice(-PAGE);
    const next = older.length > PAGE ? { next: `${onPage[0]!.rkey} ${onPage[0]!.uri}` } : {};
    return { items: onPage.reverse(), ...next, complete: !state.incomplete, setAside: state.setAside };
  };
  const read = (deliver: boolean, twoStreams = false) =>
    window.read({
      space: SPACE,
      deliver,
      labels: { items: "messages", space: "channel" },
      streams: twoStreams ? [pageFrom(state.items), pageFrom(state.secondary)] : [pageFrom(state.items)],
      prepare: async () => async (entry) => {
        if (state.failing.has(entry.text)) throw new Error(`the app failed on ${entry.text}`);
        given.push(entry);
      },
    });
  return {
    clock,
    state,
    given,
    errors,
    window,
    read,
    past: (repo: string, text: string) => item(repo, text, clock.wall - 60_000),
    now: (repo: string, text: string, at = clock.wall) => item(repo, text, at),
    remove: (uri: string) => { state.items = state.items.filter((entry) => entry.uri !== uri); },
    texts: () => given.map((entry) => entry.text),
  };
}

test("gives each new item once, oldest first, and nothing that was already there when following started", async () => {
  const h = harness();
  h.state.items.push(h.past(PERSON, "before"));
  await h.read(false);

  h.state.items.push(h.now(PERSON, "one"), h.now(PERSON, "two"));
  await h.read(true);
  await h.read(true);

  assert.deepEqual(h.texts(), ["one", "two"]);
});

test("merges two streams (commands and actions) in chronological key order without losing bursts on either stream", async () => {
  const h = harness();
  await h.read(false, true);

  const c1 = item(PERSON, "cmd-1", h.clock.wall, "new.flock.app.command");
  const a1 = item(PERSON, "act-1", h.clock.wall + 10, "new.flock.app.action");
  const c2 = item(PERSON, "cmd-2", h.clock.wall + 20, "new.flock.app.command");
  h.state.items.push(c1, c2);
  h.state.secondary.push(a1);
  await h.read(true, true);

  assert.deepEqual(h.texts(), ["cmd-1", "act-1", "cmd-2"]);
});

test("a burst bigger than a page is given whole, and one beyond the five-page bound is reported once", async () => {
  const h = harness();
  h.state.items.push(h.past(PERSON, "before"));
  await h.read(false);

  h.state.items.push(...Array.from({ length: 7 }, (_, index) => h.now(PERSON, `m${index}`)));
  await h.read(true);
  assert.deepEqual(h.texts(), ["m0", "m1", "m2", "m3", "m4", "m5", "m6"]);

  h.state.items.push(...Array.from({ length: 17 }, (_, index) => h.now(PERSON, `b${index}`)));
  await h.read(true);
  assert.equal(h.texts().filter((text) => text.startsWith("b")).length, 15);
  assert.match(String(h.errors.at(-1)), /More than 5 pages of new messages/);
});

test("an item the handler fails on is reported, does not hold back later items, and is given up after three attempts", async () => {
  const h = harness();
  await h.read(false);
  h.state.failing.add("poison");
  h.state.items.push(h.now(PERSON, "poison"), h.now(PERSON, "later"));
  await h.read(true);
  assert.deepEqual(h.texts(), ["later"]);
  assert.match(String(h.errors[0]), /failed on poison/);

  for (let round = 0; round < 4; round += 1) await h.read(true);
  assert.equal(h.errors.filter((error) => /failed on poison/.test(String(error))).length, 3);
  assert.match(String(h.errors.at(-1)), /3 times; it is not given again/);
});

test("a burst whose newest page fails is not given twice when it recovers, nor anything from before it", async () => {
  const h = harness();
  h.state.items.push(h.past(PERSON, "old-before"));
  await h.read(false);
  for (const text of ["m3", "m4", "m5"]) h.state.failing.add(text);
  h.state.items.push(...Array.from({ length: 6 }, (_, index) => h.now(PERSON, `m${index}`)));
  await h.read(true);

  h.state.failing.clear();
  await h.read(true);
  assert.deepEqual(h.texts().sort(), ["m0", "m1", "m2", "m3", "m4", "m5"]);
});

test("a deleted item lets no older one slide onto the page and be answered", async () => {
  const h = harness();
  const old = Array.from({ length: 5 }, (_, index) => h.past(PERSON, `old${index}`));
  h.state.items.push(...old);
  await h.read(false);

  h.remove(old[4]!.uri);
  await h.read(true);
  h.remove(old[3]!.uri);
  await h.read(true);
  await h.read(true);
  assert.deepEqual(h.texts(), []);

  h.state.items.push(h.now(PERSON, "new"));
  await h.read(true);
  assert.deepEqual(h.texts(), ["new"]);
});

test("a first read without a writer takes none of that writer's history for new when its host comes back", async () => {
  const h = harness();
  const first = h.past(PERSON, "first");
  const history = Array.from({ length: 3 }, (_, index) => h.past("did:plc:downwriter", `history${index}`));
  const second = h.past(PERSON, "second");
  h.state.items.push(first, second);
  h.state.incomplete = true;
  await h.read(false);

  h.state.incomplete = false;
  h.state.items = [first, ...history, second];
  await h.read(true);
  h.state.items.push(h.now(PERSON, "after"));
  await h.read(true);
  assert.deepEqual(h.texts(), ["after"]);
});

test("a first read of an empty space without a writer takes none of that writer's history for new either", async () => {
  const h = harness();
  h.state.incomplete = true;
  await h.read(false);
  h.state.incomplete = false;
  h.state.items.push(h.past("did:plc:downwriter", "history"));
  await h.read(true);
  h.state.items.push(h.now(PERSON, "after"));
  await h.read(true);
  assert.deepEqual(h.texts(), ["after"]);
});

test("a flood of items keyed in the future neither silences the space nor triggers a burst warning", async () => {
  const h = harness();
  await h.read(false);
  const ahead = Array.from({ length: 30 }, (_, index) => h.now(PERSON, `ahead${index}`, h.clock.wall + 3_600_000));
  h.state.items.push(...ahead, h.now(PERSON, "now"));
  await h.read(true);
  assert.deepEqual(h.texts(), ["now"]);
  assert.deepEqual(h.errors, []);

  for (const entry of ahead) h.remove(entry.uri);
  h.state.items.push(h.now(PERSON, "later"));
  await h.read(true);
  assert.deepEqual(h.texts(), ["now", "later"]);
});

test("a burst written just before following started is not answered", async () => {
  const h = harness();
  h.state.items.push(...Array.from({ length: 8 }, (_, index) => h.now(PERSON, `recent${index}`, h.clock.wall - 2_000)));
  await h.read(false);
  h.state.items.push(h.now(PERSON, "after"));
  await h.read(true);
  assert.deepEqual(h.texts(), ["after"]);
});

test("a writer whose host was down has what it wrote meanwhile given when it comes back", async () => {
  const { clock, advance } = testClock();
  const h = harness(clock);
  const followedAt = clock.wall;
  await h.read(false);
  advance(200);
  h.state.incomplete = true;
  h.state.items.push(h.now(PERSON, "while down"));
  await h.read(true);

  const meanwhile = h.now("did:plc:downwriter", "written while its host was down", followedAt - 5_000 + 100);
  h.state.incomplete = false;
  h.state.items.push(meanwhile);
  await h.read(true);
  assert.deepEqual(h.texts(), ["while down", "written while its host was down"]);
});

test("an item the app failed on and that is then deleted holds the window for ten minutes at most", async () => {
  const { clock, advance } = testClock();
  const h = harness(clock);
  await h.read(false);
  h.state.failing.add("poison");
  const poison = h.now(PERSON, "poison", clock.wall);
  h.state.items.push(poison);
  await h.read(true);
  h.remove(poison.uri);

  for (let minute = 1; minute <= 60; minute += 1) {
    advance(60_000);
    h.state.items.push(h.now(PERSON, `m${minute}`, clock.wall));
    await h.read(true);
  }
  assert.equal(h.texts().length, 60);
  assert.ok(h.errors.some((error) => /has not been read again for 10 minutes/.test(String(error))));
  assert.equal(h.errors.filter((error) => /More than 5 pages/.test(String(error))).length, 0);
});

test("a jump of the app's wall clock carries the window no further than the monotonic time that passed", async () => {
  const { clock, advance } = testClock();
  const h = harness(clock);
  await h.read(false);

  advance(1_000);
  clock.wall += 3_600_000;
  await h.read(true);
  clock.wall -= 3_600_000;
  advance(60_000);
  h.state.items.push(h.now(PERSON, "a minute later", clock.wall));
  await h.read(true);

  assert.deepEqual(h.texts(), ["a minute later"]);
});

test("a passing writer is reported once per read regardless of pages, and a permanent set-aside writer is reported once and does not hold the window", async () => {
  const { clock, advance } = testClock();
  const h = harness(clock);
  await h.read(false);
  h.state.items.push(...Array.from({ length: 10 }, (_, index) => h.now(PERSON, `burst${index}`, clock.wall)));
  h.state.setAside = [
    { did: "did:plc:down", reason: "host unreachable", permanent: false },
    { did: "did:plc:gone", reason: "repo taken down", permanent: true },
  ];
  await h.read(true);
  await h.read(true);
  assert.equal(h.errors.filter((error) => /read without 1 writer/.test(String(error))).length, 2);
  assert.equal(h.errors.filter((error) => /did:plc:gone's messages cannot be read/.test(String(error))).length, 1);

  h.state.setAside = [{ did: "did:plc:gone", reason: "repo taken down", permanent: true }];
  advance(60_000);
  await h.read(true);
  h.state.items.push(h.now(PERSON, "late", clock.wall - 30_000));
  await h.read(true);
  assert.equal(h.texts().includes("late"), false, "permanent set-aside writer held nothing back");
});
