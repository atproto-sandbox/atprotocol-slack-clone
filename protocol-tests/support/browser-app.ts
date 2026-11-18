import type { Page } from "@playwright/test";
import type { NetworkActor } from "./pds-network";

// Driving this app's own pages in a real browser, for the specs and measurements that need the real client: signing in with
// the browser's one grant, and opening a channel.

/** Signs in on the app with the real browser client, through the PDS's pages, and waits for the workspace to show. */
export async function signIn(page: Page, appUrl: string, actor: NetworkActor, workspaceName: string): Promise<void> {
  await page.goto(appUrl);
  await page.getByLabel("Your AT Protocol handle").fill(actor.did);
  await page.getByRole("button", { name: /Continue with atproto/i }).click();
  await consent(page, actor);
  await page.getByRole("heading", { name: workspaceName, exact: true }).waitFor({ state: "visible" });
}

/** The PDS's consent page: sign in there if asked, then approve. */
export async function consent(page: Page, actor: NetworkActor): Promise<void> {
  await page.waitForURL(/\/oauth\/authorize\?/);
  const password = page.locator("input[name=password]");
  const authorize = page.getByRole("button", { name: "Authorize", exact: true });
  await password.or(authorize).first().waitFor({ state: "visible" });
  if (await password.isVisible()) {
    await password.fill(actor.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  await authorize.click();
}

/** Opens a channel from the sidebar and waits until no read of it is in flight. */
export async function openChannel(page: Page, name: string): Promise<void> {
  await page.locator(".channel-nav-item").filter({ hasText: name }).click();
  await page.getByRole("heading", { name: new RegExp(`${name}$`) }).waitFor({ state: "visible" });
  await page.locator('.message-list[aria-busy="false"]').waitFor({ state: "attached" });
}
