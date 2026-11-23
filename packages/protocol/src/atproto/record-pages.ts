import { fromBase64 } from "@atproto/lex-data";
import type * as MemberspaceDefs from "../lexicons/api/types/com/atproto/memberspace/defs";
import type * as ListMembers from "../lexicons/api/types/com/atproto/memberspace/listMembers";
import type * as ListRecords from "../lexicons/api/types/com/atproto/space/listRecords";
import type * as ListSpaces from "../lexicons/api/types/com/atproto/space/listSpaces";
import type * as ListWriters from "../lexicons/api/types/com/atproto/space/listWriters";
import { isDid, parseSpaceUri, spaceRecordUri } from "../keys";
import { validateSpaceTypeKey } from "../registry";
import { isInvalidCursorError, type AtprotoClient } from "./xrpc";

function isValidSpaceEntryUri(uri: string): boolean {
  const parsed = parseSpaceUri(uri);
  return parsed !== null && validateSpaceTypeKey(parsed.type, parsed.skey).valid;
}

const MAX_SCAN_PAGES = 128;
const MAX_REPO_SCAN_PAGES = 512;
const MAX_SPACE_PAGE = 100; // com.atproto.space.listSpaces caps `limit` at 100; the app caps listWriters/listMembers/listRecords pages at 500 itself.
const MAX_REPO_OPS_PAGES = 128;
const MAX_REPO_OPS_PAGE_LIMIT = 500;
const MAX_REPO_OPS_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MAX_REPO_OP_CURSOR_LENGTH = 1_024;
const MAX_REPO_OP_REV_LENGTH = 64;
const MAX_REPO_OP_COLLECTION_LENGTH = 317;
const MAX_REPO_OP_RKEY_LENGTH = 512;
const MAX_REPO_OP_CID_LENGTH = 256;

const NSID_PATTERN = /^[a-zA-Z](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?:\.[a-zA-Z](?:[a-zA-Z0-9]{0,62})?)$/;
const RKEY_PATTERN = /^[A-Za-z0-9._~:-]{1,512}$/;
const TID_BASE32 = "234567abcdefghijklmnopqrstuvwxyz";
const MIN_PLAUSIBLE_TID_EPOCH_MS = 1_577_836_800_000; // 2020-01-01T00:00:00.000Z
export const WRITER_CURSOR_MAX_AGE_MS = 72 * 60 * 60 * 1000;

export const WRITER_WRITE_TYPE = "com.atproto.space.defs#repoWrite" as const;
export const WRITER_REMOVED_TYPE = "com.atproto.space.defs#repoRemoved" as const;
const utf8Encoder = new TextEncoder();

export type BoundedRecord = {
  collection: string;
  rkey: string;
  cid: string;
  value: Record<string, unknown>;
};

export type BoundedRecordHeader = {
  collection: string;
  rkey: string;
  cid: string;
  value?: undefined;
};

export type BoundedRecords<T = BoundedRecord> = {
  records: T[];
  truncated: boolean;
};

export type BoundedMembers = {
  members: MemberspaceDefs.Member[];
  truncated: boolean;
};

export type WriterWrite = {
  kind: "write";
  repo: string;
  repoRev: string;
  spaceRev: string;
  data: unknown;
};

export type WriterRemoved = {
  kind: "removed";
  repo: string;
  spaceRev: string;
};

export type WriterUpdate = WriterWrite | WriterRemoved;

export type BoundedWriters = {
  writers: WriterWrite[];
  spaceRev: string | null;
  truncated: boolean;
};

export type WritersSince = {
  updates: WriterUpdate[];
  spaceRev: string | null;
  fullReconcile: boolean;
  writers?: WriterWrite[];
};

export type BoundedSpaces = {
  spaces: ListSpaces.SpaceView[];
  truncated: boolean;
};

export type StagedRepoOp = {
  rev: string;
  collection: string;
  rkey: string;
  cid: string | null;
  prev: string | null;
  value?: unknown;
};

export type VerifiedPageCommit = {
  ver: number;
  repo: string;
  space: string;
  rev: string;
  data: Uint8Array;
};

export type RepoOpsPagesResult = {
  ops: StagedRepoOp[];
  commit: VerifiedPageCommit;
};

export class RepoOpsPageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoOpsPageError";
  }
}

function isNsid(value: unknown): value is string {
  return typeof value === "string" && value.length >= 5 && value.length <= 317 && NSID_PATTERN.test(value);
}

function isRecordKey(value: unknown): value is string {
  return typeof value === "string" && value !== "." && value !== ".." && RKEY_PATTERN.test(value);
}

function isPlainRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isConsistentRecordUri(uri: unknown, collection: string, rkey: string, space?: string, repo?: string): boolean {
  if (typeof uri !== "string") return false;
  if (space !== undefined && repo !== undefined && parseSpaceUri(space) && isDid(repo)) {
    try {
      return uri === spaceRecordUri(space, repo, collection, rkey);
    } catch {
      return false;
    }
  }
  const spaceIdx = uri.indexOf("/space/");
  if (spaceIdx <= 0) return false;
  const parts = uri.slice(spaceIdx + "/space/".length).split("/");
  if (parts.length !== 5) return false;
  const [spaceType, skey, uriRepo, uriCollection, uriRkey] = parts;
  if (!spaceType || !skey || !uriRepo || uriCollection !== collection || uriRkey !== rkey) return false;
  try {
    const baseSpace = `${uri.slice(0, spaceIdx)}/space/${spaceType}/${skey}`;
    return spaceRecordUri(baseSpace, uriRepo, uriCollection, uriRkey) === uri;
  } catch {
    return false;
  }
}

export function assertBoundedRecordPage(
  page: unknown,
  input: {
    collection?: string;
    excludeValues?: boolean;
    limit: number;
    cursor?: string;
    seenCursors?: ReadonlySet<string>;
    space?: string;
    repo?: string;
  },
): asserts page is ListRecords.OutputSchema {
  if (input.collection !== undefined && input.collection.length === 0) {
    throw new RangeError("Record page collection must not be empty.");
  }
  if (!Number.isSafeInteger(input.limit) || input.limit < 1) throw new RangeError("Record page limit must be a positive safe integer.");
  if (!isPlainRecordObject(page)) throw new Error("PDS record page is malformed.");
  const candidate = page as { records?: unknown; cursor?: unknown };
  if (!Array.isArray(candidate.records) || candidate.records.length > input.limit) throw new Error("PDS record page exceeded the requested limit.");
  const keys = new Set<string>();
  for (const raw of candidate.records) {
    if (!isPlainRecordObject(raw)) throw new Error("PDS record page contains a malformed record or unexpected collection.");
    const record = raw as { collection?: unknown; rkey?: unknown; cid?: unknown; uri?: unknown; value?: unknown };
    if (!isRecordKey(record.rkey) || !isNsid(record.collection)) {
      throw new Error("PDS record page contains a malformed record or unexpected collection.");
    }
    if (input.collection !== undefined && record.collection !== input.collection) {
      throw new Error("PDS record page contains a malformed record or unexpected collection.");
    }
    if (record.cid !== undefined && (typeof record.cid !== "string" || record.cid.length === 0)) {
      throw new Error("PDS record page contains a malformed record or unexpected collection.");
    }
    if (input.excludeValues === true && (typeof record.cid !== "string" || record.cid.length === 0)) {
      throw new Error("PDS record page contains a malformed record or unexpected collection.");
    }
    if (record.uri !== undefined && !isConsistentRecordUri(record.uri, record.collection, record.rkey, input.space, input.repo)) {
      throw new Error("PDS record page contains a malformed record or unexpected collection.");
    }
    if (input.excludeValues === true) {
      if (record.value !== undefined && !isPlainRecordObject(record.value)) {
        throw new Error("PDS record page contains a malformed record or unexpected collection.");
      }
    } else if (!isPlainRecordObject(record.value)) {
      throw new Error("PDS record page contains a malformed record or unexpected collection.");
    }
    const key = `${record.collection}/${record.rkey}`;
    if (keys.has(key)) throw new Error("PDS record page contains duplicate record keys.");
    keys.add(key);
  }
  if (candidate.cursor !== undefined && (typeof candidate.cursor !== "string" || candidate.cursor.length === 0)) {
    throw new Error("PDS record pagination returned an invalid cursor.");
  }
  if (candidate.cursor && (candidate.cursor === input.cursor || input.seenCursors?.has(candidate.cursor))) {
    throw new Error("PDS record pagination did not advance.");
  }
  if (candidate.records.length === 0 && candidate.cursor) throw new Error("PDS record pagination returned an empty nonterminal page.");
}

/** Milliseconds since the UNIX epoch encoded by a 13-character ATProto TID, or `null` if not a valid TID. */
export function tidTimestampMs(tid: string): number | null {
  if (typeof tid !== "string" || tid.length !== 13) return null;
  let value = 0n;
  for (let i = 0; i < 13; i += 1) {
    const index = TID_BASE32.indexOf(tid[i]!);
    if (index < 0) return null;
    value = (value << 5n) | BigInt(index);
  }
  return Number((value >> 10n) / 1000n);
}

