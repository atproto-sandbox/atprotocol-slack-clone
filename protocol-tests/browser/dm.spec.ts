import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { chromium, type Page } from "@playwright/test";
import { createFixtureTempRoot } from "../fixture-temp";

// M5 browser acceptance (.ai/plans/dm-tasks/m5.md): two accounts on two PDS
// hosts complete a full DM round trip through the real browser OAuth flow
// (both the app's own session and the separate browser-held DM session),
// then one side revokes and the other loses access after reload. Alongside
// the UI assertions, every /api/* request made by either page is captured so
// the test can prove message text never reaches this app's own server.

const projectRoot = process.cwd();
const pinnedCheckout = process.env.ATPROTO_PINNED_CHECKOUT;
const alicePassword = "dm-browser-alice-pass";
const bobPassword = "dm-browser-bob-pass";
const aliceMessage = "Hello Bob, this direct message must never reach the app server.";
const bobReply = "Hi Alice, replying from my own PDS, not through the app.";

type TestAgent = {
  com: { atproto: { server: {
    createAccount(input: Record<string, unknown>): Promise<{ data: { did: string } }>;
    createSession(input: Record<string, unknown>): Promise<{ data: { accessJwt: string } }>;
  } }; repo: { createRecord(input: Record<string, unknown>, options: { headers: { authorization: string } }): Promise<unknown> } };
};
type TestPds = { url: string; getAgent(): TestAgent };
type TestNetwork = {
  pds: TestPds;
  extraPdses: TestPds[];
  plc: { url: string };
  close(): Promise<void>;
  lexiconAuthority?: { did: string };
};

let network: TestNetwork | undefined;
let fixtureTemp: ReturnType<typeof createFixtureTempRoot> | undefined;
let server: ChildProcess | undefined;
let scratchDirectory: string | undefined;
let appUrl: URL | undefined;
let aliceDid = "";
let bobDid = "";
let serverOutput = "";

type ApiRequestRecord = { actor: string; method: string; url: string; body: string };
const apiRequests: ApiRequestRecord[] = [];

before(async () => {
  assert.ok(pinnedCheckout, "set ATPROTO_PINNED_CHECKOUT to the pinned atproto checkout");
  const { TestNetworkNoAppView } = await import(pathToFileURL(join(pinnedCheckout, "packages/dev-env/src/index.ts")).href) as {
    TestNetworkNoAppView: { create(options: { extraPdses: number; lexiconAuthority: boolean }): Promise<TestNetwork> };
  };
  fixtureTemp = createFixtureTempRoot("slack-dm-browser-fixture-");
  try {
    network = await TestNetworkNoAppView.create({ extraPdses: 1, lexiconAuthority: true });
  } catch (error) {
    fixtureTemp.cleanup();
    fixtureTemp = undefined;
    throw error;
  }
  await publishAppLexicons(network);

  const alice = await network.pds.getAgent().com.atproto.server.createAccount({
    handle: "dm-alice.test", email: "dm-alice@dm-browser.test", password: alicePassword,
  });
  aliceDid = alice.data.did;
  const bob = await network.extraPdses[0]!.getAgent().com.atproto.server.createAccount({
    handle: "dm-bob.test2", email: "dm-bob@dm-browser.test", password: bobPassword,
  });
  bobDid = bob.data.did;

  scratchDirectory = mkdtempSync(join(tmpdir(), "slack-dm-oauth-browser-"));
  const port = await freePort();
  appUrl = new URL(`http://127.0.0.1:${port}`);
  const childEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? tmpdir(),
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    ATPROTO_ACCEPTANCE_TEST: "true",
    APP_URL: appUrl.origin,
    DATABASE_PATH: join(scratchDirectory, "app.db"),
    AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 0x3c).toString("hex"),
    PLC_URL: network.plc.url,
    OPERATOR_SERVICE_REF: `did:web:localhost%3A${port}#atproto_slack_admin`,
  };
  server = spawn(process.execPath, [
    join(projectRoot, "node_modules/next/dist/bin/next"),
    "start", "--hostname", "127.0.0.1", "--port", String(port),
  ], { cwd: projectRoot, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout?.on("data", (chunk: Buffer) => { serverOutput = `${serverOutput}${chunk}`.slice(-20_000); });
  server.stderr?.on("data", (chunk: Buffer) => { serverOutput = `${serverOutput}${chunk}`.slice(-20_000); });
  await waitForApp(appUrl, server);
}, { timeout: 60_000 });

