import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { After, Given, Then, When } from "@cucumber/cucumber";
import type { SpaceCredential } from "@/atproto/space-credential-core";
import { requestDigest } from "@/protocol/keys";
import type { Actor, AppWorld } from "../support/world";
import { completeConsent, escapeRegExp, eventually, inviteMemberAs, waitForApp } from "../support/ui";
import {
  MAX_CREDENTIAL_LIFETIME_SECONDS, actorNamed, allSpaces, auditTrail, channelButton, claimsOf, createChannelAs, grantedCredential,
  inboxOf, journalEntry, joinWorkspaceAs, memberAccess, openChannelAs, readRecordsWith, recall, recentCalls, refusal, remember, removeMemberViaRoster,
  requiredJournalEntry, sampleWhile, showWorkspaceHome, submitAndWait, subjectRecordActive, tryMintAs, workspaceWithAdmin,
  authorityRecord, breakChannelSpace, cachedRows, eventuallyAsync, tryReadWith, withSignedExpiry, journalRowsFor, repairChannelSpace, decodeExecuted, membersOf, postMessageAs, sampleTimed, channelNamed,
  startOwnApp, runReconcileJob, withExtendedExpiry, withFinalReading, worldOn,
  type ChannelRef, type Executed, type JournalEntry, type OwnApp, type ReconcileRun, type Timed,
} from "../support/lifecycle-ui";

type Space = { label: string; uri: string };
type RemovalSample = { state: string | undefined; present: Record<string, boolean> };

const FULL_ACCESS = { read: true, write: true };
const INBOX_WRITE_ONLY = { read: false, write: true };
const SHORT_LIFETIME_SECONDS = 5;
const EXPIRY_GRACE_MS = 3_000;

function removalState(world: AppWorld, subjectDid: string): string | undefined {
  return world.withAppDatabase((db) => (db.prepare(
    "SELECT state FROM operation WHERE request_json LIKE '%\"kind\":\"removeMember\"%' AND request_json LIKE ? ORDER BY created_at DESC LIMIT 1",
  ).get(`%${subjectDid}%`) as { state: string } | undefined)?.state);
}

async function membershipMap(world: AppWorld, spaces: Space[], did: string): Promise<Record<string, boolean>> {
  const owner = actorNamed(world, "owner");
  const entries = await Promise.all(spaces.map(async (space) => [space.label, (await memberAccess(world, owner, space.uri, did)) !== undefined] as const));
  return Object.fromEntries(entries);
}

/** Who a person should be in each space: full access everywhere, except the admin inbox where members may only write. */
function expectedAccess(space: Space, inbox: string): { read: boolean; write: boolean } {
  return space.uri === inbox ? INBOX_WRITE_ONLY : FULL_ACCESS;
}

/**
 * A real failure part-way through a real removal: the authority's PDS has lost one channel's space, so the removal
 * writes some steps and is then refused by the PDS. The fault is lifted by recreating that space.
 */
async function removeWhileChannelIsBroken(world: AppWorld, owner: Actor, victim: Actor, broken: ChannelRef): Promise<Executed> {
  await breakChannelSpace(world, owner, broken);
  const executed = await removeMemberViaRoster(world, owner, victim.did);
  assert.equal(executed.status, 200, JSON.stringify(executed));
  assert.equal(executed.operation?.state, "pending", `the removal stops part-way: ${JSON.stringify(executed)}`);
  assert.match(executed.operation?.error ?? "", /\S/, "the pending operation says why");
  const steps = executed.operation?.completedSteps ?? [];
  assert.ok(steps.includes("remove-inbox-membership"), "some PDS writes were made before the failure");
  assert.ok(!steps.includes("remove-workspace-membership") && !steps.includes("removal-verified"), "but not all of them");
  assert.equal(await memberAccess(world, owner, inboxOf(world), victim.did), undefined, "the inbox list already changed");
  assert.deepEqual(await memberAccess(world, owner, world.workspaceUri, victim.did), FULL_ACCESS, "while the workspace list still holds the member: the lists disagree");
  assert.equal(requiredJournalEntry(world, executed.operationId).state, "pending");
  await owner.page.getByText(/Operation .* is still pending\./).waitFor({ state: "visible" });
  return executed;
}

// --- Remove a workspace member from every applicable space ------------------------------------------

Given("a member has workspace, inbox, public-channel, and private-channel access", async function (this: AppWorld) {
  const owner = await workspaceWithAdmin(this);
  await createChannelAs(this, owner, "Second Room", "public");
  const member = await this.actor("member", 1);
  const bystander = await this.actor("bystander", 0);
  await showWorkspaceHome(this, owner);
  await inviteMemberAs(owner, member.did);
  await inviteMemberAs(owner, bystander.did);
  const privateRoom = await createChannelAs(this, owner, "Private Room", "private", [member.did, bystander.did]);
  const spaces = remember(this, "spaces", await allSpaces(this));
  assert.equal(spaces.length, 5, "workspace, inbox, two public channels and one private channel");
  for (const person of [member, bystander]) {
    for (const space of spaces) {
      assert.deepEqual(await memberAccess(this, owner, space.uri, person.did), expectedAccess(space, inboxOf(this)), `${person.role} in ${space.label}`);
    }
    assert.equal(await subjectRecordActive(this, owner, this.workspaceUri, "org.slack.workspace.roster", person.did), true);
    assert.equal(await subjectRecordActive(this, owner, privateRoom.uri, "org.slack.channel.roster", person.did), true);
  }
  remember(this, "privateRoom", privateRoom);
});

When("an admin removes that member", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const member = actorNamed(this, "member");
  const spaces = recall<Space[]>(this, "spaces");
  const readSample = async (): Promise<RemovalSample> => {
    const state = removalState(this, member.did);
    return { state, present: await membershipMap(this, spaces, member.did) };
  };
  const sampler = sampleWhile(readSample);
  const executed = await removeMemberViaRoster(this, owner, member.did);
  const samples = [...await sampler.stop(), await readSample()];
  assert.equal(executed.operation?.state, "completed", JSON.stringify(executed));
  remember(this, "removal", executed);
  remember(this, "removalSamples", samples);
});

Then("membership is removed from each applicable space", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const member = actorNamed(this, "member");
  const bystander = actorNamed(this, "bystander");
  const spaces = recall<Space[]>(this, "spaces");
  for (const space of spaces) {
    assert.equal(await memberAccess(this, owner, space.uri, member.did), undefined, `the removed member is gone from ${space.label}`);
    assert.deepEqual(await memberAccess(this, owner, space.uri, bystander.did), expectedAccess(space, inboxOf(this)), `removal left the other member untouched in ${space.label}`);
  }
  const steps = requiredJournalEntry(this, recall<Executed>(this, "removal").operationId).steps;
  const channels = spaces.filter((space) => space.uri.includes("/org.slack.channel/"));
  assert.ok(steps.includes("remove-inbox-membership"));
  assert.ok(steps.includes("remove-workspace-membership"));
  for (const channel of channels) assert.ok(steps.includes(`remove-channel-${channel.uri.split("/").at(-1)}`), `the journal records removal from ${channel.label}`);
});