function assertWriterPage(
  page: unknown,
  limit: number,
  requested: string | undefined,
  seenCursors: ReadonlySet<string>,
): { updates: WriterUpdate[]; cursor?: string } {
  if (typeof page !== "object" || page === null || Array.isArray(page)) {
    throw new Error("PDS writer page is malformed.");
  }
  const candidate = page as { repos?: unknown; cursor?: unknown };
  if (!Array.isArray(candidate.repos) || candidate.repos.length > limit) {
    throw new Error("PDS writer page exceeded the requested limit.");
  }
  const updates: WriterUpdate[] = [];
  for (const raw of candidate.repos) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error("PDS writer page contains a malformed writer entry.");
    }
    const entry = raw as { $type?: unknown; repo?: unknown; repoRev?: unknown; spaceRev?: unknown; data?: unknown };
    if (!isDid(entry.repo)) throw new Error("PDS writer page contains a malformed repo DID.");
    if (typeof entry.spaceRev !== "string" || entry.spaceRev.length === 0) {
      throw new Error("PDS writer page contains a writer without spaceRev.");
    }
    if (entry.$type === WRITER_WRITE_TYPE) {
      if (typeof entry.repoRev !== "string" || entry.repoRev.length === 0) {
        throw new Error("PDS writer page contains a repoWrite without repoRev.");
      }
      updates.push({ kind: "write", repo: entry.repo, repoRev: entry.repoRev, spaceRev: entry.spaceRev, data: entry.data });
    } else if (entry.$type === WRITER_REMOVED_TYPE) {
      updates.push({ kind: "removed", repo: entry.repo, spaceRev: entry.spaceRev });
    } else {
      throw new Error("PDS writer page contains an unknown writer entry type.");
    }
  }
  for (let i = 1; i < updates.length; i += 1) {
    if (updates[i - 1]!.spaceRev > updates[i]!.spaceRev) {
      throw new Error("PDS writer page is not in ascending spaceRev order.");
    }
  }
  if (candidate.cursor !== undefined && (typeof candidate.cursor !== "string" || candidate.cursor.length === 0)) {
    throw new Error("PDS writer pagination returned an invalid cursor.");
  }
  if (candidate.cursor) {
    if (candidate.cursor === requested || seenCursors.has(candidate.cursor)) {
      throw new Error("PDS writer pagination did not advance.");
    }
    if (updates.length === 0) {
      throw new Error("PDS writer pagination returned an empty nonterminal page.");
    }
  }
  return { updates, ...(candidate.cursor ? { cursor: candidate.cursor } : {}) };
}

const WRITER_PAGE_LIMIT = 100;
const MIN_WRITER_RAW_ENTRIES = 2_000;
const WRITER_RAW_ENTRY_MULTIPLIER = 20;

/**
 * Pages `com.atproto.space.listWriters` across the space's writer set. Entries are ordered ascending by `spaceRev`, so a
 * writer updated or removed while paging reappears at a later `spaceRev`. Latest entry wins per `repo`: a `#repoRemoved`
 * entry deletes the repo from the active writer set, so an earlier provisional overflow `#repoWrite` followed by a later
 * `#repoRemoved` resolves without truncation when the terminal active set fits within `maxRepos`. Stops immediately when
 * `page.repos.length < limit` because `listWriters` emits `cursor` on every non-empty page, and enforces a raw-entry
 * safety ceiling (`maxRawEntries`) against unbounded churn streams.
 */
export async function listBoundedWriters(
  client: AtprotoClient,
  input: { space: string; maxRepos: number; maxRawEntries?: number },
): Promise<BoundedWriters> {
  if (!Number.isSafeInteger(input.maxRepos) || input.maxRepos < 1) {
    throw new RangeError("Writer scan limit must be a positive safe integer.");
  }
  if (input.maxRawEntries !== undefined && (!Number.isSafeInteger(input.maxRawEntries) || input.maxRawEntries < 1)) {
    throw new RangeError("Writer raw entry limit must be a positive safe integer.");
  }
  const limit = Math.min(WRITER_PAGE_LIMIT, input.maxRepos);
  const maxRawEntries = input.maxRawEntries ?? Math.max(MIN_WRITER_RAW_ENTRIES, input.maxRepos * WRITER_RAW_ENTRY_MULTIPLIER);
  const maxPages = Math.max(
    MAX_REPO_SCAN_PAGES,
    Math.ceil((input.maxRepos * WRITER_RAW_ENTRY_MULTIPLIER) / WRITER_PAGE_LIMIT) + 1,
  );
  const active = new Map<string, WriterWrite>();
  const seenCursors = new Set<string>();
  let rawEntries = 0;
  let spaceRev: string | null = null;
  let cursor: string | undefined;
  for (let pages = 0; ; pages += 1) {
    if (pages >= maxPages) throw new Error("PDS writer pagination exceeded the bounded page limit.");
    const requested = cursor;
    const page = await client.query<ListWriters.OutputSchema>("com.atproto.space.listWriters", {
      space: input.space,
      limit,
      ...(cursor ? { cursor } : {}),
    });
    const parsed = assertWriterPage(page, limit, requested, seenCursors);
    rawEntries += parsed.updates.length;
    for (const entry of parsed.updates) {
      if (entry.kind === "removed") {
        active.delete(entry.repo);
      } else {
        active.set(entry.repo, entry);
      }
      if (spaceRev === null || entry.spaceRev > spaceRev) {
        spaceRev = entry.spaceRev;
      }
    }
    if (!parsed.cursor || parsed.updates.length < limit) break;
    if (rawEntries >= maxRawEntries) {
      return {
        writers: [...active.values()].slice(0, input.maxRepos),
        spaceRev,
        truncated: true,
      };
    }
    seenCursors.add(parsed.cursor);
    cursor = parsed.cursor;
  }
  const allActive = [...active.values()];
  const truncated = allActive.length > input.maxRepos;
  return {
    writers: truncated ? allActive.slice(0, input.maxRepos) : allActive,
    spaceRev,
    truncated,
  };
}

