import assert from "node:assert/strict";
import test from "node:test";
import { SPACE_CREDENTIAL_LIFETIME_MS, SPACE_CREDENTIAL_RENEW_BEFORE_MS, verifyCredentialSig } from "@flock/protocol/atproto/space-credential-core";
import { XrpcError } from "@flock/protocol/atproto/xrpc";
import { dmConversationUri, dmInboxUri, spaceRecordUri } from "@flock/protocol/keys";
import { OPERATOR_METHOD } from "@flock/protocol/nsids";
import { CredentialCache } from "../credentials";
import { OperatorClient, type OperatorService } from "../operator-client";
import { DmClient, type DmDeps, type DmStore } from "./dm-client";
import { FakeNetwork } from "@flock/testing/fake-network";

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
      if (request.url.includes("com.atproto.space.authorizeSpaceSync")) exchanges += 1;
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

test("a half whose authority still answers AccountNotAuthorized is reported revoked, not missing", async () => {
  // #given an authority that tells a refused reader apart from a missing half, as other PDS implementations may
  const { network, client } = harness();
  network.createAccount("did:plc:alice", "pds1");
  network.createAccount("did:plc:bob", "pds2");
  const alice = client("did:plc:alice", "pds1", {
    fetchEndpoint: async (request) => {
      const response = await network.fetchEndpoint(request);
      if (!request.url.includes("authorizeSpaceSync") || response.ok) return response;
      const body = await response.json() as { error: string; message: string };
      return new Response(JSON.stringify({ ...body, error: body.error === "SpaceNotFound" ? "AccountNotAuthorized" : body.error }), { status: response.status });
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
  const reported = await network.clientFor("did:plc:bob").query<{ policy: Record<string, unknown> }>("com.atproto.space.getSpace", { space: "at:space/did:plc:bob/new.flock.dm.inbox/self" });
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
      if (request.url.includes("authorizeSpaceSync")) mints += 1;
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

test("R12 D12.8.2 (H6): switching allowlist -> nobody -> everyone reactivates dormant allowlist members so their requests are tracked, and putMembers/removeMembers chunk >100 DIDs", async () => {
  const { network, client } = harness();
  network.createAccount("did:plc:alice", "pds1");
  network.createAccount("did:plc:bob", "pds2");
  const alice = client("did:plc:alice");
  const bob = client("did:plc:bob");

  // 1. Alice enables allowlist with Bob, parks DMs in "nobody" (making Bob dormant { read:false, write:false }),
  //    then switches to "everyone" -> Bob MUST be reactivated to { read:false, write:true } so publicWrite + explicit member allows tracking!
  await alice.enableDms("allowlist", ["did:plc:bob"]);
  await alice.setRequestMode("nobody");
  assert.deepEqual(await alice.getInbox(), { exists: true, mode: "nobody", allowlist: ["did:plc:bob"] });

  await alice.setRequestMode("everyone");
  assert.deepEqual(await alice.getInbox(), { exists: true, mode: "everyone", allowlist: ["did:plc:bob"] });

  // Verify Bob's request sent after nobody -> everyone is tracked in listWriters AND returned by alice.listRequests()!
  const started = await bob.startConversation(["did:plc:alice"]);
  assert.equal(started.delivery["did:plc:alice"]?.status, "delivered");
  const seenInEveryone = await alice.listRequests();
  assert.deepEqual(seenInEveryone.map((r) => r.convKey), [started.convKey], "previously-dormant contact's request is tracked in everyone mode");

  // Switching back to "nobody" parks Bob dormant again without losing his allowlist membership.
  await alice.setRequestMode("nobody");
  assert.deepEqual(await alice.getInbox(), { exists: true, mode: "nobody", allowlist: ["did:plc:bob"] });
  assert.deepEqual(await alice.listRequests(), []);

  // 2. Allowing and disallowing >100 DIDs chunks putMembers / removeMembers into <=100 batches cleanly.
  const bulkDids = Array.from({ length: 135 }, (_, idx) => `did:plc:bulk${String(idx).padStart(3, "0")}`);
  await alice.setRequestMode("allowlist");
  await alice.allow(bulkDids);
  const afterBulkAllow = await alice.getInbox();
  assert.equal(afterBulkAllow.allowlist.length, 136);
  await alice.disallow(bulkDids);
  assert.deepEqual((await alice.getInbox()).allowlist, ["did:plc:bob"]);
});

test("R12 D12.3c: CredentialCache upgrades un-notified credentials, re-mints on notify target change, retains notify on renewal, and falls back when RegistrationNotConfirmed", async () => {
  const network = new FakeNetwork();
  network.createAccount("did:plc:alice", "pds1");
  const inbox = dmInboxUri("did:plc:alice");
  await network.clientFor("did:plc:alice").procedure("com.atproto.space.createSpace", {
    spaceType: "new.flock.dm.inbox",
    skey: "self",
    policy: { $type: "com.atproto.memberspace.policy", publicWrite: true },
  });

  const notifyPayloads: Array<unknown> = [];
  let confirmShouldSucceed = true;
  let confirmations = 0;
  network.registerEndpoint("https://webhook.test", async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/xrpc/com.atproto.space.confirmRegistration") {
      confirmations += 1;
      if (!confirmShouldSucceed) return Response.json({ error: "ChallengeMismatch" }, { status: 400 });
      const body = (await req.json()) as { challenge: string };
      return Response.json({ challenge: body.challenge });
    }
    return Response.json({});
  });

  const cache = new CredentialCache({
    did: "did:plc:alice",
    memberClient: network.clientFor("did:plc:alice"),
    resolvePds: network.resolvePds,
    resolveKemKey: network.resolveKemKey,
    fetchEndpoint: async (request) => {
      if (request.url.includes("com.atproto.space.authorizeSpaceSync") && request.method === "POST") {
        const cloned = request.clone();
        const parsed = (await cloned.json()) as { notify?: unknown };
        notifyPayloads.push(parsed.notify ?? null);
      }
      return network.fetchEndpoint(request);
    },
    generateKey: network.generateKey,
    now: network.now,
  });

  // 1. Initial get without notify mints un-notified credential.
  const c1 = await cache.get(inbox);
  assert.deepEqual(notifyPayloads, [null]);

  // 2. Passing { notify } upgrades immediately by re-minting with notify!
  const targetA = { endpoint: "https://webhook.test", token: "tok-a" };
  const c2 = await cache.get(inbox, { notify: targetA });
  assert.notEqual(c2.token, c1.token);
  assert.deepEqual(notifyPayloads.at(-1), targetA);
  assert.equal(confirmations, 1);

  // 3. Calling get(inbox) with same notify or without opts reuses c2 before renewal window, and retains targetA on renewal!
  const c2Same = await cache.get(inbox, { notify: targetA });
  assert.equal(c2Same.token, c2.token);
  network.advanceClock(SPACE_CREDENTIAL_LIFETIME_MS - SPACE_CREDENTIAL_RENEW_BEFORE_MS + 1);
  const c3Renewed = await cache.get(inbox);
  assert.notEqual(c3Renewed.token, c2.token);
  assert.deepEqual(notifyPayloads.at(-1), targetA, "renewal without opts retains confirmed notify target");
  assert.equal(confirmations, 1, "active registration renewed before exp does not re-run confirmRegistration");

  // 4. Changing token or endpoint re-mints immediately with new target.
  const targetB = { endpoint: "https://webhook.test", token: "tok-b" };
  const c4 = await cache.get(inbox, { notify: targetB });
  assert.notEqual(c4.token, c3Renewed.token);
  assert.deepEqual(notifyPayloads.at(-1), targetB);
  assert.equal(confirmations, 2);

  // 5. RegistrationNotConfirmed strips notify and immediately mints AND caches a working un-notified credential!
  confirmShouldSucceed = false;
  const targetUnconfirmed = { endpoint: "https://webhook.test", token: "tok-fail" };
  const c5Fallback = await cache.get(inbox, { notify: targetUnconfirmed });
  assert.ok(c5Fallback.token);
  assert.equal(c5Fallback.notify, undefined, "fallback credential has no notify binding");
  assert.deepEqual(notifyPayloads.slice(-2), [targetUnconfirmed, null], "retried immediately without notify after RegistrationNotConfirmed");
  const c5Cached = await cache.get(inbox);
  assert.equal(c5Cached.token, c5Fallback.token, "R10-M2: unnotified fallback updated CredentialCache slot");
  assert.equal(c5Cached.notify, undefined, "R10-M2: previous notified credential was replaced in cache");
});

test("R12 D12.3b.3 (H5): DmClient.watch proves SpaceCredential possession via RFC 9421 PoP, renews notify registrations, never blocks DM reads on operator/webhook failures, and cleans up on abort", async () => {
  const OPERATOR: OperatorService = {
    serviceRef: "did:web:operator.test#atproto_flock_operator",
    endpoint: "https://operator.test",
  };

  // 1. Happy path + PoP verification + renewal reuse without re-calling getDmNotifyTarget + AbortSignal cleanup.
  {
    const network = new FakeNetwork();
    network.createAccount("did:plc:alice", "pds1");
    network.createAccount("did:plc:bob", "pds2");

    let dmTargetCalls = 0;
    let confirmCalls = 0;
    const deliveredSpaces: string[] = [];
    const verifiedProofs: Array<{ space: string; audience: string | null }> = [];

    network.registerEndpoint(OPERATOR.endpoint, async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/xrpc/com.atproto.space.confirmRegistration") {
        confirmCalls += 1;
        const body = (await req.json()) as { challenge: string };
        return Response.json({ challenge: body.challenge });
      }
      if (url.pathname === "/xrpc/com.atproto.space.notifySpaceUpdate") {
        const body = (await req.json()) as { space: string };
        deliveredSpaces.push(body.space);
        return Response.json({});
      }
      return Response.json({ error: "NotFound" }, { status: 404 });
    });

    const baseFetch = network.fetchEndpoint;
    const fetchWithOperator: DmDeps["fetchEndpoint"] = async (request) => {
      const url = new URL(request.url);
      if (url.origin !== OPERATOR.endpoint) return baseFetch(request);
      const method = url.pathname.replace("/xrpc/", "");
      if (method === OPERATOR_METHOD.getDmNotifyTarget) {
        dmTargetCalls += 1;
        const body = (await request.json()) as {
          space: string;
          credential: string;
          proof: { authorization: string; signatureInput: string; signature: string };
        };
        const payload = JSON.parse(Buffer.from(body.credential.split(".")[1]!, "base64url").toString("utf8")) as {
          sub: string;
          cnf: { kid: `did:key:${string}` };
        };
        assert.equal(payload.sub, body.space);
        assert.equal(body.proof.authorization, `Atproto-Space-Credential ${body.credential}`);
        assert.match(body.proof.signatureInput, /;created=\d+;/, "RFC 9421 PoP proof carries signed ;created= timestamp");
        await verifyCredentialSig(
          {
            authorization: body.proof.authorization,
            "atproto-space-audience": OPERATOR.serviceRef,
            "signature-input": body.proof.signatureInput,
            signature: body.proof.signature,
          },
          payload.cnf.kid,
        );
        verifiedProofs.push({ space: body.space, audience: OPERATOR.serviceRef });
        return Response.json({ endpoint: OPERATOR.endpoint, token: ` opaque-tok-${dmTargetCalls} ` });
      }
      return Response.json({ error: "NotFound" }, { status: 404 });
    };

    const realTimers = new Map<number, { fn: () => void; delayMs: number; cleared: boolean; fired: boolean }>();
    let nextTimerId = 1;
    const aliceDeps: DmDeps = {
      did: "did:plc:alice",
      memberClient: network.clientFor("did:plc:alice"),
      resolvePds: network.resolvePds,
      resolveKemKey: network.resolveKemKey,
      fetchEndpoint: fetchWithOperator,
      generateKey: network.generateKey,
      store: createStore(),
      now: network.now,
      operator: new OperatorClient(
        { did: "did:plc:alice", memberClient: network.clientFor("did:plc:alice"), resolvePds: network.resolvePds, resolveKemKey: network.resolveKemKey, fetchEndpoint: fetchWithOperator, generateKey: network.generateKey },
        OPERATOR,
      ),
      timers: {
        setTimeout: (fn, delayMs) => {
          const id = nextTimerId++;
          const entry = {
            fn: () => {
              entry.fired = true;
              fn();
            },
            delayMs,
            cleared: false,
            fired: false,
          };
          realTimers.set(id, entry);
          return id;
        },
        clearTimeout: (handle) => {
          const entry = realTimers.get(handle as number);
          if (entry) entry.cleared = true;
        },
      },
    };
    const alice = new DmClient(aliceDeps);
    const bob = new DmClient({
      did: "did:plc:bob",
      memberClient: network.clientFor("did:plc:bob"),
      resolvePds: network.resolvePds,
      resolveKemKey: network.resolveKemKey,
      fetchEndpoint: network.fetchEndpoint,
      generateKey: network.generateKey,
      store: createStore(),
      now: network.now,
    });

    await alice.enableDms("everyone");
    const inbox = dmInboxUri("did:plc:alice");
    const abortController = new AbortController();
    await alice.watch([inbox], { signal: abortController.signal });
    await alice.flushWatchNotifications();

    assert.equal(dmTargetCalls, 1, "fetched DM notify target once");
    assert.equal(verifiedProofs.length, 1, "RFC 9421 PoP proof verified against credential cnf.kid and operator serviceRef");
    assert.equal(confirmCalls, 1, "PDS confirmed webhook registration once");

    // Bob sends a DM request -> Alice's PDS delivers notifySpaceUpdate to operator endpoint!
    await bob.startConversation(["did:plc:alice"]);
    await network.flushNotifications();
    assert.deepEqual(deliveredSpaces, [inbox]);

    // Periodic renewal timer fires before 10m expiry: renews authorizeSpaceSync reusing cached { endpoint, token } WITHOUT calling getDmNotifyTarget or confirmRegistration again!
    const activeTimers = [...realTimers.values()].filter((t) => !t.cleared && !t.fired);
    assert.equal(activeTimers.length, 1, "scheduled one renewal timer");
    assert.ok(activeTimers[0]!.delayMs >= 6 * 60_000 && activeTimers[0]!.delayMs <= 8 * 60_000);
    network.advanceClock(activeTimers[0]!.delayMs);
    activeTimers[0]!.fn();
    await alice.flushWatchNotifications();
    assert.equal(dmTargetCalls, 1, "renewal reused cached { endpoint, token } without calling getDmNotifyTarget");
    assert.equal(confirmCalls, 1, "active registration renewed before exp without re-running confirmRegistration");

    // AbortSignal immediately clears pending timers!
    assert.equal([...realTimers.values()].filter((t) => !t.cleared && !t.fired).length, 1, "next renewal timer is pending before abort");
    abortController.abort();
    assert.equal([...realTimers.values()].filter((t) => !t.cleared && !t.fired).length, 0, "AbortSignal cleaned up all pending watch timers");
  }

  // 2. Operator offline / RegistrationNotConfirmed / ScopeMissingError NEVER break DM reads, and transient failures recover via background backoff!
  {
    const network = new FakeNetwork();
    network.createAccount("did:plc:alice", "pds1");
    network.createAccount("did:plc:bob", "pds2");

    let operatorMode: "offline" | "unconfirmed" | "ok" | "missing-scope" = "offline";
    let targetCalls = 0;
    let confirmed = false;

    network.registerEndpoint(OPERATOR.endpoint, async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/xrpc/com.atproto.space.confirmRegistration") {
        if (operatorMode !== "ok") return Response.json({ error: "Down" }, { status: 502 });
        confirmed = true;
        const body = (await req.json()) as { challenge: string };
        return Response.json({ challenge: body.challenge });
      }
      return Response.json({});
    });

    const scheduledRetries: Array<{ fn: () => void; delayMs: number; cleared: boolean; fired: boolean }> = [];
    const waitForRetryCount = async (minActive: number) => {
      for (let i = 0; i < 100; i += 1) {
        if (scheduledRetries.filter((t) => !t.cleared && !t.fired).length >= minActive) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    const makeAlice = () =>
      new DmClient({
        did: "did:plc:alice",
        memberClient: network.clientFor("did:plc:alice"),
        resolvePds: network.resolvePds,
        resolveKemKey: network.resolveKemKey,
        fetchEndpoint: async (request) => {
          const url = new URL(request.url);
          if (url.origin !== OPERATOR.endpoint) return network.fetchEndpoint(request);
          targetCalls += 1;
          if (operatorMode === "offline") {
            return Response.json({ error: "BadGateway", message: "operator offline" }, { status: 502 });
          }
          if (operatorMode === "missing-scope") {
            return Response.json({ error: "ScopeMissingError", message: "Missing getDmNotifyTarget scope" }, { status: 403 });
          }
          return Response.json({ endpoint: OPERATOR.endpoint, token: "tok-recover" });
        },
        generateKey: network.generateKey,
        store: createStore(),
        now: network.now,
        operator: OPERATOR,
        watchTiming: { initialRetryMs: 50, maxRetryMs: 200 },
        timers: {
          setTimeout: (fn, delayMs) => {
            const entry = {
              fn: () => {
                entry.fired = true;
                fn();
              },
              delayMs,
              cleared: false,
              fired: false,
            };
            scheduledRetries.push(entry);
            return entry;
          },
          clearTimeout: (handle) => {
            (handle as { cleared: boolean }).cleared = true;
          },
        },
      });

    const alice = makeAlice();
    const bob = new DmClient({
      did: "did:plc:bob",
      memberClient: network.clientFor("did:plc:bob"),
      resolvePds: network.resolvePds,
      resolveKemKey: network.resolveKemKey,
      fetchEndpoint: network.fetchEndpoint,
      generateKey: network.generateKey,
      store: createStore(),
      now: network.now,
    });

    await alice.enableDms("everyone");
    await bob.enableDms("everyone");
    const started = await bob.startConversation(["did:plc:alice"]);
    const inbox = dmInboxUri("did:plc:alice");

    // (a) Operator returns 502 -> watch does NOT throw, listRequests & readConversation still succeed!
    await alice.watch([inbox]);
    await alice.flushWatchNotifications();
    assert.equal((await alice.listRequests()).length, 1, "listRequests succeeds while operator is offline");
    await alice.accept((await alice.listRequests())[0]!);
    await bob.send(started.convKey, "works without operator");
    const bobHalf = dmConversationUri("did:plc:bob", started.convKey);
    await alice.watch([inbox, bobHalf]);
    await alice.flushWatchNotifications();
    const pageWhileDown = await alice.readConversation(started.convKey, started.participants);
    assert.deepEqual(pageWhileDown.messages.map((m) => m.text), ["works without operator"]);

    // (b) Operator returns target, but webhook confirmRegistration fails -> RegistrationNotConfirmed fallback keeps DM reads working and schedules backoff retry!
    operatorMode = "unconfirmed";
    const pendingRetry1 = scheduledRetries.filter((t) => !t.cleared && !t.fired);
    assert.ok(pendingRetry1.length >= 1, "transient operator failure scheduled background backoff retry");
    pendingRetry1[0]!.fn();
    await alice.flushWatchNotifications();
    await waitForRetryCount(2);
    assert.equal(confirmed, false);
    assert.equal((await alice.readConversation(started.convKey, started.participants)).messages.length, 1, "reads stay healthy after RegistrationNotConfirmed");

    // (c) Webhook comes online -> next scheduled retry confirms registration!
    operatorMode = "ok";
    const pendingRetry2 = scheduledRetries.filter((t) => !t.cleared && !t.fired);
    for (const timer of pendingRetry2) timer.fn();
    await alice.flushWatchNotifications();
    assert.equal(confirmed, true, "background retry recovered notify registration once operator & webhook came online");
    alice.close();

    // (d) Legacy session missing getDmNotifyTarget scope (ScopeMissingError 403) degrades cleanly with zero retry storm!
    scheduledRetries.length = 0;
    operatorMode = "missing-scope";
    const callsBeforeLegacy = targetCalls;
    const legacyAlice = makeAlice();
    await legacyAlice.watch([inbox, bobHalf]);
    await legacyAlice.flushWatchNotifications();
    assert.equal(legacyAlice.isNotifyScopeMissing(), true);
    const callsAfterFirstLegacyWatch = targetCalls;
    assert.ok(callsAfterFirstLegacyWatch - callsBeforeLegacy >= 1 && callsAfterFirstLegacyWatch - callsBeforeLegacy <= 2);
    assert.equal(scheduledRetries.filter((t) => !t.cleared && !t.fired).length, 0, "no retry timer scheduled on ScopeMissingError");
    await legacyAlice.watch([inbox, bobHalf]);
    await legacyAlice.flushWatchNotifications();
    assert.equal(targetCalls, callsAfterFirstLegacyWatch, "subsequent watch calls make zero getDmNotifyTarget requests once scope is known missing");
    assert.equal((await legacyAlice.readConversation(started.convKey, started.participants)).messages.length, 1);
    legacyAlice.close();
    assert.ok(XrpcError);
  }
});

test("R12 Round 1 fixes: watch() resolves in <50ms on blackholed operator/getServiceAuth, side-car notify never blocks reads during hung confirmRegistration, single-use jti rotates at 20m & invalidates stale targets, and unwatch/coalesce stay leak-free", async () => {
  const OPERATOR: OperatorService = {
    serviceRef: "did:web:operator.test#atproto_flock_operator",
    endpoint: "https://operator.test",
  };

  // 1. Codex M5 + Opus M1: watch() resolves immediately (<50ms) when operator fetch OR getServiceAuth NEVER resolves,
  //    and composed notifyTimeoutMs aborts both into un-notified fallback + 15s retry!
  for (const stallPhase of ["operator-fetch", "service-auth"] as const) {
    const network = new FakeNetwork();
    network.createAccount("did:plc:alice", "pds1");
    const inbox = dmInboxUri("did:plc:alice");
    await network.clientFor("did:plc:alice").procedure("com.atproto.space.createSpace", {
      spaceType: "new.flock.dm.inbox",
      skey: "self",
      policy: { $type: "com.atproto.memberspace.policy", publicWrite: true },
    });

    const realMemberClient = network.clientFor("did:plc:alice");
    const stalledMemberClient = Object.create(realMemberClient, {
      query: {
        value: (method: string, params?: Record<string, unknown>) => {
          if (stallPhase === "service-auth" && method === "com.atproto.server.getServiceAuth") {
            return new Promise<never>(() => {});
          }
          return realMemberClient.query(method, params as never);
        },
      },
    });

    let sawOperatorAbortSignal = false;
    const scheduledRetries: Array<{ delayMs: number; cleared: boolean }> = [];
    const alice = new DmClient({
      did: "did:plc:alice",
      memberClient: stalledMemberClient,
      resolvePds: network.resolvePds,
      resolveKemKey: network.resolveKemKey,
      fetchEndpoint: (request) => {
        const url = new URL(request.url);
        if (url.origin === OPERATOR.endpoint) {
          sawOperatorAbortSignal = Boolean(request.signal);
          return new Promise<Response>(() => {});
        }
        return network.fetchEndpoint(request);
      },
      generateKey: network.generateKey,
      store: createStore(),
      now: network.now,
      operator: OPERATOR,
      notifyTimeoutMs: 250,
      timers: {
        setTimeout: (_fn, delayMs) => {
          const entry = { delayMs, cleared: false };
          scheduledRetries.push(entry);
          return entry;
        },
        clearTimeout: (handle) => {
          (handle as { cleared: boolean }).cleared = true;
        },
      },
    });

    const t0 = performance.now();
    const expiries = await alice.watch([inbox]);
    const watchElapsedMs = performance.now() - t0;
    assert.ok(watchElapsedMs < 200, `watch() resolved in ${watchElapsedMs.toFixed(1)}ms (<200ms, before 250ms notifyTimeoutMs) despite ${stallPhase} hang`);
    assert.ok(expiries[inbox], "returned un-notified SpaceCredential expiry immediately");

    // Background registration hits the 35ms composed deadline, enters un-notified fallback, and schedules 15s retry!
    await alice.flushWatchNotifications();
    if (stallPhase === "operator-fetch") {
      assert.equal(sawOperatorAbortSignal, true, "Request to getDmNotifyTarget carries composed AbortSignal");
    }
    const activeRetries = scheduledRetries.filter((t) => !t.cleared);
    assert.equal(activeRetries.length, 1, `stalled ${stallPhase} timed out cleanly and scheduled one retry timer`);
    assert.equal(activeRetries[0]!.delayMs, 15_000, "initial backoff retry is 15s");
    assert.deepEqual(await alice.listRequests(), [], "DM reads remain fast and unblocked");
    alice.close();
  }

  // 2. Opus M1: Hung confirmRegistration NEVER blocks concurrent DM reads (CredentialCache side-car notify minting)!
  {
    const network = new FakeNetwork();
    network.createAccount("did:plc:alice", "pds1");
    network.createAccount("did:plc:bob", "pds2");

    let confirmReleased = false;
    let releaseConfirm!: () => void;
    let confirmEntered!: () => void;
    const confirmEnteredPromise = new Promise<void>((resolve) => { confirmEntered = resolve; });
    const confirmGate = new Promise<void>((resolve) => {
      releaseConfirm = () => {
        confirmReleased = true;
        resolve();
      };
    });

    network.registerEndpoint(OPERATOR.endpoint, async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/xrpc/com.atproto.space.confirmRegistration") {
        confirmEntered();
        await confirmGate;
        return Response.json({ error: "TimedOut" }, { status: 504 });
      }
      return Response.json({});
    });

    const alice = new DmClient({
      did: "did:plc:alice",
      memberClient: network.clientFor("did:plc:alice"),
      resolvePds: network.resolvePds,
      resolveKemKey: network.resolveKemKey,
      fetchEndpoint: async (request) => {
        const url = new URL(request.url);
        if (url.origin === OPERATOR.endpoint) {
          return Response.json({ endpoint: OPERATOR.endpoint, token: "dm1.hang" });
        }
        return network.fetchEndpoint(request);
      },
      generateKey: network.generateKey,
      store: createStore(),
      now: network.now,
      operator: OPERATOR,
    });
    const bob = new DmClient({
      did: "did:plc:bob",
      memberClient: network.clientFor("did:plc:bob"),
      resolvePds: network.resolvePds,
      resolveKemKey: network.resolveKemKey,
      fetchEndpoint: network.fetchEndpoint,
      generateKey: network.generateKey,
      store: createStore(),
      now: network.now,
    });

    await alice.enableDms("everyone");
    await bob.enableDms("everyone");
    const started = await bob.startConversation(["did:plc:alice"]);
    await alice.accept((await alice.listRequests())[0]!);
    await bob.send(started.convKey, "instant read while confirm hangs");

    const inbox = dmInboxUri("did:plc:alice");
    const bobHalf = dmConversationUri("did:plc:bob", started.convKey);

    // Kick off watch -> background { notify } mint enters hung confirmRegistration!
    await alice.watch([inbox, bobHalf]);
    await confirmEnteredPromise;

    const readStart = performance.now();
    const [requests, page] = await Promise.all([
      alice.listRequests(),
      alice.readConversation(started.convKey, started.participants),
    ]);
    const readElapsedMs = performance.now() - readStart;
    assert.equal(confirmReleased, false, "concurrent DM reads completed while confirmRegistration was still hung");
    assert.ok(readElapsedMs < 500, `concurrent DM reads finished in ${readElapsedMs.toFixed(1)}ms (<500ms) while confirmRegistration hung`);
    assert.deepEqual(requests, []);
    assert.deepEqual(page.messages.map((m) => m.text), ["instant read while confirm hangs"]);

    releaseConfirm();
    await alice.flushWatchNotifications();
    alice.close();
  }

  // 3. Codex M1 + Codex M4 + Opus M1 + Opus L4 + Opus L5:
  //    - Concurrent watch() coalesces to 1 PoP proof (never trips replay cache)
  //    - Single-use jti + ;created= timestamp on every getDmNotifyTarget call
  //    - 20-min epoch rotation fetches fresh target with brand-new jti + createdSec
  //    - RegistrationNotConfirmed invalidates stale target so next retry fetches rotated token with fresh jti
  //    - unwatch() clears notifyTargets so later credential renewals stop sending { notify }, and partial watch failure leaks no state!
  {
    const network = new FakeNetwork();
    network.createAccount("did:plc:alice", "pds1");
    const inbox = dmInboxUri("did:plc:alice");
    await network.clientFor("did:plc:alice").procedure("com.atproto.space.createSpace", {
      spaceType: "new.flock.dm.inbox",
      skey: "self",
      policy: { $type: "com.atproto.memberspace.policy", publicWrite: true },
    });

    let activeWebhookSecretEpoch = 1;
    const seenJtis = new Set<string>();
    const seenCreatedSecs: number[] = [];
    const authorizeNotifyPayloads: Array<unknown> = [];

    network.registerEndpoint(OPERATOR.endpoint, async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/xrpc/com.atproto.space.confirmRegistration") {
        const body = (await req.json()) as { token: string; challenge: string };
        // Reject tokens from rotated-out operator secret epochs!
        if (body.token !== `dm1-epoch-${activeWebhookSecretEpoch}`) {
          return Response.json({ error: "InvalidWebhookToken" }, { status: 400 });
        }
        return Response.json({ challenge: body.challenge });
      }
      return Response.json({});
    });

    const timers: Array<{ fn: () => void; delayMs: number; cleared: boolean; fired: boolean }> = [];
    const alice = new DmClient({
      did: "did:plc:alice",
      memberClient: network.clientFor("did:plc:alice"),
      resolvePds: network.resolvePds,
      resolveKemKey: network.resolveKemKey,
      fetchEndpoint: async (request) => {
        const url = new URL(request.url);
        if (url.origin === OPERATOR.endpoint) {
          const body = (await request.json()) as {
            space: string;
            credential: string;
            proof: { authorization: string; signatureInput: string; signature: string };
          };
          const payload = JSON.parse(Buffer.from(body.credential.split(".")[1]!, "base64url").toString("utf8")) as {
            jti: string;
            cnf: { kid: `did:key:${string}` };
          };
          // Enforce strict single-use jti replay guard + ;created= requirement (Codex M1)!
          assert.equal(seenJtis.has(payload.jti), false, "every getDmNotifyTarget call MUST present a fresh single-use jti");
          seenJtis.add(payload.jti);
          const createdMatch = /;created=(\d+);/.exec(body.proof.signatureInput);
          assert.ok(createdMatch, "proof.signatureInput must carry signed ;created= timestamp");
          seenCreatedSecs.push(Number(createdMatch[1]));
          await verifyCredentialSig(
            {
              authorization: body.proof.authorization,
              "atproto-space-audience": OPERATOR.serviceRef,
              "signature-input": body.proof.signatureInput,
              signature: body.proof.signature,
            },
            payload.cnf.kid,
          );
          return Response.json({ endpoint: OPERATOR.endpoint, token: `dm1-epoch-${activeWebhookSecretEpoch}` });
        }
        if (request.url.includes("com.atproto.space.authorizeSpaceSync") && request.method === "POST") {
          const parsed = (await request.clone().json()) as { notify?: unknown };
          authorizeNotifyPayloads.push(parsed.notify ?? null);
        }
        return network.fetchEndpoint(request);
      },
      generateKey: network.generateKey,
      store: createStore(),
      now: network.now,
      operator: OPERATOR,
      timers: {
        setTimeout: (fn, delayMs) => {
          const entry = {
            fn: () => {
              entry.fired = true;
              fn();
            },
            delayMs,
            cleared: false,
            fired: false,
          };
          timers.push(entry);
          return entry;
        },
        clearTimeout: (handle) => {
          (handle as { cleared: boolean }).cleared = true;
        },
      },
    });

    // (a) Opus L5: Concurrent watch([inbox]) from DmProvider + DmConversation coalesces to 1 PoP proof!
    const sig1 = new AbortController();
    const sig2 = new AbortController();
    await Promise.all([
      alice.watch([inbox], { signal: sig1.signal }),
      alice.watch([inbox], { signal: sig2.signal }),
    ]);
    await alice.flushWatchNotifications();
    assert.equal(seenJtis.size, 1, "concurrent watch() calls coalesced into 1 PoP proof");
    assert.deepEqual(authorizeNotifyPayloads, [null, { endpoint: OPERATOR.endpoint, token: "dm1-epoch-1" }]);

    // (b) Codex M4: Advancing clock 20 minutes triggers target rotation with a brand-new jti + updated createdSec!
    for (let step = 0; step < 3; step += 1) {
      const due = timers.find((t) => !t.cleared && !t.fired)!;
      assert.ok(due, `expected active timer at step ${step}`);
      network.advanceClock(due.delayMs);
      due.fn();
      await alice.flushWatchNotifications();
    }
    assert.equal(seenJtis.size, 2, "20-minute epoch boundary fetched fresh dm1 target with a brand-new jti");
    assert.ok(seenCreatedSecs[1]! > seenCreatedSecs[0]!, "rotated PoP proof carries updated createdSec");

    // (c) Opus M1: Operator rotates secret (epoch 2 -> 3); RegistrationNotConfirmed invalidates cached target
    //     so next 15s retry fetches dm1-epoch-3 with a fresh jti!
    activeWebhookSecretEpoch = 2;
    network.createAccount("did:plc:bob", "pds2");
    const convStarted = await alice.startConversation(["did:plc:bob"]);
    const ownHalf = dmConversationUri("did:plc:alice", convStarted.convKey);
    let rejectConfirmOnce = true;
    network.registerEndpoint(OPERATOR.endpoint, async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/xrpc/com.atproto.space.confirmRegistration") {
        const body = (await req.json()) as { token: string; challenge: string };
        if (rejectConfirmOnce) {
          rejectConfirmOnce = false;
          activeWebhookSecretEpoch = 3;
          return Response.json({ error: "InvalidWebhookToken" }, { status: 400 });
        }
        assert.equal(body.token, "dm1-epoch-3", "retry after RegistrationNotConfirmed fetched fresh epoch-3 token");
        return Response.json({ challenge: body.challenge });
      }
      return Response.json({});
    });

    await alice.watch([ownHalf]);
    await alice.flushWatchNotifications();
    assert.equal(seenJtis.size, 3, "initial watch on ownHalf used 1 fresh jti");
    const retryTimer = timers.filter((t) => !t.cleared && !t.fired).find((t) => t.delayMs === 15_000);
    assert.ok(retryTimer, "RegistrationNotConfirmed scheduled 15s backoff retry");
    network.advanceClock(15_000);
    retryTimer.fn();
    await alice.flushWatchNotifications();
    assert.equal(seenJtis.size, 4, "retry after RegistrationNotConfirmed invalidated stale target and minted a fresh single-use jti");

    // (d) Opus L4: Partial watch() failure cleans up failing space state, and unwatch() stops future notify renewals without dropping read credentials!
    const missingHalf = dmConversationUri("did:plc:bob", "3kmissinghalf");
    const failAbort = new AbortController();
    await assert.rejects(alice.watch([missingHalf], { signal: failAbort.signal }));

    alice.unwatch([inbox, ownHalf]);
    assert.equal(timers.filter((t) => !t.cleared && !t.fired).length, 0, "unwatch cleared all watch timers");
    const payloadsBeforeRead = authorizeNotifyPayloads.length;
    // Cached credential is still valid for immediate reads without re-minting:
    await alice.listRequests();
    assert.equal(authorizeNotifyPayloads.length, payloadsBeforeRead, "unwatch kept valid read credential cached");
    // Once read credential expires, renewal mints WITHOUT notify (no zombie webhook re-registration!):
    network.advanceClock(SPACE_CREDENTIAL_LIFETIME_MS + 1_000);
    await alice.listRequests();
    assert.equal(authorizeNotifyPayloads.at(-1), null, "post-unwatch credential renewal does not re-register notify");
    sig1.abort();
    sig2.abort();
    alice.close();
  }
});

