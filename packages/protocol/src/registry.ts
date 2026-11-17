import { Lexicons, parseLexiconDoc } from "@atproto/lexicon";
import acceptanceLexicon from "../lexicons/new/flock/acceptance.json";
import adminLexicon from "../lexicons/new/flock/admin.json";
import channelRosterLexicon from "../lexicons/new/flock/channel/roster.json";
import messageLexicon from "../lexicons/new/flock/channel/message.json";
import reactionLexicon from "../lexicons/new/flock/channel/reaction.json";
import directoryLexicon from "../lexicons/new/flock/directory.json";
import dmDeclarationLexicon from "../lexicons/new/flock/dm/declaration.json";
import appActionLexicon from "../lexicons/new/flock/app/action.json";
import appCommandLexicon from "../lexicons/new/flock/app/command.json";
import appDeclarationLexicon from "../lexicons/new/flock/app/declaration.json";
import appInstallLexicon from "../lexicons/new/flock/app/install.json";
import dmHeaderLexicon from "../lexicons/new/flock/dm/header.json";
import dmMessageLexicon from "../lexicons/new/flock/dm/message.json";
import dmReactionLexicon from "../lexicons/new/flock/dm/reaction.json";
import dmRequestLexicon from "../lexicons/new/flock/dm/request.json";
import extInstallLexicon from "../lexicons/new/flock/ext/install.json";
import taskCommentLexicon from "../lexicons/new/flock/ext/tasks/comment.json";
import taskProjectLexicon from "../lexicons/new/flock/ext/tasks/project.json";
import taskProjectEditLexicon from "../lexicons/new/flock/ext/tasks/projectEdit.json";
import taskLexicon from "../lexicons/new/flock/ext/tasks/task.json";
import taskEditLexicon from "../lexicons/new/flock/ext/tasks/taskEdit.json";
import joinDecisionLexicon from "../lexicons/new/flock/joinDecision.json";
import joinRequestLexicon from "../lexicons/new/flock/joinRequest.json";
import workspaceProfileLexicon from "../lexicons/new/flock/workspace/profile.json";
import workspaceRosterLexicon from "../lexicons/new/flock/workspace/roster.json";
import { extSpaceUriFor, isExtensionId } from "./extensions";
import {
  acceptanceRecordKey,
  canonicalParticipants,
  channelUri,
  decisionRecordKey,
  dmConversationUri,
  isDid,
  isTid,
  parseChannelUri,
  parseDmConversationUri,
  parseDmInboxUri,
  parseDmMessageUri,
  parseSpaceRecordUri,
  parseSpaceUri,
  parseWorkspaceUri,
  reactionRecordKey,
  requestRecordKey,
  spaceRecordUri,
  subjectKey,
} from "./keys";
import { BLOCK_TYPE, COLLECTION, REPO_COLLECTION, SPACE_TYPE, type Collection, type SpaceType } from "./nsids";

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
  [COLLECTION.appInstall]: {
    spaceType: SPACE_TYPE.workspace, author: "authority", key: "derived", sync: "all",
    semantic: (record, context) => {
      const keyed = subjectKeyed(record, context);
      if (!keyed.valid) return keyed;
      const skeys = (record.channels as Array<{ skey: string }>).map((grant) => grant.skey);
      return new Set(skeys).size === skeys.length ? VALID : invalid("an app install grants each channel once");
    },
  },
  [COLLECTION.acceptance]: {
    spaceType: SPACE_TYPE.workspace, author: "member", key: "derived", sync: "all",
    semantic: (record, context) => parseSpaceUri(String(record.workspace))?.type === SPACE_TYPE.workspace && context.rkey === acceptanceRecordKey(String(record.workspace))
      ? VALID
      : invalid("acceptance key must match its workspace"),
  },
  [COLLECTION.appCommand]: {
    spaceType: SPACE_TYPE.appInbox, author: "member", key: "tid", sync: "window",
    semantic: (record, context) => {
      if (!isCommandName(record.command)) return invalid("command name must match [a-z0-9-]{1,32}");
      const channel = parseChannelUri(String(record.channel));
      if (!channel || channel.authorityDid !== context.authorityDid || channelUri(channel.authorityDid, channel.skey) !== record.channel) {
        return invalid("command channel must be a canonical channel URI of this authority");
      }
      if (record.parent === undefined) return VALID;
      const parent = parseSpaceRecordUri(String(record.parent), String(record.channel), COLLECTION.message);
      return parent && isTid(parent.rkey) ? VALID : invalid("command parent must be a canonical message URI in its channel");
    },
  },
  [COLLECTION.appAction]: {
    spaceType: SPACE_TYPE.appInbox, author: "member", key: "tid", sync: "window",
    semantic: (record, context) => {
      if (!isActionId(record.actionId)) return invalid("actionId must match [a-zA-Z0-9_-]{1,64}");
      const channel = parseChannelUri(String(record.channel));
      if (!channel || channel.authorityDid !== context.authorityDid || channelUri(channel.authorityDid, channel.skey) !== record.channel) {
        return invalid("action channel must be a canonical channel URI of this authority");
      }
      const message = parseSpaceRecordUri(String(record.message), String(record.channel), COLLECTION.message);
      return message && isTid(message.rkey) ? VALID : invalid("action target must be a canonical message URI in its channel");
    },
  },
  [COLLECTION.extInstall]: {
    spaceType: SPACE_TYPE.workspace, author: "authority", key: "derived", sync: "all",
    semantic: (record, context) => {
      const workspace = parseWorkspaceUri(context.spaceUri);
      if (!workspace) return invalid("extension install must be scoped to a workspace space");
      if (!isExtensionId(record.extId)) return invalid("unknown extension id");
      if (context.rkey !== record.extId) return invalid("extension install key must equal extId");
      if (record.space !== extSpaceUriFor(context.authorityDid, workspace.skey, record.extId)) {
        return invalid("extension space URI does not match canonical workspace extension space");
      }
      return isDid(record.enabledBy) ? VALID : invalid("enabledBy must be a DID within the length bound");
    },
  },
  [COLLECTION.taskProject]: {
    spaceType: SPACE_TYPE.tasks, author: "member", key: "tid", sync: "all",
    semantic: (record) => {
      if (String(record.name).trim().length < 1) return invalid("project name must not be blank");
      return isHlcTimestamp(record.t) ? VALID : invalid("invalid HLC timestamp");
    },
  },
  [COLLECTION.taskProjectEdit]: {
    spaceType: SPACE_TYPE.tasks, author: "member", key: "tid", sync: "all",
    semantic: (record, context) => validateProjectEdit(record, context),
  },
  [COLLECTION.task]: {
    spaceType: SPACE_TYPE.tasks, author: "member", key: "tid", sync: "all",
    semantic: (record, context) => validateTaskRecord(record, context),
  },
  [COLLECTION.taskEdit]: {
    spaceType: SPACE_TYPE.tasks, author: "member", key: "tid", sync: "all",
    semantic: (record, context) => validateTaskEdit(record, context),
  },
  [COLLECTION.taskComment]: {
    spaceType: SPACE_TYPE.tasks, author: "member", key: "tid", sync: "all",
    semantic: (record, context) => {
      const subject = parseSpaceRecordUri(String(record.subject), context.spaceUri, COLLECTION.task);
      if (!subject || !isTid(subject.rkey)) return invalid("comment subject must be a canonical task URI in this tasks space");
      return String(record.body).trim().length >= 1 ? VALID : invalid("comment body must not be blank");
    },
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
    semantic: (record, context) => {
      const blocks = validateMessageBlocks(record.blocks);
      if (!blocks.valid) return blocks;
      return record.parent === undefined
        ? VALID
        : validateMessageParent(String(record.parent), context.spaceUri, context.knownTopLevelMessages ?? new Set(), context.knownMessages ?? new Set());
    },
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

/** The collections any member writes in a space of this type: an acceptance, a join request, a message or a reaction. */
export function memberCollections(spaceType: SpaceType): Collection[] {
  return collectionsWhere((entry) => entry.spaceType === spaceType && entry.author === "member");
}

/** Every registered collection of a space type, whatever its author kind: what the space lexicon lists and a read grant expands to. */
export function spaceCollections(spaceType: SpaceType): Collection[] {
  return collectionsWhere((entry) => entry.spaceType === spaceType);
}

const COMMAND_NAME_PATTERN = /^[a-z0-9-]{1,32}$/;
const ACTION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export function isCommandName(value: unknown): value is string {
  return typeof value === "string" && COMMAND_NAME_PATTERN.test(value);
}

export function isActionId(value: unknown): value is string {
  return typeof value === "string" && ACTION_ID_PATTERN.test(value);
}

export function isRegisteredCollection(collection: string): collection is Collection {
  return Object.hasOwn(REGISTRY, collection);
}

const LEXICONS = new Lexicons([
  workspaceProfileLexicon, directoryLexicon, workspaceRosterLexicon, adminLexicon, acceptanceLexicon, joinRequestLexicon,
  joinDecisionLexicon, messageLexicon, reactionLexicon, channelRosterLexicon, dmRequestLexicon, dmHeaderLexicon,
  dmMessageLexicon, dmReactionLexicon, dmDeclarationLexicon, appInstallLexicon, appDeclarationLexicon, appCommandLexicon,
  appActionLexicon, extInstallLexicon, taskProjectLexicon, taskProjectEditLexicon, taskLexicon, taskEditLexicon, taskCommentLexicon,
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

/**
 * `app.declaration`: the record an app account publishes in its own public repo (key `self`) with the name people see and the
 * slash commands it offers. It is a label, never a grant; an admin's app checks it before installing the account.
 */
export function validateAppDeclaration(value: unknown): RecordValidation {
  if (!isPlainObject(value)) return invalid("app declaration must be an object");
  if (value.$type !== REPO_COLLECTION.appDeclaration) return invalid("app declaration has the wrong type");
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_RECORD_BYTES) return invalid("app declaration exceeds the size limit");
  const shape = validateRecordShape(REPO_COLLECTION.appDeclaration, value);
  if (!shape.valid) return shape;
  if (value.commands === undefined) return VALID;
  const seen = new Set<string>();
  for (const command of value.commands as Array<Record<string, unknown>>) {
    if (!isCommandName(command.name)) return invalid("declared command name must match [a-z0-9-]{1,32}");
    if (seen.has(command.name)) return invalid("declared command names must be unique");
    seen.add(command.name);
  }
  return VALID;
}

export function validateMessageBlocks(blocks: unknown): RecordValidation {
  if (!Array.isArray(blocks)) return VALID;
  const seen = new Set<string>();
  for (const block of blocks) {
    if (!isPlainObject(block) || block.$type !== BLOCK_TYPE.actions || !Array.isArray(block.elements)) continue;
    for (const element of block.elements) {
      if (!isPlainObject(element)) continue;
      if (!isActionId(element.actionId)) return invalid("button actionId must match [a-zA-Z0-9_-]{1,64}");
      if (seen.has(element.actionId)) return invalid("button actionIds must be unique across a message");
      seen.add(element.actionId);
    }
  }
  return VALID;
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

const HLC_PATTERN = /^(\d{15})\.([0-9a-f]{4})$/;
const HLC_MIN_MS = 1_000_000_000_000;
const HLC_MAX_MS = 999_999_999_999_999;
const OP_REF_PATTERN = /^[0-9a-f]{32}$/;

function isHlcTimestamp(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = HLC_PATTERN.exec(value);
  if (!match) return false;
  const ms = Number(match[1]);
  return Number.isSafeInteger(ms) && ms >= HLC_MIN_MS && ms <= HLC_MAX_MS;
}

function validateOpRefList(value: unknown): RecordValidation {
  if (!Array.isArray(value)) return invalid("s must be an array");
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !OP_REF_PATTERN.test(item)) return invalid("s entries must be 32-char lowercase hex opRefs");
    if (seen.has(item)) return invalid("s entries must be unique");
    seen.add(item);
  }
  return VALID;
}

function validateClearPairs(record: Record<string, unknown>, pairs: readonly [string, string][]): RecordValidation {
  for (const [valueKey, clearKey] of pairs) {
    if (record[clearKey] === false) return invalid(`${clearKey} must be true or omitted`);
    if (record[valueKey] !== undefined && record[clearKey] === true) {
      return invalid(`cannot set both ${valueKey} and ${clearKey}`);
    }
  }
  return VALID;
}

function validateDidSet(value: unknown, fieldName: string): RecordValidation {
  if (!Array.isArray(value)) return VALID;
  const seen = new Set<string>();
  for (const item of value) {
    if (!isDid(item)) return invalid(`${fieldName} entries must be DIDs within the length bound`);
    if (seen.has(item)) return invalid(`${fieldName} entries must be unique`);
    seen.add(item);
  }
  return VALID;
}

function validateLabelSet(value: unknown, fieldName: string): RecordValidation {
  if (!Array.isArray(value)) return VALID;
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length < 1) return invalid(`${fieldName} entries must not be blank`);
    if (seen.has(item)) return invalid(`${fieldName} entries must be unique`);
    seen.add(item);
  }
  return VALID;
}

