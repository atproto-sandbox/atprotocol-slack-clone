import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Page } from "@playwright/test";
import { availablePort, startStack, type Stack } from "../support/app-server";
import { startPdsNetwork, type PdsNetwork } from "../support/pds-network";

// M5 browser acceptance (.ai/plans/dm-tasks/m5.md): two accounts on two PDS
// hosts complete a full DM round trip through the real browser OAuth flow (the
// one browser-held session, which signing in creates), then one side revokes
// and the other loses access after reload. Alongside the UI assertions, every
// request either page sends to the app's own origin, its operator, or the Group
// Host is captured so the test can prove message text never reaches them.

const alicePassword = "dm-browser-alice-pass";
const bobPassword = "dm-browser-bob-pass";
const aliceMessage = "Hello Bob, this direct message must never reach the app server.";
const bobReply = "Hi Alice, replying from my own PDS, not through the app.";

let pds: PdsNetwork | undefined;
let stack: Stack | undefined;
let scratchDirectory: string | undefined;
let appUrl: URL | undefined;
let aliceDid = "";
let bobDid = "";

type AppRequestRecord = { actor: string; method: string; url: string; body: string };
const appRequests: AppRequestRecord[] = [];
const macResponses: Array<Promise<{ actor: string; url: string; headers: Record<string, string> }>> = [];

before(async () => {
  const [port, operatorPort] = [await availablePort(), await availablePort()];
  pds = await startPdsNetwork("slack-dm-browser", { appPort: port, operatorPort });

  const alice = await pds.hosts[0].getAgent().com.atproto.server.createAccount({
    handle: "dm-alice.test", email: "dm-alice@dm-browser.test", password: alicePassword,
  });
  aliceDid = alice.data.did;
  const bob = await pds.hosts[1].getAgent().com.atproto.server.createAccount({
    handle: "dm-bob.test2", email: "dm-bob@dm-browser.test", password: bobPassword,
  });
  bobDid = bob.data.did;

  scratchDirectory = mkdtempSync(join(tmpdir(), "slack-dm-oauth-browser-"));
  stack = await startStack({
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? tmpdir(),
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    ATPROTO_ACCEPTANCE_TEST: "true",
    APP_URL: `http://127.0.0.1:${port}`,
    OPERATOR_URL: `http://127.0.0.1:${operatorPort}`,
    GROUP_HOST_URL: pds.groupHostUrl,
    DATABASE_PATH: join(scratchDirectory, "app.db"),
    AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 0x3c).toString("hex"),
    PLC_URL: pds.plcUrl,
    OPERATOR_SERVICE_REF: `did:web:localhost%3A${operatorPort}#atproto_flock_operator`,
  });
  appUrl = stack.appUrl;
}, { timeout: 60_000 });

after(async () => {
  try {
    await stack?.stop();
    await pds?.close();
  } finally {
    if (scratchDirectory) rmSync(scratchDirectory, { recursive: true, force: true });
  }
});

test("real browsers complete a DM round trip across two PDS hosts, then a leave revokes read access", { timeout: 300_000 }, async () => {
  assert.ok(appUrl && pds);
  const browser = await chromium.launch({ headless: true });
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  try {
    const alicePage = await aliceContext.newPage();
    const bobPage = await bobContext.newPage();
    alicePage.setDefaultTimeout(30_000);
    bobPage.setDefaultTimeout(30_000);
    const groupHostOrigin = new URL(pds.groupHostUrl).origin;
    recordAppRequests("alice", alicePage, stack!, groupHostOrigin);
    recordAppRequests("bob", bobPage, stack!, groupHostOrigin);
    recordMacResponses("alice", alicePage);
    recordMacResponses("bob", bobPage);

    await signInForDms(alicePage, appUrl, aliceDid, alicePassword);
    await signInForDms(bobPage, appUrl, bobDid, bobPassword);

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

    // The PDS exposes its RFC 9421 signature and covered commit/record headers to a page on another origin, and says the
    // response varies on `Accept-Signature`: the DM client could not have verified a signature it cannot read, so this is
    // asserted from the responses themselves rather than assumed.
    const macReads = (await Promise.all(macResponses)).filter(
      (read) => Boolean(read.headers["atproto-space-commit"] || read.headers["atproto-space-record"]),
    );
    assert.ok(macReads.length > 0, "the browsers read RFC 9421 MAC-signed responses from the PDS");
    for (const { url, headers } of macReads) {
      const covered = headers["atproto-space-commit"] ? "atproto-space-commit" : "atproto-space-record";
      const exposed = (headers["access-control-expose-headers"] ?? "")
        .split(",")
        .map((token) => token.trim().toLowerCase());
      assert.ok(exposed.includes(covered), `${url} exposes ${covered} to the page (${exposed.join(", ")})`);
      assert.ok(exposed.includes("signature-input"), `${url} exposes signature-input to the page (${exposed.join(", ")})`);
      assert.ok(exposed.includes("signature"), `${url} exposes signature to the page (${exposed.join(", ")})`);
      assert.ok(Boolean(headers["signature-input"]) && Boolean(headers["signature"]), `${url} carries RFC 9421 signature headers`);
      assert.match(headers.vary ?? "", /accept-signature/i, `${url} varies on Accept-Signature`);
    }

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
    await alicePage.getByText("hasn't replied or removed your access", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await alicePage.getByText(bobReply, { exact: true }).count(), 0, "bob's messages disappear once his half is revoked");

    const forbidden = appRequests.filter((entry) => [aliceMessage, bobReply].some((text) => entry.body.includes(text) || decodeURIComponent(entry.url).includes(text)));
    assert.deepEqual(forbidden, [], `no request to the app, operator, or group host may carry DM message text: ${JSON.stringify(forbidden)}`);
    assert.ok(appRequests.length > 0, "sanity check: traffic to the app's origin was actually observed during the flow");
  } finally {
    await bobContext.close();
    await aliceContext.close();
    await browser.close();
  }
});

/** Every credentialed record, commit, repo, or oplog read a page makes, with the response headers as they came off the wire. */
function recordMacResponses(actor: string, page: Page): void {
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (
      !path.endsWith("com.atproto.space.getRecord")
      && !path.endsWith("com.atproto.space.getLatestCommit")
      && !path.endsWith("com.atproto.space.getRepo")
      && !path.endsWith("com.atproto.space.listRepoOps")
    ) return;
    macResponses.push(response.allHeaders().then((headers) => ({ actor, url: response.url(), headers })));
  });
}

/** Every request a page sends to the web app's origin, its operator's, or the Group Host's. */
function recordAppRequests(actor: string, page: Page, app: Stack, groupHostOrigin: string): void {
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== app.appUrl.origin && url.origin !== app.operatorUrl.origin && url.origin !== groupHostOrigin) return;
    const body = request.postData() ?? "";
    appRequests.push({ actor, method: request.method(), url: request.url(), body });
  });
}

async function signInForDms(page: Page, app: URL, did: string, password: string): Promise<void> {
  await page.goto(app.origin);
  await page.getByLabel("Your AT Protocol handle").fill(did);
  await page.getByRole("button", { name: /Continue with atproto/i }).click();
  await page.locator("input[name=password]").waitFor({ state: "visible" });
  await page.locator("input[name=password]").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Authorize", exact: true }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Authorize", exact: true }).click();
  await page.waitForURL(`${app.origin}/oauth/callback**`, { timeout: 30_000 });
  await page.waitForURL(app.origin, { timeout: 30_000 });
  await page.getByRole("button", { name: /New message/ }).waitFor({ state: "visible" });
}
