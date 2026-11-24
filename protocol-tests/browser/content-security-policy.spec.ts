import assert from "node:assert/strict";
import test from "node:test";
import { chromium, type Browser } from "@playwright/test";
import { tidNow } from "@flock/protocol/keys";
import { availablePort, startAppServer, startOperatorServer, type AppServer } from "../support/app-server";
import { consent } from "../support/browser-app";
import { createOpenSocialGroup, startPdsNetwork } from "../support/pds-network";

// R6's script-policy gate (`.ai/plans/platform-refactor.md`, "Final review") + R13 Group Host `connect-src` check:
// the browser holds the member's grant, per-user Group OAuth keys, and synced history, so the web app's pages run their own
// scripts under a nonce made for each request, and a script injected into a page does not run, whether as an inline script or
// as an inline event handler. Meanwhile `connect-src` allows direct browser connections to personal PDSes, PLC, Operator, and
// `pds.groupHostUrl` with zero CSP violations.

const directive = (policy: string, prefix: string) =>
  policy.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${prefix} `)) ?? "";
const scriptSrc = (policy: string) => directive(policy, "script-src");
const connectSrc = (policy: string) => directive(policy, "connect-src");
const INJECTED = `<script>window.injected = [...(window.injected ?? []), "script"]</script><img src="data:," onerror="window.injected = [...(window.injected ?? []), 'handler']">`;

test("the app's own scripts run under each page's nonce, injected scripts are blocked, and connect-src permits Group Host, personal PDS, PLC, and Operator", { timeout: 300_000 }, async () => {
  const appPort = await availablePort();
  const operatorPort = await availablePort();
  const pds = await startPdsNetwork("content-security-policy", { appPort, operatorPort });
  let operator: AppServer | undefined;
  let app: AppServer | undefined;
  let browser: Browser | undefined;
  try {
    operator = await startOperatorServer();
    app = await startAppServer(appPort);
    const [{ restoreAuthorityGrant }, { grantCreationAuthorization }, { createWorkspace }, { registrationDeps }] = await Promise.all([
      import("@flock/operator/operator/authority-grant"),
      import("@flock/operator/operator/creation-authorization"),
      import("@flock/operator/operator/kinds/create-workspace"),
      import("@flock/operator/operator/registrations"),
    ]);

    const actor = await pds.createActor("csp", 0);
    const createdGroup = await createOpenSocialGroup(pds, actor, { name: "CSP Group" });
    grantCreationAuthorization(
      { authorityDid: createdGroup.groupDid, initiatorDid: actor.did, name: "CSP Group" },
      Math.floor(Date.now() / 1000),
    );
    const createdWs = await createWorkspace(
      await restoreAuthorityGrant(createdGroup.groupDid),
      { creator: actor.did, name: "CSP Group", operationId: tidNow() },
      registrationDeps,
    );
    assert.equal(createdWs.state, "completed", JSON.stringify(createdWs));

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(30_000);
    const refusals: string[] = [];
    page.on("console", (message) => { if (/Content Security Policy/i.test(message.text())) refusals.push(message.text()); });

    // #given the app's page, loaded twice
    const first = (await page.goto(app.url))?.headers()["content-security-policy"] ?? "";
    const second = (await page.reload())?.headers()["content-security-policy"] ?? "";

    // #then each load has a policy of its own, allowing scripts only under its nonce and loopback protocol origins under connect-src
    for (const policy of [first, second]) {
      assert.match(scriptSrc(policy), /^script-src 'self' 'nonce-[A-Za-z0-9+/]+={0,2}' 'strict-dynamic'$/, policy);
      assert.equal(connectSrc(policy), "connect-src 'self' https: http://localhost:* http://127.0.0.1:*", policy);
    }
    assert.notEqual(scriptSrc(first), scriptSrc(second));
    assert.deepEqual(refusals, []);

    // #when the page arrives with a script and an inline event handler injected into its document
    await page.addInitScript(() => {
      const refused: string[] = [];
      Object.assign(window, { refused });
      document.addEventListener("securitypolicyviolation", (event) => refused.push(event.effectiveDirective));
    });
    await page.route(`${app.url}/`, async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace("</body>", `${INJECTED}</body>`) });
    });
    await page.goto(app.url);
    await page.waitForFunction(() => new Set((window as { refused?: string[] }).refused).size >= 2, undefined, { timeout: 10_000 }).catch(() => undefined);
    const injected = await page.evaluate(() => ({
      ran: (window as { injected?: string[] }).injected ?? [],
      refused: [...new Set((window as { refused?: string[] }).refused ?? [])].sort(),
    }));

    // #then neither ran, and the browser refused both
    assert.deepEqual(injected, { ran: [], refused: ["script-src-attr", "script-src-elem"] });

    // #then on a clean page under the app's served CSP, signing in, syncing from Group Host + personal PDS + PLC + Operator,
    // and completing Group-DID OAuth directly against `pds.groupHostUrl` trigger zero CSP violations
    const livePage = await browser.newPage();
    livePage.setDefaultTimeout(30_000);
    const liveViolations: string[] = [];
    const seenOrigins = new Set<string>();
    livePage.on("console", (message) => { if (/Content Security Policy/i.test(message.text())) liveViolations.push(message.text()); });
    livePage.on("response", (response) => {
      if (response.status() < 400) seenOrigins.add(new URL(response.url()).origin);
    });
    await livePage.addInitScript(() => {
      const refused: string[] = [];
      Object.assign(window, { refused });
      document.addEventListener("securitypolicyviolation", (event) => refused.push(`${event.effectiveDirective}:${event.blockedURI}`));
    });
    await livePage.goto(app.url);
    await livePage.getByLabel("Your AT Protocol handle").fill(actor.did);
    await livePage.getByRole("button", { name: /Continue with atproto/i }).click();
    await consent(livePage, actor);
    await livePage.getByRole("heading", { name: "CSP Group", exact: true }).waitFor({ state: "visible" });

    await livePage.getByRole("button", { name: "Sign in as group admin →" }).click();
    await consent(livePage, actor);
    await livePage.getByRole("button", { name: "Disconnect group session", exact: true }).waitFor({ state: "visible" });

    const domViolations = await livePage.evaluate(() => (window as { refused?: string[] }).refused ?? []);
    assert.deepEqual(liveViolations, [], `unexpected CSP console errors: ${liveViolations.join(" | ")}`);
    assert.deepEqual(domViolations, [], `unexpected securitypolicyviolation events: ${domViolations.join(" | ")}`);
    for (const origin of [
      new URL(pds.groupHostUrl).origin,
      `http://localhost:${pds.groupHost.port}`,
      new URL(pds.hosts[0].url).origin,
      new URL(pds.plcUrl).origin,
      new URL(operator.url).origin,
    ]) {
      assert.ok(seenOrigins.has(origin), `expected browser to reach ${origin} cleanly under CSP`);
    }
  } finally {
    await browser?.close();
    await app?.stop();
    await operator?.stop();
    await pds.close();
  }
});
