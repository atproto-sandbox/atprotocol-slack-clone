import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { Given, Then, When } from "@cucumber/cucumber";
import { DM_RENOTIFY_BACKOFF_MS } from "@/dm/backoff";
import { readIndependentDmConversation } from "@/reader/independent-dm";
import { dmConversationUri, dmInboxUri, recordKeyHash, stableHash, tidNow } from "@/protocol/keys";
import { validateDmHeaderMatchesRequest, validateSpaceRecord } from "@/protocol/records";
import type { SecondApp } from "../../protocol-tests/support/app-fixture";
import { completeConsent, signIn, submitWorkspaceName, uniqueWorkspaceName } from "../support/ui";
import type { Actor, AppWorld } from "../support/world";
import {
  DmpProbe, type DmpHostileHalf, type DmpMintedCredential, dmpAcceptRequestFrom, dmpAllowlistDids, dmpAllowDid, dmpChooseMode, dmpConnectDms, dmpEnableDms, dmpMessageTexts, dmpOpenConversationWith,
  dmpOwnConvKeys, dmpOwnHeader, dmpOwnMessages, dmpParticipantRows, dmpPoll, dmpReadRequests, dmpReadRequestsScanned, dmpReload, dmpRequestCount, dmpSend, dmpSidebarConversationLabels,
  dmpAppDataRowCount, dmpConnectDmsReadingScope, dmpEverythingTheAppStored, dmpFilesContain, dmpServerSessions, dmpWaitForOrigin, dmpJwtClaims, dmpLatestCommitRev, dmpOpenRequests, dmpOpenSettings, dmpRequestSenders, dmpSignInAt, dmpWatchCredentials, dmpRenotifyState, dmpReloadThroughCycle, dmpRequestOps, dmpSetRenotifyElapsed, dmpStartConversation, dmpSync, dmpWriteHostileHalf,
} from "../support/dm-policy-ui";

const SETUP_TIMEOUT = 300_000;
const PUBLIC_POLICY = "com.atproto.simplespace.defs#publicPolicy";
const MEMBER_LIST_POLICY = "com.atproto.simplespace.defs#memberListPolicy";

const actorNamed = (world: AppWorld, role: string): Actor => {
  const actor = world.actors.get(role);
  assert.ok(actor, `this scenario has no ${role} yet`);
  return actor;
};

const probeFor = (world: AppWorld, actor: Actor): DmpProbe => new DmpProbe(world, actor);

/** A person signs in to the app and connects direct messages: two separate sign-ins, two consent screens. */
async function joinDms(world: AppWorld, role: string, host: 0 | 1): Promise<Actor> {
  const actor = await world.actor(role, host);
  await signIn(world, actor);
  await dmpConnectDms(actor);
  return actor;
}

async function inboxPolicy(world: AppWorld, owner: Actor): Promise<{ writePolicy: string; members: Array<{ did: string; read: boolean; write: boolean }> }> {
  const space = dmInboxUri(owner.did);
  const policy = await world.pdsGet<{ writePolicy: { $type: string } }>(owner, "com.atproto.simplespace.getSpace", { space });
  assert.equal(policy.status, 200, JSON.stringify(policy.body));
  const members = await world.pdsGet<{ members?: Array<{ did: string; read: boolean; write: boolean }> }>(owner, "com.atproto.simplespace.listMembers", { space, limit: "1000" });
  assert.equal(members.status, 200, JSON.stringify(members.body));
  return { writePolicy: policy.body.writePolicy.$type, members: members.body.members ?? [] };
}

async function trackedDids(world: AppWorld, owner: Actor): Promise<string[]> {
  return (await probeFor(world, owner).trackedWriters(owner)).map((writer) => writer.did).sort();
}

async function writeRequestTo(world: AppWorld, writer: Actor, recipient: Actor): Promise<void> {
  const outcomes = await dmpStartConversation(writer, [recipient.did]);
  assert.equal(outcomes[recipient.did], "delivered", `${writer.role}'s request to ${recipient.role}: ${JSON.stringify(outcomes)}`);
}

// --- Allow everyone ---------------------------------------------------------------------------------

Given("a user sets their inbox policy to everyone", { timeout: SETUP_TIMEOUT }, async function (this: AppWorld) {
  const user = await joinDms(this, "user", 0);
  await dmpEnableDms(user);
  await dmpChooseMode(user, "Everyone");
  assert.equal((await inboxPolicy(this, user)).writePolicy, PUBLIC_POLICY, "the setting is stored on the user's own PDS");
});

When("a stranger writes a request", { timeout: SETUP_TIMEOUT }, async function (this: AppWorld) {
  const stranger = await joinDms(this, "stranger", 1);
  await writeRequestTo(this, stranger, actorNamed(this, "user"));
});

Then("the user's PDS tracks that writer", async function (this: AppWorld) {
  const user = actorNamed(this, "user");
  const stranger = actorNamed(this, "stranger");
  assert.ok((await trackedDids(this, user)).includes(stranger.did), "the user's PDS lists the stranger among the inbox's writers");
});

Then("the local display filter sorts the request into the requests folder", async function (this: AppWorld) {
  const user = actorNamed(this, "user");
  const stranger = actorNamed(this, "stranger");
  const rows = await dmpReadRequests(user);
  assert.deepEqual(rows.map(({ section, sender }) => ({ section, sender })), [{ section: "others", sender: stranger.did }]);
  assert.equal(await dmpRequestCount(user), 1);
  assert.deepEqual(await dmpSidebarConversationLabels(user), [], "the request is not a conversation until it is accepted");
});

// --- Allow only people I allow ----------------------------------------------------------------------

Given("a user sets their inbox policy to an allowlist of writers", { timeout: SETUP_TIMEOUT }, async function (this: AppWorld) {
  const user = await joinDms(this, "user", 0);
  const friend = await this.actor("friend", 1);
  await dmpEnableDms(user);
  await dmpAllowDid(user, friend.did);
  const inbox = await inboxPolicy(this, user);
  assert.equal(inbox.writePolicy, MEMBER_LIST_POLICY);
  assert.deepEqual(inbox.members.map(({ did, write }) => ({ did, write })), [{ did: friend.did, write: true }], "the allowlist holds exactly the allowed writer");
});

Then("the user's PDS never tracks that writer", async function (this: AppWorld) {
  const user = actorNamed(this, "user");
  const stranger = actorNamed(this, "stranger");
  assert.equal((await trackedDids(this, user)).includes(stranger.did), false, "the stranger's write was not accepted into the inbox's writer set");
  assert.equal((await dmpRequestOps(this, stranger, user)).length, 1, "yet the stranger's request really is on the stranger's own PDS, so what is missing below was refused, not never written");
  const { rows, scannedWriters } = await dmpReadRequestsScanned(user);
  assert.deepEqual(scannedWriters, [], "the user's own scan ran and the PDS handed it no writer");
  assert.deepEqual(rows.map((row) => row.sender), [], "the stranger's request is not shown either");
});

