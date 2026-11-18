import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import type { OAuthSession } from "@atproto/oauth-client-node";
import { closeDb } from "../../lib/db";
import { workspaceUri } from "@flock/protocol/keys";
import { parseWorkspaceRef, type OperatorActor } from "../actor";
import { runJournaledOperation } from "../journal";
import { bootstrapWorkspaceKind } from "./bootstrap-workspace";

const OWNER = "did:plc:owner";
let directory = "";

// The app config caches DATABASE_PATH on first read, so this file shares one database. Each test uses its own workspace name.
before(() => {
  directory = mkdtempSync(join(tmpdir(), "slack-bootstrap-test-"));
  process.env.DATABASE_PATH = join(directory, "bootstrap.db");
  process.env.AUTH_ENCRYPTION_KEY = "33".repeat(32);
  process.env.OPERATOR_SERVICE_REF = "did:web:localhost%3A3000#atproto_flock_operator";
  process.env.APP_URL = "http://127.0.0.1:3000";
});
after(() => {
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});

type SpaceType = "new.flock.workspace" | "new.flock.inbox" | "new.flock.channel";

function sessionWith(createSpace: (type: SpaceType, skey: string) => Response): OAuthSession {
  return {
    did: OWNER,
    fetchHandler: async (path: string, init: RequestInit) => {
      if (!path.startsWith("/xrpc/com.atproto.space.createSpace")) throw new Error(`unexpected request: ${path}`);
      const body = JSON.parse(String(init.body)) as { spaceType: SpaceType; skey: string };
      return createSpace(body.spaceType, body.skey);
    },
  } as unknown as OAuthSession;
}

const created = (type: SpaceType, skey: string) => Response.json({ uri: `at://${OWNER}/space/${type}/${skey}` });
test("a bootstrap replayed into a workspace whose key its name does not derive fails instead of building there", async () => {
  // #given a journaled bootstrap for "Delta" being run against some other workspace key
  const actor: OperatorActor = {
    did: OWNER, session: sessionWith(created), workspace: parseWorkspaceRef(workspaceUri(OWNER, "not-deltas-key")), canRecoverOperations: true,
  };

  // #when the runner replays it
  const view = await runJournaledOperation(actor, "5555555555555", { kind: "bootstrapWorkspace", name: "Delta" }, bootstrapWorkspaceKind.steps,
    (context) => bootstrapWorkspaceKind.run(actor, context, { kind: "bootstrapWorkspace", name: "Delta" }));

  // #then it fails before creating anything
  assert.equal(view.state, "failed");
  assert.deepEqual(view.completedSteps, []);
});
