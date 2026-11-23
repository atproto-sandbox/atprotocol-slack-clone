import assert from "node:assert/strict";
import test from "node:test";
import {
  ageGroupSessionAtHost,
  ageProviderSession,
  callOperatorMethod,
  combinedMemberScopes,
  completeRealGroupOAuthFlow,
  createOpenSocialGroup,
  expireStoredSession,
  mintBrowserSession,
  outcome,
  startPdsNetwork,
  storeGroupAuthorityGrant,
  type BrowserSession,
  type NetworkActor,
  type Outcome,
  type PdsNetwork,
} from "./support/pds-network";

// R1 / R13 gate: Operator administers an OpenSocial group workspace with a dedicated Group-DID `authority_grant` on `GroupHost`,
// completely decoupled from any human admin's personal-PDS browser sign-in session. Signing out, signing in again in a second
// browser, or letting the creator's personal session expire never disrupts group administration for other admins; multiple
// OpenSocial groups can be created and administered; replaced grants cannot clobber newer approvals; and any active admin can
// reauthorize the Group-DID grant via their own personal PDS when the group session expires.

type Scenario = "signs out" | "signs in again in a second browser" | "lets the sign-in session pass its lifetime";

const FIFTEEN_DAYS_MS = 15 * 24 * 60 * 60 * 1000;
const THIRTY_ONE_DAYS_MS = 31 * 24 * 60 * 60 * 1000;

