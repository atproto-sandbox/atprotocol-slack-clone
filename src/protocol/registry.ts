import { Lexicons, parseLexiconDoc } from "@atproto/lexicon";
import acceptanceLexicon from "../../lexicons/new/flock/acceptance.json";
import adminLexicon from "../../lexicons/new/flock/admin.json";
import channelRosterLexicon from "../../lexicons/new/flock/channel/roster.json";
import messageLexicon from "../../lexicons/new/flock/channel/message.json";
import reactionLexicon from "../../lexicons/new/flock/channel/reaction.json";
import directoryLexicon from "../../lexicons/new/flock/directory.json";
import dmDeclarationLexicon from "../../lexicons/new/flock/dm/declaration.json";
import dmHeaderLexicon from "../../lexicons/new/flock/dm/header.json";
import dmMessageLexicon from "../../lexicons/new/flock/dm/message.json";
import dmReactionLexicon from "../../lexicons/new/flock/dm/reaction.json";
import dmRequestLexicon from "../../lexicons/new/flock/dm/request.json";
import joinDecisionLexicon from "../../lexicons/new/flock/joinDecision.json";
import joinRequestLexicon from "../../lexicons/new/flock/joinRequest.json";
import workspaceProfileLexicon from "../../lexicons/new/flock/workspace/profile.json";
import workspaceRosterLexicon from "../../lexicons/new/flock/workspace/roster.json";
import {
  acceptanceRecordKey,
  canonicalParticipants,
  channelUri,
  decisionRecordKey,
  dmConversationUri,
  isDid,
  isTid,
  parseDmConversationUri,
  parseDmInboxUri,
  parseDmMessageUri,
  parseSpaceRecordUri,
  parseSpaceUri,
  reactionRecordKey,
  requestRecordKey,
  spaceRecordUri,
  subjectKey,
} from "./keys";
import { COLLECTION, REPO_COLLECTION, SPACE_TYPE, type Collection, type SpaceType } from "./nsids";

// The one table of the records this app reads and writes in spaces: which space type holds each collection, who may author
// it, how its key is formed, how a client syncs it, and the rules about meaning that a schema cannot express. Validation has
// two layers: the shape comes from the published lexicon documents, so a record the lexicon accepts is a record this app
// accepts; the meaning comes from the entry's semantic check, which can still reject a well-shaped record. Objects are open:
// an unknown field is kept and ignored. To evolve a record, add optional fields; a change to a required field or to meaning
// takes a new NSID.

export type RecordValidation = { valid: true } | { valid: false; reason: string };

export type RecordContext = {
  authorityDid: string;
  spaceUri: string;
  repoDid: string;
  rkey: string;
  knownTopLevelMessages?: ReadonlySet<string>;
  knownMessages?: ReadonlySet<string>;
  participants?: readonly string[];
};

/** Who may write a record: the space's authority, any member with write access, or the owner of a DM conversation half. */
export type Author = "authority" | "member" | "halfOwner";
/** How a record's key is formed: a TID, the literal `self`, or derived from the record (checked by its semantic rule). */
export type KeyRule = "tid" | "self" | "derived";
/** How a client syncs a writer's records: newest-first down to a window (history), or all of them (a bounded set). */
export type SyncStrategy = "window" | "all";

export type CollectionEntry = {
  spaceType: SpaceType;
  author: Author;
  key: KeyRule;
  sync: SyncStrategy;
  semantic?: (record: Record<string, unknown>, context: RecordContext) => RecordValidation;
};

/** The largest record the app reads; anything bigger is rejected before its fields are examined. */
export const MAX_RECORD_BYTES = 64 * 1024;

const VALID: RecordValidation = { valid: true };

