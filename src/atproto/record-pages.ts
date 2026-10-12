import type * as ListRecords from "@/lexicons/api/types/com/atproto/space/listRecords";
import type * as ListMembers from "@/lexicons/api/types/com/atproto/simplespace/listMembers";
import type * as ListRepos from "@/lexicons/api/types/com/atproto/space/listRepos";
import type * as ListSpaces from "@/lexicons/api/types/com/atproto/space/listSpaces";
import type { AtprotoClient } from "./xrpc";

const MAX_SCAN_PAGES = 128;
const MAX_REPO_SCAN_PAGES = 512;
const MAX_SPACE_PAGE = 100; // com.atproto.space.listSpaces caps `limit` at 100, unlike the 500 shared by listRepos/listMembers/listRecords.

export type BoundedRecords = {
  records: Array<{ rkey: string; value: Record<string, unknown> }>;
  truncated: boolean;
};

export type BoundedMembers = {
  members: ListMembers.Member[];
  truncated: boolean;
};

export type BoundedRepos = {
  repos: ListRepos.Repo[];
  truncated: boolean;
};

export type BoundedSpaces = {
  spaces: ListSpaces.SpaceView[];
  truncated: boolean;
};

export function assertBoundedRecordPage(
  page: unknown,
  input: { collection: string; limit: number; cursor?: string; seenCursors?: ReadonlySet<string> },
): asserts page is ListRecords.OutputSchema {
  if (input.collection.length === 0) throw new RangeError("Record page collection must not be empty.");
  if (!Number.isSafeInteger(input.limit) || input.limit < 1) throw new RangeError("Record page limit must be a positive safe integer.");
  if (typeof page !== "object" || page === null) throw new Error("PDS record page is malformed.");
  const candidate = page as { records?: unknown; cursor?: unknown };
  if (!Array.isArray(candidate.records) || candidate.records.length > input.limit) throw new Error("PDS record page exceeded the requested limit.");
  const rkeys = new Set<string>();
  if (candidate.records.some((record) => typeof record !== "object" || record === null || typeof record.rkey !== "string" || record.rkey.length === 0 ||
    record.collection !== input.collection ||
    typeof record.value !== "object" || record.value === null || Array.isArray(record.value))) {
    throw new Error("PDS record page contains a malformed record or unexpected collection.");
  }
  for (const record of candidate.records as Array<{ rkey: string }>) {
    if (rkeys.has(record.rkey)) throw new Error("PDS record page contains duplicate record keys.");
    rkeys.add(record.rkey);
  }
  if (candidate.cursor !== undefined && (typeof candidate.cursor !== "string" || candidate.cursor.length === 0)) {
    throw new Error("PDS record pagination returned an invalid cursor.");
  }
  if (candidate.cursor && (candidate.cursor === input.cursor || input.seenCursors?.has(candidate.cursor))) {
    throw new Error("PDS record pagination did not advance.");
  }
  if (candidate.records.length === 0 && candidate.cursor) throw new Error("PDS record pagination returned an empty nonterminal page.");
}

function assertRepoPage(page: unknown, limit: number): asserts page is ListRepos.OutputSchema {
  if (typeof page !== "object" || page === null) throw new Error("PDS repo page is malformed.");
  const candidate = page as { repos?: unknown };
  if (!Array.isArray(candidate.repos) || candidate.repos.length > limit) throw new Error("PDS repo page exceeded the requested limit.");
  if (candidate.repos.some((repo) => typeof repo !== "object" || repo === null || Array.isArray(repo) ||
    typeof repo.did !== "string" || !/^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/.test(repo.did))) {
    throw new Error("PDS repo page contains a malformed repo DID.");
  }
}

