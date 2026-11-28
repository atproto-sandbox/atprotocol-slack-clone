import { fromLegacySpaceUri, isValidRecordKey, isValidTid } from "@atproto/syntax";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { ATGRP_SPACE_TYPE, COLLECTION, NAMESPACE, SPACE_TYPE } from "./nsids";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const TID_BASE32 = "234567abcdefghijklmnopqrstuvwxyz";
const ALPHA_HEX = "abcdefghijklmnop";

export const SELF_SKEY = "self";
export const DM_INBOX_SKEY = "self";

/**
 * Protocol-level ATProto record-key syntax (1..512 `[A-Za-z0-9._~:-]` characters, rejecting `.` and `..`),
 * matching `@atproto/syntax` `isValidRecordKey`.
 */
export function isRecordKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 512 &&
    /^[A-Za-z0-9._~:-]{1,512}$/.test(value) &&
    value !== "." &&
    value !== ".." &&
    isValidRecordKey(value)
  );
}

/**
 * Atmosphere Groups role ID syntax: label-value alphabet (`[a-z-]+`), min 3 characters,
 * bounded by ATProto's 512-character `record-key` maximum (`org.atgrp.role` / `org.atgrp.policy`).
 */
export function isValidRoleId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z-]{3,512}$/.test(value) && isRecordKey(value);
}

/** Atmosphere Groups moderator tag syntax: label-value alphabet (`[a-z-]+`), 1..128 characters. */
export function isValidModTag(value: unknown): value is string {
  return typeof value === "string" && /^[a-z-]{1,128}$/.test(value);
}

/** A Flock-created UI/Operator space key: record-key syntax (rejecting `.` and `..`), capped at 128 characters. */
export function isSkey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._~:-]{1,128}$/.test(value) && value !== "." && value !== "..";
}

/**
 * Canonical ATProto TID syntax: 13 characters, leading `[234567abcdefghij]` (64th bit === 0) followed by
 * 12 `[234567abcdefghijklmnopqrstuvwxyz]` characters, matching `@atproto/syntax` `isValidTid`.
 */
export function isTid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === 13 &&
    /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/.test(value) &&
    isValidTid(value)
  );
}

export type Did = `did:${string}:${string}`;

/** A DID in the syntax every part of this app accepts; the length bounds keep a hostile link from rendering as a wall of text. */
export function isDid(value: unknown): value is Did {
  return typeof value === "string" && /^did:[a-z0-9]{1,64}:[A-Za-z0-9._:%-]{1,512}$/.test(value);
}

export function stableHash(value: string): string {
  return base32(sha256(utf8ToBytes(value)));
}

export function recordKeyHash(value: string): string {
  return stableHash(value).split("").join(":");
}

export function subjectKey(did: string): string {
  return `d-${recordKeyHash(did)}`;
}

function encodeAlphaNibbles(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += ALPHA_HEX[(byte >>> 4) & 0x0f]! + ALPHA_HEX[byte & 0x0f]!;
  }
  return out;
}

/**
 * Non-roster service-principal role key: `"app-" + alphaNibbles(sha256(utf8(appDid)))`
 * (68 chars, full 256-bit SHA-256 digest, strictly matching `[a-z-]{3,512}`).
 */
export function appRoleKey(appDid: string): string {
  return `app-${encodeAlphaNibbles(sha256(utf8ToBytes(appDid)))}`;
}

/**
 * Per-private-channel role key assigned on `org.atgrp.membership`:
 * `"channel-" + alphaNibbles(utf8(channelSkey))` (bijective, strictly `[a-z-]{3,512}`,
 * 34 chars for a 13-char TID, 130 chars for a 61-char skey, 264 chars for a 128-char skey).
 */
export function channelRoleKey(channelSkey: string): string {
  if (!isSkey(channelSkey)) throw new TypeError("Invalid private channel key.");
  return `channel-${encodeAlphaNibbles(utf8ToBytes(channelSkey))}`;
}

export function requestRecordKey(channelUri: string, requesterDid: string): string {
  return `r-${recordKeyHash(joinParts(channelUri, requesterDid))}`;
}

export function reactionRecordKey(messageUri: string, emoji: string, authorDid: string): string {
  return `x-${recordKeyHash(joinParts(messageUri, emoji, authorDid))}`;
}

export function decisionRecordKey(requestUri: string): string {
  return `q-${recordKeyHash(requestUri)}`;
}

export function spaceUri(authorityDid: string, type: string, skey: string): string {
  return `at:space/${authorityDid}/${type}/${skey}`;
}

/**
 * Rewrites a legacy alpha space or space-record URI (`at://<did>/space/...`) to canonical `at:space/<did>/...`.
 * Intended ONLY for persisted state migrations, pasted links, and legacy URLs — never for XRPC params, tokens,
 * MAC headers, or STAR archives.
 */
