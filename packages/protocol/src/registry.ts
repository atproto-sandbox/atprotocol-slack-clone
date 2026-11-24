import { jsonToLex, Lexicons, parseLexiconDoc } from "@atproto/lexicon";
import { isValidNsid } from "@atproto/syntax";
import labelDefsLexicon from "../lexicons/com/atproto/label/defs.json";
import labelRecordLexicon from "../lexicons/com/atproto/label/record.json";
import managedspacePolicyLexicon from "../lexicons/com/atproto/managedspace/policy.json";
import memberspacePolicyLexicon from "../lexicons/com/atproto/memberspace/policy.json";
import personalspacePolicyLexicon from "../lexicons/com/atproto/personalspace/policy.json";
import spacePolicyLexicon from "../lexicons/com/atproto/space/policy.json";
import openSocialAcceptanceLexicon from "../lexicons/group/opensocial/acceptance.json";
import openSocialDeclarationLexicon from "../lexicons/group/opensocial/declaration.json";
import openSocialDefsLexicon from "../lexicons/group/opensocial/defs.json";
import openSocialInviteLexicon from "../lexicons/group/opensocial/invite.json";
import openSocialInvitesSpaceLexicon from "../lexicons/group/opensocial/invites.json";
import openSocialLabelerLexicon from "../lexicons/group/opensocial/labeler.json";
import openSocialMembersSpaceLexicon from "../lexicons/group/opensocial/members.json";
import openSocialMembershipLexicon from "../lexicons/group/opensocial/membership.json";
import openSocialMetaSpaceLexicon from "../lexicons/group/opensocial/meta.json";
import openSocialPolicyLexicon from "../lexicons/group/opensocial/policy.json";
import openSocialProfileLexicon from "../lexicons/group/opensocial/profile.json";
import openSocialRoleLexicon from "../lexicons/group/opensocial/role.json";
import openSocialRuleLexicon from "../lexicons/group/opensocial/rule.json";
import openSocialSpaceIndexLexicon from "../lexicons/group/opensocial/space.json";
import appActionLexicon from "../lexicons/new/flock/app/action.json";
import appCommandLexicon from "../lexicons/new/flock/app/command.json";
import appDeclarationLexicon from "../lexicons/new/flock/app/declaration.json";
import appInboxSpaceLexicon from "../lexicons/new/flock/app/inbox.json";
import appInstallLexicon from "../lexicons/new/flock/app/install.json";
import channelSpaceLexicon from "../lexicons/new/flock/channel.json";
import messageLexicon from "../lexicons/new/flock/channel/message.json";
import reactionLexicon from "../lexicons/new/flock/channel/reaction.json";
import directoryLexicon from "../lexicons/new/flock/directory.json";
import dmConversationSpaceLexicon from "../lexicons/new/flock/dm/conversation.json";
import dmDeclarationLexicon from "../lexicons/new/flock/dm/declaration.json";
import dmHeaderLexicon from "../lexicons/new/flock/dm/header.json";
import dmInboxSpaceLexicon from "../lexicons/new/flock/dm/inbox.json";
import dmMessageLexicon from "../lexicons/new/flock/dm/message.json";
import dmReactionLexicon from "../lexicons/new/flock/dm/reaction.json";
import dmRequestLexicon from "../lexicons/new/flock/dm/request.json";
import extInstallLexicon from "../lexicons/new/flock/ext/install.json";
import tasksSpaceLexicon from "../lexicons/new/flock/ext/tasks.json";
import taskCommentLexicon from "../lexicons/new/flock/ext/tasks/comment.json";
import taskProjectLexicon from "../lexicons/new/flock/ext/tasks/project.json";
import taskProjectEditLexicon from "../lexicons/new/flock/ext/tasks/projectEdit.json";
import taskLexicon from "../lexicons/new/flock/ext/tasks/task.json";
import taskEditLexicon from "../lexicons/new/flock/ext/tasks/taskEdit.json";
import inboxSpaceLexicon from "../lexicons/new/flock/inbox.json";
import joinDecisionLexicon from "../lexicons/new/flock/joinDecision.json";
import joinRequestLexicon from "../lexicons/new/flock/joinRequest.json";
import workspaceSpaceLexicon from "../lexicons/new/flock/workspace.json";
import { extSpaceUriFor, isExtensionId } from "./extensions";
import {
  canonicalParticipants,
  channelUri,
  decisionRecordKey,
  dmConversationUri,
  groupMembersUri,
  groupMetaUri,
  isDid,
  isRecordKey,
  isSkey,
  isTid,
  parseAnySpaceRecordUri,
  parseChannelUri,
  parseDmConversationUri,
  parseDmInboxUri,
  parseDmMessageUri,
  parsePersonalInvitesUri,
  parseSpaceRecordUri,
  parseSpaceUri,
  parseWorkspaceUri,
  reactionRecordKey,
  requestRecordKey,
  SELF_SKEY,
  spaceRecordUri,
  subjectKey,
} from "./keys";
import {
  ATPROTO_SPACE_COLLECTION,
  BLOCK_TYPE,
  COLLECTION,
  FLOCK_EXTENSION_FIELD,
  OPENSOCIAL_COLLECTION,
  OPENSOCIAL_POLICY,
  OPENSOCIAL_SPACE_TYPE,
  REPO_COLLECTION,
  SPACE_TYPE,
  type AnySpaceType,
  type Collection,
  type OpenSocialCollection,
  type SpaceType,
} from "./nsids";
import { expandGroupScopes, expandPolicyGrantScopes, type GroupOpenSocialPolicy } from "./scopes";

