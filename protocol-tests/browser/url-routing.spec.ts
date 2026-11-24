import assert from "node:assert/strict";
import test from "node:test";
import { chromium, type Browser, type Page } from "@playwright/test";
import { createEngine } from "@flock/client/engine";
import { extSpaceUriFor } from "@flock/protocol/extensions";
import { channelUri, tidNow } from "@flock/protocol/keys";
import { COLLECTION, SPACE_TYPE } from "@flock/protocol/nsids";
import type { ShellLifecycleSnapshot } from "@flock/web/browser/shell-lifecycle";
import { availablePort, startAppServer, startOperatorServer, type AppServer } from "../support/app-server";
import { consent, openChannel } from "../support/browser-app";
import { actorTransport, createOpenSocialGroup, startPdsNetwork, type NetworkActor } from "../support/pds-network";
import { Probe } from "../support/sync-dataset";

const WORKSPACE_NAME = "Routing Workspace";

test("App Router URL routing, loopback normalization, returnTo OAuth lifecycle, legacy reconnect, Back/Forward shell persistence, and deep-route CSP (R11e / R13)", { timeout: 600_000 }, async () => {
  const appPort = await availablePort();
  const operatorPort = await availablePort();
  const pds = await startPdsNetwork("url-routing-browser", { appPort, operatorPort });
  let operator: AppServer | undefined;
  let app: AppServer | undefined;
  let browser: Browser | undefined;

  try {
    operator = await startOperatorServer();
    app = await startAppServer(appPort);

    const [
      { restoreAuthorityGrant },
      { grantCreationAuthorization },
      { createWorkspace },
      { registrationDeps },
      { parseWorkspaceRef },
    ] = await Promise.all([
      import("@flock/operator/operator/authority-grant"),
      import("@flock/operator/operator/creation-authorization"),
      import("@flock/operator/operator/kinds/create-workspace"),
      import("@flock/operator/operator/registrations"),
      import("@flock/operator/operator/actor"),
    ]);

    const alice = await pds.createActor("routealice", 0);
    const bob = await pds.createActor("routebob", 1);
    const createdGroup = await createOpenSocialGroup(pds, alice, {
      name: WORKSPACE_NAME,
      keyLabel: "route-authority",
    });
    const groupDid = createdGroup.groupDid;
    grantCreationAuthorization(
      { authorityDid: groupDid, initiatorDid: alice.did, name: WORKSPACE_NAME },
      Math.floor(Date.now() / 1000),
    );
    const created = await createWorkspace(
      await restoreAuthorityGrant(groupDid),
      { creator: alice.did, name: WORKSPACE_NAME, operationId: tidNow() },
      registrationDeps,
    );
    assert.equal(created.state, "completed");
    const workspaceUri = created.workspace;
    const workspaceSkey = parseWorkspaceRef(workspaceUri).skey;
    const generalSkey = created.channel.split("/").at(-1)!;
    const channelSelection = { workspace: workspaceUri, skey: generalSkey, name: "general", visibility: "public" };

    const aliceEngine = createEngine(actorTransport(pds, alice), {
      operator: { serviceRef: pds.serviceRef, endpoint: operator.url },
    });
    assert.equal((await aliceEngine.operator!.execute({
      workspace: workspaceUri,
      operationId: tidNow(),
      request: { kind: "inviteMember", subject: bob.did },
    })).operation.state, "completed");
    const bobEngine = createEngine(actorTransport(pds, bob), {
      operator: { serviceRef: pds.serviceRef, endpoint: operator.url },
    });
    await bobEngine.workspaces.accept(workspaceUri);
    assert.equal((await aliceEngine.operator!.enableExtension(workspaceUri, "tasks")).operation.state, "completed");
    assert.equal((await aliceEngine.operator!.execute({
      workspace: workspaceUri,
      operationId: tidNow(),
      request: { kind: "createChannel", skey: "random", name: "random", visibility: "public" },
    })).operation.state, "completed");
    assert.equal((await aliceEngine.operator!.execute({
      workspace: workspaceUri,
      operationId: tidNow(),
      request: { kind: "createChannel", skey: "archive", name: "archive", visibility: "public" },
    })).operation.state, "completed");

    // Seed channel messages (including older parent + reply), second channel, 610-message archive channel (>5 pages),
    // and a task + project for deep links.
    const randomSkey = "random";
    const archiveSkey = "archive";
    const randomSelection = { workspace: workspaceUri, skey: randomSkey, name: "random", visibility: "public" };
    const parentMsg = await aliceEngine.channels.send(channelSelection, "Root permalink message");
    await aliceEngine.channels.send(channelSelection, "Thread reply message", parentMsg.uri);
    const randomMsg = await aliceEngine.channels.send(randomSelection, "Channel B reply parent");

    const archiveSpace = channelUri(groupDid, archiveSkey);
    const aliceTransport = actorTransport(pds, alice);
    const baseMs = Date.now() - 100_000;
    const ancientRkey = tidNow(baseMs, 0);
    const archiveWrites = Array.from({ length: 610 }, (_, idx) => ({
      $type: "com.atproto.space.applyWrites#create",
      collection: COLLECTION.message,
      rkey: idx === 0 ? ancientRkey : tidNow(baseMs + idx, 0),
      value: {
        $type: COLLECTION.message,
        text: idx === 0 ? "Ancient 610th message" : `Archive message #${idx}`,
        createdAt: new Date(baseMs + idx).toISOString(),
      },
    }));
    for (let start = 0; start < archiveWrites.length; start += 200) {
      await aliceTransport.memberClient.procedure("com.atproto.space.applyWrites", {
        space: archiveSpace,
        repo: alice.did,
        writes: archiveWrites.slice(start, start + 200),
      });
    }
    await new Probe(pds, alice, archiveSpace).waitForCurrentRevision(alice.did);

    const projectRes = await aliceEngine.tasks.createProject(workspaceUri, { name: "Alpha Project" });
    const taskRes = await aliceEngine.tasks.createTask(workspaceUri, {
      title: "Deep link task",
      project: projectRes.uri,
      status: "in_progress",
      priority: "high",
    });

    // Establish a DM conversation between Alice and Bob for /dm/[convKey].
    const { DmClient } = await import("@flock/client/dm/dm-client");
    const bobDm = new DmClient({ ...actorTransport(pds, bob), store: inMemoryKv() });
    await bobDm.enableDms("everyone");
    const aliceDm = new DmClient({ ...actorTransport(pds, alice), store: inMemoryKv() });
    await aliceDm.enableDms("everyone");
    const startedDm = await aliceDm.startConversation([bob.did]);
    await aliceDm.send(startedDm.convKey, "DM deep link ping");

    const encAuth = encodeURIComponent(groupDid);
    const encWs = encodeURIComponent(workspaceSkey);
    const encCh = encodeURIComponent(generalSkey);
    const encRandom = encodeURIComponent(randomSkey);
    const encArchive = encodeURIComponent(archiveSkey);
    const encAlice = encodeURIComponent(alice.did);
    const parentRkey = parentMsg.uri.split("/").at(-1)!;
    const generalUrl = `${app.url}/w/${encAuth}/${encWs}/c/${encCh}`;
    const threadUrl = `${generalUrl}?thread=${encodeURIComponent(parentMsg.uri)}`;
    const randomUrl = `${app.url}/w/${encAuth}/${encWs}/c/${encRandom}`;
    const messagePermalinkUrl = `${app.url}/w/${encAuth}/${encWs}/c/${encCh}/m/${encAlice}/${encodeURIComponent(parentRkey)}`;
    const ancientPermalinkUrl = `${app.url}/w/${encAuth}/${encWs}/c/${encArchive}/m/${encAlice}/${encodeURIComponent(ancientRkey)}`;
    const missingPermalinkUrl = `${app.url}/w/${encAuth}/${encWs}/c/${encArchive}/m/${encAlice}/2222222222222`;
    const tasksDeepUrl = `${app.url}/w/${encAuth}/${encWs}/ext/tasks`;
    const projectDeepUrl = `${app.url}/w/${encAuth}/${encWs}/ext/tasks/p/${encAlice}/${encodeURIComponent(projectRes.rkey)}`;
    const taskDeepUrl = `${app.url}/w/${encAuth}/${encWs}/ext/tasks/t/${encAlice}/${encodeURIComponent(taskRes.rkey)}`;
    const boardDeepUrl = `${app.url}/w/${encAuth}/${encWs}/ext/tasks/board`;
    const activityDeepUrl = `${app.url}/w/${encAuth}/${encWs}/ext/tasks/activity`;
    const dmConvUrl = `${app.url}/dm/${encodeURIComponent(startedDm.convKey)}`;

    // 1. Loopback localhost -> 127.0.0.1 redirect preserving path & query and rejecting //evil.
    const localhostBase = app.url.replace("127.0.0.1", "localhost");
    const inviteQuery = `?invite=${encodeURIComponent(workspaceUri)}`;
    const inviteRes = await fetch(`${localhostBase}/${inviteQuery}`, { redirect: "manual" });
    assert.equal(inviteRes.status, 307);
    assert.equal(inviteRes.headers.get("location"), `${app.url}/${inviteQuery}`);

    const deepRedirectRes = await fetch(`${localhostBase}/w/did%3Aweb%3Alocalhost%253A3000/self/c/general?thread=at%3A%2F%2F1`, { redirect: "manual" });
    assert.equal(deepRedirectRes.status, 307);
    assert.equal(deepRedirectRes.headers.get("location"), `${app.url}/w/did%3Aweb%3Alocalhost%253A3000/self/c/general?thread=at%3A%2F%2F1`);

    // Next.js collapses leading repeated slashes (308 -> /evil.example/steal) before middleware; follow one hop
    // manually to confirm neither Next nor proxy ever emits a protocol-relative or off-origin redirect.
    const unsafeRedirectRes = await fetch(`${localhostBase}//evil.example/steal`, { redirect: "manual" });
    const firstLoc = unsafeRedirectRes.headers.get("location");
    assert.ok(firstLoc && !firstLoc.startsWith("//"), `unexpected protocol-relative redirect: ${firstLoc}`);
    const resolvedHop1 = new URL(firstLoc, localhostBase);
    assert.ok(resolvedHop1.origin === localhostBase || resolvedHop1.origin === app.url, `escaped loopback: ${resolvedHop1}`);
    const hop2Res = await fetch(resolvedHop1, { redirect: "manual" });
    if (resolvedHop1.origin === localhostBase) {
      assert.equal(hop2Res.status, 307);
      assert.equal(hop2Res.headers.get("location"), `${app.url}/evil.example/steal`);
    }

    browser = await chromium.launch({ headless: true });

    // 2. Signed-out cold deep link (?thread=...) -> OAuth sign-in -> returns to exact deep route.
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    await page.goto(threadUrl);
    await page.getByLabel("Your AT Protocol handle").fill(alice.did);
    await page.getByRole("button", { name: /Continue with atproto/i }).click();
    await consent(page, alice);
    await page.waitForURL(threadUrl, { timeout: 30_000 });
    await page.getByText("Root permalink message", { exact: true }).waitFor({ state: "visible" });
    await page.getByText(`Replying to ${parentMsg.uri}`).waitFor({ state: "visible" });

    // 3. Codex #13: True React/DOM & Engine/LiveSpaces persistence across channel -> permalink -> Tasks -> Board -> DMs -> Back/Forward.
    await page.waitForFunction(() => {
      const state = (window as unknown as { __flockShellLifecycle?: ShellLifecycleSnapshot }).__flockShellLifecycle;
      return Boolean(state?.gateToken && state?.engineToken && state?.liveToken);
    });
    const initialShell = await page.evaluate(
      () => ({ ...(window as unknown as { __flockShellLifecycle: ShellLifecycleSnapshot }).__flockShellLifecycle }),
    );
    assert.equal(initialShell.mountCount, 1);
    assert.equal(initialShell.unmountCount, 0);
    assert.equal(initialShell.sessionBuildCount, 1);
    const appFrameHandle = await page.evaluateHandle(() => document.querySelector(".app-frame"));
    const assertShellPersists = async (label: string) => {
      const currentShell = await page.evaluate(
        () => (window as unknown as { __flockShellLifecycle?: ShellLifecycleSnapshot }).__flockShellLifecycle,
      );
      assert.deepEqual(currentShell, initialShell, `${label}: shell mount/session/engine/live tokens must not change`);
      assert.equal(
        await appFrameHandle.evaluate((el) => el !== null && el === document.querySelector(".app-frame") && el.isConnected),
        true,
        `${label}: .app-frame DOM element must remain the exact same connected node`,
      );
    };

    const rootCard = page.locator(".message-card").filter({ hasText: "Root permalink message" }).first();
    await rootCard.getByRole("button", { name: "Link", exact: true }).click();
    await page.waitForURL(messagePermalinkUrl, { timeout: 30_000 });
    await page.locator('[data-highlighted="true"]').filter({ hasText: "Root permalink message" }).waitFor({ state: "visible" });
    await assertShellPersists("channel -> permalink");

    await page.getByRole("button", { name: "Tasks", exact: true }).click();
    await page.waitForURL(tasksDeepUrl, { timeout: 30_000 });
    await page.getByText("Deep link task", { exact: true }).waitFor({ state: "visible" });
    await assertShellPersists("permalink -> Tasks");

    await page.getByRole("tab", { name: "Board" }).click();
    await page.waitForURL(boardDeepUrl, { timeout: 30_000 });
    await page.getByRole("region", { name: "In progress" }).getByText("Deep link task", { exact: true }).waitFor({ state: "visible" });
    await assertShellPersists("Tasks -> Board");

    await page.getByRole("button", { name: /New message/ }).click();
    await page.waitForURL(`${app.url}/dm`, { timeout: 30_000 });
    await page.getByLabel("Participant DIDs").waitFor({ state: "visible" });
    await assertShellPersists("Board -> DMs");

    await page.goBack();
    await page.waitForURL(boardDeepUrl, { timeout: 30_000 });
    await page.getByRole("region", { name: "In progress" }).getByText("Deep link task", { exact: true }).waitFor({ state: "visible" });
    await assertShellPersists("Back -> Board");

    await page.goBack();
    await page.waitForURL(tasksDeepUrl, { timeout: 30_000 });
    await page.getByText("Deep link task", { exact: true }).waitFor({ state: "visible" });
    await assertShellPersists("Back -> Tasks");

    await page.goBack();
    await page.waitForURL(messagePermalinkUrl, { timeout: 30_000 });
    await page.locator('[data-highlighted="true"]').filter({ hasText: "Root permalink message" }).waitFor({ state: "visible" });
    await assertShellPersists("Back -> Permalink");

    await page.goBack();
    await page.waitForURL(threadUrl, { timeout: 30_000 });
    await page.getByText(`Replying to ${parentMsg.uri}`).waitFor({ state: "visible" });
    await assertShellPersists("Back -> Channel");

    await page.goForward();
    await page.waitForURL(messagePermalinkUrl, { timeout: 30_000 });
    await assertShellPersists("Forward -> Permalink");

    await page.goForward();
    await page.waitForURL(tasksDeepUrl, { timeout: 30_000 });
    await assertShellPersists("Forward -> Tasks");

    await page.goForward();
    await page.waitForURL(boardDeepUrl, { timeout: 30_000 });
    await assertShellPersists("Forward -> Board");

    await page.goForward();
    await page.waitForURL(`${app.url}/dm`, { timeout: 30_000 });
    await page.getByLabel("Participant DIDs").waitFor({ state: "visible" });
    await assertShellPersists("Forward -> DMs");
    await appFrameHandle.dispose();

    // 3b. Codex #8: Replying in Channel A -> Channel B (select reply) -> Browser Back to Channel A restores Channel A's thread state.
    await openChannel(page, "general");
    await page.waitForURL(generalUrl, { timeout: 30_000 });
    await page.locator(".message-card").filter({ hasText: "Root permalink message" }).first().getByRole("button", { name: "Reply", exact: true }).click();
    await page.waitForURL(threadUrl, { timeout: 30_000 });
    await page.getByText(`Replying to ${parentMsg.uri}`).waitFor({ state: "visible" });

    await openChannel(page, "random");
    await page.waitForURL(randomUrl, { timeout: 30_000 });
    assert.equal(await page.locator(".message-compose").getByText(/Replying to/).count(), 0);
    await page.locator(".message-card").filter({ hasText: "Channel B reply parent" }).first().getByRole("button", { name: "Reply", exact: true }).click();
    await page.waitForURL(`${randomUrl}?thread=${encodeURIComponent(randomMsg.uri)}`, { timeout: 30_000 });
    await page.getByText(`Replying to ${randomMsg.uri}`).waitFor({ state: "visible" });

    await page.goBack();
    await page.waitForURL(threadUrl, { timeout: 30_000 });
    await page.getByText(`Replying to ${parentMsg.uri}`).waitFor({ state: "visible" });
    assert.equal(await page.locator(".message-compose").getByText(randomMsg.uri).count(), 0, "Channel B reply target must not leak back into Channel A");

    await page.getByPlaceholder("Write a message…").fill("Back-to-A thread reply");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByText("Back-to-A thread reply", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await page.locator(".form-error").count(), 0);
    await page.waitForURL(generalUrl, { timeout: 30_000 });

    // Also verify plain Channel A (no thread) -> Channel B (select reply) -> Back to plain Channel A -> send succeeds top-level.
    await openChannel(page, "general");
    await page.waitForURL(generalUrl, { timeout: 30_000 });
    await openChannel(page, "random");
    await page.waitForURL(randomUrl, { timeout: 30_000 });
    await page.locator(".message-card").filter({ hasText: "Channel B reply parent" }).first().getByRole("button", { name: "Reply", exact: true }).click();
    await page.waitForURL(`${randomUrl}?thread=${encodeURIComponent(randomMsg.uri)}`, { timeout: 30_000 });
    await page.goBack();
    await page.waitForURL(generalUrl, { timeout: 30_000 });
    assert.equal(await page.locator(".message-compose").getByText(/Replying to/).count(), 0, "plain Channel A must not inherit Channel B reply");
    await page.getByPlaceholder("Write a message…").fill("Back-to-A top-level send");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByText("Back-to-A top-level send", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await page.locator(".form-error").count(), 0);

    // 4. Cold deep links & hard reloads: message permalink, >5-page older permalink & nonexistent permalink (Codex #9), project, task detail, activity, DM.
    await page.goto(messagePermalinkUrl);
    await page.locator('[data-highlighted="true"]').filter({ hasText: "Root permalink message" }).waitFor({ state: "visible" });
    await page.reload();
    await page.locator('[data-highlighted="true"]').filter({ hasText: "Root permalink message" }).waitFor({ state: "visible" });

    await page.goto(ancientPermalinkUrl);
    await page.locator('[data-highlighted="true"]').filter({ hasText: "Ancient 610th message" }).waitFor({ state: "visible" });
    assert.equal(await page.getByText("Loading linked message…").count(), 0, "older >5-page permalink resolves cleanly");

    await page.goto(missingPermalinkUrl);
    await page.getByText("The linked message was not found in this channel.", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await page.getByText("Loading linked message…").count(), 0, "nonexistent permalink must never stay stuck loading");

    await page.goto(projectDeepUrl);
    await page.getByRole("heading", { name: "Alpha Project", exact: true }).waitFor({ state: "visible" });
    await page.getByText("Deep link task", { exact: true }).waitFor({ state: "visible" });

    await page.goto(taskDeepUrl);
    await page.getByLabel("Task title").waitFor({ state: "visible" });
    assert.equal(await page.getByLabel("Task title").inputValue(), "Deep link task");
    await page.reload();
    assert.equal(await page.getByLabel("Task title").inputValue(), "Deep link task");

    await page.goto(activityDeepUrl);
    await page.getByLabel("Filter activity by kind").waitFor({ state: "visible" });

    await page.goto(dmConvUrl);
    await page.getByText("DM deep link ping", { exact: true }).waitFor({ state: "visible" });
    await page.reload();
    await page.getByText("DM deep link ping", { exact: true }).waitFor({ state: "visible" });

    // 5. Legacy browser session missing R11 Tasks scope -> "Connect this browser →" preserves deep returnTo.
    await stripScopeAndVerifyReconnect(page, alice, taskDeepUrl, `space:${SPACE_TYPE.tasks}`);
    await page.getByLabel("Task title").waitFor({ state: "visible" });
    assert.equal(page.url(), taskDeepUrl);

    // 6. returnTo open-redirect / OAuth-loop rejection on OAuthCallbackView.
    for (const malicious of ["https://evil.example/phish", "//evil.example/phish", "/oauth/callback", "/\\evil"]) {
      await page.evaluate((bad) => {
        sessionStorage.setItem("spaces.returnTo", bad);
      }, malicious);
      await page.goto(`${app.url}/oauth/callback`);
      await page.waitForURL(`${app.url}/`, { timeout: 30_000 });
      assert.equal(new URL(page.url()).origin, app.url);
    }

    // 7. CSP nonces & inline-script rejection on deep routes.
    const cspPage = await context.newPage();
    await cspPage.addInitScript(() => {
      const refused: string[] = [];
      Object.assign(window, { refused });
      document.addEventListener("securitypolicyviolation", (event) => refused.push(event.effectiveDirective));
    });
    const deepCspTarget = `${app.url}/w/${encAuth}/${encWs}/c/${encCh}`;
    const injected = `<script>window.injected = [...(window.injected ?? []), "script"]</script><img src="data:," onerror="window.injected = [...(window.injected ?? []), 'handler']">`;
    await cspPage.route(deepCspTarget, async (route) => {
      const response = await route.fetch();
      const csp = response.headers()["content-security-policy"] ?? "";
      assert.match(csp, /script-src 'self' 'nonce-[A-Za-z0-9+/]+={0,2}' 'strict-dynamic'/);
      await route.fulfill({ response, body: (await response.text()).replace("</body>", `${injected}</body>`) });
    });
    await cspPage.goto(deepCspTarget);
    await cspPage.waitForFunction(() => new Set((window as { refused?: string[] }).refused).size >= 2, undefined, { timeout: 10_000 }).catch(() => undefined);
    const cspOutcome = await cspPage.evaluate(() => ({
      ran: (window as { injected?: string[] }).injected ?? [],
      refused: [...new Set((window as { refused?: string[] }).refused ?? [])].sort(),
    }));
    assert.deepEqual(cspOutcome, { ran: [], refused: ["script-src-attr", "script-src-elem"] });
    await cspPage.close();

    // Ensure localhost browser navigation redirects to 127.0.0.1 preserving deep route.
    await page.goto(`${localhostBase}/w/${encAuth}/${encWs}/ext/tasks/board`);
    await page.waitForURL(boardDeepUrl, { timeout: 30_000 });
    await page.getByRole("region", { name: "In progress" }).getByText("Deep link task", { exact: true }).waitFor({ state: "visible" });

    assert.ok(extSpaceUriFor(groupDid, workspaceSkey, "tasks"));
    assert.ok(COLLECTION.task);
  } finally {
    await browser?.close();
    await app?.stop();
    await operator?.stop();
    await pds.close();
  }
});