export function normalizeLegacySpaceUri(uri: string): string {
  return fromLegacySpaceUri(uri) ?? uri;
}

export function groupMetaUri(groupDid: string): string {
  if (!isDid(groupDid)) throw new TypeError("Invalid group DID.");
  return spaceUri(groupDid, ATGRP_SPACE_TYPE.meta, SELF_SKEY);
}

export function groupMembersUri(groupDid: string): string {
  if (!isDid(groupDid)) throw new TypeError("Invalid group DID.");
  return spaceUri(groupDid, ATGRP_SPACE_TYPE.members, SELF_SKEY);
}

export function personalInboxUri(userDid: string): string {
  if (!isDid(userDid)) throw new TypeError("Invalid user DID.");
  return spaceUri(userDid, ATGRP_SPACE_TYPE.inbox, SELF_SKEY);
}

export function workspaceUri(authorityDid: string, skey = SELF_SKEY): string {
  return spaceUri(authorityDid, SPACE_TYPE.workspace, skey);
}

export function inboxUri(authorityDid: string, skey = SELF_SKEY): string {
  return spaceUri(authorityDid, SPACE_TYPE.inbox, skey);
}

export function appInboxSkey(workspaceSkey: string, appDid: string): string {
  return `i-${recordKeyHash(joinParts(workspaceSkey, appDid))}`;
}

export function appInboxUri(authorityDid: string, workspaceSkey: string, appDid: string): string {
  return spaceUri(authorityDid, SPACE_TYPE.appInbox, appInboxSkey(workspaceSkey, appDid));
}

export function extSpaceSkey(workspaceSkey: string, extId: string): string {
  return `x-${recordKeyHash(`${extId}:${workspaceSkey}`)}`;
}

export function extSpaceUri(authorityDid: string, workspaceSkey: string, extId: string, spaceType: string): string {
  return spaceUri(authorityDid, spaceType, extSpaceSkey(workspaceSkey, extId));
}

export function tasksSpaceUri(authorityDid: string, workspaceSkey = SELF_SKEY): string {
  return extSpaceUri(authorityDid, workspaceSkey, "tasks", SPACE_TYPE.tasks);
}

export function channelUri(authorityDid: string, skey: string): string {
  return spaceUri(authorityDid, SPACE_TYPE.channel, skey);
}

export function dmInboxUri(ownerDid: string): string {
  if (!isDid(ownerDid)) throw new TypeError("Invalid DM inbox owner DID.");
  return spaceUri(ownerDid, SPACE_TYPE.dmInbox, DM_INBOX_SKEY);
}

export function dmConversationUri(ownerDid: string, convKey: string): string {
  if (!isDid(ownerDid)) throw new TypeError("Invalid DM conversation owner DID.");
  if (!isTid(convKey)) throw new TypeError("Invalid DM conversation key.");
  return spaceUri(ownerDid, SPACE_TYPE.dmConversation, convKey);
}

export function parseDmInboxUri(uri: string): { ownerDid: string } | null {
  const parsed = parseSpaceUri(uri);
  if (parsed?.type !== SPACE_TYPE.dmInbox || parsed.skey !== DM_INBOX_SKEY) return null;
  return dmInboxUri(parsed.authorityDid) === uri ? { ownerDid: parsed.authorityDid } : null;
}

/** Accepts exactly the two DM space kinds (inbox or conversation half); everything else is rejected. */
export function parseDmSpaceUri(uri: string): { kind: "inbox"; ownerDid: string } | { kind: "conversation"; ownerDid: string; convKey: string } | null {
  const inbox = parseDmInboxUri(uri);
  if (inbox) return { kind: "inbox", ownerDid: inbox.ownerDid };
  const conversation = parseDmConversationUri(uri);
  if (conversation) return { kind: "conversation", ...conversation };
  return null;
}

export function parseDmConversationUri(uri: string): { ownerDid: string; convKey: string } | null {
  const parsed = parseSpaceUri(uri);
  if (parsed?.type !== SPACE_TYPE.dmConversation || !isTid(parsed.skey)) return null;
  return dmConversationUri(parsed.authorityDid, parsed.skey) === uri ? { ownerDid: parsed.authorityDid, convKey: parsed.skey } : null;
}

export function parseDmMessageUri(value: unknown): { ownerDid: string; convKey: string; repo: string; rkey: string } | null {
  if (typeof value !== "string") return null;
  const match = /^(at:space\/[^/\s]+\/[^/\s]+\/[^/\s]+)\/[^/\s]+\/[^/\s]+\/[^/\s]+$/.exec(value);
  const conversation = match ? parseDmConversationUri(match[1]!) : null;
  if (!match || !conversation) return null;
  const record = parseSpaceRecordUri(value, match[1]!, COLLECTION.dmMessage);
  if (!record || record.repo !== conversation.ownerDid || !isTid(record.rkey)) return null;
  return { ...conversation, ...record };
}

