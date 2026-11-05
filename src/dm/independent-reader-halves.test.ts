import assert from "node:assert/strict";
import test from "node:test";
import { readIndependentDmConversation } from "@/reader/independent-dm";
import { DmClient, type DmDeps, type DmStore } from "./dm-client";
import { FakeDmNetwork } from "./testing/fake-pds";

// These live beside the DM client because the independent reader may not import src/dm/** (M6 independence proof), and the
// conversation they read is written by the DM client against its fake network.

function memoryStore(): DmStore {
  const map = new Map<string, string>();
  return {
    async get(key) { return map.get(key) ?? null; },
    async set(key, value) { map.set(key, value); },
    async delete(key) { map.delete(key); },
  };
}

async function conversationOf(network: FakeDmNetwork) {
  const depsFor = (did: string): DmDeps => ({
    did, memberClient: network.clientFor(did), resolvePds: network.resolvePds, resolveKemKey: network.resolveKemKey,
    fetchEndpoint: network.fetchEndpoint, generateKey: network.generateKey, store: memoryStore(), now: () => network.now(),
  });
  network.createAccount("did:plc:alice", "pds1");
  network.createAccount("did:plc:bob", "pds2");
  const alice = new DmClient(depsFor("did:plc:alice"));
  const bob = new DmClient(depsFor("did:plc:bob"));
  await bob.enableDms("everyone");
  const started = await alice.startConversation(["did:plc:bob"]);
  await bob.accept((await bob.listRequests())[0]!);
  await alice.send(started.convKey, "hi bob");
  network.advanceClock(2);
  await bob.send(started.convKey, "hi alice");
  return { started, deps: depsFor("did:plc:alice") };
}

test("a participant whose account was deactivated reads as a missing half and the other half is still read", async () => {
  // #given a conversation whose other participant has since deactivated their account
  const network = new FakeDmNetwork();
  const { started, deps } = await conversationOf(network);
  network.setAccountState("did:plc:bob", "deactivated");

  // #when the independent reader reads it
  const conversation = await readIndependentDmConversation(deps, started.convKey, started.participants);

  // #then the read succeeds with bob's half missing and only alice's message shown
  assert.equal(conversation.halves["did:plc:bob"], "missing");
  assert.equal(conversation.halves["did:plc:alice"], "ok");
  assert.deepEqual(conversation.messages.map((message) => message.text), ["hi bob"]);
});

test("a participant whose host fails while its reactions are listed is flagged as a missing half and its messages are kept", async () => {
  // #given bob's host answers the header and messages but fails the reaction listing
  const network = new FakeDmNetwork();
  const { started, deps } = await conversationOf(network);
  const failing: DmDeps = {
    ...deps,
    fetchEndpoint: async (request) => request.url.includes("repo=did%3Aplc%3Abob") && request.url.includes("org.slack.dm.reaction")
      ? new Response(JSON.stringify({ error: "UpstreamFailure", message: "Bad Gateway" }), { status: 502, headers: { "content-type": "application/json" } })
      : network.fetchEndpoint(request),
  };

  // #when the independent reader reads it
  const conversation = await readIndependentDmConversation(failing, started.convKey, started.participants);

  // #then both halves' messages are shown and bob's half is flagged
  assert.deepEqual(conversation.messages.map((message) => message.text), ["hi alice", "hi bob"]);
  assert.equal(conversation.halves["did:plc:bob"], "missing");
});
