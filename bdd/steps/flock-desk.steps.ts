import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@playwright/test";
import { channelUri } from "@flock/protocol/keys";
import { COLLECTION } from "@flock/protocol/nsids";
import type { DeskApp } from "../../protocol-tests/support/app-fixture";
import { openChannel, postMessage } from "../support/channels-ui";
import { groupDidOf } from "../support/group-state";
import {
  createChannelAs,
  joinWorkspaceDeskAt,
  onPrimaryApp,
  openViewer,
  signInDeskAt,
  type AppViewer,
} from "../support/independent-app-ui";
import { completeConsent, createWorkspaceAs, inviteMemberAs, waitForAdminControls } from "../support/ui";
import type { AppWorld } from "../support/world";

let sharedDeskApp: DeskApp | undefined;

async function ensureDeskApp(world: AppWorld): Promise<DeskApp> {
  if (!sharedDeskApp) {
    sharedDeskApp = await world.fixture.startDeskApp();
  }
  world.scratch.set("deskApp", sharedDeskApp);
  return sharedDeskApp;
}

function deskAppOf(world: AppWorld): DeskApp {
  const app = world.scratch.get("deskApp") as DeskApp | undefined;
  assert.ok(app, "Flock Desk server has not been started in this scenario");
  return app;
}

function assertNoOperatorCalls(world: AppWorld, viewer: AppViewer): void {
  const operatorCalls = viewer.requestUrls.filter((u) => new URL(u).origin === world.operatorOrigin);
  assert.deepEqual(operatorCalls, [], "Flock Desk must never send HTTP requests to the Operator");
}

async function connectGroupGovernance(owner: AppViewer): Promise<void> {
  const governanceSection = owner.page.getByRole("region", { name: "OpenSocial group governance" });
  await governanceSection.getByRole("button", { name: "Sign in as group admin →" }).click();
  await completeConsent(owner);
  await governanceSection.getByRole("button", { name: "Disconnect group session", exact: true }).waitFor({
    state: "visible",
    timeout: 60_000,
  });
}

// --- Shared Desk setup ------------------------------------------------------------------------------

Given("Flock Desk is running without an Operator server", { timeout: 120_000 }, async function (this: AppWorld) {
  const desk = await ensureDeskApp(this);
  assert.equal(desk.operatorUrl, null, "Flock Desk runs with no Operator server");
  assert.equal(desk.databasePath, null, "Flock Desk runs with no SQLite database");
});

// --- Scenario 1: Reject server URL input and sign in with least-privilege scopes --------------------

When(
  "an unauthenticated visitor submits a raw server URL on the Desk sign-in form",
  { timeout: 120_000 },
  async function (this: AppWorld) {
    const desk = deskAppOf(this);
    const account = await this.fixture.createAccount(`deskvis${Date.now().toString(36).slice(-5)}.test`, 0);
    const visitor = await openViewer(this, { ...account, role: "visitor", context: undefined!, page: undefined!, xrpc: [] }, desk.appUrl.origin, "visitor@desk");
    this.scratch.set("deskVisitor", visitor);

    await visitor.page.goto(desk.appUrl.origin);
    await visitor.page.getByTestId("desk-handle-input").waitFor({ state: "visible" });
    await visitor.page.waitForFunction(() => {
      const btn = document.querySelector('[data-testid="desk-signin-button"]') as HTMLButtonElement | null;
      return Boolean(btn && !btn.disabled);
    });
    await visitor.page.getByTestId("desk-handle-input").fill("https://pds.evil.example");
    await visitor.page.getByTestId("desk-signin-button").click();
  },
);

Then("Desk rejects the URL locally without leaving its origin", async function (this: AppWorld) {
  const desk = deskAppOf(this);
  const visitor = this.scratch.get("deskVisitor") as AppViewer;
  const errBanner = visitor.page.getByTestId("desk-signin-error");
  await errBanner.waitFor({ state: "visible", timeout: 15_000 });
  assert.match(await errBanner.innerText(), /ATProto handle|not a server URL/i);
  assert.equal(new URL(visitor.page.url()).origin, desk.appUrl.origin);
});

