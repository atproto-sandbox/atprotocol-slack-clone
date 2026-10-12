import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { reactionRecordKey, tidNow } from "@/protocol/keys";
import type { FixtureAccount } from "../../protocol-tests/support/app-fixture";
import type { AppWorld, Actor } from "../support/world";
import {
  type DmcReaction, type DmcRepoHistory, dmcAcceptRequestFrom, dmcAllowlistShown, dmcAppDatabaseMentions, dmcAppDatabaseText, dmcCard, dmcClientFor, dmcConnect, dmcConvKeyOf, dmcDeleteMessage, dmcDeliveryRows, dmcEditMessage, dmcEnableDms, dmcHalfOf, dmcHalfUris,
  dmcHeaderOf, dmcInboxOf, dmcInboxUris, dmcMembers, dmcMessagesOf, dmcMessageUri, dmcMint, dmcOpenOnlyConversation, dmcOpenRequests, dmcOpenSettings,
  dmcOpenInboxAccounts, dmcOpenStartedConversation, dmcReload, dmcReloadAndAcceptFrom, dmcRepoHistory, dmcRequestRow, dmcRecords, dmcRequestsFrom, dmcRequestsServedTo, dmcRoster, dmcSend, dmcSetMode, dmcStartConversation, dmcSync, dmcTrafficOf, dmcUntil, dmcWriterRevs, dmcWriters,
} from "../support/dm-conversations-ui";

const dmcActor = (world: AppWorld, role: string): Actor => {
  const actor = world.actors.get(role);
  assert.ok(actor, `this scenario has no ${role} yet`);
  return actor;
};

function dmcRemember<T>(world: AppWorld, key: string, value: T): T {
  world.scratch.set(`dmc:${key}`, value);
  return value;
}

function dmcRecall<T>(world: AppWorld, key: string): T {
  const value = world.scratch.get(`dmc:${key}`);
  assert.ok(value !== undefined, `this scenario has not recorded ${key} yet`);
  return value as T;
}

/** An initiator and another participant with direct messages connected, the other open to requests from anyone. */
async function dmcConnectedPair(world: AppWorld, hosts: { initiator: 0 | 1; other: 0 | 1 } = { initiator: 0, other: 1 }): Promise<{ initiator: Actor; other: Actor }> {
  const [initiator, other] = await Promise.all([world.actor("initiator", hosts.initiator), world.actor("other", hosts.other)]);
  await Promise.all([dmcConnect(world, initiator), dmcConnect(world, other)]);
  await dmcEnableDms(other, "everyone");
  return { initiator, other };
}

/** The initiator's only half: its conversation key and the participants named in its header. */
async function dmcOnlyHalf(world: AppWorld, initiator: Actor): Promise<{ convKey: string; participants: string[] }> {
  const halves = await dmcHalfUris(world, initiator);
  assert.equal(halves.length, 1, "the initiator has exactly one conversation half");
  const convKey = dmcConvKeyOf(halves[0]!);
  assert.equal(halves[0], dmcHalfOf(initiator, convKey), "the half is authored by the initiator on their own PDS");
  const header = await dmcHeaderOf(world, initiator, convKey);
  return { convKey, participants: header.value.participants };
}

// --- Each participant owns only their own words ------------------------------------------------------

Given("a user has no DM inbox", async function (this: AppWorld) {
  const user = await this.actor("user");
  await dmcConnect(this, user);
  assert.deepEqual(await dmcInboxUris(this, user), [], "the account has no DM inbox on its PDS");
  await dmcOpenSettings(user);
  await user.page.getByText(/Direct messages are not enabled yet/).waitFor({ state: "visible" });
});

When("they enable DMs", async function (this: AppWorld) {
  await dmcEnableDms(dmcActor(this, "user"));
});

Then("a DM inbox space with the fixed self key exists on their own PDS", async function (this: AppWorld) {
  const user = dmcActor(this, "user");
  assert.deepEqual(await dmcInboxUris(this, user), [`at://${user.did}/space/org.slack.dm.inbox/self`]);
  const space = await this.pdsGet(user, "com.atproto.simplespace.getSpace", { space: dmcInboxOf(user) });
  assert.equal(space.status, 200, JSON.stringify(space.body));
});

Then("only its owner can read it", async function (this: AppWorld) {
  const user = dmcActor(this, "user");
  const inbox = dmcInboxOf(user);
  const space = await this.pdsGet<{ readPolicy: { $type: string } }>(user, "com.atproto.simplespace.getSpace", { space: inbox });
  assert.equal(space.body.readPolicy.$type, "com.atproto.simplespace.defs#memberListPolicy", "reads are limited to the member list");

  const writer = await this.actor("writer", 1);
  const allowed = await this.pdsPost(user, "com.atproto.simplespace.putMember", { space: inbox, did: writer.did, read: false, write: true });
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  assert.deepEqual(await dmcMembers(this, user, inbox), [{ did: writer.did, read: false, write: true }], "an allowed writer is on the member list without read access");

  const stranger = await this.actor("stranger", 1);
  assert.deepEqual(await dmcMint(this, user, inbox), { minted: true }, "the owner is given a read credential");
  assert.deepEqual(await dmcMint(this, writer, inbox), { minted: false, status: 403, code: "UserNotAuthorized" }, "a writer allowed to send requests cannot read the inbox");
  assert.deepEqual(await dmcMint(this, stranger, inbox), { minted: false, status: 403, code: "UserNotAuthorized" }, "a stranger cannot read the inbox");
});

Then("a user without an inbox is shown as not having enabled DMs", async function (this: AppWorld) {
  const user = dmcActor(this, "user");
  const sender = await this.actor("sender", 1);
  const bystander = await this.actor("bystander", 0);
  assert.deepEqual(await dmcInboxUris(this, bystander), [], "the bystander never enabled direct messages");
  await dmcConnect(this, sender);
  await dmcStartConversation(sender, [bystander.did, user.did]);
  const outcomes = new Map((await dmcDeliveryRows(sender)).map((row) => [row.did, row.outcome]));
  assert.equal(outcomes.get(bystander.did), "noInbox — they have not enabled direct messages");
  assert.ok(outcomes.has(user.did) && !/noInbox/.test(outcomes.get(user.did)!), "a user who enabled direct messages is not shown as lacking an inbox");
  await dmcOpenSettings(user);
  assert.equal(await user.page.getByText(/Direct messages are not enabled yet/).count(), 0, "the user's own settings no longer say direct messages are off");
});

Given("an initiator chooses one other participant", async function (this: AppWorld) {
  const { other } = await dmcConnectedPair(this);
  dmcRemember(this, "chosen", [other.did]);
  dmcRemember(this, "firstMessages", ["first words", "second words"]);
});

When("they start the conversation", { timeout: 300_000 }, async function (this: AppWorld) {
  const initiator = dmcActor(this, "initiator");
  await dmcStartConversation(initiator, dmcRecall<string[]>(this, "chosen"), 240_000);
  const firstMessages = dmcRecall<string[]>(this, "firstMessages");
  if (firstMessages.length === 0) return;
  await dmcOpenStartedConversation(initiator);
  for (const text of firstMessages) await dmcSend(initiator, text);
});