Then("the workspace and private rosters become inactive", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const member = actorNamed(this, "member");
  const bystander = actorNamed(this, "bystander");
  const privateRoom = recall<ChannelRef>(this, "privateRoom");
  assert.equal(await subjectRecordActive(this, owner, this.workspaceUri, "org.slack.workspace.roster", member.did), false);
  assert.equal(await subjectRecordActive(this, owner, privateRoom.uri, "org.slack.channel.roster", member.did), false);
  assert.equal(await subjectRecordActive(this, owner, this.workspaceUri, "org.slack.workspace.roster", bystander.did), true);
  assert.equal(await subjectRecordActive(this, owner, privateRoom.uri, "org.slack.channel.roster", bystander.did), true);
  await showWorkspaceHome(this, owner);
  await owner.page.locator(".roster-row").filter({ hasText: bystander.did }).waitFor({ state: "visible" });
  await owner.page.locator(".roster-row").filter({ hasText: member.did }).waitFor({ state: "hidden" });
});

Then("the operation stays pending until every PDS member list agrees", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const member = actorNamed(this, "member");
  const removal = recall<Executed>(this, "removal");
  const samples = recall<RemovalSample[]>(this, "removalSamples");
  const inFlight = samples.filter((sample) => sample.state === "running" && Object.values(sample.present).some(Boolean));
  assert.ok(inFlight.length > 0, "the operation was observed in flight while a member list still held the member");
  const completed = samples.filter((sample) => sample.state === "completed");
  assert.ok(completed.length > 0, "the operation was observed completed");
  for (const sample of completed) assert.deepEqual(Object.values(sample.present).filter(Boolean), [], "completed was never reported while any member list still held the member");
  const entry = requiredJournalEntry(this, removal.operationId);
  assert.equal(entry.state, "completed");
  assert.equal(entry.steps.at(-1), "removal-verified", "the last recorded step is the check that every member list agrees");
  const events = auditTrail(this, removal.operationId).map((event) => event.event);
  assert.equal(events.filter((event) => event === "operationCompleted").length, 1);
  assert.deepEqual(events.slice(-2), ["removal-verified", "operationCompleted"], "completion is recorded only after the verification step");
  assert.ok(events.indexOf("remove-workspace-membership") < events.indexOf("removal-verified"));
  assert.equal(removalState(this, member.did), "completed");

  const bystander = actorNamed(this, "bystander");
  const secondRoom = await channelNamed(this, "Second Room");
  const stuck = await removeWhileChannelIsBroken(this, owner, bystander, secondRoom);
  assert.equal(removalState(this, bystander.did), "pending", "while the lists disagree the operation stays pending");
  await repairChannelSpace(this, owner, secondRoom);
  const resumed = await submitAndWait(this, owner, async () => {
    await owner.page.getByRole("button", { name: "Retry same operation ↻" }).click();
  });
  assert.equal(resumed.operationId, stuck.operationId);
  assert.equal(resumed.operation?.state, "completed", JSON.stringify(resumed));
  for (const space of await allSpaces(this)) {
    if (space.uri !== secondRoom.uri) assert.equal(await memberAccess(this, owner, space.uri, bystander.did), undefined, `it completed only once ${space.label} agreed`);
  }
  const resumedSteps = requiredJournalEntry(this, stuck.operationId).steps;
  assert.ok(resumedSteps.includes(`remove-channel-${secondRoom.skey}`), "the resumed operation itself made the removal the fault had blocked");
  assert.equal(resumedSteps.at(-1), "removal-verified");
});

// --- An old credential expires after removal --------------------------------------------------------

Given("a member holds a space credential with a two hour maximum lifetime", async function (this: AppWorld) {
  const owner = await workspaceWithAdmin(this);
  const member = await this.actor("member", 1);
  const bystander = await this.actor("bystander", 0);
  await inviteMemberAs(owner, member.did);
  await inviteMemberAs(owner, bystander.did);
  const general = (await allSpaces(this)).find((space) => space.label.startsWith("public channel"));
  assert.ok(general, "the workspace has a public channel");
  const spaces = [{ label: "workspace", uri: this.workspaceUri }, general];
  remember(this, "credentialSpaces", spaces);
  const mintedAt = Date.now();
  const held = await Promise.all(spaces.map(async (space) => grantedCredential(this, member, space.uri)));
  remember(this, "heldCredentials", held);
  for (const credential of held) {
    const claims = claimsOf(credential.token);
    assert.equal(claims.sub, credential.space);
    assert.equal(claims.iss, owner.did, "the workspace authority signed it");
    assert.ok(claims.exp - claims.iat <= MAX_CREDENTIAL_LIFETIME_SECONDS, `lifetime ${claims.exp - claims.iat}s exceeds two hours`);
    assert.ok(claims.exp - claims.iat > 0);
    assert.ok(claims.exp * 1000 > Date.now(), "it has not expired");
    assert.ok(claims.exp * 1000 <= mintedAt + MAX_CREDENTIAL_LIFETIME_SECONDS * 1000 + 5_000, "it was minted just now, so its expiry is at most two hours away");
  }
  const profile = await readRecordsWith(this, held[0]!, owner.did, "org.slack.workspace.profile");
  assert.equal(profile.length, 1, "before removal the credential reads the workspace");
});

When("the member is removed", async function (this: AppWorld) {
  const executed = await removeMemberViaRoster(this, actorNamed(this, "owner"), actorNamed(this, "member").did);
  assert.equal(executed.operation?.state, "completed", JSON.stringify(executed));
});

Then("they cannot obtain a new credential", async function (this: AppWorld) {
  const member = actorNamed(this, "member");
  const bystander = actorNamed(this, "bystander");
  for (const space of recall<Space[]>(this, "credentialSpaces")) {
    assert.deepEqual(refusal(await tryMintAs(this, member, space.uri)), { status: 403, code: "UserNotAuthorized" }, `removed member, ${space.label}`);
    assert.equal(refusal(await tryMintAs(this, bystander, space.uri)), "granted", `a member who was not removed can still mint for ${space.label}`);
  }
});

Then("the old credential works only until its signed expiration", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const [workspaceCredential] = recall<SpaceCredential[]>(this, "heldCredentials");
  assert.ok(workspaceCredential);
  const claims = claimsOf(workspaceCredential.token);
  assert.ok(claims.exp * 1000 > Date.now(), "the old credential is still inside its signed lifetime");
  assert.ok(claims.exp - claims.iat <= MAX_CREDENTIAL_LIFETIME_SECONDS, "its signed lifetime is at most two hours");
  const profile = (credential: SpaceCredential) => tryReadWith(this, credential, owner.did, "org.slack.workspace.profile");
  assert.deepEqual(await profile(workspaceCredential), { records: 1 }, "removal does not revoke a credential that was already issued");

  assert.deepEqual(
    await profile(withExtendedExpiry(workspaceCredential, 365 * 24 * 60 * 60)),
    { refused: { status: 401, code: "BadJwtSignature" } },
    "stretching the signed expiry breaks the signature, so the expiry the authority signed is the only limit",
  );

  const expiresAt = Math.floor(Date.now() / 1000) + SHORT_LIFETIME_SECONDS;
  const shortLived = await withSignedExpiry(this, workspaceCredential, expiresAt);
  assert.deepEqual(await profile(shortLived), { records: 1 }, "signed by the authority with a near expiry, the removed member's credential still reads");
  assert.ok(Date.now() < expiresAt * 1000, "that read happened inside the signed lifetime");

  const refused = await eventuallyAsync(async () => {
    const attempt = await profile(shortLived);
    return "refused" in attempt ? { ...attempt.refused, at: Date.now() } : undefined;
  }, { what: "the PDS to refuse the credential after its signed expiration", timeoutMs: 30_000 });
  assert.deepEqual({ status: refused.status, code: refused.code }, { status: 401, code: "JwtExpired" }, "after its signed expiration the PDS refuses it as expired");
  assert.ok(refused.at >= expiresAt * 1000, "it was refused only once its signed expiration had passed");
  assert.ok(refused.at < expiresAt * 1000 + EXPIRY_GRACE_MS, "and refused as soon as it passed, with no grace period");
  assert.deepEqual(await profile(shortLived), { refused: { status: 401, code: "JwtExpired" } }, "it stays refused");
});

