import { listAllSpaceUris, listBoundedRecords, listBoundedRepos } from "@/atproto/record-pages";
import { isAccessLost, isSpaceDeleted } from "@/atproto/space-credential-core";
import { isMissingXrpcResource } from "@/atproto/xrpc";
import { mapLimited } from "@/lib/map-limited";
import { acceptanceRecordKey, decisionRecordKey, inboxUri, parseWorkspaceUri } from "@/protocol/keys";
import { COLLECTION, SPACE_TYPE } from "@/protocol/nsids";
import { validateSpaceRecord } from "@/protocol/registry";
import { summarizeWorkspace, WORKSPACE_ENVELOPE, WorkspaceEnvelopeError, workspaceDegradedMessage, type WorkspaceSummary } from "@/protocol/workspace-summary";
import type { CredentialCache } from "./credentials";
import { readWriterJoinRequests, type InboxJoinRequest, type SkippedInboxWriter } from "./inbox-requests";
import type { Lifecycle } from "./lifecycle";
import type { OperatorClient } from "./operator-client";
import { transportNow, type ClientTransport } from "./transport";

const MAX_DISCOVERABLE_WORKSPACES = 1_000;
const MAX_INBOX_WRITERS = 2_000;

export type WorkspaceCandidate = { uri: string; authorityDid: string; skey: string };
export type WorkspaceDiscovery = { workspaces: WorkspaceSummary[]; candidates: WorkspaceCandidate[] };

export type WorkspaceClientDeps = { transport: ClientTransport; credentials: CredentialCache; lifecycle: Lifecycle };

/** The member's workspaces: finding them, accepting an invitation, and an admin's view of the inbox. */
export class WorkspaceClient {
  constructor(private readonly deps: WorkspaceClientDeps) {}

  /**
   * Every workspace the account can see, read from its authority's records. A workspace whose credential is refused is an
   * invitation candidate unless it was deleted; one whose authority records are invalid is hidden. Workspaces no longer
   * listed, and the channels of each workspace no longer in its directory, are dropped from the store.
   */
  async discover(): Promise<WorkspaceDiscovery> {
    const spaces = await listAllSpaceUris(this.deps.transport.memberClient, { spaceType: SPACE_TYPE.workspace, maxSpaces: MAX_DISCOVERABLE_WORKSPACES });
    const results = await mapLimited(spaces, 8, async (uri) => {
      try {
        return { summary: await this.summary(uri, { fresh: true }), candidate: null };
      } catch (error) {
        if (!isAccessLost(error)) throw error;
        const workspace = parseWorkspaceUri(uri);
        return { summary: null, candidate: !isSpaceDeleted(error) && workspace ? { uri, ...workspace } : null };
      }
    });
    await this.deps.lifecycle.keepWorkspaces(results.flatMap(({ summary }) => (summary ? [summary.uri] : [])));
    return {
      workspaces: results.flatMap(({ summary }) => (summary ? [summary] : [])).sort((left, right) => left.name.localeCompare(right.name)),
      candidates: results.flatMap(({ candidate }) => (candidate ? [candidate] : [])).sort((left, right) => left.uri.localeCompare(right.uri)),
    };
  }

  /**
   * One workspace, or null when its authority records are invalid. Its channels no longer in the directory are dropped, unless
   * the directory scan stopped at its bound. `fresh` mints a new credential, so a removal or deletion is noticed now.
   */
  async summary(uri: string, options: { fresh?: boolean } = {}): Promise<WorkspaceSummary | null> {
    const workspace = parseWorkspaceUri(uri);
    if (!workspace) return null;
    const { authorityDid } = workspace;
    if (options.fresh) await this.deps.credentials.fresh(uri);
    const client = await this.deps.credentials.clientFor(uri, authorityDid);
    const scan = (collection: string, maxRecords: number) => listBoundedRecords(client, { space: uri, repo: authorityDid, collection, maxRecords });
    const [profiles, directory, roster, admins] = await Promise.all([
      scan(COLLECTION.workspaceProfile, 1),
      scan(COLLECTION.directory, WORKSPACE_ENVELOPE.authorityRecordScan),
      scan(COLLECTION.workspaceRoster, WORKSPACE_ENVELOPE.authorityRecordScan),
      scan(COLLECTION.admin, WORKSPACE_ENVELOPE.authorityRecordScan),
    ]);
    const summary = summarizeWorkspace(uri, this.deps.transport.did, { profiles, directory, roster, admins });
    if (!summary) {
      await this.deps.lifecycle.dropSpace(uri);
      return null;
    }
    if (!directory.truncated) await this.deps.lifecycle.keepChannels(uri, summary.channels.map((channel) => channel.uri));
    return summary;
  }

