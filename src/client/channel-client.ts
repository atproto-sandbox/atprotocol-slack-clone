import { listBoundedRecords } from "@/atproto/record-pages";
import { MAX_LISTED_SET_ASIDE } from "@/atproto/repo-failure";
import { selectValidChannelMessages } from "@/atproto/valid-channel-messages";
import { isMissingXrpcResource } from "@/atproto/xrpc";
import { channelUri, inboxUri, isSkey, parseSpaceRecordUri, parseWorkspaceUri, reactionRecordKey, requestRecordKey, spaceRecordUri, tidNow } from "@/protocol/keys";
import { COLLECTION } from "@/protocol/nsids";
import { validateSpaceRecord } from "@/protocol/registry";
import { WorkspaceEnvelopeError } from "@/protocol/workspace-summary";
import type { CredentialCache } from "./credentials";
import { ChannelUnavailableError } from "./errors";
import type { Lifecycle } from "./lifecycle";
import { decodeCursor, encodeCursor } from "./merge";
import type { StoredRecord } from "./store";
import type { SetAside, SyncCore } from "./sync";
import { transportNow, type ClientTransport } from "./transport";

const PAGE = 100;
const MAX_SUPPORTED_MEMBERS = 200;
const MAX_PRIVATE_ROSTER_SCAN = 1_000;

export type ChannelRef = { workspace: string; skey: string };
export type Visibility = "public" | "private" | "transitioning" | "archived";

export type ChannelMessage = { uri: string; repo: string; rkey: string; value: Record<string, unknown> };
export type ChannelReaction = { uri: string; repo: string; rkey: string; value: Record<string, unknown> };

export type ChannelPage = {
  messages: ChannelMessage[];
  /** The reactions held on the page's messages. */
  reactions: ChannelReaction[];
  /** Pass back as `before` for the next older page; absent when nothing older exists. */
  next?: string;
  /** Every listed writer not set aside holds the page as one checked state, and no bound cut it short. */
  complete: boolean;
  setAside: SetAside[];
  degradedReasons: string[];
};

export type ChannelClientDeps = { transport: ClientTransport; credentials: CredentialCache; sync: SyncCore; lifecycle: Lifecycle };

/** The member's view of channels: reading pages, writing own messages and reactions, and asking to join private channels. */
export class ChannelClient {
  constructor(private readonly deps: ChannelClientDeps) {}

  /** The channel's directory entry, verified at the authority's host. A missing or invalid entry, or an archived one, drops the channel. */
  async directory(ref: ChannelRef): Promise<{ authorityDid: string; space: string; visibility: Visibility }> {
    const workspace = parseWorkspaceUri(ref.workspace);
    if (!workspace || !isSkey(ref.skey)) throw new Error("Invalid workspace or channel reference.");
    const { authorityDid } = workspace;
    const space = channelUri(authorityDid, ref.skey);
    const client = await this.deps.credentials.clientFor(ref.workspace, authorityDid);
    let value: Record<string, unknown> | null;
    try {
      value = (await client.query<{ value: Record<string, unknown> }>("com.atproto.space.getRecord", {
        space: ref.workspace, repo: authorityDid, collection: COLLECTION.directory, rkey: ref.skey,
      })).value;
    } catch (error) {
      if (!isMissingXrpcResource(error)) throw error;
      value = null;
    }
    if (!value || !validateSpaceRecord(COLLECTION.directory, value, { authorityDid, spaceUri: ref.workspace, repoDid: authorityDid, rkey: ref.skey }).valid) {
      await this.deps.lifecycle.dropSpace(space);
      throw new Error("Channel directory record is missing or invalid.");
    }
    const visibility = value.visibility as Visibility;
    if (visibility === "archived") await this.deps.lifecycle.dropSpace(space);
    return { authorityDid, space, visibility };
  }