export type RecordValidation =
  | { valid: true }
  | { valid: false; reason: string; code?: string };

export type RecordContext = {
  authorityDid: string;
  spaceUri: string;
  repoDid: string;
  rkey: string;
  knownTopLevelMessages?: ReadonlySet<string>;
  knownMessages?: ReadonlySet<string>;
  participants?: readonly string[];
};

/** Who may write a record: the space's authority, any member with write access, an external group inviter, or the owner of a DM conversation half. */
export type Author = "authority" | "member" | "inviter" | "halfOwner";
/** How a record's key is formed: a TID, the literal `self`, any valid record-key (1..512 chars), or derived from the record. */
export type KeyRule = "tid" | "self" | "recordKey" | "derived";
/** How a client syncs a writer's records: newest-first down to a window (history), or all of them (a bounded set). */
export type SyncStrategy = "window" | "all";

export type RegisteredSpaceCollection = Collection | OpenSocialCollection;

export type CollectionEntry = {
  spaceType: AnySpaceType;
  author: Author;
  key: KeyRule;
  sync: SyncStrategy;
  semantic?: (record: Record<string, unknown>, context: RecordContext) => RecordValidation;
};

/** The largest record the app reads; anything bigger is rejected before its fields are examined. */
export const MAX_RECORD_BYTES = 64 * 1024;

const VALID: RecordValidation = { valid: true };
const PRINTABLE_ASCII_TOKEN = /^[\x21-\x7E]{1,256}$/;

const LITERAL_SELF_SPACE_TYPES = new Set<string>([
  OPENSOCIAL_SPACE_TYPE.meta,
  OPENSOCIAL_SPACE_TYPE.members,
  OPENSOCIAL_SPACE_TYPE.invites,
  SPACE_TYPE.workspace,
  SPACE_TYPE.inbox,
  SPACE_TYPE.dmInbox,
]);

export type DecodedMembershipExtensions =
  | {
      valid: true;
      incarnation?: string;
      generation?: number;
      admittedSpaceRev?: string;
      afterWriterRev?: string | null;
    }
  | { valid: false; reason: string; code: string };

export type DecodedAcceptanceExtensions =
  | {
      valid: true;
      incarnation?: string;
    }
  | { valid: false; reason: string; code: string };

/**
 * Validates optional Flock open-object extension properties on `group.opensocial.membership`.
 * Rejects wrong types or invalid/leading-`k`–`z` 13-char TIDs without ever invoking throwing `TID.fromStr`.
 */
export function decodeFlockMembershipExtensions(record: Record<string, unknown>): DecodedMembershipExtensions {
  const rawInc = record[FLOCK_EXTENSION_FIELD.incarnation];
  let incarnation: string | undefined;
  if (rawInc !== undefined) {
    if (typeof rawInc !== "string" || !PRINTABLE_ASCII_TOKEN.test(rawInc)) {
      return {
        valid: false,
        code: "InvalidExtensionField",
        reason: `${FLOCK_EXTENSION_FIELD.incarnation} must be 1..256 printable non-whitespace ASCII characters`,
      };
    }
    incarnation = rawInc;
  }

  const rawGen = record[FLOCK_EXTENSION_FIELD.generation];
  let generation: number | undefined;
  if (rawGen !== undefined) {
    if (typeof rawGen !== "number" || !Number.isSafeInteger(rawGen) || rawGen < 1 || rawGen > 1_000_000) {
      return {
        valid: false,
        code: "InvalidExtensionField",
        reason: `${FLOCK_EXTENSION_FIELD.generation} must be a safe integer in 1..1_000_000`,
      };
    }
    generation = rawGen;
  }

  const rawAdmitted = record[FLOCK_EXTENSION_FIELD.admittedSpaceRev];
  let admittedSpaceRev: string | undefined;
  if (rawAdmitted !== undefined) {
    if (!isTid(rawAdmitted)) {
      return {
        valid: false,
        code: "InvalidExtensionField",
        reason: `${FLOCK_EXTENSION_FIELD.admittedSpaceRev} must be a canonical 13-char TID starting with [234567abcdefghij]`,
      };
    }
    admittedSpaceRev = rawAdmitted;
  }

  const rawAfter = record[FLOCK_EXTENSION_FIELD.afterWriterRev];
  let afterWriterRev: string | null | undefined;
  if (rawAfter !== undefined) {
    if (rawAfter !== null && !isTid(rawAfter)) {
      return {
        valid: false,
        code: "InvalidExtensionField",
        reason: `${FLOCK_EXTENSION_FIELD.afterWriterRev} must be null or a canonical 13-char TID starting with [234567abcdefghij]`,
      };
    }
    afterWriterRev = rawAfter;
  }

  return {
    valid: true,
    ...(incarnation !== undefined ? { incarnation } : {}),
    ...(generation !== undefined ? { generation } : {}),
    ...(admittedSpaceRev !== undefined ? { admittedSpaceRev } : {}),
    ...(afterWriterRev !== undefined ? { afterWriterRev } : {}),
  };
}