  async requireSummary(uri: string): Promise<WorkspaceSummary> {
    const summary = await this.summary(uri);
    if (!summary) throw new Error("Workspace could not be read or contains invalid authority records.");
    return summary;
  }

  /**
   * Accepts an invitation: a valid acceptance record in the workspace, written only after a credential proves the
   * invitation's membership is current. The known refusals come back as `acceptFailure` codes.
   */
  async accept(workspace: string): Promise<{ workspace: string; marker: string }> {
    const parsed = parseWorkspaceUri(workspace);
    if (!parsed) throw new Error("Invalid workspace URI.");
    const record = { $type: COLLECTION.acceptance, workspace, createdAt: new Date(transportNow(this.deps.transport)).toISOString() };
    const rkey = acceptanceRecordKey(workspace);
    const validation = validateSpaceRecord(COLLECTION.acceptance, record, { authorityDid: parsed.authorityDid, spaceUri: workspace, repoDid: this.deps.transport.did, rkey });
    if (!validation.valid) throw new Error(validation.reason);
    await this.deps.credentials.fresh(workspace);
    const result = await this.deps.transport.memberClient.procedure<unknown, { uri: string }>("com.atproto.space.putRecord", {
      space: workspace, repo: this.deps.transport.did, collection: COLLECTION.acceptance, rkey, record,
    });
    return { workspace, marker: result.uri };
  }

  /**
   * The open join requests an admin decides. Refused to anyone but an active admin and while the workspace is degraded. The
   * writers read are the union of the operator's inbox-writer list and the authority's `listRepos`; a writer that cannot be
   * read is skipped and reported, and a request with a current decision is not shown.
   */
  async inboxRequests(workspace: string, operator: OperatorClient): Promise<{ requests: InboxJoinRequest[]; skipped: SkippedInboxWriter[] }> {
    const summary = await this.requireSummary(workspace);
    if (!summary.isAdmin) throw new Error("Active workspace admin permission is required.");
    if (summary.degradedReasons.length > 0) throw new WorkspaceEnvelopeError(workspaceDegradedMessage(summary.degradedReasons));
    const candidates = await operator.listInboxWriters(workspace);
    const inbox = inboxUri(summary.authorityDid, summary.skey);
    const authority = await this.deps.credentials.clientFor(inbox, summary.authorityDid);
    const repoScan = await listBoundedRepos(authority, { space: inbox, maxRepos: MAX_INBOX_WRITERS });
    if (repoScan.truncated) throw new WorkspaceEnvelopeError(`Inbox writer set exceeds the ${MAX_INBOX_WRITERS}-repo scan limit; inbox results are incomplete.`);
    const writers = new Set([...candidates.writers, ...repoScan.repos.map((repo) => repo.did)]);
    const perWriter = await mapLimited([...writers], 8, (repoDid) => readWriterJoinRequests({
      clientFor: () => this.deps.credentials.clientFor(inbox, repoDid),
      inbox, repoDid, authorityDid: summary.authorityDid, channels: summary.channels,
    }));
    const current = await mapLimited(perWriter.flatMap((result) => result.requests), 8, async (request) => {
      const rkey = decisionRecordKey(request.uri);
      try {
        const decision = await authority.query<{ value: Record<string, unknown> }>("com.atproto.space.getRecord", {
          space: inbox, repo: summary.authorityDid, collection: COLLECTION.joinDecision, rkey,
        });
        const valid = validateSpaceRecord(COLLECTION.joinDecision, decision.value, { authorityDid: summary.authorityDid, spaceUri: inbox, repoDid: summary.authorityDid, rkey }).valid;
        return valid && decision.value.request === request.uri && decision.value.requestId === request.requestId ? null : request;
      } catch (error) {
        if (isMissingXrpcResource(error)) return request;
        throw error;
      }
    });
    return {
      requests: current.flatMap((request) => (request ? [request] : [])).sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
      skipped: perWriter.flatMap((result) => (result.skipped ? [result.skipped] : [])),
    };
  }
}
