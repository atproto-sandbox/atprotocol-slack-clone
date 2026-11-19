import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { generateSpaceKey } from "@flock/protocol/atproto/space-key";
import type { Locator } from "@playwright/test";
import { inviteLinkFor } from "@flock/web/app/ui/client-api";
import { listBoundedWriters } from "@flock/protocol/atproto/record-pages";
import { mintSpaceCredentialWith, SpaceCredentialError, type SpaceCredential } from "@flock/protocol/atproto/space-credential-core";
import { AtprotoClient } from "@flock/protocol/atproto/xrpc";
import { channelUri, decisionRecordKey, inboxUri, parseSpaceUri, requestRecordKey, spaceRecordUri, tidNow } from "@flock/protocol/keys";
import type { Actor, ApiCall, AppWorld } from "./world";
import { listingCalls } from "./channels-ui";
import { executeAs, submitAndWait, type Executed } from "./operator-calls";
import { waitForAdminControls, createWorkspaceAs, eventually, inviteMemberAs, joinFromInvitation, openInviteLinkAndSignIn } from "./ui";
import { memberspacePolicy } from "@flock/protocol/atproto/space-policy";

export const PRIVATE_CHANNEL_NAME = "Private Room";

const JOIN_REQUEST = "new.flock.joinRequest";
const JOIN_DECISION = "new.flock.joinDecision";
const CHANNEL_ROSTER = "new.flock.channel.roster";
const CHANNEL_MESSAGE = "new.flock.channel.message";

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
    resolveKemKey: world.resolveKemKey,
    fetchEndpoint: (request) => fetch(request),
    generateKey: generateSpaceKey,
  }, space);
}

export async function assertCredentialRefused(world: AppWorld, as: Actor, space: string, what: string): Promise<void> {
  const outcome = await mintCredential(world, as, space).then(() => null, (error: unknown) => error);
  assert.ok(outcome instanceof SpaceCredentialError, `${what}: the PDS should refuse a credential, got ${outcome === null ? "a credential" : String(outcome)}`);
  assert.deepEqual({ status: outcome.status, code: outcome.code }, { status: 403, code: "SpaceNotFound" }, `${what}: the PDS denies the credential because the account is not authorized for the space`);
}

export async function membersOf(world: AppWorld, as: Actor, space: string): Promise<Member[]> {
  const result = await world.pdsGet<{ members?: Member[] }>(as, "com.atproto.memberspace.listMembers", { space, limit: "1000" });
  assert.equal(result.status, 200, `listMembers ${space}: ${JSON.stringify(result.body)}`);
  return result.body.members ?? [];
}

export function accessOf(members: Member[], did: string): { read: boolean; write: boolean } | undefined {
  const member = members.find((entry) => entry.did === did);
  return member && { read: member.read, write: member.write };
}

