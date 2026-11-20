import { listAllSpaceUris, listBoundedRecords, listBoundedWriters } from "@flock/protocol/atproto/record-pages";
import { isAccessLost, isSpaceDeleted } from "@flock/protocol/atproto/space-credential-core";
import { isMissingXrpcResource } from "@flock/protocol/atproto/xrpc";
import { mapLimited } from "@flock/protocol/map-limited";
import { readUpstreamJson } from "@flock/protocol/bounded-json";
import { acceptanceRecordKey, decisionRecordKey, inboxUri, isDid, parseWorkspaceUri } from "@flock/protocol/keys";
import { COLLECTION, REPO_COLLECTION, SPACE_TYPE } from "@flock/protocol/nsids";
import { MAX_RECORD_BYTES, validateAppDeclaration, validateSpaceRecord } from "@flock/protocol/registry";
import { summarizeWorkspace, WORKSPACE_ENVELOPE, WorkspaceEnvelopeError, workspaceDegradedMessage, type WorkspaceSummary } from "@flock/protocol/workspace-summary";
import type { CredentialCache } from "./credentials";

export type { WorkspaceSummary };
import { readWriterJoinRequests, type InboxJoinRequest, type SkippedInboxWriter } from "./inbox-requests";
import type { Lifecycle } from "./lifecycle";
import type { OperatorClient } from "./operator-client";
import { transportNow, type ClientTransport } from "./transport";

const MAX_DISCOVERABLE_WORKSPACES = 1_000;
const MAX_INBOX_WRITERS = 2_000;
// Allows the `com.atproto.repo.getRecord` `{ uri, cid, value }` wrapper around a full 64 KiB declaration record;
// `validateAppDeclaration` still enforces `MAX_RECORD_BYTES` on `value` itself.
const MAX_DECLARATION_BYTES = MAX_RECORD_BYTES + 4 * 1024;

/** A slash command an app advertises in its public declaration. */
export type DeclaredCommand = { name: string; description?: string; usage?: string };

/** What an app account says it is, in its own repo: the name people see and the commands it offers. A label, never a grant. */
export type AppDeclaration = { name: string; description?: string; commands?: DeclaredCommand[] };

export type WorkspaceCompleteness = {
  rosterComplete: boolean;
  extensionsComplete: boolean;
  invalidRosterRecords: number;
  invalidExtInstallRecords: number;
};

export type DiscoveredWorkspace = WorkspaceSummary & WorkspaceCompleteness;

export type WorkspaceCandidate = { uri: string; authorityDid: string; skey: string };
export type WorkspaceDiscovery = { workspaces: DiscoveredWorkspace[]; candidates: WorkspaceCandidate[] };

export type WorkspaceClientDeps = {
  transport: ClientTransport;
  credentials: CredentialCache;
  lifecycle: Lifecycle;
  sync?: { markSpaceStale(space: string): Promise<void> };
};

/** The member's workspaces: finding them, accepting an invitation, and an admin's view of the inbox. */
export class WorkspaceClient {
  constructor(private readonly deps: WorkspaceClientDeps) {}

  /**
   * The account's app declaration, read from its own public repo, or null when it has none (or an invalid one). An admin's app
   * installs no account without one, and shows its name.
   */
  async appDeclaration(did: string): Promise<AppDeclaration | null> {
    if (!isDid(did)) throw new TypeError("An app is named by its DID.");
    const url = new URL("/xrpc/com.atproto.repo.getRecord", await this.deps.transport.resolvePds(did));
    for (const [name, value] of Object.entries({ repo: did, collection: REPO_COLLECTION.appDeclaration, rkey: "self" })) url.searchParams.set(name, value);
    const response = await this.deps.transport.fetchEndpoint(new Request(url, { headers: { accept: "application/json" } }));
    const body = await readUpstreamJson<{ value?: unknown; error?: string }>(response, MAX_DECLARATION_BYTES);
    if (!response.ok) {
      if (body?.error === "RecordNotFound") return null;
      throw new Error(`Could not read the app declaration of ${did} (${response.status}).`);
    }
    const value = body?.value;
    if (!validateAppDeclaration(value).valid) return null;
    const { name, description, commands } = value as {
      name: string;
      description?: string;
      commands?: Array<{ name: string; description?: string; usage?: string }>;
    };
    return {
      name,
      ...(description === undefined ? {} : { description }),
      ...(commands === undefined
        ? {}
        : {
          commands: commands.map((command) => ({
            name: command.name,
            ...(command.description === undefined ? {} : { description: command.description }),
            ...(command.usage === undefined ? {} : { usage: command.usage }),
          })),
        }),
    };
  }