function isWriterCursorStale(input: {
  since: string | null;
  sinceListedAt?: number | null;
  now?: number;
  maxCursorAgeMs?: number;
}): boolean {
  if (input.since === null) return false;
  const maxAge = input.maxCursorAgeMs ?? WRITER_CURSOR_MAX_AGE_MS;
  if (input.sinceListedAt !== undefined && input.sinceListedAt !== null) {
    const now = input.now ?? Date.now();
    const age = now - input.sinceListedAt;
    return age < 0 || age >= maxAge;
  }
  if (input.now !== undefined) {
    const tidMs = tidTimestampMs(input.since);
    if (tidMs === null) return true;
    if (tidMs >= MIN_PLAUSIBLE_TID_EPOCH_MS) {
      const age = input.now - tidMs;
      return age < 0 || age >= maxAge;
    }
  }
  return false;
}

/**
 * Reads `com.atproto.space.listWriters` updates since a `spaceRev` cursor, returning deduplicated latest-wins
 * `#repoWrite` and `#repoRemoved` updates. A page shorter than `limit` ends the scan. When the checkpoint is older than
 * 72 hours, the host rejects it with `InvalidCursor`, or incremental churn/tombstones exceed `maxRepos` or raw entry/page
 * bounds, falls back cleanly to full `listBoundedWriters` reconciliation so GC'd or interleaved writer removals are
 * resolved without false errors.
 */
export async function listWritersSince(
  client: AtprotoClient,
  input: {
    space: string;
    since: string | null;
    maxRepos: number;
    maxRawEntries?: number;
    sinceListedAt?: number | null;
    now?: number;
    maxCursorAgeMs?: number;
  },
): Promise<WritersSince> {
  if (!Number.isSafeInteger(input.maxRepos) || input.maxRepos < 1) {
    throw new RangeError("Writer scan limit must be a positive safe integer.");
  }
  const fullReconciliation = async (): Promise<WritersSince> => {
    const scan = await listBoundedWriters(client, {
      space: input.space,
      maxRepos: input.maxRepos,
      ...(input.maxRawEntries !== undefined ? { maxRawEntries: input.maxRawEntries } : {}),
    });
    if (scan.truncated) throw new Error(`The space's changed writers exceed the ${input.maxRepos}-repo scan limit.`);
    return { updates: scan.writers, spaceRev: scan.spaceRev, fullReconcile: true, writers: scan.writers };
  };

  if (isWriterCursorStale(input)) return fullReconciliation();

  const limit = WRITER_PAGE_LIMIT;
  const maxRawEntries = input.maxRawEntries ?? Math.max(MIN_WRITER_RAW_ENTRIES, input.maxRepos * WRITER_RAW_ENTRY_MULTIPLIER);
  const updates = new Map<string, WriterUpdate>();
  const seenCursors = new Set<string>();
  let rawEntries = 0;
  let cursor = input.since ?? undefined;
  let spaceRev = input.since;
  for (let pages = 0; ; pages += 1) {
    if (pages >= MAX_REPO_SCAN_PAGES) return fullReconciliation();
    const requested = cursor;
    let page: ListWriters.OutputSchema;
    try {
      page = await client.query<ListWriters.OutputSchema>("com.atproto.space.listWriters", {
        space: input.space,
        limit,
        ...(cursor ? { cursor } : {}),
      });
    } catch (error) {
      if (input.since !== null && isInvalidCursorError(error)) return fullReconciliation();
      throw error;
    }
    const rawPage = page as { repos?: unknown; cursor?: unknown };
    if (Array.isArray(rawPage?.repos) && rawPage.repos.length === 0 && rawPage.cursor !== undefined && rawPage.cursor === requested) {
      return { updates: [...updates.values()], spaceRev, fullReconcile: false };
    }
    const parsed = assertWriterPage(page, limit, requested, seenCursors);
    rawEntries += parsed.updates.length;
    for (const entry of parsed.updates) {
      updates.set(entry.repo, entry);
      if (spaceRev === null || entry.spaceRev > spaceRev) spaceRev = entry.spaceRev;
    }
    if (updates.size > input.maxRepos) {
      return fullReconciliation();
    }
    if (!parsed.cursor || parsed.updates.length < limit) {
      return { updates: [...updates.values()], spaceRev, fullReconcile: false };
    }
    if (rawEntries >= maxRawEntries) {
      return fullReconciliation();
    }
    seenCursors.add(parsed.cursor);
    cursor = parsed.cursor;
  }
}

