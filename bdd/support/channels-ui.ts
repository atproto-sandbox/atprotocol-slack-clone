import assert from "node:assert/strict";
import { JoseKey } from "@atproto/jwk-jose";
import { expect, type Locator } from "@playwright/test";
import { mintSpaceCredentialWith, SpaceCredentialError, type SpaceCredential } from "@/atproto/space-credential-core";
import { AtprotoClient } from "@/atproto/xrpc";
import { channelUri, spaceRecordUri } from "@/protocol/keys";
import { inviteLinkFor } from "@/app/ui/client-api";
import type { SecondApp } from "../../protocol-tests/support/app-fixture";
import type { Actor, ApiCall, AppWorld } from "./world";
import { approveAdminControls, completeConsent, createWorkspaceAs, eventually, inviteMemberAs } from "./ui";

export type ChannelRef = { skey: string; name: string; uri: string; visibility: string };
export type Member = { did: string; read: boolean; write: boolean };
export type SpaceRecord = { uri: string; rkey: string; cid?: string; value: Record<string, unknown> };

export const messageCollection = "org.slack.channel.message";
export const reactionCollection = "org.slack.channel.reaction";

// --- PDS facts, read straight from the host with an account's own access token ------------------------

export async function listMembers(world: AppWorld, as: Actor, space: string): Promise<Member[]> {
  const result = await world.pdsGet<{ members?: Member[] }>(as, "com.atproto.simplespace.listMembers", { space, limit: "1000" });
  assert.equal(result.status, 200, `listMembers ${space}: ${JSON.stringify(result.body)}`);
  return result.body.members ?? [];
}

export async function directoryOf(world: AppWorld, owner: Actor): Promise<ChannelRef[]> {
  const result = await world.pdsGet<{ records?: Array<{ value: { skey: string; name: string; visibility: string } }> }>(
    owner, "com.atproto.space.listRecords", { space: world.workspaceUri, repo: owner.did, collection: "org.slack.directory", limit: "100" },
  );
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return (result.body.records ?? []).map(({ value }) => ({ ...value, uri: channelUri(owner.did, value.skey) }));
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
  const known = [...world.actors.values()].find((actor) => actor.did === did);
  assert.ok(known, `no actor owns ${did}, so its PDS is unknown`);
  return known.pdsUrl;
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
      fetchEndpoint: (request) => fetch(request),
      generateKey: () => JoseKey.generate(["ES256"]),
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

export async function waitForSite(site: Site, actor: Actor): Promise<void> {
  await actor.page.waitForURL((url) => url.origin === site.origin && !url.pathname.startsWith("/oauth"), { timeout: 30_000 });
}

/** The same account in another browser context, signed in to a different app. Registered so the scenario closes it. */
export async function startSessionOn(world: AppWorld, actor: Actor, site: Site, label: string): Promise<Actor> {
  const role = `${actor.role}@${label}`;
  const context = await world.newContext(role);
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const session: Actor = { ...actor, role, context, page, calls: [] };
  world.recordCalls(session);
  world.actors.set(role, session);
  await page.goto(site.origin);
  return session;
}

/** Every /api request an actor's page makes, with its query string, in order. */
export function trackApiRequests(actor: Actor): URL[] {
  const requests: URL[] = [];
  actor.page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) requests.push(url);
  });
  return requests;
}

async function signInFromLoginFormOn(site: Site, actor: Actor): Promise<void> {
  await actor.page.getByLabel("Your AT Protocol handle").fill(actor.did);
  await actor.page.getByRole("button", { name: /Continue with atproto/i }).click();
  await actor.page.locator("input[name=password]").waitFor({ state: "visible" });
  await completeConsent(actor);
  await waitForSite(site, actor);
}

export async function joinWorkspaceOn(site: Site, actor: Actor, inviteLink: string): Promise<void> {
  await actor.page.goto(inviteLink);
  await actor.page.getByText(/invited to a workspace/).waitFor({ state: "visible" });
  await signInFromLoginFormOn(site, actor);
  await actor.page.getByRole("region", { name: "Workspace invitation" }).getByRole("button", { name: "Join this workspace" }).click();
  await completeConsent(actor);
  await waitForSite(site, actor);
}

export const sidebarChannel = (actor: Actor, name: string) => actor.page.locator(".sidebar .channel-nav-item").filter({ hasText: name });

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

export const messagesCalls = (actor: Actor): ApiCall[] => actor.calls.filter((call) => call.path === "/api/channels/messages");

/** Opens a channel from the sidebar and returns the app's answer to the first history request it caused. */
export async function openChannel(actor: Actor, name: string): Promise<ApiCall> {
  const entry = sidebarChannel(actor, name);
  await refreshUntil(actor, () => expect(entry).toBeVisible({ timeout: 3_000 }), 60_000);
  const before = messagesCalls(actor).length;
  await entry.click();
  await actor.page.getByRole("heading", { name: new RegExp(`${name}$`) }).waitFor({ state: "visible" });
  return eventually(() => messagesCalls(actor)[before], { what: `the history request for ${name}` });
}