export function canonicalParticipants(dids: readonly string[]): string[] {
  const unique = [...new Set(dids)].sort();
  if (unique.length < 2 || unique.length > 100) {
    throw new RangeError("DM participants must contain 2 to 100 unique DIDs.");
  }
  if (!unique.every(isDid)) throw new TypeError("Invalid DM participant DID.");
  return unique;
}

const SPACE_URI_PATTERN = /^at:space\/(did:[^/\s]+)\/([A-Za-z0-9.-]+)\/([A-Za-z0-9._~:-]{1,512})$/;

export function parseSpaceUri(uri: string): { authorityDid: Did; type: string; skey: string } | null {
  const match = SPACE_URI_PATTERN.exec(uri);
  if (!match) return null;
  const [, authorityDid, type, skey] = match;
  return isDid(authorityDid) && isRecordKey(skey) ? { authorityDid, type, skey } : null;
}

/** The authority of any space URI. */
export function requireSpaceAuthority(space: string): Did {
  const parsed = parseSpaceUri(space);
  if (!parsed) throw new Error("Invalid permissioned space URI.");
  return parsed.authorityDid;
}

export function parseGroupMetaUri(uri: string): { groupDid: Did } | null {
  const parsed = parseSpaceUri(uri);
  return parsed?.type === ATGRP_SPACE_TYPE.meta && parsed.skey === SELF_SKEY
    ? { groupDid: parsed.authorityDid }
    : null;
}

export function parseGroupMembersUri(uri: string): { groupDid: Did } | null {
  const parsed = parseSpaceUri(uri);
  return parsed?.type === ATGRP_SPACE_TYPE.members && parsed.skey === SELF_SKEY
    ? { groupDid: parsed.authorityDid }
    : null;
}

export function parsePersonalInboxUri(uri: string): { userDid: Did } | null {
  const parsed = parseSpaceUri(uri);
  return parsed?.type === ATGRP_SPACE_TYPE.inbox && parsed.skey === SELF_SKEY
    ? { userDid: parsed.authorityDid }
    : null;
}

/** A workspace space URI's authority and skey (`self`), or null for any other URI. */
export function parseWorkspaceUri(uri: string): { authorityDid: Did; skey: string } | null {
  const parsed = parseSpaceUri(uri);
  return parsed?.type === SPACE_TYPE.workspace && parsed.skey === SELF_SKEY
    ? { authorityDid: parsed.authorityDid, skey: parsed.skey }
    : null;
}

/** An admin inbox space URI's authority and skey (`self`), or null for any other URI. */
export function parseInboxUri(uri: string): { authorityDid: Did; skey: string } | null {
  const parsed = parseSpaceUri(uri);
  return parsed?.type === SPACE_TYPE.inbox && parsed.skey === SELF_SKEY
    ? { authorityDid: parsed.authorityDid, skey: parsed.skey }
    : null;
}

/** A channel space URI's authority and skey, or null for any other URI. */
export function parseChannelUri(uri: string): { authorityDid: Did; skey: string } | null {
  const parsed = parseSpaceUri(uri);
  return parsed?.type === SPACE_TYPE.channel && isSkey(parsed.skey)
    ? { authorityDid: parsed.authorityDid, skey: parsed.skey }
    : null;
}

/** An app inbox space URI's authority and skey, or null for any other URI. */
export function parseAppInboxUri(uri: string): { authorityDid: Did; skey: string } | null {
  const parsed = parseSpaceUri(uri);
  return parsed?.type === SPACE_TYPE.appInbox && isSkey(parsed.skey)
    ? { authorityDid: parsed.authorityDid, skey: parsed.skey }
    : null;
}

/** An extension space URI's authority, space type, and skey (optionally filtered to `spaceType`), or null for any other URI. */
export function parseExtSpaceUri(uri: string, spaceType?: string): { authorityDid: Did; type: string; skey: string } | null {
  const parsed = parseSpaceUri(uri);
  if (!parsed || !isSkey(parsed.skey)) return null;
  const extPrefix = `${NAMESPACE}.ext.`;
  if (!parsed.type.startsWith(extPrefix) || parsed.type.length <= extPrefix.length) return null;
  if (spaceType !== undefined && parsed.type !== spaceType) return null;
  return parsed;
}

