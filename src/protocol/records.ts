import {
  acceptanceRecordKey,
  canonicalParticipants,
  channelUri,
  decisionRecordKey,
  dmConversationUri,
  isDid,
  isSkey,
  isTid,
  parseDmConversationUri,
  parseDmMessageUri,
  parseSpaceRecordUri,
  reactionRecordKey,
  requestRecordKey,
  spaceRecordUri,
  subjectKey,
} from "./keys";

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

const AUTHORITY_COLLECTIONS = new Set([
  "org.slack.directory",
  "org.slack.workspace.profile",
  "org.slack.workspace.roster",
  "org.slack.admin",
  "org.slack.joinDecision",
  "org.slack.channel.roster",
]);

export function validateSpaceRecord(collection: string, value: unknown, context: RecordContext): RecordValidation {
  if (!isPlainObject(value)) return invalid("record must be an object");
  if (value.$type !== undefined && value.$type !== collection) return invalid("record type does not match its collection");
  const expectedSpaceType = collectionSpaceType(collection);
  if (!expectedSpaceType || !context.spaceUri.includes(`/space/${expectedSpaceType}/`)) {
    return invalid("collection does not belong to this space type");
  }
  if (AUTHORITY_COLLECTIONS.has(collection) && context.repoDid !== context.authorityDid) {
    return invalid("authority record has the wrong author");
  }

  const record = { ...value };
  delete record.$type;

  switch (collection) {
    case "org.slack.workspace.profile":
      return validateProfile(record, context);
    case "org.slack.directory":
      return validateDirectory(record, context);
    case "org.slack.workspace.roster":
    case "org.slack.admin":
    case "org.slack.channel.roster":
      return validateRoster(record, context);
    case "org.slack.acceptance":
      return validateAcceptance(record, context);
    case "org.slack.joinRequest":
      return validateJoinRequest(record, context);
    case "org.slack.joinDecision":
      return validateJoinDecision(record, context);
    case "org.slack.channel.message":
      return validateMessage(record, context);
    case "org.slack.channel.reaction":
      return validateReaction(record, context);
    case "org.slack.dm.request":
      return validateDmRequest(record, context);
    case "org.slack.dm.header":
      return validateDmHeader(record, context);
    case "org.slack.dm.message":
      return validateDmMessage(record, context);
    case "org.slack.dm.reaction":
      return validateDmReaction(record, context);
    default:
      return invalid("unknown collection");
  }
}

export function validateMessageParent(
  parentUri: string,
  spaceUri: string,
  knownTopLevelMessages: ReadonlySet<string>,
  knownMessages: ReadonlySet<string>,
): RecordValidation {
  if (!parseSpaceRecordUri(parentUri, spaceUri, "org.slack.channel.message")) return invalid("parent must be a canonical message URI in this channel");
  if (!knownMessages.has(parentUri)) return invalid("parent message is not in this channel");
  if (!knownTopLevelMessages.has(parentUri)) return invalid("nested replies are not supported");
  return { valid: true };
}

export function validateDmHeaderMatchesRequest(header: unknown, request: unknown): boolean {
  if (!isPlainObject(header) || !isPlainObject(request)) return false;
  if (typeof header.convKey !== "string" || header.convKey !== request.convKey) return false;
  return sameParticipants(header.participants, request.participants);
}

function validateDirectory(record: Record<string, unknown>, context: RecordContext): RecordValidation {
  if (!hasOnly(record, ["skey", "name", "visibility"])) return invalid("directory record has unknown fields");
  if (!isSkey(record.skey) || context.rkey !== record.skey) return invalid("directory key must equal skey");
  if (!boundedString(record.name, 1, 80)) return invalid("channel name must contain 1 to 80 characters");
  if (!oneOf(record.visibility, ["public", "private", "transitioning", "archived"])) return invalid("invalid channel visibility");
  return { valid: true };
}

function validateProfile(record: Record<string, unknown>, context: RecordContext): RecordValidation {
  if (!hasOnly(record, ["name", "createdAt"])) return invalid("workspace profile has unknown fields");
  if (context.rkey !== "self" || !boundedString(record.name, 1, 80) || !isDatetime(record.createdAt)) return invalid("invalid workspace profile");
  return { valid: true };
}

function validateRoster(record: Record<string, unknown>, context: RecordContext): RecordValidation {
  if (!hasOnly(record, ["subject", "active", "updatedAt"])) return invalid("roster record has unknown fields");
  if (!isDid(record.subject) || context.rkey !== subjectKey(record.subject)) return invalid("roster key must equal the subject hash");
  if (typeof record.active !== "boolean" || !isDatetime(record.updatedAt)) return invalid("invalid roster state");
  if (context.spaceUri.includes("/space/org.slack.channel/") && context.repoDid !== context.authorityDid) {
    return invalid("private roster must be authored by the workspace authority");
  }
  return { valid: true };
}