When("that person signs in to Desk with their ATProto identity", { timeout: 120_000 }, async function (this: AppWorld) {
  const visitor = this.scratch.get("deskVisitor") as AppViewer;
  const scopes = await signInDeskAt(visitor);
  this.scratch.set("grantedDeskScopes", scopes);
});

Then("Desk receives only least-privilege member scopes and never contacts the Operator", async function (this: AppWorld) {
  const visitor = this.scratch.get("deskVisitor") as AppViewer;
  const scopes = this.scratch.get("grantedDeskScopes") as string[];
  assert.ok(scopes.includes("atproto"));
  assert.ok(scopes.some((s) => s.includes("new.flock.channel.message")));
  assert.equal(scopes.some((s) => s.includes("new.flock.operator.")), false);
  assert.equal(scopes.some((s) => s.includes("new.flock.channel.reaction")), false);
  assert.equal(scopes.some((s) => s.includes("new.flock.dm.")), false);
  assert.equal(scopes.some((s) => s.includes("new.flock.ext.tasks")), false);
  await visitor.page.getByTestId("desk-viewer-did").waitFor({ state: "visible" });
  assert.equal((await visitor.page.getByTestId("desk-viewer-did").innerText()).trim(), visitor.did);
  assertNoOperatorCalls(this, visitor);
});

// --- Scenario 2: Join a workspace via an invite link across sign-in ---------------------------------

Given("a workspace with a private channel exists on Flock Web", { timeout: 180_000 }, async function (this: AppWorld) {
  const owner = onPrimaryApp(this, await this.actor("owner", 0));
  await createWorkspaceAs(this, owner);
  await waitForAdminControls(this, owner);

  const memberAccount = await this.fixture.createAccount(`deskmbr${Date.now().toString(36).slice(-5)}.test2`, 1);
  this.scratch.set("invitedMemberAccount", memberAccount);

  await inviteMemberAs(owner, memberAccount.did);
  await createChannelAs(owner, "Vault", { privateMembers: [memberAccount.did] });
});

When(
  "an invited member opens the Desk invite link while signed out and completes sign-in",
  { timeout: 180_000 },
  async function (this: AppWorld) {
    const desk = deskAppOf(this);
    const memberAccount = this.scratch.get("invitedMemberAccount") as AppViewer;
    const memberDesk = await openViewer(this, memberAccount, desk.appUrl.origin, "member@desk");
    this.scratch.set("memberDesk", memberDesk);
    await joinWorkspaceDeskAt(memberDesk, this.workspaceUri, this.workspaceName);
  },
);

Then("the invitation survives sign-in and joins the workspace directly on the Group Host", async function (this: AppWorld) {
  const memberDesk = this.scratch.get("memberDesk") as AppViewer;
  await memberDesk.page.getByRole("heading", { name: this.workspaceName, exact: true }).waitFor({ state: "visible" });
  assertNoOperatorCalls(this, memberDesk);
});

Then(
  "Desk displays the workspace summary, member roster, and private channel roster",
  { timeout: 120_000 },
  async function (this: AppWorld) {
    const memberDesk = this.scratch.get("memberDesk") as AppViewer;
    const summary = (await memberDesk.page.getByTestId("desk-workspace-summary").innerText()).trim();
    assert.equal(summary, "2 active members · 2 channels · join policy: invite");
    const rosterText = await memberDesk.page.getByTestId("desk-member-roster").innerText();
    assert.ok(rosterText.includes(memberDesk.did), "member roster includes joined member");

    await memberDesk.page.locator('[data-testid="desk-channel-item"][data-channel-name="Vault"]').click();
    await memberDesk.page
      .locator('[data-testid="desk-channel-view"][data-ready="true"]')
      .waitFor({ state: "visible" });
    assert.equal((await memberDesk.page.getByTestId("desk-private-roster").innerText()).trim(), memberDesk.did);
  },
);

// --- Scenario 3: Expiring cross-PDS invitation inbox ------------------------------------------------

Given(
  "a workspace admin with a connected group governance session exists on Flock Web",
  { timeout: 180_000 },
  async function (this: AppWorld) {
    const owner = onPrimaryApp(this, await this.actor("owner", 0));
    await createWorkspaceAs(this, owner);
    await waitForAdminControls(this, owner);
    await connectGroupGovernance(owner);
  },
);

