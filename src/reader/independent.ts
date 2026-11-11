import type * as GetRecord from "@/lexicons/api/types/com/atproto/space/getRecord";
import type * as ListRecords from "@/lexicons/api/types/com/atproto/space/listRecords";
import type * as ListRepos from "@/lexicons/api/types/com/atproto/space/listRepos";
import { mintSpaceCredentialWith, SpaceCredentialError, type SpaceCredential, type SpaceCredentialDeps } from "@/atproto/space-credential-core";
import { assertBoundedRecordPage, listAllSpaceUris, listBoundedRecords, listBoundedRepos } from "@/atproto/record-pages";
import { selectValidChannelMessages } from "@/atproto/valid-channel-messages";
import { classifyRepoFailure, describeRepoFailure, MAX_LISTED_SET_ASIDE } from "@/atproto/repo-failure";
import { channelUri, parseWorkspaceUri, spaceRecordUri } from "@/protocol/keys";
import { validateSpaceRecord } from "@/protocol/registry";
import { mapLimited } from "@/lib/map-limited";
import { COLLECTION, SPACE_TYPE } from "@/protocol/nsids";

export type IndependentWorkspace = {
  uri: string;
  authorityDid: string;
  name: string;
  members: string[];
  admins: string[];
  channels: Array<{ uri: string; skey: string; name: string; visibility: string }>;
  degradedReasons: string[];
};

const MAX_SUPPORTED_MEMBERS = 200;
const MAX_SUPPORTED_CHANNELS = 100;
const MAX_AUTHORITY_RECORD_SCAN = 1_000;
const MAX_DISCOVERABLE_WORKSPACES = 1_000;
const MAX_CHANNEL_WRITERS = 20_000;
const MAX_CHANNEL_RECORD_SCAN = 20_000;
const MAX_CHANNEL_RECORD_PAGES = MAX_CHANNEL_RECORD_SCAN + MAX_CHANNEL_WRITERS;
const MAX_CHANNEL_REACTION_RECORDS = 20_000;
const MAX_CHANNEL_REACTION_PAGES = MAX_CHANNEL_WRITERS + Math.ceil((MAX_CHANNEL_REACTION_RECORDS + 1) / 100) + 1;

/** What the reader needs from its host: the account's own client and the transports a space credential is minted with. */
export type IndependentDeps = SpaceCredentialDeps;

export type IndependentMessage = { uri: string; rkey: string; repo: string; value: Record<string, unknown> };
export type IndependentReaction = { uri: string; rkey: string; repo: string; value: Record<string, unknown> };
export type IndependentChannelPage = {
  messages: IndependentMessage[];
  reactions: IndependentReaction[];
  degraded: boolean;
  degradedReasons: string[];
};

/**
 * A deliberately stateless reader for a second app. It uses the caller's own
 * client, published lexicon NSIDs, and PDS-issued space credentials only. It
 * does not import the primary app's database, sync cache, engine, or session layer.
 */
export async function listIndependentWorkspaces(deps: IndependentDeps): Promise<IndependentWorkspace[]> {
  const spaces = await listAllSpaceUris(deps.memberClient, { spaceType: SPACE_TYPE.workspace, maxSpaces: MAX_DISCOVERABLE_WORKSPACES });
  const summaries = await mapLimited(spaces, 8, async (uri) => {
    try { return await readIndependentWorkspace(deps, uri); }
    catch (error) {
      if (error instanceof SpaceCredentialError) return null;
      throw error;
    }
  });
  return summaries.flatMap((summary) => summary ? [summary] : []).sort((left, right) => left.name.localeCompare(right.name));
}

