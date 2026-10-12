import { listBoundedRecords } from "@/atproto/record-pages";
import { mintSpaceCredentialWith, SpaceCredentialError, type SpaceCredential, type SpaceCredentialDeps } from "@/atproto/space-credential-core";
import { XrpcError, type AtprotoClient } from "@/atproto/xrpc";
import { canonicalParticipants, dmConversationUri, spaceRecordUri } from "@/protocol/keys";
import { validateDmHeaderMatchesRequest, validateSpaceRecord } from "@/protocol/records";

const DEFAULT_LIMIT = 100;
const MAX_MESSAGES_PER_HALF = 20_000;
const MAX_REACTIONS_PER_HALF = 20_000;

export type IndependentDmDeps = SpaceCredentialDeps;
export type IndependentDmHalfStatus = "ok" | "missing" | "deleted" | "revoked";
export type IndependentDmMessage = { uri: string; ownerDid: string; rkey: string; text: string; createdAt: string; parent?: string };
export type IndependentDmReaction = { uri: string; ownerDid: string; subject: string; emoji: string; createdAt: string };
export type IndependentDmConversation = {
  messages: IndependentDmMessage[];
  reactions: IndependentDmReaction[];
  halves: Record<string, IndependentDmHalfStatus>;
};

type RawMessage = { uri: string; ownerDid: string; rkey: string; value: Record<string, unknown> };

/**
 * M6 independence proof: a deliberately separate, minimal reader that proves
 * DM conversations are fully reconstructible from the published
 * `org.slack.dm.*` lexicons alone. It shares only the published-protocol
 * layer with `src/dm/dm-client.ts` (`src/protocol/*`, `xrpc.ts`,
 * `record-pages.ts`, `space-credential-core.ts`); it never imports
 * `src/dm/**` and merges every half's own (bounded) full history itself,
 * rather than reusing `src/dm/merge.ts`'s incremental k-way page merge.
 */
export async function readIndependentDmConversation(
  deps: IndependentDmDeps,
  convKey: string,
  participants: readonly string[],
  options: { limit?: number; before?: string } = {},
): Promise<IndependentDmConversation> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Independent DM read limit must be a positive safe integer.");
  const canonical = canonicalParticipants(participants);

  const halves: Record<string, IndependentDmHalfStatus> = {};
  const credentialByOwner = new Map<string, SpaceCredential>();
  const rawMessages: RawMessage[] = [];

  for (const ownerDid of canonical) {
    const half = dmConversationUri(ownerDid, convKey);
    let credential: SpaceCredential;
    try {
      credential = await mintSpaceCredentialWith(deps, half);
    } catch (error) {
      halves[ownerDid] = classifyHalfStatus(error);
      continue;
    }
    const client = credential.client(await deps.resolvePds(ownerDid));
    const header = await getOptionalRecord(client, half, ownerDid, "org.slack.dm.header", "self");
    const headerValid = header !== null && validateSpaceRecord("org.slack.dm.header", header, {
      authorityDid: ownerDid, spaceUri: half, repoDid: ownerDid, rkey: "self",
    }).valid;
    if (header === null || !headerValid || !validateDmHeaderMatchesRequest(header, { convKey, participants: canonical })) {
      halves[ownerDid] = "missing";
      continue;
    }
    halves[ownerDid] = "ok";
    credentialByOwner.set(ownerDid, credential);

    const page = await listBoundedRecords(client, { space: half, repo: ownerDid, collection: "org.slack.dm.message", maxRecords: MAX_MESSAGES_PER_HALF });
    if (page.truncated) throw new Error("Independent DM reader: a half's message history exceeds the bounded scan limit.");
    for (const record of page.records) {
      const validation = validateSpaceRecord("org.slack.dm.message", record.value, {
        authorityDid: ownerDid, spaceUri: half, repoDid: ownerDid, rkey: record.rkey, participants: canonical,
      });
      if (!validation.valid) continue;
      rawMessages.push({ uri: spaceRecordUri(half, ownerDid, "org.slack.dm.message", record.rkey), ownerDid, rkey: record.rkey, value: record.value });
    }
  }

  const messages = mergeIndependentDmMessages(rawMessages, { limit, before: options.before });
  const messageUris = new Set(messages.map((message) => message.uri));
  const reactions = await readIndependentDmReactions(deps, convKey, canonical, credentialByOwner, messageUris);
  return { messages, reactions, halves };
}

