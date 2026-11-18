import assert from "node:assert/strict";
import test from "node:test";
import { SpaceCredentialError } from "@flock/protocol/atproto/space-credential-core";
import { memberspacePolicy } from "@flock/protocol/atproto/space-policy";
import { appInboxSkey, appInboxUri, channelUri, spaceRecordUri, tidNow } from "@flock/protocol/keys";
import { COLLECTION, SPACE_TYPE } from "@flock/protocol/nsids";
import { FakeNetwork } from "@flock/testing/fake-network";
import { AppAccessLostError, AppRuntime, publishAppDeclaration, type AppAction, type AppCommand, type AppMessage } from "./app-runtime";
import { actionsBlock, button, sectionBlock } from "./blocks";
import type { ChannelMessage, ChannelPage, ChannelRef } from "./channel-client";
import { createEngine } from "./engine";
import { createWorkspace, key, transportFor, writeMessage } from "./testing/engine-fixture";

const AUTHORITY = "did:plc:authority";
const APP = "did:plc:app";
const OTHER_APP = "did:plc:otherapp";
const PERSON = "did:plc:person";
const WORKSPACE = `at://${AUTHORITY}/space/new.flock.workspace/acme`;
const GENERAL = `at://${AUTHORITY}/space/new.flock.channel/acme-general`;
const SECRET = `at://${AUTHORITY}/space/new.flock.channel/acme-secret`;
const PAGE = 3;

let clock = 0;
/** A real TID for a message written at `at`, as its writer's clock would make it. */
const keyAt = (at: number) => tidNow(at, (clock += 1) % 1024);
const message = (repo: string, text: string, at = Date.now()): ChannelMessage => {
  const rkey = keyAt(at);
  return { uri: `${GENERAL}/${repo}/new.flock.channel.message/${rkey}`, repo, rkey, value: { text } };
};
/** A message written a minute before the test's app ran. */
const past = (repo: string, text: string) => message(repo, text, Date.now() - 60_000);

type Installs = Array<{ did: string; channels: Array<{ skey: string; write: boolean }> }>;

/** A workspace, its installs and its channels' messages as the app reads them (pages of three), and the feed as a script. */
function fakeApp(installs: Installs, delays: { refollowDelayMs?: number; retryDelayMs?: number; clock?: { now(): number; elapsed(): number } } = {}) {
  const state = {
    installs,
    channels: new Map<string, ChannelMessage[]>([["acme-general", []], ["acme-secret", []]]),
    failingReads: new Set<string>(),
    incomplete: false,
    setAside: [] as Array<{ did: string; reason: string; permanent: boolean }>,
    refusal: null as unknown,
    /** How many of the next workspace reads fail as a passing failure. */
    failingSummaries: 0,
    summaries: 0,
    /** The workspace's people (its active roster). */
    members: [PERSON],
    denied: [] as string[],
    lost: new Set<string>(),
    getChanges: 0,
  };
  const answers: string[][] = [];
  const given: AppMessage[] = [];
  const errors: unknown[] = [];
  const failing = new Set<string>();
  const runtime = new AppRuntime({
    did: APP,
    workspaces: [WORKSPACE],
    refollowDelayMs: delays.refollowDelayMs ?? 20,
    retryDelayMs: delays.retryDelayMs ?? 10,
    ...(delays.clock ? { clock: delays.clock } : {}),
    engine: {
      workspaces: {
        summary: async () => {
          if (state.lost.has(WORKSPACE)) throw new SpaceCredentialError("lost", 403, "NotAuthorized");
          if (state.refusal) throw state.refusal;
          state.summaries += 1;
          if (state.failingSummaries > 0) {
            state.failingSummaries -= 1;
            throw new Error("the workspace could not be read");
          }
          return { installs: state.installs, members: state.members.map((did) => ({ did, active: true })) };
        },
      } as never,
      channels: {
        readPage: async (ref: ChannelRef, options: { before?: string } = {}) => {
          if (state.failingReads.has(ref.skey)) throw new Error(`${ref.skey} could not be read`);
          // Newest key first, from a (key, uri) cursor, as the engine reads a channel.
          const bound = options.before?.split(" ")[0];
          const older = [...(state.channels.get(ref.skey) ?? [])].sort((left, right) => left.rkey.localeCompare(right.rkey))
            .filter((entry) => bound === undefined || entry.rkey < bound);
          const onPage = older.slice(-PAGE);
          const next = older.length > PAGE ? { next: `${onPage[0]!.rkey} ${onPage[0]!.uri}` } : {};
          return { messages: onPage.reverse(), ...next, complete: !state.incomplete, setAside: state.setAside, degradedReasons: [] } as unknown as ChannelPage;
        },
      } as never,
      credentials: { fresh: async (space: string) => { if (state.lost.has(space)) throw new SpaceCredentialError("lost", 403, "NotAuthorized"); } } as never,
      operator: {
        getChanges: async (follow) => {
          state.getChanges += 1;
          // A follow reads the head with nothing followed; only a poll takes the next scripted answer.
          if (follow.length === 0) return { head: "9", changed: [], denied: [], reset: [] };
          const changed = answers.shift() ?? [];
          const following = (space: string) => follow.some((entry) => entry.space === space);
          return { head: "9", changed: changed.filter(following).map((space) => ({ space, cursor: "9" })), denied: state.denied.filter(following), reset: [] };
        },
      },
    },
    onMessage: async (entry) => {
      if (failing.has(String(entry.message.value.text))) throw new Error(`the app failed on ${String(entry.message.value.text)}`);
      given.push(entry);
    },
    onError: (error) => errors.push(error),
  });
  return {
    runtime, state, given, errors, failing,
    post: (skey: string, ...written: ChannelMessage[]) => state.channels.get(skey)!.push(...written),
    remove: (skey: string, uri: string) => state.channels.set(skey, state.channels.get(skey)!.filter((entry) => entry.uri !== uri)),
    change: (...spaces: string[]) => answers.push(spaces),
    texts: () => given.map((entry) => String(entry.message.value.text)),
  };
}