  /** A channel that can be read and written now: neither transitioning nor archived. */
  async readable(ref: ChannelRef): Promise<{ authorityDid: string; space: string; visibility: "public" | "private" }> {
    const current = await this.directory(ref);
    if (current.visibility === "transitioning") throw new ChannelUnavailableError("Channel is transitioning; syncing and writes are temporarily paused.", "transitioning");
    if (current.visibility === "archived") throw new ChannelUnavailableError("Archived channels are unavailable for new sync.", "archived");
    return { ...current, visibility: current.visibility };
  }

  async readPage(ref: ChannelRef, options: { before?: string; limit?: number } = {}): Promise<ChannelPage> {
    const limit = options.limit ?? PAGE;
    const { authorityDid, space } = await this.readable(ref);
    const writers = await this.deps.sync.writers(space, { workspace: ref.workspace });
    const sources = writers.map((writer) => ({ space, repo: writer.did }));
    const parentReads = new Map<string, Promise<{ uri: string; value: Record<string, unknown> } | null>>();
    const result = await this.deps.sync.read({
      sources,
      window: COLLECTION.message,
      alongside: [COLLECTION.reaction],
      limit,
      before: decodeCursor(options.before),
      select: async (candidates, count) => {
        const byUri = new Map(candidates.map((record) => [record.uri, record]));
        const selected = await selectValidChannelMessages(candidates.map(messageOf), {
          authorityDid, spaceUri: space, limit: count,
          getParent: (repo, rkey) => this.parent(space, repo, rkey, byUri, parentReads),
        });
        return selected.messages.map((message) => byUri.get(message.uri)!);
      },
    });
    const messages = result.items.map(messageOf);
    const knownMessages = new Set(messages.map((message) => message.uri));
    const listed = new Set(sources.filter((source) => !result.setAside.some((aside) => aside.permanent && aside.did === source.repo)).map((source) => source.repo));
    const reactions = (await this.deps.sync.store.records(space, COLLECTION.reaction))
      .filter((record) => listed.has(record.repo) && typeof record.value.subject === "string" && knownMessages.has(record.value.subject) && validateSpaceRecord(COLLECTION.reaction, record.value, {
        authorityDid, spaceUri: space, repoDid: record.repo, rkey: record.rkey, knownMessages,
      }).valid)
      .map(messageOf)
      .sort((left, right) => (left.uri < right.uri ? -1 : left.uri > right.uri ? 1 : 0));
    return {
      messages,
      reactions,
      ...(result.next ? { next: encodeCursor(result.next) } : {}),
      complete: result.complete,
      setAside: result.setAside,
      degradedReasons: degradedReasons(result, this.deps.sync.options.maxRecordsPerCollection),
    };
  }

  async send(ref: ChannelRef, text: string, parent?: string): Promise<{ uri: string; rkey: string }> {
    const { authorityDid, space } = await this.readable(ref);
    const credential = await this.deps.credentials.fresh(space);
    const rkey = tidNow(transportNow(this.deps.transport));
    const record: Record<string, unknown> = { $type: COLLECTION.message, text, createdAt: new Date(transportNow(this.deps.transport)).toISOString() };
    const known = new Set<string>();
    if (parent !== undefined) {
      await this.requireTopLevel(space, parent, credential);
      known.add(parent);
      record.parent = parent;
    }
    const validation = validateSpaceRecord(COLLECTION.message, record, { authorityDid, spaceUri: space, repoDid: this.deps.transport.did, rkey, knownMessages: known, knownTopLevelMessages: known });
    if (!validation.valid) throw new Error(validation.reason);
    const result = await this.deps.transport.memberClient.procedure<unknown, { uri: string; cid: string }>("com.atproto.space.createRecord", {
      space, repo: this.deps.transport.did, collection: COLLECTION.message, rkey, record,
    });
    await this.applyOwn(ref, space, COLLECTION.message, rkey, result.cid, record);
    return { uri: spaceRecordUri(space, this.deps.transport.did, COLLECTION.message, rkey), rkey };
  }