Then("an allowed writer's request is tracked and read", { timeout: SETUP_TIMEOUT }, async function (this: AppWorld) {
  const user = actorNamed(this, "user");
  const stranger = actorNamed(this, "stranger");
  const friend = await joinDms(this, "friend", 1);
  await writeRequestTo(this, friend, user);
  const tracked = await trackedDids(this, user);
  assert.ok(tracked.includes(friend.did), "the allowed writer is tracked");
  assert.equal(tracked.includes(stranger.did), false, "the stranger still is not");
  const { rows, scannedWriters } = await dmpReadRequestsScanned(user);
  assert.deepEqual(scannedWriters, [friend.did], "the user's own scan was handed the allowed writer and nobody else");
  assert.deepEqual(rows.map((row) => row.sender), [friend.did], "only the allowed writer's request is read and shown");
});

// --- Allow nobody -----------------------------------------------------------------------------------

Given("a user sets their inbox policy to nobody", { timeout: SETUP_TIMEOUT }, async function (this: AppWorld) {
  const user = await joinDms(this, "user", 0);
  const friend = await this.actor("friend", 1);
  await dmpEnableDms(user);
  await dmpAllowDid(user, friend.did);

  await joinDms(this, "friend", 1);
  await writeRequestTo(this, friend, user);
  await friend.page.getByRole("button", { name: "Open conversation →" }).click();
  await dmpSend(friend, "friend says hello before the policy changes");

  await dmpPoll(async () => (await dmpReadRequests(user)).some((row) => row.sender === friend.did), { what: "the friend's request in the user's folder" });
  await dmpAcceptRequestFrom(user, friend.did);
  await dmpSend(user, "user replies before the policy changes");

  await dmpChooseMode(user, "Nobody");
  const inbox = await inboxPolicy(this, user);
  assert.equal(inbox.writePolicy, MEMBER_LIST_POLICY);
  assert.deepEqual(inbox.members.map(({ did, write }) => ({ did, write })), [{ did: friend.did, write: false }], "nobody keeps the allowlist but switches every entry off");
  this.scratch.set("trackedBefore", await probeFor(this, user).trackedWriters(user));
});

When("anyone writes a request", { timeout: SETUP_TIMEOUT }, async function (this: AppWorld) {
  const user = actorNamed(this, "user");
  const friend = actorNamed(this, "friend");
  const bystander = await this.actor("bystander", 0);
  const stranger = await joinDms(this, "stranger", 1);
  await writeRequestTo(this, stranger, user);
  const outcomes = await dmpStartConversation(friend, [user.did, bystander.did]);
  assert.equal(outcomes[user.did], "delivered", JSON.stringify(outcomes));
});

Then("no new writer is tracked", async function (this: AppWorld) {
  const user = actorNamed(this, "user");
  const friend = actorNamed(this, "friend");
  const before = this.scratch.get("trackedBefore") as Array<{ did: string; rev: string }>;
  const after = await probeFor(this, user).trackedWriters(user);
  assert.deepEqual(after, before, "the set of tracked writers, and each writer's last recorded revision, is unchanged");
  assert.equal(after.some((writer) => writer.did === actorNamed(this, "stranger").did), false);
  const requestsFromFriend = new Set((await dmpRequestOps(this, friend, user)).map((op) => op.rkey));
  assert.equal(requestsFromFriend.size, 2, "the friend, who is still tracked, has a second, unanswered request on the friend's PDS besides the accepted one");
  const { rows, scannedWriters } = await dmpReadRequestsScanned(user);
  assert.deepEqual(scannedWriters, [friend.did], "the user's own scan was handed the friend as a candidate writer");
  assert.equal((await dmpSidebarConversationLabels(user)).length, 1, "and the same scan result listed the accepted conversation, so the folder was read after the scan, not before it");
  assert.deepEqual(rows.map((row) => row.sender), [], "no request is shown either");
});

Then("existing conversations keep working without the inbox", { timeout: SETUP_TIMEOUT }, async function (this: AppWorld) {
  const user = actorNamed(this, "user");
  const friend = actorNamed(this, "friend");
  assert.deepEqual((await inboxPolicy(this, user)).members.filter((member) => member.write), [], "the inbox is still closed to every writer");
  await dmpOpenConversationWith(user, [friend]);
  await dmpSend(user, "user writes with the inbox closed");
  await dmpReloadAndOpen(friend, user);
  await dmpSend(friend, "friend writes with the inbox closed");
  await dmpSync(user);
  await user.page.getByText("friend writes with the inbox closed", { exact: true }).waitFor({ state: "visible" });
  await dmpSync(friend);
  await friend.page.getByText("user writes with the inbox closed", { exact: true }).waitFor({ state: "visible" });
  assert.deepEqual((await dmpMessageTexts(user)).sort(), [
    "friend says hello before the policy changes", "friend writes with the inbox closed",
    "user replies before the policy changes", "user writes with the inbox closed",
  ].sort());
});

async function dmpReloadAndOpen(actor: Actor, other: Actor): Promise<void> {
  await dmpReload(actor);
  await dmpOpenConversationWith(actor, [other]);
}

// --- Switch the policy ------------------------------------------------------------------------------

type PolicyObservation = { pdsWriters: string[]; scannedWriters: string[]; shownSenders: string[] };

async function observePolicy(world: AppWorld, owner: Actor): Promise<PolicyObservation> {
  const pdsWriters = await trackedDids(world, owner);
  const { rows, scannedWriters } = await dmpReadRequestsScanned(owner);
  return { pdsWriters, scannedWriters, shownSenders: rows.map((row) => row.sender).sort() };
}

Given("writers were tracked while the inbox policy allowed everyone", { timeout: SETUP_TIMEOUT }, async function (this: AppWorld) {
  const user = await joinDms(this, "user", 0);
  await dmpEnableDms(user);
  await dmpChooseMode(user, "Everyone");
  const kept = await joinDms(this, "kept", 1);
  const dropped = await joinDms(this, "dropped", 0);
  await writeRequestTo(this, kept, user);
  await writeRequestTo(this, dropped, user);
  const observed = await observePolicy(this, user);
  assert.deepEqual(observed.pdsWriters, [kept.did, dropped.did].sort(), "both writers are tracked under everyone");
  assert.deepEqual(observed.shownSenders, [kept.did, dropped.did].sort(), "and both requests are shown");
});

When("the user switches to an allowlist or to nobody", { timeout: SETUP_TIMEOUT }, async function (this: AppWorld) {
  const user = actorNamed(this, "user");
  await dmpAllowDid(user, actorNamed(this, "kept").did);
  await dmpChooseMode(user, "Only people I allow");
  this.scratch.set("afterAllowlist", await observePolicy(this, user));
  await dmpChooseMode(user, "Nobody");
  this.scratch.set("afterNobody", await observePolicy(this, user));
});

