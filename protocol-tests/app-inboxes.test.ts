import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acceptGroupMembership,
  callOperatorMethod,
  combinedMemberScopes,
  createOpenSocialGroup,
  mintAppSession,
  mintBrowserSession,
  outcome,
  startPdsNetwork,
  storeGroupAuthorityGrant,
} from "./support/pds-network";

async function waitForWriter(
  queryWriters: () => Promise<string[]>,
  did: string,
  present: boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if ((await queryWriters()).includes(did) === present) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal((await queryWriters()).includes(did), present, `writer ${did} expected present=${String(present)}`);
}

// R10a / R13 gate: per-install app inboxes on the real two-host PDS network + OpenSocial Group Host.
test("app inboxes on the pinned PDS: member command writes, app-only reads, removal, uninstall, pre-R10 installs and grants (R10a)", { timeout: 10 * 60 * 1000 }, async (t) => {
  const pds = await startPdsNetwork("app-inboxes");
  const stateDir = mkdtempSync(join(tmpdir(), "r10a-app-state-"));
  try {
    const [
      { restoreAuthorityGrant },
      { createWorkspace },
      { mintSpaceCredential },
      { isAccessLost },
      { sessionClient },
      { resolvePds },
      { appInboxState, getOpenSocialSpacePolicy, putAuthorityRecord, updateOpenSocialSpacePolicy },
      { liveSpaceAccess, putMembershipRoles, readGroupGovernanceState },
      { defaultWorkspaceSpacePolicy, defaultPublicChannelPolicy },
      { isRegisteredSpace },
      { recordWriteNotification },
      { getRawDb },
      keys,
      { OPENSOCIAL_COLLECTION, OPENSOCIAL_PERMISSION_SET, OPENSOCIAL_POLICY, SPACE_TYPE },
    ] = await Promise.all([
      import("@flock/operator/operator/authority-grant"),
      import("@flock/operator/operator/kinds/create-workspace"),
      import("@flock/operator/atproto/space-credential"),
      import("@flock/protocol/atproto/space-credential-core"),
      import("@flock/operator/atproto/client"),
      import("@flock/operator/atproto/identity"),
      import("@flock/operator/atproto/space-ops"),
      import("@flock/operator/operator/workspace-state"),
      import("@flock/operator/operator/workspace-spaces"),
      import("@flock/operator/operator/member-access"),
      import("@flock/operator/operator/notices"),
      import("@flock/operator/lib/db"),
      import("@flock/protocol/keys"),
      import("@flock/protocol/nsids"),
    ]);

    const adminActor = await pds.createActor("r10admin", 1);
    const memberOne = await pds.createActor("r10m1", 0);
    const memberTwo = await pds.createActor("r10m2", 1);
    const appOne = await pds.createActor("r10app1", 1);
    const appTwo = await pds.createActor("r10app2", 1);

    const group = await createOpenSocialGroup(pds, adminActor, { name: "Interactions", keyLabel: "r10-auth-grant" });
    const created = await createWorkspace(await restoreAuthorityGrant(group.groupDid), {
      creator: adminActor.did,
      name: "Interactions",
      operationId: keys.tidNow(),
    });
    assert.equal(created.state, "completed");
    const workspaceSkey = keys.parseWorkspaceUri(created.workspace)!.skey;
    const generalSkey = created.channel.split("/").at(-1)!;

    const memberScopes = await combinedMemberScopes(pds.serviceRef);
    const adminBrowser = await mintBrowserSession(adminActor.pds, adminActor.did, memberScopes, "r10-admin-browser");
    const memberOneBrowser = await mintBrowserSession(memberOne.pds, memberOne.did, memberScopes, "r10-m1-browser");
    const memberTwoBrowser = await mintBrowserSession(memberTwo.pds, memberTwo.did, memberScopes, "r10-m2-browser");
    const appOneSession = await mintAppSession(
      appOne.pds,
      appOne.did,
      { serviceRef: pds.serviceRef, plcUrl: pds.plcUrl, stateFile: join(stateDir, "app1.json") },
      "r10-app1-dpop",
    );
    const appTwoSession = await mintAppSession(
      appTwo.pds,
      appTwo.did,
      { serviceRef: pds.serviceRef, plcUrl: pds.plcUrl, stateFile: join(stateDir, "app2.json") },
      "r10-app2-dpop",
    );

    const execute = (operationId: string, request: Record<string, unknown>) =>
      callOperatorMethod(adminBrowser.session, pds.serviceRef, "new.flock.operator.execute", {}, {
        workspace: created.workspace,
        operationId,
        request,
      }) as Promise<{ operation?: { state?: string } }>;

    assert.equal((await execute(keys.tidNow(), { kind: "inviteMember", subject: memberOne.did })).operation?.state, "completed");
    assert.equal((await execute(keys.tidNow(), { kind: "inviteMember", subject: memberTwo.did })).operation?.state, "completed");
    await acceptGroupMembership(pds, memberOne, group.groupDid);
    await acceptGroupMembership(pds, memberTwo, group.groupDid);
    assert.equal(
      (
        await execute(keys.tidNow(), {
          kind: "installApp",
          subject: appOne.did,
          channels: [{ skey: generalSkey, write: true }],
        })
      ).operation?.state,
      "completed",
    );

    const appOneInbox = keys.appInboxUri(group.groupDid, workspaceSkey, appOne.did);

    const inboxWriters = async (inbox: string) => {
      const cred = await mintSpaceCredential(appOneSession, inbox);
      const listed = await cred.client(pds.groupHostUrl).query<{ repos: Array<{ $type?: string; repo: string }> }>(
        "com.atproto.space.listWriters",
        { space: inbox, limit: 100 },
      );
      return listed.repos
        .filter((entry) => entry.$type === "com.atproto.space.defs#repoWrite")
        .map((entry) => entry.repo);
    };

    await t.test("after an install, a member's command in the inbox is read by the app, and a second member and a non-authority admin are refused it", async () => {
      assert.equal(isRegisteredSpace(appOneInbox), true, "installApp registered the inbox for notices");
      const cmdRkey = keys.tidNow();
      await sessionClient(memberOneBrowser.session).procedure("com.atproto.space.createRecord", {
        space: appOneInbox,
        repo: memberOne.did,
        collection: "new.flock.app.command",
        rkey: cmdRkey,
        record: {
          $type: "new.flock.app.command",
          command: "echo",
          text: "secret command",
          channel: created.channel,
          createdAt: new Date().toISOString(),
        },
      });
      await waitForWriter(() => inboxWriters(appOneInbox), memberOne.did, true);

      const appCred = await mintSpaceCredential(appOneSession, appOneInbox);
      const read = await appCred.client(await resolvePds(memberOne.did)).query<{ value: { command?: string; text?: string } }>(
        "com.atproto.space.getRecord",
        { space: appOneInbox, repo: memberOne.did, collection: "new.flock.app.command", rkey: cmdRkey },
      );
      assert.deepEqual([read.value.command, read.value.text], ["echo", "secret command"]);

      recordWriteNotification({ space: appOneInbox, repo: memberOne.did, repoRev: cmdRkey });

      for (const [label, session, actor] of [
        ["second member", memberTwoBrowser.session, memberTwo],
        ["non-authority admin", adminBrowser.session, adminActor],
      ] as const) {
        const browserRefusal = await mintSpaceCredential(session, appOneInbox).then(() => null, (err: unknown) => err);
        assert.ok(browserRefusal, `${label} browser session is refused`);
        const readScoped = await mintAppSession(
          actor.pds,
          actor.did,
          { serviceRef: pds.serviceRef, plcUrl: pds.plcUrl, stateFile: join(stateDir, `${actor.handle}.json`) },
          `r10-readprobe-${actor.handle}`,
        );
        const hostRefusal = await mintSpaceCredential(readScoped, appOneInbox).then(() => null, (err: unknown) => err);
        assert.ok(
          hostRefusal && isAccessLost(hostRefusal),
          `${label} is refused by the Group Host's OpenSocial policy: ${String(hostRefusal)}`,
        );
        const feed = (await callOperatorMethod(session, pds.serviceRef, "new.flock.operator.getChanges", {}, {
          follow: [{ space: appOneInbox, after: "0" }],
        })) as { denied: string[] };
        assert.deepEqual(feed.denied, [appOneInbox], `${label} is denied by getChanges`);
      }

      const appFeed = (await callOperatorMethod(appOneSession, pds.serviceRef, "new.flock.operator.getChanges", {}, {
        follow: [{ space: appOneInbox, after: "0" }],
      })) as { head: string; denied: string[]; changed: Array<{ space: string; cursor: string }> };
      assert.deepEqual(appFeed.denied, [], "installed app is admitted to its inbox by getChanges");
      assert.deepEqual(appFeed.changed.map((entry) => entry.space), [appOneInbox]);
    });

    await t.test("a person removed from the workspace is no longer listed as a writer in the app inbox", async () => {
      assert.equal((await execute(keys.tidNow(), { kind: "removeMember", subject: memberOne.did })).operation?.state, "completed");
      await waitForWriter(() => inboxWriters(appOneInbox), memberOne.did, false);
      const gov = await readGroupGovernanceState(await restoreAuthorityGrant(group.groupDid), group.groupDid);
      assert.deepEqual(liveSpaceAccess(gov, group.groupDid, appOneInbox, memberOne.did), { read: false, write: false });
    });

    await t.test("after an uninstall the inbox grants are cleared, its registration gone, and the app refused by getChanges and the host", async () => {
      const { head } = (await callOperatorMethod(appOneSession, pds.serviceRef, "new.flock.operator.getChanges", {}, {
        follow: [],
      })) as { head: string };
      assert.equal((await execute(keys.tidNow(), { kind: "uninstallApp", subject: appOne.did })).operation?.state, "completed");

      const policy = await getOpenSocialSpacePolicy(await restoreAuthorityGrant(group.groupDid), appOneInbox);
      assert.deepEqual(policy?.grants ?? [], []);
      assert.equal(policy?.unlisted, true);
      assert.equal(isRegisteredSpace(appOneInbox), false, "notice registration dropped");

      const feed = (await callOperatorMethod(appOneSession, pds.serviceRef, "new.flock.operator.getChanges", {}, {
        follow: [{ space: appOneInbox, after: head }],
      })) as { denied: string[] };
      assert.deepEqual(feed.denied, [appOneInbox]);

      const refusal = await mintSpaceCredential(appOneSession, appOneInbox).then(() => null, (err: unknown) => err);
      assert.ok(refusal && isAccessLost(refusal), `uninstalled app refused a credential: ${String(refusal)}`);
    });

    await t.test("pre-R10 installs and narrower authority grants handle invite/remove, ask re-approval on updateAppAccess and reconcile, and create remaining inboxes", async () => {
      const grant = await restoreAuthorityGrant(group.groupDid);
      const nowIso = new Date().toISOString();
      const appThree = await pds.createActor("r10app3", 0);
      const membersSpace = keys.groupMembersUri(group.groupDid);
      for (const app of [appTwo, appThree]) {
        const rKey = keys.appRoleKey(app.did);
        await putAuthorityRecord(grant, created.workspace, "new.flock.app.install", keys.subjectKey(app.did), {
          subject: app.did,
          active: true,
          channels: [{ skey: generalSkey, write: true }],
          installedBy: adminActor.did,
          installedAt: nowIso,
          updatedAt: nowIso,
        });
        await putAuthorityRecord(grant, membersSpace, OPENSOCIAL_COLLECTION.role, rKey, {
          displayName: `App: ${app.did}`,
        });
        await putMembershipRoles(grant, group.groupDid, app.did, [rKey]);
      }
      const seededAppRoles = [appTwo, appThree].map((a) => keys.appRoleKey(a.did));
      await updateOpenSocialSpacePolicy(grant, created.workspace, defaultWorkspaceSpacePolicy(seededAppRoles));
      await updateOpenSocialSpacePolicy(
        grant,
        created.channel,
        defaultPublicChannelPolicy(seededAppRoles.map((role) => ({ role, write: true }))),
      );

      const appTwoInbox = keys.appInboxUri(group.groupDid, workspaceSkey, appTwo.did);
      const appThreeInbox = keys.appInboxUri(group.groupDid, workspaceSkey, appThree.did);
      assert.equal(await appInboxState(grant, appTwoInbox), "missing");

      // Store a narrower group authority grant (omitting `space:new.flock.app.inbox` and `collection=new.flock.app.install` write).
      const preR10Scope = [
        "atproto",
        `include:${OPENSOCIAL_PERMISSION_SET.authManageGroup}`,
        "repo:*",
        "blob:*/*",
        "identity:*",
        "account:repo?action=manage",
        "account:status?action=manage",
        "space:*?authority=*&action=read_self",
        `space:${SPACE_TYPE.workspace}?collection=new.flock.directory&collection=new.flock.ext.install&action=read&action=create&action=update&action=delete&manage=create&manage=update&manage=delete`,
        `space:${SPACE_TYPE.inbox}?collection=*&action=read&action=create&action=update&action=delete&manage=create&manage=update&manage=delete`,
        `space:${SPACE_TYPE.channel}?collection=*&action=read&action=create&action=update&action=delete&manage=create&manage=update&manage=delete`,
        "rpc?aud=*&lxm=com.atproto.server.createAccount&lxm=com.atproto.space.notifyCredentialsRevoked&lxm=com.atproto.space.notifyRepoUpdate",
      ].join(" ");
      await storeGroupAuthorityGrant(pds, adminActor, group.groupDid, "r10-prer10-grant", { scope: preR10Scope });

      // O(1) OpenSocial inviteMember and removeMember succeed cleanly under the narrower grant.
      const extraMember = await pds.createActor("r10extra", 0);
      assert.equal((await execute(keys.tidNow(), { kind: "inviteMember", subject: extraMember.did })).operation?.state, "completed");
      assert.equal((await execute(keys.tidNow(), { kind: "removeMember", subject: extraMember.did })).operation?.state, "completed");

      // updateAppAccess asks for re-approval with nothing left pending in `operation`.
      const updateId = keys.tidNow();
      const updateReq = { kind: "updateAppAccess", subject: appTwo.did, channels: [{ skey: generalSkey, write: false }] };
      const refusedUpdate = await outcome(() => execute(updateId, updateReq));
      assert.equal(refusedUpdate.ok, false);
      assert.match(refusedUpdate.ok ? "" : refusedUpdate.error, /AuthoritySessionUnavailable.*approve its permission again/);
      assert.equal(getRawDb().prepare("SELECT 1 FROM operation WHERE operation_id = ?").get(updateId), undefined, "nothing left pending");

      // Introduce channel policy drift (stripping `member` grant on `#general`) -> `reconcileWorkspace` under `preR10Scope`
      // repairs `#general` policy and then surfaces `AuthoritySessionUnavailable` when reaching missing `app.inbox` spaces!
      await updateOpenSocialSpacePolicy(await restoreAuthorityGrant(group.groupDid), created.channel, {
        $type: OPENSOCIAL_POLICY,
        publicRead: false,
        unlisted: false,
        grants: [{ role: "admin", read: true, write: true }],
      });
      const reconcileAttempt = await outcome(() => execute(keys.tidNow(), { kind: "reconcileWorkspace" }));
      assert.equal(reconcileAttempt.ok, false);
      assert.match(reconcileAttempt.ok ? "" : reconcileAttempt.error, /AuthoritySessionUnavailable.*approve its permission again/);
      const channelPolAfter = await getOpenSocialSpacePolicy(await restoreAuthorityGrant(group.groupDid), created.channel);
      assert.equal(
        channelPolAfter?.grants.some((g) => g.role === "member" && g.read && g.write),
        true,
        "channel policy drift repaired before reaching uncovered app.inbox creation",
      );

      // Re-approve full authority grant -> retrying `updateAppAccess` resumes pending reconcile AND completes `updateAppAccess`,
      // creating and registering both `appTwoInbox` and `appThreeInbox`!
      await storeGroupAuthorityGrant(pds, adminActor, group.groupDid, "r10-full-grant-after");
      assert.equal((await execute(updateId, updateReq)).operation?.state, "completed");
      const fullGrant = await restoreAuthorityGrant(group.groupDid);
      assert.equal(await appInboxState(fullGrant, appTwoInbox), "present");
      assert.equal(isRegisteredSpace(appTwoInbox), true);
      assert.equal(await appInboxState(fullGrant, appThreeInbox), "present");
      assert.equal(isRegisteredSpace(appThreeInbox), true);

      // Member writes a command to appTwo's newly created inbox and appTwo reads it.
      const cmdRkey = keys.tidNow();
      await sessionClient(memberTwoBrowser.session).procedure("com.atproto.space.createRecord", {
        space: appTwoInbox,
        repo: memberTwo.did,
        collection: "new.flock.app.command",
        rkey: cmdRkey,
        record: {
          $type: "new.flock.app.command",
          command: "ping",
          text: "",
          channel: created.channel,
          createdAt: new Date().toISOString(),
        },
      });
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const cred = await mintSpaceCredential(appTwoSession, appTwoInbox);
        const listed = await cred.client(pds.groupHostUrl).query<{ repos: Array<{ $type?: string; repo: string }> }>(
          "com.atproto.space.listWriters",
          { space: appTwoInbox, limit: 100 },
        );
        if (listed.repos.some((r) => r.$type === "com.atproto.space.defs#repoWrite" && r.repo === memberTwo.did)) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const appTwoCred = await mintSpaceCredential(appTwoSession, appTwoInbox);
      const readCmd = await appTwoCred.client(await resolvePds(memberTwo.did)).query<{ value: { command?: string } }>(
        "com.atproto.space.getRecord",
        { space: appTwoInbox, repo: memberTwo.did, collection: "new.flock.app.command", rkey: cmdRkey },
      );
      assert.equal(readCmd.value.command, "ping");
    });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    await pds.close();
  }
});

