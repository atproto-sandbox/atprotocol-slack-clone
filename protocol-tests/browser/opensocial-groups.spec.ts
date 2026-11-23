import assert from "node:assert/strict";
import test from "node:test";
import { chromium, type Browser, type Page } from "@playwright/test";
import { parseWorkspaceUri } from "@flock/protocol/keys";
import { availablePort, startAppServer, startOperatorServer, type AppServer } from "../support/app-server";
import { consent, openChannel } from "../support/browser-app";
import { countByOrigin, watchPreflights } from "../support/browser-network";
import { startPdsNetwork, type NetworkActor } from "../support/pds-network";

// R13 Gate 6 (`.ai/plans/r13-opensocial-groups.md`): real Chromium Playwright end-to-end verification of
// OpenSocial atmospheric groups across `APP_URL`, `OPERATOR_URL`, `GROUP_HOST_URL`, and two personal PDS hosts:
// 1. Dual-OAuth isolation (`BrowserOAuthClient` in `@atproto-oauth-client` vs `GroupBrowserOAuthClient` in
//    `flock-group-oauth:<viewerDid>` with non-extractable WebCrypto keys) + zero failed CORS preflights.
// 2. Cross-PDS invite delivery into Bob's personal `group.opensocial.invites/self` space & one-click acceptance.
// 3. `approval` join policy request (`joinMessage` -> `"Awaiting moderator approval"` -> Alice approves -> Cara admitted).
// 4. Group rules & moderation UI (`Report` -> `Moderation` queue -> `!hide` collapse/toggle & `!takedown` withholding).
// 5. Sign-out cleanup deleting `flock-group-oauth:<aliceDid>` & revoking browser Group OAuth session without touching Operator's grant.

const WORKSPACE_NAME = "OpenSocial Browser Group";
const HIDE_MESSAGE = "Minor spoiler message to hide behind moderation toggle";
const TAKEDOWN_MESSAGE = "Severe spam message to withhold via takedown";