function validateAcceptance(record: Record<string, unknown>, context: RecordContext): RecordValidation {
  if (!hasOnly(record, ["workspace", "createdAt"])) return invalid("acceptance record has unknown fields");
  if (!isSpaceUri(record.workspace, "org.slack.workspace") || context.rkey !== acceptanceRecordKey(record.workspace)) return invalid("acceptance key must match its workspace");
  if (!isDatetime(record.createdAt)) return invalid("invalid acceptance timestamp");
  return { valid: true };
}

function validateJoinRequest(record: Record<string, unknown>, context: RecordContext): RecordValidation {
  if (!hasOnly(record, ["channelSkey", "requestId", "createdAt"])) return invalid("join request has unknown fields");
  if (!isSkey(record.channelSkey) || !isTid(record.requestId) || !isDatetime(record.createdAt)) return invalid("invalid join request fields");
  const channel = channelUri(context.authorityDid, record.channelSkey);
  if (context.rkey !== requestRecordKey(channel, context.repoDid)) return invalid("join request key is not canonical");
  return { valid: true };
}

function validateJoinDecision(record: Record<string, unknown>, context: RecordContext): RecordValidation {
  if (!hasOnly(record, ["request", "requestId", "decision", "updatedAt"])) return invalid("join decision has unknown fields");
  const request = typeof record.request === "string" ? parseSpaceRecordUri(record.request, context.spaceUri, "org.slack.joinRequest") : null;
  if (!request || request.repo === context.authorityDid || context.rkey !== decisionRecordKey(record.request as string)) return invalid("join decision key must match a canonical request in this inbox");
  if (!isTid(record.requestId) || !oneOf(record.decision, ["approve", "deny"]) || !isDatetime(record.updatedAt)) return invalid("invalid join decision fields");
  return { valid: true };
}

function validateMessage(record: Record<string, unknown>, context: RecordContext): RecordValidation {
  if (!hasOnly(record, ["text", "createdAt", "parent"])) return invalid("message has unknown fields");
  if (!isTid(context.rkey)) return invalid("message key must be a TID");
  if (typeof record.text !== "string" || codePointLength(record.text) < 1 || codePointLength(record.text) > 10000) return invalid("message text must contain 1 to 10000 Unicode code points");
  if (!isDatetime(record.createdAt)) return invalid("invalid message timestamp");
  if (record.parent !== undefined) {
    if (typeof record.parent !== "string") return invalid("parent must be an AT URI");
    const parent = validateMessageParent(record.parent, context.spaceUri, context.knownTopLevelMessages ?? new Set(), context.knownMessages ?? new Set());
    if (!parent.valid) return parent;
  }
  return { valid: true };
}

function validateReaction(record: Record<string, unknown>, context: RecordContext): RecordValidation {
  if (!hasOnly(record, ["subject", "emoji", "createdAt"])) return invalid("reaction has unknown fields");
  if (typeof record.subject !== "string" || !parseSpaceRecordUri(record.subject, context.spaceUri, "org.slack.channel.message") || !context.knownMessages?.has(record.subject)) return invalid("reaction target is not a message in this channel");
  if (!boundedString(record.emoji, 1, 32) || !isDatetime(record.createdAt)) return invalid("invalid reaction fields");
  if (context.rkey !== reactionRecordKey(record.subject, record.emoji, context.repoDid)) return invalid("reaction key is not canonical");
  return { valid: true };
}

function validateDmRequest(record: Record<string, unknown>, context: RecordContext): RecordValidation {
  const inboxOwnerDid = parseDmInboxUri(context.spaceUri);
  if (!inboxOwnerDid) return invalid("DM request must be scoped to a DM inbox space");
  if (!hasOnly(record, ["convKey", "participants", "createdAt"])) return invalid("DM request has unknown fields");
  if (!isTid(record.convKey) || context.rkey !== record.convKey) return invalid("DM request key must equal its conversation key");
  const participants = canonicalDmParticipants(record.participants);
  if (!participants) return invalid("DM request participants must be canonical");
  if (!participants.includes(context.repoDid) || !participants.includes(inboxOwnerDid)) return invalid("DM request participants must include the sender and the inbox owner");
  if (!isDatetime(record.createdAt)) return invalid("invalid DM request timestamp");
  return { valid: true };
}

