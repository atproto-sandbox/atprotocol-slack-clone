import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium, type Browser } from "@playwright/test";
import { availablePort, startAppServer, startOperatorServer, type AppServer } from "../support/app-server";
import { consent, openChannel, signIn } from "../support/browser-app";
import { actorTransport, mintAppSession, startPdsNetwork, storeAuthorityGrant } from "../support/pds-network";

// R10c's gate (`.ai/plans/r10-interactions-progress.md`, "### R10c"): in a real Chromium browser under the webhooks admin
// page's own CSP (`default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'`),
// `Referrer-Policy: same-origin` and `SameSite=Lax` cookies, a workspace admin signs in via the identity-only OAuth client,
// creates a hook for #general and sees its URL once; a non-admin member is refused the page; a POST to the URL appears in
// #general as the app's message; a wrong secret and a revoked hook get the exact same answer; and after the admin changes
// the app to read-only in #general the hook is refused and nothing is written.

const WORKSPACE_NAME = "Webhooks Gate";

test("an admin manages webhooks in a real browser, non-admins are refused, valid hooks post as the app, and read-only grants refuse writes (R10c)", { timeout: 600_000 }, async () => {
  const appPort = await availablePort();
  const operatorPort = await availablePort();
  const webhooksPort = await availablePort();
  const webhooksOrigin = `http://127.0.0.1:${webhooksPort}`;
  const pds = await startPdsNetwork("webhooks-browser", { appPort, operatorPort });
  const directory = mkdtempSync(join(tmpdir(), "webhooks-browser-test-"));
  let operator: AppServer | undefined;
  let webApp: AppServer | undefined;
  let webhooksServer: Server | undefined;
  let browser: Browser | undefined;
  try {
    operator = await startOperatorServer();
    webApp = await startAppServer(appPort);

    const [
      { restoreAuthorityGrant },
      { createWorkspace },
      { registrationDeps },
      { requireActiveWorkspaceAdmin },
      { executeOperatorOperation },
      { tidNow },
      { COLLECTION },
      { listBoundedRecords },
      { publishAppDeclaration },
      { contextBlock, sectionBlock },
      { createEngine },
      { createAdminIdentityOAuth },
      { nodeTransport },
      { HooksStore },
      { ADMIN_CSP, listenWebhooksServer },
    ] = await Promise.all([
      import("@flock/operator/operator/authority-grant"),
      import("@flock/operator/operator/kinds/create-workspace"),
      import("@flock/operator/operator/registrations"),
      import("@flock/operator/operator/security"),
      import("@flock/operator/operator/operations"),
      import("@flock/protocol/keys"),
      import("@flock/protocol/nsids"),
      import("@flock/protocol/atproto/record-pages"),
      import("@flock/client/app-runtime"),
      import("@flock/client/blocks"),
      import("@flock/client/engine"),
      import("@flock/client/node/admin-oauth"),
      import("@flock/client/node/transport"),
      import("@flock/webhooks/hooks-store"),
      import("@flock/webhooks/server"),
    ]);

    // 1. Provision a workspace on PDS 0, invite a non-admin member on PDS 1, and install the webhooks app (on PDS 1) with write in #general.
    const authority = await pds.createActor("whowner", 0);
    const member = await pds.createActor("whmember", 1);
    const bot = await pds.createActor("whbot", 1);
    await storeAuthorityGrant(pds.hosts[0], authority.did, "webhooks-authority-dpop");
    const created = await createWorkspace(
      await restoreAuthorityGrant(authority.did),
      { creator: authority.did, name: WORKSPACE_NAME, operationId: tidNow() },
      registrationDeps,
    );
    assert.equal(created.state, "completed");
    const generalSkey = created.channel.split("/").at(-1)!;
    const generalRef = { workspace: created.workspace, skey: generalSkey };

    const adminActor = await requireActiveWorkspaceAdmin(created.workspace, authority.did);
    for (const request of [
      { kind: "inviteMember" as const, subject: member.did },
      { kind: "installApp" as const, subject: bot.did, channels: [{ skey: generalSkey, write: true }] },
    ]) {
      const outcome = await executeOperatorOperation(adminActor, tidNow(), request, registrationDeps);
      assert.equal(outcome.state, "completed", request.kind);
    }

    const memberEngine = createEngine(actorTransport(pds, member), {
      operator: { serviceRef: pds.serviceRef, endpoint: operator.url },
    });
    await memberEngine.workspaces.accept(created.workspace);

    // 2. Start the webhooks app server with its own session, its identity-only admin OAuth client, and its owner-only hooks store.
    const stateFile = join(directory, "webhooks-session.json");
    const hooksFile = join(directory, "webhooks-session.json.hooks.json");
    const botSession = await mintAppSession(
      bot.pds,
      bot.did,
      { serviceRef: pds.serviceRef, plcUrl: pds.plcUrl, stateFile },
      "webhooks-bot-dpop",
    );
    const botTransport = nodeTransport(botSession, { plcUrl: pds.plcUrl, loopback: true });
    await publishAppDeclaration(botTransport, {
      name: "Webhooks",
      description: "Posts incoming webhook messages in granted channels.",
    });
    const botEngine = createEngine(botTransport, { applyOwnWrites: false });
    const adminOAuth = await createAdminIdentityOAuth({
      appUrl: webhooksOrigin,
      keys: [],
      name: "Webhooks Admin",
      plcUrl: pds.plcUrl,
    });
    const hooks = new HooksStore(hooksFile);
    const serverErrors: unknown[] = [];
    webhooksServer = await listenWebhooksServer(
      {
        appUrl: webhooksOrigin,
        appDid: bot.did,
        workspaces: [created.workspace],
        engine: botEngine,
        hooks,
        adminOAuth,
        onError: (error) => serverErrors.push(error),
      },
      { port: webhooksPort, host: "127.0.0.1" },
    );

    browser = await chromium.launch({ headless: true });

    // 3. In real Chromium, an admin signs in on `/admin`, creates a hook for #general, and sees its secret URL once.
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    adminPage.setDefaultTimeout(60_000);
    const cspConsoleViolations: string[] = [];
    adminPage.on("console", (msg) => {
      if (/Content Security Policy/i.test(msg.text()) && new URL(adminPage.url()).origin === webhooksOrigin) {
        cspConsoleViolations.push(msg.text());
      }
    });

    const initialLoad = await adminPage.goto(`${webhooksOrigin}/admin`);
    assert.ok(initialLoad);
    assert.equal(initialLoad.status(), 200);
    assert.equal(initialLoad.headers()["content-security-policy"], ADMIN_CSP);
    assert.equal(initialLoad.headers()["referrer-policy"], "same-origin");
    assert.equal(initialLoad.headers()["cache-control"], "no-store");

    await adminPage.getByLabel("AT Protocol handle or DID").fill(authority.did);
    await adminPage.getByRole("button", { name: "Continue with AT Protocol", exact: true }).click();
    // Under `form-action 'self'`, the form POST stays on `/admin/login` and renders a link to the PDS consent screen.
    const authLink = adminPage.getByRole("link", { name: /Continue to authorization/ });
    await authLink.waitFor({ state: "visible" });
    await authLink.click();
    await consent(adminPage, authority);

    // Top-level return from the PDS sends the `SameSite=Lax` flow cookie, and the `303` to `/admin` sends the `SameSite=Lax` session cookie.
    await adminPage.getByText(`Signed in as ${authority.did}`).waitFor({ state: "visible" });
    await adminPage.getByRole("heading", { name: WORKSPACE_NAME, exact: true }).waitFor({ state: "visible" });

    // Create the active hook for #general and confirm its URL is shown once.
    await adminPage.getByRole("button", { name: "Create webhook", exact: true }).click();
    const secretUrlCode = adminPage.locator("code.secret-url");
    await secretUrlCode.waitFor({ state: "visible" });
    const activeHookUrl = (await secretUrlCode.textContent())?.trim() ?? "";
    const activeMatch = new RegExp(`^${webhooksOrigin.replaceAll(".", "\\.")}/hooks/([A-Za-z0-9_-]{22})/([A-Za-z0-9_-]{43})$`).exec(activeHookUrl);
    assert.ok(activeMatch, `expected full webhook URL, got: ${activeHookUrl}`);
    const [, activeId, activeSecret] = activeMatch;

    await adminPage.getByRole("link", { name: "Done", exact: true }).click();
    await adminPage.waitForURL(`${webhooksOrigin}/admin`);
    assert.equal(await adminPage.locator("code.secret-url").count(), 0, "the webhook URL is shown once in the POST answer, never on GET /admin");
    assert.equal((await adminPage.content()).includes(activeSecret!), false, "GET /admin HTML never contains the secret");
    await adminPage.reload();
    assert.equal(await adminPage.locator("code.secret-url").count(), 0, "reloading GET /admin never shows the secret");
    assert.equal((await adminPage.content()).includes(activeSecret!), false, "reloaded HTML never contains the secret");
    assert.equal(readFileSync(hooksFile, "utf8").includes(activeSecret!), false, "hooks file never stores plaintext secret");
    const activeRow = adminPage.locator(`[data-hook-id="${activeId}"]`);
    await activeRow.waitFor({ state: "visible" });
    assert.match((await activeRow.textContent()) ?? "", /active/);

    // Create and immediately revoke a second hook through the browser UI so we can compare a revoked hook's answer.
    await adminPage.getByRole("button", { name: "Create webhook", exact: true }).click();
    await secretUrlCode.waitFor({ state: "visible" });
    const revokedHookUrl = (await secretUrlCode.textContent())?.trim() ?? "";
    const revokedMatch = new RegExp(`^${webhooksOrigin.replaceAll(".", "\\.")}/hooks/([A-Za-z0-9_-]{22})/([A-Za-z0-9_-]{43})$`).exec(revokedHookUrl);
    assert.ok(revokedMatch);
    const [, revokedId] = revokedMatch;
    await adminPage.locator(`[data-hook-id="${revokedId}"]`).getByRole("button", { name: "Revoke", exact: true }).click();
    await adminPage.getByText(`Revoked webhook ${revokedId}.`).waitFor({ state: "visible" });
    assert.equal(await adminPage.locator(`[data-hook-id="${revokedId}"]`).count(), 0);

    // 4. A workspace member who is NOT an admin signs in on `/admin` in a separate browser context and is refused (`403`).
    const nonAdminContext = await browser.newContext();
    const nonAdminPage = await nonAdminContext.newPage();
    nonAdminPage.setDefaultTimeout(60_000);
    await nonAdminPage.goto(`${webhooksOrigin}/admin`);
    await nonAdminPage.getByLabel("AT Protocol handle or DID").fill(member.did);
    await nonAdminPage.getByRole("button", { name: "Continue with AT Protocol", exact: true }).click();
    const memberAuthLink = nonAdminPage.getByRole("link", { name: /Continue to authorization/ });
    await memberAuthLink.waitFor({ state: "visible" });
    const callbackResponsePromise = nonAdminPage.waitForResponse((res) => res.url().startsWith(`${webhooksOrigin}/admin/oauth/callback`));
    await memberAuthLink.click();
    await consent(nonAdminPage, member);
    const callbackResponse = await callbackResponsePromise;
    assert.equal(callbackResponse.status(), 403);
    await nonAdminPage.getByRole("heading", { name: "Access denied", exact: true }).waitFor({ state: "visible" });
    // Navigating back to `/admin` still shows the sign-in form (no session cookie was issued to the non-admin).
    await nonAdminPage.goto(`${webhooksOrigin}/admin`);
    await nonAdminPage.getByLabel("AT Protocol handle or DID").waitFor({ state: "visible" });
    await nonAdminContext.close();

    // 5. A POST to the active webhook URL appears in #general as the app's message (with blocks and the APP badge).
    const postPayload = {
      text: "Deploy v1.2 succeeded",
      blocks: [
        sectionBlock("Deploy v1.2 succeeded — all checks green"),
        contextBlock(["pipeline #42"]),
      ],
    };
    const delivery = await fetch(activeHookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(postPayload),
    });
    assert.equal(delivery.status, 200);
    const deliveryJson = await delivery.json() as { ok?: boolean; uri?: string };
    assert.equal(deliveryJson.ok, true);

    const webContext = await browser.newContext();
    const webPage = await webContext.newPage();
    webPage.setDefaultTimeout(60_000);
    await signIn(webPage, webApp.url, member, WORKSPACE_NAME);
    await openChannel(webPage, "general");
    const appCard = webPage.locator(".message-card").filter({ hasText: "Deploy v1.2 succeeded — all checks green" });
    await appCard.waitFor({ state: "visible" });
    await appCard.getByText("pipeline #42", { exact: true }).waitFor({ state: "visible" });
    await appCard.locator(".app-marker", { hasText: "APP" }).waitFor({ state: "visible" });
    await appCard.getByText(`${bot.did.slice(0, 20)}…`, { exact: true }).waitFor({ state: "visible" });
    await webContext.close();

    // 6. A wrong secret and a revoked hook get the exact same 404 answer.
    const wrongSecretRes = await fetch(`${webhooksOrigin}/hooks/${activeId}/${"z".repeat(43)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "wrong secret" }),
    });
    const revokedHookRes = await fetch(revokedHookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "revoked hook" }),
    });
    const [wrongBody, revokedBody] = await Promise.all([wrongSecretRes.text(), revokedHookRes.text()]);
    assert.equal(wrongSecretRes.status, 404);
    assert.equal(revokedHookRes.status, 404);
    assert.equal(wrongBody, revokedBody);

    const beforeReadOnlyMessages = (await memberEngine.channels.readPage(generalRef)).messages;
    assert.equal(beforeReadOnlyMessages.length, 1);
    assert.equal(beforeReadOnlyMessages[0]!.value.text, "Deploy v1.2 succeeded");

    // 7. After the admin changes the app to read-only in #general, `/admin` shows the hook as unavailable, a POST is refused,
    //    and nothing is written either to #general or to the app's own repo.
    const adminClientEngine = createEngine(actorTransport(pds, authority), {
      operator: { serviceRef: pds.serviceRef, endpoint: operator.url },
    });
    const updatedAccess = await adminClientEngine.operator!.execute({
      workspace: created.workspace,
      operationId: tidNow(),
      request: { kind: "updateAppAccess", subject: bot.did, channels: [{ skey: generalSkey, write: false }] },
    });
    assert.equal(updatedAccess.operation.state, "completed");

    await adminPage.goto(`${webhooksOrigin}/admin`);
    const unavailableRow = adminPage.locator(`[data-hook-id="${activeId}"]`);
    await unavailableRow.waitFor({ state: "visible" });
    assert.match((await unavailableRow.textContent()) ?? "", /unavailable · read-only grant/);

    const refusedReadOnly = await fetch(activeHookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "should never be written" }),
    });
    assert.equal(refusedReadOnly.status, 404);
    assert.equal(await refusedReadOnly.text(), wrongBody);

    const channelMessages = (await memberEngine.channels.readPage(generalRef)).messages;
    assert.equal(channelMessages.some((m) => m.value.text === "should never be written"), false);

    const channelCredential = await memberEngine.credentials.fresh(created.channel);
    const botOwnSpaceRecords = await listBoundedRecords(channelCredential.client(bot.pds.url), {
      space: created.channel,
      repo: bot.did,
      collection: COLLECTION.message,
      maxRecords: 50,
    });
    assert.equal(botOwnSpaceRecords.records.length, 1, "nothing was written to the app's own repo after write grant was removed");
    assert.equal(botOwnSpaceRecords.records[0]!.value.text, "Deploy v1.2 succeeded");

    assert.deepEqual(cspConsoleViolations, [], "the admin page triggered zero CSP violations in Chromium");
    assert.deepEqual(serverErrors, [], "the webhooks server handled all requests without unexpected errors");
    await adminContext.close();
  } finally {
    await browser?.close();
    if (webhooksServer) {
      webhooksServer.closeAllConnections();
      await new Promise<void>((resolve) => webhooksServer!.close(() => resolve()));
    }
    await webApp?.stop();
    await operator?.stop();
    await pds.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
