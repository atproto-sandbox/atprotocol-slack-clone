import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import Database from "better-sqlite3";
import type { OAuthSession } from "@atproto/oauth-client-node";
import { inviteLinkFor } from "@/app/ui/client-api";
import { pinnedCheckoutPath } from "../../protocol-tests/support/app-fixture";
import { completeConsent, escapeRegExp, eventually } from "./ui";
import type { Actor, ApiCall, AppWorld } from "./world";

// Helpers for scenarios that compare, attack or stress the app from outside: a second app instance viewed through
// its own browser context, journal rows only an outage could leave behind, and the delegated launch-envelope run.

/** One account signed in to one specific app instance, in its own browser context. */
export type AppViewer = Actor & { origin: string; requestUrls: string[] };

export type WorkspaceState = {
  uri: string;
  name: string;
  isAdmin: boolean;
  members: Array<{ did: string }>;
  admins: string[];
  channels: Array<{ skey: string; name: string; visibility: string }>;
};

export type WorkspaceObservation = {
  summary: string;
  directory: string[];
  state: { members: string[]; admins: string[]; channels: Array<{ skey: string; name: string; visibility: string }> };
  messages: Record<string, string[]>;
  privateRosters: Record<string, string[]>;
};

export function onPrimaryApp(world: AppWorld, actor: Actor): AppViewer {
  if ("origin" in actor) return actor as AppViewer;
  const viewer: AppViewer = Object.assign(actor, { origin: world.appOrigin, requestUrls: [] as string[] });
  actor.page.on("request", (request) => viewer.requestUrls.push(request.url()));
  return viewer;
}

export async function openViewer(world: AppWorld, account: Actor, origin: string, role: string): Promise<AppViewer> {
  const context = await world.newContext(role);
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const viewer: AppViewer = { ...account, role, context, page, calls: [], origin, requestUrls: [] };
  page.on("request", (request) => viewer.requestUrls.push(request.url()));
  world.recordCalls(viewer);
  world.actors.set(role, viewer);
  return viewer;
}

export async function waitForAppAt(viewer: AppViewer): Promise<void> {
  await viewer.page.waitForURL((url) => url.origin === viewer.origin && !url.pathname.startsWith("/oauth"), { timeout: 30_000 });
}

async function signInFromLoginFormAt(viewer: AppViewer): Promise<void> {
  await viewer.page.getByLabel("Your AT Protocol handle").fill(viewer.did);
  await viewer.page.getByRole("button", { name: /Continue with atproto/i }).click();
  await viewer.page.locator("input[name=password]").waitFor({ state: "visible" });
  await completeConsent(viewer);
  await waitForAppAt(viewer);
}

export async function signInAt(viewer: AppViewer): Promise<void> {
  await viewer.page.goto(viewer.origin);
  await signInFromLoginFormAt(viewer);
}

/** Opens the invite link as a person without a session would, signs in from it, and joins the workspace it names. */
export async function joinWorkspaceAt(viewer: AppViewer, workspaceUri: string, workspaceName: string): Promise<void> {
  await viewer.page.goto(inviteLinkFor(viewer.origin, workspaceUri));
  await viewer.page.getByText(/invited to a workspace/).waitFor({ state: "visible" });
  await signInFromLoginFormAt(viewer);
  await viewer.page.getByRole("region", { name: "Workspace invitation" }).getByRole("button", { name: "Join this workspace" }).click();
  await completeConsent(viewer);
  await waitForAppAt(viewer);
  await viewer.page.getByRole("heading", { name: workspaceName, exact: true }).waitFor({ state: "visible" });
}

export async function grantAdminControlsAt(viewer: AppViewer, workspaceName: string): Promise<void> {
  const card = viewer.page.getByRole("heading", { name: "Operator permissions" }).locator("xpath=ancestor::article");
  await card.getByRole("button", { name: /Grant admin controls/ }).click();
  await completeConsent(viewer);
  await waitForAppAt(viewer);
  await viewer.page.getByRole("heading", { name: workspaceName, exact: true }).waitFor({ state: "visible" });
}

