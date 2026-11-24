import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { After, Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@playwright/test";
import type { SpaceCredential } from "@flock/protocol/atproto/space-credential-core";
import { requestDigest, tidNow } from "@flock/protocol/keys";
import type { Actor, AppWorld } from "../support/world";
import { inviteMemberAs, eventually } from "../support/ui";
import {
  MAX_CREDENTIAL_LIFETIME_SECONDS, actorNamed, allSpaces, auditTrail, authorityRecord, breakMembershipDeletes,
  breakMembershipWrites, channelButton, channelNamed, claimsOf, createChannelAs, eventuallyAsync, grantedCredential,
  hasActivePrivateChannelRole, hasActiveWorkspaceMembership, inboxOf, joinWorkspaceAs, journalEntry, journalRowsFor,
  memberAccess, membersOf, readRecordsWith, recall, refusal, remember, removeMemberViaRoster, repairMembershipDeletes,
  repairMembershipWrites, requiredJournalEntry, runReconcileJob, sampleTimed, sampleWhile, showWorkspaceHome, startOwnApp,
  tryMintAs, tryReadWith, withExtendedExpiry, withFinalReading, withSignedExpiry, workspaceWithAdmin, worldOn,
  type ChannelRef, type JournalEntry, type OwnApp, type ReconcileRun, type Timed,
} from "../support/lifecycle-ui";
import { groupDidOf } from "../support/group-state";
import { browserStore, browserStoreAt, type BrowserStore } from "../support/browser-store";
import { credentialCalls, credentialOutcome, messageCollection, openChannel, postMessage, sidebarChannel, writeOwnRecords } from "../support/channels-ui";
import { engineAs, probeChannelRead, type ReadProbe } from "../support/engine";
import { executeAs, submitAndWait, type Executed } from "../support/operator-calls";
import { workspaceRead } from "../support/independent-app-ui";
import { BROWSER_CLIENT_METADATA_PATH } from "@flock/web/browser/client-metadata";

type Space = { label: string; uri: string };
type RemovalSample = { state: string | undefined; present: Record<string, boolean> };

const FULL_ACCESS = { read: true, write: true };
const READ_ONLY = { read: true, write: false };
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

/** Expected OpenSocial access for an ordinary non-admin human member across workspace spaces. */
function expectedAccess(space: Space, world: AppWorld): { read: boolean; write: boolean } {
  if (space.uri === inboxOf(world)) return INBOX_WRITE_ONLY;
  if (space.uri === world.workspaceUri) return READ_ONLY;
  return FULL_ACCESS;
}

// --- Remove a workspace member from Group Host governance --------------------------------------------

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
  assert.equal(spaces.length, 6, "group members, workspace, inbox, two public channels and one private channel");
  for (const person of [member, bystander]) {
    for (const space of spaces) {
      assert.deepEqual(await memberAccess(this, owner, space.uri, person.did), expectedAccess(space, this), `${person.role} in ${space.label}`);
    }
    assert.equal(hasActiveWorkspaceMembership(this, person.did), true);
    assert.equal(hasActivePrivateChannelRole(this, privateRoom.skey, person.did), true);
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

Then("their Group Host membership record is removed and access is revoked", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const member = actorNamed(this, "member");
  const bystander = actorNamed(this, "bystander");
  const spaces = recall<Space[]>(this, "spaces");
  for (const space of spaces) {
    assert.equal(await memberAccess(this, owner, space.uri, member.did), undefined, `the removed member is gone from ${space.label}`);
    assert.deepEqual(await memberAccess(this, owner, space.uri, bystander.did), expectedAccess(space, this), `removal left the other member untouched in ${space.label}`);
  }
  const steps = requiredJournalEntry(this, recall<Executed>(this, "removal").operationId).steps;
  assert.deepEqual(steps, ["remove-workspace-membership", "removal-verified"]);
});

Then("the workspace and private rosters become inactive", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const member = actorNamed(this, "member");
  const bystander = actorNamed(this, "bystander");
  const privateRoom = recall<ChannelRef>(this, "privateRoom");
  assert.equal(hasActiveWorkspaceMembership(this, member.did), false);
  assert.equal(hasActivePrivateChannelRole(this, privateRoom.skey, member.did), false);
  assert.equal(hasActiveWorkspaceMembership(this, bystander.did), true);
  assert.equal(hasActivePrivateChannelRole(this, privateRoom.skey, bystander.did), true);
  await showWorkspaceHome(this, owner);
  await owner.page.locator(".roster-row").filter({ hasText: bystander.did }).waitFor({ state: "visible" });
  await owner.page.locator(".roster-row").filter({ hasText: member.did }).waitFor({ state: "hidden" });
});

