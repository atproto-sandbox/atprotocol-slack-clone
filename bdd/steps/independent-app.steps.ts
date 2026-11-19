import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Given, Then, When } from "@cucumber/cucumber";
import { expect, type Locator } from "@playwright/test";
import { canonicalJson, channelUri, decisionRecordKey, inboxUri, requestDigest, spaceRecordUri, subjectKey, tidNow } from "@flock/protocol/keys";
import { validateSpaceRecord } from "@flock/protocol/registry";
import type { SecondApp } from "../../protocol-tests/support/app-fixture";
import {
  createChannelAs, insertJournalRow, joinWorkspaceAt, listWriters, observeWorkspace, onPrimaryApp, openViewer,
  requestPrivateAccess, runNode, runProtocolTest, withIndependentReader, type ChildRun,
  type AppViewer, type WorkspaceObservation, type WorkspaceRead, workspaceRead,
} from "../support/independent-app-ui";
import { browserStore } from "../support/browser-store";
import { operatorAs } from "../support/engine";
import { decodeExecuted, executeCalls } from "../support/operator-calls";
import { OperatorRemoteError, type StalledWork } from "@flock/client/operator-client";
import { credentialCalls, credentialOutcome, openChannel, postMessage } from "../support/channels-ui";
import { waitForAdminControls, createWorkspaceAs, eventually, inviteMemberAs } from "../support/ui";
import type { Actor, AppWorld } from "../support/world";
import { memberSessionTablesIn } from "../support/app-database";

type PdsRecord = { uri: string; rkey: string; value: Record<string, unknown> };
type Directory = Array<{ skey: string; name: string; visibility: string }>;

const actorNamed = (world: AppWorld, role: string): Actor => {
  const actor = world.actors.get(role);
  assert.ok(actor, `this scenario has no ${role} yet`);
  return actor;
};

const viewerNamed = (world: AppWorld, role: string): AppViewer => onPrimaryApp(world, actorNamed(world, role));

async function recordsOf(world: AppWorld, author: Actor, space: string, collection: string): Promise<PdsRecord[]> {
  const result = await world.pdsGet<{ records?: PdsRecord[] }>(author, "com.atproto.space.listRecords", { space, repo: author.did, collection, limit: "100" });
  assert.equal(result.status, 200, `listRecords ${collection} in ${space}: ${JSON.stringify(result.body)}`);
  return result.body.records ?? [];
}

const activeSubjects = (records: PdsRecord[]): string[] =>
  records.filter((record) => record.value.active === true).map((record) => record.value.subject as string).sort();

async function directoryOf(world: AppWorld, authority: Actor): Promise<Directory> {
  const records = await recordsOf(world, authority, world.workspaceUri, "new.flock.directory");
  return records.map(({ value }) => ({ skey: value.skey as string, name: value.name as string, visibility: value.visibility as string }))
    .filter((entry) => entry.visibility !== "archived").sort((left, right) => left.name.localeCompare(right.name));
}

async function channelMessageTexts(world: AppWorld, authority: Actor, writers: Actor[], skey: string): Promise<string[]> {
  const space = channelUri(authority.did, skey);
  const listed = await listWriters(world, authority, space);
  const records: PdsRecord[] = [];
  for (const did of listed) {
    const writer = writers.find((candidate) => candidate.did === did);
    assert.ok(writer, `unexpected writer ${did} in ${space}`);
    records.push(...await recordsOf(world, writer, space, "new.flock.channel.message"));
  }
  return records.sort((left, right) => right.rkey.localeCompare(left.rkey)).map((record) => record.value.text as string);
}

// --- Render one workspace from two independent apps -------------------------------------------------

const OWNER_NOTE = "Owner note in general";
const VAULT_NOTE = "Member note in the private channel";
const MEMBER_NOTE = "Member note in general";

async function publishedLexiconIds(world: AppWorld): Promise<string[]> {
  const pds = world.fixture.pdsUrls[0];
  const resolved = await (await fetch(new URL("/xrpc/com.atproto.identity.resolveHandle?handle=lex-authority.test", pds))).json() as { did: string };
  const listing = await (await fetch(new URL(`/xrpc/com.atproto.repo.listRecords?repo=${encodeURIComponent(resolved.did)}&collection=com.atproto.lexicon.schema&limit=100`, pds))).json() as { records: Array<{ value: { id: string } }> };
  return listing.records.map((record) => record.value.id);
}

async function localLexiconIds(): Promise<string[]> {
  const root = join(process.cwd(), "packages/protocol/lexicons/new/flock");
  const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(".json"));
  return [...new Set(await Promise.all(files.map(async (file) => (JSON.parse(await readFile(join(root, file), "utf8")) as { id: string }).id)))];
}