Then("the initiator writes a header and messages into their own half", async function (this: AppWorld) {
  const initiator = dmcActor(this, "initiator");
  const other = dmcActor(this, "other");
  const { convKey, participants } = await dmcOnlyHalf(this, initiator);
  assert.deepEqual(participants, [initiator.did, other.did].sort());
  const messages = await dmcMessagesOf(this, initiator, convKey);
  assert.deepEqual(messages.map((message) => message.value.text).sort(), [...dmcRecall<string[]>(this, "firstMessages")].sort());
  assert.deepEqual(await dmcHalfUris(this, other), [], "nothing was created on the other participant's PDS");
  for (const text of dmcRecall<string[]>(this, "firstMessages")) await dmcCard(initiator, text).waitFor({ state: "visible" });
  dmcRemember(this, "conversation", { convKey, participants });
});

Then("the other participant finds a request in their own inbox", async function (this: AppWorld) {
  const initiator = dmcActor(this, "initiator");
  const other = dmcActor(this, "other");
  await dmcReload(other);
  await dmcOpenRequests(other, 1);
  await dmcRequestRow(other, initiator.did).waitFor({ state: "visible" });
  const found = await dmcClientFor(this, other).listRequests();
  assert.deepEqual(found.map((request) => request.sender), [initiator.did], "the other participant's own engine finds one request, from the initiator");
  assert.equal((await dmcRequestsFrom(this, initiator, other)).length, 1, "the request record is stored in the initiator's repo, scoped to the other participant's inbox");
});

Then("the request names the same conversation key and participant set", async function (this: AppWorld) {
  const initiator = dmcActor(this, "initiator");
  const other = dmcActor(this, "other");
  const { convKey, participants } = dmcRecall<{ convKey: string; participants: string[] }>(this, "conversation");
  const [request] = await dmcRequestsFrom(this, initiator, other);
  assert.equal(request!.rkey, convKey);
  assert.equal(request!.value.convKey, convKey);
  assert.deepEqual(request!.value.participants, participants);
  const [found] = await dmcClientFor(this, other).listRequests();
  assert.deepEqual({ convKey: found!.convKey, participants: found!.participants }, { convKey, participants }, "the recipient reads the same key and participants");
  await dmcRequestRow(other, initiator.did).getByText(/2 participants/).waitFor({ state: "visible" });
});

Given("the initiator already has a conversation with the same participant set", async function (this: AppWorld) {
  const { initiator, other } = await dmcConnectedPair(this);
  dmcRemember(this, "chosen", [other.did]);
  await dmcStartConversation(initiator, [other.did]);
  await dmcOpenStartedConversation(initiator);
  await dmcSend(initiator, "first words");
  const { convKey, participants } = await dmcOnlyHalf(this, initiator);
  const header = await dmcHeaderOf(this, initiator, convKey);
  const messages = await dmcMessagesOf(this, initiator, convKey);
  const requests = await dmcRequestsFrom(this, initiator, other);
  assert.equal(requests.length, 1);
  dmcRemember(this, "before", {
    convKey, participants, headerCid: header.cid, messageCids: messages.map((message) => message.cid), requests: requests.map((request) => ({ rkey: request.rkey, cid: request.cid })),
    history: await dmcWriteHistory(this, initiator, other, convKey),
  });
});

type DmcWriteHistory = { ownHalf: DmcRepoHistory; requestRepo: DmcRepoHistory; inboxWriterRevs: Record<string, string> };

/** Everything a repeated start could have written: the initiator's own half, their repo in the other's inbox, and the other's record of that writer. */
async function dmcWriteHistory(world: AppWorld, initiator: Actor, other: Actor, convKey: string): Promise<DmcWriteHistory> {
  return {
    ownHalf: await dmcRepoHistory(world, initiator, dmcHalfOf(initiator, convKey)),
    requestRepo: await dmcRepoHistory(world, initiator, dmcInboxOf(other)),
    inboxWriterRevs: await dmcWriterRevs(world, other, other, dmcInboxOf(other)),
  };
}

When("they start that conversation again", async function (this: AppWorld) {
  await dmcStartConversation(dmcActor(this, "initiator"), dmcRecall<string[]>(this, "chosen"));
});

Then("the existing conversation key is reused locally", async function (this: AppWorld) {
  const initiator = dmcActor(this, "initiator");
  const before = dmcRecall<{ convKey: string; participants: string[] }>(this, "before");
  const rows = await dmcDeliveryRows(initiator);
  assert.deepEqual(rows.map((row) => row.outcome), ["not attempted"], "no request was delivered to anyone for the repeated start");
  assert.deepEqual(await dmcOnlyHalf(this, initiator), { convKey: before.convKey, participants: before.participants }, "the same half is still the only one");
  await dmcOpenStartedConversation(initiator);
  await dmcCard(initiator, "first words").waitFor({ state: "visible" });
  assert.equal(await initiator.page.locator(".channel-nav-item", { hasText: "◈" }).count(), 1, "the sidebar still lists a single conversation");
});

Then("no new half or request is written", async function (this: AppWorld) {
  const initiator = dmcActor(this, "initiator");
  const other = dmcActor(this, "other");
  const before = dmcRecall<{ convKey: string; headerCid: string; messageCids: string[]; requests: Array<{ rkey: string; cid: string }>; history: DmcWriteHistory }>(this, "before");
  const after = await dmcWriteHistory(this, initiator, other, before.convKey);
  assert.deepEqual(after.ownHalf, before.history.ownHalf, "the initiator's half took no write at all: its latest revision and every op are unchanged, which identical content cannot hide");
  assert.deepEqual(after.requestRepo, before.history.requestRepo, "the initiator's repo in the other participant's inbox took no write either, so no request was re-put");
  assert.deepEqual(after.inboxWriterRevs, before.history.inboxWriterRevs, "and the other participant's PDS recorded no newer revision from the initiator");
  assert.equal((await dmcHalfUris(this, initiator)).length, 1, "no second half exists");
  assert.equal((await dmcHeaderOf(this, initiator, before.convKey)).cid, before.headerCid, "the header was not rewritten");
  assert.deepEqual((await dmcMessagesOf(this, initiator, before.convKey)).map((message) => message.cid), before.messageCids);
  assert.deepEqual((await dmcRequestsFrom(this, initiator, other)).map((request) => ({ rkey: request.rkey, cid: request.cid })), before.requests, "no new request record exists in the other participant's inbox");
  assert.deepEqual(await dmcHalfUris(this, other), [], "the other participant gained no half either");
});


Given("an initiator chooses a group of participants", async function (this: AppWorld) {
  const [initiator, first, second] = await Promise.all([this.actor("initiator", 0), this.actor("first", 1), this.actor("second", 0)]);
  await Promise.all([initiator, first, second].map((actor) => dmcConnect(this, actor)));
  await Promise.all([first, second].map((actor) => dmcEnableDms(actor, "everyone")));
  dmcRemember(this, "chosen", [first.did, second.did]);
  dmcRemember(this, "firstMessages", ["group hello", "group second"]);
});