async function stripScopeAndVerifyReconnect(page: Page, actor: NetworkActor, deepUrl: string, stripPrefix: string): Promise<void> {
  await page.goto(deepUrl);
  await page.evaluate(async ({ did, prefix }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("@atproto-oauth-client");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(["session"], "readwrite");
        const store = tx.objectStore("session");
        const getReq = store.get(did);
        getReq.onsuccess = () => {
          const entry = getReq.result as { value: { tokenSet: { scope: string } } };
          entry.value.tokenSet.scope = entry.value.tokenSet.scope
            .split(/\s+/)
            .filter((token) => !token.startsWith(prefix))
            .join(" ");
          store.put(entry, did);
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }, { did: actor.did, prefix: stripPrefix });

  await page.reload();
  const reconnectButton = page.locator(".permission-box").getByRole("button", { name: "Connect this browser →" });
  await reconnectButton.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(page.url(), deepUrl, "legacy reconnect prompt preserves deep route URL before click");
  await reconnectButton.click();
  await consent(page, actor);
  await page.waitForURL(deepUrl, { timeout: 30_000 });
}

function inMemoryKv() {
  const map = new Map<string, string>();
  return {
    get: async (key: string) => map.get(key) ?? null,
    set: async (key: string, value: string) => { map.set(key, value); },
    delete: async (key: string) => { map.delete(key); },
  };
}
