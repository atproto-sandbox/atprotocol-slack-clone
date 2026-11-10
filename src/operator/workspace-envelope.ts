import { sessionClient } from "@/atproto/client";
import { listBoundedRecords } from "@/atproto/record-pages";
import { COLLECTION } from "@/protocol/nsids";
import { assertWorkspaceWithinEnvelope, summarizeWorkspace, WORKSPACE_ENVELOPE } from "@/protocol/workspace-summary";
import type { OperatorActor } from "./actor";

/**
 * Refuses admin changes while the workspace is outside the supported envelope, judged from the authority's own records,
 * read with the authority grant: the same records and the same rule as the member's view of the workspace.
 */
export async function assertOperatorWorkspaceWithinEnvelope(actor: OperatorActor): Promise<void> {
  const { uri, authorityDid } = actor.workspace;
  const client = sessionClient(actor.session);
  const scan = (collection: string, maxRecords: number) => listBoundedRecords(client, { space: uri, repo: authorityDid, collection, maxRecords });
  const [profiles, directory, roster, admins] = await Promise.all([
    scan(COLLECTION.workspaceProfile, 1),
    scan(COLLECTION.directory, WORKSPACE_ENVELOPE.authorityRecordScan),
    scan(COLLECTION.workspaceRoster, WORKSPACE_ENVELOPE.authorityRecordScan),
    scan(COLLECTION.admin, WORKSPACE_ENVELOPE.authorityRecordScan),
  ]);
  const summary = summarizeWorkspace(uri, authorityDid, { profiles, directory, roster, admins });
  if (!summary) throw new Error("Workspace could not be read or contains invalid authority records.");
  assertWorkspaceWithinEnvelope(summary);
}
