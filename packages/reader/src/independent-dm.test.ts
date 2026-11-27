import assert from "node:assert/strict";
import test from "node:test";
import { COMMIT_MAC_PROFILE, RECORD_MAC_PROFILE } from "@atproto/space";
import { memberspacePolicy } from "@flock/protocol/atproto/space-policy";
import { dmConversationUri, tidNow } from "@flock/protocol/keys";
import { COLLECTION, SPACE_TYPE } from "@flock/protocol/nsids";
import { FakeNetwork } from "@flock/testing/fake-network";
import { mergeIndependentDmMessages, readIndependentDmConversation, type IndependentDmDeps } from "./independent-dm";

function record(ownerDid: string, rkey: string) {
  return {
    uri: `at:space/${ownerDid}/new.flock.dm.conversation/conv/${ownerDid}/new.flock.dm.message/${rkey}`,
    ownerDid,
    rkey,
    value: { text: `${ownerDid}-${rkey}`, createdAt: "2026-01-01T00:00:00.000Z" },
  };
}

test("merges records from every half by rkey, newest first", () => {
  const records = [record("alice", "3"), record("alice", "1"), record("bob", "4"), record("bob", "2")];
  const result = mergeIndependentDmMessages(records, { limit: 10 });
  assert.deepEqual(result.map((message) => message.rkey), ["4", "3", "2", "1"]);
  assert.equal(result[0]!.text, "bob-4");
  assert.equal(result[0]!.ownerDid, "bob");
});

test("applies the limit after sorting", () => {
  const records = [record("alice", "3"), record("alice", "2"), record("alice", "1")];
  const result = mergeIndependentDmMessages(records, { limit: 2 });
  assert.deepEqual(result.map((message) => message.rkey), ["3", "2"]);
});

test("the before cursor excludes records at or after it", () => {
  const records = [record("alice", "5"), record("alice", "3"), record("alice", "1")];
  const result = mergeIndependentDmMessages(records, { limit: 10, before: "3" });
  assert.deepEqual(result.map((message) => message.rkey), ["1"]);
});

test("deduplicates by URI, keeping one entry per record", () => {
  const shared = record("alice", "2");
  const result = mergeIndependentDmMessages([shared, { ...shared }, record("alice", "1")], { limit: 10 });
  assert.deepEqual(result.map((message) => message.rkey), ["2", "1"]);
});

test("breaks rkey ties by URI so the order is deterministic", () => {
  const left = record("aaa", "1");
  const right = record("zzz", "1");
  const result = mergeIndependentDmMessages([right, left], { limit: 10 });
  assert.deepEqual(result.map((message) => message.ownerDid), ["aaa", "zzz"]);
});

test("carries the optional parent field through", () => {
  const withParent = { ...record("alice", "2"), value: { text: "reply", createdAt: "2026-01-01T00:00:00.000Z", parent: "at://parent" } };
  const result = mergeIndependentDmMessages([withParent], { limit: 10 });
  assert.equal(result[0]!.parent, "at://parent");
});

test("an empty record list returns no messages", () => {
  assert.deepEqual(mergeIndependentDmMessages([], { limit: 5 }), []);
});

test("rejects a non-positive-integer limit", () => {
  assert.throws(() => mergeIndependentDmMessages([], { limit: 0 }), RangeError);
  assert.throws(() => mergeIndependentDmMessages([], { limit: 1.5 }), RangeError);
});

const ALICE = "did:plc:alice";
const BOB = "did:plc:bob2";
const TIMESTAMP = "2026-11-17T12:00:00.000Z";

function dmDeps(
  network: FakeNetwork,
  did: string,
  onRequest?: (request: Request) => void,
): IndependentDmDeps {
  return {
    memberClient: network.clientFor(did),
    resolvePds: network.resolvePds,
    resolveKemKey: network.resolveKemKey,
    fetchEndpoint: async (request: Request) => {
      onRequest?.(request.clone());
      return network.fetchEndpoint(request);
    },
    generateKey: network.generateKey,
    now: network.now,
  };
}

