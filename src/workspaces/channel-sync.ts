import type { OAuthSession } from "@atproto/oauth-client-node";
import type * as GetLatestCommit from "@/lexicons/api/types/com/atproto/space/getLatestCommit";
import type * as GetRecord from "@/lexicons/api/types/com/atproto/space/getRecord";
import type * as ListRecords from "@/lexicons/api/types/com/atproto/space/listRecords";
import type * as ListRepos from "@/lexicons/api/types/com/atproto/space/listRepos";
import { decryptCachedValue, encryptCachedValue, type CachedRecordContext } from "@/auth/encrypted-cache";
import { resolvePds } from "@/atproto/identity";
import { registerSpaceNotifications } from "@/atproto/notifications";
import { assertBoundedRecordPage, listBoundedRepos } from "@/atproto/record-pages";
import { selectValidChannelMessages } from "@/atproto/valid-channel-messages";
import { mintSpaceCredential, type SpaceCredential } from "@/atproto/space-credential";
import { AtprotoClient } from "@/atproto/xrpc";
import { getRawDb } from "@/lib/db";
import { mapLimited } from "@/lib/map-limited";
import { channelUri, parseSpaceUri, spaceRecordUri } from "@/protocol/keys";
import { validateSpaceRecord } from "@/protocol/records";
import { ChannelUnavailableError, requireReadableChannel } from "./channels";
import { purgeSpaceCache, purgeWorkspaceCache } from "./cache";

const PAGE = 100;
const BACKFILL_PAGE = 1_000;
const REPO_CONCURRENCY = 8;
const MAX_HISTORY = 20_000;
type Cached = { repo: string; rkey: string; uri: string; value: Record<string, unknown> };

export async function readChannelPage(session: OAuthSession, workspace: string, skey: string, offset = 0) {
  let readable: Awaited<ReturnType<typeof requireReadableChannel>>;
  try {
    readable = await requireReadableChannel(session, workspace, skey);
  } catch (error) {
    const parsed = parseSpaceUri(workspace);
    if (parsed?.type === "org.slack.workspace" && skey) {
      const space = channelUri(parsed.authorityDid, skey);
      if (denied(error)) purgeWorkspaceCache(session.did, workspace);
      else if (error instanceof ChannelUnavailableError && error.visibility === "archived") purgeSpaceCache(session.did, space);
    }
    throw error;
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= MAX_HISTORY) throw new Error("History page is outside the 20,000-message limit.");
  const authorityDid = readable.authorityDid;
  const space = readable.channel;
  let credential: SpaceCredential;
  try {
    credential = await mintSpaceCredential(session, space);
    await registerSpaceNotifications(credential, space);
  } catch (error) {
    if (denied(error)) purgeSpaceCache(session.did, space);
    throw error;
  }
  try {
    const ownerClient = credential.client(await resolvePds(authorityDid));
    const repoScan = await listBoundedRepos(ownerClient, { space, maxRepos: MAX_HISTORY });
    if (repoScan.truncated) throw new Error("Channel has too many writer repos to sync safely.");
    const repos = repoScan.repos;
    const clients = new Map<string, Promise<AtprotoClient>>();
    const clientFor = (did: string) => {
      let client = clients.get(did);
      if (!client) {
        client = resolvePds(did).then((pds) => credential.client(pds));
        clients.set(did, client);
      }
      return client;
    };
    await mapLimited(repos, REPO_CONCURRENCY, async (repo) => {
      const client = await clientFor(repo.did);
      await refresh(session.did, space, repo.did, client, "org.slack.channel.message");
      await refresh(session.did, space, repo.did, client, "org.slack.channel.reaction");
    });
    const collection = "org.slack.channel.message";
    const required = Math.min(offset + PAGE + 1, MAX_HISTORY + 1);
    let scanTarget = Math.min(required, MAX_HISTORY);
    let selected = await selectValidChannelMessages([], {
      authorityDid,
      spaceUri: space,
      limit: required,
      getParent: async () => null,
    });
    while (true) {
      await fillLatest(session.did, space, repos, clientFor, scanTarget);
      const allMessages = cached(session.did, space, collection).sort((a, b) => b.rkey.localeCompare(a.rkey));
      selected = await selectValidChannelMessages(allMessages, {
        authorityDid,
        spaceUri: space,
        limit: required,
        getParent: async (repo, rkey) => {
          const record = await (await clientFor(repo)).query<GetRecord.OutputSchema>("com.atproto.space.getRecord", {
            space, repo, collection, rkey,
          });
          return { uri: record.uri, value: record.value };
        },
      });
      const total = cachedCount(session.did, space, collection);
      if (selected.messages.length >= required || total >= MAX_HISTORY || !hasMoreCursor(session.did, space, collection)) break;
      const nextTarget = Math.min(MAX_HISTORY, Math.max(scanTarget + PAGE, total + PAGE));
      if (nextTarget <= scanTarget) break;
      scanTarget = nextTarget;
    }
    await fillOlder(session.did, space, repos, clientFor, "org.slack.channel.reaction", MAX_HISTORY);
    const messages = selected.messages.slice(offset, offset + PAGE);
    const messageUris = new Set(messages.map((item) => item.uri));
    const knownMessages = new Set(messages.map((item) => item.uri));
    const reactions = cached(session.did, space, "org.slack.channel.reaction").filter((item) =>
      typeof item.value.subject === "string" && messageUris.has(item.value.subject) && validateSpaceRecord("org.slack.channel.reaction", item.value, {
        authorityDid, spaceUri: space, repoDid: item.repo, rkey: item.rkey, knownMessages,
      }).valid,
    ).sort((left, right) => left.uri.localeCompare(right.uri));
    const total = cachedCount(session.did, space, collection);
    const nextOffset = Math.min(offset + PAGE, MAX_HISTORY);
    const hasMore = channelPageHasMore(offset, PAGE, selected.messages.length, total, hasMoreCursor(session.did, space, collection));
    const degradedReasons: string[] = [];
    if (total >= MAX_HISTORY && hasMoreCursor(session.did, space, collection)) {
      degradedReasons.push(`Message history exceeds the ${MAX_HISTORY}-record channel sync limit.`);
    }
    const reactionCount = cachedCount(session.did, space, "org.slack.channel.reaction");
    if (reactionCount >= MAX_HISTORY && hasMoreCursor(session.did, space, "org.slack.channel.reaction")) {
      degradedReasons.push(`Reaction history exceeds the ${MAX_HISTORY}-record channel sync limit.`);
    }
    return {
      messages,
      reactions,
      nextOffset,
      hasMore,
      degraded: degradedReasons.length > 0,
      degradedReasons,
    };
  } catch (error) {
    if (denied(error)) purgeSpaceCache(session.did, space);
    throw error;
  }
}

