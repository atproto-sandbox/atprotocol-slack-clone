import assert from "node:assert/strict";
import test from "node:test";
import { dmConversationUri, spaceRecordUri } from "@/protocol/keys";
import { DmClient, type DmDeps, type DmStore } from "./dm-client";
import { FakeDmNetwork } from "./testing/fake-pds";

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
  const client = (did: string, host = "pds1", overrides: Partial<DmDeps> = {}): DmClient => {
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
        ...overrides,
      };
      instance = new DmClient(deps);
      clients.set(did, instance);
    }
    return instance;
  };
  return { network, client };
}

test("enableDms and getInbox round-trip every request-policy mode, preserving the allowlist through nobody", async () => {
  const { network, client } = harness();
  network.createAccount("did:plc:alice", "pds1");
  const alice = client("did:plc:alice");

  assert.deepEqual(await alice.getInbox(), { exists: false, mode: "allowlist", allowlist: [] });

  await alice.enableDms("allowlist", ["did:plc:bob"]);
  assert.deepEqual(await alice.getInbox(), { exists: true, mode: "allowlist", allowlist: ["did:plc:bob"] });

  await alice.setRequestMode("everyone");
  assert.deepEqual(await alice.getInbox(), { exists: true, mode: "everyone", allowlist: ["did:plc:bob"] });

  await alice.setRequestMode("nobody");
  assert.deepEqual(await alice.getInbox(), { exists: true, mode: "nobody", allowlist: ["did:plc:bob"] },
    "nobody deactivates bob to a dormant entry; he stays on the allowlist until explicitly disallowed");

  await alice.setRequestMode("allowlist");
  assert.deepEqual(await alice.getInbox(), { exists: true, mode: "allowlist", allowlist: ["did:plc:bob"] },
    "switching back reactivates the dormant entry without re-adding it");

  await alice.disallow(["did:plc:bob"]);
  assert.deepEqual(await alice.getInbox(), { exists: true, mode: "nobody", allowlist: [] });

  // An empty memberList inbox is indistinguishable from "nobody" until
  // someone is (re)activated (documented lossiness in `modeForInboxPolicy`),
  // so allow() here records carol dormant; setRequestMode is what reopens it.
  await alice.allow(["did:plc:carol"]);
  assert.deepEqual(await alice.getInbox(), { exists: true, mode: "nobody", allowlist: ["did:plc:carol"] });
  await alice.setRequestMode("allowlist");
  assert.deepEqual(await alice.getInbox(), { exists: true, mode: "allowlist", allowlist: ["did:plc:carol"] });
});

test("switching allowlist -> nobody -> allowlist preserves the allowlist and tracks writes again only after reactivating", async () => {
  const { network, client } = harness();
  network.createAccount("did:plc:alice", "pds1");
  network.createAccount("did:plc:carol", "pds2");
  const alice = client("did:plc:alice");
  const carol = client("did:plc:carol");

  await alice.enableDms("allowlist", ["did:plc:carol"]);
  await alice.setRequestMode("nobody");
  assert.deepEqual((await alice.getInbox()).allowlist, ["did:plc:carol"], "carol stays on the allowlist, just dormant");

  const started = await carol.startConversation(["did:plc:alice"]);
  assert.equal(started.delivery["did:plc:alice"]?.status, "delivered", "the write itself always succeeds (M0 §6g)");
  assert.deepEqual(await alice.listRequests(), [], "a dormant member's write is stored but not tracked");

  await alice.setRequestMode("allowlist");
  assert.deepEqual(await alice.listRequests(), [], "reactivating alone does not retroactively track carol's earlier untracked write");

  network.advanceClock(61_000);
  await carol.renotifyPending();
  const requests = await alice.listRequests();
  assert.equal(requests.length, 1, "carol's next write, made while active again, is now tracked");
  assert.equal(requests[0]!.convKey, started.convKey);
});

