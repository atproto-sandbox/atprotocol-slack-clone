import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { groupMembersUri, requestRecordKey } from "@flock/protocol/keys";
import { ATGRP_COLLECTION } from "@flock/protocol/nsids";
import { eventually, inviteMemberAs } from "../support/ui";
import type { Actor, AppWorld } from "../support/world";
import { listingCalls, openChannel, postMessage } from "../support/channels-ui";
import { groupDidOf } from "../support/group-state";
import {
  PRIVATE_CHANNEL_NAME, accessOf, activeRosterOf, assertCredentialRefused, callOperatorMethod, createPrivateChannelAs, decideInUi, decisionFor,
  floodInboxWriterRepo, inboxOf, inboxRequestsSeen, inboxRow, inboxSweepsSince, joinWorkspaceAs, leaveChannelForWorkspaceHome, membersOf, messagesOf,
  mintCredential, onboardMember, openChannelRoster, ownerWithAdminControls, requestPrivateAccessAs, requestsReadByOwner,
  requestsReadWithCredential, resubmitRequestAs, snapshotOfDecisionWrites, submitOperationAs, syncInbox, unregisterAppNotifications,
  watchDecisionWrites, withdrawRequestAs, workspaceWithPrivateChannel, writeRequestDirectly, writerSetOf,
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
const LONG_SETUP = { timeout: 600_000 };

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

function sweepsSince(world: AppWorld, from: number): number {
  return inboxSweepsSince(actorNamed(world, "owner"), inboxOf(world), from);
}

async function waitForNextSweep(world: AppWorld): Promise<void> {
  const before = need(stateOf(world).sweepsBefore, "inbox sweep baseline");
  await eventually(() => sweepsSince(world, before) > 0, { timeoutMs: RECONCILIATION_WINDOW_MS, what: "the admin inbox to reconcile" });
}

async function sweepFinding(world: AppWorld, requester: Actor) {
  const before = need(stateOf(world).sweepsBefore, "inbox sweep baseline");
  return eventually(
    () => inboxRequestsSeen(actorNamed(world, "owner"), inboxOf(world), before).find((entry) => entry.repoDid === requester.did),
    { timeoutMs: RECONCILIATION_WINDOW_MS, what: "an inbox sweep that lists the request" },
  );
}

/** An admin has synced the inbox and holds the requester's current request, read both from the app and from the requester's PDS. */
async function adminHoldsCurrentRequest(world: AppWorld): Promise<void> {
  const { owner, channel } = await workspaceWithPrivateChannel(world);
  const requester = await onboardMember(world, owner, "requester", 1);
  await assertCredentialRefused(world, requester, channel.space, "before approval the requester has no channel access");
  const submitted = await requestPrivateAccessAs(requester, channel);
  const sweepsBefore = owner.xrpc.length;
  await syncInbox(owner);
  const listed = await eventually(
    () => inboxRequestsSeen(owner, inboxOf(world), sweepsBefore).find((entry) => entry.repoDid === requester.did),
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
  stateOf(this).request = await requestPrivateAccessAs(actorNamed(this, "requester"), channelOf(this));
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
    space: inboxOf(this), repo: requester.did, collection: "new.flock.joinRequest", limit: "100",
  });
  assert.equal(direct.status, 400, `the requester's repo is hidden from another account: ${JSON.stringify(direct.body)}`);
  assert.equal(direct.body.error, "RepoNotFound");
  assert.equal(direct.body.records, undefined);
});

// --- Recovering requests the app was never told about & skipping unreadable writers -------------------

Given("a request write reached the Group Host writer set", LONG_SETUP, async function (this: AppWorld) {
  const { owner, channel } = await workspaceWithPrivateChannel(this);
  const requester = await this.actor("requester", 1);
  await inviteMemberAs(owner, requester.did);
  const registered = this.withAppDatabase((db) => db.prepare("SELECT 1 AS found FROM notification_registration WHERE service_ref = ? AND space_uri = ?")
    .get(this.operatorServiceRef, inboxOf(this)));
  assert.ok(registered, "the app registered for inbox notifications when the admin first opened the inbox");
  unregisterAppNotifications(this);
  const state = stateOf(this);
  state.channel = channel;
  state.sweepsBefore = owner.xrpc.length;
  state.request = await writeRequestDirectly(this, requester, channel);
  const writers = await writerSetOf(this, await mintCredential(this, owner, inboxOf(this)));
  assert.ok(writers.includes(requester.did), "the Group Host lists the requester among the inbox writers");
});