export const REGISTRY: { readonly [C in Collection]: CollectionEntry } = {
  [COLLECTION.workspaceProfile]: { spaceType: SPACE_TYPE.workspace, author: "authority", key: "self", sync: "all" },
  [COLLECTION.directory]: {
    spaceType: SPACE_TYPE.workspace, author: "authority", key: "derived", sync: "all",
    semantic: (record, context) => context.rkey === record.skey ? VALID : invalid("directory key must equal skey"),
  },
  [COLLECTION.workspaceRoster]: { spaceType: SPACE_TYPE.workspace, author: "authority", key: "derived", sync: "all", semantic: subjectKeyed },
  [COLLECTION.admin]: { spaceType: SPACE_TYPE.workspace, author: "authority", key: "derived", sync: "all", semantic: subjectKeyed },
  [COLLECTION.acceptance]: {
    spaceType: SPACE_TYPE.workspace, author: "member", key: "derived", sync: "all",
    semantic: (record, context) => parseSpaceUri(String(record.workspace))?.type === SPACE_TYPE.workspace && context.rkey === acceptanceRecordKey(String(record.workspace))
      ? VALID
      : invalid("acceptance key must match its workspace"),
  },
  [COLLECTION.joinRequest]: {
    spaceType: SPACE_TYPE.inbox, author: "member", key: "derived", sync: "all",
    semantic: (record, context) => context.rkey === requestRecordKey(channelUri(context.authorityDid, String(record.channelSkey)), context.repoDid)
      ? VALID
      : invalid("join request key is not canonical"),
  },
  [COLLECTION.joinDecision]: {
    spaceType: SPACE_TYPE.inbox, author: "authority", key: "derived", sync: "all",
    semantic: (record, context) => {
      const request = parseSpaceRecordUri(String(record.request), context.spaceUri, COLLECTION.joinRequest);
      return request && request.repo !== context.authorityDid && context.rkey === decisionRecordKey(String(record.request))
        ? VALID
        : invalid("join decision key must match a canonical request in this inbox");
    },
  },
  [COLLECTION.message]: {
    spaceType: SPACE_TYPE.channel, author: "member", key: "tid", sync: "window",
    semantic: (record, context) => record.parent === undefined
      ? VALID
      : validateMessageParent(String(record.parent), context.spaceUri, context.knownTopLevelMessages ?? new Set(), context.knownMessages ?? new Set()),
  },
  [COLLECTION.reaction]: {
    spaceType: SPACE_TYPE.channel, author: "member", key: "derived", sync: "all",
    semantic: (record, context) => {
      const subject = String(record.subject);
      if (!parseSpaceRecordUri(subject, context.spaceUri, COLLECTION.message) || !context.knownMessages?.has(subject)) {
        return invalid("reaction target is not a message in this channel");
      }
      return context.rkey === reactionRecordKey(subject, String(record.emoji), context.repoDid) ? VALID : invalid("reaction key is not canonical");
    },
  },
  [COLLECTION.channelRoster]: { spaceType: SPACE_TYPE.channel, author: "authority", key: "derived", sync: "all", semantic: subjectKeyed },
  [COLLECTION.dmRequest]: {
    spaceType: SPACE_TYPE.dmInbox, author: "member", key: "derived", sync: "all",
    semantic: (record, context) => {
      const inboxOwnerDid = parseDmInboxUri(context.spaceUri)?.ownerDid;
      if (!inboxOwnerDid) return invalid("DM request must be scoped to a DM inbox space");
      if (context.rkey !== record.convKey) return invalid("DM request key must equal its conversation key");
      const participants = canonicalDmParticipants(record.participants);
      if (!participants) return invalid("DM request participants must be canonical");
      return participants.includes(context.repoDid) && participants.includes(inboxOwnerDid)
        ? VALID
        : invalid("DM request participants must include the sender and the inbox owner");
    },
  },
  [COLLECTION.dmHeader]: {
    spaceType: SPACE_TYPE.dmConversation, author: "halfOwner", key: "self", sync: "all",
    semantic: (record, context) => {
      const half = parseDmConversationUri(context.spaceUri);
      if (!half) return invalid("DM header must be scoped to a conversation half");
      if (record.convKey !== half.convKey) return invalid("DM header conversation key must equal the half key");
      const participants = canonicalDmParticipants(record.participants);
      if (!participants) return invalid("DM header participants must be canonical");
      return participants.includes(half.ownerDid) ? VALID : invalid("DM header participants must include the half owner");
    },
  },
  [COLLECTION.dmMessage]: {
    spaceType: SPACE_TYPE.dmConversation, author: "halfOwner", key: "tid", sync: "window",
    semantic: (record, context) => {
      if (String(record.text).trim().length < 1) return invalid("DM message text must not be blank");
      return record.parent === undefined ? VALID : validateDmParent(String(record.parent), context);
    },
  },
  [COLLECTION.dmReaction]: {
    spaceType: SPACE_TYPE.dmConversation, author: "halfOwner", key: "derived", sync: "all",
    semantic: (record, context) => {
      const half = parseDmConversationUri(context.spaceUri);
      const subject = parseDmMessageUri(record.subject);
      if (!half || !subject || subject.convKey !== half.convKey) return invalid("reaction target is not a DM message in this conversation");
      if (context.participants && !context.participants.includes(subject.ownerDid)) return invalid("reaction target must be a message from a conversation participant");
      return context.rkey === reactionRecordKey(String(record.subject), String(record.emoji), context.repoDid) ? VALID : invalid("reaction key is not canonical");
    },
  },
};

/** The collections the authority writes in each space type: what its grant must be able to create, update and delete. */
export function authorityCollections(spaceType: SpaceType): Collection[] {
  return collectionsWhere((entry) => entry.spaceType === spaceType && entry.author === "authority");
}

export function isRegisteredCollection(collection: string): collection is Collection {
  return Object.hasOwn(REGISTRY, collection);
}

const LEXICONS = new Lexicons([
  workspaceProfileLexicon, directoryLexicon, workspaceRosterLexicon, adminLexicon, acceptanceLexicon, joinRequestLexicon,
  joinDecisionLexicon, messageLexicon, reactionLexicon, channelRosterLexicon, dmRequestLexicon, dmHeaderLexicon,
  dmMessageLexicon, dmReactionLexicon, dmDeclarationLexicon,
].map((document) => parseLexiconDoc(document)));

