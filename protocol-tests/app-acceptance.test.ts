import assert from "node:assert/strict";
import BetterSqlite3 from "better-sqlite3";
import { spawn } from "node:child_process";
import { mkdtempSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { isAccessLost, SPACE_CREDENTIAL_LIFETIME_MS } from "@flock/protocol/atproto/space-credential-core";
import { createFixtureTempRoot } from "./fixture-temp";
import { actorTransport, callOperatorMethod, expireStoredSession, inProcessOperator, storeAuthorityGrant, type TestPds as NetworkPds } from "./support/pds-network";

type DidResolver = { resolve(did: string, ...args: unknown[]): Promise<unknown> };
type TestPds = NetworkPds & { ctx: NetworkPds["ctx"] & { idResolver: { did: DidResolver } } };
type TestNetwork = { plc: { url: string }; pds: TestPds; extraPdses: TestPds[]; lexiconAuthority?: { did: string }; close(): Promise<void> };
type TestActor = { did: string; accessJwt: string; pds: TestPds };
type Session = { did: string; fetchHandler(path: string, init: RequestInit): Promise<Response> };

const PINNED_CHECKOUT = process.env.ATPROTO_PINNED_CHECKOUT;

test("app acceptance across two real PDS hosts and journal restart", async () => {
  assert.ok(PINNED_CHECKOUT, "set ATPROTO_PINNED_CHECKOUT to the pinned atproto checkout");
  const { TestNetworkNoAppView } = await import(pathToFileURL(join(PINNED_CHECKOUT, "packages/dev-env/src/index.ts")).href) as {
    TestNetworkNoAppView: { create(options: { extraPdses: number; lexiconAuthority: boolean }): Promise<TestNetwork> };
  };
  const fixtureTemp = createFixtureTempRoot("slack-app-acceptance-fixture-");
  let network: TestNetwork;
  try {
    network = await TestNetworkNoAppView.create({ extraPdses: 1, lexiconAuthority: true });
  } catch (error) {
    fixtureTemp.cleanup();
    throw error;
  }
  const directory = mkdtempSync(join(tmpdir(), "slack-app-acceptance-"));
  const databasePath = join(directory, "app.db");
  Object.assign(process.env, { NODE_ENV: "test" });
  process.env.ATPROTO_ACCEPTANCE_TEST = "true";
  process.env.APP_URL = "http://127.0.0.1:3000";
  process.env.AUTH_ENCRYPTION_KEY = "4a".repeat(32);
  const serviceRef = "did:web:localhost%3A3000#atproto_flock_operator";
  process.env.OPERATOR_SERVICE_REF = serviceRef;
  process.env.PLC_URL = network.plc.url;
  process.env.DATABASE_PATH = databasePath;

  try {
    await publishAppLexicons(network);
    const { LexResolver } = await import(pathToFileURL(join(PINNED_CHECKOUT, "packages/lex/lex-resolver/src/lex-resolver.ts")).href) as {
      LexResolver: new (options: Record<string, unknown>) => { get(nsid: string): Promise<unknown> };
    };
    const resolver = new LexResolver({
      fetch: (network.extraPdses[0].ctx as unknown as { safeFetch: unknown }).safeFetch,
      plcDirectoryUrl: network.plc.url,
      hooks: { onResolveAuthority: () => network.lexiconAuthority!.did },
    });
    await resolver.get("new.flock.workspace");
    const fixtureLexiconManager = (network.extraPdses[0].ctx.oauthProvider as unknown as {
      lexiconManager: { getSpacesFromScope(scope: string): Promise<Map<string, { collections: string[] }>> };
    }).lexiconManager;
    assert.ok((await fixtureLexiconManager.getSpacesFromScope("space:com.example.group?authority=did:plc:fixture&skey=workspace&action=read")).has("com.example.group"), "the PDS lexicon authority resolves its built-in space declaration");
    const appSpaceTypes = await fixtureLexiconManager.getSpacesFromScope("space:new.flock.workspace?authority=did:plc:fixture&skey=workspace&action=read");
    assert.deepEqual(appSpaceTypes.get("new.flock.workspace")?.collections, [
      "new.flock.workspace.profile", "new.flock.directory", "new.flock.workspace.roster", "new.flock.admin", "new.flock.app.install", "new.flock.ext.install", "new.flock.acceptance",
    ], "the pinned OAuth provider resolves the app's published workspace space declaration");
    const appInboxTypes = await fixtureLexiconManager.getSpacesFromScope("space:new.flock.app.inbox?authority=did:plc:fixture&skey=inbox&action=read");
    assert.deepEqual(appInboxTypes.get("new.flock.app.inbox")?.collections, [
      "new.flock.app.command", "new.flock.app.action",
    ], "the pinned OAuth provider resolves the app's published app-inbox space declaration");
    const [{ createWorkspace }, { executeOperatorOperation, listInboxWriters, resumePendingWorkspaceCreations }, { parseWorkspaceRef }, { mintSpaceCredential }, { sessionClient }, { createEngine }, { listIndependentWorkspaces, readIndependentChannelPage, readIndependentPrivateRoster }, { validateSpaceRecord }, { acceptanceRecordKey, channelUri, decisionRecordKey, inboxUri, reactionRecordKey, requestRecordKey, subjectKey, tidNow }, { getRawDb }] = await Promise.all([
      import("@flock/operator/operator/kinds/create-workspace"), import("@flock/operator/operator/operations"), import("@flock/operator/operator/actor"), import("@flock/operator/atproto/space-credential"), import("@flock/operator/atproto/client"), import("@flock/client/engine"), import("@flock/reader/independent"), import("@flock/protocol/registry"), import("@flock/protocol/keys"), import("@flock/operator/lib/db"),
    ]);
    const { readSpaceRecords } = await import("@flock/operator/atproto/space-ops");

    const owner = await createActor(network.pds, "alice", "test");
    const member = await createActor(network.extraPdses[0], "bob", "test2");
    const admin = await createActor(network.extraPdses[0], "carol", "test2");
    const outsider = await createActor(network.extraPdses[0], "dan", "test2");
    const ownerSession = sessionFor(owner);
    const memberSession = sessionFor(member);
    const adminSession = sessionFor(admin);
    const outsiderSession = sessionFor(outsider);
    // Each account's engine, as its browser runs it. The member's clock can be moved past a truth interval, so a writer is checked at its host again.
    let memberClockOffsetMs = 0;
    const memberEngine = createEngine(actorTransport({ plcUrl: network.plc.url }, member, { now: () => Date.now() + memberClockOffsetMs }));
    const adminEngine = createEngine(actorTransport({ plcUrl: network.plc.url }, admin), { operator: { serviceRef, endpoint: await inProcessOperator() } });
    const independentDeps = (actor: TestActor) => actorTransport({ plcUrl: network.plc.url }, actor);

    const bootstrap = await createWorkspace(ownerSession as never, { creator: owner.did, name: "Pilot Workspace", operationId: tidNow() });
    assert.equal(bootstrap.state, "completed");
    const bootstrapJournal = getRawDb().prepare("SELECT workspace,request_json FROM operation WHERE actor=? AND operation_id=?")
      .get(owner.did, bootstrap.operationId) as { workspace: string; request_json: string };
    assert.equal(bootstrapJournal.workspace, owner.did, "creation journal rows use the authority key shared by operator recovery");
    assert.deepEqual(JSON.parse(bootstrapJournal.request_json), {
      workspace: bootstrap.workspace, request: { kind: "createWorkspace", name: "Pilot Workspace", creator: owner.did },
    });
    getRawDb().prepare("INSERT INTO notification_registration (service_ref,space_uri,expires_at) VALUES (?,?,?)").run(serviceRef, bootstrap.workspace, Date.now() + 2 * 60 * 60 * 1000);
    const workspace = parseWorkspaceRef(bootstrap.workspace);
    const operatorActor = { did: owner.did, session: ownerSession, workspace, canRecoverOperations: true };

    // The outage outlasts the runner's own retries of a transient failure, so the first attempt is left pending.
    let rejectBootstrapSpaceCreate = true;
    const flakyBootstrapSession = {
      ...ownerSession,
      fetchHandler: async (path: string, init: RequestInit) => {
        if (rejectBootstrapSpaceCreate && path.includes("com.atproto.space.createSpace")) {
          return new Response(JSON.stringify({ error: "ServiceUnavailable", message: "injected bootstrap outage" }), {
            status: 503, headers: { "content-type": "application/json" },
          });
        }
        return ownerSession.fetchHandler(path, init);
      },
    };
    const pendingBootstrap = await createWorkspace(flakyBootstrapSession as never, { creator: owner.did, name: "Retry Workspace", operationId: tidNow() });
    rejectBootstrapSpaceCreate = false;
    assert.equal(pendingBootstrap.state, "pending");
    const retryActor = { ...operatorActor, workspace: parseWorkspaceRef(pendingBootstrap.workspace) };
    const recoveredBootstrapOperation = await executeOperatorOperation(retryActor as never, tidNow(), { kind: "inviteMember", subject: member.did });
    assert.equal(recoveredBootstrapOperation.state, "completed", "operator recovery resumes a visible pending bootstrap before changing membership");
    const recoveredBootstrapRow = getRawDb().prepare("SELECT state FROM operation WHERE workspace=? AND actor=? AND operation_id=?")
      .get(owner.did, owner.did, pendingBootstrap.operationId) as { state: string };
    assert.equal(recoveredBootstrapRow.state, "completed");

    let rejectScheduledBootstrap = true;
    const schedulerFlakySession = {
      ...ownerSession,
      fetchHandler: async (path: string, init: RequestInit) => {
        if (rejectScheduledBootstrap && path.includes("com.atproto.space.createSpace")) {
          return new Response(JSON.stringify({ error: "ServiceUnavailable", message: "injected pre-admin bootstrap outage" }), {
            status: 503, headers: { "content-type": "application/json" },
          });
        }
        return ownerSession.fetchHandler(path, init);
      },
    };
    const pendingScheduledBootstrap = await createWorkspace(schedulerFlakySession as never, {
      creator: owner.did, name: "Scheduled Retry Workspace", operationId: tidNow(),
    });
    rejectScheduledBootstrap = false;
    assert.equal(pendingScheduledBootstrap.state, "pending");
    assert.deepEqual(pendingScheduledBootstrap.completedSteps, [], "the failure is before workspace creation and the initial admin record");
    const scheduledBootstrapRecovery = await resumePendingWorkspaceCreations(ownerSession as never, pendingScheduledBootstrap.workspace);
    assert.equal(scheduledBootstrapRecovery.length, 1);
    assert.equal(scheduledBootstrapRecovery[0]?.state, "completed", "the owner session resumes bootstrap before an admin record exists");

    const memberInvite = await executeOperatorOperation(operatorActor as never, tidNow(), { kind: "inviteMember", subject: member.did });
    assert.equal(memberInvite.state, "completed");
    const adminInvite = await executeOperatorOperation(operatorActor as never, tidNow(), { kind: "inviteMember", subject: admin.did });
    assert.equal(adminInvite.state, "completed");
    const promotion = await executeOperatorOperation(operatorActor as never, tidNow(), { kind: "setAdmin", subject: admin.did, active: true });
    assert.equal(promotion.state, "completed");
    const publicChannel = await executeOperatorOperation(operatorActor as never, tidNow(), { kind: "createChannel", skey: "team-lobby", name: "team-lobby", visibility: "public" });
    assert.equal(publicChannel.state, "completed");
    const privateChannel = await executeOperatorOperation(operatorActor as never, tidNow(), { kind: "createChannel", skey: "team-private", name: "team-private", visibility: "private", members: [admin.did] });
    assert.equal(privateChannel.state, "completed");

    await writeRecord(sessionClient(memberSession as never), bootstrap.workspace, member.did, "new.flock.acceptance", acceptanceRecordKey(bootstrap.workspace), {
      $type: "new.flock.acceptance", workspace: bootstrap.workspace, createdAt: new Date().toISOString(),
    });
    await writeRecord(sessionClient(adminSession as never), bootstrap.workspace, admin.did, "new.flock.acceptance", acceptanceRecordKey(bootstrap.workspace), {
      $type: "new.flock.acceptance", workspace: bootstrap.workspace, createdAt: new Date().toISOString(),
    });

    const { workspaces: discovered } = await memberEngine.workspaces.discover();
    const independent = await listIndependentWorkspaces(independentDeps(member));
    assert.deepEqual(independent, discovered.map(({ uri, authorityDid, name, members, admins, channels, degradedReasons }) => ({ uri, authorityDid, name, members: members.map(({ did }) => did).sort(), admins: admins.sort(), channels, degradedReasons })));
    assert.equal(discovered[0]?.name, "Pilot Workspace");
    assert.deepEqual(discovered[0]?.members.map(({ did }) => did).sort(), [owner.did, member.did, admin.did].sort());
    assert.deepEqual(discovered[0]?.admins, [owner.did, admin.did].sort());
    assert.ok(discovered[0]?.channels.some((channel) => channel.skey === `${workspace.skey}-team-lobby`));

    let failWorkspaceCredential = true;
    const temporarilyUnavailableEngine = createEngine(actorTransport({ plcUrl: network.plc.url }, member, {
      fetchVia: async (request) => {
        if (failWorkspaceCredential && request.url.includes("/xrpc/com.atproto.space.getDelegationToken?")) {
          failWorkspaceCredential = false;
          return new Response(JSON.stringify({ error: "ServiceUnavailable", message: "injected workspace discovery outage" }), {
            status: 503, headers: { "content-type": "application/json" },
          });
        }
        return fetch(request);
      },
    }));
    await assert.rejects(temporarilyUnavailableEngine.workspaces.discover(), (error: unknown) =>
      Boolean(error && typeof error === "object" && "status" in error && error.status === 503),
      "a transient workspace summary failure must surface instead of returning an incomplete successful list",
    );

    // A non-author can store the same collection in their own repo, but both
    // protocol validation and the independent reader must ignore that spoof.
    await writeRecord(sessionClient(memberSession as never), bootstrap.workspace, member.did, "new.flock.admin", subjectKey(member.did), {
      $type: "new.flock.admin", subject: member.did, active: true, updatedAt: new Date().toISOString(),
    });
    assert.equal(validateSpaceRecord("new.flock.admin", { $type: "new.flock.admin", subject: member.did, active: true, updatedAt: new Date().toISOString() }, {
      authorityDid: owner.did, spaceUri: bootstrap.workspace, repoDid: member.did, rkey: subjectKey(member.did),
    }).valid, false);
    assert.deepEqual((await listIndependentWorkspaces(independentDeps(member)))[0]?.admins, [owner.did, admin.did].sort());
    assert.deepEqual((await memberEngine.workspaces.discover()).workspaces[0]?.admins, [owner.did, admin.did].sort(), "the engine reads the admins from the authority's own repo");

    const messageSpace = channelUri(owner.did, `${workspace.skey}-team-lobby`);
    getRawDb().prepare("INSERT INTO notification_registration (service_ref,space_uri,expires_at) VALUES (?,?,?)").run(serviceRef, messageSpace, Date.now() + 2 * 60 * 60 * 1000);
    const oldMessageBase = Date.now() - 1000;
    for (let index = 0; index < 101; index += 1) {
      await writeRecord(sessionClient(memberSession as never), messageSpace, member.did, "new.flock.channel.message", tidNow(oldMessageBase + index), {
        $type: "new.flock.channel.message", text: `second PDS message ${index}`, createdAt: new Date().toISOString(),
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
    await writeRecord(sessionClient(adminSession as never), messageSpace, admin.did, "new.flock.channel.message", tidNow(), {
      $type: "new.flock.channel.message", text: "admin host message", createdAt: new Date().toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const latestMessageMs = Date.now();
    const latestMessageRkey = tidNow(latestMessageMs);
    const latestMessageValue = {
      $type: "new.flock.channel.message", text: "latest second PDS message", createdAt: new Date().toISOString(),
    };
    const latestMessage = await writeRecord(sessionClient(memberSession as never), messageSpace, member.did, "new.flock.channel.message", latestMessageRkey, latestMessageValue);
    const latestMessageUri = latestMessage.uri;
    assert.equal(latestMessageUri, `${messageSpace}/${member.did}/new.flock.channel.message/${latestMessageRkey}`);
    const listedMessages = await readSpaceRecords(memberSession as never, messageSpace, member.did, "new.flock.channel.message", 100);
    assert.equal(listedMessages.find((record) => record.rkey === latestMessageRkey)?.uri, latestMessageUri,
      "the listRecords helper constructs a canonical URI because listRecords does not include one");
    const interopReplyRkey = tidNow(latestMessageMs - 100);
    await writeRecord(sessionClient(memberSession as never), messageSpace, member.did, "new.flock.channel.message", interopReplyRkey, {
      $type: "new.flock.channel.message", text: "reply to PDS returned URI", createdAt: new Date().toISOString(), parent: latestMessageUri,
    });
    const latestReaction = await writeRecord(sessionClient(memberSession as never), messageSpace, member.did, "new.flock.channel.reaction", reactionRecordKey(latestMessageUri, "💜", member.did), {
      $type: "new.flock.channel.reaction", subject: latestMessageUri, emoji: "💜", createdAt: new Date().toISOString(),
    });
    assert.equal(latestReaction.uri, `${messageSpace}/${member.did}/new.flock.channel.reaction/${reactionRecordKey(latestMessageUri, "💜", member.did)}`);
    const lobby = { workspace: bootstrap.workspace, skey: `${workspace.skey}-team-lobby` };
    const primaryPage = await memberEngine.channels.readPage(lobby);
    assert.equal(primaryPage.messages.length, 100, "the app's initial history page is capped at 100 messages");
    assert.equal(primaryPage.messages[0]?.value.text, "latest second PDS message");
    const memberView = await readIndependentChannelPage(independentDeps(member), bootstrap.workspace, lobby.skey);
    const adminView = await readIndependentChannelPage(independentDeps(admin), bootstrap.workspace, lobby.skey);
    assert.equal(memberView.messages.length, 100);
    assert.equal(adminView.messages.length, 100);
    assert.deepEqual(memberView.messages.map((message) => message.uri).sort(), adminView.messages.map((message) => message.uri).sort());
    assert.equal(memberView.messages[0]?.value.text, "latest second PDS message");
    assert.ok(memberView.messages.some((message) => message.value.text === "reply to PDS returned URI"), "the independent reader accepts replies targeting PDS-returned canonical URIs");
    assert.ok(primaryPage.messages.some((message) => message.value.text === "reply to PDS returned URI"), "the app accepts replies targeting PDS-returned canonical URIs");
    assert.ok(primaryPage.reactions.some((reaction) => reaction.uri === latestReaction.uri && reaction.value.subject === latestMessageUri), "the app accepts reactions targeting PDS-returned canonical URIs");
    assert.ok(memberView.messages.some((message) => message.value.text === "admin host message"));
    assert.deepEqual(memberView.reactions, primaryPage.reactions, "the independent reader returns the same latest-page reaction records");
    assert.deepEqual(adminView.reactions, primaryPage.reactions, "reaction records agree across independent accounts");

    // One writer whose account is deactivated must not make the channel unreadable for everyone else: the pinned PDS refuses every other
    // account's read of its repo with RepoDeactivated while the authority still issues it credentials.
    const accountCall = (method: string, jwt: string, body?: string) => fetch(new URL(`/xrpc/${method}`, admin.pds.url), {
      method: "POST", headers: { authorization: `Bearer ${jwt}`, ...(body ? { "content-type": "application/json" } : {}) }, body,
    });
    assert.equal((await accountCall("com.atproto.server.deactivateAccount", admin.accessJwt, "{}")).status, 200, "the admin's host deactivates the account");
    let activated: Response | undefined;
    try {
      // The engine checks a writer at its host again once a truth interval has passed, as it would an hour on.
      memberClockOffsetMs += memberEngine.sync.options.truthIntervalMs;
      const appPage = await memberEngine.channels.readPage(lobby);
      assert.ok(appPage.degradedReasons.length > 0);
      assert.ok(appPage.degradedReasons.some((reason) => reason.includes(admin.did) && reason.includes("its account is deactivated")), "the app names the deactivated writer");
      assert.ok(appPage.messages.some((message) => message.value.text === "latest second PDS message"), "the app still reads the other writers");
      assert.ok(!appPage.messages.some((message) => message.repo === admin.did), "the app serves nothing from the deactivated writer");
      const independentPage = await readIndependentChannelPage(independentDeps(member), bootstrap.workspace, lobby.skey);
      assert.equal(independentPage.degraded, true);
      assert.ok(independentPage.degradedReasons.some((reason) => reason.includes(admin.did) && reason.includes("its account is deactivated")), "the independent reader names the deactivated writer");
      assert.ok(independentPage.messages.some((message) => message.value.text === "latest second PDS message"), "the independent reader still reads the other writers");
      assert.ok(!independentPage.messages.some((message) => message.repo === admin.did), "the independent reader serves nothing from the deactivated writer");
    } finally {
      // Reactivate whatever happened above, without asserting here, so a failure in the try block is not hidden by this one.
      activated = await accountCall("com.atproto.server.activateAccount", admin.accessJwt);
      if (!activated.ok) {
        admin.accessJwt = (await admin.pds.getAgent().com.atproto.server.createSession({ identifier: "carol.test2", password: "carol-acceptance-pass" })).data.accessJwt;
        activated = await accountCall("com.atproto.server.activateAccount", admin.accessJwt);
      }
    }
    assert.equal(activated?.status, 200, `the admin's account is active again: ${await activated?.clone().text()}`);
    memberClockOffsetMs += memberEngine.sync.options.truthIntervalMs;
    const restoredPage = await memberEngine.channels.readPage(lobby);
    assert.ok(restoredPage.messages.some((message) => message.value.text === "admin host message"), "the writer's messages return once the account is active");
    assert.ok(!restoredPage.degradedReasons.some((reason) => reason.includes(admin.did)), "and the writer is no longer reported");
    const restoredIndependent = await readIndependentChannelPage(independentDeps(member), bootstrap.workspace, lobby.skey);
    assert.ok(restoredIndependent.messages.some((message) => message.value.text === "admin host message"), "the independent reader sees the writer again too");
    assert.ok(!restoredIndependent.degradedReasons.some((reason) => reason.includes(admin.did)), "and no longer reports it");

    // The authority's space-deleted notice drops the space's notices and registration, through the real route with a token the authority's PDS signed.
    const doomedSpace = channelUri(owner.did, "doomed-by-notice");
    const registrations = () => (getRawDb().prepare("SELECT count(*) AS count FROM notification_registration WHERE space_uri=?").get(doomedSpace) as { count: number }).count;
    getRawDb().prepare("INSERT INTO notification_registration (service_ref,space_uri,expires_at) VALUES (?,?,?)").run(serviceRef, doomedSpace, Date.now() + 2 * 60 * 60 * 1000);
    const serviceToken = async (actor: TestActor, lxm = "com.atproto.space.notifySpaceDeleted"): Promise<string> => {
      const response = await fetch(new URL(`/xrpc/com.atproto.server.getServiceAuth?aud=${encodeURIComponent(serviceRef)}&lxm=${lxm}`, actor.pds.url), {
        headers: { authorization: `Bearer ${actor.accessJwt}` },
      });
      assert.equal(response.status, 200, "the PDS signs a service token for the app's service ref");
      return ((await response.json()) as { token: string }).token;
    };
    const operatorOrigin = await inProcessOperator();
    const notice = (token: string | null, space: string) => fetch(new URL("/xrpc/com.atproto.space.notifySpaceDeleted", operatorOrigin), {
      method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ space }),
    });
    assert.equal((await notice(null, doomedSpace)).status, 403, "no token");
    assert.equal((await notice(await serviceToken(member), doomedSpace)).status, 403, "a token from someone who is not the space's authority");
    assert.equal((await notice(await serviceToken(owner), channelUri(owner.did, "never-registered"))).status, 403, "a space the app never registered");
    assert.equal((await notice(await serviceToken(owner, "com.atproto.space.notifyWrite"), doomedSpace)).status, 403, "the authority's token, but minted for another method");
    assert.equal(registrations(), 1, "nothing was dropped by a refused notice");
    assert.equal((await notice(await serviceToken(owner), doomedSpace)).status, 200, "the authority's own token is accepted");
    assert.equal(registrations(), 0, "the deleted space's notify registration is gone");

    const inbox = inboxUri(owner.did, workspace.skey);
    const privateSkey = `${workspace.skey}-team-private`;
    const privateSpace = channelUri(owner.did, privateSkey);
    const memberRequestKey = requestRecordKey(privateSpace, member.did);
    let memberRequestUri = "";
    const memberRequestId = tidNow();
    const memberDidResolver = member.pds.ctx.idResolver.did;
    const resolveMemberDid = memberDidResolver.resolve.bind(memberDidResolver);
    memberDidResolver.resolve = async (did: string, ...args: unknown[]) => {
      if (did === owner.did) return null;
      return resolveMemberDid(did, ...args);
    };
    try {
      memberRequestUri = (await writeRecord(sessionClient(memberSession as never), inbox, member.did, "new.flock.joinRequest", memberRequestKey, {
        $type: "new.flock.joinRequest", channelSkey: privateSkey, requestId: memberRequestId, createdAt: new Date().toISOString(),
      })).uri;
    } finally {
      memberDidResolver.resolve = resolveMemberDid;
    }
    assert.equal(memberRequestUri, `${inbox}/${member.did}/new.flock.joinRequest/${memberRequestKey}`);
    await assert.rejects(mintSpaceCredential(memberSession as never, privateSpace), (error: unknown) => isAccessLost(error));
    await assert.rejects(mintSpaceCredential(memberSession as never, inbox), (error: unknown) => isAccessLost(error));
    await assert.rejects(mintSpaceCredential(outsiderSession as never, inbox), (error: unknown) => isAccessLost(error));
    const adminInbox = await mintSpaceCredential(adminSession as never, inbox);
    const inboxRepos = await adminInbox.client(network.pds.url).query<{ repos: Array<{ did: string }> }>("com.atproto.space.listRepos", { space: inbox });
    assert.ok(!inboxRepos.repos.some(({ did }) => did === member.did), "a dropped PDS notification leaves the writer absent from listRepos");
    const candidates = await listInboxWriters(operatorActor as never);
    assert.ok(candidates.writers.includes(member.did), "operator returns the owner-authorized writer candidate");
    // The operator lists the inbox writers for an admin with the authority's own grant.
    await storeAuthorityGrant(network.pds, owner.did, "inbox-writers-grant-dpop");
    const adminOperator = adminEngine.operator;
    assert.ok(adminOperator, "the admin's engine reaches the operator");
    const inboxRequests = () => adminEngine.workspaces.inboxRequests(bootstrap.workspace, adminOperator);
    assert.deepEqual((await inboxRequests()).requests.map(({ uri, requestId, channelSkey, channelName }) => ({ uri, requestId, channelSkey, channelName })),
      [{ uri: memberRequestUri, requestId: memberRequestId, channelSkey: privateSkey, channelName: "team-private" }],
      "the admin's engine lists the member's request, found through the operator's writer list");
    const requestPage = await adminInbox.client(network.extraPdses[0].url).query<{ records: Array<{ value?: { requestId?: string } }> }>("com.atproto.space.listRecords", {
      space: inbox, repo: member.did, collection: "new.flock.joinRequest",
    });
    assert.equal(requestPage.records.length, 1);
    const denial = await executeOperatorOperation(operatorActor as never, tidNow(), {
      kind: "decideJoinRequest", request: memberRequestUri, requestId: memberRequestId, decision: "deny",
    });
    assert.equal(denial.state, "completed");
    await assert.rejects(mintSpaceCredential(memberSession as never, privateSpace), (error: unknown) => isAccessLost(error));
    const denialRecord = await adminInbox.client(network.pds.url).query<{ records: Array<{ value?: { requestId?: string; decision?: string } }> }>("com.atproto.space.listRecords", {
      space: inbox, repo: owner.did, collection: "new.flock.joinDecision", rkey: decisionRecordKey(memberRequestUri),
    });
    assert.equal(denialRecord.records[0]?.value?.requestId, memberRequestId);
    assert.equal(denialRecord.records[0]?.value?.decision, "deny");
    assert.deepEqual((await inboxRequests()).requests, [], "a request with a current decision is not offered again");

    const replacementRequestId = tidNow();
    await writeRecord(sessionClient(memberSession as never), inbox, member.did, "new.flock.joinRequest", memberRequestKey, {
      $type: "new.flock.joinRequest", channelSkey: privateSkey, requestId: replacementRequestId, createdAt: new Date().toISOString(),
    });
    assert.deepEqual((await inboxRequests()).requests.map(({ requestId }) => requestId), [replacementRequestId], "a resubmitted request is open again");
    const staleApproval = await executeOperatorOperation(operatorActor as never, tidNow(), {
      kind: "decideJoinRequest", request: memberRequestUri, requestId: memberRequestId, decision: "approve",
    });
    assert.equal(staleApproval.state, "failed");
    assert.match(staleApproval.error ?? "", /generation is no longer current/i);
    await assert.rejects(mintSpaceCredential(memberSession as never, privateSpace), (error: unknown) => isAccessLost(error));
    const approval = await executeOperatorOperation(operatorActor as never, tidNow(), {
      kind: "decideJoinRequest", request: memberRequestUri, requestId: replacementRequestId, decision: "approve",
    });
    assert.equal(approval.state, "completed");
    const privateMessage = tidNow();
    await writeRecord(sessionClient(memberSession as never), privateSpace, member.did, "new.flock.channel.message", privateMessage, {
      $type: "new.flock.channel.message", text: "approved private message", createdAt: new Date().toISOString(),
    });
    const privateRef = { workspace: bootstrap.workspace, skey: privateSkey };
    assert.deepEqual(await readIndependentPrivateRoster(independentDeps(member), bootstrap.workspace, privateSkey), [admin.did, member.did].sort());
    assert.deepEqual(await memberEngine.channels.roster(privateRef), [admin.did, member.did].sort(), "the engine's roster is the independent reader's");
    assert.equal((await readIndependentChannelPage(independentDeps(member), bootstrap.workspace, privateSkey)).messages[0]?.value.text, "approved private message");
    assert.equal((await memberEngine.channels.readPage(privateRef)).messages[0]?.value.text, "approved private message", "the engine reads the private channel the approval opened");
    const { putSpaceMember, removeSpaceMember } = await import("@flock/operator/atproto/space-ops");
    await removeSpaceMember(ownerSession as never, privateSpace, member.did);
    await assert.rejects(
      memberEngine.channels.send(privateRef, "after removal"),
      (error: unknown) => isAccessLost(error),
      "a removed private-channel member cannot pass the engine's fresh credential gate for writes",
    );
    await putSpaceMember(ownerSession as never, privateSpace, member.did, true, true);
    const preRemovalCredential = await mintSpaceCredential(memberSession as never, bootstrap.workspace);
    assert.ok(preRemovalCredential.expiresAt > Date.now());
    const issued = JSON.parse(Buffer.from(preRemovalCredential.token.split(".")[1]!, "base64url").toString("utf8")) as { iat: number; exp: number; jti: string; cnf: { kid: string } };
    assert.equal(issued.exp - issued.iat, SPACE_CREDENTIAL_LIFETIME_MS / 1000, "the PDS issues credentials with the lifetime the app plans its renewals around");
    assert.ok(issued.exp - issued.iat <= 60 * 60, "and never above the one hour protocol ceiling");
    assert.equal(issued.cnf.kid, preRemovalCredential.key.did(), "the credential is bound to the key that signs its requests");
    assert.ok(issued.jti.length > 0);

    assert.ok((await memberEngine.sync.store.records(messageSpace, "new.flock.channel.message")).length > 0, "the member's engine holds a copy of the channel it read");

    // Seed an unfinished operation after its first remote mutation, then
    // resume its restored journal in a new Node process against the same PDSes.
    const failedOperationId = tidNow();
    let injectedAttempts = 0;
    const failingSession = {
      ...ownerSession,
      fetchHandler: async (path: string, init: RequestInit) => {
        const body = typeof init.body === "string" ? init.body : "";
        if (injectedAttempts < 4 && path.includes("com.atproto.memberspace.removeMember") && body.includes("/space/new.flock.channel/")) {
          injectedAttempts += 1;
          return new Response(JSON.stringify({ message: "injected crash window" }), { status: 503, headers: { "content-type": "application/json" } });
        }
        return ownerSession.fetchHandler(path, init);
      },
    };
    const failingActor = { ...operatorActor, session: failingSession };
    const firstAttempt = await executeOperatorOperation(failingActor as never, failedOperationId, { kind: "removeMember", subject: member.did });
    assert.equal(injectedAttempts, 4, "a persistently unavailable PDS is retried only within the configured bound");
    assert.equal(firstAttempt.state, "pending");
    assert.ok(firstAttempt.completedSteps.includes("remove-inbox-membership"));
    assert.deepEqual(firstAttempt.completedSteps.filter((step: string) => step.startsWith("remove-channel-")).length, 0);

    // Persist the actual SDK session format encrypted under AUTH_ENCRYPTION_KEY.
    // The child recovery process receives that key through its environment,
    // separately from the SQLite backup, and restores the session through the
    // production NodeOAuthClient rather than receiving a bearer JWT.
    const grant = await storeAuthorityGrant(network.pds, owner.did, "backup-acceptance-dpop");
    const encryptedGrant = getRawDb().prepare("SELECT value FROM authority_grant WHERE key = ?").get(owner.did) as { value: string } | undefined;
    assert.ok(encryptedGrant?.value.startsWith("v1."));
    assert.equal(encryptedGrant?.value.includes(grant.accessToken), false, "the authority grant's access token is encrypted in the live database");
    await expireStoredSession("authority_grant", owner.did);
    const refreshedGrant = await (await import("@flock/operator/operator/authority-grant")).restoreAuthorityGrant(owner.did);
    assert.equal(refreshedGrant.did, owner.did, "the expired authority grant refreshes using the authority client");
    await expireStoredSession("authority_grant", owner.did);
    await acceptOperatorCreateWorkspace(ownerSession, serviceRef, owner.did);
    await expireStoredSession("authority_grant", owner.did);

    const backupPath = join(directory, "app-backup.db");
    const restoredPath = join(directory, "app-restored.db");
    const backup = spawn(process.execPath, ["scripts/backup-db.mjs", backupPath], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_PATH: databasePath }, stdio: ["ignore", "pipe", "pipe"],
    });
    let backupStdout = "";
    let backupStderr = "";
    backup.stdout.setEncoding("utf8").on("data", (chunk: string) => { backupStdout += chunk; });
    backup.stderr.setEncoding("utf8").on("data", (chunk: string) => { backupStderr += chunk; });
    const backupExitCode = await new Promise<number | null>((resolve, reject) => {
      backup.once("error", reject);
      backup.once("exit", (code) => resolve(code));
    });
    assert.equal(backupExitCode, 0, `database backup command failed: ${backupStderr}`);
    assert.match(backupStdout, /Database backup written/);
    if (process.platform !== "win32") assert.equal(statSync(backupPath).mode & 0o077, 0, "backup is not accessible to group or other users");
    const backupDb = new BetterSqlite3(backupPath, { readonly: true, fileMustExist: true });
    try {
      assert.equal(backupDb.pragma("integrity_check", { simple: true }), "ok");
      const operation = backupDb.prepare("SELECT state, steps_json FROM operation WHERE operation_id = ?").get(failedOperationId) as { state: string; steps_json: string } | undefined;
      assert.equal(operation?.state, "pending", "the live backup contains the incomplete operator operation");
      assert.ok(JSON.parse(operation?.steps_json ?? "[]").includes("remove-inbox-membership"));
      await backupDb.backup(restoredPath);
    } finally {
      backupDb.close();
    }
    const restoredDb = new BetterSqlite3(restoredPath, { readonly: true, fileMustExist: true });
    try {
      assert.equal(restoredDb.pragma("integrity_check", { simple: true }), "ok");
      const tables = (restoredDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(({ name }) => name);
      for (const removed of (await import("@flock/operator/lib/db")).MEMBER_SESSION_TABLES) {
        assert.ok(!tables.includes(removed), `the server database holds no member session, cursor or channel content: ${removed} is gone`);
      }
    } finally { restoredDb.close(); }
    const resumed = await runRestartRecovery({ databasePath: restoredPath, authorityDid: owner.did, workspace: bootstrap.workspace, memberDid: member.did, operationId: failedOperationId, useStoredAuthorityGrant: true });
    assert.equal(resumed.state, "completed");
    assert.equal(resumed.reconciliationState, "completed", "PDS reconciliation completes after backup restoration");
    const restoredStateDb = new BetterSqlite3(restoredPath);
    try {
      const journalBeforePausedCheck = restoredStateDb.prepare("SELECT workspace, actor, operation_id, state, steps_json, updated_at FROM operation ORDER BY workspace, actor, operation_id").all();
      const pausedCheck = await runReconciliation(restoredPath);
      assert.equal(pausedCheck.exitCode, 0, pausedCheck.stderr);
      assert.match(pausedCheck.stdout, /authority session verified; mutations paused/);
      assert.deepEqual(
        restoredStateDb.prepare("SELECT workspace, actor, operation_id, state, steps_json, updated_at FROM operation ORDER BY workspace, actor, operation_id").all(),
        journalBeforePausedCheck,
        "a successful paused admin check does not modify operation journals",
      );
      const activeReconciliation = await runReconciliation(restoredPath, false);
      assert.equal(activeReconciliation.exitCode, 0, activeReconciliation.stderr);
      assert.match(activeReconciliation.stdout, /completed/);
    } finally {
      restoredStateDb.close();
    }
    const afterRemoval = await memberEngine.workspaces.discover();
    assert.equal(afterRemoval.workspaces.length, 0);
    assert.equal((await memberEngine.sync.store.records(messageSpace, "new.flock.channel.message")).length, 0, "a refused workspace credential renewal purges the engine's held copy");
    await assert.rejects(memberEngine.channels.readPage(lobby), (error: unknown) => isAccessLost(error));
    await assert.rejects(mintSpaceCredential(memberSession as never, bootstrap.workspace), (error: unknown) => isAccessLost(error));
    assert.equal((await listIndependentWorkspaces(independentDeps(member))).length, 0, "the independent reader drops a stale acceptance marker after access is revoked");
    const existingCredentialStillWorks = await preRemovalCredential.client(network.pds.url).query<{ records: Array<{ rkey: string }> }>("com.atproto.space.listRecords", {
      space: bootstrap.workspace, repo: owner.did, collection: "new.flock.workspace.profile",
    });
    assert.equal(existingCredentialStillWorks.records.length, 1, "a previously issued credential remains valid until its expiry");

    await runPhase5FailureMatrix({
      ownerSession,
      memberSession,
      operatorActor,
      memberActor: { ...operatorActor, did: member.did, canRecoverOperations: false },
      ownerDid: owner.did,
      workspace: bootstrap.workspace,
      workspaceSkey: workspace.skey,
      memberDid: member.did,
      adminDid: admin.did,
      outsiderDid: outsider.did,
      publicSkey: `${workspace.skey}-team-lobby`,
      privateSkey,
      databasePath,
      accessJwt: owner.accessJwt,
      pdsUrl: network.pds.url,
    });

    const oauthProvider = network.pds.ctx.oauthProvider;
    assert.ok(oauthProvider);
    const revokedCheckDb = new BetterSqlite3(restoredPath);
    const journalBeforeRevokedCheck = revokedCheckDb.prepare("SELECT workspace, actor, operation_id, state, steps_json, updated_at FROM operation ORDER BY workspace, actor, operation_id").all();
    const encryptedRestoredGrant = revokedCheckDb.prepare("SELECT value FROM authority_grant WHERE key = ?").get(owner.did) as { value: string } | undefined;
    assert.ok(encryptedRestoredGrant);
    const { decryptJson } = await import("@flock/operator/auth/encrypted-store");
    const restoredGrant = decryptJson<{ tokenSet: { access_token: string } }>(encryptedRestoredGrant.value);
    const storedGrant = await oauthProvider.tokenManager.findToken(restoredGrant.tokenSet.access_token);
    assert.ok(storedGrant);
    await oauthProvider.tokenManager.deleteToken(storedGrant.id);
    const revokedSessionCheck = await runReconciliation(restoredPath);
    assert.equal(revokedSessionCheck.exitCode, 1, "reconciliation reports a revoked authority grant");
    assert.match(revokedSessionCheck.stderr, /reconciliation failed/);
    assert.deepEqual(
      revokedCheckDb.prepare("SELECT workspace, actor, operation_id, state, steps_json, updated_at FROM operation ORDER BY workspace, actor, operation_id").all(),
      journalBeforeRevokedCheck,
      "a revoked session cannot mutate the journal while reconciliation is paused",
    );
    revokedCheckDb.close();
  } finally {
    try {
      const { closeDb } = await import("@flock/operator/lib/db");
      closeDb();
      await network.close();
    } finally {
      fixtureTemp.cleanup();
    }
  }
});

async function createActor(pds: TestPds, name: string, domain: string): Promise<TestActor> {
  const { data } = await pds.getAgent().com.atproto.server.createAccount({
    handle: `${name}.${domain}`, email: `${name}@acceptance.test`, password: `${name}-acceptance-pass`,
  });
  return { did: data.did, accessJwt: data.accessJwt, pds };
}

type LifecycleMatrixActor = {
  did: string;
  session: Session;
  workspace: { authorityDid: string; uri: string; skey: string };
  canRecoverOperations: boolean;
};

async function runPhase5FailureMatrix(input: {
  ownerSession: Session;
  memberSession: Session;
  operatorActor: unknown;
  memberActor: unknown;
  ownerDid: string;
  workspace: string;
  workspaceSkey: string;
  memberDid: string;
  adminDid: string;
  outsiderDid: string;
  publicSkey: string;
  privateSkey: string;
  databasePath: string;
  accessJwt: string;
  pdsUrl: string;
}): Promise<void> {
  const [{ executeOperatorOperation }, { ensureMemberListSpace, listSpaceMembers, putAuthorityRecord, putSpaceMember, removeSpaceMember }, { sessionClient }, { channelUri, decisionRecordKey, inboxUri, requestRecordKey, spaceRecordUri, subjectKey, tidNow }, { mintSpaceCredential }, { resolvePds }] = await Promise.all([
    import("@flock/operator/operator/operations"), import("@flock/operator/atproto/space-ops"), import("@flock/operator/atproto/client"), import("@flock/protocol/keys"), import("@flock/operator/atproto/space-credential"), import("@flock/operator/atproto/identity"),
  ]);
  const owner = input.operatorActor as LifecycleMatrixActor;
  const memberActor = input.memberActor as LifecycleMatrixActor;
  const workspace = input.workspace;
  const authorityDid = input.ownerDid;
  const inbox = inboxUri(authorityDid, input.workspaceSkey);
  const publicSpace = channelUri(authorityDid, input.publicSkey);
  const privateSpace = channelUri(authorityDid, input.privateSkey);
  const writeAuthority = (space: string, collection: string, rkey: string, value: Record<string, unknown>) =>
    putAuthorityRecord(input.ownerSession as never, space, collection, rkey, value);
  const rosterRecord = (did: string, active: boolean) => ({ subject: did, active, updatedAt: new Date().toISOString() });
  const membership = async (space: string, did: string) => (await listSpaceMembers(input.ownerSession as never, space)).find((row) => row.did === did);
  const record = async (space: string, collection: string, rkey: string) => {
    const result = await sessionClient(input.ownerSession as never).query<{ value?: Record<string, unknown> }>("com.atproto.space.getRecord", {
      space, repo: authorityDid, collection, rkey,
    });
    return result.value;
  };
  const setWorkspaceRoster = (did: string, active: boolean) => writeAuthority(workspace, "new.flock.workspace.roster", subjectKey(did), rosterRecord(did, active));
  const setAdminRecord = (did: string, active: boolean) => writeAuthority(workspace, "new.flock.admin", subjectKey(did), rosterRecord(did, active));
  const seedMember = async (did: string, activeAdmin: boolean) => {
    await putSpaceMember(input.ownerSession as never, workspace, did, true, true);
    await putSpaceMember(input.ownerSession as never, inbox, did, activeAdmin, true);
    await putSpaceMember(input.ownerSession as never, publicSpace, did, true, true);
    await putSpaceMember(input.ownerSession as never, privateSpace, did, true, true);
    await setWorkspaceRoster(did, true);
    await setAdminRecord(did, activeAdmin);
    await writeAuthority(privateSpace, "new.flock.channel.roster", subjectKey(did), rosterRecord(did, true));
  };
  const resetMember = async (did: string) => {
    await removeSpaceMember(input.ownerSession as never, inbox, did);
    await removeSpaceMember(input.ownerSession as never, workspace, did);
    await removeSpaceMember(input.ownerSession as never, publicSpace, did);
    await removeSpaceMember(input.ownerSession as never, privateSpace, did);
    await setWorkspaceRoster(did, false);
    await setAdminRecord(did, false);
    await writeAuthority(privateSpace, "new.flock.channel.roster", subjectKey(did), rosterRecord(did, false));
  };
  const seedChannel = async (skey: string, visibility: "public" | "private" | "transitioning" | "archived", memberDids: readonly string[], rosterDids: readonly string[]) => {
    const space = channelUri(authorityDid, skey);
    await ensureMemberListSpace(input.ownerSession as never, "new.flock.channel", skey);
    const current = await listSpaceMembers(input.ownerSession as never, space);
    for (const member of current) if (member.did !== authorityDid && !memberDids.includes(member.did)) {
      await removeSpaceMember(input.ownerSession as never, space, member.did);
    }
    for (const did of memberDids) await putSpaceMember(input.ownerSession as never, space, did, true, true);
    await writeAuthority(workspace, "new.flock.directory", skey, { skey, name: `Failure ${skey}`, visibility });
    for (const did of [input.memberDid, input.adminDid, input.outsiderDid]) {
      await writeAuthority(space, "new.flock.channel.roster", subjectKey(did), rosterRecord(did, rosterDids.includes(did)));
    }
  };
  const isRequest = (method: string, predicate: (body: Record<string, unknown>) => boolean) => (path: string, init: RequestInit) => {
    if (init.method !== "POST" || !path.startsWith(`/xrpc/${method}`) || typeof init.body !== "string") return false;
    try { return predicate(JSON.parse(init.body) as Record<string, unknown>); }
    catch { return false; }
  };
  const memberMutation = (method: "putMember" | "removeMember", space: string, did: string, read?: boolean, write?: boolean) =>
    isRequest(`com.atproto.memberspace.${method}`, (body) => body.space === space && body.did === did &&
      (read === undefined || body.read === read) && (write === undefined || body.write === write));
  const recordMutation = (space: string, collection: string, rkey: string, predicate: (value: Record<string, unknown>) => boolean = () => true) =>
    isRequest("com.atproto.space.putRecord", (body) => body.space === space && body.collection === collection && body.rkey === rkey &&
      typeof body.record === "object" && body.record !== null && predicate(body.record as Record<string, unknown>));

  const injectAndRestart = async (
    label: string,
    actor: LifecycleMatrixActor,
    request: Record<string, unknown>,
    expectedStep: string,
    matcher: (path: string, init: RequestInit) => boolean,
    prepare?: () => Promise<void>,
    verify?: () => Promise<void>,
    failBeforeCommit = false,
    verifyPending?: () => Promise<void>,
  ) => {
    await prepare?.();
    const originalSession = actor.session;
    let injected = 0;
    const observedMembershipWrites: string[] = [];
    const faultySession: Session = {
      ...originalSession,
      fetchHandler: async (path, init) => {
        if (path.includes("com.atproto.memberspace.putMember") && typeof init.body === "string") observedMembershipWrites.push(init.body);
        if (injected < 4 && matcher(path, init)) {
          injected += 1;
          if (failBeforeCommit) {
            return new Response(JSON.stringify({ error: "ServiceUnavailable", message: `injected outage: ${label}` }), {
              status: 503, headers: { "content-type": "application/json" },
            });
          }
          const committed = await originalSession.fetchHandler(path, init);
          await committed.arrayBuffer();
          return new Response(JSON.stringify({ error: "ServiceUnavailable", message: `injected response loss: ${label}` }), {
            status: 503, headers: { "content-type": "application/json" },
          });
        }
        return originalSession.fetchHandler(path, init);
      },
    };
    const operationId = tidNow();
    const pending = await executeOperatorOperation({ ...actor, session: faultySession } as never, operationId, request);
    assert.equal(injected, 4, `${label}: expected four failures, got ${injected}; operation=${pending.state}; steps=${pending.completedSteps.join(",")}; error=${pending.error ?? "none"}; membershipWrites=${observedMembershipWrites.join(" | ")}`);
    assert.equal(pending.state, "pending", `${label}: the journal remains pending after the bounded retries`);
    assert.ok(!pending.completedSteps.includes(expectedStep), `${label}: the uncertain step was not checkpointed`);
    await verifyPending?.();
    const resumed = await runRestartRecovery({
      databasePath: input.databasePath, authorityDid, workspace, memberDid: input.memberDid,
      accessJwt: input.accessJwt, pdsUrl: input.pdsUrl, operationId, resumeAll: true,
    });
    assert.equal(resumed.resumedOperationState, "completed", `${label}: a fresh process resumes the operation`);
    assert.equal(resumed.reconciliationState, "completed", `${label}: membership reconciles after restart`);
    await verify?.();
  };

  // The earlier backup drill recovers its copy; resume the still-pending live journal row before new fixtures.
  const initialRecovery = await executeOperatorOperation(owner as never, tidNow(), { kind: "reconcileWorkspace" });
  assert.equal(initialRecovery.state, "completed", "the live acceptance journal is clean before lifecycle fault injection");

  // The earlier acceptance flow deliberately removes this account. Restore its PDS state for lifecycle cases.
  await seedMember(input.memberDid, false);

  // Invite membership and roster fan-out.
  const inviteTargets = [
    ["invite workspace member", workspace, "member-workspace", memberMutation("putMember", workspace, input.outsiderDid, true, true)],
    ["invite inbox writer", inbox, "member-inbox-writer", memberMutation("putMember", inbox, input.outsiderDid, false, true)],
    ["invite public-channel member", publicSpace, `member-public-channel-${input.publicSkey}`, memberMutation("putMember", publicSpace, input.outsiderDid, true, true)],
    ["write workspace roster", workspace, "member-workspace-roster", recordMutation(workspace, "new.flock.workspace.roster", subjectKey(input.outsiderDid), (value) => value.active === true)],
  ] as const;
  for (const [label, , step, matcher] of inviteTargets) {
    await injectAndRestart(label, owner, { kind: "inviteMember", subject: input.outsiderDid }, step, matcher,
      () => resetMember(input.outsiderDid),
      async () => {
        assert.ok(await membership(workspace, input.outsiderDid));
        assert.equal((await membership(inbox, input.outsiderDid))?.read, false);
        assert.ok(await membership(publicSpace, input.outsiderDid));
        assert.equal((await record(workspace, "new.flock.workspace.roster", subjectKey(input.outsiderDid)))?.active, true);
      });
  }

  // Removal fans out through both channel kinds, all authority records, and the inbox.
  const removeTargets = [
    ["remove inbox membership", "remove-inbox-membership", memberMutation("removeMember", inbox, input.adminDid)],
    ["remove public-channel membership", `remove-channel-${input.publicSkey}`, memberMutation("removeMember", publicSpace, input.adminDid)],
    ["remove private-channel membership", `remove-channel-${input.privateSkey}`, memberMutation("removeMember", privateSpace, input.adminDid)],
    ["deactivate private-channel roster", `remove-channel-${input.privateSkey}`, recordMutation(privateSpace, "new.flock.channel.roster", subjectKey(input.adminDid), (value) => value.active === false)],
    ["remove workspace membership", "remove-workspace-membership", memberMutation("removeMember", workspace, input.adminDid)],
    ["deactivate workspace roster", "deactivate-workspace-roster", recordMutation(workspace, "new.flock.workspace.roster", subjectKey(input.adminDid), (value) => value.active === false)],
    ["deactivate admin record", "deactivate-admin", recordMutation(workspace, "new.flock.admin", subjectKey(input.adminDid), (value) => value.active === false)],
  ] as const;
  for (const [label, step, matcher] of removeTargets) {
    await injectAndRestart(label, owner, { kind: "removeMember", subject: input.adminDid }, step, matcher,
      () => seedMember(input.adminDid, true),
      async () => {
        assert.equal(await membership(inbox, input.adminDid), undefined);
        assert.equal(await membership(workspace, input.adminDid), undefined);
        assert.equal((await record(workspace, "new.flock.workspace.roster", subjectKey(input.adminDid)))?.active, false);
        assert.equal((await record(workspace, "new.flock.admin", subjectKey(input.adminDid)))?.active, false);
      }, label === "deactivate admin record");
  }

  // Promotion and demotion update the admin record and inbox read permission in safe order.
  const adminTargets = [
    ["promote admin record", true, "write-admin-active", recordMutation(workspace, "new.flock.admin", subjectKey(input.adminDid), (value) => value.active === true)],
    ["grant admin inbox read", true, "grant-inbox-read", memberMutation("putMember", inbox, input.adminDid, true, true)],
    ["remove admin inbox read", false, "remove-inbox-read", memberMutation("putMember", inbox, input.adminDid, false, true)],
    ["demote admin record", false, "write-admin-inactive", recordMutation(workspace, "new.flock.admin", subjectKey(input.adminDid), (value) => value.active === false)],
  ] as const;
  for (const [label, active, step, matcher] of adminTargets) {
    await injectAndRestart(label, owner, { kind: "setAdmin", subject: input.adminDid, active }, step, matcher,
      () => seedMember(input.adminDid, !active),
      async () => {
        assert.equal((await record(workspace, "new.flock.admin", subjectKey(input.adminDid)))?.active, active);
        assert.equal((await membership(inbox, input.adminDid))?.read, active);
      });
  }

  // The last non-authority admin cannot be demoted, removed, or leave.
  await seedMember(input.adminDid, true);
  await setAdminRecord(input.ownerDid, false);
  const lastAdminActor = { ...owner, did: input.adminDid, canRecoverOperations: false };
  for (const [label, actor, request] of [
    ["last-admin demotion", owner, { kind: "setAdmin", subject: input.adminDid, active: false }],
    ["last-admin removal", owner, { kind: "removeMember", subject: input.adminDid }],
    ["last-admin self-leave", lastAdminActor, { kind: "leaveWorkspace" }],
  ] as const) {
    const result = await executeOperatorOperation(actor as never, tidNow(), request);
    assert.equal(result.state, "failed", `${label} is rejected before any membership changes`);
    assert.match(result.error ?? "", /last active admin/i, label);
  }
  await setAdminRecord(input.ownerDid, true);

  // Channel creation writes the member list before publishing its directory entry.
  const createCases = [
    ["create channel space", "create-space", "channel-space", (space: string) => isRequest("com.atproto.space.createSpace", (body) => body.skey === space.split("/").at(-1))],
    ["add private channel member", "create-private-member", `channel-member-${input.outsiderDid}`, (space: string) => memberMutation("putMember", space, input.outsiderDid, true, true)],
    ["write private channel roster", "create-private-roster", `channel-roster-${input.outsiderDid}`, (space: string) => recordMutation(space, "new.flock.channel.roster", subjectKey(input.outsiderDid), (value) => value.active === true)],
    ["publish channel directory", "create-directory", "channel-directory", (space: string) => recordMutation(workspace, "new.flock.directory", space.split("/").at(-1) ?? "")],
  ] as const;
  for (const [label, suffix, expectedStep, buildMatcher] of createCases) {
    const requestKey = `fault-${suffix}`;
    const channelSkey = `${input.workspaceSkey}-${requestKey}`;
    const visibility = suffix === "create-private-member" || suffix === "create-private-roster" ? "private" : "public";
    const request = { kind: "createChannel", skey: requestKey, name: `Failure ${suffix}`, visibility, ...(visibility === "private" ? { members: [input.outsiderDid] } : {}) };
    await injectAndRestart(label, owner, request, expectedStep, buildMatcher(channelUri(authorityDid, channelSkey)), undefined,
      async () => {
        assert.equal((await record(workspace, "new.flock.directory", channelSkey))?.visibility, visibility);
        if (visibility === "private") {
          assert.ok(await membership(channelUri(authorityDid, channelSkey), input.outsiderDid));
          assert.equal((await record(channelUri(authorityDid, channelSkey), "new.flock.channel.roster", subjectKey(input.outsiderDid)))?.active, true);
        } else {
          assert.ok(await membership(channelUri(authorityDid, channelSkey), input.outsiderDid));
        }
      }, label === "create channel space");
  }

  // Channel visibility changes pause sync at `transitioning` and converge the same space URI.
  const transitionSkey = `${input.workspaceSkey}-fault-transition`;
  const transitionSpace = channelUri(authorityDid, transitionSkey);
  const transitionMemberDid = input.outsiderDid;
  await seedChannel(transitionSkey, "public", [input.memberDid], []);
  const transitionMessageRkey = tidNow();
  await writeRecord(sessionClient(input.memberSession as never), transitionSpace, input.memberDid, "new.flock.channel.message", transitionMessageRkey, {
    $type: "new.flock.channel.message", text: "preserved through visibility changes", createdAt: new Date().toISOString(),
  });
  const transitionCredential = await mintSpaceCredential(input.memberSession as never, transitionSpace);
  const memberPds = await resolvePds(input.memberDid);
  const transitionCases = [
    ["set channel transitioning", "public", [transitionMemberDid], [input.adminDid], "private", [transitionMemberDid], "channel-set-transitioning", recordMutation(workspace, "new.flock.directory", transitionSkey, (value) => value.visibility === "transitioning"), false],
    ["add public channel member", "private", [], [transitionMemberDid], "public", [transitionMemberDid], `channel-public-add-${transitionMemberDid}`, memberMutation("putMember", transitionSpace, transitionMemberDid, true, true), false],
    ["remove channel member", "public", [transitionMemberDid, input.adminDid], [input.adminDid], "private", [transitionMemberDid], `channel-remove-${input.adminDid}`, memberMutation("removeMember", transitionSpace, input.adminDid), true],
    ["deactivate private roster", "public", [transitionMemberDid, input.adminDid], [input.adminDid], "private", [transitionMemberDid], `channel-roster-inactive-${input.adminDid}`, recordMutation(transitionSpace, "new.flock.channel.roster", subjectKey(input.adminDid), (value) => value.active === false), true],
    ["add private channel member", "private", [], [], "private", [transitionMemberDid], `channel-private-add-${transitionMemberDid}`, memberMutation("putMember", transitionSpace, transitionMemberDid, true, true), false],
    ["activate private roster", "private", [], [], "private", [transitionMemberDid], `channel-roster-active-${transitionMemberDid}`, recordMutation(transitionSpace, "new.flock.channel.roster", subjectKey(transitionMemberDid), (value) => value.active === true), false],
    ["publish final channel visibility", "transitioning", [transitionMemberDid], [transitionMemberDid], "private", [transitionMemberDid], "channel-set-final-visibility", recordMutation(workspace, "new.flock.directory", transitionSkey, (value) => value.visibility === "private"), false],
  ] as const;
  for (const [label, initialVisibility, initialMembers, initialRoster, targetVisibility, targetMembers, expectedStep, matcher, failBeforeCommit] of transitionCases) {
    const request = { kind: "transitionChannel", skey: transitionSkey, visibility: targetVisibility, ...(targetVisibility === "private" ? { members: targetMembers } : {}) };
    await injectAndRestart(label, owner, request, expectedStep, matcher, () => seedChannel(transitionSkey, initialVisibility, initialMembers, initialRoster),
      async () => {
        assert.equal((await record(workspace, "new.flock.directory", transitionSkey))?.visibility, targetVisibility);
        const actual = (await listSpaceMembers(input.ownerSession as never, transitionSpace)).map(({ did }) => did);
        assert.equal(actual.includes(transitionMemberDid), targetMembers.includes(transitionMemberDid));
        if (targetVisibility === "private") {
          assert.equal((await record(transitionSpace, "new.flock.channel.roster", subjectKey(transitionMemberDid)))?.active, targetMembers.includes(transitionMemberDid));
        }
        const preserved = await transitionCredential.client(memberPds).query<{ uri: string; value: Record<string, unknown> }>("com.atproto.space.getRecord", {
          space: transitionSpace, repo: input.memberDid, collection: "new.flock.channel.message", rkey: transitionMessageRkey,
        });
        assert.equal(preserved.uri, `${transitionSpace}/${input.memberDid}/new.flock.channel.message/${transitionMessageRkey}`);
        assert.equal(preserved.value.text, "preserved through visibility changes");
      }, failBeforeCommit,
      async () => assert.equal(
        (await record(workspace, "new.flock.directory", transitionSkey))?.visibility,
        expectedStep === "channel-set-final-visibility" ? targetVisibility : "transitioning",
      ));
  }

  // Archive first marks the directory, removes members, deactivates private rosters, then publishes archived.
  const archiveCases = [
    ["mark channel transitioning for archive", "archive-transition", "channel-archive-transition", (skey: string) => recordMutation(workspace, "new.flock.directory", skey, (value) => value.visibility === "transitioning"), false],
    ["remove channel member for archive", "archive-remove", `channel-archive-remove-${input.memberDid}`, (skey: string) => memberMutation("removeMember", channelUri(authorityDid, skey), input.memberDid), true],
    ["deactivate private roster for archive", "archive-roster", `channel-archive-roster-${input.memberDid}`, (skey: string) => recordMutation(channelUri(authorityDid, skey), "new.flock.channel.roster", subjectKey(input.memberDid), (value) => value.active === false), true],
    ["publish archived channel", "archive-final", "channel-archive-final", (skey: string) => recordMutation(workspace, "new.flock.directory", skey, (value) => value.visibility === "archived"), true],
  ] as const;
  for (const [label, suffix, expectedStep, buildMatcher, failBeforeCommit] of archiveCases) {
    const skey = `${input.workspaceSkey}-${suffix}`;
    const space = channelUri(authorityDid, skey);
    const messageRkey = tidNow();
    let archiveCredential: Awaited<ReturnType<typeof mintSpaceCredential>> | undefined;
    await injectAndRestart(label, owner, { kind: "archiveChannel", skey }, expectedStep, buildMatcher(skey),
      async () => {
        await seedChannel(skey, "private", [input.memberDid, input.adminDid], [input.memberDid, input.adminDid]);
        await writeRecord(sessionClient(input.memberSession as never), space, input.memberDid, "new.flock.channel.message", messageRkey, {
          $type: "new.flock.channel.message", text: "retained after archive", createdAt: new Date().toISOString(),
        });
        archiveCredential = await mintSpaceCredential(input.memberSession as never, space);
      },
      async () => {
        assert.equal((await record(workspace, "new.flock.directory", skey))?.visibility, "archived");
        assert.equal((await membership(space, input.memberDid)), undefined);
        assert.equal((await membership(space, input.adminDid)), undefined);
        assert.equal((await record(space, "new.flock.channel.roster", subjectKey(input.memberDid)))?.active, false);
        assert.equal((await record(space, "new.flock.channel.roster", subjectKey(input.adminDid)))?.active, false);
        assert.ok(archiveCredential);
        const archivedMessage = await archiveCredential.client(memberPds).query<{ uri: string; value: Record<string, unknown> }>("com.atproto.space.getRecord", {
          space, repo: input.memberDid, collection: "new.flock.channel.message", rkey: messageRkey,
        });
        assert.equal(archivedMessage.uri, `${space}/${input.memberDid}/new.flock.channel.message/${messageRkey}`);
        assert.equal(archivedMessage.value.text, "retained after archive");
        await assert.rejects(mintSpaceCredential(input.memberSession as never, space), (error: unknown) => isAccessLost(error));
      }, failBeforeCommit,
      async () => assert.equal(
        (await record(workspace, "new.flock.directory", skey))?.visibility,
        label === "publish archived channel" && !failBeforeCommit ? "archived" : "transitioning",
      ));
  }

  // Approval grants membership and publishes the roster before recording its decision.
  const joinSkey = `${input.workspaceSkey}-fault-join`;
  const joinSpace = channelUri(authorityDid, joinSkey);
  const joinRequestKey = requestRecordKey(joinSpace, input.memberDid);
  const joinRequestUri = spaceRecordUri(inbox, input.memberDid, "new.flock.joinRequest", joinRequestKey);
  const joinCases = [
    ["approve private membership", "approve", "join-request-channel-membership", "membership"],
    ["write approved private roster", "approve", "join-request-private-roster", "roster"],
    ["record approval decision", "approve", "join-request-decision", "approve"],
    ["record denial decision", "deny", "join-request-decision", "deny"],
  ] as const;
  for (const [label, decision, expectedStep, matchKind] of joinCases) {
    const requestId = tidNow();
    const matcher = matchKind === "membership"
      ? memberMutation("putMember", joinSpace, input.memberDid, true, true)
      : matchKind === "roster"
        ? recordMutation(joinSpace, "new.flock.channel.roster", subjectKey(input.memberDid), (value) => value.active === true)
        : recordMutation(inbox, "new.flock.joinDecision", decisionRecordKey(joinRequestUri), (value) => value.requestId === requestId && value.decision === matchKind);
    await injectAndRestart(label, owner, { kind: "decideJoinRequest", request: joinRequestUri, requestId, decision }, expectedStep,
      matcher,
      async () => {
        await seedChannel(joinSkey, "private", [], []);
        await writeRecord(sessionClient(input.memberSession as never), inbox, input.memberDid, "new.flock.joinRequest", joinRequestKey, {
          $type: "new.flock.joinRequest", channelSkey: joinSkey, requestId, createdAt: new Date().toISOString(),
        });
      },
      async () => {
        const joined = decision === "approve";
        assert.equal(Boolean(await membership(joinSpace, input.memberDid)), joined);
        assert.equal((await record(joinSpace, "new.flock.channel.roster", subjectKey(input.memberDid)))?.active, joined);
        const savedDecision = await record(inbox, "new.flock.joinDecision", decisionRecordKey(joinRequestUri));
        assert.equal(savedDecision?.requestId, requestId);
        assert.equal(savedDecision?.decision, decision);
      });
  }

  // Self-leave goes through the same serialized fan-out and is recoverable under the requester's actor DID.
  const leaveCases = [
    ["self-leave inbox membership", "remove-inbox-membership", memberMutation("removeMember", inbox, input.memberDid)],
    ["self-leave public channel membership", `remove-channel-${input.publicSkey}`, memberMutation("removeMember", publicSpace, input.memberDid)],
    ["self-leave private channel membership and roster", `remove-channel-${input.privateSkey}`, memberMutation("removeMember", privateSpace, input.memberDid)],
    ["self-leave workspace membership", "remove-workspace-membership", memberMutation("removeMember", workspace, input.memberDid)],
    ["self-leave workspace roster", "deactivate-workspace-roster", recordMutation(workspace, "new.flock.workspace.roster", subjectKey(input.memberDid), (value) => value.active === false)],
  ] as const;
  for (const [label, expectedStep, matcher] of leaveCases) {
    await injectAndRestart(label, memberActor, { kind: "leaveWorkspace" }, expectedStep, matcher,
      () => seedMember(input.memberDid, false),
      async () => {
        assert.equal(await membership(workspace, input.memberDid), undefined);
        assert.equal(await membership(inbox, input.memberDid), undefined);
        assert.equal(await membership(publicSpace, input.memberDid), undefined);
        assert.equal(await membership(privateSpace, input.memberDid), undefined);
        assert.equal((await record(workspace, "new.flock.workspace.roster", subjectKey(input.memberDid)))?.active, false);
      });
  }

  const privateLeaveSkey = `${input.workspaceSkey}-fault-private-leave`;
  const privateLeaveSpace = channelUri(authorityDid, privateLeaveSkey);
  const privateLeaveCases = [
    ["leave private channel membership", "leave-channel-membership", memberMutation("removeMember", privateLeaveSpace, input.memberDid)],
    ["leave private channel roster", "leave-channel-roster", recordMutation(privateLeaveSpace, "new.flock.channel.roster", subjectKey(input.memberDid), (value) => value.active === false)],
  ] as const;
  for (const [label, expectedStep, matcher] of privateLeaveCases) {
    await injectAndRestart(label, memberActor, { kind: "leaveChannel", skey: privateLeaveSkey }, expectedStep, matcher,
      async () => {
        await seedMember(input.memberDid, false);
        await seedChannel(privateLeaveSkey, "private", [input.memberDid], [input.memberDid]);
      },
      async () => {
        assert.equal(await membership(privateLeaveSpace, input.memberDid), undefined);
        assert.equal((await record(privateLeaveSpace, "new.flock.channel.roster", subjectKey(input.memberDid)))?.active, false);
      });
  }

  // Reconciliation repairs each authoritative source against the PDS member list, including stale private and archived state.
  const reconcileCases = [
    ["reconcile workspace membership", `workspace-set-${input.memberDid}`, memberMutation("putMember", workspace, input.memberDid, true, true), async () => {
      await seedMember(input.memberDid, false);
      await removeSpaceMember(input.ownerSession as never, workspace, input.memberDid);
    }],
    ["remove unrostered workspace member", `workspace-remove-${input.outsiderDid}`, memberMutation("removeMember", workspace, input.outsiderDid), async () => {
      await resetMember(input.outsiderDid);
      await putSpaceMember(input.ownerSession as never, workspace, input.outsiderDid, true, true);
    }],
    ["repair inbox writer permissions", `inbox-set-${input.memberDid}`, memberMutation("putMember", inbox, input.memberDid, false, true), async () => {
      await seedMember(input.memberDid, false);
      await putSpaceMember(input.ownerSession as never, inbox, input.memberDid, true, true);
    }],
    ["remove unrostered inbox writer", `inbox-remove-${input.outsiderDid}`, memberMutation("removeMember", inbox, input.outsiderDid), async () => {
      await resetMember(input.outsiderDid);
      await putSpaceMember(input.ownerSession as never, inbox, input.outsiderDid, false, true);
    }],
    ["reconcile public channel member", `channel-${input.publicSkey}-set-${input.memberDid}`, memberMutation("putMember", publicSpace, input.memberDid, true, true), async () => {
      await seedMember(input.memberDid, false);
      await removeSpaceMember(input.ownerSession as never, publicSpace, input.memberDid);
    }],
    ["remove unrostered public channel member", `channel-${input.publicSkey}-remove-${input.outsiderDid}`, memberMutation("removeMember", publicSpace, input.outsiderDid), async () => {
      await resetMember(input.outsiderDid);
      await putSpaceMember(input.ownerSession as never, publicSpace, input.outsiderDid, true, true);
    }],
    ["reconcile private channel member", `channel-${input.privateSkey}-set-${input.memberDid}`, memberMutation("putMember", privateSpace, input.memberDid, true, true), async () => {
      await seedMember(input.memberDid, false);
      await seedChannel(input.privateSkey, "private", [], [input.memberDid]);
    }],
    ["deactivate stale private roster", `channel-${input.privateSkey}-deactivate-stale-roster-${input.outsiderDid}`, recordMutation(privateSpace, "new.flock.channel.roster", subjectKey(input.outsiderDid), (value) => value.active === false), async () => {
      await resetMember(input.outsiderDid);
      await seedChannel(input.privateSkey, "private", [input.outsiderDid], [input.outsiderDid]);
    }],
    ["remove stale private channel member", `channel-${input.privateSkey}-remove-${input.outsiderDid}`, memberMutation("removeMember", privateSpace, input.outsiderDid), async () => {
      await resetMember(input.outsiderDid);
      await seedChannel(input.privateSkey, "private", [input.outsiderDid], [input.outsiderDid]);
    }],
  ] as const;
  for (const [label, expectedStep, matcher, prepare] of reconcileCases) {
    await injectAndRestart(label, owner, { kind: "reconcileWorkspace" }, expectedStep, matcher, prepare,
      async () => {
        const workspaceMembers = await listSpaceMembers(input.ownerSession as never, workspace);
        const activeMember = (await record(workspace, "new.flock.workspace.roster", subjectKey(input.memberDid)))?.active === true;
        const activeOutsider = (await record(workspace, "new.flock.workspace.roster", subjectKey(input.outsiderDid)))?.active === true;
        assert.equal(workspaceMembers.some(({ did }) => did === input.memberDid), activeMember, `${label}: member list matches the active workspace roster`);
        assert.equal(workspaceMembers.some(({ did }) => did === input.outsiderDid), activeOutsider, `${label}: outsider membership matches the active workspace roster`);
      }, true);
  }

  const archivedRepairSkey = `${input.workspaceSkey}-fault-reconcile-archived`;
  const archivedRepairSpace = channelUri(authorityDid, archivedRepairSkey);
  const archivedReconcileCases = [
    ["remove archived channel member", `archived-${archivedRepairSkey}-remove-${input.memberDid}`, memberMutation("removeMember", archivedRepairSpace, input.memberDid)],
    ["deactivate archived channel roster", `archived-${archivedRepairSkey}-deactivate-roster-${input.memberDid}`, recordMutation(archivedRepairSpace, "new.flock.channel.roster", subjectKey(input.memberDid), (value) => value.active === false)],
  ] as const;
  for (const [label, expectedStep, matcher] of archivedReconcileCases) {
    await injectAndRestart(label, owner, { kind: "reconcileWorkspace" }, expectedStep, matcher,
      () => seedChannel(archivedRepairSkey, "archived", [input.memberDid], [input.memberDid]),
      async () => {
        assert.equal(await membership(archivedRepairSpace, input.memberDid), undefined);
        assert.equal((await record(archivedRepairSpace, "new.flock.channel.roster", subjectKey(input.memberDid)))?.active, false);
      }, true);
  }

  // Keep both account sessions live in the matrix so later phase-specific cases can test requester writes.
  assert.equal(input.memberSession.did, input.memberDid);
}

async function publishAppLexicons(network: TestNetwork): Promise<void> {
  assert.ok(network.lexiconAuthority, "fixture must expose its lexicon authority");
  const agent = network.pds.getAgent();
  const session = await agent.com.atproto.server.createSession({ identifier: "lex-authority.test", password: "hunter2" });
  const root = join(process.cwd(), "packages/protocol/lexicons/new/flock");
  const files = await readdir(root, { recursive: true });
  const published = new Set<string>();
  for (const relative of files.filter((file) => file.endsWith(".json"))) {
    const lexicon = JSON.parse(await readFile(join(root, relative), "utf8")) as { id: string };
    if (published.has(lexicon.id)) continue;
    published.add(lexicon.id);
    await agent.com.atproto.repo.createRecord({
      repo: network.lexiconAuthority.did,
      collection: "com.atproto.lexicon.schema",
      rkey: lexicon.id,
      record: lexicon,
    }, { headers: { authorization: `Bearer ${session.data.accessJwt}` } });
  }
  const recordUrl = new URL("/xrpc/com.atproto.repo.getRecord", network.pds.url);
  recordUrl.search = new URLSearchParams({ repo: network.lexiconAuthority.did, collection: "com.atproto.lexicon.schema", rkey: "new.flock.workspace" }).toString();
  const response = await fetch(recordUrl, { headers: { authorization: `Bearer ${session.data.accessJwt}` } });
  const recordBody = await response.json() as { value?: Record<string, unknown> };
  assert.equal(response.status, 200, `published workspace space declaration is readable: ${JSON.stringify(recordBody)}`);
  assert.equal(recordBody.value?.id, "new.flock.workspace");
  assert.equal(recordBody.value?.$type, "com.atproto.lexicon.schema", "the published declaration is a Lexicon schema record");
}

function sessionFor(actor: TestActor): Session {
  return {
    did: actor.did,
    fetchHandler: async (path, init) => {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${actor.accessJwt}`);
      return fetch(new URL(path, actor.pds.url), { ...init, headers, redirect: "error" });
    },
  };
}

async function writeRecord(client: { procedure<TInput, TOutput>(method: string, input: TInput): Promise<TOutput> }, space: string, repo: string, collection: string, rkey: string, record: Record<string, unknown>): Promise<{ uri: string; cid: string }> {
  return client.procedure<Record<string, unknown>, { uri: string; cid: string }>("com.atproto.space.putRecord", { space, repo, collection, rkey, record });
}

async function runReconciliation(databasePath: string, mutationsPaused = true): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", "apps/operator/scripts/reconcile-workspaces.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_PATH: databasePath, FLOCK_ADMIN_MUTATIONS_PAUSED: mutationsPaused ? "true" : "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { exitCode, stdout, stderr };
}

async function acceptOperatorCreateWorkspace(session: Session, serviceRef: string, authorityDid: string): Promise<void> {
  const { tidNow } = await import("@flock/protocol/keys");
  // The owner asks as a member, with a service token from their own host; the operator creates the workspace with the separate authority grant.
  const body = { name: "Authenticated Operator Workspace", operationId: tidNow() };
  const anonymous = await fetch(new URL("/xrpc/new.flock.operator.createWorkspace", await inProcessOperator()), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal(anonymous.status, 403, "the operator refuses a request without a service token");
  const result = await callOperatorMethod(session, serviceRef, "new.flock.operator.createWorkspace", {}, body) as { state: string; workspace: string };
  assert.equal(result.state, "completed", "the operator restores the encrypted authority grant and bootstraps against the PDS");
  assert.ok(result.workspace.startsWith(`at://${authorityDid}/space/new.flock.workspace/`));
}

async function runRestartRecovery(input: {
  databasePath: string; authorityDid: string; workspace: string; memberDid: string; operationId: string; accessJwt?: string; pdsUrl?: string; resumeAll?: boolean; useStoredAuthorityGrant?: boolean;
}): Promise<{ state: string; completedSteps: string[]; resumedOperationState: string | null; reconciliationState: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", "protocol-tests/recover-pending-operation.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_PATH: input.databasePath,
      RECOVERY_AUTHORITY_DID: input.authorityDid,
      RECOVERY_WORKSPACE: input.workspace,
      RECOVERY_MEMBER_DID: input.memberDid,
      RECOVERY_ACCESS_JWT: input.accessJwt ?? "",
      RECOVERY_PDS_URL: input.pdsUrl ?? "",
      RECOVERY_OPERATION_ID: input.operationId,
      RECOVERY_RESUME_ALL: input.resumeAll ? "true" : "false",
      RECOVERY_USE_STORED_AUTHORITY_GRANT: input.useStoredAuthorityGrant ? "true" : "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  assert.equal(exitCode, 0, `restart recovery subprocess failed: ${stderr}`);
  return JSON.parse(stdout.trim()) as {
    state: string;
    completedSteps: string[];
    resumedOperationState: string | null;
    reconciliationState: string;
  };
}
