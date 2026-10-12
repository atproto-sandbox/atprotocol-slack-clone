import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { inboxUri } from "@/protocol/keys";
import { withIndependentReader, type WorkspaceState } from "../support/independent-app-ui";
import type { AppWorld, Actor } from "../support/world";
import {
  approveAdminControls, completeConsent, copyInviteLink, createWorkspaceAs, escapeRegExp, eventually, inviteMemberAs,
  joinFromInvitation, openInviteLinkAndSignIn, ownerInvites, signIn, submitWorkspaceName, uniqueWorkspaceName, waitForApp, workspaceUriOnPage,
} from "../support/ui";

type Member = { did: string; read: boolean; write: boolean };

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

async function membersOf(world: AppWorld, as: Actor, space: string): Promise<Member[]> {
  const result = await world.pdsGet<{ members?: Member[] }>(as, "com.atproto.simplespace.listMembers", { space, limit: "1000" });
  assert.equal(result.status, 200, `listMembers ${space}: ${JSON.stringify(result.body)}`);
  return result.body.members ?? [];
}

async function adminRecords(world: AppWorld, as: Actor): Promise<Array<{ subject: string; active: boolean }>> {
  const result = await world.pdsGet<{ records?: Array<{ value: { subject: string; active: boolean } }> }>(
    as, "com.atproto.space.listRecords", { space: world.workspaceUri, repo: as.did, collection: "org.slack.admin", limit: "100" },
  );
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return (result.body.records ?? []).map((record) => record.value);
}

const workspaceSkey = (world: AppWorld): string => world.workspaceUri.split("/").at(-1)!;

/** The workspace spaces an account's own PDS lists, whatever the app says about them. */
async function workspaceSpacesOn(world: AppWorld, as: Actor): Promise<string[]> {
  const listed = await world.pdsGet<{ spaces: Array<{ uri: string }> }>(as, "com.atproto.space.listSpaces", { type: "org.slack.workspace", limit: "100" });
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  return listed.body.spaces.map((space) => space.uri);
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
  const first = await eventually(() => this.callsTo(owner(this), "/api/workspaces/bootstrap")[0], { what: "the first create request" });
  assert.equal(first.status, 403);
  const body = JSON.parse(first.responseBody) as { code?: string; action?: string };
  assert.equal(body.code, "authorization_required");
  assert.equal(body.action, "workspaceAuthority");
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
  const retried = this.callsTo(actor, "/api/workspaces/bootstrap").filter((call) => (JSON.parse(call.requestBody) as { operationId: string }).operationId === operationId);
  assert.ok(retried.length >= 2, "the same operation ID was submitted again after approval");
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
  await eventually(() => this.callsTo(actor, "/api/workspaces/bootstrap").length >= 2, { what: "the setup to resume after returning" });
  await actor.page.waitForLoadState("networkidle");
  assert.equal(this.callsTo(actor, "/api/workspaces/bootstrap").length, 2, "setup was attempted once at submit and resumed exactly once");
});

Then("it shows a clear error instead of redirecting again", async function (this: AppWorld) {
  const actor = owner(this);
  await actor.page.getByText(/Permission was not granted/).waitFor({ state: "visible" });
  assert.doesNotMatch(actor.page.url(), /\/oauth\/authorize/, "the account was not sent to approve the permission a second time");
  assert.equal(this.callsTo(actor, "/api/oauth/permission").length, 1, "only the first attempt asked for permission");
});

// --- Invitations ------------------------------------------------------------------------------------

Given("a workspace has one active owner and two public channels", async function (this: AppWorld) {
  const actor = await this.actor("owner");
  await createWorkspaceAs(this, actor);
  await approveAdminControls(this, actor);
  await actor.page.getByLabel("Channel name").fill("Second Room");
  await actor.page.locator("form").filter({ has: actor.page.getByLabel("Channel name") }).getByRole("button", { name: /Create channel/ }).click();
  await actor.page.getByRole("button", { name: /Second Room/ }).waitFor({ state: "visible" });
});

When("an admin invites a DID that is not a workspace member", async function (this: AppWorld) {
  const invitee = await this.actor("invitee", 1);
  await inviteMemberAs(owner(this), invitee.did);
});

Then("the DID has read and write access to the workspace", async function (this: AppWorld) {
  const member = (await membersOf(this, owner(this), this.workspaceUri)).find((entry) => entry.did === actorNamed(this, "invitee").did);
  assert.deepEqual(member && { read: member.read, write: member.write }, { read: true, write: true });
});

