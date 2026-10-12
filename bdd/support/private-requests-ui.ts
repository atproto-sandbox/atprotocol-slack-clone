import assert from "node:assert/strict";
import { JoseKey } from "@atproto/jwk-jose";
import type { Locator, Page, Response as PlaywrightResponse } from "@playwright/test";
import { inviteLinkFor, type InboxRequest } from "@/app/ui/client-api";
import { mintSpaceCredentialWith, SpaceCredentialError, type SpaceCredential } from "@/atproto/space-credential-core";
import { AtprotoClient } from "@/atproto/xrpc";
import { channelUri, decisionRecordKey, inboxUri, parseSpaceUri, requestRecordKey, spaceRecordUri, tidNow } from "@/protocol/keys";
import type { Actor, AppWorld } from "./world";
import { approveAdminControls, completeConsent, createWorkspaceAs, inviteMemberAs, joinFromInvitation, openInviteLinkAndSignIn, waitForApp } from "./ui";

export const PRIVATE_CHANNEL_NAME = "Private Room";

const JOIN_REQUEST = "org.slack.joinRequest";
const JOIN_DECISION = "org.slack.joinDecision";
const CHANNEL_ROSTER = "org.slack.channel.roster";
const CHANNEL_MESSAGE = "org.slack.channel.message";

export type PrivateChannel = { name: string; skey: string; space: string };
export type Member = { did: string; read: boolean; write: boolean };
export type SubmittedRequest = { id: string; uri: string };
export type StoredJoinRequest = { rkey: string; requestId: string; channelSkey: string; createdAt: string };
export type JoinDecision = { request: string; requestId: string; decision: "approve" | "deny"; updatedAt: string };
export type OperationOutcome = { status: number; state: string | undefined; error: string | undefined; completedSteps: string[] };
export type WriteSnapshot = { decision: boolean; member: boolean; rosterActive: boolean };

type RecordPage = { records?: Array<{ rkey: string; value: Record<string, unknown> }> };

// --- Identifiers ------------------------------------------------------------------------------------

export function inboxOf(world: AppWorld): string {
  const parsed = parseSpaceUri(world.workspaceUri);
  assert.ok(parsed, "this scenario has no workspace yet");
  return inboxUri(parsed.authorityDid, parsed.skey);
}

export function operatorServiceRef(world: AppWorld): string {
  return `did:web:localhost%3A${world.fixture.appUrl.port}#atproto_slack_admin`;
}

export function requestUriOf(world: AppWorld, channel: PrivateChannel, requester: Actor): string {
  return spaceRecordUri(inboxOf(world), requester.did, JOIN_REQUEST, requestRecordKey(channel.space, requester.did));
}

// --- PDS facts, read straight from the hosts ---------------------------------------------------------

