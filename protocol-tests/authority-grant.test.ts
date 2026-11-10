import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  ageOAuthSessionAtProvider,
  callOperatorMethod,
  memberSignInScopes,
  outcome,
  startPdsNetwork,
  storeAuthorityGrant,
  storeOAuthSession,
  type NetworkActor,
  type Outcome,
  type PdsNetwork,
} from "./support/pds-network";

// R1's gate (K1 of `.ai/plans/platform-refactor.md`, finding F1). Before R1 the operator administered a workspace with its
// creator's ordinary sign-in session, so the creator signing out, signing in again elsewhere, or letting that session
// lapse broke admin operations for every admin (recorded in the plan's R0 results). Now the operator holds a separate
// authority grant: each scenario changes only the creator's sign-in, and every admin operation keeps working.

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
      // given an authority whose grant created one workspace
      const [{ bootstrapWorkspace }, { restoreAuthorityGrant }, { tidNow }] = await Promise.all([
        import("@/operator/kinds/bootstrap-workspace"), import("@/operator/authority-grant"), import("@/protocol/keys"),
      ]);
      const authority = await pds.createActor("k1second-owner", 0);
      await storeAuthorityGrant(pds.hosts[0], authority.did, "k1second-grant-dpop");
      const first = await bootstrapWorkspace(await restoreAuthorityGrant(authority.did), { name: "K1 first", operationId: tidNow() });

      // when it creates another
      const second = await bootstrapWorkspace(await restoreAuthorityGrant(authority.did), { name: "K1 second", operationId: tidNow() });

      // then both complete on the same grant
      assert.deepEqual([first.state, second.state], ["completed", "completed"]);
      assert.notEqual(first.workspace, second.workspace);
    });
  } finally {
    await pds.close();
  }
});

type WorkspaceUnderTest = {
  uri: string;
  authority: NetworkActor;
  admin: NetworkActor;
  creatorEvent(scenario: Scenario): Promise<void>;
};

async function createWorkspaceWithSecondAdmin(pds: PdsNetwork, scenario: Scenario): Promise<WorkspaceUnderTest> {
  const [{ getOAuthClientForSession }, { bootstrapWorkspace }, { restoreAuthorityGrant }, { requireActiveWorkspaceAdmin }, { executeOperatorOperation }, { tidNow }] = await Promise.all([
    import("@/auth/oauth"), import("@/operator/kinds/bootstrap-workspace"), import("@/operator/authority-grant"), import("@/operator/security"),
    import("@/operator/operations"), import("@/protocol/keys"),
  ]);
  const label = { "signs out": "k1out", "signs in again in a second browser": "k1again", "lets the sign-in session pass its lifetime": "k1lapse" }[scenario];
  const authority = await pds.createActor(`${label}-owner`, 0);
  const admin = await pds.createActor(`${label}-admin`, 1);
  const { permissionScopeFor } = await import("@/protocol/scopes");
  await storeOAuthSession(admin.pds, admin.did, [...await memberSignInScopes(), ...permissionScopeFor("operatorAdmin", { workspaceDid: admin.did, serviceRef: pds.serviceRef })], `${label}-admin-dpop`);
  // The creator is signed in as a member and has approved the workspace-authority grant, which the authority flow keeps apart.
  const signIn = await storeOAuthSession(pds.hosts[0], authority.did, await memberSignInScopes(), `${label}-sign-in-dpop`);
  await storeAuthorityGrant(pds.hosts[0], authority.did, `${label}-grant-dpop`);
  const created = await bootstrapWorkspace(await restoreAuthorityGrant(authority.did), { name: `K1 ${label}`, operationId: tidNow() });
  assert.equal(created.state, "completed", "the creator sets up the workspace");
  const owner = await requireActiveWorkspaceAdmin(created.workspace, authority.did);
  for (const request of [{ kind: "inviteMember", subject: admin.did }, { kind: "setAdmin", subject: admin.did, active: true }]) {
    const view = await executeOperatorOperation(owner, tidNow(), request);
    assert.equal(view.state, "completed", `${request.kind} completes`);
  }
  const restoreSignIn = async () => (await getOAuthClientForSession(authority.did)).restore(authority.did);
  return {
    uri: created.workspace,
    authority,
    admin,
    async creatorEvent(event) {
      if (event === "signs out") {
        // The creator signs out through the real route, holding the web session its sign-in created.
        const [{ createWebSession, WEB_SESSION_COOKIE }, { POST }, { NextRequest }, { getConfig }] = await Promise.all([
          import("@/auth/web-session"), import("@/app/api/oauth/logout/route"), import("next/server"), import("@/lib/config"),
        ]);
        const cookie = await createWebSession(authority.did);
        const origin = getConfig().appUrl.origin;
        const response = await POST(new NextRequest(new URL("/api/oauth/logout", origin), { method: "POST", headers: { origin, cookie: `${WEB_SESSION_COOKIE}=${cookie}` } }));
        assert.equal(response.status, 200);
        await assert.rejects(restoreSignIn(), "the creator's sign-in is gone");
        return;
      }
      if (event === "signs in again in a second browser") {
        // What /oauth/callback stores for a fresh sign-in, under the same DID-keyed member row.
        await storeOAuthSession(pds.hosts[0], authority.did, await memberSignInScopes(), `${label}-second-browser-dpop`);
        return;
      }
      // The sign-in passes its lifetime, and the web app's next use of it fails and drops it.
      await ageOAuthSessionAtProvider(pds.hosts[0], "oauth_session", authority.did, signIn.accessToken, FIFTEEN_DAYS_MS);
      await assert.rejects(restoreSignIn(), /Session expired/);
    },
  };
}

