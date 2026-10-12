import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { requestRecordKey } from "@/protocol/keys";
import { eventually, inviteMemberAs } from "../support/ui";
import type { Actor, AppWorld } from "../support/world";
import {
  PRIVATE_CHANNEL_NAME, accessOf, activeRosterOf, assertCredentialRefused, callOperator, createPrivateChannelAs, decideInUi, decisionFor,
  grantChannelReadAs, inboxOf, inboxRequestsSeen, inboxRow, joinWorkspaceAs, leaveChannelForWorkspaceHome, membersOf, messagesOf,
  inboxWriterSources, mintCredential, onboardMember, openChannelRoster, removeFromInboxMembers, ownerWithAdminControls, postMessageAs, requestPrivateAccessAs, requestsReadByOwner,
  requestsReadWithCredential, resubmitRequestAs, snapshotOfDecisionWrites, submitOperationAs, syncInbox, unregisterAppNotifications,
  watchDecisionWrites, withdrawRequestAs, workspaceWithPrivateChannel, writeRequestDirectly, writerSetOf, operatorServiceRef,
  type OperationOutcome, type PrivateChannel, type SubmittedRequest, type WriteSnapshot,
} from "../support/private-requests-ui";

type State = {
  channel?: PrivateChannel;
  request?: SubmittedRequest;
  staleRequestId?: string;
  sweepsBefore?: number;
  outcome?: OperationOutcome;
  writes?: { during: WriteSnapshot[]; after: WriteSnapshot };
  rosterShown?: string[];
};

const STATE = "privateRequests";
const RECONCILIATION_WINDOW_MS = 150_000;
const LONG_SETUP = { timeout: 300_000 };

function stateOf(world: AppWorld): State {
  const existing = world.scratch.get(STATE) as State | undefined;
  if (existing) return existing;
  const created: State = {};
  world.scratch.set(STATE, created);
  return created;
}

function need<T>(value: T | undefined, what: string): T {
  assert.ok(value !== undefined, `this scenario has no ${what} yet`);
  return value;
}

function actorNamed(world: AppWorld, role: string): Actor {
  const actor = world.actors.get(role);
  assert.ok(actor, `this scenario has no ${role} yet`);
  return actor;
}

const channelOf = (world: AppWorld): PrivateChannel => need(stateOf(world).channel, "private channel");
const requestOf = (world: AppWorld): SubmittedRequest => need(stateOf(world).request, "request");
const outcomeOf = (world: AppWorld): OperationOutcome => need(stateOf(world).outcome, "operation outcome");

function notificationsFor(world: AppWorld, requester: Actor): number {
  const row = world.withAppDatabase((db) => db.prepare("SELECT COUNT(*) AS total FROM space_notification WHERE space_uri = ? AND repo_did = ?")
    .get(inboxOf(world), requester.did) as { total: number });
  return row.total;
}

function sweepsSince(world: AppWorld, count: number): number {
  return world.callsTo(actorNamed(world, "owner"), "/api/inbox/requests").length - count;
}

async function waitForNextSweep(world: AppWorld): Promise<void> {
  const before = need(stateOf(world).sweepsBefore, "inbox sweep baseline");
  await eventually(() => sweepsSince(world, before) > 0, { timeoutMs: RECONCILIATION_WINDOW_MS, what: "the admin inbox to reconcile" });
}

async function sweepFinding(world: AppWorld, requester: Actor) {
  const before = need(stateOf(world).sweepsBefore, "inbox sweep baseline");
  return eventually(
    () => inboxRequestsSeen(world, actorNamed(world, "owner"), before).flat().find((entry) => entry.repoDid === requester.did),
    { timeoutMs: RECONCILIATION_WINDOW_MS, what: "an inbox sweep that lists the request" },
  );
}