  /** Edits an own message: the fields it already had, another app's included, are written back with the new text. */
  async edit(ref: ChannelRef, uri: string, text: string): Promise<void> {
    const { authorityDid, space } = await this.readable(ref);
    const target = this.ownMessage(space, uri);
    const credential = await this.deps.credentials.fresh(space);
    const prior = await this.verifiedRecord(credential, space, target.repo, COLLECTION.message, target.rkey);
    if (!prior) throw new Error("Message was not found in this channel.");
    const record: Record<string, unknown> = { ...prior.value, text };
    const known = new Set<string>();
    if (typeof record.parent === "string") {
      await this.requireTopLevel(space, record.parent, credential);
      known.add(record.parent);
    }
    const validation = validateSpaceRecord(COLLECTION.message, record, { authorityDid, spaceUri: space, repoDid: target.repo, rkey: target.rkey, knownMessages: known, knownTopLevelMessages: known });
    if (!validation.valid) throw new Error(validation.reason);
    const result = await this.deps.transport.memberClient.procedure<unknown, { uri: string; cid: string }>("com.atproto.space.putRecord", {
      space, repo: target.repo, collection: COLLECTION.message, rkey: target.rkey, record,
    });
    await this.applyOwn(ref, space, COLLECTION.message, target.rkey, result.cid, record);
  }

  async delete(ref: ChannelRef, uri: string): Promise<void> {
    const { space } = await this.readable(ref);
    const target = this.ownMessage(space, uri);
    await this.deps.credentials.fresh(space);
    await this.deps.transport.memberClient.procedure("com.atproto.space.deleteRecord", { space, repo: target.repo, collection: COLLECTION.message, rkey: target.rkey });
    await this.deps.sync.applyOwnWrite({ space, repo: target.repo }, { remove: [{ collection: COLLECTION.message, rkey: target.rkey }] }, { workspace: ref.workspace });
  }

  /** Reacts to a message that exists in this channel, under the key derived from it, the emoji and the reactor. */
  async react(ref: ChannelRef, subject: string, emoji: string): Promise<{ rkey: string }> {
    const { authorityDid, space } = await this.readable(ref);
    const target = parseSpaceRecordUri(subject, space, COLLECTION.message);
    if (!target) throw new Error("Invalid message URI.");
    const credential = await this.deps.credentials.fresh(space);
    if (!(await this.verifiedRecord(credential, space, target.repo, COLLECTION.message, target.rkey))) throw new Error("Message was not found in this channel.");
    const rkey = reactionRecordKey(subject, emoji, this.deps.transport.did);
    const record = { $type: COLLECTION.reaction, subject, emoji, createdAt: new Date(transportNow(this.deps.transport)).toISOString() };
    const validation = validateSpaceRecord(COLLECTION.reaction, record, { authorityDid, spaceUri: space, repoDid: this.deps.transport.did, rkey, knownMessages: new Set([subject]) });
    if (!validation.valid) throw new Error(validation.reason);
    const result = await this.deps.transport.memberClient.procedure<unknown, { uri: string; cid: string }>("com.atproto.space.putRecord", {
      space, repo: this.deps.transport.did, collection: COLLECTION.reaction, rkey, record,
    });
    await this.applyOwn(ref, space, COLLECTION.reaction, rkey, result.cid, record);
    return { rkey };
  }

  /** Removes the reaction; one that is already gone is not an error. */
  async unreact(ref: ChannelRef, subject: string, emoji: string): Promise<void> {
    const { space } = await this.readable(ref);
    if (!parseSpaceRecordUri(subject, space, COLLECTION.message)) throw new Error("Invalid message URI.");
    await this.deps.credentials.fresh(space);
    const rkey = reactionRecordKey(subject, emoji, this.deps.transport.did);
    try {
      await this.deps.transport.memberClient.procedure("com.atproto.space.deleteRecord", { space, repo: this.deps.transport.did, collection: COLLECTION.reaction, rkey });
    } catch (error) {
      if (!isMissingXrpcResource(error)) throw error;
    }
    await this.deps.sync.applyOwnWrite({ space, repo: this.deps.transport.did }, { remove: [{ collection: COLLECTION.reaction, rkey }] }, { workspace: ref.workspace });
  }

