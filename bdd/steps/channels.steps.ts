import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@playwright/test";
import { reactionRecordKey, spaceRecordUri, tidNow } from "@flock/protocol/keys";
import { PAGE_TIMEOUT_MS, type Actor, type AppWorld } from "../support/world";
import {
  waitForAdminControls, copyInviteLink, createWorkspaceAs, eventually, inviteMemberAs, joinFromInvitation, openInviteLinkAndSignIn, ownerInvites,
} from "../support/ui";
import { browserRecords } from "../support/browser-store";
import { engineAs } from "../support/engine";
import type { Engine } from "@flock/client/engine";
import {
  channelNamed, clickReaction, completedOperationSteps, composer, createChannelAs, deliveredMessage, deliveredReactions, directoryOf,
  credentialCalls, credentialOutcome, grantedCredential, listingCalls, listMembers, messageCard, messageCards, messageCollection, openChannel, ownRecords,
  postMessage, reactionCollection, requestChannelCredential, setUpRoster, settles, sidebarChannel, syncUntil, writeOwnRecords,
  type ChannelRef, type CredentialOutcome, type Member, type Roster,
} from "../support/channels-ui";

const actorNamed = (world: AppWorld, role: string): Actor => {
  const actor = world.actors.get(role);
  assert.ok(actor, `this scenario has no ${role} yet`);
  return actor;
};
const owner = (world: AppWorld): Actor => actorNamed(world, "owner");
const uniqueChannelName = (prefix: string): string => `${prefix} ${Math.random().toString(36).slice(2, 7)}`;
const didsOf = (members: Member[]): string[] => members.map((member) => member.did).sort();

// --- Public channel membership follows workspace membership ----------------------------------------

type PublicationSample = { published: boolean; members: string[] };

/**
 * Samples the new channel as the authority's PDS shows it, in a tight loop that starts before the create is submitted. Each
 * pass reads the directory first and the member list after it, so a pass that sees the entry and then an incomplete member
 * list proves the entry was published first. Passes that see the channel's space but no entry yet show the loop can see
 * the stretch in which members are still being applied.
 */
function watchPublication(world: AppWorld, authority: Actor, name: string, spacesBefore: string[]): { samples: PublicationSample[]; stop(): Promise<void> } {
  const samples: PublicationSample[] = [];
  let running = true;
  const loop = (async () => {
    let space: string | undefined;
    while (running) {
      const entry = (await directoryOf(world, authority)).find((channel) => channel.name === name);
      space ??= entry?.uri ?? (await listChannelSpaces(world, authority)).find((uri) => !spacesBefore.includes(uri));
      if (space) samples.push({ published: entry !== undefined, members: didsOf(await listMembers(world, authority, space)) });
    }
  })();
  return { samples, stop: async () => { running = false; await loop; } };
}

async function listChannelSpaces(world: AppWorld, authority: Actor): Promise<string[]> {
  const listed = await world.pdsGet<{ spaces: Array<{ space: string }> }>(authority, "com.atproto.space.listSpaces", { spaceType: "new.flock.channel", limit: "100" });
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  return listed.body.spaces.map((entry) => entry.space);
}

Given("a workspace has current members", async function (this: AppWorld) {
  const admin = await this.actor("owner");
  await createWorkspaceAs(this, admin);
  await waitForAdminControls(this, admin);
  const invitees = [await this.actor("alice", 1), await this.actor("bob", 0), await this.actor("carol", 1)];
  for (const invitee of invitees) await inviteMemberAs(admin, invitee.did);
  const removed = admin.page.locator(".roster-row").filter({ hasText: actorNamed(this, "carol").did });
  await removed.getByRole("button", { name: "Remove", exact: true }).click();
  await removed.waitFor({ state: "hidden", timeout: 60_000 });
  const members = await listMembers(this, admin, this.workspaceUri);
  assert.deepEqual(didsOf(members), [actorNamed(this, "alice").did, actorNamed(this, "bob").did].sort(), "carol was removed, alice and bob are current");
});

When("an admin creates a public channel", async function (this: AppWorld) {
  const admin = owner(this);
  const name = uniqueChannelName("Launch");
  const watcher = watchPublication(this, admin, name, await listChannelSpaces(this, admin));
  try {
    await createChannelAs(admin, name);
  } finally {
    await watcher.stop();
  }
  this.scratch.set("channelName", name);
  this.scratch.set("publication", watcher.samples);
});

Then("each current workspace member has channel read and write access", async function (this: AppWorld) {
  const admin = owner(this);
  const channel = await channelNamed(this, admin, this.scratch.get("channelName") as string);
  const current = await listMembers(this, admin, this.workspaceUri);
  assert.equal(current.length, 2, "the workspace has two current members");
  const onChannel = await listMembers(this, admin, channel.uri);
  for (const member of current) {
    const entry = onChannel.find((candidate) => candidate.did === member.did);
    assert.deepEqual({ read: entry?.read, write: entry?.write }, { read: true, write: true }, `${member.did} has read and write on the channel`);
  }
  assert.deepEqual(didsOf(onChannel), didsOf(current), "the channel lists exactly the current members: the removed account is not on it");
});