test("R12 Round 2 L2: background notification credential minting is end-to-end cancellable on blackholed authorizeSpaceSync or getDelegationToken and on mid-flight unwatch(), allowing immediate recovery once PDS restores", async () => {
  const OPERATOR: OperatorService = {
    serviceRef: "did:web:operator.test#atproto_flock_operator",
    endpoint: "https://operator.test",
  };

  // 1. Deadline cancellation: authority PDS blackholes forever on authorizeSpaceSync when notify is present ->
  //    request.signal aborts at notifyTimeoutMs, pendingNotifyMints & inFlightWatchNotify settle cleanly,
  //    retry timer is scheduled, and subsequent retry / watch() after restoring PDS succeeds!
  {
    const network = new FakeNetwork();
    network.createAccount("did:plc:alice", "pds1");
    network.createAccount("did:plc:bob", "pds2");

    let confirmCalls = 0;
    const deliveredSpaces: string[] = [];
    network.registerEndpoint(OPERATOR.endpoint, async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/xrpc/com.atproto.space.confirmRegistration") {
        confirmCalls += 1;
        const body = (await req.json()) as { challenge: string };
        return Response.json({ challenge: body.challenge });
      }
      if (url.pathname === "/xrpc/com.atproto.space.notifySpaceUpdate") {
        const body = (await req.json()) as { space: string };
        deliveredSpaces.push(body.space);
        return Response.json({});
      }
      return Response.json({});
    });

    let blackholeNotifyAuthorize = true;
    let sawNotifyAuthorizeSignal = false;
    let notifyAuthorizeAborted = false;
    const timers: Array<{ fn: () => void; delayMs: number; cleared: boolean; fired: boolean }> = [];

    const alice = new DmClient({
      did: "did:plc:alice",
      memberClient: network.clientFor("did:plc:alice"),
      resolvePds: network.resolvePds,
      resolveKemKey: network.resolveKemKey,
      fetchEndpoint: async (request) => {
        const url = new URL(request.url);
        if (url.origin === OPERATOR.endpoint) {
          return Response.json({ endpoint: OPERATOR.endpoint, token: "dm1-deadline-test" });
        }
        if (request.url.includes("com.atproto.space.authorizeSpaceSync") && request.method === "POST") {
          const parsed = (await request.clone().json()) as { notify?: unknown };
          if (parsed.notify && blackholeNotifyAuthorize) {
            sawNotifyAuthorizeSignal = Boolean(request.signal);
            request.signal.addEventListener("abort", () => {
              notifyAuthorizeAborted = true;
            }, { once: true });
            // Deliberately ignore request.signal to prove raceWithSignal ALSO detaches pendingNotifyMints!
            return new Promise<Response>(() => {});
          }
        }
        return network.fetchEndpoint(request);
      },
      generateKey: network.generateKey,
      store: createStore(),
      now: network.now,
      operator: OPERATOR,
      notifyTimeoutMs: 150,
      watchTiming: { initialRetryMs: 50, maxRetryMs: 200 },
      timers: {
        setTimeout: (fn, delayMs) => {
          const entry = {
            fn: () => {
              entry.fired = true;
              fn();
            },
            delayMs,
            cleared: false,
            fired: false,
          };
          timers.push(entry);
          return entry;
        },
        clearTimeout: (handle) => {
          (handle as { cleared: boolean }).cleared = true;
        },
      },
    });
    const bob = new DmClient({
      did: "did:plc:bob",
      memberClient: network.clientFor("did:plc:bob"),
      resolvePds: network.resolvePds,
      resolveKemKey: network.resolveKemKey,
      fetchEndpoint: network.fetchEndpoint,
      generateKey: network.generateKey,
      store: createStore(),
      now: network.now,
    });

    await alice.enableDms("everyone");
    const inbox = dmInboxUri("did:plc:alice");

    await alice.watch([inbox]);
    const flushStarted = performance.now();
    await alice.flushWatchNotifications();
    const flushElapsed = performance.now() - flushStarted;
    assert.ok(flushElapsed < 1_500, `flushWatchNotifications() settled in ${flushElapsed.toFixed(1)}ms instead of hanging forever`);
    assert.equal(sawNotifyAuthorizeSignal, true, "authorizeSpaceSync Request received AbortSignal");
    assert.equal(notifyAuthorizeAborted, true, "authorizeSpaceSync Request signal aborted on notifyTimeoutMs");
    assert.equal(confirmCalls, 0);

    const retry = timers.find((t) => !t.cleared && !t.fired);
    assert.ok(retry, "scheduled exponential backoff retry after authorizeSpaceSync timeout");
    assert.equal(retry.delayMs, 50);

    // Restore authority PDS -> scheduled retry (and/or subsequent watch) registers notifications cleanly!
    blackholeNotifyAuthorize = false;
    retry.fn();
    await alice.flushWatchNotifications();
    assert.equal(confirmCalls, 1, "subsequent retry after PDS restore completed webhook confirmation");

    await bob.startConversation(["did:plc:alice"]);
    await network.flushNotifications();
    assert.deepEqual(deliveredSpaces, [inbox]);
    alice.close();
  }

  // 2. Mid-flight unwatch() cancellation: calling unwatch() while authorizeSpaceSync({ notify }) OR getDelegationToken
  //    is hung forever aborts the request immediately, settles flushWatchNotifications() in <50ms, and lets an
  //    immediate subsequent watch() succeed once PDS is restored!
  for (const hangLeg of ["authorizeSpaceSync", "getDelegationToken"] as const) {
    const network = new FakeNetwork();
    network.createAccount("did:plc:alice", "pds1");
    const inbox = dmInboxUri("did:plc:alice");
    await network.clientFor("did:plc:alice").procedure("com.atproto.space.createSpace", {
      spaceType: "new.flock.dm.inbox",
      skey: "self",
      policy: { $type: "com.atproto.memberspace.policy", publicWrite: true },
    });

    let confirmCalls = 0;
    network.registerEndpoint(OPERATOR.endpoint, async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/xrpc/com.atproto.space.confirmRegistration") {
        confirmCalls += 1;
        const body = (await req.json()) as { challenge: string };
        return Response.json({ challenge: body.challenge });
      }
      return Response.json({});
    });

    let shouldHang = true;
    let legAborted = false;
    let enteredHang!: () => void;
    const enteredHangPromise = new Promise<void>((resolve) => {
      enteredHang = resolve;
    });

    const realMemberClient = network.clientFor("did:plc:alice");
    let delegationCalls = 0;
    const wrappedMemberClient = Object.create(realMemberClient, {
      query: {
        value: (method: string, params?: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
          if (method === "com.atproto.space.getDelegationToken") {
            delegationCalls += 1;
            // Let initial watch() ordinary credential mint (#1) succeed; hang background notify mint (#2)!
            if (hangLeg === "getDelegationToken" && shouldHang && delegationCalls >= 2) {
              assert.ok(options?.signal, "getDelegationToken received AbortSignal in options");
              options.signal.addEventListener("abort", () => {
                legAborted = true;
              }, { once: true });
              enteredHang();
              return new Promise<never>(() => {});
            }
          }
          return realMemberClient.query(method, params as never, options);
        },
      },
    });

    const alice = new DmClient({
      did: "did:plc:alice",
      memberClient: wrappedMemberClient,
      resolvePds: network.resolvePds,
      resolveKemKey: network.resolveKemKey,
      fetchEndpoint: async (request) => {
        const url = new URL(request.url);
        if (url.origin === OPERATOR.endpoint) {
          return Response.json({ endpoint: OPERATOR.endpoint, token: `dm1-unwatch-${hangLeg}` });
        }
        if (
          hangLeg === "authorizeSpaceSync"
          && shouldHang
          && request.url.includes("com.atproto.space.authorizeSpaceSync")
          && request.method === "POST"
        ) {
          const parsed = (await request.clone().json()) as { notify?: unknown };
          if (parsed.notify) {
            request.signal.addEventListener("abort", () => {
              legAborted = true;
            }, { once: true });
            enteredHang();
            return new Promise<Response>(() => {});
          }
        }
        return network.fetchEndpoint(request);
      },
      generateKey: network.generateKey,
      store: createStore(),
      now: network.now,
      operator: OPERATOR,
      notifyTimeoutMs: 10_000,
    });

    await alice.watch([inbox]);
    await enteredHangPromise;

    const unwatchStart = performance.now();
    alice.unwatch([inbox]);
    await alice.flushWatchNotifications();
    const unwatchElapsed = performance.now() - unwatchStart;
    assert.equal(legAborted, true, `mid-flight unwatch() aborted hung ${hangLeg} signal immediately`);
    assert.ok(unwatchElapsed < 100, `flushWatchNotifications() settled in ${unwatchElapsed.toFixed(1)}ms after unwatch()`);
    assert.equal(confirmCalls, 0);

    // Restore PDS and immediately watch([inbox]) again -> succeeds cleanly!
    shouldHang = false;
    await alice.watch([inbox]);
    await alice.flushWatchNotifications();
    assert.equal(confirmCalls, 1, `subsequent watch() after mid-flight unwatch() on ${hangLeg} registered webhook cleanly`);
    alice.close();
  }
});