/** The group's three people after each invited participant has accepted and replied from their own PDS. */
async function dmcGroupReplies(world: AppWorld): Promise<{ people: Actor[]; convKey: string; participants: string[]; texts: string[] }> {
  const initiator = dmcActor(world, "initiator");
  const invited = [dmcActor(world, "first"), dmcActor(world, "second")];
  for (const member of invited) {
    await dmcReload(member);
    await dmcOpenRequests(member, 1);
    await dmcAcceptRequestFrom(member, initiator.did);
    await dmcSend(member, `reply from ${member.role}`);
  }
  const { convKey, participants } = await dmcOnlyHalf(world, initiator);
  return { people: [initiator, ...invited], convKey, participants, texts: [...dmcRecall<string[]>(world, "firstMessages"), ...invited.map((member) => `reply from ${member.role}`)] };
}

Then("every participant can read every half", async function (this: AppWorld) {
  const { people, convKey, participants, texts } = await dmcGroupReplies(this);
  dmcRemember(this, "group", { convKey, participants });
  dmcRemember(this, "headerCids", Object.fromEntries(await Promise.all(people.map(async (owner) => [owner.did, (await dmcHeaderOf(this, owner, convKey)).cid] as const))));
  for (const owner of people) {
    const members = await dmcMembers(this, owner, dmcHalfOf(owner, convKey));
    const readers = members.filter((member) => member.read).map((member) => member.did).sort();
    assert.deepEqual(readers, participants.filter((did) => did !== owner.did), `every other participant can read ${owner.role}'s half`);
  }
  for (const reader of people) {
    const page = await dmcClientFor(this, reader).readConversation(convKey, participants);
    assert.deepEqual(page.halves, Object.fromEntries(participants.map((did) => [did, "ok"])), `${reader.role} reads all three halves`);
    assert.deepEqual(page.messages.map((message) => message.text).sort(), [...texts].sort(), `${reader.role} sees every participant's messages`);
  }
  for (const person of people) {
    await dmcSync(person);
    for (const text of texts) await dmcCard(person, text).waitFor({ state: "visible" });
    assert.deepEqual((await dmcRoster(person)).map((row) => row.chip), ["", "", ""], `${person.role}'s view shows no missing, left or revoked half`);
  }
});

Then("only each half's owner can write to it", async function (this: AppWorld) {
  const { convKey } = dmcRecall<{ convKey: string }>(this, "group");
  const people = ["initiator", "first", "second"].map((role) => dmcActor(this, role));
  const intrusions: string[] = [];
  for (const owner of people) {
    const half = dmcHalfOf(owner, convKey);
    const members = await dmcMembers(this, owner, half);
    assert.deepEqual(members.filter((member) => member.write), [], `${owner.role}'s member list grants no one write access`);
    assert.deepEqual(await dmcWriters(this, owner, owner, half), [owner.did], `before any intrusion only ${owner.role} is a tracked writer of the half`);
    for (const intruder of people.filter((person) => person !== owner)) {
      const text = `intrusion by ${intruder.role} into ${owner.role}`;
      const written = await this.pdsPost(intruder, "com.atproto.space.putRecord", {
        space: half, repo: intruder.did, collection: "org.slack.dm.message", rkey: tidNow(),
        record: { $type: "org.slack.dm.message", text, createdAt: new Date().toISOString() },
      });
      assert.equal(written.status, 200, `the intruder's own PDS stores the record in the intruder's repo: ${JSON.stringify(written.body)}`);
      assert.deepEqual(await dmcWriters(this, intruder, owner, half), [owner.did], `${owner.role}'s half still tracks only its owner as a writer after ${intruder.role} wrote`);
      intrusions.push(text);
    }
  }
  for (const reader of people) {
    const { messages } = await dmcClientFor(this, reader).readConversation(convKey, dmcRecall<{ participants: string[] }>(this, "group").participants);
    assert.equal(messages.filter((message) => intrusions.includes(message.text)).length, 0, `${reader.role} sees none of the intruders' records`);
  }
  const viewer = people[0]!;
  const sentinels = people.map((person) => `after the intrusions, from ${person.role}`);
  for (const [index, person] of people.entries()) await dmcSend(person, sentinels[index]!);
  await dmcSync(viewer);
  for (const text of ["group hello", ...sentinels]) await dmcCard(viewer, text).waitFor({ state: "visible" });
  for (const text of intrusions) assert.equal(await dmcCard(viewer, text).count(), 0, `${text} is not on the viewer's page, which has read every half since it was written`);
  assert.equal(await viewer.page.getByText(/intrusion by/).count(), 0, "no intruder text appears anywhere on the viewer's page");
});

Then("the participant set never changes", async function (this: AppWorld) {
  const { convKey, participants } = dmcRecall<{ convKey: string; participants: string[] }>(this, "group");
  const headerCids = dmcRecall<Record<string, string>>(this, "headerCids");
  const people = ["initiator", "first", "second"].map((role) => dmcActor(this, role));
  for (const owner of people) {
    const header = await dmcHeaderOf(this, owner, convKey);
    assert.deepEqual(header.value.participants, participants, `${owner.role}'s header names the original participants`);
    assert.equal(header.cid, headerCids[owner.did], `${owner.role}'s header was not rewritten by later activity`);
    const members = await dmcMembers(this, owner, dmcHalfOf(owner, convKey));
    assert.ok(members.every((member) => participants.includes(member.did) && member.did !== owner.did), `${owner.role}'s half admits no one outside the participant set`);
  }
  const initiator = people[0]!;
  assert.deepEqual((await dmcRoster(initiator)).map((row) => row.did).sort(), participants, "the open conversation lists exactly the original participants");
  const buttons = await initiator.page.getByRole("button").allInnerTexts();
  assert.deepEqual(buttons.filter((name) => /\b(add|invite)\b/i.test(name)), [], "the conversation offers no way to add a participant");

  const newcomer = await this.actor("newcomer", 1);
  await dmcStartConversation(initiator, [...participants.filter((did) => did !== initiator.did), newcomer.did]);
  const halves = await dmcHalfUris(this, initiator);
  assert.equal(halves.length, 2, "adding a person starts a second conversation");
  const [replacement] = halves.map(dmcConvKeyOf).filter((key) => key !== convKey);
  assert.deepEqual((await dmcHeaderOf(this, initiator, replacement!)).value.participants, [...participants, newcomer.did].sort());
  const original = await dmcHeaderOf(this, initiator, convKey);
  assert.deepEqual(original.value.participants, participants, "the original conversation keeps its participant set");
  assert.equal(original.cid, headerCids[initiator.did]);
});

