import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import Database from "better-sqlite3";
import type { OAuthSession } from "@atproto/oauth-client-node";
import { inviteLinkFor } from "@/app/ui/client-api";
import { pinnedCheckoutPath } from "../../protocol-tests/support/app-fixture";
import { COLLECTION } from "@/protocol/nsids";
import { parseWorkspaceUri } from "@/protocol/keys";
import { listingCalls, openChannel, workspaceChannels } from "./channels-ui";
import { escapeRegExp, eventually, signInFromLoginFormAt, waitForOrigin } from "./ui";
import { PAGE_TIMEOUT_MS, type Actor, type AppWorld } from "./world";

// Helpers for scenarios that compare, attack or stress the app from outside: a second app instance viewed through
// its own browser context, journal rows only an outage could leave behind, and the delegated launch-envelope run.

/** One account signed in to one specific app instance, in its own browser context. */
export type AppViewer = Actor & { origin: string; requestUrls: string[] };

/** The workspace's roster, admins and channel directory as an app's page read them for itself. */
export type WorkspaceRead = { members: string[]; admins: string[]; channels: Array<{ skey: string; name: string; visibility: string }> };

/**
 * What a person sees of one workspace on one app (its summary line, its sidebar directory, and each channel opened), and the
 * roster and admins the page read to show it.
 */
export type WorkspaceObservation = {
  summary: string;
  state: WorkspaceRead;
  directory: Array<{ name: string; visibility: "public" | "private" }>;
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
  page.setDefaultTimeout(PAGE_TIMEOUT_MS);
  const viewer: AppViewer = { ...account, role, context, page, xrpc: [], origin, requestUrls: [] };
  page.on("request", (request) => viewer.requestUrls.push(request.url()));
  world.recordCalls(viewer);
  world.actors.set(role, viewer);
  return viewer;
}

export async function waitForAppAt(viewer: AppViewer): Promise<void> {
  await waitForOrigin(viewer, viewer.origin);
}


export async function signInAt(viewer: AppViewer): Promise<void> {
  await viewer.page.goto(viewer.origin);
  await signInFromLoginFormAt(viewer, viewer.origin);
}

/** Opens the invite link as a person without a session would, signs in from it, and joins the workspace it names. */
export async function joinWorkspaceAt(viewer: AppViewer, workspaceUri: string, workspaceName: string): Promise<void> {
  await viewer.page.goto(inviteLinkFor(viewer.origin, workspaceUri));
  await viewer.page.getByText(/invited to a workspace/).waitFor({ state: "visible" });
  await signInFromLoginFormAt(viewer, viewer.origin);
  // A member joins through the invitation. The workspace's own authority reads its workspace from sign-in, so there is
  // nothing to join and the workspace opens directly.
  const join = viewer.page.getByRole("region", { name: "Workspace invitation" }).getByRole("button", { name: "Join this workspace" });
  const opened = viewer.page.getByRole("heading", { name: workspaceName, exact: true });
  await join.or(opened).first().waitFor({ state: "visible" });
  if (await join.isVisible()) await join.click();
  await opened.waitFor({ state: "visible" });
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
  return workspaceChannels(viewer.page).filter({ hasText: new RegExp(`^\\W*${escapeRegExp(name)}$`) });
}

/** A member who is not on a private channel's roster asks for access from its roster card. */
export async function requestPrivateAccess(viewer: AppViewer, channelName: string): Promise<void> {
  const page = viewer.page;
  const offRoster = page.getByText("You are not on this channel’s active roster.");
  await channelButton(viewer, channelName).click();
  await offRoster.waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Request private access →" }).click();
  await page.getByText("Your access request is in the workspace inbox.", { exact: true }).waitFor({ state: "visible" });
}