test("OpenSocial groups in real browsers: dual-OAuth isolation, cross-PDS invites, approval join requests, moderation (!hide & !takedown), CORS preflights, and sign-out cleanup (R13 Gate 6)", { timeout: 600_000 }, async (t) => {
  const appPort = await availablePort();
  const operatorPort = await availablePort();
  const pds = await startPdsNetwork("opensocial-groups-browser", { appPort, operatorPort });
  let operator: AppServer | undefined;
  let app: AppServer | undefined;
  let browser: Browser | undefined;

  try {
    operator = await startOperatorServer();
    app = await startAppServer(appPort);

    const alice = await pds.createActor("osgalice", 0);
    const bob = await pds.createActor("osgbob", 1);
    const cara = await pds.createActor("osgcara", 1);

    browser = await chromium.launch({ headless: true });
    const aliceContext = await browser.newContext();
    const bobContext = await browser.newContext();
    const caraContext = await browser.newContext();
    const alicePage = await aliceContext.newPage();
    const bobPage = await bobContext.newPage();
    const caraPage = await caraContext.newPage();
    alicePage.setDefaultTimeout(45_000);
    bobPage.setDefaultTimeout(45_000);
    caraPage.setDefaultTimeout(45_000);

    const alicePreflights = await watchPreflights(alicePage);
    const bobPreflights = await watchPreflights(bobPage);
    const caraPreflights = await watchPreflights(caraPage);

    // -------------------------------------------------------------------------
    // 1. Alice signs in with personal BrowserOAuthClient, creates an `approval`
    //    workspace with `publicMeta = true`, and completes per-user Group OAuth.
    // -------------------------------------------------------------------------
    await signInToOnboarding(alicePage, app.url, alice);
    const personalBeforeGroupOAuth = await readPersonalOAuthSnapshot(alicePage, alice.did);
    assert.deepEqual(personalBeforeGroupOAuth.keys, [alice.did], "personal OAuth DB holds only Alice's personal DID");
    assert.equal(personalBeforeGroupOAuth.sub, alice.did);

    await alicePage.getByLabel("Workspace name").fill(WORKSPACE_NAME);
    await alicePage.getByLabel("Join policy").selectOption("approval");
    const publicMetaCheckbox = alicePage.locator("#workspace-public-meta");
    if (!(await publicMetaCheckbox.isChecked())) {
      await publicMetaCheckbox.check();
    }
    const workspaceForm = alicePage.locator("form").filter({ has: alicePage.getByLabel("Workspace name") });
    await workspaceForm.getByRole("button", { name: "Create workspace", exact: true }).click();
    await consent(alicePage, alice);
    await alicePage.getByRole("heading", { name: WORKSPACE_NAME, exact: true }).waitFor({ state: "visible" });
    await alicePage.getByText(/1 active members · 1 channels · join policy:\s*approval/i).waitFor({ state: "visible" });

    const workspaceUri = (await alicePage.locator(".welcome-banner .mono-note").innerText()).trim();
    const parsedWs = parseWorkspaceUri(workspaceUri);
    assert.ok(parsedWs && parsedWs.skey === "self", `expected canonical self workspace URI, got: ${workspaceUri}`);
    const groupDid = parsedWs.authorityDid;
    assert.notEqual(groupDid, alice.did, "workspace lives under a dedicated OpenSocial Group DID");

    // Complete per-user Group-DID OAuth (`GroupBrowserOAuthClient`) in `GroupGovernancePanel`.
    const governanceSection = alicePage.getByRole("region", { name: "OpenSocial group governance" });
    await governanceSection.getByRole("button", { name: "Sign in as group admin →" }).click();
    await consent(alicePage, alice);
    await governanceSection.getByRole("button", { name: "Disconnect group session", exact: true }).waitFor({ state: "visible" });

    // Verify Dual-OAuth IndexedDB & WebCrypto key isolation!
    const dualOAuthCheck = await alicePage.evaluate(async ({ viewerDid, expectedGroupDid }) => {
      const dbNames = (await indexedDB.databases()).map((d) => d.name ?? "");
      const personalDb = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open("@atproto-oauth-client");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const groupDb = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(`flock-group-oauth:${viewerDid}`);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        const personalKeys = await new Promise<string[]>((resolve, reject) => {
          const req = personalDb.transaction(["session"], "readonly").objectStore("session").getAllKeys();
          req.onsuccess = () => resolve(req.result.map(String));
          req.onerror = () => reject(req.error);
        });
        const personalEntry = await new Promise<{ value?: { tokenSet?: { sub?: string; access_token?: string } } }>((resolve, reject) => {
          const req = personalDb.transaction(["session"], "readonly").objectStore("session").get(viewerDid);
          req.onsuccess = () => resolve(req.result as { value?: { tokenSet?: { sub?: string; access_token?: string } } });
          req.onerror = () => reject(req.error);
        });
        const groupKeys = await new Promise<string[]>((resolve, reject) => {
          const req = groupDb.transaction(["session"], "readonly").objectStore("session").getAllKeys();
          req.onsuccess = () => resolve(req.result.map(String));
          req.onerror = () => reject(req.error);
        });
        const groupEntry = await new Promise<{
          value?: {
            dpopKey?: { keyId?: string; keyPair?: CryptoKeyPair };
            tokenSet?: { sub?: string; iss?: string };
          };
        }>((resolve, reject) => {
          const req = groupDb.transaction(["session"], "readonly").objectStore("session").get(expectedGroupDid);
          req.onsuccess = () => resolve(req.result as never);
          req.onerror = () => reject(req.error);
        });
        return {
          dbNames,
          personalKeys,
          personalSub: personalEntry?.value?.tokenSet?.sub,
          personalAccessToken: personalEntry?.value?.tokenSet?.access_token,
          groupKeys,
          groupSub: groupEntry?.value?.tokenSet?.sub,
          groupIss: groupEntry?.value?.tokenSet?.iss,
          privateKeyExtractable: groupEntry?.value?.dpopKey?.keyPair?.privateKey?.extractable,
          privateKeyType: groupEntry?.value?.dpopKey?.keyPair?.privateKey?.type,
        };
      } finally {
        personalDb.close();
        groupDb.close();
      }
    }, { viewerDid: alice.did, expectedGroupDid: groupDid });

    assert.ok(dualOAuthCheck.dbNames.includes("@atproto-oauth-client"));
    assert.ok(dualOAuthCheck.dbNames.includes(`flock-group-oauth:${alice.did}`));
    assert.deepEqual(dualOAuthCheck.personalKeys, [alice.did], "Group OAuth never writes into personal BrowserOAuthClient store");
    assert.equal(dualOAuthCheck.personalSub, alice.did);
    assert.equal(dualOAuthCheck.personalAccessToken, personalBeforeGroupOAuth.accessToken, "personal OAuth tokenSet untouched by Group OAuth");
    assert.deepEqual(dualOAuthCheck.groupKeys, [groupDid], "GroupBrowserOAuthClient stores groupDid in isolated IndexedDB");
    assert.equal(dualOAuthCheck.groupSub, groupDid);
    assert.equal(dualOAuthCheck.groupIss, new URL(pds.groupHostUrl).origin);
    assert.equal(dualOAuthCheck.privateKeyType, "private");
    assert.equal(dualOAuthCheck.privateKeyExtractable, false, "Group DPoP private key is non-extractable WebCrypto key");

    // -------------------------------------------------------------------------
    // 2. Cross-PDS invite delivery into Bob's `invites/self` inbox & acceptance
    // -------------------------------------------------------------------------
    await signInToOnboarding(bobPage, app.url, bob);

    await governanceSection.getByLabel("Cross-PDS invitee DID").fill(bob.did);
    await governanceSection.getByRole("button", { name: "Send cross-PDS invite →" }).click();
    await alicePage.getByText("Cross-PDS invitation written and queued for delivery.", { exact: true }).waitFor({ state: "visible" });

    // Flush Group Host outbox and verify `delivered` badge in Group Governance UI.
    await pds.groupHost.flushBackgroundWork();
    await governanceSection.getByRole("button", { name: "Sync group ↻" }).click();
    const deliveryRow = governanceSection.getByLabel("Invite delivery status").locator(".roster-row").filter({ hasText: bob.did });
    await deliveryRow.filter({ hasText: "delivered" }).waitFor({ state: "visible" });

    // Bob sees the Pending cross-PDS invitations card on his onboarding screen and accepts with one click.
    await bobPage.getByRole("button", { name: /Refresh/ }).click();
    const invitesCard = bobPage.getByRole("region", { name: "Cross-PDS invitations" });
    await invitesCard.waitFor({ state: "visible" });
    await invitesCard.getByText(WORKSPACE_NAME, { exact: true }).waitFor({ state: "visible" });
    await invitesCard.getByRole("button", { name: "Accept invite", exact: true }).click();
    await bobPage.getByRole("heading", { name: WORKSPACE_NAME, exact: true }).waitFor({ state: "visible" });
    await bobPage.getByText(/2 active members · 1 channels/).waitFor({ state: "visible" });

    // -------------------------------------------------------------------------
    // 3. `approval` join request (`joinMessage` -> pending -> Alice approves -> Cara admitted)
    // -------------------------------------------------------------------------
    await signInToOnboarding(caraPage, app.url, cara);
    await caraPage.getByLabel("Workspace URI").fill(groupDid);
    await caraPage.getByLabel("Join message (optional, for approval groups)").fill("Hi Alice, Cara requesting approval!");
    await caraPage.getByRole("button", { name: "Connect invitation", exact: true }).click();
    await caraPage.getByText("Join request submitted — awaiting moderator approval.", { exact: true }).waitFor({ state: "visible" });

    const joinStatusCard = caraPage.getByRole("region", { name: "Pending group join operations" });
    await joinStatusCard.filter({ hasText: "Awaiting moderator approval" }).waitFor({ state: "visible" });

    // Alice syncs Group Governance, sees Cara's join request and message, and clicks "Approve join".
    await governanceSection.getByRole("button", { name: "Sync group ↻" }).click();
    const caraJoinRow = governanceSection.locator(".roster-row").filter({ hasText: cara.did });
    await caraJoinRow.filter({ hasText: "Hi Alice, Cara requesting approval!" }).waitFor({ state: "visible" });
    await caraJoinRow.getByRole("button", { name: "Approve join", exact: true }).click();
    await alicePage.getByText(`Approved join request from ${cara.did}.`, { exact: true }).waitFor({ state: "visible" });

    // Cara refreshes and transitions cleanly from pending_approval to admitted member!
    await caraPage.getByRole("button", { name: /Refresh/ }).click();
    await caraPage.getByRole("heading", { name: WORKSPACE_NAME, exact: true }).waitFor({ state: "visible" });
    await caraPage.getByText(/3 active members · 1 channels/).waitFor({ state: "visible" });

    // -------------------------------------------------------------------------
    // 4. Group rules & Moderation UI (`Report` -> `!hide` toggle & `!takedown` withheld)
    // -------------------------------------------------------------------------
    const moderationSection = alicePage.getByRole("region", { name: "Group moderation" });
    await moderationSection.getByLabel("Rule title").fill("No spoilers or spam");
    await moderationSection.getByLabel("Rule description").fill("Keep spoilers tagged and never post spam in #general.");
    await moderationSection.getByRole("button", { name: "Add rule →" }).click();
    await alicePage.getByText("Group rule published.", { exact: true }).waitFor({ state: "visible" });

    // Bob posts two messages in #general from PDS 1.
    await openChannel(bobPage, "general");
    const bobComposer = bobPage.getByPlaceholder("Write a message…");
    await bobComposer.fill(HIDE_MESSAGE);
    await bobPage.getByRole("button", { name: "Send", exact: true }).click();
    await bobPage.locator(".message-card").filter({ hasText: HIDE_MESSAGE }).waitFor({ state: "visible" });
    await bobPage.waitForFunction(
      () => (document.querySelector('textarea[placeholder="Write a message…"]') as HTMLTextAreaElement | null)?.value === "",
    );

    await bobComposer.fill(TAKEDOWN_MESSAGE);
    await bobPage.getByRole("button", { name: "Send", exact: true }).click();
    await bobPage.locator(".message-card").filter({ hasText: TAKEDOWN_MESSAGE }).waitFor({ state: "visible" });

    // Cara opens #general and reports HIDE_MESSAGE via `Report` (`ReportSubjectButton`) using her personal-PDS session.
    await openChannel(caraPage, "general");
    await caraPage.getByRole("button", { name: "Sync ↻" }).click();
    const caraHideCard = caraPage.locator(".message-card").filter({ hasText: HIDE_MESSAGE });
    await caraHideCard.waitFor({ state: "visible" });
    const hideMessageUri = await caraHideCard.getAttribute("data-message-uri");
    assert.ok(hideMessageUri, "message card carries data-message-uri");

    await caraHideCard.getByRole("button", { name: "Report", exact: true }).click();
    await caraHideCard.getByLabel("Report reason").selectOption("rude");
    await caraHideCard.getByLabel("Report details").fill("Untagged spoiler in general");
    await caraHideCard.getByRole("button", { name: "Submit report", exact: true }).click();
    await caraPage.getByText("Report submitted to group moderators.", { exact: true }).waitFor({ state: "visible" });

    // Alice opens #general and reports TAKEDOWN_MESSAGE with `reasonType = "violation"` against the published group rule.
    await openChannel(alicePage, "general");
    await alicePage.getByRole("button", { name: "Sync ↻" }).click();
    const aliceTakedownCard = alicePage.locator(".message-card").filter({ hasText: TAKEDOWN_MESSAGE });
    await aliceTakedownCard.waitFor({ state: "visible" });
    const takedownMessageUri = await aliceTakedownCard.getAttribute("data-message-uri");
    assert.ok(takedownMessageUri, "takedown message card carries data-message-uri");

    await aliceTakedownCard.getByRole("button", { name: "Report", exact: true }).click();
    await aliceTakedownCard.getByLabel("Report reason").selectOption("violation");
    await aliceTakedownCard.getByLabel("Violated rule").waitFor({ state: "visible" });
    await aliceTakedownCard.getByLabel("Report details").fill("Severe rule-violating spam");
    await aliceTakedownCard.getByRole("button", { name: "Submit report", exact: true }).click();
    await alicePage.getByText("Report submitted to group moderators.", { exact: true }).waitFor({ state: "visible" });

    // Alice returns to Workspace Home, opens Moderation queue, applies `!hide` + `Resolve` and `!takedown` + `Resolve`.
    await alicePage.getByRole("button", { name: new RegExp(WORKSPACE_NAME) }).click();
    await moderationSection.getByRole("button", { name: "Refresh queue ↻" }).click();

    const hideModRow = moderationSection.locator(".roster-row").filter({ hasText: hideMessageUri });
    await hideModRow.waitFor({ state: "visible" });
    await hideModRow.getByRole("button", { name: "Apply !hide", exact: true }).click();
    await alicePage.getByText(`Published !hide label on ${hideMessageUri}.`, { exact: true }).waitFor({ state: "visible" });
    await hideModRow.getByRole("button", { name: "History", exact: true }).click();
    const auditHistory = moderationSection.getByLabel("Moderation subject history");
    await auditHistory.getByText(/!hide/).waitFor({ state: "visible" });
    await hideModRow.getByRole("button", { name: "Resolve", exact: true }).click();
    await alicePage.getByText("Marked moderation subject resolved.", { exact: true }).waitFor({ state: "visible" });

    const takedownModRow = moderationSection.locator(".roster-row").filter({ hasText: takedownMessageUri });
    await takedownModRow.waitFor({ state: "visible" });
    await takedownModRow.getByRole("button", { name: "Apply !takedown", exact: true }).click();
    await alicePage.getByText(`Published !takedown label on ${takedownMessageUri}.`, { exact: true }).waitFor({ state: "visible" });
    await takedownModRow.getByRole("button", { name: "Resolve", exact: true }).click();
    await alicePage.getByText("Marked moderation subject resolved.", { exact: true }).waitFor({ state: "visible" });

    await pds.groupHost.flushBackgroundWork();

    // Verify `!hide` collapse + `"Show"`/`"Hide"` toggle AND `!takedown` withholding in `ChannelView`!
    for (const viewerPage of [alicePage, caraPage]) {
      await openChannel(viewerPage, "general");
      await viewerPage.getByRole("button", { name: "Sync ↻" }).click();

      const hiddenCard = viewerPage.locator(`.message-card[data-message-uri="${hideMessageUri}"][data-hidden="true"]`);
      await hiddenCard.waitFor({ state: "visible" });
      await hiddenCard.getByText(/Hidden by group moderation/).waitFor({ state: "visible" });
      assert.equal(await viewerPage.getByText(HIDE_MESSAGE, { exact: true }).count(), 0, "!hide message text is collapsed by default");

      await hiddenCard.getByRole("button", { name: "Show", exact: true }).click();
      await hiddenCard.getByText(HIDE_MESSAGE, { exact: true }).waitFor({ state: "visible" });
      await hiddenCard.getByRole("button", { name: "Hide", exact: true }).click();
      assert.equal(await viewerPage.getByText(HIDE_MESSAGE, { exact: true }).count(), 0, "clicking Hide collapses message text again");

      assert.equal(
        await viewerPage.locator(`[data-message-uri="${takedownMessageUri}"]`).count(),
        0,
        "!takedown message is completely withheld from ChannelView",
      );
      assert.equal(await viewerPage.getByText(TAKEDOWN_MESSAGE, { exact: true }).count(), 0);
    }

    // -------------------------------------------------------------------------
    // 5. Verify zero failed CORS preflights across all origins!
    // -------------------------------------------------------------------------
    const allPreflights = [...alicePreflights, ...bobPreflights, ...caraPreflights];
    const preflightsByOrigin = countByOrigin(allPreflights);
    const failedPreflights = allPreflights.filter((pf) => !/^2\d\d$/.test(pf.outcome));
    t.diagnostic(`CORS preflights by origin: ${JSON.stringify(preflightsByOrigin)}`);
    assert.deepEqual(failedPreflights, [], `every CORS preflight succeeded: ${JSON.stringify(failedPreflights)}`);
    for (const expectedOrigin of [
      new URL(pds.groupHostUrl).origin,
      `http://localhost:${pds.groupHost.port}`,
      new URL(operator.url).origin,
      new URL(pds.hosts[0].url).origin,
      new URL(pds.hosts[1].url).origin,
    ]) {
      assert.ok((preflightsByOrigin[expectedOrigin] ?? 0) > 0, `expected CORS preflights to ${expectedOrigin}`);
    }

    // -------------------------------------------------------------------------
    // 6. Sign-out cleanup: deletes `flock-group-oauth:<aliceDid>` & revokes browser
    //    Group OAuth session without revoking Operator's `authority_grant`.
    // -------------------------------------------------------------------------
    const browserGroupSessionsBefore = pds.groupHost.db
      .prepare("SELECT COUNT(*) AS cnt FROM oauth_session WHERE group_did = ? AND client_id LIKE '%group-callback%'")
      .get(groupDid) as { cnt: number };
    assert.equal(browserGroupSessionsBefore.cnt, 1, "Alice's browser Group OAuth session is active on Group Host before sign-out");

    const handleField = alicePage.getByLabel("Your AT Protocol handle");
    await alicePage.getByRole("button", { name: "Sign out", exact: true }).click();
    await handleField.waitFor({ state: "visible" });

    const afterSignOutDbs = await alicePage.evaluate(async () => (await indexedDB.databases()).map((d) => d.name ?? ""));
    assert.ok(!afterSignOutDbs.includes(`flock-group-oauth:${alice.did}`), `flock-group-oauth DB deleted: ${afterSignOutDbs.join(", ")}`);
    assert.ok(!afterSignOutDbs.includes(`flock-sync-${alice.did}`), `flock-sync DB deleted: ${afterSignOutDbs.join(", ")}`);

    const browserGroupSessionsAfter = pds.groupHost.db
      .prepare("SELECT COUNT(*) AS cnt FROM oauth_session WHERE group_did = ? AND client_id LIKE '%group-callback%'")
      .get(groupDid) as { cnt: number };
    const operatorSessionsAfter = pds.groupHost.db
      .prepare("SELECT COUNT(*) AS cnt FROM oauth_session WHERE group_did = ? AND client_id LIKE '%authority%callback%'")
      .get(groupDid) as { cnt: number };
    assert.equal(browserGroupSessionsAfter.cnt, 0, "signing out revoked Alice's browser Group OAuth session on Group Host");
    assert.equal(operatorSessionsAfter.cnt, 1, "Operator's authority_grant session on Group Host remains intact");

    await alicePage.reload();
    await handleField.waitFor({ state: "visible" });
    assert.equal(await alicePage.locator(".app-frame").count(), 0, "Alice stays signed out after reload");

    await caraContext.close();
    await bobContext.close();
    await aliceContext.close();
  } finally {
    await browser?.close();
    await app?.stop();
    await operator?.stop();
    await pds.close();
  }
});

