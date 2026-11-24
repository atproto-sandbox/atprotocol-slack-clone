import assert from "node:assert/strict";
import test from "node:test";
import { chromium, type Browser, type Page } from "@playwright/test";
import { channelUri, parseWorkspaceUri } from "@flock/protocol/keys";
import { COLLECTION } from "@flock/protocol/nsids";
import { availablePort, startAppServer, startDeskServer, startOperatorServer, type AppServer } from "../support/app-server";
import { consent, openChannel } from "../support/browser-app";
import { watchPreflights } from "../support/browser-network";
import { startPdsNetwork, type NetworkActor } from "../support/pds-network";

const WORKSPACE_NAME = "Desk Parity Workspace";
const WEB_NOTE = "Hello from @flock/web";
const DESK_NOTE = "Hello from Flock Desk";
const DESK_EDITED_NOTE = "Edited cleanly from Flock Desk";
const DESK_REPLY_NOTE = "Reply from Flock Desk to @flock/web";
const HIDE_NOTE = "Spoiler message hidden by moderation";
const TAKEDOWN_NOTE = "Removed message withheld by takedown";
const REMOVED_WRITER_NOTE = "Post after removal must fail";

async function signInWeb(page: Page, webOrigin: string, actor: NetworkActor): Promise<void> {
  await page.goto(webOrigin);
  await page.getByLabel("Your AT Protocol handle").fill(actor.did);
  await page.getByRole("button", { name: /Continue with atproto/i }).click();
  await consent(page, actor);
  await page.locator(".app-frame").waitFor({ state: "attached", timeout: 60_000 });
}

async function signInDesk(page: Page, actor: NetworkActor): Promise<void> {
  await page.getByTestId("desk-handle-input").fill(actor.did);
  await page.getByTestId("desk-signin-button").click();
  await consent(page, actor);
  await page.getByTestId("desk-shell").waitFor({ state: "visible", timeout: 60_000 });
}