/**
 * Validates optional Flock incarnation extension property on `group.opensocial.acceptance`.
 */
export function decodeFlockAcceptanceExtensions(record: Record<string, unknown>): DecodedAcceptanceExtensions {
  const rawInc = record[FLOCK_EXTENSION_FIELD.incarnation];
  if (rawInc !== undefined) {
    if (typeof rawInc !== "string" || !PRINTABLE_ASCII_TOKEN.test(rawInc)) {
      return {
        valid: false,
        code: "InvalidExtensionField",
        reason: `${FLOCK_EXTENSION_FIELD.incarnation} must be 1..256 printable non-whitespace ASCII characters`,
      };
    }
    return { valid: true, incarnation: rawInc };
  }
  return { valid: true };
}

/**
 * Protocol-level space key validation across `literal:self`, `tid`, and `any` (`isValidRecordKey` 1..512 chars) space types.
 */
export function validateSpaceTypeKey(
  spaceType: string,
  skey: string,
  options: { isGroupHostOwnSpace?: boolean } = {},
): RecordValidation {
  if (!isValidNsid(spaceType)) {
    return invalid("spaceType must be a valid NSID", "InvalidSpaceKey");
  }
  if (options.isGroupHostOwnSpace && spaceType === OPENSOCIAL_SPACE_TYPE.invites) {
    return invalid("group.opensocial.invites is a personal-PDS space and cannot be owned by a group", "InvalidSpaceKey");
  }
  if (LITERAL_SELF_SPACE_TYPES.has(spaceType)) {
    return skey === SELF_SKEY
      ? VALID
      : invalid(`${spaceType} requires literal:self key (got ${JSON.stringify(skey)})`, "InvalidSpaceKey");
  }
  if (spaceType === SPACE_TYPE.dmConversation) {
    return isTid(skey)
      ? VALID
      : invalid(`${spaceType} requires a canonical TID key`, "InvalidSpaceKey");
  }
  return isRecordKey(skey)
    ? VALID
    : invalid(`${spaceType} key must be a valid ATProto record key (1..512 chars, not '.' or '..')`, "InvalidSpaceKey");
}