test("R12 Round 3 M3: aborted or timed-out ordinary CredentialCache mints never poison the cache across background renewal deadlines or mid-flight initial watch() aborts", async () => {
  const OPERATOR: OperatorService = {
    serviceRef: "did:web:operator.test#atproto_flock_operator",
    endpoint: "https://operator.test",
  };

  // 1. Background performNotifyRegistration triggers ordinary credential renewal (credentials.get(space, { signal: deadlineSignal })
  //    once cached credential enters its renewal window) against a blackholed PDS:
  //    times out at notifyTimeoutMs, aborts wire signal, clears pending entry from CredentialCache immediately,
  //    and once PDS recovers BOTH ordinary readConversation() AND the next notification retry succeed immediately!
  {
    const network = new FakeNetwork();
    network.createAccount("did:plc:alice", "pds1");
    network.createAccount("did:plc:bob", "pds2");

    let operatorOnline = false;
    let blackholeBobAuthorize = false;
    let sawOrdinaryRenewalSignal = false;
    let ordinaryRenewalAborted = false;
    let confirmCalls = 0;
    const deliveredSpaces: string[] = [];

    network.registerEndpoint(OPERATOR.endpoint, async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/xrpc/com.atproto.space.confirmRegistration") {
        confirmCalls += 1;
        const body = (await req.json()) as { challenge: string };
        return Response.json({ challenge: body.challenge });
      }
      if (url.pathname === "/xrpc/com.atproto.space.notifySpaceUpdate") {
        const body = (await req.json()) as { space: string };
        deliveredSpaces.push(body.space);
        return Response.json({});
      }
      return Response.json({});
    });

    const timers: Array<{ fn: () => void; delayMs: number; cleared: boolean; fired: boolean }> = [];
    const alice = new DmClient({
      did: "did:plc:alice",
      memberClient: network.clientFor("did:plc:alice"),
      resolvePds: network.resolvePds,
      resolveKemKey: network.resolveKemKey,
      fetchEndpoint: async (request) => {
        const url = new URL(request.url);
        if (url.origin === OPERATOR.endpoint) {
          if (!operatorOnline) {
            return Response.json({ error: "BadGateway", message: "offline" }, { status: 502 });
          }
          return Response.json({ endpoint: OPERATOR.endpoint, token: "dm1-r3-m3-renew" });
        }
        if (
          blackholeBobAuthorize
          && request.url.includes("com.atproto.space.authorizeSpaceSync")
          && request.method === "POST"
        ) {
          const parsed = (await request.clone().json()) as { space?: string; notify?: unknown };
          if (parsed.space?.startsWith("at:space/did:plc:bob/") && parsed.notify === undefined) {
            sawOrdinaryRenewalSignal = Boolean(request.signal);
            request.signal.addEventListener("abort", () => {
              ordinaryRenewalAborted = true;
            }, { once: true });
            // Never settle even after abort to prove CredentialCache detaches immediately without waiting for settlement!
            return new Promise<Response>(() => {});
          }
        }
        return network.fetchEndpoint(request);
      },
      generateKey: network.generateKey,
      store: createStore(),
      now: network.now,
      operator: OPERATOR,
      notifyTimeoutMs: 150,
      watchTiming: { initialRetryMs: 50, maxRetryMs: 200 },
      timers: {
        setTimeout: (fn, delayMs) => {
          const entry = {
            fn: () => {
              entry.fired = true;
              fn();
            },
            delayMs,
            cleared: false,
            fired: false,
          };
          timers.push(entry);
          return entry;
        },
        clearTimeout: (handle) => {
          (handle as { cleared: boolean }).cleared = true;
        },
      },
    });
    const bob = new DmClient({
      did: "did:plc:bob",
      memberClient: network.clientFor("did:plc:bob"),
      resolvePds: network.resolvePds,
      resolveKemKey: network.resolveKemKey,
      fetchEndpoint: network.fetchEndpoint,
      generateKey: network.generateKey,
      store: createStore(),
      now: network.now,
    });

    await alice.enableDms("everyone");
    await bob.enableDms("everyone");
    const started = await bob.startConversation(["did:plc:alice"]);
    await alice.accept((await alice.listRequests())[0]!);
    await bob.send(started.convKey, "unpoisoned after renewal timeout");
    const bobHalf = dmConversationUri("did:plc:bob", started.convKey);

    // Watch bobHalf while operator returns 502 so CredentialCache holds an un-notified credential and schedules retry #1.
    await alice.watch([bobHalf]);
    await alice.flushWatchNotifications();
    const retry1 = timers.find((t) => !t.cleared && !t.fired);
    assert.ok(retry1, "initial 502 scheduled retry #1");

    // Advance clock into the ordinary credential renewal window so credentials.get(bobHalf, { signal: deadlineSignal }) must re-mint!
    network.advanceClock(SPACE_CREDENTIAL_LIFETIME_MS - SPACE_CREDENTIAL_RENEW_BEFORE_MS + 1_000);
    operatorOnline = true;
    blackholeBobAuthorize = true;

    const renewStart = performance.now();
    retry1.fn();
    await alice.flushWatchNotifications();
    const renewElapsed = performance.now() - renewStart;
    assert.ok(renewElapsed < 1_500, `timed-out ordinary renewal settled in ${renewElapsed.toFixed(1)}ms`);
    assert.equal(sawOrdinaryRenewalSignal, true, "ordinary renewal authorizeSpaceSync received AbortSignal");
    assert.equal(ordinaryRenewalAborted, true, "ordinary renewal authorizeSpaceSync signal aborted at notifyTimeoutMs");
    assert.equal(confirmCalls, 0);

    const retry2 = timers.find((t) => !t.cleared && !t.fired);
    assert.ok(retry2, "scheduled retry #2 after ordinary renewal timeout");

    // PDS recovers -> BOTH ordinary readConversation() AND retry #2 succeed immediately with zero cache poisoning!
    blackholeBobAuthorize = false;
    const readStart = performance.now();
    const page = await alice.readConversation(started.convKey, started.participants);
    const readElapsed = performance.now() - readStart;
    assert.ok(readElapsed < 1_500, `readConversation() after PDS recovery succeeded in ${readElapsed.toFixed(1)}ms`);
    assert.equal(page.halves["did:plc:bob"], "ok");
    assert.deepEqual(page.messages.map((m) => m.text), ["unpoisoned after renewal timeout"]);

    retry2.fn();
    await alice.flushWatchNotifications();
    assert.equal(confirmCalls, 1, "next notification retry succeeded immediately after PDS recovery");

    await bob.send(started.convKey, "second message");
    await network.flushNotifications();
    assert.deepEqual(deliveredSpaces, [bobHalf]);
    alice.close();
  }

  // 2. Initial alice.watch([inbox], { signal }) aborted mid-flight while initial credential mint hangs:
  //    rejects immediately on abort and leaves CredentialCache unpoisoned so subsequent listRequests() and watch([inbox]) succeed!
  for (const hangLeg of ["authorizeSpaceSync", "getDelegationToken"] as const) {
    const network = new FakeNetwork();
    network.createAccount("did:plc:alice", "pds1");
    network.createAccount("did:plc:bob", "pds2");

    let confirmCalls = 0;
    network.registerEndpoint(OPERATOR.endpoint, async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/xrpc/com.atproto.space.confirmRegistration") {
        confirmCalls += 1;
        const body = (await req.json()) as { challenge: string };
        return Response.json({ challenge: body.challenge });
      }
      return Response.json({});
    });

    const bob = new DmClient({
      did: "did:plc:bob",
      memberClient: network.clientFor("did:plc:bob"),
      resolvePds: network.resolvePds,
      resolveKemKey: network.resolveKemKey,
      fetchEndpoint: network.fetchEndpoint,
      generateKey: network.generateKey,
      store: createStore(),
      now: network.now,
    });

    // Enable Alice's DMs before installing the blackhole wrapper so Bob can deliver a real request to Alice's inbox.
    const setupAlice = new DmClient({
      did: "did:plc:alice",
      memberClient: network.clientFor("did:plc:alice"),
      resolvePds: network.resolvePds,
      resolveKemKey: network.resolveKemKey,
      fetchEndpoint: network.fetchEndpoint,
      generateKey: network.generateKey,
      store: createStore(),
      now: network.now,
    });
    await setupAlice.enableDms("everyone");
    const startedReq = await bob.startConversation(["did:plc:alice"]);

    let blackholeInitialMint = true;
    let wireAborted = false;
    let enteredInitialHang!: () => void;
    const enteredInitialHangPromise = new Promise<void>((resolve) => {
      enteredInitialHang = resolve;
    });

    const realMemberClient = network.clientFor("did:plc:alice");
    const wrappedMemberClient = Object.create(realMemberClient, {
      query: {
        value: (method: string, params?: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
          if (hangLeg === "getDelegationToken" && blackholeInitialMint && method === "com.atproto.space.getDelegationToken") {
            assert.ok(options?.signal, "initial watch getDelegationToken received AbortSignal");
            options.signal.addEventListener("abort", () => {
              wireAborted = true;
            }, { once: true });
            enteredInitialHang();
            return new Promise<never>(() => {});
          }
          return realMemberClient.query(method, params as never, options);
        },
      },
    });

    const alice = new DmClient({
      did: "did:plc:alice",
      memberClient: wrappedMemberClient,
      resolvePds: network.resolvePds,
      resolveKemKey: network.resolveKemKey,
      fetchEndpoint: async (request) => {
        const url = new URL(request.url);
        if (url.origin === OPERATOR.endpoint) {
          return Response.json({ endpoint: OPERATOR.endpoint, token: `dm1-init-abort-${hangLeg}` });
        }
        if (
          hangLeg === "authorizeSpaceSync"
          && blackholeInitialMint
          && request.url.includes("com.atproto.space.authorizeSpaceSync")
          && request.method === "POST"
        ) {
          request.signal.addEventListener("abort", () => {
            wireAborted = true;
          }, { once: true });
          enteredInitialHang();
          return new Promise<Response>(() => {});
        }
        return network.fetchEndpoint(request);
      },
      generateKey: network.generateKey,
      store: createStore(),
      now: network.now,
      operator: OPERATOR,
    });

    const inbox = dmInboxUri("did:plc:alice");
    const watchController = new AbortController();
    const pendingWatch = alice.watch([inbox], { signal: watchController.signal });
    await enteredInitialHangPromise;

    const abortStart = performance.now();
    watchController.abort();
    await assert.rejects(pendingWatch, (err: unknown) => (err as { name?: string })?.name === "AbortError");
    const abortElapsed = performance.now() - abortStart;
    assert.ok(abortElapsed < 100, `aborted initial watch() rejected in ${abortElapsed.toFixed(1)}ms (<100ms)`);
    assert.equal(wireAborted, true, `wire ${hangLeg} signal aborted immediately when initial watch() aborted`);

    // Restore PDS -> subsequent listRequests() AND watch([inbox]) succeed immediately with unpoisoned CredentialCache!
    blackholeInitialMint = false;
    const requests = await alice.listRequests();
    assert.deepEqual(requests.map((r) => r.convKey), [startedReq.convKey]);

    const expiries = await alice.watch([inbox]);
    assert.ok(expiries[inbox], "subsequent watch([inbox]) returned valid expiry");
    await alice.flushWatchNotifications();
    assert.equal(confirmCalls, 1, `subsequent watch([inbox]) after aborted ${hangLeg} confirmed webhook registration`);
    alice.close();
  }
});