Given("two apps use published lexicons, OAuth, and space credentials", { timeout: 900_000 }, async function (this: AppWorld) {
  const published = new Set(await publishedLexiconIds(this));
  const missing = (await localLexiconIds()).filter((id) => !published.has(id));
  assert.deepEqual(missing, [], "every lexicon the apps use is published to the lexicon authority");

  const second = await this.fixture.startSecondApp();
  this.scratch.set("secondApp", second);
  const metadata = await Promise.all([this.appOrigin, second.appUrl.origin].map(async (origin) =>
    (await fetch(new URL("/oauth/client-metadata.json", origin))).json() as Promise<{ client_id: string; redirect_uris: string[] }>));
  assert.notEqual(metadata[0].client_id, metadata[1].client_id, "each app is its own OAuth client");
  for (const [client, origin] of [[metadata[0], this.appOrigin], [metadata[1], second.appUrl.origin]] as const) {
    assert.ok(client.redirect_uris.length > 0, `${origin} publishes OAuth redirect URIs`);
    assert.deepEqual(client.redirect_uris.filter((uri) => !uri.startsWith(origin)), [], `every redirect URI of ${origin} points back at it`);
  }

  const owner = onPrimaryApp(this, await this.actor("owner", 0));
  await createWorkspaceAs(this, owner);
  await waitForAdminControls(this, owner);
  const member = onPrimaryApp(this, await this.actor("member", 1));
  await inviteMemberAs(owner, member.did);
  await createChannelAs(owner, "Second Room");
  await createChannelAs(owner, "Vault", { privateMembers: [member.did] });
  await owner.page.locator(".channel-nav-item").filter({ hasText: /general$/ }).click();
  await postMessage(owner, OWNER_NOTE);

  await joinWorkspaceAt(member, this.workspaceUri, this.workspaceName);
  await openChannel(member, "general");
  await postMessage(member, MEMBER_NOTE);
  await openChannel(member, "Vault");
  await postMessage(member, VAULT_NOTE);
});

When("each app syncs the same workspace", { timeout: 900_000 }, async function (this: AppWorld) {
  const second = this.scratch.get("secondApp") as SecondApp;
  const member = viewerNamed(this, "member");
  const onSecond = await openViewer(this, member, second.appUrl.origin, "member@second-app");
  await joinWorkspaceAt(onSecond, this.workspaceUri, this.workspaceName);
  this.scratch.set("observedFirst", await observeWorkspace(member, this.workspaceName, ["general", "Vault"]));
  this.scratch.set("observedSecond", await observeWorkspace(onSecond, this.workspaceName, ["general", "Vault"]));
});

Then("both show the same directory, roster, messages, and private roster", async function (this: AppWorld) {
  const first = this.scratch.get("observedFirst") as WorkspaceObservation;
  const second = this.scratch.get("observedSecond") as WorkspaceObservation;
  const owner = actorNamed(this, "owner");
  const member = actorNamed(this, "member");

  assert.deepEqual(second.directory, first.directory, "directory as listed in the sidebar");
  assert.deepEqual(second.state, first.state, "roster and admins the apps read for this workspace");
  assert.deepEqual(second.summary, first.summary);
  assert.deepEqual(second.messages, first.messages, "messages of every channel, newest first");
  assert.deepEqual(second.privateRosters, first.privateRosters, "private channel roster");

  const directory = await directoryOf(this, owner);
  const roster = activeSubjects(await recordsOf(this, owner, this.workspaceUri, "new.flock.workspace.roster"));
  const admins = activeSubjects(await recordsOf(this, owner, this.workspaceUri, "new.flock.admin"));
  const vault = directory.find((entry) => entry.name === "Vault");
  const general = directory.find((entry) => entry.name === "general");
  assert.ok(vault && general, "the directory records name the general and Vault channels");
  const vaultRoster = activeSubjects(await recordsOf(this, owner, channelUri(owner.did, vault.skey), "new.flock.channel.roster"));
  const generalTexts = await channelMessageTexts(this, owner, [owner, member], general.skey);
  const vaultTexts = await channelMessageTexts(this, owner, [owner, member], vault.skey);

  assert.deepEqual(first.directory, directory.map(({ name, visibility }) => ({ name, visibility })), "directory equals the authority's directory records on the PDS");
  assert.deepEqual(first.state.members, roster, "the roster the app read is the authority's roster records on the PDS");
  assert.deepEqual(first.state.admins, admins, "and so are its admins");
  assert.deepEqual(first.state.channels, directory, "and its channels, by key, are the authority's directory records");
  assert.equal(first.summary, `${roster.length} active members · ${directory.length} channels`);
  assert.deepEqual(first.messages.general, generalTexts, "messages equal the records in every writer's repo");
  assert.equal(generalTexts.length, 2, "both writers' messages are merged");
  assert.deepEqual(first.messages.Vault, vaultTexts);
  assert.deepEqual(first.privateRosters.Vault, vaultRoster);
  assert.deepEqual(vaultRoster, [member.did]);

  const independent = await withIndependentReader(this, member, async (reader, deps) => ({
    workspace: (await reader.listIndependentWorkspaces(deps)).find((entry) => entry.uri === this.workspaceUri),
    general: await reader.readIndependentChannelPage(deps, this.workspaceUri, general.skey),
    vault: await reader.readIndependentChannelPage(deps, this.workspaceUri, vault.skey),
    vaultRoster: await reader.readIndependentPrivateRoster(deps, this.workspaceUri, vault.skey),
  }));
  assert.ok(independent.workspace, "the stateless reader finds the workspace from the member's credentials alone");
  assert.deepEqual([...independent.workspace.members].sort(), roster);
  assert.deepEqual([...independent.workspace.admins].sort(), admins);
  assert.deepEqual(independent.workspace.channels.map(({ skey, name, visibility }) => ({ skey, name, visibility })).sort((a, b) => a.name.localeCompare(b.name)), directory);
  assert.deepEqual(independent.general.messages.map((message) => message.value.text), first.messages.general);
  assert.deepEqual(independent.vault.messages.map((message) => message.value.text), first.messages.Vault);
  assert.deepEqual(independent.vaultRoster, first.privateRosters.Vault);
});

