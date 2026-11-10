import { validateSpaceRecord } from "@/protocol/registry";
import { parseSpaceRecordUri, spaceRecordUri } from "@/protocol/keys";
import { COLLECTION } from "@/protocol/nsids";

export type ChannelMessageRecord = {
  uri: string;
  rkey: string;
  repo: string;
  value: Record<string, unknown>;
};

export type ChannelParentRecord = { uri: string; value: Record<string, unknown> };

export async function selectValidChannelMessages(
  records: ChannelMessageRecord[],
  input: {
    authorityDid: string;
    spaceUri: string;
    limit: number;
    getParent: (repo: string, rkey: string) => Promise<ChannelParentRecord | null>;
  },
): Promise<{ messages: ChannelMessageRecord[]; knownMessages: Set<string>; knownTopLevelMessages: Set<string> }> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1) throw new RangeError("Message selection limit must be a positive safe integer.");
  const ordered = records.filter((record) => {
    try {
      return record.uri === spaceRecordUri(input.spaceUri, record.repo, COLLECTION.message, record.rkey);
    } catch {
      return false;
    }
  }).sort((left, right) => right.rkey.localeCompare(left.rkey));
  const knownMessages = new Set<string>();
  const knownTopLevelMessages = new Set<string>();
  const validTopLevelMessages = new Set<string>();
  for (const record of ordered) {
    if (!isObject(record.value) || record.value.parent !== undefined) continue;
    if (validateSpaceRecord(COLLECTION.message, record.value, {
      authorityDid: input.authorityDid,
      spaceUri: input.spaceUri,
      repoDid: record.repo,
      rkey: record.rkey,
    }).valid) {
      knownMessages.add(record.uri);
      knownTopLevelMessages.add(record.uri);
      validTopLevelMessages.add(record.uri);
    }
  }

  const messages: ChannelMessageRecord[] = [];
  const attemptedParents = new Set<string>();
  for (const record of ordered) {
    if (!isObject(record.value)) continue;
    if (record.value.parent === undefined) {
      if (validTopLevelMessages.has(record.uri)) messages.push(record);
    } else {
      const parentUri = record.value.parent;
      if (typeof parentUri === "string" && !knownTopLevelMessages.has(parentUri) && !attemptedParents.has(parentUri)) {
        attemptedParents.add(parentUri);
        const target = parseSpaceRecordUri(parentUri, input.spaceUri, COLLECTION.message);
        if (target) {
          const { repo, rkey } = target;
          try {
            const parent = await input.getParent(repo, rkey);
            if (parent?.uri === parentUri && isObject(parent.value) && parent.value.parent === undefined &&
              validateSpaceRecord(COLLECTION.message, parent.value, {
                authorityDid: input.authorityDid,
                spaceUri: input.spaceUri,
                repoDid: repo,
                rkey,
              }).valid) {
              knownMessages.add(parentUri);
              knownTopLevelMessages.add(parentUri);
            }
          } catch { /* Missing, unreadable, or invalid parents make replies nonconforming. */ }
        }
      }
      if (validateSpaceRecord(COLLECTION.message, record.value, {
        authorityDid: input.authorityDid,
        spaceUri: input.spaceUri,
        repoDid: record.repo,
        rkey: record.rkey,
        knownMessages,
        knownTopLevelMessages,
      }).valid) {
        knownMessages.add(record.uri);
        messages.push(record);
      }
    }
    if (messages.length >= input.limit) break;
  }
  return { messages, knownMessages, knownTopLevelMessages };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
