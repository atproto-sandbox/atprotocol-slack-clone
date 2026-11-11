"use client";

import { useCallback, useEffect } from "react";
import { CHANNEL_PAGE } from "@/client/channel-client";
import type { Engine } from "@/client/engine";
import type { LiveSpaces, Snapshot, Snapshots } from "@/client/views";
import { channelUri, parseWorkspaceUri } from "@/protocol/keys";
import { httpStatus, isAccessFailure, mergeMessages, messageOf, withReactions, type ChannelSelection, type Message, type Reaction } from "./client-api";
import { useLiveKey, useSnapshot } from "./use-live-view";

/**
 * What the open channel shows: its newest messages (and any older pages a person loaded), the cursor below them, its roster
 * when it is private, and what may be missing. `refused` is how the account's read was refused (a private channel it is not
 * on, access lost, a channel paused or archived); nothing of the channel is kept then.
 */
export type ChannelContent = {
  messages: Message[];
  next?: string;
  roster: string[] | null;
  degradedReasons: string[];
  refused?: { status: number | undefined; message: string };
};

/** The live view key of one open channel, as it is now: a channel whose visibility changed is another view, read afresh. */
export function channelKey(channel: { workspace: string; skey: string; visibility: string }): string {
  return `channel:${channel.workspace} ${channel.skey} ${channel.visibility}`;
}

type Session = { engine: Engine | null; live: LiveSpaces | null; snapshots: Snapshots | null };

/**
 * The open channel's content as a live view: loaded when the channel opens, whenever the change feed names it and every
 * minute, as many messages as are shown so a reload keeps older pages, and nothing while it is transitioning.
 */
export function useChannelContent(session: Session, did: string, selection: ChannelSelection | null): {
  content: Snapshot<ChannelContent>;
  loadOlder: () => Promise<void>;
  reload: () => Promise<void>;
} {
  const { engine, live, snapshots } = session;
  const workspace = selection?.workspace;
  const skey = selection?.skey;
  const visibility = selection?.visibility;
  const key = workspace && skey && visibility && visibility !== "transitioning" ? channelKey({ workspace, skey, visibility }) : null;
  const authorityDid = workspace ? parseWorkspaceUri(workspace)?.authorityDid : undefined;
  const space = authorityDid && skey ? channelUri(authorityDid, skey) : null;

  const load = useCallback(async (): Promise<ChannelContent> => {
    if (!engine || !snapshots || !key || !workspace || !skey) return { messages: [], roster: null, degradedReasons: [] };
    const ref = { workspace, skey };
    const shown = snapshots.get<ChannelContent>(key).value?.messages.length ?? 0;
    try {
      const page = await engine.channels.readPage(ref, { limit: Math.max(CHANNEL_PAGE, shown) });
      const roster = visibility === "private" ? await engine.channels.roster(ref) : null;
      return {
        messages: withReactions(page.messages as Array<Omit<Message, "reactions">>, page.reactions as Reaction[], did),
        next: page.next, roster, degradedReasons: page.degradedReasons,
      };
    } catch (error) {
      if (!isAccessFailure(error)) throw error;
      return { messages: [], roster: null, degradedReasons: [], refused: { status: httpStatus(error), message: messageOf(error) } };
    }
  }, [engine, snapshots, key, workspace, skey, visibility, did]);

  useLiveKey(session, key, space ? [space] : [], load);
  useEffect(() => {
    // Once a minute the open channel is read again, whatever the change feed said.
    if (!live || !key) return;
    const interval = window.setInterval(() => void live.reload(key), 60_000);
    return () => window.clearInterval(interval);
  }, [live, key]);
  const content = useSnapshot<ChannelContent>(snapshots, key);

  const loadOlder = useCallback(async () => {
    if (!engine || !snapshots || !key || !workspace || !skey || !snapshots.get<ChannelContent>(key).value?.next) return;
    // What is shown is read when this load runs, so a reload that ran first is kept.
    await snapshots.refresh(key, async () => {
      const current = snapshots.get<ChannelContent>(key).value;
      if (!current?.next) return current;
      const page = await engine.channels.readPage({ workspace, skey }, { before: current.next });
      const older = withReactions(page.messages as Array<Omit<Message, "reactions">>, page.reactions as Reaction[], did);
      return { ...current, messages: mergeMessages(current.messages, older, true), next: page.next };
    });
  }, [engine, snapshots, key, workspace, skey, did]);

  const reload = useCallback(() => (live && key ? live.reload(key) : Promise.resolve()), [live, key]);

  return { content, loadOlder, reload };
}