Given("an initiator chooses 100 participants including themselves", { timeout: 300_000 }, async function (this: AppWorld) {
  const [initiator, recipient] = await Promise.all([this.actor("initiator", 0), this.actor("recipient", 1)]);
  await Promise.all([dmcConnect(this, initiator), dmcConnect(this, recipient)]);
  await dmcEnableDms(recipient, "everyone");
  const bulk = await dmcOpenInboxAccounts(this, 99, "bulk");
  const invited = bulk.slice(0, 98);
  const chosen = [recipient.did, ...invited.map((account) => account.did)];
  assert.equal(chosen.length + 1, 100, "the initiator plus the chosen participants make 100");
  dmcRemember(this, "chosen", chosen);
  dmcRemember(this, "firstMessages", []);
  dmcRemember(this, "invited", invited);
  dmcRemember(this, "beyondTheBound", bulk[98]!);
});

Then("the conversation is created", async function (this: AppWorld) {
  const initiator = dmcActor(this, "initiator");
  const recipient = dmcActor(this, "recipient");
  const chosen = dmcRecall<string[]>(this, "chosen");
  const rows = await dmcDeliveryRows(initiator);
  assert.deepEqual(rows.map((row) => row.did).sort(), [...chosen].sort(), "the delivery results list all 99 other participants");
  assert.deepEqual([...new Set(rows.map((row) => row.outcome))], ["delivered"], "every request was delivered");

  const { convKey, participants } = await dmcOnlyHalf(this, initiator);
  assert.deepEqual(participants, [initiator.did, ...chosen].sort(), "the header names all 100 participants");
  const members = await dmcMembers(this, initiator, dmcHalfOf(initiator, convKey));
  assert.equal(members.length, 99);
  assert.ok(members.every((member) => member.read && !member.write), "the 99 others can read the initiator's half and cannot write to it");

  const recipients = [recipient, ...dmcRecall<FixtureAccount[]>(this, "invited")];
  const requests = await Promise.all(recipients.map((account) => dmcRequestsFrom(this, initiator, account)));
  for (const [index, found] of requests.entries()) {
    assert.deepEqual(found.map((request) => request.rkey), [convKey], `${recipients[index]!.handle} has the request in their inbox`);
    assert.deepEqual(found[0]!.value.participants, participants);
  }

  await dmcReload(recipient);
  await dmcOpenRequests(recipient, 1);
  await dmcRequestRow(recipient, initiator.did).getByText(/100 participants/).waitFor({ state: "visible" });
});

Then("a request naming 101 participants is rejected", { timeout: 300_000 }, async function (this: AppWorld) {
  const initiator = dmcActor(this, "initiator");
  const recipient = dmcActor(this, "recipient");
  const chosen = dmcRecall<string[]>(this, "chosen");
  const beyond = dmcRecall<FixtureAccount>(this, "beyondTheBound");
  const tooMany = [...chosen, beyond.did];

  await initiator.page.getByRole("button", { name: /New message/ }).click();
  await initiator.page.getByLabel("Participant DIDs").fill(tooMany.join(", "));
  await initiator.page.getByText("101 participants including you.").waitFor({ state: "visible" });
  await initiator.page.getByText("Pick between 1 and 99 other participants.").waitFor({ state: "visible" });
  assert.equal(await initiator.page.getByRole("button", { name: "Start conversation" }).isDisabled(), true, "the app will not start a 101-person conversation");
  await assert.rejects(dmcClientFor(this, initiator).startConversation(tooMany), RangeError, "the DM engine refuses 101 participants");
  assert.equal((await dmcHalfUris(this, initiator)).length, 1, "no second conversation was created");

  const convKey = tidNow();
  const participants = [initiator.did, ...tooMany].sort();
  assert.equal(participants.length, 101);
  const hostile = await this.pdsPost(initiator, "com.atproto.space.putRecord", {
    space: dmcInboxOf(recipient), repo: initiator.did, collection: "org.slack.dm.request", rkey: convKey, validate: false,
    record: { $type: "org.slack.dm.request", convKey, participants, createdAt: new Date().toISOString() },
  });
  assert.equal(hostile.status, 200, `the PDS stores the oversized request when the sender skips lexicon validation: ${JSON.stringify(hostile.body)}`);
  const inSendersRepo = (await dmcRequestsFrom(this, initiator, recipient)).find((request) => request.rkey === convKey);
  assert.equal(inSendersRepo?.value.participants.length, 101, "the 101-participant request is in the sender's repo, scoped to the recipient's inbox");
  const served = await dmcRequestsServedTo(this, recipient, initiator);
  assert.deepEqual(served.map((request) => request.value.participants.length).sort(), [100, 101], "and the recipient's own credential is served both the 100- and the 101-participant request");

  await dmcReload(recipient);
  await dmcOpenRequests(recipient, 1);
  await dmcRequestRow(recipient, initiator.did).getByText(/100 participants/).waitFor({ state: "visible" });
  assert.equal(await recipient.page.getByText(/101 participants/).count(), 0, "the oversized request is not offered to the recipient");
  assert.equal(await recipient.page.getByRole("button", { name: /Requests \(1\)/ }).count(), 1, "the folder lists one request, not two");
  const scan = await dmcClientFor(this, recipient).scanRequests();
  assert.deepEqual(scan.requests.map((request) => request.participants.length), [100], "the recipient's own scan lists only the 100-participant request although it was served both");
});

/** Two accounts with a conversation the first started and the second accepted, the first's messages already fetched by the second. */
async function dmcConversationOfTwo(
  world: AppWorld, roles: { starter: string; replier: string }, hosts: [0 | 1, 0 | 1], starterTexts: string[],
): Promise<{ starter: Actor; replier: Actor; convKey: string }> {
  const [starter, replier] = await Promise.all([world.actor(roles.starter, hosts[0]), world.actor(roles.replier, hosts[1])]);
  await Promise.all([dmcConnect(world, starter), dmcConnect(world, replier)]);
  await dmcEnableDms(replier, "everyone");
  await dmcStartConversation(starter, [replier.did]);
  await dmcOpenStartedConversation(starter);
  for (const text of starterTexts) await dmcSend(starter, text);
  await dmcReloadAndAcceptFrom(replier, starter.did);
  for (const text of starterTexts) await dmcCard(replier, text).waitFor({ state: "visible" });
  return { starter, replier, convKey: (await dmcOnlyHalf(world, starter)).convKey };
}

Given("a participant authored a DM message", async function (this: AppWorld) {
  const { convKey } = await dmcConversationOfTwo(this, { starter: "author", replier: "reader" }, [0, 0], ["draft to edit", "draft to delete"]);
  dmcRemember(this, "convKey", convKey);
});

When("they edit or delete it", async function (this: AppWorld) {
  const channelAction = this.scratch.get("editOrDelete") as (() => Promise<void>) | undefined;
  if (channelAction) return channelAction();
  const author = dmcActor(this, "author");
  await dmcEditMessage(author, "draft to edit", "edited draft");
  await dmcDeleteMessage(author, "draft to delete");
});