/** The channel records an app's engine holds for the account in that app's browser, by space, writer, collection and key. */
async function heldRecordKeys(viewer: AppViewer): Promise<string[]> {
  return (await browserStore(viewer)).records.filter((record) => record.collection.startsWith("new.flock.channel."))
    .map((record) => `${record.space}|${record.repo}|${record.collection}|${record.rkey}`).sort();
}

Then("neither app reads the other's database or private cache", async function (this: AppWorld) {
  const second = this.scratch.get("secondApp") as SecondApp;
  assert.notEqual(second.databasePath, this.fixture.databasePath, "the apps run on different database files");
  assert.ok(existsSync(second.databasePath) && existsSync(this.fixture.databasePath));

  // Neither server knows who signed in to it: each browser holds its own session, in its own origin's store.
  for (const databasePath of [this.fixture.databasePath, second.databasePath]) assert.deepEqual(memberSessionTablesIn(databasePath), []);

  const secondViewer = actorNamed(this, "member@second-app") as AppViewer;
  const firstViewer = viewerNamed(this, "member");
  const firstHeld = await heldRecordKeys(firstViewer);
  const secondHeld = await heldRecordKeys(secondViewer);
  assert.ok(secondHeld.length > 0, "the second app's browser holds the channel records it read");
  assert.ok(secondHeld.some((key) => firstHeld.includes(key)), "both apps hold the same records, each in its own origin's store");
  const listedBySecond = new Set(secondViewer.xrpc.filter((call) => call.path === "/xrpc/com.atproto.space.listRecords" && call.status === 200)
    .map((call) => new URLSearchParams(call.query).get("space")));
  for (const key of secondHeld) {
    assert.ok(listedBySecond.has(key.split("|")[0]!), `the second app's browser listed ${key} from the PDS itself; nothing was copied from the other app`);
  }

  const reaches = (viewer: AppViewer, origin: string) => viewer.requestUrls.filter((url) => new URL(url).origin === origin);
  assert.deepEqual([...reaches(secondViewer, this.appOrigin), ...reaches(secondViewer, this.operatorOrigin)], [], "the second app's pages never call the first app or its operator");
  assert.deepEqual([...reaches(firstViewer, second.appUrl.origin), ...reaches(firstViewer, second.operatorUrl.origin)], [], "the first app's pages never call the second app or its operator");
  assert.ok(reaches(secondViewer, second.appUrl.origin).length > 0);
});

// --- Ignore spoofed authority records ---------------------------------------------------------------

const workspaceSkeyOf = (world: AppWorld): string => world.workspaceUri.split("/").at(-1)!;

async function writeAsMember(world: AppWorld, member: Actor, space: string, collection: string, rkey: string, value: Record<string, unknown>): Promise<void> {
  const result = await world.pdsPost(member, "com.atproto.space.putRecord", { space, repo: member.did, collection, rkey, record: { $type: collection, ...value } });
  assert.equal(result.status, 200, `the member's own repo accepts the ${collection} record: ${JSON.stringify(result.body)}`);
}

Given("a member writes an admin, decision, or roster record in their own repo", { timeout: 900_000 }, async function (this: AppWorld) {
  const owner = onPrimaryApp(this, await this.actor("owner", 0));
  await createWorkspaceAs(this, owner);
  await waitForAdminControls(this, owner);
  const member = onPrimaryApp(this, await this.actor("member", 1));
  const outsider = await this.actor("outsider", 0);
  await inviteMemberAs(owner, member.did);
  await createChannelAs(owner, "Vault", { privateMembers: [] });

  await joinWorkspaceAt(member, this.workspaceUri, this.workspaceName);
  await requestPrivateAccess(member, "Vault");
  await owner.page.getByRole("button", { name: "Sync inbox ↻" }).click();
  await owner.page.locator(".roster-row").filter({ hasText: `${member.did} requested #Vault` }).waitFor({ state: "visible" });

  const directory = await directoryOf(this, owner);
  const vault = directory.find((entry) => entry.name === "Vault");
  assert.ok(vault, "the Vault channel is in the directory");
  const inbox = inboxUri(owner.did, workspaceSkeyOf(this));
  const requests = await recordsOf(this, member, inbox, "new.flock.joinRequest");
  assert.equal(requests.length, 1, "the member has one real pending request");
  const request = requests[0]!;
  const requestUri = spaceRecordUri(inbox, member.did, "new.flock.joinRequest", request.rkey);
  const updatedAt = new Date().toISOString();

  await writeAsMember(this, member, this.workspaceUri, "new.flock.admin", subjectKey(member.did), { subject: member.did, active: true, updatedAt });
  await writeAsMember(this, member, this.workspaceUri, "new.flock.workspace.roster", subjectKey(outsider.did), { subject: outsider.did, active: true, updatedAt });
  await writeAsMember(this, member, inbox, "new.flock.joinDecision", decisionRecordKey(requestUri), {
    request: requestUri, requestId: request.value.requestId, decision: "approve", updatedAt,
  });
  this.scratch.set("vaultSkey", vault.skey);
});