/**
 * Fetches paginated `com.atproto.space.listRepoOps` responses, verifying that every page carries a valid `commit`
 * matching `(space, repo)` and stripping unknown properties from staged op entries while preserving `XrpcError`
 * (including `RepoNotFound` for unwritten repos).
 */
export async function fetchRepoOpsPages(
  client: AtprotoClient,
  input: {
    space: string;
    repo: string;
    since?: string;
    excludeValues?: boolean;
    limit?: number;
    maxPages?: number;
    maxOps?: number;
    maxPayloadBytes?: number;
    signal?: AbortSignal;
  },
): Promise<RepoOpsPagesResult> {
  const limit = input.limit ?? MAX_REPO_OPS_PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("listRepoOps limit must be a positive safe integer.");
  const maxPages = input.maxPages ?? MAX_REPO_OPS_PAGES;
  const maxPayloadBytes = input.maxPayloadBytes ?? MAX_REPO_OPS_PAYLOAD_BYTES;
  const excludeValues = input.excludeValues ?? false;

  const ops: StagedRepoOp[] = [];
  const seenCursors = new Set<string>();
  let stagedBytes = 0;
  let cursor: string | undefined;

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    if (input.signal?.aborted) throw input.signal.reason ?? new Error("Aborted.");
    const page = await client.query<{ ops?: unknown; cursor?: unknown; commit?: unknown }>("com.atproto.space.listRepoOps", {
      space: input.space,
      repo: input.repo,
      ...(input.since !== undefined && cursor === undefined ? { since: input.since } : {}),
      limit,
      ...(excludeValues ? { excludeValues: true } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
    });
    if (!page || typeof page !== "object" || Array.isArray(page) || !Array.isArray(page.ops) || page.ops.length > limit) {
      throw new RepoOpsPageError("Malformed listRepoOps page.");
    }
    if (
      page.cursor !== undefined &&
      (typeof page.cursor !== "string" || page.cursor.length === 0 || page.cursor.length > MAX_REPO_OP_CURSOR_LENGTH)
    ) {
      throw new RepoOpsPageError("Malformed or oversized listRepoOps cursor.");
    }
    const commit = decodePageCommit(page.commit, input.space, input.repo);
    if (!commit) {
      throw new RepoOpsPageError("Missing or malformed commit on listRepoOps page.");
    }
    if (input.maxOps !== undefined && ops.length + page.ops.length > input.maxOps) {
      throw new RepoOpsPageError("listRepoOps exceeded cumulative op staging bound.");
    }
    if (typeof page.cursor === "string") {
      stagedBytes += utf8Encoder.encode(page.cursor).byteLength;
      if (stagedBytes > maxPayloadBytes) {
        throw new RepoOpsPageError("listRepoOps exceeded cumulative payload byte staging bound.");
      }
    }
    for (const rawOp of page.ops as unknown[]) {
      const staged = validateAndProjectRepoOp(rawOp, excludeValues);
      if (!staged) throw new RepoOpsPageError("Malformed or oversized op entry in listRepoOps.");
      stagedBytes +=
        utf8Encoder.encode(staged.rev).byteLength +
        utf8Encoder.encode(staged.collection).byteLength +
        utf8Encoder.encode(staged.rkey).byteLength +
        (staged.cid !== null ? utf8Encoder.encode(staged.cid).byteLength : 0) +
        (staged.prev !== null ? utf8Encoder.encode(staged.prev).byteLength : 0);
      if (!excludeValues && staged.value !== undefined && staged.value !== null) {
        stagedBytes += utf8Encoder.encode(JSON.stringify(staged.value)).byteLength;
      }
      if (stagedBytes > maxPayloadBytes) {
        throw new RepoOpsPageError("listRepoOps exceeded cumulative payload byte staging bound.");
      }
      ops.push(staged);
    }
    if (page.cursor === undefined) {
      return { ops, commit };
    }
    if (page.ops.length === 0) {
      throw new RepoOpsPageError("listRepoOps returned an empty nonterminal page.");
    }
    if (page.cursor === cursor || seenCursors.has(page.cursor)) {
      throw new RepoOpsPageError("listRepoOps cursor did not advance.");
    }
    seenCursors.add(page.cursor);
    cursor = page.cursor;
  }
  throw new RepoOpsPageError("listRepoOps exceeded maxRepoOpsPages.");
}

