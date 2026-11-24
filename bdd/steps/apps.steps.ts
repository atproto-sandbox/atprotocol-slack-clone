import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import { publishAppDeclaration } from "@flock/client/app-runtime";
import { actionsBlock, button, sectionBlock } from "@flock/client/blocks";
import { createEngine } from "@flock/client/engine";
import { nodeTransport } from "@flock/client/node/transport";
import { ECHO_BOT_COMMANDS, startEchoBot } from "@flock/echo-bot/echo";
import { tidNow } from "@flock/protocol/keys";
import { SPACE_TYPE } from "@flock/protocol/nsids";
import { expect } from "@playwright/test";
import { channelNamed, composer, messageCard, messageCollection, openChannel, postMessage, syncUntil, writeOwnRecords } from "../support/channels-ui";
import { completeConsent, copyInviteLink, inviteMemberAs, joinFromInvitation, openInviteLinkAndSignIn, ownerInvites, waitForOrigin } from "../support/ui";
import type { Actor, AppWorld } from "../support/world";

// People's view of apps (R9c + R10b): the echo bot runs in this process with its own OAuth session, as `echo-bot run` does,
// while people install it, run `/echo`, click `Again`, and reconnect pre-R10 browser sessions through the real UI.

type Bot = { did: string; transport: ReturnType<typeof nodeTransport> };

async function declareEchoBot(world: AppWorld): Promise<Bot> {
  const account = await world.fixture.createAccount(`echo${Date.now().toString(36)}.test2`, 1);
  const directory = mkdtempSync(join(tmpdir(), "bdd-echo-bot-"));
  world.teardown.push(async () => rmSync(directory, { recursive: true, force: true }));
  const session = await world.fixture.appSession(account, world.operatorServiceRef, join(directory, "echo-bot.json"));
  const transport = nodeTransport(session, { plcUrl: world.fixture.plcUrl, loopback: true });
  await publishAppDeclaration(transport, {
    name: "Echo",
    description: "Answers each message with its text.",
    commands: ECHO_BOT_COMMANDS,
  });
  const bot = { did: account.did, transport } satisfies Bot;
  world.scratch.set("bot", bot);
  return bot;
}

