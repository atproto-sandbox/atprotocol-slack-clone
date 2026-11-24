import { executeOperatorOperation } from "@flock/operator/operator/operations";
import { parseWorkspaceRef } from "@flock/operator/operator/actor";
import { adminMutationsPaused } from "@flock/operator/operator/mutations-paused";
import { readGroupGovernanceState } from "@flock/operator/operator/workspace-state";
import { tidNow } from "@flock/protocol/keys";
import { getRawDb } from "@flock/operator/lib/db";
import { restoreAuthorityGrant } from "@flock/operator/operator/authority-grant";

const authorityDid = process.env.RECOVERY_AUTHORITY_DID;
const actorDid = process.env.RECOVERY_ACTOR_DID || authorityDid;
const workspaceUri = process.env.RECOVERY_WORKSPACE;
const memberDid = process.env.RECOVERY_MEMBER_DID;
const accessJwt = process.env.RECOVERY_ACCESS_JWT;
const pdsUrl = process.env.RECOVERY_PDS_URL;
const operationId = process.env.RECOVERY_OPERATION_ID;
const resumeAll = process.env.RECOVERY_RESUME_ALL === "true";
const reconcileOnly = process.env.RECOVERY_RECONCILE_ONLY === "true";
const useStoredAuthorityGrant = process.env.RECOVERY_USE_STORED_AUTHORITY_GRANT === "true" || reconcileOnly;

if (!authorityDid || !actorDid || !workspaceUri || (!reconcileOnly && (!memberDid || !operationId)) || (!useStoredAuthorityGrant && (!accessJwt || !pdsUrl))) {
  throw new Error("Recovery subprocess inputs are incomplete.");
}

try {
  const session = useStoredAuthorityGrant
    ? await restoreAuthorityGrant(authorityDid)
    : {
        did: authorityDid,
        fetchHandler: async (path: string, init: RequestInit) => {
          const headers = new Headers(init.headers);
          headers.set("authorization", `Bearer ${accessJwt}`);
          return fetch(new URL(path, pdsUrl!), { ...init, headers, redirect: "error" });
        },
      };

  const actor = {
    did: actorDid,
    session: session as never,
    workspace: parseWorkspaceRef(workspaceUri),
    canRecoverOperations: true,
  };

  if (reconcileOnly) {
    await readGroupGovernanceState(session as never, authorityDid);
    if (adminMutationsPaused()) {
      process.stdout.write("authority session verified; mutations paused\n");
    } else {
      const reconciliation = await executeOperatorOperation(actor, tidNow(), { kind: "reconcileWorkspace" });
      process.stdout.write(`${reconciliation.state}\n`);
      if (reconciliation.state !== "completed") process.exitCode = 1;
    }
  } else {
    const result = resumeAll
      ? await executeOperatorOperation(actor, tidNow(), { kind: "reconcileWorkspace" })
      : await executeOperatorOperation(actor, operationId!, { kind: "removeMember", subject: memberDid! });
    const resumed = getRawDb().prepare("SELECT state FROM operation WHERE workspace = ? AND operation_id = ? ORDER BY created_at LIMIT 1")
      .get(actor.workspace.authorityDid, operationId!) as { state: string } | undefined;
    const reconciliation = resumeAll ? result : await executeOperatorOperation(actor, tidNow(), { kind: "reconcileWorkspace" });
    process.stdout.write(JSON.stringify({
      ...result,
      resumedOperationState: resumed?.state ?? null,
      reconciliationState: reconciliation.state,
    }));
    if (result.state !== "completed" || resumed?.state !== "completed" || reconciliation.state !== "completed") process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`reconciliation failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  getRawDb().close();
}