Given("the app notification was dropped", function (this: AppWorld) {
  assert.equal(notificationsFor(this, actorNamed(this, "requester")), 0, "the app has recorded no notification for this write");
});

When("the admin inbox performs its next 60 second reconciliation", async function (this: AppWorld) {
  await waitForNextSweep(this);
});

Then("it finds the request writer through listWriters", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const requester = actorNamed(this, "requester");
  const found = await sweepFinding(this, requester);
  assert.equal(found.requestId, requestOf(this).id);
  await inboxRow(owner, requester, channelOf(this)).waitFor({ state: "visible", timeout: 60_000 });
  assert.equal(notificationsFor(this, requester), 0, "the request was found by the sweep, not by a notification");
  const credential = await mintCredential(this, owner, inboxOf(this));
  const writers = await writerSetOf(this, credential);
  assert.ok(writers.includes(requester.did), "the Group Host writer set lists the requester");
  const stored = await requestsReadWithCredential(credential, requester);
  assert.deepEqual(stored.map(({ requestId }) => requestId), [requestOf(this).id], "reading the listed writer's repo yields the request");
});

Given("two members submitted requests to the authority inbox writer set", LONG_SETUP, async function (this: AppWorld) {
  const { owner, channel } = await workspaceWithPrivateChannel(this);
  const requester = await this.actor("requester", 1);
  const noisy = await this.actor("noisy", 0);
  await inviteMemberAs(owner, requester.did);
  await inviteMemberAs(owner, noisy.did);
  const state = stateOf(this);
  state.channel = channel;
  state.request = await writeRequestDirectly(this, requester, channel);
  await writeRequestDirectly(this, noisy, channel);
  const writers = await writerSetOf(this, await mintCredential(this, owner, inboxOf(this)));
  assert.ok(writers.includes(requester.did) && writers.includes(noisy.did), "both members are in the Group Host inbox writer set");
});

Given("one writer's PDS repo becomes oversized and unreadable", async function (this: AppWorld) {
  await floodInboxWriterRepo(this, actorNamed(this, "noisy"), 105);
});

When("the admin inbox syncs", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  stateOf(this).sweepsBefore = owner.xrpc.length;
  await syncInbox(owner);
  await sweepFinding(this, actorNamed(this, "requester"));
});

Then("the admin reads the healthy member's request with their inbox credential and sees the skipped writer warning", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const requester = actorNamed(this, "requester");
  const noisy = actorNamed(this, "noisy");
  const channel = channelOf(this);
  await inboxRow(owner, requester, channel).waitFor({ state: "visible", timeout: 60_000 });
  await owner.page
    .getByText(new RegExp(`Join requests from .*${noisy.did}.*more than 100 current request records.*could not be read`))
    .waitFor({ state: "visible", timeout: 60_000 });
  const stored = await requestsReadWithCredential(await mintCredential(this, owner, inboxOf(this)), requester);
  assert.deepEqual(stored.map(({ requestId, channelSkey }) => ({ requestId, channelSkey })), [{ requestId: requestOf(this).id, channelSkey: channel.skey }]);
});

Then("the operator has no inbox-writer endpoint and never sees any request body", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const requester = actorNamed(this, "requester");
  const [stored] = await requestsReadWithCredential(await mintCredential(this, owner, inboxOf(this)), requester);
  assert.ok(stored, "there is a request body that must never reach the operator");

  const deletedEndpoint = await callOperatorMethod(this, owner, "new.flock.operator.listInboxWriters", { workspace: this.workspaceUri });
  assert.ok(deletedEndpoint.status >= 400, `new.flock.operator.listInboxWriters was deleted in R13, got ${deletedEndpoint.status}`);

  const sweepStart = need(stateOf(this).sweepsBefore, "inbox sweep baseline");
  const operatorTraffic = owner.xrpc.filter((call) => call.origin === this.operatorOrigin);
  assert.ok(operatorTraffic.length > 0, "the admin's browser talked to the operator for workspace operations/stalled checks");
  for (const call of operatorTraffic) {
    for (const secret of [stored.requestId, "joinRequest"]) {
      assert.equal(call.requestBody.includes(secret), false, `operator request ${call.path} must not contain ${secret}`);
      assert.equal(call.responseBody.includes(secret), false, `operator response ${call.path} must not contain ${secret}`);
    }
  }
  const syncOperatorTraffic = owner.xrpc.slice(sweepStart).filter((call) => call.origin === this.operatorOrigin);
  for (const call of syncOperatorTraffic) {
    assert.equal(call.requestBody.includes(stored.channelSkey), false, `inbox sync operator request ${call.path} must not contain ${stored.channelSkey}`);
    assert.equal(call.responseBody.includes(stored.channelSkey), false, `inbox sync operator response ${call.path} must not contain ${stored.channelSkey}`);
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
    state.outcome = await decideInUi(this, owner, inboxRow(owner, requester, channel), "Approve");
  } finally {
    during = await watcher.stop();
  }
  state.writes = { during, after: await sample() };
});

