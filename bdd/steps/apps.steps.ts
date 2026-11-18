import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import { publishAppDeclaration } from "@flock/client/app-runtime";
import { createEngine } from "@flock/client/engine";
import { nodeTransport } from "@flock/client/node/transport";
import { startEchoBot } from "@flock/echo-bot/echo";
import { messageCard, openChannel, postMessage } from "../support/channels-ui";
import { copyInviteLink, joinFromInvitation, openInviteLinkAndSignIn, ownerInvites } from "../support/ui";
import type { AppWorld } from "../support/world";

// R9's people's view of apps (`.ai/plans/r9-apps-progress.md`, r9c): the echo bot runs in this process with its own OAuth
// session, as `echo-bot run` does, while the admin installs and removes it through the real UI.

type Bot = { did: string; transport: ReturnType<typeof nodeTransport> };

Given("a workspace with a member, and an echo bot that declared itself an app", { timeout: 300_000 }, async function (this: AppWorld) {
  const { owner, invitee: member } = await ownerInvites(this, "member");
  await openInviteLinkAndSignIn(this, member, await copyInviteLink(owner));
  await joinFromInvitation(member);
  const account = await this.fixture.createAccount(`echo${Date.now().toString(36)}.test2`, 1);
  const directory = mkdtempSync(join(tmpdir(), "bdd-echo-bot-"));
  this.teardown.push(async () => rmSync(directory, { recursive: true, force: true }));
  const session = await this.fixture.appSession(account, this.operatorServiceRef, join(directory, "echo-bot.json"));
  const transport = nodeTransport(session, { plcUrl: this.fixture.plcUrl, loopback: true });
  await publishAppDeclaration(transport, { name: "Echo", description: "Answers each message with its text." });
  this.scratch.set("bot", { did: account.did, transport } satisfies Bot);
});

When("the admin installs the echo bot with read and write in #general", { timeout: 300_000 }, async function (this: AppWorld) {
  const owner = await this.actor("owner");
  const bot = this.scratch.get("bot") as Bot;
  const { page } = owner;
  await page.getByLabel("App account").fill(bot.did);
  await page.getByLabel("Access to #general").selectOption("write");
  await page.getByRole("button", { name: "Install app →" }).click();
  await page.locator(".app-row").filter({ hasText: "Echo" }).filter({ hasText: "#general (read and write)" }).waitFor({ state: "visible" });

  // The bot, told the workspace it was installed in, follows its grant through the operator's change feed.
  const engine = createEngine(bot.transport, { operator: { serviceRef: this.operatorServiceRef, endpoint: this.operatorOrigin } });
  const stop = new AbortController();
  const failures: unknown[] = [];
  const running = startEchoBot({ engine: { ...engine, operator: engine.operator! }, did: bot.did, workspaces: [this.workspaceUri], signal: stop.signal, onError: (error) => failures.push(error) });
  this.scratch.set("botFailures", failures);
  this.teardown.push(async () => {
    stop.abort();
    await running.catch(() => undefined);
  });
});

When("the member writes {string} in #general", { timeout: 300_000 }, async function (this: AppWorld, text: string) {
  const member = await this.actor("member");
  await openChannel(member, "general");
  await postMessage(member, text);
});

Then("the member sees the echo bot answer {string}, marked as an app's", { timeout: 300_000 }, async function (this: AppWorld, text: string) {
  const member = await this.actor("member");
  const answer = messageCard(member, text);
  await answer.waitFor({ state: "visible", timeout: 120_000 }).catch(async (error: unknown) => {
    throw new Error(`The echo bot did not answer: ${(this.scratch.get("botFailures") as unknown[]).map(String).join("; ")}`, { cause: error });
  });
  await answer.locator(".app-marker", { hasText: "APP" }).waitFor({ state: "visible" });
  this.scratch.set("answer", text);
});

When("the admin removes the echo bot, warned that its earlier messages leave the view", { timeout: 300_000 }, async function (this: AppWorld) {
  const { page } = await this.actor("owner");
  const row = page.locator(".app-row").filter({ hasText: "Echo" });
  await row.getByRole("button", { name: "Remove", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "also takes its earlier messages out of every channel’s view" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Remove app", exact: true }).click();
  await row.waitFor({ state: "hidden" });
});

Then("the member no longer sees the echo bot's answer", { timeout: 300_000 }, async function (this: AppWorld) {
  const member = await this.actor("member");
  await member.page.reload();
  await openChannel(member, "general");
  await messageCard(member, this.scratch.get("answer") as string).waitFor({ state: "hidden" });
});
