import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { JoseKey } from "@atproto/jwk-jose";
import { AtprotoClient } from "@/atproto/xrpc";
import { DmClient, type DmConversationPage, type DmDeps, type DmStore } from "@/dm/dm-client";
import { readIndependentDmConversation } from "@/reader/independent-dm";
import { createFixtureTempRoot } from "./fixture-temp";

// Backend acceptance for M4 (.ai/plans/dm-tasks/m4.md) against the pinned PDS
// checkout, using two real hosts. Every flow here runs "server off": this
// process never starts the Next server and never imports `@/lib/db` (the DM
// engine's isomorphic boundary forbids it), so `DATABASE_PATH` is set to a
// path under a directory that is asserted, at the end, to never have been
// created.
//
// M6 (.ai/plans/dm-tasks/m6.md) parity: after the 1:1 and group flows below,
// `assertDmParity` re-reads the same conversation through the independent
// reader (`src/reader/independent-dm.ts`, which imports nothing from
// `src/dm/`) using the same acting identity as the `DmClient` read it is
// compared against, and asserts identical message URIs/texts, reactions, and
// per-half statuses.

type TestAgent = {
  com: { atproto: { server: {
    createAccount(input: Record<string, unknown>): Promise<{ data: { did: string; accessJwt: string } }>;
  } } };
};
type DidResolver = { resolve(did: string, ...args: unknown[]): Promise<unknown> };
type TestPds = { url: string; getAgent(): TestAgent; ctx: { idResolver: { did: DidResolver } } };
type TestNetwork = { pds: TestPds; extraPdses: TestPds[]; close(): Promise<void> };
type Actor = { did: string; accessJwt: string; pds: TestPds };

const PINNED_CHECKOUT = process.env.ATPROTO_PINNED_CHECKOUT;

