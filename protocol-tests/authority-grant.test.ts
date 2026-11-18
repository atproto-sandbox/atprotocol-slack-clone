import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  ageProviderSession,
  callOperatorMethod,
  combinedMemberScopes,
  mintBrowserSession,
  outcome,
  startPdsNetwork,
  storeAuthorityGrant,
  type BrowserSession,
  type NetworkActor,
  type Outcome,
  type PdsNetwork,
} from "./support/pds-network";

// R1's gate (K1 of `.ai/plans/platform-refactor.md`, finding F1). Before R1 the operator administered a workspace with its
// creator's ordinary sign-in session, so the creator signing out, signing in again elsewhere, or letting that session
// lapse broke admin operations for every admin (recorded in the plan's R0 results). Now the operator holds a separate
// authority grant, and the creator's own session is the browser's: each scenario changes only that session, at the creator's
// host, and every admin operation keeps working.

type Scenario = "signs out" | "signs in again in a second browser" | "lets the sign-in session pass its lifetime";

const FIFTEEN_DAYS_MS = 15 * 24 * 60 * 60 * 1000;

test("the workspace authority grant outlives the creator's sign-in session", async (t) => {
  const pds = await startPdsNetwork("authority-grant");
  try {
    for (const scenario of ["signs out", "signs in again in a second browser", "lets the sign-in session pass its lifetime"] as const) {
      await t.test(`admin operations keep working after the creator ${scenario}`, async (st) => {
        // given a workspace created with the authority grant, with a second admin, while its creator is signed in
        const workspace = await createWorkspaceWithSecondAdmin(pds, scenario);

        // when the creator's sign-in session changes
        await workspace.creatorEvent(scenario);

        // then every admin operation still succeeds
        const results = await adminOperations(pds, workspace);
        for (const [operation, result] of Object.entries(results)) st.diagnostic(`${operation}: ${result.ok ? "ok" : result.error}`);
        assert.deepEqual(Object.entries(results).filter(([, result]) => !result.ok).map(([operation]) => operation), []);
      });
    }

    await t.test("the authority account creates a second workspace with no further approval", async () => {
      // given an authority whose grant created one workspace, asking the operator as its browser does
      const { tidNow } = await import("@flock/protocol/keys");
      const authority = await pds.createActor("k1second-owner", 0);
      const browser = await mintBrowserSession(pds.hosts[0], authority.did, await combinedMemberScopes(pds.serviceRef), "k1second-browser-dpop");
      await storeAuthorityGrant(pds.hosts[0], authority.did, "k1second-grant-dpop");
      const first = await createWorkspace(pds, browser, "K1 first", tidNow());

      // when it creates another
      const second = await createWorkspace(pds, browser, "K1 second", tidNow());

      // then both complete on the same grant
      assert.deepEqual([first.state, second.state], ["completed", "completed"]);
      assert.notEqual(first.workspace, second.workspace);
    });

    await t.test("a workspace under a dedicated account that never signs in to the app is created for its creator, who administers it with a second admin after both sign out (R8)", async () => {
      const [{ parseWorkspaceUri, tidNow }, { grantCreationAuthorization }] = await Promise.all([import("@flock/protocol/keys"), import("@flock/operator/operator/creation-authorization")]);
      // given a workspace account whose grant the operator holds (it has no browser session, here or anywhere), a person
      // signed in at their own browser, and a second person who will become an admin
      const account = await pds.createActor("k8account", 0);
      const creatorAccount = await pds.createActor("k8creator", 0);
      const second = await pds.createActor("k8admin", 1);
      const scopes = await combinedMemberScopes(pds.serviceRef);
      const creator = await mintBrowserSession(pds.hosts[0], creatorAccount.did, scopes, "k8creator-dpop");
      await storeAuthorityGrant(pds.hosts[0], account.did, "k8account-grant-dpop");
      const name = "K8 dedicated";

      // when the person creates a workspace under the account without its approval of that workspace, it is refused
      const unapproved = await outcome(() => createWorkspace(pds, creator, name, tidNow(), account.did));
      assert.equal(unapproved.ok, false, "the account's grant alone does not let someone else create under it");
      assert.match(unapproved.ok ? "" : unapproved.error, /AuthorizationRequired|approve/, `refused as needing the account's approval: ${JSON.stringify(unapproved)}`);

      // and when the account's creation flow has approved it, the workspace is created under the account for the person
      grantCreationAuthorization({ authorityDid: account.did, initiatorDid: creatorAccount.did, name }, Math.floor(Date.now() / 1000));
      const created = await createWorkspace(pds, creator, name, tidNow(), account.did);
      assert.equal(created.state, "completed");
      assert.equal(parseWorkspaceUri(created.workspace)?.authorityDid, account.did, "the workspace is the account's");

      // and an approval of that name for someone else does not join them to it: the workspace exists at the account's host
      const secondBrowser = await mintBrowserSession(second.pds, second.did, scopes, "k8admin-dpop");
      grantCreationAuthorization({ authorityDid: account.did, initiatorDid: second.did, name }, Math.floor(Date.now() / 1000));
      const existing = await outcome(() => createWorkspace(pds, secondBrowser, name, tidNow(), account.did));
      assert.equal(existing.ok, false, "a second approval of an existing name creates nothing");
      assert.match(existing.ok ? "" : existing.error, /WorkspaceExists|already exists/, `refused as an existing workspace: ${JSON.stringify(existing)}`);

      // then the person administers it: they add a second admin
      for (const request of [{ kind: "inviteMember", subject: second.did }, { kind: "setAdmin", subject: second.did, active: true }]) {
        const answer = await callOperatorMethod(creator.session, pds.serviceRef, "new.flock.operator.execute", {}, { workspace: created.workspace, operationId: tidNow(), request }) as { operation?: { state?: string } };
        assert.equal(answer.operation?.state, "completed", `the creator's ${request.kind} completes`);
      }

      // and after both admins sign out, the workspace still runs on the account's grant: the second admin, signing in again,
      // administers it
      await creator.session.signOut();
      await secondBrowser.session.signOut();
      const again = await mintBrowserSession(second.pds, second.did, scopes, "k8admin-again-dpop");
      const operationId = tidNow();
      const answer = await callOperatorMethod(again.session, pds.serviceRef, "new.flock.operator.execute", {}, {
        workspace: created.workspace, operationId, request: { kind: "createChannel", skey: `k8-${operationId}`, name: "k8", visibility: "public" },
      }) as { operation?: { state?: string } };
      assert.equal(answer.operation?.state, "completed", "an admin administers the workspace after every admin signed out");

      // and the scheduled reconcile job runs for it, though its account holds no admin record: the read-only check while
      // mutations are paused, and the reconcile itself
      await runReconcileJob(pds, created.workspace);
      await runReconcileJob(pds, created.workspace, { paused: false });
    });

    await t.test("a session restored before the authority approves again cannot use or delete the grant that replaced it", async () => {
      // given the authority's grant restored as a session, as an operator request in flight holds it
      const [{ hasAuthorityGrant, restoreAuthorityGrant }, { TokenRefreshError }] = await Promise.all([import("@flock/operator/operator/authority-grant"), import("@atproto/oauth-client-node")]);
      const authority = await pds.createActor("k1replaced-owner", 0);
      await storeAuthorityGrant(pds.hosts[0], authority.did, "k1replaced-first-dpop");
      const inFlight = await restoreAuthorityGrant(authority.did);

      // when the authority approves again, and the session in flight makes its next request
      await storeAuthorityGrant(pds.hosts[0], authority.did, "k1replaced-second-dpop");
      const staleRequest = await inFlight.fetchHandler("/xrpc/com.atproto.server.getSession", { method: "GET" }).then((response) => response.status, (error: unknown) => error);

      // then the new grant is still stored, the old approval's session found no grant of its own, and a session restored now
      // is served with the new one
      assert.equal(hasAuthorityGrant(authority.did), true, "the new grant survives");
      assert.ok(staleRequest instanceof TokenRefreshError, `the old approval's session is refused before it reaches the host: ${String(staleRequest)}`);
      const current = await restoreAuthorityGrant(authority.did);
      assert.equal((await current.fetchHandler("/xrpc/com.atproto.server.getSession", { method: "GET" })).status, 200);
    });

    await t.test("a restore that reads a grant just before the authority approves again restores the new approval", async () => {
      // given a restore that has read the authority's grant and waits for the grant's lock, held as a refresh holds it
      const [{ restoreAuthorityGrant }, { oauthSqliteRequestLock }] = await Promise.all([import("@flock/operator/operator/authority-grant"), import("@flock/operator/auth/oauth-request-lock")]);
      const authority = await pds.createActor("k1race-owner", 0);
      await storeAuthorityGrant(pds.hosts[0], authority.did, "k1race-first-dpop");
      let release: () => void = () => undefined;
      const held = oauthSqliteRequestLock(`@atproto-oauth-client-${authority.did}`, () => new Promise<void>((resolve) => { release = resolve; }));
      // The restore reads the grant as it is called, before it waits for the lock. It is awaited below; the handler keeps a
      // failure of the steps in between from being reported as its unhandled rejection instead.
      const restoring = restoreAuthorityGrant(authority.did);
      restoring.catch(() => undefined);

      // when the authority approves again before the lock is released
      try {
        await storeAuthorityGrant(pds.hosts[0], authority.did, "k1race-second-dpop");
      } finally {
        release();
        await held;
      }

      // then the restore gives a session of the new approval, which the host serves
      const session = await restoring;
      assert.equal((await session.fetchHandler("/xrpc/com.atproto.server.getSession", { method: "GET" })).status, 200);
    });
  } finally {
    await pds.close();
  }
});

