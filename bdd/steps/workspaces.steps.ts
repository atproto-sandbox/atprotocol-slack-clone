import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { groupMembersUri, groupMetaUri, inboxUri, isDid } from "@flock/protocol/keys";
import { ATGRP_COLLECTION, ATGRP_SPACE_TYPE } from "@flock/protocol/nsids";
import { withIndependentReader } from "../support/independent-app-ui";
import { credentialCalls, credentialOutcome, workspaceChannels } from "../support/channels-ui";
import {
  groupDidOf,
  groupEffectiveAdmins,
  groupHasHumanMember,
  groupSpaceMembers,
  groupSpaceRecord,
  groupSpaceUris,
} from "../support/group-state";
import type { AppWorld, Actor } from "../support/world";
import {
  waitForAdminControls, completeConsent, copyInviteLink, createWorkspaceAs, escapeRegExp, eventually, inviteMemberAs,
  joinFromInvitation, openInviteLinkAndSignIn, ownerInvites, signIn, signOutAs, submitWorkspaceName, uniqueWorkspaceName, waitForApp, workspaceUriOnPage,
} from "../support/ui";
import { createChannelAs } from "../support/lifecycle-ui";
import { OPERATOR_AUTHORITY_FLOW, OPERATOR_CREATE_WORKSPACE, operatorCalls, submitAndWait, type Executed } from "../support/operator-calls";

type Member = { did: string; read: boolean; write: boolean };

/** The browser's own listings of the account's group memberships, from its own PDS. */
const workspaceListings = (actor: Actor) => actor.xrpc.filter((call) => call.path === "/xrpc/com.atproto.space.listSpaces" && call.status === 200
  && new URLSearchParams(call.query).get("spaceType") === ATGRP_SPACE_TYPE.members);

const owner = (world: AppWorld): Actor => {
  const actor = world.actors.get("owner");
  assert.ok(actor, "this scenario has no workspace owner yet");
  return actor;
};

const actorNamed = (world: AppWorld, role: string): Actor => {
  const actor = world.actors.get(role);
  assert.ok(actor, `this scenario has no ${role} yet`);
  return actor;
};

async function membersOf(world: AppWorld, _as: Actor, space: string): Promise<Member[]> {
  return groupSpaceMembers(world, space);
}

const workspaceSkey = (world: AppWorld): string => world.workspaceUri.split("/").at(-1)!;

/** The `org.atgrp.members` spaces an account's own PDS lists (from own-authored `confirmation/self` records). */
async function memberSpacesOn(world: AppWorld, as: Actor): Promise<string[]> {
  const listed = await world.pdsGet<{ spaces: Array<{ space: string }> }>(as, "com.atproto.space.listSpaces", { spaceType: ATGRP_SPACE_TYPE.members, limit: "100" });
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  return listed.body.spaces.map((entry) => entry.space);
}

// --- Creating the first workspace -------------------------------------------------------------------

Given("a signed-in account has not yet approved workspace-authority permission", async function (this: AppWorld) {
  const actor = await this.actor("owner");
  await signIn(this, actor);
  await actor.page.getByText("No workspaces yet").waitFor({ state: "visible" });
  this.scratch.set("createPanelButtons", await actor.page.locator("#workspace-setup button").allInnerTexts());
});

When("the account submits a workspace name", async function (this: AppWorld) {
  this.workspaceName = uniqueWorkspaceName();
  await submitWorkspaceName(owner(this), this.workspaceName);
});

Then("the app reports that permission is required, not a raw scope error", async function (this: AppWorld) {
  const first = await eventually(() => operatorCalls(owner(this), OPERATOR_CREATE_WORKSPACE)[0], { what: "the first create request" });
  assert.equal(first.status, 403);
  const body = JSON.parse(first.responseBody) as { error?: string; message?: string };
  assert.equal(body.error, "AuthorizationRequired", "the operator answers with its typed error, which the app turns into the approval");
  assert.doesNotMatch(first.responseBody, /Missing required scope/);
  this.scratch.set("operationId", (JSON.parse(first.requestBody) as { operationId: string }).operationId);
});

