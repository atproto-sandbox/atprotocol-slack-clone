import { chromium, type Browser, type Page } from "@playwright/test";
import { availablePort, startAppServer, startOperatorServer, type AppServer } from "../support/app-server";
import { signIn } from "../support/browser-app";
import { actorTransport, bearerSession, startPdsNetwork, type NetworkActor, type PdsNetwork } from "../support/pds-network";
import { createChannel, deleteMessage, MESSAGES_PER_WRITER, percentile, Probe, provision, writeMessage, WRITER_COUNTS } from "../support/sync-dataset";
import { BROWSER_CLIENT_METADATA_PATH } from "@flock/web/browser/client-metadata";

// K4 of `.ai/plans/platform-refactor.md`, measured for R6a with the real client: the app's own page opening a channel's
// latest 100 messages in a real browser, on K4's dataset. A first open starts from an empty store (the account's IndexedDB
// database deleted from a page of the origin that runs no app code, then the app loaded again); a reopen opens the same
// channel again; one new message is a reopen after a writer wrote and the authority listed it. The change feed is blocked,
// so what is counted is the reads alone, each measurement starting once the page has gone quiet. Time is measured in the
// page, from the click to the channel's message list leaving `aria-busy`; requests are counted from the DevTools protocol,
// the browser's CORS preflights apart.
//
// Run: corepack pnpm build && ATPROTO_PINNED_CHECKOUT=../atproto-spaces-phase3 node --import tsx protocol-tests/browser/sync-budget.ts [runs]

const RUNS = Number(process.argv[2] ?? 10);
const WORKSPACE_NAME = "Budget";

type Phase = "first open" | "reopen" | "one new message";
type Measurement = { ms: number; requests: number; preflights: number; byMethod: Record<string, number> };
type Sent = { url: string; preflight: boolean };

async function main(): Promise<void> {
  const appPort = await availablePort();
  const operatorPort = await availablePort();
  const pds = await startPdsNetwork("sync-budget-browser", { appPort, operatorPort });
  let app: AppServer | undefined;
  let operator: AppServer | undefined;
  let browser: Browser | undefined;
  try {
    operator = await startOperatorServer();
    app = await startAppServer(appPort);
    const { authority, reader, writers } = await provision(pds, Math.max(...WRITER_COUNTS));
    const channels = await workspaceWithChannels(pds, authority, reader, writers);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.route("**/xrpc/new.flock.operator.getChanges", (route) => route.abort("connectionrefused"));
    const page = await context.newPage();
    page.setDefaultTimeout(120_000);
    const sent = await recordRequests(page);
    await signIn(page, app.url, reader, WORKSPACE_NAME);
    // The app's own servers (the web app and its operator) are not the hosts a sync is measured against.
    const appOrigins = [new URL(app.url).origin, new URL(operator.url).origin];

    const rows: Array<{ writers: number; phase: Phase; calls: number; preflights: number; median: number; p95: number; byMethod: Record<string, number> }> = [];
    for (const count of WRITER_COUNTS) {
      const { space, name } = channels.get(count)!;
      const probe = new Probe(pds, reader, space);
      const results: Record<Phase, Measurement[]> = { "first open": [], reopen: [], "one new message": [] };
      for (let run = 0; run < RUNS; run += 1) {
        await emptyStore(page, app.url, reader.did);
        results["first open"].push(await measure(page, sent, appOrigins, pds, name));
        await assertHolds(page, reader.did, space, writers.slice(0, count).map((writer) => writer.did));
        results.reopen.push(await measure(page, sent, appOrigins, pds, name));
        const writer = writers[run % count]!;
        const before = await probe.waitForCurrentRevision(writer.did);
        const rkey = await writeMessage(writer, space, `run ${run}`);
        await probe.waitForNotice(writer.did, before);
        results["one new message"].push(await measure(page, sent, appOrigins, pds, name));
        if (!await holdsRecord(page, reader.did, space, writer.did, rkey)) throw new Error(`The reopen after a new message did not read it (${writer.did}/${rkey}).`);
        await deleteMessage(writer, space, rkey);
        await probe.waitForCurrentRevision(writer.did);
      }
      for (const [phase, measurements] of Object.entries(results) as Array<[Phase, Measurement[]]>) {
        const counts = new Set(measurements.map((measurement) => measurement.requests));
        const times = measurements.map((measurement) => measurement.ms).sort((left, right) => left - right);
        const row = { writers: count, phase, calls: Math.max(...counts), preflights: Math.max(...measurements.map((measurement) => measurement.preflights)), median: percentile(times, 0.5), p95: percentile(times, 0.95), byMethod: measurements[0]!.byMethod };
        rows.push(row);
        process.stdout.write(`${count} writers, ${phase}: median ${row.median.toFixed(0)} ms, p95 ${row.p95.toFixed(0)} ms, ${[...counts].join("/")} requests + ${row.preflights} preflights ${JSON.stringify(row.byMethod)}\n`);
      }
    }
    process.stdout.write(`\n| writers | phase | requests | preflights | median ms | p95 ms |\n|---|---|---|---|---|---|\n`);
    for (const row of rows) process.stdout.write(`| ${row.writers} | ${row.phase} | ${row.calls} | ${row.preflights} | ${row.median.toFixed(0)} | ${row.p95.toFixed(0)} |\n`);
  } finally {
    await browser?.close();
    await app?.stop();
    await operator?.stop();
    await pds.close();
  }
}

