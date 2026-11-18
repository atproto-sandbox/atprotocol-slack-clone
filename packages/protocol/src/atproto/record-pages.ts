import type * as ListRecords from "../lexicons/api/types/com/atproto/space/listRecords";
import type * as ListMembers from "../lexicons/api/types/com/atproto/memberspace/listMembers";
import type * as ListRepos from "../lexicons/api/types/com/atproto/space/listRepos";
import type * as ListSpaces from "../lexicons/api/types/com/atproto/space/listSpaces";
import { isDid, parseSpaceUri, spaceRecordUri } from "../keys";
import type { AtprotoClient } from "./xrpc";

const MAX_SCAN_PAGES = 128;
const MAX_REPO_SCAN_PAGES = 512;
const MAX_SPACE_PAGE = 100; // com.atproto.space.listSpaces caps `limit` at 100; the app caps listRepos/listMembers/listRecords pages at 500 itself.

const NSID_PATTERN = /^[a-zA-Z](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?:\.[a-zA-Z](?:[a-zA-Z0-9]{0,62})?)$/;
const RKEY_PATTERN = /^[A-Za-z0-9._~:-]{1,512}$/;

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

function assertRepoPage(page: unknown, limit: number): asserts page is ListRepos.OutputSchema {
  if (typeof page !== "object" || page === null) throw new Error("PDS repo page is malformed.");
  const candidate = page as { repos?: unknown };
  if (!Array.isArray(candidate.repos) || candidate.repos.length > limit) throw new Error("PDS repo page exceeded the requested limit.");
  if (candidate.repos.some((repo) => typeof repo !== "object" || repo === null || Array.isArray(repo) ||
    !isDid(repo.did))) {
    throw new Error("PDS repo page contains a malformed repo DID.");
  }
  if (candidate.repos.some((repo) => typeof repo.repoRev !== "string" || typeof repo.spaceRev !== "string" || repo.spaceRev.length === 0)) {
    throw new Error("PDS repo page contains a repo without repoRev and spaceRev.");
  }
  for (let i = 1; i < candidate.repos.length; i++) {
    if (candidate.repos[i - 1].spaceRev > candidate.repos[i].spaceRev) throw new Error("PDS repo page is not in ascending spaceRev order.");
  }
}

function assertRepoCursor(page: ListRepos.OutputSchema, requested: string | undefined, seenCursors: ReadonlySet<string>): void {
  if (page.cursor !== undefined && (typeof page.cursor !== "string" || page.cursor.length === 0)) throw new Error("PDS repo pagination returned an invalid cursor.");
  if (!page.cursor) return;
  if (page.cursor === requested || seenCursors.has(page.cursor)) throw new Error("PDS repo pagination did not advance.");
  if (page.repos.length === 0) throw new Error("PDS repo pagination returned an empty nonterminal page.");
}

/**
 * Pages are ordered by spaceRev, so a repo updated while paginating reappears at a later
 * spaceRev. The latest entry wins, and only distinct DIDs count toward the bound and the
 * truncation flag.
 */
export async function listBoundedRepos(
  client: AtprotoClient,
  input: { space: string; maxRepos: number },
): Promise<BoundedRepos> {
  if (!Number.isSafeInteger(input.maxRepos) || input.maxRepos < 1) throw new RangeError("Repo scan limit must be a positive safe integer.");
  const collected = new Map<string, ListRepos.Repo>();
  const seenCursors = new Set<string>();
  let pages = 0;
  let cursor: string | undefined;
  const fetchPage = async (limit: number): Promise<ListRepos.OutputSchema> => {
    if (++pages > MAX_REPO_SCAN_PAGES) throw new Error("PDS repo pagination exceeded the bounded page limit.");
    const requested = cursor;
    const page = await client.query<ListRepos.OutputSchema>("com.atproto.space.listRepos", { space: input.space, limit, cursor });
    assertRepoPage(page, limit);
    assertRepoCursor(page, requested, seenCursors);
    cursor = page.cursor;
    if (cursor) seenCursors.add(cursor);
    return page;
  };

  do {
    const page = await fetchPage(Math.min(500, input.maxRepos - collected.size));
    for (const repo of page.repos) collected.set(repo.did, repo);
  } while (cursor && collected.size < input.maxRepos);

  let truncated = false;
  while (cursor && !truncated) {
    const page = await fetchPage(1);
    for (const repo of page.repos) {
      if (collected.has(repo.did)) collected.set(repo.did, repo);
      else truncated = true;
    }
  }
  return { repos: [...collected.values()], truncated };
}

/**
 * The repos updated in a space since a space revision, for a reader that holds the space and follows its changes: the
 * hint that names writers to check. A page shorter than the limit is the last; a repo updated while paging reappears in a
 * later call, under the revision this one returns. Throws when the changes exceed `maxRepos`.
 */