Then("the DID has write-only access to the admin inbox", async function (this: AppWorld) {
  const inbox = inboxUri(owner(this).did, workspaceSkey(this));
  const member = (await membersOf(this, owner(this), inbox)).find((entry) => entry.did === actorNamed(this, "invitee").did);
  assert.deepEqual(member && { read: member.read, write: member.write }, { read: false, write: true });
});

Then("the DID has read and write access to each public channel", async function (this: AppWorld) {
  const spaces = await this.pdsGet<{ spaces: Array<{ uri: string }> }>(owner(this), "com.atproto.space.listSpaces", { type: "org.slack.channel", limit: "100" });
  assert.equal(spaces.body.spaces.length, 2, "the workspace has exactly two public channels");
  for (const space of spaces.body.spaces) {
    const member = (await membersOf(this, owner(this), space.uri)).find((entry) => entry.did === actorNamed(this, "invitee").did);
    assert.deepEqual(member && { read: member.read, write: member.write }, { read: true, write: true }, space.uri);
  }
});

Then("the invite is reported complete only after every member list matches", function (this: AppWorld) {
  const invitee = actorNamed(this, "invitee");
  const steps = this.withAppDatabase((db) => db.prepare(
    "SELECT steps_json FROM operation WHERE request_json LIKE ? AND request_json LIKE '%inviteMember%' AND state = 'completed'",
  ).get(`%${invitee.did}%`) as { steps_json: string } | undefined);
  assert.ok(steps, "the invite was recorded as completed");
  const recorded = JSON.parse(steps.steps_json) as string[];
  assert.equal(recorded.at(-1), "member-state-verified", "the last recorded step is the check that every member list matches");
  const trail = this.withAppDatabase((db) => db.prepare(
    "SELECT event FROM audit_event WHERE operation_id = (SELECT operation_id FROM operation WHERE request_json LIKE ? AND request_json LIKE '%inviteMember%' AND state = 'completed') ORDER BY id",
  ).all(`%${invitee.did}%`) as Array<{ event: string }>).map((row) => row.event);
  assert.deepEqual(trail.slice(-2), ["member-state-verified", "operationCompleted"], "completion is recorded only after the verification step");
});

Given("a workspace owner has created a workspace and approved admin controls", async function (this: AppWorld) {
  const actor = await this.actor("owner");
  await createWorkspaceAs(this, actor);
  await approveAdminControls(this, actor);
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
  assert.deepEqual([link.searchParams.get("invite")], await workspaceSpacesOn(this, owner(this)), "the invite parameter is the workspace space the owner's PDS holds");
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
  await joinFromInvitation(this, actorNamed(this, "member"));
});

Then("the workspace appears in the member's dashboard with {int} active members", async function (this: AppWorld, count: number) {
  const page = actorNamed(this, "member").page;
  await page.getByRole("heading", { name: this.workspaceName, exact: true }).waitFor({ state: "visible" });
  await page.getByText(new RegExp(`(^|\\D)${count} active members`)).waitFor({ state: "visible" });
  await page.locator(".sidebar").getByRole("button", { name: new RegExp(escapeRegExp(this.workspaceName)) }).waitFor({ state: "visible" });
});

Given("a DID is absent from a workspace member list", async function (this: AppWorld) {
  const actor = await this.actor("owner");
  await createWorkspaceAs(this, actor);
  this.inviteLink = await copyInviteLink(actor);
  await this.actor("stranger", 1);
});

When("that DID opens a forwarded invite link and tries to join", async function (this: AppWorld) {
  const stranger = actorNamed(this, "stranger");
  await openInviteLinkAndSignIn(this, stranger, this.inviteLink);
  await joinFromInvitation(this, stranger);
});