Then("those writers stay listed by the PDS", function (this: AppWorld) {
  const both = [actorNamed(this, "kept").did, actorNamed(this, "dropped").did].sort();
  assert.deepEqual((this.scratch.get("afterAllowlist") as PolicyObservation).pdsWriters, both);
  assert.deepEqual((this.scratch.get("afterNobody") as PolicyObservation).pdsWriters, both);
});

Then("the client drops requests from writers outside the current policy", async function (this: AppWorld) {
  const kept = actorNamed(this, "kept");
  const dropped = actorNamed(this, "dropped");
  const user = actorNamed(this, "user");
  const both = [kept.did, dropped.did].sort();
  for (const writer of [kept, dropped]) assert.equal((await dmpRequestOps(this, writer, user)).length, 1, `${writer.role}'s request is still on its own PDS, so the client had something to drop`);
  const afterAllowlist = this.scratch.get("afterAllowlist") as PolicyObservation;
  const afterNobody = this.scratch.get("afterNobody") as PolicyObservation;
  assert.deepEqual(afterAllowlist.scannedWriters, both, "the client's own scan was handed both writers under the allowlist");
  assert.deepEqual(afterNobody.scannedWriters, both, "and under nobody");
  assert.deepEqual(afterAllowlist.shownSenders, [kept.did], "under the allowlist only the allowed writer's request is shown");
  assert.deepEqual(afterNobody.shownSenders, [], "under nobody no request is shown");
});

// --- Reads merge validated halves -------------------------------------------------------------------

const MISSING_HALF_CHIP = "hasn't replied";

async function waitForRequestFrom(recipient: Actor, sender: Actor): Promise<void> {
  await dmpPoll(async () => (await dmpReadRequests(recipient)).some((row) => row.sender === sender.did), { what: `${sender.role}'s request in ${recipient.role}'s folder`, timeoutMs: 60_000 });
}

async function openStartedConversation(initiator: Actor): Promise<void> {
  await initiator.page.getByRole("button", { name: "Open conversation →" }).click();
  await initiator.page.getByText("Participants", { exact: true }).waitFor({ state: "visible" });
}

async function acceptAndOpen(recipient: Actor, sender: Actor): Promise<void> {
  await waitForRequestFrom(recipient, sender);
  await dmpAcceptRequestFrom(recipient, sender.did);
}

async function singleConvKey(world: AppWorld, owner: Actor): Promise<string> {
  const keys = await dmpOwnConvKeys(world, owner);
  assert.equal(keys.length, 1, `${owner.role} owns exactly one conversation half`);
  return keys[0]!;
}

Given("a conversation has halves for its participants", { timeout: 420_000 }, async function (this: AppWorld) {
  const alice = await joinDms(this, "alice", 0);
  const bob = await joinDms(this, "bob", 1);
  const carol = await joinDms(this, "carol", 0);
  const dave = await this.actor("dave", 1);
  for (const invited of [bob, carol]) {
    await dmpEnableDms(invited);
    await dmpChooseMode(invited, "Everyone");
  }
  const outcomes = await dmpStartConversation(alice, [bob.did, carol.did, dave.did]);
  assert.equal(outcomes[bob.did], "delivered");
  assert.equal(outcomes[carol.did], "delivered");
  await openStartedConversation(alice);
  await acceptAndOpen(bob, alice);
  await acceptAndOpen(carol, alice);

  const sends: Array<[Actor, string]> = [[alice, "alice one"], [bob, "bob one"], [carol, "carol one"], [alice, "alice two"], [bob, "bob two"], [carol, "carol two"]];
  for (const [author, text] of sends) await dmpSend(author, text);
  this.scratch.set("convKey", await singleConvKey(this, alice));
});

When("a participant opens the conversation", async function (this: AppWorld) {
  const bob = actorNamed(this, "bob");
  await dmpReload(bob);
  await dmpOpenConversationWith(bob, [actorNamed(this, "alice")]);
  await dmpPoll(async () => (await dmpMessageTexts(bob)).length >= 6, { what: "all six messages in bob's timeline" });
});

Then("every half's messages appear in one timeline ordered by key", async function (this: AppWorld) {
  const convKey = this.scratch.get("convKey") as string;
  const authors = ["alice", "bob", "carol"].map((role) => actorNamed(this, role));
  const stored = (await Promise.all(authors.map(async (author) => (await dmpOwnMessages(this, author, convKey)).map((message) => ({ ...message, author: author.role })))))
    .flat().sort((left, right) => right.rkey.localeCompare(left.rkey));
  assert.equal(stored.length, 6, "each half holds its own two messages on its own PDS");
  assert.notDeepEqual(stored.map((message) => message.author), stored.map((message) => message.author).sort(), "the keys interleave the halves, so a per-half concatenation would be out of order");
  assert.deepEqual(await dmpMessageTexts(actorNamed(this, "bob")), stored.map((message) => message.text), "the timeline is the union of every half, newest key first");
});

Then("a missing half means that participant has not replied", async function (this: AppWorld) {
  const convKey = this.scratch.get("convKey") as string;
  const [alice, bob, carol, dave] = ["alice", "bob", "carol", "dave"].map((role) => actorNamed(this, role)) as [Actor, Actor, Actor, Actor];
  const rows = await dmpParticipantRows(bob);
  assert.deepEqual(rows.map(({ did, chip }) => ({ did, chip })).sort((left, right) => left.did.localeCompare(right.did)), [
    { did: alice.did, chip: null }, { did: bob.did, chip: null }, { did: carol.did, chip: null }, { did: dave.did, chip: MISSING_HALF_CHIP },
  ].sort((left, right) => left.did.localeCompare(right.did)));
  assert.deepEqual(await dmpOwnConvKeys(this, dave), [], "dave's own PDS holds no half");
  assert.equal(await probeFor(this, bob).credentialOutcome(dmConversationUri(dave.did, convKey)), "SpaceNotFound");
});