/** A workspace the reader has accepted, listing one channel of K4's dataset per writer count. */
async function workspaceWithChannels(pds: PdsNetwork, authority: NetworkActor, reader: NetworkActor, writers: NetworkActor[]): Promise<Map<number, { space: string; name: string }>> {
  const [{ createEngine }, { ensureMemberListSpace, putAuthorityRecord, putSpaceMember }, keys, { COLLECTION, SPACE_TYPE }] = await Promise.all([
    import("@flock/client/engine"), import("@flock/operator/atproto/space-ops"), import("@flock/protocol/keys"), import("@flock/protocol/nsids"),
  ]);
  const owner = bearerSession(authority) as never;
  const updatedAt = new Date().toISOString();
  const workspace = await ensureMemberListSpace(owner, SPACE_TYPE.workspace, "budget");
  await putAuthorityRecord(owner, workspace, COLLECTION.workspaceProfile, "self", { name: WORKSPACE_NAME, createdAt: updatedAt });
  await putAuthorityRecord(owner, workspace, COLLECTION.workspaceRoster, keys.subjectKey(reader.did), { subject: reader.did, active: true, updatedAt });
  await putSpaceMember(owner, workspace, reader.did, true, true);
  await createEngine(actorTransport(pds, reader)).workspaces.accept(workspace);
  const channels = new Map<number, { space: string; name: string }>();
  for (const count of WRITER_COUNTS) {
    const skey = `budget-${count}`;
    const space = await createChannel(pds, authority, reader, writers.slice(0, count), skey);
    await putAuthorityRecord(owner, workspace, COLLECTION.directory, skey, { skey, name: skey, visibility: "public" });
    channels.set(count, { space, name: skey });
  }
  return channels;
}

/** Every request the page's browser sends, from the DevTools protocol, with its CORS preflights marked. */
async function recordRequests(page: Page): Promise<Sent[]> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  const sent: Sent[] = [];
  cdp.on("Network.requestWillBeSent", (event) => {
    sent.push({ url: event.request.url, preflight: event.type === "Preflight" || event.request.method === "OPTIONS" });
  });
  return sent;
}

/** Deletes the account's store from a page of the origin that runs no app code, then loads the app again. */
async function emptyStore(page: Page, appUrl: string, did: string): Promise<void> {
  const { databaseName } = await import("@flock/client/indexeddb-store");
  await page.goto(new URL(BROWSER_CLIENT_METADATA_PATH, appUrl).href);
  await page.evaluate((name) => new Promise<void>((resolve, reject) => {
    const deleting = indexedDB.deleteDatabase(name);
    deleting.onsuccess = () => resolve();
    deleting.onerror = () => reject(deleting.error);
    deleting.onblocked = () => reject(new Error(`${name} is still open elsewhere`));
  }), databaseName(did));
  await page.goto(appUrl);
  await page.getByRole("heading", { name: WORKSPACE_NAME, exact: true }).waitFor({ state: "visible" });
}

