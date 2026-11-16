import { hasAuthorityGrant, restoreAuthorityGrant } from "../src/operator/authority-grant";
import { requireWorkspaceOperator } from "../src/operator/security";
import { executeOperatorOperation, resumePendingWorkspaceCreations } from "../src/operator/operations";
import { hasUncoveredAppInbox } from "../src/operator/kinds/reconcile-workspace";
import { listJournaledWorkspaces, listStalledOperations } from "../src/operator/journal";
import { tidNow } from "@flock/protocol/keys";
import { assertOperatorWorkspaceWithinEnvelope } from "../src/operator/workspace-envelope";
import { registrationDeps, registrationProblems, sweepRegistrations } from "../src/operator/registrations";
import { pruneNotices } from "../src/operator/notices";
import { adminMutationsPaused } from "../src/operator/mutations-paused";

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
      // The job is the operator itself, not an admin: a workspace under a dedicated account gives its authority no admin record.
      if (mutationsPaused) {
        await requireWorkspaceOperator(workspace.uri);
        process.stdout.write(`${workspace.uri}: authority session verified; mutations paused\n`);
        continue;
      }
      const session = await restoreAuthorityGrant(workspace.authorityDid);
      const creationResults = await resumePendingWorkspaceCreations(session, workspace.uri, registrationDeps);
      if (creationResults.some((result) => result.state !== "completed")) {
        process.stderr.write(`${workspace.uri}: workspace creation recovery remains pending.\n`);
        failed = true;
        continue;
      }
      const actor = await requireWorkspaceOperator(workspace.uri);
      await assertOperatorWorkspaceWithinEnvelope(actor);
      const operation = await executeOperatorOperation(actor, tidNow(), { kind: "reconcileWorkspace" }, registrationDeps);
      process.stdout.write(`${workspace.uri}: ${operation.state}\n`);
      if (operation.state !== "completed") failed = true;
      else {
        try {
          if (await hasUncoveredAppInbox(actor)) {
            process.stderr.write(`WARN workspace=${workspace.uri} workspace account must approve its permission again for app commands to work\n`);
          }
        } catch {
          // A transient read after a completed reconcile does not fail the run; the next minute checks again.
        }
      }
    } catch (error) {
      // Every journaled workspace is an expected authority. Do not mistake a
      // revoked session or failed PDS read for an empty workspace list.
      process.stderr.write(`${workspace.uri}: reconciliation failed (${error instanceof Error ? error.name : "unknown error"}).\n`);
      failed = true;
    }
  }
  // Local only, so it runs while mutations are paused too, and before the sweep, which can throw: week-old notices, and
  // registrations that ran out a month ago.
  pruneNotices();
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
