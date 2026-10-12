import assert from "node:assert/strict";
import { JoseKey } from "@atproto/jwk-jose";
import type { Locator } from "@playwright/test";
import { mintSpaceCredentialWith, SpaceCredentialError } from "@/atproto/space-credential-core";
import { AtprotoClient } from "@/atproto/xrpc";
import { resolvePds } from "@/dm/browser-identity";
import { DmClient, type DmDeps, type DmRequestMode } from "@/dm/dm-client";
import { escapeRegExp, completeConsent, signIn } from "./ui";
import type { FixtureAccount } from "../../protocol-tests/support/app-fixture";
import type { Actor, AppWorld } from "./world";

// Helpers for the direct-message conversation scenarios. Browser helpers drive the DM UI the way a person does;
// the PDS and Node-client helpers observe the same facts independently of that UI.

export type DmcHeader = { convKey: string; participants: string[]; createdAt: string };
export type DmcMessage = { text: string; createdAt: string; parent?: string };
export type DmcReaction = { subject: string; emoji: string; createdAt: string };
export type DmcRecord<T> = { rkey: string; cid: string; value: T };
export type DmcMember = { did: string; read: boolean; write: boolean };
export type DmcMint = { minted: true } | { minted: false; status: number; code?: string };
export type DmcTraffic = {
  requests: Array<{ method: string; url: string; postData: string }>;
  spaceReads: Array<{ url: string; status: number; body: string | null }>;
};

const MODE_LABELS: Record<DmRequestMode, string> = { everyone: "Everyone", allowlist: "Only people I allow", nobody: "Nobody" };
const SLOW_UI_MS = 60_000;

export const dmcInboxOf = (account: FixtureAccount): string => `at://${account.did}/space/org.slack.dm.inbox/self`;
export const dmcHalfOf = (account: FixtureAccount, convKey: string): string => `at://${account.did}/space/org.slack.dm.conversation/${convKey}`;

// --- Facts read straight from a PDS ---------------------------------------------------------------------

export async function dmcRecords<T extends object>(
  world: AppWorld, as: FixtureAccount, query: { space: string; repo: string; collection: string },
): Promise<Array<DmcRecord<T>>> {
  const result = await world.pdsGet<{ records?: Array<DmcRecord<T>> }>(as, "com.atproto.space.listRecords", { ...query, limit: "1000" });
  assert.equal(result.status, 200, `listRecords ${query.collection} in ${query.space}: ${JSON.stringify(result.body)}`);
  return result.body.records ?? [];
}

export async function dmcMembers(world: AppWorld, owner: FixtureAccount, space: string): Promise<DmcMember[]> {
  const result = await world.pdsGet<{ members?: DmcMember[] }>(owner, "com.atproto.simplespace.listMembers", { space, limit: "1000" });
  assert.equal(result.status, 200, `listMembers ${space}: ${JSON.stringify(result.body)}`);
  return result.body.members ?? [];
}

/** The conversation halves the account itself hosts. The PDS also lists foreign halves the account has written into. */
export async function dmcHalfUris(world: AppWorld, as: FixtureAccount): Promise<string[]> {
  const result = await world.pdsGet<{ spaces?: Array<{ uri: string }> }>(as, "com.atproto.space.listSpaces", { type: "org.slack.dm.conversation", limit: "100" });
  assert.equal(result.status, 200, `listSpaces: ${JSON.stringify(result.body)}`);
  return (result.body.spaces ?? []).map((space) => space.uri).filter((uri) => uri.startsWith(`at://${as.did}/`)).sort();
}

export async function dmcInboxUris(world: AppWorld, as: FixtureAccount): Promise<string[]> {
  const result = await world.pdsGet<{ spaces?: Array<{ uri: string }> }>(as, "com.atproto.space.listSpaces", { type: "org.slack.dm.inbox", limit: "100" });
  assert.equal(result.status, 200, `listSpaces: ${JSON.stringify(result.body)}`);
  return (result.body.spaces ?? []).map((space) => space.uri);
}