When(
  "a signed-in Desk user receives an expiring cross-PDS invitation and accepts it from the Desk inbox",
  { timeout: 180_000 },
  async function (this: AppWorld) {
    const desk = deskAppOf(this);
    const owner = onPrimaryApp(this, this.actors.get("owner")!);
    const inviteeAccount = await this.fixture.createAccount(`deskinv${Date.now().toString(36).slice(-5)}.test2`, 1);
    const inviteeDesk = await openViewer(this, { ...inviteeAccount, role: "invitee", context: undefined!, page: undefined!, xrpc: [] }, desk.appUrl.origin, "invitee@desk");
    this.scratch.set("inviteeDesk", inviteeDesk);

    await inviteeDesk.page.goto(desk.appUrl.origin);
    await signInDeskAt(inviteeDesk);

    const governanceSection = owner.page.getByRole("region", { name: "OpenSocial group governance" });
    await governanceSection.getByLabel("Cross-PDS invitee DID").fill(inviteeDesk.did);
    await governanceSection.getByRole("button", { name: "Send cross-PDS invite →" }).click();
    await owner.page
      .getByText("Cross-PDS invitation written and queued for delivery.", { exact: true })
      .waitFor({ state: "visible" });

    const inbox = inviteeDesk.page.getByTestId("desk-invites-inbox");
    await expect(async () => {
      await inviteeDesk.page.getByTestId("desk-refresh-button").click();
      await expect(inbox.getByTestId("desk-invite-card").first()).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 45_000 });

    await inbox.getByTestId("desk-accept-invite-button").first().click();
    await inviteeDesk.page
      .getByRole("heading", { name: this.workspaceName, exact: true })
      .waitFor({ state: "visible", timeout: 60_000 });
  },
);

Then("the user joins the workspace directly without contacting the Operator", async function (this: AppWorld) {
  const inviteeDesk = this.scratch.get("inviteeDesk") as AppViewer;
  const summary = (await inviteeDesk.page.getByTestId("desk-workspace-summary").innerText()).trim();
  assert.match(summary, /^2 active members · /);
  assertNoOperatorCalls(this, inviteeDesk);
});

// --- Scenario 4: Cross-client post, reply, edit, and delete -----------------------------------------

const WEB_SEED_NOTE = "Seed message from Flock Web";
const DESK_INITIAL_NOTE = "Original post from Flock Desk";
const DESK_EDITED_NOTE = "Edited message from Flock Desk";
const DESK_REPLY_NOTE = "Thread reply from Flock Desk";

Given(
  "a workspace member is signed in to both Flock Web and Flock Desk",
  { timeout: 180_000 },
  async function (this: AppWorld) {
    const desk = deskAppOf(this);
    const owner = onPrimaryApp(this, await this.actor("owner", 0));
    await createWorkspaceAs(this, owner);
    await waitForAdminControls(this, owner);

    const memberAccount = await this.fixture.createAccount(`deskmsg${Date.now().toString(36).slice(-5)}.test2`, 1);
    await inviteMemberAs(owner, memberAccount.did);

    await openChannel(owner, "general");
    await postMessage(owner, WEB_SEED_NOTE);

    const memberDesk = await openViewer(this, { ...memberAccount, role: "member", context: undefined!, page: undefined!, xrpc: [] }, desk.appUrl.origin, "member@desk");
    this.scratch.set("memberDesk", memberDesk);
    await joinWorkspaceDeskAt(memberDesk, this.workspaceUri, this.workspaceName);
  },
);