export async function mintCredential(world: AppWorld, as: Actor, space: string): Promise<SpaceCredential> {
  const pdsByDid = new Map([...world.actors.values()].map((actor) => [actor.did, actor.pdsUrl]));
  return mintSpaceCredentialWith({
    memberClient: new AtprotoClient((path, init) => {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${as.accessJwt}`);
      return fetch(new URL(path, as.pdsUrl), { ...init, headers, redirect: "error" });
    }),
    resolvePds: async (did) => {
      const url = pdsByDid.get(did);
      assert.ok(url, `no PDS is known for ${did}`);
      return url;
    },
    fetchEndpoint: (request) => fetch(request),
    generateKey: () => JoseKey.generate(["ES256"]),
  }, space);
}

export async function assertCredentialRefused(world: AppWorld, as: Actor, space: string, what: string): Promise<void> {
  const outcome = await mintCredential(world, as, space).then(() => null, (error: unknown) => error);
  assert.ok(outcome instanceof SpaceCredentialError, `${what}: the PDS should refuse a credential, got ${outcome === null ? "a credential" : String(outcome)}`);
  assert.deepEqual({ status: outcome.status, code: outcome.code }, { status: 403, code: "UserNotAuthorized" }, `${what}: the PDS denies the credential because the account is not authorized for the space`);
}

export async function membersOf(world: AppWorld, as: Actor, space: string): Promise<Member[]> {
  const result = await world.pdsGet<{ members?: Member[] }>(as, "com.atproto.simplespace.listMembers", { space, limit: "1000" });
  assert.equal(result.status, 200, `listMembers ${space}: ${JSON.stringify(result.body)}`);
  return result.body.members ?? [];
}

export function accessOf(members: Member[], did: string): { read: boolean; write: boolean } | undefined {
  const member = members.find((entry) => entry.did === did);
  return member && { read: member.read, write: member.write };
}

export async function privateChannelNamed(world: AppWorld, authority: Actor, name: string): Promise<PrivateChannel> {
  const directory = await world.pdsGet<{ records?: Array<{ value: { skey: string; name: string; visibility: string } }> }>(
    authority, "com.atproto.space.listRecords", { space: world.workspaceUri, repo: authority.did, collection: "org.slack.directory", limit: "100" },
  );
  assert.equal(directory.status, 200, JSON.stringify(directory.body));
  const entry = directory.body.records?.find(({ value }) => value.name === name)?.value;
  assert.ok(entry, `the directory has no channel named ${name}`);
  assert.equal(entry.visibility, "private");
  return { name, skey: entry.skey, space: channelUri(authority.did, entry.skey) };
}

function storedRequests(page: RecordPage): StoredJoinRequest[] {
  return (page.records ?? []).map(({ rkey, value }) => ({
    rkey, requestId: String(value.requestId), channelSkey: String(value.channelSkey), createdAt: String(value.createdAt),
  }));
}

/** The join requests a repo holds in the inbox, read with the account's own token on its own PDS. */
export async function requestsReadByOwner(world: AppWorld, owner: Actor, inbox: string): Promise<StoredJoinRequest[]> {
  const page = await world.pdsGet<RecordPage>(owner, "com.atproto.space.listRecords", { space: inbox, repo: owner.did, collection: JOIN_REQUEST, limit: "100" });
  assert.equal(page.status, 200, `listRecords ${JOIN_REQUEST}: ${JSON.stringify(page.body)}`);
  return storedRequests(page.body);
}

/** The join requests a repo holds in the inbox, read through a space credential on that repo's PDS. */
export async function requestsReadWithCredential(credential: SpaceCredential, repo: Actor): Promise<StoredJoinRequest[]> {
  const page = await credential.client(repo.pdsUrl).query<RecordPage>("com.atproto.space.listRecords", {
    space: credential.space, repo: repo.did, collection: JOIN_REQUEST, limit: 100,
  });
  return storedRequests(page);
}

export async function writerSetOf(credential: SpaceCredential, authority: Actor): Promise<string[]> {
  const page = await credential.client(authority.pdsUrl).query<{ repos: Array<{ did: string }> }>("com.atproto.space.listRepos", { space: credential.space });
  return page.repos.map(({ did }) => did);
}

export async function decisionFor(world: AppWorld, authority: Actor, inbox: string, requestUri: string): Promise<JoinDecision | undefined> {
  const result = await world.pdsGet<{ value?: JoinDecision; error?: string }>(authority, "com.atproto.space.getRecord", {
    space: inbox, repo: authority.did, collection: JOIN_DECISION, rkey: decisionRecordKey(requestUri),
  });
  if (result.status === 200) return result.body.value;
  assert.match(result.body.error ?? "", /RecordNotFound/, `reading the decision failed unexpectedly: ${result.status} ${JSON.stringify(result.body)}`);
  return undefined;
}

export async function activeRosterOf(world: AppWorld, authority: Actor, channel: PrivateChannel): Promise<string[]> {
  const page = await world.pdsGet<RecordPage>(authority, "com.atproto.space.listRecords", { space: channel.space, repo: authority.did, collection: CHANNEL_ROSTER, limit: "100" });
  assert.equal(page.status, 200, JSON.stringify(page.body));
  return (page.body.records ?? []).filter(({ value }) => value.active === true).map(({ value }) => String(value.subject)).sort();
}

export async function messagesOf(credential: SpaceCredential, author: Actor): Promise<string[]> {
  const page = await credential.client(author.pdsUrl).query<RecordPage>("com.atproto.space.listRecords", {
    space: credential.space, repo: author.did, collection: CHANNEL_MESSAGE, limit: 100,
  });
  return (page.records ?? []).map(({ value }) => String(value.text));
}

/** The decision is read first and the other two writes after it, so a decision seen here was already on the PDS when they were read. */
export async function snapshotOfDecisionWrites(world: AppWorld, authority: Actor, channel: PrivateChannel, requester: Actor, requestUri: string): Promise<WriteSnapshot> {
  const decision = await decisionFor(world, authority, inboxOf(world), requestUri) !== undefined;
  const [members, roster] = await Promise.all([membersOf(world, authority, channel.space), activeRosterOf(world, authority, channel)]);
  const member = accessOf(members, requester.did);
  return { decision, member: member?.read === true && member.write, rosterActive: roster.includes(requester.did) };
}

/** Samples the three approval writes back to back until stopped. Each sample reads the decision first, so an early decision cannot hide behind later writes. */
export function watchDecisionWrites(sample: () => Promise<WriteSnapshot>): { stop(): Promise<WriteSnapshot[]> } {
  const snapshots: WriteSnapshot[] = [];
  let running = true;
  const loop = (async () => {
    while (running) snapshots.push(await sample());
  })();
  return {
    async stop() {
      running = false;
      await loop;
      return snapshots;
    },
  };
}

// --- Adversarial writes no UI can make -------------------------------------------------------------

/** Writes the join request into the requester's own repo on its own PDS with that account's token, bypassing the app. */
export async function writeRequestDirectly(world: AppWorld, requester: Actor, channel: PrivateChannel): Promise<SubmittedRequest> {
  const id = tidNow();
  const rkey = requestRecordKey(channel.space, requester.did);
  const result = await world.pdsPost(requester, "com.atproto.space.putRecord", {
    space: inboxOf(world), repo: requester.did, collection: JOIN_REQUEST, rkey,
    record: { $type: JOIN_REQUEST, channelSkey: channel.skey, requestId: id, createdAt: new Date().toISOString() },
  });
  assert.equal(result.status, 200, `writing the request into the requester's repo: ${JSON.stringify(result.body)}`);
  return { id, uri: requestUriOf(world, channel, requester) };
}

export async function unregisterAppNotifications(world: AppWorld, authority: Actor): Promise<void> {
  const inbox = inboxOf(world);
  const credential = await mintCredential(world, authority, inbox);
  await credential.client(authority.pdsUrl).procedure("com.atproto.space.unregisterNotify", { space: inbox, service: operatorServiceRef(world) });
}

/**
 * Takes the account off the inbox member list on the authority's PDS, the way an outage or a stale member list leaves it. The PDS
 * never evicts a writer from the set listRepos returns (that set only ever grows), so afterwards the account is a writer the
 * operator's member list no longer names.
 */
export async function removeFromInboxMembers(world: AppWorld, authority: Actor, account: Actor): Promise<void> {
  const removed = await world.pdsPost(authority, "com.atproto.simplespace.removeMember", { space: inboxOf(world), did: account.did });
  assert.equal(removed.status, 200, `removing ${account.role} from the inbox member list: ${JSON.stringify(removed.body)}`);
}

/** The inbox writers each discovery path can name right now: the operator's current member list and the PDS writer set. */
export async function inboxWriterSources(world: AppWorld, authority: Actor): Promise<{ operator: string[]; listRepos: string[] }> {
  const operator = await callOperator(world, authority, "org.slack.operator.listInboxWriters", { workspace: world.workspaceUri });
  assert.equal(operator.status, 200, operator.text);
  return { operator: (JSON.parse(operator.text) as { writers: string[] }).writers, listRepos: await writerSetOf(await mintCredential(world, authority, inboxOf(world)), authority) };
}

/** Calls the operator's own XRPC endpoint with a service-auth token minted by the caller's PDS, not through the app's UI routes. */
export async function callOperator(world: AppWorld, as: Actor, method: "org.slack.operator.listInboxWriters", params: Record<string, string>): Promise<{ status: number; text: string }> {
  const auth = await world.pdsGet<{ token?: string }>(as, "com.atproto.server.getServiceAuth", { aud: operatorServiceRef(world), lxm: method });
  assert.equal(auth.status, 200, `service auth for ${method}: ${JSON.stringify(auth.body)}`);
  assert.ok(auth.body.token, "the PDS issued a service-auth token");
  const url = new URL(`/xrpc/${method}`, world.appOrigin);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: { authorization: `Bearer ${auth.body.token}` } });
  return { status: response.status, text: await response.text() };
}

// --- What people do in the browser ------------------------------------------------------------------

function isExecuteCall(response: PlaywrightResponse): boolean {
  return new URL(response.url()).pathname === "/api/operator/execute" && response.request().method() === "POST";
}

async function outcomeOf(response: PlaywrightResponse): Promise<OperationOutcome> {
  const body = await response.json() as { operation?: { state?: string; error?: string; completedSteps?: string[] }; error?: string };
  return {
    status: response.status(), state: body.operation?.state, error: body.operation?.error ?? body.error,
    completedSteps: body.operation?.completedSteps ?? [],
  };
}

export async function createPrivateChannelAs(world: AppWorld, owner: Actor, name: string, memberDids: string[] = []): Promise<PrivateChannel> {
  const page = owner.page;
  await page.getByLabel("Channel name").fill(name);
  await page.getByLabel("Channel visibility").selectOption("private");
  if (memberDids.length > 0) await page.getByLabel("Private member DIDs").fill(memberDids.join(", "));
  const form = page.locator("form").filter({ has: page.getByLabel("Channel name") });
  const [response] = await Promise.all([page.waitForResponse(isExecuteCall), form.getByRole("button", { name: /Create channel/ }).click()]);
  const outcome = await outcomeOf(response);
  assert.equal(outcome.state, "completed", `creating the private channel: ${outcome.error ?? outcome.status}`);
  await page.locator(".channel-nav-item").filter({ hasText: name }).waitFor({ state: "visible" });
  return privateChannelNamed(world, owner, name);
}

/** A signed-in workspace owner who has approved admin controls. */
export async function ownerWithAdminControls(world: AppWorld): Promise<Actor> {
  const owner = await world.actor("owner", 0);
  await createWorkspaceAs(world, owner);
  await approveAdminControls(world, owner);
  return owner;
}

/** An owner with admin controls, a private channel, and nobody else yet. */
export async function workspaceWithPrivateChannel(world: AppWorld): Promise<{ owner: Actor; channel: PrivateChannel }> {
  const owner = await ownerWithAdminControls(world);
  return { owner, channel: await createPrivateChannelAs(world, owner, PRIVATE_CHANNEL_NAME) };
}

export async function joinWorkspaceAs(world: AppWorld, member: Actor): Promise<void> {
  await openInviteLinkAndSignIn(world, member, inviteLinkFor(world.appOrigin, world.workspaceUri));
  await joinFromInvitation(world, member);
  await member.page.getByRole("heading", { name: world.workspaceName, exact: true }).waitFor({ state: "visible" });
}

/** The owner adds the account to the workspace and the account accepts from the invite link. */
export async function onboardMember(world: AppWorld, owner: Actor, role: string, host: 0 | 1): Promise<Actor> {
  const member = await world.actor(role, host);
  await inviteMemberAs(owner, member.did);
  await joinWorkspaceAs(world, member);
  return member;
}

async function openPrivateChannel(member: Actor, channel: PrivateChannel): Promise<void> {
  await member.page.locator(".channel-nav-item").filter({ hasText: channel.name }).click();
  await member.page.getByText(/Grant workspace\/channel read scope/).waitFor({ state: "visible" });
}

async function clickRequestAccess(member: Actor): Promise<SubmittedRequest> {
  const page = member.page;
  const created = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/channels/requests" && response.status() === 201);
  await page.getByRole("button", { name: "Request private access →" }).last().click();
  const body = await (await created).json() as { requestId: string; uri: string };
  await page.getByText("Your access request is in the workspace inbox.", { exact: true }).waitFor({ state: "visible" });
  return { id: body.requestId, uri: body.uri };
}

/** First request from this account: the channel, the one-time write-only inbox permission, then the request itself. */
export async function requestPrivateAccessAs(world: AppWorld, member: Actor, channel: PrivateChannel): Promise<SubmittedRequest> {
  const page = member.page;
  await openPrivateChannel(member, channel);
  await page.getByRole("button", { name: "Request private access →" }).last().click();
  await page.getByText(/Grant write-only inbox access/).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Grant request access →" }).click();
  await completeConsent(member);
  await waitForApp(world, member);
  await page.getByText(/Grant workspace\/channel read scope/).waitFor({ state: "visible" });
  return clickRequestAccess(member);
}

export async function resubmitRequestAs(member: Actor): Promise<SubmittedRequest> {
  return clickRequestAccess(member);
}

export async function withdrawRequestAs(member: Actor): Promise<void> {
  const page = member.page;
  const withdrawn = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/channels/requests" && response.status() === 200);
  await page.getByRole("button", { name: "Withdraw request", exact: true }).click();
  assert.deepEqual(await (await withdrawn).json(), { withdrawn: true });
  await page.getByText("Your private-channel request was withdrawn.", { exact: true }).waitFor({ state: "visible" });
}

export function inboxRow(admin: Actor, requester: Actor, channel: PrivateChannel): Locator {
  return admin.page.locator(".roster-row").filter({ hasText: `${requester.did} requested #${channel.name}` });
}

export async function syncInbox(admin: Actor): Promise<void> {
  await admin.page.getByRole("button", { name: "Sync inbox ↻" }).click();
}

export async function decideInUi(admin: Actor, row: Locator, decision: "Approve" | "Deny"): Promise<OperationOutcome> {
  const [response] = await Promise.all([admin.page.waitForResponse(isExecuteCall), row.getByRole("button", { name: decision, exact: true }).click()]);
  return outcomeOf(response);
}

/** What the admin UI last learned from `/api/inbox/requests`, as the app reported it. */
export function inboxRequestsSeen(world: AppWorld, admin: Actor, from = 0): InboxRequest[][] {
  return world.callsTo(admin, "/api/inbox/requests").slice(from)
    .filter((call) => call.status === 200)
    .map((call) => (JSON.parse(call.responseBody) as { requests: InboxRequest[] }).requests);
}

/** An operator operation submitted through the admin's own signed-in browser session, exactly as the UI's Approve/Deny buttons do. */
export async function submitOperationAs(page: Page, workspace: string, request: Record<string, unknown>): Promise<OperationOutcome> {
  const result = await page.evaluate(async (payload) => {
    const response = await fetch("/api/operator/execute", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    return { status: response.status, body: await response.json() as { operation?: { state?: string; error?: string; completedSteps?: string[] }; error?: string } };
  }, { workspace, operationId: tidNow(), request });
  return {
    status: result.status, state: result.body.operation?.state, error: result.body.operation?.error ?? result.body.error,
    completedSteps: result.body.operation?.completedSteps ?? [],
  };
}

export async function postMessageAs(world: AppWorld, member: Actor, text: string): Promise<void> {
  const page = member.page;
  await page.getByPlaceholder("Write a message…").fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("button", { name: "Grant message posting →" }).click();
  await completeConsent(member);
  await waitForApp(world, member);
  await page.getByPlaceholder("Write a message…").fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText(text, { exact: true }).waitFor({ state: "visible" });
}

export async function grantChannelReadAs(world: AppWorld, member: Actor, channel: PrivateChannel): Promise<void> {
  await member.page.locator(".channel-nav-item").filter({ hasText: channel.name }).click();
  await member.page.getByRole("button", { name: "Grant channel read →" }).click();
  await completeConsent(member);
  await waitForApp(world, member);
  await member.page.getByPlaceholder("Write a message…").waitFor({ state: "visible" });
}

export async function openChannelRoster(member: Actor, channel: PrivateChannel): Promise<string[]> {
  await member.page.locator(".channel-nav-item").filter({ hasText: channel.name }).click();
  const roster = member.page.locator(".private-roster");
  await roster.getByText("Active private channel members").waitFor({ state: "visible" });
  const listed = await roster.locator("p").innerText();
  return listed.split(" · ").map((did) => did.trim()).filter(Boolean).sort();
}

export async function leaveChannelForWorkspaceHome(world: AppWorld, member: Actor): Promise<void> {
  await member.page.locator(".sidebar-action").filter({ hasText: world.workspaceName }).click();
  await member.page.getByRole("heading", { name: world.workspaceName, exact: true }).waitFor({ state: "visible" });
}
