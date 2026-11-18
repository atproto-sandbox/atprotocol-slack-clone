import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import Database from "better-sqlite3";
import { chromium, type Response as PageResponse } from "@playwright/test";
import { createFixtureTempRoot } from "../fixture-temp";
import { startStack, type Stack } from "../support/app-server";
import { actorTransport } from "../support/pds-network";
import { createEngine } from "@flock/client/engine";
import type { OperatorClient } from "@flock/client/operator-client";
import { tidNow } from "@flock/protocol/keys";

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
let stack: Stack | undefined;
let secondaryStack: Stack | undefined;
let scratchDirectory: string | undefined;
let databasePath: string | undefined;
let appUrl: URL | undefined;
let secondaryAppUrl: URL | undefined;
let ownerDid = "";
let memberDid = "";

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
  databasePath = join(scratchDirectory, "app.db");
  stack = await startStack(await stackEnv({ databasePath, encryptionKey: Buffer.alloc(32, 0x5a).toString("hex") }));
  appUrl = stack.appUrl;
}, { timeout: 60_000 });

after(async () => {
  try {
    await secondaryStack?.stop();
    await stack?.stop();
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
    // Signing in is the browser's own session: one grant on the PDS for reading and writing the account's spaces, the
    // operator's methods and direct messages.
    const browserScope = await page.evaluate(() => String((window as unknown as { __authorizeData?: { scope?: string } }).__authorizeData?.scope ?? ""));
    await page.getByRole("button", { name: "Authorize", exact: true }).click();

    await page.waitForURL(appUrl.origin, { timeout: 30_000 });
    await page.getByText("No workspaces yet").waitFor({ state: "visible" });
    for (const expected of ["space:new.flock.channel?", "new.flock.channel.message", "lxm=new.flock.operator.getChanges", "lxm=new.flock.operator.listInboxWriters", "lxm=new.flock.operator.execute", "lxm=new.flock.operator.createWorkspace", "lxm=new.flock.operator.startAuthorityFlow", "lxm=new.flock.operator.listStalledOperations", "space:new.flock.dm.conversation"]) {
      assert.ok(browserScope.includes(expected), `the browser's grant includes ${expected}`);
    }
    await page.getByText("Create a shared workspace or accept an invitation.").waitFor({ state: "visible" });

    assert.deepEqual(await context.cookies(appUrl.origin), [], "signing in sets no cookie on the app: the browser holds the session");

    // First-time creation: one click. The operator answers that the authority's approval is required, the app sends the
    // user to the PDS consent screen on its own, and creation resumes after approval.
    assert.equal(await page.getByRole("button", { name: /Authorize workspace setup/ }).count(), 0, "there is no separate manual authorization step");
    await page.getByLabel("Workspace name").fill("Browser Acceptance Workspace");
    const firstAttempt = page.waitForResponse((response) => new URL(response.url()).pathname === "/xrpc/new.flock.operator.createWorkspace");
    const workspaceForm = page.locator("form").filter({ has: page.getByLabel("Workspace name") });
    await workspaceForm.getByRole("button", { name: "Create workspace", exact: true }).click();
    const firstResponse = await firstAttempt;
    assert.equal(firstResponse.status(), 403, "creating before approving the permission is refused");
    const refusal = await firstResponse.json() as { error: string; message: string };
    assert.equal(refusal.error, "AuthorizationRequired", "the refusal is typed, not a raw scope string");
    assert.match(refusal.message, /needs the workspace account's approval/);
    await page.waitForURL(/\/oauth\/authorize\?/, { timeout: 30_000 });

    // Decline on the consent screen. Returning without the permission must explain itself (no redirect
    // loop), keep the typed name, and leave the user able to try again.
    await signInIfPrompted(page);
    await page.getByRole("button", { name: "Deny access", exact: true }).click();
    await page.getByText(/Permission was not granted/).waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await page.getByLabel("Workspace name").inputValue(), "Browser Acceptance Workspace", "the typed name is kept");

    // Trying again asks for permission again instead of stranding the user.
    const permissionRetry = page.waitForResponse((response) => new URL(response.url()).pathname === "/xrpc/new.flock.operator.startAuthorityFlow");
    await workspaceForm.getByRole("button", { name: "Create workspace", exact: true }).click();
    assert.equal((await permissionRetry).status(), 200, "a retry after declining can start a new permission request");
    await page.waitForURL(/\/oauth\/authorize\?/, { timeout: 30_000 });
    // The authority grant has its own OAuth client and callback, separate from the sign-in.
    const authorityClientId = new URL(new URL(page.url()).searchParams.get("client_id") ?? "");
    assert.equal(authorityClientId.searchParams.get("redirect_uri"), `${stack!.operatorUrl.origin}/authority/callback`, "the workspace authority approves through the authority flow");
    const authorityCallbacks: string[] = [];
    page.on("request", (request) => { if (new URL(request.url()).pathname === "/authority/callback") authorityCallbacks.push(request.url()); });
    await signInIfPrompted(page);
    await page.getByRole("button", { name: "Authorize", exact: true }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Authorize", exact: true }).click();
    await page.waitForURL(appUrl.origin, { timeout: 30_000 });
    await page.getByRole("heading", { name: "Browser Acceptance Workspace", exact: true }).waitFor({ state: "visible", timeout: 30_000 });

    // The authority callback is bound to the browser that started the flow: replayed from another browser, it is refused.
    const approvedCallback = authorityCallbacks.at(-1);
    assert.ok(approvedCallback, "the approval returned through the authority callback");
    const strangerContext = await browser.newContext();
    try {
      const strangerPage = await strangerContext.newPage();
      await strangerPage.goto(approvedCallback);
      assert.match(strangerPage.url(), /[?&]authority=failed/, "a callback without its flow cookie is rejected");
    } finally {
      await strangerContext.close();
    }
    // The browser's own grant carries the operator's methods: the admin inbox loads and operations run with no further consent.
    await page.getByText("No pending join requests.").waitFor({ state: "visible", timeout: 30_000 }).catch(async (error: unknown) => {
      throw new Error(`Expected the synced inbox after bootstrap. Page: ${(await page.locator("body").innerText()).slice(0, 4_000)}\nServer: ${stack?.output()}`, { cause: error });
    });

    await page.getByLabel("Channel name").fill("Browser Room");
    const channelForm = page.locator("form").filter({ has: page.getByLabel("Channel name") });
    await channelForm.getByRole("button", { name: /Create channel/ }).click();
    const channelButton = page.getByRole("button", { name: /Browser Room/ });
    await channelButton.waitFor({ state: "visible", timeout: 30_000 });
    await channelButton.click();

    // The browser writes the message to the account's own repo with the grant it already holds: no further consent.
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
    await page.locator(".roster-row").filter({ hasText: memberDid }).waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await page.locator(".envelope-alert").count(), 0, "workspaces inside the supported envelope are not marked degraded");
    const workspaceUri = (await page.locator(".welcome-banner .mono-note").innerText()).trim();
    assert.match(workspaceUri, /^at:\/\/did:plc:[a-z0-9]+\/space\/new\.flock\.workspace\//, "the workspace home shows the workspace URI");

    secondaryStack = await startStack(await stackEnv({ databasePath: join(scratchDirectory!, "independent-app.db"), encryptionKey: Buffer.alloc(32, 0x6b).toString("hex") }));
    secondaryAppUrl = secondaryStack.appUrl;

    independentContext = await browser.newContext();
    const memberPage = await independentContext.newPage();
    memberPage.setDefaultTimeout(30_000);
    // A join request is a record the browser writes to the member's own repo in the workspace inbox.
    const joinRequestWritten = () => memberPage.waitForResponse((response) => new URL(response.url()).pathname === "/xrpc/com.atproto.space.putRecord"
      && (JSON.parse(response.request().postData() ?? "{}") as { collection?: string }).collection === "new.flock.joinRequest", { timeout: 30_000 });
    const requestIdOf = (response: PageResponse) => (JSON.parse(response.request().postData() ?? "{}") as { record: { requestId: string } }).record.requestId;
    await memberPage.goto(secondaryAppUrl.origin);
    await memberPage.getByLabel("Your AT Protocol handle").fill(memberDid);
    await memberPage.getByRole("button", { name: /Continue with atproto/i }).click();
    await memberPage.locator("input[name=password]").waitFor({ state: "visible" });
    await signInIfPrompted(memberPage, "browser-member.test", memberPassword);
    await memberPage.getByRole("button", { name: "Authorize", exact: true }).waitFor({ state: "visible" });
    await memberPage.getByRole("button", { name: "Authorize", exact: true }).click();
    await memberPage.waitForURL(secondaryAppUrl.origin, { timeout: 30_000 });
    await memberPage.getByText("No workspaces yet").waitFor({ state: "visible" });

    await memberPage.getByLabel("Workspace URI").fill(workspaceUri);
    const acceptForm = memberPage.locator("form").filter({ has: memberPage.getByLabel("Workspace URI") });
    await acceptForm.getByRole("button", { name: "Connect invitation", exact: true }).click();
    await memberPage.getByRole("heading", { name: "Browser Acceptance Workspace", exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    await memberPage.getByText(/2 active members · 3 channels/).waitFor({ state: "visible", timeout: 30_000 });

    await memberPage.getByRole("button", { name: /Browser Room/ }).click();
    await memberPage.getByText("A real browser wrote this public channel message.", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });

    const offRoster = memberPage.getByText("You are not on this channel’s active roster.");
    await memberPage.getByRole("button", { name: /Private Room/ }).click();
    await offRoster.waitFor({ state: "visible", timeout: 30_000 });
    const firstJoinRequestResponse = joinRequestWritten();
    await memberPage.getByRole("button", { name: "Request private access →" }).click();
    const firstWrite = await firstJoinRequestResponse;
    assert.equal(firstWrite.status(), 200, `the member's host stores the request: ${await firstWrite.text()}`);
    const firstJoinRequest = { requestId: requestIdOf(firstWrite) };
    await memberPage.getByText("Your access request is in the workspace inbox.", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });

    await page.getByRole("button", { name: "Sync inbox ↻" }).click();
    const pendingRequest = page.locator(".roster-row").filter({ hasText: `${memberDid} requested #Private Room` });
    await pendingRequest.waitFor({ state: "visible", timeout: 30_000 });
    await pendingRequest.getByRole("button", { name: "Deny", exact: true }).click();
    await page.getByText("Submitting workspace operation…", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    await page.getByText(/Operation completed; \d+ steps recorded/).waitFor({ state: "visible", timeout: 30_000 });
    await pendingRequest.waitFor({ state: "hidden", timeout: 30_000 });

    const replacementJoinRequestResponse = joinRequestWritten();
    // A request already sent is offered as an update; after the denial it sends a new generation.
    await memberPage.getByRole("button", { name: "Update request →" }).click();
    const replacementResponse = await replacementJoinRequestResponse;
    assert.equal(replacementResponse.status(), 200, `resubmitting after denial failed: ${await replacementResponse.text()}`);
    const replacementJoinRequest = { requestId: requestIdOf(replacementResponse) };
    assert.notEqual(replacementJoinRequest.requestId, firstJoinRequest.requestId, "resubmitting after denial creates a new request generation");
    await memberPage.getByText("Your access request is in the workspace inbox.", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });

    await page.getByRole("button", { name: "Sync inbox ↻" }).click();
    await pendingRequest.waitFor({ state: "visible", timeout: 30_000 });
    await pendingRequest.getByRole("button", { name: "Approve", exact: true }).click();
    await page.getByText("Submitting workspace operation…", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    await page.getByText(/Operation completed; \d+ steps recorded/).waitFor({ state: "visible", timeout: 30_000 });

    await memberPage.getByRole("button", { name: /Private Room/ }).click();
    await memberPage.locator(".private-roster").filter({ hasText: memberDid }).waitFor({ state: "visible", timeout: 30_000 });
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
  const root = join(projectRoot, "packages/protocol/lexicons/new/flock");
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

test("with the operator on the web app's site, the authority flow runs twice at once, and neither a used ticket nor a used callback can be replayed", async () => {
  assert.ok(stack && databasePath);
  await authorityFlowTwiceAtOnce(stack, databasePath);
});

test("with the operator on another site, the authority flow runs the same way", async () => {
  assert.ok(scratchDirectory);
  // [::1] is another site than 127.0.0.1: the flow's cookie lives on the operator's origin and travels on top-level navigations only.
  const crossSiteDatabase = join(scratchDirectory, "cross-site.db");
  const crossSite = await startStack(await stackEnv({ databasePath: crossSiteDatabase, encryptionKey: Buffer.alloc(32, 0x7c).toString("hex"), operatorHost: "[::1]" }));
  try {
    await authorityFlowTwiceAtOnce(crossSite, crossSiteDatabase);
  } finally {
    await crossSite.stop();
  }
});

/**
 * The owner signs in to `app`, then two authority flows are started and approved at once in two tabs of one browser; a
 * started ticket is used again; a third flow's callback arrives without its flow cookie, then with it, then is replayed; and
 * the grant left creates a workspace. The flows run between the web app's origin, the operator's and the PDS.
 */
async function authorityFlowTwiceAtOnce(app: Stack, appDatabase: string): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const grantRow = () => {
    const db = new Database(appDatabase, { readonly: true, fileMustExist: true });
    try { return db.prepare("SELECT key, value FROM authority_grant WHERE key = ?").all(ownerDid) as Array<{ key: string; value: string }>; }
    finally { db.close(); }
  };
  try {
    // given the owner signed in to the app in one browser, and the operator called as the owner's browser calls it
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    await page.goto(app.appUrl.origin);
    await page.getByLabel("Your AT Protocol handle").fill(ownerDid);
    await page.getByRole("button", { name: /Continue with atproto/i }).click();
    await completePdsConsentFlow(page, app.appUrl, "browser-owner.test", password);
    const operator = await ownerOperator(app);
    const startUrl = async () => new URL((await operator.startAuthorityFlow({ purpose: "reauthorize" })).url, app.operatorUrl).href;
    const approve = async (tab: import("@playwright/test").Page) => {
      await tab.waitForURL(/\/oauth\/authorize\?/);
      await signInIfPrompted(tab);
      await tab.getByRole("button", { name: "Authorize", exact: true }).click();
      await tab.waitForURL((url) => url.origin === app.appUrl.origin && !url.pathname.startsWith("/authority"));
      return tab.url();
    };

    // when two authority flows are started and both approved, in two tabs of that browser
    const [first, second] = [await context.newPage(), await context.newPage()];
    const firstTicket = await startUrl();
    await first.goto(firstTicket);
    await second.goto(await startUrl());
    const landed = [await approve(first), await approve(second)];

    // then both complete, and one grant remains
    for (const url of landed) assert.doesNotMatch(url, /authority=failed/, "each flow completes");
    assert.equal(grantRow().length, 1, "two approvals leave one grant");

    // and a ticket already used starts nothing
    const replayed = await context.newPage();
    await replayed.goto(firstTicket);
    assert.match(replayed.url(), /[?&]authority=failed/, "a used ticket is refused");

    // and a third flow approved without its flow cookie is refused, completes once the cookie is back, and then cannot be
    // replayed even with it. The flow cookie is taken while the browser is at the consent page (set by /authority/start,
    // cleared by the callback), and the callback URL from the request event, since a navigation reached through a redirect
    // is not routable.
    const third = await context.newPage();
    const callbacks: string[] = [];
    third.on("request", (request) => { if (new URL(request.url()).pathname === "/authority/callback") callbacks.push(request.url()); });
    await third.goto(await startUrl());
    await third.waitForURL(/\/oauth\/authorize\?/);
    const flowCookies = (await context.cookies(new URL("/authority/callback", app.operatorUrl).href)).filter(({ name }) => name.startsWith("spaces_oauth_"));
    assert.ok(flowCookies.length > 0, "the flow cookie is set for the operator's callback while the flow is open");
    const beforeThird = grantRow();
    await context.clearCookies({ name: /^spaces_oauth_/ });
    assert.match(await approve(third), /[?&]authority=failed/, "a callback without its flow cookie is refused");
    assert.deepEqual(grantRow(), beforeThird, "the refused callback leaves the grant as it was");
    const callbackUrl = callbacks.at(-1);
    assert.ok(callbackUrl, "the callback was observed");
    await context.addCookies(flowCookies);
    await third.goto(callbackUrl);
    assert.doesNotMatch(third.url(), /authority=failed/, "the same callback with its flow cookie completes the third flow");
    const afterApproval = grantRow();
    assert.notDeepEqual(afterApproval, beforeThird, "the third approval replaced the grant");
    await context.addCookies(flowCookies);
    await third.goto(callbackUrl);
    assert.match(third.url(), /[?&]authority=failed/, "a used state is refused even with its cookie");
    assert.deepEqual(grantRow(), afterApproval, "the refused replay leaves the grant as it was");

    // and the grant that remains works: the operator creates a workspace with it (one per run, since a creation makes a new one)
    const created = await operator.createWorkspace({ name: `Grant Survivor ${app.operatorUrl.port}`, operationId: tidNow() });
    assert.equal(created.state, "completed", JSON.stringify(created));
  } finally {
    await browser.close();
  }
}

/** The operator as the owner's browser calls it: each method with a service token the owner's own host issues. */
async function ownerOperator(app: Stack): Promise<OperatorClient> {
  assert.ok(network);
  const { data } = await network.pds.getAgent().com.atproto.server.createSession({ identifier: ownerDid, password });
  const engine = createEngine(actorTransport({ plcUrl: network.plc.url }, { did: ownerDid, accessJwt: data.accessJwt, pds: { url: network.pds.url } }), {
    operator: { serviceRef: `did:web:localhost%3A${app.operatorUrl.port}#atproto_flock_operator`, endpoint: app.operatorUrl.origin },
  });
  assert.ok(engine.operator);
  return engine.operator;
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

/** One app's environment: the web app and its operator on free ports (the operator on `operatorHost`), its own database and key. */
async function stackEnv(input: { databasePath: string; encryptionKey: string; operatorHost?: string }): Promise<NodeJS.ProcessEnv> {
  assert.ok(network);
  const [appPort, operatorPort] = [await freePort(), await freePort()];
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? tmpdir(),
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    ATPROTO_ACCEPTANCE_TEST: "true",
    APP_URL: `http://127.0.0.1:${appPort}`,
    OPERATOR_URL: `http://${input.operatorHost ?? "127.0.0.1"}:${operatorPort}`,
    DATABASE_PATH: input.databasePath,
    AUTH_ENCRYPTION_KEY: input.encryptionKey,
    PLC_URL: network.plc.url,
    OPERATOR_SERVICE_REF: `did:web:localhost%3A${operatorPort}#atproto_flock_operator`,
  };
}