async function signInToOnboarding(page: Page, appUrl: string, actor: Pick<NetworkActor, "did" | "password">): Promise<void> {
  await page.goto(appUrl);
  await page.getByLabel("Your AT Protocol handle").fill(actor.did);
  await page.getByRole("button", { name: /Continue with atproto/i }).click();
  await consent(page, actor);
  await page.getByRole("heading", { name: "Create a workspace", exact: true }).waitFor({ state: "visible" });
}

async function readPersonalOAuthSnapshot(
  page: Page,
  did: string,
): Promise<{ keys: string[]; sub: string | undefined; accessToken: string | undefined }> {
  return page.evaluate(async (viewerDid) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("@atproto-oauth-client");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      const keys = await new Promise<string[]>((resolve, reject) => {
        const req = db.transaction(["session"], "readonly").objectStore("session").getAllKeys();
        req.onsuccess = () => resolve(req.result.map(String));
        req.onerror = () => reject(req.error);
      });
      const entry = await new Promise<{ value?: { tokenSet?: { sub?: string; access_token?: string } } }>((resolve, reject) => {
        const req = db.transaction(["session"], "readonly").objectStore("session").get(viewerDid);
        req.onsuccess = () => resolve(req.result as never);
        req.onerror = () => reject(req.error);
      });
      return {
        keys,
        sub: entry?.value?.tokenSet?.sub,
        accessToken: entry?.value?.tokenSet?.access_token,
      };
    } finally {
      db.close();
    }
  }, did);
}