Then("every reader shows the change", async function (this: AppWorld) {
  const author = dmcActor(this, "author");
  const reader = dmcActor(this, "reader");
  const convKey = dmcRecall<string>(this, "convKey");
  const stored = await dmcMessagesOf(this, author, convKey);
  assert.deepEqual(stored.map((message) => message.value.text), ["edited draft"], "the author's repo holds the edit and no longer holds the deleted message");
  const page = await dmcClientFor(this, reader).readConversation(convKey, [author.did, reader.did].sort());
  assert.deepEqual(page.messages.map((message) => message.text), ["edited draft"], "a fresh read by the other participant shows the change");
  for (const viewer of [author, reader]) {
    await dmcSync(viewer);
    await dmcCard(viewer, "edited draft").waitFor({ state: "visible" });
    assert.equal(await dmcCard(viewer, "draft to edit").count(), 0, `${viewer.role} still shows the text before the edit`);
    assert.equal(await dmcCard(viewer, "draft to delete").count(), 0, `${viewer.role} still shows the deleted message`);
  }
});

Then("another participant cannot edit it because the record lives in its author's repo", async function (this: AppWorld) {
  const author = dmcActor(this, "author");
  const reader = dmcActor(this, "reader");
  const convKey = dmcRecall<string>(this, "convKey");
  const half = dmcHalfOf(author, convKey);
  const [message] = await dmcMessagesOf(this, author, convKey);
  const uri = dmcMessageUri(author, convKey, message!.rkey);

  await dmcReload(reader);
  await dmcOpenOnlyConversation(reader);
  await dmcReload(author);
  await dmcOpenOnlyConversation(author);
  const readerButtons = await dmcCard(reader, "edited draft").getByRole("button").allInnerTexts();
  const authorButtons = await dmcCard(author, "edited draft").getByRole("button").allInnerTexts();
  assert.deepEqual(readerButtons.filter((name) => /^(Edit|Delete)$/.test(name)), [], "the reader is offered no way to edit or delete the author's message");
  assert.deepEqual(authorButtons.filter((name) => /^(Edit|Delete)$/.test(name)), ["Edit", "Delete"], "the author is offered both");

  await assert.rejects(dmcClientFor(this, reader).edit(uri, "forged edit"), /Can only modify your own DM messages/);
  await assert.rejects(dmcClientFor(this, reader).delete(uri), /Can only modify your own DM messages/);

  const granted = await this.pdsPost(author, "com.atproto.simplespace.putMember", { space: half, did: reader.did, read: true, write: true });
  assert.equal(granted.status, 200, "the reader is even given write access to the author's half, so only the repo boundary can stop the edit");
  const forged = { space: half, repo: author.did, collection: "org.slack.dm.message", rkey: message!.rkey };
  const edit = await this.pdsPost(reader, "com.atproto.space.putRecord", {
    ...forged, record: { $type: "org.slack.dm.message", text: "forged edit", createdAt: message!.value.createdAt },
  });
  assert.deepEqual({ status: edit.status, message: edit.body.message }, { status: 403, message: "repo must match authenticated user" });
  const removal = await this.pdsPost(reader, "com.atproto.space.deleteRecord", forged);
  assert.deepEqual({ status: removal.status, message: removal.body.message }, { status: 403, message: "repo must match authenticated user" });

  const own = await this.pdsPost(reader, "com.atproto.space.putRecord", {
    space: half, repo: reader.did, collection: "org.slack.dm.message", rkey: message!.rkey,
    record: { $type: "org.slack.dm.message", text: "forged edit", createdAt: message!.value.createdAt },
  });
  assert.equal(own.status, 200);
  assert.equal(own.body.uri, `${half}/${reader.did}/org.slack.dm.message/${message!.rkey}`, "the only place the reader can write that key is the reader's own repo");
  assert.notEqual(own.body.uri, uri);
  const [after] = await dmcMessagesOf(this, author, convKey);
  assert.deepEqual({ text: after!.value.text, cid: after!.cid }, { text: "edited draft", cid: message!.cid }, "the author's record is untouched");
});

// --- Reactions ---------------------------------------------------------------------------------------

const DMC_CHANGE_TEXT = "message to change";
const DMC_REMOVE_TEXT = "message to remove";

Given("a participant reacts to a DM message with an emoji", async function (this: AppWorld) {
  const { starter, replier, convKey } = await dmcConversationOfTwo(this, { starter: "author", replier: "reader" }, [0, 1], [DMC_CHANGE_TEXT, DMC_REMOVE_TEXT]);
  const messages = await dmcMessagesOf(this, starter, convKey);
  const uriOf = (text: string) => dmcMessageUri(starter, convKey, messages.find((message) => message.value.text === text)!.rkey);
  const subjects = { change: uriOf(DMC_CHANGE_TEXT), remove: uriOf(DMC_REMOVE_TEXT) };
  for (const text of [DMC_CHANGE_TEXT, DMC_REMOVE_TEXT]) {
    await dmcCard(replier, text).getByRole("button", { name: "💜 0", exact: true }).click();
    await dmcCard(replier, text).getByRole("button", { name: "💜 1", exact: true }).waitFor({ state: "visible" });
  }
  const reactions = await dmcRecords<DmcReaction>(this, replier, { space: dmcHalfOf(replier, convKey), repo: replier.did, collection: "org.slack.dm.reaction" });
  assert.deepEqual(reactions.map((reaction) => reaction.rkey).sort(), [subjects.change, subjects.remove].map((subject) => reactionRecordKey(subject, "💜", replier.did)).sort());
  dmcRemember(this, "convKey", convKey);
  dmcRemember(this, "subjects", subjects);
});

When("they change or remove that reaction", async function (this: AppWorld) {
  const reader = dmcActor(this, "reader");
  const convKey = dmcRecall<string>(this, "convKey");
  const subjects = dmcRecall<{ change: string; remove: string }>(this, "subjects");
  const engine = dmcClientFor(this, reader);
  await engine.react(subjects.change, "👍");
  await engine.unreact(subjects.change, "💜");
  await dmcCard(reader, DMC_REMOVE_TEXT).getByRole("button", { name: "💜 1", exact: true }).click();
  await dmcUntil(async () => (await dmcRecords<DmcReaction>(this, reader, { space: dmcHalfOf(reader, convKey), repo: reader.did, collection: "org.slack.dm.reaction" })).length === 1, "the removed reaction to leave the reader's repo");
});

