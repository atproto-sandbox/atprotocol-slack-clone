"use client";

import { useState, type FormEvent } from "react";
import { messageOf, splitDids, threadMessages, TRANSITIONING_STATUS, type ChannelSelection, type Grant, type Message, type RunOperation } from "./client-api";
import type { WorkspaceSummary } from "@/workspaces/read-model";

type ChannelViewProps = {
  did: string;
  activeChannel: ChannelSelection;
  activeWorkspace: WorkspaceSummary | null;
  busy: boolean;
  workspaceDegraded: boolean;
  needOperatorLeave: boolean;
  needChannelRead: boolean;
  needChannelWrite: boolean;
  needJoinWrite: boolean;
  requestSubmitted: boolean;
  privateRoster: string[];
  messages: Message[];
  hasMore: boolean;
  nextOffset: number;
  messageText: string;
  setMessageText: (value: string) => void;
  replyTo: string;
  setReplyTo: (value: string) => void;
  loadMessages: (channel: ChannelSelection, offset?: number, append?: boolean) => Promise<boolean>;
  runOperation: RunOperation;
  grant: Grant;
  leaveChannel: () => Promise<void>;
  requestPrivateAccess: (withdraw?: boolean) => Promise<void>;
  authorizeCurrentChannel: (action: string) => Promise<void>;
  sendMessage: (event: FormEvent) => Promise<void>;
  toggleReaction: (subject: string, emoji: string, active: boolean) => Promise<void>;
  editMessage: (message: Message) => Promise<void>;
  deleteMessage: (uri: string) => Promise<void>;
  setError: (message: string) => void;
};

