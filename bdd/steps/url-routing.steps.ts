import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { parseWorkspaceUri } from "@flock/protocol/keys";
import { expect, type JSHandle } from "@playwright/test";
import { workspaceRoute } from "@flock/web/app/ui/routes";
import type { ShellLifecycleSnapshot } from "@flock/web/browser/shell-lifecycle";
import { openChannel, postMessage, refreshUntil, syncUntil } from "../support/channels-ui";
import { dmcEnableDms, dmcOpenStartedConversation, dmcReloadAndAcceptFrom, dmcSend, dmcStartConversation } from "../support/dm-conversations-ui";
import { copyInviteLink, joinFromInvitation, openInviteLinkAndSignIn, ownerInvites, signInFromLoginForm, signOutAs } from "../support/ui";
import type { Actor, AppWorld } from "../support/world";

async function setUpWorkspaceWithMessage(world: AppWorld): Promise<{
  owner: Actor;
  member: Actor;
  workspaceUrl: string;
  permalinkUrl: string;
}> {
  const { owner, invitee: member } = await ownerInvites(world, "member");
  await openInviteLinkAndSignIn(world, member, await copyInviteLink(owner));
  await joinFromInvitation(member);
  await member.page.getByRole("heading", { name: world.workspaceName, exact: true }).waitFor({ state: "visible" });

  const parsedWorkspace = parseWorkspaceUri(world.workspaceUri);
  assert.ok(parsedWorkspace, `invalid workspace URI: ${world.workspaceUri}`);
  const workspaceUrl = `${world.appOrigin}${workspaceRoute(parsedWorkspace.authorityDid, parsedWorkspace.skey)}`;

  await openChannel(owner, "general");
  await postMessage(owner, "Permalink target message");
  const card = owner.page.locator(".message-card").filter({ hasText: "Permalink target message" }).first();
  await card.getByRole("button", { name: "Link", exact: true }).click();
  await owner.page.waitForURL(/\/w\/[^/]+\/[^/]+\/c\/[^/]+\/m\/[^/]+\/[^/?]+/, { timeout: 30_000 });
  await owner.page.locator('[data-highlighted="true"]').filter({ hasText: "Permalink target message" }).waitFor({ state: "visible" });
  const permalinkUrl = owner.page.url();

  world.scratch.set("routing:workspaceUrl", workspaceUrl);
  world.scratch.set("routing:permalinkUrl", permalinkUrl);
  return { owner, member, workspaceUrl, permalinkUrl };
}

