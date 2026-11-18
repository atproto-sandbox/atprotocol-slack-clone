"use client";

import { useDmContext } from "./dm-context";
import { DmConversation } from "./dm-conversation";
import { DmHome } from "./dm-home";
import { DmRequests } from "./dm-requests";
import { DmSettings } from "./dm-settings";

export function DmStage() {
  const { view, conversations, loaded, status, openView } = useDmContext();
  if (!view) return null;
  switch (view.kind) {
    case "home":
      return <DmHome />;
    case "requests":
      return <DmRequests />;
    case "settings":
      return <DmSettings />;
    case "conversation": {
      const participants =
        view.participants.length > 0
          ? view.participants
          : conversations.find((entry) => entry.convKey === view.convKey)?.participants ?? null;
      if (!participants || participants.length === 0) {
        if (!loaded || status !== "ready") {
          return <p className="status-note" role="status">Loading conversation…</p>;
        }
        return (
          <div className="starter-card">
            <p className="form-error" role="alert">Conversation not found.</p>
            <button type="button" className="text-button" onClick={() => openView({ kind: "home" })}>
              Back to direct messages →
            </button>
          </div>
        );
      }
      return <DmConversation key={view.convKey} convKey={view.convKey} participants={participants} />;
    }
  }
}
