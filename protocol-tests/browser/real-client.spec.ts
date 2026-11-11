import assert from "node:assert/strict";
import test from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { availablePort, startAppServer, startOperatorServer, type AppServer } from "../support/app-server";
import { openChannel, signIn as signInPage } from "../support/browser-app";
import { countByOrigin, watchPreflights, type Preflight } from "../support/browser-network";
import { actorTransport, bearerSession, startPdsNetwork, type NetworkActor, type PdsNetwork } from "../support/pds-network";

// K9 of `.ai/plans/platform-refactor.md`, repeated in R6a with the real client: the app's own pages sign in through its
// `BrowserOAuthClient`, and the engine in the page reads the protocol hosts itself. The operator still shares the web app's
// origin (R7 moves it). Unlike R0's K9, nothing runs in Node on the client's behalf: the keys, the MAC checks and every
// request are the page's.

const WORKSPACE_NAME = "K9 Workspace";
const AUTHORITY_NOTE = "k9 from the authority host";
const REMOTE_NOTE = "k9 from the unreachable host";
const BROWSER_NOTE = "k9 from the browser";

type Seen = { method: string; url: URL; status: number; requestBody: string; headers: Record<string, string>; requestHeaders: Record<string, string>; body?: string };
/** A request the page sent to the app's web origin or to its operator's origin, of any kind (navigations too), as it left the browser. */
type ToApp = { method: string; url: URL; headers: Record<string, string>; body: string };
type Side = { actor: NetworkActor; context: BrowserContext; page: Page; preflights: Preflight[]; failures: string[]; seen: Seen[]; toApp: ToApp[]; toOperator: ToApp[] };

