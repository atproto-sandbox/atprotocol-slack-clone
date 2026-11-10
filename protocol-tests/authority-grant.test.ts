import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  authorityScopes,
  ageOAuthSessionAtProvider,
  loginScopes,
  outcome,
  startPdsNetwork,
  storeOAuthSession,
  type NetworkActor,
  type Outcome,
  type PdsNetwork,
} from "./support/pds-network";

// K1 of `.ai/plans/platform-refactor.md` (finding F1): the operator administers a workspace with its creator's ordinary
// sign-in session, so the creator signing out, signing in again elsewhere, or letting that session lapse breaks admin
// operations for every admin of the workspace. The "F1:" subtests pin today's behavior exactly; they are a record of the
// code before R1 and go away with it. R1 provisions the separate authority grant in this fixture and turns the `todo`
// subtests, which state what R1 must deliver, into the passing gate.

type Scenario = "signs out" | "signs in again in a second browser" | "lets the sign-in session pass its lifetime";

const FIFTEEN_DAYS_MS = 15 * 24 * 60 * 60 * 1000;

const R1_PENDING = "fails until R1 separates the workspace authority grant from the creator's sign-in";

test("the workspace authority grant outlives the creator's sign-in session (K1)", async (t) => {
  const pds = await startPdsNetwork("authority-grant");
  try {
    for (const scenario of ["signs out", "signs in again in a second browser", "lets the sign-in session pass its lifetime"] as const) {
      // given a workspace created by its authority, with a second admin (outside the expected failure, so a broken setup fails)
      const workspace = await createWorkspaceWithSecondAdmin(pds, scenario);

      // when the creator's sign-in session changes
      await workspace.creatorEvent(scenario);
      const results = await adminOperations(pds, workspace);
      const failed = Object.entries(results).filter(([, result]) => !result.ok);

      // then, today, admin operations fail because the operator used that sign-in session (finding F1)
      await t.test(`F1: after the creator ${scenario}, admin operations fail`, (st) => {
        for (const [operation, result] of Object.entries(results)) st.diagnostic(`${operation}: ${result.ok ? "ok" : result.error}`);
        assert.deepEqual(failed.map(([operation]) => operation), F1_FAILURES[scenario], "exactly these operations fail");
        assert.ok(failed.every(([, result]) => !result.ok && SESSION_FAILURE.test(result.error)), "every failure is the lost or narrowed authority session");
      });

      // and after R1 every admin operation succeeds
      await t.test(`admin operations keep working after the creator ${scenario}`, { todo: R1_PENDING }, () => {
        assert.deepEqual(failed.map(([operation]) => operation), []);
      });
    }
  } finally {
    await pds.close();
  }
});

const ALL_OPERATIONS = [
  "second admin passes the operator admin check (execute, getOperation, listInboxWriters)",
  "second admin creates a channel",
  "second admin lists inbox writers",
  "the authority account passes the operator admin check",
  "the reconcile job verifies the workspace",
];

/**
 * Which operations F1 breaks in each scenario, as observed at `5d88b414` before R1. After a second sign-in the session still
 * belongs to the authority, so the authority's own admin check and the reconcile job's paused check (which runs only that
 * check) still pass; every operation that reads the inbox for another admin does not.
 */
const F1_FAILURES: Record<Scenario, string[]> = {
  "signs out": ALL_OPERATIONS,
  "signs in again in a second browser": ALL_OPERATIONS.slice(0, 3),
  "lets the sign-in session pass its lifetime": ALL_OPERATIONS,
};

/** What F1 looks like from an admin operation: the creator's session is gone, expired, or no longer carries the authority scopes. */
const SESSION_FAILURE = /session was deleted|Session expired|Missing required scope|authority session is missing/;

type WorkspaceUnderTest = {
  uri: string;
  authority: NetworkActor;
  admin: NetworkActor;
  creatorEvent(scenario: Scenario): Promise<void>;
};

async function createWorkspaceWithSecondAdmin(pds: PdsNetwork, scenario: Scenario): Promise<WorkspaceUnderTest> {
  const [{ getOAuthClientForSession }, { bootstrapWorkspace }, { requireActiveWorkspaceAdmin }, { executeOperatorOperation }, { tidNow }] = await Promise.all([
    import("@/auth/oauth"), import("@/workspaces/bootstrap"), import("@/operator/security"), import("@/operator/operations"), import("@/protocol/keys"),
  ]);
  const label = { "signs out": "k1out", "signs in again in a second browser": "k1again", "lets the sign-in session pass its lifetime": "k1lapse" }[scenario];
  const authority = await pds.createActor(`${label}-owner`, 0);
  const admin = await pds.createActor(`${label}-admin`, 1);
  const grant = await storeOAuthSession(pds.hosts[0], authority.did, await authorityScopes(), `${label}-authority-dpop`);
  const session = await (await getOAuthClientForSession(authority.did)).restore(authority.did);
  const created = await bootstrapWorkspace(session, { name: `K1 ${label}`, operationId: tidNow() });
  assert.equal(created.state, "completed", "the creator sets up the workspace");
  const owner = await requireActiveWorkspaceAdmin(created.workspace, authority.did);
  for (const request of [{ kind: "inviteMember", subject: admin.did }, { kind: "setAdmin", subject: admin.did, active: true }]) {
    const view = await executeOperatorOperation(owner, tidNow(), request);
    assert.equal(view.state, "completed", `${request.kind} completes`);
  }
  return {
    uri: created.workspace,
    authority,
    admin,
    async creatorEvent(event) {
      if (event === "signs out") {
        // What /api/oauth/logout does with the creator's session.
        const current = await (await getOAuthClientForSession(authority.did)).restore(authority.did);
        await current.signOut();
        return;
      }
      if (event === "signs in again in a second browser") {
        // What /oauth/callback stores for a fresh sign-in: the login scopes only, under the same DID-keyed row.
        await storeOAuthSession(pds.hosts[0], authority.did, await loginScopes(), `${label}-second-browser-dpop`);
        return;
      }
      await ageOAuthSessionAtProvider(pds.hosts[0], authority.did, grant.accessToken, FIFTEEN_DAYS_MS);
    },
  };
}

async function adminOperations(pds: PdsNetwork, workspace: WorkspaceUnderTest): Promise<Record<string, Outcome>> {
  const [{ requireActiveWorkspaceAdmin }, { executeOperatorOperation, listInboxWriters }, { tidNow }] = await Promise.all([
    import("@/operator/security"), import("@/operator/operations"), import("@/protocol/keys"),
  ]);
  const channelKey = `k1-${tidNow()}`;
  return {
    "second admin passes the operator admin check (execute, getOperation, listInboxWriters)": await outcome(() => requireActiveWorkspaceAdmin(workspace.uri, workspace.admin.did)),
    "second admin creates a channel": await outcome(async () => {
      const actor = await requireActiveWorkspaceAdmin(workspace.uri, workspace.admin.did);
      const view = await executeOperatorOperation(actor, tidNow(), { kind: "createChannel", skey: channelKey, name: "k1", visibility: "public" });
      assert.equal(view.state, "completed");
    }),
    "second admin lists inbox writers": await outcome(async () => listInboxWriters(await requireActiveWorkspaceAdmin(workspace.uri, workspace.admin.did))),
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
