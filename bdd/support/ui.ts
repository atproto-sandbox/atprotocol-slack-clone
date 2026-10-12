import type { Actor, AppWorld } from "./world";

// Each helper is one thing a person does in the app. They drive the real UI against the real PDS fixture, so a
// scenario that passes proves the journey works for a user, not just that the underlying calls succeed.

export const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Polls until `read` returns something truthy, so steps wait on observable facts instead of fixed sleeps. */
export async function eventually<T>(read: () => T | undefined | null | false, options: { timeoutMs?: number; what?: string } = {}): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
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

/** Waits until the browser is back on the app (not on the PDS consent screen or an OAuth route). */
export async function waitForApp(world: AppWorld, actor: Actor): Promise<void> {
  await actor.page.waitForURL((url) => url.origin === world.appOrigin && !url.pathname.startsWith("/oauth"), { timeout: 30_000 });
}

export async function signInIfPrompted(actor: Actor): Promise<void> {
  const password = actor.page.locator("input[name=password]");
  if (!await password.isVisible().catch(() => false)) return;
  const username = actor.page.locator("input[name=username]");
  if (await username.isVisible().catch(() => false) && !await username.inputValue()) await username.fill(actor.handle);
  await password.fill(actor.password);
  await actor.page.getByRole("button", { name: "Sign in", exact: true }).click();
}

/** The PDS consent screen: sign in there if asked, then approve or decline. */
export async function completeConsent(actor: Actor, decision: "authorize" | "deny" = "authorize"): Promise<void> {
  await actor.page.waitForURL(/\/oauth\/authorize\?/, { timeout: 30_000 });
  await signInIfPrompted(actor);
  const button = actor.page.getByRole("button", { name: decision === "authorize" ? "Authorize" : "Deny access", exact: true });
  await button.waitFor({ state: "visible" });
  await button.click();
}

/** From the app's sign-in page: enter the DID and approve the PDS's first-time consent. */
export async function signInFromLoginForm(world: AppWorld, actor: Actor): Promise<void> {
  await actor.page.getByLabel("Your AT Protocol handle").fill(actor.did);
  await actor.page.getByRole("button", { name: /Continue with atproto/i }).click();
  await actor.page.locator("input[name=password]").waitFor({ state: "visible" });
  await completeConsent(actor);
  await waitForApp(world, actor);
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

export async function approveAdminControls(world: AppWorld, actor: Actor): Promise<void> {
  const card = actor.page.getByRole("heading", { name: "Operator permissions" }).locator("xpath=ancestor::article");
  await card.getByRole("button", { name: /Grant admin controls/ }).click();
  await completeConsent(actor);
  await waitForApp(world, actor);
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

export async function joinFromInvitation(world: AppWorld, actor: Actor): Promise<void> {
  await actor.page.getByRole("region", { name: "Workspace invitation" }).getByRole("button", { name: "Join this workspace" }).click();
  await completeConsent(actor);
  await waitForApp(world, actor);
}

/** The shared set-up of most invitation scenarios: an owner with admin controls who has added `invitee`. */
export async function ownerInvites(world: AppWorld, inviteeRole: string, options: { inviteeHost?: 0 | 1; ownerHost?: 0 | 1 } = {}): Promise<{ owner: Actor; invitee: Actor }> {
  const owner = await world.actor("owner", options.ownerHost ?? 0);
  await createWorkspaceAs(world, owner);
  await approveAdminControls(world, owner);
  const invitee = await world.actor(inviteeRole, options.inviteeHost ?? 1);
  await inviteMemberAs(owner, invitee.did);
  return { owner, invitee };
}
