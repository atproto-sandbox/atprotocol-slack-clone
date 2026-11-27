import assert from "node:assert/strict";
import test from "node:test";
import { chromium, type Browser } from "@playwright/test";
import { availablePort, startDeskServer, type AppServer } from "../support/app-server";

const directive = (policy: string, prefix: string) =>
  policy.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${prefix} `)) ?? "";
const scriptSrc = (policy: string) => directive(policy, "script-src");
const connectSrc = (policy: string) => directive(policy, "connect-src");

const INJECTED = `<script>window.deskInjected = [...(window.deskInjected ?? []), "script"]</script><img src="data:," onerror="window.deskInjected = [...(window.deskInjected ?? []), 'handler']">`;

test("Flock Desk D0 CSP gate: Astryx renders under strict per-request nonces, zero console/CSP errors, dynamic origin override, and localhost -> 127.0.0.1 redirect", { timeout: 180_000 }, async () => {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  let desk: AppServer | undefined;
  let browser: Browser | undefined;

  try {
    desk = await startDeskServer({
      DESK_APP_URL: origin,
      PLC_URL: "http://127.0.0.1:2582",
    });

    // 1. Dynamic origin override: /oauth/client-metadata.json matches bound origin and has zero operator scopes.
    const metaRes = await fetch(`${desk.url}/oauth/client-metadata.json`);
    assert.equal(metaRes.status, 200);
    const meta = (await metaRes.json()) as { client_id: string; client_name: string; redirect_uris: string[]; scope: string };
    assert.equal(meta.client_name, "Flock Desk");
    assert.deepEqual(meta.redirect_uris, [`${origin}/oauth/callback`]);
    assert.equal(meta.scope.includes("new.flock.operator."), false, "Desk metadata must include zero Operator scopes");

    // 2. localhost -> 127.0.0.1 loopback redirect preserving path and query.
    const inviteQuery = "/?invite=at%3Aspace%2Fdid%3Aplc%3Aexample%2Fnew.flock.workspace%2Fself";
    const redirectRes = await fetch(`http://localhost:${port}${inviteQuery}`, { redirect: "manual" });
    assert.ok(redirectRes.status === 307 || redirectRes.status === 308, `Expected 307/308 redirect, got ${redirectRes.status}`);
    assert.equal(redirectRes.headers.get("location"), `${origin}${inviteQuery}`);

    // 3. Real Chromium verification: strict per-request CSP nonces, zero console errors, zero CSP violations, Astryx UI renders cleanly.
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(30_000);
    const consoleErrors: string[] = [];
    const cspViolations: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error" || /Content Security Policy/i.test(msg.text())) {
        consoleErrors.push(msg.text());
      }
    });
    page.on("pageerror", (err) => consoleErrors.push(err.message));
    await page.addInitScript(() => {
      const violations: string[] = [];
      Object.assign(window, { __deskCspViolations: violations });
      document.addEventListener("securitypolicyviolation", (event) => {
        violations.push(`${event.effectiveDirective}:${event.blockedURI}`);
      });
    });

    const firstRes = await page.goto(desk.url);
    assert.ok(firstRes && firstRes.ok());
    const firstPolicy = firstRes.headers()["content-security-policy"] ?? "";
    await page.getByTestId("desk-handle-input").waitFor({ state: "visible" });
    const signInBtn = page.getByTestId("desk-signin-button");
    await signInBtn.waitFor({ state: "visible" });
    // Wait for initial session check to finish hydrating and enable the submit button.
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('[data-testid="desk-signin-button"]') as HTMLButtonElement | null;
        return Boolean(btn && !btn.disabled);
      },
      undefined,
      { timeout: 15_000 },
    );

    // Deterministically prove React hydration & Astryx interaction under strict nonce CSP without any external DNS lookup:
    // submitting a raw server URL triggers Desk's synchronous client-side validation error Banner locally.
    await page.getByTestId("desk-handle-input").fill("https://pds.evil.example");
    await signInBtn.click();
    const validationAlert = page.getByTestId("desk-signin-error");
    await validationAlert.waitFor({ state: "visible", timeout: 10_000 });
    assert.match(await validationAlert.innerText(), /ATProto handle|not a server URL/i);
    assert.equal(new URL(page.url()).origin, origin, "Page must stay on Desk origin");

    const secondRes = await page.reload();
    assert.ok(secondRes && secondRes.ok());
    assert.equal(new URL(page.url()).origin, origin, "Reload must stay on Desk origin");
    const secondPolicy = secondRes.headers()["content-security-policy"] ?? "";

    for (const policy of [firstPolicy, secondPolicy]) {
      assert.match(scriptSrc(policy), /^script-src 'self' 'nonce-[A-Za-z0-9+/]+={0,2}' 'strict-dynamic'$/, policy);
      assert.equal(policy.includes("'unsafe-eval'"), false, `Unexpected unsafe-eval in production CSP: ${policy}`);
      assert.equal(connectSrc(policy), "connect-src 'self' https: http://localhost:* http://127.0.0.1:*", policy);
    }
    assert.notEqual(scriptSrc(firstPolicy), scriptSrc(secondPolicy), "Each request must receive a fresh CSP nonce");

    const domViolations = await page.evaluate(() => (window as { __deskCspViolations?: string[] }).__deskCspViolations ?? []);
    cspViolations.push(...domViolations);
    assert.deepEqual(consoleErrors, [], `Unexpected console/page errors: ${consoleErrors.join(" | ")}`);
    assert.deepEqual(cspViolations, [], `Unexpected CSP violations: ${cspViolations.join(" | ")}`);

    // 4. Injected inline script & inline event handler are blocked by Desk's CSP.
    const attackPage = await browser.newPage();
    attackPage.setDefaultTimeout(30_000);
    await attackPage.addInitScript(() => {
      const refused: string[] = [];
      Object.assign(window, { __deskRefused: refused });
      document.addEventListener("securitypolicyviolation", (event) => refused.push(event.effectiveDirective));
    });
    await attackPage.route(`${desk.url}/`, async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace("</body>", `${INJECTED}</body>`) });
    });
    await attackPage.goto(desk.url);
    await attackPage.waitForFunction(() => new Set((window as { __deskRefused?: string[] }).__deskRefused).size >= 2, undefined, { timeout: 10_000 }).catch(() => undefined);
    const attackOutcome = await attackPage.evaluate(() => ({
      ran: (window as { deskInjected?: string[] }).deskInjected ?? [],
      refused: [...new Set((window as { __deskRefused?: string[] }).__deskRefused ?? [])].sort(),
    }));
    assert.deepEqual(attackOutcome, { ran: [], refused: ["script-src-attr", "script-src-elem"] });
  } finally {
    await browser?.close();
    await desk?.stop();
  }
});