Then("the directory shows the channel as public only after membership is applied", async function (this: AppWorld) {
  const admin = owner(this);
  const name = this.scratch.get("channelName") as string;
  const channel = await channelNamed(this, admin, name);
  assert.equal(channel.visibility, "public");
  const current = didsOf(await listMembers(this, admin, this.workspaceUri));

  const sidebar = await sidebarChannel(admin, name).innerText();
  assert.match(sidebar, /^#/, "the app's own directory view, the sidebar, lists the channel with the public marker");

  const samples = this.scratch.get("publication") as PublicationSample[];
  const published = samples.filter((sample) => sample.published);
  const applying = samples.filter((sample) => !sample.published);
  assert.ok(published.length > 0, "the authority's directory was observed to publish the channel");
  assert.deepEqual(
    published.filter((sample) => sample.members.join() !== current.join()),
    [],
    `every look at the published channel found every current member on its member list already (${samples.length} looks, ${applying.length} before publication; a gap shorter than one look would be missed here, so the journal order below is checked too)`,
  );
  this.log(`publication sampler: ${samples.length} looks, ${applying.length} saw the channel's space before its directory entry`);

  const steps = completedOperationSteps(this, "createChannel", name);
  const directoryStep = steps.indexOf("channel-directory");
  assert.ok(directoryStep >= 0, `the journal records the directory step: ${steps.join(", ")}`);
  for (const did of current) {
    const memberStep = steps.indexOf(`channel-member-${did}`);
    assert.ok(memberStep >= 0 && memberStep < directoryStep, `membership for ${did} was applied before the directory entry (${steps.join(", ")})`);
  }
  assert.ok(steps.indexOf("channel-membership-verified") > directoryStep, "membership is verified after the directory entry is published");
});

// --- Private channels stay behind PDS read authorization -------------------------------------------

Given("a member is absent from a private channel member list", async function (this: AppWorld) {
  const { owner: admin, invitee: outsider } = await ownerInvites(this, "outsider");
  const insider = await this.actor("insider", 0);
  await inviteMemberAs(admin, insider.did);
  const name = uniqueChannelName("Vault");
  await createChannelAs(admin, name, { visibility: "private", members: [insider.did] });
  const channel = await channelNamed(this, admin, name);
  const members = await listMembers(this, admin, channel.uri);
  assert.deepEqual(didsOf(members), [insider.did], "only the insider is on the private channel's member list");

  const link = await copyInviteLink(admin);
  for (const person of [outsider, insider]) {
    await openInviteLinkAndSignIn(this, person, link);
    await joinFromInvitation(person);
  }
  const secret = `secret plans ${Math.random().toString(36).slice(2, 8)}`;
  await openChannel(insider, name);
  await postMessage(insider, secret);
  this.scratch.set("channel", channel);
  this.scratch.set("secret", secret);
});

When("that member opens the channel URI", async function (this: AppWorld) {
  const outsider = actorNamed(this, "outsider");
  const channel = this.scratch.get("channel") as ChannelRef;
  const since = outsider.xrpc.length;
  await openChannel(outsider, channel.name);
  const answers = await eventually(() => credentialCalls(outsider, channel.uri, since).length > 0 && credentialCalls(outsider, channel.uri, since), { what: "the browser's own request for the channel's credential" });
  this.scratch.set("appAnswers", answers.map(credentialOutcome));
  this.scratch.set("credential", await requestChannelCredential(this, outsider, channel.uri));
});

Then("the PDS refuses a channel read credential", async function (this: AppWorld) {
  const outsider = actorNamed(this, "outsider");
  const channel = this.scratch.get("channel") as ChannelRef;
  const outcome = this.scratch.get("credential") as CredentialOutcome;
  if (outcome.granted) assert.fail("the PDS must not hand a channel credential to an account missing from the member list");
  assert.equal(outcome.status, 403);
  assert.equal(outcome.code, "SpaceNotFound", "the authority answers a user the member list excludes exactly as it answers for a space that does not exist");

  await grantedCredential(this, actorNamed(this, "insider"), channel.uri);

  assert.deepEqual([...new Set(this.scratch.get("appAnswers") as string[])], ["SpaceNotFound"], "the PDS refused every credential the app asked for this account, with the session's channel read permission granted");
  await outsider.page.getByText("You are not on this channel’s active roster.").waitFor({ state: "visible" });
  const secret = this.scratch.get("secret") as string;
  assert.equal(await messageCards(outsider).count(), 0, "no message is shown to the account");
  assert.doesNotMatch(await outsider.page.locator("body").innerText(), new RegExp(secret));
  // What the browser was answered by every XRPC host it called itself, the app's operator among them.
  const read = outsider.xrpc.filter((call) => call.body === "recorded");
  assert.ok(read.length > 0, "the account's recorded responses were scanned");
  for (const call of read) assert.doesNotMatch(call.responseBody, new RegExp(secret), `${call.origin}${call.path} must not carry the private message`);
  assert.equal((await browserRecords(outsider, messageCollection)).some((record) => record.value.text === secret), false, "the account's browser store holds no message of the channel");
  this.log(`leak scan: ${read.length} XRPC responses read; headers only, not covered: ${outsider.xrpc.filter((call) => call.body !== "recorded").map((call) => `${call.path} (${call.body})`).join(", ") || "none"}`);
});

// --- Messages and reactions remain owned by their authors ------------------------------------------

const roster = (world: AppWorld): Roster => world.scratch.get("roster") as Roster;
const unique = (prefix: string): string => `${prefix} ${Math.random().toString(36).slice(2, 8)}`;

Given("two independent apps have authorized channel credentials", async function (this: AppWorld) {
  const people = await setUpRoster(this, [{ role: "alice", host: 1, app: 2 }, { role: "bob", host: 0, app: 1 }]);
  this.scratch.set("roster", people);
  for (const [role, session] of people.sessions) {
    assert.ok(credentialCalls(session, people.general.uri).map(credentialOutcome).includes("granted"), `the app serving ${role} holds a PDS credential for the channel`);
  }
  assert.notEqual(people.sites.get("alice")!.origin, people.sites.get("bob")!.origin, "the two members use different apps");
});

When("a member creates a message", async function (this: AppWorld) {
  const people = roster(this);
  const text = unique("hello from the second app");
  await postMessage(people.sessions.get("alice")!, text);
  this.scratch.set("text", text);
});

Then("both apps show the same message", async function (this: AppWorld) {
  const people = roster(this);
  const text = this.scratch.get("text") as string;
  const alice = people.sessions.get("alice")!;
  const bob = people.sessions.get("bob")!;
  const shown = [alice, bob];
  for (const actor of shown) await syncUntil(actor, () => expect(messageCard(actor, text)).toBeVisible({ timeout: 4_000 }));

  const delivered = await Promise.all(shown.map((actor) => deliveredMessage(actor, text)));
  assert.deepEqual(delivered[0], delivered[1], "both apps delivered the identical record");
  const facts = await Promise.all(shown.map(async (actor) => ({
    author: await messageCard(actor, text).locator(".message-meta strong").innerText(),
    sentAt: await messageCard(actor, text).locator(".message-meta time").innerText(),
  })));
  assert.deepEqual(facts[0], facts[1], "both pages show the same author and timestamp");
  assert.equal(facts[0].sentAt, delivered[0].value.createdAt);

  const stored = (await ownRecords(this, alice, people.general.uri, messageCollection)).filter((record) => record.value.text === text);
  assert.equal(stored.length, 1, "exactly one record exists in the author's repo");
  assert.equal(stored[0].uri, delivered[0].uri);
  assert.equal(stored[0].value.createdAt, delivered[0].value.createdAt);
  assert.equal(delivered[0].repo, alice.did);
});

// "they edit or delete it" is shared with direct messages and defined once, so this Given leaves its action in scratch.

Given("a member authored a channel message", async function (this: AppWorld) {
  const people = await setUpRoster(this, [{ role: "alice", host: 1, app: 2 }, { role: "bob", host: 0, app: 1 }]);
  this.scratch.set("roster", people);
  const alice = people.sessions.get("alice")!;
  const bob = people.sessions.get("bob")!;
  const kept = unique("alice says before editing");
  const dropped = unique("bob says before deleting");
  await postMessage(alice, kept);
  await postMessage(bob, dropped);
  await syncUntil(bob, () => expect(messageCard(bob, kept)).toBeVisible({ timeout: 4_000 }));
  await syncUntil(alice, () => expect(messageCard(alice, dropped)).toBeVisible({ timeout: 4_000 }));
  const edited = unique("alice says after editing");
  this.scratch.set("kept", kept);
  this.scratch.set("edited", edited);
  this.scratch.set("dropped", dropped);
  this.scratch.set("keptUri", (await deliveredMessage(alice, kept)).uri);
  this.scratch.set("editOrDelete", async () => {
    alice.page.once("dialog", (dialog) => void dialog.accept(edited));
    await messageCard(alice, kept).getByRole("button", { name: "Edit", exact: true }).click();
    bob.page.once("dialog", (dialog) => void dialog.accept());
    await messageCard(bob, dropped).getByRole("button", { name: "Delete", exact: true }).click();
  });
});

// Records are open: a field another app writes is kept by every reader, and written back by this app's edit.
const ANOTHER_APPS_FIELD = { name: "pinnedBy", value: { app: "another-client", at: "2026-11-01T12:00:00.000Z" } };

Given("another app added a field this app does not know to that message", async function (this: AppWorld) {
  const people = roster(this);
  const alice = people.sessions.get("alice")!;
  const message = (await ownRecords(this, alice, people.general.uri, messageCollection)).find((record) => record.uri === this.scratch.get("keptUri"));
  assert.ok(message, "the member's message is on their PDS");
  const result = await this.pdsPost(alice, "com.atproto.space.putRecord", {
    space: people.general.uri, repo: alice.did, collection: messageCollection, rkey: message.rkey,
    record: { ...message.value, [ANOTHER_APPS_FIELD.name]: ANOTHER_APPS_FIELD.value },
  });
  assert.equal(result.status, 200, `putRecord: ${JSON.stringify(result.body)}`);
});

Then("the field the other app added is still on the edited message", async function (this: AppWorld) {
  const people = roster(this);
  const alice = people.sessions.get("alice")!;
  const [edited] = await ownRecords(this, alice, people.general.uri, messageCollection);
  assert.equal(edited?.value.text, this.scratch.get("edited"), "this is the edited record");
  assert.deepEqual(edited?.value[ANOTHER_APPS_FIELD.name], ANOTHER_APPS_FIELD.value, "the edit wrote the other app's field back");
});

Then("the change is visible to every authorized app", async function (this: AppWorld) {
  const people = roster(this);
  const alice = people.sessions.get("alice")!;
  const bob = people.sessions.get("bob")!;
  const kept = this.scratch.get("kept") as string;
  const edited = this.scratch.get("edited") as string;
  const dropped = this.scratch.get("dropped") as string;
  for (const actor of [alice, bob]) {
    await syncUntil(actor, async () => {
      await expect(messageCard(actor, edited)).toBeVisible({ timeout: 4_000 });
      await expect(messageCard(actor, kept)).toHaveCount(0, { timeout: 4_000 });
      await expect(messageCard(actor, dropped)).toHaveCount(0, { timeout: 4_000 });
    });
  }

  const aliceRecords = await ownRecords(this, alice, people.general.uri, messageCollection);
  assert.deepEqual(aliceRecords.map((record) => record.value.text), [edited], "the PDS holds the edited text in place of the original");
  assert.equal(aliceRecords[0].uri, this.scratch.get("keptUri"), "the edit rewrote the same record");
  assert.deepEqual(await ownRecords(this, bob, people.general.uri, messageCollection), [], "the PDS no longer holds the deleted message");
  assert.equal((await deliveredMessage(bob, edited)).uri, aliceRecords[0].uri);
});

/** What the app's engine said to a write: null when it wrote, else why it refused. */
type Attempt = { refused: string | null };

/** A write through the app's engine as `actor`, made around the page, whose buttons and composer would not offer it. */
async function forgedWrite(world: AppWorld, actor: Actor, write: (engine: Engine) => Promise<unknown>): Promise<Attempt> {
  try {
    await write(engineAs(world, actor));
    return { refused: null };
  } catch (error) {
    return { refused: error instanceof Error ? error.message : String(error) };
  }
}

Given("another member authored a channel message", async function (this: AppWorld) {
  const people = await setUpRoster(this, [{ role: "alice", host: 1, app: 1 }, { role: "bob", host: 0, app: 1 }]);
  this.scratch.set("roster", people);
  const alice = people.sessions.get("alice")!;
  const bob = people.sessions.get("bob")!;
  const theirs = unique("alice wrote this");
  const mine = unique("bob wrote this");
  await postMessage(alice, theirs);
  await syncUntil(bob, () => expect(messageCard(bob, theirs)).toBeVisible({ timeout: 4_000 }));
  await postMessage(bob, mine);
  this.scratch.set("theirs", theirs);
  this.scratch.set("mine", mine);
  this.scratch.set("before", await ownRecords(this, alice, people.general.uri, messageCollection));
});

When("a member attempts to edit or delete it", async function (this: AppWorld) {
  const people = roster(this);
  const alice = people.sessions.get("alice")!;
  const bob = people.sessions.get("bob")!;
  const theirs = this.scratch.get("theirs") as string;
  const mine = this.scratch.get("mine") as string;
  const message = await deliveredMessage(bob, theirs);
  const buttons = async (text: string) => messageCard(bob, text).getByRole("button", { name: /^(Edit|Delete)$/ }).allInnerTexts();
  this.scratch.set("buttons", { onTheirs: await buttons(theirs), onMine: await buttons(mine) });

  const ref = { workspace: this.workspaceUri, skey: people.general.skey };
  this.scratch.set("forgedEdit", await forgedWrite(this, bob, (engine) => engine.channels.edit(ref, message.uri, "hijacked by bob")));
  this.scratch.set("forgedDelete", await forgedWrite(this, bob, (engine) => engine.channels.delete(ref, message.uri)));
  const record = { $type: messageCollection, text: "hijacked by bob", createdAt: new Date().toISOString() };
  this.scratch.set("directEdit", await this.pdsPost(bob, "com.atproto.space.putRecord", { space: people.general.uri, repo: alice.did, collection: messageCollection, rkey: message.rkey, record }));
  this.scratch.set("directDelete", await this.pdsPost(bob, "com.atproto.space.deleteRecord", { space: people.general.uri, repo: alice.did, collection: messageCollection, rkey: message.rkey }));
});

Then("the app refuses the action", async function (this: AppWorld) {
  const people = roster(this);
  const alice = people.sessions.get("alice")!;
  const bob = people.sessions.get("bob")!;
  const theirs = this.scratch.get("theirs") as string;

  assert.deepEqual(this.scratch.get("buttons"), { onTheirs: [], onMine: ["Edit", "Delete"] }, "the page offers Edit and Delete only on the viewer's own message");
  for (const key of ["forgedEdit", "forgedDelete"]) {
    const attempt = this.scratch.get(key) as Attempt;
    assert.match(attempt.refused ?? "it wrote", /only your own messages/, key);
  }
  for (const key of ["directEdit", "directDelete"]) {
    const attempt = this.scratch.get(key) as { status: number; body: unknown };
    assert.ok(attempt.status >= 400, `the PDS refused ${key} on another account's repo, got ${attempt.status}`);
  }

  assert.deepEqual(await ownRecords(this, alice, people.general.uri, messageCollection), this.scratch.get("before"), "alice's record is unchanged on her PDS, byte for byte");
  await syncUntil(bob, () => expect(messageCard(bob, theirs)).toBeVisible({ timeout: 4_000 }));
  await expect(bob.page.getByText("hijacked by bob")).toHaveCount(0);
});

// --- One-level replies ----------------------------------------------------------------------------------

Given("a top-level message exists in a channel", async function (this: AppWorld) {
  const people = await setUpRoster(this, [{ role: "alice", host: 1, app: 1 }, { role: "bob", host: 0, app: 1 }]);
  this.scratch.set("roster", people);
  const alice = people.sessions.get("alice")!;
  const bob = people.sessions.get("bob")!;
  const parent = unique("top-level message");
  await postMessage(bob, parent);
  await syncUntil(alice, () => expect(messageCard(alice, parent)).toBeVisible({ timeout: 4_000 }));
  this.scratch.set("parent", { text: parent, uri: (await deliveredMessage(alice, parent)).uri });
});

When("a member replies to that message", async function (this: AppWorld) {
  const people = roster(this);
  const alice = people.sessions.get("alice")!;
  const parent = this.scratch.get("parent") as { text: string };
  const reply = unique("reply sent through the app");
  await postMessage(alice, reply, { replyToCard: parent.text });
  this.scratch.set("reply", reply);
});

Then("the reply is shown under the parent", async function (this: AppWorld) {
  const people = roster(this);
  const alice = people.sessions.get("alice")!;
  const bob = people.sessions.get("bob")!;
  const parent = this.scratch.get("parent") as { text: string; uri: string };
  const reply = this.scratch.get("reply") as string;
  for (const viewer of [alice, bob]) {
    await syncUntil(viewer, () => expect(messageCard(viewer, reply)).toBeVisible({ timeout: 4_000 }));
    await expect(messageCard(viewer, reply).locator("small")).toHaveText(`Reply to ${parent.uri}`, { timeout: 30_000 });
    const [parentBox, replyBox] = await Promise.all([messageCard(viewer, parent.text).boundingBox(), messageCard(viewer, reply).boundingBox()]);
    assert.ok(parentBox && replyBox);
    const order = await messageCards(viewer).locator("> p").allInnerTexts();
    assert.ok(replyBox.y > parentBox.y, `${viewer.role} sees the reply below its parent (parent at y=${parentBox.y}, reply at y=${replyBox.y}; cards top to bottom: ${order.join(" | ")})`);
  }
  const stored = (await ownRecords(this, alice, people.general.uri, messageCollection)).find((record) => record.value.text === reply);
  assert.equal(stored?.value.parent, parent.uri, "the stored reply names the parent message");
});

Then("a cross-channel parent or a reply to another reply is ignored", async function (this: AppWorld) {
  const people = roster(this);
  const admin = people.owner;
  const alice = people.sessions.get("alice")!;
  const bob = people.sessions.get("bob")!;
  const parent = this.scratch.get("parent") as { text: string; uri: string };
  const reply = this.scratch.get("reply") as string;

  const side = uniqueChannelName("Side");
  await createChannelAs(admin, side);
  const sideChannel = await channelNamed(this, admin, side);
  const elsewhere = tidNow();
  await writeOwnRecords(this, bob, sideChannel.uri, [{ collection: messageCollection, rkey: elsewhere, value: { text: unique("message in another channel"), createdAt: new Date().toISOString() } }]);

  const stamp = () => new Date().toISOString();
  const validDirect = { rkey: tidNow(), text: unique("valid reply written straight to the PDS") };
  await writeOwnRecords(this, alice, people.general.uri, [{ collection: messageCollection, rkey: validDirect.rkey, value: { text: validDirect.text, createdAt: stamp(), parent: parent.uri } }]);
  const hostile = { crossChannel: { rkey: tidNow(), text: unique("reply naming a parent in another channel") }, nested: { rkey: tidNow(), text: unique("reply to another reply") } };
  await writeOwnRecords(this, alice, people.general.uri, [
    { collection: messageCollection, rkey: hostile.crossChannel.rkey, value: { text: hostile.crossChannel.text, createdAt: stamp(), parent: spaceRecordUri(sideChannel.uri, bob.did, messageCollection, elsewhere) } },
    { collection: messageCollection, rkey: hostile.nested.rkey, value: { text: hostile.nested.text, createdAt: stamp(), parent: spaceRecordUri(people.general.uri, alice.did, messageCollection, validDirect.rkey) } },
  ]);
  const stored = (await ownRecords(this, alice, people.general.uri, messageCollection)).map((record) => record.value.text);
  for (const text of [validDirect.text, hostile.crossChannel.text, hostile.nested.text]) assert.ok(stored.includes(text), "the record really is in alice's repo on her PDS");

  await openChannel(admin, "general");
  await expect(messageCard(admin, validDirect.text)).toBeVisible({ timeout: 30_000 });
  await expect(messageCard(admin, reply)).toBeVisible({ timeout: 30_000 });
  await expect(messageCard(admin, parent.text)).toBeVisible({ timeout: 30_000 });
  for (const ignored of Object.values(hostile)) await expect(messageCard(admin, ignored.text)).toHaveCount(0);

  const nestedAttempt = unique("reply to a reply through the app");
  await messageCard(alice, reply).getByRole("button", { name: "Reply", exact: true }).click();
  await composer(alice).fill(nestedAttempt);
  await alice.page.getByRole("button", { name: "Send", exact: true }).click();
  await alice.page.locator(".form-error").filter({ hasText: "Reply target must be a top-level message in this channel." }).waitFor({ state: "visible" });
  await expect(messageCard(alice, nestedAttempt)).toHaveCount(0);
  assert.equal((await ownRecords(this, alice, people.general.uri, messageCollection)).some((record) => record.value.text === nestedAttempt), false, "the refused reply was not stored");
});

// --- One reaction per author, message, and emoji -------------------------------------------------------

const reactionButton = (actor: Actor, message: string, label: string) => messageCard(actor, message).getByRole("button", { name: label, exact: true });

async function reactionRecords(world: AppWorld, who: Actor, space: string): Promise<Array<{ emoji: unknown; subject: unknown; rkey: string }>> {
  return (await ownRecords(world, who, space, reactionCollection)).map((record) => ({ emoji: record.value.emoji, subject: record.value.subject, rkey: record.rkey }));
}

Given("a member reacts to a message with an emoji", async function (this: AppWorld) {
  const people = await setUpRoster(this, [{ role: "alice", host: 1, app: 2 }, { role: "bob", host: 0, app: 1 }]);
  this.scratch.set("roster", people);
  const alice = people.sessions.get("alice")!;
  const bob = people.sessions.get("bob")!;
  const text = unique("message to react to");
  await postMessage(bob, text);
  const uri = (await deliveredMessage(bob, text)).uri;
  const bobsThumb = reactionRecordKey(uri, "👍", bob.did);
  await writeOwnRecords(this, bob, people.general.uri, [{ collection: reactionCollection, rkey: bobsThumb, value: { subject: uri, emoji: "👍", createdAt: new Date().toISOString() } }]);
  await syncUntil(alice, async () => {
    await expect(messageCard(alice, text)).toBeVisible({ timeout: 4_000 });
    await expect(reactionButton(alice, text, "👍 1")).toBeVisible({ timeout: 4_000 });
  });

  const reacted = await clickReaction(alice, text, "💜 0");
  assert.equal(reacted.status, 200, reacted.responseBody);
  await syncUntil(alice, () => expect(reactionButton(alice, text, "💜 1")).toBeVisible({ timeout: 4_000 }));
  assert.deepEqual(await reactionRecords(this, alice, people.general.uri), [{ emoji: "💜", subject: uri, rkey: reactionRecordKey(uri, "💜", alice.did) }]);
  this.scratch.set("reacted", { text, uri });
});

When("the member changes or removes that reaction", async function (this: AppWorld) {
  const people = roster(this);
  const alice = people.sessions.get("alice")!;
  const { text, uri } = this.scratch.get("reacted") as { text: string; uri: string };
  for (const label of ["👍 1", "💜 1"]) {
    const answer = await clickReaction(alice, text, label);
    assert.equal(answer.status, 200, answer.responseBody);
  }
  // The same thumbs-up once more, from another app of alice's (her page shows it active, so it offers only to remove it).
  await engineAs(this, alice).channels.react({ workspace: this.workspaceUri, skey: people.general.skey }, uri, "👍");
  assert.deepEqual(await reactionRecords(this, alice, people.general.uri), [{ emoji: "👍", subject: uri, rkey: reactionRecordKey(uri, "👍", alice.did) }], "alice's repo holds exactly one reaction now, the thumbs-up she gave twice");
});

Then("all apps show only the current reaction record", async function (this: AppWorld) {
  const people = roster(this);
  const alice = people.sessions.get("alice")!;
  const bob = people.sessions.get("bob")!;
  const { text, uri } = this.scratch.get("reacted") as { text: string; uri: string };
  for (const viewer of [bob, alice]) {
    await syncUntil(viewer, async () => {
      await expect(reactionButton(viewer, text, "👍 2")).toBeVisible({ timeout: 4_000 });
      await expect(reactionButton(viewer, text, "💜 0")).toBeVisible({ timeout: 4_000 });
      await expect(reactionButton(viewer, text, "💜 1")).toHaveCount(0);
    });
    await expect(reactionButton(viewer, text, "👍 2")).toHaveClass(/reaction-active/, { timeout: 30_000 });
    await settles(async () => assert.deepEqual((await deliveredReactions(viewer, uri)).map((reaction) => [reaction.repo, reaction.emoji]).sort(), [[alice.did, "👍"], [bob.did, "👍"]].sort(), `${viewer.role}'s app delivered exactly the two current reaction records`));
  }
  assert.deepEqual((await reactionRecords(this, bob, people.general.uri)).map((record) => record.emoji), ["👍"]);
  assert.deepEqual((await reactionRecords(this, alice, people.general.uri)).map((record) => record.emoji), ["👍"]);
});

// --- Message length ---------------------------------------------------------------------------------------

const EMOJI = "\u{1F600}";

Given("a message contains more than 10000 graphemes", async function (this: AppWorld) {
  const people = await setUpRoster(this, [{ role: "alice", host: 1, app: 1 }]);
  this.scratch.set("roster", people);
  const atLimit = EMOJI.repeat(10_000);
  const overlong = EMOJI.repeat(10_001);
  assert.equal(Array.from(overlong).length, 10_001);
  assert.equal(Array.from(atLimit).length, 10_000);
  assert.ok(atLimit.length > 10_000, "the accepted text is longer than 10000 UTF-16 units, so only a grapheme count admits it");
  this.scratch.set("atLimit", atLimit);
  this.scratch.set("overlong", overlong);
});

When("the member submits it", async function (this: AppWorld) {
  const people = roster(this);
  const alice = people.sessions.get("alice")!;
  const atLimit = this.scratch.get("atLimit") as string;
  const overlong = this.scratch.get("overlong") as string;

  await composer(alice).fill(overlong);
  this.scratch.set("composer", {
    codePoints: Array.from(await composer(alice).inputValue()).length,
    counter: await alice.page.locator(".message-compose small").innerText(),
  });
  await composer(alice).fill("");

  await postMessage(alice, atLimit, { appears: messageCards(alice) });
  this.scratch.set("forged", await forgedWrite(this, alice, (engine) => engine.channels.send({ workspace: this.workspaceUri, skey: people.general.skey }, overlong)));
  const directRkey = tidNow();
  const direct = await this.pdsPost(alice, "com.atproto.space.createRecord", {
    space: people.general.uri, repo: alice.did, collection: messageCollection, rkey: directRkey, record: { $type: messageCollection, text: overlong, createdAt: new Date().toISOString() },
  });
  assert.equal(direct.status, 200, "the PDS stores whatever a member writes into their own repo; only readers can ignore it");
  this.scratch.set("directRkey", directRkey);
});

Then("the message is rejected", async function (this: AppWorld) {
  const people = roster(this);
  const alice = people.sessions.get("alice")!;
  const overlong = this.scratch.get("overlong") as string;

  assert.deepEqual(this.scratch.get("composer"), { codePoints: 10_000, counter: "10000/10,000" }, "the composer cannot hold more than 10000 code points");
  const forged = this.scratch.get("forged") as Attempt;
  // 10,001 four-byte emoji exceed both of the lexicon's limits (10,000 graphemes, 40,000 UTF-8 bytes); the byte limit is reported first.
  assert.match(forged.refused ?? "it wrote", /text must not be longer than 40000 characters/, "the app refuses the message before it reaches the PDS");

  const stored = await ownRecords(this, alice, people.general.uri, messageCollection);
  const lengths = new Map(stored.map((record) => [record.rkey, Array.from(String(record.value.text)).length]));
  assert.equal(lengths.size, 2, "the refused request stored nothing: alice's repo holds only the message at the limit and the record she wrote around the app");
  assert.equal([...lengths.values()].filter((length) => length === 10_000).length, 1);
  assert.equal(lengths.get(this.scratch.get("directRkey") as string), 10_001);

  const reader = people.owner;
  await openChannel(reader, "general");
  await syncUntil(reader, async () => assert.equal(await messageCards(reader).count(), 1, "a reader sees one message: the one at the limit"));
  const shown = await messageCards(reader).locator("> p").innerText();
  assert.equal(Array.from(shown).length, 10_000);
  assert.notEqual(shown, overlong);
});

// --- Bounded, paged history -------------------------------------------------------------------------------

const HISTORY_SIZE = 130;
const labelled = (prefix: string, number: number): string => `${prefix} ${String(number).padStart(3, "0")}`;
const newestFirst = (prefix: string, from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, index) => labelled(prefix, to - index));