async function setupDmConversation(network: FakeNetwork) {
  network.createAccount(ALICE, "pds1");
  network.createAccount(BOB, "pds2");
  const participants = [ALICE, BOB];
  const convKey = tidNow(network.now());
  const aliceHalf = dmConversationUri(ALICE, convKey);
  const bobHalf = dmConversationUri(BOB, convKey);

  await network.clientFor(ALICE).procedure("com.atproto.space.createSpace", {
    spaceType: SPACE_TYPE.dmConversation,
    skey: convKey,
    policy: memberspacePolicy(),
  });
  await network.clientFor(ALICE).procedure("com.atproto.memberspace.putMembers", {
    space: aliceHalf,
    members: [{ did: BOB, read: true, write: false }],
  });
  await network.writeAs(ALICE, aliceHalf, COLLECTION.dmHeader, "self", {
    convKey,
    participants,
    createdAt: TIMESTAMP,
  });

  await network.clientFor(BOB).procedure("com.atproto.space.createSpace", {
    spaceType: SPACE_TYPE.dmConversation,
    skey: convKey,
    policy: memberspacePolicy(),
  });
  await network.clientFor(BOB).procedure("com.atproto.memberspace.putMembers", {
    space: bobHalf,
    members: [{ did: ALICE, read: true, write: false }],
  });
  await network.writeAs(BOB, bobHalf, COLLECTION.dmHeader, "self", {
    convKey,
    participants,
    createdAt: TIMESTAMP,
  });

  return { convKey, participants, aliceHalf, bobHalf };
}

test("readIndependentDmConversation uses authorizeSpaceSync, verifies RFC 9421 getRecord MACs, rotates KEM keys, and sets tampered halves missing", async () => {
  const network = new FakeNetwork();
  const { convKey, participants, aliceHalf, bobHalf } = await setupDmConversation(network);
  const m1 = tidNow(network.now() + 10);
  await network.writeAs(ALICE, aliceHalf, COLLECTION.dmMessage, m1, { text: "hello bob", createdAt: TIMESTAMP });
  const m2 = tidNow(network.now() + 20);
  await network.writeAs(BOB, bobHalf, COLLECTION.dmMessage, m2, { text: "hello alice", createdAt: TIMESTAMP });

  const requests: Request[] = [];
  const ok = await readIndependentDmConversation(dmDeps(network, ALICE, (req) => requests.push(req)), convKey, participants);
  assert.deepEqual(ok.halves, { [ALICE]: "ok", [BOB]: "ok" });
  assert.deepEqual(ok.messages.map((m) => m.text), ["hello alice", "hello bob"]);

  const authReqs = requests.filter((r) => new URL(r.url).pathname === "/xrpc/com.atproto.space.authorizeSpaceSync");
  assert.equal(authReqs.length, 2);
  const headerReqs = requests.filter((r) => new URL(r.url).pathname === "/xrpc/com.atproto.space.getRecord");
  assert.equal(headerReqs.length, 2);
  for (const req of headerReqs) {
    assert.match(req.headers.get("authorization") ?? "", /^Atproto-Space-Credential /);
    assert.equal(req.headers.get("signature-input"), 'sig=("authorization" "atproto-space-audience");tag="atproto-space-credential"');
    assert.match(req.headers.get("accept-signature") ?? "", /^mac=\("atproto-space-record";sf\);keyid="did:key:zDn[^"]*";tag="atproto-space-record"$/);
  }

  // KEM rotation on Bob refreshes cleanly and succeeds.
  await network.rotateKemKey(BOB);
  const rotated = await readIndependentDmConversation(dmDeps(network, ALICE), convKey, participants);
  assert.deepEqual(rotated.halves, { [ALICE]: "ok", [BOB]: "ok" });
  assert.equal(rotated.messages.length, 2);

  // Wrong-tag RFC 9421 MAC on Bob's getRecord fails verification -> Bob marked missing, Alice still read cleanly.
  network.interceptResponse = ({ method, params, response }) => {
    if (method === "com.atproto.space.getRecord" && params.repo === BOB && response.ok) {
      const headers = new Headers(response.headers);
      headers.set("signature-input", headers.get("signature-input")!.replaceAll(RECORD_MAC_PROFILE, COMMIT_MAC_PROFILE));
      return new Response(response.body, { status: 200, headers });
    }
    return response;
  };
  const badMac = await readIndependentDmConversation(dmDeps(network, ALICE), convKey, participants);
  assert.deepEqual(badMac.halves, { [ALICE]: "ok", [BOB]: "missing" });
  assert.deepEqual(badMac.messages.map((m) => m.text), ["hello bob"]);
});

