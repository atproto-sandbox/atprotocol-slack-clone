import assert from "node:assert/strict";
import { createDecipheriv } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { JoseKey } from "@atproto/jwk-jose";
import type { Frame, Locator, Page, Response as PlaywrightResponse } from "@playwright/test";
import Database from "better-sqlite3";
import { listBoundedRecords, listBoundedRepos } from "@/atproto/record-pages";
import { mintSpaceCredentialWith, SpaceCredentialError, type SpaceCredential, type SpaceCredentialDeps } from "@/atproto/space-credential-core";
import { AtprotoClient } from "@/atproto/xrpc";
import { dmConversationUri, dmInboxUri, parseDmConversationUri, tidNow } from "@/protocol/keys";
import type { FixtureAccount } from "../../protocol-tests/support/app-fixture";
import { completeConsent, signInIfPrompted } from "./ui";
import type { Actor, AppWorld } from "./world";

// One helper per thing a person does with direct messages, plus an independent Node-side view of the PDS
// (`DmpProbe`) so a step can check what the recipient's PDS tracks without trusting the browser client.

export type DmpMode = "Everyone" | "Only people I allow" | "Nobody";
export type DmpRequestRow = { section: "shared" | "others"; sender: string };
export type DmpParticipantRow = { did: string; chip: string | null };

