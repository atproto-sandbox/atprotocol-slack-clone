import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEngine } from "@flock/client/engine";
import { OperatorRemoteError } from "@flock/client/operator-client";
import { isAccessLost, mintSpaceCredentialWith } from "@flock/protocol/atproto/space-credential-core";
import { isScopeMissingError } from "@flock/protocol/atproto/xrpc";
import { extSpaceUriFor } from "@flock/protocol/extensions";
import { requestDigest, tidNow } from "@flock/protocol/keys";
import { COLLECTION, SPACE_TYPE } from "@flock/protocol/nsids";
import { availablePort, startOperatorServer, type AppServer } from "./support/app-server";
import {
  actorTransport,
  combinedMemberScopes,
  mintAppSession,
  mintBrowserSession,
  startPdsNetwork,
  storeAuthorityGrant,
} from "./support/pds-network";

test("extensions at the pinned PDS: enable, discovery, getChanges, membership lifecycle, disable, and legacy authority grant safety (R11c)", { timeout: 10 * 60_000 }, async (t) => {
  const port = await availablePort();
  const pds = await startPdsNetwork("extensions-operator", { operatorPort: port });
  const appStateDir = mkdtempSync(join(tmpdir(), "r11c-ext-app-"));
  let server: AppServer | undefined;
  try {
    server = await startOperatorServer();
    const [
      { authorityClientMetadata, AuthorityReauthorizationRequiredError, restoreAuthorityGrant },
      { createWorkspace },
      { executeOperatorOperation },
      { parseWorkspaceRef },
      { registrationDeps },
      { listSpaceMembers, putAuthorityRecord, spaceExists },
      { mintSpaceCredential },
      { sessionClient },
      { resolvePds },
      { isRegisteredSpace },
      { getRawDb },
    ] = await Promise.all([
      import("@flock/operator/operator/authority-grant"),
      import("@flock/operator/operator/kinds/create-workspace"),
      import("@flock/operator/operator/operations"),
      import("@flock/operator/operator/actor"),
      import("@flock/operator/operator/registrations"),
      import("@flock/operator/atproto/space-ops"),
      import("@flock/operator/atproto/space-credential"),
      import("@flock/operator/atproto/client"),
      import("@flock/operator/atproto/identity"),
      import("@flock/operator/operator/member-access"),
      import("@flock/operator/lib/db"),
    ]);

    const operatorService = { serviceRef: pds.serviceRef, endpoint: server.url };
    const fullAuthorityScope = authorityClientMetadata().scope;
    const legacyAuthorityScope = fullAuthorityScope
      .split(" ")
      .filter((scope) => !scope.startsWith(`space:${SPACE_TYPE.tasks}?`))
      .join(" ");
    assert.notEqual(legacyAuthorityScope, fullAuthorityScope, "legacy authority scope excludes Tasks space scope");

    const owner = await pds.createActor("r11cowner", 0);
    const memberOne = await pds.createActor("r11cm1", 1);
    const memberTwo = await pds.createActor("r11cm2", 0);
    const leaver = await pds.createActor("r11cleaver", 1);
    const appActor = await pds.createActor("r11capp", 1);

    await storeAuthorityGrant(pds.hosts[0], owner.did, "r11c-owner-full");
    const created = await createWorkspace(await restoreAuthorityGrant(owner.did), {
      creator: owner.did,
      name: "Extensions Workspace",
      operationId: tidNow(),
    }, registrationDeps);
    assert.equal(created.state, "completed");
    const workspace = created.workspace;
    const workspaceRef = parseWorkspaceRef(workspace);
    const tasksSpace = extSpaceUriFor(owner.did, workspaceRef.skey, "tasks");
    const generalSkey = created.channel.split("/").at(-1)!;

    const scopes = await combinedMemberScopes(pds.serviceRef);
    const ownerBrowser = await mintBrowserSession(owner.pds, owner.did, scopes, "r11c-owner-browser");
    const memberOneBrowser = await mintBrowserSession(memberOne.pds, memberOne.did, scopes, "r11c-m1-browser");
    const memberTwoBrowser = await mintBrowserSession(memberTwo.pds, memberTwo.did, scopes, "r11c-m2-browser");
    const leaverBrowser = await mintBrowserSession(leaver.pds, leaver.did, scopes, "r11c-leaver-browser");
    const appSession = await mintAppSession(appActor.pds, appActor.did, {
      serviceRef: pds.serviceRef,
      plcUrl: pds.plcUrl,
      stateFile: join(appStateDir, "app.json"),
    }, "r11c-app-dpop");

    const ownerEngine = createEngine(actorTransport(pds, owner), { operator: operatorService });
    const memberOneEngine = createEngine(actorTransport(pds, memberOne), { operator: operatorService });
    const memberTwoEngine = createEngine(actorTransport(pds, memberTwo), { operator: operatorService });
    const leaverEngine = createEngine(actorTransport(pds, leaver), { operator: operatorService });
    const appEngine = createEngine(actorTransport(pds, appActor), { operator: operatorService });

    assert.equal((await ownerEngine.operator!.execute({
      workspace,
      operationId: tidNow(),
      request: { kind: "inviteMember", subject: memberOne.did },
    })).operation.state, "completed");
    await memberOneEngine.workspaces.accept(workspace);
    assert.equal((await ownerEngine.operator!.execute({
      workspace,
      operationId: tidNow(),
      request: { kind: "installApp", subject: appActor.did, channels: [{ skey: generalSkey, write: true }] },
    })).operation.state, "completed");

    await t.test("enableExtension creates Tasks space, writes ext.install, grants roster members (not apps), registers notices, discovers extension, and delivers getChanges updates", async () => {
      const enabled = await ownerEngine.operator!.enableExtension(workspace, "tasks");
      assert.equal(enabled.operation.state, "completed");

      const grant = await restoreAuthorityGrant(owner.did);
      assert.equal(await spaceExists(grant, tasksSpace), true);
      const members = await listSpaceMembers(grant, tasksSpace);
      assert.deepEqual(members, [{ did: memberOne.did, read: true, write: true }]);
      assert.equal(members.some((m) => m.did === appActor.did), false, "apps never get Tasks space access");
      assert.equal(isRegisteredSpace(tasksSpace), true, "Tasks space notice registration is recorded");

      const discovery = await memberOneEngine.workspaces.discover();
      const summary = discovery.workspaces.find((ws) => ws.uri === workspace);
      assert.ok(summary);
      assert.equal(summary.rosterComplete, true);
      assert.equal(summary.extensionsComplete, true);
      assert.equal(summary.extensions?.length, 1);
      assert.equal(summary.extensions?.[0]?.extId, "tasks");
      assert.equal(summary.extensions?.[0]?.active, true);
      assert.equal(summary.extensions?.[0]?.cleanupComplete, false);
      assert.equal(summary.extensions?.[0]?.space, tasksSpace);

      // App is denied by OAuth scope, PDS Tasks space member list, and operator getChanges.
      const appScopeErr = await mintSpaceCredential(appSession, tasksSpace).then(() => null, (err: unknown) => err);
      assert.ok(appScopeErr && isScopeMissingError(appScopeErr));
      const appCredErr = await mintSpaceCredentialWith(actorTransport(pds, appActor), tasksSpace).then(() => null, (err: unknown) => err);
      assert.ok(appCredErr && isAccessLost(appCredErr));
      const appFeed = await appEngine.operator!.getChanges([{ space: tasksSpace, after: "0" }]);
      assert.deepEqual(appFeed.denied, [tasksSpace]);

      // Member writes a project record to Tasks space and getChanges delivers the real PDS write notification.
      const { head } = await memberOneEngine.operator!.getChanges([]);
      const projectRkey = tidNow();
      await sessionClient(ownerBrowser.session).procedure("com.atproto.space.createRecord", {
        space: tasksSpace,
        repo: owner.did,
        collection: COLLECTION.taskProject,
        rkey: projectRkey,
        record: {
          $type: COLLECTION.taskProject,
          name: "R11c Project",
          t: "000170000000000.0000",
          createdAt: new Date().toISOString(),
        },
      });

      let cursor = head;
      let delivered = false;
      const deadline = Date.now() + 60_000;
      while (!delivered && Date.now() < deadline) {
        const answer = await memberOneEngine.operator!.getChanges([{ space: tasksSpace, after: cursor }]);
        assert.deepEqual(answer.denied, []);
        if (answer.changed.some((entry) => entry.space === tasksSpace)) {
          delivered = true;
          break;
        }
        cursor = answer.head;
      }
      assert.equal(delivered, true, `real PDS notifySpaceUpdate delivered Tasks space change\n${server!.output()}`);

      const m1Cred = await mintSpaceCredential(memberOneBrowser.session, tasksSpace);
      const readProject = await m1Cred.client(await resolvePds(owner.did)).query<{ value: { name?: string } }>(
        "com.atproto.space.getRecord",
        { space: tasksSpace, repo: owner.did, collection: COLLECTION.taskProject, rkey: projectRkey },
      );
      assert.equal(readProject.value.name, "R11c Project");
    });

    await t.test("inviteMember grants Tasks access, while removeMember and leaveWorkspace revoke Tasks access and getChanges immediately", async () => {
      assert.equal((await ownerEngine.operator!.execute({
        workspace, operationId: tidNow(), request: { kind: "inviteMember", subject: memberTwo.did },
      })).operation.state, "completed");
      assert.equal((await ownerEngine.operator!.execute({
        workspace, operationId: tidNow(), request: { kind: "inviteMember", subject: leaver.did },
      })).operation.state, "completed");

      const grant = await restoreAuthorityGrant(owner.did);
      const members = await listSpaceMembers(grant, tasksSpace);
      assert.equal(members.some((m) => m.did === memberTwo.did && m.read && m.write), true);
      assert.equal(members.some((m) => m.did === leaver.did && m.read && m.write), true);

      // memberTwo writes a task and reads Changes before removal.
      const taskRkey = tidNow();
      await sessionClient(memberTwoBrowser.session).procedure("com.atproto.space.createRecord", {
        space: tasksSpace,
        repo: memberTwo.did,
        collection: COLLECTION.task,
        rkey: taskRkey,
        record: {
          $type: COLLECTION.task,
          title: "Verify removal",
          status: "todo",
          priority: "medium",
          t: "000170000000001.0000",
          createdAt: new Date().toISOString(),
        },
      });
      const { head: m2Head } = await memberTwoEngine.operator!.getChanges([]);
      const { head: leaverHead } = await leaverEngine.operator!.getChanges([]);

      // removeMember revokes Tasks access immediately.
      assert.equal((await ownerEngine.operator!.execute({
        workspace, operationId: tidNow(), request: { kind: "removeMember", subject: memberTwo.did },
      })).operation.state, "completed");
      assert.equal((await listSpaceMembers(grant, tasksSpace)).some((m) => m.did === memberTwo.did), false);
      const m2Started = Date.now();
      const m2Changes = await memberTwoEngine.operator!.getChanges([{ space: tasksSpace, after: m2Head }]);
      assert.deepEqual(m2Changes.denied, [tasksSpace]);
      assert.ok(Date.now() - m2Started < 5_000, "removed member denied immediately");
      const m2CredErr = await mintSpaceCredential(memberTwoBrowser.session, tasksSpace).then(() => null, (err: unknown) => err);
      assert.ok(m2CredErr && isAccessLost(m2CredErr));

      // leaveWorkspace revokes Tasks access immediately.
      assert.equal((await leaverEngine.operator!.execute({
        workspace, operationId: tidNow(), request: { kind: "leaveWorkspace" },
      })).operation.state, "completed");
      assert.equal((await listSpaceMembers(grant, tasksSpace)).some((m) => m.did === leaver.did), false);
      const leaverStarted = Date.now();
      const leaverChanges = await leaverEngine.operator!.getChanges([{ space: tasksSpace, after: leaverHead }]);
      assert.deepEqual(leaverChanges.denied, [tasksSpace]);
      assert.ok(Date.now() - leaverStarted < 5_000, "leaving member denied immediately");
      const leaverCredErr = await mintSpaceCredential(leaverBrowser.session, tasksSpace).then(() => null, (err: unknown) => err);
      assert.ok(leaverCredErr && isAccessLost(leaverCredErr));
    });

    await t.test("disableExtension revokes all members, drops notices, sets cleanupComplete: true, and purges client store", async () => {
      await memberOneEngine.sync.store.putSpace({
        space: tasksSpace,
        spaceRev: "1",
        writers: [{ did: owner.did, repoRev: "1" }],
        writersListedAt: Date.now(),
        workspace,
        lastOpenedAt: Date.now(),
      });
      const beforeSummary = await memberOneEngine.workspaces.summary(workspace);
      assert.equal(beforeSummary?.extensions?.[0]?.active, true);
      assert.notEqual(await memberOneEngine.sync.store.getSpace(tasksSpace), undefined);

      const { head } = await memberOneEngine.operator!.getChanges([]);
      const disabled = await ownerEngine.operator!.disableExtension(workspace, "tasks");
      assert.equal(disabled.operation.state, "completed");

      const grant = await restoreAuthorityGrant(owner.did);
      assert.deepEqual(await listSpaceMembers(grant, tasksSpace), []);
      assert.equal(isRegisteredSpace(tasksSpace), false, "notice registration dropped");
      assert.equal(
        (getRawDb().prepare("SELECT count(*) AS count FROM space_notification WHERE space_uri = ?").get(tasksSpace) as { count: number }).count,
        0,
      );

      const denied = await memberOneEngine.operator!.getChanges([{ space: tasksSpace, after: head }]);
      assert.deepEqual(denied.denied, [tasksSpace]);
      const m1CredErr = await mintSpaceCredential(memberOneBrowser.session, tasksSpace).then(() => null, (err: unknown) => err);
      assert.ok(m1CredErr && isAccessLost(m1CredErr));

      const afterSummary = await memberOneEngine.workspaces.summary(workspace);
      assert.equal(afterSummary?.extensions?.[0]?.active, false);
      assert.equal(afterSummary?.extensions?.[0]?.cleanupComplete, true);
      assert.equal(typeof afterSummary?.extensions?.[0]?.disabledAt, "string");
      assert.equal(await memberOneEngine.sync.store.getSpace(tasksSpace), undefined, "disabled extension space purged from client store");
    });

    await t.test("legacy authority grant without Tasks scope succeeds on pre-R11 and cleanly disabled workspaces, and blocks enable/removal/leave/reconcile on active or uncleaned extensions", async () => {
      // 1. Cleanly disabled workspace (cleanupComplete: true) under legacy authority grant succeeds on remove, leave, reconcile.
      await ownerEngine.operator!.execute({ workspace, operationId: tidNow(), request: { kind: "inviteMember", subject: memberTwo.did } });
      await ownerEngine.operator!.execute({ workspace, operationId: tidNow(), request: { kind: "inviteMember", subject: leaver.did } });
      await storeAuthorityGrant(pds.hosts[0], owner.did, "r11c-owner-legacy-disabled", { scope: legacyAuthorityScope });
      assert.equal((await ownerEngine.operator!.execute({
        workspace, operationId: tidNow(), request: { kind: "removeMember", subject: memberTwo.did },
      })).operation.state, "completed");
      assert.equal((await leaverEngine.operator!.execute({
        workspace, operationId: tidNow(), request: { kind: "leaveWorkspace" },
      })).operation.state, "completed");
      assert.equal((await ownerEngine.operator!.execute({
        workspace, operationId: tidNow(), request: { kind: "reconcileWorkspace" },
      })).operation.state, "completed");

      // 2. Fresh pre-R11 workspace (Tasks never enabled) under legacy authority grant: remove/leave/reconcile succeed; enableExtension fails cleanly until re-grant.
      const legacyOwner = await pds.createActor("r11clegowner", 0);
      await storeAuthorityGrant(pds.hosts[0], legacyOwner.did, "r11c-leg-init");
      const legacyCreated = await createWorkspace(await restoreAuthorityGrant(legacyOwner.did), {
        creator: legacyOwner.did,
        name: "Legacy Workspace",
        operationId: tidNow(),
      }, registrationDeps);
      const legacyWs = legacyCreated.workspace;
      const legacyTasksSpace = extSpaceUriFor(legacyOwner.did, parseWorkspaceRef(legacyWs).skey, "tasks");
      const legacyOwnerEngine = createEngine(actorTransport(pds, legacyOwner), { operator: operatorService });
      assert.equal((await legacyOwnerEngine.operator!.execute({
        workspace: legacyWs, operationId: tidNow(), request: { kind: "inviteMember", subject: memberTwo.did },
      })).operation.state, "completed");
      assert.equal((await legacyOwnerEngine.operator!.execute({
        workspace: legacyWs, operationId: tidNow(), request: { kind: "inviteMember", subject: leaver.did },
      })).operation.state, "completed");

      await storeAuthorityGrant(pds.hosts[0], legacyOwner.did, "r11c-leg-downgraded", { scope: legacyAuthorityScope });
      assert.equal((await legacyOwnerEngine.operator!.execute({
        workspace: legacyWs, operationId: tidNow(), request: { kind: "removeMember", subject: memberTwo.did },
      })).operation.state, "completed");
      assert.equal((await leaverEngine.operator!.execute({
        workspace: legacyWs, operationId: tidNow(), request: { kind: "leaveWorkspace" },
      })).operation.state, "completed");
      assert.equal((await legacyOwnerEngine.operator!.execute({
        workspace: legacyWs, operationId: tidNow(), request: { kind: "reconcileWorkspace" },
      })).operation.state, "completed");

      // enableExtension under legacy grant fails cleanly with AuthoritySessionUnavailable and leaves no row or ext.install record.
      const enableOpId = tidNow();
      await assert.rejects(
        legacyOwnerEngine.operator!.enableExtension(legacyWs, "tasks", enableOpId),
        (err: unknown) => err instanceof OperatorRemoteError && err.status === 502 && err.code === "AuthoritySessionUnavailable",
      );
      assert.equal(getRawDb().prepare("SELECT 1 FROM operation WHERE operation_id = ?").get(enableOpId), undefined);

      // Re-grant full scope -> retry enableExtension with the same operationId succeeds.
      await storeAuthorityGrant(pds.hosts[0], legacyOwner.did, "r11c-leg-regranted");
      assert.equal((await legacyOwnerEngine.operator!.execute({
        workspace: legacyWs, operationId: tidNow(), request: { kind: "inviteMember", subject: memberTwo.did },
      })).operation.state, "completed");
      assert.equal((await legacyOwnerEngine.operator!.execute({
        workspace: legacyWs, operationId: tidNow(), request: { kind: "inviteMember", subject: leaver.did },
      })).operation.state, "completed");
      assert.equal((await legacyOwnerEngine.operator!.enableExtension(legacyWs, "tasks", enableOpId)).operation.state, "completed");

      // 3. Active extension under legacy grant fails cleanly on removeMember, leaveWorkspace, and reconcileWorkspace.
      await storeAuthorityGrant(pds.hosts[0], legacyOwner.did, "r11c-leg-active-downgrade", { scope: legacyAuthorityScope });
      await assert.rejects(
        legacyOwnerEngine.operator!.execute({ workspace: legacyWs, operationId: tidNow(), request: { kind: "removeMember", subject: memberTwo.did } }),
        (err: unknown) => err instanceof OperatorRemoteError && err.status === 502 && err.code === "AuthoritySessionUnavailable",
      );
      await assert.rejects(
        leaverEngine.operator!.execute({ workspace: legacyWs, operationId: tidNow(), request: { kind: "leaveWorkspace" } }),
        (err: unknown) => err instanceof OperatorRemoteError && err.status === 502 && err.code === "AuthoritySessionUnavailable",
      );
      await assert.rejects(
        legacyOwnerEngine.operator!.execute({ workspace: legacyWs, operationId: tidNow(), request: { kind: "reconcileWorkspace" } }),
        (err: unknown) => err instanceof OperatorRemoteError && err.status === 502 && err.code === "AuthoritySessionUnavailable",
      );
      // Verify memberTwo was NOT removed from workspace or Tasks space!
      await storeAuthorityGrant(pds.hosts[0], legacyOwner.did, "r11c-leg-check");
      const fullGrant = await restoreAuthorityGrant(legacyOwner.did);
      assert.equal((await listSpaceMembers(fullGrant, legacyTasksSpace)).some((m) => m.did === memberTwo.did), true);

      // 4. Uncleaned disable (active: false, cleanupComplete: false) under legacy grant ALSO blocks remove/leave/reconcile and recovery.
      const nowIso = new Date().toISOString();
      await putAuthorityRecord(fullGrant, legacyWs, COLLECTION.extInstall, "tasks", {
        extId: "tasks",
        active: false,
        space: legacyTasksSpace,
        cleanupComplete: false,
        enabledBy: legacyOwner.did,
        enabledAt: nowIso,
        updatedAt: nowIso,
        disabledAt: nowIso,
      });
      await storeAuthorityGrant(pds.hosts[0], legacyOwner.did, "r11c-leg-uncleaned-downgrade", { scope: legacyAuthorityScope });
      await assert.rejects(
        legacyOwnerEngine.operator!.execute({ workspace: legacyWs, operationId: tidNow(), request: { kind: "removeMember", subject: memberTwo.did } }),
        (err: unknown) => err instanceof OperatorRemoteError && err.status === 502 && err.code === "AuthoritySessionUnavailable",
      );
      await assert.rejects(
        leaverEngine.operator!.execute({ workspace: legacyWs, operationId: tidNow(), request: { kind: "leaveWorkspace" } }),
        (err: unknown) => err instanceof OperatorRemoteError && err.status === 502 && err.code === "AuthoritySessionUnavailable",
      );
      await assert.rejects(
        legacyOwnerEngine.operator!.execute({ workspace: legacyWs, operationId: tidNow(), request: { kind: "reconcileWorkspace" } }),
        (err: unknown) => err instanceof OperatorRemoteError && err.status === 502 && err.code === "AuthoritySessionUnavailable",
      );

      // Verify a pending operation blocked on legacy Tasks scope raises AuthorityReauthorizationRequiredError when another op attempts recovery.
      const legacyActor = {
        did: legacyOwner.did,
        session: await restoreAuthorityGrant(legacyOwner.did),
        workspace: parseWorkspaceRef(legacyWs),
        canRecoverOperations: true,
      };
      const pendingReq = { kind: "removeMember", subject: memberTwo.did };
      getRawDb().prepare(`INSERT INTO operation (workspace, workspace_uri, actor, operation_id, request_hash, request_json, state, steps_json, error, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 'missing tasks scope', ?, ?)`).run(
        legacyOwner.did,
        legacyWs,
        legacyOwner.did,
        "222222222229a",
        requestDigest({ workspace: legacyWs, request: pendingReq }),
        JSON.stringify({ workspace: legacyWs, request: pendingReq }),
        JSON.stringify(["remove-inbox-membership"]),
        Math.floor(Date.now() / 1000) - 60,
        Math.floor(Date.now() / 1000) - 60,
      );
      await assert.rejects(
        executeOperatorOperation(legacyActor, tidNow(), { kind: "reconcileWorkspace" }, registrationDeps),
        AuthorityReauthorizationRequiredError,
      );
      // Clean up synthetic row before finishing via HTTP re-consent.
      getRawDb().prepare("DELETE FROM operation WHERE operation_id = ?").run("222222222229a");

      // Re-grant full scope -> reconcileWorkspace finishes cleanup, removeMember & leaveWorkspace succeed!
      await storeAuthorityGrant(pds.hosts[0], legacyOwner.did, "r11c-leg-final-regrant");
      assert.equal((await legacyOwnerEngine.operator!.execute({
        workspace: legacyWs, operationId: tidNow(), request: { kind: "reconcileWorkspace" },
      })).operation.state, "completed");
      assert.deepEqual(await listSpaceMembers(await restoreAuthorityGrant(legacyOwner.did), legacyTasksSpace), []);
      const legacySummary = await legacyOwnerEngine.workspaces.summary(legacyWs);
      assert.equal(legacySummary?.extensions?.[0]?.cleanupComplete, true);
      assert.equal((await legacyOwnerEngine.operator!.execute({
        workspace: legacyWs, operationId: tidNow(), request: { kind: "removeMember", subject: memberTwo.did },
      })).operation.state, "completed");
      assert.equal((await leaverEngine.operator!.execute({
        workspace: legacyWs, operationId: tidNow(), request: { kind: "leaveWorkspace" },
      })).operation.state, "completed");
    });
  } finally {
    await server?.stop();
    rmSync(appStateDir, { recursive: true, force: true });
    await pds.close();
  }
});