test("readIndependentDmConversation treats host-level RepoTakendown/RepoDeactivated on authorizeSpaceSync and authority repo reads as missing without failing other half", async () => {
  for (const state of ["takendown", "deactivated"] as const) {
    const network = new FakeNetwork();
    const { convKey, participants, aliceHalf, bobHalf } = await setupDmConversation(network);
    await network.writeAs(ALICE, aliceHalf, COLLECTION.dmMessage, tidNow(network.now() + 10), { text: "from alice", createdAt: TIMESTAMP });
    await network.writeAs(BOB, bobHalf, COLLECTION.dmMessage, tidNow(network.now() + 20), { text: "from bob", createdAt: TIMESTAMP });

    // Host-level suspension on authorizeSpaceSync.
    network.setAccountState(BOB, state);
    const suspendedHost = await readIndependentDmConversation(dmDeps(network, ALICE), convKey, participants);
    assert.deepEqual(suspendedHost.halves, { [ALICE]: "ok", [BOB]: "missing" });
    assert.deepEqual(suspendedHost.messages.map((m) => m.text), ["from alice"]);

    // Transient suspension on repo === authorityDid during getRecord/listRecords (credential already minted).
    network.setAccountState(BOB, "active");
    network.interceptResponse = ({ method, params, response }) => {
      if ((method === "com.atproto.space.getRecord" || method === "com.atproto.space.listRecords") && params.repo === BOB && response.ok) {
        const code = state === "takendown" ? "RepoTakendown" : "RepoDeactivated";
        return new Response(JSON.stringify({ error: code, message: `${code}: ${BOB}` }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return response;
    };
    const suspendedRepo = await readIndependentDmConversation(dmDeps(network, ALICE), convKey, participants);
    assert.deepEqual(suspendedRepo.halves, { [ALICE]: "ok", [BOB]: "missing" });
    assert.deepEqual(suspendedRepo.messages.map((m) => m.text), ["from alice"]);
  }
});

test("readIndependentDmConversation classifies unwritten RepoNotFound, SpaceDeleted, AccountNotAuthorized, and NotAuthorized half errors cleanly", async () => {
  const network = new FakeNetwork();
  network.createAccount(ALICE, "pds1");
  network.createAccount(BOB, "pds2");
  const participants = [ALICE, BOB];
  const convKey = tidNow(network.now());
  const aliceHalf = dmConversationUri(ALICE, convKey);
  const bobHalf = dmConversationUri(BOB, convKey);

  await network.clientFor(ALICE).procedure("com.atproto.space.createSpace", {
    spaceType: SPACE_TYPE.dmConversation,
    skey: convKey,
    policy: memberspacePolicy(),
  });
  await network.clientFor(ALICE).procedure("com.atproto.memberspace.putMembers", {
    space: aliceHalf,
    members: [{ did: BOB, read: true, write: false }],
  });
  await network.writeAs(ALICE, aliceHalf, COLLECTION.dmHeader, "self", { convKey, participants, createdAt: TIMESTAMP });
  await network.writeAs(ALICE, aliceHalf, COLLECTION.dmMessage, tidNow(network.now() + 10), { text: "hi", createdAt: TIMESTAMP });

  // Bob's half space exists with member access, but Bob has never written a record yet -> RepoNotFound -> missing.
  await network.clientFor(BOB).procedure("com.atproto.space.createSpace", {
    spaceType: SPACE_TYPE.dmConversation,
    skey: convKey,
    policy: memberspacePolicy(),
  });
  await network.clientFor(BOB).procedure("com.atproto.memberspace.putMembers", {
    space: bobHalf,
    members: [{ did: ALICE, read: true, write: false }],
  });
  const unwritten = await readIndependentDmConversation(dmDeps(network, ALICE), convKey, participants);
  assert.deepEqual(unwritten.halves, { [ALICE]: "ok", [BOB]: "missing" });

  // AccountNotAuthorized / NotAuthorized -> revoked.
  for (const code of ["AccountNotAuthorized", "NotAuthorized"] as const) {
    network.interceptResponse = ({ method, params, response }) => {
      if (method === "com.atproto.space.authorizeSpaceSync" && params.space === bobHalf) {
        return new Response(JSON.stringify({ error: code, message: `${code} denied` }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return response;
    };
    const revoked = await readIndependentDmConversation(dmDeps(network, ALICE), convKey, participants);
    assert.deepEqual(revoked.halves, { [ALICE]: "ok", [BOB]: "revoked" });
  }
  network.interceptResponse = undefined;

  // Deleted half -> deleted.
  await network.clientFor(BOB).procedure("com.atproto.space.deleteSpace", { space: bobHalf });
  const deleted = await readIndependentDmConversation(dmDeps(network, ALICE), convKey, participants);
  assert.deepEqual(deleted.halves, { [ALICE]: "ok", [BOB]: "deleted" });
});