// --- A member leaves a private channel ---------------------------------------------------------------

Given("a member belongs to a private channel", async function (this: AppWorld) {
  const owner = await workspaceWithAdmin(this);
  const member = await this.actor("member", 1);
  const bystander = await this.actor("bystander", 0);
  await inviteMemberAs(owner, member.did);
  await inviteMemberAs(owner, bystander.did);
  const room = await createChannelAs(this, owner, "Private Room", "private", [member.did, bystander.did]);
  remember(this, "privateRoom", room);
  await joinWorkspaceAs(this, member);
  assert.deepEqual(await memberAccess(this, owner, room.uri, member.did), FULL_ACCESS);
  assert.equal(await subjectRecordActive(this, owner, room.uri, "org.slack.channel.roster", member.did), true);
  assert.equal((await openChannelAs(this, member, "Private Room")).status, 200, recentCalls(member));
  await member.page.getByRole("button", { name: "Leave private channel" }).waitFor({ state: "visible" });
});

When("they leave that channel", async function (this: AppWorld) {
  const member = actorNamed(this, "member");
  const first = await submitAndWait(this, member, async () => {
    await member.page.getByRole("button", { name: "Leave private channel" }).click();
  });
  assert.ok(first.status >= 400 && first.operation === undefined, `a member's first leave is refused until they approve the leave permission: ${JSON.stringify(first)}`);
  await member.page.getByRole("button", { name: "Authorize leave control →" }).click();
  await completeConsent(member);
  await waitForApp(this, member);
  const retried = await submitAndWait(this, member, async () => {
    await member.page.getByRole("button", { name: "Retry same operation ↻" }).click();
  });
  assert.equal(retried.operationId, first.operationId, "the retry reuses the same operation ID");
  assert.equal(retried.operation?.state, "completed", JSON.stringify(retried));
  remember(this, "leave", retried);
});

Then("channel access and the private roster entry are removed", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const member = actorNamed(this, "member");
  const bystander = actorNamed(this, "bystander");
  const room = recall<ChannelRef>(this, "privateRoom");
  assert.equal(await memberAccess(this, owner, room.uri, member.did), undefined);
  assert.equal(await subjectRecordActive(this, owner, room.uri, "org.slack.channel.roster", member.did), false);
  assert.deepEqual(await memberAccess(this, owner, room.uri, bystander.did), FULL_ACCESS, "other members keep the channel");
  assert.equal(await subjectRecordActive(this, owner, room.uri, "org.slack.channel.roster", bystander.did), true);
  const outcome = await tryMintAs(this, member, room.uri);
  assert.deepEqual(refusal(outcome), { status: 403, code: "UserNotAuthorized" });
  const steps = requiredJournalEntry(this, recall<Executed>(this, "leave").operationId).steps;
  assert.deepEqual(steps, ["leave-channel-membership", "leave-channel-roster", "leave-channel-verified"]);
  const before = this.callsTo(member, "/api/channels/messages").length;
  await channelButton(member, "Private Room").click();
  const reopened = await eventually(() => this.callsTo(member, "/api/channels/messages")[before], { what: "the member's next look at the channel" });
  assert.ok(reopened.status === 401 || reopened.status === 403, `the app no longer syncs the channel for them (${reopened.status})`);
});

Then("workspace access remains active", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const member = actorNamed(this, "member");
  const spaces = (await allSpaces(this)).filter((space) => !space.label.startsWith("private channel"));
  for (const space of spaces) {
    assert.deepEqual(await memberAccess(this, owner, space.uri, member.did), expectedAccess(space, inboxOf(this)), `still in ${space.label}`);
  }
  assert.equal(await subjectRecordActive(this, owner, this.workspaceUri, "org.slack.workspace.roster", member.did), true);
  assert.equal(refusal(await tryMintAs(this, member, this.workspaceUri)), "granted", "they can still mint a workspace credential");
  const listing = await member.page.request.get(`${this.appOrigin}/api/workspaces`);
  const workspaces = (await listing.json() as { workspaces: Array<{ uri: string; members: Array<{ did: string; active: boolean }> }> }).workspaces;
  const seen = workspaces.find((workspace) => workspace.uri === this.workspaceUri);
  assert.ok(seen, "the workspace is still in the member's dashboard");
  assert.ok(seen.members.some((entry) => entry.did === member.did && entry.active));
  assert.equal(journalEntry(this, recall<Executed>(this, "leave").operationId)?.request.kind, "leaveChannel", "only the channel was left, not the workspace");
});

// --- Make a public channel private -------------------------------------------------------------------

type ChannelReading = { visibility: string | undefined; members: string[] };
type Probe = { status: number; error?: string };

async function readChannel(world: AppWorld, channel: ChannelRef): Promise<ChannelReading> {
  const owner = actorNamed(world, "owner");
  const [entry, members] = await Promise.all([
    authorityRecord(world, owner, world.workspaceUri, "org.slack.directory", channel.skey),
    membersOf(world, owner, channel.uri),
  ]);
  return { visibility: entry?.visibility as string | undefined, members: members.map((member) => member.did) };
}

async function probeSync(world: AppWorld, channel: ChannelRef): Promise<Probe> {
  const query = new URLSearchParams({ workspace: world.workspaceUri, skey: channel.skey, offset: "0" });
  const response = await actorNamed(world, "owner").page.request.get(`${world.appOrigin}/api/channels/messages?${query}`);
  const body = await response.json() as { error?: string };
  return { status: response.status(), error: body.error };
}

async function messageRecords(world: AppWorld, viewerRole: string, channel: ChannelRef): Promise<Array<{ rkey: string; text: unknown }>> {
  const owner = actorNamed(world, "owner");
  const credential = await grantedCredential(world, actorNamed(world, viewerRole), channel.uri);
  return (await readRecordsWith(world, credential, owner.did, "org.slack.channel.message")).map((record) => ({ rkey: record.rkey, text: record.value.text }));
}