test("R12 Round 4 L1 & L2: superseded ordinary mint never clobbers newer sidecar notify/onAccessLost, and aborting a second watch() preserves active watchers", async () => {
  const OPERATOR: OperatorService = {
    serviceRef: "did:web:operator.test#atproto_flock_operator",
    endpoint: "https://operator.test",
  };

  // 1. R4-L1: Superseded ordinary mint failing with SpaceCredentialError (NotAuthorized) or RegistrationNotConfirmed
  //    MUST NOT delete notifyTargets or invoke onAccessLost after a newer sidecar get(space, { notify }) succeeded!
  for (const staleFailure of ["NotAuthorized", "RegistrationNotConfirmed"] as const) {
    const network = new FakeNetwork();
    network.createAccount("did:plc:alice", "pds1");
    const setupAlice = new DmClient({
      did: "did:plc:alice",
      memberClient: network.clientFor("did:plc:alice"),
      resolvePds: network.resolvePds,
      resolveKemKey: network.resolveKemKey,
      fetchEndpoint: network.fetchEndpoint,
      generateKey: network.generateKey,
      store: createStore(),
      now: network.now,
    });
    await setupAlice.enableDms("everyone");
    const inbox = dmInboxUri("did:plc:alice");

    network.registerEndpoint(OPERATOR.endpoint, async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/xrpc/com.atproto.space.confirmRegistration") {
        const body = (await req.json()) as { challenge: string };
        return Response.json({ challenge: body.challenge });
      }
      return Response.json({});
    });

    let interceptOrdinary = false;
    let resolveStaleFetch!: (resp: Response) => void;
    let enteredResolve!: () => void;
    const ordinaryInFlight = new Promise<void>((r) => {
      enteredResolve = r;
    });

    const authorizeNotifySeen: Array<{ endpoint: string; token: string } | null> = [];
    const accessLostCalls: string[] = [];
    const cache = new CredentialCache(
      {
        did: "did:plc:alice",
        memberClient: network.clientFor("did:plc:alice"),
        resolvePds: network.resolvePds,
        resolveKemKey: network.resolveKemKey,
        fetchEndpoint: async (request) => {
          if (request.url.includes("com.atproto.space.authorizeSpaceSync") && request.method === "POST") {
            const parsed = JSON.parse(await request.clone().text()) as { notify?: { endpoint: string; token: string } };
            authorizeNotifySeen.push(parsed.notify ?? null);
            if (interceptOrdinary) {
              interceptOrdinary = false;
              enteredResolve();
              return new Promise<Response>((res) => {
                resolveStaleFetch = res;
              });
            }
          }
          return network.fetchEndpoint(request);
        },
        generateKey: network.generateKey,
        now: network.now,
      },
      async (space) => {
        accessLostCalls.push(space);
      },
    );

    if (staleFailure === "RegistrationNotConfirmed") {
      // Seed an older notify target and advance into renewal window so ordinary get() mints WITH oldTarget!
      await cache.get(inbox, { notify: { endpoint: OPERATOR.endpoint, token: "dm1-old-target" } });
      network.advanceClock(SPACE_CREDENTIAL_LIFETIME_MS - SPACE_CREDENTIAL_RENEW_BEFORE_MS + 1_000);
    }

    // Start ordinary mint #1 (hangs in fetchEndpoint)
    interceptOrdinary = true;
    const staleOrdinary = cache.get(inbox);
    await ordinaryInFlight;

    // Complete sidecar notify mint #2 while ordinary mint #1 is still in flight!
    const target = { endpoint: OPERATOR.endpoint, token: `dm1-sidecar-${staleFailure}` };
    const sidecarCred = await cache.get(inbox, { notify: target });
    assert.deepEqual(sidecarCred.notify, target);

    // Now fail the superseded ordinary mint #1!
    resolveStaleFetch(
      Response.json(
        { error: staleFailure, message: `Simulated stale ${staleFailure}` },
        { status: staleFailure === "NotAuthorized" ? 403 : 400 },
      ),
    );
    if (staleFailure === "NotAuthorized") {
      await assert.rejects(staleOrdinary, { name: "SpaceCredentialError" });
    } else {
      await staleOrdinary;
    }

    assert.deepEqual(accessLostCalls, [], `stale ordinary ${staleFailure} must NOT invoke onAccessLost`);
    const cachedNow = await cache.get(inbox);
    assert.equal(cachedNow.token, sidecarCred.token, "newer sidecar credential remains intact in cache");

    // Advance past credential renewal threshold -> next ordinary renewal STILL carries `target` (notifyTargets was NOT deleted!)
    network.advanceClock(SPACE_CREDENTIAL_LIFETIME_MS - SPACE_CREDENTIAL_RENEW_BEFORE_MS + 1_000);
    authorizeNotifySeen.length = 0;
    const renewed = await cache.get(inbox);
    assert.deepEqual(renewed.notify, target, `subsequent renewal after stale ${staleFailure} kept notifyTargets intact`);
    assert.deepEqual(authorizeNotifySeen, [target]);
  }

  // 2. R4-L2: Aborting a second watch() call while a prior watcher is active MUST NOT clear existing watchers, timers, or notify state!
  {
    const network = new FakeNetwork();
    network.createAccount("did:plc:alice", "pds1");
    network.createAccount("did:plc:bob", "pds2");

    const deliveredSpaces: string[] = [];
    network.registerEndpoint(OPERATOR.endpoint, async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/xrpc/com.atproto.space.confirmRegistration") {
        const body = (await req.json()) as { challenge: string };
        return Response.json({ challenge: body.challenge });
      }
      if (url.pathname === "/xrpc/com.atproto.space.notifySpaceUpdate") {
        const body = (await req.json()) as { space: string };
        deliveredSpaces.push(body.space);
        return Response.json({});
      }
      return Response.json({});
    });

    type ScheduledTimer = { id: number; fn: () => void; delayMs: number; cleared: boolean; fired: boolean };
    let nextId = 1;
    const timers: ScheduledTimer[] = [];

    let hangUnnotifiedRenewal = false;
    let enteredSecondWatchHang!: () => void;
    const secondWatchHanging = new Promise<void>((r) => {
      enteredSecondWatchHang = r;
    });

    const alice = new DmClient({
      did: "did:plc:alice",
      memberClient: network.clientFor("did:plc:alice"),
      resolvePds: network.resolvePds,
      resolveKemKey: network.resolveKemKey,
      fetchEndpoint: async (request) => {
        const url = new URL(request.url);
        if (url.origin === OPERATOR.endpoint && url.pathname.includes(OPERATOR_METHOD.getDmNotifyTarget)) {
          return Response.json({ endpoint: OPERATOR.endpoint, token: "dm1-r4-l2-stable" });
        }
        if (
          hangUnnotifiedRenewal
          && request.url.includes("com.atproto.space.authorizeSpaceSync")
          && request.method === "POST"
        ) {
          enteredSecondWatchHang();
          return new Promise<Response>(() => {});
        }
        return network.fetchEndpoint(request);
      },
      generateKey: network.generateKey,
      store: createStore(),
      now: network.now,
      operator: OPERATOR,
      timers: {
        setTimeout: (fn, delayMs) => {
          const entry: ScheduledTimer = { id: nextId++, fn: () => { entry.fired = true; fn(); }, delayMs, cleared: false, fired: false };
          timers.push(entry);
          return entry as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimeout: (handle) => {
          if (handle) (handle as unknown as ScheduledTimer).cleared = true;
        },
      },
    });
    const bob = new DmClient({
      did: "did:plc:bob",
      memberClient: network.clientFor("did:plc:bob"),
      resolvePds: network.resolvePds,
      resolveKemKey: network.resolveKemKey,
      fetchEndpoint: network.fetchEndpoint,
      generateKey: network.generateKey,
      store: createStore(),
      now: network.now,
    });

    await alice.enableDms("everyone");
    const inbox = dmInboxUri("did:plc:alice");

    // Watcher 1 starts and registers active webhook renewal timer
    const sig1 = new AbortController();
    await alice.watch([inbox], { signal: sig1.signal });
    await alice.flushWatchNotifications();
    const activeTimersBefore = timers.filter((t) => !t.cleared && !t.fired);
    assert.equal(activeTimersBefore.length, 1, "Watcher 1 scheduled active renewal timer");

    // Advance clock into renewal window so a second watch() call triggers credential renewal
    network.advanceClock(SPACE_CREDENTIAL_LIFETIME_MS - SPACE_CREDENTIAL_RENEW_BEFORE_MS + 1_000);
    hangUnnotifiedRenewal = true;

    // Watcher 2 starts and aborts mid-flight!
    const sig2 = new AbortController();
    const secondWatch = alice.watch([inbox], { signal: sig2.signal });
    await secondWatchHanging;
    sig2.abort();
    await assert.rejects(secondWatch, (err: unknown) => (err as { name?: string })?.name === "AbortError");

    // Watcher 1's timer MUST NOT have been cleared, and firing Watcher 1's renewal timer renews webhook registration!
    assert.equal(activeTimersBefore[0]!.cleared, false, "aborting Watcher 2 preserved Watcher 1's active renewal timer");
    hangUnnotifiedRenewal = false;
    activeTimersBefore[0]!.fn();
    await alice.flushWatchNotifications();

    // Advance past original TTL -> Watcher 1's renewed webhook registration STILL delivers live notifications!
    network.advanceClock(SPACE_CREDENTIAL_RENEW_BEFORE_MS + 5_000);
    await bob.startConversation(["did:plc:alice"]);
    await network.flushNotifications();
    assert.deepEqual(deliveredSpaces, [inbox], "Watcher 1's webhook registration remained alive past original TTL");

    sig1.abort();
    alice.close();
  }
});