Then("the operation stays pending until Group Host membership removal is verified", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const member = actorNamed(this, "member");
  const removal = recall<Executed>(this, "removal");
  const samples = recall<RemovalSample[]>(this, "removalSamples");
  const completed = samples.filter((sample) => sample.state === "completed");
  assert.ok(completed.length > 0, "the operation was observed completed");
  for (const sample of completed) assert.deepEqual(Object.values(sample.present).filter(Boolean), [], "completed was never reported while Group Host membership still granted access");
  const entry = requiredJournalEntry(this, removal.operationId);
  assert.equal(entry.state, "completed");
  assert.equal(entry.steps.at(-1), "removal-verified", "the last recorded step is the check that membership removal converged");
  const events = auditTrail(this, removal.operationId).map((event) => event.event);
  assert.equal(events.filter((event) => event === "operationCompleted").length, 1);
  assert.deepEqual(events.slice(-2), ["removal-verified", "operationCompleted"], "completion is recorded only after the verification step");
  assert.ok(events.indexOf("remove-workspace-membership") < events.indexOf("removal-verified"));
  assert.equal(removalState(this, member.did), "completed");

  const bystander = actorNamed(this, "bystander");
  breakMembershipDeletes(this);
  const stuck = await removeMemberViaRoster(this, owner, bystander.did);
  assert.equal(stuck.status, 200, JSON.stringify(stuck));
  assert.equal(stuck.operation?.state, "pending", `while membership deletion fails the operation stays pending: ${JSON.stringify(stuck)}`);
  await owner.page.getByText(/Operation .* is still pending\./).waitFor({ state: "visible" });
  assert.equal(removalState(this, bystander.did), "pending");

  repairMembershipDeletes(this);
  const resumed = await submitAndWait(this, owner, async () => {
    await owner.page.getByRole("button", { name: "Retry same operation ↻" }).click();
  });
  assert.equal(resumed.operationId, stuck.operationId);
  assert.equal(resumed.operation?.state, "completed", JSON.stringify(resumed));
  for (const space of await allSpaces(this)) {
    assert.equal(await memberAccess(this, owner, space.uri, bystander.did), undefined, `it completed only once ${space.label} converged`);
  }
  const resumedSteps = requiredJournalEntry(this, stuck.operationId).steps;
  assert.deepEqual(resumedSteps, ["remove-workspace-membership", "removal-verified"]);
});

// --- An old credential expires after removal --------------------------------------------------------

Given("a member holds a space credential with a short maximum lifetime", async function (this: AppWorld) {
  const owner = await workspaceWithAdmin(this);
  const member = await this.actor("member", 1);
  const bystander = await this.actor("bystander", 0);
  await inviteMemberAs(owner, member.did);
  await inviteMemberAs(owner, bystander.did);
  const general = (await allSpaces(this)).find((space) => space.label.startsWith("public channel"));
  assert.ok(general, "the workspace has a public channel");
  const spaces = [{ label: "workspace", uri: this.workspaceUri }, general];
  remember(this, "credentialSpaces", spaces);
  const groupDid = groupDidOf(this);
  const mintedAt = Date.now();
  const held = await Promise.all(spaces.map(async (space) => grantedCredential(this, member, space.uri)));
  remember(this, "heldCredentials", held);
  for (const credential of held) {
    const claims = claimsOf(credential.token);
    assert.equal(claims.sub, credential.space);
    assert.equal(claims.iss, groupDid, "the group authority signed it");
    assert.ok(claims.exp - claims.iat <= MAX_CREDENTIAL_LIFETIME_SECONDS, `lifetime ${claims.exp - claims.iat}s exceeds the one hour protocol ceiling`);
    assert.ok(claims.exp - claims.iat > 0);
    assert.ok(claims.exp * 1000 > Date.now(), "it has not expired");
    assert.ok(claims.exp * 1000 <= mintedAt + MAX_CREDENTIAL_LIFETIME_SECONDS * 1000 + 5_000, "it was minted just now, so its expiry is at most the one hour ceiling away");
  }
  const directory = await readRecordsWith(this, held[0]!, groupDid, "new.flock.directory");
  assert.equal(directory.length, 1, "before removal the credential reads the workspace directory");
});

When("the member is removed", async function (this: AppWorld) {
  const executed = await removeMemberViaRoster(this, actorNamed(this, "owner"), actorNamed(this, "member").did);
  assert.equal(executed.operation?.state, "completed", JSON.stringify(executed));
});

Then("they cannot obtain a new credential", async function (this: AppWorld) {
  const member = actorNamed(this, "member");
  const bystander = actorNamed(this, "bystander");
  for (const space of recall<Space[]>(this, "credentialSpaces")) {
    assert.deepEqual(refusal(await tryMintAs(this, member, space.uri)), { status: 403, code: "SpaceNotFound" }, `removed member, ${space.label}`);
    assert.equal(refusal(await tryMintAs(this, bystander, space.uri)), "granted", `a member who was not removed can still mint for ${space.label}`);
  }
});