test("an app is given each message from a person once, oldest first, and nothing that was there when it started", async () => {
  // #given the app granted #general with write, which already holds a message
  const app = fakeApp([{ did: APP, channels: [{ skey: "acme-general", write: true }] }]);
  app.post("acme-general", past(PERSON, "before"));
  await app.runtime.poll();

  // #when a person writes twice, and the channel is reported changed twice
  app.post("acme-general", message(PERSON, "one"), message(PERSON, "two"));
  app.change(GENERAL);
  await app.runtime.poll();
  app.change(GENERAL);
  await app.runtime.poll();

  // #then the app was given the two new messages, once each, in the order they were written, where it may write
  assert.deepEqual(app.texts(), ["one", "two"]);
  assert.equal(app.given[0]!.canWrite, true);
});

test("an app is given no app's message, its own or another's", async () => {
  const app = fakeApp([{ did: APP, channels: [{ skey: "acme-general", write: true }] }, { did: OTHER_APP, channels: [{ skey: "acme-general", write: true }] }]);
  await app.runtime.poll();
  app.post("acme-general", message(APP, "echo: hello"), message(OTHER_APP, "beep"), message(PERSON, "hi"));
  app.change(GENERAL);
  await app.runtime.poll();
  assert.deepEqual(app.texts(), ["hi"]);
});

test("an app installed since the grants were read is not given for a person, though the workspace's read failed in that poll", async () => {
  // #given the app following #general, then another app installed there that posts at once, beside a person
  const app = fakeApp([{ did: APP, channels: [{ skey: "acme-general", write: true }] }]);
  await app.runtime.poll();
  app.state.installs = [...app.state.installs, { did: OTHER_APP, channels: [{ skey: "acme-general", write: true }] }];
  app.post("acme-general", message(OTHER_APP, "beep"), message(PERSON, "hi"));

  // #when the feed reports both spaces changed and the workspace's own read fails
  app.state.failingSummaries = 1;
  app.change(WORKSPACE, GENERAL);
  await app.runtime.poll();

  // #then the new app's message is not given: the unknown author made the runtime read the grants again first
  assert.deepEqual(app.texts(), ["hi"]);
});

test("an app installed since the grants were read is not given for a person when its channel is read before its workspace", async () => {
  // #given the app following #general, then another app installed there that posts at once
  const app = fakeApp([{ did: APP, channels: [{ skey: "acme-general", write: true }] }]);
  await app.runtime.poll();
  app.state.installs = [...app.state.installs, { did: OTHER_APP, channels: [{ skey: "acme-general", write: true }] }];
  app.post("acme-general", message(OTHER_APP, "beep"));

  // #when the feed reports the channel before the workspace
  app.change(GENERAL, WORKSPACE);
  await app.runtime.poll();

  // #then nothing is given
  assert.deepEqual(app.texts(), []);
});

test("a known author costs no extra read of the workspace, and a read the refresh cannot make gives nothing until the next change", async () => {
  // #given the app following #general
  const app = fakeApp([{ did: APP, channels: [{ skey: "acme-general", write: true }] }]);
  await app.runtime.poll();
  const reads = app.state.summaries;

  // #when a person of the workspace writes
  app.post("acme-general", message(PERSON, "hi"));
  app.change(GENERAL);
  await app.runtime.poll();

  // #then it is given without reading the workspace again
  assert.deepEqual([app.texts(), app.state.summaries], [["hi"], reads]);

  // #when someone not yet known writes and the workspace cannot be read
  app.state.members = [PERSON, "did:plc:newperson"];
  app.post("acme-general", message("did:plc:newperson", "hello all"));
  app.state.failingSummaries = 1;
  app.change(GENERAL);
  await app.runtime.poll();

  // #then nothing is given yet, and the next change gives it
  assert.deepEqual(app.texts(), ["hi"]);
  app.change(GENERAL);
  await app.runtime.poll();
  assert.deepEqual(app.texts(), ["hi", "hello all"]);
});

test("a burst bigger than a page is given whole, and one beyond the pages followed back is reported", async () => {
  // #given the app following #general, which shows three messages a page
  const app = fakeApp([{ did: APP, channels: [{ skey: "acme-general", write: true }] }]);
  app.post("acme-general", past(PERSON, "before"));
  await app.runtime.poll();

  // #when seven messages arrive at once
  app.post("acme-general", ...Array.from({ length: 7 }, (_, index) => message(PERSON, `m${index}`)));
  app.change(GENERAL);
  await app.runtime.poll();

  // #then all seven are given, oldest first
  assert.deepEqual(app.texts(), ["m0", "m1", "m2", "m3", "m4", "m5", "m6"]);

  // #and a burst of more than five pages gives the newest five pages and reports the rest
  app.post("acme-general", ...Array.from({ length: 17 }, (_, index) => message(PERSON, `b${index}`)));
  app.change(GENERAL);
  await app.runtime.poll();
  assert.equal(app.texts().filter((text) => text.startsWith("b")).length, 15);
  assert.match(String(app.errors.at(-1)), /More than 5 pages of new messages/);
});

test("a message the app fails on is reported, does not hold back the next, and is given again on the next change", async () => {
  const app = fakeApp([{ did: APP, channels: [{ skey: "acme-general", write: true }] }]);
  await app.runtime.poll();
  app.failing.add("poison");
  app.post("acme-general", message(PERSON, "poison"), message(PERSON, "later"));
  app.change(GENERAL);
  await app.runtime.poll();
  assert.deepEqual(app.texts(), ["later"]);
  assert.match(String(app.errors[0]), /failed on poison/);
  app.failing.clear();
  app.change(GENERAL);
  await app.runtime.poll();
  assert.deepEqual(app.texts(), ["later", "poison"]);
});

test("an app follows a channel granted later, stops following one whose grant ended, and keeps a changed write bit", async () => {
  // #given the app granted #general with write
  const app = fakeApp([{ did: APP, channels: [{ skey: "acme-general", write: true }] }]);
  await app.runtime.poll();
  assert.deepEqual(app.runtime.following.sort(), [GENERAL, WORKSPACE].sort());

  // #when its install grants #general read only and #secret, and the workspace space changes
  app.state.installs = [{ did: APP, channels: [{ skey: "acme-general", write: false }, { skey: "acme-secret", write: true }] }];
  app.change(WORKSPACE);
  await app.runtime.poll();
  app.post("acme-general", message(PERSON, "now read only"));
  app.change(GENERAL);
  await app.runtime.poll();

  // #then it follows both, and #general's message is given to it as read only
  assert.deepEqual(app.runtime.following.sort(), [GENERAL, SECRET, WORKSPACE].sort());
  assert.deepEqual(app.given.map((entry) => [String(entry.message.value.text), entry.canWrite]), [["now read only", false]]);

  // #and once #general's grant ends it is followed no more
  app.state.installs = [{ did: APP, channels: [{ skey: "acme-secret", write: true }] }];
  app.change(WORKSPACE);
  await app.runtime.poll();
  assert.deepEqual(app.runtime.following.sort(), [SECRET, WORKSPACE].sort());
});