type SyncedViews = {
  rosterRows: string[];
  memberRowAction: string;
  ownerSummary: string;
  pendingRequestShown: boolean;
  /** The roster and admins the member's own page read. */
  memberState: WorkspaceRead;
  memberSummary: string;
  memberHasWorkspaceControls: boolean;
  /** How the PDS answered the member's browser when it asked for the private channel's credential on opening it. */
  memberVaultCredentials: string[];
  memberStalled: { status: number; message?: string };
};

/** Presses Sync inbox until `result` shows. A click on a page that is still loading its workspace can be answered and then wiped, so one press is not enough. */
async function syncInboxUntilShown(owner: AppViewer, result: Locator): Promise<void> {
  await expect(async () => {
    await owner.page.getByRole("button", { name: "Sync inbox ↻" }).click();
    await expect(result).toBeVisible({ timeout: 10_000 });
  }).toPass({ timeout: 90_000 });
}

const STALLED_REFUSAL = "Actor is not an active workspace admin.";

/** The operator's stalled-work method as `actor`'s browser calls it, with its refusal kept. */
async function stalledAs(world: AppWorld, actor: Actor): Promise<{ status: number; message?: string; list?: StalledWork }> {
  try {
    return { status: 200, list: await operatorAs(world, actor).listStalledOperations(world.workspaceUri) };
  } catch (error) {
    if (!(error instanceof OperatorRemoteError)) throw error;
    return { status: error.status, message: error.message };
  }
}

/** What the admin sees after syncing the inbox and what the member's own app answers, read fresh from both pages. */
async function observeSyncedViews(world: AppWorld, owner: AppViewer, member: AppViewer, options: { requestPending: boolean }): Promise<SyncedViews> {
  await owner.page.goto(owner.origin);
  await owner.page.getByRole("heading", { name: world.workspaceName, exact: true }).waitFor({ state: "visible" });
  const pending = owner.page.locator(".roster-row").filter({ hasText: `${member.did} requested #Vault` });
  await syncInboxUntilShown(owner, options.requestPending ? pending : owner.page.getByText("No pending join requests."));
  const rows = owner.page.locator(".roster-row:not(.extension-row):not(.app-row)").filter({ hasNotText: "requested" });
  const memberRow = rows.filter({ hasText: member.did });

  const memberReadsFrom = member.xrpc.length;
  await member.page.goto(member.origin);
  await member.page.getByRole("heading", { name: world.workspaceName, exact: true }).waitFor({ state: "visible" });
  const memberState = await eventually(() => workspaceRead(member, world.workspaceUri, memberReadsFrom), { what: "the member's app to read the roster and admins" });
  const memberSummary = (await member.page.locator(".welcome-banner p").first().innerText()).trim();
  const memberHasWorkspaceControls = await member.page.getByRole("heading", { name: "Workspace controls" }).count() > 0;
  const vault = channelUri(owner.did, world.scratch.get("vaultSkey") as string);
  const since = member.xrpc.length;
  await openChannel(member, "Vault");
  const vaultCredentials = await eventually(() => credentialCalls(member, vault, since).length > 0 && credentialCalls(member, vault, since), { what: "the member's browser to ask for the private channel's credential" });
  const stalled = await stalledAs(world, member);

  return {
    rosterRows: (await rows.locator("span").allInnerTexts()).map((text) => text.trim()).sort(),
    memberRowAction: (await memberRow.getByRole("button").first().innerText()).trim(),
    ownerSummary: (await owner.page.locator(".welcome-banner p").first().innerText()).trim(),
    pendingRequestShown: await pending.isVisible(),
    memberState,
    memberSummary,
    memberHasWorkspaceControls,
    memberVaultCredentials: vaultCredentials.map(credentialOutcome),
    memberStalled: stalled,
  };
}

When("an app syncs the workspace", { timeout: 300_000 }, async function (this: AppWorld) {
  this.scratch.set("syncedViews", await observeSyncedViews(this, viewerNamed(this, "owner"), viewerNamed(this, "member"), { requestPending: true }));
});