/** The shape a published lexicon gives a record, and nothing more: no author, key or reference rule. */
export function validateRecordShape(collection: string, value: unknown): RecordValidation {
  const result = LEXICONS.validate(collection, value);
  return result.success ? VALID : invalid(result.error.message);
}

/** Whether `name` fits the directory record that names a channel. The lexicon owns the limits; nothing else repeats them. */
export function fitsDirectoryName(name: string): boolean {
  return validateRecordShape(COLLECTION.directory, { skey: "self", name, visibility: "public" }).valid;
}

export function validateSpaceRecord(collection: string, value: unknown, context: RecordContext): RecordValidation {
  if (!isPlainObject(value)) return invalid("record must be an object");
  if (value.$type !== undefined && value.$type !== collection) return invalid("record type does not match its collection");
  if (!isRegisteredCollection(collection)) return invalid("unknown collection");
  const entry = REGISTRY[collection];
  if (parseSpaceUri(context.spaceUri)?.type !== entry.spaceType) return invalid("collection does not belong to this space type");
  const author = checkAuthor(entry.author, context);
  if (!author.valid) return author;
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_RECORD_BYTES) return invalid("record exceeds the size limit");
  if (entry.key === "tid" && !isTid(context.rkey)) return invalid("record key must be a TID");
  if (entry.key === "self" && context.rkey !== "self") return invalid("record key must be self");
  const shape = validateRecordShape(collection, value);
  if (!shape.valid) return shape;
  return entry.semantic?.(value, context) ?? VALID;
}

/**
 * `dm.declaration`: the record an account publishes in its own public repo (key `self`) to say it runs a DM inbox. It is not
 * a space record; a sender checks it with this before treating a recipient as having an inbox.
 */
export function validateDmDeclaration(value: unknown): RecordValidation {
  if (!isPlainObject(value)) return invalid("DM declaration must be an object");
  if (value.$type !== REPO_COLLECTION.dmDeclaration) return invalid("DM declaration has the wrong type");
  return validateRecordShape(REPO_COLLECTION.dmDeclaration, value);
}

export function validateMessageParent(
  parentUri: string,
  spaceUri: string,
  knownTopLevelMessages: ReadonlySet<string>,
  knownMessages: ReadonlySet<string>,
): RecordValidation {
  if (!parseSpaceRecordUri(parentUri, spaceUri, COLLECTION.message)) return invalid("parent must be a canonical message URI in this channel");
  if (!knownMessages.has(parentUri)) return invalid("parent message is not in this channel");
  if (!knownTopLevelMessages.has(parentUri)) return invalid("nested replies are not supported");
  return VALID;
}

export function validateDmHeaderMatchesRequest(header: unknown, request: unknown): boolean {
  if (!isPlainObject(header) || !isPlainObject(request)) return false;
  if (typeof header.convKey !== "string" || header.convKey !== request.convKey) return false;
  return sameParticipants(header.participants, request.participants);
}

function checkAuthor(author: Author, context: RecordContext): RecordValidation {
  if (author === "authority" && context.repoDid !== context.authorityDid) return invalid("authority record has the wrong author");
  if (author === "halfOwner" && context.repoDid !== parseDmConversationUri(context.spaceUri)?.ownerDid) {
    return invalid("DM record must be authored by the half owner");
  }
  return VALID;
}

function subjectKeyed(record: Record<string, unknown>, context: RecordContext): RecordValidation {
  // The lexicon's `did` format has no length bound; isDid keeps a hostile roster from filling a member list with huge DIDs.
  if (!isDid(record.subject)) return invalid("roster subject must be a DID within the length bound");
  return context.rkey === subjectKey(record.subject) ? VALID : invalid("roster key must equal the subject hash");
}

function validateDmParent(parent: string, context: RecordContext): RecordValidation {
  const half = parseDmConversationUri(context.spaceUri);
  const target = parseDmMessageUri(parent);
  if (!half || !target) return invalid("parent must be a canonical DM message URI");
  if (target.convKey !== half.convKey) return invalid("parent must be a message in this conversation");
  if (context.participants && !context.participants.includes(target.ownerDid)) return invalid("parent must be a message from a conversation participant");
  const self = spaceRecordUri(dmConversationUri(half.ownerDid, half.convKey), context.repoDid, COLLECTION.dmMessage, context.rkey);
  return parent === self ? invalid("parent must not be the message itself") : VALID;
}

function collectionsWhere(predicate: (entry: CollectionEntry) => boolean): Collection[] {
  return (Object.keys(REGISTRY) as Collection[]).filter((collection) => predicate(REGISTRY[collection]));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalDmParticipants(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  try {
    const canonical = canonicalParticipants(value);
    return canonical.length === value.length && canonical.every((did, index) => did === value[index]) ? canonical : null;
  } catch {
    return null;
  }
}

function sameParticipants(left: unknown, right: unknown): boolean {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function invalid(reason: string): RecordValidation {
  return { valid: false, reason };
}
