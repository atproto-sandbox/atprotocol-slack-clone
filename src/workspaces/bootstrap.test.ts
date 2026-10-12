import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import type { OAuthSession } from "@atproto/oauth-client-node";
import { closeDb, getRawDb } from "@/lib/db";
import { bootstrapWorkspace } from "./bootstrap";

const OWNER = "did:plc:owner";
let directory = "";

// The app config caches DATABASE_PATH on first read, so this file shares one database. Each test uses its own workspace name.
before(() => {
  directory = mkdtempSync(join(tmpdir(), "slack-bootstrap-test-"));
  process.env.DATABASE_PATH = join(directory, "bootstrap.db");
  process.env.AUTH_ENCRYPTION_KEY = "33".repeat(32);
  process.env.OPERATOR_SERVICE_REF = "did:web:localhost%3A3000#atproto_slack_admin";
  process.env.APP_URL = "http://127.0.0.1:3000";
});
after(() => {
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});

const SCOPE_MISSING = () => Response.json(
  { error: "ScopeMissingError", message: 'Missing required scope "space:org.slack.workspace?authority=did:plc:owner&skey=x&action=read_self&manage=create"' },
  { status: 403 },
);

type SpaceType = "org.slack.workspace" | "org.slack.inbox" | "org.slack.channel";

function sessionWith(createSpace: (type: SpaceType, skey: string) => Response): OAuthSession {
  return {
    did: OWNER,
    fetchHandler: async (path: string, init: RequestInit) => {
      if (!path.startsWith("/xrpc/com.atproto.simplespace.createSpace")) throw new Error(`unexpected request: ${path}`);
      const body = JSON.parse(String(init.body)) as { type: SpaceType; skey: string };
      return createSpace(body.type, body.skey);
    },
  } as unknown as OAuthSession;
}

const created = (type: SpaceType, skey: string) => Response.json({ uri: `at://${OWNER}/space/${type}/${skey}` });
const rowCount = (operationId: string) =>
  (getRawDb().prepare("SELECT count(*) AS count FROM operation WHERE operation_id = ?").get(operationId) as { count: number }).count;
const catalogCount = (workspaceUri: string) =>
  (getRawDb().prepare("SELECT count(*) AS count FROM operation_workspace_catalog WHERE workspace_uri = ?").get(workspaceUri) as { count: number }).count;
const stateOf = (operationId: string) =>
  getRawDb().prepare("SELECT state, steps_json, error FROM operation WHERE operation_id = ?").get(operationId) as { state: string; steps_json: string; error: string | null } | undefined;

test("a missing permission before any step leaves no journal row, and every retry is refused the same typed way", async () => {
  // #given no workspace-authority permission has been approved
  const noPermission = sessionWith(() => SCOPE_MISSING());

  // #when setup is attempted
  const first = await bootstrapWorkspace(noPermission, { name: "Acme", operationId: "2222222222222" });

  // #then it reports that authorization is required and leaves nothing to recover or alert on
  assert.equal(first.authorizationRequired, true);
  assert.deepEqual(first.completedSteps, []);
  assert.equal(rowCount("2222222222222"), 0, "no journal row is left behind");
  assert.equal(catalogCount(first.workspace), 0, "no workspace catalog entry is left behind");
  const audit = getRawDb().prepare("SELECT event, details_json FROM audit_event WHERE operation_id = ?").all("2222222222222") as Array<{ event: string; details_json: string }>;
  assert.deepEqual(audit.map((entry) => entry.event), ["operationDiscarded"]);
  assert.match(audit[0]!.details_json, /authorizationRequired/);

  // #when the user tries again with the same operation ID
  const again = await bootstrapWorkspace(noPermission, { name: "Acme", operationId: "2222222222222" });

  // #then the refusal is typed again, instead of a raw error
  assert.equal(again.authorizationRequired, true);
  assert.equal(rowCount("2222222222222"), 0);

  // #when the same operation ID is reused for a corrected name
  const renamed = await bootstrapWorkspace(noPermission, { name: "Acme Inc", operationId: "2222222222222" });

  // #then it is not an operation-ID conflict
  assert.equal(renamed.authorizationRequired, true);
});

test("a generic failure stays pending, and a retry that fails at its first remaining step stays pending too", async () => {
  // #given the PDS is failing
  let failure = "first outage";
  const failing = sessionWith(() => Response.json({ error: "InternalServerError", message: failure }, { status: 500 }));

  // #when setup fails, then is retried and fails again
  const first = await bootstrapWorkspace(failing, { name: "Beta", operationId: "3333333333333" });
  failure = "second outage";
  const second = await bootstrapWorkspace(failing, { name: "Beta", operationId: "3333333333333" });

  // #then both are recorded as pending (the retry does not throw), and this is not an authorization problem
  assert.equal(first.state, "pending");
  assert.equal(first.authorizationRequired, undefined);
  assert.equal(second.state, "pending");
  assert.equal(second.error, "second outage");
  assert.equal(stateOf("3333333333333")?.state, "pending");
  assert.equal(stateOf("3333333333333")?.error, "second outage");
});

test("a missing permission after some steps keeps the journal row, still signals authorization, and survives a retry", async () => {
  // #given the workspace space can be created but the inbox space cannot (a partial grant)
  const partial = sessionWith((type, skey) => type === "org.slack.workspace" ? created(type, skey) : SCOPE_MISSING());

  // #when setup runs, then is retried
  const first = await bootstrapWorkspace(partial, { name: "Gamma", operationId: "4444444444444" });
  const retry = await bootstrapWorkspace(partial, { name: "Gamma", operationId: "4444444444444" });

  // #then progress is kept, and both attempts signal that authorization is needed
  assert.deepEqual(first.completedSteps, ["workspace-space"]);
  assert.equal(first.authorizationRequired, true);
  assert.deepEqual(retry.completedSteps, ["workspace-space"]);
  assert.equal(retry.authorizationRequired, true);
  assert.equal(stateOf("4444444444444")?.state, "pending");
  assert.equal(catalogCount(first.workspace), 1, "the partially created workspace stays catalogued for recovery");
});