Then("the app sends the account to approve that permission", async function (this: AppWorld) {
  await owner(this).page.waitForURL(/\/oauth\/authorize\?/, { timeout: 30_000 });
});

Then("after approval the same operation ID is retried and the workspace is created", async function (this: AppWorld) {
  const actor = owner(this);
  await completeConsent(actor);
  await waitForApp(this, actor);
  await actor.page.getByRole("heading", { name: this.workspaceName, exact: true }).waitFor({ state: "visible" });
  const operationId = this.scratch.get("operationId") as string;
  // The page shows the workspace as soon as the retry answered; the recorder files that answer a moment later.
  await eventually(() => operatorCalls(actor, OPERATOR_CREATE_WORKSPACE).filter((call) => (JSON.parse(call.requestBody) as { operationId: string }).operationId === operationId).length >= 2,
    { what: "the same operation ID to be submitted again after approval" });
  const journal = this.withAppDatabase((db) => db.prepare("SELECT state FROM operation WHERE operation_id = ?").get(operationId) as { state: string } | undefined);
  assert.equal(journal?.state, "completed");
});

Then("no separate manual authorization step exists", function (this: AppWorld) {
  assert.deepEqual(this.scratch.get("createPanelButtons"), ["Create workspace"], "the create panel offers a single action; approval is requested by it");
});

Given("the account returns from the permission screen without the required permission", async function (this: AppWorld) {
  const actor = await this.actor("owner");
  await signIn(this, actor);
  this.workspaceName = uniqueWorkspaceName();
  await submitWorkspaceName(actor, this.workspaceName);
  await completeConsent(actor, "deny");
  await waitForApp(this, actor);
});

When("the app resumes the setup once", async function (this: AppWorld) {
  const actor = owner(this);
  await eventually(() => operatorCalls(actor, OPERATOR_CREATE_WORKSPACE).length >= 2, { what: "the setup to resume after returning" });
  // The resumed attempt ends in the refusal shown to the person; nothing runs after it.
  await actor.page.getByText(/Permission was not granted/).waitFor({ state: "visible" });
  assert.equal(operatorCalls(actor, OPERATOR_CREATE_WORKSPACE).length, 2, "setup was attempted once at submit and resumed exactly once");
});

Then("it shows a clear error instead of redirecting again", async function (this: AppWorld) {
  const actor = owner(this);
  await actor.page.getByText(/Permission was not granted/).waitFor({ state: "visible" });
  assert.doesNotMatch(actor.page.url(), /\/oauth\/authorize/, "the account was not sent to approve the permission a second time");
  assert.equal(operatorCalls(actor, OPERATOR_AUTHORITY_FLOW).length, 1, "only the first attempt asked for permission");
});

// --- Invitations ------------------------------------------------------------------------------------

Given("a workspace has one active owner and two public channels", async function (this: AppWorld) {
  const actor = await this.actor("owner");
  await createWorkspaceAs(this, actor);
  await waitForAdminControls(this, actor);
  await actor.page.getByLabel("Channel name").fill("Second Room");
  await actor.page.locator("form").filter({ has: actor.page.getByLabel("Channel name") }).getByRole("button", { name: /Create channel/ }).click();
  await actor.page.getByRole("button", { name: /Second Room/ }).waitFor({ state: "visible" });
});

When("an admin invites a DID that is not a workspace member", async function (this: AppWorld) {
  const invitee = await this.actor("invitee", 1);
  await inviteMemberAs(owner(this), invitee.did);
});

Then("the DID has read access to the workspace and read and write access to group members", async function (this: AppWorld) {
  const inviteeDid = actorNamed(this, "invitee").did;
  const wsMember = (await membersOf(this, owner(this), this.workspaceUri)).find((entry) => entry.did === inviteeDid);
  assert.deepEqual(wsMember && { read: wsMember.read, write: wsMember.write }, { read: true, write: false });
  const groupMember = (await membersOf(this, owner(this), groupMembersUri(groupDidOf(this)))).find((entry) => entry.did === inviteeDid);
  assert.deepEqual(groupMember && { read: groupMember.read, write: groupMember.write }, { read: true, write: true });
});