/**
 * Waits until the page has sent nothing to the protocol hosts for a second (the app's start-up discovery done), so a
 * measurement counts only what the click causes.
 */
async function quiet(sent: Sent[], appOrigins: readonly string[]): Promise<void> {
  const upstream = () => sent.filter((entry) => !appOrigins.includes(new URL(entry.url).origin)).length;
  const deadline = Date.now() + 60_000;
  let seen = upstream();
  let since = Date.now();
  while (Date.now() - since < 1_000) {
    if (Date.now() > deadline) throw new Error("The page never went quiet.");
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (upstream() !== seen) {
      seen = upstream();
      since = Date.now();
    }
  }
}

/** Clicks the channel in the sidebar and times, in the page, until its message list stops being busy; counts what was sent. */
async function measure(page: Page, sent: Sent[], appOrigins: readonly string[], pds: PdsNetwork, name: string): Promise<Measurement> {
  await quiet(sent, appOrigins);
  const from = sent.length;
  const ms = await page.evaluate((channel) => new Promise<number>((resolve, reject) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>(".channel-nav-item")].find((entry) => entry.textContent?.slice(1).trim() === channel);
    if (!button) {
      reject(new Error(`${channel} is not in the sidebar`));
      return;
    }
    let busy = false;
    let started = 0;
    const observer = new MutationObserver(() => {
      const state = document.querySelector(".message-list")?.getAttribute("aria-busy");
      if (state === "true") busy = true;
      if (busy && state === "false") {
        observer.disconnect();
        resolve(performance.now() - started);
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-busy"] });
    started = performance.now();
    button.click();
  }), name);
  const upstream = sent.slice(from).filter((entry) => !appOrigins.includes(new URL(entry.url).origin));
  const byMethod: Record<string, number> = {};
  for (const entry of upstream.filter((item) => !item.preflight)) {
    const url = new URL(entry.url);
    const method = url.pathname.startsWith("/xrpc/") ? url.pathname.slice("/xrpc/".length) : url.origin === new URL(pds.plcUrl).origin ? "plc resolve" : `${url.origin}${url.pathname}`;
    byMethod[method] = (byMethod[method] ?? 0) + 1;
  }
  return { ms, requests: upstream.filter((entry) => !entry.preflight).length, preflights: upstream.filter((entry) => entry.preflight).length, byMethod: Object.fromEntries(Object.entries(byMethod).sort()) };
}

/** Every writer of the fixed dataset was read with all of its messages: the measured first open read the whole dataset. */
async function assertHolds(page: Page, did: string, space: string, writers: string[]): Promise<void> {
  const counts = await page.evaluate(async ({ name, space }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open(name);
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    try {
      const records = await new Promise<Array<{ space: string; collection: string; repo: string }>>((resolve, reject) => {
        const request = db.transaction("records", "readonly").objectStore("records").getAll();
        request.onsuccess = () => resolve(request.result as Array<{ space: string; collection: string; repo: string }>);
        request.onerror = () => reject(request.error);
      });
      const counts: Record<string, number> = {};
      for (const record of records) if (record.space === space && record.collection === "new.flock.channel.message") counts[record.repo] = (counts[record.repo] ?? 0) + 1;
      return counts;
    } finally { db.close(); }
  }, { name: (await import("@flock/client/indexeddb-store")).databaseName(did), space });
  const short = writers.filter((writer) => counts[writer] !== MESSAGES_PER_WRITER);
  if (Object.keys(counts).length !== writers.length || short.length > 0) {
    throw new Error(`The first open read ${Object.keys(counts).length} of ${writers.length} writers; ${short.length} without all ${MESSAGES_PER_WRITER} messages.`);
  }
}

async function holdsRecord(page: Page, did: string, space: string, repo: string, rkey: string): Promise<boolean> {
  return page.evaluate(async ({ name, key }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open(name);
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const request = db.transaction("records", "readonly").objectStore("records").get(key);
        request.onsuccess = () => resolve(request.result !== undefined);
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  }, { name: (await import("@flock/client/indexeddb-store")).databaseName(did), key: [space, "new.flock.channel.message", repo, rkey] });
}

await main();