export async function privateChannelNamed(world: AppWorld, authority: Actor, name: string): Promise<PrivateChannel> {
  const directory = await world.pdsGet<{ records?: Array<{ value: { skey: string; name: string; visibility: string } }> }>(
    authority, "com.atproto.space.listRecords", { space: world.workspaceUri, repo: authority.did, collection: "new.flock.directory", limit: "100" },
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
  const scan = await listBoundedWriters(credential.client(authority.pdsUrl), { space: credential.space, maxRepos: 1_000 });
  return scan.writers.map(({ repo }) => repo);
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

export function unregisterAppNotifications(world: AppWorld): void {
  const inbox = inboxOf(world);
  const db = new Database(world.fixture.databasePath, { fileMustExist: true });
  try {
    db.pragma("busy_timeout = 5000");
    const updated = db
      .prepare("UPDATE notification_registration SET token = 'dropped-notification-token' WHERE service_ref = ? AND space_uri = ?")
      .run(world.operatorServiceRef, inbox);
    assert.equal(updated.changes, 1, `expected an active notification_registration row for ${inbox}`);
  } finally {
    db.close();
  }
}

/**
 * Takes the account off the inbox member list on the authority's PDS, the way an outage or a stale member list leaves it. The PDS
 * drops the account from the writer set listWriters returns when it is removed, so afterwards the account is neither a member nor a
 * listed writer until it writes again while authorized.
 */
export async function removeFromInboxMembers(world: AppWorld, authority: Actor, account: Actor): Promise<void> {
  const removed = await world.pdsPost(authority, "com.atproto.memberspace.removeMembers", { space: inboxOf(world), dids: [account.did] });
  assert.equal(removed.status, 200, `removing ${account.role} from the inbox member list: ${JSON.stringify(removed.body)}`);
}

async function setInboxPublicWrite(world: AppWorld, authority: Actor, publicWrite: boolean): Promise<void> {
  const updated = await world.pdsPost(authority, "com.atproto.space.updateSpace", { space: inboxOf(world), policy: memberspacePolicy({ publicWrite }) });
  assert.equal(updated.status, 200, `setting the inbox policy to publicWrite=${publicWrite}: ${JSON.stringify(updated.body)}`);
}

/**
 * Leaves the account writing into the inbox as a tracked writer that the member list does not name. Removing a member evicts it
 * from the writer set, so the only way to get there is the one `updateSpace` leaves open: it does not re-evaluate the writer set.
 * The inbox is opened to public writes just long enough for the account's request to be tracked, then closed again.
 */
export async function writeRequestAsUnlistedWriter(world: AppWorld, authority: Actor, requester: Actor, channel: PrivateChannel): Promise<SubmittedRequest> {
  await removeFromInboxMembers(world, authority, requester);
  await setInboxPublicWrite(world, authority, true);
  try {
    return await writeRequestDirectly(world, requester, channel);
  } finally {
    await setInboxPublicWrite(world, authority, false);
  }
}

/** The inbox writers each discovery path can name right now: the operator's current member list and the PDS writer set. */
export async function inboxWriterSources(world: AppWorld, authority: Actor): Promise<{ operator: string[]; listWriters: string[] }> {
  const operator = await callOperator(world, authority, "new.flock.operator.listInboxWriters", { workspace: world.workspaceUri });
  assert.equal(operator.status, 200, operator.text);
  return { operator: (JSON.parse(operator.text) as { writers: string[] }).writers, listWriters: await writerSetOf(await mintCredential(world, authority, inboxOf(world)), authority) };
}

/** Calls the operator's own XRPC endpoint with a service-auth token minted by the caller's PDS, not through the app's UI routes. */
export async function callOperator(world: AppWorld, as: Actor, method: "new.flock.operator.listInboxWriters", params: Record<string, string>): Promise<{ status: number; text: string }> {
  const auth = await world.pdsGet<{ token?: string }>(as, "com.atproto.server.getServiceAuth", { aud: world.operatorServiceRef, lxm: method });
  assert.equal(auth.status, 200, `service auth for ${method}: ${JSON.stringify(auth.body)}`);
  assert.ok(auth.body.token, "the PDS issued a service-auth token");
  const url = new URL(`/xrpc/${method}`, world.operatorOrigin);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: { authorization: `Bearer ${auth.body.token}` } });
  return { status: response.status, text: await response.text() };
}

// --- What people do in the browser ------------------------------------------------------------------

function outcomeOf(executed: Executed): OperationOutcome {
  return { status: executed.status, state: executed.operation?.state, error: executed.operation?.error ?? executed.error, completedSteps: executed.operation?.completedSteps ?? [] };
}

/** The browser's own write of a join request record (put) or its removal (delete) since `since`, as the member's host answered. */
function joinRequestWrite(member: Actor, since: number, method: "putRecord" | "deleteRecord"): ApiCall | undefined {
  return member.xrpc.slice(since).find((call) => call.path === `/xrpc/com.atproto.space.${method}` && call.status === 200
    && (JSON.parse(call.requestBody) as { collection?: string }).collection === "new.flock.joinRequest");
}

export async function createPrivateChannelAs(world: AppWorld, owner: Actor, name: string, memberDids: string[] = []): Promise<PrivateChannel> {
  const page = owner.page;
  await page.getByLabel("Channel name").fill(name);
  await page.getByLabel("Channel visibility").selectOption("private");
  if (memberDids.length > 0) await page.getByLabel("Private member DIDs").fill(memberDids.join(", "));
  const form = page.locator("form").filter({ has: page.getByLabel("Channel name") });
  const executed = await submitAndWait(world, owner, () => form.getByRole("button", { name: /Create channel/ }).click());
  assert.equal(outcomeOf(executed).state, "completed", `creating the private channel: ${JSON.stringify(executed)}`);
  await page.locator(".channel-nav-item").filter({ hasText: name }).waitFor({ state: "visible" });
  return privateChannelNamed(world, owner, name);
}

/** A signed-in workspace owner whose admin controls are live. */
export async function ownerWithAdminControls(world: AppWorld): Promise<Actor> {
  const owner = await world.actor("owner", 0);
  await createWorkspaceAs(world, owner);
  await waitForAdminControls(world, owner);
  return owner;
}