test("the app's own browser client reaches the PDS hosts and the operator's own process directly (K9, R6a, R7)", { timeout: 600_000 }, async (t) => {
  const appPort = await availablePort();
  const operatorPort = await availablePort();
  const pds = await startPdsNetwork("k9-real-client", { appPort, operatorPort });
  let app: AppServer | undefined;
  let operator: AppServer | undefined;
  let browser: Browser | undefined;
  try {
    operator = await startOperatorServer();
    app = await startAppServer(appPort);
    const operatorOrigin = new URL(operator.url).origin;
    const fixture = await provision(pds);
    const unreachable = new URL(fixture.remote.pds.url).origin;
    browser = await chromium.launch({ headless: true });

    // given a member who reads a channel one of whose writers lives on a host the browser cannot reach
    const member = await signInFrom(browser, app.url, operatorOrigin, fixture.member, { unreachable });
    // when the member opens the channel, refreshes the workspace (a credential minted again) and opens it once more
    await openChannel(member.page, "general");
    await member.page.getByText(AUTHORITY_NOTE, { exact: true }).waitFor({ state: "visible" });
    await member.page.getByText(`Messages from ${fixture.remote.did} may be missing`).waitFor({ state: "visible" });
    const firstMints = credentialAnswers(member, fixture.workspace).length;
    await member.page.getByRole("button", { name: /Refresh/ }).click();
    await waitFor(() => credentialAnswers(member, fixture.workspace).length > firstMints, "the workspace credential to be minted again");
    const renewedAt = member.seen.length;
    await openChannel(member.page, "general");
    // and posts to the channel, which writes to its own host
    await member.page.getByPlaceholder("Write a message…").fill(BROWSER_NOTE);
    await member.page.getByRole("button", { name: "Send", exact: true }).click();
    await member.page.locator(".message-card > p").filter({ hasText: BROWSER_NOTE }).waitFor({ state: "visible" });

    // and an outsider, a workspace member not on the private channel's member list, opens that channel
    const outsider = await signInFrom(browser, app.url, operatorOrigin, fixture.outsider, {});
    await openChannel(outsider.page, "vault");
    await outsider.page.getByText("You are not on this channel’s active roster.").waitFor({ state: "visible" });

    // then every capability held in the page
    const memberHost = new URL(fixture.member.pds.url).origin;
    const fetched = (side: Side, origin: string, path: string) => side.seen.filter((entry) => entry.url.origin === origin && entry.url.pathname === path);
    const results: Record<string, boolean> = {
      "PAR and the token exchange are the page's own requests to the member's host":
        fetched(member, memberHost, "/oauth/par").some((entry) => entry.status < 300) && fetched(member, memberHost, "/oauth/token").some((entry) => entry.status === 200),
      "DID documents come from the PLC directory": member.seen.some((entry) => entry.url.origin === new URL(pds.plcUrl).origin && entry.status === 200),
      "a channel credential is minted at the authority's host": credentialAnswers(member, fixture.channel).some((entry) => entry.status === 200),
      "the workspace credential is minted again on refresh": credentialAnswers(member, fixture.workspace).filter((entry) => entry.status === 200).length >= 2,
      "a getRecord after the renewal carries a MAC the page can read": member.seen.slice(renewedAt).some((entry) => entry.url.pathname.endsWith("/com.atproto.space.getRecord")
        && entry.status === 200 && /atproto-space-mac/i.test(entry.headers["access-control-expose-headers"] ?? "") && Boolean(entry.headers["atproto-space-mac"])),
      "the authority lists the channel's writers": member.seen.some((entry) => entry.url.pathname.endsWith("/com.atproto.space.listRepos") && entry.status === 200),
      "the operator, at its own origin, is called with a service token": member.seen.some((entry) => entry.url.origin === operatorOrigin
        && entry.url.pathname === "/xrpc/new.flock.operator.getChanges" && entry.status === 200 && /^Bearer /.test(entry.requestHeaders.authorization ?? "")),
      "the page writes to its own host with its DPoP-bound session": member.seen.some((entry) => entry.url.origin === memberHost && entry.method === "POST"
        && entry.url.pathname === "/xrpc/com.atproto.space.createRecord" && entry.status === 200 && /^DPoP /.test(entry.requestHeaders.authorization ?? "")
        && entry.requestBody.includes(BROWSER_NOTE)),
      "the outsider is refused, and the refusal is readable": credentialAnswers(outsider, fixture.vault).length > 0
        && credentialAnswers(outsider, fixture.vault).every((entry) => entry.status === 400 && refusalCode(entry) === "SpaceNotFound")
        && await outsider.page.locator(".form-error").count() === 0,
      "the unreachable writer host fails as a network error, and the rest of the channel is shown": member.failures.some((failure) => failure.includes(unreachable))
        && await member.page.getByText(AUTHORITY_NOTE, { exact: true }).isVisible(),
      // Neither of the app's servers holds a member session: what reaches them carries neither a member token nor a record.
      "the sign-in's authorization code never reaches the app's server": [member, outsider].every((side) => side.toApp.some((request) => request.url.pathname === "/oauth/callback")
        && side.toApp.every((request) => !request.url.searchParams.has("code") && !request.url.searchParams.has("state"))),
      "no request to the web app carries any authorization, a DPoP proof or a cookie": [member, outsider].every((side) => side.toApp.length > 0
        && side.toApp.every((request) => request.headers.authorization === undefined && request.headers.dpop === undefined && request.headers.cookie === undefined)),
      "the operator gets service tokens only, never a member token, a DPoP proof or a cookie": [member, outsider].every((side) => side.toOperator.length > 0
        && side.toOperator.every((request) => request.method === "OPTIONS" || (/^Bearer /.test(request.headers.authorization ?? "") && request.headers.dpop === undefined && request.headers.cookie === undefined))),
      "no request to either server carries a record's content": [member, outsider].every((side) => [...side.toApp, ...side.toOperator].every((request) =>
        ![BROWSER_NOTE, AUTHORITY_NOTE].some((text) => request.body.includes(text) || decodeURIComponent(request.url.href).includes(text)))),
    };

    const preflights = [...member.preflights, ...outsider.preflights];
    const failedPreflights = preflights.filter((preflight) => !/^2\d\d$/.test(preflight.outcome) && new URL(preflight.url).origin !== unreachable);
    const failures = [...member.failures, ...outsider.failures].filter((failure) => !failure.includes(unreachable) && !isFixtureHandleCheck(failure) && !failure.endsWith("(net::ERR_ABORTED)"));
    for (const [step, ok] of Object.entries(results)) t.diagnostic(`${step}: ${ok ? "ok" : "FAILED"}`);
    t.diagnostic(`preflights the browser sent: ${preflights.length}, per origin: ${JSON.stringify(countByOrigin(preflights))}`);
    t.diagnostic(`requests per origin (member): ${JSON.stringify(countRequests(member))}`);
    t.diagnostic(`browser-level failures apart from the unreachable host, fixture handle checks and aborted polls: ${failures.join("; ") || "none"}`);
    assert.deepEqual(Object.entries(results).filter(([, ok]) => !ok).map(([step]) => step), []);
    assert.deepEqual(failedPreflights, [], "every preflight the browser sent succeeded");
    assert.deepEqual(failures, [], "only the unreachable host fails in the browser");

    // and when the member signs out (with a DM state key of its own kept, as hiding a request keeps one), what the account
    // kept in this browser goes with its session
    await member.page.evaluate((did) => localStorage.setItem(`dm:${did}:hidden-request:at://probe`, "1"), fixture.member.did);
    const handleField = member.page.getByLabel("Your AT Protocol handle");
    await member.page.getByRole("button", { name: "Sign out", exact: true }).click();
    await handleField.waitFor({ state: "visible" });
    const kept = await member.page.evaluate(async (did) => ({
      databases: (await indexedDB.databases()).map((database) => database.name ?? ""),
      dmKeys: Object.keys(localStorage).filter((key) => key.startsWith(`dm:${did}:`)),
    }), fixture.member.did);
    assert.ok(!kept.databases.includes(`flock-sync-${fixture.member.did}`), `the account's store is deleted: ${kept.databases.join(", ")}`);
    assert.deepEqual(kept.dmKeys, [], "its DM state is forgotten");
    await member.page.reload();
    await handleField.waitFor({ state: "visible" });
    assert.equal(await member.page.locator(".app-frame").count(), 0, "after a reload nobody is signed in here");
  } finally {
    await browser?.close();
    await app?.stop();
    await operator?.stop();
    await pds.close();
  }
});

