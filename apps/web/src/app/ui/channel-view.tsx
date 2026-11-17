"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { BLOCK_TYPE } from "@flock/client/blocks";
import { messageOf, splitDids, threadMessages, TRANSITIONING_STATUS, type ChannelSelection, type Message, type RunOperation } from "./client-api";
import { channelCommandContext, matchingCommands, renderableBlocks, type WorkspaceDeclarations } from "./interactions";
import type { WorkspaceSummary } from "@flock/protocol/workspace-summary";
import type { Snapshot } from "@flock/client/views";
import type { ChannelContent } from "./use-channel-content";

type ChannelViewProps = {
  did: string;
  activeChannel: ChannelSelection;
  activeWorkspace: WorkspaceSummary | null;
  declarations: WorkspaceDeclarations;
  busy: boolean;
  workspaceDegraded: boolean;
  requestSubmitted: boolean;
  /** The open channel's live view. */
  content: Snapshot<ChannelContent>;
  loadOlder: () => Promise<void>;
  /** Reads the channel again now. */
  reload: () => Promise<void>;
  messageText: string;
  setMessageText: (value: string) => void;
  chosenCommandApp: string | null;
  setChosenCommandApp: (did: string | null) => void;
  composerStatus: string;
  pendingActions: ReadonlySet<string>;
  replyTo: string;
  setReplyTo: (value: string) => void;
  highlightedMessageUri?: string | null;
  onOpenPermalink?: (message: Message) => void;
  runOperation: RunOperation;
  leaveChannel: () => Promise<void>;
  requestPrivateAccess: (withdraw?: boolean) => Promise<void>;
  sendMessage: (event: FormEvent) => Promise<void>;
  sendAction: (message: Message, actionId: string) => Promise<void>;
  toggleReaction: (subject: string, emoji: string, active: boolean) => Promise<void>;
  editMessage: (message: Message) => Promise<void>;
  deleteMessage: (uri: string) => Promise<void>;
  setError: (message: string) => void;
};