function validateAndProjectRepoOp(raw: unknown, excludeValues: boolean): StagedRepoOp | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const op = raw as { rev?: unknown; collection?: unknown; rkey?: unknown; cid?: unknown; prev?: unknown; value?: unknown };
  if (typeof op.rev !== "string" || op.rev.length === 0 || op.rev.length > MAX_REPO_OP_REV_LENGTH) return null;
  if (typeof op.collection !== "string" || op.collection.length === 0 || op.collection.length > MAX_REPO_OP_COLLECTION_LENGTH) return null;
  if (typeof op.rkey !== "string" || op.rkey.length === 0 || op.rkey.length > MAX_REPO_OP_RKEY_LENGTH) return null;
  if (op.cid !== null && (typeof op.cid !== "string" || op.cid.length === 0 || op.cid.length > MAX_REPO_OP_CID_LENGTH)) return null;
  if (op.prev !== null && (typeof op.prev !== "string" || op.prev.length === 0 || op.prev.length > MAX_REPO_OP_CID_LENGTH)) return null;
  return {
    rev: op.rev,
    collection: op.collection,
    rkey: op.rkey,
    cid: op.cid,
    prev: op.prev,
    ...(!excludeValues && op.value !== undefined ? { value: op.value } : {}),
  };
}

function decodePageCommit(raw: unknown, expectedSpace: string, expectedRepo: string): VerifiedPageCommit | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const commit = raw as { ver?: unknown; repo?: unknown; space?: unknown; rev?: unknown; data?: unknown };
  if (commit.ver !== 1 || commit.repo !== expectedRepo || commit.space !== expectedSpace || typeof commit.rev !== "string" || commit.rev.length === 0) {
    return null;
  }
  let data: Uint8Array;
  if (commit.data instanceof Uint8Array) {
    data = commit.data;
  } else if (typeof commit.data === "object" && commit.data !== null && typeof (commit.data as { $bytes?: unknown }).$bytes === "string") {
    try {
      data = fromBase64((commit.data as { $bytes: string }).$bytes);
    } catch {
      return null;
    }
  } else {
    return null;
  }
  return { ver: commit.ver, repo: commit.repo, space: commit.space, rev: commit.rev, data };
}

function assertSpacePage(page: unknown, limit: number): asserts page is ListSpaces.OutputSchema {
  if (typeof page !== "object" || page === null) throw new Error("PDS space page is malformed.");
  const candidate = page as { spaces?: unknown; cursor?: unknown };
  if (!Array.isArray(candidate.spaces) || candidate.spaces.length > limit) throw new Error("PDS space page exceeded the requested limit.");
  if (candidate.spaces.some((space) => typeof space !== "object" || space === null || Array.isArray(space) || typeof space.space !== "string")) {
    throw new Error("PDS space page contains a malformed space.");
  }
  if (candidate.cursor !== undefined && (typeof candidate.cursor !== "string" || candidate.cursor.length === 0)) {
    throw new Error("PDS space pagination returned an invalid cursor.");
  }
  if (candidate.spaces.length === 0 && candidate.cursor) throw new Error("PDS space pagination returned an empty nonterminal page.");
}