Given("another member stored a record scoped to someone else's half in their own repo", { timeout: SETUP_TIMEOUT }, async function (this: AppWorld) {
  const alice = await joinDms(this, "alice", 0);
  const bob = await joinDms(this, "bob", 1);
  await dmpEnableDms(bob);
  await dmpChooseMode(bob, "Everyone");
  await dmpStartConversation(alice, [bob.did]);
  await openStartedConversation(alice);
  await dmpSend(alice, "legit from alice");
  await acceptAndOpen(bob, alice);
  await dmpSend(bob, "legit from bob");

  const convKey = await singleConvKey(this, alice);
  const aliceHalf = dmConversationUri(alice.did, convKey);
  const hostile = "HOSTILE record in bob's repo, scoped to alice's half";
  const spoofed = await this.pdsPost(bob, "com.atproto.space.putRecord", {
    space: aliceHalf, repo: alice.did, collection: "org.slack.dm.message", rkey: tidNow(),
    record: { $type: "org.slack.dm.message", text: "spoofed as alice", createdAt: new Date().toISOString() },
  });
  assert.equal(spoofed.status, 403, "the PDS itself refuses a write into someone else's repo, so the only reachable hostile write is in the writer's own repo");
  const planted = await this.pdsPost(bob, "com.atproto.space.putRecord", {
    space: aliceHalf, repo: bob.did, collection: "org.slack.dm.message", rkey: tidNow(Date.now() + 60_000),
    record: { $type: "org.slack.dm.message", text: hostile, createdAt: new Date().toISOString() },
  });
  assert.equal(planted.status, 200, JSON.stringify(planted.body));
  const inBobsRepo = await this.pdsGet<{ records: Array<{ value: { text: string } }> }>(bob, "com.atproto.space.listRecords", { space: aliceHalf, repo: bob.did, collection: "org.slack.dm.message", limit: "100" });
  assert.deepEqual(inBobsRepo.body.records.map((record) => record.value.text), [hostile], "the hostile record really is stored in bob's own repo, scoped to alice's half");
  const asReader = await probeFor(this, alice).records(aliceHalf, bob, "org.slack.dm.message");
  assert.deepEqual(asReader.map((record) => record.value.text), [hostile], "and a credential holder for alice's half can fetch it from bob's repo");
  this.scratch.set("convKey", convKey);
  this.scratch.set("hostileText", hostile);
  this.scratch.set("reading", { reader: "alice", counterpart: "bob", visibleMessages: 2 } satisfies Reading);
});

type Reading = { reader: string; counterpart: string; visibleMessages: number };

When("a participant reads the conversation", { timeout: SETUP_TIMEOUT }, async function (this: AppWorld) {
  const reading = this.scratch.get("reading") as Reading;
  const reader = actorNamed(this, reading.reader);
  await dmpReload(reader);
  await dmpOpenConversationWith(reader, [actorNamed(this, reading.counterpart)]);
  await dmpPoll(async () => (await dmpMessageTexts(reader)).length >= reading.visibleMessages, { what: "the honest messages in the reader's timeline" });
});

Then("that record is ignored", async function (this: AppWorld) {
  const alice = actorNamed(this, "alice");
  const bob = actorNamed(this, "bob");
  const hostile = this.scratch.get("hostileText") as string;
  const convKey = this.scratch.get("convKey") as string;
  assert.deepEqual((await dmpMessageTexts(alice)).sort(), ["legit from alice", "legit from bob"]);
  assert.equal(await alice.page.getByText(hostile).count(), 0, "the hostile text is nowhere on the page");
  const independent = await readIndependentDmConversation(probeFor(this, alice).deps(), convKey, [alice.did, bob.did]);
  assert.deepEqual(independent.messages.map((message) => message.text).sort(), ["legit from alice", "legit from bob"], "an independent reader ignores it too");
});

Given("a half header names a different conversation key or participant set", { timeout: SETUP_TIMEOUT }, async function (this: AppWorld) {
  const alice = await joinDms(this, "alice", 0);
  const dana = await joinDms(this, "dana", 1);
  const wrongSet = await this.actor("wrongset", 0);
  const wrongKey = await this.actor("wrongkey", 1);
  await dmpEnableDms(dana);
  await dmpChooseMode(dana, "Everyone");

  await dmpStartConversation(alice, [wrongSet.did, wrongKey.did, dana.did]);
  await openStartedConversation(alice);
  await dmpSend(alice, "honest from alice");
  await acceptAndOpen(dana, alice);
  await dmpSend(dana, "honest from dana");

  const convKey = await singleConvKey(this, alice);
  const participants = (await dmpOwnHeader(this, alice, convKey)).participants;
  assert.equal(participants.length, 4);
  const otherKey = tidNow(Date.now() - 86_400_000);
  const requested = { convKey, participants };

  const subsetHeader = { convKey, participants: [alice.did, wrongSet.did].sort() };
  const keyHeader = { convKey: otherKey, participants };
  const halfWithSubset = { owner: wrongSet, convKey, readers: [alice], header: subsetHeader, message: "HOSTILE message under a header naming another participant set" };
  const halfWithKey = { owner: wrongKey, convKey, readers: [alice], header: keyHeader, message: "HOSTILE message under a header naming another conversation key" };
  await dmpWriteHostileHalf(this, halfWithSubset);
  await dmpWriteHostileHalf(this, halfWithKey);

  const headerContext = (owner: Actor) => ({ authorityDid: owner.did, spaceUri: dmConversationUri(owner.did, convKey), repoDid: owner.did, rkey: "self" });
  assert.equal(validateSpaceRecord("org.slack.dm.header", { $type: "org.slack.dm.header", ...subsetHeader, createdAt: new Date().toISOString() }, headerContext(wrongSet)).valid, true, "the differing participant set is a well-formed header on its own");
  assert.equal(validateDmHeaderMatchesRequest(subsetHeader, requested), false, "but it does not match the conversation being read");
  assert.equal(validateDmHeaderMatchesRequest(keyHeader, requested), false, "a header naming another conversation key does not match either");
  this.scratch.set("convKey", convKey);
  this.scratch.set("hostileHalves", [halfWithSubset, halfWithKey] satisfies DmpHostileHalf[]);
  this.scratch.set("reading", { reader: "alice", counterpart: "dana", visibleMessages: 2 } satisfies Reading);
});

Then("that half is ignored", async function (this: AppWorld) {
  const [alice, dana, wrongSet, wrongKey] = ["alice", "dana", "wrongset", "wrongkey"].map((role) => actorNamed(this, role)) as [Actor, Actor, Actor, Actor];
  const convKey = this.scratch.get("convKey") as string;
  assert.deepEqual((await dmpMessageTexts(alice)).sort(), ["honest from alice", "honest from dana"], "only the halves with matching headers contribute messages");
  assert.equal(await alice.page.getByText(/HOSTILE/).count(), 0, "neither hostile message is on the page");
  const chips = Object.fromEntries((await dmpParticipantRows(alice)).map(({ did, chip }) => [did, chip]));
  assert.deepEqual(chips, { [alice.did]: null, [dana.did]: null, [wrongSet.did]: MISSING_HALF_CHIP, [wrongKey.did]: MISSING_HALF_CHIP });
  const probe = probeFor(this, alice);
  for (const half of this.scratch.get("hostileHalves") as DmpHostileHalf[]) {
    const space = dmConversationUri(half.owner.did, half.convKey);
    assert.equal(await probe.credentialOutcome(space), "minted", `alice can mint a credential for ${half.owner.handle}'s half, so ignoring it is the client's decision and not a failed read`);
    assert.deepEqual((await probe.records(space, half.owner, "org.slack.dm.message")).map((record) => record.value.text), [half.message], `and ${half.owner.handle}'s hostile message is served to her`);
  }
  const independent = await readIndependentDmConversation(probeFor(this, alice).deps(), convKey, [alice.did, dana.did, wrongSet.did, wrongKey.did]);
  assert.deepEqual(independent.halves, { [alice.did]: "ok", [dana.did]: "ok", [wrongSet.did]: "missing", [wrongKey.did]: "missing" }, "an independent reader classifies the same halves as ignored");
});

