import type { OAuthSession } from "@atproto/oauth-client-node";
import type * as CreateSpace from "@flock/protocol/lexicons/api/types/com/atproto/space/createSpace";
import type * as GetSpace from "@flock/protocol/lexicons/api/types/com/atproto/space/getSpace";
import type * as MemberspaceDefs from "@flock/protocol/lexicons/api/types/com/atproto/memberspace/defs";
import type * as PutMembers from "@flock/protocol/lexicons/api/types/com/atproto/memberspace/putMembers";
import type * as RemoveMembers from "@flock/protocol/lexicons/api/types/com/atproto/memberspace/removeMembers";
import type * as PutRecord from "@flock/protocol/lexicons/api/types/com/atproto/space/putRecord";
import type * as ListRecords from "@flock/protocol/lexicons/api/types/com/atproto/space/listRecords";
import { resolvePds } from "./identity";
import { sessionClient, serviceClient } from "./client";
import { mintSpaceCredential } from "./space-credential";
import { isMemberListOnly, memberspacePolicy } from "@flock/protocol/atproto/space-policy";
import { validateSpaceRecord } from "@flock/protocol/registry";
import { assertBoundedRecordPage, listBoundedMembers } from "@flock/protocol/atproto/record-pages";
import { isScopeMissingError, isSpaceAlreadyExists, XrpcError } from "@flock/protocol/atproto/xrpc";
import { requireSpaceAuthority, spaceRecordUri, spaceUri } from "@flock/protocol/keys";
import { WORKSPACE_ENVELOPE, WorkspaceEnvelopeError } from "@flock/protocol/workspace-summary";

const MAX_MEMBER_BATCH = 100;

export async function ensureMemberListSpace(
  session: OAuthSession,
  type: string,
  skey: string,
): Promise<string> {
  const uri = spaceUri(session.did, type, skey);
  const client = sessionClient(session);
  try {
    const result = await client.procedure<CreateSpace.InputSchema, CreateSpace.OutputSchema>(
      "com.atproto.space.createSpace",
      { spaceType: type, skey, policy: memberspacePolicy() },
    );
    return result.space;
  } catch (error) {
    if (!isSpaceAlreadyExists(error)) throw error;
    const current = await client.query<GetSpace.OutputSchema>("com.atproto.space.getSpace", { space: uri });
    if (!isMemberListOnly(current.policy)) throw new Error(`Space already exists with an incompatible policy: ${uri}`);
    return current.space;
  }
}

/** Whether the session's account has this space live: its host answers `getSpace` with anything but `SpaceNotFound`. */
export async function spaceExists(session: OAuthSession, space: string): Promise<boolean> {
  try {
    await sessionClient(session).query<GetSpace.OutputSchema>("com.atproto.space.getSpace", { space });
    return true;
  } catch (error) {
    if (error instanceof XrpcError && error.code === "SpaceNotFound") return false;
    throw error;
  }
}

export type AppInboxState = "present" | "missing" | "uncovered";

/**
 * Whether an install's inbox exists at its authority: `present`, `missing` (the grant covers the type and the space has not
 * been created), or `uncovered` (the authority's grant predates the inbox type, so `getSpace` is refused for a missing scope
 * and no inbox was ever created).
 */
export async function appInboxState(session: OAuthSession, space: string): Promise<AppInboxState> {
  try {
    await sessionClient(session).query<GetSpace.OutputSchema>("com.atproto.space.getSpace", { space });
    return "present";
  } catch (error) {
    if (error instanceof XrpcError && error.code === "SpaceNotFound") return "missing";
    if (isScopeMissingError(error)) return "uncovered";
    throw error;
  }
}

export async function putSpaceMembers(
  session: OAuthSession,
  space: string,
  members: ReadonlyArray<{ did: string; read: boolean; write: boolean }>,
): Promise<void> {
  if (members.length === 0) return;
  const client = sessionClient(session);
  for (let offset = 0; offset < members.length; offset += MAX_MEMBER_BATCH) {
    const chunk = members.slice(offset, offset + MAX_MEMBER_BATCH).map(({ did, read, write }) => ({ did, read, write }));
    await client.procedure<PutMembers.InputSchema, unknown>(
      "com.atproto.memberspace.putMembers",
      { space, members: chunk },
    );
  }
}