async function installAndStartEchoBot(world: AppWorld, owner: Actor, bot: Bot): Promise<void> {
  const { page } = owner;
  await page.getByLabel("App account").fill(bot.did);
  await page.getByLabel("Access to #general").selectOption("write");
  await page.getByRole("button", { name: "Install app →" }).click();
  // Wait for `runOperation({ kind: "installApp" })` to finish all steps (including `putMembershipRoles`) and `reset()` the form.
  await expect(page.getByLabel("App account")).toHaveValue("", { timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Install app →" })).toBeEnabled({ timeout: 60_000 });
  await page.locator(".app-row").filter({ hasText: "Echo" }).filter({ hasText: "#general (read and write)" }).waitFor({ state: "visible" });

  const engine = createEngine(bot.transport, {
    applyOwnWrites: false,
    operator: { serviceRef: world.operatorServiceRef, endpoint: world.operatorOrigin },
  });
  const stop = new AbortController();
  const failures: unknown[] = [];
  const running = startEchoBot({
    engine: { ...engine, operator: engine.operator! },
    did: bot.did,
    workspaces: [world.workspaceUri],
    signal: stop.signal,
    onError: (error) => failures.push(error),
  });
  world.scratch.set("botFailures", failures);
  world.teardown.push(async () => {
    stop.abort();
    await running.catch(() => undefined);
  });
}

async function runSlashCommand(actor: Actor, commandText: string): Promise<void> {
  await openChannel(actor, "general");
  // Wait until the workspace shell's declaration cache has loaded Echo's `/echo` command for #general.
  await composer(actor).fill("/");
  await actor.page.getByRole("listbox", { name: "Slash commands" }).getByRole("option", { name: /\/echo/ }).waitFor({ state: "visible", timeout: 60_000 });
  await composer(actor).fill(commandText);
  await actor.page.getByRole("button", { name: "Send", exact: true }).click();
  await actor.page.locator(".composer-status").filter({ hasText: "Sent /echo to Echo." }).waitFor({ state: "visible" });
}

Given("a workspace with a member, and an echo bot that declared itself an app", { timeout: 300_000 }, async function (this: AppWorld) {
  const { owner, invitee: member } = await ownerInvites(this, "member");
  await openInviteLinkAndSignIn(this, member, await copyInviteLink(owner));
  await joinFromInvitation(member);
  await declareEchoBot(this);
});

Given("a workspace with two members, and an echo bot that declared itself an app", { timeout: 300_000 }, async function (this: AppWorld) {
  const { owner, invitee: first } = await ownerInvites(this, "member");
  const second = await this.actor("secondMember", 0);
  await inviteMemberAs(owner, second.did);
  const inviteLink = await copyInviteLink(owner);
  for (const person of [first, second]) {
    await openInviteLinkAndSignIn(this, person, inviteLink);
    await joinFromInvitation(person);
  }
  await declareEchoBot(this);
});

When("the admin installs the echo bot with read and write in #general", { timeout: 300_000 }, async function (this: AppWorld) {
  const owner = await this.actor("owner");
  const bot = this.scratch.get("bot") as Bot;
  await installAndStartEchoBot(this, owner, bot);
});

When("the member writes {string} in #general", { timeout: 300_000 }, async function (this: AppWorld, text: string) {
  const member = await this.actor("member");
  await openChannel(member, "general");
  await postMessage(member, text);
});

When("the first member runs {string} in #general", { timeout: 300_000 }, async function (this: AppWorld, commandText: string) {
  const member = await this.actor("member");
  // Refresh workspaces first so the member's shell sees the newly installed echo bot.
  await member.page.getByRole("button", { name: /Refresh/ }).click();
  await runSlashCommand(member, commandText);
});

When("the member runs {string} in #general", { timeout: 300_000 }, async function (this: AppWorld, commandText: string) {
  const member = await this.actor("member");
  await runSlashCommand(member, commandText);
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

Then(
  "the first member sees the echo bot answer {string} with an {string} button, and {string} never appears in #general",
  { timeout: 300_000 },
  async function (this: AppWorld, answerText: string, buttonLabel: string, commandText: string) {
    const first = await this.actor("member");
    const answer = messageCard(first, answerText);
    await answer.waitFor({ state: "visible", timeout: 120_000 }).catch(async (error: unknown) => {
      throw new Error(`The echo bot did not answer: ${(this.scratch.get("botFailures") as unknown[]).map(String).join("; ")}`, { cause: error });
    });
    await answer.locator(".app-marker", { hasText: "APP" }).waitFor({ state: "visible" });
    await answer.getByRole("button", { name: buttonLabel, exact: true }).waitFor({ state: "visible" });
    assert.equal(await messageCard(first, commandText).count(), 0, "the slash command was not written to the channel");
  },
);

Then(
  "the second member sees the echo bot answer {string} in #general, and never {string}",
  { timeout: 300_000 },
  async function (this: AppWorld, answerText: string, commandText: string) {
    const second = await this.actor("secondMember");
    await second.page.getByRole("button", { name: /Refresh/ }).click();
    await openChannel(second, "general");
    await syncUntil(second, async () => {
      await expect(messageCard(second, answerText)).toHaveCount(1, { timeout: 3_000 });
    });
    assert.equal(await messageCard(second, commandText).count(), 0, "the second member never sees the slash command");
  },
);

When("the first member clicks {string} on the echo bot's answer", { timeout: 300_000 }, async function (this: AppWorld, buttonLabel: string) {
  const first = await this.actor("member");
  await messageCard(first, "echo: hello").first().getByRole("button", { name: buttonLabel, exact: true }).click();
});

Then("two echo bot answers {string} appear in #general for both members", { timeout: 300_000 }, async function (this: AppWorld, answerText: string) {
  const first = await this.actor("member");
  const second = await this.actor("secondMember");
  await expect(messageCard(first, answerText)).toHaveCount(2, { timeout: 120_000 });
  await syncUntil(second, async () => {
    await expect(messageCard(second, answerText)).toHaveCount(2, { timeout: 3_000 });
  });
});

When(
  "the first member writes a message in #general carrying spoofed blocks and fallback text {string}",
  { timeout: 300_000 },
  async function (this: AppWorld, fallbackText: string) {
    const owner = await this.actor("owner");
    const first = await this.actor("member");
    const general = await channelNamed(this, owner, "general");
    await writeOwnRecords(this, first, general.uri, [
      {
        collection: messageCollection,
        rkey: tidNow(),
        value: {
          text: fallbackText,
          blocks: [
            sectionBlock("spoofed app section"),
            actionsBlock([button({ actionId: "spoof", label: "Spoof Button", value: "evil" })]),
          ],
          createdAt: new Date().toISOString(),
        },
      },
    ]);
  },
);

Then(
  "the second member sees {string} in #general with no rendered blocks or buttons",
  { timeout: 300_000 },
  async function (this: AppWorld, fallbackText: string) {
    const second = await this.actor("secondMember");
    await syncUntil(second, async () => {
      await expect(messageCard(second, fallbackText)).toHaveCount(1, { timeout: 3_000 });
    });
    const card = messageCard(second, fallbackText);
    assert.equal(await card.locator(".message-blocks").count(), 0, "no block container rendered for a person's message");
    assert.equal(await card.getByRole("button", { name: "Spoof Button" }).count(), 0, "no spoofed button rendered");
    assert.equal(await second.page.getByText("spoofed app section").count(), 0, "spoofed block text is hidden");
  },
);

Given(
  "a workspace with a member whose browser session predates R10, and an echo bot installed in #general",
  { timeout: 300_000 },
  async function (this: AppWorld) {
    const { owner, invitee: member } = await ownerInvites(this, "member");
    await openInviteLinkAndSignIn(this, member, await copyInviteLink(owner));
    await joinFromInvitation(member);
    await member.page.getByRole("heading", { name: this.workspaceName, exact: true }).waitFor({ state: "visible" });

    const bot = await declareEchoBot(this);
    await installAndStartEchoBot(this, owner, bot);

    // Strip the R10 `new.flock.app.inbox` token from the browser's stored OAuth session in IndexedDB, leaving every pre-R10
    // PDS-rewritten token intact, and reload the page so `restoreSession` runs against the pre-R10 session.
    const prefix = `space:${SPACE_TYPE.appInbox}`;
    await member.page.evaluate(async ({ did, stripPrefix }) => {
      // No named functions inside page.evaluate: tsx wraps named functions in __name, which the browser does not have.
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const opening = indexedDB.open("@atproto-oauth-client");
        opening.onsuccess = () => resolve(opening.result);
        opening.onerror = () => reject(opening.error);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(["session"], "readwrite");
          const store = tx.objectStore("session");
          const getReq = store.get(did);
          getReq.onsuccess = () => {
            const entry = getReq.result as { value: { tokenSet: { scope: string } }; expiresAt?: string };
            entry.value.tokenSet.scope = entry.value.tokenSet.scope
              .split(/\s+/)
              .filter((token) => !token.startsWith(stripPrefix))
              .join(" ");
            store.put(entry, did);
          };
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    }, { did: member.did, stripPrefix: prefix });

    await member.page.reload();
    await member.page.locator(".permission-box").getByRole("button", { name: "Connect this browser →" }).waitFor({ state: "visible", timeout: 60_000 });
  },
);

When("the member reconnects their browser through consent", { timeout: 300_000 }, async function (this: AppWorld) {
  const member = await this.actor("member");
  await member.page.locator(".permission-box").getByRole("button", { name: "Connect this browser →" }).click();
  await completeConsent(member, "authorize");
  await waitForOrigin(member, this.appOrigin);
  await member.page.locator(".permission-box").filter({ hasText: /Connect this browser|Connecting this browser/ }).waitFor({ state: "detached", timeout: 60_000 });
});

When("the admin removes the echo bot, warned that its earlier messages leave the view", { timeout: 300_000 }, async function (this: AppWorld) {
  const { page } = await this.actor("owner");
  const row = page.locator(".app-row").filter({ hasText: "Echo" });
  await row.getByRole("button", { name: "Remove", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "also takes its earlier messages out of every channel’s view" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Remove app", exact: true }).click();
  await row.waitFor({ state: "hidden" });
  await expect(page.getByRole("button", { name: "Install app →" })).toBeEnabled({ timeout: 60_000 });
});

Then("the member no longer sees the echo bot's answer", { timeout: 300_000 }, async function (this: AppWorld) {
  const member = await this.actor("member");
  await member.page.reload();
  await openChannel(member, "general");
  await messageCard(member, this.scratch.get("answer") as string).waitFor({ state: "hidden" });
});