When(
  "the member posts, edits, replies to a Web message, and deletes their reply in Flock Desk",
  { timeout: 180_000 },
  async function (this: AppWorld) {
    const owner = onPrimaryApp(this, this.actors.get("owner")!);
    const memberDesk = this.scratch.get("memberDesk") as AppViewer;

    await memberDesk.page.locator('[data-testid="desk-channel-item"][data-channel-name="general"]').click();
    await memberDesk.page
      .locator('[data-testid="desk-channel-view"][data-channel-skey="general"][data-ready="true"]')
      .waitFor({ state: "visible" });
    await memberDesk.page.getByText(WEB_SEED_NOTE, { exact: true }).waitFor({ state: "visible" });

    // Post + Edit
    await memberDesk.page.getByTestId("desk-message-input").fill(DESK_INITIAL_NOTE);
    await memberDesk.page.getByTestId("desk-send-button").click();
    await memberDesk.page.getByText(DESK_INITIAL_NOTE, { exact: true }).waitFor({ state: "visible" });

    const ownItem = memberDesk.page.getByTestId("desk-message-item").filter({ hasText: DESK_INITIAL_NOTE });
    await ownItem.getByTestId("desk-edit-message-button").click();
    await memberDesk.page.getByTestId("desk-edit-message-input").fill(DESK_EDITED_NOTE);
    await memberDesk.page.getByTestId("desk-save-edit-button").click();
    await memberDesk.page.getByText(DESK_EDITED_NOTE, { exact: true }).waitFor({ state: "visible" });

    // Reply to Web message
    const seedItem = memberDesk.page.getByTestId("desk-message-item").filter({ hasText: WEB_SEED_NOTE });
    await seedItem.getByTestId("desk-reply-message-button").click();
    await memberDesk.page.getByTestId("desk-message-input").fill(DESK_REPLY_NOTE);
    await memberDesk.page.getByTestId("desk-send-button").click();
    await memberDesk.page.getByText(DESK_REPLY_NOTE, { exact: true }).waitFor({ state: "visible" });

    // Verify reply visible on Flock Web before deleting it in Desk
    await openChannel(owner, "general");
    await owner.page.getByRole("button", { name: "Sync ↻" }).click();
    await owner.page.locator(".message-card").filter({ hasText: DESK_EDITED_NOTE }).waitFor({ state: "visible" });
    await owner.page.locator(".message-card").filter({ hasText: DESK_REPLY_NOTE }).waitFor({ state: "visible" });

    // Delete reply in Desk
    const replyItem = memberDesk.page.getByTestId("desk-message-item").filter({ hasText: DESK_REPLY_NOTE });
    await replyItem.getByTestId("desk-delete-message-button").click();
    await replyItem.waitFor({ state: "hidden", timeout: 30_000 });
  },
);

Then(
  "Flock Web observes the edited message, the reply, and the deletion directly from the writer PDS",
  { timeout: 120_000 },
  async function (this: AppWorld) {
    const owner = onPrimaryApp(this, this.actors.get("owner")!);
    const memberDesk = this.scratch.get("memberDesk") as AppViewer;

    await owner.page.getByRole("button", { name: "Sync ↻" }).click();
    await owner.page.locator(".message-card").filter({ hasText: DESK_EDITED_NOTE }).waitFor({ state: "visible" });
    await owner.page
      .locator(".message-card")
      .filter({ hasText: DESK_REPLY_NOTE })
      .waitFor({ state: "hidden", timeout: 30_000 });
    assertNoOperatorCalls(this, memberDesk);
  },
);

// --- Scenario 5: Fresh pre-write credential enforcement on removed member ---------------------------

const BLOCKED_POST_TEXT = "Write after removal must fail immediately";

Given("a workspace member has a channel open in Flock Desk", { timeout: 180_000 }, async function (this: AppWorld) {
  const desk = deskAppOf(this);
  const owner = onPrimaryApp(this, await this.actor("owner", 0));
  await createWorkspaceAs(this, owner);
  await waitForAdminControls(this, owner);

  const memberAccount = await this.fixture.createAccount(`deskrem${Date.now().toString(36).slice(-5)}.test2`, 1);
  await inviteMemberAs(owner, memberAccount.did);

  const memberDesk = await openViewer(this, { ...memberAccount, role: "removed", context: undefined!, page: undefined!, xrpc: [] }, desk.appUrl.origin, "removed@desk");
  this.scratch.set("removedDesk", memberDesk);
  await joinWorkspaceDeskAt(memberDesk, this.workspaceUri, this.workspaceName);

  await memberDesk.page.locator('[data-testid="desk-channel-item"][data-channel-name="general"]').click();
  await memberDesk.page
    .locator('[data-testid="desk-channel-view"][data-channel-skey="general"][data-ready="true"]')
    .waitFor({ state: "visible" });
});

