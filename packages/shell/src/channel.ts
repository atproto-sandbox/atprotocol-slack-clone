import {
  mintSpaceCredentialWith,
  type SpaceCredential,
} from "@flock/protocol/atproto/space-credential-core";
import { isMissingXrpcResource } from "@flock/protocol/atproto/xrpc";
import {
  parseChannelUri,
  parseSpaceRecordUri,
  spaceRecordUri,
  tidNow,
} from "@flock/protocol/keys";
import { COLLECTION } from "@flock/protocol/nsids";
import { validateSpaceRecord } from "@flock/protocol/registry";
import type { DeskShellDeps } from "./membership";

function nowOf(deps: Pick<DeskShellDeps, "now">): number {
  return deps.now ? deps.now() : Date.now();
}

function requireChannelSpace(spaceUri: string): { authorityDid: string; skey: string } {
  const parsed = parseChannelUri(spaceUri);
  if (!parsed) throw new TypeError("Invalid channel space URI.");
  return parsed;
}

async function fetchVerifiedRecord(
  deps: DeskShellDeps,
  credential: SpaceCredential,
  spaceUri: string,
  repo: string,
  collection: string,
  rkey: string,
): Promise<{ uri: string; cid?: string; value: Record<string, unknown> } | null> {
  try {
    const pds = await deps.resolvePds(repo);
    const res = await credential.client(pds).query<{ uri: string; cid?: string; value: Record<string, unknown> }>(
      "com.atproto.space.getRecord",
      { space: spaceUri, repo, collection, rkey },
    );
    return res.uri === spaceRecordUri(spaceUri, repo, collection, rkey) ? res : null;
  } catch (error) {
    if (isMissingXrpcResource(error)) return null;
    throw error;
  }
}

async function verifyTopLevelParent(
  deps: DeskShellDeps,
  credential: SpaceCredential,
  authorityDid: string,
  spaceUri: string,
  parentUri: string,
): Promise<void> {
  const target = parseSpaceRecordUri(parentUri, spaceUri, COLLECTION.message);
  if (!target) {
    throw new Error("Reply target must be a message URI in this channel.");
  }
  const parentRecord = await fetchVerifiedRecord(
    deps,
    credential,
    spaceUri,
    target.repo,
    COLLECTION.message,
    target.rkey,
  );
  if (!parentRecord || parentRecord.value.parent !== undefined) {
    throw new Error("Reply target must be a top-level message in this channel.");
  }
  const valid = validateSpaceRecord(COLLECTION.message, parentRecord.value, {
    authorityDid,
    spaceUri,
    repoDid: target.repo,
    rkey: target.rkey,
  });
  if (!valid.valid) {
    throw new Error(`Reply target message is invalid: ${valid.reason}`);
  }
}

/**
 * Posts a new message (or top-level reply) to a channel:
 * - Always mints a brand-new, uncached channel space credential immediately before writing.
 * - Verifies `parent` is an existing valid top-level message in `spaceUri` if supplied.
 * - Uses create-only `com.atproto.space.createRecord` (never `putRecord`) to prevent silent TID collisions.
 */
export async function postChannelMessage(
  deps: DeskShellDeps,
  spaceUri: string,
  input: { text: string; parent?: string },
): Promise<{ uri: string; rkey: string; cid: string }> {
  const { authorityDid } = requireChannelSpace(spaceUri);
  const credential = await mintSpaceCredentialWith(deps, spaceUri);
  const known = new Set<string>();
  if (input.parent !== undefined) {
    await verifyTopLevelParent(deps, credential, authorityDid, spaceUri, input.parent);
    known.add(input.parent);
  }

  const now = nowOf(deps);
  const rkey = tidNow(now);
  const record: Record<string, unknown> = {
    $type: COLLECTION.message,
    text: input.text,
    ...(input.parent !== undefined ? { parent: input.parent } : {}),
    createdAt: new Date(now).toISOString(),
  };
  const validation = validateSpaceRecord(COLLECTION.message, record, {
    authorityDid,
    spaceUri,
    repoDid: deps.did,
    rkey,
    knownMessages: known,
    knownTopLevelMessages: known,
  });
  if (!validation.valid) throw new Error(validation.reason);

  const result = await deps.memberClient.procedure<unknown, { uri: string; cid: string }>(
    "com.atproto.space.createRecord",
    {
      space: spaceUri,
      repo: deps.did,
      collection: COLLECTION.message,
      rkey,
      record,
    },
  );
  return {
    uri: spaceRecordUri(spaceUri, deps.did, COLLECTION.message, rkey),
    rkey,
    cid: result.cid,
  };
}

/**
 * Edits an existing own message in `spaceUri`:
 * - Mints a fresh channel credential immediately prior to mutation.
 * - Verifies ownership and fetches the existing record first, preserving unknown third-party fields.
 * - Re-verifies `prior.value.parent` if present before `putRecord`.
 */
export async function editChannelMessage(
  deps: DeskShellDeps,
  spaceUri: string,
  messageUri: string,
  input: { text: string },
): Promise<{ uri: string; cid: string }> {
  const { authorityDid } = requireChannelSpace(spaceUri);
  const target = parseSpaceRecordUri(messageUri, spaceUri, COLLECTION.message);
  if (!target || target.repo !== deps.did) {
    throw new Error("You can edit only your own messages in this channel.");
  }

  const credential = await mintSpaceCredentialWith(deps, spaceUri);
  const prior = await fetchVerifiedRecord(deps, credential, spaceUri, target.repo, COLLECTION.message, target.rkey);
  if (!prior) {
    throw new Error("Message was not found in this channel.");
  }

  const record: Record<string, unknown> = { ...prior.value, text: input.text };
  const known = new Set<string>();
  if (typeof record.parent === "string") {
    await verifyTopLevelParent(deps, credential, authorityDid, spaceUri, record.parent);
    known.add(record.parent);
  }
  const validation = validateSpaceRecord(COLLECTION.message, record, {
    authorityDid,
    spaceUri,
    repoDid: target.repo,
    rkey: target.rkey,
    knownMessages: known,
    knownTopLevelMessages: known,
  });
  if (!validation.valid) throw new Error(validation.reason);

  const result = await deps.memberClient.procedure<unknown, { uri: string; cid: string }>(
    "com.atproto.space.putRecord",
    {
      space: spaceUri,
      repo: target.repo,
      collection: COLLECTION.message,
      rkey: target.rkey,
      record,
    },
  );
  return { uri: messageUri, cid: result.cid };
}

/**
 * Deletes an own message in `spaceUri`, minting a fresh channel credential immediately before mutation.
 * Ownership is verified from the parsed message URI (`target.repo === deps.did`); the freshly minted
 * credential enforces active channel membership before issuing the idempotent personal-PDS `deleteRecord`.
 */
export async function deleteChannelMessage(
  deps: DeskShellDeps,
  spaceUri: string,
  messageUri: string,
): Promise<void> {
  requireChannelSpace(spaceUri);
  const target = parseSpaceRecordUri(messageUri, spaceUri, COLLECTION.message);
  if (!target || target.repo !== deps.did) {
    throw new Error("You can delete only your own messages in this channel.");
  }

  await mintSpaceCredentialWith(deps, spaceUri);
  await deps.memberClient.procedure("com.atproto.space.deleteRecord", {
    space: spaceUri,
    repo: target.repo,
    collection: COLLECTION.message,
    rkey: target.rkey,
  });
}