/** An admin has synced the inbox and holds the requester's current request, read both from the app and from the requester's PDS. */
async function adminHoldsCurrentRequest(world: AppWorld): Promise<void> {
  const { owner, channel } = await workspaceWithPrivateChannel(world);
  const requester = await onboardMember(world, owner, "requester", 1);
  await assertCredentialRefused(world, requester, channel.space, "before approval the requester has no channel access");
  const submitted = await requestPrivateAccessAs(world, requester, channel);
  const sweepsBefore = world.callsTo(owner, "/api/inbox/requests").length;
  await syncInbox(owner);
  const listed = await eventually(
    () => inboxRequestsSeen(world, owner, sweepsBefore).flat().find((entry) => entry.repoDid === requester.did),
    { what: "a sync that lists the request" },
  );
  await inboxRow(owner, requester, channel).waitFor({ state: "visible", timeout: 60_000 });
  const onPds = await requestsReadWithCredential(await mintCredential(world, owner, inboxOf(world)), requester);
  assert.deepEqual(onPds.map(({ requestId }) => requestId), [listed.requestId], "the PDS holds exactly the request the admin was shown");
  assert.equal(listed.requestId, submitted.id);
  const state = stateOf(world);
  state.channel = channel;
  state.request = { id: listed.requestId, uri: listed.uri };
}

// --- A member submits a private-channel request -------------------------------------------------------

Given("a workspace member has inbox write access and no inbox read access", LONG_SETUP, async function (this: AppWorld) {
  const { owner, channel } = await workspaceWithPrivateChannel(this);
  const requester = await onboardMember(this, owner, "requester", 1);
  const bystander = await this.actor("bystander", 1);
  await inviteMemberAs(owner, bystander.did);
  const inboxMembers = await membersOf(this, owner, inboxOf(this));
  assert.deepEqual(accessOf(inboxMembers, requester.did), { read: false, write: true });
  assert.deepEqual(accessOf(inboxMembers, bystander.did), { read: false, write: true });
  stateOf(this).channel = channel;
});

When("they submit a request to their own PDS repo", async function (this: AppWorld) {
  stateOf(this).request = await requestPrivateAccessAs(this, actorNamed(this, "requester"), channelOf(this));
});

Then("they can read their own request", async function (this: AppWorld) {
  const requester = actorNamed(this, "requester");
  const channel = channelOf(this);
  const own = await requestsReadByOwner(this, requester, inboxOf(this));
  assert.deepEqual(own.map(({ rkey, requestId, channelSkey }) => ({ rkey, requestId, channelSkey })), [
    { rkey: requestRecordKey(channel.space, requester.did), requestId: requestOf(this).id, channelSkey: channel.skey },
  ]);
});

Then("an admin can read it using an inbox credential", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const requester = actorNamed(this, "requester");
  const channel = channelOf(this);
  const credential = await mintCredential(this, owner, inboxOf(this));
  const seenByAdmin = await requestsReadWithCredential(credential, requester);
  assert.deepEqual(seenByAdmin.map(({ requestId, channelSkey }) => ({ requestId, channelSkey })), [{ requestId: requestOf(this).id, channelSkey: channel.skey }]);
  await syncInbox(owner);
  await inboxRow(owner, requester, channel).waitFor({ state: "visible", timeout: 60_000 });
});

Then("the requester cannot obtain an inbox read credential", async function (this: AppWorld) {
  await assertCredentialRefused(this, actorNamed(this, "requester"), inboxOf(this), "the requester");
});

Then("an ordinary member cannot read the request repo", async function (this: AppWorld) {
  const bystander = actorNamed(this, "bystander");
  const requester = actorNamed(this, "requester");
  await assertCredentialRefused(this, bystander, inboxOf(this), "the ordinary member");
  const direct = await this.pdsGet<{ records?: unknown[]; error?: string }>(bystander, "com.atproto.space.listRecords", {
    space: inboxOf(this), repo: requester.did, collection: "org.slack.joinRequest", limit: "100",
  });
  assert.equal(direct.status, 400, `the requester's repo is hidden from another account: ${JSON.stringify(direct.body)}`);
  assert.equal(direct.body.error, "RepoNotFound");
  assert.equal(direct.body.records, undefined);
});

// --- Recovering requests the app was never told about --------------------------------------------------