Then("the app ignores the record because the workspace DID did not author it", { timeout: 600_000 }, async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const member = actorNamed(this, "member");
  const outsider = actorNamed(this, "outsider");
  const views = this.scratch.get("syncedViews") as SyncedViews;
  const inbox = inboxUri(owner.did, workspaceSkeyOf(this));
  const vaultSkey = this.scratch.get("vaultSkey") as string;

  const spoofs = [
    { space: this.workspaceUri, collection: "new.flock.admin", subject: member.did },
    { space: this.workspaceUri, collection: "new.flock.workspace.roster", subject: outsider.did },
  ];
  for (const spoof of spoofs) {
    const [written] = await recordsOf(this, member, spoof.space, spoof.collection);
    assert.ok(written, `the spoofed ${spoof.collection} record exists in the member's repo`);
    assert.equal(written.value.subject, spoof.subject);
    assert.equal(written.value.active, true);
    const context = { authorityDid: owner.did, spaceUri: spoof.space, rkey: written.rkey };
    const asMember = validateSpaceRecord(spoof.collection, written.value, { ...context, repoDid: member.did });
    assert.deepEqual(asMember, { valid: false, reason: "authority record has the wrong author" });
    assert.deepEqual(validateSpaceRecord(spoof.collection, written.value, { ...context, repoDid: owner.did }), { valid: true }, "the same record is valid when the workspace DID authors it");
    const authored = (await recordsOf(this, owner, spoof.space, spoof.collection)).filter((record) => record.value.subject === spoof.subject && record.value.active === true);
    assert.deepEqual(authored, [], `the workspace DID wrote no active ${spoof.collection} record for ${spoof.subject}`);
  }
  const [decision] = await recordsOf(this, member, inbox, "new.flock.joinDecision");
  assert.ok(decision, "the spoofed decision exists in the member's repo");
  const decisionContext = { authorityDid: owner.did, spaceUri: inbox, rkey: decision.rkey };
  assert.deepEqual(validateSpaceRecord("new.flock.joinDecision", decision.value, { ...decisionContext, repoDid: member.did }), { valid: false, reason: "authority record has the wrong author" });
  assert.deepEqual(validateSpaceRecord("new.flock.joinDecision", decision.value, { ...decisionContext, repoDid: owner.did }), { valid: true });
  assert.deepEqual(await recordsOf(this, owner, inbox, "new.flock.joinDecision"), [], "the authority recorded no decision");

  assert.deepEqual(views.rosterRows, [owner.did, member.did].sort(), "the roster the admin sees is unchanged");
  assert.equal(views.ownerSummary, "2 active members · 2 channels");
  assert.equal(views.memberRowAction, "Make admin", "the member is still not an admin");
  assert.equal(views.pendingRequestShown, true, "the approval the member wrote did not settle their own request");
  assert.deepEqual({ members: views.memberState.members, admins: views.memberState.admins }, { members: [owner.did, member.did].sort(), admins: [owner.did] }, "the member's app read the roster and admins unchanged by the forged records");
  assert.equal(views.memberSummary, "2 active members · 2 channels", "the member's app shows the roster unchanged by the forged roster record");
  assert.equal(views.memberHasWorkspaceControls, false, "the member's app does not take the forged admin record: no admin controls are offered");
  assert.equal(views.memberStalled.status, 403, "the admin-only operator read is refused to the member");
  assert.equal(views.memberStalled.message, STALLED_REFUSAL, "the refusal is the admin check's own, not a generic failure");
  assert.deepEqual([...new Set(views.memberVaultCredentials)], ["SpaceNotFound"], "the member still cannot read the private channel: the PDS refuses its credential");
  const vaultMembers = await this.pdsGet<{ members?: Array<{ did: string }> }>(owner, "com.atproto.memberspace.listMembers", { space: channelUri(owner.did, vaultSkey), limit: "1000" });
  assert.equal((vaultMembers.body.members ?? []).some((entry) => entry.did === member.did), false, "the PDS member list of the private channel is unchanged");

  await authorityWritesWhatTheMemberForged(this, viewerNamed(this, "owner"), viewerNamed(this, "member"), outsider);
});

/**
 * The positive control: the same three records, authored by the workspace DID through the owner's UI, change everything the
 * assertions above found unchanged. Without it those assertions would also hold for an app that never looked at records at all.
 */
async function authorityWritesWhatTheMemberForged(world: AppWorld, owner: AppViewer, member: AppViewer, outsider: Actor): Promise<void> {
  const inbox = inboxUri(owner.did, workspaceSkeyOf(world));
  const memberRow = owner.page.locator(".roster-row").filter({ hasNotText: "requested" }).filter({ hasText: member.did });
  await memberRow.getByRole("button", { name: "Make admin", exact: true }).click();
  await memberRow.getByRole("button", { name: "Demote admin", exact: true }).waitFor({ state: "visible", timeout: 60_000 });
  await inviteMemberAs(owner, outsider.did);
  const pending = owner.page.locator(".roster-row").filter({ hasText: `${member.did} requested #Vault` });
  await pending.getByRole("button", { name: "Approve", exact: true }).click();
  await pending.waitFor({ state: "hidden", timeout: 60_000 });

  const authored = await observeSyncedViews(world, owner, member, { requestPending: false });
  assert.deepEqual(authored.rosterRows, [owner.did, member.did, outsider.did].sort(), "a roster record authored by the workspace DID does change the roster the admin sees");
  assert.equal(authored.ownerSummary, "3 active members · 2 channels");
  assert.equal(authored.memberRowAction, "Demote admin", "an admin record authored by the workspace DID makes the member an admin");
  assert.deepEqual({ members: authored.memberState.members, admins: authored.memberState.admins }, { members: [owner.did, member.did, outsider.did].sort(), admins: [owner.did, member.did].sort() }, "records the workspace DID authored do change what the member's app reads");
  assert.equal(authored.memberSummary, "3 active members · 2 channels");
  assert.equal(authored.memberHasWorkspaceControls, true, "an admin record authored by the workspace DID gives the member admin controls in their own app");
  assert.equal(authored.memberStalled.status, 200, "and the admin-only operator read is then answered");
  assert.equal(authored.pendingRequestShown, false, "a decision authored by the workspace DID does settle the request");
  assert.ok(authored.memberVaultCredentials.includes("granted"), "the approved member's browser is then granted the private channel's credential");
  assert.equal((await recordsOf(world, owner, inbox, "new.flock.joinDecision")).length, 1);
}

// --- Do not infer membership from the writer set ----------------------------------------------------

const OWNER_ONLY_NOTE = "Only the owner has written here";
const FIRST_MEMBER_NOTE = "The member writes here for the first time";