export async function listBoundedRepos(
  client: AtprotoClient,
  input: { space: string; maxRepos: number },
): Promise<BoundedRepos> {
  if (!Number.isSafeInteger(input.maxRepos) || input.maxRepos < 1) throw new RangeError("Repo scan limit must be a positive safe integer.");
  const repos: ListRepos.Repo[] = [];
  const seenCursors = new Set<string>();
  const seenDids = new Set<string>();
  let pages = 0;
  let cursor: string | undefined;
  do {
    const requestedCursor = cursor;
    const limit = Math.min(500, input.maxRepos - repos.length);
    if (++pages > MAX_REPO_SCAN_PAGES) throw new Error("PDS repo pagination exceeded the bounded page limit.");
    const page = await client.query<ListRepos.OutputSchema>("com.atproto.space.listRepos", { space: input.space, limit, cursor });
    assertRepoPage(page, limit);
    for (const repo of page.repos) {
      if (seenDids.has(repo.did)) throw new Error("PDS repo pagination returned a duplicate repo DID.");
      seenDids.add(repo.did);
    }
    repos.push(...page.repos);
    if (page.cursor !== undefined && (typeof page.cursor !== "string" || page.cursor.length === 0)) throw new Error("PDS repo pagination returned an invalid cursor.");
    cursor = page.cursor;
    if (cursor) {
      if (cursor === requestedCursor || seenCursors.has(cursor)) throw new Error("PDS repo pagination did not advance.");
      if (page.repos.length === 0) throw new Error("PDS repo pagination returned an empty nonterminal page.");
      seenCursors.add(cursor);
    }
  } while (cursor && repos.length < input.maxRepos);

  let truncated = false;
  if (cursor) {
    if (++pages > MAX_REPO_SCAN_PAGES) throw new Error("PDS repo pagination exceeded the bounded page limit.");
    const lookahead = await client.query<ListRepos.OutputSchema>("com.atproto.space.listRepos", { space: input.space, limit: 1, cursor });
    assertRepoPage(lookahead, 1);
    if (lookahead.repos.some((repo) => seenDids.has(repo.did))) throw new Error("PDS repo pagination returned a duplicate repo DID.");
    if (lookahead.cursor !== undefined && (typeof lookahead.cursor !== "string" || lookahead.cursor.length === 0)) throw new Error("PDS repo pagination returned an invalid cursor.");
    if (lookahead.repos.length === 0 && lookahead.cursor) throw new Error("PDS repo pagination returned an empty nonterminal page.");
    if (lookahead.cursor && (lookahead.cursor === cursor || seenCursors.has(lookahead.cursor))) throw new Error("PDS repo pagination did not advance.");
    truncated = lookahead.repos.length > 0;
  }
  return { repos, truncated };
}

function assertSpacePage(page: unknown, limit: number): asserts page is ListSpaces.OutputSchema {
  if (typeof page !== "object" || page === null) throw new Error("PDS space page is malformed.");
  const candidate = page as { spaces?: unknown; cursor?: unknown };
  if (!Array.isArray(candidate.spaces) || candidate.spaces.length > limit) throw new Error("PDS space page exceeded the requested limit.");
  if (candidate.spaces.some((space) => typeof space !== "object" || space === null || Array.isArray(space) ||
    typeof space.uri !== "string" || !/^at:\/\/did:[a-z0-9]+:[A-Za-z0-9._:%-]+\/space\/[A-Za-z0-9.-]+\/[A-Za-z0-9._~:-]{1,128}$/.test(space.uri))) {
    throw new Error("PDS space page contains a malformed space URI.");
  }
  if (candidate.cursor !== undefined && (typeof candidate.cursor !== "string" || candidate.cursor.length === 0)) {
    throw new Error("PDS space pagination returned an invalid cursor.");
  }
  if (candidate.spaces.length === 0 && candidate.cursor) throw new Error("PDS space pagination returned an empty nonterminal page.");
}

