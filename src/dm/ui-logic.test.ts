import assert from "node:assert/strict";
import test from "node:test";
import { DmClient, type DmDeps, type DmStore } from "./dm-client";
import { FakeDmNetwork } from "./testing/fake-pds";
import { applyAllowlistEdit, coMemberDids, conversationVisible, describeSkippedSenders, parseParticipantInput, retainAfterRefresh, sharesAnyWorkspace } from "./ui-logic";

function createStore(): DmStore {
  const map = new Map<string, string>();
  return {
    async get(key) { return map.has(key) ? map.get(key)! : null; },
    async set(key, value) { map.set(key, value); },
    async delete(key) { map.delete(key); },
  };
}

function harness() {
  const network = new FakeDmNetwork();
  const clients = new Map<string, DmClient>();
  const client = (did: string, host = "pds1"): DmClient => {
    let instance = clients.get(did);
    if (!instance) {
      if (!network.hasAccount(did)) network.createAccount(did, host);
      const deps: DmDeps = {
        did,
        memberClient: network.clientFor(did),
        resolvePds: network.resolvePds,
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
    { uri: "at://did:plc:a/space/org.slack.workspace/one", name: "One", members: [{ did: "did:plc:me", active: true }, { did: "did:plc:bob", active: true }] },
    { uri: "at://did:plc:a/space/org.slack.workspace/two", name: "Two", members: [{ did: "did:plc:carol", active: true }, { did: "did:plc:bob", active: true }] },
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