/**
 * The owner approves workspace-authority permission on an app other than the one that created the workspace. The
 * create-workspace flow asks for it with this same request; there is no button for it afterwards.
 */
export async function grantWorkspaceAuthorityAt(viewer: AppViewer): Promise<void> {
  const granted = await viewer.page.evaluate(async (workspaceDid) => {
    const response = await fetch("/api/oauth/permission", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "workspaceAuthority", workspaceDid }) });
    return { status: response.status, body: await response.json() as { redirectUrl?: string } };
  }, viewer.did);
  assert.equal(granted.status, 200);
  assert.ok(granted.body.redirectUrl, "the app sends the owner to approve workspace-authority permission");
  await viewer.page.goto(granted.body.redirectUrl);
  await completeConsent(viewer);
  await waitForAppAt(viewer);
}

export async function createChannelAs(viewer: AppViewer, name: string, options: { privateMembers?: string[] } = {}): Promise<void> {
  const page = viewer.page;
  await page.getByLabel("Channel name").fill(name);
  if (options.privateMembers) {
    await page.getByLabel("Channel visibility").selectOption("private");
    await page.getByLabel("Private member DIDs").fill(options.privateMembers.join(", "));
  }
  await page.locator("form").filter({ has: page.getByLabel("Channel name") }).getByRole("button", { name: /Create channel/ }).click();
  await channelButton(viewer, name).waitFor({ state: "visible", timeout: 60_000 });
}

function channelButton(viewer: AppViewer, name: string) {
  return viewer.page.locator(".channel-nav-item").filter({ hasText: new RegExp(`^\\W*${escapeRegExp(name)}$`) });
}

async function callSince(viewer: AppViewer, since: number, path: string, skey?: string): Promise<ApiCall> {
  const forChannel = (call: ApiCall) => skey === undefined || new URLSearchParams(call.query).get("skey") === skey;
  return eventually(() => viewer.calls.slice(since).find((call) => call.path === path && forChannel(call)), { what: `${path} to be called${skey ? ` for ${skey}` : ""}` });
}

/** The channel key the app itself listed for this channel name, so a read in flight for the previously open channel is never mistaken for this one. */
async function channelSkeyOf(viewer: AppViewer, name: string): Promise<string> {
  return eventually(() => {
    for (const call of [...viewer.calls].reverse()) {
      if (call.path !== "/api/workspaces" || call.status !== 200 || !call.responseBody) continue;
      const listed = (JSON.parse(call.responseBody) as { workspaces: Array<{ channels: Array<{ skey: string; name: string }> }> }).workspaces
        .flatMap((workspace) => workspace.channels).find((channel) => channel.name === name);
      if (listed) return listed.skey;
    }
    return undefined;
  }, { what: `the app to list channel ${name}` });
}

/**
 * Opens a channel and waits for its first read, approving the PDS read permission when the app asks for it. Returns the
 * private roster the app fetched, or null for a public channel.
 */
export async function openChannelAndRead(viewer: AppViewer, name: string): Promise<string[] | null> {
  const button = channelButton(viewer, name);
  const isPrivate = (await button.innerText()).trim().startsWith("▣");
  const skey = await channelSkeyOf(viewer, name);
  const read = async (): Promise<{ failure?: ApiCall; roster: string[] | null }> => {
    const since = viewer.calls.length;
    await button.click();
    const messages = await callSince(viewer, since, "/api/channels/messages", skey);
    if (messages.status !== 200) return { failure: messages, roster: null };
    const delivered = (JSON.parse(messages.responseBody) as { messages: unknown[] }).messages.length;
    if (delivered > 0) await viewer.page.locator(".message-card").nth(delivered - 1).waitFor();
    if (!isPrivate) return { roster: null };
    const roster = await callSince(viewer, since, "/api/channels/roster", skey);
    if (roster.status !== 200) return { failure: roster, roster: null };
    return { roster: (JSON.parse(roster.responseBody) as { members: string[] }).members };
  };
  let result = await read();
  if (result.failure) {
    await viewer.page.getByRole("button", { name: "Grant channel read →" }).click();
    await completeConsent(viewer);
    await waitForAppAt(viewer);
    result = await read();
  }
  assert.equal(result.failure, undefined, `${name} could not be read: ${result.failure?.path} ${result.failure?.status} ${result.failure?.responseBody}`);
  return result.roster;
}