test("accepting a request while in nobody mode adds the sender dormant and does not switch the mode", async () => {
  const { network, client } = harness();
  network.createAccount("did:plc:alice", "pds1");
  network.createAccount("did:plc:bob", "pds2");
  const alice = client("did:plc:alice");
  const bob = client("did:plc:bob");

  await bob.enableDms("everyone");
  await alice.startConversation(["did:plc:bob"]);
  const [request] = await bob.listRequests();
  assert.ok(request);

  await bob.setRequestMode("nobody");
  await bob.accept(request!);
  assert.deepEqual(await bob.getInbox(), { exists: true, mode: "nobody", allowlist: ["did:plc:alice"] },
    "accepting always records the sender, but does not silently switch nobody to allowlist");
});

test("switching everyone -> allowlist restores a previously-allowed member as active without re-adding them", async () => {
  const { network, client } = harness();
  network.createAccount("did:plc:alice", "pds1");
  const alice = client("did:plc:alice");

  await alice.enableDms("everyone");
  await alice.allow(["did:plc:dave"]);
  assert.deepEqual((await alice.getInbox()).allowlist, ["did:plc:dave"], "allow() while \"everyone\" is active records dave as active");

  await alice.setRequestMode("allowlist");
  assert.deepEqual(await alice.getInbox(), { exists: true, mode: "allowlist", allowlist: ["did:plc:dave"] });
});

test("listRequests filters already-tracked writers by the current mode, not by what the PDS remembers (M0 §6f)", async () => {
  const { network, client } = harness();
  network.createAccount("did:plc:alice", "pds1");
  network.createAccount("did:plc:carol", "pds2");
  const alice = client("did:plc:alice");
  const carol = client("did:plc:carol");

  await alice.enableDms("everyone");
  const start = await carol.startConversation(["did:plc:alice"]);
  assert.equal(start.delivery["did:plc:alice"]?.status, "delivered");

  const seenUnderEveryone = await alice.listRequests();
  assert.deepEqual(seenUnderEveryone.map((request) => request.sender), ["did:plc:carol"]);

  await alice.setRequestMode("nobody");
  assert.deepEqual(await alice.listRequests(), [], "nobody mode hides even an already-tracked writer");

  // Carol was never a member (only a public-policy tracked writer), so
  // allowing her here records a dormant entry, exactly like accepting a
  // request would while in nobody mode.
  await alice.allow(["did:plc:carol"]);
  assert.deepEqual(await alice.listRequests(), [], "a dormant allow entry is still hidden");

  await alice.setRequestMode("allowlist");
  const seenUnderAllowlist = await alice.listRequests();
  assert.deepEqual(seenUnderAllowlist.map((request) => request.sender), ["did:plc:carol"]);
  assert.equal(seenUnderAllowlist[0]?.convKey, start.convKey);
});

test("startConversation deduplicates identical participant sets and reports noInbox for a recipient without one", async () => {
  const { network, client } = harness();
  network.createAccount("did:plc:alice", "pds1");
  network.createAccount("did:plc:bob", "pds2");
  network.createAccount("did:plc:dan", "pds2");
  const alice = client("did:plc:alice");
  await client("did:plc:bob").enableDms("everyone");

  const first = await alice.startConversation(["did:plc:bob", "did:plc:dan"]);
  assert.equal(first.delivery["did:plc:bob"]?.status, "delivered");
  assert.equal(first.delivery["did:plc:dan"]?.status, "noInbox", "dan never called enableDms");

  const second = await alice.startConversation(["did:plc:dan", "did:plc:bob"]);
  assert.equal(second.convKey, first.convKey, "an identical participant set reuses the existing half");
  assert.deepEqual(second.delivery, {}, "no new requests are sent on dedupe");
});

test("startConversation reports noInbox for a recipient who deleted their inbox", async () => {
  // #given bob enabled DMs and then deleted his inbox space
  const { network, client } = harness();
  network.createAccount("did:plc:alice", "pds1");
  network.createAccount("did:plc:bob", "pds2");
  await client("did:plc:bob").enableDms("everyone");
  await network.clientFor("did:plc:bob").procedure("com.atproto.simplespace.deleteSpace", { space: "at://did:plc:bob/space/org.slack.dm.inbox/self" });

  // #when
  const started = await client("did:plc:alice").startConversation(["did:plc:bob"]);

  // #then
  assert.equal(started.delivery["did:plc:bob"]?.status, "noInbox");
});