Given("a public channel has current workspace members", async function (this: AppWorld) {
  const owner = await workspaceWithAdmin(this);
  const kept = await this.actor("kept", 1);
  const dropped = await this.actor("dropped", 0);
  const roadmap = await createChannelAs(this, owner, "Roadmap", "public");
  await showWorkspaceHome(this, owner);
  await inviteMemberAs(owner, kept.did);
  await inviteMemberAs(owner, dropped.did);
  assert.equal((await openChannelAs(this, owner, "Roadmap")).status, 200);
  await postMessageAs(this, owner, "Roadmap kickoff");
  for (const person of [kept, dropped]) {
    assert.deepEqual(await memberAccess(this, owner, roadmap.uri, person.did), FULL_ACCESS, `${person.role} is a current channel member`);
    assert.equal(refusal(await tryMintAs(this, person, roadmap.uri)), "granted", `${person.role} can mint a credential before the transition`);
  }
  remember(this, "roadmap", roadmap);
  remember(this, "messagesBefore", await messageRecords(this, "kept", roadmap));
});

When("an admin starts a private transition for selected members", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const kept = actorNamed(this, "kept");
  const roadmap = recall<ChannelRef>(this, "roadmap");
  remember(this, "syncBefore", await probeSync(this, roadmap));
  const sampler = sampleTimed(() => readChannel(this, roadmap));
  const probers = [1, 2, 3].map(() => sampleTimed(() => probeSync(this, roadmap)));
  const executed = await submitAndWait(this, owner, async () => {
    await owner.page.getByLabel("Selected members when making this channel private").fill(kept.did);
    await owner.page.getByRole("button", { name: "Make private", exact: true }).click();
  });
  const readings = await withFinalReading(await sampler.stop(), () => readChannel(this, roadmap));
  const probes = (await Promise.all(probers.map((prober) => prober.stop()))).flat();
  assert.equal(executed.operation?.state, "completed", JSON.stringify(executed));
  remember(this, "syncAfter", await probeSync(this, roadmap));
  remember(this, "transition", executed);
  remember(this, "channelReadings", readings);
  remember(this, "syncProbes", probes);
});

Then("the directory shows transitioning while membership changes", function (this: AppWorld) {
  const dropped = actorNamed(this, "dropped");
  const readings = recall<Array<Timed<ChannelReading>>>(this, "channelReadings");
  const visibilities = readings.map((reading) => reading.value.visibility);
  const order = ["public", "transitioning", "private"];
  assert.ok(visibilities.every((visibility, index) => index === 0 || order.indexOf(visibility!) >= order.indexOf(visibilities[index - 1]!)), `visibility only moves forward: ${visibilities.join(" > ")}`);
  assert.equal(visibilities[0], "public");
  assert.equal(visibilities.at(-1), "private");
  assert.ok(visibilities.includes("transitioning"), "the directory was observed as transitioning while the operation ran");
  for (const reading of readings) {
    if (reading.value.visibility === "private") assert.ok(!reading.value.members.includes(dropped.did), "the directory never said private while an unselected member could still read");
  }
  assert.ok(readings.some((reading) => reading.value.visibility === "transitioning" && reading.value.members.includes(dropped.did)), "membership was still unchanged when the transition was announced");
  const steps = requiredJournalEntry(this, recall<Executed>(this, "transition").operationId).steps;
  assert.equal(steps[0], "channel-set-transitioning");
  assert.equal(steps.at(-1), "channel-set-final-visibility");
  assert.ok(steps.indexOf(`channel-remove-${dropped.did}`) > 0 && steps.indexOf(`channel-remove-${dropped.did}`) < steps.indexOf("channel-visibility-verified"));
});

Then("compliant apps stop new syncs during the transition", function (this: AppWorld) {
  const readings = recall<Array<Timed<ChannelReading>>>(this, "channelReadings");
  const probes = recall<Array<Timed<Probe>>>(this, "syncProbes");
  const transitioning = readings.filter((reading) => reading.value.visibility === "transitioning");
  const windowStart = transitioning[0]!.finishedAt;
  const windowEnd = transitioning.at(-1)!.startedAt;
  const refused = probes.filter((probe) => probe.value.status === 409);
  assert.ok(refused.length > 0, "the app refused at least one sync attempt made while the directory showed transitioning");
  for (const probe of refused) assert.match(probe.value.error ?? "", /transitioning/, "it refused because of the transition");
  const during = probes.filter((probe) => probe.startedAt >= windowStart && probe.finishedAt <= windowEnd);
  assert.ok(during.length > 0, "at least one sync attempt fell wholly inside the transition window");
  assert.deepEqual(during.filter((probe) => probe.value.status !== 409), [], "no sync attempt that fell wholly inside the transition succeeded");
  assert.deepEqual(probes.filter((probe) => probe.value.status !== 409 && probe.value.status !== 200), [], "every other attempt synced normally");
  assert.equal(recall<Probe>(this, "syncBefore").status, 200, "before the transition the channel synced");
  assert.equal(recall<Probe>(this, "syncAfter").status, 200, "once the transition is complete the channel syncs again");
});

Then("the same channel URI and messages remain after completion", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const roadmap = recall<ChannelRef>(this, "roadmap");
  const entry = await channelNamed(this, "Roadmap");
  assert.deepEqual({ skey: entry.skey, uri: entry.uri, visibility: entry.visibility }, { skey: roadmap.skey, uri: roadmap.uri, visibility: "private" });
  const listing = await owner.page.request.get(`${this.appOrigin}/api/workspaces`);
  const seen = (await listing.json() as { workspaces: Array<{ uri: string; channels: Array<{ uri: string; visibility: string }> }> }).workspaces
    .find((workspace) => workspace.uri === this.workspaceUri)?.channels.find((channel) => channel.uri === roadmap.uri);
  assert.equal(seen?.visibility, "private", "the app lists the same channel URI, now private");
  assert.deepEqual(await messageRecords(this, "kept", roadmap), recall(this, "messagesBefore"), "the same message records are readable after the transition");
  await owner.page.locator(".message-card").filter({ hasText: "Roadmap kickoff" }).waitFor({ state: "visible" });
});

Then("unselected members cannot mint new credentials after completion", async function (this: AppWorld) {
  const roadmap = recall<ChannelRef>(this, "roadmap");
  const outcome = await tryMintAs(this, actorNamed(this, "dropped"), roadmap.uri);
  assert.deepEqual(refusal(outcome), { status: 403, code: "UserNotAuthorized" });
  assert.equal(refusal(await tryMintAs(this, actorNamed(this, "kept"), roadmap.uri)), "granted", "the selected member still can");
});

// --- Archive a channel -------------------------------------------------------------------------------

type MessageRecord = { repo: string; rkey: string; text: unknown };

async function messagesInRepos(world: AppWorld, credential: SpaceCredential): Promise<MessageRecord[]> {
  const found: MessageRecord[] = [];
  for (const role of ["owner", "author"]) {
    const repo = actorNamed(world, role).did;
    for (const record of await readRecordsWith(world, credential, repo, "org.slack.channel.message")) found.push({ repo, rkey: record.rkey, text: record.value.text });
  }
  return found.sort((left, right) => left.rkey.localeCompare(right.rkey));
}