// --- Conversation keys are random -------------------------------------------------------------------

type CrossedConversations = { first: { owner: string; convKey: string }; second: { owner: string; convKey: string }; participants: string[] };

const TID_ALPHABET = "234567abcdefghijklmnopqrstuvwxyz";
const RFC4648_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const SEPARATORS = ["", ",", "|", ":", "+", " ", "\n", "\0"];
const PREFIXES = ["", "dm:", "org.slack.dm.conversation:", "org.slack.dm.conversation/"];
const DIGESTS = ["sha256", "sha512", "sha1", "md5"] as const;

function encodeBase32(bytes: Uint8Array, alphabet: string): string {
  let bits = 0;
  let accumulator = 0;
  let encoded = "";
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += alphabet[(accumulator >>> bits) & 31];
    }
  }
  return bits > 0 ? encoded + alphabet[(accumulator << (5 - bits)) & 31] : encoded;
}

function sixtyFourBitTid(digest: Uint8Array): string {
  let value = BigInt(`0x${Buffer.from(digest.subarray(0, 8)).toString("hex")}`) & ((1n << 65n) - 1n);
  let encoded = "";
  for (let index = 0; index < 13; index += 1) {
    encoded = TID_ALPHABET[Number(value & 31n)] + encoded;
    value >>= 5n;
  }
  return encoded;
}

/** Every key a client could plausibly compute from a participant set: common hashes of common serializations, in common encodings. */
function candidateKeysFor(participants: readonly string[]): string[] {
  const orders = [[...participants], [...participants].reverse()];
  const serializations = new Set<string>();
  for (const order of orders) {
    for (const prefix of PREFIXES) {
      for (const separator of SEPARATORS) serializations.add(`${prefix}${order.join(separator)}`);
      serializations.add(`${prefix}${JSON.stringify(order)}`);
    }
  }
  const candidates = new Set<string>();
  for (const text of serializations) {
    for (const algorithm of DIGESTS) {
      const digest = new Uint8Array(createHash(algorithm).update(text).digest());
      candidates.add(sixtyFourBitTid(digest));
      candidates.add(encodeBase32(digest, TID_ALPHABET).slice(0, 13));
      candidates.add(encodeBase32(digest, RFC4648_ALPHABET).slice(0, 13));
    }
    candidates.add(stableHash(text).slice(0, 13));
    candidates.add(recordKeyHash(text).replaceAll(":", "").slice(0, 13));
  }
  return [...candidates];
}

Given("two conversations name the same participant set", { timeout: SETUP_TIMEOUT }, async function (this: AppWorld) {
  const alice = await joinDms(this, "alice", 0);
  const bob = await joinDms(this, "bob", 1);
  await dmpStartConversation(alice, [bob.did]);
  await dmpStartConversation(bob, [alice.did]);
  const first = await singleConvKey(this, alice);
  const second = await singleConvKey(this, bob);
  const firstSet = (await dmpOwnHeader(this, alice, first)).participants;
  const secondSet = (await dmpOwnHeader(this, bob, second)).participants;
  assert.deepEqual(firstSet, [alice.did, bob.did].sort());
  assert.deepEqual(secondSet, firstSet, "both conversations name exactly the same participants");
  this.scratch.set("crossed", { first: { owner: alice.role, convKey: first }, second: { owner: bob.role, convKey: second }, participants: firstSet } satisfies CrossedConversations);
});

Then("their conversation keys differ", function (this: AppWorld) {
  const { first, second } = this.scratch.get("crossed") as CrossedConversations;
  assert.match(first.convKey, /^[234567a-z]{13}$/);
  assert.match(second.convKey, /^[234567a-z]{13}$/);
  assert.notEqual(first.convKey, second.convKey);
});

Then("no conversation key can be computed from participant DIDs", function (this: AppWorld) {
  const { first, second, participants } = this.scratch.get("crossed") as CrossedConversations;
  const candidates = candidateKeysFor(participants);
  assert.ok(candidates.length > 500, `the derivation battery is not vacuous (${candidates.length} candidates)`);
  assert.equal(candidates.includes(first.convKey), false, "the first key is none of the derivations");
  assert.equal(candidates.includes(second.convKey), false, "the second key is none of the derivations");
  assert.notEqual(first.convKey, second.convKey, "and since both name the same DID set, no function of that set can produce both");
  this.scratch.set("candidates", candidates);
});

Then("a party who cannot guess the key cannot confirm who talks to whom", { timeout: SETUP_TIMEOUT }, async function (this: AppWorld) {
  const { first, second } = this.scratch.get("crossed") as CrossedConversations;
  const candidates = (this.scratch.get("candidates") as string[]).slice(0, 40);
  const owners = [actorNamed(this, first.owner), actorNamed(this, second.owner)];
  const outsider = await this.actor("outsider", 0);
  const probe = probeFor(this, outsider);
  const neverCreated = [tidNow(Date.now() - 1_000_000_000), tidNow(Date.now() - 2_000_000_000)];

  const outcomes = new Map<string, Set<string>>();
  for (const owner of owners) {
    for (const guess of [...candidates, ...neverCreated]) {
      const kind = neverCreated.includes(guess) ? "random" : "derived";
      const outcome = await probe.credentialOutcome(dmConversationUri(owner.did, guess));
      outcomes.set(kind, (outcomes.get(kind) ?? new Set()).add(outcome));
    }
  }
  assert.deepEqual([...outcomes.get("random")!], ["SpaceNotFound"], "a key nobody ever created is reported as not found");
  assert.deepEqual([...outcomes.get("derived")!], ["SpaceNotFound"], "every key derived from the participants is reported exactly like a key nobody created");
  assert.equal(await probe.credentialOutcome(dmConversationUri(actorNamed(this, first.owner).did, first.convKey)), "denied", "whereas knowing the real key would reveal that the conversation exists");
  assert.equal(await probe.credentialOutcome(dmConversationUri(actorNamed(this, second.owner).did, second.convKey)), "denied");
  assert.deepEqual(await dmpOwnConvKeys(this, outsider), [], "the outsider's own PDS lists no conversation to learn from");
});

// --- Correctness never depends on the app -----------------------------------------------------------

const ONE_MINUTE = 60_000;

Given("a request was written but no reply half appeared", { timeout: SETUP_TIMEOUT }, async function (this: AppWorld) {
  const recipient = await joinDms(this, "recipient", 0);
  const sender = await joinDms(this, "sender", 1);
  await dmpEnableDms(recipient);
  await dmpEnableDms(sender);
  const outcomes = await dmpStartConversation(sender, [recipient.did]);
  assert.equal(outcomes[recipient.did], "delivered", "the write itself succeeds");

  const convKey = await singleConvKey(this, sender);
  assert.equal((await dmpRequestOps(this, sender, recipient)).length, 1, "the request record exists once in the sender's repo");
  assert.deepEqual(await trackedDids(this, recipient), [], "but the recipient's PDS never learned of it: the notification was refused");
  assert.deepEqual(await dmpOwnConvKeys(this, recipient), [], "and no reply half exists");
  assert.equal(await probeFor(this, sender).credentialOutcome(dmConversationUri(recipient.did, convKey)), "SpaceNotFound");
  this.scratch.set("convKey", convKey);
  this.scratch.set("startedAt", Date.parse((await dmpOwnHeader(this, sender, convKey)).createdAt));
});