Given("a request write reached the authority PDS writer set", LONG_SETUP, async function (this: AppWorld) {
  const { owner, channel } = await workspaceWithPrivateChannel(this);
  const requester = await this.actor("requester", 1);
  await inviteMemberAs(owner, requester.did);
  const registered = this.withAppDatabase((db) => db.prepare("SELECT 1 AS found FROM notification_registration WHERE service_ref = ? AND space_uri = ?")
    .get(operatorServiceRef(this), inboxOf(this)));
  assert.ok(registered, "the app registered for inbox notifications when the admin first opened the inbox");
  await unregisterAppNotifications(this, owner);
  const state = stateOf(this);
  state.channel = channel;
  state.sweepsBefore = this.callsTo(owner, "/api/inbox/requests").length;
  state.request = await writeRequestDirectly(this, requester, channel);
  const writers = await writerSetOf(await mintCredential(this, owner, inboxOf(this)), owner);
  assert.ok(writers.includes(requester.did), "the authority PDS lists the requester among the inbox writers");
  await removeFromInboxMembers(this, owner, requester);
  assert.equal(accessOf(await membersOf(this, owner, inboxOf(this)), requester.did), undefined, "the requester is no longer on the inbox member list");
});

Given("the app notification was dropped", function (this: AppWorld) {
  assert.equal(notificationsFor(this, actorNamed(this, "requester")), 0, "the app has recorded no notification for this write");
});

Given("a request write reached the requester's PDS", LONG_SETUP, async function (this: AppWorld) {
  const { channel } = await workspaceWithPrivateChannel(this);
  const requester = await this.actor("requester", 1);
  const state = stateOf(this);
  state.channel = channel;
  state.request = await writeRequestDirectly(this, requester, channel);
  const own = await requestsReadByOwner(this, requester, inboxOf(this));
  assert.deepEqual(own.map(({ requestId }) => requestId), [state.request.id], "the request is stored in the requester's own repo");
});

Given("the PDS-to-authority notifyWrite was dropped", LONG_SETUP, async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const requester = actorNamed(this, "requester");
  // The authority refuses to hear about a write from a DID that is not yet on its inbox member list,
  // so the write above never reaches the writer set; inviting the DID afterwards makes it a current write member.
  await inviteMemberAs(owner, requester.did);
  assert.equal(accessOf(await membersOf(this, owner, inboxOf(this)), requester.did)?.write, true, "the requester is now a current inbox write member");
  const writers = await writerSetOf(await mintCredential(this, owner, inboxOf(this)), owner);
  assert.equal(writers.includes(requester.did), false, "the authority PDS never learned of the write");
  stateOf(this).sweepsBefore = this.callsTo(owner, "/api/inbox/requests").length;
});

When("the admin inbox performs its next 60 second reconciliation", async function (this: AppWorld) {
  await waitForNextSweep(this);
});

Then("it finds the request writer through listRepos", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const requester = actorNamed(this, "requester");
  const found = await sweepFinding(this, requester);
  assert.equal(found.requestId, requestOf(this).id);
  await inboxRow(owner, requester, channelOf(this)).waitFor({ state: "visible", timeout: 60_000 });
  assert.equal(notificationsFor(this, requester), 0, "the request was found by the sweep, not by a notification");
  const sources = await inboxWriterSources(this, owner);
  assert.equal(sources.operator.includes(requester.did), false, "the operator's member list does not name the requester, so it cannot be how the sweep found them");
  assert.ok(sources.listRepos.includes(requester.did), "the authority PDS writer set lists the requester");
  const credential = await mintCredential(this, owner, inboxOf(this));
  const stored = await requestsReadWithCredential(credential, requester);
  assert.deepEqual(stored.map(({ requestId }) => requestId), [requestOf(this).id], "reading the listed writer's repo yields the request");
});