async function adminOperations(pds: PdsNetwork, workspace: WorkspaceUnderTest): Promise<Record<string, Outcome>> {
  const [{ getOAuthClientForSession }, { requireActiveWorkspaceAdmin }, { tidNow }] = await Promise.all([
    import("@/auth/oauth"), import("@/operator/security"), import("@/protocol/keys"),
  ]);
  // The second admin calls each operator method through its route, with service tokens from its own signed-in session.
  const admin = await (await getOAuthClientForSession(workspace.admin.did)).restore(workspace.admin.did);
  const operationId = tidNow();
  return {
    "second admin creates a channel (execute)": await outcome(async () => {
      const answer = await callOperatorMethod(admin, pds.serviceRef, "org.slack.operator.execute", {}, {
        workspace: workspace.uri, operationId, request: { kind: "createChannel", skey: `k1-${operationId}`, name: "k1", visibility: "public" },
      }) as { operation?: { state?: string } };
      assert.equal(answer.operation?.state, "completed");
    }),
    "second admin reads that operation (getOperation)": await outcome(async () => {
      const answer = await callOperatorMethod(admin, pds.serviceRef, "org.slack.operator.getOperation", { workspace: workspace.uri, operationId }) as { operation?: { state?: string } };
      assert.equal(answer.operation?.state, "completed");
    }),
    "second admin lists inbox writers (listInboxWriters)": await outcome(() => callOperatorMethod(admin, pds.serviceRef, "org.slack.operator.listInboxWriters", { workspace: workspace.uri })),
    "the authority account passes the operator admin check": await outcome(() => requireActiveWorkspaceAdmin(workspace.uri, workspace.authority.did)),
    "the reconcile job verifies the workspace": await outcome(() => runReconcileJob(pds, workspace.uri)),
  };
}

async function runReconcileJob(pds: PdsNetwork, workspaceUri: string): Promise<void> {
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/reconcile-workspaces.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_PATH: pds.databasePath, SLACK_ADMIN_MUTATIONS_PAUSED: "true" },
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
  if (!lines.some((line) => line.startsWith(`${workspaceUri}: authority session and admin access verified`))) {
    throw new Error(`reconcile exited ${exitCode}: ${lines.join(" | ") || "no line for this workspace"}`);
  }
}