test("startConversation reports failed, not delivered, when the inbox probe itself is refused for a reason other than denial", async () => {
  // #given the sender's session lacks the scope to ask for a delegation token (not a SpaceCredentialError)
  const { network, client } = harness();
  network.createAccount("did:plc:alice", "pds1");
  network.createAccount("did:plc:bob", "pds2");
  await client("did:plc:bob").enableDms("everyone");
  const real = network.clientFor("did:plc:alice");
  const refusing = Object.create(real, {
    query: { value: async (method: string, ...rest: unknown[]) => {
      if (method === "com.atproto.space.getDelegationToken") throw new Error("Missing required scope");
      return (real.query as (method: string, ...rest: unknown[]) => Promise<unknown>)(method, ...rest);
    } },
  });
  const alice = client("did:plc:alice", "pds1", { memberClient: refusing });

  // #when
  const started = await alice.startConversation(["did:plc:bob"]);

  // #then
  assert.equal(started.delivery["did:plc:bob"]?.status, "failed");
  assert.match(started.delivery["did:plc:bob"]?.message ?? "", /Missing required scope/);
});

test("accept creates the reader's own half, matches the header, and always allows the sender (so a later mode switch does not lock them out)", async () => {
  const { network, client } = harness();
  network.createAccount("did:plc:alice", "pds1");
  network.createAccount("did:plc:bob", "pds2");
  const alice = client("did:plc:alice");
  const bob = client("did:plc:bob");
  await bob.enableDms("everyone");

  const started = await alice.startConversation(["did:plc:bob"]);
  const [request] = await bob.listRequests();
  assert.ok(request);
  assert.equal(request!.convKey, started.convKey);

  // Switching to allowlist mode before replying must not block accepting a
  // request already in hand.
  await bob.setRequestMode("allowlist");
  await bob.accept(request!);
  assert.deepEqual((await bob.getInbox()).allowlist, ["did:plc:alice"], "accepting always allows the sender");

  const conversations = await bob.listConversations();
  assert.deepEqual(conversations.map((c) => c.convKey), [started.convKey]);
});

test("send, edit, delete, react and unreact validate locally and only touch the caller's own records", async () => {
  const { network, client } = harness();
  network.createAccount("did:plc:alice", "pds1");
  network.createAccount("did:plc:bob", "pds2");
  const alice = client("did:plc:alice");
  const bob = client("did:plc:bob");
  await bob.enableDms("everyone");
  const started = await alice.startConversation(["did:plc:bob"]);
  await bob.accept((await bob.listRequests())[0]!);

  const message = await alice.send(started.convKey, "hello bob");
  assert.equal(message.text, "hello bob");
  await assert.rejects(alice.send(started.convKey, ""), /Invalid org\.slack\.dm\.message record/, "empty text fails local validation before any write");

  await alice.edit(message.uri, "hello again bob");
  const forgedUri = spaceRecordUri(dmConversationUri("did:plc:bob", started.convKey), "did:plc:bob", "org.slack.dm.message", "notmine22222");
  await assert.rejects(alice.edit(forgedUri, "nope"), /Can only modify your own DM messages/);
  await assert.rejects(bob.delete(message.uri), /Can only modify your own DM messages/);

  await alice.react(message.uri, "👍");
  const page = await alice.readConversation(started.convKey, started.participants);
  assert.deepEqual(page.reactions.map((r) => ({ subject: r.subject, emoji: r.emoji })), [{ subject: message.uri, emoji: "👍" }]);

  await alice.unreact(message.uri, "👍");
  const afterUnreact = await alice.readConversation(started.convKey, started.participants);
  assert.deepEqual(afterUnreact.reactions, []);

  await alice.delete(message.uri);
  const afterDelete = await alice.readConversation(started.convKey, started.participants);
  assert.deepEqual(afterDelete.messages.map((m) => m.uri), []);
});