function validateDisjointSets(left: unknown, right: unknown, label: string): RecordValidation {
  if (!Array.isArray(left) || !Array.isArray(right)) return VALID;
  const leftSet = new Set(left);
  return right.some((item) => leftSet.has(item)) ? invalid(`${label} must be disjoint`) : VALID;
}

function validateProjectEdit(record: Record<string, unknown>, context: RecordContext): RecordValidation {
  const subject = parseSpaceRecordUri(String(record.subject), context.spaceUri, COLLECTION.taskProject);
  if (!subject || !isTid(subject.rkey)) return invalid("projectEdit subject must be a canonical project URI in this tasks space");
  if (!isHlcTimestamp(record.t)) return invalid("invalid HLC timestamp");
  const refs = validateOpRefList(record.s);
  if (!refs.valid) return refs;
  if (record.sTruncated === false) return invalid("sTruncated must be true or omitted");
  const clears = validateClearPairs(record, [["description", "clearDescription"]]);
  if (!clears.valid) return clears;
  if (record.name !== undefined && String(record.name).trim().length < 1) return invalid("project name must not be blank");
  const hasMutation = record.name !== undefined || record.description !== undefined || record.clearDescription === true
    || record.color !== undefined || record.deleted !== undefined;
  return hasMutation ? VALID : invalid("projectEdit must carry at least one mutation");
}