Then("the DID has write-only access to the admin inbox", async function (this: AppWorld) {
  const inbox = inboxUri(groupDidOf(this), workspaceSkey(this));
  const member = (await membersOf(this, owner(this), inbox)).find((entry) => entry.did === actorNamed(this, "invitee").did);
  assert.deepEqual(member && { read: member.read, write: member.write }, { read: false, write: true });
});

Then("the DID has read and write access to each public channel", async function (this: AppWorld) {
  const channels = groupSpaceUris(this, groupDidOf(this), "new.flock.channel");
  assert.equal(channels.length, 2, "the workspace has exactly two public channels");
  for (const space of channels) {
    const member = (await membersOf(this, owner(this), space)).find((candidate) => candidate.did === actorNamed(this, "invitee").did);
    assert.deepEqual(member && { read: member.read, write: member.write }, { read: true, write: true }, space);
  }
});

Then("the invite is reported complete only after Group Host membership and invite delivery succeed", function (this: AppWorld) {
  const invitee = actorNamed(this, "invitee");
  const steps = this.withAppDatabase((db) => db.prepare(
    "SELECT steps_json FROM operation WHERE request_json LIKE ? AND request_json LIKE '%inviteMember%' AND state = 'completed'",
  ).get(`%${invitee.did}%`) as { steps_json: string } | undefined);
  assert.ok(steps, "the invite was recorded as completed");
  const recorded = JSON.parse(steps.steps_json) as string[];
  assert.equal(recorded.at(-1), "member-state-verified", "the last recorded step verifies Group Host membership and invite state");
  const trail = this.withAppDatabase((db) => db.prepare(
    "SELECT event FROM audit_event WHERE operation_id = (SELECT operation_id FROM operation WHERE request_json LIKE ? AND request_json LIKE '%inviteMember%' AND state = 'completed') ORDER BY id",
  ).all(`%${invitee.did}%`) as Array<{ event: string }>).map((row) => row.event);
  assert.deepEqual(trail.slice(-2), ["member-state-verified", "operationCompleted"], "completion is recorded only after the verification step");
});

Given("a workspace owner has created a workspace and approved admin controls", async function (this: AppWorld) {
  const actor = await this.actor("owner");
  await createWorkspaceAs(this, actor);
  await waitForAdminControls(this, actor);
});

When("the owner invites a member by DID", async function (this: AppWorld) {
  const invitee = await this.actor("invitee", 1);
  await inviteMemberAs(owner(this), invitee.did);
});

Then("the owner is told to send the invite link", async function (this: AppWorld) {
  await owner(this).page.getByText(/Send them an invite link/).waitFor({ state: "visible" });
});

Then("the owner can copy an invite link that names the workspace", async function (this: AppWorld) {
  const link = new URL(await copyInviteLink(owner(this)));
  assert.equal(link.origin, this.appOrigin, "the link opens the app the owner is using");
  assert.deepEqual([...link.searchParams.keys()], ["invite"], "the link carries the workspace and nothing else");
  assert.equal(link.searchParams.get("invite"), this.workspaceUri, "the invite parameter is the workspace URI");
  assert.ok((await memberSpacesOn(this, owner(this))).includes(groupMembersUri(groupDidOf(this))), "the owner's own PDS indexes the group's members space");
});

Given("a member has been invited to a workspace and given its invite link", async function (this: AppWorld) {
  const { owner: actor } = await ownerInvites(this, "member");
  this.inviteLink = await copyInviteLink(actor);
});

When("the member opens the invite link and signs in", async function (this: AppWorld) {
  await openInviteLinkAndSignIn(this, actorNamed(this, "member"), this.inviteLink);
});

Then("the member is offered to join that workspace", async function (this: AppWorld) {
  const banner = actorNamed(this, "member").page.getByRole("region", { name: "Workspace invitation" });
  await banner.waitFor({ state: "visible" });
  assert.match(await banner.innerText(), new RegExp(escapeRegExp(this.workspaceUri)));
});

When("the member joins the workspace", async function (this: AppWorld) {
  await joinFromInvitation(actorNamed(this, "member"));
});

