import assert from "node:assert/strict";
import test from "node:test";
import { SpaceCredentialError } from "@flock/protocol/atproto/space-credential-core";
import {
  appInboxSkey,
  appInboxUri,
  appRoleKey,
  channelRoleKey,
  channelUri,
  SELF_SKEY,
  spaceRecordUri,
  subjectKey,
  tidNow,
} from "@flock/protocol/keys";
import { ATPROTO_SPACE_COLLECTION, COLLECTION, OPENSOCIAL_COLLECTION, OPENSOCIAL_POLICY, SPACE_TYPE } from "@flock/protocol/nsids";
import { FakeNetwork } from "@flock/testing/fake-network";
import { AppAccessLostError, AppRuntime, publishAppDeclaration, type AppAction, type AppCommand, type AppMessage } from "./app-runtime";
import { actionsBlock, button, sectionBlock } from "./blocks";
import type { ChannelMessage, ChannelPage, ChannelRef } from "./channel-client";
import { createEngine } from "./engine";
import { AUTHORITY, createWorkspace, key, transportFor, writeMessage } from "./testing/engine-fixture";

const APP = "did:plc:appaaaaaaaaaaaaaaaaaaaaa";
const OTHER_APP = "did:plc:otherappaaaaaaaaaaaaaaaa";
const PERSON = "did:plc:personaaaaaaaaaaaaaaaaaa";
const WORKSPACE = `at://${AUTHORITY}/space/new.flock.workspace/self`;
const GENERAL = `at://${AUTHORITY}/space/new.flock.channel/general`;
const SECRET = `at://${AUTHORITY}/space/new.flock.channel/secret`;
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
    channels: new Map<string, ChannelMessage[]>([["general", []], ["secret", []]]),
    failingReads: new Set<string>(),
    incomplete: false,
    setAside: [] as Array<{ did: string; reason: string; permanent: boolean }>,
    refusal: null as unknown,
    failingSummaries: 0,
    summaries: 0,
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
          return {
            installs: state.installs,
            members: state.members.map((did) => ({ did, active: true, roles: ["member"] })),
            pendingMembers: [],
          };
        },
      } as never,
      channels: {
        readPage: async (ref: ChannelRef, options: { before?: string } = {}) => {
          if (state.failingReads.has(ref.skey)) throw new Error(`${ref.skey} could not be read`);
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
  const app = fakeApp([{ did: APP, channels: [{ skey: "general", write: true }] }]);
  app.post("general", past(PERSON, "before"));
  await app.runtime.poll();

  app.post("general", message(PERSON, "one"), message(PERSON, "two"));
  app.change(GENERAL);
  await app.runtime.poll();
  app.change(GENERAL);
  await app.runtime.poll();

  assert.deepEqual(app.texts(), ["one", "two"]);
  assert.equal(app.given[0]!.canWrite, true);
});

test("an app is given no app's message, its own or another's", async () => {
  const app = fakeApp([{ did: APP, channels: [{ skey: "general", write: true }] }, { did: OTHER_APP, channels: [{ skey: "general", write: true }] }]);
  await app.runtime.poll();
  app.post("general", message(APP, "echo: hello"), message(OTHER_APP, "beep"), message(PERSON, "hi"));
  app.change(GENERAL);
  await app.runtime.poll();
  assert.deepEqual(app.texts(), ["hi"]);
});

test("an app installed since the grants were read is not given for a person, though the workspace's read failed in that poll", async () => {
  const app = fakeApp([{ did: APP, channels: [{ skey: "general", write: true }] }]);
  await app.runtime.poll();
  app.state.installs = [...app.state.installs, { did: OTHER_APP, channels: [{ skey: "general", write: true }] }];
  app.post("general", message(OTHER_APP, "beep"), message(PERSON, "hi"));

  app.state.failingSummaries = 1;
  app.change(WORKSPACE, GENERAL);
  await app.runtime.poll();

  assert.deepEqual(app.texts(), ["hi"]);
});

test("an app installed since the grants were read is not given for a person when its channel is read before its workspace", async () => {
  const app = fakeApp([{ did: APP, channels: [{ skey: "general", write: true }] }]);
  await app.runtime.poll();
  app.state.installs = [...app.state.installs, { did: OTHER_APP, channels: [{ skey: "general", write: true }] }];
  app.post("general", message(OTHER_APP, "beep"));

  app.change(GENERAL, WORKSPACE);
  await app.runtime.poll();

  assert.deepEqual(app.texts(), []);
});

test("a known author costs no extra read of the workspace, and a read the refresh cannot make gives nothing until the next change", async () => {
  const app = fakeApp([{ did: APP, channels: [{ skey: "general", write: true }] }]);
  await app.runtime.poll();
  const reads = app.state.summaries;

  app.post("general", message(PERSON, "hi"));
  app.change(GENERAL);
  await app.runtime.poll();

  assert.deepEqual([app.texts(), app.state.summaries], [["hi"], reads]);

  app.state.members = [PERSON, "did:plc:newpersonaaaaaaaaaaaaaaa"];
  app.post("general", message("did:plc:newpersonaaaaaaaaaaaaaaa", "hello all"));
  app.state.failingSummaries = 1;
  app.change(GENERAL);
  await app.runtime.poll();

  assert.deepEqual(app.texts(), ["hi"]);
  app.change(GENERAL);
  await app.runtime.poll();
  assert.deepEqual(app.texts(), ["hi", "hello all"]);
});

test("a burst bigger than a page is given whole, and one beyond the pages followed back is reported", async () => {
  const app = fakeApp([{ did: APP, channels: [{ skey: "general", write: true }] }]);
  app.post("general", past(PERSON, "before"));
  await app.runtime.poll();

  app.post("general", ...Array.from({ length: 7 }, (_, index) => message(PERSON, `m${index}`)));
  app.change(GENERAL);
  await app.runtime.poll();

  assert.deepEqual(app.texts(), ["m0", "m1", "m2", "m3", "m4", "m5", "m6"]);

  app.post("general", ...Array.from({ length: 17 }, (_, index) => message(PERSON, `b${index}`)));
  app.change(GENERAL);
  await app.runtime.poll();
  assert.equal(app.texts().filter((text) => text.startsWith("b")).length, 15);
  assert.match(String(app.errors.at(-1)), /More than 5 pages of new messages/);
});