function validateTaskRecord(record: Record<string, unknown>, context: RecordContext): RecordValidation {
  if (String(record.title).trim().length < 1) return invalid("task title must not be blank");
  if (!isHlcTimestamp(record.t)) return invalid("invalid HLC timestamp");
  if (record.project !== undefined) {
    const project = parseSpaceRecordUri(String(record.project), context.spaceUri, COLLECTION.taskProject);
    if (!project || !isTid(project.rkey)) return invalid("task project must be a canonical project URI in this tasks space");
  }
  if (record.parent !== undefined) {
    const parent = parseSpaceRecordUri(String(record.parent), context.spaceUri, COLLECTION.task);
    if (!parent || !isTid(parent.rkey)) return invalid("task parent must be a canonical task URI in this tasks space");
    const selfUri = spaceRecordUri(context.spaceUri, context.repoDid, COLLECTION.task, context.rkey);
    if (record.parent === selfUri) return invalid("task parent must not be the task itself");
  }
  const assignees = validateDidSet(record.assignees, "assignees");
  if (!assignees.valid) return assignees;
  return validateLabelSet(record.labels, "labels");
}

function validateTaskEdit(record: Record<string, unknown>, context: RecordContext): RecordValidation {
  const subject = parseSpaceRecordUri(String(record.subject), context.spaceUri, COLLECTION.task);
  if (!subject || !isTid(subject.rkey)) return invalid("taskEdit subject must be a canonical task URI in this tasks space");
  if (!isHlcTimestamp(record.t)) return invalid("invalid HLC timestamp");
  const refs = validateOpRefList(record.s);
  if (!refs.valid) return refs;
  if (record.sTruncated === false) return invalid("sTruncated must be true or omitted");
  const clears = validateClearPairs(record, [
    ["description", "clearDescription"],
    ["project", "clearProject"],
    ["dueDate", "clearDueDate"],
    ["parent", "clearParent"],
  ]);
  if (!clears.valid) return clears;
  if (record.title !== undefined && String(record.title).trim().length < 1) return invalid("task title must not be blank");
  if (record.project !== undefined) {
    const project = parseSpaceRecordUri(String(record.project), context.spaceUri, COLLECTION.taskProject);
    if (!project || !isTid(project.rkey)) return invalid("taskEdit project must be a canonical project URI in this tasks space");
  }
  if (record.parent !== undefined) {
    const parent = parseSpaceRecordUri(String(record.parent), context.spaceUri, COLLECTION.task);
    if (!parent || !isTid(parent.rkey)) return invalid("taskEdit parent must be a canonical task URI in this tasks space");
    if (record.parent === record.subject) return invalid("taskEdit parent must not equal subject");
  }
  for (const check of [
    validateDidSet(record.addAssignees, "addAssignees"),
    validateDidSet(record.removeAssignees, "removeAssignees"),
    validateDisjointSets(record.addAssignees, record.removeAssignees, "addAssignees and removeAssignees"),
    validateLabelSet(record.addLabels, "addLabels"),
    validateLabelSet(record.removeLabels, "removeLabels"),
    validateDisjointSets(record.addLabels, record.removeLabels, "addLabels and removeLabels"),
  ]) {
    if (!check.valid) return check;
  }
  const hasMutation = record.title !== undefined || record.description !== undefined || record.clearDescription === true
    || record.status !== undefined || record.priority !== undefined || record.project !== undefined
    || record.clearProject === true || record.dueDate !== undefined || record.clearDueDate === true
    || record.parent !== undefined || record.clearParent === true
    || (Array.isArray(record.addAssignees) && record.addAssignees.length > 0)
    || (Array.isArray(record.removeAssignees) && record.removeAssignees.length > 0)
    || (Array.isArray(record.addLabels) && record.addLabels.length > 0)
    || (Array.isArray(record.removeLabels) && record.removeLabels.length > 0)
    || record.deleted !== undefined;
  return hasMutation ? VALID : invalid("taskEdit must carry at least one mutation");
}

function invalid(reason: string): RecordValidation {
  return { valid: false, reason };
}
