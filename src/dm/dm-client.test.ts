import assert from "node:assert/strict";
import test from "node:test";
import { SPACE_CREDENTIAL_LIFETIME_MS, SPACE_CREDENTIAL_RENEW_BEFORE_MS } from "@/atproto/space-credential-core";
import { dmConversationUri, dmInboxUri, spaceRecordUri } from "@/protocol/keys";
import { DmClient, type DmDeps, type DmStore } from "./dm-client";
import { FakeNetwork } from "@/testing/fake-network";

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
  const client = (did: string, host = "pds1", overrides: Partial<DmDeps> = {}): DmClient => {
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

test("switching allowlist -> nobody -> allowlist preserves the allowlist, and an allowed sender's earlier request shows again once reactivated", async () => {
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
  const requests = await alice.listRequests();
  assert.equal(requests.length, 1, "carol is an active allowlist entry again, so her request is read although the PDS never tracked it as a writer");
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

  // A dormant (write:false) entry evicts the writer from the PDS writer set, so reactivating carol does not list her
  // as a writer again until she writes again; but she is an active allowlist entry, which the scan reads directly.
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

test("startConversation reports noInbox for a recipient whose inbox space exists but who never published the declaration", async () => {
  // #given bob's inbox was created outside the DM client, so nothing public says he accepts requests
  const { network, client } = harness();
  network.createAccount("did:plc:alice", "pds1");
  network.createAccount("did:plc:bob", "pds2");
  await network.clientFor("did:plc:bob").procedure("com.atproto.space.createSpace", {
    spaceType: "new.flock.dm.inbox", skey: "self", policy: { $type: "com.atproto.memberspace.policy", publicWrite: true },
  });

  // #when
  const started = await client("did:plc:alice").startConversation(["did:plc:bob"]);

  // #then the declaration, not the space, is the signal a sender can read
  assert.equal(started.delivery["did:plc:bob"]?.status, "noInbox");
});

test("enableDms publishes the declaration, and a later enableDms or mode change leaves a valid one alone", async () => {
  // #given bob enabled DMs
  const { network, client } = harness();
  network.createAccount("did:plc:bob", "pds2");
  const bob = client("did:plc:bob");
  const read = () => network.clientFor("did:plc:bob").query<{ cid: string; value: { $type: string; createdAt: string } }>("com.atproto.repo.getRecord", { repo: "did:plc:bob", collection: "new.flock.dm.declaration", rkey: "self" });
  await bob.enableDms("allowlist");
  const first = await read();
  assert.equal(first.value.$type, "new.flock.dm.declaration");
  assert.ok(Number.isFinite(Date.parse(first.value.createdAt)));

  // #when he enables again and changes his request mode later
  network.advanceClock(60_000);
  await bob.enableDms("everyone");
  await bob.setRequestMode("nobody");

  // #then the public record is not rewritten, so a settings change is not a public commit
  assert.equal((await read()).cid, first.cid);
});

test("ensureDeclaration replaces a declaration that is not valid", async () => {
  // #given bob's public repo holds a record under the declaration key that a sender would not accept
  const { network, client } = harness();
  network.createAccount("did:plc:alice", "pds1");
  network.createAccount("did:plc:bob", "pds2");
  const bobRepo = network.clientFor("did:plc:bob");
  const bob = client("did:plc:bob");
  await bob.enableDms("everyone");
  await bobRepo.procedure("com.atproto.repo.putRecord", {
    repo: "did:plc:bob", collection: "new.flock.dm.declaration", rkey: "self", record: { $type: "new.flock.dm.declaration", createdAt: "yesterday" },
  });
  assert.equal((await client("did:plc:alice").startConversation(["did:plc:bob"])).delivery["did:plc:bob"]?.status, "noInbox");

  // #when
  await bob.ensureDeclaration();

  // #then senders accept it again
  network.createAccount("did:plc:carol", "pds1");
  assert.equal((await client("did:plc:carol").startConversation(["did:plc:bob"])).delivery["did:plc:bob"]?.status, "delivered");
});

test("a declaration that outlives an inbox deleted outside the app still reads as an inbox, so the request reads as delivered", async () => {
  // #given bob's inbox was deleted directly, leaving his public declaration behind
  const { network, client } = harness();
  network.createAccount("did:plc:alice", "pds1");
  network.createAccount("did:plc:bob", "pds2");
  await client("did:plc:bob").enableDms("everyone");
  await network.clientFor("did:plc:bob").procedure("com.atproto.space.deleteSpace", { space: dmInboxUri("did:plc:bob") });

  // #when alice starts a conversation with bob
  const started = await client("did:plc:alice").startConversation(["did:plc:bob"]);

  // #then the stale declaration still reads as an inbox, which the pin note documents; the app never deletes an inbox
  assert.deepEqual(started.delivery["did:plc:bob"], { status: "delivered" });
});

test("startConversation reports failed, not delivered, when the declaration cannot be read for a reason other than its absence", async () => {
  // #given bob's PDS answers the public declaration read with a server error
  const { network, client } = harness();
  network.createAccount("did:plc:alice", "pds1");
  network.createAccount("did:plc:bob", "pds2");
  await client("did:plc:bob").enableDms("everyone");
  const alice = client("did:plc:alice", "pds1", {
    fetchEndpoint: async (request) => request.url.includes("com.atproto.repo.getRecord")
      ? new Response(JSON.stringify({ error: "InternalServerError", message: "upstream exploded" }), { status: 500 })
      : network.fetchEndpoint(request),
  });

  // #when
  const started = await alice.startConversation(["did:plc:bob"]);

  // #then
  assert.equal(started.delivery["did:plc:bob"]?.status, "failed");
  assert.match(started.delivery["did:plc:bob"]?.message ?? "", /upstream exploded/);
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

test("an edit keeps a field another app added to the message", async () => {
  // #given alice's DM client, with every record it writes observed
  const { network, client } = harness();
  network.createAccount("did:plc:alice", "pds1");
  network.createAccount("did:plc:bob", "pds2");
  const memberClient = network.clientFor("did:plc:alice");
  const procedure = memberClient.procedure.bind(memberClient);
  const written: Array<Record<string, unknown>> = [];
  memberClient.procedure = (async (method: string, input?: unknown) => {
    if (method === "com.atproto.space.putRecord") written.push((input as { record: Record<string, unknown> }).record);
    return procedure(method, input);
  }) as typeof memberClient.procedure;
  const alice = client("did:plc:alice", "pds1", { memberClient });
  const bob = client("did:plc:bob");
  await bob.enableDms("everyone");
  const started = await alice.startConversation(["did:plc:bob"]);
  await bob.accept((await bob.listRequests())[0]!);
  const message = await alice.send(started.convKey, "hello bob");

  // #and another app added a field to that message
  const half = dmConversationUri("did:plc:alice", started.convKey);
  await procedure("com.atproto.space.putRecord", {
    space: half, repo: "did:plc:alice", collection: "new.flock.dm.message", rkey: message.rkey, record: { ...written.at(-1), pinnedBy: "another-app" },
  });

  // #when alice edits it
  await alice.edit(message.uri, "hello again bob");

  // #then the edit writes the new text and keeps the other app's field
  assert.deepEqual(written.at(-1), { $type: "new.flock.dm.message", text: "hello again bob", createdAt: message.createdAt, pinnedBy: "another-app" });
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
  await assert.rejects(alice.send(started.convKey, ""), /Invalid new\.flock\.dm\.message record/, "empty text fails local validation before any write");

  await alice.edit(message.uri, "hello again bob");
  const forgedUri = spaceRecordUri(dmConversationUri("did:plc:bob", started.convKey), "did:plc:bob", "new.flock.dm.message", "notmine22222");
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
  assert.equal(asEve.halves["did:plc:alice"], "missing", "a non-participant is refused exactly like a half that does not exist");
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
  assert.equal(afterLeave.halves["did:plc:bob"], "missing", "the reference authority answers a revoked reader like a missing half");
  assert.equal(afterLeave.halves["did:plc:alice"], "ok");

  await alice.deleteEverything(started.convKey);
  const afterDelete = await bob.readConversation(started.convKey, started.participants);
  assert.equal(afterDelete.halves["did:plc:alice"], "deleted");
});

test("leaving takes the conversation off this device's list and stops announcing it again", async () => {
  // #given alice in a conversation carol has not answered
  const { network, client } = harness();
  network.createAccount("did:plc:alice", "pds1");
  network.createAccount("did:plc:carol", "pds2");
  const store = createStore();
  const alice = client("did:plc:alice", "pds1", { store });
  await client("did:plc:carol").enableDms("everyone");
  const started = await alice.startConversation(["did:plc:carol"]);

  // #when she leaves it and the interval for announcing it again passes
  await alice.leave(started.convKey);
  network.advanceClock(10 * 60_000);
  await alice.renotifyPending();

  // #then it is off her list and no request was sent again
  assert.deepEqual(await alice.listConversations(), []);
  assert.equal(await store.get(`renotify:${started.convKey}:did:plc:carol`), null);
});

test("starting a conversation again after leaving it readmits the others, lists it again, and asks again only whoever never answered", async () => {
  // #given a conversation bob accepted and carol never answered, which alice then left
  const { network, client } = harness();
  network.createAccount("did:plc:alice", "pds1");
  network.createAccount("did:plc:bob", "pds2");
  network.createAccount("did:plc:carol", "pds2");
  const alice = client("did:plc:alice");
  const bob = client("did:plc:bob");
  await bob.enableDms("everyone");
  await client("did:plc:carol").enableDms("everyone");
  const started = await alice.startConversation(["did:plc:bob", "did:plc:carol"]);
  await alice.send(started.convKey, "hello");
  await bob.accept((await bob.listRequests())[0]!);
  await alice.leave(started.convKey);
  assert.equal((await bob.readConversation(started.convKey, started.participants)).halves["did:plc:alice"], "missing");

  // #when alice starts a conversation with the same people
  const again = await alice.startConversation(["did:plc:carol", "did:plc:bob"]);

  // #then it is the same conversation, on her list again, with her half readable again, and only carol is asked again
  assert.equal(again.convKey, started.convKey);
  assert.deepEqual((await alice.listConversations()).map((conversation) => conversation.convKey), [started.convKey]);
  const asBob = await bob.readConversation(started.convKey, started.participants);
  assert.equal(asBob.halves["did:plc:alice"], "ok");
  assert.deepEqual(asBob.messages.map((message) => message.text), ["hello"]);
  assert.deepEqual(again.delivery, { "did:plc:carol": { status: "delivered" } });
});

test("starting a conversation again uses the half still in use, not one that was left", async () => {
  // #given alice holding two halves with bob, because each started a conversation with the other, and having left her own
  const { network, client } = harness();
  network.createAccount("did:plc:alice", "pds1");
  network.createAccount("did:plc:bob", "pds2");
  const alice = client("did:plc:alice");
  const bob = client("did:plc:bob");
  await alice.enableDms("everyone");
  await bob.enableDms("everyone");
  const hers = await alice.startConversation(["did:plc:bob"]);
  network.advanceClock(1_000);
  const his = await bob.startConversation(["did:plc:alice"]);
  await alice.accept((await alice.listRequests())[0]!);
  await alice.leave(hers.convKey);

  // #when she starts a conversation with bob
  const again = await alice.startConversation(["did:plc:bob"]);

  // #then she gets the one still in use, and the one she left stays off her list
  assert.equal(again.convKey, his.convKey);
  assert.deepEqual((await alice.listConversations()).map((conversation) => conversation.convKey), [his.convKey]);
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
  const [request] = await bob.listRequests();
  assert.ok(request, "alice is an active allowlist entry now, so her request is read even though the PDS never tracked her write");

  network.advanceClock(2_000);
  await alice.renotifyPending();
  assert.equal((await bob.listRequests()).length, 1, "the re-put after the 1-minute backoff does not duplicate it");

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

function countingExchanges(network: FakeNetwork): { fetchEndpoint: DmDeps["fetchEndpoint"]; count: () => number } {
  let exchanges = 0;
  return {
    fetchEndpoint: (request) => {
      if (request.url.includes("com.atproto.space.getSpaceCredential")) exchanges += 1;
      return network.fetchEndpoint(request);
    },
    count: () => exchanges,
  };
}

test("a cached credential is reused until the renewal window opens, then replaced", async () => {
  const { network, client } = harness();
  const exchanges = countingExchanges(network);
  const alice = client("did:plc:alice", "pds1", { fetchEndpoint: exchanges.fetchEndpoint });
  await alice.enableDms("everyone");
  const inbox = dmInboxUri("did:plc:alice");

  await alice.watch([inbox], "did:web:app.test");
  assert.equal(exchanges.count(), 1);

  network.advanceClock(SPACE_CREDENTIAL_LIFETIME_MS - SPACE_CREDENTIAL_RENEW_BEFORE_MS - 1);
  await alice.watch([inbox], "did:web:app.test");
  assert.equal(exchanges.count(), 1, "one millisecond before the window the credential is still reused");

  network.advanceClock(1);
  await alice.watch([inbox], "did:web:app.test");
  assert.equal(exchanges.count(), 2, "inside the renewal window a fresh credential is minted");
});

test("an expired credential is never reused", async () => {
  const { network, client } = harness();
  const exchanges = countingExchanges(network);
  const alice = client("did:plc:alice", "pds1", { fetchEndpoint: exchanges.fetchEndpoint });
  await alice.enableDms("everyone");
  const inbox = dmInboxUri("did:plc:alice");

  await alice.watch([inbox], "did:web:app.test");
  network.advanceClock(SPACE_CREDENTIAL_LIFETIME_MS);
  await alice.watch([inbox], "did:web:app.test");
  assert.equal(exchanges.count(), 2);
});

test("two concurrent callers over an expired credential mint exactly one replacement", async () => {
  const { network, client } = harness();
  const exchanges = countingExchanges(network);
  const alice = client("did:plc:alice", "pds1", { fetchEndpoint: exchanges.fetchEndpoint });
  await alice.enableDms("everyone");
  const inbox = dmInboxUri("did:plc:alice");

  await alice.watch([inbox], "did:web:app.test");
  network.advanceClock(SPACE_CREDENTIAL_LIFETIME_MS);
  await Promise.all([alice.watch([inbox], "did:web:app.test"), alice.watch([inbox], "did:web:app.test")]);
  assert.equal(exchanges.count(), 2);
});

test("a half whose authority still answers UserNotAuthorized is reported revoked, not missing", async () => {
  // #given an authority that tells a refused reader apart from a missing half, as other PDS implementations may
  const { network, client } = harness();
  network.createAccount("did:plc:alice", "pds1");
  network.createAccount("did:plc:bob", "pds2");
  const alice = client("did:plc:alice", "pds1", {
    fetchEndpoint: async (request) => {
      const response = await network.fetchEndpoint(request);
      if (!request.url.includes("getSpaceCredential") || response.ok) return response;
      const body = await response.json() as { error: string; message: string };
      return new Response(JSON.stringify({ ...body, error: body.error === "SpaceNotFound" ? "UserNotAuthorized" : body.error }), { status: response.status });
    },
  });
  const bob = client("did:plc:bob");
  await bob.enableDms("everyone");
  const started = await alice.startConversation(["did:plc:bob"]);
  await bob.accept((await bob.listRequests())[0]!);
  await bob.send(started.convKey, "hi");

  // #when bob leaves, revoking alice's access to his half
  await bob.leave(started.convKey);
  const afterLeave = await alice.readConversation(started.convKey, started.participants);

  // #then
  assert.equal(afterLeave.halves["did:plc:bob"], "revoked");
});

test("setRequestMode keeps the other settings another client put on the inbox policy, and never makes the inbox publicly readable", async () => {
  // #given bob's inbox carries an app allow-list and published members, set by some other client
  const { network, client } = harness();
  network.createAccount("did:plc:bob", "pds2");
  await network.clientFor("did:plc:bob").procedure("com.atproto.space.createSpace", {
    spaceType: "new.flock.dm.inbox", skey: "self",
    policy: { $type: "com.atproto.memberspace.policy", publicRead: true, allowedApps: ["https://other.example/client.json"], publishMembers: true },
  });

  // #when bob switches the request mode here
  await client("did:plc:bob").setRequestMode("everyone");

  // #then only publicWrite changed (and publicRead is forced off)
  const reported = await network.clientFor("did:plc:bob").query<{ policy: Record<string, unknown> }>("com.atproto.space.getSpace", { space: "at://did:plc:bob/space/new.flock.dm.inbox/self" });
  assert.deepEqual(reported.policy, {
    $type: "com.atproto.memberspace.policy", publicRead: false, publicWrite: true,
    allowedApps: ["https://other.example/client.json"], publishMembers: true,
  });
});

test("setRequestMode refuses to rewrite an inbox governed by another policy type", async () => {
  const { network, client } = harness();
  network.createAccount("did:plc:bob", "pds2");
  await network.clientFor("did:plc:bob").procedure("com.atproto.space.createSpace", { spaceType: "new.flock.dm.inbox", skey: "self", policy: { $type: "com.atproto.personalspace.policy" } });
  await assert.rejects(client("did:plc:bob").setRequestMode("everyone"), /unexpected policy/);
});

test("changing the request mode publishes the declaration an inbox created before senders needed one is missing", async () => {
  // #given bob's inbox exists but nothing public says so
  const { network, client } = harness();
  network.createAccount("did:plc:alice", "pds1");
  network.createAccount("did:plc:bob", "pds2");
  await network.clientFor("did:plc:bob").procedure("com.atproto.space.createSpace", { spaceType: "new.flock.dm.inbox", skey: "self", policy: { $type: "com.atproto.memberspace.policy", publicWrite: true } });
  assert.equal((await client("did:plc:alice").startConversation(["did:plc:bob"])).delivery["did:plc:bob"]?.status, "noInbox");

  // #when bob changes his request mode
  await client("did:plc:bob").setRequestMode("everyone");

  // #then senders can find the inbox
  network.createAccount("did:plc:carol", "pds1");
  assert.equal((await client("did:plc:carol").startConversation(["did:plc:bob"])).delivery["did:plc:bob"]?.status, "delivered");
});

test("enableDms publishes the declaration last, so a failure there leaves the allowlist seeded and a second call repairs it", async () => {
  const { network, client } = harness();
  network.createAccount("did:plc:bob", "pds2");
  const real = network.clientFor("did:plc:bob");
  let failures = 1;
  const flaky = Object.create(real, {
    procedure: { value: async (method: string, ...rest: unknown[]) => {
      if (method === "com.atproto.repo.putRecord" && failures-- > 0) throw new Error("Missing required scope");
      return (real.procedure as (method: string, ...rest: unknown[]) => Promise<unknown>)(method, ...rest);
    } },
  });
  const bob = client("did:plc:bob", "pds2", { memberClient: flaky });
  await assert.rejects(bob.enableDms("allowlist", ["did:plc:friend"]), /Missing required scope/);
  assert.deepEqual((await bob.getInbox()).allowlist, ["did:plc:friend"], "the allowlist was seeded before the declaration was attempted");
  await bob.enableDms("allowlist", ["did:plc:friend"]);
  const declaration = await real.query<{ value: { $type: string } }>("com.atproto.repo.getRecord", { repo: "did:plc:bob", collection: "new.flock.dm.declaration", rkey: "self" });
  assert.equal(declaration.value.$type, "new.flock.dm.declaration");
});

test("a 2xx answer that is not the declaration record does not count as one", async () => {
  const { network, client } = harness();
  network.createAccount("did:plc:alice", "pds1");
  network.createAccount("did:plc:bob", "pds2");
  await client("did:plc:bob").enableDms("everyone");
  const alice = client("did:plc:alice", "pds1", {
    fetchEndpoint: async (request) => request.url.includes("com.atproto.repo.getRecord")
      ? new Response(JSON.stringify({ uri: "at://did:plc:bob/app.bsky.actor.profile/self", value: { $type: "app.bsky.actor.profile" } }), { status: 200 })
      : network.fetchEndpoint(request),
  });
  assert.equal((await alice.startConversation(["did:plc:bob"])).delivery["did:plc:bob"]?.status, "noInbox");
});

test("one participant whose header cannot be authenticated reads as a missing half, and the other halves are still read", async () => {
  // #given a conversation in which bob's host answers the header read with a record its MAC does not cover
  const { network, client } = harness();
  network.createAccount("did:plc:alice", "pds1");
  network.createAccount("did:plc:bob", "pds2");
  const alice = client("did:plc:alice", "pds1", {
    fetchEndpoint: async (request) => {
      const response = await network.fetchEndpoint(request);
      if (!request.url.includes("getRecord") || !request.url.includes("new.flock.dm.header") || !request.url.includes("repo=did%3Aplc%3Abob") || !response.ok) return response;
      const body = await response.json() as { value: Record<string, unknown> };
      return new Response(JSON.stringify({ ...body, value: { ...body.value, createdAt: "2000-01-01T00:00:00.000Z" } }), { status: 200, headers: response.headers });
    },
  });
  const bob = client("did:plc:bob");
  await bob.enableDms("everyone");
  const started = await alice.startConversation(["did:plc:bob"]);
  await bob.accept((await bob.listRequests())[0]!);
  await bob.send(started.convKey, "hi alice");

  // #when alice reads the conversation
  const page = await alice.readConversation(started.convKey, started.participants);

  // #then bob's half is unreadable but the read as a whole succeeds, and nothing from the unverified half is shown
  assert.equal(page.halves["did:plc:bob"], "missing");
  assert.equal(page.halves["did:plc:alice"], "ok");
  assert.deepEqual(page.messages.filter((message) => message.ownerDid === "did:plc:bob"), []);
});

test("a declaration without its timestamp does not count, so the recipient reads as having no inbox", async () => {
  const { network, client } = harness();
  network.createAccount("did:plc:alice", "pds1");
  network.createAccount("did:plc:bob", "pds2");
  await client("did:plc:bob").enableDms("everyone");
  const alice = client("did:plc:alice", "pds1", {
    fetchEndpoint: async (request) => request.url.includes("com.atproto.repo.getRecord")
      ? new Response(JSON.stringify({ uri: "at://did:plc:bob/new.flock.dm.declaration/self", value: { $type: "new.flock.dm.declaration" } }), { status: 200 })
      : network.fetchEndpoint(request),
  });
  assert.equal((await alice.startConversation(["did:plc:bob"])).delivery["did:plc:bob"]?.status, "noInbox");
});

test("ensureDeclaration publishes a missing declaration and leaves an existing one alone", async () => {
  const { network, client } = harness();
  network.createAccount("did:plc:alice", "pds1");
  network.createAccount("did:plc:bob", "pds2");
  await network.clientFor("did:plc:bob").procedure("com.atproto.space.createSpace", { spaceType: "new.flock.dm.inbox", skey: "self", policy: { $type: "com.atproto.memberspace.policy", publicWrite: true } });
  const bob = client("did:plc:bob");
  await bob.ensureDeclaration();
  const first = await network.clientFor("did:plc:bob").query<{ cid: string }>("com.atproto.repo.getRecord", { repo: "did:plc:bob", collection: "new.flock.dm.declaration", rkey: "self" });
  network.advanceClock(60_000);
  await bob.ensureDeclaration();
  const second = await network.clientFor("did:plc:bob").query<{ cid: string }>("com.atproto.repo.getRecord", { repo: "did:plc:bob", collection: "new.flock.dm.declaration", rkey: "self" });
  assert.equal(second.cid, first.cid, "an existing declaration is not rewritten");
  assert.equal((await client("did:plc:alice").startConversation(["did:plc:bob"])).delivery["did:plc:bob"]?.status, "delivered");
});

test("scanning does not ask an allowlisted member who never wrote again on every poll", async () => {
  // #given alice allows two members who have not written, and counts the reads that go to their hosts
  const { network, client } = harness();
  network.createAccount("did:plc:alice", "pds1");
  network.createAccount("did:plc:carol", "pds2");
  network.createAccount("did:plc:dan", "pds2");
  const reads: string[] = [];
  const alice = client("did:plc:alice", "pds1", {
    fetchEndpoint: async (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("com.atproto.space.listRecords")) reads.push(url.searchParams.get("repo") ?? "");
      return network.fetchEndpoint(request);
    },
  });
  await alice.enableDms("allowlist", ["did:plc:carol", "did:plc:dan"]);

  // #when she scans twice
  await alice.scanRequests();
  const afterFirst = reads.length;
  await alice.scanRequests();

  // #then the second scan asks nobody
  assert.equal(afterFirst, 2, "each member is asked once");
  assert.equal(reads.length, afterFirst, "an answer of nothing to read is trusted until it ages or the allowlist changes");

  // #and once the answer has aged they are asked again
  network.advanceClock(5 * 60_000 + 1);
  await alice.scanRequests();
  assert.equal(reads.length, afterFirst + 2);
});

test("a member who wrote while switched off is read again after the mode change, even if the last scan found nothing to read from them", async () => {
  // #given alice scanned while carol, an active allowlist member, had not written
  const { network, client } = harness();
  network.createAccount("did:plc:alice", "pds1");
  network.createAccount("did:plc:carol", "pds2");
  const alice = client("did:plc:alice");
  await alice.enableDms("allowlist", ["did:plc:carol"]);
  assert.deepEqual(await alice.listRequests(), []);

  // #when alice switches DMs off, carol writes (stored, untracked), and alice switches back to the allowlist
  await alice.setRequestMode("nobody");
  const started = await client("did:plc:carol").startConversation(["did:plc:alice"]);
  await alice.setRequestMode("allowlist");

  // #then the cached "nothing to read" answer did not hide her request
  const requests = await alice.listRequests();
  assert.deepEqual(requests.map((request) => request.convKey), [started.convKey]);
});

async function conversationWithBob(options: { aliceFetch?: (request: Request, real: (request: Request) => Promise<Response>) => Promise<Response> } = {}) {
  const { network, client } = harness();
  network.createAccount("did:plc:alice", "pds1");
  network.createAccount("did:plc:bob", "pds2");
  const alice = client("did:plc:alice", "pds1", options.aliceFetch
    ? { fetchEndpoint: (request) => options.aliceFetch!(request, network.fetchEndpoint) }
    : {});
  const bob = client("did:plc:bob");
  await bob.enableDms("everyone");
  const started = await alice.startConversation(["did:plc:bob"]);
  await bob.accept((await bob.listRequests())[0]!);
  await alice.send(started.convKey, "hi bob");
  network.advanceClock(2);
  await bob.send(started.convKey, "hi alice");
  return { network, alice, bob, started };
}

const bobsRepo = (request: Request, collection: string) => request.url.includes("repo=did%3Aplc%3Abob") && request.url.includes(collection);
const hostFailure = () => new Response(JSON.stringify({ error: "UpstreamFailure", message: "Bad Gateway" }), { status: 502, headers: { "content-type": "application/json" } });

test("a participant whose account was deactivated reads as a missing half, and the other halves are still read", async () => {
  // #given a conversation in which bob's account is then deactivated (the authority still issues credentials for it)
  const { network, alice, started } = await conversationWithBob();
  network.setAccountState("did:plc:bob", "deactivated");

  // #when alice reads the conversation
  const page = await alice.readConversation(started.convKey, started.participants);

  // #then the read succeeds, bob's half is missing and shows nothing, and alice's own messages remain
  assert.equal(page.halves["did:plc:bob"], "missing");
  assert.equal(page.halves["did:plc:alice"], "ok");
  assert.deepEqual(page.messages.map((message) => message.text), ["hi bob"]);
});

test("a participant whose account was taken down reads as a missing half too", async () => {
  const { network, alice, started } = await conversationWithBob();
  network.setAccountState("did:plc:bob", "takendown");
  const page = await alice.readConversation(started.convKey, started.participants);
  assert.equal(page.halves["did:plc:bob"], "missing");
  assert.deepEqual(page.messages.map((message) => message.text), ["hi bob"]);
});

test("a participant whose host fails while its messages are listed reads as a missing half and none of its messages are shown", async () => {
  // #given bob's host answers the header read but fails the message listing
  const { alice, started } = await conversationWithBob({
    aliceFetch: async (request, real) => bobsRepo(request, "new.flock.dm.message") ? hostFailure() : real(request),
  });

  // #when alice reads the conversation
  const page = await alice.readConversation(started.convKey, started.participants);

  // #then bob's half is reported missing, the read still succeeds, and alice's messages are shown
  assert.equal(page.halves["did:plc:bob"], "missing");
  assert.deepEqual(page.messages.map((message) => message.text), ["hi bob"]);
});

test("a participant whose host fails while its reactions are listed is reported as a missing half instead of silently showing none", async () => {
  // #given bob's host answers the header and the messages but fails the reaction listing
  const { alice, started } = await conversationWithBob({
    aliceFetch: async (request, real) => bobsRepo(request, "new.flock.dm.reaction") ? hostFailure() : real(request),
  });

  // #when alice reads the conversation
  const page = await alice.readConversation(started.convKey, started.participants);

  // #then both halves' messages are shown and bob's half is flagged
  assert.equal(page.halves["did:plc:bob"], "missing");
  assert.deepEqual(page.messages.map((message) => message.text), ["hi alice", "hi bob"]);
  assert.deepEqual(page.reactions, []);
});

test("a failure reading the caller's own half fails the read instead of marking every half missing", async () => {
  // #given alice's own host fails while her own half's header is read (for example she is offline)
  const { alice, started } = await conversationWithBob({
    aliceFetch: async (request, real) => request.url.includes("repo=did%3Aplc%3Aalice") && request.url.includes("new.flock.dm.header") ? hostFailure() : real(request),
  });

  // #when/#then the read rejects, so the caller sees an error rather than a conversation in which nobody is reachable
  await assert.rejects(alice.readConversation(started.convKey, started.participants), /Bad Gateway/);
});

test("a cached credential a participant's host refuses is dropped, so the next read mints another instead of failing until it expires", async () => {
  // #given alice holds a cached credential for bob's half, and bob's host refuses it once (for example its clock disagrees)
  let mints = 0;
  let refuseBobHeaderOnce = false;
  const { alice, started } = await conversationWithBob({
    aliceFetch: async (request, real) => {
      if (request.url.includes("getSpaceCredential")) mints += 1;
      if (refuseBobHeaderOnce && bobsRepo(request, "new.flock.dm.header")) {
        refuseBobHeaderOnce = false;
        return new Response(JSON.stringify({ error: "InvalidToken", message: "expired" }), { status: 401, headers: { "content-type": "application/json" } });
      }
      return real(request);
    },
  });
  assert.equal((await alice.readConversation(started.convKey, started.participants)).halves["did:plc:bob"], "ok");
  const mintsAfterFirstRead = mints;

  // #when the refusal happens, and alice reads again
  refuseBobHeaderOnce = true;
  const refused = await alice.readConversation(started.convKey, started.participants);
  const retried = await alice.readConversation(started.convKey, started.participants);

  // #then the refused read reports the half as missing without throwing, and the next read re-mints and reads it
  assert.equal(refused.halves["did:plc:bob"], "missing");
  assert.equal(retried.halves["did:plc:bob"], "ok");
  assert.ok(mints > mintsAfterFirstRead, "a fresh credential was minted for bob's half");
});

test("paging a conversation where two halves share message keys at a page boundary shows every message once", async () => {
  const { network, client } = harness();
  network.createAccount("did:plc:alice", "pds1");
  network.createAccount("did:plc:bob", "pds2");
  const alice = client("did:plc:alice");
  const bob = client("did:plc:bob");
  await bob.enableDms("everyone");
  const started = await alice.startConversation(["did:plc:bob"]);
  await bob.accept((await bob.listRequests())[0]!);
  const keys = ["3jzfcijpj2z2a", "3jzfcijpj2z2b", "3jzfcijpj2z2c"];
  for (const did of ["did:plc:alice", "did:plc:bob"]) {
    for (const rkey of keys) await network.writeAs(did, dmConversationUri(did, started.convKey), "new.flock.dm.message", rkey, { text: `${did} ${rkey}`, createdAt: "2026-11-10T12:00:00.000Z" });
  }
  const seen: string[] = [];
  let before: string | undefined;
  for (let pages = 0; pages < 10; pages += 1) {
    const page = await alice.readConversation(started.convKey, started.participants, { limit: 4, before });
    seen.push(...page.messages.map((message) => message.uri));
    if (!page.nextBefore) break;
    before = page.nextBefore;
  }
  assert.equal(seen.length, 6);
  assert.equal(new Set(seen).size, 6);
});

test("a half whose message history passes the read limit is reported, not silently cut", async () => {
  const { network, client } = harness();
  network.createAccount("did:plc:alice", "pds1");
  network.createAccount("did:plc:bob", "pds2");
  const alice = client("did:plc:alice", "pds1", { limits: { maxRecordsPerHalf: 3 } });
  const bob = client("did:plc:bob");
  await bob.enableDms("everyone");
  const started = await alice.startConversation(["did:plc:bob"]);
  await bob.accept((await bob.listRequests())[0]!);
  for (let n = 0; n < 5; n += 1) {
    await bob.send(started.convKey, `message ${n}`);
    network.advanceClock(1);
  }
  const first = await alice.readConversation(started.convKey, started.participants, { limit: 2 });
  await assert.rejects(alice.readConversation(started.convKey, started.participants, { limit: 2, before: first.nextBefore }), /read limit/);
});