export async function listReposSince(
  client: AtprotoClient,
  input: { space: string; since: string | null; maxRepos: number },
): Promise<{ repos: ListRepos.Repo[]; spaceRev: string | null }> {
  const limit = 100;
  const repos = new Map<string, ListRepos.Repo>();
  const seenCursors = new Set<string>();
  let cursor = input.since ?? undefined;
  let spaceRev = input.since;
  for (let pages = 0; ; pages += 1) {
    if (pages >= MAX_REPO_SCAN_PAGES) throw new Error("PDS repo pagination exceeded the bounded page limit.");
    const requested = cursor;
    const page = await client.query<ListRepos.OutputSchema>("com.atproto.space.listRepos", { space: input.space, limit, ...(cursor ? { cursor } : {}) });
    assertRepoPage(page, limit);
    if (page.cursor !== undefined && page.cursor === requested && page.repos.length === 0) return { repos: [...repos.values()], spaceRev };
    assertRepoCursor(page, requested, seenCursors);
    for (const repo of page.repos) {
      repos.set(repo.did, repo);
      if (spaceRev === null || repo.spaceRev > spaceRev) spaceRev = repo.spaceRev;
    }
    if (repos.size > input.maxRepos) throw new Error(`The space's changed writers exceed the ${input.maxRepos}-repo scan limit.`);
    if (!page.cursor || page.repos.length < limit) return { repos: [...repos.values()], spaceRev };
    seenCursors.add(page.cursor);
    cursor = page.cursor;
  }
}

function assertSpacePage(page: unknown, limit: number): asserts page is ListSpaces.OutputSchema {
  if (typeof page !== "object" || page === null) throw new Error("PDS space page is malformed.");
  const candidate = page as { spaces?: unknown; cursor?: unknown };
  if (!Array.isArray(candidate.spaces) || candidate.spaces.length > limit) throw new Error("PDS space page exceeded the requested limit.");
  if (candidate.spaces.some((space) => typeof space !== "object" || space === null || Array.isArray(space) || typeof space.uri !== "string")) {
    throw new Error("PDS space page contains a malformed space.");
  }
  if (candidate.cursor !== undefined && (typeof candidate.cursor !== "string" || candidate.cursor.length === 0)) {
    throw new Error("PDS space pagination returned an invalid cursor.");
  }
  if (candidate.spaces.length === 0 && candidate.cursor) throw new Error("PDS space pagination returned an empty nonterminal page.");
}

export async function listBoundedSpaces(
  client: AtprotoClient,
  input: { spaceType?: string; did?: string; maxSpaces: number },
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
      spaceType: input.spaceType, did: input.did, limit, cursor,
    });
    assertSpacePage(page, limit);
    for (const space of page.spaces) {
      if (seenUris.has(space.uri)) throw new Error("PDS space pagination returned a duplicate space URI.");
      seenUris.add(space.uri);
    }
    // A space whose URI this app cannot parse (for example a record key longer than it creates) is not one of its spaces. It is
    // skipped, not a reason to fail the listing: a space the account wrote into elsewhere could otherwise break discovery for good.
    spaces.push(...page.spaces.filter((space) => parseSpaceUri(space.uri) !== null));
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
      spaceType: input.spaceType, did: input.did, limit: 1, cursor: probe,
    });
    assertSpacePage(lookahead, 1);
    if (lookahead.spaces.some((space) => seenUris.has(space.uri))) throw new Error("PDS space pagination returned a duplicate space URI.");
    if (lookahead.cursor && (lookahead.cursor === probe || seenCursors.has(lookahead.cursor))) throw new Error("PDS space pagination did not advance.");
    if (lookahead.spaces.length === 0 && lookahead.cursor) throw new Error("PDS space pagination returned an empty nonterminal page.");
    truncated = lookahead.spaces.some((space) => parseSpaceUri(space.uri) !== null);
    if (lookahead.cursor) seenCursors.add(lookahead.cursor);
    probe = lookahead.cursor;
  }
  return { spaces, truncated };
}

/** Every space URI of a type, or an error when there are more than `maxSpaces`: discovery must not silently hide some of an account's spaces. */
export async function listAllSpaceUris(client: AtprotoClient, input: { spaceType: string; maxSpaces: number }): Promise<string[]> {
  const scan = await listBoundedSpaces(client, input);
  if (scan.truncated) throw new Error(`Account ${input.spaceType} list exceeds the ${input.maxSpaces}-space discovery limit.`);
  return scan.spaces.map(({ uri }) => uri);
}

function assertMemberPage(page: unknown, limit: number): asserts page is ListMembers.OutputSchema {
  if (typeof page !== "object" || page === null) throw new Error("PDS member page is malformed.");
  const candidate = page as { members?: unknown; cursor?: unknown };
  if (!Array.isArray(candidate.members) || candidate.members.length > limit) throw new Error("PDS member page exceeded the requested limit.");
  if (candidate.members.some((member) => typeof member !== "object" || member === null || Array.isArray(member) ||
    !isDid(member.did) ||
    typeof member.read !== "boolean" || typeof member.write !== "boolean" ||
    (member.$type !== undefined && member.$type !== "com.atproto.memberspace.listMembers#member"))) {
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