Given("a channel contains messages", async function (this: AppWorld) {
  const owner = await workspaceWithAdmin(this);
  const author = await this.actor("author", 1);
  const reader = await this.actor("reader", 0);
  const room = await createChannelAs(this, owner, "Archive Room", "public");
  await showWorkspaceHome(this, owner);
  await inviteMemberAs(owner, author.did);
  await inviteMemberAs(owner, reader.did);
  await joinWorkspaceAs(this, author);
  assert.equal((await openChannelAs(this, author, "Archive Room")).status, 200, recentCalls(author));
  await postMessageAs(this, author, "Message from the author");
  assert.equal((await openChannelAs(this, owner, "Archive Room")).status, 200);
  await postMessageAs(this, owner, "Message from the owner");
  const held = await grantedCredential(this, reader, room.uri);
  const before = await messagesInRepos(this, held);
  assert.deepEqual(before.map((record) => record.text).sort(), ["Message from the author", "Message from the owner"]);
  assert.deepEqual(before.map((record) => record.repo).sort(), [author.did, owner.did].sort(), "each message lives in its own author's repo");
  remember(this, "archiveRoom", room);
  remember(this, "heldCredential", held);
  remember(this, "messagesBeforeArchive", before);
});

When("an admin archives it", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const room = recall<ChannelRef>(this, "archiveRoom");
  const sampler = sampleTimed(() => readChannel(this, room));
  const executed = await submitAndWait(this, owner, async () => {
    await owner.page.getByRole("button", { name: "Archive", exact: true }).click();
  });
  const readings = await withFinalReading(await sampler.stop(), () => readChannel(this, room));
  assert.equal(executed.operation?.state, "completed", JSON.stringify(executed));
  remember(this, "archive", executed);
  remember(this, "archiveReadings", readings);
});

Then("all channel members are removed before it is marked archived", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const room = recall<ChannelRef>(this, "archiveRoom");
  const readings = recall<Array<Timed<ChannelReading>>>(this, "archiveReadings").map((reading) => reading.value);
  const order = ["public", "transitioning", "archived"];
  const visibilities = readings.map((reading) => reading.visibility!);
  assert.ok(visibilities.every((visibility, index) => index === 0 || order.indexOf(visibility) >= order.indexOf(visibilities[index - 1]!)), `visibility only moves forward: ${visibilities.join(" > ")}`);
  assert.equal(visibilities[0], "public");
  assert.equal(visibilities.at(-1), "archived");
  for (const reading of readings) {
    if (reading.visibility === "archived") assert.deepEqual(reading.members, [], "the directory never said archived while a member could still read");
  }
  assert.ok(readings.some((reading) => reading.visibility === "transitioning" && reading.members.length > 0), "members were still listed when the archive began");
  const members = [actorNamed(this, "author").did, actorNamed(this, "reader").did];
  const steps = requiredJournalEntry(this, recall<Executed>(this, "archive").operationId).steps;
  assert.equal(steps[0], "channel-archive-transition");
  assert.equal(steps.at(-1), "channel-archive-final");
  for (const did of members) {
    assert.ok(steps.indexOf(`channel-archive-remove-${did}`) > 0 && steps.indexOf(`channel-archive-remove-${did}`) < steps.indexOf("channel-archive-verified"), `the journal removes ${did} before verifying`);
  }
  assert.ok(steps.indexOf("channel-archive-verified") < steps.indexOf("channel-archive-final"));
  assert.deepEqual(await membersOf(this, owner, room.uri), [], "the PDS member list is empty");
  assert.equal((await authorityRecord(this, owner, this.workspaceUri, "org.slack.directory", room.skey))?.visibility, "archived");
});

Then("no new channel credentials are issued", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const room = recall<ChannelRef>(this, "archiveRoom");
  for (const role of ["author", "reader"]) {
    const outcome = await tryMintAs(this, actorNamed(this, role), room.uri);
    assert.deepEqual(refusal(outcome), { status: 403, code: "UserNotAuthorized" }, `${role} is refused a credential for the archived channel`);
  }
  const query = new URLSearchParams({ workspace: this.workspaceUri, skey: room.skey, offset: "0" });
  for (const role of ["owner", "author"]) {
    const response = await actorNamed(this, role).page.request.get(`${this.appOrigin}/api/channels/messages?${query}`);
    assert.equal(response.status(), 409, `${role}: the app does not sync an archived channel`);
    assert.match((await response.json() as { error: string }).error, /Archived channels are unavailable/);
  }
  await channelButton(owner, "Archive Room").waitFor({ state: "hidden" });
});

Then("existing messages remain in their authors' repos", async function (this: AppWorld) {
  const author = actorNamed(this, "author");
  const room = recall<ChannelRef>(this, "archiveRoom");
  const before = recall<MessageRecord[]>(this, "messagesBeforeArchive");
  assert.deepEqual(await messagesInRepos(this, recall(this, "heldCredential")), before, "the credential issued before the archive still reads every message from both authors' repos");
  assert.deepEqual(await messagesInRepos(this, await grantedCredential(this, actorNamed(this, "owner"), room.uri)), before, "the workspace authority reads the same messages afterwards");
  const own = await this.pdsGet<{ records?: Array<{ rkey: string; value: { text: string } }> }>(author, "com.atproto.space.listRecords", {
    space: room.uri, repo: author.did, collection: "org.slack.channel.message", limit: "100",
  });
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.deepEqual(own.body.records?.map((record) => record.value.text), ["Message from the author"], "the author's own PDS still holds the author's message");
});

// --- Retry the same operation idempotently / reject operation id reuse -------------------------------

type Journaled = { executed: Executed; hash: string; steps: string[]; updatedAt: number; auditEvents: number; workspaceMembers: string[] };

async function inviteViaUi(world: AppWorld, owner: Actor, did: string): Promise<Executed> {
  await showWorkspaceHome(world, owner);
  const executed = await submitAndWait(world, owner, () => inviteMemberAs(owner, did));
  assert.equal(executed.operation?.state, "completed", JSON.stringify(executed));
  return executed;
}

async function journaledSnapshot(world: AppWorld, executed: Executed): Promise<Journaled> {
  const entry = requiredJournalEntry(world, executed.operationId);
  return {
    executed, hash: entry.requestHash, steps: entry.steps, updatedAt: entry.updatedAt,
    auditEvents: auditTrail(world, executed.operationId).length,
    workspaceMembers: (await membersOf(world, actorNamed(world, "owner"), world.workspaceUri)).map((member) => member.did).sort(),
  };
}

async function postOperation(world: AppWorld, actor: Actor, body: Record<string, unknown>): Promise<Executed> {
  const response = await actor.page.request.post(`${world.appOrigin}/api/operator/execute`, { data: body, headers: { origin: world.appOrigin } });
  return decodeExecuted(response.status(), JSON.stringify(body), await response.text());
}

Given("an operation with a workspace, actor, and operationId is journaled", async function (this: AppWorld) {
  const owner = await workspaceWithAdmin(this);
  const invitee = await this.actor("invitee", 1);
  const executed = await inviteViaUi(this, owner, invitee.did);
  const entry = requiredJournalEntry(this, executed.operationId);
  assert.deepEqual({ workspace: entry.workspace, workspaceUri: entry.workspaceUri, actor: entry.actor, operationId: entry.operationId },
    { workspace: owner.did, workspaceUri: this.workspaceUri, actor: owner.did, operationId: executed.operationId }, "the journal is keyed by workspace, actor and operationId");
  remember(this, "journaled", await journaledSnapshot(this, executed));
});

When("the same request hash is submitted again", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const { executed } = recall<Journaled>(this, "journaled");
  const reordered = { subject: executed.request.subject, kind: executed.request.kind };
  remember(this, "resubmitted", await postOperation(this, owner, { request: reordered, operationId: executed.operationId, workspace: this.workspaceUri }));
});