function validateDmHeader(record: Record<string, unknown>, context: RecordContext): RecordValidation {
  const half = parseDmConversationUri(context.spaceUri);
  if (!half) return invalid("DM header must be scoped to a conversation half");
  if (context.repoDid !== half.ownerDid) return invalid("DM header must be authored by the half owner");
  if (!hasOnly(record, ["convKey", "participants", "createdAt"])) return invalid("DM header has unknown fields");
  if (context.rkey !== "self") return invalid("DM header key must be self");
  if (record.convKey !== half.convKey) return invalid("DM header conversation key must equal the half key");
  const participants = canonicalDmParticipants(record.participants);
  if (!participants) return invalid("DM header participants must be canonical");
  if (!participants.includes(half.ownerDid)) return invalid("DM header participants must include the half owner");
  if (!isDatetime(record.createdAt)) return invalid("invalid DM header timestamp");
  return { valid: true };
}

function validateDmMessage(record: Record<string, unknown>, context: RecordContext): RecordValidation {
  const half = parseDmConversationUri(context.spaceUri);
  if (!half) return invalid("DM message must be scoped to a conversation half");
  if (context.repoDid !== half.ownerDid) return invalid("DM message must be authored by the half owner");
  if (!hasOnly(record, ["text", "createdAt", "parent"])) return invalid("DM message has unknown fields");
  if (!isTid(context.rkey)) return invalid("DM message key must be a TID");
  if (typeof record.text !== "string" || record.text.trim().length < 1 || codePointLength(record.text) > 10000) return invalid("DM message text must contain 1 to 10000 Unicode code points");
  if (!isDatetime(record.createdAt)) return invalid("invalid DM message timestamp");
  if (record.parent !== undefined) {
    if (typeof record.parent !== "string") return invalid("parent must be an AT URI");
    const parent = validateDmParent(record.parent, context, half);
    if (!parent.valid) return parent;
  }
  return { valid: true };
}

function validateDmParent(parent: string, context: RecordContext, half: { ownerDid: string; convKey: string }): RecordValidation {
  const target = parseDmMessageUri(parent);
  if (!target) return invalid("parent must be a canonical DM message URI");
  if (target.convKey !== half.convKey) return invalid("parent must be a message in this conversation");
  if (context.participants && !context.participants.includes(target.ownerDid)) return invalid("parent must be a message from a conversation participant");
  const self = spaceRecordUri(dmConversationUri(half.ownerDid, half.convKey), context.repoDid, "org.slack.dm.message", context.rkey);
  if (parent === self) return invalid("parent must not be the message itself");
  return { valid: true };
}

function validateDmReaction(record: Record<string, unknown>, context: RecordContext): RecordValidation {
  const half = parseDmConversationUri(context.spaceUri);
  if (!half) return invalid("DM reaction must be scoped to a conversation half");
  if (context.repoDid !== half.ownerDid) return invalid("DM reaction must be authored by the half owner");
  if (!hasOnly(record, ["subject", "emoji", "createdAt"])) return invalid("DM reaction has unknown fields");
  if (typeof record.subject !== "string") return invalid("reaction target is not a DM message in this conversation");
  const subject = parseDmMessageUri(record.subject);
  if (!subject || subject.convKey !== half.convKey) return invalid("reaction target is not a DM message in this conversation");
  if (context.participants && !context.participants.includes(subject.ownerDid)) return invalid("reaction target must be a message from a conversation participant");
  if (!boundedString(record.emoji, 1, 32) || !isDatetime(record.createdAt)) return invalid("invalid reaction fields");
  if (context.rkey !== reactionRecordKey(record.subject, record.emoji, context.repoDid)) return invalid("reaction key is not canonical");
  return { valid: true };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnly(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(record).every((key) => keys.includes(key));
}

function boundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
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

function parseDmInboxUri(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^at:\/\/(did:[^/\s]+)\/space\/org\.slack\.dm\.inbox\/self$/.exec(value);
  return match && isDid(match[1]) ? match[1] : null;
}

function isSpaceUri(value: unknown, spaceType: string): value is string {
  return typeof value === "string" && new RegExp(`^at:\\/\\/did:[^/\\s]+\\/space\\/${spaceType}\\/[A-Za-z0-9._~:-]{1,128}$`).test(value);
}

function collectionSpaceType(collection: string): string | undefined {
  if (["org.slack.workspace.profile", "org.slack.directory", "org.slack.workspace.roster", "org.slack.admin", "org.slack.acceptance"].includes(collection)) return "org.slack.workspace";
  if (["org.slack.joinRequest", "org.slack.joinDecision"].includes(collection)) return "org.slack.inbox";
  if (["org.slack.channel.message", "org.slack.channel.reaction", "org.slack.channel.roster"].includes(collection)) return "org.slack.channel";
  if (collection === "org.slack.dm.request") return "org.slack.dm.inbox";
  if (["org.slack.dm.header", "org.slack.dm.message", "org.slack.dm.reaction"].includes(collection)) return "org.slack.dm.conversation";
  return undefined;
}

function isDatetime(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function invalid(reason: string): RecordValidation {
  return { valid: false, reason };
}