export function ChannelView(props: ChannelViewProps) {
  const { did, activeChannel, activeWorkspace, busy, workspaceDegraded, needOperatorLeave, needChannelRead, needChannelWrite, needJoinWrite, requestSubmitted, privateRoster, messages, hasMore, nextOffset, messageText, setMessageText, replyTo, setReplyTo } = props;
  const { loadMessages, runOperation, grant, leaveChannel, requestPrivateAccess, authorizeCurrentChannel, sendMessage, toggleReaction, editMessage, deleteMessage, setError } = props;
  const [transitionMembers, setTransitionMembers] = useState("");

  return <>
    <div className="section-heading"><div><span className="eyebrow">{activeChannel.visibility === "transitioning" ? "CHANNEL TRANSITION" : activeChannel.visibility === "private" ? "PRIVATE CHANNEL" : "PUBLIC CHANNEL"}</span><h2>{activeChannel.visibility === "private" ? "▣" : "#"} {activeChannel.name}</h2></div><div><button className="text-button" disabled={activeChannel.visibility === "transitioning"} onClick={() => void loadMessages(activeChannel).catch((caught) => setError(messageOf(caught)))}>Sync ↻</button>{activeWorkspace?.isAdmin && activeChannel.visibility !== "transitioning" && <><button className="text-button" disabled={workspaceDegraded} onClick={() => { const members = splitDids(transitionMembers); void runOperation({ kind: "transitionChannel", skey: activeChannel.skey, visibility: activeChannel.visibility === "public" ? "private" : "public", ...(activeChannel.visibility === "public" ? { members: members.length ? members : activeWorkspace.members.map((member) => member.did) } : {}) }); }}>{activeChannel.visibility === "public" ? "Make private" : "Make public"}</button><button className="text-button danger" disabled={workspaceDegraded} onClick={() => void runOperation({ kind: "archiveChannel", skey: activeChannel.skey })}>Archive</button></>}</div></div>
    {activeChannel.visibility === "transitioning" && <p className="status-note">{TRANSITIONING_STATUS}</p>}
    {activeChannel.visibility === "private" && privateRoster.length > 0 && <div className="starter-card private-roster"><strong>Active private channel members</strong><p>{privateRoster.join(" · ")}</p></div>}
    {activeWorkspace?.isAdmin && <label className="transition-members">Selected members when making this channel private<input value={transitionMembers} onChange={(event) => setTransitionMembers(event.target.value)} placeholder="DIDs separated by spaces or commas (blank keeps all)" /></label>}
    {activeChannel.visibility === "private" && privateRoster.includes(did) && did !== activeWorkspace?.authorityDid && <div className="channel-lifecycle"><button className="text-button danger" disabled={busy || workspaceDegraded} onClick={() => void leaveChannel()}>Leave private channel</button>{needOperatorLeave && <button className="text-button" disabled={workspaceDegraded} onClick={() => void grant("operatorLeave", activeChannel.workspace)}>Authorize leave control →</button>}</div>}
    {activeChannel.visibility === "private" && !privateRoster.includes(did) && <div className="starter-card permission-box"><p>You are not on this channel’s active roster.</p><button className="text-button" onClick={() => void requestPrivateAccess()}>{requestSubmitted ? "Update request →" : "Request private access →"}</button><button className="text-button danger" onClick={() => void requestPrivateAccess(true)}>Withdraw request</button></div>}
    {needChannelRead && <div className="starter-card permission-box"><p>Grant workspace/channel read scope. A private-channel PDS membership check still applies.</p><button className="text-button" onClick={() => void authorizeCurrentChannel("channelRead")}>Grant channel read →</button>{activeChannel.visibility === "private" && <button className="text-button" onClick={() => void requestPrivateAccess()}>Request private access →</button>}</div>}
    {needJoinWrite && <div className="starter-card permission-box"><p>Grant write-only inbox access to submit a private-channel request.</p><button className="text-button" onClick={() => void authorizeCurrentChannel("requestJoin")}>Grant request access →</button></div>}
    {needChannelWrite && <div className="starter-card permission-box"><p>Grant message/reaction write access for this channel.</p><button className="text-button" onClick={() => void authorizeCurrentChannel("channelWrite")}>Grant message posting →</button></div>}
    <div className="message-list">{threadMessages(messages).map(({ message, isReply }) => <article className={isReply ? "message-card reply-card" : "message-card"} key={message.uri}><div className="message-meta"><strong>{message.repo.slice(0, 20)}…</strong><time>{message.value.createdAt}</time></div><p>{message.value.text}</p>{message.value.parent && <small>Reply to {message.value.parent}</small>}<div className="message-actions"><button onClick={() => setReplyTo(message.uri)}>Reply</button>{(message.reactions ?? []).map((reaction) => <button className={reaction.active ? "reaction-active" : ""} key={reaction.emoji} onClick={() => void toggleReaction(message.uri, reaction.emoji, reaction.active)}>{reaction.emoji} {reaction.count}</button>)}{!(message.reactions ?? []).some((reaction) => reaction.emoji === "💜") && <button onClick={() => void toggleReaction(message.uri, "💜", false)}>💜 0</button>}{message.repo === did && <><button onClick={() => void editMessage(message)}>Edit</button><button onClick={() => void deleteMessage(message.uri)}>Delete</button></>}</div></article>)}</div>
    {hasMore && <button className="text-button load-older" onClick={() => void loadMessages(activeChannel, nextOffset, true).catch((caught) => setError(messageOf(caught)))}>Load older messages</button>}
    <form className="message-compose" onSubmit={sendMessage}>{replyTo && <p>Replying to {replyTo} <button type="button" onClick={() => setReplyTo("")}>Cancel</button></p>}<textarea disabled={activeChannel.visibility === "transitioning"} value={messageText} onChange={(event) => setMessageText(Array.from(event.target.value).slice(0, 10_000).join(""))} placeholder="Write a message…" required /><div><small>{Array.from(messageText).length}/10,000</small><button className="primary-button" disabled={busy || activeChannel.visibility === "transitioning"}>Send</button></div></form>
  </>;
}
