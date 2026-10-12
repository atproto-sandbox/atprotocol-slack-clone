import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JoseKey } from "@atproto/jwk-jose";
import type { Locator } from "@playwright/test";
import Database from "better-sqlite3";
import { inviteLinkFor } from "@/app/ui/client-api";
import { AtprotoClient, XrpcError } from "@/atproto/xrpc";
import { mintSpaceCredentialWith, SpaceCredential, SpaceCredentialError } from "@/atproto/space-credential-core";
import { inboxUri, subjectKey } from "@/protocol/keys";
import type { Actor, AppWorld } from "./world";
import {
  approveAdminControls, completeConsent, createWorkspaceAs, escapeRegExp, eventually, inviteMemberAs,
  joinFromInvitation, openInviteLinkAndSignIn, waitForApp,
} from "./ui";

// Helpers for the membership, privacy and archive lifecycle scenarios: what a person does in the app, plus the
// independent PDS, credential and journal observations the lifecycle claims are checked against.

export type Member = { did: string; read: boolean; write: boolean };
export type ChannelRef = { name: string; skey: string; uri: string; visibility: string };
export type OperationView = { operationId: string; requestHash: string; state: string; completedSteps: string[]; error?: string; updatedAt: string };
export type Executed = { status: number; operationId: string; request: Record<string, unknown>; operation?: OperationView; error?: string };
export type JournalEntry = {
  operationId: string; workspace: string; workspaceUri: string | null; actor: string; requestHash: string; state: string; steps: string[];
  error: string | null; request: Record<string, unknown>; createdAt: number; updatedAt: number;
};
export type AuditEvent = { id: number; actor: string; event: string };

export const MAX_CREDENTIAL_LIFETIME_SECONDS = 2 * 60 * 60;

export function remember<T>(world: AppWorld, key: string, value: T): T {
  world.scratch.set(key, value);
  return value;
}

export function recall<T>(world: AppWorld, key: string): T {
  assert.ok(world.scratch.has(key), `this scenario has not recorded "${key}" yet`);
  return world.scratch.get(key) as T;
}

export function actorNamed(world: AppWorld, role: string): Actor {
  const actor = world.actors.get(role);
  assert.ok(actor, `this scenario has no ${role} yet`);
  return actor;
}

export const workspaceSkey = (world: AppWorld): string => world.workspaceUri.split("/").at(-1)!;
export const inboxOf = (world: AppWorld): string => inboxUri(actorNamed(world, "owner").did, workspaceSkey(world));

// --- Independent observations of the PDS -------------------------------------------------------------

export async function membersOf(world: AppWorld, as: Actor, space: string): Promise<Member[]> {
  const result = await world.pdsGet<{ members?: Member[] }>(as, "com.atproto.simplespace.listMembers", { space, limit: "1000" });
  assert.equal(result.status, 200, `listMembers ${space}: ${JSON.stringify(result.body)}`);
  return result.body.members ?? [];
}

export async function memberAccess(world: AppWorld, as: Actor, space: string, did: string): Promise<{ read: boolean; write: boolean } | undefined> {
  const member = (await membersOf(world, as, space)).find((entry) => entry.did === did);
  return member && { read: member.read, write: member.write };
}

export async function authorityRecord(world: AppWorld, owner: Actor, space: string, collection: string, rkey: string): Promise<Record<string, unknown> | undefined> {
  const result = await world.pdsGet<{ value?: Record<string, unknown>; error?: string }>(owner, "com.atproto.space.getRecord", { space, repo: owner.did, collection, rkey });
  if (result.status === 200) return result.body.value;
  assert.ok(result.status < 500, `getRecord ${collection}/${rkey}: ${JSON.stringify(result.body)}`);
  return undefined;
}

export async function subjectRecordActive(world: AppWorld, owner: Actor, space: string, collection: string, did: string): Promise<boolean | undefined> {
  const value = await authorityRecord(world, owner, space, collection, subjectKey(did));
  return value === undefined ? undefined : value.active === true;
}

