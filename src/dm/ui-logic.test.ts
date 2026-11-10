import assert from "node:assert/strict";
import test from "node:test";
import { DmClient, type DmDeps, type DmStore } from "./dm-client";
import { FakeNetwork } from "@/testing/fake-network";
import { applyAllowlistEdit, coMemberDids, conversationVisible, describeSkippedSenders, halfChip, parseParticipantInput, retainAfterRefresh, runDmCycle, sharesAnyWorkspace } from "./ui-logic";

function createStore(): DmStore {
  const map = new Map<string, string>();
  return {
    async get(key) { return map.has(key) ? map.get(key)! : null; },
    async set(key, value) { map.set(key, value); },
    async delete(key) { map.delete(key); },
  };
}

function harness() {
  const network = new FakeNetwork();
  const clients = new Map<string, DmClient>();
  const client = (did: string, host = "pds1"): DmClient => {
    let instance = clients.get(did);
    if (!instance) {
      if (!network.hasAccount(did)) network.createAccount(did, host);
      const deps: DmDeps = {
        did,
        memberClient: network.clientFor(did),
        resolvePds: network.resolvePds,
        resolveKemKey: network.resolveKemKey,
        fetchEndpoint: network.fetchEndpoint,
        generateKey: network.generateKey,
        store: createStore(),
        now: () => network.now(),
      };
      instance = new DmClient(deps);
      clients.set(did, instance);
    }
    return instance;
  };
  return { network, client };
}

test("parseParticipantInput splits on commas and whitespace, dedupes, and reports non-DID tokens", () => {
  assert.deepEqual(parseParticipantInput("did:plc:bob, did:plc:carol\tdid:plc:bob\n"), {
    dids: ["did:plc:bob", "did:plc:carol"], invalid: [],
  });
  assert.deepEqual(parseParticipantInput(" did:plc:alice , bob ,did:plc:alice"), {
    dids: ["did:plc:alice"], invalid: ["bob"],
  });
  assert.deepEqual(parseParticipantInput(""), { dids: [], invalid: [] });
  assert.deepEqual(parseParticipantInput("alice.test did:web:example.com"), {
    dids: ["did:web:example.com"], invalid: ["alice.test"],
  });
});

test("workspace filtering shows only conversations whose other participants are all co-members", () => {
  const base = { viewerDid: "did:plc:me", memberDids: ["did:plc:me", "did:plc:mate"] as readonly string[], showAll: false };
  assert.equal(conversationVisible({ participants: ["did:plc:me", "did:plc:mate"], ...base }), true);
  assert.equal(conversationVisible({ participants: ["did:plc:me", "did:plc:stranger"], ...base }), false);
  assert.equal(conversationVisible({ participants: ["did:plc:me", "did:plc:mate", "did:plc:stranger"], ...base }), false);
  assert.equal(conversationVisible({ participants: ["did:plc:me", "did:plc:stranger"], ...base, showAll: true }), true);
  assert.equal(conversationVisible({ participants: ["did:plc:me", "did:plc:stranger"], ...base, memberDids: null }), true);
});

test("co-members and workspace sharing span every workspace without the viewer", () => {
  const workspaces = [
    { uri: "at://did:plc:a/space/new.flock.workspace/one", name: "One", members: [{ did: "did:plc:me", active: true }, { did: "did:plc:bob", active: true }] },
    { uri: "at://did:plc:a/space/new.flock.workspace/two", name: "Two", members: [{ did: "did:plc:carol", active: true }, { did: "did:plc:bob", active: true }] },
  ];
  assert.deepEqual(coMemberDids(workspaces, "did:plc:me"), ["did:plc:bob", "did:plc:carol"]);
  assert.equal(sharesAnyWorkspace("did:plc:carol", workspaces), true);
  assert.equal(sharesAnyWorkspace("did:plc:stranger", workspaces), false);
});

test("applyAllowlistEdit activates a first entry added while in allowlist mode (M4 review carry-over)", async () => {
  const { network, client } = harness();
  network.createAccount("did:plc:alice", "pds1");
  network.createAccount("did:plc:carol", "pds2");
  const alice = client("did:plc:alice");
  const carol = client("did:plc:carol", "pds2");

  await alice.enableDms("allowlist");
  assert.deepEqual(await alice.getInbox(), { exists: true, mode: "nobody", allowlist: [] },
    "an empty allowlist is indistinguishable from nobody, whatever the user picked");

  await applyAllowlistEdit(alice, { mode: "allowlist", add: ["did:plc:carol"] });
  assert.deepEqual(await alice.getInbox(), { exists: true, mode: "allowlist", allowlist: ["did:plc:carol"] },
    "the edit re-asserts the selected mode, so the first entry is active rather than dormant");

  const started = await carol.startConversation(["did:plc:alice"]);
  assert.equal(started.delivery["did:plc:alice"]?.status, "delivered");
  const requests = await alice.listRequests();
  assert.equal(requests.length, 1, "carol's request is tracked and visible under the allowlist");
});

test("allow() alone leaves the first entry dormant; the panel must always re-assert the selected mode", async () => {
  const { network, client } = harness();
  network.createAccount("did:plc:alice", "pds1");
  network.createAccount("did:plc:bob", "pds2");
  const alice = client("did:plc:alice");
  const bob = client("did:plc:bob", "pds2");

  await alice.enableDms("allowlist");
  await alice.allow(["did:plc:bob"]);
  assert.deepEqual(await alice.getInbox(), { exists: true, mode: "nobody", allowlist: ["did:plc:bob"] },
    "allow without setRequestMode parks the entry dormant");

  const started = await bob.startConversation(["did:plc:alice"]);
  assert.equal(started.delivery["did:plc:alice"]?.status, "delivered");
  assert.deepEqual(await alice.listRequests(), [], "a dormant allowlist entry does not make requests visible");

  await applyAllowlistEdit(alice, { mode: "allowlist", add: ["did:plc:bob"] });
  assert.deepEqual(await alice.getInbox(), { exists: true, mode: "allowlist", allowlist: ["did:plc:bob"] });
});