export function channelPageHasMore(
  offset: number,
  pageSize: number,
  selectedCount: number,
  scannedCount: number,
  cursorRemains: boolean,
): boolean {
  const nextOffset = Math.min(offset + pageSize, MAX_HISTORY);
  return selectedCount > offset + pageSize || (nextOffset < MAX_HISTORY && scannedCount < MAX_HISTORY && cursorRemains);
}

async function refresh(account: string, space: string, repo: string, client: AtprotoClient, collection: string): Promise<void> {
  const raw = getRawDb();
  const prior = raw.prepare("SELECT rev, next_cursor, checked_at FROM space_collection_cursor WHERE account_did=? AND space_uri=? AND repo_did=? AND collection=?")
    .get(account, space, repo, collection) as { rev: string; next_cursor: string | null; checked_at: number } | undefined;
  const now = seconds();
  if (prior && now - prior.checked_at < 60) return;
  const commit = await client.query<GetLatestCommit.OutputSchema>("com.atproto.space.getLatestCommit", { space, repo });
  const rev = commit.commit.rev;
  if (prior?.rev === rev) {
    raw.prepare(`UPDATE space_collection_cursor SET checked_at=?
      WHERE account_did=? AND space_uri=? AND repo_did=? AND collection=? AND rev=? AND next_cursor IS ?`)
      .run(now, account, space, repo, collection, prior.rev, prior.next_cursor);
    return;
  }
  const limit = 1;
  const page = await client.query<ListRecords.OutputSchema>("com.atproto.space.listRecords", { space, repo, collection, limit });
  assertBoundedRecordPage(page, { collection, limit });
  const resetAndStore = raw.transaction(() => {
    const nextCursor = page.cursor ?? null;
    const finished = page.cursor ? 0 : 1;
    if (prior) {
      const result = raw.prepare(`UPDATE space_collection_cursor SET rev=?,next_cursor=?,finished=?,checked_at=?
        WHERE account_did=? AND space_uri=? AND repo_did=? AND collection=? AND rev=? AND next_cursor IS ?`)
        .run(rev, nextCursor, finished, now, account, space, repo, collection, prior.rev, prior.next_cursor);
      if (result.changes !== 1) return false;
    } else {
      const result = raw.prepare(`INSERT INTO space_collection_cursor (account_did,space_uri,repo_did,collection,rev,next_cursor,finished,checked_at)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(account_did,space_uri,repo_did,collection) DO NOTHING`)
        .run(account, space, repo, collection, rev, nextCursor, finished, now);
      if (result.changes !== 1) return false;
    }
    raw.prepare("DELETE FROM channel_record_cache WHERE account_did=? AND space_uri=? AND repo_did=? AND collection=?")
      .run(account, space, repo, collection);
    const stored = store(account, space, repo, collection, page.records);
    if (page.cursor && stored === 0) throw new Error("PDS record pagination advanced without adding records.");
    raw.prepare(`INSERT INTO sync_cursor (account_did,space_uri,repo_did,rev,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(account_did,space_uri,repo_did) DO UPDATE SET rev=excluded.rev,updated_at=excluded.updated_at`)
      .run(account, space, repo, rev, now);
    return true;
  });
  resetAndStore();
}