export async function directory(world: AppWorld, owner: Actor): Promise<ChannelRef[]> {
  const result = await world.pdsGet<{ records?: Array<{ value: { skey: string; name: string; visibility: string } }> }>(
    owner, "com.atproto.space.listRecords", { space: world.workspaceUri, repo: owner.did, collection: "org.slack.directory", limit: "100" },
  );
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return (result.body.records ?? []).map(({ value }) => ({
    name: value.name, skey: value.skey, visibility: value.visibility, uri: `at://${owner.did}/space/org.slack.channel/${value.skey}`,
  }));
}

export async function channelNamed(world: AppWorld, name: string): Promise<ChannelRef> {
  const channel = (await directory(world, actorNamed(world, "owner"))).find((entry) => entry.name === name);
  assert.ok(channel, `the directory has no channel named ${name}`);
  return channel;
}

/** Every space a removed member could have been in: workspace, inbox, and each channel the directory lists. */
export async function allSpaces(world: AppWorld): Promise<Array<{ label: string; uri: string }>> {
  const channels = await directory(world, actorNamed(world, "owner"));
  return [
    { label: "workspace", uri: world.workspaceUri },
    { label: "inbox", uri: inboxOf(world) },
    ...channels.map((channel) => ({ label: `${channel.visibility} channel ${channel.name}`, uri: channel.uri })),
  ];
}

// --- Space credentials, minted the way an independent app does ---------------------------------------

function accountFor(world: AppWorld, did: string): Actor {
  const account = [...world.actors.values()].find((actor) => actor.did === did);
  assert.ok(account, `no account in this scenario has DID ${did}`);
  return account;
}