function isHttpOrHttpsUrl(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export const REGISTRY: { readonly [C in RegisteredSpaceCollection]: CollectionEntry } = {
  // OpenSocial atmospheric group collections
  [OPENSOCIAL_COLLECTION.profile]: {
    spaceType: OPENSOCIAL_SPACE_TYPE.meta,
    author: "authority",
    key: "self",
    sync: "all",
    semantic: (record) => {
      if (record.url !== undefined && !isHttpOrHttpsUrl(record.url)) {
        return invalid("profile url must use http or https scheme", "InvalidRequest");
      }
      return VALID;
    },
  },
  [OPENSOCIAL_COLLECTION.rule]: {
    spaceType: OPENSOCIAL_SPACE_TYPE.meta,
    author: "authority",
    key: "tid",
    sync: "all",
  },
  [OPENSOCIAL_COLLECTION.labeler]: {
    spaceType: OPENSOCIAL_SPACE_TYPE.meta,
    author: "authority",
    key: "self",
    sync: "all",
  },
  [OPENSOCIAL_COLLECTION.space]: {
    spaceType: OPENSOCIAL_SPACE_TYPE.members,
    author: "authority",
    key: "tid",
    sync: "all",
    semantic: (record, context) => {
      const target = parseSpaceUri(String(record.space));
      if (!target || target.authorityDid !== context.authorityDid) {
        return invalid("space index entry must reference a space of this group", "InvalidRequest");
      }
      if (
        target.type === OPENSOCIAL_SPACE_TYPE.meta ||
        target.type === OPENSOCIAL_SPACE_TYPE.members ||
        target.type === OPENSOCIAL_SPACE_TYPE.invites
      ) {
        return invalid("core or personal spaces are excluded from group.opensocial.space", "InvalidRequest");
      }
      const keyCheck = validateSpaceTypeKey(target.type, target.skey, { isGroupHostOwnSpace: true });
      return keyCheck.valid ? VALID : keyCheck;
    },
  },
  [OPENSOCIAL_COLLECTION.role]: {
    spaceType: OPENSOCIAL_SPACE_TYPE.members,
    author: "authority",
    key: "recordKey",
    sync: "all",
    semantic: (record, context) => {
      if (Array.isArray(record.scopes) && record.scopes.length > 0) {
        try {
          expandGroupScopes(
            record.scopes as readonly string[],
            isDid(context.authorityDid) ? context.authorityDid : undefined,
          );
        } catch (error) {
          return invalid(error instanceof Error ? error.message : "invalid role scope", "InvalidScope");
        }
      }
      if (Array.isArray(record.assignable)) {
        for (const item of record.assignable) {
          if (item !== "*" && !isRecordKey(item)) {
            return invalid("role assignable entries must be '*' or valid record keys", "InvalidRequest");
          }
        }
      }
      return VALID;
    },
  },
  [OPENSOCIAL_COLLECTION.membership]: {
    spaceType: OPENSOCIAL_SPACE_TYPE.members,
    author: "authority",
    key: "derived",
    sync: "all",
    semantic: (record, context) => {
      if (!isDid(context.rkey)) {
        return invalid("membership key must be a valid member DID", "InvalidRequest");
      }
      if (context.rkey === context.authorityDid) {
        return invalid("group DID has implicit membership and cannot have an explicit membership record", "CannotTargetGroupSelf");
      }
      const roles = record.roles;
      if (!Array.isArray(roles) || roles.length < 1) {
        return invalid("membership roles must contain at least one role", "EmptyMemberRoles");
      }
      if (new Set(roles).size !== roles.length) {
        return invalid("membership roles must be unique", "InvalidRequest");
      }
      const ext = decodeFlockMembershipExtensions(record);
      if (!ext.valid) return invalid(ext.reason, ext.code);
      return VALID;
    },
  },
  [OPENSOCIAL_COLLECTION.acceptance]: {
    spaceType: OPENSOCIAL_SPACE_TYPE.members,
    author: "member",
    key: "self",
    sync: "all",
    semantic: (record, context) => {
      if (context.repoDid === context.authorityDid) {
        return invalid("group DID cannot author a membership acceptance record", "CannotTargetGroupSelf");
      }
      const ext = decodeFlockAcceptanceExtensions(record);
      if (!ext.valid) return invalid(ext.reason, ext.code);
      return VALID;
    },
  },
  [OPENSOCIAL_COLLECTION.invite]: {
    spaceType: OPENSOCIAL_SPACE_TYPE.invites,
    author: "inviter",
    key: "tid",
    sync: "all",
    semantic: (_record, context) => {
      const target = parsePersonalInvitesUri(context.spaceUri);
      if (!target) {
        return invalid("invite must reside in a personal group.opensocial.invites/self space", "InvalidRequest");
      }
      if (!isDid(context.repoDid) || context.repoDid === target.userDid) {
        return invalid("invite must be authored by an inviting group DID distinct from the invitee", "InvalidRequest");
      }
      return VALID;
    },
  },

  // Flock modality & DM collections
  [COLLECTION.directory]: {
    spaceType: SPACE_TYPE.workspace,
    author: "authority",
    key: "derived",
    sync: "all",
    semantic: (record, context) =>
      isSkey(record.skey) && context.rkey === record.skey
        ? VALID
        : invalid("directory key must equal a valid channel skey"),
  },
  [COLLECTION.appInstall]: {
    spaceType: SPACE_TYPE.workspace,
    author: "authority",
    key: "derived",
    sync: "all",
    semantic: (record, context) => {
      const keyed = subjectKeyed(record, context);
      if (!keyed.valid) return keyed;
      if (record.subject === context.authorityDid) {
        return invalid("cannot install the group DID as an app service principal", "CannotTargetGroupSelf");
      }
      const skeys = (record.channels as Array<{ skey: string }>).map((grant) => grant.skey);
      if (!skeys.every(isSkey)) return invalid("an app install channel key must be a valid skey");
      return new Set(skeys).size === skeys.length ? VALID : invalid("an app install grants each channel once");
    },
  },
  [COLLECTION.appCommand]: {
    spaceType: SPACE_TYPE.appInbox,
    author: "member",
    key: "tid",
    sync: "window",
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
    spaceType: SPACE_TYPE.appInbox,
    author: "member",
    key: "tid",
    sync: "window",
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
    spaceType: SPACE_TYPE.workspace,
    author: "authority",
    key: "derived",
    sync: "all",
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
    spaceType: SPACE_TYPE.tasks,
    author: "member",
    key: "tid",
    sync: "all",
    semantic: (record) => {
      if (String(record.name).trim().length < 1) return invalid("project name must not be blank");
      return isHlcTimestamp(record.t) ? VALID : invalid("invalid HLC timestamp");
    },
  },
  [COLLECTION.taskProjectEdit]: {
    spaceType: SPACE_TYPE.tasks,
    author: "member",
    key: "tid",
    sync: "all",
    semantic: (record, context) => validateProjectEdit(record, context),
  },
  [COLLECTION.task]: {
    spaceType: SPACE_TYPE.tasks,
    author: "member",
    key: "tid",
    sync: "all",
    semantic: (record, context) => validateTaskRecord(record, context),
  },
  [COLLECTION.taskEdit]: {
    spaceType: SPACE_TYPE.tasks,
    author: "member",
    key: "tid",
    sync: "all",
    semantic: (record, context) => validateTaskEdit(record, context),
  },
  [COLLECTION.taskComment]: {
    spaceType: SPACE_TYPE.tasks,
    author: "member",
    key: "tid",
    sync: "all",
    semantic: (record, context) => {
      const subject = parseSpaceRecordUri(String(record.subject), context.spaceUri, COLLECTION.task);
      if (!subject || !isTid(subject.rkey)) return invalid("comment subject must be a canonical task URI in this tasks space");
      return String(record.body).trim().length >= 1 ? VALID : invalid("comment body must not be blank");
    },
  },
  [COLLECTION.joinRequest]: {
    spaceType: SPACE_TYPE.inbox,
    author: "member",
    key: "derived",
    sync: "all",
    semantic: (record, context) =>
      isSkey(record.channelSkey) && context.rkey === requestRecordKey(channelUri(context.authorityDid, record.channelSkey), context.repoDid)
        ? VALID
        : invalid("join request key is not canonical"),
  },
  [COLLECTION.joinDecision]: {
    spaceType: SPACE_TYPE.inbox,
    author: "authority",
    key: "derived",
    sync: "all",
    semantic: (record, context) => {
      const request = parseSpaceRecordUri(String(record.request), context.spaceUri, COLLECTION.joinRequest);
      return request && request.repo !== context.authorityDid && context.rkey === decisionRecordKey(String(record.request))
        ? VALID
        : invalid("join decision key must match a canonical request in this inbox");
    },
  },
  [COLLECTION.message]: {
    spaceType: SPACE_TYPE.channel,
    author: "member",
    key: "tid",
    sync: "window",
    semantic: (record, context) => {
      const blocks = validateMessageBlocks(record.blocks);
      if (!blocks.valid) return blocks;
      return record.parent === undefined
        ? VALID
        : validateMessageParent(String(record.parent), context.spaceUri, context.knownTopLevelMessages ?? new Set(), context.knownMessages ?? new Set());
    },
  },
  [COLLECTION.reaction]: {
    spaceType: SPACE_TYPE.channel,
    author: "member",
    key: "derived",
    sync: "all",
    semantic: (record, context) => {
      const subject = String(record.subject);
      if (!parseSpaceRecordUri(subject, context.spaceUri, COLLECTION.message) || !context.knownMessages?.has(subject)) {
        return invalid("reaction target is not a message in this channel");
      }
      return context.rkey === reactionRecordKey(subject, String(record.emoji), context.repoDid) ? VALID : invalid("reaction key is not canonical");
    },
  },
  [COLLECTION.dmRequest]: {
    spaceType: SPACE_TYPE.dmInbox,
    author: "member",
    key: "derived",
    sync: "all",
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
    spaceType: SPACE_TYPE.dmConversation,
    author: "halfOwner",
    key: "self",
    sync: "all",
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
    spaceType: SPACE_TYPE.dmConversation,
    author: "halfOwner",
    key: "tid",
    sync: "window",
    semantic: (record, context) => {
      if (String(record.text).trim().length < 1) return invalid("DM message text must not be blank");
      return record.parent === undefined ? VALID : validateDmParent(String(record.parent), context);
    },
  },
  [COLLECTION.dmReaction]: {
    spaceType: SPACE_TYPE.dmConversation,
    author: "halfOwner",
    key: "derived",
    sync: "all",
    semantic: (record, context) => {
      const half = parseDmConversationUri(context.spaceUri);
      const subject = parseDmMessageUri(record.subject);
      if (!half || !subject || subject.convKey !== half.convKey) return invalid("reaction target is not a DM message in this conversation");
      if (context.participants && !context.participants.includes(subject.ownerDid)) return invalid("reaction target must be a message from a conversation participant");
      return context.rkey === reactionRecordKey(String(record.subject), String(record.emoji), context.repoDid) ? VALID : invalid("reaction key is not canonical");
    },
  },
};

const LABELABLE_SPACE_TYPES = new Set<string>([
  OPENSOCIAL_SPACE_TYPE.meta,
  OPENSOCIAL_SPACE_TYPE.members,
  SPACE_TYPE.workspace,
  SPACE_TYPE.inbox,
  SPACE_TYPE.channel,
  SPACE_TYPE.appInbox,
  SPACE_TYPE.tasks,
]);

/** The collections the authority writes in each space type. */
export function authorityCollections(spaceType: AnySpaceType): RegisteredSpaceCollection[] {
  return collectionsWhere((entry) => entry.spaceType === spaceType && entry.author === "authority");
}

/** The collections any member writes in a space of this type. */
export function memberCollections(spaceType: AnySpaceType): RegisteredSpaceCollection[] {
  return collectionsWhere((entry) => entry.spaceType === spaceType && entry.author === "member");
}

/** Every declared collection of a space type (including `com.atproto.label.record` on group spaces). */
export function spaceCollections(spaceType: SpaceType | AnySpaceType): string[] {
  const cols: string[] = collectionsWhere((entry) => entry.spaceType === spaceType);
  if (LABELABLE_SPACE_TYPES.has(spaceType)) {
    cols.push(ATPROTO_SPACE_COLLECTION.label);
  }
  return cols;
}

const COMMAND_NAME_PATTERN = /^[a-z0-9-]{1,32}$/;
const ACTION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export function isCommandName(value: unknown): value is string {
  return typeof value === "string" && COMMAND_NAME_PATTERN.test(value);
}

export function isActionId(value: unknown): value is string {
  return typeof value === "string" && ACTION_ID_PATTERN.test(value);
}

export function isRegisteredCollection(collection: string): collection is RegisteredSpaceCollection {
  return Object.hasOwn(REGISTRY, collection);
}

/** Collections that MUST pass shape + semantic validation even when `validate: false` is passed on host writes/imports. */
export const MANDATORY_VALIDATED_SPACE_COLLECTIONS: ReadonlySet<string> = new Set<string>([
  ATPROTO_SPACE_COLLECTION.spacePolicy,
  ATPROTO_SPACE_COLLECTION.label,
  OPENSOCIAL_COLLECTION.profile,
  OPENSOCIAL_COLLECTION.rule,
  OPENSOCIAL_COLLECTION.labeler,
  OPENSOCIAL_COLLECTION.space,
  OPENSOCIAL_COLLECTION.role,
  OPENSOCIAL_COLLECTION.membership,
  OPENSOCIAL_COLLECTION.acceptance,
  OPENSOCIAL_COLLECTION.invite,
  COLLECTION.appInstall,
]);

const LEXICONS = new Lexicons([
  // ATProto base schemas
  labelDefsLexicon,
  labelRecordLexicon,
  spacePolicyLexicon,
  memberspacePolicyLexicon,
  managedspacePolicyLexicon,
  personalspacePolicyLexicon,
  // OpenSocial schemas
  openSocialDefsLexicon,
  openSocialPolicyLexicon,
  openSocialDeclarationLexicon,
  openSocialProfileLexicon,
  openSocialRuleLexicon,
  openSocialLabelerLexicon,
  openSocialSpaceIndexLexicon,
  openSocialRoleLexicon,
  openSocialMembershipLexicon,
  openSocialAcceptanceLexicon,
  openSocialInviteLexicon,
  openSocialMetaSpaceLexicon,
  openSocialMembersSpaceLexicon,
  openSocialInvitesSpaceLexicon,
  // Flock schemas
  workspaceSpaceLexicon,
  inboxSpaceLexicon,
  channelSpaceLexicon,
  appInboxSpaceLexicon,
  tasksSpaceLexicon,
  dmInboxSpaceLexicon,
  dmConversationSpaceLexicon,
  directoryLexicon,
  joinRequestLexicon,
  joinDecisionLexicon,
  messageLexicon,
  reactionLexicon,
  dmRequestLexicon,
  dmHeaderLexicon,
  dmMessageLexicon,
  dmReactionLexicon,
  dmDeclarationLexicon,
  appInstallLexicon,
  appDeclarationLexicon,
  appCommandLexicon,
  appActionLexicon,
  extInstallLexicon,
  taskProjectLexicon,
  taskProjectEditLexicon,
  taskLexicon,
  taskEditLexicon,
  taskCommentLexicon,
].map((document) => parseLexiconDoc(document)));

/** The shape a published lexicon gives a record or object, and nothing more. */
export function validateRecordShape(collection: string, value: unknown): RecordValidation {
  let lexVal = value;
  if (isPlainObject(value)) {
    try {
      lexVal = jsonToLex(value);
    } catch (error) {
      return invalid(error instanceof Error ? error.message : "malformed lexicon value");
    }
  }
  const result = LEXICONS.validate(collection, lexVal);
  return result.success ? VALID : invalid(result.error.message);
}

/** Whether `name` fits the directory record that names a channel. */
export function fitsDirectoryName(name: string): boolean {
  return validateRecordShape(COLLECTION.directory, { skey: SELF_SKEY, name, visibility: "public" }).valid;
}

/**
 * Validates a `group.opensocial.policy` object for `(groupDid, spaceType, skey)`:
 * checks Lexicon shape, unique `grant.role` keys (`DuplicateRoleGrant`), and `expandPolicyGrantScopes`
 * on every `grant.scopes` entry (`InvalidSpacePolicyScope`).
 */
export function validateSpacePolicy(
  policy: unknown,
  context: { groupDid: string; spaceType: string; skey: string },
): RecordValidation {
  if (!isPlainObject(policy)) {
    return invalid("space policy must be an object", "InvalidRequest");
  }
  if (policy.$type !== OPENSOCIAL_POLICY) {
    return invalid(`space policy must have $type ${OPENSOCIAL_POLICY}`, "InvalidSpacePolicy");
  }
  if (new TextEncoder().encode(JSON.stringify(policy)).length > MAX_RECORD_BYTES) {
    return invalid("space policy exceeds size limit", "InvalidRequest");
  }
  const shape = LEXICONS.validate(`${OPENSOCIAL_POLICY}#main`, policy);
  if (!shape.success) {
    return invalid(shape.error.message, "InvalidRequest");
  }
  const grants = (policy as GroupOpenSocialPolicy).grants;
  const seenRoles = new Set<string>();
  for (const grant of grants) {
    if (!isRecordKey(grant.role)) {
      return invalid(`grant role must be a valid record key: ${grant.role}`, "InvalidRequest");
    }
    if (seenRoles.has(grant.role)) {
      return invalid(`duplicate policy grant for role ${grant.role}`, "DuplicateRoleGrant");
    }
    seenRoles.add(grant.role);
    if (grant.scopes && grant.scopes.length > 0) {
      try {
        expandPolicyGrantScopes(grant.scopes, context);
      } catch (error) {
        return invalid(
          error instanceof Error ? error.message : "invalid space policy grant scope",
          "InvalidSpacePolicyScope",
        );
      }
    }
  }
  return VALID;
}

/**
 * Deterministic semantic fingerprint for a validated `group.opensocial.policy` object,
 * normalizing optional booleans (`false` vs omitted), role grant ordering, and grant scope sets.
 */
export function canonicalOpenSocialPolicyKey(policy: GroupOpenSocialPolicy): string {
  return JSON.stringify({
    $type: OPENSOCIAL_POLICY,
    publicRead: policy.publicRead === true,
    unlisted: policy.unlisted === true,
    grants: [...policy.grants]
      .sort((a, b) => (a.role < b.role ? -1 : a.role > b.role ? 1 : 0))
      .map((grant) => ({
        role: grant.role,
        read: grant.read === true,
        write: grant.write === true,
        scopes: grant.scopes && grant.scopes.length > 0 ? [...new Set(grant.scopes)].sort() : [],
      })),
  });
}

/**
 * Validates `com.atproto.label.record` inside a group space (`tid` rkey, `<groupDid>` author,
 * non-empty `val`, and same-space targeting / `members/self` account targeting).
 */
export function validateLabelRecord(value: unknown, context: RecordContext): RecordValidation {
  if (!isPlainObject(value)) return invalid("label record must be an object", "InvalidRequest");
  if (value.$type !== undefined && value.$type !== ATPROTO_SPACE_COLLECTION.label) {
    return invalid("record type does not match com.atproto.label.record", "InvalidRequest");
  }
  const parsedSpace = parseSpaceUri(context.spaceUri);
  if (!parsedSpace) {
    return invalid("invalid space URI for label record", "InvalidRequest");
  }
  const keyCheck = validateSpaceTypeKey(parsedSpace.type, parsedSpace.skey);
  if (!keyCheck.valid) return keyCheck;
  if (
    parsedSpace.type === OPENSOCIAL_SPACE_TYPE.invites ||
    parsedSpace.type === SPACE_TYPE.dmInbox ||
    parsedSpace.type === SPACE_TYPE.dmConversation
  ) {
    return invalid("com.atproto.label.record does not belong to this space type", "InvalidRequest");
  }
  if (context.repoDid !== context.authorityDid) {
    return invalid("authority record has the wrong author: labels must be authored by the group DID", "InvalidRequest");
  }
  if (!isTid(context.rkey)) {
    return invalid("label record key must be a canonical TID", "InvalidRequest");
  }
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_RECORD_BYTES) {
    return invalid("record exceeds the size limit", "InvalidRequest");
  }
  const shape = validateRecordShape(ATPROTO_SPACE_COLLECTION.label, value);
  if (!shape.valid) return shape;
  if (typeof value.val !== "string" || value.val.length < 1) {
    return invalid("label val must be non-empty", "EmptyLabelValue");
  }
  const targetUri = String(value.uri);
  if (isDid(targetUri)) {
    if (context.spaceUri !== groupMembersUri(context.authorityDid)) {
      return invalid("account DID labels must reside in group.opensocial.members/self", "CrossSpaceLabel");
    }
    if (value.cid !== undefined) {
      return invalid("account DID labels cannot specify cid", "InvalidRequest");
    }
    return VALID;
  }
  const targetRecord = parseAnySpaceRecordUri(targetUri);
  if (!targetRecord || targetRecord.spaceUri !== context.spaceUri) {
    return invalid("space record label must reside in the same space as its target record", "CrossSpaceLabel");
  }
  return VALID;
}