/** Opens a channel and, like a person would, approves the channel-read permission if the app asks for it. */
export async function openChannelReading(site: Site, actor: Actor, name: string): Promise<void> {
  const first = await openChannel(actor, name);
  if (first.status === 200) return;
  assert.ok(first.status === 401 || first.status === 403, `unexpected first history answer ${first.status}: ${first.responseBody}`);
  const before = messagesCalls(actor).length;
  await actor.page.getByRole("button", { name: "Grant channel read →" }).click();
  await completeConsent(actor);
  await waitForSite(site, actor);
  await eventually(() => messagesCalls(actor).slice(before).find((call) => call.status === 200), { what: `a successful history answer for ${name} after approving read (saw ${messagesCalls(actor).slice(before).map((call) => call.status).join(", ")})` });
}

export const composer = (actor: Actor) => actor.page.getByPlaceholder("Write a message…");
export const messageCards = (actor: Actor) => actor.page.locator(".message-card");
export const messageCard = (actor: Actor, text: string) => messageCards(actor).filter({ has: actor.page.locator("p", { hasText: new RegExp(`^${escapeForRegExp(text)}$`) }) });

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Types a message and sends it. The first post in a channel needs the write permission, which a person approves once. */
export async function postMessage(site: Site, actor: Actor, text: string, options: { replyToCard?: string; appears?: Locator } = {}): Promise<void> {
  const appears = options.appears ?? messageCard(actor, text);
  const { page } = actor;
  const needsPermission = page.getByRole("button", { name: "Grant message posting →" });
  const send = async (): Promise<void> => {
    await composer(actor).fill(text);
    await page.getByRole("button", { name: "Send", exact: true }).click();
  };
  if (options.replyToCard) await messageCard(actor, options.replyToCard).getByRole("button", { name: "Reply", exact: true }).click();
  await send();
  const refused = page.locator(".form-error");
  await appears.or(needsPermission).or(refused).first().waitFor({ state: "visible" });
  if (!await needsPermission.isVisible() && await refused.isVisible()) throw new Error(`The app refused the message: ${await refused.innerText()}`);
  if (!await needsPermission.isVisible()) {
    await syncUntil(actor, () => expect(appears.first()).toBeVisible({ timeout: 4_000 }));
    return;
  }
  await needsPermission.click();
  await completeConsent(actor);
  await waitForSite(site, actor);
  await composer(actor).waitFor({ state: "visible" });
  if (options.replyToCard) {
    await messageCard(actor, options.replyToCard).waitFor({ state: "visible" });
    await messageCard(actor, options.replyToCard).getByRole("button", { name: "Reply", exact: true }).click();
  }
  await send();
  await syncUntil(actor, () => expect(appears.first()).toBeVisible({ timeout: 4_000 }));
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
  await approveAdminControls(world, owner);
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
  for (const person of people) await openChannelReading(sites.get(person.role)!, sessions.get(person.role)!, "general");
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

/** The message as the app delivered it to this page, taken from the newest history answer that contains it. */
export async function deliveredMessage(actor: Actor, text: string): Promise<DeliveredMessage> {
  return eventually(() => {
    for (const call of [...messagesCalls(actor)].reverse()) {
      if (call.status !== 200 || !call.responseBody) continue;
      const page = JSON.parse(call.responseBody) as { messages: DeliveredMessage[] };
      const found = page.messages.find((message) => message.value.text === text);
      if (found) return found;
    }
    return undefined;
  }, { what: `${actor.role}'s app to deliver the message`, timeoutMs: 15_000 });
}

/** The reaction records the app delivered to this page for a message, from the newest history answer. */
export function deliveredReactions(actor: Actor, subject: string): Array<{ repo: string; emoji: unknown }> {
  const answer = [...messagesCalls(actor)].reverse().find((call) => call.status === 200);
  assert.ok(answer, `${actor.role} received no channel history`);
  const page = JSON.parse(answer.responseBody) as { reactions: Array<{ repo: string; value: { subject?: string; emoji?: unknown } }> };
  return page.reactions.filter((reaction) => reaction.value.subject === subject).map((reaction) => ({ repo: reaction.repo, emoji: reaction.value.emoji }));
}

const reactionCalls = (actor: Actor): ApiCall[] => actor.calls.filter((call) => call.path === "/api/channels/reactions");

/** Clicks a reaction button and returns the app's answer. A first write needs the channel write permission, which a person approves once. */
export async function clickReaction(site: Site, actor: Actor, message: string, label: string): Promise<ApiCall> {
  const click = async (): Promise<ApiCall> => {
    const before = reactionCalls(actor).length;
    await messageCard(actor, message).getByRole("button", { name: label, exact: true }).click();
    return eventually(() => reactionCalls(actor)[before], { what: `the app to answer the ${label} click` });
  };
  const answer = await click();
  const needsPermission = actor.page.getByRole("button", { name: "Grant message posting →" });
  if (answer.status !== 403 || !await needsPermission.isVisible()) return answer;
  await needsPermission.click();
  await completeConsent(actor);
  await waitForSite(site, actor);
  await syncUntil(actor, () => expect(messageCard(actor, message).getByRole("button", { name: label, exact: true })).toBeVisible({ timeout: 4_000 }));
  return click();
}

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