Then("all readers show only the current reaction record", async function (this: AppWorld) {
  const author = dmcActor(this, "author");
  const reader = dmcActor(this, "reader");
  const convKey = dmcRecall<string>(this, "convKey");
  const subjects = dmcRecall<{ change: string; remove: string }>(this, "subjects");
  const stored = await dmcRecords<DmcReaction>(this, reader, { space: dmcHalfOf(reader, convKey), repo: reader.did, collection: "org.slack.dm.reaction" });
  assert.deepEqual(stored.map((reaction) => ({ rkey: reaction.rkey, subject: reaction.value.subject, emoji: reaction.value.emoji })), [
    { rkey: reactionRecordKey(subjects.change, "👍", reader.did), subject: subjects.change, emoji: "👍" },
  ], "the reader's repo holds exactly the current reaction");
  const page = await dmcClientFor(this, author).readConversation(convKey, [author.did, reader.did].sort());
  assert.deepEqual(page.reactions.map((reaction) => ({ ownerDid: reaction.ownerDid, subject: reaction.subject, emoji: reaction.emoji })), [{ ownerDid: reader.did, subject: subjects.change, emoji: "👍" }]);
  for (const viewer of [author, reader]) {
    await dmcSync(viewer);
    await dmcCard(viewer, DMC_CHANGE_TEXT).getByRole("button", { name: "👍 1", exact: true }).waitFor({ state: "visible" });
    assert.equal(await dmcCard(viewer, DMC_CHANGE_TEXT).getByRole("button", { name: "💜 0", exact: true }).count(), 1, `${viewer.role} shows no heart on the changed message`);
    assert.equal(await dmcCard(viewer, DMC_REMOVE_TEXT).getByRole("button", { name: "💜 0", exact: true }).count(), 1, `${viewer.role} shows no reaction on the unreacted message`);
  }
});

Then("a reaction whose subject is a message in another conversation is ignored", async function (this: AppWorld) {
  const author = dmcActor(this, "author");
  const reader = dmcActor(this, "reader");
  const convKey = dmcRecall<string>(this, "convKey");
  const subjects = dmcRecall<{ change: string; remove: string }>(this, "subjects");
  const third = await this.actor("third", 1);
  const elsewhere = await dmcClientFor(this, author).startConversation([third.did]);
  assert.notEqual(elsewhere.convKey, convKey);
  const foreignMessage = await dmcClientFor(this, author).send(elsewhere.convKey, "said somewhere else");

  const half = dmcHalfOf(reader, convKey);
  const putReaction = (subject: string, emoji: string) => this.pdsPost(reader, "com.atproto.space.putRecord", {
    space: half, repo: reader.did, collection: "org.slack.dm.reaction", rkey: reactionRecordKey(subject, emoji, reader.did),
    record: { $type: "org.slack.dm.reaction", subject, emoji, createdAt: new Date().toISOString() },
  });
  assert.equal((await putReaction(foreignMessage.uri, "💜")).status, 200, "the PDS stores the reaction aimed at another conversation");
  assert.equal((await putReaction(subjects.change, "🔥")).status, 200, "a same-shaped reaction aimed at this conversation is stored too");
  const stored = await dmcRecords<DmcReaction>(this, reader, { space: half, repo: reader.did, collection: "org.slack.dm.reaction" });
  assert.deepEqual(stored.map((reaction) => reaction.value.subject).sort(), [foreignMessage.uri, subjects.change, subjects.change].sort(), "all three records exist on the reader's PDS");

  const page = await dmcClientFor(this, author).readConversation(convKey, [author.did, reader.did].sort());
  assert.deepEqual(page.reactions.map((reaction) => `${reaction.subject} ${reaction.emoji}`).sort(), [`${subjects.change} 🔥`, `${subjects.change} 👍`].sort(), "the engine reads the in-conversation reactions and ignores the foreign one");
  await dmcSync(author);
  await dmcCard(author, DMC_CHANGE_TEXT).getByRole("button", { name: "🔥 1", exact: true }).waitFor({ state: "visible" });
});

// --- Leaving and deleting ----------------------------------------------------------------------------

Given("a participant wants to stop sharing their messages", async function (this: AppWorld) {
  const { starter, replier, convKey } = await dmcConversationOfTwo(this, { starter: "stayer", replier: "leaver" }, [0, 1], ["words from the stayer"]);
  await dmcSend(replier, "words from the leaver");
  await dmcSync(starter);
  await dmcCard(starter, "words from the leaver").waitFor({ state: "visible" });
  assert.deepEqual((await dmcMembers(this, replier, dmcHalfOf(replier, convKey))).map((member) => ({ did: member.did, read: member.read })), [{ did: starter.did, read: true }]);
  dmcRemember(this, "convKey", convKey);
});

When("they remove the other participants from their half", async function (this: AppWorld) {
  const leaver = dmcActor(this, "leaver");
  const convKey = dmcRecall<string>(this, "convKey");
  await leaver.page.getByRole("button", { name: "Leave conversation" }).click();
  await leaver.page.getByRole("button", { name: "Confirm leave" }).click();
  await dmcUntil(async () => (await dmcMembers(this, leaver, dmcHalfOf(leaver, convKey))).length === 0, "the leaver's member list to be emptied");
});

Then("new credentials for that half are refused", async function (this: AppWorld) {
  const stayer = dmcActor(this, "stayer");
  const leaver = dmcActor(this, "leaver");
  const convKey = dmcRecall<string>(this, "convKey");
  assert.deepEqual(await dmcMembers(this, leaver, dmcHalfOf(leaver, convKey)), [], "the leaver's half lists no member");
  assert.deepEqual(await dmcMint(this, stayer, dmcHalfOf(leaver, convKey)), { minted: false, status: 403, code: "UserNotAuthorized" });
  const page = await dmcClientFor(this, stayer).readConversation(convKey, [stayer.did, leaver.did].sort());
  assert.equal(page.halves[leaver.did], "revoked");
  assert.deepEqual(page.messages.map((message) => message.text), ["words from the stayer"], "the leaver's words are no longer readable");

  await dmcReload(stayer);
  await dmcOpenOnlyConversation(stayer);
  await stayer.page.getByText("revoked your access", { exact: true }).waitFor({ state: "visible" });
  await dmcCard(stayer, "words from the stayer").waitFor({ state: "visible" });
  assert.equal(await dmcCard(stayer, "words from the leaver").count(), 0, "the stayer's view no longer shows the leaver's words");
  assert.equal((await dmcMessagesOf(this, leaver, convKey)).length, 1, "leaving revokes access without deleting the leaver's own records");
});

Then("the other participants keep their own halves", async function (this: AppWorld) {
  const stayer = dmcActor(this, "stayer");
  const leaver = dmcActor(this, "leaver");
  const convKey = dmcRecall<string>(this, "convKey");
  assert.deepEqual(await dmcHalfUris(this, stayer), [dmcHalfOf(stayer, convKey)], "the stayer's half still exists");
  assert.deepEqual(await dmcMembers(this, stayer, dmcHalfOf(stayer, convKey)), [{ did: leaver.did, read: true, write: false }], "the stayer's member list is untouched");
  assert.deepEqual((await dmcMessagesOf(this, stayer, convKey)).map((message) => message.value.text), ["words from the stayer"]);
  const page = await dmcClientFor(this, leaver).readConversation(convKey, [stayer.did, leaver.did].sort());
  assert.equal(page.halves[stayer.did], "ok", "the leaver can still read the stayer's half");
});

Given("a participant wants to unsend every message", async function (this: AppWorld) {
  const { starter, replier, convKey } = await dmcConversationOfTwo(this, { starter: "unsender", replier: "keeper" }, [0, 1], ["unsend one", "unsend two"]);
  await dmcSend(replier, "keeper reply");
  assert.equal((await dmcMessagesOf(this, starter, convKey)).length, 2, "the unsender has two messages on their PDS");
  dmcRemember(this, "convKey", convKey);
});

