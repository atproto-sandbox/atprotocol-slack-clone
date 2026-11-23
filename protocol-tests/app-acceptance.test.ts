import assert from "node:assert/strict";
import BetterSqlite3 from "better-sqlite3";
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { isAccessLost, SPACE_CREDENTIAL_LIFETIME_MS } from "@flock/protocol/atproto/space-credential-core";
import { channelRoleKey, groupMembersUri } from "@flock/protocol/keys";
import { COLLECTION, OPENSOCIAL_COLLECTION, OPENSOCIAL_POLICY, SPACE_TYPE } from "@flock/protocol/nsids";
import {
  acceptGroupMembership,
  actorTransport,
  bearerSession,
  callOperatorMethod,
  createOpenSocialGroup,
  expireStoredSession,
  inProcessOperator,
  pinnedCheckout,
  startPdsNetwork,
  storeGroupAuthorityGrant,
  type BearerSession,
  type NetworkActor,
  type PdsNetwork,
} from "./support/pds-network";

test("app acceptance across two real PDS hosts, OpenSocial Group Host, and journal restart", { timeout: 10 * 60_000 }, async () => {
  const checkout = pinnedCheckout();
  const pds = await startPdsNetwork("app-acceptance");
  const databasePath = pds.databasePath;
  const serviceRef = pds.serviceRef;

  try {
    const { LexResolver } = (await import(
      pathToFileURL(join(checkout, "packages/lex/lex-resolver/src/lex-resolver.ts")).href
    )) as {
      LexResolver: new (options: Record<string, unknown>) => { get(nsid: string): Promise<unknown> };
    };
    const resolver = new LexResolver({
      fetch: (pds.hosts[1].ctx as unknown as { safeFetch: unknown }).safeFetch,
      plcDirectoryUrl: pds.plcUrl,
      hooks: { onResolveAuthority: () => pds.network.lexiconAuthority!.did },
    });
    await resolver.get("new.flock.workspace");
    await resolver.get("group.opensocial.members");

    const fixtureLexiconManager = (pds.hosts[1].ctx.oauthProvider as unknown as {
      lexiconManager: { getSpacesFromScope(scope: string): Promise<Map<string, { collections: string[] }>> };
    }).lexiconManager;
    assert.ok(
      (await fixtureLexiconManager.getSpacesFromScope("space:com.example.group?authority=did:plc:fixture&skey=workspace&action=read")).has(
        "com.example.group",
      ),
      "the PDS lexicon authority resolves its built-in space declaration",
    );
    const appSpaceTypes = await fixtureLexiconManager.getSpacesFromScope(
      "space:new.flock.workspace?authority=did:plc:fixture&skey=self&action=read",
    );
    assert.deepEqual(
      appSpaceTypes.get("new.flock.workspace")?.collections,
      ["new.flock.directory", "new.flock.app.install", "new.flock.ext.install", "com.atproto.label.record"],
      "the pinned OAuth provider resolves the app's published workspace space declaration",
    );
    const appInboxTypes = await fixtureLexiconManager.getSpacesFromScope(
      "space:new.flock.app.inbox?authority=did:plc:fixture&skey=inbox&action=read",
    );
    assert.deepEqual(
      appInboxTypes.get("new.flock.app.inbox")?.collections,
      ["new.flock.app.command", "new.flock.app.action", "com.atproto.label.record"],
      "the pinned OAuth provider resolves the app's published app-inbox space declaration",
    );

    const [
      { createWorkspace },
      { executeOperatorOperation, resumePendingWorkspaceCreations },
      { parseWorkspaceRef },
      { restoreAuthorityGrant },
      { mintSpaceCredential },
      { sessionClient },
      { createEngine },
      { listIndependentWorkspaces, readIndependentChannelPage, readIndependentPrivateRoster },
      { validateSpaceRecord },
      { channelUri, inboxUri, reactionRecordKey, requestRecordKey, tidNow },
      { getRawDb },
      { ensureOpenSocialSpace, putAuthorityRecord, readSpaceRecords },
      { putMembershipRoles, readGroupGovernanceState },
    ] = await Promise.all([
      import("@flock/operator/operator/kinds/create-workspace"),
      import("@flock/operator/operator/operations"),
      import("@flock/operator/operator/actor"),
      import("@flock/operator/operator/authority-grant"),
      import("@flock/operator/atproto/space-credential"),
      import("@flock/operator/atproto/client"),
      import("@flock/client/engine"),
      import("@flock/reader/independent"),
      import("@flock/protocol/registry"),
      import("@flock/protocol/keys"),
      import("@flock/operator/lib/db"),
      import("@flock/operator/atproto/space-ops"),
      import("@flock/operator/operator/workspace-state"),
    ]);

    const owner = await pds.createActor("alice", 0);
    const member = await pds.createActor("bob", 1);
    const admin = await pds.createActor("carol", 1);
    const outsider = await pds.createActor("dan", 1);
    const ownerSession = bearerSession(owner);
    const memberSession = bearerSession(member);
    const adminSession = bearerSession(admin);
    const outsiderSession = bearerSession(outsider);

    let memberClockOffsetMs = 0;
    const memberEngine = createEngine(actorTransport(pds, member, { now: () => Date.now() + memberClockOffsetMs }));
    const adminEngine = createEngine(actorTransport(pds, admin), {
      operator: { serviceRef, endpoint: await inProcessOperator() },
    });
    const independentDeps = (actor: NetworkActor) => actorTransport(pds, actor);

    const pilotGroup = await createOpenSocialGroup(pds, owner, {
      name: "Pilot Workspace",
      keyLabel: "pilot-grant-dpop",
    });
    const pilotSession = await restoreAuthorityGrant(pilotGroup.groupDid);
    const bootstrap = await createWorkspace(pilotSession, {
      creator: owner.did,
      name: "Pilot Workspace",
      operationId: tidNow(),
    });
    assert.equal(bootstrap.state, "completed");
    const bootstrapJournal = getRawDb()
      .prepare("SELECT workspace,request_json FROM operation WHERE workspace=? AND operation_id=?")
      .get(pilotGroup.groupDid, bootstrap.operationId) as { workspace: string; request_json: string };
    assert.equal(bootstrapJournal.workspace, pilotGroup.groupDid, "creation journal rows use the group authority key shared by operator recovery");
    assert.deepEqual(JSON.parse(bootstrapJournal.request_json), {
      workspace: bootstrap.workspace,
      request: { kind: "createWorkspace", name: "Pilot Workspace", creator: owner.did },
    });
    getRawDb()
      .prepare("INSERT OR REPLACE INTO notification_registration (service_ref,space_uri,expires_at,token,renew_at) VALUES (?,?,?,?,?)")
      .run(serviceRef, bootstrap.workspace, Date.now() + 2 * 60 * 60 * 1000, "seed-workspace-token", Date.now() + 60 * 60 * 1000);
    const workspace = parseWorkspaceRef(bootstrap.workspace);
    const operatorActor = { did: owner.did, session: pilotSession, workspace, canRecoverOperations: true };

    // Outage outlasts transient retries on a fresh OpenSocial group, leaving creation pending until recovered by next admin op.
    const retryGroup = await createOpenSocialGroup(pds, owner, {
      name: "Retry Workspace",
      keyLabel: "retry-grant-dpop",
    });
    const retrySession = await restoreAuthorityGrant(retryGroup.groupDid);
    let rejectBootstrapSpaceCreate = true;
    const flakyBootstrapSession = {
      did: retrySession.did,
      fetchHandler: async (path: string, init: RequestInit) => {
        if (rejectBootstrapSpaceCreate && path.includes("com.atproto.space.createSpace")) {
          return new Response(JSON.stringify({ error: "ServiceUnavailable", message: "injected bootstrap outage" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
        return retrySession.fetchHandler(path, init);
      },
    };
    const pendingBootstrap = await createWorkspace(flakyBootstrapSession as never, {
      creator: owner.did,
      name: "Retry Workspace",
      operationId: tidNow(),
    });
    rejectBootstrapSpaceCreate = false;
    assert.equal(pendingBootstrap.state, "pending");
    const retryActor = {
      did: owner.did,
      session: retrySession,
      workspace: parseWorkspaceRef(pendingBootstrap.workspace),
      canRecoverOperations: true,
    };
    const recoveredBootstrapOperation = await executeOperatorOperation(retryActor, tidNow(), {
      kind: "inviteMember",
      subject: member.did,
    });
    assert.equal(recoveredBootstrapOperation.state, "completed", "operator recovery resumes a visible pending bootstrap before changing membership");
    const recoveredBootstrapRow = getRawDb()
      .prepare("SELECT state FROM operation WHERE workspace=? AND actor=? AND operation_id=?")
      .get(retryGroup.groupDid, owner.did, pendingBootstrap.operationId) as { state: string };
    assert.equal(recoveredBootstrapRow.state, "completed");

    // Scheduled / pre-workspace recovery via `resumePendingWorkspaceCreations`.
    const schedGroup = await createOpenSocialGroup(pds, owner, {
      name: "Scheduled Retry Workspace",
      keyLabel: "sched-grant-dpop",
    });
    const schedSession = await restoreAuthorityGrant(schedGroup.groupDid);
    let rejectScheduledBootstrap = true;
    const schedulerFlakySession = {
      did: schedSession.did,
      fetchHandler: async (path: string, init: RequestInit) => {
        if (rejectScheduledBootstrap && path.includes("com.atproto.space.createSpace")) {
          return new Response(JSON.stringify({ error: "ServiceUnavailable", message: "injected pre-workspace bootstrap outage" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
        return schedSession.fetchHandler(path, init);
      },
    };
    const pendingScheduledBootstrap = await createWorkspace(schedulerFlakySession as never, {
      creator: owner.did,
      name: "Scheduled Retry Workspace",
      operationId: tidNow(),
    });
    rejectScheduledBootstrap = false;
    assert.equal(pendingScheduledBootstrap.state, "pending");
    assert.deepEqual(pendingScheduledBootstrap.completedSteps, [], "the failure is before workspace space creation");
    const scheduledBootstrapRecovery = await resumePendingWorkspaceCreations(schedSession, pendingScheduledBootstrap.workspace);
    assert.equal(scheduledBootstrapRecovery.length, 1);
    assert.equal(scheduledBootstrapRecovery[0]?.state, "completed", "the group grant resumes bootstrap cleanly");

    const memberInvite = await executeOperatorOperation(operatorActor, tidNow(), { kind: "inviteMember", subject: member.did });
    assert.equal(memberInvite.state, "completed");
    const adminInvite = await executeOperatorOperation(operatorActor, tidNow(), { kind: "inviteMember", subject: admin.did });
    assert.equal(adminInvite.state, "completed");
    const promotion = await executeOperatorOperation(operatorActor, tidNow(), { kind: "setAdmin", subject: admin.did, active: true });
    assert.equal(promotion.state, "completed");
    const publicChannel = await executeOperatorOperation(operatorActor, tidNow(), {
      kind: "createChannel",
      skey: "team-lobby",
      name: "team-lobby",
      visibility: "public",
    });
    assert.equal(publicChannel.state, "completed");
    const privateChannel = await executeOperatorOperation(operatorActor, tidNow(), {
      kind: "createChannel",
      skey: "team-private",
      name: "team-private",
      visibility: "private",
      members: [admin.did],
    });
    assert.equal(privateChannel.state, "completed");

    await acceptGroupMembership(pds, member, pilotGroup.groupDid);
    await acceptGroupMembership(pds, admin, pilotGroup.groupDid);

    const { workspaces: discovered } = await memberEngine.workspaces.discover();
    const independent = await listIndependentWorkspaces(independentDeps(member));
    assert.deepEqual(
      independent,
      discovered.map(({ uri, authorityDid, groupDid, name, joinPolicy, publicMeta, members, pendingMembers, rosterComplete, admins, moderators, channels, degradedReasons }) => ({
        uri,
        authorityDid,
        groupDid,
        name,
        joinPolicy,
        publicMeta,
        members: members.map(({ did }) => did),
        pendingMembers: pendingMembers.map(({ did }) => did),
        rosterComplete,
        admins,
        moderators,
        channels,
        degradedReasons,
      })),
    );
    assert.equal(discovered[0]?.name, "Pilot Workspace");
    assert.deepEqual(discovered[0]?.members.map(({ did }) => did).sort(), [owner.did, member.did, admin.did].sort());
    assert.deepEqual(discovered[0]?.admins.slice().sort(), [owner.did, admin.did].sort());
    assert.ok(discovered[0]?.channels.some((channel) => channel.skey === "team-lobby"));

    let failWorkspaceCredential = true;
    const temporarilyUnavailableEngine = createEngine(actorTransport(pds, member, {
      fetchVia: async (request) => {
        if (failWorkspaceCredential && request.url.includes("/xrpc/com.atproto.space.getDelegationToken?")) {
          failWorkspaceCredential = false;
          return new Response(JSON.stringify({ error: "ServiceUnavailable", message: "injected workspace discovery outage" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
        return fetch(request);
      },
    }));
    await assert.rejects(
      temporarilyUnavailableEngine.workspaces.discover(),
      (error: unknown) => Boolean(error && typeof error === "object" && "status" in error && error.status === 503),
      "a transient workspace summary failure must surface instead of returning an incomplete successful list",
    );

    // Non-authority spoof attempt of `group.opensocial.membership` is rejected by delegation scope / validation and never elevates admins.
    const membersSpace = groupMembersUri(pilotGroup.groupDid);
    const spoofedMembership = {
      $type: OPENSOCIAL_COLLECTION.membership,
      roles: ["member", "admin"],
      createdAt: new Date().toISOString(),
    };
    await writeRecord(sessionClient(memberSession as never), membersSpace, member.did, OPENSOCIAL_COLLECTION.membership, member.did, spoofedMembership)
      .catch(() => null);
    assert.equal(
      validateSpaceRecord(OPENSOCIAL_COLLECTION.membership, spoofedMembership, {
        authorityDid: pilotGroup.groupDid,
        spaceUri: membersSpace,
        repoDid: member.did,
        rkey: member.did,
      }).valid,
      false,
    );
    assert.deepEqual((await listIndependentWorkspaces(independentDeps(member)))[0]?.admins.slice().sort(), [owner.did, admin.did].sort());
    assert.deepEqual((await memberEngine.workspaces.discover()).workspaces[0]?.admins.slice().sort(), [owner.did, admin.did].sort());

    const lobbySkey = "team-lobby";
    const messageSpace = channelUri(pilotGroup.groupDid, lobbySkey);
    getRawDb()
      .prepare("INSERT OR REPLACE INTO notification_registration (service_ref,space_uri,expires_at,token,renew_at) VALUES (?,?,?,?,?)")
      .run(serviceRef, messageSpace, Date.now() + 2 * 60 * 60 * 1000, "seed-lobby-token", Date.now() + 60 * 60 * 1000);
    const oldMessageBase = Date.now() - 1000;
    for (let index = 0; index < 101; index += 1) {
      await writeRecord(sessionClient(memberSession as never), messageSpace, member.did, "new.flock.channel.message", tidNow(oldMessageBase + index), {
        $type: "new.flock.channel.message",
        text: `second PDS message ${index}`,
        createdAt: new Date().toISOString(),
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
    await writeRecord(sessionClient(adminSession as never), messageSpace, admin.did, "new.flock.channel.message", tidNow(), {
      $type: "new.flock.channel.message",
      text: "admin host message",
      createdAt: new Date().toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const latestMessageMs = Date.now();
    const latestMessageRkey = tidNow(latestMessageMs);
    const latestMessageValue = {
      $type: "new.flock.channel.message",
      text: "latest second PDS message",
      createdAt: new Date().toISOString(),
    };
    const latestMessage = await writeRecord(sessionClient(memberSession as never), messageSpace, member.did, "new.flock.channel.message", latestMessageRkey, latestMessageValue);
    const latestMessageUri = latestMessage.uri;
    assert.equal(latestMessageUri, `${messageSpace}/${member.did}/new.flock.channel.message/${latestMessageRkey}`);
    const listedMessages = await readSpaceRecords(memberSession as never, messageSpace, member.did, "new.flock.channel.message", 100);
    assert.equal(
      listedMessages.find((record) => record.rkey === latestMessageRkey)?.uri,
      latestMessageUri,
      "the listRecords helper constructs a canonical URI",
    );
    const interopReplyRkey = tidNow(latestMessageMs - 100);
    await writeRecord(sessionClient(memberSession as never), messageSpace, member.did, "new.flock.channel.message", interopReplyRkey, {
      $type: "new.flock.channel.message",
      text: "reply to PDS returned URI",
      createdAt: new Date().toISOString(),
      parent: latestMessageUri,
    });
    const latestReaction = await writeRecord(
      sessionClient(memberSession as never),
      messageSpace,
      member.did,
      "new.flock.channel.reaction",
      reactionRecordKey(latestMessageUri, "💜", member.did),
      {
        $type: "new.flock.channel.reaction",
        subject: latestMessageUri,
        emoji: "💜",
        createdAt: new Date().toISOString(),
      },
    );
    assert.equal(latestReaction.uri, `${messageSpace}/${member.did}/new.flock.channel.reaction/${reactionRecordKey(latestMessageUri, "💜", member.did)}`);

    await waitForWritersAtGroupHost(memberSession, messageSpace, pds.groupHostUrl, [member.did, admin.did]);

    const lobby = { workspace: bootstrap.workspace, skey: lobbySkey };
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

    // Deactivated writer isolation: one writer whose personal PDS account is deactivated must not make the channel unreadable.
    const accountCall = (method: string, jwt: string, body?: string) =>
      fetch(new URL(`/xrpc/${method}`, admin.pds.url), {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}`, ...(body ? { "content-type": "application/json" } : {}) },
        body,
      });
    assert.equal((await accountCall("com.atproto.server.deactivateAccount", admin.accessJwt, "{}")).status, 200, "the admin's host deactivates the account");
    let activated: Response | undefined;
    try {
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
      activated = await accountCall("com.atproto.server.activateAccount", admin.accessJwt);
      if (!activated.ok) {
        admin.accessJwt = (
          await admin.pds.getAgent().com.atproto.server.createSession({ identifier: admin.handle, password: admin.password })
        ).data.accessJwt;
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

    // `#spaceDeleted` webhook (`D12.3.3`) on GroupHost.
    const [{ registerSpace }, { recordWriteNotification }] = await Promise.all([
      import("@flock/operator/operator/registrations"),
      import("@flock/operator/operator/notices"),
    ]);
    const operatorOrigin = await inProcessOperator();
    const doomedSpace = await ensureOpenSocialSpace(pilotSession, SPACE_TYPE.channel, "doomed-by-notice", {
      $type: OPENSOCIAL_POLICY,
      publicRead: false,
      unlisted: true,
      grants: [],
    });
    assert.equal(
      await registerSpace(pilotSession, bootstrap.workspace, doomedSpace),
      true,
      "GroupHost confirms and registers doomedSpace with the in-process operator",
    );
    recordWriteNotification({ space: doomedSpace, repo: owner.did, repoRev: tidNow() });
    const registrations = () =>
      (getRawDb().prepare("SELECT count(*) AS count FROM notification_registration WHERE space_uri=?").get(doomedSpace) as { count: number }).count;
    const notices = () =>
      (getRawDb().prepare("SELECT count(*) AS count FROM space_notification WHERE space_uri=?").get(doomedSpace) as { count: number }).count;
    const storedToken = (
      getRawDb()
        .prepare("SELECT token FROM notification_registration WHERE service_ref=? AND space_uri=?")
        .get(serviceRef, doomedSpace) as { token: string }
    ).token;
    assert.ok(storedToken.length > 0);
    assert.equal(registrations(), 1);
    const initialNotices = notices();
    assert.ok(initialNotices >= 1);

    const sendSpaceDeletedNotice = (token: string | undefined, space: string) =>
      fetch(new URL("/xrpc/com.atproto.space.notifySpaceUpdate", operatorOrigin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          space,
          ...(token !== undefined ? { token } : {}),
          update: { $type: "com.atproto.space.notifySpaceUpdate#spaceDeleted" },
        }),
      });
    assert.equal((await sendSpaceDeletedNotice(undefined, doomedSpace)).status, 400, "missing webhook token");
    assert.equal((await sendSpaceDeletedNotice("wrong-webhook-token", doomedSpace)).status, 400, "mismatched webhook token");
    assert.equal((await sendSpaceDeletedNotice(storedToken, channelUri(pilotGroup.groupDid, "never-registered"))).status, 400, "a space the app never registered");
    assert.equal(registrations(), 1, "nothing was dropped by a refused notice");
    assert.equal(notices(), initialNotices);

    // Spoofed/premature `#spaceDeleted` with the real token while the space still exists at GroupHost must NOT purge!
    assert.equal((await sendSpaceDeletedNotice(storedToken, doomedSpace)).status, 200, "valid webhook token answered 200");
    assert.equal(registrations(), 1, "#spaceDeleted refuses to purge when authority authorizeSpaceSync does not confirm SpaceDeleted");
    assert.equal(notices(), initialNotices, "space notifications remain intact while space is still live");

    // Real `deleteSpace` at GroupHost triggers `#spaceDeleted`, which `authorizeSpaceSync` now confirms as `SpaceDeleted`.
    await sessionClient(pilotSession).procedure("com.atproto.space.deleteSpace", { space: doomedSpace });
    for (let attempt = 0; attempt < 40 && registrations() > 0; attempt += 1) {
      if (attempt === 10 && registrations() > 0) {
        await sendSpaceDeletedNotice(storedToken, doomedSpace);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(registrations(), 0, "the confirmed deleted space's notify registration is purged");
    assert.equal(notices(), 0, "the confirmed deleted space's notices are purged");

    // Private-channel join requests in `new.flock.inbox/self` + `decideJoinRequest` via GroupHost `listWriters`.
    const inbox = inboxUri(pilotGroup.groupDid, workspace.skey);
    const privateSkey = "team-private";
    const privateSpace = channelUri(pilotGroup.groupDid, privateSkey);
    const memberRequestKey = requestRecordKey(privateSpace, member.did);
    const memberRequestId = tidNow();
    const memberRequestUri = (
      await writeRecord(sessionClient(memberSession as never), inbox, member.did, "new.flock.joinRequest", memberRequestKey, {
        $type: "new.flock.joinRequest",
        channelSkey: privateSkey,
        requestId: memberRequestId,
        createdAt: new Date().toISOString(),
      })
    ).uri;
    assert.equal(memberRequestUri, `${inbox}/${member.did}/new.flock.joinRequest/${memberRequestKey}`);
    await assert.rejects(mintSpaceCredential(memberSession as never, privateSpace), (error: unknown) => isAccessLost(error));
    await assert.rejects(mintSpaceCredential(memberSession as never, inbox), (error: unknown) => isAccessLost(error));
    await assert.rejects(mintSpaceCredential(outsiderSession as never, inbox), (error: unknown) => isAccessLost(error));

    await waitForWritersAtGroupHost(adminSession, inbox, pds.groupHostUrl, [member.did]);
    const adminInbox = await mintSpaceCredential(adminSession as never, inbox);
    const adminOperator = adminEngine.operator;
    assert.ok(adminOperator, "the admin's engine reaches the operator");
    const inboxRequests = () => adminEngine.workspaces.inboxRequests(bootstrap.workspace, adminOperator);
    assert.deepEqual(
      (await inboxRequests()).requests.map(({ uri, requestId, channelSkey, channelName }) => ({
        uri,
        requestId,
        channelSkey,
        channelName,
      })),
      [{ uri: memberRequestUri, requestId: memberRequestId, channelSkey: privateSkey, channelName: "team-private" }],
      "the admin's engine lists the member's request from GroupHost listWriters",
    );
    const requestPage = await adminInbox
      .client(pds.hosts[1].url)
      .query<{ records: Array<{ value?: { requestId?: string } }> }>("com.atproto.space.listRecords", {
        space: inbox,
        repo: member.did,
        collection: "new.flock.joinRequest",
      });
    assert.equal(requestPage.records.length, 1);

    const denial = await executeOperatorOperation(operatorActor, tidNow(), {
      kind: "decideJoinRequest",
      request: memberRequestUri,
      requestId: memberRequestId,
      decision: "deny",
    });
    assert.equal(denial.state, "completed");
    await assert.rejects(mintSpaceCredential(memberSession as never, privateSpace), (error: unknown) => isAccessLost(error));
    const denialRecord = await adminInbox
      .client(pds.groupHostUrl)
      .query<{ records: Array<{ value?: { requestId?: string; decision?: string } }> }>("com.atproto.space.listRecords", {
        space: inbox,
        repo: pilotGroup.groupDid,
        collection: "new.flock.joinDecision",
      });
    const matchedDenial = denialRecord.records.find((r) => r.value?.requestId === memberRequestId);
    assert.equal(matchedDenial?.value?.decision, "deny");
    assert.deepEqual((await inboxRequests()).requests, [], "a request with a current decision is not offered again");

    const replacementRequestId = tidNow();
    await writeRecord(sessionClient(memberSession as never), inbox, member.did, "new.flock.joinRequest", memberRequestKey, {
      $type: "new.flock.joinRequest",
      channelSkey: privateSkey,
      requestId: replacementRequestId,
      createdAt: new Date().toISOString(),
    });
    await waitForWritersAtGroupHost(adminSession, inbox, pds.groupHostUrl, [member.did]);
    assert.deepEqual((await inboxRequests()).requests.map(({ requestId }) => requestId), [replacementRequestId], "a resubmitted request is open again");
    const staleApproval = await executeOperatorOperation(operatorActor, tidNow(), {
      kind: "decideJoinRequest",
      request: memberRequestUri,
      requestId: memberRequestId,
      decision: "approve",
    });
    assert.equal(staleApproval.state, "failed");
    assert.match(staleApproval.error ?? "", /generation is no longer current/i);
    await assert.rejects(mintSpaceCredential(memberSession as never, privateSpace), (error: unknown) => isAccessLost(error));

    const approval = await executeOperatorOperation(operatorActor, tidNow(), {
      kind: "decideJoinRequest",
      request: memberRequestUri,
      requestId: replacementRequestId,
      decision: "approve",
    });
    assert.equal(approval.state, "completed");
    const privateMessage = tidNow();
    await writeRecord(sessionClient(memberSession as never), privateSpace, member.did, "new.flock.channel.message", privateMessage, {
      $type: "new.flock.channel.message",
      text: "approved private message",
      createdAt: new Date().toISOString(),
    });
    await waitForWritersAtGroupHost(memberSession, privateSpace, pds.groupHostUrl, [member.did]);
    const privateRef = { workspace: bootstrap.workspace, skey: privateSkey };
    assert.deepEqual(
      (await readIndependentPrivateRoster(independentDeps(member), bootstrap.workspace, privateSkey)).slice().sort(),
      [admin.did, member.did].sort(),
    );
    assert.deepEqual(
      (await memberEngine.channels.roster(privateRef)).slice().sort(),
      [admin.did, member.did].sort(),
      "the engine's private channel roster matches the independent reader's",
    );
    assert.equal((await readIndependentChannelPage(independentDeps(member), bootstrap.workspace, privateSkey)).messages[0]?.value.text, "approved private message");
    assert.equal((await memberEngine.channels.readPage(privateRef)).messages[0]?.value.text, "approved private message", "the engine reads the private channel the approval opened");

    // Removing the private-channel role blocks fresh writes immediately; restoring it restores access.
    await putMembershipRoles(pilotSession, pilotGroup.groupDid, member.did, ["member"]);
    await assert.rejects(
      memberEngine.channels.send(privateRef, "after removal"),
      (error: unknown) => isAccessLost(error),
      "a removed private-channel member cannot pass the engine's fresh credential gate for writes",
    );
    await putMembershipRoles(pilotSession, pilotGroup.groupDid, member.did, ["member", channelRoleKey(privateSkey)]);

    const preRemovalCredential = await mintSpaceCredential(memberSession as never, bootstrap.workspace);
    assert.ok(preRemovalCredential.expiresAt > Date.now());
    const issued = JSON.parse(Buffer.from(preRemovalCredential.token.split(".")[1]!, "base64url").toString("utf8")) as {
      iat: number;
      exp: number;
      jti: string;
      cnf: { kid: string };
    };
    assert.equal(issued.exp - issued.iat, SPACE_CREDENTIAL_LIFETIME_MS / 1000, "GroupHost issues credentials with the lifetime the app plans its renewals around");
    assert.ok(issued.exp - issued.iat <= 60 * 60, "and never above the one hour protocol ceiling");
    assert.equal(issued.cnf.kid, preRemovalCredential.key.did(), "the credential is bound to the key that signs its requests");
    assert.ok(issued.jti.length > 0);

    assert.ok((await memberEngine.sync.store.records(messageSpace, "new.flock.channel.message")).length > 0, "the member's engine holds a copy of the channel it read");

    // Seed an unfinished `removeMember` operation after `remove-workspace-membership` commits, then resume from SQLite backup in a fresh Node process.
    const failedOperationId = tidNow();
    let sawMembershipDelete = false;
    let injectedAttempts = 0;
    const failingSession = {
      did: pilotSession.did,
      fetchHandler: async (path: string, init: RequestInit) => {
        if (path.includes("com.atproto.space.deleteRecord")) {
          const response = await pilotSession.fetchHandler(path, init);
          sawMembershipDelete = true;
          return response;
        }
        if (
          sawMembershipDelete &&
          injectedAttempts < 4 &&
          path.includes("com.atproto.space.listRecords") &&
          path.includes("collection=group.opensocial.membership")
        ) {
          injectedAttempts += 1;
          return new Response(JSON.stringify({ message: "injected crash window" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
        return pilotSession.fetchHandler(path, init);
      },
    };
    const failingActor = { ...operatorActor, session: failingSession as never };
    const firstAttempt = await executeOperatorOperation(failingActor, failedOperationId, { kind: "removeMember", subject: member.did });
    assert.equal(injectedAttempts, 4, "a persistently unavailable GroupHost is retried only within the configured bound");
    assert.equal(firstAttempt.state, "pending");
    assert.ok(firstAttempt.completedSteps.includes("remove-workspace-membership"));
    assert.equal(firstAttempt.completedSteps.includes("removal-verified"), false);

    // Verify encrypted Group-DID authority_grant storage, refresh, and authenticated HTTP createWorkspace on a separate OpenSocial group.
    const grant = await storeGroupAuthorityGrant(pds, owner, pilotGroup.groupDid, "backup-acceptance-dpop");
    const encryptedGrant = getRawDb()
      .prepare("SELECT value FROM authority_grant WHERE key = ?")
      .get(pilotGroup.groupDid) as { value: string } | undefined;
    assert.ok(encryptedGrant?.value.startsWith("v1."));
    assert.equal(encryptedGrant?.value.includes(grant.accessToken), false, "the authority grant's access token is encrypted in the live database");
    await expireStoredSession("authority_grant", pilotGroup.groupDid);
    const refreshedGrant = await restoreAuthorityGrant(pilotGroup.groupDid);
    assert.equal(refreshedGrant.did, pilotGroup.groupDid, "the expired Group-DID authority grant refreshes using the authority client");
    await acceptOperatorCreateWorkspace(pds, owner, ownerSession, serviceRef);
    await expireStoredSession("authority_grant", pilotGroup.groupDid);

    const backupPath = `${databasePath}.backup`;
    const restoredPath = `${databasePath}.restored`;
    const backup = spawn(process.execPath, ["scripts/backup-db.mjs", backupPath], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_PATH: databasePath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let backupStdout = "";
    let backupStderr = "";
    backup.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      backupStdout += chunk;
    });
    backup.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      backupStderr += chunk;
    });
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
      const operation = backupDb
        .prepare("SELECT state, steps_json FROM operation WHERE operation_id = ?")
        .get(failedOperationId) as { state: string; steps_json: string } | undefined;
      assert.equal(operation?.state, "pending", "the live backup contains the incomplete operator operation");
      assert.ok(JSON.parse(operation?.steps_json ?? "[]").includes("remove-workspace-membership"));
      await backupDb.backup(restoredPath);
    } finally {
      backupDb.close();
    }
    const restoredDb = new BetterSqlite3(restoredPath, { readonly: true, fileMustExist: true });
    try {
      assert.equal(restoredDb.pragma("integrity_check", { simple: true }), "ok");
      const tables = (restoredDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        ({ name }) => name,
      );
      for (const removed of (await import("@flock/operator/lib/db")).MEMBER_SESSION_TABLES) {
        assert.ok(!tables.includes(removed), `the server database holds no member session, cursor or channel content: ${removed} is gone`);
      }
    } finally {
      restoredDb.close();
    }

    const resumed = await runRestartRecovery({
      databasePath: restoredPath,
      authorityDid: pilotGroup.groupDid,
      actorDid: owner.did,
      workspace: bootstrap.workspace,
      memberDid: member.did,
      operationId: failedOperationId,
      useStoredAuthorityGrant: true,
    });
    assert.equal(resumed.state, "completed");
    assert.equal(resumed.reconciliationState, "completed", "GroupHost reconciliation completes after backup restoration");

    const restoredStateDb = new BetterSqlite3(restoredPath);
    try {
      const journalBeforePausedCheck = restoredStateDb
        .prepare("SELECT workspace, actor, operation_id, state, steps_json, updated_at FROM operation ORDER BY workspace, actor, operation_id")
        .all();
      const pausedCheck = await runReconciliation(restoredPath, pilotGroup.groupDid, owner.did, bootstrap.workspace, true);
      assert.equal(pausedCheck.exitCode, 0, pausedCheck.stderr);
      assert.match(pausedCheck.stdout, /authority session verified; mutations paused/);
      assert.deepEqual(
        restoredStateDb
          .prepare("SELECT workspace, actor, operation_id, state, steps_json, updated_at FROM operation ORDER BY workspace, actor, operation_id")
          .all(),
        journalBeforePausedCheck,
        "a successful paused admin check does not modify operation journals",
      );
      const activeReconciliation = await runReconciliation(restoredPath, pilotGroup.groupDid, owner.did, bootstrap.workspace, false);
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
    await assert.rejects(
      preRemovalCredential.client(pds.groupHostUrl).query("com.atproto.space.listRecords", {
        space: bootstrap.workspace,
        repo: pilotGroup.groupDid,
        collection: COLLECTION.directory,
      }),
      (error: unknown) => Boolean(error && typeof error === "object" && "status" in error && error.status === 401),
      "GroupHost immediately revokes a removed member's previously issued space credential",
    );

    await storeGroupAuthorityGrant(pds, owner, pilotGroup.groupDid, "phase5-matrix-grant-dpop");
    const refreshedPilotSession = await restoreAuthorityGrant(pilotGroup.groupDid);
    const liveOperatorActor = { did: owner.did, session: refreshedPilotSession, workspace, canRecoverOperations: true };
    await runPhase5FailureMatrix({
      pds,
      groupSession: refreshedPilotSession,
      memberSession,
      operatorActor: liveOperatorActor,
      memberActor: { ...liveOperatorActor, did: member.did, canRecoverOperations: false },
      groupDid: pilotGroup.groupDid,
      ownerDid: owner.did,
      workspace: bootstrap.workspace,
      memberDid: member.did,
      adminDid: admin.did,
      outsiderDid: outsider.did,
      publicSkey: lobbySkey,
      privateSkey,
      databasePath,
      putAuthorityRecord,
      readGroupGovernanceState,
    });

    // Revoking the group's OAuth session at GroupHost causes reconciliation to fail cleanly without mutating the journal while paused.
    const revokedCheckDb = new BetterSqlite3(restoredPath);
    const journalBeforeRevokedCheck = revokedCheckDb
      .prepare("SELECT workspace, actor, operation_id, state, steps_json, updated_at FROM operation ORDER BY workspace, actor, operation_id")
      .all();
    pds.groupHost.db
      .prepare("DELETE FROM oauth_refresh_token WHERE session_id IN (SELECT session_id FROM oauth_session WHERE group_did = ?)")
      .run(pilotGroup.groupDid);
    pds.groupHost.db.prepare("DELETE FROM oauth_session WHERE group_did = ?").run(pilotGroup.groupDid);
    const revokedSessionCheck = await runReconciliation(restoredPath, pilotGroup.groupDid, owner.did, bootstrap.workspace, true);
    assert.equal(revokedSessionCheck.exitCode, 1, "reconciliation reports a revoked Group-DID authority grant");
    assert.match(revokedSessionCheck.stderr, /reconciliation failed/);
    assert.deepEqual(
      revokedCheckDb
        .prepare("SELECT workspace, actor, operation_id, state, steps_json, updated_at FROM operation ORDER BY workspace, actor, operation_id")
        .all(),
      journalBeforeRevokedCheck,
      "a revoked session cannot mutate the journal while reconciliation is paused",
    );
    revokedCheckDb.close();
  } finally {
    await pds.close();
  }
});

type LifecycleSession = {
  did: string;
  fetchHandler(path: string, init: RequestInit): Promise<Response>;
};

type LifecycleMatrixActor = {
  did: string;
  session: LifecycleSession;
  workspace: { authorityDid: string; uri: string; skey: string };
  canRecoverOperations: boolean;
};

async function runPhase5FailureMatrix(input: {
  pds: PdsNetwork;
  groupSession: LifecycleSession;
  memberSession: BearerSession;
  operatorActor: LifecycleMatrixActor;
  memberActor: LifecycleMatrixActor;
  groupDid: string;
  ownerDid: string;
  workspace: string;
  memberDid: string;
  adminDid: string;
  outsiderDid: string;
  publicSkey: string;
  privateSkey: string;
  databasePath: string;
  putAuthorityRecord: typeof import("@flock/operator/atproto/space-ops").putAuthorityRecord;
  readGroupGovernanceState: typeof import("@flock/operator/operator/workspace-state").readGroupGovernanceState;
}): Promise<void> {
  const [
    { executeOperatorOperation },
    { ensureOpenSocialSpace, getOpenSocialSpacePolicy, updateOpenSocialSpacePolicy },
    { deleteMembershipRecord, liveSpaceAccess, putMembershipRoles },
    { archivedChannelPolicy, defaultPrivateChannelPolicy, defaultPublicChannelPolicy },
    { sessionClient },
    { channelUri, decisionRecordKey, inboxUri, requestRecordKey, spaceRecordUri, tidNow },
    { mintSpaceCredential },
    { resolvePds },
  ] = await Promise.all([
    import("@flock/operator/operator/operations"),
    import("@flock/operator/atproto/space-ops"),
    import("@flock/operator/operator/workspace-state"),
    import("@flock/operator/operator/workspace-spaces"),
    import("@flock/operator/atproto/client"),
    import("@flock/protocol/keys"),
    import("@flock/operator/atproto/space-credential"),
    import("@flock/operator/atproto/identity"),
  ]);

  const owner = input.operatorActor;
  const memberActor = input.memberActor;
  const workspace = input.workspace;
  const groupDid = input.groupDid;
  const membersSpace = groupMembersUri(groupDid);
  const inbox = inboxUri(groupDid, "self");
  const publicSpace = channelUri(groupDid, input.publicSkey);
  const privateSpace = channelUri(groupDid, input.privateSkey);

  const writeAuthority = (space: string, collection: string, rkey: string, value: Record<string, unknown>) =>
    input.putAuthorityRecord(input.groupSession as never, space, collection, rkey, value);
  const record = async (space: string, collection: string, rkey: string) => {
    const result = await sessionClient(input.groupSession as never)
      .query<{ value?: Record<string, unknown> }>("com.atproto.space.getRecord", {
        space,
        repo: groupDid,
        collection,
        rkey,
      })
      .catch(() => ({ value: undefined }));
    return result.value;
  };
  const access = async (space: string, did: string) => {
    const gov = await input.readGroupGovernanceState(input.groupSession as never, groupDid);
    return liveSpaceAccess(gov, groupDid, space, did);
  };

  const seedMember = async (did: string, activeAdmin: boolean, extraRoles: readonly string[] = [channelRoleKey(input.privateSkey)]) => {
    const roles = [...new Set(["member", ...(activeAdmin ? ["admin"] : []), ...extraRoles])];
    await putMembershipRoles(input.groupSession as never, groupDid, did, roles);
  };
  const resetMember = async (did: string) => {
    await deleteMembershipRecord(input.groupSession as never, groupDid, did);
  };
  const seedChannel = async (
    skey: string,
    visibility: "public" | "private" | "transitioning" | "archived",
    memberDids: readonly string[],
  ) => {
    const space = channelUri(groupDid, skey);
    const privRole = channelRoleKey(skey);
    await writeAuthority(membersSpace, OPENSOCIAL_COLLECTION.role, privRole, {
      displayName: `#${skey} member`,
    });
    const policy =
      visibility === "public"
        ? defaultPublicChannelPolicy()
        : visibility === "archived"
          ? archivedChannelPolicy()
          : defaultPrivateChannelPolicy(privRole);
    await ensureOpenSocialSpace(input.groupSession as never, SPACE_TYPE.channel, skey, policy);
    await updateOpenSocialSpacePolicy(input.groupSession as never, space, policy);
    await writeAuthority(workspace, COLLECTION.directory, skey, {
      skey,
      name: `Failure ${skey}`,
      visibility,
    });
    const gov = await input.readGroupGovernanceState(input.groupSession as never, groupDid);
    for (const [did, mem] of gov.memberships.entries()) {
      if (did === groupDid) continue;
      const shouldHave = memberDids.includes(did);
      const hasRole = mem.roles.includes(privRole);
      if (shouldHave && !hasRole) {
        await putMembershipRoles(input.groupSession as never, groupDid, did, [...mem.roles, privRole]);
      } else if (!shouldHave && hasRole) {
        const remaining = mem.roles.filter((r) => r !== privRole);
        await putMembershipRoles(input.groupSession as never, groupDid, did, remaining.length > 0 ? remaining : ["member"]);
      }
    }
  };

  const isRequest = (method: string, predicate: (body: Record<string, unknown>) => boolean) => (path: string, init: RequestInit) => {
    if (init.method !== "POST" || !path.startsWith(`/xrpc/${method}`) || typeof init.body !== "string") return false;
    try {
      return predicate(JSON.parse(init.body) as Record<string, unknown>);
    } catch {
      return false;
    }
  };
  const recordMutation = (
    space: string,
    collection: string,
    rkey: string,
    predicate: (value: Record<string, unknown>) => boolean = () => true,
  ) =>
    isRequest(
      "com.atproto.space.putRecord",
      (body) =>
        body.space === space &&
        body.collection === collection &&
        body.rkey === rkey &&
        typeof body.record === "object" &&
        body.record !== null &&
        predicate(body.record as Record<string, unknown>),
    );
  const recordDelete = (space: string, collection: string, rkey: string) =>
    isRequest(
      "com.atproto.space.deleteRecord",
      (body) => body.space === space && body.collection === collection && body.rkey === rkey,
    );
  const spaceUpdate = (space: string) =>
    isRequest("com.atproto.space.updateSpace", (body) => body.space === space);

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
    const faultySession: LifecycleSession = {
      did: originalSession.did,
      fetchHandler: async (path, init) => {
        if (injected < 4 && matcher(path, init)) {
          injected += 1;
          if (failBeforeCommit) {
            return new Response(JSON.stringify({ error: "ServiceUnavailable", message: `injected outage: ${label}` }), {
              status: 503,
              headers: { "content-type": "application/json" },
            });
          }
          const committed = await originalSession.fetchHandler(path, init);
          await committed.arrayBuffer();
          return new Response(JSON.stringify({ error: "ServiceUnavailable", message: `injected response loss: ${label}` }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
        return originalSession.fetchHandler(path, init);
      },
    };
    const operationId = tidNow();
    const pending = await executeOperatorOperation({ ...actor, session: faultySession as never }, operationId, request);
    assert.equal(
      injected,
      4,
      `${label}: expected four failures, got ${injected}; operation=${pending.state}; steps=${pending.completedSteps.join(",")}; error=${pending.error ?? "none"}`,
    );
    assert.equal(pending.state, "pending", `${label}: the journal remains pending after the bounded retries`);
    assert.ok(!pending.completedSteps.includes(expectedStep), `${label}: the uncertain step was not checkpointed`);
    await verifyPending?.();
    const resumed = await runRestartRecovery({
      databasePath: input.databasePath,
      authorityDid: groupDid,
      actorDid: input.ownerDid,
      workspace,
      memberDid: input.memberDid,
      operationId,
      resumeAll: true,
      useStoredAuthorityGrant: true,
    });
    assert.equal(resumed.resumedOperationState, "completed", `${label}: a fresh process resumes the operation`);
    assert.equal(resumed.reconciliationState, "completed", `${label}: membership reconciles after restart`);
    await verify?.();
  };

  // Resume the still-pending live journal row from the backup drill before lifecycle fault injection.
  const initialRecovery = await executeOperatorOperation(owner as never, tidNow(), { kind: "reconcileWorkspace" });
  assert.equal(initialRecovery.state, "completed", "the live acceptance journal is clean before lifecycle fault injection");

  // Restore `memberDid` after the earlier removal drill.
  await seedMember(input.memberDid, false);

  // 1. Invite membership (`member-workspace`):
  //    (a) Post-commit response loss converges on retry 2 without re-writing `putRecord` (preserving `new.flock.incarnation`).
  await resetMember(input.outsiderDid);
  let postCommitWrites = 0;
  const responseLossInvite = await executeOperatorOperation(
    {
      ...owner,
      session: {
        did: owner.session.did,
        fetchHandler: async (path: string, init: RequestInit) => {
          if (recordMutation(membersSpace, OPENSOCIAL_COLLECTION.membership, input.outsiderDid)(path, init)) {
            postCommitWrites += 1;
            const committed = await owner.session.fetchHandler(path, init);
            await committed.arrayBuffer();
            return new Response(JSON.stringify({ error: "ServiceUnavailable", message: "lost invite response" }), {
              status: 503,
              headers: { "content-type": "application/json" },
            });
          }
          return owner.session.fetchHandler(path, init);
        },
      } as never,
    },
    tidNow(),
    { kind: "inviteMember", subject: input.outsiderDid },
  );
  assert.equal(responseLossInvite.state, "completed");
  assert.equal(postCommitWrites, 1, "read-before-write retry preserves committed membership incarnation without a second putRecord");

  //    (b) Pre-commit outage retries 4 times, leaves journal pending, and recovers in a fresh process.
  await injectAndRestart(
    "invite workspace member",
    owner,
    { kind: "inviteMember", subject: input.outsiderDid },
    "member-workspace",
    recordMutation(membersSpace, OPENSOCIAL_COLLECTION.membership, input.outsiderDid),
    () => resetMember(input.outsiderDid),
    async () => {
      assert.deepEqual(await access(workspace, input.outsiderDid), { read: true, write: false });
      assert.deepEqual(await access(inbox, input.outsiderDid), { read: false, write: true });
      assert.deepEqual(await access(publicSpace, input.outsiderDid), { read: true, write: true });
    },
    true,
  );

  // 2. Removal (`remove-workspace-membership`).
  await injectAndRestart(
    "remove workspace membership",
    owner,
    { kind: "removeMember", subject: input.adminDid },
    "remove-workspace-membership",
    recordDelete(membersSpace, OPENSOCIAL_COLLECTION.membership, input.adminDid),
    () => seedMember(input.adminDid, true),
    async () => {
      assert.deepEqual(await access(workspace, input.adminDid), { read: false, write: false });
      assert.deepEqual(await access(inbox, input.adminDid), { read: false, write: false });
      assert.deepEqual(await access(publicSpace, input.adminDid), { read: false, write: false });
      assert.deepEqual(await access(privateSpace, input.adminDid), { read: false, write: false });
    },
    true,
  );

  // 3. Promotion and demotion (`write-admin-active` / `write-admin-inactive`).
  const adminTargets = [
    [
      "promote admin role",
      true,
      "write-admin-active",
      recordMutation(membersSpace, OPENSOCIAL_COLLECTION.membership, input.adminDid, (v) =>
        Array.isArray(v.roles) && v.roles.includes("admin"),
      ),
    ],
    [
      "demote admin role",
      false,
      "write-admin-inactive",
      recordMutation(membersSpace, OPENSOCIAL_COLLECTION.membership, input.adminDid, (v) =>
        Array.isArray(v.roles) && !v.roles.includes("admin"),
      ),
    ],
  ] as const;
  for (const [label, active, step, matcher] of adminTargets) {
    await injectAndRestart(
      label,
      owner,
      { kind: "setAdmin", subject: input.adminDid, active },
      step,
      matcher,
      () => seedMember(input.adminDid, !active),
      async () => {
        const gov = await input.readGroupGovernanceState(input.groupSession as never, groupDid);
        assert.equal(Boolean(gov.memberships.get(input.adminDid)?.roles.includes("admin")), active);
        assert.deepEqual(await access(inbox, input.adminDid), { read: active, write: true });
      },
      true,
    );
  }

  // 4. Last active human admin cannot be demoted, removed, or self-leave.
  await seedMember(input.adminDid, false);
  await putMembershipRoles(input.groupSession as never, groupDid, input.ownerDid, ["member", "admin"]);
  for (const [label, request] of [
    ["last-admin demotion", { kind: "setAdmin", subject: input.ownerDid, active: false }],
    ["last-admin removal", { kind: "removeMember", subject: input.ownerDid }],
    ["last-admin self-leave", { kind: "leaveWorkspace" }],
  ] as const) {
    const result = await executeOperatorOperation(owner as never, tidNow(), request);
    assert.equal(result.state, "failed", `${label} is rejected before any membership changes`);
    assert.match(result.error ?? "", /last active admin/i, label);
  }
  await seedMember(input.adminDid, true);

  // 5. Channel creation (`channel-space`, `channel-member-{did}`, `channel-directory`).
  await seedMember(input.outsiderDid, false, []);
  const createCases = [
    [
      "create channel space",
      "fault-create-space",
      "public",
      "channel-space",
      (skey: string) => isRequest("com.atproto.space.createSpace", (body) => body.skey === skey),
      true,
    ],
    [
      "add private channel member",
      "fault-create-private-member",
      "private",
      `channel-member-${input.outsiderDid}`,
      (skey: string) =>
        recordMutation(membersSpace, OPENSOCIAL_COLLECTION.membership, input.outsiderDid, (v) =>
          Array.isArray(v.roles) && v.roles.includes(channelRoleKey(skey)),
        ),
      true,
    ],
    [
      "publish channel directory",
      "fault-create-directory",
      "public",
      "channel-directory",
      (skey: string) => recordMutation(workspace, COLLECTION.directory, skey),
      false,
    ],
  ] as const;
  for (const [label, channelSkey, visibility, expectedStep, buildMatcher, failBeforeCommit] of createCases) {
    const request = {
      kind: "createChannel",
      skey: channelSkey,
      name: `Failure ${channelSkey}`,
      visibility,
      ...(visibility === "private" ? { members: [input.outsiderDid] } : {}),
    };
    await injectAndRestart(
      label,
      owner,
      request,
      expectedStep,
      buildMatcher(channelSkey),
      undefined,
      async () => {
        assert.equal((await record(workspace, COLLECTION.directory, channelSkey))?.visibility, visibility);
        assert.deepEqual(await access(channelUri(groupDid, channelSkey), input.outsiderDid), { read: true, write: true });
      },
      failBeforeCommit,
    );
  }

  // 6. Channel visibility transitions preserve history and converge roles & policy.
  const transitionSkey = "fault-transition";
  const transitionSpace = channelUri(groupDid, transitionSkey);
  const transitionMemberDid = input.outsiderDid;
  await seedChannel(transitionSkey, "public", [input.memberDid]);
  const transitionMessageRkey = tidNow();
  await writeRecord(sessionClient(input.memberSession as never), transitionSpace, input.memberDid, "new.flock.channel.message", transitionMessageRkey, {
    $type: "new.flock.channel.message",
    text: "preserved through visibility changes",
    createdAt: new Date().toISOString(),
  });
  const transitionCredential = await mintSpaceCredential(input.groupSession as never, transitionSpace);
  const memberPds = await resolvePds(input.memberDid);
  const transitionCases = [
    [
      "set channel transitioning",
      "public",
      [transitionMemberDid],
      "private",
      [transitionMemberDid],
      "channel-set-transitioning",
      recordMutation(workspace, COLLECTION.directory, transitionSkey, (value) => value.visibility === "transitioning"),
      false,
    ],
    [
      "remove deselected private channel member",
      "private",
      [transitionMemberDid, input.adminDid],
      "private",
      [transitionMemberDid],
      `channel-remove-${input.adminDid}`,
      recordMutation(membersSpace, OPENSOCIAL_COLLECTION.membership, input.adminDid, (v) =>
        Array.isArray(v.roles) && !v.roles.includes(channelRoleKey(transitionSkey)),
      ),
      true,
    ],
    [
      "add private channel member",
      "private",
      [],
      "private",
      [transitionMemberDid],
      `channel-private-add-${transitionMemberDid}`,
      recordMutation(membersSpace, OPENSOCIAL_COLLECTION.membership, transitionMemberDid, (v) =>
        Array.isArray(v.roles) && v.roles.includes(channelRoleKey(transitionSkey)),
      ),
      true,
    ],
    [
      "publish final channel visibility",
      "transitioning",
      [transitionMemberDid],
      "private",
      [transitionMemberDid],
      "channel-set-final-visibility",
      recordMutation(workspace, COLLECTION.directory, transitionSkey, (value) => value.visibility === "private"),
      false,
    ],
  ] as const;
  for (const [label, initialVisibility, initialMembers, targetVisibility, targetMembers, expectedStep, matcher, failBeforeCommit] of transitionCases) {
    const request = {
      kind: "transitionChannel",
      skey: transitionSkey,
      visibility: targetVisibility,
      ...(targetVisibility === "private" ? { members: targetMembers } : {}),
    };
    await injectAndRestart(
      label,
      owner,
      request,
      expectedStep,
      matcher,
      () => seedChannel(transitionSkey, initialVisibility, initialMembers),
      async () => {
        assert.equal((await record(workspace, COLLECTION.directory, transitionSkey))?.visibility, targetVisibility);
        const expectedAccess = targetMembers.includes(transitionMemberDid)
          ? { read: true, write: true }
          : { read: false, write: false };
        assert.deepEqual(await access(transitionSpace, transitionMemberDid), expectedAccess);
        const preserved = await transitionCredential
          .client(memberPds)
          .query<{ uri: string; value: Record<string, unknown> }>("com.atproto.space.getRecord", {
            space: transitionSpace,
            repo: input.memberDid,
            collection: "new.flock.channel.message",
            rkey: transitionMessageRkey,
          });
        assert.equal(preserved.uri, `${transitionSpace}/${input.memberDid}/new.flock.channel.message/${transitionMessageRkey}`);
        assert.equal(preserved.value.text, "preserved through visibility changes");
      },
      failBeforeCommit,
      async () =>
        assert.equal(
          (await record(workspace, COLLECTION.directory, transitionSkey))?.visibility,
          expectedStep === "channel-set-final-visibility" ? targetVisibility : "transitioning",
        ),
    );
  }

  // 7. Archive clears policy grants, strips private channel roles, deletes `role/channel-<skey>`, and retains history.
  const archiveCases = [
    [
      "mark channel transitioning for archive",
      "fault-archive-transition",
      "channel-archive-transition",
      (skey: string) => recordMutation(workspace, COLLECTION.directory, skey, (value) => value.visibility === "transitioning"),
      false,
    ],
    [
      "remove channel role for archive",
      "fault-archive-remove",
      `channel-archive-remove-${input.memberDid}`,
      (skey: string) =>
        recordMutation(membersSpace, OPENSOCIAL_COLLECTION.membership, input.memberDid, (v) =>
          Array.isArray(v.roles) && !v.roles.includes(channelRoleKey(skey)),
        ),
      true,
    ],
    [
      "publish archived channel",
      "fault-archive-final",
      "channel-archive-final",
      (skey: string) => recordMutation(workspace, COLLECTION.directory, skey, (value) => value.visibility === "archived"),
      true,
    ],
  ] as const;
  for (const [label, skey, expectedStep, buildMatcher, failBeforeCommit] of archiveCases) {
    const space = channelUri(groupDid, skey);
    const messageRkey = tidNow();
    let archiveCredential: Awaited<ReturnType<typeof mintSpaceCredential>> | undefined;
    await injectAndRestart(
      label,
      owner,
      { kind: "archiveChannel", skey },
      expectedStep,
      buildMatcher(skey),
      async () => {
        await seedChannel(skey, "private", [input.memberDid, input.adminDid]);
        await writeRecord(sessionClient(input.memberSession as never), space, input.memberDid, "new.flock.channel.message", messageRkey, {
          $type: "new.flock.channel.message",
          text: "retained after archive",
          createdAt: new Date().toISOString(),
        });
        archiveCredential = await mintSpaceCredential(input.groupSession as never, space);
      },
      async () => {
        assert.equal((await record(workspace, COLLECTION.directory, skey))?.visibility, "archived");
        assert.deepEqual(await access(space, input.memberDid), { read: false, write: false });
        assert.deepEqual(await access(space, input.adminDid), { read: false, write: false });
        assert.equal(await record(membersSpace, OPENSOCIAL_COLLECTION.role, channelRoleKey(skey)), undefined);
        assert.ok(archiveCredential);
        const archivedMessage = await archiveCredential
          .client(memberPds)
          .query<{ uri: string; value: Record<string, unknown> }>("com.atproto.space.getRecord", {
            space,
            repo: input.memberDid,
            collection: "new.flock.channel.message",
            rkey: messageRkey,
          });
        assert.equal(archivedMessage.uri, `${space}/${input.memberDid}/new.flock.channel.message/${messageRkey}`);
        assert.equal(archivedMessage.value.text, "retained after archive");
        await assert.rejects(mintSpaceCredential(input.memberSession as never, space), (error: unknown) => isAccessLost(error));
      },
      failBeforeCommit,
      async () =>
        assert.equal(
          (await record(workspace, COLLECTION.directory, skey))?.visibility,
          label === "publish archived channel" && !failBeforeCommit ? "archived" : "transitioning",
        ),
    );
  }

  // 8. `decideJoinRequest` grants private role and records joinDecision.
  const joinSkey = "fault-join";
  const joinSpace = channelUri(groupDid, joinSkey);
  const joinRequestKey = requestRecordKey(joinSpace, input.memberDid);
  const joinRequestUri = spaceRecordUri(inbox, input.memberDid, "new.flock.joinRequest", joinRequestKey);
  const joinCases = [
    ["approve private membership", "approve", "join-request-channel-membership", "membership"],
    ["record approval decision", "approve", "join-request-decision", "approve"],
    ["record denial decision", "deny", "join-request-decision", "deny"],
  ] as const;
  for (const [label, decision, expectedStep, matchKind] of joinCases) {
    const requestId = tidNow();
    const matcher =
      matchKind === "membership"
        ? recordMutation(membersSpace, OPENSOCIAL_COLLECTION.membership, input.memberDid, (v) =>
            Array.isArray(v.roles) && v.roles.includes(channelRoleKey(joinSkey)),
          )
        : recordMutation(
            inbox,
            "new.flock.joinDecision",
            decisionRecordKey(joinRequestUri),
            (value) => value.requestId === requestId && value.decision === matchKind,
          );
    await injectAndRestart(
      label,
      owner,
      { kind: "decideJoinRequest", request: joinRequestUri, requestId, decision },
      expectedStep,
      matcher,
      async () => {
        await seedChannel(joinSkey, "private", []);
        await writeRecord(sessionClient(input.memberSession as never), inbox, input.memberDid, "new.flock.joinRequest", joinRequestKey, {
          $type: "new.flock.joinRequest",
          channelSkey: joinSkey,
          requestId,
          createdAt: new Date().toISOString(),
        });
      },
      async () => {
        const joined = decision === "approve";
        assert.deepEqual(await access(joinSpace, input.memberDid), { read: joined, write: joined });
        const savedDecision = await record(inbox, "new.flock.joinDecision", decisionRecordKey(joinRequestUri));
        assert.equal(savedDecision?.requestId, requestId);
        assert.equal(savedDecision?.decision, decision);
      },
      matchKind === "membership",
    );
  }

  // 9. Self-leave (`leaveWorkspace`) recoverable after crash.
  await injectAndRestart(
    "self-leave workspace membership",
    memberActor,
    { kind: "leaveWorkspace" },
    "remove-workspace-membership",
    recordDelete(membersSpace, OPENSOCIAL_COLLECTION.membership, input.memberDid),
    () => seedMember(input.memberDid, false),
    async () => {
      assert.deepEqual(await access(workspace, input.memberDid), { read: false, write: false });
      assert.deepEqual(await access(inbox, input.memberDid), { read: false, write: false });
      assert.deepEqual(await access(publicSpace, input.memberDid), { read: false, write: false });
      assert.deepEqual(await access(privateSpace, input.memberDid), { read: false, write: false });
    },
    true,
  );

  // 10. Private channel self-leave (`leaveChannel`) recoverable after crash.
  const privateLeaveSkey = "fault-private-leave";
  const privateLeaveSpace = channelUri(groupDid, privateLeaveSkey);
  await injectAndRestart(
    "leave private channel membership",
    memberActor,
    { kind: "leaveChannel", skey: privateLeaveSkey },
    "leave-channel-membership",
    recordMutation(membersSpace, OPENSOCIAL_COLLECTION.membership, input.memberDid, (v) =>
      Array.isArray(v.roles) && !v.roles.includes(channelRoleKey(privateLeaveSkey)),
    ),
    async () => {
      await seedMember(input.memberDid, false);
      await seedChannel(privateLeaveSkey, "private", [input.memberDid]);
    },
    async () => {
      assert.deepEqual(await access(privateLeaveSpace, input.memberDid), { read: false, write: false });
      assert.deepEqual(await access(workspace, input.memberDid), { read: true, write: false });
    },
    true,
  );

  // 11. `reconcileWorkspace` repairs drifted workspace, inbox, public/private channel, and archived channel policies/roles.
  const archivedRepairSkey = "fault-reconcile-archived";
  const archivedRepairSpace = channelUri(groupDid, archivedRepairSkey);
  const adminOnlyDriftPolicy = {
    $type: "group.opensocial.policy",
    publicRead: false,
    unlisted: true,
    grants: [{ role: "admin", read: true, write: true }],
  } as const;
  const reconcileCases = [
    [
      "reconcile workspace policy",
      "workspace-verified",
      spaceUpdate(workspace),
      async () => {
        await seedMember(input.memberDid, false);
        await updateOpenSocialSpacePolicy(input.groupSession as never, workspace, adminOnlyDriftPolicy);
      },
    ],
    [
      "reconcile inbox policy",
      "inbox-verified",
      spaceUpdate(inbox),
      async () => {
        await seedMember(input.memberDid, false);
        await updateOpenSocialSpacePolicy(input.groupSession as never, inbox, adminOnlyDriftPolicy);
      },
    ],
    [
      "reconcile public channel policy",
      `channel-${input.publicSkey}-verified`,
      spaceUpdate(publicSpace),
      async () => {
        await seedMember(input.memberDid, false);
        await updateOpenSocialSpacePolicy(input.groupSession as never, publicSpace, adminOnlyDriftPolicy);
      },
    ],
    [
      "reconcile private channel policy",
      `channel-${input.privateSkey}-verified`,
      spaceUpdate(privateSpace),
      async () => {
        await seedMember(input.ownerDid, true, [channelRoleKey(input.privateSkey)]);
        await seedMember(input.memberDid, false, [channelRoleKey(input.privateSkey)]);
        await updateOpenSocialSpacePolicy(input.groupSession as never, privateSpace, adminOnlyDriftPolicy);
      },
    ],
    [
      "reconcile archived channel policy and stale roles",
      `archived-${archivedRepairSkey}-verified`,
      spaceUpdate(archivedRepairSpace),
      async () => {
        await seedMember(input.memberDid, false);
        await seedChannel(archivedRepairSkey, "private", [input.memberDid]);
        await writeAuthority(workspace, COLLECTION.directory, archivedRepairSkey, {
          skey: archivedRepairSkey,
          name: `Failure ${archivedRepairSkey}`,
          visibility: "archived",
        });
      },
    ],
  ] as const;
  for (const [label, expectedStep, matcher, prepare] of reconcileCases) {
    await injectAndRestart(
      label,
      owner,
      { kind: "reconcileWorkspace" },
      expectedStep,
      matcher,
      prepare,
      async () => {
        assert.deepEqual(await access(workspace, input.memberDid), { read: true, write: false });
        assert.deepEqual(await access(inbox, input.memberDid), { read: false, write: true });
        assert.deepEqual(await access(publicSpace, input.memberDid), { read: true, write: true });
      },
      true,
    );
  }
  const archivedPolicy = await getOpenSocialSpacePolicy(input.groupSession as never, archivedRepairSpace);
  assert.deepEqual(archivedPolicy?.grants ?? [], []);
  assert.deepEqual(await access(archivedRepairSpace, input.memberDid), { read: false, write: false });
  assert.equal(await record(membersSpace, OPENSOCIAL_COLLECTION.role, channelRoleKey(archivedRepairSkey)), undefined);

  assert.equal(input.memberSession.did, input.memberDid);
}

async function waitForWritersAtGroupHost(
  readerSession: BearerSession,
  space: string,
  groupHostUrl: string,
  expectedWriters: readonly string[],
): Promise<void> {
  const { mintSpaceCredential } = await import("@flock/operator/atproto/space-credential");
  const cred = await mintSpaceCredential(readerSession as never, space);
  const client = cred.client(groupHostUrl);
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const listed = await client.query<{ repos: Array<{ $type?: string; repo: string }> }>("com.atproto.space.listWriters", {
      space,
      limit: 500,
    });
    const present = new Set(
      listed.repos.filter((r) => r.$type === "com.atproto.space.defs#repoWrite").map((r) => r.repo),
    );
    if (expectedWriters.every((did) => present.has(did))) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Writers ${expectedWriters.join(", ")} did not appear in listWriters for ${space}`);
}

async function writeRecord(
  client: { procedure<TInput, TOutput>(method: string, input: TInput): Promise<TOutput> },
  space: string,
  repo: string,
  collection: string,
  rkey: string,
  record: Record<string, unknown>,
): Promise<{ uri: string; cid: string }> {
  return client.procedure<Record<string, unknown>, { uri: string; cid: string }>("com.atproto.space.putRecord", {
    space,
    repo,
    collection,
    rkey,
    record,
  });
}

async function runReconciliation(
  databasePath: string,
  authorityDid: string,
  actorDid: string,
  workspace: string,
  mutationsPaused = true,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", "protocol-tests/recover-pending-operation.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_PATH: databasePath,
      RECOVERY_AUTHORITY_DID: authorityDid,
      RECOVERY_ACTOR_DID: actorDid,
      RECOVERY_WORKSPACE: workspace,
      RECOVERY_RECONCILE_ONLY: "true",
      FLOCK_ADMIN_MUTATIONS_PAUSED: mutationsPaused ? "true" : "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { exitCode, stdout, stderr };
}

async function acceptOperatorCreateWorkspace(
  pds: PdsNetwork,
  owner: NetworkActor,
  session: BearerSession,
  serviceRef: string,
): Promise<void> {
  const { tidNow } = await import("@flock/protocol/keys");
  const opGroup = await createOpenSocialGroup(pds, owner, {
    name: "Authenticated Operator Workspace",
    keyLabel: "auth-op-create-dpop",
  });
  await expireStoredSession("authority_grant", opGroup.groupDid);
  const body = {
    authority: opGroup.groupDid,
    name: "Authenticated Operator Workspace",
    operationId: tidNow(),
  };
  const anonymous = await fetch(new URL("/xrpc/new.flock.operator.createWorkspace", await inProcessOperator()), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(anonymous.status, 403, "the operator refuses a request without a service token");
  const result = (await callOperatorMethod(session, serviceRef, "new.flock.operator.createWorkspace", {}, body)) as {
    state: string;
    workspace: string;
  };
  assert.equal(result.state, "completed", "the operator restores the encrypted Group-DID authority grant and bootstraps against GroupHost");
  assert.equal(result.workspace, `at://${opGroup.groupDid}/space/new.flock.workspace/self`);
}

async function runRestartRecovery(input: {
  databasePath: string;
  authorityDid: string;
  actorDid: string;
  workspace: string;
  memberDid: string;
  operationId: string;
  accessJwt?: string;
  pdsUrl?: string;
  resumeAll?: boolean;
  useStoredAuthorityGrant?: boolean;
}): Promise<{ state: string; completedSteps: string[]; resumedOperationState: string | null; reconciliationState: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", "protocol-tests/recover-pending-operation.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_PATH: input.databasePath,
      RECOVERY_AUTHORITY_DID: input.authorityDid,
      RECOVERY_ACTOR_DID: input.actorDid,
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
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
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