async function fillLatest(
  account: string,
  space: string,
  repos: ListRepos.Repo[],
  clientFor: (did: string) => Promise<AtprotoClient>,
  target: number,
): Promise<void> {
  const raw = getRawDb();
  const collection = "org.slack.channel.message";
  const goal = Math.min(target, MAX_HISTORY);
  const limit = Math.max(1, Math.min(PAGE, Math.floor(PAGE / Math.max(1, repos.length))));
  const seenCursors = new Map<string, Set<string>>();
  const seenRkeys = new Map<string, Set<string>>();
  for (const row of raw.prepare("SELECT repo_did,rkey FROM channel_record_cache WHERE account_did=? AND space_uri=? AND collection=?")
    .all(account, space, collection) as Array<{ repo_did: string; rkey: string }>) {
    const keys = seenRkeys.get(row.repo_did) ?? new Set<string>();
    keys.add(row.rkey);
    seenRkeys.set(row.repo_did, keys);
  }
  for (let round = 0; round < MAX_HISTORY; round += 1) {
    const records = cached(account, space, collection).sort((left, right) => right.rkey.localeCompare(left.rkey));
    const cutoff = records.length >= goal ? records[goal - 1]?.rkey : undefined;
    const candidates = repos.flatMap((repo) => {
      const state = raw.prepare("SELECT rev,next_cursor,finished FROM space_collection_cursor WHERE account_did=? AND space_uri=? AND repo_did=? AND collection=?")
        .get(account, space, repo.did, collection) as { rev: string; next_cursor: string | null; finished: number } | undefined;
      if (!state?.next_cursor || state.finished) return [];
      const repoRecords = records.filter((record) => record.repo === repo.did);
      const lastSeen = repoRecords.reduce<string | undefined>((smallest, record) => !smallest || record.rkey < smallest ? record.rkey : smallest, undefined);
      return !cutoff || !lastSeen || lastSeen >= cutoff ? [{ repo, state }] : [];
    });
    if (candidates.length === 0 || records.length >= MAX_HISTORY) return;
    await mapLimited(candidates, REPO_CONCURRENCY, async ({ repo, state }) => {
      const client = await clientFor(repo.did);
      const cursor = state.next_cursor ?? undefined;
      const usedCursors = seenCursors.get(repo.did) ?? new Set<string>();
      seenCursors.set(repo.did, usedCursors);
      if (cursor && usedCursors.has(cursor)) throw new Error("PDS record pagination did not advance.");
      if (cursor) usedCursors.add(cursor);
      const page = await client.query<ListRecords.OutputSchema>("com.atproto.space.listRecords", {
        space, repo: repo.did, collection, cursor, limit,
      });
      assertBoundedRecordPage(page, { collection, limit, cursor, seenCursors: usedCursors });
      const keys = seenRkeys.get(repo.did) ?? new Set<string>();
      seenRkeys.set(repo.did, keys);
      commitPageAndAdvanceCursor(account, space, repo.did, collection, state.rev, cursor!, page, keys);
    });
  }
}