When(
  "an admin removes that member in Flock Web and the removed member tries to post in Flock Desk",
  { timeout: 180_000 },
  async function (this: AppWorld) {
    const owner = onPrimaryApp(this, this.actors.get("owner")!);
    const removedDesk = this.scratch.get("removedDesk") as AppViewer;

    const rosterRow = owner.page
      .locator(".starter-card.roster-list")
      .first()
      .locator(".roster-row")
      .filter({ hasText: removedDesk.did });
    await rosterRow.getByRole("button", { name: "Remove", exact: true }).click();
    await rosterRow.waitFor({ state: "hidden", timeout: 60_000 });

    await removedDesk.page.getByTestId("desk-message-input").fill(BLOCKED_POST_TEXT);
    await removedDesk.page.getByTestId("desk-send-button").click();
  },
);

Then(
  "Desk displays a write rejection error and nothing is written to the removed member's PDS",
  { timeout: 120_000 },
  async function (this: AppWorld) {
    const removedDesk = this.scratch.get("removedDesk") as AppViewer;
    const errBanner = removedDesk.page.getByTestId("desk-channel-error");
    await errBanner.waitFor({ state: "visible", timeout: 30_000 });
    assert.ok((await errBanner.innerText()).trim().length > 0);
    assert.equal(
      await removedDesk.page.getByTestId("desk-message-list").getByText(BLOCKED_POST_TEXT, { exact: true }).count(),
      0,
    );

    const generalSpace = channelUri(groupDidOf(this), "general");
    const repoList = await this.pdsGet<{ records?: Array<{ value?: { text?: string } }> }>(
      removedDesk,
      "com.atproto.space.listRecords",
      { space: generalSpace, repo: removedDesk.did, collection: COLLECTION.message, limit: "50" },
    );
    assert.equal(repoList.status, 200);
    const leaked = (repoList.body.records ?? []).some((rec) => rec.value?.text === BLOCKED_POST_TEXT);
    assert.equal(leaked, false, "rejected message must not exist in removed member's PDS repo");
    assertNoOperatorCalls(this, removedDesk);
  },
);

// --- Scenario 6: Moderation reporting, !hide veil/reveal, !takedown withholding ---------------------

const MOD_HIDE_NOTE = "Spoiler message to veil with !hide";
const MOD_TAKEDOWN_NOTE = "Message to remove with !takedown";

Given(
  "a workspace has a published group rule and messages in general",
  { timeout: 180_000 },
  async function (this: AppWorld) {
    const desk = deskAppOf(this);
    const owner = onPrimaryApp(this, await this.actor("owner", 0));
    await createWorkspaceAs(this, owner);
    await waitForAdminControls(this, owner);
    await connectGroupGovernance(owner);

    const moderationSection = owner.page.getByRole("region", { name: "Group moderation" });
    await moderationSection.getByLabel("Rule title").fill("No spoilers");
    await moderationSection.getByLabel("Rule description").fill("Keep spoilers out of #general.");
    await moderationSection.getByRole("button", { name: "Add rule →" }).click();
    await owner.page.getByText("Group rule published.", { exact: true }).waitFor({ state: "visible" });

    const memberAccount = await this.fixture.createAccount(`deskmod${Date.now().toString(36).slice(-5)}.test2`, 1);
    await inviteMemberAs(owner, memberAccount.did);

    await openChannel(owner, "general");
    await postMessage(owner, MOD_TAKEDOWN_NOTE);

    const memberDesk = await openViewer(this, { ...memberAccount, role: "reporter", context: undefined!, page: undefined!, xrpc: [] }, desk.appUrl.origin, "reporter@desk");
    this.scratch.set("reporterDesk", memberDesk);
    await joinWorkspaceDeskAt(memberDesk, this.workspaceUri, this.workspaceName);

    await memberDesk.page.locator('[data-testid="desk-channel-item"][data-channel-name="general"]').click();
    await memberDesk.page
      .locator('[data-testid="desk-channel-view"][data-channel-skey="general"][data-ready="true"]')
      .waitFor({ state: "visible" });

    // Member authors MOD_HIDE_NOTE so we verify Edit & Reply suppression non-vacuously!
    await memberDesk.page.getByTestId("desk-message-input").fill(MOD_HIDE_NOTE);
    await memberDesk.page.getByTestId("desk-send-button").click();
    const hideCard = memberDesk.page.getByTestId("desk-message-item").filter({ hasText: MOD_HIDE_NOTE });
    await hideCard.waitFor({ state: "visible" });
    assert.equal(await hideCard.getByTestId("desk-edit-message-button").count(), 1);
    assert.equal(await hideCard.getByTestId("desk-reply-message-button").count(), 1);
  },
);