Then("the operator returns the current inbox write-member DID", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const requester = actorNamed(this, "requester");
  const operator = await callOperator(this, owner, "org.slack.operator.listInboxWriters", { workspace: this.workspaceUri });
  assert.equal(operator.status, 200, operator.text);
  const body = JSON.parse(operator.text) as { inbox: string; writers: string[] };
  assert.equal(body.inbox, inboxOf(this));
  const writeMembers = (await membersOf(this, owner, inboxOf(this))).filter((member) => member.write).map((member) => member.did).sort();
  assert.deepEqual([...body.writers].sort(), writeMembers, "the operator lists exactly the current inbox write members");
  assert.ok(body.writers.includes(requester.did));
  const found = await sweepFinding(this, requester);
  assert.equal(found.requestId, requestOf(this).id, "the reconciliation surfaced the request through that DID");
  await inboxRow(owner, requester, channelOf(this)).waitFor({ state: "visible", timeout: 60_000 });
  assert.equal(notificationsFor(this, requester), 0);
  const writers = await writerSetOf(await mintCredential(this, owner, inboxOf(this)), owner);
  assert.equal(writers.includes(requester.did), false, "listRepos could not have found it; only the operator's member list did");
});

Then("the admin reads that repo with their inbox credential", async function (this: AppWorld) {
  const stored = await requestsReadWithCredential(await mintCredential(this, actorNamed(this, "owner"), inboxOf(this)), actorNamed(this, "requester"));
  assert.deepEqual(stored.map(({ requestId, channelSkey }) => ({ requestId, channelSkey })), [{ requestId: requestOf(this).id, channelSkey: channelOf(this).skey }]);
});

Then("the operator never returns the request body", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const [stored] = await requestsReadWithCredential(await mintCredential(this, owner, inboxOf(this)), actorNamed(this, "requester"));
  assert.ok(stored, "there is a request body to leak");
  const operator = await callOperator(this, owner, "org.slack.operator.listInboxWriters", { workspace: this.workspaceUri });
  assert.equal(operator.status, 200, operator.text);
  assert.deepEqual(Object.keys(JSON.parse(operator.text) as object).sort(), ["checkedAt", "inbox", "writers"]);
  for (const secret of [stored.requestId, stored.channelSkey, stored.createdAt, "joinRequest"]) {
    assert.equal(operator.text.includes(secret), false, `the operator response must not contain ${secret}`);
  }
});

// --- Decisions apply only to the current request generation ----------------------------------------------

Given("an admin has read the current request and requestId", LONG_SETUP, async function (this: AppWorld) {
  await adminHoldsCurrentRequest(this);
});

Given("an admin has read the current request", LONG_SETUP, async function (this: AppWorld) {
  await adminHoldsCurrentRequest(this);
});

When("the admin approves it", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const requester = actorNamed(this, "requester");
  const channel = channelOf(this);
  const sample = () => snapshotOfDecisionWrites(this, owner, channel, requester, requestOf(this).uri);
  const watcher = watchDecisionWrites(sample);
  const state = stateOf(this);
  let during: WriteSnapshot[] = [];
  try {
    state.outcome = await decideInUi(owner, inboxRow(owner, requester, channel), "Approve");
  } finally {
    during = await watcher.stop();
  }
  state.writes = { during, after: await sample() };
});

When("the admin denies it", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  stateOf(this).outcome = await decideInUi(owner, inboxRow(owner, actorNamed(this, "requester"), channelOf(this)), "Deny");
});

Then("the requester receives channel read and write access", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const requester = actorNamed(this, "requester");
  const channel = channelOf(this);
  assert.equal(outcomeOf(this).state, "completed", outcomeOf(this).error);
  assert.deepEqual(accessOf(await membersOf(this, owner, channel.space), requester.did), { read: true, write: true });
  const credential = await mintCredential(this, requester, channel.space);
  assert.equal(credential.space, channel.space, "the PDS now issues the requester a credential for the private channel");
});

Then("the active private roster includes the requester", async function (this: AppWorld) {
  assert.ok((await activeRosterOf(this, actorNamed(this, "owner"), channelOf(this))).includes(actorNamed(this, "requester").did));
});

Then("an authority-authored decision matches the same requestId", async function (this: AppWorld) {
  const decision = await decisionFor(this, actorNamed(this, "owner"), inboxOf(this), requestOf(this).uri);
  assert.ok(decision, "the authority's repo holds a decision for this request");
  assert.deepEqual({ request: decision.request, requestId: decision.requestId, decision: decision.decision }, {
    request: requestOf(this).uri, requestId: requestOf(this).id, decision: "approve",
  });
});