test("the OpenSocial group authority grant outlives the creator's personal sign-in session", async (t) => {
  const pds = await startPdsNetwork("authority-grant");
  try {
    for (const scenario of ["signs out", "signs in again in a second browser", "lets the sign-in session pass its lifetime"] as const) {
      await t.test(`admin operations keep working after the creator ${scenario}`, async (st) => {
        // given a group workspace created with the group authority grant, with a second admin, while its creator is signed in
        const workspace = await createWorkspaceWithSecondAdmin(pds, scenario);

        // when the creator's personal sign-in session changes
        await workspace.creatorEvent(scenario);

        // then every admin operation still succeeds
        const results = await adminOperations(pds, workspace);
        for (const [operation, result] of Object.entries(results)) {
          st.diagnostic(`${operation}: ${result.ok ? "ok" : result.error}`);
        }
        assert.deepEqual(
          Object.entries(results)
            .filter(([, result]) => !result.ok)
            .map(([operation]) => operation),
          [],
        );
      });
    }

    await t.test("a creator creates multiple distinct OpenSocial group workspaces with one personal browser session", async () => {
      const [{ tidNow }, { grantCreationAuthorization }] = await Promise.all([
        import("@flock/protocol/keys"),
        import("@flock/operator/operator/creation-authorization"),
      ]);
      const creatorActor = await pds.createActor("k1second-owner", 0);
      const browser = await mintBrowserSession(
        pds.hosts[0],
        creatorActor.did,
        await combinedMemberScopes(pds.serviceRef),
        "k1second-browser-dpop",
      );

      const groupOne = await createOpenSocialGroup(pds, creatorActor, { name: "K1 first", keyLabel: "k1second-g1-dpop" });
      grantCreationAuthorization(
        { authorityDid: groupOne.groupDid, initiatorDid: creatorActor.did, name: "K1 first" },
        Math.floor(Date.now() / 1000),
      );
      const first = await createWorkspace(pds, browser, "K1 first", tidNow(), groupOne.groupDid);

      const groupTwo = await createOpenSocialGroup(pds, creatorActor, { name: "K1 second", keyLabel: "k1second-g2-dpop" });
      grantCreationAuthorization(
        { authorityDid: groupTwo.groupDid, initiatorDid: creatorActor.did, name: "K1 second" },
        Math.floor(Date.now() / 1000),
      );
      const second = await createWorkspace(pds, browser, "K1 second", tidNow(), groupTwo.groupDid);

      assert.deepEqual([first.state, second.state], ["completed", "completed"]);
      assert.notEqual(groupOne.groupDid, groupTwo.groupDid);
      assert.notEqual(first.workspace, second.workspace);

      // 1 OpenSocial group == 1 Flock workspace (`new.flock.workspace/self`): creating another inside groupOne is refused
      grantCreationAuthorization(
        { authorityDid: groupOne.groupDid, initiatorDid: creatorActor.did, name: "K1 duplicate" },
        Math.floor(Date.now() / 1000),
      );
      const duplicate = await outcome(() => createWorkspace(pds, browser, "K1 duplicate", tidNow(), groupOne.groupDid));
      assert.equal(duplicate.ok, false);
      assert.match(duplicate.ok ? "" : duplicate.error, /WorkspaceExists|already exists/);
    });

    await t.test("a dedicated OpenSocial group is administered after both admins sign out, and reauthorized by the second admin when expired (R8)", async () => {
      const [{ parseWorkspaceUri, tidNow }, { grantCreationAuthorization }] = await Promise.all([
        import("@flock/protocol/keys"),
        import("@flock/operator/operator/creation-authorization"),
      ]);
      const creatorAccount = await pds.createActor("k8creator", 0);
      const second = await pds.createActor("k8admin", 1);
      const outsider = await pds.createActor("k8outsider", 1);
      const scopes = await combinedMemberScopes(pds.serviceRef);
      const creator = await mintBrowserSession(pds.hosts[0], creatorAccount.did, scopes, "k8creator-dpop");
      const outsiderBrowser = await mintBrowserSession(outsider.pds, outsider.did, scopes, "k8outsider-dpop");
      const name = "K8 dedicated";

      const group = await createOpenSocialGroup(pds, creatorAccount, {
        name,
        keyLabel: "k8group-grant-dpop",
        grantCreationAuth: false,
      });

      // Without creation authorization, neither an outsider nor the creator can bind a workspace to the group's grant
      for (const unapprovedBrowser of [outsiderBrowser, creator]) {
        const unapproved = await outcome(() => createWorkspace(pds, unapprovedBrowser, name, tidNow(), group.groupDid));
        assert.equal(unapproved.ok, false, "the group's grant alone does not let anyone create without creation authorization");
        assert.match(
          unapproved.ok ? "" : unapproved.error,
          /AuthorizationRequired|approve/,
          `refused as needing approval: ${JSON.stringify(unapproved)}`,
        );
      }

      // Once approved for `creatorAccount`, workspace setup succeeds on `<groupDid>`
      grantCreationAuthorization(
        { authorityDid: group.groupDid, initiatorDid: creatorAccount.did, name },
        Math.floor(Date.now() / 1000),
      );
      const created = await createWorkspace(pds, creator, name, tidNow(), group.groupDid);
      assert.equal(created.state, "completed");
      assert.equal(parseWorkspaceUri(created.workspace)?.authorityDid, group.groupDid, "the workspace belongs to the group DID");

      // Approving the existing group for someone else refuses to overwrite the existing workspace
      const secondBrowser = await mintBrowserSession(second.pds, second.did, scopes, "k8admin-dpop");
      grantCreationAuthorization(
        { authorityDid: group.groupDid, initiatorDid: second.did, name },
        Math.floor(Date.now() / 1000),
      );
      const existing = await outcome(() => createWorkspace(pds, secondBrowser, name, tidNow(), group.groupDid));
      assert.equal(existing.ok, false, "a second approval on an existing group workspace creates nothing");
      assert.match(
        existing.ok ? "" : existing.error,
        /WorkspaceExists|already exists/,
        `refused as an existing workspace: ${JSON.stringify(existing)}`,
      );

      // Creator invites and promotes the second admin
      for (const request of [
        { kind: "inviteMember", subject: second.did },
        { kind: "setAdmin", subject: second.did, active: true },
      ]) {
        const answer = (await callOperatorMethod(creator.session, pds.serviceRef, "new.flock.operator.execute", {}, {
          workspace: created.workspace,
          operationId: tidNow(),
          request,
        })) as { operation?: { state?: string } };
        assert.equal(answer.operation?.state, "completed", `the creator's ${request.kind} completes`);
      }

      // Both admins sign out of their personal browsers; the second admin signs back in and administers the group
      await creator.session.signOut();
      await secondBrowser.session.signOut();
      const again = await mintBrowserSession(second.pds, second.did, scopes, "k8admin-again-dpop");
      const operationId = tidNow();
      const answer = (await callOperatorMethod(again.session, pds.serviceRef, "new.flock.operator.execute", {}, {
        workspace: created.workspace,
        operationId,
        request: { kind: "createChannel", skey: `k8-${operationId}`, name: "k8", visibility: "public" },
      })) as { operation?: { state?: string } };
      assert.equal(answer.operation?.state, "completed", "an admin administers the group after every admin signed out");

      const reconciled = (await callOperatorMethod(again.session, pds.serviceRef, "new.flock.operator.execute", {}, {
        workspace: created.workspace,
        operationId: tidNow(),
        request: { kind: "reconcileWorkspace" },
      })) as { operation?: { state?: string } };
      assert.equal(reconciled.operation?.state, "completed");

      // When the Group-DID session expires at Group Host, admin operations surface reauthorization, and the second admin
      // reauthorizes `<groupDid>` via their own personal PDS (`second.pds`) without needing the original creator!
      await ageGroupSessionAtHost(pds.groupHost, group.groupDid, THIRTY_ONE_DAYS_MS);
      await expireStoredSession("authority_grant", group.groupDid);

      const postExpiryOpId = tidNow();
      const expiredAttempt = await outcome(() =>
        callOperatorMethod(again.session, pds.serviceRef, "new.flock.operator.execute", {}, {
          workspace: created.workspace,
          operationId: postExpiryOpId,
          request: { kind: "createChannel", skey: `reauth-${postExpiryOpId}`, name: "reauth", visibility: "public" },
        }),
      );
      assert.equal(expiredAttempt.ok, false);
      assert.match(expiredAttempt.ok ? "" : expiredAttempt.error, /AuthoritySessionUnavailable.*must be reauthorized/);

      const flowStart = (await callOperatorMethod(again.session, pds.serviceRef, "new.flock.operator.startAuthorityFlow", {}, {
        purpose: "reauthorize",
        authority: group.groupDid,
      })) as { url?: string };
      assert.match(flowStart.url ?? "", /\/authority\/start\?ticket=[A-Za-z0-9_-]+$/);

      await storeGroupAuthorityGrant(pds, second, group.groupDid, "k8-second-admin-reauth-dpop");
      const afterReauth = (await callOperatorMethod(again.session, pds.serviceRef, "new.flock.operator.execute", {}, {
        workspace: created.workspace,
        operationId: postExpiryOpId,
        request: { kind: "createChannel", skey: `reauth-${postExpiryOpId}`, name: "reauth", visibility: "public" },
      })) as { operation?: { state?: string } };
      assert.equal(afterReauth.operation?.state, "completed", "second admin reauthorizes group grant and completes operation");
    });

    await t.test("a session restored before the authority approves again cannot use or delete the grant that replaced it", async () => {
      const [
        { authorityClientMetadata, hasAuthorityGrant, persistAuthorityGrant, restoreAuthorityGrant },
        { TokenInvalidError, TokenRefreshError, TokenRevokedError },
      ] = await Promise.all([
        import("@flock/operator/operator/authority-grant"),
        import("@atproto/oauth-client-node"),
      ]);
      const owner = await pds.createActor("k1replaced-owner", 0);
      const group = await createOpenSocialGroup(pds, owner, { name: "Replaced", keyLabel: "k1replaced-first-dpop" });
      const inFlight = await restoreAuthorityGrant(group.groupDid);

      // Mint a replacement Group-DID approval and persist it (which revokes the replaced session at Group Host)
      const metadata = authorityClientMetadata();
      const replacement = await completeRealGroupOAuthFlow({
        groupHost: pds.groupHost,
        actor: owner,
        scope: metadata.scope,
        clientId: metadata.client_id,
        redirectUri: metadata.redirect_uris[0],
        loginHint: group.groupDid,
        keyLabel: "k1replaced-second-dpop",
      });
      assert.ok(replacement.saved);
      await persistAuthorityGrant(group.groupDid, replacement.saved);

      const staleRequest = await inFlight
        .fetchHandler("/xrpc/com.atproto.server.checkAccountStatus", { method: "GET" })
        .then((response) => response.status, (error: unknown) => error);

      assert.equal(hasAuthorityGrant(group.groupDid), true, "the new grant survives");
      assert.ok(
        staleRequest instanceof TokenRefreshError ||
          staleRequest instanceof TokenRevokedError ||
          staleRequest instanceof TokenInvalidError,
        `the old approval's session is refused without clobbering the replacement: ${String(staleRequest)}`,
      );
      const current = await restoreAuthorityGrant(group.groupDid);
      assert.equal((await current.fetchHandler("/xrpc/com.atproto.server.checkAccountStatus", { method: "GET" })).status, 200);
    });

    await t.test("a restore that reads a grant just before the authority approves again restores the new approval", async () => {
      const [{ restoreAuthorityGrant }, { oauthSqliteRequestLock }] = await Promise.all([
        import("@flock/operator/operator/authority-grant"),
        import("@flock/operator/auth/oauth-request-lock"),
      ]);
      const owner = await pds.createActor("k1race-owner", 0);
      const group = await createOpenSocialGroup(pds, owner, { name: "Race", keyLabel: "k1race-first-dpop" });
      await expireStoredSession("authority_grant", group.groupDid);

      let release: () => void = () => undefined;
      const held = oauthSqliteRequestLock(
        `@atproto-oauth-client-${group.groupDid}`,
        () => new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      const restoring = restoreAuthorityGrant(group.groupDid);
      restoring.catch(() => undefined);

      // Age out the first session at Group Host and write a fresh approval while the lock is held
      try {
        await ageGroupSessionAtHost(pds.groupHost, group.groupDid, THIRTY_ONE_DAYS_MS);
        await storeGroupAuthorityGrant(pds, owner, group.groupDid, "k1race-second-dpop");
      } finally {
        release();
        await held;
      }

      const session = await restoring;
      assert.equal((await session.fetchHandler("/xrpc/com.atproto.server.checkAccountStatus", { method: "GET" })).status, 200);
    });
  } finally {
    await pds.close();
  }
});

type WorkspaceUnderTest = {
  uri: string;
  groupDid: string;
  authority: NetworkActor;
  admin: NetworkActor;
  /** The second admin's own browser session, which no scenario touches. */
  adminBrowser: BrowserSession;
  creatorEvent(scenario: Scenario): Promise<void>;
};

async function createWorkspace(
  pds: PdsNetwork,
  browser: BrowserSession,
  name: string,
  operationId: string,
  authority?: string,
): Promise<{ state: string; workspace: string; groupDid: string }> {
  return (await callOperatorMethod(browser.session, pds.serviceRef, "new.flock.operator.createWorkspace", {}, {
    name,
    operationId,
    ...(authority ? { authority } : {}),
  })) as { state: string; workspace: string; groupDid: string };
}

async function createWorkspaceWithSecondAdmin(pds: PdsNetwork, scenario: Scenario): Promise<WorkspaceUnderTest> {
  const [{ tidNow }, { grantCreationAuthorization }] = await Promise.all([
    import("@flock/protocol/keys"),
    import("@flock/operator/operator/creation-authorization"),
  ]);
  const label = {
    "signs out": "k1out",
    "signs in again in a second browser": "k1again",
    "lets the sign-in session pass its lifetime": "k1lapse",
  }[scenario];
  const authority = await pds.createActor(`${label}-owner`, 0);
  const admin = await pds.createActor(`${label}-admin`, 1);
  const scopes = await combinedMemberScopes(pds.serviceRef);
  const adminBrowser = await mintBrowserSession(admin.pds, admin.did, scopes, `${label}-admin-dpop`);

  const creator = await mintBrowserSession(pds.hosts[0], authority.did, scopes, `${label}-browser-dpop`);
  const wsName = `K1 ${label}`;
  const group = await createOpenSocialGroup(pds, authority, { name: wsName, keyLabel: `${label}-grant-dpop` });
  grantCreationAuthorization(
    { authorityDid: group.groupDid, initiatorDid: authority.did, name: wsName },
    Math.floor(Date.now() / 1000),
  );
  const created = await createWorkspace(pds, creator, wsName, tidNow(), group.groupDid);
  assert.equal(created.state, "completed", "the creator sets up the workspace");
  for (const request of [
    { kind: "inviteMember", subject: admin.did },
    { kind: "setAdmin", subject: admin.did, active: true },
  ]) {
    const answer = (await callOperatorMethod(creator.session, pds.serviceRef, "new.flock.operator.execute", {}, {
      workspace: created.workspace,
      operationId: tidNow(),
      request,
    })) as { operation?: { state?: string } };
    assert.equal(answer.operation?.state, "completed", `${request.kind} completes`);
  }
  return {
    uri: created.workspace,
    groupDid: group.groupDid,
    authority,
    admin,
    adminBrowser,
    async creatorEvent(event) {
      if (event === "signs out") {
        await creator.session.signOut();
        await assert.rejects(creator.restore(), "the creator's browser session is gone");
        return;
      }
      if (event === "signs in again in a second browser") {
        const second = await mintBrowserSession(pds.hosts[0], authority.did, scopes, `${label}-second-browser-dpop`);
        assert.notEqual(second.accessToken, creator.accessToken);
        return;
      }
      await ageProviderSession(pds.hosts[0], creator.accessToken, FIFTEEN_DAYS_MS);
      await assert.rejects(creator.restore(true), /expired/i);
    },
  };
}

async function adminOperations(pds: PdsNetwork, workspace: WorkspaceUnderTest): Promise<Record<string, Outcome>> {
  const [{ requireActiveWorkspaceAdmin, requireWorkspaceOperator }, { tidNow }] = await Promise.all([
    import("@flock/operator/operator/security"),
    import("@flock/protocol/keys"),
  ]);
  const admin = workspace.adminBrowser.session;
  const operationId = tidNow();
  return {
    "second admin creates a channel (execute)": await outcome(async () => {
      const answer = (await callOperatorMethod(admin, pds.serviceRef, "new.flock.operator.execute", {}, {
        workspace: workspace.uri,
        operationId,
        request: { kind: "createChannel", skey: `k1-${operationId}`, name: "k1", visibility: "public" },
      })) as { operation?: { state?: string } };
      assert.equal(answer.operation?.state, "completed");
    }),
    "second admin reads that operation (getOperation)": await outcome(async () => {
      const answer = (await callOperatorMethod(admin, pds.serviceRef, "new.flock.operator.getOperation", {
        workspace: workspace.uri,
        operationId,
      })) as { operation?: { state?: string } };
      assert.equal(answer.operation?.state, "completed");
    }),
    "second admin lists stalled operations (listStalledOperations)": await outcome(async () => {
      const answer = (await callOperatorMethod(admin, pds.serviceRef, "new.flock.operator.listStalledOperations", {
        workspace: workspace.uri,
      })) as { operations?: unknown[] };
      assert.ok(Array.isArray(answer.operations));
    }),
    "the creator account passes the operator admin check": await outcome(() =>
      requireActiveWorkspaceAdmin(workspace.uri, workspace.authority.did),
    ),
    "the group grant passes the operator group check": await outcome(() =>
      requireWorkspaceOperator(workspace.uri),
    ),
    "second admin reconciles the workspace (reconcileWorkspace)": await outcome(async () => {
      const answer = (await callOperatorMethod(admin, pds.serviceRef, "new.flock.operator.execute", {}, {
        workspace: workspace.uri,
        operationId: tidNow(),
        request: { kind: "reconcileWorkspace" },
      })) as { operation?: { state?: string } };
      assert.equal(answer.operation?.state, "completed");
    }),
  };
}