Then("the app says the account has not been added to the workspace", async function (this: AppWorld) {
  await actorNamed(this, "stranger").page.getByRole("alert").filter({ hasText: /haven't been added to this workspace/ }).waitFor({ state: "visible" });
  const accept = this.callsTo(actorNamed(this, "stranger"), "/api/workspaces/accept").at(-1);
  assert.equal(accept?.status, 403);
  assert.equal((JSON.parse(accept!.responseBody) as { code: string }).code, "not_a_member");
});

Then("the workspace does not appear in that account's dashboard", async function (this: AppWorld) {
  const stranger = actorNamed(this, "stranger");
  const page = stranger.page;
  await page.waitForLoadState("networkidle");
  const listing = this.callsTo(stranger, "/api/workspaces").at(-1);
  assert.ok(listing, "the dashboard asked the server for this account's workspaces");
  assert.deepEqual((JSON.parse(listing.responseBody) as { workspaces: Array<{ uri: string }> }).workspaces.map((entry) => entry.uri), [], "the server lists no workspace for this account");
  assert.equal(await page.getByRole("heading", { name: this.workspaceName, exact: true }).count(), 0);
  assert.equal(await page.locator(".sidebar").getByRole("button", { name: new RegExp(escapeRegExp(this.workspaceName)) }).count(), 0);
});

Then("the DID is still absent from the member list and left no acceptance marker", async function (this: AppWorld) {
  const stranger = actorNamed(this, "stranger");
  const members = await membersOf(this, owner(this), this.workspaceUri);
  assert.equal(members.some((entry) => entry.did === stranger.did), false);
  const spaces = await this.pdsGet<{ spaces: Array<{ uri: string }> }>(stranger, "com.atproto.space.listSpaces", { type: "org.slack.workspace", limit: "100" });
  assert.equal(spaces.body.spaces.some((space) => space.uri === this.workspaceUri), false, "no acceptance marker was written for a non-member");
});

Given("an invitee has been added to the workspace member list", async function (this: AppWorld) {
  const { owner: actor } = await ownerInvites(this, "invitee");
  this.inviteLink = await copyInviteLink(actor);
});

When("the invitee joins the workspace from its invite link", async function (this: AppWorld) {
  const invitee = actorNamed(this, "invitee");
  await openInviteLinkAndSignIn(this, invitee, this.inviteLink);
  await joinFromInvitation(this, invitee);
  await invitee.page.getByRole("heading", { name: this.workspaceName, exact: true }).waitFor({ state: "visible" });
});

Then("the workspace appears in that account's spaces index", async function (this: AppWorld) {
  const spaces = await this.pdsGet<{ spaces: Array<{ uri: string }> }>(actorNamed(this, "invitee"), "com.atproto.space.listSpaces", { type: "org.slack.workspace", limit: "100" });
  assert.ok(spaces.body.spaces.some((space) => space.uri === this.workspaceUri), "the acceptance marker makes the workspace discoverable from the invitee's own PDS");
});

Then("a second app reads the same directory and workspace roster", async function (this: AppWorld) {
  const invitee = actorNamed(this, "invitee");
  const seen = await withIndependentReader(this, invitee, async (reader, session) =>
    (await reader.listIndependentWorkspaces(session)).find((entry) => entry.uri === this.workspaceUri));
  assert.ok(seen, "the second app finds the workspace from the invitee's credentials alone");

  const { workspaces } = await invitee.page.evaluate(async () => (await fetch("/api/workspaces")).json()) as { workspaces: WorkspaceState[] };
  const primary = workspaces.find((entry) => entry.uri === this.workspaceUri);
  assert.ok(primary, "the app the invitee joined through lists the workspace");
  assert.ok(primary.members.length > 0 && primary.channels.length > 0, "the first app shows a roster and a directory to compare with");

  const directory = (channels: Array<{ skey: string; name: string; visibility: string }>) =>
    channels.map(({ skey, name, visibility }) => ({ skey, name, visibility })).sort((left, right) => left.name.localeCompare(right.name));
  assert.deepEqual([...seen.members].sort(), primary.members.map((member) => member.did).sort(), "the second app's roster is the first app's");
  assert.deepEqual([...seen.admins].sort(), [...primary.admins].sort(), "the second app's admins are the first app's");
  assert.deepEqual(directory(seen.channels), directory(primary.channels), "the second app's directory is the first app's");
});

// --- Administration ---------------------------------------------------------------------------------

Given("a workspace authority DID owns the workspace", async function (this: AppWorld) {
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

Then("an authority-authored active admin record exists for that DID", async function (this: AppWorld) {
  const records = await adminRecords(this, owner(this));
  assert.ok(records.some((record) => record.subject === owner(this).did && record.active));
});

Then("the authority can read the workspace without a member-list entry", async function (this: AppWorld) {
  const actor = owner(this);
  assert.equal((await membersOf(this, actor, this.workspaceUri)).some((entry) => entry.did === actor.did), false, "the authority is not on its own member list");
  const profile = await this.pdsGet<{ records?: Array<{ value: { name?: string } }> }>(actor, "com.atproto.space.listRecords", {
    space: this.workspaceUri, repo: actor.did, collection: "org.slack.workspace.profile", limit: "10",
  });
  assert.equal(profile.status, 200, `the authority's PDS lets it read its workspace: ${JSON.stringify(profile.body)}`);
  assert.deepEqual(profile.body.records?.map((record) => record.value.name), [this.workspaceName], "what it reads is the workspace it just created");
});

async function promote(world: AppWorld, member: Actor): Promise<void> {
  const row = owner(world).page.locator(".roster-row").filter({ hasText: member.did });
  await row.getByRole("button", { name: "Make admin", exact: true }).click();
  await row.getByRole("button", { name: "Demote admin", exact: true }).waitFor({ state: "visible", timeout: 60_000 });
}

Given("a user has an active authority-authored admin record", async function (this: AppWorld) {
  const { invitee } = await ownerInvites(this, "member", { inviteeHost: 0 });
  await promote(this, invitee);
  assert.ok((await adminRecords(this, owner(this))).some((record) => record.subject === invitee.did && record.active));
  await this.actor("outsider", 0);
});

When("that user calls a member-management operation without the authority session", async function (this: AppWorld) {
  const result = await this.pdsPost(actorNamed(this, "member"), "com.atproto.simplespace.putMember", {
    space: this.workspaceUri, did: actorNamed(this, "outsider").did, read: true, write: true,
  });
  this.scratch.set("managementAttempt", result);
});

Then("the PDS rejects the operation", async function (this: AppWorld) {
  const attempt = this.scratch.get("managementAttempt") as { status: number; body: { error?: string } };
  assert.ok(attempt.status >= 400, `expected a rejection, got ${attempt.status}`);
  assert.equal(attempt.body.error, "NotSpaceOwner", "rejected because the caller is not the space owner, whatever admin records say");
  const members = await membersOf(this, owner(this), this.workspaceUri);
  assert.equal(members.some((entry) => entry.did === actorNamed(this, "outsider").did), false, "the rejected operation changed nothing");
});

Given("a current workspace member is not an admin", async function (this: AppWorld) {
  await ownerInvites(this, "member");
});

When("an admin promotes that member", async function (this: AppWorld) {
  await promote(this, actorNamed(this, "member"));
});

Then("the member receives inbox read access and an active admin record", async function (this: AppWorld) {
  const member = actorNamed(this, "member");
  const inbox = await membersOf(this, owner(this), inboxUri(owner(this).did, workspaceSkey(this)));
  assert.equal(inbox.find((entry) => entry.did === member.did)?.read, true);
  assert.ok((await adminRecords(this, owner(this))).some((record) => record.subject === member.did && record.active));
});

When("the member is demoted", async function (this: AppWorld) {
  const row = owner(this).page.locator(".roster-row").filter({ hasText: actorNamed(this, "member").did });
  await row.getByRole("button", { name: "Demote admin", exact: true }).click();
  await row.getByRole("button", { name: "Make admin", exact: true }).waitFor({ state: "visible", timeout: 60_000 });
});

Then("inbox read access is removed before the admin record becomes inactive", async function (this: AppWorld) {
  const member = actorNamed(this, "member");
  const inbox = await membersOf(this, owner(this), inboxUri(owner(this).did, workspaceSkey(this)));
  assert.equal(inbox.find((entry) => entry.did === member.did)?.read, false);
  assert.equal((await adminRecords(this, owner(this))).find((record) => record.subject === member.did)?.active, false);
  const row = this.withAppDatabase((db) => db.prepare(
    "SELECT steps_json FROM operation WHERE request_json LIKE '%\"kind\":\"setAdmin\"%' AND request_json LIKE '%\"active\":false%' AND request_json LIKE ? AND state = 'completed'",
  ).get(`%${member.did}%`) as { steps_json: string } | undefined);
  assert.ok(row, "the demotion was journaled");
  const steps = JSON.parse(row.steps_json) as string[];
  assert.ok(steps.indexOf("remove-inbox-read") >= 0 && steps.indexOf("remove-inbox-read") < steps.indexOf("write-admin-inactive"), `step order was ${steps.join(", ")}`);
});

// --- Declining the join permission ------------------------------------------------------------------

When("the member declines the permission screen when joining", async function (this: AppWorld) {
  const member = actorNamed(this, "member");
  await member.page.getByRole("region", { name: "Workspace invitation" }).getByRole("button", { name: "Join this workspace" }).click();
  await completeConsent(member, "deny");
  await waitForApp(this, member);
});

Then("the app says the permission was not granted", async function (this: AppWorld) {
  const member = actorNamed(this, "member");
  await member.page.getByRole("alert").filter({ hasText: /Permission was not granted/ }).waitFor({ state: "visible" });
  assert.doesNotMatch(await member.page.locator("body").innerText(), /Missing required scope/, "no raw scope error reaches the person");
});

Then("the invitation is still offered", async function (this: AppWorld) {
  await actorNamed(this, "member").page.getByRole("region", { name: "Workspace invitation" }).waitFor({ state: "visible" });
});