Given("a workspace member has not written to a channel", { timeout: 900_000 }, async function (this: AppWorld) {
  const owner = onPrimaryApp(this, await this.actor("owner", 0));
  await createWorkspaceAs(this, owner);
  await waitForAdminControls(this, owner);
  const member = onPrimaryApp(this, await this.actor("member", 1));
  await inviteMemberAs(owner, member.did);
  await owner.page.locator(".channel-nav-item").filter({ hasText: /general$/ }).click();
  await postMessage(owner, OWNER_ONLY_NOTE);
  await joinWorkspaceAt(member, this.workspaceUri, this.workspaceName);
  const general = (await directoryOf(this, owner)).find((entry) => entry.name === "general");
  assert.ok(general);
  this.scratch.set("generalSpace", channelUri(owner.did, general.skey));
});

When("an app reads listWriters", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const space = this.scratch.get("generalSpace") as string;
  this.scratch.set("writers", await listWriters(this, owner, space));
});

Then("it does not treat absence from that writer set as absence from membership", { timeout: 300_000 }, async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const member = viewerNamed(this, "member");
  const space = this.scratch.get("generalSpace") as string;
  const writers = this.scratch.get("writers") as string[];
  assert.deepEqual(writers, [owner.did], "listWriters names only the account that has written");

  const members = await this.pdsGet<{ members?: Array<{ did: string; read: boolean; write: boolean }> }>(owner, "com.atproto.memberspace.listMembers", { space, limit: "1000" });
  const onList = (members.body.members ?? []).find((entry) => entry.did === member.did);
  assert.deepEqual(onList && { read: onList.read, write: onList.write }, { read: true, write: true }, "the PDS member list still has the member with read and write");

  await member.page.goto(member.origin);
  await member.page.getByText(/(^|\D)2 active members/).waitFor({ state: "visible" });
  await openChannel(member, "general");
  assert.ok(credentialCalls(member, space).map(credentialOutcome).includes("granted"), "the app reads the channel for the member with a PDS credential");
  await member.page.locator(".message-card > p").filter({ hasText: OWNER_ONLY_NOTE }).waitFor({ state: "visible" });

  await postMessage(member, FIRST_MEMBER_NOTE);
  assert.deepEqual(await listWriters(this, owner, space), [owner.did, member.did].sort(), "the member joins the writer set only by writing");
});

// --- Meet the workspace size envelope (delegated) ---------------------------------------------------
// No browser can create 200 accounts and 2,000,000 records, so this scenario runs the launch-envelope protocol test
// in a child process, once per cucumber run, and asserts on what it exits with and reports.

const ENVELOPE_TEST = "protocol-tests/performance-envelope.test.ts";
const ENVELOPE_TIMEOUT_MS = 90 * 60 * 1000;
let envelopeRun: Promise<ChildRun> | undefined;

type EnvelopeReport = { logicalMembers: number; channels: number; messagesPerChannel: number; inboxWriterReconciliationMs: number };

function envelopeReport(run: ChildRun): EnvelopeReport {
  const line = /PERFORMANCE_ENVELOPE (\{.*\})/.exec(run.output);
  assert.ok(line, `the envelope run printed no report.\n${run.output.slice(-3_000)}`);
  return JSON.parse(line[1]!) as EnvelopeReport;
}

Given("a workspace has 200 members, 100 channels, and 20000 messages per channel", function (this: AppWorld) {
  assert.ok(existsSync(ENVELOPE_TEST), "the launch-envelope workload exists");
});

When("an admin inbox and a channel are synchronized", { timeout: ENVELOPE_TIMEOUT_MS + 60_000 }, async function (this: AppWorld) {
  envelopeRun ??= runProtocolTest(ENVELOPE_TEST, ENVELOPE_TIMEOUT_MS);
  this.scratch.set("envelopeRun", await envelopeRun);
});