Then("the workspace appears in the member's dashboard with {int} active members", async function (this: AppWorld, count: number) {
  const page = actorNamed(this, "member").page;
  await page.getByRole("heading", { name: this.workspaceName, exact: true }).waitFor({ state: "visible" });
  await page.getByText(new RegExp(`(^|\\D)${count} active members`)).waitFor({ state: "visible" });
  await page.locator(".sidebar").getByRole("button", { name: new RegExp(escapeRegExp(this.workspaceName)) }).waitFor({ state: "visible" });
});

Given("a DID has no Group Host workspace membership", async function (this: AppWorld) {
  const actor = await this.actor("owner");
  await createWorkspaceAs(this, actor);
  this.inviteLink = await copyInviteLink(actor);
  await this.actor("stranger", 1);
});

When("that DID opens a forwarded invite link and tries to join", async function (this: AppWorld) {
  const stranger = actorNamed(this, "stranger");
  await openInviteLinkAndSignIn(this, stranger, this.inviteLink);
  await joinFromInvitation(stranger);
});

Then("the app says the account has not been added to the workspace", async function (this: AppWorld) {
  const stranger = actorNamed(this, "stranger");
  await stranger.page.getByRole("alert").filter({ hasText: /invite-only|may not have been added to it yet/i }).waitFor({ state: "visible" });
  const asked = credentialCalls(stranger, groupMembersUri(groupDidOf(this)));
  assert.ok(asked.length > 0, "joining asked the group host for the group members credential");
  assert.deepEqual([...new Set(asked.map(credentialOutcome))], ["SpaceNotFound"], "the authority gives an account it never added the same answer it gives for a missing space");
});

Then("the workspace does not appear in that account's dashboard", async function (this: AppWorld) {
  const stranger = actorNamed(this, "stranger");
  const page = stranger.page;
  const listing = await eventually(() => workspaceListings(stranger).at(-1), { what: "the app to list this account's group memberships" });
  assert.deepEqual((JSON.parse(listing.responseBody) as { spaces: Array<{ space: string }> }).spaces.map((entry) => entry.space), [], "the account's own PDS lists no group membership to the app");
  assert.equal(await page.getByRole("heading", { name: this.workspaceName, exact: true }).count(), 0);
  assert.equal(await page.locator(".sidebar").getByRole("button", { name: new RegExp(escapeRegExp(this.workspaceName)) }).count(), 0);
});

Then("the DID still has no Group Host workspace membership and left no acceptance marker", async function (this: AppWorld) {
  const stranger = actorNamed(this, "stranger");
  const members = await membersOf(this, owner(this), this.workspaceUri);
  assert.equal(members.some((entry) => entry.did === stranger.did), false);
  const spaces = await memberSpacesOn(this, stranger);
  assert.equal(spaces.includes(groupMembersUri(groupDidOf(this))), false, "no acceptance marker was written for a non-member");
});

Given("an invitee has been added to Group Host workspace membership", async function (this: AppWorld) {
  const { owner: actor } = await ownerInvites(this, "invitee");
  this.inviteLink = await copyInviteLink(actor);
});

When("the invitee joins the workspace from its invite link", async function (this: AppWorld) {
  const invitee = actorNamed(this, "invitee");
  await openInviteLinkAndSignIn(this, invitee, this.inviteLink);
  await joinFromInvitation(invitee);
  await invitee.page.getByRole("heading", { name: this.workspaceName, exact: true }).waitFor({ state: "visible" });
});

Then("the workspace appears in that account's spaces index", async function (this: AppWorld) {
  const spaces = await memberSpacesOn(this, actorNamed(this, "invitee"));
  assert.ok(spaces.includes(groupMembersUri(groupDidOf(this))), "the acceptance marker makes the workspace discoverable from the invitee's own PDS");
});

