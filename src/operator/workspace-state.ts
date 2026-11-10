import type { OAuthSession } from "@atproto/oauth-client-node";
import type * as GetRecord from "@/lexicons/api/types/com/atproto/space/getRecord";
import { sessionClient } from "@/atproto/client";
import { resolvePds } from "@/atproto/identity";
import { listBoundedRecords } from "@/atproto/record-pages";
import { classifyRepoFailure } from "@/atproto/repo-failure";
import { mintSpaceCredential } from "@/atproto/space-credential";
import { listSpaceMembers, putAuthorityRecord } from "@/atproto/space-ops";
import { isMissingXrpcResource, type AtprotoClient } from "@/atproto/xrpc";
import { parseSpaceRecordUri, subjectKey } from "@/protocol/keys";
import { COLLECTION, type Collection } from "@/protocol/nsids";
import { validateSpaceRecord } from "@/protocol/registry";
import { WORKSPACE_ENVELOPE, WorkspaceEnvelopeError } from "@/protocol/workspace-summary";
import { OperationRejectedError } from "./journal";
import type { OperatorActor } from "./actor";

// What the operator reads and writes of a workspace's state, shared by every operation kind: the authority's own records
// (directory, rosters, admins), PDS member lists, and join requests.

const MAX_AUTHORITY_RECORD_SCAN = WORKSPACE_ENVELOPE.authorityRecordScan;

export async function activePrivateRoster(actor: OperatorActor, space: string): Promise<Set<string>> {
  const rows = await listOwnerRecords(actor.session, space, COLLECTION.channelRoster);
  const members = new Set(rows.flatMap((row) => row.value && validateSpaceRecord(COLLECTION.channelRoster, row.value, {
    authorityDid: actor.workspace.authorityDid, spaceUri: space, repoDid: actor.workspace.authorityDid, rkey: row.rkey,
  }).valid && row.value.active === true && typeof row.value.subject === "string" ? [row.value.subject] : []));
  if (members.size > 200) throw new WorkspaceEnvelopeError("Private-channel roster exceeds 200 active members.");
  return members;
}

export async function readJoinRequest(session: OAuthSession, inbox: string, repoDid: string, rkey: string, authorityDid: string): Promise<Record<string, unknown> | null> {
  const credential = await mintSpaceCredential(session, inbox);
  return readJoinRequestRecord(credential.client(await resolvePds(repoDid)), inbox, repoDid, rkey, authorityDid);
}

/**
 * The requester's join request, or null when there is no current one to act on. A repo that cannot be authenticated (no
 * usable `#atproto_kem` key, or a MAC that does not verify) reads as null: the decision is rejected and any partial approval
 * is undone, instead of the journal keeping the operation pending and every later admin operation replaying the same failure.
 */
export async function readJoinRequestRecord(
  client: Pick<AtprotoClient, "query">,
  inbox: string,
  repoDid: string,
  rkey: string,
  authorityDid: string,
): Promise<Record<string, unknown> | null> {
  try {
    const result = await client.query<GetRecord.OutputSchema>("com.atproto.space.getRecord", {
      space: inbox, repo: repoDid, collection: COLLECTION.joinRequest, rkey,
    });
    return validateSpaceRecord(COLLECTION.joinRequest, result.value, {
      authorityDid, spaceUri: inbox, repoDid, rkey,
    }).valid ? result.value : null;
  } catch (error) {
    // A repo that is gone for good (deactivated, taken down, unauthenticated, oversized) will fail the same way on every replay, so
    // it reads as no current request; a host that is merely down still fails the operation so it can be retried.
    if (isNotFound(error) || classifyRepoFailure(error)?.permanent) return null;
    throw error;
  }
}

export async function directoryRecords(actor: OperatorActor): Promise<Array<{ rkey: string; value: Record<string, unknown> & { skey: string; name: string; visibility: string } }>> {
  const rows = await listOwnerRecords(actor.session, actor.workspace.uri, COLLECTION.directory);
  const channels = rows.filter((row): row is typeof row & { value: Record<string, unknown> & { skey: string; name: string; visibility: string } } =>
    Boolean(row.value && validateSpaceRecord(COLLECTION.directory, row.value, {
      authorityDid: actor.workspace.authorityDid, spaceUri: actor.workspace.uri, repoDid: actor.workspace.authorityDid, rkey: row.rkey,
    }).valid) && typeof row.value?.skey === "string" && typeof row.value.name === "string" && typeof row.value.visibility === "string",
  );
  if (channels.filter(({ value }) => value.visibility !== "archived").length > 100) {
    throw new WorkspaceEnvelopeError("The active channel count exceeds 100 channels.");
  }
  return channels;
}

export async function activeRoster(actor: OperatorActor): Promise<Set<string>> {
  const rows = await listOwnerRecords(actor.session, actor.workspace.uri, COLLECTION.workspaceRoster, MAX_AUTHORITY_RECORD_SCAN);
  const members = new Set(rows.flatMap((row) => row.value && validateSpaceRecord(COLLECTION.workspaceRoster, row.value, {
    authorityDid: actor.workspace.authorityDid, spaceUri: actor.workspace.uri, repoDid: actor.workspace.authorityDid, rkey: row.rkey,
  }).valid && row.value.active === true && typeof row.value.subject === "string" ? [row.value.subject] : []));
  if (members.size > 200) throw new WorkspaceEnvelopeError("The active workspace roster exceeds 200 members.");
  return members;
}

