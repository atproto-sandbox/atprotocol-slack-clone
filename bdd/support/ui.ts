import { PAGE_TIMEOUT_MS, type Actor, type AppWorld } from "./world";

// Each helper is one thing a person does in the app. They drive the real UI against the real PDS fixture, so a
// scenario that passes proves the journey works for a user, not just that the underlying calls succeed.

export const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Polls until `read` returns something truthy, so steps wait on observable facts instead of fixed sleeps. */
export async function eventually<T>(read: () => T | undefined | null | false, options: { timeoutMs?: number; what?: string } = {}): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? PAGE_TIMEOUT_MS);
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${options.what ?? "a condition"}.`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export function uniqueWorkspaceName(): string {
  return `Team ${Math.random().toString(36).slice(2, 8)}`;
}

/** Waits until the browser is back on the app (not on the PDS consent screen, an OAuth route or the browser session's callback). */
export async function waitForApp(world: AppWorld, actor: Actor): Promise<void> {
  await waitForOrigin(actor, world.appOrigin);
}

export async function waitForOrigin(actor: Actor, origin: string): Promise<void> {
  await actor.page.waitForURL((url) => url.origin === origin && !url.pathname.startsWith("/oauth"), { timeout: 60_000 });
}

/**
 * From the sign-in form of the app at `origin`: enters the actor's DID, signs in at its host and approves the app's one grant
 * (its workspaces, channels and DMs, and the operator's methods), then waits until the app reads through the browser's
 * session. Returns the scopes the consent screen listed.
 */
export async function signInFromLoginFormAt(actor: Actor, origin: string): Promise<string[]> {
  await actor.page.getByLabel("Your AT Protocol handle").fill(actor.did);
  await actor.page.getByRole("button", { name: /Continue with atproto/i }).click();
  await actor.page.waitForURL(/\/oauth\/authorize\?/, { timeout: 30_000 });
  const authorize = actor.page.getByRole("button", { name: "Authorize", exact: true });
  await actor.page.locator("input[name=password]").or(authorize).first().waitFor({ state: "visible" });
  await signInIfPrompted(actor);
  await authorize.waitFor({ state: "visible" });
  const shown = await actor.page.evaluate(() => (window as unknown as { __authorizeData?: { scope?: string } }).__authorizeData?.scope ?? "");
  await authorize.click();
  await waitForOrigin(actor, origin);
  await actor.page.locator(".app-frame").waitFor({ state: "attached", timeout: 60_000 });
  await actor.page.locator(".permission-box").filter({ hasText: /Connect this browser|Connecting this browser/ }).waitFor({ state: "detached", timeout: 60_000 });
  return shown.split(" ").filter(Boolean);
}

export async function signInIfPrompted(actor: Actor): Promise<void> {
  const password = actor.page.locator("input[name=password]");
  if (!await password.isVisible().catch(() => false)) return;
  const username = actor.page.locator("input[name=username]");
  if (await username.isVisible().catch(() => false) && !await username.inputValue()) await username.fill(actor.handle);
  await password.fill(actor.password);
  await actor.page.getByRole("button", { name: "Sign in", exact: true }).click();
}

/**
 * Completes either a direct personal-PDS consent screen OR a Group Host multi-hop OAuth consent flow
 * (Group Host `/oauth/authorize` -> Personal PDS `/oauth/authorize` -> optional Group Host `/oauth/confirm-action`).
 */
export async function completeConsent(actor: Actor, decision: "authorize" | "deny" = "authorize"): Promise<void> {
  const { page } = actor;
  await page.waitForURL(/\/oauth\/(?:authorize|confirm-action)/, { timeout: 30_000 });

  const groupForm = page.getByTestId("group-oauth-authorize-form");
  const pdsPassword = page.locator("input[name=password]");
  const pdsAuthorize = page.getByRole("button", { name: "Authorize", exact: true });
  const groupConfirm = page.getByTestId("group-oauth-confirm-form");

  await groupForm.or(pdsPassword).or(pdsAuthorize).or(groupConfirm).first().waitFor({ state: "visible" });

  if (await groupForm.isVisible()) {
    if (decision === "deny") {
      await page.getByTestId("group-oauth-deny-button").click();
      return;
    }
    await page.getByTestId("group-oauth-actor-input").fill(actor.did);
    await page.getByTestId("group-oauth-approve-button").click();

    await page.waitForFunction(() => !document.querySelector('[data-testid="group-oauth-authorize-form"]'));
    await pdsPassword
      .or(pdsAuthorize)
      .or(groupConfirm)
      .or(page.locator("main"))
      .first()
      .waitFor({ state: "visible" });
  }

  if ((await pdsPassword.isVisible()) || (await pdsAuthorize.isVisible())) {
    await signInIfPrompted(actor);
    if (decision === "deny" && !(await groupConfirm.isVisible())) {
      const denyButton = page.getByRole("button", { name: "Deny access", exact: true }).or(
        page.getByRole("button", { name: /Reject|Deny|Cancel/i }),
      ).first();
      await denyButton.waitFor({ state: "visible" });
      await denyButton.click();
      return;
    }
    await pdsAuthorize.waitFor({ state: "visible" });
    await pdsAuthorize.click();

    await groupConfirm.or(page.locator("main")).first().waitFor({ state: "visible" });
  }

  if (await groupConfirm.isVisible()) {
    if (decision === "deny") {
      await page.getByTestId("group-oauth-confirm-deny").click();
    } else {
      await page.getByTestId("group-oauth-confirm-approve").click();
    }
  }
}

/**
 * The PDS consent screen in `actor`'s browser, approved by signing in there as `account`: a dedicated workspace account
 * approving the operator's grant from someone else's browser. It never visits the web app.
 */
export async function approveConsentAs(actor: Actor, account: Actor): Promise<void> {
  const { page } = actor;
  await page.waitForURL(/\/oauth\/authorize\?/, { timeout: 30_000 });
  const authorize = page.getByRole("button", { name: "Authorize", exact: true });
  const password = page.locator("input[name=password]");
  await password.or(authorize).first().waitFor({ state: "visible" });
  if (await password.isVisible()) {
    // The flow names the account it is for, so the host may show its username already filled and fixed.
    const username = page.locator("input[name=username]");
    if (await username.isEditable().catch(() => false) && !await username.inputValue()) await username.fill(account.handle);
    await password.fill(account.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  await authorize.waitFor({ state: "visible" });
  await authorize.click();
}

/** Signs `actor` out with the app's sign-out control, and waits for the sign-in form. */
export async function signOutAs(actor: Actor): Promise<void> {
  await actor.page.getByRole("button", { name: "Sign out", exact: true }).click();
  await actor.page.getByLabel("Your AT Protocol handle").waitFor({ state: "visible", timeout: 60_000 });
}

/** From the app's sign-in page: enter the DID and approve the app's one grant at the account's host. */
export async function signInFromLoginForm(world: AppWorld, actor: Actor): Promise<void> {
  await signInFromLoginFormAt(actor, world.appOrigin);
}

export async function signIn(world: AppWorld, actor: Actor): Promise<void> {
  await actor.page.goto(world.appOrigin);
  await signInFromLoginForm(world, actor);
}

export function workspaceNameForm(actor: Actor) {
  return actor.page.locator("form").filter({ has: actor.page.getByLabel("Workspace name") });
}

export async function submitWorkspaceName(actor: Actor, name: string): Promise<void> {
  await actor.page.getByLabel("Workspace name").fill(name);
  await workspaceNameForm(actor).getByRole("button", { name: "Create workspace", exact: true }).click();
}

export async function workspaceUriOnPage(actor: Actor): Promise<string> {
  const text = await actor.page.locator(".mono-note").filter({ hasText: "at://" }).first().innerText();
  return text.trim();
}

/** Signs in and creates a workspace the way a first-time owner does: one click, then approve. */
export async function createWorkspaceAs(world: AppWorld, actor: Actor, name = uniqueWorkspaceName()): Promise<void> {
  await signIn(world, actor);
  await submitWorkspaceName(actor, name);
  await completeConsent(actor);
  await waitForApp(world, actor);
  await actor.page.getByRole("heading", { name, exact: true }).waitFor({ state: "visible" });
  world.workspaceName = name;
  world.workspaceUri = await workspaceUriOnPage(actor);
}

/**
 * Waits until an admin's controls are live: the admin inbox has been read. The browser session's one grant carries the
 * operator's methods, so there is nothing more to approve.
 */
export async function waitForAdminControls(world: AppWorld, actor: Actor): Promise<void> {
  await actor.page.getByRole("heading", { name: world.workspaceName, exact: true }).waitFor({ state: "visible" });
  await actor.page.getByText("No pending join requests.").waitFor({ state: "visible" });
}

export async function inviteMemberAs(actor: Actor, did: string): Promise<void> {
  await actor.page.getByLabel("Member DID", { exact: true }).fill(did);
  await actor.page.getByRole("button", { name: /Invite member/ }).click();
  await actor.page.getByText(new RegExp(`Added ${escapeRegExp(did)}`)).waitFor({ state: "visible", timeout: 60_000 });
}

export async function copyInviteLink(actor: Actor): Promise<string> {
  await actor.page.getByRole("button", { name: "Copy invite link", exact: true }).click();
  await actor.page.getByText(/Invite link copied/).waitFor({ state: "visible" });
  return actor.page.evaluate(() => navigator.clipboard.readText());
}

/** Opens an invite link and signs in from the page it lands on, as a person who has no session yet would. */
export async function openInviteLinkAndSignIn(world: AppWorld, actor: Actor, link: string): Promise<void> {
  await actor.page.goto(link);
  await actor.page.getByText(/invited to a workspace/).waitFor({ state: "visible" });
  await signInFromLoginForm(world, actor);
}

/** Joins from the invitation banner: the browser writes the acceptance record with the session's grant, no consent screen. */
export async function joinFromInvitation(actor: Actor): Promise<void> {
  await actor.page.getByRole("region", { name: "Workspace invitation" }).getByRole("button", { name: "Join this workspace" }).click();
}

/** The shared set-up of most invitation scenarios: an owner with admin controls who has added `invitee`. */
export async function ownerInvites(world: AppWorld, inviteeRole: string, options: { inviteeHost?: 0 | 1; ownerHost?: 0 | 1 } = {}): Promise<{ owner: Actor; invitee: Actor }> {
  const owner = await world.actor("owner", options.ownerHost ?? 0);
  await createWorkspaceAs(world, owner);
  await waitForAdminControls(world, owner);
  const invitee = await world.actor(inviteeRole, options.inviteeHost ?? 1);
  await inviteMemberAs(owner, invitee.did);
  return { owner, invitee };
}