Then("the old credential works only until its signed expiration", async function (this: AppWorld) {
  const bystander = actorNamed(this, "bystander");
  const [workspaceCredential, generalCredential] = recall<SpaceCredential[]>(this, "heldCredentials");
  assert.ok(workspaceCredential && generalCredential);
  const claims = claimsOf(generalCredential.token);
  assert.ok(claims.exp * 1000 > Date.now(), "the old credential is still inside its signed lifetime");
  assert.ok(claims.exp - claims.iat <= MAX_CREDENTIAL_LIFETIME_SECONDS, "its signed lifetime is at most the one hour ceiling");

  // Group Host itself immediately revokes issued credentials upon membership removal; an unnotified peer PDS (bystander on host 0,
  // which had not yet written to general when member on host 1 was removed) enforces the signed expiration cryptographically.
  await writeOwnRecords(this, bystander, generalCredential.space, [
    { collection: messageCollection, rkey: tidNow(), value: { text: "Note on bystander PDS", createdAt: new Date().toISOString() } },
  ]);
  const readBystanderMessages = (credential: SpaceCredential) => tryReadWith(this, credential, bystander.did, messageCollection);
  assert.deepEqual(await readBystanderMessages(generalCredential), { records: 1 }, "an unnotified repo host honors an already-issued credential inside its signed lifetime");

  assert.deepEqual(
    await readBystanderMessages(withExtendedExpiry(this, generalCredential, 600)),
    { refused: { status: 401, code: "BadJwtSignature" } },
    "stretching the signed expiry breaks the signature, so the expiry the group authority signed is the only limit",
  );

  const expiresAt = Math.floor(Date.now() / 1000) + SHORT_LIFETIME_SECONDS;
  const shortLived = await withSignedExpiry(this, generalCredential, expiresAt);
  assert.deepEqual(await readBystanderMessages(shortLived), { records: 1 }, "signed by the group authority with a near expiry, the credential still reads before expiration");
  assert.ok(Date.now() < expiresAt * 1000, "that read happened inside the signed lifetime");

  const refused = await eventuallyAsync(async () => {
    const attempt = await readBystanderMessages(shortLived);
    return "refused" in attempt ? { ...attempt.refused, at: Date.now() } : undefined;
  }, { what: "the PDS to refuse the credential after its signed expiration", timeoutMs: 30_000 });
  assert.deepEqual({ status: refused.status, code: refused.code }, { status: 401, code: "JwtExpired" }, "after its signed expiration the PDS refuses it as expired");
  assert.ok(refused.at >= expiresAt * 1000, "it was refused only once its signed expiration had passed");
  assert.ok(refused.at < expiresAt * 1000 + EXPIRY_GRACE_MS, "and refused as soon as it passed, with no grace period");
  assert.deepEqual(await readBystanderMessages(shortLived), { refused: { status: 401, code: "JwtExpired" } }, "it stays refused");
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
  assert.equal(hasActivePrivateChannelRole(this, room.skey, member.did), true);
  await openChannel(member, "Private Room");
  await member.page.getByRole("button", { name: "Leave private channel" }).waitFor({ state: "visible" });
});

When("they leave that channel", async function (this: AppWorld) {
  const member = actorNamed(this, "member");
  const left = await submitAndWait(this, member, async () => {
    await member.page.getByRole("button", { name: "Leave private channel" }).click();
  });
  assert.equal(left.operation?.state, "completed", JSON.stringify(left));
  await member.page.getByText("WORKSPACE HOME").waitFor({ state: "visible" });
  remember(this, "leave", left);
});

Then("channel access and the private roster entry are removed", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const member = actorNamed(this, "member");
  const bystander = actorNamed(this, "bystander");
  const room = recall<ChannelRef>(this, "privateRoom");
  assert.equal(await memberAccess(this, owner, room.uri, member.did), undefined);
  assert.equal(hasActivePrivateChannelRole(this, room.skey, member.did), false);
  assert.deepEqual(await memberAccess(this, owner, room.uri, bystander.did), FULL_ACCESS, "other members keep the channel");
  assert.equal(hasActivePrivateChannelRole(this, room.skey, bystander.did), true);
  const outcome = await tryMintAs(this, member, room.uri);
  assert.deepEqual(refusal(outcome), { status: 403, code: "SpaceNotFound" });
  const steps = requiredJournalEntry(this, recall<Executed>(this, "leave").operationId).steps;
  assert.deepEqual(steps, ["leave-channel-membership", "leave-channel-verified"]);
  const since = member.xrpc.length;
  await openChannel(member, "Private Room");
  const reopened = await eventually(() => credentialCalls(member, room.uri, since).length > 0 && credentialCalls(member, room.uri, since), { what: "the member's next look at the channel" });
  assert.deepEqual([...new Set(reopened.map(credentialOutcome))], ["SpaceNotFound"], "the app no longer syncs the channel for them: the Group Host refuses its credential");
  await member.page.getByText("You are not on this channel’s active roster.").waitFor({ state: "visible" });
  assert.equal(await member.page.locator(".message-card").count(), 0, "none of the channel's messages are shown");
});

Then("workspace access remains active", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const member = actorNamed(this, "member");
  const spaces = (await allSpaces(this)).filter((space) => !space.label.startsWith("private channel"));
  for (const space of spaces) {
    assert.deepEqual(await memberAccess(this, owner, space.uri, member.did), expectedAccess(space, this), `still in ${space.label}`);
  }
  assert.equal(hasActiveWorkspaceMembership(this, member.did), true);
  assert.equal(refusal(await tryMintAs(this, member, this.workspaceUri)), "granted", "they can still mint a workspace credential");
  const since = member.xrpc.length;
  await member.page.goto(this.appOrigin);
  await member.page.getByRole("heading", { name: this.workspaceName, exact: true }).waitFor({ state: "visible" });
  const read = await eventually(() => workspaceRead(member, this.workspaceUri, since), { what: "the member's app to read the roster" });
  assert.ok(read.members.includes(member.did), "the member's app reads them on the workspace roster");
  assert.equal(journalEntry(this, recall<Executed>(this, "leave").operationId)?.request.kind, "leaveChannel", "only the channel was left, not the workspace");
});