export async function readIndependentWorkspace(deps: IndependentDeps, uri: string): Promise<IndependentWorkspace | null> {
  const workspace = parseWorkspaceUri(uri);
  if (!workspace) return null;
  const { authorityDid } = workspace;
  const credential = await mintSpaceCredentialWith(deps, uri);
  const client = credential.client(await deps.resolvePds(authorityDid));
  const [profile, directories, roster, adminRecords] = await Promise.all([
    listBoundedRecords(client, { space: uri, repo: authorityDid, collection: COLLECTION.workspaceProfile, maxRecords: 1 }),
    listBoundedRecords(client, { space: uri, repo: authorityDid, collection: COLLECTION.directory, maxRecords: MAX_AUTHORITY_RECORD_SCAN }),
    listBoundedRecords(client, { space: uri, repo: authorityDid, collection: COLLECTION.workspaceRoster, maxRecords: MAX_AUTHORITY_RECORD_SCAN }),
    listBoundedRecords(client, { space: uri, repo: authorityDid, collection: COLLECTION.admin, maxRecords: MAX_AUTHORITY_RECORD_SCAN }),
  ]);
  const validProfile = profile.records.find((record) => validateSpaceRecord(COLLECTION.workspaceProfile, record.value, {
    authorityDid, spaceUri: uri, repoDid: authorityDid, rkey: record.rkey,
  }).valid);
  if (typeof validProfile?.value.name !== "string") return null;
  const members = roster.records.flatMap((record) => validateSpaceRecord(COLLECTION.workspaceRoster, record.value, {
    authorityDid, spaceUri: uri, repoDid: authorityDid, rkey: record.rkey,
  }).valid && record.value.active === true && typeof record.value.subject === "string" ? [record.value.subject] : []).sort();
  const admins = adminRecords.records.flatMap((record) => validateSpaceRecord(COLLECTION.admin, record.value, {
    authorityDid, spaceUri: uri, repoDid: authorityDid, rkey: record.rkey,
  }).valid && record.value.active === true && typeof record.value.subject === "string" ? [record.value.subject] : []).sort();
  const channels = directories.records.flatMap((record) => {
    if (!validateSpaceRecord(COLLECTION.directory, record.value, { authorityDid, spaceUri: uri, repoDid: authorityDid, rkey: record.rkey }).valid) return [];
    const value = record.value;
    if (typeof value.skey !== "string" || typeof value.name !== "string" || typeof value.visibility !== "string" || value.visibility === "archived") return [];
    return [{ uri: channelUri(authorityDid, value.skey), skey: value.skey, name: value.name, visibility: value.visibility }];
  }).sort((left, right) => left.name.localeCompare(right.name));
  const degradedReasons: string[] = [];
  if (profile.truncated) degradedReasons.push("Workspace profile records exceed the expected single-record limit.");
  if (directories.truncated) degradedReasons.push(`The channel directory exceeds the ${MAX_AUTHORITY_RECORD_SCAN}-record scan limit; the channel list may be incomplete.`);
  if (roster.truncated) degradedReasons.push(`The workspace roster exceeds the ${MAX_AUTHORITY_RECORD_SCAN}-record scan limit; the member list may be incomplete.`);
  if (adminRecords.truncated) degradedReasons.push(`Admin records exceed the ${MAX_AUTHORITY_RECORD_SCAN}-record scan limit; the admin list may be incomplete.`);
  if (members.length > MAX_SUPPORTED_MEMBERS) degradedReasons.push(`The active workspace roster exceeds ${MAX_SUPPORTED_MEMBERS} members.`);
  if (channels.length > MAX_SUPPORTED_CHANNELS) degradedReasons.push(`The active channel count exceeds ${MAX_SUPPORTED_CHANNELS} channels.`);
  if (admins.length > MAX_SUPPORTED_MEMBERS) degradedReasons.push(`The active admin count exceeds ${MAX_SUPPORTED_MEMBERS} members.`);
  return { uri, authorityDid, name: validProfile.value.name, members, admins, channels, degradedReasons };
}