test("a granted channel that could not be read when it was granted holds back no other, and is followed once it can be read", async () => {
  // #given #general and #secret granted while #secret cannot be read
  const app = fakeApp([{ did: APP, channels: [] }]);
  await app.runtime.poll();
  app.state.installs = [{ did: APP, channels: [{ skey: "acme-general", write: true }, { skey: "acme-secret", write: true }] }];
  app.state.failingReads.add("acme-secret");
  app.change(WORKSPACE);
  await app.runtime.poll();
  await app.runtime.poll();
  assert.deepEqual(app.runtime.following.sort(), [GENERAL, WORKSPACE].sort(), "#general is followed all the same");
  assert.match(String(app.errors.at(-1)), /acme-secret could not be read/);

  // #when it can be read, and the retry is due
  app.state.failingReads.clear();
  await new Promise((resolve) => setTimeout(resolve, 15));
  await app.runtime.poll();

  // #then it is followed, and a message there is given
  assert.equal(app.runtime.following.includes(SECRET), true);
  app.post("acme-secret", message(PERSON, "secret"));
  app.change(SECRET);
  await app.runtime.poll();
  assert.deepEqual(app.texts(), ["secret"]);
});

test("an app that loses its workspace reports it, waits instead of asking the feed again at once, and follows it again when it can", async () => {
  // #given the app following its workspace and #general
  const app = fakeApp([{ did: APP, channels: [{ skey: "acme-general", write: true }] }]);
  await app.runtime.poll();

  // #when the feed denies both and the authority refuses them (an uninstall)
  app.state.denied = [WORKSPACE, GENERAL];
  app.state.lost = new Set([WORKSPACE, GENERAL]);
  await app.runtime.poll();
  const asked = app.state.getChanges;
  const started = Date.now();
  await app.runtime.poll();

  // #then it follows nothing, has said so, and its next round waited without asking the feed
  assert.deepEqual(app.runtime.following, []);
  assert.ok(app.errors.some((error) => error instanceof AppAccessLostError && error.space === WORKSPACE));
  assert.equal(app.state.getChanges, asked);
  assert.ok(Date.now() - started >= 15);

  // #and once it may read the workspace again (installed again), it follows it and its channel
  app.state.denied = [];
  app.state.lost.clear();
  await new Promise((resolve) => setTimeout(resolve, 25));
  await app.runtime.poll();
  assert.deepEqual(app.runtime.following.sort(), [GENERAL, WORKSPACE].sort());
});

test("a read without some writer is reported", async () => {
  const app = fakeApp([{ did: APP, channels: [{ skey: "acme-general", write: true }] }]);
  await app.runtime.poll();
  app.state.incomplete = true;
  app.change(GENERAL);
  await app.runtime.poll();
  assert.match(String(app.errors.at(-1)), /read without some writer/);
});

test("an app is told workspace URIs only", () => {
  assert.throws(() => new AppRuntime({
    did: APP, workspaces: ["https://example.com"], engine: {} as never, onMessage: async () => undefined, onError: () => undefined,
  }), /Not a workspace URI/);
});

test("an app's declaration is published when it has none or it differs, keeping when it was first made", async () => {
  const writes: Array<Record<string, unknown>> = [];
  let stored: Record<string, unknown> | null = null;
  const transport = {
    did: APP,
    memberClient: {
      query: async () => {
        if (!stored) throw Object.assign(new Error("Could not locate record"), { status: 400, code: "RecordNotFound" });
        return { value: stored };
      },
      procedure: async (_method: string, input: { record: Record<string, unknown> }) => { writes.push(input.record); stored = input.record; },
    },
  } as never;
  await publishAppDeclaration(transport, { name: "Echo" });
  await publishAppDeclaration(transport, { name: "Echo" });
  await publishAppDeclaration(transport, { name: "Echo", description: "Says it back." });
  await publishAppDeclaration(transport, { name: "Echo", description: "Says it back.", commands: [{ name: "echo", description: "Repeats text", usage: "<text>" }] });
  await publishAppDeclaration(transport, { name: "Echo", description: "Says it back.", commands: [{ name: "echo", description: "Repeats text", usage: "<text>" }] });
  assert.equal(writes.length, 3, "an unchanged declaration (commands included) is not written again");
  assert.equal(writes[1]!.createdAt, writes[0]!.createdAt);
  assert.equal(writes[1]!.description, "Says it back.");
  assert.deepEqual(writes[2]!.commands, [{ name: "echo", description: "Repeats text", usage: "<text>" }]);
});

test("a deleted message lets no older one slide onto the page and be answered", async () => {
  // #given a channel of five messages, followed (its newest page holds the last three)
  const app = fakeApp([{ did: APP, channels: [{ skey: "acme-general", write: true }] }]);
  const old = Array.from({ length: 5 }, (_, index) => past(PERSON, `old${index}`));
  app.post("acme-general", ...old);
  await app.runtime.poll();

  // #when the newest is deleted and the channel changes
  app.remove("acme-general", old[4]!.uri);
  app.change(GENERAL);
  await app.runtime.poll();

  // #then nothing is given: the message that slid onto the page was there before the app
  assert.deepEqual(app.texts(), []);
});

test("a burst whose newest page the app fails on is not given twice, nor anything from before it", async () => {
  // #given the app following #general, then a burst of six whose newest three it fails on
  const app = fakeApp([{ did: APP, channels: [{ skey: "acme-general", write: true }] }]);
  app.post("acme-general", past(PERSON, "old-before"));
  await app.runtime.poll();
  for (const text of ["m3", "m4", "m5"]) app.failing.add(text);
  app.post("acme-general", ...Array.from({ length: 6 }, (_, index) => message(PERSON, `m${index}`)));
  app.change(GENERAL);
  await app.runtime.poll();

  // #when the app recovers, and the channel changes again
  app.failing.clear();
  app.change(GENERAL);
  await app.runtime.poll();

  // #then each of the six was given once, and nothing older
  assert.deepEqual(app.texts().sort(), ["m0", "m1", "m2", "m3", "m4", "m5"]);
});