function seedMessages(prefix: string, count: number): Array<{ collection: string; rkey: string; value: Record<string, unknown> }> {
  const start = Date.now() - 24 * 60 * 60 * 1000;
  return Array.from({ length: count }, (_, index) => {
    const at = start + (index + 1) * 1000;
    return { collection: messageCollection, rkey: tidNow(at, 0), value: { text: labelled(prefix, index + 1), createdAt: new Date(at).toISOString() } };
  });
}

/** The spaces whose messages the app's engine holds in this browser for the account. */
const heldMessageSpaces = async (who: Actor): Promise<string[]> => [...new Set((await browserRecords(who, messageCollection)).map((record) => record.space))].sort();

/** The message texts the browser's own listings carried. */
const listedTexts = (listings: ReturnType<typeof listingCalls>): string[] =>
  listings.flatMap(({ call }) => (JSON.parse(call.responseBody) as { records: Array<{ value: { text?: unknown } }> }).records.map((record) => String(record.value.text)));

Given("a channel contains more than 100 messages", async function (this: AppWorld) {
  const people = await setUpRoster(this, [{ role: "alice", host: 1, app: 1 }]);
  this.scratch.set("roster", people);
  const alice = people.sessions.get("alice")!;
  const history = uniqueChannelName("History");
  const decoy = uniqueChannelName("Decoy");
  await createChannelAs(people.owner, history);
  await createChannelAs(people.owner, decoy);
  const channels = { history: await channelNamed(this, people.owner, history), decoy: await channelNamed(this, people.owner, decoy) };
  await writeOwnRecords(this, alice, channels.history.uri, seedMessages("history", HISTORY_SIZE));
  await writeOwnRecords(this, alice, channels.decoy.uri, seedMessages("decoy", 12));
  assert.equal((await ownRecords(this, alice, channels.history.uri, messageCollection)).length, HISTORY_SIZE);
  this.scratch.set("channels", channels);
});