Then("a second app reads the same directory and workspace roster", async function (this: AppWorld) {
  const invitee = actorNamed(this, "invitee");
  const seen = await withIndependentReader(this, invitee, async (reader, deps) =>
    (await reader.listIndependentWorkspaces(deps)).find((entry) => entry.uri === this.workspaceUri));
  assert.ok(seen, "the second app finds the workspace from the invitee's credentials alone");

  const summary = (await invitee.page.locator(".welcome-banner p").first().innerText()).trim();
  const directory = (await workspaceChannels(invitee.page).allInnerTexts()).map((entry) => entry.slice(1).trim()).sort();
  assert.ok(directory.length > 0, "the first app shows a directory to compare with");
  assert.equal(summary, `${seen.members.length} active members · ${seen.channels.length} channels · join policy: ${seen.joinPolicy}`, "the second app's roster is the one the first app shows");
  assert.deepEqual(seen.channels.map((channel) => channel.name).sort(), directory, "the second app's directory is the first app's");
});

// --- Administration (R13 OpenSocial Groups) ----------------------------------------------------------

Given("a person is signed in to create a workspace", async function (this: AppWorld) {
  const person = await this.actor("owner", 0);
  await signIn(this, person);
});

When("the person creates a workspace approved through the group host", async function (this: AppWorld) {
  const person = owner(this);
  const name = uniqueWorkspaceName();
  await submitWorkspaceName(person, name);
  await completeConsent(person);
  await waitForApp(this, person);
  await person.page.getByRole("heading", { name, exact: true }).waitFor({ state: "visible", timeout: 90_000 }).catch(async (error: unknown) => {
    throw new Error(`The workspace did not appear after group host approval. Page: ${(await person.page.locator("body").innerText()).slice(0, 2_000)}`, { cause: error });
  });
  this.workspaceName = name;
  this.workspaceUri = await workspaceUriOnPage(person);
});

Then("the workspace belongs to a dedicated group DID, and the person is its first admin while the group DID is not a member", async function (this: AppWorld) {
  const person = owner(this);
  const groupDid = groupDidOf(this);
  assert.ok(isDid(groupDid) && groupDid !== person.did, "the workspace belongs to a dedicated group DID");
  await waitForAdminControls(this, person);
  assert.deepEqual(groupEffectiveAdmins(this, groupDid), [person.did], "the creator is the sole effective human admin");
  assert.equal(groupSpaceRecord(this, groupMembersUri(groupDid), ATGRP_COLLECTION.membership, groupDid), undefined, "the group DID has no membership record");
  assert.equal((await membersOf(this, person, groupMembersUri(groupDid))).some((entry) => entry.did === person.did && entry.read && entry.write), true, "the creator is a member");
});

When("the person makes a second member an admin", async function (this: AppWorld) {
  const person = owner(this);
  const second = await this.actor("deputy", 1);
  await inviteMemberAs(person, second.did);
  const link = await copyInviteLink(person);
  await openInviteLinkAndSignIn(this, second, link);
  await joinFromInvitation(second);
  await promote(this, second);
});

When("both admins sign out", async function (this: AppWorld) {
  for (const role of ["owner", "deputy"]) await signOutAs(actorNamed(this, role));
});

Then("an admin who signs in again still administers the workspace", async function (this: AppWorld) {
  const second = actorNamed(this, "deputy");
  await signIn(this, second);
  await createChannelAs(this, second, "after sign out", "public");
});

Then("the group DID never signed in to the app", function (this: AppWorld) {
  const groupDid = groupDidOf(this);
  assert.equal([...this.actors.values()].some((actor) => actor.did === groupDid), false, "the group DID has no personal browser session");
});

Given("a signed-in person creates a workspace", async function (this: AppWorld) {
  const actor = await this.actor("owner");
  await signIn(this, actor);
});

When("the workspace is created", async function (this: AppWorld) {
  const actor = owner(this);
  this.workspaceName = uniqueWorkspaceName();
  await submitWorkspaceName(actor, this.workspaceName);
  await completeConsent(actor);
  await waitForApp(this, actor);
  await actor.page.getByRole("heading", { name: this.workspaceName, exact: true }).waitFor({ state: "visible" });
  this.workspaceUri = await workspaceUriOnPage(actor);
});

Then("a group-authored membership record grants the creator the admin role", function (this: AppWorld) {
  const groupDid = groupDidOf(this);
  const person = owner(this);
  const membership = groupSpaceRecord(this, groupMembersUri(groupDid), ATGRP_COLLECTION.membership, person.did);
  assert.ok(membership, "the group host stores a membership record for the creator");
  assert.ok(Array.isArray(membership.roles) && (membership.roles as string[]).includes("admin"), "the creator holds the admin role");
  assert.ok(groupEffectiveAdmins(this, groupDid).includes(person.did));
});