/**
 * This reader's own merge: fetch every half's full (bounded) history up
 * front, then sort the union once by TID (`rkey`), newest first, breaking
 * ties on URI for a deterministic order. Unlike `src/dm/merge.ts`'s
 * incremental per-page k-way merge, there is no paging loop to converge; the
 * whole bounded history is already in hand.
 */
export function mergeIndependentDmMessages(
  records: readonly RawMessage[],
  input: { limit: number; before?: string },
): IndependentDmMessage[] {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1) throw new RangeError("Independent DM merge limit must be a positive safe integer.");
  const byUri = new Map<string, RawMessage>();
  for (const record of records) {
    if (input.before !== undefined && record.rkey >= input.before) continue;
    byUri.set(record.uri, record);
  }
  const sorted = [...byUri.values()].sort((left, right) =>
    left.rkey === right.rkey ? left.uri.localeCompare(right.uri) : right.rkey.localeCompare(left.rkey));
  return sorted.slice(0, input.limit).map((record) => ({
    uri: record.uri, ownerDid: record.ownerDid, rkey: record.rkey,
    text: String(record.value.text ?? ""), createdAt: String(record.value.createdAt ?? ""),
    parent: typeof record.value.parent === "string" ? record.value.parent : undefined,
  }));
}

async function readIndependentDmReactions(
  deps: IndependentDmDeps,
  convKey: string,
  participants: readonly string[],
  credentialByOwner: ReadonlyMap<string, SpaceCredential>,
  messageUris: ReadonlySet<string>,
): Promise<IndependentDmReaction[]> {
  const reactions: IndependentDmReaction[] = [];
  for (const ownerDid of participants) {
    const credential = credentialByOwner.get(ownerDid);
    if (!credential) continue;
    const half = dmConversationUri(ownerDid, convKey);
    const client = credential.client(await deps.resolvePds(ownerDid));
    const page = await listBoundedRecords(client, { space: half, repo: ownerDid, collection: "org.slack.dm.reaction", maxRecords: MAX_REACTIONS_PER_HALF });
    if (page.truncated) throw new Error("Independent DM reader: a half's reaction history exceeds the bounded scan limit.");
    for (const record of page.records) {
      const validation = validateSpaceRecord("org.slack.dm.reaction", record.value, {
        authorityDid: ownerDid, spaceUri: half, repoDid: ownerDid, rkey: record.rkey, participants,
      });
      if (!validation.valid) continue;
      const value = record.value as { subject: string; emoji: string; createdAt: string };
      if (!messageUris.has(value.subject)) continue;
      reactions.push({ uri: spaceRecordUri(half, ownerDid, "org.slack.dm.reaction", record.rkey), ownerDid, subject: value.subject, emoji: value.emoji, createdAt: value.createdAt });
    }
  }
  return reactions;
}

async function getOptionalRecord(client: AtprotoClient, space: string, repo: string, collection: string, rkey: string): Promise<Record<string, unknown> | null> {
  try {
    const record = await client.query<{ value: Record<string, unknown> }>("com.atproto.space.getRecord", { space, repo, collection, rkey });
    return record.value;
  } catch (error) {
    if (error instanceof XrpcError && error.code === "RecordNotFound") return null;
    throw error;
  }
}

function classifyHalfStatus(error: unknown): IndependentDmHalfStatus {
  if (error instanceof SpaceCredentialError) {
    if (error.code === "SpaceNotFound") return "missing";
    if (error.code === "SpaceDeleted") return "deleted";
    return "revoked";
  }
  throw error;
}