export function ChannelView(props: ChannelViewProps) {
  const { did, activeChannel, activeWorkspace, declarations, busy, workspaceDegraded, requestSubmitted, content, loadOlder, reload } = props;
  const { messageText, setMessageText, chosenCommandApp, setChosenCommandApp, composerStatus, pendingActions, replyTo, setReplyTo, highlightedMessageUri = null, onOpenPermalink } = props;
  const { runOperation, leaveChannel, requestPrivateAccess, sendMessage, sendAction, toggleReaction, editMessage, deleteMessage, setError } = props;
  const [transitionMembers, setTransitionMembers] = useState("");
  const messages = useMemo(() => content.value?.messages ?? [], [content.value?.messages]);
  const privateRoster = content.value?.roster ?? [];

  useEffect(() => {
    if (!highlightedMessageUri) return;
    const match = [...document.querySelectorAll<HTMLElement>("[data-message-uri]")].find(
      (element) => element.dataset.messageUri === highlightedMessageUri,
    );
    match?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [highlightedMessageUri, messages]);
  // An installed app's messages are marked and may render blocks; a person's message shows its fallback text only.
  const appDids = new Set(activeWorkspace?.installs.map((install) => install.did) ?? []);
  // Busy while a read runs, and before the first one has answered; a channel in transition is not read.
  const reading = activeChannel.visibility !== "transitioning" && (content.loading || (content.value === undefined && content.error === undefined));
  const refused = content.value?.refused;
  const commandContext = channelCommandContext({
    workspace: activeWorkspace,
    channel: activeChannel,
    viewerDid: did,
    content: content.value,
    replyTo,
    declarations,
  });
  const pickerMatches = matchingCommands(messageText, commandContext);

  function handleTextChange(next: string) {
    const bounded = Array.from(next).slice(0, 10_000).join("");
    const prevToken = messageText.startsWith("/") && !messageText.startsWith("//") ? (messageText.slice(1).split(/\s+/)[0] ?? "") : "";
    const nextToken = bounded.startsWith("/") && !bounded.startsWith("//") ? (bounded.slice(1).split(/\s+/)[0] ?? "") : "";
    setMessageText(bounded);
    if (chosenCommandApp && (!nextToken || nextToken !== prevToken)) setChosenCommandApp(null);
  }

  function chooseCommand(commandName: string, appDid: string) {
    setChosenCommandApp(appDid);
    const token = messageText.startsWith("/") ? (messageText.slice(1).split(/\s+/)[0] ?? "") : "";
    if (token !== commandName) {
      setMessageText(`/${commandName} `);
    }
  }

  return <>
    <div className="section-heading"><div><span className="eyebrow">{activeChannel.visibility === "transitioning" ? "CHANNEL TRANSITION" : activeChannel.visibility === "private" ? "PRIVATE CHANNEL" : "PUBLIC CHANNEL"}</span><h2>{activeChannel.visibility === "private" ? "▣" : "#"} {activeChannel.name}</h2></div><div><button className="text-button" disabled={activeChannel.visibility === "transitioning"} onClick={() => void reload().catch((caught: unknown) => setError(messageOf(caught)))}>Sync ↻</button>{activeWorkspace?.isAdmin && activeChannel.visibility !== "transitioning" && <><button className="text-button" disabled={workspaceDegraded} onClick={() => { const members = splitDids(transitionMembers); void runOperation({ kind: "transitionChannel", skey: activeChannel.skey, visibility: activeChannel.visibility === "public" ? "private" : "public", ...(activeChannel.visibility === "public" ? { members: members.length ? members : activeWorkspace.members.map((member) => member.did) } : {}) }); }}>{activeChannel.visibility === "public" ? "Make private" : "Make public"}</button><button className="text-button danger" disabled={workspaceDegraded} onClick={() => void runOperation({ kind: "archiveChannel", skey: activeChannel.skey })}>Archive</button></>}</div></div>
    {activeChannel.visibility === "transitioning" && <p className="status-note">{TRANSITIONING_STATUS}</p>}
    {activeChannel.visibility === "private" && privateRoster.length > 0 && <div className="starter-card private-roster"><strong>Active private channel members</strong><p>{privateRoster.join(" · ")}</p></div>}
    {activeWorkspace?.isAdmin && <label className="transition-members">Selected members when making this channel private<input value={transitionMembers} onChange={(event) => setTransitionMembers(event.target.value)} placeholder="DIDs separated by spaces or commas (blank keeps all)" /></label>}
    {activeChannel.visibility === "private" && privateRoster.includes(did) && did !== activeWorkspace?.authorityDid && <div className="channel-lifecycle"><button className="text-button danger" disabled={busy || workspaceDegraded} onClick={() => void leaveChannel()}>Leave private channel</button></div>}
    {activeChannel.visibility === "private" && !reading && !privateRoster.includes(did) && <div className="starter-card permission-box"><p>You are not on this channel’s active roster.</p><button className="text-button" onClick={() => void requestPrivateAccess()}>{requestSubmitted ? "Update request →" : "Request private access →"}</button><button className="text-button danger" onClick={() => void requestPrivateAccess(true)}>Withdraw request</button></div>}
    {content.value?.degradedReasons.length ? <p className="status-note" role="status">{content.value.degradedReasons.join(" ")} Older records need operator review.</p> : null}
    {content.error !== undefined && <p className="form-error" role="alert">{messageOf(content.error)}</p>}
    {refused && activeChannel.visibility !== "private" && <p className="form-error" role="alert">{refused.message}</p>}
    {highlightedMessageUri && !reading && !content.error && !refused && !messages.some((entry) => entry.uri === highlightedMessageUri) && (
      <p className="status-note" role="status">
        {content.value?.next !== undefined ? "Loading linked message…" : "The linked message was not found in this channel."}
      </p>
    )}
    <div className="message-list" aria-busy={reading}>{threadMessages(messages).map(({ message, isReply }) => {
      const blocks = renderableBlocks(message, appDids);
      const isHighlighted = highlightedMessageUri === message.uri;
      return (
        <article
          className={`${isReply ? "message-card reply-card" : "message-card"}${isHighlighted ? " highlighted-message" : ""}`}
          key={message.uri}
          data-message-uri={message.uri}
          data-highlighted={isHighlighted ? "true" : undefined}
        >
          <div className="message-meta"><strong>{message.repo.slice(0, 20)}…</strong>{appDids.has(message.repo) && <span className="eyebrow app-marker">APP</span>}<time>{message.value.createdAt}</time></div>
          {blocks ? (
            <div className="message-blocks">
              {blocks.map((block, index) => {
                if (block.$type === BLOCK_TYPE.section) return <p className="block-section" key={index}>{block.text}</p>;
                if (block.$type === BLOCK_TYPE.context) return <div className="block-context" key={index}>{block.elements.map((item, itemIndex) => <span key={itemIndex}>{item}</span>)}</div>;
                if (block.$type === BLOCK_TYPE.divider) return <hr className="block-divider" key={index} />;
                return (
                  <div className="block-actions" key={index}>
                    {block.elements.map((btn) => {
                      const actionKey = `${message.uri} ${btn.actionId}`;
                      const buttonClass = btn.style === "primary" ? "block-button primary" : btn.style === "danger" ? "block-button danger" : "block-button";
                      return (
                        <button
                          type="button"
                          key={btn.actionId}
                          className={buttonClass}
                          disabled={pendingActions.has(actionKey) || activeChannel.visibility === "transitioning"}
                          onClick={() => void sendAction(message, btn.actionId)}
                        >
                          {btn.label}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          ) : (
            <p>{message.value.text}</p>
          )}
          {message.value.parent && <small>Reply to {message.value.parent}</small>}
          <div className="message-actions"><button onClick={() => setReplyTo(message.uri)}>Reply</button>{onOpenPermalink && <button type="button" onClick={() => onOpenPermalink(message)}>Link</button>}{(message.reactions ?? []).map((reaction) => <button className={reaction.active ? "reaction-active" : ""} key={reaction.emoji} onClick={() => void toggleReaction(message.uri, reaction.emoji, reaction.active)}>{reaction.emoji} {reaction.count}</button>)}{!(message.reactions ?? []).some((reaction) => reaction.emoji === "💜") && <button onClick={() => void toggleReaction(message.uri, "💜", false)}>💜 0</button>}{message.repo === did && <><button onClick={() => void editMessage(message)}>Edit</button><button onClick={() => void deleteMessage(message.uri)}>Delete</button></>}</div>
        </article>
      );
    })}</div>
    {content.value?.next !== undefined && <button className="text-button load-older" onClick={() => void loadOlder().catch((caught) => setError(messageOf(caught)))}>Load older messages</button>}
    <form className="message-compose" onSubmit={sendMessage}>
      {replyTo && <p>Replying to {replyTo} <button type="button" onClick={() => setReplyTo("")}>Cancel</button></p>}
      {pickerMatches.length > 0 && (
        <div className="command-picker" role="listbox" aria-label="Slash commands">
          {pickerMatches.map((cmd) => (
            <button
              type="button"
              role="option"
              aria-selected={chosenCommandApp === cmd.appDid}
              className={chosenCommandApp === cmd.appDid ? "command-option selected" : "command-option"}
              key={`${cmd.appDid}:${cmd.name}`}
              onClick={() => chooseCommand(cmd.name, cmd.appDid)}
            >
              <strong>/{cmd.name}{cmd.usage ? ` ${cmd.usage}` : ""}</strong>
              <span>{cmd.appName}{cmd.description ? ` · ${cmd.description}` : ""}</span>
            </button>
          ))}
        </div>
      )}
      <textarea disabled={activeChannel.visibility === "transitioning"} value={messageText} onChange={(event) => handleTextChange(event.target.value)} placeholder="Write a message…" required />
      {composerStatus && <p className="composer-status" role="status">{composerStatus}</p>}
      <div><small>{Array.from(messageText).length}/10,000</small><button className="primary-button" disabled={busy || activeChannel.visibility === "transitioning"}>Send</button></div>
    </form>
  </>;
}
