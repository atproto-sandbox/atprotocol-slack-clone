import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { chromium } from "@playwright/test";
import { createFixtureTempRoot } from "../fixture-temp";

const projectRoot = process.cwd();
const pinnedCheckout = process.env.ATPROTO_PINNED_CHECKOUT;
const password = "browser-acceptance-pass";
const memberPassword = "browser-member-acceptance-pass";

let network: {
  pds: { url: string; getAgent(): { com: { atproto: { server: {
    createAccount(input: Record<string, unknown>): Promise<{ data: { did: string } }>;
    createSession(input: Record<string, unknown>): Promise<{ data: { accessJwt: string } }>;
  } }; repo: { createRecord(input: Record<string, unknown>, options: { headers: { authorization: string } }): Promise<unknown> } } } };
  plc: { url: string };
  close(): Promise<void>;
  lexiconAuthority?: { did: string };
} | undefined;
let fixtureTemp: ReturnType<typeof createFixtureTempRoot> | undefined;
let server: ChildProcess | undefined;
let secondaryServer: ChildProcess | undefined;
let scratchDirectory: string | undefined;
let databasePath: string | undefined;
let encryptionKey = "";
let appUrl: URL | undefined;
let secondaryAppUrl: URL | undefined;
let ownerDid = "";
let memberDid = "";
let serverOutput = "";
let secondaryServerOutput = "";

before(async () => {
  assert.ok(pinnedCheckout, "set ATPROTO_PINNED_CHECKOUT to the pinned atproto checkout");
  const { TestNetworkNoAppView } = await import(pathToFileURL(join(pinnedCheckout, "packages/dev-env/src/index.ts")).href) as {
    TestNetworkNoAppView: { create(options: { extraPdses: number; lexiconAuthority: boolean }): Promise<NonNullable<typeof network>> };
  };
  fixtureTemp = createFixtureTempRoot("slack-browser-fixture-");
  try {
    network = await TestNetworkNoAppView.create({ extraPdses: 0, lexiconAuthority: true });
  } catch (error) {
    fixtureTemp.cleanup();
    fixtureTemp = undefined;
    throw error;
  }
  await publishAppLexicons(network);

  const agent = network.pds.getAgent();
  const owner = await agent.com.atproto.server.createAccount({
    handle: "browser-owner.test",
    email: "browser-owner@acceptance.test",
    password,
  });
  ownerDid = owner.data.did;
  const member = await agent.com.atproto.server.createAccount({
    handle: "browser-member.test",
    email: "browser-member@acceptance.test",
    password: memberPassword,
  });
  memberDid = member.data.did;

  scratchDirectory = mkdtempSync(join(tmpdir(), "slack-oauth-browser-"));
  const port = await freePort();
  appUrl = new URL(`http://127.0.0.1:${port}`);
  encryptionKey = Buffer.alloc(32, 0x5a).toString("hex");
  databasePath = join(scratchDirectory, "app.db");
  const childEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? tmpdir(),
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    ATPROTO_ACCEPTANCE_TEST: "true",
    APP_URL: appUrl.origin,
    DATABASE_PATH: databasePath,
    AUTH_ENCRYPTION_KEY: encryptionKey,
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
    await stopServer(secondaryServer);
    await stopServer(server);
    await network?.close();
  } finally {
    if (scratchDirectory) rmSync(scratchDirectory, { recursive: true, force: true });
    fixtureTemp?.cleanup();
  }
});