test("a message the app keeps failing on is given up after three attempts, and said so", async () => {
  const app = fakeApp([{ did: APP, channels: [{ skey: "acme-general", write: true }] }]);
  await app.runtime.poll();
  let attempts = 0;
  app.failing.add("poison");
  app.post("acme-general", message(PERSON, "poison"));
  for (let round = 0; round < 5; round += 1) {
    app.change(GENERAL);
    await app.runtime.poll();
    attempts = app.errors.filter((error) => /failed on poison/.test(String(error))).length;
  }
  assert.equal(attempts, 3);
  assert.match(String(app.errors.at(-1)), /3 times; it is not given again/);
});

test("losing the workspace takes its channels with it, and each loss is reported once", async () => {
  // #given the app following its workspace and #general
  const app = fakeApp([{ did: APP, channels: [{ skey: "acme-general", write: true }] }]);
  await app.runtime.poll();

  // #when the feed denies the workspace alone, and the authority refuses it, for several rounds
  app.state.denied = [WORKSPACE];
  app.state.lost = new Set([WORKSPACE]);
  for (let round = 0; round < 4; round += 1) {
    await app.runtime.poll();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  // #then it follows nothing of the workspace, and said so once
  assert.deepEqual(app.runtime.following, []);
  assert.deepEqual(app.errors.filter((error) => error instanceof AppAccessLostError).map((error) => (error as AppAccessLostError).space), [WORKSPACE]);
});

test("a refusal that is not the authority refusing a space is reported as it is, not as lost access", async () => {
  const app = fakeApp([{ did: APP, channels: [] }]);
  app.state.refusal = Object.assign(new Error("the operator refused the service token"), { status: 403 });
  await app.runtime.poll();
  assert.equal(app.errors.some((error) => error instanceof AppAccessLostError), false);
  assert.match(String(app.errors[0]), /operator refused the service token/);
});

test("a writer whose host may come back is reported at each read; one set aside for good is reported once", async () => {
  const app = fakeApp([{ did: APP, channels: [{ skey: "acme-general", write: true }] }]);
  await app.runtime.poll();
  app.state.setAside = [{ did: "did:plc:down", reason: "host unreachable", permanent: false }, { did: "did:plc:gone", reason: "repo taken down", permanent: true }];
  for (let round = 0; round < 2; round += 1) {
    app.change(GENERAL);
    await app.runtime.poll();
  }
  assert.equal(app.errors.filter((error) => /read without 1 writer/.test(String(error))).length, 2);
  assert.equal(app.errors.filter((error) => /did:plc:gone's messages cannot be read/.test(String(error))).length, 1);
});

test("an app that stays lost waits each round instead of asking again at once", async () => {
  // #given the app's workspace and channel both denied and refused for good
  const app = fakeApp([{ did: APP, channels: [{ skey: "acme-general", write: true }] }]);
  await app.runtime.poll();
  app.state.denied = [WORKSPACE, GENERAL];
  app.state.lost = new Set([WORKSPACE, GENERAL]);
  for (let round = 0; round < 4; round += 1) await app.runtime.poll();

  // #when it goes on, long past two of its re-follow delays
  const rounds: number[] = [];
  for (let round = 0; round < 3; round += 1) {
    const started = Date.now();
    await app.runtime.poll();
    rounds.push(Date.now() - started);
  }

  // #then every round waited
  assert.ok(rounds.every((elapsed) => elapsed >= 90), rounds.join(", "));
});

test("a deleted message lets no older one in, however often the channel changes after", async () => {
  // #given five messages, followed, and then the newest and a middle one deleted
  const app = fakeApp([{ did: APP, channels: [{ skey: "acme-general", write: true }] }]);
  const old = Array.from({ length: 5 }, (_, index) => past(PERSON, `old${index}`));
  app.post("acme-general", ...old);
  await app.runtime.poll();
  app.remove("acme-general", old[4]!.uri);
  app.change(GENERAL);
  await app.runtime.poll();
  app.remove("acme-general", old[3]!.uri);
  for (let round = 0; round < 2; round += 1) {
    app.change(GENERAL);
    await app.runtime.poll();
  }

  // #then nothing old was given, and a new message still is
  assert.deepEqual(app.texts(), []);
  app.post("acme-general", message(PERSON, "new"));
  app.change(GENERAL);
  await app.runtime.poll();
  assert.deepEqual(app.texts(), ["new"]);
});

test("a first read without a writer takes none of that writer's history for new when its host comes back", async () => {
  // #given a writer whose older messages fall between two others on the page, and whose host is down at the app's start
  const app = fakeApp([{ did: APP, channels: [{ skey: "acme-general", write: true }] }]);
  const first = past(PERSON, "first");
  const history = Array.from({ length: 3 }, (_, index) => past("did:plc:downwriter", `history${index}`));
  const second = past(PERSON, "second");
  app.post("acme-general", first, second);
  app.state.incomplete = true;
  await app.runtime.poll();

  // #when its host comes back with that history, and a person then writes
  app.state.incomplete = false;
  app.state.channels.set("acme-general", [first, ...history, second]);
  app.change(GENERAL);
  await app.runtime.poll();
  app.post("acme-general", message(PERSON, "after"));
  app.change(GENERAL);
  await app.runtime.poll();

  // #then only the new message is given
  assert.deepEqual(app.texts(), ["after"]);
});

test("a first read of an empty channel without a writer takes none of that writer's history for new either", async () => {
  const app = fakeApp([{ did: APP, channels: [{ skey: "acme-general", write: true }] }]);
  app.state.incomplete = true;
  await app.runtime.poll();
  app.state.incomplete = false;
  app.post("acme-general", past("did:plc:downwriter", "history"));
  app.change(GENERAL);
  await app.runtime.poll();
  app.post("acme-general", message(PERSON, "after"));
  app.change(GENERAL);
  await app.runtime.poll();
  assert.deepEqual(app.texts(), ["after"]);
});

test("a message keyed in the future, even deleted again, does not silence the channel", async () => {
  // #given a member who wrote messages keyed an hour ahead, seen by the app, and then deleted them
  const app = fakeApp([{ did: APP, channels: [{ skey: "acme-general", write: true }] }]);
  await app.runtime.poll();
  const ahead = Array.from({ length: 3 }, (_, index) => message(PERSON, `ahead${index}`, Date.now() + 3_600_000));
  app.post("acme-general", ...ahead);
  app.change(GENERAL);
  await app.runtime.poll();
  for (const entry of ahead) app.remove("acme-general", entry.uri);

  // #when people write after that
  app.post("acme-general", message(PERSON, "later"));
  app.change(GENERAL);
  await app.runtime.poll();

  // #then their messages are given all the same, and those keyed ahead only when their time comes
  assert.deepEqual(app.texts(), ["later"]);
});

test("a channel the app cannot follow is tried again less and less often", async () => {
  // #given a granted channel that cannot be read, a retry of 10 ms that doubles, and a cap of a second
  const app = fakeApp([{ did: APP, channels: [{ skey: "acme-general", write: true }] }], { retryDelayMs: 10, refollowDelayMs: 1_000 });
  app.state.failingReads.add("acme-general");

  // #when the app runs for 300 ms
  const started = Date.now();
  while (Date.now() - started < 300) await app.runtime.poll();

  // #then it tried at about 0, 10, 30, 70 and 150 ms, not every 10 ms
  const tries = app.errors.filter((error) => /acme-general could not be read/.test(String(error))).length;
  assert.ok(tries >= 4 && tries <= 6, `${tries} tries`);
});

test("a new message in a long channel is read from its newest page alone", async () => {
  const app = fakeApp([{ did: APP, channels: [{ skey: "acme-general", write: true }] }]);
  app.post("acme-general", ...Array.from({ length: 20 }, (_, index) => past(PERSON, `old${index}`)));
  await app.runtime.poll();
  app.post("acme-general", message(PERSON, "new"));
  app.change(GENERAL);
  await app.runtime.poll();
  assert.deepEqual(app.texts(), ["new"]);
  assert.deepEqual(app.errors, [], "no burst is reported");
});

test("an app that loses its workspace, gets it back and loses it again is told both times", async () => {
  const app = fakeApp([{ did: APP, channels: [] }]);
  await app.runtime.poll();
  for (let time = 0; time < 2; time += 1) {
    app.state.denied = [WORKSPACE];
    app.state.lost = new Set([WORKSPACE]);
    await app.runtime.poll();
    app.state.denied = [];
    app.state.lost.clear();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await app.runtime.poll();
    assert.deepEqual(app.runtime.following, [WORKSPACE]);
  }
  assert.equal(app.errors.filter((error) => error instanceof AppAccessLostError).length, 2);
});

test("a flood of messages keyed in the future hides no message a person writes now, and none of them is given before its time", async () => {
  const app = fakeApp([{ did: APP, channels: [{ skey: "acme-general", write: true }] }]);
  await app.runtime.poll();
  app.post("acme-general", ...Array.from({ length: 30 }, (_, index) => message(PERSON, `ahead${index}`, Date.now() + 3_600_000)));
  app.post("acme-general", message(PERSON, "now"));
  app.change(GENERAL);
  await app.runtime.poll();
  assert.deepEqual(app.texts(), ["now"]);
  assert.deepEqual(app.errors, [], "no burst is reported");
});

test("a burst written just before the app followed is not answered", async () => {
  const app = fakeApp([{ did: APP, channels: [{ skey: "acme-general", write: true }] }]);
  app.post("acme-general", ...Array.from({ length: 8 }, (_, index) => message(PERSON, `recent${index}`, Date.now() - 2_000)));
  await app.runtime.poll();
  app.post("acme-general", message(PERSON, "after"));
  app.change(GENERAL);
  await app.runtime.poll();
  assert.deepEqual(app.texts(), ["after"]);
});

test("a writer whose host was down has what it wrote meanwhile given when it comes back", async () => {
  // #given the app following #general, and then, a little later, a read without one writer
  const app = fakeApp([{ did: APP, channels: [{ skey: "acme-general", write: true }] }]);
  const followedAt = Date.now();
  await app.runtime.poll();
  await new Promise((resolve) => setTimeout(resolve, 200));
  app.state.incomplete = true;
  app.post("acme-general", message(PERSON, "while down"));
  app.change(GENERAL);
  await app.runtime.poll();

  // #when that writer's host is back with a message it wrote while the app was following, just inside the window's edge as it
  // stood before the read without it (a read that moved the edge on would have left it behind)
  const meanwhile = message("did:plc:downwriter", "written while its host was down", followedAt - 5_000 + 100);
  app.state.incomplete = false;
  app.post("acme-general", meanwhile);
  app.change(GENERAL);
  await app.runtime.poll();

  // #then it is given, after the message the app was given on the incomplete read
  assert.deepEqual(app.texts(), ["while down", "written while its host was down"]);
});

/** A clock a test moves: the wall clock (which can jump) and the time that really passed. */
function testClock() {
  const clock = { wall: Date.now(), passed: 0, now: () => clock.wall, elapsed: () => clock.passed };
  return { clock, advance: (ms: number) => { clock.wall += ms; clock.passed += ms; } };
}

test("a message the app failed on and that is then deleted holds the window for ten minutes at most", async () => {
  // #given the app failing once on a message that is then deleted
  const { clock, advance } = testClock();
  const app = fakeApp([{ did: APP, channels: [{ skey: "acme-general", write: true }] }], { clock });
  await app.runtime.poll();
  app.failing.add("poison");
  const poison = message(PERSON, "poison", clock.wall);
  app.post("acme-general", poison);
  app.change(GENERAL);
  await app.runtime.poll();
  app.remove("acme-general", poison.uri);

  // #when people write once a minute for an hour
  for (let minute = 1; minute <= 60; minute += 1) {
    advance(60_000);
    app.post("acme-general", message(PERSON, `m${minute}`, clock.wall));
    app.change(GENERAL);
    await app.runtime.poll();
  }

  // #then every message was given, the failed one was given up and said so, and no read went past its pages
  assert.equal(app.texts().length, 60);
  assert.ok(app.errors.some((error) => /has not been read again for 10 minutes/.test(String(error))));
  assert.equal(app.errors.filter((error) => /More than 5 pages/.test(String(error))).length, 0);
});

test("a jump of the app's clock carries the window no further than the time that passed", async () => {
  // #given the app following #general
  const { clock, advance } = testClock();
  const app = fakeApp([{ did: APP, channels: [{ skey: "acme-general", write: true }] }], { clock });
  await app.runtime.poll();

  // #when its wall clock jumps an hour ahead for one read, and is then set right
  advance(1_000);
  clock.wall += 3_600_000;
  app.change(GENERAL);
  await app.runtime.poll();
  clock.wall -= 3_600_000;
  advance(60_000);
  app.post("acme-general", message(PERSON, "a minute later", clock.wall));
  app.change(GENERAL);
  await app.runtime.poll();

  // #then the message written after the clock was set right is given
  assert.deepEqual(app.texts(), ["a minute later"]);
});

test("a read without some writer is reported once, however many pages it reads", async () => {
  const { clock } = testClock();
  const app = fakeApp([{ did: APP, channels: [{ skey: "acme-general", write: true }] }], { clock });
  await app.runtime.poll();
  app.post("acme-general", ...Array.from({ length: 10 }, (_, index) => message(PERSON, `burst${index}`, clock.wall)));
  app.state.setAside = [{ did: "did:plc:down", reason: "host unreachable", permanent: false }];
  app.change(GENERAL);
  await app.runtime.poll();
  assert.equal(app.errors.filter((error) => /read without 1 writer/.test(String(error))).length, 1);
});

test("a writer set aside for good does not hold the window", async () => {
  // #given a writer set aside for good, and a message from a person kept off the page until well after it was written
  const { clock, advance } = testClock();
  const app = fakeApp([{ did: APP, channels: [{ skey: "acme-general", write: true }] }], { clock });
  app.state.setAside = [{ did: "did:plc:gone", reason: "repo taken down", permanent: true }];
  await app.runtime.poll();
  advance(60_000);
  app.change(GENERAL);
  await app.runtime.poll();
  const late = message(PERSON, "late", clock.wall - 30_000);

  // #when it appears
  app.post("acme-general", late);
  app.change(GENERAL);
  await app.runtime.poll();

  // #then it is old, as the window moved on: the writer set aside for good held nothing back
  assert.deepEqual(app.texts(), []);
});

// --- R10b: App inbox following, optional handlers, command/action checks, and per-author throttle ----------------

async function inboxFixture(options: {
  onMessage?: boolean;
  onCommand?: boolean;
  onAction?: boolean;
  maxRecordsPerAuthor?: number;
} = {}) {
  const network = new FakeNetwork();
  let passed = 0;
  const clock = { now: () => network.now(), elapsed: () => passed };
  const advance = (ms: number) => {
    network.advanceClock(ms);
    passed += ms;
  };
  const alice = "did:plc:alice";
  const bob = "did:plc:bob2";
  const appDid = "did:plc:app2";
  const otherAppDid = "did:plc:otherapp";
  const fixture = await createWorkspace(network, {
    authority: AUTHORITY,
    members: [alice, bob],
    channels: [
      { skey: "general", visibility: "public" },
      { skey: "secret", visibility: "private", members: [alice] },
      { skey: "moving", visibility: "transitioning" },
    ],
  });
  const otherWorkspace = await createWorkspace(network, {
    authority: AUTHORITY,
    skey: "beta",
    members: [alice],
    channels: [{ skey: "general", visibility: "public" }],
  });

  network.createAccount(appDid, "pds2");
  network.createAccount(otherAppDid, "pds1");
  const owner = network.clientFor(AUTHORITY);
  const inbox = appInboxUri(AUTHORITY, "acme", appDid);
  await owner.procedure("com.atproto.space.createSpace", { spaceType: SPACE_TYPE.appInbox, skey: appInboxSkey("acme", appDid), policy: memberspacePolicy() });
  for (const space of [fixture.workspace, fixture.channels.general!, fixture.channels.secret!, otherWorkspace.workspace, otherWorkspace.channels.general!]) {
    await owner.procedure("com.atproto.memberspace.putMember", { space, did: appDid, read: true, write: true });
    await owner.procedure("com.atproto.memberspace.putMember", { space, did: otherAppDid, read: true, write: true });
  }
  await owner.procedure("com.atproto.memberspace.putMember", { space: inbox, did: appDid, read: true, write: false });
  for (const writer of [alice, bob]) {
    await owner.procedure("com.atproto.memberspace.putMember", { space: inbox, did: writer, read: false, write: true });
  }
  const { subjectKey } = await import("@flock/protocol/keys");
  const writeInstall = (did: string, active: boolean, channels: Array<{ skey: string; write: boolean }>) =>
    network.writeAs(AUTHORITY, fixture.workspace, COLLECTION.appInstall, subjectKey(did), {
      subject: did,
      active,
      channels,
      installedBy: AUTHORITY,
      installedAt: "2026-11-10T12:00:00.000Z",
      updatedAt: "2026-11-10T12:00:00.000Z",
    });
  await writeInstall(appDid, true, [
    { skey: "acme-general", write: true },
    { skey: "acme-secret", write: true },
    { skey: "acme-moving", write: true },
  ]);
  await writeInstall(otherAppDid, true, [{ skey: "acme-general", write: true }]);

  const answers: string[][] = [];
  const commands: AppCommand[] = [];
  const actions: AppAction[] = [];
  const messages: AppMessage[] = [];
  const errors: unknown[] = [];
  const appEngine = createEngine(transportFor(network, appDid));
  const runtime = new AppRuntime({
    did: appDid,
    workspaces: [fixture.workspace],
    commands: [{ name: "echo", description: "Echoes text" }],
    ...(options.maxRecordsPerAuthor ? { maxRecordsPerAuthor: options.maxRecordsPerAuthor } : {}),
    clock,
    refollowDelayMs: 20,
    retryDelayMs: 10,
    engine: {
      ...appEngine,
      operator: {
        getChanges: async (follow) => {
          if (follow.length === 0) return { head: "9", changed: [], denied: [], reset: [] };
          const changed = answers.shift() ?? [];
          const following = (space: string) => follow.some((entry) => entry.space === space);
          return { head: "9", changed: changed.filter(following).map((space) => ({ space, cursor: "9" })), denied: [], reset: [] };
        },
      },
    },
    ...(options.onMessage === false ? {} : { onMessage: async (entry) => { messages.push(entry); } }),
    ...(options.onCommand === false ? {} : { onCommand: async (entry) => { commands.push(entry); } }),
    ...(options.onAction === false ? {} : { onAction: async (entry) => { actions.push(entry); } }),
    onError: (error) => errors.push(error),
  });
  return {
    network,
    clock,
    advance,
    alice,
    bob,
    appDid,
    otherAppDid,
    fixture,
    otherWorkspace,
    inbox,
    appEngine,
    runtime,
    commands,
    actions,
    messages,
    errors,
    subjectKey,
    writeInstall,
    change: (...spaces: string[]) => answers.push(spaces),
  };
}

test("optional handlers decide what is followed: no inbox without command/action handlers, no channels without onMessage, and unfollowed on uninstall", async () => {
  const messageOnly = await inboxFixture({ onMessage: true, onCommand: false, onAction: false });
  await messageOnly.runtime.poll();
  assert.equal(messageOnly.runtime.following.includes(messageOnly.inbox), false, "no inbox followed without onCommand/onAction");

  const withoutMessage = await inboxFixture({ onMessage: false, onCommand: true, onAction: false });
  await withoutMessage.runtime.poll();
  assert.deepEqual(withoutMessage.runtime.following.sort(), [withoutMessage.fixture.workspace, withoutMessage.inbox].sort(), "no channels followed without onMessage");

  // App's own writes are kept out of its local store automatically by AppRuntime.
  await withoutMessage.appEngine.channels.send(
    { workspace: withoutMessage.fixture.workspace, skey: "acme-general" },
    "posted only",
  );
  assert.deepEqual(await withoutMessage.appEngine.sync.store.records(withoutMessage.fixture.channels.general!, COLLECTION.message), []);

  // When uninstalled, the inbox is unfollowed immediately on the workspace poll.
  await withoutMessage.writeInstall(withoutMessage.appDid, false, []);
  withoutMessage.change(withoutMessage.fixture.workspace);
  await withoutMessage.runtime.poll();
  assert.deepEqual(withoutMessage.runtime.following, [withoutMessage.fixture.workspace]);
});

test("onCommand checks declared name, fresh roster, same-workspace channel, visibility, private roster (admitting the authority), and top-level parent", async () => {
  const env = await inboxFixture({ onMessage: false });
  await env.runtime.poll();

  const aliceEngine = createEngine(transportFor(env.network, env.alice));
  const bobEngine = createEngine(transportFor(env.network, env.bob));
  const authorityEngine = createEngine(transportFor(env.network, AUTHORITY));
  const generalRef = { workspace: env.fixture.workspace, skey: "acme-general" };
  const secretRef = { workspace: env.fixture.workspace, skey: "acme-secret" };
  const movingRef = { workspace: env.fixture.workspace, skey: "acme-moving" };

  // Create a top-level message and a reply in #general for parent checks.
  const topMsg = await aliceEngine.channels.send(generalRef, "top");
  env.advance(5);
  const replyMsg = await aliceEngine.channels.send(generalRef, "reply", topMsg.uri);

  // 1. Undeclared command -> dropped.
  env.advance(5);
  await aliceEngine.appInboxes.sendCommand(generalRef, env.appDid, "undeclared", "arg");

  // 2. Private channel outsider (Bob is in the workspace but NOT on #secret's roster) -> dropped.
  env.advance(5);
  await bobEngine.appInboxes.sendCommand(secretRef, env.appDid, "echo", "sneak");

  // 3. Channel of another workspace of the same authority -> dropped.
  env.advance(5);
  await env.network.writeAs(env.alice, env.inbox, COLLECTION.appCommand, tidNow(env.clock.now()), {
    command: "echo",
    text: "cross-workspace",
    channel: channelUri(AUTHORITY, "beta-general"),
    createdAt: new Date(env.clock.now()).toISOString(),
  });

  // 4. Channel in transition -> dropped.
  env.advance(5);
  await aliceEngine.appInboxes.sendCommand(movingRef, env.appDid, "echo", "transitioning");

  // 5. Command whose parent is missing or is itself a reply -> both dropped.
  env.advance(5);
  await aliceEngine.appInboxes.sendCommand(generalRef, env.appDid, "echo", "missing-parent", spaceRecordUri(env.fixture.channels.general!, env.alice, COLLECTION.message, key(999)));
  env.advance(5);
  await aliceEngine.appInboxes.sendCommand(generalRef, env.appDid, "echo", "nested-parent", replyMsg.uri);

  // 6. Valid command in #general on a top-level parent -> delivered!
  env.advance(5);
  await aliceEngine.appInboxes.sendCommand(generalRef, env.appDid, "echo", "in-thread", topMsg.uri);

  // 7. Workspace authority in a private channel it owns (never written to channelRoster) -> admitted!
  env.advance(5);
  await authorityEngine.appInboxes.sendCommand(secretRef, env.appDid, "echo", "from-authority");

  env.change(env.inbox);
  await env.runtime.poll();

  assert.deepEqual(
    env.commands.map((entry) => ({ repo: entry.repo, skey: entry.channel.skey, text: entry.text, parent: entry.parent, canWrite: entry.canWrite })),
    [
      { repo: env.alice, skey: "acme-general", text: "in-thread", parent: topMsg.uri, canWrite: true },
      { repo: AUTHORITY, skey: "acme-secret", text: "from-authority", parent: undefined, canWrite: true },
    ],
    `errors: ${env.errors.map(String).join(" || ")}`,
  );
  assert.equal(env.errors.length, 6, `all six invalid commands were dropped and reported: ${env.errors.map(String).join(" | ")}`);

  // 8. A removed author still in the runtime's earlier cached summary is caught by the fresh summary read!
  env.advance(10);
  await bobEngine.appInboxes.sendCommand(generalRef, env.appDid, "echo", "after-removal");
  await env.network.writeAs(AUTHORITY, env.fixture.workspace, COLLECTION.workspaceRoster, env.subjectKey(env.bob), {
    subject: env.bob,
    active: false,
    updatedAt: "2026-11-10T12:02:00.000Z",
  });
  // Only the inbox changes in this poll (workspace has not been re-read by readGrants yet).
  env.change(env.inbox);
  await env.runtime.poll();
  assert.equal(env.commands.length, 2, "removed member's command was dropped via fresh workspace summary");
  assert.match(String(env.errors.at(-1)), /not on .* active roster/);
});

test("onAction checks message authorship, fresh grant, private roster, old messages beyond any page, button presence, and ignores forged action values", async () => {
  const env = await inboxFixture({ onMessage: false });
  await env.runtime.poll();

  const aliceEngine = createEngine(transportFor(env.network, env.alice));
  const bobEngine = createEngine(transportFor(env.network, env.bob));
  const authorityEngine = createEngine(transportFor(env.network, AUTHORITY));
  const generalSpace = env.fixture.channels.general!;
  const generalRef = { workspace: env.fixture.workspace, skey: "acme-general" };
  const secretRef = { workspace: env.fixture.workspace, skey: "acme-secret" };

  // Write an old app message with a button, then 120 newer messages so it is older than any 100-message page.
  const ancientAppRkey = key(1);
  const ancientAppUri = spaceRecordUri(generalSpace, env.appDid, COLLECTION.message, ancientAppRkey);
  await env.network.writeAs(env.appDid, generalSpace, COLLECTION.message, ancientAppRkey, {
    text: "echo: ancient",
    blocks: [sectionBlock("echo: ancient"), actionsBlock([button({ actionId: "again", label: "Again", value: "trusted-button-value" })])],
    createdAt: "2026-11-10T12:00:00.000Z",
  });
  for (let index = 2; index <= 122; index += 1) await writeMessage(env.network, env.alice, generalSpace, index);

  // Also write an app message in #secret, and a person's message + another app's message with buttons.
  const secretAppMsg = await env.appEngine.channels.send(
    secretRef,
    "secret card",
    undefined,
    [actionsBlock([button({ actionId: "confirm", label: "Confirm", value: "secret-ok" })])],
  );
  env.advance(5);
  const personMsg = await aliceEngine.channels.send(
    generalRef,
    "person card",
    undefined,
    [actionsBlock([button({ actionId: "again", label: "Spoof", value: "spoofed" })])],
  );
  env.advance(5);
  const editableAppMsg = await env.appEngine.channels.send(
    generalRef,
    "one-shot",
    undefined,
    [actionsBlock([button({ actionId: "once", label: "Once", value: "1" })])],
  );
  // Edit editableAppMsg to clear its blocks before the click is processed.
  await env.appEngine.channels.edit(generalRef, editableAppMsg.uri, "done", null);

  // 1. Click on someone else's message -> dropped.
  env.advance(5);
  await aliceEngine.appInboxes.sendAction(generalRef, env.appDid, personMsg.uri, "again");

  // 2. Click on a button that is gone -> dropped.
  env.advance(5);
  await aliceEngine.appInboxes.sendAction(generalRef, env.appDid, editableAppMsg.uri, "once");

  // 3. Click on private channel by outsider -> dropped.
  env.advance(5);
  await bobEngine.appInboxes.sendAction(secretRef, env.appDid, secretAppMsg.uri, "confirm");

  // 4. Forged `value` written directly into the action record on an ancient message -> delivered with the button's OWN value!
  env.advance(5);
  await env.network.writeAs(env.alice, env.inbox, COLLECTION.appAction, tidNow(env.clock.now()), {
    message: ancientAppUri,
    actionId: "again",
    channel: generalSpace,
    value: "FORGED-BY-CALLER",
    createdAt: new Date(env.clock.now()).toISOString(),
  });

  // 5. Workspace authority clicking a button in private channel #secret -> admitted!
  env.advance(5);
  await authorityEngine.appInboxes.sendAction(secretRef, env.appDid, secretAppMsg.uri, "confirm");

  env.change(env.inbox);
  await env.runtime.poll();

  assert.deepEqual(
    env.actions.map((entry) => ({ repo: entry.repo, message: entry.message.uri, actionId: entry.actionId, value: entry.value, canWrite: entry.canWrite })),
    [
      { repo: env.alice, message: ancientAppUri, actionId: "again", value: "trusted-button-value", canWrite: true },
      { repo: AUTHORITY, message: secretAppMsg.uri, actionId: "confirm", value: "secret-ok", canWrite: true },
    ],
  );
  assert.equal(env.errors.length, 3, `three invalid actions dropped: ${env.errors.map(String).join(" | ")}`);

  // 6. Grant changed to read-only -> canWrite is false; grant removed -> dropped even though app still holds a cached credential!
  await env.writeInstall(env.appDid, true, [{ skey: "acme-general", write: false }]);
  env.advance(5);
  await aliceEngine.appInboxes.sendAction(generalRef, env.appDid, ancientAppUri, "again");
  env.advance(5);
  await authorityEngine.appInboxes.sendAction(secretRef, env.appDid, secretAppMsg.uri, "confirm");
  env.change(env.inbox);
  await env.runtime.poll();

  assert.equal(env.actions.length, 3);
  assert.equal(env.actions[2]!.canWrite, false, "read-only grant passes canWrite: false");
  assert.match(String(env.errors.at(-1)), /not granted to this app/, "ungranted channel dropped despite cached credential");
});

test("per-author inbox throttle caps each author per minute, reports excess once per minute per author, and resets next minute", async () => {
  const env = await inboxFixture({ onMessage: false, maxRecordsPerAuthor: 3 });
  await env.runtime.poll();

  const aliceEngine = createEngine(transportFor(env.network, env.alice));
  const bobEngine = createEngine(transportFor(env.network, env.bob));
  const generalRef = { workspace: env.fixture.workspace, skey: "acme-general" };

  // Alice writes 5 commands in one minute; Bob writes 1.
  for (let index = 0; index < 5; index += 1) {
    env.advance(10);
    await aliceEngine.appInboxes.sendCommand(generalRef, env.appDid, "echo", `a${index}`);
  }
  env.advance(10);
  await bobEngine.appInboxes.sendCommand(generalRef, env.appDid, "echo", "b0");

  env.change(env.inbox);
  await env.runtime.poll();

  assert.deepEqual(env.commands.map((entry) => entry.text), ["a0", "a1", "a2", "b0"]);
  const throttleErrors = env.errors.filter((error) => /exceeded 3 inbox records per minute/.test(String(error)));
  assert.equal(throttleErrors.length, 1, "excess records reported once per minute per author");

  // After a minute passes, Alice's budget resets and a Dropped record is NOT re-delivered.
  env.advance(60_000);
  await aliceEngine.appInboxes.sendCommand(generalRef, env.appDid, "echo", "after-minute");
  env.change(env.inbox);
  await env.runtime.poll();
  assert.deepEqual(env.commands.map((entry) => entry.text), ["a0", "a1", "a2", "b0", "after-minute"]);
});
