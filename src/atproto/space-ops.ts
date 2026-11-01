import type { OAuthSession } from "@atproto/oauth-client-node";
import type * as CreateSpace from "@/lexicons/api/types/com/atproto/space/createSpace";
import type * as GetSpace from "@/lexicons/api/types/com/atproto/space/getSpace";
import type * as ListMembers from "@/lexicons/api/types/com/atproto/memberspace/listMembers";
import type * as PutMember from "@/lexicons/api/types/com/atproto/memberspace/putMember";
import type * as RemoveMember from "@/lexicons/api/types/com/atproto/memberspace/removeMember";
import type * as PutRecord from "@/lexicons/api/types/com/atproto/space/putRecord";
import type * as ListRecords from "@/lexicons/api/types/com/atproto/space/listRecords";
import { resolvePds } from "./identity";
import { sessionClient, serviceClient } from "./client";
import { mintSpaceCredential } from "./space-credential";
import { isMemberListOnly, memberspacePolicy } from "./space-policy";
import { validateSpaceRecord } from "@/protocol/records";
import { assertBoundedRecordPage, listBoundedMembers } from "./record-pages";
import { spaceRecordUri } from "@/protocol/keys";
import { WorkspaceEnvelopeError } from "@/workspaces/read-model";

export async function ensureMemberListSpace(
  session: OAuthSession,
  type: string,
  skey: string,
): Promise<string> {
  const uri = `at://${session.did}/space/${type}/${skey}`;
  const client = sessionClient(session);
  try {
    const result = await client.procedure<CreateSpace.InputSchema, CreateSpace.OutputSchema>(
      "com.atproto.space.createSpace",
      { spaceType: type, skey, policy: memberspacePolicy() },
    );
    return result.uri;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const current = await client.query<GetSpace.OutputSchema>("com.atproto.space.getSpace", { space: uri });
    if (!isMemberListOnly(current.policy)) throw new Error(`Space already exists with an incompatible policy: ${uri}`);
    return current.uri;
  }
}

export async function putSpaceMember(
  session: OAuthSession,
  space: string,
  did: string,
  read: boolean,
  write: boolean,
): Promise<void> {
  await sessionClient(session).procedure<PutMember.InputSchema, unknown>(
    "com.atproto.memberspace.putMember", { space, did, read, write },
  );
}

export async function removeSpaceMember(session: OAuthSession, space: string, did: string): Promise<void> {
  await sessionClient(session).procedure<RemoveMember.InputSchema, unknown>(
    "com.atproto.memberspace.removeMember", { space, did },
  );
}

export async function listSpaceMembers(session: OAuthSession, space: string): Promise<ListMembers.Member[]> {
  const result = await listBoundedMembers(sessionClient(session), { space, maxMembers: 200 });
  if (result.truncated) throw new WorkspaceEnvelopeError("PDS member list exceeds the 200-member v1 scan limit; operator state may be incomplete.");
  return result.members;
}

export async function putAuthorityRecord(
  session: OAuthSession,
  space: string,
  collection: string,
  rkey: string,
  value: Record<string, unknown>,
): Promise<PutRecord.OutputSchema> {
  const authorityDid = parseAuthorityDid(space);
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
  const authorityDid = parseAuthorityDid(space);
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

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (("status" in error && error.status === 409) || ("message" in error && typeof error.message === "string" && /already exists/i.test(error.message)));
}

function parseAuthorityDid(space: string): string {
  const match = /^at:\/\/(did:[^/]+)\/space\/[a-zA-Z0-9.-]+\/[A-Za-z0-9._~:-]{1,128}$/.exec(space);
  if (!match) throw new Error("Invalid permissioned space URI.");
  return match[1];
}