test("real browsers complete OAuth, workspace sharing, private-channel requests, and message flows across independent apps", async () => {
  assert.ok(appUrl);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  let independentContext: import("@playwright/test").BrowserContext | undefined;
  page.setDefaultTimeout(30_000);
  page.on("response", async (response) => {
    if (new URL(response.url()).pathname.includes("/~api/consent") && response.status() >= 400) {
      console.log("PDS consent API rejection", response.status(), (await response.text()).slice(0, 1_000));
    }
  });
  try {
    await page.goto(appUrl.origin);
    assert.match(await page.getByRole("heading").innerText(), /Good work happens\s+together/i);
    await page.getByLabel("Your AT Protocol handle").fill(ownerDid);
    await page.getByRole("button", { name: /Continue with atproto/i }).click();

    await page.locator("input[name=password]").waitFor({ state: "visible" });
    assert.equal(await page.locator("input[name=username]").inputValue(), "browser-owner.test");
    const rememberAccount = page.getByLabel("Remember this account on this device");
    if (await rememberAccount.isVisible().catch(() => false)) await rememberAccount.check();
    await page.locator("input[name=password]").fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("button", { name: "Authorize", exact: true }).waitFor({ state: "visible" });
    assert.match(await page.locator("body").innerText(), /Access permissioned spaces/);
    await page.getByRole("button", { name: "Authorize", exact: true }).click();

    await page.waitForURL(appUrl.origin, { timeout: 30_000 });
    await page.getByText("No workspaces yet").waitFor({ state: "visible" });
    assert.match(await page.locator("body").innerText(), /Create a shared workspace or accept an invitation\./);

    const cookies = await context.cookies(appUrl.origin);
    const webSession = cookies.find(({ name }) => name === "spaces_session");
    assert.ok(webSession, "OAuth callback sets the app web-session cookie");
    assert.equal(webSession.httpOnly, true);
    assert.equal(cookies.some(({ name }) => name.startsWith("spaces_oauth_")), false, "OAuth state-binding cookie is cleared after callback");

    // First-time creation: one click. The server answers that permission is required, the app
    // sends the user to the PDS consent screen on its own, and creation resumes after approval.
    assert.equal(await page.getByRole("button", { name: /Authorize workspace setup/ }).count(), 0, "there is no separate manual authorization step");
    await page.getByLabel("Workspace name").fill("Browser Acceptance Workspace");
    const firstAttempt = page.waitForResponse((response) => response.url().includes("/api/workspaces/bootstrap"));
    const workspaceForm = page.locator("form").filter({ has: page.getByLabel("Workspace name") });
    await workspaceForm.getByRole("button", { name: "Create workspace", exact: true }).click();
    const firstResponse = await firstAttempt;
    assert.equal(firstResponse.status(), 403, "creating before approving the permission is refused");
    const refusal = await firstResponse.json() as { error: string; code: string; action: string };
    assert.equal(refusal.code, "authorization_required", "the refusal is typed, not a raw scope string");
    assert.equal(refusal.action, "workspaceAuthority");
    assert.match(refusal.error, /needs your permission/);
    await page.waitForURL(/\/oauth\/authorize\?/, { timeout: 30_000 });

    // Decline on the consent screen. Returning without the permission must explain itself (no redirect
    // loop), keep the typed name, and leave the user able to try again.
    await signInIfPrompted(page);
    await page.getByRole("button", { name: "Deny access", exact: true }).click();
    await page.getByText(/Permission was not granted/).waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await page.getByLabel("Workspace name").inputValue(), "Browser Acceptance Workspace", "the typed name is kept");

    // Trying again asks for permission again instead of stranding the user.
    const permissionRetry = page.waitForResponse((response) => response.url().includes("/api/oauth/permission"));
    await workspaceForm.getByRole("button", { name: "Create workspace", exact: true }).click();
    assert.equal((await permissionRetry).status(), 200, "a retry after declining can start a new permission request");
    await page.waitForURL(/\/oauth\/authorize\?/, { timeout: 30_000 });
    await signInIfPrompted(page);
    await page.getByRole("button", { name: "Authorize", exact: true }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Authorize", exact: true }).click();
    await page.waitForURL(appUrl.origin, { timeout: 30_000 });
    await page.getByRole("heading", { name: "Browser Acceptance Workspace", exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    await page.getByText("Grant operator controls to sync private-channel requests.", { exact: false }).waitFor({ state: "visible", timeout: 30_000 }).catch(async (error: unknown) => {
      const state = await page.evaluate(async () => await fetch("/api/workspaces").then((response) => response.json()));
      throw new Error(`Expected the inbox permission prompt after bootstrap. API: ${JSON.stringify(state)}\nPage: ${(await page.locator("body").innerText()).slice(0, 4_000)}\nServer: ${serverOutput}`, { cause: error });
    });

    const adminScopeResponse = page.waitForResponse((response) => response.url().includes("/api/oauth/permission"));
    const operatorPermissionsCard = page.getByRole("heading", { name: "Operator permissions" }).locator("xpath=ancestor::article");
    await operatorPermissionsCard.getByRole("button", { name: /Grant admin controls/ }).click();
    await page.waitForURL(/\/oauth\/authorize\?/, { timeout: 30_000 });
    const authorizationRequest = new URL(page.url());
    const clientId = authorizationRequest.searchParams.get("client_id");
    assert.ok(clientId);
    const requestedScope = new URL(clientId).searchParams.get("scope") ?? "";
    for (const method of ["execute", "getOperation", "listInboxWriters"]) {
      assert.ok(requestedScope.includes(`lxm=org.slack.operator.${method}`), `client metadata includes operator method ${method}`);
    }
    await signInIfPrompted(page);
    await page.getByRole("button", { name: "Authorize", exact: true }).waitFor({ state: "visible" });
    const consentScope = await page.evaluate(() => String((window as unknown as { __authorizeData?: { scope?: string } }).__authorizeData?.scope ?? ""));
    for (const method of ["execute", "getOperation", "listInboxWriters"]) {
      assert.ok(consentScope.includes(`lxm=org.slack.operator.${method}`), `PDS consent includes operator method ${method}`);
    }
    await page.getByRole("button", { name: "Authorize", exact: true }).click();
    await page.waitForURL(appUrl.origin, { timeout: 30_000 });
    assert.equal((await adminScopeResponse).status(), 200, "the admin client receives the exact operator RPC scopes");
    await page.getByRole("heading", { name: "Browser Acceptance Workspace", exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    await page.getByText("No pending join requests.").waitFor({ state: "visible", timeout: 30_000 });

    await page.getByLabel("Channel name").fill("Browser Room");
    const channelForm = page.locator("form").filter({ has: page.getByLabel("Channel name") });
    await channelForm.getByRole("button", { name: /Create channel/ }).click();
    const channelButton = page.getByRole("button", { name: /Browser Room/ });
    await channelButton.waitFor({ state: "visible", timeout: 30_000 });
    await channelButton.click();

    await page.getByPlaceholder("Write a message…").fill("A real browser wrote this public channel message.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByRole("button", { name: "Grant message posting →" }).waitFor({ state: "visible", timeout: 30_000 });

    const channelScopeResponse = page.waitForResponse((response) => response.url().includes("/api/oauth/permission"));
    await page.getByRole("button", { name: "Grant message posting →" }).click();
    await page.waitForURL(/\/oauth\/authorize\?/, { timeout: 30_000 });
    await signInIfPrompted(page);
    await page.getByRole("button", { name: "Authorize", exact: true }).waitFor({ state: "visible" }).catch(async (error: unknown) => {
      throw new Error(`PDS did not show consent for channel posting. Page: ${(await page.locator("body").innerText()).slice(0, 2_000)}\nServer: ${serverOutput}`, { cause: error });
    });
    const channelConsentScope = await page.evaluate(() => String((window as unknown as { __authorizeData?: { scope?: string } }).__authorizeData?.scope ?? ""));
    assert.ok(channelConsentScope.includes("org.slack.channel.message") && channelConsentScope.includes("action=create"), "PDS consent includes channel message write scope");
    await page.getByRole("button", { name: "Authorize", exact: true }).click();
    await page.waitForURL(appUrl.origin, { timeout: 30_000 }).catch(async (error: unknown) => {
      throw new Error(`Channel consent did not return to the app. URL: ${page.url()} Page: ${(await page.locator("body").innerText()).slice(0, 2_000)}\nServer: ${serverOutput}`, { cause: error });
    });
    assert.equal((await channelScopeResponse).status(), 200, "the account receives the selected channel message-write scope");
    await page.getByPlaceholder("Write a message…").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByPlaceholder("Write a message…").fill("A real browser wrote this public channel message.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByText("A real browser wrote this public channel message.", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });

    await page.getByRole("button", { name: /Browser Acceptance Workspace/ }).click();
    await page.getByLabel("Channel name").fill("Private Room");
    await page.getByLabel("Channel visibility").selectOption("private");
    const privateChannelForm = page.locator("form").filter({ has: page.getByLabel("Channel name") });
    await privateChannelForm.getByRole("button", { name: /Create channel/ }).click();
    await page.getByRole("button", { name: /Private Room/ }).waitFor({ state: "visible", timeout: 30_000 });

    await page.getByLabel("Member DID", { exact: true }).fill(memberDid);
    await page.getByRole("button", { name: /Invite member/ }).click();
    await page.getByText(memberDid, { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    const workspaceState = await page.evaluate(async () => await fetch("/api/workspaces").then((response) => response.json())) as {
      workspaces: Array<{ uri: string; name: string; members: Array<{ did: string }>; channels: Array<{ skey: string; name: string; visibility: string }>; degradedReasons: string[] }>;
    };
    const workspace = workspaceState.workspaces.find(({ name }) => name === "Browser Acceptance Workspace");
    assert.ok(workspace);
    assert.deepEqual(workspace.degradedReasons, [], "workspaces inside the supported envelope are not marked degraded");
    assert.ok(workspace.members.some(({ did }) => did === memberDid), "owner UI invite adds the second DID to the shared roster");

    const independentPort = await freePort();
    secondaryAppUrl = new URL(`http://127.0.0.1:${independentPort}`);
    secondaryServer = spawn(process.execPath, [
      join(projectRoot, "node_modules/next/dist/bin/next"),
      "start", "--hostname", "127.0.0.1", "--port", String(independentPort),
    ], {
      cwd: projectRoot,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? tmpdir(),
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        NODE_ENV: "production",
        NEXT_TELEMETRY_DISABLED: "1",
        ATPROTO_ACCEPTANCE_TEST: "true",
        APP_URL: secondaryAppUrl.origin,
        DATABASE_PATH: join(scratchDirectory!, "independent-app.db"),
        AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 0x6b).toString("hex"),
        PLC_URL: network!.plc.url,
        OPERATOR_SERVICE_REF: `did:web:localhost%3A${independentPort}#atproto_slack_admin`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    secondaryServer.stdout?.on("data", (chunk: Buffer) => { secondaryServerOutput = `${secondaryServerOutput}${chunk}`.slice(-20_000); });
    secondaryServer.stderr?.on("data", (chunk: Buffer) => { secondaryServerOutput = `${secondaryServerOutput}${chunk}`.slice(-20_000); });
    await waitForApp(secondaryAppUrl, secondaryServer, () => secondaryServerOutput);

    independentContext = await browser.newContext();
    const memberPage = await independentContext.newPage();
    memberPage.setDefaultTimeout(30_000);
    const memberRequestEvents: string[] = [];
    memberPage.on("request", (request) => {
      if (request.url().includes("/api/channels/requests")) memberRequestEvents.push(`${request.method()} ${request.url()}`);
    });
    memberPage.on("requestfinished", (request) => {
      if (request.url().includes("/api/channels/requests")) memberRequestEvents.push(`finished ${request.method()} ${request.url()}`);
    });
    memberPage.on("requestfailed", (request) => {
      if (request.url().includes("/api/channels/requests")) memberRequestEvents.push(`failed ${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "unknown"}`);
    });
    await memberPage.goto(secondaryAppUrl.origin);
    await memberPage.getByLabel("Your AT Protocol handle").fill(memberDid);
    await memberPage.getByRole("button", { name: /Continue with atproto/i }).click();
    await memberPage.locator("input[name=password]").waitFor({ state: "visible" });
    await signInIfPrompted(memberPage, "browser-member.test", memberPassword);
    await memberPage.getByRole("button", { name: "Authorize", exact: true }).waitFor({ state: "visible" });
    await memberPage.getByRole("button", { name: "Authorize", exact: true }).click();
    await memberPage.waitForURL(secondaryAppUrl.origin, { timeout: 30_000 });
    await memberPage.getByText("No workspaces yet").waitFor({ state: "visible" });

    await memberPage.getByLabel("Workspace URI").fill(workspace.uri);
    const acceptForm = memberPage.locator("form").filter({ has: memberPage.getByLabel("Workspace URI") });
    await acceptForm.getByRole("button", { name: "Connect invitation", exact: true }).click();
    await completePdsConsentFlow(memberPage, secondaryAppUrl, "browser-member.test", memberPassword);
    await memberPage.getByRole("heading", { name: "Browser Acceptance Workspace", exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    await memberPage.getByText(/2 active members · 3 channels/).waitFor({ state: "visible", timeout: 30_000 });

    await memberPage.getByRole("button", { name: /Browser Room/ }).click();
    await memberPage.getByText(/Grant workspace\/channel read scope/).waitFor({ state: "visible", timeout: 30_000 });
    await memberPage.getByRole("button", { name: "Grant channel read →" }).click();
    await completePdsConsentFlow(memberPage, secondaryAppUrl, "browser-member.test", memberPassword);
    await memberPage.getByText("A real browser wrote this public channel message.", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });

    await memberPage.getByRole("button", { name: /Private Room/ }).click();
    await memberPage.getByText(/Grant workspace\/channel read scope/).waitFor({ state: "visible", timeout: 30_000 });
    await memberPage.getByRole("button", { name: "Request private access →" }).last().click();
    await memberPage.getByText(/Grant write-only inbox access/).waitFor({ state: "visible", timeout: 30_000 });
    await memberPage.getByRole("button", { name: "Grant request access →" }).click();
    await completePdsConsentFlow(memberPage, secondaryAppUrl, "browser-member.test", memberPassword);
    await memberPage.getByText(/Grant workspace\/channel read scope/).waitFor({ state: "visible", timeout: 30_000 });
    const firstJoinRequestResponse = memberPage.waitForResponse((response) => response.url().includes("/api/channels/requests") && response.status() === 201);
    await memberPage.getByRole("button", { name: "Request private access →" }).last().click();
    const firstJoinRequest = await (await firstJoinRequestResponse).json() as { requestId: string };
    await memberPage.getByText("Your access request is in the workspace inbox.", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });

    await page.getByRole("button", { name: "Sync inbox ↻" }).click();
    const pendingRequest = page.locator(".roster-row").filter({ hasText: `${memberDid} requested #Private Room` });
    await pendingRequest.waitFor({ state: "visible", timeout: 30_000 });
    await pendingRequest.getByRole("button", { name: "Deny", exact: true }).click();
    await page.getByText("Submitting workspace operation…", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    await page.getByText(/Operation completed; \d+ steps recorded/).waitFor({ state: "visible", timeout: 30_000 });
    await pendingRequest.waitFor({ state: "hidden", timeout: 30_000 });

    const replacementJoinRequestResponse = memberPage.waitForResponse((response) => response.url().includes("/api/channels/requests"), { timeout: 10_000 })
      .then((response) => ({ response }), (error: unknown) => ({ error }));
    const updateRequestButton = memberPage.getByRole("button", { name: "Request private access →" }).last();
    await updateRequestButton.click({ timeout: 5_000 }).catch(async (error: unknown) => {
      throw new Error(`Could not click the request resubmission button. Network: ${JSON.stringify(memberRequestEvents)}\nPage: ${(await memberPage.locator("body").innerText()).slice(0, 4_000)}\nButton: ${await updateRequestButton.evaluate((button) => button.outerHTML).catch(() => "not present")}\nServer: ${secondaryServerOutput}`, { cause: error });
    });
    const responseResult = await replacementJoinRequestResponse;
    if ("error" in responseResult) {
      const buttonState = await memberPage.getByRole("button").evaluateAll((buttons) => buttons.map((button) => ({
        text: button.textContent?.trim(), disabled: (button as HTMLButtonElement).disabled,
      })));
      throw new Error(`No request response after resubmission. Network: ${JSON.stringify(memberRequestEvents)}\nPage: ${(await memberPage.locator("body").innerText()).slice(0, 4_000)}\nButtons: ${JSON.stringify(buttonState)}\nServer: ${secondaryServerOutput}`, { cause: responseResult.error });
    }
    const replacementResponse = responseResult.response;
    assert.equal(replacementResponse.status(), 201, `resubmitting after denial failed: ${await replacementResponse.text()}`);
    const replacementJoinRequest = await replacementResponse.json() as { requestId: string };
    assert.notEqual(replacementJoinRequest.requestId, firstJoinRequest.requestId, "resubmitting after denial creates a new request generation");
    await memberPage.getByText("Your access request is in the workspace inbox.", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });

    await page.getByRole("button", { name: "Sync inbox ↻" }).click();
    await pendingRequest.waitFor({ state: "visible", timeout: 30_000 });
    await pendingRequest.getByRole("button", { name: "Approve", exact: true }).click();
    await page.getByText("Submitting workspace operation…", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    await page.getByText(/Operation completed; \d+ steps recorded/).waitFor({ state: "visible", timeout: 30_000 });

    await memberPage.getByRole("button", { name: /Private Room/ }).click();
    await memberPage.getByText(/Grant workspace\/channel read scope/).waitFor({ state: "visible", timeout: 30_000 });
    await memberPage.getByRole("button", { name: "Grant channel read →" }).click();
    await completePdsConsentFlow(memberPage, secondaryAppUrl, "browser-member.test", memberPassword);
    await memberPage.getByPlaceholder("Write a message…").waitFor({ state: "visible", timeout: 30_000 });
    await memberPage.getByPlaceholder("Write a message…").fill("A second app member can write after admin approval.");
    await memberPage.getByRole("button", { name: "Send", exact: true }).click();
    await memberPage.getByRole("button", { name: "Grant message posting →" }).waitFor({ state: "visible", timeout: 30_000 });
    await memberPage.getByRole("button", { name: "Grant message posting →" }).click();
    await completePdsConsentFlow(memberPage, secondaryAppUrl, "browser-member.test", memberPassword);
    await memberPage.getByPlaceholder("Write a message…").waitFor({ state: "visible", timeout: 30_000 });
    await memberPage.getByPlaceholder("Write a message…").fill("A second app member can write after admin approval.");
    await memberPage.getByRole("button", { name: "Send", exact: true }).click();
    await memberPage.getByText("A second app member can write after admin approval.", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });

    await memberPage.setViewportSize({ width: 390, height: 844 });
    const mobileWidth = await memberPage.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
    assert.ok(mobileWidth.content <= mobileWidth.viewport, `mobile UI overflows horizontally: ${JSON.stringify(mobileWidth)}`);
  } finally {
    await independentContext?.close();
    await context.close();
    await browser.close();
  }
});

async function publishAppLexicons(fixture: NonNullable<typeof network>): Promise<void> {
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

async function signInIfPrompted(
  page: import("@playwright/test").Page,
  handle = "browser-owner.test",
  accountPassword = password,
): Promise<void> {
  const passwordInput = page.locator("input[name=password]");
  if (!await passwordInput.isVisible().catch(() => false)) return;
  const rememberAccount = page.getByLabel("Remember this account on this device");
  if (await rememberAccount.isVisible().catch(() => false) && !await rememberAccount.isChecked().catch(() => false)) {
    await rememberAccount.check();
  }
  const usernameInput = page.locator("input[name=username]");
  if (await usernameInput.isVisible().catch(() => false) && !await usernameInput.inputValue()) await usernameInput.fill(handle);
  await passwordInput.fill(accountPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

async function completePdsConsentFlow(
  page: import("@playwright/test").Page,
  app: URL,
  handle: string,
  accountPassword: string,
): Promise<void> {
  await page.waitForURL(/\/oauth\/authorize\?/, { timeout: 30_000 });
  await signInIfPrompted(page, handle, accountPassword);
  await page.getByRole("button", { name: "Authorize", exact: true }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Authorize", exact: true }).click();
  await page.waitForURL(app.origin, { timeout: 30_000 });
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

async function waitForApp(url: URL, child: ChildProcess, readOutput = () => serverOutput): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Next server exited before becoming ready.\n${readOutput()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Continue polling while Next starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Next server did not become ready.\n${readOutput()}`);
}