test("a message the app fails on is reported, does not hold back the next, and is given again on the next change", async () => {
  const app = fakeApp([{ did: APP, channels: [{ skey: "general", write: true }] }]);
  await app.runtime.poll();
  app.failing.add("poison");
  app.post("general", message(PERSON, "poison"), message(PERSON, "later"));
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
  const app = fakeApp([{ did: APP, channels: [{ skey: "general", write: true }] }]);
  await app.runtime.poll();
  assert.deepEqual(app.runtime.following.sort(), [GENERAL, WORKSPACE].sort());

  app.state.installs = [{ did: APP, channels: [{ skey: "general", write: false }, { skey: "secret", write: true }] }];
  app.change(WORKSPACE);
  await app.runtime.poll();
  app.post("general", message(PERSON, "now read only"));
  app.change(GENERAL);
  await app.runtime.poll();

  assert.deepEqual(app.runtime.following.sort(), [GENERAL, SECRET, WORKSPACE].sort());
  assert.deepEqual(app.given.map((entry) => [String(entry.message.value.text), entry.canWrite]), [["now read only", false]]);

  app.state.installs = [{ did: APP, channels: [{ skey: "secret", write: true }] }];
  app.change(WORKSPACE);
  await app.runtime.poll();
  assert.deepEqual(app.runtime.following.sort(), [SECRET, WORKSPACE].sort());
});

test("a granted channel that could not be read when it was granted holds back no other, and is followed once it can be read", async () => {
  const app = fakeApp([{ did: APP, channels: [] }]);
  await app.runtime.poll();
  app.state.installs = [{ did: APP, channels: [{ skey: "general", write: true }, { skey: "secret", write: true }] }];
  app.state.failingReads.add("secret");
  app.change(WORKSPACE);
  await app.runtime.poll();
  await app.runtime.poll();
  assert.deepEqual(app.runtime.following.sort(), [GENERAL, WORKSPACE].sort(), "#general is followed all the same");
  assert.match(String(app.errors.at(-1)), /secret could not be read/);

  app.state.failingReads.clear();
  await new Promise((resolve) => setTimeout(resolve, 15));
  await app.runtime.poll();

  assert.equal(app.runtime.following.includes(SECRET), true);
  app.post("secret", message(PERSON, "secret"));
  app.change(SECRET);
  await app.runtime.poll();
  assert.deepEqual(app.texts(), ["secret"]);
});

test("an app that loses its workspace reports it, waits instead of asking the feed again at once, and follows it again when it can", async () => {
  const app = fakeApp([{ did: APP, channels: [{ skey: "general", write: true }] }]);
  await app.runtime.poll();

  app.state.denied = [WORKSPACE, GENERAL];
  app.state.lost = new Set([WORKSPACE, GENERAL]);
  await app.runtime.poll();
  const asked = app.state.getChanges;
  const started = Date.now();
  await app.runtime.poll();

  assert.deepEqual(app.runtime.following, []);
  assert.ok(app.errors.some((error) => error instanceof AppAccessLostError && error.space === WORKSPACE));
  assert.equal(app.state.getChanges, asked);
  assert.ok(Date.now() - started >= 15);

  app.state.denied = [];
  app.state.lost.clear();
  await new Promise((resolve) => setTimeout(resolve, 25));
  await app.runtime.poll();
  assert.deepEqual(app.runtime.following.sort(), [GENERAL, WORKSPACE].sort());
});

test("a read without some writer is reported", async () => {
  const app = fakeApp([{ did: APP, channels: [{ skey: "general", write: true }] }]);
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
  const app = fakeApp([{ did: APP, channels: [{ skey: "general", write: true }] }]);
  const old = Array.from({ length: 5 }, (_, index) => past(PERSON, `old${index}`));
  app.post("general", ...old);
  await app.runtime.poll();

  app.remove("general", old[4]!.uri);
  app.change(GENERAL);
  await app.runtime.poll();

  assert.deepEqual(app.texts(), []);
});

test("a burst whose newest page the app fails on is not given twice, nor anything from before it", async () => {
  const app = fakeApp([{ did: APP, channels: [{ skey: "general", write: true }] }]);
  app.post("general", past(PERSON, "old-before"));
  await app.runtime.poll();
  for (const text of ["m3", "m4", "m5"]) app.failing.add(text);
  app.post("general", ...Array.from({ length: 6 }, (_, index) => message(PERSON, `m${index}`)));
  app.change(GENERAL);
  await app.runtime.poll();

  app.failing.clear();
  app.change(GENERAL);
  await app.runtime.poll();

  assert.deepEqual(app.texts().sort(), ["m0", "m1", "m2", "m3", "m4", "m5"]);
});

test("a message the app keeps failing on is given up after three attempts, and said so", async () => {
  const app = fakeApp([{ did: APP, channels: [{ skey: "general", write: true }] }]);
  await app.runtime.poll();
  let attempts = 0;
  app.failing.add("poison");
  app.post("general", message(PERSON, "poison"));
  for (let round = 0; round < 5; round += 1) {
    app.change(GENERAL);
    await app.runtime.poll();
    attempts = app.errors.filter((error) => /failed on poison/.test(String(error))).length;
  }
  assert.equal(attempts, 3);
  assert.match(String(app.errors.at(-1)), /3 times; it is not given again/);
});