export async function currentWorkspaceMembers(actor: OperatorActor): Promise<Set<string>> {
  const [roster, pdsMembers] = await Promise.all([
    activeRoster(actor),
    listSpaceMembers(actor.session, actor.workspace.uri),
  ]);
  assertWorkspaceRosterMatchesPds(roster, pdsMembers, actor.workspace.authorityDid);
  return roster;
}

export function assertWorkspaceRosterMatchesPds(
  roster: ReadonlySet<string>,
  pdsMembers: ReadonlyArray<{ did: string; read: boolean; write: boolean }>,
  authorityDid: string,
): void {
  for (const did of roster) {
    if (did === authorityDid) continue;
    const member = pdsMembers.find((entry) => entry.did === did);
    if (!member || !member.read || !member.write) {
      throw new OperationRejectedError("Workspace roster has not converged with PDS membership.");
    }
  }
  for (const member of pdsMembers) {
    if (member.did === authorityDid || (!member.read && !member.write)) continue;
    if (!roster.has(member.did) || !member.read || !member.write) {
      throw new OperationRejectedError("Workspace roster has not converged with PDS membership.");
    }
  }
}

export async function activeAdmins(actor: OperatorActor): Promise<Set<string>> {
  const rows = await listOwnerRecords(actor.session, actor.workspace.uri, COLLECTION.admin);
  const members = await activeRoster(actor);
  const workspaceMembers = new Set((await listSpaceMembers(actor.session, actor.workspace.uri))
    .filter((member) => member.read && member.write).map((member) => member.did));
  const admins = new Set(rows.flatMap((row) => row.value && validateSpaceRecord(COLLECTION.admin, row.value, {
    authorityDid: actor.workspace.authorityDid, spaceUri: actor.workspace.uri, repoDid: actor.workspace.authorityDid, rkey: row.rkey,
  }).valid && row.value.active === true && typeof row.value.subject === "string" && members.has(row.value.subject) &&
    (row.value.subject === actor.workspace.authorityDid || workspaceMembers.has(row.value.subject)) ? [row.value.subject] : []));
  if (admins.size === 0) throw new Error("Workspace has no active admin record.");
  if (admins.size > 200) throw new WorkspaceEnvelopeError("The active admin count exceeds 200 members.");
  return admins;
}

export async function hasActiveAdminRecord(actor: OperatorActor, subject: string): Promise<boolean> {
  const record = await getOwnerRecord(actor.session, actor.workspace.uri, COLLECTION.admin, subjectKey(subject));
  return record?.subject === subject && record.active === true;
}

export async function listOwnerRecords(
  session: OAuthSession,
  space: string,
  collection: string,
  maxRecords = MAX_AUTHORITY_RECORD_SCAN,
): Promise<Array<{ rkey: string; value: Record<string, unknown> }>> {
  const result = await listBoundedRecords(sessionClient(session), { space, repo: session.did, collection, maxRecords });
  if (result.truncated) {
    throw new WorkspaceEnvelopeError(`The ${collection} record scan exceeds its ${maxRecords}-record limit; operator state may be incomplete.`);
  }
  return result.records;
}

export async function getOwnerRecord(session: OAuthSession, space: string, collection: string, rkey: string): Promise<Record<string, unknown> | null> {
  try {
    const result = await sessionClient(session).query<GetRecord.OutputSchema>("com.atproto.space.getRecord", {
      space, repo: session.did, collection, rkey,
    });
    return validateSpaceRecord(collection, result.value, {
      authorityDid: session.did, spaceUri: space, repoDid: session.did, rkey,
    }).valid ? result.value : null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function writeRoster(actor: OperatorActor, space: string, did: string, active: boolean, collection: Collection = COLLECTION.workspaceRoster): Promise<void> {
  await putAuthorityRecord(actor.session, space, collection, subjectKey(did), { subject: did, active, updatedAt: new Date().toISOString() });
}

export async function assertMembership(actor: OperatorActor, space: string, did: string, read: boolean, write: boolean): Promise<void> {
  const member = (await listSpaceMembers(actor.session, space)).find((entry) => entry.did === did);
  if (!member || member.read !== read || member.write !== write) throw new Error("PDS membership has not converged to the requested state.");
}

export async function assertNoMembership(actor: OperatorActor, space: string, did: string): Promise<void> {
  if ((await listSpaceMembers(actor.session, space)).some((entry) => entry.did === did)) throw new Error("PDS membership removal has not converged.");
}

export function parseJoinRequestUri(uri: string, authorityDid: string, inbox: string): { repo: string; rkey: string } | null {
  const parsed = parseSpaceRecordUri(uri, inbox, COLLECTION.joinRequest);
  return !parsed || parsed.repo === authorityDid ? null : parsed;
}

export function isNotFound(error: unknown): boolean {
  return isMissingXrpcResource(error);
}
