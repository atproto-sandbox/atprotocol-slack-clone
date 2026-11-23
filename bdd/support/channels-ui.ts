import assert from "node:assert/strict";
import { generateSpaceKey } from "@flock/protocol/atproto/space-key";
import { expect, type Locator, type Page } from "@playwright/test";
import { mintSpaceCredentialWith, SpaceCredentialError, type SpaceCredential } from "@flock/protocol/atproto/space-credential-core";
import { AtprotoClient } from "@flock/protocol/atproto/xrpc";
import { channelUri, spaceRecordUri } from "@flock/protocol/keys";
import { COLLECTION } from "@flock/protocol/nsids";
import { inviteLinkFor } from "@flock/web/app/ui/client-api";
import type { SecondApp } from "../../protocol-tests/support/app-fixture";
import { PAGE_TIMEOUT_MS, type Actor, type ApiCall, type AppWorld } from "./world";
import { browserRecords } from "./browser-store";
import { groupDidOf, groupSpaceMembers, groupSpaceRecords, resolvePdsOrigin } from "./group-state";
import { waitForAdminControls, createWorkspaceAs, eventually, inviteMemberAs, signInFromLoginFormAt } from "./ui";

export type ChannelRef = { skey: string; name: string; uri: string; visibility: string };
export type Member = { did: string; read: boolean; write: boolean };
export type SpaceRecord = { uri: string; rkey: string; cid?: string; value: Record<string, unknown> };

export const messageCollection = "new.flock.channel.message";
export const reactionCollection = "new.flock.channel.reaction";

// --- Group Host & PDS facts, read straight from the hosts --------------------------------------------

export async function listMembers(world: AppWorld, _as: Actor, space: string): Promise<Member[]> {
  return groupSpaceMembers(world, space);
}

export async function directoryOf(world: AppWorld, _owner?: Actor): Promise<ChannelRef[]> {
  void _owner;
  const groupDid = groupDidOf(world);
  const records = groupSpaceRecords(world, world.workspaceUri, COLLECTION.directory, groupDid);
  return records.map(({ value }) => ({
    skey: String(value.skey),
    name: String(value.name),
    visibility: String(value.visibility),
    uri: channelUri(groupDid, String(value.skey)),
  }));
}

export async function channelNamed(world: AppWorld, owner: Actor, name: string): Promise<ChannelRef> {
  const found = (await directoryOf(world, owner)).find((channel) => channel.name === name);
  assert.ok(found, `the directory has no channel named ${name}`);
  return found;
}

/** The records an account holds in its own repo of a channel, newest first, as the PDS stores them. */
export async function ownRecords(world: AppWorld, as: Actor, space: string, collection: string): Promise<SpaceRecord[]> {
  const records: SpaceRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await world.pdsGet<{ records?: SpaceRecord[]; cursor?: string }>(as, "com.atproto.space.listRecords", {
      space, repo: as.did, collection, limit: "100", ...(cursor ? { cursor } : {}),
    });
    assert.equal(page.status, 200, `listRecords ${collection}: ${JSON.stringify(page.body)}`);
    records.push(...(page.body.records ?? []).map((record) => ({ ...record, uri: spaceRecordUri(space, as.did, collection, record.rkey) })));
    cursor = page.body.cursor;
  } while (cursor);
  return records;
}

export async function writeOwnRecords(world: AppWorld, as: Actor, space: string, writes: Array<{ collection: string; rkey: string; value: Record<string, unknown> }>): Promise<void> {
  for (let start = 0; start < writes.length; start += 200) {
    const batch = writes.slice(start, start + 200).map(({ collection, rkey, value }) => ({
      $type: "com.atproto.space.applyWrites#create", collection, rkey, value: { $type: collection, ...value },
    }));
    const result = await world.pdsPost(as, "com.atproto.space.applyWrites", { space, repo: as.did, writes: batch });
    assert.equal(result.status, 200, `applyWrites into ${space}: ${JSON.stringify(result.body)}`);
  }
}

// --- Space credentials, minted the way any app must: delegation token from the member's PDS, credential from the authority's PDS