Then("the request is shown as approved only after all three writes complete", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const requester = actorNamed(this, "requester");
  const outcome = outcomeOf(this);
  const writes = outcome.completedSteps.filter((step) => /^join-request-(channel-membership|private-roster|decision)$/.test(step));
  assert.deepEqual(writes, ["join-request-channel-membership", "join-request-private-roster", "join-request-decision"], `the app's own journal lists the writes as: ${outcome.completedSteps.join(", ")}`);
  assert.equal(outcome.completedSteps.at(-1), "join-request-approved-membership-verified");
  const { during, after } = need(stateOf(this).writes, "write observations");
  assert.deepEqual(after, { decision: true, member: true, rosterActive: true }, "once the operation completed, all three writes are on the PDS");
  const partWayDone = during.filter((snapshot) => !snapshot.decision && (snapshot.member || snapshot.rosterActive));
  assert.ok(partWayDone.length > 0, `the sampler saw the approval part way done (${during.length} samples), so it can resolve the order of the writes it vouches for`);
  const early = during.filter((snapshot) => snapshot.decision && !(snapshot.member && snapshot.rosterActive));
  assert.deepEqual(early, [], `the PDS never showed the decision without the membership and the roster entry (${partWayDone.length} of ${during.length} samples were taken part way through the approval; a gap shorter than one sample would not be seen, the journal order above covers it)`);
  await inboxRow(owner, requester, channelOf(this)).waitFor({ state: "hidden", timeout: 60_000 });
  await syncInbox(owner);
  await owner.page.getByText("No pending join requests.").waitFor({ state: "visible" });
});

Then("an authority-authored denial is recorded", async function (this: AppWorld) {
  assert.equal(outcomeOf(this).state, "completed", outcomeOf(this).error);
  const decision = await decisionFor(this, actorNamed(this, "owner"), inboxOf(this), requestOf(this).uri);
  assert.ok(decision, "the authority's repo holds a decision for this request");
  assert.deepEqual({ request: decision.request, requestId: decision.requestId, decision: decision.decision }, {
    request: requestOf(this).uri, requestId: requestOf(this).id, decision: "deny",
  });
});

Then("the requester receives no channel membership", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const requester = actorNamed(this, "requester");
  const channel = channelOf(this);
  assert.equal(accessOf(await membersOf(this, owner, channel.space), requester.did), undefined);
  assert.equal((await activeRosterOf(this, owner, channel)).includes(requester.did), false);
  await assertCredentialRefused(this, requester, channel.space, "after the denial the requester");
  await inboxRow(owner, requester, channel).waitFor({ state: "hidden", timeout: 60_000 });
});

Given("a requester withdrew and resubmitted a request with a fresh requestId", LONG_SETUP, async function (this: AppWorld) {
  const { owner, channel } = await workspaceWithPrivateChannel(this);
  const requester = await onboardMember(this, owner, "requester", 1);
  const first = await requestPrivateAccessAs(this, requester, channel);
  await syncInbox(owner);
  await inboxRow(owner, requester, channel).waitFor({ state: "visible", timeout: 60_000 });
  await withdrawRequestAs(requester);
  const second = await resubmitRequestAs(requester);
  assert.notEqual(second.id, first.id, "resubmitting creates a new request generation");
  const stored = await requestsReadByOwner(this, requester, inboxOf(this));
  assert.deepEqual(stored.map(({ requestId }) => requestId), [second.id], "only the fresh generation remains in the requester's repo");
  const state = stateOf(this);
  state.channel = channel;
  state.staleRequestId = first.id;
  state.request = second;
});

When("an older approval decision arrives", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  stateOf(this).outcome = await submitOperationAs(owner.page, this.workspaceUri, {
    kind: "decideJoinRequest", request: requestOf(this).uri, requestId: need(stateOf(this).staleRequestId, "older request generation"), decision: "approve",
  });
});

