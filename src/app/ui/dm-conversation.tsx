"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { dmConversationUri, dmInboxUri } from "@/protocol/keys";
import type { DmHalfStatus, DmMessage, DmReaction } from "@/dm/dm-client";
import { conversationLabel, participantLabel, retainAfterRefresh } from "@/dm/ui-logic";
import { messageOf } from "./client-api";
import { useDmContext } from "./dm-context";

const HALF_CHIPS: Record<DmHalfStatus, string | null> = {
  ok: null,
  missing: "hasn't replied",
  deleted: "left",
  revoked: "revoked your access",
};

type ReactionChip = { emoji: string; count: number; active: boolean };

export function DmConversation({ convKey, participants }: { convKey: string; participants: string[] }) {
  const { did, client, dmConfig, labels, openView, setError, refresh } = useDmContext();
  const [messages, setMessages] = useState<DmMessage[]>([]);
  const [reactions, setReactions] = useState<DmReaction[]>([]);
  const [halves, setHalves] = useState<Record<string, DmHalfStatus>>({});
  const [nextBefore, setNextBefore] = useState<string | undefined>(undefined);
  const [text, setText] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [editingUri, setEditingUri] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  const refreshes = useRef({ started: 0, applied: 0 });

  const loadPage = useCallback(async (before?: string) => {
    if (!client) return null;
    const refreshing = before === undefined;
    const ticket = refreshing ? (refreshes.current.started += 1) : 0;
    const page = await client.readConversation(convKey, participants, before ? { before } : {});
    if (refreshing) {
      if (ticket < refreshes.current.applied) return page;
      refreshes.current.applied = ticket;
    }
    const windowStart = page.nextBefore ?? "";
    const freshMessageUris = new Set(page.messages.map((message) => message.uri));
    setMessages((current) => mergeByUri(refreshing ? retainAfterRefresh(current, page.halves, (message) => message.rkey >= windowStart) : current, page.messages));
    setReactions((current) => mergeByUri(refreshing ? retainAfterRefresh(current, page.halves, (reaction) => freshMessageUris.has(reaction.subject)) : current, page.reactions));
    setHalves(page.halves);
    if (before !== undefined) setNextBefore(page.nextBefore);
    else setNextBefore((current) => current ?? page.nextBefore);
    return page;
  }, [client, convKey, participants]);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    let sources: EventSource[] = [];
    let subscribed = "";
    const watchAndSubscribe = async (knownHalves: Record<string, DmHalfStatus>) => {
      const spaces = [
        ...Object.entries(knownHalves).filter(([, status]) => status === "ok").map(([ownerDid]) => dmConversationUri(ownerDid, convKey)),
        dmInboxUri(did),
      ];
      try {
        await client.watch(spaces, dmConfig.serviceRef);
      } catch {
        // Registration is best-effort: the 60-second poll keeps the view correct.
      }
      if (cancelled) return;
      const subscription = spaces.join("|");
      if (subscription === subscribed && sources.every((source) => source.readyState !== EventSource.CLOSED)) return;
      subscribed = subscription;
      for (const source of sources) source.close();
      sources = spaces.map((space) => {
        const query = new URLSearchParams({ space, after: "0" });
        const events = new EventSource(`/api/notifications/dm?${query}`);
        const reload = () => {
          void loadPage().catch((caught) => setError(messageOf(caught)));
        };
        events.addEventListener("change", reload);
        events.addEventListener("error", () => {
          if (events.readyState === EventSource.CLOSED) reload();
        });
        return events;
      });
    };
    void (async () => {
      const page = await loadPage();
      if (cancelled || !page) return;
      await watchAndSubscribe(page.halves);
    })().catch((caught) => {
      if (!cancelled) setError(messageOf(caught));
    });
    const timer = window.setInterval(() => {
      void (async () => {
        const page = await loadPage();
        if (cancelled || !page) return;
        await watchAndSubscribe(page.halves);
      })().catch((caught) => {
        if (!cancelled) setError(messageOf(caught));
      });
    }, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      for (const source of sources) source.close();
    };
  }, [client, did, convKey, dmConfig.serviceRef, loadPage, setError]);

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!client || !text.trim()) return;
    setBusy(true);
    try {
      await client.send(convKey, text, replyTo || undefined);
      setText("");
      setReplyTo("");
      await loadPage();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function toggleReaction(message: DmMessage, emoji: string, active: boolean) {
    if (!client) return;
    try {
      if (active) await client.unreact(message.uri, emoji);
      else await client.react(message.uri, emoji);
      await loadPage();
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  function startEdit(message: DmMessage) {
    setEditingUri(message.uri);
    setEditText(message.text);
  }

  function cancelEdit() {
    setEditingUri(null);
    setEditText("");
  }

  async function saveEdit(event: FormEvent, message: DmMessage) {
    event.preventDefault();
    if (!client) return;
    try {
      await client.edit(message.uri, editText);
      cancelEdit();
      await loadPage();
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  async function deleteMessage(message: DmMessage) {
    if (!client) return;
    try {
      await client.delete(message.uri);
      setConfirming(null);
      await loadPage();
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  async function leaveConversation() {
    if (!client) return;
    try {
      await client.leave(convKey);
      await refresh();
      openView(null);
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  async function deleteEverything() {
    if (!client) return;
    try {
      await client.deleteEverything(convKey);
      await refresh();
      openView(null);
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  const chipsBySubject = groupReactions(reactions, did);

  return (
    <>
      <div className="section-heading">
        <div><span className="eyebrow"><span className="eyebrow-line" /> DIRECT MESSAGE</span><h2>◈ {conversationLabel({ participants, viewerDid: did, labels })}</h2></div>
        <div><button className="text-button" onClick={() => void loadPage().catch((caught) => setError(messageOf(caught)))}>Sync ↻</button></div>
      </div>
      <div className="starter-card private-roster">
        <strong>Participants</strong>
        <div className="roster-list">
          {participants.map((participant) => {
            const chip = HALF_CHIPS[halves[participant] ?? "missing"];
            return (
              <div className="roster-row" key={participant}>
                <span>{participantLabel(participant, labels)} <small className="mono-note">{participant}</small></span>
                <div>{chip && <span className="status-note">{chip}</span>}</div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="message-list">
        {messages.map((message) => {
          const chips = chipsBySubject.get(message.uri) ?? [];
          return (
            <article className="message-card" key={message.uri}>
              <div className="message-meta"><strong>{participantLabel(message.ownerDid, labels)}</strong><time>{message.createdAt}</time></div>
              {editingUri === message.uri
                ? (
                  <form className="message-compose" onSubmit={(event) => void saveEdit(event, message)}>
                    <textarea value={editText} onChange={(event) => setEditText(Array.from(event.target.value).slice(0, 10_000).join(""))} required />
                    <div><small>{Array.from(editText).length}/10,000</small><div className="message-actions"><button type="button" onClick={cancelEdit}>Cancel</button><button className="primary-button">Save</button></div></div>
                  </form>
                )
                : <p>{message.text}</p>}
              {message.parent && <small>Reply to {message.parent}</small>}
              <div className="message-actions">
                <button onClick={() => setReplyTo(message.uri)}>Reply</button>
                {chips.map((chip) => (
                  <button key={chip.emoji} className={chip.active ? "reaction-active" : ""} onClick={() => void toggleReaction(message, chip.emoji, chip.active)}>
                    {chip.emoji} {chip.count}
                  </button>
                ))}
                {!chips.some((chip) => chip.emoji === "💜") && <button onClick={() => void toggleReaction(message, "💜", false)}>💜 0</button>}
                {message.ownerDid === did && editingUri !== message.uri && (
                  <>
                    <button onClick={() => startEdit(message)}>Edit</button>
                    {confirming === message.uri
                      ? (
                        <>
                          <button className="text-button danger" onClick={() => void deleteMessage(message)}>Confirm delete</button>
                          <button onClick={() => setConfirming(null)}>Cancel</button>
                        </>
                      )
                      : <button onClick={() => setConfirming(message.uri)}>Delete</button>}
                  </>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {nextBefore && <button className="text-button load-older" onClick={() => void loadPage(nextBefore).catch((caught) => setError(messageOf(caught)))}>Load older messages</button>}
      <form className="message-compose" onSubmit={(event) => void send(event)}>
        {replyTo && <p>Replying to {replyTo} <button type="button" onClick={() => setReplyTo("")}>Cancel</button></p>}
        <textarea value={text} onChange={(event) => setText(Array.from(event.target.value).slice(0, 10_000).join(""))} placeholder="Write a message…" required />
        <div><small>{Array.from(text).length}/10,000</small><button className="primary-button" disabled={busy}>Send</button></div>
      </form>
      <div className="starter-card lifecycle-card">
        <h3>Conversation controls</h3>
        <p>Leaving removes the other participants from your half of the conversation; their copies are untouched. Deleting everything removes your half entirely.</p>
        {confirming === "leave"
          ? (
            <div className="channel-lifecycle">
              <button className="text-button danger" onClick={() => void leaveConversation()}>Confirm leave</button>
              <button className="text-button" onClick={() => setConfirming(null)}>Cancel</button>
            </div>
          )
          : <button className="text-button danger" disabled={busy} onClick={() => setConfirming("leave")}>Leave conversation</button>}
        {confirming === "deleteAll"
          ? (
            <div className="channel-lifecycle">
              <button className="text-button danger" onClick={() => void deleteEverything()}>Confirm delete everything</button>
              <button className="text-button" onClick={() => setConfirming(null)}>Cancel</button>
            </div>
          )
          : <button className="text-button danger" disabled={busy} onClick={() => setConfirming("deleteAll")}>Delete everything I sent</button>}
      </div>
    </>
  );
}

function groupReactions(reactions: readonly DmReaction[], viewerDid: string): Map<string, ReactionChip[]> {
  const bySubject = new Map<string, Map<string, ReactionChip>>();
  for (const reaction of reactions) {
    const emojis = bySubject.get(reaction.subject) ?? new Map<string, ReactionChip>();
    const chip = emojis.get(reaction.emoji) ?? { emoji: reaction.emoji, count: 0, active: false };
    chip.count += 1;
    if (reaction.ownerDid === viewerDid) chip.active = true;
    emojis.set(reaction.emoji, chip);
    bySubject.set(reaction.subject, emojis);
  }
  return new Map([...bySubject].map(([subject, emojis]) => [subject, [...emojis.values()]]));
}

function mergeByUri<T extends { uri: string; rkey?: string }>(current: readonly T[], incoming: readonly T[]): T[] {
  const unique = new Map([...current, ...incoming].map((entry) => [entry.uri, entry]));
  return [...unique.values()].sort((left, right) => (right.rkey ?? "").localeCompare(left.rkey ?? ""));
}