export async function dmcHeaderOf(world: AppWorld, owner: FixtureAccount, convKey: string): Promise<DmcRecord<DmcHeader>> {
  const records = await dmcRecords<DmcHeader>(world, owner, { space: dmcHalfOf(owner, convKey), repo: owner.did, collection: "org.slack.dm.header" });
  assert.equal(records.length, 1, `exactly one header in ${owner.did}'s half`);
  assert.equal(records[0]!.rkey, "self");
  return records[0]!;
}

export async function dmcMessagesOf(world: AppWorld, owner: FixtureAccount, convKey: string): Promise<Array<DmcRecord<DmcMessage>>> {
  return dmcRecords<DmcMessage>(world, owner, { space: dmcHalfOf(owner, convKey), repo: owner.did, collection: "org.slack.dm.message" });
}

export async function dmcRequestsFrom(world: AppWorld, sender: FixtureAccount, recipient: FixtureAccount): Promise<Array<DmcRecord<DmcHeader>>> {
  return dmcRecords<DmcHeader>(world, sender, { space: dmcInboxOf(recipient), repo: sender.did, collection: "org.slack.dm.request" });
}

export const dmcMessageUri = (owner: FixtureAccount, convKey: string, rkey: string): string =>
  `${dmcHalfOf(owner, convKey)}/${owner.did}/org.slack.dm.message/${rkey}`;

/** Polls an asynchronous read until it returns something truthy, for facts a click has not finished writing yet. */
export async function dmcUntil<T>(read: () => Promise<T | undefined | null | false>, what: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export function dmcConvKeyOf(halfUri: string): string {
  return halfUri.split("/").at(-1)!;
}

/** Asks the space authority for a credential as `as`, the same exchange every reader performs. */
export async function dmcMint(world: AppWorld, as: FixtureAccount, space: string): Promise<DmcMint> {
  try {
    await mintSpaceCredentialWith(dmcDeps(world, as), space);
    return { minted: true };
  } catch (error) {
    if (error instanceof SpaceCredentialError) return { minted: false, status: error.status, code: error.code };
    throw error;
  }
}

/** The accounts the space authority tracks as writers of `space` and each one's last recorded revision, listed with a credential minted by `member`. */
export async function dmcWriterRevs(world: AppWorld, member: FixtureAccount, authority: FixtureAccount, space: string): Promise<Record<string, string>> {
  const credential = await mintSpaceCredentialWith(dmcDeps(world, member), space);
  const page = await credential.client(authority.pdsUrl).query<{ repos: Array<{ did: string; rev: string }> }>("com.atproto.space.listRepos", { space });
  return Object.fromEntries(page.repos.map((repo): [string, string] => [repo.did, repo.rev]).sort(([left], [right]) => left.localeCompare(right)));
}

/** The accounts the space authority tracks as writers of `space`, listed with a credential minted by `member`. */
export async function dmcWriters(world: AppWorld, member: FixtureAccount, authority: FixtureAccount, space: string): Promise<string[]> {
  return Object.keys(await dmcWriterRevs(world, member, authority, space)).sort();
}

export type DmcRepoHistory = { latestRev: string; opRevs: string[] };

/** The repo's commit history in `space` as its owner's PDS reports it: any write, even of identical content, adds an op and moves the revision. */
export async function dmcRepoHistory(world: AppWorld, owner: FixtureAccount, space: string): Promise<DmcRepoHistory> {
  const commit = await world.pdsGet<{ commit: { rev: string } }>(owner, "com.atproto.space.getLatestCommit", { space, repo: owner.did });
  assert.equal(commit.status, 200, `getLatestCommit ${space}: ${JSON.stringify(commit.body)}`);
  const ops = await world.pdsGet<{ ops: Array<{ rev: string }> }>(owner, "com.atproto.space.listRepoOps", { space, repo: owner.did, limit: "100" });
  assert.equal(ops.status, 200, `listRepoOps ${space}: ${JSON.stringify(ops.body)}`);
  assert.ok(ops.body.ops.length < 100, "the op listing is not truncated");
  return { latestRev: commit.body.commit.rev, opRevs: ops.body.ops.map((op) => op.rev) };
}

/** The request records a writer's repo serves to `reader`, who mints a credential for the reader's own inbox, as the reader's client sees them. */
export async function dmcRequestsServedTo(world: AppWorld, reader: FixtureAccount, writer: FixtureAccount): Promise<Array<DmcRecord<DmcHeader>>> {
  const space = dmcInboxOf(reader);
  const credential = await mintSpaceCredentialWith(dmcDeps(world, reader), space);
  const page = await credential.client(writer.pdsUrl).query<{ records: Array<DmcRecord<DmcHeader>> }>("com.atproto.space.listRecords", {
    space, repo: writer.did, collection: "org.slack.dm.request", limit: "100",
  });
  return page.records;
}

/** Every value in every table of the app's own database, as text, so a scenario can prove something is not in it. */
export function dmcAppDatabaseText(world: AppWorld): string {
  return world.withAppDatabase((db) => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    return tables.map(({ name }) => {
      const rows = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() as Array<Record<string, unknown>>;
      return rows.map((row) => Object.values(row).map((value) => Buffer.isBuffer(value) ? value.toString("latin1") : String(value)).join("\u0000")).join("\n");
    }).join("\n");
  });
}