after(async () => {
  try {
    await stopServer(server);
    await network?.close();
  } finally {
    if (scratchDirectory) rmSync(scratchDirectory, { recursive: true, force: true });
    fixtureTemp?.cleanup();
  }
});

test("real browsers complete a DM round trip across two PDS hosts, then a leave revokes read access", async () => {
  assert.ok(appUrl);
  const browser = await chromium.launch({ headless: true });
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  try {
    const alicePage = await aliceContext.newPage();
    const bobPage = await bobContext.newPage();
    alicePage.setDefaultTimeout(30_000);
    bobPage.setDefaultTimeout(30_000);
    recordApiRequests("alice", alicePage);
    recordApiRequests("bob", bobPage);

    await loginAndConnectDms(alicePage, appUrl, aliceDid, "dm-alice.test", alicePassword);
    await loginAndConnectDms(bobPage, appUrl, bobDid, "dm-bob.test2", bobPassword);

    // Bob enables DMs (default "Only people I allow") then switches to
    // "Everyone" so alice's request is tracked without needing a prior allowlist entry.
    await bobPage.getByRole("button", { name: "DM settings", exact: false }).click();
    await bobPage.getByRole("button", { name: "Enable direct messages" }).click();
    await bobPage.getByText(/Current mode: Only people I allow/).waitFor({ state: "visible" });
    await bobPage.getByRole("radio", { name: "Everyone" }).click();
    await bobPage.getByText(/Current mode: Everyone/).waitFor({ state: "visible" });

    // Alice starts a conversation with bob's DID.
    await alicePage.getByRole("button", { name: "New message", exact: false }).click();
    await alicePage.getByLabel("Participant DIDs").fill(bobDid);
    await alicePage.getByRole("button", { name: "Start conversation" }).click();
    await alicePage.getByText("Delivery results", { exact: false }).waitFor({ state: "visible" });
    await alicePage.getByText("delivered", { exact: true }).first().waitFor({ state: "visible" });
    await alicePage.getByRole("button", { name: "Open conversation →" }).click();
    await alicePage.getByPlaceholder("Write a message…").fill(aliceMessage);
    await alicePage.getByRole("button", { name: "Send", exact: true }).click();
    await alicePage.getByText(aliceMessage, { exact: true }).waitFor({ state: "visible" });

    // Bob reloads (the app reads on open, so this does not depend on the
    // 60-second poll or notify registrations having already been made) and accepts the request.
    await bobPage.reload();
    await bobPage.getByRole("button", { name: /Requests \(1\)/ }).waitFor({ state: "visible" });
    await bobPage.getByRole("button", { name: /Requests \(1\)/ }).click();
    await bobPage.getByText(aliceDid, { exact: true }).waitFor({ state: "visible" });
    await bobPage.getByRole("button", { name: "Accept", exact: true }).click();
    await bobPage.getByText(aliceMessage, { exact: true }).waitFor({ state: "visible" });
    await bobPage.getByPlaceholder("Write a message…").fill(bobReply);
    await bobPage.getByRole("button", { name: "Send", exact: true }).click();
    await bobPage.getByText(bobReply, { exact: true }).waitFor({ state: "visible" });

    // Alice's conversation view syncs (in-page action, not a reload) to pick up bob's half and message.
    await alicePage.getByRole("button", { name: /Sync/ }).click();
    await alicePage.getByText(bobReply, { exact: true }).waitFor({ state: "visible" });

    // Alice reacts; bob sees it after syncing.
    await alicePage.getByText(bobReply, { exact: true }).locator("xpath=ancestor::article").getByText("💜 0", { exact: true }).click();
    await bobPage.getByRole("button", { name: /Sync/ }).click();
    await bobPage.getByText(bobReply, { exact: true }).locator("xpath=ancestor::article").getByText("💜 1", { exact: true }).waitFor({ state: "visible" });

    // Bob leaves the conversation.
    await bobPage.getByRole("button", { name: "Leave conversation" }).click();
    await bobPage.getByRole("button", { name: "Confirm leave" }).click();
    await bobPage.getByRole("button", { name: "Leave conversation" }).waitFor({ state: "hidden" }).catch(() => undefined);

    // After reload, alice's own half still exists but bob revoked her read
    // access to his; she sees the revoked chip and no longer sees his message.
    await alicePage.reload();
    await alicePage.getByRole("button", { name: /New message/ }).waitFor({ state: "visible" });
    // The sidebar resolves bob's handle for display once his DID document loads,
    // so the conversation entry is labeled "dm-bob.test2" rather than his DID.
    const aliceConversationEntry = alicePage.locator(".channel-nav-item", { hasText: "dm-bob.test2" });
    await aliceConversationEntry.click();
    await alicePage.getByText("revoked your access", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await alicePage.getByText(bobReply, { exact: true }).count(), 0, "bob's messages disappear once his half is revoked");

    const forbiddenBodies = apiRequests.filter((entry) => entry.body.includes(aliceMessage) || entry.body.includes(bobReply));
    assert.deepEqual(forbiddenBodies, [], `no /api/* request body may contain DM message text: ${JSON.stringify(forbiddenBodies)}`);
    assert.ok(apiRequests.length > 0, "sanity check: /api/* traffic was actually observed during the flow");
  } finally {
    await bobContext.close();
    await aliceContext.close();
    await browser.close();
  }
});

