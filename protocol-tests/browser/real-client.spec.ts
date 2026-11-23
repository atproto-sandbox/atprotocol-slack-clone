import assert from "node:assert/strict";
import test from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { availablePort, startAppServer, startOperatorServer, type AppServer } from "../support/app-server";
import { openChannel, signIn as signInPage } from "../support/browser-app";
import { countByOrigin, watchPreflights, type Preflight } from "../support/browser-network";
import {
  acceptGroupMembership,
  actorTransport,
  bearerSession,
  createOpenSocialGroup,
  startPdsNetwork,
  type NetworkActor,
  type PdsNetwork,
} from "../support/pds-network";

// K9 of `.ai/plans/platform-refactor.md`, repeated with the real browser client on R13 OpenSocial groups: the app's own pages
// sign in through `BrowserOAuthClient`, and the engine in the page reads the personal PDS hosts, the OpenSocial Group Host,
// PLC, and the operator directly. Nothing runs in Node on the client's behalf: the keys, the MAC checks and every request are
// the page's.

const WORKSPACE_NAME = "K9 Workspace";
const AUTHORITY_NOTE = "k9 from the authority host";
const REMOTE_NOTE = "k9 from the unreachable host";
const BROWSER_NOTE = "k9 from the browser";

type Seen = { method: string; url: URL; status: number; requestBody: string; headers: Record<string, string>; requestHeaders: Record<string, string>; body?: string };
/** A request the page sent to the app's web origin or to its operator's origin, of any kind (navigations too), as it left the browser. */
type ToApp = { method: string; url: URL; headers: Record<string, string>; body: string };
type Side = { actor: NetworkActor; context: BrowserContext; page: Page; preflights: Preflight[]; failures: string[]; seen: Seen[]; toApp: ToApp[]; toOperator: ToApp[] };