/** A member who is not on a private channel's roster asks for access, approving the write-only inbox permission on the way. */
export async function requestPrivateAccess(viewer: AppViewer, channelName: string): Promise<void> {
  const page = viewer.page;
  await channelButton(viewer, channelName).click();
  await page.getByText(/Grant workspace\/channel read scope/).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Request private access →" }).last().click();
  await page.getByText(/Grant write-only inbox access/).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Grant request access →" }).click();
  await completeConsent(viewer);
  await waitForAppAt(viewer);
  await page.getByText(/Grant workspace\/channel read scope/).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Request private access →" }).last().click();
  await page.getByText("Your access request is in the workspace inbox.", { exact: true }).waitFor({ state: "visible" });
}

export async function postMessage(viewer: AppViewer, text: string): Promise<void> {
  const page = viewer.page;
  const box = page.getByPlaceholder("Write a message…");
  const grant = page.getByRole("button", { name: "Grant message posting →" });
  const posted = page.locator(".message-card > p").filter({ hasText: text });
  await box.fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await grant.or(posted).first().waitFor();
  if (await grant.isVisible()) {
    await grant.click();
    await completeConsent(viewer);
    await waitForAppAt(viewer);
    await box.fill(text);
    await page.getByRole("button", { name: "Send", exact: true }).click();
  }
  await posted.waitFor();
}

export async function workspaceStateFor(viewer: AppViewer, workspaceName: string): Promise<WorkspaceState> {
  const listing = await viewer.page.evaluate(async () => (await fetch("/api/workspaces")).json()) as { workspaces: WorkspaceState[] };
  const found = listing.workspaces.find((workspace) => workspace.name === workspaceName);
  if (!found) throw new Error(`${viewer.origin} does not list ${workspaceName}`);
  return found;
}

/** What a person sees on this app: workspace home, the channel directory, and each named channel's messages and private roster. */
export async function observeWorkspace(viewer: AppViewer, workspaceName: string, channels: string[]): Promise<WorkspaceObservation> {
  const page = viewer.page;
  await page.goto(viewer.origin);
  await page.getByRole("heading", { name: workspaceName, exact: true }).waitFor({ state: "visible" });
  const summary = (await page.locator(".welcome-banner p").first().innerText()).trim();
  const directory = (await page.locator(".channel-nav-item").allInnerTexts()).map((entry) => entry.trim()).sort();
  const state = await workspaceStateFor(viewer, workspaceName);
  const messages: Record<string, string[]> = {};
  const privateRosters: Record<string, string[]> = {};
  for (const channel of channels) {
    const fetchedRoster = await openChannelAndRead(viewer, channel);
    const roster = page.locator(".private-roster p");
    if (fetchedRoster?.length) await roster.waitFor();
    messages[channel] = await page.locator(".message-card > p").allInnerTexts();
    privateRosters[channel] = await roster.count() === 0 ? [] : (await roster.innerText()).split(" · ").sort();
  }
  return {
    summary, directory, messages, privateRosters,
    state: {
      members: state.members.map((member) => member.did).sort(),
      admins: [...state.admins].sort(),
      channels: state.channels.map(({ skey, name, visibility }) => ({ skey, name, visibility })).sort((left, right) => left.name.localeCompare(right.name)),
    },
  };
}

/**
 * Runs `read` with the independent reader (src/reader/independent.ts) authenticated as `account`. The reader needs
 * only the account's credentials, the published lexicons and PDS space credentials; it has no database or cache.
 */
