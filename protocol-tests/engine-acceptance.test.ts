import assert from "node:assert/strict";
import test from "node:test";
import { actorTransport, bearerSession, startPdsNetwork, type NetworkActor, type PdsNetwork } from "./support/pds-network";

// R4 of `.ai/plans/platform-refactor.md`: the engine's channel page against the independent reader, on two real PDS hosts
// at the pinned checkout, through the sync and writer-set cases that end in a fresh read. DM parity on real hosts is
// `dm-acceptance.test.ts`, whose `DmClient` now reads through the engine.

test("the engine's channel page matches the independent reader on two real PDS hosts", { timeout: 300_000 }, async () => {
  const pds = await startPdsNetwork("engine-acceptance");
  try {
    const [{ createEngine }, { readIndependentChannelPage }, { ensureMemberListSpace, putAuthorityRecord, putSpaceMember }, keys, { COLLECTION, SPACE_TYPE }, { AtprotoClient }] = await Promise.all([
      import("@/client/engine"), import("@/reader/independent"), import("@/atproto/space-ops"), import("@/protocol/keys"), import("@/protocol/nsids"), import("@/atproto/xrpc"),
    ]);
    const authority = await pds.createActor("engowner", 0);
    const alice = await pds.createActor("engalice", 0);
    const bob = await pds.createActor("engbob", 1);
    const carol = await pds.createActor("engcarol", 1);
    const owner = bearerSession(authority) as never;
    const updatedAt = new Date().toISOString();
    const workspace = await ensureMemberListSpace(owner, SPACE_TYPE.workspace, "eng");
    const channel = await ensureMemberListSpace(owner, SPACE_TYPE.channel, "eng-general");
    await putAuthorityRecord(owner, workspace, COLLECTION.workspaceProfile, "self", { name: "Engine", createdAt: updatedAt });
    await putAuthorityRecord(owner, workspace, COLLECTION.directory, "eng-general", { skey: "eng-general", name: "general", visibility: "public" });
    for (const member of [alice, bob, carol]) {
      await putAuthorityRecord(owner, workspace, COLLECTION.workspaceRoster, keys.subjectKey(member.did), { subject: member.did, active: true, updatedAt });
      await putSpaceMember(owner, workspace, member.did, true, true);
      await putSpaceMember(owner, channel, member.did, true, true);
    }

    let offset = 0;
    const transport = actorTransport(pds, alice, { now: () => Date.now() + offset });
    const engine = createEngine(transport);
    const ref = { workspace, skey: "eng-general" };
    const write = (actor: NetworkActor, collection: string, rkey: string, record: Record<string, unknown>) =>
      new AtprotoClient(bearerSession(actor).fetchHandler).procedure("com.atproto.space.putRecord", { space: channel, repo: actor.did, collection, rkey, record: { $type: collection, ...record } });
    const compare = async (label: string) => {
      await settled(pds, alice, channel, [alice, bob, carol]);
      const fresh = await readIndependentChannelPage(actorTransport(pds, alice), workspace, ref.skey);
      const page = await engine.channels.readPage(ref);
      assert.deepEqual(page.messages.map((message) => [message.uri, message.value.text]), fresh.messages.map((message) => [message.uri, message.value.text]), `${label}: messages`);
      assert.deepEqual(page.reactions.map((reaction) => reaction.uri), fresh.reactions.map((reaction) => reaction.uri), `${label}: reactions`);
      assert.equal(page.degradedReasons.length > 0, fresh.degraded, `${label}: degraded`);
      return page;
    };

    const messages: Array<{ writer: NetworkActor; rkey: string; uri: string }> = [];
    for (let n = 0; n < 12; n += 1) {
      const writer = [alice, bob, carol][n % 3]!;
      const rkey = keys.tidNow();
      await write(writer, COLLECTION.message, rkey, { text: `message ${n}`, createdAt: new Date().toISOString() });
      messages.push({ writer, rkey, uri: keys.spaceRecordUri(channel, writer.did, COLLECTION.message, rkey) });
    }
    const first = await compare("first sync");
    assert.equal(first.messages.length, 12);

    const [bobTop, , , aliceEdited, bobDeleted] = [messages[1]!, messages[2]!, messages[0]!, messages[3]!, messages[4]!];
    await write(carol, COLLECTION.message, keys.tidNow(), { text: "reply", createdAt: new Date().toISOString(), parent: bobTop.uri });
    await write(bob, COLLECTION.reaction, keys.reactionRecordKey(messages[0]!.uri, "👍", bob.did), { subject: messages[0]!.uri, emoji: "👍", createdAt: new Date().toISOString() });
    await write(aliceEdited.writer, COLLECTION.message, aliceEdited.rkey, { text: "edited", createdAt: new Date().toISOString() });
    await new AtprotoClient(bearerSession(bobDeleted.writer).fetchHandler).procedure("com.atproto.space.deleteRecord", {
      space: channel, repo: bobDeleted.writer.did, collection: COLLECTION.message, rkey: bobDeleted.rkey,
    });
    await compare("a reply, a reaction, an edit and a delete, read through hints");

    await putSpaceMember(owner, channel, carol.did, true, false);
    offset += engine.sync.options.truthIntervalMs;
    const reduced = await compare("a member reduced to read-only, after the truth interval");
    assert.equal(reduced.messages.some((message) => message.repo === carol.did), false, "an account no longer listed takes its records out of view (D14)");
  } finally {
    await pds.close();
  }
});

/** Waits until the authority lists every writer at the revision its own host reports, so a comparison does not race a write notice. */
async function settled(pds: PdsNetwork, reader: NetworkActor, space: string, writers: readonly NetworkActor[]): Promise<void> {
  const [{ mintSpaceCredentialWith }] = await Promise.all([import("@/atproto/space-credential-core")]);
  const transport = actorTransport(pds, reader);
  const credential = await mintSpaceCredentialWith(transport, space);
  const authorityDid = space.slice("at://".length).split("/")[0]!;
  const authority = credential.client(await transport.resolvePds(authorityDid));
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const listed = await authority.query<{ repos: Array<{ did: string; repoRev: string }> }>("com.atproto.space.listRepos", { space, limit: 1000 });
    let current = true;
    for (const writer of writers) {
      const host = credential.client(await transport.resolvePds(writer.did));
      const rev = await host.query<{ commit: { rev: string } }>("com.atproto.space.getLatestCommit", { space, repo: writer.did }).then((commit) => commit.commit.rev, () => null);
      const reported = listed.repos.find((repo) => repo.did === writer.did)?.repoRev ?? null;
      if (rev !== null && reported !== null && reported < rev) current = false;
    }
    if (current) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("The authority never reported every writer's current revision.");
}