/** What a person sees on this app: workspace home, the channel directory, and each named channel's messages and private roster. */
export async function observeWorkspace(viewer: AppViewer, workspaceName: string, channels: string[]): Promise<WorkspaceObservation> {
  const page = viewer.page;
  const since = viewer.xrpc.length;
  await page.goto(viewer.origin);
  await page.getByRole("heading", { name: workspaceName, exact: true }).waitFor({ state: "visible" });
  const summary = (await page.locator(".welcome-banner p").first().innerText()).trim();
  const workspaceUri = (await page.locator(".welcome-banner .mono-note").first().innerText()).trim();
  const state = await eventually(() => workspaceRead(viewer, workspaceUri, since), { what: `${viewer.origin} to read the workspace's roster and admins` });
  const directory = (await workspaceChannels(page).allInnerTexts()).map((entry) => entry.trim())
    .map((entry) => ({ name: entry.slice(1).trim(), visibility: entry.startsWith("▣") ? "private" as const : "public" as const }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const messages: Record<string, string[]> = {};
  const privateRosters: Record<string, string[]> = {};
  for (const channel of channels) {
    await openChannel(viewer, channel);
    const roster = page.locator(".private-roster p");
    messages[channel] = await page.locator(".message-card > p").allInnerTexts();
    privateRosters[channel] = await roster.count() === 0 ? [] : (await roster.innerText()).split(" · ").sort();
  }
  return { summary, state, directory, messages, privateRosters };
}

/**
 * The workspace's roster, admins and directory as the account's page read them since `since` (an index into its XRPC calls),
 * from the newest complete listing of each the browser made itself: active subjects, and the channels not archived;
 * undefined until it has made one of each. Asserts the page listed them only from the authority's own repo.
 */
export function workspaceRead(viewer: Actor, workspaceUri: string, since = 0): WorkspaceRead | undefined {
  const authority = parseWorkspaceUri(workspaceUri)?.authorityDid;
  type Listed = { value: Record<string, unknown> };
  const read = (collection: string): Listed[] | undefined => {
    const listings = listingCalls(viewer, collection, since).filter(({ call, query }) => call.status === 200 && call.body === "recorded" && query.get("space") === workspaceUri);
    const start = listings.map(({ query }) => query.get("cursor")).lastIndexOf(null);
    if (start < 0) return undefined;
    const pages = listings.slice(start).map(({ call, query }) => ({ query, body: JSON.parse(call.responseBody) as { cursor?: string; records: Listed[] } }));
    if (pages.at(-1)?.body.cursor !== undefined) return undefined;
    assert.deepEqual([...new Set(pages.map(({ query }) => query.get("repo")))], [authority], `the app read ${collection} only from the workspace authority's repo`);
    return pages.flatMap(({ body }) => body.records);
  };
  const activeSubjects = (records: Listed[]) => records.filter((record) => record.value.active === true).map((record) => String(record.value.subject)).sort();
  const [roster, adminRecords, directory] = [read(COLLECTION.workspaceRoster), read(COLLECTION.admin), read(COLLECTION.directory)];
  if (!roster || !adminRecords || !directory) return undefined;
  return {
    members: activeSubjects(roster),
    admins: activeSubjects(adminRecords),
    channels: directory.filter((record) => record.value.visibility !== "archived")
      .map(({ value }) => ({ skey: String(value.skey), name: String(value.name), visibility: String(value.visibility) }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

/**
 * Runs `read` with the independent reader (src/reader/independent.ts) authenticated as `account`. The reader needs
 * only the account's credentials, the published lexicons and PDS space credentials; it has no database or cache.
 */
export async function withIndependentReader<T>(
  world: AppWorld,
  account: Actor,
  read: (reader: typeof import("@/reader/independent"), deps: import("@/reader/independent").IndependentDeps, session: OAuthSession) => Promise<T>,
): Promise<T> {
  const environment: Record<string, string> = {
    APP_URL: world.appOrigin, PLC_URL: world.fixture.plcUrl, ATPROTO_ACCEPTANCE_TEST: "true",
    DATABASE_PATH: `${world.fixture.databasePath}.independent-reader-unused`, AUTH_ENCRYPTION_KEY: "7".repeat(64),
    OPERATOR_SERVICE_REF: `did:web:localhost%3A${world.fixture.appUrl.port}#atproto_flock_operator`,
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
    const { sessionCredentialDeps } = await import("@/atproto/space-credential");
    return await read(await import("@/reader/independent"), sessionCredentialDeps(session), session);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

/** The repos that have written to a space, listed the way the app lists them: with a PDS-issued space credential. */
export async function listWriters(world: AppWorld, account: Actor, space: string): Promise<string[]> {
  return withIndependentReader(world, account, async (_reader, _deps, session) => {
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