export async function withIndependentReader<T>(
  world: AppWorld,
  account: Actor,
  read: (reader: typeof import("@/reader/independent"), session: OAuthSession) => Promise<T>,
): Promise<T> {
  const environment: Record<string, string> = {
    APP_URL: world.appOrigin, PLC_URL: world.fixture.plcUrl, ATPROTO_ACCEPTANCE_TEST: "true",
    DATABASE_PATH: `${world.fixture.databasePath}.independent-reader-unused`, AUTH_ENCRYPTION_KEY: "7".repeat(64),
    OPERATOR_SERVICE_REF: `did:web:localhost%3A${world.fixture.appUrl.port}#atproto_slack_admin`,
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  try {
    const session = {
      did: account.did,
      fetchHandler: async (path: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        headers.set("authorization", `Bearer ${account.accessJwt}`);
        return fetch(new URL(path, account.pdsUrl), { ...init, headers, redirect: "error" });
      },
    } as unknown as OAuthSession;
    return await read(await import("@/reader/independent"), session);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

/** The repos that have written to a space, listed the way the app lists them: with a PDS-issued space credential. */
export async function listWriters(world: AppWorld, account: Actor, space: string): Promise<string[]> {
  return withIndependentReader(world, account, async (_reader, session) => {
    const [{ mintSpaceCredential }, { resolvePds }, { listBoundedRepos }] = await Promise.all([
      import("@/atproto/space-credential"), import("@/atproto/identity"), import("@/atproto/record-pages"),
    ]);
    const authorityDid = /^at:\/\/([^/]+)\//.exec(space)?.[1];
    assert.ok(authorityDid, `${space} is not a space URI`);
    const credential = await mintSpaceCredential(session, space);
    const scan = await listBoundedRepos(credential.client(await resolvePds(authorityDid)), { space, maxRepos: 500 });
    assert.equal(scan.truncated, false);
    return scan.repos.map((repo) => repo.did).sort();
  });
}

/** A journal row as a crashed runner leaves it, aged by `ageSeconds`. The app cannot be made to stall from a browser. */
export function insertJournalRow(world: AppWorld, row: {
  workspaceDid: string; workspaceUri: string; actor: string; operationId: string; requestHash: string; requestJson: string;
  state: "running" | "pending"; ageSeconds: number; error?: string;
}): number {
  const updatedAt = Math.floor(Date.now() / 1000) - row.ageSeconds;
  const db = new Database(world.fixture.databasePath, { fileMustExist: true });
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare(`INSERT INTO operation (workspace, workspace_uri, actor, operation_id, request_hash, request_json, state, steps_json, error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?)`)
      .run(row.workspaceDid, row.workspaceUri, row.actor, row.operationId, row.requestHash, row.requestJson, row.state, row.error ?? null, updatedAt, updatedAt);
    db.prepare("INSERT OR IGNORE INTO operation_workspace_catalog (workspace, workspace_uri) VALUES (?, ?)").run(row.workspaceDid, row.workspaceUri);
  } finally { db.close(); }
  return updatedAt;
}

export type ChildRun = { exitCode: number | null; output: string };

const children = new Set<ChildProcess>();

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
}

function killAllChildren(): void {
  for (const child of children) killGroup(child);
}

process.once("exit", killAllChildren);
for (const signal of ["SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => { killAllChildren(); process.kill(process.pid, signal); });
}

/**
 * Runs node with `args` as a child process and collects everything it prints. The child leads its own process group, which is
 * killed when `timeoutMs` passes (the run then rejects) and when this process is terminated, so nothing outlives the cucumber run.
 */
export function runNode(args: string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number; what: string }): Promise<ChildRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: process.cwd(), env: options.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    children.add(child);
    let output = "";
    const collect = (chunk: Buffer) => { output += chunk.toString("utf8"); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => { killGroup(child); reject(new Error(`${options.what} did not finish within ${options.timeoutMs} ms.\n${output.slice(-4_000)}`)); }, options.timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); children.delete(child); reject(error); });
    child.once("close", (exitCode) => { clearTimeout(timer); children.delete(child); resolve({ exitCode, output }); });
  });
}

/** Runs a protocol test file with `node --test` and collects its TAP output. */
export function runProtocolTest(file: string, timeoutMs: number): Promise<ChildRun> {
  return runNode(["--import", "tsx", "--test", file], { env: { ...process.env, ATPROTO_PINNED_CHECKOUT: pinnedCheckoutPath() }, timeoutMs, what: file });
}