/** A Tasks extension space URI's authority and skey, or null for any other URI. */
export function parseTasksSpaceUri(uri: string): { authorityDid: Did; skey: string } | null {
  const parsed = parseSpaceUri(uri);
  return parsed?.type === SPACE_TYPE.tasks && isSkey(parsed.skey)
    ? { authorityDid: parsed.authorityDid, skey: parsed.skey }
    : null;
}

export function spaceRecordUri(spaceUriValue: string, repoDid: string, collection: string, rkey: string): string {
  if (!parseSpaceUri(spaceUriValue) || !isDid(repoDid) || !/^[A-Za-z0-9.-]+$/.test(collection) || !isRecordKey(rkey)) {
    throw new TypeError("Invalid space record URI components.");
  }
  return `${spaceUriValue}/${repoDid}/${collection}/${rkey}`;
}

export function parseSpaceRecordUri(
  uri: string,
  spaceUriValue: string,
  collection: string,
): { repo: string; rkey: string } | null {
  const prefix = `${spaceUriValue}/`;
  if (!uri.startsWith(prefix)) return null;
  const parts = uri.slice(prefix.length).split("/");
  if (parts.length !== 3 || parts[1] !== collection || !isDid(parts[0]) || !isRecordKey(parts[2])) return null;
  try {
    return spaceRecordUri(spaceUriValue, parts[0], collection, parts[2]) === uri
      ? { repo: parts[0], rkey: parts[2] }
      : null;
  } catch {
    return null;
  }
}

export function parseAnySpaceRecordUri(
  uri: unknown,
): { spaceUri: string; authorityDid: Did; spaceType: string; skey: string; repoDid: Did; collection: string; rkey: string } | null {
  if (typeof uri !== "string") return null;
  const match = /^(at:space\/[^/\s]+\/[^/\s]+\/[^/\s]+)\/([^/\s]+)\/([A-Za-z0-9.-]+)\/([^/\s]+)$/.exec(uri);
  if (!match) return null;
  const [, rawSpaceUri, rawRepoDid, collection, rkey] = match;
  const parsedSpace = parseSpaceUri(rawSpaceUri);
  if (!parsedSpace || !isDid(rawRepoDid) || !isRecordKey(rkey)) return null;
  return {
    spaceUri: rawSpaceUri,
    authorityDid: parsedSpace.authorityDid,
    spaceType: parsedSpace.type,
    skey: parsedSpace.skey,
    repoDid: rawRepoDid,
    collection,
    rkey,
  };
}

export function tidNow(nowMs = Date.now(), clockId = randomClockId()): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || clockId < 0 || clockId > 1023) {
    throw new RangeError("Invalid TID timestamp or clock identifier.");
  }
  let value = ((BigInt(nowMs) * 1000n) << 10n) | BigInt(clockId);
  // Clear top bit so generated TIDs always start with [234567abcdefghij]
  value &= 0x7fffffffffffffffn;
  let encoded = "";
  for (let index = 0; index < 13; index += 1) {
    encoded = TID_BASE32[Number(value & 31n)] + encoded;
    value >>= 5n;
  }
  return encoded;
}

/** Decodes the 53-bit microsecond timestamp from a canonical 13-character ATProto TID. */
export function tidTimestampUs(tid: string): bigint {
  if (!isTid(tid)) {
    throw new TypeError("Invalid TID.");
  }
  let value = 0n;
  for (let index = 0; index < tid.length; index += 1) {
    value = (value << 5n) | BigInt(TID_BASE32.indexOf(tid[index]!));
  }
  return value >> 10n;
}

export function canonicalJson(value: unknown): string {
  return canonicalValue(value);
}

export function requestDigest(value: unknown): string {
  return bytesToHex(sha256(utf8ToBytes(canonicalJson(value))));
}

function joinParts(...parts: string[]): string {
  return parts.join("\u0000");
}

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let accumulator = 0;
  let output = "";
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32[(accumulator >>> bits) & 31];
    }
  }
  if (bits > 0) output += BASE32[(accumulator << (5 - bits)) & 31];
  return output;
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON cannot encode non-finite numbers.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError("Canonical JSON cannot encode non-finite or non-plain objects: plain objects only.");
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => {
      if (record[key] === undefined) throw new TypeError("Canonical JSON cannot encode undefined values.");
      return `${JSON.stringify(key)}:${canonicalValue(record[key])}`;
    }).join(",")}}`;
  }
  throw new TypeError(`Canonical JSON cannot encode ${typeof value}.`);
}

function randomClockId(): number {
  return randomUint(1024);
}

function randomUint(exclusiveMax: number): number {
  const limit = Math.floor(0x100000000 / exclusiveMax) * exclusiveMax;
  let value: number;
  do {
    value = crypto.getRandomValues(new Uint32Array(1))[0];
  } while (value >= limit);
  return value % exclusiveMax;
}