Then("writer reconciliation completes within 60 seconds", function (this: AppWorld) {
  const run = this.scratch.get("envelopeRun") as ChildRun;
  assert.equal(run.exitCode, 0, `the envelope workload failed.\n${run.output.slice(-3_000)}`);
  assert.match(run.output, /# fail 0\b/);
  const report = envelopeReport(run);
  assert.deepEqual({ members: report.logicalMembers, channels: report.channels, messages: report.messagesPerChannel }, { members: 200, channels: 100, messages: 20_000 }, "the measured workspace is at the launch envelope");
  assert.ok(report.inboxWriterReconciliationMs <= 60_000, `writer reconciliation took ${report.inboxWriterReconciliationMs} ms`);
});

Then("opening the channel loads the latest 100 messages first", function (this: AppWorld) {
  const run = this.scratch.get("envelopeRun") as ChildRun;
  assert.equal(run.exitCode, 0, `the envelope workload failed.\n${run.output.slice(-3_000)}`);
  assert.match(run.output, /# fail 0\b/);
  assert.match(run.output, /^ok \d+ - supported-size workload: 200 members, 100 channels, 20,000 messages/m, "the workload that asserts the latest-100 pages of both readers ran and passed");
});

// --- Alert on stalled admin work --------------------------------------------------------------------

type StalledList = StalledWork;
type BoundarySample = { before: number; after: number; listed: boolean };
type StalledChecks = {
  uiAlert: string;
  api: StalledList;
  reconcile: ChildRun;
  samples: BoundarySample[];
  probeId: string;
  boundaryMs: number;
};

const STALL_SECONDS = 300;
const RECONCILE_TIMEOUT_MS = 120_000;

function journalRowFor(world: AppWorld, owner: Actor, ageSeconds: number): { operationId: string; updatedAt: number } {
  const operationId = tidNow();
  const request = { kind: "inviteMember", subject: owner.did };
  const updatedAt = insertJournalRow(world, {
    workspaceDid: owner.did, workspaceUri: world.workspaceUri, actor: owner.did, operationId,
    requestHash: requestDigest({ workspace: world.workspaceUri, request }),
    requestJson: canonicalJson({ workspace: world.workspaceUri, request }), state: "running", ageSeconds,
  });
  return { operationId, updatedAt };
}

Given("a journaled operation has made no progress for five minutes", { timeout: 300_000 }, async function (this: AppWorld) {
  const owner = onPrimaryApp(this, await this.actor("owner", 0));
  await createWorkspaceAs(this, owner);
  await waitForAdminControls(this, owner);
  assert.equal(await owner.page.locator(".operation-alert").count(), 0, "a healthy workspace shows no operator alert");
  const stalled = journalRowFor(this, owner, STALL_SECONDS);
  const recent = journalRowFor(this, owner, 60);
  this.scratch.set("stalledOperation", stalled);
  this.scratch.set("recentOperation", recent);
});

async function probeFiveMinuteBoundary(world: AppWorld, owner: AppViewer): Promise<Pick<StalledChecks, "samples" | "probeId" | "boundaryMs">> {
  const probe = journalRowFor(world, owner, STALL_SECONDS - 3);
  const boundaryMs = (probe.updatedAt + STALL_SECONDS) * 1000;
  const operator = operatorAs(world, owner);
  const samples: BoundarySample[] = [];
  while (samples.length === 0 || samples.at(-1)!.before < boundaryMs + 300) {
    const before = Date.now();
    const list = await operator.listStalledOperations(world.workspaceUri);
    const after = Date.now();
    samples.push({ before, after, listed: list.operations.some((operation) => operation.operationId === probe.operationId) });
    assert.ok(after < boundaryMs + 10_000, "the probe crossed the five-minute mark");
  }
  return { samples, probeId: probe.operationId, boundaryMs };
}

When("the operator checks its pending operations", { timeout: 300_000 }, async function (this: AppWorld) {
  const owner = viewerNamed(this, "owner");
  await owner.page.goto(owner.origin);
  await owner.page.getByRole("heading", { name: this.workspaceName, exact: true }).waitFor({ state: "visible" });
  const alert = owner.page.locator(".operation-alert");
  await alert.waitFor({ state: "visible" });
  const uiAlert = await alert.innerText();

  const api = await operatorAs(this, owner).listStalledOperations(this.workspaceUri);

  const reconcile = await runProtocolReconcile(this);
  const boundary = await probeFiveMinuteBoundary(this, owner);
  this.scratch.set("stalledChecks", { uiAlert, api, reconcile, ...boundary } satisfies StalledChecks);
});

Then("it raises an operator alert with the operation status", function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const stalled = this.scratch.get("stalledOperation") as { operationId: string; updatedAt: number };
  const recent = this.scratch.get("recentOperation") as { operationId: string };
  const checks = this.scratch.get("stalledChecks") as StalledChecks;

  assert.match(checks.uiAlert, /1 operation\(s\) have had no progress for at least five minutes/);
  assert.match(checks.uiAlert, new RegExp(`${stalled.operationId} · ${owner.did} · running`), "the admin screen alert names the operation and its status");
  assert.doesNotMatch(checks.uiAlert, new RegExp(recent.operationId), "an operation that moved a minute ago raises no alert");

  assert.deepEqual(checks.api.operations, [{
    actor: owner.did, operationId: stalled.operationId, state: "running", updatedAt: new Date(stalled.updatedAt * 1000).toISOString(),
  }], "the operator's own method lists it; an operation without an error has no error field");
  assert.equal(checks.api.truncated, false);

  const alertLine = new RegExp(`ALERT stalled operation ${stalled.operationId} actor=${owner.did} state=running since=${new Date(stalled.updatedAt * 1000).toISOString()}`);
  assert.match(checks.reconcile.output, alertLine, "the scheduled reconcile job alerts on stderr with the status");
  assert.doesNotMatch(checks.reconcile.output, new RegExp(recent.operationId));
  assert.equal(checks.reconcile.exitCode, 1, "the scheduled job fails so its stderr reaches the operator");

  const beforeMark = checks.samples.filter((sample) => sample.after < checks.boundaryMs);
  const afterMark = checks.samples.filter((sample) => sample.before >= checks.boundaryMs);
  assert.ok(beforeMark.some((sample) => sample.before >= checks.boundaryMs - 1_000), "the probe was observed during its last second before five minutes");
  assert.deepEqual(beforeMark.filter((sample) => sample.listed), [], "no alert at four minutes fifty-nine seconds");
  assert.ok(afterMark.length > 0, "the probe was observed after five minutes");
  assert.deepEqual(afterMark.filter((sample) => !sample.listed), [], "the alert is raised at five minutes");
});

async function runProtocolReconcile(world: AppWorld): Promise<ChildRun> {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_ENV: "production", ATPROTO_ACCEPTANCE_TEST: "true",
    APP_URL: world.appOrigin, OPERATOR_URL: world.operatorOrigin, DATABASE_PATH: world.fixture.databasePath, AUTH_ENCRYPTION_KEY: "7".repeat(64),
    PLC_URL: world.fixture.plcUrl, OPERATOR_SERVICE_REF: world.operatorServiceRef,
    FLOCK_ADMIN_MUTATIONS_PAUSED: "true",
  };
  return runNode(["--import", "tsx", "apps/operator/scripts/reconcile-workspaces.ts"], { env: environment, timeoutMs: RECONCILE_TIMEOUT_MS, what: "the scheduled reconcile job" });
}