export async function putSpaceMember(
  session: OAuthSession,
  space: string,
  did: string,
  read: boolean,
  write: boolean,
): Promise<void> {
  await putSpaceMembers(session, space, [{ did, read, write }]);
}

export async function removeSpaceMembers(session: OAuthSession, space: string, dids: readonly string[]): Promise<void> {
  if (dids.length === 0) return;
  const client = sessionClient(session);
  for (let offset = 0; offset < dids.length; offset += MAX_MEMBER_BATCH) {
    const chunk = dids.slice(offset, offset + MAX_MEMBER_BATCH);
    await client.procedure<RemoveMembers.InputSchema, unknown>(
      "com.atproto.memberspace.removeMembers",
      { space, dids: chunk },
    );
  }
}

export async function removeSpaceMember(session: OAuthSession, space: string, did: string): Promise<void> {
  await removeSpaceMembers(session, space, [did]);
}

export async function listSpaceMembers(session: OAuthSession, space: string): Promise<MemberspaceDefs.Member[]> {
  const result = await listBoundedMembers(sessionClient(session), { space, maxMembers: WORKSPACE_ENVELOPE.memberList });
  if (result.truncated) throw new WorkspaceEnvelopeError(`PDS member list exceeds its ${WORKSPACE_ENVELOPE.memberList}-entry scan limit (people and apps); operator state may be incomplete.`);
  return result.members;
}

export async function putAuthorityRecord(
  session: OAuthSession,
  space: string,
  collection: string,
  rkey: string,
  value: Record<string, unknown>,
): Promise<PutRecord.OutputSchema> {
  const authorityDid = requireSpaceAuthority(space);
  if (authorityDid !== session.did) throw new Error("Authority record must be written by the space authority.");
  const record = { $type: collection, ...value };
  const validation = validateSpaceRecord(collection, record, { authorityDid, spaceUri: space, repoDid: session.did, rkey });
  if (!validation.valid) throw new Error(`Invalid ${collection} record: ${validation.reason}`);
  return sessionClient(session).procedure<PutRecord.InputSchema, PutRecord.OutputSchema>(
    "com.atproto.space.putRecord",
    { space, repo: session.did, collection, rkey, record },
  );
}

export async function readSpaceRecords<T extends Record<string, unknown>>(
  session: OAuthSession,
  space: string,
  repoDid: string,
  collection: string,
  limit = 100,
): Promise<Array<{ uri: string; rkey: string; value: T }>> {
  const credential = await mintSpaceCredential(session, space);
  const pds = await resolvePds(repoDid);
  const page = await credential.client(pds).query<ListRecords.OutputSchema>(
    "com.atproto.space.listRecords", { space, repo: repoDid, collection, limit },
  );
  assertBoundedRecordPage(page, { collection, limit });
  return page.records.flatMap((record) => record.value ? [{
    uri: spaceRecordUri(space, repoDid, collection, record.rkey), rkey: record.rkey, value: record.value as T,
  }] : []);
}

export async function putMemberRecord(
  session: OAuthSession,
  space: string,
  collection: string,
  rkey: string,
  value: Record<string, unknown>,
  context: { knownMessages?: ReadonlySet<string>; knownTopLevelMessages?: ReadonlySet<string> } = {},
): Promise<string> {
  const authorityDid = requireSpaceAuthority(space);
  const record = { $type: collection, ...value };
  const validation = validateSpaceRecord(collection, record, {
    authorityDid, spaceUri: space, repoDid: session.did, rkey,
    knownMessages: context.knownMessages, knownTopLevelMessages: context.knownTopLevelMessages,
  });
  if (!validation.valid) throw new Error(`Invalid ${collection} record: ${validation.reason}`);
  const result = await sessionClient(session).procedure<PutRecord.InputSchema, PutRecord.OutputSchema>(
    "com.atproto.space.putRecord",
    { space, repo: session.did, collection, rkey, record },
  );
  return result.uri;
}

export async function publicServiceClientForDid(did: string) {
  return serviceClient(await resolvePds(did));
}
