"use client";

import { useDmContext } from "./dm-context";
import { DmConversation } from "./dm-conversation";
import { DmHome } from "./dm-home";
import { DmRequests } from "./dm-requests";
import { DmSettings } from "./dm-settings";

export function DmStage() {
  const { view } = useDmContext();
  if (!view) return null;
  switch (view.kind) {
    case "home":
      return <DmHome />;
    case "requests":
      return <DmRequests />;
    case "settings":
      return <DmSettings />;
    case "conversation":
      return <DmConversation key={view.convKey} convKey={view.convKey} participants={view.participants} />;
  }
}
