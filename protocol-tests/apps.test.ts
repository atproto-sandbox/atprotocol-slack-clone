import assert from "node:assert/strict";
import test from "node:test";
import { callOperatorMethod, combinedMemberScopes, mintBrowserSession, outcome, startPdsNetwork, storeAuthorityGrant } from "./support/pds-network";

// R9 (`.ai/plans/r9-apps-progress.md`): an app installed in a workspace on the real PDS network. It is an account holding its
// own OAuth session; its access is its install record, which the operator turns into member-list entries and takes back.
test("apps at the pinned PDS: installed after reauthorizing, reading only what is granted, and losing access on uninstall (R9)", async (t) => {
  const pds = await startPdsNetwork("apps");
  try {
    const [{ restoreAuthorityGrant }, { createWorkspace }, { mintSpaceCredential }, { isAccessLost }, { sessionClient }, { resolvePds }, { listSpaceMembers }, keys, { getRawDb }] = await Promise.all([
      import("@flock/operator/operator/authority-grant"), import("@flock/operator/operator/kinds/create-workspace"), import("@flock/operator/atproto/space-credential"),
      import("@flock/protocol/atproto/space-credential-core"), import("@flock/operator/atproto/client"), import("@flock/operator/atproto/identity"),
      import("@flock/operator/atproto/space-ops"), import("@flock/protocol/keys"), import("@flock/operator/lib/db"),
    ]);
    // given a workspace with a second public channel, an admin's browser session, and an app account holding its own OAuth
    // session; and then an authority grant whose consent left out the workspace records' permission, the install record's
    // with them (the pinned provider issues only scope strings the client declares, so a grant from before the install
    // collection was added cannot be minted again; this is the same refusal for the same first step)
    const owner = await pds.createActor("r9owner", 0);
    const { authorityClientMetadata } = await import("@flock/operator/operator/authority-grant");
    const withoutWorkspaceRecords = authorityClientMetadata().scope.split(" ")
      .filter((scope) => !(scope.startsWith("space:new.flock.workspace?") && scope.includes("collection=new.flock.app.install"))
        && !scope.startsWith("space:new.flock.app.inbox?"))
      .join(" ");
    assert.notEqual(withoutWorkspaceRecords, authorityClientMetadata().scope, "the narrower grant lacks the install collection");
    await storeAuthorityGrant(pds.hosts[0], owner.did, "r9-grant-dpop");
    const created = await createWorkspace(await restoreAuthorityGrant(owner.did), { creator: owner.did, name: "Apps", operationId: keys.tidNow() });
    assert.equal(created.state, "completed");
    const scopes = await combinedMemberScopes(pds.serviceRef);
    const admin = await mintBrowserSession(owner.pds, owner.did, scopes, "r9-owner-dpop");
    const execute = (operationId: string, request: Record<string, unknown>) =>
      callOperatorMethod(admin.session, pds.serviceRef, "new.flock.operator.execute", {}, { workspace: created.workspace, operationId, request }) as Promise<{ operation?: { state?: string } }>;
    const otherSkey = `${keys.parseWorkspaceUri(created.workspace)!.skey}-other`;
    assert.equal((await execute(keys.tidNow(), { kind: "createChannel", skey: "other", name: "other", visibility: "public" })).operation?.state, "completed");
    const other = keys.channelUri(owner.did, otherSkey);
    await storeAuthorityGrant(pds.hosts[0], owner.did, "r9-grant-narrower-dpop", { scope: withoutWorkspaceRecords });
    const generalSkey = created.channel.split("/").at(-1)!;
    const app = await pds.createActor("r9app", 1);
    const appGrant = await mintBrowserSession(app.pds, app.did, scopes, "r9-app-dpop");
    const install = { kind: "installApp", subject: app.did, channels: [{ skey: generalSkey, write: true }] };
    const installId = keys.tidNow();

    await t.test("installing with the narrower grant asks the account to approve again, leaves no row, and the same operation succeeds after", async () => {
      // when the admin installs the app, the account approves the current grant, and the admin retries the same operation
      const first = await outcome(() => execute(installId, install));
      const rowAfterRefusal = getRawDb().prepare("SELECT 1 FROM operation WHERE operation_id = ?").get(installId);
      await storeAuthorityGrant(pds.hosts[0], owner.did, "r9-grant-with-apps-dpop");
      const retried = await execute(installId, install);

      // then the first is refused as needing approval, with nothing journaled, and the retry installs the app
      assert.equal(first.ok, false);
      // (execute answers a grant short of a scope as it always has: the app's approval path takes this answer)
      assert.match(first.ok ? "" : first.error, /AuthoritySessionUnavailable.*approve its permission again/, JSON.stringify(first));
      assert.equal(rowAfterRefusal, undefined);
      assert.equal(retried.operation?.state, "completed");
    });

    await t.test("the app reads and writes the channel it is granted, and the authority refuses it one it is not", async () => {
      const credential = await mintSpaceCredential(appGrant.session, created.channel);
      const rkey = keys.tidNow();
      await sessionClient(appGrant.session).procedure("com.atproto.space.createRecord", {
        space: created.channel, repo: app.did, collection: "new.flock.channel.message", rkey, record: { $type: "new.flock.channel.message", text: "hello from an app", createdAt: new Date().toISOString() },
      });
      const read = await credential.client(await resolvePds(app.did)).query<{ value: { text?: string } }>("com.atproto.space.getRecord", {
        space: created.channel, repo: app.did, collection: "new.flock.channel.message", rkey,
      });
      assert.equal(read.value.text, "hello from an app");
      const refusal = await mintSpaceCredential(appGrant.session, other).then(() => null, (error: unknown) => error);
      assert.ok(refusal && isAccessLost(refusal), `the authority refuses a channel the app was not granted: ${String(refusal)}`);
    });

    await t.test("an app that may only read writes nothing readers see: the authority lists it as no writer, in a channel it reads or the workspace space", async () => {
      // given the app a listed writer of #general (its write above), and then its grant there made read only
      const writers = async (space: string) => {
        const credential = await mintSpaceCredential(await restoreAuthorityGrant(owner.did), space);
        const listed = await credential.client(owner.pds.url).query<{ repos: Array<{ $type?: string; repo: string }> }>(
          "com.atproto.space.listWriters",
          { space, limit: 100 },
        );
        return listed.repos
          .filter((entry) => entry.$type === "com.atproto.space.defs#repoWrite")
          .map((entry) => entry.repo);
      };
      // The authority lists a writer once the writer's host has delivered the write notice, which is asynchronous.
      for (let attempt = 0; !(await writers(created.channel)).includes(app.did); attempt += 1) {
        assert.ok(attempt < 40, "the app is listed as a writer while it may write");
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      assert.equal((await execute(keys.tidNow(), { kind: "updateAppAccess", subject: app.did, channels: [{ skey: generalSkey, write: false }] })).operation?.state, "completed");

      // when it writes a message in #general, and in the workspace space the one record a member writes there (an
      // acceptance), each into its own repo
      await sessionClient(appGrant.session).procedure("com.atproto.space.createRecord", {
        space: created.channel, repo: app.did, collection: "new.flock.channel.message", rkey: keys.tidNow(), record: { $type: "new.flock.channel.message", text: "may I?", createdAt: new Date().toISOString() },
      });
      await sessionClient(appGrant.session).procedure("com.atproto.space.putRecord", {
        space: created.workspace, repo: app.did, collection: "new.flock.acceptance", rkey: keys.acceptanceRecordKey(created.workspace), record: { $type: "new.flock.acceptance", workspace: created.workspace, createdAt: new Date().toISOString() },
      });
      await new Promise((resolve) => setTimeout(resolve, 3_000));

      // then the authority lists it as a writer of neither, so no reader syncs those records, and it still reads #general
      assert.equal((await writers(created.channel)).includes(app.did), false, "no longer a writer of the channel it reads");
      assert.equal((await writers(created.workspace)).includes(app.did), false, "never a writer of the workspace space");
      await mintSpaceCredential(appGrant.session, created.channel);
    });

    await t.test("after uninstallApp the app is in no member list, is denied by getChanges at once, and is refused its next credential", async (st) => {
      // given a credential the app holds from before the uninstall
      const held = await mintSpaceCredential(appGrant.session, created.channel);
      const { head } = await callOperatorMethod(appGrant.session, pds.serviceRef, "new.flock.operator.getChanges", {}, { follow: [] }) as { head: string };

      // when the admin uninstalls it
      assert.equal((await execute(keys.tidNow(), { kind: "uninstallApp", subject: app.did })).operation?.state, "completed");

      // then it is in no list, the feed denies it at once, and the authority refuses it a credential
      const grant = await restoreAuthorityGrant(owner.did);
      const appInbox = keys.appInboxUri(owner.did, keys.parseWorkspaceUri(created.workspace)!.skey, app.did);
      for (const space of [created.workspace, created.channel, other, appInbox]) {
        assert.equal((await listSpaceMembers(grant, space)).some((member) => member.did === app.did), false, `not in ${space}`);
      }
      const started = Date.now();
      const changes = await callOperatorMethod(appGrant.session, pds.serviceRef, "new.flock.operator.getChanges", {}, { follow: [{ space: created.channel, after: head }] }) as { denied: string[] };
      assert.deepEqual(changes.denied, [created.channel]);
      assert.ok(Date.now() - started < 5_000, "denied without waiting for a change");
      const refusal = await mintSpaceCredential(appGrant.session, created.channel).then(() => null, (error: unknown) => error);
      assert.ok(refusal && isAccessLost(refusal), `its next credential is refused: ${String(refusal)}`);

      // and the credential it already held is measured: whether it still reads, and how long it has left
      // and the credential it already held still reads until it expires, ten minutes after it was issued, which is what
      // docs/operations.md tells an operator about an uninstalled app
      const residual = await outcome(() => held.client(owner.pds.url).query("com.atproto.space.listWriters", { space: created.channel, limit: 1 }));
      const { exp, iat } = JSON.parse(Buffer.from(held.token.split(".")[1]!, "base64url").toString("utf8")) as { exp: number; iat: number };
      st.diagnostic(`a credential held before the uninstall ${residual.ok ? "still reads" : `is refused (${residual.error})`}; issued for ${exp - iat} s, it has ${Math.round(exp - Date.now() / 1000)} s left after the uninstall`);
      assert.equal(residual.ok, true, "a held credential outlives the uninstall");
      assert.equal(exp - iat, 600, "the pinned PDS issues ten-minute credentials");
    });
  } finally {
    await pds.close();
  }
});

// R9's envelope case: an app installed at exactly 200 people. The people are written directly into the roster and the lists,
// as the performance envelope does, since only the install and the reconcile after it are under test.
test("an app installs at exactly 200 people, and a reconcile then finds every list as the membership model expects (R9)", { timeout: 15 * 60 * 1000 }, async () => {
  const pds = await startPdsNetwork("apps-envelope");
  try {
    const [{ restoreAuthorityGrant }, { createWorkspace }, { executeOperatorOperation }, { parseWorkspaceRef }, { listSpaceMembers, putAuthorityRecord, putSpaceMembers }, keys, { mapLimited }] = await Promise.all([
      import("@flock/operator/operator/authority-grant"), import("@flock/operator/operator/kinds/create-workspace"), import("@flock/operator/operator/operations"),
      import("@flock/operator/operator/actor"), import("@flock/operator/atproto/space-ops"), import("@flock/protocol/keys"), import("@flock/protocol/map-limited"),
    ]);
    // given a workspace of 200 people: its account and 199 others, on the roster and in the workspace, inbox and #general lists
    const owner = await pds.createActor("r9envowner", 0);
    await storeAuthorityGrant(pds.hosts[0], owner.did, "r9-envelope-grant-dpop");
    const grant = await restoreAuthorityGrant(owner.did);
    const created = await createWorkspace(grant, { creator: owner.did, name: "Envelope Apps", operationId: keys.tidNow() });
    assert.equal(created.state, "completed");
    const workspace = parseWorkspaceRef(created.workspace);
    const inbox = keys.inboxUri(owner.did, workspace.skey);
    const people = await mapLimited(Array.from({ length: 199 }, (_, index) => index), 8, (index) => pds.createActor(`r9p${String(index).padStart(3, "0")}`, index % 2 === 0 ? 0 : 1));
    await putSpaceMembers(grant, created.workspace, people.map((person) => ({ did: person.did, read: true, write: true })));
    await putSpaceMembers(grant, inbox, people.map((person) => ({ did: person.did, read: false, write: true })));
    await putSpaceMembers(grant, created.channel, people.map((person) => ({ did: person.did, read: true, write: true })));
    await mapLimited(people, 8, (person) =>
      putAuthorityRecord(grant, created.workspace, "new.flock.workspace.roster", keys.subjectKey(person.did), { subject: person.did, active: true, updatedAt: new Date().toISOString() }).then(() => undefined));
    const app = await pds.createActor("r9envapp", 1);
    const admin = { did: owner.did, session: grant, workspace, canRecoverOperations: true };

    // when an admin installs the app with write in #general, and then reconciles the workspace
    const install = await executeOperatorOperation(admin, keys.tidNow(), { kind: "installApp", subject: app.did, channels: [{ skey: created.channel.split("/").at(-1)!, write: true }] });
    const reconcile = await executeOperatorOperation(admin, keys.tidNow(), { kind: "reconcileWorkspace" });

    // then both complete, the reconcile changing nothing, and the workspace and #general lists hold the 199 people and the app
    assert.equal(install.state, "completed", JSON.stringify(install));
    assert.equal(reconcile.state, "completed", JSON.stringify(reconcile));
    assert.deepEqual(reconcile.completedSteps.filter((step) => /-(set|remove)-/.test(step)), [], "every list already matches the model");
    for (const [space, write] of [[created.workspace, false], [created.channel, true]] as const) {
      const listed = await listSpaceMembers(grant, space);
      assert.equal(listed.length, 200, `${space}: the 199 people besides the account, and the app`);
      assert.ok(listed.some((member) => member.did === app.did && member.read && member.write === write), `${space}: the app with its grant`);
    }
  } finally {
    await pds.close();
  }
});
