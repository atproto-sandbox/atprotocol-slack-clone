import { hasAuthorityGrant, restoreAuthorityGrant } from "@/operator/authority-grant";
import { requireActiveWorkspaceAdmin } from "@/operator/security";
import { executeOperatorOperation } from "@/operator/operations";
import { listJournaledWorkspaces, listStalledOperations } from "@/operator/journal";
import { tidNow } from "@/protocol/keys";
import { resumePendingWorkspaceBootstraps } from "@/operator/kinds/bootstrap-workspace";
import { assertOperatorWorkspaceWithinEnvelope } from "@/operator/workspace-envelope";
import { registrationDeps, registrationProblems, sweepRegistrations } from "@/operator/registrations";
import { adminMutationsPaused } from "@/operator/mutations-paused";

async function main() {
  let failed = false;
  const mutationsPaused = adminMutationsPaused();
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
      const bootstrapResults = await resumePendingWorkspaceBootstraps(session, workspace.uri, registrationDeps);
      if (bootstrapResults.some((result) => result.state !== "completed")) {
        process.stderr.write(`${workspace.uri}: workspace bootstrap recovery remains pending.\n`);
        failed = true;
        continue;
      }
      const actor = await requireActiveWorkspaceAdmin(workspace.uri, session.did);
      await assertOperatorWorkspaceWithinEnvelope(actor);
      const operation = await executeOperatorOperation(actor, tidNow(), { kind: "reconcileWorkspace" }, registrationDeps);
      process.stdout.write(`${workspace.uri}: ${operation.state}\n`);
      if (operation.state !== "completed") failed = true;
    } catch (error) {
      // Every journaled workspace is an expected authority. Do not mistake a
      // revoked session or failed PDS read for an empty workspace list.
      process.stderr.write(`${workspace.uri}: reconciliation failed (${error instanceof Error ? error.name : "unknown error"}).\n`);
      failed = true;
    }
  }
  // Notice registrations: backfilled and renewed at most every 30 minutes, whichever process gets there first, and not while
  // mutations are paused. A space without one gets no change ticks, so its clients fall back to their hourly check: worth a
  // warning and the admin screen, not a failed run.
  const sweep = await sweepRegistrations();
  if (sweep) process.stdout.write(`notice registrations: ${sweep.registered} registered, ${sweep.failed} failed\n`);
  for (const skipped of sweep?.skipped ?? []) process.stderr.write(`WARN notice registration sweep skipped workspace=${skipped.workspace} (${skipped.reason})\n`);
  for (const workspace of workspaces) {
    for (const problem of registrationProblems(workspace.uri)) {
      process.stderr.write(`WARN notice registration space=${problem.space} failures=${problem.failures}${problem.expiredAt ? ` expired=${problem.expiredAt}` : ""}\n`);
    }
  }
  if (failed) process.exitCode = 1;
}

await main();