type WorkspaceUnderTest = {
  uri: string;
  authority: NetworkActor;
  admin: NetworkActor;
  /** The second admin's own browser session, which no scenario touches. */
  adminBrowser: BrowserSession;
  creatorEvent(scenario: Scenario): Promise<void>;
};

/** Creates `name` as the browser's account, under `authority` (a dedicated workspace account) or its own account. */
async function createWorkspace(pds: PdsNetwork, browser: BrowserSession, name: string, operationId: string, authority?: string): Promise<{ state: string; workspace: string }> {
  return await callOperatorMethod(browser.session, pds.serviceRef, "new.flock.operator.createWorkspace", {}, { name, operationId, ...(authority ? { authority } : {}) }) as { state: string; workspace: string };
}

async function createWorkspaceWithSecondAdmin(pds: PdsNetwork, scenario: Scenario): Promise<WorkspaceUnderTest> {
  const { tidNow } = await import("@flock/protocol/keys");
  const label = { "signs out": "k1out", "signs in again in a second browser": "k1again", "lets the sign-in session pass its lifetime": "k1lapse" }[scenario];
  const authority = await pds.createActor(`${label}-owner`, 0);
  const admin = await pds.createActor(`${label}-admin`, 1);
  const scopes = await combinedMemberScopes(pds.serviceRef);
  const adminBrowser = await mintBrowserSession(admin.pds, admin.did, scopes, `${label}-admin-dpop`);
  // The creator is signed in at their browser with the member grant and has approved the workspace-authority grant, which the authority flow keeps apart.
  const creator = await mintBrowserSession(pds.hosts[0], authority.did, scopes, `${label}-browser-dpop`);
  await storeAuthorityGrant(pds.hosts[0], authority.did, `${label}-grant-dpop`);
  const created = await createWorkspace(pds, creator, `K1 ${label}`, tidNow());
  assert.equal(created.state, "completed", "the creator sets up the workspace");
  for (const request of [{ kind: "inviteMember", subject: admin.did }, { kind: "setAdmin", subject: admin.did, active: true }]) {
    const answer = await callOperatorMethod(creator.session, pds.serviceRef, "new.flock.operator.execute", {}, { workspace: created.workspace, operationId: tidNow(), request }) as { operation?: { state?: string } };
    assert.equal(answer.operation?.state, "completed", `${request.kind} completes`);
  }
  return {
    uri: created.workspace,
    authority,
    admin,
    adminBrowser,
    async creatorEvent(event) {
      if (event === "signs out") {
        // The browser signs the creator out: the session is revoked at the creator's host.
        await creator.session.signOut();
        await assert.rejects(creator.restore(), "the creator's browser session is gone");
        return;
      }
      if (event === "signs in again in a second browser") {
        // A second browser signs in: another session for the same account, at the same host.
        const second = await mintBrowserSession(pds.hosts[0], authority.did, scopes, `${label}-second-browser-dpop`);
        assert.notEqual(second.accessToken, creator.accessToken);
        return;
      }
      // The session passes its lifetime at the provider, and the browser's next refresh of it is refused.
      await ageProviderSession(pds.hosts[0], creator.accessToken, FIFTEEN_DAYS_MS);
      await assert.rejects(creator.restore(true), /expired/i);
    },
  };
}