  /** Asks to join a private channel: a request in the workspace inbox under the derived key, with a new request id each time. */
  async requestJoin(ref: ChannelRef): Promise<{ uri: string; requestId: string }> {
    const { authorityDid, visibility } = await this.directory(ref);
    if (visibility !== "private") throw new Error("Join requests are only used for private channels.");
    const workspace = parseWorkspaceUri(ref.workspace)!;
    const inbox = inboxUri(authorityDid, workspace.skey);
    const rkey = requestRecordKey(channelUri(authorityDid, ref.skey), this.deps.transport.did);
    const record = { $type: COLLECTION.joinRequest, channelSkey: ref.skey, requestId: tidNow(transportNow(this.deps.transport)), createdAt: new Date(transportNow(this.deps.transport)).toISOString() };
    const validation = validateSpaceRecord(COLLECTION.joinRequest, record, { authorityDid, spaceUri: inbox, repoDid: this.deps.transport.did, rkey });
    if (!validation.valid) throw new Error(validation.reason);
    const result = await this.deps.transport.memberClient.procedure<unknown, { uri: string }>("com.atproto.space.putRecord", {
      space: inbox, repo: this.deps.transport.did, collection: COLLECTION.joinRequest, rkey, record,
    });
    return { uri: result.uri, requestId: record.requestId };
  }

  /** Withdraws a join request, whatever the channel's visibility now; one that is already gone is not an error. */
  async withdrawJoin(ref: ChannelRef): Promise<void> {
    const workspace = parseWorkspaceUri(ref.workspace);
    if (!workspace || !isSkey(ref.skey)) throw new Error("Invalid workspace or channel reference.");
    const rkey = requestRecordKey(channelUri(workspace.authorityDid, ref.skey), this.deps.transport.did);
    try {
      await this.deps.transport.memberClient.procedure("com.atproto.space.deleteRecord", {
        space: inboxUri(workspace.authorityDid, workspace.skey), repo: this.deps.transport.did, collection: COLLECTION.joinRequest, rkey,
      });
    } catch (error) {
      if (!isMissingXrpcResource(error)) throw error;
    }
  }

  /** The members of a private channel, from the authority's roster; a public channel has no roster. */
  async roster(ref: ChannelRef): Promise<string[]> {
    const { authorityDid, space, visibility } = await this.readable(ref);
    if (visibility !== "private") return [];
    const client = await this.deps.credentials.clientFor(space, authorityDid);
    const roster = await listBoundedRecords(client, { space, repo: authorityDid, collection: COLLECTION.channelRoster, maxRecords: MAX_PRIVATE_ROSTER_SCAN });
    const members = new Set(roster.records.flatMap((record) => validateSpaceRecord(COLLECTION.channelRoster, record.value, {
      authorityDid, spaceUri: space, repoDid: authorityDid, rkey: record.rkey,
    }).valid && record.value.active === true && typeof record.value.subject === "string" ? [record.value.subject] : []));
    if (roster.truncated) throw new WorkspaceEnvelopeError(`Private-channel roster exceeds the ${MAX_PRIVATE_ROSTER_SCAN}-record scan limit; the roster may be incomplete.`);
    if (members.size > MAX_SUPPORTED_MEMBERS) throw new WorkspaceEnvelopeError(`Private-channel roster exceeds ${MAX_SUPPORTED_MEMBERS} members.`);
    return [...members].sort();
  }

  private ownMessage(space: string, uri: string): { repo: string; rkey: string } {
    const target = parseSpaceRecordUri(uri, space, COLLECTION.message);
    if (!target || target.repo !== this.deps.transport.did) throw new Error("You can change only your own messages.");
    return target;
  }