Then("the group authority holds the workspace profile while having no membership record of its own", function (this: AppWorld) {
  const groupDid = groupDidOf(this);
  assert.equal(groupSpaceRecord(this, groupMembersUri(groupDid), ATGRP_COLLECTION.membership, groupDid), undefined, "the group DID is not on its own member list");
  const about = groupSpaceRecord(this, groupMetaUri(groupDid), ATGRP_COLLECTION.about, "self");
  assert.equal(about?.displayName, this.workspaceName, "the group's meta/self space holds the workspace about record");
});

async function promote(world: AppWorld, member: Actor): Promise<void> {
  const row = owner(world).page.locator(".roster-row").filter({ hasText: member.did });
  await row.getByRole("button", { name: "Make admin", exact: true }).click();
  await row.getByRole("button", { name: "Demote admin", exact: true }).waitFor({ state: "visible", timeout: 60_000 });
}

Given("a user holds the group-authored admin role", async function (this: AppWorld) {
  const { invitee } = await ownerInvites(this, "member", { inviteeHost: 0 });
  await promote(this, invitee);
  assert.ok(groupEffectiveAdmins(this, groupDidOf(this)).includes(invitee.did));
  await this.actor("outsider", 0);
});

When("that user calls a group space mutation with only their personal PDS token", async function (this: AppWorld) {
  const groupDid = groupDidOf(this);
  const member = actorNamed(this, "member");
  const outsider = actorNamed(this, "outsider");
  const response = await fetch(new URL("/xrpc/com.atproto.space.putRecord", this.fixture.groupHostUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${member.accessJwt}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      space: groupMembersUri(groupDid),
      repo: groupDid,
      collection: ATGRP_COLLECTION.membership,
      rkey: outsider.did,
      record: {
        $type: ATGRP_COLLECTION.membership,
        roles: ["member"],
        createdAt: new Date().toISOString(),
      },
    }),
  });
  const text = await response.text();
  this.scratch.set("managementAttempt", { status: response.status, body: text ? (JSON.parse(text) as { error?: string }) : {} });
});

Then("the group host rejects the operation", function (this: AppWorld) {
  const attempt = this.scratch.get("managementAttempt") as { status: number; body: { error?: string } };
  assert.ok(attempt.status === 401 || attempt.status === 403, `expected 401/403 rejection, got ${attempt.status} ${JSON.stringify(attempt.body)}`);
  assert.equal(groupHasHumanMember(this, groupDidOf(this), actorNamed(this, "outsider").did), false, "the rejected operation changed nothing");
});

// --- The final admin cannot leave or be demoted (bound against real UI + AppFixture) -----------------

Given("a workspace has one active admin", async function (this: AppWorld) {
  const { owner: admin, invitee: member } = await ownerInvites(this, "member");
  await openInviteLinkAndSignIn(this, member, await copyInviteLink(admin));
  await joinFromInvitation(member);
  await member.page.getByRole("heading", { name: this.workspaceName, exact: true }).waitFor({ state: "visible" });
  await admin.page.getByRole("button", { name: /Refresh/ }).click();
  await admin.page.getByText(/(^|\D)2 active members/).waitFor({ state: "visible" });
  assert.deepEqual(groupEffectiveAdmins(this, groupDidOf(this)), [admin.did]);
});

