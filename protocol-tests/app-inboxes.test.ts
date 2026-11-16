import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { callOperatorMethod, combinedMemberScopes, mintAppSession, mintBrowserSession, outcome, startPdsNetwork, storeAuthorityGrant, type PdsNetwork } from "./support/pds-network";

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

async function runReconcileCli(pds: PdsNetwork): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", "apps/operator/scripts/reconcile-workspaces.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_PATH: pds.databasePath },
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

// R10a gate (`.ai/plans/r10-interactions-progress.md`): per-install app inboxes on the real two-host PDS network.
test("app inboxes on the pinned PDS: member command writes, app-only reads, removal, uninstall, pre-R10 installs and grants (R10a)", { timeout: 10 * 60 * 1000 }, async (t) => {
  const pds = await startPdsNetwork("app-inboxes");
  const stateDir = mkdtempSync(join(tmpdir(), "r10a-app-state-"));
  try {
    const [
      { authorityClientMetadata, restoreAuthorityGrant },
      { grantCreationAuthorization },
      { createWorkspace },
      { mintSpaceCredential },
      { isAccessLost },
      { sessionClient },
      { resolvePds },
      { appInboxState, listSpaceMembers, putAuthorityRecord, putSpaceMember },
      { isRegisteredSpace },
      { getRawDb },
      keys,
    ] = await Promise.all([
      import("@flock/operator/operator/authority-grant"),
      import("@flock/operator/operator/creation-authorization"),
      import("@flock/operator/operator/kinds/create-workspace"),
      import("@flock/operator/atproto/space-credential"),
      import("@flock/protocol/atproto/space-credential-core"),
      import("@flock/operator/atproto/client"),
      import("@flock/operator/atproto/identity"),
      import("@flock/operator/atproto/space-ops"),
      import("@flock/operator/operator/member-access"),
      import("@flock/operator/lib/db"),
      import("@flock/protocol/keys"),
    ]);

    // Dedicated workspace account (host 0), creator/non-authority admin (host 1), two members (hosts 0 and 1), and two apps (host 1).
    const authority = await pds.createActor("r10auth", 0);
    const adminActor = await pds.createActor("r10admin", 1);
    const memberOne = await pds.createActor("r10m1", 0);
    const memberTwo = await pds.createActor("r10m2", 1);
    const appOne = await pds.createActor("r10app1", 1);
    const appTwo = await pds.createActor("r10app2", 1);

    await storeAuthorityGrant(pds.hosts[0], authority.did, "r10-auth-grant");
    grantCreationAuthorization({ authorityDid: authority.did, initiatorDid: adminActor.did, name: "Interactions" }, Math.floor(Date.now() / 1000));
    const created = await createWorkspace(await restoreAuthorityGrant(authority.did), {
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
    const appOneSession = await mintAppSession(appOne.pds, appOne.did, {
      serviceRef: pds.serviceRef, plcUrl: pds.plcUrl, stateFile: join(stateDir, "app1.json"),
    }, "r10-app1-dpop");
    const appTwoSession = await mintAppSession(appTwo.pds, appTwo.did, {
      serviceRef: pds.serviceRef, plcUrl: pds.plcUrl, stateFile: join(stateDir, "app2.json"),
    }, "r10-app2-dpop");

    const execute = (operationId: string, request: Record<string, unknown>) =>
      callOperatorMethod(adminBrowser.session, pds.serviceRef, "new.flock.operator.execute", {}, {
        workspace: created.workspace, operationId, request,
      }) as Promise<{ operation?: { state?: string } }>;

    assert.equal((await execute(keys.tidNow(), { kind: "inviteMember", subject: memberOne.did })).operation?.state, "completed");
    assert.equal((await execute(keys.tidNow(), { kind: "inviteMember", subject: memberTwo.did })).operation?.state, "completed");
    assert.equal((await execute(keys.tidNow(), {
      kind: "installApp", subject: appOne.did, channels: [{ skey: generalSkey, write: true }],
    })).operation?.state, "completed");

    const appOneInbox = keys.appInboxUri(authority.did, workspaceSkey, appOne.did);

    const inboxWriters = async (inbox: string) => {
      const cred = await mintSpaceCredential(appOneSession, inbox);
      const listed = await cred.client(authority.pds.url).query<{ repos: Array<{ did: string }> }>("com.atproto.space.listRepos", { space: inbox, limit: 100 });
      return listed.repos.map((repo) => repo.did);
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

      // Both another member and the non-authority admin are refused at the host (and lack read scope on their browser grant).
      for (const [label, session, actor] of [
        ["second member", memberTwoBrowser.session, memberTwo],
        ["non-authority admin", adminBrowser.session, adminActor],
      ] as const) {
        const browserRefusal = await mintSpaceCredential(session, appOneInbox).then(() => null, (err: unknown) => err);
        assert.ok(browserRefusal, `${label} browser session is refused`);
        // Even with a session holding read scope (simulated via app grant shape), the authority's member list refuses them!
        const readScoped = await mintAppSession(actor.pds, actor.did, {
          serviceRef: pds.serviceRef, plcUrl: pds.plcUrl, stateFile: join(stateDir, `${actor.handle}.json`),
        }, `r10-readprobe-${actor.handle}`);
        const hostRefusal = await mintSpaceCredential(readScoped, appOneInbox).then(() => null, (err: unknown) => err);
        assert.ok(hostRefusal && isAccessLost(hostRefusal), `${label} is refused by the authority's member list: ${String(hostRefusal)}`);
        const feed = await callOperatorMethod(session, pds.serviceRef, "new.flock.operator.getChanges", {}, {
          follow: [{ space: appOneInbox, after: "0" }],
        }) as { denied: string[] };
        assert.deepEqual(feed.denied, [appOneInbox], `${label} is denied by getChanges`);
      }

      // The installed app is admitted by getChanges.
      const appFeed = await callOperatorMethod(appOneSession, pds.serviceRef, "new.flock.operator.getChanges", {}, { follow: [] }) as { head: string };
      assert.ok(typeof appFeed.head === "string");
    });

    await t.test("a person removed from the workspace is no longer listed as a writer in the app inbox", async () => {
      assert.equal((await execute(keys.tidNow(), { kind: "removeMember", subject: memberOne.did })).operation?.state, "completed");
      await waitForWriter(() => inboxWriters(appOneInbox), memberOne.did, false);
      const listed = await listSpaceMembers(await restoreAuthorityGrant(authority.did), appOneInbox);
      assert.equal(listed.some((m) => m.did === memberOne.did), false);
    });

    await t.test("after an uninstall the inbox list is empty, its registration gone, and the app refused by getChanges and the host", async () => {
      const { head } = await callOperatorMethod(appOneSession, pds.serviceRef, "new.flock.operator.getChanges", {}, { follow: [] }) as { head: string };
      assert.equal((await execute(keys.tidNow(), { kind: "uninstallApp", subject: appOne.did })).operation?.state, "completed");

      const listed = await listSpaceMembers(await restoreAuthorityGrant(authority.did), appOneInbox);
      assert.deepEqual(listed, []);
      assert.equal(isRegisteredSpace(appOneInbox), false, "notice registration dropped");

      const feed = await callOperatorMethod(appOneSession, pds.serviceRef, "new.flock.operator.getChanges", {}, {
        follow: [{ space: appOneInbox, after: head }],
      }) as { denied: string[] };
      assert.deepEqual(feed.denied, [appOneInbox]);

      const refusal = await mintSpaceCredential(appOneSession, appOneInbox).then(() => null, (err: unknown) => err);
      assert.ok(refusal && isAccessLost(refusal), `uninstalled app refused a credential: ${String(refusal)}`);
    });

    await t.test("pre-R10 installs and pre-R10 authority grants reconcile, warn, re-approve on updateAppAccess, and create remaining inboxes", async () => {
      // Seed two pre-R10 active installs directly (install records + workspace/channel membership, no app.inbox spaces).
      const grant = await restoreAuthorityGrant(authority.did);
      const nowIso = new Date().toISOString();
      const appThree = await pds.createActor("r10app3", 0);
      for (const app of [appTwo, appThree]) {
        await putAuthorityRecord(grant, created.workspace, "new.flock.app.install", keys.subjectKey(app.did), {
          subject: app.did,
          active: true,
          channels: [{ skey: generalSkey, write: true }],
          installedBy: adminActor.did,
          installedAt: nowIso,
          updatedAt: nowIso,
        });
        await putSpaceMember(grant, created.workspace, app.did, true, false);
        await putSpaceMember(grant, created.channel, app.did, true, true);
      }
      const appTwoInbox = keys.appInboxUri(authority.did, workspaceSkey, appTwo.did);
      const appThreeInbox = keys.appInboxUri(authority.did, workspaceSkey, appThree.did);
      assert.equal(await appInboxState(grant, appTwoInbox), "missing");

      // Store a pre-R10 authority grant (lacks space:new.flock.app.inbox).
      const preR10Scope = authorityClientMetadata().scope.split(" ")
        .filter((scope) => !scope.startsWith("space:new.flock.app.inbox?"))
        .join(" ");
      assert.notEqual(preR10Scope, authorityClientMetadata().scope);
      await storeAuthorityGrant(pds.hosts[0], authority.did, "r10-prer10-grant", { scope: preR10Scope });

      // Under the pre-R10 grant: invite and removal complete, scheduled reconcile completes and warns, updateAppAccess asks for re-approval with nothing written.
      const extraMember = await pds.createActor("r10extra", 0);
      assert.equal((await execute(keys.tidNow(), { kind: "inviteMember", subject: extraMember.did })).operation?.state, "completed");
      assert.equal((await execute(keys.tidNow(), { kind: "removeMember", subject: extraMember.did })).operation?.state, "completed");

      const job = await runReconcileCli(pds);
      assert.equal(job.exitCode, 0, `reconcile stderr: ${job.stderr}`);
      assert.match(job.stdout, new RegExp(`${created.workspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: completed`));
      assert.match(job.stderr, /WARN .*must approve its permission again/);

      const updateId = keys.tidNow();
      const updateReq = { kind: "updateAppAccess", subject: appTwo.did, channels: [{ skey: generalSkey, write: false }] };
      const refusedUpdate = await outcome(() => execute(updateId, updateReq));
      assert.equal(refusedUpdate.ok, false);
      assert.match(refusedUpdate.ok ? "" : refusedUpdate.error, /AuthoritySessionUnavailable.*approve its permission again/);
      assert.equal(getRawDb().prepare("SELECT 1 FROM operation WHERE operation_id = ?").get(updateId), undefined, "nothing left pending");

      // Re-approve full R10 authority grant, retry the same updateAppAccess -> creates, fills and registers appTwo's inbox.
      await storeAuthorityGrant(pds.hosts[0], authority.did, "r10-full-grant-after");
      assert.equal((await execute(updateId, updateReq)).operation?.state, "completed");
      const fullGrant = await restoreAuthorityGrant(authority.did);
      assert.equal(await appInboxState(fullGrant, appTwoInbox), "present");
      assert.equal(isRegisteredSpace(appTwoInbox), true);

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
        const listed = await cred.client(authority.pds.url).query<{ repos: Array<{ did: string }> }>("com.atproto.space.listRepos", { space: appTwoInbox, limit: 100 });
        if (listed.repos.some((r) => r.did === memberTwo.did)) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const appTwoCred = await mintSpaceCredential(appTwoSession, appTwoInbox);
      const readCmd = await appTwoCred.client(await resolvePds(memberTwo.did)).query<{ value: { command?: string } }>(
        "com.atproto.space.getRecord",
        { space: appTwoInbox, repo: memberTwo.did, collection: "new.flock.app.command", rkey: cmdRkey },
      );
      assert.equal(readCmd.value.command, "ping");

      // Next reconcile creates and registers the inbox of the other pre-R10 install (appThree).
      assert.equal(await appInboxState(fullGrant, appThreeInbox), "missing");
      assert.equal((await execute(keys.tidNow(), { kind: "reconcileWorkspace" })).operation?.state, "completed");
      assert.equal(await appInboxState(fullGrant, appThreeInbox), "present");
      assert.equal(isRegisteredSpace(appThreeInbox), true);
    });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    await pds.close();
  }
});

// R10a envelope gate: 20 active installs at a 200-person roster — reconcileWorkspace of 20 drifted inboxes, removeMember and
// inviteMember each finish within the three-minute operation run limit.
test("envelope: 20 active installs at a 200-person roster finish reconcileWorkspace (20 drifted inboxes), removeMember and inviteMember within the run limit (R10a)", { timeout: 20 * 60 * 1000 }, async (t) => {
  const pds = await startPdsNetwork("app-inboxes-envelope");
  try {
    const [
      { restoreAuthorityGrant },
      { createWorkspace },
      { executeOperatorOperation },
      { registrationDeps },
      { parseWorkspaceRef },
      { listSpaceMembers, putAuthorityRecord, putSpaceMember },
      { mapLimited },
      keys,
    ] = await Promise.all([
      import("@flock/operator/operator/authority-grant"),
      import("@flock/operator/operator/kinds/create-workspace"),
      import("@flock/operator/operator/operations"),
      import("@flock/operator/operator/registrations"),
      import("@flock/operator/operator/actor"),
      import("@flock/operator/atproto/space-ops"),
      import("@flock/protocol/map-limited"),
      import("@flock/protocol/keys"),
    ]);

    const owner = await pds.createActor("r10envowner", 0);
    await storeAuthorityGrant(pds.hosts[0], owner.did, "r10-env-grant");
    const grant = await restoreAuthorityGrant(owner.did);
    const created = await createWorkspace(grant, { creator: owner.did, name: "Envelope Inboxes", operationId: keys.tidNow() });
    assert.equal(created.state, "completed");
    const workspace = parseWorkspaceRef(created.workspace);
    const inbox = keys.inboxUri(owner.did, workspace.skey);
    const generalSkey = created.channel.split("/").at(-1)!;
    const nowIso = new Date().toISOString();

    // 199 non-owner members (+ owner = 200 roster members) and 20 pre-R10 installs (missing inboxes = 20 drifted inboxes).
    const people = await mapLimited(Array.from({ length: 199 }, (_, idx) => idx), 8, (idx) =>
      pds.createActor(`r10p${String(idx).padStart(3, "0")}`, idx % 2 === 0 ? 0 : 1));
    await mapLimited(people.flatMap((person) => [
      () => putSpaceMember(grant, created.workspace, person.did, true, true),
      () => putSpaceMember(grant, inbox, person.did, false, true),
      () => putSpaceMember(grant, created.channel, person.did, true, true),
      () => putAuthorityRecord(grant, created.workspace, "new.flock.workspace.roster", keys.subjectKey(person.did), {
        subject: person.did, active: true, updatedAt: nowIso,
      }).then(() => undefined),
    ]), 8, (task) => task());

    const apps = await mapLimited(Array.from({ length: 20 }, (_, idx) => idx), 8, (idx) =>
      pds.createActor(`r10bot${String(idx).padStart(2, "0")}`, idx % 2 === 0 ? 0 : 1));
    await mapLimited(apps.flatMap((app) => [
      () => putSpaceMember(grant, created.workspace, app.did, true, false),
      () => putSpaceMember(grant, created.channel, app.did, true, true),
      () => putAuthorityRecord(grant, created.workspace, "new.flock.app.install", keys.subjectKey(app.did), {
        subject: app.did, active: true, channels: [{ skey: generalSkey, write: true }], installedBy: owner.did, installedAt: nowIso, updatedAt: nowIso,
      }).then(() => undefined),
    ]), 8, (task) => task());

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
    const remove = await executeOperatorOperation(admin, keys.tidNow(), { kind: "removeMember", subject: targetPerson.did }, registrationDeps);
    const removeMs = Date.now() - tRemove;
    t.diagnostic(`removeMember (20 active inboxes, 200-person roster): ${removeMs} ms (state=${remove.state})`);
    assert.equal(remove.state, "completed", JSON.stringify(remove));
    assert.ok(removeMs < LIMIT_MS, `removeMember took ${removeMs} ms, within ${LIMIT_MS} ms`);

    const tInvite = Date.now();
    const invite = await executeOperatorOperation(admin, keys.tidNow(), { kind: "inviteMember", subject: targetPerson.did }, registrationDeps);
    const inviteMs = Date.now() - tInvite;
    t.diagnostic(`inviteMember (20 active inboxes, 200-person roster): ${inviteMs} ms (state=${invite.state})`);
    assert.equal(invite.state, "completed", JSON.stringify(invite));
    assert.ok(inviteMs < LIMIT_MS, `inviteMember took ${inviteMs} ms, within ${LIMIT_MS} ms`);

    const firstInbox = keys.appInboxUri(owner.did, workspace.skey, apps[0]!.did);
    const listed = await listSpaceMembers(grant, firstInbox);
    assert.equal(listed.length, 200, "199 non-authority roster members + 1 app");
  } finally {
    await pds.close();
  }
});
