import { hasAuthorityGrant, restoreAuthorityGrant } from "@/operator/authority-grant";
import { requireActiveWorkspaceAdmin } from "@/operator/security";
import { executeOperatorOperation } from "@/operator/operations";
import { listJournaledWorkspaces, listStalledOperations } from "@/operator/journal";
import { tidNow } from "@/protocol/keys";
import { resumePendingWorkspaceBootstraps } from "@/operator/kinds/bootstrap-workspace";
import { assertOperatorWorkspaceWithinEnvelope } from "@/operator/workspace-envelope";

async function main() {
  let failed = false;
  const mutationsPaused = process.env.FLOCK_ADMIN_MUTATIONS_PAUSED === "true";
  const workspaces = listJournaledWorkspaces();
  for (const workspace of workspaces) {
    const stalledResult = listStalledOperations(workspace.authorityDid, workspace.uri);
    for (const stalled of stalledResult.operations) {
      process.stderr.write(`ALERT stalled operation ${stalled.operationId} actor=${stalled.actor} state=${stalled.state} since=${stalled.updatedAt}\n`);
      failed = true;
    }
    if (stalledResult.truncated) {
      process.stderr.write(`ALERT workspace=${workspace.uri} has more than 100 stalled operations; only the oldest 100 were listed.\n`);
      failed = true;
    }
  }

  if (mutationsPaused) process.stdout.write("Admin mutations are paused; only read-only authority checks will run.\n");
  for (const workspace of workspaces) {
    if (!hasAuthorityGrant(workspace.authorityDid)) {
      process.stderr.write(`ALERT workspace authority grant is missing workspace=${workspace.uri}\n`);
      failed = true;
      continue;
    }
    try {
      if (mutationsPaused) {
        await requireActiveWorkspaceAdmin(workspace.uri, workspace.authorityDid);
        process.stdout.write(`${workspace.uri}: authority session and admin access verified; mutations paused\n`);
        continue;
      }
      const session = await restoreAuthorityGrant(workspace.authorityDid);
      const bootstrapResults = await resumePendingWorkspaceBootstraps(session, workspace.uri);
      if (bootstrapResults.some((result) => result.state !== "completed")) {
        process.stderr.write(`${workspace.uri}: workspace bootstrap recovery remains pending.\n`);
        failed = true;
        continue;
      }
      const actor = await requireActiveWorkspaceAdmin(workspace.uri, session.did);
      await assertOperatorWorkspaceWithinEnvelope(actor);
      const operation = await executeOperatorOperation(actor, tidNow(), { kind: "reconcileWorkspace" });
      process.stdout.write(`${workspace.uri}: ${operation.state}\n`);
      if (operation.state !== "completed") failed = true;
    } catch (error) {
      // Every journaled workspace is an expected authority. Do not mistake a
      // revoked session or failed PDS read for an empty workspace list.
      process.stderr.write(`${workspace.uri}: reconciliation failed (${error instanceof Error ? error.name : "unknown error"}).\n`);
      failed = true;
    }
  }
  if (failed) process.exitCode = 1;
}

await main();