test("R12 Round 5 M3 & L1: superseded SpaceCredentialError never destroys an active DmClient watch, and stale sidecar failure never erases notify target preserved across drop()/fresh()", async () => {
  const OPERATOR: OperatorService = {
    serviceRef: "did:web:operator.test#atproto_flock_operator",
    endpoint: "https://operator.test",
  };

  // 1. R5-L1: Sidecar failure after drop(space) (which retains notifyTargets and advances cacheGen) MUST NOT erase notifyTargets!
  {
    const network = new FakeNetwork();
    network.createAccount("did:plc:alice", "pds1");
    const setupAlice = new DmClient({
      did: "did:plc:alice",
      memberClient: network.clientFor("did:plc:alice"),
      resolvePds: network.resolvePds,
      resolveKemKey: network.resolveKemKey,
      fetchEndpoint: network.fetchEndpoint,
      generateKey: network.generateKey,
      store: createStore(),
      now: network.now,
    });
    await setupAlice.enableDms("everyone");
    const inbox = dmInboxUri("did:plc:alice");

    network.registerEndpoint(OPERATOR.endpoint, async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/xrpc/com.atproto.space.confirmRegistration") {
        const body = (await req.json()) as { challenge: string };
        return Response.json({ challenge: body.challenge });
      }
      return Response.json({});
    });

    let interceptSidecar = false;
    let enteredSidecar!: () => void;
    const sidecarHanging = new Promise<void>((r) => {
      enteredSidecar = r;
    });
    let resolveSidecar!: (resp: Response) => void;
    const seenNotifyPayloads: Array<{ endpoint: string; token: string } | null> = [];

    const cache = new CredentialCache({
      did: "did:plc:alice",
      memberClient: network.clientFor("did:plc:alice"),
      resolvePds: network.resolvePds,
      resolveKemKey: network.resolveKemKey,
      fetchEndpoint: async (request) => {
        if (request.url.includes("com.atproto.space.authorizeSpaceSync") && request.method === "POST") {
          const parsed = JSON.parse(await request.clone().text()) as { notify?: { endpoint: string; token: string } };
          seenNotifyPayloads.push(parsed.notify ?? null);
          if (interceptSidecar && parsed.notify?.token === "dm1-stale-sidecar") {
            interceptSidecar = false;
            enteredSidecar();
            return new Promise<Response>((res) => {
              resolveSidecar = res;
            });
          }
        }
        return network.fetchEndpoint(request);
      },
      generateKey: network.generateKey,
      now: network.now,
    });

    // Seed initial notify target
    const preservedTarget = { endpoint: OPERATOR.endpoint, token: "dm1-preserved-target" };
    await cache.get(inbox, { notify: preservedTarget });

    // Start a sidecar mint that hangs on the wire
    interceptSidecar = true;
    const staleSidecar = cache.get(inbox, { notify: { endpoint: OPERATOR.endpoint, token: "dm1-stale-sidecar" } });
    await sidecarHanging;

    // Caller runs drop(inbox) WITHOUT clearNotify (retaining preservedTarget!) and mints a fresh credential carrying preservedTarget!
    cache.drop(inbox);
    const refreshed = await cache.get(inbox);
    assert.deepEqual(refreshed.notify, preservedTarget, "drop() without clearNotify preserved notify target on ordinary mint");

    // Now fail the superseded sidecar mint with a transient 502 error!
    resolveSidecar(Response.json({ error: "UpstreamUnavailable", message: "transient" }, { status: 502 }));
    await assert.rejects(staleSidecar);

    // Advance clock into renewal window -> next ordinary renewal MUST still carry `preservedTarget`!
    network.advanceClock(SPACE_CREDENTIAL_LIFETIME_MS - SPACE_CREDENTIAL_RENEW_BEFORE_MS + 1_000);
    seenNotifyPayloads.length = 0;
    const afterStaleFailure = await cache.get(inbox);
    assert.deepEqual(afterStaleFailure.notify, preservedTarget, "R5-L1: stale sidecar failure did NOT erase preserved notifyTarget");
    assert.deepEqual(seenNotifyPayloads, [preservedTarget]);
  }

  // 2. R5-M3: A superseded SpaceCredentialError propagating out of an earlier joined ordinary mint MUST NOT destroy
  //    an active DmClient watch (neither in initial watch() nor in background performNotifyRegistration)!
  {
    const network = new FakeNetwork();
    network.createAccount("did:plc:alice", "pds1");
    network.createAccount("did:plc:bob", "pds2");

    const deliveredSpaces: string[] = [];
    network.registerEndpoint(OPERATOR.endpoint, async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/xrpc/com.atproto.space.confirmRegistration") {
        const body = (await req.json()) as { challenge: string };
        return Response.json({ challenge: body.challenge });
      }
      if (url.pathname === "/xrpc/com.atproto.space.notifySpaceUpdate") {
        const body = (await req.json()) as { space: string };
        deliveredSpaces.push(body.space);
        return Response.json({});
      }
      return Response.json({});
    });

    type ScheduledTimer = { fn: () => void; delayMs: number; cleared: boolean; fired: boolean };
    const timers: ScheduledTimer[] = [];

    let interceptOrdinaryRenewal = false;
    let enteredRenewalHang!: () => void;
    const renewalHanging = new Promise<void>((r) => {
      enteredRenewalHang = r;
    });
    let resolveStaleRenewal!: (resp: Response) => void;

    const alice = new DmClient({
      did: "did:plc:alice",
      memberClient: network.clientFor("did:plc:alice"),
      resolvePds: network.resolvePds,
      resolveKemKey: network.resolveKemKey,
      fetchEndpoint: async (request) => {
        const url = new URL(request.url);
        if (url.origin === OPERATOR.endpoint && url.pathname.includes(OPERATOR_METHOD.getDmNotifyTarget)) {
          return Response.json({ endpoint: OPERATOR.endpoint, token: "dm1-r5-m3-stable" });
        }
        if (
          interceptOrdinaryRenewal
          && request.url.includes("com.atproto.space.authorizeSpaceSync")
          && request.method === "POST"
        ) {
          const parsed = JSON.parse(await request.clone().text()) as { notify?: { token: string } };
          if (!parsed.notify) {
            interceptOrdinaryRenewal = false;
            enteredRenewalHang();
            return new Promise<Response>((res) => {
              resolveStaleRenewal = res;
            });
          }
        }
        return network.fetchEndpoint(request);
      },
      generateKey: network.generateKey,
      store: createStore(),
      now: network.now,
      operator: OPERATOR,
      timers: {
        setTimeout: (fn, delayMs) => {
          const entry: ScheduledTimer = { fn: () => { entry.fired = true; fn(); }, delayMs, cleared: false, fired: false };
          timers.push(entry);
          return entry as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimeout: (handle) => {
          if (handle) (handle as unknown as ScheduledTimer).cleared = true;
        },
      },
    });
    const bob = new DmClient({
      did: "did:plc:bob",
      memberClient: network.clientFor("did:plc:bob"),
      resolvePds: network.resolvePds,
      resolveKemKey: network.resolveKemKey,
      fetchEndpoint: network.fetchEndpoint,
      generateKey: network.generateKey,
      store: createStore(),
      now: network.now,
    });

    await alice.enableDms("everyone");
    const inbox = dmInboxUri("did:plc:alice");

    // Start Watcher 1 -> installs active notified credential + renewal timer
    const sig1 = new AbortController();
    await alice.watch([inbox], { signal: sig1.signal });
    await alice.flushWatchNotifications();
    const initialTimer = timers.find((t) => !t.cleared && !t.fired)!;
    assert.ok(initialTimer, "Watcher 1 scheduled renewal timer");

    // Advance clock past credential expiry so un-notified get() starts a new ordinary mint, while Watcher 1's timer also renews sidecar notify!
    network.advanceClock(SPACE_CREDENTIAL_LIFETIME_MS + 1_000);
    // Drop notify target from CredentialCache via un-notified read race: trigger a second watch() whose initial get(inbox) hangs
    // while Watcher 1's renewal timer fires `fresh(inbox, { notify })` and succeeds FIRST!
    // Clear cached notify on credentials only by letting target age past 20m? No: firing initialTimer runs sidecar `fresh(inbox, { notify })`!
    interceptOrdinaryRenewal = true;
    // Clear cached target age by advancing 20m so initial get() runs un-notified? Wait: ordinary get() carries notifyTargets if set,
    // so let's intercept the FIRST ordinary get() regardless of notify!
    interceptOrdinaryRenewal = false;

    let interceptAnyFirstOrdinary = true;
    let enteredAnyHang!: () => void;
    const anyHanging = new Promise<void>((r) => {
      enteredAnyHang = r;
    });
    let resolveStaleAny!: (resp: Response) => void;
    // Swap fetch wrapper flag via closure:
    void renewalHanging;
    void resolveStaleRenewal;

    const alice2 = new DmClient({
      did: "did:plc:alice",
      memberClient: network.clientFor("did:plc:alice"),
      resolvePds: network.resolvePds,
      resolveKemKey: network.resolveKemKey,
      fetchEndpoint: async (request) => {
        const url = new URL(request.url);
        if (url.origin === OPERATOR.endpoint && url.pathname.includes(OPERATOR_METHOD.getDmNotifyTarget)) {
          return Response.json({ endpoint: OPERATOR.endpoint, token: "dm1-r5-m3-stable" });
        }
        if (
           !url.origin.includes("operator.test")
          && interceptAnyFirstOrdinary
          && request.url.includes("com.atproto.space.authorizeSpaceSync")
          && request.method === "POST"
        ) {
          interceptAnyFirstOrdinary = false;
          enteredAnyHang();
          return new Promise<Response>((res) => {
            resolveStaleAny = res;
          });
        }
        return network.fetchEndpoint(request);
      },
      generateKey: network.generateKey,
      store: createStore(),
      now: network.now,
      operator: OPERATOR,
      timers: {
        setTimeout: (fn, delayMs) => {
          const entry: ScheduledTimer = { fn: () => { entry.fired = true; fn(); }, delayMs, cleared: false, fired: false };
          timers.push(entry);
          return entry as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimeout: (handle) => {
          if (handle) (handle as unknown as ScheduledTimer).cleared = true;
        },
      },
    });
    alice.close();
    timers.length = 0;

    // Seed Watcher 1 on alice2 normally first (disable interception during initial setup)
    interceptAnyFirstOrdinary = false;
    const w1 = new AbortController();
    await alice2.watch([inbox], { signal: w1.signal });
    await alice2.flushWatchNotifications();
    const w1Timer = timers.find((t) => !t.cleared && !t.fired)!;
    assert.ok(w1Timer, "Watcher 1 scheduled renewal timer on alice2");

    // Advance past credential renewal window; start Watcher 2 (whose ordinary get(inbox) hangs on wire!)
    network.advanceClock(SPACE_CREDENTIAL_LIFETIME_MS - SPACE_CREDENTIAL_RENEW_BEFORE_MS + 1_000);
    interceptAnyFirstOrdinary = true;
    const w2 = new AbortController();
    const pendingWatch2 = alice2.watch([inbox], { signal: w2.signal });
    await anyHanging;

    // While Watcher 2's ordinary mint is hanging, Watcher 1's renewal timer fires `fresh(inbox, { notify })` and SUCCEEDS!
    w1Timer.fn();
    await alice2.flushWatchNotifications();
    const renewedTimer = timers.find((t) => !t.cleared && !t.fired)!;
    assert.ok(renewedTimer, "Watcher 1's background sidecar renewal succeeded and scheduled next timer");

    // Now the superseded ordinary mint from Watcher 2 rejects with SpaceCredentialError("NotAuthorized")!
    resolveStaleAny(Response.json({ error: "NotAuthorized", message: "stale refusal" }, { status: 403 }));
    await assert.rejects(pendingWatch2, { name: "SpaceCredentialError" });

    // R5-M3: Watcher 1's active watch, timer, and webhook registration MUST remain completely intact!
    assert.equal(renewedTimer.cleared, false, "R5-M3: superseded SpaceCredentialError did NOT clear Watcher 1's active timer");
    network.advanceClock(SPACE_CREDENTIAL_RENEW_BEFORE_MS + 5_000);
    deliveredSpaces.length = 0;
    await bob.startConversation(["did:plc:alice"]);
    await network.flushNotifications();
    assert.deepEqual(deliveredSpaces, [inbox], "R5-M3: Watcher 1 continued receiving live webhook notifications");

    w1.abort();
    w2.abort();
    alice2.close();
  }
});

