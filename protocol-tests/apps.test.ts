import assert from "node:assert/strict";
import test from "node:test";
import {
  callOperatorMethod,
  combinedMemberScopes,
  createOpenSocialGroup,
  mintBrowserSession,
  outcome,
  startPdsNetwork,
  storeGroupAuthorityGrant,
} from "./support/pds-network";

// R9 / R13: an app installed in an OpenSocial group workspace on the real PDS network + Group Host. It is an account holding
// its own OAuth session; its access is governed by `new.flock.app.install` + OpenSocial `role/app-<hash>`, `membership/<appDid>`,
// and `group.opensocial.policy` grants, which the operator provisions and removes cleanly (`RoleInUse`-safe).
test("apps at the pinned PDS: installed after reauthorizing, reading only what is granted, and losing access on uninstall (R9)", async (t) => {
  const pds = await startPdsNetwork("apps");
  try {
    const [
      { restoreAuthorityGrant },
      { createWorkspace },
      { mintSpaceCredential },
      { isAccessLost },
      { sessionClient },
      { resolvePds },
      { liveSpaceAccess, readGroupGovernanceState },
      keys,
      { ATGRP_COLLECTION, ATGRP_PERMISSION_SET, SPACE_TYPE },
      { getRawDb },
    ] = await Promise.all([
      import("@flock/operator/operator/authority-grant"),
      import("@flock/operator/operator/kinds/create-workspace"),
      import("@flock/operator/atproto/space-credential"),
      import("@flock/protocol/atproto/space-credential-core"),
      import("@flock/operator/atproto/client"),
      import("@flock/operator/atproto/identity"),
      import("@flock/operator/operator/workspace-state"),
      import("@flock/protocol/keys"),
      import("@flock/protocol/nsids"),
      import("@flock/operator/lib/db"),
    ]);

    const owner = await pds.createActor("r9owner", 0);
    // Narrower Group-DID grant omitting `collection=new.flock.app.install` on `new.flock.workspace` and `space:new.flock.app.inbox`
    const withoutAppInstallScope = [
      "atproto",
      `include:${ATGRP_PERMISSION_SET.authManageAdmin}`,
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

    const group = await createOpenSocialGroup(pds, owner, { name: "Apps", keyLabel: "r9-grant-dpop" });
    const created = await createWorkspace(await restoreAuthorityGrant(group.groupDid), {
      creator: owner.did,
      name: "Apps",
      operationId: keys.tidNow(),
    });
    assert.equal(created.state, "completed");

    const scopes = await combinedMemberScopes(pds.serviceRef);
    const admin = await mintBrowserSession(owner.pds, owner.did, scopes, "r9-owner-dpop");
    const execute = (operationId: string, request: Record<string, unknown>) =>
      callOperatorMethod(admin.session, pds.serviceRef, "new.flock.operator.execute", {}, {
        workspace: created.workspace,
        operationId,
        request,
      }) as Promise<{ operation?: { state?: string } }>;

    assert.equal(
      (await execute(keys.tidNow(), { kind: "createChannel", skey: "other", name: "other", visibility: "public" })).operation?.state,
      "completed",
    );
    const other = keys.channelUri(group.groupDid, "other");
    await storeGroupAuthorityGrant(pds, owner, group.groupDid, "r9-grant-narrower-dpop", {
      scope: withoutAppInstallScope,
    });
    const generalSkey = created.channel.split("/").at(-1)!;
    const app = await pds.createActor("r9app", 1);
    const appGrant = await mintBrowserSession(app.pds, app.did, scopes, "r9-app-dpop");
    const install = { kind: "installApp", subject: app.did, channels: [{ skey: generalSkey, write: true }] };
    const installId = keys.tidNow();

    await t.test("installing with the narrower grant asks the account to approve again, leaves no row, and the same operation succeeds after", async () => {
      const first = await outcome(() => execute(installId, install));
      const rowAfterRefusal = getRawDb().prepare("SELECT 1 FROM operation WHERE operation_id = ?").get(installId);
      await storeGroupAuthorityGrant(pds, owner, group.groupDid, "r9-grant-with-apps-dpop");
      const retried = await execute(installId, install);

      assert.equal(first.ok, false);
      assert.match(first.ok ? "" : first.error, /AuthoritySessionUnavailable.*approve its permission again/, JSON.stringify(first));
      assert.equal(rowAfterRefusal, undefined);
      assert.equal(retried.operation?.state, "completed");
    });

    await t.test("the app reads and writes the channel it is granted, and the Group Host refuses it one it is not", async () => {
      const credential = await mintSpaceCredential(appGrant.session, created.channel);
      const rkey = keys.tidNow();
      await sessionClient(appGrant.session).procedure("com.atproto.space.createRecord", {
        space: created.channel,
        repo: app.did,
        collection: "new.flock.channel.message",
        rkey,
        record: { $type: "new.flock.channel.message", text: "hello from an app", createdAt: new Date().toISOString() },
      });
      const read = await credential.client(await resolvePds(app.did)).query<{ value: { text?: string } }>(
        "com.atproto.space.getRecord",
        {
          space: created.channel,
          repo: app.did,
          collection: "new.flock.channel.message",
          rkey,
        },
      );
      assert.equal(read.value.text, "hello from an app");
      const refusal = await mintSpaceCredential(appGrant.session, other).then(() => null, (error: unknown) => error);
      assert.ok(refusal && isAccessLost(refusal), `the Group Host refuses a channel the app was not granted: ${String(refusal)}`);
    });

    await t.test("an app that may only read writes nothing readers see: the Group Host lists it as no writer, in a channel it reads or members/workspace spaces", async () => {
      const writers = async (space: string) => {
        const credential = await mintSpaceCredential(await restoreAuthorityGrant(group.groupDid), space);
        const listed = await credential.client(pds.groupHostUrl).query<{ repos: Array<{ $type?: string; repo: string }> }>(
          "com.atproto.space.listWriters",
          { space, limit: 100 },
        );
        return listed.repos
          .filter((entry) => entry.$type === "com.atproto.space.defs#repoWrite")
          .map((entry) => entry.repo);
      };
      for (let attempt = 0; !(await writers(created.channel)).includes(app.did); attempt += 1) {
        assert.ok(attempt < 40, "the app is listed as a writer while it may write");
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      assert.equal(
        (await execute(keys.tidNow(), { kind: "updateAppAccess", subject: app.did, channels: [{ skey: generalSkey, write: false }] }))
          .operation?.state,
        "completed",
      );

      // When the app writes a message in #general and an acceptance in `members/self`, each into its own personal PDS repo,
      // Group Host rejects `notifyRepoUpdate` because the app holds only `read: true` (never `write: true`).
      await sessionClient(appGrant.session).procedure("com.atproto.space.createRecord", {
        space: created.channel,
        repo: app.did,
        collection: "new.flock.channel.message",
        rkey: keys.tidNow(),
        record: { $type: "new.flock.channel.message", text: "may I?", createdAt: new Date().toISOString() },
      });
      await sessionClient(appGrant.session).procedure("com.atproto.space.putRecord", {
        space: keys.groupMembersUri(group.groupDid),
        repo: app.did,
        collection: ATGRP_COLLECTION.confirmation,
        rkey: "self",
        record: { $type: ATGRP_COLLECTION.confirmation, createdAt: new Date().toISOString() },
      });
      await new Promise((resolve) => setTimeout(resolve, 2_000));

      assert.equal((await writers(created.channel)).includes(app.did), false, "no longer a writer of the channel it reads");
      assert.equal((await writers(created.workspace)).includes(app.did), false, "never a writer of the workspace space");
      assert.equal((await writers(keys.groupMembersUri(group.groupDid))).includes(app.did), false, "never a writer of members/self");
      await mintSpaceCredential(appGrant.session, created.channel);
    });

    await t.test("after uninstallApp the app has no OpenSocial role or access, is denied by getChanges at once, and is refused its next credential", async (st) => {
      const held = await mintSpaceCredential(appGrant.session, created.channel);
      const { head } = (await callOperatorMethod(appGrant.session, pds.serviceRef, "new.flock.operator.getChanges", {}, {
        follow: [],
      })) as { head: string };

      assert.equal((await execute(keys.tidNow(), { kind: "uninstallApp", subject: app.did })).operation?.state, "completed");

      const grant = await restoreAuthorityGrant(group.groupDid);
      const gov = await readGroupGovernanceState(grant, group.groupDid);
      assert.equal(gov.memberships.has(app.did), false, "app membership deleted");
      assert.equal(gov.roles.has(keys.appRoleKey(app.did)), false, "app role deleted");
      const appInbox = keys.appInboxUri(group.groupDid, "self", app.did);
      for (const space of [created.workspace, created.channel, other, appInbox]) {
        assert.deepEqual(
          liveSpaceAccess(gov, group.groupDid, space, app.did),
          { read: false, write: false },
          `no OpenSocial access in ${space}`,
        );
      }
      const started = Date.now();
      const changes = (await callOperatorMethod(appGrant.session, pds.serviceRef, "new.flock.operator.getChanges", {}, {
        follow: [{ space: created.channel, after: head }],
      })) as { denied: string[] };
      assert.deepEqual(changes.denied, [created.channel]);
      assert.ok(Date.now() - started < 5_000, "denied without waiting for a change");
      const refusal = await mintSpaceCredential(appGrant.session, created.channel).then(() => null, (error: unknown) => error);
      assert.ok(refusal && isAccessLost(refusal), `its next credential is refused: ${String(refusal)}`);

      // Wait briefly for asynchronous `notifyCredentialsRevoked` / residual check on Group Host
      const residual = await outcome(() =>
        held.client(pds.groupHostUrl).query("com.atproto.space.listWriters", { space: created.channel, limit: 1 }),
      );
      const { exp, iat } = JSON.parse(Buffer.from(held.token.split(".")[1]!, "base64url").toString("utf8")) as {
        exp: number;
        iat: number;
      };
      st.diagnostic(
        `a credential held before the uninstall ${residual.ok ? "still reads" : `is refused (${residual.error})`}; issued for ${exp - iat} s`,
      );
      assert.equal(exp - iat, 600, "the Group Host issues ten-minute credentials");
    });
  } finally {
    await pds.close();
  }
});

// R9's envelope case: an app installed at exactly 200 people on an OpenSocial group.
test("an app installs at exactly 200 people, and a reconcile then finds every OpenSocial policy and membership as expected (R9)", { timeout: 15 * 60 * 1000 }, async () => {
  const pds = await startPdsNetwork("apps-envelope");
  try {
    const [
      { restoreAuthorityGrant },
      { createWorkspace },
      { executeOperatorOperation },
      { parseWorkspaceRef },
      { sessionClient },
      { humanMemberDids, liveSpaceAccess, readGroupGovernanceState },
      keys,
      { ATGRP_COLLECTION },
      { mapLimited },
    ] = await Promise.all([
      import("@flock/operator/operator/authority-grant"),
      import("@flock/operator/operator/kinds/create-workspace"),
      import("@flock/operator/operator/operations"),
      import("@flock/operator/operator/actor"),
      import("@flock/operator/atproto/client"),
      import("@flock/operator/operator/workspace-state"),
      import("@flock/protocol/keys"),
      import("@flock/protocol/nsids"),
      import("@flock/protocol/map-limited"),
    ]);

    const owner = await pds.createActor("r9envowner", 0);
    const group = await createOpenSocialGroup(pds, owner, { name: "Envelope Apps", keyLabel: "r9-envelope-grant-dpop" });
    const grant = await restoreAuthorityGrant(group.groupDid);
    const created = await createWorkspace(grant, {
      creator: owner.did,
      name: "Envelope Apps",
      operationId: keys.tidNow(),
    });
    assert.equal(created.state, "completed");
    const workspace = parseWorkspaceRef(created.workspace);
    const nowIso = new Date().toISOString();

    // Seed 199 additional human members (+ owner = 200 human members) in `group.opensocial.members/self`
    const people = await mapLimited(Array.from({ length: 199 }, (_, index) => index), 8, (index) =>
      pds.createActor(`r9p${String(index).padStart(3, "0")}`, index % 2 === 0 ? 0 : 1),
    );
    await sessionClient(grant).procedure("com.atproto.space.applyWrites", {
      space: keys.groupMembersUri(group.groupDid),
      repo: group.groupDid,
      writes: people.map((person) => ({
        $type: "com.atproto.space.applyWrites#create",
        collection: ATGRP_COLLECTION.membership,
        rkey: person.did,
        value: {
          $type: ATGRP_COLLECTION.membership,
          roles: ["member"],
          createdAt: nowIso,
        },
      })),
    });

    const app = await pds.createActor("r9envapp", 1);
    const admin = { did: owner.did, session: grant, workspace, canRecoverOperations: true };

    const install = await executeOperatorOperation(admin, keys.tidNow(), {
      kind: "installApp",
      subject: app.did,
      channels: [{ skey: created.channel.split("/").at(-1)!, write: true }],
    });
    const reconcile = await executeOperatorOperation(admin, keys.tidNow(), { kind: "reconcileWorkspace" });

    assert.equal(install.state, "completed", JSON.stringify(install));
    assert.equal(reconcile.state, "completed", JSON.stringify(reconcile));

    const state = await readGroupGovernanceState(grant, group.groupDid);
    assert.equal(humanMemberDids(state, group.groupDid).size, 200, "200 active human members (owner + 199 people)");
    assert.equal(state.knownAppSubjects.has(app.did), true);
    assert.deepEqual(liveSpaceAccess(state, group.groupDid, created.workspace, app.did), { read: true, write: false });
    assert.deepEqual(liveSpaceAccess(state, group.groupDid, created.channel, app.did), { read: true, write: true });
    assert.deepEqual(liveSpaceAccess(state, group.groupDid, created.workspace, people[0]!.did), { read: true, write: false });
    assert.deepEqual(liveSpaceAccess(state, group.groupDid, created.channel, people[0]!.did), { read: true, write: true });
  } finally {
    await pds.close();
  }
});