test("the app's own browser client reaches the PDS hosts, Group Host, and the operator's own process directly (K9, R6a, R7, R13)", { timeout: 600_000 }, async (t) => {
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
    const groupHostOrigin = `http://localhost:${pds.groupHost.port}`;
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
    const renewedAt = member.seen.length;
    await member.page.getByRole("button", { name: /Refresh/ }).click();
    await waitFor(() => credentialAnswers(member, fixture.workspace).length > firstMints, "the workspace credential to be minted again");
    await openChannel(member.page, "general");
    // and posts to the channel, which writes to its own host
    await member.page.getByPlaceholder("Write a message…").fill(BROWSER_NOTE);
    await member.page.getByRole("button", { name: "Send", exact: true }).click();
    await member.page.locator(".message-card > p").filter({ hasText: BROWSER_NOTE }).waitFor({ state: "visible" });

    // and an outsider, a workspace member not on the private channel's role, opens that channel
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
      "a channel credential is minted at the Group Host": credentialAnswers(member, fixture.channel).some((entry) => entry.url.origin === groupHostOrigin && entry.status === 200),
      "the workspace credential is minted again on refresh at the Group Host": credentialAnswers(member, fixture.workspace).filter((entry) => entry.url.origin === groupHostOrigin && entry.status === 200).length >= 2,
      "a getRecord after the renewal carries a MAC the page can read": member.seen.slice(renewedAt).some((entry) => {
        if (!entry.url.pathname.endsWith("/com.atproto.space.getRecord") || entry.status !== 200) return false;
        const exposed = (entry.headers["access-control-expose-headers"] ?? "").split(",").map((token) => token.trim().toLowerCase());
        return exposed.includes("atproto-space-record")
          && exposed.includes("signature-input")
          && exposed.includes("signature")
          && Boolean(entry.headers["atproto-space-record"])
          && Boolean(entry.headers["signature-input"])
          && Boolean(entry.headers["signature"])
          && /accept-signature/i.test(entry.headers.vary ?? "");
      }),
      "the Group Host lists the channel's writers": member.seen.some((entry) => entry.url.origin === groupHostOrigin && entry.url.pathname.endsWith("/com.atproto.space.listWriters") && entry.status === 200),
      "the operator, at its own origin, is called with a service token": member.seen.some((entry) => entry.url.origin === operatorOrigin
        && entry.url.pathname === "/xrpc/new.flock.operator.getChanges" && entry.status === 200 && /^Bearer /.test(entry.requestHeaders.authorization ?? "")),
      "the page writes to its own host with its DPoP-bound session": member.seen.some((entry) => entry.url.origin === memberHost && entry.method === "POST"
        && entry.url.pathname === "/xrpc/com.atproto.space.createRecord" && entry.status === 200 && /^DPoP /.test(entry.requestHeaders.authorization ?? "")
        && entry.requestBody.includes(BROWSER_NOTE)),
      "the outsider is refused at the Group Host, and the refusal is readable": credentialAnswers(outsider, fixture.vault).length > 0
        && credentialAnswers(outsider, fixture.vault).every((entry) => entry.url.origin === groupHostOrigin && entry.status === 400 && refusalCode(entry) === "SpaceNotFound")
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
    const byOrigin = countByOrigin(preflights);
    const failedPreflights = preflights.filter((preflight) => !/^2\d\d$/.test(preflight.outcome) && new URL(preflight.url).origin !== unreachable);
    const failures = [...member.failures, ...outsider.failures].filter((failure) => !failure.includes(unreachable) && !isFixtureHandleCheck(failure) && !failure.endsWith("(net::ERR_ABORTED)"));
    for (const [step, ok] of Object.entries(results)) t.diagnostic(`${step}: ${ok ? "ok" : "FAILED"}`);
    t.diagnostic(`preflights the browser sent: ${preflights.length}, per origin: ${JSON.stringify(byOrigin)}`);
    t.diagnostic(`requests per origin (member): ${JSON.stringify(countRequests(member))}`);
    t.diagnostic(`browser-level failures apart from the unreachable host, fixture handle checks and aborted polls: ${failures.join("; ") || "none"}`);
    assert.deepEqual(Object.entries(results).filter(([, ok]) => !ok).map(([step]) => step), []);
    assert.ok((byOrigin[groupHostOrigin] ?? 0) > 0, "browser sent CORS preflights to Group Host");
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
    assert.ok(!kept.databases.includes(`flock-sync-${fixture.member.did}`), `the account's sync store is deleted: ${kept.databases.join(", ")}`);
    assert.ok(!kept.databases.includes(`flock-group-oauth:${fixture.member.did}`), `the account's group OAuth store is deleted: ${kept.databases.join(", ")}`);
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
 * An OpenSocial group workspace with `#general` (public) and `#vault` (private). `member` and `outsider` (both on host 0)
 * have accepted membership; `member` holds the private channel role for `#vault` while `outsider` does not. Both `owner`
 * (on host 0) and `remote` (on host 1) have written to `#general`, and the Group Host lists both writers.
 */
async function provision(pds: PdsNetwork) {
  const [
    { readIndependentChannelPage },
    { restoreAuthorityGrant },
    { grantCreationAuthorization },
    { createWorkspace },
    { registrationDeps },
    { requireActiveWorkspaceAdmin },
    { executeOperatorOperation },
    { channelUri, tidNow },
    { COLLECTION },
    { AtprotoClient },
  ] = await Promise.all([
    import("@flock/reader/independent"),
    import("@flock/operator/operator/authority-grant"),
    import("@flock/operator/operator/creation-authorization"),
    import("@flock/operator/operator/kinds/create-workspace"),
    import("@flock/operator/operator/registrations"),
    import("@flock/operator/operator/security"),
    import("@flock/operator/operator/operations"),
    import("@flock/protocol/keys"),
    import("@flock/protocol/nsids"),
    import("@flock/protocol/atproto/xrpc"),
  ]);
  const owner = await pds.createActor("k9rowner", 0);
  const member = await pds.createActor("k9rmember", 0);
  const outsider = await pds.createActor("k9routsider", 0);
  const remote = await pds.createActor("k9rremote", 1);

  const createdGroup = await createOpenSocialGroup(pds, owner, { name: WORKSPACE_NAME });
  const groupDid = createdGroup.groupDid;
  grantCreationAuthorization(
    { authorityDid: groupDid, initiatorDid: owner.did, name: WORKSPACE_NAME },
    Math.floor(Date.now() / 1000),
  );
  const createdWs = await createWorkspace(
    await restoreAuthorityGrant(groupDid),
    { creator: owner.did, name: WORKSPACE_NAME, operationId: tidNow() },
    registrationDeps,
  );
  assert.equal(createdWs.state, "completed");
  const workspace = createdWs.workspace;
  const channel = createdWs.channel;
  const vault = channelUri(groupDid, "vault");

  const adminActor = await requireActiveWorkspaceAdmin(workspace, owner.did);
  for (const account of [member, outsider, remote]) {
    const invited = await executeOperatorOperation(
      adminActor,
      tidNow(),
      { kind: "inviteMember", subject: account.did },
      registrationDeps,
    );
    assert.equal(invited.state, "completed");
    await acceptGroupMembership(pds, account, groupDid);
  }
  const createdVault = await executeOperatorOperation(
    adminActor,
    tidNow(),
    { kind: "createChannel", skey: "vault", name: "vault", visibility: "private", members: [owner.did, member.did] },
    registrationDeps,
  );
  assert.equal(createdVault.state, "completed");

  for (const [writer, text] of [[owner, AUTHORITY_NOTE], [remote, REMOTE_NOTE]] as const) {
    await new AtprotoClient(bearerSession(writer).fetchHandler).procedure("com.atproto.space.createRecord", {
      space: channel,
      repo: writer.did,
      collection: COLLECTION.message,
      rkey: tidNow(),
      record: { $type: COLLECTION.message, text, createdAt: new Date().toISOString() },
    });
  }
  await waitFor(
    async () => (await readIndependentChannelPage(actorTransport(pds, member), workspace, "general")).messages.length === 2,
    "the Group Host to list both writers",
  );
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
    const body = url.pathname === "/xrpc/com.atproto.space.authorizeSpaceSync" && response.status() !== 200 ? response.text() : Promise.resolve(undefined);
    void Promise.all([response.allHeaders(), request.allHeaders(), body]).then(([headers, requestHeaders, text]) => {
      side.seen.push({ method: request.method(), url, status: response.status(), requestBody: request.postData() ?? "", headers, requestHeaders, body: text });
    }, (error: unknown) => side.failures.push(`unrecorded response ${url.href} (${String(error)})`));
  });
  await signInPage(page, appUrl, actor, WORKSPACE_NAME);
  return side;
}

/** The page's credential exchanges for one space, as the Group Host answered them. */
function credentialAnswers(side: Side, space: string): Seen[] {
  return side.seen.filter((entry) => entry.url.pathname === "/xrpc/com.atproto.space.authorizeSpaceSync" && spaceOf(entry.requestBody) === space);
}

/** The Group Host answers credential refusals for unlisted private spaces as HTTP 400 with `SpaceNotFound`. */
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