test("R12 Round 6 M1: reverse-order stale sidecars (SpaceCredentialError, RegistrationNotConfirmed fallback, and stale success) never overwrite or destroy newer ordinary/sidecar credentials or active watches", async () => {
  const OPERATOR: OperatorService = {
    serviceRef: "did:web:operator.test#atproto_flock_operator",
    endpoint: "https://operator.test",
  };

  // 1. Reverse-order race on CredentialCache:
  //    Sidecar #1 (`opSeq = 1`) starts FIRST and hangs -> Ordinary #2 (`opSeq = 2`) starts SECOND and succeeds ->
  //    Sidecar #1 (`opSeq = 1`) then completes via SpaceCredentialError("NotAuthorized"), RegistrationNotConfirmed fallback, or stale 200 success!
  for (const staleSidecarOutcome of ["NotAuthorized", "RegistrationNotConfirmed", "StaleSuccess"] as const) {
    const network = new FakeNetwork();
    network.createAccount("did:plc:alice", "pds1");
    const setupAlice = new DmClient({
      did: "did:plc:alice",
      memberClient: network.clientFor("did:plc:alice"),
      resolvePds: network.resolvePds,
      resolveKemKey: network.resolveKemKey,
      fetchEndpoint: network.fetchEndpoint,
      generateKey: network.generateKey,
      store: createStore(),
      now: network.now,
    });
    await setupAlice.enableDms("everyone");
    const inbox = dmInboxUri("did:plc:alice");

    network.registerEndpoint(OPERATOR.endpoint, async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/xrpc/com.atproto.space.confirmRegistration") {
        const body = (await req.json()) as { challenge: string };
        return Response.json({ challenge: body.challenge });
      }
      return Response.json({});
    });

    let interceptStaleSidecar = true;
    let savedStaleRequest!: Request;
    let enteredStaleSidecar!: () => void;
    const staleSidecarInFlight = new Promise<void>((r) => {
      enteredStaleSidecar = r;
    });
    let resolveStaleSidecar!: (resp: Response) => void;
    const accessLostSpaces: string[] = [];

    const cache = new CredentialCache(
      {
        did: "did:plc:alice",
        memberClient: network.clientFor("did:plc:alice"),
        resolvePds: network.resolvePds,
        resolveKemKey: network.resolveKemKey,
        fetchEndpoint: async (request) => {
          if (request.url.includes("com.atproto.space.authorizeSpaceSync") && request.method === "POST") {
            const parsed = JSON.parse(await request.clone().text()) as { notify?: { token: string } };
            if (interceptStaleSidecar && parsed.notify?.token === "dm1-stale-first") {
              interceptStaleSidecar = false;
              savedStaleRequest = request.clone();
              enteredStaleSidecar();
              return new Promise<Response>((res) => {
                resolveStaleSidecar = res;
              });
            }
          }
          return network.fetchEndpoint(request);
        },
        generateKey: network.generateKey,
        now: network.now,
      },
      async (sp) => {
        accessLostSpaces.push(sp);
      },
    );

    // Sidecar #1 starts FIRST (`opSeq = 1`) and hangs
    const staleTarget = { endpoint: OPERATOR.endpoint, token: "dm1-stale-first" };
    const staleSidecarPromise = cache.get(inbox, { notify: staleTarget });
    await staleSidecarInFlight;

    // Ordinary #2 (or newer Sidecar #2 when testing RegistrationNotConfirmed / StaleSuccess) starts SECOND and succeeds!
    const newerTarget = { endpoint: OPERATOR.endpoint, token: "dm1-newer-second" };
    const newerCred = staleSidecarOutcome === "NotAuthorized"
      ? await cache.get(inbox) // Pure ordinary mint becoming current without prior cacheGen trickery!
      : await cache.get(inbox, { notify: newerTarget });

    // Now settle older Sidecar #1!
    if (staleSidecarOutcome === "NotAuthorized") {
      resolveStaleSidecar(Response.json({ error: "NotAuthorized", message: "stale sidecar refusal" }, { status: 403 }));
      let caughtErr: unknown;
      await staleSidecarPromise.catch((err) => {
        caughtErr = err;
      });
      assert.equal(cache.isAuthoritativeAccessLoss(inbox, caughtErr), false, "superseded sidecar SpaceCredentialError is NOT authoritative");
      assert.deepEqual(accessLostSpaces, [], "superseded sidecar SpaceCredentialError did NOT invoke onAccessLost");
      const currentAfter = await cache.get(inbox);
      assert.equal(currentAfter.token, newerCred.token, "newer ordinary credential remained cached after stale sidecar SpaceCredentialError");
    } else if (staleSidecarOutcome === "RegistrationNotConfirmed") {
      resolveStaleSidecar(Response.json({ error: "RegistrationNotConfirmed", message: "stale confirm failed" }, { status: 400 }));
      await staleSidecarPromise;
      const currentAfter = await cache.get(inbox);
      assert.equal(currentAfter.token, newerCred.token, "stale sidecar RegistrationNotConfirmed fallback did NOT overwrite newer credential");
      assert.deepEqual(currentAfter.notify, newerTarget, "newer notify target remained intact");
    } else {
      // StaleSuccess: let FakeNetwork issue a real credential for Sidecar #1's original request, and prove it STILL does NOT overwrite `newerCred`!
      const realResp = await network.fetchEndpoint(savedStaleRequest);
      resolveStaleSidecar(realResp);
      await staleSidecarPromise;
      const currentAfter = await cache.get(inbox);
      assert.equal(currentAfter.token, newerCred.token, "stale sidecar 200 success did NOT overwrite newer credential");
      assert.deepEqual(currentAfter.notify, newerTarget, "newer notify target was NOT overwritten by stale sidecar success");
    }
  }

  // 2. End-to-end DmClient reverse-order race (`dm-client.ts:1014`):
  //    Background performNotifyRegistration starts Sidecar #1 (`opSeq = 2`) which hangs ->
  //    time advances into renewal window and a read (`listRequests()`) mints newer Ordinary #3 (`opSeq = 3`) ->
  //    Sidecar #1 (`opSeq = 2`) rejects with SpaceCredentialError("NotAuthorized") ->
  //    DmClient MUST NOT clear the active watch, schedules retry timer cleanly, and recovers live notifications!
  {
    const network = new FakeNetwork();
    network.createAccount("did:plc:alice", "pds1");
    network.createAccount("did:plc:bob", "pds2");

    const deliveredSpaces: string[] = [];
    network.registerEndpoint(OPERATOR.endpoint, async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/xrpc/com.atproto.space.confirmRegistration") {
        const body = (await req.json()) as { challenge: string };
        return Response.json({ challenge: body.challenge });
      }
      if (url.pathname === "/xrpc/com.atproto.space.notifySpaceUpdate") {
        const body = (await req.json()) as { space: string };
        deliveredSpaces.push(body.space);
        return Response.json({});
      }
      return Response.json({});
    });

    type ScheduledTimer = { fn: () => void; delayMs: number; cleared: boolean; fired: boolean };
    const timers: ScheduledTimer[] = [];
    let interceptBgSidecarOnce = true;
    let enteredBgSidecar!: () => void;
    const bgSidecarInFlight = new Promise<void>((r) => {
      enteredBgSidecar = r;
    });
    let resolveBgSidecar!: (resp: Response) => void;

    const alice = new DmClient({
      did: "did:plc:alice",
      memberClient: network.clientFor("did:plc:alice"),
      resolvePds: network.resolvePds,
      resolveKemKey: network.resolveKemKey,
      fetchEndpoint: async (request) => {
        const url = new URL(request.url);
        if (url.origin === OPERATOR.endpoint && url.pathname.includes(OPERATOR_METHOD.getDmNotifyTarget)) {
          return Response.json({ endpoint: OPERATOR.endpoint, token: "dm1-r6-m1-bg" });
        }
        if (
          interceptBgSidecarOnce
          && request.url.includes("com.atproto.space.authorizeSpaceSync")
          && request.method === "POST"
        ) {
          const parsed = JSON.parse(await request.clone().text()) as { notify?: { token: string } };
          if (parsed.notify?.token === "dm1-r6-m1-bg") {
            interceptBgSidecarOnce = false;
            enteredBgSidecar();
            return new Promise<Response>((res) => {
              resolveBgSidecar = res;
            });
          }
        }
        return network.fetchEndpoint(request);
      },
      generateKey: network.generateKey,
      store: createStore(),
      now: network.now,
      operator: OPERATOR,
      timers: {
        setTimeout: (fn, delayMs) => {
          const entry: ScheduledTimer = { fn: () => { entry.fired = true; fn(); }, delayMs, cleared: false, fired: false };
          timers.push(entry);
          return entry as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimeout: (handle) => {
          if (handle) (handle as unknown as ScheduledTimer).cleared = true;
        },
      },
    });
    const bob = new DmClient({
      did: "did:plc:bob",
      memberClient: network.clientFor("did:plc:bob"),
      resolvePds: network.resolvePds,
      resolveKemKey: network.resolveKemKey,
      fetchEndpoint: network.fetchEndpoint,
      generateKey: network.generateKey,
      store: createStore(),
      now: network.now,
    });

    await alice.enableDms("everyone");
    const inbox = dmInboxUri("did:plc:alice");

    // Start Watcher 1 -> initial un-notified get() (`opSeq = 1`) succeeds, background Sidecar (`opSeq = 2`) hangs!
    const sig1 = new AbortController();
    await alice.watch([inbox], { signal: sig1.signal });
    await bgSidecarInFlight;

    // Advance clock into renewal window and run `listRequests()` -> Ordinary mint (`opSeq = 3`) succeeds and becomes current!
    network.advanceClock(SPACE_CREDENTIAL_LIFETIME_MS - SPACE_CREDENTIAL_RENEW_BEFORE_MS + 1_000);
    await alice.listRequests();

    // Now older background Sidecar (`opSeq = 2`) rejects with SpaceCredentialError("NotAuthorized")!
    resolveBgSidecar(Response.json({ error: "NotAuthorized", message: "stale bg sidecar refusal" }, { status: 403 }));
    await alice.flushWatchNotifications();

    // Active watch MUST NOT have been cleared -> retry timer was scheduled and succeeds on next tick!
    const retryTimer = timers.find((t) => !t.cleared && !t.fired);
    assert.ok(retryTimer, "R6-M1: DmClient preserved active watch and scheduled retry timer after superseded sidecar SpaceCredentialError");
    retryTimer.fn();
    await alice.flushWatchNotifications();

    await bob.startConversation(["did:plc:alice"]);
    await network.flushNotifications();
    assert.deepEqual(deliveredSpaces, [inbox], "R6-M1: preserved DmClient watch recovered webhook notifications");

    sig1.abort();
    alice.close();
  }
});