When("a member opens that channel", { timeout: 420_000 }, async function (this: AppWorld) {
  const people = roster(this);
  const alice = people.sessions.get("alice")!;
  const channels = this.scratch.get("channels") as { history: ChannelRef };
  this.scratch.set("xrpcBefore", alice.xrpc.length);
  this.scratch.set("spacesBefore", await heldMessageSpaces(alice));
  await openChannel(alice, channels.history.name);
  await expect(messageCards(alice).first()).toBeVisible({ timeout: PAGE_TIMEOUT_MS });
});

/** The browser's own message listings since the member opened the channel. */
const historyListings = (world: AppWorld, alice: Actor): ReturnType<typeof listingCalls> => listingCalls(alice, messageCollection, world.scratch.get("xrpcBefore") as number);

Then("the initial view contains the latest 100 messages", async function (this: AppWorld) {
  const people = roster(this);
  const alice = people.sessions.get("alice")!;
  const channels = this.scratch.get("channels") as { history: ChannelRef };
  await expect(messageCards(alice)).toHaveCount(100, { timeout: PAGE_TIMEOUT_MS });
  assert.deepEqual(await messageCards(alice).locator("> p").allInnerTexts(), newestFirst("history", 31, 130), "the view shows the newest 100 messages, newest first");
  await expect(alice.page.getByRole("button", { name: "Load older messages", exact: true })).toBeVisible();

  await settles(() => {
    const listings = historyListings(this, alice);
    assert.ok(listings.length > 0, "the browser listed the channel's messages itself");
    assert.equal(listings[0]!.query.get("cursor"), null, "the first request asked for the newest page");
    assert.deepEqual([...new Set(listedTexts(listings))].sort(), newestFirst("history", 31, 130).sort(), "the browser fetched the newest 100 messages and nothing older");
    assert.equal(listings.every(({ query }) => query.get("space") === channels.history.uri), true);
  });
});