When("the sender's re-notify backoff elapses", { timeout: 900_000 }, async function (this: AppWorld) {
  const recipient = actorNamed(this, "recipient");
  const sender = actorNamed(this, "sender");
  const convKey = this.scratch.get("convKey") as string;
  const startedAt = this.scratch.get("startedAt") as number;
  assert.deepEqual([...DM_RENOTIFY_BACKOFF_MS], [ONE_MINUTE, 10 * ONE_MINUTE, 60 * ONE_MINUTE, 24 * 60 * ONE_MINUTE], "the schedule is 1 minute, 10 minutes, 1 hour, 1 day");
  const opCount = async (): Promise<number> => (await dmpRequestOps(this, sender, recipient)).length;

  await dmpChooseMode(recipient, "Everyone");
  assert.ok(Date.now() - startedAt < ONE_MINUTE - 5_000, "the sender's first cycle runs inside the first minute");
  await dmpReloadThroughCycle(sender);
  assert.equal(await opCount(), 1, "a cycle inside the first minute re-sends nothing");

  await dmpPoll(async () => (await opCount()) >= 2, { what: "the first re-notification after one real minute", timeoutMs: 180_000 });
  assert.ok(Date.now() - startedAt >= ONE_MINUTE - 1_000, "it was not sent before the first backoff had elapsed");

  for (let attempts = 1; attempts < DM_RENOTIFY_BACKOFF_MS.length; attempts += 1) {
    const backoff = DM_RENOTIFY_BACKOFF_MS[attempts]!;
    assert.equal((await dmpRenotifyState(sender, convKey, recipient))?.attempts, attempts, "the sender persisted how many re-sends it has made");
    await dmpSetRenotifyElapsed(sender, convKey, recipient, backoff - 2 * ONE_MINUTE);
    await dmpReloadThroughCycle(sender);
    assert.equal(await opCount(), attempts + 1, `${backoff - 2 * ONE_MINUTE} ms is not enough for a ${backoff} ms step`);
    await dmpSetRenotifyElapsed(sender, convKey, recipient, backoff + 1_000);
    await dmpReloadThroughCycle(sender);
    await dmpPoll(async () => (await opCount()) >= attempts + 2, { what: `re-notification ${attempts + 1} after ${backoff} ms` });
  }
});

Then("the same request record is re-put with a new revision", async function (this: AppWorld) {
  const recipient = actorNamed(this, "recipient");
  const sender = actorNamed(this, "sender");
  const convKey = this.scratch.get("convKey") as string;
  const ops = await dmpRequestOps(this, sender, recipient);
  assert.equal(ops.length, 1 + DM_RENOTIFY_BACKOFF_MS.length, "one original write and one re-put per backoff step");
  assert.ok(ops.every((op) => op.collection === "org.slack.dm.request" && op.rkey === convKey), "every write is to the same request record");
  assert.equal(new Set(ops.map((op) => op.cid)).size, 1, "with identical content");
  assert.deepEqual(ops.slice(1).map((op) => op.prev), ops.slice(0, -1).map((op) => op.cid), "each re-put replaces the previous version of that record");
  assert.deepEqual(ops.map((op) => op.rev), [...new Set(ops.map((op) => op.rev))].sort(), "and carries a new, later revision");
  const latest = await dmpLatestCommitRev(this, sender, recipient);
  assert.equal(ops.at(-1)!.rev, latest);
  const tracked = (await probeFor(this, recipient).trackedWriters(recipient)).find((writer) => writer.did === sender.did);
  assert.equal(tracked?.rev, latest, "the recipient's PDS recorded the newest revision, so the notification finally reached it");
});

Then("the recipient side treats the repeat as idempotent", async function (this: AppWorld) {
  const recipient = actorNamed(this, "recipient");
  const sender = actorNamed(this, "sender");
  const convKey = this.scratch.get("convKey") as string;
  assert.deepEqual((await probeFor(this, recipient).trackedWriters(recipient)).map((writer) => writer.did), [sender.did], "one tracked writer, however many times it notified");
  const stored = await probeFor(this, recipient).records(dmInboxUri(recipient.did), sender, "org.slack.dm.request");
  assert.deepEqual(stored.map((record) => record.rkey), [convKey], "one request record");
  const rows = await dmpReadRequests(recipient);
  assert.deepEqual(rows.map(({ section, sender: from }) => ({ section, sender: from })), [{ section: "others", sender: sender.did }], "and one request in the recipient's folder");
  assert.equal(await dmpRequestCount(recipient), 1);
});

Then("the backoff stops after the final step", { timeout: SETUP_TIMEOUT }, async function (this: AppWorld) {
  const recipient = actorNamed(this, "recipient");
  const sender = actorNamed(this, "sender");
  const convKey = this.scratch.get("convKey") as string;
  const before = await dmpRequestOps(this, sender, recipient);
  assert.equal((await dmpRenotifyState(sender, convKey, recipient))?.attempts, DM_RENOTIFY_BACKOFF_MS.length, "every step of the schedule has been used");
  await dmpSetRenotifyElapsed(sender, convKey, recipient, 365 * 24 * 60 * ONE_MINUTE);
  await dmpReloadThroughCycle(sender);
  assert.deepEqual((await dmpRequestOps(this, sender, recipient)).map((op) => op.rev), before.map((op) => op.rev), "a year later the sender sends nothing more");
  assert.equal((await dmpRenotifyState(sender, convKey, recipient))?.attempts, DM_RENOTIFY_BACKOFF_MS.length);
});

// --- Rebuild every conversation from your own PDS ---------------------------------------------------

type ExpectedConversation = { convKey: string; others: string[] };
type RebuildHistory = {
  conversations: ExpectedConversation[];
  pendingSender: string;
  allowlist: string[];
  credentialsBefore: DmpMintedCredential[];
  messages: Record<string, string[]>;
};