export function validateSpaceRecord(collection: string, value: unknown, context: RecordContext): RecordValidation {
  if (!isPlainObject(value)) return invalid("record must be an object");
  if (value.$type !== undefined && value.$type !== collection) return invalid("record type does not match its collection");

  if (collection === ATPROTO_SPACE_COLLECTION.label) {
    return validateLabelRecord(value, context);
  }
  if (collection === ATPROTO_SPACE_COLLECTION.spacePolicy) {
    const parsedSpace = parseSpaceUri(context.spaceUri);
    if (!parsedSpace) return invalid("invalid space URI");
    if (context.repoDid !== context.authorityDid) return invalid("authority record has the wrong author");
    if (context.rkey !== SELF_SKEY) return invalid("record key must be self");
    if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_RECORD_BYTES) return invalid("record exceeds the size limit");
    const shape = validateRecordShape(ATPROTO_SPACE_COLLECTION.spacePolicy, value);
    if (!shape.valid) return shape;
    if (isPlainObject(value.policy) && value.policy.$type === OPENSOCIAL_POLICY) {
      return validateSpacePolicy(value.policy, {
        groupDid: context.authorityDid,
        spaceType: parsedSpace.type,
        skey: parsedSpace.skey,
      });
    }
    return VALID;
  }

  if (!isRegisteredCollection(collection)) return invalid("unknown collection");
  const entry = REGISTRY[collection];
  const parsedSpace = parseSpaceUri(context.spaceUri);
  if (!parsedSpace || parsedSpace.type !== entry.spaceType) {
    return invalid("collection does not belong to this space type");
  }
  const spaceKeyCheck = validateSpaceTypeKey(parsedSpace.type, parsedSpace.skey);
  if (!spaceKeyCheck.valid) return spaceKeyCheck;

  const author = checkAuthor(entry.author, context);
  if (!author.valid) return author;
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_RECORD_BYTES) return invalid("record exceeds the size limit");
  if (entry.key === "tid" && !isTid(context.rkey)) return invalid("record key must be a TID");
  if (entry.key === "self" && context.rkey !== SELF_SKEY) return invalid("record key must be self");
  if (entry.key === "recordKey" && !isRecordKey(context.rkey)) return invalid("record key must be a valid record key");
  const shape = validateRecordShape(collection, value);
  if (!shape.valid) return shape;
  return entry.semantic?.(value, context) ?? VALID;
}