export async function listBoundedSpaces(
  client: AtprotoClient,
  input: { spaceType?: string; spaceDid?: string; maxSpaces: number },
): Promise<BoundedSpaces> {
  if (!Number.isSafeInteger(input.maxSpaces) || input.maxSpaces < 1) throw new RangeError("Space scan limit must be a positive safe integer.");
  const spaces: ListSpaces.SpaceView[] = [];
  const seenCursors = new Set<string>();
  const seenSpaces = new Set<string>();
  let pages = 0;
  let cursor: string | undefined;
  do {
    const requestedCursor = cursor;
    const limit = Math.min(MAX_SPACE_PAGE, input.maxSpaces - spaces.length);
    if (++pages > MAX_SCAN_PAGES) throw new Error("PDS space pagination exceeded the bounded page limit.");
    const page = await client.query<ListSpaces.OutputSchema>("com.atproto.space.listSpaces", {
      spaceType: input.spaceType, spaceDid: input.spaceDid, limit, cursor,
    });
    assertSpacePage(page, limit);
    for (const entry of page.spaces) {
      if (seenSpaces.has(entry.space)) throw new Error("PDS space pagination returned a duplicate space URI.");
      seenSpaces.add(entry.space);
    }
    // A space whose URI this app cannot parse (for example a record key longer than it creates) is not one of its spaces. It is
    // skipped, not a reason to fail the listing: a space the account wrote into elsewhere could otherwise break discovery for good.
    spaces.push(...page.spaces.filter((entry) => isValidSpaceEntryUri(entry.space)));
    cursor = page.cursor;
    if (cursor) {
      if (cursor === requestedCursor || seenCursors.has(cursor)) throw new Error("PDS space pagination did not advance.");
      if (page.spaces.length === 0) throw new Error("PDS space pagination returned an empty nonterminal page.");
      seenCursors.add(cursor);
    }
  } while (cursor && spaces.length < input.maxSpaces);

  // One entry past the limit decides whether the list was cut short. An entry this app cannot parse is not one of its spaces, so it
  // does not count as more; keep looking past it, within the same page bound.
  let truncated = false;
  let probe = cursor;
  while (probe && !truncated) {
    if (++pages > MAX_SCAN_PAGES) throw new Error("PDS space pagination exceeded the bounded page limit.");
    const lookahead = await client.query<ListSpaces.OutputSchema>("com.atproto.space.listSpaces", {
      spaceType: input.spaceType, spaceDid: input.spaceDid, limit: 1, cursor: probe,
    });
    assertSpacePage(lookahead, 1);
    if (lookahead.spaces.some((entry) => seenSpaces.has(entry.space))) throw new Error("PDS space pagination returned a duplicate space URI.");
    if (lookahead.cursor && (lookahead.cursor === probe || seenCursors.has(lookahead.cursor))) throw new Error("PDS space pagination did not advance.");
    if (lookahead.spaces.length === 0 && lookahead.cursor) throw new Error("PDS space pagination returned an empty nonterminal page.");
    truncated = lookahead.spaces.some((entry) => isValidSpaceEntryUri(entry.space));
    if (lookahead.cursor) seenCursors.add(lookahead.cursor);
    probe = lookahead.cursor;
  }
  return { spaces, truncated };
}

/** Every space URI of a type, or an error when there are more than `maxSpaces`: discovery must not silently hide some of an account's spaces. */
export async function listAllSpaceUris(client: AtprotoClient, input: { spaceType?: string; maxSpaces: number }): Promise<string[]> {
  const scan = await listBoundedSpaces(client, input);
  if (scan.truncated) throw new Error(`Account ${input.spaceType ?? "spaces"} list exceeds the ${input.maxSpaces}-space discovery limit.`);
  return scan.spaces.map(({ space }) => space);
}

function assertMemberPage(page: unknown, limit: number): asserts page is ListMembers.OutputSchema {
  if (typeof page !== "object" || page === null) throw new Error("PDS member page is malformed.");
  const candidate = page as { members?: unknown; cursor?: unknown };
  if (!Array.isArray(candidate.members) || candidate.members.length > limit) throw new Error("PDS member page exceeded the requested limit.");
  if (candidate.members.some((member) => typeof member !== "object" || member === null || Array.isArray(member) ||
    !isDid(member.did) ||
    typeof member.read !== "boolean" || typeof member.write !== "boolean" ||
    (member.$type !== undefined && member.$type !== "com.atproto.memberspace.defs#member"))) {
    throw new Error("PDS member page contains a malformed member.");
  }
  if (candidate.cursor !== undefined && (typeof candidate.cursor !== "string" || candidate.cursor.length === 0)) {
    throw new Error("PDS member pagination returned an invalid cursor.");
  }
  if (candidate.members.length === 0 && candidate.cursor) throw new Error("PDS member pagination returned an empty nonterminal page.");
}

export async function listBoundedMembers(
  client: AtprotoClient,
  input: { space: string; maxMembers: number },
): Promise<BoundedMembers> {
  if (!Number.isSafeInteger(input.maxMembers) || input.maxMembers < 1) throw new RangeError("Member scan limit must be a positive safe integer.");
  const members: MemberspaceDefs.Member[] = [];
  const seenDids = new Set<string>();
  const seenCursors = new Set<string>();
  let pages = 0;
  let cursor: string | undefined;
  do {
    const requestedCursor = cursor;
    const limit = Math.min(500, input.maxMembers - members.length);
    if (++pages > MAX_SCAN_PAGES) throw new Error("PDS member pagination exceeded the bounded page limit.");
    const page = await client.query<ListMembers.OutputSchema>("com.atproto.memberspace.listMembers", {
      space: input.space,
      limit,
      cursor,
    });
    assertMemberPage(page, limit);
    for (const member of page.members) {
      if (seenDids.has(member.did)) throw new Error("PDS member pagination returned a duplicate member DID.");
      seenDids.add(member.did);
    }
    members.push(...page.members);
    cursor = page.cursor;
    if (cursor) {
      if (cursor === requestedCursor || seenCursors.has(cursor)) throw new Error("PDS member pagination did not advance.");
      seenCursors.add(cursor);
    }
  } while (cursor && members.length < input.maxMembers);

  let truncated = false;
  if (cursor) {
    if (++pages > MAX_SCAN_PAGES) throw new Error("PDS member pagination exceeded the bounded page limit.");
    const page = await client.query<ListMembers.OutputSchema>("com.atproto.memberspace.listMembers", {
      space: input.space,
      limit: 1,
      cursor,
    });
    assertMemberPage(page, 1);
    for (const member of page.members) {
      if (seenDids.has(member.did)) throw new Error("PDS member pagination returned a duplicate member DID.");
    }
    if (page.cursor && (page.cursor === cursor || seenCursors.has(page.cursor))) throw new Error("PDS member pagination did not advance.");
    truncated = page.members.length > 0;
  }
  return { members, truncated };
}