Given("the app server, its database, and its notification endpoint are gone", { timeout: 900_000 }, async function (this: AppWorld) {
  const alice = await this.actor("alice", 0);
  const credentialsBefore = dmpWatchCredentials(alice.page);
  await signIn(this, alice);
  await dmpConnectDms(alice);
  const bob = await joinDms(this, "bob", 1);
  const carol = await joinDms(this, "carol", 0);
  for (const person of [alice, bob]) {
    await dmpEnableDms(person);
    await dmpChooseMode(person, "Everyone");
  }

  await dmpStartConversation(alice, [bob.did]);
  await openStartedConversation(alice);
  await dmpSend(alice, "alice to bob");
  await acceptAndOpen(bob, alice);
  await dmpSend(bob, "bob to alice");

  await dmpStartConversation(carol, [alice.did]);
  await openStartedConversation(carol);
  await dmpSend(carol, "carol to alice");
  await acceptAndOpen(alice, carol);
  await dmpSend(alice, "alice to carol");

  const outcomes = await dmpStartConversation(bob, [alice.did, carol.did]);
  assert.equal(outcomes[alice.did], "delivered");

  const aliceKeys = await dmpOwnConvKeys(this, alice);
  assert.equal(aliceKeys.length, 2, "alice owns the two halves she created or accepted");
  const conversations = await Promise.all(aliceKeys.map(async (convKey) => ({
    convKey, others: (await dmpOwnHeader(this, alice, convKey)).participants.filter((did) => did !== alice.did),
  })));
  this.scratch.set("history", {
    conversations, pendingSender: bob.did, allowlist: (await inboxPolicy(this, alice)).members.map((member) => member.did).sort(), credentialsBefore,
    messages: { [bob.did]: ["alice to bob", "bob to alice"], [carol.did]: ["alice to carol", "carol to alice"] },
  } satisfies RebuildHistory);
  assert.deepEqual((this.scratch.get("history") as RebuildHistory).allowlist, [carol.did], "accepting carol's request put her on alice's allowlist");

  const second = await this.fixture.startSecondApp();
  this.scratch.set("secondApp", second);
  assert.equal(dmpAppDataRowCount(second.databasePath), 0, "the replacement app starts with an empty database");
});

When("a participant signs in with any conforming OAuth client", { timeout: SETUP_TIMEOUT }, async function (this: AppWorld) {
  const alice = actorNamed(this, "alice");
  const second = this.scratch.get("secondApp") as SecondApp;
  const context = await this.newContext("alice-elsewhere");
  const requested: string[] = [];
  const notificationStreamAttempts: string[] = [];
  context.on("request", (request) => { requested.push(request.url()); });
  await context.route(`${this.appOrigin}/**`, (route) => route.abort("connectionrefused"));
  await context.route("**/api/notifications/dm**", (route) => { notificationStreamAttempts.push(route.request().url()); return route.abort("connectionrefused"); });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const elsewhere: Actor = { ...alice, role: "alice-elsewhere", context, page, calls: [] };
  this.actors.set(elsewhere.role, elsewhere);
  this.scratch.set("rebuiltCredentials", dmpWatchCredentials(page));
  this.scratch.set("rebuildRequests", requested);
  this.scratch.set("notificationStreamAttempts", notificationStreamAttempts);
  this.scratch.set("rebuildStartedAt", Date.now());
  await dmpSignInAt(elsewhere, second.appUrl.origin);
  await dmpConnectDms(elsewhere);
});

Then("their conversations are rebuilt from their own spaces, halves, and inbox", { timeout: SETUP_TIMEOUT }, async function (this: AppWorld) {
  const history = this.scratch.get("history") as RebuildHistory;
  const elsewhere = actorNamed(this, "alice-elsewhere");
  const handleOf = (did: string): string => [...this.actors.values()].find((actor) => actor.did === did)!.handle;

  const expectedLabels = history.conversations.map((conversation) => conversation.others.map(handleOf).join(", ")).sort();
  const labels = await dmpPoll(async () => {
    const shown = (await dmpSidebarConversationLabels(elsewhere)).map((label) => label.replace("◈", "").trim()).sort();
    return JSON.stringify(shown) === JSON.stringify(expectedLabels) ? shown : null;
  }, { what: "the rebuilt conversation list", timeoutMs: 60_000 });
  assert.equal(labels.length, 2);

  await dmpOpenRequests(elsewhere);
  assert.deepEqual(await dmpRequestSenders(elsewhere), [history.pendingSender], "the request still waiting in the inbox is back");
  await dmpOpenSettings(elsewhere);
  await elsewhere.page.getByText("Current mode: Everyone").waitFor({ state: "visible" });
  assert.deepEqual(await dmpAllowlistDids(elsewhere), history.allowlist, "so is the inbox policy and allowlist");

  const second = this.scratch.get("secondApp") as SecondApp;
  const contacted = [...new Set((this.scratch.get("rebuildRequests") as string[]).filter((url) => /^https?:/.test(url)).map((url) => new URL(url).origin))].sort();
  const localServers = [second.appUrl.origin, ...this.fixture.pdsUrls.map((url) => new URL(url).origin), new URL(this.fixture.plcUrl).origin];
  const outsideServers = ["https://fonts.googleapis.com", "https://fonts.gstatic.com", ...[...this.actors.values()].map((actor) => `https://${actor.handle}`)];
  const isLocal = (origin: string): boolean => ["127.0.0.1", "localhost"].includes(new URL(origin).hostname);
  assert.ok(contacted.includes(second.appUrl.origin), "the rebuilt page was served by the replacement app");
  assert.ok(this.fixture.pdsUrls.some((url) => contacted.includes(new URL(url).origin)), "and talked to the PDS hosts, so the observation below covers the rebuild itself");
  assert.deepEqual(contacted.filter((origin) => isLocal(origin) && !localServers.includes(origin)), [], "of the servers on this machine the rebuild contacted only the replacement app, the PDS hosts, and the PLC directory");
  assert.deepEqual(contacted.filter((origin) => !isLocal(origin) && !outsideServers.includes(origin)), [], "and beyond them only web fonts and handle-domain lookups");
  assert.equal(contacted.includes(this.appOrigin), false, "so nothing in it so much as tried the original app server");
  assert.ok((this.scratch.get("notificationStreamAttempts") as string[]).length > 0, "the notification stream was tried and refused while the conversations were rebuilt anyway");
  assert.equal(dmpAppDataRowCount(second.databasePath), 0, "and the replacement app, which only ever saw a sign-in, holds no workspace or channel data");
  assert.equal(dmpFilesContain(second.databasePath, "alice to bob"), false, "or any conversation text");
});