test("readConversation merges both halves newest-first, paginates with before, and reports per-half status", async () => {
  const { network, client } = harness();
  network.createAccount("did:plc:alice", "pds1");
  network.createAccount("did:plc:bob", "pds2");
  network.createAccount("did:plc:eve", "pds1");
  const alice = client("did:plc:alice");
  const bob = client("did:plc:bob");
  await bob.enableDms("everyone");
  const started = await alice.startConversation(["did:plc:bob"]);
  await bob.accept((await bob.listRequests())[0]!);

  await alice.send(started.convKey, "alice-1");
  network.advanceClock(2);
  await bob.send(started.convKey, "bob-1");
  network.advanceClock(2);
  await alice.send(started.convKey, "alice-2");
  network.advanceClock(2);
  await bob.send(started.convKey, "bob-2");

  const first = await alice.readConversation(started.convKey, started.participants, { limit: 2 });
  assert.deepEqual(first.messages.map((m) => m.text), ["bob-2", "alice-2"]);
  assert.equal(first.halves["did:plc:alice"], "ok");
  assert.equal(first.halves["did:plc:bob"], "ok");
  assert.ok(first.nextBefore);

  const second = await alice.readConversation(started.convKey, started.participants, { limit: 2, before: first.nextBefore });
  assert.deepEqual(second.messages.map((m) => m.text), ["bob-1", "alice-1"]);
  assert.equal(second.nextBefore, undefined);

  const eve = client("did:plc:eve");
  const asEve = await eve.readConversation(started.convKey, started.participants);
  assert.equal(asEve.halves["did:plc:alice"], "revoked", "a non-participant is not on either half's member list");
});

test("leave revokes the leaver's half for the other participant, and deleteEverything removes the deleter's own half", async () => {
  const { network, client } = harness();
  network.createAccount("did:plc:alice", "pds1");
  network.createAccount("did:plc:bob", "pds2");
  const alice = client("did:plc:alice");
  const bob = client("did:plc:bob");
  await bob.enableDms("everyone");
  const started = await alice.startConversation(["did:plc:bob"]);
  await bob.accept((await bob.listRequests())[0]!);
  await bob.send(started.convKey, "hi");

  await bob.leave(started.convKey);
  const afterLeave = await alice.readConversation(started.convKey, started.participants);
  assert.equal(afterLeave.halves["did:plc:bob"], "revoked");
  assert.equal(afterLeave.halves["did:plc:alice"], "ok");

  await alice.deleteEverything(started.convKey);
  const afterDelete = await bob.readConversation(started.convKey, started.participants);
  assert.equal(afterDelete.halves["did:plc:alice"], "deleted");
});

test("a half deleted after its credential was cached is reported as deleted, not as a participant who has not replied", async () => {
  // #given bob already holds a credential for alice's half
  const { network, client } = harness();
  network.createAccount("did:plc:alice", "pds1");
  network.createAccount("did:plc:bob", "pds2");
  const alice = client("did:plc:alice");
  const bob = client("did:plc:bob");
  await bob.enableDms("everyone");
  const started = await alice.startConversation(["did:plc:bob"]);
  await alice.send(started.convKey, "hi");
  assert.equal((await bob.readConversation(started.convKey, started.participants)).halves["did:plc:alice"], "ok");

  // #when alice deletes everything and bob reads again with the same engine
  await alice.deleteEverything(started.convKey);
  const afterDelete = await bob.readConversation(started.convKey, started.participants);

  // #then
  assert.equal(afterDelete.halves["did:plc:alice"], "deleted");
});

test("renotifyPending re-sends the request only once its backoff interval has elapsed, and stops once the recipient has a half", async () => {
  const { network, client } = harness();
  network.createAccount("did:plc:alice", "pds1");
  network.createAccount("did:plc:bob", "pds2");
  const alice = client("did:plc:alice");
  const bob = client("did:plc:bob");
  await bob.enableDms("nobody");
  await alice.startConversation(["did:plc:bob"]);
  assert.deepEqual(await bob.listRequests(), [], "bob's inbox is closed, so the first request was stored but not tracked");

  await alice.renotifyPending();
  network.advanceClock(59_000);
  await alice.renotifyPending();
  // allow() while bob is still in nobody mode records alice dormant;
  // setRequestMode is the separate, explicit step that reopens the inbox.
  await bob.allow(["did:plc:alice"]);
  await bob.setRequestMode("allowlist");
  assert.deepEqual(await bob.listRequests(), [], "alice is now allowed, but her only write so far was never tracked, and the retry isn't due yet either");

  network.advanceClock(2_000);
  await alice.renotifyPending();
  const [request] = await bob.listRequests();
  assert.ok(request, "the re-put after the 1-minute backoff is now tracked under the allowlist");

  await bob.accept(request!);
  network.advanceClock(10 * 60_000 + 1_000);
  await alice.renotifyPending();
  const conversations = await alice.listConversations();
  assert.ok(conversations.some((c) => c.convKey === request!.convKey), "alice's own half is listed");
});