// --- Stop new work with the operator pause switch ---------------------------------------------------

const PAUSED_MESSAGE = "Workspace admin mutations are paused.";

async function pdsSnapshot(world: AppWorld, owner: Actor): Promise<unknown> {
  const channels = await world.pdsGet<{ spaces: Array<{ space: string }> }>(owner, "com.atproto.space.listSpaces", { spaceType: "new.flock.channel", limit: "100" });
  const spaces = [world.workspaceUri, inboxUri(owner.did, workspaceSkeyOf(world)), ...channels.body.spaces.map((entry) => entry.space)].sort();
  const memberLists: Record<string, string[]> = {};
  for (const space of spaces) {
    const listed = await world.pdsGet<{ members?: Array<{ did: string; read: boolean; write: boolean }> }>(owner, "com.atproto.memberspace.listMembers", { space, limit: "1000" });
    assert.equal(listed.status, 200, `listMembers ${space}: ${JSON.stringify(listed.body)}`);
    memberLists[space] = (listed.body.members ?? []).map((entry) => `${entry.did} read=${entry.read} write=${entry.write}`).sort();
  }
  const records: Record<string, PdsRecord[]> = {};
  for (const collection of ["new.flock.workspace.profile", "new.flock.directory", "new.flock.workspace.roster", "new.flock.admin"]) {
    records[collection] = (await recordsOf(world, owner, world.workspaceUri, collection)).sort((left, right) => left.rkey.localeCompare(right.rkey));
  }
  return { memberLists, records };
}

Given("the owner has paused admin mutations", { timeout: 900_000 }, async function (this: AppWorld) {
  const owner = onPrimaryApp(this, await this.actor("owner", 0));
  await createWorkspaceAs(this, owner);
  await waitForAdminControls(this, owner);
  const member = await this.actor("member", 1);
  await this.actor("invitee", 1);
  await inviteMemberAs(owner, member.did);
  this.scratch.set("snapshotBefore", await pdsSnapshot(this, owner));

  const paused = await this.fixture.startSecondApp({ env: { FLOCK_ADMIN_MUTATIONS_PAUSED: "true" } });
  this.scratch.set("pausedApp", paused);
  const onPaused = await openViewer(this, owner, paused.appUrl.origin, "owner@paused-app");
  await joinWorkspaceAt(onPaused, this.workspaceUri, this.workspaceName);
});

When("an admin submits a mutation", { timeout: 300_000 }, async function (this: AppWorld) {
  const invitee = actorNamed(this, "invitee");
  const onPaused = actorNamed(this, "owner@paused-app");
  const pauseShown = onPaused.page.waitForFunction(
    (message) => [...document.querySelectorAll("[role=alert]")].some((alert) => alert.textContent?.includes(message)),
    PAUSED_MESSAGE,
  ).then(() => true, () => false);
  await onPaused.page.getByLabel("Member DID", { exact: true }).fill(invitee.did);
  await onPaused.page.getByRole("button", { name: /Invite member/ }).click();
  await eventually(() => executeCalls(onPaused)[0], { what: "the paused app's operator to answer the mutation", timeoutMs: 60_000 });
  this.scratch.set("pauseMessageShown", await pauseShown);
});

Then("the operator rejects or queues it as paused", function (this: AppWorld) {
  const onPaused = actorNamed(this, "owner@paused-app");
  const paused = this.scratch.get("pausedApp") as SecondApp;
  const attempts = executeCalls(onPaused).map(decodeExecuted);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]!.status, 423);
  assert.equal(attempts[0]!.error, PAUSED_MESSAGE);
  assert.equal(this.scratch.get("pauseMessageShown"), true, "the person is told the mutation is paused");
  const journal = new Database(paused.databasePath, { readonly: true, fileMustExist: true });
  try {
    assert.equal((journal.prepare("SELECT COUNT(*) AS count FROM operation").get() as { count: number }).count, 0, "a paused mutation is rejected, not journaled or queued");
  } finally { journal.close(); }
});

Then("committed PDS records and member lists remain unchanged", async function (this: AppWorld) {
  const owner = actorNamed(this, "owner");
  const onPaused = actorNamed(this, "owner@paused-app");
  await onPaused.page.getByText(/is still pending\. Retry same operation/).waitFor({ state: "visible" });
  assert.equal(await onPaused.page.getByText(/^Added /).count(), 0, "the UI does not claim the member was added");
  const before = this.scratch.get("snapshotBefore");
  const after = await pdsSnapshot(this, owner);
  assert.deepEqual(after, before, "member lists and authority records on the PDS are exactly as before the attempt");
  assert.doesNotMatch(JSON.stringify(after), new RegExp(actorNamed(this, "invitee").did), "the invitee is on no member list or record");
});