When("they delete their half", async function (this: AppWorld) {
  const unsender = dmcActor(this, "unsender");
  const sidebarEntry = unsender.page.locator(".channel-nav-item", { hasText: "◈" });
  await sidebarEntry.waitFor({ state: "visible" });
  await unsender.page.getByRole("button", { name: "Delete everything I sent" }).click();
  await unsender.page.getByRole("button", { name: "Confirm delete everything" }).click();
  await sidebarEntry.waitFor({ state: "detached" });
  await dmcUntil(async () => (await dmcHalfUris(this, unsender)).length === 0, "the unsender's half to be deleted");
});

Then("their messages are gone from their own PDS", async function (this: AppWorld) {
  const unsender = dmcActor(this, "unsender");
  const keeper = dmcActor(this, "keeper");
  const convKey = dmcRecall<string>(this, "convKey");
  const half = dmcHalfOf(unsender, convKey);
  assert.deepEqual(await dmcHalfUris(this, unsender), []);
  const space = await this.pdsGet(unsender, "com.atproto.simplespace.getSpace", { space: half });
  assert.deepEqual({ status: space.status, error: space.body.error }, { status: 400, error: "SpaceNotFound" });
  assert.deepEqual(await dmcMessagesOf(this, unsender, convKey), [], "no message record remains in the deleted half");
  const page = await dmcClientFor(this, keeper).readConversation(convKey, [unsender.did, keeper.did].sort());
  assert.equal(page.halves[unsender.did], "deleted");
  assert.deepEqual(page.messages.map((message) => message.text), ["keeper reply"], "a fresh read finds only the keeper's own words");
  assert.equal(await unsender.page.locator(".channel-nav-item", { hasText: "◈" }).count(), 0, "the unsender's sidebar lists no conversation");
});

Then("copies other participants already fetched are not recalled", async function (this: AppWorld) {
  const keeper = dmcActor(this, "keeper");
  const unsender = dmcActor(this, "unsender");
  const chipOf = (viewer: Actor) => async () => (await dmcRoster(viewer)).find((row) => row.did === unsender.did)?.chip;
  await dmcSync(keeper);
  await dmcUntil(async () => await chipOf(keeper)() === "left", "the keeper's live page to show the unsender as having left after a sync");
  for (const text of ["unsend one", "unsend two"]) await dmcCard(keeper, text).waitFor({ state: "visible" });

  const fresh: Actor = { ...keeper, page: await keeper.context.newPage() };
  fresh.page.setDefaultTimeout(30_000);
  await fresh.page.goto(this.appOrigin);
  await fresh.page.getByRole("button", { name: /New message/ }).waitFor({ state: "visible", timeout: 60_000 });
  await dmcOpenOnlyConversation(fresh);
  await dmcUntil(async () => await chipOf(fresh)() === "left", "a freshly opened page of the keeper to show the unsender as having left");
  await dmcCard(fresh, "keeper reply").waitFor({ state: "visible" });
  for (const text of ["unsend one", "unsend two"]) assert.equal(await dmcCard(fresh, text).count(), 0, `a page that never fetched "${text}" cannot get it back`);
  for (const text of ["unsend one", "unsend two"]) assert.equal(await dmcCard(keeper, text).count(), 1, `the keeper's original page still shows the copy of "${text}"`);
});

// --- Requests live in the recipient's own inbox ---------------------------------------------------------

/** A sender on one PDS who has started a conversation with a recipient on the other, whose inbox accepts anyone. */
async function dmcSenderWritesRequest(world: AppWorld): Promise<{ sender: Actor; recipient: Actor; convKey: string }> {
  const [sender, recipient] = await Promise.all([world.actor("sender", 0), world.actor("recipient", 1)]);
  await Promise.all([dmcConnect(world, sender), dmcConnect(world, recipient)]);
  await dmcEnableDms(recipient, "everyone");
  await dmcStartConversation(sender, [recipient.did]);
  await dmcOpenStartedConversation(sender);
  await dmcSend(sender, "hello from the sender");
  const requests = await dmcRequestsFrom(world, sender, recipient);
  assert.equal(requests.length, 1, "the sender's repo holds one request scoped to the recipient's inbox");
  return { sender, recipient, convKey: requests[0]!.rkey };
}

Given("a sender wrote a request in their own repo scoped to the recipient's inbox", async function (this: AppWorld) {
  const { recipient, convKey } = await dmcSenderWritesRequest(this);
  const traffic = dmcTrafficOf(this, recipient);
  dmcRemember(this, "convKey", convKey);
  dmcRemember(this, "mark", { requests: traffic.requests.length, spaceReads: traffic.spaceReads.length });
});

When("the recipient's client scans the writers of its own inbox", async function (this: AppWorld) {
  const recipient = dmcActor(this, "recipient");
  await dmcReload(recipient);
  await dmcOpenRequests(recipient, 1);
});

Then("the recipient reads the request from the sender's repo", async function (this: AppWorld) {
  const sender = dmcActor(this, "sender");
  const recipient = dmcActor(this, "recipient");
  const convKey = dmcRecall<string>(this, "convKey");
  const mark = dmcRecall<{ spaceReads: number }>(this, "mark");
  const traffic = dmcTrafficOf(this, recipient);
  const reads = (host: FixtureAccount, method: string) => traffic.spaceReads.slice(mark.spaceReads).filter((read) => {
    const url = new URL(read.url);
    return url.origin === new URL(host.pdsUrl).origin && url.pathname === `/xrpc/com.atproto.space.${method}` && url.searchParams.get("space") === dmcInboxOf(recipient);
  });

  const writerListing = await dmcUntil(async () => reads(recipient, "listRepos")[0], "the recipient's browser to list the writers of its inbox on its own PDS");
  assert.deepEqual((JSON.parse(writerListing.body!) as { repos: Array<{ did: string }> }).repos.map((repo) => repo.did), [sender.did], "its own PDS tracks the sender as a writer");

  const senderRead = await dmcUntil(async () => reads(sender, "listRecords").find((read) => new URL(read.url).searchParams.get("repo") === sender.did), "the recipient's browser to read the sender's repo on the sender's PDS");
  assert.equal(senderRead.status, 200);
  const served = (JSON.parse(senderRead.body!) as { records: Array<{ rkey: string; value: { convKey: string; participants: string[] } }> }).records;
  assert.deepEqual(served.map((record) => record.rkey), [convKey]);
  assert.deepEqual(served[0]!.value.participants, [sender.did, recipient.did].sort());

  await dmcRequestRow(recipient, sender.did).waitFor({ state: "visible" });
  const copy = await this.pdsGet(recipient, "com.atproto.space.listRecords", { space: dmcInboxOf(recipient), repo: sender.did, collection: "org.slack.dm.request" });
  assert.deepEqual({ status: copy.status, error: copy.body.error }, { status: 400, error: "RepoNotFound" }, "the recipient's PDS holds no copy of the request");
});