export async function readIndependentPrivateRoster(deps: IndependentDeps, workspace: string, skey: string): Promise<string[]> {
  const summary = await readIndependentWorkspace(deps, workspace);
  const channel = summary?.channels.find((entry) => entry.skey === skey && entry.visibility === "private");
  if (!summary || !channel) throw new Error("Private channel is unavailable.");
  const credential = await mintSpaceCredentialWith(deps, channel.uri);
  const client = credential.client(await deps.resolvePds(summary.authorityDid));
  const roster = await listBoundedRecords(client, { space: channel.uri, repo: summary.authorityDid, collection: COLLECTION.channelRoster, maxRecords: MAX_AUTHORITY_RECORD_SCAN });
  const members = roster.records.flatMap((record) => validateSpaceRecord(COLLECTION.channelRoster, record.value, {
    authorityDid: summary.authorityDid, spaceUri: channel.uri, repoDid: summary.authorityDid, rkey: record.rkey,
  }).valid && record.value.active === true && typeof record.value.subject === "string" ? [record.value.subject] : []).sort();
  if (roster.truncated) throw new Error(`Private-channel roster exceeds the ${MAX_AUTHORITY_RECORD_SCAN}-record scan limit; the roster is incomplete.`);
  if (members.length > MAX_SUPPORTED_MEMBERS) throw new Error(`Private-channel roster exceeds ${MAX_SUPPORTED_MEMBERS} members.`);
  return members;
}