export async function listBoundedSpaces(
  client: AtprotoClient,
  input: { type?: string; did?: string; maxSpaces: number },
): Promise<BoundedSpaces> {
  if (!Number.isSafeInteger(input.maxSpaces) || input.maxSpaces < 1) throw new RangeError("Space scan limit must be a positive safe integer.");
  const spaces: ListSpaces.SpaceView[] = [];
  const seenCursors = new Set<string>();
  const seenUris = new Set<string>();
  let pages = 0;
  let cursor: string | undefined;
  do {
    const requestedCursor = cursor;
    const limit = Math.min(MAX_SPACE_PAGE, input.maxSpaces - spaces.length);
    if (++pages > MAX_SCAN_PAGES) throw new Error("PDS space pagination exceeded the bounded page limit.");
    const page = await client.query<ListSpaces.OutputSchema>("com.atproto.space.listSpaces", {
      type: input.type, did: input.did, limit, cursor,
    });
    assertSpacePage(page, limit);
    for (const space of page.spaces) {
      if (seenUris.has(space.uri)) throw new Error("PDS space pagination returned a duplicate space URI.");
      seenUris.add(space.uri);
    }
    spaces.push(...page.spaces);
    cursor = page.cursor;
    if (cursor) {
      if (cursor === requestedCursor || seenCursors.has(cursor)) throw new Error("PDS space pagination did not advance.");
      if (page.spaces.length === 0) throw new Error("PDS space pagination returned an empty nonterminal page.");
      seenCursors.add(cursor);
    }
  } while (cursor && spaces.length < input.maxSpaces);

  let truncated = false;
  if (cursor) {
    if (++pages > MAX_SCAN_PAGES) throw new Error("PDS space pagination exceeded the bounded page limit.");
    const lookahead = await client.query<ListSpaces.OutputSchema>("com.atproto.space.listSpaces", {
      type: input.type, did: input.did, limit: 1, cursor,
    });
    assertSpacePage(lookahead, 1);
    if (lookahead.spaces.some((space) => seenUris.has(space.uri))) throw new Error("PDS space pagination returned a duplicate space URI.");
    if (lookahead.cursor && (lookahead.cursor === cursor || seenCursors.has(lookahead.cursor))) throw new Error("PDS space pagination did not advance.");
    truncated = lookahead.spaces.length > 0;
  }
  return { spaces, truncated };
}

function assertMemberPage(page: unknown, limit: number): asserts page is ListMembers.OutputSchema {
  if (typeof page !== "object" || page === null) throw new Error("PDS member page is malformed.");
  const candidate = page as { members?: unknown; cursor?: unknown };
  if (!Array.isArray(candidate.members) || candidate.members.length > limit) throw new Error("PDS member page exceeded the requested limit.");
  if (candidate.members.some((member) => typeof member !== "object" || member === null || Array.isArray(member) ||
    typeof member.did !== "string" || !/^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/.test(member.did) ||
    typeof member.read !== "boolean" || typeof member.write !== "boolean" ||
    (member.$type !== undefined && member.$type !== "com.atproto.simplespace.listMembers#member"))) {
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
  const members: ListMembers.Member[] = [];
  const seenDids = new Set<string>();
  const seenCursors = new Set<string>();
  let pages = 0;
  let cursor: string | undefined;
  do {
    const requestedCursor = cursor;
    const limit = Math.min(500, input.maxMembers - members.length);
    if (++pages > MAX_SCAN_PAGES) throw new Error("PDS member pagination exceeded the bounded page limit.");
    const page = await client.query<ListMembers.OutputSchema>("com.atproto.simplespace.listMembers", {
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
    const page = await client.query<ListMembers.OutputSchema>("com.atproto.simplespace.listMembers", {
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
  input: { space: string; repo: string; collection: string; maxRecords: number },
): Promise<BoundedRecords> {
  if (!Number.isSafeInteger(input.maxRecords) || input.maxRecords < 1) throw new RangeError("Record scan limit must be a positive safe integer.");
  const records: BoundedRecords["records"] = [];
  const seenCursors = new Set<string>();
  const seenRkeys = new Set<string>();
  let scanned = 0;
  let pages = 0;
  let cursor: string | undefined;
  do {
    const limit = Math.min(500, input.maxRecords - scanned);
    if (++pages > MAX_SCAN_PAGES) throw new Error("PDS record pagination exceeded the bounded page limit.");
    const page = await client.query<ListRecords.OutputSchema>("com.atproto.space.listRecords", {
      space: input.space,
      repo: input.repo,
      collection: input.collection,
      limit,
      cursor,
    });
    if (cursor) seenCursors.add(cursor);
    assertBoundedRecordPage(page, { collection: input.collection, limit, cursor, seenCursors });
    for (const record of page.records) {
      if (seenRkeys.has(record.rkey)) throw new Error("PDS record pagination returned a duplicate record key.");
      seenRkeys.add(record.rkey);
    }
    records.push(...page.records.flatMap((record) => record.value ? [{ rkey: record.rkey, value: record.value }] : []));
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
      collection: input.collection,
      limit: 1,
      cursor,
    });
    assertBoundedRecordPage(page, { collection: input.collection, limit: 1, cursor, seenCursors });
    if (page.records.some((record) => seenRkeys.has(record.rkey))) throw new Error("PDS record pagination returned a duplicate record key.");
    truncated = page.records.length > 0;
  }
  return { records, truncated };
}
