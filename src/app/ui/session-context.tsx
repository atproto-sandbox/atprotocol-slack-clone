"use client";

import dynamic from "next/dynamic";
import { createContext, useContext, useState, type ReactNode } from "react";
import type { BrowserSessionConfig } from "@/browser/session";
import type { BrowserSessionState } from "@/browser/use-browser-session";

// The browser session (and, through it, the browser-only OAuth and WebCrypto modules) is restored in a childless bridge
// rendered client-side only, so it never enters a server bundle while everything below still renders during SSR; see the
// note in dm-session-bridge.tsx. Its state reaches the UI through this context.
const SessionBridge = dynamic(() => import("./dm-session-bridge").then((mod) => mod.DmSessionBridge), { ssr: false });

const RESTORING: BrowserSessionState = {
  status: "connecting", client: null, store: null, engine: null, snapshots: null, live: null, error: "",
  connect: () => {}, disconnect: async () => {},
};

const SessionContext = createContext<BrowserSessionState | null>(null);

export function useBrowserSessionContext(): BrowserSessionState {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useBrowserSessionContext must be used inside SessionProvider.");
  return value;
}

/** Restores the signed-in account's browser session once, for the DM client and the engine alike. */
export function SessionProvider({ did, config, children }: { did: string; config: BrowserSessionConfig; children: ReactNode }) {
  const [session, setSession] = useState<BrowserSessionState>(RESTORING);
  return (
    <SessionContext.Provider value={session}>
      <SessionBridge did={did} dmConfig={config} onSession={setSession} />
      {children}
    </SessionContext.Provider>
  );
}