Then("the existing operation status is returned", async function (this: AppWorld) {
  const before = recall<Journaled>(this, "journaled");
  const again = recall<Executed>(this, "resubmitted");
  assert.equal(again.status, 200, JSON.stringify(again));
  assert.deepEqual(again.operation, before.executed.operation, "the stored status comes back unchanged: same hash, steps and timestamp");
  assert.equal(again.operation?.requestHash, before.hash);
  const after = await journaledSnapshot(this, before.executed);
  assert.deepEqual({ ...after, executed: undefined }, { ...before, executed: undefined }, "nothing ran again: journal row, audit trail and member list are unchanged");
});

Given("an operationId is already bound to a request hash", async function (this: AppWorld) {
  const owner = await workspaceWithAdmin(this);
  const invitee = await this.actor("invitee", 1);
  await this.actor("other", 0);
  const executed = await inviteViaUi(this, owner, invitee.did);
  const snapshot = await journaledSnapshot(this, executed);
  assert.equal(snapshot.hash, requestDigest({ workspace: this.workspaceUri, request: executed.request }), "the journal binds the id to the canonical hash of workspace and request");
  remember(this, "journaled", snapshot);
});

When("another request body uses the same operationId", async function (this: AppWorld) {
  const { executed } = recall<Journaled>(this, "journaled");
  remember(this, "reused", await postOperation(this, actorNamed(this, "owner"), {
    workspace: this.workspaceUri, operationId: executed.operationId, request: { kind: "inviteMember", subject: actorNamed(this, "other").did },
  }));
});

Then("the operator reports a conflict", async function (this: AppWorld) {
  const before = recall<Journaled>(this, "journaled");
  const reused = recall<Executed>(this, "reused");
  assert.equal(reused.status, 409, JSON.stringify(reused));
  assert.equal(reused.error, "OperationIdConflict");
  assert.equal(reused.operation, undefined, "no operation status is returned for the conflicting body");
  const after = await journaledSnapshot(this, before.executed);
  assert.deepEqual({ ...after, executed: undefined }, { ...before, executed: undefined }, "the conflicting request changed nothing");
  const other = actorNamed(this, "other");
  for (const space of await allSpaces(this)) assert.equal(await memberAccess(this, actorNamed(this, "owner"), space.uri, other.did), undefined, `the rejected body did not invite anyone to ${space.label}`);
});

// --- Keep private cached data out of use after access is revoked -------------------------------------

Given("an app cached private-channel data", async function (this: AppWorld) {
  const owner = await workspaceWithAdmin(this);
  const member = await this.actor("member", 1);
  await inviteMemberAs(owner, member.did);
  const vault = await createChannelAs(this, owner, "Vault", "private", [member.did]);
  await joinWorkspaceAs(this, member);
  assert.equal((await openChannelAs(this, member, "Vault")).status, 200, recentCalls(member));
  await postMessageAs(this, member, "Private note");
  const cached = cachedRows(this, member.did);
  assert.ok(cached.records > 0 && cached.cursors > 0 && cached.syncs > 0, `the app cached the private channel for the member: ${JSON.stringify(cached)}`);
  remember(this, "vault", vault);
});

When("the credential can no longer be renewed", async function (this: AppWorld) {
  const member = actorNamed(this, "member");
  const vault = recall<ChannelRef>(this, "vault");
  const executed = await removeMemberViaRoster(this, actorNamed(this, "owner"), member.did);
  assert.equal(executed.operation?.state, "completed", JSON.stringify(executed));
  for (const space of [vault.uri, this.workspaceUri]) {
    const outcome = await tryMintAs(this, member, space);
    assert.deepEqual(refusal(outcome), { status: 403, code: "UserNotAuthorized" }, `renewal is refused for ${space}`);
  }
});

Then("the app stops syncing and purges its cached copy", async function (this: AppWorld) {
  const member = actorNamed(this, "member");
  const vault = recall<ChannelRef>(this, "vault");
  const query = new URLSearchParams({ workspace: this.workspaceUri, skey: vault.skey, offset: "0" });
  const cached = cachedRows(this, member.did);
  assert.ok(cached.records > 0 && cached.cursors > 0 && cached.syncs > 0, `revoking access alone left the cached copy in place, so only the app's refused sync can purge it: ${JSON.stringify(cached)}`);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const sync = await member.page.request.get(`${this.appOrigin}/api/channels/messages?${query}`);
    assert.ok(sync.status() === 401 || sync.status() === 403, `sync attempt ${attempt} is refused (${sync.status()})`);
    assert.doesNotMatch(await sync.text(), /Private note/, "the refusal does not leak the cached message");
    assert.deepEqual(cachedRows(this, member.did), { records: 0, cursors: 0, syncs: 0 }, `after attempt ${attempt} the app holds no cached copy`);
  }
  await member.page.reload();
  await member.page.getByText("No workspaces yet").waitFor({ state: "visible" });
  assert.equal(await member.page.locator(".message-card").count(), 0, "reopening the app shows none of the private messages");
});

// --- Pending admin work: recovered by admins first, never resumed by a member's leave ----------------

type PendingWork = { executed: Executed; entry: JournalEntry; auditEvents: number };

async function leaveAdminOperationPending(world: AppWorld, extraMemberRoles: string[]): Promise<void> {
  const owner = await workspaceWithAdmin(world);
  const victim = await world.actor("victim", 1);
  await world.actor("newcomer", 0);
  const others = await Promise.all(extraMemberRoles.map((role) => world.actor(role, 1)));
  await showWorkspaceHome(world, owner);
  for (const person of [victim, ...others]) await inviteMemberAs(owner, person.did);
  const zulu = await createChannelAs(world, owner, "Zulu Room", "public");
  const executed = await removeWhileChannelIsBroken(world, owner, victim, zulu);
  remember(world, "zulu", zulu);
  remember(world, "pending", { executed, entry: requiredJournalEntry(world, executed.operationId), auditEvents: auditTrail(world, executed.operationId).length } satisfies PendingWork);
}

async function submitInviteViaUi(world: AppWorld, owner: Actor, did: string): Promise<Executed> {
  return submitAndWait(world, owner, async () => {
    await owner.page.getByLabel("Member DID", { exact: true }).fill(did);
    await owner.page.getByRole("button", { name: /Invite member/ }).click();
  });
}

Given("an admin operation remains pending after a partial write", async function (this: AppWorld) {
  await leaveAdminOperationPending(this, []);
});

When("an active admin submits another mutation", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const newcomer = actorNamed(this, "newcomer");
  const zulu = recall<ChannelRef>(this, "zulu");
  const older = recall<PendingWork>(this, "pending");

  const blocked = await submitInviteViaUi(this, owner, newcomer.did);
  remember(this, "blocked", blocked);
  remember(this, "olderAfterBlocked", requiredJournalEntry(this, older.executed.operationId));
  remember(this, "olderAuditAfterBlocked", auditTrail(this, older.executed.operationId).length);

  await repairChannelSpace(this, owner, zulu);
  const retried = await submitAndWait(this, owner, async () => {
    await owner.page.getByRole("button", { name: "Retry same operation ↻" }).click();
  });
  assert.equal(retried.operationId, blocked.operationId, "the retry reuses the newer mutation's own operation ID");
  remember(this, "newer", retried);
});