Then("the other halves are read with freshly minted credentials", { timeout: SETUP_TIMEOUT }, async function (this: AppWorld) {
  const history = this.scratch.get("history") as RebuildHistory;
  const alice = actorNamed(this, "alice");
  const elsewhere = actorNamed(this, "alice-elsewhere");
  const minted = this.scratch.get("rebuiltCredentials") as DmpMintedCredential[];
  const startedAt = this.scratch.get("rebuildStartedAt") as number;
  const handleOf = (did: string): string => [...this.actors.values()].find((actor) => actor.did === did)!.handle;

  for (const conversation of history.conversations) {
    const other = [...this.actors.values()].find((actor) => actor.did === conversation.others[0])!;
    await dmpReload(elsewhere);
    await dmpOpenConversationWith(elsewhere, [other]);
    const expected = history.messages[other.did]!;
    await dmpPoll(async () => (await dmpMessageTexts(elsewhere)).length >= expected.length, { what: `the messages with ${handleOf(other.did)}` });
    assert.deepEqual((await dmpMessageTexts(elsewhere)).sort(), [...expected].sort(), `both halves of the conversation with ${handleOf(other.did)} are shown`);

    const otherHalf = dmConversationUri(other.did, conversation.convKey);
    const credential = minted.find((entry) => entry.space === otherHalf && entry.status === 200 && entry.token);
    assert.ok(credential, `this browser obtained its own credential for ${handleOf(other.did)}'s half`);
    const claims = dmpJwtClaims(credential.token);
    assert.equal(claims.sub, otherHalf);
    assert.ok(Number(claims.iat) * 1000 >= startedAt - 5_000, "issued during this sign-in, not before it");
    const usedBefore = history.credentialsBefore.map((entry) => entry.token).filter(Boolean);
    assert.ok(usedBefore.length > 0, "the first session had minted credentials of its own to compare with");
    assert.equal(usedBefore.includes(credential.token), false, "it is not a credential the original session held");

    const independent = await readIndependentDmConversation(probeFor(this, alice).deps(), conversation.convKey, [alice.did, ...conversation.others]);
    assert.deepEqual(independent.messages.map((message) => message.text).sort(), [...expected].sort(), "and a client with no app at all reads the same conversation");
  }
});

// --- The app server never holds DM scopes or DM content ---------------------------------------------

const DM_SPACE_TYPE = "org.slack.dm";

type ServerSession = { second: SecondApp; key: string; dmScopeShown: string[]; texts: string[] };

Given("the app runs its own server session for workspaces", { timeout: SETUP_TIMEOUT }, async function (this: AppWorld) {
  const key = randomBytes(32).toString("hex");
  const second = await this.fixture.startSecondApp({ env: { AUTH_ENCRYPTION_KEY: key } });
  const alice = await this.actor("alice", 0);
  await dmpSignInAt(alice, second.appUrl.origin);
  await submitWorkspaceName(alice, uniqueWorkspaceName());
  await completeConsent(alice);
  await dmpWaitForOrigin(alice, second.appUrl.origin);
  await alice.page.getByRole("heading", { level: 1 }).or(alice.page.locator(".mono-note").filter({ hasText: "at://" }).first()).waitFor({ state: "visible" });

  const sessions = dmpServerSessions(second.databasePath, key);
  const own = sessions.find((session) => session.did === alice.did);
  assert.ok(own, "the app server holds an OAuth session for alice");
  assert.ok(own.scope.some((scope) => scope.startsWith(`space:org.slack.workspace?authority=${alice.did}`) && scope.includes("collection=org.slack.admin")),
    `the session carries the workspace-authority scopes it was approved for: ${own.scope.join(" ")}`);
  this.scratch.set("serverSession", { second, key, dmScopeShown: [], texts: [] } satisfies ServerSession);
});

When("direct messages are exchanged", { timeout: SETUP_TIMEOUT }, async function (this: AppWorld) {
  const session = this.scratch.get("serverSession") as ServerSession;
  const origin = session.second.appUrl.origin;
  const alice = actorNamed(this, "alice");
  const bob = await this.actor("bob", 1);
  session.dmScopeShown.push(...await dmpConnectDmsReadingScope(alice));
  await dmpSignInAt(bob, origin);
  session.dmScopeShown.push(...await dmpConnectDmsReadingScope(bob));
  await dmpEnableDms(bob);
  await dmpChooseMode(bob, "Everyone");

  const secrets = [`secret-hello-${randomBytes(6).toString("hex")}`, `secret-reply-${randomBytes(6).toString("hex")}`];
  await dmpStartConversation(alice, [bob.did]);
  await openStartedConversation(alice);
  await dmpSend(alice, secrets[0]!);
  await acceptAndOpen(bob, alice);
  await dmpSend(bob, secrets[1]!);
  await dmpSync(alice);
  await alice.page.getByText(secrets[1]!, { exact: true }).waitFor({ state: "visible" });
  session.texts.push(...secrets);
});

Then("that session holds no DM scope", function (this: AppWorld) {
  const session = this.scratch.get("serverSession") as ServerSession;
  const held = dmpServerSessions(session.second.databasePath, session.key);
  assert.deepEqual(held.map((entry) => entry.did).sort(), [actorNamed(this, "alice").did, actorNamed(this, "bob").did].sort(), "the server holds a session for each person who signed in");
  for (const entry of held) {
    assert.ok(entry.scope.includes("atproto"), "a real, granted session");
    assert.deepEqual(entry.scope.filter((scope) => scope.includes(DM_SPACE_TYPE)), [], `no granted scope names a DM space: ${entry.scope.join(" ")}`);
    assert.deepEqual(entry.clientScope.filter((scope) => scope.includes(DM_SPACE_TYPE)), [], "nor does the scope its OAuth client requested");
  }
  assert.ok(session.dmScopeShown.some((scope) => scope.includes(`space:${DM_SPACE_TYPE}.conversation`)), "the DM permission does exist: it was asked of, and approved at the PDS by, the separate browser-held session");
});

Then("no server route stores or returns DM content", async function (this: AppWorld) {
  const session = this.scratch.get("serverSession") as ServerSession;
  const alice = actorNamed(this, "alice");
  const bob = actorNamed(this, "bob");
  assert.equal(session.texts.length, 2);
  const everyCall = [alice, bob].flatMap((actor) => actor.calls);
  assert.ok(everyCall.length > 0, "the people's browsers did talk to the app server");
  const stream = await readStream(`${session.second.appUrl.origin}/api/notifications/dm?space=${encodeURIComponent(dmInboxUri(alice.did))}&after=0`, await cookieHeader(alice));
  const stored = dmpEverythingTheAppStored(session.second.databasePath, session.key);
  assert.ok(stored.some((value) => value.includes(alice.did)), "the scan of the database sees what the app does keep: accounts and sessions");
  for (const text of session.texts) {
    assert.equal(everyCall.some((call) => call.requestBody.includes(text) || call.responseBody.includes(text) || call.path.includes(text)), false, `no /api request or response carries "${text}"`);
    assert.equal(stream.includes(text), false, "nor does the notification stream");
    assert.equal(dmpFilesContain(session.second.databasePath, text), false, "nor do the database files");
    assert.equal(stored.some((value) => value.includes(text)), false, "nor any value in it, once decrypted");
    assert.equal(session.second.serverOutput().includes(text), false, "nor the server's own output");
  }
  assert.match(stream, /^(: keepalive|id: \d+\nevent: change\ndata: \{"cursor":\d+\})/m, "the stream is the content-free change feed");
});

async function cookieHeader(actor: Actor): Promise<string> {
  return (await actor.context.cookies()).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

async function readStream(url: string, cookie: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  let received = "";
  try {
    const response = await fetch(url, { headers: { cookie, accept: "text/event-stream" }, signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += Buffer.from(chunk.value).toString("utf8");
    }
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "AbortError") throw error;
  } finally {
    clearTimeout(timer);
  }
  return received;
}