/**
 * Validates `group.opensocial.declaration/self` in `<groupDid>`'s public repository.
 */
export function validateGroupDeclaration(value: unknown, groupDid: string, rkey = SELF_SKEY): RecordValidation {
  if (rkey !== SELF_SKEY) return invalid("group declaration rkey must be self");
  if (!isDid(groupDid)) return invalid("invalid group DID");
  if (!isPlainObject(value)) return invalid("group declaration must be an object");
  if (value.$type !== undefined && value.$type !== REPO_COLLECTION.groupDeclaration) {
    return invalid("group declaration has the wrong type");
  }
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_RECORD_BYTES) {
    return invalid("group declaration exceeds the size limit");
  }
  const shape = validateRecordShape(REPO_COLLECTION.groupDeclaration, value);
  if (!shape.valid) return shape;
  if (value.meta !== groupMetaUri(groupDid)) {
    return invalid(`group declaration meta must equal ${groupMetaUri(groupDid)}`);
  }
  return VALID;
}

/**
 * Validates a public-repository record on Group Host (`validate === false` honored for arbitrary records,
 * while `group.opensocial.declaration` is unconditionally validated).
 */
export function validatePublicRecord(
  collection: string,
  value: unknown,
  context: { repoDid: string; rkey: string; validate?: boolean },
): RecordValidation {
  if (!isValidNsid(collection)) return invalid("collection must be a valid NSID");
  if (!isRecordKey(context.rkey)) return invalid("rkey must be a valid ATProto record key");
  if (!isPlainObject(value)) return invalid("record must be an object");
  if (value.$type !== undefined && value.$type !== collection) {
    return invalid("record type does not match its collection");
  }
  if (collection === REPO_COLLECTION.groupDeclaration) {
    return validateGroupDeclaration(value, context.repoDid, context.rkey);
  }
  if (context.validate === false) {
    return VALID;
  }
  if (collection === REPO_COLLECTION.dmDeclaration) {
    return context.rkey === SELF_SKEY ? validateDmDeclaration({ $type: collection, ...value }) : invalid("DM declaration rkey must be self");
  }
  if (collection === REPO_COLLECTION.appDeclaration) {
    return context.rkey === SELF_SKEY ? validateAppDeclaration({ $type: collection, ...value }) : invalid("app declaration rkey must be self");
  }
  return VALID;
}