  /** A reply's target must be a top-level message in this channel, read with a verified MAC. */
  private async requireTopLevel(space: string, parent: string, credential: Awaited<ReturnType<CredentialCache["get"]>>): Promise<void> {
    const target = parseSpaceRecordUri(parent, space, COLLECTION.message);
    const record = target ? await this.verifiedRecord(credential, space, target.repo, COLLECTION.message, target.rkey) : null;
    if (!record || record.value.parent !== undefined) throw new Error("Reply target must be a top-level message in this channel.");
  }

  private async verifiedRecord(
    credential: Awaited<ReturnType<CredentialCache["get"]>>,
    space: string,
    repo: string,
    collection: string,
    rkey: string,
  ): Promise<{ uri: string; value: Record<string, unknown> } | null> {
    try {
      const client = credential.client(await this.deps.transport.resolvePds(repo));
      const record = await client.query<{ uri: string; value: Record<string, unknown> }>("com.atproto.space.getRecord", { space, repo, collection, rkey });
      return record.uri === spaceRecordUri(space, repo, collection, rkey) ? record : null;
    } catch (error) {
      if (isMissingXrpcResource(error)) return null;
      throw error;
    }
  }

  /** A reply's parent: held if it is, otherwise read once per page with a verified MAC. */
  private parent(
    space: string,
    repo: string,
    rkey: string,
    held: ReadonlyMap<string, StoredRecord>,
    reads: Map<string, Promise<{ uri: string; value: Record<string, unknown> } | null>>,
  ): Promise<{ uri: string; value: Record<string, unknown> } | null> {
    const uri = spaceRecordUri(space, repo, COLLECTION.message, rkey);
    const local = held.get(uri);
    if (local) return Promise.resolve({ uri, value: local.value });
    let read = reads.get(uri);
    if (!read) {
      read = this.deps.credentials.get(space).then((credential) => this.verifiedRecord(credential, space, repo, COLLECTION.message, rkey));
      reads.set(uri, read);
    }
    return read;
  }

  private async applyOwn(ref: ChannelRef, space: string, collection: string, rkey: string, cid: string, value: Record<string, unknown>): Promise<void> {
    const repo = this.deps.transport.did;
    await this.deps.sync.applyOwnWrite({ space, repo }, {
      upsert: [{ space, repo, collection, rkey, uri: spaceRecordUri(space, repo, collection, rkey), cid: cid ?? "", value }],
    }, { workspace: ref.workspace });
  }
}

function messageOf(record: StoredRecord): ChannelMessage {
  return { uri: record.uri, repo: record.repo, rkey: record.rkey, value: record.value };
}

/** What a page tells its reader about what may be missing: writers set aside, partly read or changing, and bounds reached. */
function degradedReasons(result: { setAside: SetAside[]; partial: SetAside[]; changing: string[]; cut: string[] }, bound: number): string[] {
  const reasons = result.setAside.slice(0, MAX_LISTED_SET_ASIDE).map(({ did, reason }) => `Messages from ${did} may be missing or out of date: ${reason}`);
  if (result.setAside.length > MAX_LISTED_SET_ASIDE) reasons.push(`${result.setAside.length - MAX_LISTED_SET_ASIDE} more writers' messages may be missing or out of date.`);
  for (const { did, reason } of result.partial.slice(0, MAX_LISTED_SET_ASIDE)) reasons.push(`Reactions from ${did} may be missing: ${reason}`);
  for (const did of result.changing) reasons.push(`Messages from ${did} are changing and may be out of date.`);
  if (result.cut.includes(COLLECTION.message)) reasons.push(`Message history exceeds the ${bound}-record channel sync limit.`);
  if (result.cut.includes(COLLECTION.reaction)) reasons.push(`Reaction history exceeds the ${bound}-record channel sync limit.`);
  return reasons;
}