async function fillOlder(
  account: string,
  space: string,
  repos: ListRepos.Repo[],
  clientFor: (did: string) => Promise<AtprotoClient>,
  collection: string,
  target: number,
): Promise<void> {
  const raw = getRawDb();
  const goal = Math.min(target, MAX_HISTORY);
  const seenCursors = new Map<string, Set<string>>();
  const seenRkeys = new Map<string, Set<string>>();
  for (const row of raw.prepare("SELECT repo_did,rkey FROM channel_record_cache WHERE account_did=? AND space_uri=? AND collection=?")
    .all(account, space, collection) as Array<{ repo_did: string; rkey: string }>) {
    const keys = seenRkeys.get(row.repo_did) ?? new Set<string>();
    keys.add(row.rkey);
    seenRkeys.set(row.repo_did, keys);
  }
  for (let round = 0; round < MAX_HISTORY; round += 1) {
    const remaining = Math.min(goal, MAX_HISTORY) - cachedCount(account, space, collection);
    if (remaining <= 0) break;
    const candidates = repos.flatMap((repo) => {
      const state = raw.prepare("SELECT rev,next_cursor,finished FROM space_collection_cursor WHERE account_did=? AND space_uri=? AND repo_did=? AND collection=?")
        .get(account, space, repo.did, collection) as { rev: string; next_cursor: string | null; finished: number } | undefined;
      return state?.next_cursor && !state.finished ? [{ repo, cursor: state.next_cursor, rev: state.rev }] : [];
    }).slice(0, remaining);
    if (candidates.length === 0) return;
    const limit = backfillPageLimit(remaining, candidates.length);
    const stored = await mapLimited(candidates, REPO_CONCURRENCY, async ({ repo, cursor, rev }) => {
      const client = await clientFor(repo.did);
      const usedCursors = seenCursors.get(repo.did) ?? new Set<string>();
      seenCursors.set(repo.did, usedCursors);
      if (usedCursors.has(cursor)) throw new Error("PDS record pagination did not advance.");
      usedCursors.add(cursor);
      const page = await client.query<ListRecords.OutputSchema>("com.atproto.space.listRecords", {
        space, repo: repo.did, collection, cursor, limit,
      });
      assertBoundedRecordPage(page, { collection, limit, cursor, seenCursors: usedCursors });
      const keys = seenRkeys.get(repo.did) ?? new Set<string>();
      seenRkeys.set(repo.did, keys);
      return commitPageAndAdvanceCursor(account, space, repo.did, collection, rev, cursor, page, keys).stored;
    });
    if (stored.every((count) => count === 0)) return;
  }
  if (goal < MAX_HISTORY || cachedCount(account, space, collection) < goal) return;
  for (const repo of repos) {
    const state = raw.prepare("SELECT rev,next_cursor,finished FROM space_collection_cursor WHERE account_did=? AND space_uri=? AND repo_did=? AND collection=?")
      .get(account, space, repo.did, collection) as { rev: string; next_cursor: string | null; finished: number } | undefined;
    if (!state?.next_cursor || state.finished) continue;
    const client = await clientFor(repo.did);
    const usedCursors = seenCursors.get(repo.did) ?? new Set<string>();
    seenCursors.set(repo.did, usedCursors);
    if (usedCursors.has(state.next_cursor)) throw new Error("PDS record pagination did not advance.");
    usedCursors.add(state.next_cursor);
    const page = await client.query<ListRecords.OutputSchema>("com.atproto.space.listRecords", {
      space, repo: repo.did, collection, cursor: state.next_cursor, limit: 1,
    });
    assertBoundedRecordPage(page, { collection, limit: 1, cursor: state.next_cursor, seenCursors: usedCursors });
    if (page.records.length > 0) return;
    const keys = seenRkeys.get(repo.did) ?? new Set<string>();
    seenRkeys.set(repo.did, keys);
    commitPageAndAdvanceCursor(account, space, repo.did, collection, state.rev, state.next_cursor, page, keys);
  }
}

export function backfillPageLimit(remaining: number, candidates: number): number {
  return Math.max(1, Math.min(BACKFILL_PAGE, Math.floor(remaining / Math.max(1, candidates))));
}

function commitPageAndAdvanceCursor(
  account: string,
  space: string,
  repo: string,
  collection: string,
  rev: string,
  expectedCursor: string,
  page: ListRecords.OutputSchema,
  seenRkeys: Set<string>,
): { advanced: boolean; stored: number } {
  const raw = getRawDb();
  const advance = raw.prepare(`UPDATE space_collection_cursor SET next_cursor=?,finished=?,checked_at=?
    WHERE account_did=? AND space_uri=? AND repo_did=? AND collection=? AND rev=? AND next_cursor=?`);
  const apply = raw.transaction(() => {
    const result = advance.run(page.cursor ?? null, page.cursor ? 0 : 1, seconds(), account, space, repo, collection, rev, expectedCursor);
    if (result.changes !== 1) return { advanced: false, stored: 0 };
    if (page.records.some((record) => seenRkeys.has(record.rkey))) {
      throw new Error("PDS record pagination returned a duplicate record key.");
    }
    const stored = store(account, space, repo, collection, page.records);
    if (page.cursor && stored === 0) throw new Error("PDS record pagination advanced without adding records.");
    for (const record of page.records) seenRkeys.add(record.rkey);
    return { advanced: true, stored };
  });
  return apply();
}