export async function readIndependentChannelPage(
  deps: IndependentDeps,
  workspace: string,
  skey: string,
  limit = 100,
): Promise<IndependentChannelPage> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError("Independent reader page limit must be between 1 and 100.");
  const summary = await readIndependentWorkspace(deps, workspace);
  const channel = summary?.channels.find((entry) => entry.skey === skey);
  if (!summary || !channel || (channel.visibility !== "public" && channel.visibility !== "private")) throw new Error("Channel is unavailable for new reads.");
  const credential = await mintSpaceCredentialWith(deps, channel.uri);
  const authorityClient = credential.client(await deps.resolvePds(summary.authorityDid));
  const repoScan = await listBoundedRepos(authorityClient, { space: channel.uri, maxRepos: MAX_CHANNEL_WRITERS });
  if (repoScan.truncated) throw new Error("Channel writer count exceeds the v1 envelope.");
  const repos = repoScan.repos;
  // A writer whose repo cannot be read (deactivated, taken down, unauthenticated, oversized, or on a host that is down) is reported and
  // read no further, so one member cannot make the channel unreadable for everyone else. What was read from it before it failed is
  // kept; its reactions are skipped. This covers a failed page read. A page that arrives but breaks the record rules (a record with no
  // value, a duplicate key) still fails the read, as before.
  const setAside = new Map<string, string>();
  const readWriter = async <T>(did: string, run: () => Promise<T>): Promise<T | null> => {
    try {
      return await run();
    } catch (error) {
      const failure = classifyRepoFailure(error);
      if (!failure) throw error;
      console.warn(`Independent reader set a writer aside (${failure.permanent ? "permanent" : "transient"}): ${describeRepoFailure(error)}`);
      setAside.set(did, failure.reason);
      return null;
    }
  };
  const finishPage = async (messages: IndependentMessage[]): Promise<IndependentChannelPage> => {
    const { reactions, truncated } = await readIndependentReactions(deps, credential, channel.uri, summary.authorityDid, repos.filter((repo) => !setAside.has(repo.did)), messages, readWriter);
    const degradedReasons = [
      ...[...setAside].slice(0, MAX_LISTED_SET_ASIDE).map(([did, reason]) => `Messages or reactions from ${did} may be missing: ${reason}`),
      ...(setAside.size > MAX_LISTED_SET_ASIDE ? [`${setAside.size - MAX_LISTED_SET_ASIDE} more writers' messages or reactions may be missing.`] : []),
      ...(truncated ? [`Reaction history exceeds the ${MAX_CHANNEL_REACTION_RECORDS}-record channel sync limit.`] : []),
    ];
    return { messages, reactions, degraded: degradedReasons.length > 0, degradedReasons };
  };
  const states = repos.map((repo) => ({
    repo,
    cursor: undefined as string | undefined,
    finished: false,
    seenCursors: new Set<string>(),
    seenRkeys: new Set<string>(),
    oldestRkey: undefined as string | undefined,
  }));
  const records: IndependentMessage[] = [];
  const parentReads = new Map<string, Promise<{ uri: string; value: Record<string, unknown> } | null>>();
  const getParent = (repo: string, rkey: string) => {
    const uri = spaceRecordUri(channel.uri, repo, COLLECTION.message, rkey);
    let result = parentReads.get(uri);
    if (!result) {
      result = (async () => {
        const parent = await credential.client(await deps.resolvePds(repo)).query<GetRecord.OutputSchema>("com.atproto.space.getRecord", {
          space: channel.uri, repo, collection: COLLECTION.message, rkey,
        });
        return { uri: parent.uri, value: parent.value };
      })().catch(() => null);
      parentReads.set(uri, result);
    }
    return result;
  };
  let scanned = 0;
  let pageRequests = 0;
  while (true) {
    const selected = await selectValidChannelMessages(records, {
      authorityDid: summary.authorityDid,
      spaceUri: channel.uri,
      limit,
      getParent,
    });
    const cutoff = selected.messages.length >= limit ? selected.messages[limit - 1]?.rkey : undefined;
    const candidates = states.filter((state) => !state.finished && (!cutoff || !state.oldestRkey || state.oldestRkey >= cutoff));
    if (selected.messages.length >= limit && candidates.length === 0) return finishPage(selected.messages);
    if (candidates.length === 0) return finishPage(selected.messages);

    const remaining = MAX_CHANNEL_RECORD_SCAN - scanned;
    const pageLimit = Math.min(100, Math.floor(remaining / candidates.length));
    if (pageLimit < 1) {
      if (pageRequests + candidates.length > MAX_CHANNEL_RECORD_PAGES) throw new Error("Channel pagination exceeded the bounded page request limit.");
      pageRequests += candidates.length;
      const lookahead = (await mapLimited(candidates, 8, (state) => readWriter(state.repo.did, async () => {
        if (state.cursor) state.seenCursors.add(state.cursor);
        const page = await credential.client(await deps.resolvePds(state.repo.did)).query<ListRecords.OutputSchema>("com.atproto.space.listRecords", {
          space: channel.uri, repo: state.repo.did, collection: COLLECTION.message, cursor: state.cursor, limit: 1,
        });
        assertBoundedRecordPage(page, { collection: COLLECTION.message, limit: 1, cursor: state.cursor, seenCursors: state.seenCursors });
        return { state, page };
      }).then((read) => { if (!read) state.finished = true; return read; }))).flatMap((read) => read ? [read] : []);
      const lookaheadRecordCount = lookahead.reduce((count, { page }) => count + page.records.length, 0);
      if (lookaheadRecordCount > remaining) throw new Error("Channel history exceeds the bounded 20,000-record scan limit.");
      for (const { state, page } of lookahead) {
        for (const record of page.records) {
          if (!record.value) throw new Error("PDS record page contains a malformed record.");
          if (state.seenRkeys.has(record.rkey)) throw new Error("PDS record pagination returned a duplicate record key.");
          state.seenRkeys.add(record.rkey);
          records.push({
            uri: spaceRecordUri(channel.uri, state.repo.did, COLLECTION.message, record.rkey),
            rkey: record.rkey,
            repo: state.repo.did,
            value: record.value,
          });
        }
        scanned += page.records.length;
        const pageOldest = page.records.reduce<string | undefined>((oldest, record) => !oldest || record.rkey < oldest ? record.rkey : oldest, undefined);
        if (pageOldest && (!state.oldestRkey || pageOldest < state.oldestRkey)) state.oldestRkey = pageOldest;
        state.cursor = page.cursor;
        if (page.cursor) state.seenCursors.add(page.cursor);
        else state.finished = true;
      }
      continue;
    }
    if (pageRequests + candidates.length > MAX_CHANNEL_RECORD_PAGES) throw new Error("Channel pagination exceeded the bounded page request limit.");
    pageRequests += candidates.length;
    const pages = (await mapLimited(candidates, 8, (state) => readWriter(state.repo.did, async () => {
      if (state.cursor) state.seenCursors.add(state.cursor);
      const page = await credential.client(await deps.resolvePds(state.repo.did)).query<ListRecords.OutputSchema>("com.atproto.space.listRecords", {
        space: channel.uri, repo: state.repo.did, collection: COLLECTION.message, cursor: state.cursor, limit: pageLimit,
      });
      assertBoundedRecordPage(page, { collection: COLLECTION.message, limit: pageLimit, cursor: state.cursor, seenCursors: state.seenCursors });
      return { state, page };
    }).then((read) => { if (!read) state.finished = true; return read; }))).flatMap((read) => read ? [read] : []);
    for (const { state, page } of pages) {
      for (const record of page.records) {
        if (!record.value) throw new Error("PDS record page contains a malformed record.");
        if (state.seenRkeys.has(record.rkey)) throw new Error("PDS record pagination returned a duplicate record key.");
        state.seenRkeys.add(record.rkey);
        records.push({
          uri: spaceRecordUri(channel.uri, state.repo.did, COLLECTION.message, record.rkey),
          rkey: record.rkey,
          repo: state.repo.did,
          value: record.value,
        });
      }
      scanned += page.records.length;
      const pageOldest = page.records.reduce<string | undefined>((oldest, record) => !oldest || record.rkey < oldest ? record.rkey : oldest, undefined);
      if (pageOldest && (!state.oldestRkey || pageOldest < state.oldestRkey)) state.oldestRkey = pageOldest;
      state.cursor = page.cursor;
      if (page.cursor) state.seenCursors.add(page.cursor);
      else state.finished = true;
    }
  }

}