test("R12 Round 7 M1: older sidecars are fenced while a newer sidecar is STILL pending in-flight, and committedNotifySeq advances monotonically across clearNotify() + stale access loss", async () => {
  const OPERATOR: OperatorService = {
    serviceRef: "did:web:operator.test#atproto_flock_operator",
    endpoint: "https://operator.test",
  };

  // 1. Older sidecar (`opSeq = 1`) settles WHILE newer sidecar (`opSeq = 2`) is STILL pending in-flight!
  for (const staleOutcome of ["NotAuthorized", "RegistrationNotConfirmed", "StaleSuccess"] as const) {
    const network = new FakeNetwork();
    network.createAccount("did:plc:alice", "pds1");
    const setupAlice = new DmClient({
      did: "did:plc:alice",
      memberClient: network.clientFor("did:plc:alice"),
      resolvePds: network.resolvePds,
      resolveKemKey: network.resolveKemKey,
      fetchEndpoint: network.fetchEndpoint,
      generateKey: network.generateKey,
      store: createStore(),
      now: network.now,
    });
    await setupAlice.enableDms("everyone");
    const inbox = dmInboxUri("did:plc:alice");

    network.registerEndpoint(OPERATOR.endpoint, async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/xrpc/com.atproto.space.confirmRegistration") {
        const body = (await req.json()) as { challenge: string };
        return Response.json({ challenge: body.challenge });
      }
      return Response.json({});
    });

    let savedReq1!: Request;
    let savedReq2!: Request;
    let resolveReq1!: (resp: Response) => void;
    let resolveReq2!: (resp: Response) => void;
    let entered1!: () => void;
    let entered2!: () => void;
    const inFlight1 = new Promise<void>((r) => { entered1 = r; });
    const inFlight2 = new Promise<void>((r) => { entered2 = r; });
    const accessLost: string[] = [];

    const cache = new CredentialCache(
      {
        did: "did:plc:alice",
        memberClient: network.clientFor("did:plc:alice"),
        resolvePds: network.resolvePds,
        resolveKemKey: network.resolveKemKey,
        fetchEndpoint: async (request) => {
          if (request.url.includes("com.atproto.space.authorizeSpaceSync") && request.method === "POST") {
            const parsed = JSON.parse(await request.clone().text()) as { notify?: { token: string } };
            if (parsed.notify?.token === "dm1-pending-old") {
              savedReq1 = request.clone();
              entered1();
              return new Promise<Response>((res) => { resolveReq1 = res; });
            }
            if (parsed.notify?.token === "dm1-pending-new") {
              savedReq2 = request.clone();
              entered2();
              return new Promise<Response>((res) => { resolveReq2 = res; });
            }
          }
          return network.fetchEndpoint(request);
        },
        generateKey: network.generateKey,
        now: network.now,
      },
      async (sp) => {
        accessLost.push(sp);
      },
    );

    const oldTarget = { endpoint: OPERATOR.endpoint, token: "dm1-pending-old" };
    const newTarget = { endpoint: OPERATOR.endpoint, token: "dm1-pending-new" };

    // Start Sidecar #1 (`opSeq = 1`) AND Sidecar #2 (`opSeq = 2`) — BOTH are simultaneously pending in-flight!
    const p1 = cache.get(inbox, { notify: oldTarget });
    await inFlight1;
    const p2 = cache.get(inbox, { notify: newTarget });
    await inFlight2;

    // Settle older Sidecar #1 (`opSeq = 1`) FIRST while newer Sidecar #2 (`opSeq = 2`) is STILL pending!
    if (staleOutcome === "NotAuthorized") {
      resolveReq1(Response.json({ error: "NotAuthorized", message: "stale while p2 pending" }, { status: 403 }));
      let err1: unknown;
      await p1.catch((e) => { err1 = e; });
      assert.equal(cache.isAuthoritativeAccessLoss(inbox, err1), false, "R7-M1: older sidecar loss is NOT authoritative while newer sidecar is pending");
      assert.deepEqual(accessLost, [], "R7-M1: onAccessLost NOT invoked while newer sidecar is pending");
    } else if (staleOutcome === "RegistrationNotConfirmed") {
      resolveReq1(Response.json({ error: "RegistrationNotConfirmed", message: "stale unconfirmed" }, { status: 400 }));
      await p1;
    } else {
      resolveReq1(await network.fetchEndpoint(savedReq1));
      await p1;
    }

    // Now resolve newer Sidecar #2 (`opSeq = 2`) -> its credential & target MUST win cleanly!
    resolveReq2(await network.fetchEndpoint(savedReq2));
    const cred2 = await p2;
    assert.deepEqual(cred2.notify, newTarget);
    const cachedFinal = await cache.get(inbox);
    assert.equal(cachedFinal.token, cred2.token, `R7-M1 (${staleOutcome}): newer sidecar credential owns slot`);
    assert.deepEqual(cachedFinal.notify, newTarget, `R7-M1 (${staleOutcome}): newer sidecar notify target owns slot`);
  }

  // 2. Monotonic committedNotifySeq: clearNotify() (`opSeq = 3`) followed by older `SpaceCredentialError` or older sidecar
  //    MUST NEVER lower committedNotifySeq or restore a cleared notify target!
  {
    const network = new FakeNetwork();
    network.createAccount("did:plc:alice", "pds1");
    const setupAlice = new DmClient({
      did: "did:plc:alice",
      memberClient: network.clientFor("did:plc:alice"),
      resolvePds: network.resolvePds,
      resolveKemKey: network.resolveKemKey,
      fetchEndpoint: network.fetchEndpoint,
      generateKey: network.generateKey,
      store: createStore(),
      now: network.now,
    });
    await setupAlice.enableDms("everyone");
    const inbox = dmInboxUri("did:plc:alice");

    network.registerEndpoint(OPERATOR.endpoint, async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/xrpc/com.atproto.space.confirmRegistration") {
        const body = (await req.json()) as { challenge: string };
        return Response.json({ challenge: body.challenge });
      }
      return Response.json({});
    });

    let savedSidecar2!: Request;
    let resolveOp1!: (resp: Response) => void;
    let resolveSidecar2!: (resp: Response) => void;
    let e1!: () => void;
    let e2!: () => void;
    const p1InFlight = new Promise<void>((r) => { e1 = r; });
    const p2InFlight = new Promise<void>((r) => { e2 = r; });
    const seenPayloads: Array<unknown> = [];

    const cache = new CredentialCache({
      did: "did:plc:alice",
      memberClient: network.clientFor("did:plc:alice"),
      resolvePds: network.resolvePds,
      resolveKemKey: network.resolveKemKey,
      fetchEndpoint: async (request) => {
        if (request.url.includes("com.atproto.space.authorizeSpaceSync") && request.method === "POST") {
          const parsed = JSON.parse(await request.clone().text()) as { notify?: { token: string } };
          seenPayloads.push(parsed.notify ?? null);
          if (!parsed.notify && resolveOp1 === undefined) {
            e1();
            return new Promise<Response>((res) => { resolveOp1 = res; });
          }
          if (parsed.notify?.token === "dm1-before-clear") {
            savedSidecar2 = request.clone();
            e2();
            return new Promise<Response>((res) => { resolveSidecar2 = res; });
          }
        }
        return network.fetchEndpoint(request);
      },
      generateKey: network.generateKey,
      now: network.now,
    });

    // Op 1 (`opSeq = 1`): ordinary mint hangs
    const op1 = cache.get(inbox);
    await p1InFlight;
    // Op 2 (`opSeq = 2`): sidecar mint hangs
    const op2 = cache.get(inbox, { notify: { endpoint: OPERATOR.endpoint, token: "dm1-before-clear" } });
    await p2InFlight;
    // Op 3 (`opSeq = 3`): clearNotify() advances committedNotifySeq = 3!
    cache.clearNotify(inbox);

    // Op 1 (`opSeq = 1`) fails with SpaceCredentialError, then Op 2 (`opSeq = 2`) succeeds:
    resolveOp1(Response.json({ error: "NotAuthorized", message: "stale" }, { status: 403 }));
    await assert.rejects(op1);
    resolveSidecar2(await network.fetchEndpoint(savedSidecar2));
    await op2;

    // Next fresh/get mint MUST NOT carry "dm1-before-clear" because clearNotify (`opSeq = 3`) was never lowered!
    seenPayloads.length = 0;
    const afterClear = await cache.get(inbox);
    assert.equal(afterClear.notify, undefined, "R7-M1: clearNotify remained monotonic; older sidecar did NOT restore cleared target");
    assert.deepEqual(seenPayloads, [null]);
  }

  // 3. R8-M1: A successful newer `mintFreshUnnotified` on a space with existing notified state MUST still advance
  //    `committedCredSeq` durably (while leaving the cached notified credential intact), so an older in-flight sidecar
  //    settling afterward CANNOT pass `ownsCredentialSlot`, delete cached state, or invoke `onAccessLost`!
  {
    const network = new FakeNetwork();
    network.createAccount("did:plc:alice", "pds1");
    const setupAlice = new DmClient({
      did: "did:plc:alice",
      memberClient: network.clientFor("did:plc:alice"),
      resolvePds: network.resolvePds,
      resolveKemKey: network.resolveKemKey,
      fetchEndpoint: network.fetchEndpoint,
      generateKey: network.generateKey,
      store: createStore(),
      now: network.now,
    });
    await setupAlice.enableDms("everyone");
    const inbox = dmInboxUri("did:plc:alice");

    network.registerEndpoint(OPERATOR.endpoint, async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/xrpc/com.atproto.space.confirmRegistration") {
        const body = (await req.json()) as { challenge: string };
        return Response.json({ challenge: body.challenge });
      }
      return Response.json({});
    });

    let resolveOlderSidecar!: (resp: Response) => void;
    let enteredOlderSidecar!: () => void;
    const olderSidecarHanging = new Promise<void>((r) => { enteredOlderSidecar = r; });
    const accessLost: string[] = [];

    const cache = new CredentialCache(
      {
        did: "did:plc:alice",
        memberClient: network.clientFor("did:plc:alice"),
        resolvePds: network.resolvePds,
        resolveKemKey: network.resolveKemKey,
        fetchEndpoint: async (request) => {
          if (request.url.includes("com.atproto.space.authorizeSpaceSync") && request.method === "POST") {
            const parsed = JSON.parse(await request.clone().text()) as { notify?: { token: string } };
            if (parsed.notify?.token === "dm1-r8-stale-sidecar") {
              enteredOlderSidecar();
              return new Promise<Response>((res) => { resolveOlderSidecar = res; });
            }
          }
          return network.fetchEndpoint(request);
        },
        generateKey: network.generateKey,
        now: network.now,
      },
      async (sp) => {
        accessLost.push(sp);
      },
    );

    // Seed an active notified credential (`opSeq = 1`)
    const activeTarget = { endpoint: OPERATOR.endpoint, token: "dm1-r8-active" };
    const activeCred = await cache.get(inbox, { notify: activeTarget });
    assert.deepEqual(activeCred.notify, activeTarget);

    // Start an older sidecar (`opSeq = 2`) that hangs on the wire
    const staleSidecar = cache.get(inbox, { notify: { endpoint: OPERATOR.endpoint, token: "dm1-r8-stale-sidecar" } });
    await olderSidecarHanging;

    // Run a newer `mintFreshUnnotified` (`opSeq = 3`) while `activeCred` & `activeTarget` are present:
    // it returns a fresh un-notified PoP credential without clobbering `activeCred`, AND commits durable fence `3`!
    const popCred = await cache.mintFreshUnnotified(inbox);
    assert.equal(popCred.notify, undefined);
    assert.notEqual(popCred.token, activeCred.token);

    // Now older sidecar (`opSeq = 2`) fails with `SpaceCredentialError("NotAuthorized")` AFTER `mintFreshUnnotified` (`opSeq = 3`) unregistered!
    resolveOlderSidecar(Response.json({ error: "NotAuthorized", message: "stale after mintFreshUnnotified" }, { status: 403 }));
    let caughtStale: unknown;
    await staleSidecar.catch((err) => { caughtStale = err; });

    assert.equal(cache.isAuthoritativeAccessLoss(inbox, caughtStale), false, "R8-M1: older sidecar fenced by durable mintFreshUnnotified opSeq");
    assert.deepEqual(accessLost, [], "R8-M1: onAccessLost NOT invoked");
    const stillActive = await cache.get(inbox);
    assert.equal(stillActive.token, activeCred.token, "R8-M1: active notified credential remained intact in cache");
    assert.deepEqual(stillActive.notify, activeTarget, "R8-M1: active notify target remained intact");
  }

  // 4. R9-M1: Four-operation causal fence regression (`op1` notified -> `op2` older sidecar pending ->
  //    `op3` (`mintFreshUnnotified` | `ordinary` | `sidecar`) succeeds WHILE later `op4` is active ->
  //    `op4` aborts or fails transiently with HTTP 502 -> `op2` rejects with `SpaceCredentialError` or HTTP 502):
  //    `op3` MUST durably advance `settledFenceSeq` even while `op4 > op3` is active, so `op2` NEVER purges state or fires `onAccessLost`!
  for (const op3Kind of ["mintFreshUnnotified", "ordinary", "sidecar"] as const) {
    for (const op4End of ["abort", "transient502"] as const) {
      for (const op2End of ["NotAuthorized", "transient502"] as const) {
        const network = new FakeNetwork();
        network.createAccount("did:plc:alice", "pds1");
        const setupAlice = new DmClient({
          did: "did:plc:alice",
          memberClient: network.clientFor("did:plc:alice"),
          resolvePds: network.resolvePds,
          resolveKemKey: network.resolveKemKey,
          fetchEndpoint: network.fetchEndpoint,
          generateKey: network.generateKey,
          store: createStore(),
          now: network.now,
        });
        await setupAlice.enableDms("everyone");
        const inbox = dmInboxUri("did:plc:alice");

        network.registerEndpoint(OPERATOR.endpoint, async (req) => {
          const url = new URL(req.url);
          if (url.pathname === "/xrpc/com.atproto.space.confirmRegistration") {
            const body = (await req.json()) as { challenge: string };
            return Response.json({ challenge: body.challenge });
          }
          return Response.json({});
        });

        let phase: "seed" | "op2" | "op3" | "op4" | "done" = "seed";
        let savedOp3Req!: Request;
        let resolveOp2!: (resp: Response) => void;
        let resolveOp3!: (resp: Response) => void;
        let resolveOp4!: (resp: Response) => void;
        let enteredOp2!: () => void;
        let enteredOp3!: () => void;
        let enteredOp4!: () => void;
        const op2InFlight = new Promise<void>((r) => { enteredOp2 = r; });
        const op3InFlight = new Promise<void>((r) => { enteredOp3 = r; });
        const op4InFlight = new Promise<void>((r) => { enteredOp4 = r; });
        const accessLost: string[] = [];

        const cache = new CredentialCache(
          {
            did: "did:plc:alice",
            memberClient: network.clientFor("did:plc:alice"),
            resolvePds: network.resolvePds,
            resolveKemKey: network.resolveKemKey,
            fetchEndpoint: async (request) => {
              if (request.url.includes("com.atproto.space.authorizeSpaceSync") && request.method === "POST") {
                if (phase === "op2") {
                  phase = "op3";
                  enteredOp2();
                  return new Promise<Response>((res) => { resolveOp2 = res; });
                }
                if (phase === "op3") {
                  phase = "op4";
                  savedOp3Req = request.clone();
                  enteredOp3();
                  return new Promise<Response>((res) => { resolveOp3 = res; });
                }
                if (phase === "op4") {
                  phase = "done";
                  enteredOp4();
                  return new Promise<Response>((res) => { resolveOp4 = res; });
                }
              }
              return network.fetchEndpoint(request);
            },
            generateKey: network.generateKey,
            now: network.now,
          },
          async (sp) => {
            accessLost.push(sp);
          },
        );

        const activeTarget = { endpoint: OPERATOR.endpoint, token: "dm1-r9-active" };
        const op1Cred = await cache.get(inbox, { notify: activeTarget });
        assert.deepEqual(op1Cred.notify, activeTarget);

        // Start op2 (`seq = 2`): older sidecar hanging on wire
        phase = "op2";
        const op2Promise = cache.get(inbox, { notify: { endpoint: OPERATOR.endpoint, token: "dm1-r9-stale-op2" } });
        await op2InFlight;

        // Start op3 (`seq = 3`) and hang so we can start op4 (`seq = 4`) BEFORE op3 settles!
        const op3Target = { endpoint: OPERATOR.endpoint, token: "dm1-r9-op3-target" };
        let op3Promise: Promise<unknown>;
        if (op3Kind === "mintFreshUnnotified") {
          op3Promise = cache.mintFreshUnnotified(inbox);
        } else if (op3Kind === "ordinary") {
          network.advanceClock(SPACE_CREDENTIAL_LIFETIME_MS - SPACE_CREDENTIAL_RENEW_BEFORE_MS + 1_000);
          op3Promise = cache.get(inbox);
        } else {
          op3Promise = cache.get(inbox, { notify: op3Target });
        }
        await op3InFlight;

        // Start op4 (`seq = 4`) so `activeOpSeqs` contains `4 > 3` when `op3` settles!
        const op4Ctrl = new AbortController();
        const op4Promise = op4End === "abort"
          ? cache.get(inbox, { notify: { endpoint: OPERATOR.endpoint, token: "dm1-r9-op4-aborted" }, signal: op4Ctrl.signal })
          : cache.mintFreshUnnotified(inbox, op4Ctrl.signal);
        await op4InFlight;

        // Settle op3 (`seq = 3`) with 200 OK WHILE op4 (`seq = 4`) is STILL active!
        resolveOp3(await network.fetchEndpoint(savedOp3Req));
        const op3Cred = (await op3Promise) as { token: string; notify?: { endpoint: string; token: string } };

        // Now settle op4 (`seq = 4`) via abort OR transient HTTP 502 (committing NO credential)!
        if (op4End === "abort") {
          op4Ctrl.abort();
          await assert.rejects(op4Promise);
        } else {
          resolveOp4(Response.json({ error: "UpstreamUnavailable", message: "transient 502" }, { status: 502 }));
          await assert.rejects(op4Promise);
        }

        // Finally settle older op2 (`seq = 2`) with SpaceCredentialError("NotAuthorized") OR transient 502!
        if (op2End === "NotAuthorized") {
          resolveOp2(Response.json({ error: "NotAuthorized", message: "stale op2 refusal" }, { status: 403 }));
        } else {
          resolveOp2(Response.json({ error: "UpstreamUnavailable", message: "stale op2 502" }, { status: 502 }));
        }
        let err2: unknown;
        await op2Promise.catch((e) => { err2 = e; });

        const label = `R9-M1 (${op3Kind} / ${op4End} / ${op2End})`;
        assert.equal(cache.isAuthoritativeAccessLoss(inbox, err2), false, `${label}: op2 is NOT authoritative access loss`);
        assert.deepEqual(accessLost, [], `${label}: onAccessLost was NOT invoked`);

        const expectedTarget = op3Kind === "sidecar" ? op3Target : activeTarget;
        const expectedToken = op3Kind === "mintFreshUnnotified" ? op1Cred.token : op3Cred.token;
        const cachedAfter = await cache.get(inbox);
        assert.equal(cachedAfter.token, expectedToken, `${label}: valid cached credential survived`);
        assert.deepEqual(cachedAfter.notify, expectedTarget, `${label}: valid notify target survived`);
      }
    }
  }

  // 5. R10-M1 / R7-M1: `RegistrationNotConfirmed` fast-path reuse (and unnotified fallback) MUST advance `settledFenceSeq`
  //    (upstream `authorizeSpaceSync` verifies space access BEFORE `confirmRegistration`), so an older pending sidecar
  //    rejecting afterward with `SpaceCredentialError` NEVER purges cached state or invokes `onAccessLost`!
  for (const withLaterAbortedOp4 of [false, true] as const) {
    const network = new FakeNetwork();
    network.createAccount("did:plc:alice", "pds1");
    const setupAlice = new DmClient({
      did: "did:plc:alice",
      memberClient: network.clientFor("did:plc:alice"),
      resolvePds: network.resolvePds,
      resolveKemKey: network.resolveKemKey,
      fetchEndpoint: network.fetchEndpoint,
      generateKey: network.generateKey,
      store: createStore(),
      now: network.now,
    });
    await setupAlice.enableDms("everyone");
    const inbox = dmInboxUri("did:plc:alice");

    // Operator rejects confirmRegistration (`RegistrationNotConfirmed`)!
    network.registerEndpoint(OPERATOR.endpoint, async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/xrpc/com.atproto.space.confirmRegistration") {
        return Response.json({ error: "InvalidRequest", message: "refused" }, { status: 400 });
      }
      return Response.json({});
    });

    let resolveOlderOp2!: (resp: Response) => void;
    let resolveOp3!: (resp: Response) => void;
    let savedOp3Req!: Request;
    let enteredOp2!: () => void;
    let enteredOp3!: () => void;
    let enteredOp4!: () => void;
    const op2InFlight = new Promise<void>((r) => { enteredOp2 = r; });
    const op3InFlight = new Promise<void>((r) => { enteredOp3 = r; });
    const op4InFlight = new Promise<void>((r) => { enteredOp4 = r; });
    const accessLost: string[] = [];

    const cache = new CredentialCache(
      {
        did: "did:plc:alice",
        memberClient: network.clientFor("did:plc:alice"),
        resolvePds: network.resolvePds,
        resolveKemKey: network.resolveKemKey,
        fetchEndpoint: async (request) => {
          if (request.url.includes("com.atproto.space.authorizeSpaceSync") && request.method === "POST") {
            const parsed = JSON.parse(await request.clone().text()) as { notify?: { token: string } };
            if (parsed.notify?.token === "dm1-r10-stale-op2") {
              enteredOp2();
              return new Promise<Response>((res) => { resolveOlderOp2 = res; });
            }
            if (parsed.notify?.token === "dm1-r10-unconfirmed-op3") {
              savedOp3Req = request.clone();
              enteredOp3();
              return new Promise<Response>((res) => { resolveOp3 = res; });
            }
            if (parsed.notify?.token === "dm1-r10-aborted-op4") {
              enteredOp4();
              return new Promise<Response>(() => {});
            }
          }
          return network.fetchEndpoint(request);
        },
        generateKey: network.generateKey,
        now: network.now,
      },
      async (sp) => {
        accessLost.push(sp);
      },
    );

    // Seed usable un-notified credential (`op1`, `seq = 1`) so `op3` takes the `RegistrationNotConfirmed` fast path!
    const op1Unnotified = await cache.get(inbox);
    assert.equal(op1Unnotified.notify, undefined);

    // Start older sidecar `op2` (`seq = 2`) and hang
    const op2Promise = cache.get(inbox, { notify: { endpoint: OPERATOR.endpoint, token: "dm1-r10-stale-op2" } });
    await op2InFlight;

    // Start newer sidecar `op3` (`seq = 3`) which hits real `RegistrationNotConfirmed` and takes fast path returning `op1Unnotified`!
    const op3Promise = cache.get(inbox, { notify: { endpoint: OPERATOR.endpoint, token: "dm1-r10-unconfirmed-op3" } });
    await op3InFlight;

    const op4Ctrl = new AbortController();
    let op4Promise: Promise<unknown> | undefined;
    if (withLaterAbortedOp4) {
      op4Promise = cache.get(inbox, { notify: { endpoint: OPERATOR.endpoint, token: "dm1-r10-aborted-op4" }, signal: op4Ctrl.signal });
      await op4InFlight;
    }

    // Resolve `op3` against FakeNetwork -> operator refuses confirmation -> PDS returns `RegistrationNotConfirmed` -> fast path returns `op1Unnotified`!
    resolveOp3(await network.fetchEndpoint(savedOp3Req));
    const op3Returned = await op3Promise;
    assert.equal(op3Returned.token, op1Unnotified.token, "op3 took RegistrationNotConfirmed fast path");

    if (op4Promise) {
      op4Ctrl.abort();
      await assert.rejects(op4Promise);
    }

    // Now older `op2` (`seq = 2`) rejects with `SpaceCredentialError("NotAuthorized")` -> MUST be fenced by `op3`!
    resolveOlderOp2(Response.json({ error: "NotAuthorized", message: "stale op2 refusal" }, { status: 403 }));
    let err2: unknown;
    await op2Promise.catch((e) => { err2 = e; });

    assert.equal(cache.isAuthoritativeAccessLoss(inbox, err2), false, `R10-M1 (op4=${withLaterAbortedOp4}): older op2 fenced after RegistrationNotConfirmed fast path`);
    assert.deepEqual(accessLost, [], `R10-M1 (op4=${withLaterAbortedOp4}): onAccessLost NOT invoked`);
    const cachedAfter = await cache.get(inbox);
    assert.equal(cachedAfter.token, op1Unnotified.token, `R10-M1 (op4=${withLaterAbortedOp4}): cached unnotified credential survived intact`);
  }
});
