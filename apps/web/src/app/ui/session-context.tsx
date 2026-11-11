"use client";

import dynamic from "next/dynamic";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import type { BrowserSessionConfig } from "../../browser/session";
import type { BrowserSessionState } from "../../browser/use-browser-session";
import { clearAccountScopedState, SIGN_OUT_KEPT, SIGN_OUT_PARAM, SIGN_OUT_UNREVOKED } from "./client-api";

// The browser session (and, through it, the browser-only OAuth and WebCrypto modules) is restored in a childless bridge
// rendered client-side only, so it never enters a server bundle while everything below still renders during SSR; see the
// note in dm-session-bridge.tsx. Its state reaches the UI through this context.
const SessionBridge = dynamic(() => import("./dm-session-bridge").then((mod) => mod.DmSessionBridge), { ssr: false });

/**
 * The state until the bridge reports: restoring, and a sign-out that already works, through the same procedure. `stopped`
 * unmounts the bridge first, so a restore it was starting cannot open the store again after it is deleted.
 */
function restoring(did: string, config: BrowserSessionConfig, stopped: () => void): BrowserSessionState {
  return {
    status: "connecting", client: null, store: null, engine: null, snapshots: null, live: null, error: "",
    connect: () => {},
    signOut: async () => {
      stopped();
      return (await import("../../browser/sign-out")).signOutAccount(did, async () => (await import("../../browser/session")).signOut(config));
    },
  };
}

const SessionContext = createContext<BrowserSessionState | null>(null);

export function useBrowserSessionContext(): BrowserSessionState {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useBrowserSessionContext must be used inside SessionProvider.");
  return value;
}

/**
 * Signs the account out of this browser (what it kept here deleted, its session revoked at its host) and returns to the
 * sign-in page, which says which part did not hold: a session its host was not told of ends when it expires, and a store
 * another tab held is deleted when another account signs in here.
 */
export function useSignOut(): () => Promise<void> {
  const { signOut } = useBrowserSessionContext();
  return useCallback(async () => {
    const { revoked, erased } = await signOut().catch(() => ({ revoked: false, erased: false }));
    clearAccountScopedState(sessionStorage);
    const unheld = [...(revoked ? [] : [SIGN_OUT_UNREVOKED]), ...(erased ? [] : [SIGN_OUT_KEPT])];
    window.location.assign(unheld.length ? `${window.location.origin}/?${SIGN_OUT_PARAM}=${unheld.join(",")}` : window.location.origin);
  }, [signOut]);
}

/** Restores the signed-in account's browser session once, for the DM client and the engine alike. */
export function SessionProvider({ did, config, children }: { did: string; config: BrowserSessionConfig; children: ReactNode }) {
  const [signingOut, setSigningOut] = useState(false);
  const [session, setSession] = useState<BrowserSessionState>(() => restoring(did, config, () => setSigningOut(true)));
  return (
    <SessionContext.Provider value={session}>
      {!signingOut && <SessionBridge did={did} dmConfig={config} onSession={setSession} />}
      {children}
    </SessionContext.Provider>
  );
}