async function adminOperations(pds: PdsNetwork, workspace: WorkspaceUnderTest): Promise<Record<string, Outcome>> {
  const [{ requireActiveWorkspaceAdmin }, { tidNow }] = await Promise.all([import("@flock/operator/operator/security"), import("@flock/protocol/keys")]);
  // The second admin calls each operator method through its route, with service tokens from its own browser session.
  const admin = workspace.adminBrowser.session;
  const operationId = tidNow();
  return {
    "second admin creates a channel (execute)": await outcome(async () => {
      const answer = await callOperatorMethod(admin, pds.serviceRef, "new.flock.operator.execute", {}, {
        workspace: workspace.uri, operationId, request: { kind: "createChannel", skey: `k1-${operationId}`, name: "k1", visibility: "public" },
      }) as { operation?: { state?: string } };
      assert.equal(answer.operation?.state, "completed");
    }),
    "second admin reads that operation (getOperation)": await outcome(async () => {
      const answer = await callOperatorMethod(admin, pds.serviceRef, "new.flock.operator.getOperation", { workspace: workspace.uri, operationId }) as { operation?: { state?: string } };
      assert.equal(answer.operation?.state, "completed");
    }),
    "second admin lists inbox writers (listInboxWriters)": await outcome(() => callOperatorMethod(admin, pds.serviceRef, "new.flock.operator.listInboxWriters", { workspace: workspace.uri })),
    "the authority account passes the operator admin check": await outcome(() => requireActiveWorkspaceAdmin(workspace.uri, workspace.authority.did)),
    "the reconcile job verifies the workspace": await outcome(() => runReconcileJob(pds, workspace.uri)),
  };
}

/** Runs the reconcile job as the scheduler does: by default with mutations paused (its read-only check), or the reconcile itself. */
async function runReconcileJob(pds: PdsNetwork, workspaceUri: string, options: { paused?: boolean } = {}): Promise<void> {
  const paused = options.paused ?? true;
  const env = { ...process.env, DATABASE_PATH: pds.databasePath };
  if (paused) env.FLOCK_ADMIN_MUTATIONS_PAUSED = "true";
  else delete env.FLOCK_ADMIN_MUTATIONS_PAUSED;
  const child = spawn(process.execPath, ["--import", "tsx", "apps/operator/scripts/reconcile-workspaces.ts"], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  // The job covers every journaled workspace in the database; only this workspace's own line decides the outcome.
  const lines = output.trim().split("\n").filter((line) => line.includes(workspaceUri));
  const expected = paused ? `${workspaceUri}: authority session verified; mutations paused` : `${workspaceUri}: completed`;
  if (!lines.some((line) => line === expected)) {
    throw new Error(`reconcile exited ${exitCode}: ${lines.join(" | ") || "no line for this workspace"}`);
  }
}
