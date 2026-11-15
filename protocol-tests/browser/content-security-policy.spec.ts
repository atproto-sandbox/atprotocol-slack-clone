import assert from "node:assert/strict";
import test from "node:test";
import { chromium, type Browser } from "@playwright/test";
import { availablePort, startAppServer, type AppServer } from "../support/app-server";
import { startPdsNetwork } from "../support/pds-network";

// R6's script-policy gate (`.ai/plans/platform-refactor.md`, "Final review"): the browser holds the member's grant and synced
// history, so the web app's pages run their own scripts under a nonce made for each request, and a script injected into a
// page does not run, whether as an inline script or as an inline event handler. The injection is put into the app's own
// document, as a stored or reflected one would arrive, under the policy the app sent with it.

const scriptSrc = (policy: string) => policy.split(";").map((part) => part.trim()).find((part) => part.startsWith("script-src ")) ?? "";
const INJECTED = `<script>window.injected = [...(window.injected ?? []), "script"]</script><img src="data:," onerror="window.injected = [...(window.injected ?? []), 'handler']">`;

test("the app's own scripts run under each page's nonce, and a script injected into the page does not", { timeout: 300_000 }, async () => {
  const appPort = await availablePort();
  const pds = await startPdsNetwork("content-security-policy", { appPort });
  let app: AppServer | undefined;
  let browser: Browser | undefined;
  try {
    app = await startAppServer(appPort);
    const actor = await pds.createActor("csp", 0);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const refusals: string[] = [];
    page.on("console", (message) => { if (/Content Security Policy/i.test(message.text())) refusals.push(message.text()); });

    // #given the app's page, loaded twice
    const first = (await page.goto(app.url))?.headers()["content-security-policy"] ?? "";
    const second = (await page.reload())?.headers()["content-security-policy"] ?? "";

    // #then each load has a policy of its own, allowing scripts only under its nonce, and the page's own scripts were refused nothing
    for (const policy of [first, second]) assert.match(scriptSrc(policy), /^script-src 'self' 'nonce-[A-Za-z0-9+/]+={0,2}' 'strict-dynamic'$/, policy);
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

    // #then on the app's own page, as it serves it, its scripts work: signing in takes the page to the PDS's consent screen
    await page.unrouteAll();
    const errors: string[] = [];
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(app.url);
    await page.getByLabel("Your AT Protocol handle").fill(actor.did);
    await page.getByRole("button", { name: /Continue with atproto/i }).click();
    await page.waitForURL(/\/oauth\/authorize\?/).catch((error: unknown) => {
      throw new Error(`Signing in did not reach the consent screen; the page said: ${errors.join(" | ") || "nothing"}`, { cause: error });
    });
  } finally {
    await browser?.close();
    await app?.stop();
    await pds.close();
  }
});