// R10a envelope gate: 20 active installs at a 200-person OpenSocial roster — reconcileWorkspace of 20 drifted inboxes,
// removeMember and inviteMember each finish within the three-minute operation run limit.
test("envelope: 20 active installs at a 200-person roster finish reconcileWorkspace (20 drifted inboxes), removeMember and inviteMember within the run limit (R10a)", { timeout: 20 * 60 * 1000 }, async (t) => {
  const pds = await startPdsNetwork("app-inboxes-envelope");
  try {
    const [
      { restoreAuthorityGrant },
      { createWorkspace },
      { executeOperatorOperation },
      { registrationDeps },
      { parseWorkspaceRef },
      { sessionClient },
      { putAuthorityRecord },
      { humanMemberDids, liveSpaceAccess, readGroupGovernanceState },
      { mapLimited },
      keys,
      { OPENSOCIAL_COLLECTION },
    ] = await Promise.all([
      import("@flock/operator/operator/authority-grant"),
      import("@flock/operator/operator/kinds/create-workspace"),
      import("@flock/operator/operator/operations"),
      import("@flock/operator/operator/registrations"),
      import("@flock/operator/operator/actor"),
      import("@flock/operator/atproto/client"),
      import("@flock/operator/atproto/space-ops"),
      import("@flock/operator/operator/workspace-state"),
      import("@flock/protocol/map-limited"),
      import("@flock/protocol/keys"),
      import("@flock/protocol/nsids"),
    ]);

    const owner = await pds.createActor("r10envowner", 0);
    const group = await createOpenSocialGroup(pds, owner, { name: "Envelope Inboxes", keyLabel: "r10-env-grant" });
    const grant = await restoreAuthorityGrant(group.groupDid);
    const created = await createWorkspace(grant, {
      creator: owner.did,
      name: "Envelope Inboxes",
      operationId: keys.tidNow(),
    });
    assert.equal(created.state, "completed");
    const workspace = parseWorkspaceRef(created.workspace);
    const generalSkey = created.channel.split("/").at(-1)!;
    const nowIso = new Date().toISOString();

    // 199 non-owner human members (+ owner = 200 roster members) and 20 pre-R10 installs (missing inboxes = 20 drifted inboxes).
    const people = await mapLimited(Array.from({ length: 199 }, (_, idx) => idx), 8, (idx) =>
      pds.createActor(`r10p${String(idx).padStart(3, "0")}`, idx % 2 === 0 ? 0 : 1),
    );
    await sessionClient(grant).procedure("com.atproto.space.applyWrites", {
      space: keys.groupMembersUri(group.groupDid),
      repo: group.groupDid,
      writes: people.map((person) => ({
        $type: "com.atproto.space.applyWrites#create",
        collection: OPENSOCIAL_COLLECTION.membership,
        rkey: person.did,
        value: {
          $type: OPENSOCIAL_COLLECTION.membership,
          roles: ["member"],
          createdAt: nowIso,
        },
      })),
    });

    const apps = await mapLimited(Array.from({ length: 20 }, (_, idx) => idx), 8, (idx) =>
      pds.createActor(`r10bot${String(idx).padStart(2, "0")}`, idx % 2 === 0 ? 0 : 1),
    );
    await mapLimited(apps, 8, (app) =>
      putAuthorityRecord(grant, created.workspace, "new.flock.app.install", keys.subjectKey(app.did), {
        subject: app.did,
        active: true,
        channels: [{ skey: generalSkey, write: true }],
        installedBy: owner.did,
        installedAt: nowIso,
        updatedAt: nowIso,
      }).then(() => undefined),
    );

    const admin = { did: owner.did, session: grant, workspace, canRecoverOperations: true };
    const LIMIT_MS = 3 * 60_000;

    const tReconcile = Date.now();
    const reconcile = await executeOperatorOperation(admin, keys.tidNow(), { kind: "reconcileWorkspace" }, registrationDeps);
    const reconcileMs = Date.now() - tReconcile;
    t.diagnostic(`reconcileWorkspace (20 drifted inboxes, 200-person roster): ${reconcileMs} ms (state=${reconcile.state})`);
    assert.equal(reconcile.state, "completed", JSON.stringify(reconcile));
    assert.ok(reconcileMs < LIMIT_MS, `reconcileWorkspace took ${reconcileMs} ms, within ${LIMIT_MS} ms`);

    const targetPerson = people[0]!;
    const tRemove = Date.now();
    const remove = await executeOperatorOperation(
      admin,
      keys.tidNow(),
      { kind: "removeMember", subject: targetPerson.did },
      registrationDeps,
    );
    const removeMs = Date.now() - tRemove;
    t.diagnostic(`removeMember (20 active inboxes, 200-person roster): ${removeMs} ms (state=${remove.state})`);
    assert.equal(remove.state, "completed", JSON.stringify(remove));
    assert.ok(removeMs < LIMIT_MS, `removeMember took ${removeMs} ms, within ${LIMIT_MS} ms`);

    const tInvite = Date.now();
    const invite = await executeOperatorOperation(
      admin,
      keys.tidNow(),
      { kind: "inviteMember", subject: targetPerson.did },
      registrationDeps,
    );
    const inviteMs = Date.now() - tInvite;
    t.diagnostic(`inviteMember (20 active inboxes, 200-person roster): ${inviteMs} ms (state=${invite.state})`);
    assert.equal(invite.state, "completed", JSON.stringify(invite));
    assert.ok(inviteMs < LIMIT_MS, `inviteMember took ${inviteMs} ms, within ${LIMIT_MS} ms`);

    const firstInbox = keys.appInboxUri(group.groupDid, workspace.skey, apps[0]!.did);
    const state = await readGroupGovernanceState(grant, group.groupDid);
    assert.equal(humanMemberDids(state, group.groupDid).size, 200, "200 active human members");
    assert.deepEqual(liveSpaceAccess(state, group.groupDid, firstInbox, apps[0]!.did), { read: true, write: false });
    assert.deepEqual(liveSpaceAccess(state, group.groupDid, firstInbox, targetPerson.did), { read: false, write: true });
  } finally {
    await pds.close();
  }
});