export type CredentialOutcome = { granted: true; credential: SpaceCredential } | { granted: false; status: number; code: string | undefined; message: string };

function pdsOf(world: AppWorld, did: string): string {
  return resolvePdsOrigin(world, did);
}

export async function requestChannelCredential(world: AppWorld, as: Actor, space: string): Promise<CredentialOutcome> {
  const memberClient = new AtprotoClient((path, init) => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${as.accessJwt}`);
    return fetch(new URL(path, as.pdsUrl), { ...init, headers, redirect: "error" });
  });
  try {
    const credential = await mintSpaceCredentialWith({
      memberClient,
      resolvePds: async (did) => pdsOf(world, did),
      resolveKemKey: world.resolveKemKey,
      fetchEndpoint: (request) => fetch(request),
      generateKey: generateSpaceKey,
    }, space);
    return { granted: true, credential };
  } catch (error) {
    if (error instanceof SpaceCredentialError) return { granted: false, status: error.status, code: error.code, message: error.message };
    throw error;
  }
}

export async function grantedCredential(world: AppWorld, as: Actor, space: string): Promise<SpaceCredential> {
  const outcome = await requestChannelCredential(world, as, space);
  assert.ok(outcome.granted, `the PDS refused ${as.role} a credential for ${space}: ${JSON.stringify(outcome)}`);
  return outcome.credential;
}

// --- Driving the app ---------------------------------------------------------------------------------

export type Site = { origin: string };

export const primarySite = (world: AppWorld): Site => ({ origin: world.appOrigin });
export const siteOf = (app: SecondApp): Site => ({ origin: app.appUrl.origin });

/** The same account in another browser context, signed in to a different app. Registered so the scenario closes it. */
export async function startSessionOn(world: AppWorld, actor: Actor, site: Site, label: string): Promise<Actor> {
  const role = `${actor.role}@${label}`;
  const context = await world.newContext(role);
  const page = await context.newPage();
  page.setDefaultTimeout(PAGE_TIMEOUT_MS);
  const session: Actor = { ...actor, role, context, page, xrpc: [] };
  world.recordCalls(session);
  world.actors.set(role, session);
  await page.goto(site.origin);
  return session;
}



export async function joinWorkspaceOn(site: Site, actor: Actor, inviteLink: string): Promise<void> {
  await actor.page.goto(inviteLink);
  await actor.page.getByText(/invited to a workspace/).waitFor({ state: "visible" });
  await signInFromLoginFormAt(actor, site.origin);
  await actor.page.getByRole("region", { name: "Workspace invitation" }).getByRole("button", { name: "Join this workspace" }).click();
}

/** The open workspace's channels in the sidebar (the direct-message list beside them uses the same item style). */
export const workspaceChannels = (page: Page) => page.locator(".channel-nav").filter({ has: page.locator(".section-label", { hasText: "CHANNELS" }) }).locator(".channel-nav-item");

export const sidebarChannel = (actor: Actor, name: string) => workspaceChannels(actor.page).filter({ hasText: name });

export async function createChannelAs(actor: Actor, name: string, options: { visibility?: "public" | "private"; members?: string[] } = {}): Promise<void> {
  const { page } = actor;
  await page.getByLabel("Channel name").fill(name);
  if (options.visibility === "private") {
    await page.getByLabel("Channel visibility").selectOption("private");
    if (options.members?.length) await page.getByLabel("Private member DIDs").fill(options.members.join(","));
  }
  await page.locator("form").filter({ has: page.getByLabel("Channel name") }).getByRole("button", { name: /Create channel/ }).click();
  await sidebarChannel(actor, name).waitFor({ state: "visible", timeout: 60_000 });
}

const SPACE_CREDENTIAL = "/xrpc/com.atproto.space.authorizeSpaceSync";

/** The space a recorded credential request asked for. */
function credentialSpace(call: ApiCall): string | undefined {
  try { return (JSON.parse(call.requestBody) as { space?: string }).space; }
  catch { return undefined; }
}

/**
 * How the authority's PDS answered one of the browser's credential requests: "granted", or the refusal's error code. The PDS
 * answers every refusal as HTTP 400 with a code (SpaceNotFound for a space it will not admit the caller to).
 */
export function credentialOutcome(call: ApiCall): string {
  if (call.status === 200) return "granted";
  try { return (JSON.parse(call.responseBody) as { error?: string }).error ?? `HTTP ${call.status}`; }
  catch { return `HTTP ${call.status}`; }
}

/** The browser's own requests for a space's credential since `since`, as the authority's PDS answered them. */
export const credentialCalls = (actor: Actor, space: string, since = 0): ApiCall[] =>
  actor.xrpc.slice(since).filter((call) => call.path === SPACE_CREDENTIAL && credentialSpace(call) === space);

/** The browser's own record listings of one collection since `since`, with the query each named. */
export const listingCalls = (actor: Actor, collection: string, since = 0): Array<{ call: ApiCall; query: URLSearchParams }> =>
  actor.xrpc.slice(since).filter((call) => call.path === "/xrpc/com.atproto.space.listRecords").map((call) => ({ call, query: new URLSearchParams(call.query) }))
    .filter(({ query }) => query.get("collection") === collection);

/** Waits for the open channel's reads to settle: no read of it is in flight. */
export async function channelSettled(actor: Actor): Promise<void> {
  await actor.page.locator('.message-list[aria-busy="false"]').waitFor({ state: "attached" });
}

/** Opens a channel from the sidebar and waits until its reads have settled without an error. */
export async function openChannel(actor: Actor, name: string): Promise<void> {
  const entry = sidebarChannel(actor, name);
  await refreshUntil(actor, () => expect(entry).toBeVisible({ timeout: 3_000 }), 60_000);
  await entry.click();
  await actor.page.getByRole("heading", { name: new RegExp(`${escapeForRegExp(name)}$`) }).waitFor({ state: "visible" });
  await channelSettled(actor);
  const failure = actor.page.locator(".form-error");
  assert.equal(await failure.count(), 0, `${name} could not be read: ${await failure.allInnerTexts()}`);
}

export const composer = (actor: Actor) => actor.page.getByPlaceholder("Write a message…");
export const messageCards = (actor: Actor) => actor.page.locator(".message-card");
export const messageCard = (actor: Actor, text: string) => messageCards(actor).filter({ has: actor.page.locator("p", { hasText: new RegExp(`^${escapeForRegExp(text)}$`) }) });

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Types a message and sends it: the browser writes it to the account's own repo with the session's grant, and shows it at once. */
export async function postMessage(actor: Actor, text: string, options: { replyToCard?: string; appears?: Locator } = {}): Promise<void> {
  const { page } = actor;
  if (options.replyToCard) await messageCard(actor, options.replyToCard).getByRole("button", { name: "Reply", exact: true }).click();
  await composer(actor).fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const appears = (options.appears ?? messageCard(actor, text)).first();
  const refused = page.locator(".form-error");
  await appears.or(refused).first().waitFor({ state: "visible" });
  if (await refused.isVisible()) throw new Error(`The app refused the message: ${await refused.innerText()}`);
}

// --- Operator journal, for facts only the app records ----------------------------------------------

export function completedOperationSteps(world: AppWorld, kind: string, containing: string): string[] {
  const row = world.withAppDatabase((db) => db.prepare(
    "SELECT steps_json FROM operation WHERE state = 'completed' AND request_json LIKE ? AND request_json LIKE ?",
  ).get(`%"kind":"${kind}"%`, `%${containing}%`) as { steps_json: string } | undefined);
  assert.ok(row, `no completed ${kind} operation mentions ${containing}`);
  return JSON.parse(row.steps_json) as string[];
}

// --- A workspace seen through two independent apps -----------------------------------------------

export type Person = { role: string; host: 0 | 1; app: 1 | 2 };
export type Roster = { owner: Actor; general: ChannelRef; sessions: Map<string, Actor>; sites: Map<string, Site> };

/**
 * An owner on the primary app and invited members who each join through the app named for them (1 is the primary
 * app, 2 a second independent app with its own database and keys). Every member ends up reading #general there.
 */
export async function setUpRoster(world: AppWorld, people: Person[]): Promise<Roster> {
  const owner = await world.actor("owner");
  await createWorkspaceAs(world, owner);
  await waitForAdminControls(world, owner);
  const accounts = new Map<string, Actor>();
  for (const person of people) {
    const account = await world.actor(person.role, person.host);
    await inviteMemberAs(owner, account.did);
    accounts.set(person.role, account);
  }
  const site1 = primarySite(world);
  const site2 = people.some((person) => person.app === 2) ? siteOf(await world.fixture.startSecondApp()) : undefined;
  const sessions = new Map<string, Actor>();
  const sites = new Map<string, Site>();
  for (const person of people) {
    const account = accounts.get(person.role)!;
    const site = person.app === 1 ? site1 : site2!;
    const session = person.app === 1 ? account : await startSessionOn(world, account, site, `app2-${person.role}`);
    await joinWorkspaceOn(site, session, inviteLinkFor(site.origin, world.workspaceUri));
    await session.page.getByRole("heading", { name: world.workspaceName, exact: true }).waitFor({ state: "visible" });
    sessions.set(person.role, session);
    sites.set(person.role, site);
  }
  const general = await channelNamed(world, owner, "general");
  for (const person of people) await openChannel(sessions.get(person.role)!, "general");
  return { owner, general, sessions, sites };
}

/**
 * Re-checks a page's expectations, pressing the channel's Sync button between attempts, until they hold or the
 * deadline passes (then the last failure is thrown). The app re-reads a writer's repo at most once a minute, so
 * a change made elsewhere can take that long to show up.
 */
export async function syncUntil(actor: Actor, check: () => Promise<void>, timeoutMs = 150_000): Promise<void> {
  await retryAfter(check, () => actor.page.getByRole("button", { name: "Sync ↻", exact: true }).click(), timeoutMs);
}

/** Like syncUntil, for what only the workspace view carries (the channel list), pressing the top bar's Refresh. */
export async function refreshUntil(actor: Actor, check: () => Promise<void>, timeoutMs = 150_000): Promise<void> {
  await retryAfter(check, () => actor.page.getByRole("button", { name: /Refresh/ }).click(), timeoutMs);
}

async function retryAfter(check: () => Promise<void>, press: () => Promise<void>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
    }
    await press();
  }
}

export type DeliveredMessage = { uri: string; rkey: string; repo: string; value: Record<string, unknown> };

/** The message as the app's engine holds it in this browser: the record the page renders. */
export async function deliveredMessage(actor: Actor, text: string): Promise<DeliveredMessage> {
  let found: DeliveredMessage | undefined;
  await settles(async () => {
    found = (await browserRecords(actor, messageCollection)).find((record) => record.value.text === text);
    assert.ok(found, `${actor.role}'s app holds the message`);
  });
  assert.ok(found);
  return found;
}

/** The reaction records the app's engine holds in this browser for a message. */
export async function deliveredReactions(actor: Actor, subject: string): Promise<Array<{ repo: string; emoji: unknown }>> {
  return (await browserRecords(actor, reactionCollection)).filter((reaction) => reaction.value.subject === subject)
    .map((reaction) => ({ repo: reaction.repo, emoji: reaction.value.emoji }));
}

/** Clicks a reaction button and returns the PDS's answer to the browser's own write (a putRecord, or a deleteRecord to remove it). */
export async function clickReaction(actor: Actor, message: string, label: string): Promise<ApiCall> {
  const before = actor.xrpc.length;
  await messageCard(actor, message).getByRole("button", { name: label, exact: true }).click();
  return eventually(() => actor.xrpc.slice(before).find((call) => REACTION_WRITES.has(call.path) && call.requestBody.includes(reactionCollection)),
    { what: `the browser to write the ${label} reaction` });
}

const REACTION_WRITES = new Set(["/xrpc/com.atproto.space.putRecord", "/xrpc/com.atproto.space.deleteRecord"]);

/** Re-runs an assertion over facts that arrive asynchronously (recorded network answers) until it holds or time runs out. */
export async function settles(check: () => void | Promise<void>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