/**
 * A workspace with a public channel and a private one. The member and the outsider (both on host 0) have accepted it; the
 * member is on both channels, the outsider on neither's member list but the public one's. A writer on host 1 and the
 * authority have each written to the public channel, and the authority lists both.
 */
async function provision(pds: PdsNetwork) {
  const [{ createEngine }, { readIndependentChannelPage }, { ensureMemberListSpace, putAuthorityRecord, putSpaceMember }, keys, { COLLECTION, SPACE_TYPE }, { AtprotoClient }] = await Promise.all([
    import("@flock/client/engine"), import("@flock/reader/independent"), import("@flock/operator/atproto/space-ops"), import("@flock/protocol/keys"), import("@flock/protocol/nsids"), import("@flock/protocol/atproto/xrpc"),
  ]);
  const authority = await pds.createActor("k9rowner", 0);
  const member = await pds.createActor("k9rmember", 0);
  const outsider = await pds.createActor("k9routsider", 0);
  const remote = await pds.createActor("k9rremote", 1);
  const owner = bearerSession(authority) as never;
  const updatedAt = new Date().toISOString();
  const workspace = await ensureMemberListSpace(owner, SPACE_TYPE.workspace, "k9r");
  const channel = await ensureMemberListSpace(owner, SPACE_TYPE.channel, "k9r-general");
  const vault = await ensureMemberListSpace(owner, SPACE_TYPE.channel, "k9r-vault");
  await putAuthorityRecord(owner, workspace, COLLECTION.workspaceProfile, "self", { name: WORKSPACE_NAME, createdAt: updatedAt });
  await putAuthorityRecord(owner, workspace, COLLECTION.directory, "k9r-general", { skey: "k9r-general", name: "general", visibility: "public" });
  await putAuthorityRecord(owner, workspace, COLLECTION.directory, "k9r-vault", { skey: "k9r-vault", name: "vault", visibility: "private" });
  await putAuthorityRecord(owner, vault, COLLECTION.channelRoster, keys.subjectKey(member.did), { subject: member.did, active: true, updatedAt });
  await putSpaceMember(owner, vault, member.did, true, true);
  for (const account of [authority, member, outsider, remote]) {
    await putAuthorityRecord(owner, workspace, COLLECTION.workspaceRoster, keys.subjectKey(account.did), { subject: account.did, active: true, updatedAt });
    await putSpaceMember(owner, workspace, account.did, true, true);
    await putSpaceMember(owner, channel, account.did, true, true);
  }
  for (const account of [member, outsider]) await createEngine(actorTransport(pds, account)).workspaces.accept(workspace);
  for (const [writer, text] of [[authority, AUTHORITY_NOTE], [remote, REMOTE_NOTE]] as const) {
    await new AtprotoClient(bearerSession(writer).fetchHandler).procedure("com.atproto.space.createRecord", {
      space: channel, repo: writer.did, collection: COLLECTION.message, rkey: keys.tidNow(),
      record: { $type: COLLECTION.message, text, createdAt: new Date().toISOString() },
    });
  }
  await waitFor(async () => (await readIndependentChannelPage(actorTransport(pds, member), workspace, "k9r-general")).messages.length === 2, "the authority to list both writers");
  return { member, outsider, remote, workspace, channel, vault };
}