// --- Make a public channel private -------------------------------------------------------------------

type ChannelReading = { visibility: string | undefined; members: string[] };

async function readChannel(world: AppWorld, channel: ChannelRef): Promise<ChannelReading> {
  const owner = actorNamed(world, "owner");
  const [entry, members] = await Promise.all([
    authorityRecord(world, owner, world.workspaceUri, "new.flock.directory", channel.skey),
    membersOf(world, owner, channel.uri),
  ]);
  return { visibility: entry?.visibility as string | undefined, members: members.map((member) => member.did) };
}

async function messageRecords(world: AppWorld, viewerRole: string, channel: ChannelRef): Promise<Array<{ rkey: string; text: unknown }>> {
  const owner = actorNamed(world, "owner");
  const credential = await grantedCredential(world, actorNamed(world, viewerRole), channel.uri);
  return (await readRecordsWith(world, credential, owner.did, "new.flock.channel.message")).map((record) => ({ rkey: record.rkey, text: record.value.text }));
}

Given("a public channel has current workspace members", async function (this: AppWorld) {
  const owner = await workspaceWithAdmin(this);
  const kept = await this.actor("kept", 1);
  const dropped = await this.actor("dropped", 0);
  const roadmap = await createChannelAs(this, owner, "Roadmap", "public");
  await showWorkspaceHome(this, owner);
  await inviteMemberAs(owner, kept.did);
  await inviteMemberAs(owner, dropped.did);
  await openChannel(owner, "Roadmap");
  await postMessage(owner, "Roadmap kickoff");
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
  const ownerApp = engineAs(this, owner);
  const probeSync = () => probeChannelRead(ownerApp, { workspace: this.workspaceUri, skey: roadmap.skey });
  remember(this, "syncBefore", await probeSync());
  const sampler = sampleTimed(() => readChannel(this, roadmap));
  const probers = [1, 2, 3].map(() => sampleTimed(probeSync));
  const executed = await submitAndWait(this, owner, async () => {
    await owner.page.getByLabel("Selected members when making this channel private").fill(`${owner.did}, ${kept.did}`);
    await owner.page.getByRole("button", { name: "Make private", exact: true }).click();
  });
  const readings = await withFinalReading(await sampler.stop(), () => readChannel(this, roadmap));
  const probes = (await Promise.all(probers.map((prober) => prober.stop()))).flat();
  assert.equal(executed.operation?.state, "completed", JSON.stringify(executed));
  remember(this, "syncAfter", await probeSync());
  remember(this, "transition", executed);
  remember(this, "channelReadings", readings);
  remember(this, "syncProbes", probes);
});

Then("the directory shows transitioning while membership changes", function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const kept = actorNamed(this, "kept");
  const dropped = actorNamed(this, "dropped");
  const expectedPrivate = [owner.did, kept.did].sort();
  const readings = recall<Array<Timed<ChannelReading>>>(this, "channelReadings");
  const visibilities = readings.map((reading) => reading.value.visibility);
  const order = ["public", "transitioning", "private"];
  assert.ok(visibilities.every((visibility, index) => index === 0 || order.indexOf(visibility!) >= order.indexOf(visibilities[index - 1]!)), `visibility only moves forward: ${visibilities.join(" > ")}`);
  assert.equal(visibilities[0], "public");
  assert.equal(visibilities.at(-1), "private");
  assert.ok(visibilities.includes("transitioning"), "the directory was observed as transitioning while the operation ran");
  for (const reading of readings) {
    if (reading.value.visibility === "private") {
      assert.ok(!reading.value.members.includes(dropped.did), "the directory never said private while an unselected member could still read");
      assert.deepEqual([...reading.value.members].sort(), expectedPrivate, "the directory never said private before selected members converged");
    }
  }
  assert.ok(
    readings.some((reading) => reading.value.visibility === "transitioning" && reading.value.members.join() !== expectedPrivate.join()),
    "membership was still changing while the transition was announced",
  );
  const steps = requiredJournalEntry(this, recall<Executed>(this, "transition").operationId).steps;
  assert.equal(steps[0], "channel-set-transitioning");
  assert.equal(steps.at(-1), "channel-set-final-visibility");
  assert.ok(steps.indexOf(`channel-private-add-${kept.did}`) > 0 && steps.indexOf(`channel-private-add-${kept.did}`) < steps.indexOf("channel-visibility-verified"));
});