When(
  "a Desk member submits a rule-violation report and a spam report directly to the Group Host",
  { timeout: 120_000 },
  async function (this: AppWorld) {
    const reporterDesk = this.scratch.get("reporterDesk") as AppViewer;

    const hideItem = reporterDesk.page.getByTestId("desk-message-item").filter({ hasText: MOD_HIDE_NOTE });
    const hideUri = await hideItem.getAttribute("data-message-uri");
    assert.ok(hideUri);
    this.scratch.set("modHideUri", hideUri);
    await hideItem.getByTestId("desk-report-message-button").click();
    await reporterDesk.page.getByTestId("desk-report-panel").waitFor({ state: "visible" });
    await reporterDesk.page.getByTestId("desk-report-reason-type").selectOption("violation");
    await reporterDesk.page.getByTestId("desk-report-rule-select").waitFor({ state: "visible" });
    await reporterDesk.page.getByTestId("desk-report-reason-input").fill("Spoiler reported from Desk");
    await reporterDesk.page.getByTestId("desk-report-submit-button").click();
    await reporterDesk.page.getByTestId("desk-report-confirmation").waitFor({ state: "visible" });

    const tdItem = reporterDesk.page.getByTestId("desk-message-item").filter({ hasText: MOD_TAKEDOWN_NOTE });
    const tdUri = await tdItem.getAttribute("data-message-uri");
    assert.ok(tdUri);
    this.scratch.set("modTakedownUri", tdUri);
    await tdItem.getByTestId("desk-report-message-button").click();
    await reporterDesk.page.getByTestId("desk-report-reason-type").selectOption("spam");
    await reporterDesk.page.getByTestId("desk-report-submit-button").click();
    await reporterDesk.page.getByTestId("desk-report-confirmation").waitFor({ state: "visible" });
  },
);

When(
  "a moderator applies hide and takedown labels to those messages in Flock Web",
  { timeout: 120_000 },
  async function (this: AppWorld) {
    const owner = onPrimaryApp(this, this.actors.get("owner")!);
    const hideUri = this.scratch.get("modHideUri") as string;
    const tdUri = this.scratch.get("modTakedownUri") as string;

    await owner.page.getByRole("button", { name: new RegExp(this.workspaceName) }).click();
    const moderationSection = owner.page.getByRole("region", { name: "Group moderation" });
    await moderationSection.getByRole("button", { name: "Refresh queue ↻" }).click();

    const hideRow = moderationSection.locator(".roster-row").filter({ hasText: hideUri });
    await hideRow.waitFor({ state: "visible" });
    await hideRow.getByRole("button", { name: "Apply !hide", exact: true }).click();
    await owner.page.getByText(`Published !hide label on ${hideUri}.`, { exact: true }).waitFor({ state: "visible" });

    const tdRow = moderationSection.locator(".roster-row").filter({ hasText: tdUri });
    await tdRow.waitFor({ state: "visible" });
    await tdRow.getByRole("button", { name: "Apply !takedown", exact: true }).click();
    await owner.page
      .getByText(`Published !takedown label on ${tdUri}.`, { exact: true })
      .waitFor({ state: "visible" });
  },
);