async function readIndependentReactions(
  deps: IndependentDeps,
  credential: SpaceCredential,
  space: string,
  authorityDid: string,
  repos: ListRepos.Repo[],
  messages: IndependentMessage[],
  readWriter: <T>(did: string, run: () => Promise<T>) => Promise<T | null>,
): Promise<{ reactions: IndependentReaction[]; truncated: boolean }> {
  const knownMessages = new Set(messages.map((message) => message.uri));
  const reactions: IndependentReaction[] = [];
  const result = (truncated: boolean) => ({ reactions: reactions.sort((left, right) => left.uri.localeCompare(right.uri)), truncated });
  const seenRkeys = new Map<string, Set<string>>();
  let scanned = 0;
  let pageRequests = 0;
  for (const repo of repos) {
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    while (true) {
      if (pageRequests >= MAX_CHANNEL_REACTION_PAGES) throw new Error("Channel reaction pagination exceeded the bounded page request limit.");
      pageRequests += 1;
      if (cursor) seenCursors.add(cursor);
      const remaining = MAX_CHANNEL_REACTION_RECORDS - scanned;
      const limit = Math.min(100, remaining > 0 ? remaining + 1 : 1);
      const page = await readWriter(repo.did, async () => {
        const read = await credential.client(await deps.resolvePds(repo.did)).query<ListRecords.OutputSchema>("com.atproto.space.listRecords", {
          space, repo: repo.did, collection: COLLECTION.reaction, cursor, limit,
        });
        assertBoundedRecordPage(read, { collection: COLLECTION.reaction, limit, cursor, seenCursors });
        return read;
      });
      if (!page) break;
      const overflow = page.records.length > remaining;
      const rows = overflow ? page.records.slice(0, remaining) : page.records;
      const repoRkeys = seenRkeys.get(repo.did) ?? new Set<string>();
      seenRkeys.set(repo.did, repoRkeys);
      for (const record of rows) {
        if (!record.value) throw new Error("PDS record page contains a malformed reaction.");
        if (repoRkeys.has(record.rkey)) throw new Error("PDS reaction pagination returned a duplicate record key.");
        repoRkeys.add(record.rkey);
        const uri = spaceRecordUri(space, repo.did, COLLECTION.reaction, record.rkey);
        if (typeof record.value.subject !== "string" || !knownMessages.has(record.value.subject)) continue;
        if (!validateSpaceRecord(COLLECTION.reaction, record.value, {
          authorityDid, spaceUri: space, repoDid: repo.did, rkey: record.rkey, knownMessages,
        }).valid) continue;
        reactions.push({ uri, rkey: record.rkey, repo: repo.did, value: record.value });
      }
      scanned += rows.length;
      if (overflow) return result(true);
      cursor = page.cursor ?? undefined;
      if (!cursor) break;
    }
  }
  return result(false);
}