  /** The DID an admin means by an account they typed: a DID as it is, or a handle resolved by the signed-in account's own host. */
  async resolveAccount(account: string): Promise<string> {
    const input = account.trim().replace(/^@/, "");
    if (isDid(input)) return input;
    const { did } = await this.deps.transport.memberClient.query<{ did: string }>("com.atproto.identity.resolveHandle", { handle: input });
    if (!isDid(did)) throw new Error(`The handle ${input} did not resolve to a DID.`);
    return did;
  }

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
   * One workspace, or null when its authority records are invalid. Its channels no longer in the directory and extension
   * spaces no longer active are dropped, unless their respective scans stopped at their bounds. `fresh` mints a new
   * credential, so a removal or deletion is noticed now.
   */
  async summary(uri: string, options: { fresh?: boolean } = {}): Promise<DiscoveredWorkspace | null> {
    const workspace = parseWorkspaceUri(uri);
    if (!workspace) return null;
    const { authorityDid } = workspace;
    if (options.fresh) {
      await this.deps.credentials.fresh(uri);
    }
    await this.deps.sync?.markSpaceStale(uri);
    const client = await this.deps.credentials.clientFor(uri, authorityDid);
    const scan = (collection: string, maxRecords: number) => listBoundedRecords(client, { space: uri, repo: authorityDid, collection, maxRecords });
    const [profiles, directory, roster, admins, installs, extInstalls] = await Promise.all([
      scan(COLLECTION.workspaceProfile, 1),
      scan(COLLECTION.directory, WORKSPACE_ENVELOPE.authorityRecordScan),
      scan(COLLECTION.workspaceRoster, WORKSPACE_ENVELOPE.authorityRecordScan),
      scan(COLLECTION.admin, WORKSPACE_ENVELOPE.authorityRecordScan),
      scan(COLLECTION.appInstall, WORKSPACE_ENVELOPE.authorityRecordScan),
      scan(COLLECTION.extInstall, WORKSPACE_ENVELOPE.authorityRecordScan),
    ]);
    const summary = summarizeWorkspace(uri, this.deps.transport.did, { profiles, directory, roster, admins, installs, extInstalls });
    if (!summary) {
      await this.deps.lifecycle.dropSpace(uri);
      return null;
    }
    const invalidRosterRecords = countInvalidAuthorityRecords(COLLECTION.workspaceRoster, roster.records, authorityDid, uri);
    const invalidExtInstallRecords = countInvalidAuthorityRecords(COLLECTION.extInstall, extInstalls.records, authorityDid, uri);
    const activeExtensions = (summary.extensions ?? []).filter((ext) => ext.active);
    const rosterComplete = !roster.truncated && invalidRosterRecords === 0 && summary.members.length <= WORKSPACE_ENVELOPE.members;
    const extensionsComplete = !extInstalls.truncated && invalidExtInstallRecords === 0 && activeExtensions.length <= WORKSPACE_ENVELOPE.extensions;
    await this.deps.lifecycle.keepWorkspaceSpaces(uri, {
      ...(directory.truncated ? {} : { channels: summary.channels.map((channel) => channel.uri) }),
      ...(extInstalls.truncated ? {} : { extensions: activeExtensions.map((ext) => ext.space) }),
    });
    return {
      ...summary,
      rosterComplete,
      extensionsComplete,
      invalidRosterRecords,
      invalidExtInstallRecords,
    };
  }

  async requireSummary(uri: string): Promise<DiscoveredWorkspace> {
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
   * writers read are the union of the operator's inbox-writer list and the authority's `listWriters`; a writer that cannot be
   * read is skipped and reported, and a request with a current decision is not shown.
   */
  async inboxRequests(workspace: string, operator: OperatorClient): Promise<{ requests: InboxJoinRequest[]; skipped: SkippedInboxWriter[] }> {
    const summary = await this.requireSummary(workspace);
    if (!summary.isAdmin) throw new Error("Active workspace admin permission is required.");
    if (summary.degradedReasons.length > 0) throw new WorkspaceEnvelopeError(workspaceDegradedMessage(summary.degradedReasons));
    const candidates = await operator.listInboxWriters(workspace);
    const inbox = inboxUri(summary.authorityDid, summary.skey);
    const authority = await this.deps.credentials.clientFor(inbox, summary.authorityDid);
    const repoScan = await listBoundedWriters(authority, { space: inbox, maxRepos: MAX_INBOX_WRITERS });
    if (repoScan.truncated) throw new WorkspaceEnvelopeError(`Inbox writer set exceeds the ${MAX_INBOX_WRITERS}-repo scan limit; inbox results are incomplete.`);
    const writers = new Set([...candidates.writers, ...repoScan.writers.map((writer) => writer.repo)]);
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

function countInvalidAuthorityRecords(
  collection: string,
  records: ReadonlyArray<{ rkey: string; value: Record<string, unknown> }>,
  authorityDid: string,
  spaceUri: string,
): number {
  return records.filter((record) => !validateSpaceRecord(collection, record.value, {
    authorityDid,
    spaceUri,
    repoDid: authorityDid,
    rkey: record.rkey,
  }).valid).length;
}