When("the admin denies it", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  stateOf(this).outcome = await decideInUi(this, owner, inboxRow(owner, actorNamed(this, "requester"), channelOf(this)), "Deny");
});

Then("the requester receives channel read and write access", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const requester = actorNamed(this, "requester");
  const channel = channelOf(this);
  assert.equal(outcomeOf(this).state, "completed", outcomeOf(this).error);
  assert.deepEqual(accessOf(await membersOf(this, owner, channel.space), requester.did), { read: true, write: true });
  const credential = await mintCredential(this, requester, channel.space);
  assert.equal(credential.space, channel.space, "the Group Host now issues the requester a credential for the private channel");
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
  assert.deepEqual(after, { decision: true, member: true, rosterActive: true }, "once the operation completed, all approval state is on the Group Host");
  const early = during.filter((snapshot) => snapshot.decision && !(snapshot.member && snapshot.rosterActive));
  assert.deepEqual(early, [], `the Group Host never showed the decision without the membership and the private role (${during.length} samples)`);
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

Then("the requester receives no channel role grant", async function (this: AppWorld) {
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
  const first = await requestPrivateAccessAs(requester, channel);
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
  stateOf(this).outcome = await submitOperationAs(this, owner, this.workspaceUri, {
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
  const sweepsBefore = owner.xrpc.length;
  await syncInbox(owner);
  const listed = await eventually(
    () => inboxRequestsSeen(owner, inboxOf(this), sweepsBefore).find((entry) => entry.repoDid === requester.did && entry.requestId === request.id),
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

  await requestPrivateAccessAs(gamma, channel);
  await syncInbox(owner);
  const approval = await decideInUi(this, owner, inboxRow(owner, gamma, channel), "Approve");
  assert.equal(approval.state, "completed", approval.error);

  await openChannel(alpha, channel.name);
  await postMessage(alpha, "alpha is the only one who posts here");
  await leaveChannelForWorkspaceHome(this, alpha);
  const credential = await mintCredential(this, alpha, channel.space);
  assert.equal(credential.space, channel.space, "alpha holds a credential for the private channel");
  stateOf(this).channel = channel;
});

When("they open the channel roster", async function (this: AppWorld) {
  const alpha = actorNamed(this, "alpha");
  const since = alpha.xrpc.length;
  stateOf(this).rosterShown = await openChannelRoster(alpha, channelOf(this));
  assert.ok(
    listingCalls(alpha, ATGRP_COLLECTION.membership, since).some(
      ({ call, query }) => call.status === 200 && query.get("space") === groupMembersUri(groupDidOf(this)),
    ),
    "the app read the private channel's role memberships from the group authority's records",
  );
});

Then("it includes every active member, including members who have never posted", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const [alpha, beta, gamma] = ["alpha", "beta", "gamma"].map((role) => actorNamed(this, role));
  const channel = channelOf(this);
  const everyone = [alpha.did, beta.did, gamma.did].sort();
  const shown = need(stateOf(this).rosterShown, "roster on screen");
  assert.deepEqual(shown, everyone, "the roster on screen lists exactly the active members");
  assert.deepEqual(await activeRosterOf(this, owner, channel), everyone, "the authority's role membership records agree");
  const memberList = (await membersOf(this, owner, channel.space)).filter((member) => member.read && member.write).map((member) => member.did).sort();
  assert.deepEqual(memberList, everyone, "so does the Group Host effective member list");

  const credential = await mintCredential(this, alpha, channel.space);
  assert.equal((await messagesOf(credential, alpha)).length, 1, "alpha has posted");
  assert.deepEqual(await messagesOf(credential, beta), [], "beta never posted");
  assert.deepEqual(await messagesOf(credential, gamma), [], "gamma never posted");
});
