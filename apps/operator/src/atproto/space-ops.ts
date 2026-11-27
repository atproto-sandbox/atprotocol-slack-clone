import type { OAuthSession } from "@atproto/oauth-client-node";
import type * as CreateSpace from "@flock/protocol/lexicons/api/types/com/atproto/space/createSpace";
import type * as DeleteRecord from "@flock/protocol/lexicons/api/types/com/atproto/space/deleteRecord";
import type * as GetSpace from "@flock/protocol/lexicons/api/types/com/atproto/space/getSpace";
import type * as ListRecords from "@flock/protocol/lexicons/api/types/com/atproto/space/listRecords";
import type * as ListSpaces from "@flock/protocol/lexicons/api/types/com/atproto/space/listSpaces";
import type * as PutRecord from "@flock/protocol/lexicons/api/types/com/atproto/space/putRecord";
import type * as UpdateSpace from "@flock/protocol/lexicons/api/types/com/atproto/space/updateSpace";
import { assertBoundedRecordPage } from "@flock/protocol/atproto/record-pages";
import {
  isMissingXrpcResource,
  isScopeMissingError,
  isSpaceAlreadyExists,
  XrpcError,
} from "@flock/protocol/atproto/xrpc";
import { canonicalJson, parseSpaceUri, requireSpaceAuthority, spaceRecordUri, spaceUri } from "@flock/protocol/keys";
import { OPENSOCIAL_POLICY } from "@flock/protocol/nsids";
import { validateSpacePolicy, validateSpaceRecord } from "@flock/protocol/registry";
import type { GroupOpenSocialPolicy } from "@flock/protocol/scopes";
import { WORKSPACE_ENVELOPE, WorkspaceEnvelopeError } from "@flock/protocol/workspace-summary";
import { serviceClient, sessionClient } from "./client";
import { resolvePds } from "./identity";
import { mintSpaceCredential } from "./space-credential";

function normalizeOpenSocialPolicy(policy: GroupOpenSocialPolicy): Record<string, unknown> & { $type: string } {
  return {
    $type: OPENSOCIAL_POLICY,
    publicRead: policy.publicRead === true,
    unlisted: policy.unlisted === true,
    grants: [...policy.grants]
      .sort((a, b) => a.role.localeCompare(b.role))
      .map((grant) => ({
        role: grant.role,
        ...(grant.read !== undefined ? { read: grant.read } : {}),
        ...(grant.write !== undefined ? { write: grant.write } : {}),
        ...(grant.scopes && grant.scopes.length > 0 ? { scopes: [...grant.scopes] } : {}),
      })),
  };
}

export async function ensureOpenSocialSpace(
  session: OAuthSession,
  type: string,
  skey: string,
  policy: GroupOpenSocialPolicy,
): Promise<string> {
  const uri = spaceUri(session.did, type, skey);
  const desired = normalizeOpenSocialPolicy(policy);
  const check = validateSpacePolicy(desired, { groupDid: session.did, spaceType: type, skey });
  if (!check.valid) throw new Error(`Invalid group.opensocial.policy for ${uri}: ${check.reason}`);
  const client = sessionClient(session);
  try {
    const result = await client.procedure<CreateSpace.InputSchema, CreateSpace.OutputSchema>(
      "com.atproto.space.createSpace",
      { spaceType: type, skey, policy: desired as unknown as CreateSpace.InputSchema["policy"] },
    );
    return result.space;
  } catch (error) {
    if (!isSpaceAlreadyExists(error)) throw error;
    const current = await client.query<GetSpace.OutputSchema>("com.atproto.space.getSpace", { space: uri });
    const rawPolicy = current.policy as Record<string, unknown> | undefined;
    if (!rawPolicy || rawPolicy.$type !== OPENSOCIAL_POLICY) {
      throw new Error(`Space already exists with an incompatible policy: ${uri}`);
    }
    const normalizedCurrent = normalizeOpenSocialPolicy(rawPolicy as unknown as GroupOpenSocialPolicy);
    if (canonicalJson(normalizedCurrent) !== canonicalJson(desired)) {
      await updateOpenSocialSpacePolicy(session, uri, policy);
    }
    return current.space;
  }
}

export async function updateOpenSocialSpacePolicy(
  session: OAuthSession,
  space: string,
  policy: GroupOpenSocialPolicy,
): Promise<void> {
  const parsed = parseSpaceUri(space);
  if (!parsed || parsed.authorityDid !== session.did) {
    throw new Error("Space policy must be updated by the group authority.");
  }
  const desired = normalizeOpenSocialPolicy(policy);
  const check = validateSpacePolicy(desired, {
    groupDid: session.did,
    spaceType: parsed.type,
    skey: parsed.skey,
  });
  if (!check.valid) throw new Error(`Invalid group.opensocial.policy for ${space}: ${check.reason}`);
  await sessionClient(session).procedure<UpdateSpace.InputSchema, Record<string, never>>(
    "com.atproto.space.updateSpace",
    { space, policy: desired as unknown as UpdateSpace.InputSchema["policy"] },
  );
}

