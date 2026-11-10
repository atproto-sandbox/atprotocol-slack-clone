import { executeOperatorOperation } from "@/operator/operations";
import { parseWorkspaceRef } from "@/operator/actor";
import { discoverWorkspaces } from "@/workspaces/read-model";
import { tidNow } from "@/protocol/keys";
import { getRawDb } from "@/lib/db";
import { getOAuthClientForSession } from "@/auth/oauth";
import { restoreAuthorityGrant } from "@/operator/authority-grant";

const authorityDid = process.env.RECOVERY_AUTHORITY_DID;
const workspaceUri = process.env.RECOVERY_WORKSPACE;
const memberDid = process.env.RECOVERY_MEMBER_DID;
const accessJwt = process.env.RECOVERY_ACCESS_JWT;
const pdsUrl = process.env.RECOVERY_PDS_URL;
const operationId = process.env.RECOVERY_OPERATION_ID;
const resumeAll = process.env.RECOVERY_RESUME_ALL === "true";
const useStoredAuthorityGrant = process.env.RECOVERY_USE_STORED_AUTHORITY_GRANT === "true";
if (!authorityDid || !workspaceUri || !memberDid || !operationId || (!useStoredAuthorityGrant && (!accessJwt || !pdsUrl))) {
  throw new Error("Recovery subprocess inputs are incomplete.");
}

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

try {
  const actor = {
    did: authorityDid,
    session: session as never,
    workspace: parseWorkspaceRef(workspaceUri),
    canRecoverOperations: true,
  };
  const result = resumeAll
    ? await executeOperatorOperation(actor, tidNow(), { kind: "reconcileWorkspace" })
    : await executeOperatorOperation(actor, operationId, { kind: "removeMember", subject: memberDid });
  const resumed = getRawDb().prepare("SELECT state FROM operation WHERE workspace = ? AND operation_id = ? ORDER BY created_at LIMIT 1")
    .get(actor.workspace.authorityDid, operationId) as { state: string } | undefined;
  // Discovery is what a member does, with the owner's own sign-in restored from the same database, not with the grant.
  const memberSession = useStoredAuthorityGrant ? await (await getOAuthClientForSession(authorityDid)).restore(authorityDid) : session;
  const discoveredWorkspaces = (await discoverWorkspaces(memberSession as never)).map(({ uri }) => uri);
  const reconciliation = resumeAll ? result : await executeOperatorOperation(actor, tidNow(), { kind: "reconcileWorkspace" });
  process.stdout.write(JSON.stringify({
    ...result,
    resumedOperationState: resumed?.state ?? null,
    discoveredWorkspaces,
    reconciliationState: reconciliation.state,
  }));
  if (result.state !== "completed" || resumed?.state !== "completed" || reconciliation.state !== "completed") process.exitCode = 1;
} finally {
  getRawDb().close();
}
