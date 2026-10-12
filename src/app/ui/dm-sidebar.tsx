"use client";

import { conversationLabel, conversationVisible } from "@/dm/ui-logic";
import { useDmContext } from "./dm-context";

export function DmSidebar() {
  const { did, status, store, connect, conversations, requests, labels, activeWorkspace, showAll, setShowAll, view, openView, error } = useDmContext();
  const memberDids = activeWorkspace ? activeWorkspace.members.map((member) => member.did) : null;
  const visible = conversations.filter((entry) => conversationVisible({ participants: entry.participants, viewerDid: did, memberDids, showAll }));

  return (
    <div className="channel-nav">
      <div className="section-label"><span>DIRECT MESSAGES</span></div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {status !== "ready" ? (
        <button className="sidebar-action" disabled={status === "connecting"} onClick={connect}>
          <span>+</span> {status === "connecting" ? "Connecting…" : "Connect direct messages"}
        </button>
      ) : (
        <>
          {store && !store.persistent && <p className="status-note">Browser storage is unavailable; DM state lasts only until this tab closes.</p>}
          {visible.map((conversation) => (
            <button
              key={conversation.convKey}
              className={`channel-nav-item ${view?.kind === "conversation" && view.convKey === conversation.convKey ? "active" : ""}`}
              onClick={() => openView({ kind: "conversation", convKey: conversation.convKey, participants: conversation.participants })}
            >
              <span>◈</span>{conversationLabel({ participants: conversation.participants, viewerDid: did, labels })}
            </button>
          ))}
          <button className={`channel-nav-item ${view?.kind === "requests" ? "active" : ""}`} onClick={() => openView({ kind: "requests" })}>
            <span>✉</span>Requests ({requests.length})
          </button>
          <button className={`channel-nav-item ${view?.kind === "home" ? "active" : ""}`} onClick={() => openView({ kind: "home" })}>
            <span>+</span>New message
          </button>
          <button className={`channel-nav-item ${view?.kind === "settings" ? "active" : ""}`} onClick={() => openView({ kind: "settings" })}>
            <span>⚙</span>DM settings
          </button>
          <button className="channel-nav-item" onClick={() => setShowAll(!showAll)}>
            <span>⇔</span>{showAll ? "Show workspace only" : "Show all conversations"}
          </button>
        </>
      )}
    </div>
  );
}