Then(
  "Desk withholds the taken-down message and veils the hidden message until explicitly revealed",
  { timeout: 120_000 },
  async function (this: AppWorld) {
    const reporterDesk = this.scratch.get("reporterDesk") as AppViewer;
    const hideUri = this.scratch.get("modHideUri") as string;
    const tdUri = this.scratch.get("modTakedownUri") as string;

    await reporterDesk.page.getByTestId("desk-channel-refresh-button").click();
    const veiledItem = reporterDesk.page.locator(
      `[data-testid="desk-message-item"][data-message-uri="${hideUri}"][data-hidden="true"]`,
    );
    await veiledItem.waitFor({ state: "visible" });
    assert.equal(await reporterDesk.page.getByText(MOD_HIDE_NOTE, { exact: true }).count(), 0);
    assert.equal(await veiledItem.getByTestId("desk-edit-message-button").count(), 0);
    assert.equal(await veiledItem.getByTestId("desk-reply-message-button").count(), 0);
    assert.equal(await reporterDesk.page.locator(`[data-message-uri="${tdUri}"]`).count(), 0);

    await reporterDesk.page.getByTestId("desk-reveal-hidden-button").click();
    await reporterDesk.page.getByText(MOD_HIDE_NOTE, { exact: true }).waitFor({ state: "visible" });
    assert.equal(await veiledItem.getByTestId("desk-edit-message-button").count(), 1);
    assert.equal(await veiledItem.getByTestId("desk-reply-message-button").count(), 1);
    assertNoOperatorCalls(this, reporterDesk);
  },
);

// --- Scenario 7: Leave a workspace and erase local lifecycle data on sign-out -----------------------

Given(
  "a workspace member is signed in to Flock Desk with an active workspace",
  { timeout: 180_000 },
  async function (this: AppWorld) {
    const desk = deskAppOf(this);
    const owner = onPrimaryApp(this, await this.actor("owner", 0));
    await createWorkspaceAs(this, owner);
    await waitForAdminControls(this, owner);

    const memberAccount = await this.fixture.createAccount(`desklv${Date.now().toString(36).slice(-5)}.test2`, 1);
    await inviteMemberAs(owner, memberAccount.did);

    const memberDesk = await openViewer(this, { ...memberAccount, role: "leaver", context: undefined!, page: undefined!, xrpc: [] }, desk.appUrl.origin, "leaver@desk");
    this.scratch.set("leaverDesk", memberDesk);
    await joinWorkspaceDeskAt(memberDesk, this.workspaceUri, this.workspaceName);
  },
);

When(
  "the member leaves the workspace and signs out of Flock Desk",
  { timeout: 180_000 },
  async function (this: AppWorld) {
    const leaverDesk = this.scratch.get("leaverDesk") as AppViewer;
    const idbBefore = await leaverDesk.page.evaluate(async () =>
      (await indexedDB.databases()).map((d) => d.name ?? "").sort(),
    );
    this.scratch.set("idbBeforeSignOut", idbBefore);

    await leaverDesk.page.getByTestId("desk-leave-button").click();
    await leaverDesk.page
      .getByRole("heading", { name: "Welcome to Flock Desk", exact: true })
      .waitFor({ state: "visible", timeout: 60_000 });

    await leaverDesk.page.getByTestId("desk-signout-button").click();
    await leaverDesk.page.getByTestId("desk-handle-input").waitFor({ state: "visible", timeout: 30_000 });
  },
);

Then(
  "Desk holds zero sync caches and erases the account lifecycle database on sign-out",
  async function (this: AppWorld) {
    const leaverDesk = this.scratch.get("leaverDesk") as AppViewer;
    const idbBefore = this.scratch.get("idbBeforeSignOut") as string[];
    const idbAfter = await leaverDesk.page.evaluate(async () =>
      (await indexedDB.databases()).map((d) => d.name ?? "").sort(),
    );

    assert.equal(idbBefore.some((n) => n.startsWith("flock-sync-")), false, `Zero flock-sync-* caches before sign-out: ${JSON.stringify(idbBefore)}`);
    assert.ok(idbBefore.includes(`flock-desk-lifecycle:${leaverDesk.did}`), `Lifecycle DB present before sign-out: ${JSON.stringify(idbBefore)}`);
    assert.equal(idbAfter.some((n) => n.startsWith("flock-sync-")), false);
    assert.equal(
      idbAfter.includes(`flock-desk-lifecycle:${leaverDesk.did}`),
      false,
      `Lifecycle DB must be erased on sign-out: ${JSON.stringify(idbAfter)}`,
    );
    assertNoOperatorCalls(this, leaverDesk);
  },
);