Then("no app server is asked for the request", async function (this: AppWorld) {
  const sender = dmcActor(this, "sender");
  const recipient = dmcActor(this, "recipient");
  const convKey = dmcRecall<string>(this, "convKey");
  const appCalls = dmcTrafficOf(this, recipient).requests.filter((request) => new URL(request.url).origin === this.appOrigin && new URL(request.url).pathname.startsWith("/api/"));
  assert.ok(appCalls.length > 0, "the recipient's browser did talk to the app server");
  const exchanged = [
    ...appCalls.map((request) => `${request.url}\n${request.postData}`),
    ...recipient.calls.map((call) => `${call.path}\n${call.requestBody}\n${call.responseBody}`),
  ].join("\n");
  for (const needle of [convKey, sender.did, "org.slack.dm.request"]) assert.ok(!exchanged.includes(needle), `no /api exchange of the recipient mentions ${needle}`);
  const stored = dmcAppDatabaseText(this);
  for (const needle of ["org.slack.dm.request", '"participants"']) assert.ok(!stored.includes(needle), `the app's database holds no request: it contains no ${needle}`);
  const mentions = dmcAppDatabaseMentions(this, convKey);
  assert.deepEqual(
    [...new Set(mentions.map(({ table, column }) => `${table}.${column}`))].filter((place) => place !== "space_notification.space_uri"), [],
    "the only place the app's database mentions the conversation key is the notified space URI of a space write notification",
  );
  for (const mention of mentions) assert.equal(mention.value, dmcHalfOf(sender, convKey), "that mention is the sender's own half URI as notified, not a request record");
});

Given("a recipient found a request", async function (this: AppWorld) {
  const { sender, recipient, convKey } = await dmcSenderWritesRequest(this);
  await dmcReload(recipient);
  await dmcOpenRequests(recipient, 1);
  await dmcRequestRow(recipient, sender.did).waitFor({ state: "visible" });
  dmcRemember(this, "convKey", convKey);
});

When("they reply", async function (this: AppWorld) {
  const recipient = dmcActor(this, "recipient");
  await dmcAcceptRequestFrom(recipient, dmcActor(this, "sender").did);
  await dmcSend(recipient, "reply from the recipient");
});

Then("a half with the same conversation key and participants is created on their own PDS", async function (this: AppWorld) {
  const sender = dmcActor(this, "sender");
  const recipient = dmcActor(this, "recipient");
  const convKey = dmcRecall<string>(this, "convKey");
  assert.deepEqual(await dmcHalfUris(this, recipient), [dmcHalfOf(recipient, convKey)]);
  const requested = await dmcHeaderOf(this, sender, convKey);
  const created = await dmcHeaderOf(this, recipient, convKey);
  assert.deepEqual({ convKey: created.value.convKey, participants: created.value.participants }, { convKey, participants: requested.value.participants });
  assert.deepEqual(await dmcMembers(this, recipient, dmcHalfOf(recipient, convKey)), [{ did: sender.did, read: true, write: false }], "the sender can read the new half");
  assert.deepEqual((await dmcMessagesOf(this, recipient, convKey)).map((message) => message.value.text), ["reply from the recipient"]);
});

Then("the requester is added to the recipient's allowlist", async function (this: AppWorld) {
  const sender = dmcActor(this, "sender");
  const recipient = dmcActor(this, "recipient");
  assert.deepEqual(await dmcMembers(this, recipient, dmcInboxOf(recipient)), [{ did: sender.did, read: false, write: true }]);
  await dmcOpenSettings(recipient);
  assert.deepEqual(await dmcAllowlistShown(recipient), [sender.did], "the settings screen lists the requester on the allowlist");
});

Then("later conversations from that requester are not blocked", async function (this: AppWorld) {
  const sender = dmcActor(this, "sender");
  const recipient = dmcActor(this, "recipient");
  const stranger = await this.actor("stranger", 0);
  const third = await this.actor("third", 1);
  await dmcOpenSettings(recipient);
  await dmcSetMode(recipient, "allowlist");
  await dmcStartConversation(sender, [recipient.did, third.did]);
  const strangerStart = await dmcClientFor(this, stranger).startConversation([recipient.did]);
  assert.equal(strangerStart.delivery[recipient.did]?.status, "delivered", "the stranger's write is accepted by their own PDS");

  assert.deepEqual(await dmcWriters(this, recipient, recipient, dmcInboxOf(recipient)), [sender.did], "the recipient's PDS tracks the requester and refuses the stranger");
  await dmcReload(recipient);
  await dmcOpenRequests(recipient, 1);
  await dmcRequestRow(recipient, sender.did).getByText(/3 participants/).waitFor({ state: "visible" });
  assert.equal(await dmcRequestRow(recipient, stranger.did).count(), 0, "the stranger's request is not offered");
  const found = await dmcClientFor(this, recipient).listRequests();
  assert.deepEqual(found.map((request) => [request.sender, request.participants.length]), [[sender.did, 3]]);
});

When("they ignore or hide it", async function (this: AppWorld) {
  const recipient = dmcActor(this, "recipient");
  await dmcRequestRow(recipient, dmcActor(this, "sender").did).getByRole("button", { name: "Hide", exact: true }).click();
  await recipient.page.getByRole("button", { name: /Requests \(0\)/ }).waitFor({ state: "visible" });
});

Then("no half is created", async function (this: AppWorld) {
  const recipient = dmcActor(this, "recipient");
  assert.deepEqual(await dmcHalfUris(this, recipient), [], "the recipient hosts no conversation half");
  assert.deepEqual(await dmcClientFor(this, recipient).listConversations(), []);
  assert.equal(await recipient.page.locator(".channel-nav-item", { hasText: "◈" }).count(), 0, "the recipient's sidebar lists no conversation");
});

Then("the sender gains no read access", async function (this: AppWorld) {
  const sender = dmcActor(this, "sender");
  const recipient = dmcActor(this, "recipient");
  const convKey = dmcRecall<string>(this, "convKey");
  assert.deepEqual(await dmcMint(this, sender, dmcHalfOf(recipient, convKey)), { minted: false, status: 404, code: "SpaceNotFound" }, "there is no recipient half for the sender to read");
  assert.deepEqual(await dmcMint(this, sender, dmcInboxOf(recipient)), { minted: false, status: 403, code: "UserNotAuthorized" }, "the sender cannot read the recipient's inbox");
  assert.deepEqual((await dmcMembers(this, recipient, dmcInboxOf(recipient))).filter((member) => member.read), [], "no one but the owner can read the inbox");
  const page = await dmcClientFor(this, sender).readConversation(convKey, [sender.did, recipient.did].sort());
  assert.equal(page.halves[recipient.did], "missing");
  assert.deepEqual(page.messages.map((message) => message.text), ["hello from the sender"]);
  await dmcReload(sender);
  await dmcOpenOnlyConversation(sender);
  await dmcUntil(async () => {
    const chips = new Map((await dmcRoster(sender)).map((row) => [row.did, row.chip]));
    return chips.get(sender.did) === "" && chips.get(recipient.did) === "hasn't replied";
  }, "the sender's view to show that the recipient has not replied");
});
