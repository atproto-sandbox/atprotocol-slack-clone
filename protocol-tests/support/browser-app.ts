import type { Page } from "@playwright/test";
import type { NetworkActor } from "./pds-network";

// Driving this app's own pages in a real browser, for the specs and measurements that need the real client: signing in with
// the browser's personal grant, completing Group Host multi-hop OAuth consent when creating/administering a group, and opening a channel.

/** Signs in on the app with the real browser client, through the PDS's pages, and waits for the workspace to show. */
export async function signIn(page: Page, appUrl: string, actor: Pick<NetworkActor, "did" | "password">, workspaceName: string): Promise<void> {
  await page.goto(appUrl);
  await page.getByLabel("Your AT Protocol handle").fill(actor.did);
  await page.getByRole("button", { name: /Continue with atproto/i }).click();
  await consent(page, actor);
  await page.getByRole("heading", { name: workspaceName, exact: true }).waitFor({ state: "visible" });
}

/**
 * Completes either a direct personal-PDS consent screen OR a Group Host multi-hop OAuth consent flow
 * (Group Host `/oauth/authorize` -> Personal PDS `/oauth/authorize` -> optional Group Host `/oauth/confirm-action`).
 */
export async function consent(
  page: Page,
  actor: Pick<NetworkActor, "did" | "password">,
  options: { decision?: "approve" | "deny"; denyStage?: "authorize" | "confirm" } = {},
): Promise<void> {
  await page.waitForURL(/\/oauth\/(?:authorize|confirm-action)/);

  const groupForm = page.getByTestId("group-oauth-authorize-form");
  const pdsPassword = page.locator("input[name=password]");
  const pdsAuthorize = page.getByRole("button", { name: "Authorize", exact: true });
  const groupConfirm = page.getByTestId("group-oauth-confirm-form");

  await groupForm.or(pdsPassword).or(pdsAuthorize).or(groupConfirm).first().waitFor({ state: "visible" });

  if (await groupForm.isVisible()) {
    if (options.decision === "deny" && options.denyStage !== "confirm") {
      await page.getByTestId("group-oauth-deny-button").click();
      return;
    }
    const actorInput = page.getByTestId("group-oauth-actor-input");
    await actorInput.fill(actor.did);
    await page.getByTestId("group-oauth-approve-button").click();

    // After Group Host redirects to Personal PDS, the PDS may either ask for password/Authorize OR auto-SSO straight back to Group Host / app!
    await page.waitForFunction(() => !document.querySelector('[data-testid="group-oauth-authorize-form"]'));
    await pdsPassword
      .or(pdsAuthorize)
      .or(groupConfirm)
      .or(page.locator("main"))
      .first()
      .waitFor({ state: "visible" });
  }

  if ((await pdsPassword.isVisible()) || (await pdsAuthorize.isVisible())) {
    if (await pdsPassword.isVisible()) {
      await pdsPassword.fill(actor.password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
    }
    if (options.decision === "deny" && options.denyStage !== "confirm" && !(await groupConfirm.isVisible())) {
      const rejectBtn = page.getByRole("button", { name: /Reject|Deny|Cancel/i }).first();
      await rejectBtn.click();
      return;
    }
    await pdsAuthorize.waitFor({ state: "visible" });
    await pdsAuthorize.click();

    // Wait briefly in case upstream redirects to Group Host `/oauth/confirm-action` before returning to the app
    await groupConfirm.or(page.locator("main")).first().waitFor({ state: "visible" });
  }

  if (await groupConfirm.isVisible()) {
    if (options.decision === "deny") {
      await page.getByTestId("group-oauth-confirm-deny").click();
    } else {
      await page.getByTestId("group-oauth-confirm-approve").click();
    }
  }
}

/** Opens a channel from the sidebar and waits until no read of it is in flight. */
export async function openChannel(page: Page, name: string): Promise<void> {
  await page.locator(".channel-nav-item").filter({ hasText: name }).click();
  await page.getByRole("heading", { name: new RegExp(`${name}$`) }).waitFor({ state: "visible" });
  await page.locator('.message-list[aria-busy="false"]').waitFor({ state: "attached" });
}