Then("compliant apps stop new syncs during the transition", function (this: AppWorld) {
  const readings = recall<Array<Timed<ChannelReading>>>(this, "channelReadings");
  const probes = recall<Array<Timed<ReadProbe>>>(this, "syncProbes");
  const transitioning = readings.filter((reading) => reading.value.visibility === "transitioning");
  const windowStart = transitioning[0]!.finishedAt;
  const windowEnd = transitioning.at(-1)!.startedAt;
  const refused = probes.filter((probe) => probe.value.status === 409);
  assert.ok(refused.length > 0, "the app refused at least one sync attempt made while the directory showed transitioning");
  for (const probe of refused) assert.match(probe.value.error ?? "", /transitioning/, "it refused because of the transition");
  const isTransitionStop = (probe: Timed<ReadProbe>) =>
    probe.value.status === 409 ||
    ((probe.value.status === 401 || probe.value.status === 403) &&
      /Space credential has been revoked|Space not found/i.test(probe.value.error ?? ""));
  const during = probes.filter((probe) => probe.startedAt >= windowStart && probe.finishedAt <= windowEnd);
  if (during.length > 0) {
    assert.deepEqual(during.filter((probe) => !isTransitionStop(probe)), [], "no sync attempt that fell wholly inside the transition succeeded");
  }
  assert.deepEqual(probes.filter((probe) => !isTransitionStop(probe) && probe.value.status !== 200), [], "every other attempt synced normally or stopped on credential revocation");
  assert.equal(recall<ReadProbe>(this, "syncBefore").status, 200, "before the transition the channel synced");
  assert.equal(recall<ReadProbe>(this, "syncAfter").status, 200, "once the transition is complete the channel syncs again");
});

Then("the same channel URI and the messages of the remaining members remain after completion", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const roadmap = recall<ChannelRef>(this, "roadmap");
  const entry = await channelNamed(this, "Roadmap");
  assert.deepEqual({ skey: entry.skey, uri: entry.uri, visibility: entry.visibility }, { skey: roadmap.skey, uri: roadmap.uri, visibility: "private" });
  await expect(sidebarChannel(owner, "Roadmap")).toHaveText(/^▣/, { timeout: 60_000 });
  assert.deepEqual(await messageRecords(this, "kept", roadmap), recall(this, "messagesBefore"), "the same message records are readable after the transition");
  await owner.page.locator(".message-card").filter({ hasText: "Roadmap kickoff" }).waitFor({ state: "visible" });
});

Then("unselected members cannot mint new credentials after completion", async function (this: AppWorld) {
  const roadmap = recall<ChannelRef>(this, "roadmap");
  const outcome = await tryMintAs(this, actorNamed(this, "dropped"), roadmap.uri);
  assert.deepEqual(refusal(outcome), { status: 403, code: "SpaceNotFound" });
  assert.equal(refusal(await tryMintAs(this, actorNamed(this, "kept"), roadmap.uri)), "granted", "the selected member still can");
});

// --- Archive a channel -------------------------------------------------------------------------------

type MessageRecord = { repo: string; rkey: string; text: unknown };