Then("the operator resumes the older operation first", function (this: AppWorld) {
  const older = recall<PendingWork>(this, "pending");
  const afterBlocked = recall<JournalEntry>(this, "olderAfterBlocked");
  assert.ok(afterBlocked.updatedAt >= older.entry.updatedAt);
  assert.ok(recall<number>(this, "olderAuditAfterBlocked") > older.auditEvents, "the operator tried to resume the older operation when the newer mutation arrived, even though it could not finish it");
  const entry = requiredJournalEntry(this, older.executed.operationId);
  assert.equal(entry.state, "completed", "the older operation was completed by the recovery");
  assert.equal(entry.steps.at(-1), "removal-verified");
  assert.ok(entry.steps.length > older.executed.operation!.completedSteps.length, "it continued from its recorded steps");
  assert.deepEqual(entry.steps.slice(0, older.executed.operation!.completedSteps.length), older.executed.operation!.completedSteps, "without repeating or reordering the steps already recorded");
  assert.equal(entry.actor, actorNamed(this, "owner").did);
});

Then("the newer mutation runs only after the older operation completes", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const newcomer = actorNamed(this, "newcomer");
  const victim = actorNamed(this, "victim");
  const older = recall<PendingWork>(this, "pending");
  const blocked = recall<Executed>(this, "blocked");
  const newer = recall<Executed>(this, "newer");
  const zulu = recall<ChannelRef>(this, "zulu");

  assert.ok(blocked.status >= 400 && blocked.operation === undefined, `while the older operation could not finish, the newer mutation did not run: ${JSON.stringify(blocked)}`);
  assert.match(blocked.error ?? "", new RegExp(`could not be resumed.*${older.executed.operationId}`));
  assert.equal(recall<JournalEntry>(this, "olderAfterBlocked").state, "pending");
  assert.equal(newer.operation?.state, "completed", JSON.stringify(newer));

  const olderTrail = auditTrail(this, older.executed.operationId);
  const newerTrail = auditTrail(this, newer.operationId);
  const olderCompleted = olderTrail.find((event) => event.event === "operationCompleted");
  assert.ok(olderCompleted && newerTrail.length > 0);
  assert.ok(newerTrail.every((event) => event.id > olderCompleted.id), "every event of the newer mutation comes after the older operation completed");
  assert.ok(requiredJournalEntry(this, older.executed.operationId).steps.includes(`remove-channel-${zulu.skey}`), "the older operation itself made the removal the fault had blocked");
  for (const space of await allSpaces(this)) {
    if (space.uri !== zulu.uri) assert.equal(await memberAccess(this, owner, space.uri, victim.did), undefined, `the older removal finished in ${space.label}`);
    if (space.label.startsWith("public channel") || space.label === "workspace") assert.deepEqual(await memberAccess(this, owner, space.uri, newcomer.did), FULL_ACCESS, `and the newer invite applied to ${space.label}`);
  }
});

Given("an admin operation remains pending", async function (this: AppWorld) {
  await leaveAdminOperationPending(this, ["leaver"]);
});

When("a workspace member requests to leave", async function (this: AppWorld) {
  const leaver = actorNamed(this, "leaver");
  remember(this, "pendingBeforeLeave", { entry: requiredJournalEntry(this, recall<PendingWork>(this, "pending").executed.operationId), auditEvents: auditTrail(this, recall<PendingWork>(this, "pending").executed.operationId).length });
  await joinWorkspaceAs(this, leaver);
  const first = await submitAndWait(this, leaver, async () => {
    await leaver.page.getByRole("button", { name: "Leave this workspace" }).click();
  });
  assert.ok(first.status >= 400 && first.operation === undefined, `a member's first leave is refused until they approve the leave permission: ${JSON.stringify(first)}`);
  await leaver.page.getByRole("button", { name: "Authorize leave control →" }).click();
  await completeConsent(leaver);
  await waitForApp(this, leaver);
  const retried = await submitAndWait(this, leaver, async () => {
    await leaver.page.getByRole("button", { name: "Retry same operation ↻" }).click();
  });
  remember(this, "leaveAttempt", retried);
});

Then("the operator returns a busy response", async function (this: AppWorld) {
  const attempt = recall<Executed>(this, "leaveAttempt");
  assert.equal(attempt.status, 503, JSON.stringify(attempt));
  assert.match(attempt.error ?? "", /Pending admin operations must be recovered by an active admin before member leave can proceed/);
  assert.equal(attempt.operation, undefined);
  await actorNamed(this, "leaver").page.getByRole("alert").filter({ hasText: /Pending admin operations must be recovered/ }).waitFor({ state: "visible" });
});

Then("it does not execute the pending admin operation as the member", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const leaver = actorNamed(this, "leaver");
  const victim = actorNamed(this, "victim");
  const older = recall<PendingWork>(this, "pending");
  const before = recall<{ entry: JournalEntry; auditEvents: number }>(this, "pendingBeforeLeave");
  assert.deepEqual(requiredJournalEntry(this, older.executed.operationId), before.entry, "the pending operation's state, steps, error and timestamps are exactly as they were");
  assert.equal(auditTrail(this, older.executed.operationId).length, before.auditEvents, "no attempt to resume it was made on the member's behalf");
  assert.equal(journalRowsFor(this, leaver.did), 0, "the member's own leave request was never journaled");
  assert.deepEqual(await memberAccess(this, owner, this.workspaceUri, victim.did), FULL_ACCESS, "the member being removed was not touched");
  for (const space of await allSpaces(this)) {
    if (space.label.startsWith("public channel Zulu")) continue;
    const expected = space.uri === inboxOf(this) ? INBOX_WRITE_ONLY : FULL_ACCESS;
    assert.deepEqual(await memberAccess(this, owner, space.uri, leaver.did), expected, `the member who asked to leave is still in ${space.label}`);
  }
  assert.equal(await subjectRecordActive(this, owner, this.workspaceUri, "org.slack.workspace.roster", leaver.did), true);
});

// --- Recover a partially completed privacy transition (the operator is really restarted) -------------

type TransitionRecovery = {
  app: OwnApp;
  web: AppWorld;
  roadmap: ChannelRef;
  failed: Executed;
};

Given("a privacy transition failed after any PDS mutation step", async function (this: AppWorld) {
  const app = remember(this, "ownApp", await startOwnApp(this));
  const web = worldOn(this, app);
  const owner = await workspaceWithAdmin(web);
  const kept = await web.actor("kept", 1);
  const dropped = await web.actor("dropped", 0);
  await showWorkspaceHome(web, owner);
  await inviteMemberAs(owner, kept.did);
  await inviteMemberAs(owner, dropped.did);
  const roadmap = await createChannelAs(web, owner, "Roadmap", "public");
  assert.deepEqual(await memberAccess(web, owner, roadmap.uri, dropped.did), FULL_ACCESS);
  assert.equal((await openChannelAs(web, owner, "Roadmap")).status, 200);
  await breakChannelSpace(web, owner, roadmap);
  const failed = await submitAndWait(web, owner, async () => {
    await owner.page.getByLabel("Selected members when making this channel private").fill(kept.did);
    await owner.page.getByRole("button", { name: "Make private", exact: true }).click();
  });
  assert.equal(failed.operation?.state, "pending", JSON.stringify(failed));
  assert.deepEqual(failed.operation?.completedSteps, ["channel-set-transitioning"], "this covers a failure after the first PDS write; failures after later writes are covered by the delegated failure matrix");
  assert.equal((await authorityRecord(web, owner, web.workspaceUri, "org.slack.directory", roadmap.skey))?.visibility, "transitioning");
  await owner.page.getByText("CHANNEL TRANSITION").waitFor({ state: "visible" });
  assert.equal(requiredJournalEntry(web, failed.operationId).state, "pending");
  remember(this, "recovery", { app, web, roadmap, failed } satisfies TransitionRecovery);
});