test("listConversations lists only the caller's own halves, so a pending request never enters it", async () => {
  const { network, client } = harness();
  network.createAccount("did:plc:alice", "pds1");
  network.createAccount("did:plc:bob", "pds1");
  const alice = client("did:plc:alice");
  const bob = client("did:plc:bob");
  await bob.enableDms("everyone");
  await alice.startConversation(["did:plc:bob"]);

  assert.equal((await bob.listRequests()).length, 1);
  assert.deepEqual(await bob.listConversations(), []);
});

test("a sender with too many requests is skipped and reported instead of failing the whole scan", async () => {
  const { network, client } = harness();
  for (const did of ["did:plc:bob", "did:plc:carol", "did:plc:dave", "did:plc:x1", "did:plc:x2", "did:plc:x3"]) network.createAccount(did, "pds1");
  const bob = client("did:plc:bob", "pds1", { limits: { maxRequestsPerWriter: 2 } });
  await bob.enableDms("everyone");
  const carol = client("did:plc:carol");
  for (const extra of ["did:plc:x1", "did:plc:x2", "did:plc:x3"]) await carol.startConversation(["did:plc:bob", extra]);
  await client("did:plc:dave").startConversation(["did:plc:bob"]);

  const scan = await bob.scanRequests();
  assert.deepEqual(scan.requests.map((request) => request.sender), ["did:plc:dave"]);
  assert.deepEqual(scan.skipped, { oversizedWriters: ["did:plc:carol"], failedWriters: [], writerSetTruncated: false });
  assert.deepEqual((await bob.listRequests()).map((request) => request.sender), ["did:plc:dave"]);
});

test("a sender whose host cannot be reached is skipped and reported, and other senders still load", async () => {
  const { network, client } = harness();
  for (const did of ["did:plc:bob", "did:plc:carol", "did:plc:dave"]) network.createAccount(did, "pds1");
  const bob = client("did:plc:bob", "pds1", {
    resolvePds: async (did) => {
      if (did === "did:plc:carol") throw new TypeError("fetch failed");
      return network.resolvePds(did);
    },
  });
  await bob.enableDms("everyone");
  await client("did:plc:carol").startConversation(["did:plc:bob"]);
  await client("did:plc:dave").startConversation(["did:plc:bob"]);

  const scan = await bob.scanRequests();
  assert.deepEqual(scan.requests.map((request) => request.sender), ["did:plc:dave"]);
  assert.deepEqual(scan.skipped.failedWriters, [{ did: "did:plc:carol", reason: "fetch failed" }]);
  assert.equal(scan.skipped.writerSetTruncated, false);
});

test("a tracked writer set beyond the scan limit is truncated and flagged, not fatal", async () => {
  const { network, client } = harness();
  for (const did of ["did:plc:bob", "did:plc:carol", "did:plc:dave"]) network.createAccount(did, "pds1");
  const bob = client("did:plc:bob", "pds1", { limits: { maxInboxScan: 1 } });
  await bob.enableDms("everyone");
  await client("did:plc:carol").startConversation(["did:plc:bob"]);
  await client("did:plc:dave").startConversation(["did:plc:bob"]);

  const scan = await bob.scanRequests();
  assert.equal(scan.skipped.writerSetTruncated, true);
  assert.equal(scan.requests.length, 1);
});

test("a local store failure while scanning requests propagates instead of masquerading as an unreachable sender", async () => {
  const { network, client } = harness();
  for (const did of ["did:plc:bob", "did:plc:carol"]) network.createAccount(did, "pds1");
  const bob = client("did:plc:bob", "pds1", {
    store: { async get() { throw new Error("store down"); }, async set() {}, async delete() {} },
  });
  await bob.enableDms("everyone");
  await client("did:plc:carol").startConversation(["did:plc:bob"]);

  await assert.rejects(bob.scanRequests(), /store down/);
});