Then("older messages load by page", { timeout: 420_000 }, async function (this: AppWorld) {
  const people = roster(this);
  const alice = people.sessions.get("alice")!;
  const since = alice.xrpc.length;
  await alice.page.getByRole("button", { name: "Load older messages", exact: true }).click();
  await expect(messageCards(alice)).toHaveCount(HISTORY_SIZE, { timeout: PAGE_TIMEOUT_MS });
  assert.deepEqual(await messageCards(alice).locator("> p").allInnerTexts(), newestFirst("history", 1, 130), "the older 30 messages are appended after the newest 100");
  await settles(() => {
    const requested = listingCalls(alice, messageCollection, since);
    assert.deepEqual(requested.map(({ query }) => query.get("cursor") !== null), [true], "exactly one more page was requested, continuing below the first 100");
    assert.deepEqual(listedTexts(requested).sort(), newestFirst("history", 1, 30).sort(), "that page carried the older 30 messages");
  });
  await expect(alice.page.getByRole("button", { name: "Load older messages", exact: true })).toHaveCount(0);
});

Then("no other channel history is fetched", async function (this: AppWorld) {
  const people = roster(this);
  const alice = people.sessions.get("alice")!;
  const channels = this.scratch.get("channels") as { history: ChannelRef; decoy: ChannelRef };
  assert.deepEqual([...new Set(historyListings(this, alice).map(({ query }) => query.get("space")))], [channels.history.uri], "every history request named the opened channel");
  for (const call of alice.xrpc.slice(this.scratch.get("xrpcBefore") as number)) assert.doesNotMatch(call.responseBody, /decoy \d{3}/, "no response carried another channel's messages");
  const held = await heldMessageSpaces(alice);
  assert.deepEqual(held.filter((space) => !(this.scratch.get("spacesBefore") as string[]).includes(space)), [channels.history.uri], "the app synced only the opened channel's records for this account");
  assert.equal(held.includes(channels.decoy.uri), false);
  assert.equal(await alice.page.getByText(/decoy \d{3}/).count(), 0);
});