async function messagesInRepos(world: AppWorld, credential: SpaceCredential): Promise<MessageRecord[]> {
  const found: MessageRecord[] = [];
  for (const role of ["owner", "author"]) {
    const repo = actorNamed(world, role).did;
    for (const record of await readRecordsWith(world, credential, repo, "new.flock.channel.message")) found.push({ repo, rkey: record.rkey, text: record.value.text });
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
  await openChannel(author, "Archive Room");
  await postMessage(author, "Message from the author");
  await openChannel(owner, "Archive Room");
  await postMessage(owner, "Message from the owner");
  const held = await grantedCredential(this, reader, room.uri);
  const before = await messagesInRepos(this, held);
  assert.deepEqual(before.map((record) => record.text).sort(), ["Message from the author", "Message from the owner"]);
  assert.deepEqual(before.map((record) => record.repo).sort(), [author.did, owner.did].sort(), "each message lives in its own author's repo");
  remember(this, "archiveRoom", room);
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

Then("all channel policy role grants are removed before it is marked archived", async function (this: AppWorld) {
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
  const steps = requiredJournalEntry(this, recall<Executed>(this, "archive").operationId).steps;
  assert.equal(steps[0], "channel-archive-transition");
  assert.equal(steps.at(-1), "channel-archive-final");
  assert.ok(steps.indexOf("channel-archive-verified") > 0 && steps.indexOf("channel-archive-verified") < steps.indexOf("channel-archive-final"));
  assert.deepEqual(await membersOf(this, owner, room.uri), [], "the channel policy grants list is empty");
  assert.equal((await authorityRecord(this, owner, this.workspaceUri, "new.flock.directory", room.skey))?.visibility, "archived");
});

Then("no new channel credentials are issued", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const room = recall<ChannelRef>(this, "archiveRoom");
  for (const role of ["owner", "author", "reader"]) {
    const outcome = await tryMintAs(this, actorNamed(this, role), room.uri);
    assert.deepEqual(refusal(outcome), { status: 403, code: "SpaceNotFound" }, `${role} is refused a credential for the archived channel`);
  }
  for (const role of ["owner", "author"]) {
    const probe = await probeChannelRead(engineAs(this, actorNamed(this, role)), { workspace: this.workspaceUri, skey: room.skey });
    assert.equal(probe.status, 409, `${role}: the app does not sync an archived channel`);
    assert.match(probe.error ?? "", /Archived channels are unavailable/);
  }
  await channelButton(owner, "Archive Room").waitFor({ state: "hidden" });
});

Then("existing messages remain in their authors' repos", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const author = actorNamed(this, "author");
  const room = recall<ChannelRef>(this, "archiveRoom");
  const before = recall<MessageRecord[]>(this, "messagesBeforeArchive");

  const stored: MessageRecord[] = [];
  for (const person of [owner, author]) {
    const own = await this.pdsGet<{ records?: Array<{ rkey: string; value: { text: string } }> }>(person, "com.atproto.space.listRecords", {
      space: room.uri, repo: person.did, collection: "new.flock.channel.message", limit: "100",
    });
    assert.equal(own.status, 200, JSON.stringify(own.body));
    for (const record of own.body.records ?? []) {
      stored.push({ repo: person.did, rkey: record.rkey, text: record.value.text });
    }
  }
  stored.sort((left, right) => left.rkey.localeCompare(right.rkey));
  assert.deepEqual(stored, before, "archiving the channel leaves every author's message intact in their own PDS repo");
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

Given("an operation with a workspace, actor, and operationId is journaled", async function (this: AppWorld) {
  const owner = await workspaceWithAdmin(this);
  const invitee = await this.actor("invitee", 1);
  const executed = await inviteViaUi(this, owner, invitee.did);
  const entry = requiredJournalEntry(this, executed.operationId);
  assert.deepEqual({ workspace: entry.workspace, workspaceUri: entry.workspaceUri, actor: entry.actor, operationId: entry.operationId },
    { workspace: groupDidOf(this), workspaceUri: this.workspaceUri, actor: owner.did, operationId: executed.operationId }, "the journal is keyed by workspace group DID, actor and operationId");
  remember(this, "journaled", await journaledSnapshot(this, executed));
});

When("the same request hash is submitted again", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const { executed } = recall<Journaled>(this, "journaled");
  const reordered = { subject: executed.request.subject, kind: executed.request.kind };
  remember(this, "resubmitted", await executeAs(this, owner, { request: reordered, operationId: executed.operationId, workspace: this.workspaceUri }));
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
  remember(this, "reused", await executeAs(this, actorNamed(this, "owner"), {
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
  await openChannel(member, "Vault");
  await postMessage(member, "Private note");
  const held = heldCopy(await browserStoreAt(member, this.appOrigin), vault.uri);
  assert.ok(held.records > 0 && held.space, `the app holds the private channel for the member in their browser: ${JSON.stringify(held)}`);
  remember(this, "vault", vault);
});

When("the credential can no longer be renewed", async function (this: AppWorld) {
  const member = actorNamed(this, "member");
  const vault = recall<ChannelRef>(this, "vault");
  assert.equal(new URL(member.page.url()).pathname, BROWSER_CLIENT_METADATA_PATH);
  const executed = await removeMemberViaRoster(this, actorNamed(this, "owner"), member.did);
  assert.equal(executed.operation?.state, "completed", JSON.stringify(executed));
  for (const space of [vault.uri, this.workspaceUri]) {
    const outcome = await tryMintAs(this, member, space);
    assert.deepEqual(refusal(outcome), { status: 403, code: "SpaceNotFound" }, `renewal is refused for ${space}`);
  }
});

/** What the account's browser store holds of one space. */
function heldCopy(store: BrowserStore, space: string): { records: number; space: boolean } {
  return { records: store.records.filter((record) => record.space === space).length, space: store.spaces.includes(space) };
}

Then("the app stops syncing and purges its cached copy", async function (this: AppWorld) {
  const member = actorNamed(this, "member");
  const vault = recall<ChannelRef>(this, "vault");
  const before = heldCopy(await browserStoreAt(member, this.appOrigin), vault.uri);
  assert.ok(before.records > 0 && before.space, `revoking access alone left the browser's copy in place, so only the app's refused sync can purge it: ${JSON.stringify(before)}`);
  const since = member.xrpc.length;
  await member.page.goto(this.appOrigin);
  await eventuallyAsync(async () => {
    const held = heldCopy(await browserStore(member), vault.uri);
    return held.records === 0 && !held.space;
  }, { what: "the reopened app to purge its copy of the private channel" });
  await member.page.getByText("No workspaces yet").waitFor({ state: "visible" });
  assert.equal(await member.page.locator(".message-card").count(), 0, "reopening the app shows none of the private messages");
  const reads = member.xrpc.slice(since);
  assert.deepEqual(reads.filter((call) => call.status === 200 && new URLSearchParams(call.query).get("space") === vault.uri).map((call) => call.path), [], "the app stopped syncing the private channel");
  assert.equal([...credentialCalls(member, this.workspaceUri, since), ...credentialCalls(member, vault.uri, since)].map(credentialOutcome).includes("granted"), false, "the Group Host renewed no credential for the workspace or the channel");
  for (const call of reads) assert.doesNotMatch(call.responseBody, /Private note/, "no refused sync leaked the cached message");
  assert.deepEqual(heldCopy(await browserStoreAt(member, this.appOrigin), vault.uri), { records: 0, space: false }, "the app holds no cached copy once it has closed");
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
  if (others.length > 0) {
    await createChannelAs(world, owner, "Private Leave Room", "private", others.map((person) => person.did));
  }
  const zulu = await createChannelAs(world, owner, "Zulu Room", "public");
  await openChannel(owner, "Zulu Room");
  breakMembershipWrites(world);
  const executed = await submitAndWait(world, owner, async () => {
    await owner.page.getByLabel("Selected members when making this channel private").fill(`${owner.did}, ${victim.did}`);
    await owner.page.getByRole("button", { name: "Make private", exact: true }).click();
  });
  assert.equal(executed.status, 200, JSON.stringify(executed));
  assert.equal(executed.operation?.state, "pending", `the transition stops part-way after channel-set-transitioning: ${JSON.stringify(executed)}`);
  assert.deepEqual(executed.operation?.completedSteps, ["channel-set-transitioning"], "the partial write committed channel-set-transitioning before failing");
  assert.equal(requiredJournalEntry(world, executed.operationId).state, "pending");
  await owner.page.getByText(/Operation .* is still pending\./).waitFor({ state: "visible" });
  remember(world, "zulu", zulu);
  remember(world, "pending", { executed, entry: requiredJournalEntry(world, executed.operationId), auditEvents: auditTrail(world, executed.operationId).length } satisfies PendingWork);
}

async function submitInviteViaUi(world: AppWorld, owner: Actor, did: string): Promise<Executed> {
  await showWorkspaceHome(world, owner);
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
  const older = recall<PendingWork>(this, "pending");

  const blocked = await submitInviteViaUi(this, owner, newcomer.did);
  remember(this, "blocked", blocked);
  remember(this, "olderAfterBlocked", requiredJournalEntry(this, older.executed.operationId));
  remember(this, "olderAuditAfterBlocked", auditTrail(this, older.executed.operationId).length);

  repairMembershipWrites(this);
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
  assert.equal(entry.steps.at(-1), "channel-set-final-visibility");
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
  assert.ok(requiredJournalEntry(this, older.executed.operationId).steps.includes(`channel-private-add-${victim.did}`), "the older operation itself made the private-role write the fault had blocked");
  assert.deepEqual(await memberAccess(this, owner, zulu.uri, victim.did), FULL_ACCESS, "the older transition finished granting victim access to Zulu Room");
  assert.equal(await memberAccess(this, owner, zulu.uri, newcomer.did), undefined, "newcomer was not added to private Zulu Room");
  for (const space of await allSpaces(this)) {
    if (space.label.startsWith("public channel") || space.label === "members") {
      assert.deepEqual(await memberAccess(this, owner, space.uri, newcomer.did), FULL_ACCESS, `and the newer invite applied to ${space.label}`);
    } else if (space.label === "workspace") {
      assert.deepEqual(await memberAccess(this, owner, space.uri, newcomer.did), READ_ONLY, "and the newer invite applied read access to workspace");
    }
  }
});

Given("an admin operation remains pending", async function (this: AppWorld) {
  await leaveAdminOperationPending(this, ["leaver"]);
});

When("a workspace member requests to leave", async function (this: AppWorld) {
  const leaver = actorNamed(this, "leaver");
  remember(this, "pendingBeforeLeave", { entry: requiredJournalEntry(this, recall<PendingWork>(this, "pending").executed.operationId), auditEvents: auditTrail(this, recall<PendingWork>(this, "pending").executed.operationId).length });
  await joinWorkspaceAs(this, leaver);
  await openChannel(leaver, "Private Leave Room");
  const attempt = await submitAndWait(this, leaver, async () => {
    await leaver.page.getByRole("button", { name: "Leave private channel" }).click();
  });
  remember(this, "leaveAttempt", attempt);
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
  const older = recall<PendingWork>(this, "pending");
  const before = recall<{ entry: JournalEntry; auditEvents: number }>(this, "pendingBeforeLeave");
  assert.deepEqual(requiredJournalEntry(this, older.executed.operationId), before.entry, "the pending operation's state, steps, error and timestamps are exactly as they were");
  assert.equal(auditTrail(this, older.executed.operationId).length, before.auditEvents, "no attempt to resume it was made on the member's behalf");
  assert.equal(journalRowsFor(this, leaver.did), 0, "the member's own leave request was never journaled");
  const privateRoom = await channelNamed(this, "Private Leave Room");
  assert.deepEqual(await memberAccess(this, owner, privateRoom.uri, leaver.did), FULL_ACCESS, "the member who asked to leave is still in the private channel");
  assert.equal(hasActiveWorkspaceMembership(this, leaver.did), true);
});

// --- Recover a partially completed privacy transition (the operator is really restarted) -------------

type TransitionRecovery = {
  app: OwnApp;
  web: AppWorld;
  roadmap: ChannelRef;
  failed: Executed;
};

Given("a privacy transition failed after a Group Host mutation step", async function (this: AppWorld) {
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
  await openChannel(owner, "Roadmap");
  breakMembershipWrites(web);
  const failed = await submitAndWait(web, owner, async () => {
    await owner.page.getByLabel("Selected members when making this channel private").fill(`${owner.did}, ${kept.did}`);
    await owner.page.getByRole("button", { name: "Make private", exact: true }).click();
  });
  assert.equal(failed.operation?.state, "pending", JSON.stringify(failed));
  assert.deepEqual(failed.operation?.completedSteps, ["channel-set-transitioning"], "this covers a failure after the first Group Host write; failures after later writes are covered by the delegated failure matrix");
  assert.equal((await authorityRecord(web, owner, web.workspaceUri, "new.flock.directory", roadmap.skey))?.visibility, "transitioning");
  await owner.page.getByText("CHANNEL TRANSITION").waitFor({ state: "visible" });
  assert.equal(requiredJournalEntry(web, failed.operationId).state, "pending");
  remember(this, "recovery", { app, web, roadmap, failed } satisfies TransitionRecovery);
});

When("the operator restarts", async function (this: AppWorld) {
  const { app, web, roadmap, failed } = recall<TransitionRecovery>(this, "recovery");
  const owner = actorNamed(this, "owner");
  const kept = actorNamed(this, "kept");
  repairMembershipWrites(web);
  const sampler = sampleTimed(() => readChannel(web, roadmap));
  await app.restart();
  remember(this, "afterRestart", await readChannel(web, roadmap));
  const reconcile = await runReconcileJob(app, {
    groupDid: groupDidOf(web),
    actorDid: owner.did,
    workspaceUri: web.workspaceUri,
    memberDid: kept.did,
    operationId: failed.operationId,
  });
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
  const report = JSON.parse(reconcile.stdout) as { resumedOperationState?: string; reconciliationState?: string };
  assert.equal(report.resumedOperationState, "completed");

  const entry = requiredJournalEntry(web, failed.operationId);
  assert.equal(entry.state, "completed", "the interrupted operation itself was resumed");
  assert.deepEqual(entry.steps.slice(0, 1), ["channel-set-transitioning"], "it kept the step it had already made");
  assert.equal(entry.steps.at(-1), "channel-set-final-visibility");
  assert.ok(entry.steps.indexOf("channel-visibility-verified") < entry.steps.indexOf("channel-set-final-visibility"));
  const transitions = web.withAppDatabase((db) => (db.prepare("SELECT count(*) AS count FROM operation WHERE request_json LIKE '%transitionChannel%'").get() as { count: number }).count);
  assert.equal(transitions, 1, "recovery resumed the journaled operation instead of starting a second one");

  assert.equal((await authorityRecord(web, owner, web.workspaceUri, "new.flock.directory", roadmap.skey))?.visibility, "private");
  assert.deepEqual(await memberAccess(web, owner, roadmap.uri, kept.did), FULL_ACCESS);
  assert.equal(await memberAccess(web, owner, roadmap.uri, dropped.did), undefined);
  assert.equal(hasActivePrivateChannelRole(web, roadmap.skey, kept.did), true);

  await owner.page.reload();
  await channelButton(owner, "Roadmap").waitFor({ state: "visible" });
  assert.match(await channelButton(owner, "Roadmap").innerText(), /▣/, "after the restart the app lists the channel as private");
});

Then("the channel remains transitioning until the Group Host channel role and policy update completes", function (this: AppWorld) {
  const { failed, web } = recall<TransitionRecovery>(this, "recovery");
  const owner = actorNamed(this, "owner");
  const kept = actorNamed(this, "kept");
  const dropped = actorNamed(this, "dropped");
  const expectedPrivate = [owner.did, kept.did].sort();
  const afterRestart = recall<ChannelReading>(this, "afterRestart");
  assert.equal(afterRestart.visibility, "transitioning", "restarting the operator by itself did not publish the new visibility");
  assert.ok(afterRestart.members.includes(dropped.did), "the unselected member is still present before recovery finishes");
  assert.notDeepEqual([...afterRestart.members].sort(), expectedPrivate, "the channel role and policy update had not yet completed");
  const readings = recall<ChannelReading[]>(this, "recoveryReadings");
  for (const reading of readings) {
    if (reading.visibility === "private") assert.deepEqual([...reading.members].sort(), expectedPrivate, "the directory said private only once the channel role and policy grants matched the selection");
  }
  assert.equal(readings.at(-1)?.visibility, "private");
  const events = auditTrail(web, failed.operationId).map((event) => event.event);
  assert.ok(events.indexOf("channel-visibility-verified") < events.indexOf("channel-set-final-visibility"), "the journal verified the channel role and policy grants before publishing the final visibility");
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

/** Injected Group Host write failures and real process restarts exist only in the protocol acceptance test, so it is run once per cucumber process, in its own process group so a timeout can kill the apps it started too. */
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

Given("an admin operation can fail after each Group Host write", function (this: AppWorld) {
  assert.ok(statSync(ACCEPTANCE_TEST).isFile(), "the protocol acceptance test is available");
});

When("a failure is injected and the operator restarts", { timeout: ACCEPTANCE_STEP_TIMEOUT_MS }, async function (this: AppWorld) {
  remember(this, "acceptance", await runAcceptanceMatrix());
});

Then("the operation remains visibly pending until state converges", function (this: AppWorld) {
  const { exitCode, signal, output } = recall<AcceptanceRun>(this, "acceptance");
  assert.equal(exitCode, 0, `exit ${exitCode} signal ${signal}\n${output.slice(-4_000)}`);
  assert.match(output, /✔ app acceptance across two real PDS hosts, OpenSocial Group Host, and journal restart/);
  assert.match(output, /ℹ pass 1\b/);
  assert.match(output, /ℹ fail 0\b/);
});

After(async function (this: AppWorld) {
  killAcceptanceChildren();
  const app = this.scratch.get("ownApp") as OwnApp | undefined;
  await app?.stop();
});
