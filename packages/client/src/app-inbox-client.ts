import { isMissingXrpcResource } from "@flock/protocol/atproto/xrpc";
import { appInboxUri, channelUri, isDid, isSkey, isTid, parseWorkspaceUri, spaceRecordUri, tidNow } from "@flock/protocol/keys";
import { isTakendown } from "@flock/protocol/moderation";
import { COLLECTION } from "@flock/protocol/nsids";
import { validateSpaceRecord } from "@flock/protocol/registry";
import type { ChannelRef } from "./channel-client";
import { decodeCursor, encodeCursor } from "./merge";
import type { ListedWriter } from "./store";
import type { SetAside, SyncCore } from "./sync";
import { transportNow, type ClientTransport } from "./transport";

export const INBOX_PAGE = 100;

export type AppInboxCollection = typeof COLLECTION.appCommand | typeof COLLECTION.appAction;

export type AppInboxRecord = {
  uri: string;
  repo: string;
  rkey: string;
  collection: AppInboxCollection;
  value: Record<string, unknown>;
};

export type AppInboxPage = {
  records: AppInboxRecord[];
  next?: string;
  complete: boolean;
  setAside: SetAside[];
};

export type AppInboxClientDeps = {
  transport: ClientTransport;
  sync: SyncCore;
};

/**
 * App inboxes: a member writes and retracts commands and block-action clicks directly in their own repo (without minting a
 * space credential or touching the local store, as `requestJoin` does), and the installed app syncs its inbox through `SyncCore`.
 */
export class AppInboxClient {
  constructor(private readonly deps: AppInboxClientDeps) {}

  async sendCommand(ref: ChannelRef, appDid: string, command: string, text: string, parent?: string): Promise<{ uri: string; rkey: string }> {
    const { authorityDid, inbox, channel } = this.target(ref, appDid);
    const now = transportNow(this.deps.transport);
    const rkey = tidNow(now);
    const record: Record<string, unknown> = {
      $type: COLLECTION.appCommand,
      command,
      text,
      channel,
      ...(parent === undefined ? {} : { parent }),
      createdAt: new Date(now).toISOString(),
    };
    const validation = validateSpaceRecord(COLLECTION.appCommand, record, {
      authorityDid,
      spaceUri: inbox,
      repoDid: this.deps.transport.did,
      rkey,
    });
    if (!validation.valid) throw new Error(validation.reason);
    await this.deps.transport.memberClient.procedure("com.atproto.space.createRecord", {
      space: inbox,
      repo: this.deps.transport.did,
      collection: COLLECTION.appCommand,
      rkey,
      record,
    });
    return { uri: spaceRecordUri(inbox, this.deps.transport.did, COLLECTION.appCommand, rkey), rkey };
  }

  async retractCommand(workspace: string, appDid: string, rkey: string): Promise<void> {
    await this.retract(workspace, appDid, COLLECTION.appCommand, rkey);
  }

  async sendAction(ref: ChannelRef, appDid: string, message: string, actionId: string): Promise<{ uri: string; rkey: string }> {
    const { authorityDid, inbox, channel } = this.target(ref, appDid);
    const now = transportNow(this.deps.transport);
    const rkey = tidNow(now);
    const record: Record<string, unknown> = {
      $type: COLLECTION.appAction,
      message,
      actionId,
      channel,
      createdAt: new Date(now).toISOString(),
    };
    const validation = validateSpaceRecord(COLLECTION.appAction, record, {
      authorityDid,
      spaceUri: inbox,
      repoDid: this.deps.transport.did,
      rkey,
    });
    if (!validation.valid) throw new Error(validation.reason);
    await this.deps.transport.memberClient.procedure("com.atproto.space.createRecord", {
      space: inbox,
      repo: this.deps.transport.did,
      collection: COLLECTION.appAction,
      rkey,
      record,
    });
    return { uri: spaceRecordUri(inbox, this.deps.transport.did, COLLECTION.appAction, rkey), rkey };
  }

  async retractAction(workspace: string, appDid: string, rkey: string): Promise<void> {
    await this.retract(workspace, appDid, COLLECTION.appAction, rkey);
  }

  async writers(workspace: string, appDid: string): Promise<ListedWriter[]> {
    const { inbox } = this.inboxOf(workspace, appDid);
    return this.deps.sync.writers(inbox, { workspace });
  }

  async readPage(
    workspace: string,
    appDid: string,
    collection: AppInboxCollection,
    options: { before?: string; limit?: number; writers?: readonly ListedWriter[] } = {},
  ): Promise<AppInboxPage> {
    if (collection !== COLLECTION.appCommand && collection !== COLLECTION.appAction) {
      throw new TypeError("App inbox reads only command or action collections.");
    }
    const { authorityDid, inbox } = this.inboxOf(workspace, appDid);
    const limit = options.limit ?? INBOX_PAGE;
    const writers = options.writers ?? await this.deps.sync.writers(inbox, { workspace });
    const listedWriters = new Set(writers.map((writer) => writer.did));
    const [inboxLabels, accountLabels] = await Promise.all([
      this.deps.sync.syncSpaceActiveLabels(inbox, { workspace, listedWriters }),
      this.deps.sync.syncAccountLabels(authorityDid),
    ]);
    const sources = writers.map((writer) => ({ space: inbox, repo: writer.did }));
    const result = await this.deps.sync.read({
      sources,
      window: collection,
      limit,
      before: decodeCursor(options.before),
      select: async (candidates, count) =>
        candidates
          .filter(
            (record) =>
              !isTakendown(accountLabels, record.repo) &&
              !isTakendown(inboxLabels, record.uri, record.cid || undefined) &&
              validateSpaceRecord(collection, record.value, {
                authorityDid,
                spaceUri: inbox,
                repoDid: record.repo,
                rkey: record.rkey,
              }).valid,
          )
          .slice(0, count),
    });
    return {
      records: result.items.map((record) => ({
        uri: record.uri,
        repo: record.repo,
        rkey: record.rkey,
        collection,
        value: record.value,
      })),
      ...(result.next ? { next: encodeCursor(result.next) } : {}),
      complete: result.complete,
      setAside: result.setAside,
    };
  }

  private target(ref: ChannelRef, appDid: string): { authorityDid: string; inbox: string; channel: string } {
    if (!isSkey(ref.skey)) throw new Error("Invalid workspace or channel reference.");
    const { authorityDid, inbox } = this.inboxOf(ref.workspace, appDid);
    return { authorityDid, inbox, channel: channelUri(authorityDid, ref.skey) };
  }

  private inboxOf(workspace: string, appDid: string): { authorityDid: string; inbox: string } {
    const parsed = parseWorkspaceUri(workspace);
    if (!parsed) throw new Error("Invalid workspace or channel reference.");
    if (!isDid(appDid)) throw new TypeError("An app is named by its DID.");
    return { authorityDid: parsed.authorityDid, inbox: appInboxUri(parsed.authorityDid, parsed.skey, appDid) };
  }

  private async retract(workspace: string, appDid: string, collection: AppInboxCollection, rkey: string): Promise<void> {
    if (!isTid(rkey)) throw new Error("Record key must be a TID.");
    const { inbox } = this.inboxOf(workspace, appDid);
    try {
      await this.deps.transport.memberClient.procedure("com.atproto.space.deleteRecord", {
        space: inbox,
        repo: this.deps.transport.did,
        collection,
        rkey,
      });
    } catch (error) {
      if (!isMissingXrpcResource(error)) throw error;
    }
  }
}