export function validateDmDeclaration(value: unknown): RecordValidation {
  if (!isPlainObject(value)) return invalid("DM declaration must be an object");
  if (value.$type !== REPO_COLLECTION.dmDeclaration) return invalid("DM declaration has the wrong type");
  return validateRecordShape(REPO_COLLECTION.dmDeclaration, value);
}

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
  spaceUriValue: string,
  knownTopLevelMessages: ReadonlySet<string>,
  knownMessages: ReadonlySet<string>,
): RecordValidation {
  if (!parseSpaceRecordUri(parentUri, spaceUriValue, COLLECTION.message)) return invalid("parent must be a canonical message URI in this channel");
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
  if (author === "inviter" && (!isDid(context.repoDid) || context.repoDid === context.authorityDid)) {
    return invalid("invite must be authored by an external group DID");
  }
  return VALID;
}

function subjectKeyed(record: Record<string, unknown>, context: RecordContext): RecordValidation {
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

function collectionsWhere(predicate: (entry: CollectionEntry) => boolean): RegisteredSpaceCollection[] {
  return (Object.keys(REGISTRY) as RegisteredSpaceCollection[]).filter((collection) => predicate(REGISTRY[collection]));
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

function invalid(reason: string, code?: string): RecordValidation {
  return code ? { valid: false, reason, code } : { valid: false, reason };
}