test("Flock Desk end-to-end parity (D3/D5): direct-grant & expiring invites, cross-posting, fresh-credential removal check, private roster, !hide/!takedown, labeler-compliant createReport, two-tab IDB isolation, sign-out erasure, CSP & zero Operator calls", { timeout: 600_000 }, async () => {
  const appPort = await availablePort();
  const operatorPort = await availablePort();
  const deskPort = await availablePort();
  const pds = await startPdsNetwork("desk-parity", { appPort, operatorPort });

  let operator: AppServer | undefined;
  let web: AppServer | undefined;
  let desk: AppServer | undefined;
  let browser: Browser | undefined;

  try {
    operator = await startOperatorServer();
    web = await startAppServer(appPort);
    desk = await startDeskServer({
      DESK_APP_URL: `http://127.0.0.1:${deskPort}`,
      PLC_URL: pds.plcUrl,
      GROUP_HOST_URL: pds.groupHostUrl,
    });

    const alice = await pds.createActor("deskalice", 0);
    const bob = await pds.createActor("deskbob", 1);
    const cara = await pds.createActor("deskcara", 1);

    browser = await chromium.launch({ headless: true });
    const aliceCtx = await browser.newContext();
    const bobCtx = await browser.newContext();
    const caraCtx = await browser.newContext();

    const alicePage = await aliceCtx.newPage();
    const bobDeskPage = await bobCtx.newPage();
    const caraDeskPage = await caraCtx.newPage();
    alicePage.setDefaultTimeout(45_000);
    bobDeskPage.setDefaultTimeout(45_000);
    caraDeskPage.setDefaultTimeout(45_000);

    const deskConsoleErrors: string[] = [];
    const deskCspViolations: string[] = [];
    const deskRequests: string[] = [];
    const bobPreflights = await watchPreflights(bobDeskPage);
    const caraPreflights = await watchPreflights(caraDeskPage);

    const deskOrigin = new URL(desk.url).origin;
    const pdsOrigins = new Set([new URL(bob.pds.url).origin, new URL(cara.pds.url).origin]);
    let caraRemoved = false;
    let caraRemovalAuthorityOrigin: string | undefined = undefined;
    let caraRemovalRefusalResponses = 0;
    const isCaraAuthorizeSyncUrl = (rawUrl: string): boolean => {
      if (!caraRemoved || !caraRemovalAuthorityOrigin) return false;
      try {
        const parsedLoc = new URL(rawUrl);
        return (
          parsedLoc.origin === caraRemovalAuthorityOrigin &&
          parsedLoc.pathname === "/xrpc/com.atproto.space.authorizeSpaceSync"
        );
      } catch {
        return false;
      }
    };
    caraDeskPage.on("response", (res) => {
      if (isCaraAuthorizeSyncUrl(res.url()) && (res.status() === 400 || res.status() === 403)) {
        caraRemovalRefusalResponses += 1;
      }
    });
    for (const [label, p] of [["bob", bobDeskPage], ["cara", caraDeskPage]] as const) {
      p.on("request", (req) => deskRequests.push(req.url()));
      p.on("console", (msg) => {
        if (!p.url().startsWith(deskOrigin)) return;
        const text = msg.text();
        const locUrl = msg.location().url;
        if (locUrl) {
          try {
            const parsedLoc = new URL(locUrl);
            if (
              text === "Failed to load resource: net::ERR_NAME_NOT_RESOLVED" &&
              parsedLoc.pathname === "/.well-known/atproto-did" &&
              /\.test2?$/.test(parsedLoc.hostname)
            ) {
              return;
            }
            if (
              /^Failed to load resource: the server responded with a status of 400\b/.test(text) &&
              pdsOrigins.has(parsedLoc.origin) &&
              (parsedLoc.pathname === "/oauth/par" ||
                (parsedLoc.pathname === "/xrpc/com.atproto.space.getSpace" &&
                  (parsedLoc.searchParams.get("space") ?? "").endsWith("/space/group.opensocial.invites/self")))
            ) {
              return;
            }
            if (
              label === "cara" &&
              /^Failed to load resource: the server responded with a status of 40[03]\b/.test(text) &&
              isCaraAuthorizeSyncUrl(locUrl)
            ) {
              return;
            }
          } catch {
            // fall through to record unexpected console error
          }
        }
        if (msg.type() === "error" || /Content Security Policy/i.test(text)) {
          deskConsoleErrors.push(`[${label}] ${locUrl ? `${text} (${locUrl})` : text}`);
        }
      });
      p.on("pageerror", (err) => {
        if (!p.url().startsWith(deskOrigin)) return;
        deskConsoleErrors.push(`[${label}] ${err.message}`);
      });
      await p.addInitScript(() => {
        const list: string[] = [];
        Object.assign(window, { __deskViolations: list });
        document.addEventListener("securitypolicyviolation", (event) => {
          list.push(`${event.effectiveDirective}:${event.blockedURI}`);
        });
      });
    }

    // 1. Alice creates workspace + private Vault channel + group rule on `@flock/web`
    await signInWeb(alicePage, web.url, alice);
    await alicePage.getByLabel("Workspace name").fill(WORKSPACE_NAME);
    const wsForm = alicePage.locator("form").filter({ has: alicePage.getByLabel("Workspace name") });
    await wsForm.getByRole("button", { name: "Create workspace", exact: true }).click();
    await consent(alicePage, alice);
    await alicePage.getByRole("heading", { name: WORKSPACE_NAME, exact: true }).waitFor({ state: "visible" });

    const workspaceUri = (await alicePage.locator(".welcome-banner .mono-note").innerText()).trim();
    const parsedWs = parseWorkspaceUri(workspaceUri);
    assert.ok(parsedWs, `expected workspace URI, got ${workspaceUri}`);

    // Connect Alice's Group Governance session so she can publish rules, send expiring cross-PDS invites, and moderate
    const governanceSection = alicePage.getByRole("region", { name: "OpenSocial group governance" });
    await governanceSection.getByRole("button", { name: "Sign in as group admin →" }).click();
    await consent(alicePage, alice);
    await governanceSection.getByRole("button", { name: "Disconnect group session", exact: true }).waitFor({ state: "visible" });

    // Direct-grant invite Bob via `@flock/web` (no expiresAt) and create private Vault channel for Bob
    await alicePage.getByLabel("Member DID", { exact: true }).fill(bob.did);
    await alicePage.getByRole("button", { name: /Invite member/ }).click();
    await alicePage.getByText(new RegExp(`Added ${bob.did.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)).waitFor({ state: "visible" });

    await alicePage.getByLabel("Channel name").fill("Vault");
    await alicePage.getByLabel("Channel visibility").selectOption("private");
    await alicePage.getByLabel("Private member DIDs").fill(bob.did);
    await alicePage.locator("form").filter({ has: alicePage.getByLabel("Channel name") }).getByRole("button", { name: /Create channel/ }).click();
    await alicePage.locator(".channel-nav-item").filter({ hasText: /Vault$/ }).waitFor({ state: "visible" });

    // Publish a group rule in meta/self for Desk's violation report test
    const moderationSection = alicePage.getByRole("region", { name: "Group moderation" });
    await moderationSection.getByLabel("Rule title").fill("Be respectful");
    await moderationSection.getByLabel("Rule description").fill("No spoilers or spam in channels.");
    await moderationSection.getByRole("button", { name: "Add rule →" }).click();
    await alicePage.getByText("Group rule published.", { exact: true }).waitFor({ state: "visible" });

    // 2. Bob joins via direct-grant invite link on Flock Desk (surviving signed-out OAuth redirect!)
    const firstDeskRes = await bobDeskPage.goto(`${desk.url}/?invite=${encodeURIComponent(workspaceUri)}`);
    const cspHeader = firstDeskRes?.headers()["content-security-policy"] ?? "";
    assert.match(cspHeader, /script-src 'self' 'nonce-[A-Za-z0-9+/]+={0,2}' 'strict-dynamic'/);
    assert.equal(cspHeader.includes("'unsafe-eval'"), false);

    await bobDeskPage.getByTestId("desk-invite-banner").waitFor({ state: "visible" });
    await signInDesk(bobDeskPage, bob);
    const joinBtn = bobDeskPage.getByTestId("desk-join-button");
    const wsHeading = bobDeskPage.getByRole("heading", { name: WORKSPACE_NAME, exact: true });
    await joinBtn.or(wsHeading).first().waitFor({ state: "visible", timeout: 60_000 });
    if (await joinBtn.isVisible()) await joinBtn.click();
    await wsHeading.waitFor({ state: "visible", timeout: 60_000 });
    assert.equal(
      (await bobDeskPage.getByTestId("desk-workspace-summary").innerText()).trim(),
      "2 active members · 2 channels · join policy: invite",
    );

    // Verify private channel Vault roster parity in Desk
    await bobDeskPage.locator('[data-testid="desk-channel-item"][data-channel-name="Vault"]').click();
    await bobDeskPage.locator('[data-testid="desk-channel-view"][data-ready="true"]').waitFor({ state: "visible" });
    assert.equal((await bobDeskPage.getByTestId("desk-private-roster").innerText()).trim(), bob.did);

    // 3. Cara signs into Desk (provisions invites/self), Alice sends expiring cross-PDS invite, Cara accepts from Desk Invites inbox!
    await caraDeskPage.goto(desk.url);
    await signInDesk(caraDeskPage, cara);

    await governanceSection.getByLabel("Cross-PDS invitee DID").fill(cara.did);
    await governanceSection.getByRole("button", { name: "Send cross-PDS invite →" }).click();
    await alicePage.getByText("Cross-PDS invitation written and queued for delivery.", { exact: true }).waitFor({ state: "visible" });
    await pds.groupHost.flushBackgroundWork();

    await caraDeskPage.getByTestId("desk-refresh-button").click();
    const caraInvites = caraDeskPage.getByTestId("desk-invites-inbox");
    await caraInvites.getByTestId("desk-invite-card").first().waitFor({ state: "visible", timeout: 30_000 });
    await caraInvites.getByTestId("desk-accept-invite-button").first().click();
    await caraDeskPage.getByRole("heading", { name: WORKSPACE_NAME, exact: true }).waitFor({ state: "visible", timeout: 60_000 });

    // 4. Cross-posting & edit between `@flock/web` and Desk
    await openChannel(alicePage, "general");
    for (const note of [WEB_NOTE, TAKEDOWN_NOTE]) {
      await alicePage.getByPlaceholder("Write a message…").fill(note);
      await alicePage.getByRole("button", { name: "Send", exact: true }).click();
      await alicePage.locator(".message-card").filter({ hasText: note }).waitFor({ state: "visible" });
    }

    await bobDeskPage.locator('[data-testid="desk-channel-item"][data-channel-name="general"]').click();
    await bobDeskPage.locator('[data-testid="desk-channel-view"][data-channel-skey="general"][data-ready="true"]').waitFor({ state: "visible" });
    await bobDeskPage.getByText(WEB_NOTE, { exact: true }).waitFor({ state: "visible" });

    // Bob posts HIDE_NOTE (own message so `!hide` Edit suppression is verified non-vacuously!),
    // posts DESK_NOTE, edits it, replies to Alice's Web message, and deletes his reply
    await bobDeskPage.getByTestId("desk-message-input").fill(HIDE_NOTE);
    await bobDeskPage.getByTestId("desk-send-button").click();
    const bobHideItemBeforeVeil = bobDeskPage.getByTestId("desk-message-item").filter({ hasText: HIDE_NOTE });
    await bobHideItemBeforeVeil.waitFor({ state: "visible" });
    assert.equal(await bobHideItemBeforeVeil.getByTestId("desk-edit-message-button").count(), 1, "Own message exposes Edit before !hide");
    assert.equal(await bobHideItemBeforeVeil.getByTestId("desk-reply-message-button").count(), 1, "Top-level message exposes Reply before !hide");

    await bobDeskPage.getByTestId("desk-message-input").fill(DESK_NOTE);
    await bobDeskPage.getByTestId("desk-send-button").click();
    await bobDeskPage.getByText(DESK_NOTE, { exact: true }).waitFor({ state: "visible" });

    const bobOwnItem = bobDeskPage.getByTestId("desk-message-item").filter({ hasText: DESK_NOTE });
    await bobOwnItem.getByTestId("desk-edit-message-button").click();
    await bobDeskPage.getByTestId("desk-edit-message-input").fill(DESK_EDITED_NOTE);
    await bobDeskPage.getByTestId("desk-save-edit-button").click();
    await bobDeskPage.getByText(DESK_EDITED_NOTE, { exact: true }).waitFor({ state: "visible" });

    const webNoteItemInDesk = bobDeskPage.getByTestId("desk-message-item").filter({ hasText: WEB_NOTE });
    await webNoteItemInDesk.getByTestId("desk-reply-message-button").click();
    await bobDeskPage.getByTestId("desk-message-input").fill(DESK_REPLY_NOTE);
    await bobDeskPage.getByTestId("desk-send-button").click();
    await bobDeskPage.getByText(DESK_REPLY_NOTE, { exact: true }).waitFor({ state: "visible" });

    // Alice syncs #general on `@flock/web` and sees Bob's edited Desk message AND Desk reply!
    await alicePage.getByRole("button", { name: "Sync ↻" }).click();
    await alicePage.locator(".message-card").filter({ hasText: DESK_EDITED_NOTE }).waitFor({ state: "visible" });
    await alicePage.locator(".message-card").filter({ hasText: DESK_REPLY_NOTE }).waitFor({ state: "visible" });

    // Bob deletes his reply in Desk -> disappears from Desk AND from `@flock/web` after sync!
    const bobReplyItem = bobDeskPage.getByTestId("desk-message-item").filter({ hasText: DESK_REPLY_NOTE });
    await bobReplyItem.getByTestId("desk-delete-message-button").click();
    await bobReplyItem.waitFor({ state: "hidden", timeout: 30_000 });
    await alicePage.getByRole("button", { name: "Sync ↻" }).click();
    await alicePage.locator(".message-card").filter({ hasText: DESK_REPLY_NOTE }).waitFor({ state: "hidden", timeout: 30_000 });

    // 5. Bob submits a labeler-compliant `violation` report citing the meta/self rule directly from Desk!
    const hideItemInDesk = bobDeskPage.getByTestId("desk-message-item").filter({ hasText: HIDE_NOTE });
    const hideUri = await hideItemInDesk.getAttribute("data-message-uri");
    assert.ok(hideUri);
    await hideItemInDesk.getByTestId("desk-report-message-button").click();
    await bobDeskPage.getByTestId("desk-report-panel").waitFor({ state: "visible" });
    await bobDeskPage.getByTestId("desk-report-reason-type").selectOption("violation");
    await bobDeskPage.getByTestId("desk-report-rule-select").waitFor({ state: "visible" });
    await bobDeskPage.getByTestId("desk-report-reason-input").fill("Reported from Flock Desk");
    await bobDeskPage.getByTestId("desk-report-submit-button").click();
    await bobDeskPage.getByTestId("desk-report-confirmation").waitFor({ state: "visible" });

    // Also report TAKEDOWN_NOTE from Desk so Alice can apply `!takedown` in Moderation queue
    const takedownItemInDesk = bobDeskPage.getByTestId("desk-message-item").filter({ hasText: TAKEDOWN_NOTE });
    const takedownUri = await takedownItemInDesk.getAttribute("data-message-uri");
    assert.ok(takedownUri);
    await takedownItemInDesk.getByTestId("desk-report-message-button").click();
    await bobDeskPage.getByTestId("desk-report-reason-type").selectOption("spam");
    await bobDeskPage.getByTestId("desk-report-submit-button").click();
    await bobDeskPage.getByTestId("desk-report-confirmation").waitFor({ state: "visible" });

    // Alice applies `!hide` and `!takedown` in `@flock/web` Moderation queue
    await alicePage.getByRole("button", { name: new RegExp(WORKSPACE_NAME) }).click();
    await moderationSection.getByRole("button", { name: "Refresh queue ↻" }).click();

    const hideRow = moderationSection.locator(".roster-row").filter({ hasText: hideUri });
    await hideRow.waitFor({ state: "visible" });
    await hideRow.getByRole("button", { name: "Apply !hide", exact: true }).click();
    await alicePage.getByText(`Published !hide label on ${hideUri}.`, { exact: true }).waitFor({ state: "visible" });

    const tdRow = moderationSection.locator(".roster-row").filter({ hasText: takedownUri });
    await tdRow.waitFor({ state: "visible" });
    await tdRow.getByRole("button", { name: "Apply !takedown", exact: true }).click();
    await alicePage.getByText(`Published !takedown label on ${takedownUri}.`, { exact: true }).waitFor({ state: "visible" });

    // Bob refreshes #general in Desk -> `!takedown` withheld; `!hide` collapsed with click-to-reveal & suppressed Reply/Edit!
    await bobDeskPage.getByTestId("desk-channel-refresh-button").click();
    const veiledHideItem = bobDeskPage.locator(
      `[data-testid="desk-message-item"][data-message-uri="${hideUri}"][data-hidden="true"]`,
    );
    await veiledHideItem.waitFor({ state: "visible" });
    assert.equal(await bobDeskPage.getByText(HIDE_NOTE, { exact: true }).count(), 0, "!hide collapsed by default in Desk");
    assert.equal(
      await veiledHideItem.getByTestId("desk-reply-message-button").count(),
      0,
      "!hide must suppress Reply action until explicit reveal",
    );
    assert.equal(
      await veiledHideItem.getByTestId("desk-edit-message-button").count(),
      0,
      "!hide must suppress Edit action until explicit reveal",
    );
    await bobDeskPage.getByTestId("desk-reveal-hidden-button").click();
    await bobDeskPage.getByText(HIDE_NOTE, { exact: true }).waitFor({ state: "visible" });
    assert.equal(await veiledHideItem.getByTestId("desk-edit-message-button").count(), 1, "Own message re-exposes Edit after explicit reveal");
    assert.equal(await veiledHideItem.getByTestId("desk-reply-message-button").count(), 1, "Top-level message re-exposes Reply after explicit reveal");
    assert.equal(await bobDeskPage.locator(`[data-message-uri="${takedownUri}"]`).count(), 0, "!takedown withheld in Desk");

    // 6. Remove Cara in `@flock/web` -> Cara's next post in Desk is immediately rejected by fresh pre-write credential check!
    await caraDeskPage.locator('[data-testid="desk-channel-item"][data-channel-name="general"]').click();
    await caraDeskPage.locator('[data-testid="desk-channel-view"][data-channel-skey="general"][data-ready="true"]').waitFor({ state: "visible" });

    const caraRosterRow = alicePage.locator(".starter-card.roster-list").first().locator(".roster-row").filter({ hasText: cara.did });
    await caraRosterRow.getByRole("button", { name: "Remove", exact: true }).click();
    await caraRosterRow.waitFor({ state: "hidden", timeout: 60_000 });

    const groupDidDoc = (await (await fetch(`${pds.plcUrl}/${encodeURIComponent(parsedWs.authorityDid)}`)).json()) as {
      service?: Array<{ id?: string; serviceEndpoint?: string }>;
    };
    const groupPdsEndpoint = groupDidDoc.service?.find((s) => s.id === "#atproto_pds")?.serviceEndpoint;
    assert.ok(groupPdsEndpoint, `Expected #atproto_pds service endpoint for ${parsedWs.authorityDid}`);
    caraRemovalAuthorityOrigin = new URL(groupPdsEndpoint).origin;
    caraRemoved = true;
    await caraDeskPage.getByTestId("desk-message-input").fill(REMOVED_WRITER_NOTE);
    await caraDeskPage.getByTestId("desk-send-button").click();
    const caraErrorBanner = caraDeskPage.getByTestId("desk-channel-error");
    await caraErrorBanner.waitFor({ state: "visible", timeout: 30_000 });
    assert.ok(
      caraRemovalRefusalResponses >= 1,
      `Expected Group Host authorizeSpaceSync 400/403 refusal for removed member Cara (console: ${deskConsoleErrors.join(" | ")})`,
    );
    const caraErrorText = (await caraErrorBanner.innerText()).trim();
    assert.ok(caraErrorText.length > 0, "Removed member write must show explicit error text");
    assert.equal(
      await caraDeskPage.getByTestId("desk-message-list").getByText(REMOVED_WRITER_NOTE, { exact: true }).count(),
      0,
      "Rejected message must not appear in Cara's channel message list",
    );

    // Verify rejected write was NEVER persisted to Cara's personal PDS space repo!
    const generalSpaceUri = channelUri(parsedWs.authorityDid, "general");
    const caraListUrl = new URL("/xrpc/com.atproto.space.listRecords", cara.pds.url);
    caraListUrl.searchParams.set("space", generalSpaceUri);
    caraListUrl.searchParams.set("repo", cara.did);
    caraListUrl.searchParams.set("collection", COLLECTION.message);
    const caraRepoRes = await fetch(caraListUrl, {
      headers: { authorization: `Bearer ${cara.accessJwt}` },
    });
    assert.equal(caraRepoRes.status, 200, "Authenticated PDS owner can inspect own space repo");
    const caraRepoBody = (await caraRepoRes.json()) as { records?: Array<{ value?: { text?: string } }> };
    const leaked = (caraRepoBody.records ?? []).some((rec) => rec.value?.text === REMOVED_WRITER_NOTE);
    assert.equal(leaked, false, "Rejected post after removal must NOT exist in Cara's personal PDS repo");

    // 7. Same-context two-tab origin IndexedDB isolation + sign-out erasure of `flock-desk-lifecycle:<bobDid>`!
    const bobWebTab = await bobCtx.newPage();
    bobWebTab.setDefaultTimeout(45_000);
    await signInWeb(bobWebTab, web.url, bob);
    await bobWebTab.getByRole("heading", { name: WORKSPACE_NAME, exact: true }).waitFor({ state: "visible", timeout: 60_000 });

    const webIdbNames = await bobWebTab.evaluate(async () => (await indexedDB.databases()).map((d) => d.name ?? "").sort());
    assert.ok(webIdbNames.some((n) => n.startsWith("flock-sync-")), `expected @flock/web to hold flock-sync-* DB, got ${JSON.stringify(webIdbNames)}`);

    const deskIdbBeforeSignOut = await bobDeskPage.evaluate(async () => (await indexedDB.databases()).map((d) => d.name ?? "").sort());
    assert.equal(deskIdbBeforeSignOut.some((n) => n.startsWith("flock-sync-")), false, `Desk must hold ZERO flock-sync-* DBs, got ${JSON.stringify(deskIdbBeforeSignOut)}`);
    assert.ok(deskIdbBeforeSignOut.includes("@atproto-oauth-client"));
    assert.ok(deskIdbBeforeSignOut.includes(`flock-desk-lifecycle:${bob.did}`));

    await bobDeskPage.getByTestId("desk-signout-button").click();
    await bobDeskPage.getByTestId("desk-handle-input").waitFor({ state: "visible", timeout: 30_000 });
    const deskIdbAfterSignOut = await bobDeskPage.evaluate(async () => (await indexedDB.databases()).map((d) => d.name ?? "").sort());
    assert.equal(
      deskIdbAfterSignOut.includes(`flock-desk-lifecycle:${bob.did}`),
      false,
      `Sign-out must erase flock-desk-lifecycle:<bobDid>, got ${JSON.stringify(deskIdbAfterSignOut)}`,
    );

    // 8. Zero requests from Desk to Operator or Web origin, zero CSP violations, zero failed CORS preflights
    const operatorOrigin = new URL(operator.url).origin;
    const webOrigin = new URL(web.url).origin;
    assert.deepEqual(
      deskRequests.filter((u) => new URL(u).origin === operatorOrigin),
      [],
      "Flock Desk must issue ZERO HTTP requests to Operator",
    );
    assert.deepEqual(
      deskRequests.filter((u) => new URL(u).origin === webOrigin),
      [],
      "Flock Desk must issue ZERO HTTP requests to @flock/web",
    );

    for (const p of [bobDeskPage, caraDeskPage]) {
      const violations = await p.evaluate(() => (window as { __deskViolations?: string[] }).__deskViolations ?? []);
      deskCspViolations.push(...violations);
    }
    assert.deepEqual(deskCspViolations, [], `Unexpected CSP violations on Desk: ${deskCspViolations.join(" | ")}`);

    // Every unexpected console error, pageerror, or CSP violation across both Desk pages must be strictly zero
    // (only Cara's intentional post-removal 400/403 during her write attempt and fixture *.test handle checks are exempted).
    assert.deepEqual(
      deskConsoleErrors,
      [],
      `Unexpected Desk console/page errors: ${deskConsoleErrors.join(" | ")}`,
    );

    const failedPreflights = [...bobPreflights, ...caraPreflights].filter((pf) => !/^2\d\d$/.test(pf.outcome));
    assert.deepEqual(failedPreflights, [], `Unexpected failed CORS preflights on Desk: ${JSON.stringify(failedPreflights)}`);
  } finally {
    await browser?.close();
    await desk?.stop();
    await web?.stop();
    await operator?.stop();
    await pds.close();
  }
});