test("losing the workspace takes its channels with it, and each loss is reported once", async () => {
  const app = fakeApp([{ did: APP, channels: [{ skey: "general", write: true }] }]);
  await app.runtime.poll();

  app.state.denied = [WORKSPACE];
  app.state.lost = new Set([WORKSPACE]);
  for (let round = 0; round < 4; round += 1) {
    await app.runtime.poll();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

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
  const app = fakeApp([{ did: APP, channels: [{ skey: "general", write: true }] }]);
  await app.runtime.poll();
  app.state.setAside = [{ did: "did:plc:downaaaaaaaaaaaaaaaaaaaa", reason: "host unreachable", permanent: false }, { did: "did:plc:goneaaaaaaaaaaaaaaaaaaaa", reason: "repo taken down", permanent: true }];
  for (let round = 0; round < 2; round += 1) {
    app.change(GENERAL);
    await app.runtime.poll();
  }
  assert.equal(app.errors.filter((error) => /read without 1 writer/.test(String(error))).length, 2);
  assert.equal(app.errors.filter((error) => /did:plc:goneaaaaaaaaaaaaaaaaaaaa's messages cannot be read/.test(String(error))).length, 1);
});

test("an app that stays lost waits each round instead of asking again at once", async () => {
  const app = fakeApp([{ did: APP, channels: [{ skey: "general", write: true }] }]);
  await app.runtime.poll();
  app.state.denied = [WORKSPACE, GENERAL];
  app.state.lost = new Set([WORKSPACE, GENERAL]);
  for (let round = 0; round < 4; round += 1) await app.runtime.poll();

  const rounds: number[] = [];
  for (let round = 0; round < 3; round += 1) {
    const started = Date.now();
    await app.runtime.poll();
    rounds.push(Date.now() - started);
  }

  assert.ok(rounds.every((elapsed) => elapsed >= 90), rounds.join(", "));
});

test("a deleted message lets no older one in, however often the channel changes after", async () => {
  const app = fakeApp([{ did: APP, channels: [{ skey: "general", write: true }] }]);
  const old = Array.from({ length: 5 }, (_, index) => past(PERSON, `old${index}`));
  app.post("general", ...old);
  await app.runtime.poll();
  app.remove("general", old[4]!.uri);
  app.change(GENERAL);
  await app.runtime.poll();
  app.remove("general", old[3]!.uri);
  for (let round = 0; round < 2; round += 1) {
    app.change(GENERAL);
    await app.runtime.poll();
  }

  assert.deepEqual(app.texts(), []);
  app.post("general", message(PERSON, "new"));
  app.change(GENERAL);
  await app.runtime.poll();
  assert.deepEqual(app.texts(), ["new"]);
});

test("a first read without a writer takes none of that writer's history for new when its host comes back", async () => {
  const app = fakeApp([{ did: APP, channels: [{ skey: "general", write: true }] }]);
  const first = past(PERSON, "first");
  const history = Array.from({ length: 3 }, (_, index) => past("did:plc:downwriteraaaaaaaaaaaaaa", `history${index}`));
  const second = past(PERSON, "second");
  app.post("general", first, second);
  app.state.incomplete = true;
  await app.runtime.poll();

  app.state.incomplete = false;
  app.state.channels.set("general", [first, ...history, second]);
  app.change(GENERAL);
  await app.runtime.poll();
  app.post("general", message(PERSON, "after"));
  app.change(GENERAL);
  await app.runtime.poll();

  assert.deepEqual(app.texts(), ["after"]);
});

test("a first read of an empty channel without a writer takes none of that writer's history for new either", async () => {
  const app = fakeApp([{ did: APP, channels: [{ skey: "general", write: true }] }]);
  app.state.incomplete = true;
  await app.runtime.poll();
  app.state.incomplete = false;
  app.post("general", past("did:plc:downwriteraaaaaaaaaaaaaa", "history"));
  app.change(GENERAL);
  await app.runtime.poll();
  app.post("general", message(PERSON, "after"));
  app.change(GENERAL);
  await app.runtime.poll();
  assert.deepEqual(app.texts(), ["after"]);
});

test("a message keyed in the future, even deleted again, does not silence the channel", async () => {
  const app = fakeApp([{ did: APP, channels: [{ skey: "general", write: true }] }]);
  await app.runtime.poll();
  const ahead = Array.from({ length: 3 }, (_, index) => message(PERSON, `ahead${index}`, Date.now() + 3_600_000));
  app.post("general", ...ahead);
  app.change(GENERAL);
  await app.runtime.poll();
  for (const entry of ahead) app.remove("general", entry.uri);

  app.post("general", message(PERSON, "later"));
  app.change(GENERAL);
  await app.runtime.poll();

  assert.deepEqual(app.texts(), ["later"]);
});

test("a channel the app cannot follow is tried again less and less often", async () => {
  const app = fakeApp([{ did: APP, channels: [{ skey: "general", write: true }] }], { retryDelayMs: 10, refollowDelayMs: 1_000 });
  app.state.failingReads.add("general");

  const started = Date.now();
  while (Date.now() - started < 300) await app.runtime.poll();

  const tries = app.errors.filter((error) => /general could not be read/.test(String(error))).length;
  assert.ok(tries >= 4 && tries <= 6, `${tries} tries`);
});

test("a new message in a long channel is read from its newest page alone", async () => {
  const app = fakeApp([{ did: APP, channels: [{ skey: "general", write: true }] }]);
  app.post("general", ...Array.from({ length: 20 }, (_, index) => past(PERSON, `old${index}`)));
  await app.runtime.poll();
  app.post("general", message(PERSON, "new"));
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
  const app = fakeApp([{ did: APP, channels: [{ skey: "general", write: true }] }]);
  await app.runtime.poll();
  app.post("general", ...Array.from({ length: 30 }, (_, index) => message(PERSON, `ahead${index}`, Date.now() + 3_600_000)));
  app.post("general", message(PERSON, "now"));
  app.change(GENERAL);
  await app.runtime.poll();
  assert.deepEqual(app.texts(), ["now"]);
  assert.deepEqual(app.errors, [], "no burst is reported");
});

test("a burst written just before the app followed is not answered", async () => {
  const app = fakeApp([{ did: APP, channels: [{ skey: "general", write: true }] }]);
  app.post("general", ...Array.from({ length: 8 }, (_, index) => message(PERSON, `recent${index}`, Date.now() - 2_000)));
  await app.runtime.poll();
  app.post("general", message(PERSON, "after"));
  app.change(GENERAL);
  await app.runtime.poll();
  assert.deepEqual(app.texts(), ["after"]);
});

test("a writer whose host was down has what it wrote meanwhile given when it comes back", async () => {
  const app = fakeApp([{ did: APP, channels: [{ skey: "general", write: true }] }]);
  const followedAt = Date.now();
  await app.runtime.poll();
  await new Promise((resolve) => setTimeout(resolve, 200));
  app.state.incomplete = true;
  app.post("general", message(PERSON, "while down"));
  app.change(GENERAL);
  await app.runtime.poll();

  const meanwhile = message("did:plc:downwriteraaaaaaaaaaaaaa", "written while its host was down", followedAt - 5_000 + 100);
  app.state.incomplete = false;
  app.post("general", meanwhile);
  app.change(GENERAL);
  await app.runtime.poll();

  assert.deepEqual(app.texts(), ["while down", "written while its host was down"]);
});

function testClock() {
  const clock = { wall: Date.now(), passed: 0, now: () => clock.wall, elapsed: () => clock.passed };
  return { clock, advance: (ms: number) => { clock.wall += ms; clock.passed += ms; } };
}

test("a message the app failed on and that is then deleted holds the window for ten minutes at most", async () => {
  const { clock, advance } = testClock();
  const app = fakeApp([{ did: APP, channels: [{ skey: "general", write: true }] }], { clock });
  await app.runtime.poll();
  app.failing.add("poison");
  const poison = message(PERSON, "poison", clock.wall);
  app.post("general", poison);
  app.change(GENERAL);
  await app.runtime.poll();
  app.remove("general", poison.uri);

  for (let minute = 1; minute <= 60; minute += 1) {
    advance(60_000);
    app.post("general", message(PERSON, `m${minute}`, clock.wall));
    app.change(GENERAL);
    await app.runtime.poll();
  }

  assert.equal(app.texts().length, 60);
  assert.ok(app.errors.some((error) => /has not been read again for 10 minutes/.test(String(error))));
  assert.equal(app.errors.filter((error) => /More than 5 pages/.test(String(error))).length, 0);
});

test("a jump of the app's clock carries the window no further than the time that passed", async () => {
  const { clock, advance } = testClock();
  const app = fakeApp([{ did: APP, channels: [{ skey: "general", write: true }] }], { clock });
  await app.runtime.poll();

  advance(1_000);
  clock.wall += 3_600_000;
  app.change(GENERAL);
  await app.runtime.poll();
  clock.wall -= 3_600_000;
  advance(60_000);
  app.post("general", message(PERSON, "a minute later", clock.wall));
  app.change(GENERAL);
  await app.runtime.poll();

  assert.deepEqual(app.texts(), ["a minute later"]);
});

test("a read without some writer is reported once, however many pages it reads", async () => {
  const { clock } = testClock();
  const app = fakeApp([{ did: APP, channels: [{ skey: "general", write: true }] }], { clock });
  await app.runtime.poll();
  app.post("general", ...Array.from({ length: 10 }, (_, index) => message(PERSON, `burst${index}`, clock.wall)));
  app.state.setAside = [{ did: "did:plc:downaaaaaaaaaaaaaaaaaaaa", reason: "host unreachable", permanent: false }];
  app.change(GENERAL);
  await app.runtime.poll();
  assert.equal(app.errors.filter((error) => /read without 1 writer/.test(String(error))).length, 1);
});

test("a writer set aside for good does not hold the window", async () => {
  const { clock, advance } = testClock();
  const app = fakeApp([{ did: APP, channels: [{ skey: "general", write: true }] }], { clock });
  app.state.setAside = [{ did: "did:plc:goneaaaaaaaaaaaaaaaaaaaa", reason: "repo taken down", permanent: true }];
  await app.runtime.poll();
  advance(60_000);
  app.change(GENERAL);
  await app.runtime.poll();
  const late = message(PERSON, "late", clock.wall - 30_000);

  app.post("general", late);
  app.change(GENERAL);
  await app.runtime.poll();

  assert.deepEqual(app.texts(), []);
});

// --- R10b + R13: App inbox following, OpenSocial RBAC, moderation label filtering, and per-author throttle ----------

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
  const founder = "did:plc:founderaaaaaaaaaaaaaaaaa";
  const alice = "did:plc:aliceaaaaaaaaaaaaaaaaaaa";
  const bob = "did:plc:bob2aaaaaaaaaaaaaaaaaaaa";
  const appDid = "did:plc:app2aaaaaaaaaaaaaaaaaaaa";
  const otherAppDid = "did:plc:otherappaaaaaaaaaaaaaaaa";
  const fixture = await createWorkspace(network, {
    authority: AUTHORITY,
    admins: [founder],
    members: [founder, alice, bob],
    channels: [
      { skey: "general", visibility: "public" },
      { skey: "secret", visibility: "private", members: [founder, alice] },
      { skey: "moving", visibility: "transitioning" },
    ],
  });
  const otherWorkspace = await createWorkspace(network, {
    skey: "beta",
    admins: [alice],
    members: [alice],
    channels: [{ skey: "general", visibility: "public" }],
  });

  network.createAccount(appDid, "pds2");
  network.createAccount(otherAppDid, "pds1");
  const owner = network.clientFor(AUTHORITY);
  const appRole = appRoleKey(appDid);
  const otherAppRole = appRoleKey(otherAppDid);
  const secretRole = channelRoleKey("secret");

  for (const [did, role] of [[appDid, appRole], [otherAppDid, otherAppRole]] as const) {
    await owner.procedure("com.atproto.space.putRecord", {
      space: fixture.members,
      repo: AUTHORITY,
      collection: OPENSOCIAL_COLLECTION.role,
      rkey: role,
      record: {
        $type: OPENSOCIAL_COLLECTION.role,
        displayName: `Bot ${did}`,
        scopes: [
          "space:group.opensocial.meta?authority=self&skey=self&action=read",
          "space:group.opensocial.members?authority=self&skey=self&action=read",
          "space:new.flock.workspace?authority=self&skey=self&action=read",
        ],
      },
    });
  }

  const writeInstall = (did: string, active: boolean, channels: Array<{ skey: string; write: boolean }>) =>
    network.writeAs(AUTHORITY, fixture.workspace, COLLECTION.appInstall, subjectKey(did), {
      subject: did,
      active,
      channels,
      installedBy: founder,
      installedAt: "2026-11-10T12:00:00.000Z",
      updatedAt: "2026-11-10T12:00:00.000Z",
    });
  await writeInstall(appDid, true, [
    { skey: "general", write: true },
    { skey: "secret", write: true },
    { skey: "moving", write: true },
  ]);
  await writeInstall(otherAppDid, true, [{ skey: "general", write: true }]);

  for (const [did, role] of [[appDid, appRole], [otherAppDid, otherAppRole]] as const) {
    await owner.procedure("com.atproto.space.putRecord", {
      space: fixture.members,
      repo: AUTHORITY,
      collection: OPENSOCIAL_COLLECTION.membership,
      rkey: did,
      record: { $type: OPENSOCIAL_COLLECTION.membership, roles: [role], createdAt: "2026-11-10T12:00:00.000Z" },
    });
  }

  // Grant app roles read access on meta/self, members/self, and workspace/self (matching Operator installApp)
  await owner.procedure("com.atproto.space.updateSpace", {
    space: fixture.meta,
    policy: {
      $type: OPENSOCIAL_POLICY,
      publicRead: true,
      unlisted: false,
      grants: [
        { role: "admin", read: true, write: true },
        { role: "moderator", read: true, write: true },
        { role: "member", read: true },
        { role: appRole, read: true },
        { role: otherAppRole, read: true },
      ],
    },
  });
  await owner.procedure("com.atproto.space.updateSpace", {
    space: fixture.members,
    policy: {
      $type: OPENSOCIAL_POLICY,
      publicRead: false,
      unlisted: false,
      grants: [
        { role: "admin", read: true, write: true },
        { role: "moderator", read: true, write: true },
        { role: "member", read: true, write: true },
        { role: appRole, read: true },
        { role: otherAppRole, read: true },
      ],
    },
  });
  await owner.procedure("com.atproto.space.updateSpace", {
    space: fixture.workspace,
    policy: {
      $type: OPENSOCIAL_POLICY,
      publicRead: false,
      unlisted: false,
      grants: [
        { role: "admin", read: true, write: true },
        { role: "moderator", read: true, write: true },
        { role: "member", read: true },
        { role: appRole, read: true },
        { role: otherAppRole, read: true },
      ],
    },
  });

  // Grant app roles on #general and #secret policies via updateSpace
  await owner.procedure("com.atproto.space.updateSpace", {
    space: fixture.channels.general!,
    policy: {
      $type: OPENSOCIAL_POLICY,
      publicRead: false,
      unlisted: false,
      grants: [
        { role: "admin", read: true, write: true },
        { role: "moderator", read: true, write: true },
        { role: "member", read: true, write: true },
        { role: appRole, read: true, write: true },
        { role: otherAppRole, read: true, write: true },
      ],
    },
  });
  await owner.procedure("com.atproto.space.updateSpace", {
    space: fixture.channels.secret!,
    policy: {
      $type: OPENSOCIAL_POLICY,
      publicRead: false,
      unlisted: true,
      grants: [
        { role: secretRole, read: true, write: true },
        { role: appRole, read: true, write: true },
      ],
    },
  });

  const inbox = appInboxUri(AUTHORITY, SELF_SKEY, appDid);
  await owner.procedure("com.atproto.space.createSpace", {
    spaceType: SPACE_TYPE.appInbox,
    skey: appInboxSkey(SELF_SKEY, appDid),
    policy: {
      $type: OPENSOCIAL_POLICY,
      publicRead: false,
      unlisted: true,
      grants: [
        { role: appRole, read: true },
        { role: "admin", write: true },
        { role: "moderator", write: true },
        { role: "member", write: true },
      ],
    },
  });

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
    founder,
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

  await withoutMessage.appEngine.channels.send(
    { workspace: withoutMessage.fixture.workspace, skey: "general" },
    "posted only",
  );
  assert.deepEqual(await withoutMessage.appEngine.sync.store.records(withoutMessage.fixture.channels.general!, COLLECTION.message), []);

  // Full OpenSocial uninstall: remove role grants, delete membership/<appDid>, set app.install active: false -> unfollows inbox & workspace.
  const owner = withoutMessage.network.clientFor(AUTHORITY);
  await owner.procedure("com.atproto.space.deleteRecord", {
    space: withoutMessage.fixture.members,
    repo: AUTHORITY,
    collection: OPENSOCIAL_COLLECTION.membership,
    rkey: withoutMessage.appDid,
  });
  await withoutMessage.writeInstall(withoutMessage.appDid, false, []);
  withoutMessage.change(withoutMessage.fixture.workspace);
  await withoutMessage.runtime.poll();
  assert.deepEqual(withoutMessage.runtime.following, []);
});

test("onCommand checks declared name, fresh roster, same-workspace channel, visibility, private roster, top-level parent, and !takedown withholding", async () => {
  const env = await inboxFixture({ onMessage: false });
  await env.runtime.poll();

  const aliceEngine = createEngine(transportFor(env.network, env.alice));
  const bobEngine = createEngine(transportFor(env.network, env.bob));
  const founderEngine = createEngine(transportFor(env.network, env.founder));
  const generalRef = { workspace: env.fixture.workspace, skey: "general" };
  const secretRef = { workspace: env.fixture.workspace, skey: "secret" };
  const movingRef = { workspace: env.fixture.workspace, skey: "moving" };

  const topMsg = await aliceEngine.channels.send(generalRef, "top");
  env.advance(5);
  const replyMsg = await aliceEngine.channels.send(generalRef, "reply", topMsg.uri);

  // 1. Undeclared command -> dropped.
  env.advance(5);
  await aliceEngine.appInboxes.sendCommand(generalRef, env.appDid, "undeclared", "arg");

  // 2. Private channel outsider (Bob is in the workspace but NOT on #secret's roster) -> dropped.
  env.advance(5);
  await bobEngine.appInboxes.sendCommand(secretRef, env.appDid, "echo", "sneak");

  // 3. Channel of another workspace -> dropped.
  env.advance(5);
  await env.network.writeAs(env.alice, env.inbox, COLLECTION.appCommand, tidNow(env.clock.now()), {
    command: "echo",
    text: "cross-workspace",
    channel: channelUri(env.otherWorkspace.groupDid, "general"),
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

  // 6. `!takedown`-labeled command in inbox -> dropped!
  env.advance(5);
  const takedownCmd = await aliceEngine.appInboxes.sendCommand(generalRef, env.appDid, "echo", "takendown-cmd");
  await env.network.clientFor(AUTHORITY).procedure("com.atproto.space.putRecord", {
    space: env.inbox,
    repo: AUTHORITY,
    collection: ATPROTO_SPACE_COLLECTION.label,
    rkey: key(77),
    record: { $type: ATPROTO_SPACE_COLLECTION.label, src: AUTHORITY, uri: takedownCmd.uri, val: "!takedown", cts: "2026-11-10T12:01:00.000Z" },
  });

  // 7. Valid command in #general on a top-level parent -> delivered!
  env.advance(5);
  await aliceEngine.appInboxes.sendCommand(generalRef, env.appDid, "echo", "in-thread", topMsg.uri);

  // 8. Admitted private-channel admin (founder) in #secret -> delivered!
  env.advance(5);
  await founderEngine.appInboxes.sendCommand(secretRef, env.appDid, "echo", "from-founder");

  env.change(env.inbox);
  await env.runtime.poll();

  assert.deepEqual(
    env.commands.map((entry) => ({ repo: entry.repo, skey: entry.channel.skey, text: entry.text, parent: entry.parent, canWrite: entry.canWrite })),
    [
      { repo: env.alice, skey: "general", text: "in-thread", parent: topMsg.uri, canWrite: true },
      { repo: env.founder, skey: "secret", text: "from-founder", parent: undefined, canWrite: true },
    ],
    `errors: ${env.errors.map(String).join(" || ")}`,
  );
  assert.equal(env.errors.length, 7, `all seven invalid/takendown commands were dropped and reported: ${env.errors.map(String).join(" | ")}`);

  // 9. A removed author still in the runtime's earlier cached summary is caught by the fresh summary read!
  env.advance(10);
  await bobEngine.appInboxes.sendCommand(generalRef, env.appDid, "echo", "after-removal");
  await env.network.clientFor(AUTHORITY).procedure("com.atproto.space.deleteRecord", {
    space: env.fixture.members,
    repo: AUTHORITY,
    collection: OPENSOCIAL_COLLECTION.membership,
    rkey: env.bob,
  });
  env.change(env.inbox);
  await env.runtime.poll();
  assert.equal(env.commands.length, 2, "removed member's command was dropped via fresh workspace summary");
});

test("onAction checks message authorship, fresh grant, private roster, old messages beyond any page, button presence, and ignores forged action values", async () => {
  const env = await inboxFixture({ onMessage: false });
  await env.runtime.poll();

  const aliceEngine = createEngine(transportFor(env.network, env.alice));
  const bobEngine = createEngine(transportFor(env.network, env.bob));
  const founderEngine = createEngine(transportFor(env.network, env.founder));
  const generalSpace = env.fixture.channels.general!;
  const generalRef = { workspace: env.fixture.workspace, skey: "general" };
  const secretRef = { workspace: env.fixture.workspace, skey: "secret" };

  const ancientAppRkey = key(1);
  const ancientAppUri = spaceRecordUri(generalSpace, env.appDid, COLLECTION.message, ancientAppRkey);
  await env.network.writeAs(env.appDid, generalSpace, COLLECTION.message, ancientAppRkey, {
    text: "echo: ancient",
    blocks: [sectionBlock("echo: ancient"), actionsBlock([button({ actionId: "again", label: "Again", value: "trusted-button-value" })])],
    createdAt: "2026-11-10T12:00:00.000Z",
  });
  for (let index = 2; index <= 122; index += 1) await writeMessage(env.network, env.alice, generalSpace, index);

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

  // 5. Admitted private-channel member clicking a button in #secret -> admitted!
  env.advance(5);
  await founderEngine.appInboxes.sendAction(secretRef, env.appDid, secretAppMsg.uri, "confirm");

  env.change(env.inbox);
  await env.runtime.poll();

  assert.deepEqual(
    env.actions.map((entry) => ({ repo: entry.repo, message: entry.message.uri, actionId: entry.actionId, value: entry.value, canWrite: entry.canWrite })),
    [
      { repo: env.alice, message: ancientAppUri, actionId: "again", value: "trusted-button-value", canWrite: true },
      { repo: env.founder, message: secretAppMsg.uri, actionId: "confirm", value: "secret-ok", canWrite: true },
    ],
  );
  assert.equal(env.errors.length, 3, `three invalid actions dropped: ${env.errors.map(String).join(" | ")}`);

  // 6. Grant changed to read-only -> canWrite is false; grant removed -> dropped even though app still holds a cached credential!
  await env.writeInstall(env.appDid, true, [{ skey: "general", write: false }]);
  env.advance(5);
  await aliceEngine.appInboxes.sendAction(generalRef, env.appDid, ancientAppUri, "again");
  env.advance(5);
  await founderEngine.appInboxes.sendAction(secretRef, env.appDid, secretAppMsg.uri, "confirm");
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
  const generalRef = { workspace: env.fixture.workspace, skey: "general" };

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

  env.advance(60_000);
  await aliceEngine.appInboxes.sendCommand(generalRef, env.appDid, "echo", "after-minute");
  env.change(env.inbox);
  await env.runtime.poll();
  assert.deepEqual(env.commands.map((entry) => entry.text), ["a0", "a1", "a2", "b0", "after-minute"]);
});

test("AppRuntime with followRepoOps delivers same-rev applyWrites in host order, withholds !takedown messages, handles oplog reset without redelivery, and retries without duplicating", async () => {
  const resets: Array<{ space: string; repo: string }> = [];
  const env = await inboxFixture({ onMessage: true, onCommand: false, onAction: false });
  const channel = env.fixture.channels.general!;
  await writeMessage(env.network, env.alice, channel, 1, "before-follow");
  await env.runtime.poll();
  assert.equal(env.messages.length, 0);

  // Note valid TID rkeys (`234567abcdefghij` leading char, `[2-7a-z]{13}`):
  await env.network.applyWritesAs(env.alice, channel, [
    { action: "create", collection: COLLECTION.message, rkey: "jzzzzzzzzzzzz", value: { text: "host-first", createdAt: "2026-11-10T12:00:00.000Z" } },
    { action: "create", collection: COLLECTION.message, rkey: "2aaaaaaaaaaaa", value: { text: "host-second", createdAt: "2026-11-10T12:00:00.000Z" } },
  ]);
  env.change(channel);
  await env.runtime.poll();
  assert.deepEqual(
    env.messages.map((entry) => entry.message.value.text),
    ["host-first", "host-second"],
    "AppRuntime delivers same-rev applyWrites in PDS host order",
  );

  // Moderation `!takedown` label on a new channel message withholds it from AppRuntime delivery!
  const takedownMsgRkey = key(97);
  const takedownMsgUri = spaceRecordUri(channel, env.alice, COLLECTION.message, takedownMsgRkey);
  await writeMessage(env.network, env.alice, channel, 97, "takendown-msg");
  await env.network.clientFor(AUTHORITY).procedure("com.atproto.space.putRecord", {
    space: channel,
    repo: AUTHORITY,
    collection: ATPROTO_SPACE_COLLECTION.label,
    rkey: key(96),
    record: { $type: ATPROTO_SPACE_COLLECTION.label, src: AUTHORITY, uri: takedownMsgUri, val: "!takedown", cts: "2026-11-10T12:01:00.000Z" },
  });
  env.change(channel);
  await env.runtime.poll();
  assert.equal(env.messages.some((m) => m.message.value.text === "takendown-msg"), false, "!takedown message withheld from bot");

  // Pruned oplog hole: write msg A (unsynced), prune oplog so msg A's op disappears, write msg B -> AppRuntime detects reset without delivering A/B or historical records!
  await writeMessage(env.network, env.alice, channel, 98, "lost-during-prune");
  env.network.pruneOplog(channel, env.alice);
  await writeMessage(env.network, env.alice, channel, 99, "after-prune");
  env.change(channel);
  await env.runtime.poll();
  assert.equal(env.messages.length, 2, "no duplicate deliveries or pre-reset historical replay");
  assert.equal(env.errors.some((error) => /Repo oplog reset/.test(String(error))), true, "reset diagnostic emitted via onError");

  let failMessage = true;
  const deliveredRetry: string[] = [];
  const retryRuntime = new AppRuntime({
    did: env.appDid,
    workspaces: [env.fixture.workspace],
    clock: env.clock,
    refollowDelayMs: 20,
    retryDelayMs: 10,
    engine: {
      ...createEngine(transportFor(env.network, env.appDid)),
      operator: {
        getChanges: async (follow) => {
          if (follow.length === 0) return { head: "1", changed: [], denied: [], reset: [] };
          return { head: "2", changed: follow.map((f) => ({ space: f.space, cursor: "2" })), denied: [], reset: [] };
        },
      },
    },
    onMessage: async (entry) => {
      const text = String(entry.message.value.text);
      if (failMessage && text === "m1") {
        failMessage = false;
        throw new Error("handler transient failure");
      }
      deliveredRetry.push(text);
    },
    onReset: (notice) => resets.push({ space: notice.space, repo: notice.repo }),
    onError: () => undefined,
  });
  await retryRuntime.poll();
  await retryRuntime.poll();
  await env.network.applyWritesAs(env.bob, channel, [
    { action: "create", collection: COLLECTION.message, rkey: "jzzzzzzzzzzzz", value: { text: "m1", createdAt: "2026-11-10T12:00:00.000Z" } },
    { action: "create", collection: COLLECTION.message, rkey: "3aaaaaaaaaaaa", value: { text: "m2", createdAt: "2026-11-10T12:00:00.000Z" } },
  ]);
  await retryRuntime.poll();
  assert.deepEqual(deliveredRetry, ["m2"], "sibling m2 delivered while m1 deferred");
  await retryRuntime.poll();
  assert.deepEqual(deliveredRetry, ["m2", "m1"], "m1 retried on next poll without duplicating m2");

  env.network.clearRecordsAs(env.bob, channel);
  await retryRuntime.poll();
  assert.deepEqual(resets, [{ space: channel, repo: env.bob }]);
});

test("AppRuntime with followRepoOps isolates failed initial writers, admits pendingMembers without acceptance/self, preserves floor on hold expiry, and prevents post-baseline genesis replay", async () => {
  // 1. Alice baselines + Bob fails permanently (RepoDeactivated) -> Carol joins via membership/<carol> (even before writing acceptance/self!) and her first command executes immediately without hammering Bob.
  {
    const env = await inboxFixture({ onMessage: false, onCommand: true, onAction: false });
    const generalRef = { workspace: env.fixture.workspace, skey: "general" };

    env.network.setAccountState(env.bob, "deactivated");
    await env.runtime.poll();
    assert.equal(env.commands.length, 0);

    const carol = "did:plc:carolaaaaaaaaaaaaaaaaaaa";
    env.network.createAccount(carol, "pds2");
    await env.network.clientFor(AUTHORITY).procedure("com.atproto.space.putRecord", {
      space: env.fixture.members,
      repo: AUTHORITY,
      collection: OPENSOCIAL_COLLECTION.membership,
      rkey: carol,
      record: { $type: OPENSOCIAL_COLLECTION.membership, roles: ["member"], createdAt: "2026-11-10T12:00:00.000Z" },
    });
    const carolEngine = createEngine(transportFor(env.network, carol));
    await carolEngine.appInboxes.sendCommand(generalRef, env.appDid, "echo", "carol-immediate-cmd");

    let bobInboxCalls = 0;
    const origFetch = env.network.fetchEndpoint;
    env.network.fetchEndpoint = async (request) => {
      const url = new URL(request.url);
      if (url.searchParams.get("space") === env.inbox && url.searchParams.get("repo") === env.bob) {
        bobInboxCalls += 1;
      }
      return origFetch(request);
    };
    try {
      env.change(env.inbox);
      await env.runtime.poll();
    } finally {
      env.network.fetchEndpoint = origFetch;
    }
    assert.deepEqual(env.commands.map((c) => c.text), ["carol-immediate-cmd"]);
    assert.equal(bobInboxCalls, 0, "unrelated deliver:true tick must not hammer deactivated writer");
  }

  // 2. Hold expiry at minute 11.1 records floor so recovery at minute 12 drops minute-1 command and delivers minute-11.5 command,
  //    and post-baseline RepoTakendown at minute 1 -> restored at minute 21 never replays genesis oplog or minute-1 commands.
  {
    const env = await inboxFixture({ onMessage: false, onCommand: true, onAction: false });
    const generalRef = { workspace: env.fixture.workspace, skey: "general" };
    const aliceEngine = createEngine(transportFor(env.network, env.alice));
    const bobEngine = createEngine(transportFor(env.network, env.bob));

    await env.runtime.poll();
    assert.equal(env.commands.length, 0);

    env.advance(60_000);
    await aliceEngine.appInboxes.sendCommand(generalRef, env.appDid, "echo", "alice-cmd-m1");
    await bobEngine.appInboxes.sendCommand(generalRef, env.appDid, "echo", "bob-suspended-m1");
    env.network.setHostReachable(env.alice, false);
    env.network.setAccountState(env.bob, "takendown");
    env.change(env.inbox);
    await env.runtime.poll();
    assert.equal(env.commands.length, 0);

    env.advance(10 * 60_000 + 6_000);
    env.change(env.inbox);
    await env.runtime.poll();
    assert.equal(env.commands.length, 0);

    env.advance(24_000);
    await aliceEngine.appInboxes.sendCommand(generalRef, env.appDid, "echo", "alice-cmd-m11-5");

    env.advance(30_000);
    env.network.setHostReachable(env.alice, true);
    env.change(env.inbox);
    await env.runtime.poll();
    assert.deepEqual(env.commands.map((c) => c.text), ["alice-cmd-m11-5"]);

    env.advance(9 * 60_000 + 60 * 60_000);
    let genesisOps = false;
    env.network.beforeListRepoOps = ({ since }) => {
      if (since === undefined) genesisOps = true;
    };
    env.network.setAccountState(env.bob, "active");
    env.change(env.inbox);
    await env.runtime.poll();
    assert.equal(genesisOps, false, "must not replay genesis oplog on post-baseline permanent recovery");
    assert.deepEqual(env.commands.map((c) => c.text), ["alice-cmd-m11-5"]);
  }
});

test("AppRuntime syncs account-level !takedown and !hide labels from members/self and never fires bot handlers for !takedown-labeled authors", async () => {
  const env = await inboxFixture({ onMessage: true, onCommand: true, onAction: true });
  const general = env.fixture.channels.general!;
  const generalRef = { workspace: env.fixture.workspace, skey: "general" };
  const owner = env.network.clientFor(AUTHORITY);
  const aliceEngine = createEngine(transportFor(env.network, env.alice));
  const bobEngine = createEngine(transportFor(env.network, env.bob));
  const appEngine = createEngine(transportFor(env.network, env.appDid), { applyOwnWrites: false });

  const botMsg = await appEngine.channels.send(generalRef, "click here", undefined, [
    actionsBlock([button({ actionId: "go", label: "Go" })]),
  ]);

  await env.runtime.poll();
  assert.equal(env.messages.length, 0);
  assert.equal(env.commands.length, 0);
  assert.equal(env.actions.length, 0);

  // Publish account-level `!takedown` on Bob and `!hide` on Alice in `members/self` WITHOUT signalling `members/self` on the feed!
  await owner.procedure("com.atproto.space.putRecord", {
    space: env.fixture.members,
    repo: AUTHORITY,
    collection: ATPROTO_SPACE_COLLECTION.label,
    rkey: key(90),
    record: {
      $type: ATPROTO_SPACE_COLLECTION.label,
      src: AUTHORITY,
      uri: env.bob,
      val: "!takedown",
      cts: "2026-11-10T12:10:00.000Z",
    },
  });
  await owner.procedure("com.atproto.space.putRecord", {
    space: env.fixture.members,
    repo: AUTHORITY,
    collection: ATPROTO_SPACE_COLLECTION.label,
    rkey: key(91),
    record: {
      $type: ATPROTO_SPACE_COLLECTION.label,
      src: AUTHORITY,
      uri: env.alice,
      val: "!hide",
      cts: "2026-11-10T12:10:01.000Z",
    },
  });

  env.advance(5_000);
  await bobEngine.channels.send(generalRef, "bob-takendown-msg");
  await bobEngine.appInboxes.sendCommand(generalRef, env.appDid, "echo", "bob-takendown-cmd");
  await bobEngine.appInboxes.sendAction(generalRef, env.appDid, botMsg.uri, "go");

  await aliceEngine.channels.send(generalRef, "alice-hidden-msg");
  await aliceEngine.appInboxes.sendCommand(generalRef, env.appDid, "echo", "alice-cmd");
  await aliceEngine.appInboxes.sendAction(generalRef, env.appDid, botMsg.uri, "go");

  env.change(general, env.inbox);
  await env.runtime.poll();

  assert.deepEqual(
    env.messages.map((m) => ({ author: m.message.repo, text: m.message.value.text, hidden: m.message.hidden })),
    [{ author: env.alice, text: "alice-hidden-msg", hidden: true }],
    "takendown Bob's message is withheld while hidden Alice's message carries hidden: true",
  );
  assert.deepEqual(env.commands.map((c) => c.repo), [env.alice], "onCommand never fires for !takedown author");
  assert.deepEqual(env.actions.map((a) => a.repo), [env.alice], "onAction never fires for !takedown author");
});