export async function mintAs(world: AppWorld, actor: Actor, space: string): Promise<SpaceCredential> {
  return mintSpaceCredentialWith({
    memberClient: new AtprotoClient(async (path, init) => {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${actor.accessJwt}`);
      return fetch(new URL(path, actor.pdsUrl), { ...init, headers, redirect: "error" });
    }),
    resolvePds: async (did) => accountFor(world, did).pdsUrl,
    fetchEndpoint: (request) => fetch(request),
    generateKey: () => JoseKey.generate(["ES256"]),
  }, space);
}

export type MintOutcome = { granted: SpaceCredential } | { refused: { status: number; code?: string } };

export async function tryMintAs(world: AppWorld, actor: Actor, space: string): Promise<MintOutcome> {
  try {
    return { granted: await mintAs(world, actor, space) };
  } catch (error) {
    if (error instanceof SpaceCredentialError) return { refused: { status: error.status, code: error.code } };
    throw error;
  }
}

/** What a mint attempt came to, in a form that prints without exposing a credential. */
export function refusal(outcome: MintOutcome): { status: number; code?: string } | "granted" {
  return "refused" in outcome ? outcome.refused : "granted";
}

export async function grantedCredential(world: AppWorld, actor: Actor, space: string): Promise<SpaceCredential> {
  const outcome = await tryMintAs(world, actor, space);
  assert.ok("granted" in outcome, `${actor.role} was refused a credential for ${space}: ${JSON.stringify(outcome)}`);
  return outcome.granted;
}

export type CredentialClaims = { iss: string; sub: string; iat: number; exp: number; cnf?: { jkt?: string } };

export function claimsOf(token: string): CredentialClaims {
  const payload = token.split(".")[1];
  assert.ok(payload, "a space credential is a three-part JWT");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as CredentialClaims;
}

/** The same credential with its signed expiry pushed out and the original signature kept: what someone trying to outlive removal could forge. */
export function withExtendedExpiry(credential: SpaceCredential, extraSeconds: number): SpaceCredential {
  const [header, , signature] = credential.token.split(".");
  const payload = Buffer.from(JSON.stringify({ ...claimsOf(credential.token), exp: claimsOf(credential.token).exp + extraSeconds }), "utf8").toString("base64url");
  return new SpaceCredential(credential.space, `${header}.${payload}.${signature}`, credential.key, (request) => fetch(request));
}

/** The credential's header and claims re-signed by its authority with a new `exp`, keeping its jti and DPoP binding: a genuinely expired (or not yet expired) copy that verifies. */
export async function withSignedExpiry(world: AppWorld, credential: SpaceCredential, exp: number): Promise<SpaceCredential> {
  const authority = accountFor(world, claimsOf(credential.token).iss);
  const token = await world.fixture.resignSpaceCredential(authority.host, credential.token, { exp });
  return new SpaceCredential(credential.space, token, credential.key, (request) => fetch(request));
}

export async function readRecordsWith(world: AppWorld, credential: SpaceCredential, repoDid: string, collection: string): Promise<Array<{ rkey: string; value: Record<string, unknown> }>> {
  const records = await credential.client(accountFor(world, repoDid).pdsUrl).query<{ records: Array<{ rkey: string; value: Record<string, unknown> }> }>(
    "com.atproto.space.listRecords", { space: credential.space, repo: repoDid, collection, limit: 100 },
  );
  return records.records;
}

export type ReadAttempt = { records: number } | { refused: { status: number; code: string } };

/** A read with a held credential, reporting how the PDS answered instead of throwing when it refuses. */
export async function tryReadWith(world: AppWorld, credential: SpaceCredential, repoDid: string, collection: string): Promise<ReadAttempt> {
  try {
    return { records: (await readRecordsWith(world, credential, repoDid, collection)).length };
  } catch (error) {
    if (error instanceof XrpcError) return { refused: { status: error.status, code: error.code } };
    throw error;
  }
}

/** `eventually` for conditions that take an awaited read to check. */
export async function eventuallyAsync<T>(read: () => Promise<T | undefined | null | false>, options: { timeoutMs?: number; what?: string } = {}): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${options.what ?? "a condition"}.`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export function recentCalls(actor: Actor, count = 12): string {
  return actor.calls.slice(-count).map((call) => `${call.method} ${call.path} -> ${call.status} ${call.responseBody.slice(0, 120)}`).join("\n");
}

// --- Driving the app ---------------------------------------------------------------------------------

export async function workspaceWithAdmin(world: AppWorld): Promise<Actor> {
  const owner = await world.actor("owner", 0);
  await createWorkspaceAs(world, owner);
  await approveAdminControls(world, owner);
  return owner;
}

export async function showWorkspaceHome(world: AppWorld, actor: Actor): Promise<void> {
  await actor.page.locator(".sidebar").getByRole("button", { name: new RegExp(escapeRegExp(world.workspaceName)) }).first().click();
  await actor.page.getByText("WORKSPACE HOME").waitFor({ state: "visible" });
}

/** Runs `act`, then waits for the app's reply to the operator call it caused and decodes it. */
export async function submitAndWait(world: AppWorld, actor: Actor, act: () => Promise<void>): Promise<Executed> {
  const before = world.callsTo(actor, "/api/operator/execute").length;
  await act();
  const call = await eventually(() => world.callsTo(actor, "/api/operator/execute")[before], { what: "the operator reply", timeoutMs: 120_000 });
  return decodeExecuted(call.status, call.requestBody, call.responseBody);
}

export function decodeExecuted(status: number, requestBody: string, responseBody: string): Executed {
  const request = JSON.parse(requestBody) as { operationId: string; request: Record<string, unknown> };
  const body = (responseBody ? JSON.parse(responseBody) : {}) as { operation?: OperationView; error?: string };
  return { status, operationId: request.operationId, request: request.request, operation: body.operation, error: body.error };
}

export async function createChannelAs(world: AppWorld, owner: Actor, name: string, visibility: "public" | "private", memberDids: string[] = []): Promise<ChannelRef> {
  await showWorkspaceHome(world, owner);
  const done = await submitAndWait(world, owner, async () => {
    await owner.page.getByLabel("Channel name").fill(name);
    await owner.page.getByLabel("Channel visibility").selectOption(visibility);
    if (visibility === "private") await owner.page.getByLabel("Private member DIDs").fill(memberDids.join(" "));
    await owner.page.locator("form").filter({ has: owner.page.getByLabel("Channel name") }).getByRole("button", { name: /Create channel/ }).click();
  });
  assert.equal(done.operation?.state, "completed", `creating ${name}: ${JSON.stringify(done)}`);
  await channelButton(owner, name).waitFor({ state: "visible", timeout: 60_000 });
  return channelNamed(world, name);
}

export const channelButton = (actor: Actor, name: string): Locator =>
  actor.page.locator(".channel-nav-item").filter({ hasText: new RegExp(`^\\s*[#▣]\\s*${escapeRegExp(name)}\\s*$`) });

export async function removeMemberViaRoster(world: AppWorld, admin: Actor, did: string): Promise<Executed> {
  await showWorkspaceHome(world, admin);
  return submitAndWait(world, admin, async () => {
    await admin.page.locator(".roster-row").filter({ hasText: did }).getByRole("button", { name: "Remove", exact: true }).click();
  });
}

export async function joinWorkspaceAs(world: AppWorld, member: Actor): Promise<void> {
  await openInviteLinkAndSignIn(world, member, inviteLinkFor(world.appOrigin, world.workspaceUri));
  await joinFromInvitation(world, member);
  await member.page.getByRole("heading", { name: world.workspaceName, exact: true }).waitFor({ state: "visible" });
}

/**
 * Opens a channel from the sidebar, approving the one-time channel-read permission if the app asks for it.
 * After approving, the page comes back on the channel with its messages but without the private roster, so a person
 * opens the channel once more to see it in full.
 */
export async function openChannelAs(world: AppWorld, actor: Actor, name: string): Promise<{ status: number }> {
  const before = world.callsTo(actor, "/api/channels/messages").length;
  await channelButton(actor, name).click();
  const first = await eventually(() => world.callsTo(actor, "/api/channels/messages")[before], { what: `the first sync of ${name}` });
  if (first.status !== 401 && first.status !== 403) return { status: first.status };
  await actor.page.getByRole("button", { name: "Grant channel read →" }).click();
  await completeConsent(actor);
  await waitForApp(world, actor);
  await actor.page.getByRole("heading", { name: new RegExp(`${escapeRegExp(name)}$`) }).waitFor({ state: "visible" });
  const reopened = world.callsTo(actor, "/api/channels/messages").length;
  await channelButton(actor, name).click();
  const again = await eventually(() => world.callsTo(actor, "/api/channels/messages")[reopened], { what: `the sync of ${name} after approval`, timeoutMs: 60_000 });
  return { status: again.status };
}

export async function postMessageAs(world: AppWorld, actor: Actor, text: string): Promise<void> {
  const composer = actor.page.getByPlaceholder("Write a message…");
  await composer.fill(text);
  await actor.page.getByRole("button", { name: "Send", exact: true }).click();
  const grant = actor.page.getByRole("button", { name: "Grant message posting →" });
  const posted = actor.page.locator(".message-card").filter({ hasText: text });
  await Promise.race([grant.waitFor({ state: "visible" }), posted.waitFor({ state: "visible" })]);
  if (await grant.isVisible()) {
    await grant.click();
    await completeConsent(actor);
    await waitForApp(world, actor);
    await composer.waitFor({ state: "visible" });
    await composer.fill(text);
    await actor.page.getByRole("button", { name: "Send", exact: true }).click();
  }
  await posted.waitFor({ state: "visible" }).catch((error: unknown) => {
    throw new Error(`The message "${text}" never appeared. Recent app calls:\n${recentCalls(actor)}`, { cause: error });
  });
}

/** An invited member's first visit: sign in from the invite link and join. */
export async function inviteAndJoin(world: AppWorld, owner: Actor, member: Actor): Promise<void> {
  await showWorkspaceHome(world, owner);
  await inviteMemberAs(owner, member.did);
  await joinWorkspaceAs(world, member);
}

// --- The operation journal and audit trail (app database, read only) --------------------------------

export function journalEntry(world: AppWorld, operationId: string): JournalEntry | undefined {
  return world.withAppDatabase((db) => {
    const row = db.prepare("SELECT workspace, workspace_uri, actor, request_hash, request_json, state, steps_json, error, created_at, updated_at FROM operation WHERE operation_id = ?")
      .get(operationId) as { workspace: string; workspace_uri: string | null; actor: string; request_hash: string; request_json: string; state: string; steps_json: string; error: string | null; created_at: number; updated_at: number } | undefined;
    if (!row) return undefined;
    const saved = JSON.parse(row.request_json) as { request: Record<string, unknown> };
    return {
      operationId, workspace: row.workspace, workspaceUri: row.workspace_uri, actor: row.actor, requestHash: row.request_hash, state: row.state, steps: JSON.parse(row.steps_json) as string[],
      error: row.error, request: saved.request, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  });
}

export function requiredJournalEntry(world: AppWorld, operationId: string): JournalEntry {
  const entry = journalEntry(world, operationId);
  assert.ok(entry, `operation ${operationId} is in the journal`);
  return entry;
}

export function auditTrail(world: AppWorld, operationId: string): AuditEvent[] {
  return world.withAppDatabase((db) => db.prepare("SELECT id, actor, event FROM audit_event WHERE operation_id = ? ORDER BY id")
    .all(operationId) as AuditEvent[]);
}

export function journalRowsFor(world: AppWorld, actorDid: string): number {
  return world.withAppDatabase((db) => (db.prepare("SELECT count(*) AS count FROM operation WHERE actor = ?").get(actorDid) as { count: number }).count);
}

export function cachedRows(world: AppWorld, accountDid: string): { records: number; cursors: number; syncs: number } {
  return world.withAppDatabase((db) => {
    const count = (table: string) => (db.prepare(`SELECT count(*) AS count FROM ${table} WHERE account_did = ?`).get(accountDid) as { count: number }).count;
    return { records: count("channel_record_cache"), cursors: count("space_collection_cursor"), syncs: count("sync_cursor") };
  });
}

// --- Sampling a live operation -----------------------------------------------------------------------

export type Sampler<T> = { stop(): Promise<T[]> };

/** Reads continuously until stopped, so an assertion can look at what was true while an operation was in flight. */
export function sampleWhile<T>(read: () => Promise<T>): Sampler<T> {
  const samples: T[] = [];
  let running = true;
  let failure: unknown;
  const loop = (async () => {
    while (running) samples.push(await read());
  })().catch((error: unknown) => { failure = error; });
  return {
    async stop() {
      running = false;
      await loop;
      if (failure) throw failure;
      return samples;
    },
  };
}

export type Timed<T> = { startedAt: number; finishedAt: number; value: T };

/** Like `sampleWhile`, but stamps each reading with when it started and finished, so it can be lined up against other readings. */
export function sampleTimed<T>(read: () => Promise<T>): Sampler<Timed<T>> {
  return sampleWhile(async () => {
    const startedAt = Date.now();
    const value = await read();
    return { startedAt, finishedAt: Date.now(), value };
  });
}

/** Stopping a sampler can leave its last reading a moment before the operation finished, so take one more after it. */
export async function withFinalReading<T>(samples: Array<Timed<T>>, read: () => Promise<T>): Promise<Array<Timed<T>>> {
  const startedAt = Date.now();
  const value = await read();
  return [...samples, { startedAt, finishedAt: Date.now(), value }];
}

// --- Faults only the PDS owner can cause -------------------------------------------------------------

const MEMBER_LIST_POLICY = { $type: "com.atproto.simplespace.defs#memberListPolicy" };
const OPEN_APP_ACCESS = { $type: "com.atproto.simplespace.defs#open" };

/** The authority deletes a channel's space on its PDS, so every later write to that member list is refused. */
export async function breakChannelSpace(world: AppWorld, owner: Actor, channel: ChannelRef): Promise<void> {
  const result = await world.pdsPost(owner, "com.atproto.simplespace.deleteSpace", { space: channel.uri });
  assert.equal(result.status, 200, JSON.stringify(result.body));
}

/** Lifts the fault: the authority creates the channel space again, with the policies the app uses. */
export async function repairChannelSpace(world: AppWorld, owner: Actor, channel: ChannelRef): Promise<void> {
  const result = await world.pdsPost(owner, "com.atproto.simplespace.createSpace", {
    type: "org.slack.channel", skey: channel.skey, readPolicy: MEMBER_LIST_POLICY, writePolicy: MEMBER_LIST_POLICY, appAccess: OPEN_APP_ACCESS,
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
}

// --- An app instance a scenario can stop and start again ---------------------------------------------

export type OwnApp = {
  readonly origin: string;
  readonly databasePath: string;
  readonly environment: NodeJS.ProcessEnv;
  restart(): Promise<void>;
  stop(): Promise<void>;
};

const runningApps = new Set<ChildProcess>();
process.once("exit", () => { for (const child of runningApps) child.kill("SIGKILL"); });

async function freePort(): Promise<number> {
  const listener = createServer();
  return new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      listener.close(() => address && typeof address !== "string" ? resolve(address.port) : reject(new Error("No free local port.")));
    });
  });
}

async function launch(environment: NodeJS.ProcessEnv, port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, [join(process.cwd(), "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: process.cwd(), env: environment, stdio: ["ignore", "pipe", "pipe"],
  });
  runningApps.add(child);
  let output = "";
  const capture = (chunk: Buffer) => { output = `${output}${chunk}`.slice(-4_000); };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  const deadline = Date.now() + 60_000;
  for (;;) {
    assert.equal(child.exitCode, null, `the app exited before it was ready\n${output}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return child;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
    assert.ok(Date.now() < deadline, `the app did not become ready\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function terminate(child: ChildProcess): Promise<void> {
  runningApps.delete(child);
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

/**
 * Starts an app of its own on the scenario's PDS network, with an encryption key the scenario knows, so the
 * app process can be stopped and a new one started against the same database, key and address.
 */
export async function startOwnApp(world: AppWorld): Promise<OwnApp> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const directory = mkdtempSync(join(tmpdir(), "slack-lifecycle-app-"));
  const databasePath = join(directory, "app.db");
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? tmpdir(), TMPDIR: process.env.TMPDIR ?? tmpdir(),
    NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", ATPROTO_ACCEPTANCE_TEST: "true",
    APP_URL: origin, DATABASE_PATH: databasePath, AUTH_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    PLC_URL: world.fixture.plcUrl, OPERATOR_SERVICE_REF: `did:web:localhost%3A${port}#atproto_slack_admin`,
  };
  let child = await launch(environment, port);
  const app: OwnApp = {
    origin, databasePath, environment,
    async restart() {
      await terminate(child);
      child = await launch(environment, port);
    },
    async stop() {
      await terminate(child);
      rmSync(directory, { recursive: true, force: true });
    },
  };
  return app;
}

/** The scenario's world, pointed at `app`: the same accounts and browsers, but UI helpers and journal reads use that app. */
export function worldOn(world: AppWorld, app: OwnApp): AppWorld {
  return new Proxy(world, {
    get(target, property) {
      if (property === "appOrigin") return app.origin;
      if (property === "withAppDatabase") {
        return <T>(read: (db: Database.Database) => T): T => {
          const db = new Database(app.databasePath, { readonly: true, fileMustExist: true });
          try { return read(db); } finally { db.close(); }
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set: (target, property, value) => Reflect.set(target, property, value, target),
  });
}

export type ReconcileRun = { exitCode: number | null; stdout: string; stderr: string };

const RECONCILE_DEADLINE_MS = 120_000;

/** The scheduled reconcile job (`pnpm reconcile`), run as a new process against the app's database and key. Killed if it outlives its deadline or the cucumber process. */
export async function runReconcileJob(app: OwnApp): Promise<ReconcileRun> {
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/reconcile-workspaces.ts"], {
    cwd: process.cwd(), env: { ...app.environment }, stdio: ["ignore", "pipe", "pipe"],
  });
  runningApps.add(child);
  const deadline = setTimeout(() => child.kill("SIGKILL"), RECONCILE_DEADLINE_MS);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(deadline);
    runningApps.delete(child);
  }
}