export async function listBoundedRecords(
  client: AtprotoClient,
  input: { space: string; repo: string; collection?: string; maxRecords: number; excludeValues?: false },
): Promise<BoundedRecords<BoundedRecord>>;
export async function listBoundedRecords(
  client: AtprotoClient,
  input: { space: string; repo: string; collection?: string; maxRecords: number; excludeValues: true },
): Promise<BoundedRecords<BoundedRecordHeader>>;
export async function listBoundedRecords(
  client: AtprotoClient,
  input: { space: string; repo: string; collection?: string; maxRecords: number; excludeValues?: boolean },
): Promise<BoundedRecords<BoundedRecord | BoundedRecordHeader>>;
export async function listBoundedRecords(
  client: AtprotoClient,
  input: { space: string; repo: string; collection?: string; maxRecords: number; excludeValues?: boolean },
): Promise<BoundedRecords<BoundedRecord | BoundedRecordHeader>> {
  if (!Number.isSafeInteger(input.maxRecords) || input.maxRecords < 1) throw new RangeError("Record scan limit must be a positive safe integer.");
  const records: Array<BoundedRecord | BoundedRecordHeader> = [];
  const seenCursors = new Set<string>();
  const seenKeys = new Set<string>();
  let scanned = 0;
  let pages = 0;
  let cursor: string | undefined;
  do {
    const limit = Math.min(500, input.maxRecords - scanned);
    if (++pages > MAX_SCAN_PAGES) throw new Error("PDS record pagination exceeded the bounded page limit.");
    const page = await client.query<ListRecords.OutputSchema>("com.atproto.space.listRecords", {
      space: input.space,
      repo: input.repo,
      ...(input.collection !== undefined ? { collection: input.collection } : {}),
      ...(input.excludeValues !== undefined ? { excludeValues: input.excludeValues } : {}),
      limit,
      cursor,
    });
    if (cursor) seenCursors.add(cursor);
    assertBoundedRecordPage(page, {
      collection: input.collection,
      excludeValues: input.excludeValues,
      limit,
      cursor,
      seenCursors,
      space: input.space,
      repo: input.repo,
    });
    for (const record of page.records) {
      const key = `${record.collection}/${record.rkey}`;
      if (seenKeys.has(key)) throw new Error("PDS record pagination returned a duplicate record key.");
      seenKeys.add(key);
    }
    if (input.excludeValues) {
      for (const record of page.records) {
        records.push({ collection: record.collection, rkey: record.rkey, cid: record.cid });
      }
    } else {
      for (const record of page.records) {
        if (record.value) {
          records.push({ collection: record.collection, rkey: record.rkey, cid: record.cid ?? "", value: record.value });
        }
      }
    }
    scanned += page.records.length;
    cursor = page.cursor;
    if (cursor) seenCursors.add(cursor);
  } while (cursor && scanned < input.maxRecords);

  let truncated = false;
  if (cursor) {
    if (++pages > MAX_SCAN_PAGES) throw new Error("PDS record pagination exceeded the bounded page limit.");
    const page = await client.query<ListRecords.OutputSchema>("com.atproto.space.listRecords", {
      space: input.space,
      repo: input.repo,
      ...(input.collection !== undefined ? { collection: input.collection } : {}),
      ...(input.excludeValues !== undefined ? { excludeValues: input.excludeValues } : {}),
      limit: 1,
      cursor,
    });
    assertBoundedRecordPage(page, {
      collection: input.collection,
      excludeValues: input.excludeValues,
      limit: 1,
      cursor,
      seenCursors,
      space: input.space,
      repo: input.repo,
    });
    if (page.records.some((record) => seenKeys.has(`${record.collection}/${record.rkey}`))) {
      throw new Error("PDS record pagination returned a duplicate record key.");
    }
    truncated = page.records.length > 0;
  }
  return { records, truncated };
}