/** An owner with admin controls, a private channel, and nobody else yet. */
export async function workspaceWithPrivateChannel(world: AppWorld): Promise<{ owner: Actor; channel: PrivateChannel }> {
  const owner = await ownerWithAdminControls(world);
  return { owner, channel: await createPrivateChannelAs(world, owner, PRIVATE_CHANNEL_NAME) };
}

export async function joinWorkspaceAs(world: AppWorld, member: Actor): Promise<void> {
  await openInviteLinkAndSignIn(world, member, inviteLinkFor(world.appOrigin, world.workspaceUri));
  await joinFromInvitation(member);
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
  await member.page.getByText("You are not on this channel’s active roster.").waitFor({ state: "visible" });
}

/** Sends the request (or updates it) from the roster card; the browser writes it to the account's own repo in the inbox. */
async function clickRequestAccess(member: Actor): Promise<SubmittedRequest> {
  const page = member.page;
  const since = member.xrpc.length;
  await page.getByRole("button", { name: /^(Request private access|Update request) →$/ }).click();
  const write = await eventually(() => joinRequestWrite(member, since, "putRecord"), { what: "the browser to write the join request" });
  const body = JSON.parse(write.requestBody) as { space: string; repo: string; rkey: string; record: { requestId: string } };
  await page.getByText("Your access request is in the workspace inbox.", { exact: true }).waitFor({ state: "visible" });
  return { id: body.record.requestId, uri: spaceRecordUri(body.space, body.repo, "new.flock.joinRequest", body.rkey) };
}

/** A first request from this account: the private channel's roster card, then the request; the browser's grant covers it. */
export async function requestPrivateAccessAs(member: Actor, channel: PrivateChannel): Promise<SubmittedRequest> {
  await openPrivateChannel(member, channel);
  return clickRequestAccess(member);
}

export async function resubmitRequestAs(member: Actor): Promise<SubmittedRequest> {
  return clickRequestAccess(member);
}

export async function withdrawRequestAs(member: Actor): Promise<void> {
  const page = member.page;
  const since = member.xrpc.length;
  await page.getByRole("button", { name: "Withdraw request", exact: true }).click();
  await eventually(() => joinRequestWrite(member, since, "deleteRecord"), { what: "the browser to delete the join request" });
  await page.getByText("Your private-channel request was withdrawn.", { exact: true }).waitFor({ state: "visible" });
}

export function inboxRow(admin: Actor, requester: Actor, channel: PrivateChannel): Locator {
  return admin.page.locator(".roster-row").filter({ hasText: `${requester.did} requested #${channel.name}` });
}

export async function syncInbox(admin: Actor): Promise<void> {
  await admin.page.getByRole("button", { name: "Sync inbox ↻" }).click();
}

export async function decideInUi(world: AppWorld, admin: Actor, row: Locator, decision: "Approve" | "Deny"): Promise<OperationOutcome> {
  return outcomeOf(await submitAndWait(world, admin, () => row.getByRole("button", { name: decision, exact: true }).click()));
}

const INBOX_WRITERS = "/xrpc/new.flock.operator.listInboxWriters";

/** The inbox sweeps the admin's app started since `from` (an index into its XRPC calls): each asks the operator for the inbox writers. */
export function inboxSweepsSince(admin: Actor, from: number): number {
  return admin.xrpc.slice(from).filter((call) => call.path === INBOX_WRITERS && call.status === 200).length;
}

/** The join requests the admin's browser read from the inbox writers' repos since `from` (an index into its XRPC calls). */
export function inboxRequestsSeen(admin: Actor, inbox: string, from: number): Array<{ repoDid: string; requestId: string; uri: string }> {
  return listingCalls(admin, "new.flock.joinRequest", from).filter(({ call, query }) => call.status === 200 && query.get("space") === inbox)
    .flatMap(({ call, query }) => {
      const repoDid = query.get("repo") ?? "";
      return (JSON.parse(call.responseBody) as { records: Array<{ rkey: string; value: { requestId?: unknown } }> }).records
        .map((record) => ({ repoDid, requestId: String(record.value.requestId), uri: spaceRecordUri(inbox, repoDid, "new.flock.joinRequest", record.rkey) }));
    });
}

/** An operator operation submitted as the admin, the way the UI's Approve/Deny buttons send it, with a body the page would not build. */
export async function submitOperationAs(world: AppWorld, admin: Actor, workspace: string, request: Record<string, unknown>): Promise<OperationOutcome> {
  return outcomeOf(await executeAs(world, admin, { workspace, operationId: tidNow(), request }));
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