function recordApiRequests(actor: string, page: Page): void {
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/")) return;
    const body = request.postData() ?? "";
    apiRequests.push({ actor, method: request.method(), url: request.url(), body });
  });
}

async function loginAndConnectDms(page: Page, app: URL, did: string, handle: string, password: string): Promise<void> {
  await page.goto(app.origin);
  await page.getByLabel("Your AT Protocol handle").fill(did);
  await page.getByRole("button", { name: /Continue with atproto/i }).click();
  await page.locator("input[name=password]").waitFor({ state: "visible" });
  await page.locator("input[name=password]").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Authorize", exact: true }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Authorize", exact: true }).click();
  await page.waitForURL(app.origin, { timeout: 30_000 });

  await page.getByRole("button", { name: /Connect direct messages/ }).click();
  await page.waitForURL(/\/oauth\/authorize\?/, { timeout: 30_000 }).catch(async (error: unknown) => {
    throw new Error(`DM connect did not redirect to PDS authorize. URL: ${page.url()} Page: ${(await page.locator("body").innerText()).slice(0, 2_000)}`, { cause: error });
  });
  await signInIfPrompted(page, handle, password);
  await page.getByRole("button", { name: "Authorize", exact: true }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Authorize", exact: true }).click();
  await page.waitForURL(`${app.origin}/dm/callback**`, { timeout: 30_000 });
  await page.waitForURL(app.origin, { timeout: 30_000 });
  await page.getByRole("button", { name: /New message/ }).waitFor({ state: "visible" });
}

async function signInIfPrompted(page: Page, handle: string, password: string): Promise<void> {
  const passwordInput = page.locator("input[name=password]");
  if (!await passwordInput.isVisible().catch(() => false)) return;
  const usernameInput = page.locator("input[name=username]");
  if (await usernameInput.isVisible().catch(() => false) && !await usernameInput.inputValue()) await usernameInput.fill(handle);
  await passwordInput.fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

async function publishAppLexicons(fixture: TestNetwork): Promise<void> {
  assert.ok(fixture.lexiconAuthority, "fixture must expose its lexicon authority");
  const agent = fixture.pds.getAgent();
  const session = await agent.com.atproto.server.createSession({ identifier: "lex-authority.test", password: "hunter2" });
  const root = join(projectRoot, "lexicons/org/slack");
  const files = await readdir(root, { recursive: true });
  const published = new Set<string>();
  for (const relative of files.filter((file) => file.endsWith(".json"))) {
    const lexicon = JSON.parse(await readFile(join(root, relative), "utf8")) as { id: string };
    if (published.has(lexicon.id)) continue;
    published.add(lexicon.id);
    await agent.com.atproto.repo.createRecord({
      repo: fixture.lexiconAuthority.did,
      collection: "com.atproto.lexicon.schema",
      rkey: lexicon.id,
      record: lexicon,
    }, { headers: { authorization: `Bearer ${session.data.accessJwt}` } });
  }
}

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function stopServer(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.killed) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => resolve(), 5_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

async function waitForApp(url: URL, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Next server exited before becoming ready.\n${serverOutput}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Continue polling while Next starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Next server did not become ready.\n${serverOutput}`);
}