When("that admin leaves, is removed, or is demoted", async function (this: AppWorld) {
  const admin = owner(this);
  const ownRow = admin.page.locator(".roster-row").filter({ hasText: admin.did });

  // 1) Leave workspace via the UI's "Leave this workspace" button (calls Group Host `org.atgrp.leave` -> `LastAdmin`).
  await admin.page.getByRole("button", { name: "Leave this workspace", exact: true }).click();
  const leaveAlert = admin.page.locator("p.form-error[role=alert]");
  await leaveAlert.waitFor({ state: "visible", timeout: 60_000 });
  const leaveError = (await leaveAlert.innerText()).trim();

  // 2) Remove self via the UI's "Remove" button on the admin's own roster row.
  const removeAttempt = await submitAndWait(this, admin, async () => {
    await ownRow.getByRole("button", { name: "Remove", exact: true }).click();
  });

  // 3) Demote self via the UI's "Demote admin" button on the admin's own roster row.
  const demoteAttempt = await submitAndWait(this, admin, async () => {
    await ownRow.getByRole("button", { name: "Demote admin", exact: true }).click();
  });

  this.scratch.set("finalAdminAttempts", { leaveError, removeAttempt, demoteAttempt });
});

Then("the operation is rejected", async function (this: AppWorld) {
  const admin = owner(this);
  const { leaveError, removeAttempt, demoteAttempt } = this.scratch.get("finalAdminAttempts") as {
    leaveError: string;
    removeAttempt: Executed;
    demoteAttempt: Executed;
  };

  assert.match(leaveError, /last.*admin|sole.*admin|cannot leave|LastAdmin/i, `leaving as the sole admin with another member present was rejected: ${leaveError}`);
  assert.equal(removeAttempt.operation?.state, "failed", JSON.stringify(removeAttempt));
  assert.match(removeAttempt.operation?.error ?? "", /last active admin cannot leave or be removed/i);
  assert.equal(demoteAttempt.operation?.state, "failed", JSON.stringify(demoteAttempt));
  assert.match(demoteAttempt.operation?.error ?? "", /last active admin cannot be demoted/i);

  assert.deepEqual(groupEffectiveAdmins(this, groupDidOf(this)), [admin.did], "the sole admin remains an active admin");
  assert.equal(groupHasHumanMember(this, groupDidOf(this), admin.did), true, "the sole admin remains a member");
  await admin.page.getByRole("heading", { name: this.workspaceName, exact: true }).waitFor({ state: "visible" });
});

// --- Promote and demote an admin ---------------------------------------------------------------------

Given("a current workspace member is not an admin", async function (this: AppWorld) {
  await ownerInvites(this, "member");
});

When("an admin promotes that member", async function (this: AppWorld) {
  await promote(this, actorNamed(this, "member"));
});

Then("the member receives inbox read access and the admin role", async function (this: AppWorld) {
  const member = actorNamed(this, "member");
  const groupDid = groupDidOf(this);
  const inbox = await membersOf(this, owner(this), inboxUri(groupDid, workspaceSkey(this)));
  assert.equal(inbox.find((entry) => entry.did === member.did)?.read, true);
  assert.ok(groupEffectiveAdmins(this, groupDid).includes(member.did));
});

When("the member is demoted", async function (this: AppWorld) {
  const row = owner(this).page.locator(".roster-row").filter({ hasText: actorNamed(this, "member").did });
  await row.getByRole("button", { name: "Demote admin", exact: true }).click();
  await row.getByRole("button", { name: "Make admin", exact: true }).waitFor({ state: "visible", timeout: 60_000 });
});

Then("inbox read access is removed with the admin role", async function (this: AppWorld) {
  const member = actorNamed(this, "member");
  const groupDid = groupDidOf(this);
  const inbox = await membersOf(this, owner(this), inboxUri(groupDid, workspaceSkey(this)));
  assert.equal(inbox.find((entry) => entry.did === member.did)?.read, false);
  assert.equal(groupEffectiveAdmins(this, groupDid).includes(member.did), false);
  let row: { steps_json: string } | undefined;
  await eventually(() => {
    row = this.withAppDatabase((db) => db.prepare(
      "SELECT steps_json FROM operation WHERE request_json LIKE '%\"kind\":\"setAdmin\"%' AND request_json LIKE '%\"active\":false%' AND request_json LIKE ? AND state = 'completed'",
    ).get(`%${member.did}%`) as { steps_json: string } | undefined);
    return row !== undefined;
  }, { what: "the demotion operation to finish committing" });
  assert.ok(row, "the demotion was journaled");
  const steps = JSON.parse(row.steps_json) as string[];
  assert.deepEqual(steps, ["write-admin-inactive", "admin-state-verified"]);
});