When("the operator restarts", async function (this: AppWorld) {
  const { app, web, roadmap } = recall<TransitionRecovery>(this, "recovery");
  const owner = actorNamed(this, "owner");
  await repairChannelSpace(web, owner, roadmap);
  const sampler = sampleTimed(() => readChannel(web, roadmap));
  await app.restart();
  remember(this, "afterRestart", await readChannel(web, roadmap));
  const reconcile = await runReconcileJob(app);
  const readings = await withFinalReading(await sampler.stop(), () => readChannel(web, roadmap));
  remember(this, "reconcile", reconcile);
  remember(this, "recoveryReadings", readings.map((reading) => reading.value));
});

Then("the journal resumes the desired state", async function (this: AppWorld) {
  const { web, roadmap, failed } = recall<TransitionRecovery>(this, "recovery");
  const owner = actorNamed(this, "owner");
  const kept = actorNamed(this, "kept");
  const dropped = actorNamed(this, "dropped");
  const reconcile = recall<ReconcileRun>(this, "reconcile");
  assert.equal(reconcile.exitCode, 0, reconcile.stderr);
  assert.match(reconcile.stdout, new RegExp(`${escapeRegExp(web.workspaceUri)}: completed`));

  const entry = requiredJournalEntry(web, failed.operationId);
  assert.equal(entry.state, "completed", "the interrupted operation itself was resumed");
  assert.deepEqual(entry.steps.slice(0, 1), ["channel-set-transitioning"], "it kept the step it had already made");
  assert.equal(entry.steps.at(-1), "channel-set-final-visibility");
  assert.ok(entry.steps.indexOf("channel-visibility-verified") < entry.steps.indexOf("channel-set-final-visibility"));
  const transitions = web.withAppDatabase((db) => (db.prepare("SELECT count(*) AS count FROM operation WHERE request_json LIKE '%transitionChannel%'").get() as { count: number }).count);
  assert.equal(transitions, 1, "recovery resumed the journaled operation instead of starting a second one");

  assert.equal((await authorityRecord(web, owner, web.workspaceUri, "org.slack.directory", roadmap.skey))?.visibility, "private");
  assert.deepEqual(await memberAccess(web, owner, roadmap.uri, kept.did), FULL_ACCESS);
  assert.equal(await memberAccess(web, owner, roadmap.uri, dropped.did), undefined);
  assert.equal(await subjectRecordActive(web, owner, roadmap.uri, "org.slack.channel.roster", kept.did), true);

  await owner.page.reload();
  await channelButton(owner, "Roadmap").waitFor({ state: "visible" });
  assert.match(await channelButton(owner, "Roadmap").innerText(), /▣/, "after the restart the app lists the channel as private");
});

Then("the channel remains transitioning until all member lists agree", function (this: AppWorld) {
  const { failed, web } = recall<TransitionRecovery>(this, "recovery");
  const kept = actorNamed(this, "kept");
  const afterRestart = recall<ChannelReading>(this, "afterRestart");
  assert.equal(afterRestart.visibility, "transitioning", "restarting the operator by itself did not publish the new visibility");
  assert.deepEqual(afterRestart.members, [], "the member list had not yet converged to the desired state");
  const readings = recall<ChannelReading[]>(this, "recoveryReadings");
  for (const reading of readings) {
    if (reading.visibility === "private") assert.deepEqual(reading.members, [kept.did], "the directory said private only once the member list matched the selection");
  }
  assert.equal(readings.at(-1)?.visibility, "private");
  const events = auditTrail(web, failed.operationId).map((event) => event.event);
  assert.ok(events.indexOf("channel-visibility-verified") < events.indexOf("channel-set-final-visibility"), "the journal verified the member lists before publishing the final visibility");
});

// --- Recover after every injected mutation failure (delegated to the protocol acceptance matrix) -----

const ACCEPTANCE_TEST = "protocol-tests/app-acceptance.test.ts";
const ACCEPTANCE_STEP_TIMEOUT_MS = 1_500_000;
const ACCEPTANCE_DEADLINE_MS = ACCEPTANCE_STEP_TIMEOUT_MS - 30_000;
type AcceptanceRun = { exitCode: number | null; signal: NodeJS.Signals | null; output: string };
let acceptanceRun: Promise<AcceptanceRun> | undefined;
const acceptanceChildren = new Set<ChildProcess>();

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    process.kill(-child.pid!, signal);
  } catch {
    child.kill(signal);
  }
}

function killAcceptanceChildren(): void {
  for (const child of acceptanceChildren) killProcessGroup(child, "SIGKILL");
  acceptanceChildren.clear();
}

process.once("exit", killAcceptanceChildren);

/** Injected PDS write failures and real process restarts exist only in the protocol acceptance test, so it is run once per cucumber process, in its own process group so a timeout can kill the apps it started too. */
function runAcceptanceMatrix(): Promise<AcceptanceRun> {
  acceptanceRun ??= new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--test", "--test-reporter=spec", ACCEPTANCE_TEST], {
      cwd: process.cwd(), env: { ...process.env, NODE_OPTIONS: "" }, stdio: ["ignore", "pipe", "pipe"], detached: true,
    });
    acceptanceChildren.add(child);
    const deadline = setTimeout(() => killProcessGroup(child, "SIGKILL"), ACCEPTANCE_DEADLINE_MS);
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      clearTimeout(deadline);
      acceptanceChildren.delete(child);
      resolve({ exitCode, signal, output });
    });
  });
  return acceptanceRun;
}

Given("an admin operation can fail after each PDS write", function (this: AppWorld) {
  assert.ok(statSync(ACCEPTANCE_TEST).isFile(), "the protocol acceptance test is available");
});

When("a failure is injected and the operator restarts", { timeout: ACCEPTANCE_STEP_TIMEOUT_MS }, async function (this: AppWorld) {
  remember(this, "acceptance", await runAcceptanceMatrix());
});

Then("the operation remains visibly pending until state converges", function (this: AppWorld) {
  const { exitCode, signal, output } = recall<AcceptanceRun>(this, "acceptance");
  assert.equal(exitCode, 0, `exit ${exitCode} signal ${signal}\n${output.slice(-4_000)}`);
  assert.match(output, /✔ app acceptance across two real PDS hosts and journal restart/);
  assert.match(output, /ℹ pass 1\b/);
  assert.match(output, /ℹ fail 0\b/);
});

After(async function (this: AppWorld) {
  killAcceptanceChildren();
  const app = this.scratch.get("ownApp") as OwnApp | undefined;
  await app?.stop();
});