/** A browser context for `actor`, recording what its page sends and what fails, signed in on the app. */
async function signInFrom(browser: Browser, appUrl: string, operatorOrigin: string, actor: NetworkActor, options: { unreachable?: string }): Promise<Side> {
  const context = await browser.newContext();
  if (options.unreachable) await context.route(`${options.unreachable}/**`, (route) => route.abort("connectionrefused"));
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  const side: Side = { actor, context, page, preflights: await watchPreflights(page), failures: [], seen: [], toApp: [], toOperator: [] };
  const appOrigin = new URL(appUrl).origin;
  page.on("request", (request) => {
    const url = new URL(request.url());
    const recorded = url.origin === appOrigin ? side.toApp : url.origin === operatorOrigin ? side.toOperator : undefined;
    if (!recorded) return;
    void request.allHeaders().then(
      (headers) => recorded.push({ method: request.method(), url, headers, body: request.postData() ?? "" }),
      (error: unknown) => side.failures.push(`unrecorded request ${url.href} (${String(error)})`),
    );
  });
  page.on("requestfailed", (request) => side.failures.push(`${request.method()} ${request.url()} (${request.failure()?.errorText})`));
  page.on("response", (response) => {
    const request = response.request();
    if (request.resourceType() !== "fetch" && request.resourceType() !== "xhr") return;
    const url = new URL(response.url());
    // A refused credential exchange is read for its error code; nothing else needs a body.
    const body = url.pathname === "/xrpc/com.atproto.space.getSpaceCredential" && response.status() !== 200 ? response.text() : Promise.resolve(undefined);
    void Promise.all([response.allHeaders(), request.allHeaders(), body]).then(([headers, requestHeaders, text]) => {
      side.seen.push({ method: request.method(), url, status: response.status(), requestBody: request.postData() ?? "", headers, requestHeaders, body: text });
    }, (error: unknown) => side.failures.push(`unrecorded response ${url.href} (${String(error)})`));
  });
  await signInPage(page, appUrl, actor, WORKSPACE_NAME);
  return side;
}

/** The page's credential exchanges for one space, as the authority's host answered them. */
function credentialAnswers(side: Side, space: string): Seen[] {
  return side.seen.filter((entry) => entry.url.pathname === "/xrpc/com.atproto.space.getSpaceCredential" && spaceOf(entry.requestBody) === space);
}

/** The PDS answers every credential refusal as HTTP 400 with an error code. */
function refusalCode(entry: Seen): string | undefined {
  return entry.body === undefined ? undefined : (JSON.parse(entry.body) as { error?: string }).error;
}

function spaceOf(body: string): string | undefined {
  try { return (JSON.parse(body) as { space?: string }).space; }
  catch { return undefined; }
}

/** The OAuth client checks each handle at https://<handle>/.well-known/atproto-did; the fixture's handles are not real domains. */
function isFixtureHandleCheck(failure: string): boolean {
  const url = /^\w+ (\S+) /.exec(failure)?.[1];
  return url !== undefined && new URL(url).pathname === "/.well-known/atproto-did" && /\.test2?$/.test(new URL(url).hostname);
}

function countRequests(side: Side): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { url } of side.seen) counts[url.origin] = (counts[url.origin] ?? 0) + 1;
  return counts;
}

async function waitFor(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