Given("a workspace with a channel message and a direct message conversation", { timeout: 300_000 }, async function (this: AppWorld) {
  const { owner, member } = await setUpWorkspaceWithMessage(this);

  await dmcEnableDms(member, "everyone");
  await dmcEnableDms(owner, "everyone");
  await dmcStartConversation(owner, [member.did]);
  await dmcOpenStartedConversation(owner);
  await dmcSend(owner, "DM deep link message");
  await owner.page.waitForURL(/\/dm\/[^/?]+/, { timeout: 30_000 });
  this.scratch.set("routing:dmUrl", owner.page.url());

  await dmcReloadAndAcceptFrom(member, owner.did, 1);
  await member.page.getByText("DM deep link message", { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
});

When("the member opens the message permalink directly and reloads the page", { timeout: 300_000 }, async function (this: AppWorld) {
  const member = await this.actor("member");
  const workspaceUrl = this.scratch.get("routing:workspaceUrl") as string;
  const permalinkUrl = this.scratch.get("routing:permalinkUrl") as string;

  await member.page.goto(workspaceUrl);
  await member.page.getByRole("heading", { name: this.workspaceName, exact: true }).waitFor({ state: "visible", timeout: 60_000 });
  await member.page.reload();
  assert.equal(member.page.url(), workspaceUrl);
  await member.page.getByRole("heading", { name: this.workspaceName, exact: true }).waitFor({ state: "visible", timeout: 60_000 });

  await member.page.goto(permalinkUrl);
  await member.page.locator('[data-highlighted="true"]').filter({ hasText: "Permalink target message" }).waitFor({ state: "visible", timeout: 60_000 });
  await member.page.reload();
});

Then("the browser stays on the message permalink route and highlights that message", { timeout: 300_000 }, async function (this: AppWorld) {
  const member = await this.actor("member");
  const permalinkUrl = this.scratch.get("routing:permalinkUrl") as string;
  assert.equal(member.page.url(), permalinkUrl);
  await member.page.locator('[data-highlighted="true"]').filter({ hasText: "Permalink target message" }).waitFor({ state: "visible", timeout: 60_000 });
});

When("the member opens the DM conversation route directly and reloads the page", { timeout: 300_000 }, async function (this: AppWorld) {
  const member = await this.actor("member");
  const dmUrl = this.scratch.get("routing:dmUrl") as string;
  await member.page.goto(dmUrl);
  await member.page.getByText("DM deep link message", { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
  await member.page.reload();
});

Then("the browser stays on the DM conversation route and shows the DM message", { timeout: 300_000 }, async function (this: AppWorld) {
  const member = await this.actor("member");
  const dmUrl = this.scratch.get("routing:dmUrl") as string;
  assert.equal(member.page.url(), dmUrl);
  await member.page.getByText("DM deep link message", { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
});

Given("a workspace member has a shareable message permalink", { timeout: 300_000 }, async function (this: AppWorld) {
  await setUpWorkspaceWithMessage(this);
});

When("that member signs in after opening the message permalink while signed out", { timeout: 300_000 }, async function (this: AppWorld) {
  const member = await this.actor("member");
  const permalinkUrl = this.scratch.get("routing:permalinkUrl") as string;
  await signOutAs(member);
  await member.page.goto(permalinkUrl);
  await signInFromLoginForm(this, member);
});

Then("the browser returns to that exact message permalink and highlights the message", { timeout: 300_000 }, async function (this: AppWorld) {
  const member = await this.actor("member");
  const permalinkUrl = this.scratch.get("routing:permalinkUrl") as string;
  await member.page.waitForURL(permalinkUrl, { timeout: 30_000 });
  await member.page.locator('[data-highlighted="true"]').filter({ hasText: "Permalink target message" }).waitFor({ state: "visible", timeout: 60_000 });
});

async function assertMemberShellPersists(world: AppWorld, member: Actor, label: string): Promise<void> {
  const initialShell = world.scratch.get("routing:initialShell") as ShellLifecycleSnapshot;
  const appFrameHandle = world.scratch.get("routing:appFrameHandle") as JSHandle<Element | null>;
  const currentShell = await member.page.evaluate(
    () => (window as unknown as { __flockShellLifecycle?: ShellLifecycleSnapshot }).__flockShellLifecycle,
  );
  assert.deepEqual(currentShell, initialShell, `${label}: shell mount/session/engine/live tokens must stay unchanged`);
  assert.equal(
    await appFrameHandle.evaluate((el) => el !== null && el === document.querySelector(".app-frame") && el.isConnected),
    true,
    `${label}: .app-frame DOM node must stay the exact same connected element`,
  );
}

Given("a signed-in member viewing a channel in a workspace with Tasks enabled in the live shell", { timeout: 300_000 }, async function (this: AppWorld) {
  const { owner, member, permalinkUrl } = await setUpWorkspaceWithMessage(this);
  await owner.page.locator(".sidebar-action", { hasText: this.workspaceName }).click();
  await owner.page.getByRole("button", { name: "Enable Tasks", exact: true }).click();
  await owner.page.getByRole("button", { name: "Tasks", exact: true }).waitFor({ state: "visible", timeout: 60_000 });

  await refreshUntil(member, () => expect(member.page.getByRole("button", { name: "Tasks", exact: true })).toBeVisible({ timeout: 3_000 }));
  await openChannel(member, "general");
  await syncUntil(member, () => expect(member.page.locator(".message-card").filter({ hasText: "Permalink target message" }).first()).toBeVisible({ timeout: 3_000 }));

  await member.page.waitForFunction(() => {
    const state = (window as unknown as { __flockShellLifecycle?: ShellLifecycleSnapshot }).__flockShellLifecycle;
    return Boolean(state?.gateToken && state?.engineToken && state?.liveToken);
  });
  const initialShell = await member.page.evaluate(
    () => ({ ...(window as unknown as { __flockShellLifecycle: ShellLifecycleSnapshot }).__flockShellLifecycle }),
  );
  assert.equal(initialShell.mountCount, 1);
  assert.equal(initialShell.unmountCount, 0);
  assert.equal(initialShell.sessionBuildCount, 1);
  const appFrameHandle = await member.page.evaluateHandle(() => document.querySelector(".app-frame"));

  this.scratch.set("routing:initialShell", initialShell);
  this.scratch.set("routing:appFrameHandle", appFrameHandle);
  this.scratch.set("routing:channelUrl", member.page.url());
  this.scratch.set("routing:permalinkUrl", permalinkUrl);
});

When("the member navigates across a message permalink, Tasks, Board, and Direct messages and moves Back and Forward in browser history", { timeout: 300_000 }, async function (this: AppWorld) {
  const member = await this.actor("member");
  const channelUrl = this.scratch.get("routing:channelUrl") as string;
  const permalinkUrl = this.scratch.get("routing:permalinkUrl") as string;

  await member.page.locator(".message-card").filter({ hasText: "Permalink target message" }).first().getByRole("button", { name: "Link", exact: true }).click();
  await member.page.waitForURL(permalinkUrl, { timeout: 30_000 });
  await member.page.locator('[data-highlighted="true"]').filter({ hasText: "Permalink target message" }).waitFor({ state: "visible", timeout: 60_000 });
  await assertMemberShellPersists(this, member, "channel -> permalink");

  await member.page.getByRole("button", { name: "Tasks", exact: true }).click();
  await member.page.waitForURL(/\/w\/[^/]+\/[^/]+\/ext\/tasks$/, { timeout: 30_000 });
  await member.page.getByRole("button", { name: "+ New task" }).waitFor({ state: "visible", timeout: 60_000 });
  await assertMemberShellPersists(this, member, "permalink -> Tasks");

  await member.page.getByRole("tab", { name: "Board" }).click();
  await member.page.waitForURL(/\/w\/[^/]+\/[^/]+\/ext\/tasks\/board$/, { timeout: 30_000 });
  await member.page.getByRole("region", { name: "In progress" }).waitFor({ state: "visible", timeout: 60_000 });
  await assertMemberShellPersists(this, member, "Tasks -> Board");

  await member.page.getByRole("button", { name: /New message/ }).click();
  await member.page.waitForURL(`${this.appOrigin}/dm`, { timeout: 30_000 });
  await member.page.getByLabel("Participant DIDs").waitFor({ state: "visible" });
  await assertMemberShellPersists(this, member, "Board -> DMs");

  await member.page.goBack();
  await member.page.waitForURL(/\/w\/[^/]+\/[^/]+\/ext\/tasks\/board$/, { timeout: 30_000 });
  await member.page.getByRole("region", { name: "In progress" }).waitFor({ state: "visible", timeout: 60_000 });
  await assertMemberShellPersists(this, member, "Back -> Board");

  await member.page.goBack();
  await member.page.waitForURL(/\/w\/[^/]+\/[^/]+\/ext\/tasks$/, { timeout: 30_000 });
  await member.page.getByRole("button", { name: "+ New task" }).waitFor({ state: "visible", timeout: 60_000 });
  await assertMemberShellPersists(this, member, "Back -> Tasks");

  await member.page.goBack();
  await member.page.waitForURL(permalinkUrl, { timeout: 30_000 });
  await member.page.locator('[data-highlighted="true"]').filter({ hasText: "Permalink target message" }).waitFor({ state: "visible", timeout: 60_000 });
  await assertMemberShellPersists(this, member, "Back -> Permalink");

  await member.page.goBack();
  await member.page.waitForURL(channelUrl, { timeout: 30_000 });
  await member.page.locator(".message-card").filter({ hasText: "Permalink target message" }).first().waitFor({ state: "visible", timeout: 60_000 });
  await assertMemberShellPersists(this, member, "Back -> Channel");

  await member.page.goForward();
  await member.page.waitForURL(permalinkUrl, { timeout: 30_000 });
  await assertMemberShellPersists(this, member, "Forward -> Permalink");

  await member.page.goForward();
  await member.page.waitForURL(/\/w\/[^/]+\/[^/]+\/ext\/tasks$/, { timeout: 30_000 });
  await assertMemberShellPersists(this, member, "Forward -> Tasks");

  await member.page.goForward();
  await member.page.waitForURL(/\/w\/[^/]+\/[^/]+\/ext\/tasks\/board$/, { timeout: 30_000 });
  await assertMemberShellPersists(this, member, "Forward -> Board");

  await member.page.goForward();
  await member.page.waitForURL(`${this.appOrigin}/dm`, { timeout: 30_000 });
  await member.page.getByLabel("Participant DIDs").waitFor({ state: "visible" });
});

Then("each route renders its content while the shell stays continuously mounted", { timeout: 300_000 }, async function (this: AppWorld) {
  const member = await this.actor("member");
  const appFrameHandle = this.scratch.get("routing:appFrameHandle") as JSHandle<Element | null>;
  try {
    await assertMemberShellPersists(this, member, "final");
    await expect(member.page.getByLabel("Participant DIDs")).toBeVisible();
  } finally {
    await appFrameHandle.dispose();
  }
});