Then("the new request remains pending", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const requester = actorNamed(this, "requester");
  const channel = channelOf(this);
  const request = requestOf(this);
  const outcome = outcomeOf(this);
  assert.equal(outcome.state, "failed", `the older decision should be rejected, got ${JSON.stringify(outcome)}`);
  assert.match(outcome.error ?? "", /generation is no longer current/i);
  assert.equal(await decisionFor(this, owner, inboxOf(this), request.uri), undefined, "no decision was recorded");
  assert.equal(accessOf(await membersOf(this, owner, channel.space), requester.did), undefined, "the requester was not added to the channel");
  assert.equal((await activeRosterOf(this, owner, channel)).includes(requester.did), false);
  const [stored] = await requestsReadByOwner(this, requester, inboxOf(this));
  assert.equal(stored?.requestId, request.id, "the requester's repo still holds the fresh generation");
  const sweepsBefore = this.callsTo(owner, "/api/inbox/requests").length;
  await syncInbox(owner);
  const listed = await eventually(
    () => inboxRequestsSeen(this, owner, sweepsBefore).flat().find((entry) => entry.repoDid === requester.did && entry.requestId === request.id),
    { what: "a sync that lists the fresh generation as pending" },
  );
  assert.equal(listed.uri, request.uri);
  await inboxRow(owner, requester, channel).getByRole("button", { name: "Approve", exact: true }).waitFor({ state: "visible" });
});

// --- The full private roster ---------------------------------------------------------------------------

Given("a member has an authorized private-channel credential", LONG_SETUP, async function (this: AppWorld) {
  const owner = await ownerWithAdminControls(this);
  const alpha = await this.actor("alpha", 1);
  const beta = await this.actor("beta", 0);
  const gamma = await this.actor("gamma", 1);
  for (const member of [alpha, beta, gamma]) await inviteMemberAs(owner, member.did);
  const channel = await createPrivateChannelAs(this, owner, PRIVATE_CHANNEL_NAME, [alpha.did, beta.did]);
  await joinWorkspaceAs(this, gamma);
  await joinWorkspaceAs(this, alpha);

  await requestPrivateAccessAs(this, gamma, channel);
  await syncInbox(owner);
  const approval = await decideInUi(owner, inboxRow(owner, gamma, channel), "Approve");
  assert.equal(approval.state, "completed", approval.error);

  await grantChannelReadAs(this, alpha, channel);
  await postMessageAs(this, alpha, "alpha is the only one who posts here");
  await leaveChannelForWorkspaceHome(this, alpha);
  const credential = await mintCredential(this, alpha, channel.space);
  assert.equal(credential.space, channel.space, "alpha holds a credential for the private channel");
  stateOf(this).channel = channel;
});

When("they open the channel roster", async function (this: AppWorld) {
  const alpha = actorNamed(this, "alpha");
  const before = this.callsTo(alpha, "/api/channels/roster").length;
  stateOf(this).rosterShown = await openChannelRoster(alpha, channelOf(this));
  await eventually(() => this.callsTo(alpha, "/api/channels/roster").length > before, { what: "the roster request" });
});

Then("it includes every active member, including members who have never posted", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const [alpha, beta, gamma] = ["alpha", "beta", "gamma"].map((role) => actorNamed(this, role));
  const channel = channelOf(this);
  const everyone = [alpha.did, beta.did, gamma.did].sort();
  const shown = need(stateOf(this).rosterShown, "roster on screen");
  assert.deepEqual(shown, everyone, "the roster on screen lists exactly the active members");
  assert.deepEqual(await activeRosterOf(this, owner, channel), everyone, "the authority's roster records agree");
  const memberList = (await membersOf(this, owner, channel.space)).filter((member) => member.read && member.write).map((member) => member.did).sort();
  assert.deepEqual(memberList, everyone, "so does the PDS member list");

  const credential = await mintCredential(this, alpha, channel.space);
  assert.equal((await messagesOf(credential, alpha)).length, 1, "alpha has posted");
  assert.deepEqual(await messagesOf(credential, beta), [], "beta never posted");
  assert.deepEqual(await messagesOf(credential, gamma), [], "gamma never posted");
});