export type DmcMention = { table: string; column: string; value: string };

/** Every table and column of the app's own database whose stored value contains `needle`. */
export function dmcAppDatabaseMentions(world: AppWorld, needle: string): DmcMention[] {
  return world.withAppDatabase((db) => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    return tables.flatMap(({ name }) => {
      const rows = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() as Array<Record<string, unknown>>;
      return rows.flatMap((row) => Object.entries(row).flatMap(([column, value]) => {
        const text = Buffer.isBuffer(value) ? value.toString("latin1") : String(value);
        return text.includes(needle) ? [{ table: name, column, value: text }] : [];
      }));
    });
  });
}

// --- A DM engine acting as an account from Node ---------------------------------------------------------

function dmcDeps(world: AppWorld, account: FixtureAccount): DmDeps {
  const values = new Map<string, string>();
  return {
    did: account.did,
    memberClient: new AtprotoClient(async (path, init) => {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${account.accessJwt}`);
      return fetch(new URL(path, account.pdsUrl), { ...init, headers, redirect: "error" });
    }),
    resolvePds: (did) => resolvePds(did, { plcUrl: world.fixture.plcUrl, loopback: true }),
    fetchEndpoint: (request) => fetch(request),
    generateKey: () => JoseKey.generate(["ES256"]),
    store: {
      get: async (key) => values.get(key) ?? null,
      set: async (key, value) => { values.set(key, value); },
      delete: async (key) => { values.delete(key); },
    },
  };
}

/** A fresh DM engine for the account: no cached credentials, so every read mints new ones. */
export function dmcClientFor(world: AppWorld, account: FixtureAccount): DmClient {
  return new DmClient(dmcDeps(world, account));
}

/** Creates `count` extra accounts alternating between the two PDS hosts, each with an open DM inbox. */
export async function dmcOpenInboxAccounts(world: AppWorld, count: number, tag: string): Promise<FixtureAccount[]> {
  const accounts: FixtureAccount[] = [];
  const stamp = Date.now().toString(36).slice(-4);
  for (let start = 0; start < count; start += 10) {
    const batch = await Promise.all(Array.from({ length: Math.min(10, count - start) }, async (_, offset) => {
      const index = start + offset;
      const host = index % 2 === 0 ? 0 : 1;
      const account = await world.fixture.createAccount(`${tag}${stamp}x${index}.${host === 0 ? "test" : "test2"}`, host);
      await dmcClientFor(world, account).enableDms("everyone");
      return account;
    }));
    accounts.push(...batch);
  }
  return accounts;
}

// --- What the browser did on the network ----------------------------------------------------------------

function recordTraffic(world: AppWorld, actor: Actor): void {
  const traffic: DmcTraffic = { requests: [], spaceReads: [] };
  world.scratch.set(`dmc:traffic:${actor.role}`, traffic);
  actor.page.on("request", (request) => {
    traffic.requests.push({ method: request.method(), url: request.url(), postData: request.postData() ?? "" });
  });
  actor.page.on("response", (response) => {
    const url = response.url();
    if (response.request().method() !== "GET" || !url.includes("/xrpc/com.atproto.space.")) return;
    const status = response.status();
    void response.text().then(
      (body) => { traffic.spaceReads.push({ url, status, body }); },
      () => { traffic.spaceReads.push({ url, status, body: null }); },
    );
  });
}

export function dmcTrafficOf(world: AppWorld, actor: Actor): DmcTraffic {
  const traffic = world.scratch.get(`dmc:traffic:${actor.role}`) as DmcTraffic | undefined;
  assert.ok(traffic, `${actor.role} has no recorded traffic; connect them with dmcConnect first`);
  return traffic;
}

// --- What a person does in the DM UI --------------------------------------------------------------------

/** Signs in to the app, then connects the browser's own direct-message session (a second PDS consent). */
export async function dmcConnect(world: AppWorld, actor: Actor): Promise<void> {
  recordTraffic(world, actor);
  await signIn(world, actor);
  await actor.page.getByRole("button", { name: /Connect direct messages/ }).click();
  await completeConsent(actor);
  await actor.page.getByRole("button", { name: /New message/ }).waitFor({ state: "visible", timeout: SLOW_UI_MS });
}

export async function dmcReload(actor: Actor): Promise<void> {
  await actor.page.reload();
  await actor.page.getByRole("button", { name: /New message/ }).waitFor({ state: "visible", timeout: SLOW_UI_MS });
}

export async function dmcOpenSettings(actor: Actor): Promise<void> {
  await actor.page.getByRole("button", { name: /DM settings/ }).click();
  await actor.page.getByRole("heading", { name: "Request settings" }).waitFor({ state: "visible" });
}

export async function dmcSetMode(actor: Actor, mode: DmRequestMode): Promise<void> {
  await actor.page.getByRole("radio", { name: MODE_LABELS[mode], exact: true }).click();
  await actor.page.getByText(new RegExp(`Current mode: ${escapeRegExp(MODE_LABELS[mode])}`)).waitFor({ state: "visible" });
}

export async function dmcEnableDms(actor: Actor, mode: DmRequestMode = "allowlist"): Promise<void> {
  await dmcOpenSettings(actor);
  await actor.page.getByRole("button", { name: "Enable direct messages" }).click();
  await actor.page.getByText(/Current mode: Only people I allow/).waitFor({ state: "visible" });
  if (mode !== "allowlist") await dmcSetMode(actor, mode);
}

export async function dmcStartConversation(actor: Actor, dids: readonly string[], timeoutMs = SLOW_UI_MS): Promise<void> {
  await actor.page.getByRole("button", { name: /New message/ }).click();
  await actor.page.getByLabel("Participant DIDs").fill(dids.join(", "));
  await actor.page.getByRole("button", { name: "Start conversation" }).click();
  await actor.page.getByRole("heading", { name: "Delivery results" }).waitFor({ state: "visible", timeout: timeoutMs });
}

export async function dmcDeliveryRows(actor: Actor): Promise<Array<{ did: string; outcome: string }>> {
  const card = actor.page.locator(".starter-card").filter({ has: actor.page.getByRole("heading", { name: "Delivery results" }) });
  return card.locator(".roster-row").evaluateAll((rows) => rows.map((row) => ({
    did: row.querySelector(".mono-note")?.textContent?.trim() ?? "",
    outcome: row.querySelector(".status-note")?.textContent?.trim() ?? "",
  })));
}

export async function dmcOpenStartedConversation(actor: Actor): Promise<void> {
  await actor.page.getByRole("button", { name: "Open conversation →" }).click();
  await actor.page.getByPlaceholder("Write a message…").waitFor({ state: "visible" });
}

/** Opens the only conversation listed in the sidebar. */
export async function dmcOpenOnlyConversation(actor: Actor): Promise<void> {
  await actor.page.locator(".channel-nav-item", { hasText: "◈" }).click();
  await actor.page.getByPlaceholder("Write a message…").waitFor({ state: "visible" });
}

export const dmcCard = (actor: Actor, text: string): Locator =>
  actor.page.locator("article.message-card").filter({ has: actor.page.getByText(text, { exact: true }) });

export async function dmcSend(actor: Actor, text: string): Promise<void> {
  await actor.page.getByPlaceholder("Write a message…").fill(text);
  await actor.page.getByRole("button", { name: "Send", exact: true }).click();
  await dmcCard(actor, text).waitFor({ state: "visible" });
}

export async function dmcEditMessage(actor: Actor, text: string, replacement: string): Promise<void> {
  await dmcCard(actor, text).getByRole("button", { name: "Edit", exact: true }).click();
  const editor = actor.page.locator("article.message-card form.message-compose");
  await editor.locator("textarea").fill(replacement);
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
}

export async function dmcDeleteMessage(actor: Actor, text: string): Promise<void> {
  await dmcCard(actor, text).getByRole("button", { name: "Delete", exact: true }).click();
  const confirm = dmcCard(actor, text).getByRole("button", { name: "Confirm delete", exact: true });
  await confirm.click();
  await confirm.waitFor({ state: "hidden" });
}

export async function dmcSync(actor: Actor): Promise<void> {
  await actor.page.getByRole("button", { name: /Sync/ }).click();
}

export async function dmcOpenRequests(actor: Actor, count: number): Promise<void> {
  const button = actor.page.getByRole("button", { name: new RegExp(`Requests \\(${count}\\)`) });
  await button.waitFor({ state: "visible", timeout: SLOW_UI_MS });
  await button.click();
  await actor.page.getByRole("heading", { name: "Requests", exact: true }).waitFor({ state: "visible" });
}

export const dmcRequestRow = (actor: Actor, senderDid: string): Locator =>
  actor.page.locator(".roster-row").filter({ hasText: senderDid }).filter({ has: actor.page.getByRole("button", { name: "Accept", exact: true }) });

/** Accepts the request from `senderDid` and waits for the conversation it opens. */
export async function dmcAcceptRequestFrom(actor: Actor, senderDid: string): Promise<void> {
  await dmcRequestRow(actor, senderDid).getByRole("button", { name: "Accept", exact: true }).click();
  await actor.page.getByPlaceholder("Write a message…").waitFor({ state: "visible", timeout: SLOW_UI_MS });
}

/** Reloads, opens the request list showing exactly `count` requests, and accepts the one from `senderDid`. */
export async function dmcReloadAndAcceptFrom(actor: Actor, senderDid: string, count = 1): Promise<void> {
  await dmcReload(actor);
  await dmcOpenRequests(actor, count);
  await dmcAcceptRequestFrom(actor, senderDid);
}

/** The participants card of the open conversation: one row per participant, with any status chip. */
export async function dmcRoster(actor: Actor): Promise<Array<{ did: string; chip: string }>> {
  return actor.page.locator(".private-roster .roster-row").evaluateAll((rows) => rows.map((row) => ({
    did: row.querySelector(".mono-note")?.textContent?.trim() ?? "",
    chip: row.querySelector(".status-note")?.textContent?.trim() ?? "",
  })));
}

export async function dmcAllowlistShown(actor: Actor): Promise<string[]> {
  const card = actor.page.locator(".starter-card").filter({ has: actor.page.getByRole("heading", { name: "Allowlist" }) });
  return card.locator(".roster-row .mono-note").allInnerTexts();
}