export async function dmpPoll<T>(read: () => Promise<T | undefined | null | false>, options: { timeoutMs?: number; what: string }): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${options.what}.`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

// --- Signing in and connecting direct messages ------------------------------------------------------

/** Signs in to the app served at `origin` with the actor's DID and approves the PDS consent screen. */
export async function dmpSignInAt(actor: Actor, origin: string): Promise<void> {
  await actor.page.goto(origin);
  await actor.page.getByLabel("Your AT Protocol handle").fill(actor.did);
  await actor.page.getByRole("button", { name: /Continue with atproto/i }).click();
  await actor.page.locator("input[name=password]").waitFor({ state: "visible" });
  await completeConsent(actor);
  await dmpWaitForOrigin(actor, origin);
}

export async function dmpWaitForOrigin(actor: Actor, origin: string): Promise<void> {
  await actor.page.waitForURL((url) => url.origin === origin && !url.pathname.startsWith("/oauth"), { timeout: 30_000 });
}

/** The separate, browser-held DM sign-in: its own consent screen, its own OAuth client. */
export async function dmpConnectDms(actor: Actor): Promise<void> {
  await actor.page.getByRole("button", { name: /Connect direct messages/ }).click();
  await completeConsent(actor);
  await dmpWaitForDmReady(actor);
}

/** Like `dmpConnectDms`, and reports the scopes the PDS consent screen listed for this separate DM sign-in. */
export async function dmpConnectDmsReadingScope(actor: Actor): Promise<string[]> {
  await actor.page.getByRole("button", { name: /Connect direct messages/ }).click();
  await actor.page.waitForURL(/\/oauth\/authorize\?/, { timeout: 30_000 });
  await signInIfPrompted(actor);
  await actor.page.getByRole("button", { name: "Authorize", exact: true }).waitFor({ state: "visible" });
  const shown = await actor.page.evaluate(() => (window as unknown as { __authorizeData?: { scope?: string } }).__authorizeData?.scope ?? "");
  await actor.page.getByRole("button", { name: "Authorize", exact: true }).click();
  await dmpWaitForDmReady(actor);
  return shown.split(" ").filter(Boolean);
}

export async function dmpWaitForDmReady(actor: Actor): Promise<void> {
  await actor.page.getByRole("button", { name: /New message/ }).waitFor({ state: "visible", timeout: 45_000 });
}

export async function dmpReload(actor: Actor): Promise<void> {
  await actor.page.reload();
  await dmpWaitForDmReady(actor);
}

// --- Settings ---------------------------------------------------------------------------------------

export async function dmpOpenSettings(actor: Actor): Promise<void> {
  await actor.page.getByRole("button", { name: "DM settings" }).click();
  await actor.page.getByRole("heading", { name: "Request settings" }).waitFor({ state: "visible" });
}

async function dmpWaitIdle(actor: Actor): Promise<void> {
  await actor.page.waitForFunction(() => document.querySelectorAll('input[name="dm-request-mode"]:disabled').length === 0);
}

/** Enabling creates the inbox with the default "Only people I allow". */
export async function dmpEnableDms(actor: Actor): Promise<void> {
  await dmpOpenSettings(actor);
  await actor.page.getByRole("button", { name: "Enable direct messages" }).click();
  await actor.page.getByText(/Current mode: Only people I allow/).waitFor({ state: "visible" });
  await dmpWaitIdle(actor);
}

export async function dmpChooseMode(actor: Actor, mode: DmpMode): Promise<void> {
  await dmpOpenSettings(actor);
  await actor.page.getByRole("radio", { name: mode, exact: true }).click();
  await actor.page.getByText(`Current mode: ${mode}`).waitFor({ state: "visible" });
  await dmpWaitIdle(actor);
}

export async function dmpAllowDid(actor: Actor, did: string): Promise<void> {
  await dmpOpenSettings(actor);
  await actor.page.getByLabel("Allow a DID").fill(did);
  await actor.page.getByRole("button", { name: "Add to allowlist →" }).click();
  await actor.page.locator(".roster-row").filter({ hasText: did }).waitFor({ state: "visible" });
  await dmpWaitIdle(actor);
}

// --- Conversations ----------------------------------------------------------------------------------

/** Starts a conversation and returns the per-recipient delivery outcome the sender is shown. */
export async function dmpStartConversation(actor: Actor, dids: readonly string[]): Promise<Record<string, string>> {
  await actor.page.getByRole("button", { name: /New message/ }).click();
  await actor.page.getByLabel("Participant DIDs").fill(dids.join(" "));
  await actor.page.getByRole("button", { name: "Start conversation" }).click();
  const card = actor.page.locator(".starter-card").filter({ has: actor.page.getByRole("heading", { name: "Delivery results" }) });
  await card.waitFor({ state: "visible", timeout: 60_000 });
  const outcomes: Record<string, string> = {};
  for (const row of await card.locator(".roster-row").all()) {
    outcomes[await row.locator("small.mono-note").innerText()] = await row.locator(".status-note").innerText();
  }
  return outcomes;
}

export async function dmpOpenConversationWith(actor: Actor, others: readonly Actor[]): Promise<void> {
  let entries: Locator = actor.page.locator(".channel-nav-item").filter({ hasText: "◈" });
  for (const other of others) entries = entries.filter({ hasText: other.handle });
  await entries.first().click();
  await actor.page.getByRole("heading", { name: /^◈/ }).waitFor({ state: "visible" });
  await actor.page.getByText("Participants", { exact: true }).waitFor({ state: "visible" });
}

export async function dmpSend(actor: Actor, text: string): Promise<void> {
  await actor.page.getByPlaceholder("Write a message…").fill(text);
  await actor.page.getByRole("button", { name: "Send", exact: true }).click();
  await actor.page.getByText(text, { exact: true }).waitFor({ state: "visible" });
}

export async function dmpSync(actor: Actor): Promise<void> {
  await actor.page.getByRole("button", { name: /Sync/ }).click();
}

export async function dmpMessageTexts(actor: Actor): Promise<string[]> {
  return actor.page.locator(".message-list .message-card > p").allInnerTexts();
}

export async function dmpParticipantRows(actor: Actor): Promise<DmpParticipantRow[]> {
  const rows: DmpParticipantRow[] = [];
  for (const row of await actor.page.locator(".private-roster .roster-row").all()) {
    const chip = row.locator(".status-note");
    rows.push({ did: await row.locator("small.mono-note").innerText(), chip: await chip.count() > 0 ? await chip.innerText() : null });
  }
  return rows;
}

export async function dmpSidebarConversationLabels(actor: Actor): Promise<string[]> {
  return actor.page.locator(".channel-nav-item").filter({ hasText: "◈" }).allInnerTexts();
}

// --- Requests folder --------------------------------------------------------------------------------

export async function dmpRequestCount(actor: Actor): Promise<number> {
  const label = await actor.page.getByRole("button", { name: /^✉\s*Requests \(\d+\)/ }).innerText();
  return Number(/\((\d+)\)/.exec(label)?.[1]);
}

export async function dmpOpenRequests(actor: Actor): Promise<void> {
  await actor.page.getByRole("button", { name: /Requests \(\d+\)/ }).click();
  await actor.page.getByRole("heading", { name: "Requests", exact: true }).waitFor({ state: "visible" });
}

export type DmpRequestsRead = { rows: DmpRequestRow[]; scannedWriters: string[] };

/**
 * Reloads and waits for the new document's first scan to finish before anything is read. The DM provider renews the
 * inbox notification registration only after `refresh()` (conversations, request scan, inbox) and `renotifyPending()`
 * have returned, so that request marks a settled folder. Requests of the old document are ignored (`committed`).
 * Returns the writers the user's own PDS handed to the browser's scan, which is the candidate set the client filters.
 */
export async function dmpReloadThroughScan(actor: Actor): Promise<string[]> {
  const { page } = actor;
  const inbox = dmInboxUri(actor.did);
  let committed = false;
  const listings: Array<Promise<string[]>> = [];
  const markCommitted = (frame: Frame): void => {
    if (frame === page.mainFrame()) committed = true;
  };
  const collectListing = (response: PlaywrightResponse): void => {
    const url = new URL(response.url());
    if (!committed || response.status() !== 200 || !url.pathname.endsWith("/xrpc/com.atproto.space.listRepos") || url.searchParams.get("space") !== inbox) return;
    const listing = response.json().then((body: { repos?: Array<{ did: string }> }) => (body.repos ?? []).map((repo) => repo.did));
    listings.push(listing);
    void listing.catch(() => undefined);
  };
  page.on("framenavigated", markCommitted);
  page.on("response", collectListing);
  try {
    const registered = page.waitForRequest(
      (request) => committed && request.url().includes("/xrpc/com.atproto.space.registerNotify") && (request.postData() ?? "").includes(inbox),
      { timeout: 60_000 },
    );
    await page.reload();
    await registered;
    await dmpWaitForDmReady(actor);
  } finally {
    page.off("framenavigated", markCommitted);
    page.off("response", collectListing);
  }
  assert.ok(listings.length > 0, "the browser listed the writers of its own inbox after the reload, so the scan ran");
  return [...new Set((await Promise.all(listings)).flat())].sort();
}

/** Reloads through a finished scan, opens the requests folder, and reads which section each listed request sits in. */
export async function dmpReadRequestsScanned(actor: Actor): Promise<DmpRequestsRead> {
  const scannedWriters = await dmpReloadThroughScan(actor);
  await dmpOpenRequests(actor);
  const rows: DmpRequestRow[] = [];
  const sections: Array<[DmpRequestRow["section"], string]> = [["shared", "From people you share a workspace with"], ["others", "Others"]];
  for (const [section, heading] of sections) {
    const card = actor.page.locator(".starter-card").filter({ has: actor.page.getByRole("heading", { name: heading, exact: true }) });
    for (const row of await card.locator(".roster-row").all()) rows.push({ section, sender: await row.locator("small.mono-note").innerText() });
  }
  assert.equal(await dmpRequestCount(actor), rows.length, "the sidebar count and the folder list agree");
  return { rows, scannedWriters };
}

export async function dmpReadRequests(actor: Actor): Promise<DmpRequestRow[]> {
  return (await dmpReadRequestsScanned(actor)).rows;
}

export async function dmpRequestSenders(actor: Actor): Promise<string[]> {
  return actor.page.locator(".roster-row small.mono-note").allInnerTexts();
}

export async function dmpAllowlistDids(actor: Actor): Promise<string[]> {
  const card = actor.page.locator(".starter-card").filter({ has: actor.page.getByRole("heading", { name: "Allowlist", exact: true }) });
  return (await card.locator(".roster-row small.mono-note").allInnerTexts()).sort();
}

export async function dmpAcceptRequestFrom(actor: Actor, senderDid: string): Promise<void> {
  await dmpOpenRequests(actor);
  const row = actor.page.locator(".roster-row").filter({ hasText: senderDid });
  await row.getByRole("button", { name: "Accept", exact: true }).click();
  await actor.page.getByText("Participants", { exact: true }).waitFor({ state: "visible" });
}

// --- An independent view of the PDS -----------------------------------------------------------------

export type DmpTrackedWriter = { did: string; rev: string };
export type DmpCredentialOutcome = "minted" | "SpaceNotFound" | "SpaceDeleted" | "denied";

/** Reads spaces straight from the PDS with freshly minted space credentials, the way any conforming client would. */
export class DmpProbe {
  constructor(private readonly world: AppWorld, private readonly as: FixtureAccount) {}

  private pdsOf(did: string): string {
    const known = [...this.world.actors.values()].find((actor) => actor.did === did);
    if (!known) throw new Error(`No PDS is known for ${did}.`);
    return known.pdsUrl;
  }

  deps(): SpaceCredentialDeps {
    const as = this.as;
    return {
      memberClient: new AtprotoClient(async (path, init) => {
        const headers = new Headers(init.headers);
        headers.set("authorization", `Bearer ${as.accessJwt}`);
        return fetch(new URL(path, as.pdsUrl), { ...init, headers, redirect: "error" });
      }),
      resolvePds: async (did) => this.pdsOf(did),
      fetchEndpoint: (request) => fetch(request),
      generateKey: () => JoseKey.generate(["ES256"]),
    };
  }

  mint(space: string): Promise<SpaceCredential> {
    return mintSpaceCredentialWith(this.deps(), space);
  }

  async credentialOutcome(space: string): Promise<DmpCredentialOutcome> {
    try {
      await this.mint(space);
      return "minted";
    } catch (error) {
      if (!(error instanceof SpaceCredentialError)) throw error;
      if (error.code === "SpaceNotFound") return "SpaceNotFound";
      if (error.code === "SpaceDeleted") return "SpaceDeleted";
      return "denied";
    }
  }

  /** The writers the inbox owner's PDS tracks (`com.atproto.space.listRepos`), readable only by the owner. */
  async trackedWriters(inboxOwner: Actor): Promise<DmpTrackedWriter[]> {
    const space = dmInboxUri(inboxOwner.did);
    const credential = await this.mint(space);
    const scan = await listBoundedRepos(credential.client(inboxOwner.pdsUrl), { space, maxRepos: 1_000 });
    return scan.repos.map((repo) => ({ did: repo.did, rev: repo.rev }));
  }

  /** A record collection as the half owner's PDS serves it to a credential holder for `space`. */
  async records(space: string, repoOwner: FixtureAccount, collection: string): Promise<Array<{ rkey: string; value: Record<string, unknown> }>> {
    const credential = await this.mint(space);
    return (await listBoundedRecords(credential.client(repoOwner.pdsUrl), { space, repo: repoOwner.did, collection, maxRecords: 1_000 })).records;
  }
}

// --- Reading and writing the PDS directly -----------------------------------------------------------

export type DmpMessageRecord = { rkey: string; text: string };

/** The conversation keys of the halves an account owns, from its own PDS. */
export async function dmpOwnConvKeys(world: AppWorld, owner: FixtureAccount): Promise<string[]> {
  const listed = await world.pdsGet<{ spaces?: Array<{ uri: string }> }>(owner, "com.atproto.space.listSpaces", { type: "org.slack.dm.conversation", limit: "100" });
  if (listed.status !== 200) throw new Error(`listSpaces for ${owner.handle}: ${JSON.stringify(listed.body)}`);
  return (listed.body.spaces ?? []).flatMap((space) => {
    const parsed = parseDmConversationUri(space.uri);
    return parsed && parsed.ownerDid === owner.did ? [parsed.convKey] : [];
  }).sort();
}

/** An author's own messages in their own half, as their PDS stores them. */
export async function dmpOwnMessages(world: AppWorld, author: FixtureAccount, convKey: string): Promise<DmpMessageRecord[]> {
  const listed = await world.pdsGet<{ records?: Array<{ rkey: string; value: { text: string } }> }>(author, "com.atproto.space.listRecords", {
    space: dmConversationUri(author.did, convKey), repo: author.did, collection: "org.slack.dm.message", limit: "100",
  });
  if (listed.status !== 200) throw new Error(`listRecords for ${author.handle}: ${JSON.stringify(listed.body)}`);
  return (listed.body.records ?? []).map((record) => ({ rkey: record.rkey, text: record.value.text }));
}

export async function dmpOwnHeader(world: AppWorld, owner: FixtureAccount, convKey: string): Promise<{ convKey: string; participants: string[]; createdAt: string }> {
  const header = await world.pdsGet<{ value: { convKey: string; participants: string[]; createdAt: string } }>(owner, "com.atproto.space.getRecord", {
    space: dmConversationUri(owner.did, convKey), repo: owner.did, collection: "org.slack.dm.header", rkey: "self",
  });
  if (header.status !== 200) throw new Error(`getRecord header for ${owner.handle}: ${JSON.stringify(header.body)}`);
  return header.body.value;
}

export type DmpHostileHalf = {
  owner: FixtureAccount;
  convKey: string;
  readers: readonly FixtureAccount[];
  header: { convKey: string; participants: readonly string[] };
  message: string;
};

/** A participant who skips the client and writes their own half by hand, with whatever header they like. */
export async function dmpWriteHostileHalf(world: AppWorld, half: DmpHostileHalf): Promise<{ messageRkey: string }> {
  const space = dmConversationUri(half.owner.did, half.convKey);
  const memberList = { $type: "com.atproto.simplespace.defs#memberListPolicy" };
  const steps: Array<[string, unknown]> = [
    ["com.atproto.simplespace.createSpace", { type: "org.slack.dm.conversation", skey: half.convKey, readPolicy: memberList, writePolicy: memberList, appAccess: { $type: "com.atproto.simplespace.defs#open" } }],
    ...half.readers.map((reader): [string, unknown] => ["com.atproto.simplespace.putMember", { space, did: reader.did, read: true, write: false }]),
    ["com.atproto.space.putRecord", { space, repo: half.owner.did, collection: "org.slack.dm.header", rkey: "self", record: { $type: "org.slack.dm.header", ...half.header, createdAt: new Date().toISOString() } }],
  ];
  for (const [nsid, input] of steps) {
    const result = await world.pdsPost(half.owner, nsid, input);
    if (result.status !== 200) throw new Error(`${nsid} as ${half.owner.handle}: ${result.status} ${JSON.stringify(result.body)}`);
  }
  const messageRkey = tidNow();
  const written = await world.pdsPost(half.owner, "com.atproto.space.putRecord", {
    space, repo: half.owner.did, collection: "org.slack.dm.message", rkey: messageRkey,
    record: { $type: "org.slack.dm.message", text: half.message, createdAt: new Date().toISOString() },
  });
  if (written.status !== 200) throw new Error(`hostile message as ${half.owner.handle}: ${written.status} ${JSON.stringify(written.body)}`);
  return { messageRkey };
}

// --- The sender's re-notify schedule ----------------------------------------------------------------

export type DmpRenotifyState = { attempts: number; lastAttemptAt: number };
export type DmpRepoOp = { rev: string; collection: string; rkey: string; cid: string | null; prev: string | null; value: Record<string, unknown> };

/**
 * Reloads the page and waits for the DM provider's first full cycle to finish: it renews the inbox
 * notification registration only after `renotifyPending()` has returned, so seeing that request means any
 * due re-notification has already been sent.
 */
export async function dmpReloadThroughCycle(actor: Actor): Promise<void> {
  const cycled = actor.page.waitForRequest((request) => request.url().includes("/xrpc/com.atproto.space.registerNotify"), { timeout: 60_000 });
  await actor.page.reload();
  await cycled;
  await dmpWaitForDmReady(actor);
}

function renotifyKey(sender: FixtureAccount, convKey: string, recipient: FixtureAccount): string {
  return `dm:${sender.did}:renotify:${convKey}:${recipient.did}`;
}

/** What the sender's browser has persisted about how many times it has re-sent this request, and when. */
export async function dmpRenotifyState(sender: Actor, convKey: string, recipient: FixtureAccount): Promise<DmpRenotifyState | null> {
  const raw = await sender.page.evaluate((key) => localStorage.getItem(key), renotifyKey(sender, convKey, recipient));
  return raw ? JSON.parse(raw) as DmpRenotifyState : null;
}

/**
 * Time cannot be fast-forwarded inside the page (the PDS rejects DPoP proofs more than minutes off), so the
 * schedule is advanced the way it is stored: the last attempt is moved back so that `elapsedMs` have passed.
 */
export async function dmpSetRenotifyElapsed(sender: Actor, convKey: string, recipient: FixtureAccount, elapsedMs: number): Promise<void> {
  const state = await dmpRenotifyState(sender, convKey, recipient);
  if (!state) throw new Error("The sender has not persisted any re-notify state yet.");
  const moved: DmpRenotifyState = { attempts: state.attempts, lastAttemptAt: Date.now() - elapsedMs };
  await sender.page.evaluate(([key, value]) => localStorage.setItem(key as string, value as string), [renotifyKey(sender, convKey, recipient), JSON.stringify(moved)]);
}

/** Every write the sender's repo has taken in the recipient's inbox space, oldest first. */
export async function dmpRequestOps(world: AppWorld, sender: FixtureAccount, recipient: FixtureAccount): Promise<DmpRepoOp[]> {
  const result = await world.pdsGet<{ ops: DmpRepoOp[] }>(sender, "com.atproto.space.listRepoOps", { space: dmInboxUri(recipient.did), repo: sender.did, limit: "100" });
  if (result.status !== 200) throw new Error(`listRepoOps for ${sender.handle}: ${JSON.stringify(result.body)}`);
  return result.body.ops;
}

export async function dmpLatestCommitRev(world: AppWorld, sender: FixtureAccount, recipient: FixtureAccount): Promise<string> {
  const result = await world.pdsGet<{ commit: { rev: string } }>(sender, "com.atproto.space.getLatestCommit", { space: dmInboxUri(recipient.did), repo: sender.did });
  if (result.status !== 200) throw new Error(`getLatestCommit for ${sender.handle}: ${JSON.stringify(result.body)}`);
  return result.body.commit.rev;
}

// --- Credentials a browser minted, and what an app server keeps -------------------------------------

export type DmpMintedCredential = { space: string; token: string; status: number; issuedAt: number; error?: string };

const GET_SPACE_CREDENTIAL = "/xrpc/com.atproto.space.getSpaceCredential";

/** Records every space credential this page obtains from a PDS, as the browser sees the exchange on the wire. */
export function dmpWatchCredentials(page: Page): DmpMintedCredential[] {
  const minted: DmpMintedCredential[] = [];
  page.on("response", (response) => {
    if (!response.url().includes(GET_SPACE_CREDENTIAL)) return;
    const space = (response.request().postDataJSON() as { space?: string } | null)?.space ?? "";
    void (async () => {
      try {
        const body = response.status() === 200 ? await response.json() as { credential?: string } : {};
        minted.push({ space, token: body.credential ?? "", status: response.status(), issuedAt: Date.now() });
      } catch (error) {
        minted.push({ space, token: "", status: response.status(), issuedAt: Date.now(), error: String(error) });
      }
    })();
  });
  return minted;
}

export function dmpJwtClaims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
}

export function dmpDecrypt(hexKey: string, value: string): string {
  const [version, iv, tag, ciphertext] = value.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("Not an encrypted app value.");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(hexKey, "hex"), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

const ENCRYPTED_VALUE = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** Every text value the app has stored, with encrypted values decrypted by the key this scenario chose for it. */
export function dmpEverythingTheAppStored(databasePath: string, hexKey: string): string[] {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
    return tables.flatMap(({ name }) => (db.prepare(`SELECT * FROM "${name}"`).all() as Array<Record<string, unknown>>)
      .flatMap((row) => Object.values(row))
      .flatMap((value) => typeof value === "string" ? (ENCRYPTED_VALUE.test(value) ? [value, dmpDecrypt(hexKey, value)] : [value]) : []));
  } finally {
    db.close();
  }
}

export type DmpSavedServerSession = { did: string; scope: string[]; clientScope: string[] };

/** The OAuth sessions the app server holds, decrypted: the scope each one was actually granted by the PDS. */
export function dmpServerSessions(databasePath: string, hexKey: string): DmpSavedServerSession[] {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return (db.prepare("SELECT key, value FROM oauth_session").all() as Array<{ key: string; value: string }>).map(({ key, value }) => {
      const saved = JSON.parse(dmpDecrypt(hexKey, value)) as { tokenSet: { scope?: string }; oauthClientScope?: string };
      return { did: key, scope: (saved.tokenSet.scope ?? "").split(" ").filter(Boolean), clientScope: (saved.oauthClientScope ?? "").split(" ").filter(Boolean) };
    });
  } finally {
    db.close();
  }
}

/** True when `needle` occurs anywhere in the database file or its write-ahead log, as raw bytes. */
export function dmpFilesContain(databasePath: string, needle: string): boolean {
  return ["", "-wal", "-shm"].some((suffix) => existsSync(`${databasePath}${suffix}`) && readFileSync(`${databasePath}${suffix}`).includes(Buffer.from(needle)));
}

const APP_DATA_TABLES = ["operation", "operation_workspace_catalog", "audit_event", "sync_cursor", "channel_record_cache", "workspace_channel_cache", "space_collection_cursor"];

/** How many rows of workspace, channel or operation data an app's database holds (zero for a database that was never written). */
export function dmpAppDataRowCount(databasePath: string): number {
  if (!existsSync(databasePath)) return 0;
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const present = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(({ name }) => name));
    return APP_DATA_TABLES.filter((table) => present.has(table))
      .reduce((total, table) => total + (db.prepare(`SELECT COUNT(*) AS rows FROM "${table}"`).get() as { rows: number }).rows, 0);
  } finally {
    db.close();
  }
}