test("applyAllowlistEdit removes entries and re-asserts nobody so nothing new is tracked", async () => {
  const { network, client } = harness();
  network.createAccount("did:plc:alice", "pds1");
  const alice = client("did:plc:alice");

  await alice.enableDms("allowlist", ["did:plc:bob"]);
  await applyAllowlistEdit(alice, { mode: "nobody", remove: ["did:plc:bob"] });
  assert.deepEqual(await alice.getInbox(), { exists: true, mode: "nobody", allowlist: [] });
});

test("describeSkippedSenders is empty when nothing was skipped and names each cause otherwise", () => {
  assert.equal(describeSkippedSenders({ oversizedWriters: [], failedWriters: [], writerSetTruncated: false }), "");
  assert.equal(
    describeSkippedSenders({ oversizedWriters: ["did:plc:a"], failedWriters: [{ did: "did:plc:b", reason: "x" }, { did: "did:plc:c", reason: "y" }], writerSetTruncated: true }),
    "Some senders were skipped: 1 sender sent too many requests; 2 senders could not be reached; more senders exist than could be scanned.",
  );
});

test("retainAfterRefresh drops window entries from readable halves but keeps copies from halves that can no longer be read", () => {
  // #given
  const current = [
    { ownerDid: "did:plc:alice", rkey: "3", text: "deleted by its author" },
    { ownerDid: "did:plc:alice", rkey: "1", text: "older than the window" },
    { ownerDid: "did:plc:bob", rkey: "4", text: "bob left, but this copy was already fetched" },
  ];
  const halves = { "did:plc:alice": "ok", "did:plc:bob": "deleted" } as const;

  // #when
  const kept = retainAfterRefresh(current, halves, (entry) => entry.rkey >= "2");

  // #then
  assert.deepEqual(kept.map((entry) => entry.text), ["older than the window", "bob left, but this copy was already fetched"]);
});

function cycleHarness(failing: ReadonlySet<string> = new Set(), exists = true) {
  const calls: string[] = [];
  const errors: string[] = [];
  const declarationChecked = { current: false };
  const record = (name: string) => {
    calls.push(name);
    if (failing.has(name)) throw new Error(`${name} failed`);
  };
  const run = () => runDmCycle({
    refresh: async () => { calls.push("refresh"); if (failing.has("refresh")) throw new Error("refresh failed"); return { exists }; },
    client: {
      renotifyPending: async () => record("renotify"),
      watch: async () => { record("watch"); return {}; },
      ensureDeclaration: async () => record("declaration"),
    },
    inboxUri: "at://did:plc:a/space/new.flock.dm.inbox/self", serviceRef: "did:web:app#svc", declarationChecked,
    report: (error) => errors.push(error instanceof Error ? error.message : String(error)),
  });
  return { calls, errors, declarationChecked, run };
}

test("a DM cycle runs every step in order and marks the declaration checked", async () => {
  const cycle = cycleHarness();
  await cycle.run();
  assert.deepEqual(cycle.calls, ["refresh", "renotify", "watch", "declaration"]);
  assert.deepEqual(cycle.errors, []);
  assert.equal(cycle.declarationChecked.current, true);
});

test("a failing renotify or watch does not keep the declaration from being repaired", async () => {
  const cycle = cycleHarness(new Set(["renotify", "watch"]));
  await cycle.run();
  assert.deepEqual(cycle.calls, ["refresh", "renotify", "watch", "declaration"], "the declaration step still ran");
  assert.deepEqual(cycle.errors, ["renotify failed", "watch failed"], "both failures were reported");
  assert.equal(cycle.declarationChecked.current, true);
});

test("a failing declaration check does not keep notifications registered, and is retried next cycle", async () => {
  const cycle = cycleHarness(new Set(["declaration"]));
  await cycle.run();
  assert.deepEqual(cycle.calls, ["refresh", "renotify", "watch", "declaration"], "watch ran before the failing declaration step");
  assert.equal(cycle.declarationChecked.current, false, "not marked checked, so the next cycle tries again");
  await cycle.run();
  assert.equal(cycle.calls.filter((call) => call === "declaration").length, 2);
});

test("a DM cycle whose refresh fails reports it and stops, and a cycle with no inbox neither watches nor checks the declaration", async () => {
  const refreshFails = cycleHarness(new Set(["refresh"]));
  await refreshFails.run();
  assert.deepEqual(refreshFails.calls, ["refresh"]);
  assert.deepEqual(refreshFails.errors, ["refresh failed"]);
  const noInbox = cycleHarness(new Set(), false);
  await noInbox.run();
  assert.deepEqual(noInbox.calls, ["refresh", "renotify"]);
});

test("a participant's half shows a note only for a state that is known, and nothing before the first page loads", () => {
  assert.equal(halfChip(undefined), null, "unloaded: not 'missing', which would flash on the viewer's own row");
  assert.equal(halfChip("ok"), null);
  assert.equal(halfChip("missing"), "hasn't replied or removed your access");
  assert.equal(halfChip("deleted"), "left");
  assert.equal(halfChip("revoked"), "revoked your access");
});