export type OpenSocialSpacePolicyInspection =
  | { status: "valid"; policy: GroupOpenSocialPolicy }
  | { status: "missing" }
  | { status: "invalid" };

export async function inspectOpenSocialSpacePolicy(
  session: OAuthSession,
  space: string,
): Promise<OpenSocialSpacePolicyInspection> {
  const parsed = parseSpaceUri(space);
  if (!parsed) throw new Error("Invalid space URI.");
  try {
    const current = await sessionClient(session).query<GetSpace.OutputSchema>(
      "com.atproto.space.getSpace",
      { space },
    );
    const rawPolicy = current.policy as Record<string, unknown> | undefined;
    if (!rawPolicy || rawPolicy.$type !== OPENSOCIAL_POLICY) return { status: "invalid" };
    const check = validateSpacePolicy(rawPolicy, {
      groupDid: parsed.authorityDid,
      spaceType: parsed.type,
      skey: parsed.skey,
    });
    if (!check.valid) return { status: "invalid" };
    return {
      status: "valid",
      policy: {
        $type: OPENSOCIAL_POLICY,
        publicRead: rawPolicy.publicRead === true,
        unlisted: rawPolicy.unlisted === true,
        grants: (rawPolicy.grants as GroupOpenSocialPolicy["grants"]) ?? [],
      },
    };
  } catch (error) {
    if (error instanceof XrpcError && error.code === "SpaceNotFound") return { status: "missing" };
    throw error;
  }
}

export async function getOpenSocialSpacePolicy(
  session: OAuthSession,
  space: string,
): Promise<GroupOpenSocialPolicy | null> {
  const res = await inspectOpenSocialSpacePolicy(session, space);
  return res.status === "valid" ? res.policy : null;
}

export async function listOwnGroupSpaceUris(session: OAuthSession): Promise<string[]> {
  const client = sessionClient(session);
  const ownUris: string[] = [];
  let cursor: string | undefined;
  let scanned = 0;
  for (;;) {
    const page = await client.query<ListSpaces.OutputSchema>("com.atproto.space.listSpaces", {
      spaceDid: session.did,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    for (const entry of page.spaces) {
      scanned += 1;
      if (scanned > WORKSPACE_ENVELOPE.authorityRecordScan) {
        throw new WorkspaceEnvelopeError(`Group space count exceeds the ${WORKSPACE_ENVELOPE.authorityRecordScan}-space scan limit.`);
      }
      if (parseSpaceUri(entry.space)?.authorityDid === session.did) {
        ownUris.push(entry.space);
      }
    }
    if (!page.cursor || page.spaces.length === 0) break;
    cursor = page.cursor;
  }
  return ownUris;
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

export async function putAuthorityRecord(
  session: OAuthSession,
  space: string,
  collection: string,
  rkey: string,
  value: Record<string, unknown>,
  options?: { ifJoinRequestPresent?: boolean },
): Promise<PutRecord.OutputSchema> {
  const authorityDid = requireSpaceAuthority(space);
  const record = { $type: collection, ...value };
  const validation = validateSpaceRecord(collection, record, {
    authorityDid,
    spaceUri: space,
    repoDid: session.did,
    rkey,
  });
  if (!validation.valid) throw new Error(`Invalid ${collection} record: ${validation.reason}`);
  return sessionClient(session).procedure<PutRecord.InputSchema, PutRecord.OutputSchema>(
    "com.atproto.space.putRecord",
    { space, repo: session.did, collection, rkey, record },
    {},
    options?.ifJoinRequestPresent
      ? { headers: { "If-Join-Request-Present": "true" } }
      : undefined,
  );
}

export async function deleteAuthorityRecord(
  session: OAuthSession,
  space: string,
  collection: string,
  rkey: string,
): Promise<void> {
  try {
    await sessionClient(session).procedure<DeleteRecord.InputSchema, DeleteRecord.OutputSchema>(
      "com.atproto.space.deleteRecord",
      { space, repo: session.did, collection, rkey },
    );
  } catch (error) {
    if (isMissingXrpcResource(error) || (error instanceof XrpcError && error.code === "SpaceNotFound")) {
      return;
    }
    throw error;
  }
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
    "com.atproto.space.listRecords",
    { space, repo: repoDid, collection, limit },
  );
  assertBoundedRecordPage(page, { collection, limit });
  return page.records.flatMap((record) =>
    record.value
      ? [
          {
            uri: spaceRecordUri(space, repoDid, collection, record.rkey),
            rkey: record.rkey,
            value: record.value as T,
          },
        ]
      : [],
  );
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
    authorityDid,
    spaceUri: space,
    repoDid: session.did,
    rkey,
    knownMessages: context.knownMessages,
    knownTopLevelMessages: context.knownTopLevelMessages,
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