function store(account: string, space: string, repo: string, collection: string, records: ListRecords.Record[]): number {
  const db = getRawDb();
  const exists = db.prepare("SELECT 1 FROM channel_record_cache WHERE account_did=? AND space_uri=? AND repo_did=? AND collection=? AND rkey=?");
  const insert = db.prepare(`INSERT INTO channel_record_cache (account_did,space_uri,repo_did,collection,rkey,uri,value_cipher,updated_at)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(account_did,space_uri,repo_did,collection,rkey) DO UPDATE SET
    uri=excluded.uri,value_cipher=excluded.value_cipher,updated_at=excluded.updated_at`);
  const write = db.transaction((rows: ListRecords.Record[]) => {
    let inserted = 0;
    for (const row of rows) if (row.value) {
      if (!exists.get(account, space, repo, collection, row.rkey)) inserted += 1;
      const uri = spaceRecordUri(space, repo, collection, row.rkey);
      insert.run(account, space, repo, collection, row.rkey,
        uri, encryptCachedValue(row.value, { accountDid: account, spaceUri: space, repoDid: repo, collection, rkey: row.rkey, uri }), seconds());
    }
    return inserted;
  });
  return write(records);
}

function cached(account: string, space: string, collection: string): Cached[] {
  const rows = getRawDb().prepare("SELECT repo_did,rkey,uri,value_cipher FROM channel_record_cache WHERE account_did=? AND space_uri=? AND collection=?")
    .all(account, space, collection) as Array<{ repo_did: string; rkey: string; uri: string; value_cipher: string }>;
  return rows.flatMap((row) => {
    try {
      const uri = spaceRecordUri(space, row.repo_did, collection, row.rkey);
      let value: Record<string, unknown>;
      if (row.uri === uri) {
        const context: CachedRecordContext = { accountDid: account, spaceUri: space, repoDid: row.repo_did, collection, rkey: row.rkey, uri };
        value = decryptCachedValue<Record<string, unknown>>(row.value_cipher, context);
      } else if (row.uri === `at://${row.repo_did}/${collection}/${row.rkey}`) {
        const oldContext: CachedRecordContext = { accountDid: account, spaceUri: space, repoDid: row.repo_did, collection, rkey: row.rkey, uri: row.uri };
        value = decryptCachedValue<Record<string, unknown>>(row.value_cipher, oldContext);
        const newContext = { ...oldContext, uri };
        getRawDb().prepare(`UPDATE channel_record_cache SET uri=?,value_cipher=?,updated_at=?
          WHERE account_did=? AND space_uri=? AND repo_did=? AND collection=? AND rkey=? AND uri=?`).run(
          uri, encryptCachedValue(value, newContext), seconds(), account, space, row.repo_did, collection, row.rkey, row.uri,
        );
      } else {
        throw new Error("Cached record URI does not match its row key.");
      }
      return [{ repo: row.repo_did, rkey: row.rkey, uri, value }];
    } catch {
      getRawDb().prepare("DELETE FROM channel_record_cache WHERE account_did=? AND space_uri=? AND repo_did=? AND collection=? AND rkey=?").run(account, space, row.repo_did, collection, row.rkey);
      return [];
    }
  });
}

function cachedCount(account: string, space: string, collection: string): number {
  return (getRawDb().prepare("SELECT count(*) AS count FROM channel_record_cache WHERE account_did=? AND space_uri=? AND collection=?").get(account, space, collection) as { count: number }).count;
}

function hasMoreCursor(account: string, space: string, collection: string): boolean {
  return Boolean(getRawDb().prepare("SELECT 1 FROM space_collection_cursor WHERE account_did=? AND space_uri=? AND collection=? AND next_cursor IS NOT NULL LIMIT 1").get(account, space, collection));
}

function denied(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && (error.status === 401 || error.status === 403);
}

function seconds(): number { return Math.floor(Date.now() / 1000); }