test("DM acceptance: 1:1, group, dropped-notification recovery, all with the server off", async () => {
  assert.ok(PINNED_CHECKOUT, "set ATPROTO_PINNED_CHECKOUT to the pinned atproto checkout");
  const { TestNetworkNoAppView } = await import(pathToFileURL(join(PINNED_CHECKOUT, "packages/dev-env/src/index.ts")).href) as {
    TestNetworkNoAppView: { create(options: { extraPdses: number }): Promise<TestNetwork> };
  };
  const fixtureTemp = createFixtureTempRoot("dm-acceptance-fixture-");
  const missingDatabaseDir = join(fixtureTemp.path, "does-not-exist");
  process.env.DATABASE_PATH = join(missingDatabaseDir, "app.db");

  let network: TestNetwork | undefined;
  try {
    network = await TestNetworkNoAppView.create({ extraPdses: 1 });
    const pdsByDid = new Map<string, string>();

    const createActor = async (pds: TestPds, name: string, domain: string): Promise<Actor> => {
      const { data } = await pds.getAgent().com.atproto.server.createAccount({
        handle: `${name}.${domain}`, email: `${name}@dm-acceptance.test`, password: `${name}-dm-acceptance-pass`,
      });
      pdsByDid.set(data.did, pds.url);
      return { did: data.did, accessJwt: data.accessJwt, pds };
    };

    const memberClientFor = (actor: Actor): AtprotoClient => new AtprotoClient(async (path, init) => {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${actor.accessJwt}`);
      return fetch(new URL(path, actor.pds.url), { ...init, headers, redirect: "error" });
    });

    const createStore = (): DmStore => {
      const map = new Map<string, string>();
      return {
        async get(key) { return map.has(key) ? map.get(key)! : null; },
        async set(key, value) { map.set(key, value); },
        async delete(key) { map.delete(key); },
      };
    };

    const depsFor = (actor: Actor, now?: () => number): DmDeps => ({
      did: actor.did,
      memberClient: memberClientFor(actor),
      resolvePds: async (did) => {
        const url = pdsByDid.get(did);
        if (!url) throw new Error(`dm-acceptance: no known PDS for ${did}`);
        return url;
      },
      fetchEndpoint: (request) => fetch(request),
      generateKey: () => JoseKey.generate(["ES256"]),
      store: createStore(),
      ...(now ? { now } : {}),
    });

    const dmFor = (actor: Actor, now?: () => number): DmClient => new DmClient(depsFor(actor, now));

    const byUri = <T extends { uri: string }>(records: readonly T[]): Record<string, T> => Object.fromEntries(records.map((record) => [record.uri, record]));
    const assertDmParity = async (actor: Actor, page: DmConversationPage, convKey: string, participants: readonly string[]): Promise<void> => {
      const independent = await readIndependentDmConversation(depsFor(actor), convKey, participants);
      assert.deepEqual(byUri(page.messages), byUri(independent.messages), "independent reader must render identical DM messages");
      assert.deepEqual(byUri(page.reactions), byUri(independent.reactions), "independent reader must render identical DM reactions");
      assert.deepEqual(page.halves, independent.halves, "independent reader must classify half status identically");
    };

    // --- 1:1 ---
    const alice = await createActor(network.pds, "alice", "test");
    const bob = await createActor(network.extraPdses[0], "bob", "test2");
    const aliceDm = dmFor(alice);
    const bobDm = dmFor(bob);

    await bobDm.enableDms("everyone");
    const started = await aliceDm.startConversation([bob.did]);
    assert.equal(started.delivery[bob.did]?.status, "delivered");

    const beforeAccept = await aliceDm.readConversation(started.convKey, started.participants);
    assert.equal(beforeAccept.halves[bob.did], "missing", "bob has not replied yet");
    await assertDmParity(alice, beforeAccept, started.convKey, started.participants);

    assert.equal((await bobDm.listRequests()).length, 1, "bob sees alice's request under \"everyone\"");

    await bobDm.setRequestMode("nobody");
    assert.deepEqual(await bobDm.listRequests(), [], "\"nobody\" hides the already-tracked writer");

    // allow() while still in nobody mode records alice as a dormant member
    // (an empty memberList inbox is indistinguishable from nobody);
    // setRequestMode("allowlist") is the explicit step that reactivates her.
    await bobDm.allow([alice.did]);
    assert.deepEqual(await bobDm.listRequests(), [], "allowing while still in nobody mode keeps the entry dormant (M0 §6f)");

    await bobDm.setRequestMode("allowlist");
    const visible = await bobDm.listRequests();
    assert.equal(visible.length, 1);
    assert.equal(visible[0]!.convKey, started.convKey);

    await bobDm.accept(visible[0]!);
    const aliceMessage = await aliceDm.send(started.convKey, "hi bob");
    const bobMessage = await bobDm.send(started.convKey, "hi alice");
    await aliceDm.edit(aliceMessage.uri, "hi bob!!");
    await bobDm.react(aliceMessage.uri, "👍");

    const merged = await aliceDm.readConversation(started.convKey, started.participants);
    assert.equal(merged.messages.length, 2, "the merge combines both halves");
    assert.equal(merged.messages.find((message) => message.uri === aliceMessage.uri)?.text, "hi bob!!", "the edit is reflected");
    assert.deepEqual(merged.reactions.map((reaction) => ({ subject: reaction.subject, emoji: reaction.emoji })), [{ subject: aliceMessage.uri, emoji: "👍" }]);
    assert.equal(merged.halves[alice.did], "ok");
    assert.equal(merged.halves[bob.did], "ok");
    await assertDmParity(alice, merged, started.convKey, started.participants);

    await bobDm.unreact(aliceMessage.uri, "👍");
    await bobDm.delete(bobMessage.uri);
    const afterEdits = await aliceDm.readConversation(started.convKey, started.participants);
    assert.deepEqual(afterEdits.reactions, []);
    assert.equal(afterEdits.messages.length, 1, "the deleted message is gone");
    await assertDmParity(alice, afterEdits, started.convKey, started.participants);

    await bobDm.leave(started.convKey);
    // A credential minted before this point (by the `merged`/`afterEdits`
    // reads above) legitimately stays valid until its own expiry (M0 §6d):
    // revocation blocks new mints, it doesn't recall ones already issued. A
    // fresh client (no cached credential) observes the revocation immediately.
    const afterLeave = await dmFor(alice).readConversation(started.convKey, started.participants);
    assert.equal(afterLeave.halves[bob.did], "revoked", "leaving removes alice from bob's own half");
    await assertDmParity(alice, afterLeave, started.convKey, started.participants);

    await aliceDm.deleteEverything(started.convKey);
    const afterDelete = await dmFor(bob).readConversation(started.convKey, started.participants);
    assert.equal(afterDelete.halves[alice.did], "deleted");
    await assertDmParity(bob, afterDelete, started.convKey, started.participants);

    // --- 3-person group ---
    const carol = await createActor(network.pds, "carol", "test");
    const dave = await createActor(network.extraPdses[0], "dave", "test2");
    const erin = await createActor(network.pds, "erin", "test");
    const daveDm = dmFor(dave);
    const erinDm = dmFor(erin);
    await daveDm.enableDms("everyone");
    await erinDm.enableDms("everyone");
    const carolDm = dmFor(carol);

    const group = await carolDm.startConversation([dave.did, erin.did]);
    assert.equal(group.participants.length, 3);
    await daveDm.accept((await daveDm.listRequests()).find((request) => request.convKey === group.convKey)!);
    await erinDm.accept((await erinDm.listRequests()).find((request) => request.convKey === group.convKey)!);

    await carolDm.send(group.convKey, "from carol");
    await daveDm.send(group.convKey, "from dave");
    await erinDm.send(group.convKey, "from erin");

    const groupPage = await carolDm.readConversation(group.convKey, group.participants);
    assert.equal(groupPage.messages.length, 3);
    assert.deepEqual(new Set(groupPage.messages.map((message) => message.text)), new Set(["from carol", "from dave", "from erin"]));
    assert.deepEqual(groupPage.halves, { [carol.did]: "ok", [dave.did]: "ok", [erin.did]: "ok" });
    await assertDmParity(carol, groupPage, group.convKey, group.participants);

    // --- Dormant allowlist members (nobody mode): real putMember(read:false,write:false) ---
    const heidi = await createActor(network.pds, "heidi", "test");
    const ivan = await createActor(network.extraPdses[0], "ivan", "test2");
    const heidiDm = dmFor(heidi);
    const ivanDm = dmFor(ivan);

    await heidiDm.enableDms("allowlist", [ivan.did]);
    assert.deepEqual((await heidiDm.getInbox()).allowlist, [ivan.did]);

    await heidiDm.setRequestMode("nobody");
    assert.deepEqual((await heidiDm.getInbox()).allowlist, [ivan.did],
      "the real PDS accepts putMember(read:false,write:false) and still lists ivan as dormant, not removed");

    const dormantAttempt = await ivanDm.startConversation([heidi.did]);
    assert.equal(dormantAttempt.delivery[heidi.did]?.status, "delivered", "the write itself succeeds even while dormant (M0 §6g)");
    assert.deepEqual(await heidiDm.listRequests(), [], "a dormant member's new request is not tracked in listRepos");

    await heidiDm.setRequestMode("allowlist");
    assert.deepEqual(await heidiDm.listRequests(), [], "reactivating alone does not retroactively track the earlier untracked write");

    let dormantVirtualNow = Date.now();
    const ivanWithClock = dmFor(ivan, () => dormantVirtualNow);
    dormantVirtualNow += 61_000;
    await ivanWithClock.renotifyPending();
    const nowTracked = await heidiDm.listRequests();
    assert.equal(nowTracked.length, 1, "ivan's next write, made while active again, is now tracked in listRepos");
    assert.equal(nowTracked[0]!.convKey, dormantAttempt.convKey);

    // --- Dropped notification, recovered by renotifyPending ---
    const frank = await createActor(network.pds, "frank", "test");
    const grace = await createActor(network.extraPdses[0], "grace", "test2");
    const graceDm = dmFor(grace);
    await graceDm.enableDms("everyone");

    const frankResolver = frank.pds.ctx.idResolver.did;
    const resolveFrank = frankResolver.resolve.bind(frankResolver);
    let dropped: Awaited<ReturnType<DmClient["startConversation"]>>;
    frankResolver.resolve = async (did: string, ...args: unknown[]) => (did === grace.did ? null : resolveFrank(did, ...(args as never[])));
    try {
      dropped = await dmFor(frank).startConversation([grace.did]);
    } finally {
      frankResolver.resolve = resolveFrank;
    }
    assert.equal(dropped.delivery[grace.did]?.status, "delivered", "the write itself succeeds even though the notification is dropped");
    assert.deepEqual(await graceDm.listRequests(), [], "the dropped notification leaves grace's PDS without a tracked writer");

    let virtualNow = Date.now();
    const frankWithClock = dmFor(frank, () => virtualNow);
    await frankWithClock.renotifyPending();
    virtualNow += 59_000;
    await frankWithClock.renotifyPending();
    assert.deepEqual(await graceDm.listRequests(), [], "not due for a retry yet");
    virtualNow += 2_000;
    await frankWithClock.renotifyPending();
    const recovered = await graceDm.listRequests();
    assert.equal(recovered.length, 1, "the re-put after the 1-minute backoff is now tracked");
    assert.equal(recovered[0]!.convKey, dropped.convKey);

    // Every flow above ran with no Next server and `DATABASE_PATH` pointing at
    // a directory this process never created; assert that's still true before
    // the fixture cleanup below removes it regardless.
    assert.equal(existsSync(missingDatabaseDir), false, "the DM engine never touched the server database directory");
  } finally {
    try {
      await network?.close();
    } finally {
      fixtureTemp.cleanup();
    }
  }
});
